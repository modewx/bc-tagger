"""Import batches of hand-written track lists (``bc-tagger-import/1``).

create → resolve (the collection, the file's Bandcamp URL, Bandcamp search) + locate (a job) →
review (rows, tag mapping, picks, links) → commit. Batches and rows are persisted, so the user can
leave and come back.

A row is a Bandcamp row (``row.bandcamp``) when it's already in the collection (``existing_id``, the
same id, or the same artist + title), when the resolver found it, when the user picked a
candidate, or when the user linked it to a Bandcamp page from the extension. Everything else goes
to the ``other`` collection.
"""

from __future__ import annotations

import copy
import json
import math
import re
import secrets
from datetime import datetime, timedelta
from typing import Any

from . import bandcamp
from .collection import (
    DuplicateIndex, by_number, merge_pending_item_tags, now_ms_iso, other_get, other_id, other_put, queue_add,
    search_links,
)
from .fetcher import Challenged, RateLimited, Unavailable
from .rowmatch import score_row
from .store import now_iso

FORMAT = "bc-tagger-import/1"
CHALLENGE_COOLDOWN_S = 3600  # after a bot check, no Bandcamp lookups from any batch for an hour
REQUESTS_PER_LOOKUP = 1.3  # some rows need a second search (the title alone)
RATE_LIMITED = "Bandcamp is rate-limiting; try again later"
_PAGE_URL = re.compile(r"^https://[^/\s?#]+/(track|album)/[^/\s?#]+$")
ROW_FIELDS = ("line", "raw", "kind", "artist", "title", "album", "album_artist", "flags", "note", "label", "catalog",
              "year", "track_num", "position", "duration", "expanded_from", "bandcamp_url", "discogs_url",
              "existing_id", "existing_tags", "tag_fixes")
OTHER_FIELDS = ("label", "catalog", "year", "note", "flags", "raw", "line", "duration", "position", "album_artist",
                "expanded_from", "hints")


class ImportError_(ValueError):
    pass


def _clean_tags(tags) -> list[str]:
    return [t.strip() for t in dict.fromkeys(tags or []) if isinstance(t, str) and t.strip()]


def _empty_match() -> dict[str, Any]:
    return {"status": "pending", "source": None, "confidence": 0.0, "query": None, "candidates": [], "chosen": None,
            "item": None}


def _unavailable(reason: str, error: str) -> dict[str, Any]:
    """Not looked up: Bandcamp lookups are off, or stopped after Bandcamp's bot check."""
    return {**_empty_match(), "status": "unavailable", "reason": reason, "error": error}


def _stop_reason(svc, batch: dict) -> tuple[str, str] | None:
    """Why this batch must not ask Bandcamp anything right now, or None."""
    if bandcamp.lookups_off():
        return "off", "Bandcamp lookups are off (BC_TAGGER_BANDCAMP=off)"
    stopped = batch.get("bandcamp_lookups") or {}
    if stopped.get("state") in ("stopped", "paused"):
        return stopped["reason"], stopped["error"]
    last = svc.store.get_meta("bandcamp_challenge")
    if last and (datetime.now().astimezone() - datetime.fromisoformat(last["at"])).total_seconds() < CHALLENGE_COOLDOWN_S:
        return "challenge", f"Bandcamp lookup unavailable: bot check at {last['at']}"
    return None


def _challenged(svc, batch: dict, e: Exception) -> tuple[str, str]:
    """Bandcamp answered with its bot check: stop this batch's lookups (and others', for a while)."""
    error = f"Bandcamp lookup unavailable: {e}"
    at = now_iso()
    batch["bandcamp_lookups"] = {"state": "stopped", "reason": "challenge", "error": error, "at": at}
    svc.store.set_meta("bandcamp_challenge", {"at": at, "error": str(e)})
    _save_batch(svc.store, batch)
    return "challenge", error


def _rate_limited(svc, batch: dict, e: Exception) -> tuple[str, str]:
    """Still rate-limited after waiting: pause this batch's lookups until the user resumes."""
    batch["bandcamp_lookups"] = {"state": "paused", "reason": "rate_limited", "error": RATE_LIMITED,
                                 "detail": str(e), "at": now_iso()}
    _save_batch(svc.store, batch)
    return "rate_limited", RATE_LIMITED


def _fmt_duration(seconds: float) -> str:
    return "under a minute" if seconds < 60 else f"{round(seconds / 60)} min"


def _plan(svc, fetcher, rows: list[dict], todo) -> tuple[dict[str, Any], list[bool]]:
    """Which of ``rows`` (those ``todo`` says need a lookup) will hit the network, and how long that
    takes at the configured pace: ``{lookups, cached, requests, seconds, interval_s, text}``."""
    dups = DuplicateIndex(svc.store)
    network = []
    cached = 0
    for row in rows:
        probe = copy.deepcopy(row)
        _check_duplicate(dups, probe)
        needs = todo(probe)
        uncached = needs and not fetcher.is_cached(*bandcamp.first_request(probe))
        cached += needs and not uncached
        network.append(bool(uncached))
    lookups = sum(network)
    requests = math.ceil(lookups * REQUESTS_PER_LOOKUP)
    seconds = requests * fetcher.min_interval
    text = f"~{lookups} lookups ≈ {_fmt_duration(seconds)}" if lookups else "no Bandcamp requests needed"
    return {"lookups": lookups, "cached": cached, "requests": requests, "seconds": round(seconds),
            "interval_s": fetcher.min_interval, "text": text}, network


def _needs_lookup(row: dict) -> bool:
    return row["source"] != "bandcamp" and (row.get("match") or {}).get("status") in ("pending", None)


def _try_lookup(svc, batch: dict, fetcher, row: dict) -> tuple[str, str] | None:
    """One row's lookup; returns why the batch's lookups must stop now (bot check, rate limit)."""
    try:
        _lookup(fetcher, row)
        return None
    except Challenged as e:  # the bot check: stop asking Bandcamp, never retry
        stop = _challenged(svc, batch, e)
    except RateLimited as e:  # still 429 after waiting: pause until the user resumes
        stop = _rate_limited(svc, batch, e)
    except Unavailable as e:  # not recorded, network error: this row only
        row["match"], row["bandcamp"] = _unavailable("error", f"Bandcamp lookup unavailable: {e}"), None
        return None
    except Exception as e:  # one bad row must not stop the batch
        row["match"], row["bandcamp"] = {**_empty_match(), "status": "error", "error": f"{type(e).__name__}: {e}"}, None
        return None
    row["match"], row["bandcamp"] = _unavailable(*stop), None
    return stop


def _lookup_rows(svc, batch: dict, rows: list[dict], todo, phase: str, ctx=None) -> Any:
    """Look up ``rows`` that ``todo`` selects, one request at a time, with progress and a time estimate."""
    store, batch_id = svc.store, batch["batch_id"]
    fetcher = svc.bandcamp_fetcher()
    dups = DuplicateIndex(store)
    estimate, network = _plan(svc, fetcher, rows, todo)
    batch["estimate"] = estimate
    stop = _stop_reason(svc, batch)
    if stop is None:
        batch["bandcamp_lookups"] = {"state": "on"}
    elif (batch.get("bandcamp_lookups") or {}).get("state") not in ("stopped", "paused"):
        batch["bandcamp_lookups"] = {"state": "off" if stop[0] == "off" else "stopped", "reason": stop[0],
                                     "error": stop[1], "at": now_iso()}
    _save_batch(store, batch)
    state = {"i": 0}

    def progress(message: str) -> None:
        svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": phase, "current": state["i"], "total": len(rows),
                                        "message": message})
        if ctx:
            ctx.progress(state["i"], len(rows), message)

    fetcher.on_wait = lambda seconds, message: progress(message)
    for i, row in enumerate(rows, 1):
        state["i"] = i
        _check_duplicate(dups, row)
        if (row.get("bandcamp") or {}).get("via") == "collection":  # already in the collection: no lookup
            if (row.get("match") or {}).get("status") in ("pending", None, "in_collection"):
                row["match"] = {**_empty_match(), "status": "in_collection", "source": "collection"}
        elif todo(row):
            if stop:
                row["match"] = _unavailable(*stop)
            else:
                stop = _try_lookup(svc, batch, fetcher, row)
            _check_duplicate(dups, row)
        _refresh(row)
        if i % 10 == 0 or i == len(rows):
            _save_rows(store, batch_id, rows)
        left = math.ceil(sum(network[i:]) * REQUESTS_PER_LOOKUP) * fetcher.min_interval if not stop else 0
        progress(f"{phase} {i}/{len(rows)}" + (f" · ~{_fmt_duration(left)} left" if left else ""))
    return fetcher


# -- persistence -------------------------------------------------------------------------------


def _save_batch(store, batch: dict) -> None:
    with store.tx() as c:
        c.execute(
            "INSERT INTO import_batches(id, data, created_at, updated_at) VALUES(?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (batch["batch_id"], json.dumps(batch), batch["created_at"], now_iso()),
        )


def _save_rows(store, batch_id: str, rows: list[dict]) -> None:
    with store.tx() as c:
        for row in rows:
            c.execute(
                "INSERT INTO import_rows(batch_id, n, data) VALUES(?, ?, ?) "
                "ON CONFLICT(batch_id, n) DO UPDATE SET data = excluded.data",
                (batch_id, row["n"], json.dumps(row)),
            )


def load_batch(store, batch_id: str) -> dict:
    row = store.query_one("SELECT data FROM import_batches WHERE id = ?", (batch_id,))
    if row is None:
        raise KeyError(batch_id)
    return json.loads(row["data"])


def load_rows(store, batch_id: str) -> list[dict]:
    return [json.loads(r["data"]) for r in store.query(
        "SELECT data FROM import_rows WHERE batch_id = ? ORDER BY n", (batch_id,))]


def compute_stats(batch: dict, rows: list[dict]) -> dict[str, int]:
    def via(r, kind):
        return bool(r.get("bandcamp")) and r["bandcamp"]["via"] == kind

    return {
        "total": len(rows),
        "bandcamp": sum(r["source"] == "bandcamp" for r in rows),
        "in_collection": sum(via(r, "collection") for r in rows),
        "found": sum(via(r, "resolved") for r in rows),
        "picked": sum(via(r, "chosen") for r in rows),
        "linked": sum(via(r, "linked") for r in rows),
        "other": sum(r["source"] == "other" for r in rows),
        "located": sum((r.get("located") or {}).get("status") == "located" for r in rows),
        "duplicates": sum(bool(r.get("duplicate")) for r in rows),
        "flagged": sum(bool(r.get("flags")) for r in rows),
        "unknown_tags": len(batch.get("unknown_tags") or {}),
        "checked": sum(bool(r.get("checked")) for r in rows),
        "needs_pick": sum((r.get("match") or {}).get("status") == "candidates" and r["source"] != "bandcamp"
                          for r in rows),
        "unavailable": sum((r.get("match") or {}).get("status") == "unavailable" for r in rows),
        "pending_releases": len(batch.get("pending_releases") or []),
    }


def _refresh_stats(store, batch: dict, rows: list[dict] | None = None) -> dict:
    rows = rows if rows is not None else load_rows(store, batch["batch_id"])
    batch["stats"] = compute_stats(batch, rows)
    _save_batch(store, batch)
    return batch


# -- rows ------------------------------------------------------------------------------------------


OWN = ("resolved", "chosen", "linked")  # the row's own Bandcamp item, not the collection's duplicate


def _own(row: dict) -> dict | None:
    bc = row.get("bandcamp")
    return bc if bc and bc["via"] in OWN else None


def _hints(row: dict) -> dict[str, Any]:
    """Link hints: the import file's, or a Bandcamp page URL the user set (``match_url``)."""
    match = row.get("match") or {}
    url = match.get("url") if match.get("source") == "url" else None
    return {"bandcamp_url": url or row.get("bandcamp_url"), "discogs_url": row.get("discogs_url")}


def _refresh(row: dict) -> None:
    row["source"] = "bandcamp" if row.get("bandcamp") else "other"
    row.setdefault("match", _empty_match())
    row["match"]["item"] = row["bandcamp"]["item"] if row.get("bandcamp") else None
    if (row.get("bandcamp") or {}).get("via") == "collection" and row["match"]["status"] in ("pending", "in_collection"):
        row["match"].update(status="in_collection", source="collection")
    row["match_source"] = row["match"].get("source")
    row["hints"] = _hints(row)
    row["links"] = search_links(row.get("artist"), row.get("title") or row.get("album"), row.get("album"),
                                row["hints"])


def row_item(row: dict) -> dict:
    """What the row would become: the tagger item, or the ``other`` item."""
    if row.get("bandcamp"):
        return {**row["bandcamp"]["item"], "tags": row["tags"]}
    album = row.get("album")
    track = row.get("track_num") if by_number(row) else None
    item = {
        "id": other_id(row.get("artist"), row.get("title") or row.get("album") or "", row.get("album"), track),
        "kind": row["kind"], "artist": row.get("artist"), "title": row.get("title") or row.get("album"),
        "album": album, "album_title": album, "track_num": row.get("track_num"), "tags": row["tags"],
        "flags": row.get("flags") or [],
    }
    return item


def _tagger_fields(item: dict) -> dict:
    return {k: v for k, v in item.items() if k not in ("tags", "source", "pending", "date_added")}


def _check_duplicate(dups: DuplicateIndex, row: dict) -> None:
    """Already in the collection? By ``existing_id`` or the row's id, then artist + title. A
    duplicate of a Bandcamp item makes the row a Bandcamp row, unless it has its own item."""
    own = _own(row)
    item = row_item({**row, "bandcamp": own})
    dup = None
    for item_id in (row.get("existing_id"), item["id"]):
        if item_id and dup is None:
            dup = dups.find(item_id, None, None)
    if dup is None:
        dup = dups.find(None, item.get("artist"), item.get("title"), item)
    row["duplicate"] = dup
    if own is None:
        hit = dups.by_id.get(dup["of"]) if dup and dup["source"] == "bandcamp" else None
        row["bandcamp"] = {"item": _tagger_fields(hit), "via": "collection"} if hit else None
    _refresh(row)


def _refresh_index(svc, ctx=None, batch: dict | None = None, mode: str | None = None) -> dict[str, Any]:
    """Before locating: pick up files added since the last full scan or since the batch was created,
    whichever is earlier (a quick scan from that date, minus ``quick_scan_margin_days``)."""
    mode = mode or svc.default_scan_mode
    if mode != "quick":
        return svc.prepare_index([], mode, ctx)
    dates = [d for d in (svc.index_status().get("last_scan_at"), (batch or {}).get("created_at")) if d]
    if not dates:
        return {"mode": "none", "skipped": "no full scan yet"}
    cutoff = min(datetime.fromisoformat(d.replace("Z", "+00:00")) for d in dates) - \
        timedelta(days=float(svc.settings.get("quick_scan_margin_days")))
    return svc.prepare_index([], "quick", ctx, cutoff=cutoff)


def _locate(svc, rows: list[dict], index=None) -> None:
    from .matcher import locate_item

    index = index or svc.file_index()
    cfg = svc.match_config()
    for row in rows:
        if (row.get("located") or {}).get("manual"):
            continue  # a file the user picked: later locates leave it alone
        result = locate_item(row_item(row), index, cfg)
        row["located"] = {"status": result["status"], "best": result["best"], "candidates": result["candidates"][:3]}


def _lookup(fetcher, row: dict) -> None:
    """The file's Bandcamp URL when it has one (one page), else a Bandcamp search (no page)."""
    hint = row.get("bandcamp_url")
    found = bandcamp.item_from_page(fetcher, hint, row) if hint and bandcamp.is_bandcamp_url(hint) else None
    if found:
        item, confidence = found
        cand = {"id": item["id"], "type": item["item_type"], "title": item["title"], "artist": item.get("artist"),
                "album": item.get("album_title"), "url": item.get("item_url"), "art_url": item.get("art_url"),
                "confidence": round(confidence, 3)}
        row["match"] = {"status": "accepted", "source": "file", "confidence": cand["confidence"], "query": hint,
                        "candidates": [cand], "chosen": cand}
        row["bandcamp"] = {"item": item, "via": "resolved"}
        return
    match = bandcamp.resolve(fetcher, row)
    row["match"] = match
    # The search answer is enough to import; the page (data-tralbum) is fetched later, only if asked for.
    row["bandcamp"] = {"item": bandcamp.minimal_item(match["chosen"]), "via": "resolved"} if match["chosen"] else None


# -- create ---------------------------------------------------------------------------------------


def _with_defaults(own: list[str], defaults: list[str], to_all: bool) -> tuple[list[str], list[str]]:
    """(tags, default_added): defaults go to untagged rows, or with ``to_all`` are added to every row."""
    added = [t for t in defaults if t not in own] if (to_all or not own) else []
    return own + added, added


def create_batch(svc, file_obj: dict, default_tags: list[str], name: str | None = None,
                 default_tags_all: bool = False) -> dict:
    if not isinstance(file_obj, dict) or file_obj.get("format") != FORMAT:
        raise ImportError_(f"not a {FORMAT} file")
    items = file_obj.get("items")
    if not isinstance(items, list) or not items:
        raise ImportError_("the file has no items")
    default_tags = _clean_tags(default_tags)
    vocab = set(svc.store.get_tags())
    suggestions = file_obj.get("unknown_tags") or {}
    rows: list[dict] = []
    for n, it in enumerate(items):
        if not isinstance(it, dict) or not (it.get("title") or it.get("album")):
            raise ImportError_(f"item {n} has no title")
        row = {k: it.get(k) for k in ROW_FIELDS}
        row["kind"] = "album" if it.get("kind") == "album" else "track"
        row["flags"] = list(it.get("flags") or [])
        tags, added = _with_defaults(_clean_tags(it.get("tags")), default_tags, default_tags_all)
        row.update(
            n=n, tags=tags, default_added=added, default_tags_applied=bool(added),
            checked=True, source="other", match=_empty_match(), bandcamp=None, duplicate=None,
            located={"status": "unknown", "best": None, "candidates": []}, committed=None,
        )
        _refresh(row)
        rows.append(row)
    unknown = {}
    for row in rows:
        for t in row["tags"]:
            if t not in vocab and t not in unknown:
                unknown[t] = _clean_tags(suggestions.get(t) or [])
    batch = {
        "batch_id": "imp-" + secrets.token_hex(4), "name": name or file_obj.get("source") or "import",
        "created_at": now_iso(), "status": "resolving", "error": None, "default_tags": default_tags,
        "default_tags_all": bool(default_tags_all),
        "unknown_tags": unknown, "new_tags": [], "tag_mapping": None, "source_file": file_obj.get("source"),
        "revision": file_obj.get("revision"), "pending_releases": list(file_obj.get("pending_releases") or []),
        "job_id": None, "job_kind": None, "job_boot": svc.boot_id, "phase": "resolving", "stats": {},
        "committed_at": None, "commit_result": None,
    }
    batch["estimate"] = _plan(svc, svc.bandcamp_fetcher(), rows, _needs_lookup)[0]
    _save_rows(svc.store, batch["batch_id"], rows)
    _refresh_stats(svc.store, batch, rows)
    return batch


# -- look up + locate -------------------------------------------------------------------------------


def run_batch(svc, batch_id: str, ctx=None) -> dict:
    store = svc.store
    batch = load_batch(store, batch_id)
    rows = load_rows(store, batch_id)

    def event(phase, current, total):
        svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": phase, "current": current, "total": total})
        if ctx:
            ctx.progress(current, total, f"{phase} {current}/{total}")

    fetcher = None
    try:
        batch["phase"] = "resolving"
        fetcher = _lookup_rows(svc, batch, rows, _needs_lookup, "resolving", ctx)
        event("locating", 0, len(rows))
        batch["phase"] = "locating"
        _save_batch(store, batch)
        batch["scan"] = _refresh_index(svc, ctx)
        _locate(svc, rows)
        _save_rows(store, batch_id, rows)
        batch.update(status="ready", phase=None)
        event("done", len(rows), len(rows))
    except Exception as e:
        batch.update(status="error", error=f"{type(e).__name__}: {e}")
        _save_rows(store, batch_id, rows)
        _refresh_stats(store, batch, rows)
        svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": "error", "current": 0, "total": len(rows)})
        raise
    _refresh_stats(store, batch, rows)
    return {"batch_id": batch_id, "stats": batch["stats"], "network_requests": fetcher.network_requests if fetcher else 0}


def _paused(row: dict) -> bool:
    match = row.get("match") or {}
    return row["source"] != "bandcamp" and match.get("status") == "unavailable" and match.get("reason") == "rate_limited"


def _needs_details(row: dict) -> bool:
    bc = _own(row) or {}
    return bool(bc) and bc["via"] in ("resolved", "chosen") and bool(bc["item"].get("partial")) \
        and bool(bc["item"].get("item_url")) and row.get("checked") and not row.get("committed") \
        and not row.get("duplicate")


def prepare_job(svc, batch_id: str, what: str) -> dict[str, Any]:
    """Check a resume/details job may run now; returns its time estimate."""
    batch = load_batch(svc.store, batch_id)
    _live(svc, batch)  # a restart may have interrupted it
    interrupted = batch["status"] == "interrupted"
    if batch["status"] != "ready" and not (what == "resume" and interrupted):
        raise ImportError_(f"the batch isn't ready ({batch['status']})")
    lookups = batch.get("bandcamp_lookups") or {}
    if what == "resume":
        if not interrupted and lookups.get("state") != "paused":
            raise ImportError_("nothing to resume: the batch's Bandcamp lookups aren't paused")
        if lookups.get("state") == "paused":
            batch["bandcamp_lookups"] = {"state": "on"}
        if interrupted:
            batch.update(status="resolving", phase="resolving", error=None)
        _save_batch(svc.store, batch)
    stop = _stop_reason(svc, batch)
    if stop and not interrupted:  # an interrupted batch still finishes: its rows end unavailable
        raise ImportError_(stop[1])
    rows = load_rows(svc.store, batch_id)
    fetcher = svc.bandcamp_fetcher()
    if what == "resume":
        return _plan(svc, fetcher, rows, _resumable_row)[0]
    pages = [r for r in rows if _needs_details(r)]
    uncached = sum(not fetcher.is_cached("GET", r["bandcamp"]["item"]["item_url"]) for r in pages)
    seconds = uncached * fetcher.min_interval
    return {"lookups": uncached, "cached": len(pages) - uncached, "requests": uncached, "seconds": round(seconds),
            "interval_s": fetcher.min_interval,
            "text": f"~{uncached} pages ≈ {_fmt_duration(seconds)}" if uncached else "no Bandcamp requests needed"}


def _resumable_row(row: dict) -> bool:
    """Paused by a rate limit, or never looked up (a restart interrupted the batch)."""
    return _paused(row) or _needs_lookup(row)


def resume_batch(svc, batch_id: str, ctx=None) -> dict:
    """Look up the rows a rate limit paused or a restart interrupted (what was already fetched comes
    from the cache), then locate."""
    store = svc.store
    batch = load_batch(store, batch_id)
    rows = load_rows(store, batch_id)
    interrupted = batch["status"] == "resolving"  # prepare_job reopened an interrupted batch
    targets = [r for r in rows if _resumable_row(r)]
    for r in targets:
        r["match"] = _empty_match()
    try:
        _lookup_rows(svc, batch, rows, lambda r: any(r is t for t in targets), "resolving", ctx)
        if interrupted:  # it may not have located anything yet
            batch["phase"] = "locating"
            _save_batch(store, batch)
            batch["scan"] = _refresh_index(svc, ctx)
            _locate(svc, rows)
        else:
            _locate(svc, targets)
    except Exception as e:
        batch.update(status="error", error=f"{type(e).__name__}: {e}")
        _save_rows(store, batch_id, rows)
        _refresh_stats(store, batch, rows)
        raise
    batch.update(status="ready", phase=None)
    _save_rows(store, batch_id, rows)
    _refresh_stats(store, batch, rows)
    svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": "done", "current": len(rows), "total": len(rows)})
    return {"batch_id": batch_id, "stats": batch["stats"]}


def fetch_details(svc, batch_id: str, ctx=None) -> dict:
    """Optional: fetch the Bandcamp page (data-tralbum) of the rows that will become tagger items,
    for the full item (track number, album URL, stream). Paced; stops on a bot check or rate limit."""
    store = svc.store
    batch = load_batch(store, batch_id)
    rows = load_rows(store, batch_id)
    fetcher = svc.bandcamp_fetcher()
    targets = [r for r in rows if _needs_details(r)]
    done = 0
    stop = None
    for i, row in enumerate(targets, 1):
        try:
            item = row["bandcamp"]["item"]
            row["bandcamp"]["item"] = bandcamp.fetch_item(fetcher, {"url": item["item_url"]}) or item
            done += 1
        except Challenged as e:
            stop = _challenged(svc, batch, e)
        except RateLimited as e:
            stop = _rate_limited(svc, batch, e)
        except Unavailable:
            pass
        _refresh(row)
        if ctx:
            ctx.progress(i, len(targets), f"details {i}/{len(targets)}")
        if stop:
            break
    _save_rows(store, batch_id, rows)
    _refresh_stats(store, batch, rows)
    svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": "details", "current": done, "total": len(targets)})
    return {"batch_id": batch_id, "fetched": done, "of": len(targets), "stopped": stop[1] if stop else None}


# -- review ----------------------------------------------------------------------------------------


def set_job(svc, batch_id: str, job) -> None:
    """Remember the batch's current job (and which server run it belongs to)."""
    batch = load_batch(svc.store, batch_id)
    batch.update(job_id=job.id, job_kind=job.kind, job_boot=svc.boot_id)
    _save_batch(svc.store, batch)


def _live(svc, batch: dict) -> dict:
    """The batch as the UI needs it to reopen it: ``step``, ``progress``, the running ``job``. A batch
    caught mid-lookup or mid-commit by a server restart is marked here (and saved)."""
    ours = batch.get("job_boot") == svc.boot_id
    job = svc.jobs.get(batch["job_id"]) if ours and batch.get("job_id") else None
    if batch["status"] == "resolving" and not ours:
        batch.update(status="interrupted", error="The server restarted during the lookups. Resume to continue "
                                                 "(answers already fetched come from the cache).")
        _save_batch(svc.store, batch)
    elif batch["status"] == "committing" and batch["batch_id"] not in svc.committing:
        batch.update(status="ready", error="The server restarted during the import. Import again: rows "
                                           "already imported are skipped.")
        _save_batch(svc.store, batch)
    status = batch["status"]
    if status == "resolving":
        step = batch.get("phase") or "resolving"
    elif status == "ready":
        step = "mapping" if batch.get("unknown_tags") else "ready"
    else:
        step = status  # interrupted, committing, committed, error
    running = job is not None and job.status in ("queued", "running")
    lookups = batch.get("bandcamp_lookups") or {}
    return {
        "step": step,
        "progress": dict(job.progress) if running else None,
        "job": {"id": job.id, "kind": job.kind, "status": job.status} if running else None,
        "resumable": status == "interrupted" or (status == "ready" and lookups.get("state") == "paused"),
    }


LIST_FIELDS = ("batch_id", "name", "created_at", "status", "error", "stats", "estimate", "bandcamp_lookups",
               "default_tags", "default_tags_all", "committed_at")


def get_batch(svc, batch_id: str) -> dict:
    batch = load_batch(svc.store, batch_id)
    live = _live(svc, batch)
    return {**batch, **live, "rows": load_rows(svc.store, batch_id)}


def list_batches(svc) -> list[dict]:
    """``[{batch_id, name, created_at, status, step, progress, job, resumable, error, stats, estimate,
    bandcamp_lookups, default_tags, default_tags_all, committed_at, unknown_tags}]``, newest first."""
    out = []
    for r in svc.store.query("SELECT data FROM import_batches ORDER BY created_at DESC"):
        b = json.loads(r["data"])
        live = _live(svc, b)
        out.append({**{k: b.get(k) for k in LIST_FIELDS}, **live, "unknown_tags": len(b.get("unknown_tags") or {})})
    return out


def _editable(store, batch_id: str, n: int) -> tuple[dict, list[dict], dict]:
    batch = load_batch(store, batch_id)
    if batch["status"] == "committed":
        raise ImportError_("the batch was already imported")
    rows = load_rows(store, batch_id)
    row = next((r for r in rows if r["n"] == n), None)
    if row is None:
        raise KeyError(n)
    return batch, rows, row


def update_row(svc, batch_id: str, n: int, changes: dict) -> dict:
    store = svc.store
    batch, rows, row = _editable(store, batch_id, n)
    if "tags" in changes:
        row["tags"] = _clean_tags(changes["tags"])
        row["default_added"] = []  # the user's own list now: switching defaults never removes from it
    if "checked" in changes:
        row["checked"] = bool(changes["checked"])
    identity = False
    for key in ("artist", "title", "album"):
        if key in changes:
            row[key] = (changes[key] or "").strip() or None
            identity = True
    if "bandcamp_url" in changes:  # a pasted Bandcamp page: the row's hint (then re_resolve reads it)
        url = _clean_page_url(changes["bandcamp_url"])
        row["bandcamp_url"] = url or None
        if (_own(row) or {}).get("via") in ("resolved", "chosen"):
            row["bandcamp"] = None  # the pasted page replaces what the search found
            row["match"] = _empty_match()
        identity = True
    if changes.get("re_resolve") and _own(row) is None:
        stop = _stop_reason(svc, batch)
        if stop:  # stopped or off: the same state, no request
            row["match"] = _unavailable(*stop)
        else:
            _try_lookup(svc, batch, svc.bandcamp_fetcher(), row)
        identity = True
    if "choose" in changes:  # a Bandcamp candidate, or None: not on Bandcamp (→ other)
        match = dict(row.get("match") or _empty_match())
        cid = changes["choose"]
        if cid is None:
            match.update(chosen=None, status="manual", source=None)
            row["bandcamp"] = None
        else:
            cand = next((c for c in match.get("candidates") or [] if c["id"] == cid), None)
            if cand is None:
                raise ImportError_(f"{cid} is not one of the row's candidates")
            match.update(chosen=cand, status="manual", source="picked")
            row["bandcamp"] = {"item": bandcamp.minimal_item(cand), "via": "chosen"}
        row["match"] = match
        identity = True
    if "match_url" in changes:  # a Bandcamp page the user found; nothing is fetched
        url = _clean_page_url(changes["match_url"], "match_url")
        if url:
            row["match"] = {**_empty_match(), "status": "manual", "source": "url", "url": url}
        else:
            row["match"] = {**_empty_match(), "status": "manual"}
        row["bandcamp"] = None
        identity = True
    if "path" in changes:  # the user picks the file (like the collection's Located popover); None: back to auto
        if changes["path"]:
            row["located"] = _manual_location(svc, changes["path"])
        else:
            row["located"] = {"status": "unknown", "best": None, "candidates": []}
            _locate(svc, [row])
    if changes.get("link_item") is not None:  # the item the extension saved from the page
        return link_row(svc, batch_id, n, {"item": changes["link_item"]})
    if identity:
        _check_duplicate(DuplicateIndex(store), row)
        _locate(svc, [row])
    _refresh(row)
    _save_rows(store, batch_id, [row])
    _refresh_stats(store, batch, rows)
    _row_event(svc, batch_id, n, len(rows))
    return row


def _clean_page_url(value: str | None, key: str = "bandcamp_url") -> str:
    """https://host/(track|album)/slug, query and fragment dropped; "" clears; 400 for anything else."""
    url = (value or "").strip().split("?")[0].split("#")[0].rstrip("/")
    if url and not _PAGE_URL.match(url):
        raise ImportError_(f"{key} must look like https://host/track/slug or https://host/album/slug")
    return url


def _manual_location(svc, path: str) -> dict[str, Any]:
    from .indexer import index_file
    from .matcher import _file_entry

    try:
        found = index_file(svc.store, path, svc.settings.roots())
    except FileNotFoundError:
        raise ImportError_(f"no such file: {path}") from None
    except (ValueError, OSError) as e:
        raise ImportError_(str(e)) from None
    view = svc.file_index().by_path.get(found["path"])
    if view is None:
        raise ImportError_(f"couldn't index {path}")
    best = _file_entry(view, {"confidence": 1.0, "method": "manual"})
    return {"status": "located", "best": best, "candidates": [], "manual": True, "match_source": "manual"}


def locate_row(svc, batch_id: str, n: int) -> dict:
    """Search again for one row's file: quick scan for new files, then locate (a hand-picked file is
    replaced by what the search finds)."""
    store = svc.store
    batch, rows, row = _editable(store, batch_id, n)
    scan = _refresh_index(svc, batch=batch)
    row["located"] = {"status": "unknown", "best": None, "candidates": []}
    _locate(svc, [row])
    _save_rows(store, batch_id, [row])
    _refresh_stats(store, batch, rows)
    _row_event(svc, batch_id, n, len(rows))
    return {**row, "scan": scan}


def relocate_batch(svc, batch_id: str, which: Any = "missing", scan: str | None = None, ctx=None) -> dict:
    """Locate a batch's rows again ("missing", "all" or a list of row numbers) after a quick scan for
    files added since the batch was created. Hand-picked files stay."""
    store = svc.store
    batch = load_batch(store, batch_id)
    if batch["status"] == "committed":
        raise ImportError_("the batch was already imported")
    rows = load_rows(store, batch_id)
    if which == "missing":
        targets = [r for r in rows if (r.get("located") or {}).get("status") != "located"]
    elif which == "all":
        targets = list(rows)
    else:
        wanted = {int(x) for x in which}
        targets = [r for r in rows if r["n"] in wanted]
    targets = [r for r in targets if not (r.get("located") or {}).get("manual") and not r.get("committed")]
    if ctx:
        ctx.progress(0, len(targets), "scanning for new files")
    scan_stats = _refresh_index(svc, ctx, batch, scan)
    before = {r["n"]: ((r.get("located") or {}).get("status"), ((r.get("located") or {}).get("best") or {}).get("path"))
              for r in targets}
    if ctx:
        ctx.progress(0, len(targets), f"locating {len(targets)} rows")
    _locate(svc, targets)
    newly = [r["n"] for r in targets if r["located"]["status"] == "located" and before[r["n"]][0] != "located"]
    changed = [r["n"] for r in targets if (r["located"]["status"], (r["located"].get("best") or {}).get("path"))
               != before[r["n"]]]
    _save_rows(store, batch_id, rows)
    _refresh_stats(store, batch, rows)
    svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": "located", "current": len(newly),
                                    "total": len(targets)})
    return {"batch_id": batch_id, "checked": len(targets), "newly_located": newly, "changed": changed,
            "still_missing": sum(r["located"]["status"] != "located" for r in targets),
            "scan": {k: v for k, v in (scan_stats or {}).items() if k != "roots"}, "stats": batch["stats"]}


def _row_event(svc, batch_id: str, n: int, total: int) -> None:
    svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": "row", "n": n, "current": n, "total": total})


def link_row(svc, batch_id: str, n: int, payload: dict) -> dict:
    """Link a row to the Bandcamp page the user has open (the extension sends the page's item, or
    its ``data-tralbum``); ``{item: null}`` unlinks."""
    store = svc.store
    batch, rows, row = _editable(store, batch_id, n)
    item = bandcamp.tagger_item(payload["tralbum"], payload.get("embed") or {}) if payload.get("tralbum") \
        else payload.get("item")
    if item is None:  # unlink
        row["bandcamp"] = None
        row["match"] = {**_empty_match(), "status": "manual"}
    else:
        try:
            item = bandcamp.link_item(item)
        except ValueError as e:
            raise ImportError_(str(e)) from e
        cand = {"id": item["id"], "type": item["item_type"], "title": item["title"], "artist": item.get("artist"),
                "album": item.get("album_title"), "url": item.get("item_url"), "art_url": item.get("art_url"),
                "confidence": 1.0, "album_id": item.get("album_id"), "band_id": item.get("band_id")}
        row["match"] = {**_empty_match(), "status": "manual", "source": "linked", "confidence": 1.0, "chosen": cand,
                        "candidates": [cand]}
        row["bandcamp"] = {"item": item, "via": "linked", "linked_at": now_iso(),
                           "page_url": payload.get("page_url") or item.get("item_url")}
    _check_duplicate(DuplicateIndex(store), row)
    _locate(svc, [row])
    _save_rows(store, batch_id, [row])
    _refresh_stats(store, batch, rows)
    _row_event(svc, batch_id, n, len(rows))
    return row


def open_rows(svc) -> list[dict]:
    """Rows of uncommitted batches that have no Bandcamp item yet (cheap: the content script asks
    on every Bandcamp page view)."""
    rows = svc.store.query(
        "SELECT b.id AS batch_id, json_extract(b.data, '$.name') AS batch_name, r.n, r.data FROM import_rows r "
        "JOIN import_batches b ON b.id = r.batch_id "
        "WHERE json_extract(b.data, '$.status') = 'ready' AND json_extract(r.data, '$.bandcamp') IS NULL "
        "AND json_extract(r.data, '$.committed') IS NULL ORDER BY b.created_at DESC, r.n"
    )
    out = []
    for r in rows:
        row = json.loads(r["data"])
        match = row.get("match") or {}
        out.append({"batch_id": r["batch_id"], "batch_name": r["batch_name"], "n": r["n"], "line": row.get("line"),
                    "artist": row.get("artist"), "title": row.get("title"), "album": row.get("album"),
                    "position": row.get("position"), "track_num": row.get("track_num"),
                    "hint": (row.get("hints") or {}).get("bandcamp_url"),
                    "match_url": match.get("url") if match.get("source") == "url" else None})
    return out


class _PageItem:
    def __init__(self, item: dict):
        self.title, self.artist, self.album = item.get("title") or "", item.get("artist"), item.get("album_title")


def link_candidates(svc, payload: dict, limit: int = 5) -> list[dict]:
    """Rows of open batches that fit the Bandcamp page the user has open, best first: the row's
    Bandcamp hint is this page (or its album), or artist + title agree."""
    if payload.get("tralbum"):
        item = bandcamp.tagger_item(payload["tralbum"], payload.get("embed") or {})
    else:
        item = payload.get("item") or {}
    page = bandcamp.page_key(payload.get("page_url") or item.get("item_url"))
    album_page = bandcamp.page_key(item.get("album_url"))
    found = _PageItem(item)
    out = []
    for b in list_batches(svc):
        if b["status"] != "ready":
            continue
        for row in load_rows(svc.store, b["batch_id"]):
            if row.get("committed"):
                continue
            hint = bandcamp.page_key((row.get("hints") or {}).get("bandcamp_url"))
            hint_match = bool(hint) and hint in (page, album_page)
            score = score_row(found, row) if found.title else 0.0
            if hint_match or score >= 0.6:
                bc = row.get("bandcamp") or {}
                out.append({"batch_id": b["batch_id"], "batch_name": b["name"], "n": row["n"],
                            "artist": row.get("artist"), "title": row.get("title"), "album": row.get("album"),
                            "score": round(score, 3), "hint_match": hint_match,
                            "bandcamp_id": (bc.get("item") or {}).get("id"), "via": bc.get("via")})
    out.sort(key=lambda r: (-r["score"], not r["hint_match"]))
    return out[:limit]


def _default_added(batch: dict, row: dict) -> list[str]:
    if "default_added" in row:
        return [t for t in row["default_added"] if t in row["tags"]]
    # batches from before default_added: defaults only ever went to untagged rows
    return [t for t in batch.get("default_tags") or [] if t in row["tags"]] if row.get("default_tags_applied") else []


def set_default_tags(svc, batch_id: str, tags: list[str], to_all: bool) -> dict:
    """Re-apply the default tags to a batch's rows (not imported yet): first take off what earlier
    defaults added, then add the new ones (to untagged rows, or with ``to_all`` to every row). Tags from
    the file or the user's own edits are never removed. No lookups."""
    store = svc.store
    batch = load_batch(store, batch_id)
    if batch["status"] == "committed":
        raise ImportError_("the batch was already imported")
    tags = _clean_tags(tags)
    rows = load_rows(store, batch_id)
    changed = 0
    for row in rows:
        if row.get("committed"):
            continue
        previous = _default_added(batch, row)
        own = [t for t in row["tags"] if t not in previous]
        new, added = _with_defaults(own, tags, to_all)
        if new != row["tags"] or added != row.get("default_added"):
            changed += new != row["tags"]
            row.update(tags=new, default_added=added, default_tags_applied=bool(added))
    batch.update(default_tags=tags, default_tags_all=bool(to_all))
    _save_rows(store, batch_id, rows)
    _refresh_stats(store, batch, rows)
    svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": "tags", "current": changed, "total": len(rows)})
    return {"default_tags": tags, "default_tags_all": bool(to_all), "rows_changed": changed,
            "stats": batch["stats"], "rows": rows}


def apply_tag_mapping(svc, batch_id: str, mapping: dict[str, list[str]], unmapped: str) -> dict:
    if unmapped not in ("create", "ignore"):
        raise ImportError_("unmapped must be 'create' or 'ignore'")
    store = svc.store
    batch = load_batch(store, batch_id)
    rows = load_rows(store, batch_id)
    unknown = set(batch.get("unknown_tags") or {})
    mapping = {k: _clean_tags(v if isinstance(v, list) else [v]) for k, v in (mapping or {}).items()}
    changed = 0
    for row in rows:
        new: list[str] = []
        for t in row["tags"]:
            if t in unknown:
                if mapping.get(t):
                    new += mapping[t]
                elif unmapped == "create":
                    new.append(t)
            else:
                new.append(t)
        new = _clean_tags(new)
        if new != row["tags"]:
            row["tags"] = new
            changed += 1
    vocab = set(store.get_tags())
    batch["new_tags"] = sorted({t for r in rows for t in r["tags"] if t not in vocab})
    batch["unknown_tags"] = {}
    batch["tag_mapping"] = {"map": mapping, "unmapped": unmapped}
    _save_rows(store, batch_id, rows)
    _refresh_stats(store, batch, rows)
    svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": "tags", "current": changed, "total": len(rows)})
    return {"unknown_tags": {}, "new_tags": batch["new_tags"], "rows_changed": changed}


# -- commit ------------------------------------------------------------------------------------------


def commit(svc, batch_id: str) -> dict:
    store = svc.store
    batch = load_batch(store, batch_id)
    if batch["status"] == "committed":
        raise ImportError_("the batch was already imported")
    if batch["status"] != "ready":
        raise ImportError_(f"the batch isn't ready ({batch['status']})")
    svc.committing.add(batch_id)
    batch.update(status="committing", error=None)
    _save_batch(store, batch)
    try:
        return _commit(svc, batch)
    except Exception as e:
        batch.update(status="ready", error=f"The import stopped: {type(e).__name__}: {e}. Import again: rows "
                                            "already imported are skipped.")
        _save_batch(store, batch)
        raise
    finally:
        svc.committing.discard(batch_id)


def _commit(svc, batch: dict) -> dict:
    store, batch_id = svc.store, batch["batch_id"]
    rows = load_rows(store, batch_id)
    dups = DuplicateIndex(store)
    vocab = store.get_tags()
    result = {"pending_adds": 0, "tag_merges": 0, "other_added": 0, "other_merged": 0, "new_tags": [], "skipped": 0}
    stamp = now_ms_iso()
    used_tags: list[str] = []
    for row in rows:
        if row.get("checked"):
            used_tags += row["tags"]  # also rows done before a restart: their new tags still count
        if not row.get("checked") or row.get("committed"):
            result["skipped"] += 1
            continue
        tags = row["tags"]
        _check_duplicate(dups, row)
        dup = row["duplicate"]
        if dup and dup["source"] == "bandcamp":
            if dup.get("pending"):
                merge_pending_item_tags(store, dup["of"], tags)
            else:
                union = list(dict.fromkeys(dup["tags"] + tags))
                if union != dup["tags"]:
                    svc.queue_tag_edit(dup["of"], union)
            row["committed"] = "tag_merge"
            result["tag_merges"] += 1
        elif dup:  # an existing "other" item
            existing = other_get(store, dup["of"]) or {}
            other_put(store, {**existing, "tags": list(dict.fromkeys((existing.get("tags") or []) + tags))})
            row["committed"] = "other_merge"
            result["other_merged"] += 1
        elif row["source"] == "bandcamp":
            item = {**row["bandcamp"]["item"], "tags": tags, "date_added": stamp}
            queue_add(store, item=item)
            dups.add({**item, "source": "bandcamp", "pending": "tagger"})
            row["committed"] = "pending_add"
            result["pending_adds"] += 1
        else:
            item = other_put(store, {
                **row_item(row), "date_added": stamp, "import_batch": batch_id,
                **{k: row.get(k) for k in OTHER_FIELDS if row.get(k) is not None},
            })
            dups.add(item)
            row["committed"] = "other"
            result["other_added"] += 1
        located = row.get("located") or {}
        if located.get("manual") and located.get("best"):  # the hand-picked file: confirmed for the new item
            item_id = (row["duplicate"] or {}).get("of") or row_item(row)["id"]
            with store.tx() as c:
                c.execute("DELETE FROM match_overrides WHERE item_id = ? AND decision = 'confirm'", (item_id,))
                c.execute("INSERT INTO match_overrides(item_id, path, decision, created_at) VALUES(?, ?, 'confirm', ?)",
                          (item_id, located["best"]["path"], now_iso()))
        _save_rows(store, batch_id, [row])  # done rows are skipped if a restart makes the user import again
    new_tags = [t for t in dict.fromkeys(used_tags) if t not in vocab]
    if new_tags:
        svc.sync_tags(vocab + new_tags)
        queue_add(store, tags=new_tags)
    result["new_tags"] = new_tags
    batch.update(status="committed", committed_at=now_iso(), commit_result=result)
    _save_rows(store, batch_id, rows)
    _refresh_stats(store, batch, rows)
    svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": "committed", "current": len(rows), "total": len(rows)})
    return result


def discard(svc, batch_id: str) -> dict:
    load_batch(svc.store, batch_id)
    with svc.store.tx() as c:
        c.execute("DELETE FROM import_rows WHERE batch_id = ?", (batch_id,))
        c.execute("DELETE FROM import_batches WHERE id = ?", (batch_id,))
    return {"deleted": True}

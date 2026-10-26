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

import json
import secrets
from typing import Any

from . import bandcamp
from .collection import (
    DuplicateIndex, by_number, merge_pending_item_tags, now_ms_iso, other_get, other_id, other_put, queue_add,
    search_links,
)
from .fetcher import Unavailable
from .rowmatch import score_row
from .store import now_iso

FORMAT = "bc-tagger-import/1"
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
    return {"status": "pending", "source": None, "confidence": 0.0, "query": None, "candidates": [], "chosen": None}


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
    """Link hints from the import file."""
    return {"bandcamp_url": row.get("bandcamp_url"), "discogs_url": row.get("discogs_url")}


def _refresh(row: dict) -> None:
    row["source"] = "bandcamp" if row.get("bandcamp") else "other"
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


def _locate(svc, rows: list[dict], index=None) -> None:
    from .matcher import locate_item

    index = index or svc.file_index()
    cfg = svc.match_config()
    for row in rows:
        result = locate_item(row_item(row), index, cfg)
        row["located"] = {"status": result["status"], "best": result["best"], "candidates": result["candidates"][:3]}


def _item_for(fetcher, candidate: dict) -> dict:
    try:
        return bandcamp.fetch_item(fetcher, candidate) or bandcamp.minimal_item(candidate)
    except Unavailable:
        return bandcamp.minimal_item(candidate)


def _lookup(fetcher, row: dict) -> None:
    """The file's Bandcamp URL when it has one, else a Bandcamp search."""
    hint = row.get("bandcamp_url")
    found = bandcamp.item_from_page(fetcher, hint, row) if hint and bandcamp.is_bandcamp_url(hint) else None
    if found:
        item, confidence = found
        cand = {"id": item["id"], "type": item["item_type"], "title": item["title"], "artist": item.get("artist"),
                "album": item.get("album_title"), "url": item.get("item_url"), "art_url": item.get("art_url"),
                "confidence": round(confidence, 3)}
        row["match"] = {"status": "accepted", "source": "file_url", "confidence": cand["confidence"], "query": hint,
                        "candidates": [cand], "chosen": cand}
        row["bandcamp"] = {"item": item, "via": "resolved"}
        return
    match = bandcamp.resolve(fetcher, row)
    row["match"] = match
    row["bandcamp"] = {"item": _item_for(fetcher, match["chosen"]), "via": "resolved"} if match["chosen"] else None


# -- create ---------------------------------------------------------------------------------------


def create_batch(svc, file_obj: dict, default_tags: list[str], name: str | None = None) -> dict:
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
        tags = _clean_tags(it.get("tags"))
        row.update(
            n=n, tags=tags or list(default_tags), default_tags_applied=not tags and bool(default_tags),
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
        "unknown_tags": unknown, "new_tags": [], "tag_mapping": None, "source_file": file_obj.get("source"),
        "revision": file_obj.get("revision"), "pending_releases": list(file_obj.get("pending_releases") or []),
        "job_id": None, "stats": {}, "committed_at": None, "commit_result": None,
    }
    _save_rows(svc.store, batch["batch_id"], rows)
    _refresh_stats(svc.store, batch, rows)
    return batch


# -- look up + locate -------------------------------------------------------------------------------


def run_batch(svc, batch_id: str, ctx=None) -> dict:
    store = svc.store
    batch = load_batch(store, batch_id)
    rows = load_rows(store, batch_id)
    fetcher = svc.bandcamp_fetcher()
    dups = DuplicateIndex(store)

    def event(phase, current, total):
        svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": phase, "current": current, "total": total})
        if ctx:
            ctx.progress(current, total, f"{phase} {current}/{total}")

    try:
        for i, row in enumerate(rows, 1):
            _check_duplicate(dups, row)
            if row["source"] == "bandcamp":
                row["match"] = {**_empty_match(), "status": "in_collection"}
            else:
                try:
                    _lookup(fetcher, row)
                except Exception as e:  # one bad row must not stop the batch
                    row["match"] = {**_empty_match(), "status": "error", "error": f"{type(e).__name__}: {e}"}
                _check_duplicate(dups, row)
            if i % 10 == 0 or i == len(rows):
                _save_rows(store, batch_id, rows)
            event("resolving", i, len(rows))
        event("locating", 0, len(rows))
        _locate(svc, rows)
        _save_rows(store, batch_id, rows)
        batch["status"] = "ready"
        event("done", len(rows), len(rows))
    except Exception as e:
        batch.update(status="error", error=f"{type(e).__name__}: {e}")
        _save_rows(store, batch_id, rows)
        _refresh_stats(store, batch, rows)
        svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": "error", "current": 0, "total": len(rows)})
        raise
    _refresh_stats(store, batch, rows)
    return {"batch_id": batch_id, "stats": batch["stats"], "network_requests": fetcher.network_requests}


# -- review ----------------------------------------------------------------------------------------


def get_batch(svc, batch_id: str) -> dict:
    batch = load_batch(svc.store, batch_id)
    return {**batch, "rows": load_rows(svc.store, batch_id)}


def list_batches(svc) -> list[dict]:
    rows = svc.store.query("SELECT data FROM import_batches ORDER BY created_at DESC")
    return [{k: b[k] for k in ("batch_id", "name", "created_at", "status", "stats")}
            for b in (json.loads(r["data"]) for r in rows)]


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
    if "checked" in changes:
        row["checked"] = bool(changes["checked"])
    identity = False
    for key in ("artist", "title", "album"):
        if key in changes:
            row[key] = (changes[key] or "").strip() or None
            identity = True
    if changes.get("re_resolve"):
        try:
            _lookup(svc.bandcamp_fetcher(), row)
        except Unavailable as e:
            row["match"] = {**_empty_match(), "status": "error", "error": str(e)}
            row["bandcamp"] = None
        identity = True
    if "choose" in changes:  # a Bandcamp candidate, or None: not on Bandcamp (→ other)
        match = dict(row.get("match") or _empty_match())
        cid = changes["choose"]
        if cid is None:
            match.update(chosen=None, status="manual")
            row["bandcamp"] = None
        else:
            cand = next((c for c in match.get("candidates") or [] if c["id"] == cid), None)
            if cand is None:
                raise ImportError_(f"{cid} is not one of the row's candidates")
            match.update(chosen=cand, status="manual")
            row["bandcamp"] = {"item": _item_for(svc.bandcamp_fetcher(), cand), "via": "chosen"}
        row["match"] = match
        identity = True
    if identity:
        _check_duplicate(DuplicateIndex(store), row)
        _locate(svc, [row])
    _refresh(row)
    _save_rows(store, batch_id, [row])
    _refresh_stats(store, batch, rows)
    return row


def link_row(svc, batch_id: str, n: int, payload: dict) -> dict:
    """Link a row to the Bandcamp page the user has open (the extension sends the page's item, or
    its ``data-tralbum``); ``{item: null}`` unlinks."""
    store = svc.store
    batch, rows, row = _editable(store, batch_id, n)
    item = bandcamp.tagger_item(payload["tralbum"], payload.get("embed") or {}) if payload.get("tralbum") \
        else payload.get("item")
    if item is None:
        row["bandcamp"] = None
        if (row.get("match") or {}).get("chosen"):  # back to what the resolver found
            row["bandcamp"] = {"item": _item_for(svc.bandcamp_fetcher(), row["match"]["chosen"]),
                               "via": "chosen" if row["match"]["status"] == "manual" else "resolved"}
    else:
        try:
            item = bandcamp.link_item(item)
        except ValueError as e:
            raise ImportError_(str(e)) from e
        row["bandcamp"] = {"item": item, "via": "linked", "linked_at": now_iso(),
                           "page_url": payload.get("page_url") or item.get("item_url")}
    _check_duplicate(DuplicateIndex(store), row)
    _locate(svc, [row])
    _save_rows(store, batch_id, [row])
    _refresh_stats(store, batch, rows)
    svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": "linked", "current": n, "total": len(rows)})
    return row


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
    return {"unknown_tags": {}, "new_tags": batch["new_tags"], "rows_changed": changed}


# -- commit ------------------------------------------------------------------------------------------


def commit(svc, batch_id: str) -> dict:
    store = svc.store
    batch = load_batch(store, batch_id)
    if batch["status"] == "committed":
        raise ImportError_("the batch was already imported")
    if batch["status"] != "ready":
        raise ImportError_(f"the batch isn't ready ({batch['status']})")
    rows = load_rows(store, batch_id)
    dups = DuplicateIndex(store)
    vocab = store.get_tags()
    result = {"pending_adds": 0, "tag_merges": 0, "other_added": 0, "other_merged": 0, "new_tags": [], "skipped": 0}
    stamp = now_ms_iso()
    used_tags: list[str] = []
    for row in rows:
        if not row.get("checked") or row.get("committed"):
            result["skipped"] += 1
            continue
        tags = row["tags"]
        used_tags += tags
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

"""Download owned releases for collection items and import rows that aren't located (Phase 4).

Each ref is an item id (``t123``/``a456``) or an import row (``<batch_id>:<n>``). Tracks map to their
album when the album is owned (else the track itself if it was bought alone); releases are
deduped and given to the downloader together, ``download_parallel`` at a time (one download job at a time,
though). After each run its folders are indexed and the affected items and rows are located again.
Bandcamp's bot check or a rate limit stops the remaining releases.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from . import downloader
from .downloader import DownloadRefused
from .items import album_name
from .store import now_iso
from .tagread import AUDIO_EXTS

_one_at_a_time = threading.Lock()
CHUNK_FACTOR = 3  # releases per downloader run: this many times download_parallel

MESSAGES = {
    "downloaded": "downloaded",
    "on_disk": "already on disk",
    "cached": "downloaded before (the downloader's cache): nothing new; download again with force",
    "redownloaded": "downloaded again: the downloader's cache listed it, but its files weren't found",
    "not_in_collection": "not in your Bandcamp collection",
    "challenged": "Bandcamp answered with its bot check; downloads stopped",
    "rate_limited": "Bandcamp is rate-limiting; try again later",
    "failed": "the download failed",
}


def _owned(store, ids: list[str]) -> set[str]:
    ids = [i for i in ids if i]
    if not ids:
        return set()
    marks = ",".join("?" * len(ids))
    return {r["id"] for r in store.query(f"SELECT id FROM owned_ids WHERE id IN ({marks})", ids)}


def release_for(store, item: dict, full_release: bool = False) -> str | None:
    """The collection item to download for ``item``. Default ("Download File"): the track itself when it
    was bought alone, else its album (the only way to get it). ``full_release``: always the album or EP
    the track is on, which must be owned. An album item is its own release either way."""
    album = item.get("album_id")
    album = f"a{album}" if isinstance(album, int) else album
    if str(item["id"]).startswith("a"):
        album = item["id"]
    owned = _owned(store, [album if isinstance(album, str) and album.startswith("a") else None, item["id"]])
    if full_release:
        return album if album in owned else None
    if item["id"] in owned:
        return item["id"]
    return album if album in owned else None


def _resolve(svc, ref: str, collection: dict[str, dict]) -> dict[str, Any]:
    """``{ref, item, located, row?}`` or ``{ref, error}``."""
    from . import importer

    if ":" in ref:
        batch_id, _, n = ref.rpartition(":")
        try:
            row = next((r for r in importer.load_rows(svc.store, batch_id) if str(r["n"]) == n), None)
        except KeyError:
            row = None
        if row is None:
            return {"ref": ref, "error": "no such import row"}
        item = (row.get("bandcamp") or {}).get("item")
        if not item:
            return {"ref": ref, "error": "not a Bandcamp row: link it to its Bandcamp page first"}
        return {"ref": ref, "item": item, "row": (batch_id, row["n"]),
                "located": (row.get("located") or {}).get("status") == "located"}
    item = collection.get(ref)
    if item is None:
        return {"ref": ref, "error": "no such item"}
    if str(ref).startswith("o"):
        return {"ref": ref, "error": "not a Bandcamp item"}
    located = svc.store.query_one("SELECT status FROM locate_results WHERE item_id = ?", (ref,))
    return {"ref": ref, "item": item, "located": bool(located) and located["status"] == "located"}


def plan(svc, refs: list[str], force: bool = False, full_release: bool = False) -> dict[str, Any]:
    """What a download would do: ``{destination, format, releases: [{release, refs, title, artist}], items:
    [{ref, item_id, title, artist, release, state: "queued"|"skipped"|"failed", message}]}``."""
    folder = downloader.downloads_dir(svc.settings)
    collection = {it["id"]: it for it in svc.collection_items()}
    items, releases = [], {}
    for ref in dict.fromkeys(refs):
        r = _resolve(svc, ref, collection)
        item = r.get("item") or {}
        entry = {"ref": ref, "item_id": item.get("id"), "title": item.get("title"), "artist": item.get("artist"),
                 "release": None, "state": "failed", "message": r.get("error")}
        if item:
            release = release_for(svc.store, item, full_release)
            if release is None:
                entry["message"] = "not owned"
                if full_release and release_for(svc.store, item) is not None:
                    entry["message"] = "the full release isn't owned (only this track)"
            elif r["located"] and not force:
                entry.update(release=release, state="skipped", message="already located")
            else:
                entry.update(release=release, state="queued", message="queued")
                # an album item's album_title is a URL slug: its own title is the album's
                title = (album_name(item) if release.startswith("a") else None) or item.get("title")
                rel = releases.setdefault(release, {"release": release, "refs": [], "title": title,
                                                    "artist": item.get("artist")})
                rel["refs"].append(ref)
        items.append(entry)
    return {"destination": str(folder), "format": svc.settings.get("download_format"),
            "releases": list(releases.values()), "items": items}


def _index_folder(svc, folder: str | None) -> int:
    from .indexer import index_file

    if not folder or not Path(folder).is_dir():
        return 0
    roots = svc.settings.roots()
    n = 0
    for p in sorted(Path(folder).rglob("*")):
        if p.is_file() and p.suffix.lower() in AUDIO_EXTS and not p.name.startswith("."):
            index_file(svc.store, p, roots)
            n += 1
    return n


def _locate_refs(svc, entries: list[dict]) -> dict[str, bool]:
    from . import importer

    located: dict[str, bool] = {}
    items = [e["item_id"] for e in entries if ":" not in e["ref"]]
    if items:
        for s in svc.locate(ids=items, scan="none")["items"]:
            located[s["id"]] = s["status"] == "located"
    for e in entries:
        if ":" in e["ref"]:
            batch_id, _, n = e["ref"].rpartition(":")
            batch = importer.load_batch(svc.store, batch_id)
            rows = importer.load_rows(svc.store, batch_id)
            row = next(r for r in rows if str(r["n"]) == n)
            importer._locate(svc, [row])
            importer._save_rows(svc.store, batch_id, [row])
            importer._refresh_stats(svc.store, batch, rows)
            importer._row_event(svc, batch_id, row["n"], len(rows))
            located[e["ref"]] = row["located"]["status"] == "located"
        else:
            located[e["ref"]] = located.get(e["item_id"], False)
    return located


def run(svc, refs: list[str], force: bool = False, ctx=None, full_release: bool = False) -> dict[str, Any]:
    p = plan(svc, refs, force, full_release)
    job_id = ctx.job.id if ctx else None
    by_ref = {e["ref"]: e for e in p["items"]}

    def publish(entry: dict) -> None:
        svc.jobs.bus.publish("download", {"job_id": job_id, **{k: entry.get(k) for k in (
            "ref", "item_id", "release", "state", "message", "located")}})

    for e in p["items"]:
        publish(e)
    results: list[dict] = []
    try:
        stop = _run_releases(svc, p, by_ref, force, ctx, job_id, publish, results)
    finally:
        _record(svc, p["items"], results, full_release, job_id)
    if ctx:
        ctx.progress(len(p["releases"]), len(p["releases"]), "downloads done")
    return {"destination": p["destination"], "releases": results, "items": p["items"], "stopped": stop}


def _record(svc, entries: list[dict], results: list[dict], full_release: bool, job_id: str | None) -> None:
    """Keep what each item got (done or failed; not skipped ones) for the import logs."""
    folders = {r["release"]: r.get("folder") for r in results}
    at = now_iso()
    with svc.store.tx() as c:
        for e in entries:
            if e["state"] in ("done", "failed"):
                c.execute("INSERT INTO download_log(ref, item_id, release, full_release, state, message, folder, job_id, at) "
                          "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                          (e["ref"], e.get("item_id"), e.get("release"), int(bool(full_release)), e["state"],
                           e.get("message"), folders.get(e.get("release")), job_id, at))


def downloads_for(store, item_ids: list[str], refs: list[str], since: str) -> list[dict]:
    """Downloads recorded for these items (since ``since``) or these refs, oldest first."""
    ids, refs = [i for i in item_ids if i], [r for r in refs if r]
    if not ids and not refs:
        return []
    marks = lambda xs: ",".join("?" * len(xs)) or "NULL"  # noqa: E731
    return [dict(r) for r in store.query(
        f"SELECT ref, item_id, release, full_release, state, message, folder, at FROM download_log "
        f"WHERE (item_id IN ({marks(ids)}) AND at >= ?) OR ref IN ({marks(refs)}) ORDER BY seq",
        (*ids, since, *refs))]


def _failed(release: str, err: Exception) -> dict[str, Any]:
    return {"release": release, "outcome": "failed", "ok": False, "folder": None, "files": [], "errors": [str(err)],
            "retries": []}


def _run_releases(svc, p: dict, by_ref: dict, force: bool, ctx, job_id, publish, results: list[dict]) -> str | None:
    """The plan's releases, ``download_parallel`` at a time in one downloader run per chunk (a few times the
    parallel count, so items get located as chunks finish). Returns why the rest stopped, if they did."""
    stop = None
    rels = p["releases"]
    total, done = len(rels), 0
    chunk_size = max(1, int(svc.settings.get("download_parallel")) * CHUNK_FACTOR)
    entries_of = {rel["release"]: [by_ref[r] for r in rel["refs"]] for rel in rels}
    names = {rel["release"]: rel["title"] or rel["release"] for rel in rels}
    active: dict[str, str] = {}  # release → its latest message, for the job's progress line

    def report(release, message, percent=None):
        if release is None:  # a line about the whole run
            if ctx:
                ctx.progress(done, total, message)
            return
        active[release] = message
        if ctx:  # e.g. "MSP01: retry 1/3: read timed out · Atacama EP: downloading 42 %"
            ctx.progress(done, total, " · ".join(f"{names[r]}: {m}" for r, m in active.items()))
        for e in entries_of[release]:  # per-row progress for the UI
            svc.jobs.bus.publish("download", {"job_id": job_id, "ref": e["ref"], "item_id": e["item_id"],
                                              "release": release, "state": "downloading",
                                              "message": message, "percent": percent, "located": None})

    def download(chunk: list[dict], forced: bool) -> dict[str, dict]:
        try:
            run = downloader.run_releases(svc.settings, [{k: r[k] for k in ("release", "title", "artist")} for r in chunk],
                                          p["format"], forced, on_line=report)
        except (DownloadRefused, OSError) as err:
            return {r["release"]: _failed(r["release"], err) for r in chunk}
        res_by = run["releases"]
        unmatched = [r for r in chunk if res_by[r["release"]]["outcome"] == "unmatched"]
        if unmatched:  # the output didn't say which release a folder is: index them all, then look for ours
            for folder in run["folders"]:
                _index_folder(svc, folder)
            for rel in unmatched:
                located = _locate_refs(svc, entries_of[rel["release"]])
                ok = bool(located) and all(located.values())
                why = "; ".join(run["stray_errors"]) or "nothing about it in the downloader's output"
                res_by[rel["release"]].update(outcome="downloaded" if ok else "failed", ok=ok,
                                              errors=[] if ok else [f"couldn't tell which release failed: {why}"])
        return res_by

    with _one_at_a_time:
        for start in range(0, total, chunk_size):
            chunk = rels[start:start + chunk_size]
            if stop:
                for rel in chunk:
                    for e in entries_of[rel["release"]]:
                        e.update(state="failed", message=stop)
                        publish(e)
                continue
            for rel in chunk:
                for e in entries_of[rel["release"]]:
                    e.update(state="downloading", message=f"waiting to download {names[rel['release']]}")
                    publish(e)
            if ctx:
                ctx.progress(done, total, f"downloading {done + 1}–{done + len(chunk)} of {total}")
            res_by = download(chunk, force)
            failed = next((r for r in res_by.values() if r["outcome"] == "failed"
                           and any("not mounted" in e for e in r["errors"])), None)
            if failed:
                stop = failed["errors"][-1]  # the drive went away: don't try the rest
            # The tool's cache says "downloaded", but the files aren't in the index (moved, renamed or
            # deleted): the user asked for them, so fetch those again, ignoring that cache once.
            again = [rel for rel in chunk if res_by[rel["release"]]["outcome"] == "cached" and not force
                     and not all(_locate_refs(svc, entries_of[rel["release"]]).values())]
            if again and not stop:
                for rel in again:
                    report(rel["release"], "the downloader's cache lists it, but its files weren't found: downloading again")
                for release, res in download(again, True).items():
                    if res["outcome"] == "downloaded":
                        res["outcome"] = "redownloaded"
                    res_by[release] = {**res, "retries": res_by[release].get("retries", []) + res.get("retries", [])}
            for res in res_by.values():
                if res["outcome"] in ("challenged", "rate_limited"):
                    stop = MESSAGES[res["outcome"]]
            for rel in chunk:
                release = rel["release"]
                res, entries = res_by[release], entries_of[release]
                active.pop(release, None)
                indexed = _index_folder(svc, res.get("folder")) if res["ok"] else 0
                located = _locate_refs(svc, entries) if res["ok"] else {}
                for e in entries:
                    message = MESSAGES[res["outcome"]]
                    if res["outcome"] == "failed" and stop and "not mounted" in stop:
                        message = stop
                    elif res["outcome"] == "failed" and res.get("errors"):
                        message = f"{message}: {res['errors'][-1]}"
                    elif res.get("retries"):
                        message = f"{message} (after {len(res['retries'])} retr{'y' if len(res['retries']) == 1 else 'ies'}: " \
                                  f"{res['retries'][-1]})"
                    e.update(state="done" if res["ok"] else "failed", message=message, located=located.get(e["ref"]))
                    publish(e)
                results.append({**{k: v for k, v in res.items() if k != "log_tail"}, "indexed": indexed,
                                "refs": rel["refs"]})
            done += len(chunk)
    return stop

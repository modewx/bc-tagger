"""Download owned releases for collection items and import rows that aren't located (Phase 4).

Each ref is an item id (``t123``/``a456``) or an import row (``<batch_id>:<n>``). Tracks map to their
album when the album is owned (else the track itself if it was bought alone); releases are deduped and
given to ONE downloader run per job (one login and one walk of the collection, like ``bc-download``),
``download_parallel`` at a time, with the tool's ``--force``: only releases that aren't located are queued
(unless the user's ``force``), so the tool's cache must not skip them; and ``--preorders``: a preorder's
tracks that are out now. One download job at a time. Each run's output goes to ``download-logs/<job>.log`` in
the data dir (the last ``KEEP_LOGS``; the job's result names it, ``GET /api/jobs/{id}/log`` serves it).
Bandcamp's first rate limit (429) in a job doesn't end it: what's being downloaded finishes, then after
``BACKOFF_S`` the rest go in one more run with ``--jobs=1``; a rate limit in that run ends the job.
Each release is indexed and its items and rows located as soon as it finishes, on a finisher thread, while
the run goes on. Bandcamp's bot check or a rate limit in the output, or the drive going away, ends the run
at once and fails the releases not finished yet.
"""

from __future__ import annotations

import queue
import re
import threading
import time
from pathlib import Path
from typing import Any

from . import downloader
from .downloader import DownloadRefused
from .items import album_name
from .store import now_iso
from .tagread import AUDIO_EXTS

_one_at_a_time = threading.Lock()
KEEP_LOGS = 30  # download-logs/: the newest this many
BACKOFF_S = 60.0  # after Bandcamp's first rate limit in a run: the pause before the rest go one at a time

MESSAGES = {
    "downloaded": "downloaded",
    "on_disk": "already on disk",
    "cached": "the downloader's cache lists it, so it wasn't fetched",
    "not_in_collection": "not in your Bandcamp collection",
    "challenged": "Bandcamp answered with its bot check; downloads stopped",
    "rate_limited": "Bandcamp is rate-limiting; try again later",
    "failed": "the download failed",
    "unreported": "the downloader didn't report on it; see the download log",
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
    indexed = []
    for p in sorted(Path(folder).rglob("*")):
        if p.is_file() and p.suffix.lower() in AUDIO_EXTS and not p.name.startswith("."):
            indexed.append(index_file(svc.store, p, roots)["path"])
    svc.previews.enqueue(indexed)  # while the files are fresh (AIFF/ALAC only; previews.py)
    return len(indexed)


def _album_of(item: dict) -> str | None:
    album = item.get("album_id")
    return f"a{album}" if isinstance(album, int) else album


def _locate_refs(svc, entries: list[dict], release: str | None = None) -> dict[str, bool]:
    """Locate the downloaded refs: collection items, and import rows (the row, and the collection item it
    is, if any). With ``release`` (after a download), also the collection's other items of that release, so
    a full release or an import row's download shows up in the collection at once."""
    from . import importer
    from .collection import all_items

    located: dict[str, bool] = {}
    collection = {it["id"]: it for it in all_items(svc.store)}
    items = {e["item_id"] for e in entries if e.get("item_id") in collection}
    if release:
        items |= {i for i, it in collection.items() if i == release or _album_of(it) == release}
    if items:
        for s in svc.locate(ids=sorted(items), scan="none")["items"]:
            located[s["id"]] = s["status"] == "located"
            svc.jobs.bus.publish("item", {"id": s["id"]})
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
    log = log_path(svc, job_id or time.strftime("run-%Y%m%d-%H%M%S")) if p["releases"] else None
    try:
        stop = _run_releases(svc, p, by_ref, ctx, job_id, publish, results, log)
    finally:
        order = [rel["release"] for rel in p["releases"]]
        results.sort(key=lambda r: order.index(r["release"]))  # the plan's order, not the finishing order
        _record(svc, p["items"], results, full_release, job_id)
    if ctx:
        ctx.progress(len(p["releases"]), len(p["releases"]), "downloads done")
    return {"destination": p["destination"], "releases": results, "items": p["items"], "stopped": stop,
            "log": str(log) if log and log.exists() else None}


def log_dir(svc) -> Path:
    return svc.settings.path.parent / "download-logs"


def log_path(svc, job_id: str) -> Path:
    """Where a job's downloader output goes; the oldest logs beyond ``KEEP_LOGS`` are removed."""
    if not re.fullmatch(r"[\w.-]+", job_id):
        raise ValueError(f"not a job id: {job_id!r}")
    folder = log_dir(svc)
    if folder.is_dir():
        for old in sorted(folder.glob("*.log"), key=lambda f: f.stat().st_mtime)[:-(KEEP_LOGS - 1)]:
            old.unlink(missing_ok=True)
    return folder / f"{job_id}.log"


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


def _message(res: dict) -> str:
    message = MESSAGES[res["outcome"]]
    errors, retries = res.get("errors") or [], res.get("retries") or []
    if res["outcome"] == "failed" and errors and "not mounted" in errors[-1]:
        return errors[-1]  # the drive went away: say just that
    if res["outcome"] == "failed" and errors:
        message = f"{message}: {errors[-1]}"
    elif res["outcome"] == "unreported" and errors:
        message = f"{message} (the run's last error: {errors[-1]})"
    elif retries and res["ok"]:  # what it took to get it (a stop's own retries say nothing new)
        message = f"{message} (after {len(retries)} retr{'y' if len(retries) == 1 else 'ies'}: {retries[-1]})"
    if res.get("preorder"):
        message = f"a preorder, out {res['preorder']}: {message}"
    return message


def _run_releases(svc, p: dict, by_ref: dict, ctx, job_id, publish, results: list[dict],
                  log: Path | None = None) -> str | None:
    """The plan's releases in one downloader run, ``download_parallel`` at a time. Each release is indexed and
    located on a finisher thread as soon as the tool says it finished (indexing on the thread reading the
    tool's output would stall the pipe, and the downloads with it). Returns why the run stopped, if it did."""
    rels = p["releases"]
    if not rels:
        return None
    total, done = len(rels), 0
    entries_of = {rel["release"]: [by_ref[r] for r in rel["refs"]] for rel in rels}
    names = {rel["release"]: rel["title"] or rel["release"] for rel in rels}
    active: dict[str, str] = {}  # release → its latest message, for the job's progress line
    lock = threading.Lock()  # active, done and the job's progress: the reader and the finisher both touch them
    handed: set[str] = set()  # releases given to the finisher during the run
    indexed_folders: set[str] = set()
    todo: queue.Queue[dict | None] = queue.Queue()
    failures: list[BaseException] = []

    def progress(message: str | None = None) -> None:
        if ctx:
            with lock:  # e.g. "MSP01: retry 1/3: read timed out · Atacama EP: downloading 42 %"
                ctx.progress(done, total, message or " · ".join(f"{names[r]}: {m}" for r, m in active.items()))

    def report(release, message, percent=None):
        if release is None:  # a line about the whole run
            progress(message)
            return
        if release in handed:  # finished: a late line mustn't turn its rows back to "downloading"
            return
        with lock:
            active[release] = message
        progress()
        for e in entries_of[release]:  # per-row progress for the UI
            svc.jobs.bus.publish("download", {"job_id": job_id, "ref": e["ref"], "item_id": e["item_id"],
                                              "release": release, "state": "downloading",
                                              "message": message, "percent": percent, "located": None})

    def finish(res: dict) -> None:
        nonlocal done
        release, entries = res["release"], entries_of[res["release"]]
        indexed = _index_folder(svc, res.get("folder")) if res["ok"] else 0
        if res.get("folder"):
            indexed_folders.add(res["folder"])
        located = _locate_refs(svc, entries, release) if res["ok"] else {}
        message = _message(res)
        for e in entries:
            said = message
            if res["ok"] and res.get("preorder") and not located.get(e["ref"]):
                said = f"a preorder, out {res['preorder']}: downloaded what's out now; this one isn't out yet"
            e.update(state="done" if res["ok"] else "failed", message=said, located=located.get(e["ref"]))
            publish(e)
        results.append({**{k: v for k, v in res.items() if k != "log_tail"}, "indexed": indexed, "refs": [
            e["ref"] for e in entries]})
        with lock:
            active.pop(release, None)
            done += 1
        progress(None if active else f"{names[release]}: {message}")

    def finisher() -> None:
        while (res := todo.get()) is not None:
            if failures:  # an earlier release failed to index or locate: the job fails once the run is over
                continue
            try:
                finish(res)
            except BaseException as err:  # noqa: BLE001 (raised again on the job's thread)
                failures.append(err)

    def on_done(res: dict) -> None:  # on the thread reading the tool's output: hand it over, nothing more
        handed.add(res["release"])
        with lock:
            active.pop(res["release"], None)
        todo.put(res)

    def _back_off(again: list[str]) -> None:
        """Bandcamp rate-limited the first run: say so on the job and the rows, wait, then the rest go one at a
        time."""
        message = f"Bandcamp is rate-limiting: waiting {BACKOFF_S:g} s, then one at a time"
        with lock:
            for r in again:
                active.pop(r, None)
        progress(message)
        for r in again:
            for e in entries_of[r]:
                e.update(state="downloading", message=message)
                publish(e)
        time.sleep(BACKOFF_S)

    with _one_at_a_time:
        for rel in rels:
            for e in entries_of[rel["release"]]:
                e.update(state="downloading", message=f"waiting to download {names[rel['release']]}")
                publish(e)
        progress(f"starting the downloader for {total} release{'s' if total != 1 else ''}")
        worker = threading.Thread(target=finisher, name="download-finisher", daemon=True)
        worker.start()
        spec = {r["release"]: {k: r[k] for k in ("release", "title", "artist")} for r in rels}
        try:
            run = downloader.run_releases(svc.settings, list(spec.values()), p["format"], True, on_line=report,
                                          on_done=on_done, log_path=log, rate_limit="back_off")
            again = [r for r in spec if r not in handed and run["releases"][r]["outcome"] == "rate_limited"]
            if run["stopped"] is None and again:
                _back_off(again)
                try:
                    second = downloader.run_releases(svc.settings, [spec[r] for r in again], p["format"], True,
                                                     on_line=report, jobs=1, on_done=on_done, log_path=log)
                except (DownloadRefused, OSError) as err:
                    second = {"releases": {r: _failed(r, err) for r in again}, "folders": [], "stray_errors": [],
                              "stopped": None, "stop_error": None}
                run = {**run, "releases": {**run["releases"], **second["releases"]},
                       "folders": run["folders"] + second["folders"],
                       "stray_errors": run["stray_errors"] + second["stray_errors"],
                       "stopped": second["stopped"], "stop_error": second["stop_error"]}
        except (DownloadRefused, OSError) as err:
            run = {"releases": {r["release"]: _failed(r["release"], err) for r in rels}, "folders": [],
                   "stray_errors": [], "stopped": None, "stop_error": None}
        finally:
            todo.put(None)
            worker.join()  # every release handed over is indexed and located before the job ends
        if failures:
            raise failures[0]
        res_by = run["releases"]
        left = [rel["release"] for rel in rels if rel["release"] not in handed]
        unmatched = [r for r in left if res_by[r]["outcome"] == "unmatched"]
        if unmatched:  # the output didn't say which release a folder is: index them all, then look for ours
            for folder in run["folders"]:
                if folder not in indexed_folders:
                    _index_folder(svc, folder)
            why = "; ".join(run["stray_errors"]) or "nothing about it in the downloader's output"
            for release in unmatched:
                located = _locate_refs(svc, entries_of[release])
                ok = bool(located) and all(located.values())
                res_by[release].update(outcome="downloaded" if ok else "failed", ok=ok,
                                       errors=[] if ok else [f"couldn't tell which release failed: {why}"])
        for release in left:
            finish(res_by[release])
    if run["stopped"] in ("challenged", "rate_limited"):
        return MESSAGES[run["stopped"]]
    if run["stopped"] == "not_mounted":
        return run["stop_error"]
    gone = next((r["errors"][-1] for r in res_by.values() if r["outcome"] == "failed" and r["errors"]
                 and "not mounted" in r["errors"][-1]), None)
    return gone  # the drive was gone before the run started

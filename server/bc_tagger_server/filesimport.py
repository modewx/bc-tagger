"""Import from Files (Phase 7): import rows from the audio files added to folders since a date.

``POST /api/import/files {folders: [{path, since}], lookup, default_tags, default_tags_all}`` makes an import
batch (``kind: "files"``) like a JSON import's, with the same review, commit, log and "#" numbering. Its job:

1. quick-scans each folder (files are recorded under the configured root that holds the folder);
2. takes the indexed audio files under it created (birthtime, else mtime) on or after ``since`` (``since`` null or
   "all": every file under it);
3. keeps one file per track when a release folder has it in several formats (``format_preference``);
4. orders rows by folder (as given), then release (oldest first), then disc and track number;
5. makes rows from the files' tags (falling back to the file and folder names), already located to their file.
   A Bandcamp track/album URL in the tags is the row's page (read directly, no search). Files already in the
   collection are duplicates and start unchecked;
6. looks the rows up like any batch (server or browser).

Folders are checked before anything is written: missing, unreadable or on an unplugged drive → an error.

``POST /api/import/<id>/folders {folders: [{path, since}]}`` adds folders to an open batch of any kind (a folder
dragged onto the page, found with ``findfolder``): the same scan and rows, numbered after the batch's rows, without
files the batch already has; only the new rows are looked up (a job, queued after the batch's running one).
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import bandcamp, importer
from .collection import DuplicateIndex, all_items
from .fsguard import NotMounted, is_mounted, require_mounted
from .importer import ImportError_
from .indexer import quick_scan
from .matcher import format_rank
from .normalize import norm_title
from .store import now_iso

RUNS_META = "files_import_runs"  # {folder: when the last files-import of it was created (ISO)}
FIRST_RUN_DAYS = 7
DEFAULT_TAGS = ["pool"]
_DATE = re.compile(r"^\d{4}-\d\d-\d\d$")
EPOCH = datetime.fromtimestamp(0).astimezone()  # the quick scan's cutoff for "every file"
_PAGE = re.compile(r"^https?://[^/\s?#]+\.bandcamp\.com/(track|album)/[^/\s?#]+", re.I)


# -- folders -----------------------------------------------------------------------------------


def parse_since(value: Any) -> datetime | None:
    """``YYYY-MM-DD`` (local midnight) or an ISO date-time (local when it has no offset); null or "all": None,
    every file."""
    if value is None or str(value).strip().lower() == "all":
        return None
    text = str(value).strip()
    try:
        if _DATE.match(text):
            return datetime.fromisoformat(text).astimezone()
        when = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise ImportError_(f"since must be a date (YYYY-MM-DD) or an ISO date-time, not {text!r}") from None
    return when if when.tzinfo else when.astimezone()


def check_folder(path_text: Any, expand: bool = True) -> Path:
    """``expand``: a leading "~" is the home folder (paths from the settings); off for paths found on disk, where
    "~" can be a folder's real name."""
    path = Path(str(path_text or ""))
    path = path.expanduser() if expand else path
    if not path.is_absolute():
        raise ImportError_(f"not a full folder path: {path_text!r}")
    try:
        require_mounted(path)
    except NotMounted as e:
        raise ImportError_(str(e)) from None
    if not path.is_dir():
        raise ImportError_(f"folder not found: {path}")
    if not os.access(path, os.R_OK | os.X_OK):
        raise ImportError_(f"can't read the folder: {path}")
    return Path(os.path.normpath(path))


def check_folders(folders: Any, expand: bool = True) -> list[dict[str, str | None]]:
    """``[{path, since}]``, ``since`` an ISO date-time or None (every file)."""
    if not isinstance(folders, list) or not folders:
        raise ImportError_("add at least one folder")
    out: list[dict[str, str | None]] = []
    for f in folders:
        if not isinstance(f, dict):
            raise ImportError_("each folder needs a path and a since date")
        path = str(check_folder(f.get("path"), expand))
        since = parse_since(f.get("since"))
        if path not in {o["path"] for o in out}:
            out.append({"path": path, "since": since.isoformat(timespec="seconds") if since else None})
    return out


def _folder_row(path: str, kind: str, runs: dict[str, str]) -> dict[str, Any]:
    last = runs.get(path)
    since = datetime.fromisoformat(last) if last else datetime.now().astimezone() - timedelta(days=FIRST_RUN_DAYS)
    mounted = is_mounted(path)
    # "exists" is no longer checked here (it would wake the drive): a missing folder is reported when the
    # import starts
    return {"path": path, "kind": kind, "since": since.astimezone().date().isoformat(), "last_run": last,
            "mounted": mounted, "exists": mounted}


def defaults(svc) -> dict[str, Any]:
    """The two default folders (the owned root, the not-owned "complete" root), each with "since" = the last
    files-import of it (7 days ago the first time). Reads only the settings, the database and the mount
    table: opening the page never touches the music drive."""
    s = svc.settings.all()
    runs = svc.store.get_meta(RUNS_META) or {}
    folders = [_folder_row(s["owned_root"], "owned", runs)] if s.get("owned_root") else []
    not_owned = [r["path"] for r in s.get("not_owned_roots") or []]
    pick = next((p for p in not_owned if Path(p).name == "complete"), not_owned[0] if not_owned else None)
    if pick:
        folders.append(_folder_row(pick, "not_owned", runs))
    return {"folders": folders, "remembered": runs, "default_tags": DEFAULT_TAGS, "lookup": "server",
            "first_run_days": FIRST_RUN_DAYS}


# -- create ------------------------------------------------------------------------------------


def create(svc, folders: Any, default_tags: list[str], default_tags_all: bool = False, lookup: str = "server",
           name: str | None = None) -> dict:
    """Check the folders and make the batch (no rows yet: the job scans); remember this run per folder."""
    if lookup not in ("server", "browser"):
        raise ImportError_("lookup must be 'server' or 'browser'")
    folders = check_folders(folders)
    default_tags = importer._clean_tags(default_tags)
    name = name or "files " + " + ".join(Path(f["path"]).name for f in folders)
    batch = importer.new_batch(svc, name, default_tags, default_tags_all, lookup, kind="files", folders=folders,
                               phase="scanning", scanned=False,
                               estimate={"lookups": None, "text": "scanning the folders first"})
    importer._refresh_stats(svc.store, batch, [])
    runs = svc.store.get_meta(RUNS_META) or {}
    stamp = datetime.now().astimezone().isoformat(timespec="seconds")
    svc.store.set_meta(RUNS_META, {**runs, **{f["path"]: stamp for f in folders}})
    return batch


# -- the job -----------------------------------------------------------------------------------


def _root_for(folder: Path, roots: list[dict]) -> dict[str, Any]:
    """The configured root holding ``folder`` (the longest), else the folder itself as a not-owned root."""
    for r in sorted(roots, key=lambda r: -len(str(Path(r["path"]).expanduser()))):
        rp = Path(os.path.normpath(Path(r["path"]).expanduser()))
        if folder == rp or rp in folder.parents:
            return {"path": str(rp), "kind": r["kind"], "globs": r.get("globs") or []}
    return {"path": str(folder), "kind": "not_owned", "globs": []}


def _created(rec: dict) -> float:
    return rec.get("created") or rec["mtime"]


def select_files(store, folder: Path, since: datetime | None) -> list[dict]:
    """Indexed audio files under ``folder`` created on or after ``since`` (None: all) that are still there."""
    prefix = str(folder).rstrip("/") + "/"
    out = []
    for r in store.query("SELECT * FROM files WHERE substr(path, 1, ?) = ? AND coalesce(nullif(created, 0), mtime) >= ?",
                         (len(prefix), prefix, since.timestamp() if since else float("-inf"))):
        rec = dict(r)
        rel = Path(rec["path"][len(prefix):])
        if any(part.startswith(".") for part in rel.parts) or not os.path.isfile(rec["path"]):
            continue
        rec["bc_urls"] = json.loads(rec["bc_urls"] or "[]")
        rec["parsed"] = json.loads(rec["parsed"] or "{}")
        out.append(rec)
    return out


def _keys(rec: dict) -> list[tuple]:
    pf = rec["parsed"].get("file", {})
    keys: list[tuple] = [(rec["release_dir"], Path(rec["path"]).stem.lower())]
    track, title = rec.get("tracknumber") or pf.get("track"), norm_title(rec.get("title") or pf.get("title") or "")
    if track and title:
        keys.append((rec["release_dir"], rec.get("discnumber") or pf.get("disc") or 1, track, title))
    return keys


def one_per_track(files: list[dict], preference: list[str]) -> list[list[dict]]:
    """Groups of the same track (same release folder and file name, or same disc + track + title), the
    preferred format first."""
    groups: list[list[dict]] = []
    by_key: dict[tuple, int] = {}
    for rec in sorted(files, key=lambda r: r["path"]):
        keys = _keys(rec)
        g = next((by_key[k] for k in keys if k in by_key), None)
        if g is None:
            g = len(groups)
            groups.append([])
        groups[g].append(rec)
        for k in keys:
            by_key.setdefault(k, g)
    return [sorted(g, key=lambda r: (format_rank(r["format"], preference), r["path"])) for g in groups]


def _page_url(group: list[dict]) -> str | None:
    """A Bandcamp track page in the files' tags, else an album page."""
    urls = [u for rec in group for u in rec["bc_urls"] if _PAGE.match(u)]
    return next((u for u in urls if "/track/" in u.lower()), urls[0] if urls else None)


def _located_files(store) -> dict[str, str]:
    """{file path: the collection item it's located for}."""
    out: dict[str, str] = {}
    for r in store.query("SELECT item_id, best FROM locate_results WHERE status = 'located' AND best IS NOT NULL"):
        best = json.loads(r["best"])
        for p in [best.get("path")] + [t.get("path") for t in best.get("tracks") or []]:
            if p:
                out.setdefault(p, r["item_id"])
    return out


def _row_item(group: list[dict], line: int, existing: str | None) -> dict[str, Any]:
    rec = group[0]
    pf, pd = rec["parsed"].get("file", {}), rec["parsed"].get("dir", {})
    return {
        "line": line, "raw": rec["path"], "kind": "track",
        "artist": rec.get("artist") or pf.get("artist") or rec.get("albumartist") or pd.get("artist"),
        "title": rec.get("title") or pf.get("title") or Path(rec["path"]).stem,
        "album": rec.get("album") or pf.get("album") or pd.get("album"),
        "album_artist": rec.get("albumartist"), "track_num": rec.get("tracknumber") or pf.get("track"),
        "year": rec.get("year"), "label": rec.get("label"), "duration": rec.get("duration"),
        "bandcamp_url": _page_url(group), "existing_id": existing,
    }


def _located(group: list[dict], item: dict) -> dict[str, Any]:
    rec = group[0]
    best = {"path": rec["path"], "format": rec["format"], "confidence": 1.0, "method": "file",
            "root_kind": rec["root_kind"], "track_num": item["track_num"], "created": _created(rec),
            "title": item["title"], "artist": item["artist"], "album": item["album"], "scores": {}}
    return {"status": "located", "source": "file", "best": best, "candidates": []}


def build_rows(svc, batch: dict, per_folder: list[list[dict]]) -> list[dict]:
    """Rows in order: folder, release (oldest first), disc, track."""
    return _rows(svc, batch, _ordered(svc, per_folder)[0])


def _ordered(svc, per_folder: list[list[dict]], skip: set[str] = frozenset()) -> tuple[list[tuple[int, list[dict]]], int]:
    """(folder i, the track's files) in row order, without tracks that have a file in ``skip``; and how many
    tracks were left out for that."""
    pref = svc.settings.get("format_preference")
    ordered: list[tuple[int, list[dict]]] = []
    skipped = 0
    for i, files in enumerate(per_folder):
        groups = one_per_track(files, pref)
        kept = [g for g in groups if not any(r["path"] in skip for r in g)]
        skipped += len(groups) - len(kept)
        groups = kept
        release_at: dict[str, float] = {}
        for g in groups:
            for rec in g:
                release_at[rec["release_dir"]] = min(release_at.get(rec["release_dir"], _created(rec)), _created(rec))

        def order(g: list[dict]) -> tuple:
            rec, pf = g[0], g[0]["parsed"].get("file", {})
            return (release_at[rec["release_dir"]], rec["release_dir"], rec.get("discnumber") or pf.get("disc") or 1,
                    rec.get("tracknumber") or pf.get("track") or 9999, rec["path"])

        ordered += [(i, g) for g in sorted(groups, key=order)]
    return ordered, skipped


def _rows(svc, batch: dict, ordered: list[tuple[int, list[dict]]], slots: list[int] | None = None,
          first_line: int = 1, first_n: int = 0) -> list[dict]:
    """The rows of ``ordered``, numbered from ``first_line`` (``n`` from ``first_n``); ``slots``: each folder's
    place in the batch's folders (default: the same)."""
    located = _located_files(svc.store)
    by_url = {}
    for it in all_items(svc.store):
        url = it.get("item_url") or it.get("url")
        if url:
            by_url.setdefault(bandcamp.page_key(url), it["id"])
    items, folders = [], batch["folders"]
    for line, (_, g) in enumerate(ordered, first_line):
        url = _page_url(g)
        existing = next((located[r["path"]] for r in g if r["path"] in located), None) \
            or (by_url.get(bandcamp.page_key(url)) if url else None)
        items.append(_row_item(g, line, existing))
    rows = importer.new_rows(items, batch["default_tags"], batch["default_tags_all"]) if items else []
    dups = DuplicateIndex(svc.store)
    for k, (row, (i, g)) in enumerate(zip(rows, ordered)):
        slot = slots[i] if slots else i
        row.update(n=first_n + k, folder=folders[slot]["path"], folder_index=slot, located=_located(g, row),
                   file={"path": g[0]["path"], "format": g[0]["format"], "root_kind": g[0]["root_kind"],
                         "created": datetime.fromtimestamp(_created(g[0])).astimezone().isoformat(timespec="seconds"),
                         "formats": [{"path": r["path"], "format": r["format"]} for r in g]})
        importer._check_duplicate(dups, row)
    importer._uncheck_duplicates(batch, rows)
    return rows


def _scan(svc, folders: list[dict], progress, seen: set[str]) -> tuple[list[list[dict]], list[dict]]:
    """Quick-scan each folder; its files since its ``since`` (all with None) not in ``seen`` (which gets them)."""
    store = svc.store
    roots = svc.settings.roots()
    margin = timedelta(days=float(svc.settings.get("quick_scan_margin_days")))
    per_folder: list[list[dict]] = []
    scans = []
    for f in folders:
        folder = check_folder(f["path"], expand=False)  # unplugged since the batch was made: stop, nothing written
        since = datetime.fromisoformat(f["since"]) if f.get("since") else None
        progress(f"scanning {folder.name} for files since {since.date().isoformat()}" if since
                 else f"scanning {folder.name} for all its files")
        stats = quick_scan(store, [{**_root_for(folder, roots), "walk": str(folder)}], since - margin if since else EPOCH)
        scans.append({k: stats[k] for k in ("checked", "read", "added")})
        files = [r for r in select_files(store, folder, since) if r["path"] not in seen]
        seen.update(r["path"] for r in files)
        per_folder.append(files)
    return per_folder, scans


def run(svc, batch_id: str, ctx=None) -> dict:
    """The job: scan the folders, make the rows, then look them up like any batch."""
    store = svc.store
    batch = importer.load_batch(store, batch_id)

    def progress(message: str) -> None:
        svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": "scanning", "current": 0, "total": 0,
                                        "message": message})
        if ctx:
            ctx.progress(0, 0, message)

    batch.update(status="resolving", phase="scanning", error=None)
    importer._save_batch(store, batch)
    try:
        seen: set[str] = set()
        per_folder, scans = _scan(svc, batch["folders"], progress, seen)
        rows = build_rows(svc, batch, per_folder)
        batch.update(scanned=True, scan={"folders": scans, "at": now_iso()},
                     files={"found": len(seen), "rows": len(rows)})
        importer._save_rows(store, batch_id, rows)
        importer._refresh_stats(store, batch, rows)
    except Exception as e:
        batch.update(status="error", error=f"{type(e).__name__}: {e}" if not isinstance(e, ImportError_) else str(e))
        importer._save_batch(store, batch)
        svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": "error", "current": 0, "total": 0})
        raise
    progress(f"{len(rows)} tracks from {len(seen)} files")
    return importer.run_batch(svc, batch_id, ctx)


# -- adding folders to an open batch ---------------------------------------------------------------


def _cant_add(batch: dict) -> str | None:
    """Why folders can't be added to the batch, or None."""
    status = batch["status"]
    if status == "committed":
        return "the batch was already imported: start a new import for these folders"
    if status == "committing":
        return "the batch is being imported: wait for it to finish, then start a new import"
    if status == "interrupted":
        return "the server restarted during this batch's lookups: resume it first"
    if status == "error":
        return "the batch stopped with an error: start a new import for these folders"
    return None


def prepare_add(svc, batch_id: str, folders: Any) -> tuple[list[dict], bool]:
    """Check the batch and the folders (paths as found on disk: "~" is never the home folder). Returns the
    folders and whether the batch has a job running (the add then waits for it)."""
    batch = importer.load_batch(svc.store, batch_id)  # KeyError: unknown batch
    live = importer._live(svc, batch)  # a restart may have interrupted it
    why = _cant_add(batch)
    if why:
        raise importer.ImportConflict(why)
    return check_folders(folders, expand=False), live["job"] is not None


def _batch_files(rows: list[dict]) -> set[str]:
    """Files the batch's rows already are (a files row's file, in every format) or are located to."""
    from .views import located_tracks

    out: set[str] = set()
    for row in rows:
        file = row.get("file") or {}
        out.update(f["path"] for f in file.get("formats") or [])
        if file.get("path"):
            out.add(file["path"])
        located = row.get("located") or {}
        if located.get("status") == "located":
            out.update(t["path"] for t in located_tracks(located.get("best")) if t.get("path"))
    return out


def _slot(batch: dict, folder: dict) -> int:
    """The folder's place in the batch's folders (added at the end; a folder it has already keeps the earlier
    ``since`` of the two, None being the earliest)."""
    folders = batch.setdefault("folders", [])
    for i, have in enumerate(folders):
        if have["path"] == folder["path"]:
            if have.get("since") and (not folder["since"] or folder["since"] < have["since"]):
                have["since"] = folder["since"]
            return i
    folders.append(dict(folder))
    return len(folders) - 1


def add_folders(svc, batch_id: str, folders: list[dict], ctx=None) -> dict:
    """The job: scan the folders, append their rows (not the files the batch has), look up only those rows. The
    batch then is as before (ready, or back to its browser lookups); a scan that fails adds nothing."""
    store = svc.store
    batch = importer.load_batch(store, batch_id)
    why = _cant_add(batch)
    if why is None and batch["status"] == "resolving" and batch.get("phase") not in ("browser", "locating"):
        why = "wait for the current step to finish"
    if why:
        raise importer.ImportConflict(why)
    if ctx:
        importer.set_job(svc, batch_id, ctx.job)
        batch = importer.load_batch(store, batch_id)
    before = {"status": batch["status"], "phase": batch.get("phase")}
    browsing = batch.get("phase") == "browser"  # the page's lookups go on meanwhile and pick the new rows up

    def event(phase: str, message: str = "", current: int = 0, total: int = 0) -> None:
        svc.jobs.bus.publish("import", {"batch_id": batch_id, "phase": phase, "current": current, "total": total,
                                        "message": message})

    def progress(message: str) -> None:
        event("adding", message)
        if ctx:
            ctx.progress(0, 0, message)

    if not browsing:
        batch.update(status="resolving", phase="adding", error=None)
        importer._save_batch(store, batch)
    new: list[dict] = []
    try:
        rows = importer.load_rows(store, batch_id)
        seen: set[str] = set()
        per_folder, scans = _scan(svc, folders, progress, seen)
        ordered, already = _ordered(svc, per_folder, _batch_files(rows))
        batch = importer.load_batch(store, batch_id)  # rows may have been edited meanwhile
        slots = [_slot(batch, f) for f in folders]
        first_line = max((r["line"] for r in rows if isinstance(r.get("line"), int)), default=0) + 1
        new = _rows(svc, batch, ordered, slots, first_line, max((r["n"] for r in rows), default=-1) + 1)
        importer._save_rows(store, batch_id, new)
        if batch.get("files"):
            batch["files"] = {"found": batch["files"]["found"] + len(seen), "rows": batch["files"]["rows"] + len(new)}
        batch["added_folders"] = [*(batch.get("added_folders") or []), {
            "at": now_iso(), "folders": [f["path"] for f in folders], "found": len(seen), "rows": len(new),
            "already": already, "scan": scans}]
        importer._save_batch(store, batch)
        runs = store.get_meta(RUNS_META) or {}
        stamp = datetime.now().astimezone().isoformat(timespec="seconds")
        store.set_meta(RUNS_META, {**runs, **{f["path"]: stamp for f in folders}})
        progress(f"{len(new)} tracks from {len(seen)} files" + (f", {already} already in this import" if already else ""))
        if batch.get("lookup") == "browser" and any(importer._needs_browser(r) for r in new):
            if not browsing:
                lookups = batch.get("bandcamp_lookups") or {}
                if lookups.get("state") not in ("stopped", "paused"):  # a bot check or a 429 still holds
                    batch["bandcamp_lookups"] = {"state": "on"}
                batch.update(status="resolving", phase="browser")
                importer._save_batch(store, batch)
                importer.browser_state(svc, batch_id)  # what the cache answers; the page's lookups do the rest
            batch = importer.load_batch(store, batch_id)
        else:
            if batch.get("lookup") != "browser" and new:
                batch["phase"] = "resolving"
                importer._lookup_rows(svc, batch, new, importer._needs_lookup, "resolving", ctx)
                importer._uncheck_duplicates(batch, new)
                importer._save_rows(store, batch_id, new)
            if not browsing:
                batch.update(before)
    except Exception as e:
        batch = importer.load_batch(store, batch_id)
        if not browsing:
            batch.update(before)
        what = str(e) if isinstance(e, ImportError_) else f"{type(e).__name__}: {e}"
        batch["error"] = f"Adding folders stopped: {what}" + ("" if new else " (nothing was added)")
        importer._refresh_stats(store, batch)
        event("error", batch["error"])
        raise
    importer._refresh_stats(store, batch)
    event("done", current=len(new), total=len(new))
    return {"batch_id": batch_id, "added": len(new), "found": len(seen), "already": already,
            "folders": [f["path"] for f in folders], "stats": batch["stats"]}

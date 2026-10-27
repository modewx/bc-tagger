"""Import from Files (Phase 7): import rows from the audio files added to folders since a date.

``POST /api/import/files {folders: [{path, since}], lookup, default_tags, default_tags_all}`` makes an import
batch (``kind: "files"``) like a JSON import's, with the same review, commit, log and "#" numbering. Its job:

1. quick-scans each folder (files are recorded under the configured root that holds the folder);
2. takes the indexed audio files under it created (birthtime, else mtime) on or after ``since``;
3. keeps one file per track when a release folder has it in several formats (``format_preference``);
4. orders rows by folder (as given), then release (oldest first), then disc and track number;
5. makes rows from the files' tags (falling back to the file and folder names), already located to their file.
   A Bandcamp track/album URL in the tags is the row's page (read directly, no search). Files already in the
   collection are duplicates and start unchecked;
6. looks the rows up like any batch (server or browser).

Folders are checked before anything is written: missing, unreadable or on an unplugged drive → an error.
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
_PAGE = re.compile(r"^https?://[^/\s?#]+\.bandcamp\.com/(track|album)/[^/\s?#]+", re.I)


# -- folders -----------------------------------------------------------------------------------


def parse_since(value: Any) -> datetime:
    """``YYYY-MM-DD`` (local midnight) or an ISO date-time (local when it has no offset)."""
    text = str(value or "").strip()
    try:
        if _DATE.match(text):
            return datetime.fromisoformat(text).astimezone()
        when = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise ImportError_(f"since must be a date (YYYY-MM-DD) or an ISO date-time, not {text!r}") from None
    return when if when.tzinfo else when.astimezone()


def check_folder(path_text: Any) -> Path:
    path = Path(str(path_text or "")).expanduser()
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


def check_folders(folders: Any) -> list[dict[str, str]]:
    if not isinstance(folders, list) or not folders:
        raise ImportError_("add at least one folder")
    out: list[dict[str, str]] = []
    for f in folders:
        if not isinstance(f, dict):
            raise ImportError_("each folder needs a path and a since date")
        path = str(check_folder(f.get("path")))
        if path not in {o["path"] for o in out}:
            out.append({"path": path, "since": parse_since(f.get("since")).isoformat(timespec="seconds")})
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


def select_files(store, folder: Path, since: datetime) -> list[dict]:
    """Indexed audio files under ``folder`` created on or after ``since`` that are still there."""
    prefix = str(folder).rstrip("/") + "/"
    out = []
    for r in store.query("SELECT * FROM files WHERE substr(path, 1, ?) = ? AND coalesce(nullif(created, 0), mtime) >= ?",
                         (len(prefix), prefix, since.timestamp())):
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
    pref = svc.settings.get("format_preference")
    located = _located_files(svc.store)
    by_url = {}
    for it in all_items(svc.store):
        url = it.get("item_url") or it.get("url")
        if url:
            by_url.setdefault(bandcamp.page_key(url), it["id"])
    ordered: list[tuple[int, list[dict]]] = []
    for i, files in enumerate(per_folder):
        groups = one_per_track(files, pref)
        release_at: dict[str, float] = {}
        for g in groups:
            for rec in g:
                release_at[rec["release_dir"]] = min(release_at.get(rec["release_dir"], _created(rec)), _created(rec))

        def order(g: list[dict]) -> tuple:
            rec, pf = g[0], g[0]["parsed"].get("file", {})
            return (release_at[rec["release_dir"]], rec["release_dir"], rec.get("discnumber") or pf.get("disc") or 1,
                    rec.get("tracknumber") or pf.get("track") or 9999, rec["path"])

        ordered += [(i, g) for g in sorted(groups, key=order)]
    items, folders = [], batch["folders"]
    for line, (_, g) in enumerate(ordered, 1):
        url = _page_url(g)
        existing = next((located[r["path"]] for r in g if r["path"] in located), None) \
            or (by_url.get(bandcamp.page_key(url)) if url else None)
        items.append(_row_item(g, line, existing))
    rows = importer.new_rows(items, batch["default_tags"], batch["default_tags_all"]) if items else []
    dups = DuplicateIndex(svc.store)
    for row, (i, g) in zip(rows, ordered):
        row.update(folder=folders[i]["path"], folder_index=i, located=_located(g, row),
                   file={"path": g[0]["path"], "format": g[0]["format"], "root_kind": g[0]["root_kind"],
                         "created": datetime.fromtimestamp(_created(g[0])).astimezone().isoformat(timespec="seconds"),
                         "formats": [{"path": r["path"], "format": r["format"]} for r in g]})
        importer._check_duplicate(dups, row)
    importer._uncheck_duplicates(batch, rows)
    return rows


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
        roots = svc.settings.roots()
        margin = timedelta(days=float(svc.settings.get("quick_scan_margin_days")))
        per_folder: list[list[dict]] = []
        seen: set[str] = set()
        scans = []
        for f in batch["folders"]:
            folder = check_folder(f["path"])  # unplugged since the batch was made: stop, nothing written
            since = datetime.fromisoformat(f["since"])
            progress(f"scanning {folder.name} for files since {since.date().isoformat()}")
            stats = quick_scan(store, [{**_root_for(folder, roots), "walk": str(folder)}], since - margin)
            scans.append({k: stats[k] for k in ("checked", "read", "added")})
            files = [r for r in select_files(store, folder, since) if r["path"] not in seen]
            seen.update(r["path"] for r in files)
            per_folder.append(files)
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

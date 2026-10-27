"""Scan configured roots for audio files and cache their tags in SQLite.

* Full scan (``scan``, manual only): walks every root. Incremental: a file is re-read only
  when its size or mtime changed, rows for deleted files are dropped (never for a root that
  is missing or went away mid-walk), and per-root completeness is recorded.
* Quick scan (``quick_scan``, before every Locate/Export): only audio files created or
  modified since a cutoff date, found with Spotlight (``mdfind``) plus a shallow walk into
  recently modified folders; never deletes rows.

Roots are only read, never written.
"""

from __future__ import annotations

import fnmatch
import json
import logging
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .aiff import AIFF_EXTS, aiff_layout
from .normalize import is_disc_dir, parse_filename, parse_release_dir
from .store import Store, now_iso
from .tagread import AUDIO_EXTS, read_tags

log = logging.getLogger(__name__)

BATCH = 200

FILE_COLUMNS = (
    "path", "root", "root_kind", "size", "mtime", "ext", "format", "title", "artist",
    "albumartist", "album", "tracknumber", "discnumber", "comment", "bc_urls", "duration",
    "bitrate", "sample_rate", "bits", "codec", "year", "genre", "label", "release_dir",
    "created", "parsed", "scanned_at", "error", "channels", "aiff_layout",
)


def release_dir_of(path: Path) -> Path:
    parent = path.parent
    return parent.parent if is_disc_dir(parent.name) else parent


def file_record(path: Path, root: str, root_kind: str, st: os.stat_result) -> dict[str, Any]:
    rel = release_dir_of(path)
    parsed = {
        "file": parse_filename(path.stem),
        "dir": parse_release_dir(rel.name, rel.parent.name),
    }
    rec: dict[str, Any] = {
        "path": str(path),
        "root": root,
        "root_kind": root_kind,
        "size": st.st_size,
        "mtime": st.st_mtime,
        "ext": path.suffix.lower(),
        "release_dir": str(rel),
        "created": _created(st),
        "parsed": json.dumps(parsed),
        "scanned_at": now_iso(),
        "error": None,
    }
    try:
        tags = read_tags(path)
    except Exception as e:  # noqa: BLE001 - keep the file, flag the error
        tags = {"format": "other", "urls": []}
        rec["error"] = f"{type(e).__name__}: {e}"
    rec.update(
        format=tags.get("format") or "other",
        title=tags.get("title"),
        artist=tags.get("artist"),
        albumartist=tags.get("albumartist"),
        album=tags.get("album"),
        tracknumber=tags.get("tracknumber"),
        discnumber=tags.get("discnumber"),
        comment=tags.get("comment"),
        bc_urls=json.dumps(tags.get("urls") or []),
        duration=tags.get("duration"),
        bitrate=tags.get("bitrate"),
        sample_rate=tags.get("sample_rate"),
        bits=tags.get("bits"),
        codec=tags.get("codec"),
        year=tags.get("year"),
        genre=tags.get("genre"),
        label=tags.get("label"),
        channels=tags.get("channels"),
        aiff_layout=None,
    )
    if rec["ext"] in AIFF_EXTS:  # a few small reads of the chunk headers, so playback needs none
        layout = aiff_layout(path, st.st_size)
        if layout:
            rec.update(aiff_layout=json.dumps(layout), channels=layout["channels"])
    return rec


def _created(st: os.stat_result) -> float:
    return float(getattr(st, "st_birthtime", 0) or st.st_ctime)


def _wanted(rel: str, globs: list[str]) -> bool:
    return not globs or any(fnmatch.fnmatch(rel, g) or fnmatch.fnmatch(os.path.basename(rel), g) for g in globs)


def _flush(store: Store, batch: list[dict]) -> None:
    if not batch:
        return
    cols = ", ".join(FILE_COLUMNS)
    marks = ", ".join("?" * len(FILE_COLUMNS))
    updates = ", ".join(f"{c} = excluded.{c}" for c in FILE_COLUMNS if c != "path")
    with store.tx() as c:
        c.executemany(
            f"INSERT INTO files({cols}) VALUES({marks}) ON CONFLICT(path) DO UPDATE SET {updates}",
            [tuple(r[k] for k in FILE_COLUMNS) for r in batch],
        )
    batch.clear()


def scan(
    store: Store,
    roots: list[dict],
    progress: Callable[[int, int, str], None] | None = None,
) -> dict[str, Any]:
    """Scan ``roots`` (``[{path, globs, kind}]``) and return counts."""
    stats = {"roots": [], "files": 0, "read": 0, "unchanged": 0, "removed": 0, "errors": 0, "incomplete_roots": []}
    for root in roots:
        root_path = Path(root["path"]).expanduser()
        root_key = str(root_path)
        rstats = {"path": root_key, "kind": root["kind"], "exists": root_path.is_dir(), "files": 0}
        stats["roots"].append(rstats)
        if not root_path.is_dir():
            log.warning("Scan root missing: %s", root_path)
            continue
        known = {
            r["path"]: (r["size"], r["mtime"])
            for r in store.query("SELECT path, size, mtime FROM files WHERE root = ?", (root_key,))
        }
        no_created = {
            r["path"] for r in store.query("SELECT path FROM files WHERE root = ? AND created IS NULL", (root_key,))
        }
        created_updates: list[tuple[float, str]] = []
        seen: set[str] = set()
        batch: list[dict] = []
        walk_errors: list[str] = []
        for dirpath, dirnames, filenames in os.walk(root_path, onerror=lambda e: walk_errors.append(str(e))):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            for fn in sorted(filenames):
                if fn.startswith("."):
                    continue
                path = Path(dirpath) / fn
                if path.suffix.lower() not in AUDIO_EXTS:
                    continue
                rel = str(path.relative_to(root_path))
                if not _wanted(rel, root.get("globs") or []):
                    continue
                try:
                    st = path.stat()
                except OSError:
                    continue
                key = str(path)
                seen.add(key)
                stats["files"] += 1
                rstats["files"] += 1
                if known.get(key) == (st.st_size, st.st_mtime):
                    stats["unchanged"] += 1
                    if key in no_created:  # rows indexed before creation times were recorded
                        created_updates.append((_created(st), key))
                    continue
                rec = file_record(path, root_key, root["kind"], st)
                stats["read"] += 1
                if rec["error"]:
                    stats["errors"] += 1
                batch.append(rec)
                if len(batch) >= BATCH:
                    _flush(store, batch)
                if progress and stats["files"] % 25 == 0:
                    progress(stats["files"], 0, f"scanning {root_key}")
        _flush(store, batch)
        if created_updates:
            with store.tx() as c:
                c.executemany("UPDATE files SET created = ? WHERE path = ?", created_updates)
        if walk_errors or not root_path.is_dir():
            # A drive that went away mid-walk (or unreadable folders) must not look like
            # deleted files: keep every row we didn't see.
            log.warning("Scan of %s incomplete (%d errors); keeping unseen files", root_path, len(walk_errors))
            rstats["incomplete"] = True
            rstats["walk_errors"] = walk_errors[:5]
            stats["incomplete_roots"].append(root_key)
            continue
        gone = [p for p in known if p not in seen]
        if gone:
            with store.tx() as c:
                c.executemany("DELETE FROM files WHERE path = ?", [(p,) for p in gone])
            stats["removed"] += len(gone)
    # Drop rows of roots that are no longer configured (a configured root that is merely
    # missing, e.g. an unmounted drive, keeps its rows).
    keep = [str(Path(r["path"]).expanduser()) for r in roots]
    marks = ",".join("?" * len(keep)) or "''"
    with store.tx() as c:
        stats["removed"] += c.execute(f"DELETE FROM files WHERE root NOT IN ({marks})", keep).rowcount
    at = now_iso()
    store.set_meta("last_scan", {
        "at": at,
        **{k: v for k, v in stats.items() if k != "roots"},
        "roots": [r["path"] for r in roots],
    })
    store.set_meta("last_full_scan", {
        "at": at,
        "files": stats["files"],
        "incomplete_roots": stats["incomplete_roots"] + [r["path"] for r in stats["roots"] if not r["exists"]],
        "roots": [
            {"path": r["path"], "kind": r["kind"], "mounted": r["exists"], "files": r["files"],
             "complete": bool(r["exists"] and not r.get("incomplete"))}
            for r in stats["roots"]
        ],
    })
    if progress:
        progress(stats["files"], stats["files"], "scan finished")
    return stats


# -- quick scan ------------------------------------------------------------------------------


def _mount_point(path: Path) -> Path:
    p = path.resolve()
    while not os.path.ismount(p) and p != p.parent:
        p = p.parent
    return p


def spotlight_enabled(root: Path) -> bool:
    """``mdutil -s`` says "Indexing enabled." for the volume holding ``root``."""
    try:
        out = subprocess.run(["mdutil", "-s", str(_mount_point(root))], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return out.returncode == 0 and "Indexing enabled" in out.stdout


def spotlight_recent(root: Path, cutoff: datetime) -> list[str] | None:
    """Files under ``root`` created or changed since ``cutoff`` per Spotlight (None: unavailable)."""
    if not spotlight_enabled(root):
        return None
    t = cutoff.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    query = f"(kMDItemFSCreationDate >= $time.iso({t}) || kMDItemFSContentChangeDate >= $time.iso({t}))"
    try:
        out = subprocess.run(["mdfind", "-onlyin", str(root), query], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return [line for line in out.stdout.splitlines() if line.strip()]


def walk_recent(root: Path, cutoff_ts: float) -> list[str]:
    """Shallow fallback: descend only into folders modified since the cutoff.

    A folder's mtime changes when entries are added to it directly, so new release folders
    (and their parents) are found. Limitation: a file added deep inside folders whose own
    entries otherwise didn't change is missed when its parent's parent wasn't touched;
    the manual full scan finds it.
    """
    found: list[str] = []
    stack = [root]
    while stack:
        d = stack.pop()
        try:
            entries = list(os.scandir(d))
        except OSError:
            continue
        for e in entries:
            if e.name.startswith("."):
                continue
            try:
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            if e.is_dir(follow_symlinks=False):
                if st.st_mtime >= cutoff_ts:
                    stack.append(Path(e.path))
            elif max(st.st_mtime, _created(st)) >= cutoff_ts:
                found.append(e.path)
    return found


def quick_scan(
    store: Store,
    roots: list[dict],
    cutoff: datetime,
    progress: Callable[[int, int, str], None] | None = None,
) -> dict[str, Any]:
    """Index audio files created or modified since ``cutoff`` in the mounted roots. A root's ``walk``
    (a folder inside it) limits the walk to that folder; files are still recorded under the root."""
    cutoff_ts = cutoff.timestamp()
    stats: dict[str, Any] = {
        "mode": "quick", "cutoff": cutoff.astimezone(timezone.utc).isoformat(timespec="seconds"),
        "checked": 0, "read": 0, "added": 0, "unchanged": 0, "errors": 0, "roots": [],
    }
    for root in roots:
        root_path = Path(root["path"]).expanduser()
        walk_path = Path(root.get("walk") or root_path).expanduser()
        root_key = str(root_path)
        rstats: dict[str, Any] = {"path": str(walk_path), "kind": root["kind"], "mounted": walk_path.is_dir()}
        stats["roots"].append(rstats)
        if not rstats["mounted"]:
            rstats["method"] = "skipped (not mounted)"
            continue
        spot = spotlight_recent(walk_path, cutoff)
        paths = set(walk_recent(walk_path, cutoff_ts))
        rstats["method"] = "walk" if spot is None else "spotlight+walk"
        if spot is not None:
            paths |= set(spot)
        candidates = []
        for p in paths:
            path = Path(p)
            if path.suffix.lower() not in AUDIO_EXTS or path.name.startswith("."):
                continue
            try:
                rel = str(path.relative_to(root_path))
            except ValueError:
                continue
            if any(part.startswith(".") for part in Path(rel).parts) or not _wanted(rel, root.get("globs") or []):
                continue
            candidates.append(path)
        known = {}
        for chunk in range(0, len(candidates), 500):
            part = [str(c) for c in candidates[chunk:chunk + 500]]
            marks = ",".join("?" * len(part))
            for r in store.query(f"SELECT path, size, mtime FROM files WHERE path IN ({marks})", part):
                known[r["path"]] = (r["size"], r["mtime"])
        batch: list[dict] = []
        rstats.update(checked=len(candidates), read=0, added=0)
        for path in sorted(candidates):
            try:
                st = path.stat()
            except OSError:
                continue
            key = str(path)
            if known.get(key) == (st.st_size, st.st_mtime):
                stats["unchanged"] += 1
                continue
            rec = file_record(path, root_key, root["kind"], st)
            rstats["read"] += 1
            if key not in known:
                rstats["added"] += 1
            if rec["error"]:
                stats["errors"] += 1
            batch.append(rec)
            if len(batch) >= BATCH:
                _flush(store, batch)
        _flush(store, batch)
        for k in ("checked", "read", "added"):
            stats[k] += rstats[k]
        if progress:
            progress(stats["checked"], 0, f"quick scan {root_key}")
    stats["at"] = now_iso()
    store.set_meta("last_quick_scan", stats)
    return stats


def index_file(store: Store, path: str | Path, roots: list[dict[str, Any]]) -> dict[str, Any]:
    """Index one audio file the user picked by hand (re-read if it changed). It belongs to the
    configured root that contains it, else to its own folder as a not-owned root."""
    path = Path(path).expanduser()
    if path.suffix.lower() not in AUDIO_EXTS:
        raise ValueError(f"not an audio file: {path.name}")
    st = path.stat()  # FileNotFoundError if it isn't there
    root_key, kind = str(path.parent), "not_owned"
    for r in sorted(roots, key=lambda r: -len(str(Path(r["path"]).expanduser()))):
        rp = Path(r["path"]).expanduser()
        if rp in path.parents:
            root_key, kind = str(rp), r["kind"]
            break
    known = store.query_one("SELECT size, mtime FROM files WHERE path = ?", (str(path),))
    if known is None or (known["size"], known["mtime"]) != (st.st_size, st.st_mtime):
        _flush(store, [file_record(path, root_key, kind, st)])
    return {"path": str(path), "added": known is None}


def search_files(store: Store, q: str, limit: int = 20) -> list[dict[str, Any]]:
    """Files whose artist/title/album/path contain every word of ``q`` (case-insensitive), newest first."""
    words = [w for w in q.lower().split() if w][:8]
    if not words:
        return []
    hay = "lower(coalesce(artist,'') || ' ' || coalesce(albumartist,'') || ' ' || coalesce(title,'') || ' ' " \
          "|| coalesce(album,'') || ' ' || path)"
    where = " AND ".join(f"{hay} LIKE ?" for _ in words)
    rows = store.query(
        f"SELECT path, title, artist, album, tracknumber, format, root_kind, duration, mtime FROM files "
        f"WHERE {where} ORDER BY mtime DESC LIMIT ?",
        [f"%{w}%" for w in words] + [max(1, min(int(limit), 200))],
    )
    return [dict(r) for r in rows]


def load_files(store: Store) -> list[dict]:
    rows = store.query("SELECT * FROM files")
    out = []
    for r in rows:
        d = dict(r)
        d["bc_urls"] = json.loads(d["bc_urls"] or "[]")
        d["parsed"] = json.loads(d["parsed"] or "{}")
        out.append(d)
    return out

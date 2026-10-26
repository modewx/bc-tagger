"""Scan configured roots for audio files and cache their tags in SQLite.

Rescans are incremental: a file is re-read only when its size or mtime changed, and rows
for files that disappeared are dropped. Roots are only read, never written.
"""

from __future__ import annotations

import fnmatch
import json
import logging
import os
from pathlib import Path
from typing import Any, Callable

from .normalize import is_disc_dir, parse_filename, parse_release_dir
from .store import Store, now_iso
from .tagread import AUDIO_EXTS, read_tags

log = logging.getLogger(__name__)

BATCH = 200

FILE_COLUMNS = (
    "path", "root", "root_kind", "size", "mtime", "ext", "format", "title", "artist",
    "albumartist", "album", "tracknumber", "discnumber", "comment", "bc_urls", "duration",
    "bitrate", "sample_rate", "bits", "codec", "year", "genre", "label", "release_dir",
    "parsed", "scanned_at", "error",
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
    )
    return rec


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
    store.set_meta("last_scan", {
        "at": now_iso(),
        **{k: v for k, v in stats.items() if k != "roots"},
        "roots": [r["path"] for r in roots],
    })
    if progress:
        progress(stats["files"], stats["files"], "scan finished")
    return stats


def load_files(store: Store) -> list[dict]:
    rows = store.query("SELECT * FROM files")
    out = []
    for r in rows:
        d = dict(r)
        d["bc_urls"] = json.loads(d["bc_urls"] or "[]")
        d["parsed"] = json.loads(d["parsed"] or "{}")
        out.append(d)
    return out

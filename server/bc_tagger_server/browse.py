"""Browsing folders to pick a file by hand: only the configured roots and what's under them."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .store import Store
from .tagread import AUDIO_EXTS


class OutsideRoots(PermissionError):
    pass


def _real(path: str | Path) -> Path:
    return Path(os.path.realpath(Path(path).expanduser()))


def _mounted_roots(roots: list[dict[str, Any]]) -> list[Path]:
    out: list[Path] = []
    for r in roots:
        p = _real(r["path"])
        if p.is_dir() and p not in out:
            out.append(p)
    return out


def _within(path: Path, roots: list[Path]) -> bool:
    return any(path == r or path.is_relative_to(r) for r in roots)


def inside_roots(roots_cfg: list[dict[str, Any]], path: str | Path) -> bool:
    """Whether ``path`` (symlinks and ``..`` resolved) is under a mounted root, as the browser offers it."""
    return _within(_real(path), _mounted_roots(roots_cfg))


def list_dir(store: Store, roots_cfg: list[dict[str, Any]], path: str | None = None) -> dict[str, Any]:
    """``{path, parent, dirs: [{name, path}], files: [{name, path, ext, size, mtime, indexed, title?, artist?,
    album?, format?}]}``.
    Without ``path``: the mounted roots. Symlinks and ``..`` are resolved first; anything outside the
    roots raises ``OutsideRoots``."""
    roots = _mounted_roots(roots_cfg)
    if not path:
        return {"path": None, "parent": None, "files": [],
                "dirs": [{"name": str(r), "path": str(r)} for r in roots]}
    here = _real(path)
    if not _within(here, roots):
        raise OutsideRoots(f"{path} is outside the configured roots")
    if not here.is_dir():
        raise FileNotFoundError(f"no such folder: {path}")
    dirs, files = [], []
    for entry in sorted(here.iterdir(), key=lambda p: p.name.casefold()):
        if entry.name.startswith("."):
            continue
        try:
            if entry.is_dir():
                if _within(_real(entry), roots):  # a symlink pointing out of the roots isn't offered
                    dirs.append({"name": entry.name, "path": str(entry)})
            elif entry.suffix.lower() in AUDIO_EXTS and _within(_real(entry), roots):
                st = entry.stat()
                files.append({"name": entry.name, "path": str(entry), "ext": entry.suffix.lower(),
                              "size": st.st_size, "mtime": st.st_mtime, "indexed": False})
        except OSError:
            continue
    if files:
        marks = ",".join("?" * len(files))
        known = {r["path"]: r for r in store.query(
            f"SELECT path, title, artist, album, format FROM files WHERE path IN ({marks})", [f["path"] for f in files])}
        for f in files:
            if f["path"] in known:
                k = known[f["path"]]
                f.update(indexed=True, title=k["title"], artist=k["artist"], album=k["album"], format=k["format"])
    parent = here.parent if here not in roots and _within(here.parent, roots) else None
    return {"path": str(here), "parent": str(parent) if parent else None, "dirs": dirs, "files": files}

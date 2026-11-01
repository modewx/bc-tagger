"""Finding a folder dropped on the page (dragged from Finder). The browser never gives a dropped folder's path,
only its name and its files' paths relative to it, with their sizes; the server looks for the folders of that
name that hold those files. Read only, within about 2 s, run only on a drop:

1. the index: folders whose indexed files end in ``/<name>/<rel>`` (instant);
2. Spotlight: folders of that name (``mdfind``, a short timeout; skipped when it fails);
3. when neither found it (or Spotlight failed): a walk, breadth first and at most 4 folders deep, from where
   music is likely to be: the batch's folders and their parents, the last folder browsed, the folders of earlier
   files imports and their parents, the configured roots, ~/Music, ~/Downloads, ~/Desktop, ~/Documents and the
   home folder's other folders.

A folder matches only if it has that name and every sampled file, with the same size; every match is returned
(two copies: the page asks which). Hidden folders and ~/Library are never looked in. A "~" in a path found on
disk is a folder's name, never the home folder (only paths from the settings are expanded).
"""

from __future__ import annotations

import os
import stat
import subprocess
import time
import unicodedata
from pathlib import Path
from typing import Any, Callable, Iterator

from .fsguard import is_mounted
from .tagread import AUDIO_EXTS

BUDGET_S = 2.0
SPOTLIGHT_S = 1.0
WALK_DEPTH = 4
COUNT_S = 0.25  # counting one match's audio files
HOME_FOLDERS = ("Music", "Downloads", "Desktop", "Documents")
SKIP_NAMES = {"node_modules", "__pycache__"}
SKIP_SUFFIXES = (".app", ".bundle", ".framework", ".photoslibrary", ".musiclibrary", ".tvlibrary", ".imovielibrary",
                 ".fcpbundle", ".logicx", ".xcodeproj")
SOURCES = ("index", "spotlight", "walk")


class BadSample(ValueError):
    pass


def _nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def _clean(name: Any, files: list[tuple[Any, Any]]) -> tuple[str, list[tuple[str, int]]]:
    name = str(name or "")
    if not name or "/" in name or "\0" in name or name in (".", ".."):
        raise BadSample(f"not a folder name: {name!r}")
    out: list[tuple[str, int]] = []
    for rel, size in files:
        rel = str(rel)
        if rel.startswith("/") or "\0" in rel or any(p in ("", ".", "..") for p in rel.split("/")):
            raise BadSample(f"not a path inside the folder: {rel!r}")
        out.append((rel, int(size)))
    if not out:
        raise BadSample("the dropped folder has no files to recognise it by")
    return name, out


def _excluder(home: Path) -> Callable[[str], bool]:
    library = home / "Library"

    def excluded(path: str) -> bool:
        p = Path(path)
        return any(part.startswith(".") for part in p.parts[1:]) or p == library or library in p.parents

    return excluded


def _verify(folder: str, name: str, files: list[tuple[str, int]]) -> bool:
    if _nfc(os.path.basename(folder)) != _nfc(name):
        return False
    for rel, size in files:
        try:
            st = os.stat(os.path.join(folder, rel))
        except OSError:
            return False
        if not stat.S_ISREG(st.st_mode) or st.st_size != size:
            return False
    return True


def _from_index(store, name: str, files: list[tuple[str, int]]) -> list[str]:
    """Folders named ``name`` with indexed files among the sample, none of them another size."""
    sizes = {_nfc(rel): size for rel, size in files}
    needles = list(dict.fromkeys("/" + unicodedata.normalize(form, name) + "/" for form in ("NFC", "NFD")))
    where = " OR ".join("instr(path, ?) > 0" for _ in needles)
    agree: dict[str, bool] = {}
    for r in store.query(f"SELECT path, size FROM files WHERE {where}", needles):
        path = r["path"]
        for needle in needles:
            i = path.find(needle)
            while i >= 0:
                rel = _nfc(path[i + len(needle):])
                if rel in sizes:
                    folder = path[:i + len(needle) - 1]
                    agree[folder] = agree.get(folder, True) and r["size"] == sizes[rel]
                i = path.find(needle, i + 1)
    return [folder for folder, ok in agree.items() if ok]


def spotlight(name: str, timeout: float) -> list[str] | None:
    """Folders named ``name`` per Spotlight; None when it failed or took too long."""
    if any(c in name for c in '"\\*'):  # not safe inside a query: any file name containing it, exact names kept
        cmd = ["mdfind", "-name", name]
    else:
        cmd = ["mdfind", f'kMDItemFSName == "{name}" && kMDItemContentType == "public.folder"']
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    want = _nfc(name)
    return [p for p in out.stdout.splitlines() if p and _nfc(os.path.basename(p)) == want]


def _starts(svc, batch_id: str | None, home: Path) -> list[str]:
    from . import filesimport, importer

    out: list[str] = []

    def add(path: Any, parent: bool = False) -> None:
        if path:
            out.append(os.path.normpath(str(path)))
            if parent:
                out.append(os.path.dirname(os.path.normpath(str(path))))

    batch: dict = {}
    if batch_id:
        try:
            batch = importer.load_batch(svc.store, batch_id)
        except KeyError:
            pass
    for f in batch.get("folders") or []:
        add(f["path"], parent=True)
    browsed = svc.settings.get("last_browse_dir")
    add(Path(browsed).expanduser() if browsed else None)  # from the settings: "~" is the home folder
    for path in svc.store.get_meta(filesimport.RUNS_META) or {}:
        add(path, parent=True)
    for r in svc.settings.roots():
        add(Path(r["path"]).expanduser())
    for name in HOME_FOLDERS:
        add(home / name)
    try:
        add_home = sorted(e.path for e in os.scandir(home) if e.is_dir(follow_symlinks=False))
    except OSError:
        add_home = []
    for path in add_home:
        add(path)
    return list(dict.fromkeys(out))


def _walk(starts: list[str], name: str, deadline: float, excluded: Callable[[str], bool]) -> Iterator[str]:
    """Folders named ``name`` at most ``WALK_DEPTH`` below the starts, shallowest first, until ``deadline``."""
    want = _nfc(name)
    seen: set[str] = set()
    level: list[str] = []
    for path in starts:
        if path not in seen and not excluded(path):
            seen.add(path)
            level.append(path)
            if _nfc(os.path.basename(path)) == want:
                yield path
    for _ in range(WALK_DEPTH):
        below: list[str] = []
        for folder in level:
            if time.monotonic() > deadline:
                return
            try:
                with os.scandir(folder) as it:
                    entries = list(it)
            except OSError:
                continue
            for e in entries:
                if e.name.startswith(".") or e.name in SKIP_NAMES or e.name.endswith(SKIP_SUFFIXES):
                    continue
                try:
                    if not e.is_dir(follow_symlinks=False):
                        continue
                except OSError:
                    continue
                if e.path in seen or excluded(e.path):
                    continue
                seen.add(e.path)
                if _nfc(e.name) == want:
                    yield e.path
                below.append(e.path)
        level = below


def _count_audio(folder: str, until: float) -> int | None:
    """Audio files under ``folder`` (hidden ones left out); None if counting takes too long."""
    n = 0
    stack = [folder]
    while stack:
        if time.monotonic() > until:
            return None
        try:
            with os.scandir(stack.pop()) as it:
                entries = list(it)
        except OSError:
            continue
        for e in entries:
            if e.name.startswith("."):
                continue
            try:
                if e.is_dir(follow_symlinks=False):
                    stack.append(e.path)
                elif os.path.splitext(e.name)[1].lower() in AUDIO_EXTS:
                    n += 1
            except OSError:
                continue
    return n


def find(svc, name: Any, files: list[tuple[Any, Any]], count: int | None = None, batch_id: str | None = None,
         budget: float = BUDGET_S) -> dict[str, Any]:
    """``{matches: [{path, source, audio_files}], ms, sources, timed_out}``: the folders named ``name`` holding every
    ``(rel, size)`` of ``files``; those with ``count`` audio files first. ``audio_files`` is None when counting
    took too long; ``sources``: what was searched; ``timed_out``: the walk ran out of time."""
    t0 = time.monotonic()
    deadline = t0 + budget
    name, files = _clean(name, files)
    home = Path.home()
    excluded = _excluder(home)
    found: dict[str, dict[str, Any]] = {}
    rejected: set[str] = set()

    def consider(folder: str, source: str) -> None:
        folder = os.path.normpath(folder)
        if folder in found or folder in rejected:
            return
        if excluded(folder) or not _verify(folder, name, files):
            rejected.add(folder)
        else:
            found[folder] = {"path": folder, "source": source}

    sources = ["index"]
    for folder in _from_index(svc.store, name, files):
        if is_mounted(folder):  # the index may know a drive that isn't plugged in
            consider(folder, "index")
    spot = spotlight(name, max(0.1, min(SPOTLIGHT_S, deadline - time.monotonic())))
    if spot is not None:
        sources.append("spotlight")
    for folder in spot or []:
        consider(folder, "spotlight")
    timed_out = False
    if not found or spot is None:
        sources.append("walk")
        for folder in _walk(_starts(svc, batch_id, home), name, deadline, excluded):
            consider(folder, "walk")
        timed_out = time.monotonic() > deadline
    matches = list(found.values())
    for m in matches:
        m["audio_files"] = _count_audio(m["path"], time.monotonic() + COUNT_S)
    matches.sort(key=lambda m: (count is not None and m["audio_files"] != count, SOURCES.index(m["source"]), m["path"]))
    return {"matches": matches, "ms": round((time.monotonic() - t0) * 1000), "sources": sources,
            "timed_out": timed_out}

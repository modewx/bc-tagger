"""Opt-in file watcher (setting ``watch_roots``, default off; design: ``docs/fsevents-watcher.md``).

While the server runs, file events from the roots update the index within seconds, so the quick scan
before Locate/Export finds nothing left to do. Full scans stay manual and remain the ground truth.

* A ``WatchSource`` delivers events; ``WatchdogSource`` uses the ``watchdog`` package (live events only,
  no history replay) when it's installed, else the watcher reports itself unavailable. Tests feed a fake
  source.
* Events are collected per path and applied once the path has been quiet for ``watch_debounce_seconds``
  and its size is stable across two stats (downloads write in chunks). Many events under one folder
  become one subtree walk.
* Created/modified files are (re)indexed like the scans do; a file is removed from the index only when
  its volume is mounted and it's really gone (an unplugged drive never empties the index).
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol

from .fsguard import volume_root
from .store import Store, now_iso
from .tagread import AUDIO_EXTS

BURST = 500  # pending paths under one folder before it becomes a subtree walk
_IGNORED_SUFFIXES = (".part", ".tmp", ".download", ".crdownload")


@dataclass
class WatchEvent:
    path: str
    kind: str  # "created" | "modified" | "removed" | "moved" | "rescan"
    is_dir: bool = False
    dest: str | None = None  # for "moved"


class WatchSource(Protocol):
    name: str

    def start(self, roots: list[str], emit: Callable[[WatchEvent], None]) -> None: ...

    def stop(self) -> None: ...


class WatchdogSource:
    """Live events through ``watchdog`` (FSEvents on macOS)."""

    name = "watchdog"

    def __init__(self):
        from watchdog.observers import Observer  # noqa: F401 (ImportError: not installed)

        self._observer = None

    def start(self, roots: list[str], emit: Callable[[WatchEvent], None]) -> None:
        from watchdog.events import FileSystemEventHandler
        from watchdog.observers import Observer

        class Handler(FileSystemEventHandler):
            def on_any_event(self, ev):
                kind = {"created": "created", "modified": "modified", "deleted": "removed",
                        "moved": "moved"}.get(ev.event_type)
                if kind:
                    emit(WatchEvent(ev.src_path, kind, ev.is_directory, getattr(ev, "dest_path", None)))

        self._observer = Observer()
        for root in roots:
            self._observer.schedule(Handler(), root, recursive=True)
        self._observer.start()

    def stop(self) -> None:
        if self._observer is not None:
            self._observer.stop()
            self._observer.join(timeout=5)


def default_source() -> WatchSource | None:
    try:
        return WatchdogSource()
    except ImportError:
        return None


def _wanted(path: str) -> bool:
    name = os.path.basename(path)
    return not name.startswith(".") and not name.endswith(_IGNORED_SUFFIXES)


def _mounted(path: str) -> bool:
    vol = volume_root(path)
    return vol is None or os.path.ismount(os.path.realpath(vol))


@dataclass
class _Pending:
    kind: str
    is_dir: bool
    last_event: float
    size: int | None = None


@dataclass
class WatchStats:
    applied: int = 0
    removed: int = 0
    rescans: int = 0
    last_event_at: str | None = None
    errors: list[str] = field(default_factory=list)


class Watcher:
    def __init__(self, store: Store, roots: Callable[[], list[dict[str, Any]]], debounce: float = 3.0,
                 source: WatchSource | None = None, publish: Callable[[dict], None] | None = None,
                 paused: Callable[[], bool] = lambda: False):
        self.store, self.roots, self.debounce, self.paused = store, roots, debounce, paused
        self.source = source
        self.publish = publish or (lambda event: None)
        self.stats = WatchStats()
        self._pending: dict[str, _Pending] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.running = False
        self.error: str | None = None

    # -- lifecycle -------------------------------------------------------------------------------

    def start(self) -> bool:
        if self.running:
            return True
        if self.source is None:
            self.error = "unavailable: no file-event backend (install the watchdog package)"
            return False
        roots = [str(Path(r["path"]).expanduser()) for r in self.roots()
                 if Path(r["path"]).expanduser().is_dir() and _mounted(r["path"])]
        try:
            self.source.start(roots, self.emit)
        except Exception as e:  # noqa: BLE001 - report, don't crash the server
            self.error = f"{type(e).__name__}: {e}"
            return False
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="bc-tagger-watcher", daemon=True)
        self._thread.start()
        self.running, self.error = True, None
        return True

    def stop(self) -> None:
        self._stop.set()
        if self.source is not None and self.running:
            self.source.stop()
        if self._thread is not None:
            self._thread.join(timeout=5)
        self.running = False

    def status(self) -> dict[str, Any]:
        with self._lock:
            pending = len(self._pending)
        return {"running": self.running, "backend": getattr(self.source, "name", None), "error": self.error,
                "pending": pending, "applied": self.stats.applied, "removed": self.stats.removed,
                "rescans": self.stats.rescans, "last_event_at": self.stats.last_event_at,
                "debounce_seconds": self.debounce}

    # -- events --------------------------------------------------------------------------------------

    def emit(self, event: WatchEvent) -> None:
        if not _wanted(event.path):
            return
        with self._lock:
            self.stats.last_event_at = now_iso()
            if event.kind == "moved":
                self._add(event.path, "removed", event.is_dir)
                if event.dest and _wanted(event.dest):
                    self._add(event.dest, "created", event.is_dir)
            else:
                self._add(event.path, event.kind, event.is_dir)

    def _add(self, path: str, kind: str, is_dir: bool) -> None:
        if not is_dir and kind != "rescan" and Path(path).suffix.lower() not in AUDIO_EXTS:
            return
        self._pending[path] = _Pending(kind, is_dir or kind == "rescan", time.monotonic())

    def _loop(self) -> None:
        while not self._stop.wait(min(1.0, max(0.05, self.debounce / 3))):
            self.flush()

    def flush(self, now: float | None = None) -> dict[str, int]:
        """Apply the events whose paths have been quiet long enough (and whose size is stable)."""
        now = time.monotonic() if now is None else now
        if self.paused():  # a full scan is running: events keep queueing
            return {"applied": 0, "removed": 0, "rescans": 0}
        with self._lock:
            ready: dict[str, _Pending] = {}
            for path, p in list(self._pending.items()):
                if now - p.last_event < self.debounce:
                    continue
                if p.kind != "removed" and not p.is_dir:
                    try:
                        size = os.stat(path).st_size
                    except OSError:
                        size = None
                    if size is not None and size != p.size:  # still being written: wait one more round
                        p.size, p.last_event = size, now
                        continue
                ready[path] = self._pending.pop(path)
        if not ready:
            return {"applied": 0, "removed": 0, "rescans": 0}
        return self._apply(ready)

    def _apply(self, ready: dict[str, _Pending]) -> dict[str, int]:
        from .indexer import index_file

        roots = self.roots()
        counts = {"applied": 0, "removed": 0, "rescans": 0}
        # bursts: many files under one folder → one walk of that folder
        by_dir: dict[str, list[str]] = {}
        for path, p in ready.items():
            if not p.is_dir:
                by_dir.setdefault(str(Path(path).parent), []).append(path)
        rescans = {d for d, paths in by_dir.items() if len(paths) >= BURST}
        rescans |= {path for path, p in ready.items() if p.is_dir}
        for path, p in ready.items():
            if p.is_dir or str(Path(path).parent) in rescans:
                continue
            try:
                if os.path.isfile(path):
                    index_file(self.store, path, roots)
                    counts["applied"] += 1
                elif _mounted(path):  # really gone (the volume is there)
                    with self.store.tx() as c:
                        counts["removed"] += c.execute("DELETE FROM files WHERE path = ?", (path,)).rowcount
            except (OSError, ValueError) as e:
                self.stats.errors = (self.stats.errors + [f"{path}: {e}"])[-20:]
        for folder in sorted(rescans):
            counts["rescans"] += 1
            applied, removed = self._rescan(folder, roots)
            counts["applied"] += applied
            counts["removed"] += removed
        self.stats.applied += counts["applied"]
        self.stats.removed += counts["removed"]
        self.stats.rescans += counts["rescans"]
        self.publish({"phase": "finished", "kind": "watch", **counts})
        return counts

    def _rescan(self, folder: str, roots: list[dict[str, Any]]) -> tuple[int, int]:
        from .indexer import index_file

        if not _mounted(folder):
            return 0, 0
        seen: set[str] = set()
        applied = 0
        if os.path.isdir(folder):
            for dirpath, dirnames, filenames in os.walk(folder):
                dirnames[:] = [d for d in dirnames if not d.startswith(".")]
                for name in filenames:
                    p = os.path.join(dirpath, name)
                    if _wanted(p) and Path(name).suffix.lower() in AUDIO_EXTS:
                        seen.add(p)
                        try:
                            index_file(self.store, p, roots)
                            applied += 1
                        except (OSError, ValueError):
                            continue
        prefix = folder.rstrip("/") + "/"
        stale = [r["path"] for r in self.store.query("SELECT path FROM files WHERE path LIKE ?", (prefix + "%",))
                 if r["path"] not in seen]
        with self.store.tx() as c:
            for p in stale:
                c.execute("DELETE FROM files WHERE path = ?", (p,))
        return applied, len(stale)

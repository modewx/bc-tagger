"""Opus previews of AIFF and ALAC files on the internal disk, so a track starts at once, even with the music drive
asleep or unplugged.

A preview is the file encoded to Opus 96 kbps in WebM (cues at the front and the duration written, so it seeks)
under ``<data dir>/previews/``. It's kept for one version of its source (path, size and mtime; ``previews`` table)
and played instead of the original by ``/api/files/stream`` unless asked for the original (``preview=0``).
Formats Chrome plays natively need none.

Only work the user started makes previews, and only that work reads the drive: an import commit (its located
rows), a finished download, a first play (in the background, after the stream has had the drive for a moment) and
``POST /api/previews/build``. Page loads and timers only read the table. At most two encodes run at a time, under
``nice``. The store keeps to ``preview_cache_gb`` by dropping the least recently played, and never writes when the
internal disk would drop below 2 GB free: that preview is skipped, and the status says so.
"""

from __future__ import annotations

import atexit
import hashlib
import json
import logging
import shutil
import subprocess
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

from .config import data_dir
from .fsguard import is_mounted
from .store import Store, now_iso

log = logging.getLogger(__name__)

PREVIEW_FORMATS = {"aiff", "alac"}
MIN_FREE_BYTES = 2 * 1024**3
ENCODERS = 2
PLAY_DELAY_S = 3.0  # a play's preview waits this long, so the player's first reads have the drive to themselves
TOUCH_EVERY_S = 0.0  # a played preview's last-played time is written on every request (each seek is one)
ENCODE_TIMEOUT_S = 900
UNKNOWN_LENGTH_S = 600.0  # the free-space estimate for a file whose length the index doesn't know
PLAYS_KEPT = 512  # how many paths remember what their current play started on


def previews_dir() -> Path:
    return data_dir() / "previews"


def ffmpeg_bin() -> str:
    return shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"


def _key(path: str, size: int, mtime: float) -> str:
    return hashlib.sha1(f"{path}|{size}|{mtime}".encode()).hexdigest()


def located_paths(store: Store, item_ids: Iterable[str]) -> list[str]:
    """The located files of these items (a track's, or each of a release's tracks), in item order."""
    ids = list(dict.fromkeys(item_ids))
    if not ids:
        return []
    rows = {r["item_id"]: r["best"] for r in store.query_all(
        "SELECT item_id, best FROM locate_results WHERE status = 'located' AND item_id IN "
        "(SELECT value FROM json_each(?))", ["item_id", "best"], (json.dumps(ids),))}
    out: list[str] = []
    for item_id in ids:
        best = json.loads(rows[item_id]) if rows.get(item_id) else {}
        out += [t["path"] for t in best.get("tracks") or [best] if t.get("path")]
    return list(dict.fromkeys(out))


@dataclass(eq=False)
class Task:
    path: str
    seq: int
    priority: int  # 0: a play, 1: everything else
    not_before: float
    owners: set = field(default_factory=set)  # build jobs waiting on it; None: work that can't be cancelled
    done: threading.Event = field(default_factory=threading.Event)
    result: dict | None = None
    cancelled: bool = False


class Previews:
    def __init__(self, store: Store, settings, publish: Callable[[str, Any], None], autostart: bool = True):
        self.store, self.settings, self.publish = store, settings, publish
        self.autostart = autostart  # tests turn it off and call run_pending()
        self._cv = threading.Condition()
        self._queue: list[Task] = []
        self._tasks: dict[str, Task] = {}  # queued or running, by path
        self._procs: dict[str, subprocess.Popen] = {}  # running encodes, by path
        self._workers: list[threading.Thread] = []
        self._seq = 0
        self._closed = False
        self._cancelled_owners: set[str] = set()
        self._plays: OrderedDict[str, str] = OrderedDict()  # path -> "preview" | "original", by the stream
        self._open: dict[str, int] = {}  # previews being sent right now, by source path: never dropped meanwhile
        self.skipped_low_space = 0
        self.last_skip: dict | None = None

    # -- reading (the table and the internal disk only) -------------------------------------------------

    def cap_bytes(self) -> int:
        return int(float(self.settings.get("preview_cache_gb")) * 1024**3)

    def bitrate(self) -> int:
        """Bits per second of new previews (``preview_bitrate_kbps``); existing ones keep theirs."""
        return int(self.settings.get("preview_bitrate_kbps")) * 1000

    def stream_opened(self, path: str) -> None:
        with self._cv:
            self._open[path] = self._open.get(path, 0) + 1

    def stream_closed(self, path: str) -> None:
        with self._cv:
            if self._open.get(path, 0) <= 1:
                self._open.pop(path, None)
            else:
                self._open[path] -= 1

    def lookup(self, row) -> Path | None:
        """The preview of this version of the file (``row``: path, size, mtime), if there is one."""
        hit = self.store.query_one("SELECT file FROM previews WHERE path = ? AND size = ? AND mtime = ?",
                                   (row["path"], row["size"], row["mtime"]))
        if hit is None:
            return None
        out = previews_dir() / hit["file"]
        if out.is_file():
            return out
        with self.store.tx() as c:  # deleted by hand: forget it
            c.execute("DELETE FROM previews WHERE path = ?", (row["path"],))
        return None

    def touch(self, path: str) -> None:
        """Played now (the least recently played go first when the store is full)."""
        now = time.time()
        if self.store.query_one("SELECT 1 FROM previews WHERE path = ? AND played_at <= ?",
                                (path, now - TOUCH_EVERY_S)):
            with self.store.tx() as c:
                c.execute("UPDATE previews SET played_at = ? WHERE path = ?", (now, path))

    def playing(self, path: str) -> str | None:
        """What the current play of ``path`` started on ("preview" or "original"), if this process saw it start."""
        with self._cv:
            return self._plays.get(path)

    def started(self, path: str, source: str) -> None:
        """A play of ``path`` started on ``source``: its later ranges stay on it, even if a preview appears."""
        with self._cv:
            self._plays[path] = source
            self._plays.move_to_end(path)
            while len(self._plays) > PLAYS_KEPT:
                self._plays.popitem(last=False)

    def status(self) -> dict[str, Any]:
        row = self.store.query_one("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM previews")
        with self._cv:
            running, queued = len(self._procs), len(self._queue)
            jobs = sorted({o for t in self._tasks.values() for o in t.owners if o})
        return {"count": row["n"], "bytes": row["b"], "cap_bytes": self.cap_bytes(), "free_bytes": self._free_bytes(),
                "min_free_bytes": MIN_FREE_BYTES, "building": running, "queued": queued, "jobs": jobs,
                "skipped_low_space": self.skipped_low_space, "last_skip": self.last_skip}

    def _free_bytes(self) -> int:
        d = previews_dir()
        return shutil.disk_usage(d if d.is_dir() else data_dir()).free

    # -- queueing --------------------------------------------------------------------------------------

    def wanted(self, paths: Iterable[str]) -> list[str]:
        """Those of ``paths`` that are indexed AIFF or ALAC files without a preview of their current version."""
        paths = list(dict.fromkeys(paths))
        if not paths:
            return []
        rows = self.store.query_all(
            "SELECT f.path FROM files f LEFT JOIN previews p ON p.path = f.path AND p.size = f.size "
            "AND p.mtime = f.mtime WHERE f.path IN (SELECT value FROM json_each(?)) AND p.path IS NULL "
            f"AND f.format IN ({', '.join(repr(f) for f in sorted(PREVIEW_FORMATS))})",
            ["path"], (json.dumps(paths),))
        found = {r["path"] for r in rows}
        return [p for p in paths if p in found]

    def enqueue(self, paths: Iterable[str], owner: str | None = None, delay: float = 0.0,
                play: bool = False) -> list[Task]:
        """Queue previews for those of ``paths`` that need one; returns their tasks (already queued ones too).
        ``owner``: the build job asking (it may cancel what only it asked for); ``play``: ahead of the rest."""
        if self.cap_bytes() <= 0:
            return []
        wanted = self.wanted(paths)
        tasks = []
        with self._cv:
            if self._closed:
                return []
            for path in wanted:
                task = self._tasks.get(path)
                if task is None:
                    self._seq += 1
                    task = Task(path, self._seq, 0 if play else 1, time.monotonic() + delay)
                    self._tasks[path] = task
                    self._queue.append(task)
                elif play and task in self._queue:
                    task.priority = 0
                task.owners.add(owner)
                tasks.append(task)
            if tasks:
                self._cv.notify_all()
        if tasks and self.autostart:
            self.start()
        return tasks

    def queued(self) -> list[str]:
        """Paths waiting for an encoder, next first."""
        with self._cv:
            return [t.path for t in sorted(self._queue, key=lambda t: (t.priority, t.seq))]

    def cancel(self, owner: str) -> int:
        """Drop what only ``owner`` asked for: queued previews leave the queue, running encodes are stopped."""
        n = 0
        with self._cv:
            self._cancelled_owners.add(owner)
            for task in list(self._tasks.values()):
                if owner not in task.owners:
                    continue
                task.owners.discard(owner)
                if task.owners:
                    continue
                n += 1
                task.cancelled = True
                if task in self._queue:
                    self._queue.remove(task)
                    self._finish(task, {"path": task.path, "status": "cancelled"})
                elif task.path in self._procs:
                    self._procs[task.path].terminate()
            self._cv.notify_all()
        return n

    def wait(self, tasks: list[Task], progress: Callable[[int], None] | None = None,
             owner: str | None = None) -> None:
        """Until every task is done, calling ``progress(done)`` as the count grows. Once ``owner`` is cancelled,
        tasks something else still wants aren't waited for (its own stop quickly)."""
        seen = -1
        with self._cv:
            while True:
                done = sum(t.done.is_set() for t in tasks)
                if done != seen and progress:
                    self._cv.release()
                    try:
                        progress(done)
                    finally:
                        self._cv.acquire()
                seen = done
                if done == len(tasks) or (owner in self._cancelled_owners
                                          and all(t.done.is_set() or t.owners for t in tasks)):
                    return
                self._cv.wait(1.0)

    def _finish(self, task: Task, result: dict) -> None:  # with self._cv held
        task.result = result
        self._tasks.pop(task.path, None)
        task.done.set()
        self._cv.notify_all()

    # -- workers ---------------------------------------------------------------------------------------

    def start(self) -> None:
        with self._cv:
            if self._workers or self._closed:
                return
            self._workers = [threading.Thread(target=self._work, name=f"bct-preview-{i}", daemon=True)
                             for i in range(ENCODERS)]
        atexit.register(self.close)
        for w in self._workers:
            w.start()

    def _next(self, block: bool) -> Task | None:  # with self._cv held
        while not self._closed:
            now = time.monotonic()
            ready = [t for t in self._queue if t.not_before <= now or not block]
            if ready:
                task = min(ready, key=lambda t: (t.priority, t.seq))
                self._queue.remove(task)
                return task
            if not block:
                return None
            wake = min((t.not_before for t in self._queue), default=now + 60) - now
            self._cv.wait(max(0.05, min(wake, 60)))
        return None

    def _work(self) -> None:
        while True:
            with self._cv:
                task = self._next(block=True)
            if task is None:
                return
            self._run(task)

    def run_pending(self) -> list[dict]:
        """Build everything queued, in this thread, ignoring play delays (tests)."""
        out = []
        while True:
            with self._cv:
                task = self._next(block=False)
            if task is None:
                return out
            out.append(self._run(task))

    def _run(self, task: Task) -> dict:
        try:
            result = self.build(task.path, task)
        except Exception as e:  # noqa: BLE001 - one bad file mustn't stop the queue
            log.exception("preview of %s failed", task.path)
            result = {"path": task.path, "status": "failed", "error": f"{type(e).__name__}: {e}"}
        with self._cv:
            self._finish(task, result)
        return result

    def close(self) -> None:
        with self._cv:
            self._closed = True
            for task in list(self._queue):
                self._finish(task, {"path": task.path, "status": "cancelled"})
            self._queue.clear()
            for proc in self._procs.values():
                proc.terminate()
            self._cv.notify_all()

    # -- making one ------------------------------------------------------------------------------------

    def build(self, path: str, task: Task | None = None) -> dict:
        """Make the preview of ``path`` now (it reads the whole file). ``{path, status: built|exists|skipped|
        failed|cancelled, ...}``."""
        row = self.store.query_one("SELECT path, size, mtime, format, duration FROM files WHERE path = ?", (path,))
        if row is None or row["format"] not in PREVIEW_FORMATS:
            return {"path": path, "status": "skipped", "reason": "not an indexed AIFF or ALAC file"}
        if self.lookup(row) is not None:
            return {"path": path, "status": "exists"}
        if self.cap_bytes() <= 0:
            return {"path": path, "status": "skipped", "reason": "previews are off (preview_cache_gb is 0)"}
        if not is_mounted(path):
            return {"path": path, "status": "skipped", "reason": "music drive not mounted"}
        bitrate = self.bitrate()
        estimate = int((row["duration"] or UNKNOWN_LENGTH_S) * bitrate / 8 * 1.1) + 65_536
        free = self._free_bytes()
        if free - estimate < MIN_FREE_BYTES:
            self.skipped_low_space += 1
            self.last_skip = {"path": path, "reason": "low_space", "free_bytes": free, "at": now_iso()}
            log.warning("preview of %s skipped: %d MB free on the internal disk", path, free // 2**20)
            self.publish("preview", {"path": path, "preview": False, "skipped": "low_space"})
            return {"path": path, "status": "skipped", "reason": "low_space", "free_bytes": free}
        key = _key(row["path"], row["size"], row["mtime"])
        out_dir = previews_dir()
        out_dir.mkdir(parents=True, exist_ok=True)
        out, tmp = out_dir / f"{key}.webm", out_dir / f"{key}.part.webm"
        cmd = ["nice", "-n", "10", ffmpeg_bin(), "-nostdin", "-loglevel", "error", "-y", "-i", path,
               "-map", "0:a:0", "-map_metadata", "-1", "-c:a", "libopus", "-b:a", str(bitrate),
               "-cues_to_front", "1", "-f", "webm", str(tmp)]
        with self._cv:
            if task is not None and task.cancelled or self._closed:
                return {"path": path, "status": "cancelled"}
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.PIPE, text=True)
            self._procs[path] = proc
        started = time.monotonic()
        try:
            _, err = proc.communicate(timeout=ENCODE_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            proc.kill()
            _, err = proc.communicate()
            err = f"took over {ENCODE_TIMEOUT_S} s"
        finally:
            with self._cv:
                self._procs.pop(path, None)
        if (task is not None and task.cancelled) or self._closed or proc.returncode != 0:
            tmp.unlink(missing_ok=True)
            if (task is not None and task.cancelled) or self._closed:
                return {"path": path, "status": "cancelled"}
            log.warning("preview of %s failed: %s", path, (err or "").strip()[-300:])
            return {"path": path, "status": "failed", "error": (err or "").strip()[-300:]}
        tmp.replace(out)
        nbytes = out.stat().st_size
        now = time.time()
        old = self.store.query_one("SELECT file FROM previews WHERE path = ?", (path,))
        with self.store.tx() as c:
            c.execute("INSERT INTO previews(path, size, mtime, file, bytes, created_at, played_at) "
                      "VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size, "
                      "mtime = excluded.mtime, file = excluded.file, bytes = excluded.bytes, "
                      "created_at = excluded.created_at, played_at = excluded.played_at",
                      (path, row["size"], row["mtime"], out.name, nbytes, now, now))
        if old and old["file"] != out.name:  # the preview of an earlier version
            (out_dir / old["file"]).unlink(missing_ok=True)
        log.info("preview of %s: %.1f MB in %.1f s", path, nbytes / 1e6, time.monotonic() - started)
        self.publish("preview", {"path": path, "preview": True, "bytes": nbytes})
        self.prune()
        return {"path": path, "status": "built", "bytes": nbytes}

    def prune(self) -> list[str]:
        """Drop the least recently played until the store fits ``preview_cache_gb``; returns their paths. A preview
        being sent right now is never dropped (it counts towards the cap, first)."""
        cap, dropped = self.cap_bytes(), []
        with self._cv:
            sending = set(self._open)
        rows = self.store.query("SELECT path, file, bytes FROM previews ORDER BY played_at DESC, created_at DESC")
        total = sum(r["bytes"] for r in rows if r["path"] in sending)
        for r in rows:
            if r["path"] in sending:
                continue
            total += r["bytes"]
            if total > cap:
                dropped.append(r)
        if dropped:
            with self.store.tx() as c:
                c.executemany("DELETE FROM previews WHERE path = ?", [(r["path"],) for r in dropped])
            for r in dropped:
                (previews_dir() / r["file"]).unlink(missing_ok=True)
                self.publish("preview", {"path": r["path"], "preview": False})
        return [r["path"] for r in dropped]

    def clear(self) -> dict[str, int]:
        """Delete every preview (queued ones are dropped, running encodes stopped)."""
        with self._cv:
            for task in list(self._queue):
                self._finish(task, {"path": task.path, "status": "cancelled"})
            self._queue.clear()
            for task in self._tasks.values():
                task.cancelled = True
            for proc in self._procs.values():
                proc.terminate()
        row = self.store.query_one("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM previews")
        with self.store.tx() as c:
            c.execute("DELETE FROM previews")
        d = previews_dir()
        if d.is_dir():
            for f in d.glob("*.webm"):
                f.unlink(missing_ok=True)
        self.publish("preview", {"cleared": True})
        return {"deleted": row["n"], "bytes": row["b"]}

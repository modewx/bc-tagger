"""Opus previews of AIFF and ALAC files on the internal disk, so a track starts at once, even with the music drive
asleep or unplugged.

A preview is the file encoded to Opus (``preview_bitrate_kbps``, 96) in WebM (cues at the front and the duration
written, so it seeks) under ``<data dir>/previews/``. It's kept for one version of its source (path, size and
mtime; ``previews`` table) and played by ``/api/files/stream?src=preview``. Formats Chrome plays natively need none.

Only work the user started makes previews, and only that work reads the drive:

* in the background, at most two encodes at a time, each reading its file: an import commit (its located rows),
  a finished download, a first play (a moment after the stream starts);
* a build (``POST /api/previews/build``: everything, or a selection) runs as a pipeline made for a hard disk.
  One reader reads each file once, whole, in path order (a release's files sit together, so the head barely
  seeks) into a small in-memory queue; ``preview_build_parallel`` encoders take the files from it through stdin.
  Only the reader touches the drive; background encodes wait while a build runs.

Page loads and timers only read the table. All encodes run under ``nice``. The store keeps to ``preview_cache_gb``
by dropping the least recently played (never one being sent), and never writes when the internal disk would drop
below 2 GB free: that preview is skipped, and the status says so.
"""

from __future__ import annotations

import atexit
import hashlib
import json
import logging
import shutil
import subprocess
import tempfile
import threading
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

from .config import data_dir
from .fsguard import is_mounted
from .store import Store, now_iso

log = logging.getLogger(__name__)

PREVIEW_FORMATS = {"aiff", "alac"}
MIN_FREE_BYTES = 2 * 1024**3
ENCODERS = 2  # background encodes
PLAY_DELAY_S = 3.0  # a play's preview waits this long, so the player's first reads have the drive to themselves
TOUCH_EVERY_S = 0.0  # a played preview's last-played time is written on every request (each seek is one)
ENCODE_TIMEOUT_S = 900
UNKNOWN_LENGTH_S = 600.0  # the size estimate for a file whose length the index doesn't know
PLAYS_KEPT = 512  # how many paths remember what their current play started on
READ_CHUNK = 4 * 1024**2
PIPE_CHUNK = 1024**2  # what an encoder writes to ffmpeg's stdin at a time
BATCH_QUEUE_FILES = 3  # files read ahead of the encoders, at most (and at most this many bytes, unless one is bigger)
BATCH_QUEUE_BYTES = 300 * 1024**2


def previews_dir() -> Path:
    return data_dir() / "previews"


def ffmpeg_bin() -> str:
    return shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"


def _key(path: str, size: int, mtime: float) -> str:
    return hashlib.sha1(f"{path}|{size}|{mtime}".encode()).hexdigest()


def estimate_bytes(duration: float | None, bitrate: int) -> int:
    """About what a preview of this length takes (Opus VBR lands just under its bitrate; WebM adds little)."""
    return int((duration or UNKNOWN_LENGTH_S) * bitrate / 8 * 1.02) + 16_384


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


def _read_source(path: str, counted: Callable[[int], None]) -> bytearray:
    """The whole file, read start to finish (the build's reader; nothing else reads the drive meanwhile)."""
    data = bytearray()
    with open(path, "rb", buffering=0) as f:
        while chunk := f.read(READ_CHUNK):
            data += chunk
            counted(len(chunk))
    return data


@dataclass(eq=False)
class Task:
    path: str
    seq: int
    priority: int  # 0: a play, 1: everything else
    not_before: float
    done: threading.Event = field(default_factory=threading.Event)
    result: dict | None = None


class BuildRunning(Exception):
    pass


@dataclass(eq=False)
class Batch:
    """A running build: what it's reading and how far it got."""

    job_id: str
    rows: list  # planned files, in reading (path) order
    bytes_total: int
    started: float = field(default_factory=time.monotonic)
    cancel: threading.Event = field(default_factory=threading.Event)
    current: str | None = None
    bytes_read: int = 0
    bytes_done: int = 0  # source bytes of the files done (built, failed or skipped)
    built: int = 0
    failed: int = 0
    skipped: int = 0
    encoding: int = 0
    queued: int = 0
    errors: list = field(default_factory=list)
    stopped: str | None = None  # why reading stopped early

    def progress(self) -> dict[str, Any]:
        elapsed = max(time.monotonic() - self.started, 1e-6)
        done = self.built + self.failed + self.skipped
        rate = self.bytes_done / elapsed or self.bytes_read / elapsed
        eta = (self.bytes_total - self.bytes_done) / rate if rate else None
        return {"current": done, "total": len(self.rows), "message": f"previews {done}/{len(self.rows)}",
                "built": self.built, "failed": self.failed, "skipped": self.skipped, "bytes_read": self.bytes_read,
                "bytes_total": self.bytes_total, "read_mb_s": round(self.bytes_read / elapsed / 1e6, 1),
                "eta_s": round(eta) if eta is not None else None, "current_file": self.current,
                "encoding": self.encoding, "queued": self.queued, "elapsed_s": round(elapsed, 1)}


class _Buffer:
    """Files read and waiting for an encoder: at most ``max_files`` and ``max_bytes`` (a bigger file still goes
    in alone)."""

    def __init__(self, max_files: int, max_bytes: int):
        self._cv = threading.Condition()
        self._items: deque = deque()
        self._bytes = 0
        self._closed = False
        self.max_files, self.max_bytes = max_files, max_bytes

    def put(self, item: Any, size: int, cancel: threading.Event) -> bool:
        with self._cv:
            while self._items and (len(self._items) >= self.max_files or self._bytes + size > self.max_bytes):
                if cancel.is_set():
                    return False
                self._cv.wait(0.2)
            self._items.append((item, size))
            self._bytes += size
            self._cv.notify_all()
            return True

    def get(self) -> Any | None:
        with self._cv:
            while not self._items and not self._closed:
                self._cv.wait()
            if not self._items:
                return None
            item, size = self._items.popleft()
            self._bytes -= size
            self._cv.notify_all()
            return item

    def close(self) -> None:
        with self._cv:
            self._closed = True
            self._cv.notify_all()

    def __len__(self) -> int:
        with self._cv:
            return len(self._items)


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
        self._generation = 0  # bumped by clear(): encodes started before it are thrown away
        self._batch: Batch | None = None
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
            batch = self._batch
            background = {"building": len(self._procs) - (batch.encoding if batch else 0), "queued": len(self._queue)}
        return {"count": row["n"], "bytes": row["b"], "cap_bytes": self.cap_bytes(), "free_bytes": self._free_bytes(),
                "min_free_bytes": MIN_FREE_BYTES, "kbps": self.bitrate() // 1000, **background,
                "batch": {"job_id": batch.job_id, **batch.progress()} if batch else None,
                "skipped_low_space": self.skipped_low_space, "last_skip": self.last_skip}

    def _free_bytes(self) -> int:
        d = previews_dir()
        return shutil.disk_usage(d if d.is_dir() else data_dir()).free

    # -- the background queue (imports, downloads, first plays) ---------------------------------------

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

    def enqueue(self, paths: Iterable[str], delay: float = 0.0, play: bool = False) -> list[Task]:
        """Queue previews for those of ``paths`` that need one; returns their tasks (already queued ones too).
        ``play``: ahead of the rest."""
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
                tasks.append(task)
            if tasks:
                self._cv.notify_all()
        if tasks and self.autostart:
            self.start()
        return tasks

    def queued(self) -> list[str]:
        """Paths waiting for a background encoder, next first."""
        with self._cv:
            return [t.path for t in sorted(self._queue, key=lambda t: (t.priority, t.seq))]

    def _finish(self, task: Task, result: dict) -> None:  # with self._cv held
        task.result = result
        self._tasks.pop(task.path, None)
        task.done.set()
        self._cv.notify_all()

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
            if block and self._batch is not None:  # a build reads the drive alone
                self._cv.wait(1.0)
                continue
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
            result = self.build(task.path)
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
            if self._batch:
                self._batch.cancel.set()
            for proc in self._procs.values():
                proc.terminate()
            self._cv.notify_all()

    # -- making one ------------------------------------------------------------------------------------

    def _row(self, path: str):
        return self.store.query_one("SELECT path, size, mtime, format, duration FROM files WHERE path = ?", (path,))

    def build(self, path: str) -> dict:
        """Make the preview of ``path`` now; ffmpeg reads the file itself. ``{path, status: built|exists|skipped|
        failed|cancelled, ...}``."""
        row = self._row(path)
        if row is None or row["format"] not in PREVIEW_FORMATS:
            return {"path": path, "status": "skipped", "reason": "not an indexed AIFF or ALAC file"}
        if self.lookup(row) is not None:
            return {"path": path, "status": "exists"}
        if self.cap_bytes() <= 0:
            return {"path": path, "status": "skipped", "reason": "previews are off (preview_cache_gb is 0)"}
        if not is_mounted(path):
            return {"path": path, "status": "skipped", "reason": "music drive not mounted"}
        return self._encode(row)

    def _space_left(self, row, bitrate: int) -> dict | None:
        """None if this preview fits above the 2 GB the internal disk keeps free; else the skip, recorded."""
        free = self._free_bytes()
        if free - estimate_bytes(row["duration"], bitrate) >= MIN_FREE_BYTES:
            return None
        self.skipped_low_space += 1
        self.last_skip = {"path": row["path"], "reason": "low_space", "free_bytes": free, "at": now_iso()}
        log.warning("preview of %s skipped: %d MB free on the internal disk", row["path"], free // 2**20)
        self.publish("preview", {"path": row["path"], "preview": False, "skipped": "low_space"})
        return {"path": row["path"], "status": "skipped", "reason": "low_space", "free_bytes": free}

    def _encode(self, row, data: bytearray | None = None) -> dict:
        """Encode the preview of ``row``: ffmpeg reads the file (``data`` None) or gets it from memory through stdin.
        ALAC (and an AIFF ffmpeg can't read from a pipe) goes through a copy on the internal disk: MP4 needs to
        seek."""
        path, bitrate, generation = row["path"], self.bitrate(), self._generation
        skip = self._space_left(row, bitrate)
        if skip:
            return skip
        key = _key(path, row["size"], row["mtime"])
        out_dir = previews_dir()
        out_dir.mkdir(parents=True, exist_ok=True)
        out, tmp = out_dir / f"{key}.webm", out_dir / f"{key}.part.webm"
        copy = out_dir / f"{key}.src{Path(path).suffix.lower()}"
        started = time.monotonic()
        try:
            if data is None:
                code, err = self._ffmpeg(path, path, tmp, bitrate)
            else:
                code, err = (self._ffmpeg(path, "pipe:0", tmp, bitrate, data) if row["format"] == "aiff"
                             else (1, "MP4 needs to seek"))
                if code != 0 and not self._stopped(generation):
                    copy.write_bytes(data)
                    code, err = self._ffmpeg(path, str(copy), tmp, bitrate)
        finally:
            copy.unlink(missing_ok=True)
        if self._stopped(generation) or code != 0:
            tmp.unlink(missing_ok=True)
            if self._stopped(generation):
                return {"path": path, "status": "cancelled"}
            log.warning("preview of %s failed: %s", path, err)
            return {"path": path, "status": "failed", "error": err}
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

    def _stopped(self, generation: int) -> bool:
        return self._closed or self._generation != generation

    def _ffmpeg(self, path: str, source: str, tmp: Path, bitrate: int, data: bytearray | None = None) -> tuple[int, str]:
        cmd = ["nice", "-n", "10", ffmpeg_bin(), "-nostdin", "-loglevel", "error", "-y", "-i", source,
               "-map", "0:a:0", "-map_metadata", "-1", "-c:a", "libopus", "-b:a", str(bitrate),
               "-cues_to_front", "1", "-f", "webm", str(tmp)]
        # stdin in big blocking writes (communicate() writes 512 bytes per step, holding the GIL each time: ten
        # encoders then mostly wait for each other); stderr to a file, so a chatty ffmpeg can't block the writes
        with tempfile.TemporaryFile() as errors:
            with self._cv:
                if self._closed:
                    return 1, "stopped"
                proc = subprocess.Popen(cmd, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                                        stdout=subprocess.DEVNULL, stderr=errors)
                self._procs[path] = proc
            timed_out = threading.Event()
            timer = threading.Timer(ENCODE_TIMEOUT_S, lambda: (timed_out.set(), proc.kill()))
            timer.start()
            try:
                if data is not None:
                    view = memoryview(data)
                    try:
                        for i in range(0, len(view), PIPE_CHUNK):
                            proc.stdin.write(view[i:i + PIPE_CHUNK])
                        proc.stdin.close()
                    except (BrokenPipeError, OSError):  # ffmpeg gave up early: its stderr says why
                        pass
                proc.wait()
            finally:
                timer.cancel()
                with self._cv:
                    self._procs.pop(path, None)
            errors.seek(0)
            err = errors.read().decode(errors="replace").strip()[-300:]
        if timed_out.is_set():
            err = f"took over {ENCODE_TIMEOUT_S} s"
        return proc.returncode, err

    # -- a build: everything, or a selection -----------------------------------------------------------

    def plan(self, paths: list[str]) -> dict[str, Any]:
        """What a build of ``paths`` (in collection order) would do, from the index and the internal disk only.
        Files that don't fit the cap or the free-space guard are left out from the end."""
        # row by row, not query_all: JSON keeps 15 digits of a REAL, and mtime must stay exact (it keys previews)
        rows = {r["path"]: dict(r) for r in self.store.query(
            "SELECT f.path, f.size, f.mtime, f.format, f.duration, p.path IS NOT NULL AS has FROM files f "
            "LEFT JOIN previews p ON p.path = f.path AND p.size = f.size AND p.mtime = f.mtime "
            "WHERE f.path IN (SELECT value FROM json_each(?))", (json.dumps(paths),))}
        need, native, already, missing = [], 0, 0, 0
        for p in paths:
            r = rows.get(p)
            if r is None:
                missing += 1
            elif r["format"] not in PREVIEW_FORMATS:
                native += 1
            elif r["has"]:
                already += 1
            else:
                need.append(r)
        bitrate = self.bitrate()
        used = self.store.query_one("SELECT COALESCE(SUM(bytes), 0) AS b FROM previews")["b"]
        cap, free = self.cap_bytes(), self._free_bytes()
        room_cap, room_space = cap - used, free - MIN_FREE_BYTES
        needed_bytes = sum(estimate_bytes(r["duration"], bitrate) for r in need)
        planned, total = [], 0
        for r in need:  # in collection order, up to the cap and the space
            size = estimate_bytes(r["duration"], bitrate)
            if total + size > min(room_cap, room_space):
                break
            planned.append(r)
            total += size
        return {"files": len(paths), "native": native, "already": already, "missing": missing,
                "needed": len(need), "planned": len(planned), "left_out": len(need) - len(planned),
                "needed_bytes": needed_bytes, "planned_bytes": total, "left_out_bytes": needed_bytes - total,
                "source_bytes": sum(r["size"] for r in planned),
                "audio_hours": round(sum(r["duration"] or 0 for r in planned) / 3600, 1),
                "fits_cap": needed_bytes <= room_cap, "fits_space": needed_bytes <= room_space,
                "cap_bytes": cap, "used_bytes": used, "free_bytes": free, "min_free_bytes": MIN_FREE_BYTES,
                "kbps": bitrate // 1000, "parallel": int(self.settings.get("preview_build_parallel")),
                "_rows": planned}

    def batch_job(self) -> str | None:
        with self._cv:
            return self._batch.job_id if self._batch else None

    def start_batch(self, job_id: str, plan: dict, progress: Callable[[dict], None],
                    done: Callable[[dict | None, str | None], None]) -> None:
        """Run a build of ``plan`` in the background; ``progress(fields)`` as it goes, ``done(result, error)``."""
        with self._cv:
            if self._batch is not None:
                raise BuildRunning(self._batch.job_id)
            rows = sorted(plan["_rows"], key=lambda r: r["path"])  # the drive reads a release in one sweep
            self._batch = Batch(job_id, rows, sum(r["size"] for r in rows))

        def run() -> None:
            try:
                done(self._run_batch(self._batch, plan, progress), None)
            except Exception as e:  # noqa: BLE001 - surfaced on the job
                log.exception("preview build failed")
                done(None, f"{type(e).__name__}: {e}")
            finally:
                with self._cv:
                    self._batch = None
                    self._cv.notify_all()  # background encodes go on

        threading.Thread(target=run, name=f"bct-{job_id}", daemon=True).start()

    def cancel_batch(self, job_id: str) -> bool:
        """Stop the build after the files being encoded; read files still waiting are dropped."""
        with self._cv:
            if self._batch is None or self._batch.job_id != job_id:
                return False
            self._batch.cancel.set()
            return True

    def _run_batch(self, b: Batch, plan: dict, progress: Callable[[dict], None]) -> dict:
        parallel = max(1, int(plan["parallel"]))
        buf = _Buffer(BATCH_QUEUE_FILES, BATCH_QUEUE_BYTES)
        dropped = [0]
        lock = threading.Lock()

        def reader() -> None:
            def counted(n: int) -> None:
                b.bytes_read += n

            try:
                for row in b.rows:
                    if b.cancel.is_set():
                        break
                    if not is_mounted(row["path"]):
                        b.stopped = "music drive not mounted"
                        break
                    b.current = row["path"]
                    try:
                        data = _read_source(row["path"], counted)
                    except OSError as e:
                        with lock:
                            b.failed += 1
                            b.bytes_done += row["size"]
                            b.errors.append({"path": row["path"], "error": f"{type(e).__name__}: {e}"})
                        continue
                    if not buf.put((row, data), len(data), b.cancel):
                        break
                    b.queued = len(buf)
            finally:
                b.current = None
                buf.close()

        def encoder() -> None:
            while (item := buf.get()) is not None:
                b.queued = len(buf)
                row, data = item
                if b.cancel.is_set():
                    dropped[0] += 1
                    continue
                with lock:
                    b.encoding += 1
                try:
                    result = self._encode(row, data)
                except Exception as e:  # noqa: BLE001 - listed, and the build goes on
                    log.exception("preview of %s failed", row["path"])
                    result = {"path": row["path"], "status": "failed", "error": f"{type(e).__name__}: {e}"}
                del data, item
                with lock:
                    b.encoding -= 1
                    b.bytes_done += row["size"]
                    status = result["status"]
                    if status == "built":
                        b.built += 1
                    elif status == "skipped":
                        b.skipped += 1
                    elif status == "failed":
                        b.failed += 1
                    if status in ("skipped", "failed"):
                        b.errors.append({k: result[k] for k in ("path", "status", "reason", "error") if k in result})

        threads = [threading.Thread(target=reader, name=f"bct-{b.job_id}-reader", daemon=True)]
        threads += [threading.Thread(target=encoder, name=f"bct-{b.job_id}-enc{i}", daemon=True)
                    for i in range(parallel)]
        for t in threads:
            t.start()
        last = None
        while any(t.is_alive() for t in threads):
            time.sleep(0.5)
            now = b.progress()
            if now != last:
                progress(now)
                last = now
        for t in threads:
            t.join()
        final = b.progress()
        progress(final)
        public = {k: v for k, v in plan.items() if not k.startswith("_")}
        return {**public, "built": b.built, "failed": b.failed, "skipped": b.skipped,
                "cancelled": b.cancel.is_set(), "not_built": len(b.rows) - b.built - b.failed - b.skipped,
                "dropped": dropped[0], "stopped": b.stopped, "errors": b.errors[:200],
                "bytes_read": b.bytes_read, "read_mb_s": final["read_mb_s"], "elapsed_s": final["elapsed_s"]}

    # -- keeping to the cap ----------------------------------------------------------------------------

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
        """Delete every preview: queued ones are dropped, a build is stopped, running encodes are thrown away."""
        with self._cv:
            self._generation += 1
            for task in list(self._queue):
                self._finish(task, {"path": task.path, "status": "cancelled"})
            self._queue.clear()
            if self._batch:
                self._batch.cancel.set()
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

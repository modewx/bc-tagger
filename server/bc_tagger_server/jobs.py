"""Background jobs (one worker, so scans/locates/exports never overlap) and an event bus for SSE."""

from __future__ import annotations

import asyncio
import itertools
import logging
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from .store import now_iso

log = logging.getLogger(__name__)


class EventBus:
    """Fan-out of events to SSE subscribers; ``publish`` is safe from any thread."""

    def __init__(self) -> None:
        self._subs: set[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = set()
        self._lock = threading.Lock()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        with self._lock:
            self._subs.add((asyncio.get_running_loop(), q))
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._subs = {s for s in self._subs if s[1] is not q}

    def publish(self, event: str, data: Any) -> None:
        with self._lock:
            subs = list(self._subs)
        for loop, q in subs:
            try:
                loop.call_soon_threadsafe(_put_nowait, q, (event, data))
            except RuntimeError:  # loop closed
                self.unsubscribe(q)


def _put_nowait(q: asyncio.Queue, item: Any) -> None:
    try:
        q.put_nowait(item)
    except asyncio.QueueFull:
        pass


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"  # queued | running | done | error
    progress: dict = field(default_factory=lambda: {"current": 0, "total": 0, "message": ""})
    result: Any = None
    error: str | None = None
    created_at: str = field(default_factory=now_iso)
    finished_at: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": dict(self.progress),
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
        }


class JobContext:
    """Handed to job functions for progress reporting."""

    def __init__(self, manager: "JobManager", job: Job):
        self._m = manager
        self.job = job

    def progress(self, current: int | None = None, total: int | None = None, message: str | None = None) -> None:
        p = self.job.progress
        if current is not None:
            p["current"] = current
        if total is not None:
            p["total"] = total
        if message is not None:
            p["message"] = message
        self._m.bus.publish("job", self.job.to_dict())

    def item_updated(self, item_id: str) -> None:
        self._m.bus.publish("item", {"id": item_id})

    def finish(self, result: Any = None, error: str | None = None) -> None:
        """End a job started with ``JobManager.track``."""
        self.job.result, self.job.error = result, error
        self.job.status = "error" if error else "done"
        self.job.finished_at = now_iso()
        self._m.bus.publish("job", self.job.to_dict())


class JobManager:
    def __init__(self, bus: EventBus | None = None, keep: int = 200):
        self.bus = bus or EventBus()
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="bct-job")
        self._jobs: dict[str, Job] = {}
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self._keep = keep

    def submit(self, kind: str, fn: Callable[[JobContext], Any]) -> Job:
        with self._lock:
            job = Job(id=f"{kind}-{next(self._ids)}", kind=kind)
            self._jobs[job.id] = job
            if len(self._jobs) > self._keep:
                for old in list(self._jobs)[: len(self._jobs) - self._keep]:
                    if self._jobs[old].status in ("done", "error"):
                        del self._jobs[old]
        self.bus.publish("job", job.to_dict())
        self._pool.submit(self._run, job, fn)
        return job

    def track(self, kind: str) -> JobContext:
        """A job its caller runs (not on the worker, so it neither waits for nor holds up the others): listed,
        and its progress sent, like any job; ``ctx.finish`` ends it."""
        with self._lock:
            job = Job(id=f"{kind}-{next(self._ids)}", kind=kind, status="running")
            self._jobs[job.id] = job
        self.bus.publish("job", job.to_dict())
        return JobContext(self, job)

    def _run(self, job: Job, fn: Callable[[JobContext], Any]) -> None:
        ctx = JobContext(self, job)
        job.status = "running"
        self.bus.publish("job", job.to_dict())
        try:
            job.result = fn(ctx)
            job.status = "done"
        except Exception as e:  # noqa: BLE001 - surfaced to the client
            log.error("job %s failed: %s\n%s", job.id, e, traceback.format_exc())
            job.error = f"{type(e).__name__}: {e}"
            job.status = "error"
        job.finished_at = now_iso()
        self.bus.publish("job", job.to_dict())

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return list(self._jobs.values())

    def wait(self, job_id: str, timeout: float | None = None) -> Job:
        """Block until a job finishes (used by tests and the CLI)."""
        import time

        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            job = self.get(job_id)
            if job is None or job.status in ("done", "error"):
                return job
            if deadline is not None and time.monotonic() > deadline:
                return job
            time.sleep(0.05)

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)

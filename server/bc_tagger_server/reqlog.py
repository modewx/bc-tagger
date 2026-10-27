"""Request log and slow-request watchdog, so a stalled server names its cause.

Every request is logged when it ends with its start time (the log line's), method, path, status, duration and
response size. A request still running after ``SLOW_AFTER_S`` makes the watchdog log every thread's stack once
(plus who holds the Store lock), at most once per ``DUMP_EVERY_S``.
"""

from __future__ import annotations

import itertools
import logging
import sys
import threading
import time
import traceback
from typing import Any, Callable

log = logging.getLogger("bc_tagger_server.requests")

SLOW_AFTER_S = 5.0
DUMP_EVERY_S = 30.0
WATCH_EVERY_S = 1.0

_ids = itertools.count(1)
_lock = threading.Lock()
_running: dict[int, dict[str, Any]] = {}  # request id → {start, method, path, reported, extra}
_watchdog: threading.Thread | None = None
_last_dump = 0.0


def _target(scope: dict) -> str:
    path = scope.get("path", "")
    query = scope.get("query_string", b"").decode("latin-1")
    if query:
        path += "?" + (query if len(query) <= 120 else query[:117] + "...")
    return path


class RequestLog:
    """ASGI middleware: one log line per request, and the slow-request watchdog."""

    def __init__(self, app, extra: Callable[[], str] | None = None) -> None:
        self.app = app
        self.extra = extra  # a line for the dump, e.g. who holds the Store lock

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        _start_watchdog()
        rid, start = next(_ids), time.monotonic()
        wall = time.time()
        info = {"status": 0, "bytes": 0}
        with _lock:
            _running[rid] = {"start": start, "method": scope["method"], "path": _target(scope), "reported": False,
                             "extra": self.extra}

        async def timed_send(message):
            if message["type"] == "http.response.start":
                info["status"] = message["status"]
            elif message["type"] == "http.response.body":
                info["bytes"] += len(message.get("body", b""))
            await send(message)

        try:
            await self.app(scope, receive, timed_send)
        finally:
            with _lock:
                entry = _running.pop(rid, None)
            took = time.monotonic() - start
            level = logging.WARNING if took >= SLOW_AFTER_S else logging.INFO
            log.log(level, "%s %s %s %s %.3fs %s (started %s)", (scope.get("client") or ("?", "?"))[1], scope["method"],
                    entry["path"] if entry else _target(scope), info["status"] or "-", took, _size(info["bytes"]),
                    time.strftime("%H:%M:%S", time.localtime(wall)) + f".{int(wall % 1 * 1000):03d}")


def _size(n: int) -> str:
    return f"{n / 1e6:.1f}MB" if n >= 1e6 else f"{n / 1e3:.1f}kB" if n >= 1e3 else f"{n}B"


def _start_watchdog() -> None:
    global _watchdog
    with _lock:
        if _watchdog is None or not _watchdog.is_alive():
            _watchdog = threading.Thread(target=_watch, name="bc-tagger-slow-requests", daemon=True)
            _watchdog.start()


def _watch() -> None:
    while True:
        time.sleep(WATCH_EVERY_S)
        check()


def check(now: float | None = None) -> str | None:
    """Dump every thread's stack if a request has run longer than ``SLOW_AFTER_S`` (once per request, at most
    once per ``DUMP_EVERY_S``). Returns the dump."""
    global _last_dump
    now = time.monotonic() if now is None else now
    with _lock:
        slow = [r for r in _running.values() if now - r["start"] >= SLOW_AFTER_S and not r["reported"]]
        if not slow or now - _last_dump < DUMP_EVERY_S and _last_dump:
            return None
        for r in _running.values():
            if now - r["start"] >= SLOW_AFTER_S:
                r["reported"] = True
        running = sorted(_running.values(), key=lambda r: r["start"])
        _last_dump = now
    lines = [f"slow requests: {len(slow)} over {SLOW_AFTER_S:g}s; {len(running)} running:"]
    lines += [f"  {now - r['start']:7.2f}s {r['method']} {r['path']}" for r in running]
    for extra in dict.fromkeys(r["extra"] for r in running if r["extra"] is not None):
        try:
            lines.append(extra())
        except Exception as e:  # noqa: BLE001 (a dump must never fail)
            lines.append(f"(extra failed: {e})")
    names = {t.ident: t.name for t in threading.enumerate()}
    for ident, frame in sys._current_frames().items():
        if ident == threading.get_ident():
            continue
        lines.append(f"--- thread {names.get(ident, '?')} ({ident})")
        lines += [ln.rstrip("\n") for ln in traceback.format_stack(frame)]
    dump = "\n".join(lines)
    log.warning("%s", dump)
    return dump

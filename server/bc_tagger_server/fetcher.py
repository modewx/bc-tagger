"""Polite HTTP for lookups: an identifying User-Agent, at most one request per second per host
(redirect hops included), and every answer cached in SQLite (``http_cache``), so re-running an
import costs nothing. ``offline=True`` only serves the cache; ``fixtures`` serves recorded
responses from a JSON file instead (tests, e2e).

A bot-check page ("Client Challenge") raises ``Challenged``: it is never cached and never
retried, and callers stop asking that site.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Any, Callable
from urllib.parse import urlencode, urljoin, urlsplit

from pathlib import Path

import httpx

from .store import Store, now_iso

log = logging.getLogger(__name__)

CACHE_TTL_S = 30 * 86400
MAX_REDIRECTS = 3
BACKOFF_S = (30, 60, 120)  # waits after HTTP 429/503 without Retry-After; then give up for now
MAX_WAIT_S = 600
REDIRECT_LOOP = 598  # pseudo status, cached for a day: some hosts redirect to themselves forever


class Unavailable(RuntimeError):
    pass


class Challenged(Unavailable):
    """The site answered with its bot check. Stop; don't retry, don't work around it."""


class RateLimited(Unavailable):
    """Still HTTP 429 after waiting (Retry-After, else 30/60/120 s): pause, let the user resume later."""


def _retry_after(r: httpx.Response) -> float | None:
    value = (r.headers.get("retry-after") or "").strip()
    if not value:
        return None
    if value.isdigit():
        return float(value)
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, (when - datetime.now(when.tzinfo)).total_seconds())


_CHALLENGE = re.compile(r"<title>\s*Client Challenge\s*</title>", re.I)


def is_challenge(body: str) -> bool:
    return bool(_CHALLENGE.search(body[:20000]))


def load_fixtures(path: str | Path) -> dict[str, tuple[int, str]]:
    """Recorded responses: a JSON list of {key, url, status, body} (a file, or a directory with
    ``bandcamp_recorded.json``)."""
    p = Path(path).expanduser()
    if p.is_dir():
        p = p / "bandcamp_recorded.json"
    return {e["key"]: (e["status"], e["body"]) for e in json.loads(p.read_text())}


class Fetcher:
    _locks: dict[str, threading.Lock] = {}
    _last: dict[str, float] = {}
    _guard = threading.Lock()

    def __init__(self, store: Store, user_agent: str, min_interval: float | Callable[[], float] = 1.0,
                 offline: bool = False, transport: httpx.BaseTransport | None = None,
                 fixtures: dict[str, tuple[int, str]] | None = None):
        self.store = store
        self._interval = min_interval  # a number, or read before every request (a live setting)
        self.offline = offline or fixtures is not None
        self.fixtures = fixtures
        self.sleep = time.sleep  # tests replace it
        self.on_wait = None  # called with (seconds, message) before a rate-limit wait
        self.client = httpx.Client(
            timeout=30, headers={"User-Agent": user_agent, "Accept": "application/json"},
            follow_redirects=False, transport=transport,
        )
        self.network_requests = 0

    @property
    def min_interval(self) -> float:
        return float(self._interval() if callable(self._interval) else self._interval)

    @staticmethod
    def cache_key(method: str, url: str, body: Any = None) -> str:
        return hashlib.sha1(json.dumps([method, url, body], sort_keys=True).encode()).hexdigest()

    def _cached(self, key: str) -> tuple[int, str] | None:
        if self.fixtures is not None:
            return self.fixtures.get(key)
        row = self.store.query_one("SELECT status, body, fetched_at FROM http_cache WHERE key = ?", (key,))
        if row is None:
            return None
        if not self.offline:
            age = time.time() - datetime.fromisoformat(row["fetched_at"]).timestamp()
            if age > (86400 if row["status"] == REDIRECT_LOOP else CACHE_TTL_S):
                return None
        return row["status"], row["body"]

    def request(self, method: str, url: str, *, json_body: Any = None, params: dict | None = None) -> tuple[int, str]:
        full_url = f"{url}?{urlencode(params)}" if params else url
        key = self.cache_key(method, full_url, json_body)
        hit = self._cached(key)
        if hit is not None:
            return hit
        if self.offline:
            raise Unavailable(f"not in the recorded responses: {method} {full_url} {json_body}")
        status, body = self._fetch(method, full_url, json_body)
        if is_challenge(body):
            log.warning("bot check (Client Challenge) from %s: stopping", full_url)
            raise Challenged(f"Bandcamp answered with its bot check (Client Challenge): {full_url}")
        if status in (200, 404, REDIRECT_LOOP):
            with self.store.tx() as c:
                c.execute(
                    "INSERT INTO http_cache(key, url, status, body, fetched_at) VALUES(?, ?, ?, ?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET status = excluded.status, body = excluded.body, "
                    "fetched_at = excluded.fetched_at",
                    (key, full_url, status, body, now_iso()),
                )
        return status, body

    def is_cached(self, method: str, url: str, json_body: Any = None) -> bool:
        return self._cached(self.cache_key(method, url, json_body)) is not None

    def get_json(self, url: str, params: dict | None = None) -> Any:
        status, body = self.request("GET", url, params=params)
        if status != 200:
            raise Unavailable(f"HTTP {status} for {url}")
        try:
            return json.loads(body)
        except ValueError as e:
            raise Unavailable(f"not JSON: {url}") from e

    def _send(self, method: str, url: str, json_body: Any) -> httpx.Response:
        host = urlsplit(url).netloc
        with Fetcher._guard:
            lock = Fetcher._locks.setdefault(host, threading.Lock())
        with lock:  # at most one request per min_interval and host, across all fetchers
            wait = Fetcher._last.get(host, 0.0) + self.min_interval - time.monotonic()
            if wait > 0:
                self.sleep(wait)
            try:
                return self.client.request(method, url, json=json_body)
            finally:
                Fetcher._last[host] = time.monotonic()
                self.network_requests += 1

    def _fetch(self, method: str, url: str, json_body: Any) -> tuple[int, str]:
        """Follow redirects by hand, so every hop goes through the rate limit."""
        waits = backoffs = 0
        hops = 0
        while True:
            try:
                r = self._send(method, url, json_body)
            except httpx.HTTPError as e:  # timeouts, connection errors: not cached
                log.info("request failed: %s %s: %s", method, url, e)
                return 599, f"{type(e).__name__}: {e}"
            if r.status_code in (429, 503) and not is_challenge(r.text):
                if waits == len(BACKOFF_S):
                    raise RateLimited(f"HTTP {r.status_code} after waiting {sum(BACKOFF_S[:waits])} s: {url}")
                wait = _retry_after(r)
                if wait is None:
                    wait, backoffs = BACKOFF_S[backoffs], backoffs + 1
                wait = min(MAX_WAIT_S, wait)
                waits += 1
                log.info("HTTP %s from %s: waiting %.0f s", r.status_code, url, wait)
                if self.on_wait:
                    self.on_wait(wait, f"Bandcamp is rate-limiting; waiting {wait:.0f} s")
                # Being polite: the next request to this host (this one again, or anyone's) waits it out.
                Fetcher._last[urlsplit(url).netloc] = time.monotonic() + wait - self.min_interval
                continue
            if not r.is_redirect:
                return r.status_code, r.text
            hops += 1
            if hops > MAX_REDIRECTS:
                log.info("redirect loop: %s", url)
                return REDIRECT_LOOP, f"more than {MAX_REDIRECTS} redirects: {url}"
            url = urljoin(str(r.url), r.headers["location"])
            if r.status_code == 303:
                method, json_body = "GET", None

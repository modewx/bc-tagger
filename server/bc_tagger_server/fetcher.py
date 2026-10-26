"""Polite HTTP for metadata APIs: an identifying User-Agent, at most one request per second per
host (redirect hops included), and every answer cached in SQLite (``http_cache``), so re-running
an import costs nothing. ``offline=True`` only serves the cache (tests use recorded responses).
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from datetime import datetime
from typing import Any
from urllib.parse import urlencode, urljoin, urlsplit

import httpx

from .store import Store, now_iso

log = logging.getLogger(__name__)

CACHE_TTL_S = 30 * 86400
MAX_REDIRECTS = 3
REDIRECT_LOOP = 598  # pseudo status, cached for a day: some hosts redirect to themselves forever


class Unavailable(RuntimeError):
    pass


class Fetcher:
    _locks: dict[str, threading.Lock] = {}
    _last: dict[str, float] = {}
    _guard = threading.Lock()

    def __init__(self, store: Store, user_agent: str, min_interval: float = 1.0, offline: bool = False,
                 transport: httpx.BaseTransport | None = None):
        self.store = store
        self.min_interval = min_interval
        self.offline = offline
        self.client = httpx.Client(
            timeout=30, headers={"User-Agent": user_agent, "Accept": "application/json"},
            follow_redirects=False, transport=transport,
        )
        self.network_requests = 0

    @staticmethod
    def cache_key(method: str, url: str, body: Any = None) -> str:
        return hashlib.sha1(json.dumps([method, url, body], sort_keys=True).encode()).hexdigest()

    def _cached(self, key: str) -> tuple[int, str] | None:
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
        if status in (200, 404, REDIRECT_LOOP):
            with self.store.tx() as c:
                c.execute(
                    "INSERT INTO http_cache(key, url, status, body, fetched_at) VALUES(?, ?, ?, ?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET status = excluded.status, body = excluded.body, "
                    "fetched_at = excluded.fetched_at",
                    (key, full_url, status, body, now_iso()),
                )
        return status, body

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
                time.sleep(wait)
            try:
                return self.client.request(method, url, json=json_body)
            finally:
                Fetcher._last[host] = time.monotonic()
                self.network_requests += 1

    def _fetch(self, method: str, url: str, json_body: Any) -> tuple[int, str]:
        """Follow redirects by hand, so every hop goes through the rate limit."""
        backed_off = False
        hops = 0
        while True:
            try:
                r = self._send(method, url, json_body)
            except httpx.HTTPError as e:  # timeouts, connection errors: not cached
                log.info("request failed: %s %s: %s", method, url, e)
                return 599, f"{type(e).__name__}: {e}"
            if r.status_code in (429, 503) and not backed_off:
                backed_off = True
                time.sleep(10)  # rate limited: back off once
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

"""Bandcamp ownership: cookie-file fallback fetcher (the extension normally pushes owned IDs).

``GET https://bandcamp.com/api/fan/2/collection_summary`` with the user's session cookies
returns ``tralbum_lookup`` keyed exactly like our item ids (``a<id>`` / ``t<id>``). Every
entry is in the fan's collection, so it counts as owned (``purchased`` is a date, or null
for free/code downloads). Cookie values are never logged.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import logging
from pathlib import Path
from typing import Any

import httpx

from . import USER_AGENT
from .fetcher import is_challenge

log = logging.getLogger(__name__)

SUMMARY_URL = "https://bandcamp.com/api/fan/2/collection_summary"


class OwnershipError(RuntimeError):
    pass


def load_cookies(path: str | Path) -> httpx.Cookies:
    p = Path(path).expanduser()
    if not p.is_file():
        raise OwnershipError(f"cookies file not found: {p}")
    jar = http.cookiejar.MozillaCookieJar(str(p))
    try:
        jar.load(ignore_discard=True, ignore_expires=True)
    except (OSError, http.cookiejar.LoadError) as e:
        raise OwnershipError(f"could not read cookies file {p.name}: {type(e).__name__}") from None
    cookies = httpx.Cookies()
    names = set()
    for c in jar:
        if "bandcamp.com" in c.domain:
            cookies.set(c.name, c.value, domain=c.domain, path=c.path)
            names.add(c.name)
    if "identity" not in names:
        raise OwnershipError("cookies file has no Bandcamp 'identity' cookie (not logged in?)")
    return cookies


def fetch_collection(cookies_file: str | Path, client: httpx.Client | None = None) -> dict[str, Any]:
    cookies = load_cookies(cookies_file)
    own_client = client is None
    client = client or httpx.Client(timeout=30, headers={"User-Agent": USER_AGENT})
    try:
        r = client.get(SUMMARY_URL, cookies=cookies)
    finally:
        if own_client:
            client.close()
    if is_challenge(r.text):  # the bot check: report it, don't retry or work around it
        raise OwnershipError("Bandcamp answered with its bot check (Client Challenge); not retried. "
                             "The extension's ownership push still works.")
    if r.status_code != 200:
        raise OwnershipError(f"Bandcamp answered HTTP {r.status_code} (cookies expired?)")
    data = r.json()
    summary = data.get("collection_summary") or {}
    lookup = summary.get("tralbum_lookup")
    if not isinstance(lookup, dict):
        raise OwnershipError("unexpected response: no tralbum_lookup (cookies expired?)")
    return {
        "fan_id": data.get("fan_id"),
        "username": summary.get("username"),
        "owned": {k: (v or {}).get("purchased") for k, v in lookup.items()},
    }


def refresh(service, ctx=None) -> dict[str, Any]:
    cookies_file = service.settings.get("cookies_file")
    if ctx:
        ctx.progress(0, 1, "fetching Bandcamp collection")
    coll = fetch_collection(cookies_file)
    result = service.set_ownership(list(coll["owned"]), source="cookie-file", full=True)
    tagged = [it for it in service.store.all_items()]
    from .views import ownership_status

    statuses = [ownership_status(service.store, it)["status"] for it in tagged]
    if ctx:
        ctx.progress(1, 1, "ownership updated")
    return {
        **result,
        "username": coll["username"],
        "collection_size": len(coll["owned"]),
        "tagged_owned": statuses.count("owned"),
        "tagged_not_owned": statuses.count("not_owned"),
    }


# -- CLI ---------------------------------------------------------------------------------------


def _cmd_refresh(svc, args: argparse.Namespace) -> int:
    try:
        result = refresh(svc)
    except OwnershipError as e:
        print(f"ownership refresh failed: {e}")
        return 1
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(
            f"{result['username']}: {result['collection_size']} items in the Bandcamp collection; "
            f"tagged items owned: {result['tagged_owned']}, not owned: {result['tagged_not_owned']}"
        )
    return 0


def _cmd_show(svc, args: argparse.Namespace) -> int:
    from .items import select_items
    from .views import item_view

    items = select_items(svc.store.all_items(), latest=args.latest)
    rows = [item_view(svc.store, it, svc.db_path()) for it in items]
    if args.json:
        print(json.dumps([{"id": r["id"], "title": r.get("title"), "owned": r["owned"], "hints": r["local"].get("hints")} for r in rows], indent=2))
        return 0
    for r in rows:
        hint = f"  [{', '.join(r['local']['hints'])}]" if r["local"].get("hints") else ""
        print(f"{r['owned']['status']:10} {r['id']:12} {r.get('artist') or '?'} – {r.get('title')}{hint}")
    return 0


def add_cli(sub) -> None:
    p = sub.add_parser("ownership", help="Bandcamp ownership (cookie-file fallback)")
    osub = p.add_subparsers(dest="ownership_cmd", required=True)
    r = osub.add_parser("refresh", help="fetch the fan collection with the cookies file")
    r.add_argument("--json", action="store_true")
    r.set_defaults(func=_cmd_refresh)
    s = osub.add_parser("show", help="ownership of the latest items")
    s.add_argument("--latest", type=int, default=20)
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=_cmd_show)

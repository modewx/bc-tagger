"""Helpers for tagged items (the extension's ``taggedItems`` records)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

from .store import Store

ITEM_ID_RE = re.compile(r"^([at]\d+|o[0-9a-f]{10})$")


def is_valid_id(item_id: str) -> bool:
    """Bandcamp items are ``t<trackid>`` / ``a<albumid>``, "other" items ``o<10 hex>``;
    the extension's storage also has junk keys."""
    return bool(ITEM_ID_RE.match(item_id or ""))


def is_album(item: dict) -> bool:
    item_id = str(item.get("id", ""))
    return item_id.startswith("a") or (item_id.startswith("o") and item.get("kind") == "album")


def item_tags(item: dict) -> list[str]:
    tags = item.get("tags") or []
    return [t for t in dict.fromkeys(tags) if isinstance(t, str) and t.strip()]


def item_url(item: dict) -> str | None:
    for key in ("item_url", "url"):
        v = item.get(key)
        if isinstance(v, str) and v.startswith("http"):
            return v
    return None


def album_url(item: dict) -> str | None:
    v = item.get("album_url")
    if isinstance(v, str) and v.startswith("http"):
        return v
    # Relative album URLs ("/album/naafi-x") borrow the item URL's host.
    base = item_url(item)
    if isinstance(v, str) and v.startswith("/") and base:
        p = urlparse(base)
        return f"{p.scheme}://{p.netloc}{v}"
    return None


def bandcamp_host(item: dict) -> str | None:
    url = item_url(item) or album_url(item)
    if not url:
        return None
    return urlparse(url).netloc.lower() or None


def album_name(item: dict) -> str:
    """Album title for display/matching. Album items store a slug in ``album_title``."""
    if is_album(item):
        return str(item.get("title") or "")
    return str(item.get("album_title") or "")


def load_export_json(path: Path) -> tuple[dict[str, dict], list[str]]:
    data = json.loads(Path(path).read_text())
    items = data.get("taggedItems") or {}
    tags = data.get("tags") or []
    return items, tags


def seed_from_export(store: Store, path: Path, force: bool = False) -> dict[str, Any]:
    """Load the export JSON into the mirror if the mirror is empty (or ``force``)."""
    if store.count_items() and not force:
        return {"seeded": False, "reason": "mirror not empty"}
    items, tags = load_export_json(path)
    result = store.upsert_items(items, full=True)
    store.set_tags(tags)
    store.set_meta("items_source", {"kind": "export-json", "path": str(path)})
    return {"seeded": True, **result, "tags": len(tags)}


def select_items(
    items: list[dict],
    ids: Iterable[str] | None = None,
    latest: int | None = None,
    predicate=None,
) -> list[dict]:
    """Pick items by explicit ids, or the ``latest`` N (newest first), optionally filtered.

    ``items`` must already be sorted newest first (``Store.all_items``). With a
    ``predicate``, ``latest`` counts only items that pass it.
    """
    valid = [it for it in items if is_valid_id(it.get("id", ""))]
    if ids is not None:
        wanted = list(dict.fromkeys(ids))
        by_id = {it["id"]: it for it in valid}
        chosen = [by_id[i] for i in wanted if i in by_id]
    else:
        chosen = valid
    if predicate is not None:
        chosen = [it for it in chosen if predicate(it)]
    if latest is not None:
        chosen = chosen[: max(0, int(latest))]
    return chosen


def matches_query(item: dict, q: str) -> bool:
    q = q.strip().lower()
    if not q:
        return True
    hay = " ".join(
        str(item.get(k) or "") for k in ("title", "artist", "album_title", "band_name", "item_title")
    ).lower()
    hay += " " + " ".join(item_tags(item)).lower()
    return all(part in hay for part in q.split())

"""The two collections: ``bandcamp`` (the extension's tagger items, mirrored here) and
``other`` (items not on Bandcamp, owned by the server), plus the extension's pending-adds queue.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Iterable
from urllib.parse import quote_plus

from .normalize import norm, norm_title
from .store import Store, now_iso

SOURCES = ("bandcamp", "other")


def now_ms_iso() -> str:
    """The content script's date format: 2026-10-26T05:34:49.406Z."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def by_number(item: dict) -> bool:
    """Untitled tracks and vinyl positions ("Untitled", "B1"): told apart by album + track number."""
    return "match_by_track_num" in (item.get("flags") or []) and bool(item.get("track_num"))


def parse_ts(value: Any) -> datetime | None:
    """An item's ``modified_at``/``date_added`` as a datetime (None when missing or unreadable)."""
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def by_date(items: list[dict], key: str = "modified_at", newest_first: bool = True) -> list[dict]:
    """Sorted by ``key``; items without that date count as earlier than any date (last when newest
    first, first when oldest first)."""
    dated = [it for it in items if parse_ts(it.get(key))]
    undated = [it for it in items if not parse_ts(it.get(key))]
    dated.sort(key=lambda it: parse_ts(it[key]), reverse=newest_first)
    return dated + undated if newest_first else undated + dated


def other_id(artist: str | None, title: str, album: str | None = None, track: int | None = None) -> str:
    key = "|".join((norm(artist), norm_title(title), norm(album)) + ((str(track),) if track else ()))
    return "o" + hashlib.sha1(key.encode()).hexdigest()[:10]


def search_links(artist: str | None, title: str | None, album: str | None = None,
                 hints: dict | None = None) -> dict[str, Any]:
    """Where to look an item up: the hint URLs from the import file when there are some, else
    searches. All of them open in the user's own browser."""
    from .bandcamp import search_url

    q = " ".join(p for p in (artist, title or album) if p)
    hints = hints or {}
    return {
        "bandcamp": hints.get("bandcamp_url") or search_url(artist, title or album),
        "bandcamp_is_hint": bool(hints.get("bandcamp_url")),
        "discogs": hints.get("discogs_url") or f"https://www.discogs.com/search/?q={quote_plus(q)}&type=all",
        "youtube": f"https://www.youtube.com/results?search_query={quote_plus(q)}",
    }


# -- other items -----------------------------------------------------------------------------


def other_all(store: Store) -> list[dict]:
    return [json.loads(r["data"]) for r in store.query("SELECT data FROM other_items")]


def other_get(store: Store, item_id: str) -> dict | None:
    row = store.query_one("SELECT data FROM other_items WHERE id = ?", (item_id,))
    return json.loads(row["data"]) if row else None


def other_put(store: Store, item: dict) -> dict:
    item = {**item, "source": "other"}
    item["album_title"] = item.get("album")
    item["links"] = links_for(item)
    with store.tx() as c:
        c.execute(
            "INSERT INTO other_items(id, data, date_added, updated_at) VALUES(?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data, date_added = excluded.date_added, "
            "updated_at = excluded.updated_at",
            (item["id"], json.dumps(item), item.get("date_added"), now_iso()),
        )
    return item


def other_set_tags(store: Store, item_id: str, tags: list[str]) -> dict | None:
    item = other_get(store, item_id)
    if item is None:
        return None
    clean = [t for t in dict.fromkeys(tags) if isinstance(t, str) and t.strip()]
    if clean != item.get("tags"):
        item["modified_at"] = now_ms_iso()
    item["tags"] = clean
    return other_put(store, item)


# -- pending adds (server -> extension) ------------------------------------------------------


def queue_add(store: Store, *, item: dict | None = None, tags: list[str] | None = None) -> int:
    payload = {"item": item} if item is not None else {"tags": list(tags or [])}
    with store.tx() as c:
        cur = c.execute(
            "INSERT INTO pending_adds(item_id, payload, created_at) VALUES(?, ?, ?)",
            (item["id"] if item else None, json.dumps(payload), now_iso()),
        )
        return cur.lastrowid


def pending_adds(store: Store) -> list[dict]:
    rows = store.query("SELECT add_id, payload FROM pending_adds WHERE acked_at IS NULL ORDER BY add_id")
    return [{"add_id": r["add_id"], **json.loads(r["payload"])} for r in rows]


def ack_adds(store: Store, add_ids: Iterable[int]) -> int:
    ts, n = now_iso(), 0
    with store.tx() as c:
        for add_id in add_ids:
            n += c.execute(
                "UPDATE pending_adds SET acked_at = ? WHERE add_id = ? AND acked_at IS NULL", (ts, int(add_id))
            ).rowcount
    return n


def merge_pending_item_tags(store: Store, item_id: str, tags: list[str], replace: bool = False) -> bool:
    """Union ``tags`` into (or with ``replace``, set them on) a not-yet-acked pending add for ``item_id``."""
    row = store.query_one(
        "SELECT add_id, payload FROM pending_adds WHERE item_id = ? AND acked_at IS NULL ORDER BY add_id DESC",
        (item_id,),
    )
    if row is None:
        return False
    payload = json.loads(row["payload"])
    old = [] if replace else payload["item"].get("tags", [])
    payload["item"]["tags"] = list(dict.fromkeys(old + tags))
    payload["item"]["modified_at"] = now_ms_iso()
    with store.tx() as c:
        c.execute("UPDATE pending_adds SET payload = ? WHERE add_id = ?", (json.dumps(payload), row["add_id"]))
    return True


# -- both collections ------------------------------------------------------------------------


def _newest_first(items: list[dict]) -> list[dict]:
    dated = [it for it in items if isinstance(it.get("date_added"), str)]
    undated = [it for it in items if not isinstance(it.get("date_added"), str)]
    return sorted(dated, key=lambda it: it["date_added"], reverse=True) + sorted(undated, key=lambda it: it["id"])


def all_items(store: Store, sources: Iterable[str] = SOURCES) -> list[dict]:
    """Both collections, newest ``date_added`` first. Bandcamp items queued for the tagger but
    not synced back yet are included with ``pending: "tagger"``."""
    sources = set(sources)
    out: list[dict] = []
    if "bandcamp" in sources:
        mirror = store.all_items()
        seen = {it["id"] for it in mirror}
        out += [{**it, "source": "bandcamp"} for it in mirror]
        for add in pending_adds(store):
            item = add.get("item")
            if item and item["id"] not in seen:
                seen.add(item["id"])
                out.append({**item, "source": "bandcamp", "pending": "tagger"})
    if "other" in sources:
        out += other_all(store)
    return _newest_first(out)


def name_key(artist: str | None, title: str | None) -> tuple[str, str]:
    return norm(artist), norm_title(title)


class DuplicateIndex:
    """Lookups for import rows: same Bandcamp id, or same normalized artist + title."""

    def __init__(self, store: Store):
        self.by_id: dict[str, dict] = {}
        self.by_name: dict[tuple[str, str], dict] = {}
        for it in all_items(store):
            self.add(it)

    @staticmethod
    def _keys(artist: str | None, title: str | None, item: dict | None = None) -> list[tuple[str, str]]:
        if item and by_number(item):  # "Untitled" B1 and B2 are different tracks
            album = item.get("album") or item.get("album_title")
            return [(norm(artist), f"{norm_title(title)} #{item['track_num']} {norm(album)}")] if artist else []
        keys = [name_key(artist, title)]
        if title and " - " in title:  # compilations: "Artist - Title" with the label as artist
            a, t = title.split(" - ", 1)
            keys.append(name_key(a, t))
        return [k for k in keys if k[0] and k[1]]

    def find(self, item_id: str | None, artist: str | None, title: str | None, item: dict | None = None) -> dict | None:
        """By id, else by artist + title (``item``: the row's item, for its album + track number)."""
        hit = self.by_id.get(item_id) if item_id else None
        if hit is None:
            for key in self._keys(artist, title, item):
                hit = self.by_name.get(key)
                if hit:
                    break
        if hit is None:
            return None
        return {"of": hit["id"], "source": hit.get("source", "bandcamp"), "title": hit.get("title"),
                "artist": hit.get("artist"), "tags": list(hit.get("tags") or []),
                "pending": hit.get("pending")}

    def add(self, item: dict) -> None:
        self.by_id[item["id"]] = item
        for key in self._keys(item.get("artist"), item.get("title"), item):
            self.by_name.setdefault(key, item)


def links_for(item: dict) -> dict[str, Any]:
    return search_links(item.get("artist"), item.get("title"), item.get("album"), item.get("hints"))

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
    return [json.loads(r["data"]) for r in store.query_all("SELECT data FROM other_items", ["data"])]


def other_get(store: Store, item_id: str) -> dict | None:
    row = store.query_one("SELECT data FROM other_items WHERE id = ?", (item_id,))
    return json.loads(row["data"]) if row else None


def other_put(store: Store, item: dict, collection_id: int | None = None) -> dict:
    """Save an Other item. A new one joins ``collection_id`` (an import's choice; else the first collection),
    unless it's in a collection already."""
    item = {**item, "source": "other"}
    item["album_title"] = item.get("album")
    item["links"] = links_for(item)
    ts = now_iso()
    with store.tx() as c:
        new = c.execute("SELECT 1 FROM other_items WHERE id = ?", (item["id"],)).fetchone() is None
        c.execute(
            "INSERT INTO other_items(id, data, date_added, updated_at) VALUES(?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data, date_added = excluded.date_added, "
            "updated_at = excluded.updated_at",
            (item["id"], json.dumps(item), item.get("date_added"), ts),
        )
        if new:  # collection 0's "#" is the item's; elsewhere, after the last
            if collection_id is None:
                from .membership import FIRST_SQL

                collection_id = c.execute(FIRST_SQL).fetchone()["id"]
            pos = item_order(item) if collection_id == 0 else None
            c.execute("INSERT INTO collection_items(collection_id, item_id, pos, added_at) SELECT ?, ?, "
                      "COALESCE(?, (SELECT COALESCE(MAX(pos), 0) + 1 FROM collection_items WHERE collection_id = ?)), "
                      "? WHERE NOT EXISTS (SELECT 1 FROM collection_items WHERE item_id = ?)",
                      (collection_id, item["id"], pos, collection_id, ts, item["id"]))
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
    rows = store.query_all("SELECT add_id, payload FROM pending_adds WHERE acked_at IS NULL", ["add_id", "payload"])
    return [{"add_id": r["add_id"], **json.loads(r["payload"])} for r in sorted(rows, key=lambda r: r["add_id"])]


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


# -- deleting items (the app's Remove from collection / Delete collection) ------------------


def _found(c, ids: list[str]) -> dict[str, tuple[str, dict]]:
    """``{id: (kind, data)}`` for those of ``ids`` that are items: Other items, the mirror, unacked pending adds."""
    out: dict[str, tuple[str, dict]] = {}
    for r in c.execute(
            "SELECT id, data, 'other' AS kind, 0 AS rank FROM other_items WHERE id IN (SELECT value FROM json_each(?)) "
            "UNION ALL SELECT id, data, 'bandcamp', 1 FROM items WHERE id IN (SELECT value FROM json_each(?)) "
            "UNION ALL SELECT item_id, json_extract(payload, '$.item'), 'bandcamp', 2 FROM pending_adds "
            "WHERE acked_at IS NULL AND item_id IN (SELECT value FROM json_each(?)) ORDER BY rank",
            (json.dumps(ids),) * 3):  # the mirror's copy before a pending add's
        out.setdefault(r["id"], (r["kind"], json.loads(r["data"])))
    return out


def describe(c, ids: list[str]) -> list[dict]:
    """``[{id, title, artist, kind: "bandcamp"|"other"}]`` for those of ``ids`` that are items, in that order."""
    found = _found(c, ids)
    return [{"id": i, "title": found[i][1].get("title"), "artist": found[i][1].get("artist"), "kind": found[i][0]}
            for i in ids if i in found]


def delete_items(c, ids: list[str], ts: str) -> dict[str, list]:
    """Delete items for good, inside ``c`` (with their memberships, locate results and match decisions; files and
    rekordbox stay). Other items are the server's: gone. Bandcamp items are the extension's: out of the mirror (an
    unacked pending add or tag edit is called off), with a pending delete for the extension that is also a
    tombstone until it's acked. Ids that aren't items are left alone. ``{deleted: [ids], pending_deletes:
    [{delete_id, item_id}]}``."""
    found = _found(c, ids)
    deleted, queued = [], []
    for item_id in ids:
        if item_id not in found:
            continue
        kind, data = found[item_id]
        if kind == "other":
            c.execute("DELETE FROM other_items WHERE id = ?", (item_id,))
        else:
            c.execute("DELETE FROM items WHERE id = ?", (item_id,))
            c.execute("UPDATE pending_adds SET acked_at = ? WHERE item_id = ? AND acked_at IS NULL", (ts, item_id))
            c.execute("UPDATE tag_edits SET acked_at = ? WHERE item_id = ? AND acked_at IS NULL", (ts, item_id))
            c.execute("INSERT OR IGNORE INTO pending_deletes(item_id, data, created_at) VALUES(?, ?, ?)",
                      (item_id, json.dumps(data), ts))  # already queued: the one there stands
            row = c.execute("SELECT delete_id FROM pending_deletes WHERE item_id = ? AND acked_at IS NULL",
                            (item_id,)).fetchone()
            queued.append({"delete_id": row["delete_id"], "item_id": item_id})
        for table in ("collection_items", "locate_results", "match_overrides"):
            c.execute(f"DELETE FROM {table} WHERE item_id = ?", (item_id,))
        deleted.append(item_id)
    return {"deleted": deleted, "pending_deletes": queued}


# -- pending deletes (server -> extension) ---------------------------------------------------


def pending_deletes(store: Store) -> list[dict]:
    """``[{delete_id, item_id}]`` not acked yet, oldest first."""
    return [{"delete_id": r["delete_id"], "item_id": r["item_id"]} for r in store.query(
        "SELECT delete_id, item_id FROM pending_deletes WHERE acked_at IS NULL ORDER BY delete_id")]


def ack_deletes(store: Store, delete_ids: Iterable[int]) -> int:
    """The extension deleted them too: their tombstones go, so a later star of the same track works."""
    ts, n = now_iso(), 0
    with store.tx() as c:
        for delete_id in delete_ids:
            n += c.execute("UPDATE pending_deletes SET acked_at = ? WHERE delete_id = ? AND acked_at IS NULL",
                           (ts, int(delete_id))).rowcount
    return n


# -- both collections ------------------------------------------------------------------------


def item_order(item: dict) -> int | None:
    """The item's "#" (``order``, an integer ≥ 1), or None."""
    value = item.get("order")
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 1 else None


def max_order(store: Store) -> int:
    """The highest "#" in use (mirror items, unacked pending adds, Other items, and collection 0's positions), and
    never less than the number of Bandcamp items in the mirror, so numbers the extension gives its own items (1..N)
    stay free. Collection 0's positions count because an item without a "#" (starred into another collection) that
    joins "Collection" on the server is numbered there after the last one."""
    valid = "json_type({col}, '{path}') = 'integer' AND json_extract({col}, '{path}') >= 1"
    queries = (
        f"SELECT MAX(json_extract(data, '$.order')) AS n FROM items WHERE {valid.format(col='data', path='$.order')}",
        f"SELECT MAX(json_extract(payload, '$.item.order')) AS n FROM pending_adds WHERE acked_at IS NULL "
        f"AND {valid.format(col='payload', path='$.item.order')}",
        f"SELECT MAX(json_extract(data, '$.order')) AS n FROM other_items WHERE {valid.format(col='data', path='$.order')}",
        "SELECT MAX(pos) AS n FROM collection_items WHERE collection_id = 0",  # covering index: collection_items_pos
    )
    return max([store.count_items()] + [store.query_one(q)["n"] or 0 for q in queries])


def by_order(items: list[dict], ascending: bool = True) -> list[dict]:
    """By "#" (ties by id); items without one last, in the order given."""
    numbered = sorted((it for it in items if item_order(it)), key=lambda it: (item_order(it), it["id"]),
                      reverse=not ascending)
    return numbered + [it for it in items if not item_order(it)]


def number_other_items(store: Store) -> int:
    """Other items from before "#" existed get numbers after ``max_order``, oldest first (only those
    without one, so running it again does nothing)."""
    todo = [it for it in other_all(store) if not item_order(it)]
    todo.sort(key=lambda it: (it.get("date_added") or "", it["line"] if isinstance(it.get("line"), int) else 0,
                              it["id"]))
    n = max_order(store)
    for it in todo:
        n += 1
        other_put(store, {**it, "order": n})
    return len(todo)


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

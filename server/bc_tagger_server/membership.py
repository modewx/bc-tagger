"""Collections (Phase 8): named sets of items, each with its own "#".

Membership is explicit for every collection (``collection_items``), id 0 "Collection" included. An item can be in
several collections or none (it still shows in All). Track data (tags, location, ownership, previews, rekordbox)
stays per item. Collection 0's "#" follows the item's ``order`` (numbered by the extension and by imports); other
collections number their items as they're added.
"""

from __future__ import annotations

import json
from typing import Any, Iterable

from .store import Store, now_iso

MAIN = 0  # "Collection": what the extension tags into; can be renamed, not deleted


class CollectionError(Exception):
    """400: a bad name or request."""


class CollectionConflict(Exception):
    """409: a name in use, or deleting collection 0."""


def _order(item: dict) -> int | None:
    value = item.get("order")
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 1 else None


def get(store: Store, collection_id: int) -> dict:
    row = store.query_one("SELECT c.id, c.name, c.pos, c.created_at, COUNT(ci.item_id) AS count FROM collections c "
                          "LEFT JOIN collection_items ci ON ci.collection_id = c.id WHERE c.id = ? GROUP BY c.id",
                          (collection_id,))
    if row is None:
        raise KeyError(collection_id)
    return dict(row)


def all_collections(store: Store) -> list[dict]:
    """``[{id, name, pos, count, created_at}]`` by ``pos`` (then id); no "all" entry."""
    rows = store.query("SELECT c.id, c.name, c.pos, c.created_at, COUNT(ci.item_id) AS count FROM collections c "
                       "LEFT JOIN collection_items ci ON ci.collection_id = c.id GROUP BY c.id")
    return sorted((dict(r) for r in rows), key=lambda r: (r["pos"] if r["pos"] is not None else 1 << 30, r["id"]))


def _clean_name(name: Any) -> str:
    if not isinstance(name, str) or not name.strip():
        raise CollectionError("a collection needs a name")
    name = " ".join(name.split())
    if len(name) > 100:
        raise CollectionError("a collection name has at most 100 characters")
    return name


def _name_taken(store: Store, name: str, but: int | None = None) -> bool:
    row = store.query_one("SELECT id FROM collections WHERE name = ? COLLATE NOCASE", (name,))
    return row is not None and row["id"] != but


def create(store: Store, name: Any) -> dict:
    name = _clean_name(name)
    if _name_taken(store, name):
        raise CollectionConflict(f'there is already a collection named "{name}"')
    with store.tx() as c:
        top = c.execute("SELECT COALESCE(MAX(id), 0) AS id, COALESCE(MAX(pos), 0) AS pos FROM collections").fetchone()
        cid = top["id"] + 1
        c.execute("INSERT INTO collections(id, name, pos, created_at) VALUES(?, ?, ?, ?)",
                  (cid, name, top["pos"] + 1, now_iso()))
    return get(store, cid)


def update(store: Store, collection_id: int, name: Any = None, pos: Any = None) -> dict:
    """Rename (collection 0 too) and/or set its place in the list (``pos``; ties go by id)."""
    get(store, collection_id)
    changes: dict[str, Any] = {}
    if name is not None:
        changes["name"] = _clean_name(name)
        if _name_taken(store, changes["name"], but=collection_id):
            raise CollectionConflict(f'there is already a collection named "{changes["name"]}"')
    if pos is not None:
        if isinstance(pos, bool) or not isinstance(pos, int) or pos < 0:
            raise CollectionError("pos must be a whole number from 0")
        changes["pos"] = pos
    if changes:
        with store.tx() as c:
            c.execute(f"UPDATE collections SET {', '.join(f'{k} = ?' for k in changes)} WHERE id = ?",
                      (*changes.values(), collection_id))
    return get(store, collection_id)


def delete(store: Store, collection_id: int) -> list[str]:
    """Remove the collection and its memberships only (items, files and rekordbox stay). Returns the item ids
    that were in it."""
    if collection_id == MAIN:
        raise CollectionConflict('"Collection" can\'t be deleted')
    get(store, collection_id)
    ids = members(store, collection_id)
    with store.tx() as c:
        c.execute("DELETE FROM collection_items WHERE collection_id = ?", (collection_id,))
        c.execute("DELETE FROM collections WHERE id = ?", (collection_id,))
    return ids


def members(store: Store, collection_id: int) -> list[str]:
    return [r["item_id"] for r in store.query_all("SELECT item_id FROM collection_items WHERE collection_id = ?",
                                                  ["item_id"], (collection_id,))]


def add_items(store: Store, collection_id: int, items: Iterable[dict]) -> dict[str, list[str]]:
    """Put ``items`` (dicts with ``id``; ``order`` for collection 0) into the collection, in the order given, after
    what's there ("#" = the last one's + 1; in collection 0, the item's own "#" when it has one). Idempotent:
    ``{added: [ids], already: [ids]}``."""
    get(store, collection_id)
    items = list({it["id"]: it for it in items}.values())
    if not items:
        return {"added": [], "already": []}
    ts = now_iso()
    added, already = [], []
    with store.tx() as c:
        have = {r["item_id"] for r in c.execute(
            "SELECT item_id FROM collection_items WHERE collection_id = ? AND item_id IN (SELECT value FROM "
            "json_each(?))", (collection_id, json.dumps([it["id"] for it in items])))}
        top = c.execute("SELECT COALESCE(MAX(pos), 0) AS pos FROM collection_items WHERE collection_id = ?",
                        (collection_id,)).fetchone()["pos"]
        rows = []
        for it in items:
            if it["id"] in have:
                already.append(it["id"])
                continue
            pos = _order(it) if collection_id == MAIN else None
            if pos is None:
                top += 1
                pos = top
            rows.append((collection_id, it["id"], pos, ts))
            added.append(it["id"])
        c.executemany("INSERT INTO collection_items(collection_id, item_id, pos, added_at) VALUES(?, ?, ?, ?)", rows)
    return {"added": added, "already": already}


def remove_items(store: Store, collection_id: int, ids: Iterable[str]) -> list[str]:
    """Take ``ids`` out of the collection (membership only). Returns those that were in it."""
    get(store, collection_id)
    ids = list(dict.fromkeys(ids))
    with store.tx() as c:
        gone = [r["item_id"] for r in c.execute(
            "SELECT item_id FROM collection_items WHERE collection_id = ? AND item_id IN (SELECT value FROM "
            "json_each(?))", (collection_id, json.dumps(ids)))]
        c.executemany("DELETE FROM collection_items WHERE collection_id = ? AND item_id = ?",
                      [(collection_id, i) for i in gone])
    return gone


def memberships(store: Store, ids: Iterable[str] | None = None) -> dict[str, list[int]]:
    """``{item_id: [collection ids]}`` (in the collections' list order), for ``ids`` or every item."""
    sql = ("SELECT ci.item_id, ci.collection_id, c.pos FROM collection_items ci JOIN collections c "
           "ON c.id = ci.collection_id")
    params: tuple = ()
    if ids is not None:
        sql += " WHERE ci.item_id IN (SELECT value FROM json_each(?))"
        params = (json.dumps(list(ids)),)
    out: dict[str, list[tuple]] = {}
    for r in store.query_all(sql, ["item_id", "collection_id", "pos"], params):
        out.setdefault(r["item_id"], []).append((r["pos"] if r["pos"] is not None else 1 << 30, r["collection_id"]))
    return {k: [cid for _, cid in sorted(v)] for k, v in out.items()}


def positions(store: Store, collection_id: int) -> dict[str, tuple[int | None, str]]:
    """``{item_id: (pos, added_at)}`` of a collection's members."""
    return {r["item_id"]: (r["pos"], r["added_at"]) for r in store.query_all(
        "SELECT item_id, pos, added_at FROM collection_items WHERE collection_id = ?", ["item_id", "pos", "added_at"],
        (collection_id,))}


def first_added(store: Store) -> dict[str, str]:
    """When each item first joined any collection."""
    return {r["item_id"]: r["added_at"] for r in store.query_all(
        "SELECT item_id, MIN(added_at) AS added_at FROM collection_items GROUP BY item_id", ["item_id", "added_at"])}


def by_position(items: list[dict], pos: dict[str, int | None], added: dict[str, str],
                ascending: bool = True) -> list[dict]:
    """By "#" (``pos``; ties by id), then those without one by when they were added (in the same direction), then
    those with neither in the order given."""
    numbered = sorted((it for it in items if pos.get(it["id"]) is not None), key=lambda it: (pos[it["id"]], it["id"]),
                      reverse=not ascending)
    rest = [it for it in items if pos.get(it["id"]) is None]
    dated = sorted((it for it in rest if added.get(it["id"])), key=lambda it: added[it["id"]], reverse=not ascending)
    return numbered + dated + [it for it in rest if not added.get(it["id"])]

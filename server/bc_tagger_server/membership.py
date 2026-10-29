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
    check_deletable(store, collection_id)
    with store.tx() as c:
        return delete_rows(c, collection_id)


def check_deletable(store: Store, collection_id: int) -> None:
    if collection_id == MAIN:
        raise CollectionConflict('"Collection" can\'t be deleted')
    get(store, collection_id)


def delete_rows(c, collection_id: int) -> list[str]:
    """``delete`` inside a transaction ``c``."""
    ids = [r["item_id"] for r in c.execute("SELECT item_id FROM collection_items WHERE collection_id = ?",
                                           (collection_id,))]
    c.execute("DELETE FROM collection_items WHERE collection_id = ?", (collection_id,))
    c.execute("DELETE FROM collections WHERE id = ?", (collection_id,))
    return ids


def leaving(c, collection_id: int, ids: Iterable[str] | None = None) -> tuple[list[str], list[str]]:
    """Inside ``c``: the members of the collection among ``ids`` (None: all of them, by "#"), and those of them in
    no other collection, which taking them out would leave nowhere."""
    if ids is None:
        inside = [r["item_id"] for r in c.execute(
            "SELECT item_id FROM collection_items WHERE collection_id = ? ORDER BY pos IS NULL, pos, added_at, item_id",
            (collection_id,))]
    else:
        ids = list(dict.fromkeys(ids))
        have = {r["item_id"] for r in c.execute(
            "SELECT item_id FROM collection_items WHERE collection_id = ? AND item_id IN (SELECT value FROM "
            "json_each(?))", (collection_id, json.dumps(ids)))}
        inside = [i for i in ids if i in have]
    elsewhere = {r["item_id"] for r in c.execute(
        "SELECT DISTINCT item_id FROM collection_items WHERE collection_id != ? AND item_id IN (SELECT value FROM "
        "json_each(?))", (collection_id, json.dumps(inside)))}
    return inside, [i for i in inside if i not in elsewhere]


def members(store: Store, collection_id: int) -> list[str]:
    return [r["item_id"] for r in store.query_all("SELECT item_id FROM collection_items WHERE collection_id = ?",
                                                  ["item_id"], (collection_id,))]


def add_items(store: Store, collection_id: int, items: Iterable[dict]) -> dict[str, list[str]]:
    """Put ``items`` (dicts with ``id``; ``order`` for collection 0) into the collection, in the order given, after
    what's there ("#" = the last one's + 1; in collection 0, the item's own "#" when it has one). Idempotent:
    ``{added: [ids], already: [ids]}``."""
    get(store, collection_id)
    with store.tx() as c:
        return add_rows(c, collection_id, [(it["id"], _order(it)) for it in items], now_iso())


def add_rows(c, collection_id: int, items: list[tuple[str, int | None]], ts: str,
             follow_order: bool = False) -> dict[str, list[str]]:
    """``add_items`` inside a transaction ``c``: ``items`` are ``(id, "#" or None)``. ``follow_order``: in collection
    0 the item's "#" even when it has none (the extension's items: their "#" is the extension's to give)."""
    items = list(dict(items).items())
    if not items:
        return {"added": [], "already": []}
    have = {r["item_id"] for r in c.execute(
        "SELECT item_id FROM collection_items WHERE collection_id = ? AND item_id IN (SELECT value FROM "
        "json_each(?))", (collection_id, json.dumps([i for i, _ in items])))}
    top = c.execute("SELECT COALESCE(MAX(pos), 0) AS pos FROM collection_items WHERE collection_id = ?",
                    (collection_id,)).fetchone()["pos"]
    added, already, rows = [], [], []
    for item_id, order in items:
        if item_id in have:
            already.append(item_id)
            continue
        pos = order if collection_id == MAIN else None
        if pos is None and not (follow_order and collection_id == MAIN):
            top += 1
            pos = top
        rows.append((collection_id, item_id, pos, ts))
        added.append(item_id)
    c.executemany("INSERT INTO collection_items(collection_id, item_id, pos, added_at) VALUES(?, ?, ?, ?)", rows)
    return {"added": added, "already": already}


def remove_items(store: Store, collection_id: int, ids: Iterable[str]) -> list[str]:
    """Take ``ids`` out of the collection (membership only). Returns those that were in it."""
    get(store, collection_id)
    with store.tx() as c:
        return remove_rows(c, collection_id, ids)


def remove_rows(c, collection_id: int, ids: Iterable[str]) -> list[str]:
    """``remove_items`` inside a transaction ``c``."""
    ids = list(dict.fromkeys(ids))
    gone = [r["item_id"] for r in c.execute(
        "SELECT item_id FROM collection_items WHERE collection_id = ? AND item_id IN (SELECT value FROM "
        "json_each(?))", (collection_id, json.dumps(ids)))]
    c.executemany("DELETE FROM collection_items WHERE collection_id = ? AND item_id = ?",
                  [(collection_id, i) for i in gone])
    return gone


FIRST_SQL = "SELECT id FROM collections ORDER BY pos IS NULL, pos, id LIMIT 1"


def first_collection(store_or_conn) -> int:
    """Where a new item with no membership goes ("All" adds to the first collection): the lowest ``pos``, then id.
    Collection 0 can't be deleted, so there always is one."""
    run = store_or_conn.query_one if isinstance(store_or_conn, Store) else (
        lambda sql: store_or_conn.execute(sql).fetchone())
    return run(FIRST_SQL)["id"]


def apply_ops(c, ops: list[dict], orders: dict[str, int | None], known: set[str], ts: str,
              tombstoned: set[str] = frozenset()) -> dict[str, Any]:
    """The extension's membership changes (``[{op: "add"|"remove", collection_id, ids}]``), in order, inside the
    sync's transaction ``c``. An op for a collection that's gone is skipped; so are ``tombstoned`` ids (deleted in
    the app; the rest of their op is applied, and the skip names them in ``ids``); ids that aren't items are left
    out of adds. ``{added, removed, skipped: [{index, op, collection_id, reason, ids?}], unknown, changes: {cid:
    {added, removed}}}``."""
    exists = {r["id"] for r in c.execute("SELECT id FROM collections")}
    out: dict[str, Any] = {"added": 0, "removed": 0, "skipped": [], "unknown": 0, "changes": {}}
    for index, op in enumerate(ops):
        cid = op["collection_id"]
        if cid not in exists:
            out["skipped"].append({"index": index, "op": op["op"], "collection_id": cid,
                                   "reason": "no such collection"})
            continue
        change = out["changes"].setdefault(cid, {"added": [], "removed": []})
        ids = list(dict.fromkeys(op["ids"]))
        gone = [i for i in ids if i in tombstoned]
        if gone:
            out["skipped"].append({"index": index, "op": op["op"], "collection_id": cid, "reason": "deleted",
                                   "ids": gone})
            ids = [i for i in ids if i not in tombstoned]
        if op["op"] == "add":
            wanted = [i for i in ids if i in known]
            out["unknown"] += len(ids) - len(wanted)
            done = add_rows(c, cid, [(i, orders.get(i)) for i in wanted], ts, follow_order=True)["added"]
            change["added"] += done
            out["added"] += len(done)
        else:
            done = remove_rows(c, cid, ids)
            change["removed"] += done
            out["removed"] += len(done)
    return out


def all_members(store: Store) -> dict[str, list[str]]:
    """``{"<collection id>": [item ids by "#", then when they joined]}`` for every collection (empty ones too)."""
    out: dict[str, list[str]] = {str(c["id"]): [] for c in all_collections(store)}
    rows = store.query_all("SELECT collection_id, item_id, pos, added_at FROM collection_items",
                           ["collection_id", "item_id", "pos", "added_at"])
    rows.sort(key=lambda r: (r["collection_id"], r["pos"] is None, r["pos"] or 0, r["added_at"], r["item_id"]))
    for r in rows:
        out.setdefault(str(r["collection_id"]), []).append(r["item_id"])
    return out


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

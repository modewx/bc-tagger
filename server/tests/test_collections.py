"""Phase 8: several collections. Membership is explicit (collection 0 "Collection" too); track data stays per item."""

from __future__ import annotations

from fastapi.testclient import TestClient

from bc_tagger_server import importer, membership
from bc_tagger_server.api import create_app
from bc_tagger_server.collection import all_items, other_put, pending_adds, queue_add
from bc_tagger_server.store import Store

from .test_import import recorded_rows, run, svc  # noqa: F401 - the import fixture


def members(store, collection_id) -> dict:
    return {r["item_id"]: r["pos"] for r in store.query(
        "SELECT item_id, pos FROM collection_items WHERE collection_id = ? ORDER BY pos, item_id", (collection_id,))}


def listed(client, **params) -> list[str]:
    return [i["id"] for i in client.get("/api/items", params=params).json()]


def test_the_migration_puts_every_item_in_collection_0_once(tmp_path):
    store = Store(path=tmp_path / "s.db")
    store.upsert_items({"t1": {"title": "a", "order": 3}, "t2": {"title": "b"}, "t3": {"title": "c", "order": 1}})
    queue_add(store, item={"id": "t9", "title": "pending", "order": 4})
    other_put(store, {"id": "o1", "title": "other", "order": 2})
    queue_add(store, tags=["new tag"])  # not an item
    with store.tx() as c:  # as a database from before Phase 8
        c.execute("DELETE FROM collection_items")
        c.execute("DELETE FROM collections")
        c.execute("DELETE FROM meta WHERE key = 'collections_v1'")
    before = sorted(it["id"] for it in all_items(store))
    store.close()

    store = Store(path=tmp_path / "s.db")
    try:
        assert [(c["id"], c["name"], c["count"]) for c in membership.all_collections(store)] == [(0, "Collection", 5)]
        assert members(store, 0) == {"t1": 3, "t2": None, "t3": 1, "t9": 4, "o1": 2}  # today's "#"
        assert sorted(members(store, 0)) == before  # every item, once
        rows = store.query("SELECT * FROM collection_items ORDER BY item_id")
        store._migrate_collections()  # again (and at every start): nothing changes
    finally:
        store.close()
    store = Store(path=tmp_path / "s.db")
    try:
        assert [dict(r) for r in store.query("SELECT * FROM collection_items ORDER BY item_id")] == [dict(r) for r in rows]
        assert len(store.query("SELECT * FROM collections")) == 1
    finally:
        store.close()


def test_new_items_from_the_extension_go_into_collection_0(svc):  # noqa: F811
    svc.sync_items({"t100": {"title": "new", "tags": [], "order": 7}}, [], full=False)
    assert members(svc.store, 0)["t100"] == 7
    svc.sync_items({"t100": {"title": "new", "tags": [], "order": 8}}, [], full=False)
    assert members(svc.store, 0)["t100"] == 8  # collection 0's "#" is the item's
    sets = svc.collection_create("Sets")["id"]
    svc.collection_add(sets, ["t100"])
    svc.collection_remove(0, ["t100"])
    svc.sync_items({"t100": {"title": "new", "tags": ["x"], "order": 8}}, [], full=False)
    assert "t100" not in members(svc.store, 0) and "t100" in members(svc.store, sets)  # never auto-added back
    svc.collection_remove(sets, ["t100"])  # in no collection: still an item, shown in All
    svc.sync_items({"t100": {"title": "new", "tags": ["y"], "order": 8}}, [], full=False)
    assert membership.memberships(svc.store, ["t100"]) == {}
    with TestClient(create_app(svc)) as c:
        assert "t100" in listed(c) and c.get("/api/items/t100").json()["collections"] == []
    svc.sync_items({}, ["t100"], full=False)  # deleted in the extension: its memberships go too
    assert svc.store.query_one("SELECT 1 FROM collection_items WHERE item_id = 't100'") is None


def test_an_old_open_batch_imports_into_a_new_collection_only(svc):  # noqa: F811
    batch = run(svc, recorded_rows())  # made before the collection exists
    bid = batch["batch_id"]
    importer.apply_tag_mapping(svc, bid, {}, "create")
    ticked = {r["n"]: (r["checked"], r["tags"]) for r in importer.load_rows(svc.store, bid)}
    before_0 = members(svc.store, 0)
    with TestClient(create_app(svc)) as c:
        sets = c.post("/api/collections", json={"name": "Warehouse sets"}).json()["id"]
        assert c.post(f"/api/import/{bid}/commit", json={"collection_id": 99}).status_code == 400
        result = c.post(f"/api/import/{bid}/commit", json={"collection_id": sets}).json()
        assert result["collection_id"] == sets and result["collection_added"] > 0
        rows = importer.load_rows(svc.store, bid)
        assert {r["n"]: (r["checked"], r["tags"]) for r in rows} == ticked  # ticks and tags carried over
        committed = list(dict.fromkeys(i for _, i in importer._committed_items(rows)))
        in_sets = members(svc.store, sets)
        assert list(in_sets) == committed and list(in_sets.values()) == list(range(1, len(committed) + 1))
        new = [r["commit_info"]["item_id"] for r in rows if r["committed"] in ("pending_add", "other")]
        assert new and not set(new) & set(members(svc.store, 0))  # nothing new in "Collection"
        assert members(svc.store, 0) == before_0
        merged = [r["commit_info"]["item_id"] for r in rows if r["committed"] == "tag_merge"]
        assert merged and all(i in before_0 and i in in_sets for i in merged)  # copied, still in 0 too
        assert listed(c, collection=sets) == committed  # in import order
        assert c.get("/api/import/last-committed").json()["collection_id"] == sets
        # the extension adds the pending items and syncs them back: they stay in the import's collection only
        adds = {a["item"]["id"]: a["item"] for a in pending_adds(svc.store) if "item" in a}
        svc.sync_items({i: {**it, "tags": it["tags"]} for i, it in adds.items()}, [], full=False)
        assert not set(adds) & set(members(svc.store, 0)) and set(adds) <= set(members(svc.store, sets))


def test_import_to_collection_copies_and_remove_takes_out(svc):  # noqa: F811
    ids = sorted(members(svc.store, 0))
    with TestClient(create_app(svc)) as c:
        sets = c.post("/api/collections", json={"name": "Sets"}).json()["id"]
        r = c.post(f"/api/collections/{sets}/items", json={"ids": [ids[1], ids[0], "t404"]}).json()
        assert r == {"added": 2, "already": 0, "unknown": 1}
        assert c.post(f"/api/collections/{sets}/items", json={"ids": ids}).json() == {"added": 0, "already": 2,
                                                                                      "unknown": 0}
        assert listed(c, collection=sets) == [ids[1], ids[0]]  # "#" in the order they were added
        assert listed(c, collection=sets, order="desc") == [ids[0], ids[1]]
        view = c.get(f"/api/items/{ids[0]}").json()
        assert view["collections"] == [0, sets] and view["tags"] == svc.store.get_item(ids[0])["tags"]  # per item
        assert c.get("/api/collections").json()[1]["count"] == 2
        assert c.request("DELETE", f"/api/collections/{sets}/items", json={"ids": [ids[1], "t404"]}).json() == {
            "removed": 1}
        assert listed(c, collection=sets) == [ids[0]] and ids[1] in listed(c, collection=0)  # copies are separate
        assert c.post("/api/collections/99/items", json={"ids": ids}).status_code == 404


def test_deleting_a_collection_keeps_its_items(svc):  # noqa: F811
    other_put(svc.store, {"id": "o5", "title": "only here", "order": 50})
    with TestClient(create_app(svc)) as c:
        sets = c.post("/api/collections", json={"name": "Sets"}).json()["id"]
        c.post(f"/api/collections/{sets}/items", json={"ids": ["o5"]})
        c.request("DELETE", "/api/collections/0/items", json={"ids": ["o5"]})  # only in Sets now
        assert c.delete("/api/collections/0").status_code == 409
        assert c.delete(f"/api/collections/{sets}").json() == {"deleted": sets, "items": 1}
        assert [col["id"] for col in c.get("/api/collections").json()] == [0]
        assert c.get("/api/items", params={"collection": sets}).status_code == 404
        everything = c.get("/api/items").json()
        assert "o5" in [i["id"] for i in everything]  # in no collection, still in All
        assert next(i for i in everything if i["id"] == "o5")["collections"] == []
        assert c.get("/api/items", params={"collection": "x"}).status_code == 422


def test_collections_are_named_renamed_and_ordered(svc):  # noqa: F811
    events = []
    svc.jobs.bus.publish = lambda event, data: events.append((event, data))
    with TestClient(create_app(svc)) as c:
        a = c.post("/api/collections", json={"name": "  Warm   up "}).json()
        assert (a["name"], a["count"], a["pos"]) == ("Warm up", 0, 1)
        b = c.post("/api/collections", json={"name": "Peak"}).json()
        assert c.post("/api/collections", json={"name": "peak"}).status_code == 409  # names are unique, any case
        assert c.post("/api/collections", json={"name": " "}).status_code == 400
        assert c.patch(f"/api/collections/{b['id']}", json={"name": "Warm up"}).status_code == 409
        assert c.patch(f"/api/collections/{b['id']}", json={"pos": 0}).json()["pos"] == 0
        assert c.patch("/api/collections/0", json={"name": "Main"}).json()["name"] == "Main"  # renaming 0 is fine
        assert [col["name"] for col in c.get("/api/collections").json()] == ["Main", "Peak", "Warm up"]
        assert c.patch("/api/collections/99", json={"name": "x"}).status_code == 404
    assert [(d["action"], d["id"]) for e, d in events if e == "collections"] == [
        ("created", a["id"]), ("created", b["id"]), ("reordered", b["id"]), ("renamed", 0)]


def test_all_sorts_by_collection_0_then_when_items_joined(svc):  # noqa: F811
    svc.sync_items({"t1": {"title": "one", "tags": [], "order": 2}, "t2": {"title": "two", "tags": [], "order": 1}},
                   [], full=False)
    sets = svc.collection_create("Sets")["id"]
    other_put(svc.store, {"id": "o7", "title": "elsewhere", "order": 99}, sets)  # an import into Sets
    assert "o7" not in members(svc.store, 0)
    with TestClient(create_app(svc)) as c:
        everything = listed(c)
        assert everything[:2] == ["t2", "t1"]  # collection 0's "#"
        assert everything.index("o7") > everything.index("t1")  # then the rest, by when they joined
        assert listed(c, collection=0)[:2] == ["t2", "t1"] and "o7" not in listed(c, collection=0)
        assert listed(c, collection=sets) == ["o7"]

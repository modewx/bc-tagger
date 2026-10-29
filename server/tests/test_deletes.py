"""The app's Remove from collection and Delete collection: a track either leaves in no collection is deleted (with
``delete_orphans``, after a ``dry_run`` the app shows). Other items go on the server; Bandcamp items are queued for
the extension and tombstoned until it acks, so a sync that still has them brings nothing back."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from bc_tagger_server import indexer, membership
from bc_tagger_server.api import create_app
from bc_tagger_server.collection import other_get, other_put, pending_adds, queue_add

from .test_collections import members, sync, version
from .test_import import svc  # noqa: F401 - the fixture
from .test_no_drive_reads import _file_rec

FIXTURE = ["t3244411361", "t3973705564"]  # the svc fixture's two items, in "Collection"


@pytest.fixture
def app(svc):  # noqa: F811
    """"Collection" (0): t1, t2 (Bandcamp) and o1 (Other). "Sets": t2 and o2 (Other, only there)."""
    events = []
    real = svc.jobs.bus.publish
    svc.jobs.bus.publish = lambda e, d: (events.append((e, d)), real(e, d))
    with TestClient(create_app(svc)) as c:
        sync(c, {"t1": {"title": "One", "artist": "A", "tags": ["must"], "order": 10},
                 "t2": {"title": "Two", "artist": "B", "tags": [], "order": 11}})
        other_put(svc.store, {"id": "o1", "kind": "track", "title": "Other one", "artist": "C", "tags": ["dub"],
                              "order": 12})
        sets = c.post("/api/collections", json={"name": "Sets"}).json()["id"]
        c.post(f"/api/collections/{sets}/items", json={"ids": ["t2"]})
        other_put(svc.store, {"id": "o2", "kind": "track", "title": "Only in Sets", "tags": []}, collection_id=sets)
        c.svc, c.sets, c.events = svc, sets, events
        events.clear()
        yield c


def remove(c, collection_id, ids, **flags) -> dict:
    r = c.request("DELETE", f"/api/collections/{collection_id}/items", json={"ids": ids, **flags})
    assert r.status_code == 200, r.text
    return r.json()


def state(svc) -> dict:
    """Every table a delete could write, to compare around a dry run."""
    tables = ("items", "other_items", "collections", "collection_items", "pending_adds", "pending_deletes",
              "tag_edits", "locate_results", "match_overrides")
    return {t: [tuple(r) for r in svc.store.query(f"SELECT * FROM {t} ORDER BY 1, 2")] for t in tables}


def test_a_dry_run_says_what_the_real_call_does(app):
    svc, v, before = app.svc, version(app), state(app.svc)
    ids = ["t1", "o1", "t2", "t404"]
    dry = remove(app, 0, ids, dry_run=True, delete_orphans=True)
    assert dry == {"would_delete": [{"id": "t1", "title": "One", "artist": "A", "kind": "bandcamp"},
                                    {"id": "o1", "title": "Other one", "artist": "C", "kind": "other"}],
                   "would_remove": 3}
    assert state(svc) == before and version(app) == v and app.events == []  # nothing changed, nothing announced
    assert remove(app, 0, ids, dry_run=True) == dry  # without delete_orphans: the same answer

    real = remove(app, 0, ids, delete_orphans=True)
    delete_id = real["pending_deletes"][0]["delete_id"]
    assert real == {"removed": 3, "deleted": ["t1", "o1"], "deleted_items": ["t1", "o1"],
                    "pending_deletes": [{"delete_id": delete_id, "item_id": "t1"}]}
    assert [d["id"] for d in dry["would_delete"]] == real["deleted"]
    assert app.get("/api/items/t2").json()["collections"] == [app.sets]  # still in Sets: only lost its membership
    assert app.get("/api/items/t1").status_code == app.get("/api/items/o1").status_code == 404
    assert svc.store.get_item("t1") is None and other_get(svc.store, "o1") is None
    assert sorted(i["id"] for i in app.get("/api/items").json()) == sorted(FIXTURE + ["o2", "t2"])
    assert app.get("/api/health").json()["items"] == 3  # the mirror: the fixture's two and t2
    assert [(col["id"], col["count"]) for col in app.get("/api/collections").json()] == [(0, 2), (app.sets, 2)]
    # an item event for each item that changed, and one collections event with the new version
    assert sorted(d["id"] for e, d in app.events if e == "item") == ["o1", "t1", "t2"]
    assert [d for e, d in app.events if e == "collections"] == [
        {"action": "items", "id": 0, "removed": 3, "items_deleted": 2, "version": version(app)}]
    assert version(app) > v
    assert app.request("DELETE", "/api/collections/99/items", json={"ids": ["t2"], "dry_run": True}).status_code == 404


def test_without_delete_orphans_nothing_is_deleted(app):
    assert remove(app, 0, ["t1", "o1"]) == {"removed": 2}
    assert remove(app, app.sets, ["o2"], delete_orphans=False) == {"removed": 1}
    everything = {i["id"]: i for i in app.get("/api/items").json()}
    assert all(everything[i]["collections"] == [] for i in ("t1", "o1", "o2"))  # in no collection, still in All
    assert app.get("/api/tagger/pending-deletes").json() == []
    assert app.delete(f"/api/collections/{app.sets}").json() == {"deleted": app.sets, "items": 1}
    assert app.get("/api/items/t2").json()["collections"] == [0]


def test_other_items_go_with_their_matches_and_bandcamp_items_are_queued(app, tmp_path):
    svc, path = app.svc, str(tmp_path / "found.aiff")
    indexer._flush(svc.store, [_file_rec(path, str(tmp_path))])
    with svc.store.tx() as c:
        for item_id in ("o1", "t1"):
            c.execute("INSERT INTO locate_results(item_id, status, best, candidates, located_at) "
                      "VALUES(?, 'located', ?, '[]', 'x')", (item_id, json.dumps({"path": path})))
            c.execute("INSERT INTO match_overrides(item_id, path, decision, created_at) VALUES(?, ?, 'confirm', 'x')",
                      (item_id, path))
            c.execute("INSERT INTO rb_claims(db_path, tag, content_id, item_id) VALUES('db', 'must', '1', ?)",
                      (item_id,))
    app.post("/api/tag-edits", json={"id": "t1", "tags": ["pool"]})  # not acked by the extension yet
    queue_add(svc.store, item={"id": "t9", "title": "Pending", "artist": "D", "tags": [], "order": 13})
    svc.collection_add(0, ["t9"])  # an import's item the extension hasn't added yet

    r = remove(app, 0, ["o1", "t1", "t9"], delete_orphans=True)
    assert r["deleted"] == ["o1", "t1", "t9"] and [p["item_id"] for p in r["pending_deletes"]] == ["t1", "t9"]
    q = svc.store.query
    assert not q("SELECT 1 FROM locate_results WHERE item_id IN ('o1', 't1')")
    assert not q("SELECT 1 FROM match_overrides WHERE item_id IN ('o1', 't1')")
    assert len(q("SELECT 1 FROM rb_claims")) == 2 and q("SELECT 1 FROM files WHERE path = ?", (path,))  # stay
    # the extension's queues: the pending add and the tag edit are called off, the deletes wait for it
    assert "t9" not in [a["item"]["id"] for a in pending_adds(svc.store) if "item" in a]
    assert app.get("/api/tag-edits/pending").json() == []
    assert app.get("/api/tagger/pending-deletes").json() == r["pending_deletes"]
    kept = {r["item_id"]: json.loads(r["data"]) for r in q("SELECT item_id, data FROM pending_deletes")}
    assert kept["t1"]["tags"] == ["pool"] and kept["t9"]["title"] == "Pending"  # as they were, should they be needed
    assert "t9" not in [i["id"] for i in app.get("/api/items").json()]


def test_delete_collection_deletes_only_the_tracks_that_were_only_there(app):
    sync(app, {"t3": {"title": "Three", "artist": "E", "tags": [], "order": None}},
         membership=[{"op": "add", "collection_id": app.sets, "ids": ["t3"]}])
    app.events.clear()
    assert app.delete("/api/collections/0", params={"dry_run": True}).status_code == 409
    dry = app.delete(f"/api/collections/{app.sets}", params={"dry_run": True}).json()
    assert dry == {"would_delete": [{"id": "o2", "title": "Only in Sets", "artist": None, "kind": "other"},
                                    {"id": "t3", "title": "Three", "artist": "E", "kind": "bandcamp"}],
                   "would_remove": 3}  # t2 is in "Collection" too
    assert [col["id"] for col in app.get("/api/collections").json()] == [0, app.sets] and app.events == []

    r = app.delete(f"/api/collections/{app.sets}", params={"delete_orphans": True}).json()
    assert r == {"deleted": app.sets, "items": 3, "deleted_items": ["o2", "t3"],
                 "pending_deletes": [{"delete_id": r["pending_deletes"][0]["delete_id"], "item_id": "t3"}]}
    assert [col["id"] for col in app.get("/api/collections").json()] == [0]
    assert app.get("/api/items/o2").status_code == app.get("/api/items/t3").status_code == 404
    assert app.get("/api/items/t2").json()["collections"] == [0]
    assert [d for e, d in app.events if e == "collections"] == [
        {"action": "deleted", "id": app.sets, "items_deleted": 2, "version": version(app)}]
    assert sorted(d["id"] for e, d in app.events if e == "item") == ["o2", "t2", "t3"]


def test_a_full_sync_or_a_stale_push_before_the_ack_brings_nothing_back(app):
    svc = app.svc
    snapshot = {i: svc.store.get_item(i) for i in FIXTURE + ["t1", "t2"]}  # the extension's items, t1 included
    [pending] = remove(app, 0, ["t1"], delete_orphans=True)["pending_deletes"]
    v, before = version(app), state(svc)
    app.events.clear()

    full = sync(app, snapshot, full=True)  # sent before the extension applied the delete
    assert (full["ignored"], full["removed"], full["membership"]["auto_added"]) == (["t1"], 0, 0)
    assert state(svc) == before and version(app) == v and app.events == []
    stale = sync(app, {"t1": {**snapshot["t1"], "tags": ["must", "late"]}}, deleted=["t1"],
                 membership=[{"op": "add", "collection_id": app.sets, "ids": ["t1", FIXTURE[0]]},
                             {"op": "remove", "collection_id": 0, "ids": ["t1"]}])
    assert stale["ignored"] == ["t1"] and svc.store.get_item("t1") is None
    assert stale["membership"] == {"added": 1, "removed": 0, "unknown": 0, "auto_added": 0, "skipped": [
        {"index": 0, "op": "add", "collection_id": app.sets, "reason": "deleted", "ids": ["t1"]},
        {"index": 1, "op": "remove", "collection_id": 0, "reason": "deleted", "ids": ["t1"]}]}
    assert membership.memberships(svc.store, ["t1"]) == {} and FIXTURE[0] in members(svc.store, app.sets)
    assert app.get("/api/tagger/pending-deletes").json() == [pending]

    # the extension deletes it too and acks: the tombstone goes, and starring the track again works as for any track
    assert app.post("/api/tagger/pending-deletes/ack", json={"ids": [pending["delete_id"]]}).json() == {"acked": 1}
    assert app.get("/api/tagger/pending-deletes").json() == []
    again = sync(app, {"t1": {"title": "One", "artist": "A", "tags": ["new"], "order": 14}})
    assert again["ignored"] == [] and again["membership"]["auto_added"] == 1
    assert app.get("/api/items/t1").json()["collections"] == [0] and members(svc.store, 0)["t1"] == 14


def test_pending_deletes_are_idempotent(app):
    svc = app.svc
    [pending] = remove(app, 0, ["t1"], delete_orphans=True)["pending_deletes"]
    assert app.get("/api/tagger/pending-deletes").json() == app.get("/api/tagger/pending-deletes").json() == [pending]
    with svc.store.tx() as c:  # back in "Collection" before the ack (behind the server's back): deleted again
        c.execute("INSERT INTO items(id, data, updated_at) VALUES('t1', ?, 'x')", (json.dumps({"title": "One"}),))
        c.execute("INSERT INTO collection_items(collection_id, item_id, pos, added_at) VALUES(0, 't1', 10, 'x')")
    assert remove(app, 0, ["t1"], delete_orphans=True)["pending_deletes"] == [pending]  # the one delete stands
    assert app.get("/api/tagger/pending-deletes").json() == [pending]
    ack = {"ids": [pending["delete_id"], pending["delete_id"], 999]}
    assert app.post("/api/tagger/pending-deletes/ack", json=ack).json() == {"acked": 1}
    assert app.post("/api/tagger/pending-deletes/ack", json=ack).json() == {"acked": 0}
    assert app.get("/api/tagger/pending-deletes").json() == []
    assert remove(app, 0, ["t1"], delete_orphans=True) == {"removed": 0, "deleted": [], "deleted_items": [],
                                                          "pending_deletes": []}  # gone already

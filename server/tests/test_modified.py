"""Phase 6: ``modified_at`` on items (commit, merge, sync, tag edits) and sorting by it."""

from __future__ import annotations

import time

from fastapi.testclient import TestClient

from bc_tagger_server import importer
from bc_tagger_server.api import create_app
from bc_tagger_server.collection import parse_ts, pending_adds

from .test_import import recorded_rows, run, svc  # noqa: F401 (the fixture)


def test_commit_stamps_new_and_merged_items_and_returns_their_ids(svc):  # noqa: F811
    batch = run(svc, recorded_rows())
    importer.apply_tag_mapping(svc, batch["batch_id"], {}, "create")
    result = importer.commit(svc, batch["batch_id"])
    stamp = result["modified_at"]
    ids = result["item_ids"]
    assert set(ids["merged"]) == {"t3244411361", "t3973705564"} and len(ids["added"]) == result["pending_adds"]
    assert len(ids["other_added"]) == result["other_added"] and ids["other_merged"] == []
    assert result["selected"] == ids["added"] + ids["merged"] + ids["other_added"]
    for add in pending_adds(svc.store):
        if "item" in add:
            assert add["item"]["modified_at"] == add["item"]["date_added"] == stamp
    # merged: the mirror item is stamped, also Atacama whose tags didn't change
    assert svc.store.get_item("t3244411361")["modified_at"] == stamp
    assert svc.store.get_item("t3973705564")["modified_at"] == stamp
    _, items = svc.list_items(ids=result["selected"])
    assert {i["id"]: i["modified_at"] for i in items} == {i: stamp for i in result["selected"]}


def test_sync_keeps_or_sets_modified_at(svc):  # noqa: F811
    svc.store.upsert_items({"t1": {"title": "A", "tags": ["must"], "modified_at": "2026-10-20T10:00:00.000Z"}})
    item = {"title": "A", "tags": ["must"]}
    # same tags, no date from the extension: ours stays
    svc.sync_items({"t1": item}, [], full=False)
    assert svc.store.get_item("t1")["modified_at"] == "2026-10-20T10:00:00.000Z"
    # tags changed, no date (or an older one): the server stamps it now
    before = time.time()
    svc.sync_items({"t1": {**item, "tags": ["must", "dub"], "modified_at": "2026-10-01T00:00:00.000Z"}}, [], full=False)
    assert parse_ts(svc.store.get_item("t1")["modified_at"]).timestamp() >= before - 1
    # tags changed with a newer date from the extension: theirs
    svc.sync_items({"t1": {**item, "tags": ["dub"], "modified_at": "2030-01-01T00:00:00.000Z"}}, [], full=False)
    assert svc.store.get_item("t1")["modified_at"] == "2030-01-01T00:00:00.000Z"
    # a new item keeps what the extension sent, or nothing
    svc.sync_items({"t2": {"title": "B", "tags": []}}, [], full=False)
    assert "modified_at" not in svc.store.get_item("t2")


def test_tag_edits_stamp_items(svc):  # noqa: F811
    from bc_tagger_server.collection import other_put

    other_put(svc.store, {"id": "o0123456789", "kind": "track", "artist": "X", "title": "Y", "tags": ["pool"]})
    with TestClient(create_app(svc)) as c:
        r = c.post("/api/tag-edits", json={"id": "t3244411361", "tags": ["must"]}).json()
        assert r["modified_at"] and svc.store.get_item("t3244411361")["modified_at"] == r["modified_at"]
        assert c.get("/api/tag-edits/pending").json()[-1]["modified_at"] == r["modified_at"]
        c.post("/api/tag-edits", json={"id": "o0123456789", "tags": ["pool"]})  # unchanged: no stamp
        assert "modified_at" not in c.get("/api/items/o0123456789").json()
        c.post("/api/tag-edits", json={"id": "o0123456789", "tags": ["pool", "dub"]})
        assert c.get("/api/items/o0123456789").json()["modified_at"]


def test_sort_by_modified_with_undated_items_earliest(svc):  # noqa: F811
    svc.store.upsert_items({
        "t10": {"title": "old", "tags": [], "modified_at": "2026-01-01T00:00:00.000Z"},
        "t11": {"title": "new", "tags": [], "modified_at": "2026-10-26T09:00:00.000Z"},
        "t12": {"title": "never", "tags": []},
    })
    with TestClient(create_app(svc)) as c:
        newest = [i["id"] for i in c.get("/api/items", params={"sort": "modified_at", "ids": "t10,t11,t12"}).json()]
        oldest = [i["id"] for i in c.get("/api/items", params={"sort": "modified_at", "order": "asc",
                                                                "ids": "t10,t11,t12"}).json()]
        assert newest == ["t11", "t10", "t12"] and oldest == ["t12", "t10", "t11"]
        assert c.get("/api/items", params={"sort": "nope"}).status_code == 422

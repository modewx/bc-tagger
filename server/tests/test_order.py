""""#" (``order``): one sequence across Bandcamp items (numbered by the extension) and Other items, with
import commits appending in row order."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from bc_tagger_server import importer
from bc_tagger_server.api import create_app
from bc_tagger_server.collection import max_order, number_other_items, other_get, other_put, pending_adds, queue_add
from bc_tagger_server.service import Service

from .test_import import recorded_rows, run, svc  # noqa: F401 (the fixture)


def test_max_order_counts_every_kind_and_never_goes_below_the_mirror_size(svc):  # noqa: F811
    assert svc.store.count_items() == 2 and max_order(svc.store) == 2  # no numbers yet: the mirror's size
    svc.store.upsert_items({"t1": {"title": "A", "tags": [], "order": 10},
                            "t2": {"title": "B", "tags": [], "order": "50"},  # not an integer: ignored
                            "t3": {"title": "C", "tags": [], "order": True}})
    assert max_order(svc.store) == 10
    queue_add(svc.store, item={"id": "t4", "title": "D", "tags": [], "order": 12})
    assert max_order(svc.store) == 12
    other_put(svc.store, {"id": "o0000000001", "kind": "track", "title": "E", "tags": [], "order": 15})
    assert max_order(svc.store) == 15
    with svc.store.tx() as c:  # acked adds are in the mirror by then (or deleted there): not counted
        c.execute("UPDATE pending_adds SET acked_at = 'x'")
    other_put(svc.store, {"id": "o0000000001", "kind": "track", "title": "E", "tags": [], "order": 0})
    assert max_order(svc.store) == 15  # its "#" is gone, but it still holds 15 in "Collection"
    svc.collection_remove(0, ["o0000000001"])
    assert max_order(svc.store) == 10
    with TestClient(create_app(svc)) as c:
        assert c.get("/api/health").json()["max_order"] == 10


def test_items_sort_by_order_then_unnumbered_newest_first(svc):  # noqa: F811
    svc.store.upsert_items({
        "t20": {"title": "third", "tags": [], "order": 7},
        "t21": {"title": "first", "tags": [], "order": 3},
        "t22": {"title": "tie", "tags": [], "order": 7},
    })
    other_put(svc.store, {"id": "o0000000002", "kind": "track", "title": "second", "tags": [], "order": 5})
    with TestClient(create_app(svc)) as c:
        ids = [i["id"] for i in c.get("/api/items").json()]
        # numbered first; then the two unnumbered mirror items, newest date_added first (as before)
        assert ids == ["t21", "o0000000002", "t20", "t22", "t3973705564", "t3244411361"]
        assert c.get("/api/items", params={"sort": "order"}).json()[0]["order"] == 3
        desc = [i["id"] for i in c.get("/api/items", params={"sort": "order", "order": "desc"}).json()]
        assert desc[:4] == ["t22", "t20", "o0000000002", "t21"]
        some = [i["id"] for i in c.get("/api/items", params={"ids": "t3244411361,t20,o0000000002"}).json()]
        assert some == ["o0000000002", "t20", "t3244411361"]
        dated = [i["id"] for i in c.get("/api/items", params={"sort": "date_added"}).json()]
        assert dated[:2] == ["t3973705564", "t3244411361"]  # the date sorts are unchanged
        assert c.get("/api/items/t21").json()["order"] == 3


def test_sync_keeps_the_extensions_numbers(svc):  # noqa: F811
    svc.sync_items({"t3244411361": {**svc.store.get_item("t3244411361"), "order": 1},
                    "t3973705564": {**svc.store.get_item("t3973705564"), "order": 2}}, [], full=False)
    assert [i["order"] for i in svc.list_items()[1]] == [1, 2]


def test_import_commit_appends_new_items_in_row_order(svc, monkeypatch):  # noqa: F811
    svc.sync_items({"t3244411361": {**svc.store.get_item("t3244411361"), "order": 40}}, [], full=False)
    batch = run(svc, recorded_rows())
    bid = batch["batch_id"]
    importer.apply_tag_mapping(svc, bid, {}, "create")
    real, calls = importer.queue_add, []

    def flaky(store, **kw):  # the import stops at the third new Bandcamp item, then is retried
        calls.append(kw)
        if len(calls) == 3:
            raise OSError("disk full")
        return real(store, **kw)

    monkeypatch.setattr(importer, "queue_add", flaky)
    with pytest.raises(OSError):
        importer.commit(svc, bid)
    monkeypatch.setattr(importer, "queue_add", real)
    result = importer.commit(svc, bid)

    rows = importer.load_rows(svc.store, bid)
    new = [r for r in rows if r["committed"] in ("pending_add", "other")]
    assert [r["commit_info"]["order"] for r in new] == list(range(41, 41 + len(new)))  # row order, no gaps
    adds = {a["item"]["id"]: a["item"] for a in pending_adds(svc.store) if "item" in a}
    for r in new:
        item = adds.get(r["commit_info"]["item_id"]) or other_get(svc.store, r["commit_info"]["item_id"])
        assert item["order"] == r["commit_info"]["order"]
    assert {r["committed"] for r in new} == {"pending_add", "other"}  # one sequence for both kinds
    assert svc.store.get_item("t3244411361")["order"] == 40  # merged: keeps its number
    assert max_order(svc.store) == 40 + len(new)
    log = json.loads((svc.settings.path.parent / "import-logs" / result["log"]).read_text())
    assert [e["order"] for e in log["rows"] if e["outcome"] in ("added_to_tagger", "added_to_other")] == \
        list(range(41, 41 + len(new)))
    # the collection page: the import's new items come last, in import order
    with TestClient(create_app(svc)) as c:
        listed = [i for i in c.get("/api/items").json() if i.get("order")]
        assert [i["order"] for i in listed] == [40] + list(range(41, 41 + len(new)))


def test_other_items_from_before_get_numbers_once(svc):  # noqa: F811
    for oid, added, line in (("o0000000013", "2026-10-02T00:00:00.000Z", 2), ("o0000000011", "2026-10-01T00:00:00.000Z", 9),
                             ("o0000000012", "2026-10-02T00:00:00.000Z", 1)):
        other_put(svc.store, {"id": oid, "kind": "track", "title": oid, "tags": [], "date_added": added, "line": line})
    other_put(svc.store, {"id": "o0000000014", "kind": "track", "title": "numbered", "tags": [], "order": 7})
    Service(settings=svc.settings, store=svc.store, seed=False)  # at startup
    assert [other_get(svc.store, i)["order"] for i in ("o0000000011", "o0000000012", "o0000000013")] == [8, 9, 10]
    assert other_get(svc.store, "o0000000014")["order"] == 7
    assert number_other_items(svc.store) == 0 and other_get(svc.store, "o0000000013")["order"] == 10

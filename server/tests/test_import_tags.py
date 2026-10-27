"""Import rows keep tags that aren't in the tag list yet; a commit creates them before anything uses them."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from bc_tagger_server import importer
from bc_tagger_server.api import create_app
from bc_tagger_server.collection import pending_adds

from .test_import import recorded_rows, row_at, run, svc  # noqa: F401 (the fixture)


def test_rows_keep_new_tags_until_the_commit_creates_them_first(svc):  # noqa: F811
    batch = run(svc, recorded_rows())
    bid = batch["batch_id"]
    with TestClient(create_app(svc)) as c:
        # a row edit, new default tags and the mapping step all keep tags that aren't in the list yet
        elhwah = row_at(batch, 211)
        c.put(f"/api/import/{bid}/rows/{elhwah['n']}", json={"tags": ["muertos", "brandnew", "ritual"]})
        c.put(f"/api/import/{bid}/default-tags", json={"tags": ["must", "fresh"], "all": True})
        c.post(f"/api/import/{bid}/tags", json={"map": {"mourn": ["melancholic"]}, "unmapped": "create"})
        b = c.get(f"/api/import/{bid}").json()
        tags = {r["line"]: r["tags"] for r in b["rows"] if r["line"] != 48}
        assert tags[211] == ["muertos", "brandnew", "ritual", "must", "fresh"]
        assert "fresh" in tags[1] and "melancholic" in tags[181] and "closer" in tags[181]
        assert {"brandnew", "fresh", "muertos", "closer"} <= set(b["new_tags"]) and b["uncreated_tags"] == b["new_tags"]
        assert "melancholic" not in b["new_tags"] and "brandnew" not in svc.store.get_tags()  # not created yet
        result = c.post(f"/api/import/{bid}/commit").json()
    assert {"brandnew", "fresh", "muertos", "closer"} <= set(result["new_tags"])
    assert set(result["new_tags"]) <= set(svc.store.get_tags())
    adds = pending_adds(svc.store)
    # the extension gets the new tags before any item that uses them
    assert "tags" in adds[0] and set(adds[0]["tags"]) == set(result["new_tags"])
    assert all("item" in a for a in adds[1:])
    edits = {e["item_id"]: e["tags"] for e in svc.pending_tag_edits()}
    assert {"brandnew", "fresh"} <= set(edits["t3244411361"])  # the merged item's new tags, now known
    log = json.loads((svc.settings.path.parent / "import-logs" / result["log"]).read_text())
    assert log["batch"]["new_tags"] == result["new_tags"]


def test_ignoring_new_tags_drops_them_only_when_chosen(svc):  # noqa: F811
    batch = run(svc, recorded_rows())
    bid = batch["batch_id"]
    importer.apply_tag_mapping(svc, bid, {}, "ignore")
    rows = {r["line"]: r["tags"] for r in importer.get_batch(svc, bid)["rows"] if r["line"] != 48}
    assert "mourn" not in rows[181] and "closer" not in rows[181]  # the file's unknown tags, as chosen
    importer.update_row(svc, bid, row_at(importer.get_batch(svc, bid), 181)["n"], {"tags": ["later-tag"]})
    assert importer.get_batch(svc, bid)["new_tags"] == ["later-tag"]  # a tag added afterwards stays


def test_an_extension_sync_doesnt_drop_tags_still_queued_for_it(svc):  # noqa: F811
    from bc_tagger_server.collection import ack_adds

    before = svc.store.get_tags()
    assert svc.create_tags(["brandnew"])["created"] == ["brandnew"]
    svc.sync_tags(before)  # the extension's list, from before it got the queued tag
    assert svc.store.get_tags() == before + ["brandnew"]
    ack_adds(svc.store, [a["add_id"] for a in pending_adds(svc.store)])
    svc.sync_tags(before)  # received and then deleted in the extension: gone
    assert svc.store.get_tags() == before

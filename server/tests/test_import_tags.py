"""Import rows keep tags that aren't in the tag list yet, and the batch lists them (``new_tags``)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from bc_tagger_server import importer
from bc_tagger_server.api import create_app

from .test_import import recorded_rows, row_at, run, svc  # noqa: F401 (the fixture)


def test_rows_keep_new_tags_and_the_batch_lists_them(svc):  # noqa: F811
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
        assert "melancholic" not in b["new_tags"]


def test_ignoring_new_tags_drops_them_only_when_chosen(svc):  # noqa: F811
    batch = run(svc, recorded_rows())
    bid = batch["batch_id"]
    importer.apply_tag_mapping(svc, bid, {}, "ignore")
    rows = {r["line"]: r["tags"] for r in importer.get_batch(svc, bid)["rows"] if r["line"] != 48}
    assert "mourn" not in rows[181] and "closer" not in rows[181]  # the file's unknown tags, as chosen
    importer.update_row(svc, bid, row_at(importer.get_batch(svc, bid), 181)["n"], {"tags": ["later-tag"]})
    assert importer.get_batch(svc, bid)["new_tags"] == ["later-tag"]  # a tag added afterwards stays

"""Import logs: a JSON + Markdown file per import commit (also a partial one), and their API."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bc_tagger_server import importer, importlog
from bc_tagger_server.api import create_app
from bc_tagger_server.config import SettingsError, import_log_dir_problem

from .test_import import recorded_rows, row_at, run, svc  # noqa: F401 (the fixture)


def logs_dir(svc):  # noqa: F811
    return svc.settings.path.parent / "import-logs"


def read_log(svc, name):  # noqa: F811
    return json.loads((logs_dir(svc) / name).read_text())


def test_commit_writes_a_json_and_markdown_log(svc):  # noqa: F811
    rows = recorded_rows()
    rows.append({"line": 999, "raw": "Nobody Here - Not Anywhere #mourn #peak", "artist": "Nobody Here",
                 "title": "Not Anywhere", "album": None, "tags": ["mourn", "peak"]})
    batch = run(svc, rows)
    bid = batch["batch_id"]
    importer.apply_tag_mapping(svc, bid, {"mourn": ["melancholic", "ritual"]}, "create")
    importer.update_row(svc, bid, row_at(batch, 85)["n"], {"checked": False})
    result = importer.commit(svc, bid)

    assert re.fullmatch(rf"\d{{4}}-\d\d-\d\d_\d{{6}}_test_{bid}\.json", result["log"])
    assert result["log_md"] == result["log"][:-len(".json")] + ".md" and Path(result["log_dir"]) == logs_dir(svc)
    assert importer.get_batch(svc, bid)["logs"] == [result["log"]]
    assert importer.get_batch(svc, bid)["commit_result"]["log"] == result["log"]
    log = read_log(svc, result["log"])
    assert log["status"] == "complete" and log["error"] is None
    b = log["batch"]
    assert (b["id"], b["name"], b["lookup"], b["lookup_source"], b["default_tags"]) == (bid, "test", "server",
                                                                                        "bandcamp", ["must"])
    assert b["committed_at"] and b["tag_mapping"]["map"] == {"mourn": ["melancholic", "ritual"]}
    assert "peak" in b["new_tags"] and b["stats"]["total"] == len(rows)
    counts = log["counts"]
    assert counts["added_to_tagger"] == result["pending_adds"] and counts["merged"] == result["tag_merges"]
    assert counts["added_to_other"] == result["other_added"] and counts["unchecked"] == result["skipped"] == 1
    assert counts["total"] == len(rows) and counts["not_imported"] == 0 and counts["located"] >= 1

    by_line = {e["line"]: e for e in log["rows"] if e["line"] != 48}
    nobody = by_line[999]
    assert nobody["raw"].startswith("Nobody Here") and nobody["outcome"] == "added_to_other"
    assert nobody["item_id"] in result["item_ids"]["other_added"]
    assert nobody["mapped_tags"] == {"mourn": ["melancholic", "ritual"], "peak": ["peak"]}
    assert nobody["tags"] == ["melancholic", "ritual", "peak"] and nobody["new_tags"] == ["peak"]
    elhwah = by_line[211]  # already tagged in the collection: merged
    assert elhwah["outcome"] == "merged" and elhwah["item_id"] == "t3244411361"
    assert elhwah["tags_before"] == ["must", "industrial"]
    assert elhwah["tags_after"] == ["must", "industrial", "muertos", "dubstep", "ritual"]
    assert elhwah["match"]["via"] == "collection"
    drama = by_line[1]  # untagged: the default tag
    assert drama["tags_from_defaults"] == ["must"] and drama["mapped_tags"] == {}
    assert drama["outcome"] == "added_to_tagger" and drama["item_id"] in result["item_ids"]["added"]
    assert drama["bandcamp_url"].startswith("https://") and drama["match"]["source"]
    astika = by_line[206]
    assert astika["located"]["status"] == "located" and astika["located"]["path"].endswith("01. Astika.aiff")
    assert by_line[85]["outcome"] == "unchecked" and by_line[85]["item_id"] is None
    assert all(e["downloads"] == [] and not e["imported_earlier"] for e in log["rows"])

    md = (logs_dir(svc) / result["log_md"]).read_text()
    assert md.startswith("# Import: test (") and f"Batch `{bid}`" in md
    assert f"| Added to the tagger | {result['pending_adds']} |" in md and "| Unchecked (skipped) | 1 |" in md
    assert "| 999 | Nobody Here – Not Anywhere | added to other (" in md
    assert "merged into an existing item (t3244411361): must, industrial → must, industrial, muertos" in md


def test_a_partial_import_is_logged_and_so_is_the_retry(svc, monkeypatch):  # noqa: F811
    batch = run(svc, recorded_rows())
    bid = batch["batch_id"]
    importer.apply_tag_mapping(svc, bid, {}, "create")
    real, calls = importer.queue_add, []

    def flaky(store, **kw):
        calls.append(kw)
        if len(calls) == 3:
            raise OSError("disk full")
        return real(store, **kw)

    monkeypatch.setattr(importer, "queue_add", flaky)
    with pytest.raises(OSError):
        importer.commit(svc, bid)
    b = importer.get_batch(svc, bid)
    assert b["status"] == "ready" and len(b["logs"]) == 1
    first = read_log(svc, b["logs"][0])
    assert first["status"] == "partial" and first["error"] == "OSError: disk full"
    done = sum(e["outcome"] not in ("not_imported", "unchecked") for e in first["rows"])
    assert first["counts"]["added_to_tagger"] == 2 and first["counts"]["not_imported"] == len(first["rows"]) - done
    md = (logs_dir(svc) / b["logs"][0].replace(".json", ".md")).read_text()
    assert "**The import stopped part way:** OSError: disk full." in md

    monkeypatch.setattr(importer, "queue_add", real)
    result = importer.commit(svc, bid)
    second = read_log(svc, result["log"])
    assert second["status"] == "complete" and second["counts"]["not_imported"] == 0
    assert second["counts"]["imported_earlier"] == done
    assert importer.get_batch(svc, bid)["logs"] == [b["logs"][0], result["log"]]


def test_logs_api(svc, monkeypatch):  # noqa: F811
    first_batch = run(svc, recorded_rows())
    importer.apply_tag_mapping(svc, first_batch["batch_id"], {}, "create")
    first = importer.commit(svc, first_batch["batch_id"])["log"]
    second_batch = run(svc, recorded_rows()[:3])
    importer.apply_tag_mapping(svc, second_batch["batch_id"], {}, "create")
    second = importer.commit(svc, second_batch["batch_id"])
    opened = []
    monkeypatch.setattr(importlog, "_open", opened.append)
    with TestClient(create_app(svc)) as c:
        listing = c.get("/api/import/logs").json()
        assert listing["dir"] == str(logs_dir(svc)) and listing["warning"] is None
        assert [x["name"] for x in listing["logs"]] == [second["log"], first]  # newest first
        newest = listing["logs"][0]
        assert newest["batch_id"] == second_batch["batch_id"] and newest["status"] == "complete"
        assert newest["md"] == second["log_md"] and newest["counts"]["total"] == 3 and newest["logged_at"]
        r = c.get(f"/api/import/logs/{first}")
        assert r.headers["content-type"] == "application/json" and r.json()["batch"]["id"] == first_batch["batch_id"]
        r = c.get(f"/api/import/logs/{second['log_md']}")
        assert r.headers["content-type"].startswith("text/markdown") and r.text.startswith("# Import: test")
        for bad in ("nope.json", "settings.json", "server.db", "x.txt", "..json"):
            assert c.get(f"/api/import/logs/{bad}").status_code == 404, bad
        assert c.post("/api/import/logs/reveal", json={"name": first}).json()["revealed"] == str(logs_dir(svc) / first)
        assert c.post("/api/import/logs/reveal").json()["revealed"] == str(logs_dir(svc))
        assert opened == [["-R", str(logs_dir(svc) / first)], [str(logs_dir(svc))]]
        assert c.post("/api/import/logs/reveal", json={"name": "nope.json"}).status_code == 404
    with TestClient(create_app(svc), client=("192.168.1.5", 50000)) as c:
        assert c.post("/api/import/logs/reveal").status_code == 403
    assert len(opened) == 2


def test_log_folder_is_never_in_a_root_or_on_the_music_drive(svc, tmp_path):  # noqa: F811
    with pytest.raises(SettingsError, match="inside a music root"):
        svc.settings.update({"import_log_dir": str(tmp_path / "music" / "logs")})
    assert import_log_dir_problem(Path("/Volumes/Music Drive/logs"), ["/Volumes/Music Drive/Music"]) == \
        "import_log_dir can't be on the music drive (/Volumes/Music Drive)"
    assert import_log_dir_problem(tmp_path / "elsewhere", [str(tmp_path / "music")]) is None
    custom = tmp_path / "my-logs"
    svc.settings.update({"import_log_dir": str(custom)})
    assert importlog.log_dir(svc) == (custom, None) and custom.is_dir()
    # on a drive that isn't plugged in: the default folder, with the reason
    svc.settings.update({"import_log_dir": "/Volumes/bc-tagger-no-such-drive/logs"})
    folder, warning = importlog.log_dir(svc)
    assert folder == logs_dir(svc) and "not mounted" in warning and str(logs_dir(svc)) in warning
    assert not Path("/Volumes/bc-tagger-no-such-drive").exists()

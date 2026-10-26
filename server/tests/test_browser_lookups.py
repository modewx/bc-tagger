"""Phase 5 item 7: an import's Bandcamp lookups run in the user's browser (the extension), on fixtures:
a fake browser answers the server's pending requests from the recorded responses."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from bc_tagger_server import importer
from bc_tagger_server.api import create_app

from .test_import import FIXTURES, recorded_rows, row_at, svc  # noqa: F401 (the fixture)

RECORDED = {e["key"]: e for e in json.loads((FIXTURES / "bandcamp_recorded.json").read_text())}


def answer(req, text=None, status=None):
    """What the extension posts back for one pending request (from the recordings)."""
    rec = RECORDED.get(req["key"], {"status": 404, "body": ""})
    return {"key": req["key"], "method": req["method"], "url": req["url"], "body": req["body"],
            "status": status or rec["status"], "text": rec["body"] if text is None else text}


def browser_batch(svc):  # noqa: F811
    with svc.store.tx() as c:
        c.execute("DELETE FROM http_cache")  # nothing known yet: everything goes through the browser
    batch = importer.create_batch(svc, {"format": "bc-tagger-import/1", "items": recorded_rows()}, ["must"],
                                  lookup="browser")
    out = importer.run_batch(svc, batch["batch_id"])
    assert out["browser"]["state"] == "waiting" and out["browser"]["pending_count"] > 0
    return batch["batch_id"]


def test_lookups_in_the_browser_resolve_like_the_server(svc):  # noqa: F811
    bid = browser_batch(svc)
    b = importer.get_batch(svc, bid)
    assert b["status"] == "resolving" and b["step"] == "browser" and b["lookup"] == "browser"
    assert row_at(b, 211)["match"]["status"] == "in_collection"  # the collection needs no lookup
    state = importer.browser_state(svc, bid)
    rounds = 0
    while state["state"] == "waiting":
        rounds += 1
        assert state["pending"] and all(p["method"] in ("GET", "POST") and p["rows"] for p in state["pending"])
        state = importer.browser_results(svc, bid, [answer(p) for p in state["pending"]])
        assert state["taken"] >= 1 and state["ignored"] == 0
    assert state["state"] == "done" and rounds >= 2  # e.g. a title-only search after "artist title" found nothing
    job = importer.load_batch(svc.store, bid)["job_id"]
    svc.jobs.wait(job, timeout=30)
    b = importer.get_batch(svc, bid)
    assert b["status"] == "ready" and b["step"] == "mapping"
    assert row_at(b, 13)["match"]["status"] == "accepted" and row_at(b, 13)["source"] == "bandcamp"
    assert row_at(b, 1)["match"]["source"] == "file"  # the file's Bandcamp URL, fetched by the browser too
    assert row_at(b, 206)["located"]["status"] == "located"
    assert b["stats"]["unavailable"] == 0


def test_bot_check_in_the_browser_stops(svc):  # noqa: F811
    bid = browser_batch(svc)
    pending = importer.browser_state(svc, bid)["pending"]
    state = importer.browser_results(svc, bid, [answer(pending[0], text="<html><title>Client Challenge</title></html>",
                                                       status=200)])
    assert state["state"] == "stopped" and state["reason"] == "challenge" and "bot check" in state["error"]
    b = importer.get_batch(svc, bid)
    waiting = [r for r in b["rows"] if r["source"] != "bandcamp"]
    assert waiting and all(r["match"]["status"] == "unavailable" and r["match"]["reason"] == "challenge" for r in waiting)
    assert svc.store.get_meta("bandcamp_challenge") is None  # the user's browser, not the server's lookups
    assert svc.store.query_one("SELECT count(*) AS n FROM http_cache WHERE body LIKE '%Client Challenge%'")["n"] == 0


def test_rate_limit_in_the_browser_pauses_and_resumes(svc):  # noqa: F811
    bid = browser_batch(svc)
    pending = importer.browser_state(svc, bid)["pending"]
    state = importer.browser_results(svc, bid, [answer(pending[0], text="slow down", status=429)])
    assert state["state"] == "paused" and state["error"] == importer.RATE_LIMITED
    assert importer.list_batches(svc)[0]["resumable"] is True
    importer.prepare_job(svc, bid, "resume")
    importer.resume_batch(svc, bid)
    state = importer.browser_state(svc, bid)
    assert state["state"] == "waiting" and state["pending_count"] >= len(pending)


def test_only_asked_requests_are_taken_and_restarts_dont_interrupt(svc):  # noqa: F811
    bid = browser_batch(svc)
    with TestClient(create_app(svc)) as c:
        st = c.get(f"/api/import/{bid}/lookups", params={"limit": 2}).json()
        assert len(st["pending"]) == 2 and st["pending_count"] > 2 and st["state"] == "waiting"
        bogus = {"method": "GET", "url": "https://evil.example/x", "body": None, "status": 200, "text": "<html/>"}
        r = c.post(f"/api/import/{bid}/lookups", json={"results": [bogus]}).json()
        assert r["ignored"] == 1 and r["taken"] == 0
        assert svc.store.query_one("SELECT count(*) AS n FROM http_cache WHERE url LIKE '%evil%'")["n"] == 0
        svc.boot_id = "after-restart"  # the extension drives it: nothing was lost
        assert c.get(f"/api/import/{bid}").json()["status"] == "resolving"
        server = c.post("/api/import", json={"file": {"format": "bc-tagger-import/1", "items": recorded_rows()[:2]}}).json()
        svc.jobs.wait(server["job_id"], timeout=30)
        assert c.get(f"/api/import/{server['batch_id']}/lookups").json()["state"] == "server"
        assert c.post(f"/api/import/{server['batch_id']}/lookups", json={"results": []}).status_code == 400
        assert c.post("/api/import", json={"file": {"format": "bc-tagger-import/1", "items": recorded_rows()},
                                            "lookup": "elsewhere"}).status_code == 422

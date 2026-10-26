"""HTTP API: contract endpoints, jobs, ownership, overrides, streaming, origin checks."""

from __future__ import annotations

import shutil

import pytest
from fastapi.testclient import TestClient

from bc_tagger_server.api import create_app

from .conftest import write_aiff


@pytest.fixture
def lib(tmp_path):
    root = tmp_path / "music"
    a = write_aiff(root / "Expat" / "07 Celebrate Death.aiff", "Celebrate Death", "Visitor", "Expat", 7, seconds=0.5)
    b = write_aiff(root / "Other" / "01 Landing.aiff", "Landing", "Visitor", "Expat", 10)
    return {"root": root, "a": str(a), "b": str(b)}


@pytest.fixture
def client(make_service, lib):
    items = {
        "t1969272616": {"title": "Celebrate Death", "artist": None, "album_title": "Visitor - Expat", "track_num": 7,
                        "tags": ["must", "ebm"], "date_added": "2026-10-26T01:00:00Z", "album_id": "a749839514"},
        "a2170047530": {"title": "Eudæmonia", "artist": "Birds Of Pandæmonium", "album_title": "eud-monia",
                        "track_num": -1, "tags": ["must"], "date_added": "2026-10-26T02:00:00Z"},
        "undefined": {"title": "junk key"},
    }
    svc = make_service(lib["root"], items=items, tags=["must", "ebm"])
    with TestClient(create_app(svc)) as c:
        c.svc = svc
        yield c


def wait(client, job_id):
    job = client.svc.jobs.wait(job_id, timeout=30)
    assert job.status == "done", job.error
    return client.get(f"/api/jobs/{job_id}").json()


def test_health_items_tags(client):
    h = client.get("/api/health").json()
    assert h["ok"] and h["items"] == 3
    r = client.get("/api/items", params={"limit": 1})
    assert r.headers["x-total-count"] == "3"
    first = r.json()[0]
    assert first["id"] == "a2170047530" and first["is_album"]
    assert first["local"]["status"] == "unknown" and first["owned"]["status"] == "unknown"
    assert first["rekordbox"] == {"status": "none", "content_ids": [], "playlists": []}
    assert [i["id"] for i in client.get("/api/items", params={"tag": "ebm"}).json()] == ["t1969272616"]
    assert [i["id"] for i in client.get("/api/items", params={"q": "visitor expat"}).json()] == ["t1969272616"]
    assert client.get("/api/tags").json() == ["must", "ebm"]
    assert client.get("/api/items/nope").status_code == 404


def test_sync_and_tag_edits(client):
    r = client.post("/api/sync/items", json={"items": {"t5": {"title": "New", "tags": ["pool"]}}, "deleted": ["undefined"]})
    assert r.json() == {"upserted": 1, "removed": 1}
    client.post("/api/sync/tags", json={"tags": ["must", "pool"]})
    assert client.get("/api/tags").json() == ["must", "pool"]
    edit = client.post("/api/tag-edits", json={"id": "t5", "tags": ["pool", "dub"]}).json()
    assert client.get("/api/items/t5").json()["tags"] == ["pool", "dub"]
    pending = client.get("/api/tag-edits/pending").json()
    assert [(p["edit_id"], p["item_id"], p["tags"]) for p in pending] == [(edit["edit_id"], "t5", ["pool", "dub"])]
    assert client.post("/api/tag-edits/ack", json={"ids": [edit["edit_id"]]}).json() == {"acked": 1}
    assert client.get("/api/tag-edits/pending").json() == []
    r = client.post("/api/sync/items", json={"items": {"t5": {"title": "New", "tags": []}}, "full": True})
    assert r.json()["removed"] == 2 and client.get("/api/health").json()["items"] == 1


def test_ownership_push(client):
    client.post("/api/ownership", json={"owned_ids": ["a749839514"], "source": "extension", "full": True})
    items = {i["id"]: i for i in client.get("/api/items").json()}
    assert items["t1969272616"]["owned"]["status"] == "owned"  # via its album
    assert items["a2170047530"]["owned"]["status"] == "not_owned"


def test_locate_job_confirm_reject_and_stream(client, lib):
    job = client.post("/api/locate", json={"latest": 5}).json()
    result = wait(client, job["job_id"])["result"]
    assert result["counts"] == {"located": 1, "missing": 1}
    item = client.get("/api/items/t1969272616").json()
    assert item["local"]["status"] == "located" and item["local"]["best"]["path"] == lib["a"]

    r = client.post("/api/matches/t1969272616/reject", json={"path": lib["a"]}).json()
    assert r["item"]["local"]["status"] in ("missing", "candidates")
    r = client.post("/api/matches/t1969272616/confirm", json={"path": lib["b"]}).json()
    assert r["item"]["local"]["best"]["path"] == lib["b"] and r["item"]["local"]["best"]["method"] == "confirmed"

    if not shutil.which("ffmpeg") and not __import__("os").path.exists("/opt/homebrew/bin/ffmpeg"):
        pytest.skip("ffmpeg not installed")
    s = client.get("/api/files/stream", params={"path": lib["a"]}, headers={"Range": "bytes=0-99"})
    assert s.status_code == 206 and s.headers["content-type"] == "audio/flac" and len(s.content) == 100
    assert client.get("/api/files/stream", params={"path": "/etc/passwd"}).status_code == 404


def test_scan_job_and_settings(client):
    assert wait(client, client.post("/api/index/scan").json()["job_id"])["result"]["files"] == 2
    s = client.get("/api/settings").json()
    assert "production" in s["presets"] and s["playlist_folder"] == "bc-tagger"
    assert client.put("/api/settings", json={"playlist_folder": "bct"}).json()["playlist_folder"] == "bct"
    assert client.put("/api/settings", json={"match_threshold": 3}).status_code == 400


def test_foreign_origins_and_hosts_blocked(client):
    assert client.get("/api/health", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.get("/api/health", headers={"Host": "evil.example"}).status_code == 403
    assert client.get("/api/health", headers={"Origin": "http://127.0.0.1:8765"}).status_code == 200
    ok = client.get("/api/health", headers={"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"})
    assert ok.status_code == 200 and ok.headers["access-control-allow-origin"].startswith("chrome-extension://")


def test_download_refuses_unfiltered(client):
    assert client.post("/api/download", json={"filter": "*"}).status_code == 400
    assert client.post("/api/download", json={"filter": "x", "number": 99}).status_code == 400


def test_match_report(client):
    from bc_tagger_server.report import build

    wait(client, client.post("/api/locate", json={}).json()["job_id"])
    text = build(client.svc)
    assert "| located | 1 |" in text and "| missing | 1 |" in text
    assert "Celebrate Death" in text

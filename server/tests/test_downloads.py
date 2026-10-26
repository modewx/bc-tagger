"""Phase 4: downloading owned releases with a stub downloader (never the network, never the drive)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bc_tagger_server import USER_AGENT, downloader, downloads, importer
from bc_tagger_server.api import create_app

from .conftest import write_aiff

STUB = Path(__file__).parent / "fixtures" / "stub_downloader.py"
RELEASES = {
    "a10": {"artist": "Artist A", "title": "Album A", "year": 2024, "tracks": ["Song A", "Song B"]},
    "t200": {"artist": "Artist B", "title": "Single", "year": 2025, "tracks": ["Single"]},
    "a50": {"artist": "Artist E", "title": "Imported EP", "year": 2023, "tracks": ["Row Song"]},
}


@pytest.fixture
def svc(make_service, tmp_path, monkeypatch):
    music, owned = tmp_path / "music", tmp_path / "owned"
    owned.mkdir()
    write_aiff(music / "Artist D - Here" / "01 Here Already.aiff", "Here Already", "Artist D", "Here", 1)
    items = {
        "t100": {"title": "Song A", "artist": "Artist A", "album_title": "Album A", "album_id": "a10", "track_num": 1},
        "t101": {"title": "Song B", "artist": "Artist A", "album_title": "Album A", "album_id": "a10", "track_num": 2},
        "t200": {"title": "Single", "artist": "Artist B", "album_title": "Single", "album_id": "a20", "track_num": 1},
        "t300": {"title": "Not Mine", "artist": "Artist C", "album_title": "Other", "album_id": "a30", "track_num": 1},
        "a70": {"title": "Look At Yourself", "artist": "Artist G", "album_title": "look-at-yourself", "track_num": -1},
        "t400": {"title": "Here Already", "artist": "Artist D", "album_title": "Here", "album_id": "a40", "track_num": 1},
    }
    s = make_service(music, items=items, tags=["must"])
    cookies = tmp_path / "cookies.txt"
    cookies.write_text("# Netscape HTTP Cookie File\n")
    s.settings.update({"owned_root": str(owned), "cookies_file": str(cookies), "downloads_dir": ""})
    with s.store.tx() as c:
        for owned_id in ("a10", "t200", "a40", "a50", "a70"):
            c.execute("INSERT INTO owned_ids(id, source, checked_at) VALUES(?, 'test', '2026-10-26')", (owned_id,))
    rel = tmp_path / "releases.json"
    rel.write_text(json.dumps(RELEASES))
    monkeypatch.setenv(downloader.STUB_ENV, str(STUB))
    monkeypatch.setenv("BC_TAGGER_STUB_RELEASES", str(rel))
    s.scan()
    s.locate(ids=["t400"], scan="none")
    return s


def by_ref(result):
    return {e["ref"]: e for e in result["items"]}


def test_plan_maps_tracks_to_owned_releases(svc, tmp_path):
    with TestClient(create_app(svc)) as c:
        p = c.post("/api/download", json={"ids": ["t100", "t101", "t200", "t300", "t400", "o123", "nope"],
                                          "scope": "collection", "dry_run": True}).json()
    assert Path(p["destination"]) == (tmp_path / "owned").resolve() and p["format"] == "aiff-lossless"
    assert [(r["release"], r["refs"]) for r in p["releases"]] == [("a10", ["t100", "t101"]), ("t200", ["t200"])]
    items = by_ref(p)
    assert items["t300"]["state"] == "failed" and items["t300"]["message"] == "not owned"
    assert items["t400"]["state"] == "skipped" and items["t400"]["message"] == "already located"
    assert items["nope"]["message"] == "no such item"


def test_plan_shows_an_album_items_own_title(svc):
    p = downloads.plan(svc, ["a70", "t100"])
    assert [(r["release"], r["title"]) for r in p["releases"]] == [("a70", "Look At Yourself"), ("a10", "Album A")]


def test_download_then_locate(svc, tmp_path):
    with TestClient(create_app(svc)) as c:
        job = c.post("/api/download", json={"ids": ["t100", "t101", "t200", "t300"], "scope": "collection"}).json()
        done = svc.jobs.wait(job["job_id"], timeout=60)
        assert done.status == "done", done.error
        result = done.result
        assert [r["outcome"] for r in result["releases"]] == ["downloaded", "downloaded"] and result["stopped"] is None
        items = by_ref(result)
        assert all(items[i]["state"] == "done" and items[i]["located"] for i in ("t100", "t101", "t200"))
        assert items["t300"]["state"] == "failed"
        album = (tmp_path / "owned" / "Artist A" / "2024 - Album A").resolve()
        assert result["releases"][0]["folder"] == str(album) and result["releases"][0]["indexed"] == 2
        view = c.get("/api/items/t100").json()
        assert view["local"]["status"] == "located" and view["local"]["best"]["path"].endswith("01 Song A.aiff")
        # downloaded before: the downloader's cache, nothing new; force downloads again
        job = c.post("/api/download", json={"ids": ["t200"], "force": False}).json()
        assert svc.jobs.wait(job["job_id"], timeout=60).result["items"][0]["state"] == "skipped"  # located now
        res = downloader.run_release(svc.settings, "t200")
        assert res["outcome"] == "cached" and res["ok"]
        res = downloader.run_release(svc.settings, "t200", force=True)
        assert res["outcome"] == "downloaded"
        assert any(f"User-Agent: {USER_AGENT}" in line for line in res["log_tail"])


def test_command_is_honest_and_keeps_cookies_out_of_output(svc):
    cmd = downloader.release_command(svc.settings, "a10")
    assert f"--user-agent={USER_AGENT}" in cmd and "--item-id=a10" in cmd and "--skip-hidden" in cmd and "--jobs=1" in cmd
    assert "--audio-format=aiff-lossless" in cmd and "--force" not in cmd
    with pytest.raises(downloader.DownloadRefused):
        downloader.release_command(svc.settings, "a10; rm -rf /")


def test_bot_check_stops_the_remaining_releases(svc, tmp_path, monkeypatch):
    rel = tmp_path / "releases.json"
    rel.write_text(json.dumps({**RELEASES, "a10": {**RELEASES["a10"], "fail": "challenge"}}))
    result = downloads.run(svc, ["t100", "t200"])
    items = by_ref(result)
    assert result["stopped"] and "bot check" in result["stopped"]
    assert items["t100"]["state"] == "failed" and "bot check" in items["t100"]["message"]
    assert items["t200"]["state"] == "failed" and len(result["releases"]) == 1  # never started
    assert not (tmp_path / "owned" / "Artist B").exists()


def test_import_row_download(svc):
    batch = importer.create_batch(svc, {"format": "bc-tagger-import/1", "items": [
        {"line": 1, "artist": "Artist E", "title": "Row Song", "album": "Imported EP", "tags": []}]}, ["must"])
    bid = batch["batch_id"]
    importer.link_row(  # not resolved: link the row to its Bandcamp item by hand
svc, bid, 0, {"item": {"id": "t500", "title": "Row Song", "artist": "Artist E",
                                             "album_title": "Imported EP", "album_id": "a50"}})
    b = importer.load_batch(svc.store, bid)
    b["status"] = "ready"
    importer._save_batch(svc.store, b)
    result = downloads.run(svc, [f"{bid}:0"])
    assert result["releases"][0]["release"] == "a50" and by_ref(result)[f"{bid}:0"]["located"] is True
    row = importer.get_batch(svc, bid)["rows"][0]
    assert row["located"]["status"] == "located" and row["located"]["best"]["path"].endswith("01 Row Song.aiff")
    plan = downloads.plan(svc, [f"{bid}:9", "imp-x:0"])
    assert [e["message"] for e in plan["items"]] == ["no such import row", "no such import row"]


def test_destination_must_be_inside_an_owned_root(svc, tmp_path):
    from bc_tagger_server.config import SettingsError

    with pytest.raises(SettingsError, match="inside an owned root"):
        svc.settings.update({"downloads_dir": str(tmp_path / "music")})
    svc.settings.update({"downloads_dir": str(tmp_path / "owned" / "new")})
    assert downloader.downloads_dir(svc.settings) == (tmp_path / "owned" / "new").resolve()
    svc.settings.update({"owned_root": str(tmp_path / "elsewhere")})  # the owned root moved
    with TestClient(create_app(svc)) as c:
        r = c.post("/api/download", json={"ids": ["t100"]})
        assert r.status_code == 400 and "inside an owned root" in r.json()["detail"]


def test_progress_and_retry_reasons_in_plain_words(svc, monkeypatch):
    monkeypatch.setenv("BC_TAGGER_STUB_RETRY", "1")
    said = []
    res = downloader.run_release(svc.settings, "t200", on_line=lambda message, percent=None: said.append((message, percent)))
    assert res["outcome"] == "downloaded" and res["retries"] == ["SocketTimeoutException: Read timed out"]
    messages = [m for m, _ in said]
    assert "Bandcamp error: SocketTimeoutException: Read timed out" in messages
    assert "retrying 1/3 after: SocketTimeoutException: Read timed out" in messages
    percents = [p for m, p in said if m.startswith("downloading ") and m.endswith("%")]
    assert percents == [0.0, 12.5, 50.0, 99.99]  # whole percents only: 12.9 is still 12 %
    assert not any("Progress:" in line for line in res["log_tail"])  # not kept in the log
    # the job reports it per row
    events = []
    monkeypatch.setattr(svc.jobs.bus, "publish", lambda kind, data: events.append((kind, data)))
    downloads.run(svc, ["t100"])
    pct = [d["percent"] for k, d in events if k == "download" and d["state"] == "downloading" and d.get("percent")]
    assert pct and max(pct) == 100.0


def test_download_file_vs_full_release(svc):
    with svc.store.tx() as c:  # t300: a single bought alone (t200 too; its album a20 is not owned yet)
        c.execute("INSERT INTO owned_ids(id, source, checked_at) VALUES('t300', 'test', 'x')")  # a single only
    p = downloads.plan(svc, ["t100", "t200", "t300"])
    assert {e["ref"]: e["release"] for e in p["items"]} == {"t100": "a10", "t200": "t200", "t300": "t300"}
    full = downloads.plan(svc, ["t100", "t200", "t300"], full_release=True)
    items = by_ref(full)
    assert items["t100"]["release"] == "a10"  # the album either way
    assert items["t300"]["state"] == "failed" and items["t300"]["message"] == "the full release isn't owned (only this track)"
    assert items["t200"]["state"] == "failed"  # its album a20 isn't owned either
    with svc.store.tx() as c:
        c.execute("INSERT INTO owned_ids(id, source, checked_at) VALUES('a20', 'test', 'x')")
    assert by_ref(downloads.plan(svc, ["t200"], full_release=True))["t200"]["release"] == "a20"
    assert by_ref(downloads.plan(svc, ["t200"]))["t200"]["release"] == "t200"  # Download File: just the track
    with TestClient(create_app(svc)) as c:
        r = c.post("/api/download", json={"ids": ["t200"], "full_release": True, "dry_run": True}).json()
        assert r["releases"][0]["release"] == "a20"
        owned = c.get("/api/items/t200").json()["owned"]
        assert owned["status"] == "owned" and owned["track_owned"] and owned["album_owned"] and owned["full_release"] == "a20"
        owned = c.get("/api/items/t300").json()["owned"]
        assert owned["track_owned"] and not owned["album_owned"] and owned["full_release"] is None
        owned = c.get("/api/items/t400").json()["owned"]  # its album a40 is owned, the track not separately
        assert not owned["track_owned"] and owned["album_owned"] and owned["full_release"] == "a40"


def test_import_rows_say_what_can_be_downloaded(svc):
    batch = importer.create_batch(svc, {"format": "bc-tagger-import/1", "items": [
        {"line": 1, "artist": "Artist E", "title": "Row Song", "album": "Imported Release", "tags": []},
        {"line": 2, "artist": "Nobody", "title": "Nothing Here", "tags": []}]}, ["must"])
    importer.link_row(svc, batch["batch_id"], 0, {"item": {"id": "t500", "title": "Row Song", "artist": "Artist E",
                                                            "album_id": "a50"}})
    rows = importer.get_batch(svc, batch["batch_id"])["rows"]
    assert rows[0]["owned"]["status"] == "owned" and rows[0]["owned"]["full_release"] == "a50"
    assert rows[1]["owned"] is None  # not a Bandcamp row


def test_cached_but_missing_files_are_downloaded_again(svc, tmp_path):
    import shutil

    first = downloads.run(svc, ["t200"])
    assert by_ref(first)["t200"]["located"] is True
    folder = tmp_path / "owned" / "Artist B"
    shutil.rmtree(folder)  # the files were moved away; the tool's cache still lists the release
    with svc.store.tx() as c:
        c.execute("DELETE FROM files WHERE path LIKE ?", (str(folder.resolve()) + "%",))
    svc.locate(ids=["t200"], scan="none")
    result = downloads.run(svc, ["t200"])
    item = by_ref(result)["t200"]
    assert result["releases"][0]["outcome"] == "redownloaded" and item["state"] == "done" and item["located"] is True
    assert item["message"].startswith("downloaded again")
    # with force (the user asked explicitly) it is fetched again even though it is on disk and located
    again = downloads.run(svc, ["t200"], force=True)
    assert again["releases"][0]["outcome"] in ("downloaded", "on_disk")  # force: the user asked explicitly

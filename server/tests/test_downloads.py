"""Phase 4: downloading owned releases with a stub downloader (never the network, never the drive)."""

from __future__ import annotations

import json
import os
import time
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
        # previews of what was just downloaded, while it's fresh
        assert set(svc.previews.queued()) >= {str(p) for p in album.glob("*.aiff")} and list(album.glob("*.aiff"))
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
    assert "--audio-format=aiff-lossless" in cmd and "--force" not in cmd and "--preorders" in cmd
    with pytest.raises(downloader.DownloadRefused):
        downloader.release_command(svc.settings, "a10; rm -rf /")


def _more_owned(svc, *ids):
    """Owned tracks bought alone (t601…), each its own release."""
    svc.store.upsert_items({i: {"title": f"Song {i}", "artist": "Artist F", "album_title": f"Song {i}", "track_num": 1}
                            for i in ids})
    with svc.store.tx() as c:
        for i in ids:
            c.execute("INSERT INTO owned_ids(id, source, checked_at) VALUES(?, 'test', '2026-10-26')", (i,))


@pytest.mark.parametrize("fail, said", [("challenge", "bot check"), ("rate_limit", "rate-limiting")])
def test_a_bot_check_mid_run_ends_it_and_fails_the_rest(svc, tmp_path, monkeypatch, fail, said):
    # one release at a time: Single downloads, then Album A meets the bot check (or a 429). The stub carries on
    # after 2 s like a tool that didn't notice, so only the server ending the run keeps the rest from coming.
    svc.settings.update({"download_parallel": 1})
    _more_owned(svc, "t601")
    rel = tmp_path / "releases.json"
    rel.write_text(json.dumps({**RELEASES, "a10": {**RELEASES["a10"], "fail": fail}}))
    args = tmp_path / "args.jsonl"
    monkeypatch.setenv("BC_TAGGER_STUB_ARGS", str(args))
    monkeypatch.setattr(downloads, "BACKOFF_S", 0.01)  # a 429: one pause, then the rest one at a time
    started = time.monotonic()
    result = downloads.run(svc, ["t200", "t100", "a70", "t601"])
    assert time.monotonic() - started < 1.5  # not the stub's 2 s: it was stopped
    items = by_ref(result)
    assert result["stopped"] and said in result["stopped"]
    assert items["t200"]["state"] == "done" and items["t200"]["located"]  # finished before it
    for ref in ("t100", "a70", "t601"):
        assert items[ref]["state"] == "failed" and items[ref]["message"] == result["stopped"], ref
    assert [r["release"] for r in result["releases"]] == ["t200", "a10", "a70", "t601"]
    runs = [json.loads(line) for line in args.read_text().splitlines()]
    if fail == "challenge":
        assert len(runs) == 1  # the bot check: at once, never a second run
    else:  # the first 429 backed off; it came again in the one-at-a-time run
        assert len(runs) == 2 and "--jobs=1" in runs[1]
        assert [a for a in runs[1] if a.startswith("--item-id=")] == ["--item-id=a10", "--item-id=a70", "--item-id=t601"]
    assert not (tmp_path / "owned" / "Artist A").exists() and not (tmp_path / "owned" / "Stub Artist").exists()


def test_a_long_selection_is_one_downloader_run(svc, tmp_path, monkeypatch):
    """14 releases with download_parallel 4: one run (one login, one walk of the collection), every id, --force."""
    ids = [f"t6{n:02d}" for n in range(1, 15)]
    _more_owned(svc, *ids)
    rel = tmp_path / "releases.json"
    rel.write_text(json.dumps({**RELEASES, **{i: {"artist": "Artist F", "title": f"Song {i}", "year": 2026,
                                                  "tracks": [f"Song {i}"]} for i in ids}}))
    args = tmp_path / "args.jsonl"
    monkeypatch.setenv("BC_TAGGER_STUB_ARGS", str(args))
    totals = []

    class Ctx:
        job = type("Job", (), {"id": "download-test"})()

        def progress(self, cur, total, message):
            totals.append((cur, total, message))

    result = downloads.run(svc, ids, ctx=Ctx())
    runs = [json.loads(line) for line in args.read_text().splitlines()]
    assert len(runs) == 1
    assert [a for a in runs[0] if a.startswith("--item-id=")] == [f"--item-id={i}" for i in ids]
    assert "--force" in runs[0] and "--jobs=4" in runs[0]
    assert all(e["state"] == "done" and e["located"] for e in result["items"])
    assert [r["release"] for r in result["releases"]] == ids
    counted = [cur for cur, total, _ in totals if total == 14]
    assert counted == sorted(counted) and set(range(15)) <= set(counted)  # finished releases, one by one
    assert not any(" of 14" in m for _, _, m in totals)  # no "downloading 1–12 of 14" chunks


def test_each_release_is_located_while_the_run_goes_on(svc, tmp_path, monkeypatch):
    svc.settings.update({"download_parallel": 1})
    monkeypatch.setenv("BC_TAGGER_STUB_DELAY", "0.4")  # before writing each release
    album = tmp_path / "owned" / "Artist A"
    real, ended = downloader.run_releases, []

    def timed(*a, **kw):
        try:
            return real(*a, **kw)
        finally:
            ended.append(time.monotonic())

    monkeypatch.setattr(downloader, "run_releases", timed)
    seen = []

    def publish(kind, data):
        if kind == "download" and data["state"] == "done":
            seen.append((data["ref"], data["located"], time.monotonic(), album.exists()))

    monkeypatch.setattr(svc.jobs.bus, "publish", publish)
    downloads.run(svc, ["t200", "t100"])
    single = next(s for s in seen if s[0] == "t200")
    assert single[1] is True and single[2] < ended[0]  # located and done before the run ended
    assert single[3] is False  # Album A wasn't even written yet
    assert {s[0] for s in seen} == {"t200", "t100"}


def test_releases_download_in_parallel_in_one_run(svc, tmp_path, monkeypatch):
    rel = tmp_path / "releases.json"
    rel.write_text(json.dumps({**RELEASES, "a70": {"artist": "Artist G", "title": "Look At Yourself", "year": 2020,
                                                   "tracks": ["Look"]},
                               "t200": {**RELEASES["t200"], "retry_error": "java.lang.Exception: No file to download. "
                                                                           "Server replied HTTP code: 503"}}))
    args = tmp_path / "args.jsonl"
    monkeypatch.setenv("BC_TAGGER_STUB_ARGS", str(args))
    svc.settings.update({"download_timeout_s": 240})
    events, progress = [], []
    monkeypatch.setattr(svc.jobs.bus, "publish", lambda kind, data: events.append((kind, data)))

    class Ctx:
        job = type("Job", (), {"id": "download-test"})()

        def progress(self, cur, total, message):
            progress.append(message)

    result = downloads.run(svc, ["t100", "t200", "a70"], ctx=Ctx())
    runs = [json.loads(line) for line in args.read_text().splitlines()]
    assert len(runs) == 1  # one downloader run for all three
    assert [a for a in runs[0] if a.startswith("--item-id=")] == ["--item-id=a10", "--item-id=t200", "--item-id=a70"]
    assert "--jobs=3" in runs[0] and "--timeout=240000" in runs[0]  # at most one per release (setting: 4)
    assert "--force" in runs[0]  # only what isn't located is queued: the tool's cache mustn't skip it
    assert "--preorders" in runs[0]  # a preorder's tracks that are out now
    assert [r["outcome"] for r in result["releases"]] == ["downloaded"] * 3 and result["stopped"] is None
    assert all(e["state"] == "done" and e["located"] for e in result["items"])
    # each release's own percent, read from the shared "Progresses: [thread] x % || …" line
    pct = {}
    for kind, d in events:
        if kind == "download" and d.get("percent") is not None and d["message"].startswith("downloading "):
            pct.setdefault(d["ref"], []).append(d["percent"])
    assert pct["t100"][:3] == [0.0, 12.5, 50.0] and pct["t200"][:3] == [1.0, 13.5, 51.0]
    assert pct["a70"][:3] == [2.0, 14.5, 52.0]
    # the retry reason, for that release only
    retry = [(d["ref"], d["message"]) for k, d in events if k == "download" and d["message"].startswith("retry")]
    assert retry == [("t200", "retry 1/3: HTTP 503")]
    assert any("Single: retry 1/3: HTTP 503" in m for m in progress)
    assert any(" · " in m and "Album A: downloading" in m for m in progress)  # several at once in the job's line
    assert by_ref(result)["t200"]["message"] == "downloaded (after 1 retry: HTTP 503)"


def test_parallel_output_with_titles_we_cant_tell_apart(svc, tmp_path, monkeypatch):
    """An older tool ("Managing item N/M" without ids), release names in the output that match none of ours:
    every folder written is indexed and each item is checked by locating it."""
    monkeypatch.setenv("BC_TAGGER_STUB_OLD", "1")
    rel = tmp_path / "releases.json"
    rel.write_text(json.dumps({**RELEASES,
                               "t200": {**RELEASES["t200"], "title": "Single (Edit)"},
                               "a10": {**RELEASES["a10"], "title": "Album A (Remastered)", "fail": "error"}}))
    result = downloads.run(svc, ["t200", "t100"])
    outcomes = {r["release"]: r["outcome"] for r in result["releases"]}
    assert outcomes == {"t200": "downloaded", "a10": "failed"}
    assert by_ref(result)["t200"]["located"]
    assert by_ref(result)["t100"]["message"] == ("the download failed: couldn't tell which release failed: "
                                                 "Could not download item: No URL found for item")
    monkeypatch.delenv("BC_TAGGER_STUB_OLD")  # the tool now names each item it manages: no guessing
    result = downloads.run(svc, ["t200", "t100"], force=True)
    assert by_ref(result)["t100"]["message"] == "the download failed: Could not download item: No URL found for item"


def test_download_settings_are_checked(svc):
    from bc_tagger_server.config import SettingsError

    for bad in ({"download_parallel": 0}, {"download_parallel": 9}, {"download_parallel": 2.5},
                {"download_timeout_s": 10}, {"download_timeout_s": "slow"}):
        with pytest.raises(SettingsError):
            svc.settings.update(bad)
    assert svc.settings.get("download_parallel") == 4 and svc.settings.get("download_timeout_s") == 180


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
    assert res["outcome"] == "downloaded" and res["retries"] == ["read timed out"]
    messages = [m for m, _ in said]
    assert "Bandcamp error: read timed out" in messages and "retry 1/3: read timed out" in messages
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


def test_a_release_in_the_tools_cache_still_downloads_in_the_same_run(svc, tmp_path, monkeypatch):
    import shutil

    args = tmp_path / "args.jsonl"
    monkeypatch.setenv("BC_TAGGER_STUB_ARGS", str(args))
    first = downloads.run(svc, ["t200"])
    assert by_ref(first)["t200"]["located"] is True
    folder = tmp_path / "owned" / "Artist B"
    shutil.rmtree(folder)  # the files were moved away; the tool's cache still lists the release
    with svc.store.tx() as c:
        c.execute("DELETE FROM files WHERE path LIKE ?", (str(folder.resolve()) + "%",))
    svc.locate(ids=["t200"], scan="none")
    result = downloads.run(svc, ["t200", "t100"])
    item = by_ref(result)["t200"]
    assert result["releases"][0]["outcome"] == "downloaded" and item["state"] == "done" and item["located"] is True
    assert item["message"] == "downloaded"
    runs = [json.loads(line) for line in args.read_text().splitlines()]
    assert len(runs) == 2 and all("--force" in r for r in runs)  # one run per job, no second "cached" run
    # with force (the user asked explicitly) it is fetched again even though it is on disk and located
    again = downloads.run(svc, ["t200"], force=True)
    assert again["releases"][0]["outcome"] in ("downloaded", "on_disk")  # force: the user asked explicitly


def test_downloads_are_kept_for_the_import_log(svc):
    batch = importer.create_batch(svc, {"format": "bc-tagger-import/1", "source": "dl.json", "items": [
        {"line": 1, "artist": "Artist E", "title": "Row Song", "album": "Imported EP", "tags": []},
        {"line": 2, "artist": "Artist C", "title": "Not Mine", "album": "Other", "tags": []}]}, ["must"])
    bid = batch["batch_id"]
    importer.link_row(svc, bid, 0, {"item": {"id": "t500", "title": "Row Song", "artist": "Artist E",
                                             "album_title": "Imported EP", "album_id": "a50"}})
    b = importer.load_batch(svc.store, bid)
    b["status"] = "ready"
    importer._save_batch(svc.store, b)
    downloads.run(svc, [f"{bid}:0", "t300", "t400"])  # t300 isn't owned; t400 is already located (skipped)
    kept = svc.store.query("SELECT ref, item_id, release, state, message, folder FROM download_log ORDER BY seq")
    assert [(r["ref"], r["state"]) for r in kept] == [(f"{bid}:0", "done"), ("t300", "failed")]
    assert kept[0]["release"] == "a50" and kept[0]["folder"].endswith("2023 - Imported EP")
    result = importer.commit(svc, bid)
    log = json.loads((svc.settings.path.parent / "import-logs" / result["log"]).read_text())
    row = log["rows"][0]
    assert row["outcome"] == "added_to_tagger" and row["item_id"] == "t500"
    assert [(d["ref"], d["release"], d["state"], d["message"]) for d in row["downloads"]] == [
        (f"{bid}:0", "a50", "done", "downloaded")]
    assert row["located"]["status"] == "located" and log["counts"]["downloaded"] == 1
    # the second row is collection item t300: its download from the collection page (since the batch began)
    other = log["rows"][1]
    assert other["outcome"] == "merged" and other["item_id"] == "t300"
    assert [(d["ref"], d["state"], d["message"]) for d in other["downloads"]] == [("t300", "failed", "not owned")]
    assert result["log"].endswith(f"_dl_{bid}.json")


def test_an_import_rows_download_locates_the_collection_items_too(svc):
    """Downloading from an import row (here the full release) also locates the collection's items of that
    release, so the collection shows them at once."""
    svc.store.upsert_items({"t102": {"title": "Song C", "artist": "Artist A", "album_title": "Album A",
                                     "album_id": "a10", "track_num": 3}})
    rel = json.loads(Path(os.environ["BC_TAGGER_STUB_RELEASES"]).read_text())
    rel["a10"]["tracks"] = ["Song A", "Song B", "Song C"]
    Path(os.environ["BC_TAGGER_STUB_RELEASES"]).write_text(json.dumps(rel))
    batch = importer.create_batch(svc, {"format": "bc-tagger-import/1", "items": [
        {"line": 1, "artist": "Artist A", "title": "Song A", "album": "Album A", "tags": []}]}, ["must"])
    bid = batch["batch_id"]
    importer.link_row(svc, bid, 0, {"item": {"id": "t100", "title": "Song A", "artist": "Artist A",
                                             "album_title": "Album A", "album_id": "a10"}})
    b = importer.load_batch(svc.store, bid)
    b["status"] = "ready"
    importer._save_batch(svc.store, b)
    result = downloads.run(svc, [f"{bid}:0"], full_release=True)
    assert result["releases"][0]["release"] == "a10" and by_ref(result)[f"{bid}:0"]["located"]
    for item_id in ("t100", "t101", "t102"):  # the row's item and the rest of the album
        assert svc.get_item_view(item_id)["local"]["status"] == "located", item_id


def test_stub_retry_wait_keeps_the_retry_in_the_jobs_line(svc, tmp_path, monkeypatch):
    rel = tmp_path / "releases.json"
    rel.write_text(json.dumps({**RELEASES, "t200": {**RELEASES["t200"], "retry_wait": 0.3,
                                                    "retry_error": "java.net.SocketTimeoutException: Read timed out"}}))
    seen = []

    class Ctx:
        job = type("Job", (), {"id": "download-test"})()

        def progress(self, cur, total, message):
            seen.append((time.monotonic(), message))

    downloads.run(svc, ["t100", "t200"], ctx=Ctx())
    retry_at = next(t for t, m in seen if "Single: retry 1/3: read timed out" in m and "Album A: downloading" in m)
    after = next(t for t, m in seen if t > retry_at and "Single: downloading" in m)
    assert after - retry_at >= 0.25  # the retry stays on the job's line while the other release downloads


def test_every_failure_says_why(svc, tmp_path, monkeypatch):
    """Each thread's lines belong to the item its "Managing item N/M: <id> (p…)" line names: a download page
    that keeps failing before "Found release", an unexpected exception, and an item nothing more is said about."""
    _more_owned(svc, "t601")
    rel = tmp_path / "releases.json"
    rel.write_text(json.dumps({**RELEASES, "t200": {**RELEASES["t200"], "fail": "page_error"},
                               "a10": {**RELEASES["a10"], "fail": "exception"},
                               "t601": {"artist": "Artist F", "title": "Song t601", "year": 2026, "fail": "silent",
                                        "tracks": ["Song t601"]}}))
    result = downloads.run(svc, ["t200", "t100", "a70", "t601"])
    items = by_ref(result)
    assert items["t200"]["state"] == "failed" and items["t200"]["message"] == (
        "the download failed: Could not download item: Could not perform task after 3 retries "
        "(last: java.lang.NullPointerException: null).")
    assert items["t100"]["message"] == ("the download failed: Could not download item: "
                                        "java.lang.IllegalStateException: something unexpected")
    assert items["t601"]["state"] == "failed"
    assert items["t601"]["message"] == "the downloader didn't report on it; see the download log"
    assert items["a70"]["state"] == "done" and items["a70"]["message"] == "downloaded"
    outcomes = {r["release"]: r["outcome"] for r in result["releases"]}
    assert outcomes == {"t200": "failed", "a10": "failed", "a70": "downloaded", "t601": "unreported"}


def test_a_bot_check_on_a_download_page_ends_the_run(svc, tmp_path, monkeypatch):
    svc.settings.update({"download_parallel": 1})
    rel = tmp_path / "releases.json"
    rel.write_text(json.dumps({**RELEASES, "a10": {**RELEASES["a10"], "fail": "page_challenge"}}))
    started = time.monotonic()
    result = downloads.run(svc, ["t200", "t100", "a70"])
    assert time.monotonic() - started < 1.5  # not the stub's 2 s: it was stopped
    items = by_ref(result)
    assert result["stopped"] == downloads.MESSAGES["challenged"]
    assert items["t200"]["state"] == "done"
    assert items["t100"]["state"] == "failed" and "Client Challenge" in items["t100"]["message"]  # its own line
    assert items["a70"]["state"] == "failed" and items["a70"]["message"] == result["stopped"]
    assert not (tmp_path / "owned" / "Stub Artist").exists()


def test_a_preorder_downloads_what_is_out_now(svc, tmp_path):
    rel = tmp_path / "releases.json"
    rel.write_text(json.dumps({**RELEASES, "a10": {**RELEASES["a10"], "preorder": "2026-10-30", "out": ["Song A"]}}))
    result = downloads.run(svc, ["t100", "t101"])
    items = by_ref(result)
    assert result["releases"][0]["outcome"] == "downloaded" and result["releases"][0]["preorder"] == "2026-10-30"
    assert items["t100"]["state"] == "done" and items["t100"]["located"] is True
    assert items["t100"]["message"] == "a preorder, out 2026-10-30: downloaded"
    assert items["t101"]["state"] == "done" and not items["t101"]["located"]
    assert items["t101"]["message"] == "a preorder, out 2026-10-30: downloaded what's out now; this one isn't out yet"


def test_each_run_keeps_its_output(svc, tmp_path, monkeypatch):
    """The run's output, redacted and without progress lines, in download-logs/<job id>.log (the newest 30)."""
    logs = svc.settings.path.parent / "download-logs"
    logs.mkdir()
    for n in range(35):  # older logs: only the newest are kept
        old = logs / f"download-items-old{n}.log"
        old.write_text("old")
        os.utime(old, (1_000_000 + n, 1_000_000 + n))
    monkeypatch.setenv("BC_TAGGER_STUB_ECHO", "Cookie: identity=SECRET123; session=abc")
    with TestClient(create_app(svc)) as c:
        job = c.post("/api/download", json={"ids": ["t200"]}).json()
        done = svc.jobs.wait(job["job_id"], timeout=60)
        assert done.status == "done", done.error
        path = Path(done.result["log"])
        assert path == logs / f"{job['job_id']}.log"
        text = c.get(f"/api/jobs/{job['job_id']}/log").text
        assert c.get("/api/jobs/download-items-nope/log").status_code == 404
    assert text == path.read_text()
    assert "Managing item 1/1: t200 (p200)" in text and "successfully downloaded" in text
    assert "identity=<redacted>" in text and "SECRET123" not in text and "session=<redacted>" in text
    assert "Progress" not in text  # thousands of those: not kept
    assert "--cookies-file=<cookies file>" in text and str(svc.settings.get("cookies_file")) not in text
    assert text.rstrip().endswith("# exit 0")
    kept = sorted(logs.glob("*.log"))
    assert len(kept) == downloads.KEEP_LOGS and path in kept and not (logs / "download-items-old5.log").exists()


def _limited_job(svc, tmp_path, monkeypatch, fail):
    """download_parallel 2: [Single, Album A] then [Look At Yourself, Song t601]; Album A's download page answers
    429. The stub carries on 5 s after that group, so finishing fast means the server ended the run itself."""
    svc.settings.update({"download_parallel": 2})
    _more_owned(svc, "t601")
    rel = tmp_path / "releases.json"
    rel.write_text(json.dumps({**RELEASES, "a10": {**RELEASES["a10"], "fail": fail},
                               "a70": {"artist": "Artist G", "title": "Look At Yourself", "year": 2020, "tracks": ["Look"]},
                               "t601": {"artist": "Artist F", "title": "Song t601", "year": 2026, "tracks": ["Song t601"]}}))
    args = tmp_path / "args.jsonl"
    monkeypatch.setenv("BC_TAGGER_STUB_ARGS", str(args))
    monkeypatch.setenv("BC_TAGGER_STUB_AFTER_STOP", "5")
    monkeypatch.setattr(downloads, "BACKOFF_S", 0.01)
    events, progress = [], []
    monkeypatch.setattr(svc.jobs.bus, "publish", lambda kind, data: events.append((kind, data)))

    class Ctx:
        job = type("Job", (), {"id": "download-test"})()

        def progress(self, cur, total, message):
            progress.append(message)

    started = time.monotonic()
    result = downloads.run(svc, ["t200", "t100", "a70", "t601"], ctx=Ctx())
    assert time.monotonic() - started < 4  # never waited out the stub's 5 s
    runs = [json.loads(line) for line in args.read_text().splitlines()]
    return result, runs, events, progress


def test_a_first_429_backs_off_then_the_rest_go_one_at_a_time(svc, tmp_path, monkeypatch):
    result, runs, events, progress = _limited_job(svc, tmp_path, monkeypatch, "rate_limit_once")
    assert result["stopped"] is None
    assert all(e["state"] == "done" and e["located"] for e in result["items"]), result["items"]
    assert len(runs) == 2 and "--jobs=2" in runs[0] and "--jobs=1" in runs[1]
    # Single was being downloaded when the 429 came: it finished in the first run; the rest went one at a time
    assert [a for a in runs[1] if a.startswith("--item-id=")] == ["--item-id=a10", "--item-id=a70", "--item-id=t601"]
    assert any(m.startswith("Bandcamp is rate-limiting: letting what's downloading finish") for m in progress)
    waiting = "Bandcamp is rate-limiting: waiting 0.01 s, then one at a time"
    assert waiting in progress
    assert {d["ref"] for k, d in events if k == "download" and d["message"] == waiting} == {"t100", "a70", "t601"}
    log = Path(result["log"]).read_text()  # both runs, one after the other
    assert "Status=429" in log and [ln for ln in log.splitlines() if ln.startswith("# ") and "--jobs=1" in ln]
    assert len([ln for ln in log.splitlines() if ln.startswith("# exit")]) == 2


def test_a_second_429_after_backing_off_ends_the_job(svc, tmp_path, monkeypatch):
    result, runs, events, progress = _limited_job(svc, tmp_path, monkeypatch, "rate_limit_page")
    items = by_ref(result)
    assert result["stopped"] == downloads.MESSAGES["rate_limited"]
    assert items["t200"]["state"] == "done" and items["t200"]["located"]
    for ref in ("t100", "a70", "t601"):
        assert items[ref]["state"] == "failed" and items[ref]["message"] == result["stopped"], ref
    assert len(runs) == 2 and "--jobs=1" in runs[1]
    assert not (tmp_path / "owned" / "Artist G").exists() and not (tmp_path / "owned" / "Artist F").exists()

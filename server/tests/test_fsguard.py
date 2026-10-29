"""Never write onto an unplugged drive: /Volumes/<name> must be mounted, roots must already exist."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bc_tagger_server import downloader
from bc_tagger_server.api import create_app
from bc_tagger_server.fsguard import NotMounted, ensure_dir_under, require_existing_root, require_mounted, volume_root

GONE = Path("/Volumes/bc-tagger-no-such-drive")  # never mounted


def test_volumes_and_mounts(tmp_path):
    assert volume_root("/Volumes/Stationary Backup/Music/Collection") == Path("/Volumes/Stationary Backup")
    assert volume_root(tmp_path) is None and volume_root("/Volumes") is None
    require_mounted(tmp_path)
    require_mounted("/Volumes/Macintosh HD/Users")  # the startup disk's alias
    with pytest.raises(NotMounted, match="music drive not mounted"):
        require_mounted(GONE / "Music" / "Collection")
    assert not GONE.exists()


def test_folders_only_below_an_existing_root(tmp_path):
    root = tmp_path / "Collection"
    with pytest.raises(NotMounted, match="doesn't exist"):
        ensure_dir_under(root / "Artist", root)
    assert not root.exists()  # nothing above the root is ever created
    root.mkdir()
    assert ensure_dir_under(root / "Artist" / "2024 - Album", root).is_dir()
    with pytest.raises(NotMounted, match="isn't inside"):
        ensure_dir_under(tmp_path / "elsewhere", root)
    with pytest.raises(NotMounted, match="music drive not mounted"):
        require_existing_root(GONE / "Music" / "Collection")


def test_no_download_onto_an_unplugged_drive(make_service, tmp_path, monkeypatch):
    svc = make_service(tmp_path / "music", items={"t1": {"title": "Song", "artist": "A", "album_id": "a1"}})
    cookies = tmp_path / "cookies.txt"
    cookies.write_text("x")
    svc.settings.update({"owned_root": str(GONE / "Music" / "Collection"), "cookies_file": str(cookies),
                         "downloads_dir": ""})
    with svc.store.tx() as c:
        c.execute("INSERT INTO owned_ids(id, source, checked_at) VALUES('a1', 'test', 'x')")
    monkeypatch.setenv(downloader.STUB_ENV, str(Path(__file__).parent / "fixtures" / "stub_downloader.py"))
    with TestClient(create_app(svc)) as c:
        for body in ({"ids": ["t1"], "dry_run": True}, {"ids": ["t1"]}):
            r = c.post("/api/download", json=body)
            assert r.status_code == 400 and "music drive not mounted" in r.json()["detail"]
    with pytest.raises(downloader.DownloadRefused, match="music drive not mounted"):
        downloader.run_release(svc.settings, "a1")
    assert not GONE.exists()


def test_drive_unplugged_during_a_download_job(make_service, tmp_path, monkeypatch):
    """The drive goes away after the first release of a run: the run is ended at once (the tool would create
    the folders again, on the internal disk), and the release not yet written fails with the drive's message."""
    import json
    import time

    from bc_tagger_server import downloads

    owned = tmp_path / "owned"
    owned.mkdir()
    svc = make_service(tmp_path / "music", items={
        "t1": {"title": "Song", "artist": "A", "album_id": "a1"}, "t2": {"title": "Other", "artist": "B", "album_id": "a2"}})
    cookies = tmp_path / "cookies.txt"
    cookies.write_text("x")
    svc.settings.update({"owned_root": str(owned), "cookies_file": str(cookies), "downloads_dir": ""})
    with svc.store.tx() as c:
        for i in ("a1", "a2"):
            c.execute("INSERT INTO owned_ids(id, source, checked_at) VALUES(?, 'test', 'x')", (i,))
    releases = tmp_path / "releases.json"
    releases.write_text(json.dumps({"a1": {"artist": "A", "title": "Song", "year": 2024, "tracks": ["Song"]},
                                    "a2": {"artist": "B", "title": "Other", "year": 2024, "tracks": ["Other"]}}))
    monkeypatch.setenv(downloader.STUB_ENV, str(Path(__file__).parent / "fixtures" / "stub_downloader.py"))
    monkeypatch.setenv("BC_TAGGER_STUB_RELEASES", str(releases))
    monkeypatch.setenv("BC_TAGGER_STUB_DELAY", "1.5")  # before writing each release
    monkeypatch.setattr(downloader, "DRIVE_CHECK_S", 0.05)
    svc.settings.update({"download_parallel": 1})  # one release at a time, in one run
    real = downloads._index_folder

    def unplug_after_first(svc_, folder):
        n = real(svc_, folder)
        if owned.exists():
            os.rename(owned, tmp_path / "unplugged")  # the root is gone now
        return n

    monkeypatch.setattr(downloads, "_index_folder", unplug_after_first)
    started = time.monotonic()
    result = downloads.run(svc, ["t1", "t2"])
    assert time.monotonic() - started < 2.8  # the second release's 1.5 s never ran out
    items = {e["ref"]: e for e in result["items"]}
    assert items["t1"]["state"] == "done"
    assert items["t2"]["state"] == "failed" and "not mounted" in items["t2"]["message"]
    assert "not mounted" in result["stopped"]
    assert not owned.exists()  # not re-created


def test_xml_and_rekordbox_writes_refuse_an_unplugged_drive():
    from bc_tagger_server import rbguard
    from bc_tagger_server.xmlexport import write_xml

    with pytest.raises(NotMounted):
        write_xml(None, "bc-tagger", {}, GONE / "rekordbox")
    with pytest.raises(NotMounted):
        rbguard.backup(GONE / "rekordbox" / "master.db")
    assert not GONE.exists()

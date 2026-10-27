"""Phase 2b: quick date-based scans, manual-only full scans, index status, joining scans."""

from __future__ import annotations

import os
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from bc_tagger_server import indexer
from bc_tagger_server.api import create_app
from bc_tagger_server.store import Store

from .conftest import write_aiff

NOW = datetime.now(timezone.utc)


@pytest.fixture(autouse=True)
def no_spotlight(monkeypatch):
    """Tests decide what Spotlight returns; never query the real index."""
    monkeypatch.setattr(indexer, "spotlight_recent", lambda root, cutoff: None)


def _age(path, days):
    t = time.time() - days * 86400
    os.utime(path, (t, t))


@pytest.fixture
def drive(tmp_path):
    """An old release (files and folders 40 days old) and one downloaded today."""
    root = tmp_path / "drive"
    old = write_aiff(root / "Old Artist" / "2020 - Old Record" / "01 Old Song.aiff", "Old Song", "Old Artist", "Old Record", 1)
    for p in (old, old.parent, old.parent.parent, root):
        _age(p, 40)
    new = write_aiff(root / "New Artist" / "2026 - New Record" / "01 New Song.aiff", "New Song", "New Artist", "New Record", 1)
    return {"root": root, "old": str(old), "new": str(new)}


def _paths(store):
    return sorted(r["path"] for r in store.query("SELECT path FROM files"))


def test_quick_scan_indexes_only_files_since_the_cutoff(new_store, drive, tmp_path):
    store = new_store()
    roots = [{"path": str(drive["root"]), "globs": [], "kind": "owned"}]
    stats = indexer.quick_scan(store, roots, NOW - timedelta(days=2))
    assert _paths(store) == [drive["new"]]
    assert stats["roots"][0]["method"] == "walk" and (stats["checked"], stats["read"], stats["added"]) == (1, 1, 1)
    again = indexer.quick_scan(store, roots, NOW - timedelta(days=2))
    assert (again["read"], again["unchanged"]) == (0, 1)


def test_spotlight_results_are_merged_in(new_store, drive, tmp_path, monkeypatch):
    """Spotlight finds files deep inside unchanged folders that the shallow walk can't reach."""
    monkeypatch.setattr(indexer, "spotlight_recent", lambda root, cutoff: [drive["old"], str(root / "notes.txt")])
    store = new_store()
    stats = indexer.quick_scan(store, [{"path": str(drive["root"]), "globs": [], "kind": "owned"}], NOW - timedelta(days=2))
    assert stats["roots"][0]["method"] == "spotlight+walk"
    assert _paths(store) == sorted([drive["old"], drive["new"]])


def test_spotlight_unavailable_falls_back(monkeypatch, tmp_path):
    monkeypatch.undo()  # use the real spotlight_recent, with mdutil/mdfind stubbed
    calls = []

    def fake_run(cmd, **kw):
        calls.append(cmd[0])
        out = "/Volumes/X:\n\tIndexing disabled.\n" if cmd[0] == "mdutil" else ""
        return subprocess.CompletedProcess(cmd, 0, out, "")

    monkeypatch.setattr(indexer.subprocess, "run", fake_run)
    assert indexer.spotlight_recent(tmp_path, NOW) is None and calls == ["mdutil"]

    def failing_mdfind(cmd, **kw):
        if cmd[0] == "mdutil":
            return subprocess.CompletedProcess(cmd, 0, "/:\n\tIndexing enabled. \n", "")
        return subprocess.CompletedProcess(cmd, 1, "", "error")

    monkeypatch.setattr(indexer.subprocess, "run", failing_mdfind)
    assert indexer.spotlight_recent(tmp_path, NOW) is None


def test_unmounted_root_is_skipped(new_store, tmp_path):
    store = new_store()
    stats = indexer.quick_scan(store, [{"path": str(tmp_path / "gone"), "globs": [], "kind": "owned"}], NOW)
    assert stats["roots"][0]["method"] == "skipped (not mounted)" and stats["checked"] == 0


# -- through the service ---------------------------------------------------------------------


@pytest.fixture
def svc(make_service, drive):
    items = {
        "t1": {"title": "New Song", "artist": "New Artist", "album_title": "New Record", "track_num": 1,
               "tags": ["must"], "date_added": NOW.isoformat()},
        "t2": {"title": "Old Song", "artist": "Old Artist", "album_title": "Old Record", "track_num": 1,
               "tags": ["pool"], "date_added": (NOW - timedelta(days=1)).isoformat()},
        "t3": {"title": "No Date", "artist": "X", "album_title": "Y", "track_num": 1, "tags": ["pool"]},
    }
    s = make_service(drive["root"], items=items)
    s.default_scan_mode = "quick"  # the production default
    return s


def test_locate_uses_a_quick_scan_and_never_a_full_one(svc, drive, monkeypatch):
    def no_full(*a, **k):
        raise AssertionError("a full scan ran automatically")

    monkeypatch.setattr(indexer, "scan", no_full)
    result = svc.locate(ids=["t1", "t2"])
    assert result["scan"]["mode"] == "quick" and result["scan"]["added"] == 1
    status = {s["id"]: s["status"] for s in result["items"]}
    assert status == {"t1": "located", "t2": "missing"}  # the old file is invisible to a quick scan
    assert svc.locate(ids=["t3"])["scan"] == {"mode": "quick", "skipped": "the selected items have no tag dates"}
    assert svc.locate(ids=["t1"], scan="none")["scan"] == {"mode": "none"}
    # Stale index / never fully scanned: still no automatic full scan, only hints.
    st = svc.index_status()
    assert st["stale"] and st["next_auto_reason"] == "never_scanned"
    assert svc.export(ids=["t1"], dry_run=True)["scan"]["mode"] == "quick"


def test_manual_full_scan_finds_old_files_and_sets_status(svc, drive, tmp_path, mount_table):
    unplugged = "/Volumes/BctTestUnplugged/soulseek"  # its drive isn't in the mount table
    svc.settings.update({"extra_roots": [{"path": unplugged, "globs": [], "kind": "not_owned"}]})
    result = svc.locate(ids=["t2"], scan="full")
    assert result["scan"]["mode"] == "full" and result["items"][0]["status"] == "located"
    st = svc.index_status()
    assert st["last_scan_at"] and not st["stale"] and st["files"] == 2
    assert unplugged in st["incomplete_roots"]
    hints = {h["path"]: h["code"] for h in st["hints"]}
    assert hints[unplugged] == "root_incomplete" and set(hints.values()) == {"root_incomplete"}
    assert st["next_auto_reason"] == "root_incomplete"
    by_path = {r["path"]: r for r in st["roots"]}
    assert by_path[str(drive["root"])] == {"path": str(drive["root"]), "kind": "not_owned", "mounted": True, "files": 2, "complete": True}
    assert by_path[unplugged]["mounted"] is False and by_path[unplugged]["complete"] is False
    mount_table("/Volumes/BctTestUnplugged")  # the drive is back: still only a hint, now saying so
    assert "mounted now" in next(h for h in svc.index_status()["hints"] if h["path"] == unplugged)["message"]
    svc.settings.update({"full_rescan_hint_days": 0})
    assert "stale" in [h["code"] for h in svc.index_status()["hints"]]


def test_concurrent_full_scans_join(svc, monkeypatch):
    gate = threading.Event()
    real_scan = svc.scan

    def slow_scan(ctx=None):
        gate.wait(5)
        return real_scan(ctx)

    monkeypatch.setattr(svc, "scan", slow_scan)
    job1, joined1 = svc.start_scan()
    job2, joined2 = svc.start_scan()
    assert (joined1, joined2) == (False, True) and job1.id == job2.id
    assert svc.index_status()["scanning"]["job_id"] == job1.id
    gate.set()
    assert svc.jobs.wait(job1.id, timeout=10).status == "done"
    job3, joined3 = svc.start_scan()
    assert not joined3 and job3.id != job1.id
    svc.jobs.wait(job3.id, timeout=10)


def test_api_and_events(svc, drive):
    events = []
    real_publish = svc.jobs.bus.publish
    svc.jobs.bus.publish = lambda event, data: (events.append((event, data)), real_publish(event, data))
    with TestClient(create_app(svc)) as c:
        job = c.post("/api/locate", json={"ids": ["t1"]}).json()["job_id"]
        result = svc.jobs.wait(job, timeout=10).result
        assert result["scan"]["mode"] == "quick" and result["scan"]["cutoff"]
        assert c.post("/api/locate", json={"ids": ["t1"], "scan": "bogus"}).status_code == 422
        r = c.post("/api/index/scan").json()
        assert set(r) == {"job_id", "joined"}
        svc.jobs.wait(r["job_id"], timeout=10)
        st = c.get("/api/index/status").json()
        assert {"last_scan_at", "files", "roots", "incomplete_roots", "stale", "scanning", "next_auto_reason",
                "hints", "last_quick_scan", "quick_scan_margin_days", "full_rescan_hint_days"} <= set(st)
    index_events = [(d["phase"], d["kind"]) for e, d in events if e == "index"]
    assert ("started", "quick") in index_events and ("finished", "quick") in index_events
    assert ("started", "full") in index_events and ("finished", "full") in index_events

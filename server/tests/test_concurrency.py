"""A stalled request names its cause; reads never wait for writes; the mount table is read without waiting."""

from __future__ import annotations

import logging
import re
import subprocess
import sys
import threading
import time

import pytest
from fastapi.testclient import TestClient

from bc_tagger_server import fsguard, importer, reqlog
from bc_tagger_server.api import create_app


def test_reads_do_not_wait_for_a_write(new_store):
    store = new_store()
    store.set_meta("k", 1)
    inside, release, seen = threading.Event(), threading.Event(), []

    def writer():
        with store.tx() as c:
            c.execute("UPDATE meta SET value = '2' WHERE key = 'k'")
            seen.append(store.get_meta("k"))  # inside its transaction a thread reads its own write
            inside.set()
            release.wait(10)

    t = threading.Thread(target=writer)
    t.start()
    assert inside.wait(10)
    start = time.monotonic()
    assert store.get_meta("k") == 1  # the last committed value, without waiting for the write to end
    assert time.monotonic() - start < 1
    release.set()
    t.join()
    assert seen == [2] and store.get_meta("k") == 2


def test_import_row_writes_bump_the_version(new_store):
    store = new_store()
    assert store.version("import_rows") == 0
    importer._save_rows(store, "b1", [{"n": 1}, {"n": 2}])
    importer._save_rows(store, "b1", [{"n": 1, "title": "x"}])
    with store.tx() as c:
        c.execute("DELETE FROM import_rows WHERE batch_id = 'b1'")
    assert store.version("import_rows") == 5  # two inserts, one update, two deletes


def test_a_stalled_request_names_its_threads(make_service, tmp_path, monkeypatch, caplog):
    svc = make_service(tmp_path / "lib")
    entered, gate, statuses = threading.Event(), threading.Event(), []

    def stalled_build_id():
        entered.set()
        gate.wait(10)
        return "x"

    app = create_app(svc)
    monkeypatch.setattr(svc, "build_id", stalled_build_id)
    monkeypatch.setattr(reqlog, "_last_dump", 0.0)
    caplog.set_level(logging.INFO, logger="bc_tagger_server.requests")
    with TestClient(app) as c:
        t = threading.Thread(target=lambda: statuses.append(c.get("/api/dev/build-id").status_code))
        t.start()
        assert entered.wait(10)
        later = time.monotonic() + reqlog.SLOW_AFTER_S + 1
        dump = reqlog.check(now=later)
        assert reqlog.check(now=later + reqlog.DUMP_EVERY_S + 1) is None  # each slow request is reported once
        gate.set()
        t.join()
    assert statuses == [200]
    assert "GET /api/dev/build-id" in dump and "store lock: <unlocked" in dump
    assert "in stalled_build_id" in dump  # the stalled thread's stack
    lines = [r.getMessage() for r in caplog.records if r.name == "bc_tagger_server.requests"]
    assert any(re.search(r"GET /api/dev/build-id 200 \d+\.\d{3}s 1\dB \(started \d\d:\d\d:\d\d\.\d{3}\)", m) for m in lines)


@pytest.mark.skipif(sys.platform != "darwin", reason="getfsstat is the macOS mount table")
def test_getfsstat_lists_what_mount_lists():
    out = subprocess.run(["/sbin/mount"], capture_output=True, text=True, timeout=10).stdout
    assert fsguard._getfsstat_mount_points() == fsguard.parse_mount_output(out)

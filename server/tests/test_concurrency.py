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


def test_open_streams_are_not_stalls(monkeypatch):
    """An event or audio stream starts its response at once and stays open: never reported."""
    stream = {"start": 0.0, "method": "GET", "path": "/api/events", "reported": False, "extra": None,
              "responding": True}
    monkeypatch.setattr(reqlog, "_running", {1: stream})
    monkeypatch.setattr(reqlog, "_last_dump", 0.0)
    assert reqlog.check(now=600.0) is None
    stuck = {**stream, "path": "/api/items", "responding": False}
    monkeypatch.setattr(reqlog, "_running", {1: stream, 2: stuck})
    dump = reqlog.check(now=600.0)
    assert "slow requests: 1 over" in dump and "/api/events (responding)" in dump


@pytest.mark.skipif(sys.platform != "darwin", reason="getfsstat is the macOS mount table")
def test_getfsstat_lists_what_mount_lists():
    out = subprocess.run(["/sbin/mount"], capture_output=True, text=True, timeout=10).stdout
    assert fsguard._getfsstat_mount_points() == fsguard.parse_mount_output(out)


def _burst_service(make_service, tmp_path):
    """An item list as big as the user's: 1,000 items, 4,500 owned ids, 1,000 locate results."""
    from bc_tagger_server.store import now_iso

    items = {f"t{i}": {"title": f"Song {i}", "artist": f"Artist {i}", "tags": ["pool"],
                       "date_added": f"2026-10-{1 + i % 28:02d}T00:00:00Z"} for i in range(1000)}
    svc = make_service(tmp_path / "lib", items=items)
    svc.set_ownership([f"t{i}" for i in range(0, 1000, 2)] + [f"a{i}" for i in range(4000)], "extension", full=True)
    with svc.store.tx() as c:
        c.executemany("INSERT INTO locate_results(item_id, status, best, candidates, located_at) VALUES(?, ?, ?, ?, ?)",
                      [(f"t{i}", "missing", None, "[]", now_iso()) for i in range(1000)])
    return svc


def _busy_link_candidates(svc, payload, limit=5):
    """A fresh page item: about 40 ms of scoring in Python."""
    end = time.perf_counter() + 0.04
    while time.perf_counter() < end:
        pass
    return [{"n": 1, "title": (payload.get("item") or {}).get("title")}]


def test_item_loads_stay_fast_during_a_link_candidates_burst(make_service, tmp_path, monkeypatch):
    svc = _burst_service(make_service, tmp_path)
    monkeypatch.setattr(importer, "link_candidates", _busy_link_candidates)
    medians = []
    with TestClient(create_app(svc)) as c:
        assert len(c.get("/api/items").json()) == 1000

        def attempt(n: int) -> list[float]:
            took, lock = [], threading.Lock()

            def load():
                start = time.monotonic()
                assert c.get("/api/items").status_code == 200
                with lock:
                    took.append(time.monotonic() - start)

            burst = [threading.Thread(target=c.post, args=("/api/import/link-candidates",),
                                      kwargs={"json": {"item": {"title": f"Page item {n}.{i}"}}}) for i in range(40)]
            for t in burst:
                t.start()
            time.sleep(0.1)  # the burst is running: 2 at a time, 40 ms each
            tabs = [threading.Thread(target=load) for _ in range(5)]
            for t in tabs:
                t.start()
            for t in tabs + burst:
                t.join()
            assert len(took) == 5
            return sorted(took)

        # The median of five loads, best of up to three bursts: the machine may be busy with other work (the user's
        # rekordbox; load averages of 13 were seen). Row-by-row reads took 0.92-0.95 s on every load of every burst.
        for n in range(3):
            took = attempt(n)
            medians.append(took[2])
            if took[2] < 0.5:
                break
    assert min(medians) < 0.5, medians


def test_link_candidates_batch_form_and_coalescing(make_service, tmp_path, monkeypatch):
    svc = make_service(tmp_path / "lib")
    calls, entered, gate = [], threading.Event(), threading.Event()

    def counted(svc_, payload, limit=5):
        calls.append(payload)
        entered.set()
        gate.wait(10)
        return [{"n": len(calls), "title": (payload.get("item") or {}).get("title")}]

    monkeypatch.setattr(importer, "link_candidates", counted)
    with TestClient(create_app(svc)) as c:
        # two identical requests in flight: computed once, both answered
        same = {"item": {"title": "Resent"}, "page_url": "https://x.bandcamp.com/track/resent"}
        answers = []

        def ask():
            answers.append(c.post("/api/import/link-candidates", json=same).json())

        first = threading.Thread(target=ask)
        first.start()
        assert entered.wait(10)
        second = threading.Thread(target=ask)
        second.start()
        time.sleep(0.3)
        gate.set()
        first.join()
        second.join()
        assert len(calls) == 1 and answers == [[{"n": 1, "title": "Resent"}]] * 2
        # one request for a page's items: results in the order sent
        calls.clear()
        r = c.post("/api/import/link-candidates", json={"items": [{"item": {"title": "A"}}, {"item": {"title": "B"}},
                                                                   {"item": {"title": "A"}}]})
        assert r.status_code == 200
        assert [[x["title"] for x in res] for res in r.json()["results"]] == [["A"], ["B"], ["A"]]
        assert c.post("/api/import/link-candidates", json={"items": [], "item": {"title": "A"}}).status_code == 400
        assert c.post("/api/import/link-candidates", json={"items": []}).json() == {"results": []}

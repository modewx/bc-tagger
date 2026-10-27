"""Opus previews: made only by work the user started, played instead of the original, kept to their cap."""

from __future__ import annotations

import builtins
import json
import os
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bc_tagger_server import indexer, previews, stream
from bc_tagger_server.api import create_app
from bc_tagger_server.store import now_iso

from .test_no_drive_reads import DRIVE, _file_rec, no_stat_under
from .test_stream import FFMPEG, decode, make_aiff, needs_ffmpeg, no_open

pytestmark = needs_ffmpeg


@pytest.fixture(autouse=True)
def _plenty_of_space(monkeypatch):
    """The free-space guard is tested on its own; elsewhere this machine's free space mustn't matter."""
    monkeypatch.setattr(previews.Previews, "_free_bytes", lambda self: 10**12)


@pytest.fixture
def lib(make_service, tmp_path):
    """A service over ``tmp_path/music``; ``add(name, seconds, item=…)`` indexes a new 24-bit stereo AIFF and,
    with ``item``, locates that item to it."""
    root = tmp_path / "music"
    root.mkdir()
    svc = make_service(root, items={f"t{i}": {"title": f"Song {i}", "artist": "A", "tags": []} for i in range(1, 6)})

    def add(name: str, seconds: float = 2.0, item: str | None = None) -> str:
        path = make_aiff(root / f"{name}.aiff", "pcm_s24be", 2, seconds)
        indexer.index_file(svc.store, path, svc.settings.roots())
        if item:
            locate(svc, item, {"path": str(path), "format": "aiff"})
        return str(path)

    return svc, root, add


def locate(svc, item_id: str, best: dict) -> None:
    with svc.store.tx() as c:
        c.execute("INSERT OR REPLACE INTO locate_results(item_id, status, best, candidates, located_at) "
                  "VALUES(?, 'located', ?, '[]', ?)", (item_id, json.dumps(best), now_iso()))


def get(client, path: str, rng: str | None = None, **params):
    return client.get("/api/files/stream", params={"path": path, **params},
                      headers={"Range": rng} if rng else {})


def test_a_preview_is_made_served_and_seeks(lib, tmp_path):
    svc, _, add = lib
    src = add("song", seconds=4.0, item="t1")
    assert svc.previews.build(src)["status"] == "built"
    files = list((tmp_path / "data" / "previews").iterdir())
    assert len(files) == 1 and files[0].suffix == ".webm"
    data = files[0].read_bytes()
    assert data[:4] == bytes.fromhex("1a45dfa3") and 0 < data.find(bytes.fromhex("1c53bb6b")) < 1024  # cues first
    probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_name",
                                       "-of", "json", str(files[0])], capture_output=True, text=True).stdout)
    assert probe["streams"][0]["codec_name"] == "opus" and float(probe["format"]["duration"]) == pytest.approx(4, abs=0.05)
    status = svc.previews.status()
    assert (status["count"], status["bytes"], status["cap_bytes"]) == (1, len(data), 3 * 1024**3)
    with TestClient(create_app(svc)) as c:
        r = get(c, src)
        assert r.status_code == 200 and r.headers["content-type"] == "audio/webm"
        assert r.headers["x-bc-source"] == "preview" and r.content == data
        mid = len(data) // 2
        r = get(c, src, f"bytes={mid}-{mid + 999}")
        assert r.status_code == 206 and r.content == data[mid:mid + 1000] and r.headers["x-bc-source"] == "preview"
        view = c.get("/api/items/t1").json()["local"]["best"]
        assert view["preview"] is True and view["duration"] == pytest.approx(4.0)
    # seeking: a decode from 2.5 s gives the last 1.5 s
    tail = subprocess.run([FFMPEG, "-nostdin", "-loglevel", "error", "-ss", "2.5", "-i", str(files[0]), "-f", "s16le",
                           "-ac", "2", "-ar", "48000", "-"], capture_output=True, check=True).stdout
    assert len(tail) / (48000 * 4) == pytest.approx(1.5, abs=0.05)


def test_preview_0_serves_the_original_and_never_queues(lib):
    svc, _, add = lib
    with_preview, without = add("with"), add("without")
    svc.previews.build(with_preview)
    with TestClient(create_app(svc)) as c:
        r = get(c, with_preview, "bytes=0-99", preview=0)
        assert r.status_code == 206 and r.headers["x-bc-source"] == "wav" and r.content[:4] == b"RIFF"
        assert get(c, without, preview=0).content[44:] == decode(Path(without), "s24le")
        assert get(c, without, "bytes=0-99", preview="false").headers["x-bc-source"] == "wav"
        assert svc.previews.queued() == []  # A/B listening builds nothing
        assert get(c, with_preview, "bytes=0-99", preview=1).headers["x-bc-source"] == "preview"
        # the default: the original until there's a preview, which a first play queues
        assert get(c, without, "bytes=0-99").headers["x-bc-source"] == "wav"
        assert get(c, without, "bytes=100-199").headers["x-bc-source"] == "wav"
        assert svc.previews.queued() == [without]  # once
        assert [r["status"] for r in svc.previews.run_pending()] == ["built"]
        assert get(c, without, "bytes=0-99").headers["x-bc-source"] == "preview"


def test_a_play_stays_on_what_it_started_on(lib):
    """A first play makes a preview a moment later; the rest of that play must still get the original's bytes."""
    svc, _, add = lib
    src = add("song", seconds=1.0)
    with TestClient(create_app(svc)) as c:
        whole = get(c, src, preview=0).content
        assert get(c, src, "bytes=0-").headers["x-bc-source"] == "wav"  # the play starts
        assert [r["status"] for r in svc.previews.run_pending()] == ["built"]  # its preview, meanwhile
        r = get(c, src, "bytes=5000-")
        assert r.headers["x-bc-source"] == "wav" and r.content == whole[5000:]  # the same play goes on
        assert get(c, src).headers["x-bc-source"] == "preview"  # a whole-file fetch isn't a player
        assert get(c, src, "bytes=-100").content == whole[-100:]  # still the play that started on WAV
        assert get(c, src, "bytes=0-").headers["x-bc-source"] == "preview"  # the next play
        preview = get(c, src).content
        r = get(c, src, "bytes=100-")
        assert r.headers["x-bc-source"] == "preview" and r.content == preview[100:]


def test_the_least_recently_played_go_at_the_cap(lib, monkeypatch):
    svc, _, add = lib
    monkeypatch.setattr(previews, "TOUCH_EVERY_S", 0.0)
    a, b, c3 = add("a"), add("b"), add("c")
    svc.previews.build(a)
    svc.previews.build(b)
    size = svc.previews.status()["bytes"] // 2
    time.sleep(0.01)
    svc.previews.touch(a)  # played after b was made
    svc.settings.update({"preview_cache_gb": 2.5 * size / 1024**3})
    assert svc.previews.build(c3)["status"] == "built"
    kept = [r["path"] for r in svc.store.query("SELECT path FROM previews ORDER BY path")]
    assert kept == [a, c3]
    names = {r["file"] for r in svc.store.query("SELECT file FROM previews")}
    assert {f.name for f in previews.previews_dir().iterdir()} == names
    with TestClient(create_app(svc)) as client:  # a smaller cap drops the least recently played at once
        client.put("/api/settings", json={"preview_cache_gb": 1.5 * size / 1024**3})
        assert [r["path"] for r in svc.store.query("SELECT path FROM previews")] == [c3]
        assert len(list(previews.previews_dir().iterdir())) == 1
        before = client.get("/api/previews/status").json()["bytes"]
        assert client.delete("/api/previews").json() == {"deleted": 1, "bytes": before}
        assert client.get("/api/previews/status").json()["count"] == 0
        assert list(previews.previews_dir().iterdir()) == []


def test_no_preview_when_the_disk_would_drop_below_2_gb(lib, monkeypatch):
    svc, _, add = lib
    src = add("big", seconds=1.0)
    monkeypatch.setattr(previews.Previews, "_free_bytes", lambda self: previews.MIN_FREE_BYTES + 20_000)
    result = svc.previews.build(src)
    assert result["status"] == "skipped" and result["reason"] == "low_space"
    assert not previews.previews_dir().exists() or list(previews.previews_dir().iterdir()) == []
    status = svc.previews.status()
    assert status["count"] == 0 and status["skipped_low_space"] == 1 and status["last_skip"]["path"] == src
    assert status["min_free_bytes"] == 2 * 1024**3
    monkeypatch.setattr(previews.Previews, "_free_bytes", lambda self: previews.MIN_FREE_BYTES + 10**9)
    assert svc.previews.build(src)["status"] == "built"


def test_a_preview_plays_with_the_drive_unplugged(lib, monkeypatch):
    svc, root, add = lib
    with_preview, without = add("with"), add("without")
    svc.previews.build(with_preview)
    data = next(previews.previews_dir().iterdir()).read_bytes()
    monkeypatch.setattr(stream, "is_mounted", lambda path: False)
    monkeypatch.setattr(stream, "_open_source", no_open)
    with TestClient(create_app(svc)) as c, no_stat_under(monkeypatch, str(root)) as touched:
        r = get(c, with_preview, "bytes=0-")
        assert r.status_code == 206 and r.headers["x-bc-source"] == "preview" and r.content == data
        r = get(c, without)
        assert r.status_code == 404 and r.json()["detail"] == "music drive not mounted"
        assert get(c, with_preview, preview=0).status_code == 404  # the original needs the drive
    assert touched == [] and svc.previews.queued() == []


def test_page_loads_do_no_preview_work(make_service, tmp_path, mount_table, monkeypatch):
    collection = f"{DRIVE}/Music/Collection"
    svc = make_service(tmp_path / "unused", items={"t1": {"title": "One", "tags": []}, "a2": {"title": "Two", "tags": []},
                                                    "t3": {"title": "Three", "tags": []}})
    one, two_a, two_b, three = (f"{collection}/{n}.aiff" for n in ("one", "2a", "2b", "three"))
    indexer._flush(svc.store, [_file_rec(p, collection) for p in (one, two_a, two_b, three)])
    with svc.store.tx() as c:  # previews of one and 2a; three's is of an older version of the file
        c.executemany("INSERT INTO previews(path, size, mtime, file, bytes, created_at, played_at) "
                      "VALUES(?, ?, ?, ?, 1000, 0, 0)", [(one, 1, 0.0, "x.webm"), (two_a, 1, 0.0, "y.webm"),
                                                         (three, 1, 5.0, "z.webm")])
    locate(svc, "t1", {"path": one, "format": "aiff"})
    locate(svc, "a2", {"path": f"{collection}", "format": "aiff",
                       "tracks": [{"path": two_a, "format": "aiff"}, {"path": two_b, "format": "aiff"}]})
    locate(svc, "t3", {"path": three, "format": "aiff"})
    mount_table(DRIVE)
    monkeypatch.setattr(previews.subprocess, "Popen", lambda *a, **k: pytest.fail("an encode started"))
    real_open = builtins.open
    monkeypatch.setattr(builtins, "open", lambda f, *a, **k: pytest.fail(f"opened {f}") if
                        isinstance(f, (str, os.PathLike)) and os.fspath(f).startswith(DRIVE) else real_open(f, *a, **k))
    with TestClient(create_app(svc)) as c, no_stat_under(monkeypatch, DRIVE) as touched:
        for path in ("/api/health", "/api/settings", "/api/items", "/api/tags", "/api/jobs", "/api/index/status",
                     "/api/previews/status", "/api/items/t1", "/api/items/a2"):
            assert c.get(path).status_code == 200, path
        items = {i["id"]: i["local"]["best"] for i in c.get("/api/items").json()}
        status = c.get("/api/previews/status").json()
    assert touched == [] and svc.previews.queued() == [] and status["building"] == status["queued"] == 0
    assert status["count"] == 3 and status["bytes"] == 3000
    assert items["t1"]["preview"] is True and items["t3"]["preview"] is False  # made from another version
    assert [t["preview"] for t in items["a2"]["tracks"]] == [True, False] and items["a2"]["preview"] is False


def test_a_build_job_reports_progress_and_can_be_cancelled(lib):
    svc, _, add = lib
    paths = [add(f"s{i}", seconds=0.5, item=f"t{i}") for i in (1, 2, 3)]
    svc.previews.build(paths[0])  # already there
    events = []
    svc.jobs.bus.publish = svc.previews.publish = lambda event, data: events.append((event, data))
    with TestClient(create_app(svc)) as c:
        job_id = c.post("/api/previews/build", json={"ids": ["t1", "t2", "t3", "t4"]}).json()["job_id"]
        assert svc.previews.queued() == paths[1:] and svc.previews.status()["jobs"] == [job_id]
        assert svc.jobs.get(job_id).status == "running"  # alongside other jobs, not on their worker
        svc.previews.run_pending()
        job = svc.jobs.wait(job_id, timeout=10)
        assert job.status == "done" and job.progress["current"] == job.progress["total"] == 2
        assert {k: job.result[k] for k in ("items", "files", "already", "native", "built", "cancelled")} == {
            "items": 4, "files": 3, "already": 1, "native": 0, "built": 2, "cancelled": 0}
        assert [d["progress"]["current"] for e, d in events if e == "job" and d["id"] == job_id][-1] == 2
        assert sorted(d["path"] for e, d in events if e == "preview") == paths[1:]
        # cancelled before anything ran: the queue empties
        more = [add(f"m{i}", seconds=0.5, item=f"t{i}") for i in (4, 5)]
        job_id = c.post("/api/previews/build", json={"ids": ["t4", "t5"]}).json()["job_id"]
        svc.previews.enqueue([more[1]])  # also asked for by something else: stays
        assert c.post(f"/api/previews/build/{job_id}/cancel").json() == {"job_id": job_id, "cancelled": 1}
        job = svc.jobs.wait(job_id, timeout=10)
        assert (job.result["cancelled"], job.result["left"]) == (1, 1) and svc.previews.queued() == [more[1]]
        assert c.post("/api/previews/build/locate-1/cancel").status_code == 404


def test_cancel_stops_a_running_encode(lib, tmp_path, monkeypatch):
    svc, _, add = lib
    src = add("slow", seconds=0.5, item="t1")
    slow = tmp_path / "slow-ffmpeg"
    slow.write_text("#!/bin/sh\nexec sleep 30\n")
    slow.chmod(0o755)
    monkeypatch.setattr(previews, "ffmpeg_bin", lambda: str(slow))
    svc.previews.autostart = True
    job = svc.start_preview_build(["t1"])
    deadline = time.monotonic() + 10
    while svc.previews.status()["building"] == 0 and time.monotonic() < deadline:
        time.sleep(0.02)
    assert svc.previews.status()["building"] == 1
    started = time.monotonic()
    assert svc.cancel_preview_build(job.id)["cancelled"] == 1
    done = svc.jobs.wait(job.id, timeout=10)
    assert done.result["cancelled"] == 1 and time.monotonic() - started < 5
    assert list(previews.previews_dir().iterdir()) == [] and svc.previews.status()["building"] == 0
    svc.previews.close()
    assert Path(src).is_file()

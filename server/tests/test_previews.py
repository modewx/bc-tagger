"""Opus previews: made only by work the user started, played instead of the original, kept to their cap."""

from __future__ import annotations

import builtins
import json
import os
import subprocess
import sys
import threading
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
    svc = make_service(root, items={f"t{i}": {"title": f"Song {i}", "artist": "A", "tags": [], "order": i}
                                    for i in range(1, 13)})

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
    assert (status["count"], status["bytes"], status["cap_bytes"]) == (1, len(data), int(3.5 * 1024**3))
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


def test_src_original_keeps_its_bytes_while_a_preview_appears(lib):
    """The freeze the user hit: a first play's preview was ready mid-play and the same URL changed to it. A URL's
    bytes must never change under a player."""
    svc, _, add = lib
    src = add("song", seconds=2.0)
    with TestClient(create_app(svc)) as c:
        first = get(c, src, "bytes=0-", src="original")
        assert first.headers["x-bc-source"] == "wav" and first.headers["cache-control"] == "no-cache"
        total, etag = int(first.headers["content-range"].rsplit("/", 1)[1]), first.headers["etag"]
        assert svc.previews.queued() == [src]  # a first play queues its preview
        assert [r["status"] for r in svc.previews.run_pending()] == ["built"]
        preview_size = int(get(c, src, src="preview").headers["content-length"])
        svc.previews._plays.clear()  # what a restart forgets: src alone must keep the bytes
        for start in (total // 2, total - 1000, 0):  # seeks, the first two far past the preview's size
            assert start > preview_size or start == 0
            r = get(c, src, f"bytes={start}-", src="original")
            assert r.status_code == 206 and r.headers["content-range"] == f"bytes {start}-{total - 1}/{total}"
            assert r.headers["etag"] == etag and r.content == first.content[start:]
        assert get(c, src, "bytes=0-", src="preview").headers["x-bc-source"] == "preview"  # the next player's


def test_src_preview_never_falls_back_to_the_original(lib):
    svc, _, add = lib
    src = add("song")
    with TestClient(create_app(svc)) as c:
        r = get(c, src, "bytes=0-", src="preview")
        assert r.status_code == 404 and r.json()["detail"] == "no preview of this file"
        assert svc.previews.queued() == []  # asking for a preview doesn't make one
        svc.previews.build(src)
        assert get(c, src, "bytes=0-", src="preview").status_code == 206
        c.delete("/api/previews")
        assert get(c, src, "bytes=100-", src="preview").status_code == 404  # gone: 404, never the WAV
        assert get(c, src, "bytes=100-", src="original").headers["x-bc-source"] == "wav"
        assert c.get("/api/files/stream", params={"path": src, "src": "both"}).status_code == 422
        # preview=0 is src=original that makes no preview (comparing the two)
        assert get(c, src, "bytes=0-", preview=0).headers["x-bc-source"] == "wav" and svc.previews.queued() == [src]
        svc.previews.run_pending()
        assert get(c, src, "bytes=0-", preview=0).headers["x-bc-source"] == "wav"


def test_if_range_for_another_representation_gets_the_whole_current_one(lib):
    svc, root, add = lib
    src = add("song")
    svc.previews.build(src)
    flac = root / "native.flac"
    subprocess.run([FFMPEG, "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=d=0.5", str(flac)], check=True)
    indexer.index_file(svc.store, flac, svc.settings.roots())
    with TestClient(create_app(svc)) as c:
        reps = {"original": get(c, src, src="original"), "preview": get(c, src, src="preview"),
                "native": get(c, str(flac))}
        etags = {k: r.headers["etag"] for k, r in reps.items()}
        assert len(set(etags.values())) == 3 and all(e.startswith('"') for e in etags.values())
        assert {k: r.headers["x-bc-source"] for k, r in reps.items()} == {"original": "wav", "preview": "preview",
                                                                          "native": "native"}
        for kind, whole in reps.items():
            params = {"path": str(flac) if kind == "native" else src} | ({} if kind == "native" else {"src": kind})
            other = etags["preview" if kind != "preview" else "original"]
            r = c.get("/api/files/stream", params=params, headers={"Range": "bytes=100-", "If-Range": other})
            assert r.status_code == 200 and r.content == whole.content, kind  # the whole, never a slice
            r = c.get("/api/files/stream", params=params, headers={"Range": "bytes=100-", "If-Range": etags[kind]})
            assert r.status_code == 206 and r.content == whole.content[100:], kind
            assert r.headers["cache-control"] == "no-cache"


def test_a_preview_being_sent_is_never_dropped(lib, monkeypatch):
    svc, _, add = lib
    a, b = add("a"), add("b")
    svc.previews.build(a)
    time.sleep(0.01)
    svc.previews.build(b)  # a is the least recently played
    calls = []
    for name in ("stream_opened", "stream_closed"):
        real = getattr(svc.previews, name)
        monkeypatch.setattr(svc.previews, name, lambda p, real=real, name=name: (calls.append((name, p)), real(p)))
    with TestClient(create_app(svc)) as c:
        played = []
        for _ in range(2):  # every request bumps it
            get(c, b, "bytes=0-", src="preview")
            played.append(svc.store.query_one("SELECT played_at FROM previews WHERE path = ?", (b,))["played_at"])
            time.sleep(0.01)
    assert played[1] > played[0] and calls == [("stream_opened", b), ("stream_closed", b)] * 2
    svc.previews.stream_opened(a)  # a player is reading a
    svc.settings.update({"preview_cache_gb": 1e-9})
    assert svc.previews.prune() == [b]  # not a, though it's the least recently played
    svc.previews.stream_closed(a)
    assert svc.previews.prune() == [a]


def test_preview_defaults_and_the_old_default_moving_to_3_5(tmp_path):
    from bc_tagger_server.config import Settings, SettingsError

    fresh = Settings(path=tmp_path / "a" / "settings.json")
    assert (fresh.get("preview_cache_gb"), fresh.get("preview_bitrate_kbps")) == (3.5, 96)
    old = tmp_path / "b" / "settings.json"
    old.parent.mkdir()
    old.write_text(json.dumps({"preview_cache_gb": 3, "settings_version": 2}))  # the old default, written out
    assert Settings(path=old).get("preview_cache_gb") == 3.5
    old.write_text(json.dumps({"preview_cache_gb": 3, "settings_version": 3}))  # chosen since: kept
    assert Settings(path=old).get("preview_cache_gb") == 3
    with pytest.raises(SettingsError):
        fresh.update({"preview_bitrate_kbps": 8})



FAKE_FFMPEG = """#!{python}
# Stands in for ffmpeg in build tests: logs when it ran and how it got its input; fails on a file marked BADFILE.
import json, os, sys, time
args = sys.argv[1:]
start = time.time()
source = args[args.index("-i") + 1]
data = sys.stdin.buffer.read() if source == "pipe:0" else open(source, "rb").read()
time.sleep(float(os.environ.get("FAKE_FFMPEG_S", "0.3")))
with open(os.environ["FAKE_FFMPEG_LOG"], "a") as log:
    log.write(json.dumps({{"start": start, "end": time.time(), "source": source, "bytes": len(data)}}) + "\\n")
if b"BADFILE" in data:
    sys.stderr.write("Invalid data found when processing input")
    sys.exit(1)
open(args[-1], "wb").write(bytes.fromhex("1a45dfa3") + b"x" * 1000)
"""


@pytest.fixture
def fake_ffmpeg(tmp_path, monkeypatch):
    """ffmpeg replaced by FAKE_FFMPEG; returns a function reading its log."""
    script, log = tmp_path / "fake-ffmpeg", tmp_path / "fake-ffmpeg.log"
    script.write_text(FAKE_FFMPEG.format(python=sys.executable))
    script.chmod(0o755)
    log.write_text("")
    monkeypatch.setattr(previews, "ffmpeg_bin", lambda: str(script))
    monkeypatch.setenv("FAKE_FFMPEG_LOG", str(log))
    return lambda: [json.loads(line) for line in log.read_text().splitlines()]


def most_at_once(spans) -> int:
    edges = sorted([(a, 1) for a, _ in spans] + [(b, -1) for _, b in spans])
    now = top = 0
    for _, step in edges:
        now += step
        top = max(top, now)
    return top


def test_a_build_reads_each_file_once_in_one_thread_and_encodes_in_parallel(lib, fake_ffmpeg, monkeypatch):
    svc, root, add = lib
    paths = [add(f"{i:02d} song", seconds=1.0, item=f"t{i}") for i in range(1, 9)]
    with open(paths[4], "ab") as f:  # past the AIFF's end: still indexed and read, but the encoder fails on it
        f.write(b"BADFILE")
    indexer.index_file(svc.store, paths[4], svc.settings.roots())
    svc.settings.update({"preview_build_parallel": 4})
    reads, real = [], previews._read_source

    def spy(path, counted):
        start = time.monotonic()
        data = real(path, counted)
        time.sleep(0.02)  # a slower drive: overlapping reads would show
        reads.append((threading.current_thread().name, path, start, time.monotonic()))
        return data

    monkeypatch.setattr(previews, "_read_source", spy)
    events = []
    svc.jobs.bus.publish = lambda event, data: events.append((event, data))
    with TestClient(create_app(svc)) as c:
        r = c.post("/api/previews/build", json={"all": True}).json()
        plan = r["plan"]
        assert (plan["files"], plan["needed"], plan["planned"], plan["left_out"], plan["parallel"]) == (8, 8, 8, 0, 4)
        assert plan["fits_cap"] and plan["fits_space"] and plan["kbps"] == 96 and "_rows" not in plan
        assert c.post("/api/previews/build", json={"all": True}).status_code == 409  # one build at a time
        job = svc.jobs.wait(r["job_id"], timeout=30)
    assert job.status == "done", job.error
    # one reader, each file once, start to finish, one after another, in path order
    assert {name for name, *_ in reads} == {f"bct-{job.id}-reader"}
    assert [p for _, p, *_ in reads] == sorted(paths)
    assert all(b[2] >= a[3] for a, b in zip(reads, reads[1:]))
    # the encoders got the files through stdin, several at once
    runs = fake_ffmpeg()
    piped = [r for r in runs if r["source"] == "pipe:0"]
    assert len(piped) == 8 and all(r["bytes"] > 100_000 for r in piped)
    assert [r["source"] for r in runs if r["source"] != "pipe:0"] == [  # the bad one, again from a local copy
        str(previews.previews_dir() / (previews._key(paths[4], *(lambda r: (r["size"], r["mtime"]))(
            svc.store.query_one("SELECT size, mtime FROM files WHERE path = ?", (paths[4],)))) + ".src.aiff"))]
    assert 3 <= most_at_once([(r["start"], r["end"]) for r in piped]) <= 4
    res = job.result
    assert (res["built"], res["failed"], res["skipped"], res["cancelled"], res["not_built"]) == (7, 1, 0, False, 0)
    assert res["errors"] == [{"path": paths[4], "status": "failed", "error": "Invalid data found when processing input"}]
    assert res["bytes_read"] == sum(os.path.getsize(p) for p in paths) and res["read_mb_s"] > 0
    progress = [d["progress"] for e, d in events if e == "job" and d["id"] == job.id]
    assert {"read_mb_s", "eta_s", "current_file", "bytes_read", "bytes_total", "built", "failed"} <= set(progress[-1])
    assert any(p.get("current_file") in paths for p in progress) and progress[-1]["current"] == 8
    assert svc.previews.status()["count"] == 7 and svc.previews.status()["batch"] is None
    assert not list(previews.previews_dir().glob("*.src.*")) and not list(previews.previews_dir().glob("*.part.*"))


def test_a_build_resumes_and_skips_what_is_done(lib):
    svc, _, add = lib
    paths = [add(f"{i:02d}", seconds=0.5, item=f"t{i}") for i in range(1, 6)]
    first = svc.preview_build(["t1", "t2"])
    assert svc.jobs.wait(first["job_id"], timeout=30).result["built"] == 2
    again = svc.preview_build(everything=True)
    assert (again["plan"]["already"], again["plan"]["planned"]) == (2, 3)
    assert svc.jobs.wait(again["job_id"], timeout=30).result["built"] == 3
    done = svc.preview_build(everything=True)
    assert (done["plan"]["already"], done["plan"]["planned"]) == (5, 0)
    assert svc.jobs.wait(done["job_id"], timeout=30).result["built"] == 0
    assert sorted(r["path"] for r in svc.store.query("SELECT path FROM previews")) == paths


def test_a_build_keeps_to_the_cap_and_the_free_space(lib, monkeypatch):
    svc, _, add = lib
    for i in range(1, 6):
        add(f"{i:02d}", seconds=1.0, item=f"t{i}")
    one = previews.estimate_bytes(1.0, 96_000)
    svc.settings.update({"preview_cache_gb": (3 * one + 100) / 1024**3})
    with TestClient(create_app(svc)) as c:
        plan = c.post("/api/previews/build", json={"all": True, "dry_run": True}).json()
        assert "job_id" not in plan and svc.jobs.list() == []  # a dry run only plans
        plan = plan["plan"]
        assert (plan["needed"], plan["planned"], plan["left_out"], plan["fits_cap"], plan["fits_space"]) == (
            5, 3, 2, False, True)
        assert plan["planned_bytes"] == 3 * one and plan["left_out_bytes"] == 2 * one
        monkeypatch.setattr(previews.Previews, "_free_bytes", lambda self: previews.MIN_FREE_BYTES + 2 * one + 100)
        plan = c.post("/api/previews/build", json={"ids": ["t1", "t2", "t3", "t4", "t5"]}).json()
        assert (plan["plan"]["planned"], plan["plan"]["fits_space"]) == (2, False)
        result = svc.jobs.wait(plan["job_id"], timeout=30).result
        assert result["built"] == 2 and result["left_out"] == 3  # in collection order: t1 and t2
        assert c.post("/api/previews/build", json={"ids": ["t1"], "all": True}).status_code == 400


def test_cancel_stops_after_the_files_being_encoded(lib, fake_ffmpeg, monkeypatch):
    svc, _, add = lib
    for i in range(1, 7):
        add(f"{i:02d}", seconds=0.5, item=f"t{i}")
    monkeypatch.setenv("FAKE_FFMPEG_S", "1.0")
    svc.settings.update({"preview_build_parallel": 2})
    with TestClient(create_app(svc)) as c:
        job_id = c.post("/api/previews/build", json={"all": True}).json()["job_id"]
        deadline = time.monotonic() + 10
        while (svc.previews.status()["batch"] or {}).get("encoding") != 2 and time.monotonic() < deadline:
            time.sleep(0.02)
        assert c.post(f"/api/previews/build/{job_id}/cancel").json() == {"job_id": job_id, "cancelled": True}
        started = time.monotonic()
        job = svc.jobs.wait(job_id, timeout=10)
        assert time.monotonic() - started < 2  # the two in flight finish; nothing else starts
        res = job.result
        assert res["cancelled"] and res["built"] == 2 and res["not_built"] == 4 and len(fake_ffmpeg()) == 2
        assert c.post(f"/api/previews/build/{job_id}/cancel").json()["cancelled"] is False  # over
        assert c.post("/api/previews/build/locate-1/cancel").status_code == 404


def test_background_encodes_wait_while_a_build_reads_the_drive(lib, fake_ffmpeg, monkeypatch):
    svc, _, add = lib
    built = add("built", seconds=0.5, item="t1")
    later = add("later", seconds=0.5)
    monkeypatch.setenv("FAKE_FFMPEG_S", "0.6")
    svc.previews.autostart = True
    job = svc.preview_build(["t1"])
    svc.previews.enqueue([later])  # e.g. an import commit, mid-build
    time.sleep(0.3)
    assert [r["source"] for r in fake_ffmpeg()] == [] and svc.previews.status()["building"] == 0
    svc.jobs.wait(job["job_id"], timeout=10)
    deadline = time.monotonic() + 10
    while svc.previews.status()["count"] < 2 and time.monotonic() < deadline:
        time.sleep(0.05)
    runs = fake_ffmpeg()
    assert [r["source"] for r in runs] == ["pipe:0", later]  # the build first, then the background one
    assert runs[1]["start"] >= runs[0]["end"] and built != later


def test_a_stuck_encode_times_out(lib, fake_ffmpeg, monkeypatch):
    svc, _, add = lib
    src = add("stuck", seconds=0.5)
    monkeypatch.setenv("FAKE_FFMPEG_S", "5")
    monkeypatch.setattr(previews, "ENCODE_TIMEOUT_S", 0.5)
    started = time.monotonic()
    result = svc.previews.build(src)
    assert result == {"path": src, "status": "failed", "error": "took over 0.5 s"} and time.monotonic() - started < 3
    assert not list(previews.previews_dir().glob("*.part.*"))

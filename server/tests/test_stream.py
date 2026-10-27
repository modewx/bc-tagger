"""AIFF plays as a WAV built on the fly: the header from the index, each range read as just that slice."""

from __future__ import annotations

import builtins
import json
import os
import shutil
import struct
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bc_tagger_server import aiff, indexer, stream
from bc_tagger_server.api import create_app
from bc_tagger_server.store import now_iso

from .test_no_drive_reads import DRIVE, _file_rec, no_stat_under

FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
needs_ffmpeg = pytest.mark.skipif(not os.path.exists(FFMPEG), reason="ffmpeg not installed")

# ffmpeg codec that writes the AIFF -> (raw format and codec the same samples decode to as WAV bytes)
VARIANTS = {
    "s16be-stereo": ("pcm_s16be", 2, "s16le"),
    "s16be-mono": ("pcm_s16be", 1, "s16le"),
    "s24be-stereo": ("pcm_s24be", 2, "s24le"),
    "s24be-mono": ("pcm_s24be", 1, "s24le"),
    "s32be-stereo": ("pcm_s32be", 2, "s32le"),
    "s8-mono": ("pcm_s8", 1, "u8"),
    "sowt-stereo": ("pcm_s16le", 2, "s16le"),  # AIFF-C sowt: already little-endian
    "fl32-stereo": ("pcm_f32be", 2, "f32le"),
    "fl64-mono": ("pcm_f64be", 1, "f64le"),
}


def make_aiff(path: Path, codec: str, channels: int, seconds: float = 1.0, rate: int = 44100) -> Path:
    """Noise plus two tones, so every byte of every sample varies."""
    path.parent.mkdir(parents=True, exist_ok=True)
    expr = "0.8*sin(440*2*PI*t)+0.15*random(0)|0.5*sin(660*2*PI*t)-0.2*random(1)"
    subprocess.run([FFMPEG, "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    f"aevalsrc=exprs={expr}:s={rate}:d={seconds}", "-ac", str(channels), "-c:a", codec, str(path)],
                   check=True)
    return path


def decode(path: Path, raw: str) -> bytes:
    """What ffmpeg decodes the file to, as raw little-endian (or unsigned 8-bit) samples."""
    codec = "pcm_u8" if raw == "u8" else f"pcm_{raw}"
    return subprocess.run([FFMPEG, "-nostdin", "-loglevel", "error", "-i", str(path), "-f", raw, "-c:a", codec, "-"],
                          check=True, capture_output=True).stdout


@pytest.fixture
def music(make_service, tmp_path):
    """A service whose only root is ``tmp_path/music``; ``add(name, codec, channels)`` indexes a new AIFF."""
    root = tmp_path / "music"
    root.mkdir()
    svc = make_service(root)

    def add(name: str, codec: str = "pcm_s16be", channels: int = 2, seconds: float = 1.0) -> Path:
        path = make_aiff(root / f"{name}.aiff", codec, channels, seconds)
        indexer.index_file(svc.store, path, svc.settings.roots())
        return path

    return svc, root, add


def get(client, path: Path, rng: str | None = None):
    return client.get("/api/files/stream", params={"path": str(path)}, headers={"Range": rng} if rng else {})


def layout_of(svc, path: Path) -> dict | None:
    row = svc.store.query_one("SELECT aiff_layout FROM files WHERE path = ?", (str(path),))
    return json.loads(row["aiff_layout"]) if row["aiff_layout"] else None


class CountingFile:
    """A source file that counts the bytes read from it."""

    opened: list["CountingFile"] = []

    def __init__(self, path):
        self.f, self.read_bytes = open(path, "rb", buffering=0), 0
        CountingFile.opened.append(self)

    def read(self, n=-1):
        b = self.f.read(n)
        self.read_bytes += len(b)
        return b

    def seek(self, *a):
        return self.f.seek(*a)

    def fileno(self):
        return self.f.fileno()

    def close(self):
        self.f.close()


def no_open(path):
    raise AssertionError(f"opened {path}")


@pytest.fixture
def counting(monkeypatch):
    CountingFile.opened = []
    monkeypatch.setattr(stream, "_open_source", CountingFile)
    return CountingFile.opened


@needs_ffmpeg
@pytest.mark.parametrize("variant", sorted(VARIANTS))
def test_wav_samples_equal_ffmpegs_decode(music, variant, tmp_path):
    svc, _, add = music
    codec, channels, raw = VARIANTS[variant]
    src = add(variant, codec, channels)
    expected = decode(src, raw)
    with TestClient(create_app(svc)) as c:
        whole = get(c, src)
        assert whole.status_code == 200 and whole.headers["content-type"] == "audio/wav"
        assert whole.headers["accept-ranges"] == "bytes"
        assert int(whole.headers["content-length"]) == len(whole.content) == 44 + len(expected)
        assert whole.content[44:] == expected
        # the header is right: ffmpeg reads the WAV back to the same samples
        wav = tmp_path / f"{variant}.wav"
        wav.write_bytes(whole.content)
        assert decode(wav, raw) == expected
        # a slice in the middle, starting and ending inside samples
        a = len(expected) // 3 + 1
        b = a + 10_001
        r = get(c, src, f"bytes={44 + a}-{44 + b - 1}")
        assert r.status_code == 206 and r.headers["content-range"] == f"bytes {44 + a}-{44 + b - 1}/{44 + len(expected)}"
        assert r.content == expected[a:b]


@needs_ffmpeg
def test_a_mid_file_range_reads_only_that_slice(music, counting):
    svc, _, add = music
    src = add("long", "pcm_s24be", 2, seconds=10)  # 2.6 MB of samples
    layout = layout_of(svc, src)
    size = 44 + layout["size"]
    with TestClient(create_app(svc)) as c:
        start = size // 2 + 1
        r = get(c, src, f"bytes={start}-{start + 65_535}")
        assert r.status_code == 206 and len(r.content) == 65_536
        assert int(r.headers["content-length"]) == 65_536
        assert len(counting) == 1
        assert 65_536 <= counting[0].read_bytes <= 65_536 + 2 * 3  # whole 24-bit samples at both ends
        # an open-ended range near the end, as a player sends after a seek
        r = get(c, src, f"bytes={size - 1000}-")
        assert r.status_code == 206 and len(r.content) == 1000 and counting[1].read_bytes <= 1000 + 3
        r = get(c, src, "bytes=-100")  # the last 100 bytes
        assert r.headers["content-range"] == f"bytes {size - 100}-{size - 1}/{size}" and len(r.content) == 100


@needs_ffmpeg
def test_the_header_needs_no_read_of_the_file(music, monkeypatch):
    svc, root, add = music
    src = add("t", "pcm_s16be", 2)
    layout = layout_of(svc, src)
    assert layout["container"] == "AIFF" and layout["channels"] == 2 and layout["bits"] == 16
    assert layout["rate"] == 44100 and layout["frames"] == 44100 and layout["size"] == 44100 * 4

    monkeypatch.setattr(stream, "_open_source", no_open)
    with TestClient(create_app(svc)) as c, no_stat_under(monkeypatch, str(root)) as touched:
        r = get(c, src, "bytes=0-43")
        assert r.status_code == 206 and r.headers["content-type"] == "audio/wav"
        assert r.headers["content-range"] == f"bytes 0-43/{44 + layout['size']}"
        riff, size, wave, fmt, fmt_size, tag, ch, rate, byte_rate, block, bits, data, data_size = struct.unpack(
            "<4sL4s4sLHHLLHH4sL", r.content)
        assert (riff, wave, fmt, data) == (b"RIFF", b"WAVE", b"fmt ", b"data")
        assert (tag, ch, rate, block, bits, data_size) == (1, 2, 44100, 4, 16, layout["size"])
        assert size == 36 + layout["size"] and byte_rate == 44100 * 4
        assert get(c, src, "bytes=0-10").content == r.content[:11]
    assert touched == []


@needs_ffmpeg
def test_rows_indexed_before_layouts_get_one_on_first_play(music, monkeypatch, counting):
    svc, _, add = music
    src = add("old", "pcm_s16be", 1)
    kept = layout_of(svc, src)
    with svc.store.tx() as c:
        c.execute("UPDATE files SET aiff_layout = NULL, channels = NULL WHERE path = ?", (str(src),))
    with TestClient(create_app(svc)) as c:
        assert get(c, src, "bytes=0-").status_code == 206
        assert layout_of(svc, src) == kept
        assert svc.store.query_one("SELECT channels FROM files WHERE path = ?", (str(src),))["channels"] == 1
        assert counting[0].read_bytes < 300 + kept["size"]  # the chunk headers, then the samples
        monkeypatch.setattr(stream, "_open_source", no_open)
        assert get(c, src, "bytes=0-43").status_code == 206  # saved: the header needs no read now


@needs_ffmpeg
def test_ranges_past_the_end_and_odd_ranges(music):
    svc, _, add = music
    src = add("r", "pcm_s16be", 2, seconds=0.2)
    total = 44 + layout_of(svc, src)["size"]
    with TestClient(create_app(svc)) as c:
        r = get(c, src, f"bytes={total}-")
        assert r.status_code == 416 and r.headers["content-range"] == f"bytes */{total}"
        assert get(c, src, "bytes=0-0").content == b"R"
        r = get(c, src, f"bytes=10-{total + 500}")  # an end past the end is cut to it
        assert r.status_code == 206 and r.headers["content-range"] == f"bytes 10-{total - 1}/{total}"
        assert len(r.content) == total - 10
        for odd in ("bytes=0-1,5-9", "items=0-5", "bytes=9-3"):  # not served as ranges: the whole file
            r = get(c, src, odd)
            assert r.status_code == 200 and len(r.content) == total, odd


@needs_ffmpeg
def test_compressed_aiff_c_and_cached_flac_use_flac(music, counting):
    svc, root, add = music
    ulaw = add("ulaw", "pcm_mulaw", 2, seconds=0.2)
    assert layout_of(svc, ulaw)["compression"] == "ulaw"
    pcm = add("pcm", "pcm_s16be", 2, seconds=0.2)
    row = svc.store.query_one("SELECT size, mtime FROM files WHERE path = ?", (str(pcm),))
    stream.transcode_to_flac(pcm, row["size"], row["mtime"])  # played before this change
    with TestClient(create_app(svc)) as c:
        r = get(c, ulaw, "bytes=0-99")
        assert r.status_code == 206 and r.headers["content-type"] == "audio/flac"
        r = get(c, pcm, "bytes=0-99")
        assert r.status_code == 206 and r.headers["content-type"] == "audio/flac"  # from the cache
        assert [f for f in counting if f.read_bytes] == []  # the cached FLAC: no read of the source
        # a file changed since it was indexed: its kept layout can't be trusted, so it's transcoded
        changed = add("changed", "pcm_s16be", 2, seconds=0.2)
        os.utime(changed, (1_000_000_000, 1_000_000_000))
        assert get(c, changed, "bytes=0-99").headers["content-type"] == "audio/flac"


def test_read_layout_walks_odd_chunks_and_the_ssnd_offset(tmp_path):
    """An odd-sized chunk before the samples (padded to even), and an SSND with an offset to its data."""
    frames, data = 3, bytes(range(12))  # 3 stereo 16-bit frames
    rate80 = struct.pack(">HQ", 16383 + 15, 44100 << (63 - 15))
    comm = struct.pack(">hLh", 2, frames, 16) + rate80
    junk = b"abc"  # odd: one pad byte follows
    ssnd = struct.pack(">LL", 4, 0) + b"\xff" * 4 + data
    body = (b"AIFF" + b"COMM" + struct.pack(">L", len(comm)) + comm + b"ANNO" + struct.pack(">L", 3) + junk + b"\0"
            + b"SSND" + struct.pack(">L", len(ssnd)) + ssnd)
    path = tmp_path / "x.aiff"
    path.write_bytes(b"FORM" + struct.pack(">L", len(body)) + body)
    layout = aiff.aiff_layout(path, path.stat().st_size)
    assert layout == {"container": "AIFF", "compression": "NONE", "channels": 2, "bits": 16, "rate": 44100,
                      "frames": 3, "offset": path.read_bytes().index(data), "size": 12}
    # a file cut short: only the whole frames it holds
    path.write_bytes(path.read_bytes()[:-5])
    assert aiff.aiff_layout(path, path.stat().st_size)["size"] == 4
    assert aiff.aiff_layout(tmp_path / "missing.aiff", 0) is None
    (tmp_path / "not.aiff").write_bytes(b"RIFF....WAVE")
    assert aiff.aiff_layout(tmp_path / "not.aiff", 12) is None


def test_item_views_carry_length_without_touching_the_files(make_service, tmp_path, mount_table, monkeypatch):
    collection = f"{DRIVE}/Music/Collection"
    items = {"t1": {"title": "One", "artist": "A", "tags": []}, "a2": {"title": "Two", "artist": "B", "tags": []},
             # enough for the list to read the views in bulk (a single item reads its own)
             **{f"t{i}": {"title": f"Filler {i}", "artist": "C", "tags": []} for i in range(100, 125)}}
    svc = make_service(tmp_path / "unused", items=items)
    one, side_a, side_b = (f"{collection}/A/one.aiff", f"{collection}/B/1.aiff", f"{collection}/B/2.aiff")
    rows = []
    for path, duration, channels in ((one, 303.5, 2), (side_a, 61.0, 1), (side_b, 62.25, None)):
        rows.append({**_file_rec(path, collection), "duration": duration, "sample_rate": 44100, "bits": 24,
                     "channels": channels})
    indexer._flush(svc.store, rows)
    best_one = {"path": one, "format": "aiff", "confidence": 1.0}
    best_two = {"path": f"{collection}/B", "format": "aiff",
                "tracks": [{"path": side_a, "format": "aiff"}, {"path": side_b, "format": "aiff"},
                           {"path": f"{collection}/B/3.aiff", "format": "aiff"}]}  # no longer indexed
    with svc.store.tx() as c:
        c.executemany("INSERT INTO locate_results(item_id, status, best, candidates, located_at) VALUES(?, ?, ?, ?, ?)",
                      [("t1", "located", json.dumps(best_one), "[]", now_iso()),
                       ("a2", "located", json.dumps(best_two), "[]", now_iso())])
    mount_table(DRIVE)
    real_open = builtins.open

    def guarded_open(file, *a, **k):
        if isinstance(file, (str, os.PathLike)) and os.fspath(file).startswith(DRIVE):
            raise AssertionError(f"opened {file}")
        return real_open(file, *a, **k)

    monkeypatch.setattr(builtins, "open", guarded_open)
    with TestClient(create_app(svc)) as c, no_stat_under(monkeypatch, DRIVE) as touched:
        listed = {i["id"]: i for i in c.get("/api/items").json()}
        single = c.get("/api/items/t1").json(), c.get("/api/items/a2").json()
    assert touched == []
    for t1, a2 in ((listed["t1"], listed["a2"]), single):
        assert {k: t1["local"]["best"][k] for k in ("duration", "sample_rate", "bits", "channels")} == {
            "duration": 303.5, "sample_rate": 44100, "bits": 24, "channels": 2}
        assert "duration" not in a2["local"]["best"]  # a release: each track has its own
        assert [(t["duration"], t["channels"]) for t in a2["local"]["best"]["tracks"]] == [
            (61.0, 1), (62.25, None), (None, None)]


@needs_ffmpeg
def test_other_formats_index_their_channels_and_no_layout(music):
    svc, root, _ = music
    flac = root / "mono.flac"
    subprocess.run([FFMPEG, "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=d=0.2", "-ac", "1", str(flac)],
                   check=True)
    indexer.index_file(svc.store, flac, svc.settings.roots())
    row = svc.store.query_one("SELECT channels, aiff_layout, duration FROM files WHERE path = ?", (str(flac),))
    assert (row["channels"], row["aiff_layout"]) == (1, None) and row["duration"] == pytest.approx(0.2, abs=0.01)

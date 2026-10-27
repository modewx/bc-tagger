"""Serve indexed audio files to the browser with HTTP Range support.

Chrome can't play AIFF (or ALAC). In order:

* a FLAC already in the transcode cache (under the data dir) is served from there, with no read of the
  music drive;
* an uncompressed AIFF is served as a WAV built on the fly: the 44-byte header comes from the layout the
  index keeps (``files.aiff_layout``, see ``aiff``), and each requested range reads only that slice of the
  samples. So the first byte goes out before the drive is read, and a seek reads only what it plays;
* anything else (ALAC, compressed AIFF-C) is transcoded once to FLAC with ffmpeg into the cache.

Only files that are in the index can be streamed.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import BinaryIO, Iterator

from fastapi import HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse

from .aiff import WavFormat, read_layout, to_wav, wav_format, wav_header
from .config import data_dir
from .fsguard import is_mounted
from .store import Store

log = logging.getLogger(__name__)

NATIVE_TYPES = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
}
TRANSCODE_FORMATS = {"aiff", "alac"}
CACHE_LIMIT_BYTES = 2 * 1024**3
CACHE_CONTROL = "private, max-age=3600"
WAV_CHUNK = 256 * 1024  # bytes read from the drive per step; a stopped player stops the reads
_RANGE = re.compile(r"bytes=(\d*)-(\d*)")

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def ffmpeg_bin() -> str:
    return shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"


def cache_dir() -> Path:
    d = data_dir() / "transcode-cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


def _flac_key(src: Path, size: int, mtime: float) -> str:
    return hashlib.sha1(f"{src}|{size}|{mtime}".encode()).hexdigest()


def cached_flac(src: Path, size: int, mtime: float) -> Path | None:
    """The cache's FLAC of this version of ``src``, if there is one (only the data dir is looked at)."""
    out = cache_dir() / f"{_flac_key(src, size, mtime)}.flac"
    if not out.is_file():
        return None
    out.touch()
    return out


def transcode_to_flac(src: Path, size: int, mtime: float) -> Path:
    key = _flac_key(src, size, mtime)
    out = cache_dir() / f"{key}.flac"
    with _lock_for(key):
        if out.is_file():
            out.touch()
            return out
        tmp = out.with_suffix(".part.flac")
        cmd = [ffmpeg_bin(), "-nostdin", "-loglevel", "error", "-y", "-i", str(src),
               "-map", "0:a", "-c:a", "flac", "-compression_level", "0", str(tmp)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if proc.returncode != 0:
            tmp.unlink(missing_ok=True)
            raise HTTPException(500, f"transcode failed: {proc.stderr.strip()[:300]}")
        tmp.replace(out)
    _prune_cache()
    return out


def _prune_cache() -> None:
    files = sorted(cache_dir().glob("*.flac"), key=lambda p: p.stat().st_mtime, reverse=True)
    total = 0
    for f in files:
        total += f.stat().st_size
        if total > CACHE_LIMIT_BYTES:
            f.unlink(missing_ok=True)


def stream_response(store: Store, path: str, range_header: str | None = None) -> Response:
    row = store.query_one("SELECT path, format, size, mtime, ext, aiff_layout FROM files WHERE path = ?", (path,))
    if row is None:
        raise HTTPException(404, "not an indexed audio file")
    if not is_mounted(row["path"]):
        raise HTTPException(404, "music drive not mounted")
    src = Path(row["path"])
    headers = {"Cache-Control": CACHE_CONTROL}
    if row["format"] in TRANSCODE_FORMATS:
        out = cached_flac(src, row["size"], row["mtime"])
        if out is not None:
            return FileResponse(out, media_type="audio/flac", headers=headers)
        if row["format"] == "aiff":
            response = wav_response(store, row, range_header)
            if response is not None:
                return response
        if not src.is_file():
            raise HTTPException(404, "file is gone (re-scan the index)")
        out = transcode_to_flac(src, row["size"], row["mtime"])
        return FileResponse(out, media_type="audio/flac", headers=headers)
    if not src.is_file():
        raise HTTPException(404, "file is gone (re-scan the index)")
    media = NATIVE_TYPES.get(row["ext"])
    if media is None:
        raise HTTPException(415, f"can't stream {row['ext']} files")
    return FileResponse(src, media_type=media, headers=headers)


# -- AIFF as WAV -----------------------------------------------------------------------------


def _open_source(path: Path) -> BinaryIO:
    return open(path, "rb", buffering=0)


def _open_unchanged(row) -> BinaryIO | None:
    """The file opened for reading, or None if it changed since it was indexed (its layout may have too)."""
    try:
        f = _open_source(Path(row["path"]))
    except FileNotFoundError:
        raise HTTPException(404, "file is gone (re-scan the index)") from None
    st = os.fstat(f.fileno())
    if (st.st_size, st.st_mtime) != (row["size"], row["mtime"]):
        log.info("%s changed since it was indexed: transcoding it (re-scan to stream it directly)", row["path"])
        f.close()
        return None
    return f


def wav_response(store: Store, row, range_header: str | None) -> Response | None:
    """The uncompressed AIFF in ``row`` as a WAV, or None to transcode it instead."""
    layout = json.loads(row["aiff_layout"]) if row["aiff_layout"] else None
    source = None
    if layout is None:  # indexed before layouts were kept: read it now (a few small reads), once
        source = _open_unchanged(row)
        if source is None:
            return None
        try:
            layout = read_layout(source, row["size"])
        except Exception:  # noqa: BLE001 - a broken header: let ffmpeg try
            layout = None
        if layout is None:
            source.close()
            return None
        with store.tx() as c:
            c.execute("UPDATE files SET aiff_layout = ?, channels = ? WHERE path = ? AND size = ? AND mtime = ?",
                      (json.dumps(layout), layout["channels"], row["path"], row["size"], row["mtime"]))
    fmt = wav_format(layout)
    if fmt is None:  # compressed AIFF-C
        if source is not None:
            source.close()
        return None
    header = wav_header(layout, fmt)
    total = len(header) + layout["size"]
    headers = {"Accept-Ranges": "bytes", "Cache-Control": CACHE_CONTROL,
               "ETag": f'"{_flac_key(Path(row["path"]), row["size"], row["mtime"])[:20]}-wav"'}
    try:
        span = parse_range(range_header, total)
    except RangeNotSatisfiable:
        if source is not None:
            source.close()
        return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{total}"})
    start, end = span or (0, total - 1)
    if end >= len(header) and source is None:  # sample data asked for: only now is the drive read
        source = _open_unchanged(row)
        if source is None:
            return None
    elif end < len(header) and source is not None:
        source.close()
        source = None
    headers["Content-Length"] = str(end - start + 1)
    if span:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    return StreamingResponse(_wav_body(source, layout["offset"], fmt, header, start, end),
                             status_code=206 if span else 200, media_type="audio/wav", headers=headers)


def _wav_body(source: BinaryIO | None, offset: int, fmt: WavFormat, header: bytes,
              start: int, end: int) -> Iterator[bytes]:
    """Bytes ``start``..``end`` (inclusive) of the WAV: header bytes as they are, sample bytes read in
    whole samples from ``offset`` in the source and reordered."""
    try:
        if start < len(header):
            yield header[start:end + 1]
        a, b = max(start - len(header), 0), end + 1 - len(header)  # the sample bytes wanted, [a, b)
        pos = a - a % fmt.width
        while pos < b:
            stop = min(b, pos + WAV_CHUNK)
            stop += -stop % fmt.width  # whole samples (the data is whole frames, so this stays inside it)
            buf = _read_at(source, offset + pos, stop - pos)
            yield to_wav(buf, fmt)[max(a - pos, 0):b - pos]
            pos = stop
    finally:
        if source is not None:
            source.close()


def _read_at(f: BinaryIO, at: int, n: int) -> bytes:
    f.seek(at)
    parts, got = [], 0
    while got < n:
        part = f.read(n - got)
        if not part:  # shorter than when it was indexed: keep the promised length with silence
            parts.append(b"\x00" * (n - got))
            break
        parts.append(part)
        got += len(part)
    return b"".join(parts)


class RangeNotSatisfiable(Exception):
    pass


def parse_range(value: str | None, total: int) -> tuple[int, int] | None:
    """``(start, end)`` (inclusive) of a single ``bytes=`` range, or None to send everything (no Range,
    or one this doesn't serve, like several ranges). Raises ``RangeNotSatisfiable`` past the end."""
    m = _RANGE.fullmatch((value or "").strip())
    if not m or not (m[1] or m[2]):
        return None
    if m[1]:
        start = int(m[1])
        end = min(int(m[2]), total - 1) if m[2] else total - 1
        if m[2] and int(m[2]) < start:
            return None  # invalid: ignored, as the RFC says
        if start >= total:
            raise RangeNotSatisfiable
        return start, end
    suffix = int(m[2])
    if suffix == 0 or total == 0:
        raise RangeNotSatisfiable
    return max(total - suffix, 0), total - 1

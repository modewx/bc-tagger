"""Serve indexed audio files to the browser with HTTP Range support.

Chrome can't play AIFF (or ALAC), so those are transcoded once to FLAC with ffmpeg into a
cache under the data dir (~1 s per track) and served from there, which keeps seeking working.
Only files that are in the index can be streamed.
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import threading
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse

from .config import data_dir
from .store import Store

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


def transcode_to_flac(src: Path, size: int, mtime: float) -> Path:
    key = hashlib.sha1(f"{src}|{size}|{mtime}".encode()).hexdigest()
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


def stream_response(store: Store, path: str) -> FileResponse:
    row = store.query_one("SELECT path, format, size, mtime, ext FROM files WHERE path = ?", (path,))
    if row is None:
        raise HTTPException(404, "not an indexed audio file")
    src = Path(row["path"])
    if not src.is_file():
        raise HTTPException(404, "file is gone (re-scan the index)")
    if row["format"] in TRANSCODE_FORMATS:
        out = transcode_to_flac(src, row["size"], row["mtime"])
        return FileResponse(out, media_type="audio/flac", headers={"Cache-Control": "private, max-age=3600"})
    media = NATIVE_TYPES.get(row["ext"])
    if media is None:
        raise HTTPException(415, f"can't stream {row['ext']} files")
    return FileResponse(src, media_type=media, headers={"Cache-Control": "private, max-age=3600"})

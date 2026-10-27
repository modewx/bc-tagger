"""Read embedded audio tags with mutagen into one flat dict."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import mutagen

AUDIO_EXTS = {".aif", ".aiff", ".flac", ".wav", ".mp3", ".m4a", ".mp4", ".alac", ".ogg", ".opus"}
_URL = re.compile(r"https?://[^\s\"'<>]+", re.I)


def _first(v: Any) -> str | None:
    if v is None:
        return None
    if hasattr(v, "text"):  # ID3 text frame
        v = v.text
    elif hasattr(v, "url"):  # ID3 URL frame
        v = v.url
    if isinstance(v, (list, tuple)):
        v = v[0] if v else None
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _num(v: str | None) -> int | None:
    if not v:
        return None
    m = re.match(r"\s*(\d+)", str(v))
    return int(m.group(1)) if m else None


def _id3(tags: Any) -> dict:
    get = lambda key: _first(tags.get(key))  # noqa: E731
    comments = [
        _first(frame) for key, frame in tags.items() if key.startswith("COMM")
    ]
    urls = [_first(frame) for key, frame in tags.items() if key.startswith(("WXXX", "WOAF", "WOAR", "WOAS"))]
    label = get("TPUB") or get("TXXX:ORGANIZATION") or get("TXXX:LABEL")
    return {
        "title": get("TIT2"),
        "artist": get("TPE1"),
        "albumartist": get("TPE2") or get("TXXX:ALBUM ARTIST") or get("TXXX:ALBUMARTIST"),
        "album": get("TALB"),
        "tracknumber": _num(get("TRCK")),
        "discnumber": _num(get("TPOS")),
        "comment": " | ".join(c for c in comments if c) or None,
        "urls": [u for u in urls if u],
        "year": _num(get("TDRC") or get("TYER")),
        "genre": get("TCON"),
        "label": label,
    }


def _vorbis(tags: Any) -> dict:
    get = lambda key: _first(tags.get(key))  # noqa: E731
    return {
        "title": get("title"),
        "artist": get("artist"),
        "albumartist": get("albumartist") or get("album artist"),
        "album": get("album"),
        "tracknumber": _num(get("tracknumber")),
        "discnumber": _num(get("discnumber")),
        "comment": get("comment") or get("description"),
        "urls": [u for u in (get("url"), get("website")) if u],
        "year": _num(get("date") or get("year")),
        "genre": get("genre"),
        "label": get("label") or get("organization") or get("publisher"),
    }


def _mp4(tags: Any) -> dict:
    get = lambda key: _first(tags.get(key))  # noqa: E731
    trkn = tags.get("trkn")
    disk = tags.get("disk")
    return {
        "title": get("\xa9nam"),
        "artist": get("\xa9ART"),
        "albumartist": get("aART"),
        "album": get("\xa9alb"),
        "tracknumber": trkn[0][0] if trkn else None,
        "discnumber": disk[0][0] if disk else None,
        "comment": get("\xa9cmt"),
        "urls": [],
        "year": _num(get("\xa9day")),
        "genre": get("\xa9gen"),
        "label": None,
    }


def classify_format(ext: str, codec: str | None, bitrate: int | None) -> str:
    ext = ext.lower()
    if ext in (".aif", ".aiff"):
        return "aiff"
    if ext == ".flac":
        return "flac"
    if ext == ".wav":
        return "wav"
    if ext in (".m4a", ".mp4", ".alac"):
        return "alac" if codec and "alac" in codec.lower() else "m4a"
    if ext == ".mp3":
        return "mp3-320" if bitrate and bitrate >= 315_000 else "mp3"
    return "other"


def read_tags(path: Path) -> dict:
    """Return tags + audio info. Raises on unreadable files."""
    audio = mutagen.File(path)
    if audio is None:
        raise ValueError("unsupported or unreadable audio file")
    tags = audio.tags
    kind = type(tags).__name__ if tags is not None else ""
    if tags is None:
        data: dict = {"urls": []}
    elif kind in ("ID3", "_WaveID3", "_IFFID3"):
        data = _id3(tags)
    elif kind == "MP4Tags":
        data = _mp4(tags)
    else:  # VCommentDict / FLAC / Ogg
        data = _vorbis(tags)
    info = audio.info
    codec = getattr(info, "codec", None)
    bitrate = getattr(info, "bitrate", None)
    text = " ".join(filter(None, [data.get("comment")] + data.get("urls", [])))
    urls = list(dict.fromkeys(u.rstrip(".,;)") for u in _URL.findall(text)))
    data.update(
        urls=urls,
        duration=float(getattr(info, "length", 0) or 0) or None,
        bitrate=int(bitrate) if bitrate else None,
        sample_rate=getattr(info, "sample_rate", None),
        bits=getattr(info, "bits_per_sample", None),
        channels=getattr(info, "channels", None),
        codec=codec,
        format=classify_format(path.suffix, codec, bitrate),
    )
    return data

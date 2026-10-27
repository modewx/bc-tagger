"""AIFF and AIFF-C served as WAV, without converting the file.

An AIFF keeps its samples as plain PCM in one ``SSND`` chunk: big-endian integers, or in AIFF-C
little-endian (``sowt``) or big-endian floats (``fl32``/``fl64``). ``read_layout`` finds where that data
is and how it's stored from the chunk headers (a few small reads); the index keeps the result
(``files.aiff_layout``). A stream then describes the file as a WAV (``wav_header``: 44 bytes, no read)
and serves any byte range by reading only that slice of the samples and reordering their bytes
(``to_wav``). Other AIFF-C compressions get ``wav_format() is None`` and are transcoded instead.
"""

from __future__ import annotations

import os
import struct
from dataclasses import dataclass
from typing import Any, BinaryIO

AIFF_EXTS = {".aif", ".aiff"}
WAV_HEADER_SIZE = 44
MAX_CHUNKS = 64  # a malformed file must not keep the walk reading

BIG_ENDIAN = {"NONE", "twos", "in24", "in32"}  # AIFF-C names for big-endian integer PCM (plain AIFF: NONE)
LITTLE_ENDIAN = {"sowt"}
UNSIGNED_8 = {"raw "}
FLOATS = {"fl32": 4, "FL32": 4, "fl64": 8, "FL64": 8}  # bytes per sample

_FLIP_SIGN = bytes((b ^ 0x80) for b in range(256))  # signed 8-bit (AIFF) <-> unsigned 8-bit (WAV)


def aiff_layout(path: str | os.PathLike, size: int) -> dict[str, Any] | None:
    """The layout of the AIFF at ``path`` (``size`` bytes long), or None if it isn't readable as one."""
    try:
        with open(path, "rb") as f:
            return read_layout(f, size)
    except (OSError, struct.error, ValueError):
        return None


def read_layout(f: BinaryIO, file_size: int) -> dict[str, Any] | None:
    """Walk the chunk headers of an open AIFF / AIFF-C file.

    Returns ``{container, compression, channels, bits, rate, frames, offset, size}``: ``offset`` and
    ``size`` are where the sample data starts in the file and how many bytes of it there are (whole
    frames, cut to what the file holds). None if it isn't an AIFF.
    """
    f.seek(0)
    head = f.read(12)
    if len(head) < 12 or head[:4] != b"FORM" or head[8:12] not in (b"AIFF", b"AIFC"):
        return None
    container = head[8:12].decode()
    comm = ssnd = None
    pos = 12
    for _ in range(MAX_CHUNKS):
        if (comm and ssnd) or pos + 8 > file_size:
            break
        f.seek(pos)
        hdr = f.read(8)
        if len(hdr) < 8:
            break
        cid, size = hdr[:4], struct.unpack(">L", hdr[4:])[0]
        if cid == b"COMM":
            comm = f.read(min(size, 64))
        elif cid == b"SSND":
            offset = struct.unpack(">L", f.read(8)[:4])[0]
            end = pos + 8 + size if size >= 8 else file_size  # some writers leave the size at 0
            ssnd = (pos + 16 + offset, min(end, file_size))
        pos += 8 + size + (size & 1)
    if comm is None or len(comm) < 18:
        return None
    channels, frames, bits = struct.unpack(">hLh", comm[:8])
    rate = round(_extended(comm[8:18]))
    compression = "NONE"
    if container == "AIFC" and len(comm) >= 22:
        compression = comm[18:22].decode("latin-1")
    layout = {"container": container, "compression": compression, "channels": channels, "bits": bits,
              "rate": rate, "frames": 0, "offset": 0, "size": 0}
    width = FLOATS.get(compression) or (bits + 7) // 8
    block = width * channels
    if ssnd and block > 0:
        start, end = ssnd
        size = max(0, min(frames * block, end - start))
        layout.update(frames=size // block, offset=start, size=size - size % block)
    return layout


def _extended(b: bytes) -> float:
    """An 80-bit IEEE 754 extended float (the AIFF sample rate)."""
    exp, mant = struct.unpack(">HQ", b)
    sign = -1.0 if exp & 0x8000 else 1.0
    exp &= 0x7FFF
    if exp == 0 and mant == 0:
        return 0.0
    return sign * mant * 2.0 ** (exp - 16383 - 63)


@dataclass(frozen=True)
class WavFormat:
    tag: int  # 1 = integer PCM, 3 = IEEE float
    width: int  # bytes per sample
    swap: bool  # big-endian samples: reverse each one's bytes
    flip_sign: bool  # signed 8-bit to WAV's unsigned 8-bit


def wav_format(layout: dict[str, Any]) -> WavFormat | None:
    """How the samples become WAV samples, or None if they can't without decoding (compressed)."""
    comp, channels, bits = layout["compression"], layout["channels"], layout["bits"]
    if not 1 <= channels <= 2 or layout["rate"] <= 0:
        return None
    if comp in FLOATS:
        return WavFormat(3, FLOATS[comp], True, False)
    if not 1 <= bits <= 32:
        return None
    width = (bits + 7) // 8
    if comp in BIG_ENDIAN:
        return WavFormat(1, width, width > 1, width == 1)
    if comp in LITTLE_ENDIAN:
        return WavFormat(1, width, False, width == 1)
    if comp in UNSIGNED_8 and width == 1:
        return WavFormat(1, 1, False, False)
    return None


def wav_header(layout: dict[str, Any], fmt: WavFormat) -> bytes:
    """The 44-byte header of the WAV the samples make (samples wider than ``bits`` keep their width)."""
    channels, rate, size = layout["channels"], layout["rate"], layout["size"]
    block = fmt.width * channels
    return (b"RIFF" + struct.pack("<L", 36 + size) + b"WAVE"
            + b"fmt " + struct.pack("<LHHLLHH", 16, fmt.tag, channels, rate, rate * block, block, fmt.width * 8)
            + b"data" + struct.pack("<L", size))


def to_wav(buf: bytes, fmt: WavFormat) -> bytes:
    """AIFF sample bytes (whole samples) as WAV sample bytes."""
    if fmt.flip_sign:
        return buf.translate(_FLIP_SIGN)
    if not fmt.swap:
        return buf
    w = fmt.width
    out = bytearray(len(buf))
    for k in range(w):
        out[k::w] = buf[w - 1 - k::w]
    return bytes(out)

"""Never write onto an unplugged drive.

With the drive unplugged, ``/Volumes/<name>`` is just a folder on the internal disk: creating anything
there fills the internal disk, and macOS later mounts the real drive as "<name> 1". So every write into a
root (downloads, XML output, rekordbox files) first checks that the volume is mounted and that the root
already exists, and folders are only ever created below an existing root, never above it.
"""

from __future__ import annotations

import ctypes
import logging
import os
import platform
import re
import subprocess
import sys
import threading
import time
import unicodedata
from pathlib import Path

log = logging.getLogger(__name__)

MOUNTS_TTL_S = 10.0
_MOUNT_LINE = re.compile(r"^.+? on (.+) \([^()]*\)$")
_mounts_lock = threading.Lock()
_mounts: tuple[float, frozenset[str] | None] | None = None


class NotMounted(OSError):
    pass


def volume_root(path: str | Path) -> Path | None:
    """``/Volumes/<name>`` for paths on another volume, else None."""
    parts = Path(path).expanduser().absolute().parts
    if len(parts) >= 3 and parts[0] == "/" and parts[1] == "Volumes":
        return Path("/Volumes", parts[2])
    return None


def _key(path: str | Path) -> str:
    return unicodedata.normalize("NFC", str(path)).casefold()


class _Statfs(ctypes.Structure):
    """macOS ``struct statfs`` (64-bit inodes), as ``getfsstat`` fills it."""

    _fields_ = [("f_bsize", ctypes.c_uint32), ("f_iosize", ctypes.c_int32), ("f_blocks", ctypes.c_uint64),
                ("f_bfree", ctypes.c_uint64), ("f_bavail", ctypes.c_uint64), ("f_files", ctypes.c_uint64),
                ("f_ffree", ctypes.c_uint64), ("f_fsid", ctypes.c_int32 * 2), ("f_owner", ctypes.c_uint32),
                ("f_type", ctypes.c_uint32), ("f_flags", ctypes.c_uint32), ("f_fssubtype", ctypes.c_uint32),
                ("f_fstypename", ctypes.c_char * 16), ("f_mntonname", ctypes.c_char * 1024),
                ("f_mntfromname", ctypes.c_char * 1024), ("f_flags_ext", ctypes.c_uint32),
                ("f_reserved", ctypes.c_uint32 * 7)]


MNT_NOWAIT = 2  # the kernel's cached list: no volume is asked for its statistics (a sleeping drive isn't woken)


def _getfsstat_mount_points() -> frozenset[str] | None:
    """The mount points from ``getfsstat(MNT_NOWAIT)``; None where that isn't available."""
    if sys.platform != "darwin" or ctypes.sizeof(_Statfs) != 2168:
        return None
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        fn = libc["getfsstat$INODE64"] if platform.machine() == "x86_64" else libc["getfsstat"]
    except (OSError, AttributeError):
        return None
    fn.argtypes, fn.restype = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int], ctypes.c_int
    for _ in range(3):  # volumes can come and go between the two calls
        n = fn(None, 0, MNT_NOWAIT)
        if n <= 0:
            return None
        buf = (_Statfs * (n + 4))()
        got = fn(buf, ctypes.sizeof(buf), MNT_NOWAIT)
        if 0 < got <= n + 4:
            points = frozenset(_key(os.fsdecode(buf[i].f_mntonname)) for i in range(got))
            return points if "/" in points else None
    return None


def _read_mount_table() -> frozenset[str] | None:
    """The mount points in the kernel's mount table: ``getfsstat`` with ``MNT_NOWAIT``, else the ``mount``
    command's list. None if neither works."""
    points = _getfsstat_mount_points()
    if points is not None:
        return points
    try:
        out = subprocess.run(["/sbin/mount"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError) as e:
        log.warning("can't read the mount table: %s", e)
        return None
    return parse_mount_output(out)


def parse_mount_output(text: str) -> frozenset[str]:
    """``/dev/disk5s1 on /Volumes/Stationary Backup (apfs, local, …)`` lines → their mount points (casefolded)."""
    return frozenset(_key(m.group(1)) for m in map(_MOUNT_LINE.match, text.splitlines()) if m)


def mount_points() -> frozenset[str] | None:
    """The mount table (casefolded), cached for ``MOUNTS_TTL_S``."""
    global _mounts
    with _mounts_lock:
        now = time.monotonic()
        if _mounts is None or now - _mounts[0] > MOUNTS_TTL_S:
            _mounts = (now, _read_mount_table())
        return _mounts[1]


def is_mounted(path: str | Path) -> bool:
    """Whether ``path``'s volume is mounted, read from the mount table: nothing on that volume is touched, so a
    sleeping drive stays asleep. Paths outside ``/Volumes`` are on the boot disk. Whether the folder exists is
    only checked by work the user started."""
    vol = volume_root(path)
    if vol is None:
        return True
    points = mount_points()
    if points is None:  # no mount table: ask the volume itself
        return os.path.ismount(os.path.realpath(vol))
    if _key(vol) in points:
        return True
    # not a mount point, so this lstat stays on the boot disk: "/Volumes/Macintosh HD" is a symlink to "/"
    return os.path.islink(vol) and volume_root(os.path.realpath(vol)) is None


def require_mounted(path: str | Path) -> None:
    vol = volume_root(path)
    # "/Volumes/Macintosh HD" is a symlink to "/": check what it points at
    if vol is not None and not os.path.ismount(os.path.realpath(vol)):
        raise NotMounted(f"music drive not mounted: {vol} (plug it in; nothing was written)")


def require_existing_root(root: str | Path) -> Path:
    root = Path(root).expanduser()
    require_mounted(root)
    if not root.is_dir():
        raise NotMounted(f"music drive not mounted? {root} doesn't exist (nothing was written)")
    return root


def ensure_dir_under(folder: str | Path, root: str | Path) -> Path:
    """Create ``folder`` (and what's between it and ``root``) only below an existing, mounted ``root``."""
    root = require_existing_root(root)
    folder = Path(folder).expanduser()
    real_root, real_folder = Path(os.path.realpath(root)), Path(os.path.realpath(folder))
    if real_folder != real_root and real_root not in real_folder.parents:
        raise NotMounted(f"{folder} isn't inside {root}")
    folder.mkdir(parents=True, exist_ok=True)
    return folder

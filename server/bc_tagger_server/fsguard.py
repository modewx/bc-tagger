"""Never write onto an unplugged drive.

With the drive unplugged, ``/Volumes/<name>`` is just a folder on the internal disk: creating anything
there fills the internal disk, and macOS later mounts the real drive as "<name> 1". So every write into a
root (downloads, XML output, rekordbox files) first checks that the volume is mounted and that the root
already exists, and folders are only ever created below an existing root, never above it.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
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


def _read_mount_table() -> frozenset[str] | None:
    """The mount points in the kernel's mount table. ``mount`` lists it without waiting on (or touching) any
    volume; None if it can't be read."""
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

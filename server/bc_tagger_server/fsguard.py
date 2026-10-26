"""Never write onto an unplugged drive.

With the drive unplugged, ``/Volumes/<name>`` is just a folder on the internal disk: creating anything
there fills the internal disk, and macOS later mounts the real drive as "<name> 1". So every write into a
root (downloads, XML output, rekordbox files) first checks that the volume is mounted and that the root
already exists, and folders are only ever created below an existing root, never above it.
"""

from __future__ import annotations

import os
from pathlib import Path


class NotMounted(OSError):
    pass


def volume_root(path: str | Path) -> Path | None:
    """``/Volumes/<name>`` for paths on another volume, else None."""
    parts = Path(path).expanduser().absolute().parts
    if len(parts) >= 3 and parts[0] == "/" and parts[1] == "Volumes":
        return Path("/Volumes", parts[2])
    return None


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

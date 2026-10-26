"""Settings and well-known paths.

Settings live in ``<data_dir>/settings.json``. The data dir defaults to
``~/Library/Application Support/bc-tagger`` and can be overridden with the
``BC_TAGGER_DATA_DIR`` environment variable (tests always do this).
"""

from __future__ import annotations

import copy
import json
import os
import threading
from pathlib import Path
from typing import Any

HOME = Path.home()
PROJECT_ROOT = Path("/Users/alvaroh/Projects/auto-rekordbox")

# The user's MAIN rekordbox library. Never written, never read.
MAIN_LIBRARY_DIR = HOME / "Library" / "Pioneer" / "rekordbox"
TEST_LIBRARY_DIR = HOME / "Library" / "Pioneer" / "rekordbox_test"
REKORDBOX_OPTIONS_JSON = (
    HOME / "Library" / "Application Support" / "Pioneer" / "rekordboxAgent" / "storage" / "options.json"
)
# The real music drive: reading/indexing is fine, writing never.
PROTECTED_VOLUME = Path("/Volumes/Stationary Backup")

TEST_OWNED_ROOT = PROJECT_ROOT / "test-downloads"
TEST_NOT_OWNED_ROOT = PROJECT_ROOT / "test-tracks"
PROD_OWNED_ROOT = PROTECTED_VOLUME / "Music" / "Collection"
PROD_NOT_OWNED_ROOT = PROTECTED_VOLUME / "soulseek" / "complete"

DEFAULT_EXPORT_JSON = PROJECT_ROOT / "tagger-test-db" / "bc-tagger-export-2026-10-26.json"
DEFAULT_COOKIES_FILE = PROJECT_ROOT / "cookies" / "bandcamp.com_cookies_10:2026.txt"
DEFAULT_DOWNLOADER_DIR = PROJECT_ROOT / "bandcamp-collection-downloader"
DEV_EXTENSION_BUILD_DIR = PROJECT_ROOT / "dev-extension-build"

DEFAULT_PORT = 8765

FORMAT_PREFERENCE = ["aiff", "flac", "wav", "alac", "m4a", "mp3-320", "other"]

PRESETS: dict[str, dict[str, Any]] = {
    "test": {
        "owned_root": str(TEST_OWNED_ROOT),
        "not_owned_roots": [{"path": str(TEST_NOT_OWNED_ROOT), "globs": []}],
    },
    "production": {
        "owned_root": str(PROD_OWNED_ROOT),
        "not_owned_roots": [{"path": str(PROD_NOT_OWNED_ROOT), "globs": []}],
    },
}

DEFAULT_SETTINGS: dict[str, Any] = {
    # Which root preset the paths below came from ("test" | "production" | "custom").
    "roots_preset": "test",
    "owned_root": PRESETS["test"]["owned_root"],
    "not_owned_roots": copy.deepcopy(PRESETS["test"]["not_owned_roots"]),
    "rekordbox_db_path": str(TEST_LIBRARY_DIR / "master.db"),
    "playlist_folder": "bc-tagger",
    "server_port": DEFAULT_PORT,
    "cookies_file": str(DEFAULT_COOKIES_FILE),
    "bandcamp_username": "herrasti",
    "format_preference": list(FORMAT_PREFERENCE),
    # Auto-accept a match at or above this confidence (0..1).
    "match_threshold": 0.85,
    # Keep candidates at or above this confidence for the user to confirm.
    "candidate_threshold": 0.6,
    # Seed for the items mirror until the extension pushes its own data.
    "seed_export_json": str(DEFAULT_EXPORT_JSON),
    # Where the built local app (Session B) lives; served at "/".
    "app_dist_dir": "",
    "xml_output_dir": "",
    "downloads_dir": str(TEST_OWNED_ROOT),
    "downloader_dir": str(DEFAULT_DOWNLOADER_DIR),
    "dev_extension_build_dir": str(DEV_EXTENSION_BUILD_DIR),
}

# Keys the API refuses to change (they are safety-relevant or derived).
READ_ONLY_KEYS: set[str] = set()


def data_dir() -> Path:
    env = os.environ.get("BC_TAGGER_DATA_DIR")
    path = Path(env).expanduser() if env else HOME / "Library" / "Application Support" / "bc-tagger"
    path.mkdir(parents=True, exist_ok=True)
    return path


def default_app_dist_dir() -> Path:
    # server/bc_tagger_server/config.py -> repo root -> app/dist
    return Path(__file__).resolve().parents[2] / "app" / "dist"


class SettingsError(ValueError):
    pass


def _validate(merged: dict[str, Any]) -> dict[str, Any]:
    out = dict(merged)
    if not isinstance(out.get("owned_root"), str):
        raise SettingsError("owned_root must be a string path")
    roots = out.get("not_owned_roots")
    if not isinstance(roots, list):
        raise SettingsError("not_owned_roots must be a list")
    norm_roots = []
    for r in roots:
        if isinstance(r, str):
            r = {"path": r, "globs": []}
        if not isinstance(r, dict) or not isinstance(r.get("path"), str):
            raise SettingsError("each not_owned_roots entry needs a 'path'")
        globs = r.get("globs") or []
        if not isinstance(globs, list) or not all(isinstance(g, str) for g in globs):
            raise SettingsError("globs must be a list of strings")
        norm_roots.append({"path": r["path"], "globs": globs})
    out["not_owned_roots"] = norm_roots
    for key in ("match_threshold", "candidate_threshold"):
        v = float(out[key])
        if not 0 <= v <= 1:
            raise SettingsError(f"{key} must be between 0 and 1")
        out[key] = v
    if out["candidate_threshold"] > out["match_threshold"]:
        raise SettingsError("candidate_threshold must not exceed match_threshold")
    port = int(out["server_port"])
    if not 1024 <= port <= 65535:
        raise SettingsError("server_port must be between 1024 and 65535")
    out["server_port"] = port
    name = str(out.get("playlist_folder") or "").strip()
    if not name:
        raise SettingsError("playlist_folder must not be empty")
    out["playlist_folder"] = name
    pref = out.get("format_preference")
    if not isinstance(pref, list) or not all(isinstance(p, str) for p in pref):
        raise SettingsError("format_preference must be a list of strings")
    return out


class Settings:
    """Thread-safe JSON-backed settings."""

    def __init__(self, path: Path | None = None):
        self.path = path or data_dir() / "settings.json"
        self._lock = threading.Lock()
        self._data = self._load()

    def _load(self) -> dict[str, Any]:
        data = copy.deepcopy(DEFAULT_SETTINGS)
        if self.path.exists():
            try:
                stored = json.loads(self.path.read_text())
                data.update({k: v for k, v in stored.items() if k in DEFAULT_SETTINGS})
            except (OSError, json.JSONDecodeError):
                pass
        return _validate(data)

    def all(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._data)

    def get(self, key: str) -> Any:
        with self._lock:
            return copy.deepcopy(self._data[key])

    def update(self, changes: dict[str, Any]) -> dict[str, Any]:
        unknown = set(changes) - set(DEFAULT_SETTINGS)
        if unknown:
            raise SettingsError(f"unknown settings: {sorted(unknown)}")
        blocked = set(changes) & READ_ONLY_KEYS
        if blocked:
            raise SettingsError(f"read-only settings: {sorted(blocked)}")
        with self._lock:
            merged = _validate({**self._data, **changes})
            self._data = merged
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(merged, indent=2))
            tmp.replace(self.path)
            return copy.deepcopy(merged)

    # Convenience accessors -------------------------------------------------------

    def roots(self) -> list[dict[str, Any]]:
        """All scan roots with their kind ("owned" | "not_owned")."""
        data = self.all()
        out = []
        if data["owned_root"]:
            out.append({"path": data["owned_root"], "globs": [], "kind": "owned"})
        for r in data["not_owned_roots"]:
            out.append({"path": r["path"], "globs": r.get("globs", []), "kind": "not_owned"})
        return out

    def app_dist_dir(self) -> Path:
        configured = self.get("app_dist_dir")
        return Path(configured).expanduser() if configured else default_app_dist_dir()

    def xml_output_dir(self) -> Path:
        configured = self.get("xml_output_dir")
        return Path(configured).expanduser() if configured else data_dir() / "exports"

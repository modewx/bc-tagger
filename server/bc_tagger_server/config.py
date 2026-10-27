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

# The user's MAIN rekordbox library. Only written in "main" target mode (Phase 2), which the
# user switches on in settings; never written or read by test-mode code.
MAIN_LIBRARY_DIR = HOME / "Library" / "Pioneer" / "rekordbox"
# Where rb-switch-library.sh parks the main library while the test library is switched in.
PARKED_MAIN_LIBRARY_DIR = HOME / "Library" / "Pioneer" / "rekordbox_main"
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
    # More roots of either kind, e.g. the test folders next to the production preset:
    # [{"path": ..., "globs": [...], "kind": "owned" | "not_owned"}]
    "extra_roots": [],
    # The test library (needs the marker file). Exports go here while rekordbox_target is "test".
    "rekordbox_db_path": str(TEST_LIBRARY_DIR / "master.db"),
    # "test" | "main": the library exports and transfers use (reads: the playlist tree, dry runs). A free choice;
    # writing to "main" additionally needs allow_main_writes (else the dry run shows it locked).
    "rekordbox_target": "test",
    "allow_main_writes": False,
    "rekordbox_main_db_path": str(MAIN_LIBRARY_DIR / "master.db"),
    # Folder for plain playlist names (and for every tag in "auto" mode).
    "playlist_folder": "bc-tagger",
    # "auto": tag -> playlist named like the tag inside playlist_folder.
    # "custom": tag_playlist_map {tag: [playlist, ...]}; a tag with no playlists isn't exported.
    #   "Name" = inside playlist_folder, "a/b" = path below playlist_folder, "/a/b" = from the root.
    "tag_playlist_mode": "auto",
    "tag_playlist_map": {},
    "server_port": DEFAULT_PORT,
    "cookies_file": str(DEFAULT_COOKIES_FILE),
    "bandcamp_username": "herrasti",
    "format_preference": list(FORMAT_PREFERENCE),
    # Auto-accept a match at or above this confidence (0..1).
    "match_threshold": 0.85,
    # Keep candidates at or above this confidence for the user to confirm.
    "candidate_threshold": 0.6,
    # Locate/Export run a quick scan of files created/changed since the selected items'
    # tag dates minus this many days; full scans are manual only.
    "quick_scan_margin_days": 2,
    # Suggest a manual full rescan when the last one is older than this.
    "full_rescan_hint_days": 30,
    # Imports: seconds between the server's Bandcamp requests (one at a time; read before each one).
    "bandcamp_request_interval_s": 1.0,
    # Which migrations this file has had (set by the server, not by clients).
    "settings_version": 2,
    # The folder of the last file picked by hand for an import row (the file browser opens there).
    "last_browse_dir": "",
    # The browser side (extension / app shared code) reads these for its own Bandcamp fetches.
    "bandcamp_browser_concurrency": 2,
    "bandcamp_browser_spacing_ms": 400,
    # Seed for the items mirror until the extension pushes its own data.
    "seed_export_json": str(DEFAULT_EXPORT_JSON),
    # Where the built local app (Session B) lives; served at "/".
    "app_dist_dir": "",
    "xml_output_dir": "",
    # Downloads of owned releases (Phase 4); empty: the owned root. Must be inside an owned root.
    "downloads_dir": "",
    "download_format": "aiff-lossless",
    # Several releases go to one downloader run with this many parallel downloads (its --jobs), 1–8.
    "download_parallel": 4,
    # The downloader's HTTP read/connect timeout (its --timeout), seconds; at least 30.
    "download_timeout_s": 180,
    # Imports: a JSON + Markdown log of each commit goes here; empty: <data dir>/import-logs. Never on the
    # music drive or inside a root.
    "import_log_dir": "",
    # Opt-in file watcher (docs/fsevents-watcher.md): keeps the index current while the server runs.
    "watch_roots": False,
    "watch_debounce_seconds": 3,
    # Imports: where rows are looked up: "bandcamp" (default), "musicbrainz" (hints only) or "both".
    "lookup_source": "bandcamp",
    "downloader_dir": str(DEFAULT_DOWNLOADER_DIR),
    # Empty: <downloader_dir>/build/libs/bandcamp-collection-downloader.jar, then ~/Scripts/bc-download/...
    "downloader_jar": "",
    "dev_extension_build_dir": str(DEV_EXTENSION_BUILD_DIR),
}

# Keys the API refuses to change (they are safety-relevant or derived).
READ_ONLY_KEYS: set[str] = set()
# Bumped when a stored default changes meaning; files from before are migrated on load.
# 2: bandcamp_request_interval_s default 2.5 → 1.0.
SETTINGS_VERSION = 2


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


def check_playlist_name(name: str) -> None:
    """'Name', 'Folder/Name' or '/Root/Folder/Name'; no empty segments."""
    body = name[1:] if name.startswith("/") else name
    if not body or any(not part.strip() for part in body.split("/")):
        raise SettingsError(f"invalid playlist name {name!r} (empty path segment)")


def _check_downloads_dir(settings: dict[str, Any]) -> None:
    """``downloads_dir`` (when set) must be inside an owned root."""
    value = (settings.get("downloads_dir") or "").strip()
    if not value:
        return
    folder = Path(value).expanduser().resolve()
    owned = [Path(settings["owned_root"]).expanduser().resolve()] + [
        Path(r["path"]).expanduser().resolve() for r in settings.get("extra_roots") or [] if r.get("kind") == "owned"]
    if not any(folder == o or o in folder.parents for o in owned):
        raise SettingsError(f"downloads_dir must be inside an owned root ({', '.join(map(str, owned))})")


def _check_import_log_dir(settings: dict[str, Any]) -> None:
    """``import_log_dir`` (when set) must not be inside a root or on a music root's drive."""
    value = settings.get("import_log_dir") or ""
    if not value:
        return
    problem = import_log_dir_problem(Path(value), all_root_paths(settings))
    if problem:
        raise SettingsError(problem)


def all_root_paths(settings: dict[str, Any]) -> list[str]:
    paths = [settings.get("owned_root") or "", settings.get("downloads_dir") or ""]
    paths += [r["path"] for r in settings.get("not_owned_roots") or []]
    paths += [r["path"] for r in settings.get("extra_roots") or []]
    return [p for p in paths if p]


def import_log_dir_problem(folder: Path, roots: list[str], resolve: bool = True) -> str | None:
    """Why ``folder`` can't hold import logs (inside a root, or on a music root's drive), else None.
    ``resolve=False`` compares the paths as written: resolving symlinks would read the music drive."""
    from .fsguard import volume_root

    real_path = os.path.realpath if resolve else os.path.abspath
    folder = Path(real_path(Path(folder).expanduser()))
    for root in roots:
        real = Path(real_path(Path(root).expanduser()))
        if folder == real or real in folder.parents:
            return f"import_log_dir can't be inside a music root ({root})"
        vol = volume_root(root)
        if vol is not None and volume_root(folder) == vol:
            return f"import_log_dir can't be on the music drive ({vol})"
    return None


def _validate(merged: dict[str, Any]) -> dict[str, Any]:
    out = dict(merged)
    out["settings_version"] = SETTINGS_VERSION
    out["watch_roots"] = bool(out.get("watch_roots"))
    try:
        debounce = float(out.get("watch_debounce_seconds"))
    except (TypeError, ValueError):
        raise SettingsError("watch_debounce_seconds must be a number") from None
    if debounce < 0.5:
        raise SettingsError("watch_debounce_seconds must be at least 0.5")
    out["watch_debounce_seconds"] = debounce
    if out.get("lookup_source") not in ("bandcamp", "musicbrainz", "both"):
        raise SettingsError("lookup_source must be bandcamp, musicbrainz or both")
    if out.get("download_format") not in ("flac", "wav", "aac-hi", "mp3-320", "aiff-lossless", "vorbis", "mp3-v0", "alac"):
        raise SettingsError("download_format must be one of the downloader's audio formats")
    out["downloads_dir"] = out.get("downloads_dir") or ""
    parallel = out.get("download_parallel")
    if isinstance(parallel, bool) or not isinstance(parallel, int) or not 1 <= parallel <= 8:
        raise SettingsError("download_parallel must be a whole number from 1 to 8")
    timeout = out.get("download_timeout_s")
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout < 30:
        raise SettingsError("download_timeout_s must be a number of seconds, at least 30")
    out["import_log_dir"] = out.get("import_log_dir") or ""
    if not isinstance(out["import_log_dir"], str):
        raise SettingsError("import_log_dir must be a string path")
    if out.get("last_browse_dir") is None:
        out["last_browse_dir"] = ""  # cleared
    if not isinstance(out["last_browse_dir"], str):
        raise SettingsError("last_browse_dir must be a string path")
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
    extra = out.get("extra_roots") or []
    if not isinstance(extra, list):
        raise SettingsError("extra_roots must be a list")
    norm_extra = []
    for r in extra:
        if not isinstance(r, dict) or not isinstance(r.get("path"), str):
            raise SettingsError("each extra_roots entry needs a 'path'")
        if r.get("kind") not in ("owned", "not_owned"):
            raise SettingsError("extra_roots kind must be 'owned' or 'not_owned'")
        globs = r.get("globs") or []
        if not isinstance(globs, list) or not all(isinstance(g, str) for g in globs):
            raise SettingsError("globs must be a list of strings")
        norm_extra.append({"path": r["path"], "globs": globs, "kind": r["kind"]})
    out["extra_roots"] = norm_extra
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
    for key in ("quick_scan_margin_days", "full_rescan_hint_days"):
        try:
            v = float(out[key])
        except (TypeError, ValueError):
            raise SettingsError(f"{key} must be a number") from None
        if v < 0:
            raise SettingsError(f"{key} must not be negative")
        out[key] = int(v) if v == int(v) else v
    try:
        interval = float(out["bandcamp_request_interval_s"])
    except (TypeError, ValueError):
        raise SettingsError("bandcamp_request_interval_s must be a number") from None
    if interval < 0.1:
        raise SettingsError("bandcamp_request_interval_s must be at least 0.1")
    out["bandcamp_request_interval_s"] = interval
    for key, low, high in (("bandcamp_browser_concurrency", 1, 4), ("bandcamp_browser_spacing_ms", 100, None)):
        try:
            v = float(out[key])
        except (TypeError, ValueError):
            raise SettingsError(f"{key} must be a number") from None
        if v != int(v) or v < low or (high is not None and v > high):
            raise SettingsError(f"{key} must be a whole number " + (f"from {low} to {high}" if high else f"of at least {low}"))
        out[key] = int(v)
    if out.get("rekordbox_target") not in ("test", "main"):
        raise SettingsError("rekordbox_target must be 'test' or 'main'")
    if not isinstance(out.get("allow_main_writes"), bool):
        raise SettingsError("allow_main_writes must be true or false")
    if not isinstance(out.get("rekordbox_main_db_path"), str) or not out["rekordbox_main_db_path"].strip():
        raise SettingsError("rekordbox_main_db_path must be a path")
    if out.get("tag_playlist_mode") not in ("auto", "custom"):
        raise SettingsError("tag_playlist_mode must be 'auto' or 'custom'")
    mapping = out.get("tag_playlist_map")
    if not isinstance(mapping, dict):
        raise SettingsError("tag_playlist_map must be an object {tag: [playlist, ...]}")
    clean_map: dict[str, list[str]] = {}
    for tag, names in mapping.items():
        if isinstance(names, str):
            names = [names]
        if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
            raise SettingsError(f"tag_playlist_map[{tag!r}] must be a list of playlist names")
        cleaned = []
        for n in names:
            n = n.strip()
            if not n:
                continue
            check_playlist_name(n)
            if n not in cleaned:
                cleaned.append(n)
        clean_map[str(tag)] = cleaned
    out["tag_playlist_map"] = clean_map
    pref = out.get("format_preference")
    if not isinstance(pref, list) or not all(isinstance(p, str) for p in pref):
        raise SettingsError("format_preference must be a list of strings")
    return out


class Settings:
    """Thread-safe JSON-backed settings."""

    def __init__(self, path: Path | None = None):
        self.path = path or data_dir() / "settings.json"
        self._lock = threading.Lock()
        self._mtime: float | None = None
        self._data = self._load()

    def _file_mtime(self) -> float | None:
        try:
            return self.path.stat().st_mtime
        except OSError:
            return None

    def _fresh(self) -> dict[str, Any]:
        """The settings, reloaded if another process (CLI or server) changed the file."""
        if self._file_mtime() != self._mtime:
            self._data = self._load()
        return self._data

    def _load(self) -> dict[str, Any]:
        data = copy.deepcopy(DEFAULT_SETTINGS)
        self._mtime = self._file_mtime()
        if self.path.exists():
            try:
                stored = json.loads(self.path.read_text())
                data.update({k: v for k, v in stored.items() if k in DEFAULT_SETTINGS})
                if stored.get("settings_version", 1) < 2 and stored.get("bandcamp_request_interval_s") == 2.5:
                    data["bandcamp_request_interval_s"] = 1.0  # 2.5 was only the old default
            except (OSError, json.JSONDecodeError):
                pass
        return _validate(data)

    def all(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._fresh())

    def get(self, key: str) -> Any:
        with self._lock:
            return copy.deepcopy(self._fresh()[key])

    def update(self, changes: dict[str, Any]) -> dict[str, Any]:
        unknown = set(changes) - set(DEFAULT_SETTINGS)
        if unknown:
            raise SettingsError(f"unknown settings: {sorted(unknown)}")
        blocked = set(changes) & READ_ONLY_KEYS
        if blocked:
            raise SettingsError(f"read-only settings: {sorted(blocked)}")
        with self._lock:
            changes = dict(changes)
            merged = _validate({**self._fresh(), **changes})
            if "downloads_dir" in changes:
                _check_downloads_dir(merged)
            if changes.keys() & {"import_log_dir", "owned_root", "not_owned_roots", "extra_roots", "downloads_dir"}:
                _check_import_log_dir(merged)
            self._data = merged
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(merged, indent=2))
            tmp.replace(self.path)
            self._mtime = self._file_mtime()
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
        out += [dict(r) for r in data["extra_roots"]]
        seen: set[str] = set()
        unique = []
        for r in out:
            key = str(Path(r["path"]).expanduser())
            if key not in seen:
                seen.add(key)
                unique.append(r)
        return unique

    def app_dist_dir(self) -> Path:
        configured = self.get("app_dist_dir")
        return Path(configured).expanduser() if configured else default_app_dist_dir()

    def import_log_dir(self) -> Path:
        """Where import logs go: the setting, else ``import-logs`` next to settings.json (the data dir)."""
        configured = self.get("import_log_dir")
        return Path(configured).expanduser() if configured else self.path.parent / "import-logs"

    def xml_output_dir(self) -> Path:
        configured = self.get("xml_output_dir")
        return Path(configured).expanduser() if configured else data_dir() / "exports"

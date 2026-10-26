"""Write guard, backups and guarded commits for rekordbox ``master.db`` files.

Test mode (default; see LOCAL_COLLECTION_PLAN.md, "Hard safety rules"):

* Never open anything inside the main library (``~/Library/Pioneer/rekordbox``, or
  ``rekordbox_main`` while the test library is switched in), not even to read it, and never
  write under ``/Volumes/Stationary Backup``.
* Only write a DB whose folder holds the marker file ``.bc-tagger-test-library``.
* pyrekordbox's ``commit()`` refuses while any rekordbox process runs. We bypass that check
  only when the target has the marker AND differs from ``options.json``'s ``db-path``
  (i.e. rekordbox has some other library open). Otherwise we refuse.
* Back up the target before every write.
* Always open DBs by explicit path; never let pyrekordbox auto-detect.

Main mode (Phase 2: the user's own collection, switched on in settings only):

* Writes only when ``allow_main_writes`` is on (re-read at every check) and the path is the
  configured ``rekordbox_main_db_path``; there is no per-request override.
* Refuses while any rekordbox process runs (no bypass) and when the folder holds the test
  marker (the test library is switched in).
* Backs up ``master.db`` (+ -wal/-shm) and ``masterPlaylists6.xml`` to
  ``<data dir>/backups/main/<timestamp>/`` before every write, keeping the last 5.
* Reads (dry runs, the playlist tree) use a snapshot copy, never the live file.
"""

from __future__ import annotations

import json
import logging
import shutil
import threading
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator
from unittest import mock

from .config import (
    MAIN_LIBRARY_DIR,
    PARKED_MAIN_LIBRARY_DIR,
    PROTECTED_VOLUME,
    REKORDBOX_OPTIONS_JSON,
    data_dir,
)

log = logging.getLogger(__name__)

MARKER_NAME = ".bc-tagger-test-library"
BACKUP_DIRNAME = "backups"
KEEP_BACKUPS = 50
KEEP_MAIN_BACKUPS = 5
PLAYLIST_XML = "masterPlaylists6.xml"

_UNSET: Any = object()
_commit_lock = threading.Lock()


class WriteRefused(RuntimeError):
    """The write guard refused to touch a rekordbox database."""


@dataclass
class GuardDecision:
    allowed: bool
    reason: str
    target: str
    rekordbox_running: bool = False
    options_db_path: str | None = None
    # True when rekordbox is running on another library and the commit check is bypassed.
    bypass_running_check: bool = False
    mode: str = "test"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def resolve(path: str | Path) -> Path:
    return Path(path).expanduser().resolve()


def is_within(child: Path, parent: Path) -> bool:
    child, parent = resolve(child), resolve(parent)
    return child == parent or parent in child.parents


def is_test_library(db_path: str | Path, main_dir: Path = MAIN_LIBRARY_DIR) -> bool:
    p = resolve(db_path)
    return (p.parent / MARKER_NAME).is_file() and not is_within(p, main_dir)


def rekordbox_running() -> bool:
    """True if any process named ``rekordbox`` runs (same check pyrekordbox's commit uses)."""
    from pyrekordbox.utils import get_rekordbox_pid

    return bool(get_rekordbox_pid())


def options_db_path(options_file: Path = REKORDBOX_OPTIONS_JSON) -> Path | None:
    """The DB rekordbox opens (``db-path`` in ``options.json``); None if unreadable."""
    try:
        data = json.loads(Path(options_file).read_text())
        for key, value in data.get("options", []):
            if key == "db-path" and value:
                return resolve(value)
    except (OSError, ValueError, TypeError) as e:
        log.warning("Could not read rekordbox options.json: %s", e)
    return None


def check_write(
    db_path: str | Path,
    *,
    running: bool | None = None,
    options_db: Path | None = _UNSET,
    main_dir: Path = MAIN_LIBRARY_DIR,
    protected_dirs: tuple[Path, ...] = (PROTECTED_VOLUME,),
) -> GuardDecision:
    target = resolve(db_path)
    t = str(target)
    for d in (main_dir, PARKED_MAIN_LIBRARY_DIR):
        if is_within(target, d):
            return GuardDecision(False, f"refusing: {t} is inside the main rekordbox library {d}", t)
    for d in protected_dirs:
        if is_within(target, d):
            return GuardDecision(False, f"refusing: {t} is on the protected volume {d}", t)
    if not target.is_file():
        return GuardDecision(False, f"refusing: {t} does not exist", t)
    if not (target.parent / MARKER_NAME).is_file():
        return GuardDecision(
            False, f"refusing: no {MARKER_NAME} marker in {target.parent} (not a test library)", t
        )
    is_running = rekordbox_running() if running is None else running
    if not is_running:
        return GuardDecision(True, "ok: test library, rekordbox not running", t)
    opts = options_db_path() if options_db is _UNSET else options_db
    if opts is None:
        return GuardDecision(
            False,
            "refusing: rekordbox is running and options.json db-path is unknown, "
            "so it may have this DB open",
            t,
            rekordbox_running=True,
        )
    opts = resolve(opts)
    if opts == target:
        return GuardDecision(
            False,
            f"refusing: rekordbox is running with this DB open ({opts})",
            t,
            rekordbox_running=True,
            options_db_path=str(opts),
        )
    return GuardDecision(
        True,
        f"ok: rekordbox is running on another library ({opts}); bypassing pyrekordbox's running check",
        t,
        rekordbox_running=True,
        options_db_path=str(opts),
        bypass_running_check=True,
    )


def require_write(db_path: str | Path, **kwargs: Any) -> GuardDecision:
    decision = check_write(db_path, **kwargs)
    if not decision.allowed:
        raise WriteRefused(decision.reason)
    return decision


def backup(db_path: str | Path, keep: int = KEEP_BACKUPS, **guard_kwargs: Any) -> Path:
    """Copy ``master.db`` (and any -wal/-shm) to ``<db dir>/backups/master_<ts>.db``."""
    require_write(db_path, **guard_kwargs)
    src = resolve(db_path)
    bdir = src.parent / BACKUP_DIRNAME
    bdir.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = bdir / f"{src.stem}_{stamp}{src.suffix}"
    n = 1
    while dest.exists():
        dest = bdir / f"{src.stem}_{stamp}_{n}{src.suffix}"
        n += 1
    shutil.copy2(src, dest)
    for side in ("-wal", "-shm"):
        extra = src.with_name(src.name + side)
        if extra.exists():
            shutil.copy2(extra, dest.with_name(dest.name + side))
    _prune_backups(bdir, src.stem, keep)
    log.info("Backed up %s -> %s", src, dest)
    return dest


def _prune_backups(bdir: Path, stem: str, keep: int) -> None:
    backups = sorted(bdir.glob(f"{stem}_*.db"), key=lambda p: p.stat().st_mtime)
    for old in backups[:-keep] if keep > 0 else []:
        for p in (old, old.with_name(old.name + "-wal"), old.with_name(old.name + "-shm")):
            p.unlink(missing_ok=True)


def open_by_other_process(path: Path) -> list[str]:
    """Processes holding the DB (or its -wal/-shm) open, via lsof; empty if none."""
    import subprocess

    targets = [str(p) for p in (path, path.with_name(path.name + "-wal"), path.with_name(path.name + "-shm")) if p.exists()]
    if not targets:
        return []
    proc = subprocess.run(["lsof", "-F", "pc", *targets], capture_output=True, text=True)
    holders, pid = [], None
    for line in proc.stdout.splitlines():
        if line.startswith("p"):
            pid = line[1:]
        elif line.startswith("c") and pid:
            holders.append(f"{line[1:]} (pid {pid})")
    return sorted(set(holders))


def restore(db_path: str | Path, backup_path: str | Path, **guard_kwargs: Any) -> dict[str, Any]:
    """Replace the test DB with one of its backups (backing up the current DB first)."""
    target = resolve(db_path)
    src = resolve(backup_path)
    require_write(target, **guard_kwargs)
    if not src.is_file() or src.parent != target.parent / BACKUP_DIRNAME:
        raise WriteRefused(f"refusing: {src} is not a backup in {target.parent / BACKUP_DIRNAME}")
    holders = open_by_other_process(target)
    if holders:
        raise WriteRefused(f"refusing: the DB is open in {', '.join(holders)}")
    safety = backup(target, **guard_kwargs)
    with _commit_lock:
        tmp = target.with_name(target.name + ".restoring")
        shutil.copy2(src, tmp)
        for side in ("-wal", "-shm"):
            target.with_name(target.name + side).unlink(missing_ok=True)
            extra = src.with_name(src.name + side)
            if extra.exists():
                shutil.copy2(extra, target.with_name(target.name + side))
        tmp.replace(target)
    log.info("Restored %s from %s (previous state saved as %s)", target, src, safety)
    return {"db_path": str(target), "restored_from": str(src), "previous_saved_as": str(safety)}


# -- main mode ---------------------------------------------------------------------------------


def _allowed(allow: Any) -> bool:
    return bool(allow() if callable(allow) else allow)


def check_write_main(
    db_path: str | Path,
    *,
    allow: Any,
    configured: str | Path,
    running: bool | None = None,
    protected_dirs: tuple[Path, ...] = (PROTECTED_VOLUME,),
) -> GuardDecision:
    """Guard for writing the user's main collection (``allow`` may be a callable, re-read here)."""
    target = resolve(db_path)
    t = str(target)

    def refuse(reason: str, **kw: Any) -> GuardDecision:
        return GuardDecision(False, f"refusing: {reason}", t, mode="main", **kw)

    if not _allowed(allow):
        return refuse("writing to the main collection is turned off (Settings → Rekordbox)")
    configured_path = resolve(configured() if callable(configured) else configured)
    if target != configured_path:
        return refuse(f"{t} is not the configured main collection ({configured_path})")
    for d in protected_dirs:
        if is_within(target, d):
            return refuse(f"{t} is on the protected volume {d}")
    if not target.is_file():
        return refuse(f"{t} does not exist")
    if (target.parent / MARKER_NAME).is_file():
        return refuse(
            f"{target.parent} holds the test library (marker file found). "
            "Run `server/scripts/rb-switch-library.sh main` first"
        )
    is_running = rekordbox_running() if running is None else running
    if is_running:
        return refuse("rekordbox is running. Quit rekordbox before writing to your collection", rekordbox_running=True)
    return GuardDecision(True, "ok: main collection, writes allowed, rekordbox not running", t, mode="main")


def require_write_main(db_path: str | Path, **kwargs: Any) -> GuardDecision:
    decision = check_write_main(db_path, **kwargs)
    if not decision.allowed:
        raise WriteRefused(decision.reason)
    return decision


def _copy_db_files(src: Path, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)
    for f in (src, src.with_name(src.name + "-wal"), src.with_name(src.name + "-shm"), src.parent / PLAYLIST_XML):
        if f.exists():
            shutil.copy2(f, dest_dir / f.name)


def backup_main(db_path: str | Path, root: Path | None = None, keep: int = KEEP_MAIN_BACKUPS, **guard_kwargs: Any) -> Path:
    """Copy master.db (+ -wal/-shm) and masterPlaylists6.xml outside the rekordbox folder."""
    require_write_main(db_path, **guard_kwargs)
    src = resolve(db_path)
    root = root or data_dir() / "backups" / "main"
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = root / stamp
    n = 1
    while dest.exists():
        dest = root / f"{stamp}_{n}"
        n += 1
    _copy_db_files(src, dest)
    for old in sorted((d for d in root.iterdir() if d.is_dir()), key=lambda d: d.name)[:-keep]:
        shutil.rmtree(old, ignore_errors=True)
    log.info("Backed up the main collection %s -> %s", src, dest)
    return dest


def snapshot(db_path: str | Path, root: Path | None = None) -> Path:
    """A read-only working copy of a library (refreshed when the source changes).

    Used for every read of the main collection, so dry runs and the playlist tree never open
    the live file (opening a WAL database can create -wal/-shm files next to it).
    """
    src = resolve(db_path)
    if not src.is_file():
        raise FileNotFoundError(src)
    import hashlib

    root = root or data_dir() / "snapshots"
    dest = root / hashlib.sha1(str(src).encode()).hexdigest()[:12]
    stamp_file = dest / ".source"
    files = [f for f in (src, src.with_name(src.name + "-wal"), src.parent / PLAYLIST_XML) if f.exists()]
    stamp = json.dumps([[f.name, f.stat().st_size, f.stat().st_mtime] for f in files])
    with _commit_lock:
        if not (stamp_file.is_file() and stamp_file.read_text() == stamp):
            if dest.exists():
                shutil.rmtree(dest)
            _copy_db_files(src, dest)
            stamp_file.write_text(stamp)
    return dest / src.name


def source_fingerprint(db_path: str | Path) -> str:
    """Size + mtime of the DB files: changes whenever rekordbox (or anything) writes them."""
    src = resolve(db_path)
    files = [f for f in (src, src.with_name(src.name + "-wal"), src.parent / PLAYLIST_XML) if f.exists()]
    return json.dumps([[f.name, f.stat().st_size, f.stat().st_mtime_ns] for f in files])


def _quiet_pyrekordbox() -> None:
    """pyrekordbox adds its own console handler and warns "Rekordbox is running!" /
    "No masterPlaylists6.xml" on every open; route it through our logging, errors only.

    Also switch off its auto-detection: MasterDatabase() reads rekordbox's settings and
    options.json on every open (even with an explicit path) and asserts they agree, which
    fails after library switching. We always pass explicit paths, so it gets a stub config.
    """
    import pyrekordbox.config as rbconf

    for section in ("rekordbox6", "rekordbox7"):
        if not rbconf.__config__.get(section):
            rbconf.__config__[section] = {"bc_tagger": "explicit paths only, no auto-detection"}
    pl = logging.getLogger("pyrekordbox")
    for h in list(pl.handlers):
        pl.removeHandler(h)
    if not log.isEnabledFor(logging.DEBUG):
        pl.setLevel(logging.ERROR)


def open_database(db_path: str | Path, *, for_write: bool, mode: str = "test", **guard_kwargs: Any):
    """Open a ``MasterDatabase`` by explicit path (never auto-detected).

    ``mode="main"`` is only for writing the user's collection (guarded); read it via ``snapshot``.
    """
    from pyrekordbox.masterdb import MasterDatabase

    _quiet_pyrekordbox()
    target = resolve(db_path)
    if mode == "main":
        if not for_write:
            raise WriteRefused("read the main collection through snapshot(), not in place")
        require_write_main(target, **guard_kwargs)
        return MasterDatabase(path=target, db_dir=target.parent)
    if is_within(target, MAIN_LIBRARY_DIR):
        raise WriteRefused(f"refusing to open the main rekordbox library ({target})")
    if for_write:
        require_write(target, **guard_kwargs)
    elif not target.is_file():
        raise FileNotFoundError(target)
    return MasterDatabase(path=target, db_dir=target.parent)


@contextmanager
def database(db_path: str | Path, *, for_write: bool, mode: str = "test", **guard_kwargs: Any) -> Iterator[Any]:
    """``open_database`` that also closes the session and disposes the engine's pool."""
    db = open_database(db_path, for_write=for_write, mode=mode, **guard_kwargs)
    try:
        yield db
    finally:
        try:
            if db.session is not None:
                db.rollback()
                db.close()
        finally:
            db.engine.dispose()


def guarded_commit(db: Any, db_path: str | Path, mode: str = "test", **guard_kwargs: Any) -> GuardDecision:
    """Re-check the guard right before committing, then commit.

    Test mode: if rekordbox is running on a different library, pyrekordbox's own running
    check is patched out for the duration of this one commit. Main mode never bypasses it.
    """
    import pyrekordbox.masterdb.database as rbdb

    with _commit_lock:
        if mode == "main":
            decision = require_write_main(db_path, **guard_kwargs)
            db.commit()
            return decision
        decision = require_write(db_path, **guard_kwargs)
        if decision.bypass_running_check:
            log.info(decision.reason)
            with mock.patch.object(rbdb, "get_rekordbox_pid", lambda *a, **k: 0):
                db.commit()
        else:
            db.commit()
    return decision


@dataclass
class Target:
    """Where an export writes: the test library or (only from settings) the main collection."""

    kind: str  # "test" | "main"
    db_path: str
    guard: dict[str, Any]  # test: check_write kwargs; main: {allow, configured[, running]}

    @property
    def is_main(self) -> bool:
        return self.kind == "main"

    def check(self) -> GuardDecision:
        if self.is_main:
            return check_write_main(self.db_path, **self.guard)
        return check_write(self.db_path, **self.guard)

    def require(self) -> GuardDecision:
        decision = self.check()
        if not decision.allowed:
            raise WriteRefused(decision.reason)
        return decision

    def backup(self) -> Path:
        if self.is_main:
            return backup_main(self.db_path, **self.guard)
        return backup(self.db_path, **self.guard)

    def open_write(self):
        return open_database(self.db_path, for_write=True, mode=self.kind, **self.guard)

    def open_read(self):
        path = snapshot(self.db_path) if self.is_main else self.db_path
        return open_database(path, for_write=False)

    def commit(self, db: Any) -> GuardDecision:
        return guarded_commit(db, self.db_path, mode=self.kind, **self.guard)

    def source_fingerprint(self) -> str:
        return source_fingerprint(self.db_path)

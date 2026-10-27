from __future__ import annotations

import os
import shutil
import struct
from pathlib import Path

import pytest

from bc_tagger_server.config import TEST_LIBRARY_DIR, Settings
from bc_tagger_server.rbguard import MARKER_NAME
from bc_tagger_server.service import Service
from bc_tagger_server.store import Store

# A rekordbox master.db to copy for export tests. Only ever copied, never written.
TEMPLATE_DB = Path(os.environ.get("BCT_TEST_TEMPLATE_DB", TEST_LIBRARY_DIR / "master.db"))
TEST_TRACKS = Path("/Users/alvaroh/Projects/auto-rekordbox/test-tracks")
EXPORT_JSON = Path("/Users/alvaroh/Projects/auto-rekordbox/tagger-test-db/bc-tagger-export-2026-10-26.json")


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("BC_TAGGER_DATA_DIR", str(tmp_path / "data"))


@pytest.fixture
def test_db(tmp_path) -> Path:
    """A throwaway copy of the test library's master.db, with the marker file."""
    if not TEMPLATE_DB.is_file():
        pytest.skip(f"no template rekordbox DB at {TEMPLATE_DB}")
    lib = tmp_path / "lib"
    lib.mkdir()
    shutil.copy2(TEMPLATE_DB, lib / "master.db")
    (lib / MARKER_NAME).write_text("pytest test library\n")
    return lib / "master.db"


def write_aiff(path: Path, title: str | None, artist: str | None, album: str | None, track: int | None,
               seconds: float = 0.1) -> Path:
    """A tiny valid 16-bit mono AIFF with ID3 tags (none if all of title/artist/album are None)."""
    import mutagen.aiff
    from mutagen.id3 import TALB, TIT2, TPE1, TRCK

    path.parent.mkdir(parents=True, exist_ok=True)
    rate, frames = 8000, int(8000 * seconds)
    data = b"\x00\x00" * frames
    # 80-bit extended float for the sample rate
    exp, mant = 16383 + 12, rate << (63 - 12)  # 8000 = 1.953125 * 2^12
    rate80 = struct.pack(">HQ", exp, mant)
    comm = struct.pack(">hLh", 1, frames, 16) + rate80
    ssnd = struct.pack(">LL", 0, 0) + data
    body = b"AIFF" + b"COMM" + struct.pack(">L", len(comm)) + comm + b"SSND" + struct.pack(">L", len(ssnd)) + ssnd
    path.write_bytes(b"FORM" + struct.pack(">L", len(body)) + body)
    if title is None and artist is None and album is None:
        return path
    f = mutagen.aiff.AIFF(path)
    f.add_tags()
    f.tags.add(TIT2(encoding=3, text=title))
    f.tags.add(TPE1(encoding=3, text=artist))
    f.tags.add(TALB(encoding=3, text=album))
    f.tags.add(TRCK(encoding=3, text=str(track)))
    f.save()
    return path


@pytest.fixture
def make_service(tmp_path):
    services = []

    def _make(roots_dir: Path, db_path: Path | None = None, items: dict | None = None, tags=None) -> Service:
        settings = Settings(path=tmp_path / "data" / "settings.json")
        changes = {
            "owned_root": str(tmp_path / "owned-missing"),
            "not_owned_roots": [{"path": str(roots_dir), "globs": []}],
            "roots_preset": "custom",
        }
        if db_path is not None:
            changes["rekordbox_db_path"] = str(db_path)
        settings.update(changes)
        svc = Service(settings=settings, store=Store(path=tmp_path / "data" / "server.db"), seed=False)
        svc.default_scan_mode = "full"  # tests add files between calls; quick scans are tested explicitly
        svc.previews.autostart = False  # queued previews wait for previews.run_pending() (test_previews)
        if items is not None:
            svc.store.upsert_items(items, full=True)
            svc.store.set_tags(tags or sorted({t for it in items.values() for t in it.get("tags", [])}))
        services.append(svc)
        return svc

    yield _make
    for svc in services:
        svc.previews.close()
        svc.jobs.shutdown()
        svc.store.close()


@pytest.fixture
def new_store(tmp_path):
    """Make ``Store`` objects for a test (``new_store("t.db")`` or ``new_store(path=…)``); closed afterwards."""
    from bc_tagger_server.store import Store

    made = []

    def make(name: str = "s.db", path: Path | None = None) -> Store:
        made.append(Store(path=path or tmp_path / name))
        return made[-1]

    yield make
    for store in made:
        store.close()


@pytest.fixture
def mount_table(monkeypatch):
    """Set what the kernel's mount table says (``mount_table("/Volumes/X")``): ``fsguard.is_mounted`` then
    reads only that. ``/`` is always there."""
    from bc_tagger_server import fsguard

    def set_mounts(*points: str) -> None:
        table = fsguard.parse_mount_output("".join(f"/dev/disk9s{i} on {p} (apfs, local)\n"
                                                   for i, p in enumerate(("/", *points))))
        monkeypatch.setattr(fsguard, "_read_mount_table", lambda: table)
        monkeypatch.setattr(fsguard, "_mounts", None)

    set_mounts()
    return set_mounts


def pytest_collection_finish(session):
    """Freeze what's alive after collection (the imported modules): the full collections the rekordbox code runs
    (``rbguard.close_database``) and the leak check then only look at objects the tests make."""
    import gc

    gc.collect()
    gc.freeze()


@pytest.fixture(autouse=True)
def _no_open_databases_left(monkeypatch):
    """No test may leave a ``Store`` or a rekordbox database (SQLCipher) open.

    An open sqlite connection left to the garbage collector is freed in no fixed order. Garbage collection in the
    middle of a SQLCipher query crashed later tests at random, which ``rbguard`` now prevents. These checks keep
    the tests from hiding leaks. The object scan runs only after a test opened a rekordbox database.
    """
    import gc

    from bc_tagger_server import rbguard
    from bc_tagger_server import store as store_module

    made = []
    real_init = store_module.Store.__init__

    def init(self, *a, **kw):
        real_init(self, *a, **kw)
        made.append(self)

    monkeypatch.setattr(store_module.Store, "__init__", init)
    opened_before = rbguard.databases_opened()
    yield
    still_open = [s.path for s in made if _is_open(s._conn)]
    for store in made:
        store.close()
    assert not still_open, f"Store(s) left open: {still_open}"
    assert rbguard.open_databases() == 0, "a rekordbox database was opened and not closed (close_database)"
    if rbguard.databases_opened() != opened_before:
        from sqlcipher3 import dbapi2 as sqlcipher

        gc.collect()
        left = [o for o in gc.get_objects() if type(o) is sqlcipher.Connection and _is_open(o)]
        assert not left, f"{len(left)} rekordbox database connection(s) left open"


def _is_open(conn) -> bool:
    try:
        conn.total_changes
        return True
    except Exception:  # sqlite3/sqlcipher3 ProgrammingError: closed
        return False

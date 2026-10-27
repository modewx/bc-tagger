"""Write guard: marker file, main library, protected volume, and the rekordbox-running cases."""

from __future__ import annotations

import json

import pytest

import pyrekordbox.masterdb.database as rbdb
from bc_tagger_server import rbguard
from bc_tagger_server.config import MAIN_LIBRARY_DIR
from bc_tagger_server.rbguard import MARKER_NAME, WriteRefused, check_write, guarded_commit


def fake_db(dir_, marker=True):
    dir_.mkdir(parents=True, exist_ok=True)
    db = dir_ / "master.db"
    db.write_bytes(b"not really a db")
    if marker:
        (dir_ / MARKER_NAME).write_text("x")
    return db


def test_refuses_without_marker(tmp_path):
    db = fake_db(tmp_path / "lib", marker=False)
    d = check_write(db, running=False)
    assert not d.allowed and "marker" in d.reason


def test_allows_marked_db_when_rekordbox_not_running(tmp_path):
    db = fake_db(tmp_path / "lib")
    d = check_write(db, running=False)
    assert d.allowed and not d.bypass_running_check


def test_refuses_main_library_even_with_marker(tmp_path):
    main = tmp_path / "Pioneer" / "rekordbox"
    db = fake_db(main)
    d = check_write(db, running=False, main_dir=main)
    assert not d.allowed and "main rekordbox library" in d.reason


def test_refuses_real_main_library_path():
    d = check_write(MAIN_LIBRARY_DIR / "master.db", running=False)
    assert not d.allowed and "main rekordbox library" in d.reason
    with pytest.raises(WriteRefused):
        rbguard.open_database(MAIN_LIBRARY_DIR / "master.db", for_write=False)


def test_refuses_symlink_into_main_library(tmp_path):
    main = tmp_path / "rekordbox"
    fake_db(main)
    link_dir = tmp_path / "innocent"
    link_dir.symlink_to(main)
    d = check_write(link_dir / "master.db", running=False, main_dir=main)
    assert not d.allowed


def test_refuses_protected_volume(tmp_path):
    vol = tmp_path / "Volumes" / "Stationary Backup"
    db = fake_db(vol / "lib")
    d = check_write(db, running=False, protected_dirs=(vol,))
    assert not d.allowed and "protected volume" in d.reason


def test_refuses_missing_file(tmp_path):
    (tmp_path / "lib").mkdir()
    (tmp_path / "lib" / MARKER_NAME).write_text("x")
    assert not check_write(tmp_path / "lib" / "master.db", running=False).allowed


# -- rekordbox running ----------------------------------------------------------------------


def test_running_with_same_db_open_is_refused(tmp_path):
    db = fake_db(tmp_path / "lib")
    d = check_write(db, running=True, options_db=db)
    assert not d.allowed and "this DB open" in d.reason


def test_running_with_other_db_open_bypasses(tmp_path):
    db = fake_db(tmp_path / "lib")
    d = check_write(db, running=True, options_db=tmp_path / "main" / "master.db")
    assert d.allowed and d.bypass_running_check


def test_running_with_unknown_options_is_refused(tmp_path):
    db = fake_db(tmp_path / "lib")
    d = check_write(db, running=True, options_db=None)
    assert not d.allowed and "unknown" in d.reason


def test_options_json_parsing(tmp_path):
    db = fake_db(tmp_path / "lib")
    opts = tmp_path / "options.json"
    opts.write_text(json.dumps({"options": [["lang-path", "/x"], ["db-path", str(db)]]}))
    assert rbguard.options_db_path(opts) == rbguard.resolve(db)
    assert not check_write(db, running=True, options_db=rbguard.options_db_path(opts)).allowed
    opts.write_text("{not json")
    assert rbguard.options_db_path(opts) is None
    assert rbguard.options_db_path(tmp_path / "missing.json") is None


def test_real_options_json_points_elsewhere(test_db):
    """With the user's real options.json (main library), the test copy may be written."""
    opts = rbguard.options_db_path()
    if opts is None:
        pytest.skip("no rekordbox options.json on this machine")
    d = check_write(test_db, running=True)
    assert d.allowed and d.bypass_running_check and d.options_db_path == str(opts)


def _simulate_rekordbox_running(monkeypatch):
    monkeypatch.setattr(rbguard, "rekordbox_running", lambda: True)
    monkeypatch.setattr(rbdb, "get_rekordbox_pid", lambda *a, **k: 4242)


def _add_playlist(db_path, name):
    db = rbguard.open_database(db_path, for_write=False)
    db.create_playlist(name)
    return db


def _close(db):
    db.rollback()
    db.close()
    db.engine.dispose()


def _playlist_names(db_path):
    with rbguard.database(db_path, for_write=False) as db:
        return {p.Name for p in db.get_playlist()}


def test_pyrekordbox_commit_refuses_while_running(test_db, monkeypatch):
    """Why the bypass exists: plain pyrekordbox refuses whenever rekordbox runs."""
    _simulate_rekordbox_running(monkeypatch)
    db = _add_playlist(test_db, "pytest-plain")
    with pytest.raises(RuntimeError, match="Rekordbox is running"):
        db.commit()
    _close(db)
    assert "pytest-plain" not in _playlist_names(test_db)


def test_guarded_commit_bypasses_when_other_library_open(test_db, tmp_path, monkeypatch):
    _simulate_rekordbox_running(monkeypatch)
    other = tmp_path / "Pioneer" / "rekordbox" / "master.db"
    db = _add_playlist(test_db, "pytest-bypass")
    decision = guarded_commit(db, test_db, options_db=other)
    _close(db)
    assert decision.bypass_running_check
    assert "pytest-bypass" in _playlist_names(test_db)
    # The patch is scoped to that one commit.
    assert rbdb.get_rekordbox_pid() == 4242


def test_guarded_commit_refuses_when_target_is_open(test_db, monkeypatch):
    _simulate_rekordbox_running(monkeypatch)
    before = test_db.read_bytes()
    db = _add_playlist(test_db, "pytest-refused")
    with pytest.raises(WriteRefused, match="this DB open"):
        guarded_commit(db, test_db, options_db=test_db)
    _close(db)
    assert "pytest-refused" not in _playlist_names(test_db)
    assert test_db.read_bytes() == before


def test_guarded_commit_refuses_when_marker_removed(test_db):
    db = _add_playlist(test_db, "pytest-nomarker")
    (test_db.parent / MARKER_NAME).unlink()
    with pytest.raises(WriteRefused, match="marker"):
        guarded_commit(db, test_db, running=False)
    _close(db)


def test_backup_is_timestamped(test_db):
    b1 = rbguard.backup(test_db, running=False)
    b2 = rbguard.backup(test_db, running=False)
    assert b1.parent == test_db.parent / "backups"
    assert b1 != b2 and b1.read_bytes() == test_db.read_bytes()


def test_backup_refused_without_marker(tmp_path):
    db = fake_db(tmp_path / "lib", marker=False)
    with pytest.raises(WriteRefused):
        rbguard.backup(db, running=False)
    assert not (tmp_path / "lib" / "backups").exists()


def test_restore_from_backup(test_db, monkeypatch):
    monkeypatch.setattr(rbdb, "get_rekordbox_pid", lambda *a, **k: 0)  # independent of the real app
    pristine = rbguard.backup(test_db, running=False)
    db = _add_playlist(test_db, "pytest-restore")
    guarded_commit(db, test_db, running=False)
    _close(db)
    assert "pytest-restore" in _playlist_names(test_db)
    result = rbguard.restore(test_db, pristine, running=False)
    assert "pytest-restore" not in _playlist_names(test_db)
    saved = rbguard.resolve(result["previous_saved_as"])
    assert saved.parent == test_db.parent / "backups" and saved != pristine


def test_restore_refuses_foreign_file_and_missing_marker(test_db, tmp_path):
    outside = tmp_path / "elsewhere.db"
    outside.write_bytes(test_db.read_bytes())
    with pytest.raises(WriteRefused, match="not a backup"):
        rbguard.restore(test_db, outside, running=False)
    pristine = rbguard.backup(test_db, running=False)
    (test_db.parent / MARKER_NAME).unlink()
    with pytest.raises(WriteRefused, match="marker"):
        rbguard.restore(test_db, pristine, running=False)


def test_db_path_in_options_json_is_not_trusted(tmp_path):
    """rekordbox 6.7.4 rewrote options.json to a Caches path it doesn't use while it kept
    ~/Library/Pioneer/rekordbox open: both count as possibly open."""
    main = tmp_path / "Pioneer" / "rekordbox"
    main_db = fake_db(main)  # even with a marker (test library switched in)
    caches = tmp_path / "Caches" / "rekordbox" / "master.db"  # doesn't exist
    test_db = fake_db(tmp_path / "rekordbox_test")
    ok = check_write(test_db, running=True, options_db=caches, main_dir=main)
    assert ok.allowed and ok.bypass_running_check
    refused = check_write(main_db, running=True, options_db=caches, main_dir=main)
    assert not refused.allowed and refused.code == "main_library_path"
    open_elsewhere = fake_db(tmp_path / "Caches" / "rekordbox")
    refused = check_write(open_elsewhere, running=True, options_db=open_elsewhere, main_dir=main)
    assert not refused.allowed and refused.code == "rekordbox_has_db_open"


def test_refusals_carry_codes(tmp_path):
    db = fake_db(tmp_path / "lib", marker=False)
    assert check_write(db, running=False).code == "not_test_library"
    assert check_write(tmp_path / "nope" / "master.db", running=False).code == "db_missing"
    main = fake_db(tmp_path / "main", marker=False)
    assert rbguard.check_write_main(main, allow=False, configured=main, running=False).code == "main_writes_locked"
    assert rbguard.check_write_main(main, allow=True, configured=main, running=True).code == "rekordbox_running"

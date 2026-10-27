"""Phase 2: writing the user's main collection, tag→playlist mapping, guards, confirmations.

The "main collection" here is a throwaway copy of the test template in a folder named like
the real one, with a masterPlaylists6.xml, no marker file, and a realistic playlist tree.
"""

from __future__ import annotations

import os
import shutil
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import pyrekordbox.masterdb.database as rbdb
from bc_tagger_server import rbguard
from bc_tagger_server.api import create_app
from bc_tagger_server.config import SettingsError
from bc_tagger_server.playlists import name_to_parts, playlists_for_tag
from bc_tagger_server.rbexport import ExportError, find_content, read_back
from bc_tagger_server.rbguard import MARKER_NAME, WriteRefused

from .conftest import TEMPLATE_DB, write_aiff

FOLDER = "bct-main"


@pytest.fixture(autouse=True)
def rekordbox_closed(monkeypatch):
    monkeypatch.setattr(rbguard, "rekordbox_running", lambda: False)
    monkeypatch.setattr(rbdb, "get_rekordbox_pid", lambda *a, **k: 0)


def _xml_for(db) -> str:
    nodes = []
    for pl in db.get_playlist():
        parent = "0" if str(pl.ParentID) == "root" else f"{int(pl.ParentID):X}"
        ts = int(pl.updated_at.timestamp() * 1000)
        nodes.append(f'    <NODE Id="{int(pl.ID):X}" ParentId="{parent}" Attribute="{pl.Attribute}" '
                     f'Timestamp="{ts}" Lib_Type="0" CheckType="0"/>')
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<MASTER_PLAYLIST Version="3.0.0" AutomaticSync="0">\n'
            '  <PRODUCT Name="" Version="" Company="Pioneer DJ"/>\n  <PLAYLISTS>\n' + "\n".join(nodes) +
            "\n  </PLAYLISTS>\n</MASTER_PLAYLIST>\n")


@pytest.fixture
def library(tmp_path):
    root = tmp_path / "music"
    alpha = [str(write_aiff(root / "Alpha - Alpha Album" / f"0{n} - Alpha {n}.aiff", f"Alpha {n}", "Alpha", "Alpha Album", n))
             for n in (1, 2, 3)]
    beta = str(write_aiff(root / "Beta - Single" / "01 - Beta Song.aiff", "Beta Song", "Beta", "Single", 1))
    user = str(write_aiff(tmp_path / "elsewhere" / "User Song.aiff", "User Song", "Someone", "Theirs", 1))
    items = {
        "a100": {"id": "a100", "title": "Alpha Album", "artist": "Alpha", "album_title": "alpha-album", "track_num": -1,
                 "tags": ["must", "closer"], "date_added": "2026-10-26T03:00:00Z"},
        "t200": {"id": "t200", "title": "Beta Song", "artist": "Beta", "album_title": "Single", "track_num": 1,
                 "tags": ["pool"], "date_added": "2026-10-26T02:00:00Z"},
    }
    return {"root": root, "alpha": alpha, "beta": beta, "user": user, "items": items}


@pytest.fixture
def main_db(tmp_path, library):
    """A fake main collection: /DJ/Status/Must (with a user track and one of our tracks added by
    the user), /DJ/Smart (smart playlist), two /Dup playlists, and a masterPlaylists6.xml."""
    from pyrekordbox.masterdb.smartlist import Property, SmartList

    if not TEMPLATE_DB.is_file():
        pytest.skip(f"no template rekordbox DB at {TEMPLATE_DB}")
    lib = tmp_path / "Pioneer" / "rekordbox-main-copy"
    lib.mkdir(parents=True)
    db_path = lib / "master.db"
    shutil.copy2(TEMPLATE_DB, db_path)
    with _raw(db_path) as db:
        dj = db.create_playlist_folder("DJ")
        status = db.create_playlist_folder("Status", parent=dj)
        must = db.create_playlist("Must", parent=status)
        smart = SmartList()
        smart.add_condition(Property.ARTIST, operator=1, value_left="nobody")
        db.create_smart_playlist("Smart", smart, parent=dj)
        db.create_playlist("Dup")
        db.create_playlist("Dup")
        for path in (library["user"], library["alpha"][0]):
            db.add_to_playlist(must, db.add_content(path))
        db.commit()
        (lib / "masterPlaylists6.xml").write_text(_xml_for(db))
    return db_path


class _raw:
    """Open a DB in place for fixture setup only (bypasses the guard on purpose)."""

    def __init__(self, path):
        from pyrekordbox.masterdb import MasterDatabase

        rbguard._quiet_pyrekordbox()
        self.db = MasterDatabase(path=path, db_dir=Path(path).parent)

    def __enter__(self):
        return self.db

    def __exit__(self, *exc):
        self.db.close()
        self.db.engine.dispose()


@pytest.fixture
def svc(make_service, library, main_db):
    s = make_service(library["root"], items=library["items"], tags=["must", "pool", "closer"])
    s.settings.update({
        "allow_main_writes": True,
        "rekordbox_target": "main",
        "rekordbox_main_db_path": str(main_db),
        "playlist_folder": FOLDER,
        "tag_playlist_mode": "custom",
        "tag_playlist_map": {"must": ["/DJ/Status/Must", "Keepers"], "pool": ["Genres/Pool"], "closer": []},
    })
    return s


def _files(folder: Path) -> dict[str, tuple[int, int]]:
    return {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in folder.iterdir() if p.is_file()}


# -- names --------------------------------------------------------------------------------------


def test_name_resolution_rules():
    assert name_to_parts("Must", "bc-tagger") == ("bc-tagger", "Must")
    assert name_to_parts("Genres/Acid", "bc-tagger") == ("bc-tagger", "Genres", "Acid")
    assert name_to_parts("/DJ/Status/Must", "bc-tagger") == ("DJ", "Status", "Must")
    assert playlists_for_tag("afro/latin", "auto", {}, "bc-tagger") == ["/bc-tagger/afro/latin"]
    assert playlists_for_tag("must", "custom", {"must": ["A", "/B/C", "A"]}, "f") == ["/f/A", "/B/C"]
    assert playlists_for_tag("pool", "custom", {"must": ["A"]}, "f") == []
    nfd = unicodedata.normalize("NFD", "Oração")
    assert name_to_parts(nfd, "f") == ("f", unicodedata.normalize("NFC", "Oração"))


def test_settings_rules(svc):
    with pytest.raises(SettingsError):
        svc.settings.update({"allow_main_writes": True, "rekordbox_target": "main", "tag_playlist_map": {"x": ["a//b"]}})
    assert svc.settings_derived()["mapping_warning"] is None
    svc.settings.update({"tag_playlist_map": {"must": [], "pool": []}})
    assert "No tag is mapped" in svc.settings_derived()["mapping_warning"]
    # unticking "allow" keeps the chosen library: main, read-only for bc-tagger
    svc.settings.update({"allow_main_writes": False})
    assert svc.settings.get("rekordbox_target") == "main" and svc.target().kind == "main"
    assert svc.settings_derived()["main_writes_locked"] is True
    svc.settings.update({"rekordbox_target": "test"})
    svc.settings.update({"rekordbox_target": "main"})  # choosing main needs no "allow"
    assert svc.target().kind == "main"


def test_playlist_tree_and_resolve(svc):
    tree = {r["path"]: r for r in svc.rekordbox_playlists()}
    assert tree["/DJ"]["kind"] == "folder" and tree["/DJ"]["count"] == 2
    assert tree["/DJ/Status/Must"] == {"path": "/DJ/Status/Must", "name": "Must", "kind": "playlist", "count": 2}
    assert tree["/DJ/Smart"]["kind"] == "smart" and tree["/DJ/Smart"]["count"] is None
    got = {r["name"]: (r["status"], r["path"]) for r in svc.resolve_playlist_names(
        ["/DJ/Status/Must", "Keepers", "Genres/Pool", "/DJ/Smart", "/DJ", "/Dup", "/DJ/Status/Must/x", "a//b"])}
    assert got["/DJ/Status/Must"] == ("exists", "/DJ/Status/Must")
    assert got["Keepers"] == ("create", f"/{FOLDER}/Keepers")
    assert got["Genres/Pool"] == ("create", f"/{FOLDER}/Genres/Pool")
    assert {k: v[0] for k, v in got.items() if v[0] == "error"} == {
        "/DJ/Smart": "error", "/DJ": "error", "/Dup": "error", "/DJ/Status/Must/x": "error", "a//b": "error"}


# -- the full main flow -------------------------------------------------------------------------


def test_main_export_needs_dry_run_and_is_idempotent(svc, library, main_db, tmp_path):
    lib = main_db.parent
    before = _files(lib)
    with pytest.raises(ExportError, match="dry run required"):
        svc.export(ids=["a100", "t200"])

    dry = svc.export(ids=["a100", "t200"], dry_run=True)
    assert dry["target"] == "main" and dry["changed"] and dry["errors"] == []
    assert dry["folders_created"] == [f"/{FOLDER}", f"/{FOLDER}/Genres"]
    assert dry["playlists_created"] == [f"/{FOLDER}/Keepers", f"/{FOLDER}/Genres/Pool"]
    assert sorted(dry["content_added"]) == sorted(library["alpha"][1:] + [library["beta"]])
    assert dry["entries_kept_user"] == 1  # Alpha 1 is already in /DJ/Status/Must (the user's entry)
    assert {"code": "unmapped_tags", "message": "not exported (no playlist mapped): closer"} in dry["warnings"]
    assert dry["blockers"] == [] and dry["can_confirm"] is True
    assert _files(lib) == before  # the dry run read a snapshot: nothing next to master.db changed

    result = svc.export(ids=["a100", "t200"], confirm_token=dry["confirm_token"])
    assert result["changed"] and not result["dry_run"]
    backup = Path(result["backup"])
    assert backup.parent.name == "main" and {"master.db", "masterPlaylists6.xml"} <= {p.name for p in backup.iterdir()}
    keys = ["/DJ/Status/Must", f"/{FOLDER}/Keepers", f"/{FOLDER}/Genres/Pool"]
    state = read_back(svc.target(), FOLDER, keys)
    alpha, beta = library["alpha"], library["beta"]
    assert state["mapped"]["/DJ/Status/Must"] == [library["user"], alpha[0], alpha[1], alpha[2]]
    assert state["mapped"][f"/{FOLDER}/Keepers"] == alpha
    assert state["mapped"][f"/{FOLDER}/Genres/Pool"] == [beta]
    assert state["duplicate_content_paths"] == []

    # masterPlaylists6.xml lists the new folders/playlists under the right parents.
    tree = {r["path"]: r for r in svc.rekordbox_playlists()}
    xml_nodes = {n.get("Id"): n for n in ET.parse(lib / "masterPlaylists6.xml").getroot().iter("NODE")}
    with _raw(svc.target().db_path) as db:
        by_name = {(p.Name, str(p.ParentID)): p for p in db.get_playlist()}
        folder = next(p for (n, _), p in by_name.items() if n == FOLDER)
        genres = by_name[("Genres", str(folder.ID))]
        pool = by_name[("Pool", str(genres.ID))]
        for row, parent in ((folder, "0"), (genres, f"{int(folder.ID):X}"), (pool, f"{int(genres.ID):X}")):
            node = xml_nodes[f"{int(row.ID):X}"]
            assert node.get("ParentId") == parent and node.get("Attribute") == str(row.Attribute)
    assert tree[f"/{FOLDER}/Genres/Pool"]["count"] == 1

    with pytest.raises(ExportError, match="already used"):
        svc.export(ids=["a100", "t200"], confirm_token=dry["confirm_token"])
    again = svc.export(ids=["a100", "t200"], dry_run=True)
    assert not again["changed"] and again["entries_added"] == [] and again["content_added"] == []
    n_backups = len(list(backup.parent.iterdir()))
    assert not svc.export(ids=["a100", "t200"], confirm_token=again["confirm_token"])["changed"]
    assert len(list(backup.parent.iterdir())) == n_backups  # nothing to write: no backup

    # Untag 'must' on the album: only the tool's own entries leave; the user's stay.
    item = svc.store.get_item("a100")
    item["tags"] = ["closer"]
    svc.store.upsert_items({"a100": item})
    dry = svc.export(ids=["a100"], dry_run=True)
    assert sorted((e["playlist"], e["path"]) for e in dry["entries_removed"]) == sorted(
        [("/DJ/Status/Must", alpha[1]), ("/DJ/Status/Must", alpha[2])]
        + [(f"/{FOLDER}/Keepers", p) for p in alpha])
    svc.export(ids=["a100"], confirm_token=dry["confirm_token"])
    state = read_back(svc.target(), FOLDER, keys)
    assert state["mapped"]["/DJ/Status/Must"] == [library["user"], alpha[0]]
    assert state["mapped"][f"/{FOLDER}/Keepers"] == []


def test_main_never_modifies_existing_content(svc, library, main_db):
    with _raw(main_db) as db:
        db.add_content(library["beta"])  # in the collection already, without a title
        db.commit()
    dry = svc.export(ids=["t200"], dry_run=True)
    assert dry["content_updated"] == [] and dry["content_existing"] == 1 and dry["content_added"] == []
    svc.export(ids=["t200"], confirm_token=dry["confirm_token"])
    with _raw(main_db) as db:
        assert find_content(db, library["beta"]).Title is None


def test_existing_content_matched_across_unicode_forms(svc, library, main_db, tmp_path):
    nfc = unicodedata.normalize("NFC", "Oração")
    path = write_aiff(library["root"] / "Lechuga Zafiro - NAAFI X" / f"01 - {nfc}.aiff", nfc, "Lechuga Zafiro", "NAAFI X", 1)
    nfd_path = unicodedata.normalize("NFD", str(path))
    assert nfd_path != str(path) and Path(nfd_path).is_file()  # macOS resolves both forms
    with _raw(main_db) as db:
        db.add_content(nfd_path)  # rekordbox stored the decomposed form
        db.commit()
    svc.store.upsert_items({"t300": {"id": "t300", "title": nfc, "artist": "Lechuga Zafiro", "album_title": "NAAFI X",
                                     "track_num": 1, "tags": ["pool"], "date_added": "2026-10-26T04:00:00Z"}})
    dry = svc.export(ids=["t300"], dry_run=True)
    assert dry["content_added"] == [] and dry["content_existing"] == 1


# -- guard refusals -----------------------------------------------------------------------------


def test_refuses_while_rekordbox_runs(svc, monkeypatch, main_db):
    dry = svc.export(ids=["t200"], dry_run=True)  # reading a snapshot is fine
    assert dry["guard"]["allowed"] is True
    monkeypatch.setattr(rbguard, "rekordbox_running", lambda: True)
    before = _files(main_db.parent)
    with pytest.raises(WriteRefused, match="rekordbox is running"):
        svc.export(ids=["t200"], confirm_token=dry["confirm_token"])
    assert _files(main_db.parent) == before
    assert not (rbguard.data_dir() / "backups" / "main").exists()


def test_refuses_when_test_library_is_switched_in(svc, main_db):
    (main_db.parent / MARKER_NAME).write_text("test library")
    dry = svc.export(ids=["t200"], dry_run=True)
    assert dry["guard"]["allowed"] is False and "rb-switch-library.sh main" in dry["guard"]["reason"]
    with pytest.raises(WriteRefused, match="test library"):
        svc.export(ids=["t200"], confirm_token=dry["confirm_token"])


def test_refuses_when_setting_is_off_or_path_differs(svc, main_db, tmp_path):
    allow = {"on": True}
    target = rbguard.Target("main", str(main_db), {"allow": lambda: allow["on"], "configured": str(main_db)})
    assert target.check().allowed
    allow["on"] = False
    assert target.check().code == "main_writes_locked" and "locked" in target.check().reason
    other = rbguard.Target("main", str(main_db), {"allow": True, "configured": str(tmp_path / "other.db")})
    assert "not the configured main collection" in other.check().reason
    # Switching the setting off between dry run and confirm stops the write.
    dry = svc.export(ids=["t200"], dry_run=True)
    svc.settings.update({"allow_main_writes": False})
    before = _files(main_db.parent)
    with pytest.raises(WriteRefused, match="locked"):
        svc.export(ids=["t200"], confirm_token=dry["confirm_token"])
    assert _files(main_db.parent) == before


def test_refuses_changed_plan_or_library(svc, main_db):
    dry = svc.export(ids=["t200"], dry_run=True)
    svc.settings.update({"tag_playlist_map": {"pool": ["Other Pool"]}})
    with pytest.raises(ExportError, match="plan changed"):
        svc.export(ids=["t200"], confirm_token=dry["confirm_token"])
    dry = svc.export(ids=["t200"], dry_run=True)
    os.utime(main_db, None)  # rekordbox (or anything) touched the library after the dry run
    with pytest.raises(ExportError, match="plan changed"):
        svc.export(ids=["t200"], confirm_token=dry["confirm_token"])


def test_mapping_errors_block_the_export(svc, main_db):
    svc.settings.update({"tag_playlist_map": {"pool": ["/DJ/Smart", "/DJ", "/Dup"]}})
    dry = svc.export(ids=["t200"], dry_run=True)
    assert len(dry["errors"]) == 3
    assert any("smart playlist" in e for e in dry["errors"]) and any("is a folder" in e for e in dry["errors"])
    before = _files(main_db.parent)
    with pytest.raises(ExportError):
        svc.export(ids=["t200"], confirm_token=dry["confirm_token"])
    assert _files(main_db.parent) == before


def test_api_requires_dry_run_for_main(svc):
    with TestClient(create_app(svc)) as c:
        r = c.post("/api/rekordbox/export", json={"ids": ["t200"]})
        assert r.status_code == 409 and r.json()["detail"] == "dry run required"
        job = c.post("/api/rekordbox/export", json={"ids": ["t200"], "dry_run": True}).json()["job_id"]
        result = svc.jobs.wait(job, timeout=30).result
        assert result["confirm_token"] and result["target"] == "main"
        job = c.post("/api/rekordbox/export", json={"ids": ["t200"], "confirm_token": result["confirm_token"]}).json()["job_id"]
        done = svc.jobs.wait(job, timeout=30)
        assert done.status == "done" and done.result["changed"], done.error
        assert c.get("/api/health").json()["db"]["target"] == "main"
        assert c.get("/api/settings").json()["derived"]["target_db_path"] == svc.target().db_path
        assert any(r["path"] == "/DJ/Status/Must" for r in c.get("/api/rekordbox/playlists").json())


def test_main_backups_keep_last_five(main_db, tmp_path):
    root = tmp_path / "backups-main"
    for _ in range(7):
        rbguard.backup_main(main_db, root=root, allow=True, configured=main_db, running=False)
    kept = sorted(root.iterdir())
    assert len(kept) == 5 and all((d / "master.db").is_file() and (d / "masterPlaylists6.xml").is_file() for d in kept)


def test_test_mode_never_touches_parked_main(tmp_path, monkeypatch):
    from bc_tagger_server import config

    parked = tmp_path / "rekordbox_main"
    parked.mkdir()
    (parked / "master.db").write_bytes(b"x")
    (parked / MARKER_NAME).write_text("even with a marker")
    monkeypatch.setattr(rbguard, "PARKED_MAIN_LIBRARY_DIR", parked)
    assert not rbguard.check_write(parked / "master.db", running=False).allowed
    assert config.PARKED_MAIN_LIBRARY_DIR.name == "rekordbox_main"


def test_xml_only_touched_nodes_change(svc, library, main_db):
    """pyrekordbox would 'sync' every node whose Timestamp differs from the DB; only playlists
    the export created or changed may be touched."""
    xml_path = main_db.parent / "masterPlaylists6.xml"
    root = ET.parse(xml_path)
    with _raw(main_db) as db:
        dup_ids = [f"{int(p.ID):X}" for p in db.get_playlist() if p.Name == "Dup"]
        must_id = f"{int(next(p for p in db.get_playlist() if p.Name == 'Must').ID):X}"
    for n in root.getroot().iter("NODE"):
        if n.get("Id") in dup_ids + [must_id]:
            n.set("Timestamp", "1000")  # out of sync with the DB, like many real libraries
    root.write(xml_path, encoding="UTF-8", xml_declaration=True)
    before = {n.get("Id"): dict(n.attrib) for n in ET.parse(xml_path).getroot().iter("NODE")}
    dry = svc.export(ids=["a100", "t200"], dry_run=True)
    svc.export(ids=["a100", "t200"], confirm_token=dry["confirm_token"])
    after = {n.get("Id"): dict(n.attrib) for n in ET.parse(xml_path).getroot().iter("NODE")}
    changed = {k for k in before if before[k] != after.get(k)}
    assert changed == {must_id}  # the existing playlist we added tracks to; "Dup" stays as it was
    assert all(after[i]["Timestamp"] == "1000" for i in dup_ids) and after[must_id]["Timestamp"] != "1000"
    assert len(after) == len(before) + 4  # /bct-main, /bct-main/Genres, Keepers, Genres/Pool


def test_dry_run_reports_blockers_before_confirm(svc, monkeypatch, main_db):
    monkeypatch.setattr(rbguard, "rekordbox_running", lambda: True)
    dry = svc.export(ids=["t200"], dry_run=True)
    assert dry["blockers"] == [{"code": "rekordbox_running", "message": "rekordbox is running. Quit rekordbox before confirming."}]
    assert dry["can_confirm"] is False and dry["changed"] is True
    monkeypatch.setattr(rbguard, "rekordbox_running", lambda: False)
    (main_db.parent / MARKER_NAME).write_text("x")
    assert [b["code"] for b in svc.export(ids=["t200"], dry_run=True)["blockers"]] == ["test_library_switched_in"]
    (main_db.parent / MARKER_NAME).unlink()
    off = svc.export(ids=["t200"], dry_run=True, guard_kwargs={"allow": False})
    assert [b["code"] for b in off["blockers"]] == ["main_writes_locked"]
    svc.settings.update({"tag_playlist_map": {"pool": ["/DJ/Smart"]}})
    bad = svc.export(ids=["t200"], dry_run=True)
    assert [b["code"] for b in bad["blockers"]] == ["playlist_errors"] and not bad["can_confirm"]


def test_main_chosen_with_writes_locked_reads_but_never_writes(svc, main_db):
    """The library choice and the permission are separate: main + locked reads the main library (a copy) and
    stops every write at the dry run's blocker."""
    svc.settings.update({"allow_main_writes": False})
    assert svc.target().kind == "main"
    before = _files(main_db.parent)
    tree = {r["path"] for r in svc.rekordbox_playlists()}  # reads work: the playlist tree and names
    assert "/DJ/Status/Must" in tree
    assert {r["name"]: r["status"] for r in svc.resolve_playlist_names(["/DJ/Status/Must"])} == {"/DJ/Status/Must": "exists"}
    dry = svc.export(ids=["t200"], dry_run=True)
    assert dry["target"] == "main" and dry["changed"] and dry["can_confirm"] is False
    assert dry["blockers"] == [{"code": "main_writes_locked", "message": rbguard.MAIN_WRITES_LOCKED}]
    with TestClient(create_app(svc)) as c:
        r = c.post("/api/rekordbox/export", json={"ids": ["t200"], "confirm_token": dry["confirm_token"]})
        assert r.status_code == 409 and "locked" in r.json()["detail"]
        assert c.get("/api/settings").json()["derived"]["main_writes_locked"] is True
    with pytest.raises(WriteRefused, match="locked"):
        svc.export(ids=["t200"], confirm_token=dry["confirm_token"])
    assert _files(main_db.parent) == before  # nothing written, no backup taken
    # allowed again, rekordbox closed, the test library not switched in: the same export goes through
    svc.settings.update({"allow_main_writes": True})
    dry = svc.export(ids=["t200"], dry_run=True)
    assert dry["blockers"] == [] and dry["can_confirm"]
    done = svc.export(ids=["t200"], confirm_token=dry["confirm_token"])
    assert done["changed"] and done["backup"]

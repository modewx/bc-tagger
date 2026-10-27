"""rekordbox export: layout, idempotency, managed sync, dry run, guard, XML fallback."""

from __future__ import annotations

import urllib.parse
from pathlib import Path
import xml.etree.ElementTree as ET

import pytest

from bc_tagger_server import rbguard
from bc_tagger_server.rbexport import find_content, read_back
from bc_tagger_server.rbguard import MARKER_NAME, WriteRefused

from .conftest import write_aiff

FOLDER = "bct-pytest"
GUARD: dict = {}


@pytest.fixture(autouse=True)
def rekordbox_not_running(monkeypatch):
    """Export tests must not depend on whether the user has rekordbox open."""
    import pyrekordbox.masterdb.database as rbdb

    monkeypatch.setattr(rbguard, "rekordbox_running", lambda: False)
    monkeypatch.setattr(rbdb, "get_rekordbox_pid", lambda *a, **k: 0)


def _item(item_id, title, artist, album, track, tags, date, **extra):
    return {"id": item_id, "title": title, "artist": artist, "album_title": album, "track_num": track,
            "tags": tags, "date_added": date, **extra}


@pytest.fixture
def library(tmp_path):
    root = tmp_path / "music"
    alpha = [write_aiff(root / "Alpha - Alpha Album" / f"0{n} - Alpha {n}.aiff", f"Alpha {n}", "Alpha", "Alpha Album", n)
             for n in (1, 2, 3)]
    beta = write_aiff(root / "Beta - Single" / "01 - Beta Song.aiff", "Beta Song", "Beta", "Single", 1)
    items = {
        "a100": _item("a100", "Alpha Album", "Alpha", "alpha-album", -1, ["must", "closer"], "2026-10-26T03:00:00Z"),
        "t200": _item("t200", "Beta Song", "Beta", "Single", 1, ["pool", "electro"], "2026-10-26T02:00:00Z"),
        "t300": _item("t300", "Alpha 2", "Alpha", "Alpha Album", 2, ["must", "ritual"], "2026-10-26T01:00:00Z"),
        "t400": _item("t400", "Not Here", "Nobody", "Nothing", 1, ["must"], "2026-10-26T04:00:00Z"),
    }
    return {"root": root, "alpha": [str(p) for p in alpha], "beta": str(beta), "items": items}


@pytest.fixture
def svc(make_service, library, test_db):
    s = make_service(library["root"], db_path=test_db, items=library["items"], tags=["must", "pool", "electro", "closer", "ritual"])
    s.settings.update({"playlist_folder": FOLDER})
    return s


def export(svc, **kw):
    return svc.export(guard_kwargs=GUARD, **kw)


def test_export_layout_and_idempotency(svc, library, test_db):
    before = read_back(test_db, FOLDER)
    diff = export(svc, ids=["a100", "t200", "t300", "t400"])
    assert diff["changed"] and diff["folder"]["created"]
    assert [s["id"] for s in diff["skipped_items"]] == ["t400"]
    assert sorted(diff["content_added"]) == sorted(library["alpha"] + [library["beta"]])
    assert diff["backup"] and (test_db.parent / "backups").is_dir()

    state = read_back(test_db, FOLDER)
    alpha, beta = library["alpha"], library["beta"]
    assert state["playlists"] == {
        "must": alpha,  # album tag + t300's own 'must' on Alpha 2: no duplicate entry
        "pool": [beta],
        "electro": [beta],
        "closer": alpha,
        "ritual": [alpha[1]],
    }
    assert state["content_count"] == before["content_count"] + 4
    assert state["duplicate_content_paths"] == []

    again = export(svc, ids=["a100", "t200", "t300", "t400"])
    assert not again["changed"]
    assert again["content_added"] == [] and again["entries_added"] == [] and again["entries_removed"] == []
    assert again["backup"] is None
    assert read_back(test_db, FOLDER) == state

    view = svc.get_item_view("a100")["rekordbox"]
    assert view["status"] == "exported" and view["playlists"] == [f"/{FOLDER}/closer", f"/{FOLDER}/must"]


def _user_adds(test_db, playlist_name, path):
    """Simulate the user adding a track to a playlist inside rekordbox."""
    with rbguard.database(test_db, for_write=True, **GUARD) as db:
        content = find_content(db, path) or db.add_content(path)
        folder = next(p for p in db.get_playlist(Name=FOLDER))
        pl = next(p for p in db.get_playlist(Name=playlist_name) if p.ParentID == folder.ID)
        db.add_to_playlist(pl, content)
        rbguard.guarded_commit(db, test_db, **GUARD)


def test_managed_sync_only_removes_own_entries(svc, library, test_db, tmp_path):
    export(svc, ids=["a100", "t200", "t300"])
    extra = str(write_aiff(tmp_path / "manual" / "Manual.aiff", "Manual", "Someone", "Else", 1))
    _user_adds(test_db, "pool", extra)  # a track we never exported
    _user_adds(test_db, "must", library["beta"])  # a user entry for a track we manage elsewhere

    item = svc.store.get_item("t200")
    item["tags"] = ["electro"]  # untag 'pool'
    svc.store.upsert_items({"t200": item})
    diff = export(svc, ids=["t200"])
    assert [(e["tag"], e["path"]) for e in diff["entries_removed"]] == [(f"/{FOLDER}/pool", library["beta"])]

    state = read_back(test_db, FOLDER)
    assert state["playlists"]["pool"] == [extra]
    assert library["beta"] in state["playlists"]["must"]  # the user's own entry stays
    assert state["playlists"]["electro"] == [library["beta"]]
    # Items outside the selection keep their entries.
    assert state["playlists"]["closer"] == library["alpha"]


def test_shared_claims_keep_entry(svc, library, test_db):
    """Alpha 2 is in 'must' via the album and via t300; untagging t300 keeps the entry."""
    export(svc, ids=["a100", "t300"])
    item = svc.store.get_item("t300")
    item["tags"] = ["ritual"]
    svc.store.upsert_items({"t300": item})
    diff = export(svc, ids=["t300"])
    assert diff["entries_removed"] == []
    assert library["alpha"][1] in read_back(test_db, FOLDER)["playlists"]["must"]


def test_existing_content_is_reused(svc, library, test_db):
    with rbguard.database(test_db, for_write=True, **GUARD) as db:
        db.add_content(library["beta"], Title="Imported by hand")
        rbguard.guarded_commit(db, test_db, **GUARD)
    diff = export(svc, ids=["t200"])
    assert diff["content_existing"] == 1 and diff["content_added"] == []
    assert read_back(test_db, FOLDER)["duplicate_content_paths"] == []


def test_dry_run_writes_nothing(svc, test_db):
    before = test_db.read_bytes()
    diff = export(svc, ids=["a100", "t200"], dry_run=True)
    assert diff["dry_run"] and diff["changed"] and diff["folder"]["created"]
    assert len(diff["entries_added"]) == 3 * 2 + 2
    assert test_db.read_bytes() == before
    assert not (test_db.parent / "backups").exists()
    assert svc.store.query("SELECT * FROM rb_claims") == []


def test_export_refused_without_marker(svc, test_db):
    (test_db.parent / MARKER_NAME).unlink()
    before = test_db.read_bytes()
    with pytest.raises(WriteRefused):
        export(svc, ids=["t200"])
    assert test_db.read_bytes() == before
    assert not (test_db.parent / "backups").exists()


def test_export_while_rekordbox_runs_on_another_library(svc, library, test_db, tmp_path, monkeypatch):
    import pyrekordbox.masterdb.database as rbdb

    monkeypatch.setattr(rbguard, "rekordbox_running", lambda: True)
    monkeypatch.setattr(rbdb, "get_rekordbox_pid", lambda *a, **k: 4242)
    monkeypatch.setattr(rbguard, "options_db_path", lambda *a, **k: tmp_path / "Pioneer" / "rekordbox" / "master.db")
    diff = svc.export(ids=["t200"])
    assert diff["guard"]["bypass_running_check"] and diff["changed"]
    assert read_back(test_db, FOLDER)["playlists"]["pool"] == [library["beta"]]

    # ...but not when rekordbox has this very DB open.
    monkeypatch.setattr(rbguard, "options_db_path", lambda *a, **k: test_db)
    item = svc.store.get_item("t200")
    item["tags"] = ["pool", "house"]
    svc.store.upsert_items({"t200": item})
    with pytest.raises(WriteRefused, match="this DB open"):
        svc.export(ids=["t200"])
    assert "house" not in read_back(test_db, FOLDER)["playlists"]


def test_latest_counts_located_items(svc):
    diff = export(svc, latest=2, dry_run=True)
    # t400 is the newest item but not located, so the two most recent located items are picked.
    assert [i["id"] for i in diff["selected_items"]] == ["a100", "t200"]


def test_xml_fallback(svc, library):
    result = svc.write_xml(ids=["a100", "t200", "t300", "t400"])
    root = ET.parse(result["path"]).getroot()
    tracks = {t.get("TrackID"): t for t in root.find("COLLECTION")}
    assert len(tracks) == 4
    paths = {tid: urllib.parse.unquote(t.get("Location").removeprefix("file://localhost")) for tid, t in tracks.items()}
    assert all(t.get("Location").startswith("file://localhost/") and not t.get("Location").startswith("file://localhost//")
               for t in tracks.values())
    assert sorted(paths.values()) == sorted(library["alpha"] + [library["beta"]])
    folder = root.find("PLAYLISTS/NODE/NODE")
    assert folder.get("Name") == FOLDER
    lists = {n.get("Name"): [paths[t.get("Key")] for t in n] for n in folder}
    assert lists == {
        "must": library["alpha"],
        "pool": [library["beta"]],
        "electro": [library["beta"]],
        "closer": library["alpha"],
        "ritual": [library["alpha"][1]],
    }
    assert all(int(n.get("Entries")) == len(n) for n in folder)


def _content_fields(test_db, path):
    with rbguard.database(test_db, for_write=False) as db:
        c = find_content(db, path)
        return (c.Title, c.Artist.Name if c.Artist else None, c.Album.Name if c.Album else None)


def test_untagged_file_gets_metadata_from_the_item(svc, library, test_db):
    bare = str(write_aiff(library["root"] / "Farfa - Ability EP" / "07.Francesco Farfa - File #2.aiff", None, None, None, None))
    item = _item("t500", "File #2", "Francesco Farfa", "Farfability", 7, ["must"], "2026-10-26T05:00:00Z")
    va = _item("t600", "Lechuga Zafiro - Oração", "V/A", "NAAFI X", 1, ["must"], "2026-10-26T05:00:00Z")
    va_file = str(write_aiff(library["root"] / "loose" / "Lechuga Zafiro - Oração.aiff", None, None, None, None))
    svc.store.upsert_items({"t500": item, "t600": va})
    export(svc, ids=["t500", "t600", "t200"])
    assert _content_fields(test_db, bare) == ("File #2", "Francesco Farfa", "Farfability")
    assert _content_fields(test_db, va_file) == ("Oração", "Lechuga Zafiro", "NAAFI X")
    # Tags in the file win over the item's metadata.
    item200 = svc.store.get_item("t200")
    item200["title"], item200["album_title"] = "Beta Song (Bandcamp spelling)", "Other Album Name"
    svc.store.upsert_items({"t200": item200})
    export(svc, ids=["t200"])
    assert _content_fields(test_db, library["beta"]) == ("Beta Song", "Beta", "Single")


def test_empty_fields_of_our_rows_are_filled_on_reexport(svc, library, test_db):
    bare = str(write_aiff(library["root"] / "Real Artist - Real Album" / "01 Real Title.aiff", None, None, None, None))
    svc.store.upsert_items({"t500": _item("t500", "Real Title", "Real Artist", "Real Album", 1, ["pool"], "2026-10-26T05:00:00Z")})
    export(svc, ids=["t500"])
    with rbguard.database(test_db, for_write=True, **GUARD) as db:  # as an older export left it
        c = find_content(db, bare)
        c.Title, c.ArtistID, c.AlbumID = None, None, None
        rbguard.guarded_commit(db, test_db, **GUARD)
    diff = export(svc, ids=["t500"])
    assert diff["changed"] and diff["content_updated"] == [{"path": bare, "fields": ["Title", "Artist", "Album"]}]
    assert _content_fields(test_db, bare) == ("Real Title", "Real Artist", "Real Album")
    assert not export(svc, ids=["t500"])["changed"]


def test_user_rows_are_not_filled(svc, library, test_db):
    with rbguard.database(test_db, for_write=True, **GUARD) as db:
        db.add_content(library["beta"])  # imported by hand, no title
        rbguard.guarded_commit(db, test_db, **GUARD)
    diff = export(svc, ids=["t200"])
    assert diff["content_updated"] == [] and _content_fields(test_db, library["beta"])[0] is None


def test_unavailable_files_leave_existing_entries_alone(svc, library, test_db, tmp_path):
    export(svc, ids=["t200"])
    (tmp_path / "unmounted").mkdir()
    moved = tmp_path / "unmounted" / "beta.aiff"
    Path(library["beta"]).rename(moved)  # the drive goes away; the locate result still points there
    from bc_tagger_server.rbexport import build_selection, export as rb_export

    selection = build_selection(svc.store, [svc.store.get_item("t200")], svc.store.get_tags(), svc.playlist_rule())
    assert selection.skipped == [{"id": "t200", "title": "Beta Song", "status": "unavailable"}]
    diff = rb_export(svc.store, svc.target(GUARD), selection)
    assert not diff["changed"] and diff["entries_removed"] == []
    assert read_back(test_db, FOLDER)["playlists"]["pool"] == [library["beta"]]


def test_import_rows_go_to_rekordbox_without_joining_the_collection(svc, library, test_db):
    from fastapi.testclient import TestClient

    from bc_tagger_server import importer
    from bc_tagger_server.api import create_app
    from bc_tagger_server.collection import other_all, pending_adds

    export(svc, ids=["t200"])  # Beta Song is in the collection: pool, electro
    batch = importer.create_batch(svc, {"format": "bc-tagger-import/1", "source": "temp", "items": [
        {"line": 1, "artist": "Alpha", "title": "Alpha 1", "album": "Alpha Album", "tags": ["temp"]},
        {"line": 2, "artist": "Beta", "title": "Beta Song", "album": "Single", "tags": ["ritual"]},
        {"line": 3, "artist": "Nobody", "title": "Nowhere", "tags": ["temp"]}]}, [])
    bid = batch["batch_id"]
    rows = importer.load_rows(svc.store, bid)
    importer._locate(svc, rows)
    importer._save_rows(svc.store, bid, rows)
    refs = [f"{bid}:0", f"{bid}:1", f"{bid}:2", "imp-nope:0"]
    items_before, before = svc.store.count_items(), read_back(test_db, FOLDER)

    dry = export(svc, rows=refs, dry_run=True)
    assert dry["rows"] and dry["confirm_token"] and read_back(test_db, FOLDER) == before
    assert {s["id"]: s["status"] for s in dry["skipped_items"]} == {f"{bid}:2": "missing",
                                                                    "imp-nope:0": "no such import row"}
    diff = export(svc, rows=refs)
    state = read_back(test_db, FOLDER)
    alpha, beta = library["alpha"], library["beta"]
    assert state["playlists"]["temp"] == [alpha[0]] and state["playlists"]["ritual"] == [beta]
    assert state["playlists"]["pool"] == [beta] and state["playlists"]["electro"] == [beta]  # t200's, unchanged
    assert sorted(diff["content_added"]) == [alpha[0]]
    # nothing joined the collection
    assert svc.store.count_items() == items_before and other_all(svc.store) == []
    assert [a.get("tags") for a in pending_adds(svc.store)] == [["temp"]]  # only the new tag, no items
    assert diff["created_tags"] == ["temp"] and "temp" in svc.store.get_tags()
    claims = {r["item_id"] for r in svc.store.query("SELECT item_id FROM rb_claims")}
    assert claims == {"t200", f"{bid}:0", f"{bid}:1"}
    exported = {r["n"]: r.get("exported") for r in importer.load_rows(svc.store, bid)}
    assert exported[0]["target"] == "test" and exported[1] and exported[2] is None
    # the collection item's next export keeps the row's entry; the row's own re-export manages it
    assert not export(svc, ids=["t200"])["changed"]
    importer.update_row(svc, bid, 1, {"tags": []})
    again = export(svc, rows=[f"{bid}:1"])
    assert [(e["tag"], e["path"]) for e in again["entries_removed"]] == [(f"/{FOLDER}/ritual", beta)]
    assert read_back(test_db, FOLDER)["playlists"]["pool"] == [beta]
    with TestClient(create_app(svc)) as c:
        assert c.post("/api/rekordbox/export", json={"rows": refs, "ids": ["t200"], "dry_run": True}).status_code == 400
        assert c.post("/api/rekordbox/export", json={"rows": [], "dry_run": True}).status_code == 400
        job = c.post("/api/rekordbox/export", json={"rows": [f"{bid}:0"], "dry_run": True}).json()
        result = svc.jobs.wait(job["job_id"], timeout=60)
        assert result.status == "done" and not result.result["changed"]


def test_import_rows_use_the_collections_tag_to_playlist_mapping(svc, library, test_db):
    from bc_tagger_server import importer

    svc.settings.update({"tag_playlist_mode": "custom", "tag_playlist_map": {"temp": ["Sets/Warmup"], "must": ["Must"]}})
    batch = importer.create_batch(svc, {"format": "bc-tagger-import/1", "source": "temp", "items": [
        {"line": 1, "artist": "Alpha", "title": "Alpha 1", "album": "Alpha Album", "tags": ["temp", "must", "ritual"]}]},
        [])
    svc.scan()
    rows = importer.load_rows(svc.store, batch["batch_id"])
    importer._locate(svc, rows)
    importer._save_rows(svc.store, batch["batch_id"], rows)
    diff = export(svc, rows=[f"{batch['batch_id']}:0"])
    assert sorted(e["tag"] for e in diff["entries_added"]) == [f"/{FOLDER}/Must", f"/{FOLDER}/Sets/Warmup"]
    # no playlist for it in the mapping: not exported, the same warning as for items
    assert [w["message"] for w in diff["warnings"] if w["code"] == "unmapped_tags"] == [
        "not exported (no playlist mapped): ritual"]


def test_new_tags_of_import_rows_can_be_created_then_mapped(svc, library, test_db):
    from fastapi.testclient import TestClient

    from bc_tagger_server import importer
    from bc_tagger_server.api import create_app
    from bc_tagger_server.collection import pending_adds

    svc.scan()
    batch = importer.create_batch(svc, {"format": "bc-tagger-import/1", "source": "temp", "items": [
        {"line": 1, "artist": "Alpha", "title": "Alpha 1", "album": "Alpha Album", "tags": ["warmup", "must"]}]}, [])
    bid = batch["batch_id"]
    rows = importer.load_rows(svc.store, bid)
    importer._locate(svc, rows)
    importer._save_rows(svc.store, bid, rows)
    svc.settings.update({"tag_playlist_mode": "custom", "tag_playlist_map": {"must": ["Must"]}})
    with TestClient(create_app(svc)) as c:
        assert c.get(f"/api/import/{bid}").json()["uncreated_tags"] == ["warmup"]
        dry = export(svc, rows=[f"{bid}:0"], dry_run=True)
        assert dry["new_tags"] == ["warmup"]
        assert dry["tag_playlists"] == [{"tag": "must", "new": False, "playlists": [f"/{FOLDER}/Must"], "created": False},
                                        {"tag": "warmup", "new": True, "playlists": [], "created": False}]  # not mapped yet
        assert dry["created_tags"] == [] and "warmup" not in svc.store.get_tags()  # a dry run creates nothing
        r = c.post("/api/tags/create", json={"tags": ["warmup", "must"]}).json()
        assert r["created"] == ["warmup"] and r["existing"] == ["must"] and "warmup" in svc.store.get_tags()
        assert [a["tags"] for a in pending_adds(svc.store) if "tags" in a] == [["warmup"]]  # for the extension
        assert c.post("/api/tags/create", json={"tags": ["warmup"]}).json()["created"] == []
        assert c.get(f"/api/import/{bid}").json()["uncreated_tags"] == []
    # mapped in Settings: the next export sends it there
    svc.settings.update({"tag_playlist_map": {"must": ["Must"], "warmup": ["Sets/Warmup"]}})
    diff = export(svc, rows=[f"{bid}:0"])
    assert sorted(e["tag"] for e in diff["entries_added"]) == [f"/{FOLDER}/Must", f"/{FOLDER}/Sets/Warmup"]
    assert diff["new_tags"] == []

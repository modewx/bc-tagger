"""Folders dragged onto the page: finding them on disk from what the browser gives (POST /api/fs/find-folder),
and adding them to an open import (POST /api/import/<id>/folders). Fixture trees only, with a stand-in home
folder; Spotlight is stubbed (it would search the real disk)."""

from __future__ import annotations

import threading

import pytest
from fastapi.testclient import TestClient

from bc_tagger_server import filesimport, findfolder, importer
from bc_tagger_server.api import create_app

from .conftest import write_aiff
from .test_files_import import aged, since, start, tree, write_flac  # noqa: F401 (tree: the fixture)

ALBUM = "Artist N - Drop (2026)"


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A home folder with a real folder named "~" in it (like the user's /Users/alvaroh/~/Music)."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(findfolder, "spotlight", lambda name, timeout: None)  # "unavailable": the walk runs
    return home


def album(folder, days=100):
    """Two old FLACs, one on a disc folder: ``since`` null must still find them."""
    a = aged(write_flac(folder / "01 Intro.flac", "Intro", "Artist N", "Drop", 1), days)
    b = aged(write_flac(folder / "CD2" / "02 Outro.flac", "Outro", "Artist N", "Drop", 2), days)
    return a, b


def sample(folder, *files):
    return {"name": folder.name, "count": len(files),
            "files": [{"rel": str(f.relative_to(folder)), "size": f.stat().st_size} for f in files]}


def events_of(svc, monkeypatch):
    events = []
    publish = svc.jobs.bus.publish
    monkeypatch.setattr(svc.jobs.bus, "publish", lambda kind, data: (events.append((kind, data)), publish(kind, data)))
    return events


# -- finding the folder -------------------------------------------------------------------------------


def test_a_folder_inside_a_folder_named_tilde_is_found_and_added_as_it_is(tree, home, monkeypatch):
    svc, coll, complete, files = tree
    drop = home / "~" / "Music" / ALBUM
    intro, outro = album(drop)
    copy = home / "Downloads" / "stuff" / ALBUM  # a second copy: both are offered
    album(copy)
    album(home / "Music" / ALBUM)  # the same name with other files: no match
    (home / "Music" / ALBUM / "01 Intro.flac").write_bytes(b"not the same size")
    album(home / "Library" / "Caches" / ALBUM)  # never looked in
    album(home / ".Trash" / ALBUM)
    with TestClient(create_app(svc)) as c:
        r = c.post("/api/fs/find-folder", json=sample(drop, intro, outro))
        assert r.status_code == 200, r.text
        found = r.json()
        assert [(m["path"], m["source"], m["audio_files"]) for m in found["matches"]] == [
            (str(copy), "walk", 2), (str(drop), "walk", 2)]
        assert found["sources"] == ["index", "walk"] and not found["timed_out"] and found["ms"] < 2000
        assert "/home/~/Music/" in found["matches"][1]["path"]  # the folder's real name, not the home folder

        batch, job = svc.start_files_import([{"path": str(coll), "since": since(7)}], ["pool"])
        assert svc.jobs.wait(job.id, timeout=30).status == "done"
        r = c.post(f"/api/import/{batch['batch_id']}/folders", json={"folders": [{"path": str(drop), "since": None}]})
        assert r.status_code == 200 and r.json()["queued"] is False, r.text
        assert svc.jobs.wait(r.json()["job_id"], timeout=30).status == "done"
        rows = c.get(f"/api/import/{batch['batch_id']}").json()["rows"]
    added = [x for x in rows if x["folder_index"] == 1]
    assert [(x["title"], x["raw"]) for x in added] == [("Intro", str(intro)), ("Outro", str(outro))]
    assert all(x["located"]["best"]["path"].startswith(str(home / "~")) for x in added)
    assert svc.store.query_one("SELECT root FROM files WHERE path = ?", (str(intro),))["root"] == str(drop)


def test_the_index_and_spotlight_find_it_without_a_walk(tree, home, monkeypatch):
    svc, coll, complete, files = tree
    ep = coll / "Artist B - New EP (2026)"
    other = home / "Music" / ep.name  # Spotlight's copy
    for f in ("01 First.aiff", "02 Second.aiff"):
        other.mkdir(parents=True, exist_ok=True)
        (other / f).write_bytes((ep / f).read_bytes())
    wrong = home / "Desktop" / ep.name
    wrong.mkdir(parents=True)
    (wrong / "01 First.aiff").write_bytes(b"x")
    hidden = home / ".hidden" / ep.name
    hidden.mkdir(parents=True)
    (hidden / "01 First.aiff").write_bytes((ep / "01 First.aiff").read_bytes())
    asked = []
    monkeypatch.setattr(findfolder, "spotlight", lambda name, timeout: asked.append((name, timeout)) or [
        str(wrong), str(other), str(hidden)])
    walked = []
    monkeypatch.setattr(findfolder, "_walk", lambda *a: walked.append(a) or iter(()))
    body = sample(ep, files["first_aiff"])
    with TestClient(create_app(svc)) as c:
        found = c.post("/api/fs/find-folder", json=body).json()
        assert [(m["path"], m["source"]) for m in found["matches"]] == [(str(ep), "index"), (str(other), "spotlight")]
        assert found["sources"] == ["index", "spotlight"] and walked == []
        assert asked[0][0] == ep.name and 0 < asked[0][1] <= findfolder.SPOTLIGHT_S
        # "count" puts the copy holding that many audio files first
        found = c.post("/api/fs/find-folder", json={**body, "count": 2}).json()
        assert [m["audio_files"] for m in found["matches"]] == [2, 3]
        assert found["matches"][0]["path"] == str(other)
        # nothing of that name anywhere
        found = c.post("/api/fs/find-folder", json={**body, "name": "Nowhere"}).json()
        assert found["matches"] == [] and found["sources"] == ["index", "spotlight", "walk"]


def test_a_folder_the_index_knows_on_an_unplugged_drive_is_not_looked_at(tree, home, monkeypatch):
    svc, coll, complete, files = tree
    with svc.store.tx() as c:
        c.execute("INSERT INTO files(path, root, root_kind, size, mtime, ext, format, release_dir, scanned_at) "
                  "VALUES(?, '/Volumes/bc-tagger-no-such-drive', 'owned', 5, 0, '.flac', 'flac', ?, 'x')",
                  ("/Volumes/bc-tagger-no-such-drive/M/Gone/01 a.flac", "/Volumes/bc-tagger-no-such-drive/M/Gone"))
    stats = []
    monkeypatch.setattr(findfolder, "_verify", lambda folder, *a: stats.append(folder) or False)
    found = findfolder.find(svc, "Gone", [("01 a.flac", 5)], budget=0.5)
    assert found["matches"] == [] and not any(p.startswith("/Volumes/bc-tagger-no-such-drive") for p in stats)


def test_the_walk_stops_at_the_time_budget(tree, home):
    svc, coll, complete, files = tree
    deep = home / "Music" / "a" / "b" / ALBUM
    intro, outro = album(deep)
    found = findfolder.find(svc, ALBUM, [(str(intro.relative_to(deep)), intro.stat().st_size)], budget=0.0)
    assert found["matches"] == [] and found["timed_out"]
    found = findfolder.find(svc, ALBUM, [(str(intro.relative_to(deep)), intro.stat().st_size)])
    assert [m["path"] for m in found["matches"]] == [str(deep)] and not found["timed_out"]
    too_deep = home / "Music" / "a" / "b" / "c" / "d" / "Deeper"  # 5 below ~/Music
    aged(write_flac(too_deep / "01 x.flac", "x", "y", "z", 1), 1)
    assert findfolder.find(svc, "Deeper", [("01 x.flac", (too_deep / "01 x.flac").stat().st_size)])["matches"] == []


def test_find_folder_rejects_what_isnt_a_folder_sample(tree, home):
    svc, coll, complete, files = tree
    with TestClient(create_app(svc)) as c:
        for body, message in (({"name": "a/b", "files": [{"rel": "x.flac", "size": 1}]}, "not a folder name"),
                              ({"name": "..", "files": [{"rel": "x.flac", "size": 1}]}, "not a folder name"),
                              ({"name": "A", "files": [{"rel": "../x.flac", "size": 1}]}, "not a path inside"),
                              ({"name": "A", "files": [{"rel": "/etc/x", "size": 1}]}, "not a path inside"),
                              ({"name": "A", "files": []}, "no files to recognise it by")):
            r = c.post("/api/fs/find-folder", json=body)
            assert r.status_code == 400 and message in r.json()["detail"], (body, r.text)
        assert c.post("/api/fs/find-folder", json={"name": "A", "files": [{"rel": "x", "size": -1}]}).status_code == 422


# -- adding folders to a batch ----------------------------------------------------------------------


def test_folders_added_to_a_files_batch_continue_its_rows_and_skip_its_files(tree, home, monkeypatch, tmp_path):
    svc, coll, complete, files = tree
    drop = tmp_path / "elsewhere" / ALBUM
    intro, outro = album(drop)
    events = events_of(svc, monkeypatch)
    looked_up = []
    lookup = importer._lookup
    monkeypatch.setattr(importer, "_lookup", lambda f, row, *a: looked_up.append(row["n"]) or lookup(f, row, *a))
    with TestClient(create_app(svc)) as c:
        r = start(c, [{"path": str(coll), "since": since(7)}])
        assert svc.jobs.wait(r["job_id"], timeout=30).status == "done"
        bid = r["batch_id"]
        c.put(f"/api/import/{bid}/rows/1", json={"tags": ["must"]})  # the user's edits stay
        before = c.get(f"/api/import/{bid}").json()
        assert [(x["n"], x["line"], x["title"]) for x in before["rows"]] == [
            (0, 1, "First"), (1, 2, "Second"), (2, 3, "Old Track"), (3, 4, "Later")]
        looked_up.clear()
        job = c.post(f"/api/import/{bid}/folders", json={"folders": [{"path": str(drop), "since": None}]}).json()
        result = svc.jobs.wait(job["job_id"], timeout=30)
        assert result.status == "done", result.error
        assert result.result["added"] == 2 and result.result["already"] == 0 and result.result["found"] == 2
        batch = c.get(f"/api/import/{bid}").json()
        assert batch["status"] == "ready" and batch["job"] is None and batch["error"] is None
        assert [f["path"] for f in batch["folders"]] == [str(coll), str(drop)] and batch["folders"][1]["since"] is None
        new = batch["rows"][4:]
        assert [(x["n"], x["line"], x["folder_index"], x["title"], x["tags"]) for x in new] == [
            (4, 5, 1, "Intro", ["pool"]), (5, 6, 1, "Outro", ["pool"])]
        assert all(x["located"]["source"] == "file" and x["checked"] for x in new)
        assert batch["rows"][:4] == before["rows"] and batch["rows"][1]["tags"] == ["must"]
        assert looked_up == [4, 5]  # only the new rows
        assert batch["files"] == {"found": 7, "rows": 6} and batch["stats"]["total"] == 6
        assert str(drop) in svc.store.get_meta(filesimport.RUNS_META)
        # the whole collection folder, every file: only "Old One" (30 days old) is new to the batch
        job = c.post(f"/api/import/{bid}/folders", json={"folders": [{"path": str(coll), "since": "all"}]}).json()
        result = svc.jobs.wait(job["job_id"], timeout=30)
        assert result.result["added"] == 1 and result.result["already"] == 4, result.result
        batch = c.get(f"/api/import/{bid}").json()
    assert [(x["line"], x["folder_index"], x["title"]) for x in batch["rows"][6:]] == [(7, 0, "Old One")]
    assert batch["folders"][0]["since"] is None  # widened to every file
    assert [a["rows"] for a in batch["added_folders"]] == [2, 1]
    phases = [d["phase"] for k, d in events if k == "import" and d["batch_id"] == bid]
    assert "adding" in phases and phases[-1] == "done"


def test_folders_added_to_a_json_batch(tree, home, monkeypatch):
    svc, coll, complete, files = tree
    batch = importer.create_batch(svc, {"format": importer.FORMAT, "items": [
        {"line": 12, "title": "Some Song", "artist": "Someone"}]}, ["pool"])
    importer.run_batch(svc, batch["batch_id"])
    bid = batch["batch_id"]
    song = importer.load_rows(svc.store, bid)[0]
    with TestClient(create_app(svc)) as c:
        job = c.post(f"/api/import/{bid}/folders", json={"folders": [
            {"path": str(complete / "Bootlegs"), "since": None}, {"path": str(complete / "Unknown - Thing")}]}).json()
        assert svc.jobs.wait(job["job_id"], timeout=30).status == "done"
        got = c.get(f"/api/import/{bid}").json()
        rows = got["rows"]
        assert got["kind"] == "json" and got["status"] == "ready" and rows[0] == {**song, "owned": None}
        assert [(x["n"], x["line"], x["folder_index"], x["title"]) for x in rows[1:]] == [
            (1, 13, 0, "Old Track"), (2, 14, 1, "Thing")]
        dup = rows[1]  # already in the collection (t900): unchecked, as in a files import
        assert dup["duplicate"]["of"] == "t900" and not dup["checked"] and rows[2]["checked"]
        result = c.post(f"/api/import/{bid}/commit").json()
    assert result["other_added"] == 2 and result["skipped"] == 1  # "Some Song" and "Thing"
    thing = next(x for x in importer.load_rows(svc.store, bid) if x["title"] == "Thing")
    assert svc.get_item_view(thing["commit_info"]["item_id"])["local"]["best"]["path"] == str(files["thing"])
    log = (svc.settings.path.parent / "import-logs" / result["log_md"]).read_text()
    assert f"folder `{complete / 'Bootlegs'}` all files" in log


def test_folders_added_while_the_browser_looks_up(tree, home, tmp_path):
    svc, coll, complete, files = tree
    drop = tmp_path / "elsewhere" / ALBUM
    album(drop)
    with TestClient(create_app(svc)) as c:
        r = start(c, [{"path": str(complete), "since": since(7)}], lookup="browser")
        assert svc.jobs.wait(r["job_id"], timeout=30).status == "done"
        bid = r["batch_id"]
        assert c.get(f"/api/import/{bid}").json()["step"] == "browser"
        job = c.post(f"/api/import/{bid}/folders", json={"folders": [{"path": str(drop), "since": None}]}).json()
        assert svc.jobs.wait(job["job_id"], timeout=30).status == "done"
        batch = c.get(f"/api/import/{bid}").json()
        assert batch["step"] == "browser" and len(batch["rows"]) == 4  # the lookups went on: still the page's
        pending = c.get(f"/api/import/{bid}/lookups").json()
    assert sorted(n for p in pending["pending"] for n in p["rows"]) == [1, 2, 3]  # "Thing" and the two new rows


def test_folders_wait_for_the_batchs_running_job(tree, home, tmp_path):
    svc, coll, complete, files = tree
    drop = tmp_path / "elsewhere" / ALBUM
    album(drop)
    batch, job = svc.start_files_import([{"path": str(coll), "since": since(7)}], ["pool"])
    assert svc.jobs.wait(job.id, timeout=30).status == "done"
    bid = batch["batch_id"]
    gate = threading.Event()
    blocker = svc.jobs.submit("import-details", lambda ctx: gate.wait(10))
    importer.set_job(svc, bid, blocker)
    with TestClient(create_app(svc)) as c:
        r = c.post(f"/api/import/{bid}/folders", json={"folders": [{"path": str(drop), "since": None}]}).json()
        assert r["queued"] is True and c.get(f"/api/import/{bid}").json()["job"]["id"] == blocker.id
        gate.set()
        assert svc.jobs.wait(r["job_id"], timeout=30).status == "done"
        assert len(c.get(f"/api/import/{bid}").json()["rows"]) == 6


def test_what_cant_be_added(tree, home, tmp_path, monkeypatch):
    svc, coll, complete, files = tree
    drop = tmp_path / "elsewhere" / ALBUM
    album(drop)
    batch, job = svc.start_files_import([{"path": str(coll), "since": since(7)}], ["pool"])
    assert svc.jobs.wait(job.id, timeout=30).status == "done"
    bid = batch["batch_id"]

    def add(folders, batch_id=bid):
        return c.post(f"/api/import/{batch_id}/folders", json={"folders": folders})

    with TestClient(create_app(svc)) as c:
        assert add([{"path": str(drop)}], "imp-nope").status_code == 404
        for folders, message in (([], "add at least one folder"),
                                 ([{"path": str(tmp_path / "gone")}], "folder not found"),
                                 ([{"path": "~/Music"}], "not a full folder path"),  # "~" is never expanded here
                                 ([{"path": str(drop), "since": "soon"}], "since must be a date")):
            r = add(folders)
            assert r.status_code == 400 and message in r.json()["detail"], (folders, r.text)
        # the scan fails in the job (the drive went away): nothing added, the batch as it was
        monkeypatch.setattr(filesimport, "_scan", lambda *a: (_ for _ in ()).throw(
            importer.ImportError_("music drive not mounted: /Volumes/X (plug it in; nothing was written)")))
        failed = svc.jobs.wait(add([{"path": str(drop)}]).json()["job_id"], timeout=30)
        assert failed.status == "error" and "music drive not mounted" in failed.error
        after = c.get(f"/api/import/{bid}").json()
        assert after["status"] == "ready" and len(after["rows"]) == 4 and after.get("folders") == batch["folders"]
        assert after["error"].startswith("Adding folders stopped: music drive not mounted") and "nothing was added" in \
            after["error"]
        c.post(f"/api/import/{bid}/commit")
        r = add([{"path": str(drop)}])
        assert r.status_code == 409 and "already imported" in r.json()["detail"]
        b = importer.load_batch(svc.store, bid)
        b.update(status="resolving", job_id="gone", job_boot="an-earlier-run")  # a restart during its lookups
        importer._save_batch(svc.store, b)
        r = add([{"path": str(drop)}])
        assert r.status_code == 409 and "resume it first" in r.json()["detail"]


def test_a_files_import_of_every_file_in_a_folder(tree, home):
    svc, coll, complete, files = tree
    with TestClient(create_app(svc)) as c:
        for since_value in (None, "all"):
            r = start(c, [{"path": str(coll), "since": since_value}])
            assert svc.jobs.wait(r["job_id"], timeout=30).status == "done"
            batch = c.get(f"/api/import/{r['batch_id']}").json()
            assert batch["folders"] == [{"path": str(coll), "since": None}]
            assert [x["title"] for x in batch["rows"]] == ["Old One", "First", "Second", "Old Track", "Later"]


def test_a_queued_locate_leaves_lookups_that_rows_added_reopened(tree, home):
    svc, coll, complete, files = tree
    batch, job = svc.start_files_import([{"path": str(complete), "since": since(7)}], ["pool"], lookup="browser")
    assert svc.jobs.wait(job.id, timeout=30).status == "done"
    bid = batch["batch_id"]
    gate = threading.Event()
    blocker = svc.jobs.submit("import-details", lambda ctx: gate.wait(10))
    importer._finish_browser(svc, importer.load_batch(svc.store, bid))  # the lookups ended: locate, queued
    b = importer.load_batch(svc.store, bid)
    b["phase"] = "browser"  # then an add reopened them
    importer._save_batch(svc.store, b)
    finish = svc.jobs.get(importer.load_batch(svc.store, bid)["job_id"])
    gate.set()
    assert svc.jobs.wait(blocker.id, timeout=30).status == "done"
    assert svc.jobs.wait(finish.id, timeout=30).result["skipped"]
    assert importer.load_batch(svc.store, bid)["status"] == "resolving"

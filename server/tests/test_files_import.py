"""Phase 7: Import from Files, on a fixture tree with real file dates (never the drive or Bandcamp)."""

from __future__ import annotations

import html
import json
import os
import struct
import time
from datetime import datetime, timedelta
from pathlib import Path

import mutagen.flac
import pytest
from fastapi.testclient import TestClient

from bc_tagger_server import filesimport, importer
from bc_tagger_server.api import create_app
from bc_tagger_server.collection import other_get, pending_adds
from bc_tagger_server.fetcher import Fetcher

from .conftest import write_aiff

DAY = 86400
LATER_URL = "https://artistc.bandcamp.com/track/later"

if not hasattr(os.stat(Path(__file__)), "st_birthtime"):
    pytest.skip("needs file creation times (macOS)", allow_module_level=True)


def write_flac(path: Path, title=None, artist=None, album=None, track=None, comment=None) -> Path:
    """A tiny FLAC (STREAMINFO only) with Vorbis comments."""
    path.parent.mkdir(parents=True, exist_ok=True)
    packed = (8000 << 44) | (0 << 41) | (15 << 36)  # 8 kHz, mono, 16 bits, 0 samples
    info = struct.pack(">HH", 4096, 4096) + b"\0" * 6 + packed.to_bytes(8, "big") + b"\0" * 16
    path.write_bytes(b"fLaC" + bytes([0x80]) + len(info).to_bytes(3, "big") + info)
    f = mutagen.flac.FLAC(path)
    f.add_tags()
    for key, value in (("title", title), ("artist", artist), ("album", album), ("tracknumber", track),
                       ("comment", comment)):
        if value is not None:
            f[key] = str(value)
    f.save()
    return path


def aged(path: Path, days: float) -> Path:
    """Created (and modified) ``days`` ago: setting an older mtime moves the birthtime back too."""
    t = time.time() - days * DAY
    os.utime(path, (t, t))
    return path


def later_page() -> str:
    tralbum = {"current": {"id": 777, "title": "Later", "type": "track", "band_id": 5}, "url": LATER_URL,
               "artist": "Artist C", "item_type": "track", "trackinfo": [{"id": 777, "title": "Later", "track_num": 1}]}
    return f'<div data-tralbum="{html.escape(json.dumps(tralbum))}"></div>'


@pytest.fixture
def tree(make_service, tmp_path):
    coll, complete = tmp_path / "Collection", tmp_path / "complete"
    files = {
        "old": aged(write_aiff(coll / "Artist A - Old EP" / "01 Old One.aiff", "Old One", "Artist A", "Old EP", 1), 30),
        "first_flac": aged(write_flac(coll / "Artist B - New EP (2026)" / "01 First.flac", "First", "Artist B",
                                      "New EP", 1), 3),
        "first_aiff": aged(write_aiff(coll / "Artist B - New EP (2026)" / "01 First.aiff", "First", "Artist B",
                                      "New EP", 1), 3),
        "second": aged(write_aiff(coll / "Artist B - New EP (2026)" / "02 Second.aiff", "Second", "Artist B",
                                  "New EP", 2), 3),
        "tagged": aged(write_aiff(coll / "Artist Z - Old" / "01 Old Track.aiff", "Old Track", "Artist Z", "Old", 1), 2),
        "later": aged(write_flac(coll / "Artist C - Later" / "01 Later.flac", "Later", "Artist C", "Later", 1,
                                 f"Visit {LATER_URL}"), 1),
        "boot": aged(write_flac(complete / "Bootlegs" / "05 Dup.flac", "Old Track", "Artist Z", "Bootlegs", 5), 2),
        "thing": aged(write_flac(complete / "Unknown - Thing" / "01 Thing.flac"), 1),
    }
    items = {"t900": {"title": "Old Track", "artist": "Artist Z", "album_title": "Old", "track_num": 1,
                      "tags": ["must"], "date_added": "2026-10-01T00:00:00.000Z"}}
    svc = make_service(complete, items=items, tags=["must", "pool"])
    svc.settings.update({"owned_root": str(coll), "not_owned_roots": [{"path": str(complete), "globs": []}]})
    svc.scan()
    svc.locate(ids=["t900"], scan="none")
    with svc.store.tx() as c:
        c.execute("INSERT INTO http_cache(key, url, status, body, fetched_at) VALUES(?, ?, 200, ?, ?)",
                  (Fetcher.cache_key("GET", LATER_URL, None), LATER_URL, later_page(), "2026-10-26T00:00:00+00:00"))
    svc.bandcamp_fetcher = lambda: Fetcher(svc.store, "test", offline=True)
    return svc, coll, complete, files


def since(days: float) -> str:
    return (datetime.now() - timedelta(days=days)).date().isoformat()


def start(c, folders, **kw):
    r = c.post("/api/import/files", json={"folders": folders, "default_tags": ["pool"], **kw})
    assert r.status_code == 200, r.text
    return r.json()


def test_rows_from_new_files(tree):
    svc, coll, complete, files = tree
    new = aged(write_aiff(coll / "Artist B - New EP (2026)" / "03 Third.aiff", "Third", "Artist B", "New EP", 3), 3)
    with TestClient(create_app(svc)) as c:  # "Third" came after the full scan: the quick scan finds it
        r = start(c, [{"path": str(coll), "since": since(7)}, {"path": str(complete), "since": since(7)}])
        assert r["estimate"]["text"] == "scanning the folders first"
        assert svc.jobs.wait(r["job_id"], timeout=30).status == "done"
        batch = c.get(f"/api/import/{r['batch_id']}").json()
    assert batch["status"] == "ready" and batch["kind"] == "files" and batch["scanned"]
    assert batch["name"] == "files Collection + complete" and batch["default_tags"] == ["pool"]
    rows = batch["rows"]
    got = [(r["line"], r["folder_index"], r["artist"], r["title"]) for r in rows]
    # folder 1 then 2; within a folder oldest release first, then track number; 30 days old: left out
    assert got == [(1, 0, "Artist B", "First"), (2, 0, "Artist B", "Second"), (3, 0, "Artist B", "Third"),
                   (4, 0, "Artist Z", "Old Track"), (5, 0, "Artist C", "Later"),
                   (6, 1, "Artist Z", "Old Track"), (7, 1, "Unknown", "Thing")]
    first = rows[0]
    assert first["raw"] == str(files["first_aiff"]) and first["file"]["format"] == "aiff"  # format_preference
    assert {f["format"] for f in first["file"]["formats"]} == {"aiff", "flac"}
    assert first["located"]["status"] == "located" and first["located"]["source"] == "file"
    assert first["located"]["best"]["path"] == str(files["first_aiff"]) and first["album"] == "New EP"
    assert first["track_num"] == 1 and first["tags"] == ["pool"] and first["checked"]
    assert rows[2]["raw"] == str(new) and rows[6]["album"] == "Thing" and rows[6]["track_num"] == 1
    # already in the collection: by its located file, or by artist + title; unchecked
    for dup in (rows[3], rows[5]):
        assert dup["duplicate"]["of"] == "t900" and not dup["checked"] and dup["match"]["status"] == "in_collection"
    assert rows[3]["existing_id"] == "t900" and rows[3]["located"]["best"]["path"] == str(files["tagged"])
    # a Bandcamp URL in the tags: that page, no search
    later = rows[4]
    assert later["bandcamp_url"] == LATER_URL and later["match"]["source"] == "file"
    assert later["bandcamp"]["item"]["id"] == "t777" and later["source"] == "bandcamp"
    assert batch["stats"]["located"] == 7 and batch["files"] == {"found": 8, "rows": 7}


def test_commit_numbers_in_row_order_and_confirms_the_files(tree):
    svc, coll, complete, files = tree
    with TestClient(create_app(svc)) as c:
        r = start(c, [{"path": str(coll), "since": since(7)}, {"path": str(complete), "since": since(7)}])
        assert svc.jobs.wait(r["job_id"], timeout=30).status == "done"
        result = c.post(f"/api/import/{r['batch_id']}/commit").json()
    assert result["skipped"] == 2 and result["tag_merges"] == 0  # the two duplicates stayed unchecked
    rows = importer.load_rows(svc.store, r["batch_id"])
    new = [x for x in rows if x["committed"]]
    assert [(x["line"], x["title"]) for x in new] == [(1, "First"), (2, "Second"), (4, "Later"), (6, "Thing")]
    orders = [x["commit_info"]["order"] for x in new]
    assert orders == sorted(orders) and orders == list(range(orders[0], orders[0] + 4))
    adds = {a["item"]["id"]: a["item"] for a in pending_adds(svc.store) if "item" in a}
    assert adds["t777"]["tags"] == ["pool"] and adds["t777"]["order"] == orders[2]
    thing = other_get(svc.store, new[3]["commit_info"]["item_id"])
    assert thing["order"] == orders[3] and thing["modified_at"] == result["modified_at"]
    confirmed = dict(svc.store.query("SELECT item_id, path FROM match_overrides WHERE decision = 'confirm'"))
    assert confirmed["t777"] == str(files["later"]) and confirmed[thing["id"]] == str(files["thing"])
    log = json.loads((svc.settings.path.parent / "import-logs" / result["log"]).read_text())
    assert log["batch"]["source"] == "files" and [f["path"] for f in log["batch"]["folders"]] == [str(coll),
                                                                                                    str(complete)]
    assert log["counts"]["unchecked"] == 2 and log["rows"][0]["located"]["path"] == str(files["first_aiff"])


def test_since_and_defaults(tree):
    svc, coll, complete, files = tree
    with TestClient(create_app(svc)) as c:
        d = c.get("/api/import/files/defaults").json()
        assert [(f["path"], f["kind"], f["since"], f["last_run"]) for f in d["folders"]] == [
            (str(coll), "owned", since(7), None), (str(complete), "not_owned", since(7), None)]
        assert d["default_tags"] == ["pool"] and all(f["mounted"] and f["exists"] for f in d["folders"])
        r = start(c, [{"path": str(coll), "since": since(2.5)}])  # only the last two days' releases
        assert svc.jobs.wait(r["job_id"], timeout=30).status == "done"
        titles = [x["title"] for x in c.get(f"/api/import/{r['batch_id']}").json()["rows"]]
        assert titles == ["Old Track", "Later"]
        d = c.get("/api/import/files/defaults").json()
        assert d["folders"][0]["since"] == datetime.now().date().isoformat() and d["folders"][0]["last_run"]
        assert d["folders"][1]["last_run"] is None and str(coll) in d["remembered"]


def test_folders_are_checked_before_anything_is_written(tree, tmp_path):
    svc, coll, complete, files = tree
    with TestClient(create_app(svc)) as c:
        cases = [([], "add at least one folder"),
                 ([{"path": str(tmp_path / "nope"), "since": since(7)}], "folder not found"),
                 ([{"path": "/Volumes/bc-tagger-no-such-drive/Music", "since": since(7)}], "music drive not mounted"),
                 ([{"path": "relative/folder", "since": since(7)}], "not a full folder path"),
                 ([{"path": str(coll), "since": "last week"}], "since must be a date")]
        for folders, message in cases:
            r = c.post("/api/import/files", json={"folders": folders, "default_tags": ["pool"]})
            assert r.status_code == 400 and message in r.json()["detail"], (folders, r.text)
        assert c.get("/api/import").json() == [] and svc.store.get_meta(filesimport.RUNS_META) is None
    assert not Path("/Volumes/bc-tagger-no-such-drive").exists()


def test_browser_lookups_and_no_new_files(tree):
    svc, coll, complete, files = tree
    with TestClient(create_app(svc)) as c:
        r = start(c, [{"path": str(complete), "since": since(0.5)}])  # nothing that new
        assert svc.jobs.wait(r["job_id"], timeout=30).status == "done"
        batch = c.get(f"/api/import/{r['batch_id']}").json()
        assert batch["status"] == "ready" and batch["rows"] == [] and batch["files"] == {"found": 0, "rows": 0}
        r = start(c, [{"path": str(complete), "since": since(7)}], lookup="browser")
        assert svc.jobs.wait(r["job_id"], timeout=30).status == "done"
        batch = c.get(f"/api/import/{r['batch_id']}").json()
        assert batch["lookup"] == "browser" and [x["title"] for x in batch["rows"]] == ["Old Track", "Thing"]
        assert not batch["rows"][0]["checked"] and batch["rows"][0]["duplicate"]["of"] == "t900"
        pending = c.get(f"/api/import/{r['batch_id']}/lookups").json()
        assert [p["rows"] for p in pending["pending"]] == [[1]]  # only "Thing" needs Bandcamp


def test_a_subfolder_keeps_its_root_and_a_restart_while_scanning_resumes(tree):
    svc, coll, complete, files = tree
    ep = coll / "Artist B - New EP (2026)"
    new = aged(write_aiff(ep / "03 Third.aiff", "Third", "Artist B", "New EP", 3), 1)
    batch = filesimport.create(svc, [{"path": str(ep), "since": since(7)}], ["pool"])
    b = importer.load_batch(svc.store, batch["batch_id"])
    b.update(job_id="gone", job_boot="an-earlier-run")  # the server restarted before the scan ran
    importer._save_batch(svc.store, b)
    with TestClient(create_app(svc)) as c:
        assert c.get(f"/api/import/{batch['batch_id']}").json()["status"] == "interrupted"
        job = c.post(f"/api/import/{batch['batch_id']}/resume").json()
        assert svc.jobs.wait(job["job_id"], timeout=30).status == "done"
        rows = c.get(f"/api/import/{batch['batch_id']}").json()["rows"]
    assert [x["title"] for x in rows] == ["First", "Second", "Third"]
    assert svc.store.query_one("SELECT root FROM files WHERE path = ?", (str(new),))["root"] == str(coll)

""""Set file…" for collection items (any audio file in the roots) and "Back to automatic"."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from bc_tagger_server.api import create_app

from .conftest import write_aiff


@pytest.fixture
def setup(make_service, tmp_path):
    music = tmp_path / "music"
    auto = write_aiff(music / "Artist A - Album" / "01 Song A.aiff", "Song A", "Artist A", "Album", 1)
    write_aiff(music / "Album B" / "01 X.aiff", "X", "Artist B", "Album B", 1)
    write_aiff(music / "Album B" / "02 Y.aiff", "Y", "Artist B", "Album B", 2)
    svc = make_service(music, items={
        "t1": {"title": "Song A", "artist": "Artist A", "album_title": "Album", "track_num": 1},
        "a5": {"title": "Something Else Entirely", "artist": "Nobody", "album_title": "something-else", "track_num": -1},
    })
    svc.scan()
    svc.locate(scan="none")
    events = []
    publish = svc.jobs.bus.publish
    svc.jobs.bus.publish = lambda kind, data: (events.append((kind, data)), publish(kind, data))[1]
    with TestClient(create_app(svc)) as c:
        yield {"svc": svc, "c": c, "music": music, "auto": str(auto), "events": events, "tmp": tmp_path}


def local(c, item_id):
    return c.get(f"/api/items/{item_id}").json()["local"]


def test_set_file_indexes_a_file_in_the_roots_with_no_title_overlap(setup):
    c, svc, music = setup["c"], setup["svc"], setup["music"]
    assert local(c, "t1")["best"]["path"] == setup["auto"] and local(c, "t1")["manual"] is False
    picked = write_aiff(music / "Loose" / "rip.aiff", "Totally Different", "Someone", "Bootleg", 7)  # not indexed
    assert svc.store.query_one("SELECT 1 FROM files WHERE path = ?", (str(picked),)) is None
    r = c.post("/api/matches/t1/set-file", json={"path": str(picked)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["item_id"] == "t1" and body["path"] == str(picked) and body["decision"] == "confirm"
    view = body["item"]["local"]
    assert view["status"] == "located" and view["best"]["path"] == str(picked) and view["best"]["method"] == "confirmed"
    assert view["manual"] is True
    assert setup["auto"] in [cand["path"] for cand in view["candidates"]]  # the automatic match stays offered
    assert svc.store.query_one("SELECT 1 FROM files WHERE path = ?", (str(picked),)) is not None
    assert ("item", {"id": "t1"}) in setup["events"]
    # the list carries it too (the collection page reads that)
    row = next(it for it in c.get("/api/items", params={"ids": "t1"}).json() if it["id"] == "t1")
    assert row["local"]["manual"] is True and row["local"]["best"]["path"] == str(picked)


def test_set_file_takes_what_an_import_row_takes(setup):
    """The import's "Set file…" helper: any audio file (outside the roots, its folder counts as a not-owned
    root), and its folder is where the file browser opens next, on either page."""
    c, svc, music, tmp = setup["c"], setup["svc"], setup["music"], setup["tmp"]
    before = svc.store.query("SELECT * FROM match_overrides")
    r = c.post("/api/matches/t1/set-file", json={"path": str(music / "Loose" / "gone.aiff")})
    assert r.status_code == 400 and "no such file" in r.json()["detail"]
    (music / "notes.txt").write_text("x")
    r = c.post("/api/matches/t1/set-file", json={"path": str(music / "notes.txt")})
    assert r.status_code == 400 and "not an audio file" in r.json()["detail"]
    elsewhere = write_aiff(tmp / "elsewhere" / "x.aiff", "Whatever", "Someone", "Else", 1)
    assert c.post("/api/matches/nope/set-file", json={"path": str(elsewhere)}).status_code == 404
    assert svc.store.query_one("SELECT 1 FROM files WHERE path = ?", (str(elsewhere),)) is None  # 404 first
    assert svc.store.query("SELECT * FROM match_overrides") == before
    assert c.get("/api/settings").json()["last_browse_dir"] == ""
    r = c.post("/api/matches/t1/set-file", json={"path": str(elsewhere)})
    assert r.status_code == 200 and r.json()["item"]["local"]["best"]["path"] == str(elsewhere)
    row = svc.store.query_one("SELECT root_kind FROM files WHERE path = ?", (str(elsewhere),))
    assert row["root_kind"] == "not_owned"
    assert c.get("/api/settings").json()["last_browse_dir"] == str(tmp / "elsewhere")
    picked = write_aiff(music / "Loose" / "rip.aiff", "Totally Different", "Someone", "Bootleg", 7)
    c.post("/api/matches/t1/set-file", json={"path": str(picked)})
    assert c.get("/api/settings").json()["last_browse_dir"] == str(music / "Loose")


def test_a_manual_file_survives_scans_and_locates(setup):
    c, svc, music = setup["c"], setup["svc"], setup["music"]
    picked = write_aiff(music / "Loose" / "rip.aiff", "Totally Different", "Someone", "Bootleg", 7)
    c.post("/api/matches/t1/set-file", json={"path": str(picked)})
    svc.scan()  # a full scan
    svc.locate(ids=["t1"], scan="quick")  # "Locate again"
    assert local(c, "t1")["best"]["path"] == str(picked)
    job = c.post("/api/locate", json={"ids": ["t1"], "scan": "full"}).json()  # a locate job
    assert svc.jobs.wait(job["job_id"], timeout=30).status == "done"
    svc.locate(scan="none")  # everything
    view = local(c, "t1")
    assert view["best"]["path"] == str(picked) and view["manual"] is True


def test_back_to_automatic_keeps_the_rejects(setup):
    c, svc, music = setup["c"], setup["svc"], setup["music"]
    other = write_aiff(music / "Another" / "01 Song A.aiff", "Song A", "Artist A", "Another", 1)
    svc.scan()
    c.post("/api/matches/t1/reject", json={"path": str(other)})
    picked = write_aiff(music / "Loose" / "rip.aiff", "Totally Different", "Someone", "Bootleg", 7)
    c.post("/api/matches/t1/set-file", json={"path": str(picked)})
    setup["events"].clear()
    r = c.delete("/api/matches/t1/confirm")
    assert r.status_code == 200, r.text
    view = r.json()  # the item view itself
    assert view["id"] == "t1" and view["local"]["manual"] is False
    assert view["local"]["best"]["path"] == setup["auto"] and view["local"]["best"]["method"] != "confirmed"
    assert ("item", {"id": "t1"}) in setup["events"]
    decisions = {r["path"]: r["decision"] for r in svc.store.query("SELECT path, decision FROM match_overrides "
                                                                    "WHERE item_id = 't1'")}
    assert decisions == {str(other): "reject"}
    assert c.delete("/api/matches/nope/confirm").status_code == 404


def test_set_file_on_an_album_item_confirms_its_release(setup):
    c, music = setup["c"], setup["music"]
    assert local(c, "a5")["status"] != "located"  # no overlap with "Album B" at all
    r = c.post("/api/matches/a5/set-file", json={"path": str(music / "Album B" / "02 Y.aiff")}).json()
    assert r["path"] == str(music / "Album B")
    view = r["item"]["local"]
    assert view["status"] == "located" and view["manual"] is True and view["best"]["path"] == str(music / "Album B")

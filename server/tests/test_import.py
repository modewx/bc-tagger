"""Phase 3 import flow on recorded Bandcamp responses (tests/fixtures/bandcamp_recorded.json,
replayed by an offline fetcher), never the live site."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bc_tagger_server import importer
from bc_tagger_server.api import create_app
from bc_tagger_server.collection import pending_adds
from bc_tagger_server.fetcher import Fetcher

from .conftest import write_aiff

FIXTURES = Path(__file__).parent / "fixtures"


def recorded_rows() -> list[dict]:
    """annotations.json rows (revision 3) whose Bandcamp responses were recorded."""
    return json.loads((FIXTURES / "import_rows.json").read_text())


def load_recorded(store) -> None:
    entries = json.loads((FIXTURES / "bandcamp_recorded.json").read_text())
    with store.tx() as c:
        for e in entries:
            c.execute("INSERT OR REPLACE INTO http_cache(key, url, status, body, fetched_at) VALUES(?, ?, ?, ?, ?)",
                      (e["key"], e["url"], e["status"], e["body"], "2026-10-26T00:00:00+00:00"))


@pytest.fixture
def svc(make_service, tmp_path):
    music = tmp_path / "music"
    write_aiff(music / "Space Drum Meditation - SDM005" / "01. Astika.aiff", "Astika", "Space Drum Meditation", "SDM005", 1)
    for n, title in ((8, "Acht"), (9, "Neun")):  # an untitled release: titles that don't help
        write_aiff(music / "Gregor Schnitzler - Conrad & Sohn" / f"{n:02d} {title}.aiff", title, "Gregor Schnitzler",
                   "Conrad & Sohn", n)
    items = {  # already tagged in the collection (duplicates in the import)
        "t3244411361": {"title": "Elhwah", "artist": "Gil.Barte", "album_title": "Claviceps Purpurea", "track_num": 4,
                        "tags": ["must", "industrial"], "date_added": "2026-10-25T06:05:12.800Z"},
        "t3973705564": {"title": "Atacama", "artist": "Bunzinelli", "album_title": "Atacama EP", "track_num": 1,
                        "tags": ["must", "build"], "date_added": "2026-10-26T00:11:38.501Z"},
    }
    s = make_service(music, items=items, tags=["must", "pool", "build", "industrial", "ritual", "poly", "ebm", "melancholic"])
    load_recorded(s.store)
    s.bandcamp_fetcher = lambda: Fetcher(s.store, "test", offline=True)
    s.scan()
    return s


def run(svc, rows, default_tags=("must",)):
    batch = importer.create_batch(svc, {"format": "bc-tagger-import/1", "source": "test", "revision": 3, "items": rows,
                                        "unknown_tags": {"mourn": ["melancholic"]},
                                        "pending_releases": [{"line": 20, "release": "x"}]}, list(default_tags))
    importer.run_batch(svc, batch["batch_id"])
    return importer.get_batch(svc, batch["batch_id"])


def row_at(batch, line, title=None):
    return next(r for r in batch["rows"] if r["line"] == line and (title is None or r["title"] == title))


# A page the user opened for a row the resolver missed (the extension sends what it reads there).
PAGE_ITEM = {"id": "t1111111111", "tralbum_type": "t", "item_type": "track", "title": "The Human Being Disgusts",
             "artist": "UFO", "album_title": "Birth", "album_id": "a2222222222", "track_num": 3,
             "item_url": "https://example-label.bandcamp.com/track/the-human-being-disgusts",
             "album_url": "https://example-label.bandcamp.com/album/birth"}


def test_lookup_duplicates_locate_and_stats(svc):
    rows = recorded_rows()
    batch = run(svc, rows)
    assert batch["status"] == "ready" and batch["revision"] == 3 and len(batch["pending_releases"]) == 1
    for line, item_id in ((211, "t3244411361"), (297, "t3973705564")):
        r = row_at(batch, line)
        assert r["source"] == "bandcamp" and r["bandcamp"]["via"] == "collection"
        assert r["bandcamp"]["item"]["id"] == item_id and "tags" not in r["bandcamp"]["item"]
        assert r["duplicate"]["of"] == item_id and r["match"]["status"] == "in_collection" and r["checked"]
        assert r["match"]["source"] == "collection" and r["match"]["item"]["id"] == item_id
    # the file's Bandcamp URL (a release page): the track is picked from its tracklist, no search
    sd = row_at(batch, 1)
    assert sd["match"]["source"] == "file" and sd["match"]["status"] == "accepted" and sd["match_source"] == "file"
    assert sd["source"] == "bandcamp" and sd["bandcamp"]["via"] == "resolved"
    assert sd["bandcamp"]["item"]["album_url"] == "https://superdrama.bandcamp.com/album/select-edits-2017-2020"
    assert sd["links"]["bandcamp"] == sd["hints"]["bandcamp_url"] and sd["links"]["bandcamp_is_hint"]
    assert sd["bandcamp"]["item"].get("partial") is None and sd["bandcamp"]["item"]["file"]  # the file's URL: full page
    # found by search: the search answer only (no page request); the page comes later, if asked for
    butterfly = row_at(batch, 13)
    assert butterfly["match"]["source"] == "search" and butterfly["match"]["status"] == "accepted"
    item = butterfly["bandcamp"]["item"]
    assert item["id"] == "t3425186059" and item["album_id"].startswith("a") and item["partial"] is True
    assert item["item_url"].startswith("https://") and "file" not in item
    assert butterfly["match"]["item"] == item  # also under match.item
    assert batch["estimate"]["lookups"] == 0 and batch["estimate"]["cached"] >= 8  # all recorded
    # not found: other, with the file's Discogs URL and a Bandcamp search to open in the browser
    carbon = [r for r in batch["rows"] if r["line"] == 48]
    assert all(r["source"] == "other" for r in carbon)
    assert carbon[0]["links"]["discogs"].startswith("https://www.discogs.com/release/91375")
    assert carbon[0]["links"]["bandcamp"].startswith("https://bandcamp.com/search?q=The+Carbon+Boys")
    astika = row_at(batch, 206)
    assert astika["located"]["status"] == "located" and astika["located"]["best"]["path"].endswith("01. Astika.aiff")
    # "Untitled", track 9 of Conrad & Sohn: matched by album + track number
    untitled = row_at(batch, 11)
    assert untitled["located"]["best"]["path"].endswith("09 Neun.aiff")
    assert untitled["located"]["best"]["method"] == "track_num"
    s = batch["stats"]
    assert s["total"] == len(rows) and s["duplicates"] == 2 and s["in_collection"] == 2
    assert s["bandcamp"] == s["in_collection"] + s["found"] and s["found"] >= 4 and s["linked"] == 0
    assert s["bandcamp"] + s["other"] == len(rows) and s["located"] >= 2 and s["pending_releases"] == 1
    assert s["unavailable"] == 0 and batch["bandcamp_lookups"] == {"state": "on"}
    # default tags only for rows without tags
    assert row_at(batch, 297)["tags"] == ["must"]
    assert row_at(batch, 211)["tags"] == ["muertos", "dubstep", "industrial", "ritual"]


def test_link_rows_to_bandcamp_pages(svc):
    batch = run(svc, recorded_rows())
    bid = batch["batch_id"]
    uf0 = row_at(batch, 181)
    assert uf0["source"] == "other"
    # the extension asks which rows fit the page the user has open
    cands = importer.link_candidates(svc, {"item": PAGE_ITEM})
    assert cands[0]["n"] == uf0["n"] and cands[0]["score"] >= 0.85 and cands[0]["via"] is None
    # a row whose Bandcamp hint is this page (or its album) fits too
    sd = row_at(batch, 1)
    page = {"id": "t99", "title": "Take It As A Game (Super Drama Mix)", "artist": "Super Drama",
            "item_url": "https://superdrama.bandcamp.com/track/take-it-as-a-game",
            "album_url": "https://superdrama.bandcamp.com/album/select-edits-2017-2020"}
    hit = importer.link_candidates(svc, {"item": page})[0]
    assert hit["n"] == sd["n"] and hit["hint_match"]

    row = importer.link_row(svc, bid, uf0["n"], {"item": {**PAGE_ITEM, "tags": ["junk"]}})
    assert row["source"] == "bandcamp" and row["bandcamp"]["via"] == "linked" and row["duplicate"] is None
    assert row["bandcamp"]["item"]["id"] == "t1111111111" and "tags" not in row["bandcamp"]["item"]
    assert importer.link_candidates(svc, {"item": PAGE_ITEM})[0]["via"] == "linked"
    # linking a page that's already in the collection makes the row its duplicate
    carbon = row_at(batch, 48)
    row = importer.link_row(svc, bid, carbon["n"], {"item": {"id": "t3244411361", "title": "Elhwah", "artist": "Gil.Barte"}})
    assert row["duplicate"]["of"] == "t3244411361"
    row = importer.link_row(svc, bid, carbon["n"], {"item": None})  # unlink: back to what the resolver found
    assert row["source"] == "other" and row["bandcamp"] is None and row["duplicate"] is None
    with pytest.raises(importer.ImportError_):
        importer.link_row(svc, bid, carbon["n"], {"item": {"id": "o123", "title": "x"}})
    assert importer.get_batch(svc, bid)["stats"]["linked"] == 1


def test_tag_mapping_edits_and_commit(svc):
    rows = recorded_rows()
    rows.append({"line": 999, "raw": "x", "artist": "Nobody Here", "title": "Not Anywhere", "album": None,
                 "tags": ["mourn", "peak"], "discogs_url": "https://www.discogs.com/release/1"})
    batch = run(svc, rows)
    bid = batch["batch_id"]
    assert set(batch["unknown_tags"]) >= {"mourn", "peak", "muertos", "dubstep"}
    assert batch["unknown_tags"]["mourn"] == ["melancholic"]
    res = importer.apply_tag_mapping(svc, bid, {"mourn": ["melancholic", "ritual"]}, "create")
    assert "peak" in res["new_tags"] and "mourn" not in res["new_tags"]
    batch = importer.get_batch(svc, bid)
    nobody = row_at(batch, 999)
    assert nobody["tags"] == ["melancholic", "ritual", "peak"] and nobody["source"] == "other"

    uf0 = row_at(batch, 181)
    importer.link_row(svc, bid, uf0["n"], {"item": PAGE_ITEM})
    butterfly = row_at(batch, 13)
    bf_id = butterfly["bandcamp"]["item"]["id"]
    importer.update_row(svc, bid, butterfly["n"], {"tags": ["must", "poly"]})
    importer.update_row(svc, bid, row_at(batch, 206)["n"], {"checked": False})
    found = sum(r["source"] == "bandcamp" and not r["duplicate"] for r in importer.get_batch(svc, bid)["rows"]
                if r["checked"])

    result = importer.commit(svc, bid)
    assert result["tag_merges"] == 2 and result["pending_adds"] == found and result["other_added"] >= 1
    assert result["skipped"] == 1 and "peak" in result["new_tags"] and "peak" in svc.store.get_tags()
    adds = pending_adds(svc.store)
    added = {a["item"]["id"]: a["item"] for a in adds if "item" in a}
    assert "t1111111111" in added and bf_id in added
    assert added[bf_id]["tags"] == ["must", "poly"] and added[bf_id]["date_added"].endswith("Z")
    assert any(a.get("tags") and "peak" in a["tags"] for a in adds)
    edits = {e["item_id"]: e["tags"] for e in svc.pending_tag_edits()}
    assert set(edits["t3244411361"]) == {"must", "industrial", "muertos", "dubstep", "ritual"}  # union
    _, items = svc.list_items()
    by_id = {i["id"]: i for i in items}
    assert by_id[bf_id]["pending"] == "tagger" and by_id[bf_id]["source"] == "bandcamp"
    # editing a queued item's tags edits the queued add, not the tag-edit queue
    assert svc.queue_tag_edit(bf_id, ["pool"])["pending"] == "tagger"
    assert next(a for a in pending_adds(svc.store) if a.get("item", {}).get("id") == bf_id)["item"]["tags"] == ["pool"]
    assert bf_id not in {e["item_id"] for e in svc.pending_tag_edits()}
    # other items keep their hints as links, and the row's metadata
    other = {i["title"]: i for i in items if i["source"] == "other"}
    assert other["Not Anywhere"]["links"]["discogs"] == "https://www.discogs.com/release/1"
    assert other["Not Anywhere"]["import_batch"] == bid and other["Not Anywhere"]["line"] == 999
    carbon = [i for i in items if i["source"] == "other" and i.get("line") == 48]
    assert len(carbon) == 2 and carbon[0]["id"] != carbon[1]["id"]  # B1 and B2 stay two tracks
    assert carbon[0]["links"]["discogs"].startswith("https://www.discogs.com/release/91375")
    assert importer.get_batch(svc, bid)["status"] == "committed"
    with pytest.raises(importer.ImportError_):
        importer.commit(svc, bid)


def test_api_flow(svc):
    rows = recorded_rows()
    with TestClient(create_app(svc)) as c:
        r = c.post("/api/import", json={"file": {"format": "bc-tagger-import/1", "items": rows}, "default_tags": ["must"]}).json()
        assert svc.jobs.wait(r["job_id"], timeout=30).status == "done"
        bid = r["batch_id"]
        batch = c.get(f"/api/import/{bid}").json()
        assert batch["status"] == "ready" and len(batch["rows"]) == len(rows)
        assert [b["batch_id"] for b in c.get("/api/import").json()] == [bid]
        row = next(x for x in batch["rows"] if x["source"] == "bandcamp" and x["match"]["candidates"]
                   and not x["duplicate"])
        changed = c.put(f"/api/import/{bid}/rows/{row['n']}", json={"choose": None}).json()  # not on Bandcamp
        assert changed["source"] == "other" and changed["match"]["status"] == "manual"
        changed = c.put(f"/api/import/{bid}/rows/{row['n']}", json={"choose": row["match"]["candidates"][0]["id"]}).json()
        assert changed["source"] == "bandcamp" and changed["bandcamp"]["via"] == "chosen"
        assert changed["match"]["source"] == "picked"
        assert c.put(f"/api/import/{bid}/rows/{row['n']}", json={"choose": "t1"}).status_code == 400
        uf0 = next(x for x in batch["rows"] if x["line"] == 181)
        assert c.post("/api/import/link-candidates", json={"item": PAGE_ITEM}).json()[0]["n"] == uf0["n"]
        assert c.post(f"/api/import/{bid}/rows/{uf0['n']}/link", json={}).status_code == 400
        assert c.post(f"/api/import/{bid}/rows/{uf0['n']}/link", json={"item": {"id": "x"}}).status_code == 400
        linked = c.post(f"/api/import/{bid}/rows/{uf0['n']}/link", json={"item": PAGE_ITEM}).json()
        assert linked["source"] == "bandcamp"
        assert c.post(f"/api/import/{bid}/rows/999/link", json={"item": None}).status_code == 404
        assert c.post(f"/api/import/{bid}/tags", json={"map": {}, "unmapped": "ignore"}).status_code == 200
        res = c.post(f"/api/import/{bid}/commit").json()
        assert res["pending_adds"] >= 2
        adds = c.get("/api/tagger/pending-adds").json()
        assert c.post("/api/tagger/pending-adds/ack", json={"ids": [a["add_id"] for a in adds]}).json()["acked"] == len(adds)
        assert c.get("/api/tagger/pending-adds").json() == []
        other = c.get("/api/items", params={"source": "other"}).json()
        assert other and {i["source"] for i in other} == {"other"}
        bc = c.get("/api/items", params={"source": "bandcamp"}).json()
        assert {i["source"] for i in bc} == {"bandcamp"}
        oid = other[0]["id"]
        edit = c.post("/api/tag-edits", json={"id": oid, "tags": ["pool"]}).json()
        assert edit["applied"] is True and c.get(f"/api/items/{oid}").json()["tags"] == ["pool"]
        assert c.post("/api/import", json={"file": {"format": "nope"}}).status_code == 400
        assert c.delete(f"/api/import/{bid}").json() == {"deleted": True}
        assert c.get(f"/api/import/{bid}").status_code == 404


def test_other_items_locate_with_the_rest(svc):
    from bc_tagger_server.collection import other_put

    other_put(svc.store, {"id": "o0123456789", "kind": "track", "artist": "Space Drum Meditation", "title": "Astika",
                          "album": None, "tags": ["ritual"], "date_added": "2026-10-26T09:00:00.000Z"})
    result = svc.locate(ids=["o0123456789"], scan="none")
    assert result["items"][0]["status"] == "located"
    view = svc.get_item_view("o0123456789")
    assert view["source"] == "other" and view["owned"]["status"] == "unknown"
    assert view["links"]["youtube"] and view["links"]["bandcamp"].startswith("https://bandcamp.com/search?")


def test_user_set_url_link_item_and_open_rows(svc):
    batch = run(svc, recorded_rows())
    bid = batch["batch_id"]
    uf0, carbon = row_at(batch, 181), row_at(batch, 48)
    with TestClient(create_app(svc)) as c:
        open_rows = c.get("/api/import/open-rows").json()
        assert {(r["batch_id"], r["n"]) for r in open_rows} == {(bid, r["n"]) for r in batch["rows"] if r["source"] == "other"}
        assert next(r for r in open_rows if r["n"] == carbon["n"])["position"] == "B1"
        # a Bandcamp page the user found: stored, not fetched; it becomes the row's Bandcamp link
        url = "https://example-label.bandcamp.com/track/the-human-being-disgusts"
        row = c.put(f"/api/import/{bid}/rows/{uf0['n']}", json={"match_url": url + "?from=search"}).json()
        assert row["match"]["status"] == "manual" and row["match"]["source"] == "url" and row["match"]["url"] == url
        assert row["source"] == "other" and row["links"]["bandcamp"] == url and row["match"]["item"] is None
        assert next(r for r in c.get("/api/import/open-rows").json() if r["n"] == uf0["n"])["match_url"] == url
        assert c.put(f"/api/import/{bid}/rows/{uf0['n']}", json={"match_url": "https://x.com/nope"}).status_code == 400
        # the item the extension saved from that page
        row = c.put(f"/api/import/{bid}/rows/{uf0['n']}", json={"link_item": PAGE_ITEM}).json()
        assert row["source"] == "bandcamp" and row["match"]["source"] == "linked" and row["match"]["status"] == "manual"
        assert row["match"]["chosen"]["id"] == row["match"]["item"]["id"] == "t1111111111"
        assert uf0["n"] not in {r["n"] for r in c.get("/api/import/open-rows").json()}
        # a URL-only row is imported as an "other" item that keeps the URL
        c.put(f"/api/import/{bid}/rows/{carbon['n']}", json={"match_url": "https://x.bandcamp.com/album/cosmic-function"})
        c.post(f"/api/import/{bid}/commit")
        other = [i for i in c.get("/api/items", params={"source": "other"}).json() if i.get("position") == "B1"]
        assert other[0]["links"]["bandcamp"] == "https://x.bandcamp.com/album/cosmic-function"
        assert c.get("/api/import/open-rows").json() == []


def _challenge_fetcher(store, calls):
    import httpx

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(403, text="<html><head><title>Client Challenge</title></head><body>…</body></html>")

    return Fetcher(store, "test", min_interval=0, transport=httpx.MockTransport(handler))


def test_bot_check_stops_the_batch(svc):
    with svc.store.tx() as c:
        c.execute("DELETE FROM http_cache")  # nothing recorded: every lookup goes to the (stub) site
    calls: list[str] = []
    svc.bandcamp_fetcher = lambda: _challenge_fetcher(svc.store, calls)
    batch = run(svc, recorded_rows())
    assert len(calls) == 1  # the first lookup got the bot check; nothing after it, no retry
    looked_up = [r for r in batch["rows"] if r["match"]["status"] != "in_collection"]
    assert looked_up and all(r["match"]["status"] == "unavailable" and r["match"]["reason"] == "challenge"
                             for r in looked_up)
    assert all("Client Challenge" in r["match"]["error"] or "bot check" in r["match"]["error"] for r in looked_up)
    assert batch["bandcamp_lookups"]["state"] == "stopped" and batch["stats"]["unavailable"] == len(looked_up)
    sd = row_at(batch, 1)
    assert sd["hints"]["bandcamp_url"].startswith("https://superdrama.bandcamp.com/")  # hints kept
    assert svc.store.query_one("SELECT count(*) AS n FROM http_cache WHERE body LIKE '%Client Challenge%'")["n"] == 0
    # re_resolve while stopped: the same state, no request
    row = importer.update_row(svc, batch["batch_id"], row_at(batch, 13)["n"], {"re_resolve": True})
    assert row["match"]["status"] == "unavailable" and len(calls) == 1
    # other batches don't ask either (for an hour)
    batch2 = run(svc, recorded_rows()[:3])
    assert len(calls) == 1 and batch2["bandcamp_lookups"]["state"] == "stopped"
    # the rest of the flow still works: duplicates, locate, commit
    assert row_at(batch, 211)["source"] == "bandcamp" and row_at(batch, 206)["located"]["status"] == "located"
    assert importer.commit(svc, batch["batch_id"])["tag_merges"] == 2


def test_lookups_off_and_fixtures_switches(svc, monkeypatch):
    monkeypatch.setenv("BC_TAGGER_BANDCAMP", "off")
    calls: list[str] = []
    svc.bandcamp_fetcher = lambda: _challenge_fetcher(svc.store, calls)
    batch = run(svc, recorded_rows())
    assert calls == [] and batch["bandcamp_lookups"]["state"] == "off"
    assert {r["match"]["status"] for r in batch["rows"]} == {"in_collection", "unavailable"}
    monkeypatch.delenv("BC_TAGGER_BANDCAMP")
    # recorded answers only, from a file: what B's e2e uses
    from bc_tagger_server import bandcamp

    monkeypatch.setenv("BC_TAGGER_BANDCAMP_FIXTURES", str(FIXTURES))
    svc.store.set_meta("bandcamp_challenge", None)
    svc.bandcamp_fetcher = lambda: bandcamp.make_fetcher(svc.store)
    batch = run(svc, recorded_rows())
    assert row_at(batch, 13)["match"]["status"] == "accepted" and batch["stats"]["unavailable"] == 0


def test_details_job_fetches_pages_only_when_asked(svc):
    batch = run(svc, recorded_rows())
    bid = batch["batch_id"]
    est = importer.prepare_job(svc, bid, "details")
    assert est["requests"] == 0 and est["cached"] >= 1  # the recorded pages
    result = importer.fetch_details(svc, bid)
    assert result["fetched"] >= 1 and result["stopped"] is None
    item = row_at(importer.get_batch(svc, bid), 13)["bandcamp"]["item"]
    assert item.get("partial") is None and item["file"]["mp3-128"] and item["track_num"]
    with pytest.raises(importer.ImportError_, match="aren't paused"):
        importer.prepare_job(svc, bid, "resume")


def test_rate_limit_pauses_and_resume_continues(svc):
    import httpx

    with svc.store.tx() as c:
        c.execute("DELETE FROM http_cache")
    calls: list[str] = []
    sleeps: list[float] = []

    def limited(request):
        calls.append(str(request.url))
        return httpx.Response(429, headers={"Retry-After": "7"} if len(calls) == 1 else {}, text="slow down")

    def fetcher_for(handler):
        f = Fetcher(svc.store, "test", min_interval=2.5, transport=httpx.MockTransport(handler))
        f.sleep = sleeps.append
        return f

    svc.bandcamp_fetcher = lambda: fetcher_for(limited)
    batch = run(svc, recorded_rows())
    # Retry-After honored once, then 30/60/120 s waits; then the batch pauses (no more requests)
    assert len(calls) == 4 and [round(w) for w in sleeps if w > 3][:3] == [7, 30, 60]
    assert batch["bandcamp_lookups"]["state"] == "paused" and batch["bandcamp_lookups"]["error"] == importer.RATE_LIMITED
    paused = [r for r in batch["rows"] if r["match"]["status"] == "unavailable"]
    assert paused and all(r["match"]["reason"] == "rate_limited" for r in paused)
    assert svc.store.get_meta("bandcamp_challenge") is None  # not a bot check: other batches may still ask
    row = importer.update_row(svc, batch["batch_id"], paused[0]["n"], {"re_resolve": True})
    assert row["match"]["reason"] == "rate_limited" and len(calls) == 4  # paused: no request
    # later: the user resumes; the recorded answers stand in for Bandcamp
    load_recorded(svc.store)
    svc.bandcamp_fetcher = lambda: Fetcher(svc.store, "test", offline=True)
    est = importer.prepare_job(svc, batch["batch_id"], "resume")
    assert est["lookups"] == 0 and est["cached"] == len(paused)
    importer.resume_batch(svc, batch["batch_id"])
    batch = importer.get_batch(svc, batch["batch_id"])
    assert batch["bandcamp_lookups"] == {"state": "on"} and batch["stats"]["unavailable"] == 0
    assert row_at(batch, 13)["match"]["status"] == "accepted"
    assert row_at(batch, 206)["located"]["status"] == "located"


def test_estimate_and_pace(svc):
    import httpx

    with svc.store.tx() as c:
        c.execute("DELETE FROM http_cache")
    svc.settings.update({"bandcamp_request_interval_s": 3})
    assert svc.default_bandcamp_fetcher().min_interval == 3.0
    svc.bandcamp_fetcher = svc.default_bandcamp_fetcher
    with pytest.raises(Exception, match="at least 1"):
        svc.settings.update({"bandcamp_request_interval_s": 0.5})
    batch = importer.create_batch(svc, {"format": "bc-tagger-import/1", "items": recorded_rows()}, ["must"])
    est = batch["estimate"]
    looked_up = len(recorded_rows()) - 2  # Elhwah and Atacama are in the collection
    assert est["lookups"] == looked_up and est["cached"] == 0 and est["interval_s"] == 3.0
    assert est["requests"] == -(-looked_up * 13 // 10) and est["seconds"] == est["requests"] * 3
    assert est["text"].startswith(f"~{looked_up} lookups ≈ ")
    with TestClient(create_app(svc)) as c, pytest.MonkeyPatch.context() as mp:
        mp.setenv("BC_TAGGER_BANDCAMP", "off")
        r = c.post("/api/import", json={"file": {"format": "bc-tagger-import/1", "items": recorded_rows()}}).json()
        assert r["estimate"]["lookups"] >= 0 and "text" in r["estimate"]
        svc.jobs.wait(r["job_id"], timeout=30)

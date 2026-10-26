"""Bandcamp resolver: scoring, search readings, pages, the polite fetcher, link helpers. Never
touches the live site, except the opt-in smoke test (BCT_LIVE_BANDCAMP=1)."""

from __future__ import annotations

import html
import json
import os
import time

import httpx
import pytest

from bc_tagger_server import bandcamp
from bc_tagger_server.bandcamp import Hit, tagger_item
from bc_tagger_server.fetcher import MAX_REDIRECTS, REDIRECT_LOOP, Fetcher, Unavailable
from bc_tagger_server.rowmatch import ACCEPT_AT, score_hit
from bc_tagger_server.store import Store


def hit(id_, title, artist, album=None):
    return Hit(id=id_, type="track" if id_[0] == "t" else "album", title=title, artist=artist, album=album,
               url=f"https://x.bandcamp.com/track/{id_}", art_url=None, raw={})


def test_scoring():
    assert score_hit(hit("t1", "Elhwah", "Gil.Barte", "Claviceps Purpurea"), "Gil.Barte", "Elhwah") >= ACCEPT_AT
    assert score_hit(hit("t1", "Elhwah", "Somebody Else"), "Gil.Barte", "Elhwah") <= 0.6  # other artist: candidate at most
    assert score_hit(hit("t1", "Part 2", "A"), "A", "Part 3") == 0.0  # number guard
    # Title-only rows (artist_missing) are never auto-accepted.
    assert score_hit(hit("t1", "Bones", "Wata Igarashi"), None, "Bones") < ACCEPT_AT
    # Label compilations: the artist is in the track title, ranked just below the artist's own release.
    comp = score_hit(hit("t1", "Visitor - Celebrate Death", "Verboden"), "Visitor", "Celebrate Death")
    own = score_hit(hit("t2", "Celebrate Death", "Visitor"), "Visitor", "Celebrate Death")
    assert ACCEPT_AT <= comp < own
    # Non-Latin titles, Bandcamp's own title suffixes
    assert score_hit(hit("t1", "スカイサーファー", "Sunju Hargun"), "Sunju Hargun", "スカイサーファー") == 1.0
    assert score_hit(hit("t1", "スカイサーファー", "Sunju Hargun"), "Sunju Hargun", "ハロー") == 0.0
    assert score_hit(hit("t1", "The Core (Escape Dub) [Bandcamp Digital Exclusive]", "Olsvangèr"),
                     "Olsvangèr", "The Core (Escape Dub)") >= ACCEPT_AT
    # Only the parenthetical differs: maybe another version, so a candidate
    s = score_hit(hit("t1", "B1 Signs of Inertia", "Titonton"), "Titonton", "Signs Of Inertia (Metamorphic)")
    assert 0.6 < s < ACCEPT_AT
    # A guessed artist must match closely to auto-accept
    assert score_hit(hit("t1", "One Night", "Super Drama"), "Super Drama", "One Night", strict=True) >= ACCEPT_AT
    assert score_hit(hit("t1", "One Night", "Super Dramas Crew"), "Super Drama", "One Night", strict=True) < ACCEPT_AT


class FakeSite:
    """A Fetcher stand-in answering searches and pages from dicts; records what was asked."""

    def __init__(self, answers, pages=None):
        self.answers, self.pages, self.queries, self.network_requests = answers, pages or {}, [], 0

    def request(self, method, url, *, json_body=None, params=None):
        if url == bandcamp.SEARCH_URL:
            self.queries.append(json_body["search_text"])
            return 200, json.dumps({"auto": {"results": self.answers.get(json_body["search_text"], [])}})
        if url in self.pages:
            return 200, self.pages[url]
        return 404, ""


def _result(id_, name, band, album=None, kind="t"):
    return {"type": kind, "id": id_, "name": name, "band_name": band, "album_name": album,
            "item_url_path": f"https://x.bandcamp.com/{'track' if kind == 't' else 'album'}/{id_}", "img": None}


def test_resolve_readings():
    # order_ambiguous: the swapped reading wins.
    f = FakeSite({"Rex The Dog Elektromekanik": [], "Elektromekanik Rex The Dog": [_result(5, "Elektromekanik", "Rex The Dog")]})
    r = bandcamp.resolve(f, {"kind": "track", "artist": "Rex The Dog", "title": "Elektromekanik", "flags": ["order_ambiguous"]})
    assert f.queries == ["Rex The Dog Elektromekanik", "Elektromekanik Rex The Dog"]
    assert r["status"] == "accepted" and r["chosen"]["id"] == "t5"
    # artist_missing: title-only search, candidates (never accepted), top 3 kept.
    f = FakeSite({"Bones": [_result(i, "Bones", f"Artist {i}") for i in range(1, 6)]})
    r = bandcamp.resolve(f, {"kind": "track", "artist": None, "title": "Bones", "flags": ["artist_missing"]})
    assert f.queries == ["Bones"] and r["status"] == "candidates" and len(r["candidates"]) == 3
    # albums use the album filter and match the release name
    f = FakeSite({"DJ Phlowgod Mantha EP": [_result(9, "Mantha EP", "DJ Phlowgod", kind="a")]})
    r = bandcamp.resolve(f, {"kind": "album", "artist": "DJ Phlowgod", "title": "Mantha EP", "flags": []})
    assert r["status"] == "accepted" and r["chosen"]["id"] == "a9" and r["chosen"]["type"] == "album"
    # written the other way round, without the flag: still accepted (both fields agree)
    f = FakeSite({"Halo Welt Quadratschulz": [_result(7, "Halo Welt", "quadratschulz")]})
    r = bandcamp.resolve(f, {"kind": "track", "artist": "Halo Welt", "title": "Quadratschulz", "flags": []})
    assert r["status"] == "accepted" and r["chosen"]["id"] == "t7"
    # a guessed artist is checked against the title-only results
    f = FakeSite({"One Night": [_result(8, "One Night", "Super Drama")]})
    r = bandcamp.resolve(f, {"kind": "track", "artist": "Super Drama", "title": "One Night",
                             "flags": ["artist_missing", "artist_guessed"]})
    assert f.queries == ["One Night"] and r["status"] == "accepted"
    # "artist title" finds nothing: the title alone is searched, the artist still has to match
    f = FakeSite({"Dust Devil": [_result(3, "Dust Devil", "DMX Krew"), _result(4, "Dust Devil", "Someone")]})
    r = bandcamp.resolve(f, {"kind": "track", "artist": "DMX Krew", "title": "Dust Devil", "flags": []})
    assert f.queries == ["DMX Krew Dust Devil", "Dust Devil"] and r["chosen"]["id"] == "t3"
    assert [c["id"] for c in r["candidates"]] == ["t3"]  # other artists' "Dust Devil" aren't offered
    # nothing found
    f = FakeSite({})
    assert bandcamp.resolve(f, {"kind": "track", "artist": "Front 242", "title": "Controversy Between"})["status"] == "none"
    assert f.queries == ["Front 242 Controversy Between", "Controversy Between"]


def test_search_errors_say_what_happened():
    class Site(FakeSite):
        def __init__(self, status, body=""):
            super().__init__({})
            self.status, self.body = status, body

        def request(self, method, url, *, json_body=None, params=None):
            self.queries.append(url)
            return self.status, self.body

    for site, message in ((Site(599, "ConnectError: refused"), "unreachable"), (Site(503), "HTTP 503"),
                          (Site(200, "<html>not json</html>"), "isn't its JSON")):
        with pytest.raises(Unavailable, match=message) as e:
            bandcamp.search(site, "x", "t")
        assert not isinstance(e.value, bandcamp.Challenged) and "bot" not in str(e.value)
        assert site.queries == [bandcamp.SEARCH_URL]  # no HTML-search fallback


TRALBUM = {
    "current": {"id": 3244411361, "type": "track", "title": "Elhwah", "album_id": 4071322060, "band_id": 3790356143,
                "publish_date": "24 Mar 2025 12:35:21 GMT", "track_number": 4},
    "artist": "Gil.Barte", "item_type": "track", "url": "https://gilbartemusic.bandcamp.com/track/elhwah",
    "album_url": "/album/claviceps-purpurea", "art_id": 771123465,
    "trackinfo": [{"id": 3244411361, "track_num": 4, "file": {"mp3-128": "https://t4.bcbits.com/stream/x"}}],
}
ALBUM = {
    "current": {"id": 4071322060, "type": "album", "title": "Select Edits (2017-2020)", "band_id": 1,
                "publish_date": "01 Jan 2021 00:00:00 GMT"},
    "artist": "Super Drama", "item_type": "album", "url": "https://superdrama.bandcamp.com/album/select-edits-2017-2020",
    "art_id": 12,
    "trackinfo": [{"id": 101 + i, "track_num": i + 1, "title": t, "title_link": f"/track/t{i}",
                   "file": {"mp3-128": f"https://t4.bcbits.com/stream/{i}"}}
                  for i, t in enumerate(["Intro", "Leave Me (Super Drama Mix)", "Untitled", "Take It As A Game (Super Drama Mix)"])],
}


def page(tralbum, embed=None):
    attr = lambda d: html.escape(json.dumps(d), quote=True)  # noqa: E731
    return f'<div data-tralbum="{attr(tralbum)}" data-embed="{attr(embed or {})}"></div>'


def test_pages():
    assert tagger_item(TRALBUM, {"album_title": "Claviceps Purpurea", "artist": "Gil.Barte"}) == {
        "id": "t3244411361", "tralbum_type": "t", "item_type": "track", "title": "Elhwah",
        "album_title": "Claviceps Purpurea", "album_id": "a4071322060",
        "album_url": "https://gilbartemusic.bandcamp.com/album/claviceps-purpurea", "track_num": 4,
        "raw_id": 3244411361, "artist": "Gil.Barte", "art_url": "https://f4.bcbits.com/img/a0771123465_2.jpg",
        "band_id": 3790356143, "publish_date": "24 Mar 2025 12:35:21 GMT",
        "file": {"mp3-128": "https://t4.bcbits.com/stream/x"}, "item_url": "https://gilbartemusic.bandcamp.com/track/elhwah",
    }
    # the import file's release URL: the row's track is picked from the tracklist, no search
    f = FakeSite({}, {ALBUM["url"]: page(ALBUM)})
    item, conf = bandcamp.item_from_page(f, ALBUM["url"], {"artist": "Super Drama", "title": "Take It As A Game (Super Drama Mix)"})
    assert conf >= ACCEPT_AT and f.queries == []
    assert item["id"] == "t104" and item["album_id"] == "a4071322060" and item["track_num"] == 4
    assert item["item_url"] == "https://superdrama.bandcamp.com/track/t3" and item["album_title"] == "Select Edits (2017-2020)"
    # untitled tracks: by number
    item, _ = bandcamp.item_from_page(f, ALBUM["url"], {"artist": "Super Drama", "title": "Untitled", "track_num": 3,
                                                        "flags": ["match_by_track_num"]})
    assert item["id"] == "t103"
    assert bandcamp.item_from_page(f, ALBUM["url"], {"artist": "Super Drama", "title": "Not There"}) is None
    assert bandcamp.item_from_page(f, "https://superdrama.bandcamp.com/gone", {"title": "x"}) is None
    # a candidate whose page can't be read keeps what the search said
    cand = {"id": "t5", "type": "track", "title": "T", "artist": "A", "album": "B", "album_id": "a6", "url": "u"}
    assert bandcamp.minimal_item(cand)["partial"] is True and bandcamp.fetch_item(f, cand) is None


def test_fetcher_rate_limit_cache_and_user_agent(tmp_path):
    calls = []

    def handler(request):
        calls.append((time.monotonic(), request.headers["user-agent"]))
        return httpx.Response(200, text=f"ok {request.url}")

    store = Store(path=tmp_path / "s.db")
    f = bandcamp.make_fetcher(store, min_interval=0.2, transport=httpx.MockTransport(handler))
    for i in range(3):
        assert f.request("GET", f"https://bandcamp.com/x{i}")[0] == 200
    assert len(calls) == 3 and calls[2][0] - calls[0][0] >= 0.39
    assert {ua for _, ua in calls} == {bandcamp.USER_AGENT}  # an honest, identifying User-Agent
    assert f.request("GET", "https://bandcamp.com/x1") == (200, "ok https://bandcamp.com/x1")
    assert len(calls) == 3 and f.network_requests == 3  # served from the cache
    offline = Fetcher(store, "test", offline=True)
    assert offline.request("GET", "https://bandcamp.com/x2")[0] == 200
    with pytest.raises(Unavailable):
        offline.request("GET", "https://bandcamp.com/never-recorded")


def test_fetcher_redirects_are_rate_limited_and_loops_cached(tmp_path):
    calls = []

    def handler(request):
        calls.append((time.monotonic(), str(request.url)))
        if request.url.path == "/moved":
            return httpx.Response(301, headers={"location": "/track/x"})
        if request.url.host == "custom.example":  # a custom domain that 303s to itself forever
            return httpx.Response(303, headers={"location": str(request.url)})
        return httpx.Response(200, text="page")

    store = Store(path=tmp_path / "s.db")
    f = Fetcher(store, "test", min_interval=0.1, transport=httpx.MockTransport(handler))
    assert f.request("GET", "https://x.bandcamp.com/moved") == (200, "page")
    assert [u for _, u in calls] == ["https://x.bandcamp.com/moved", "https://x.bandcamp.com/track/x"]
    calls.clear()
    status, _ = f.request("GET", "https://custom.example/track/y")
    assert status == REDIRECT_LOOP and len(calls) == MAX_REDIRECTS + 1
    assert all(b - a >= 0.09 for (a, _), (b, _) in zip(calls, calls[1:]))  # every hop is throttled
    assert f.request("GET", "https://custom.example/track/y")[0] == REDIRECT_LOOP
    assert len(calls) == MAX_REDIRECTS + 1  # cached
    assert bandcamp.fetch_item(f, {"url": "https://custom.example/track/y"}) is None


def test_link_helpers():
    assert bandcamp.search_url("Gil.Barte", "Elhwah") == "https://bandcamp.com/search?q=Gil.Barte+Elhwah&item_type=t"
    assert bandcamp.is_bandcamp_url("https://gilbarte.bandcamp.com/track/elhwah")
    assert not bandcamp.is_bandcamp_url("https://vxx.vc/track/x")
    assert bandcamp.page_key("https://X.bandcamp.com/album/y/?from=search#t") == "x.bandcamp.com/album/y"
    item = bandcamp.link_item({"id": "t1", "title": "Elhwah", "artist": "Gil.Barte", "tags": ["x"], "junk": 1})
    assert item == {"id": "t1", "title": "Elhwah", "artist": "Gil.Barte", "tralbum_type": "t", "item_type": "track"}
    assert bandcamp.link_item({"id": "a2", "title": "EP"})["track_num"] == -1
    for bad in ({"id": "o123", "title": "x"}, {"id": "t1"}, None):
        with pytest.raises(ValueError):
            bandcamp.link_item(bad)


@pytest.mark.skipif(os.environ.get("BCT_LIVE_BANDCAMP") != "1", reason="live Bandcamp smoke test (set BCT_LIVE_BANDCAMP=1)")
def test_live_smoke(tmp_path):
    f = bandcamp.make_fetcher(Store(path=tmp_path / "s.db"))
    r = bandcamp.resolve(f, {"kind": "track", "artist": "Gil.Barte", "title": "Elhwah", "flags": []})
    assert r["status"] == "accepted" and r["chosen"]["id"] == "t3244411361"
    item = bandcamp.fetch_item(f, r["chosen"])
    assert item["album_id"] == "a4071322060" and item["file"]["mp3-128"].startswith("https://")


def test_ownership_refresh_stops_on_the_bot_check(tmp_path):
    from bc_tagger_server import ownership

    cookies = tmp_path / "cookies.txt"
    cookies.write_text("# Netscape HTTP Cookie File\n.bandcamp.com\tTRUE\t/\tTRUE\t0\tidentity\tx\n")
    calls = []

    def handler(request):
        calls.append(request.headers["user-agent"])
        return httpx.Response(200, text="<html><title>Client Challenge</title></html>")

    client = httpx.Client(headers={"User-Agent": ownership.USER_AGENT}, transport=httpx.MockTransport(handler))
    with pytest.raises(ownership.OwnershipError, match="bot check"):
        ownership.fetch_collection(cookies, client=client)
    assert calls == [bandcamp.USER_AGENT] and "Mozilla" not in ownership.USER_AGENT  # one honest request


def test_fetcher_backs_off_politely_on_429(tmp_path):
    from bc_tagger_server.fetcher import RateLimited

    calls, sleeps, waits = [], [], []

    def handler(request):
        calls.append(time.monotonic())
        if len(calls) <= 2:
            return httpx.Response(429, headers={"Retry-After": "5"} if len(calls) == 1 else {})
        return httpx.Response(200, text="ok")

    f = Fetcher(Store(path=tmp_path / "s.db"), "test", min_interval=2.5, transport=httpx.MockTransport(handler))
    f.sleep = sleeps.append
    f.on_wait = lambda s, msg: waits.append((s, msg))
    assert f.request("GET", "https://bandcamp.com/a") == (200, "ok")
    assert [round(w) for w, _ in waits] == [5, 30] and "rate-limiting" in waits[0][1]
    assert [round(s) for s in sleeps if s > 3] == [5, 30]  # the pacing carries the wait: no double sleep
    # still limited after 30/60/120 s: give up for now (not cached)
    always = Fetcher(Store(path=tmp_path / "t.db"), "test", min_interval=1,
                     transport=httpx.MockTransport(lambda r: httpx.Response(429)))
    always.sleep = lambda s: None
    with pytest.raises(RateLimited):
        always.request("GET", "https://bandcamp.com/b")
    assert always.network_requests == 4


def test_one_honest_product_user_agent():
    from bc_tagger_server import USER_AGENT, ownership

    assert bandcamp.USER_AGENT is USER_AGENT and ownership.USER_AGENT is USER_AGENT
    assert USER_AGENT.startswith("bc-tagger/0.1 (") and "github.com/modewx/bc-tagger" in USER_AGENT
    assert not any(s in USER_AGENT for s in ("dev", "Mozilla", "Java", "Node", "Chrome", "Safari"))


def test_interval_default_and_migration(tmp_path):
    from bc_tagger_server.config import Settings

    fresh = Settings(path=tmp_path / "a" / "settings.json")
    assert fresh.get("bandcamp_request_interval_s") == 1.0
    # a file written before the default changed, holding the old default: moved to 1.0
    old = tmp_path / "b" / "settings.json"
    old.parent.mkdir()
    old.write_text(json.dumps({"bandcamp_request_interval_s": 2.5, "server_port": 8765}))
    assert Settings(path=old).get("bandcamp_request_interval_s") == 1.0
    # chosen after the change (the file says so): kept
    s = Settings(path=old)
    s.update({"bandcamp_request_interval_s": 2.5})
    assert json.loads(old.read_text())["settings_version"] == 2
    assert Settings(path=old).get("bandcamp_request_interval_s") == 2.5
    old.write_text(json.dumps({"bandcamp_request_interval_s": 3}))  # not the old default: kept
    assert Settings(path=old).get("bandcamp_request_interval_s") == 3


def test_pacing_is_start_to_start(tmp_path):
    starts = []

    def slow(request):
        starts.append(time.monotonic())
        time.sleep(0.2)  # the answer takes a while
        return httpx.Response(200, text="ok")

    f = Fetcher(Store(path=tmp_path / "s.db"), "test", min_interval=0.25, transport=httpx.MockTransport(slow))
    for i in range(3):
        f.request("GET", f"https://pace.example/{i}")
    gaps = [b - a for a, b in zip(starts, starts[1:])]
    assert all(0.24 <= g < 0.4 for g in gaps), gaps  # not 0.25 + 0.2 latency

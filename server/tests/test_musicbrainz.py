"""MusicBrainz as an optional lookup source: resolve, release links, the importer's "musicbrainz" and
"both" modes. Fixtures only, except the opt-in live smoke test (BCT_LIVE_MUSICBRAINZ=1)."""

from __future__ import annotations

import html
import json
import os
import time

import httpx
import pytest

from bc_tagger_server import USER_AGENT, importer, musicbrainz
from bc_tagger_server.fetcher import Fetcher, Unavailable
from bc_tagger_server.musicbrainz import query_for
from bc_tagger_server.store import Store

from .test_import import recorded_rows, row_at, svc  # noqa: F401 (the fixture)


def rec(id_, title, artist, releases=()):
    return {"id": id_, "title": title, "artist-credit": [{"name": artist, "joinphrase": ""}], "length": 300000,
            "releases": [{"id": rid, "title": rt, "status": status, "date": date,
                          "release-group": {"primary-type": kind}} for rid, rt, status, date, kind in releases]}


class FakeMB:
    """A Fetcher stand-in answering MusicBrainz searches and release lookups from dicts."""

    def __init__(self, answers, releases=None):
        self.answers, self.releases, self.queries, self.lookups = answers, releases or {}, [], []
        self.network_requests = 0

    def get_json(self, url, params=None):
        if url.endswith("/recording"):
            self.queries.append(params["query"])
            return {"recordings": self.answers.get(params["query"], [])}
        rid = url.rsplit("/", 1)[-1]
        self.lookups.append(rid)
        if rid not in self.releases:
            raise Unavailable(f"HTTP 404 for {url}")
        return self.releases[rid]


def test_resolve_readings():
    # order_ambiguous: the swapped reading finds it
    f = FakeMB({query_for("Elektromekanik", "Rex The Dog"): [rec("r5", "Elektromekanik", "Rex the Dog")]})
    r = musicbrainz.resolve(f, {"artist": "Rex The Dog", "title": "Elektromekanik", "flags": ["order_ambiguous"]})
    assert f.queries == [query_for("Rex The Dog", "Elektromekanik"), query_for("Elektromekanik", "Rex The Dog")]
    assert r["status"] == "accepted" and r["chosen"]["id"] == "mb:r5"
    assert r["chosen"]["url"] == "https://musicbrainz.org/recording/r5"
    # artist_missing: title only; candidates (never accepted), top 3 kept
    f = FakeMB({query_for(None, "Bones"): [rec(f"r{i}", "Bones", f"Artist {i}") for i in range(5)]})
    r = musicbrainz.resolve(f, {"artist": None, "title": "Bones", "flags": ["artist_missing"]})
    assert f.queries == [query_for(None, "Bones")] and r["status"] == "candidates" and len(r["candidates"]) == 3
    # written the other way round, without the flag: accepted when both fields agree
    f = FakeMB({query_for("Halo Welt", "Quadratschulz"): [rec("r7", "Halo Welt", "quadratschulz")]})
    assert musicbrainz.resolve(f, {"artist": "Halo Welt", "title": "Quadratschulz", "flags": []})["status"] == "accepted"
    # "artist title" finds nothing: the title alone, and the artist still has to agree
    f = FakeMB({query_for(None, "Blurred Cognition"): [rec("r3", "Blurred Cognition", "Patrick Conway"),
                                                        rec("r4", "Blurred Cognition", "Someone Else")]})
    r = musicbrainz.resolve(f, {"artist": "Patrick Conw", "title": "Blurred Cognition", "flags": ["possible_typo"]})
    assert f.queries == [query_for("Patrick Conw", "Blurred Cognition"), query_for(None, "Blurred Cognition")]
    assert r["chosen"]["id"] == "mb:r3" and [c["id"] for c in r["candidates"]] == ["mb:r3"]
    # nothing found
    f = FakeMB({})
    assert musicbrainz.resolve(f, {"artist": "Front 242", "title": "Controversy Between"})["status"] == "none"
    # the release that fits the row's album comes first; official, non-compilation, oldest after that
    f = FakeMB({query_for("Visitor", "Celebrate Death"): [rec("r9", "Celebrate Death", "Visitor", [
        ("comp", "Verboden 2019 Compilation", "Official", "2019", "Compilation"),
        ("boot", "Expat", "Bootleg", "2017", "Album"), ("ep", "Expat", "Official", "2018", "Album")])]})
    r = musicbrainz.resolve(f, {"artist": "Visitor", "title": "Celebrate Death", "album": "Expat"})
    assert r["chosen"]["album"] == "Expat" and r["chosen"]["release_ids"][:2] == ["ep", "boot"]
    assert query_for('Say "Hi"', "x") == 'recording:"x" AND artist:"Say \\"Hi\\""'


def test_release_links():
    def release(rid, *urls, label=None):
        return {"id": rid, "title": "Expat", "relations": [{"url": {"resource": u}} for u in urls],
                "label-info": [{"catalog-number": "DR-002", "label": {"name": label}}] if label else []}

    f = FakeMB({}, {"ep": release("ep", "https://www.discogs.com/release/1", label="Detriti"),
                    "boot": release("boot", "https://visitor.bandcamp.com/album/expat"),
                    "third": release("third", "https://other.bandcamp.com/album/x")})
    links = musicbrainz.candidate_links(f, {"release_ids": ["ep", "boot", "third"]})
    assert links["bandcamp_url"] == "https://visitor.bandcamp.com/album/expat"
    assert links["discogs_url"] == "https://www.discogs.com/release/1"
    assert links["label"] == "Detriti" and links["catalog"] == "DR-002" and links["release_id"] == "ep"
    assert f.lookups == ["ep", "boot"]  # stops at the first Bandcamp link, at most two lookups
    f = FakeMB({}, {})
    assert musicbrainz.candidate_links(f, {"release_ids": ["gone"]}) == {}


def test_fetcher_rate_limit_cache_and_user_agent(new_store, tmp_path):
    calls = []

    def handler(request):
        calls.append((time.monotonic(), request.headers["user-agent"]))
        return httpx.Response(200, text=f"ok {request.url}")

    store = new_store()
    f = musicbrainz.make_fetcher(store, min_interval=0.2, transport=httpx.MockTransport(handler))
    for i in range(3):
        assert f.request("GET", f"https://musicbrainz.org/x{i}")[0] == 200
    assert len(calls) == 3 and calls[2][0] - calls[0][0] >= 0.39
    assert {ua for _, ua in calls} == {USER_AGENT}  # the app's own, honest User-Agent
    assert f.request("GET", "https://musicbrainz.org/x1") == (200, "ok https://musicbrainz.org/x1")
    assert len(calls) == 3 and f.network_requests == 3  # served from the cache
    offline = Fetcher(store, "test", offline=True)
    assert offline.request("GET", "https://musicbrainz.org/x2")[0] == 200
    with pytest.raises(Unavailable):
        offline.request("GET", "https://musicbrainz.org/never-recorded")




def _page(tralbum):
    attr = html.escape(json.dumps(tralbum), quote=True)
    return f'<div data-tralbum="{attr}" data-embed="{{}}"></div>'


def test_lookup_source_musicbrainz_gives_hints_only(new_store, svc):  # noqa: F811
    calls = []
    svc.settings.update({"lookup_source": "musicbrainz"})
    no_bandcamp = httpx.MockTransport(lambda request: calls.append(str(request.url)) or httpx.Response(500))
    svc.bandcamp_fetcher = lambda: Fetcher(new_store(path=svc.store.path.parent / "empty.db"), "test", transport=no_bandcamp)
    q = query_for("Shinichi Atobe", "Butterfly Effect")
    svc.musicbrainz_fetcher = lambda: FakeMB(
        {q: [rec("r1", "Butterfly Effect", "Shinichi Atobe", [("rel1", "Butterfly Effect", "Official", "2014", "Album")])]},
        {"rel1": {"id": "rel1", "title": "Butterfly Effect", "relations": [
            {"url": {"resource": "https://dds.bandcamp.com/album/butterfly-effect"}},
            {"url": {"resource": "https://www.discogs.com/release/5"}}]}})
    rows = [r for r in recorded_rows() if r["line"] in (13, 211)]
    batch = importer.create_batch(svc, {"format": "bc-tagger-import/1", "items": rows}, ["must"])
    importer.run_batch(svc, batch["batch_id"])
    b = importer.get_batch(svc, batch["batch_id"])
    bf = row_at(b, 13)
    assert bf["source"] == "other" and bf["match"]["source"] == "musicbrainz" and bf["match"]["status"] == "accepted"
    assert bf["hints"]["bandcamp_url"] == "https://dds.bandcamp.com/album/butterfly-effect"
    assert bf["hints"]["from"]["bandcamp_url"] == "musicbrainz" and bf["hints"]["discogs_url"].endswith("/release/5")
    assert bf["links"]["bandcamp"] == bf["hints"]["bandcamp_url"] and bf["hints"]["musicbrainz_url"].endswith("/r1")
    assert row_at(b, 211)["match"]["status"] == "in_collection"
    assert calls == []  # not a single Bandcamp request


def test_lookup_source_both_reads_the_release_page_bandcamp_missed(svc):  # noqa: F811
    svc.settings.update({"lookup_source": "both"})
    svc.bandcamp_fetcher = lambda: Fetcher(svc.store, "test", offline=True)
    page = "https://ufo.bandcamp.com/album/birth"
    tralbum = {"current": {"id": 77, "type": "album", "title": "Birth", "band_id": 1}, "artist": "UFO",
               "item_type": "album", "url": page, "art_id": 3,
               "trackinfo": [{"id": 701, "track_num": 1, "title": "The Human Being Disgusts", "title_link": "/track/thbd",
                              "file": {"mp3-128": "https://t4.bcbits.com/stream/x"}}]}
    Fetcher(svc.store, "test").remember("GET", page, None, 200, _page(tralbum))  # as if fetched before
    q = query_for("Uf0", "The Human Being Disgusts")
    svc.musicbrainz_fetcher = lambda: FakeMB(
        {q: [rec("r9", "The Human Being Disgusts", "UFO", [("relB", "Birth", "Official", "1994", "Album")])]},
        {"relB": {"id": "relB", "title": "Birth", "relations": [{"url": {"resource": page}}]}})
    rows = [r for r in recorded_rows() if r["line"] == 181]
    batch = importer.create_batch(svc, {"format": "bc-tagger-import/1", "items": rows}, ["must"])
    importer.run_batch(svc, batch["batch_id"])
    row = importer.get_batch(svc, batch["batch_id"])["rows"][0]
    assert row["source"] == "bandcamp" and row["match"]["source"] == "musicbrainz"
    assert row["bandcamp"]["item"]["id"] == "t701" and row["bandcamp"]["item"]["album_title"] == "Birth"


def test_lookup_source_setting():
    from bc_tagger_server.config import Settings, SettingsError

    import tempfile
    s = Settings(path=__import__("pathlib").Path(tempfile.mkdtemp()) / "settings.json")
    assert s.get("lookup_source") == "bandcamp"
    with pytest.raises(SettingsError):
        s.update({"lookup_source": "discogs"})


@pytest.mark.skipif(os.environ.get("BCT_LIVE_MUSICBRAINZ") != "1",
                    reason="live MusicBrainz smoke test (set BCT_LIVE_MUSICBRAINZ=1)")
def test_live_musicbrainz_smoke(new_store, tmp_path):
    f = musicbrainz.make_fetcher(new_store())
    r = musicbrainz.resolve(f, {"artist": "Front 242", "title": "Headhunter", "flags": []})
    assert r["status"] == "accepted" and r["chosen"]["artist"].lower().startswith("front 242")
    assert musicbrainz.candidate_links(f, r["chosen"]).get("release_id")

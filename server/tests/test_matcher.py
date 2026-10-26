"""Matcher: scoring, the number guard, albums, format preference (Expat AIFF vs MP3), overrides."""

from __future__ import annotations


import pytest

from bc_tagger_server.items import load_export_json
from bc_tagger_server.matcher import FileIndex, MatchConfig, format_rank, locate_item, title_similarity
from bc_tagger_server.normalize import parse_filename, parse_release_dir

from .conftest import EXPORT_JSON, TEST_TRACKS

CFG = MatchConfig()


def row(path, title=None, artist=None, album=None, track=None, fmt="aiff", root_kind="not_owned", albumartist=None, urls=()):
    from pathlib import Path

    from bc_tagger_server.indexer import release_dir_of

    p = Path(path)
    rel = release_dir_of(p)
    return {
        "path": path,
        "format": fmt,
        "root_kind": root_kind,
        "release_dir": str(rel),
        "title": title,
        "artist": artist,
        "albumartist": albumartist,
        "album": album,
        "tracknumber": track,
        "discnumber": None,
        "bc_urls": list(urls),
        "parsed": {"file": parse_filename(p.stem), "dir": parse_release_dir(rel.name, rel.parent.name)},
    }


EXPAT_AIFF = row("/m/Expat/07 Celebrate Death.aiff", "Celebrate Death", "Visitor", "Expat", 7, "aiff")
EXPAT_MP3 = row("/m/[DR-002] visito - expat (2018)/07. celebrate death.mp3", "Celebrate Death", "Visitor", "Expat", 7, "mp3-320")
EXPAT_ITEM = {
    "id": "t1969272616",
    "title": "Celebrate Death",
    "artist": None,
    "album_title": "Visitor - Expat",
    "track_num": 7,
    "album_url": "https://detritirecords.bandcamp.com/album/visitor-expat",
}


def test_expat_duplicate_prefers_aiff():
    for rows in ([EXPAT_AIFF, EXPAT_MP3], [EXPAT_MP3, EXPAT_AIFF]):
        r = locate_item(EXPAT_ITEM, FileIndex(rows), CFG)
        assert r["status"] == "located"
        assert r["best"]["path"] == EXPAT_AIFF["path"] and r["best"]["format"] == "aiff"
        assert [c["path"] for c in r["candidates"]] == [EXPAT_MP3["path"]]


def test_format_preference_does_not_override_a_much_better_match():
    """A clearly better MP3 match wins over a borderline AIFF (different track)."""
    mp3 = row("/m/A/03 Song.mp3", "Song", "Artist", "Record", 3, "mp3-320")
    aiff = row("/m/B/03 Song Reprise.aiff", "Song Reprise", "Artist", "Record", 3, "aiff")
    item = {"id": "t1", "title": "Song", "artist": "Artist", "album_title": "Record", "track_num": 3}
    r = locate_item(item, FileIndex([aiff, mp3]), CFG)
    assert r["best"]["path"] == mp3["path"]


def test_format_rank_order():
    pref = CFG.format_preference
    ranks = [format_rank(f, pref) for f in ["aiff", "flac", "wav", "alac", "m4a", "mp3-320", "mp3", "ogg"]]
    assert ranks == sorted(ranks) and ranks[0] == 0
    assert format_rank("mp3", pref) > format_rank("mp3-320", pref)


def test_number_guard():
    assert title_similarity("Nine-L - Islands, Part 3", "Nine-L - Islands, Part 2") <= 0.5
    assert title_similarity("File #2", "File #1") <= 0.5
    assert title_similarity("File #2", "File #2") == 1.0
    assert title_similarity("Paroles (Original)", "Paroles") == 1.0


def test_compilation_title_with_artist_prefix_and_typos():
    f = row(
        "/m/tony boninsegna - notes from underground 1986-1994 vol. 1 (cold blow)/01 - Lab Technicians - We Gave You Life.aiff",
        "We Gave You Life", "Lab Technicians", "Notes From Underground 1986-1994 Vol. 1", 1, albumartist="Tony Boninsegna",
    )
    other = row(
        "/m/tony boninsegna - notes from underground 1986-1994 vol. 1 (cold blow)/12 - Nine-L - Islands, Part 2.aiff",
        "Islands, Part 2", "Nine-L", "Notes From Underground 1986-1994 Vol. 1", 12, albumartist="Tony Boninsegna",
    )
    idx = FileIndex([f, other])
    lab = {"id": "t59016477", "artist": "Tony Boninsegna", "title": "Lab Techninicans - We Gave You Life",
           "album_title": "Notes From Underground 1988-1994 (Volume 1 & 2)", "track_num": 1}
    assert locate_item(lab, idx, CFG)["best"]["path"] == f["path"]
    islands3 = {"id": "t1064448596", "artist": "Tony Boninsegna", "title": "Nine-L - Islands, Part 3",
                "album_title": "Notes From Underground 1988-1994 (Volume 1 & 2)", "track_num": 12}
    assert locate_item(islands3, idx, CFG)["status"] == "missing"


def test_untagged_files_match_by_filename():
    farfa = [
        row(f"/m/Farfa - Ability EP (Remastered) (M4a)/0{n}.Francesco Farfa - File #{n - 5}.mp3", fmt="mp3")
        for n in (6, 7, 8)
    ]
    item = {"id": "t1738134782", "artist": "Francesco Farfa", "title": "File #2", "album_title": "Farfability", "track_num": 7}
    r = locate_item(item, FileIndex(farfa), CFG)
    assert r["status"] == "located" and r["best"]["path"].endswith("File #2.mp3")


def test_same_title_other_artist_is_only_a_candidate():
    f = row("/m/X/01 Landing.aiff", "Landing", "Visitor", "Expat", 1)
    item = {"id": "t9", "artist": "Somebody Else", "title": "Landing", "album_title": "Other Record", "track_num": 4}
    r = locate_item(item, FileIndex([f]), CFG)
    assert r["status"] in ("candidates", "missing") and r["best"] is None


def test_album_expands_to_release_tracks():
    rows = [row(f"/m/Synergy Trilogy/0{n} - T{n}.aiff", f"T{n}", "Synergy Trilogy", "Synergy Trilogy", n) for n in range(1, 4)]
    rows.append(row("/m/Other/01 - X.aiff", "X", "Other", "Other", 1))
    item = {"id": "a563830364", "title": "Synergy Trilogy", "artist": "Synergy Trilogy", "album_title": "synergy-trilogy",
            "track_num": -1, "url": "https://infiniteexpanse.bandcamp.com/album/synergy-trilogy"}
    r = locate_item(item, FileIndex(rows), CFG)
    assert r["status"] == "located"
    assert [t["track_num"] for t in r["best"]["tracks"]] == [1, 2, 3]
    assert r["best"]["release_dir"] == "/m/Synergy Trilogy"


def test_url_in_comment_is_exact():
    f = row("/m/Z/01 weird name.aiff", "weird name", "Nobody", "None", 1,
            urls=["https://label.bandcamp.com/track/the-real-title"])
    item = {"id": "t5", "artist": "Real", "title": "The Real Title", "item_url": "https://label.bandcamp.com/track/the-real-title"}
    r = locate_item(item, FileIndex([f]), CFG)
    assert r["status"] == "located" and r["best"]["method"] == "url"


def test_overrides_reject_and_confirm():
    idx = FileIndex([EXPAT_AIFF, EXPAT_MP3])
    r = locate_item(EXPAT_ITEM, idx, CFG, {EXPAT_AIFF["path"]: "reject"})
    assert r["best"]["path"] == EXPAT_MP3["path"]
    r = locate_item(EXPAT_ITEM, idx, CFG, {EXPAT_MP3["path"]: "confirm"})
    assert r["best"]["path"] == EXPAT_MP3["path"] and r["best"]["method"] == "confirmed"


def test_parse_filename_and_dir():
    assert parse_filename("1-01 Claviceps Purpurea")["track"] == 1
    assert parse_filename("07.Francesco Farfa - File #2") == {
        "track": 7, "disc": None, "rest": "Francesco Farfa - File #2", "artist": "Francesco Farfa", "title": "File #2"}
    p = parse_filename("01-katatonic_silentio-interlude_to_solstice")
    assert (p["track"], p["artist"], p["title"]) == (1, "katatonic silentio", "interlude to solstice")
    assert parse_release_dir("[DR-002] visito - expat (2018)") == {"artist": "visito", "album": "expat"}
    assert parse_release_dir("Morgan Buckley & Ben Donohoe - Sworx [Wah Wah Wino, 2026] {WEB FLAC-16}") == {
        "artist": "Morgan Buckley & Ben Donohoe", "album": "Sworx"}
    assert parse_release_dir("2025 - Claviceps Purpurea", "Gil.Barte") == {"artist": "Gil.Barte", "album": "Claviceps Purpurea"}


# -- against the real test folder ---------------------------------------------------------


@pytest.fixture
def real_service(make_service):
    if not TEST_TRACKS.is_dir() or not EXPORT_JSON.is_file():
        pytest.skip("test-tracks or export JSON not available")
    items, tags = load_export_json(EXPORT_JSON)
    return make_service(TEST_TRACKS, items=items, tags=tags)


def test_latest_5_against_test_tracks(real_service):
    result = real_service.locate(latest=5)
    status = {s["title"]: s["status"] for s in result["items"]}
    assert status == {
        "Synergy Trilogy": "located",
        "Eudæmonia": "missing",
        "Thinkin' Bout U, Pt. 1 (Mercury)": "missing",
        "The System Works": "located",
        "Atacama": "missing",
    }
    synergy = next(s for s in result["items"] if s["title"] == "Synergy Trilogy")
    assert synergy["is_album"] and synergy["tracks"] == 9


def test_real_expat_prefers_aiff(real_service):
    real_service.locate(ids=["t1969272616"])
    view = real_service.get_item_view("t1969272616")
    assert view["local"]["status"] == "located"
    assert view["local"]["best"]["path"] == str(TEST_TRACKS / "Expat" / "07 Celebrate Death.aiff")
    assert any(c["path"].endswith("07. celebrate death.mp3") for c in view["local"]["candidates"])


def test_no_false_positives_on_full_collection(real_service):
    result = real_service.locate()
    located = {s["id"] for s in result["items"] if s["status"] == "located"}
    # Every located item is one of the releases that really are in test-tracks.
    items = {it["id"]: it for it in real_service.store.all_items()}
    allowed = ("Gil.Barte", "Morgan Buckley & Ben Donohoe", "Mike Ink", "Tony Boninsegna", "Francesco Farfa", "Synergy Trilogy")
    for item_id in located:
        it = items[item_id]
        assert it.get("artist") in allowed or "Expat" in (it.get("album_title") or ""), it
    assert "t1064448596" not in located  # Islands, Part 3 (local file is Part 2)
    assert "t3227131631" not in located  # Space Drum Meditation SDM001 (local is SDM005)

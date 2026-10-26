"""Matcher: scoring, the number guard, albums, format preference (Expat AIFF vs MP3), overrides."""

from __future__ import annotations


import pytest

from bc_tagger_server.items import load_export_json
from bc_tagger_server.matcher import FileIndex, MatchConfig, format_rank, locate_item, title_similarity
from bc_tagger_server.normalize import parse_filename, parse_release_dir

from .conftest import EXPORT_JSON, TEST_TRACKS

CFG = MatchConfig()


def row(path, title=None, artist=None, album=None, track=None, fmt="aiff", root_kind="not_owned", albumartist=None, urls=(), created=None):
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
        "created": created,
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


# -- patterns found on the real collection drive ---------------------------------------------


def test_label_compilation_with_artist_in_title():
    """The downloader files label compilations under the label; the tag title is 'Artist - Title'."""
    f = row("/c/Banlieue Records/2024 - BR16 - VA – LABOR OF LOVE/Banlieue Records - BR16 - VA – LABOR OF LOVE - 02 Alien D - Liquid Nails.aiff",
            "Alien D - Liquid Nails", "Banlieue Records", "BR16 - VA – LABOR OF LOVE", 2, root_kind="owned")
    item = {"id": "t1", "artist": "Alien D", "title": "Liquid Nails", "album_title": "BR16 - VA – LABOR OF LOVE", "track_num": 2}
    r = locate_item(item, FileIndex([f]), CFG)
    assert r["status"] == "located" and r["best"]["confidence"] == 1.0


def test_featured_artist_moved_between_fields():
    f = row("/c/Lechuga Zafiro ft. Linn Da Quebrada - Oração (Pense & Dance).aiff",
            "Oração (Pense & Dance)", "Lechuga Zafiro ft. Linn Da Quebrada", None, None, root_kind="owned")
    item = {"id": "t1616655546", "artist": "V/A", "title": "Lechuga Zafiro - Oração (Pense & Dance) Ft. Linn da Quebrada",
            "album_title": "NAAFI X", "track_num": 1}
    assert locate_item(item, FileIndex([f]), CFG)["status"] == "located"


def test_reordered_title_words_are_not_auto_accepted():
    f = row("/c/Anatolian Weapons/2020 - Cause And Effect/Anatolian Weapons - Cause And Effect - 03 Naked Eye.aiff",
            "Naked Eye", "Anatolian Weapons", "Cause And Effect", 3, root_kind="owned")
    item = {"id": "t1", "artist": "Anatolian Weapons", "title": "Ego (Naked)", "album_title": "Beyond", "track_num": 3}
    r = locate_item(item, FileIndex([f]), CFG)
    assert r["status"] == "candidates" and r["best"] is None


def test_same_title_other_artist_and_album_is_not_a_candidate():
    f = row("/c/Ani Klang/2020 - Burn the Empire/Ani Klang - Burn the Empire - 03 Us.aiff", "Us", "Ani Klang", "Burn the Empire", 3)
    item = {"id": "t1", "artist": "Klara Lewis", "title": "Us", "album_title": "Too", "track_num": 3}
    assert locate_item(item, FileIndex([f]), CFG)["status"] == "missing"


def test_downloader_filename_without_tags():
    p = parse_filename("Avon Terror Corps - AVON ALIVE! - 12 Logic Lost & Monika Badly - Rabun")
    assert (p["artist"], p["album"], p["track"], p["title"]) == (
        "Avon Terror Corps", "AVON ALIVE!", 12, "Logic Lost & Monika Badly - Rabun")
    f = row("/c/Avon Terror Corps/2026 - AVON ALIVE!/Avon Terror Corps - AVON ALIVE! - 12 Logic Lost & Monika Badly - Rabun.aiff")
    item = {"id": "t1", "artist": "Avon Terror Corps", "title": "Logic Lost & Monika Badly - Rabun", "album_title": "AVON ALIVE!", "track_num": 12}
    assert locate_item(item, FileIndex([f]), CFG)["status"] == "located"


def test_album_in_loose_folder_only_takes_its_own_tracks():
    loose = "/s/!!!LOOSE TRACKS!!!"
    rows = [row(f"{loose}/{n:02d} Song {n}.aiff", f"Song {n}", "Band", "The Album", n) for n in (1, 2)]
    rows += [row(f"{loose}/x{n}.aiff", f"Other {n}", f"Someone {n}", f"Unrelated {n}", 1) for n in (1, 2, 3)]
    item = {"id": "a1", "title": "The Album", "artist": "Band", "album_title": "the-album", "track_num": -1}
    r = locate_item(item, FileIndex(rows), CFG)
    assert r["status"] == "located"
    assert [t["title"] for t in r["best"]["tracks"]] == ["Song 1", "Song 2"]
    assert r["best"]["release_dir"] == loose and r["best"]["path"] != loose


def test_owned_root_wins_a_tie():
    owned = row("/c/Band/2020 - Rec/Band - Rec - 01 Song.aiff", "Song", "Band", "Rec", 1, root_kind="owned")
    soulseek = row("/s/Band - Rec/01 Song.aiff", "Song", "Band", "Rec", 1, root_kind="not_owned")
    item = {"id": "t1", "artist": "Band", "title": "Song", "album_title": "Rec", "track_num": 1}
    for rows in ([owned, soulseek], [soulseek, owned]):
        assert locate_item(item, FileIndex(rows), CFG)["best"]["path"] == owned["path"]


def test_label_artist_counts_as_unknown():
    f = row("/c/Lefty/2026 - Phase One/Lefty - Phase One.aiff", "Phase One", "Lefty", "Phase One", 1, root_kind="owned")
    item = {"id": "t1", "artist": "7even Recordings", "title": "Phase One", "album_title": "F - Phase One / Icon", "track_num": 1}
    assert locate_item(item, FileIndex([f]), CFG)["status"] == "located"


def test_artist_spelled_out_in_title():
    f = row("/s/(2023) Tutu Ta - Lonely Eyes (MMLPXX707)/10 - Tutu Ta - Terkos.aiff", "Terkos", "Tutu Ta", "Lonely Eyes", 10)
    item = {"id": "t1", "artist": "MMLPXX707 B4", "title": 'Tutu Ta "Terkos"', "album_title": 'MMLPXX707 - TUTU TA "Lonely Eyes"', "track_num": 10}
    assert locate_item(item, FileIndex([f]), CFG)["status"] == "located"


def test_key_bpm_suffix_and_vinyl_side_prefix():
    assert title_similarity("Drifting Through The Mist", "Drifting Through The Mist - 11A - 82") == 1.0
    f = row("/s/Hari Sima, Mínim - Fluvius/05 - Hari Sima, Mínim - Tiberis.aiff", "Tiberis", "Hari Sima, Mínim", "Fluvius", 5)
    item = {"id": "t1", "artist": "Hari Sima & Mínim", "title": "B1- Tiberis", "album_title": "Fluvius", "track_num": 5}
    assert locate_item(item, FileIndex([f]), CFG)["status"] == "located"
    assert title_similarity("Part 2", "Part 2 - 4A - 120") == 1.0  # the guard still sees the same numbers


def test_title_split_pseudo_artist_is_not_an_artist():
    """'You And Me - [320 kbps]_pn' splits into a pseudo-artist 'You And Me'; it must not
    vouch for an item by another artist titled 'You And Me'."""
    f = row("/s/SUPER UK Garage Collection   30 of 37/Sovereign vs Fantastic 3 - You And Me -  [320 kbps]_pn.mp3",
            "You And Me", "Sovereign vs Fantastic 3", "FT3 003 Fantastic 3 Records", None, fmt="mp3-320")
    item = {"id": "t1", "artist": "Le Matin", "title": "You And Me", "album_title": "Le Matin EP", "track_num": 2}
    assert locate_item(item, FileIndex([f]), CFG)["status"] != "located"


def test_glued_digits_and_repeated_artist_prefix():
    f = row("/c/Sfire/2019 - Sfire/Sfire - Sfire - 02 Sfire 2.aiff", "Sfire 2", "Sfire", "Sfire", 2, root_kind="owned")
    item = {"id": "t1", "artist": "Sfire", "title": "Sfire2", "album_title": "Sfire", "track_num": 2}
    assert locate_item(item, FileIndex([f]), CFG)["status"] == "located"
    assert title_similarity("Sfire2", "Sfire 3") <= 0.5  # the number guard still applies
    g = row("/s/Dub Squad - Blown Fruit/01 Blown Fruit.aiff", "Blown Fruit", "Dub Squad", "Blown Fruit", 1)
    item = {"id": "t2", "artist": "Dub Squad", "title": "Dub Squad - Dub Squad - Blown Fruit", "album_title": "Blown Fruit", "track_num": 1}
    assert locate_item(item, FileIndex([g]), CFG)["status"] == "located"


def test_date_tie_break_prefers_the_copy_made_after_tagging():
    from datetime import datetime, timezone

    tagged = datetime(2026, 10, 20, 12, tzinfo=timezone.utc).timestamp()
    old = row("/s/old rip/03 Song.aiff", "Song", "Artist", "Record", 3, created=tagged - 400 * 86400)
    new = row("/s/new download/03 Song.aiff", "Song", "Artist", "Record", 3, created=tagged + 3 * 86400)
    later = row("/s/much later/03 Song.aiff", "Song", "Artist", "Record", 3, created=tagged + 90 * 86400)
    item = {"id": "t1", "artist": "Artist", "title": "Song", "album_title": "Record", "track_num": 3,
            "date_added": "2026-10-20T12:00:00Z"}
    for rows in ([old, new, later], [later, old, new]):
        assert locate_item(item, FileIndex(rows), CFG)["best"]["path"] == new["path"]
    # Never a filter: an old copy alone still matches, and format preference still wins.
    assert locate_item(item, FileIndex([old]), CFG)["best"]["path"] == old["path"]
    mp3 = row("/s/new mp3/03 Song.mp3", "Song", "Artist", "Record", 3, fmt="mp3-320", created=tagged + 86400)
    assert locate_item(item, FileIndex([old, mp3]), CFG)["best"]["path"] == old["path"]

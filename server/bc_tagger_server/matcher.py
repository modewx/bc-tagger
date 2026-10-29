"""Match tagged Bandcamp items to indexed local files.

Tracks are scored against single files; albums against release folders (an album item
expands to every track in the matched folder). Scores combine fuzzy title / artist / album
similarity (rapidfuzz) with track number and Bandcamp-URL evidence from the file's
comment tag. When several files match about equally well (the same track in several
formats), the format preference picks one: AIFF > FLAC > WAV > ALAC/M4A > MP3-320 > other.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable
from urllib.parse import urlparse

from rapidfuzz import fuzz

from .items import album_name, album_url, bandcamp_host, is_album, item_url
from .normalize import (has_edition_hint, looks_like_label, norm, norm_title, numbers, strip_edition, strip_feat,
                        strip_side, unslug)
from .store import Store, now_iso

# A located match within this distance of the best score counts as "the same track"
# for the format preference.
SAME_TRACK_MARGIN = 0.1
TITLE_GATE = 0.75
# Below this title similarity a track is never auto-accepted, however well artist and
# album agree ("Ego (Naked)" vs "Naked Eye" on the same artist's page).
AUTO_TITLE_MIN = 0.88
ALBUM_GATE = 0.8
# Title tokens shared by more files than this ("the", "mix", "dub") are not used to find
# candidates, unless the title has no rarer token.
MAX_POSTING = 1500
VARIOUS = {"v a", "va", "various", "various artists", "v a various artists"}


def _sim(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return max(fuzz.ratio(a, b), fuzz.token_sort_ratio(a, b)) / 100.0


def _sim_loose(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return max(fuzz.ratio(a, b), fuzz.token_sort_ratio(a, b), 0.95 * fuzz.token_set_ratio(a, b)) / 100.0


def title_similarity(item_title: str, file_title: str) -> float:
    a, b = norm_title(item_title), norm_title(file_title)
    s = _sim(a, b)
    na, nb = numbers(item_title), numbers(file_title)
    if na and nb and na != nb:
        s = min(s, 0.5)  # "Part 3" vs "Part 2", "File #1" vs "File #2"
    elif na != nb:
        s *= 0.9
    return s


def format_rank(fmt: str, preference: list[str]) -> int:
    pref = [p.lower() for p in preference]
    fmt = (fmt or "other").lower()
    if fmt in pref:
        return pref.index(fmt)
    if fmt == "mp3" and "other" in pref:
        return pref.index("other")
    return len(pref)


# -- file side -----------------------------------------------------------------------------


@dataclass
class FileView:
    path: str
    format: str
    root_kind: str
    release_dir: str
    track: int | None
    disc: int | None
    titles: list[str]  # raw title variants
    artists: list[str]  # includes 'Artist - Title' splits of titles
    real_artists: list[str]  # only artist fields (tags, file name, folder)
    albums: list[str]
    hosts: set[str]
    urls: set[str]
    display: dict = field(default_factory=dict)
    created: float | None = None  # file creation time (epoch), for the date tie-break


def _clean(values: Iterable[str | None]) -> list[str]:
    return [v for v in dict.fromkeys(v.strip() for v in values if v and v.strip())]


def _with_variants(titles: Iterable[str | None], artists: Iterable[str | None]) -> tuple[list[str], list[str]]:
    """Add 'Artist - Title' splits, feat.-/side-stripped forms and edition-stripped forms (also composed:
    'Glory (feat. X) (Bonus Digital)' -> 'Glory') to title/artist variants."""
    titles, artists = _clean(titles), _clean(artists)
    for t in list(titles):
        split = _split_artist_title(t)
        if split:
            artists.append(split[0])
            titles.append(split[1])
            last = t.rsplit(" - ", 1)[-1].strip()  # "Dub Squad - Dub Squad - Blown Fruit"
            if last and last != split[1]:
                titles.append(last)
    sides = [strip_side(t) for t in titles]
    titles = _clean(titles + [strip_feat(t) for t in titles] + sides
                    + [strip_feat(s) for s, t in zip(sides, titles) if s != t])  # "B1 Song (feat. X)" -> "Song"
    if has_edition_hint("\n".join(titles)):  # one look per file at index build; most have none
        titles = _clean(titles + [strip_edition(t) for t in titles])
    artists = _clean(artists + [strip_feat(a) for a in artists])
    return titles, artists


def _item_artists(artist: str) -> list[str]:
    """The item's artist, unless it's "V/A" or a label/compilation name (then unknown)."""
    return [] if norm(artist) in VARIOUS or looks_like_label(artist) else [artist]


def _artist_in_title(item_titles: list[str], file_artists: list[str]) -> bool:
    """True when one of the file's artists is spelled out in the item title, e.g. a release
    whose Bandcamp "artist" is a catalog number and whose title is 'Tutu Ta "Terkos"'."""
    title_tokens = [set(norm(t).split()) for t in item_titles]
    for a in file_artists:
        na = norm(a)
        if len(na) < 4 or na in VARIOUS:
            continue
        # strictly inside: the title must say more than the artist name
        if any(set(na.split()) < toks for toks in title_tokens):
            return True
    return False


def file_view(row: dict) -> FileView:
    pf = row["parsed"].get("file", {})
    pd = row["parsed"].get("dir", {})
    urls = {u.rstrip("/").lower() for u in row.get("bc_urls") or []}
    hosts = {urlparse(u).netloc for u in urls if urlparse(u).netloc}
    real_artists = _clean([row.get("artist"), row.get("albumartist"), pf.get("artist"), pd.get("artist")])
    titles, artists = _with_variants([row.get("title"), pf.get("title"), pf.get("rest")], real_artists)
    return FileView(
        path=row["path"],
        format=row["format"],
        root_kind=row["root_kind"],
        release_dir=row["release_dir"],
        track=row.get("tracknumber") or pf.get("track"),
        disc=row.get("discnumber") or pf.get("disc"),
        titles=titles,
        artists=artists,
        real_artists=real_artists,
        created=row.get("created"),
        albums=_clean([row.get("album"), pf.get("album"), pd.get("album")]),
        hosts=hosts,
        urls=urls,
        display={
            "title": row.get("title") or pf.get("title"),
            "artist": row.get("artist") or pf.get("artist") or pd.get("artist"),
            "album": row.get("album") or pd.get("album"),
        },
    )


class FileIndex:
    def __init__(self, rows: list[dict]):
        self.files = [file_view(r) for r in rows]
        self.by_path = {f.path: f for f in self.files}
        self.by_token: dict[str, set[int]] = defaultdict(set)
        self.by_url: dict[str, set[int]] = defaultdict(set)
        for i, f in enumerate(self.files):
            for u in f.urls:
                self.by_url[u].add(i)
            for t in f.titles:
                for tok in norm_title(t).split():
                    if len(tok) >= 2 or tok.isdigit():
                        self.by_token[tok].add(i)
        self.releases = release_groups(self.files)

    def candidates_for_titles(self, titles: list[str]) -> set[int]:
        toks = {tok for t in titles for tok in norm_title(t).split() if len(tok) >= 2 or tok.isdigit()}
        if not toks:
            return set(range(len(self.files)))
        postings = sorted((self.by_token.get(tok, set()) for tok in toks), key=len)
        usable = [p for p in postings if len(p) <= MAX_POSTING] or postings[:1]
        out: set[int] = set()
        for p in usable:
            out |= p
        return out


def release_groups(files: list[FileView]) -> dict[str, list[int]]:
    """Group files into releases: one per folder, split by album tag when a folder mixes
    albums (loose-track folders), so an album match never pulls in unrelated files.

    Keys are the folder path, or ``<folder>::<album>`` for folders holding several albums.
    """
    by_dir: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(list))
    for i, f in enumerate(files):
        album = norm(f.display.get("album") or "")
        by_dir[f.release_dir][album].append(i)
    groups: dict[str, list[int]] = {}
    for rdir, albums in by_dir.items():
        if len(albums) == 1:
            groups[rdir] = next(iter(albums.values()))
        else:
            for album, idxs in albums.items():
                groups[f"{rdir}::{album or '?'}"] = idxs
    return groups


# -- item side -----------------------------------------------------------------------------


def _split_artist_title(title: str) -> tuple[str, str] | None:
    parts = [p.strip() for p in title.split(" - ")]
    if len(parts) >= 2 and parts[0]:
        return parts[0], " - ".join(parts[1:])
    return None


def track_item_variants(item: dict) -> dict[str, Any]:
    title = str(item.get("title") or "")
    artist = item.get("artist") or item.get("band_name") or ""
    titles, artists = _with_variants([title], _item_artists(artist))
    albums = _clean([item.get("album_title"), unslug(_url_slug(album_url(item)))])
    track = item.get("track_num")
    return {
        "titles": titles,
        "artists": artists,
        "albums": albums,
        "track": track if isinstance(track, int) and track > 0 else None,
        "host": bandcamp_host(item),
        "url": (item_url(item) or "").rstrip("/").lower(),
    }


def _url_slug(url: str | None) -> str:
    if not url:
        return ""
    return urlparse(url).path.rstrip("/").rsplit("/", 1)[-1]


# -- scoring -------------------------------------------------------------------------------


def score_track(v: dict[str, Any], f: FileView) -> dict[str, Any] | None:
    if v["url"] and v["url"] in f.urls:
        return {"confidence": 1.0, "method": "url", "title": 1.0, "artist": 1.0, "album": 1.0}
    title = max((title_similarity(a, b) for a in v["titles"] for b in f.titles), default=0.0)
    if title < TITLE_GATE:
        return None
    artist = (
        max((_sim_loose(norm(a), norm(b)) for a in v["artists"] for b in f.artists), default=0.0)
        if v["artists"]
        else None
    )
    if artist is not None and artist < 1.0 and _artist_in_title(v["titles"], f.real_artists):
        artist = 1.0
    album = max((_sim_loose(norm(a), norm(b)) for a in v["albums"] for b in f.albums), default=0.0)
    if artist is None:
        score = 0.75 * title + 0.25 * album
    else:
        score = 0.6 * title + 0.25 * artist + 0.15 * album
    if v["track"] and f.track:
        score += 0.05 if v["track"] == f.track else -0.05
    if v["host"] and v["host"] in f.hosts:
        score += 0.1
    if title < AUTO_TITLE_MIN:
        score = min(score, 0.8)  # a fuzzy title alone can't carry a match: candidate at most
    if artist is not None and artist < 0.6:
        # Same title, different artist: a candidate on a matching album (label compilations),
        # otherwise not even that ("Us" by Klara Lewis vs "Us" by Ani Klang).
        score = min(score, 0.7 if album >= 0.6 else 0.5)
    return {
        "confidence": round(max(0.0, min(1.0, score)), 3),
        "method": "auto",
        "title": round(title, 3),
        "artist": None if artist is None else round(artist, 3),
        "album": round(album, 3),
    }


def album_item_variants(item: dict) -> dict[str, Any]:
    artist = item.get("artist") or item.get("band_name") or ""
    names = _clean([album_name(item), unslug(item.get("album_title")), unslug(_url_slug(item_url(item)))])
    return {
        "albums": names,
        "artists": _clean(_item_artists(artist)),
        "host": bandcamp_host(item),
        "url": (item_url(item) or "").rstrip("/").lower(),
    }


def score_release(v: dict[str, Any], files: list[FileView]) -> dict[str, Any] | None:
    if v["url"] and any(v["url"] in f.urls for f in files):
        return {"confidence": 1.0, "method": "url", "album": 1.0, "artist": 1.0}
    group_albums = _clean([a for f in files for a in f.albums])
    group_artists = _clean([a for f in files for a in f.artists])
    album = max((_sim(norm(a), norm(b)) for a in v["albums"] for b in group_albums), default=0.0)
    if album < ALBUM_GATE:
        return None
    artist = (
        max((_sim_loose(norm(a), norm(b)) for a in v["artists"] for b in group_artists), default=0.0)
        if v["artists"]
        else None
    )
    score = album if artist is None else 0.65 * album + 0.35 * artist
    if v["host"] and any(v["host"] in f.hosts for f in files):
        score += 0.1
    if artist is not None and artist < 0.6:
        score = min(score, 0.7)
    return {
        "confidence": round(max(0.0, min(1.0, score)), 3),
        "method": "auto",
        "album": round(album, 3),
        "artist": None if artist is None else round(artist, 3),
    }


# -- locate --------------------------------------------------------------------------------


@dataclass
class MatchConfig:
    threshold: float = 0.85
    candidate_threshold: float = 0.6
    format_preference: list[str] = field(
        default_factory=lambda: ["aiff", "flac", "wav", "alac", "m4a", "mp3-320", "other"]
    )


def _file_entry(f: FileView, scores: dict[str, Any]) -> dict[str, Any]:
    return {
        "path": f.path,
        "format": f.format,
        "confidence": scores["confidence"],
        "method": scores["method"],
        "root_kind": f.root_kind,
        "track_num": f.track,
        "created": f.created,
        **f.display,
        "scores": {k: v for k, v in scores.items() if k not in ("confidence", "method")},
    }


def _release_entry(key: str, files: list[FileView], scores: dict[str, Any], pref: list[str]) -> dict[str, Any]:
    ordered = sorted(files, key=lambda f: (f.disc or 1, f.track or 9999, f.path))
    fmt = Counter(f.format for f in files).most_common(1)[0][0]
    first = ordered[0]
    return {
        "path": key,
        "release_dir": first.release_dir,
        "format": fmt,
        "confidence": scores["confidence"],
        "method": scores["method"],
        "root_kind": first.root_kind,
        "created": min((f.created for f in files if f.created), default=None),
        "album": first.display.get("album"),
        "artist": first.display.get("artist"),
        "scores": {k: v for k, v in scores.items() if k not in ("confidence", "method")},
        "tracks": [
            {"path": f.path, "format": f.format, "track_num": f.track, "disc": f.disc, **f.display}
            for f in ordered
        ],
    }


DATE_SLACK_S = 2 * 86400  # files created up to 2 days before the tag still count as "after"


def _date_rank(entry: dict, tagged_at: float | None) -> tuple[int, float]:
    """Tie-break: files created shortly after the item was tagged first (a new download is
    usually close to the tag date). Never a filter: the downloader may run much later."""
    created = entry.get("created")
    if tagged_at is None or not created:
        return (1, float("inf"))
    delta = created - tagged_at
    return (0, delta + DATE_SLACK_S) if delta >= -DATE_SLACK_S else (1, -delta)


def _tagged_at(item: dict) -> float | None:
    from datetime import datetime

    try:
        return datetime.fromisoformat(str(item.get("date_added")).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _decide(entries: list[dict], overrides: dict[str, str], cfg: MatchConfig,
            tagged_at: float | None = None) -> dict[str, Any]:
    entries = [e for e in entries if overrides.get(e["path"]) != "reject"]
    entries.sort(key=lambda e: -e["confidence"])
    confirmed = [e for e in entries if overrides.get(e["path"]) == "confirm"]
    if confirmed:
        best = {**confirmed[0], "confidence": 1.0, "method": "confirmed"}
        others = [e for e in entries if e["path"] != best["path"]]
        return {"status": "located", "best": best, "candidates": others[:5]}
    if not entries:
        return {"status": "missing", "best": None, "candidates": []}
    top = entries[0]["confidence"]
    eligible = [
        e for e in entries if e["confidence"] >= cfg.threshold and e["confidence"] >= top - SAME_TRACK_MARGIN
    ]
    if eligible:
        best = min(
            eligible,
            key=lambda e: (
                format_rank(e["format"], cfg.format_preference),
                e.get("root_kind") != "owned",  # same format: prefer the Bandcamp download
                _date_rank(e, tagged_at),  # then the copy created closest after tagging
                -e["confidence"],
                e["path"],
            ),
        )
        others = [e for e in entries if e["path"] != best["path"]]
        return {"status": "located", "best": best, "candidates": others[:5]}
    cands = [e for e in entries if e["confidence"] >= cfg.candidate_threshold]
    if cands:
        return {"status": "candidates", "best": None, "candidates": cands[:5]}
    return {"status": "missing", "best": None, "candidates": []}


def _by_track_number(item: dict) -> bool:
    """Import rows flagged ``match_by_track_num``: untitled tracks and vinyl positions."""
    return ("match_by_track_num" in (item.get("flags") or []) and isinstance(item.get("track_num"), int)
            and item["track_num"] > 0 and bool(album_name(item)))


def locate_item(item: dict, index: FileIndex, cfg: MatchConfig, overrides: dict[str, str] | None = None) -> dict:
    overrides = overrides or {}
    entries: list[dict] = []
    if is_album(item):
        v = album_item_variants(item)
        for rdir, idxs in index.releases.items():
            files = [index.files[i] for i in idxs]
            scores = score_release(v, files)
            if scores is None and overrides.get(rdir) == "confirm":
                scores = {"confidence": 0.0, "method": "manual"}
            if scores is not None:
                entries.append(_release_entry(rdir, files, scores, cfg.format_preference))
    else:
        v = track_item_variants(item)
        for i in index.candidates_for_titles(v["titles"]) | index.by_url.get(v["url"], set()):
            f = index.files[i]
            scores = score_track(v, f)
            if scores is None and overrides.get(f.path) == "confirm":
                scores = {"confidence": 0.0, "method": "manual"}
            if scores is not None:
                entries.append(_file_entry(f, scores))
        if _by_track_number(item):  # "Untitled" / "B1": the album's file with that track number
            va = album_item_variants(item)
            for rdir, idxs in index.releases.items():
                files = [index.files[i] for i in idxs]
                numbered = [f for f in files if f.track == item["track_num"] and f.path not in {e["path"] for e in entries}]
                scores = score_release(va, files) if numbered else None
                if scores is not None:
                    entries += [_file_entry(f, {**scores, "method": "track_num"}) for f in numbered]
        # A confirmed path that has no title overlap at all.
        for path, decision in overrides.items():
            if decision == "confirm" and path in index.by_path and all(e["path"] != path for e in entries):
                entries.append(_file_entry(index.by_path[path], {"confidence": 0.0, "method": "manual"}))
    return _decide(entries, overrides, cfg, _tagged_at(item))


def load_overrides(store: Store, item_id: str) -> dict[str, str]:
    rows = store.query("SELECT path, decision FROM match_overrides WHERE item_id = ?", (item_id,))
    return {r["path"]: r["decision"] for r in rows}


def save_result(store: Store, item_id: str, result: dict) -> None:
    with store.tx() as c:
        c.execute(
            "INSERT INTO locate_results(item_id, status, best, candidates, located_at) VALUES(?, ?, ?, ?, ?) "
            "ON CONFLICT(item_id) DO UPDATE SET status = excluded.status, best = excluded.best, "
            "candidates = excluded.candidates, located_at = excluded.located_at",
            (
                item_id,
                result["status"],
                json.dumps(result["best"]) if result["best"] else None,
                json.dumps(result["candidates"]),
                now_iso(),
            ),
        )


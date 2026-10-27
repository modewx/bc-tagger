"""Scoring a hand-written import row (artist, title, album) against a found track, reusing the
matcher's normalization and guards. Used for Bandcamp search results and for linking rows to the
Bandcamp page the user has open."""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Protocol

from rapidfuzz import fuzz

from .matcher import _artist_in_title, _clean, _sim_loose, _with_variants, title_similarity
from .normalize import fold, norm, norm_title, strip_feat

ACCEPT_AT = 0.85

# Store-added title noise: "[Bandcamp Digital Exclusive]", "(Bonus Track)"
_STORE_NOISE = re.compile(r"\s*[\(\[][^\)\]]*\b(?:bandcamp|bonus|exclusive)\b[^\)\]]*[\)\]]", re.I)
_PARENS = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]")


@lru_cache(maxsize=1 << 15)
def _row_forms(title: str | None, artist: str | None) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """A row's title and artist variants. Remembered: link-candidates scores every open row against every item
    of a Bandcamp page, and the resolver scores each row against many hits."""
    titles, artists = _with_variants([title], [artist] if artist else [])
    return tuple(titles), tuple(artists)


@lru_cache(maxsize=1 << 15)
def _hit_forms(title: str | None, artist: str | None) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """A found track's variants, plus its titles without store noise ("[Bandcamp Exclusive]")."""
    titles, artists = _with_variants([title], [artist] if artist else [])
    return tuple(_clean(titles + [_STORE_NOISE.sub("", t) for t in titles])), tuple(artists)


class Found(Protocol):
    title: str
    artist: str | None
    album: str | None


def _title_sim(a: str, b: str) -> float:
    if norm_title(a) and norm_title(b):
        return title_similarity(a, b)
    fa, fb = " ".join(fold(a).split()), " ".join(fold(b).split())  # non-Latin titles ("スカイサーファー")
    return fuzz.ratio(fa, fb) / 100.0 if fa and fb else 0.0


def _best_title(row_titles: list[str], hit_titles: list[str]) -> float:
    return max((_title_sim(a, b) for a in row_titles for b in hit_titles), default=0.0)


def score_hit(hit: Found, artist: str | None, title: str, album: str | None = None, strict: bool = False) -> float:
    """How well ``hit`` agrees with the row. ``strict``: the artist was guessed, so it must match
    closely to auto-accept. Title-only rows are never auto-accepted."""
    row_titles, row_artists = _row_forms(title, artist)
    hit_titles, hit_artists = _hit_forms(hit.title, hit.artist)
    t = _best_title(row_titles, hit_titles)
    if t < 0.88:
        # Same title once "(Metamorphic)", "(… Remix)" etc. are dropped: maybe another version, so
        # a candidate to pick, never auto.
        bare = _best_title(_clean(_PARENS.sub("", x) for x in row_titles), _clean(_PARENS.sub("", y) for y in hit_titles))
        if bare >= 0.88:
            t = max(t, 0.8)
    if t < 0.75:
        return 0.0
    if not row_artists:
        return min(0.9 * t, ACCEPT_AT - 0.01)

    def artist_sim(candidates: list[str]) -> float:
        return max((_sim_loose(norm(x), norm(y)) for x in row_artists for y in candidates), default=0.0)

    a = artist_sim(hit_artists)
    if a > 0.97 and artist_sim(_clean([hit.artist, strip_feat(hit.artist)])) < a:
        a = 0.97  # only via a label compilation's "Artist - Title": just below the artist's own release
    if a < 0.97 and _artist_in_title(row_titles, [hit.artist] if hit.artist else []):
        a = 0.97
    score = 0.65 * t + 0.35 * a
    if album and hit.album:
        score += 0.05 * _sim_loose(norm(album), norm(hit.album))
    if t < 0.88 or (strict and a < 0.9):
        score = min(score, ACCEPT_AT - 0.01)
    if a < 0.6:
        score = min(score, 0.6)
    return round(min(1.0, score), 3)


def readings(row: dict) -> list[tuple[str | None, str, float, bool]]:
    """The ways to read a row, each hit is scored under all of them: (artist, title, weight, strict)."""
    artist = row.get("artist") or None
    title = row.get("title") or ""
    missing = "artist_missing" in (row.get("flags") or [])
    out: list[tuple[str | None, str, float, bool]] = []
    if missing or not artist:
        out.append((None, title, 1.0, False))
    if artist:
        out.append((artist, title, 1.0, missing))  # a guessed artist must match closely
        if not missing:
            out.append((title, artist, 0.98, False))  # written the other way round
    return out


def score_row(hit: Found, row: dict) -> float:
    return max(w * score_hit(hit, a, t, row.get("album"), strict) for a, t, w, strict in readings(row))

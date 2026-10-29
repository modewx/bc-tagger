"""Text normalization and filename / folder-name parsing for matching."""

from __future__ import annotations

import re
import unicodedata
from functools import lru_cache, wraps

_SPECIAL = str.maketrans({"æ": "ae", "Æ": "ae", "ø": "o", "Ø": "o", "ß": "ss", "œ": "oe", "Œ": "oe", "đ": "d", "ł": "l", "Ł": "l"})
_NON_ALNUM = re.compile(r"[^0-9a-z]+")
_NOISE = re.compile(r"\b(original mix|original version|original)\b")
# Mixed In Key-style "Title - 11A - 82" (key + BPM) suffixes, after norm()
_KEY_BPM = re.compile(r"\s\d{1,2}[ab]\s\d{2,3}$")
# Vinyl side prefixes: "B1 Title", "A2- Title", "C3. Title"
_SIDE_PREFIX = re.compile(r"^\s*[a-dA-D][1-9]\s*[-.:)]?\s+(?=\S)")
_SLUG_SEP = re.compile(r"[-_]+")


def _memo(fn):
    """Remember results for string arguments: matching normalizes the same titles over and over (every
    link-candidates call scores all open import rows)."""
    cached = lru_cache(maxsize=1 << 16)(fn)

    @wraps(fn)
    def call(s):
        return cached(s) if s is None or isinstance(s, str) else fn(s)

    return call


@_memo
def fold(s: str | None) -> str:
    """Lowercase, strip accents, map a few special letters (æ -> ae)."""
    if not s:
        return ""
    s = str(s).translate(_SPECIAL)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return s.casefold()


@_memo
def norm(s: str | None) -> str:
    """Folded, '&' -> 'and', punctuation -> spaces, whitespace collapsed."""
    s = fold(s).replace("&", " and ").replace("+", " and ")
    return " ".join(_NON_ALNUM.sub(" ", s).split())


_GLUED_DIGITS = re.compile(r"(?<=[a-z])(?=\d)")


@_memo
def norm_title(s: str | None) -> str:
    """Like ``norm`` but drops '(Original Mix)' noise and Mixed In Key '- 11A - 82' suffixes,
    and splits digits glued to words ('Sfire2' -> 'sfire 2')."""
    t = _KEY_BPM.sub("", _NOISE.sub(" ", norm(s)))
    return " ".join(_GLUED_DIGITS.sub(" ", t).split())


@_memo
def strip_side(s: str | None) -> str:
    """'B1- Tiberis' -> 'Tiberis' (vinyl side prefixes on Bandcamp track titles)."""
    return _SIDE_PREFIX.sub("", s or "", count=1).strip()


_LABEL_WORDS = re.compile(r"\b(records|recordings|label|compilation)\b", re.I)


def looks_like_label(artist: str | None) -> bool:
    """Bandcamp items from label/compilation pages often carry the label as the artist."""
    return bool(_LABEL_WORDS.search(artist or ""))


_FEAT = re.compile(r"\s*[\(\[]?\s*\b(?:feat\.?|ft\.?|featuring)\s+[^\)\]]*[\)\]]?", re.I)


@_memo
def strip_feat(s: str | None) -> str:
    """'Song (feat. X)' / 'Artist ft. X' -> 'Song' / 'Artist' (featured artists move between
    title and artist fields from one source to another)."""
    return " ".join(_FEAT.sub(" ", s or "").split())


# Edition-only qualifiers mark the same recording sold another way: "(Bonus Digital)", "[Bonus Track]",
# "(Bandcamp Exclusive)", "(Digital Only)", "(Explicit)", "(Remastered 2011)", "- 2011 Remaster". A bracket (or a
# " - " suffix) of these words alone, with at least one marker, is dropped. Version qualifiers (Remix, Edit, Dub,
# VIP, Live, Instrumental, Extended, Rework, Bootleg, "Mix") are a different recording: never dropped.
_EDITION_MARKERS = {"bonus", "exclusive", "only", "explicit", "remaster", "remastered"}
_EDITION_WORDS = _EDITION_MARKERS | {"digital", "bandcamp", "cd", "vinyl", "track", "tracks", "cut", "version"}
_BRACKETED = re.compile(r"\s*[\(\[]([^\(\)\[\]]*)[\)\]]")
_DASH_SUFFIX = re.compile(r"\s+[-–]\s+([^-–]+)$")


def has_edition_hint(s: str) -> bool:
    """Whether ``s`` (one title, or several joined) might hold an edition qualifier: a quick first look (plain
    substring checks: ten times faster than a case-insensitive regex, and it runs on every file at index build)."""
    s = s.lower()
    return "bonus" in s or "only" in s or "exclusive" in s or "explicit" in s or "remaster" in s


def _is_edition(text: str) -> bool:
    words = norm(text).split()
    return (bool(words) and any(w in _EDITION_MARKERS for w in words)
            and all(w in _EDITION_WORDS or (len(w) == 4 and w.isdigit()) for w in words))


def strip_edition(s: str | None) -> str:
    """'Close Enemies (Bonus Digital)' -> 'Close Enemies', 'Song - 2011 Remaster' -> 'Song'; 'Song (X Remix)'
    stays. Never strips a title to nothing. Not memoized: it runs on every file title at index build (mostly
    unique strings), and the keyword look below is cheaper than a cache lookup."""
    s = s or ""
    if not has_edition_hint(s):
        return s
    out = _BRACKETED.sub(lambda m: " " if _is_edition(m.group(1)) else m.group(0), s)
    out = _DASH_SUFFIX.sub(lambda m: "" if _is_edition(m.group(1)) else m.group(0), out.rstrip())
    return " ".join(out.split()) or s


def unslug(s: str | None) -> str:
    return _SLUG_SEP.sub(" ", s or "").strip()


_ROMAN = {"i": "1", "ii": "2", "iii": "3", "iv": "4", "v": "5", "vi": "6", "vii": "7", "viii": "8", "ix": "9", "x": "10"}


@_memo
def numbers(s: str | None) -> frozenset[str]:
    """Number tokens in a title ('Part 3', 'File #2', 'Vol. II') for the number-mismatch guard."""
    out = set()
    for tok in norm_title(s).split():
        if tok.isdigit():
            out.add(str(int(tok)))
        elif tok in _ROMAN and tok not in ("i", "v", "x"):
            # single letters are too ambiguous ("I like to watch", "V/A")
            out.add(_ROMAN[tok])
    return frozenset(out)


# -- filename parsing ---------------------------------------------------------------------

_TRACK_PREFIX = re.compile(
    r"^(?:(?P<disc>\d)[-.](?=\d))?(?P<track>\d{1,3})(?:\s*[-._)]\s*|\s+)(?P<rest>.+)$"
)
_SCENE_FILE = re.compile(r"^(?P<track>\d{2,3})-(?P<artist>[^-\s]+)-(?P<title>[^\s]+)$")
# bandcamp-collection-downloader: "<artist> - <album> - <NN> <title>"
_DOWNLOADER_FILE = re.compile(r"^(?P<artist>.+?) - (?P<album>.+) - (?P<track>\d{1,3}) (?P<title>.+)$")


def _despace(s: str) -> str:
    return s.replace("_", " ") if " " not in s else s


def parse_filename(stem: str) -> dict:
    """Guess track number / artist / title from a file name (without extension).

    Returns ``{"track", "disc", "rest", "artist", "title"}``; ``artist``/``title`` come from
    splitting ``rest`` on " - " and may be wrong for titles that contain " - ".
    """
    out: dict = {"track": None, "disc": None, "rest": stem, "artist": None, "title": stem}
    m = _SCENE_FILE.match(stem)
    if m and "_" in stem:
        out.update(
            track=int(m["track"]),
            artist=_despace(m["artist"]),
            title=_despace(m["title"]),
            rest=_despace(m["title"]),
        )
        return out
    m = _TRACK_PREFIX.match(stem)
    d = None if m else _DOWNLOADER_FILE.match(stem)
    if d:
        out.update(track=int(d["track"]), artist=d["artist"].strip(), title=d["title"].strip(),
                   rest=d["title"].strip(), album=d["album"].strip())
        return out
    rest = stem
    if m:
        out["track"] = int(m["track"])
        out["disc"] = int(m["disc"]) if m["disc"] else None
        rest = m["rest"].strip()
    rest = _despace(rest)
    out["rest"] = rest
    out["title"] = rest
    parts = [p.strip() for p in rest.split(" - ")]
    if len(parts) >= 2 and parts[0]:
        out["artist"] = parts[0]
        out["title"] = " - ".join(parts[1:])
    return out


# -- folder parsing -----------------------------------------------------------------------

_BRACKETS = re.compile(r"\[[^\]]*\]|\{[^}]*\}|\([^)]*\)")
_TRAILING_YEAR = re.compile(r"[\s,.-]*\b(19|20)\d{2}\b\s*$")
_YEAR_PREFIX = re.compile(r"^(19|20)\d{2}\s+-\s+(?P<album>.+)$")
_DISC_DIR = re.compile(r"^(cd|disc|disk)\s*\d+$", re.I)


def is_disc_dir(name: str) -> bool:
    return bool(_DISC_DIR.match(name.strip()))


def parse_release_dir(name: str, parent: str | None = None) -> dict:
    """Guess ``artist`` / ``album`` from a release folder name.

    Handles "Artist - Album (Year) [..]", "[CAT] artist - album (year)", scene names
    ("Artist_Name-Album_Name-(CAT)-16BIT-WEB-FLAC-2026-GRP") and the downloader's
    "<artist>/<year> - <release>" layout (pass the artist folder as ``parent``).
    """
    raw = name.strip()
    m = _YEAR_PREFIX.match(raw)
    if m:
        return {"artist": parent, "album": _BRACKETS.sub(" ", m["album"]).strip() or m["album"]}
    if " " not in raw and "_" in raw and "-" in raw:
        parts = [p for p in raw.split("-") if p]
        if len(parts) >= 2:
            return {"artist": _despace(parts[0]), "album": _despace(parts[1])}
    cleaned = " ".join(_BRACKETS.sub(" ", raw).split())
    cleaned = _TRAILING_YEAR.sub("", cleaned).strip(" -")
    if " - " in cleaned:
        artist, album = cleaned.split(" - ", 1)
        return {"artist": artist.strip() or None, "album": album.strip() or None}
    return {"artist": None, "album": cleaned or raw}

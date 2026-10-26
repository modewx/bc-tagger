"""Text normalization and filename / folder-name parsing for matching."""

from __future__ import annotations

import re
import unicodedata

_SPECIAL = str.maketrans({"æ": "ae", "Æ": "ae", "ø": "o", "Ø": "o", "ß": "ss", "œ": "oe", "Œ": "oe", "đ": "d", "ł": "l", "Ł": "l"})
_NON_ALNUM = re.compile(r"[^0-9a-z]+")
_NOISE = re.compile(r"\b(original mix|original version|original)\b")
# Mixed In Key-style "Title - 11A - 82" (key + BPM) suffixes, after norm()
_KEY_BPM = re.compile(r"\s\d{1,2}[ab]\s\d{2,3}$")
# Vinyl side prefixes: "B1 Title", "A2- Title", "C3. Title"
_SIDE_PREFIX = re.compile(r"^\s*[a-dA-D][1-9]\s*[-.:)]?\s+(?=\S)")
_SLUG_SEP = re.compile(r"[-_]+")


def fold(s: str | None) -> str:
    """Lowercase, strip accents, map a few special letters (æ -> ae)."""
    if not s:
        return ""
    s = str(s).translate(_SPECIAL)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return s.casefold()


def norm(s: str | None) -> str:
    """Folded, '&' -> 'and', punctuation -> spaces, whitespace collapsed."""
    s = fold(s).replace("&", " and ").replace("+", " and ")
    return " ".join(_NON_ALNUM.sub(" ", s).split())


_GLUED_DIGITS = re.compile(r"(?<=[a-z])(?=\d)")


def norm_title(s: str | None) -> str:
    """Like ``norm`` but drops '(Original Mix)' noise and Mixed In Key '- 11A - 82' suffixes,
    and splits digits glued to words ('Sfire2' -> 'sfire 2')."""
    t = _KEY_BPM.sub("", _NOISE.sub(" ", norm(s)))
    return " ".join(_GLUED_DIGITS.sub(" ", t).split())


def strip_side(s: str | None) -> str:
    """'B1- Tiberis' -> 'Tiberis' (vinyl side prefixes on Bandcamp track titles)."""
    return _SIDE_PREFIX.sub("", s or "", count=1).strip()


_LABEL_WORDS = re.compile(r"\b(records|recordings|label|compilation)\b", re.I)


def looks_like_label(artist: str | None) -> bool:
    """Bandcamp items from label/compilation pages often carry the label as the artist."""
    return bool(_LABEL_WORDS.search(artist or ""))


_FEAT = re.compile(r"\s*[\(\[]?\s*\b(?:feat\.?|ft\.?|featuring)\s+[^\)\]]*[\)\]]?", re.I)


def strip_feat(s: str | None) -> str:
    """'Song (feat. X)' / 'Artist ft. X' -> 'Song' / 'Artist' (featured artists move between
    title and artist fields from one source to another)."""
    return " ".join(_FEAT.sub(" ", s or "").split())


def unslug(s: str | None) -> str:
    return _SLUG_SEP.sub(" ", s or "").strip()


_ROMAN = {"i": "1", "ii": "2", "iii": "3", "iv": "4", "v": "5", "vi": "6", "vii": "7", "viii": "8", "ix": "9", "x": "10"}


def numbers(s: str | None) -> set[str]:
    """Number tokens in a title ('Part 3', 'File #2', 'Vol. II') for the number-mismatch guard."""
    out = set()
    for tok in norm_title(s).split():
        if tok.isdigit():
            out.add(str(int(tok)))
        elif tok in _ROMAN and tok not in ("i", "v", "x"):
            # single letters are too ambiguous ("I like to watch", "V/A")
            out.add(_ROMAN[tok])
    return out


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

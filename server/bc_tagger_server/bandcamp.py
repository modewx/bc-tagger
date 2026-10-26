"""Find imported rows on Bandcamp, and build tagger items from Bandcamp pages.

* Search: the public autocomplete JSON (``bcsearch_public_api/1/autocomplete_elastic``), from the
  local server with an identifying User-Agent, at most one request per second, cached (see
  ``fetcher``). Fallback: the HTML search page. Bandcamp answers non-browser clients there with a
  bot-check page; that is detected and reported as unavailable, never worked around.
* A Bandcamp URL in the import file (``bandcamp_url``, often a release page) is read directly:
  the row's track is picked from the page's tracklist, no search needed.
* Accepted matches: the track/album page's ``data-tralbum`` gives the full item in the content
  script's shape (ids, album, art, stream link).
* Rows the search misses can be linked by the user from the extension (``link_item``).
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode, urljoin, urlsplit

from .fetcher import Fetcher, Unavailable
from .rowmatch import ACCEPT_AT, score_row
from .store import Store

SEARCH_URL = "https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic"
HTML_SEARCH_URL = "https://bandcamp.com/search"
USER_AGENT = "bc-tagger/0.1 (personal music-collection tool; local server)"
ITEM_FIELDS = ("id", "raw_id", "tralbum_type", "item_type", "title", "artist", "album_title", "album_id",
               "album_url", "item_url", "url", "art_url", "band_id", "track_num", "publish_date", "file")
_ID = re.compile(r"^[at]\d+$")
BandcampUnavailable = Unavailable


def make_fetcher(store: Store, **kw) -> Fetcher:
    return Fetcher(store, USER_AGENT, **kw)


# -- search --------------------------------------------------------------------------------------


@dataclass
class Hit:
    id: str  # "t123" / "a456"
    type: str  # "track" | "album"
    title: str
    artist: str | None
    album: str | None
    url: str | None
    art_url: str | None
    raw: dict

    def to_candidate(self, confidence: float) -> dict[str, Any]:
        album_id = self.raw.get("album_id") if self.type == "track" else self.raw.get("id")
        return {"id": self.id, "type": self.type, "title": self.title, "artist": self.artist,
                "album": self.album, "url": self.url, "art_url": self.art_url, "confidence": round(confidence, 3),
                "album_id": f"a{album_id}" if album_id else None, "band_id": self.raw.get("band_id")}


def search(fetcher: Fetcher, text: str, kind: str = "t") -> tuple[list[Hit], str]:
    """Search tracks (``kind="t"``) or albums (``"a"``). Returns (hits, method)."""
    status, body = fetcher.request(
        "POST", SEARCH_URL, json_body={"search_text": text, "search_filter": kind, "full_page": False, "fan_id": None}
    )
    if status == 200:
        try:
            results = json.loads(body).get("auto", {}).get("results", [])
            return [h for h in (_hit_from_json(r) for r in results) if h and h.id[0] == kind], "autocomplete"
        except (ValueError, AttributeError):
            pass
    status, body = fetcher.request("GET", HTML_SEARCH_URL, params={"q": text, "item_type": kind})
    if status != 200 or "searchresult" not in body:
        raise Unavailable("Bandcamp search unavailable (the HTML search returns a bot-check page)")
    return parse_html_search(body, kind), "html"


def _hit_from_json(r: dict) -> Hit | None:
    t = r.get("type")
    if t not in ("t", "a") or not r.get("id"):
        return None
    return Hit(
        id=f"{t}{r['id']}", type="track" if t == "t" else "album", title=r.get("name") or "",
        artist=r.get("band_name"), album=r.get("album_name") if t == "t" else r.get("name"),
        url=r.get("item_url_path"), art_url=_art_url(r.get("art_id")) or r.get("img"), raw=r,
    )


_RESULT = re.compile(r'<li class="searchresult[^"]*"(?P<attrs>[^>]*)>(?P<body>.*?)</li>', re.S)
_HEADING = re.compile(r'class="heading">\s*<a href="(?P<url>[^"]+)"[^>]*>(?P<title>.*?)</a>', re.S)
_SUBHEAD = re.compile(r'class="subhead">(?P<text>.*?)</div>', re.S)
_SEARCH_DATA = re.compile(r'data-search="(?P<json>[^"]+)"')


def parse_html_search(body: str, kind: str) -> list[Hit]:
    """Classic Bandcamp search markup: li.searchresult > .heading a, .subhead ("from X by Y")."""
    hits = []
    for m in _RESULT.finditer(body):
        b = m.group("body")
        h = _HEADING.search(b)
        if not h:
            continue
        data = {}
        ds = _SEARCH_DATA.search(m.group("attrs"))
        if ds:
            try:
                data = json.loads(html.unescape(ds.group("json")))
            except ValueError:
                data = {}
        sub = _SUBHEAD.search(b)
        sub_text = " ".join(html.unescape(re.sub(r"<[^>]+>", " ", sub.group("text"))).split()) if sub else ""
        artist = album = None
        if " by " in f" {sub_text}":
            before, _, artist = f" {sub_text}".rpartition(" by ")
            album = before.strip()[5:].strip() if before.strip().startswith("from ") else None
        item_id = data.get("id")
        t = (data.get("type") or kind)[:1]
        hits.append(Hit(
            id=f"{t}{item_id}" if item_id else f"{t}?{h.group('url')}", type="track" if t == "t" else "album",
            title=" ".join(html.unescape(re.sub(r"<[^>]+>", "", h.group("title"))).split()),
            artist=(artist or "").strip() or None, album=album, url=h.group("url").split("?")[0], art_url=None, raw=data,
        ))
    return hits


# -- resolve ------------------------------------------------------------------------------------


def resolve(fetcher: Fetcher, row: dict) -> dict[str, Any]:
    """Match one import row: ``{status, confidence, query, chosen, candidates}``."""
    kind = "a" if row.get("kind") == "album" else "t"
    artist = row.get("artist") or None
    title = (row.get("album") if kind == "a" else row.get("title")) or row.get("title") or row.get("album") or ""
    flags = set(row.get("flags") or [])
    missing = "artist_missing" in flags
    scored_row = {**row, "title": title, "album": None if kind == "a" else row.get("album")}
    queries: list[str] = []
    methods: set[str] = set()
    found: dict[str, Hit] = {}

    def run(query: str) -> None:
        if query and query not in queries:
            queries.append(query)
            hits, method = search(fetcher, query, kind)
            methods.add(method)
            for hit in hits:
                found.setdefault(hit.id, hit)

    def score_all() -> list[tuple[float, Hit]]:
        return sorted(((score_row(h, scored_row), h) for h in found.values()), key=lambda x: -x[0])

    run(title if missing or not artist else f"{artist} {title}")
    if "order_ambiguous" in flags and artist and not missing:
        run(f"{title} {artist}")
    ranked = score_all()
    if artist and not missing and not any(s > 0 for s, _ in ranked):
        before = set(found)
        run(title)  # nothing usable for "artist title": search the title alone
        # ...where only hits whose artist agrees count (not every other track with that title)
        ranked = [(s, h) for s, h in score_all() if h.id in before or s > 0.6]
    candidates = [h.to_candidate(s) for s, h in ranked if s > 0][:3]
    best = candidates[0] if candidates else None
    result = {"source": "search", "query": " | ".join(queries), "method": "+".join(sorted(methods)),
              "candidates": candidates, "confidence": best["confidence"] if best else 0.0, "chosen": None}
    if best and best["confidence"] >= ACCEPT_AT:
        result.update(status="accepted", chosen=best)
    else:
        result["status"] = "candidates" if candidates else "none"
    return result


# -- pages ----------------------------------------------------------------------------------------


_TRALBUM = re.compile(r'data-tralbum="(?P<json>[^"]+)"')
_EMBED = re.compile(r'data-embed="(?P<json>[^"]+)"')


def _page(fetcher: Fetcher, url: str) -> tuple[dict, dict] | None:
    status, body = fetcher.request("GET", url)
    m = _TRALBUM.search(body) if status == 200 else None
    if not m:
        return None
    e = _EMBED.search(body)
    return json.loads(html.unescape(m.group("json"))), json.loads(html.unescape(e.group("json"))) if e else {}


def fetch_item(fetcher: Fetcher, candidate: dict) -> dict | None:
    """The tagger item for a candidate, from the page's data-tralbum (None if unavailable)."""
    page = _page(fetcher, candidate["url"]) if candidate.get("url") else None
    return tagger_item(*page) if page else None


def minimal_item(c: dict) -> dict:
    """A candidate whose page can't be read (custom domains that redirect forever): search data only."""
    t = c["id"][0]
    return {"id": c["id"], "raw_id": int(c["id"][1:]) if c["id"][1:].isdigit() else None, "tralbum_type": t,
            "item_type": c["type"], "title": c["title"], "artist": c["artist"], "album_title": c.get("album"),
            "album_id": c.get("album_id"), "band_id": c.get("band_id"), "item_url": c.get("url"),
            "art_url": c.get("art_url"), "track_num": -1 if t == "a" else None, "partial": True}


@dataclass
class _Entry:
    title: str
    artist: str | None
    album: str | None


def item_from_page(fetcher: Fetcher, url: str, row: dict) -> tuple[dict, float] | None:
    """The row's track on a Bandcamp page the import file points at: a track page, or the release
    page (the track picked from its tracklist by title, or by number for untitled tracks)."""
    page = _page(fetcher, url)
    if page is None:
        return None
    tralbum, embed = page
    item = tagger_item(tralbum, embed)
    if item["item_type"] == "track" or row.get("kind") == "album":
        return item, score_row(_Entry(item["title"] or "", item.get("artist"), item.get("album_title")), row)
    best: tuple[float, dict] | None = None
    for entry in tralbum.get("trackinfo") or []:
        e = _Entry(entry.get("title") or "", entry.get("artist") or tralbum.get("artist"), item["title"])
        score = score_row(e, row)
        if "match_by_track_num" in (row.get("flags") or []) and entry.get("track_num") == row.get("track_num"):
            score = max(score, ACCEPT_AT)
        if entry.get("id") and (best is None or score > best[0]):
            best = (score, entry)
    if best is None or best[0] < ACCEPT_AT:
        return None
    entry = best[1]
    return {
        "id": f"t{entry['id']}", "tralbum_type": "t", "item_type": "track", "title": entry.get("title"),
        "album_title": item["title"], "album_id": item["id"], "album_url": item.get("item_url"),
        "track_num": entry.get("track_num"), "raw_id": entry["id"],
        "artist": entry.get("artist") or tralbum.get("artist"), "art_url": item.get("art_url"),
        "band_id": item.get("band_id"), "publish_date": item.get("publish_date"), "file": entry.get("file") or None,
        "item_url": urljoin(item["item_url"], entry["title_link"]) if entry.get("title_link") and item.get("item_url") else None,
    }, best[0]


# -- links ----------------------------------------------------------------------------------------


def search_url(artist: str | None, title: str | None) -> str:
    q = " ".join(p for p in (artist, title) if p)
    return f"{HTML_SEARCH_URL}?{urlencode({'q': q, 'item_type': 't'})}"


def is_bandcamp_url(url: str | None) -> bool:
    host = urlsplit(url or "").netloc.lower()
    return host == "bandcamp.com" or host.endswith(".bandcamp.com")


def page_key(url: str | None) -> str:
    """Compare page URLs: no scheme, query, fragment or trailing slash; lowercase."""
    parts = urlsplit(url or "")
    return f"{parts.netloc}{parts.path}".rstrip("/").lower()


def link_item(item: Any) -> dict:
    """Validate an item the extension read from a Bandcamp page (the content script's shape)."""
    if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not _ID.match(item["id"]):
        raise ValueError("item.id must look like t123 or a456")
    if not isinstance(item.get("title"), str) or not item["title"].strip():
        raise ValueError("item.title is required")
    out = {k: item[k] for k in ITEM_FIELDS if item.get(k) is not None}
    out.setdefault("tralbum_type", item["id"][0])
    out.setdefault("item_type", "album" if item["id"][0] == "a" else "track")
    if out["id"][0] == "a":
        out.setdefault("track_num", -1)
    return out


def _art_url(art_id: Any) -> str | None:
    try:
        return f"https://f4.bcbits.com/img/a{int(art_id):010d}_2.jpg"
    except (TypeError, ValueError):
        return None


def tagger_item(tralbum: dict, embed: dict) -> dict:
    """Build an item in the content script's shape from a page's data-tralbum."""
    cur = tralbum.get("current") or {}
    url = tralbum.get("url")
    tracks = tralbum.get("trackinfo") or []
    first = tracks[0] if tracks else {}
    common = {
        "raw_id": cur.get("id"),
        "artist": tralbum.get("artist") or embed.get("artist"),
        "art_url": _art_url(tralbum.get("art_id")),
        "band_id": cur.get("band_id"),
        "publish_date": cur.get("publish_date"),
        "file": first.get("file") or None,
        "item_url": url,
    }
    if tralbum.get("item_type") == "album" or cur.get("type") == "album":
        return {
            "id": f"a{cur.get('id')}", "tralbum_type": "a", "item_type": "album", "title": cur.get("title"),
            "album_title": cur.get("title"), "album_id": f"a{cur.get('id')}", "album_url": url, "url": url,
            "track_num": -1, **common,
        }
    album_url = tralbum.get("album_url")
    return {
        "id": f"t{cur.get('id')}", "tralbum_type": "t", "item_type": "track", "title": cur.get("title"),
        "album_title": embed.get("album_title"),
        "album_id": f"a{cur['album_id']}" if cur.get("album_id") else None,
        "album_url": urljoin(url, album_url) if album_url and url else album_url,
        "track_num": first.get("track_num") or cur.get("track_number"),
        **common,
    }

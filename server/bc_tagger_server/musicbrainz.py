"""MusicBrainz as an optional lookup source for imports (setting lookup_source: bandcamp (default),
musicbrainz or both): the official, keyless API, at most one request per second, with the app's
own User-Agent.

A recording search gives candidates, scored with rowmatch. For an accepted recording, its releases'
URL relationships give Bandcamp and Discogs links: hints for the row, and with both a Bandcamp page
the importer reads for the exact track.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from . import USER_AGENT
from .fetcher import Fetcher, Unavailable
from .matcher import _sim_loose
from .normalize import norm
from .rowmatch import ACCEPT_AT, score_row
from .store import Store

API = "https://musicbrainz.org/ws/2"
SITE = "https://musicbrainz.org"
MAX_RELEASE_LOOKUPS = 2


def make_fetcher(store: Store, **kw) -> Fetcher:
    return Fetcher(store, USER_AGENT, **kw)


@dataclass
class Recording:
    id: str
    title: str
    artist: str | None
    releases: list[dict] = field(default_factory=list)
    length: int | None = None
    album: str | None = None  # the release title that best fits the row

    def to_candidate(self, confidence: float) -> dict[str, Any]:
        rel = self.releases[0] if self.releases else {}
        return {
            "id": f"mb:{self.id}", "type": "recording", "title": self.title, "artist": self.artist,
            "album": self.album, "year": (rel.get("date") or "")[:4] or None, "length": self.length,
            "url": f"{SITE}/recording/{self.id}", "confidence": round(confidence, 3),
            "release_ids": [r["id"] for r in self.releases[:5] if r.get("id")],
        }


def _credit(credits: list[dict] | None) -> str | None:
    return "".join(f"{c.get('name', '')}{c.get('joinphrase', '')}" for c in credits or []).strip() or None


def _phrase(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def query_for(artist: str | None, title: str) -> str:
    q = f"recording:{_phrase(title)}"
    return f"{q} AND artist:{_phrase(artist)}" if artist else q


def _recording(r: dict, album: str | None) -> Recording:
    releases = sorted(
        r.get("releases") or [],
        key=lambda rel: (
            -(_sim_loose(norm(album), norm(rel.get("title"))) if album else 0.0),
            rel.get("status") != "Official",
            (rel.get("release-group") or {}).get("primary-type") == "Compilation",
            rel.get("date") or "9999",
        ),
    )
    return Recording(id=r["id"], title=r.get("title") or "", artist=_credit(r.get("artist-credit")),
                     releases=releases, length=r.get("length"),
                     album=releases[0].get("title") if releases else None)


def search(fetcher: Fetcher, artist: str | None, title: str, album: str | None = None, limit: int = 10) -> list[Recording]:
    data = fetcher.get_json(f"{API}/recording", {"query": query_for(artist, title), "limit": limit, "fmt": "json"})
    return [_recording(r, album) for r in data.get("recordings") or [] if r.get("id")]


def resolve(fetcher: Fetcher, row: dict) -> dict[str, Any]:
    """Match one import row: ``{status, confidence, query, chosen, candidates}``."""
    title = row.get("title") or row.get("album") or ""
    artist = row.get("artist") or None
    album = row.get("album")
    flags = set(row.get("flags") or [])
    queries: list[str] = []
    found: dict[str, Recording] = {}

    def run(a: str | None, t: str) -> None:
        q = query_for(a, t)
        if t and q not in queries:
            queries.append(q)
            for rec in search(fetcher, a, t, album):
                found.setdefault(rec.id, rec)

    def score_all() -> list[tuple[float, Recording]]:
        return sorted(((score_row(rec, row), rec) for rec in found.values()), key=lambda x: -x[0])

    run(artist, title)
    if "order_ambiguous" in flags and artist:
        run(title, artist)
    ranked = score_all()
    if artist and not any(s > 0 for s, _ in ranked):
        before = set(found)
        run(None, title)  # a misspelled artist, a label as artist...: search the title alone
        # ...where only hits whose artist agrees count (not every other track with that title)
        ranked = [(s, r) for s, r in score_all() if r.id in before or s > 0.6]
    candidates = [r.to_candidate(s) for s, r in ranked if s > 0][:3]
    best = candidates[0] if candidates else None
    result = {"source": "musicbrainz", "query": " | ".join(queries), "candidates": candidates,
              "confidence": best["confidence"] if best else 0.0, "chosen": None}
    if best and best["confidence"] >= ACCEPT_AT:
        result.update(status="accepted", chosen=best)
    else:
        result["status"] = "candidates" if candidates else "none"
    return result


def release_info(fetcher: Fetcher, release_id: str) -> dict[str, Any]:
    """A release's Bandcamp/Discogs links (URL relationships), label and catalog number."""
    data = fetcher.get_json(f"{API}/release/{release_id}", {"inc": "url-rels labels", "fmt": "json"})
    info: dict[str, Any] = {"release_id": release_id, "release_title": data.get("title"),
                            "release_url": f"{SITE}/release/{release_id}"}
    for rel in data.get("relations") or []:
        url = (rel.get("url") or {}).get("resource") or ""
        host = urlsplit(url).netloc.lower()
        if host == "bandcamp.com" or host.endswith(".bandcamp.com"):
            info.setdefault("bandcamp_url", url)
        elif host.endswith("discogs.com"):
            info.setdefault("discogs_url", url)
    label = next((li for li in data.get("label-info") or [] if li.get("label")), None)
    if label:
        info.update(label=label["label"].get("name"), catalog=label.get("catalog-number"))
    return info


def candidate_links(fetcher: Fetcher, candidate: dict) -> dict[str, Any]:
    """Look up the candidate's best releases (at most two) until one links to Bandcamp."""
    merged: dict[str, Any] = {}
    for release_id in (candidate.get("release_ids") or [])[:MAX_RELEASE_LOOKUPS]:
        try:
            info = release_info(fetcher, release_id)
        except Unavailable:
            continue
        for k, v in info.items():
            if v and not merged.get(k):
                merged[k] = v
        if merged.get("bandcamp_url"):
            break
    return merged

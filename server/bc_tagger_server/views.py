"""Compose the API's item view: mirror fields + local / owned / rekordbox status."""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Any

from .items import is_album, item_tags
from .store import Store


# what the views add to each located file, from the index (never from the file itself)
FILE_INFO = ("duration", "sample_rate", "bits", "channels")
_NO_FILE_INFO = dict.fromkeys(FILE_INFO)


def located_tracks(best: dict | None) -> list[dict]:
    """The concrete files an item resolves to (one for a track, several for an album)."""
    if not best:
        return []
    if best.get("tracks"):
        return list(best["tracks"])
    if best.get("path"):
        return [best]
    return []


class ViewData:
    """What the views read, for every item at once: a handful of queries instead of about five per item
    (``/api/items`` shows them all, and every open tab reloads it)."""

    def __init__(self, store: Store, db_path: str):
        # query_all: these run to thousands of rows (owned_ids), read in one piece
        self.locate = {r["item_id"]: r for r in store.query_all(
            "SELECT * FROM locate_results", ["item_id", "status", "best", "candidates", "located_at"])}
        self.owned = {r["id"]: r for r in store.query_all("SELECT * FROM owned_ids", ["id", "source", "checked_at"])}
        self.last_full = store.get_meta("ownership_last_full")
        self.content = {r["path"]: r["content_id"] for r in store.query_all(
            "SELECT path, content_id FROM rb_content WHERE db_path = ?", ["path", "content_id"], (db_path,))}
        self.claims: dict[str, list[dict]] = defaultdict(list)
        for r in store.query_all("SELECT DISTINCT item_id, tag, content_id FROM rb_claims WHERE db_path = ?",
                                 ["item_id", "tag", "content_id"], (db_path,)):
            self.claims[r["item_id"]].append({"tag": r["tag"], "content_id": r["content_id"]})
        # every located file (a track's, or each of a release's tracks)
        self.files = {r["path"]: r for r in store.query_all(
            f"SELECT path, {', '.join(FILE_INFO)} FROM files WHERE path IN ("
            " SELECT json_extract(best, '$.path') FROM locate_results WHERE best IS NOT NULL"
            " UNION ALL SELECT json_extract(t.value, '$.path')"
            " FROM locate_results, json_each(locate_results.best, '$.tracks') AS t WHERE best IS NOT NULL)",
            ["path", *FILE_INFO])}


def file_info(store: Store, paths: list[str]) -> dict[str, dict]:
    """Length and audio format of indexed files, by path."""
    if not paths:
        return {}
    return {r["path"]: r for r in store.query_all(
        f"SELECT path, {', '.join(FILE_INFO)} FROM files WHERE path IN (SELECT value FROM json_each(?))",
        ["path", *FILE_INFO], (json.dumps(paths),))}


def with_file_info(best: dict | None, files: dict[str, dict]) -> dict | None:
    """``best`` with ``duration`` (seconds), ``sample_rate``, ``bits`` and ``channels`` on the file, or on
    each of a release's tracks; null where the index doesn't know."""
    if not best:
        return best
    if best.get("tracks"):
        return {**best, "tracks": [{**t, **_info(files, t.get("path"))} for t in best["tracks"]]}
    if best.get("path"):
        return {**best, **_info(files, best["path"])}
    return best


def _info(files: dict[str, dict], path: str | None) -> dict:
    row = files.get(path) if path else None
    return {k: row[k] for k in FILE_INFO} if row else dict(_NO_FILE_INFO)


def local_status(store: Store, item_id: str, data: ViewData | None = None) -> dict[str, Any]:
    if data is not None:
        row = data.locate.get(item_id)
    else:
        row = store.query_one("SELECT * FROM locate_results WHERE item_id = ?", (item_id,))
    if not row:
        return {"status": "unknown", "best": None, "candidates": []}
    best = json.loads(row["best"]) if row["best"] else None
    if best is not None:
        files = data.files if data is not None else file_info(store, [t["path"] for t in located_tracks(best)])
        best = with_file_info(best, files)
    return {
        "status": row["status"],
        "best": best,
        "candidates": json.loads(row["candidates"]) if row["candidates"] else [],
        "located_at": row["located_at"],
    }


def ownership_status(store: Store, item: dict, data: ViewData | None = None) -> dict[str, Any]:
    if item.get("source") == "other" or str(item.get("id", "")).startswith("o"):
        return {"status": "unknown", "source": "other", "checked_at": None}
    ids = [item["id"]]
    album_id = item.get("album_id")
    if isinstance(album_id, int):
        album_id = f"a{album_id}"
    if isinstance(album_id, str) and album_id.startswith("a") and album_id != item["id"]:
        ids.append(album_id)
    else:
        album_id = item["id"] if str(item["id"]).startswith("a") else None
    if data is not None:  # in id order, as the query returns them
        rows = [data.owned[i] for i in sorted(set(ids)) if i in data.owned]
    else:
        placeholders = ",".join("?" * len(ids))
        rows = store.query(f"SELECT id, source, checked_at FROM owned_ids WHERE id IN ({placeholders})", ids)
    owned = {r["id"]: r for r in rows}
    # what a download can fetch: the track bought alone, and/or its whole release (album or EP)
    detail = {"track_owned": item["id"] in owned and not str(item["id"]).startswith("a"),
              "album_owned": album_id in owned if album_id else False,
              "full_release": album_id if album_id in owned else None}
    if owned:
        row = next(iter(owned.values()))
        return {"status": "owned", "source": row["source"], "checked_at": row["checked_at"], **detail}
    last_full = data.last_full if data is not None else store.get_meta("ownership_last_full")
    if last_full:
        return {"status": "not_owned", "source": last_full["source"], "checked_at": last_full["checked_at"], **detail}
    return {"status": "unknown", "source": None, "checked_at": None, **detail}


def rekordbox_status(store: Store, item: dict, local: dict, db_path: str, playlist_rule=None,
                     data: ViewData | None = None) -> dict[str, Any]:
    """``playlists`` are playlist paths (``/bc-tagger/must``); ``exported`` means every located
    track is in the library and in every playlist its tags map to (``playlist_rule``)."""
    tracks = located_tracks(local.get("best")) if local.get("status") == "located" else []
    paths = [t["path"] for t in tracks]
    content_ids: list[str] = []
    for p in paths:
        if data is not None:
            if p in data.content:
                content_ids.append(data.content[p])
            continue
        row = store.query_one(
            "SELECT content_id FROM rb_content WHERE db_path = ? AND path = ?", (db_path, p)
        )
        if row:
            content_ids.append(row["content_id"])
    if data is not None:
        claims = data.claims.get(item["id"], [])
    else:
        claims = store.query(
            "SELECT DISTINCT tag, content_id FROM rb_claims WHERE db_path = ? AND item_id = ?",
            (db_path, item["id"]),
        )
    playlists = sorted({r["tag"] for r in claims})
    if playlist_rule is not None:
        expected = {k for t in item_tags(item) for k in playlist_rule(t)}
    else:
        expected = set(playlists)
    complete = all(
        {r["tag"] for r in claims if r["content_id"] == cid} >= expected for cid in content_ids
    )
    if not content_ids:
        status = "none"
    elif len(content_ids) == len(paths) and complete:
        status = "exported"
    else:
        status = "partial"
    return {"status": status, "content_ids": content_ids, "playlists": playlists}


def local_hints(local: dict, owned: dict) -> list[str]:
    """Mismatches worth showing, e.g. owned on Bandcamp but only found in the Soulseek folder."""
    best = local.get("best") or {}
    if local.get("status") != "located":
        return ["owned_not_located"] if owned["status"] == "owned" else []
    if owned["status"] == "owned" and best.get("root_kind") == "not_owned":
        return ["owned_but_only_in_not_owned_root"]
    if owned["status"] == "not_owned" and best.get("root_kind") == "owned":
        return ["in_owned_root_but_not_owned"]
    return []


def item_view(store: Store, item: dict, db_path: str, playlist_rule=None,
              data: ViewData | None = None) -> dict[str, Any]:
    local = local_status(store, item["id"], data)
    owned = ownership_status(store, item, data)
    local["hints"] = local_hints(local, owned)
    return {
        **item,
        "is_album": is_album(item),
        "local": local,
        "owned": owned,
        "rekordbox": rekordbox_status(store, item, local, db_path, playlist_rule, data),
    }

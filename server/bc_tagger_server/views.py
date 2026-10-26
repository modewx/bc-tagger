"""Compose the API's item view: mirror fields + local / owned / rekordbox status."""

from __future__ import annotations

import json
from typing import Any

from .items import is_album, item_tags
from .store import Store


def located_tracks(best: dict | None) -> list[dict]:
    """The concrete files an item resolves to (one for a track, several for an album)."""
    if not best:
        return []
    if best.get("tracks"):
        return list(best["tracks"])
    if best.get("path"):
        return [best]
    return []


def local_status(store: Store, item_id: str) -> dict[str, Any]:
    row = store.query_one("SELECT * FROM locate_results WHERE item_id = ?", (item_id,))
    if not row:
        return {"status": "unknown", "best": None, "candidates": []}
    return {
        "status": row["status"],
        "best": json.loads(row["best"]) if row["best"] else None,
        "candidates": json.loads(row["candidates"]) if row["candidates"] else [],
        "located_at": row["located_at"],
    }


def ownership_status(store: Store, item: dict) -> dict[str, Any]:
    ids = [item["id"]]
    album_id = item.get("album_id")
    if isinstance(album_id, str) and album_id.startswith("a"):
        ids.append(album_id)
    elif isinstance(album_id, int):
        ids.append(f"a{album_id}")
    placeholders = ",".join("?" * len(ids))
    row = store.query_one(
        f"SELECT source, checked_at FROM owned_ids WHERE id IN ({placeholders}) LIMIT 1", ids
    )
    if row:
        return {"status": "owned", "source": row["source"], "checked_at": row["checked_at"]}
    last_full = store.get_meta("ownership_last_full")
    if last_full:
        return {"status": "not_owned", "source": last_full["source"], "checked_at": last_full["checked_at"]}
    return {"status": "unknown", "source": None, "checked_at": None}


def rekordbox_status(store: Store, item: dict, local: dict, db_path: str, playlist_rule=None) -> dict[str, Any]:
    """``playlists`` are playlist paths (``/bc-tagger/must``); ``exported`` means every located
    track is in the library and in every playlist its tags map to (``playlist_rule``)."""
    tracks = located_tracks(local.get("best")) if local.get("status") == "located" else []
    paths = [t["path"] for t in tracks]
    content_ids: list[str] = []
    for p in paths:
        row = store.query_one(
            "SELECT content_id FROM rb_content WHERE db_path = ? AND path = ?", (db_path, p)
        )
        if row:
            content_ids.append(row["content_id"])
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


def item_view(store: Store, item: dict, db_path: str, playlist_rule=None) -> dict[str, Any]:
    local = local_status(store, item["id"])
    owned = ownership_status(store, item)
    local["hints"] = local_hints(local, owned)
    return {
        **item,
        "is_album": is_album(item),
        "local": local,
        "owned": owned,
        "rekordbox": rekordbox_status(store, item, local, db_path, playlist_rule),
    }

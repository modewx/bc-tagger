"""Tag → playlist mapping and playlist-path resolution inside a rekordbox library.

Names (settings ``tag_playlist_map`` and the auto mode):

* ``Name``        → a playlist inside the target folder (``playlist_folder``)
* ``Folder/Name`` → a path below the target folder
* ``/A/B/Name``   → a path from the library root

Canonical keys are root paths with a leading slash, e.g. ``/bc-tagger/must``. Names are
compared after Unicode NFC normalization.
"""

from __future__ import annotations

import unicodedata
from collections import defaultdict
from typing import Any, Iterable

ROOT_ID = "root"
KINDS = {0: "playlist", 1: "folder", 4: "smart"}


class PlaylistError(ValueError):
    pass


def _nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s or "").strip()


def name_to_parts(name: str, folder: str) -> tuple[str, ...]:
    name = name.strip()
    if name.startswith("/"):
        parts = name[1:].split("/")
    else:
        parts = [folder, *name.split("/")]
    parts = [_nfc(p) for p in parts]
    if not parts or any(not p for p in parts):
        raise PlaylistError(f"invalid playlist name {name!r}")
    return tuple(parts)


def key_of(parts: Iterable[str]) -> str:
    return "/" + "/".join(parts)


def parts_of(key: str) -> tuple[str, ...]:
    return tuple(key[1:].split("/"))


def playlists_for_tag(tag: str, mode: str, mapping: dict[str, list[str]], folder: str) -> list[str]:
    """Canonical playlist keys a tag exports to ([] = not exported)."""
    if mode == "auto":
        return [key_of((_nfc(folder), _nfc(tag)))]  # the tag is one literal name, even with "/"
    return list(dict.fromkeys(key_of(name_to_parts(n, folder)) for n in mapping.get(tag, []) if n.strip()))


def mapping_warning(mode: str, mapping: dict[str, list[str]]) -> str | None:
    if mode == "custom" and not any(mapping.values()):
        return "No tag is mapped to a playlist, so nothing would be exported."
    return None


class Tree:
    """In-memory view of djmdPlaylist for lookups, planned creations and listing."""

    def __init__(self, db: Any):
        from pyrekordbox.masterdb.models import DjmdPlaylist, DjmdSongPlaylist
        from sqlalchemy import func

        self.children: dict[str, list[Any]] = defaultdict(list)
        for row in db.query(DjmdPlaylist).all():
            self.children[str(row.ParentID)].append(row)
        for rows in self.children.values():
            rows.sort(key=lambda r: (r.Seq or 0, str(r.ID)))
        self.counts = {
            str(pid): n
            for pid, n in db.query(DjmdSongPlaylist.PlaylistID, func.count(DjmdSongPlaylist.ID))
            .group_by(DjmdSongPlaylist.PlaylistID)
        }

    def add(self, row: Any) -> None:
        self.children[str(row.ParentID)].append(row)

    def lookup(self, parts: tuple[str, ...]) -> tuple[Any | None, int, str | None]:
        """Walk ``parts`` from the root.

        Returns ``(node, missing_from, error)``: the playlist row if the whole path exists,
        else the index of the first missing part (everything from there must be created),
        or an error (a folder/smart list in the way, or two entries with the same name).
        """
        parent = ROOT_ID
        node = None
        for i, part in enumerate(parts):
            matches = [c for c in self.children.get(parent, []) if _nfc(c.Name) == part]
            here = key_of(parts[: i + 1])
            if len(matches) > 1:
                return None, i, f"{here}: {len(matches)} playlists/folders have this name"
            if not matches:
                return None, i, None
            node = matches[0]
            kind = KINDS.get(node.Attribute, f"attribute {node.Attribute}")
            last = i == len(parts) - 1
            if not last and node.Attribute != 1:
                return None, i, f"{here} is a {kind}, not a folder"
            if last and node.Attribute == 1:
                return None, i, f"{here} is a folder; tracks can only go into a playlist"
            if last and node.Attribute == 4:
                return None, i, f"{here} is a smart playlist; tracks can't be added to it"
            if last and node.Attribute != 0:
                return None, i, f"{here} is a {kind}, not a playlist"
            parent = str(node.ID)
        return node, len(parts), None

    def resolve(self, key: str) -> dict[str, Any]:
        node, missing_from, error = self.lookup(parts_of(key))
        if error:
            return {"path": key, "status": "error", "error": error}
        return {"path": key, "status": "exists" if node is not None else "create", "error": None}

    def listing(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []

        def walk(parent: str, prefix: str) -> None:
            for row in self.children.get(parent, []):
                path = f"{prefix}/{row.Name}"
                kind = KINDS.get(row.Attribute, "playlist")
                count = (
                    self.counts.get(str(row.ID), 0)
                    if kind == "playlist"
                    else len(self.children.get(str(row.ID), [])) if kind == "folder" else None
                )
                out.append({"path": path, "name": row.Name, "kind": kind, "count": count})
                if kind == "folder":
                    walk(str(row.ID), path)

        walk(ROOT_ID, "")
        return out

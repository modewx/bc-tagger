"""Export located tracks into a rekordbox ``master.db`` (pyrekordbox), one playlist per tag.

Layout: a folder (default ``bc-tagger``) at the playlist root holding one flat playlist per
tag (``must`` and ``pool`` included). Files are referenced in place.

Managed sync: a (tag, track) entry is wanted while at least one tagged item "claims" it.
Export of a selection updates the claims of the selected items only. The tool adds missing
entries and removes only entries it created itself once nothing claims them; entries the
user added in rekordbox are never touched. ``Content`` rows are looked up by file path
first and never deleted, so re-running an export changes nothing.
"""

from __future__ import annotations

import datetime as dt
import logging
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import rbguard
from .items import item_tags
from .store import Store, now_iso
from .views import located_tracks

log = logging.getLogger(__name__)


@dataclass
class TrackPlan:
    path: str
    tags: list[str] = field(default_factory=list)  # ordered, unique
    items: list[str] = field(default_factory=list)
    claims: set[tuple[str, str]] = field(default_factory=set)  # (tag, item_id)


@dataclass
class ExportSelection:
    items: list[dict]  # selected items (dicts with "id", "tags")
    tracks: dict[str, TrackPlan]  # path -> plan
    skipped: list[dict]  # items without a located file
    tag_order: list[str]


def build_selection(store: Store, items: list[dict], tag_vocabulary: list[str]) -> ExportSelection:
    """Resolve items to located tracks; album tags apply to every track of the album."""
    from .views import local_status

    tracks: dict[str, TrackPlan] = {}
    skipped: list[dict] = []
    used_items: list[dict] = []
    for item in items:
        local = local_status(store, item["id"])
        files = located_tracks(local["best"]) if local["status"] == "located" else []
        if not files:
            skipped.append({"id": item["id"], "title": item.get("title"), "status": local["status"]})
            continue
        used_items.append(item)
        tags = item_tags(item)
        for f in files:
            plan = tracks.setdefault(f["path"], TrackPlan(path=f["path"]))
            if item["id"] not in plan.items:
                plan.items.append(item["id"])
            for t in tags:
                if t not in plan.tags:
                    plan.tags.append(t)
                plan.claims.add((t, item["id"]))
    order = {t: i for i, t in enumerate(tag_vocabulary)}
    all_tags = sorted({t for p in tracks.values() for t in p.tags}, key=lambda t: (order.get(t, len(order)), t))
    return ExportSelection(items=used_items, tracks=tracks, skipped=skipped, tag_order=all_tags)


# -- pyrekordbox helpers ---------------------------------------------------------------------


def _path_variants(path: str) -> list[str]:
    return list(dict.fromkeys([path, unicodedata.normalize("NFC", path), unicodedata.normalize("NFD", path)]))


def find_content(db: Any, path: str):
    from pyrekordbox.masterdb.models import DjmdContent

    for p in _path_variants(path):
        row = db.query(DjmdContent).filter(DjmdContent.FolderPath == p).first()
        if row is not None:
            return row
    return None


def _get_or_add(db: Any, model: Any, adder: str, name: str | None, **kw: Any):
    if not name:
        return None
    row = db.query(model).filter(model.Name == name).first()
    if row is not None:
        return row
    return getattr(db, adder)(name, **kw)


def content_kwargs(db: Any, meta: dict[str, Any]) -> dict[str, Any]:
    from pyrekordbox.masterdb import models as m

    kw: dict[str, Any] = {}
    if meta.get("title"):
        kw["Title"] = meta["title"]
    artist = _get_or_add(db, m.DjmdArtist, "add_artist", meta.get("artist"))
    if artist is not None:
        kw["ArtistID"] = artist.ID
    album_name = meta.get("album")
    if album_name:
        album_artist = _get_or_add(db, m.DjmdArtist, "add_artist", meta.get("albumartist") or meta.get("artist"))
        q = db.query(m.DjmdAlbum).filter(m.DjmdAlbum.Name == album_name)
        if album_artist is not None:
            q = q.filter(m.DjmdAlbum.AlbumArtistID == album_artist.ID)
        album = q.first() or db.add_album(album_name, artist=album_artist)
        kw["AlbumID"] = album.ID
    genre = _get_or_add(db, m.DjmdGenre, "add_genre", meta.get("genre"))
    if genre is not None:
        kw["GenreID"] = genre.ID
    label = _get_or_add(db, m.DjmdLabel, "add_label", meta.get("label"))
    if label is not None:
        kw["LabelID"] = label.ID
    if meta.get("duration"):
        kw["Length"] = int(round(meta["duration"]))
    if meta.get("bitrate"):
        kw["BitRate"] = int(meta["bitrate"] // 1000)
    if meta.get("sample_rate"):
        kw["SampleRate"] = int(meta["sample_rate"])
    if meta.get("bits"):
        kw["BitDepth"] = int(meta["bits"])
    if meta.get("year"):
        kw["ReleaseYear"] = int(meta["year"])
    if meta.get("tracknumber"):
        kw["TrackNo"] = int(meta["tracknumber"])
    if meta.get("discnumber"):
        kw["DiscNo"] = int(meta["discnumber"])
    if meta.get("comment"):
        kw["Commnt"] = meta["comment"]
    return kw


def find_folder(db: Any, name: str):
    from pyrekordbox.masterdb.models import DjmdPlaylist

    return (
        db.query(DjmdPlaylist)
        .filter(DjmdPlaylist.Name == name, DjmdPlaylist.Attribute == 1, DjmdPlaylist.ParentID == "root")
        .order_by(DjmdPlaylist.Seq)
        .first()
    )


def find_playlist(db: Any, name: str, parent_id: str):
    from pyrekordbox.masterdb.models import DjmdPlaylist

    return (
        db.query(DjmdPlaylist)
        .filter(DjmdPlaylist.Name == name, DjmdPlaylist.Attribute == 0, DjmdPlaylist.ParentID == str(parent_id))
        .order_by(DjmdPlaylist.Seq)
        .first()
    )


def playlist_songs(db: Any, playlist_id: str) -> list:
    from pyrekordbox.masterdb.models import DjmdSongPlaylist

    return (
        db.query(DjmdSongPlaylist)
        .filter(DjmdSongPlaylist.PlaylistID == str(playlist_id))
        .order_by(DjmdSongPlaylist.TrackNo)
        .all()
    )


def remove_song(db: Any, song: Any) -> None:
    """Remove one playlist entry and renumber the rest, without committing.

    (pyrekordbox's ``remove_from_playlist`` commits mid-way, which would skip our guard.)
    """
    from pyrekordbox.masterdb.models import DjmdSongPlaylist

    playlist_id, track_no = song.PlaylistID, song.TrackNo
    db.delete(song)
    db.flush()
    now = dt.datetime.now()
    moved = []
    with db.registry.disabled():
        for other in (
            db.query(DjmdSongPlaylist)
            .filter(DjmdSongPlaylist.PlaylistID == playlist_id, DjmdSongPlaylist.TrackNo > track_no)
            .order_by(DjmdSongPlaylist.TrackNo)
        ):
            other.TrackNo -= 1
            other.updated_at = now
            moved.append(other)
    if moved:
        db.registry.on_move(moved)


# -- export ----------------------------------------------------------------------------------


def export(
    store: Store,
    db_path: str,
    folder_name: str,
    selection: ExportSelection,
    *,
    dry_run: bool = False,
    file_meta: dict[str, dict] | None = None,
    guard_kwargs: dict[str, Any] | None = None,
    progress=None,
) -> dict[str, Any]:
    """Apply (or with ``dry_run`` only compute) the export. Returns a diff.

    A real run first plans with a dry pass; when nothing would change it returns without
    taking a backup or opening the DB for writing.
    """
    kw = dict(file_meta=file_meta, guard_kwargs=guard_kwargs, progress=progress)
    plan = _export(store, db_path, folder_name, selection, dry_run=True, record=False, **kw)
    if dry_run:
        return plan
    if not plan["changed"]:
        # Nothing to write, but claims may have moved between items: record them.
        result = _export(store, db_path, folder_name, selection, dry_run=True, record=True, **kw)
        result["dry_run"] = False
        return result
    return _export(store, db_path, folder_name, selection, dry_run=False, record=True, **kw)


def _export(
    store: Store,
    db_path: str,
    folder_name: str,
    selection: ExportSelection,
    *,
    dry_run: bool,
    record: bool,
    file_meta: dict[str, dict] | None,
    guard_kwargs: dict[str, Any] | None,
    progress,
) -> dict[str, Any]:
    guard_kwargs = guard_kwargs or {}
    db_key = str(rbguard.resolve(db_path))
    file_meta = file_meta or {}
    diff: dict[str, Any] = {
        "db_path": db_key,
        "dry_run": dry_run,
        "folder": {"name": folder_name, "created": False, "id": None},
        "content_added": [],
        "content_existing": 0,
        "playlists_created": [],
        "entries_added": [],
        "entries_removed": [],
        "entries_kept_user": 0,
        "skipped_items": selection.skipped,
        "missing_files": [],
        "items": len(selection.items),
        "tracks": len(selection.tracks),
        "backup": None,
        "guard": None,
    }

    if dry_run:
        decision = rbguard.check_write(db_key, **guard_kwargs)
        diff["guard"] = decision.to_dict()
        db = rbguard.open_database(db_key, for_write=False)
    else:
        decision = rbguard.require_write(db_key, **guard_kwargs)
        diff["guard"] = decision.to_dict()
        diff["backup"] = str(rbguard.backup(db_key, **guard_kwargs))
        db = rbguard.open_database(db_key, for_write=True, **guard_kwargs)

    content_ids: dict[str, str] = {}
    new_entries: list[tuple[str, str, str, str]] = []  # (tag, content_id, song_id, playlist_id)
    removed_entries: list[tuple[str, str]] = []  # (tag, content_id)
    stale_entries: list[tuple[str, str]] = []
    created_content: list[tuple[str, str]] = []
    try:
        # 1. Folder
        folder = find_folder(db, folder_name)
        if folder is None:
            diff["folder"]["created"] = True
            folder = None if dry_run else db.create_playlist_folder(folder_name)
        diff["folder"]["id"] = folder.ID if folder is not None else None

        # 2. Content rows (looked up by path first)
        total = len(selection.tracks)
        for n, path in enumerate(selection.tracks, 1):
            if not Path(path).is_file():
                diff["missing_files"].append(path)
                continue
            row = find_content(db, path)
            if row is not None:
                content_ids[path] = str(row.ID)
                diff["content_existing"] += 1
            else:
                diff["content_added"].append(path)
                if not dry_run:
                    row = db.add_content(path, **content_kwargs(db, file_meta.get(path, {})))
                    content_ids[path] = str(row.ID)
                    created_content.append((path, str(row.ID)))
                else:
                    content_ids[path] = f"new:{path}"
            if progress:
                progress(n, total, f"content {n}/{total}")

        # 3. Claims after this export, per (tag, content). Items that are not located right
        # now (e.g. their drive is unmounted) are out of scope, so their entries stay put.
        scope = {it["id"] for it in selection.items}
        new_claims: dict[tuple[str, str], set[str]] = {}
        track_pos: dict[str, int] = {}
        for pos, (path, plan) in enumerate(selection.tracks.items()):
            cid = content_ids.get(path)
            if cid is None:
                # File vanished since locate: keep the claims on the content it had before.
                row = store.query_one(
                    "SELECT content_id FROM rb_content WHERE db_path = ? AND path = ?", (db_key, path)
                )
                if row is None:
                    continue
                cid = row["content_id"]
            track_pos.setdefault(cid, pos)
            for tag, item_id in plan.claims:
                new_claims.setdefault((tag, cid), set()).add(item_id)
        old_scope_pairs = {
            (r["tag"], r["content_id"])
            for r in store.query(
                f"SELECT tag, content_id FROM rb_claims WHERE db_path = ? AND item_id IN ({','.join('?' * len(scope)) or 'NULL'})",
                [db_key, *scope],
            )
        }
        affected = sorted(
            set(new_claims) | old_scope_pairs,
            key=lambda p: (_tag_pos(p[0], selection.tag_order), track_pos.get(p[1], len(track_pos)), p[1]),
        )

        # 4. Playlists and entries
        playlists: dict[str, Any] = {}

        def get_playlist(tag: str, create: bool):
            if tag in playlists:
                return playlists[tag]
            pl = find_playlist(db, tag, folder.ID) if folder is not None else None
            if pl is None and create:
                diff["playlists_created"].append(tag)
                pl = None if dry_run else db.create_playlist(tag, parent=folder)
            playlists[tag] = pl
            return pl

        # Create playlists in vocabulary order so they sort nicely in rekordbox.
        for tag in selection.tag_order:
            get_playlist(tag, create=True)

        for tag, cid in affected:
            others = store.query(
                f"SELECT 1 FROM rb_claims WHERE db_path = ? AND tag = ? AND content_id = ? "
                f"AND item_id NOT IN ({','.join('?' * len(scope)) or 'NULL'}) LIMIT 1",
                [db_key, tag, cid, *scope],
            )
            wanted = bool(new_claims.get((tag, cid))) or bool(others)
            pl = get_playlist(tag, create=wanted)
            songs = playlist_songs(db, pl.ID) if pl is not None else []
            present = [s for s in songs if str(s.ContentID) == cid]
            ours = store.query_one(
                "SELECT song_id FROM rb_entries WHERE db_path = ? AND tag = ? AND content_id = ?",
                (db_key, tag, cid),
            )
            ours_song = next((s for s in present if ours and str(s.ID) == ours["song_id"]), None)
            if ours and ours_song is None:
                stale_entries.append((tag, cid))
            if wanted:
                if present:
                    if ours_song is None:
                        diff["entries_kept_user"] += 1
                    continue
                diff["entries_added"].append({"tag": tag, "content_id": cid, "path": _path_of(content_ids, cid)})
                if not dry_run:
                    song = db.add_to_playlist(pl, cid)
                    new_entries.append((tag, cid, str(song.ID), str(pl.ID)))
            elif ours_song is not None:
                diff["entries_removed"].append({"tag": tag, "content_id": cid, "path": _path_of(content_ids, cid)})
                removed_entries.append((tag, cid))
                if not dry_run:
                    remove_song(db, ours_song)

        changed = bool(
            diff["folder"]["created"]
            or diff["content_added"]
            or diff["playlists_created"]
            or diff["entries_added"]
            or diff["entries_removed"]
        )
        diff["changed"] = changed
        if dry_run:
            db.rollback()
            if not record:
                return diff
        elif changed:
            diff["guard"] = rbguard.guarded_commit(db, db_key, **guard_kwargs).to_dict()
        else:
            db.rollback()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
        db.engine.dispose()

    # 5. Record what we did (only after a successful commit).
    ts = now_iso()
    with store.tx() as c:
        for path, cid in content_ids.items():
            c.execute(
                "INSERT INTO rb_content(db_path, path, content_id, created_by_us, updated_at) VALUES(?, ?, ?, ?, ?) "
                "ON CONFLICT(db_path, path) DO UPDATE SET content_id = excluded.content_id, updated_at = excluded.updated_at",
                (db_key, path, cid, int(any(p == path for p, _ in created_content)), ts),
            )
        c.execute(
            f"DELETE FROM rb_claims WHERE db_path = ? AND item_id IN ({','.join('?' * len(scope)) or 'NULL'})",
            [db_key, *scope],
        )
        for (tag, cid), item_ids in new_claims.items():
            for item_id in item_ids:
                c.execute(
                    "INSERT OR IGNORE INTO rb_claims(db_path, tag, content_id, item_id) VALUES(?, ?, ?, ?)",
                    (db_key, tag, cid, item_id),
                )
        for tag, cid in stale_entries + removed_entries:
            c.execute("DELETE FROM rb_entries WHERE db_path = ? AND tag = ? AND content_id = ?", (db_key, tag, cid))
        for tag, cid, song_id, pl_id in new_entries:
            c.execute(
                "INSERT INTO rb_entries(db_path, tag, content_id, song_id, playlist_id, created_at) VALUES(?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(db_path, tag, content_id) DO UPDATE SET song_id = excluded.song_id, "
                "playlist_id = excluded.playlist_id, created_at = excluded.created_at",
                (db_key, tag, cid, song_id, pl_id, ts),
            )
    return diff


def _tag_pos(tag: str, order: list[str]) -> int:
    return order.index(tag) if tag in order else len(order)


def _path_of(content_ids: dict[str, str], cid: str) -> str | None:
    return next((p for p, c in content_ids.items() if c == cid), None)


# -- verification ----------------------------------------------------------------------------


def read_back(db_path: str, folder_name: str) -> dict[str, Any]:
    """Re-read the DB: folder -> playlists -> track paths (for verification and the CLI)."""
    from pyrekordbox.masterdb.models import DjmdContent, DjmdPlaylist
    from sqlalchemy import func

    db = rbguard.open_database(db_path, for_write=False)
    try:
        folder = find_folder(db, folder_name)
        out: dict[str, Any] = {
            "db_path": str(rbguard.resolve(db_path)),
            "content_count": db.get_content().count(),
            "folder": None,
            "playlists": {},
        }
        if folder is None:
            return out
        out["folder"] = {"id": str(folder.ID), "name": folder.Name}
        for pl in (
            db.query(DjmdPlaylist).filter(DjmdPlaylist.ParentID == str(folder.ID)).order_by(DjmdPlaylist.Seq)
        ):
            paths = []
            for s in playlist_songs(db, pl.ID):
                c = db.query(DjmdContent).filter(DjmdContent.ID == s.ContentID).first()
                paths.append(c.FolderPath if c is not None else None)
            out["playlists"][pl.Name] = paths
        dup = (
            db.query(DjmdContent.FolderPath)
            .group_by(DjmdContent.FolderPath)
            .having(func.count(DjmdContent.ID) > 1)
            .all()
        )
        out["duplicate_content_paths"] = [d[0] for d in dup]
        return out
    finally:
        db.close()
        db.engine.dispose()

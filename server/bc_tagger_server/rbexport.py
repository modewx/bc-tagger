"""Export located tracks into a rekordbox ``master.db`` (pyrekordbox), playlists from tags.

Layout: ``auto`` mode puts one playlist per tag (``must`` and ``pool`` included) in a folder
(default ``bc-tagger``); ``custom`` mode maps each tag to any playlists (see playlists.py).
Missing playlists/folders are created; smart playlists, folders and ambiguous paths are errors.
Files are referenced in place.

Managed sync: a (playlist, track) entry is wanted while at least one tagged item "claims" it.
Export of a selection updates the claims of the selected items only. The tool adds missing
entries and removes only entries it created itself once nothing claims them; entries the
user added in rekordbox are never touched or claimed. ``Content`` rows are looked up by file
path (NFC/NFD-insensitive) and never deleted; on the main collection they are never modified.
Re-running an export changes nothing.
"""

from __future__ import annotations

import datetime as dt
import logging
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import hashlib
import json
from typing import Callable

from . import rbguard
from .items import album_name, is_album, item_tags
from .normalize import norm
from .playlists import Tree, key_of, parts_of, playlists_for_tag
from .store import Store, now_iso
from .views import located_tracks

log = logging.getLogger(__name__)

# Extensions pyrekordbox's add_content accepts (its FileType enum names).
_FILE_TYPES = {"MP3", "MP4", "M4A", "AAC", "FLAC", "ALAC", "WAV", "AIFF", "AIF"}


class ExportError(RuntimeError):
    """The export can't run as planned (bad playlist mapping, or the plan changed)."""


@dataclass
class TrackPlan:
    path: str
    tags: list[str] = field(default_factory=list)  # ordered, unique
    playlists: list[str] = field(default_factory=list)  # canonical playlist keys, ordered
    items: list[str] = field(default_factory=list)
    claims: set[tuple[str, str]] = field(default_factory=set)  # (playlist key, item_id)
    # Bandcamp's title/artist/album for this track, for fields the file's tags leave empty.
    meta: dict[str, str] = field(default_factory=dict)


@dataclass
class ExportSelection:
    items: list[dict]  # selected items (dicts with "id", "tags")
    tracks: dict[str, TrackPlan]  # path -> plan
    skipped: list[dict]  # items without a located (or currently available) file
    tag_order: list[str]
    playlist_order: list[str] = field(default_factory=list)  # keys, in creation order
    unmapped_tags: list[str] = field(default_factory=list)  # custom mode: tags with no playlist


def item_metadata(item: dict, track: dict) -> dict[str, str]:
    """Title/artist/album of one located track as the tagger item knows them."""
    from .matcher import VARIOUS

    artist = str(item.get("artist") or item.get("band_name") or "")
    if is_album(item):
        meta = {"title": track.get("title"), "artist": artist or track.get("artist"), "album": album_name(item)}
    else:
        title = str(item.get("title") or "")
        if norm(artist) in VARIOUS and " - " in title:  # "V/A" + "Artist - Title"
            artist, title = (part.strip() for part in title.split(" - ", 1))
        meta = {"title": title, "artist": artist, "album": item.get("album_title")}
    return {k: str(v) for k, v in meta.items() if v}


def auto_rule(folder: str = "bc-tagger") -> Callable[[str], list[str]]:
    return lambda tag: playlists_for_tag(tag, "auto", {}, folder)


def build_selection(
    store: Store,
    items: list[dict],
    tag_vocabulary: list[str],
    playlist_rule: Callable[[str], list[str]] | None = None,
) -> ExportSelection:
    """Resolve items to located tracks and their playlists.

    Album tags apply to every track of the album; a track gets the union of the playlists
    of all its tags (``playlist_rule``: tag -> canonical playlist keys).
    """
    from .views import local_status

    rule = playlist_rule or auto_rule()
    order = {t: i for i, t in enumerate(tag_vocabulary)}
    tracks: dict[str, TrackPlan] = {}
    skipped: list[dict] = []
    used_items: list[dict] = []
    unmapped: set[str] = set()
    for item in items:
        local = item.get("_located") or local_status(store, item["id"])  # import rows bring their own file
        files = located_tracks(local["best"]) if local["status"] == "located" else []
        if not files:
            skipped.append({"id": item["id"], "title": item.get("title"), "status": local["status"]})
            continue
        if not all(Path(f["path"]).is_file() for f in files):
            # e.g. on an unmounted drive: leave the item (and its existing entries) alone
            skipped.append({"id": item["id"], "title": item.get("title"), "status": "unavailable"})
            continue
        used_items.append(item)
        tags = item_tags(item)
        for f in files:
            plan = tracks.setdefault(f["path"], TrackPlan(path=f["path"]))
            for k, v in item_metadata(item, f).items():
                plan.meta.setdefault(k, v)
            if item["id"] not in plan.items:
                plan.items.append(item["id"])
            for t in tags:
                if t not in plan.tags:
                    plan.tags.append(t)
                keys = rule(t)
                if not keys:
                    unmapped.add(t)
                for k in keys:
                    if k not in plan.playlists:
                        plan.playlists.append(k)
                    plan.claims.add((k, item["id"]))
    all_tags = sorted({t for p in tracks.values() for t in p.tags}, key=lambda t: (order.get(t, len(order)), t))
    playlist_order: list[str] = []
    for t in all_tags:
        for k in rule(t):
            if k not in playlist_order and any(k in p.playlists for p in tracks.values()):
                playlist_order.append(k)
    return ExportSelection(
        items=used_items,
        tracks=tracks,
        skipped=skipped,
        tag_order=all_tags,
        playlist_order=playlist_order,
        unmapped_tags=sorted(unmapped, key=lambda t: (order.get(t, len(order)), t)),
    )


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


def content_path_index(db: Any) -> dict[str, str]:
    """FolderPath -> Content ID for the whole DB (one query instead of a scan per track)."""
    from pyrekordbox.masterdb.models import DjmdContent

    index: dict[str, str] = {}
    for cid, folder_path in db.query(DjmdContent.ID, DjmdContent.FolderPath):
        if folder_path:
            index.setdefault(unicodedata.normalize("NFC", folder_path), str(cid))
    return index


def _get_or_add(db: Any, model: Any, adder: str, name: str | None, **kw: Any):
    if not name:
        return None
    row = db.query(model).filter(model.Name == name).first()
    if row is not None:
        return row
    return getattr(db, adder)(name, **kw)


def merged_meta(file_tags: dict[str, Any], item_meta: dict[str, str]) -> dict[str, Any]:
    """File tags, with title/artist/album taken from the tagger item where the tags are empty."""
    merged = dict(file_tags)
    for key in ("title", "artist", "album"):
        if not merged.get(key) and item_meta.get(key):
            merged[key] = item_meta[key]
    return merged


def _album_for(db: Any, meta: dict[str, Any]):
    from pyrekordbox.masterdb import models as m

    name = meta.get("album")
    if not name:
        return None
    album_artist = _get_or_add(db, m.DjmdArtist, "add_artist", meta.get("albumartist") or meta.get("artist"))
    q = db.query(m.DjmdAlbum).filter(m.DjmdAlbum.Name == name)
    if album_artist is not None:
        q = q.filter(m.DjmdAlbum.AlbumArtistID == album_artist.ID)
    return q.first() or db.add_album(name, artist=album_artist)


def fill_empty_fields(db: Any, content: Any, meta: dict[str, Any], dry_run: bool) -> list[str]:
    """Fill Title/Artist/Album of an existing Content row where they are empty."""
    from pyrekordbox.masterdb import models as m

    filled = []
    if not content.Title and meta.get("title"):
        filled.append("Title")
        if not dry_run:
            content.Title = meta["title"]
    if not content.ArtistID and meta.get("artist"):
        filled.append("Artist")
        if not dry_run:
            content.ArtistID = _get_or_add(db, m.DjmdArtist, "add_artist", meta["artist"]).ID
    if not content.AlbumID and meta.get("album"):
        filled.append("Album")
        if not dry_run:
            content.AlbumID = _album_for(db, meta).ID
    return filled


def content_kwargs(db: Any, meta: dict[str, Any]) -> dict[str, Any]:
    from pyrekordbox.masterdb import models as m

    kw: dict[str, Any] = {}
    if meta.get("title"):
        kw["Title"] = meta["title"]
    artist = _get_or_add(db, m.DjmdArtist, "add_artist", meta.get("artist"))
    if artist is not None:
        kw["ArtistID"] = artist.ID
    album = _album_for(db, meta)
    if album is not None:
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


def plan_fingerprint(diff: dict[str, Any]) -> str:
    """What a confirmed dry run promised to write (independent of IDs assigned on write)."""
    payload = {
        "folders": diff["folders_created"],
        "playlists": diff["playlists_created"],
        "content": sorted(diff["content_added"]),
        "updated": sorted(u["path"] for u in diff["content_updated"]),
        "add": sorted([e["playlist"], e["path"] or e["content_id"]] for e in diff["entries_added"]),
        "remove": sorted([e["playlist"], e["path"] or e["content_id"]] for e in diff["entries_removed"]),
        "errors": diff["errors"],
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def export(
    store: Store,
    target: rbguard.Target,
    selection: ExportSelection,
    *,
    dry_run: bool = False,
    folder_name: str | None = None,
    file_meta: dict[str, dict] | None = None,
    progress=None,
    expect: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Apply (or with ``dry_run`` only compute) the export. Returns a diff.

    A real run first plans with a dry pass (on the main collection: on a snapshot copy). It
    refuses if the plan has errors, or if ``expect`` (from a confirmed dry run) no longer
    matches the plan or the DB files. When nothing would change it returns without a backup.
    """
    source_fp = target.source_fingerprint()
    kw = dict(folder_name=folder_name, file_meta=file_meta, progress=progress)
    plan = _export(store, target, selection, dry_run=True, record=False, **kw)
    plan["plan_fingerprint"] = plan_fingerprint(plan)
    plan["source_fingerprint"] = source_fp
    if dry_run:
        return plan
    if plan["errors"]:
        raise ExportError("; ".join(plan["errors"]))
    if expect is not None:
        if expect.get("plan_fingerprint") != plan["plan_fingerprint"] or (
            target.is_main and expect.get("source_fingerprint") != source_fp
        ):
            raise ExportError("the plan changed since the dry run (or the library was modified); run the dry run again")
    if not plan["changed"]:
        # Nothing to write, but claims may have moved between items: record them.
        result = _export(store, target, selection, dry_run=True, record=True, **kw)
        result["dry_run"] = False
        return result
    return _export(store, target, selection, dry_run=False, record=True,
                   expect_plan=plan["plan_fingerprint"], **kw)


def _export(
    store: Store,
    target: rbguard.Target,
    selection: ExportSelection,
    *,
    dry_run: bool,
    record: bool,
    folder_name: str | None,
    file_meta: dict[str, dict] | None,
    progress,
    expect_plan: str | None = None,
) -> dict[str, Any]:
    db_key = str(rbguard.resolve(target.db_path))
    file_meta = file_meta or {}
    diff: dict[str, Any] = {
        "db_path": db_key,
        "target": target.kind,
        "dry_run": dry_run,
        "folder": {"name": folder_name, "created": False, "id": None},
        "folders_created": [],
        "playlists_created": [],
        "content_added": [],
        "content_existing": 0,
        "content_updated": [],
        "entries_added": [],
        "entries_removed": [],
        "entries_kept_user": 0,
        "per_playlist": [],
        "errors": [],
        # [{code, message}] — blockers make a confirm fail (shown before the user confirms);
        # warnings don't.
        "blockers": [],
        "warnings": [],
        "skipped_items": selection.skipped,
        "missing_files": [],
        "failed_files": [],
        "items": len(selection.items),
        "tracks": len(selection.tracks),
        "backup": None,
        "guard": None,
    }
    def warn(code: str, message: str) -> None:
        diff["warnings"].append({"code": code, "message": message})

    if selection.unmapped_tags:
        warn("unmapped_tags", "not exported (no playlist mapped): " + ", ".join(selection.unmapped_tags))
    if not selection.playlist_order and selection.tracks:
        warn("no_mapped_playlists", "no tag of the selected items maps to a playlist")
    if target.is_main and _agent_running():
        warn("rekordbox_agent_running",
             "rekordboxAgent is running; if you use Cloud Library Sync, quit it before exporting")

    if dry_run:
        decision = target.check()
        diff["guard"] = decision.to_dict()
        if not decision.allowed:
            message = decision.reason.removeprefix("refusing: ")
            if decision.code == "rekordbox_running":
                message = "rekordbox is running. Quit rekordbox before confirming."
            diff["blockers"].append({"code": decision.code or "refused", "message": message})
        db = target.open_read()
    else:
        diff["guard"] = target.require().to_dict()
        diff["backup"] = str(target.backup())
        db = target.open_write()

    content_ids: dict[str, str] = {}
    new_entries: list[tuple[str, str, str, str]] = []  # (playlist key, content_id, song_id, playlist_id)
    removed_entries: list[tuple[str, str]] = []
    stale_entries: list[tuple[str, str]] = []
    created_content: list[tuple[str, str]] = []
    try:
        tree = Tree(db)
        touched: dict[str, Any] = {}  # playlist ID -> row created or changed by this export
        rows: dict[str, Any] = {}  # playlist key -> DjmdPlaylist (None: planned or unresolvable)
        bad: set[str] = set()
        planned: set[str] = set()

        def ensure(key: str, create: bool):
            """The playlist for ``key``; creates missing folders/playlists when ``create``."""
            if key in rows:
                return rows[key]
            parts = parts_of(key)
            node, missing_from, error = tree.lookup(parts)
            if error:
                if error not in diff["errors"]:
                    diff["errors"].append(error)
                bad.add(key)
                rows[key] = None
                return None
            if node is not None or not create:
                rows[key] = node
                return node
            parent = _folder_row(tree, parts[:missing_from]) if missing_from > 0 else None
            for j in range(missing_from, len(parts)):
                k = key_of(parts[: j + 1])
                last = j == len(parts) - 1
                if k not in planned:
                    planned.add(k)
                    (diff["playlists_created"] if last else diff["folders_created"]).append(k)
                if dry_run:
                    continue
                if not last:
                    existing = _folder_row(tree, parts[: j + 1])
                    if existing is None:
                        existing = db.create_playlist_folder(parts[j], parent=parent)
                        tree.add(existing)
                        touched[str(existing.ID)] = existing
                    parent = existing
                else:
                    pl = db.create_playlist(parts[j], parent=parent)
                    tree.add(pl)
                    touched[str(pl.ID)] = pl
                    rows[key] = pl
                    return pl
            rows[key] = None  # dry run: will be created
            return None

        # 1. Playlists (and folders) in mapping order, so new ones sort nicely in rekordbox
        for key in selection.playlist_order:
            ensure(key, create=True)
        if folder_name:
            diff["folder"]["created"] = key_of((folder_name,)) in diff["folders_created"]

        # 2. Content rows (looked up by path first, NFC/NFD-insensitive)
        known = content_path_index(db)
        total = len(selection.tracks)
        for n, path in enumerate(selection.tracks, 1):
            if not Path(path).is_file():
                diff["missing_files"].append(path)
                continue
            existing = known.get(unicodedata.normalize("NFC", path))
            meta = merged_meta(file_meta.get(path, {}), selection.tracks[path].meta)
            if existing is not None:
                content_ids[path] = existing
                diff["content_existing"] += 1
                if target.is_main:
                    continue  # never modify existing Content in the user's collection
                ours = store.query_one(
                    "SELECT created_by_us FROM rb_content WHERE db_path = ? AND path = ?", (db_key, path)
                )
                if ours is not None and ours["created_by_us"]:
                    from pyrekordbox.masterdb.models import DjmdContent

                    row = db.query(DjmdContent).filter(DjmdContent.ID == existing).first()
                    filled = fill_empty_fields(db, row, meta, dry_run) if row is not None else []
                    if filled:
                        diff["content_updated"].append({"path": path, "fields": filled})
            elif Path(path).suffix.lstrip(".").upper() not in _FILE_TYPES:
                diff["failed_files"].append({"path": path, "error": "file type not supported by rekordbox"})
            else:
                diff["content_added"].append(path)
                if not dry_run:
                    row = db.add_content(path, **content_kwargs(db, meta))
                    content_ids[path] = str(row.ID)
                    created_content.append((path, str(row.ID)))
                else:
                    content_ids[path] = f"new:{path}"
            if progress:
                progress(n, total, f"content {n}/{total}")

        # 3. Claims after this export, per (playlist, content). Items that are not located right
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
            for key, item_id in plan.claims:
                if key not in bad:
                    new_claims.setdefault((key, cid), set()).add(item_id)
        marks = ",".join("?" * len(scope)) or "NULL"
        old_scope_pairs = {
            (r["tag"], r["content_id"])
            for r in store.query(
                f"SELECT tag, content_id FROM rb_claims WHERE db_path = ? AND item_id IN ({marks})",
                [db_key, *scope],
            )
        }
        order = {k: i for i, k in enumerate(selection.playlist_order)}
        affected = sorted(
            set(new_claims) | old_scope_pairs,
            key=lambda p: (order.get(p[0], len(order)), p[0], track_pos.get(p[1], len(track_pos)), p[1]),
        )

        # 4. Entries
        songs_by_pl: dict[str, dict[str, list]] = {}

        def songs_for(pl) -> dict[str, list]:
            if pl is None:
                return {}
            if pl.ID not in songs_by_pl:
                by_cid: dict[str, list] = {}
                for song in playlist_songs(db, pl.ID):
                    by_cid.setdefault(str(song.ContentID), []).append(song)
                songs_by_pl[pl.ID] = by_cid
            return songs_by_pl[pl.ID]

        per: dict[str, dict[str, Any]] = {}
        for key, cid in affected:
            others = store.query(
                f"SELECT 1 FROM rb_claims WHERE db_path = ? AND tag = ? AND content_id = ? "
                f"AND item_id NOT IN ({marks}) LIMIT 1",
                [db_key, key, cid, *scope],
            )
            wanted = bool(new_claims.get((key, cid))) or bool(others)
            pl = ensure(key, create=wanted)
            if key in bad:
                continue
            present = list(songs_for(pl).get(cid, []))
            ours = store.query_one(
                "SELECT song_id FROM rb_entries WHERE db_path = ? AND tag = ? AND content_id = ?",
                (db_key, key, cid),
            )
            ours_song = next((s for s in present if ours and str(s.ID) == ours["song_id"]), None)
            if ours and ours_song is None:
                stale_entries.append((key, cid))
            stats = per.setdefault(key, {"playlist": key, "exists": key not in planned, "add": 0, "remove": 0})
            if wanted:
                if present:
                    if ours_song is None:
                        diff["entries_kept_user"] += 1  # the user's own entry: not claimed
                    continue
                entry = {"playlist": key, "tag": key, "content_id": cid, "path": _path_of(content_ids, cid)}
                diff["entries_added"].append(entry)
                stats["add"] += 1
                if not dry_run:
                    song = db.add_to_playlist(pl, cid)
                    songs_for(pl).setdefault(cid, []).append(song)
                    new_entries.append((key, cid, str(song.ID), str(pl.ID)))
                    touched[str(pl.ID)] = pl
            elif ours_song is not None:
                entry = {"playlist": key, "tag": key, "content_id": cid, "path": _path_of(content_ids, cid)}
                diff["entries_removed"].append(entry)
                stats["remove"] += 1
                removed_entries.append((key, cid))
                if not dry_run:
                    remove_song(db, ours_song)
                    songs_for(pl)[cid].remove(ours_song)
                    touched[str(pl.ID)] = pl
        for key in diff["playlists_created"]:
            per.setdefault(key, {"playlist": key, "exists": False, "add": 0, "remove": 0})
        diff["per_playlist"] = [v for v in per.values() if v["add"] or v["remove"] or not v["exists"]]

        changed = bool(
            diff["folders_created"]
            or diff["playlists_created"]
            or diff["content_added"]
            or diff["content_updated"]
            or diff["entries_added"]
            or diff["entries_removed"]
        )
        diff["changed"] = changed
        if diff["errors"]:
            diff["blockers"].append({"code": "playlist_errors", "message": "; ".join(diff["errors"])})
        diff["can_confirm"] = changed and not diff["blockers"]
        if dry_run:
            db.rollback()
            if not record:
                return diff
        elif diff["errors"]:
            raise ExportError("; ".join(diff["errors"]))
        elif changed:
            if expect_plan is not None and plan_fingerprint(diff) != expect_plan:
                raise ExportError("the library changed while exporting; nothing was written, run the dry run again")
            _touch_playlists(db, touched)
            diff["guard"] = target.commit(db).to_dict()
        else:
            db.rollback()
    except Exception:
        db.rollback()
        raise
    finally:
        rbguard.close_database(db)

    # 5. Record what we did (only after a successful commit).
    ts = now_iso()
    with store.tx() as c:
        for path, cid in content_ids.items():
            c.execute(
                "INSERT INTO rb_content(db_path, path, content_id, created_by_us, updated_at) VALUES(?, ?, ?, ?, ?) "
                "ON CONFLICT(db_path, path) DO UPDATE SET content_id = excluded.content_id, updated_at = excluded.updated_at",
                (db_key, path, cid, int(any(p == path for p, _ in created_content)), ts),
            )
        c.execute(f"DELETE FROM rb_claims WHERE db_path = ? AND item_id IN ({marks})", [db_key, *scope])
        for (key, cid), item_ids in new_claims.items():
            for item_id in item_ids:
                c.execute(
                    "INSERT OR IGNORE INTO rb_claims(db_path, tag, content_id, item_id) VALUES(?, ?, ?, ?)",
                    (db_key, key, cid, item_id),
                )
        for key, cid in stale_entries + removed_entries:
            c.execute("DELETE FROM rb_entries WHERE db_path = ? AND tag = ? AND content_id = ?", (db_key, key, cid))
        for key, cid, song_id, pl_id in new_entries:
            c.execute(
                "INSERT INTO rb_entries(db_path, tag, content_id, song_id, playlist_id, created_at) VALUES(?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(db_path, tag, content_id) DO UPDATE SET song_id = excluded.song_id, "
                "playlist_id = excluded.playlist_id, created_at = excluded.created_at",
                (db_key, key, cid, song_id, pl_id, ts),
            )
    return diff


def _touch_playlists(db: Any, touched: dict[str, Any]) -> None:
    """Bump ``updated_at`` of the playlists this export changed, and let pyrekordbox's commit
    update only their nodes in masterPlaylists6.xml.

    (pyrekordbox's commit otherwise rewrites the Timestamp of every playlist whose XML value
    differs from the DB, i.e. potentially the user's whole file.)
    """
    now = dt.datetime.now()
    for row in touched.values():
        row.updated_at = now
    xml_file = getattr(db, "playlist_xml", None)
    if xml_file is None:
        return
    allowed = set(touched)
    original = xml_file.update

    def update_only_touched(playlist_id, *args, **kwargs):
        if str(playlist_id) in allowed:
            return original(playlist_id, *args, **kwargs)
        return None

    xml_file.update = update_only_touched


def _folder_row(tree: Tree, parts: tuple[str, ...]):
    """The existing folder at ``parts`` (None for the root or if missing)."""
    parent = "root"
    node = None
    for part in parts:
        matches = [c for c in tree.children.get(parent, []) if unicodedata.normalize("NFC", c.Name or "") == part]
        if len(matches) != 1 or matches[0].Attribute != 1:
            return None
        node = matches[0]
        parent = str(node.ID)
    return node


def _agent_running() -> bool:
    from pyrekordbox.utils import get_process_id

    try:
        return bool(get_process_id("rekordboxAgent"))
    except Exception:  # noqa: BLE001
        return False


def _path_of(content_ids: dict[str, str], cid: str) -> str | None:
    return next((p for p, c in content_ids.items() if c == cid), None)


# -- verification ----------------------------------------------------------------------------


def read_back(target: rbguard.Target | str | Path, folder_name: str, keys: list[str] | None = None) -> dict[str, Any]:
    """Re-read the DB (main: a fresh snapshot): the folder's playlists, and the playlists at
    ``keys``, with their track paths (for verification and the CLI)."""
    from pyrekordbox.masterdb.models import DjmdContent, DjmdPlaylist
    from sqlalchemy import func

    if not isinstance(target, rbguard.Target):
        target = rbguard.Target("test", str(target), {})
    db = target.open_read()

    def paths_of(playlist_id) -> list[str | None]:
        out_paths = []
        for s in playlist_songs(db, playlist_id):
            c = db.query(DjmdContent).filter(DjmdContent.ID == s.ContentID).first()
            out_paths.append(c.FolderPath if c is not None else None)
        return out_paths

    try:
        folder = find_folder(db, folder_name)
        out: dict[str, Any] = {
            "db_path": str(rbguard.resolve(target.db_path)),
            "content_count": db.get_content().count(),
            "folder": None,
            "playlists": {},
            "mapped": {},
        }
        if keys:
            tree = Tree(db)
            for key in keys:
                node, _, error = tree.lookup(parts_of(key))
                out["mapped"][key] = error or (paths_of(node.ID) if node is not None else None)
        if folder is None:
            dup = db.query(DjmdContent.FolderPath).group_by(DjmdContent.FolderPath).having(func.count(DjmdContent.ID) > 1).all()
            out["duplicate_content_paths"] = [d[0] for d in dup]
            return out
        out["folder"] = {"id": str(folder.ID), "name": folder.Name}
        for pl in (
            db.query(DjmdPlaylist).filter(DjmdPlaylist.ParentID == str(folder.ID)).order_by(DjmdPlaylist.Seq)
        ):
            out["playlists"][pl.Name] = paths_of(pl.ID)
        dup = (
            db.query(DjmdContent.FolderPath)
            .group_by(DjmdContent.FolderPath)
            .having(func.count(DjmdContent.ID) > 1)
            .all()
        )
        out["duplicate_content_paths"] = [d[0] for d in dup]
        return out
    finally:
        rbguard.close_database(db)

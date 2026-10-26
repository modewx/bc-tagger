"""Application service shared by the HTTP API and the CLI."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Iterable

from . import __version__
from .config import Settings
from .items import is_valid_id, item_tags, matches_query, seed_from_export
from .jobs import JobManager
from .store import Store, now_iso
from .views import item_view

log = logging.getLogger(__name__)


class Service:
    def __init__(self, settings: Settings | None = None, store: Store | None = None, seed: bool = True):
        self.settings = settings or Settings()
        self.store = store or Store()
        self.jobs = JobManager()
        if seed:
            self.seed_items()
        self._migrate_playlist_keys()

    def _migrate_playlist_keys(self) -> None:
        """Export tracking used to be keyed by tag name; it is keyed by playlist path now."""
        if self.store.get_meta("rb_keys_v2"):
            return
        folder = self.settings.get("playlist_folder")
        with self.store.tx() as c:
            for table in ("rb_claims", "rb_entries"):
                c.execute(f"UPDATE OR IGNORE {table} SET tag = '/' || ? || '/' || tag WHERE tag NOT LIKE '/%'", (folder,))
                c.execute(f"DELETE FROM {table} WHERE tag NOT LIKE '/%'")
        self.store.set_meta("rb_keys_v2", True)

    # -- items mirror -----------------------------------------------------------------

    def seed_items(self, force: bool = False) -> dict[str, Any]:
        path = Path(self.settings.get("seed_export_json") or "").expanduser()
        if not path.is_file():
            return {"seeded": False, "reason": f"no export JSON at {path}"}
        result = seed_from_export(self.store, path, force=force)
        if result.get("seeded"):
            log.info("Seeded items mirror from %s (%s items)", path, result.get("upserted"))
        return result

    def target(self, guard_overrides: dict[str, Any] | None = None):
        """The export target from settings only (never from a request)."""
        from .rbguard import Target

        s = self.settings.all()
        if s["rekordbox_target"] == "main":
            main = str(Path(s["rekordbox_main_db_path"]).expanduser())
            guard = {
                # Re-read at every check: switching it off stops a pending write.
                "allow": lambda: bool(self.settings.get("allow_main_writes"))
                and self.settings.get("rekordbox_target") == "main",
                "configured": lambda: str(Path(self.settings.get("rekordbox_main_db_path")).expanduser()),
            }
            return Target("main", main, {**guard, **(guard_overrides or {})})
        return Target("test", str(Path(s["rekordbox_db_path"]).expanduser()), dict(guard_overrides or {}))

    def db_path(self) -> str:
        return self.target().db_path

    def test_db_path(self) -> str:
        return str(Path(self.settings.get("rekordbox_db_path")).expanduser())

    def playlist_rule(self):
        from .playlists import playlists_for_tag

        s = self.settings.all()
        return lambda tag: playlists_for_tag(tag, s["tag_playlist_mode"], s["tag_playlist_map"], s["playlist_folder"])

    def settings_derived(self) -> dict[str, Any]:
        from .playlists import mapping_warning

        s = self.settings.all()
        return {
            "target": s["rekordbox_target"],
            "target_db_path": self.db_path(),
            "mapping_warning": mapping_warning(s["tag_playlist_mode"], s["tag_playlist_map"]),
        }

    def list_items(
        self,
        q: str = "",
        tag: str | None = None,
        limit: int | None = None,
        offset: int = 0,
        ids: Iterable[str] | None = None,
    ) -> tuple[int, list[dict]]:
        items = self.store.all_items()
        if ids is not None:
            wanted = set(ids)
            items = [it for it in items if it["id"] in wanted]
        if q:
            items = [it for it in items if matches_query(it, q)]
        if tag:
            items = [it for it in items if tag in item_tags(it)]
        total = len(items)
        page = items[offset : offset + limit if limit is not None else None]
        db_path = self.db_path()
        rule = self.playlist_rule()
        return total, [item_view(self.store, it, db_path, rule) for it in page]

    def get_item_view(self, item_id: str) -> dict | None:
        item = self.store.get_item(item_id)
        return item_view(self.store, item, self.db_path(), self.playlist_rule()) if item else None

    def sync_items(self, items: dict[str, dict], deleted: list[str], full: bool) -> dict[str, Any]:
        result = self.store.upsert_items(items, deleted, full=full)
        self.store.set_meta("items_source", {"kind": "extension", "synced_at": now_iso(), "full": full})
        for item_id in list(items) + list(deleted):
            self.jobs.bus.publish("item", {"id": item_id})
        return result

    def sync_tags(self, tags: list[str]) -> dict[str, Any]:
        self.store.set_tags(tags)
        self.jobs.bus.publish("tags", {"count": len(tags)})
        return {"tags": len(tags)}

    # -- tag edits queue (app -> extension) -------------------------------------------

    def queue_tag_edit(self, item_id: str, tags: list[str]) -> dict[str, Any]:
        import json

        clean = [t for t in dict.fromkeys(tags) if isinstance(t, str) and t.strip()]
        with self.store.tx() as c:
            cur = c.execute(
                "INSERT INTO tag_edits(item_id, tags, created_at) VALUES(?, ?, ?)",
                (item_id, json.dumps(clean), now_iso()),
            )
            edit_id = cur.lastrowid
        # Reflect the edit in the mirror right away; the extension confirms it later.
        item = self.store.get_item(item_id)
        if item is not None:
            item["tags"] = clean
            self.store.upsert_items({item_id: item})
            self.jobs.bus.publish("item", {"id": item_id})
        return {"edit_id": edit_id, "item_id": item_id, "tags": clean}

    def pending_tag_edits(self) -> list[dict[str, Any]]:
        import json

        rows = self.store.query(
            "SELECT seq, item_id, tags, created_at FROM tag_edits WHERE acked_at IS NULL ORDER BY seq"
        )
        return [
            {"edit_id": r["seq"], "item_id": r["item_id"], "tags": json.loads(r["tags"]), "created_at": r["created_at"]}
            for r in rows
        ]

    def ack_tag_edits(self, edit_ids: list[int]) -> dict[str, Any]:
        ts = now_iso()
        n = 0
        with self.store.tx() as c:
            for eid in edit_ids:
                n += c.execute(
                    "UPDATE tag_edits SET acked_at = ? WHERE seq = ? AND acked_at IS NULL", (ts, int(eid))
                ).rowcount
        return {"acked": n}

    # -- ownership --------------------------------------------------------------------

    def set_ownership(self, owned_ids: list[str], source: str, full: bool) -> dict[str, Any]:
        ts = now_iso()
        clean = [i for i in dict.fromkeys(owned_ids) if is_valid_id(i)]
        with self.store.tx() as c:
            if full:
                c.execute("DELETE FROM owned_ids")
            for i in clean:
                c.execute(
                    "INSERT INTO owned_ids(id, source, checked_at) VALUES(?, ?, ?) "
                    "ON CONFLICT(id) DO UPDATE SET source = excluded.source, checked_at = excluded.checked_at",
                    (i, source, ts),
                )
        if full:
            self.store.set_meta("ownership_last_full", {"source": source, "checked_at": ts, "count": len(clean)})
        self.jobs.bus.publish("ownership", {"count": len(clean), "full": full})
        return {"owned": len(clean), "full": full, "checked_at": ts}

    # -- jobs (filled in by later milestones) -----------------------------------------

    def _not_yet(self, kind: str):
        def run(ctx):
            raise NotImplementedError(f"{kind} is not implemented yet")

        return self.jobs.submit(kind, run)

    def start_ownership_refresh(self):
        from .ownership import refresh

        return self.jobs.submit("ownership-refresh", lambda ctx: refresh(self, ctx))

    # -- index & locate ---------------------------------------------------------------

    def scan(self, ctx=None) -> dict[str, Any]:
        from .indexer import scan

        progress = (lambda cur, tot, msg: ctx.progress(cur, tot, msg)) if ctx else None
        return scan(self.store, self.settings.roots(), progress)

    def start_scan(self):
        return self.jobs.submit("scan", lambda ctx: self.scan(ctx))

    def match_config(self):
        from .matcher import MatchConfig

        s = self.settings.all()
        return MatchConfig(
            threshold=s["match_threshold"],
            candidate_threshold=s["candidate_threshold"],
            format_preference=s["format_preference"],
        )

    def file_index(self):
        from .indexer import load_files
        from .matcher import FileIndex

        return FileIndex(load_files(self.store))

    def locate(self, ids=None, latest=None, ctx=None, rescan: bool = True) -> dict[str, Any]:
        """Locate the selected items (all valid items if neither ``ids`` nor ``latest``)."""
        from .items import select_items
        from .matcher import load_overrides, locate_item, save_result

        scan_stats = self.scan(ctx) if rescan else None
        index = self.file_index()
        cfg = self.match_config()
        chosen = select_items(self.store.all_items(), ids=ids, latest=latest)
        summary = []
        for n, item in enumerate(chosen, 1):
            result = locate_item(item, index, cfg, load_overrides(self.store, item["id"]))
            save_result(self.store, item["id"], result)
            summary.append(_locate_summary(item, result))
            if ctx:
                ctx.progress(n, len(chosen), f"located {n}/{len(chosen)}")
                ctx.item_updated(item["id"])
        counts: dict[str, int] = {}
        for s in summary:
            counts[s["status"]] = counts.get(s["status"], 0) + 1
        return {"items": summary, "counts": counts, "files_indexed": len(index.files), "scan": scan_stats}

    def start_locate(self, ids=None, latest=None):
        return self.jobs.submit("locate", lambda ctx: self.locate(ids=ids, latest=latest, ctx=ctx))

    # -- rekordbox --------------------------------------------------------------------

    def select_located(self, ids=None, latest=None, ctx=None) -> list[dict]:
        """Locate and pick the items to export.

        ``ids``: exactly those items. ``latest``: the N most recent items that are *located*
        (walking newest first). Neither: every item.
        """
        from .items import select_items
        from .matcher import load_overrides, locate_item, save_result

        self.scan(ctx)
        index = self.file_index()
        cfg = self.match_config()
        pool = select_items(self.store.all_items(), ids=ids)
        chosen: list[dict] = []
        for item in pool:
            result = locate_item(item, index, cfg, load_overrides(self.store, item["id"]))
            save_result(self.store, item["id"], result)
            if latest is None:
                chosen.append(item)
            elif result["status"] == "located":
                chosen.append(item)
                if len(chosen) >= latest:
                    break
        return chosen

    def file_meta(self, paths) -> dict[str, dict]:
        out = {}
        for p in paths:
            row = self.store.query_one("SELECT * FROM files WHERE path = ?", (p,))
            if row:
                out[p] = dict(row)
        return out

    TOKEN_TTL_S = 15 * 60

    def _issue_token(self, target, diff: dict[str, Any], item_ids: list[str]) -> tuple[str, str]:
        import secrets
        import time
        from datetime import datetime, timezone

        token = secrets.token_urlsafe(16)
        expires = time.time() + self.TOKEN_TTL_S
        with self.store.tx() as c:
            c.execute("DELETE FROM confirm_tokens WHERE expires_at < ?", (time.time() - 86400,))
            c.execute(
                "INSERT INTO confirm_tokens(token, target, db_path, plan_fingerprint, source_fingerprint, item_ids, "
                "created_at, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (token, target.kind, target.db_path, diff["plan_fingerprint"], diff["source_fingerprint"],
                 json.dumps(item_ids), now_iso(), expires),
            )
        return token, datetime.fromtimestamp(expires, timezone.utc).isoformat(timespec="seconds")

    def _token_expectation(self, token: str, target) -> dict[str, str]:
        import time

        from .rbexport import ExportError

        row = self.store.query_one("SELECT * FROM confirm_tokens WHERE token = ?", (token,))
        if row is None or row["used_at"] or row["expires_at"] < time.time():
            raise ExportError("the confirmation expired or was already used; run the dry run again")
        if row["target"] != target.kind or row["db_path"] != target.db_path:
            raise ExportError("the target library changed since the dry run; run the dry run again")
        return {"plan_fingerprint": row["plan_fingerprint"], "source_fingerprint": row["source_fingerprint"]}

    def export(self, ids=None, latest=None, dry_run=False, ctx=None, guard_kwargs=None,
               confirm_token: str | None = None) -> dict[str, Any]:
        """Export to the configured target. The main collection needs ``confirm_token`` from a dry run."""
        from .rbexport import ExportError, build_selection, export

        target = self.target(guard_kwargs)
        expect = None
        if not dry_run:
            if confirm_token:
                expect = self._token_expectation(confirm_token, target)
            elif target.is_main:
                raise ExportError("dry run required: exports to your main collection need a confirmed dry run")
        items = self.select_located(ids=ids, latest=latest, ctx=ctx)
        selection = build_selection(self.store, items, self.store.get_tags(), self.playlist_rule())
        progress = (lambda cur, tot, msg: ctx.progress(cur, tot, msg)) if ctx else None
        diff = export(
            self.store,
            target,
            selection,
            dry_run=dry_run,
            folder_name=self.settings.get("playlist_folder"),
            file_meta=self.file_meta(selection.tracks),
            progress=progress,
            expect=expect,
        )
        diff["selected_items"] = [{"id": it["id"], "title": it.get("title"), "tags": it.get("tags")} for it in items]
        if dry_run:
            diff["confirm_token"], diff["token_expires_at"] = self._issue_token(target, diff, [it["id"] for it in items])
        elif confirm_token:
            with self.store.tx() as c:
                c.execute("UPDATE confirm_tokens SET used_at = ? WHERE token = ?", (now_iso(), confirm_token))
        if ctx:
            for it in items:
                ctx.item_updated(it["id"])
        return diff

    def start_export(self, ids=None, latest=None, dry_run=False, confirm_token=None):
        return self.jobs.submit(
            "export",
            lambda ctx: self.export(ids=ids, latest=latest, dry_run=dry_run, ctx=ctx, confirm_token=confirm_token),
        )

    def rekordbox_playlists(self) -> list[dict[str, Any]]:
        from .playlists import Tree

        db = self.target().open_read()
        try:
            return Tree(db).listing()
        finally:
            db.close()
            db.engine.dispose()

    def resolve_playlist_names(self, names: list[str]) -> list[dict[str, Any]]:
        from .playlists import PlaylistError, Tree, key_of, name_to_parts

        folder = self.settings.get("playlist_folder")
        db = self.target().open_read()
        try:
            tree = Tree(db)
            out = []
            for name in names:
                try:
                    key = key_of(name_to_parts(name, folder))
                except PlaylistError as e:
                    out.append({"name": name, "path": None, "status": "error", "error": str(e)})
                    continue
                out.append({"name": name, **tree.resolve(key)})
            return out
        finally:
            db.close()
            db.engine.dispose()

    def write_xml(self, ids=None, latest=None) -> dict[str, Any]:
        from .rbexport import build_selection
        from .xmlexport import write_xml

        items = self.select_located(ids=ids, latest=latest)
        selection = build_selection(self.store, items, self.store.get_tags(), self.playlist_rule())
        result = write_xml(
            selection,
            self.settings.get("playlist_folder"),
            self.file_meta(selection.tracks),
            self.settings.xml_output_dir(),
        )
        result["selected_items"] = [{"id": it["id"], "title": it.get("title")} for it in items]
        return result

    def set_match_override(self, item_id: str, path: str, decision: str) -> dict[str, Any]:
        """Confirm or reject a candidate path, then re-locate the item right away."""
        from fastapi import HTTPException

        from .matcher import load_overrides, locate_item, save_result

        item = self.store.get_item(item_id)
        if item is None:
            raise HTTPException(404, f"unknown item {item_id}")
        with self.store.tx() as c:
            if decision == "confirm":
                # One confirmed path per item.
                c.execute("DELETE FROM match_overrides WHERE item_id = ? AND decision = 'confirm'", (item_id,))
            c.execute(
                "INSERT INTO match_overrides(item_id, path, decision, created_at) VALUES(?, ?, ?, ?) "
                "ON CONFLICT(item_id, path) DO UPDATE SET decision = excluded.decision, "
                "created_at = excluded.created_at",
                (item_id, path, decision, now_iso()),
            )
        result = locate_item(item, self.file_index(), self.match_config(), load_overrides(self.store, item_id))
        save_result(self.store, item_id, result)
        self.jobs.bus.publish("item", {"id": item_id})
        return {"item_id": item_id, "path": path, "decision": decision, "item": self.get_item_view(item_id)}

    def start_download(self, string_filter: str, number: int = 1, audio_format: str = "aiff-lossless", dry_run: bool = False):
        from .downloader import run

        def job(ctx):
            result = run(self.settings, string_filter, number, audio_format, dry_run=dry_run,
                         progress=lambda n, t, line: ctx.progress(n, t, line))
            if not dry_run and result.get("new_files"):
                result["scan"] = {k: v for k, v in self.scan(ctx).items() if k != "roots"}
            if not dry_run and not result["ok"]:
                raise RuntimeError("downloader failed: " + "; ".join(result["errors"] or [f"exit {result['exit_code']}"]))
            return result

        return self.jobs.submit("download", job)

    def stream_file(self, request, path: str):
        from .stream import stream_response

        return stream_response(self.store, path)

    # -- health -----------------------------------------------------------------------

    def health(self) -> dict[str, Any]:
        from .rbguard import is_test_library

        db_path = self.db_path()
        return {
            "ok": True,
            "name": "bc-tagger",
            "version": __version__,
            "db": {"path": db_path, "is_test": is_test_library(db_path), "target": self.target().kind},
            "items": self.store.count_items(),
            "items_source": self.store.get_meta("items_source"),
            "build_id": self.build_id(),
        }

    def build_id(self) -> str:
        """Changes whenever the dev extension build or the app build changes."""
        newest = 0.0
        for key in ("dev_extension_build_dir",):
            d = Path(self.settings.get(key) or "").expanduser()
            newest = max(newest, _newest_mtime(d))
        newest = max(newest, _newest_mtime(self.settings.app_dist_dir()))
        return f"{int(newest * 1000):x}" if newest else "0"

    def valid_item_ids(self) -> list[str]:
        return [it["id"] for it in self.store.all_items() if is_valid_id(it["id"])]


def _locate_summary(item: dict, result: dict) -> dict[str, Any]:
    from .items import is_album

    best = result.get("best") or {}
    return {
        "id": item["id"],
        "is_album": is_album(item),
        "artist": item.get("artist"),
        "title": item.get("title"),
        "status": result["status"],
        "path": best.get("path"),
        "format": best.get("format"),
        "confidence": best.get("confidence"),
        "tracks": len(best.get("tracks") or []) if best.get("tracks") else (1 if best else 0),
        "candidates": len(result.get("candidates") or []),
    }


def _newest_mtime(d: Path, limit: int = 5000) -> float:
    if not d.is_dir():
        return 0.0
    newest = 0.0
    for i, p in enumerate(d.rglob("*")):
        if i > limit:
            break
        try:
            if p.is_file():
                newest = max(newest, p.stat().st_mtime)
        except OSError:
            pass
    return newest

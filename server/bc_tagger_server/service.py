"""Application service shared by the HTTP API and the CLI."""

from __future__ import annotations

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

    # -- items mirror -----------------------------------------------------------------

    def seed_items(self, force: bool = False) -> dict[str, Any]:
        path = Path(self.settings.get("seed_export_json") or "").expanduser()
        if not path.is_file():
            return {"seeded": False, "reason": f"no export JSON at {path}"}
        result = seed_from_export(self.store, path, force=force)
        if result.get("seeded"):
            log.info("Seeded items mirror from %s (%s items)", path, result.get("upserted"))
        return result

    def db_path(self) -> str:
        return str(Path(self.settings.get("rekordbox_db_path")).expanduser())

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
        return total, [item_view(self.store, it, db_path) for it in page]

    def get_item_view(self, item_id: str) -> dict | None:
        item = self.store.get_item(item_id)
        return item_view(self.store, item, self.db_path()) if item else None

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
        return self._not_yet("ownership-refresh")

    def start_scan(self):
        return self._not_yet("scan")

    def start_locate(self, ids=None, latest=None):
        return self._not_yet("locate")

    def start_export(self, ids=None, latest=None, dry_run=False):
        return self._not_yet("export")

    def write_xml(self, ids=None, latest=None) -> dict[str, Any]:
        from fastapi import HTTPException

        raise HTTPException(501, "XML export is not implemented yet")

    def set_match_override(self, item_id: str, path: str, decision: str) -> dict[str, Any]:
        with self.store.tx() as c:
            c.execute(
                "INSERT INTO match_overrides(item_id, path, decision, created_at) VALUES(?, ?, ?, ?) "
                "ON CONFLICT(item_id, path) DO UPDATE SET decision = excluded.decision, "
                "created_at = excluded.created_at",
                (item_id, path, decision, now_iso()),
            )
        return {"item_id": item_id, "path": path, "decision": decision}

    def stream_file(self, request, path: str):
        from fastapi import HTTPException

        raise HTTPException(501, "file streaming is not implemented yet")

    # -- health -----------------------------------------------------------------------

    def health(self) -> dict[str, Any]:
        from .rbguard import is_test_library

        db_path = self.db_path()
        return {
            "ok": True,
            "version": __version__,
            "db": {"path": db_path, "is_test": is_test_library(db_path)},
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

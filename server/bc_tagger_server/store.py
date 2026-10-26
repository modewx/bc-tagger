"""SQLite state: the items/tags mirror plus local-only data.

One connection shared across threads behind a lock; the server's write volume is tiny.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

from .config import data_dir

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    date_added TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_date_added ON items(date_added);

CREATE TABLE IF NOT EXISTS tags (name TEXT PRIMARY KEY, pos INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    root TEXT NOT NULL,
    root_kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime REAL NOT NULL,
    ext TEXT NOT NULL,
    format TEXT NOT NULL,
    title TEXT, artist TEXT, albumartist TEXT, album TEXT,
    tracknumber INTEGER, discnumber INTEGER,
    comment TEXT, bc_urls TEXT,
    duration REAL, bitrate INTEGER, sample_rate INTEGER, bits INTEGER, codec TEXT,
    year INTEGER, genre TEXT, label TEXT,
    release_dir TEXT NOT NULL,
    created REAL,
    parsed TEXT,
    scanned_at TEXT NOT NULL,
    error TEXT
);
CREATE INDEX IF NOT EXISTS files_root ON files(root);
CREATE INDEX IF NOT EXISTS files_release_dir ON files(release_dir);

CREATE TABLE IF NOT EXISTS locate_results (
    item_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    best TEXT,
    candidates TEXT,
    located_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS match_overrides (
    item_id TEXT NOT NULL,
    path TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('confirm', 'reject')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (item_id, path)
);

CREATE TABLE IF NOT EXISTS owned_ids (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    checked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rb_content (
    db_path TEXT NOT NULL,
    path TEXT NOT NULL,
    content_id TEXT NOT NULL,
    created_by_us INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (db_path, path)
);

-- Which tagged item wants (tag, content) in the tag playlist.
CREATE TABLE IF NOT EXISTS rb_claims (
    db_path TEXT NOT NULL,
    tag TEXT NOT NULL,
    content_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    PRIMARY KEY (db_path, tag, content_id, item_id)
);

-- Playlist entries this tool created (managed sync only ever removes these).
CREATE TABLE IF NOT EXISTS rb_entries (
    db_path TEXT NOT NULL,
    tag TEXT NOT NULL,
    content_id TEXT NOT NULL,
    song_id TEXT NOT NULL,
    playlist_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (db_path, tag, content_id)
);

-- Dry runs that a real export may confirm (required for the main collection).
CREATE TABLE IF NOT EXISTS confirm_tokens (
    token TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    db_path TEXT NOT NULL,
    plan_fingerprint TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    item_ids TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at REAL NOT NULL,
    used_at TEXT
);

-- The "other" collection: items not on Bandcamp, owned by the server (Phase 3).
CREATE TABLE IF NOT EXISTS other_items (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    date_added TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_rows (
    batch_id TEXT NOT NULL,
    n INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (batch_id, n)
);

-- Items (and new vocabulary tags) for the extension to add to chrome.storage.
CREATE TABLE IF NOT EXISTS pending_adds (
    add_id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acked_at TEXT
);

-- Cached Bandcamp search/page responses.
CREATE TABLE IF NOT EXISTS http_cache (
    key TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    status INTEGER NOT NULL,
    body TEXT NOT NULL,
    fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tag_edits (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    tags TEXT NOT NULL,
    created_at TEXT NOT NULL,
    acked_at TEXT
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: Path | None = None):
        self.path = path or data_dir() / "server.db"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)
        self._migrate()

    def _migrate(self) -> None:
        cols = {r[1] for r in self._conn.execute("PRAGMA table_info(files)")}
        if "created" not in cols:  # file creation time (st_birthtime), added for date matching
            self._conn.execute("ALTER TABLE files ADD COLUMN created REAL")

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            else:
                self._conn.execute("COMMIT")

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, tuple(params)).fetchall()

    def query_one(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Row | None:
        with self._lock:
            return self._conn.execute(sql, tuple(params)).fetchone()

    # -- meta -------------------------------------------------------------------------

    def get_meta(self, key: str, default: Any = None) -> Any:
        row = self.query_one("SELECT value FROM meta WHERE key = ?", (key,))
        return json.loads(row["value"]) if row else default

    def set_meta(self, key: str, value: Any) -> None:
        with self.tx() as c:
            c.execute(
                "INSERT INTO meta(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value)),
            )

    # -- items mirror -----------------------------------------------------------------

    def upsert_items(self, items: dict[str, dict], deleted: Iterable[str] = (), full: bool = False) -> dict:
        ts = now_iso()
        deleted = list(deleted)
        with self.tx() as c:
            removed = 0
            if full:
                keep = set(items)
                existing = [r["id"] for r in c.execute("SELECT id FROM items")]
                gone = [i for i in existing if i not in keep]
                for i in gone:
                    c.execute("DELETE FROM items WHERE id = ?", (i,))
                removed += len(gone)
            for item_id in deleted:
                removed += c.execute("DELETE FROM items WHERE id = ?", (item_id,)).rowcount
            for item_id, item in items.items():
                if not isinstance(item, dict):
                    continue
                item = {**item, "id": item_id}
                date_added = item.get("date_added") if isinstance(item.get("date_added"), str) else None
                c.execute(
                    "INSERT INTO items(id, data, date_added, updated_at) VALUES(?, ?, ?, ?) "
                    "ON CONFLICT(id) DO UPDATE SET data = excluded.data, "
                    "date_added = excluded.date_added, updated_at = excluded.updated_at",
                    (item_id, json.dumps(item), date_added, ts),
                )
        return {"upserted": len(items), "removed": removed}

    def set_tags(self, tags: list[str]) -> None:
        with self.tx() as c:
            c.execute("DELETE FROM tags")
            for pos, name in enumerate(dict.fromkeys(t for t in tags if isinstance(t, str))):
                c.execute("INSERT INTO tags(name, pos) VALUES(?, ?)", (name, pos))

    def get_tags(self) -> list[str]:
        return [r["name"] for r in self.query("SELECT name FROM tags ORDER BY pos")]

    def count_items(self) -> int:
        return self.query_one("SELECT COUNT(*) AS n FROM items")["n"]

    def get_item(self, item_id: str) -> dict | None:
        row = self.query_one("SELECT data FROM items WHERE id = ?", (item_id,))
        return json.loads(row["data"]) if row else None

    def all_items(self) -> list[dict]:
        """All items, newest ``date_added`` first (undated last, then by id)."""
        rows = self.query(
            "SELECT data FROM items ORDER BY date_added IS NULL, date_added DESC, id"
        )
        return [json.loads(r["data"]) for r in rows]

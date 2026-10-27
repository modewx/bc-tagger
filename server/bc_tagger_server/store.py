"""SQLite state: the items/tags mirror plus local-only data.

Writes go through one connection behind a lock (``tx``); the server's write volume is tiny. Reads outside a
transaction use a small pool of their own connections (WAL lets them run beside a write), so a page load never
waits behind another request's queries or a long write.
"""

from __future__ import annotations

import json
import queue
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

-- Files per root, kept by triggers on every write to files, so the index status never counts them.
CREATE TABLE IF NOT EXISTS file_counts (root TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS file_counts_insert AFTER INSERT ON files BEGIN
    INSERT INTO file_counts(root, n) VALUES(new.root, 1) ON CONFLICT(root) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER IF NOT EXISTS file_counts_delete AFTER DELETE ON files BEGIN
    UPDATE file_counts SET n = n - 1 WHERE root = old.root;
    DELETE FROM file_counts WHERE root = old.root AND n <= 0;
END;
CREATE TRIGGER IF NOT EXISTS file_counts_move AFTER UPDATE OF root ON files WHEN old.root IS NOT new.root BEGIN
    UPDATE file_counts SET n = n - 1 WHERE root = old.root;
    DELETE FROM file_counts WHERE root = old.root AND n <= 0;
    INSERT INTO file_counts(root, n) VALUES(new.root, 1) ON CONFLICT(root) DO UPDATE SET n = n + 1;
END;

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

-- Bumped by triggers on every write to a table, so caches built from it know when to rebuild.
CREATE TABLE IF NOT EXISTS data_versions (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS import_rows_insert AFTER INSERT ON import_rows BEGIN
    INSERT INTO data_versions(name, n) VALUES('import_rows', 1) ON CONFLICT(name) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER IF NOT EXISTS import_rows_update AFTER UPDATE ON import_rows BEGIN
    INSERT INTO data_versions(name, n) VALUES('import_rows', 1) ON CONFLICT(name) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER IF NOT EXISTS import_rows_delete AFTER DELETE ON import_rows BEGIN
    INSERT INTO data_versions(name, n) VALUES('import_rows', 1) ON CONFLICT(name) DO UPDATE SET n = n + 1;
END;

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

-- Release downloads the user started (Phase 4): what each item got, for the import logs.
CREATE TABLE IF NOT EXISTS download_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL,
    item_id TEXT,
    release TEXT,
    full_release INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    message TEXT,
    folder TEXT,
    job_id TEXT,
    at TEXT NOT NULL
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


READERS = 8  # read connections at most (3 file descriptors each)


class Store:
    def __init__(self, path: Path | None = None):
        self.path = path or data_dir() / "server.db"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._local = threading.local()  # .tx: this thread is inside tx() (its reads must see its writes)
        self._readers: queue.SimpleQueue[sqlite3.Connection] = queue.SimpleQueue()
        self._readers_made = 0
        self._readers_lock = threading.Lock()
        self._all_readers: list[sqlite3.Connection] = []
        self._closed = False
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
        if self._conn.execute("SELECT 1 FROM meta WHERE key = 'file_counts_v1'").fetchone() is None:
            # the triggers keep file_counts from now on; count what's there once
            with self.tx() as c:
                c.execute("DELETE FROM file_counts")
                c.execute("INSERT INTO file_counts(root, n) SELECT root, COUNT(*) FROM files GROUP BY root")
                c.execute("INSERT INTO meta(key, value) VALUES('file_counts_v1', 'true')")

    def close(self) -> None:
        with self._lock, self._readers_lock:
            self._closed = True
            for conn in self._all_readers:
                conn.close()
            self._conn.close()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            self._local.tx = True
            try:
                yield self._conn
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            else:
                self._conn.execute("COMMIT")
            finally:
                self._local.tx = False

    def _new_reader(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
        return conn

    @contextmanager
    def _reader(self) -> Iterator[sqlite3.Connection]:
        """A read connection from the pool (made on demand, up to ``READERS``). Inside ``tx`` the reads use the
        transaction's own connection, so they see its uncommitted writes."""
        if getattr(self._local, "tx", False) or self._closed:
            with self._lock:
                yield self._conn
            return
        try:
            conn = self._readers.get_nowait()
        except queue.Empty:
            conn = None
            with self._readers_lock:
                if self._readers_made < READERS and not self._closed:
                    self._readers_made += 1
                    conn = self._new_reader()
                    self._all_readers.append(conn)
            if conn is None:
                conn = self._readers.get()
        try:
            yield conn
        finally:
            self._readers.put(conn)

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        with self._reader() as conn:
            return conn.execute(sql, tuple(params)).fetchall()

    def query_one(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Row | None:
        with self._reader() as conn:
            cur = conn.execute(sql, tuple(params))
            try:
                return cur.fetchone()
            finally:
                cur.close()  # ends the statement, so this connection's next read sees the newest data

    def query_all(self, sql: str, columns: list[str], params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        """``sql``'s rows (as dicts of ``columns``) fetched as one JSON value, in no set order.

        Python's sqlite3 lets go of the GIL for every row it steps through and has to take it back for the next.
        While another thread is busy in Python (scoring, say), each take-back waits its turn, so reading a few
        thousand rows can take seconds. One aggregated row takes it back once."""
        cols = ", ".join(columns)
        row = self.query_one(f"SELECT json_group_array(json_array({cols})) AS j FROM ({sql})", params)
        return [dict(zip(columns, values)) for values in json.loads(row["j"])]

    def version(self, name: str) -> int:
        """How many writes ``name`` has had (kept by triggers; 0 before the first)."""
        row = self.query_one("SELECT n FROM data_versions WHERE name = ?", (name,))
        return row["n"] if row else 0

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
        """Write the items whose data changed (an unchanged one is left alone) and remove ``deleted`` (with
        ``full``: every item not in ``items``). ``{upserted, changed, removed, changed_ids, removed_ids}``."""
        ts = now_iso()
        deleted = list(deleted)
        changed_ids: list[str] = []
        removed_ids: list[str] = []
        with self.tx() as c:
            if full:
                keep = set(items)
                existing = [r["id"] for r in c.execute("SELECT id FROM items")]
                gone = [i for i in existing if i not in keep]
                for i in gone:
                    c.execute("DELETE FROM items WHERE id = ?", (i,))
                removed_ids += gone
            for item_id in deleted:
                if c.execute("DELETE FROM items WHERE id = ?", (item_id,)).rowcount:
                    removed_ids.append(item_id)
            for item_id, item in items.items():
                if not isinstance(item, dict):
                    continue
                data = json.dumps({**item, "id": item_id})
                row = c.execute("SELECT data FROM items WHERE id = ?", (item_id,)).fetchone()
                if row is not None and json.loads(row["data"]) == json.loads(data):
                    continue
                date_added = item.get("date_added") if isinstance(item.get("date_added"), str) else None
                c.execute(
                    "INSERT INTO items(id, data, date_added, updated_at) VALUES(?, ?, ?, ?) "
                    "ON CONFLICT(id) DO UPDATE SET data = excluded.data, "
                    "date_added = excluded.date_added, updated_at = excluded.updated_at",
                    (item_id, data, date_added, ts),
                )
                changed_ids.append(item_id)
        return {"upserted": len(items), "changed": len(changed_ids), "removed": len(removed_ids),
                "changed_ids": changed_ids, "removed_ids": removed_ids}

    def set_tags(self, tags: list[str]) -> None:
        with self.tx() as c:
            c.execute("DELETE FROM tags")
            for pos, name in enumerate(dict.fromkeys(t for t in tags if isinstance(t, str))):
                c.execute("INSERT INTO tags(name, pos) VALUES(?, ?)", (name, pos))

    def get_tags(self) -> list[str]:
        return [r["name"] for r in self.query("SELECT name FROM tags ORDER BY pos")]

    def file_counts(self) -> dict[str, int]:
        """Indexed files per root (kept by triggers: no count over the files table)."""
        return {r["root"]: r["n"] for r in self.query("SELECT root, n FROM file_counts")}

    def count_items(self) -> int:
        return self.query_one("SELECT COUNT(*) AS n FROM items")["n"]

    def get_item(self, item_id: str) -> dict | None:
        row = self.query_one("SELECT data FROM items WHERE id = ?", (item_id,))
        return json.loads(row["data"]) if row else None

    def all_items(self) -> list[dict]:
        """All items, newest ``date_added`` first (undated last, then by id)."""
        items = [json.loads(r["data"]) for r in self.query_all("SELECT data FROM items", ["data"])]
        items.sort(key=lambda it: it["id"])
        dated = [it for it in items if isinstance(it.get("date_added"), str)]
        dated.sort(key=lambda it: it["date_added"], reverse=True)  # stable: ties stay by id
        return dated + [it for it in items if not isinstance(it.get("date_added"), str)]

"""Page loads and timers never touch the music drive, and syncs of unchanged data announce nothing."""

from __future__ import annotations

import json
import os
from contextlib import contextmanager

from fastapi.testclient import TestClient

from bc_tagger_server import filesimport, fsguard, indexer
from bc_tagger_server import service as service_module
from bc_tagger_server.api import create_app

DRIVE = "/Volumes/BctTestDrive"  # never exists: only the (faked) mount table says whether it's mounted
COLLECTION = f"{DRIVE}/Music/Collection"
COMPLETE = f"{DRIVE}/soulseek/complete"


@contextmanager
def no_stat_under(monkeypatch, *prefixes: str):
    """Fail on any stat, lstat, listing or access check of a path at or below one of ``prefixes``."""
    touched: list[str] = []

    def guard(real):
        def call(path=None, *a, **k):
            if isinstance(path, (str, bytes, os.PathLike)):
                p = os.fsdecode(path)
                if any(p == x or p.startswith(x + "/") for x in prefixes):
                    touched.append(p)
                    raise AssertionError(f"touched {p}")
            return real(*a, **k) if path is None else real(path, *a, **k)

        return call

    with monkeypatch.context() as m:
        for name in ("stat", "lstat", "scandir", "listdir", "access"):
            m.setattr(os, name, guard(getattr(os, name)))
        yield touched


def _file_rec(path: str, root: str) -> dict:
    return {**dict.fromkeys(indexer.FILE_COLUMNS), "path": path, "root": root, "root_kind": "owned", "size": 1,
            "mtime": 0.0, "ext": ".aiff", "format": "aiff", "release_dir": os.path.dirname(path), "scanned_at": "now"}


def test_page_loads_never_touch_a_root(make_service, tmp_path, mount_table, monkeypatch):
    internal = str(tmp_path / "soulseek")  # a root on the boot disk
    svc = make_service(tmp_path / "unused")
    svc.settings.update({"owned_root": COLLECTION,
                         "not_owned_roots": [{"path": COMPLETE, "globs": []}, {"path": internal, "globs": []}]})
    indexer._flush(svc.store, [_file_rec(f"{COLLECTION}/A/{i}.aiff", COLLECTION) for i in range(3)])
    mount_table(DRIVE)
    with TestClient(create_app(svc)) as c:
        with no_stat_under(monkeypatch, DRIVE, internal) as touched:
            st = c.get("/api/index/status").json()
            folders = c.get("/api/import/files/defaults").json()["folders"]
            for path in ("/api/health", "/api/settings", "/api/items", "/api/tags", "/api/import",
                         "/api/import/logs", "/api/import/open-rows", "/api/dev/build-id", "/api/jobs"):
                assert c.get(path).status_code == 200, path
        assert touched == []
    roots = {r["path"]: r for r in st["roots"]}
    assert roots[COLLECTION]["mounted"] and roots[COLLECTION]["files"] == 3 and st["files"] == 3
    assert roots[COMPLETE]["mounted"] and roots[internal]["mounted"]  # the boot disk is always there
    assert [(f["path"], f["mounted"], f["exists"]) for f in folders] == [(COLLECTION, True, True),
                                                                          (COMPLETE, True, True)]
    # unplugged: only the empty mount point name on the boot disk may be looked at, never the roots
    mount_table()
    with no_stat_under(monkeypatch, COLLECTION, COMPLETE, internal) as touched:
        st = svc.index_status()
        folders = filesimport.defaults(svc)["folders"]
    assert touched == []
    assert {r["path"]: r["mounted"] for r in st["roots"]} == {COLLECTION: False, COMPLETE: False, internal: True}
    assert [(f["mounted"], f["exists"]) for f in folders] == [(False, False), (False, False)]


def test_mount_table(mount_table, monkeypatch):
    out = ("/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n"
           "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)\n"
           "/dev/disk5s1 on /Volumes/Stationary Backup (apfs, local, nodev, nosuid, journaled, noowners)\n"
           "/dev/disk6s1 on /Volumes/Live on Air (hfs, local)\n")
    assert fsguard.parse_mount_output(out) == {"/", "/system/volumes/data/home", "/volumes/stationary backup",
                                               "/volumes/live on air"}
    mount_table("/Volumes/Stationary Backup")
    assert fsguard.is_mounted("/Volumes/stationary backup/Music/Collection")  # volume names ignore case
    assert not fsguard.is_mounted("/Volumes/BctTestNoSuchDrive/Music")
    assert fsguard.is_mounted("/Users/someone/Music")  # the boot disk
    reads = []
    monkeypatch.setattr(fsguard, "_read_mount_table", lambda: reads.append(1) or frozenset({"/"}))
    monkeypatch.setattr(fsguard, "_mounts", None)
    for _ in range(5):
        fsguard.is_mounted(COLLECTION)
    assert reads == [1]  # read once, then cached


def test_the_real_mount_table_lists_the_boot_disk():
    assert "/" in fsguard._read_mount_table()


def test_a_full_sync_of_unchanged_items_announces_nothing(make_service, tmp_path, monkeypatch):
    svc = make_service(tmp_path / "lib")
    events = []
    monkeypatch.setattr(svc.jobs.bus, "publish", lambda event, data: events.append((event, data)))
    items = {"t1": {"title": "A", "tags": ["must"]},
             "t2": {"title": "B", "tags": ["pool"], "modified_at": "2026-10-20T10:00:00.000Z"}}
    first = svc.sync_items(items, [], full=True)
    assert {k: first[k] for k in ("upserted", "changed", "removed")} == {"upserted": 2, "changed": 2, "removed": 0}
    assert first["membership"]["auto_added"] == 2  # new: into the first collection
    assert svc.sync_tags(["must", "pool"]) == {"tags": 2, "changed": True}
    assert sorted(d["id"] for e, d in events if e == "item") == ["t1", "t2"] and ("tags", {"count": 2}) in events
    assert [d["added"] for e, d in events if e == "collections"] == [2]
    events.clear()
    # the extension's next full sync: the same items and tags
    again = svc.sync_items(json.loads(json.dumps(items)), [], full=True)
    assert {k: again[k] for k in ("upserted", "changed", "removed")} == {"upserted": 2, "changed": 0, "removed": 0}
    assert again["membership"] == {"added": 0, "removed": 0, "skipped": [], "unknown": 0, "auto_added": 0}
    assert svc.sync_tags(["must", "pool"]) == {"tags": 2, "changed": False}
    assert events == []
    # one tag changed, then an item gone: only those are announced
    assert svc.sync_items({**items, "t1": {"title": "A", "tags": ["must", "dub"]}}, [], full=True)["changed"] == 1
    assert [d["id"] for e, d in events] == ["t1"]
    events.clear()
    gone = svc.sync_items({"t1": svc.store.get_item("t1")}, [], full=True)
    assert {k: gone[k] for k in ("upserted", "changed", "removed")} == {"upserted": 1, "changed": 0, "removed": 1}
    assert events[0] == ("item", {"id": "t2"})  # and its membership went: the collection's count changed
    assert [(e, d["action"], d["removed"]) for e, d in events[1:]] == [("collections", "items", 1)]


def test_file_counts_follow_every_write(new_store):
    store = new_store()

    def counted():
        return {r["root"]: r["n"] for r in store.query("SELECT root, COUNT(*) AS n FROM files GROUP BY root")}

    indexer._flush(store, [_file_rec("/r1/a.aiff", "/r1"), _file_rec("/r1/b.aiff", "/r1"), _file_rec("/r2/c.aiff", "/r2")])
    assert store.file_counts() == {"/r1": 2, "/r2": 1}
    indexer._flush(store, [_file_rec("/r1/a.aiff", "/r1"), _file_rec("/r1/b.aiff", "/r2")])  # re-read; moved root
    assert store.file_counts() == counted() == {"/r1": 1, "/r2": 2}
    with store.tx() as c:
        c.execute("DELETE FROM files WHERE root = '/r1'")
    assert store.file_counts() == counted() == {"/r2": 2}
    # a database from before the counts is counted once when opened
    with store.tx() as c:
        c.execute("DELETE FROM file_counts")
        c.execute("DELETE FROM meta WHERE key = 'file_counts_v1'")
    store.close()
    assert new_store(path=store.path).file_counts() == {"/r2": 2}


def test_build_id_is_cached_briefly(make_service, tmp_path, monkeypatch):
    svc = make_service(tmp_path / "lib")
    walks = []
    monkeypatch.setattr(service_module, "_newest_mtime", lambda d, limit=5000: walks.append(d) or 1.0)
    assert svc.build_id() == svc.build_id() == svc.build_id() == "3e8"
    assert len(walks) == 2  # each build folder walked once
    monkeypatch.setattr(service_module, "BUILD_ID_TTL_S", 0)
    svc.build_id()
    assert len(walks) == 4

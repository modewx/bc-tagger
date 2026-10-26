"""Indexer: incremental rescans, deletions, and drives that vanish mid-scan."""

from __future__ import annotations

import os
import shutil

from bc_tagger_server import indexer
from bc_tagger_server.store import Store

from .conftest import write_aiff


def _paths(store):
    return sorted(r["path"] for r in store.query("SELECT path FROM files"))


def _setup(tmp_path):
    root = tmp_path / "music"
    a = write_aiff(root / "A - Album" / "01 - One.aiff", "One", "A", "Album", 1)
    b = write_aiff(root / "B - Other" / "01 - Two.aiff", "Two", "B", "Other", 1)
    store = Store(path=tmp_path / "s.db")
    roots = [{"path": str(root), "globs": [], "kind": "not_owned"}]
    return root, a, b, store, roots


def test_incremental_and_deletion(tmp_path):
    root, a, b, store, roots = _setup(tmp_path)
    first = indexer.scan(store, roots)
    assert (first["read"], first["unchanged"]) == (2, 0)
    again = indexer.scan(store, roots)
    assert (again["read"], again["unchanged"]) == (0, 2)
    b.unlink()
    third = indexer.scan(store, roots)
    assert third["removed"] == 1 and _paths(store) == [str(a)]


def test_interrupted_walk_keeps_rows(tmp_path, monkeypatch):
    root, a, b, store, roots = _setup(tmp_path)
    indexer.scan(store, roots)
    real_walk = os.walk

    def flaky_walk(top, onerror=None, **kw):
        for i, entry in enumerate(real_walk(top, onerror=onerror, **kw)):
            if i == 1:  # the drive disappears after the first folder
                onerror(OSError(5, "Input/output error", str(top)))
                return
            yield entry

    monkeypatch.setattr(indexer.os, "walk", flaky_walk)
    stats = indexer.scan(store, roots)
    assert stats["incomplete_roots"] == [str(root)] and stats["removed"] == 0
    assert _paths(store) == sorted([str(a), str(b)])


def test_missing_root_keeps_rows(tmp_path):
    root, a, b, store, roots = _setup(tmp_path)
    indexer.scan(store, roots)
    shutil.move(str(root), str(tmp_path / "unmounted"))
    stats = indexer.scan(store, roots)
    assert stats["roots"][0]["exists"] is False and stats["removed"] == 0
    assert len(_paths(store)) == 2

"""The opt-in file watcher (default off), with a fake event source."""

from __future__ import annotations

import time

from bc_tagger_server import watcher as w
from bc_tagger_server.watcher import WatchEvent, Watcher

from .conftest import write_aiff


class FakeSource:
    name = "fake"

    def __init__(self):
        self.started_with = None
        self.emit = None

    def start(self, roots, emit):
        self.started_with, self.emit = roots, emit

    def stop(self):
        pass


def indexed(store, path):
    return store.query_one("SELECT title FROM files WHERE path = ?", (str(path),))


def make(store, music, **kw):
    return Watcher(store, lambda: [{"path": str(music), "kind": "not_owned", "globs": []}], debounce=0.01, **kw)


def settle(watcher):
    later = time.monotonic() + 1
    first = watcher.flush(now=later)  # records the size
    second = watcher.flush(now=later + 1)  # size stable: applied
    return {k: first[k] + second[k] for k in first}


def test_off_by_default_and_unavailable_without_a_backend(make_service, tmp_path):
    svc = make_service(tmp_path / "music")
    assert svc.start_watcher() == {"enabled": False}
    assert svc.index_status()["watcher"] == {"enabled": False, "running": False}
    svc.settings.update({"watch_roots": True})
    if w.default_source() is None:  # the watchdog package isn't installed here
        out = svc.start_watcher()
        assert out["enabled"] and not out["running"] and "unavailable" in out["error"]


def test_events_update_the_index(make_service, tmp_path):
    music = tmp_path / "music"
    music.mkdir()
    svc = make_service(music)
    src = FakeSource()
    svc.settings.update({"watch_roots": True})
    status = svc.start_watcher(source=src)
    assert status["running"] and src.started_with == [str(music)]
    wt = svc.watcher
    wt.debounce = 0.01
    new = write_aiff(music / "Artist - EP" / "01 Fresh.aiff", "Fresh", "Artist", "EP", 1)
    src.emit(WatchEvent(str(new), "created"))
    src.emit(WatchEvent(str(music / "Artist - EP" / ".01 Fresh.aiff.part"), "created"))  # ignored
    src.emit(WatchEvent(str(music / "Artist - EP" / "cover.jpg"), "created"))  # not audio
    assert wt.status()["pending"] == 1
    assert settle(wt)["applied"] == 1 and indexed(svc.store, new)["title"] == "Fresh"
    write_aiff(new, "Fresher", "Artist", "EP", 1)  # tags changed
    src.emit(WatchEvent(str(new), "modified"))
    settle(wt)
    assert indexed(svc.store, new)["title"] == "Fresher"
    new.unlink()
    src.emit(WatchEvent(str(new), "removed"))
    assert settle(wt)["removed"] == 1 and indexed(svc.store, new) is None
    assert svc.index_status()["watcher"]["applied"] == 2 and svc.index_status()["watcher"]["running"]
    wt.stop()


def test_unplugged_volume_never_empties_the_index(make_service, tmp_path):
    svc = make_service(tmp_path / "music")
    gone = "/Volumes/bc-tagger-no-such-drive/Music/x.aiff"
    with svc.store.tx() as c:
        c.execute("INSERT INTO files(path, root, root_kind, size, mtime, ext, format, parsed, scanned_at, release_dir) "
                  "VALUES(?, '/Volumes/bc-tagger-no-such-drive/Music', 'owned', 1, 1, '.aiff', 'aiff', '{}', 'x', "
                  "'/Volumes/bc-tagger-no-such-drive/Music')", (gone,))
    wt = make(svc.store, tmp_path / "music")
    wt.emit(WatchEvent(gone, "removed"))
    wt.emit(WatchEvent("/Volumes/bc-tagger-no-such-drive/Music", "rescan", is_dir=True))
    settle(wt)
    assert indexed(svc.store, gone) is not None


def test_rescans_bursts_and_moves(make_service, tmp_path, monkeypatch):
    music = tmp_path / "music"
    svc = make_service(music)
    a = write_aiff(music / "Album" / "01 A.aiff", "A", "X", "Album", 1)
    wt = make(svc.store, music)
    wt.emit(WatchEvent(str(music / "Album"), "rescan", is_dir=True))
    assert settle(wt)["rescans"] == 1 and indexed(svc.store, a)
    # a folder full of new files: one walk instead of one event each
    monkeypatch.setattr(w, "BURST", 3)
    files = [write_aiff(music / "Burst" / f"{i:02d} T{i}.aiff", f"T{i}", "Y", "Burst", i) for i in range(4)]
    for f in files:
        wt.emit(WatchEvent(str(f), "created"))
    counts = settle(wt)
    assert counts["rescans"] == 1 and all(indexed(svc.store, f) for f in files)
    # renamed: the old path goes, the new one comes
    moved = music / "Album" / "01 A (renamed).aiff"
    a.rename(moved)
    wt.emit(WatchEvent(str(a), "moved", dest=str(moved)))
    settle(wt)
    assert indexed(svc.store, a) is None and indexed(svc.store, moved)
    # a full scan is running: nothing is applied, events wait
    wt.paused = lambda: True
    wt.emit(WatchEvent(str(moved), "modified"))
    assert settle(wt) == {"applied": 0, "removed": 0, "rescans": 0} and wt.status()["pending"] == 1


def test_growing_file_waits_until_its_size_is_stable(make_service, tmp_path):
    music = tmp_path / "music"
    svc = make_service(music)
    f = write_aiff(music / "Dl" / "01 Big.aiff", "Big", "Z", "Dl", 1)
    wt = make(svc.store, music)
    wt.emit(WatchEvent(str(f), "created"))
    later = time.monotonic() + 1
    assert wt.flush(now=later)["applied"] == 0  # first look: size noted
    with f.open("ab") as fh:
        fh.write(b"\0" * 1000)  # still being written
    assert wt.flush(now=later + 1)["applied"] == 0
    assert wt.flush(now=later + 2)["applied"] == 1

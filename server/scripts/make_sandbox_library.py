"""Make a throwaway rekordbox library for tests and e2e: a copy of the test library's ``master.db`` with the
playlists you name, so two sandboxes (say a fake "main" and a fake "test") can differ.

    python scripts/make_sandbox_library.py <dest dir> [--playlist "/DJ/Status/Must" ...] [--test-marker]

* ``--playlist``: a playlist to create, as a path from the root; the folders above it are created too.
* ``--test-marker``: add the test-library marker file, so the test guard lets bc-tagger write to it (point
  ``rekordbox_db_path`` there). Leave it out for a fake main (``rekordbox_main_db_path``): the main guard
  refuses a folder that holds the marker.
* The source is ``BCT_TEST_TEMPLATE_DB`` or ``~/Library/Pioneer/rekordbox_test/master.db``, only copied.
* It refuses any destination inside ``~/Library/Pioneer``, on the music drive, or set as rekordbox's library,
  and only replaces a folder it made itself (``.bc-tagger-sandbox`` inside). It works while rekordbox runs
  (rekordbox can't have such a copy open).
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bc_tagger_server import rbguard  # noqa: E402
from bc_tagger_server.config import PROTECTED_VOLUME, TEST_LIBRARY_DIR  # noqa: E402

SANDBOX_MARK = ".bc-tagger-sandbox"
PIONEER = Path.home() / "Library" / "Pioneer"


def make(dest: Path, playlists: list[str], test_marker: bool) -> Path:
    template = Path(os.environ.get("BCT_TEST_TEMPLATE_DB", TEST_LIBRARY_DIR / "master.db"))
    dest = Path(os.path.realpath(dest.expanduser()))
    for protected in (PIONEER, PROTECTED_VOLUME):
        if rbguard.is_within(dest, Path(os.path.realpath(protected))):
            raise SystemExit(f"refusing: {dest} is inside {protected}")
    if dest.exists():
        if not (dest / SANDBOX_MARK).is_file():
            raise SystemExit(f"refusing: {dest} exists and isn't a sandbox this script made")
        shutil.rmtree(dest)
    if not template.is_file():
        raise SystemExit(f"no template library at {template}")
    dest.mkdir(parents=True)
    (dest / SANDBOX_MARK).write_text("made by make_sandbox_library.py\n")
    db_path = dest / "master.db"
    shutil.copy2(template, db_path)
    open_in_rekordbox = rbguard.options_db_path()
    if open_in_rekordbox is not None and rbguard.resolve(open_in_rekordbox) == rbguard.resolve(db_path):
        raise SystemExit(f"refusing: rekordbox is set to use {db_path}")
    db = rbguard.open_master_database(db_path, dest)
    try:
        for path in playlists:
            parts = [p for p in path.strip("/").split("/") if p]
            parent = None
            for name in parts[:-1]:
                found = [p for p in db.get_playlist(Name=name) if str(p.ParentID) == str(parent.ID if parent else "root")]
                parent = found[0] if found else db.create_playlist_folder(name, parent=parent)
            db.create_playlist(parts[-1], parent=parent)
        # pyrekordbox refuses to commit while rekordbox runs; this copy is outside ~/Library/Pioneer and isn't
        # the library rekordbox is set to use, so rekordbox can't have it open
        with mock.patch("pyrekordbox.masterdb.database.get_rekordbox_pid", return_value=0):
            db.commit()
    finally:
        rbguard.close_database(db)
    if test_marker:
        (dest / rbguard.MARKER_NAME).write_text("bc-tagger sandbox test library\n")
    return db_path


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("dest", type=Path)
    p.add_argument("--playlist", action="append", default=[])
    p.add_argument("--test-marker", action="store_true")
    args = p.parse_args()
    print(make(args.dest, args.playlist, args.test_marker))
    return 0


if __name__ == "__main__":
    sys.exit(main())

# bc-tagger local server

Python backend for the bc-tagger local app. It indexes local audio files, matches them to the
items you tagged on Bandcamp, works out what you own on Bandcamp, and exports located tracks to
rekordbox with one playlist per tag. It also serves the JSON API and the built local app
(`../app/dist`).

The shared plan with all decisions and the API contract is
`/Users/alvaroh/Projects/auto-rekordbox/LOCAL_COLLECTION_PLAN.md`.

## Setup

The server uses the shared venv `/Users/alvaroh/Projects/auto-rekordbox/.venv` (Python 3.11):

```bash
uv pip install --python /Users/alvaroh/Projects/auto-rekordbox/.venv/bin/python pyrekordbox mutagen rapidfuzz fastapi "uvicorn[standard]" httpx pytest
```

pyrekordbox 0.5 ships the rekordbox 6.7 database key, so no key download is needed.
Streaming AIFF to the browser needs `ffmpeg` (`/opt/homebrew/bin/ffmpeg`).

`./bct` runs the CLI with that venv (`BCT_PYTHON` overrides the interpreter):

```bash
cd server
./bct --help
```

## Run the server

```bash
./bct serve              # http://127.0.0.1:8765 (port from settings, or --port)
```

- API docs: http://127.0.0.1:8765/docs. The local app is served at `/` from `app/dist/`
  (setting `app_dist_dir`).
- It binds to `127.0.0.1` only. Requests from other origins (anything but `chrome-extension://…`
  and `http://localhost|127.0.0.1:*`) or with a foreign `Host` header get 403.
- State lives in `~/Library/Application Support/bc-tagger/` (override with `BC_TAGGER_DATA_DIR`
  or `./bct --data-dir DIR`): `server.db` (SQLite), `settings.json`, `exports/` (XML),
  `transcode-cache/`.
- Until the extension pushes its data, the items mirror is seeded from the export JSON
  (setting `seed_export_json`). `./bct seed --force` reloads it.

## CLI

```bash
./bct scan                          # index the roots (incremental: unchanged files are skipped)
./bct locate --latest 5             # match the 5 most recent tagged items to local files
./bct locate --ids t283914533,a563830364
./bct export --latest 7 --dry-run   # show what an export would change
./bct export --latest 7             # write the rekordbox test DB
./bct rb-status --tracks            # re-read the DB: folder, playlists, tracks
./bct xml --latest 7                # rekordbox XML fallback
./bct ownership refresh             # fetch owned items with the cookies file
./bct ownership show --latest 20
./bct download --filter "Artist" -n 1 [--dry-run]   # see "Downloader" below
./bct settings [--set key=value ...]
```

`--latest N` means the N most recent items for `locate`, and the N most recent **located** items
for `export` and `xml`. `--all` selects every item. Add `--json` for machine-readable output.

## Settings

`GET/PUT /api/settings` or `./bct settings`. Defaults point at the **test** paths:

| key | default |
|---|---|
| `owned_root` | `…/auto-rekordbox/test-downloads` (downloader layout `<artist>/<year> - <release>/`) |
| `not_owned_roots` | `[{path: …/auto-rekordbox/test-tracks, globs: []}]` (globs are include patterns) |
| `rekordbox_db_path` | `~/Library/Pioneer/rekordbox_test/master.db` |
| `playlist_folder` | `bc-tagger` |
| `match_threshold` / `candidate_threshold` | `0.85` / `0.6` |
| `format_preference` | `aiff, flac, wav, alac, m4a, mp3-320, other` |
| `cookies_file`, `bandcamp_username` | the fresh cookies file, `herrasti` |

`GET /api/settings` also returns `presets.test` and `presets.production` (the
`/Volumes/Stationary Backup` roots) so the settings page can switch between them. Indexing the
production drive is read-only.

## rekordbox write guard

Every write to a `master.db` goes through `bc_tagger_server/rbguard.py`:

1. **Never** the main library: anything inside `~/Library/Pioneer/rekordbox/` is refused, even for
   reading, and so is anything under `/Volumes/Stationary Backup/`. Paths are resolved first, so
   symlinks can't sneak around this.
2. The DB folder must contain the marker file `.bc-tagger-test-library`.
3. If a `rekordbox` process is running, the write is allowed only when `options.json`'s
   `db-path` (the DB rekordbox has open) is a **different** file; then pyrekordbox's own
   "rekordbox is running" check is bypassed for that one commit. If rekordbox has the target
   open, or `options.json` can't be read, the write is refused.
4. A timestamped backup (`<db dir>/backups/master_YYYYmmdd_HHMMSS.db`, last 50 kept) is taken
   before every write. An export first plans with a dry pass; if nothing would change it
   doesn't back up or write at all.
5. DBs are always opened by explicit path; pyrekordbox auto-detection is never used.

To restore, copy a backup over `rekordbox_test/master.db` (rekordbox doesn't have the test DB open
unless you switched to it with the script below).

## How the export works

- A folder named `playlist_folder` at the playlist root, with one flat playlist per tag
  (`must` and `pool` included), ordered like the tag vocabulary.
- Files are referenced in place. `Content` rows are looked up by file path first, so nothing is
  ever duplicated, and they are never deleted. New rows get title/artist/album/genre/label,
  length, bitrate, sample rate, bit depth, year and track number from the file tags. rekordbox
  analyses them (BPM, key, waveform) when you load or batch-analyse them.
- Album tags apply to every track of the album.
- **Managed sync:** each tagged item "claims" (tag, track) pairs. An export of a selection updates
  only the selected items' claims, adds missing entries, and removes an entry only if this tool
  created it and no item claims it any more. Entries you add by hand in rekordbox are left
  alone. Items that aren't located right now are left out of the selection, so an unmounted
  drive doesn't empty your playlists. If you delete a managed entry in rekordbox, the next
  export puts it back; untag the item to drop it.

### XML fallback

`./bct xml …` (or `POST /api/rekordbox/xml`) writes
`~/Library/Application Support/bc-tagger/exports/bc-tagger_<timestamp>.xml` and
`bc-tagger_latest.xml` with the same folder and playlists. In rekordbox: Preferences >
Advanced > Database > rekordbox xml, point "Imported Library" at `bc-tagger_latest.xml`, and
enable Preferences > View > Layout > rekordbox xml. The "rekordbox xml" node in the tree then shows
the folder; drag its playlists into your collection. This works while rekordbox is open and never touches a `master.db`.

## Viewing the test library in rekordbox (you run this, not the tools)

rekordbox always opens `~/Library/Pioneer/rekordbox/master.db`. To look at the test library:

```bash
scripts/rb-switch-library.sh status
scripts/rb-switch-library.sh test    # quit rekordbox first; renames rekordbox -> rekordbox_main, rekordbox_test -> rekordbox
scripts/rb-switch-library.sh main    # quit rekordbox first; switches back
```

It refuses while rekordbox is running and checks the marker file before every rename. While the
test library is active, exports refuse to run (the test DB isn't at `rekordbox_test/` any more).
If you use rekordbox Cloud Library Sync, turn it off before opening the test library.

## Matching

- The indexer reads tags with mutagen and also parses file and folder names (`01 - Title`,
  `07.Artist - Title`, scene names like `01-artist_name-title`, `Artist - Album (Year) [..]`,
  and the downloader's `<artist>/<year> - <release>`).
- Tracks are scored on title (60%), artist (25%) and album (15%) similarity, plus track number
  and the Bandcamp URL from the comment tag. A Bandcamp track URL in the comment is an exact match.
  Titles whose numbers differ ("Part 2" vs "Part 3", "File #1" vs "File #2") never match.
  Compilation titles like "Artist - Title" are split. If the artist clearly differs, a match can only
  be a candidate.
- Album items match whole release folders and expand to every track in the folder.
- Matches at or above `match_threshold` are accepted. If several are within 0.1 of the best (the same
  track in several formats), the format preference picks one, so AIFF beats MP3. Lower scores
  above `candidate_threshold` are kept as candidates to confirm in the UI
  (`POST /api/matches/{id}/confirm|reject {path}`; for albums the path is the release folder).

## Ownership

The extension pushes owned IDs (`POST /api/ownership`). The fallback,
`./bct ownership refresh` or `POST /api/ownership/refresh`, calls Bandcamp's
`collection_summary` with the cookies file and marks every collection entry as owned. A track
counts as owned if it or its album is in the collection. After a full sync from either source,
everything else counts as `not_owned`; before that it's `unknown`. Cookie values are never logged.
Item views carry hints like `owned_but_only_in_not_owned_root`.

## Downloader

`./bct download --filter "<artist or album substring>" -n 1` wraps
`bandcamp-collection-downloader` (jar from setting `downloader_jar`, else
`bandcamp-collection-downloader/build/libs/`, else `~/Scripts/bc-download/…`). It refuses
without a filter, refuses more than 5 releases, and only downloads into `test-downloads/`.
`POST /api/download {filter, number, format, dry_run}` runs it as a job and rescans afterwards.

## Tests

```bash
cd server && /Users/alvaroh/Projects/auto-rekordbox/.venv/bin/python -m pytest -q
```

Export and guard tests run on throwaway copies of `rekordbox_test/master.db` (set
`BCT_TEST_TEMPLATE_DB` to use another template) with generated AIFF files. They simulate
rekordbox running or not running, so they don't depend on whether rekordbox is open.

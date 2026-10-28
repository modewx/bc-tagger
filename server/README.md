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
Streaming ALAC and compressed AIFF-C to the browser needs `ffmpeg` (`/opt/homebrew/bin/ffmpeg`); plain AIFF
plays without it (see Playback).

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
- The log (stderr) has one timed line per request: when it ended, port, method, path, status, the time until
  its response started, size, when it started, and for a stream (events, audio) how long it stayed open. A
  request with no response after 5 s logs every thread's stack once, plus who holds the Store's write lock
  (`slow requests: …`), so a stall names its cause. Open streams never count.
- Reads use their own pooled SQLite connections (WAL), so a page load never waits for another request's
  queries or for a write.

## Playback

`GET /api/files/stream?path=…&src=preview|original` serves an indexed file with Range support (`Accept-Ranges:
bytes`, 206, 416 with `Content-Range: bytes */N`). **A URL's bytes never change under a player:**

- `src=preview`: only the preview (below), which starts at once and needs no music drive, even unplugged. No
  preview (never made, or dropped): 404, never the original. Players fall back to `src=original` themselves.
- `src=original`: only the original (WAV for AIFF, FLAC for ALAC, else the file), even once a preview exists. Its
  first play queues a preview for the next player. `preview=0` is `src=original` that makes no preview (for
  comparing the two).
- No `src`: the preview when there is one; a play (`bytes=0-` and the ranges after it) stays on what it started on.
- `X-Bc-Source` says what was served: `preview`, `wav`, `flac` or `native`. Each representation has its own strong
  `ETag` (`"opus-…"`, `"wav-<size>-<mtime>"`, `"flac-…"`, `"orig-…"`); a Range whose `If-Range` doesn't match gets
  the whole current representation (200), not a slice of it. `Cache-Control: no-cache`.
- A preview being sent is never dropped by the cap, and every request for it counts as a play.

Without a preview, Chrome can't play AIFF or ALAC, so:

1. Uncompressed AIFF (big-endian PCM; AIFF-C `sowt`, `fl32`, `fl64`; 1–32 bits, mono or stereo) is served as a
   WAV made on the fly (`audio/wav`). Its 44-byte header comes from the layout the index keeps
   (`files.aiff_layout`: channels, bits, rate, frames, where the samples start and how many bytes), so it needs
   no read. A range reads only that slice of the samples (whole samples at the ends) and reorders their bytes.
   A request for several ranges at once gets the whole file (200).
   Rows indexed before layouts were kept get one on first play (a few small reads, saved). A file changed
   since it was indexed is indexed again when played. AIFF never goes through the FLAC cache, and FLACs
   of AIFFs cached before are no longer served (clearing `transcode-cache/` frees them).
2. Anything else (ALAC, compressed AIFF-C, AIFF with more than two channels) is transcoded once to FLAC with
   ffmpeg into `transcode-cache/` (2 GB, least recently played dropped first).

Item views give each located file `duration` (seconds), `sample_rate`, `bits`, `channels` and `preview` (a
preview exists) from the index (`local.best` for a track, `local.best.tracks[i]` for a release; a release's own
`preview` is true when all its tracks have one). Null where the index doesn't know. `channels` is filled when a
file is (re)indexed, or for AIFF when first played.

### Previews

Opus 96 kbps in WebM (cues at the front, so it seeks) under `<data dir>/previews/`, one per AIFF/ALAC file, for
the version (size, mtime) it was made from. About 4 MB for 5 minutes, so 3.5 GB holds about 850 tracks.

- **Made only by work you started**, which is also the only time they read the drive:
  - in the background, at most two encodes at a time, each reading its file: an import commit (the files its rows
    are located to), a finished download, a first play (3 s after the stream starts; not with `preview=0`);
  - a **build** (`POST /api/previews/build`), everything or a selection, as a pipeline made for a hard disk: one
    reader reads each file once, whole, in path order (a release's files together, so the head barely seeks) into a
    queue of at most 3 files / 300 MB; `preview_build_parallel` encoders (default: the cores but two) take them
    through stdin (ALAC, which needs seeking, through a copy on the internal disk). Only the reader touches the
    drive, and background encodes wait while a build runs.
  - Page loads and timers only read the `previews` table. Encodes run under `nice`.
- **Kept to `preview_cache_gb`** (default 3.5; 0 turns them off), at `preview_bitrate_kbps` (default 96; new
  previews only): the least recently played go first, at once when the setting is lowered. **Never written when the
  internal disk would drop below 2 GB free**: that preview is skipped and the status counts it.
- `GET /api/previews/status` → `{count, bytes, cap_bytes, free_bytes, min_free_bytes, kbps, building, queued, batch,
  skipped_low_space, last_skip}`; `batch` is null or the running build's progress (below) with its `job_id`.
- `POST /api/previews/build {all: true}` or `{ids: [...]}`, plus `dry_run: true` for only the plan → `{plan}` or
  `{job_id, plan}`; 409 while a build runs, 400 without exactly one of `all`/`ids`.
  - `plan`: `{files, native, already, missing, needed, planned, left_out, needed_bytes, planned_bytes,
    left_out_bytes, source_bytes, audio_hours, fits_cap, fits_space, cap_bytes, used_bytes, free_bytes,
    min_free_bytes, kbps, parallel}`. Files that need a preview are taken in collection ("#") order up to the cap and
    the free-space guard; the rest are `left_out`. Ones with a preview are skipped, so a build resumes.
  - Progress (SSE `job`, kind `previews`): `{current, total, message, built, failed, skipped, bytes_read,
    bytes_total, read_mb_s, eta_s, current_file, encoding, queued, elapsed_s}`.
  - Result: the plan plus `{built, failed, skipped, cancelled, not_built, dropped, stopped, errors: [{path, status,
    reason|error}], bytes_read, read_mb_s, elapsed_s}`. A file that fails is listed and the build goes on;
    `stopped` says why reading stopped early (e.g. "music drive not mounted").
  - `POST /api/previews/build/<job_id>/cancel` → `{job_id, cancelled}`: the files being encoded finish, nothing new
    is read or started.
- `DELETE /api/previews` → `{deleted, bytes}` deletes them all (and stops a build).
- SSE `preview` `{path, preview: true, bytes}` when one is made, `{path, preview: false}` when one is dropped
  (`skipped: "low_space"` when it wasn't made), `{cleared: true}` after a delete.

## CLI

```bash
./bct scan                          # full scan of the roots (manual; incremental: unchanged files are skipped)
./bct index-status                  # last full scan, per-root state, quick-scan result, rescan hints
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
./bct rb-restore                    # list backups of the test DB
./bct rb-restore master_YYYYmmdd_HHMMSS.db   # restore one (guarded; current DB backed up first)
./bct match-report [--out FILE]     # match-quality numbers + a sample to spot-check
```

`--latest N` means the N most recent items for `locate`, and the N most recent **located** items
for `export` and `xml`.

### Keeping the index current

- `./bct scan` (the app's **Rescan drive**) is the **full** scan: it walks every root (about a minute for
  ~41k unchanged files on the USB drive, ~30 minutes the first time). It only runs when you ask.
- `locate`/`export`/`xml` run a **quick** scan first (`--scan quick`, the default): only audio files created
  or changed since the selected items' tag dates minus `quick_scan_margin_days` (default 2), found with
  Spotlight (`mdfind`, when `mdutil -s` says indexing is on) plus a walk into recently modified folders.
  A new download is usually close to its tag date, so this finds it in a few seconds. `--scan none` uses the
  index as is; `--scan full` runs the full scan first.
- The quick scan can miss files added deep inside folders that didn't otherwise change (when Spotlight is
  off or hasn't indexed them yet), and old files that were never indexed. `./bct index-status` (or
  `GET /api/index/status`) says when a full rescan is worth it: never scanned, a root missing or interrupted
  at the last full scan, or the last full scan older than `full_rescan_hint_days` (default 30).
  The status never touches the music drive: a root's `mounted` comes from the kernel's mount table (a root on
  the boot disk always counts as mounted), and its `files` count is kept by triggers on the index.
- When several copies match equally well, the one created closest after the item was tagged wins.
- **Opt-in file watcher** (`watch_roots`, default off): while `bct serve` runs, file events from the roots
  update the index within seconds (debounced until the size is stable; a file leaves the index only when its
  volume is mounted and it's gone). It needs the `watchdog` package; without it the watcher reports itself
  unavailable in `GET /api/index/status` → `watcher`. History replay across restarts is designed in
  `docs/fsevents-watcher.md` but not built. `--all` selects every item. Add `--json` for machine-readable output.

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
| `downloads_dir` / `download_format` | `""` (= the owned root; must be inside an owned root) / `aiff-lossless` |
| `download_parallel` / `download_timeout_s` | `4` (1–8 parallel downloads per tool run) / `180` (≥ 30; the tool's `--timeout`) |
| `lookup_source` | `bandcamp` (`musicbrainz`: hints only, no Bandcamp requests; `both`) |
| `import_log_dir` | `""` (= `<data dir>/import-logs`; never inside a root or on the music drive) |
| `bandcamp_request_interval_s` | `1.0` (≥ 0.1; the server's pace for Bandcamp lookups) |
| `bandcamp_browser_concurrency` / `bandcamp_browser_spacing_ms` | `2` / `400` (for the extension's own fetches) |
| `watch_roots` / `watch_debounce_seconds` | `false` / `3` |
| `last_browse_dir` | `""` (the folder of the last file picked by hand for an import row) |

`GET /api/settings` also returns `presets.test` and `presets.production` (the
`/Volumes/Stationary Backup` roots) so the settings page can switch between them. Indexing the
production drive is read-only. `extra_roots` (`[{path, globs, kind}]`) adds more roots of either
kind, e.g. the test folders next to the production preset. Settings changed by one process (CLI or
server) are picked up by the others.

If a drive is unmounted, or disappears in the middle of a scan, its files stay in the index (they
show as located but can't be streamed or exported until the drive is back). Only a complete walk of
a mounted root drops files that were deleted.

**Nothing is ever written onto an unplugged drive.** With the drive unplugged, `/Volumes/<name>` is just a
folder on the internal disk (and macOS would later mount the real drive as "<name> 1"). Every write into a
root (downloads and the downloader's folders, XML output, rekordbox backups and commits, the match report)
first requires the volume to be mounted and the root to exist; folders are only created below an existing
root. The refusal reads "music drive not mounted: /Volumes/<name> (plug it in; nothing was written)".

## Collections (Phase 8)

Items belong to collections: id 0 "Collection" (what the extension tags into) and any the user creates. Membership is
explicit (`collection_items`); an item can be in several or in none (it still shows in All). Tags, location,
ownership, previews and rekordbox stay per item.

- **Migration (once, at start):** every existing item (the Bandcamp mirror, unacked pending adds, Other items) joins
  collection 0 with its "#" as `pos`. Running it again adds nothing.
- **Who joins where:** the extension says where its items go: `POST /api/sync/items` takes `membership: [{op:
  "add"|"remove", collection_id, ids}]`, applied in order in the sync's transaction after the items. A new item that's
  then in no collection (no op named it, an op's collection was gone, or an older extension sent none) joins the
  **first collection** (lowest `pos`, then id; today "Collection"); one an import's pending add put somewhere stays
  there. The response's `membership: {added, removed, skipped: [{index, op, collection_id, reason}], unknown,
  auto_added}` says what happened; skipped ops are done with (their collection is gone). An import commit (`POST /api/import/<id>/commit {collection_id}`, default 0,
  chosen at commit) puts every committed row's item into that collection only, in row order (merged items are
  copied; they stay where they were).
- **"#":** collection 0's `pos` is the item's `order` (the extension's and imports' numbering); other collections
  number items as they join. `GET /api/items?collection=<id|all>` (default all) sorts "#" by that collection's
  `pos`; All by collection 0's, then by when items joined a collection, then items in none.
- **API:** `GET /api/collections` → `[{id, name, pos, count, created_at}]` by `pos`; `POST /api/collections {name}`;
  `PATCH /api/collections/<id> {name?, pos?}`; `DELETE /api/collections/<id>` (memberships only; 409 for 0);
  `POST /api/collections/<id>/items {ids}` → `{added, already, unknown}` (a copy); `DELETE …/items {ids}` →
  `{removed}`. Every item view has `collections: [ids]`. Names are unique (any case), trimmed, up to 100 characters.
- **Events:** SSE `collections` `{action: created|renamed|reordered|deleted|items, id, collection?, added?, removed?,
  version}` from every path that changes the list or membership (the API, import commits, the extension's sync), and
  `item` `{id}` for each membership change.
- **For the extension:** `GET /api/collections/membership` → `{version, collections, members: {"<id>": [item ids by
  "#"]}}` in one read (15 KB for 1,090 members). `collections_version` (in `GET /api/health`, one row) goes up on any
  change to the collections or their members, whatever the path (triggers), and only then.

## Items: "#", dates and sorting

`order` is an item's "#": an integer from 1, one sequence across both collections, kept where the item lives.
The extension numbers Bandcamp items and syncs them, and the server stores and returns what it sends. Import
commits number every new item (pending adds and new `other` items), in row order, after `max_order`. Merges
keep their number, and a retry after a partial commit carries on from there. `other` items from before this
change are numbered once at startup, oldest first. `max_order` (also in `GET /api/health`) is the highest
number in use across the mirror, unacked pending adds and `other` items. It's never less than the number of
mirror items, so the extension can number its own items 1..N without clashing. `GET /api/items` sorts by
"#" by default (`sort=order`, ascending; `order=desc` reverses; ties by id). Items without a number come
last, newest first.

`GET /api/items?sort=modified_at|date_added&order=desc|asc` sorts both collections by that date; items
without it count as earlier than any date (last when newest first). `modified_at` (ISO, the extension's
`…Z` milliseconds) is set by app tag edits (also carried in the queued edit), `other`-item tag changes,
import commits (new items, every merge, pending adds) and, on extension sync, when the tags changed and the
extension's date isn't newer than the server's (unchanged tags keep the later date).

## rekordbox write guard

Every write to a `master.db` goes through `bc_tagger_server/rbguard.py`. With the default target
(`rekordbox_target: "test"`):

1. **Never** the main library: anything inside `~/Library/Pioneer/rekordbox/` (or `rekordbox_main/`
   while the test library is switched in) is refused, even for reading, and so is anything under
   `/Volumes/Stationary Backup/`. Paths are resolved first, so symlinks can't sneak around this.
2. The DB folder must contain the marker file `.bc-tagger-test-library`.
3. If a `rekordbox` process is running, the write is allowed only when `options.json`'s
   `db-path` (the DB rekordbox has open) is a **different** file; then pyrekordbox's own
   "rekordbox is running" check is bypassed for that one commit. If rekordbox has the target
   open, or `options.json` can't be read, the write is refused.
4. A timestamped backup (`<db dir>/backups/master_YYYYmmdd_HHMMSS.db`, last 50 kept) is taken
   before every write. An export first plans with a dry pass; if nothing would change it
   doesn't back up or write at all.
5. DBs are always opened by explicit path; pyrekordbox's auto-detection is switched off before
   every open.

To restore: `./bct rb-restore <backup>`. It refuses if any process has the DB open, backs up the
current DB first, and resets this data dir's export tracking for that DB.

## Writing to your main collection

Two separate settings in Settings → Rekordbox:

- **Which library** (`rekordbox_target`: `test` | `main`): a free choice. With `main`, the playlist tree, the
  mapping marks and every export/transfer dry run read your main library (always a snapshot copy, never the
  live file).
- **Permission to write to main** (`allow_main_writes`, off by default: "Allow bc-tagger to write to my main
  rekordbox collection"). With `main` chosen and this off, the dry run shows the blocker `main_writes_locked`
  ("Writing to your main collection is locked: tick …"), `can_confirm` is false and a confirmed export is
  refused (409); unticking it never switches the library back to `test`. Settings' `derived.main_writes_locked`
  says so too.

`./bct settings --set allow_main_writes=true --set rekordbox_target='"main"'` sets both.

`GET /api/rekordbox/playlists?target=test|main` and `POST /api/rekordbox/resolve` (`?target=` or `target` in the
body) read that library whatever the saved target is, so Settings can show the one picked before Save; main is
read through its snapshot copy, never written. For tests and e2e, `python scripts/make_sandbox_library.py <dir>
[--playlist /A/B …] [--test-marker]` makes a throwaway copy of the test library with the playlists you name
(refused inside `~/Library/Pioneer` or on the music drive).

**Before your first export, make your own backup in rekordbox: *File → Library → Backup
Library*.** bc-tagger also copies `master.db` and `masterPlaylists6.xml` to
`~/Library/Application Support/bc-tagger/backups/main/<timestamp>/` before every write (last 5,
~300 MB each), but a rekordbox backup is the one rekordbox itself can restore.

- **Quit rekordbox first.** Writes are refused while any rekordbox process runs.
- The main library must be switched in: if `~/Library/Pioneer/rekordbox` holds the test library
  (marker file), writes are refused; run `scripts/rb-switch-library.sh main`.
- **Every export is a dry run first.** It shows the playlists/folders to create, the tracks to
  add and the entries to add/remove per playlist, plus a confirmation token. Only
  `./bct export … --confirm <token>` (or the app's confirm button) writes, and only if nothing
  changed since the dry run (same plan, library files untouched, within 15 minutes, once).
  The dry run reads a copy of your library, never the live file.
- Existing tracks (`Content`) are never modified; only files rekordbox doesn't have yet are added
  (matched by path, Unicode-normalized). Entries you put in playlists yourself are never removed;
  bc-tagger only removes entries it added. Playlists are never deleted.
- `masterPlaylists6.xml` gets the new folders/playlists, and only the playlists the export changed
  get a new timestamp (verified on a copy of your library: 4 added, 5 updated, 1,549 untouched).
- Both are only in settings; no request can point an export at another library or skip the permission.
  Unticking the permission keeps `main` chosen (reads go on; writes stop at the dry run).

### Tag → playlist mapping

`tag_playlist_mode: "auto"` (default): each tag → a playlist named like the tag inside
`playlist_folder` (default `bc-tagger`). `"custom"`: `tag_playlist_map` maps a tag to one or more
playlists; a tag with no playlists isn't exported.

| name | means |
|---|---|
| `Must` | `/<playlist_folder>/Must` |
| `Genres/Acid` | `/<playlist_folder>/Genres/Acid` |
| `/DJ/Status/Must` | that path from the library root |

Missing playlists and folders are created. A name that resolves to a smart playlist, a folder,
or two entries with the same name is an error, and nothing is written. A track gets the union of
the playlists of all its tags. `./bct rb-playlists` (or `GET /api/rekordbox/playlists`) lists the
target's playlist tree; `POST /api/rekordbox/resolve` says which names exist or will be created.

## How the export works

- Playlists per the mapping above (auto: a folder named `playlist_folder` at the playlist root
  with one flat playlist per tag, `must` and `pool` included, ordered like the tag vocabulary).
- Files are referenced in place. `Content` rows are looked up by file path first, so nothing is
  ever duplicated, and they are never deleted. New rows get title/artist/album/genre/label,
  length, bitrate, sample rate, bit depth, year and track number from the file tags. rekordbox
  analyses them (BPM, key, waveform) when you load or batch-analyse them.
- Album tags apply to every track of the album.
- **Managed sync:** each tagged item "claims" (playlist, track) pairs. An export of a selection updates
  only the selected items' claims, adds missing entries, and removes an entry only if this tool
  created it and no item claims it any more. Entries you add by hand in rekordbox are left
  alone. Items that aren't located right now are left out of the selection, so an unmounted
  drive doesn't empty your playlists. If you delete a managed entry in rekordbox, the next
  export puts it back; untag the item to drop it.
- **No duplicate entries:** a track is never added to a playlist twice. Exporting it again, from a second
  import for example, finds its entry (or the one you added yourself).
  - **Same song, another file:** a different file of the same song isn't added either. This covers a FLAC
    when the AIFF is in, or your own copy. Same song means the same artist and title (case, punctuation and
    "(Original Mix)" ignored) with lengths within 2 s; an unknown title, artist or length never matches.
  - **In the diff:** these are listed under `entries_same_song` as
    `{playlist, content_id, path, title, artist, reason: "same_song_other_file",
    message: "already in playlist (other file)", existing: {content_id, path, title, artist}}`.
    `per_playlist[].same_song` counts them, and a `same_song_other_file` warning gives the total.
  - A file skipped this way for every playlist isn't added to the library either. `content_id` is then
    `null`.
  - `add_same_song: true` in `POST /api/rekordbox/export` (on both the dry run and the confirm) adds them
    anyway.

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

## Downloading owned releases

For an owned item (or import row) that isn't located, `POST /api/download {ids: ["t123", "<batch>:<n>"]}`
runs the user's `bandcamp-collection-downloader` (branch `bc-tagger-item-id`, `./gradlew fatJar`, JDK 11) with
`--item-id a<id>|t<id>`: exactly that collection item, respecting the tool's cache unless `force`. Tracks map
to their album when the album is owned. Releases are deduped and given to one tool run together: several
`--item-id`, `--jobs=<download_parallel>` (default 4, like the tool's own default; at most one per release),
`--timeout=<download_timeout_s × 1000>` (default 180 s; the tool's own 50 s restarted whole zips on slow
stretches), `--skip-hidden`, the app's User-Agent and the cookies file. Long lists go in runs of 3 ×
`download_parallel`, and there's still one download job at a time. Files go into `downloads_dir` (empty: the
owned root; refused unless inside an owned root), in `download_format` (default `aiff-lossless`). After each run
its folders are indexed and the affected items and rows are located. Bandcamp's bot check or a rate limit stops
the rest. The tool's parallel output ("[pool-1-thread-N] …", "Progresses: [thread] x % || …") is tied to our
releases by the "Found release" title. If a title matches none of ours, every folder that run wrote is indexed
and the item is checked by locating it.
`full_release: true` ("Download Full Release") fetches the whole album/EP of each track, when that release is
owned; without it ("Download File") a track bought alone is fetched by itself. Item views say what's possible
(`owned.track_owned`, `owned.album_owned`, `owned.full_release`). If the tool's cache says a release was
downloaded before but its files aren't in the index (moved or deleted), it is fetched again once
(`--force`). Progress is per release, "downloading 42 %" (SSE `download` events carry `percent`); the job's
line lists every release in flight ("Album A: downloading 42 % · MSP01: retry 1/3: read timed out"). A retry
names its reason in plain words ("read timed out", "HTTP 503", else the exception), and a release that needed
retries ends "downloaded (after 1 retry: read timed out)".
`dry_run: true` answers the plan (destination, releases, per-item state) without downloading.
Only the user's clicks download into the real Collection; tests and e2e use the stub
(`BC_TAGGER_DOWNLOADER_STUB=server/tests/fixtures/stub_downloader.py`).

`./bct download --filter "<artist or album substring>" -n 1` (agents) still wraps a filtered run, at most 5
releases, into `test-downloads/` only.

## Importing track lists

`POST /api/import {file, default_tags}` takes a `bc-tagger-import/1` file (format and reading rules:
`annotations-import-rules.md`) and runs a job that, for each row:

1. checks the collection: `existing_id`, the row's id, then normalized artist + title (untitled
   tracks and vinyl sides by album + track number). Rows already there are Bandcamp rows whose tags
   are merged on commit; they cost no requests.
2. reads the file's `bandcamp_url` when there is one (a release page: the track is picked from its
   tracklist), else searches Bandcamp's public autocomplete. The search answer (id, URL, names, art)
   is enough to import; the track page (`data-tralbum`) is only fetched by the optional
   `POST /api/import/<id>/details` job. Requests come from this server one at a time, every
   `bandcamp_request_interval_s` seconds (default 1.0, at least 0.1; read before every request; start to start, so an answer's latency isn't added), with the app's own
   User-Agent `bc-tagger/0.1 (personal music collection app; …)` (`bc_tagger_server.USER_AGENT`), and are cached for 30 days in `http_cache`. HTTP 429: `Retry-After` is
   honored, else it waits 30, 60, 120 s; still limited, the batch pauses ("Bandcamp is rate-limiting;
   try again later") until `POST /api/import/<id>/resume`. Bandcamp's bot check ("Client Challenge")
   stops the batch's lookups for good (and every batch's for an hour); it is never cached, retried or
   worked around. There is no HTML-search fallback (it only ever returns the bot check). `POST /api/import` answers with an estimate ("~120 lookups ≈ 5 min").
3. quick-scans files added since the last full scan, then locates the row in the file index;
   `match_by_track_num` rows match by album + track number.

`BC_TAGGER_BANDCAMP=off` turns Bandcamp requests off; `BC_TAGGER_BANDCAMP_FIXTURES=<file or dir>` serves
recorded answers only (tests and e2e; `server/tests/fixtures/`); `BC_TAGGER_BANDCAMP_OFFLINE=1` uses the
server's own cache only.

Many rows at once (select all): `PUT /api/import/<id>/rows {ns: [n, …], changes: {checked?, tags?}}` →
`{updated, rows: [{n, checked, tags}]}`. Every row or none (one transaction, with the batch's counts), one `import`
event `{phase: "rows", ns, current, total}`; an unknown `n` is a 404 before anything changes. `tags` become those
rows' own list, as for one row.

Rows below the threshold keep up to three candidates to pick (`PUT …/rows/<n> {choose}`). A row the
search misses can be linked from the extension to the Bandcamp page the user has open
(`POST /api/import/<id>/rows/<n>/link {item}`; `POST /api/import/link-candidates {item}` says which
rows fit that page). For a whole Bandcamp page, `POST /api/import/link-candidates {items: [{item, page_url?}, …]}`
returns `{results: [[candidate, …], …]}` in the order sent (up to 1,000 items). At most two run at once, waiting
ones hold no worker thread, identical requests in flight are answered once, a request the extension gave up on
is skipped, and answers are cached until an import row changes. On commit, Bandcamp rows go to the extension's pending-adds queue and the rest
to the server's `other` collection with Bandcamp/Discogs/YouTube links. Each committed row that is located gives
its item that location right away (new items always; a merged item only if it wasn't located already, or the row
confirms it), with SSE `item` events, so the collection shows it located without a Locate (`items_located`).
The commit result lists
`item_ids {added, merged, other_added, other_merged}` (every committed row's item, also those an earlier, stopped
attempt committed), `selected` and the `modified_at` it stamped, so the collection page can select exactly what the
import added or merged and sort it to the top. `GET /api/import/last-committed` → `{batch_id, name, kind,
committed_at, item_ids, by_outcome}` gives the newest committed batch's items in row order ("Select last import";
nulls before the first commit).

More import options:

- **Look up in my browser** (`POST /api/import {…, lookup: "browser"}`): the server runs its own lookup code
  against its cache and hands every missing request to the extension (`GET /api/import/<id>/lookups`), which
  fetches it in the user's Chrome and posts the answer back (`POST …/lookups`). A bot check stops, HTTP 429
  pauses (`resume`); either way the batch becomes ready to review.
- **MusicBrainz** (`lookup_source`): `musicbrainz` searches recordings (≤ 1 request/s, the app's User-Agent)
  and uses their releases' Bandcamp/Discogs links as hints, with no Bandcamp request; `both` asks Bandcamp
  first and MusicBrainz for the misses, reading the Bandcamp page its release links to.
- **Default tags to all rows** (`default_tags_all`, or `PUT /api/import/<id>/default-tags {tags, all}` on an
  open batch, reversible: rows remember `default_added`).
- **Re-locate** (`POST /api/import/<id>/locate {rows, scan}`, `POST …/rows/<n>/locate`), **pick a file by hand**
  (`PUT …/rows/<n> {path}`, with `GET /api/fs/list` to browse the roots and `GET /api/index/search`), and
  **reopen** a batch after a restart (`GET /api/import` gives each batch's `step`, `progress`, `job`,
  `resumable`; a batch caught mid-lookup becomes `interrupted` and `resume` finishes it from the cache).

### Import from Files

`POST /api/import/files {folders: [{path, since}], lookup, default_tags, default_tags_all, name?}` makes a batch
(`kind: "files"`) from the audio files added to folders since a date. It's the same kind of batch as a JSON
import: rows, review, commit, log (`source: "files"`), `modified_at` and "#".

- **Checks first:** folders must be existing, readable directories. A missing folder, or one on an unplugged
  drive, is refused (400) before anything is written.
- **Scanning (the job):** each folder gets a quick scan, recorded under the configured root that holds it. Then
  it takes the indexed audio files under the folder created (birthtime, else mtime) on or after `since` (a
  `YYYY-MM-DD` local date or an ISO date-time).
- **One row per track:** files in the same release folder with the same name, or the same disc, track and
  title, are one track; the row uses the file `format_preference` ranks first and lists the others in
  `file.formats`.
- **Order:** folders as given, then releases oldest first, then disc and track. Rows are numbered (`line`) in
  that order, and so are the new items' "#".
- **What each row holds:**
  - artist, title, album, track # and year from the tags, else from the file and folder names;
  - `raw`: the file path; `folder` and `folder_index`;
  - `located` already set to the file (`source: "file"`; later locates leave it alone).
- **Matching:** a Bandcamp track/album page URL in the tags is the row's page, read directly with no search.
  Otherwise the chosen lookup runs (server or browser).
- **Already in the collection:** a file located for a collection item (or an album item), a Bandcamp URL of a
  collection item, or the same artist + title makes the row a duplicate, and it starts unchecked.
- **On commit:** the file is confirmed for each new item. When the same track came from two folders, the item
  keeps the better format.
- **Location updates:** collection items that a row's file matches (a row that's a duplicate) but that aren't
  located yet, and weren't located by hand, are listed in `location_updates: [{item_id, path, release_dir, kind,
  n, line, title, artist, checked}]` (count in `stats.location_updates`). The commit locates them to those files
  (an album item to that file's release), **whether or not the row is checked**; the checkbox only decides tags.
  Items already located are never changed. The commit result has `location_updates` (with `applied`, `status`
  and `located_path`) and `located_items`, SSE `item` events fire, and the log lists them.

`GET /api/import/files/defaults` → `{folders: [{path, kind, since, last_run, mounted, exists}], remembered,
default_tags: ["pool"], lookup}`: the owned root and the not-owned `complete` root. Each `since` is the date of
that folder's last files-import (remembered when one is created), else 7 days ago. It only reads, and never
touches the music drive: `mounted` comes from the mount table and `exists` is the same value. A missing folder
is reported when the import starts.

### Import rows straight to rekordbox

`POST /api/rekordbox/export {rows: ["<batch_id>:<n>", …], dry_run, confirm_token}` sends import rows to
rekordbox without adding them to the collection. It's the same job, result, guard and dry-run/confirm rule
(on the main library) as exporting items, with playlists from the rows' tags.

- Rows use the file they're located to, with no scan. Rows that aren't located, and refs that aren't
  import rows, come back in `skipped_items`.
- Each row's playlist claims are its own (claim id = the ref), so a later export of a collection item never
  removes them, and exporting a row never changes a collection item's playlists. Re-exporting a row with new
  tags updates its entries.
- Rows sent for real get `exported: {at, target}`. The result has `rows: true`.
- Sending `rows` together with `ids`/`latest`, or an empty `rows`, is a 400.
- Rows go out with their tags as they are, even before an import's tag-mapping step. Every export result has
  `tag_playlists: [{tag, new, playlists}]` (where each tag goes under the collection's mapping; `new`: not in the
  tag list yet; `playlists: []`: not exported) and `new_tags`.
- An import batch lists `new_tags` (also as `uncreated_tags`), the tags its rows use that don't exist yet, computed
  live until the commit (the preview highlights them). `POST /api/tags/create {tags}`
  creates them now, as a commit would: the server's list, plus queued for the extension. It returns `{created,
  existing, tags}`. Then they can be mapped in Settings (custom mode).

### Import logs

Every commit writes a log to `import_log_dir`: `YYYY-MM-DD_HHMMSS_<batch name>_<batch_id>.json` (local time),
with a Markdown summary beside it (`.md`: counts and a table of rows and outcomes). A commit that stops part
way writes one too (`status: "partial"`, with the error), and so does the retry; rows done the first time are
marked `imported_earlier`. The JSON (`bc-tagger-import-log/1`) has:

- `batch`: id, name, source file, created/committed times, default tags and `default_tags_all`, `lookup`
  (server/browser), `lookup_source`, the tag mapping, new tags and the stats;
- `counts`: `added_to_tagger`, `merged`, `added_to_other`, `merged_into_other`, `unchecked`, `not_imported`,
  `imported_earlier`, `located`, `downloaded`, `total`;
- `rows[]`: line and raw text; the final artist, title and album; `tags`, `tags_from_defaults`, `mapped_tags`
  (`{unknown tag: what it became}`; null for batches mapped before logs existed) and `new_tags`; `outcome`,
  `item_id` and, for merges, `tags_before` → `tags_after`; `match` (source, status, via) and `bandcamp_url`;
  `located` (status, path); `downloads` (each one started for the row, or for its item since the batch
  began: state, message, release, folder).

The commit result names the files (`log`, `log_md`, `log_dir`; `log_error` if it couldn't be written, which
never fails the import), and the batch lists them (`logs`). `GET /api/import/logs` lists them newest first
(name, `logged_at`, batch, status, counts); `GET /api/import/logs/<name>` returns the JSON or the Markdown;
`POST /api/import/logs/reveal {name?}` shows a log in Finder (`open -R`) or opens the folder (requests from
this Mac only).

## Tests

```bash
cd server && /Users/alvaroh/Projects/auto-rekordbox/.venv/bin/python -m pytest -q
```

Export and guard tests run on throwaway copies of `rekordbox_test/master.db` (set
`BCT_TEST_TEMPLATE_DB` to use another template) with generated AIFF files. They simulate
rekordbox running or not running, so they don't depend on whether rekordbox is open.

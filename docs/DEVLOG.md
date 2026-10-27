# bc-tagger dev log

Short notes on what changed, why, and how to run it. The full decisions and API shapes live in
`/Users/alvaroh/Projects/auto-rekordbox/LOCAL_COLLECTION_PLAN.md` (each session's Status section).

## Server (`server/`, branch `claude/rekordbox-backend-354716`)

### How to run

```bash
cd server && ./bct serve --port 8765           # the app's server (default data dir)
cd server && ./bct --data-dir /tmp/dev serve --port 8770   # a throwaway dev server with its own data
cd server && /Users/alvaroh/Projects/auto-rekordbox/.venv/bin/python -m pytest -q
```

Tests never touch Bandcamp, the music drive or a real rekordbox library: Bandcamp answers come from
`server/tests/fixtures/` (`BC_TAGGER_BANDCAMP_FIXTURES`), downloads from the stub
`server/tests/fixtures/stub_downloader.py` (`BC_TAGGER_DOWNLOADER_STUB`), and exports go to throwaway copies of
`rekordbox_test`.

### 2026-10-26

- **Imports (Phase 3):** `bc-tagger-import/1` batches. Lookups go to the collection first, then the file's
  Bandcamp URL, then Bandcamp's autocomplete. They're paced (1 request/s by default) with an honest
  User-Agent, and stop on Bandcamp's bot check. Then tag mapping, review, and commit (pending adds for the
  extension, tag merges, the `other` collection). Why: the user's hand-written track lists, imported without
  retyping.
- **Downloads (Phase 4):** Download an owned release that isn't located. It uses the user's
  `bandcamp-collection-downloader` with an exact `--item-id` (branch `bc-tagger-item-id` of that repo), into
  `downloads_dir`, then locates it.
- **Phase 5 (while the user was away):**
  - Writes onto an unplugged drive are refused ("music drive not mounted"), so `/Volumes/<name>` is never
    created on the internal disk.
  - "Look up in my browser": the extension runs the lookups the server hands it.
  - MusicBrainz as an optional lookup source.
  - Re-locate and pick a file by hand.
  - An opt-in file watcher, off by default.
  - An API end-to-end check on copies: import → one real download into `test-downloads/` → locate → export
    to a sandbox copy of `rekordbox_test`.
- **Phase 6:**
  - `modified_at` on items (import commits, merges, tag edits, sync), sortable, with undated items earliest
    (`/api/items?sort=modified_at`).
  - The commit result lists the added and merged ids, so the collection page can select exactly them.
  - Checked on a copy: sorted by Modified, the newest 20 items were exactly the commit's selection. Exporting
    that selection to a sandbox `rekordbox_test` (Elhwah merged with a new tag → added to
    `/bc-tagger/ritual`) gave 16 entries, 5 new playlists and no errors.
- **Downloads, later that day (user's request):**
  - Progress in plain words: "downloading 42 %", or "retrying 1/3 after: SocketTimeoutException: Read timed out".
    A download had looked stuck on "Retrying (1/3).", but it finished on its second try.
  - When the downloader's cache lists a release whose files are gone, the server downloads it again once
    (`--force`) instead of reporting it as already downloaded.
  - `full_release: true` downloads the whole album or EP a track is on, when that release is owned. Items and
    import rows say what's owned (`track_owned`, `album_owned`, `full_release`), so the app shows Download File
    only for owned items and Download Full Release only where it works.
- **Import logs (user's request: "a log of everything that was imported saved with datetime"):**
  - Every import commit writes `YYYY-MM-DD_HHMMSS_<batch name>_<batch_id>.json` and a Markdown summary beside it,
    to `import_log_dir` (default `~/Library/Application Support/bc-tagger/import-logs/`; refused inside a root
    or on the music drive).
  - For each row it records:
    - what it became (added, merged with tags before → after, other, unchecked);
    - its final tags and which came from the defaults or the tag mapping;
    - how it was matched and its Bandcamp URL;
    - where it was located;
    - downloads made for it.
  - A commit that stops part way is logged too, and so is the retry.
  - Downloads are now kept in a `download_log` table, so the logs can say what each row got.
  - API: `GET /api/import/logs`, `GET /api/import/logs/<name>`, `POST /api/import/logs/reveal`.
- **"#" made explicit (user's request, via B):**
  - `order` is one sequence across Bandcamp items (numbered by the extension) and Other items (numbered by
    the server).
  - Import commits number their new items after everything else, in import order. Merges keep their number.
  - `GET /api/items` sorts by it by default, and `/api/health` gives `max_order` so the extension numbers new
    tags after the import's Other items.
- **Import from Files (Phase 7):**
  - A batch made from the audio files added to folders since a date: by default the Collection and the
    soulseek `complete` folder, each since its last run.
  - One row per track; a FLAC + AIFF pair becomes one row, using the preferred format.
  - Rows are already located to their file; a Bandcamp URL in the tags is read directly. Files already in the
    collection start unchecked.
  - Ordered by folder, then release (oldest first), then track, so new "#" numbers follow.
  - Checked end to end on a dev server with clones of `test-tracks/` and `test-downloads/`:
    - 94 files gave 94 rows; 33 were already in the collection and stayed unchecked;
    - the commit gave the new items "#" 947–998 and wrote the log;
    - an album present as MP3 and as AIFF kept the AIFFs.
  - Location updates (user's addition): collection items the files match that aren't located yet get located
    to those files at commit, checked or not. Located items and hand-picked locations are left alone. On the
    clones with nothing located beforehand, 18 items were located this way.
- **Import rows straight to rekordbox (user's request: "transfer to rekordbox … without adding to collection"):**
  - Selected import rows can be exported to rekordbox (same dry run, confirm and guard; playlists from the
    rows' tags) without joining the collection.
  - Their playlist claims are their own, so a collection export never removes them, and they never change a
    collection item's playlists.
- **Faster downloads (user approved: "parallel downloads setting (default 4, like my script), longer read timeout, and
  show the retry reason"):**
  - Several releases now go to one downloader run with `--jobs=<download_parallel>` (default 4), and the
    timeout is 180 s instead of the tool's 50 s.
  - Each release's progress and retry reason (e.g. "retry 1/3: read timed out") are read from the tool's
    parallel output.
- **Random native crashes fixed (segfault / bus error):** an automatic garbage-collection pass, in any thread,
  freed pyrekordbox/SQLAlchemy reference cycles in the middle of a SQLCipher query.
  - Now automatic collection pauses while any rekordbox database is open, and the last close collects at a safe
    point.
  - Every `MasterDatabase` is opened and closed through `rbguard.open_master_database` / `close_database`.
  - Tests close every `Store` and fail if a rekordbox connection is left open.
  - Before, the full suite crashed on nearly every run; after, 9/9 runs passed (`-q` and `-v`).

### 2026-10-27

- **Page loads no longer wake the music drive (user report: Collection empty for about a minute while the drive
  spun up).** The rule: no drive or online work runs unless the user clicked for it.
  - "Mounted" now comes from the kernel's mount table (`mount`, cached 10 s), not from looking at the folder.
    This covers `GET /api/index/status`, the Import from Files folder list, and the import-logs folder check.
    Whether a root folder exists is checked only by work the user starts (scan, locate, download, import).
  - Files per root are kept in a `file_counts` table that triggers update on every write to the index. The
    status no longer counts 41k rows on each call (about 230 ms).
  - The extension's periodic full sync rewrites and announces only items that changed (it returns `changed`).
    Before, every open tab re-read all items every 15 minutes. The tag list announces only a real change too.
  - The build id (asked every few seconds by each tab) is cached for 2 s.
- **A 45 s stall after the 01:16 rebuild, found and fixed.**
  - What happened: every open tab reloaded at once, and the Bandcamp tabs asked `link-candidates` for every
    item on their pages. Each of those calls parsed all 1,591 open import rows (5.2 MB of JSON) while holding
    the Store's single lock. `/api/items` runs about 5,000 small queries, each needing that lock, so it waited
    behind them. Most of the 40 worker threads sat waiting on the lock, so new requests also waited for a free
    thread.
  - Reproduced on a copy (10 tabs, 40 `link-candidates`, a full sync): 10.5 s, with 36 threads waiting on
    the Store lock in the stack dump.
  - Fixes:
    - Reads use a pool of up to 8 SQLite read connections instead of the write lock. A thread inside `tx`
      still reads through its own connection, so it sees its own writes.
    - `link-candidates`: the open rows are kept slimmed in memory until an import row changes (a trigger-kept
      version). Title normalization is memoized: 128 → 53 ms per call, 0.2 ms when the same item is asked
      again. At most two run at once, and requests the extension already gave up on are skipped.
    - `/api/items` reads locate results, ownership and rekordbox entries once for all items:
      0.13 → 0.07 s, with identical views.
    - The mount table comes from `getfsstat(MNT_NOWAIT)` (0.1 ms, no process spawned); `mount` is the fallback.
  - After the fixes, the same load finishes in 3–5 s, all of it CPU, with light requests under 1 s. A
    normal reload (6 tabs, 15 `link-candidates`, unchanged sync) finishes in 1.2 s.
  - To catch the next one: every request is logged with its time and duration. A request with no response
    after 5 s dumps every thread's stack and the Store lock's owner. Event and audio streams have started
    their response, so they never count.

- **Page loads during lookup bursts (coordinator: 40 `link-candidates` made `/api/items` take 3.2 s):**
  - Cause: a GIL convoy, not worker threads. The `link-candidates` route already waited on its semaphore in
    the event loop, holding no thread.
    - Python's sqlite3 lets go of the GIL around every row it steps through. While two scoring threads were
      busy, each row's take-back waited its turn, so `/api/items`, reading about 7,000 rows (4,751 owned ids),
      finished only when the burst did.
    - In isolation: 1,085 rows took 60 ms alone, 1.4 s next to one busy thread and 3.5 s next to two.
    - A shorter switch interval didn't help the server.
  - Fixes:
    - `Store.query_all` reads many rows as one JSON value (one take-back). It's used by the item list's
      bulk reads, the item mirror, `other` items and pending adds.
    - Scoring memoizes the title and artist variants of rows and hits, plus `numbers`, `strip_feat` and
      `strip_side`: 53 → 19 ms per new page item (128 ms two commits ago).
    - Identical `link-candidates` requests in flight share one answer.
    - New batch form, `{items: [...]}` → `{results: [...]}`, so the extension can ask once per page.
  - On a copy of the live data, `/api/items` during a burst of 40 new page items: 2.8 s → 0.26–0.40 s; a
    batch of 40 answers in about 1 s.
  - A test checks five item loads stay under 0.5 s during a 40-call burst. With row-by-row reads the same
    test takes 0.92–0.95 s and fails.
- **Re-export never duplicates playlist entries (user's request, queued in "Later"):**
  - The same file was already found by its Content row. Tests now cover the user's case on the test library
    and on a main-mode sandbox: the same track from two imports exported in separate runs, and a track the
    user added to the playlist themselves.
  - New: another file of the same song (same normalized artist and title, length within 2 s) isn't added.
    It's listed in the diff as `entries_same_song`, "already in playlist (other file)".
  - A file skipped for all its playlists isn't added to the library. `add_same_song: true` adds them anyway.
- **Playback starts fast and reads only what's played (user's request: "save a cache of file length and other
  metadata, to minimize disk reads"):**
  - Before: the first play of an AIFF (755 of the 813 located items) had ffmpeg read the whole 50+ MB file from
    the music drive and encode it to FLAC before the first byte went out.
  - Now an uncompressed AIFF is served as a WAV made on the fly:
    - The 44-byte header comes from the AIFF layout the index keeps (`files.aiff_layout`), so it needs no read.
    - A range reads only that slice of the samples and reorders their bytes (big-endian to little-endian;
      AIFF-C `sowt` as is; `fl32`/`fl64` as float WAV; 8-bit signed to unsigned).
    - The layout is read at index time (scan, quick scan, Import from Files, the watcher, downloads) with a few
      small reads. Rows indexed before this get one on first play.
    - ALAC and compressed AIFF-C are still transcoded to FLAC.
    - Follow-up (the internal disk had 6.5 GB free): AIFF never goes through the FLAC cache, and FLACs of AIFFs
      cached before aren't served. 64 of the cache's 66 files (2.01 of 2.07 GB) came from AIFF; the cache is
      left as it is until the user decides. A file changed since it was indexed is indexed again when played,
      instead of transcoded. All 802 located AIFFs are plain 16 or 24-bit stereo, so all stream as WAV.
  - Item views give each located file `duration`, `sample_rate`, `bits` and `channels`, from one bulk query:
    no file access.
  - On the live server, for AIFFs not in the FLAC cache, with the drive awake:
    - **Mid-file range (256 KB): first byte 0.76–2.3 s → 0.011–0.067 s**, with 0.019–0.093 s for the whole
      range (including the one-time layout read).
    - **Drive read per first play: 49–115 MB → about 0.3 MB.** The header alone takes 4 ms and reads nothing.
    - A real 58 MB Bandcamp AIFF served whole decodes to exactly ffmpeg's samples.
  - A sleeping drive still adds its spin-up (disk sleep is 10 min) to the first range that reads samples;
    these numbers had the drive awake.

## App and extension (`app/`, `extension/`, `shared/`, branch `claude/local-collection-ui-e8f6f6`)

*(Session B's notes go here.)*

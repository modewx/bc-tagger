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
- **Previews (user decided: "Cap at 3GB"):** Opus 96 kbps WebM copies of AIFF/ALAC files on the internal disk
  (about 4 MB per 5-minute track), played instead of the original when there is one: no drive spin-up, and
  they play with the drive unplugged.
  - Made only by work the user started: an import commit, a finished download, a first play (in the
    background), and a build job for a selection (with progress and cancel, on its own two workers under
    `nice`, so scans and exports don't wait for it). Page loads only read the `previews` table.
  - Capped at `preview_cache_gb` (3), least recently played first. Never written when the internal disk would
    drop below 2 GB free; that's skipped and counted in the status.
  - `preview=0` on the stream always plays the original and builds nothing, so the app can compare the two.
    `X-Bc-Source` says what was served (`preview`, `wav`, `flac`, `native`).
  - Found live right after: a first play's preview was ready 3 s in, and that play's next ranges got the
    preview's bytes (a 200, then 416s past its end), so the track stopped. Now a play stays on what it started
    on: `bytes=0-` starts a play; later ranges keep its source.
  - Live: a preview's first 64 KB of audio in 2–25 ms with nothing read from the drive, against 0.26 s for WAV
    from the awake drive. Encodes take 0.6–3.3 s per track (0.7–5.4 MB). The sleeping-drive case wasn't
    captured: the drive never stayed idle for 11 minutes.
- **Playback froze after a first play (user, import `imp-45e20d7a`):** a seek after the first play's preview was
  ready asked for an offset of the 50 MB WAV and got the 4 MB preview, or a 416; the audio stayed dead. The
  per-play memory of `f780ca2` covered one server process; the rule now holds per URL:
  - `src=preview` serves only the preview (404 without one), `src=original` only the original, even once a
    preview exists. Players choose when they're created and fall back to `src=original` on a 404.
  - Strong `ETag` per representation, `If-Range` honoured (a mismatch gets the whole current representation),
    `Cache-Control: no-cache`.
  - A preview being sent is never dropped by the cap, and each request bumps its last-played time.
- **Preview defaults (user: "Raise the preview cap to 3.5 GB and keep 96 kbps"):** `preview_cache_gb` 3.5 and
  `preview_bitrate_kbps` 96. A stored 3 (the old default) becomes 3.5 (settings version 3).
- The sleeping-drive measurement was dropped: the drive never idled while the user played, and it's unplugged
  now. Nothing here was measured from a sleeping drive.
- **Build all previews (user: a button that converts all tracks, "parallelized for max speed"):**
  `POST /api/previews/build {all: true}` (or `{ids}`), planned first (`dry_run`): what fits the cap and the 2 GB
  guard, in collection order, and what's left out.
  - One reader reads each file once, whole, in path order, into a queue of 3 files / 300 MB; `preview_build_parallel`
    encoders (cores − 2 = 10 here) take them through stdin. The drive sees one sequential reader, never several.
  - Found while measuring: `subprocess.communicate()` feeds stdin 512 bytes per step, holding the GIL each time, so
    10 encoders were slower than 2 (20 files in 49 s vs 33 s). Writing 1 MB blocks: 10.6 s.
  - On 20 local AIFFs (1.47 GB, 137 min; the SSD, not the HDD): 138 MB/s with 10 encoders, 83 with 4, 44 with 2.
    All 800 files (52.7 GB) would take 6.3 min if the drive kept up; from the HDD the drive sets the pace (about
    7 min at 120 MB/s).
- **Select all in an import, saved in one call (coordinator: ticks were one PUT per row, so leaving the page lost
  some):** `PUT /api/import/<id>/rows {ns, changes: {checked?, tags?}}` → `{updated, rows}`. All rows and the batch's
  counts in one transaction, one `import` event. 1,000 rows in one call in a test; a failure at row 500 leaves all
  1,000 as they were.
- **Phase 8, several collections (user: "I need multiple collections … assume this collection is item 0"):**
  `collections` and `collection_items` (explicit membership, collection 0 included); a one-time migration put every
  existing item into collection 0 with its "#" (on a copy of the live data: 1,089 items, the All order identical in
  both directions, `imp-45e20d7a` byte for byte unchanged). The extension's new items join 0; an import commit
  chooses its collection (`collection_id`) and adds there only. Collections API, `?collection=` on the item list,
  `collections: [ids]` on every item.
- **Phase 9, collections in the extension's tagger (server side):** the extension's sync carries membership ops
  (`add`/`remove`, in order, in the sync's transaction); a new item in no collection joins the first collection, not
  a fixed 0; `GET /api/collections/membership` gives the extension its whole copy in one read; `collections_version`
  (triggers) in `/api/health` tells it when to re-read; every membership change sends an SSE `collections` event with
  the version.

## App and extension (`app/`, `extension/`, `shared/`, branch `claude/local-collection-ui-e8f6f6`)

### How to run

```bash
npm run build:app && npm run build:dev   # the local app (served by the server at /) and "Bc Tagger (dev)"
npm run test:e2e                         # Playwright e2e: own profile, server :8767, app in .e2e/app-dist
```

### 2026-10-28

- **Speed of stars and tags** (user: a star took seconds, letters typed after Enter appeared a second later).
  Measured first with `scripts/perf/extension.perf.mjs` (new): a recorded album page, a 1,070-item store
  (1.6 MB), the pre-Phase-9 server like the user's, no network. It compares before Phase 9 (`ab310d9`), `65f65aa`
  and this change, with 1 tab, and with 4 tabs (3 Bandcamp, 1 app) with the Bandcamp tabs' CPU slowed 6×.
  - No multi-second delay showed, and Phase 9 wasn't a measurable regression.
  - The cost was the whole store moving around. Each star or tag change first fetched every item from the worker
    (about 30 ms). Each write then handed every content script and app tab the old and new store through
    `storage.onChanged`.
  - Changes:
    - The content script keeps the page's items in memory (read once with the page). A star or a tag change is
      decided from them at once, and the star is drawn before anything is sent.
    - Pages and the app bridge no longer listen to `storage.onChanged`. The worker, now the one listener, sends
      small notices instead:
      - `itemsChanged {changed, deleted}` (over 200 changes, `reload`: the page reads the store once);
      - `collectionsShown`;
      - `tagsUpdated`;
      - and to the bridge, `tagsChanged` with the tags.
    - The per-widget `console.log`s of the whole store are gone.
  - Tried and dropped: the worker keeping the items in memory with debounced writes. It measured worse: worker CPU
    per star went from 43 to 90 ms and writes landed later, because `chrome.storage.local.set` cost more from a
    timer than inside the message's task.
  - Results, medians of 2 rounds × 3 runs (ms; before Phase 9 / `65f65aa` / this change):

    | | 1 tab | 4 tabs, CPU 6× |
    |---|---|---|
    | star on screen | 42 / 43 / **1** | 66 / 62 / **8** |
    | star written to storage | 129 / 129 / 104 | 153 / 140 / 94 |
    | page CPU per star | 31 / 39 / **8** | 196 / 252 / **45** |
    | page CPU per un-star | 36 / 32 / **8** | 320 / 250 / **66** |
    | worker CPU per star | 50 / 60 / 46 | 46 / 41 / 38 |
    | slowest key while typing | 16 / 16 / 16 | 128 / 104 / 56 |
    | page CPU, a tag + Enter + 5 letters | 56 / 55 / 34 | 622 / 579 / 398 |

  - What's left while typing at 6× is the page's own style, layout and paint, plus chosen's and jQuery's
    visibility and CSS checks. That was already there before Phase 9.
  - Run it (scratch builds pointed at its own server on :8769):
    `PERF_EXT=<e2e build> PERF_APP=<app build> PERF_TABS=4 PERF_THROTTLE=6 node --experimental-websocket scripts/perf/extension.perf.mjs`.

### 2026-10-27

- **Our own player controls** (user: a click on the timeline still needed a second click). On the user's drive the
  metadata takes 1–2 s, and Chrome's native timeline drops a click that lands before it. `shared/collection/
  rowPlayer.js` replaces the native controls (rows, the docked player, both pages): play/pause, a seek bar the page
  hit-tests (a click is an exact fraction, kept until the length arrives, then applied and played; a later click
  replaces it), current / duration, "loading…", space and ←/→ on the bar. The 150 ms dwell stays as a head start.
  Raising `preload` already resumes the fetch, so `load()` is only called when nothing is loading (it made a second
  request). e2e with a stream that answers 1.5 s late (app and extension page): one click at 60% before load starts
  at 60% (fails on 52c107c), a second click replaces it, a click after load seeks at once.
- **Volume; Use previews** (user): the player has a speaker (mute) with a volume slider on hover, one volume and
  mute for all players (localStorage), ↑/↓ on the bar. **Use previews** (by the player; on by default, kept per
  browser): off, local stream URLs get `preview=0` (the server's original instead of its Opus preview, A); a player
  that has started swaps its source at the same moment and keeps playing (`swapSource`), the others when they
  next load. "▶ preview / original / Bandcamp stream" says what the track playing is heard from (the toggle and
  `local.best.preview`). Play/pause are SVG icons (the text glyphs rendered as a square in the docked player).
- **PayPal: the card issuer's currency, never PayPal's conversion** (user: PayPal's page changed, and the old
  automation paid at PayPal's rate: `#one-time-cta` is enabled before any currency is chosen, the old
  `currency-conversion-option-link` is gone, so the "US site" branch paid after 1 s). `paypalCheckout.js`: a state
  machine read from the page (order details trigger → "Available currency options" → the non-USD tab, pressed with
  pointer/mouse events since Radix tabs ignore click, then focus+Enter → "Use <it>", never "Use USD" → Pay), driven by
  a MutationObserver and a 250 ms poll; each step once, retried once after 3 s, then a notice on the page. Pay only
  for a USD order or after the choice when PayPal's rate is gone, once the page held still 1.2 s. Progress in
  sessionStorage by the checkout's token. checkout.js runs it on paypal.com only, the Bandcamp part elsewhere (no
  jQuery any more). Tests: `npm run test:paypal` (a sanitized stand-in with a mousedown-only tab, in-place and full
  loads; 9 tests, ~7 s); the e2e switch test now has a PayPal and a Bandcamp page.
- **Phase 9 e2e under budget** (27.3 s → 19.2 s): one storage write (one push, one wait) to set tracks aside and
  put them back, server checks by id, 100 ms polling in the Phase 9 waits, no fixed settles (popup, timing). The
  "#" collision test still fails without A's max_order fix.
- **Phase 9 merged with A's server** (`0d4791a`: max_order counts collection 0's positions): the extension reads
  `max_order` again when the app forwards a `collections` event that moved the version, so the next "#" it gives
  comes after a track numbered on the server at once. e2e: with a hole in Collection's "#", an unnumbered track
  joins Collection on the server and the next starred track comes after it (fails without A's fix).
- **Phase 9 hardening: no poison queue** (coordinator): the server answers a malformed membership op with 422 and
  writes nothing, items included, so one bad op left in `pendingMembership` would stop all syncing. Ops are now
  checked before they're queued (`membershipOps.js`: add/remove, an integer collection id from 0, item ids) and
  again when read; a 422 with ops attached sends the items again without them, and only if that goes through are
  the ops dropped (console, `bcSyncStatus.droppedMembership`, the popup's server tooltip; the collections read
  again). If the items are refused too, the ops stay and the error is as before. Unit tests: `npm run test:unit`.
- **Phase 9: collections in the extension's tagger** (user; contract in LOCAL_COLLECTION_PLAN.md): the extension
  keeps `collectionsCache` / `activeCollection` / `pendingMembership` (`collectionsStore.js`); membership changes
  are optimistic, queued and sent as `membership` ops with the item pushes (a new item and its collection in one
  write, so one request); refresh on popup open (its single request), on the tick when `collections_version`
  moved, and when the app forwards an SSE `collections` event (with its version) through the bridge. Popup
  dropdown with New collection…; Bandcamp stars per the choice (Set lookups, redrawn from storage.onChanged);
  the bundled page filters by it. "#": items starred into another collection than Collection get `order: null`
  and a number only when they join Collection (fillOrder skips null). Star drawing with 1,100 items: 65–71 ms
  before, 58–67 ms after (median of 5). e2e: 5 tests (~16.7 s).
- **Collections e2e on A's real server** (after the merge of `e422c37`): the route stand-in is gone; the two
  collections tests create, fill, rename and delete real collections (and drop what they made), and the import
  test commits a real track-list batch with `collection_id` (`last-committed` says where it went). The toolbar test
  expects the bar (All, Collection) and Remove hidden in All. Found on the way: the app's `syncNow` (the import page
  asks after a commit) forced a full sync, so an extension with empty storage replaced the server's whole mirror
  (946 items → 0 in an alone run). It's guarded now like the automatic syncs (an empty or much smaller storage only
  upserts); only the popup's "sync" forces.
- **Phase 8: collections, the UI** (user; contract in LOCAL_COLLECTION_PLAN.md, A building the server): `collections.js`:
  the bar at the top (All first, then the collections by `pos`, with counts; kept in localStorage
  `bc_app_collection`, `?collection=` wins and follows a switch), Create Collection / Rename (a name dialog: empty or
  taken can't confirm) / Delete (danger confirm; disabled for 0 and All). The data source reads
  `/api/items?collection=<id>` (plain `/api/items` for All, so routes and older servers see what they did). On the
  selection: Import to Collection (a select: the others; POST …/items → "N added, M already there") and Remove from
  collection (confirm; DELETE …/items; not in All). A Collections chip column, hidden by default outside All
  (`hideColumns` can be a function; `page.refreshColumns()`). The import page: "Import selected … into
  [collection]" (last used, else 0), the commit sends `collection_id`, the hand-over carries it, and the collection
  page opens there; Select last import follows `last.collection_id` when the server gives it. SSE `collections`
  refreshes the bar, `item` the counts. A server without `/api/collections`: nothing of it shows, and the commit
  sends no `collection_id`. All's count is the items shown in All (health's `items` counts the mirror only). The
  start-up selection prune runs only in All. e2e against a stand-in for the contract (routes; the items from a
  snapshot): the bar, create/rename/delete, Import to Collection twice, Remove, kept and `?collection=`, the chips;
  the import picker, its commit body and the page opening in the collection. Alone and in the full suite.
- **Test 95 (Build previews on the e2e server) failed on other machines** (coordinator: "Of all 950 items"): the test
  wrote the kept selection to localStorage right after the page's load event, then reloaded; the app's start-up
  (still running) saved the selection it had read, empty, over it. Not a button bug (it reads the selection when
  clicked). Fixes: the app saves the pruned selection at start only when pruning changed it (another tab's choice
  stays); tests set kept state before the app's scripts run (`storageFirst`: an init script, first load only).
  Alone 3/3 and the full suite pass.
- **Build previews; Settings → Previews** (user, A's API in `960b36c`): Tools ▾ → Build previews runs the dry run
  (`POST /api/previews/build {ids|all, dry_run}`) and shows its plan in a dialog (needed / already / native /
  missing, what's left out and whether the cap or the 2 GB guard, size of the cap, time from `source_bytes` at
  120 MB/s, "an estimate"); then the build, its SSE `job` progress (built/total, MB/s, ETA, file) with Cancel, and a
  summary (built/failed/skipped, cancelled, `stopped`, errors in a `<details>`). Selected items → `ids`; nothing
  selected or filtered → `all`; else the shown ids. 409 or a build running at load: follow it
  (`/api/previews/status`'s `batch`). SSE `preview` (`{path, preview}`, `{cleared}`) updates the items' flags
  (a release's from its tracks) and redraws those rows, so their next players take `src=preview` (one in use
  keeps its source). Settings → Previews: `preview_cache_gb` / `preview_bitrate_kbps` / `preview_build_parallel`,
  the usage (status), Clear previews (`DELETE /api/previews`, asks). e2e: a stubbed build (dialog with left-out,
  progress line, Cancel, errors) and a real one on the e2e server (3 AIFFs + a FLAC from Import from Files; cap 0
  during the commit so it queues none): 3 built, rows play `src=preview`, a lower cap leaves 1, Clear leaves 0.
- **Import ticks never lost** (user: the selection in `imp-45e20d7a`): ticks went one PUT per row (4 at a time),
  so Select all over hundreds of rows took seconds, and a reload meanwhile dropped the rest; a failed save only
  logged. `rowSaves.js`: one request per action (A's bulk `PUT /api/import/<id>/rows {ns, changes}`; 404/405/422:
  per-row PUTs, 6 at once), tags the same way; a journal in localStorage (`bc_import_pending:<batch>`) holds what the
  server hasn't acked, overlaid on every batch read and sent again on open; transient failures (no answer, 5xx)
  retry with backoff (1, 2, 5, 10, 30 s) and show "Not saved yet (…): N rows, trying again in N s. Try now"; a
  refused save (4xx) is dropped and said; `beforeunload` asks while anything is pending; Import selected flushes
  first. The view (Show, sort, scroll) is kept per batch (`bc_import_view:<batch>`). e2e (stub with the bulk form,
  a slow server without it, 503s): Select all on 300 + an immediate reload keeps 300 (without the journal it
  doesn't); one request per action; a failure retries and says so; the view comes back.
- **Drive unplugged** (user ejects the music drive): a local file with no preview now fails at once (the server's
  404 "music drive not mounted"). A Bandcamp item falls back to Bandcamp's stream as before, with the reason in the
  cell's tooltip; an item from another source used to fall through to an empty Bandcamp embed (spinning forever)
  and now shows "File not available (drive not connected)" with ↻ (a click on the cell too) to try the file again.
  The reason comes from `/api/index/status` (the roots' `mounted`, from the mount table; kept 5 s), asked only after
  a failed play (`localUnavailable`; `bandcampFallback` says which rows have a Bandcamp player). e2e: collection and
  import preview, unplugged then plugged back.
- **Stream URLs pin the preview or the original** (user: playback froze after a seek): the first play had the server
  make an Opus preview, and then the same URL served it instead of the ~50 MB WAV; the next seek asked past the
  preview's 4 MB (416) and the player was dead. Local stream URLs now say `src=preview` (previews on and the file's
  `preview` flag, the track's for a release) or `src=original`, decided when a player is made or the toggle swaps
  it; A's server serves exactly that. Nothing else changes a player's URL: an items reload that flips the flag
  re-renders the rows not in use (their new players take the preview) and keeps the one playing. A `src=preview`
  that fails (404, a media error) swaps to the original at the same moment and keeps playing (`localFallbackUrl`;
  `originalOf` keeps the path's encoding, so the url compares equal to `localPlayUrl`'s). The ▶ pill reads the
  player's own `src`. e2e: a two-version stream double (chunked, 416 past the end, 404 for a missing preview);
  with the old bare URLs the seek test times out (the user's freeze).
- **Cached lengths** (user: faster playback): when the server sends a located file's cached `duration`
  (`local.best.duration`, A), the player shows it before anything loads (`0:00 / 5:12`), and a click shows the time
  it'll start at; the file's own length wins once it's in. Without it (Bandcamp streams, an older server), as above.
- **A click on a player's timeline plays from there again** (regression from the hover change): without metadata
  the element has no duration, so the click couldn't seek. Now the metadata loads once the pointer rests on that
  player for 150 ms (cancelled when it leaves), on focus, or when it's pressed (a click that lands too early makes
  the next one seek); passing over rows still loads nothing. Same in the extension's page.
- **Link to import: one request per Bandcamp page** (A's batch form, `3b72a62`): the content script sends the page's
  items in one `POST /api/import/link-candidates {items}` (it used to send one per item, 20–40 at once on album
  pages). Targets added within 300 ms go in the same request.
- **Export dry run: same song as another file** (A's `entries_same_song`): the dialog lists, per playlist, tracks not
  added because the playlist already has the same song as another file, with both paths. **Add them anyway** (off)
  runs the dry run again with `add_same_song` and the write sends it too. A dry run with only such tracks still
  shows the dialog (Export disabled until the box is ticked).
- **Tag editors keep what's being typed** (user bug: after picking a tag, the next letters vanished and the wrong
  tag got picked, on the Collection and the import preview). Picking a tag set off a reload of the row (the
  extension's push → the server's item event; or the batch's import event), and the row's editor got
  `chosen:updated` even when nothing had changed, which rebuilds it: the search text went, the chips jumped into
  tag-list order (a pick is added at the end), and chosen, which picks by option index, could pick another tag. Now a chosen field is redrawn only when its options or selection
  changed, and a field in use (focused or open) gets its update when it's left, so its chips keep the order shown
  while typing; so does a whole-table re-render (items added or renumbered). Not a tag-fetching problem: the tag list loads once and events update it.
- **Chips' x was invisible in the app:** the vendored `chosen.min.css` points its sprite into the extension. The app
  build rewrites it to `/chosen-sprite.png` (the extension's copy is unchanged), and the pages link it with the
  build stamp (`?v=`) so a cached copy isn't kept.
- **Collection loads fast, nothing unasked** (user bug: Settings → Collection showed an empty table for a minute with
  the music drive spinning). Cause (the coordinator, from the server log): Chrome's 6 connections per host were held
  by event streams: Settings had 3, every page 1, hidden tabs included, so `/api/items` waited for a free one.
  - One stream per page (`pageEvents()`); hidden tabs close it and catch up on `resume`; the collection and import
    preview open it after their rows load, and load without waiting for the extension's answer.
  - "Loading collection…" until the rows are in; after 5 s it says the browser may be out of connections.
  - Hover no longer loads a player (it read the drive in the app). The app doesn't fetch art on scroll
    (`autoFetchArt: false`). The extension's 6-hourly ownership check is gone: only Refresh ownership checks.
  - e2e: one stream per page and the hidden/shown catch-up; rows load while the extension's answer is held; no
    `/api/files/stream` on hover; no `fetchPage` on scroll (checked to fail with auto-fetch on); the first sync tick
    doesn't check ownership.

### 2026-10-26

- **Main library, read-only or writable** (user request, A's `main_writes_locked`): Settings → Rekordbox has
  Target library radios (Test / Main, `rekordbox_target`) and, separately, Allow writes (`allow_main_writes`, backup
  dialog). Before, ticking Allow was what switched to Main. The radios reload the Playlists marks from that
  library (`?target=`) before Save; a slower earlier load is dropped. Export and Transfer dialogs on a locked main
  show the blocker with a link to the checkbox, and Confirm stays disabled. The header shows read-only (amber) or
  writes enabled. e2e: two sandbox libraries from `server/scripts/make_sandbox_library.py`, and a locked dry run
  on a copy that's checked unchanged.
- **Shared collection page:**
  - The extension's built-in page and the local app use the same table (`shared/collection/`).
  - Column widths are stored by column id. Adding a column once shifted them onto the wrong columns.
  - **Columns ▾** shows and hides columns per page; Selection comes first; **Modified** sits next to Added;
    Track # is off by default.
  - In windows narrower than 1570 px the app's table scrolls sideways, so Title and Artist keep their width. Tag
    editors are built when their row comes into view, not their cell, because the Tags column can be scrolled off
    to the right.
  - One player per row. Hovering a player that's already playing no longer reloads it (that stopped it).
  - The Artist cell has a copy button at its right edge: "Artist Title".
  - **"#" is explicit** (user request): each item has `order`, one sequence across Bandcamp (numbered by the
    extension) and Other (numbered by the server at import). Before this, "#" was Chrome's storage order (item IDs
    sorted) on the extension page and date added in the app. Items without one are numbered 1, 2, … in storage
    order when the extension updates, skipping numbers already in use. The server numbers imports above its
    Bandcamp item count, so those numbers stay free. A new tag gets max(own, the server's `max_order`) + 1, and a re-tag keeps its
    number. Import → **Set the # order only** restores an order from a file.
  - **Import from Files** (Phase 7, A's API): the Import tab's folder rows come prefilled with dates from each
    folder's last run, with Browse… (a folder picker of the music folders), `pool` and the lookup choice. The
    preview groups rows under their folder's path (`groupBy` in the shared table, in "#" order only), shows a
    FLAC + AIFF pair as one row with "+1", and lists **Locations to update**: collection items that get located
    on commit, ticked or not. The preview's "#" is the row's own place. e2e uses a fixture tree with real file
    dates on the test server.
  - Import preview: **Select all**, **Select new only**, and **Transfer to rekordbox** (A's `rows` export: the ticked
    rows, not added to the collection). Transfer doesn't wait for tags to be created or mapped.
    - The dialog lists `tag_playlists` (new tags and tags that won't be exported are pointed out) with a link to map
      them.
    - New tags (`uncreated_tags` / `new_tags`) are highlighted in the rows' tag editors, in the chips and the
      dropdown (`opts.newTags` in the shared table; they're offered in every row's dropdown). This is the user's
      scope: "just add highlight". Tag creation is unchanged: "Create New Tags" (`POST /api/tags/create`), then
      "Map them to rekordbox playlists →", and Import selected creates them. `#rekordbox/tags=a,b` opens Settings with
      those tags pointed out in the mapping editor.
    - "Located shows – after an import" (user bug): the page mirrors /api/items. The commit didn't save the rows'
      located files for their items, so they read "unknown" until a Locate (A fixed it in `52e045c`). e2e: a files
      import's new items show located right after the commit, on the server and on the page.
    - The reported "lost" tags: neither the editor (a row's own tags are always options), nor the row save, nor a
      reload or the commit dropped them. What was missing: other rows couldn't add a row's new tag, and nothing
      showed which tags were new.
  - Collection toolbar tidied (user request):
    - selection actions first, then Rescan drive, then **Tools ▾** (maintenance, `group: "tools"` in the shared
      toolbar; the extension's page too) and Columns ▾;
    - Locate / Export latest 10 moved to Settings → **Test**;
    - **Select last import** (`lastImport.js`, A's `GET /api/import/last-committed`, easy to remove);
    - the selection is kept in localStorage (`bc_app_selection`): restored on load, items no longer in the collection
      dropped.
  - Rows: Finder-style highlight in the shared table (`highlightedKeys` / `isHighlighted` / `rangeKeys`), separate from
    the ticks. `rowTicks.js` makes a tick on a highlighted row apply to all of them, and Shift on a checkbox a range.
    Click-to-play is the player column only (the user: other cells played in some places and not others).
  - Popup: **Checkout / PayPal automation** (`checkoutAutomation`, on unless false). Off, `checkout.js` returns
    before doing anything: no listeners, no DOM changes, no clicks. e2e on a stand-in PayPal page.
  - **New tags reach open pages again:** an update or a dev reload cuts off the content script in tabs already
    open. The background now injects a fresh one into Bandcamp and local-app tabs (the `scripting` permission). It
    drops the old copy's widgets, and a cut-off app bridge stays quiet. The Bandcamp tagger also follows storage
    changes, so an import's new tags reach it.
- **Extension:**
  - Syncs to the server (diffs, a guarded full sync) and is the bridge for the local app (tag edits, page fetches,
    pending adds from imports).
  - Stamps `modified_at` whenever it changes an item's tags: its own edits, the app's, queued edits, imports and
    merges.
  - Content script: **Link to import** on Bandcamp album and track pages.
  - "Look up in my browser" requests (Bandcamp hosts only, no cookies).
  - The first "Client Challenge" stops its fetching; the last ownership check survives reloads, so dev rebuilds
    don't ask Bandcamp again.
- **Local app:**
  - Collection: Owned / Located / Rekordbox; selection-driven Locate / **Export Selected to RB** / Download owned
    missing; Settings (folders, matching, downloads, Bandcamp pacing, lookup source, the rekordbox target and the
    tag → playlist mapping, which prefills `tag → tag` and shows playlists to be created in yellow).
  - **Import:** file → tag mapping → preview (tints, match sources, Notes popover, Open on Bandcamp, pasted URL,
    Locate again, Set file by search or Browse, Download) → Import selected. That opens the collection with
    exactly the imported and merged items selected, newest Modified first.
  - Open imports reopen at their step after navigation, reloads or a server restart.
  - Downloads (user request): no confirmation, since they only add files to the downloads folder. **Download File**
    shows only for owned items (the server's `owned`). **Download Full Release** shows when a track's album or EP is
    owned (`full_release`), and a **Download Full Releases** box makes Download owned missing do the same. Rows show
    the server's plain progress ("downloading 42 %", "retry 1/3: read timed out", amber while retrying).
  - Parallel downloads (A): Settings → Downloads has Parallel downloads (1–8, default 4) and Download timeout
    (≥ 30 s, default 180). Rows show their own percent while several releases run, and the status line shows the
    job's line of everything in flight. The job tracker keeps a job's events that arrive before its start call
    answers.
  - **Import logs** (user request; the server writes them): after Import selected, the collection shows "Import
    log saved: <file>" with View (the Markdown, rendered in a dialog) and Show in Finder. The Import tab lists
    **Past imports**, and Settings has the folder (`import_log_dir`). A commit that stops part way still shows its
    partial log. The e2e harness answers every Show in Finder itself, so tests never open Finder, and the test
    server's logs stay in its own data folder.
- **e2e:** no live Bandcamp (fixtures, recordings, the stub downloader); the app is built into its own folder so
  runs never reload the user's tab.
- **Checked on copies** (`.e2e/phase5-e2e.mjs`, a sandbox `rekordbox_test`):
  - `annotations-test.json` → map → preview → Download → Import selected → Locate → Export Selected to RB;
  - the selection after import is exactly the imported and merged items, newest Modified first.

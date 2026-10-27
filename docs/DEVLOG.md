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

## App and extension (`app/`, `extension/`, `shared/`, branch `claude/local-collection-ui-e8f6f6`)

*(Session B's notes go here.)*

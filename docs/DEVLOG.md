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

## App and extension (`app/`, `extension/`, `shared/`, branch `claude/local-collection-ui-e8f6f6`)

### How to run

```bash
npm run build:app && npm run build:dev   # the local app (served by the server at /) and "Bc Tagger (dev)"
npm run test:e2e                         # Playwright e2e: own profile, server :8767, app in .e2e/app-dist
```

### 2026-10-26

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
    the server's plain progress ("downloading 42 %", "retrying 1/3 after: …").
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

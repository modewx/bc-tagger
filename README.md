# <img src="extension/public/icons/icon_48.png" width="45" align="left"> Bc Tagger

Tag Bandcamp tracks and albums in Chrome, browse the tagged collection, and (with the local
server) match it to your music files and export it to rekordbox.

## Layout

| Folder | What |
|---|---|
| `extension/` | The Chrome extension (MV3): tagging on bandcamp.com, popup, built-in "See Collection" page, Import/Export, sync to the local server. |
| `shared/` | Code used by both the extension and the local app: the collection page (`shared/collection/`), data sources (`shared/datasource/`), vendor libs (jQuery, chosen). |
| `app/` | The local app (collection with Owned / Located / Rekordbox columns, Settings), served by the server at `/`. |
| `server/` | The local server (Python/FastAPI): file index, matching, ownership, rekordbox export. See [`server/README.md`](server/README.md). |

The extension owns the tags (`chrome.storage.local`) and keeps the server's mirror up to date. The local
app edits tags through the extension (a content script on the server's page); when the extension isn't
reachable, edits are queued on the server and applied by the extension on its next sync.

## The local app

- **#** is each item's own number (`order`), the same on the extension's page and in the app: a new tag goes last,
  and an import's rows (Bandcamp and Other) get the next numbers in the file's order. The Src column and the
  Bandcamp / Other filter tell the two apart.
- **Collection** (`/`): Owned / Located / Rekordbox columns, Bandcamp and Other collections, a selection
  column (select-all for the rows shown), **Columns ▾** to show or hide columns (remembered per page; Track # is
  off by default), and **Modified** (when an item's tags last changed) next to **Added**.
  - The toolbar, in groups:
    - What to do with the selected rows (or the rows shown when none are selected): **Locate**, **Export selected to
      RB** (always a dry run, then confirm), **Download owned missing** (with **Download Full Releases** ticked: each
      track's whole album or EP), **Select last import** (exactly the last committed import's items), **Clear
      selection**;
    - **Rescan drive**;
    - **Tools ▾**: maintenance (Refresh player files, Refresh thumbnails, Fix artists, Fix album IDs, Refresh
      ownership); **Columns ▾**.
  - The selection is kept in this browser across pages and reloads.
  - **Collections** (Phase 8; shown once the server has them): the dropdown at the top lists **All** (every track,
    once) and then each collection, with its count; the choice is kept in this browser, and `?collection=<id|all>`
    opens one. **Create Collection** (a new, empty one), **Rename**, **Delete** (asks first; the tracks stay in All
    and in other collections, and no file, preview or rekordbox entry is touched; "Collection" can't be deleted).
    On the selection: **Import to Collection…** copies the tracks into another collection (and says how many were
    already there), **Remove from collection** (asks first; not in All). In All, a **Collections** column of chips
    (Columns ▾). Tags, files and everything else stay per track. An import's tracks go into the collection picked
    next to **Import selected** (the last used, else "Collection"; an open batch chooses then), and the collection
    page then opens in it, as does **Select last import**.
  - Rows (here and in the import preview): a click highlights a row, **Shift**-click a range, **Cmd**-click one more.
    Ticking a highlighted row ticks all highlighted rows (unticking unticks them all), and Shift on a checkbox ticks a
    range. Only the **player column** plays: a click anywhere in it, empty space too, plays or pauses that row.
  - **Players** (here, the import preview and the extension's page) have their own controls: play/pause, a seek bar
    and current / duration. A click on the bar plays from there, even before the file has loaded (a sleeping drive):
    the thumb waits at the click, "loading…", and playback starts there. Space and ←/→ (5 s) work on the bar.
    The speaker mutes, and its slider (on hover) sets the volume; ↑/↓ on the bar too. One volume for all players,
    kept in this browser.
  - **Use previews** (by the player, on by default): local players stream the server's preview of a file when it
    has one; off, the original, to hear the difference. Switching while a track plays carries on from the same
    moment. Each player's URL says which it plays (`src=preview` / `src=original`), fixed when the player is made:
    a preview the server makes while a track plays reaches only players made after, never the one playing (a seek
    on it keeps working). A preview that can't be played (the server no longer has it) plays on from the original,
    at the same moment. Next to the toggle, what the track playing is heard from (preview / original / Bandcamp
    stream), from its player's URL.
  - **A file that can't be played** (e.g. the music drive is unplugged and there's no preview): a Bandcamp item plays
    Bandcamp's stream instead (the cell's tooltip says why); an item from another source shows "File not available
    (drive not connected)" (asked of `/api/index/status`, which reads the mount table, never the drive), and ↻ (or a
    click on the cell) tries the file again, e.g. once the drive is back.
  - **Build previews** (Tools ▾): previews for the selected items (or the ones shown; with nothing selected or
    filtered, the whole collection). A dry run first, in a dialog: how many tracks need one, already have one or
    play as they are, how much of the space for previews it takes, what's left out and why, and roughly how long
    (the files to read at about 120 MB/s, the drive's speed: an estimate). The music drive must stay connected.
    Then its progress in the status line (built/total, MB/s, ETA, the file) with **Cancel**, and at the end what it
    built, failed and skipped, why it stopped early if it did, and the errors in a list to open. Rows follow the
    previews as they're made or dropped: a row's next player plays its preview. A build started before the page
    (or elsewhere) shows there too.
  - Test-only actions (Locate / Export latest 10) are in **Settings → Test**.
  - **Nothing runs unasked:** the app reads the music drive or Bandcamp only when you click (Play, Locate, Tools,
    Refresh ownership) or rest on a player: passing over players loads nothing, resting on one for a moment loads
    its length (so a click on its timeline plays from there). Rows without stored art show a placeholder (Tools →
    Refresh thumbnails fetches art), and the extension checks ownership only on Refresh ownership.
  - **One connection per tab:** Chrome allows 6 connections to the server across all tabs, and each open page's live
    updates hold one. A page uses a single stream, closes it while its tab is hidden, and catches up when shown.
    The collection loads without waiting for the extension, and says "Loading collection…" until its rows are in.
  - The Located popover: candidates, Locate again, **Download File** for owned items that aren't on the drive, and
    **Download Full Release** when a track's album or EP is owned. Downloads start at once, several releases at a
    time (Settings → Downloads → Parallel downloads, default 4). Each row shows its progress, and a retry shows its
    reason (amber).
- **Settings → Import:**
  - import a `bc-tagger-import/1` track list: default tags, optionally on every track; lookups by the server or
    **in my browser** (the extension);
  - map unknown tags, then review the preview: tints, match sources, Notes, Locate again / Set file (search or
    Browse), Download, Open on Bandcamp, or **Link to import** on the Bandcamp page itself.
  - **Import selected** opens the collection with exactly the imported and merged items selected, newest
    Modified first, ready for **Export Selected to RB**. It also saves an import log (JSON plus a Markdown summary,
    named by date and time): **View** shows it, and **Show in Finder** shows the file.
  - **Past imports** on the Import tab lists the logs, newest first, with their counts.
- **Settings → Import → Import from Files:** folders (by default the Collection and the downloads `complete`
  folder), each with an "added since" date that starts from its last run. Default tags are `pool`, with the same
  lookup choice.
  - One row per track file (a FLAC + AIFF pair counts once), already located, folder by folder, oldest release
    first.
  - Tracks already in the collection show as duplicates, unticked.
  - **Locations to update (N):** collection items that aren't located yet get these files on Import selected,
    whether or not their rows are ticked.
- **Import preview:** **Select all** / **Select new only** (everything not already in the collection), and
  **Transfer to rekordbox** sends the ticked rows' files to rekordbox (playlists from their tags, the usual dry run
  and confirm) without adding them to the collection. Its count, like Export Selected to RB's, is the located rows;
  the hint next to it says how many aren't located (skipped). The dialog shows where each tag goes.
  - Export and Transfer don't add a track to a playlist that already has the same song as another file (same
    artist and title, lengths within 2 s): the dry run lists them with both files, and **Add them anyway** adds them.
  - **Ticks and tags are never lost:** each action is saved in one request (one per row on a server without the
    bulk form, six at a time), with **Saving… / Saved** next to Import selected. A save that fails is tried again
    (and says so, with **Try now**); until the server has them they're also kept in this browser, so a reload or
    a crash shows them as made and sends them again, and leaving first asks. Import selected saves them first.
  - Back on a batch, the view is as it was left: **Show**, the sort and how far down (per batch, in this browser).
  - **New tags** (in the rows, not in the tag list yet) are highlighted in the rows' tag editors, chips and
    dropdown ("new: not in your tag list yet"). Tags that aren't in the list yet get **Create New Tags** at the top,
    then a link to map them in Settings → Rekordbox. Import selected creates them too.
  - An open import survives leaving the page; the header shows where it is.
- **Settings → General:** music folders, matching, downloads (folder and format), Bandcamp request pacing, the
  lookup source (Bandcamp / MusicBrainz / both), the import log folder (not inside a music folder or on the music
  drive); **Rekordbox:** the Target library (Test / Main), whether bc-tagger may write to the main one, and the tag →
  playlist mapping; **Previews:** their space (GB; saving a lower value drops the least recently played at once;
  0 turns them off), bitrate and parallel encoders, what they take (and the Mac's free space, with the 2 GB the
  server keeps free), and **Clear previews** (asks first).
- **Main library:** picking Main is safe on its own: exports to it stop at the dry run, which says writes are
  locked and links to **Allow bc-tagger to write to my main rekordbox collection**. Ticking that asks for a backup
  first; unticking it locks writes again and keeps Main. The header says **MAIN LIBRARY · read-only** or **MAIN
  LIBRARY · writes enabled** (nothing for the test library). The Playlists marks follow the Target library radios before
  you save.

Bandcamp is only reached by the server's paced lookups (if enabled) and by the extension in your own Chrome. The
first "Client Challenge" (bot check) stops it and says so.

## Build

```bash
npm install
npm run build        # production extension → extension/build (npm run pack zips it into release/)
npm run build:dev    # "Bc Tagger (dev)" → ../dev-extension-build (load it unpacked once)
npm run build:app    # local app → app/dist
server/bct serve     # local server + app on http://127.0.0.1:8765
```

- `BC_EXT_OUT=<dir>` overrides any extension build's output folder.
- `npm run watch:dev` / `npm run watch:app` rebuild on change. The dev extension reloads itself after a
  rebuild (within ~30 s, or popup → "Reload (dev)"); open app pages reload when the server reports a
  new build.
- The popup's **Checkout / PayPal automation** box (on by default) turns off the automatic steps on Bandcamp
  checkout and PayPal pages: with it off, `checkout.js` does nothing on those pages from their next load.
  On PayPal (`paypalCheckout.js`) it chooses the card issuer's currency, never PayPal's conversion: order details
  → Available currency options → the non-USD tab → Use it → Pay. A USD order is paid at once. Pay is never clicked
  while the page shows PayPal's rate; when it can't choose, it says so on the page and leaves Pay to you. Its
  progress is kept per checkout (by its token), so it never loops. Test: `npm run test:paypal` (fixtures, no network).
- **Collections in the tagger** (Phase 9): the popup's **Collection** dropdown (All, then the collections with
  their counts, then **New collection…**) says what the stars on Bandcamp pages show and where starring puts a
  track; the choice is kept by the extension (default All) and open Bandcamp tabs redraw their stars at once. In a
  collection, the star is membership (tags stay; the track stays in All). In All, starring a new track puts it into
  the first collection, and un-starring deletes it everywhere (asking first when it's in two or more). New
  collection… makes it on the server (the app shows it at once; one made in the app reaches the extension through
  an open app tab, else at the next check). Starring works with the server off: the changes go when it's back.
  The built-in See Collection page shows the chosen collection.
- The popup shows the local server's status; "edit" changes its URL (default `http://127.0.0.1:8765`),
  "sync" pushes everything now. **See Collection** opens the local app when the server answers, else the
  built-in page (Shift-click: always the built-in page).
- **Import** (popup) loads an Export file: merge (the file wins), merge keeping existing items, or replace. **Set
  the # order only** renumbers "#" from an Export or an order file (`{"format": "bc-tagger-order/1", "order": [ids]}`)
  and changes nothing else.

## Tests

```bash
npm run test:e2e     # HEADED=1 npm run test:e2e to watch
```

Runs the extension, server and local app together in a Playwright Chromium with a throwaway profile
(`.e2e/`), never the regular Chrome profile.
- It builds "Bc Tagger (e2e)" pointed at its own server on port 8767 with a fresh data folder, and the app into
  `.e2e/app-dist` (served by that server). It never touches the server on 8765, the `app/dist` it serves, or
  rekordbox.
- **No live Bandcamp:** Bandcamp hosts don't resolve in the test browser. Pages and API answers come from
  `scripts/e2e/fixtures/bandcamp/` and the server's recordings (`server/tests/fixtures/`). Downloads use the stub
  downloader. Any unrecorded Bandcamp request fails the test that made it.
- It covers import/sync/popup/bridge, the collection page (selection, columns, Modified), the import flow on the
  real server (mapping, linking, browser lookups, downloads, re-locate, browse), settings, and rekordbox dry runs
  and a sandbox write.

A full run (102 tests) takes about 3.5 minutes (2026-10-26: 110–147 s). For a quick check, run a subset by
name. Include `Import \(replace\)`, which loads the test collection the others use:

```bash
node --test --test-concurrency=1 --test-name-pattern="Import \(replace\)|Import from Files" scripts/e2e/extension.e2e.mjs
```

Some tests rely on earlier ones (e.g. Import from Files needs an item the Locate tests located), so a subset
can fail where the full run passes. Tests wait for conditions rather than fixed delays; the few short fixed
waits check that something does *not* happen.

First time only: `npx playwright install chromium`.

Other helpers: `node scripts/ext-page-harness.js --build extension/build --data <export.json>` serves a
built extension page in any browser with a stub `chrome` API. Server tests: see `server/README.md`.

---

Bootstrapped with [Chrome Extension CLI](https://github.com/dutiyesh/chrome-extension-cli).

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
  - The bulk buttons act on the selected rows, or on the rows shown when none are selected: **Locate**,
    **Export Selected to RB** (always a dry run, then confirm), **Download owned missing** (with **Download Full
    Releases** ticked: each track's whole album or EP).
  - The Located popover: candidates, Locate again, **Download File** for owned items that aren't on the drive, and
    **Download Full Release** when a track's album or EP is owned. Downloads start at once and the row shows their
    progress.
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
  and confirm) without adding them to the collection. The dialog shows where each tag goes. Tags the rows use that
  aren't in the tag list yet get **Create New Tags** at the top, then a link to map them in Settings → Rekordbox.
  - An open import survives leaving the page; the header shows where it is.
- **Settings → General:** music folders, matching, downloads (folder and format), Bandcamp request pacing, the
  lookup source (Bandcamp / MusicBrainz / both), the import log folder (not inside a music folder or on the music
  drive); **Rekordbox:** the target library and tag → playlist mapping.

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

First time only: `npx playwright install chromium`.

Other helpers: `node scripts/ext-page-harness.js --build extension/build --data <export.json>` serves a
built extension page in any browser with a stub `chrome` API. Server tests: see `server/README.md`.

---

Bootstrapped with [Chrome Extension CLI](https://github.com/dutiyesh/chrome-extension-cli).

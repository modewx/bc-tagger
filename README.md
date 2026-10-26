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
- **Import** (popup) loads an Export file: merge (the file wins), merge keeping existing items, or replace.

## Tests

```bash
npm run test:e2e     # HEADED=1 npm run test:e2e to watch
```

Runs the extension, server and local app together in a Playwright Chromium with a throwaway profile
(`.e2e/`), never the regular Chrome profile: Import, sync, the built-in collection page, the popup's See
Collection (server up/down), app ↔ extension tag edits, queued edits, and Bandcamp ownership when the
cookie file exists. It builds "Bc Tagger (e2e)" pointed at its own server on port 8767 with a fresh data
folder, so it never touches the server on 8765 or rekordbox. First time only: `npx playwright install chromium`.

Other helpers: `node scripts/ext-page-harness.js --build extension/build --data <export.json>` serves a
built extension page in any browser with a stub `chrome` API. Server tests: see `server/README.md`.

---

Bootstrapped with [Chrome Extension CLI](https://github.com/dutiyesh/chrome-extension-cli).

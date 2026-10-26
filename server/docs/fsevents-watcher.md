# FSEvents watcher

**Built, opt-in (Phase 5), default off:** `bc_tagger_server/watcher.py`, setting `watch_roots` (+
`watch_debounce_seconds`, default 3). It has the `WatchSource` interface, debouncing with a stable-size check,
bursts as subtree walks, "removed only if the volume is mounted and the file is gone", and pausing during
full scans. Status is in `GET /api/index/status` → `watcher`; SSE `index` events with `kind: "watch"`. Only
`bct serve` starts it. Its one backend is `watchdog` (live events only), used when that package is installed;
otherwise the watcher reports itself unavailable. **Not built yet:** the native FSEvents backend
(pyobjc) with event IDs and history replay across restarts and drive unplug/replug, as designed below.

Goal: keep the file index current while the server runs, so a quick scan before Locate/Export
finds nothing to do and a manual full rescan is rarely needed.

## Where it fits

| | today (Phase 2b) | with the watcher |
|---|---|---|
| Full scan | manual only (Rescan drive / `bct scan`) | still manual; the ground truth |
| Quick scan before Locate/Export | Spotlight + walk of recently modified folders since `cutoff` | first replays FSEvents history since the stored event ID (plan "method 2"), then falls back to today's quick scan |
| While the server runs | nothing | live events update the index within seconds |

## Library choice

- **`watchdog`** (FSEvents observer on macOS) is easy to use and cross-platform, but it hides
  FSEvents **event IDs** and can't **replay history** (`sinceWhen`). Those are what make the watcher
  useful across server restarts and drive unplug/replug.
- **Recommended: the native FSEvents API through `pyobjc-framework-CoreServices`**
  (`FSEventStreamCreate` with `kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagWatchRoot`,
  `FSEventStreamSetDispatchQueue`, `FSEventsGetCurrentEventId`, `FSEventsCopyUUIDForDevice`). It gives
  per-file events with flags, a persistent event ID per volume, and history replay from `.fseventsd`.
  Keep it behind a small interface (`WatchSource`) so tests can feed fake events and a `watchdog`
  live-only backend can be swapped in if pyobjc becomes a problem.

## Data kept per volume

`meta.fsevents[<volume UUID>] = {last_event_id, volume_uuid, roots, updated_at}`

- Volume UUID from `FSEventsCopyUUIDForDevice(st_dev)`. If it changes (event database reset,
  reformat), the stored ID is meaningless: drop it and show the `stale` hint (manual full rescan).
- After a **full scan**, store `FSEventsGetCurrentEventId()` **taken before the walk started**, so events
  that happened during the walk are replayed afterwards (applying them is idempotent).

## Lifecycle

1. **Server start:** for each mounted root, open a stream with `sinceWhen = last_event_id` (or `Now` if
   none). Historical events arrive first, then `kFSEventStreamEventFlagHistoryDone`, then live ones.
2. **Mount/unmount:** watch `/Volumes` (NSWorkspace `didMount`/`didUnmount` notifications, or a stream on
   `/Volumes` itself). On mount: start the stream with replay. On unmount: stop it and mark the root
   unmounted. **Never delete index rows because a volume went away** (same rule as the full scan).
3. **Shutdown:** flush pending batches and persist `last_event_id`.

## Event handling

- Only regular files with audio extensions (and directories, for subtree rescans); ignore dotfiles,
  `._*`, `.DS_Store`, `*.part`, `*.tmp`, and the downloader's working files.
- **Debounce:** collect events per path; act after the path has been quiet for ~3 s and its size is
  stable across two stats (downloads and `flac-exchange` conversions write in chunks). Burst cap: when
  more than ~500 paths are pending in one folder tree, treat it as one subtree rescan.
- Created/modified/renamed-in: `stat`, then upsert through the indexer's `file_record` + `_flush` (tags
  are re-read only when size or mtime changed, exactly like the scans).
- Removed/renamed-out: delete the row **only if** the volume is mounted and `stat` confirms the path is gone.
- `MustScanSubDirs`, `KernelDropped`, `UserDropped`: run the quick-walk on that subtree (or the
  whole root for root-level drops) instead of trusting individual events.
- `RootChanged` (a root folder was moved or deleted): stop the stream and show a hint.
- Publish SSE `index` events (`kind: "watch"`) per applied batch, so the UI updates live.

## Concurrency

- Index writes go through `Store.tx()`, as today. A full scan pauses applying watcher batches
  (events keep queueing) and resumes afterwards; nothing is lost because the full scan's start event ID
  is stored.
- The watcher runs as one thread in the server process; the CLI never runs it.

## Caveats

- **APFS/HFS+** (the current drive, `/Volumes/Stationary Backup`, is APFS with `.fseventsd`): full support,
  history survives unplug/replug.
- **exFAT/FAT32 USB sticks:** live events work, but `.fseventsd` history is often missing or reset on
  remount. Treat "no history" as "use the quick scan". FAT timestamps have 2 s granularity (debounce
  covers that). Spotlight is often disabled on these volumes, so the quick scan uses the folder walk.
- **SMB/NFS shares:** no events for changes made by other machines; keep scans as the only mechanism there.
- **Sleep and spin-down:** the kernel queues events; on wake the stream continues. Dropped-event flags
  trigger subtree rescans.
- **Event ID wrap/reset:** detected by the volume UUID or IDs going backwards → `stale` hint.

## Settings and status

- `watch_roots: bool` (default **off** until it has proven itself), `watch_debounce_seconds` (default 3).
- `GET /api/index/status` would gain `watcher: {running, volumes:[{uuid, mounted, last_event_id,
  last_event_at, history: "ok"|"unavailable"|"reset"}]}`.

## Testing plan

- Unit tests with a fake `WatchSource`: create/modify/delete/rename, debounce and stable size,
  dropped-event fallbacks, unmount with no deletions, UUID change → stale hint.
- One integration test on a temp dir on APFS with the real stream (latency ~1 s), skipped if
  pyobjc isn't installed.

## Effort and risks

About 1–2 days including tests. Risks: pyobjc packaging in the shared venv (fallback: the `watchdog` backend,
live events only), and debouncing large downloads. Neither blocks the current quick-scan design.

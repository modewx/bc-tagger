# Collection Page Player — Findings

Investigation into why the **See Collection** page players are mostly broken, and how to
fix them reliably. All claims below are verified against the live export
(`db-backups/bc-tagger-export-2026-10-25 (1).json`, 932 items) and tested in a browser.

## TL;DR

Each tagged track stores a stream link in `file["mp3-128"]`. There are **two forms**, and
only one survives over time:

| Form | Example | Lifespan |
|------|---------|----------|
| **`bandcamp.com/stream_redirect?…&track_id=…&t=…`** | TSVI, TVS bonuses, TestDept | **Permanent** |
| **`t4.bcbits.com/stream/<hash>/mp3-128/<id>?…&token=…`** | Phrex, LUXE, Tutu Ta | **~1 day**, then `410 Gone` |

A track plays today only if its cached link is the durable `stream_redirect` form **or** a
`t4` link captured within the last ~day. Everything else is dead.

## Root cause

- `t4.bcbits.com` links are **pre-signed CDN URLs** with an expiry baked into the `ts` query
  param (`ts` ≈ now + 1 day). After that they return **HTTP 410 Gone** (verified on a real
  saved link).
- `bandcamp.com/stream_redirect` is a **server endpoint**, not a file. Each time it's hit it
  **re-mints a fresh signed `t4` URL and 302-redirects to it**. Its own signature does not
  expire — a TestDept link signed in **2023** still played, logged-out, in an isolated
  browser. This is why a handful of old tracks still have working lightweight players.

## Data breakdown (932 items)

- **23** durable (`stream_redirect`) — nearly all play.
- **785** expiring (`t4.bcbits.com`) — almost all expired/dead.
- **124** have no `file` at all.

## Why TSVI works but most don't

`Futuro Lontano` (TSVI) and friends are stored in the **durable** `stream_redirect` form.
Those 23 durable links were a **one-off capture**: the 9 that have a `date_added` were all
saved in a single ~2-hour window on **2025-04-03**, and the other 14 predate the
`date_added` field entirely (an older capture path that no longer runs).

The **current tagging flow always stores the expiring `t4` form.** Proof it isn't about
which albums you own: album `ghettokumbe/kumb` has **both** a durable and an expiring track —
so the difference is *how/when it was captured*, not ownership.

Where the current `t4` links come from: tagging reads the Bandcamp page's embedded
`data-tralbum` blob (`src/contentScript.js`, `extractTrackData` →
`trackinfo[i].file["mp3-128"]`). That blob serves the short-lived `t4` form.

## How to create valid links

- **Cannot forge** a `stream_redirect` signature — Bandcamp must provide it.
- **Can always** get a *fresh* `t4` link on demand by fetching the track/album page and
  reading its `data-tralbum` (valid ~1 day). Requires `host_permissions` for
  `*.bandcamp.com`. Verified against the Naya Beat album page.
- **Open lever:** fetching **with the user's Bandcamp cookies** (`credentials:'include'`) may
  return the durable `stream_redirect` form for owned tracks. Untested; the refresh can try
  it and keep whichever form Bandcamp returns.
- The **EmbeddedPlayer iframe** (`bandcamp.com/EmbeddedPlayer/track=<id>` / `album=<id>`) is
  itself a permanent server-side re-mint — a guaranteed-working fallback. But rendering ~600
  of them at once made the page unusable, so it must be used sparingly (click-to-load), not
  as the default row player.

Note: the storage key encodes type + id (`t<trackid>` / `a<albumid>`) and is always present,
so any player can be built from the key alone.

## Proposed design (lightweight audio default, fast)

1. Each row renders a lightweight `<audio preload="none">` — zero network until play, so the
   page loads and scrolls fast. Validity is read from the URL with no network:
   `stream_redirect` ⇒ durable; `t4` ⇒ play only if `ts > now`.
2. Expired/missing ⇒ a compact **↻ load** button: one click fetches a fresh link (preferring
   `stream_redirect`), caches it to storage, and swaps in the audio — so **next time it just
   plays**.
3. Top **Refresh player files** button ⇒ bulk version (fetches each album page once, with
   limited concurrency); owned tracks may upgrade to permanent links.
4. Keep the embedded **full player** as the always-works fallback (click-to-load).
5. Optionally update **tagging** to capture the durable form going forward.

Net effect: owned tracks become permanent lightweight players; everything else is one click
to refresh, then cached.

## Status / next steps

- Collection page has been **reverted** to the original fast behavior for now.
- New player code (cached + refresh) is preserved in the session scratchpad.
- Awaiting go-ahead to build the design above (will re-add `host_permissions`).

## Open questions

- Does `credentials:'include'` actually yield `stream_redirect` for owned (vs. non-owned)
  tracks? Determines how many links can become permanent vs. needing periodic refresh.
- Thumbnails are a separate broken thing: `art_url` is missing on most items (`art_id` on
  nearly all), so the Thumbnail column is largely blank. Fixable separately.

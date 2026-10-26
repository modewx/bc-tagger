// ---------------------------------------------------------------------------
// Stream link helpers
//
// Each track stores file["mp3-128"]. Two forms exist:
//   - https://bandcamp.com/stream_redirect?...  -> DURABLE (server re-mints a
//     fresh CDN url on every hit; never expires).
//   - https://t4.bcbits.com/stream/...&token=   -> EXPIRES ~1 day (the `ts`
//     query param is the expiry; afterwards it returns 410 Gone).
// We can tell which is which (and whether a t4 link is still fresh) with no
// network call, and we can rebuild a fresh one by fetching the Bandcamp page.
// ---------------------------------------------------------------------------

import { ChallengeError, isChallengePage } from "../bandcampChallenge";

export function streamUrlOf(item) {
  return item && item.file && item.file["mp3-128"] ? item.file["mp3-128"] : null;
}

export function isDurableStream(url) {
  try {
    return new URL(url).host === "bandcamp.com"; // stream_redirect endpoint
  } catch (e) {
    return false;
  }
}

export function streamExpiry(url) {
  try {
    const ts = new URL(url).searchParams.get("ts");
    return ts ? Number(ts) : 0;
  } catch (e) {
    return 0;
  }
}

// Can this track play right now from its cached link (no refresh needed)?
export function isPlayable(item) {
  const url = streamUrlOf(item);
  if (!url) return false;
  if (isDurableStream(url)) return true;
  return streamExpiry(url) > Math.floor(Date.now() / 1000);
}

// Read the current mp3-128 url from a parsed Bandcamp page for a given track.
export function pickStreamFromTralbum(tralbum, item) {
  const trackinfo = Array.isArray(tralbum.trackinfo) ? tralbum.trackinfo : [];
  let track = null;
  if (item.tralbum_type === "t") {
    const rid = String(item.raw_id);
    track =
      trackinfo.find((t) => String(t.id) === rid) ||
      trackinfo.find((t) => String(t.track_id) === rid) ||
      (trackinfo.length === 1 ? trackinfo[0] : null);
  } else {
    track = trackinfo[0]; // album: first track
  }
  return track && track.file ? track.file["mp3-128"] : null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAbsUrl(u) {
  return typeof u === "string" && /^https?:\/\//.test(u);
}

export function isBandcampHost(u) {
  try {
    const h = new URL(u).host;
    return h === "bandcamp.com" || h.endsWith(".bandcamp.com");
  } catch (e) {
    return false;
  }
}

function isTrackUrl(u) {
  return /\/track\//.test(u);
}

// Choose the best page URL for an item. We strongly prefer a bandcamp.com page
// (custom domains fail CORS since they're not in host_permissions). For streams
// we prefer the track page (exact track + its file, works even for bundles /
// compilations whose album page doesn't list the track); for art the album page
// is fine (and dedupes across an album's tracks).
function bestPageUrl(item, preferTrack) {
  const base = [item.url, item.item_url].find(isAbsUrl);
  let albumAbs = null;
  if (isAbsUrl(item.album_url)) albumAbs = item.album_url;
  else if (item.album_url && base) {
    try {
      albumAbs = new URL(item.album_url, base).href;
    } catch (e) {
      /* ignore */
    }
  }
  const candidates = [item.url, item.item_url, albumAbs].filter(isAbsUrl);
  const bc = candidates.filter(isBandcampHost);
  const ordered = preferTrack
    ? [...bc.filter(isTrackUrl), ...bc.filter((u) => !isTrackUrl(u))]
    : [...bc.filter((u) => !isTrackUrl(u)), ...bc.filter(isTrackUrl)];
  return ordered[0] || candidates[0] || null; // bandcamp first, else custom, else none
}

export function pageUrlFor(item) {
  return bestPageUrl(item, false);
}

export function streamPageUrlFor(item) {
  return bestPageUrl(item, true);
}

export function tralbumOf(doc) {
  const el = doc.querySelector("script[data-tralbum]");
  if (!el) return null;
  try {
    return JSON.parse(el.getAttribute("data-tralbum"));
  } catch (e) {
    return null;
  }
}

// Full Bandcamp EmbeddedPlayer (always works; used as on-demand fallback).
export function embedSrcFromKey(key) {
  if (!key || key.length < 2) return null;
  const type = key[0];
  const id = key.slice(1);
  if (!/^\d+$/.test(id)) return null;
  const opts = "size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/artwork=small/transparent=true/";
  if (type === "a") return `https://bandcamp.com/EmbeddedPlayer/album=${id}/${opts}`;
  if (type === "t") return `https://bandcamp.com/EmbeddedPlayer/track=${id}/${opts}`;
  return null;
}

// ---------------------------------------------------------------------------
// Thumbnail helpers
//
// Bandcamp art is a permanent CDN image: f4.bcbits.com/img/a<art_id>_16.jpg,
// where <art_id> is zero-padded to 10 digits. So if we have art_id we can build
// the URL with no network; otherwise fetch the page to read art_id from the
// data-tralbum blob.
// ---------------------------------------------------------------------------

function artUrlFromId(artId) {
  if (!artId) return null;
  return `https://f4.bcbits.com/img/a${String(artId).padStart(10, "0")}_16.jpg`;
}

export function thumbUrl(item) {
  if (item.art_url) return item.art_url;
  return artUrlFromId(item.art_id);
}

function artIdFromTralbum(tralbum) {
  if (tralbum.art_id) return tralbum.art_id;
  if (tralbum.current && tralbum.current.art_id) return tralbum.current.art_id;
  return null;
}

// Read the current thumbnail URL from a parsed Bandcamp page. og:image is the
// most reliable (exact current art, correct filename), with data-tralbum's
// art_id as a fallback.
export function artUrlFromPage(doc) {
  const og = doc.querySelector('meta[property="og:image"]');
  if (og) {
    const m = (og.getAttribute("content") || "").match(/\/img\/(a?\d+)_\d+\.jpg/);
    if (m) return `https://f4.bcbits.com/img/${m[1]}_16.jpg`;
  }
  const tralbum = tralbumOf(doc);
  if (tralbum) return artUrlFromId(artIdFromTralbum(tralbum));
  return null;
}

// Split "Artist - Title" when the artist is embedded in the title.
export function splitArtistFromTitle(title) {
  const idx = (title || "").indexOf(" - ");
  if (idx === -1) return null;
  const artist = title.slice(0, idx).trim();
  const rest = title.slice(idx + 3).trim();
  if (!artist || !rest) return null;
  return { artist, title: rest };
}

// ---------------------------------------------------------------------------
// Page fetching
//
// `fetchFn(url, opts)` must resolve to a Response-like {ok, status, text()}
// (plus `challenge: true` when the extension saw Bandcamp's bot check).
// The extension passes window.fetch (it has host_permissions for bandcamp);
// the local app passes a fetch that goes through the extension bridge.
// The first bot-check page ("Client Challenge") stops all fetching through
// this fetcher (onChallenge(url) tells the page once); nothing retries it.
// ---------------------------------------------------------------------------

export function createBandcampFetcher(fetchFn, { onChallenge } = {}) {
  // --- Global throttle ------------------------------------------------------
  // Bandcamp returns HTTP 429 when hit too fast, so ALL page fetches go through
  // one small queue: few at a time, spaced out, and when a 429 lands everything
  // pauses for a cooldown. This keeps bulk refreshes from getting blocked.
  const MAX_CONCURRENT = 2;
  const SPACING_MS = 400;
  let activeFetches = 0;
  const fetchQueue = [];
  let pausedUntil = 0;
  let challengedUrl = null;

  function challenged(url) {
    if (!challengedUrl) {
      challengedUrl = url;
      if (onChallenge) onChallenge(url);
    }
    return new ChallengeError(challengedUrl);
  }

  function pumpFetches() {
    while (activeFetches < MAX_CONCURRENT && fetchQueue.length) {
      const task = fetchQueue.shift();
      activeFetches++;
      task().finally(() => {
        activeFetches--;
        setTimeout(pumpFetches, SPACING_MS);
      });
    }
  }

  function schedule(fn) {
    return new Promise((resolve, reject) => {
      fetchQueue.push(() => fn().then(resolve, reject));
      pumpFetches();
    });
  }

  // Fetch + parse a page through the throttle, honoring 429 with a global pause.
  function fetchPageDoc(url, opts) {
    return schedule(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        while (Date.now() < pausedUntil) await sleep(pausedUntil - Date.now() + 50);
        if (challengedUrl) throw new ChallengeError(challengedUrl);
        let res;
        try {
          res = await fetchFn(url, opts);
        } catch (e) {
          if (attempt === 3) throw e; // CORS / network — won't recover
          await sleep(800 * (attempt + 1));
          continue;
        }
        if (res.challenge) throw challenged(url);
        if (res.status === 429) {
          pausedUntil = Date.now() + 15000; // back everything off
          if (attempt === 3) throw new Error("HTTP 429");
          continue;
        }
        if (!res.ok) {
          if (isChallengePage(await res.text().catch(() => ""))) throw challenged(url);
          throw new Error(`HTTP ${res.status}`);
        }
        const html = await res.text();
        if (isChallengePage(html)) throw challenged(url);
        return new DOMParser().parseFromString(html, "text/html");
      }
    });
  }

  // Resolve the canonical *.bandcamp.com URL for an item whose stored URL is a
  // custom domain (which we can't fetch due to CORS). The EmbeddedPlayer page is
  // always on bandcamp.com (so permitted) and links to the real bandcamp album/
  // track URL. Keyed by the embed id so it's fetched once per album/track.
  const canonicalCache = new Map(); // embedUrl -> Promise<bandcampUrl|null>
  function resolveCanonicalUrl(item) {
    let embed = null;
    const albumId = item.album_id ? String(item.album_id).replace(/^a/, "") : null;
    if (albumId && /^\d+$/.test(albumId)) {
      embed = `https://bandcamp.com/EmbeddedPlayer/album=${albumId}/size=large/`;
    } else if (item.raw_id) {
      const t = item.tralbum_type === "a" ? "album" : "track";
      embed = `https://bandcamp.com/EmbeddedPlayer/${t}=${item.raw_id}/size=large/`;
    }
    if (!embed) return Promise.resolve(null);
    if (canonicalCache.has(embed)) return canonicalCache.get(embed);
    const p = fetchPageDoc(embed, { credentials: "omit" })
      .then((doc) => {
        if (!doc) return null;
        // The canonical bandcamp URL may be in an <a href> or inline JSON, so scan
        // the serialized HTML rather than relying on anchor elements.
        const html = doc.documentElement ? doc.documentElement.outerHTML : "";
        const m = html.match(/https?:\/\/[a-z0-9-]+\.bandcamp\.com\/(?:album|track)\/[a-z0-9-]+/i);
        return m ? m[0] : null;
      })
      .catch(() => null);
    canonicalCache.set(embed, p);
    return p;
  }

  // Fetch + parse an item's page. If its best URL is a custom domain, resolve the
  // canonical bandcamp URL first (via the EmbeddedPlayer) so no custom-domain
  // host permission is needed.
  async function pageDocForItem(item, preferTrack) {
    let url = preferTrack ? streamPageUrlFor(item) : pageUrlFor(item);
    if (!url) return null;
    if (!isBandcampHost(url)) {
      url = await resolveCanonicalUrl(item);
      if (!url) return null; // couldn't resolve -> skip (avoid a CORS attempt)
    }
    // Include cookies so owned tracks can return durable stream_redirect links.
    return fetchPageDoc(url, { credentials: "include" });
  }

  // Fetch the item's Bandcamp page (with the user's cookies, so owned tracks may
  // return the durable stream_redirect form) and read a fresh stream url.
  async function fetchFreshStream(item) {
    const doc = await pageDocForItem(item, true);
    const tralbum = doc && tralbumOf(doc);
    return tralbum ? pickStreamFromTralbum(tralbum, item) || null : null;
  }

  // Fetch (and cache) an item's album page once, canonical-aware, deduped per
  // album. Art, artist, and bulk stream resolution all reuse this one fetch.
  const albumDocCache = new Map(); // dedupe key -> Promise<doc|null>
  function albumDedupeKey(item) {
    return (item.album_id || pageUrlFor(item) || item.raw_id || "") + "";
  }
  function resolveAlbumDoc(item) {
    const key = albumDedupeKey(item);
    if (!key) return Promise.resolve(null);
    if (albumDocCache.has(key)) return albumDocCache.get(key);
    const p = pageDocForItem(item, false).catch((e) => {
      console.warn("[page] failed", key, (e && e.message) || e);
      return null;
    });
    albumDocCache.set(key, p);
    return p;
  }
  function resolveItemArt(item) {
    return resolveAlbumDoc(item).then((doc) => (doc ? artUrlFromPage(doc) : null));
  }

  // The data-tralbum of a track's own page. Ignores the stored album_id (it may
  // be the wrong one this is used to repair) when resolving custom domains.
  function resolveTrackTralbum(item) {
    return pageDocForItem({ ...item, album_id: null }, true)
      .then((doc) => (doc ? tralbumOf(doc) : null))
      .catch((e) => {
        console.warn("[track page] failed", item.id, (e && e.message) || e); // e.g. 404: track removed
        return null;
      });
  }

  // Bandcamp's own player data for a track (data-player-data on the
  // EmbeddedPlayer page). Always on bandcamp.com, so it also works for tracks
  // whose pages live on a label's custom domain.
  function resolveTrackPlayerData(item) {
    if (!/^\d+$/.test(String(item.raw_id || ""))) return Promise.resolve(null);
    const url = `https://bandcamp.com/EmbeddedPlayer/track=${item.raw_id}/size=large/`;
    return fetchPageDoc(url, { credentials: "omit" })
      .then((doc) => {
        const el = doc && doc.querySelector("[data-player-data]");
        return el ? JSON.parse(el.getAttribute("data-player-data")) : null;
      })
      .catch(() => null);
  }

  return {
    fetchFreshStream,
    resolveAlbumDoc,
    resolveItemArt,
    resolveTrackTralbum,
    resolveTrackPlayerData,
    challengedUrl: () => challengedUrl,
  };
}

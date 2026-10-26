console.log("----- collection.js");

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

function streamUrlOf(item) {
  return item && item.file && item.file["mp3-128"] ? item.file["mp3-128"] : null;
}

function isDurableStream(url) {
  try {
    return new URL(url).host === "bandcamp.com"; // stream_redirect endpoint
  } catch (e) {
    return false;
  }
}

function streamExpiry(url) {
  try {
    const ts = new URL(url).searchParams.get("ts");
    return ts ? Number(ts) : 0;
  } catch (e) {
    return 0;
  }
}

// Can this track play right now from its cached link (no refresh needed)?
function isPlayable(item) {
  const url = streamUrlOf(item);
  if (!url) return false;
  if (isDurableStream(url)) return true;
  return streamExpiry(url) > Math.floor(Date.now() / 1000);
}

// Read the current mp3-128 url from a parsed Bandcamp page for a given track.
function pickStreamFromTralbum(tralbum, item) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAbsUrl(u) {
  return typeof u === "string" && /^https?:\/\//.test(u);
}

function isBandcampHost(u) {
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

function pageUrlFor(item) {
  return bestPageUrl(item, false);
}

function streamPageUrlFor(item) {
  return bestPageUrl(item, true);
}

// --- Global throttle --------------------------------------------------------
// Bandcamp returns HTTP 429 when hit too fast, so ALL page fetches go through
// one small queue: few at a time, spaced out, and when a 429 lands everything
// pauses for a cooldown. This keeps bulk refreshes from getting blocked.
const MAX_CONCURRENT = 2;
const SPACING_MS = 400;
let activeFetches = 0;
const fetchQueue = [];
let pausedUntil = 0;

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
      let res;
      try {
        res = await fetch(url, opts);
      } catch (e) {
        if (attempt === 3) throw e; // CORS / network — won't recover
        await sleep(800 * (attempt + 1));
        continue;
      }
      if (res.status === 429) {
        pausedUntil = Date.now() + 15000; // back everything off
        if (attempt === 3) throw new Error("HTTP 429");
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      return new DOMParser().parseFromString(html, "text/html");
    }
  });
}

function tralbumOf(doc) {
  const el = doc.querySelector("script[data-tralbum]");
  if (!el) return null;
  try {
    return JSON.parse(el.getAttribute("data-tralbum"));
  } catch (e) {
    return null;
  }
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

// Full Bandcamp EmbeddedPlayer (always works; used as on-demand fallback).
function embedSrcFromKey(key) {
  if (!key || key.length < 2) return null;
  const type = key[0];
  const id = key.slice(1);
  if (!/^\d+$/.test(id)) return null;
  const opts = "size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/artwork=small/transparent=true/";
  if (type === "a") return `https://bandcamp.com/EmbeddedPlayer/album=${id}/${opts}`;
  if (type === "t") return `https://bandcamp.com/EmbeddedPlayer/track=${id}/${opts}`;
  return null;
}

// --- Players ---------------------------------------------------------------
// Two modes (toggle top-right, persisted):
//  - Per-row (default): each track row has its own <audio>; one plays at a time
//    (others pause). Good for skimming. Playback stops on re-render.
//  - Global: one persistent <audio> in the sticky top bar that survives
//    re-renders, so you can keep listening while sorting/filtering.
// "Now Playing" + Go To Playing + the playing-row highlight work in both modes.

let globalMode = (() => {
  try {
    return localStorage.getItem("bc_global_player_mode") === "1";
  } catch (e) {
    return false;
  }
})();
let playingKey = null;
let playingItem = null;
let playingAudio = null; // the single <audio> that is (or last was) current
let playingTagWrap = null; // the playing track's tag editor (teleports with it)

// Reposition the live player on scroll/resize (header-aware), rAF-throttled, so
// it docks to the top bar when its row is hidden behind the header / off screen
// and returns to the row when the row is visible again.
let placeScheduled = false;
function schedulePlace() {
  if (placeScheduled) return;
  placeScheduled = true;
  requestAnimationFrame(() => {
    placeScheduled = false;
    placePlaying();
  });
}
window.addEventListener("scroll", schedulePlace, { passive: true });
window.addEventListener("resize", schedulePlace);

function nowPlayingBox() {
  return {
    wrap: document.getElementById("globalPlayer"),
    holder: document.getElementById("gpAudioHolder"),
    tagHolder: document.getElementById("gpTagHolder"),
    title: document.getElementById("gpTitle"),
    artist: document.getElementById("gpArtist"),
  };
}

function highlightPlayingRow() {
  const table = document.getElementById("collectionTable");
  if (!table) return;
  table.querySelectorAll("tr.playing-row").forEach((r) => r.classList.remove("playing-row"));
  if (!playingKey) return;
  const row = table.querySelector(`tr[data-key="${playingKey}"]`);
  if (row) row.classList.add("playing-row");
}

// Per-row mode: a title + Go To Playing indicator at the top (no teleport).
function updateNowPlaying(item) {
  const { wrap, title, artist } = nowPlayingBox();
  if (!item) {
    wrap.classList.add("hidden");
    return;
  }
  title.textContent = item.title || "";
  artist.textContent = item.artist || "";
  wrap.classList.remove("hidden");
}

function isElementInView(el) {
  const r = el.getBoundingClientRect();
  const bar = document.getElementById("topBar");
  const barH = bar ? bar.offsetHeight : 0;
  return r.bottom > barH + 4 && r.top < (window.innerHeight || document.documentElement.clientHeight);
}

function playButton(label) {
  const btn = document.createElement("button");
  btn.className = "player-btn";
  btn.textContent = label;
  return btn;
}

// A real per-row <audio>. Hover loads metadata (so the timeline is seekable
// before play); clicking the timeline while paused starts playback there.
function makeRowAudio(url, item, key) {
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "none";
  audio.src = url;

  audio.addEventListener(
    "pointerenter",
    () => {
      if (audio.preload !== "metadata") {
        audio.preload = "metadata";
        audio.load();
      }
    },
    { once: true }
  );
  audio.addEventListener("seeked", () => {
    if (audio.paused) audio.play().catch(() => {});
  });
  audio.addEventListener("play", () => onAudioPlay(audio, item, key));
  // On end, keep the player in place (shows the play button at the end of the
  // track); it only moves/changes when another track starts.
  return audio;
}

// Any row audio that starts playing becomes the single current player (others
// pause). In global mode the element then teleports between its row and the top
// bar; in per-row mode it stays put (and playback ends on the next re-render).
function onAudioPlay(audio, item, key) {
  if (playingAudio && playingAudio !== audio) {
    try { playingAudio.pause(); } catch (e) { /* ignore */ }
    if (globalMode) {
      returnToRow(playingAudio, playingKey);
      returnTagWrapToRow(playingTagWrap, playingKey);
    }
  }
  if (globalMode && key !== playingKey) playingTagWrap = null; // new track -> its own editor
  playingAudio = audio;
  playingKey = key;
  playingItem = item;
  highlightPlayingRow();
  if (globalMode) {
    ensurePlayingTagWrap();
    placePlaying();
  } else {
    updateNowPlaying(item);
  }
}

// Move a no-longer-current audio back into its own row cell, or drop it.
function returnToRow(audio, key) {
  const cell = document.querySelector(`#collectionTable tr[data-key="${key}"] td.player-cell`);
  if (cell) {
    if (audio.parentElement !== cell) cell.appendChild(audio);
  } else if (audio.parentElement) {
    audio.remove();
  }
}

// Global mode: keep the live audio in its row while the row is on screen; dock
// it in the top bar otherwise, so playback + controls survive scroll/filter.
// "On screen" = below the sticky header and above the viewport bottom.
let suppressPlaceUntil = 0; // during a Go-To-Playing smooth scroll

function placePlaying() {
  if (!globalMode || !playingAudio) return;
  if (Date.now() < suppressPlaceUntil) return; // let Go To Playing settle
  ensurePlayingTagWrap();
  const { wrap, holder, tagHolder, title, artist } = nowPlayingBox();
  const row = playingKey
    ? document.querySelector(`#collectionTable tr[data-key="${playingKey}"]`)
    : null;
  const cell = row ? row.querySelector("td.player-cell") : null;
  const tagsCell = row ? row.querySelector("td.tags-cell") : null;
  if (cell && isElementInView(cell)) {
    if (playingAudio.parentElement !== cell) cell.appendChild(playingAudio);
    if (playingTagWrap && tagsCell && playingTagWrap.parentElement !== tagsCell) {
      tagsCell.innerHTML = "";
      tagsCell.appendChild(playingTagWrap);
    }
    wrap.classList.add("hidden");
  } else {
    if (playingAudio.parentElement !== holder) {
      [...holder.querySelectorAll("audio")].forEach((a) => {
        if (a !== playingAudio) a.remove();
      });
      holder.appendChild(playingAudio);
    }
    if (playingTagWrap && playingTagWrap.parentElement !== tagHolder) {
      [...tagHolder.querySelectorAll(".tag-editor-wrap")].forEach((w) => {
        if (w !== playingTagWrap) w.remove();
      });
      tagHolder.appendChild(playingTagWrap);
    }
    title.textContent = (playingItem && playingItem.title) || "";
    artist.textContent = (playingItem && playingItem.artist) || "";
    wrap.classList.remove("hidden");
  }
}

// Play a track in a row (used by the row-click shortcut and the Play button for
// not-yet-resolved tracks): reuse an existing audio, else resolve a link first.
async function playTrack(item, key, cell, btn) {
  const existing = cell.querySelector("audio");
  if (existing) {
    existing.play().catch(() => {});
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = "Loading..."; }
  let url = isPlayable(item) ? streamUrlOf(item) : null;
  if (!url) {
    try {
      url = await fetchFreshStream(item);
      if (url) {
        item.file = { "mp3-128": url };
        persistFiles({ [key]: item.file });
      }
    } catch (e) {
      console.warn("play load failed", key, (e && e.message) || e);
    }
  }
  if (btn) { btn.disabled = false; btn.textContent = "▶ Play"; }
  if (!url) {
    loadEmbed(cell, key);
    return;
  }
  cell.innerHTML = "";
  const audio = makeRowAudio(url, item, key);
  cell.appendChild(audio);
  audio.play().catch(() => {});
}

function goToPlaying() {
  if (!playingKey) return;
  let row = document.querySelector(`#collectionTable tr[data-key="${playingKey}"]`);
  if (!row) {
    // Playing track is filtered/searched out -> clear filters and re-render.
    document.getElementById("searchInput").value = "";
    $("#tagFilterSelect").val([]).trigger("chosen:updated");
    computeView();
    row = document.querySelector(`#collectionTable tr[data-key="${playingKey}"]`);
  }
  if (!row) return;
  // Immediately dock the player + tag editor back into the row, then scroll to
  // it (and keep them there during the smooth scroll).
  if (globalMode && playingAudio) {
    const cell = row.querySelector("td.player-cell");
    if (cell && playingAudio.parentElement !== cell) cell.appendChild(playingAudio);
    const tagsCell = row.querySelector("td.tags-cell");
    if (playingTagWrap && tagsCell && playingTagWrap.parentElement !== tagsCell) {
      tagsCell.innerHTML = "";
      tagsCell.appendChild(playingTagWrap);
    }
    nowPlayingBox().wrap.classList.add("hidden");
    suppressPlaceUntil = Date.now() + 800;
  }
  row.scrollIntoView({ behavior: "smooth", block: "center" });
}

function persistFiles(filesMap) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "updateTaggedItemFiles", files: filesMap }, () => resolve());
  });
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

function thumbUrl(item) {
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
function artUrlFromPage(doc) {
  const og = doc.querySelector('meta[property="og:image"]');
  if (og) {
    const m = (og.getAttribute("content") || "").match(/\/img\/(a?\d+)_\d+\.jpg/);
    if (m) return `https://f4.bcbits.com/img/${m[1]}_16.jpg`;
  }
  const tralbum = tralbumOf(doc);
  if (tralbum) return artUrlFromId(artIdFromTralbum(tralbum));
  return null;
}

function persistArt(artMap) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "updateTaggedItemArt", art: artMap }, () => resolve());
  });
}

function persistFields(updates) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "updateTaggedItemFields", updates }, () => resolve());
  });
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

// Lazily fetch a row's thumbnail only when it scrolls near view, so we never
// burst-fetch the whole collection at once (which gets rate-limited).
const thumbObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const cell = entry.target;
      thumbObserver.unobserve(cell);
      const item = cell._item;
      const key = cell._key;
      if (!item) return;
      resolveItemArt(item).then((url) => {
        if (!url) return;
        item.art_url = url;
        persistArt({ [key]: url });
        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = "";
        img.src = url;
        cell.innerHTML = "";
        cell.appendChild(img);
      });
    });
  },
  { rootMargin: "300px" }
);

function observeForArt(cell, key, item) {
  cell.innerHTML = "";
  const ph = document.createElement("span");
  ph.className = "no-thumb";
  cell.appendChild(ph);
  if (!pageUrlFor(item)) return; // nothing fetchable
  cell._item = item;
  cell._key = key;
  thumbObserver.observe(cell);
}

function renderThumb(cell, key, item) {
  cell.innerHTML = "";
  const turl = thumbUrl(item);
  if (turl) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = turl;
    // Stale/broken stored art -> placeholder, then lazily re-resolve from the page.
    img.onerror = () => observeForArt(cell, key, item);
    cell.appendChild(img);
  } else {
    observeForArt(cell, key, item);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let allItems = {};
let currentView = {}; // items currently shown (after search + tag filter)
let allTagsVocab = []; // tag vocabulary, for the inline tag editors
let indexByKey = {}; // key -> position in the stored JSON order (the "#" column)
let sortColumn = "index"; // "index" (JSON order, default) | "date" | "title" | "artist" | "tags"
let sortDir = 1; // 1 = ascending, -1 = descending

// --- Sorting ---------------------------------------------------------------

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function tagRank(tags) {
  if (tags.includes("must")) return 0;
  if (tags.includes("pool")) return 1;
  return 2; // neither -> last
}

// Tags minus the special must/pool, sorted alphabetically (the disambiguator).
function secondaryTags(tags) {
  return tags.filter((t) => t !== "must" && t !== "pool").sort();
}

function cmpTagArrays(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length; // shorter prefix first
}

function cmpTags(a, b) {
  const ta = a.tags || [];
  const tb = b.tags || [];
  const ra = tagRank(ta);
  const rb = tagRank(tb);
  if (ra !== rb) return ra - rb;
  return cmpTagArrays(secondaryTags(ta), secondaryTags(tb));
}

function compareItems(a, b) {
  let r = 0;
  if (sortColumn === "date") {
    r = (Date.parse(a.date_added) || 0) - (Date.parse(b.date_added) || 0);
  } else if (sortColumn === "title") {
    r = String(a.title || "").toLowerCase().localeCompare(String(b.title || "").toLowerCase());
  } else if (sortColumn === "artist") {
    r = String(a.artist || "").toLowerCase().localeCompare(String(b.artist || "").toLowerCase());
  } else if (sortColumn === "tags") {
    r = cmpTags(a, b);
  }
  return r * sortDir;
}

// --- Search ----------------------------------------------------------------

// A "label" proxy: the bandcamp subdomain (often the label/artist account).
function labelOf(item) {
  const u = item.url || item.album_url || item.item_url;
  try {
    return new URL(u).host.replace(/\.bandcamp\.com$/, "");
  } catch (e) {
    return "";
  }
}

function searchHaystack(item) {
  return [item.title, item.artist, item.album_title, labelOf(item)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// Multi-term substring match (every whitespace-separated term must appear).
function matchesSearch(item, terms) {
  if (!terms.length) return true;
  const hay = searchHaystack(item);
  return terms.every((t) => hay.includes(t));
}

// Recompute the visible set from the search box + tag filter, then render.
function computeView() {
  const q = (document.getElementById("searchInput").value || "").trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const selected = $("#tagFilterSelect").val() || [];

  const useAnd = !document.getElementById("filterOr").checked; // AND unless OR is picked

  const entries = Object.entries(allItems).filter(([key, item]) => {
    if (selected.length) {
      const tags = item.tags || [];
      const ok = useAnd
        ? selected.every((t) => tags.includes(t))
        : selected.some((t) => tags.includes(t));
      if (!ok) return false;
    }
    if (!matchesSearch(item, terms)) return false;
    return true;
  });
  currentView = Object.fromEntries(entries);
  renderCollectionTable(currentView);
}

// Lazily turn a Tags cell into a chosen multi-select (same widget as track
// annotation) when it scrolls into view, so we don't instantiate ~900 at once.
const tagEditorObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const cell = entry.target;
      tagEditorObserver.unobserve(cell);
      cell.innerHTML = "";
      cell.appendChild(buildTagEditorWrap(cell._item, cell._key));
    });
  },
  { rootMargin: "300px" }
);

// Build a chosen tag editor wrapped in a div so the whole widget can be moved
// (teleported) as one element between a row and the top bar.
function buildTagEditorWrap(item, key) {
  const wrap = document.createElement("div");
  wrap.className = "tag-editor-wrap";
  wrap.dataset.key = key;

  const current = Array.isArray(item.tags) ? item.tags : [];
  const sel = document.createElement("select");
  sel.multiple = true;
  sel.className = "chosen-select tag-editor";
  sel.setAttribute("data-placeholder", "Add tags...");

  const seen = {};
  allTagsVocab.forEach((t) => {
    seen[t] = true;
    sel.appendChild(new Option(t, t, false, current.includes(t)));
  });
  current.forEach((t) => {
    if (!seen[t]) sel.appendChild(new Option(t, t, false, true));
  });

  wrap.appendChild(sel);
  const $sel = $(sel);
  $sel.chosen({ width: "100%", no_results_text: "No tag" });
  $sel.on("change", () => {
    const tags = $sel.val() || [];
    item.tags = tags;
    chrome.runtime.sendMessage({ type: "updateTaggedItemTags", id: key, tags });
  });
  return wrap;
}

// Make sure the playing track has a (teleportable) tag editor to move around.
function ensurePlayingTagWrap() {
  if (playingTagWrap || !playingKey) return;
  const cell = document.querySelector(`#collectionTable tr[data-key="${playingKey}"] td.tags-cell`);
  if (cell) {
    let wrap = cell.querySelector(".tag-editor-wrap");
    if (!wrap) {
      tagEditorObserver.unobserve(cell);
      cell.innerHTML = "";
      wrap = buildTagEditorWrap(playingItem, playingKey);
      cell.appendChild(wrap);
    }
    playingTagWrap = wrap;
  } else {
    playingTagWrap = buildTagEditorWrap(playingItem, playingKey); // row not rendered yet
  }
}

// Move a no-longer-current tag editor back into its own row, or drop it.
function returnTagWrapToRow(wrap, key) {
  if (!wrap) return;
  const cell = document.querySelector(`#collectionTable tr[data-key="${key}"] td.tags-cell`);
  if (cell) {
    if (wrap.parentElement !== cell) {
      cell.innerHTML = "";
      cell.appendChild(wrap);
    }
  } else if (wrap.parentElement) {
    wrap.remove();
  }
}

// Reconcile a chosen multi-select's options with the current vocabulary: add new
// tags, drop deleted ones, keep current selections. (Same approach the Bandcamp
// content script uses for live tag updates.)
function syncChosenOptions(sel, tags) {
  const $sel = $(sel);
  const selected = $sel.val() || [];
  const keep = {};
  tags.forEach((t) => (keep[t] = true));
  selected.forEach((t) => (keep[t] = true));
  const have = {};
  [...sel.querySelectorAll("option")].forEach((o) => {
    if (o.value === "") return; // keep placeholder
    if (keep[o.value]) have[o.value] = true;
    else o.remove();
  });
  tags.forEach((t) => {
    if (!have[t]) sel.appendChild(new Option(t, t));
  });
  $sel.val(selected);
  $sel.trigger("chosen:updated");
}

// When the tag vocabulary changes anywhere (e.g. Create Tag in the popup),
// refresh the filter and every open inline tag editor live — no reload needed.
function onVocabChanged(tags) {
  allTagsVocab = Array.isArray(tags) ? tags : [];
  const filter = document.getElementById("tagFilterSelect");
  if (filter) syncChosenOptions(filter, allTagsVocab);
  document.querySelectorAll("select.tag-editor").forEach((sel) => syncChosenOptions(sel, allTagsVocab));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tags) {
    onVocabChanged(changes.tags.newValue || []);
  }
});

function renderTagsCell(cell, key, item) {
  cell.className = "tags-cell";
  cell.innerHTML = "";
  // Reuse the live teleporting editor for the playing track (global mode).
  if (globalMode && key === playingKey && playingTagWrap) {
    cell.appendChild(playingTagWrap);
    return;
  }
  // Otherwise show the tags as text until the editor is lazily built on scroll.
  const text = document.createElement("span");
  text.textContent = item.tags && item.tags.length ? item.tags.join(", ") : "—";
  cell.appendChild(text);
  cell._item = item;
  cell._key = key;
  tagEditorObserver.observe(cell);
}

// A chosen multi-select tag filter (same widget style as track annotation):
// type to autocomplete, add several tags, and the collection filters live.
function renderTagFilter(tags) {
  const sel = $("#tagFilterSelect");
  sel.empty();
  (tags || []).forEach((tag) => sel.append(new Option(tag, tag)));
  sel.chosen({ no_results_text: "No matching tag", width: "420px" });
  sel.on("change", computeView);
}

function openInNewTab(url) {
  if (url) window.open(url, "_blank").focus();
}

// Load the full Bandcamp embedded player inline (used for albums and as a
// fallback when a track's stream can't be resolved).
function loadEmbed(cell, key) {
  const src = embedSrcFromKey(key);
  if (!src) {
    cell.textContent = "no player";
    return;
  }
  const frame = document.createElement("iframe");
  frame.setAttribute("seamless", "");
  frame.style.border = "0";
  frame.style.width = "100%";
  frame.style.height = "120px";
  frame.src = src;
  cell.innerHTML = "";
  cell.appendChild(frame);
}

function renderPlayerCell(cell, key, item) {
  cell.className = "player-cell";
  cell.innerHTML = "";
  const isTrack = item.tralbum_type !== "a";

  // Albums are multi-track -> inline embedded player (either mode).
  if (!isTrack) {
    const btn = playButton("Play album");
    btn.addEventListener("click", () => loadEmbed(cell, key));
    cell.appendChild(btn);
    return;
  }

  // Global mode: the currently-playing track reuses the one live (teleporting)
  // audio element; placePlaying() may relocate it to the top bar afterwards.
  if (globalMode && key === playingKey && playingAudio) {
    cell.appendChild(playingAudio);
    return;
  }

  // A live link -> inline <audio>; else a Play button that resolves one.
  if (isPlayable(item)) {
    cell.appendChild(makeRowAudio(streamUrlOf(item), item, key));
    return;
  }
  const btn = playButton("▶ Play");
  btn.addEventListener("click", () => playTrack(item, key, cell, btn));
  cell.appendChild(btn);
}

// Persisted per-column widths (survive re-renders and reloads).
const COL_WIDTH_KEY = "bc_collection_col_widths_v3";
function loadColWidths() {
  try {
    return JSON.parse(localStorage.getItem(COL_WIDTH_KEY)) || {};
  } catch (e) {
    return {};
  }
}
function saveColWidths(w) {
  try {
    localStorage.setItem(COL_WIDTH_KEY, JSON.stringify(w));
  } catch (e) {
    /* ignore */
  }
}

// Make each header draggable on its right edge to resize its column.
function setupColumnResizing(table) {
  const ths = [...table.querySelectorAll("thead th")];
  const widths = loadColWidths();
  ths.forEach((th, i) => {
    if (widths[i]) th.style.width = widths[i] + "px";
    const grip = document.createElement("div");
    grip.className = "col-resizer";
    th.appendChild(grip);
    grip.addEventListener("click", (e) => e.stopPropagation()); // don't sort when resizing
    grip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.pageX;
      const startW = th.offsetWidth;
      const onMove = (ev) => {
        th.style.width = Math.max(40, startW + ev.pageX - startX) + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        const saved = loadColWidths();
        saved[i] = th.offsetWidth;
        saveColWidths(saved);
      };
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

function renderCollectionTable(items) {
  const collectionTable = document.getElementById("collectionTable");
  // Preserve the live playing audio across the rebuild (global mode) by docking
  // it in the top bar before the table is cleared.
  if (globalMode && playingAudio && collectionTable.contains(playingAudio)) {
    document.getElementById("gpAudioHolder").appendChild(playingAudio);
  }
  if (globalMode && playingTagWrap && collectionTable.contains(playingTagWrap)) {
    document.getElementById("gpTagHolder").appendChild(playingTagWrap);
  }
  thumbObserver.disconnect(); // drop observations from the previous render
  tagEditorObserver.disconnect();
  collectionTable.innerHTML = "";

  // Sortable header. null key = not sortable.
  const columns = [
    { key: "index", label: "#" },
    { key: "date", label: "Added" },
    { key: null, label: "Thumbnail" },
    { key: "title", label: "Title" },
    { key: "artist", label: "Artist" },
    { key: null, label: "Player" },
    { key: "tags", label: "Tags" },
  ];
  const header = collectionTable.createTHead();
  const headerRow = header.insertRow(0);
  columns.forEach((col) => {
    const th = document.createElement("th");
    th.textContent = col.label;
    if (col.key) {
      th.style.cursor = "pointer";
      if (sortColumn === col.key) {
        const arrow = document.createElement("span");
        arrow.className = "sort-arrow";
        arrow.textContent = sortDir === 1 ? " ▲" : " ▼"; // ▲ / ▼
        th.appendChild(arrow);
      }
      th.addEventListener("click", () => {
        if (sortColumn === col.key) {
          sortDir = -sortDir; // toggle asc <-> desc
        } else {
          sortColumn = col.key;
          sortDir = 1; // first click = ascending
        }
        renderCollectionTable(currentView);
      });
    }
    headerRow.appendChild(th);
  });

  // Keep original (storage/JSON) order until a column is clicked.
  const entries = Object.entries(items);
  if (sortColumn === "index") {
    entries.sort((x, y) => ((indexByKey[x[0]] || 0) - (indexByKey[y[0]] || 0)) * sortDir);
  } else if (sortColumn) {
    entries.sort((x, y) => compareItems(x[1], y[1]));
  }

  const tbody = collectionTable.createTBody();
  entries.forEach(([key, item]) => {
    const row = tbody.insertRow();
    row.dataset.key = key;
    const indexCell = row.insertCell();
    const dateCell = row.insertCell();
    const thumbnailCell = row.insertCell();
    const titleCell = row.insertCell();
    const artistCell = row.insertCell();
    const playerCell = row.insertCell();
    const tagsCell = row.insertCell();

    indexCell.className = "index-cell";
    indexCell.textContent = (indexByKey[key] || 0) + 1;

    dateCell.className = "date-cell";
    dateCell.textContent = fmtDate(item.date_added);

    thumbnailCell.className = "thumb-cell";
    renderThumb(thumbnailCell, key, item);
    $(thumbnailCell).click(() => openInNewTab(pageUrlFor(item)));

    const link = pageUrlFor(item) || "#";
    titleCell.innerHTML = `<a href="${link}" target="_blank">${item.title || ""}</a>`;
    artistCell.innerText = item.artist || "";

    renderPlayerCell(playerCell, key, item);

    renderTagsCell(tagsCell, key, item);

    // Global mode: clicking the "white space" of a row plays it. Ignore clicks on
    // the interactive bits (title link, thumbnail, tag editor, player controls).
    if (globalMode && item.tralbum_type !== "a") {
      row.classList.add("clickable-row");
      row.addEventListener("click", (e) => {
        if (e.target.closest("a, img, .no-thumb, button, audio, input, select, .chosen-container, .tags-cell, .thumb-cell")) {
          return;
        }
        playTrack(item, key, playerCell);
      });
    }
  });

  setupColumnResizing(collectionTable);

  if (globalMode) {
    highlightPlayingRow(); // live audio survives re-render
    placePlaying(); // dock to row (if visible) or top bar
  } else {
    // Per-row audio is destroyed by re-render, so playback stops -> clear state.
    playingAudio = null;
    playingKey = null;
    playingItem = null;
    playingTagWrap = null;
    updateNowPlaying(null);
    highlightPlayingRow();
  }
}

// Filter the table by the selected tags (any-match). No selection = show all.
// Bulk "Refresh player files": rebuild cached streams for all tracks. Fetches
// each album page once (tracks share albums) with limited concurrency.
async function refreshAllFiles(statusEl, button) {
  if (button) button.disabled = true;

  const tracks = Object.entries(allItems).filter(([key, item]) => item.tralbum_type === "t");
  const filesToPersist = {};
  let done = 0, updated = 0;

  const setStatus = () => {
    if (statusEl) statusEl.textContent = `Refreshing players ${done}/${tracks.length}... (${updated} set)`;
  };
  setStatus();

  // resolveAlbumDoc dedupes per album and the throttle handles concurrency/429.
  await Promise.all(
    tracks.map(([key, item]) =>
      resolveAlbumDoc(item).then((doc) => {
        const tralbum = doc && tralbumOf(doc);
        if (tralbum) {
          const fresh = pickStreamFromTralbum(tralbum, item);
          if (fresh) {
            item.file = { "mp3-128": fresh };
            filesToPersist[key] = item.file;
            updated++;
          }
        }
        done++;
        setStatus();
      })
    )
  );

  if (Object.keys(filesToPersist).length) {
    await persistFiles(filesToPersist);
  }
  if (statusEl) {
    statusEl.textContent = `Refreshed ${updated} of ${tracks.length} tracks.`;
  }
  if (button) button.disabled = false;
  renderCollectionTable(allItems);
}

// Bulk "Refresh thumbnails": for items with no art at all, fetch each album
// page once and read its art_id, then build + cache the thumbnail URL.
async function refreshAllThumbnails(statusEl, button) {
  if (button) button.disabled = true;

  // Items with no resolvable thumbnail at all (stale-art_id items are fixed
  // lazily via the img onerror path). resolveItemArt dedupes per album.
  const targets = Object.entries(allItems).filter(([key, item]) => !thumbUrl(item));
  const artToPersist = {};
  let done = 0, updated = 0;

  const setStatus = () => {
    if (statusEl) statusEl.textContent = `Thumbnails ${done}/${targets.length}... (${updated} set)`;
  };
  setStatus();

  await Promise.all(
    targets.map(([key, item]) =>
      resolveItemArt(item).then((url) => {
        if (url) {
          item.art_url = url;
          artToPersist[key] = url;
          updated++;
        }
        done++;
        setStatus();
      })
    )
  );

  if (Object.keys(artToPersist).length) {
    await persistArt(artToPersist);
  }
  console.log(`[thumbnails] checked=${targets.length} set=${updated} (per-URL failures logged above as "[art] failed ...")`);

  if (statusEl) {
    statusEl.textContent = `Thumbnails: set ${updated} of ${targets.length} (any failures in console).`;
  }
  if (button) button.disabled = false;
  renderCollectionTable(allItems);
}

// Split "Artist - Title" when the artist is embedded in the title.
function splitArtistFromTitle(title) {
  const idx = (title || "").indexOf(" - ");
  if (idx === -1) return null;
  const artist = title.slice(0, idx).trim();
  const rest = title.slice(idx + 3).trim();
  if (!artist || !rest) return null;
  return { artist, title: rest };
}

// "Fix artists": fill empty artist fields. Titles like "Artist - Title" are
// split locally; the rest are read from the Bandcamp page's tralbum.artist
// (and the missing thumbnail is grabbed in the same fetch). Order is preserved.
async function fixArtists(statusEl, button) {
  if (button) button.disabled = true;

  const dashUpdates = {};
  const toFetch = [];
  Object.entries(allItems).forEach(([key, item]) => {
    if (item.artist) return;
    const split = splitArtistFromTitle(item.title);
    if (split) {
      item.artist = split.artist;
      item.title = split.title;
      dashUpdates[key] = { artist: split.artist, title: split.title };
    } else {
      toFetch.push([key, item]); // canonical resolver handles custom domains too
    }
  });

  let fixed = 0;

  // 1) Dash-splits are instant: persist and show them right away.
  if (Object.keys(dashUpdates).length) {
    fixed += Object.keys(dashUpdates).length;
    await persistFields(dashUpdates);
    renderCollectionTable(currentView);
  }

  // 2) Fetch the rest (slow due to rate-limiting), saving progress in batches so
  //    nothing is lost if the page is closed partway through.
  let done = 0;
  let pending = {};
  const flush = async () => {
    if (Object.keys(pending).length) {
      const batch = pending;
      pending = {};
      await persistFields(batch);
    }
  };
  const setStatus = () => {
    if (statusEl) statusEl.textContent = `Fixing artists: ${fixed} set, ${done}/${toFetch.length} looked up...`;
  };
  setStatus();

  await Promise.all(
    toFetch.map(([key, item]) =>
      resolveAlbumDoc(item).then(async (doc) => {
        const tralbum = doc && tralbumOf(doc);
        if (tralbum) {
          let artist = tralbum.artist;
          if (Array.isArray(tralbum.trackinfo)) {
            const ti = tralbum.trackinfo.find((x) => String(x.id) === String(item.raw_id));
            if (ti && ti.artist) artist = ti.artist; // prefer per-track artist
          }
          const art = artUrlFromPage(doc);
          const fields = {};
          if (artist && !item.artist) {
            item.artist = artist;
            fields.artist = artist;
            fixed++;
          }
          if (art && !item.art_url) {
            item.art_url = art;
            fields.art_url = art;
          }
          if (Object.keys(fields).length) pending[key] = fields;
        }
        done++;
        setStatus();
        if (Object.keys(pending).length >= 20) await flush(); // periodic save
      })
    )
  );
  await flush();

  if (statusEl) statusEl.textContent = `Fixed ${fixed} artists.`;
  if (button) button.disabled = false;
  renderCollectionTable(currentView);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

chrome.runtime.sendMessage({ type: "getTags" }, (tags) => {
  if (tags == null) {
    $.getJSON(chrome.runtime.getURL("tags.json"), (seed) => {
      chrome.runtime.sendMessage({ type: "updateTags", tags: seed });
    });
  }

  chrome.runtime.sendMessage({ type: "getTags" }, (dbTags) => {
    allTagsVocab = Array.isArray(dbTags) ? dbTags : [];
    renderTagFilter(dbTags);
    // Load items after the vocab so inline tag editors have their options.
    chrome.runtime.sendMessage({ type: "getTaggedItems" }, (taggedItems) => {
      allItems = taggedItems || {};
      indexByKey = {};
      Object.keys(allItems).forEach((k, i) => { indexByKey[k] = i; });
      computeView();
    });
  });

  // Go To Playing.
  const gpGoto = document.getElementById("gpGoto");
  if (gpGoto) gpGoto.addEventListener("click", goToPlaying);

  // Player mode toggle (global vs per-row); persisted, per-row is the default.
  const modeToggle = document.getElementById("globalModeToggle");
  if (modeToggle) {
    modeToggle.checked = globalMode;
    modeToggle.addEventListener("change", () => {
      globalMode = modeToggle.checked;
      try { localStorage.setItem("bc_global_player_mode", globalMode ? "1" : "0"); } catch (e) { /* ignore */ }
      // Stop playback and reset, then re-render in the new mode.
      try { if (playingAudio) playingAudio.pause(); } catch (e) { /* ignore */ }
      if (playingTagWrap && playingTagWrap.parentElement) playingTagWrap.remove();
      playingAudio = null;
      playingKey = null;
      playingItem = null;
      playingTagWrap = null;
      updateNowPlaying(null);
      renderCollectionTable(currentView);
    });
  }

  // AND/OR filter mode: mutually exclusive checkboxes (radio-like), AND default.
  const filterAnd = document.getElementById("filterAnd");
  const filterOr = document.getElementById("filterOr");
  if (filterAnd && filterOr) {
    filterAnd.addEventListener("click", () => {
      filterAnd.checked = true;
      filterOr.checked = false;
      computeView();
    });
    filterOr.addEventListener("click", () => {
      filterOr.checked = true;
      filterAnd.checked = false;
      computeView();
    });
  }

  // Live search (debounced) across title / artist / album / label.
  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
    let t = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(computeView, 120);
    });
  }

  const refreshBtn = document.getElementById("refreshPlayers");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () =>
      refreshAllFiles(document.getElementById("refreshStatus"), refreshBtn)
    );
  }

  const thumbsBtn = document.getElementById("refreshThumbs");
  if (thumbsBtn) {
    thumbsBtn.addEventListener("click", () =>
      refreshAllThumbnails(document.getElementById("refreshStatus"), thumbsBtn)
    );
  }

  const artistsBtn = document.getElementById("fixArtists");
  if (artistsBtn) {
    artistsBtn.addEventListener("click", () =>
      fixArtists(document.getElementById("refreshStatus"), artistsBtn)
    );
  }
});

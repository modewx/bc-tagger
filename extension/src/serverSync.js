// ---------------------------------------------------------------------------
// Sync with the local bc-tagger server (server/ in this repo).
//
// The extension owns the data (chrome.storage.local, through itemsStore.js); the server keeps a
// mirror for the local app. We push:
//   - item upserts/deletions as they happen (the store says which items each change touched),
//   - a full snapshot on startup and periodically (the server drops anything
//     not in it),
//   - the tag vocabulary,
//   - owned item IDs, fetched from Bandcamp with the live session.
// and pull tag edits the local app queued while it couldn't reach us.
//
// Settings:  chrome.storage.local  bcServer = {url}
// Status:    chrome.storage.session bcSyncStatus = {...} (shown in the popup)
// ---------------------------------------------------------------------------

import { withItems, change, read, onStoreChange, nowIso, sameTags, laterIso, fillOrder, nextOrder, orderFloorOf, setOrderFloor } from "./itemsStore";
import { CHALLENGE_TEXT, isChallengePage } from "../../shared/bandcampChallenge";
import { readCollections, storeFetched, acceptOps, removeQueued, setActive, allCountOf, activeOf } from "./collectionsStore";
import { notePush } from "./timings";
import { splitOps, postWithOps } from "./membershipOps";

// http://127.0.0.1:8765 unless the build sets BC_DEFAULT_SERVER_URL (e2e builds).
export const DEFAULT_SERVER_URL = __DEFAULT_SERVER_URL__;
const FULL_SYNC_EVERY_MS = 15 * 60 * 1000;
const PUSH_DEBOUNCE_MS = 800;
const MEMBERSHIP_PUSH_MS = 250; // a star in a collection: soon (its item, if new, goes with it)

// --- Config / status ---------------------------------------------------------

export function normalizeServerUrl(url) {
  try {
    const u = new URL(String(url || "").trim() || DEFAULT_SERVER_URL);
    if (u.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(u.hostname)) return null;
    return `${u.protocol}//${u.host}`;
  } catch (e) {
    return null;
  }
}

// localhost and 127.0.0.1 are the same server.
export function sameServerOrigin(a, b) {
  const norm = (x) => {
    const n = normalizeServerUrl(x);
    return n ? n.replace("://localhost", "://127.0.0.1") : null;
  };
  return !!norm(a) && norm(a) === norm(b);
}

export async function getServerUrl() {
  const { bcServer } = await chrome.storage.local.get("bcServer");
  return normalizeServerUrl(bcServer && bcServer.url) || DEFAULT_SERVER_URL;
}

export async function getStatus() {
  const { bcSyncStatus } = await chrome.storage.session.get("bcSyncStatus");
  return bcSyncStatus || {};
}

async function setStatus(patch) {
  const status = { ...(await getStatus()), ...patch };
  await chrome.storage.session.set({ bcSyncStatus: status });
  return status;
}

// --- HTTP --------------------------------------------------------------------

async function api(path, { method = "GET", body, timeoutMs = 15000 } = {}) {
  const base = await getServerUrl();
  const init = { method, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + path, init);
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  return text ? JSON.parse(text) : null;
}

// Is our server answering? (Used by See Collection and the popup.)
export async function probeServer(timeoutMs = 800) {
  try {
    const health = await api("/api/health", { timeoutMs });
    if (!(health && health.ok && health.name === "bc-tagger")) return null;
    // The highest "#" on the server (its Other items too): new tags go after it.
    if (Number.isFinite(health.max_order)) setOrderFloor(health.max_order);
    return health;
  } catch (e) {
    return null;
  }
}

// --- Item / tag pushes -------------------------------------------------------

// The items changed since the last push (sent as they are then: upserted, or deleted if gone), and the tag list.
let pending = { ids: new Set(), tags: false };
let pushTimer = null;

// Every change to the store: its items and tags go to the server soon after (a membership change sooner), and the
// tag list to open app tabs at once.
onStoreChange(({ changed, deleted, keys }) => {
  changed.forEach((id) => pending.ids.add(id));
  deleted.forEach((id) => pending.ids.add(id));
  if (keys.includes("tags")) {
    pending.tags = true;
    read((s) => notifyAppTabs("tagsChanged", s.tags || []));
  }
  if (keys.includes("pendingMembership")) scheduleMembershipPush();
  else if (changed.length || deleted.length || keys.includes("tags")) schedulePush();
});

export function schedulePush(delayMs = PUSH_DEBOUNCE_MS) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushPending, delayMs);
}

export const scheduleMembershipPush = () => schedulePush(MEMBERSHIP_PUSH_MS);

// Membership ops the server can't take: out of the queue for good (a malformed one would make every later sync
// fail), logged, and kept in the sync status (the popup's server line says so); the collections read again.
async function dropOps(ops, error) {
  console.warn("[sync] membership changes the server can't take, dropped:", ops, error && error.message);
  await removeQueued(ops);
  const { droppedMembership } = await getStatus();
  const entry = { at: Date.now(), ops, error: (error && error.message) || String(error) };
  await setStatus({ droppedMembership: [...(droppedMembership || []), entry].slice(-20) });
  refreshCollections();
}

// The queued membership ops that can be sent (any malformed one, from before validation, is dropped now).
async function queuedOps() {
  const { good, bad } = splitOps((await readCollections()).pending);
  if (bad.length) await dropOps(bad, new Error("malformed"));
  return good;
}

// POST /api/sync/items with the queued ops; a 422 with ops attached: the items again without them (membershipOps.js).
function syncItems(body, ops, timeoutMs) {
  const post = (b) => api("/api/sync/items", { method: "POST", body: b, ...(timeoutMs ? { timeoutMs } : {}) });
  return postWithOps(post, body, ops, { accept: acceptOps, drop: dropOps });
}

// Membership changes made here ride on the item push (a new item and its collection together: the server would
// otherwise put the item into the first collection), or go on their own; the server applies them after the items.
async function pushPending() {
  const batch = pending;
  pending = { ids: new Set(), tags: false };
  // The items as they are now (an item changed again since is sent once, as it is).
  const { items, deleted, tags, count } = await read((s) => {
    const out = {};
    const gone = [];
    batch.ids.forEach((id) => (id in s.taggedItems ? (out[id] = s.taggedItems[id]) : gone.push(id)));
    return { items: out, deleted: gone, tags: Array.isArray(s.tags) ? s.tags : [], count: Object.keys(s.taggedItems).length };
  });
  const ids = Object.keys(items);
  const ops = await queuedOps();
  if (!ids.length && !deleted.length && !batch.tags && !ops.length) return;
  const t0 = Date.now();
  try {
    if (ids.length || deleted.length || ops.length) {
      await syncItems({ items, deleted, full: false }, ops);
    }
    // A fresh install only has the tags.json seed: don't let it replace the server's vocabulary.
    if (batch.tags && count) await api("/api/sync/tags", { method: "POST", body: { tags } });
    notePush([...batch.ids], t0, Date.now());
    await setStatus({ lastPushAt: Date.now(), lastPushCount: ids.length + deleted.length, lastError: null, serverUp: true });
  } catch (e) {
    // Server down: a full sync on the next successful contact catches up.
    notePush([...batch.ids], t0, Date.now(), e.message);
    await setStatus({ needsFull: true, lastError: e.message, serverUp: false });
  }
}

// Push everything; the server drops items that are no longer in storage.
// Automatic syncs never let an empty or much smaller storage (a fresh
// install, a new profile) wipe the server's mirror: they then only upsert.
// Only the popup's "sync" passes {force: true} (the app's syncNow is guarded too).
export async function fullSync(reason, { force = false } = {}) {
  const { items, tags } = await read((s) => ({ items: s.taggedItems, tags: s.tags }));
  const count = Object.keys(items).length;
  let full = true;
  let skipped = null;
  if (!force) {
    const health = await probeServer(1500);
    const serverItems = (health && health.items) || 0;
    if (count === 0 || (serverItems > 0 && count < serverItems / 2)) {
      full = false;
      skipped = `kept the server's ${serverItems} items: this extension has only ${count} (use "sync" to replace them)`;
    }
  }
  const ops = await queuedOps(); // after the items, as on every push
  try {
    if (count || full || ops.length) {
      await syncItems({ items, deleted: [], full }, ops, 60000);
    }
    if (count) await api("/api/sync/tags", { method: "POST", body: { tags: Array.isArray(tags) ? tags : [] } });
    await setStatus({
      lastFullAt: Date.now(),
      lastFullCount: count,
      lastFullReason: reason || "",
      needsFull: false,
      lastError: null,
      syncWarning: skipped,
      serverUp: true,
    });
    return { items: count, full };
  } catch (e) {
    await setStatus({ needsFull: true, lastError: e.message, serverUp: false });
    throw e;
  }
}

// --- Collections (Phase 9) ------------------------------------------------------

// One read of the server's collections and members (about 16 KB), kept in collectionsCache. Null: this server has
// no collections (older), or isn't answering.
export async function refreshCollections(timeoutMs = 4000) {
  try {
    return await storeFetched(await api("/api/collections/membership", { timeoutMs }));
  } catch (e) {
    return null;
  }
}

// For the popup, as it opens: one localhost request (the collections read) says whether the server answers and
// brings the collections up to date. The rest comes from the store. All's count is every item, as in the app (the
// extension's and those only in a collection, e.g. Other items): with one collection, the same as it.
export async function popupState() {
  const url = await getServerUrl();
  let up = false;
  try {
    await storeFetched(await api("/api/collections/membership", { timeoutMs: 1000 }));
    up = true;
  } catch (e) {
    up = !!e.status; // it answered (an older server without collections)
  }
  const [state, status] = await Promise.all([read((s) => ({ cache: s.collectionsCache || { list: [] }, active: activeOf(s), allCount: allCountOf(s) })), getStatus()]);
  if (up) await setStatus({ serverUp: true, lastCheckAt: Date.now() });
  return { url, up, status, ...state };
}

// "New collection…" in the popup: made on the server (the app hears of it), then the popup's choice.
export async function createCollection(name) {
  const made = await api("/api/collections", { method: "POST", body: { name } });
  await refreshCollections();
  await setActive(made.id);
  return made;
}

// --- Tag edits queued by the local app ---------------------------------------

export async function pullTagEdits() {
  const edits = await api("/api/tag-edits/pending");
  if (!Array.isArray(edits) || !edits.length) return { applied: 0, dropped: 0 };
  let applied = 0;
  const dropped = [];
  // Oldest first, so the newest edit for an item wins. The store pushes the
  // applied tags back to the server.
  const touched = edits.map((edit) => edit.item_id || edit.id);
  await withItems((items) => {
    edits.forEach((edit) => {
      const id = edit.item_id || edit.id;
      if (items[id] && Array.isArray(edit.tags)) {
        // The edit's own time (made in the local app), else now.
        if (!sameTags(items[id].tags, edit.tags) || edit.modified_at) items[id].modified_at = edit.modified_at || nowIso();
        items[id].tags = edit.tags;
        applied++;
      } else {
        dropped.push(id);
      }
    });
    if (!applied) return { ok: false, reason: "nothing to apply" }; // skip the write
  }, touched);
  await api("/api/tag-edits/ack", { method: "POST", body: { ids: edits.map((e) => e.edit_id) } });
  if (dropped.length) console.warn("[sync] dropped queued tag edits for unknown items", dropped);
  await setStatus({ lastPullAt: Date.now(), lastPullApplied: applied });
  return { applied, dropped: dropped.length };
}

// --- Imported Bandcamp items queued by the server -------------------------------

// Rows of an import that were found on Bandcamp become tagger items here
// (the extension owns them). Never overwrite an existing item: only merge
// tags. Entries may also carry new vocabulary tags ({tags: [...]}).
export async function pullPendingAdds() {
  const adds = await api("/api/tagger/pending-adds");
  if (!Array.isArray(adds) || !adds.length) return { added: 0, merged: 0, tags: 0 };
  let added = 0;
  let merged = 0;
  const vocab = [];
  const floor = await read(orderFloorOf);
  await withItems((items) => {
    // "#": the server numbers an import's new items in row order; else they go last here.
    fillOrder(items); // older items first, should they still have none
    let next = nextOrder(items, floor) - 1;
    adds.forEach((entry) => {
      (Array.isArray(entry.tags) ? entry.tags : []).forEach((t) => vocab.push(t));
      const item = entry.item;
      if (!item || !item.id) return;
      (item.tags || []).forEach((t) => vocab.push(t));
      const existing = items[item.id];
      const stamp = item.modified_at || nowIso(); // the import commit's time when the server sends it
      if (!existing) {
        const order = Number.isFinite(item.order) ? item.order : ++next;
        next = Math.max(next, order);
        items[item.id] = { ...item, date_added: item.date_added || nowIso(), modified_at: stamp, order };
        added++;
      } else {
        const union = [...new Set([...(existing.tags || []), ...(item.tags || [])])];
        const newer = laterIso(existing.modified_at, stamp) !== existing.modified_at;
        // A merge is a modification even without new tags (it was just imported again).
        if (union.length !== (existing.tags || []).length || newer) {
          existing.tags = union;
          existing.modified_at = laterIso(existing.modified_at, stamp);
          merged++;
        }
      }
    });
    if (!added && !merged) return { ok: false, reason: "nothing to change" }; // skip the write
  });
  let newTags = 0;
  if (vocab.length) {
    await change((s) => {
      const current = Array.isArray(s.tags) ? s.tags : [];
      const next = [...current];
      vocab.forEach((t) => {
        if (t && !next.includes(t)) next.push(t);
      });
      newTags = next.length - current.length;
      return newTags ? { values: { tags: next } } : { skip: true }; // the store pushes the vocabulary back
    });
  }
  await api("/api/tagger/pending-adds/ack", { method: "POST", body: { ids: adds.map((e) => e.add_id) } });
  await setStatus({ lastPendingAddsAt: Date.now(), lastPendingAdds: { added, merged, tags: newTags } });
  return { added, merged, tags: newTags };
}

// Settings → Bandcamp requests (the page-fetch throttle), from the server.
export async function bandcampLimits() {
  const data = await api("/api/settings", { timeoutMs: 2000 });
  const s = (data && data.settings) || data || {};
  return { concurrency: s.bandcamp_browser_concurrency, spacingMs: s.bandcamp_browser_spacing_ms };
}

// --- Import rows (Phase 3) -----------------------------------------------------

// Rows of open imports still waiting for a Bandcamp item, with the URL the user
// pasted for them (match_url) or the file's link (hint).
export async function openImportRows() {
  const rows = await api("/api/import/open-rows", { timeoutMs: 4000 });
  return Array.isArray(rows) ? rows : [];
}

// Rows of open imports that fit the items of the Bandcamp page the user has open
// (for the content script's "Link to import"), one request for the whole page:
// for each item, best first, [{batch_id, batch_name, n, artist, title, album, score, hint_match, bandcamp_id, via}].
const LINK_CANDIDATES_MAX = 1000; // items per request (the server's limit)

export async function importLinkCandidatesMany(items, pageUrl) {
  const out = [];
  for (let i = 0; i < items.length; i += LINK_CANDIDATES_MAX) {
    const chunk = items.slice(i, i + LINK_CANDIDATES_MAX);
    const res = await api("/api/import/link-candidates", {
      method: "POST",
      body: { items: chunk.map((item) => ({ item, page_url: pageUrl })) },
      timeoutMs: 15000,
    });
    const results = (res && Array.isArray(res.results) ? res.results : []).map((rows) => (Array.isArray(rows) ? rows : []));
    chunk.forEach((_, j) => out.push(results[j] || []));
  }
  return out;
}

// The page's item (as the content script saves it) becomes the row's Bandcamp item.
export function linkImportRow(batchId, n, item, pageUrl) {
  return api(`/api/import/${encodeURIComponent(batchId)}/rows/${encodeURIComponent(n)}/link`, {
    method: "POST",
    body: { item, page_url: pageUrl },
  });
}

// --- Ownership ---------------------------------------------------------------

// The logged-in fan's collection, keyed like our item IDs ("a<album>", "t<track>").
async function fetchOwnedIds() {
  const res = await fetch("https://bandcamp.com/api/fan/2/collection_summary", { credentials: "include" });
  const text = await res.text();
  if (isChallengePage(text)) {
    const e = new Error(`${CHALLENGE_TEXT}. Ownership isn't checked in the background until you refresh it yourself.`);
    e.challenge = true;
    throw e;
  }
  if (!res.ok) throw new Error(`Bandcamp collection_summary: HTTP ${res.status}`);
  const data = JSON.parse(text);
  const summary = data && data.collection_summary;
  if (!summary || !data.fan_id) throw new Error("not logged in to Bandcamp in this browser");
  const owned = Object.keys(summary.tralbum_lookup || {}).filter((k) => /^[at]\d+$/.test(k));
  return { owned, fanId: data.fan_id, username: summary.username || null };
}

// Only when the user asks: Tools → Refresh ownership in the local app.
export async function refreshOwnership() {
  let fetched;
  try {
    fetched = await fetchOwnedIds();
  } catch (e) {
    await setStatus({ ownership: { at: Date.now(), error: e.message, challenge: !!e.challenge } });
    throw e;
  }
  const res = await api("/api/ownership", {
    method: "POST",
    body: { owned_ids: fetched.owned, source: "extension", full: true, fan_id: fetched.fanId, username: fetched.username },
  });
  await setStatus({ ownership: { at: Date.now(), count: fetched.owned.length, username: fetched.username, error: null } });
  return { owned: fetched.owned.length, username: fetched.username, server: res };
}

// --- App tabs ----------------------------------------------------------------

// Tell open local-app tabs (via the appBridge content script) that the server
// mirror just changed, so they re-read it; or that the tags changed (`data`: the tags).
export async function notifyAppTabs(event, data) {
  try {
    const base = await getServerUrl();
    const port = new URL(base).port;
    const patterns = ["127.0.0.1", "localhost"].map((h) => `http://${h}${port ? ":" + port : ""}/*`);
    const tabs = await chrome.tabs.query({ url: patterns });
    tabs.forEach((tab) =>
      chrome.tabs.sendMessage(tab.id, { type: "bridgeEvent", event, data }, () => void chrome.runtime.lastError)
    );
  } catch (e) {
    /* no app tabs */
  }
}

// --- Periodic work ------------------------------------------------------------

// Runs on startup and on every alarm tick: catch up when needed, pull queued
// tag edits. Quiet when the server is down. Never goes online by itself:
// ownership is only refreshed by the user's Refresh ownership.
export async function syncTick(reason) {
  const health = await probeServer(1500);
  if (!health) {
    await setStatus({ serverUp: false, lastCheckAt: Date.now() });
    return;
  }
  const status = await setStatus({ serverUp: true, lastCheckAt: Date.now(), serverItems: health.items });
  // Collections: read again only when the server says they changed (health.collections_version).
  const { cache, pending: ops } = await readCollections();
  if (health.collections_version != null && health.collections_version !== cache.version) await refreshCollections();
  const source = health.items_source || {};
  const stale = !status.lastFullAt || Date.now() - status.lastFullAt > FULL_SYNC_EVERY_MS;
  if (status.needsFull || stale || source.kind !== "extension") {
    await fullSync(reason).catch(() => {});
  } else if (ops.length) {
    await pushPending(); // membership changes made while the server was off
  }
  await pullTagEdits().catch((e) => console.warn("[sync] pull failed", e.message));
  await pullPendingAdds().catch((e) => console.warn("[sync] pending adds failed", e.message));
  await setStatus({ tickDoneAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Sync with the local bc-tagger server (server/ in this repo).
//
// The extension owns the data (chrome.storage.local); the server keeps a
// mirror for the local app. We push:
//   - item upserts/deletions as they happen (diffed from storage.onChanged),
//   - a full snapshot on startup and periodically (the server drops anything
//     not in it),
//   - the tag vocabulary,
//   - owned item IDs, fetched from Bandcamp with the live session.
// and pull tag edits the local app queued while it couldn't reach us.
//
// Settings:  chrome.storage.local  bcServer = {url}
// Status:    chrome.storage.session bcSyncStatus = {...} (shown in the popup)
// ---------------------------------------------------------------------------

import { withItems, serialized, getStorage, setStorage, nowIso, sameTags, laterIso, maxOrder, orderFloor, setOrderFloor } from "./itemsStore";
import { CHALLENGE_TEXT, isChallengePage } from "../../shared/bandcampChallenge";

// http://127.0.0.1:8765 unless the build sets BC_DEFAULT_SERVER_URL (e2e builds).
export const DEFAULT_SERVER_URL = __DEFAULT_SERVER_URL__;
const FULL_SYNC_EVERY_MS = 15 * 60 * 1000;
const OWNERSHIP_EVERY_MS = 6 * 60 * 60 * 1000;
const PUSH_DEBOUNCE_MS = 800;

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
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
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

let pending = { items: {}, deleted: new Set(), tags: false };
let pushTimer = null;

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Record what changed between two taggedItems snapshots.
export function queueItemsDiff(oldItems, newItems) {
  oldItems = oldItems || {};
  newItems = newItems || {};
  Object.keys(newItems).forEach((id) => {
    if (!sameJson(oldItems[id], newItems[id])) {
      pending.items[id] = newItems[id];
      pending.deleted.delete(id);
    }
  });
  Object.keys(oldItems).forEach((id) => {
    if (!(id in newItems)) {
      pending.deleted.add(id);
      delete pending.items[id];
    }
  });
  schedulePush();
}

export function queueTags() {
  pending.tags = true;
  schedulePush();
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushPending, PUSH_DEBOUNCE_MS);
}

async function pushPending() {
  const batch = pending;
  pending = { items: {}, deleted: new Set(), tags: false };
  const ids = Object.keys(batch.items);
  if (!ids.length && !batch.deleted.size && !batch.tags) return;
  try {
    if (ids.length || batch.deleted.size) {
      await api("/api/sync/items", {
        method: "POST",
        body: { items: batch.items, deleted: [...batch.deleted], full: false },
      });
    }
    if (batch.tags) {
      // A fresh install only has the tags.json seed: don't let it replace the
      // server's vocabulary.
      const { tags, taggedItems } = await chrome.storage.local.get(["tags", "taggedItems"]);
      if (taggedItems && Object.keys(taggedItems).length) {
        await api("/api/sync/tags", { method: "POST", body: { tags: Array.isArray(tags) ? tags : [] } });
      }
    }
    await setStatus({ lastPushAt: Date.now(), lastPushCount: ids.length + batch.deleted.size, lastError: null, serverUp: true });
    notifyAppTabs("synced");
  } catch (e) {
    // Server down: a full sync on the next successful contact catches up.
    await setStatus({ needsFull: true, lastError: e.message, serverUp: false });
  }
}

// Push everything; the server drops items that are no longer in storage.
// Automatic syncs never let an empty or much smaller storage (a fresh
// install, a new profile) wipe the server's mirror: they then only upsert.
// Manual syncs (popup "sync", the app) pass {force: true}.
export async function fullSync(reason, { force = false } = {}) {
  const { taggedItems, tags } = await chrome.storage.local.get(["taggedItems", "tags"]);
  const items = taggedItems || {};
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
  try {
    if (count || full) {
      await api("/api/sync/items", { method: "POST", body: { items, deleted: [], full }, timeoutMs: 60000 });
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
    notifyAppTabs("synced");
    return { items: count, full };
  } catch (e) {
    await setStatus({ needsFull: true, lastError: e.message, serverUp: false });
    throw e;
  }
}

// --- Tag edits queued by the local app ---------------------------------------

export async function pullTagEdits() {
  const edits = await api("/api/tag-edits/pending");
  if (!Array.isArray(edits) || !edits.length) return { applied: 0, dropped: 0 };
  let applied = 0;
  const dropped = [];
  // Oldest first, so the newest edit for an item wins. onChanged pushes the
  // applied tags back to the server.
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
  });
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
  const floor = await orderFloor();
  await withItems((items) => {
    // "#": the server numbers an import's new items in row order; else they go last here.
    let next = Math.max(maxOrder(items), floor);
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
    await serialized(async () => {
      const { tags } = await getStorage("tags");
      const current = Array.isArray(tags) ? tags : [];
      const next = [...current];
      vocab.forEach((t) => {
        if (t && !next.includes(t)) next.push(t);
      });
      newTags = next.length - current.length;
      if (newTags) await setStorage({ tags: next }); // onChanged pushes the vocabulary back
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

// Rows of open imports that fit an item of the Bandcamp page the user has open
// (for the content script's "Link to import"), best first:
// [{batch_id, batch_name, n, artist, title, album, score, hint_match, bandcamp_id, via}].
export async function importLinkCandidates(item, pageUrl) {
  const rows = await api("/api/import/link-candidates", { method: "POST", body: { item, page_url: pageUrl }, timeoutMs: 4000 });
  return Array.isArray(rows) ? rows : [];
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

// The last check is also kept in chrome.storage.local (bcOwnershipCheck), so an
// extension reload (e.g. a dev rebuild) doesn't ask Bandcamp again.
export async function refreshOwnership() {
  let fetched;
  try {
    fetched = await fetchOwnedIds();
  } catch (e) {
    await setStatus({ ownership: { at: Date.now(), error: e.message, challenge: !!e.challenge } });
    await setStorage({ bcOwnershipCheck: { at: Date.now(), challenge: !!e.challenge } });
    throw e;
  }
  await setStorage({ bcOwnershipCheck: { at: Date.now(), challenge: false } });
  const res = await api("/api/ownership", {
    method: "POST",
    body: { owned_ids: fetched.owned, source: "extension", full: true, fan_id: fetched.fanId, username: fetched.username },
  });
  await setStatus({ ownership: { at: Date.now(), count: fetched.owned.length, username: fetched.username, error: null } });
  return { owned: fetched.owned.length, username: fetched.username, server: res };
}

// --- App tabs ----------------------------------------------------------------

// Tell open local-app tabs (via the appBridge content script) that the server
// mirror just changed, so they re-read it.
async function notifyAppTabs(event) {
  try {
    const base = await getServerUrl();
    const port = new URL(base).port;
    const patterns = ["127.0.0.1", "localhost"].map((h) => `http://${h}${port ? ":" + port : ""}/*`);
    const tabs = await chrome.tabs.query({ url: patterns });
    tabs.forEach((tab) =>
      chrome.tabs.sendMessage(tab.id, { type: "bridgeEvent", event }, () => void chrome.runtime.lastError)
    );
  } catch (e) {
    /* no app tabs */
  }
}

// --- Periodic work ------------------------------------------------------------

// Runs on startup and on every alarm tick: catch up when needed, pull queued
// tag edits, refresh ownership now and then. Quiet when the server is down.
export async function syncTick(reason) {
  const health = await probeServer(1500);
  if (!health) {
    await setStatus({ serverUp: false, lastCheckAt: Date.now() });
    return;
  }
  const status = await setStatus({ serverUp: true, lastCheckAt: Date.now(), serverItems: health.items });
  const source = health.items_source || {};
  const stale = !status.lastFullAt || Date.now() - status.lastFullAt > FULL_SYNC_EVERY_MS;
  if (status.needsFull || stale || source.kind !== "extension") {
    await fullSync(reason).catch(() => {});
  }
  await pullTagEdits().catch((e) => console.warn("[sync] pull failed", e.message));
  await pullPendingAdds().catch((e) => console.warn("[sync] pending adds failed", e.message));
  const { bcOwnershipCheck: own = {} } = await getStorage("bcOwnershipCheck");
  // After a bot check, only the user's own Refresh ownership tries again.
  if (!own.challenge && (!own.at || Date.now() - own.at > OWNERSHIP_EVERY_MS)) {
    await refreshOwnership().catch((e) => console.warn("[sync] ownership failed", e.message));
  }
}

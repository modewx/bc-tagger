import {
  fullSync,
  getServerUrl,
  getStatus,
  probeServer,
  pullTagEdits,
  pullPendingAdds,
  pullPendingDeletes,
  importLinkCandidatesMany,
  linkImportRow,
  openImportRows,
  bandcampLimits,
  refreshOwnership,
  sameServerOrigin,
  syncTick,
  refreshCollections,
  popupState,
  createCollection,
} from "./serverSync";
import { ALL, MAIN, queueMembership, removeItem, removeItems, unstar, setActive, readCollections, activeOf, memberIndex, sortedList, firstCollection } from "./collectionsStore";
import { withItems, change, read, flush, replaceItems, rev, tagsRev, nowIso, sameTags, fillOrder, nextOrder, orderFloorOf } from "./itemsStore";
import { noteOp, noteScreen, timingsText } from "./timings";
import { isChallengePage } from "../../shared/bandcampChallenge";

// ---------------------------------------------------------------------------
// Tag vocabulary helpers
//
// Data lives in chrome.storage.local, read and written only here (itemsStore.js keeps it in memory):
//   - taggedItems: { [id]: { ...metadata, tags: string[] } }  (the saved tracks)
//   - tags:        string[]                                    (the vocabulary / dropdown options)
//
// Golden rule: the vocabulary must always contain every tag that any saved
// track uses, plus the full tags.json seed. If a used tag were missing from the
// vocabulary it could silently disappear from a track when its tags are edited.
// ---------------------------------------------------------------------------

function usedTagsFrom(taggedItems) {
  const used = new Set();
  Object.values(taggedItems || {}).forEach((item) => {
    const tags = item && Array.isArray(item.tags) ? item.tags : [];
    tags.forEach((t) => {
      if (t != null && t !== "") used.add(t);
    });
  });
  return used;
}

// Ordered, de-duplicated union: keep seed order first, then any extras.
function unionTags(...lists) {
  const seen = new Set();
  const out = [];
  lists.forEach((list) => {
    (list || []).forEach((t) => {
      if (t != null && t !== "" && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    });
  });
  return out;
}

const seedTags = () =>
  fetch(chrome.runtime.getURL("tags.json"))
    .then((response) => response.json())
    .catch(() => []);

// The tag list as a change (pages see it when they're next shown: no broadcast to open tabs).
const setTags = (tags) => change((s) => (JSON.stringify(s.tags) === JSON.stringify(tags) ? { skip: true } : { values: { tags } }));

// Restore/maintain the complete vocabulary: tags.json ∪ existing ∪ used-by-tracks.
async function ensureTagsComplete() {
  const seed = await seedTags(); // still guarantee used tags without it
  return change((s) => {
    const merged = unionTags(seed, Array.isArray(s.tags) ? s.tags : [], [...usedTagsFrom(s.taggedItems)]);
    return JSON.stringify(merged) === JSON.stringify(s.tags) ? { skip: true } : { values: { tags: merged } };
  });
}

// The vocabulary for a dropdown, unioned with every tag a saved track uses so a dropdown can always represent (and
// never drop) a track's tags; kept when that adds any. Nothing stored yet: seeded from tags.json.
async function vocabulary() {
  const out = await change((s) => {
    const existing = Array.isArray(s.tags) ? s.tags : [];
    const merged = unionTags(existing, [...usedTagsFrom(s.taggedItems)]);
    if (!merged.length) return { skip: true, result: null };
    return merged.length !== existing.length ? { values: { tags: merged }, result: merged } : { skip: true, result: existing };
  });
  if (out) return out;
  const seeded = unionTags(await seedTags());
  await setTags(seeded);
  return seeded;
}

// ---------------------------------------------------------------------------
// Item updates (shared by the extension pages and the local app bridge)
// ---------------------------------------------------------------------------

// Merge refreshed stream URLs back in: { [id]: { "mp3-128": url } }.
function updateItemFiles(files) {
  const ids = [];
  return withItems((items) => {
    Object.entries(files || {}).forEach(([id, file]) => {
      if (items[id]) {
        items[id].file = file;
        ids.push(id);
      }
    });
  }, ids);
}

// Merge rebuilt thumbnail URLs back in: { [id]: art_url }.
function updateItemArt(art) {
  const ids = [];
  return withItems((items) => {
    Object.entries(art || {}).forEach(([id, art_url]) => {
      if (items[id]) {
        items[id].art_url = art_url;
        ids.push(id);
      }
    });
  }, ids);
}

// Merge arbitrary fields into items without reordering: { [id]: {..} }.
function updateItemFields(updates) {
  const ids = [];
  return withItems((items) => {
    Object.entries(updates || {}).forEach(([id, fields]) => {
      if (items[id] && fields && typeof fields === "object") {
        Object.assign(items[id], fields);
        ids.push(id);
      }
    });
  }, ids);
}

// Update one item's tags (inline editing from the collection page / local app).
// "#" from a file, nothing else: an order file ({format: "bc-tagger-order/1",
// order: [ids]}) numbers its ids 1, 2, …; an Export uses each item's `order`,
// else its place in the file. Items here that the file doesn't number keep
// their relative order, after the file's.
async function importOrder(data) {
  const fileOrder = {};
  if (data && Array.isArray(data.order)) {
    data.order.forEach((id, i) => {
      if (typeof id === "string" && !(id in fileOrder)) fileOrder[id] = i + 1;
    });
  } else if (data && data.taggedItems && typeof data.taggedItems === "object") {
    const ids = Object.keys(data.taggedItems);
    const numbered = ids.some((id) => Number.isFinite((data.taggedItems[id] || {}).order));
    ids.forEach((id, i) => (fileOrder[id] = numbered ? (data.taggedItems[id] || {}).order : i + 1));
    Object.keys(fileOrder).forEach((id) => !Number.isFinite(fileOrder[id]) && delete fileOrder[id]);
  } else {
    throw new Error("not a Bc Tagger export or order file");
  }
  return withItems((items) => {
    let numbered = 0;
    Object.entries(fileOrder).forEach(([id, n]) => {
      if (!items[id]) return;
      items[id].order = n;
      numbered++;
    });
    let next = Math.max(0, ...Object.values(fileOrder));
    const rest = Object.keys(items)
      .filter((id) => !(id in fileOrder))
      .sort((a, b) => (items[a].order ?? Infinity) - (items[b].order ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0));
    rest.forEach((id) => (items[id].order = ++next));
    return { ok: true, items: Object.keys(items).length, numbered, after: rest.length };
  });
}

// Items without an explicit `order` (data from before it existed) get numbers from 1, in storage order.
function ensureOrder() {
  return withItems((items) => (fillOrder(items) ? { ok: true } : { ok: false, reason: "all numbered" }));
}

// The collections a page names (`collections: [ids]`, or the older `collection: id`), as integers.
function collectionsOf(request) {
  const list = Array.isArray(request.collections) ? request.collections : Number.isInteger(request.collection) ? [request.collection] : [];
  return [...new Set(list.filter(Number.isInteger))];
}

// Starring / tagging on a Bandcamp page: a new item, or new tags, is a modification. `collections`: the collections
// it joins now (none: the server puts a new one into the first collection; All: every collection). "#" is
// Collection's: a new item gets the next number when it joins Collection (or no collection is named), none
// (`order: null`) when it's starred into others only, until it joins Collection (setMembership); an item keeps its
// number. Queued at once (the store's queue), so a page's next read sees it.
function saveTaggedItem(incoming, collections = []) {
  const ids = [incoming.id];
  const write = (items, s) => writeItem(items, s, incoming, collections, ids);
  if (!collections.length) return withItems(write, ids);
  return queueMembership(collections.map((cid) => ({ op: "add", collection_id: cid, ids: [incoming.id] })), write, ids);
}

// `incoming` saved in `items`; `ids` gets the items it numbers.
function writeItem(items, s, incoming, collections, ids) {
  const numbered = !collections.length || collections.includes(MAIN);
  const prev = items[incoming.id];
  const item = { ...incoming };
  item.modified_at = !prev || !sameTags(prev.tags, item.tags) ? nowIso() : prev.modified_at || item.modified_at;
  if (!item.modified_at) delete item.modified_at;
  fillOrder(items, ids); // older items first, should they still have none
  if (prev && prev.order != null) item.order = prev.order;
  else item.order = numbered ? nextOrder(items, orderFloorOf(s)) : null;
  items[item.id] = item;
}

// A saved item joins collections (tags kept). Joining Collection numbers it, if it has no "#" yet. Gone meanwhile
// (un-starred in its last collection in another tab): saved again as the page has it (`item`), when it sent one.
function joinCollections(collections, id, item = null) {
  const ids = [id];
  const write = (items, s) => {
    const it = items[id];
    if (!it) {
      if (!item || item.id !== id) return false;
      writeItem(items, s, item, collections, ids);
      return;
    }
    if (!collections.includes(MAIN) || it.order != null) return false;
    fillOrder(items, ids);
    it.order = nextOrder(items, orderFloorOf(s));
  };
  return queueMembership(collections.map((cid) => ({ op: "add", collection_id: cid, ids: [id] })), write, ids);
}

function updateItemTags(id, tags) {
  return withItems((items) => {
    if (!items[id]) return { ok: false, reason: "not-found" };
    const next = Array.isArray(tags) ? tags : [];
    if (!sameTags(items[id].tags, next)) items[id].modified_at = nowIso();
    items[id].tags = next;
    return { ok: true };
  }, [id]);
}

// What a page shows of its own items (`ids`): whether each is saved (and as what), the collections each is in, the
// collection shown and the list. `since`: the version the page has; unchanged, one small answer.
function pageState(ids, since) {
  return read((s) => {
    const now = rev();
    if (since && since === now) return { rev: now, same: true };
    const index = memberIndex(s);
    const items = {};
    const member = {};
    (ids || []).forEach((id) => {
      if (s.taggedItems[id]) items[id] = s.taggedItems[id];
      const m = index.get(id);
      if (m) member[id] = m;
    });
    const list = sortedList(s.collectionsCache).map(({ id, name, pos }) => ({ id, name, pos }));
    return { rev: now, active: activeOf(s), list, items, member };
  });
}

// The bundled collection page: the items of the collection shown, or in All the items in any collection (the union;
// no collection known yet: every item here), and the versions.
function shownItems() {
  return read((s) => {
    const active = activeOf(s);
    let items = s.taggedItems;
    if (active !== ALL && active != null) {
      items = {};
      ((s.collectionsCache.members || {})[String(active)] || []).forEach((id) => id in s.taggedItems && (items[id] = s.taggedItems[id]));
    } else if (active === ALL && sortedList(s.collectionsCache).length) {
      const index = memberIndex(s);
      items = {};
      Object.keys(s.taggedItems).forEach((id) => index.has(id) && (items[id] = s.taggedItems[id]));
    }
    return { rev: rev(), tagsRev: tagsRev(), active, items };
  });
}

// New items saved without naming a collection (an import, a test's setup) go into the first collection, as the
// server puts them: said in the extension's copy at once (an op, sent with them), so pages showing a collection
// list them before the next read from the server.
async function intoFirstCollection(ids) {
  const first = ids.length ? await read((s) => firstCollection(s.collectionsCache)) : null;
  if (first) await queueMembership([{ op: "add", collection_id: first.id, ids }]);
}

// Keys a test (or a repair) writes as given, through the store: the items' differences are pushed as usual.
async function writeStorage(values) {
  const { taggedItems, bcServer, ...rest } = values || {};
  if (bcServer !== undefined) await setServerUrl(bcServer && bcServer.url);
  if (taggedItems) {
    const had = await read((s) => new Set(Object.keys(s.taggedItems)));
    await replaceItems(taggedItems, rest);
    await intoFirstCollection(Object.keys(taggedItems).filter((id) => !had.has(id)));
  } else if (Object.keys(rest).length) await change(() => ({ values: rest })).then(flush);
  return { ok: true };
}

// The popup's server URL (a setting, not the store's): saved, then a sync with that server.
async function setServerUrl(url) {
  await chrome.storage.local.set({ bcServer: url ? { url } : null });
  syncTick("server changed");
}

// A tagger action reached here: the timing log (timings.js), when the page sent its id.
function noteAction(request, kind, ids, sender) {
  if (!request.opId) return;
  noteOp({ opId: request.opId, kind, page: request.page || (sender.tab ? "tab" : "extension page"), widgets: request.widgets, ids });
}

// ---------------------------------------------------------------------------
// Import (from an Export file: { taggedItems: {id: item}, tags: [...] })
//   mode "merge":   add new items, the file's copy wins for items in both
//   mode "keep":    add new items only, existing items stay as they are
//   mode "replace": storage becomes exactly the file's items
//   mode "order":   only the "#" order changes (importOrder)
// The vocabulary always ends up as tags.json ∪ existing ∪ file ∪ used tags.
// "#" (`order`): new items go after everything here (and on the server), in the
// file's order; items in both keep their number unless the file's copy has one
// (merge). Replace keeps the file's numbers and numbers the rest from 1.
// ---------------------------------------------------------------------------

async function importData(data, mode) {
  if (mode === "order") return importOrder(data);
  if (!data || typeof data !== "object" || !data.taggedItems || typeof data.taggedItems !== "object") {
    throw new Error("not a Bc Tagger export (no taggedItems)");
  }
  const incoming = {};
  Object.entries(data.taggedItems).forEach(([id, item]) => {
    if (item && typeof item === "object" && !Array.isArray(item)) incoming[id] = item;
  });
  const seed = await fetch(chrome.runtime.getURL("tags.json"))
    .then((r) => r.json())
    .catch(() => []);
  const floor = await read(orderFloorOf);
  // Read, then replace (the store's queue keeps other changes from landing in between, all but a page's star in the
  // same instant, which the file's copy replaces anyway).
  return (async () => {
    const { existing, existingTags } = await read((s) => ({ existing: s.taggedItems, existingTags: Array.isArray(s.tags) ? s.tags : [] }));
    let taggedItems;
    if (mode === "replace") taggedItems = incoming;
    else if (mode === "keep") taggedItems = { ...incoming, ...existing };
    else taggedItems = { ...existing, ...incoming };
    if (mode === "replace") {
      fillOrder(taggedItems);
    } else {
      // Existing items keep their numbers (unnumbered ones get theirs first); new ones go last, in the file's order.
      const kept = {};
      Object.keys(existing).forEach((id) => {
        const it = { ...taggedItems[id] };
        if (!Number.isFinite(it.order) && existing[id] && Number.isFinite(existing[id].order)) it.order = existing[id].order;
        kept[id] = it;
      });
      fillOrder(kept);
      let next = nextOrder(kept, floor) - 1;
      const added = Object.keys(incoming).filter((id) => !(id in kept));
      added.forEach((id) => (kept[id] = { ...taggedItems[id], order: ++next }));
      taggedItems = kept;
    }
    const tags = unionTags(
      seed,
      mode === "replace" ? [] : existingTags,
      Array.isArray(data.tags) ? data.tags : [],
      [...usedTagsFrom(taggedItems)]
    );
    await replaceItems(taggedItems, { tags });
    await intoFirstCollection(Object.keys(taggedItems).filter((id) => !(id in existing)));
    return { ok: true, items: Object.keys(taggedItems).length, tags: tags.length };
  })();
}

// ---------------------------------------------------------------------------
// Local app bridge: ops the local app may ask for. Only accepted from the
// configured server's pages (the content script checks this too).
// ---------------------------------------------------------------------------

function isBandcampUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "bandcamp.com" || u.hostname.endsWith(".bandcamp.com"));
  } catch (e) {
    return false;
  }
}

async function handleAppBridge(op, payload, sender) {
  const origin = sender.origin || (sender.url && new URL(sender.url).origin);
  if (!sender.tab || !sameServerOrigin(origin, await getServerUrl())) {
    throw new Error("not the configured local server");
  }
  switch (op) {
    case "collectionsChanged": {
      // The app heard an SSE `collections` event: read the collections again (one request), unless this copy is
      // that version already.
      const { cache } = await readCollections();
      if (payload.version != null && payload.version === cache.version) return { version: cache.version, read: false };
      const fresh = await refreshCollections();
      // A track with no "#" may have joined Collection on the server (numbered there): the highest "#" again, so the
      // next one given here comes after it.
      await probeServer(1500);
      return { version: fresh ? fresh.version : null, read: true };
    }
    case "deleteItems": {
      // The app's Remove from collection / Delete collection deleted these (left in no collection): here too, at
      // once, without asking (the app asked); then the server's queue of them is acked.
      const ids = (Array.isArray(payload.ids) ? payload.ids : []).filter((id) => typeof id === "string");
      await removeItems(ids);
      const pulled = await pullPendingDeletes().catch(() => ({ deleted: 0 }));
      return { deleted: ids.length, acked: pulled.deleted };
    }
    case "setItemTags": {
      noteAction(payload, "tags", [payload.id], sender);
      const res = await updateItemTags(payload.id, payload.tags);
      if (!res.ok) throw new Error(res.reason || "not saved");
      return res;
    }
    case "persistFiles":
      return updateItemFiles(payload.files);
    case "persistArt":
      return updateItemArt(payload.art);
    case "persistFields":
      return updateItemFields(payload.updates);
    case "fetchPage": {
      // Bandcamp pages only, read-only, with the user's session when asked.
      if (!isBandcampUrl(payload.url)) throw new Error("only bandcamp.com pages can be fetched");
      const res = await fetch(payload.url, {
        credentials: payload.credentials === "include" ? "include" : "omit",
      });
      if (res.url && !isBandcampUrl(res.url)) throw new Error("redirected away from bandcamp.com");
      const text = await res.text();
      return { status: res.status, text: res.ok ? text : "", challenge: isChallengePage(text) };
    }
    case "bandcampRequest": {
      // A Bandcamp request the local server asked for ("Look up in my
      // browser" for imports): its search (POST, JSON body) or a release
      // page (GET), in this browser, without the user's cookies. The body
      // goes back as is (the server reads it, and sees a bot check).
      const { method = "GET", url, body } = payload;
      if (!isBandcampUrl(url)) throw new Error("only bandcamp.com requests");
      if (method !== "GET" && method !== "POST") throw new Error("GET or POST only");
      const init = { method, credentials: "omit" };
      if (method === "POST" && body != null) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(body);
      }
      const res = await fetch(url, init);
      if (res.url && !isBandcampUrl(res.url)) throw new Error("redirected away from bandcamp.com");
      const text = await res.text();
      return { status: res.status, text, challenge: isChallengePage(text) };
    }
    case "refreshOwnership":
      return refreshOwnership();
    case "syncNow": {
      // Guarded like an automatic sync: an empty (or much smaller) storage never replaces the server's mirror
      // from a page (the import page asks after a commit); only the popup's "sync" forces that.
      await fullSync("app");
      const edits = await pullTagEdits();
      const adds = await pullPendingAdds().catch((e) => ({ error: e.message }));
      return { ...edits, adds };
    }
    case "status":
      return { serverUrl: await getServerUrl(), status: await getStatus() };
    case "timing":
      return noteScreen(payload.opId, payload.screenMs);
    default:
      throw new Error(`unknown op ${op}`);
  }
}

// ---------------------------------------------------------------------------
// Server sync triggers
// ---------------------------------------------------------------------------

// No storage.onChanged listener anywhere in the extension: Chrome would copy every write (the old and new store) to
// each context listening. This worker is the only writer; it knows what each change touched (itemsStore.js).

// Every 30 s: catch up / pull queued tag edits (see syncTick).
chrome.alarms.create("bc-sync", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bc-sync") syncTick("alarm");
  if (alarm.name === "bc-sync" && __DEV_BUILD__) checkDevBuild();
});

// ---------------------------------------------------------------------------
// Dev builds only: reload the extension when a new build lands in its folder
// (webpack writes dev-build-id.txt after every compile).
// ---------------------------------------------------------------------------

let devBuildId = null;
function checkDevBuild() {
  fetch(chrome.runtime.getURL("dev-build-id.txt"), { cache: "no-store" })
    .then((r) => (r.ok ? r.text() : null))
    .then((id) => {
      if (!id) return;
      if (devBuildId && id !== devBuildId) {
        console.log("[dev] new build, reloading");
        chrome.runtime.reload();
      }
      devBuildId = id;
    })
    .catch(() => {});
}
if (__DEV_BUILD__) {
  checkDevBuild();
  setInterval(checkDevBuild, 2000); // while the worker is awake; the alarm covers the rest
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// After an update or a dev reload, tabs that were already open keep a content
// script cut off from the extension: no saves, no new tags, no app bridge.
// Give the Bandcamp pages and the local app a fresh one; it drops the old
// copy's widgets (contentScript.js), and a cut-off bridge stays quiet (appBridge.js).
async function refreshContentScripts() {
  const entries = (chrome.runtime.getManifest().content_scripts || []).filter((e) =>
    (e.js || []).some((f) => /contentScript|appBridge/.test(f))
  );
  for (const entry of entries) {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: entry.matches });
    } catch (e) {
      continue;
    }
    for (const tab of tabs) {
      const target = { tabId: tab.id };
      try {
        if (entry.css && entry.css.length) await chrome.scripting.insertCSS({ target, files: entry.css });
        await chrome.scripting.executeScript({ target, files: entry.js });
      } catch (e) {
        // a tab that can't be scripted (discarded, an error page)
      }
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  refreshContentScripts();
  ensureTagsComplete(); // (the store writes an empty taggedItems when there's none)
  ensureOrder();
  syncTick("installed");
});

// Also heal on browser startup, in case anything was ever written partially.
chrome.runtime.onStartup.addListener(() => {
  ensureTagsComplete();
  ensureOrder();
  syncTick("startup");
});

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Every change is queued in the store as the message arrives (no await before it), so a page's next read sees it.
  if (request.type === "getTaggedItems") {
    read((s) => s.taggedItems).then(sendResponse);
    return true;
  }

  if (request.type === "pageState") {
    // A page shown or focused (or just loaded): its items' state, or "same" when nothing changed since `rev`.
    pageState(request.ids, request.rev).then(sendResponse);
    return true;
  }

  if (request.type === "tagsState") {
    // The tag list, unless the page has this version.
    if (request.rev && request.rev === tagsRev()) sendResponse({ rev: tagsRev(), same: true });
    else vocabulary().then((tags) => sendResponse({ rev: tagsRev(), tags }));
    return true;
  }

  if (request.type === "addTaggedItem") {
    const item = request.item || {};
    noteAction(request, request.kind || "star", [item.id], sender);
    saveTaggedItem(item, collectionsOf(request)).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (request.type === "setMembership") {
    // Starring (or tagging) an item that exists in a collection (in All: every collection), or un-starring it there:
    // out of it, or deleted when it was its last collection ({deleted: true}).
    noteAction(request, request.kind || (request.op === "add" ? "star" : "unstar"), [request.id], sender);
    const collections = collectionsOf(request);
    const done =
      request.op === "remove"
        ? unstar(collections, request.id)
        : joinCollections(collections, request.id, request.item).then((r) => (r && r.queued ? { ok: true } : { ok: false, error: "not a valid change" }));
    done.then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (request.type === "removeTaggedItem") {
    // Un-starring in All: the item and its tags go, from every collection (one change).
    noteAction(request, "unstar", [request.id], sender);
    removeItem(request.id).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.type === "flushNow") {
    // A page that made changes is hidden or closing: write them now.
    flush().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.type === "timing") {
    noteScreen(request.opId, request.screenMs);
    return false;
  }

  if (request.type === "getTimings") {
    timingsText().then((text) => sendResponse({ text }));
    return true;
  }

  if (request.type === "revs") {
    sendResponse({ rev: rev(), tagsRev: tagsRev() });
    return false;
  }

  if (request.type === "shownItems") {
    shownItems().then(sendResponse);
    return true;
  }

  if (request.type === "writeStorage") {
    writeStorage(request.values).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (request.type === "setServerUrl") {
    setServerUrl(request.url).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.type === "popupState") {
    popupState().then(sendResponse, (e) => sendResponse({ up: false, error: e.message }));
    return true;
  }

  if (request.type === "createCollection") {
    createCollection(String(request.name || "").trim()).then(
      (collection) => sendResponse({ ok: true, collection }),
      (e) => sendResponse({ ok: false, error: e.message, status: e.status })
    );
    return true;
  }

  if (request.type === "setActiveCollection") {
    setActive(request.collection).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.type === "updateTaggedItemFiles") {
    updateItemFiles(request.files).then(sendResponse);
    return true;
  }

  if (request.type === "updateTaggedItemArt") {
    updateItemArt(request.art).then(sendResponse);
    return true;
  }

  if (request.type === "updateTaggedItemFields") {
    updateItemFields(request.updates).then(sendResponse);
    return true;
  }

  if (request.type === "updateTaggedItemTags") {
    noteAction(request, "tags", [request.id], sender);
    updateItemTags(request.id, request.tags).then(sendResponse);
    return true;
  }

  if (request.type === "refreshContentScripts") {
    // What an update or dev reload does to open tabs (tests call it directly).
    refreshContentScripts().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.type === "importData") {
    importData(request.data, request.mode).then(sendResponse, (e) =>
      sendResponse({ ok: false, error: e.message })
    );
    return true;
  }

  if (request.type === "appBridge") {
    // Requests from the local app, relayed by the appBridge content script.
    handleAppBridge(request.op, request.payload || {}, sender).then(
      (result) => sendResponse({ ok: true, result }),
      (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) })
    );
    return true;
  }

  // From the content script: import rows that fit an item of the page, and
  // linking the page's item to one of them.
  if (request.type === "bandcampLimits") {
    bandcampLimits().then(
      (limits) => sendResponse({ ok: true, limits }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }
  if (request.type === "importOpenRows") {
    openImportRows().then(
      (rows) => sendResponse({ ok: true, rows }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }
  if (request.type === "importLinkCandidates") {
    importLinkCandidatesMany(request.items || [], request.page_url).then(
      (results) => sendResponse({ ok: true, results }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }
  if (request.type === "linkImportRow") {
    const item = request.item || {};
    if (!/^[at]\d+$/.test(String(item.id || ""))) {
      sendResponse({ ok: false, error: "not a Bandcamp track or album" });
      return false;
    }
    linkImportRow(request.batch_id, request.n, item, request.page_url).then(
      (row) => sendResponse({ ok: true, row }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }

  if (request.type === "serverStatus") {
    // For the popup: server URL, whether it answers, last sync/ownership.
    Promise.all([getServerUrl(), probeServer(), getStatus()]).then(([url, health, status]) =>
      sendResponse({ url, health, status })
    );
    return true;
  }

  if (request.type === "syncNow") {
    fullSync("manual", { force: true })
      .then(() => pullTagEdits())
      .then((r) => pullPendingAdds().then((adds) => ({ ...r, adds }), () => r))
      .then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (request.type === "getTags") {
    // The vocabulary, defensively unioned with every tag used by saved tracks so a dropdown can always represent
    // (and never drop) a track's tags.
    vocabulary().then(sendResponse);
    return true;
  }

  if (request.type === "addTag") {
    const name = (request.tag || "").trim();
    change((s) => {
      const current = Array.isArray(s.tags) ? s.tags : [];
      if (!name) return { skip: true, result: { ok: false, reason: "empty" } };
      if (current.includes(name)) return { skip: true, result: { ok: false, reason: "exists" } };
      const updated = [...current, name];
      return { values: { tags: updated }, result: { ok: true, tags: updated } };
    }).then(sendResponse);
    return true;
  }

  if (request.type === "updateTags") {
    setTags(Array.isArray(request.tags) ? request.tags : []).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

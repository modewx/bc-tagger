import {
  fullSync,
  getServerUrl,
  getStatus,
  probeServer,
  pullTagEdits,
  pullPendingAdds,
  importLinkCandidatesMany,
  linkImportRow,
  openImportRows,
  bandcampLimits,
  queueItemsDiff,
  queueTags,
  refreshOwnership,
  sameServerOrigin,
  syncTick,
  scheduleMembershipPush,
  refreshCollections,
  popupState,
  createCollection,
} from "./serverSync";
import { MAIN, queueMembership, forgetItem, setActive, readCollections } from "./collectionsStore";
import { serialized, withItems, getStorage, setStorage, nowIso, sameTags, fillOrder, nextOrder, orderFloor } from "./itemsStore";
import { isChallengePage } from "../../shared/bandcampChallenge";

// ---------------------------------------------------------------------------
// Tag vocabulary helpers
//
// Data lives in chrome.storage.local:
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

// Restore/maintain the complete vocabulary: tags.json ∪ existing ∪ used-by-tracks.
function ensureTagsComplete(cb) {
  const finish = (merged) => {
    chrome.storage.local.set({ tags: merged }, () => cb && cb(merged));
  };
  chrome.storage.local.get(["tags", "taggedItems"], ({ tags, taggedItems }) => {
    const existing = Array.isArray(tags) ? tags : [];
    const used = [...usedTagsFrom(taggedItems)];
    fetch(chrome.runtime.getURL("tags.json"))
      .then((response) => response.json())
      .then((seed) => finish(unionTags(seed, existing, used)))
      .catch(() => finish(unionTags(existing, used))); // still guarantee used tags
  });
}

// Push the current tag list to every tab so open Bandcamp pages can refresh
// their annotation dropdowns without a reload.
function broadcastTags(tags) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { type: "tagsUpdated", tags }, () => {
        void chrome.runtime.lastError; // ignore tabs with no content script
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Item updates (shared by the extension pages and the local app bridge)
// ---------------------------------------------------------------------------

// Merge refreshed stream URLs back in: { [id]: { "mp3-128": url } }.
function updateItemFiles(files) {
  return withItems((items) => {
    Object.entries(files || {}).forEach(([id, file]) => {
      if (items[id]) items[id].file = file;
    });
  });
}

// Merge rebuilt thumbnail URLs back in: { [id]: art_url }.
function updateItemArt(art) {
  return withItems((items) => {
    Object.entries(art || {}).forEach(([id, art_url]) => {
      if (items[id]) items[id].art_url = art_url;
    });
  });
}

// Merge arbitrary fields into items without reordering: { [id]: {..} }.
function updateItemFields(updates) {
  return withItems((items) => {
    Object.entries(updates || {}).forEach(([id, fields]) => {
      if (items[id] && fields && typeof fields === "object") {
        Object.assign(items[id], fields);
      }
    });
  });
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

// Starring / tagging on a Bandcamp page: a new item, or new tags, is a modification. `collection`: the collection it
// joins now (null: none named; the server puts a new one into the first collection). "#" is Collection's: a new
// item gets the next number when it joins Collection (or no collection is named), none (`order: null`) when it's
// starred into another one, until it joins Collection (setMembership); an item keeps its number.
async function saveTaggedItem(incoming, collection = null) {
  const floor = await orderFloor();
  const numbered = collection == null || collection === MAIN;
  const write = (items) => {
    const prev = items[incoming.id];
    const item = { ...incoming };
    item.modified_at = !prev || !sameTags(prev.tags, item.tags) ? nowIso() : prev.modified_at || item.modified_at;
    if (!item.modified_at) delete item.modified_at;
    fillOrder(items); // older items first, should they still have none
    if (prev && prev.order != null) item.order = prev.order;
    else item.order = numbered ? nextOrder(items, floor) : null;
    items[item.id] = item;
  };
  if (collection == null) return withItems(write);
  return queueMembership([{ op: "add", collection_id: collection, ids: [incoming.id] }], write);
}

// An item joins or leaves a collection (tags kept). Joining Collection numbers it, if it has no "#" yet.
async function setMembership(op, collection, id) {
  const floor = await orderFloor();
  const number =
    op === "add" && collection === MAIN
      ? (items) => {
          const it = items[id];
          if (!it || it.order != null) return false;
          fillOrder(items);
          it.order = nextOrder(items, floor);
        }
      : null;
  return queueMembership([{ op, collection_id: collection, ids: [id] }], number);
}

function updateItemTags(id, tags) {
  return withItems((items) => {
    if (!items[id]) return { ok: false, reason: "not-found" };
    const next = Array.isArray(tags) ? tags : [];
    if (!sameTags(items[id].tags, next)) items[id].modified_at = nowIso();
    items[id].tags = next;
    return { ok: true };
  });
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
  const floor = await orderFloor();
  // Read and write inside the queue so no other update lands in between.
  return serialized(async () => {
    const { taggedItems: existing = {}, tags: existingTags = [] } = await getStorage(["taggedItems", "tags"]);
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
    await setStorage({ taggedItems, tags });
    broadcastTags(tags);
    return { ok: true, items: Object.keys(taggedItems).length, tags: tags.length };
  });
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
    case "setItemTags": {
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
    default:
      throw new Error(`unknown op ${op}`);
  }
}

// ---------------------------------------------------------------------------
// Server sync triggers
// ---------------------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.taggedItems) queueItemsDiff(changes.taggedItems.oldValue, changes.taggedItems.newValue);
  if (changes.tags) queueTags();
  // A membership change on its own (an item that exists already joins or leaves a collection).
  const ops = changes.pendingMembership;
  if (ops && ((ops.newValue || []).length > (ops.oldValue || []).length)) scheduleMembershipPush();
  if (changes.bcServer) syncTick("server changed");
});

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
  chrome.storage.local.get("taggedItems", ({ taggedItems }) => {
    if (!taggedItems) {
      chrome.storage.local.set({ taggedItems: {} });
    }
  });
  ensureTagsComplete();
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
  if (request.type === "getTaggedItems") {
    chrome.storage.local.get("taggedItems", ({ taggedItems }) => {
      sendResponse(taggedItems || {});
    });
    return true;
  }

  if (request.type === "addTaggedItem") {
    saveTaggedItem(request.item, Number.isInteger(request.collection) ? request.collection : null);
    return false;
  }

  if (request.type === "setMembership") {
    // Starring (or tagging) an item that exists, or un-starring it, while a collection is shown.
    setMembership(request.op, request.collection, request.id).then(
      (r) => sendResponse(r && r.queued ? { ok: true } : { ok: false, error: "not a valid change" }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }

  if (request.type === "removeTaggedItem") {
    // Un-starring in All: the item and its tags go, from every collection.
    withItems((items) => {
      delete items[request.id];
    }).then(() => forgetItem(request.id));
    return false;
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
    // Return the vocabulary, defensively unioned with every tag used by saved
    // tracks so a dropdown can always represent (and never drop) a track's tags.
    chrome.storage.local.get(["tags", "taggedItems"], ({ tags, taggedItems }) => {
      const existing = Array.isArray(tags) ? tags : [];
      const used = [...usedTagsFrom(taggedItems)];
      const merged = unionTags(existing, used);

      if (merged.length > 0) {
        if (merged.length !== existing.length) {
          chrome.storage.local.set({ tags: merged });
        }
        sendResponse(merged);
      } else {
        // Nothing stored yet: seed from tags.json.
        fetch(chrome.runtime.getURL("tags.json"))
          .then((response) => response.json())
          .then((seed) => {
            const seeded = unionTags(seed, used);
            chrome.storage.local.set({ tags: seeded });
            sendResponse(seeded);
          })
          .catch(() => sendResponse(merged));
      }
    });
    return true;
  }

  if (request.type === "addTag") {
    const name = (request.tag || "").trim();
    chrome.storage.local.get("tags", ({ tags }) => {
      const current = Array.isArray(tags) ? tags : [];
      if (!name) {
        sendResponse({ ok: false, reason: "empty" });
        return;
      }
      if (current.includes(name)) {
        sendResponse({ ok: false, reason: "exists" });
        return;
      }
      const updated = [...current, name];
      chrome.storage.local.set({ tags: updated }, () => {
        broadcastTags(updated);
        sendResponse({ ok: true, tags: updated });
      });
    });
    return true;
  }

  if (request.type === "updateTags") {
    chrome.storage.local.set({ tags: request.tags }, () => {
      broadcastTags(request.tags);
    });
    return false;
  }

  return false;
});

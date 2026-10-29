// Collections in the extension (Phase 9). Tags stay per item (taggedItems); collections are membership only, and
// the server owns them. Kept by the worker's store (itemsStore.js: in memory, written to chrome.storage.local), so
// they survive an extension reload and show while the server is off:
//   collectionsCache   {version, list: [{id, name, pos, count, created_at}], members: {"<id>": [item ids]}}
//   activeCollection   "all" | a collection id: what the tagger shows and stars into
//   activeChosen       true once the user chose in the popup (since Phase 9b): a stored "all" without it is the old
//                      default, which is now the first collection
//   pendingMembership  [{op: "add"|"remove", collection_id, ids}]: changes made here the server hasn't accepted
// The cache shows the pending changes too (optimistic); a fresh read from the server gets them put back on top until
// the server has them.
//
// All (Phase 9b) is a special mode, never the default: a star puts the item into every collection, a star is filled
// when the item is in any, and un-starring deletes it (and its tags) from all of them.

import { change, read, rev } from "./itemsStore";
import { splitOps, withoutOps } from "./membershipOps";

export const ALL = "all";
export const MAIN = 0; // "Collection": its "#" is the items' `order`

const EMPTY = { version: null, list: [], members: {} };
const byPos = (a, b) => (a.pos ?? a.id) - (b.pos ?? b.id) || a.id - b.id;

const cacheOf = (s) => s.collectionsCache || EMPTY;
const pendingOf = (s) => (Array.isArray(s.pendingMembership) ? s.pendingMembership : []);
export const sortedList = (cache) => ((cache && cache.list) || []).slice().sort(byPos);

/**
 * What the tagger shows: a collection id, ALL (chosen in the popup), or null (no collection known yet: the server
 * was never reached; a star then only saves the item, and the server puts it into its first collection).
 * Default, and for a collection that's gone: the first collection (lowest pos, then id).
 */
export function activeOf(s) {
  const stored = s.activeCollection;
  if (stored === ALL && s.activeChosen) return ALL;
  const list = sortedList(cacheOf(s));
  if (Number.isInteger(stored) && list.some((c) => c.id === stored)) return stored;
  return list.length ? list[0].id : null;
}

export function readCollections() {
  return read((s) => ({ cache: cacheOf(s), active: activeOf(s), pending: pendingOf(s) }));
}

/** The collection a new item goes into when none is named: the first in list order (null: none known yet). */
export const firstCollection = (cache) => sortedList(cache)[0] || null;

// Item id → the ids of the collections it's in (numbers), rebuilt when the cache changes (it's replaced, not edited).
let indexed = null;
let index = new Map();
export function memberIndex(s) {
  const cache = cacheOf(s);
  if (indexed === cache) return index;
  index = new Map();
  Object.entries(cache.members || {}).forEach(([cid, ids]) =>
    ids.forEach((id) => {
      const have = index.get(id);
      if (have) have.push(Number(cid));
      else index.set(id, [Number(cid)]);
    })
  );
  indexed = cache;
  return index;
}

// All's count, as the app counts All: every item, the extension's and those only in a collection (Other items).
// Counted again only after a change (rev).
let countedAt = null;
let allCount = 0;
export function allCountOf(s) {
  if (countedAt === rev()) return allCount;
  let n = Object.keys(s.taggedItems).length;
  memberIndex(s).forEach((_, id) => !(id in s.taggedItems) && n++);
  countedAt = rev();
  allCount = n;
  return n;
}

/** `ops` applied to `members` (a copy). */
export function applyOps(members, ops) {
  const out = {};
  Object.entries(members || {}).forEach(([id, ids]) => (out[id] = ids.slice()));
  ops.forEach(({ op, collection_id: cid, ids }) => {
    const key = String(cid);
    const have = out[key] || (out[key] = []);
    if (op === "add") {
      const there = new Set(have);
      ids.forEach((i) => !there.has(i) && have.push(i));
    } else {
      const gone = new Set(ids);
      out[key] = have.filter((i) => !gone.has(i));
    }
  });
  return out;
}

// The list's counts from the members (the extension's view, its pending changes in).
function recount(cache) {
  return { ...cache, list: cache.list.map((c) => ({ ...c, count: (cache.members[String(c.id)] || []).length })) };
}

/**
 * Queue membership changes and show them at once. `writeItems(items, state)` (optional) changes the items in the same
 * change (one write, one push: a new item and its first membership go to the server together; the server would put
 * a new item with no membership into the first collection); `ids`: the items it changes (returning false: none).
 * A malformed op is never queued (the server would refuse the whole sync with it): it's logged and left out.
 * Resolves to {queued, dropped}.
 */
export function queueMembership(ops, writeItems = null, ids = []) {
  const { good, bad } = splitOps(ops);
  if (bad.length) console.warn("[collections] not queued (malformed):", bad);
  return change((s) => {
    const values = {};
    if (good.length) {
      const cache = cacheOf(s);
      values.pendingMembership = [...pendingOf(s), ...good];
      values.collectionsCache = recount({ ...cache, members: applyOps(cache.members, good) });
    }
    const wrote = writeItems ? writeItems(s.taggedItems, s) !== false : false;
    return { values, changed: wrote ? ids.filter((id) => id in s.taggedItems) : [], result: { queued: good.length, dropped: bad.length } };
  });
}

/** Un-starring in All: the item and its tags go, and from every collection (the server drops its memberships with it). */
export function removeItem(id) {
  return change((s) => {
    const had = id in s.taggedItems;
    delete s.taggedItems[id];
    const cache = cacheOf(s);
    const values = {};
    if ((memberIndex(s).get(id) || []).length) {
      const members = {};
      Object.entries(cache.members).forEach(([cid, ids]) => (members[cid] = ids.filter((i) => i !== id)));
      values.collectionsCache = recount({ ...cache, members });
    }
    return { deleted: had ? [id] : [], values };
  });
}

/** A fresh read from the server (`{version, collections, members}`), with what's still pending put back on top. */
export function storeFetched(fetched) {
  return change((s) => {
    const list = (fetched.collections || []).slice().sort(byPos);
    const cache = recount({ version: fetched.version ?? null, list, members: applyOps(fetched.members || {}, pendingOf(s)) });
    return { values: { collectionsCache: cache }, result: cache };
  });
}

/** Ops done with (the server took them, or they were dropped): out of the queue (anything queued since stays). */
export function removeQueued(done) {
  if (!done.length) return Promise.resolve();
  return change((s) => ({ values: { pendingMembership: withoutOps(pendingOf(s), done) } }));
}
export const acceptOps = removeQueued;

/** The popup's choice. */
export function setActive(v) {
  return change(() => ({ values: { activeCollection: v === ALL || v == null ? ALL : Number(v), activeChosen: true } }));
}

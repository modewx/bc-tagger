// Collections in the extension (Phase 9). Tags stay per item (taggedItems); collections are membership only, and
// the server owns them. Kept in chrome.storage.local, so they survive an extension reload and show while the
// server is off:
//   collectionsCache   {version, list: [{id, name, pos, count, created_at}], members: {"<id>": [item ids]}}
//   activeCollection   "all" | a collection id: what the tagger shows and stars into (default "all")
//   pendingMembership  [{op: "add"|"remove", collection_id, ids}]: changes made here the server hasn't accepted
// The cache shows the pending changes too (optimistic); a fresh read from the server gets them put back on top until
// the server has them.

import { serialized, getStorage, setStorage } from "./itemsStore";
import { splitOps, withoutOps } from "./membershipOps";

export const ALL = "all";
export const MAIN = 0; // "Collection": its "#" is the items' `order`

const EMPTY = { version: null, list: [], members: {} };
const byPos = (a, b) => (a.pos ?? a.id) - (b.pos ?? b.id) || a.id - b.id;

export async function readCollections() {
  const { collectionsCache, activeCollection, pendingMembership } = await getStorage([
    "collectionsCache",
    "activeCollection",
    "pendingMembership",
  ]);
  return {
    cache: collectionsCache || EMPTY,
    active: activeCollection == null ? ALL : activeCollection,
    pending: Array.isArray(pendingMembership) ? pendingMembership : [],
  };
}

/** The collection a new item starred in All goes into: the first in list order (null: none known yet). */
export const firstCollection = (cache) => ((cache && cache.list) || []).slice().sort(byPos)[0] || null;

/** `ops` applied to `members` (a copy). */
export function applyOps(members, ops) {
  const out = {};
  Object.entries(members || {}).forEach(([id, ids]) => (out[id] = ids.slice()));
  ops.forEach(({ op, collection_id: cid, ids }) => {
    const key = String(cid);
    const have = out[key] || (out[key] = []);
    if (op === "add") ids.forEach((i) => !have.includes(i) && have.push(i));
    else out[key] = have.filter((i) => !ids.includes(i));
  });
  return out;
}

// The list's counts from the members (the extension's view, its pending changes in).
function recount(cache) {
  return { ...cache, list: cache.list.map((c) => ({ ...c, count: (cache.members[String(c.id)] || []).length })) };
}

/**
 * Queue membership changes and show them at once. `items` (optional) is written in the same storage write, so a new
 * item and its first membership go to the server together (the server puts a new item with no membership into the
 * first collection). A malformed op is never queued (the server would refuse the whole sync with it): it's logged
 * and left out. Resolves to {queued, dropped}.
 */
export function queueMembership(ops, writeItems = null) {
  const { good, bad } = splitOps(ops);
  if (bad.length) console.warn("[collections] not queued (malformed):", bad);
  return serialized(async () => {
    const { cache, pending } = await readCollections();
    const values = {};
    if (good.length) {
      values.pendingMembership = [...pending, ...good];
      values.collectionsCache = recount({ ...cache, members: applyOps(cache.members, good) });
    }
    if (writeItems) {
      const { taggedItems } = await getStorage("taggedItems");
      const items = taggedItems || {};
      if (writeItems(items) !== false) values.taggedItems = items;
    }
    if (Object.keys(values).length) await setStorage(values);
    return { queued: good.length, dropped: bad.length };
  });
}

/** An item deleted here is in no collection any more (the server drops its memberships with it). */
export function forgetItem(id) {
  return serialized(async () => {
    const { cache } = await readCollections();
    const members = {};
    Object.entries(cache.members).forEach(([cid, ids]) => (members[cid] = ids.filter((i) => i !== id)));
    await setStorage({ collectionsCache: recount({ ...cache, members }) });
  });
}

/** A fresh read from the server (`{version, collections, members}`), with what's still pending put back on top. */
export function storeFetched(fetched) {
  return serialized(async () => {
    const { pending, active } = await readCollections();
    const list = (fetched.collections || []).slice().sort(byPos);
    const cache = recount({ version: fetched.version ?? null, list, members: applyOps(fetched.members || {}, pending) });
    const values = { collectionsCache: cache };
    // The collection shown was deleted elsewhere: All.
    if (active !== ALL && !list.some((c) => c.id === active)) values.activeCollection = ALL;
    await setStorage(values);
    return cache;
  });
}

/** Ops done with (the server took them, or they were dropped): out of the queue (anything queued since stays). */
export function removeQueued(done) {
  if (!done.length) return Promise.resolve();
  return serialized(async () => {
    const { pending } = await readCollections();
    await setStorage({ pendingMembership: withoutOps(pending, done) });
  });
}
export const acceptOps = removeQueued;

export function setActive(v) {
  return setStorage({ activeCollection: v === ALL || v == null ? ALL : Number(v) });
}

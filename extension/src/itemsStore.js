// The worker's store: the only reader and writer of the tagger's data in chrome.storage.local ("many to one"). Bandcamp
// tabs, the popup, the bundled collection page and the local app (through the bridge) are its clients: they send
// changes here and ask for what they show; none of them reads these keys or listens to storage.onChanged.
//
// Read once per worker life, then kept in memory: a change is applied there at once and written back with every
// other change since, in one chrome.storage.local.set, FLUSH_MS after the last one (at most MAX_WAIT_MS after the
// first). Until then each change is also in `opJournal`, a small key written at once: a worker stopped before the
// write loses nothing, the journal is replayed when the store is next read. Nothing listens to storage.onChanged,
// so a write is never copied (old and new value) to the open pages.

// Every change goes through one queue, so concurrent updates (a tag edit, a refreshed thumbnail, a sync pull, an
// import) can't overwrite each other, and a read asked for after a change sees it.
let queue = Promise.resolve();

// Run `fn` (sync or async) after every earlier queued task has finished.
export function serialized(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

function get(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function set(values) {
  return new Promise((resolve, reject) =>
    chrome.storage.local.set(values, () => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()))
  );
}

export { get as getStorage, set as setStorage };

const KEYS = ["taggedItems", "tags", "collectionsCache", "activeCollection", "activeChosen", "pendingMembership", "orderFloor"];
const PAGE_KEYS = new Set(["collectionsCache", "activeCollection", "activeChosen"]); // what pages show, besides items
const JOURNAL = "opJournal";
const FLUSH_MS = 400;
const MAX_WAIT_MS = 2000;
const BULK = 50; // more items than this changed at once (an import, a pull): written at once, not journaled

let state = null; // KEYS → values: storage, with the journal and every change since applied
let loading = null;
let dirty = new Set(); // keys changed since the last write
let journal = { items: {}, values: {} };
let flushTimer = null;
let firstChangeAt = 0;
const listeners = [];
const flushListeners = [];

// What pages compare to know whether anything they show changed (`rev`), or the tag list (`tagsRev`). The epoch
// keeps a page's copy from an earlier worker life from ever matching.
const epoch = Date.now().toString(36);
let revN = 0;
let tagsRevN = 0;
export const rev = () => `${epoch}.${revN}`;
export const tagsRev = () => `${epoch}.${tagsRevN}`;

/** `fn({changed, deleted, keys})` after each change (server pushes; the journal's replay too). */
export function onStoreChange(fn) {
  listeners.push(fn);
}

/** `fn({keys, ms})` after each write. */
export function onFlush(fn) {
  flushListeners.push(fn);
}

/** The store, read from storage once per worker life (the journal replayed). */
export function load() {
  if (state) return Promise.resolve(state);
  if (!loading) {
    loading = get([...KEYS, JOURNAL]).then((got) => {
      const s = {};
      KEYS.forEach((k) => (s[k] = got[k]));
      if (!s.taggedItems || typeof s.taggedItems !== "object") {
        s.taggedItems = {};
        dirty.add("taggedItems");
      }
      state = s;
      const j = got[JOURNAL];
      if (j && typeof j === "object") replay(j);
      if (dirty.size) scheduleFlush(0);
      return state;
    });
  }
  return loading;
}

// Changes a stopped worker made but never wrote: applied again, written, and pushed.
function replay(j) {
  const changed = [];
  const deleted = [];
  Object.entries(j.items || {}).forEach(([id, item]) => {
    if (item && typeof item === "object") {
      state.taggedItems[id] = item;
      changed.push(id);
    } else {
      delete state.taggedItems[id];
      deleted.push(id);
    }
  });
  const values = j.values && typeof j.values === "object" ? j.values : {};
  if (!changed.length && !deleted.length && !Object.keys(values).length) return;
  console.log(`[store] replayed the journal: ${changed.length} items changed, ${deleted.length} deleted, ${Object.keys(values).join(", ") || "no other keys"}`);
  commit({ changed, deleted, values }, { journaled: true });
}

// Apply a change's bookkeeping (the items themselves are changed already): versions, journal, listeners, the write.
function commit({ changed = [], deleted = [], values = {} }, { journaled = false } = {}) {
  const keys = Object.keys(values);
  if (!changed.length && !deleted.length && !keys.length) return;
  keys.forEach((k) => {
    state[k] = values[k];
    dirty.add(k);
    journal.values[k] = values[k];
  });
  changed.forEach((id) => (journal.items[id] = state.taggedItems[id]));
  deleted.forEach((id) => (journal.items[id] = null));
  if (changed.length || deleted.length) dirty.add("taggedItems");
  if (changed.length || deleted.length || keys.some((k) => PAGE_KEYS.has(k))) revN++;
  if (keys.includes("tags")) tagsRevN++;
  listeners.forEach((fn) => {
    try {
      fn({ changed, deleted, keys });
    } catch (e) {
      console.warn("[store] listener", e);
    }
  });
  if (Object.keys(journal.items).length > BULK) {
    flush();
    return;
  }
  if (!journaled) set({ [JOURNAL]: journal }).catch((e) => console.warn("[store] journal not written", e.message));
  scheduleFlush();
}

function scheduleFlush(delay = FLUSH_MS) {
  const now = Date.now();
  if (!firstChangeAt) firstChangeAt = now;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, Math.max(0, Math.min(delay, firstChangeAt + MAX_WAIT_MS - now)));
}

/** Write every change so far (one chrome.storage.local.set, the journal emptied in the same write). */
export function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  firstChangeAt = 0;
  if (!state || !dirty.size) return Promise.resolve();
  const values = {};
  dirty.forEach((k) => (values[k] = state[k]));
  values[JOURNAL] = null;
  const keys = [...dirty];
  dirty = new Set();
  journal = { items: {}, values: {} };
  const t0 = performance.now();
  // The values are copied when set() is called: changes made while it's written go into the next write.
  return set(values).then(
    () => {
      const ms = Math.round(performance.now() - t0);
      flushListeners.forEach((fn) => fn({ keys, ms, startedAt: Date.now() - ms }));
    },
    (e) => {
      // Not written (the journal neither): kept for the next write.
      console.warn("[store] not written, retrying", e.message);
      keys.forEach((k) => dirty.add(k));
      scheduleFlush(5000);
    }
  );
}

/**
 * One change to the store, in the queue: `fn(state)` (may be async) changes `state.taggedItems` in place and returns
 * `{changed: [ids], deleted: [ids], values: {key: new value}, result}` (`skip: true`: nothing changed). Resolves to
 * `result`.
 */
export function change(fn) {
  return serialized(async () => {
    const s = await load();
    const out = (await fn(s)) || {};
    if (!out.skip) commit(out);
    return out.result;
  });
}

/** A read in the queue: after every change asked for before it. */
export function read(fn) {
  return serialized(async () => fn(await load()));
}

// Each item as JSON, to tell afterwards which ones a change touched.
function snapshot(items) {
  const out = {};
  Object.keys(items).forEach((id) => (out[id] = JSON.stringify(items[id])));
  return out;
}

function diff(before, items) {
  const changed = Object.keys(items).filter((id) => before[id] !== JSON.stringify(items[id]));
  const deleted = Object.keys(before).filter((id) => !(id in items));
  return { changed, deleted };
}

/**
 * Read-modify-write taggedItems: `mutate(items, state)` changes them in place and returns the response ({ok: false, ...}:
 * nothing to keep). `ids`: the items it can change (an array, read after `mutate`, so it may fill it in), else every
 * item is compared before and after (bulk changes).
 */
export function withItems(mutate, ids = null) {
  return change((s) => {
    const before = ids ? null : snapshot(s.taggedItems);
    const result = mutate(s.taggedItems, s);
    if (ids && result && result.ok === false) return { skip: true, result };
    const { changed, deleted } = ids
      ? { changed: ids.filter((id) => id in s.taggedItems), deleted: ids.filter((id) => !(id in s.taggedItems)) }
      : diff(before, s.taggedItems);
    return { changed, deleted, result: result || { ok: true } };
  });
}

/** All the items at once (an import, a test's setup): replaced, the differences pushed, written at once. */
export function replaceItems(items, values = {}) {
  return change((s) => {
    const before = snapshot(s.taggedItems);
    s.taggedItems = items;
    return { ...diff(before, items), values };
  }).then(flush);
}

/** Other keys (the tag list, the collections), as a change. */
export function setValues(values) {
  return change(() => ({ values }));
}

/** The items (the store's own object: read it, don't change it). */
export const currentItems = () => read((s) => s.taggedItems);

// modified_at: when an item's tags last changed (ISO, like date_added).
export const nowIso = () => new Date().toISOString();
export const sameTags = (a, b) => {
  const x = new Set(a || []);
  const y = new Set(b || []);
  return x.size === y.size && [...x].every((t) => y.has(t));
};
// The later of two ISO dates (either may be missing).
export const laterIso = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

// "#": each item's explicit place in the collection (`order`: 1, 2, …), one
// sequence with the server's Other items. The server reports its highest as
// health.max_order (kept here as `orderFloor`), so new items go after both.
export function maxOrder(items) {
  let max = 0;
  Object.values(items || {}).forEach((it) => {
    if (it && Number.isFinite(it.order) && it.order > max) max = it.order;
  });
  return max;
}

// Number the items that have no `order` yet from 1 up, skipping numbers in
// use, in storage order (what "#" showed before it was explicit). The server
// numbers imports above its Bandcamp item count, so 1..N stay free for these.
// `order: null` is on purpose: an item starred into another collection than
// "Collection" (Phase 9), numbered only if it joins "Collection". Returns how many;
// their ids go into `numbered` when given.
export function fillOrder(items, numbered = null) {
  const taken = new Set();
  Object.values(items).forEach((it) => it && Number.isFinite(it.order) && taken.add(it.order));
  let next = 0;
  let n = 0;
  Object.entries(items).forEach(([id, it]) => {
    if (it && typeof it === "object" && it.order === undefined) {
      do next++;
      while (taken.has(next));
      it.order = next;
      n++;
      if (numbered) numbered.push(id);
    }
  });
  return n;
}

// A new item's number: after everything here and on the server.
export const nextOrder = (items, floor) => Math.max(maxOrder(items), floor || 0) + 1;

export const orderFloorOf = (s) => (Number.isFinite(s.orderFloor) ? s.orderFloor : 0);

export async function orderFloor() {
  return orderFloorOf(await load());
}

export function setOrderFloor(floor) {
  return change((s) => (s.orderFloor === floor ? { skip: true } : { values: { orderFloor: floor } }));
}

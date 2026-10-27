// Every read-modify-write of chrome.storage.local in the background goes
// through one queue, so concurrent updates (a tag edit, a refreshed
// thumbnail, a sync pull, an import) can't overwrite each other.

let queue = Promise.resolve();

// Run `fn` (sync or async) after every earlier queued write has finished.
export function serialized(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

function get(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function set(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

// Read-modify-write taggedItems; `mutate(items)` changes them in place and
// returns the response ({ok: false, ...} skips the write).
export function withItems(mutate) {
  return serialized(async () => {
    const { taggedItems } = await get("taggedItems");
    const items = taggedItems || {};
    const result = mutate(items);
    if (result && result.ok === false) return result;
    await set({ taggedItems: items });
    return result || { ok: true };
  });
}

export { get as getStorage, set as setStorage };

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
// Returns how many.
export function fillOrder(items) {
  const taken = new Set();
  Object.values(items).forEach((it) => it && Number.isFinite(it.order) && taken.add(it.order));
  let next = 0;
  let n = 0;
  Object.values(items).forEach((it) => {
    if (it && typeof it === "object" && !Number.isFinite(it.order)) {
      do next++;
      while (taken.has(next));
      it.order = next;
      n++;
    }
  });
  return n;
}

// A new item's number: after everything here and on the server.
export const nextOrder = (items, floor) => Math.max(maxOrder(items), floor || 0) + 1;

export async function orderFloor() {
  const { orderFloor: floor } = await get("orderFloor");
  return Number.isFinite(floor) ? floor : 0;
}

export async function setOrderFloor(floor) {
  if ((await orderFloor()) !== floor) await set({ orderFloor: floor });
}

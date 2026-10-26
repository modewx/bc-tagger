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

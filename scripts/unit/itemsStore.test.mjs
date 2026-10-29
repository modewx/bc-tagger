// The worker's store (extension/src/itemsStore.js) on a fake chrome.storage.local: changes are kept in memory and
// written together, a journal covers a worker stopped before the write, and nothing is lost or written twice.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";

// chrome.storage.local as Chrome keeps it: values copied in and out (as JSON); every set recorded.
const disk = {};
const sets = [];
globalThis.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get(keys, cb) {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => k in disk && (out[k] = JSON.parse(JSON.stringify(disk[k]))));
        setTimeout(() => cb(out), 1);
      },
      set(values, cb) {
        sets.push(Object.keys(values).sort());
        Object.entries(values).forEach(([k, v]) => (disk[k] = JSON.parse(JSON.stringify(v))));
        setTimeout(() => cb && cb(), 1);
      },
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
// A fresh copy of the module: what a restarted worker runs.
const freshStore = () => import(`../../extension/src/itemsStore.js?worker=${++n}`);
const reset = (values) => {
  Object.keys(disk).forEach((k) => delete disk[k]);
  Object.assign(disk, JSON.parse(JSON.stringify(values)));
  sets.length = 0;
};

test("changes are applied in memory at once and written together, once, after the last one (the journal emptied in the same write)", async () => {
  reset({ taggedItems: { a: { id: "a", tags: [] } }, tags: ["x"] });
  const store = await freshStore();
  const seen = [];
  store.onStoreChange((c) => seen.push(c));
  await store.withItems((items) => void (items.b = { id: "b", tags: ["x"] }), ["b"]);
  await store.withItems((items) => void (items.a.tags = ["x"]), ["a"]);
  assert.deepEqual(Object.keys(await store.currentItems()).sort(), ["a", "b"], "in memory at once");
  assert.deepEqual(seen.map((c) => c.changed), [["b"], ["a"]], "each change says which items it touched");
  assert.equal(disk.taggedItems.b, undefined, "not written yet");
  assert.deepEqual(Object.keys(disk.opJournal.items).sort(), ["a", "b"], "both in the journal");
  await sleep(600);
  assert.deepEqual(Object.keys(disk.taggedItems).sort(), ["a", "b"]);
  assert.equal(disk.opJournal, null, "the journal emptied with the write");
  const writes = sets.filter((k) => k.includes("taggedItems"));
  assert.equal(writes.length, 1, `one write of the items: ${JSON.stringify(sets)}`);
  assert.deepEqual(writes[0], ["opJournal", "taggedItems"]);
});

test("a worker stopped before the write loses nothing: the next one replays the journal, writes it and pushes it", async () => {
  reset({ taggedItems: { a: { id: "a", tags: [] }, gone: { id: "gone" } }, collectionsCache: { version: 1, list: [], members: {} } });
  const first = await freshStore();
  await first.withItems((items) => void (items.c = { id: "c", tags: ["new"] }), ["c"]);
  await first.withItems((items) => void delete items.gone, ["gone"]);
  await first.setValues({ collectionsCache: { version: 1, list: [{ id: 0, name: "Collection" }], members: { 0: ["c"] } } });
  // Stopped here: the items never written, only the journal.
  assert.equal(disk.taggedItems.c, undefined);
  assert.ok(disk.opJournal);
  const second = await freshStore();
  const seen = [];
  second.onStoreChange((c) => seen.push(c));
  const items = await second.currentItems();
  assert.deepEqual(Object.keys(items).sort(), ["a", "c"]);
  assert.deepEqual((await second.read((s) => s.collectionsCache)).members, { 0: ["c"] });
  assert.deepEqual(seen, [{ changed: ["c"], deleted: ["gone"], keys: ["collectionsCache"] }], "the replayed changes go to the server like any");
  await sleep(100);
  assert.deepEqual(Object.keys(disk.taggedItems).sort(), ["a", "c"], "written at once");
  assert.equal(disk.opJournal, null);
  await sleep(500); // (the first copy isn't really stopped: its own write, the same, lands before the next test)
});

test("a read waits for the changes asked before it; the version moves only when what pages show changed", async () => {
  reset({ taggedItems: {} });
  const store = await freshStore();
  const before = store.rev();
  const tagsBefore = store.tagsRev();
  const write = store.withItems((items) => void (items.d = { id: "d" }), ["d"]);
  const seen = await store.read((s) => "d" in s.taggedItems);
  await write;
  assert.equal(seen, true);
  assert.notEqual(store.rev(), before);
  const after = store.rev();
  await store.setValues({ orderFloor: 7 });
  assert.equal(store.rev(), after, "the order floor isn't shown by pages");
  assert.equal(store.tagsRev(), tagsBefore);
  await store.setValues({ tags: ["y"] });
  assert.notEqual(store.tagsRev(), tagsBefore);
  await store.flush();
});

test("bulk changes (an import) are written at once, not journaled", async () => {
  reset({ taggedItems: {} });
  const store = await freshStore();
  const many = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`t${i}`, { id: `t${i}` }]));
  await store.replaceItems(many, { tags: ["z"] });
  assert.equal(Object.keys(disk.taggedItems).length, 120);
  assert.deepEqual(disk.tags, ["z"]);
  assert.ok(!sets.some((k) => k.length === 1 && k[0] === "opJournal"), `no journal write: ${JSON.stringify(sets)}`);
});

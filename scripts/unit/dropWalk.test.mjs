// Unit tests for the dropped-folder walker (app/src/dropWalk.js), on a fake tree of FileSystemEntry-like objects:
// readEntries in batches, breadth first, a sample of audio files {rel, size}, the count with its cap and time budget,
// and the paths a drop carries as text. Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { walkFolder, readAll, droppedPaths, isAudio, baseName } from "../../app/src/dropWalk.js";

// A fake entry tree: {name: size} for a file, {name: {...}} for a folder. readEntries hands out `batch` at a time,
// then an empty batch (as Chrome does); `reads` counts its calls.
function tree(name, spec, opts = {}) {
  const batch = opts.batch || 3;
  const stats = opts.stats || { reads: 0, files: 0 };
  const entry = {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      const children = Object.entries(spec).map(([n, v]) =>
        typeof v === "object"
          ? tree(n, v, { ...opts, stats })
          : {
              name: n,
              isFile: true,
              isDirectory: false,
              file(ok) {
                stats.files++;
                setTimeout(() => ok({ size: v }), 0);
              },
            }
      );
      let at = 0;
      return {
        readEntries(ok) {
          stats.reads++;
          setTimeout(() => {
            const out = children.slice(at, at + batch);
            at += out.length;
            ok(out);
          }, 0);
        },
      };
    },
  };
  entry.stats = stats;
  return entry;
}

test("readAll: reads every batch until an empty one", async () => {
  const spec = Object.fromEntries([...Array(10)].map((_, i) => [`${String(i).padStart(2, "0")}.flac`, i]));
  const dir = tree("Many", spec, { batch: 4 });
  const all = await readAll(dir);
  assert.equal(all.length, 10);
  assert.equal(dir.stats.reads, 4, "4 + 4 + 2, then the empty one");
});

test("walkFolder: breadth first, audio files only, hidden ones skipped, paths relative to the folder", async () => {
  const dir = tree("Artist - Album", {
    "02 Two.aiff": 200,
    "01 One.flac": 100,
    "cover.jpg": 5,
    ".DS_Store": 1,
    "._01 One.flac": 1,
    ".hidden": { "x.mp3": 9 },
    CD2: { "01 Deep.mp3": 300, Bonus: { "01 Deepest.wav": 400 } },
    "CD1.5": { "01 Mid.m4a": 250 },
  });
  const w = await walkFolder(dir);
  assert.equal(w.name, "Artist - Album");
  assert.deepEqual(w.files, [
    { rel: "01 One.flac", size: 100 },
    { rel: "02 Two.aiff", size: 200 },
    { rel: "CD1.5/01 Mid.m4a", size: 250 },
    { rel: "CD2/01 Deep.mp3", size: 300 },
    { rel: "CD2/Bonus/01 Deepest.wav", size: 400 },
  ]);
  assert.equal(w.count, 5);
  assert.equal(w.capped, false);
});

test("walkFolder: a sample of 25, every audio file counted; file() asked for the sample only", async () => {
  const spec = {};
  for (let d = 0; d < 4; d++) {
    const sub = {};
    for (let i = 0; i < 10; i++) sub[`${String(i).padStart(2, "0")} t.flac`] = d * 100 + i;
    spec[`Disc ${d}`] = sub;
  }
  const dir = tree("Box set", spec, { batch: 7 });
  const w = await walkFolder(dir);
  assert.equal(w.files.length, 25);
  assert.equal(w.files[0].rel, "Disc 0/00 t.flac");
  assert.equal(w.files[24].rel, "Disc 2/04 t.flac");
  assert.equal(w.count, 40);
  assert.equal(dir.stats.files, 25, "no size read past the sample");
  assert.equal(w.capped, false);
});

test("walkFolder: counting stops at the cap, or past the time budget (capped)", async () => {
  const spec = {};
  for (let d = 0; d < 5; d++) spec[`D${d}`] = Object.fromEntries([...Array(20)].map((_, i) => [`${i}.mp3`, i]));
  const capped = await walkFolder(tree("Big", spec), { cap: 30 });
  assert.equal(capped.capped, true);
  assert.ok(capped.count >= 30 && capped.count < 100, `stopped near the cap: ${capped.count}`);

  let t = 0;
  const now = () => (t += 400); // each look at the clock: 400 ms later
  const slow = await walkFolder(tree("Slow", spec), { budgetMs: 1000, now });
  assert.equal(slow.capped, true);
  assert.ok(slow.count < 100, `stopped by the budget: ${slow.count}`);
  assert.equal(slow.files.length, Math.min(25, slow.count));
});

test("walkFolder: an empty folder, or one with no audio", async () => {
  assert.deepEqual(await walkFolder(tree("Empty", {})), { name: "Empty", files: [], count: 0, capped: false });
  assert.deepEqual(await walkFolder(tree("Art", { "a.jpg": 1, scans: { "b.png": 2 } })), { name: "Art", files: [], count: 0, capped: false });
});

test("walkFolder: an unreadable subfolder counts as empty; a file whose size can't be read has size null", async () => {
  const dir = tree("Mixed", { "01 a.flac": 10, Locked: { "x.flac": 1 } });
  const reader = dir.createReader;
  dir.createReader = () => {
    const r = reader();
    const read = r.readEntries;
    r.readEntries = (ok, fail) =>
      read((batch) => {
        batch.forEach((e) => {
          if (e.name === "Locked") e.createReader = () => ({ readEntries: (_ok, bad) => bad(new Error("denied")) });
          if (e.name === "01 a.flac") e.file = (_ok, bad) => bad(new Error("gone"));
        });
        ok(batch);
      }, fail);
    return r;
  };
  const w = await walkFolder(dir);
  assert.deepEqual(w.files, [{ rel: "01 a.flac", size: null }]);
  assert.equal(w.count, 1);
});

test("droppedPaths: file:// URLs (decoded, comments and other URLs skipped), else absolute paths in plain text", () => {
  assert.deepEqual(
    droppedPaths("# a comment\r\nfile:///Users/me/Music/A%20B%20(2026)/\r\nhttps://example.com/x\r\nfile://localhost/Volumes/Drive/C%C3%A9line", ""),
    ["/Users/me/Music/A B (2026)", "/Volumes/Drive/Céline"]
  );
  assert.deepEqual(droppedPaths("file://otherhost/share/x", "/Users/me/Plain/"), ["/Users/me/Plain"], "a remote host's file URL isn't a path here");
  assert.deepEqual(droppedPaths("", "/Users/me/One\n/Users/me/Two\nnot a path"), ["/Users/me/One", "/Users/me/Two"]);
  assert.deepEqual(droppedPaths("", "relative/path"), []);
  assert.deepEqual(droppedPaths(undefined, undefined), []);
  assert.deepEqual(droppedPaths("file:///", ""), ["/"]);
});

test("isAudio / baseName", () => {
  assert.equal(isAudio("01 Track.FLAC"), true);
  assert.equal(isAudio("x.aif"), true);
  assert.equal(isAudio("cover.jpg"), false);
  assert.equal(isAudio("Vol. 2"), false);
  assert.equal(isAudio("flac"), false);
  assert.equal(baseName("/Users/me/Music/Album/"), "Album");
  assert.equal(baseName("Album"), "Album");
});

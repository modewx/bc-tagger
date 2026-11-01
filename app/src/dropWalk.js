// Folders dropped from Finder (folderDrop.js): what the browser lets a page see of them. Never a folder's absolute
// path, so the server finds it (POST /api/fs/find-folder) by its name plus a sample of its audio files' paths
// relative to it and sizes. Nothing is read or uploaded: entry.file() only gives the size.
// No DOM here (unit-tested with fake entries: scripts/unit/dropWalk.test.mjs).

// As the server's (tagread.AUDIO_EXTS).
export const AUDIO_EXTS = new Set([".aif", ".aiff", ".flac", ".wav", ".mp3", ".m4a", ".mp4", ".alac", ".ogg", ".opus"]);

export function isAudio(name) {
  const m = /\.[^./]+$/.exec(String(name || ""));
  return !!m && AUDIO_EXTS.has(m[0].toLowerCase());
}

const hidden = (name) => String(name || "").startsWith(".");

// A folder's entries: readEntries gives them in batches (about 100 at a time), until an empty one.
export function readAll(dir) {
  const reader = dir.createReader();
  const all = [];
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

const sizeOf = (entry) =>
  new Promise((resolve) => entry.file((f) => resolve(f.size), () => resolve(null)));

/**
 * A dropped folder, breadth first: up to `sample` audio files as {rel, size} (the first found: the top level's
 * first), and how many audio files it has, counting up to `cap` or for `budgetMs` (then `capped`).
 * Hidden files and folders are skipped.
 * @returns {Promise<{name: string, files: {rel: string, size: number|null}[], count: number, capped: boolean}>}
 */
export async function walkFolder(dir, { sample = 25, cap = 5000, budgetMs = 1000, now = () => Date.now() } = {}) {
  const t0 = now();
  const files = [];
  let count = 0;
  let capped = false;
  const queue = [{ dir, prefix: "" }];
  while (queue.length && !capped) {
    const { dir: d, prefix } = queue.shift();
    let entries;
    try {
      entries = await readAll(d);
    } catch (e) {
      continue; // unreadable: counted as empty
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const want = [];
    for (const e of entries) {
      if (hidden(e.name)) continue;
      if (e.isDirectory) queue.push({ dir: e, prefix: `${prefix}${e.name}/` });
      else if (e.isFile && isAudio(e.name)) {
        count++;
        if (files.length + want.length < sample) want.push({ e, rel: prefix + e.name });
      }
    }
    const sizes = await Promise.all(want.map(({ e }) => sizeOf(e)));
    want.forEach(({ rel }, i) => files.push({ rel, size: sizes[i] }));
    if (count >= cap || now() - t0 > budgetMs) capped = true;
  }
  return { name: dir.name, files, count, capped };
}

// The absolute paths a drop carries as text (another app's drag, or a test's): file:// URLs in text/uri-list, or
// absolute paths in text/plain, one per line. Trailing slashes dropped.
export function droppedPaths(uriList, plain) {
  const trim = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const fromUris = String(uriList || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      try {
        const u = new URL(l);
        return u.protocol === "file:" && (!u.host || u.host === "localhost") ? decodeURIComponent(u.pathname) : null;
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
  if (fromUris.length) return [...new Set(fromUris.map(trim))];
  const fromText = String(plain || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("/"));
  return [...new Set(fromText.map(trim))];
}

export const baseName = (p) => String(p || "").replace(/\/+$/, "").split("/").pop();

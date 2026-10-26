#!/usr/bin/env node
// Dev/test harness: serve a built extension folder over plain HTTP so its pages
// (e.g. collection.html) can be opened in any browser, with a stub `chrome`
// API backed by an export JSON ({taggedItems, tags}). Writes stay in memory
// (per page load). Bandcamp fetches from the page fail (CORS), as expected
// outside the extension.
//
//   node scripts/ext-page-harness.js --build extension/build \
//     --data ../tagger-test-db/bc-tagger-export-2026-10-26.json --port 8790
//   then open http://127.0.0.1:8790/collection.html

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const buildDir = path.resolve(args.build || 'extension/build');
const dataFile = args.data ? path.resolve(args.data) : null;
const port = Number(args.port || process.env.PORT || 8790);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.map': 'application/json',
};

// Runs in the page before the extension scripts.
const STUB = `
(function () {
  const listeners = [];
  let db = { taggedItems: {}, tags: [] };
  const ready = fetch("/__stub/data.json").then((r) => r.json()).then((d) => { db = d; });
  function set(patch) {
    const changes = {};
    Object.keys(patch).forEach((k) => { changes[k] = { oldValue: db[k], newValue: patch[k] }; db[k] = patch[k]; });
    listeners.forEach((cb) => cb(changes, "local"));
  }
  function handle(msg) {
    const items = db.taggedItems;
    switch (msg.type) {
      case "getTaggedItems": return JSON.parse(JSON.stringify(items));
      case "getTags": return db.tags;
      case "updateTags": set({ tags: msg.tags }); return undefined;
      case "updateTaggedItemTags":
        if (!items[msg.id]) return { ok: false, reason: "not-found" };
        items[msg.id].tags = msg.tags; set({ taggedItems: items }); return { ok: true };
      case "updateTaggedItemFiles":
        Object.entries(msg.files || {}).forEach(([id, f]) => { if (items[id]) items[id].file = f; });
        set({ taggedItems: items }); return { ok: true };
      case "updateTaggedItemArt":
        Object.entries(msg.art || {}).forEach(([id, a]) => { if (items[id]) items[id].art_url = a; });
        set({ taggedItems: items }); return { ok: true };
      case "updateTaggedItemFields":
        Object.entries(msg.updates || {}).forEach(([id, f]) => { if (items[id]) Object.assign(items[id], f); });
        set({ taggedItems: items }); return { ok: true };
      default: return undefined;
    }
  }
  window.__stubLog = [];
  window.chrome = {
    runtime: {
      id: "stub",
      lastError: undefined,
      getURL: (p) => "/" + String(p).replace(/^\\//, ""),
      getManifest: () => ({ name: "Bc Tagger (stub)", version: "0" }),
      sendMessage(msg, cb) {
        window.__stubLog.push(msg);
        ready.then(() => { const res = handle(msg); if (cb) setTimeout(() => cb(res), 0); });
      },
      onMessage: { addListener() {} },
    },
    storage: {
      onChanged: { addListener: (cb) => listeners.push(cb) },
      local: { get: (k, cb) => ready.then(() => cb(db)), set: (o, cb) => { set(o); cb && cb(); } },
    },
    tabs: { query: (q, cb) => cb([]), create: ({ url }) => window.open(url) },
  };
})();
`;

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__stub/chrome.js') {
      res.writeHead(200, { 'Content-Type': TYPES['.js'] });
      return res.end(STUB);
    }
    if (url.pathname === '/__stub/data.json') {
      res.writeHead(200, { 'Content-Type': TYPES['.json'] });
      return res.end(dataFile ? fs.readFileSync(dataFile) : '{"taggedItems":{},"tags":[]}');
    }
    const file = path.join(buildDir, decodeURIComponent(url.pathname));
    if (!file.startsWith(buildDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = path.extname(file);
    let body = fs.readFileSync(file);
    if (ext === '.html') {
      body = body.toString().replace('<head>', '<head>\n<script src="/__stub/chrome.js"></script>');
    }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`extension page harness: http://127.0.0.1:${port}/collection.html (build: ${buildDir})`);
  });

// End-to-end tests for the extension + local server + local app, in a
// Playwright-controlled Chromium with its own throwaway profile (never the
// user's Chrome or the dev extension's storage).
//
//   npm run test:e2e                 (HEADED=1 to watch it)
//
// It builds "Bc Tagger (e2e)" into .e2e/extension (default server
// http://127.0.0.1:8767), starts server/bct on :8767 with a fresh data dir in
// .e2e/server-data (seeded from the export JSON), and loads the export through
// the extension's Import page.
// Nothing here writes rekordbox or touches :8765 / :8766, and nothing reaches
// Bandcamp: its hosts don't resolve in this browser, and the pages the tests
// need are recorded fixtures (scripts/e2e/fixtures/bandcamp). A Bandcamp
// request with no fixture fails the test that made it.

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { importStub } from "./importStub.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const E2E = path.join(ROOT, ".e2e");
const EXT_DIR = path.join(E2E, "extension");
const PROFILE = path.join(E2E, "profile");
const SERVER_DATA = path.join(E2E, "server-data");
const PORT = Number(process.env.E2E_PORT || 8767);
const SERVER = `http://127.0.0.1:${PORT}`;
const EXPORT_JSON =
  process.env.E2E_EXPORT_JSON ||
  "/Users/alvaroh/Projects/auto-rekordbox/tagger-test-db/bc-tagger-export-2026-10-26.json";
const ITEM = "t283914533"; // "The System Works", in the export

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exportData = JSON.parse(fs.readFileSync(EXPORT_JSON, "utf8"));
const exportCount = Object.keys(exportData.taggedItems).length;

let server, context, extId, probe;

async function api(p, init) {
  const res = await fetch(SERVER + p, init);
  return res.json();
}
const post = (p, body) =>
  api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function waitFor(fn, { timeout = 15000, interval = 250, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

// chrome.storage of the e2e extension, read from one of its own pages.
const storage = (keys) => probe.evaluate((k) => chrome.storage.local.get(k), keys);
const itemTags = async (id) => ((await storage("taggedItems")).taggedItems[id] || {}).tags;

function extPage(name) {
  return `chrome-extension://${extId}/${name}`;
}

// --- Recorded Bandcamp ------------------------------------------------------------
// Bandcamp answers automated browsers with a bot check, so the tests never go
// there. Pages and API answers come from FIXTURES/index.json (URL → file or
// status); streams, images and other embedded players get stand-ins, and so do
// other release pages (the collection pages fetch one for a row with no art as
// it scrolls into view): a page with no data, recorded in standInPages so a
// test can assert it fetched none. Anything else is blocked and fails the test
// that asked for it.

const FIXTURES = path.join(ROOT, "scripts/e2e/fixtures/bandcamp");
const fixtureIndex = JSON.parse(fs.readFileSync(path.join(FIXTURES, "index.json"), "utf8"));
const BANDCAMP_URL = /^https?:\/\/([a-z0-9-]+\.)*(bandcamp\.com|bcbits\.com)(:\d+)?\//i;
const NO_BANDCAMP_DNS = "MAP bandcamp.com ~NOTFOUND, MAP *.bandcamp.com ~NOTFOUND, MAP *.bcbits.com ~NOTFOUND";
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const escapedRequests = []; // Bandcamp requests with no fixture
const standInPages = []; // release pages answered with the no-data stand-in

// One second of 8 kHz 8-bit silence.
function silentWav(rate = 8000) {
  const b = Buffer.alloc(44 + rate, 128);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + rate, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(rate, 40);
  return b;
}
const SILENCE = silentWav();

function bandcampFixture(url) {
  const u = new URL(url);
  const entry = fixtureIndex[u.origin + u.pathname];
  if (entry) {
    if (entry.status) return { status: entry.status, contentType: "text/html", body: "Not found (e2e fixture)" };
    return {
      status: 200,
      contentType: entry.type || "text/html; charset=utf-8",
      body: fs.readFileSync(path.join(FIXTURES, entry.file)),
    };
  }
  if (/\.bcbits\.com$/.test(u.host) && u.pathname.startsWith("/img/")) return { status: 200, contentType: "image/png", body: PIXEL };
  if (/\.bcbits\.com$/.test(u.host) && u.pathname.startsWith("/stream/")) return { status: 200, contentType: "audio/wav", body: SILENCE };
  if (u.host === "bandcamp.com" && u.pathname === "/stream_redirect") return { status: 200, contentType: "audio/wav", body: SILENCE };
  if (u.host === "bandcamp.com" && u.pathname.startsWith("/EmbeddedPlayer/")) {
    return { status: 200, contentType: "text/html; charset=utf-8", body: fs.readFileSync(path.join(FIXTURES, "embed.html")) };
  }
  if (/\.bandcamp\.com$/.test(u.host) && /^\/(album|track)\/[^/]+\/?$/.test(u.pathname)) {
    standInPages.push(u.origin + u.pathname);
    return { status: 200, contentType: "text/html; charset=utf-8", body: fs.readFileSync(path.join(FIXTURES, "page-no-data.html")) };
  }
  return null;
}

async function routeBandcamp(route) {
  const fixture = bandcampFixture(route.request().url());
  if (fixture) return route.fulfill(fixture);
  const u = new URL(route.request().url());
  escapedRequests.push(`${route.request().method()} ${u.origin}${u.pathname}`);
  return route.abort("blockedbyclient");
}

// Any test that asked Bandcamp for something we have no recording of fails.
afterEach(() => {
  standInPages.length = 0;
  const escaped = escapedRequests.splice(0);
  assert.deepEqual(escaped, [], `Bandcamp requests with no fixture (blocked): ${escaped.join(", ")}`);
});

before(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(SERVER_DATA, { recursive: true, force: true });
  fs.mkdirSync(SERVER_DATA, { recursive: true });

  // Builds: the e2e extension (pointed at our server) and the local app.
  execFileSync("npx", ["webpack", "--mode=development", "--env", "e2e", "--config", "extension/config/webpack.config.js"], {
    cwd: ROOT,
    env: { ...process.env, BC_DEFAULT_SERVER_URL: SERVER },
    stdio: "ignore",
  });
  execFileSync("npm", ["run", "build:app"], { cwd: ROOT, stdio: "ignore" }); // test the current source

  server = spawn(path.join(ROOT, "server/bct"), ["serve", "--port", String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, BC_TAGGER_DATA_DIR: SERVER_DATA },
    stdio: "ignore",
  });
  await waitFor(() => api("/api/health").then((h) => h.ok && h.items > 0).catch(() => false), {
    timeout: 30000,
    what: "the server",
  });

  process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1"; // route the extension's own fetches too
  context = await chromium.launchPersistentContext(PROFILE, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      `--host-resolver-rules=${NO_BANDCAMP_DNS}`, // backstop: nothing live, even if a request skips the route
    ],
  });
  await context.route(BANDCAMP_URL, routeBandcamp);
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  extId = new URL(sw.url()).host;
  probe = await context.newPage();
  await probe.goto(extPage("import.html"));
});

after(async () => {
  if (context) await context.close();
  if (server) server.kill();
});

test("the e2e extension loads with its own name", async () => {
  const name = await probe.evaluate(() => chrome.runtime.getManifest().name);
  assert.equal(name, "Bc Tagger (e2e)");
});

test("a fresh, empty profile does not wipe the server mirror", async () => {
  await sleep(4000); // onInstalled → sync tick
  const health = await api("/api/health");
  assert.equal(health.items, exportCount);
  assert.equal((health.items_source || {}).kind, "export-json");
  const { bcSyncStatus } = await probe.evaluate(() => chrome.storage.session.get("bcSyncStatus"));
  assert.match((bcSyncStatus || {}).syncWarning || "", /kept the server/);
});

test("Import (replace) loads the export into the extension", async () => {
  const page = await context.newPage();
  await page.goto(extPage("import.html"));
  await page.setInputFiles("#file", EXPORT_JSON);
  await page.waitForSelector("#summary:not([hidden])");
  assert.match(await page.textContent("#summary"), new RegExp(`File: ${exportCount} items`));
  await page.check('input[name="mode"][value="replace"]');
  page.once("dialog", (d) => d.accept());
  await page.click("#import");
  await page.waitForSelector("#result:not([hidden])");
  assert.match(await page.textContent("#result"), new RegExp(`Storage now has ${exportCount} items`));
  assert.equal(Object.keys((await storage("taggedItems")).taggedItems).length, exportCount);
  await page.close();
});

test("Import modes: keep mine leaves tags, merge takes the file's", async () => {
  const changed = JSON.parse(JSON.stringify(exportData));
  const original = changed.taggedItems[ITEM].tags;
  changed.taggedItems[ITEM].tags = [...original, "e2e-tag"];
  const file = path.join(E2E, "export-changed.json");
  fs.writeFileSync(file, JSON.stringify(changed));
  const page = await context.newPage();
  await page.goto(extPage("import.html"));
  await page.setInputFiles("#file", file);
  await page.waitForSelector("#summary:not([hidden])");
  assert.match(await page.textContent("#summary"), /\(1 with different tags\)/);

  await page.check('input[name="mode"][value="keep"]');
  await page.click("#import");
  await page.waitForSelector("#result:not([hidden])");
  assert.deepEqual(await itemTags(ITEM), original);

  await page.goto(extPage("import.html"));
  await page.setInputFiles("#file", file);
  await page.waitForSelector("#summary:not([hidden])");
  await page.check('input[name="mode"][value="merge"]');
  await page.click("#import");
  await page.waitForSelector("#result:not([hidden])");
  assert.deepEqual(await itemTags(ITEM), [...original, "e2e-tag"]);
  await page.close();
});

test("storage changes sync to the server", async () => {
  const tags = await itemTags(ITEM);
  await waitFor(() => api(`/api/items/${ITEM}`).then((it) => JSON.stringify(it.tags) === JSON.stringify(tags)), {
    what: "the merged tags on the server",
  });
  const health = await api("/api/health");
  assert.equal(health.items_source.kind, "extension");
});

test("the bundled collection page renders with the shared code", async () => {
  const page = await context.newPage();
  await page.goto(extPage("collection.html"));
  await page.waitForFunction((n) => document.querySelectorAll("#collectionTable tbody tr").length === n, exportCount);
  const headers = await page.$$eval("#collectionTable thead th", (ths) => ths.map((t) => t.firstChild.textContent));
  assert.deepEqual(headers, ["#", "Added", "Thumbnail", "Title", "Artist", "Player", "Tags"]);
  const buttons = await page.$$eval("#toolbar button", (bs) => bs.map((b) => b.textContent));
  assert.deepEqual(buttons, ["Refresh player files", "Refresh thumbnails", "Fix artists", "Fix album IDs"]);
  await page.waitForSelector("select.tag-editor", { state: "attached" });
  await page.close();
});

test("popup: status line, See Collection → local app, Shift-click → built-in page", async () => {
  const popup = await context.newPage();
  await popup.goto(extPage("popup.html"));
  await popup.waitForFunction(
    (host) => document.getElementById("serverText").textContent.includes(host),
    `127.0.0.1:${PORT}`
  );
  assert.match(await popup.textContent("#serverText"), /synced/);

  let [opened] = await Promise.all([context.waitForEvent("page"), popup.click("#seeCollection")]);
  await opened.waitForLoadState();
  assert.equal(new URL(opened.url()).origin, SERVER);
  await opened.close();

  [opened] = await Promise.all([context.waitForEvent("page"), popup.click("#seeCollection", { modifiers: ["Shift"] })]);
  await opened.waitForLoadState();
  assert.equal(opened.url(), extPage("collection.html"));
  await opened.close();
  await popup.close();
});

test("popup: See Collection falls back to the built-in page when the server is down", async () => {
  await probe.evaluate(() => chrome.storage.local.set({ bcServer: { url: "http://127.0.0.1:9" } }));
  const popup = await context.newPage();
  await popup.goto(extPage("popup.html"));
  await popup.waitForFunction(() => /offline/.test(document.getElementById("serverText").textContent));
  const [opened] = await Promise.all([context.waitForEvent("page"), popup.click("#seeCollection")]);
  await opened.waitForLoadState();
  assert.equal(opened.url(), extPage("collection.html"));
  await opened.close();
  await popup.close();
  await probe.evaluate((url) => chrome.storage.local.set({ bcServer: { url } }), SERVER);
});

test("local app ↔ extension bridge: tag edits go into the extension and back to the server", async () => {
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
  const before = await itemTags(ITEM);
  const next = before.filter((t) => t !== "e2e-tag");
  await app.locator(`tr[data-key="${ITEM}"]`).scrollIntoViewIfNeeded();
  await app.waitForSelector(`tr[data-key="${ITEM}"] select.tag-editor`, { state: "attached" });
  await app.evaluate(
    ([id, tags]) => $(`tr[data-key="${id}"] select.tag-editor`).val(tags).trigger("change"),
    [ITEM, next]
  );
  await waitFor(async () => JSON.stringify(await itemTags(ITEM)) === JSON.stringify(next), { what: "the extension write" });
  await waitFor(() => api(`/api/items/${ITEM}`).then((it) => JSON.stringify(it.tags) === JSON.stringify(next)), {
    what: "the server mirror",
  });
  const queued = await api("/api/tag-edits/pending");
  assert.equal(queued.length, 0, "the edit went through the extension, not the queue");
  await app.close();
});

test("tag edits queued on the server are applied by the extension", async () => {
  const before = await itemTags(ITEM);
  const next = [...before, "queued-e2e"];
  await post("/api/tag-edits", { id: ITEM, tags: next });
  // The popup's "sync" forces a full sync and pulls queued edits (the 30 s alarm does too).
  const popup = await context.newPage();
  await popup.goto(extPage("popup.html"));
  await popup.click("#serverSync");
  await waitFor(async () => JSON.stringify(await itemTags(ITEM)) === JSON.stringify(next), { what: "the queued edit" });
  await waitFor(() => api("/api/tag-edits/pending").then((p) => p.length === 0), { what: "the ack" });
  await popup.close();
});

test("ownership from Bandcamp via the extension (recorded collection summary)", async () => {
  const lookup = JSON.parse(fs.readFileSync(path.join(FIXTURES, "collection_summary.json"), "utf8")).collection_summary.tralbum_lookup;
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
  await app.click("#refreshOwnership");
  await app.waitForFunction(() => /done|failed/.test(document.getElementById("refreshStatus").textContent), null, {
    timeout: 60000,
  });
  const status = await app.textContent("#refreshStatus");
  const owned = Number((status.match(/owned: (\d+)/) || [])[1] || 0);
  assert.equal(owned, Object.keys(lookup).length, `status: ${status.replace(/\s+/g, " ").slice(0, 120)}`);
  await waitFor(() => api("/api/items/t1004723757").then((it) => it.owned && it.owned.status === "owned"), {
    what: "the server's ownership",
  });
  await app.close();
});

test("local app: the Show filter narrows by status and explains an empty result", async () => {
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 0);
  const total = await app.$$eval("#collectionTable tbody tr", (rows) => rows.length);
  await app.selectOption("#statusFilter", "unknown"); // nothing located on this fresh server
  assert.equal(await app.$$eval("#collectionTable tbody tr", (rows) => rows.length), total);
  await app.selectOption("#statusFilter", "located");
  assert.equal(await app.$$eval("#collectionTable tbody tr", (rows) => rows.length), 0);
  assert.equal(await app.isVisible("#emptyState"), true);
  assert.match(await app.textContent("#viewCount"), new RegExp(`0 of ${total}`));
  await app.selectOption("#statusFilter", "all");
  await app.close();
});

test("Fix album IDs reads the real album from track pages (recorded Bandcamp pages)", async () => {
  // Two tracks tagged on their own pages (one stored "a" + its own id, one
  // none), plus one whose page is gone (404) that must not stop the run.
  // t1110893101's page is on a custom domain: it goes through the embedded player.
  const targets = { t1004723757: "a1994132225", t1011914860: null, t1110893101: "a3018496543", t999000404: null };
  await probe.evaluate(async (ids) => {
    const { taggedItems } = await chrome.storage.local.get("taggedItems");
    taggedItems.t999000404 = {
      id: "t999000404",
      title: "Removed track",
      tralbum_type: "t",
      raw_id: 999000404,
      tags: ["must"],
      url: "https://joaquincornejomusic.bandcamp.com/track/this-track-does-not-exist-e2e",
    };
    Object.entries(taggedItems).forEach(([id, it]) => {
      if (it.tralbum_type === "t" && !ids.includes(id)) it.album_checked = true; // keep the run short
    });
    await chrome.storage.local.set({ taggedItems });
  }, Object.keys(targets));
  const page = await context.newPage();
  await page.goto(extPage("collection.html"));
  await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 0);
  await page.click("#fixAlbumIds");
  await page.waitForFunction(
    () => {
      const t = document.getElementById("refreshStatus").textContent;
      return /^Album IDs: \d+ fixed/.test(t) && !/checked \(/.test(t) && !document.getElementById("fixAlbumIds").disabled;
    },
    null,
    { timeout: 90000 }
  );
  assert.match(await page.textContent("#refreshStatus"), /1 from the embedded player/);
  assert.match(await page.textContent("#refreshStatus"), /1 not found on Bandcamp/);
  assert.equal(await page.isDisabled("#fixAlbumIds"), false);
  const items = (await storage("taggedItems")).taggedItems;
  assert.equal(items.t1004723757.album_id, targets.t1004723757);
  assert.match(String(items.t1011914860.album_id), /^a\d+$/);
  assert.equal(items.t1011914860.album_checked, true);
  // album_url becomes the real (absolute) album page.
  assert.match(items.t1004723757.album_url, /^https:\/\/[a-z0-9-]+\.bandcamp\.com\/album\//);
  assert.equal(items.t1110893101.album_id, targets.t1110893101);
  assert.equal(items.t999000404.album_checked, undefined); // gone from Bandcamp: kept, retried next time
  assert.ok(items.t999000404, "an unreachable item is never removed");
  await probe.evaluate(() => chrome.runtime.sendMessage({ type: "removeTaggedItem", id: "t999000404" }));
  await page.close();
});

// --- Regression tests for the code review findings -----------------------------

test("concurrent item updates in the background don't overwrite each other", async () => {
  const [a, b] = ["t283914533", "t1004723757"];
  const before = await itemTags(a);
  await probe.evaluate(
    ([a, b, tags]) =>
      Promise.all([
        chrome.runtime.sendMessage({ type: "updateTaggedItemTags", id: a, tags }),
        chrome.runtime.sendMessage({ type: "updateTaggedItemArt", art: { [b]: "https://f4.bcbits.com/img/a0000000001_16.jpg" } }),
        chrome.runtime.sendMessage({ type: "updateTaggedItemFields", updates: { [b]: { e2e_field: 1 } } }),
      ]),
    [a, b, [...before, "race"]]
  );
  const items = (await storage("taggedItems")).taggedItems;
  assert.deepEqual(items[a].tags, [...before, "race"]);
  assert.equal(items[b].art_url, "https://f4.bcbits.com/img/a0000000001_16.jpg");
  assert.equal(items[b].e2e_field, 1);
  await probe.evaluate(([a, tags]) => chrome.runtime.sendMessage({ type: "updateTaggedItemTags", id: a, tags }), [a, before]);
});

test("titles are rendered as text, not HTML (extension page and local app)", async () => {
  const id = "t999000001";
  const evil = '<img src=x onerror="window.__xss = 1">Evil';
  await probe.evaluate(
    ([id, title]) =>
      chrome.runtime.sendMessage({
        type: "importData",
        mode: "keep",
        data: { taggedItems: { [id]: { id, title, tralbum_type: "t", raw_id: 999000001, tags: ["must"] } } },
      }),
    [id, evil]
  );
  await waitFor(() => api(`/api/items/${id}`).then((it) => it.title === evil).catch(() => false), { what: "the item on the server" });
  for (const url of [extPage("collection.html"), SERVER + "/"]) {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector(`tr[data-key="${id}"]`, { state: "attached" });
    await sleep(300);
    assert.equal(await page.evaluate(() => window.__xss), undefined, url);
    assert.equal(await page.textContent(`tr[data-key="${id}"] .col-title a`), evil, url);
    await page.close();
  }
  await probe.evaluate((id) => chrome.runtime.sendMessage({ type: "removeTaggedItem", id }), id);
  await waitFor(() => fetch(`${SERVER}/api/items/${id}`).then((r) => r.status === 404), { what: "the deletion on the server" });
});

test("local app: a reload before an edit reaches the server doesn't undo it", async () => {
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
  const before = await itemTags(ITEM);
  const set = async (tags) => {
    await app.locator(`tr[data-key="${ITEM}"]`).scrollIntoViewIfNeeded();
    await app.waitForSelector(`tr[data-key="${ITEM}"] select.tag-editor`, { state: "attached" });
    await app.evaluate(([id, t]) => $(`tr[data-key="${id}"] select.tag-editor`).val(t).trigger("change"), [ITEM, tags]);
  };
  const editorTags = async () => [...((await app.evaluate((id) => $(`tr[data-key="${id}"] select.tag-editor`).val(), ITEM)) || [])].sort();
  // A vocabulary tag the item doesn't have (the editor only offers vocabulary tags).
  const extra = (await storage("tags")).tags.find((t) => !before.includes(t));
  const want = [...before, extra].sort();

  await set([...before, extra]);
  // Force a reload now, while the server mirror still has the old tags (the
  // extension pushes ~0.8 s after the edit): any server event does it.
  await post("/api/ownership", { owned_ids: ["a1460820700"], source: "e2e", full: false });
  await sleep(650);
  assert.notDeepEqual(
    [...(await api(`/api/items/${ITEM}`)).tags].sort(),
    want,
    "test setup: the server should not have the edit yet"
  );
  assert.deepEqual(await editorTags(), want, "the reload must not undo the edit in the editor");
  await waitFor(() => api(`/api/items/${ITEM}`).then((it) => JSON.stringify([...it.tags].sort()) === JSON.stringify(want)), {
    what: "the edit on the server",
  });
  assert.deepEqual([...(await itemTags(ITEM))].sort(), want);
  assert.deepEqual(await editorTags(), want);
  await set(before);
  await sleep(1500);
  await app.close();
});

test("local app: editing an item the extension doesn't have shows an error instead of queueing", async () => {
  const id = "t999000002";
  await post("/api/sync/items", { items: { [id]: { id, title: "Server only", tralbum_type: "t", tags: ["must"] } }, deleted: [], full: false });
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
  await app.locator(`tr[data-key="${id}"]`).scrollIntoViewIfNeeded();
  await app.waitForSelector(`tr[data-key="${id}"] select.tag-editor`, { state: "attached" });
  await app.evaluate((id) => $(`tr[data-key="${id}"] select.tag-editor`).val(["must", "pool"]).trigger("change"), id);
  await app.waitForSelector(`tr[data-key="${id}"] .tag-editor-wrap.tags-error`, { state: "attached" });
  assert.equal((await api("/api/tag-edits/pending")).length, 0);
  await post("/api/sync/items", { items: {}, deleted: [id], full: false });
  await app.close();
});

test("local app: a loaded album embed survives an unrelated update of its row", async () => {
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 0);
  const album = await app.evaluate(() => {
    const btn = [...document.querySelectorAll("td.player-cell button")].find((b) => b.textContent === "Play album");
    const key = btn.closest("tr").dataset.key;
    btn.click();
    return key;
  });
  await app.waitForSelector(`tr[data-key="${album}"] td.player-cell iframe`, { state: "attached" });
  // Change the album's ownership on the server → item event → in-place row update.
  await post("/api/ownership", { owned_ids: [album], source: "e2e", full: false });
  await app.waitForFunction(
    (key) => /owned/.test(document.querySelector(`tr[data-key="${key}"] .col-owned`).textContent),
    album,
    { timeout: 10000 }
  );
  assert.equal(await app.locator(`tr[data-key="${album}"] td.player-cell iframe`).count(), 1);
  await app.close();
});

// --- Phase 2: Rekordbox settings, main-library opt-in, dry run before writes ----
// The main library path is always pointed at a sandbox path under .e2e/ first;
// nothing here opens or writes ~/Library/Pioneer/rekordbox.

const SANDBOX_MAIN = path.join(E2E, "main-sandbox", "master.db");
const put = (body) =>
  api("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("Settings has General and Rekordbox tabs", async () => {
  const page = await context.newPage();
  await page.goto(SERVER + "/settings/");
  await page.waitForSelector("#tabs");
  assert.equal(await page.isVisible("#sec_folders"), true);
  assert.equal(await page.isVisible("#sec_rb_target"), false);
  await page.click("#tab_rekordbox");
  assert.equal(await page.isVisible("#sec_rb_target"), true);
  assert.equal(await page.isVisible("#sec_folders"), false);
  assert.match(page.url(), /#rekordbox$/);
  await page.goto(SERVER + "/settings/#rekordbox"); // deep link
  await page.waitForSelector("#sec_rb_playlists:not([hidden])");
  assert.equal(await page.isVisible("#mappingAuto"), true);
  await page.close();
});

test("Settings: the tag → playlists mapping round-trips through the server", async () => {
  const page = await context.newPage();
  await page.goto(SERVER + "/settings/#rekordbox");
  await page.waitForSelector("#mappingAuto");
  assert.equal(await page.isChecked("#mappingAuto"), true);
  assert.equal(await page.isVisible(".mapping-panel"), false);
  await page.uncheck("#mappingAuto");
  assert.equal(await page.isVisible(".mapping-warning"), true, "warns while no tag is mapped");
  const row = (tag) => page.locator(`.map-row[data-tag="${tag}"]`);
  assert.equal(await row("must").locator("input").first().getAttribute("placeholder"), "must");
  await row("must").locator("input").first().fill("/DJ/Status/Must");
  await row("must").locator(".map-add").click();
  await row("must").locator("input").nth(1).fill("Favourites");
  await row("pool").locator("input").first().fill("Sub/Pool");
  assert.equal(await page.isVisible(".mapping-warning"), false);
  await page.click("#saveBtn");
  await page.waitForFunction(() => /Saved/.test(document.getElementById("saveState").textContent));
  let s = await api("/api/settings");
  assert.equal(s.tag_playlist_mode, "custom");
  assert.deepEqual(s.tag_playlist_map, { must: ["/DJ/Status/Must", "Favourites"], pool: ["Sub/Pool"] });

  await page.reload();
  await page.waitForSelector(".map-row");
  assert.equal(await row("must").locator("input").nth(1).inputValue(), "Favourites");
  await row("pool").locator("input").first().fill("a//b"); // invalid: refused by the server
  assert.match(await row("pool").locator(".map-status").textContent(), /empty folder name/);
  await page.click("#saveBtn");
  await page.waitForFunction(() => /Not saved/.test(document.getElementById("saveState").textContent));
  await page.click("#revertBtn");
  await page.check("#mappingAuto"); // back to auto; the map is kept for later
  await page.click("#saveBtn");
  await page.waitForFunction(() => /Saved/.test(document.getElementById("saveState").textContent));
  s = await api("/api/settings");
  assert.equal(s.tag_playlist_mode, "auto");
  assert.deepEqual(s.tag_playlist_map.must, ["/DJ/Status/Must", "Favourites"]);
  await page.close();
});

test("Settings: the main-collection opt-in asks first, and the header shows MAIN LIBRARY", async () => {
  await put({ rekordbox_main_db_path: SANDBOX_MAIN });
  const page = await context.newPage();
  await page.goto(SERVER + "/settings/#rekordbox");
  await page.waitForSelector("#f_allow_main_writes");
  assert.equal(await page.isVisible("#mainLibraryBanner"), false);

  await page.check("#f_allow_main_writes").catch(() => {}); // the dialog opens and un-ticks it
  await page.waitForSelector("#mainLibraryConfirm");
  assert.match(await page.textContent("#mainLibraryConfirm"), /Backup Library/);
  assert.equal(await page.isDisabled("#mainLibraryConfirm .dialog-confirm"), true, "needs the backup acknowledgement");
  await page.click("#mainLibraryConfirm .dialog-cancel");
  assert.equal(await page.isChecked("#f_allow_main_writes"), false, "cancel keeps the test library");

  await page.check("#f_allow_main_writes").catch(() => {});
  await page.waitForSelector("#mainLibraryConfirm");
  await page.check("#mainLibraryConfirm .dialog-ack input");
  await page.click("#mainLibraryConfirm .dialog-confirm");
  assert.equal(await page.isChecked("#f_allow_main_writes"), true);
  await page.click("#saveBtn");
  await page.waitForFunction(() => /Saved/.test(document.getElementById("saveState").textContent));
  let s = await api("/api/settings");
  assert.equal(s.rekordbox_target, "main");
  assert.equal(s.allow_main_writes, true);
  assert.equal(s.rekordbox_main_db_path, SANDBOX_MAIN);
  assert.equal(await page.isVisible("#mainLibraryBanner"), true);

  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForSelector("#mainLibraryBanner:not([hidden])");
  await app.close();

  await page.uncheck("#f_allow_main_writes");
  await page.click("#saveBtn");
  await page.waitForFunction(() => /Saved/.test(document.getElementById("saveState").textContent));
  s = await api("/api/settings");
  assert.equal(s.rekordbox_target, "test");
  assert.equal(s.allow_main_writes, false);
  assert.equal(await page.isVisible("#mainLibraryBanner"), false);
  await page.close();
});

test("Main target: every export runs a dry run and writes only after confirming", async () => {
  await put({ rekordbox_main_db_path: SANDBOX_MAIN, allow_main_writes: true, rekordbox_target: "main" });
  const app = await context.newPage();
  // Only the export + job endpoints are stubbed for this page: no database is touched.
  const calls = [];
  const jobs = {};
  let n = 0;
  await app.route("**/api/rekordbox/export", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    calls.push(body);
    const id = `export-e2e-${++n}`;
    jobs[id] = body.dry_run
      ? {
          id, kind: "export", status: "done", progress: {},
          result: {
            dry_run: true, target: "main", db_path: SANDBOX_MAIN, changed: true, confirm_token: `tok-${n}`,
            content_added: ["/music/a.aiff"], content_existing: 1, playlists_created: ["/DJ/New"], folders_created: [],
            entries_added: [{ playlist: "/DJ/New", path: "/music/a.aiff" }], entries_removed: [],
            per_playlist: [{ playlist: "/DJ/New", exists: false, add: 1, remove: 0 }], selected_items: [{}], errors: [], warnings: [],
          },
        }
      : { id, kind: "export", status: "done", progress: {}, result: { dry_run: false, changed: true } };
    await route.fulfill({ json: { job_id: id } });
  });
  await app.route("**/api/jobs/export-e2e-*", (route) => route.fulfill({ json: jobs[route.request().url().split("/").pop()] }));
  await app.goto(SERVER + "/");
  await app.waitForSelector("#mainLibraryBanner:not([hidden])");
  await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 0);

  // Export latest 10: dry run, then the dialog; Cancel writes nothing.
  await app.click("#exportLatest");
  await app.waitForSelector("#exportConfirm");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dry_run, true);
  assert.match(await app.textContent("#exportConfirm"), /MAIN rekordbox library/);
  assert.match(await app.textContent("#exportConfirm"), /\/DJ\/New/);
  await app.click("#exportConfirm .dialog-cancel");
  await app.waitForFunction(() => /cancelled/.test(document.getElementById("refreshStatus").textContent));
  assert.equal(calls.length, 1, "cancel: no write request");

  // Confirm: the write carries the dry run's token.
  await app.click("#exportLatest");
  await app.waitForSelector("#exportConfirm");
  await app.click("#exportConfirm .dialog-confirm");
  await app.waitForFunction(() => /Export latest 10.*done/.test(document.getElementById("refreshStatus").textContent));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], { latest: 10, confirm_token: "tok-2" });

  // The per-row button and "Export shown…" go through the same dry run + confirm.
  await app.evaluate(() => {
    const s = document.getElementById("searchInput");
    s.value = "System Works";
    s.dispatchEvent(new Event("input"));
  });
  await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length === 1);
  await app.click("#exportShown");
  await app.waitForSelector("#exportConfirm");
  assert.equal(calls[3].dry_run, true);
  await app.click("#exportConfirm .dialog-cancel");
  await app.evaluate(() => {
    // The per-row Export is enabled only for located rows; enable it for this check.
    const b = document.querySelector("#collectionTable tbody tr .col-rekordbox .mini-btn");
    b.disabled = false;
    b.click();
  });
  await app.waitForSelector("#exportConfirm");
  assert.equal(calls[4].dry_run, true);
  assert.equal(calls[4].ids.length, 1);
  await app.click("#exportConfirm .dialog-cancel");
  assert.equal(calls.filter((c) => !c.dry_run).length, 1, "only the one confirmed write");
  await app.close();
  await put({ allow_main_writes: false });
});

// Real server + a sandbox copy of the TEST library's master.db (never the main
// library) standing in for "main". With rekordbox running, the server must
// refuse the write and leave the sandbox untouched; otherwise the confirmed
// export writes the mapped playlists and a re-run changes nothing.
test("Main target, real server: dry run, confirm, and write to a sandbox copy", async (t) => {
  const template = process.env.E2E_TEMPLATE_DB || path.join(process.env.HOME, "Library/Pioneer/rekordbox_test/master.db");
  if (!fs.existsSync(template)) {
    t.skip(`no template DB at ${template} (test library switched out?)`);
    return;
  }
  const sandboxDir = path.join(E2E, "main-sandbox", "rekordbox");
  fs.rmSync(path.dirname(sandboxDir), { recursive: true, force: true });
  fs.mkdirSync(sandboxDir, { recursive: true });
  const sandboxDb = path.join(sandboxDir, "master.db");
  fs.copyFileSync(template, sandboxDb); // a copy: the template is only read
  const stat = () => {
    const st = fs.statSync(sandboxDb);
    return `${st.size}:${st.mtimeMs}`;
  };
  let rekordboxRunning = false;
  try {
    execFileSync("pgrep", ["-x", "rekordbox"], { stdio: "ignore" });
    rekordboxRunning = true;
  } catch (e) {
    /* not running */
  }

  await put({
    rekordbox_main_db_path: sandboxDb,
    allow_main_writes: true,
    rekordbox_target: "main",
    tag_playlist_mode: "custom",
    tag_playlist_map: { must: ["/E2E/Must"], pool: ["Pool"] },
  });
  const loc = await post("/api/locate", { latest: 10 });
  await waitFor(() => api(`/api/jobs/${loc.job_id}`).then((j) => j.status === "done" || j.status === "error"), {
    timeout: 120000,
    what: "locate",
  });
  const before = stat();

  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForSelector("#mainLibraryBanner:not([hidden])");
  await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 0);
  await app.click("#exportLatest");
  await app.waitForSelector("#exportConfirm", { timeout: 120000 });
  const dialog = await app.textContent("#exportConfirm");
  assert.match(dialog, /MAIN rekordbox library/);
  assert.match(dialog, /\/E2E\/Must/, "the mapped playlist is in the dry run");
  assert.equal(stat(), before, "the dry run doesn't touch the sandbox");
  if (rekordboxRunning) {
    // The dry run reports the blocker; Confirm stays disabled.
    assert.match(dialog, /Quit rekordbox/);
    assert.equal(await app.isDisabled("#exportConfirm .dialog-confirm"), true);
    await app.click("#exportConfirm .dialog-cancel");
    await app.waitForFunction(() => !document.getElementById("exportLatest").disabled, null, { timeout: 120000 });
    assert.match(await app.textContent("#refreshStatus"), /failed.*Quit rekordbox/);
    assert.equal(stat(), before, "nothing written");
    console.log("# main write blocked before confirming: rekordbox is running");
  } else {
    await app.click("#exportConfirm .dialog-confirm");
    await app.waitForFunction(() => !document.getElementById("exportLatest").disabled, null, { timeout: 120000 }); // the flow ended
    const status = await app.textContent("#refreshStatus");
    assert.match(status, /done/);
    const tree = await api("/api/rekordbox/playlists");
    const must = tree.find((p) => p.path === "/E2E/Must");
    assert.ok(must && must.kind === "playlist" && must.count > 0, "the mapped playlist was written");
    // A second export finds nothing to do.
    await app.click("#exportLatest");
    await app.waitForFunction(() => !document.getElementById("exportLatest").disabled, null, { timeout: 120000 });
    assert.match(await app.textContent("#refreshStatus"), /up to date/);
  }
  await app.close();
  await put({ allow_main_writes: false, tag_playlist_mode: "auto" });
  fs.rmSync(path.dirname(sandboxDir), { recursive: true, force: true });
});

// Album pages: the header widget is the album (a<id>), each row its own track
// (t<id>), paired by position with the page's data. If Bandcamp's markup ever
// shifts that pairing, album items would be saved/removed under track ids.
test("album page: the header widget is the album item; track rows never touch it (recorded album page)", async () => {
  const albumId = "a563830364"; // Synergy Trilogy (in the imported export)
  const trackId = "t3738475288"; // Holo Law, one of its tracks
  const page = await context.newPage();
  await page.goto("https://infiniteexpanse.bandcamp.com/album/synergy-trilogy");
  await page.waitForSelector(`#tagger_${albumId}`, { state: "attached", timeout: 30000 });
  // Every row tagger is a t<id> of this album, in page order; the header is the album.
  const ids = await page.$$eval("select[id^='tagger_']", (sels) => sels.map((s) => s.id.slice("tagger_".length)));
  assert.equal(ids[ids.length - 1], albumId, "the last widget (header) is the album");
  assert.ok(ids.slice(0, -1).every((i) => /^t\d+$/.test(i)), `rows are tracks: ${ids.join(",")}`);
  assert.ok(ids.includes(trackId));
  const before = (await storage("taggedItems")).taggedItems[albumId];
  assert.ok(before, "album saved before");
  const headerTags = await page.$eval(`#tagger_${albumId}`, (s) => [...s.selectedOptions].map((o) => o.value));
  assert.deepEqual(headerTags, before.tags, "the header shows the album's tags");

  // Star the track (save it), then un-star it: only t<id> changes.
  const trackStar = page.locator(`#tagger_${trackId}`).locator("xpath=ancestor::div[contains(@class,'tagger-container')]").locator(".tag-button");
  await trackStar.click();
  await waitFor(async () => !!(await storage("taggedItems")).taggedItems[trackId], { what: "the track saved" });
  let items = (await storage("taggedItems")).taggedItems;
  assert.equal(items[trackId].album_id, albumId);
  assert.deepEqual(items[albumId], before, "the album item is untouched");
  await trackStar.click();
  await waitFor(async () => !(await storage("taggedItems")).taggedItems[trackId], { what: "the track un-saved" });
  items = (await storage("taggedItems")).taggedItems;
  assert.deepEqual(items[albumId], before, "still untouched after un-saving the track");
  await page.close();
});

// --- Phase 2b: file index status, Rescan drive ----------------------------------

const hasIndexStatus = () => fetch(`${SERVER}/api/index/status`).then((r) => r.ok).catch(() => false);

async function rescanFromApp(app) {
  const samples = await app.evaluate(() => {
    window.__indexSamples = [];
    const st = document.getElementById("indexStatus");
    new MutationObserver(() =>
      window.__indexSamples.push(`${st.textContent}${document.getElementById("locateLatest").disabled ? " [blocked]" : ""}`)
    ).observe(st, { childList: true, characterData: true, subtree: true });
    document.getElementById("rescanDrive").click();
    return true;
  });
  await app.waitForFunction(() => /^Rescan drive:/.test(document.getElementById("refreshStatus").textContent), null, {
    timeout: 120000,
  });
  return samples && (await app.evaluate(() => window.__indexSamples));
}

test("Rescan drive: live progress, Locate/Export wait, then the status line", async () => {
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForSelector("#rescanDrive");
  const samples = await rescanFromApp(app);
  assert.ok(samples.some((s) => /Scanning the drive/.test(s)), `live progress: ${samples.slice(0, 4).join(" | ")}`);
  assert.ok(samples.some((s) => /\[blocked\]/.test(s)), "Locate/Export are disabled while scanning");
  assert.match(await app.textContent("#refreshStatus"), /Rescan drive: done/);
  assert.equal(await app.isDisabled("#locateLatest"), false, "re-enabled after the scan");
  if (await hasIndexStatus()) {
    await app.waitForFunction(() => /^Full scan (just now|\d+ min ago) · [\d,.]+ files$/.test(document.getElementById("indexStatus").textContent));
  }
  await app.close();
});

test("index hint: a drive missing at the last scan, cleared once it's back", async (t) => {
  if (!(await hasIndexStatus())) {
    t.skip("server has no /api/index/status yet");
    return;
  }
  const missing = path.join(E2E, "missing-drive"); // never created: like an unplugged drive
  await put({ extra_roots: [{ path: missing, kind: "not_owned", globs: [] }] });
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForSelector("#rescanDrive");
  await rescanFromApp(app);
  await app.waitForSelector("#indexHint:not([hidden])");
  const hint = await app.textContent("#indexHint");
  assert.ok(/missing|rescan/i.test(hint), hint);
  const status = await api("/api/index/status");
  assert.ok((status.incomplete_roots || []).length || status.next_auto_reason, JSON.stringify(status));

  await put({ extra_roots: [] });
  await rescanFromApp(app);
  await app.waitForFunction(() => document.getElementById("indexHint").hidden);
  await app.close();
});

test("Settings: quick-scan margin and full-rescan hint under General → Matching", async (t) => {
  const s0 = await api("/api/settings");
  if (!("quick_scan_margin_days" in s0)) {
    t.skip("server has no quick_scan_margin_days yet");
    return;
  }
  const page = await context.newPage();
  await page.goto(SERVER + "/settings/");
  await page.waitForSelector("#f_quick_scan_margin_days");
  assert.equal(await page.isVisible('#sec_matching .field[data-key="quick_scan_margin_days"]'), true);
  assert.equal(await page.isVisible('#sec_matching .field[data-key="full_rescan_hint_days"]'), true);
  await page.fill("#f_quick_scan_margin_days", "3");
  await page.fill("#f_full_rescan_hint_days", "45");
  await page.click("#saveBtn");
  await page.waitForFunction(() => /Saved/.test(document.getElementById("saveState").textContent));
  const s1 = await api("/api/settings");
  assert.equal(s1.quick_scan_margin_days, 3);
  assert.equal(s1.full_rescan_hint_days, 45);
  await put({ quick_scan_margin_days: s0.quick_scan_margin_days, full_rescan_hint_days: s0.full_rescan_hint_days });
  await page.close();
});

test("Locate never runs a full scan; its status shows what the quick scan did", async (t) => {
  if (!(await hasIndexStatus())) {
    t.skip("server has no /api/index/status yet");
    return;
  }
  const lastFull = (await api("/api/index/status")).last_scan_at;
  const scanJobsBefore = (await api("/api/jobs")).filter((j) => j.kind === "scan").length;
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForSelector("#locateLatest:not([disabled])");
  await app.click("#locateLatest");
  await app.waitForFunction(() => /^Locate latest 10: (done|failed)/.test(document.getElementById("refreshStatus").textContent), null, {
    timeout: 120000,
  });
  const status = await app.textContent("#refreshStatus");
  assert.match(status, /\((checked|no scan)[^)]*\)/, `quick-scan summary: ${status}`);
  assert.doesNotMatch(status, /full scan/, "no full scan from Locate");
  assert.equal((await api("/api/index/status")).last_scan_at, lastFull, "last full scan time unchanged");
  assert.equal((await api("/api/jobs")).filter((j) => j.kind === "scan").length, scanJobsBefore, "no scan job started");
  await app.close();
});

// --- One player per row ----------------------------------------------------------
// Clicking a row (global player) after its row was updated in place used to
// play the stale, replaced cell's audio and dock it next to the new cell's own
// player: one more player per update+click.

const audiosIn = (page, key) => page.$$eval(`tr[data-key="${key}"] audio`, (a) => a.length);
const playingCount = (page) =>
  page.evaluate(() => [...document.querySelectorAll("audio")].filter((a) => !a.paused).length);

test("local app: re-clicking a row after item updates keeps one player in it", async () => {
  const key = "t283914533"; // located by the earlier Locate tests: a local-file player
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForSelector(`tr[data-key="${key}"]`);
  if (!(await app.isChecked("#globalModeToggle"))) await app.click("#globalModeToggle");
  const row = app.locator(`tr[data-key="${key}"]`);
  for (let i = 0; i < 3; i++) {
    // An unrelated change to this item → SSE item → the row is updated in place.
    const before = await app.textContent(`tr[data-key="${key}"] .col-owned`);
    await post("/api/ownership", { owned_ids: i % 2 ? [] : [key], source: "e2e", full: true });
    await app.waitForFunction(
      ([k, b]) => document.querySelector(`tr[data-key="${k}"] .col-owned`).textContent !== b,
      [key, before],
      { timeout: 10000 }
    );
    await row.scrollIntoViewIfNeeded();
    await row.locator(".col-date").click(); // the row's "white space" plays it in global mode
    await app.waitForTimeout(600);
  }
  assert.equal(await audiosIn(app, key) + (await app.$$eval("#gpAudioHolder audio", (a) => a.length)), 1, "one player for the track");
  assert.ok((await playingCount(app)) <= 1, "at most one playing");
  await app.evaluate(() => document.querySelectorAll("audio").forEach((a) => a.pause()));
  await app.close();
});

test("extension page: re-clicking a row and switching tracks keeps one player per row", async () => {
  const a = "t1002746421"; // Futuro Lontano (durable stream link: an <audio> from the start)
  const page = await context.newPage();
  await page.goto(extPage("collection.html"));
  await page.waitForSelector(`tr[data-key="${a}"] audio`, { state: "attached" });
  if (!(await page.isChecked("#globalModeToggle"))) await page.click("#globalModeToggle");
  const rowA = page.locator(`tr[data-key="${a}"]`);
  await rowA.scrollIntoViewIfNeeded();
  for (let i = 0; i < 3; i++) {
    await rowA.locator(".col-date").click();
    await page.waitForTimeout(300);
  }
  // Another playable row, then back to the first one.
  const b = await page.evaluate((a) => {
    const rows = [...document.querySelectorAll("#collectionTable tbody tr")];
    const r = rows.find((tr) => tr.dataset.key !== a && tr.querySelector("td.player-cell audio"));
    return r && r.dataset.key;
  }, a);
  if (b) {
    const rowB = page.locator(`tr[data-key="${b}"]`);
    await rowB.scrollIntoViewIfNeeded();
    await rowB.locator(".col-date").click();
    await page.waitForTimeout(300);
    await rowA.scrollIntoViewIfNeeded();
    await rowA.locator(".col-date").click();
    await page.waitForTimeout(300);
    assert.equal(await audiosIn(page, b), 1, "the other row keeps one player");
  }
  const docked = await page.$$eval("#gpAudioHolder audio", (x) => x.length);
  assert.equal(await audiosIn(page, a) + docked, 1, "one player for the track");
  assert.ok((await playingCount(page)) <= 1, "at most one playing");
  await page.evaluate(() => document.querySelectorAll("audio").forEach((x) => x.pause()));
  await page.close();
});

// --- Column widths ------------------------------------------------------------------
// Widths used to be saved by position: adding the Src column shifted them, and
// Artist (no width of its own) collapsed to a sliver.

const colWidth = (page, id) => page.$eval(`#collectionTable thead th.col-${id}`, (th) => th.offsetWidth);

test("local app: saved widths that would squeeze a column are dropped (self-heal)", async () => {
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.evaluate(() =>
    localStorage.setItem(
      "bc_app_col_widths_v2",
      JSON.stringify({ index: 40, date: 120, source: 80, thumb: 300, title: 420, owned: 120, located: 140, rekordbox: 380, player: 360, tags: 300 })
    )
  );
  await app.reload();
  await app.waitForSelector("#collectionTable thead th.col-artist", { state: "attached" });
  await app.waitForFunction(() => localStorage.getItem("bc_app_col_widths_v2") === "{}");
  assert.ok((await colWidth(app, "artist")) >= 60, `artist width ${await colWidth(app, "artist")}`);
  assert.ok((await colWidth(app, "player")) >= 380, `player width ${await colWidth(app, "player")}`);
  await app.close();
});

test("extension page: old position-based widths move to the right columns", async () => {
  const page = await context.newPage();
  await page.goto(extPage("collection.html"));
  await page.evaluate(() => {
    localStorage.removeItem("bc_collection_col_widths_by_id");
    localStorage.setItem("bc_collection_col_widths_v3", JSON.stringify({ 3: 333 })); // the Title column, by position
  });
  await page.reload();
  await page.waitForSelector("#collectionTable thead th.col-title");
  assert.equal(await page.$eval("#collectionTable thead th.col-title", (th) => th.style.width), "333px");
  assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem("bc_collection_col_widths_by_id"))), { title: 333 });
  await page.evaluate(() => localStorage.removeItem("bc_collection_col_widths_by_id"));
  await page.close();
});

// --- Phase 3: import preview (stubbed import API) ------------------------------------
// The server's import endpoints are stubbed (scripts/e2e/importStub.mjs, shapes
// as documented by Session A) until they land; everything else is the real app.
// Bandcamp lookup is paused, so matches come from the collection, the file's
// URL or a pasted URL, and Find on Bandcamp is only a link (never followed here).

const IMPORT_SAMPLE = path.join(ROOT, "scripts/e2e/fixtures/import-sample.json");

test("import: file → tag mapping → preview with tints, match sources, Find link, pasted URL, Import selected", async () => {
  const stub = importStub(JSON.parse(fs.readFileSync(IMPORT_SAMPLE, "utf8")), { located: [1, 2] });
  const page = await context.newPage();
  await stub.install(page);
  page.on("dialog", (d) => d.accept());
  await page.goto(SERVER + "/settings/#import");
  await page.setInputFiles("#importFile", IMPORT_SAMPLE);
  await page.waitForFunction(() => /6 rows from/.test(document.getElementById("importFileInfo").textContent));
  assert.match(await page.textContent("#importFileInfo"), /2 tags not in your vocabulary/);
  await page.click("#importStart");

  // Mapping step: the file's suggestion is pre-filled; create the rest.
  await page.waitForSelector("#importMapping:not([hidden])");
  assert.deepEqual(await page.$$eval("#importMapping .map-row", (r) => r.map((x) => x.dataset.tag)), ["chill", "4/4"]);
  await page.click("#mapCreate");
  await page.waitForURL(/\/import\/\?batch=e2e-b1/);
  const tagsCall = stub.calls.find((c) => c.path.endsWith("/tags"));
  assert.deepEqual(tagsCall.body, { map: { "4/4": ["four-four"] }, unmapped: "create" });
  const startCall = stub.calls.find((c) => c.method === "POST" && c.path === "/api/import");
  assert.equal(startCall.body.name, "import-sample.json");
  assert.equal(startCall.body.file.format, "bc-tagger-import/1");

  // Preview: tints and where each match came from.
  await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length === 6);
  const rowInfo = () =>
    page.$$eval("#collectionTable tbody tr", (trs) =>
      trs.map((tr) => ({
        key: tr.dataset.key,
        cls: ["row-duplicate", "row-missing"].filter((c) => tr.classList.contains(c)).join(" "),
        source: tr.querySelector(".match-cell .chip").dataset.source,
        find: (tr.querySelector(".match-cell a.find-bc") || {}).href || null,
      }))
    );
  const byKey = Object.fromEntries((await rowInfo()).map((r) => [r.key, r]));
  assert.equal(byKey.r0.cls, "row-duplicate");
  assert.equal(byKey.r0.source, "collection");
  assert.equal(byKey.r1.cls, "");
  assert.equal(byKey.r1.source, "file");
  assert.equal(byKey.r2.cls, "row-missing");
  assert.equal(byKey.r2.source, "none");
  assert.equal(byKey.r5.source, "candidates");
  assert.equal(byKey.r2.find, "https://bandcamp.com/search?q=Nobody%20Known%20Slow%20One&item_type=t");
  assert.equal(byKey.r4.find, "https://bandcamp.com/search?q=Sample%20Artist%20Sample%20Album&item_type=a");
  assert.equal(byKey.r0.find, null, "matched rows have no Find link in the cell");
  assert.equal(await page.getAttribute("tr[data-key='r2'] a.find-bc", "target"), "_blank");
  assert.match(await page.textContent(".import-stats"), /6 rows/);

  // Paste a URL: junk is refused, a real page URL (query dropped) becomes the match.
  await page.click("tr[data-key='r2'] .match-cell .chip");
  await page.fill(".popover .match-url", "not a url");
  await page.click(".popover .pop-url button.primary");
  assert.match(await page.textContent(".popover .pop-err"), /isn't a Bandcamp track or album page/);
  await page.fill(".popover .match-url", "https://nobodyknown.bandcamp.com/track/slow-one?from=search");
  await page.click(".popover .pop-url button.primary");
  await page.waitForFunction(() => document.querySelector("tr[data-key='r2'] .match-cell .chip").dataset.source === "url");
  assert.deepEqual(stub.calls.filter((c) => c.method === "PUT").pop().body, { match_url: "https://nobodyknown.bandcamp.com/track/slow-one" });
  assert.equal(await page.$("tr[data-key='r2'] a.find-bc"), null);

  // Pick a search candidate, then send another row back to Other.
  await page.click("tr[data-key='r5'] .match-cell .chip");
  await page.click(".popover .pop-file button.primary >> nth=0");
  await page.waitForFunction(() => document.querySelector("tr[data-key='r5'] .match-cell .chip").dataset.source === "picked");
  assert.deepEqual(stub.calls.filter((c) => c.method === "PUT").pop().body, { choose: "t7000000001" });
  await page.click("tr[data-key='r1'] .match-cell .chip");
  await page.click(".popover button.danger");
  await page.waitForFunction(() => document.querySelector("tr[data-key='r1'] .match-cell .chip").dataset.source === "none");
  assert.deepEqual(stub.calls.filter((c) => c.method === "PUT").pop().body, { choose: null });

  // Select: one row off, then Import selected.
  await page.click("tr[data-key='r3'] .row-check");
  await page.waitForFunction(() => /\(5\)/.test(document.getElementById("importSelected").textContent));
  assert.equal(await page.$eval("#selectAll", (b) => b.indeterminate), true);
  await page.click("#importSelected");
  await page.waitForFunction(() => /^Imported:/.test(document.getElementById("refreshStatus").textContent));
  assert.match(await page.textContent("#refreshStatus"), /pending adds 2, tag merges 1, other added 2/);
  assert.ok(stub.calls.some((c) => c.path.endsWith("/commit")));
  assert.deepEqual(standInPages, [], "the preview fetches no Bandcamp pages");
  await page.close();
});

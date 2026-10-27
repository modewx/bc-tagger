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
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { importStub } from "./importStub.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const E2E = path.join(ROOT, ".e2e");
const EXT_DIR = path.join(E2E, "extension");
const PROFILE = path.join(E2E, "profile");
const SERVER_DATA = path.join(E2E, "server-data");
const APP_DIST = path.join(E2E, "app-dist"); // the app under test (not app/dist)
const STUB_RELEASES = path.join(E2E, "stub-releases.json"); // what the stub downloader "downloads"
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
const reveals = []; // Show in Finder calls (answered here: a test never opens Finder)

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

const NO_LIVE = "http://127.0.0.1:9"; // nothing listens there
const NO_LIVE_PROXY = { HTTPS_PROXY: NO_LIVE, HTTP_PROXY: NO_LIVE, ALL_PROXY: NO_LIVE, NO_PROXY: "127.0.0.1,localhost" };
const RECORDED_RESOLVER = path.join(ROOT, "server/tests/fixtures"); // Session A's recordings

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
  // Test the current source, built into its own folder: app/dist is what the
  // user's server serves (rebuilding it reloads their open tabs).
  fs.rmSync(APP_DIST, { recursive: true, force: true });
  execFileSync("npm", ["run", "build:app"], { cwd: ROOT, env: { ...process.env, BC_APP_OUT: APP_DIST }, stdio: "ignore" });
  fs.writeFileSync(path.join(SERVER_DATA, "settings.json"), JSON.stringify({ app_dist_dir: APP_DIST }));

  // The import resolver answers only from Session A's recorded responses
  // (BC_TAGGER_BANDCAMP_FIXTURES); as a backstop, the server's own requests
  // go to a closed local port, so nothing can reach Bandcamp.
  server = spawn(path.join(ROOT, "server/bct"), ["serve", "--port", String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      BC_TAGGER_DATA_DIR: SERVER_DATA,
      BC_TAGGER_BANDCAMP_FIXTURES: RECORDED_RESOLVER,
      // Downloads run Session A's stub downloader (writes small tagged AIFFs; no network).
      BC_TAGGER_DOWNLOADER_STUB: path.join(ROOT, "server/tests/fixtures/stub_downloader.py"),
      BC_TAGGER_STUB_RELEASES: STUB_RELEASES,
      ...NO_LIVE_PROXY,
    },
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
  // Show in Finder never opens Finder from a test: the calls are recorded and answered here.
  await context.route("**/api/import/logs/reveal", (route) => {
    const body = route.request().postDataJSON() || {};
    reveals.push(body);
    const where = path.join(SERVER_DATA, "import-logs", body.name || "");
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revealed: where }) });
  });
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
  // "#" is explicit: the file had none, so items are numbered in the file's order.
  const items = (await storage("taggedItems")).taggedItems;
  assert.deepEqual(
    Object.keys(exportData.taggedItems).map((k) => items[k].order),
    Object.keys(exportData.taggedItems).map((k, i) => i + 1)
  );
  await page.close();
});

test("\"#\" is explicit: a new tag goes last, a re-tag keeps its number, \"Set the # order only\" renumbers from a file; the app shows the same", async () => {
  const send = (msg) => probe.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);
  const items = async () => (await storage("taggedItems")).taggedItems;
  const ordered = (its) => Object.keys(its).sort((a, b) => its[a].order - its[b].order);
  const before = await items();
  const max = Math.max(...Object.values(before).map((i) => i.order));
  const NEW = "t9000000001";
  const page = await context.newPage();
  try {
    // A new tag from a Bandcamp page: last.
    await send({ type: "addTaggedItem", item: { id: NEW, raw_id: 9000000001, tralbum_type: "t", artist: "E2E Artist", title: "E2E Newest", tags: ["must"] } });
    await waitFor(async () => (await items())[NEW], { what: "the new item" });
    assert.equal((await items())[NEW].order, max + 1);
    // Re-tagging an existing item (the page sends its own copy, without "order"): same number.
    const first = ordered(before)[0];
    const { order: _o, ...copy } = before[first];
    await send({ type: "addTaggedItem", item: { ...copy, tags: [...(copy.tags || []), "e2e-retag"] } });
    await waitFor(async () => ((await items())[first].tags || []).includes("e2e-retag"), { what: "the re-tag" });
    assert.equal((await items())[first].order, before[first].order);
    // The local app: the same numbers ("#" sorted), the new one last.
    await page.goto(SERVER + "/");
    await waitFor(() => api(`/api/items/${NEW}`).then((it) => it.order === max + 1).catch(() => false), { what: "the new item's order on the server" });
    await page.reload();
    await page.waitForFunction((id) => document.querySelector(`tr[data-key="${id}"]`), NEW);
    const rows = await page.$$eval("#collectionTable tbody tr", (trs) => trs.map((tr) => [tr.dataset.key, tr.querySelector(".col-index").textContent]));
    const bc = rows.filter(([k]) => !/^o/.test(k));
    assert.deepEqual(bc[bc.length - 1], [NEW, String(max + 1)], "the new tag is last");
    assert.deepEqual(bc[0], [first, String(before[first].order)]);

    // "Set the # order only" from an order file: these three first, the rest after in their order.
    const top = ordered(before).slice(-3).reverse();
    const file = path.join(E2E, "order-file.json");
    fs.writeFileSync(file, JSON.stringify({ format: "bc-tagger-order/1", order: top }));
    await page.goto(extPage("import.html"));
    await page.setInputFiles("#file", file);
    await page.waitForSelector("#summary:not([hidden])");
    assert.equal(await page.isChecked('input[name="mode"][value="order"]'), true);
    assert.equal(await page.isDisabled('input[name="mode"][value="replace"]'), true, "an order file can't replace items");
    assert.match(await page.textContent("#summary"), /3 get their "#" from the file/);
    await page.click("#import");
    await page.waitForSelector("#result:not([hidden])");
    assert.match(await page.textContent("#result"), /"#" set for 3 items from the file/);
    const after = await items();
    assert.deepEqual(top.map((k) => after[k].order), [1, 2, 3]);
    const rest = ordered(before).filter((k) => !top.includes(k));
    assert.deepEqual(rest.map((k) => after[k].order), rest.map((k, i) => i + 4), "the rest keep their relative order");
    assert.equal(after[first].tags.includes("e2e-retag"), true, "nothing else changed");
  } finally {
    // Back to the export's numbering, without the e2e item and tag.
    await send({ type: "removeTaggedItem", id: NEW });
    const first = Object.keys(exportData.taggedItems)[0];
    await send({ type: "updateTaggedItemTags", id: first, tags: exportData.taggedItems[first].tags });
    await send({ type: "importData", data: { format: "bc-tagger-order/1", order: Object.keys(exportData.taggedItems) }, mode: "order" });
    await page.close();
  }
});

test("\"#\" migration: items with no number get 1, 2, … in storage order, skipping numbers in use (a server-numbered import above them stays)", async () => {
  const send = (msg) => probe.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);
  const saved = (await storage("taggedItems")).taggedItems;
  const keys = Object.keys(saved); // storage order
  const n = keys.length;
  const fromServer = keys[5]; // as if a pending add numbered by the server came in before the migration
  try {
    const stripped = Object.fromEntries(keys.map((k) => {
      const { order, ...rest } = saved[k];
      return [k, k === fromServer ? { ...rest, order: n + 1 } : rest];
    }));
    await probe.evaluate((items) => chrome.storage.local.set({ taggedItems: items }), stripped);
    // Any write numbers them first: re-tag one (its copy has no "order").
    const target = keys[0];
    await send({ type: "addTaggedItem", item: { ...stripped[target], tags: [...(stripped[target].tags || [])] } });
    await waitFor(async () => Number.isFinite((await storage("taggedItems")).taggedItems[keys[1]].order), { what: "the migration" });
    const items = (await storage("taggedItems")).taggedItems;
    assert.equal(items[fromServer].order, n + 1, "the server's number stays");
    const others = keys.filter((k) => k !== fromServer);
    assert.deepEqual(others.map((k) => items[k].order), others.map((k, i) => i + 1), "1..N-1 in storage order");
  } finally {
    await probe.evaluate((items) => chrome.storage.local.set({ taggedItems: items }), saved);
  }
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
  assert.deepEqual(headers, ["#", "Added", "Modified", "Thumbnail", "Title", "Artist", "Player", "Tags"]);
  const buttons = await page.$$eval("#toolbar button", (bs) => bs.map((b) => b.textContent));
  assert.deepEqual(buttons, ["Refresh player files", "Refresh thumbnails", "Fix artists", "Fix album IDs", "Columns ▾"]);
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
  const row = (tag) => page.locator(`.map-row[data-tag="${tag}"]`);
  // Every tag starts with its own name, so nothing warns.
  assert.equal(await row("must").locator("input").first().inputValue(), "must");
  assert.equal(await page.isVisible(".mapping-warning"), false);
  await row("must").locator("input").first().fill("/DJ/Status/Must");
  await row("must").locator(".map-add").click();
  await row("must").locator("input").nth(1).fill("Favourites");
  await row("pool").locator("input").first().fill("Sub/Pool");
  assert.equal(await page.isVisible(".mapping-warning"), false);
  await page.click("#saveBtn");
  await page.waitForFunction(() => /Saved/.test(document.getElementById("saveState").textContent));
  let s = await api("/api/settings");
  assert.equal(s.tag_playlist_mode, "custom");
  assert.deepEqual(s.tag_playlist_map.must, ["/DJ/Status/Must", "Favourites"]);
  assert.deepEqual(s.tag_playlist_map.pool, ["Sub/Pool"]);
  assert.deepEqual(s.tag_playlist_map.build, ["build"], "the others: their own name");

  await page.reload();
  await page.waitForSelector('.map-row[data-tag="build"]'); // the vocabulary is in (it re-renders the rows)
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

test("Settings: unticking Auto prefills unmapped tags (saved ones untouched); a playlist to be created is yellow", async () => {
  await put({ tag_playlist_mode: "auto", tag_playlist_map: { pool: ["Pool Party"], ritual: [] } });
  const page = await context.newPage();
  try {
    await page.goto(SERVER + "/settings/#rekordbox");
    await page.waitForSelector('.map-row[data-tag="build"]', { state: "attached" }); // the vocabulary is in
    await page.uncheck("#mappingAuto");
    const row = (tag) => page.locator(`.map-row[data-tag="${tag}"]`);
    const entry = (tag) => row(tag).locator(".map-entry").first();
    await page.waitForFunction(() => /exists/.test(document.querySelector('.map-row[data-tag="must"] .map-status').textContent));
    // must: prefilled, and exists in the test library.
    assert.equal(await entry("must").locator("input").inputValue(), "must");
    assert.match(await entry("must").locator(".map-status").textContent(), /^exists · \d+ tracks?$/);
    assert.equal(await entry("must").evaluate((e) => e.classList.contains("missing")), false);
    // pool: the saved mapping is kept, and that playlist doesn't exist yet: yellow.
    assert.equal(await entry("pool").locator("input").inputValue(), "Pool Party");
    assert.equal(await entry("pool").locator(".map-status").textContent(), "does not exist: will be created on export");
    assert.equal(await entry("pool").evaluate((e) => e.classList.contains("missing")), true);
    assert.equal(await entry("pool").locator("input").evaluate((i) => getComputedStyle(i).backgroundColor), "rgb(255, 248, 220)");
    // ritual: deliberately not exported (saved as []): stays empty.
    assert.equal(await entry("ritual").locator("input").inputValue(), "");
    // A bad name stays red, not yellow.
    await entry("must").locator("input").fill("a//b");
    assert.equal(await entry("must").evaluate((e) => e.classList.contains("missing")), false);
    assert.equal(await entry("must").locator(".map-status").evaluate((s) => s.classList.contains("bad")), true);
    await entry("must").locator("input").fill("must");
    await page.click("#saveBtn");
    await page.waitForFunction(() => /Saved/.test(document.getElementById("saveState").textContent));
    const s = await api("/api/settings");
    assert.deepEqual(s.tag_playlist_map.must, ["must"]);
    assert.deepEqual(s.tag_playlist_map.pool, ["Pool Party"]);
    assert.deepEqual(s.tag_playlist_map.ritual, []);
  } finally {
    await put({ tag_playlist_mode: "auto", tag_playlist_map: {} });
    await page.close();
  }
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

test("a tag created in the extension is offered at once in pages already open: a Bandcamp page's tagger, the extension's collection page, the local app", async () => {
  const send = (msg) => probe.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);
  const TAG = "e2e-live-tag";
  const { tags: before } = await storage("tags");
  const bc = await context.newPage();
  const ext = await context.newPage();
  const app = await context.newPage();
  try {
    await bc.goto("https://infiniteexpanse.bandcamp.com/album/synergy-trilogy");
    await bc.waitForSelector("#tagger_a563830364", { state: "attached", timeout: 30000 });
    await ext.goto(extPage("collection.html"));
    await ext.waitForSelector(`tr[data-key="${ITEM}"]`);
    await app.goto(SERVER + "/");
    await app.waitForSelector(`tr[data-key="${ITEM}"]`);
    await app.locator(`tr[data-key="${ITEM}"]`).scrollIntoViewIfNeeded();
    await ext.locator(`tr[data-key="${ITEM}"]`).scrollIntoViewIfNeeded();
    await app.waitForSelector(`tr[data-key="${ITEM}"] select.tag-editor`, { state: "attached" });
    await ext.waitForSelector(`tr[data-key="${ITEM}"] select.tag-editor`, { state: "attached" });

    // Created in the popup (its "+ New tag" sends addTag).
    const res = await send({ type: "addTag", tag: TAG });
    assert.equal(res.ok, true, JSON.stringify(res));
    const offered = (page, sel) =>
      page.waitForFunction(([s, t]) => [...document.querySelectorAll(s)].some((x) => [...x.options].some((o) => o.value === t)), [sel, TAG], { timeout: 10000 });
    const where = [];
    for (const [name, page, sel] of [
      ["Bandcamp page", bc, "#tagger_a563830364"],
      ["extension collection page", ext, `tr[data-key="${ITEM}"] select.tag-editor`],
      ["local app", app, `tr[data-key="${ITEM}"] select.tag-editor`],
    ]) {
      await offered(page, sel).catch(() => where.push(name));
    }
    assert.deepEqual(where, [], `not offered on: ${where.join(", ")}`);
    // The Bandcamp tagger's autocomplete finds it too.
    await bc.click("#tagger_a563830364 + .chosen-container");
    await bc.keyboard.type("e2e-live");
    await bc.waitForFunction((t) => [...document.querySelectorAll(".chosen-container-active .chosen-results li")].some((li) => li.textContent.trim() === t), TAG, { timeout: 5000 });
    // Tags that arrive without the popup's broadcast (an import's new tags are written straight to storage).
    const { tags: now } = await storage("tags");
    await probe.evaluate((t) => chrome.storage.local.set({ tags: t }), [...now, `${TAG}-2`]);
    await offered(bc, "#tagger_a563830364").catch(() => {});
    await bc.waitForFunction((t) => [...document.querySelectorAll("#tagger_a563830364 option")].some((o) => o.value === t), `${TAG}-2`, { timeout: 10000 });
  } finally {
    await send({ type: "updateTags", tags: before });
    await Promise.all([bc.close(), ext.close(), app.close()]);
  }
});

test("after the extension reloads (a dev rebuild, an update), open pages get a fresh content script: one tagger per item, which hears new tags; the app's bridge still answers", async () => {
  // Chrome cuts off the old copies on a reload, and the background injects fresh ones
  // (refreshContentScripts). Reloading the extension here unloads it for good, so the
  // test asks the background to do the injection directly.
  const send = (msg) => probe.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);
  const TAG = "e2e-after-reload";
  const { tags: before } = await storage("tags");
  const bc = await context.newPage();
  const app = await context.newPage();
  try {
    await bc.goto("https://infiniteexpanse.bandcamp.com/album/synergy-trilogy");
    await bc.waitForSelector("#tagger_a563830364", { state: "attached", timeout: 30000 });
    const widgets = await bc.$$eval(".tagger-container", (n) => (n.forEach((x) => (x.dataset.e2eOld = "1")), n.length));
    await app.goto(SERVER + "/");
    await app.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
    assert.deepEqual(await send({ type: "refreshContentScripts" }), { ok: true });
    // The Bandcamp tab: the old widgets replaced by fresh ones, one per item, which hear a new tag.
    await bc.waitForFunction(
      (n) => !document.querySelector("[data-e2e-old]") && document.querySelectorAll(".tagger-container").length === n && document.querySelector("#tagger_a563830364"),
      widgets,
      { timeout: 30000 }
    );
    await send({ type: "addTag", tag: TAG });
    await bc.waitForFunction((t) => [...document.querySelectorAll("#tagger_a563830364 option")].some((o) => o.value === t), TAG, { timeout: 15000 });
    // The app tab: its bridge answers.
    const answer = await app.evaluate(
      () =>
        new Promise((resolve) => {
          const id = `e2e-${Math.random()}`;
          const on = (e) => {
            if (e.data && e.data.bcTagger === "response" && e.data.id === id) {
              removeEventListener("message", on);
              resolve(e.data);
            }
          };
          addEventListener("message", on);
          postMessage({ bcTagger: "request", id, op: "status", payload: {} }, location.origin);
          setTimeout(() => resolve(null), 5000);
        })
    );
    assert.ok(answer && answer.ok, JSON.stringify(answer));
  } finally {
    await send({ type: "updateTags", tags: before }).catch(() => {});
    await Promise.all([bc.close(), app.close()]);
  }
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

test("player: hovering a track that is playing doesn't stop it (hover still loads a paused one); the Artist cell copies \"Artist Title\"", async () => {
  const a = "t1002746421"; // Futuro Lontano by TSVI (durable stream link: an <audio> from the start)
  const page = await context.newPage();
  try {
    await page.goto(extPage("collection.html"));
    await page.waitForSelector(`tr[data-key="${a}"] audio`, { state: "attached" });
    if (!(await page.isChecked("#globalModeToggle"))) await page.click("#globalModeToggle");
    // A paused player: hovering loads its metadata, so the timeline can be scrubbed first.
    const other = await page.evaluate((a) => {
      const r = [...document.querySelectorAll("#collectionTable tbody tr")].find((tr) => tr.dataset.key !== a && tr.querySelector("td.player-cell audio"));
      return r && r.dataset.key;
    }, a);
    if (other) {
      await page.locator(`tr[data-key="${other}"] audio`).scrollIntoViewIfNeeded();
      await page.hover(`tr[data-key="${other}"] audio`);
      await page.waitForFunction((k) => document.querySelector(`tr[data-key="${k}"] audio`).readyState > 0, other, { timeout: 10000 });
    }
    // Play (a row click), then hover the player: it keeps playing (load() would reset it).
    await page.$eval(`tr[data-key="${a}"] audio`, (au) => {
      au.loop = true; // the stand-in stream is 1 s of silence
      window.__audioEvents = [];
      ["emptied", "abort", "pause"].forEach((t) => au.addEventListener(t, () => window.__audioEvents.push(t)));
    });
    await page.locator(`tr[data-key="${a}"]`).scrollIntoViewIfNeeded();
    await page.click(`tr[data-key="${a}"] .col-date`);
    await page.waitForFunction(() => [...document.querySelectorAll("audio")].some((au) => !au.paused && au.currentTime > 0), null, { timeout: 10000 });
    const playing = await page.evaluateHandle(() => [...document.querySelectorAll("audio")].find((au) => !au.paused));
    await playing.hover();
    await page.waitForTimeout(600);
    assert.equal(await playing.evaluate((au) => au.paused), false, "still playing after the hover");
    assert.deepEqual(await page.evaluate(() => window.__audioEvents), [], "not reset or paused");
    await page.evaluate(() => document.querySelectorAll("audio").forEach((au) => au.pause()));

    // The copy button at the right of the Artist cell (the clipboard is stubbed: the real one stays as it is).
    await page.evaluate(() => {
      window.__copied = [];
      navigator.clipboard.writeText = async (t) => window.__copied.push(t);
    });
    const cell = await page.$(`tr[data-key="${a}"] td.col-artist`);
    const [btn, box] = [await cell.$(".copy-btn").then((b) => b.boundingBox()), await cell.boundingBox()];
    assert.ok(box.x + box.width - (btn.x + btn.width) < 12, "at the cell's right edge");
    assert.equal(await cell.$eval(".artist-name", (n) => n.textContent), "TSVI");
    await page.click(`tr[data-key="${a}"] .copy-btn`);
    assert.deepEqual(await page.evaluate(() => window.__copied), ["TSVI Futuro Lontano"]);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("audio")].some((au) => !au.paused)), false, "copying doesn't play the row");
  } finally {
    await page.close();
  }
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

test("import: file → tag mapping → preview (tints, release, to confirm, match sources, lookup unavailable, Open on Bandcamp, pasted URL) → Import selected", async () => {
  const stub = importStub(JSON.parse(fs.readFileSync(IMPORT_SAMPLE, "utf8")), { located: [1, 2], unavailable: [7] });
  const page = await context.newPage();
  await stub.install(page);
  page.on("dialog", (d) => d.accept());
  await page.goto(SERVER + "/settings/#import");
  await page.setInputFiles("#importFile", IMPORT_SAMPLE);
  await page.waitForFunction(() => /7 rows from/.test(document.getElementById("importFileInfo").textContent));
  const fileInfo = await page.textContent("#importFileInfo");
  assert.match(fileInfo, /1 already in your collection/);
  assert.match(fileInfo, /1 to confirm/);
  assert.match(fileInfo, /1 release not importable yet/);
  assert.match(fileInfo, /2 tags not in your vocabulary/);
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

  // Preview: tints, rows to confirm, release info, where each match came from.
  await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length === 7);
  // Selection first; Added and Modified (nothing has either yet) are off but listed in Columns ▾.
  const previewCols = await page.$$eval("#collectionTable thead th", (ths) => ths.map((th) => th.className.replace(/^col-/, "")));
  assert.equal(previewCols[0], "sel");
  assert.ok(!previewCols.includes("modified") && !previewCols.includes("date"));
  await page.click("#columnsChooser");
  assert.equal(await page.isChecked('#columnsMenu label[data-col="modified"] input'), false);
  await page.click("#columnsChooser");
  const rows = Object.fromEntries(
    (
      await page.$$eval("#collectionTable tbody tr", (trs) =>
        trs.map((tr) => ({
          key: tr.dataset.key,
          cls: ["row-duplicate", "row-missing", "row-confirm"].filter((c) => tr.classList.contains(c)).join(" "),
          source: tr.querySelector(".match-cell .chip").dataset.source,
          open: tr.querySelector(".match-cell a.open-bc") && {
            text: tr.querySelector(".match-cell a.open-bc").textContent,
            href: tr.querySelector(".match-cell a.open-bc").href,
          },
          release: tr.querySelector("td.release-cell").innerText.replace(/\s+/g, " ").trim(),
          confirm: !!tr.querySelector(".confirm-chip"),
        }))
      )
    ).map((r) => [r.key, r])
  );
  assert.equal(rows.r0.cls, "row-duplicate");
  assert.equal(rows.r0.source, "collection");
  assert.equal(rows.r0.open, null, "matched rows have no Open link in the cell");
  assert.equal(rows.r1.cls, "", "located, not a duplicate");
  assert.equal(rows.r1.source, "file", "resolved from the file's link");
  assert.equal(rows.r1.open, null);
  assert.equal(rows.r1.release, "Select Edits (2017-2020) track 4");
  assert.equal(rows.r6.source, "unavailable");
  assert.deepEqual(rows.r6.open, { text: "Open link ↗", href: "https://someband.bandcamp.com/track/hinted-but-blocked" });
  assert.match(await page.textContent("#lookupUnavailable"), /Bandcamp lookup unavailable for 1 row: .*Client Challenge/);
  assert.equal(rows.r2.cls, "row-missing row-confirm");
  assert.equal(rows.r2.confirm, true);
  assert.deepEqual(rows.r2.open, { text: "Search ↗", href: "https://bandcamp.com/search?q=Nobody%20Known%20Slow%20One&item_type=t" });
  assert.equal(rows.r3.release, "Cosmic Function B1 · track 2");
  assert.equal(rows.r4.release, "Cosmic Function B2 · track 3", "same title, distinct rows");
  assert.equal(rows.r5.source, "candidates");
  assert.equal(await page.getAttribute("tr[data-key='r2'] a.open-bc", "target"), "_blank");
  assert.match(await page.textContent(".import-stats"), /7 rows .*1 to confirm/);
  assert.match(await page.textContent(".import-pending"), /1 release not importable yet .*Sample Artist – Sample EP/);

  // Show filter.
  const shown = () => page.$$eval("#collectionTable tbody tr", (trs) => trs.map((tr) => tr.dataset.key));
  await page.selectOption("#importShow", "confirm");
  assert.deepEqual(await shown(), ["r2"]);
  await page.selectOption("#importShow", "duplicates");
  assert.deepEqual(await shown(), ["r0"]);
  await page.selectOption("#importShow", "unavailable");
  assert.deepEqual(await shown(), ["r6"]);
  await page.selectOption("#importShow", "all");
  assert.equal((await shown()).length, 7);

  // Look up again (re_resolve) is offered, except where the lookup hit the bot check.
  await page.click("tr[data-key='r6'] .match-cell .chip");
  await page.click(".popover button:has-text('Edit artist/title')");
  assert.equal(await page.$(".popover button:has-text('look up again')"), null);
  await page.keyboard.press("Escape");
  await page.click("tr[data-key='r3'] .match-cell .chip");
  await page.click(".popover button:has-text('Edit artist/title')");
  await page.click(".popover button:has-text('Save and look up again')");
  await waitFor(() => stub.calls.some((c) => c.method === "PUT" && c.body.re_resolve === true), { what: "the re_resolve PUT" });
  assert.deepEqual(stub.calls.filter((c) => c.method === "PUT").pop().body, { artist: "The Carbon Boys", title: "Untitled", re_resolve: true });

  // Paste a URL: junk is refused; a page URL (query dropped) is kept for the
  // row (the extension links it when the page is opened).
  await page.click("tr[data-key='r2'] .match-cell .chip");
  await page.fill(".popover .match-url", "not a url");
  await page.click(".popover .pop-url button.primary");
  assert.match(await page.textContent(".popover .pop-err"), /isn't a Bandcamp track or album page/);
  await page.fill(".popover .match-url", "https://nobodyknown.bandcamp.com/track/slow-one?from=search");
  await page.click(".popover .pop-url button.primary");
  await page.waitForFunction(() => document.querySelector("tr[data-key='r2'] .match-cell .chip").dataset.source === "url");
  assert.deepEqual(stub.calls.filter((c) => c.method === "PUT").pop().body, { match_url: "https://nobodyknown.bandcamp.com/track/slow-one" });
  assert.equal(await page.getAttribute("tr[data-key='r2'] a.open-bc", "href"), "https://nobodyknown.bandcamp.com/track/slow-one");

  // Pick a candidate, then send that row back to Other.
  await page.click("tr[data-key='r5'] .match-cell .chip");
  await page.click(".popover .pop-file button.primary >> nth=0");
  await page.waitForFunction(() => document.querySelector("tr[data-key='r5'] .match-cell .chip").dataset.source === "picked");
  assert.deepEqual(stub.calls.filter((c) => c.method === "PUT").pop().body, { choose: "t7000000001" });
  await page.click("tr[data-key='r5'] .match-cell .chip");
  await page.click(".popover button.danger");
  await page.waitForFunction(() => document.querySelector("tr[data-key='r5'] .match-cell .chip").dataset.source === "notbc");
  assert.deepEqual(stub.calls.filter((c) => c.method === "PUT").pop().body, { choose: null });

  // Select: one row off, then Import selected.
  await page.click("tr[data-key='r3'] .row-check");
  await page.waitForFunction(() => /\(6\)/.test(document.getElementById("importSelected").textContent));
  assert.equal(await page.$eval("#selectAll", (b) => b.indeterminate), true);
  await page.click("#importSelected");
  await page.waitForFunction(() => /^Imported:/.test(document.getElementById("refreshStatus").textContent));
  assert.match(await page.textContent("#refreshStatus"), /pending adds 1, tag merges 1, other added 4/);
  assert.ok(stub.calls.some((c) => c.path.endsWith("/commit")));
  assert.deepEqual(standInPages, [], "the preview fetches no Bandcamp pages");
  await page.close();
});

test("import: lookups paused by Bandcamp's rate limiting resume from the preview (stubbed API)", async () => {
  const stub = importStub(JSON.parse(fs.readFileSync(IMPORT_SAMPLE, "utf8")), { paused: [3, 6] });
  const page = await context.newPage();
  await stub.install(page);
  await page.goto(SERVER + "/import/?batch=e2e-b1");
  await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length === 7);
  assert.match(await page.textContent("#lookupUnavailable"), /Bandcamp lookup paused with 2 rows left: Bandcamp is rate-limiting/);
  assert.equal(await page.$eval("tr[data-key='r2'] .match-cell .chip", (c) => c.dataset.source), "unavailable");
  await page.click("#resumeLookups");
  await waitFor(() => stub.calls.some((c) => c.path.endsWith("/resume")), { what: "the resume call" });
  await page.waitForFunction(() => document.getElementById("lookupUnavailable").hidden);
  assert.equal(await page.$eval("tr[data-key='r2'] .match-cell .chip", (c) => c.dataset.source), "none");
  await page.close();
});

test("Settings → Import: import_log_dir round-trips; a folder inside a music folder is refused", async () => {
  const page = await context.newPage();
  const custom = path.join(E2E, "import-logs-custom");
  try {
    await page.goto(SERVER + "/settings/");
    await page.waitForSelector("#f_import_log_dir");
    assert.equal(await page.inputValue("#f_import_log_dir"), "");
    assert.match(await page.getAttribute("#f_import_log_dir", "placeholder"), /import-logs/);
    await page.fill("#f_import_log_dir", custom);
    await page.click("#saveBtn");
    await page.waitForFunction(() => /Saved/.test(document.getElementById("saveState").textContent));
    assert.equal((await api("/api/settings").then((d) => d.settings || d)).import_log_dir, custom);
    const owned = (await api("/api/settings").then((d) => d.settings || d)).owned_root;
    assert.ok(owned, "the test server has an owned folder");
    await page.fill("#f_import_log_dir", path.join(owned, "logs"));
    await page.click("#saveBtn");
    await page.waitForFunction(() => /Not saved: .*music root/.test(document.getElementById("saveState").textContent));
    assert.equal((await api("/api/settings").then((d) => d.settings || d)).import_log_dir, custom, "unchanged");
  } finally {
    await put({ import_log_dir: "" });
    await page.close();
  }
});

test("Settings → Import lookups: lookup_source (bandcamp by default) round-trips", async () => {
  const page = await context.newPage();
  try {
    await page.goto(SERVER + "/settings/");
    await page.waitForSelector("#f_lookup_source");
    assert.equal(await page.inputValue("#f_lookup_source"), "bandcamp");
    assert.deepEqual(await page.$$eval("#f_lookup_source option", (o) => o.map((x) => x.value)), ["bandcamp", "musicbrainz", "both"]);
    await page.selectOption("#f_lookup_source", "both");
    await page.click("#saveBtn");
    await page.waitForFunction(() => /Saved/.test(document.getElementById("saveState").textContent));
    assert.equal((await api("/api/settings")).lookup_source, "both");
  } finally {
    await put({ lookup_source: "bandcamp" });
    await page.close();
  }
});

test("Settings → Bandcamp requests: the three values round-trip, and both collection pages use the browser ones", async () => {
  const page = await context.newPage();
  await page.goto(SERVER + "/settings/");
  await page.waitForSelector("#f_bandcamp_browser_concurrency");
  assert.match(await page.textContent("#sec_bandcamp_requests"), /rate limiting \(HTTP 429\)/);
  await page.fill("#f_bandcamp_request_interval_s", "1.5");
  await page.fill("#f_bandcamp_browser_concurrency", "1");
  await page.fill("#f_bandcamp_browser_spacing_ms", "150");
  await page.click("#saveBtn");
  await waitFor(() => api("/api/settings").then((d) => (d.settings || d).bandcamp_browser_spacing_ms === 150), { what: "the saved settings" });
  const saved = await api("/api/settings").then((d) => d.settings || d);
  assert.equal(saved.bandcamp_request_interval_s, 1.5);
  assert.equal(saved.bandcamp_browser_concurrency, 1);
  for (const url of [SERVER + "/", extPage("collection.html")]) {
    const p = await context.newPage();
    await p.goto(url);
    await p.waitForFunction(() => document.documentElement.dataset.bandcampLimits === "1/150", null, { timeout: 15000 });
    await p.close();
  }
  // Out of range: the server refuses it and nothing changes.
  await page.fill("#f_bandcamp_browser_concurrency", "9");
  await page.click("#saveBtn");
  await page.waitForTimeout(800);
  assert.equal((await api("/api/settings").then((d) => d.settings || d)).bandcamp_browser_concurrency, 1);
  await put({ bandcamp_request_interval_s: 1, bandcamp_browser_concurrency: 2, bandcamp_browser_spacing_ms: 400 });
  await page.close();
});

test("import: Add default tags to all tracks, at the start and on an open batch's preview (stubbed API)", async () => {
  const stub = importStub(JSON.parse(fs.readFileSync(IMPORT_SAMPLE, "utf8")));
  const page = await context.newPage();
  await stub.install(page);
  await page.goto(SERVER + "/settings/#import");
  await page.setInputFiles("#importFile", IMPORT_SAMPLE);
  await page.waitForFunction(() => /rows from/.test(document.getElementById("importFileInfo").textContent));
  assert.equal(await page.isChecked("#importDefaultAll"), false, "off by default");
  await page.check("#importDefaultAll");
  await page.click("#importStart");
  await waitFor(() => stub.calls.some((c) => c.method === "POST" && c.path === "/api/import"), { what: "the create call" });
  const create = stub.calls.find((c) => c.method === "POST" && c.path === "/api/import");
  assert.equal(create.body.default_tags_all, true);
  assert.deepEqual(create.body.default_tags, ["must"]);

  // On the preview of an open batch: shown with the default tags, off; on → every track gets them.
  await page.goto(SERVER + "/import/?batch=e2e-b1");
  await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length === 7);
  assert.match(await page.textContent(".import-defaults"), /Default tags: must · Add default tags to all tracks/);
  assert.equal(await page.isChecked("#previewDefaultAll"), false);
  const tagsOf = (key) => page.$eval(`tr[data-key='${key}']`, (tr) => [...tr.querySelectorAll("select.tag-editor option:checked")].map((o) => o.value));
  await page.locator("tr[data-key='r0']").scrollIntoViewIfNeeded();
  await page.waitForSelector("tr[data-key='r0'] select.tag-editor", { state: "attached" });
  assert.deepEqual(await tagsOf("r0"), ["drums"]);
  await page.check("#previewDefaultAll");
  await waitFor(() => stub.calls.some((c) => c.path.endsWith("/default-tags")), { what: "the default-tags call" });
  assert.deepEqual(stub.calls.find((c) => c.path.endsWith("/default-tags")).body, { tags: ["must"], all: true });
  await page.waitForFunction(() => [...document.querySelectorAll("tr[data-key='r0'] select.tag-editor option:checked")].some((o) => o.value === "must"));
  assert.deepEqual((await tagsOf("r0")).sort(), ["drums", "must"]);
  assert.equal(await page.isChecked("#previewDefaultAll"), true);
  await page.close();
});

// --- Locate again, and setting a row's file by hand -------------------------------------
// A folder of the test server's own (.e2e/music, an extra root) gets a file
// after the batch exists; nothing touches the user's music folders.

const E2E_MUSIC = path.join(E2E, "music");
const PYTHON = process.env.E2E_PYTHON || "/Users/alvaroh/Projects/auto-rekordbox/.venv/bin/python"; // the server's (has mutagen)
function writeAiff(file, title, artist, album) {
  execFileSync(PYTHON, [
    "-c",
    "import sys; sys.path[:0] = sys.argv[1:3]; from pathlib import Path; from conftest import write_aiff; write_aiff(Path(sys.argv[3]), sys.argv[4], sys.argv[5], sys.argv[6], 1)",
    path.join(ROOT, "server/tests"),
    path.join(ROOT, "server"),
    file,
    title,
    artist,
    album,
  ]);
}

test("import preview: Locate again finds a file added later; Set file by search; a hand-set file survives Locate again (real server)", async () => {
  fs.rmSync(E2E_MUSIC, { recursive: true, force: true });
  fs.mkdirSync(E2E_MUSIC, { recursive: true });
  await put({ extra_roots: [{ path: E2E_MUSIC, kind: "not_owned" }] });
  const items = [
    { line: 1, raw: "E2E Late Artist - E2E Late File", artist: "E2E Late Artist", title: "E2E Late File", album: "E2E Late Album", tags: ["must"] },
    { line: 2, raw: "Nobody - Picked By Hand", artist: "Nobody", title: "Picked By Hand", tags: ["must"] },
  ];
  const res = await post("/api/import", { file: { format: "bc-tagger-import/1", source: "e2e-locate.txt", items }, default_tags: [], name: "e2e-locate" });
  const batchId = res.batch_id;
  const page = await context.newPage();
  try {
    await waitFor(() => api(`/api/import/${batchId}`).then((b) => b.status === "ready"), { what: "the batch", timeout: 30000 });
    await page.goto(`${SERVER}/import/?batch=${batchId}`);
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length === 2);
    const loc = (k) => page.$eval(`tr[data-key='${k}'] .located-cell .chip`, (c) => c.dataset.status);
    assert.equal(await loc("r0"), "missing");
    assert.ok(await page.$eval("tr[data-key='r0']", (tr) => tr.classList.contains("row-missing")));

    // The file shows up after the batch was made: Locate again (missing rows).
    const late = path.join(E2E_MUSIC, "E2E Late Artist - E2E Late File.aiff");
    writeAiff(late, "E2E Late File", "E2E Late Artist", "E2E Late Album");
    await page.click("#locateAgain");
    await page.waitForFunction(() => /^Locate again: 1 newly located/.test(document.getElementById("refreshStatus").textContent), null, { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector("tr[data-key='r0'] .located-cell .chip").dataset.status === "located");
    assert.ok(!(await page.$eval("tr[data-key='r0']", (tr) => tr.classList.contains("row-missing"))), "no longer light red");

    // Set file… for the other row, by searching the index.
    await page.click("tr[data-key='r1'] .located-cell .chip");
    await page.click(".popover button:has-text('Set file…')");
    assert.equal(await page.inputValue(".popover .set-file-q"), "Nobody Picked By Hand");
    await page.fill(".popover .set-file-q", "e2e late file");
    await page.click(".popover .set-file button:has-text('Search')");
    await page.waitForSelector(".popover .set-file-results .pop-file");
    assert.match(await page.textContent(".popover .set-file-results"), /E2E Late File/);
    await page.click(".popover .set-file-results .pop-file button.primary");
    await page.waitForFunction(() => document.querySelector("tr[data-key='r1'] .located-cell .chip").dataset.status === "located-manual");
    assert.equal(await page.textContent("tr[data-key='r1'] .located-cell .chip"), "✓ set manually");

    // Locate again on all rows keeps the hand-set file.
    await page.check("#locateAllRows");
    await page.click("#locateAgain");
    await page.waitForFunction(() => /^Locate again: /.test(document.getElementById("refreshStatus").textContent) && !document.getElementById("locateAgain").disabled, null, { timeout: 60000 });
    await page.waitForTimeout(300);
    assert.equal(await loc("r1"), "located-manual");
    const row1 = (await api(`/api/import/${batchId}`)).rows[1];
    assert.equal(row1.located.best.path, late);
    assert.equal(row1.located.manual, true);
  } finally {
    await api(`/api/import/${batchId}`, { method: "DELETE" });
    await put({ extra_roots: [] });
    fs.rmSync(E2E_MUSIC, { recursive: true, force: true });
    await page.close();
  }
});

test("import preview: Set file → Browse from the music folders to a file; the next Browse opens there; a folder outside is refused (real server)", async () => {
  fs.rmSync(E2E_MUSIC, { recursive: true, force: true });
  const album = path.join(E2E_MUSIC, "Some Artist", "Some Album");
  writeAiff(path.join(album, "01 Browse Me.aiff"), "Browse Me", "Some Artist", "Some Album");
  writeAiff(path.join(album, "02 Browse Me Too.aiff"), "Browse Me Too", "Some Artist", "Some Album");
  const before = await api("/api/settings").then((d) => d.settings || d);
  const saved = await put({ extra_roots: [{ path: E2E_MUSIC, kind: "not_owned" }], ...("last_browse_dir" in before ? { last_browse_dir: "" } : {}) });
  assert.ok(!saved.detail, `settings: ${JSON.stringify(saved.detail)}`);
  const items = [
    { line: 1, raw: "Nobody - First Unknown", artist: "Nobody", title: "First Unknown", tags: ["must"] },
    { line: 2, raw: "Nobody - Second Unknown", artist: "Nobody", title: "Second Unknown", tags: ["must"] },
  ];
  const { batch_id: batchId } = await post("/api/import", { file: { format: "bc-tagger-import/1", source: "e2e-browse.txt", items }, default_tags: [], name: "e2e-browse" });
  const page = await context.newPage();
  const openBrowser = async (key) => {
    await page.click(`tr[data-key='${key}'] .located-cell .chip`);
    await page.click(".popover button:has-text('Set file…')");
    await page.click(".popover #browseFiles");
    await page.waitForSelector(".popover #folderBrowser .fb-entry, .popover #folderBrowser .fb-msg:not(:empty)");
  };
  try {
    await waitFor(() => api(`/api/import/${batchId}`).then((b) => b.status === "ready"), { what: "the batch", timeout: 30000 });
    await page.goto(`${SERVER}/import/?batch=${batchId}`);
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length === 2);

    // From the music folders down to the file.
    await openBrowser("r0");
    await page.click(`.popover .fb-dir[data-path="${E2E_MUSIC}"]`);
    await page.click(`.popover .fb-dir[data-path="${path.join(E2E_MUSIC, "Some Artist")}"]`);
    await page.click(`.popover .fb-dir[data-path="${album}"]`);
    await page.waitForFunction(() => /Some Album$/.test(document.querySelector(".popover .fb-crumbs").textContent));
    assert.equal(await page.textContent(".popover .fb-crumbs"), `Music folders / ${E2E_MUSIC} / Some Artist / Some Album`);
    await page.click(`.popover .fb-file[data-path="${path.join(album, "01 Browse Me.aiff")}"]`);
    await page.waitForFunction(() => document.querySelector("tr[data-key='r0'] .located-cell .chip").dataset.status === "located-manual");
    assert.equal((await api(`/api/import/${batchId}`)).rows[0].located.best.path, path.join(album, "01 Browse Me.aiff"));

    // The next Browse opens in that folder.
    await openBrowser("r1");
    await page.waitForSelector(`.popover .fb-file[data-path="${path.join(album, "02 Browse Me Too.aiff")}"]`);
    assert.match(await page.textContent(".popover .fb-crumbs"), /Some Album$/);
    assert.equal((await api("/api/settings").then((d) => d.settings || d)).last_browse_dir, album);
    await page.keyboard.press("Escape");

    // A remembered folder that's outside the music folders now is refused: the music folders show instead.
    await put({ last_browse_dir: E2E });
    await openBrowser("r1");
    await page.waitForFunction(() => /Can't open/.test(document.querySelector(".popover .fb-msg").textContent));
    assert.ok(await page.$(`.popover .fb-dir[data-path="${E2E_MUSIC}"]`), "back at the music folders");
  } finally {
    await api(`/api/import/${batchId}`, { method: "DELETE" });
    await put({ extra_roots: [], ...("last_browse_dir" in before ? { last_browse_dir: before.last_browse_dir || "" } : {}) });
    fs.rmSync(E2E_MUSIC, { recursive: true, force: true });
    await page.close();
  }
});

// --- Collection: the checkbox column and bulk actions -----------------------------------

test("collection: with rows selected, Locate / Export / Download act on them; with none, on the rows shown", async () => {
  const app = await context.newPage();
  const posts = [];
  app.on("request", (r) => {
    const p = new URL(r.url()).pathname;
    if (r.method() === "POST" && /^\/api\/(locate|rekordbox\/export|download)$/.test(p)) posts.push({ path: p, body: JSON.parse(r.postData() || "{}") });
  });
  try {
    await app.goto(SERVER + "/");
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 2);
    const shown = await app.$$eval("#collectionTable tbody tr", (r) => r.length);
    assert.equal(await app.textContent("#locateShown"), `Locate shown (${shown})`);
    assert.equal(await app.isVisible("#clearSelection"), false);
    const keys = await app.$$eval("#collectionTable tbody tr", (r) => r.slice(0, 2).map((x) => x.dataset.key));
    for (const k of keys) await app.check(`tr[data-key="${k}"] .row-check`);
    assert.equal(await app.textContent("#locateShown"), "Locate selected (2)");
    assert.equal(await app.textContent("#exportShown"), "Export Selected to RB (2)…");
    assert.equal(await app.textContent("#downloadOwnedMissing"), "Download owned missing (selected)");
    assert.equal(await app.textContent("#clearSelection"), "Clear selection (2)");
    assert.equal(await app.$eval("#selectAll", (b) => b.indeterminate), true);

    // Locate selected: just those two.
    await app.click("#locateShown");
    await waitFor(async () => posts.some((p) => p.path === "/api/locate"), { what: "the locate call" });
    assert.deepEqual(posts.find((p) => p.path === "/api/locate").body.ids.slice().sort(), keys.slice().sort());
    await app.waitForFunction(() => /^Locate: /.test(document.getElementById("refreshStatus").textContent) && !document.getElementById("locateShown").disabled, null, { timeout: 120000 });

    // Export selected: the dry run is for those two (cancelled if it asks; nothing written).
    await app.click("#exportShown");
    await waitFor(async () => posts.some((p) => p.path === "/api/rekordbox/export"), { what: "the export dry run", timeout: 60000 });
    await app.waitForFunction(
      () => document.querySelector(".confirm-dialog .dialog-cancel") || !document.getElementById("exportShown").disabled,
      null,
      { timeout: 60000 }
    );
    if (await app.$(".confirm-dialog .dialog-cancel")) await app.click(".confirm-dialog .dialog-cancel");
    const dry = posts.find((p) => p.path === "/api/rekordbox/export");
    assert.equal(dry.body.dry_run, true);
    assert.deepEqual(dry.body.ids.slice().sort(), keys.slice().sort());
    await app.waitForFunction(() => !document.getElementById("exportShown").disabled);
    assert.equal(posts.filter((p) => p.path === "/api/rekordbox/export").length, 1, "only the dry run");

    // Download (selected): neither is an owned missing item, so nothing is asked of the server.
    await app.click("#downloadOwnedMissing");
    await app.waitForFunction(() => /^Download: nothing to download/.test(document.getElementById("refreshStatus").textContent));
    assert.equal(posts.filter((p) => p.path === "/api/download").length, 0);

    // Clear: back to the rows shown. Select all: every row shown.
    await app.click("#clearSelection");
    assert.equal(await app.textContent("#locateShown"), `Locate shown (${shown})`);
    assert.equal(await app.isChecked(`tr[data-key="${keys[0]}"] .row-check`), false);
    await app.check("#selectAll");
    assert.equal(await app.textContent("#locateShown"), `Locate selected (${shown})`);
    await app.uncheck("#selectAll");
    assert.equal(await app.textContent("#locateShown"), `Locate shown (${shown})`);
  } finally {
    await app.close();
  }
});

// --- Phase 6: Modified, the Columns chooser -----------------------------------------------

test("collection: the Columns chooser lists every column in order, toggles at once and remembers it; Selection first, Modified next to Added, Track # off", async () => {
  const app = await context.newPage();
  const KEY = "bc_app_col_widths_v2_shown";
  try {
    await app.goto(SERVER + "/");
    await app.evaluate((k) => localStorage.removeItem(k), KEY);
    await app.reload();
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 0);
    const headers = () => app.$$eval("#collectionTable thead th", (ths) => ths.map((th) => th.className.replace(/^col-/, "")));
    const h = await headers();
    assert.equal(h[0], "sel", "Selection first");
    assert.equal(h.indexOf("modified"), h.indexOf("date") + 1, "Modified next to Added");
    assert.ok(!h.includes("track"), "Track # is off by default");
    await app.click("#columnsChooser");
    const menu = await app.$$eval("#columnsMenu label", (ls) => ls.map((l) => [l.dataset.col, l.querySelector("input").checked]));
    assert.deepEqual(menu.filter(([, on]) => on).map(([id]) => id), h, "the shown columns, in display order");
    assert.deepEqual(menu.find(([id]) => id === "track"), ["track", false]);
    assert.equal(await app.textContent('#columnsMenu label[data-col="sel"]'), " Selection");
    await app.click('#columnsMenu label[data-col="track"] input');
    assert.ok((await headers()).includes("track"), "shown at once");
    await app.click('#columnsMenu label[data-col="thumb"] input');
    assert.ok(!(await headers()).includes("thumb"), "hidden at once");
    await app.reload();
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 0);
    const h2 = await headers();
    assert.ok(h2.includes("track") && !h2.includes("thumb"), "remembered");
    assert.ok(h2.indexOf("track") > h2.indexOf("modified") && h2.indexOf("track") < h2.indexOf("title"), "the order is kept");
    // The extension's page has its own choice.
    const ext = await context.newPage();
    await ext.goto(extPage("collection.html"));
    await ext.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 0);
    assert.ok(!(await ext.$$eval("#collectionTable thead th", (ths) => ths.map((th) => th.className))).includes("col-track"));
    await ext.close();
  } finally {
    await app.evaluate((k) => localStorage.removeItem(k), KEY).catch(() => {});
    await app.close();
  }
});

test("collection: Modified is when tags last changed; newest first puts undated items last", async () => {
  const app = await context.newPage();
  try {
    await app.goto(SERVER + "/");
    await app.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 5);
    const [a, b] = await app.$$eval("#collectionTable tbody tr", (trs) => trs.slice(3, 5).map((tr) => tr.dataset.key));
    const edit = async (key) => {
      await app.locator(`tr[data-key="${key}"]`).scrollIntoViewIfNeeded();
      await app.waitForSelector(`tr[data-key="${key}"] select.tag-editor`, { state: "attached" });
      const tags = await app.$eval(`tr[data-key="${key}"] select.tag-editor`, (s) => [...s.selectedOptions].map((o) => o.value));
      const next = tags.includes("pool") ? tags.filter((t) => t !== "pool") : [...tags, "pool"];
      await app.evaluate(([k, t]) => $(`tr[data-key="${k}"] select.tag-editor`).val(t).trigger("change"), [key, next]);
      await waitFor(() => api(`/api/items/${key}`).then((it) => it.modified_at && JSON.stringify(it.tags.slice().sort()) === JSON.stringify(next.slice().sort())), { what: `${key} modified on the server` });
    };
    await edit(a);
    await sleep(50);
    await edit(b); // b is newer
    const items = await storage("taggedItems");
    assert.ok(items.taggedItems[a].modified_at && items.taggedItems[b].modified_at > items.taggedItems[a].modified_at, "the extension stamps modified_at");
    await app.reload();
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 5);
    await app.click("th.col-modified"); // oldest first
    await app.click("th.col-modified"); // newest first
    assert.match(await app.textContent("th.col-modified"), /▼/);
    const order = await app.$$eval("#collectionTable tbody tr", (trs) => trs.map((tr) => [tr.dataset.key, tr.querySelector(".col-modified").textContent]));
    const keys = order.map(([k]) => k);
    assert.ok(keys.indexOf(b) < keys.indexOf(a), "newest first");
    const firstUndated = order.findIndex(([, d]) => !d);
    assert.ok(firstUndated > keys.indexOf(a), "undated items after the dated ones");
    assert.ok(order.slice(firstUndated).every(([, d]) => !d), "…all of them at the end");
  } finally {
    await app.close();
  }
});

// --- Phase 4: downloading owned releases (Session A's stub downloader) ----------------
// The test server's owned folder is .e2e/owned (downloads go there) and its
// cookies file a dummy; both are restored afterwards. No real downloads.

const OWNED = path.join(E2E, "owned");
const DL = {
  collection: { id: "a2225096452", artist: "Reptant", title: "Halls Of Perception" },
  import: { id: "a3484490386", artist: "Bjarki", title: "Look at yourself" },
  refused: { id: "a2773973352", artist: "Earthman", title: "[TerraFirm 3] Earthman - Orogenesis" },
};

// Ownership detail (the server's owned.track_owned / full_release): Download File only
// for owned items; Download Full Release when a track's album or EP is owned.
const FULLDL = {
  notOwned: { id: "t1005306136", q: "Clicked" }, // Carré
  trackOnly: { id: "t1002746421", q: "Futuro Lontano" }, // TSVI, bought on its own
  viaAlbum: { id: "t1013878587", q: "Green Ranger", album: { id: "a2132989582", artist: "PIGMNT", title: "Green Ranger EP", tracks: ["Green Ranger", "Two"] } },
  boxed: { id: "t1042405552", q: "Lords Of Gwaranjar", album: { id: "a3440228500", artist: "Smogo", title: "Sharp Knowledge EP", tracks: ["Lords Of Gwaranjar", "Two"] } },
};

async function downloadSetup({ releases = [], owned = [] } = {}) {
  fs.rmSync(OWNED, { recursive: true, force: true });
  fs.mkdirSync(OWNED, { recursive: true });
  const cookies = path.join(E2E, "cookies-dummy.txt");
  fs.writeFileSync(cookies, "# e2e: a dummy cookies file (the stub never uses it)\n");
  const release = (r, extra = {}) => ({ artist: r.artist, title: r.title, year: 2024, tracks: ["One", "Two"], ...extra });
  fs.writeFileSync(
    STUB_RELEASES,
    JSON.stringify({
      [DL.collection.id]: release(DL.collection),
      [DL.import.id]: release(DL.import),
      [DL.refused.id]: release(DL.refused, { fail: "not_in_collection" }),
      ...Object.fromEntries(releases.map((r) => [r.id, release(r, { tracks: r.tracks })])),
    })
  );
  const before = await api("/api/settings").then((d) => d.settings || d);
  const saved = await put({ owned_root: OWNED, cookies_file: cookies, downloads_dir: "", download_format: "aiff-lossless" });
  assert.ok(!saved.detail, `settings: ${JSON.stringify(saved.detail)}`);
  await post("/api/ownership", { owned_ids: [...Object.values(DL).map((r) => r.id), ...owned], source: "e2e", full: false });
  return async () => {
    await put({ owned_root: before.owned_root, cookies_file: before.cookies_file, downloads_dir: before.downloads_dir || "" });
    fs.rmSync(OWNED, { recursive: true, force: true });
  };
}

test("Download (collection): an owned album not on the drive is downloaded (stub) and located, with no confirmation; the status names the release", async () => {
  const restore = await downloadSetup();
  const { id } = DL.collection;
  const app = await context.newPage();
  const dialogs = [];
  app.on("dialog", (d) => {
    dialogs.push(d.message());
    d.dismiss();
  });
  try {
    await app.goto(SERVER + "/");
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 0);
    await app.fill("#searchInput", "Halls Of Perception");
    await app.waitForFunction((id) => document.querySelectorAll("#collectionTable tbody tr").length === 1 && document.querySelector(`tr[data-key="${id}"]`), id);
    await app.waitForFunction((id) => /owned/.test(document.querySelector(`tr[data-key="${id}"] .col-owned`).textContent), id);
    await app.click(`tr[data-key="${id}"] .col-located .chip`);
    assert.equal(await app.textContent(".popover #downloadItem"), "Download File");
    assert.equal(await app.$(".popover #downloadFullRelease"), null, "an album is its own full release");
    let started = "";
    await app.click(".popover #downloadItem");
    await app.waitForFunction(() => /^Download(ing|:)/.test(document.getElementById("refreshStatus").textContent));
    started = await app.textContent("#refreshStatus");
    await app.waitForFunction(() => /^Download: 1 of 1 releases downloaded/.test(document.getElementById("refreshStatus").textContent), null, { timeout: 60000 });
    assert.deepEqual(dialogs, [], "no confirmation");
    if (/^Downloading 1 release/.test(started)) assert.match(started, /→ .*\(aiff-lossless\): Reptant – Halls Of Perception\./);
    assert.ok((await app.textContent("#refreshStatus")).includes(`→ ${OWNED}.`), "where it went");
    await waitFor(() => api(`/api/items/${id}`).then((it) => it.local && it.local.status === "located"), { what: "the item located on the server", timeout: 30000 });
    const item = await api(`/api/items/${id}`);
    assert.ok(item.local.best.path.startsWith(OWNED), item.local.best.path);
    try {
      await app.waitForFunction((id) => /^✓/.test((document.querySelector(`tr[data-key="${id}"] .col-located .chip`) || {}).textContent || ""), id, { timeout: 15000 });
    } catch (e) {
      const cell = await app.$eval(`tr[data-key="${id}"] .col-located`, (c) => c.outerHTML).catch((x) => String(x));
      throw new Error(`the row didn't show it located: ${cell}`);
    }
  } finally {
    await restore();
    await app.close();
  }
});

test("Download owned missing (import): the selected rows are downloaded and located; a refused one shows why in its row", async () => {
  const restore = await downloadSetup();
  const items = [
    { line: 1, raw: "Bjarki - Look at yourself", artist: "Bjarki", title: "Look at yourself", existing_id: DL.import.id, tags: ["must"] },
    { line: 2, raw: "Earthman - Orogenesis", artist: "Earthman", title: "Orogenesis", existing_id: DL.refused.id, tags: ["must"] },
    { line: 3, raw: "Carré - Clicked", artist: "Carré", title: "Clicked", existing_id: FULLDL.notOwned.id, tags: ["must"] },
  ];
  const { batch_id: batchId } = await post("/api/import", { file: { format: "bc-tagger-import/1", source: "e2e-download.txt", items }, default_tags: [], name: "e2e-download" });
  const page = await context.newPage();
  const dialogs = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    d.dismiss();
  });
  const bodies = [];
  page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/download") && bodies.push(r.postDataJSON()));
  try {
    await waitFor(() => api(`/api/import/${batchId}`).then((b) => b.status === "ready"), { what: "the batch", timeout: 30000 });
    await page.goto(`${SERVER}/import/?batch=${batchId}`);
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length === 3);
    // The row that isn't owned has no Download (it couldn't work).
    await page.click("tr[data-key='r2'] .located-cell .chip");
    await page.waitForSelector(".popover");
    assert.equal(await page.$(".popover #downloadRow"), null);
    await page.keyboard.press("Escape");
    await page.click("#downloadOwnedMissing");
    await page.waitForFunction(() => /^Download: 1 of 2 releases downloaded, 1 failed/.test(document.getElementById("refreshStatus").textContent), null, { timeout: 60000 });
    assert.deepEqual(dialogs, [], "no confirmation");
    assert.deepEqual(bodies[0].ids, [`${batchId}:0`, `${batchId}:1`], "only the owned rows");
    assert.equal(bodies[0].dry_run, true);
    assert.equal(bodies[0].full_release, undefined);
    await page.waitForFunction(() => document.querySelector("tr[data-key='r0'] .located-cell .chip").dataset.status === "located", null, { timeout: 30000 });
    await page.waitForFunction(() => /download failed: not in your Bandcamp collection/.test(document.querySelector("tr[data-key='r1'] .located-cell").textContent));
    assert.equal((await api(`/api/import/${batchId}`)).rows[0].located.status, "located");
  } finally {
    await api(`/api/import/${batchId}`, { method: "DELETE" });
    await restore();
    await page.close();
  }
});

test("Download File only for owned items; Download Full Release for a track whose album is owned; the Download Full Releases box (collection, import)", async () => {
  const restore = await downloadSetup({
    releases: [FULLDL.viaAlbum.album, FULLDL.boxed.album],
    owned: [FULLDL.trackOnly.id, FULLDL.viaAlbum.album.id, FULLDL.boxed.album.id],
  });
  const app = await context.newPage();
  const bodies = [];
  app.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/download") && bodies.push(r.postDataJSON()));
  const dialogs = [];
  app.on("dialog", (d) => {
    dialogs.push(d.message());
    d.dismiss();
  });
  const status = () => app.textContent("#refreshStatus");
  const show = async ({ id, q }) => {
    await app.fill("#searchInput", q);
    await app.waitForFunction((id) => document.querySelector(`tr[data-key="${id}"]`), id);
  };
  const popoverButtons = async ({ id }) => {
    await app.click(`tr[data-key="${id}"] .col-located .chip`);
    await app.waitForSelector(".popover");
    const b = await app.$$eval(".popover .pop-actions button", (bs) => bs.map((x) => x.textContent));
    return b;
  };
  let batchId = null;
  try {
    await app.goto(SERVER + "/");
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 0);
    await app.evaluate(() => localStorage.removeItem("bc_download_full_releases"));
    await app.reload();
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 0);
    // The box sits next to Download owned missing, off by default.
    assert.equal(await app.$eval("#downloadOwnedMissing", (b) => b.nextElementSibling.querySelector("#downloadFullReleases") !== null), true);
    assert.equal(await app.isChecked("#downloadFullReleases"), false);

    await show(FULLDL.notOwned);
    let b = await popoverButtons(FULLDL.notOwned);
    assert.ok(!b.includes("Download File") && !b.includes("Download Full Release"), `not owned: ${b}`);
    await app.keyboard.press("Escape");

    await show(FULLDL.trackOnly);
    b = await popoverButtons(FULLDL.trackOnly);
    assert.ok(b.includes("Download File") && !b.includes("Download Full Release"), `bought on its own: ${b}`);
    assert.match(await app.getAttribute(".popover #downloadItem", "title"), /bought on its own/);
    await app.keyboard.press("Escape");

    await show(FULLDL.viaAlbum);
    b = await popoverButtons(FULLDL.viaAlbum);
    assert.ok(b.includes("Download File") && b.includes("Download Full Release"), `album owned: ${b}`);
    // The row says how far the download is ("downloading 50 %"), from the server's events.
    await app.evaluate((id) => {
      window.__dlSeen = [];
      new MutationObserver(() => {
        const t = (document.querySelector(`tr[data-key="${id}"] .col-located`) || {}).textContent || "";
        if (t && !window.__dlSeen.includes(t)) window.__dlSeen.push(t);
      }).observe(document.getElementById("collectionTable"), { childList: true, subtree: true, characterData: true });
    }, FULLDL.viaAlbum.id);
    await app.click(".popover #downloadFullRelease");
    await app.waitForFunction(() => /^Download: 1 of 1 releases downloaded/.test(document.getElementById("refreshStatus").textContent), null, { timeout: 60000 });
    const seen = await app.evaluate(() => window.__dlSeen);
    assert.ok(seen.some((t) => /downloading \d+ %/.test(t)), `progress in the row: ${JSON.stringify(seen)}`);
    assert.deepEqual(bodies.map((x) => [x.ids, x.full_release, !!x.dry_run]), [
      [[FULLDL.viaAlbum.id], true, true],
      [[FULLDL.viaAlbum.id], true, false],
    ]);
    assert.ok(fs.readdirSync(path.join(OWNED, "PIGMNT")).some((d) => d.includes("Green Ranger EP")), "the whole EP was downloaded");

    // The box: the selected owned items' full releases; one bought on its own has none.
    bodies.length = 0;
    await show(FULLDL.trackOnly);
    await app.check(`tr[data-key="${FULLDL.trackOnly.id}"] .row-check`);
    await show(FULLDL.boxed);
    await app.check(`tr[data-key="${FULLDL.boxed.id}"] .row-check`);
    await app.check("#downloadFullReleases");
    await app.click("#downloadOwnedMissing");
    await app.waitForFunction(() => /^Download: 1 of 1 releases downloaded/.test(document.getElementById("refreshStatus").textContent), null, { timeout: 60000 });
    assert.deepEqual(bodies[0].ids.slice().sort(), [FULLDL.trackOnly.id, FULLDL.boxed.id].sort());
    assert.equal(bodies[0].full_release, true);
    assert.match(await status(), /Not downloadable: 1 the full release isn't owned \(only this track\)\./);
    assert.ok(fs.readdirSync(path.join(OWNED, "Smogo")).some((d) => d.includes("Sharp Knowledge EP")));
    assert.deepEqual(dialogs, [], "no confirmation");
    await app.reload();
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 0);
    assert.equal(await app.isChecked("#downloadFullReleases"), true, "remembered");

    // The import preview: the same buttons from the row's ownership.
    const items = [
      { line: 1, raw: "Carré - Clicked", artist: "Carré", title: "Clicked", existing_id: FULLDL.notOwned.id, tags: ["must"] },
      { line: 2, raw: "TSVI - Futuro Lontano", artist: "TSVI", title: "Futuro Lontano", existing_id: FULLDL.trackOnly.id, tags: ["must"] },
    ];
    ({ batch_id: batchId } = await post("/api/import", { file: { format: "bc-tagger-import/1", source: "e2e-full.txt", items }, default_tags: [], name: "e2e-full" }));
    await waitFor(() => api(`/api/import/${batchId}`).then((x) => x.status === "ready"), { what: "the batch", timeout: 30000 });
    await app.goto(`${SERVER}/import/?batch=${batchId}`);
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length === 2);
    assert.equal(await app.isChecked("#downloadFullReleases"), true, "the same box on the preview");
    const rowButtons = async (n) => {
      await app.click(`tr[data-key='r${n}'] .located-cell .chip`);
      await app.waitForSelector(".popover");
      const x = await app.$$eval(".popover .pop-actions button", (bs) => bs.map((y) => y.textContent));
      await app.keyboard.press("Escape");
      return x;
    };
    assert.ok(!(await rowButtons(0)).includes("Download File"), "not owned");
    const own = await rowButtons(1);
    assert.ok(own.includes("Download File") && !own.includes("Download Full Release"), `bought on its own: ${own}`);
  } finally {
    await app.evaluate(() => localStorage.removeItem("bc_download_full_releases")).catch(() => {});
    if (batchId) await api(`/api/import/${batchId}`, { method: "DELETE" });
    await restore();
    await app.close();
  }
});

test("import preview: the Notes icons open a popover with the flags in plain words, the note and the line (stubbed API)", async () => {
  const stub = importStub(JSON.parse(fs.readFileSync(IMPORT_SAMPLE, "utf8")));
  const page = await context.newPage();
  await stub.install(page);
  try {
    await page.goto(SERVER + "/import/?batch=e2e-b1");
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length === 7);
    const popText = () => page.textContent(".popover");
    // The row to confirm: its ⚑ and its "confirm" chip open the same notes.
    assert.match(await page.getAttribute("tr[data-key='r2'] .flag-icon", "title"), /Flags: needs_user_confirmation/, "the tooltip stays");
    await page.click("tr[data-key='r2'] .flag-icon");
    let t = await popText();
    assert.match(t, /Notes · please confirm/);
    assert.match(t, /Your reading and the files disagree: please confirm\./);
    assert.match(t, /Note: The file says Nobody Known, the drive says Nobody Knows\./);
    assert.match(t, /Line 3: slow one by Nobody Known \(chill\)/);
    await page.keyboard.press("Escape");
    await page.click("tr[data-key='r2'] .confirm-chip");
    assert.match(await popText(), /Your reading and the files disagree/);
    await page.keyboard.press("Escape");
    // A vinyl-position row.
    await page.click("tr[data-key='r3'] .flag-icon");
    t = await popText();
    assert.match(t, /Only a side or position is known \(e\.g\. B1\)\./);
    assert.match(t, /Untitled or generic track: matched on album \+ track number\./);
    await page.keyboard.press("Escape");
    // A duplicate.
    await page.click("tr[data-key='r0'] .dup-icon");
    assert.match(await popText(), /⧉ Already in your collection as Buma II — Joaquín Cornejo \(tags: must, drums, build\): its tags are merged on import\./);
  } finally {
    await page.close();
  }
});

// --- An open import survives navigation and reloads ---------------------------------

test("import: a reload during lookups follows the same job on to the mapping step (stubbed API)", async () => {
  const stub = importStub(JSON.parse(fs.readFileSync(IMPORT_SAMPLE, "utf8")), { slowJob: 6 });
  const page = await context.newPage();
  await stub.install(page);
  await page.goto(SERVER + "/settings/#import");
  // The open batch is still looking up: the tab follows it (nothing is started).
  await page.waitForFunction(() => /Looking up rows on Bandcamp/.test(document.getElementById("importProgress").textContent));
  assert.match(page.url(), /#import\/e2e-b1$/);
  assert.match(await page.textContent("#navImport"), /^Import: /);
  await page.reload();
  await page.waitForFunction(() => /Looking up rows on Bandcamp/.test(document.getElementById("importProgress").textContent));
  await page.waitForSelector("#importMapping:not([hidden])", { timeout: 30000 });
  assert.equal(await page.$eval("#importMapping", (m) => m.dataset.batch), "e2e-b1");
  assert.equal(stub.calls.filter((c) => c.method === "POST" && c.path === "/api/import").length, 0, "nothing restarted");
  assert.ok(!stub.calls.some((c) => c.method === "DELETE"), "nothing cancelled");
  await page.close();
});

test("import: a batch interrupted by a server restart resumes its lookups from the Import tab (stubbed API)", async () => {
  const stub = importStub(JSON.parse(fs.readFileSync(IMPORT_SAMPLE, "utf8")), { interrupted: true });
  const page = await context.newPage();
  await stub.install(page);
  await page.goto(SERVER + "/");
  await page.waitForSelector("#navImport:not([hidden])");
  assert.match(await page.textContent("#navImport"), /^Import interrupted/);
  await page.click("#navImport");
  await page.waitForSelector("#importOpen:not([hidden])");
  assert.match(await page.textContent("#importProgress"), /server restarted during the lookups/);
  await page.click("#importResume");
  await page.waitForSelector("#importMapping:not([hidden])", { timeout: 30000 });
  assert.equal(stub.calls.filter((c) => c.path.endsWith("/resume")).length, 1);
  assert.equal(stub.calls.filter((c) => c.method === "POST" && c.path === "/api/import").length, 0, "nothing restarted from scratch");
  await page.close();
});

test("import: leaving for Collection and Settings returns to the same batch and step, and preview edits stay (real server)", async () => {
  const items = JSON.parse(fs.readFileSync(path.join(ROOT, "server/tests/fixtures/import_rows.json"), "utf8")).slice(0, 6);
  items[0].tags = [...(items[0].tags || []), "mourn"];
  const file = path.join(E2E, "import-nav.json");
  fs.writeFileSync(file, JSON.stringify({ format: "bc-tagger-import/1", source: "e2e-nav.txt", revision: 3, unknown_tags: { mourn: ["melancholic"] }, pending_releases: [], items }));
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  let batchId = null;
  try {
    await page.goto(SERVER + "/settings/#import");
    await page.setInputFiles("#importFile", file);
    await page.waitForFunction(() => /6 rows from/.test(document.getElementById("importFileInfo").textContent));
    await page.click("#importStart");
    await page.waitForSelector("#importMapping:not([hidden])", { timeout: 60000 });
    batchId = decodeURIComponent(page.url().split("#import/")[1]);
    assert.match(batchId, /^imp-/);

    // Away to the Collection: the header says where the import is and links back.
    await page.click("#navLink_collection");
    await page.waitForSelector("#navImport:not([hidden])");
    assert.match(await page.textContent("#navImport"), /^Import: 1 tag to map/);
    assert.equal(await page.getAttribute("#navImport", "href"), `/settings/#import/${batchId}`);
    await page.click("#navLink_import");
    await page.waitForSelector("#importMapping:not([hidden])");
    assert.equal(await page.$eval("#importMapping", (m) => m.dataset.batch), batchId);
    assert.deepEqual(await page.$$eval("#importMapping .map-row", (r) => r.map((x) => x.dataset.tag)), ["mourn"]);
    await page.click("#mapCreate");
    await page.waitForURL(new RegExp(`/import/\\?batch=${batchId}$`));

    // Preview edits are saved as they're made: uncheck a row, change a row's tags.
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length === 6);
    await page.click("tr[data-key='r1'] .row-check");
    await page.waitForFunction(() => /\(5\)/.test(document.getElementById("importSelected").textContent));
    await page.locator("tr[data-key='r2']").scrollIntoViewIfNeeded();
    await page.waitForSelector("tr[data-key='r2'] select.tag-editor", { state: "attached" });
    await page.evaluate(() => $("tr[data-key='r2'] select.tag-editor").val(["must", "pool"]).trigger("change"));
    await waitFor(() => api(`/api/import/${batchId}`).then((b) => !b.rows[1].checked && JSON.stringify(b.rows[2].tags) === JSON.stringify(["must", "pool"])), {
      what: "the edits on the server",
    });

    // Away to Settings and back through the header: the same preview, edits there.
    await page.click("#navLink_settings");
    await page.waitForSelector("#navImport:not([hidden])");
    assert.match(await page.textContent("#navImport"), /^Import ready to review \(6 rows\)/);
    await page.click("#navLink_import");
    await page.waitForURL(new RegExp(`/import/\\?batch=${batchId}$`));
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length === 6);
    assert.equal(await page.isChecked("tr[data-key='r1'] .row-check"), false);
    assert.match(await page.textContent("#importSelected"), /\(5\)/);
    assert.deepEqual(await page.$eval("tr[data-key='r2']", (tr) => [...tr.querySelectorAll("select.tag-editor option:checked")].map((o) => o.value)), ["must", "pool"]);

    // The Import tab offers it too.
    await page.goto(SERVER + "/settings/#import");
    await page.waitForSelector("#importOpen:not([hidden])");
    assert.match(await page.textContent("#importOpen"), /import-nav\.json · ready to review/);
    assert.equal(await page.getAttribute("#importContinue", "href"), `/import/?batch=${batchId}`);
  } finally {
    if (batchId) await api(`/api/import/${batchId}`, { method: "DELETE" });
    await page.close();
  }
});

// --- Bandcamp's bot check ("Client Challenge") ---------------------------------------
// Whatever gets it stops fetching from Bandcamp and says so; nothing retries it.

const CHALLENGE_HTML = fs.readFileSync(path.join(FIXTURES, "challenge.html"));

test("bot check: the first challenged page stops all page fetching and is shown", async () => {
  const ids = ["t999000601", "t999000602"];
  await probe.evaluate(async (ids) => {
    const { taggedItems } = await chrome.storage.local.get("taggedItems");
    Object.values(taggedItems).forEach((it) => {
      if (it.tralbum_type === "t") it.album_checked = true;
    });
    ids.forEach((id, i) => {
      taggedItems[id] = {
        id,
        title: `Challenged ${i + 1}`,
        tralbum_type: "t",
        raw_id: Number(id.slice(1)),
        tags: ["must"],
        url: `https://e2e-challenge.bandcamp.com/track/challenged-${i + 1}`,
      };
    });
    await chrome.storage.local.set({ taggedItems });
  }, ids);
  const page = await context.newPage();
  const seen = [];
  await page.route(/e2e-challenge\.bandcamp\.com|\/EmbeddedPlayer\/track=99900060/, (route) => {
    seen.push(route.request().url());
    return route.fulfill({ status: 403, contentType: "text/html", body: CHALLENGE_HTML });
  });
  await page.goto(extPage("collection.html"));
  await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 0);
  await page.click("#fixAlbumIds");
  await page.waitForFunction(() => /^Album IDs: stopped by Bandcamp's bot check/.test(document.getElementById("refreshStatus").textContent));
  assert.match(await page.textContent("#bcChallenge"), /Client Challenge/);
  assert.match(await page.getAttribute("#bcChallenge a", "href"), /^https:\/\/e2e-challenge\.bandcamp\.com\/track\/challenged-/);
  // The two track pages may already be in flight together; nothing after the
  // challenge (no embedded-player fallback, no retry).
  assert.ok(seen.length >= 1 && seen.length <= 2, `fetched: ${seen.join(", ")}`);
  assert.ok(seen.every((u) => /e2e-challenge/.test(u)), `fetched after the challenge: ${seen.join(", ")}`);
  const items = (await storage("taggedItems")).taggedItems;
  ids.forEach((id) => assert.equal(items[id].album_checked, undefined, "a challenged item isn't marked checked"));
  await page.click("#refreshThumbs").catch(() => {});
  await page.waitForTimeout(500);
  assert.ok(seen.every((u) => /e2e-challenge/.test(u)) && seen.length <= 2, "no fetches after the challenge");
  await probe.evaluate((ids) => Promise.all(ids.map((id) => chrome.runtime.sendMessage({ type: "removeTaggedItem", id }))), ids);
  await page.close();
});

test("bot check: ownership reports it and stops refreshing in the background", async () => {
  const SUMMARY = "https://bandcamp.com/api/fan/2/collection_summary";
  const challenge = (route) => route.fulfill({ status: 200, contentType: "text/html", body: CHALLENGE_HTML });
  await context.route(SUMMARY, challenge);
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
  await app.click("#refreshOwnership");
  await app.waitForFunction(() => /failed|error/i.test(document.getElementById("refreshStatus").textContent), null, { timeout: 30000 });
  assert.match(await app.textContent("#refreshStatus"), /bot check/);
  const status = await probe.evaluate(() => chrome.storage.session.get("bcSyncStatus").then((s) => s.bcSyncStatus));
  assert.equal(status.ownership.challenge, true);
  // The user's own refresh clears it once Bandcamp answers again.
  await context.unroute(SUMMARY, challenge);
  await app.click("#refreshOwnership");
  await app.waitForFunction(() => /owned: \d+/.test(document.getElementById("refreshStatus").textContent), null, { timeout: 30000 });
  const after = await probe.evaluate(() => chrome.storage.session.get("bcSyncStatus").then((s) => s.bcSyncStatus));
  assert.ok(!after.ownership.challenge);
  await app.close();
});

// --- "Look up in my browser" (Phase 5): the extension answers the server's requests -----
// Every Bandcamp request the extension makes is answered from Session A's
// recordings, found by the same key the server's fetcher uses:
// sha1(json.dumps([method, url, body], sort_keys=True)) (Python's spacing and
// \u escapes). Nothing reaches Bandcamp.

function pyJson(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v).replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  if (Array.isArray(v)) return "[" + v.map(pyJson).join(", ") + "]";
  return "{" + Object.keys(v).sort().map((k) => `${pyJson(k)}: ${pyJson(v[k])}`).join(", ") + "}";
}
const recordedKey = (method, url, body) => crypto.createHash("sha1").update(pyJson([method, url, body ?? null])).digest("hex");
const BANDCAMP_HOSTS = /^https?:\/\/([a-z0-9-]+\.)*bandcamp\.com\//i;

function browserAnswers({ challenge = false } = {}) {
  const recorded = Object.fromEntries(
    JSON.parse(fs.readFileSync(path.join(RECORDED_RESOLVER, "bandcamp_recorded.json"), "utf8")).map((e) => [e.key, e])
  );
  const seen = [];
  const handler = (route) => {
    const req = route.request();
    // The extension's own ownership checks aren't lookups: the fixtures answer them.
    if (/\/api\/(fan|fancollection)\//.test(req.url())) return route.fallback();
    let body = null;
    try {
      body = req.postData() ? JSON.parse(req.postData()) : null;
    } catch (e) {
      /* not JSON */
    }
    const rec = recorded[recordedKey(req.method(), req.url(), body)];
    seen.push({ method: req.method(), url: req.url(), recorded: !!rec });
    if (challenge) return route.fulfill({ status: 200, contentType: "text/html", body: CHALLENGE_HTML });
    if (rec) return route.fulfill({ status: rec.status, contentType: req.method() === "POST" ? "application/json" : "text/html; charset=utf-8", body: rec.body });
    if (req.method() === "POST") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ auto: { results: [] } }) });
    return route.fulfill({ status: 404, contentType: "text/html", body: "Not found (e2e)" });
  };
  return { handler, seen };
}

async function startBrowserImport(page, file) {
  await page.goto(SERVER + "/settings/#import");
  await page.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
  await page.setInputFiles("#importFile", file);
  await page.waitForFunction(() => /rows from/.test(document.getElementById("importFileInfo").textContent));
  await page.check("#importLookupBrowser");
  await page.click("#importStart");
}

test("import, Look up in my browser: the extension makes the server's requests (recorded answers); same results as the server; then mapping and preview (real server)", async () => {
  const items = JSON.parse(fs.readFileSync(path.join(ROOT, "server/tests/fixtures/import_rows.json"), "utf8"));
  const file = path.join(E2E, "import-browser.json");
  fs.writeFileSync(file, JSON.stringify({ format: "bc-tagger-import/1", source: "e2e-browser.txt", revision: 3, unknown_tags: { mourn: ["melancholic"] }, pending_releases: [], items }));
  const answers = browserAnswers();
  await context.route(BANDCAMP_HOSTS, answers.handler);
  const page = await context.newPage();
  let batchId = null;
  try {
    await startBrowserImport(page, file);
    try {
      await page.waitForSelector("#importMapping:not([hidden])", { timeout: 90000 });
    } catch (e) {
      const id = decodeURIComponent((page.url().split("#import/")[1] || ""));
      const st = id ? await api(`/api/import/${id}/lookups`).catch((x) => String(x)) : null;
      throw new Error(`no mapping step: progress "${await page.textContent("#importProgress")}", seen ${JSON.stringify(answers.seen.slice(0, 6))} (${answers.seen.length}), lookups ${JSON.stringify(st).slice(0, 600)}`);
    }
    batchId = decodeURIComponent(page.url().split("#import/")[1]);
    assert.ok(answers.seen.some((s) => s.method === "POST" && s.recorded), "searches answered from the recordings");
    assert.ok(answers.seen.every((s) => s.recorded), `requests with no recording: ${answers.seen.filter((s) => !s.recorded).map((s) => s.url).join(", ")}`);
    await page.click("#mapCreate");
    await page.waitForURL(/\/import\/\?batch=imp-/);
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length === 12);
    const src = await page.$$eval("#collectionTable tbody tr", (trs) =>
      Object.fromEntries(trs.map((tr) => [tr.querySelector(".col-title").textContent, tr.querySelector(".match-cell .chip").dataset.source]))
    );
    assert.equal(src["Take It As A Game (Super Drama Mix)"], "file");
    assert.equal(src.Astika, "search");
    assert.equal(src.Elhwah, "collection");
  } finally {
    await context.unroute(BANDCAMP_HOSTS, answers.handler);
    if (batchId) await api(`/api/import/${batchId}`, { method: "DELETE" });
    await page.close();
  }
});

test("import, Look up in my browser: Bandcamp's bot check in the browser stops the lookups (real server)", async () => {
  // Rows nobody has looked up (answers already in the server's cache aren't asked for again).
  const items = [1, 2, 3, 4].map((n) => ({ line: n, raw: `Never Seen ${n} - Unknown Artist`, artist: "Unknown Artist", title: `Never Seen ${n}`, tags: ["must"] }));
  const file = path.join(E2E, "import-browser-challenge.json");
  fs.writeFileSync(file, JSON.stringify({ format: "bc-tagger-import/1", source: "e2e-challenge.txt", items }));
  const answers = browserAnswers({ challenge: true });
  await context.route(BANDCAMP_HOSTS, answers.handler);
  const page = await context.newPage();
  let batchId = null;
  try {
    await startBrowserImport(page, file);
    // The Import tab says it stopped, then carries on to the mapping step (unknown
    // tags) or the preview, whose banner says why: either place shows it.
    const stopShown = () => {
      const progress = document.getElementById("importProgress");
      const banner = document.querySelector(".import-unavailable:not([hidden])");
      return (
        (progress && !progress.hidden && /Stopped: .*bot check|lookup unavailable .*bot check/.test(progress.textContent)) ||
        (banner && /bot check .* to your browser/.test(banner.textContent))
      );
    };
    try {
      await page.waitForFunction(stopShown, null, { timeout: 60000 });
    } catch (e) {
      throw new Error(`no stop message: at ${page.url()}, progress "${await page.textContent("#importProgress").catch(() => "-")}", ${answers.seen.length} requests`);
    }
    batchId = decodeURIComponent(page.url().match(/#import\/([^/?#]+)|[?&]batch=([^&#]+)/).slice(1).find(Boolean));
    const asked = answers.seen.length;
    assert.ok(asked >= 1 && asked <= 4, `requests: ${asked}`);
    await page.waitForTimeout(1500);
    assert.equal(answers.seen.length, asked, "nothing more after the bot check");
    const state = await api(`/api/import/${batchId}/lookups`);
    assert.equal(state.state, "stopped");
    assert.equal(state.reason, "challenge");
    // The batch is still reviewable (rows marked unavailable), so links can be set by hand.
    await waitFor(() => api(`/api/import/${batchId}`).then((b) => b.status === "ready"), { what: "the batch ready", timeout: 30000 });
  } finally {
    await context.unroute(BANDCAMP_HOSTS, answers.handler);
    if (batchId) await api(`/api/import/${batchId}`, { method: "DELETE" });
    await page.close();
  }
});

// --- Phase 3 end to end, on the real server ------------------------------------------
// Session A's import server with its recorded resolver answers (12 rows of
// annotations.json) plus a Holo Law row the resolver can't look up here: it is
// linked from the (recorded) album page with the extension. Then Import
// selected: Bandcamp rows reach the extension through pending adds, the rest
// show under Other in the collection.

test("import end to end (real server): resolve, map tags, paste a URL, link from the album page, commit, pending adds, Other", async () => {
  const items = JSON.parse(fs.readFileSync(path.join(ROOT, "server/tests/fixtures/import_rows.json"), "utf8"));
  const ALBUM = "https://infiniteexpanse.bandcamp.com/album/synergy-trilogy";
  items.push(
    { line: 900, raw: "Synergy Trilogy - Holo Law", artist: "Synergy Trilogy", title: "Holo Law", album: "Synergy Trilogy", tags: ["vocal"] },
    { line: 901, raw: "Synergy Trilogy - E2E stand-in track", artist: "Synergy Trilogy", title: "E2E stand-in track", tags: [], bandcamp_url: ALBUM }
  );
  const file = path.join(E2E, "import-e2e.json");
  fs.writeFileSync(file, JSON.stringify({ format: "bc-tagger-import/1", source: "e2e-real.txt", revision: 3, unknown_tags: { mourn: ["melancholic"] }, pending_releases: [], items }));
  const before = Object.keys((await storage("taggedItems")).taggedItems).length;

  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(SERVER + "/settings/#import");
  await page.setInputFiles("#importFile", file);
  await page.waitForFunction(() => /14 rows from/.test(document.getElementById("importFileInfo").textContent));
  await page.click("#importStart");
  await page.waitForSelector("#importMapping:not([hidden])", { timeout: 60000 });
  assert.deepEqual(await page.$$eval("#importMapping .map-row", (r) => r.map((x) => x.dataset.tag)), ["mourn"]);
  await page.click("#mapCreate");
  await page.waitForURL(/\/import\/\?batch=imp-/);
  const batchId = new URL(page.url()).searchParams.get("batch");
  await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length === 14);
  const sources = () =>
    page.$$eval("#collectionTable tbody tr", (trs) =>
      Object.fromEntries(trs.map((tr) => [tr.querySelector(".col-title").textContent, tr.querySelector(".match-cell .chip").dataset.source]))
    );
  let src = await sources();
  assert.equal(src.Elhwah, "collection");
  assert.equal(src.Atacama, "collection");
  assert.equal(await page.$$eval("tr.row-duplicate", (r) => r.length), 2);
  assert.equal(src["Take It As A Game (Super Drama Mix)"], "file", "resolved from the file's link (recorded)");
  assert.equal(src.Astika, "search", "found by the Bandcamp search (recorded)");
  assert.equal(src["The Human Being Disgusts"], "none", "searched, not found: unmatched (not \"search\")");
  // Not recorded: no lookup goes out; the row says why.
  assert.equal(src["Holo Law"], "unavailable");
  assert.match(await page.textContent("#lookupUnavailable"), /Bandcamp lookup unavailable for \d+ rows?: the lookup failed/);

  // Paste Holo Law's page (its album) in the preview: stored, not fetched.
  const holoKey = await page.$$eval("#collectionTable tbody tr", (trs) => trs.find((tr) => tr.querySelector(".col-title").textContent === "Holo Law").dataset.key);
  await page.click(`tr[data-key='${holoKey}'] .match-cell .chip`);
  await page.fill(".popover .match-url", ALBUM + "?from=search");
  await page.click(".popover .pop-url button.primary");
  await page.waitForFunction((k) => document.querySelector(`tr[data-key='${k}'] .match-cell .chip`).dataset.source === "url", holoKey);

  // Open the album page: the extension links Holo Law (pasted URL) and the
  // stand-in track (the file's link) by itself.
  const album = await context.newPage();
  await album.goto(ALBUM);
  await album.waitForFunction(() => (document.getElementById("bct-import-notice") || {}).childElementCount >= 2, null, { timeout: 15000 });
  const notices = await album.textContent("#bct-import-notice");
  assert.match(notices, /linked this page's “Holo Law” to the import row Synergy Trilogy – Holo Law/);
  assert.match(notices, /linked this page's “E2E stand-in track”/);
  await album.close();
  await page.waitForFunction(
    () => [...document.querySelectorAll("#collectionTable tbody tr")].filter((tr) => tr.querySelector(".match-cell .chip").dataset.source === "linked").length === 2,
    null,
    { timeout: 15000 }
  );
  const batch = await api(`/api/import/${batchId}`);
  const holo = batch.rows.find((r) => r.title === "Holo Law");
  assert.equal(holo.bandcamp.via, "linked");
  assert.equal(holo.bandcamp.item.id, "t3738475288");
  assert.equal(batch.rows.find((r) => r.title === "E2E stand-in track").bandcamp.item.id, "t3738475200");

  // Import selected → the collection opens with exactly the imported and merged
  // items selected, newest Modified first; the pending adds reach the extension.
  const commits = [];
  page.on("response", async (r) => {
    if (/\/api\/import\/[^/]+\/commit$/.test(new URL(r.url()).pathname)) commits.push(await r.json().catch(() => null));
  });
  const maxOrderBefore = (await api("/api/health")).max_order;
  assert.ok(Number.isFinite(maxOrderBefore), "health.max_order");
  await page.click("#importSelected");
  await page.waitForURL(SERVER + "/", { timeout: 30000 });
  const res = await waitFor(async () => commits[0], { what: "the commit result" });
  assert.equal(res.tag_merges, 2, JSON.stringify(res));
  assert.ok(res.pending_adds >= 4, JSON.stringify(res)); // Holo Law, the stand-in, Super Drama, Astika at least
  assert.ok(res.other_added >= 1, JSON.stringify(res));
  const chosen = res.selected;
  assert.ok(Array.isArray(chosen) && chosen.length === res.pending_adds + res.tag_merges + res.other_added + res.other_merged, JSON.stringify(res));
  await waitFor(async () => !!(await storage("taggedItems")).taggedItems.t3738475288, { what: "Holo Law in the extension", timeout: 30000 });
  const after = (await storage("taggedItems")).taggedItems;
  assert.equal(Object.keys(after).length, before + res.pending_adds);
  assert.ok(after.t3738475288.tags.includes("vocal"));
  assert.ok(after.t3738475288.modified_at, "new items carry modified_at");
  assert.ok(after.t3738475288.order > maxOrderBefore, `"#" after everything before the import: ${after.t3738475288.order}`);
  const elhwah = batch.rows.find((r) => r.title === "Elhwah").tags;
  await waitFor(
    async () => {
      const tags = (await storage("taggedItems")).taggedItems.t3244411361.tags || [];
      return elhwah.every((t) => tags.includes(t));
    },
    { what: "the duplicate's tags merged in the extension" }
  );
  assert.equal((await api("/api/tagger/pending-adds")).length, 0, "all pending adds acknowledged");

  // Exactly those selected (new Bandcamp items join as the extension adds them), newest Modified first.
  await page.waitForFunction((n) => document.querySelectorAll("#collectionTable .row-check:checked").length === n, chosen.length, { timeout: 30000 });
  const checked = await page.$$eval("#collectionTable .row-check:checked", (b) => b.map((x) => x.closest("tr").dataset.key));
  assert.deepEqual(checked.slice().sort(), chosen.slice().sort());
  assert.match(await page.textContent("th.col-modified"), /▼/);
  const top = await page.$$eval("#collectionTable tbody tr", (trs, n) => trs.slice(0, n).map((tr) => tr.dataset.key), chosen.length);
  assert.deepEqual(top.slice().sort(), chosen.slice().sort(), "the imported items come first");
  assert.match(await page.textContent("#refreshStatus"), new RegExp(`The ${chosen.length} imported and merged items are selected`));
  assert.equal(await page.textContent("#exportShown"), `Export Selected to RB (${chosen.length})…`);

  // Export Selected to RB: the dry run is exactly the selection (cancelled here; the sandbox run writes).
  const exportPosts = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/rekordbox/export") exportPosts.push(JSON.parse(r.postData() || "{}"));
  });
  await page.click("#exportShown");
  await waitFor(async () => exportPosts.length > 0, { what: "the export dry run", timeout: 60000 });
  assert.equal(exportPosts[0].dry_run, true);
  assert.deepEqual(exportPosts[0].ids.slice().sort(), chosen.slice().sort());
  await page.waitForFunction(() => document.querySelector(".confirm-dialog .dialog-cancel") || !document.getElementById("exportShown").disabled, null, { timeout: 60000 });
  if (await page.$(".confirm-dialog .dialog-cancel")) await page.click(".confirm-dialog .dialog-cancel");
  assert.equal(exportPosts.length, 1, "only the dry run");

  // The import log: saved in the test server's own data folder (never the user's), shown with
  // View and Show in Finder (answered by the harness: no Finder from a test).
  assert.match(res.log || "", /^\d{4}-\d{2}-\d{2}_\d{6}_.+\.json$/, JSON.stringify(res));
  assert.equal(path.resolve(res.log_dir), path.resolve(SERVER_DATA, "import-logs"));
  assert.ok(fs.existsSync(path.join(SERVER_DATA, "import-logs", res.log)) && fs.existsSync(path.join(SERVER_DATA, "import-logs", res.log_md)));
  assert.ok((await page.textContent("#importLogNote")).includes(`Import log saved: ${res.log}`));
  await page.click("#importLogNote .log-view");
  await page.waitForSelector("#importLogDialog .md-table");
  assert.match(await page.textContent("#importLogDialog h4"), /^Import: /);
  assert.ok((await page.textContent("#importLogDialog .dialog-body")).includes("Holo Law"), "the rows are in it");
  const revealsBefore = reveals.length;
  await page.click("#importLogDialog .dialog-confirm"); // Show in Finder
  await waitFor(async () => reveals.length > revealsBefore, { what: "Show in Finder from the viewer" });
  assert.deepEqual(reveals[reveals.length - 1], { name: res.log });
  await page.click("#importLogNote .log-reveal");
  await waitFor(async () => reveals.length > revealsBefore + 1, { what: "Show in Finder from the note" });

  // Past imports on the Import tab: newest first, its counts, View, and the folder.
  const tab = await context.newPage();
  await tab.goto(SERVER + "/settings/#import");
  await tab.waitForSelector(`#importLogs .log-row[data-log="${res.log}"]`);
  assert.equal(await tab.$eval("#importLogs .log-row", (r) => r.dataset.log), res.log, "newest first");
  assert.match(await tab.textContent(`#importLogs .log-row[data-log="${res.log}"] .log-counts`), /^\d+ added · 2 merged · \d+ to Other · .*\d+ located/);
  assert.ok((await tab.textContent(".import-logs-dir")).includes(path.join(SERVER_DATA, "import-logs")));
  await tab.click(`#importLogs .log-row[data-log="${res.log}"] .log-view`);
  await tab.waitForSelector("#importLogDialog .md-table");
  await tab.click("#importLogDialog .dialog-cancel");
  await tab.click("#importLogsFolder");
  await waitFor(async () => reveals.length > revealsBefore + 2, { what: "Open folder" });
  assert.deepEqual(reveals[reveals.length - 1], {});
  await tab.close();

  // The collection: Other only.
  await page.click("#clearSelection");
  if (await page.isChecked("#source_bandcamp")) await page.click("#source_bandcamp");
  const others = await page.$$eval("#collectionTable tbody tr", (trs) => trs.map((tr) => tr.dataset.key));
  assert.equal(others.length, res.other_added);
  assert.ok(others.every((k) => /^o[0-9a-f]+$/.test(k)), others.join(","));
  // "#": the Other rows, numbered after everything before the import, in the file's row order.
  const otherItems = await api(`/api/items?ids=${others.join(",")}`).then((d) => (Array.isArray(d) ? d : d.items));
  const byKey = Object.fromEntries(otherItems.map((it) => [it.id, it]));
  assert.ok(others.every((k) => byKey[k].order > maxOrderBefore), JSON.stringify(otherItems.map((it) => it.order)));
  const lines = others.map((k) => byKey[k].line); // shown by "#": the file's lines, in order (a line can expand to several)
  assert.ok(lines.every((l, i) => Number.isFinite(l) && (i === 0 || l >= lines[i - 1])), `lines by "#": ${lines}`);
  await page.click("#source_bandcamp");
  await page.close();
});

// --- Phase 7: Import from Files ---------------------------------------------------------
// A fixture tree with real file dates (an older mtime moves the creation date back too):
// the test server's owned and not-owned folders point at it for the test.

function writeFixtureFiles(files) {
  execFileSync(PYTHON, [
    "-c",
    `
import json, os, struct, sys, time
sys.path[:0] = sys.argv[1:3]
from pathlib import Path
import mutagen.flac
from conftest import write_aiff

def write_flac(path, title, artist, album, track):
    path.parent.mkdir(parents=True, exist_ok=True)
    packed = (8000 << 44) | (0 << 41) | (15 << 36)
    info = struct.pack(">HH", 4096, 4096) + b"\\0" * 6 + packed.to_bytes(8, "big") + b"\\0" * 16
    path.write_bytes(b"fLaC" + bytes([0x80]) + len(info).to_bytes(3, "big") + info)
    f = mutagen.flac.FLAC(path)
    f.add_tags()
    for key, value in (("title", title), ("artist", artist), ("album", album), ("tracknumber", track)):
        if value is not None:
            f[key] = str(value)
    f.save()

for f in json.loads(sys.argv[3]):
    p = Path(f["path"])
    (write_flac if p.suffix == ".flac" else write_aiff)(p, f.get("title"), f.get("artist"), f.get("album"), f.get("track"))
    t = time.time() - f["days"] * 86400
    os.utime(p, (t, t))
`,
    path.join(ROOT, "server/tests"),
    path.join(ROOT, "server"),
    JSON.stringify(files),
  ]);
}

test("Import from Files: folders prefilled with their dates, rows by folder under headers, a FLAC + AIFF pair is one row, duplicates unticked, the file shown; commit numbers the rows after everything", async () => {
  const base = path.join(E2E, "files-import");
  const coll = path.join(base, "Collection");
  const complete = path.join(base, "complete");
  fs.rmSync(base, { recursive: true, force: true });
  const release = path.join(coll, "E2E Artist B - New EP (2026)");
  // ITEM ("The System Works") was located by the Locate tests: a copy of it here must leave it as it is.
  const located = exportData.taggedItems[ITEM];
  writeFixtureFiles([
    { path: path.join(complete, `${located.artist} - Copy`, `01 ${located.title}.aiff`), title: located.title, artist: located.artist, album: "Copy", track: 1, days: 1.5 },
    { path: path.join(release, "01 First.flac"), title: "First", artist: "E2E Artist B", album: "New EP", track: 1, days: 3 },
    { path: path.join(release, "01 First.aiff"), title: "First", artist: "E2E Artist B", album: "New EP", track: 1, days: 3 },
    { path: path.join(release, "02 Second.aiff"), title: "Second", artist: "E2E Artist B", album: "New EP", track: 2, days: 3 },
    { path: path.join(coll, "E2E Artist A - Old EP", "01 Old One.aiff"), title: "Old One", artist: "E2E Artist A", album: "Old EP", track: 1, days: 30 },
    { path: path.join(coll, "TSVI - Stella Remota", "01 Futuro Lontano.aiff"), title: "Futuro Lontano", artist: "TSVI", album: "Stella Remota", track: 1, days: 2 },
    { path: path.join(complete, "Unknown - Thing", "01 Thing.flac"), days: 1 },
  ]);
  const before = await api("/api/settings").then((d) => d.settings || d);
  await put({ owned_root: coll, not_owned_roots: [{ path: complete, globs: [] }], downloads_dir: "" });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  let batchId = null;
  try {
    const weekAgo = new Date(Date.now() - 7 * 86400e3);
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await page.goto(SERVER + "/settings/#import");
    await page.waitForFunction(() => document.querySelectorAll("#importFolders .folder-row").length === 2);
    const rows = () => page.$$eval("#importFolders .folder-row", (rs) => rs.map((r) => [r.querySelector(".folder-path").value, r.querySelector(".folder-since").value]));
    assert.deepEqual(await rows(), [[coll, ymd(weekAgo)], [complete, ymd(weekAgo)]], "the Collection, then the downloads, from 7 days ago");
    assert.deepEqual(await page.$$eval("#importFilesDefaultTags option:checked", (o) => o.map((x) => x.value)), ["pool"]);
    assert.equal(await page.isChecked("#importFilesLookupServer"), true);
    // + and ×, and Browse… (a folder of the music folders).
    await page.click("#importFolderAdd");
    assert.equal((await rows()).length, 3);
    await page.click('#importFolders .folder-row[data-i="2"] .folder-browse');
    await page.waitForSelector(".folder-picker .fp-dir");
    await page.click(`.folder-picker .fp-dir[data-path="${complete}"]`);
    await page.waitForFunction((p) => document.querySelector(".folder-picker .fp-use").title === p, complete);
    await page.click(".folder-picker .fp-use");
    assert.equal((await rows())[2][0], complete);
    await page.click('#importFolders .folder-row[data-i="2"] .folder-del');
    assert.equal((await rows()).length, 2);
    // A drive that isn't there: refused before anything is written.
    await page.click("#importFolderAdd");
    await page.fill('#importFolders .folder-row[data-i="2"] .folder-path', "/Volumes/E2E No Such Drive/Music");
    await page.click("#importFilesStart");
    await page.waitForFunction(() => /Import failed: .*not mounted/.test(document.getElementById("importProgress").textContent));
    await page.click('#importFolders .folder-row[data-i="2"] .folder-del');
    const shot = (name, el) => process.env.E2E_SHOTS && (el ? page.locator(el) : page).screenshot({ path: path.join(process.env.E2E_SHOTS, name) });
    await shot("files-section.png", "#sec_import_files");

    const maxOrderBefore = (await api("/api/health")).max_order;
    assert.notEqual((await api("/api/items/t1002746421")).local?.status, "located", "Futuro Lontano isn't located yet");
    const itemBefore = await api(`/api/items/${ITEM}`);
    assert.equal(itemBefore.local.status, "located", "ITEM was located by the Locate tests");
    await page.click("#importFilesStart");
    await page.waitForURL(/\/import\/\?batch=imp-/, { timeout: 90000 });
    batchId = new URL(page.url()).searchParams.get("batch");
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key]").length > 0);
    // By folder, under the folder's path; oldest release first; one row for First (FLAC + AIFF); Old One is too old.
    const layout = await page.$$eval("#collectionTable tbody tr", (trs) =>
      trs.map((tr) => (tr.classList.contains("group-row") ? `# ${tr.textContent}` : tr.querySelector(".col-title").textContent.trim()))
    );
    assert.deepEqual(layout, [`# ${coll}`, "First", "Second", "Futuro Lontano", `# ${complete}`, located.title, "Thing"]);
    const keyOf = async (title) =>
      page.evaluate((t) => [...document.querySelectorAll("#collectionTable tbody tr[data-key]")].find((tr) => tr.querySelector(".col-title").textContent.trim() === t).dataset.key, title);
    const dup = await keyOf("Futuro Lontano");
    assert.ok(await page.$eval(`tr[data-key="${dup}"]`, (tr) => tr.classList.contains("row-duplicate")), "duplicate tint");
    assert.ok(await page.$(`tr[data-key="${dup}"] .dup-icon`), "duplicate icon");
    assert.equal(await page.isChecked(`tr[data-key="${dup}"] .row-check`), false, "duplicates start unticked");
    const first = await keyOf("First");
    assert.equal(await page.isChecked(`tr[data-key="${first}"] .row-check`), true);
    assert.match(await page.getAttribute(`tr[data-key="${first}"] .located-cell .chip`, "title"), /E2E Artist B - New EP \(2026\)\/01 First\.(flac|aiff)/, "the file, on hover");
    assert.match(await page.getAttribute(`tr[data-key="${first}"] .formats-icon`, "title"), /Also here as:\n.*01 First\.(aiff|flac)/);
    // Select all ticks the duplicates too; Select new only goes back to the rows that aren't in the collection.
    await page.click("#selectAllRows");
    await page.waitForFunction((k) => document.querySelector(`tr[data-key="${k}"] .row-check`).checked, dup);
    await page.click("#selectNewOnly");
    await page.waitForFunction((k) => !document.querySelector(`tr[data-key="${k}"] .row-check`).checked, dup);
    await waitFor(() => api(`/api/import/${batchId}`).then((b) => b.rows.every((r) => r.checked === !r.duplicate)), { what: "the ticks saved" });
    assert.equal(await page.isChecked(`tr[data-key="${first}"] .row-check`), true);
    // Transfer to rekordbox: the ticked rows, a dry run first (cancelled here: nothing written, nothing added).
    const exportPosts = [];
    page.on("request", (r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/rekordbox/export" && exportPosts.push(r.postDataJSON()));
    assert.equal(await page.textContent("#transferToRekordbox"), "Transfer to rekordbox (3)…");
    await page.click("#transferToRekordbox");
    await waitFor(async () => exportPosts.length > 0, { what: "the transfer's dry run", timeout: 60000 });
    assert.equal(exportPosts[0].dry_run, true);
    const ticked = (await api(`/api/import/${batchId}`)).rows.filter((r) => r.checked).map((r) => `${batchId}:${r.n}`);
    assert.deepEqual(exportPosts[0].rows.slice().sort(), ticked.sort());
    await page.waitForFunction(
      () => document.querySelector(".confirm-dialog .dialog-cancel") || /^Transfer to rekordbox: (done|error)/.test(document.getElementById("refreshStatus").textContent),
      null,
      { timeout: 60000 }
    );
    if (await page.$(".confirm-dialog .dialog-cancel")) await page.click(".confirm-dialog .dialog-cancel");
    await page.waitForFunction(() => /^Transfer to rekordbox: (done|error)/.test(document.getElementById("refreshStatus").textContent));
    assert.equal(exportPosts.length, 1, "only the dry run");
    // Locations to update: the duplicate's collection item isn't located, so it gets this file on commit,
    // ticked or not; an item already located isn't listed.
    await page.waitForSelector("#locationUpdates:not([hidden])");
    assert.match(await page.textContent("#locationUpdates summary"), /^Locations to update \(\d+\): .*whether or not their rows are ticked/);
    assert.ok(await page.$('#locationUpdates li[data-item="t1002746421"]'), "Futuro Lontano is listed");
    assert.equal(await page.$(`#locationUpdates li[data-item="${ITEM}"]`), null, "an item already located isn't");
    await shot("files-preview.png");

    // Import selected: the ticked rows, numbered after everything, in row order; the duplicate isn't merged.
    const tsviTags = (await api("/api/items/t1002746421")).tags;
    await page.click("#importSelected");
    await page.waitForURL(SERVER + "/", { timeout: 60000 });
    const committed = await api(`/api/import/${batchId}`);
    assert.ok(committed.committed_at || committed.status === "committed", JSON.stringify(committed).slice(0, 300));
    const created = await api("/api/items?source=other").then((d) => (Array.isArray(d) ? d : d.items)).then((items) => items.filter((i) => ["First", "Second", "Thing"].includes(i.title)));
    const orders = ["First", "Second", "Thing"].map((t) => (created.find((i) => i.title === t) || {}).order);
    assert.ok(orders.every((o, i) => o > maxOrderBefore && (i === 0 || o > orders[i - 1])), `"#" in row order after everything: ${orders} (> ${maxOrderBefore})`);
    assert.deepEqual((await api("/api/items/t1002746421")).tags, tsviTags, "the unticked duplicate's tags are left alone");
    const tsvi = await api("/api/items/t1002746421");
    assert.equal(tsvi.local.status, "located", "but it's located to its file");
    assert.ok(tsvi.local.best.path.endsWith("TSVI - Stella Remota/01 Futuro Lontano.aiff"), tsvi.local.best.path);
    assert.equal((await api(`/api/items/${ITEM}`)).local.best.path, itemBefore.local.best.path, "an item already located is untouched");
    await page.waitForFunction(() => /collection items? located to the imported files/.test(document.getElementById("refreshStatus").textContent));
    // Next time the Collection starts from today.
    const defaults = await api("/api/import/files/defaults");
    assert.equal(defaults.folders.find((f) => f.path === coll).since, ymd(new Date()));
  } finally {
    if (batchId) await api(`/api/import/${batchId}`, { method: "DELETE" }).catch(() => {});
    await put({ owned_root: before.owned_root, not_owned_roots: before.not_owned_roots, downloads_dir: before.downloads_dir || "" });
    fs.rmSync(base, { recursive: true, force: true });
    await page.close();
  }
});

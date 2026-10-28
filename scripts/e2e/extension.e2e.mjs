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
// Only the player column plays: click its empty space (a corner, away from the controls).
const playerSpace = async (rowLocator) => {
  const cell = rowLocator.locator("td.player-cell");
  const box = await cell.boundingBox();
  await cell.click({ position: { x: box.width - 4, y: box.height - 4 } });
};
// The collection pages keep maintenance actions in the Tools ▾ menu.
const tool = async (page, id) => {
  await page.click("#toolsMenuBtn");
  await page.click(`#toolsMenu #${id}`);
};
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

// `seconds` of 8 kHz 8-bit silence.
function silentWav(seconds = 1, rate = 8000) {
  const size = rate * seconds;
  const b = Buffer.alloc(44 + size, 128);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + size, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(size, 40);
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
  // The first sync tick (onInstalled) has run to its end. It never checks ownership on Bandcamp by itself.
  await waitFor(
    () => probe.evaluate(() => chrome.storage.session.get("bcSyncStatus").then((s) => s.bcSyncStatus || {})).then((s) => !!s.tickDoneAt),
    { what: "the first sync tick", timeout: 20000 }
  );
  const tick = await probe.evaluate(() => chrome.storage.session.get("bcSyncStatus").then((s) => s.bcSyncStatus));
  assert.equal(tick.ownership, undefined, "no ownership check without the user's Refresh ownership");
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
    // Another new item rebuilds the table: the page stays where it was.
    await page.evaluate(() => window.scrollTo(0, 3000));
    const y = await page.evaluate(() => window.scrollY);
    await send({ type: "addTaggedItem", item: { id: `${NEW}2`, raw_id: 90000000012, tralbum_type: "t", artist: "E2E Artist", title: "E2E Newer", tags: ["must"] } });
    await page.waitForFunction((id) => document.querySelector(`tr[data-key="${id}"]`), `${NEW}2`, { timeout: 15000 });
    const scrolled = await page.evaluate(() => [window.scrollY, document.documentElement.scrollHeight, innerHeight]);
    assert.ok(Math.abs(scrolled[0] - y) < 50, `scroll kept: ${y} → ${JSON.stringify(scrolled)}`);

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
    await send({ type: "removeTaggedItem", id: `${NEW}2` });
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
  assert.deepEqual(buttons, ["Tools ▾", "Columns ▾"]);
  assert.deepEqual(await page.$$eval("#toolsMenu .tools-item", (bs) => bs.map((b) => b.textContent)), [
    "Refresh player files",
    "Refresh thumbnails",
    "Fix artists",
    "Fix album IDs",
  ]);
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
  await tool(app, "refreshOwnership");
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
  await tool(page, "fixAlbumIds");
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
  const before = await itemTags(ITEM);
  // A vocabulary tag the item doesn't have (the editor only offers vocabulary tags).
  const extra = (await storage("tags")).tags.find((t) => !before.includes(t));
  const want = [...before, extra].sort();
  // Right after an import the server is still getting the extension's tag list and "#" numbers
  // (each re-sorts the app's table): start once it has both.
  await waitFor(() => api("/api/tags").then((t) => Array.isArray(t) && t.includes(extra)), { what: "the tag list on the server" });
  await waitFor(
    () => api("/api/items").then((d) => (Array.isArray(d) ? d : d.items).every((i) => i.source === "other" || Number.isFinite(i.order))),
    { what: "every item numbered on the server", timeout: 30000 }
  );
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
  const set = async (tags) => {
    await app.locator(`tr[data-key="${ITEM}"]`).scrollIntoViewIfNeeded();
    await app.waitForSelector(`tr[data-key="${ITEM}"] select.tag-editor`, { state: "attached" });
    await app.evaluate(([id, t]) => $(`tr[data-key="${id}"] select.tag-editor`).val(t).trigger("change"), [ITEM, tags]);
  };
  const editorTags = async () => [...((await app.evaluate((id) => $(`tr[data-key="${id}"] select.tag-editor`).val(), ITEM)) || [])].sort();

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
  await waitFor(() => api(`/api/items/${ITEM}`).then((it) => JSON.stringify([...it.tags].sort()) === JSON.stringify([...before].sort())), {
    what: "the tags back on the server",
  });
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
const PYTHON = process.env.E2E_PYTHON || "/Users/alvaroh/Projects/auto-rekordbox/.venv/bin/python"; // the server's (has mutagen)
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

// The mapping editor's tag list and the library's playlists arrive after the page (each
// re-renders or repaints it): wait for both before typing, and for each result after.
const mappingLoaded = (page) => page.waitForSelector(".mapping[data-vocab][data-playlists]", { state: "attached" });
const settingsNow = () => api("/api/settings").then((d) => d.settings || d);
// Export / Transfer count what they can send: the located ones.
const locatedOf = (ids) =>
  api(`/api/items?ids=${ids.join(",")}`).then((d) => (Array.isArray(d) ? d : d.items).filter((i) => i.local && i.local.status === "located").length);
const skippedHint = (n) => (n ? `${n} not located ${n > 1 ? "are" : "is"} skipped` : "");

test("Settings: the tag → playlists mapping round-trips through the server", async () => {
  const page = await context.newPage();
  await page.goto(SERVER + "/settings/#rekordbox");
  await mappingLoaded(page);
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
  let s = await waitFor(() => settingsNow().then((x) => x.tag_playlist_mode === "custom" && x), { what: "the custom mapping saved" });
  assert.equal(s.tag_playlist_mode, "custom");
  assert.deepEqual(s.tag_playlist_map.must, ["/DJ/Status/Must", "Favourites"]);
  assert.deepEqual(s.tag_playlist_map.pool, ["Sub/Pool"]);
  assert.deepEqual(s.tag_playlist_map.build, ["build"], "the others: their own name");

  await page.reload();
  await mappingLoaded(page);
  assert.equal(await row("must").locator("input").nth(1).inputValue(), "Favourites");
  await row("pool").locator("input").first().fill("a//b"); // invalid: refused by the server
  await page.waitForFunction(() => /empty folder name/.test(document.querySelector('.map-row[data-tag="pool"] .map-status').textContent));
  await page.click("#saveBtn");
  await page.waitForFunction(() => /Not saved/.test(document.getElementById("saveState").textContent));
  assert.deepEqual((await settingsNow()).tag_playlist_map.pool, ["Sub/Pool"], "nothing saved");
  await page.click("#revertBtn");
  await page.waitForFunction(() => document.querySelector('.map-row[data-tag="pool"] input').value === "Sub/Pool");
  await page.check("#mappingAuto"); // back to auto; the map is kept for later
  await page.click("#saveBtn");
  await page.waitForFunction(() => /Saved/.test(document.getElementById("saveState").textContent));
  s = await waitFor(() => settingsNow().then((x) => x.tag_playlist_mode === "auto" && x), { what: "auto mode saved" });
  assert.equal(s.tag_playlist_mode, "auto");
  assert.deepEqual(s.tag_playlist_map.must, ["/DJ/Status/Must", "Favourites"]);
  await page.close();
});

test("Settings: unticking Auto prefills unmapped tags (saved ones untouched); a playlist to be created is yellow", async () => {
  await put({ tag_playlist_mode: "auto", tag_playlist_map: { pool: ["Pool Party"], ritual: [] } });
  const page = await context.newPage();
  try {
    await page.goto(SERVER + "/settings/#rekordbox");
    await mappingLoaded(page);
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

test("Settings → Rekordbox: Library (Test / Main) and Allow writes are separate; unticking Allow keeps Main; the header says read-only or writes enabled", async () => {
  await put({ rekordbox_main_db_path: SANDBOX_MAIN, rekordbox_target: "test", allow_main_writes: false });
  const page = await context.newPage();
  const saved = async () => {
    await page.click("#saveBtn");
    await page.waitForFunction(() => /Saved/.test(document.getElementById("saveState").textContent));
    return api("/api/settings").then((d) => d.settings || d);
  };
  try {
    await page.goto(SERVER + "/settings/#rekordbox");
    await page.waitForSelector("#f_target_test");
    assert.equal(await page.isChecked("#f_target_test"), true);
    assert.equal(await page.isVisible("#mainLibraryBanner"), false, "no banner for the test library");

    // Main with writes locked: read-only.
    await page.check("#f_target_main");
    let s = await saved();
    assert.deepEqual([s.rekordbox_target, s.allow_main_writes], ["main", false]);
    await page.waitForFunction(() => document.getElementById("mainLibraryBanner").textContent === "MAIN LIBRARY · read-only");
    assert.match(await page.textContent("#mainTargetBanner"), /read-only/);

    // Allow asks first (a backup acknowledgement); cancel keeps it locked.
    await page.check("#f_allow_main_writes").catch(() => {}); // the dialog opens and un-ticks it
    await page.waitForSelector("#mainLibraryConfirm");
    assert.match(await page.textContent("#mainLibraryConfirm"), /Backup Library/);
    assert.equal(await page.isDisabled("#mainLibraryConfirm .dialog-confirm"), true, "needs the backup acknowledgement");
    await page.click("#mainLibraryConfirm .dialog-cancel");
    assert.equal(await page.isChecked("#f_allow_main_writes"), false);
    await page.check("#f_allow_main_writes").catch(() => {});
    await page.waitForSelector("#mainLibraryConfirm");
    await page.check("#mainLibraryConfirm .dialog-ack input");
    await page.click("#mainLibraryConfirm .dialog-confirm");
    s = await saved();
    assert.deepEqual([s.rekordbox_target, s.allow_main_writes, s.rekordbox_main_db_path], ["main", true, SANDBOX_MAIN]);
    await page.waitForFunction(() => document.getElementById("mainLibraryBanner").textContent === "MAIN LIBRARY · writes enabled");
    const app = await context.newPage();
    await app.goto(SERVER + "/");
    await app.waitForFunction(() => document.getElementById("mainLibraryBanner").textContent === "MAIN LIBRARY · writes enabled");
    await app.close();

    // Unticking Allow locks writes and keeps Main.
    await page.uncheck("#f_allow_main_writes");
    s = await saved();
    assert.deepEqual([s.rekordbox_target, s.allow_main_writes], ["main", false]);
    assert.equal(await page.isChecked("#f_target_main"), true);
    await page.waitForFunction(() => document.getElementById("mainLibraryBanner").textContent === "MAIN LIBRARY · read-only");

    // Back to Test: no banner.
    await page.check("#f_target_test");
    s = await saved();
    assert.equal(s.rekordbox_target, "test");
    await page.waitForFunction(() => document.getElementById("mainLibraryBanner").hidden);
  } finally {
    await put({ rekordbox_target: "test", allow_main_writes: false });
    await page.close();
  }
});

test("Settings → Rekordbox: the Playlists marks follow the Library radios before Save (two sandbox libraries)", async (t) => {
  const template = process.env.E2E_TEMPLATE_DB || path.join(process.env.HOME, "Library/Pioneer/rekordbox_test/master.db");
  if (!fs.existsSync(template)) {
    t.skip(`no template DB at ${template} (test library switched out?)`);
    return;
  }
  // Copies of the template, each with a playlist only it has (the script refuses ~/Library/Pioneer).
  const dir = path.join(E2E, "marks");
  fs.rmSync(dir, { recursive: true, force: true });
  const sandbox = (name, playlist, ...flags) =>
    execFileSync(PYTHON, [path.join(ROOT, "server", "scripts", "make_sandbox_library.py"), path.join(dir, name), "--playlist", playlist, ...flags], {
      env: { ...process.env, BCT_TEST_TEMPLATE_DB: template },
    })
      .toString()
      .trim();
  const testDb = sandbox("test", "/E2E Marks/Only Test", "--test-marker");
  const mainDb = sandbox("main", "/E2E Marks/Only Main");
  const { rekordbox_db_path: savedTestDb } = await api("/api/settings");
  await put({
    rekordbox_db_path: testDb,
    rekordbox_main_db_path: mainDb,
    rekordbox_target: "test",
    allow_main_writes: false,
    tag_playlist_mode: "custom",
    tag_playlist_map: { must: ["/E2E Marks/Only Test"], pool: ["/E2E Marks/Only Main"] },
  });
  const page = await context.newPage();
  const marks = () =>
    page.evaluate(() =>
      ["must", "pool"].map((tag) => document.querySelector(`.map-row[data-tag="${tag}"] .map-entry .map-status`).textContent)
    );
  const marksAre = (must, pool) =>
    page.waitForFunction(
      ([m, p]) => {
        const st = (tag) => (document.querySelector(`.map-row[data-tag="${tag}"] .map-entry .map-status`) || {}).textContent || "";
        return m.test(st("must")) && p.test(st("pool"));
      },
      [must, pool]
    );
  const EXISTS = /^exists · \d+ tracks?$/;
  const MISSING = /^does not exist/;
  try {
    await page.goto(SERVER + "/settings/#rekordbox");
    await mappingLoaded(page);
    await marksAre(EXISTS, MISSING).catch(async (e) => assert.fail(`test library marks: ${await marks()}`));
    await page.check("#f_target_main"); // not saved: the marks read the main library
    await marksAre(MISSING, EXISTS).catch(async (e) => assert.fail(`main library marks: ${await marks()}`));
    assert.equal((await api("/api/settings")).rekordbox_target, "test", "a radio alone doesn't save");
    await page.check("#f_target_test");
    await marksAre(EXISTS, MISSING);
    // Quick switches: the last one picked wins.
    await page.check("#f_target_main");
    await page.check("#f_target_test");
    await page.check("#f_target_main");
    await marksAre(MISSING, EXISTS);
  } finally {
    await put({
      rekordbox_db_path: savedTestDb,
      rekordbox_main_db_path: SANDBOX_MAIN,
      rekordbox_target: "test",
      tag_playlist_mode: "auto",
      tag_playlist_map: {},
    });
    await page.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  await app.goto(SERVER + "/settings/#test");
  await app.waitForSelector("#mainLibraryBanner:not([hidden])");
  await app.waitForSelector("#exportLatest");

  // Export latest 10 (Settings → Test): dry run, then the dialog; Cancel writes nothing.
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
  await app.goto(SERVER + "/");
  await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 0);
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
test("Main library with writes locked: the dry run shows the blocker, with a link to allow writes, and Confirm stays disabled (sandbox copy)", async (t) => {
  const template = process.env.E2E_TEMPLATE_DB || path.join(process.env.HOME, "Library/Pioneer/rekordbox_test/master.db");
  if (!fs.existsSync(template)) {
    t.skip(`no template DB at ${template} (test library switched out?)`);
    return;
  }
  const dir = path.join(E2E, "main-locked", "rekordbox");
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const db = path.join(dir, "master.db");
  fs.copyFileSync(template, db); // a copy: the template is only read
  const stat = () => {
    const st = fs.statSync(db);
    return `${st.size}:${st.mtimeMs}`;
  };
  await put({
    rekordbox_main_db_path: db,
    rekordbox_target: "main",
    allow_main_writes: false,
    tag_playlist_mode: "custom",
    tag_playlist_map: { must: ["/E2E/Must"], pool: ["Pool"] },
  });
  const loc = await post("/api/locate", { latest: 10 });
  await waitFor(() => api(`/api/jobs/${loc.job_id}`).then((j) => j.status === "done" || j.status === "error"), {
    timeout: 120000,
    what: "locate",
  });
  const before = stat();
  const page = await context.newPage();
  try {
    await page.goto(SERVER + "/settings/#test");
    await page.waitForFunction(() => document.getElementById("mainLibraryBanner").textContent === "MAIN LIBRARY · read-only");
    await page.click("#exportLatest");
    // The dialog, or the flow ended without one (then its status says why).
    await page.waitForFunction(() => document.getElementById("exportConfirm") || !document.getElementById("exportLatest").disabled, null, {
      timeout: 120000,
    });
    assert.ok(await page.$("#exportConfirm"), `no dry-run dialog: ${await page.textContent("#refreshStatus")}`);
    assert.match(await page.textContent("#exportConfirm"), /Writing to your main collection is locked/);
    assert.equal(await page.getAttribute("#exportConfirm .allow-writes-link", "href"), "/settings/#rekordbox");
    assert.equal(await page.isDisabled("#exportConfirm .dialog-confirm"), true);
    await page.click("#exportConfirm .dialog-cancel");
    assert.equal(stat(), before, "nothing written");
  } finally {
    await put({ rekordbox_target: "test", allow_main_writes: false, tag_playlist_mode: "auto" });
    await page.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

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
  await app.goto(SERVER + "/settings/#test");
  await app.waitForSelector("#mainLibraryBanner:not([hidden])");
  await app.waitForSelector("#exportLatest");
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
  await put({ allow_main_writes: false, rekordbox_target: "test", tag_playlist_mode: "auto" });
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

test("popup: Checkout / PayPal automation is on by default; off, the checkout script does nothing (fixture page)", async () => {
  // A stand-in PayPal page with the buttons checkout.js clicks; each click is recorded.
  const FIXTURE = `<!doctype html><html><body>
    <script>window.__clicked = [];</script>
    <div class="footer-button"><button onclick="window.__clicked.push('footer')">Continue</button></div>
    <button id="one-time-cta" onclick="window.__clicked.push('pay')">Pay</button>
  </body></html>`;
  const URL = "https://www.paypal.com/checkoutnow?token=e2e";
  const popup = await context.newPage();
  const shop = await context.newPage();
  await shop.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: FIXTURE })); // nothing leaves the browser
  const logs = [];
  shop.on("console", (m) => logs.push(m.text()));
  try {
    // On by default: the script clicks through.
    await popup.goto(extPage("popup.html"));
    await popup.waitForFunction(() => document.getElementById("checkoutAutomation"));
    assert.equal(await popup.isChecked("#checkoutAutomation"), true);
    await shop.goto(URL);
    await shop.waitForFunction(() => window.__clicked.includes("footer") && window.__clicked.includes("pay"), null, { timeout: 10000 });

    // Off (remembered): the next load does nothing at all.
    await popup.uncheck("#checkoutAutomation");
    await waitFor(async () => (await storage("checkoutAutomation")).checkoutAutomation === false, { what: "the setting stored" });
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById("checkoutAutomation"));
    await waitFor(async () => !(await popup.isChecked("#checkoutAutomation")), { what: "the box unticked after a reload" });
    logs.length = 0;
    await shop.reload();
    await waitFor(async () => logs.some((t) => /checkout automation is off/.test(t)), { what: "the script saying it's off" });
    assert.deepEqual(await shop.evaluate(() => window.__clicked), [], "no clicks");
  } finally {
    await probe.evaluate(() => chrome.storage.local.remove("checkoutAutomation"));
    await Promise.all([popup.close(), shop.close()]);
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

test("Bandcamp page: one link-candidates request for all its items (recorded album page)", async () => {
  const pageUrl = "https://infiniteexpanse.bandcamp.com/album/synergy-trilogy";
  // An import row that fits one of the page's tracks, so the page gets a "Link to import" button.
  const items = [{ line: 1, raw: "Synergy Trilogy - E2E stand-in track", artist: "Synergy Trilogy", title: "E2E stand-in track", tags: ["must"] }];
  const file = { format: "bc-tagger-import/1", source: "e2e-link.txt", unknown_tags: {}, items };
  const { batch_id: batchId } = await post("/api/import", { file, default_tags: [], name: "e2e-link" });
  const asks = [];
  const record = (route) => {
    asks.push(route.request().postDataJSON());
    return route.continue();
  };
  await context.route(SERVER + "/api/import/link-candidates", record); // the extension's own requests too
  const page = await context.newPage();
  try {
    await waitFor(() => api(`/api/import/${batchId}`).then((b) => b.status === "ready"), { what: "the batch", timeout: 30000 });
    await post(`/api/import/${batchId}/tags`, { map: {}, unmapped: "create" });
    await page.goto(pageUrl);
    await page.waitForSelector(".bct-link-btn", { timeout: 30000 });
    await page.waitForTimeout(800); // anything else would have gone out by now
    const widgets = await page.$$eval("select[id^='tagger_']", (s) => s.length);
    assert.equal(asks.length, 1, "one request for the page");
    assert.equal(asks[0].items.length, widgets, "with every item on it");
    assert.ok(asks[0].items.every((e) => e.page_url === pageUrl && /^[at]\d+$/.test(e.item.id)));
  } finally {
    await context.unroute(SERVER + "/api/import/link-candidates", record);
    await api(`/api/import/${batchId}`, { method: "DELETE" }).catch(() => {});
    await page.close();
  }
});

// --- Phase 2b: file index status, Rescan drive ----------------------------------

const hasIndexStatus = () => fetch(`${SERVER}/api/index/status`).then((r) => r.ok).catch(() => false);

async function rescanFromApp(app) {
  const samples = await app.evaluate(() => {
    window.__indexSamples = [];
    const st = document.getElementById("indexStatus");
    new MutationObserver(() =>
      window.__indexSamples.push(`${st.textContent}${document.getElementById("locateShown").disabled ? " [blocked]" : ""}`)
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
  assert.equal(await app.isDisabled("#locateShown"), false, "re-enabled after the scan");
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
  await app.goto(SERVER + "/settings/#test");
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
    await playerSpace(row); // the player column's empty space plays it
    await app.waitForTimeout(600);
  }
  assert.equal(await audiosIn(app, key) + (await app.$$eval("#gpAudioHolder audio", (a) => a.length)), 1, "one player for the track");
  assert.ok((await playingCount(app)) <= 1, "at most one playing");
  await app.evaluate(() => document.querySelectorAll("audio").forEach((a) => a.pause()));
  await app.close();
});

test("player: passing over a paused player loads nothing, resting on it loads it once; hovering one that's playing doesn't stop it; the Artist cell copies \"Artist Title\"", async () => {
  const a = "t1002746421"; // Futuro Lontano by TSVI (durable stream link: an <audio> from the start)
  const page = await context.newPage();
  try {
    await page.goto(extPage("collection.html"));
    await page.waitForSelector(`tr[data-key="${a}"] audio`, { state: "attached" });
    if (!(await page.isChecked("#globalModeToggle"))) await page.click("#globalModeToggle");
    // A paused player: passing over it loads nothing; resting on it loads its metadata (so the timeline seeks).
    const other = await page.evaluate((a) => {
      const r = [...document.querySelectorAll("#collectionTable tbody tr")].find((tr) => tr.dataset.key !== a && tr.querySelector("td.player-cell audio"));
      return r && r.dataset.key;
    }, a);
    assert.ok(other, "another row with an <audio>");
    const otherSrc = await page.getAttribute(`tr[data-key="${other}"] audio`, "src");
    const loads = [];
    const onRequest = (r) => r.url() === otherSrc && loads.push(r.url());
    page.on("request", onRequest);
    await page.locator(`tr[data-key="${other}"] .row-player`).scrollIntoViewIfNeeded();
    await page.$eval(`tr[data-key="${other}"] audio`, (au) => {
      au.__loads = 0;
      au.addEventListener("loadstart", () => au.__loads++);
    });
    const at = await page.locator(`tr[data-key="${other}"] .row-player`).boundingBox();
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.move(at.x + at.width / 2, at.y - 40); // passed over
    await page.waitForTimeout(400);
    assert.equal(await page.$eval(`tr[data-key="${other}"] audio`, (au) => au.readyState), 0, "passing over loads nothing");
    assert.deepEqual(loads, [], "no request for the stream");
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2); // resting on it
    await page.waitForFunction((k) => document.querySelector(`tr[data-key="${k}"] audio`).readyState > 0, other, { timeout: 10000 });
    page.off("request", onRequest);
    // Not started over (the stand-in stream has no ranges, so Chrome may fetch it twice; the app's test counts
    // requests).
    assert.ok((await page.$eval(`tr[data-key="${other}"] audio`, (au) => au.__loads)) <= 1, "resting on it loads it once");
    assert.ok(loads.length >= 1);
    // Play (a row click), then hover the player: it keeps playing (load() would reset it).
    await page.$eval(`tr[data-key="${a}"] audio`, (au) => {
      au.loop = true; // the stand-in stream is 1 s of silence
      window.__audioEvents = [];
      ["emptied", "abort", "pause"].forEach((t) => au.addEventListener(t, () => window.__audioEvents.push(t)));
    });
    await page.locator(`tr[data-key="${a}"]`).scrollIntoViewIfNeeded();
    await playerSpace(page.locator(`tr[data-key="${a}"]`));
    await page.waitForFunction(() => [...document.querySelectorAll("audio")].some((au) => !au.paused && au.currentTime > 0), null, { timeout: 10000 });
    const playing = await page.evaluateHandle(() => [...document.querySelectorAll("audio")].find((au) => !au.paused));
    await (await playing.evaluateHandle((au) => au.parentElement)).hover(); // its controls
    await page.waitForTimeout(600);
    assert.equal(await playing.evaluate((au) => au.paused), false, "still playing after the hover");
    assert.deepEqual(await page.evaluate(() => window.__audioEvents), [], "not reset or paused");
    // Global mode: with its row scrolled away, the player (its controls) docks in the top bar, still playing.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForSelector("#gpAudioHolder .row-player audio", { state: "attached", timeout: 5000 });
    assert.equal(await playing.evaluate((au) => au.paused), false, "still playing, docked");
    if (process.env.E2E_SHOTS) await page.locator("#globalPlayer").screenshot({ path: path.join(process.env.E2E_SHOTS, "docked-player.png") });
    await page.locator(`tr[data-key="${a}"]`).scrollIntoViewIfNeeded();
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

// --- Connections and background work: the local app holds one event stream per visible page, and reads the
// drive or Bandcamp only when the user asks.

// Records the page's EventSources (window.__streams) from before its scripts run.
const countStreams = (page) =>
  page.addInitScript(() => {
    const ES = window.EventSource;
    window.__streams = [];
    window.EventSource = class extends ES {
      constructor(...args) {
        super(...args);
        window.__streams.push(this);
      }
    };
  });
const streams = (page) =>
  page.evaluate(() => ({ made: window.__streams.length, open: window.__streams.filter((s) => s.readyState !== 2).length }));
// What Chrome does when the tab is switched away from / back to.
const setHidden = (page, hidden) =>
  page.evaluate((h) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

test("local app: a page holds one event stream (Settings too); a hidden tab closes it and catches up when shown again", async () => {
  const id = "t999000003"; // a server-only item, removed at the end
  const settings = await context.newPage();
  const app = await context.newPage();
  await countStreams(settings);
  await countStreams(app);
  try {
    // Settings: its header, Import and Test tabs share one stream (they had one each).
    await settings.goto(SERVER + "/settings/#import");
    await settings.waitForSelector("#importFile", { state: "attached" });
    await settings.waitForFunction(() => window.__streams.length > 0);
    await settings.waitForTimeout(300);
    assert.deepEqual(await streams(settings), { made: 1, open: 1 });

    await app.goto(SERVER + "/");
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key]").length > 0);
    await app.waitForFunction(() => window.__streams.length > 0);
    await app.waitForTimeout(300);
    assert.deepEqual(await streams(app), { made: 1, open: 1 });

    // Hidden: the stream is closed, so a change on the server doesn't reach the page...
    await setHidden(app, true);
    assert.deepEqual(await streams(app), { made: 1, open: 0 });
    await post("/api/sync/items", { items: { [id]: { id, title: "E2E while hidden", tralbum_type: "t", tags: ["must"] } }, deleted: [], full: false });
    await app.waitForTimeout(800);
    assert.equal(await app.$(`tr[data-key="${id}"]`), null, "no update while hidden");
    // ...until it's shown again: a new stream, and the page catches up.
    await setHidden(app, false);
    await app.waitForSelector(`tr[data-key="${id}"]`, { state: "attached", timeout: 10000 });
    assert.deepEqual(await streams(app), { made: 2, open: 1 });
  } finally {
    await post("/api/sync/items", { items: {}, deleted: [id], full: false });
    await settings.close();
    await app.close();
  }
});

test("local app: the rows load while the extension is still answering; \"Loading collection…\" until they're in", async () => {
  const app = await context.newPage();
  // Hold the extension's hello (so the bridge stays "connecting") and record when the ping and the items request go out.
  await app.addInitScript(() => {
    const held = [];
    window.__t = {};
    window.addEventListener(
      "message",
      (e) => {
        if (e.data && e.data.bcTagger === "hello" && !window.__bridgeOpen) {
          held.push(e.data);
          e.stopImmediatePropagation();
        }
      },
      true
    );
    window.__openBridge = () => {
      window.__bridgeOpen = true;
      held.forEach((d) => window.postMessage(d, location.origin));
    };
    const post = window.postMessage.bind(window);
    window.postMessage = (m, ...rest) => {
      if (m && m.bcTagger === "ping" && window.__t.ping == null) window.__t.ping = performance.now();
      return post(m, ...rest);
    };
    const f = window.fetch.bind(window);
    window.fetch = (url, ...rest) => {
      if (String(url) === "/api/items" && window.__t.items == null) window.__t.items = performance.now();
      return f(url, ...rest);
    };
  });
  let release;
  const held = new Promise((r) => (release = r));
  await app.route("**/api/items", async (route) => {
    await held;
    await route.continue();
  });
  try {
    await app.goto(SERVER + "/");
    await app.waitForSelector("#loadingState");
    assert.equal(await app.textContent("#loadingState"), "Loading collection…");
    assert.equal(await app.$$eval("#collectionTable tbody tr[data-key]", (r) => r.length), 0);
    const t = await app.evaluate(() => window.__t);
    assert.ok(t.items - t.ping < 500, `the items were asked for with the extension's answer still pending (${Math.round(t.items - t.ping)} ms)`);
    release();
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key]").length > 0);
    assert.equal(await app.$("#loadingState"), null);
    assert.doesNotMatch(await app.textContent("#navExt"), /extension connected/);
    await app.evaluate(() => window.__openBridge());
    await app.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
  } finally {
    release();
    await app.close();
  }
});

// The players' own seek bar: a click at `frac` of it (rowPlayer.js).
async function clickBar(page, key, frac) {
  const box = await page.locator(`tr[data-key="${key}"] .row-player .rp-track`).boundingBox();
  await page.mouse.click(box.x + box.width * frac, box.y + box.height / 2);
}
// A route handler that answers with `wav` after `delayMs` (like a drive that has to wake up), with ranges like
// the real server and Bandcamp's CDN (without them Chrome can't seek). `reads` gets each request's URL.
function slowWav(wav, delayMs, reads = []) {
  return async (route) => {
    reads.push(route.request().url());
    await sleep(delayMs);
    const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || "");
    if (!m) return route.fulfill({ status: 200, contentType: "audio/wav", headers: { "Accept-Ranges": "bytes" }, body: wav }).catch(() => {});
    const from = Number(m[1]);
    const to = m[2] ? Math.min(Number(m[2]), wav.length - 1) : wav.length - 1;
    return route
      .fulfill({
        status: 206,
        contentType: "audio/wav",
        headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${from}-${to}/${wav.length}` },
        body: wav.subarray(from, to + 1),
      })
      .catch(() => {}); // the page may have moved on
  };
}
// Answers a page's /api/files/stream requests with a `seconds` silent WAV after `delayMs` (or with `stream`, a route
// handler); marks `count` tracks located (local players), with the server's cached `duration` and `preview` flag if
// given (`preview` may be a function: asked at each items request); the first `other` of them are shown as from
// another source (no Bandcamp player). Nothing on the server changes and no file is read. Returns the requests seen
// (not with `stream`), with `.located` and `.other`: the item ids.
async function slowLocalStreams(page, { delayMs = 1500, count = 12, duration = null, preview = null, seconds = 3, stream = null, other = 0 } = {}) {
  const located = [];
  const others = [];
  // Right after an import the items are still getting their "#" (each re-renders the table): start after.
  await waitFor(
    () => api("/api/items").then((d) => (Array.isArray(d) ? d : d.items).every((i) => i.source === "other" || Number.isFinite(i.order))),
    { what: "every item numbered on the server", timeout: 30000 }
  );
  await page.route("**/api/items", async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    (Array.isArray(data) ? data : data.items)
      .filter((i) => i.tralbum_type === "t" && i.source !== "other")
      .sort((a, b) => String(a.id).localeCompare(String(b.id))) // the same ones at each request
      .slice(0, count)
      .forEach((it, n) => {
        const pv = typeof preview === "function" ? preview() : preview;
        const best = { path: `/e2e/not-a-real-folder/${it.id}.wav`, ...(duration ? { duration } : {}), ...(pv != null ? { preview: pv } : {}) };
        it.local = { status: "located", best, candidates: [] };
        if (!located.includes(it.id)) located.push(it.id);
        if (n < other) {
          it.source = "other";
          if (!others.includes(it.id)) others.push(it.id);
        }
      });
    await route.fulfill({ response: res, json: data });
  });
  const reads = [];
  await page.route("**/api/files/stream**", stream || slowWav(silentWav(seconds), delayMs, reads));
  // (not enumerable: tests compare `reads` with arrays)
  return Object.defineProperties(reads, { located: { value: located }, other: { value: others } });
}
// The music drive unplugged (or back): the stream answers as the server does without it, and /api/index/status
// says the stand-in files' folder isn't mounted. Then `plug(true)`: the files play (a `seconds` silent WAV).
async function unpluggedDrive(page, folder, { seconds = 3 } = {}) {
  const d = { plugged: false, streams: 0 };
  const wav = slowWav(silentWav(seconds), 0);
  await page.route("**/api/files/stream**", (route) => {
    d.streams++;
    if (d.plugged) return wav(route);
    return route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"music drive not mounted"}' }).catch(() => {});
  });
  await page.route("**/api/index/status", async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    data.roots = [...(data.roots || []), { path: folder, kind: "owned", mounted: d.plugged, files: 12, complete: true }];
    await route.fulfill({ response: res, json: data });
  });
  return d;
}
// A stand-in for the server's stream of a local file, in its two versions: the original (`src=original`, 8 kHz) and
// the preview (`src=preview`, 4 kHz: half the size; 404 until `built`, and once `gone`). A URL without `src` is the
// server from before: the original until the preview is built, then the preview (a seek past its size: 416). Answers
// in chunks, so a seek asks again; `log` gets each request ({path, src, from, status}).
const STREAM_CHUNK = 64 * 1024;
function streamDouble({ seconds = 600 } = {}) {
  const original = silentWav(seconds);
  const preview = silentWav(seconds, 4000); // (Chrome plays nothing under 3 kHz)
  const d = { built: false, gone: false, log: [], size: original.length };
  d.handler = async (route) => {
    const u = new URL(route.request().url());
    const src = u.searchParams.get("src");
    const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || "");
    const from = m ? Number(m[1]) : 0;
    const entry = { path: u.searchParams.get("path"), src, from, status: 0 };
    d.log.push(entry);
    await sleep(40);
    const usePreview = src === "preview" || (!src && d.built);
    if (usePreview && (!d.built || d.gone)) {
      entry.status = 404;
      return route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"no preview"}' }).catch(() => {});
    }
    const body = usePreview ? preview : original;
    if (from >= body.length) {
      entry.status = 416;
      return route.fulfill({ status: 416, headers: { "Content-Range": `bytes */${body.length}` } }).catch(() => {});
    }
    const to = Math.min(m && m[2] ? Number(m[2]) : body.length - 1, from + STREAM_CHUNK - 1, body.length - 1);
    entry.status = 206;
    return route
      .fulfill({
        status: 206,
        contentType: "audio/wav",
        headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${from}-${to}/${body.length}` },
        body: body.subarray(from, to + 1),
      })
      .catch(() => {});
  };
  return d;
}
// A row's player is playing, past `t` seconds (and has what it needs to go on).
const playingPast = (page, key, t) =>
  page.waitForFunction(
    ([k, t]) => {
      const au = document.querySelector(`tr[data-key="${k}"] audio`);
      return au && !au.paused && au.readyState >= 3 && au.currentTime > t;
    },
    [key, t],
    { timeout: 15000 }
  );
const srcOf = (page, key) => page.getAttribute(`tr[data-key="${key}"] audio`, "src");
// The local players shown, in order.
const localPlayers = async (page) => {
  await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key] audio.local-audio").length > 3);
  return page.$$eval("#collectionTable tbody tr[data-key] audio.local-audio", (as) => as.map((a) => a.closest("tr").dataset.key));
};
// Where the row's audio was when it started playing (the first "playing" after this), and now.
const watchStart = (page, key) =>
  page.$eval(`tr[data-key="${key}"] audio`, (au) => {
    au.__startedAt = null;
    au.addEventListener("playing", () => au.__startedAt == null && (au.__startedAt = au.currentTime));
  });
const started = (page, key) =>
  page.waitForFunction((k) => document.querySelector(`tr[data-key="${k}"] audio`).__startedAt != null, key, { timeout: 15000 }).then(() =>
    page.$eval(`tr[data-key="${key}"] audio`, (au) => ({ at: au.__startedAt, now: au.currentTime, d: au.duration, paused: au.paused }))
  );

test("local app: a single click on a player's bar before its file is loaded (a slow drive) plays from there", async () => {
  const app = await context.newPage();
  const reads = await slowLocalStreams(app);
  try {
    await app.goto(SERVER + "/");
    const [key] = await localPlayers(app);
    await app.locator(`tr[data-key="${key}"]`).scrollIntoViewIfNeeded();
    await watchStart(app, key);
    await clickBar(app, key, 0.6); // straight there: no time to rest on it first
    assert.equal(await app.$eval(`tr[data-key="${key}"] audio`, (au) => au.readyState), 0, "clicked before the metadata");
    assert.match(await app.getAttribute(`tr[data-key="${key}"] .row-player`, "class"), /\bloading\b/, "shows it's loading");
    const thumb = await app.$eval(`tr[data-key="${key}"] .rp-thumb`, (t) => parseFloat(t.style.left));
    assert.ok(Math.abs(thumb - 60) < 2, `the thumb waits at the click: ${thumb}%`);
    const s = await started(app, key);
    assert.ok(s.at > 0.5 * s.d && !s.paused, `started at ${s.at} of ${s.d}`);
    assert.ok(reads.length >= 1);
  } finally {
    await app.evaluate(() => document.querySelectorAll("audio").forEach((au) => au.pause())).catch(() => {});
    await app.close();
  }
});

test("local app: a player shows the file's cached length before anything is loaded; the file's own length wins", async () => {
  const app = await context.newPage();
  const reads = await slowLocalStreams(app, { duration: 312.4 }); // the stand-in file itself is 3 s
  try {
    await app.goto(SERVER + "/");
    const [key] = await localPlayers(app);
    const shot = (name) =>
      process.env.E2E_SHOTS && app.locator(`tr[data-key="${key}"] td.player-cell`).screenshot({ path: path.join(process.env.E2E_SHOTS, name) });
    assert.equal(await app.textContent(`tr[data-key="${key}"] .rp-time`), "0:00 / 5:12");
    assert.deepEqual(reads, [], "before any request");
    await app.locator(`tr[data-key="${key}"]`).scrollIntoViewIfNeeded();
    await app.mouse.move(5, 5);
    await shot("row-player.png");
    await watchStart(app, key);
    await clickBar(app, key, 0.5);
    assert.equal(await app.textContent(`tr[data-key="${key}"] .rp-time`), "2:36 / 5:12", "where it will start, while it loads");
    await shot("row-player-loading.png");
    const s = await started(app, key);
    await app.mouse.move(5, 5);
    await shot("row-player-playing.png");
    assert.ok(s.at > 0.4 * s.d && s.at < 0.65 * s.d && Math.abs(s.d - 3) < 0.1, `half of the file's own length: ${s.at} of ${s.d}`);
    assert.match(await app.textContent(`tr[data-key="${key}"] .rp-time`), / \/ 0:03$/);
  } finally {
    await app.evaluate(() => document.querySelectorAll("audio").forEach((au) => au.pause())).catch(() => {});
    await app.close();
  }
});

test("local app: \"Use previews\" off asks for the originals (src=original), and a track playing carries on from the same moment on the new source", async () => {
  const app = await context.newPage();
  const reads = await slowLocalStreams(app, { delayMs: 0, seconds: 10, preview: true });
  const rest = async (key) => {
    const b = await app.locator(`tr[data-key="${key}"] .row-player`).boundingBox();
    await app.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await app.waitForFunction((k) => document.querySelector(`tr[data-key="${k}"] audio`).readyState >= 1, key, { timeout: 10000 });
    await app.mouse.move(5, 5);
  };
  try {
    await app.goto(SERVER + "/");
    const [key, other] = await localPlayers(app);
    assert.equal(await app.isChecked("#usePreviews"), true, "on by default");
    await app.locator(`tr[data-key="${key}"]`).scrollIntoViewIfNeeded();
    await rest(key);
    assert.ok(reads.length >= 1 && reads.every((u) => /&src=preview$/.test(u)), `previews on: ${reads.join(", ")}`);
    // Play, then turn previews off mid-play: the same moment, on the original.
    await clickBar(app, key, 0.3);
    await app.waitForFunction((k) => {
      const au = document.querySelector(`tr[data-key="${k}"] audio`);
      return !au.paused && au.readyState >= 3 && au.currentTime > 3.2;
    }, key, { timeout: 10000 });
    assert.equal(await app.textContent("#playingSource"), "▶ preview");
    await watchStart(app, key);
    const before = await app.$eval(`tr[data-key="${key}"] audio`, (au) => au.currentTime);
    reads.length = 0;
    await app.uncheck("#usePreviews");
    const s = await started(app, key);
    assert.ok(Math.abs(s.at - before) < 0.5 && !s.paused, `went on at ${s.at} (was at ${before})`);
    assert.match(await srcOf(app, key), /&src=original$/);
    assert.ok(reads.length >= 1 && reads.every((u) => /&src=original$/.test(u)), `previews off: ${reads.join(", ")}`);
    assert.equal(await app.textContent("#playingSource"), "▶ original");
    await app.$eval(`tr[data-key="${key}"] audio`, (au) => au.pause());
    // The others take it when they next load; and it's kept in this browser.
    reads.length = 0;
    await app.locator(`tr[data-key="${other}"]`).scrollIntoViewIfNeeded();
    await rest(other);
    assert.ok(reads.length >= 1 && reads.every((u) => /&src=original$/.test(u)), `another player: ${reads.join(", ")}`);
    await app.reload();
    await app.waitForSelector("#usePreviews", { state: "attached" });
    assert.equal(await app.isChecked("#usePreviews"), false, "kept");
  } finally {
    await app.evaluate(() => localStorage.removeItem("bc_use_previews")).catch(() => {});
    await app.evaluate(() => document.querySelectorAll("audio").forEach((au) => au.pause())).catch(() => {});
    await app.close();
  }
});

test("local app: a preview made while a track plays never changes what its player streams (a seek far on still plays); players made after use it", async () => {
  const app = await context.newPage();
  const double = streamDouble();
  let built = false;
  await slowLocalStreams(app, { preview: () => built, stream: double.handler });
  const mine = (key) => double.log.filter((r) => r.path === `/e2e/not-a-real-folder/${key}.wav`);
  try {
    await app.goto(SERVER + "/");
    const [key, other] = await localPlayers(app);
    assert.match(await srcOf(app, key), /&src=original$/, "no preview yet: the original, previews on or not");
    await app.locator(`tr[data-key="${key}"]`).scrollIntoViewIfNeeded();
    await clickBar(app, key, 0.05);
    await playingPast(app, key, 31);
    const player = await app.$(`tr[data-key="${key}"] audio`);
    // The first play has the server make the preview; the page hears of it (here: shown again, so it reloads).
    double.built = built = true;
    await setHidden(app, true);
    await setHidden(app, false);
    await app.waitForFunction((k) => /&src=preview$/.test(document.querySelector(`tr[data-key="${k}"] audio`).getAttribute("src")), other, { timeout: 10000 });
    assert.match(await srcOf(app, key), /&src=original$/, "the one playing keeps its source");
    // A seek far past the preview's size: asked again, of the original; still playing.
    const asked = mine(key).length;
    await clickBar(app, key, 0.9);
    await playingPast(app, key, 541);
    const t = await player.evaluate((au) => au.currentTime);
    await sleep(600);
    assert.ok((await player.evaluate((au) => au.currentTime)) > t + 0.3, "and goes on");
    assert.ok(await player.evaluate((au, k) => au.isConnected && au.closest("tr").dataset.key === k, key), "the same player");
    const after = mine(key).slice(asked);
    assert.ok(after.some((r) => r.from > 0.8 * double.size), `the seek asked the server: ${JSON.stringify(after)}`);
    assert.deepEqual(mine(key).filter((r) => r.src !== "original"), [], "only ever the original");
    assert.deepEqual(double.log.filter((r) => r.status === 416), [], "no 416");
    assert.equal(await app.textContent("#playingSource"), "▶ original");
  } finally {
    await app.evaluate(() => document.querySelectorAll("audio").forEach((au) => au.pause())).catch(() => {});
    await app.close();
  }
});

test("local app: a preview the server no longer has (404) plays on from the original, at the same moment", async () => {
  const app = await context.newPage();
  const double = streamDouble();
  double.built = true;
  await slowLocalStreams(app, { preview: true, stream: double.handler });
  try {
    await app.goto(SERVER + "/");
    const [key] = await localPlayers(app);
    assert.match(await srcOf(app, key), /&src=preview$/);
    await app.locator(`tr[data-key="${key}"]`).scrollIntoViewIfNeeded();
    await clickBar(app, key, 0.05);
    await playingPast(app, key, 31);
    assert.equal(await app.textContent("#playingSource"), "▶ preview");
    // Evicted meanwhile: the seek's request gets a 404.
    double.gone = true;
    await clickBar(app, key, 0.6);
    await app.waitForFunction((k) => /&src=original$/.test(document.querySelector(`tr[data-key="${k}"] audio`).getAttribute("src")), key, { timeout: 15000 });
    await playingPast(app, key, 359);
    const at = await app.$eval(`tr[data-key="${key}"] audio`, (au) => au.currentTime);
    assert.ok(at < 366, `from the same moment: ${at}`);
    assert.ok(double.log.some((r) => r.src === "preview" && r.status === 404), "the preview was asked for, and gone");
    assert.equal(await app.textContent("#playingSource"), "▶ original");
    assert.equal(await app.$(`tr[data-key="${key}"] iframe`), null, "not the Bandcamp player");
  } finally {
    await app.evaluate(() => document.querySelectorAll("audio").forEach((au) => au.pause())).catch(() => {});
    await app.close();
  }
});

test("local app: with the music drive unplugged, a file with nothing else to play says so (↻ tries again, and plays once it's back); a Bandcamp item plays Bandcamp's stream", async () => {
  const app = await context.newPage();
  const ids = await slowLocalStreams(app, { other: 1, stream: (route) => route.fallback() });
  const drive = await unpluggedDrive(app, "/e2e/not-a-real-folder");
  const cell = (key) => `tr[data-key="${key}"] td.player-cell`;
  try {
    await app.goto(SERVER + "/");
    const keys = await localPlayers(app);
    const [otherKey] = ids.other;
    assert.ok(keys.includes(otherKey), "the other-source item has a local player");
    const bcKey = keys.find((k) => k !== otherKey);
    // Another source: nothing else to play, so it says why (no spinner, no Bandcamp player).
    await app.locator(`tr[data-key="${otherKey}"]`).scrollIntoViewIfNeeded();
    await clickBar(app, otherKey, 0.3);
    await app.waitForSelector(`${cell(otherKey)} .player-unavailable`, { timeout: 10000 });
    assert.equal(await app.textContent(`${cell(otherKey)} .pu-text`), "File not available (drive not connected)");
    assert.equal(await app.$(`${cell(otherKey)} iframe`), null);
    assert.equal(await app.$(`${cell(otherKey)} .row-player`), null);
    if (process.env.E2E_SHOTS) await app.locator(cell(otherKey)).screenshot({ path: path.join(process.env.E2E_SHOTS, "player-unavailable.png") });
    // A click on the cell tries again: still unplugged, the same.
    const asked = drive.streams;
    await app.locator(`${cell(otherKey)} .pu-text`).click();
    await waitFor(() => drive.streams > asked, { what: "the file asked for again", timeout: 10000 });
    await app.waitForSelector(`${cell(otherKey)} .player-unavailable`, { timeout: 10000 });
    // A Bandcamp item: Bandcamp's stream instead, and the cell says why.
    await app.locator(`tr[data-key="${bcKey}"]`).scrollIntoViewIfNeeded();
    await clickBar(app, bcKey, 0.3);
    await app.waitForFunction((sel) => {
      const c = document.querySelector(sel);
      return c && !c.querySelector("audio.local-audio") && /drive not connected/.test(c.title);
    }, cell(bcKey), { timeout: 10000 });
    assert.equal(await app.getAttribute(cell(bcKey), "title"), "File not available (drive not connected): playing Bandcamp's stream.");
    assert.equal(await app.$(`${cell(bcKey)} .player-unavailable`), null);
    await app.waitForFunction(() => document.getElementById("playingSource").textContent === "▶ Bandcamp stream", null, { timeout: 10000 });
    await app.evaluate(() => document.querySelectorAll("audio").forEach((au) => au.pause()));
    // The drive is back: ↻ plays the file.
    drive.plugged = true;
    await app.locator(`tr[data-key="${otherKey}"]`).scrollIntoViewIfNeeded();
    await app.click(`${cell(otherKey)} .pu-retry`);
    await app.waitForFunction((sel) => {
      const au = document.querySelector(sel + " audio.local-audio");
      return au && !au.paused && au.currentTime > 0.2;
    }, cell(otherKey), { timeout: 10000 });
    assert.equal(await app.$(`${cell(otherKey)} .player-unavailable`), null);
    assert.equal(await app.getAttribute(cell(otherKey), "title"), null);
  } finally {
    await app.evaluate(() => document.querySelectorAll("audio").forEach((au) => au.pause())).catch(() => {});
    await app.close();
  }
});

test("players: one volume and mute for all (the speaker, its slider, ↑/↓ on the bar), kept across a reload", async () => {
  const app = await context.newPage();
  await slowLocalStreams(app, { delayMs: 0 });
  const audioOf = (key) => app.$eval(`tr[data-key="${key}"] audio`, (au) => ({ volume: au.volume, muted: au.muted }));
  try {
    await app.goto(SERVER + "/");
    const [key, other] = await localPlayers(app);
    await app.locator(`tr[data-key="${key}"]`).scrollIntoViewIfNeeded();
    // The slider shows while the pointer is on the speaker.
    assert.equal(await app.isVisible(`tr[data-key="${key}"] .rp-volume`), false);
    await app.hover(`tr[data-key="${key}"] .rp-speaker`);
    await app.waitForSelector(`tr[data-key="${key}"] .rp-volume`, { state: "visible" });
    if (process.env.E2E_SHOTS) await app.locator(`tr[data-key="${key}"] td.player-cell`).screenshot({ path: path.join(process.env.E2E_SHOTS, "row-player-volume.png") });
    await app.$eval(`tr[data-key="${key}"] .rp-volume`, (r) => {
      r.value = "0.3";
      r.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.deepEqual(await audioOf(key), { volume: 0.3, muted: false });
    assert.deepEqual(await audioOf(other), { volume: 0.3, muted: false }, "every player");
    // Playing, it applies at once; the speaker mutes.
    await clickBar(app, key, 0.1);
    await app.waitForFunction((k) => !document.querySelector(`tr[data-key="${k}"] audio`).paused, key);
    await app.click(`tr[data-key="${key}"] .rp-speaker`);
    assert.deepEqual(await audioOf(key), { volume: 0.3, muted: true });
    await app.click(`tr[data-key="${key}"] .rp-speaker`);
    assert.equal((await audioOf(key)).muted, false);
    // ↓ on the bar.
    await app.focus(`tr[data-key="${key}"] .rp-bar`);
    await app.keyboard.press("ArrowDown");
    assert.ok(Math.abs((await audioOf(key)).volume - 0.2) < 0.001);
    await app.click(`tr[data-key="${key}"] .rp-speaker`); // muted, at 0.2
    await app.$eval(`tr[data-key="${key}"] audio`, (au) => au.pause());
    // Kept in this browser.
    await app.reload();
    const [k2] = await localPlayers(app);
    const after = await app.$eval(`tr[data-key="${k2}"] audio`, (au) => ({ volume: Math.round(au.volume * 100) / 100, muted: au.muted }));
    assert.deepEqual(after, { volume: 0.2, muted: true });
  } finally {
    await app.evaluate(() => ["bc_player_volume", "bc_player_muted"].forEach((k) => localStorage.removeItem(k))).catch(() => {});
    await app.evaluate(() => document.querySelectorAll("audio").forEach((au) => au.pause())).catch(() => {});
    await app.close();
  }
});

test("local app: a second click on the bar before the file is loaded replaces the first; once loaded, a click seeks and plays at once", async () => {
  const app = await context.newPage();
  await slowLocalStreams(app);
  try {
    await app.goto(SERVER + "/");
    const [key, other] = await localPlayers(app);
    await app.locator(`tr[data-key="${key}"]`).scrollIntoViewIfNeeded();
    await watchStart(app, key);
    await clickBar(app, key, 0.6);
    await clickBar(app, key, 0.2);
    const s = await started(app, key);
    assert.ok(s.at > 0.1 * s.d && s.at < 0.35 * s.d && !s.paused, `started at ${s.at} of ${s.d}`);
    await app.$eval(`tr[data-key="${key}"] audio`, (au) => au.pause());
    // Loaded: a click seeks and plays right away.
    await clickBar(app, key, 0.7);
    const now = await app.$eval(`tr[data-key="${key}"] audio`, (au) => ({ t: au.currentTime, d: au.duration, paused: au.paused }));
    assert.ok(Math.abs(now.t - 0.7 * now.d) < 0.2 && !now.paused, JSON.stringify(now));
    // One player at a time: another row's bar takes over.
    await app.locator(`tr[data-key="${other}"]`).scrollIntoViewIfNeeded();
    await clickBar(app, other, 0.5);
    await app.waitForFunction(
      ([a, b]) => {
        const [x, y] = [a, b].map((k) => document.querySelector(`tr[data-key="${k}"] audio`));
        return x.paused && !y.paused && y.readyState >= 3 && y.currentTime > 0; // playing for real (the stream is slow)
      },
      [key, other],
      { timeout: 15000 }
    );
    // The play button and the keyboard (space, arrows) on the bar.
    await app.click(`tr[data-key="${other}"] .rp-play`);
    assert.equal(await app.$eval(`tr[data-key="${other}"] audio`, (au) => au.paused), true, "the button pauses");
    await app.focus(`tr[data-key="${other}"] .rp-bar`);
    const before = await app.$eval(`tr[data-key="${other}"] audio`, (au) => au.currentTime);
    await app.keyboard.press("ArrowLeft");
    assert.ok((await app.$eval(`tr[data-key="${other}"] audio`, (au) => au.currentTime)) < before, "← goes back");
    await app.keyboard.press(" ");
    assert.equal(await app.$eval(`tr[data-key="${other}"] audio`, (au) => au.paused), false, "space plays");
  } finally {
    await app.evaluate(() => document.querySelectorAll("audio").forEach((au) => au.pause())).catch(() => {});
    await app.close();
  }
});

test("local app: passing over players reads nothing; resting on one reads its metadata once", async () => {
  const app = await context.newPage();
  const reads = await slowLocalStreams(app, { delayMs: 0 });
  try {
    await app.goto(SERVER + "/");
    const players = await localPlayers(app);
    await app.locator(`tr[data-key="${players[0]}"]`).scrollIntoViewIfNeeded();
    const centers = [];
    for (const k of players) {
      const b = await app.locator(`tr[data-key="${k}"] .row-player`).boundingBox();
      if (b && b.y > 0 && b.y + b.height < 720) centers.push([b.x + b.width / 2, b.y + b.height / 2]);
    }
    assert.ok(centers.length >= 3, `players in view: ${centers.length}`);
    // Across the rows, over each player in passing.
    for (const [x, y] of centers) await app.mouse.move(x, y, { steps: 2 });
    await app.mouse.move(5, 5);
    await app.waitForTimeout(400);
    assert.deepEqual(reads, [], "passing over read nothing");
    // Resting on one: its metadata, once (a head start for the bar).
    const key = players[0];
    const box = await app.locator(`tr[data-key="${key}"] .row-player`).boundingBox();
    await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await app.waitForFunction((k) => document.querySelector(`tr[data-key="${k}"] audio`).readyState >= 1, key, { timeout: 10000 });
    await app.waitForTimeout(300);
    assert.equal(reads.length, 1, `one request: ${reads.join(", ")}`);
    assert.ok(reads[0].includes(encodeURIComponent(`/e2e/not-a-real-folder/${key}.wav`)));
    assert.equal(await app.$eval(`tr[data-key="${key}"] audio`, (au) => au.paused), true, "not playing");
    assert.match(await app.textContent(`tr[data-key="${key}"] .rp-time`), /^0:00 \/ 0:03$/);
  } finally {
    await app.close();
  }
});

test("local app: rows without stored art don't fetch their Bandcamp page on scroll (Tools → Refresh thumbnails does)", async () => {
  const app = await context.newPage();
  // No row has stored art.
  await app.route("**/api/items", async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    (Array.isArray(data) ? data : data.items).forEach((i) => {
      delete i.art_url;
      delete i.art_id;
    });
    await route.fulfill({ response: res, json: data });
  });
  // Bandcamp pages are fetched through the extension: record the page's requests to it.
  await app.addInitScript(() => {
    window.__ops = [];
    const post = window.postMessage.bind(window);
    window.postMessage = (m, ...rest) => {
      if (m && m.bcTagger === "request") window.__ops.push(m.op);
      return post(m, ...rest);
    };
  });
  try {
    await app.goto(SERVER + "/");
    await app.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key]").length > 0);
    // Rendered again with the extension connected, then scrolled through.
    await app.click("#collectionTable th.col-title");
    await app.mouse.wheel(0, 3000);
    await app.waitForTimeout(400);
    await app.mouse.wheel(0, 3000);
    await app.waitForTimeout(800);
    assert.ok(await app.$("#collectionTable td.col-thumb .no-thumb"), "rows show the placeholder");
    assert.deepEqual((await app.evaluate(() => window.__ops)).filter((op) => op === "fetchPage"), []);
  } finally {
    await app.close();
  }
});

// Typing in a tag editor while its row is reloaded (the user's bug: the next letters vanished, the chips jumped
// into tag-list order, and the wrong tag got picked). Picks `first` (it sorts before a chip the row has) by typing
// it and Enter, types `second` at once, waits for the reload that the pick sets off (`reloaded`: its response):
// the chips keep the order shown, the text is still there, and Enter picks `second`. After leaving the field, the
// order is settled: a later reload doesn't move the chips.
async function typeThroughReload(page, key, first, second, reloaded) {
  const sel = `tr[data-key="${key}"]`;
  const chips = () => page.$$eval(`${sel} .chosen-choices li.search-choice`, (lis) => lis.map((li) => li.textContent.trim()));
  const before = await chips();
  await page.click(`${sel} .chosen-choices .search-field input`);
  await page.keyboard.type(first, { delay: 20 });
  await page.keyboard.press("Enter");
  const shown = [...before, first]; // chosen adds a pick at the end
  assert.deepEqual(await chips(), shown);
  const reload = page.waitForResponse(reloaded, { timeout: 20000 });
  await page.keyboard.type(second, { delay: 20 });
  await reload;
  await page.waitForTimeout(700); // the reload applied (debounced)
  assert.deepEqual(await chips(), shown, "the chips keep their order while typing");
  assert.equal(await page.inputValue(`${sel} .chosen-choices .search-field input`), second, "the typed text survives the reload");
  assert.equal((await page.textContent(`${sel} .chosen-results li.highlighted`)).trim(), second, "and its tag is highlighted");
  const reload2 = page.waitForResponse(reloaded, { timeout: 20000 });
  await page.keyboard.press("Enter");
  const tags = await page.$eval(`${sel} select.tag-editor`, (s) => [...s.selectedOptions].map((o) => o.value));
  assert.ok(tags.includes(first) && tags.includes(second), `both picked: ${tags}`);
  // Leave the field: whatever waited runs once, then nothing moves.
  await page.keyboard.press("Escape");
  await page.click("#searchInput");
  await page.waitForTimeout(400);
  // (A re-render that waited for the field to be left builds the row's editor anew, when it's in view.)
  await page.locator(sel).scrollIntoViewIfNeeded(); // it may have moved (a re-sort)
  await page.waitForFunction(([s, n]) => document.querySelectorAll(`${s} .chosen-choices li.search-choice`).length === n, [sel, tags.length]);
  const settled = await chips();
  assert.deepEqual(settled.slice().sort(), tags.slice().sort(), "the chips are the tags");
  await reload2;
  await page.waitForTimeout(700);
  assert.deepEqual(await chips(), settled, "settled: a later reload doesn't move the chips");
  return tags;
}

// Tags typing can pick (each the only tag containing its name, so typing it highlights it).
const typable = (vocab) => vocab.filter((t) => /^[a-z][a-z0-9-]*$/.test(t) && vocab.every((u) => u === t || !u.includes(t)));

// Two typable tags the row doesn't have, the first before one of its tags in tag-list order; null if none.
function twoTagsFor(vocab, has) {
  const last = Math.max(-1, ...has.map((t) => vocab.indexOf(t)));
  const free = typable(vocab).filter((t) => !has.includes(t));
  const first = free.find((t) => vocab.indexOf(t) < last);
  const second = free.find((t) => t !== first);
  return first && second ? [first, second] : null;
}

test("collection: a tag editor keeps the text being typed (and picks what's typed) while its row is reloaded", async () => {
  const app = await context.newPage();
  let key = null;
  let before = null;
  try {
    await app.goto(SERVER + "/");
    await app.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
    await app.waitForSelector("#collectionTable tbody tr[data-key] select.tag-editor", { state: "attached" });
    // A row with a tag that a typable one sorts before.
    const vocab = await api("/api/tags");
    const rows = await app.$$eval("#collectionTable tbody tr[data-key] select.tag-editor", (sels) =>
      sels.map((s) => [s.closest("tr").dataset.key, [...s.selectedOptions].map((o) => o.value)])
    );
    const found = rows.find(([, has]) => twoTagsFor(vocab, has));
    assert.ok(found, "a row to type in");
    key = found[0];
    before = (await api(`/api/items/${key}`)).tags;
    const [first, second] = twoTagsFor(vocab, found[1]);
    // The pick goes to the extension, which pushes to the server; its item event reloads the items.
    await typeThroughReload(app, key, first, second, (r) => r.url() === SERVER + "/api/items" && r.request().method() === "GET");
    await waitFor(() => api(`/api/items/${key}`).then((it) => it.tags.includes(second)), { what: "both tags saved" });
  } finally {
    if (key && before) {
      // Put the row's tags back (through the editor, like the user).
      await app.keyboard.press("Escape").catch(() => {});
      await app.click("#searchInput").catch(() => {});
      await app.evaluate(([k, t]) => $(`tr[data-key="${k}"] select.tag-editor`).val(t).trigger("change"), [key, before]).catch(() => {});
      await waitFor(() => api(`/api/items/${key}`).then((it) => JSON.stringify(it.tags) === JSON.stringify(before)), { what: "the tags restored" }).catch(() => {});
    }
    await app.close();
  }
});

test("chosen's sprite (a chip's x, the arrow, the search icon) loads on every app page", async () => {
  const page = await context.newPage();
  try {
    for (const url of ["/", "/settings/#rekordbox", "/import/"]) {
      await page.goto(SERVER + url);
      await page.waitForLoadState("load");
      // A chip's close button, as chosen draws it.
      const res = await page.evaluate(async () => {
        const probe = document.createElement("div");
        probe.className = "chosen-container chosen-container-multi";
        probe.innerHTML = '<ul class="chosen-choices"><li class="search-choice"><span>x</span><a class="search-choice-close"></a></li></ul>';
        document.body.appendChild(probe);
        const bg = getComputedStyle(probe.querySelector(".search-choice-close")).backgroundImage;
        probe.remove();
        const m = bg.match(/url\("?([^")]+)"?\)/);
        return { bg, status: m ? (await fetch(m[1])).status : null };
      });
      assert.equal(res.status, 200, `${url}: ${res.bg}`);
    }
  } finally {
    await page.close();
  }
});

test("extension page: a single click on a player's bar before its stream is loaded (slow) plays from there", async () => {
  const a = "t1002746421"; // Futuro Lontano (durable stream link: a player from the start)
  const page = await context.newPage();
  let src = null;
  const isSrc = (u) => u.href === src;
  const slow = slowWav(silentWav(3), 1500);
  try {
    await page.goto(extPage("collection.html"));
    await page.waitForSelector(`tr[data-key="${a}"] .row-player`);
    src = await page.getAttribute(`tr[data-key="${a}"] audio`, "src");
    await context.route(isSrc, slow); // before the fixture route (the latest route answers first)
    await page.locator(`tr[data-key="${a}"]`).scrollIntoViewIfNeeded();
    await watchStart(page, a);
    await clickBar(page, a, 0.6);
    assert.equal(await page.$eval(`tr[data-key="${a}"] audio`, (au) => au.readyState), 0, "clicked before the metadata");
    const s = await started(page, a);
    assert.ok(s.at > 0.5 * s.d && !s.paused, `started at ${s.at} of ${s.d}`);
  } finally {
    if (src) await context.unroute(isSrc, slow);
    await page.evaluate(() => document.querySelectorAll("audio").forEach((au) => au.pause())).catch(() => {});
    await page.close();
  }
});

test("rows: click / Shift / Cmd highlight; a tick on a highlighted row ticks them all, untick unticks them all; only the player column plays (collection, extension page, import preview)", async () => {
  const hl = (page) => page.$$eval("#collectionTable tr.row-highlight", (trs) => trs.map((t) => t.dataset.key));
  const ticked = (page) => page.$$eval("#collectionTable .row-check:checked", (b) => b.map((x) => x.closest("tr").dataset.key));
  const nothingPlays = (page) => page.evaluate(() => [...document.querySelectorAll("audio")].every((a) => a.paused));
  const app = await context.newPage();
  const ext = await context.newPage();
  const stub = importStub(JSON.parse(fs.readFileSync(IMPORT_SAMPLE, "utf8")));
  const preview = await context.newPage();
  try {
    // Right after an import the items are still getting their "#" (each re-sorts the table): start after.
    await waitFor(
      () => api("/api/items").then((d) => (Array.isArray(d) ? d : d.items).every((i) => i.source === "other" || Number.isFinite(i.order))),
      { what: "every item numbered on the server", timeout: 30000 }
    );
    await app.goto(SERVER + "/");
    await app.evaluate(() => localStorage.removeItem("bc_app_selection"));
    await app.reload();
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 6);
    const keys = await app.$$eval("#collectionTable tbody tr", (r) => r.slice(0, 6).map((x) => x.dataset.key));
    const row = (k) => app.locator(`tr[data-key="${k}"]`);
    await row(keys[0]).locator(".col-date").click();
    assert.deepEqual(await hl(app), [keys[0]], "a click highlights one row");
    await row(keys[2]).locator(".col-date").click({ modifiers: ["Shift"] });
    assert.deepEqual(await hl(app), keys.slice(0, 3), "Shift extends a range");
    await row(keys[4]).locator(".col-date").click({ modifiers: ["Meta"] });
    assert.deepEqual(await hl(app), [...keys.slice(0, 3), keys[4]], "Cmd adds one");
    // The controls keep their behaviour: the tag editor doesn't change the highlight.
    await row(keys[0]).locator("td.tags-cell").click();
    assert.deepEqual(await hl(app), [...keys.slice(0, 3), keys[4]]);
    // A tick on a highlighted row ticks them all; unticking unticks them all.
    await app.check(`tr[data-key="${keys[1]}"] .row-check`);
    assert.deepEqual((await ticked(app)).sort(), [...keys.slice(0, 3), keys[4]].sort());
    assert.equal(await app.textContent("#clearSelection"), "Clear selection (4)");
    await app.uncheck(`tr[data-key="${keys[1]}"] .row-check`);
    assert.deepEqual(await ticked(app), []);
    // A row that isn't highlighted: only it. Shift on a checkbox: the range from the last one clicked.
    await app.check(`tr[data-key="${keys[5]}"] .row-check`);
    assert.deepEqual(await ticked(app), [keys[5]]);
    await app.click(`tr[data-key="${keys[3]}"] .row-check`, { modifiers: ["Shift"] });
    assert.deepEqual((await ticked(app)).sort(), keys.slice(3, 6).sort());
    await app.click("#clearSelection");
    // Located's empty space highlights and doesn't play.
    const located = row(keys[5]).locator("td.col-located");
    const lb = await located.boundingBox();
    await located.click({ position: { x: lb.width - 4, y: lb.height - 4 } });
    assert.deepEqual(await hl(app), [keys[5]]);
    assert.equal(await nothingPlays(app), true);

    // The extension page: artist and title don't play; the player column's empty space does.
    const a = "t1002746421"; // Futuro Lontano (an <audio> from the start)
    await ext.goto(extPage("collection.html"));
    await ext.waitForSelector(`tr[data-key="${a}"] audio`, { state: "attached" });
    await ext.locator(`tr[data-key="${a}"]`).scrollIntoViewIfNeeded();
    await ext.click(`tr[data-key="${a}"] .artist-name`);
    assert.deepEqual(await hl(ext), [a]);
    assert.equal(await nothingPlays(ext), true, "the artist doesn't play");
    await ext.$eval(`tr[data-key="${a}"] audio`, (au) => (au.loop = true));
    await playerSpace(ext.locator(`tr[data-key="${a}"]`));
    await ext.waitForFunction(() => [...document.querySelectorAll("audio")].some((au) => !au.paused), null, { timeout: 10000 });
    assert.deepEqual(await hl(ext), [a], "playing doesn't change the highlight");
    await ext.evaluate(() => document.querySelectorAll("audio").forEach((au) => au.pause()));

    // The import preview: a tick on a highlighted row ticks them all (saved to the batch).
    await stub.install(preview);
    await preview.goto(SERVER + "/import/?batch=e2e-b1");
    await preview.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key]").length === 7);
    await preview.locator("tr[data-key='r0'] .col-artist").click();
    await preview.locator("tr[data-key='r2'] .col-artist").click({ modifiers: ["Shift"] });
    assert.deepEqual(await hl(preview), ["r0", "r1", "r2"]);
    const before = await ticked(preview);
    await preview.click("tr[data-key='r1'] .row-check"); // they start ticked: untick all three
    await preview.waitForFunction(() => ["r0", "r1", "r2"].every((k) => !document.querySelector(`tr[data-key="${k}"] .row-check`).checked));
    assert.deepEqual((await ticked(preview)).sort(), before.filter((k) => !["r0", "r1", "r2"].includes(k)).sort());
    await waitFor(() => [0, 1, 2].every((n) => stub.rows[n].checked === false), { what: "the three rows saved unticked" });
  } finally {
    await app.evaluate(() => localStorage.removeItem("bc_app_selection")).catch(() => {});
    await Promise.all([app.close(), ext.close(), preview.close()]);
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
    await playerSpace(rowA);
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
    await playerSpace(rowB);
    await page.waitForTimeout(300);
    await rowA.scrollIntoViewIfNeeded();
    await playerSpace(rowA);
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

test("Settings → Downloads: Parallel downloads (4) and Download timeout (180 s) round-trip; out of range is refused", async () => {
  const page = await context.newPage();
  try {
    await page.goto(SERVER + "/settings/");
    await page.waitForSelector("#f_download_parallel");
    assert.equal(await page.inputValue("#f_download_parallel"), "4");
    assert.equal(await page.inputValue("#f_download_timeout_s"), "180");
    await page.fill("#f_download_parallel", "2");
    await page.fill("#f_download_timeout_s", "240");
    await page.click("#saveBtn");
    await page.waitForFunction(() => /Saved/.test(document.getElementById("saveState").textContent));
    let s = await settingsNow();
    assert.deepEqual([s.download_parallel, s.download_timeout_s], [2, 240]);
    await page.fill("#f_download_parallel", "9");
    await page.click("#saveBtn");
    await page.waitForFunction(() => /Not saved/.test(document.getElementById("saveState").textContent));
    s = await settingsNow();
    assert.equal(s.download_parallel, 2, "unchanged");
  } finally {
    await put({ download_parallel: 4, download_timeout_s: 180 });
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
  await page.waitForFunction(() => /Not saved/.test(document.getElementById("saveState").textContent));
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
    await page.waitForFunction(() => document.querySelector("tr[data-key='r1'] .located-cell .chip").dataset.status === "located-manual");
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
    const locatedSel = await locatedOf(keys);
    assert.equal(await app.textContent("#exportShown"), `Export selected to RB (${locatedSel})…`, "the located ones");
    assert.equal(await app.textContent("#exportHint"), skippedHint(2 - locatedSel));
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
      ...Object.fromEntries(
        releases.map((r) => [r.id, release(r, { tracks: r.tracks || ["One", "Two"], ...(r.retry_error ? { retry_error: r.retry_error, retry_wait: r.retry_wait } : {}) })])
      ),
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

test("Download owned missing: releases download together, each row with its own percent; a retry shows its reason in its row and the status line", async () => {
  const A = { id: "a2027456636", artist: "TÉNÈBRE", title: "WNCL041" };
  const B = { id: "a2153449172", artist: "INSTINCT", title: "Interplanetary Criminal", retry_error: "java.net.SocketTimeoutException: Read timed out", retry_wait: 1 };
  const restore = await downloadSetup({ releases: [A, B], owned: [A.id, B.id] });
  const app = await context.newPage();
  try {
    await app.goto(SERVER + "/");
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 0);
    for (const r of [A, B]) {
      await app.fill("#searchInput", r.title);
      await app.waitForFunction((id) => document.querySelector(`tr[data-key="${id}"]`), r.id);
      await app.check(`tr[data-key="${r.id}"] .row-check`);
    }
    await app.fill("#searchInput", "");
    await app.waitForFunction(([a, b]) => document.querySelector(`tr[data-key="${a}"]`) && document.querySelector(`tr[data-key="${b}"]`), [A.id, B.id]);
    // Neither is located yet: Export Selected counts none, and says so.
    assert.equal(await app.textContent("#exportShown"), "Export selected to RB (0)…");
    assert.equal(await app.textContent("#exportHint"), "2 not located are skipped");
    // Everything each row and the status line show while it runs.
    await app.evaluate(([a, b]) => {
      const seen = (window.__seen = { [a]: [], [b]: [], status: [], warn: [] });
      const note = (list, t) => t && !list.includes(t) && list.push(t);
      new MutationObserver(() => {
        [a, b].forEach((id) => {
          const cell = document.querySelector(`tr[data-key="${id}"] .col-located`);
          if (!cell) return;
          note(seen[id], cell.textContent);
          if (cell.querySelector(".warn-note")) note(seen.warn, id);
        });
        note(seen.status, document.getElementById("refreshStatus").textContent);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }, [A.id, B.id]);
    await app.click("#downloadOwnedMissing");
    await app.waitForFunction(() => /^Download: 2 of 2 releases downloaded/.test(document.getElementById("refreshStatus").textContent), null, { timeout: 60000 });
    const seen = await app.evaluate(() => window.__seen);
    const has = (list, re) => list.some((t) => re.test(t));
    assert.ok(has(seen[A.id], /downloading \d+ %/), `A's percent: ${JSON.stringify(seen[A.id])}`);
    assert.ok(has(seen[B.id], /retry 1\/3: read timed out/), `B's retry: ${JSON.stringify(seen[B.id])}`);
    assert.deepEqual(seen.warn, [B.id], "only the retrying row is amber");
    assert.ok(has(seen.status, /retry 1\/3: read timed out/), `status: ${JSON.stringify(seen.status)}`);
    for (const r of [A, B]) {
      await waitFor(() => api(`/api/items/${r.id}`).then((it) => it.local && it.local.status === "located"), { what: `${r.title} located` });
    }
    // Located now: the count follows, live.
    await app.waitForFunction(() => document.getElementById("exportShown").textContent === "Export selected to RB (2)…");
    assert.equal(await app.textContent("#exportHint"), "");
  } finally {
    await restore();
    await app.close();
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

test("import preview: its players stream the preview or the original like the collection's (a missing preview plays the original from the click; the toggle swaps a playing one) (stubbed API)", async () => {
  const stub = importStub(JSON.parse(fs.readFileSync(IMPORT_SAMPLE, "utf8")), { located: [1, 2] });
  const [withPreview, without] = [1, 2].map((line) => stub.rows.find((r) => r.line === line));
  withPreview.located.best.preview = true;
  const double = streamDouble(); // the preview isn't there: 404
  const page = await context.newPage();
  await stub.install(page);
  await page.route("**/api/files/stream**", double.handler);
  const [a, b] = [`r${withPreview.n}`, `r${without.n}`];
  const now = () => page.$eval(`tr[data-key="${a}"] audio`, (au) => au.currentTime);
  try {
    await page.goto(SERVER + "/import/?batch=e2e-b1");
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key] audio.local-audio").length === 2);
    assert.match(await srcOf(page, a), /&src=preview$/);
    assert.match(await srcOf(page, b), /&src=original$/);
    // A click at half: the preview 404s, so the original, from the click.
    await clickBar(page, a, 0.5);
    await playingPast(page, a, 299);
    assert.match(await srcOf(page, a), /&src=original$/);
    assert.ok((await now()) < 306, `from the click: ${await now()}`);
    assert.equal(await page.textContent("#playingSource"), "▶ original");
    // The preview is made meanwhile: only the toggle changes a playing player's source (off: nothing to change;
    // on again: the preview, from the same moment).
    double.built = true;
    await page.uncheck("#usePreviews");
    assert.match(await srcOf(page, a), /&src=original$/);
    const before = await now();
    await page.check("#usePreviews");
    assert.match(await srcOf(page, a), /&src=preview$/);
    await playingPast(page, a, before);
    assert.ok((await now()) - before < 2, `went on at ${await now()} (was at ${before})`);
    assert.equal(await page.textContent("#playingSource"), "▶ preview");
    assert.match(await srcOf(page, b), /&src=original$/, "no preview flag: the original");
    assert.deepEqual(double.log.filter((r) => r.status === 416), []);
  } finally {
    await page.evaluate(() => localStorage.removeItem("bc_use_previews")).catch(() => {});
    await page.evaluate(() => document.querySelectorAll("audio").forEach((au) => au.pause())).catch(() => {});
    await page.close();
  }
});

test("import preview: with the music drive unplugged, an unmatched row's file says it isn't available (stubbed API)", async () => {
  const stub = importStub(JSON.parse(fs.readFileSync(IMPORT_SAMPLE, "utf8")), { located: [3] });
  const row = stub.rows.find((r) => r.line === 3);
  assert.equal(row.source, "other", "unmatched: no Bandcamp player");
  const page = await context.newPage();
  await stub.install(page);
  const drive = await unpluggedDrive(page, "/e2e");
  const key = `r${row.n}`;
  try {
    await page.goto(SERVER + "/import/?batch=e2e-b1");
    await page.waitForSelector(`tr[data-key="${key}"] audio.local-audio`, { state: "attached" });
    await clickBar(page, key, 0.5);
    await page.waitForSelector(`tr[data-key="${key}"] .player-unavailable`, { timeout: 10000 });
    assert.equal(await page.textContent(`tr[data-key="${key}"] .pu-text`), "File not available (drive not connected)");
    assert.equal(await page.$(`tr[data-key="${key}"] iframe`), null);
    drive.plugged = true;
    await page.click(`tr[data-key="${key}"] .pu-retry`);
    await page.waitForFunction((k) => {
      const au = document.querySelector(`tr[data-key="${k}"] audio.local-audio`);
      return au && !au.paused && au.currentTime > 0.2;
    }, key, { timeout: 10000 });
  } finally {
    await page.evaluate(() => document.querySelectorAll("audio").forEach((au) => au.pause())).catch(() => {});
    await page.close();
  }
});

// An import file of `n` plain rows (no match, no tags of their own), for the stub.
const bigImport = (n) => ({
  source: "big-import.txt",
  unknown_tags: {},
  items: Array.from({ length: n }, (_, i) => {
    const title = `Track ${String(i).padStart(3, "0")}`;
    return { line: i + 1, raw: `Artist ${i} - ${title}`, artist: `Artist ${i}`, title, tags: [] };
  }),
});
const tickedRows = (page) => page.$$eval("#collectionTable tbody .row-check", (bs) => bs.filter((b) => b.checked).length);
const saveStateIs = (page, text, timeout = 15000) =>
  page.waitForFunction((t) => document.getElementById("saveState").textContent === t, text, { timeout });

test("import preview: Select all on 300 rows, then a reload at once, keeps all 300 ticked (a slow server without the bulk form): it asks before leaving, and saves the rest after (stubbed API)", async () => {
  const stub = importStub(bigImport(300), { bulk: false, saveDelayMs: 100 });
  stub.rows.forEach((r) => (r.checked = false));
  const page = await context.newPage();
  await stub.install(page);
  const all300 = () => page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key]").length === 300);
  try {
    await page.goto(SERVER + "/import/?batch=e2e-b1");
    await all300();
    assert.equal(await tickedRows(page), 0);
    await page.click("#selectAll");
    assert.match(await page.textContent("#saveState"), /^Saving… \(\d+ rows\)$/);
    await sleep(300);
    assert.ok(stub.saves.maxSaving > 1 && stub.saves.maxSaving <= 6, `one row at a time, 6 at once: ${stub.saves.maxSaving}`);
    let dialog = null;
    page.once("dialog", (d) => {
      dialog = d.type();
      d.accept().catch(() => {});
    });
    await page.reload();
    assert.equal(dialog, "beforeunload", "leaving with ticks not saved asks first");
    assert.ok(stub.rows.filter((r) => r.checked).length < 100, "most weren't on the server when the page went");
    await all300();
    assert.equal(await tickedRows(page), 300, "all ticked again at once");
    await saveStateIs(page, "Saved", 30000);
    assert.equal(stub.rows.filter((r) => r.checked).length, 300, "all saved on the server");
    assert.equal(await page.evaluate(() => localStorage.getItem("bc_import_pending:e2e-b1")), null, "nothing left to send");
    // From the server alone, and nothing to ask about.
    page.once("dialog", (d) => {
      dialog = "again: " + d.type();
      d.accept().catch(() => {});
    });
    await page.reload();
    await all300();
    assert.equal(await tickedRows(page), 300);
    assert.equal(dialog, "beforeunload");
  } finally {
    await page.evaluate(() => localStorage.removeItem("bc_import_pending:e2e-b1")).catch(() => {});
    await page.close();
  }
});

test("import preview: a tick on many rows is one request (the bulk form); a save that fails is tried again, and says so (stubbed API)", async () => {
  const stub = importStub(bigImport(40));
  stub.rows.forEach((r) => (r.checked = false));
  const page = await context.newPage();
  await stub.install(page);
  const saves = () => stub.calls.filter((c) => c.method === "PUT" && /\/rows(\/\d+)?$/.test(c.path));
  try {
    await page.goto(SERVER + "/import/?batch=e2e-b1");
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key]").length === 40);
    await page.click("#selectAll");
    await saveStateIs(page, "Saved");
    assert.equal(saves().length, 1, "one request");
    assert.deepEqual(saves()[0].body, { ns: stub.rows.map((r) => r.n), changes: { checked: true } });
    assert.equal(stub.rows.filter((r) => r.checked).length, 40);
    // The server fails twice: it says so, tries again, and saves.
    stub.saves.failing = 2;
    await page.click(`tr[data-key="r3"] .row-check`);
    await page.waitForFunction(
      () => /^Not saved yet \(the server is busy \(e2e\)\): 1 row, trying again in \d+ s\. Try now$/.test(document.getElementById("saveState").textContent),
      null,
      { timeout: 10000 }
    );
    if (process.env.E2E_SHOTS) await page.locator("#saveState").screenshot({ path: path.join(process.env.E2E_SHOTS, "save-retrying.png") });
    assert.equal(stub.rows[3].checked, true, "not saved yet");
    await saveStateIs(page, "Saved");
    assert.equal(stub.rows[3].checked, false);
    assert.equal(stub.saves.failing, 0, "tried again after each failure");
  } finally {
    await page.evaluate(() => localStorage.removeItem("bc_import_pending:e2e-b1")).catch(() => {});
    await page.close();
  }
});

test("import preview: back on a batch, the view is as it was left: Show, the sort, how far down (stubbed API)", async () => {
  const stub = importStub(bigImport(300), { located: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  const page = await context.newPage();
  await stub.install(page);
  const shown = () => page.$$eval("#collectionTable tbody tr[data-key]", (rs) => rs.length);
  try {
    await page.goto(SERVER + "/import/?batch=e2e-b1");
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key]").length === 300);
    await page.selectOption("#importShow", "missing");
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key]").length === 290);
    await page.click("#collectionTable thead th.col-title");
    await page.click("#collectionTable thead th.col-title"); // descending
    await page.evaluate(() => window.scrollTo(0, 3000));
    await sleep(400);
    await page.goto(SERVER + "/");
    await page.waitForSelector("#collectionTable tbody tr[data-key]");
    await page.goto(SERVER + "/import/?batch=e2e-b1");
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key]").length === 290);
    assert.equal(await page.inputValue("#importShow"), "missing");
    assert.equal(await page.textContent("#collectionTable thead th.col-title .sort-arrow"), " ▼");
    assert.equal(await shown(), 290);
    assert.equal(await page.textContent("#collectionTable tbody tr[data-key] .col-title"), "Track 299");
    const y = await page.evaluate(() => window.scrollY);
    assert.ok(Math.abs(y - 3000) < 60, `scrolled back to ${y}`);
  } finally {
    await page.evaluate(() => localStorage.removeItem("bc_import_view:e2e-b1")).catch(() => {});
    await page.close();
  }
});

test("import: a reload during lookups follows the same job on to the mapping step (stubbed API)", async () => {
  // The job runs until the test lets it finish: the tab and the header's pill both poll it.
  const stub = importStub(JSON.parse(fs.readFileSync(IMPORT_SAMPLE, "utf8")), { holdJob: true });
  const page = await context.newPage();
  await stub.install(page);
  await page.goto(SERVER + "/settings/#import");
  // The open batch is still looking up: the tab follows it (nothing is started).
  await page.waitForFunction(() => /Looking up rows on Bandcamp/.test((document.getElementById("importProgress") || {}).textContent));
  assert.match(page.url(), /#import\/e2e-b1$/);
  await page.waitForFunction(() => /^Import: /.test((document.getElementById("navImport") || {}).textContent));
  await page.reload();
  await page.waitForFunction(() => /Looking up rows on Bandcamp/.test((document.getElementById("importProgress") || {}).textContent));
  // Followed again after the reload: now let the job finish.
  stub.finishJob();
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
    // r2's tag editor is built as its row comes into view (a frame later): wait for it.
    await page.waitForFunction(() => {
      const sel = document.querySelector("tr[data-key='r2'] select.tag-editor");
      return sel && JSON.stringify([...sel.selectedOptions].map((o) => o.value)) === JSON.stringify(["must", "pool"]);
    });

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
  await tool(page, "fixAlbumIds");
  await page.waitForFunction(() => /^Album IDs: stopped by Bandcamp's bot check/.test(document.getElementById("refreshStatus").textContent));
  assert.match(await page.textContent("#bcChallenge"), /Client Challenge/);
  assert.match(await page.getAttribute("#bcChallenge a", "href"), /^https:\/\/e2e-challenge\.bandcamp\.com\/track\/challenged-/);
  // The two track pages may already be in flight together; nothing after the
  // challenge (no embedded-player fallback, no retry).
  assert.ok(seen.length >= 1 && seen.length <= 2, `fetched: ${seen.join(", ")}`);
  assert.ok(seen.every((u) => /e2e-challenge/.test(u)), `fetched after the challenge: ${seen.join(", ")}`);
  const items = (await storage("taggedItems")).taggedItems;
  ids.forEach((id) => assert.equal(items[id].album_checked, undefined, "a challenged item isn't marked checked"));
  await tool(page, "refreshThumbs").catch(() => {});
  await page.waitForTimeout(500);
  assert.ok(seen.every((u) => /e2e-challenge/.test(u)) && seen.length <= 2, "no fetches after the challenge");
  await probe.evaluate((ids) => Promise.all(ids.map((id) => chrome.runtime.sendMessage({ type: "removeTaggedItem", id }))), ids);
  await page.close();
});

test("bot check: Refresh ownership reports it; the next one clears it", async () => {
  const SUMMARY = "https://bandcamp.com/api/fan/2/collection_summary";
  const challenge = (route) => route.fulfill({ status: 200, contentType: "text/html", body: CHALLENGE_HTML });
  await context.route(SUMMARY, challenge);
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
  await tool(app, "refreshOwnership");
  await app.waitForFunction(() => /failed|error/i.test(document.getElementById("refreshStatus").textContent), null, { timeout: 30000 });
  assert.match(await app.textContent("#refreshStatus"), /bot check/);
  const status = await probe.evaluate(() => chrome.storage.session.get("bcSyncStatus").then((s) => s.bcSyncStatus));
  assert.equal(status.ownership.challenge, true);
  // The user's own refresh clears it once Bandcamp answers again.
  await context.unroute(SUMMARY, challenge);
  await tool(app, "refreshOwnership");
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
  // Transfer to rekordbox counts the ticked rows that are located; the rest are said to be skipped.
  const nowRows = (await api(`/api/import/${batchId}`)).rows.filter((r) => r.checked);
  const locatedTicked = nowRows.filter((r) => r.located && r.located.status === "located").length;
  assert.ok(locatedTicked > 0 && locatedTicked < nowRows.length, `a mix: ${locatedTicked} of ${nowRows.length}`);
  await page.waitForFunction((n) => document.getElementById("transferToRekordbox").textContent === `Transfer to rekordbox (${n})…`, locatedTicked);
  assert.equal(await page.textContent("#transferHint"), skippedHint(nowRows.length - locatedTicked));
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
  // Located as the server says, also for the items the extension added after the page opened (user bug: "–").
  const serverLocal = await api(`/api/items?ids=${chosen.join(",")}`).then((d) => (Array.isArray(d) ? d : d.items));
  const locatedIds = serverLocal.filter((i) => i.local && i.local.status === "located").map((i) => i.id);
  assert.ok(locatedIds.length > 0, "some imported rows are located");
  try {
    await page.waitForFunction(
      (ids) => ids.every((id) => (document.querySelector(`tr[data-key="${id}"] .col-located .chip`) || {}).textContent?.startsWith("✓")),
      locatedIds,
      { timeout: 15000 }
    );
  } catch (e) {
    const shown = await page.$$eval("#collectionTable tbody tr", (trs, ids) => trs.filter((tr) => ids.includes(tr.dataset.key)).map((tr) => [tr.dataset.key, (tr.querySelector(".col-located") || {}).textContent]), locatedIds);
    throw new Error(`located on the server, not on the page: ${JSON.stringify(shown.filter(([, t]) => !/^✓/.test(t)))}`);
  }
  const checked = await page.$$eval("#collectionTable .row-check:checked", (b) => b.map((x) => x.closest("tr").dataset.key));
  assert.deepEqual(checked.slice().sort(), chosen.slice().sort());
  assert.match(await page.textContent("th.col-modified"), /▼/);
  const top = await page.$$eval("#collectionTable tbody tr", (trs, n) => trs.slice(0, n).map((tr) => tr.dataset.key), chosen.length);
  assert.deepEqual(top.slice().sort(), chosen.slice().sort(), "the imported items come first");
  assert.match(await page.textContent("#refreshStatus"), new RegExp(`The ${chosen.length} imported and merged items are selected`));
  const locatedChosen = await locatedOf(chosen);
  assert.equal(await page.textContent("#exportShown"), `Export selected to RB (${locatedChosen})…`);
  assert.equal(await page.textContent("#exportHint"), skippedHint(chosen.length - locatedChosen));

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
    if p.suffix == ".flac":
        write_flac(p, f.get("title"), f.get("artist"), f.get("album"), f.get("track"))
    else:
        write_aiff(p, f.get("title"), f.get("artist"), f.get("album"), f.get("track"), f.get("seconds", 0.1))
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
    await page.waitForFunction(() => /Import failed: .*not mounted/.test((document.getElementById("importProgress") || {}).textContent));
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
    // A tag the rows use that isn't in the tag list yet: "Create New Tags" at the top.
    const NEW_TAG = "e2e-new-tag";
    const firstRow = (await api(`/api/import/${batchId}`)).rows.find((r) => r.title === "First");
    await api(`/api/import/${batchId}/rows/${firstRow.n}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: [...firstRow.tags, NEW_TAG] }),
    });
    await page.reload();
    await page.waitForSelector("#newTagsBar:not([hidden]) #createNewTags");
    await shot("files-new-tags.png", ".import-info");
    assert.match(await page.textContent("#newTagsBar"), new RegExp(`isn't in your tag list yet: ${NEW_TAG}\\.`));
    assert.equal(await page.evaluate(() => document.querySelector(".import-info").firstElementChild.nextElementSibling.id), "newTagsBar", "at the top");
    // Transfer to rekordbox: the ticked rows, a dry run first (cancelled here: nothing written, nothing added).
    // It doesn't wait for the new tag: the dialog says where each tag goes, the new one pointed out.
    const exportPosts = [];
    page.on("request", (r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/rekordbox/export" && exportPosts.push(r.postDataJSON()));
    assert.equal(await page.textContent("#transferToRekordbox"), "Transfer to rekordbox (3)…");
    assert.equal(await page.textContent("#transferHint"), "", "all located");
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
    assert.ok(await page.$(".confirm-dialog .tag-playlists"), "tag → playlists in the dialog");
    assert.match(await page.textContent(".confirm-dialog h3"), /^Transfer 3 rows to rekordbox \(not added to your collection here\)\?$/);
    await shot("files-transfer-dialog.png");
    assert.match(await page.textContent(".confirm-dialog .tag-playlists"), new RegExp(`${NEW_TAG} \\(new tag\\) → `));
    assert.match(await page.getAttribute(".confirm-dialog .map-tags-link", "href"), new RegExp(`^/settings/#rekordbox/tags%3D.*${NEW_TAG}`));
    await page.click(".confirm-dialog .dialog-cancel");
    await page.waitForFunction(() => /^Transfer to rekordbox: (done|error)/.test(document.getElementById("refreshStatus").textContent));
    assert.equal(exportPosts.length, 1, "only the dry run");
    // Create New Tags: in the tag list now; then a link to map it, which Settings opens with the tag pointed out.
    await page.click("#createNewTags");
    await page.waitForFunction((t) => document.getElementById("newTagsBar").textContent.startsWith(`Created: ${t}.`), NEW_TAG);
    assert.ok((await api("/api/tags")).includes(NEW_TAG));
    const mapUrl = await page.getAttribute("#mapNewTags", "href");
    const settings = await context.newPage();
    await settings.goto(SERVER + mapUrl);
    await settings.waitForSelector(".mapping-focus-note:not([hidden])");
    assert.match(await settings.textContent(".mapping-focus-note"), new RegExp(`New tags: ${NEW_TAG}\\.`));
    assert.equal(await settings.isVisible("#sec_rb_playlists"), true, "the Rekordbox tab");
    await settings.close();
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
    // The collection shows them located, as the server says (user bug: "–" after an import).
    const createdIds = created.map((i) => i.id);
    // Located on the server by the commit (the rows' files), then on the page without a reload.
    await waitFor(
      () => api(`/api/items?ids=${createdIds.join(",")}`).then((d) => (Array.isArray(d) ? d : d.items).every((i) => i.local && i.local.status === "located")),
      { what: "the new items located on the server", timeout: 15000 }
    );
    try {
      await page.waitForFunction(
        (ids) => ids.every((id) => (document.querySelector(`tr[data-key="${id}"] .col-located .chip`) || {}).textContent?.startsWith("✓")),
        createdIds,
        { timeout: 15000 }
      );
    } catch (e) {
      const shown = await page.$$eval("#collectionTable tbody tr", (trs, ids) => trs.filter((tr) => ids.includes(tr.dataset.key)).map((tr) => [tr.dataset.key, (tr.querySelector(".col-located") || {}).textContent]), createdIds);
      throw new Error(`located on the server, not on the page: ${JSON.stringify(shown)}`);
    }
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

// New tags (not in the vocabulary) in an import: kept on the rows, offered to every row,
// highlighted, and created when the rows are imported.
test("import preview: a row's new tag is never dropped (edits, reloads), other rows can add it, it's highlighted, and Import selected creates it", async () => {
  const NEW = "e2e-fresh";
  const items = [
    { line: 1, raw: "TSVI - Futuro Lontano", artist: "TSVI", title: "Futuro Lontano", existing_id: "t1002746421", tags: ["must", NEW] },
    { line: 2, raw: "E2E Nobody - Lonely Thing", artist: "E2E Nobody", title: "Lonely Thing", tags: ["must"] },
  ];
  const file = { format: "bc-tagger-import/1", source: "e2e-newtags.txt", unknown_tags: { [NEW]: [] }, items };
  const { batch_id: batchId } = await post("/api/import", { file, default_tags: [], name: "e2e-newtags" });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  const rowTags = (n) => api(`/api/import/${batchId}`).then((b) => b.rows.find((r) => r.n === n).tags);
  const editorTags = (key) => page.$eval(`tr[data-key='${key}'] select.tag-editor`, (s) => [...s.selectedOptions].map((o) => o.value));
  const editorReady = (key) => page.waitForSelector(`tr[data-key='${key}'] select.tag-editor`, { state: "attached" });
  try {
    await waitFor(() => api(`/api/import/${batchId}`).then((b) => b.status === "ready"), { what: "the batch", timeout: 30000 });
    await post(`/api/import/${batchId}/tags`, { map: {}, unmapped: "create" });
    assert.deepEqual(await rowTags(0), ["must", NEW]);
    await page.goto(`${SERVER}/import/?batch=${batchId}`);
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key]").length === 2);
    await editorReady("r0");
    assert.deepEqual(await editorTags("r0"), ["must", NEW], "shown");
    // Editing another tag keeps it.
    await page.evaluate(() => $("tr[data-key='r0'] select.tag-editor").val([...$("tr[data-key='r0'] select.tag-editor").val(), "pool"]).trigger("change"));
    await waitFor(async () => (await rowTags(0)).includes("pool"), { what: "the edit saved" });
    assert.deepEqual((await rowTags(0)).sort(), ["must", NEW, "pool"].sort(), "kept on save");
    // A reload keeps it.
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key]").length === 2);
    await editorReady("r0");
    assert.deepEqual((await editorTags("r0")).sort(), ["must", NEW, "pool"].sort(), "kept after a reload");
    // Highlighted: its chip and its option.
    await page.waitForFunction((t) => [...document.querySelectorAll("tr[data-key='r0'] li.search-choice.new-tag")].some((li) => li.textContent.trim() === t), NEW);
    assert.equal(await page.$eval(`tr[data-key='r0'] select.tag-editor option[value="${NEW}"]`, (o) => o.classList.contains("new-tag")), true);
    assert.equal(await page.$eval("tr[data-key='r0'] select.tag-editor option[value='pool']", (o) => o.classList.contains("new-tag")), false);
    assert.equal(
      await page.$eval("tr[data-key='r0'] li.search-choice.new-tag", (li) => li.title),
      "new: not in your tag list yet"
    );
    // The bar above is as before (Create New Tags).
    assert.match(await page.textContent("#newTagsBar"), new RegExp(`isn't in your tag list yet: ${NEW}\\.`));
    // Another row can add it like any tag.
    await editorReady("r1");
    assert.equal(await page.$eval(`tr[data-key='r1'] select.tag-editor option[value="${NEW}"]`, (o) => o.classList.contains("new-tag")), true, "offered");
    await page.evaluate((t) => $("tr[data-key='r1'] select.tag-editor").val(["must", t]).trigger("change"), NEW);
    await waitFor(async () => (await rowTags(1)).includes(NEW), { what: "added to the other row" });
    // Import selected creates it: in the vocabulary, on the merged item and on the new Other item.
    assert.ok(!(await api("/api/tags")).includes(NEW), "not created yet");
    await page.click("#importSelected");
    await page.waitForURL(SERVER + "/", { timeout: 30000 });
    await waitFor(async () => (await api("/api/tags")).includes(NEW), { what: "the tag in the vocabulary" });
    await waitFor(() => api("/api/items/t1002746421").then((it) => it.tags.includes(NEW)), { what: "the merged item carrying it" });
    const other = (await api("/api/items?source=other").then((d) => (Array.isArray(d) ? d : d.items))).find((i) => i.title === "Lonely Thing");
    assert.ok(other && other.tags.includes(NEW), JSON.stringify(other && other.tags));
    await waitFor(async () => (await storage("tags")).tags.includes(NEW), { what: "the tag in the extension" });
  } finally {
    await api(`/api/import/${batchId}`, { method: "DELETE" }).catch(() => {});
    await page.close();
  }
});

test("import preview: a tag editor keeps the text being typed (and picks what's typed) while its row is reloaded", async () => {
  // The row's tag is the last typable one, so the picks sort before it.
  const vocab = await api("/api/tags");
  const late = typable(vocab).at(-1);
  const items = [{ line: 1, raw: "E2E Typist - Fast Fingers", artist: "E2E Typist", title: "Fast Fingers", tags: [late] }];
  const file = { format: "bc-tagger-import/1", source: "e2e-typing.txt", unknown_tags: {}, items };
  const { batch_id: batchId } = await post("/api/import", { file, default_tags: [], name: "e2e-typing" });
  const page = await context.newPage();
  try {
    await waitFor(() => api(`/api/import/${batchId}`).then((b) => b.status === "ready"), { what: "the batch", timeout: 30000 });
    await post(`/api/import/${batchId}/tags`, { map: {}, unmapped: "create" });
    await page.goto(`${SERVER}/import/?batch=${batchId}`);
    await page.waitForSelector("tr[data-key='r0'] select.tag-editor", { state: "attached" });
    const [first, second] = twoTagsFor(vocab, [late]);
    // The pick is saved to the batch; its import event reloads the rows.
    await typeThroughReload(page, "r0", first, second, (r) => r.url().endsWith(`/api/import/${batchId}`) && r.request().method() === "GET");
    await waitFor(
      () => api(`/api/import/${batchId}`).then((b) => b.rows[0].tags.includes(first) && b.rows[0].tags.includes(second)),
      { what: "both tags saved" }
    );
  } finally {
    await api(`/api/import/${batchId}`, { method: "DELETE" }).catch(() => {});
    await page.close();
  }
});

test("Transfer to rekordbox: a re-transfer adds nothing; another file of the same song is listed and not added, unless \"Add them anyway\" (sandbox test library)", async (t) => {
  const template = process.env.E2E_TEMPLATE_DB || path.join(process.env.HOME, "Library/Pioneer/rekordbox_test/master.db");
  if (!fs.existsSync(template)) {
    t.skip(`no template DB at ${template}`);
    return;
  }
  const base = path.join(E2E, "same-song");
  fs.rmSync(base, { recursive: true, force: true });
  const coll = path.join(base, "Collection");
  const complete = path.join(base, "complete");
  // 3 s: rekordbox keeps whole seconds, and an unknown (0) length never counts as the same song.
  const song = { title: "Same Song", artist: "E2E Same Artist", track: 1, days: 1, seconds: 3 };
  const fileA = path.join(coll, "E2E Same Artist - Same EP", "01 Same Song.aiff");
  const fileB = path.join(complete, "E2E Same Artist - Same EP (copy)", "01 Same Song.aiff");
  writeFixtureFiles([
    { ...song, path: fileA, album: "Same EP" },
    { ...song, path: fileB, album: "Same EP" },
  ]);
  // A writable test library of our own (a copy of the template, with the test marker).
  const db = execFileSync(PYTHON, [path.join(ROOT, "server", "scripts", "make_sandbox_library.py"), path.join(base, "rekordbox"), "--test-marker"], {
    env: { ...process.env, BCT_TEST_TEMPLATE_DB: template },
  })
    .toString()
    .trim();
  const PLAYLIST = "/E2E Same Song";
  const before = await api("/api/settings").then((d) => d.settings || d);
  await put({
    owned_root: coll,
    not_owned_roots: [{ path: complete, globs: [] }],
    downloads_dir: "",
    rekordbox_db_path: db,
    rekordbox_target: "test",
    tag_playlist_mode: "custom",
    tag_playlist_map: { pool: [PLAYLIST] },
  });
  const inPlaylist = async () => ((await api("/api/rekordbox/playlists")).find((p) => p.path === PLAYLIST) || {}).count || 0;
  const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  const filesBatch = async (folder, name) => {
    const { batch_id } = await post("/api/import/files", { folders: [{ path: folder, since: weekAgo }], default_tags: ["pool"], default_tags_all: true, name });
    await waitFor(() => api(`/api/import/${batch_id}`).then((b) => b.status === "ready" && b.rows.length === 1), { what: `the batch ${name}`, timeout: 30000 });
    return batch_id;
  };
  const page = await context.newPage();
  const batches = [];
  const transfer = async () => {
    await page.click("#transferToRekordbox");
    await page.waitForFunction(
      () => document.getElementById("exportConfirm") || /^Transfer to rekordbox: (done|failed)/.test(document.getElementById("refreshStatus").textContent),
      null,
      { timeout: 60000 }
    );
    return !!(await page.$("#exportConfirm"));
  };
  const transferred = () =>
    page.waitForFunction(() => /^Transfer to rekordbox: (done|failed)/.test(document.getElementById("refreshStatus").textContent), null, { timeout: 60000 });
  try {
    // The song's first file goes in.
    batches.push(await filesBatch(coll, "e2e-same-1"));
    await page.goto(`${SERVER}/import/?batch=${batches[0]}`);
    await page.waitForSelector("#collectionTable tbody tr[data-key]");
    assert.equal(await transfer(), true, "a dry run to confirm");
    assert.equal(await page.$("#exportConfirm .same-song"), null);
    await page.click("#exportConfirm .dialog-confirm");
    await transferred();
    assert.match(await page.textContent("#refreshStatus"), /^Transfer to rekordbox: done/);
    assert.equal(await inPlaylist(), 1);

    // The same again: nothing to add.
    assert.equal(await transfer(), false, "no dialog");
    assert.match(await page.textContent("#refreshStatus"), /already up to date/);
    assert.equal(await inPlaylist(), 1);

    // Another file of the same song: listed (both files), and not added.
    batches.push(await filesBatch(complete, "e2e-same-2"));
    await page.goto(`${SERVER}/import/?batch=${batches[1]}`);
    await page.waitForSelector("#collectionTable tbody tr[data-key]");
    assert.equal(await transfer(), true, "the dialog lists it");
    const listed = await page.textContent("#exportConfirm .same-song");
    assert.match(listed, /Already in the playlist as another file \(1\)/);
    assert.match(listed, /E2E Same Song[\s\S]*Same Song: already in playlist \(other file\)/);
    assert.ok(listed.includes(`this file: ${fileB}`) && listed.includes(`in the playlist: ${fileA}`), listed);
    assert.equal(await page.isDisabled("#exportConfirm .dialog-confirm"), true, "nothing to add");
    assert.equal(await page.isChecked("#addSameSong"), false, "off by default");
    const shot = (name) => process.env.E2E_SHOTS && page.locator("#exportConfirm").screenshot({ path: path.join(process.env.E2E_SHOTS, name) });
    await shot("same-song-dialog.png");
    // "Add them anyway": the dry run again, now adding it.
    const dryRuns = [];
    const onPost = (r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/rekordbox/export" && dryRuns.push(r.postDataJSON());
    page.on("request", onPost);
    await page.check("#addSameSong");
    await page.waitForFunction(() => !document.querySelector("#exportConfirm .dialog-confirm").disabled, null, { timeout: 60000 });
    assert.equal(await page.$("#exportConfirm .same-song"), null, "nothing left out");
    assert.match(await page.textContent("#exportConfirm"), /E2E Same Song: \+1/);
    await shot("same-song-dialog-add-anyway.png");
    await page.click("#exportConfirm .dialog-confirm");
    await transferred();
    page.off("request", onPost);
    assert.deepEqual(dryRuns.map((b) => [!!b.dry_run, b.add_same_song]), [[true, true], [false, true]], "the dry run and the write both add it");
    assert.match(await page.textContent("#refreshStatus"), /^Transfer to rekordbox: done/);
    assert.equal(await inPlaylist(), 2);
  } finally {
    for (const b of batches) await api(`/api/import/${b}`, { method: "DELETE" }).catch(() => {});
    await put({
      owned_root: before.owned_root,
      not_owned_roots: before.not_owned_roots,
      downloads_dir: before.downloads_dir,
      rekordbox_db_path: before.rekordbox_db_path,
      rekordbox_target: "test",
      tag_playlist_mode: "auto",
      tag_playlist_map: {},
    });
    await page.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("collection: the toolbar is everyday actions (test ones in Settings → Test); the selection survives Settings and back and a reload; Select last import selects the last import's items", async () => {
  const app = await context.newPage();
  const checked = () => app.$$eval("#collectionTable .row-check:checked", (b) => b.map((x) => x.closest("tr").dataset.key).sort());
  const batchIds = [];
  await storageFirst(app, { remove: ["bc_app_collection"] }); // All
  try {
    await app.goto(SERVER + "/");
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 2);
    // The collections at the top: All, then "Collection".
    await app.waitForSelector("#collectionsBar:not([hidden])");
    const options = await app.$$eval("#collectionSelect option", (os) => os.map((o) => o.textContent));
    assert.match(options[0], /^All \(\d+\)$/);
    assert.match(options[1], /^Collection \(\d+\)$/);
    assert.equal(await app.inputValue("#collectionSelect"), "all");
    // The toolbar: selection actions, the drive, Tools ▾, Columns ▾; no test buttons.
    const bar = await app.$$eval("#toolbar button", (bs) => bs.map((b) => b.id));
    assert.deepEqual(bar.slice(0, 7), [
      "locateShown", "exportShown", "downloadOwnedMissing", "selectLastImport", "clearSelection", "removeFromCollection", "rescanDrive",
    ]);
    assert.equal(await app.isHidden("#removeFromCollection"), true, "not in All");
    assert.ok(bar.includes("toolsMenuBtn") && bar.includes("columnsChooser"));
    assert.ok(!bar.includes("locateLatest") && !bar.includes("exportLatest"), "no test buttons");
    assert.ok(await app.$("#toolsMenu #refreshOwnership"), "Refresh ownership is in Tools");

    // A selection survives going to Settings and back, and a reload.
    await app.evaluate(() => localStorage.removeItem("bc_app_selection"));
    await app.reload();
    await app.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr").length > 2);
    const keys = (await app.$$eval("#collectionTable tbody tr", (r) => r.slice(0, 3).map((x) => x.dataset.key))).sort();
    for (const k of keys) await app.check(`tr[data-key="${k}"] .row-check`);
    assert.equal(await app.textContent("#clearSelection"), "Clear selection (3)");
    await app.click("#navLink_settings");
    await app.waitForSelector("#tabs");
    // The test buttons are in Settings → Test.
    await app.click("#tab_test");
    assert.ok((await app.isVisible("#locateLatest")) && (await app.isVisible("#exportLatest")));
    await app.click("#navLink_collection");
    await app.waitForFunction((n) => document.querySelectorAll("#collectionTable .row-check:checked").length === n, keys.length);
    assert.deepEqual(await checked(), keys, "kept across pages");
    assert.equal(await app.textContent("#clearSelection"), "Clear selection (3)");
    await app.reload();
    await app.waitForFunction((n) => document.querySelectorAll("#collectionTable .row-check:checked").length === n, keys.length);
    assert.deepEqual(await checked(), keys, "kept across a reload");

    // Select last import: exactly the last committed import's items, newest Modified first.
    // (Its own small import: two rows merged into collection items.)
    const items = [
      { line: 1, raw: "TSVI - Futuro Lontano", artist: "TSVI", title: "Futuro Lontano", existing_id: "t1002746421", tags: ["must"] },
      { line: 2, raw: "x - y", artist: exportData.taggedItems[ITEM].artist, title: exportData.taggedItems[ITEM].title, existing_id: ITEM, tags: ["must"] },
    ];
    const { batch_id: lastBatch } = await post("/api/import", { file: { format: "bc-tagger-import/1", source: "e2e-last.txt", items }, default_tags: [], name: "e2e-last" });
    batchIds.push(lastBatch);
    await waitFor(() => api(`/api/import/${lastBatch}`).then((b) => b.status === "ready"), { what: "the batch", timeout: 30000 });
    await post(`/api/import/${lastBatch}/commit`, {});
    await waitFor(() => api("/api/import/last-committed").then((l) => l.batch_id === lastBatch), { what: "the commit", timeout: 30000 });
    const last = await api("/api/import/last-committed");
    assert.deepEqual(last.item_ids.slice().sort(), ["t1002746421", ITEM].sort());
    await app.click("#selectLastImport");
    const want = last.item_ids.slice().sort();
    await app.waitForFunction((n) => document.querySelectorAll("#collectionTable .row-check:checked").length === n, want.length);
    assert.deepEqual(await checked(), want);
    assert.match(await app.textContent("th.col-modified"), /▼/);
    assert.match(await app.textContent("#refreshStatus"), new RegExp(`^Selected the ${want.length} items of the last import`));
    await app.click("#clearSelection");
    assert.deepEqual(await checked(), []);
  } finally {
    await app.evaluate(() => localStorage.removeItem("bc_app_selection")).catch(() => {});
    for (const id of batchIds) await api(`/api/import/${id}`, { method: "DELETE" }).catch(() => {});
    await app.close();
  }
});

// --- Previews: Build previews (Tools ▾) and Settings → Previews ----------------------

const GB = 1024 ** 3;
const MB = 1024 ** 2;
// This browser's kept state for the app (localStorage), set before the page's own scripts read it, on its first
// load only (its reloads keep what the page did). Written after a load instead, it races the page's start-up,
// which saves what it read.
const storageFirst = (page, { set = {}, remove = [] } = {}) =>
  page.addInitScript(
    ([set, remove]) => {
      if (sessionStorage.getItem("e2e-storage-first")) return;
      sessionStorage.setItem("e2e-storage-first", "1");
      remove.forEach((k) => localStorage.removeItem(k));
      Object.entries(set).forEach(([k, v]) => localStorage.setItem(k, v));
    },
    [set, remove]
  );
// The collection's kept selection and filters (and an import's hand-over): without them a bulk button acts on all of it.
const COLLECTION_STATE = ["bc_app_selection", "bc_app_status_filter", "bc_app_source_filter", "bc_after_import"];

test("Build previews (Tools ▾): the dry run asks first (what's left out, and why); then its progress (built/total, MB/s, ETA, file) and Cancel; the summary lists the errors (stubbed build)", async () => {
  const plan = {
    files: 130, native: 6, already: 4, missing: 0, needed: 120, planned: 100, left_out: 20,
    needed_bytes: 480 * MB, planned_bytes: 400 * MB, left_out_bytes: 80 * MB, source_bytes: 14.4 * GB, audio_hours: 8.3,
    fits_cap: false, fits_space: true, cap_bytes: 3.5 * GB, used_bytes: 3.1 * GB, free_bytes: 120 * GB, min_free_bytes: 2 * GB,
    kbps: 96, parallel: 6,
  };
  const running = {
    id: "e2e-previews-1", kind: "previews", status: "running",
    progress: {
      current: 40, total: 100, message: "previews 40/100", built: 38, failed: 2, skipped: 0, bytes_read: 6 * GB, bytes_total: 14.4 * GB,
      read_mb_s: 112.4, eta_s: 95, current_file: "/Volumes/E2E/Music/Artist - EP/03 Track.aiff", encoding: 6, queued: 3, elapsed_s: 53,
    },
  };
  const errors = [
    { path: "/Volumes/E2E/Music/Bad - One/01 Bad One.aiff", status: "failed", reason: "ffmpeg: Invalid data found when processing input" },
    { path: "/Volumes/E2E/Music/Bad - Two/01 Bad Two.aiff", status: "failed", reason: "not an AIFF file" },
  ];
  const done = {
    ...running, status: "done",
    result: { ...plan, built: 41, failed: 2, skipped: 0, cancelled: true, not_built: 57, dropped: 0, stopped: null, errors, bytes_read: 6.6 * GB, read_mb_s: 110, elapsed_s: 61 },
  };
  const app = await context.newPage();
  const bodies = [];
  let cancelled = false;
  await app.route("**/api/previews/build", (route) => {
    const body = JSON.parse(route.request().postData());
    bodies.push(body);
    return route.fulfill({ json: body.dry_run ? { plan } : { job_id: "e2e-previews-1", plan } });
  });
  await app.route("**/api/previews/build/e2e-previews-1/cancel", (route) => {
    cancelled = true;
    return route.fulfill({ json: { job_id: "e2e-previews-1", cancelled: true } });
  });
  await app.route("**/api/jobs/e2e-previews-1", (route) => route.fulfill({ json: cancelled ? done : running }));
  const status = () => app.textContent("#refreshStatus");
  try {
    await storageFirst(app, { remove: COLLECTION_STATE });
    await app.goto(SERVER + "/");
    await app.waitForSelector("#collectionTable tbody tr[data-key]");
    const n = await app.$$eval("#collectionTable tbody tr[data-key]", (rs) => rs.length);
    await tool(app, "buildPreviews");
    await app.waitForSelector("#previewBuildConfirm");
    assert.deepEqual(bodies[0], { all: true, dry_run: true }, "nothing selected or filtered: the whole collection");
    assert.equal(await app.textContent("#previewBuildConfirm h3"), "Build 100 previews?");
    const text = await app.textContent("#previewBuildConfirm .dialog-body");
    assert.match(text, new RegExp(`^Of all ${n} items: 120 tracks need a preview; 4 tracks already have one; 6 tracks play as they are \\(MP3, FLAC, WAV…\\)\\.`));
    assert.match(text, /100 of them fit; 20 tracks \(about 80 MB\) are left out: the space for previews is full \(raise it in Settings → Previews\)\./);
    assert.match(text, /About 400 MB of the 3\.5 GB for previews \(3\.1 GB used now; 120 GB free on this Mac\)\. Opus at 96 kbps\./);
    assert.match(text, /Time: about 2 min, to read 14 GB from the music drive at about 120 MB\/s \(6 encoders at once\)\. An estimate: the drive's speed decides\./);
    assert.match(text, /The music drive must stay connected until it's done\./);
    if (process.env.E2E_SHOTS) await app.locator("#previewBuildConfirm").screenshot({ path: path.join(process.env.E2E_SHOTS, "preview-build-confirm-left-out.png") });
    await app.click("#previewBuildConfirm .dialog-confirm");
    // Its progress, with Cancel.
    await app.waitForFunction(() => /^Build previews: 38\/100 built/.test(document.getElementById("refreshStatus").textContent), null, { timeout: 10000 });
    assert.equal(await status(), "Build previews: 38/100 built · 2 failed · 112 MB/s · ETA 1:35 · 03 Track.aiff Cancel");
    assert.deepEqual(bodies[1], { all: true });
    assert.equal(await app.isDisabled("#buildPreviews"), true, "one build at a time");
    if (process.env.E2E_SHOTS) await app.locator("#refreshStatus").screenshot({ path: path.join(process.env.E2E_SHOTS, "preview-build-progress.png") });
    await app.click("#cancelPreviewBuild");
    assert.equal(await app.textContent("#cancelPreviewBuild"), "Cancelling…");
    await app.waitForFunction(() => /cancelled/.test(document.getElementById("refreshStatus").textContent), null, { timeout: 10000 });
    assert.ok(cancelled);
    assert.equal(await app.$$eval("#refreshStatus .preview-progress, #cancelPreviewBuild", (es) => es.length), 0, "no progress or Cancel left");
    assert.match(await status(), /^Build previews: 41 built, 2 failed, 0 skipped · cancelled \(57 not built\) · in 1:01 at 110 MB\/s 2 errors/);
    await app.click("#refreshStatus .preview-errors summary");
    assert.deepEqual(await app.$$eval("#refreshStatus .preview-errors li", (ls) => ls.map((l) => l.textContent)), [
      "01 Bad One.aiff: ffmpeg: Invalid data found when processing input",
      "01 Bad Two.aiff: not an AIFF file",
    ]);
    assert.equal(await app.isDisabled("#buildPreviews"), false);
  } finally {
    await app.close();
  }
});

test("Build previews on the e2e server (3 AIFFs and a FLAC): the dialog's numbers, the build, the rows' next players play src=preview; Settings → Previews: a lower cap drops some at once, Clear previews the rest", async () => {
  const base = path.join(E2E, "previews");
  fs.rmSync(base, { recursive: true, force: true });
  const coll = path.join(base, "Collection");
  const rel = path.join(coll, "E2E Preview Artist - Preview EP");
  const song = { artist: "E2E Preview Artist", album: "Preview EP", days: 1 };
  writeFixtureFiles([
    ...[1, 2, 3].map((n) => ({ ...song, path: path.join(rel, `0${n} Preview ${n}.aiff`), title: `Preview ${n}`, track: n, seconds: 3 })),
    { ...song, path: path.join(rel, "04 Native.flac"), title: "Native", track: 4 },
  ]);
  const before = await api("/api/settings").then((d) => d.settings || d);
  // No previews of the commit's own (cap 0) until the build.
  await put({ owned_root: coll, not_owned_roots: [], downloads_dir: "", preview_cache_gb: 0 });
  const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  const pages = [];
  let batchId = null;
  try {
    ({ batch_id: batchId } = await post("/api/import/files", { folders: [{ path: coll, since: weekAgo }], default_tags: ["pool"], default_tags_all: true, name: "e2e-previews" }));
    await waitFor(() => api(`/api/import/${batchId}`).then((b) => b.status === "ready" && b.rows.length === 4), { what: "the files batch", timeout: 30000 });
    await post(`/api/import/${batchId}/commit`, {});
    await waitFor(() => api("/api/import/last-committed").then((l) => l.batch_id === batchId), { what: "the commit", timeout: 30000 });
    const ids = (await api("/api/import/last-committed")).item_ids;
    const located = await waitFor(
      async () => {
        const list = await api(`/api/items?ids=${ids.join(",")}`).then((d) => (Array.isArray(d) ? d : d.items));
        return list.length === 4 && list.every((i) => i.local && i.local.status === "located" && Number.isFinite(i.order)) && list;
      },
      { what: "the 4 items located and numbered", timeout: 30000 }
    );
    const aiffs = located.filter((i) => /\.aiff$/.test(i.local.best.path)).map((i) => i.id);
    const flac = located.find((i) => /\.flac$/.test(i.local.best.path)).id;
    assert.equal(aiffs.length, 3);
    await put({ preview_cache_gb: 3.5 });
    await api("/api/previews", { method: "DELETE" });
    assert.equal((await api("/api/previews/status")).count, 0);

    const app = await context.newPage();
    pages.push(app);
    await storageFirst(app, { remove: COLLECTION_STATE, set: { bc_app_selection: JSON.stringify(ids) } });
    await app.goto(SERVER + "/");
    await app.waitForFunction((ks) => ks.every((k) => document.querySelector(`tr[data-key="${k}"] audio.local-audio`)), aiffs);
    for (const k of aiffs) assert.match(await srcOf(app, k), /&src=original$/, "no preview yet");
    // The dry run, in a dialog.
    await tool(app, "buildPreviews");
    await app.waitForSelector("#previewBuildConfirm");
    assert.equal(await app.textContent("#previewBuildConfirm h3"), "Build 3 previews?");
    const text = await app.textContent("#previewBuildConfirm .dialog-body");
    assert.match(text, /^Of the 4 selected items: 3 tracks need a preview; 1 track plays as it is \(MP3, FLAC, WAV…\)\./);
    assert.match(text, /About \d+ KB of the 3\.5 GB for previews \(none used yet; [\d.]+ GB free on this Mac\)\. Opus at 96 kbps\./);
    assert.match(text, /Time: under a minute, to read [\d.]+ (KB|MB) from the music drive at about 120 MB\/s \(\d+ encoders? at once\)\./);
    assert.doesNotMatch(text, /left out/);
    if (process.env.E2E_SHOTS) await app.locator("#previewBuildConfirm").screenshot({ path: path.join(process.env.E2E_SHOTS, "preview-build-confirm.png") });
    await app.click("#previewBuildConfirm .dialog-confirm");
    await app.waitForFunction(() => /^Build previews: 3 built, 0 failed, 0 skipped/.test(document.getElementById("refreshStatus").textContent), null, { timeout: 60000 });
    assert.equal((await api("/api/previews/status")).count, 3);
    // The rows heard of each preview: their next players play it; the FLAC plays as it is.
    await app.waitForFunction(
      (ks) => ks.every((k) => /&src=preview$/.test(document.querySelector(`tr[data-key="${k}"] audio`).getAttribute("src"))),
      aiffs,
      { timeout: 10000 }
    );
    assert.match(await srcOf(app, flac), /&src=original$/);
    // (By its own key: in global-player mode the one playing goes to the top bar.)
    const played = `audio[data-key="${aiffs[0]}"]`;
    await app.locator(`tr[data-key="${aiffs[0]}"]`).scrollIntoViewIfNeeded();
    await app.click(`tr[data-key="${aiffs[0]}"] .rp-play`);
    await app
      .waitForFunction((sel) => {
        const au = document.querySelector(sel);
        return au && !au.paused && au.readyState >= 3 && au.currentTime > 0.3;
      }, played, { timeout: 15000 })
      .catch(async (e) => {
        const st = await app.$eval(played, (au) => ({ src: au.getAttribute("src"), paused: au.paused, ready: au.readyState, net: au.networkState, t: au.currentTime, err: au.error && au.error.code }));
        throw new Error(`${e.message} ${JSON.stringify(st)}`);
      });
    assert.match(await app.getAttribute(played, "src"), /&src=preview$/);
    assert.equal(await app.textContent("#playingSource"), "▶ preview");
    await app.$eval(played, (au) => au.pause());
    // Built: nothing more to do.
    await tool(app, "buildPreviews");
    await app.waitForSelector("#previewBuildConfirm");
    assert.equal(await app.textContent("#previewBuildConfirm h3"), "Nothing to build");
    assert.match(await app.textContent("#previewBuildConfirm .dialog-body"), /: 0 tracks need a preview; 3 tracks already have one; 1 track plays as it is/);
    await app.click("#previewBuildConfirm .dialog-cancel");

    // Settings → Previews: the usage; a lower cap drops the least recently played at once.
    const settings = await context.newPage();
    pages.push(settings);
    await settings.goto(SERVER + "/settings/#previews");
    await settings.waitForFunction(() => /^3 previews: /.test(document.getElementById("previewUsageText").textContent));
    assert.equal(await settings.inputValue("#f_preview_cache_gb"), "3.5");
    assert.match(await settings.textContent("#previewUsageText"), /Free on this Mac: [\d.]+ GB\. No preview is written when that would drop below 2 GB\./);
    if (process.env.E2E_SHOTS) await settings.locator("#sec_previews").screenshot({ path: path.join(process.env.E2E_SHOTS, "settings-previews.png") });
    const { bytes } = await api("/api/previews/status");
    await settings.fill("#f_preview_cache_gb", String(((bytes / 3) * 1.5) / GB)); // room for one
    await settings.click("#saveBtn");
    await settings.waitForFunction(() => /^1 preview: /.test(document.getElementById("previewUsageText").textContent), null, { timeout: 10000 });
    assert.equal((await api("/api/previews/status")).count, 1);
    // The collection heard: the two dropped rows' next players play the original.
    await app.waitForFunction(
      (ks) => ks.filter((k) => /&src=original$/.test(document.querySelector(`audio[data-key="${k}"]`).getAttribute("src"))).length === 2,
      aiffs,
      { timeout: 10000 }
    );
    // Clear previews (asks first).
    await settings.click("#clearPreviews");
    await settings.waitForSelector("#clearPreviewsConfirm");
    assert.match(await settings.textContent("#clearPreviewsConfirm .dialog-body"), /^Deletes the 1 preview \(\d+ KB\) from this Mac\./);
    await settings.click("#clearPreviewsConfirm .dialog-confirm");
    await settings.waitForFunction(() => /^0 previews: /.test(document.getElementById("previewUsageText").textContent), null, { timeout: 10000 });
    assert.match(await settings.textContent("#previewClearState"), /^Cleared: 1 preview \(\d+ KB\)\.$/);
    assert.equal(await settings.isDisabled("#clearPreviews"), true);
    assert.equal((await api("/api/previews/status")).count, 0);
    await app.reload();
    await app.waitForFunction((ks) => ks.every((k) => document.querySelector(`tr[data-key="${k}"] audio.local-audio`)), aiffs);
    for (const k of aiffs) assert.match(await srcOf(app, k), /&src=original$/);
  } finally {
    for (const p of pages) await p.evaluate(() => localStorage.removeItem("bc_app_selection")).catch(() => {});
    for (const p of pages) await p.close().catch(() => {});
    if (batchId) await api(`/api/import/${batchId}`, { method: "DELETE" }).catch(() => {});
    await put({
      owned_root: before.owned_root,
      not_owned_roots: before.not_owned_roots,
      downloads_dir: before.downloads_dir,
      preview_cache_gb: before.preview_cache_gb ?? 3.5,
    });
    await api("/api/previews", { method: "DELETE" }).catch(() => {});
  }
});

// --- Phase 8: collections (the real server: A's collections, e422c37) --------------------------

const serverItems = () => api("/api/items").then((d) => (Array.isArray(d) ? d : d.items));
const collectionsNow = () => api("/api/collections");
const membersOf = (id) => api(`/api/items?collection=${id}`).then((d) => (Array.isArray(d) ? d : d.items).map((i) => i.id));
// Every collection but "Collection" goes (memberships only): what a test made.
const dropCollections = async () => {
  for (const c of await collectionsNow().catch(() => [])) if (c.id !== 0) await api(`/api/collections/${c.id}`, { method: "DELETE" }).catch(() => {});
};
const optionTexts = (page, sel) => page.$$eval(`${sel} option`, (os) => os.map((o) => o.textContent));
const shownKeys = (page) => page.$$eval("#collectionTable tbody tr[data-key]", (rs) => rs.map((r) => r.dataset.key));
const shownName = (page) => page.$eval("#collectionSelect", (s) => s.selectedOptions[0].textContent);

test("Collections: the dropdown (All first, counts), Create / Rename / Delete, Import to Collection and Remove from collection on the selection, the Collections chips in All, the choice kept and ?collection=", async () => {
  await dropCollections();
  const n = (await serverItems()).length;
  const inCollection = (await collectionsNow()).find((c) => c.id === 0).count;
  const app = await context.newPage();
  await storageFirst(app, { remove: [...COLLECTION_STATE, "bc_app_collection", "bc_app_col_widths_v2_shown"] });
  const pick = async (value) => {
    await app.selectOption("#collectionSelect", String(value));
    await app.waitForFunction(() => !document.getElementById("loadingState"));
  };
  const rowsAre = (count) => app.waitForFunction((c) => document.querySelectorAll("#collectionTable tbody tr[data-key]").length === c, count, { timeout: 10000 });
  const status = () => app.textContent("#refreshStatus");
  const statusIs = (re) => app.waitForFunction((src) => new RegExp(src).test(document.getElementById("refreshStatus").textContent), re.source, { timeout: 10000 });
  try {
    await app.goto(SERVER + "/");
    await app.waitForSelector("#collectionsBar:not([hidden])");
    assert.equal(await app.textContent("#navLink_collection"), "Collections");
    assert.deepEqual(await optionTexts(app, "#collectionSelect"), [`All (${n})`, `Collection (${inCollection})`]);
    assert.equal(await app.inputValue("#collectionSelect"), "all", "All by default");
    assert.equal(await app.isDisabled("#renameCollection"), true);
    assert.equal(await app.isDisabled("#deleteCollection"), true);
    // In All, the Collections column.
    await app.waitForSelector("#collectionTable thead th.col-collections");
    const [k1, k2, k3, k4] = await shownKeys(app);
    assert.deepEqual(await app.$$eval(`tr[data-key="${k1}"] .collection-chip`, (cs) => cs.map((c) => c.textContent)), ["Collection"]);
    assert.equal(await app.isHidden("#removeFromCollection"), true, "not in All");

    // "Collection": can be renamed, never deleted; no Collections column.
    await pick(0);
    await rowsAre(inCollection);
    assert.equal(await app.isDisabled("#renameCollection"), false);
    assert.equal(await app.isDisabled("#deleteCollection"), true);
    assert.equal(await app.$("#collectionTable thead th.col-collections"), null);

    // Create Collection: a name not taken (any case); it's shown, empty.
    await app.click("#createCollection");
    await app.waitForSelector("#createCollectionDialog");
    assert.equal(await app.isDisabled("#createCollectionDialog .dialog-confirm"), true, "no name yet");
    await app.fill("#createCollectionDialogName", "collection");
    assert.match(await app.textContent("#createCollectionDialog .dialog-body"), /There's already a collection called “collection”\./);
    assert.equal(await app.isDisabled("#createCollectionDialog .dialog-confirm"), true);
    await app.fill("#createCollectionDialogName", "Techno");
    await app.press("#createCollectionDialogName", "Enter");
    await app.waitForFunction(() => document.getElementById("collectionSelect").selectedOptions[0].textContent === "Techno (0)");
    await rowsAre(0);
    assert.match(await status(), /^Created “Techno”: empty\./);
    const techno = (await collectionsNow()).find((c) => c.name === "Techno");
    assert.ok(techno, "made on the server");
    assert.equal(await app.inputValue("#collectionSelect"), String(techno.id));

    // Import to Collection, on the selection (from All): a copy; again: what was there already is said.
    await pick("all");
    await rowsAre(n);
    for (const k of [k1, k2, k3]) await app.click(`tr[data-key="${k}"] .row-check`);
    assert.deepEqual(await optionTexts(app, "#importToCollection"), ["Import 3 to Collection…", "Collection", "Techno"]);
    await app.selectOption("#importToCollection", String(techno.id));
    await statusIs(/^Import to Collection “Techno”: 3 added\.$/);
    assert.deepEqual((await membersOf(techno.id)).sort(), [k1, k2, k3].sort());
    await app.waitForFunction((k) => [...document.querySelectorAll(`tr[data-key="${k}"] .collection-chip`)].map((c) => c.textContent).join() === "Collection,Techno", k1, { timeout: 10000 });
    await app.click(`tr[data-key="${k4}"] .row-check`);
    await app.selectOption("#importToCollection", String(techno.id));
    await statusIs(/^Import to Collection “Techno”: 1 added, 3 already there\.$/);
    assert.equal(await app.inputValue("#importToCollection"), "", "back to its label");

    // In Techno: its 4, in the order they joined; Import to Collection offers the others; Remove (asks first).
    await pick(techno.id);
    await rowsAre(4);
    assert.deepEqual(await shownKeys(app), [k1, k2, k3, k4]);
    await app.waitForFunction(() => document.getElementById("collectionSelect").selectedOptions[0].textContent === "Techno (4)", null, { timeout: 10000 });
    assert.deepEqual(await optionTexts(app, "#importToCollection"), ["Import 4 to Collection…", "Collection"]);
    await app.click("#clearSelection");
    await app.click(`tr[data-key="${k2}"] .row-check`);
    assert.equal(await app.isHidden("#removeFromCollection"), false);
    await app.click("#removeFromCollection");
    await app.waitForSelector("#removeFromCollectionConfirm");
    assert.equal(await app.textContent("#removeFromCollectionConfirm h3"), "Remove 1 track from “Techno”?");
    await app.click("#removeFromCollectionConfirm .dialog-confirm");
    await rowsAre(3);
    assert.equal(await status(), "Removed 1 from “Techno”.");
    assert.equal(await app.$(`tr[data-key="${k2}"]`), null);
    assert.deepEqual((await membersOf(techno.id)).sort(), [k1, k3, k4].sort());
    assert.ok((await membersOf(0)).includes(k2), "still in Collection");
    await app.waitForFunction(() => document.getElementById("collectionSelect").selectedOptions[0].textContent === "Techno (3)", null, { timeout: 10000 });

    // Rename.
    await app.click("#renameCollection");
    await app.waitForSelector("#renameCollectionDialog");
    assert.equal(await app.inputValue("#renameCollectionDialogName"), "Techno");
    await app.fill("#renameCollectionDialogName", "Deep Techno");
    await app.click("#renameCollectionDialog .dialog-confirm");
    await app.waitForFunction(() => document.getElementById("collectionSelect").selectedOptions[0].textContent === "Deep Techno (3)", null, { timeout: 10000 });
    assert.equal((await collectionsNow()).find((c) => c.id === techno.id).name, "Deep Techno");

    // Kept in this browser; ?collection= wins.
    await app.reload();
    await rowsAre(3);
    assert.equal(await app.inputValue("#collectionSelect"), String(techno.id));
    await app.goto(SERVER + "/?collection=all");
    await rowsAre(n);
    assert.equal(await app.inputValue("#collectionSelect"), "all");
    await app.goto(`${SERVER}/?collection=${techno.id}`);
    await rowsAre(3);

    // Delete (asks first): back to All; the tracks stay there and in Collection.
    await app.click("#deleteCollection");
    await app.waitForSelector("#deleteCollectionConfirm");
    assert.match(await app.textContent("#deleteCollectionConfirm .dialog-body"), /^The 3 tracks in it stay in All and in your other collections, with their tags\./);
    if (process.env.E2E_SHOTS) await app.locator("#deleteCollectionConfirm").screenshot({ path: path.join(process.env.E2E_SHOTS, "collections-delete.png") });
    await app.click("#deleteCollectionConfirm .dialog-confirm");
    await rowsAre(n);
    assert.equal(await app.inputValue("#collectionSelect"), "all");
    assert.deepEqual(await optionTexts(app, "#collectionSelect"), [`All (${n})`, `Collection (${inCollection})`]);
    assert.equal(await status(), "Deleted the collection “Deep Techno”.");
    assert.match(app.url(), /\?collection=all$/, "the URL follows");
    assert.deepEqual((await collectionsNow()).map((c) => c.id), [0]);
    if (process.env.E2E_SHOTS) await app.locator("#topBar").screenshot({ path: path.join(process.env.E2E_SHOTS, "collections-bar.png") });
  } finally {
    await app.evaluate(() => ["bc_app_selection", "bc_app_collection"].forEach((k) => localStorage.removeItem(k))).catch(() => {});
    await app.close();
    await dropCollections();
  }
});

test("Collections: Import selected goes into the collection picked next to it (the last used, else Collection), an open batch choosing at the commit; the collection page then opens there", async () => {
  await dropCollections();
  const techno = await post("/api/collections", { name: "E2E Techno" });
  // A batch of two collection tracks (their own tags: the merge changes nothing), made before choosing.
  const picked = (await serverItems()).filter((i) => i.tralbum_type === "t" && i.source !== "other" && (i.tags || []).length).slice(0, 2);
  const items = picked.map((it, i) => ({ line: i + 1, raw: `${it.artist} - ${it.title}`, artist: it.artist, title: it.title, existing_id: it.id, tags: it.tags }));
  const { batch_id: batchId } = await post("/api/import", { file: { format: "bc-tagger-import/1", source: "e2e-into.txt", items }, default_tags: [], name: "e2e-into" });
  await waitFor(() => api(`/api/import/${batchId}`).then((b) => b.status === "ready"), { what: "the batch", timeout: 30000 });
  const page = await context.newPage();
  await storageFirst(page, { remove: [...COLLECTION_STATE, "bc_app_collection", "bc_import_collection"] });
  const commits = [];
  page.on("request", (r) => r.method() === "POST" && r.url().endsWith(`/api/import/${batchId}/commit`) && commits.push(JSON.parse(r.postData() || "{}")));
  const confirms = [];
  page.on("dialog", (dlg) => {
    confirms.push(dlg.message());
    dlg.accept();
  });
  const pickerReady = () => page.waitForFunction(() => !document.querySelector(".import-collection-label").hidden);
  try {
    await page.goto(`${SERVER}/import/?batch=${batchId}`);
    await pickerReady();
    assert.deepEqual(await optionTexts(page, "#importCollection"), ["Collection", "E2E Techno"]);
    assert.equal(await page.inputValue("#importCollection"), "0", "Collection, with none used before");
    await page.selectOption("#importCollection", String(techno.id));
    await page.reload();
    await pickerReady();
    assert.equal(await page.inputValue("#importCollection"), String(techno.id), "the last used");
    if (process.env.E2E_SHOTS) await page.locator("#toolbar").screenshot({ path: path.join(process.env.E2E_SHOTS, "import-into-collection.png") });
    await page.click("#importSelected");
    await page.waitForURL(`${SERVER}/`, { timeout: 30000 });
    assert.deepEqual(commits, [{ collection_id: techno.id }]);
    assert.match(confirms[0], /^Import 2 selected rows into “E2E Techno”\?/);
    const last = await api("/api/import/last-committed");
    assert.equal(last.batch_id, batchId);
    assert.equal(last.collection_id, techno.id);
    assert.deepEqual((await membersOf(techno.id)).sort(), picked.map((i) => i.id).sort(), "they went into E2E Techno");
    // The collection page opens in E2E Techno, with what was imported selected.
    await page.waitForFunction((v) => document.getElementById("collectionSelect").value === v, String(techno.id));
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key]").length === 2, null, { timeout: 10000 });
    assert.equal(await shownName(page), "E2E Techno (2)");
    assert.deepEqual((await page.$$eval("#collectionTable .row-check:checked", (bs) => bs.map((b) => b.closest("tr").dataset.key))).sort(), picked.map((i) => i.id).sort());
    // Select last import, from All: back in E2E Techno.
    await page.selectOption("#collectionSelect", "all");
    await page.waitForFunction(() => document.querySelectorAll("#collectionTable tbody tr[data-key]").length > 2);
    await page.click("#selectLastImport");
    await page.waitForFunction((v) => document.getElementById("collectionSelect").value === v, String(techno.id), { timeout: 10000 });
    await page.waitForFunction(() => /^Selected the 2 items of the last import/.test(document.getElementById("refreshStatus").textContent));
  } finally {
    await page.evaluate(() => ["bc_app_selection", "bc_app_collection", "bc_import_collection"].forEach((k) => localStorage.removeItem(k))).catch(() => {});
    await page.close();
    await api(`/api/import/${batchId}`, { method: "DELETE" }).catch(() => {});
    await dropCollections();
  }
});

// --- Phase 9: collections in the extension's tagger -------------------------------------------

// What these tests wait for is quick to ask (a few items, the extension's storage): asked every 100 ms.
const waitSoon = (fn, o = {}) => waitFor(fn, { interval: 100, ...o });

// How long a Bandcamp page takes to draw its stars with `total` items in the extension's storage (copies of real
// ones beyond the export, removed after): navigation start → the last star drawn, the median of `runs` loads.
async function starTiming({ total = 1100, runs = 5 } = {}) {
  const { taggedItems } = await storage("taggedItems");
  const ids = Object.keys(taggedItems);
  const extra = {};
  for (let i = 0; ids.length + Object.keys(extra).length < total; i++) {
    const src = taggedItems[ids[i % ids.length]];
    const id = `t9${String(i).padStart(9, "0")}`;
    extra[id] = { ...src, id, title: `${src.title} (timing ${i})` };
  }
  const serverBefore = (await api("/api/health")).items;
  await probe.evaluate((x) => chrome.storage.local.get("taggedItems").then(({ taggedItems }) => chrome.storage.local.set({ taggedItems: { ...taggedItems, ...x } })), extra);
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__stars = { n: 0, last: 0 };
    new MutationObserver(() => {
      const n = document.querySelectorAll(".tag-button").length;
      if (n !== window.__stars.n) window.__stars = { n, last: performance.now() };
    }).observe(document, { childList: true, subtree: true });
  });
  const times = [];
  try {
    for (let r = 0; r < runs; r++) {
      await page.goto("https://infiniteexpanse.bandcamp.com/album/synergy-trilogy");
      await page.waitForSelector("#tagger_a563830364", { state: "attached", timeout: 30000 });
      // The last stars: none added for 100 ms.
      await page.waitForFunction(() => window.__stars.n > 1 && performance.now() - window.__stars.last > 100, null, { polling: 25 });
      const { n, last } = await page.evaluate(() => window.__stars);
      times.push({ n, ms: Math.round(last) });
    }
  } finally {
    await page.close();
    await probe.evaluate((x) => chrome.storage.local.get("taggedItems").then(({ taggedItems }) => {
      Object.keys(x).forEach((id) => delete taggedItems[id]);
      return chrome.storage.local.set({ taggedItems });
    }), extra);
    // The server too (the extension pushes the deletions), so later tests start from the same collection.
    await waitSoon(async () => (await api("/api/health")).items === serverBefore, { what: "the copies gone from the server" });
  }
  const sorted = times.map((t) => t.ms).sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], times, stars: times[0].n, items: total };
}

test("Bandcamp page: the stars of a recorded album page are drawn as fast with 1,100 items in storage (timing)", async () => {
  const t = await starTiming();
  console.log(`[timing] stars: ${JSON.stringify(t)}`);
  assert.ok(t.stars > 1, "stars drawn");
  assert.ok(t.median < 3000, `median ${t.median} ms`);
});

const ALBUM = "a563830364"; // Synergy Trilogy, in the imported export (in "Collection")
const TRACK = "t3738475288"; // Holo Law, one of its tracks: not saved
const ALBUM_URL = "https://infiniteexpanse.bandcamp.com/album/synergy-trilogy";
const setStorage = (values) => probe.evaluate((v) => chrome.storage.local.set(v), values);
const send = (msg) => probe.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);
// The extension's copy of the collections is the server's version (nothing pending).
const extensionCaughtUp = async () => {
  const want = (await api("/api/collections/membership")).version;
  await waitSoon(async () => {
    const { collectionsCache, pendingMembership } = await storage(["collectionsCache", "pendingMembership"]);
    if ((collectionsCache || {}).version !== want || (pendingMembership || []).length) {
      await send({ type: "popupState" }); // reads them (one request)
      return false;
    }
    return true;
  }, { what: "the extension's collections copy", timeout: 15000 });
};
const serverHas = (ids) => api(`/api/items?ids=${ids.join(",")}`).then((d) => new Set((Array.isArray(d) ? d : d.items).map((i) => i.id)));
const onServer = (id) => serverHas([id]).then((have) => have.has(id));
// The extension's items: these set (an item, or null to delete it), in one storage write (one push).
const writeItems = (changes) =>
  probe.evaluate((c) => chrome.storage.local.get("taggedItems").then(({ taggedItems }) => {
    Object.entries(c).forEach(([id, item]) => (item ? (taggedItems[id] = item) : delete taggedItems[id]));
    return chrome.storage.local.set({ taggedItems });
  }), changes);
// These tracks start unsaved (an earlier test may have saved one): set aside here and on the server, in one write.
// The returned function puts them back as they were, with `also` (more items to put back), in one write.
async function tracksAside(ids) {
  const saved = (await storage("taggedItems")).taggedItems;
  const copies = Object.fromEntries(ids.map((id) => [id, saved[id] || null]));
  if (ids.some((id) => copies[id])) await writeItems(Object.fromEntries(ids.map((id) => [id, null])));
  await waitSoon(async () => !(await serverHas(ids)).size, { what: `${ids.join(", ")} not on the server` });
  return async (also = {}) => {
    const back = { ...copies, ...also };
    await writeItems(back);
    const kept = Object.keys(back).filter((id) => back[id]);
    const gone = Object.keys(back).filter((id) => !back[id]);
    await waitSoon(async () => {
      const have = await serverHas(Object.keys(back));
      return kept.every((id) => have.has(id)) && gone.every((id) => !have.has(id));
    }, { what: "the tracks as they were on the server" });
  };
}
const starOf = (page, id) => page.locator(`.tag-button[data-item-id="${id}"]`);
const isStarred = (page, id) => starOf(page, id).evaluate((b) => b.textContent.trim() === "★");
const starIs = (page, id, on) =>
  page.waitForFunction(([i, o]) => {
    const b = document.querySelector(`.tag-button[data-item-id="${i}"]`);
    return b && (b.textContent.trim() === "★") === o;
  }, [id, on], { timeout: 10000 });

test("Collections in the extension: the popup lists All, the collections with counts and New collection…, makes one localhost request as it opens, and keeps its choice in the extension's storage (what an extension reload keeps)", async () => {
  await dropCollections();
  const crates = await post("/api/collections", { name: "E2E Crates" });
  await extensionCaughtUp();
  const inCollection = (await collectionsNow()).find((c) => c.id === 0).count;
  const { taggedItems } = await storage("taggedItems");
  const popup = await context.newPage();
  const asked = [];
  const record = (r) => r.url().startsWith(SERVER) && asked.push(new URL(r.url()).pathname);
  context.on("request", record);
  try {
    await popup.goto(extPage("popup.html"));
    await popup.waitForFunction(() => document.querySelectorAll("#collectionPicker option").length > 2 && /synced|offline/.test(document.getElementById("serverText").textContent));
    await sleep(300);
    context.off("request", record);
    // (The background's own work aside: the 30 s tick's reads, and pushes of earlier changes.)
    const mine = asked.filter((p) => !["/api/health", "/api/tag-edits/pending", "/api/tagger/pending-adds", "/api/sync/items", "/api/sync/tags"].includes(p));
    assert.deepEqual(mine, ["/api/collections/membership"], `one request: ${asked.join(", ")}`);
    assert.deepEqual(await popup.$$eval("#collectionPicker option", (os) => os.map((o) => o.textContent)), [
      `All (${Object.keys(taggedItems).length})`,
      `Collection (${inCollection})`,
      "E2E Crates (0)",
      "New collection…",
    ]);
    assert.equal(await popup.inputValue("#collectionPicker"), "all", "All by default");
    if (process.env.E2E_SHOTS) await popup.screenshot({ path: path.join(process.env.E2E_SHOTS, "popup-collections.png") });
    await popup.selectOption("#collectionPicker", String(crates.id));
    await waitSoon(async () => (await storage("activeCollection")).activeCollection === crates.id, { what: "the choice stored" });
    await popup.close();
    // Kept in chrome.storage.local, which an extension reload keeps: a new popup (fresh script) shows it.
    const again = await context.newPage();
    await again.goto(extPage("popup.html"));
    await again.waitForFunction((v) => document.getElementById("collectionPicker").value === v, String(crates.id));
    await again.close();
  } finally {
    context.off("request", record);
    await setStorage({ activeCollection: "all" });
    await dropCollections();
  }
});

test("Collections in the extension: a Bandcamp page's stars follow the popup's choice without a reload; star and un-star in a collection (membership only) and in All (a new item into the first collection; deleting asks when it's in two or more)", async () => {
  await dropCollections();
  const crates = await post("/api/collections", { name: "E2E Crates" });
  const putBack = await tracksAside([TRACK]);
  await extensionCaughtUp();
  const albumCopy = (await storage("taggedItems")).taggedItems[ALBUM];
  assert.ok(albumCopy);
  const page = await context.newPage();
  const dialogs = [];
  let answer = false;
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    answer ? d.accept() : d.dismiss();
  });
  const saved = async (id) => !!(await storage("taggedItems")).taggedItems[id];
  try {
    await page.goto(ALBUM_URL);
    await page.waitForSelector(`.tag-button[data-item-id="${ALBUM}"]`, { timeout: 30000 });
    const loads = [];
    page.on("load", () => loads.push(1));
    // All: saved items are starred; starring a new one puts it into the first collection ("Collection"), numbered.
    assert.equal(await isStarred(page, ALBUM), true);
    assert.equal(await isStarred(page, TRACK), false);
    await starOf(page, TRACK).click();
    await starIs(page, TRACK, true);
    await waitSoon(async () => (await membersOf(0)).includes(TRACK), { what: "the track in Collection (the first)" });
    assert.ok(Number.isInteger((await storage("taggedItems")).taggedItems[TRACK].order), "numbered");
    // The popup's choice: the stars follow, with no reload.
    await setStorage({ activeCollection: crates.id });
    await starIs(page, ALBUM, false);
    assert.equal(await isStarred(page, TRACK), false);
    // In a collection: starring puts a saved item in, membership only (its tags as they were).
    await starOf(page, ALBUM).click();
    await starOf(page, TRACK).click();
    await starIs(page, ALBUM, true);
    await starIs(page, TRACK, true);
    await waitSoon(async () => (await membersOf(crates.id)).sort().join() === [ALBUM, TRACK].sort().join(), { what: "both in E2E Crates" });
    assert.deepEqual((await storage("taggedItems")).taggedItems[ALBUM].tags, albumCopy.tags);
    // Un-starring in a collection: out of it only (still saved, still in Collection).
    await starOf(page, TRACK).click();
    await starIs(page, TRACK, false);
    await waitSoon(async () => !(await membersOf(crates.id)).includes(TRACK), { what: "the track out of E2E Crates" });
    assert.ok(await saved(TRACK), "still saved");
    assert.ok((await membersOf(0)).includes(TRACK), "still in Collection");
    // Back to All: starred (saved), still no reload.
    await setStorage({ activeCollection: "all" });
    await starIs(page, TRACK, true);
    assert.equal(loads.length, 0, "no reload");
    // All: the album is in two collections: un-starring asks first (No: kept; Yes: deleted everywhere).
    await starOf(page, ALBUM).click();
    await waitSoon(() => dialogs.length === 1, { what: "the confirm" });
    assert.match(dialogs[0], /is in 2 collections \(Collection, E2E Crates\)\. Delete it and its tags from all of them\?$/);
    await starIs(page, ALBUM, true);
    assert.ok(await saved(ALBUM), "kept");
    answer = true;
    await starOf(page, ALBUM).click();
    await starIs(page, ALBUM, false);
    await waitSoon(async () => !(await onServer(ALBUM)), { what: "the album deleted on the server" });
    assert.equal(await saved(ALBUM), false);
    assert.equal((await membersOf(crates.id)).includes(ALBUM), false);
    assert.equal(dialogs.length, 2);
  } finally {
    await page.close();
    // As it was: the album back (it rejoins Collection, the first), the track as it was, All shown.
    await setStorage({ activeCollection: "all" });
    await dropCollections();
    await putBack({ [ALBUM]: albumCopy });
  }
});

test("Collections in the extension: one made in the popup shows in the app at once, and one made in the app reaches the extension (through the app) and its popup", async () => {
  await dropCollections();
  await extensionCaughtUp();
  const app = await context.newPage();
  await storageFirst(app, { remove: ["bc_app_collection"] });
  const popup = await context.newPage();
  try {
    await app.goto(SERVER + "/");
    await app.waitForSelector("#collectionsBar:not([hidden])");
    await app.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
    // In the popup: New collection… → a name → Create: the popup's choice; the app's dropdown has it.
    await popup.goto(extPage("popup.html"));
    await popup.waitForFunction(() => {
      const add = document.querySelector("#collectionPicker option[value='new']");
      return add && !add.disabled;
    });
    await popup.selectOption("#collectionPicker", "new");
    await popup.fill("#newCollectionName", "E2E From Popup");
    await popup.press("#newCollectionName", "Enter");
    const fromPopup = await waitSoon(async () => (await collectionsNow()).find((c) => c.name === "E2E From Popup"), { what: "made on the server" });
    await popup.waitForFunction((v) => document.getElementById("collectionPicker").value === v, String(fromPopup.id));
    assert.equal((await storage("activeCollection")).activeCollection, fromPopup.id);
    await app.waitForFunction(() => [...document.querySelectorAll("#collectionSelect option")].some((o) => o.textContent === "E2E From Popup (0)"), null, { timeout: 10000 });
    // In the app: Create Collection: the extension's copy has it (the app passes the event on), then its popup.
    await app.click("#createCollection");
    await app.fill("#createCollectionDialogName", "E2E From App");
    await app.press("#createCollectionDialogName", "Enter");
    await waitSoon(async () => ((await storage("collectionsCache")).collectionsCache.list || []).some((c) => c.name === "E2E From App"), {
      what: "the extension's copy", timeout: 10000,
    });
    await popup.reload();
    await popup.waitForFunction(() => [...document.querySelectorAll("#collectionPicker option")].some((o) => o.textContent === "E2E From App (0)"));
  } finally {
    await popup.close();
    await app.evaluate(() => localStorage.removeItem("bc_app_collection")).catch(() => {});
    await app.close();
    await setStorage({ activeCollection: "all" });
    await dropCollections();
  }
});

test("Collections in the extension: starring while the server is off works at once and reaches the server when it's back; New collection… waits for the server", async () => {
  await dropCollections();
  const crates = await post("/api/collections", { name: "E2E Crates" });
  const putBack = await tracksAside([TRACK]);
  await extensionCaughtUp();
  const page = await context.newPage();
  const popup = await context.newPage();
  try {
    await setStorage({ activeCollection: crates.id });
    await setStorage({ bcServer: { url: "http://127.0.0.1:9" } }); // nothing answers there
    await page.goto(ALBUM_URL);
    await page.waitForSelector(`.tag-button[data-item-id="${TRACK}"]`, { timeout: 30000 });
    await starOf(page, TRACK).click();
    await starIs(page, TRACK, true);
    await waitSoon(async () => ((await storage("pendingMembership")).pendingMembership || []).some((op) => op.ids.includes(TRACK)), { what: "the change queued" });
    assert.equal((await membersOf(crates.id)).includes(TRACK), false, "not on the server yet");
    await popup.goto(extPage("popup.html"));
    await popup.waitForFunction(() => /offline/.test(document.getElementById("serverText").textContent));
    assert.equal(await popup.textContent("#collectionPicker option[value='new']"), "New collection… (the server isn't running)");
    assert.equal(await popup.$eval("#collectionPicker option[value='new']", (o) => o.disabled), true);
    assert.equal(await popup.inputValue("#collectionPicker"), String(crates.id), "the choice, from the extension's copy");
    // The server is back: the queued change is applied.
    await setStorage({ bcServer: { url: SERVER } });
    await waitSoon(async () => (await membersOf(crates.id)).includes(TRACK), { what: "the track in E2E Crates on the server", timeout: 30000 });
    await waitSoon(async () => !((await storage("pendingMembership")).pendingMembership || []).length, { what: "nothing left queued" });
    assert.equal((await membersOf(0)).includes(TRACK), false, "only there: a new item starred in a collection");
    assert.equal((await storage("taggedItems")).taggedItems[TRACK].order, null, "no number in Collection");
  } finally {
    await setStorage({ bcServer: { url: SERVER }, activeCollection: "all" });
    await popup.close();
    await page.close();
    await dropCollections();
    await putBack();
  }
});

test("Collections in the extension: a track with no \"#\" that joins Collection on the server is numbered there, and the extension's next \"#\" comes after it (no collision)", async () => {
  await dropCollections();
  const crates = await post("/api/collections", { name: "E2E Crates" });
  const page = await context.newPage();
  const app = await context.newPage();
  const putBack = [];
  try {
    await page.goto(ALBUM_URL);
    await page.waitForSelector(`.tag-button[data-item-id="${TRACK}"]`, { timeout: 30000 });
    const other = (await page.$$eval(".tag-button[data-item-id]", (bs) => bs.map((b) => b.dataset.itemId))).find((i) => i.startsWith("t") && i !== TRACK);
    assert.ok(other, "the album's other track");
    // Both tracks unsaved, and a hole in Collection's "#" (a low-numbered track deleted, as happens): its highest
    // number is then above the number of tracks, which alone no longer covers a place given on the server.
    const saved = (await storage("taggedItems")).taggedItems;
    const low = Object.values(saved).filter((i) => Number.isInteger(i.order) && i.id !== ALBUM).sort((a, b) => a.order - b.order)[0].id;
    putBack.push(await tracksAside([TRACK, other, low]));
    await extensionCaughtUp();
    // The app is open: it passes the server's collections events on to the extension.
    await app.goto(SERVER + "/");
    await app.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
    // Starred into E2E Crates: saved with no "#".
    await setStorage({ activeCollection: crates.id });
    await starIs(page, TRACK, false);
    await starOf(page, TRACK).click();
    await waitSoon(async () => (await membersOf(crates.id)).includes(TRACK), { what: "the track in E2E Crates" });
    assert.equal((await storage("taggedItems")).taggedItems[TRACK].order, null);
    // It joins Collection on the server (the app's Import to Collection): numbered there, after the last.
    assert.equal((await post("/api/collections/0/items", { ids: [TRACK] })).added, 1);
    const numbered = (await api("/api/health")).max_order; // counts its place in Collection
    await waitSoon(async () => (await storage("orderFloor")).orderFloor >= numbered, { what: "the extension's highest \"#\"" });
    // A new track starred in All (into Collection, the first) is numbered after it.
    await setStorage({ activeCollection: "all" });
    await starIs(page, other, false);
    await starOf(page, other).click();
    const order = await waitSoon(async () => ((await storage("taggedItems")).taggedItems[other] || {}).order, { what: "its \"#\"" });
    assert.ok(order > numbered, `${order} after ${numbered}`);
    await waitSoon(async () => (await membersOf(0)).includes(other), { what: "the new track in Collection" });
    const inCollection = await membersOf(0);
    assert.ok(inCollection.indexOf(TRACK) < inCollection.indexOf(other), "in that order in Collection");
  } finally {
    await setStorage({ activeCollection: "all" });
    await app.close();
    await page.close();
    await dropCollections();
    for (const back of putBack.reverse()) await back();
  }
});

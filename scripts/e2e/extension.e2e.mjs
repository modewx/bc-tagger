// End-to-end tests for the extension + local server + local app, in a
// Playwright-controlled Chromium with its own throwaway profile (never the
// user's Chrome or the dev extension's storage).
//
//   npm run test:e2e                 (HEADED=1 to watch it)
//
// It builds "Bc Tagger (e2e)" into .e2e/extension (default server
// http://127.0.0.1:8767), starts server/bct on :8767 with a fresh data dir in
// .e2e/server-data (seeded from the export JSON), and loads the export through
// the extension's Import page. With the Bandcamp cookie file present, it also
// checks ownership via the extension (cookie values are never printed).
// Nothing here writes rekordbox or touches :8765 / :8766.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

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
const COOKIES =
  process.env.E2E_COOKIES || "/Users/alvaroh/Projects/auto-rekordbox/cookies/bandcamp.com_cookies_10:2026.txt";
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

// Netscape cookies.txt → Playwright cookies (bandcamp only). Values are never logged.
function loadCookies(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => {
      const httpOnly = line.startsWith("#HttpOnly_");
      if (httpOnly) line = line.slice("#HttpOnly_".length);
      if (!line || line.startsWith("#")) return null;
      const [domain, , cpath, secure, expires, name, value] = line.split("\t");
      if (!name || !/bandcamp\.com$/.test(domain)) return null;
      return {
        name,
        value: (value || "").trim(),
        domain,
        path: cpath || "/",
        secure: secure === "TRUE",
        httpOnly,
        expires: Number(expires) > 0 ? Number(expires) : -1,
        sameSite: "Lax",
      };
    })
    .filter(Boolean);
}

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

  context = await chromium.launchPersistentContext(PROFILE, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
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

test("ownership from Bandcamp via the extension (cookie file)", async (t) => {
  const cookies = loadCookies(COOKIES);
  if (!cookies.length) {
    t.skip("no Bandcamp cookie file");
    return;
  }
  await context.addCookies(cookies);
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForFunction(() => /extension connected/.test(document.getElementById("navExt").textContent));
  await app.click("#refreshOwnership");
  await app.waitForFunction(() => /done|failed/.test(document.getElementById("refreshStatus").textContent), null, {
    timeout: 60000,
  });
  const status = await app.textContent("#refreshStatus");
  const owned = Number((status.match(/owned: (\d+)/) || [])[1] || 0);
  assert.ok(owned > 0, `expected owned items, got: ${status.replace(/\s+/g, " ").slice(0, 120)}`);
  console.log(`# ownership: ${owned} owned items`);
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

test("Fix album IDs reads the real album from track pages (Bandcamp)", async () => {
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
test("album page: the header widget is the album item; track rows never touch it (Bandcamp)", async () => {
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

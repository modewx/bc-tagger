// How fast the extension's tagger answers on a Bandcamp page with a store the size of the user's (about 1,070
// items, 1.6 MB of taggedItems): star / un-star (on screen, written, pushed to the server) and typing tags in the
// chosen box (per key, keydown to the next paint), with the page's long tasks and the service worker's CPU time.
// Everything local: a recorded Bandcamp page (scripts/e2e/fixtures), a server of our own, no network.
//
//   PERF_EXT=<an e2e build of the extension, pointed at PERF_PORT>   (npx webpack --env e2e, BC_EXT_OUT=…,
//   PERF_APP=<an app build>                                             BC_DEFAULT_SERVER_URL=http://127.0.0.1:8769)
//   PERF_SERVER_ROOT=<a checkout whose server/ runs>  PERF_PORT=8769  PERF_TABS=1 (Bandcamp tabs; more: also an app tab)
//   PERF_RUNS=5  PERF_LABEL=…  PERF_OUT=<json>  PERF_SWTOP=1 / PERF_PAGETOP=1 (top functions: worker / typing page)
//   node --experimental-websocket scripts/perf/extension.perf.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXT = process.env.PERF_EXT || path.join(ROOT, ".e2e/extension");
const APP = process.env.PERF_APP || path.join(ROOT, "app/dist");
const SERVER_ROOT = process.env.PERF_SERVER_ROOT || ROOT;
const PORT = Number(process.env.PERF_PORT || 8769);
const SERVER = `http://127.0.0.1:${PORT}`;
const TABS = Number(process.env.PERF_TABS || 1);
const RUNS = Number(process.env.PERF_RUNS || 5);
const THROTTLE = Number(process.env.PERF_THROTTLE || 1); // the Bandcamp tabs' CPU slowed this much (a loaded machine)
const COLD = !!process.env.PERF_COLD; // the service worker stopped before each star (Chrome stops it after ~30 s idle)
const LABEL = process.env.PERF_LABEL || path.basename(EXT);
const CDP_PORT = 9339;
const ITEMS = 1070;
const EXPORT_JSON = process.env.PERF_EXPORT_JSON || "/Users/alvaroh/Projects/auto-rekordbox/tagger-test-db/bc-tagger-export-2026-10-26.json";
const ALBUM_URL = "https://infiniteexpanse.bandcamp.com/album/synergy-trilogy";
const TRACK = "t3738475288"; // Holo Law: starred and un-starred
const FIXTURES = path.join(ROOT, "scripts/e2e/fixtures/bandcamp");
const fixtureIndex = JSON.parse(fs.readFileSync(path.join(FIXTURES, "index.json"), "utf8"));
const NO_LIVE = "http://127.0.0.1:9";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const api = (p) => fetch(SERVER + p).then((r) => r.json());

async function waitFor(fn, what, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out: ${what}`);
}

// --- the service worker's CPU time, over CDP (its CPU profile: the time not idle) ------------------------------
async function swProfile(extId) {
  const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
  const t = list.find((x) => x.type === "service_worker" && x.url.includes(extId));
  if (!t) return { stop: async () => null };
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let id = 0;
  const send = (method, params = {}) =>
    new Promise((res) => {
      const my = ++id;
      ws.addEventListener("message", function on(ev) {
        const m = JSON.parse(ev.data);
        if (m.id === my) {
          ws.removeEventListener("message", on);
          res(m.result || {});
        }
      });
      ws.send(JSON.stringify({ id: my, method, params }));
    });
  await send("Profiler.enable");
  await send("Profiler.setSamplingInterval", { interval: 200 });
  await send("Profiler.start");
  return {
    async stop() {
      const { profile } = await send("Profiler.stop");
      ws.close();
      return profileBusy(profile, process.env.PERF_SWTOP && "sw");
    },
  };
}

// A CPU profile's non-idle time (ms); with `label`, its top functions by self time on stderr.
function profileBusy(profile, label) {
  if (!profile) return null;
  const idle = new Set(profile.nodes.filter((n) => n.callFrame.functionName === "(idle)").map((n) => n.id));
  let busy = 0;
  const self = {};
  const byId = Object.fromEntries(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((nodeId, i) => {
    if (idle.has(nodeId)) return;
    busy += profile.timeDeltas[i] || 0;
    const cf = byId[nodeId].callFrame;
    const key = `${cf.functionName || "(anonymous)"} ${String(cf.url).split("/").pop()}:${cf.lineNumber}`;
    self[key] = (self[key] || 0) + (profile.timeDeltas[i] || 0);
  });
  if (label) {
    const top = Object.entries(self).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${Math.round(v / 1000)}ms ${k}`);
    console.error(`[${label} top] ${top.join(" | ")}`);
  }
  return Math.round(busy / 1000);
}

// --- set up -------------------------------------------------------------------------------------------------
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "bc-perf-data-"));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "bc-perf-profile-"));
fs.writeFileSync(path.join(DATA, "settings.json"), JSON.stringify({ app_dist_dir: APP }));
const server = spawn(path.join(SERVER_ROOT, "server/bct"), ["serve", "--port", String(PORT)], {
  cwd: SERVER_ROOT,
  env: { ...process.env, BC_TAGGER_DATA_DIR: DATA, HTTPS_PROXY: NO_LIVE, HTTP_PROXY: NO_LIVE, ALL_PROXY: NO_LIVE, NO_PROXY: "127.0.0.1,localhost" },
  stdio: "ignore",
});
const cleanup = async (context) => {
  if (context) await context.close().catch(() => {});
  server.kill();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
};
let context;
try {
  await waitFor(() => api("/api/health").then((h) => h.ok).catch(() => false), "the server");
  process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";
  context = await chromium.launchPersistentContext(PROFILE, {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--host-resolver-rules=MAP bandcamp.com ~NOTFOUND, MAP *.bandcamp.com ~NOTFOUND, MAP *.bcbits.com ~NOTFOUND",
    ],
  });
  await context.route(/^https?:\/\/([a-z0-9-]+\.)*(bandcamp\.com|bcbits\.com)\//i, (route) => {
    const u = new URL(route.request().url());
    const entry = fixtureIndex[u.origin + u.pathname];
    if (entry && !entry.status) return route.fulfill({ status: 200, contentType: entry.type || "text/html; charset=utf-8", body: fs.readFileSync(path.join(FIXTURES, entry.file)) });
    return route.abort("blockedbyclient");
  });
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  const extId = new URL(sw.url()).host;
  const probe = await context.newPage();
  await probe.goto(`chrome-extension://${extId}/import.html`);

  // The store: the export, plus copies of its items up to ITEMS.
  const exp = JSON.parse(fs.readFileSync(EXPORT_JSON, "utf8"));
  const items = { ...exp.taggedItems };
  const ids = Object.keys(exp.taggedItems);
  for (let i = 0; Object.keys(items).length < ITEMS; i++) {
    const src = exp.taggedItems[ids[i % ids.length]];
    const id = `t8${String(i).padStart(9, "0")}`;
    items[id] = { ...src, id, title: `${src.title} (copy ${i})`, order: ids.length + i + 1 };
  }
  await probe.evaluate(([taggedItems, tags]) => chrome.storage.local.set({ taggedItems, tags }), [items, exp.tags || []]);
  await waitFor(() => api("/api/health").then((h) => h.items >= ITEMS), "the store on the server", 60000);
  const bytes = JSON.stringify(items).length;

  // Writes and pushes, as they happen.
  await probe.evaluate(() => {
    window.__writes = [];
    chrome.storage.onChanged.addListener((c, area) => area === "local" && c.taggedItems && window.__writes.push(Date.now()));
  });
  const pushes = [];
  context.on("request", (r) => /\/api\/sync\/items$/.test(r.url()) && pushes.push(Date.now()));
  const notFound = [];
  context.on("response", (r) => r.url().startsWith(SERVER) && r.status() === 404 && notFound.push(new URL(r.url()).pathname));

  // The pages: the measured Bandcamp tab first (long tasks and event timing recorded), more Bandcamp tabs, an app tab.
  const instrument = () => {
    window.__long = [];
    window.__events = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push({ at: performance.timeOrigin + e.startTime, ms: e.duration }))).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((l) =>
      l.getEntries().forEach((e) =>
        window.__events.push({ name: e.name, at: performance.timeOrigin + e.startTime, ms: e.duration, wait: e.processingStart - e.startTime, run: e.processingEnd - e.processingStart })
      )
    ).observe({ type: "event", durationThreshold: 16, buffered: true });
  };
  const page = await context.newPage();
  await page.addInitScript(instrument);
  await page.goto(ALBUM_URL);
  const others = [];
  for (let i = 1; i < TABS; i++) {
    const p = await context.newPage();
    await p.goto(ALBUM_URL);
    others.push(p);
  }
  if (TABS > 1) {
    const app = await context.newPage();
    await app.goto(SERVER + "/");
    await app.waitForSelector("#collectionTable tbody tr", { timeout: 60000 });
    others.push(app);
  }
  for (const p of [page, ...others.filter((p) => p.url().includes("bandcamp"))]) {
    await p.waitForSelector(`#tagger_${TRACK}`, { state: "attached", timeout: 30000 });
    if (THROTTLE > 1) await (await context.newCDPSession(p)).send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  }
  // The measured tab's main-thread busy time (CDP Performance: TaskDuration), content scripts included.
  const pageCdp = await context.newCDPSession(page);
  await pageCdp.send("Performance.enable");
  const pageBusy = async () => ((await pageCdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration") || {}).value || 0;
  const trackIds = await page.$$eval("select[id^='tagger_']", (s) => s.map((x) => x.id.slice(7)));
  const OTHER = trackIds.find((i) => i.startsWith("t") && i !== TRACK);
  const star = page.locator(`#tagger_${TRACK}`).locator("xpath=ancestor::div[contains(@class,'tagger-container')]").locator(".tag-button");
  await sleep(1500); // the pages settled (first sync, the app's first load)

  const saved = async (id) => !!(await probe.evaluate((i) => chrome.storage.local.get("taggedItems").then((s) => !!s.taggedItems[i]), id));
  const quiet = async () => {
    const n = pushes.length;
    await sleep(1200);
    if (pushes.length !== n) await sleep(1200);
  };

  // One star click: its times from the click (on screen, painted, written, pushed), the long tasks on the page
  // and the service worker's CPU in the 3 s after it.
  // Stop the extension's service worker, as Chrome does after it was idle a while.
  async function stopWorker() {
    const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
    const t = list.find((x) => x.type === "service_worker" && x.url.includes(extId));
    if (!t) return;
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${t.id}`);
    await waitFor(async () => !(await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json())).some((x) => x.id === t.id), "the worker stopped", 10000);
  }

  async function clickStar(expectOn) {
    await quiet();
    if (COLD) await stopWorker();
    const prof = COLD ? { stop: async () => null } : await swProfile(extId);
    const busy0 = await pageBusy();
    const w0 = (await probe.evaluate(() => window.__writes.length));
    const p0 = pushes.length;
    await star.evaluate((b) => {
      window.__t = {};
      const target = b;
      document.addEventListener("click", (e) => e.target.closest(".tag-button") === target && (window.__t.click = Date.now()), { capture: true, once: true });
      new MutationObserver((m, obs) => {
        window.__t.star = Date.now();
        requestAnimationFrame(() => requestAnimationFrame(() => (window.__t.paint = Date.now())));
        obs.disconnect();
      }).observe(target, { childList: true, characterData: true, subtree: true });
    });
    await star.click();
    await page.waitForFunction(() => window.__t.paint, null, { timeout: 15000 });
    await waitFor(async () => (await probe.evaluate(() => window.__writes.length)) > w0, "the write");
    await waitFor(() => pushes.length > p0, "the push", 15000);
    const t = await page.evaluate(() => window.__t);
    const writtenAt = await probe.evaluate((n) => window.__writes[n], w0);
    await sleep(Math.max(0, t.click + 3000 - Date.now()));
    const swMs = await prof.stop();
    const pageCpuMs = Math.round(((await pageBusy()) - busy0) * 1000);
    const long = await page.evaluate((from) => window.__long.filter((l) => l.at >= from && l.at < from + 3000).reduce((s, l) => s + l.ms, 0), t.click);
    if ((await saved(TRACK)) !== expectOn) throw new Error(`the track should be ${expectOn ? "saved" : "un-saved"}`);
    return { star: t.star - t.click, paint: t.paint - t.click, written: writtenAt - t.click, pushed: pushes[p0] - t.click, longMs: Math.round(long), swMs, pageCpuMs };
  }

  const stars = [];
  const unstars = [];
  if (await saved(TRACK)) await clickStar(false);
  for (let r = 0; r < RUNS; r++) {
    stars.push(await clickStar(true));
    unstars.push(await clickStar(false));
  }

  // Typing tags in the chosen box of the other track: a tag, Enter (saves it), then 5 letters at once.
  const tags = (await probe.evaluate(() => chrome.storage.local.get("tags"))).tags;
  const typing = [];
  for (let r = 0; r < Math.max(2, Math.ceil(RUNS / 2)); r++) {
    await quiet();
    const tag = tags[(r * 7 + 3) % tags.length];
    const box = page.locator(`#tagger_${OTHER}`).locator("xpath=following-sibling::div[contains(@class,'chosen-container')]");
    await box.click();
    const input = box.locator("input");
    await input.type(tag.slice(0, 3), { delay: 60 });
    const prof = await swProfile(extId);
    if (process.env.PERF_PAGETOP) await pageCdp.send("Profiler.enable").then(() => pageCdp.send("Profiler.start"));
    const busy0 = await pageBusy();
    const t0 = Date.now();
    await page.keyboard.press("Enter");
    await page.keyboard.type("abcde", { delay: 70 });
    await sleep(2500);
    const swMs = await prof.stop();
    if (process.env.PERF_PAGETOP) profileBusy((await pageCdp.send("Profiler.stop")).profile, "page");
    const pageCpuMs = Math.round(((await pageBusy()) - busy0) * 1000);
    const ev = await page.evaluate((from) => window.__events.filter((e) => e.at >= from), t0);
    const keys = ev.filter((e) => e.name === "keydown");
    const long = await page.evaluate((from) => window.__long.filter((l) => l.at >= from).reduce((s, l) => s + l.ms, 0), t0);
    // the 5 letters: the slowest and each key's (keys under 16 ms aren't reported: 16 then)
    const letters = keys.slice(-5).map((e) => Math.round(e.ms));
    typing.push({ enterMs: Math.round((keys[0] || {}).ms || 0), letters, worstLetter: Math.max(16, ...letters), longMs: Math.round(long), swMs, pageCpuMs });
    // as it was: the track un-saved, the box empty
    await page.keyboard.press("Escape");
    await probe.evaluate((i) => chrome.storage.local.get("taggedItems").then(({ taggedItems }) => (delete taggedItems[i], chrome.storage.local.set({ taggedItems }))), OTHER);
    await page.reload();
    await page.waitForSelector(`#tagger_${OTHER}`, { state: "attached", timeout: 30000 });
  }

  // The pieces, each on its own (median of 5): the worker's get and set of the whole store, the diff it makes of
  // every item on each write (queueItemsDiff), a getTaggedItems round trip, a storage change reaching another
  // context, a push of one item to the server, the app's re-read of the items, the popup's state (its 404 path).
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  const timesOf = async (fn, n = 5) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await fn());
    return median(out);
  };
  const parts = {
    swGetMs: await timesOf(() => worker.evaluate(async () => { const t = performance.now(); await chrome.storage.local.get("taggedItems"); return Math.round(performance.now() - t); })),
    swSetMs: await timesOf(() => worker.evaluate(async () => { const { taggedItems } = await chrome.storage.local.get("taggedItems"); const t = performance.now(); await chrome.storage.local.set({ taggedItems }); return Math.round(performance.now() - t); })),
    swDiffMs: await timesOf(() => worker.evaluate(async () => {
      const { taggedItems } = await chrome.storage.local.get("taggedItems");
      const copy = JSON.parse(JSON.stringify(taggedItems));
      const t = performance.now();
      Object.keys(copy).forEach((id) => JSON.stringify(taggedItems[id]) !== JSON.stringify(copy[id]));
      Object.keys(taggedItems).forEach((id) => id in copy);
      return Math.round(performance.now() - t);
    })),
    roundTripMs: await timesOf(() => probe.evaluate(() => new Promise((r) => { const t = performance.now(); chrome.runtime.sendMessage({ type: "getTaggedItems" }, () => r(Math.round(performance.now() - t))); }))),
    changeReachesMs: await timesOf(async () => {
      await probe.evaluate(() => { window.__seen = null; chrome.storage.onChanged.addListener(function on(c) { if (c.taggedItems) { window.__seen = Date.now(); chrome.storage.onChanged.removeListener(on); } }); });
      const t = await worker.evaluate(async () => { const { taggedItems } = await chrome.storage.local.get("taggedItems"); taggedItems.__perf = { id: "__perf", at: Date.now() }; const t0 = Date.now(); await chrome.storage.local.set({ taggedItems }); delete taggedItems.__perf; await chrome.storage.local.set({ taggedItems }); return t0; });
      await waitFor(() => probe.evaluate(() => window.__seen), "the change");
      return (await probe.evaluate(() => window.__seen)) - t;
    }),
    pushOneMs: await timesOf(async () => { const t = Date.now(); await fetch(SERVER + "/api/sync/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: {}, deleted: [], full: false }) }); return Date.now() - t; }),
    appReReadMs: await timesOf(async () => { const t = Date.now(); await fetch(SERVER + "/api/items").then((r) => r.text()); return Date.now() - t; }),
    popupStateMs: await timesOf(() => probe.evaluate(() => new Promise((r) => { const t = performance.now(); chrome.runtime.sendMessage({ type: "popupState" }, () => r(Math.round(performance.now() - t))); })), 3),
  };
  await sleep(1500); // the test writes pushed

  const sum = (xs, k) => median(xs.map((x) => x[k]).filter((v) => v != null));
  const result = {
    label: LABEL,
    tabs: TABS,
    throttle: THROTTLE,
    cold: COLD,
    items: ITEMS,
    storeKB: Math.round(bytes / 1024),
    star: { onScreen: sum(stars, "star"), painted: sum(stars, "paint"), written: sum(stars, "written"), pushed: sum(stars, "pushed"), pageLongMs: sum(stars, "longMs"), pageCpuMs: sum(stars, "pageCpuMs"), swCpuMs: sum(stars, "swMs") },
    unstar: { onScreen: sum(unstars, "star"), painted: sum(unstars, "paint"), written: sum(unstars, "written"), pushed: sum(unstars, "pushed"), pageLongMs: sum(unstars, "longMs"), pageCpuMs: sum(unstars, "pageCpuMs"), swCpuMs: sum(unstars, "swMs") },
    typing: { enterMs: sum(typing, "enterMs"), worstLetterMs: sum(typing, "worstLetter"), letters: typing.map((t) => t.letters), pageLongMs: sum(typing, "longMs"), pageCpuMs: sum(typing, "pageCpuMs"), swCpuMs: sum(typing, "swMs") },
    parts,
    notFound: [...new Set(notFound)],
    raw: { stars, unstars, typing },
  };
  console.log(JSON.stringify(result, null, 1));
  if (process.env.PERF_OUT) fs.writeFileSync(process.env.PERF_OUT, JSON.stringify(result, null, 1));
} finally {
  await cleanup(context);
}

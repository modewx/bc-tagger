// The tagger with many Bandcamp tabs open, as the user works: PERF_BG_TABS background tabs and one in front, all of
// the user's own saved fan collection page (PERF_PAGE, a local file: never committed), plus a local app tab, with a
// store the size of the user's (about 1,070 items, 1.6 MB). For each action in the front tab (star, un-star, a tag
// typed then Enter then more letters) it records a browser-wide trace (CDP Tracing on the browser target) and
// reports the longest task on the browser's main thread (it routes input to every tab), the main-thread CPU of the
// background tabs together, of the front tab and of the extension, the time to the screen, and each key's latency.
// Everything local: the page and its files from disk, a server of our own, no network (unknown hosts don't resolve).
//
//   PERF_EXT=<an e2e build of the extension, pointed at PERF_PORT>  PERF_APP=<an app build>
//   PERF_SERVER_ROOT=<a checkout whose server/ runs>  PERF_PORT=8769  PERF_BG_TABS=30  PERF_THROTTLE=1 (all Bandcamp tabs)
//   PERF_RUNS=3  PERF_LABEL=…  PERF_OUT=<json>  PERF_PAGE=<saved .htm, its files beside it in <name>_files/>
//   node --experimental-websocket scripts/perf/tabs.perf.mjs
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
const BG_TABS = Number(process.env.PERF_BG_TABS ?? 30);
const RUNS = Number(process.env.PERF_RUNS || 3);
const THROTTLE = Number(process.env.PERF_THROTTLE || 1);
const LABEL = process.env.PERF_LABEL || path.basename(EXT);
const PAGE_FILE = process.env.PERF_PAGE || "/Users/alvaroh/Projects/auto-rekordbox/bandcamp-pages/complete_perf_test_page.htm";
const PAGE_FILES = PAGE_FILE.replace(/\.html?$/, "_files");
// Where the saved page is served (from PAGE_FILE, never fetched): a fan page's shape, not the user's name.
const PAGE_URL = process.env.PERF_PAGE_URL || "https://bandcamp.com/perf-fan";
const FILES_URL = `https://bandcamp.com/${path.basename(PAGE_FILES)}/`;
const CDP_PORT = 9339;
const ITEMS = 1070;
const EXPORT_JSON = process.env.PERF_EXPORT_JSON || "/Users/alvaroh/Projects/auto-rekordbox/tagger-test-db/bc-tagger-export-2026-10-26.json";
const NO_LIVE = "http://127.0.0.1:9";
const WINDOW_MS = 2500; // after an action: the extension's write (~400 ms) and push (~800 ms) are in it
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const api = (p) => fetch(SERVER + p).then((r) => r.json());
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".svg": "image/svg+xml" };

async function waitFor(fn, what, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(`timed out: ${what}`);
}

// --- CDP on the browser target (tracing) -----------------------------------------------------------------------
async function browserCdp() {
  const { webSocketDebuggerUrl } = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json());
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let id = 0;
  const waiting = new Map();
  const handlers = {};
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m.result || {});
      waiting.delete(m.id);
    } else if (m.method && handlers[m.method]) handlers[m.method](m.params);
  };
  return {
    send: (method, params = {}) =>
      new Promise((res) => {
        const my = ++id;
        waiting.set(my, res);
        ws.send(JSON.stringify({ id: my, method, params }));
      }),
    on: (method, fn) => (handlers[method] = fn),
    close: () => ws.close(),
  };
}

// Each tab says which it is in the trace (its renderer's events carry the pid): console.timeStamp("bct:<role>").
let roles = [];
async function traced(cdp, fn) {
  const events = [];
  cdp.on("Tracing.dataCollected", (p) => events.push(...p.value));
  const done = new Promise((res) => cdp.on("Tracing.tracingComplete", res));
  await cdp.send("Tracing.start", {
    traceConfig: {
      includedCategories: ["toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline", "v8", "__metadata"],
      recordMode: "recordAsMuchAsPossible",
    },
    transferMode: "ReportEvents",
  });
  await sleep(100);
  await Promise.all(roles.map(([p, role]) => p.evaluate((r) => console.timeStamp(`bct:${r}`), role).catch(() => {})));
  const out = await fn();
  await cdp.send("Tracing.end");
  await done;
  if (process.env.PERF_TRACE_DUMP) {
    traced.n = (traced.n || 0) + 1;
    fs.writeFileSync(`${process.env.PERF_TRACE_DUMP}.${traced.n}`, JSON.stringify(events)); // 1 idle, 2 star, 3 un-star, …
  }
  return { events, out };
}

// Per process (and its main thread): busy time and the longest top-level task in the trace.
function analyze(events) {
  const procName = {};
  const procLabel = {};
  const threadName = {};
  events.forEach((e) => {
    if (e.ph !== "M") return;
    if (e.name === "process_name") procName[e.pid] = e.args.name;
    if (e.name === "process_labels") procLabel[e.pid] = e.args.labels;
    if (e.name === "thread_name") threadName[`${e.pid}:${e.tid}`] = e.args.name;
  });
  const stats = {}; // pid -> {main: ms, longest: ms, gc: ms, any: ms}
  const st = (pid) => (stats[pid] = stats[pid] || { main: 0, longest: 0, gc: 0, worker: 0, input: false });
  events.forEach((e) => {
    const t = threadName[`${e.pid}:${e.tid}`] || "";
    const main = t === "CrBrowserMain" || t === "CrRendererMain";
    if (e.ph === "X" && e.cat && e.cat.includes("toplevel") && /RunTask/.test(e.name)) {
      const ms = (e.dur || 0) / 1000;
      if (main) {
        st(e.pid).main += ms;
        st(e.pid).longest = Math.max(st(e.pid).longest, ms);
      } else if (/ServiceWorker|Worker/.test(t)) st(e.pid).worker += ms;
    }
    if (e.ph === "X" && /GC|Scavenge|MarkCompact/.test(e.name) && main) st(e.pid).gc += (e.dur || 0) / 1000;
    if (e.name === "EventDispatch" && e.args && e.args.data && /click|keydown|pointerdown/.test(e.args.data.type)) st(e.pid).input = true;
  });
  const role = {}; // pid -> the roles of the tabs in it
  events.forEach((e) => {
    const m = e.name === "TimeStamp" && e.args && e.args.data && /^bct:(\w+)/.exec(e.args.data.message || "");
    if (m) (role[e.pid] = role[e.pid] || new Set()).add(m[1]);
  });
  const browser = Object.keys(procName).find((p) => procName[p] === "Browser");
  const renderers = Object.keys(procName).filter((p) => /Renderer/.test(procName[p]));
  const front = Object.keys(role).find((p) => role[p].has("front"));
  const bandcamp = Object.keys(role).filter((p) => role[p].has("bg") || role[p].has("front"));
  const ext = Object.keys(procName).filter((p) => procName[p] === "Extension Renderer");
  const app = Object.keys(role).filter((p) => role[p].has("app"));
  const sum = (ps, k) => Math.round(ps.reduce((a, p) => a + ((stats[p] || {})[k] || 0), 0));
  const bg = bandcamp.filter((p) => p !== front);
  return {
    browserLongestMs: Math.round((stats[browser] || {}).longest || 0),
    browserBusyMs: Math.round((stats[browser] || {}).main || 0),
    bgTabsCpuMs: sum(bg, "main"),
    bgTabsGcMs: sum(bg, "gc"),
    bgTabsBusy: bg.filter((p) => ((stats[p] || {}).main || 0) > 5).length,
    frontCpuMs: Math.round((stats[front] || {}).main || 0),
    frontLongestMs: Math.round((stats[front] || {}).longest || 0),
    extWorkerMs: sum(ext, "worker"),
    appCpuMs: sum(app, "main"),
    appLongestMs: Math.round(Math.max(0, ...app.map((p) => (stats[p] || {}).longest || 0))),
    processes: { bandcamp: bandcamp.length, renderers: renderers.length, frontShared: !!front && role[front].size > 1 },
  };
}

// The app tab's JS profile during an action (PERF_APPTOP): its top functions by self time.
async function profile(p) {
  const s = await p.context().newCDPSession(p);
  await s.send("Profiler.enable");
  await s.send("Profiler.start");
  return { stop: async () => (await s.send("Profiler.stop")).profile };
}
function profileTop(profile) {
  if (!profile) return "";
  const byId = Object.fromEntries(profile.nodes.map((n) => [n.id, n]));
  const self = {};
  profile.samples.forEach((id, i) => {
    const cf = byId[id].callFrame;
    if (cf.functionName === "(idle)") return;
    const k = `${cf.functionName || "(anon)"} ${String(cf.url).split("/").pop()}:${cf.lineNumber}`;
    self[k] = (self[k] || 0) + (profile.timeDeltas[i] || 0);
  });
  return Object.entries(self).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${Math.round(v / 1000)}ms ${k}`).join(" | ");
}

// --- set up -----------------------------------------------------------------------------------------------------
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "bc-tabs-data-"));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "bc-tabs-profile-"));
fs.writeFileSync(path.join(DATA, "settings.json"), JSON.stringify({ app_dist_dir: APP })); // the app build under test
const server = spawn(path.join(SERVER_ROOT, "server/bct"), ["serve", "--port", String(PORT)], {
  cwd: SERVER_ROOT,
  env: { ...process.env, BC_TAGGER_DATA_DIR: DATA, HTTPS_PROXY: NO_LIVE, HTTP_PROXY: NO_LIVE, ALL_PROXY: NO_LIVE, NO_PROXY: "127.0.0.1,localhost" },
  stdio: "ignore",
});
let context;
let cdp;
try {
  await waitFor(() => api("/api/health").then((h) => h.ok).catch(() => false), "the server");
  context = await chromium.launchPersistentContext(PROFILE, {
    channel: "chromium",
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    ],
  });
  // The saved page and its files, from disk; anything else on the web: refused.
  const pageHtml = fs.readFileSync(PAGE_FILE);
  await context.route(/^https?:\/\//, (route) => {
    const url = route.request().url();
    if (url.startsWith(SERVER) || url.startsWith(`http://localhost:${PORT}`)) return route.continue();
    if (url.split("?")[0] === PAGE_URL) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: pageHtml });
    if (url.startsWith(FILES_URL)) {
      const file = path.join(PAGE_FILES, decodeURIComponent(url.slice(FILES_URL.length).split("?")[0]));
      if (file.startsWith(PAGE_FILES) && fs.existsSync(file)) return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || "application/octet-stream", body: fs.readFileSync(file) });
    }
    return route.abort("blockedbyclient");
  });
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  const extId = new URL(sw.url()).host;
  const probe = await context.newPage();
  await probe.goto(`chrome-extension://${extId}/import.html`);
  const send = (msg) => probe.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, (res) => (void chrome.runtime.lastError, r(res)))), msg);

  // The store: the export, plus copies of its items up to ITEMS; written through the worker where it has a way in
  // (writeStorage), else straight to storage (older builds, whose worker listens to it).
  const exp = JSON.parse(fs.readFileSync(EXPORT_JSON, "utf8"));
  const items = { ...exp.taggedItems };
  const ids = Object.keys(exp.taggedItems);
  for (let i = 0; Object.keys(items).length < ITEMS; i++) {
    const src = exp.taggedItems[ids[i % ids.length]];
    const id = `t8${String(i).padStart(9, "0")}`;
    items[id] = { ...src, id, title: `${src.title} (copy ${i})`, order: ids.length + i + 1 };
  }
  const values = { taggedItems: items, tags: exp.tags || [] };
  const viaWorker = await send({ type: "writeStorage", values });
  if (!viaWorker || !viaWorker.ok) await probe.evaluate((v) => chrome.storage.local.set(v), values);
  await waitFor(() => api("/api/health").then((h) => h.items >= ITEMS), "the store on the server", 90000);
  await send({ type: "popupState" }); // the collections into the extension (one read)

  // The tabs: the app, the background Bandcamp tabs, then the front one (opened last: in front).
  const pushes = [];
  const appReads = []; // the app's reads of items: [time, url]
  context.on("request", (r) => {
    if (/\/api\/sync\/items$/.test(r.url())) pushes.push(Date.now());
    if (/\/api\/items(\?|$)/.test(r.url())) appReads.push([Date.now(), r.url().replace(SERVER, "")]);
  });
  const app = await context.newPage();
  await app.goto(SERVER + "/");
  await app.waitForSelector("#collectionTable tbody tr", { timeout: 60000 });
  const tabs = [];
  for (let i = 0; i < BG_TABS; i++) {
    const p = await context.newPage();
    await p.goto(PAGE_URL);
    tabs.push(p);
  }
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__events = [];
    new PerformanceObserver((l) =>
      l.getEntries().forEach((e) => window.__events.push({ name: e.name, at: performance.timeOrigin + e.startTime, ms: e.duration }))
    ).observe({ type: "event", durationThreshold: 16, buffered: true });
  });
  await page.goto(PAGE_URL);
  for (const p of [...tabs, page]) {
    await p.waitForSelector(".tagger-container .tag-button", { timeout: 60000 });
    await p.waitForFunction(() => document.querySelectorAll(".tagger-container .chosen-container").length === document.querySelectorAll(".tagger-container").length, null, { timeout: 60000 });
    if (THROTTLE > 1) await (await context.newCDPSession(p)).send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  }
  await page.bringToFront();
  // The page's header (a fixed web component) covers rows wherever they scroll: out of the way.
  const noHeader = () => page.addStyleTag({ content: "menu-bar, .menu-bar-wrapper { display: none !important; }" });
  await noHeader();
  const visible = await Promise.all([...tabs.slice(0, 3), page].map((p) => p.evaluate(() => document.visibilityState)));
  const widgetIds = await page.$$eval(".tag-button[data-item-id]", (bs) => bs.map((b) => b.dataset.itemId));
  const saved = new Set(Object.keys(items));
  const starId = widgetIds.find((id) => !saved.has(id)) || widgetIds[0];
  const tagId = widgetIds.filter((id) => id !== starId).find((id) => !saved.has(id)) || widgetIds[1];
  roles = [...tabs.map((p) => [p, "bg"]), [page, "front"], [app, "app"]];
  console.error(`[${LABEL}] ${BG_TABS} background tabs + front + app; throttle ${THROTTLE}x; widgets ${widgetIds.length}; star ${starId}, tags ${tagId}; visibility ${visible.join(",")}`);
  cdp = await browserCdp();
  // The page's sticky menu bar covers whatever is scrolled to the top: centered first.
  const center = (sel) => page.$eval(sel, (el) => el.scrollIntoView({ block: "center" }));
  // The tabs settle after loading (the page's own scripts, at THROTTLE x slower), then each action's window is
  // compared with the same window with no action at all (`idle`).
  await sleep(5000 * Math.min(THROTTLE, 3));
  const idleWindow = async () => analyze((await traced(cdp, () => sleep(WINDOW_MS))).events);
  const quiet = async () => {
    const n = pushes.length;
    await sleep(1500);
    if (pushes.length !== n) await sleep(1500);
  };

  // One click on the star: the page's time from the click to the next frame after the star changed.
  async function clickStar() {
    await page.evaluate((id) => {
      const b = document.querySelector(`.tag-button[data-item-id="${id}"]`);
      window.__star = { was: b.textContent.trim(), click: null, paint: null };
      b.addEventListener("click", (e) => (window.__star.click = e.timeStamp), { once: true, capture: true });
      new MutationObserver((_, obs) => {
        if (b.textContent.trim() !== window.__star.was) {
          obs.disconnect();
          requestAnimationFrame(() => setTimeout(() => (window.__star.paint = performance.now()), 0));
        }
      }).observe(b, { childList: true, characterData: true, subtree: true });
    }, starId);
    await center(`.tag-button[data-item-id="${starId}"]`);
    const appProf = process.env.PERF_APPTOP ? await profile(app) : null;
    const t0 = Date.now();
    const { events } = await traced(cdp, async () => {
      await page.click(`.tag-button[data-item-id="${starId}"]`);
      await sleep(WINDOW_MS);
    });
    const s = await page.evaluate(() => window.__star);
    if (process.env.PERF_APPTOP) {
      const top = profileTop((await appProf.stop()) || null);
      console.error(`[app top] ${top} | reads: ${appReads.filter(([t]) => t >= t0).map(([, u]) => u.slice(0, 60)).join(", ")}`);
    }
    const pushed = pushes.find((t) => t >= t0);
    return { screenMs: s.paint != null && s.click != null ? Math.round(s.paint - s.click) : null, pushedMs: pushed ? pushed - t0 : null, ...analyze(events) };
  }

  // A tag: its first letters, Enter (saves it), then 5 more letters; each key's latency (Event Timing).
  async function typeTag(r) {
    const tag = (exp.tags || ["must"])[(r * 7 + 3) % (exp.tags || ["must"]).length];
    const box = `#tagger_${tagId} + .chosen-container`;
    await center(box);
    await page.click(box);
    await page.type(`${box} input`, tag.slice(0, 3), { delay: 60 });
    const t0 = Date.now();
    const { events } = await traced(cdp, async () => {
      await page.keyboard.press("Enter");
      await page.keyboard.type("abcde", { delay: 70 });
      await sleep(WINDOW_MS);
    });
    const keys = await page.evaluate((from) => window.__events.filter((e) => e.at >= from && e.name === "keydown").map((e) => Math.round(e.ms)), t0);
    await page.keyboard.press("Escape");
    return { enterMs: keys[0] ?? 16, worstKeyMs: Math.max(16, ...keys.slice(1)), ...analyze(events) };
  }
  // The tagged item: unsaved again, from the probe (not measured).
  async function untag() {
    const gone = await send({ type: "getTaggedItems" });
    if (gone && gone[tagId]) {
      delete gone[tagId];
      const ok = await send({ type: "writeStorage", values: { taggedItems: gone } });
      if (!ok || !ok.ok) await probe.evaluate((v) => chrome.storage.local.set(v), { taggedItems: gone });
    }
    await page.reload();
    await page.waitForSelector(`#tagger_${tagId} + .chosen-container`, { timeout: 60000 });
    await noHeader();
    if (THROTTLE > 1) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  }

  const idle = [];
  const stars = [];
  const unstars = [];
  const typing = [];
  for (let r = 0; r < RUNS; r++) {
    await quiet();
    idle.push(await idleWindow());
    stars.push(await clickStar());
    await quiet();
    unstars.push(await clickStar());
  }
  for (let r = 0; r < RUNS; r++) {
    await quiet();
    typing.push(await typeTag(r));
    await untag();
  }
  const pick = (list) => {
    const keys = Object.keys(list[0] || {}).filter((k) => typeof list[0][k] === "number" || list[0][k] == null);
    return Object.fromEntries(keys.map((k) => [k, median(list.map((x) => x[k]))]));
  };
  const result = {
    label: LABEL,
    bgTabs: BG_TABS,
    throttle: THROTTLE,
    items: ITEMS,
    processes: (stars[0] || {}).processes,
    idle: pick(idle),
    star: pick(stars),
    unstar: pick(unstars),
    typing: pick(typing),
    raw: { idle, stars, unstars, typing },
  };
  console.log(JSON.stringify(result, null, 1));
  if (process.env.PERF_OUT) fs.writeFileSync(process.env.PERF_OUT, JSON.stringify(result, null, 1));
} finally {
  if (cdp) cdp.close();
  if (context) await context.close().catch(() => {});
  server.kill();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
}

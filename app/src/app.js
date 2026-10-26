// The local app's collection page: the shared collection page on top of the
// server's mirror, plus Owned / Located / Rekordbox columns and job buttons.

import { createCollectionPage } from "../../shared/collection/collectionPage";
import { HttpDataSource, apiJson } from "../../shared/datasource/HttpDataSource";
import { ExtensionBridge } from "../../shared/datasource/extensionBridge";
import { ServerEvents } from "../../shared/datasource/serverEvents";
import { Jobs, progressText, resultText } from "./jobs";
import { buildNav } from "./nav";
import { appColumns, localPlayUrl } from "./columns";
import { startDevReload } from "./devReload";
import { createStatusFilter, createSourceFilter, sourceOf, playableItem } from "./statusFilter";
import { runExport } from "./exportFlow";
import { createIndexStatus } from "./indexStatus";

const bridge = new ExtensionBridge();
const events = new ServerEvents();
const ds = new HttpDataSource({ bridge, events });
const jobs = new Jobs(events);
const nav = buildNav("collection");
const statusFilter = createStatusFilter();
const sourceFilter = createSourceFilter();

let page = null;

// Toolbar buttons that use the file index wait while the drive is scanned.
const SCAN_BLOCKED = ["locateLatest", "exportLatest", "locateShown", "exportShown"];
let indexStatus = null;

function updateScanBlocked() {
  const scanning = !!(indexStatus && indexStatus.isScanning());
  SCAN_BLOCKED.forEach((id) => {
    const b = document.getElementById(id);
    if (!b) return;
    b.disabled = scanning || b.dataset.running === "1";
    b.title = scanning ? "Waiting for the drive scan to finish" : b.dataset.title || "";
  });
}

// A toolbar button that runs a server job and reports progress in the status line.
function jobButton(id, label, title, start) {
  return {
    id,
    label,
    title,
    className: "job-btn",
    run: async (statusEl, button) => {
      if (SCAN_BLOCKED.includes(id) && indexStatus && indexStatus.isScanning()) return;
      button.dataset.running = "1";
      button.disabled = true;
      statusEl.textContent = `${label}: starting…`;
      let job;
      try {
        job = await start((j) => (statusEl.textContent = `${label}: ${progressText(j)}`));
      } catch (e) {
        job = { status: "error", error: e.message };
      }
      statusEl.textContent = `${label}: ${resultText(job)}`;
      delete button.dataset.running;
      button.disabled = false;
      updateScanBlocked();
      await page.reload();
      if (statusFilter.active() || sourceFilter.active()) page.refilter(); // e.g. newly located items join "Located"
    },
  };
}

// Ownership comes from the extension (live Bandcamp session) when it's
// connected, otherwise from the server's cookie-file fallback job.
async function refreshOwnership(onProgress) {
  if (bridge.connected) {
    onProgress({ status: "running", progress: { message: "fetching your Bandcamp collection via the extension" } });
    const result = await bridge.call("refreshOwnership", {}, 120000);
    return { status: "done", result };
  }
  return jobs.run("/api/ownership/refresh", {}, onProgress);
}

// "… shown" buttons act on the rows currently shown (search + tags + Show).
function shownIds() {
  return Object.keys(page.getView());
}

function locateShown(onProgress) {
  const ids = shownIds();
  if (!ids.length) return Promise.resolve({ status: "done", result: { message: "no items shown" } });
  return jobs.run("/api/locate", { ids }, onProgress);
}

// Export writes rekordbox, so preview it with a dry run and ask first.
function exportShown(onProgress) {
  const ids = shownIds();
  if (!ids.length) return Promise.resolve({ status: "done", result: { message: "no items shown" } });
  return runExport(jobs, { ids }, onProgress, { ask: true });
}

function updateShownButtons(shown) {
  const loc = document.getElementById("locateShown");
  const exp = document.getElementById("exportShown");
  if (loc) loc.textContent = `Locate shown (${shown})`;
  if (exp) exp.textContent = `Export shown (${shown})…`;
}

async function refreshHealth() {
  try {
    nav.setHealth(await apiJson("/api/health"));
    nav.setTarget(await apiJson("/api/settings"));
  } catch (e) {
    nav.setHealth(null, e);
  }
}

(async () => {
  // Ask the extension bridge first: it decides whether page fetches and
  // direct tag writes are available.
  await bridge.connect(1000);
  nav.setExtension(bridge.info);
  bridge.on("connect", (info) => nav.setExtension(info));

  page = createCollectionPage({
    dataSource: ds,
    topBarStart: nav.el,
    // By column id (v1 was by position and got shifted when Src was added).
    colWidthKey: "bc_app_col_widths_v2",
    extraColumns: appColumns({
      jobs,
      page: () => page,
      statusEl: () => page.statusEl,
    }),
    extraToolbarButtons: [
      jobButton("locateLatest", "Locate latest 10", "Match the 10 most recently tagged items to local files", (p) =>
        jobs.run("/api/locate", { latest: 10 }, p)
      ),
      jobButton(
        "exportLatest",
        "Export latest 10 to rekordbox",
        "Add the 10 most recent located items to rekordbox, one playlist per tag",
        (p) => runExport(jobs, { latest: 10 }, p) // asks first when the target is the main library
      ),
      jobButton("refreshOwnership", "Refresh ownership", "Check which items you own on Bandcamp", refreshOwnership),
      {
        id: "rescanDrive",
        label: "Rescan drive",
        title: "Full rescan of the music folders. Locate/Export only do a quick scan of files added since the items were tagged.",
        className: "job-btn",
        run: async (statusEl, button) => {
          button.disabled = true;
          await indexStatus.rescan(statusEl);
          button.disabled = false;
          await page.reload();
        },
      },
      jobButton("locateShown", "Locate shown", "Match the items shown below to local files", locateShown),
      jobButton(
        "exportShown",
        "Export shown",
        "Add the located items shown below to rekordbox (previews the changes first)",
        exportShown
      ),
    ],
    localPlayUrl,
    playable: playableItem,
    filterItem: (item) => sourceFilter.filterItem(item) && statusFilter.filterItem(item),
    clearExtraFilters: () => {
      statusFilter.reset();
      sourceFilter.reset();
    },
    // `other` rows have no Bandcamp page: the title searches Discogs.
    titleUrl: (item) =>
      sourceOf(item) === "other"
        ? item.discogs_url || `https://www.discogs.com/search/?type=all&q=${encodeURIComponent([item.artist, item.title].filter(Boolean).join(" "))}`
        : null,
    onView: (shown, total) => {
      statusFilter.onView(shown, total);
      updateShownButtons(shown);
    },
  });

  // File index status next to "Rescan drive".
  indexStatus = createIndexStatus({ events, jobs, onScanning: updateScanBlocked });
  SCAN_BLOCKED.forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.dataset.title = b.title;
  });
  document.getElementById("rescanDrive").after(indexStatus.el, indexStatus.hint);

  // Let the wide table scroll sideways on narrow screens.
  const table = document.getElementById("collectionTable");
  const scroller = document.createElement("div");
  scroller.id = "tableScroll";
  table.before(scroller);
  scroller.appendChild(table);
  sourceFilter.mount(document.getElementById("searchBar"), () => page.refilter());
  statusFilter.mount(document.getElementById("searchBar"), scroller, () => page.refilter());

  events.on("tags", () => refreshHealth());
  events.start();
  refreshHealth();
  setInterval(refreshHealth, 30000);
  startDevReload();

  try {
    await page.start();
  } catch (e) {
    page.statusEl.textContent = `Could not load the collection from the server: ${e.message}`;
  }
})();

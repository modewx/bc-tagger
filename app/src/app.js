// The local app's collection page: the shared collection page on top of the
// server's mirror, plus Owned / Located / Rekordbox columns and job buttons.

import { createCollectionPage } from "../../shared/collection/collectionPage";
import { HttpDataSource, apiJson } from "../../shared/datasource/HttpDataSource";
import { ExtensionBridge } from "../../shared/datasource/extensionBridge";
import { ServerEvents } from "../../shared/datasource/serverEvents";
import { Jobs, progressText, resultText } from "./jobs";
import { buildNav } from "./nav";
import { appColumns, downloadable, localPlayUrl } from "./columns";
import { downloadFlow } from "./downloads";
import { startDevReload } from "./devReload";
import { createStatusFilter, createSourceFilter, sourceOf, playableItem } from "./statusFilter";
import { runExport } from "./exportFlow";
import { createIndexStatus } from "./indexStatus";

const bridge = new ExtensionBridge();
const events = new ServerEvents();
const ds = new HttpDataSource({ bridge, events });
const jobs = new Jobs(events);
const nav = buildNav("collection");
nav.trackImports(events);
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

// The rows the bulk buttons act on: the selected ones (checkbox column) when
// there are any, else the rows currently shown (search + tags + Show).
const selected = new Set();
function selectedIds() {
  const items = page.getItems();
  return [...selected].filter((k) => k in items);
}
function targetIds() {
  const sel = selectedIds();
  return sel.length ? sel : Object.keys(page.getView());
}

function locateShown(onProgress) {
  const ids = targetIds();
  if (!ids.length) return Promise.resolve({ status: "done", result: { message: "nothing selected or shown" } });
  return jobs.run("/api/locate", { ids }, onProgress);
}

// Export writes rekordbox, so preview it with a dry run and ask first.
function exportShown(onProgress) {
  const ids = targetIds();
  if (!ids.length) return Promise.resolve({ status: "done", result: { message: "nothing selected or shown" } });
  return runExport(jobs, { ids }, onProgress, { ask: true });
}

function updateShownButtons() {
  const sel = selectedIds().length;
  const shown = Object.keys(page.getView()).length;
  const loc = document.getElementById("locateShown");
  const exp = document.getElementById("exportShown");
  const dl = document.getElementById("downloadOwnedMissing");
  const clear = document.getElementById("clearSelection");
  if (loc) loc.textContent = sel ? `Locate selected (${sel})` : `Locate shown (${shown})`;
  if (exp) exp.textContent = sel ? `Export Selected to RB (${sel})…` : `Export shown (${shown})…`;
  if (dl) dl.textContent = sel ? "Download owned missing (selected)" : "Download owned missing";
  if (clear) {
    clear.hidden = !sel;
    clear.textContent = `Clear selection (${sel})`;
  }
  syncSelectAll();
}

// After an import (the preview hands over what it imported and merged): those
// items selected, all others not, newest Modified first, ready for "Export
// Selected to RB". Consumed once.
const AFTER_IMPORT_KEY = "bc_after_import";
function takeImportedSelection() {
  let handoff = null;
  try {
    handoff = JSON.parse(localStorage.getItem(AFTER_IMPORT_KEY) || "null");
    localStorage.removeItem(AFTER_IMPORT_KEY);
  } catch (e) {
    return null;
  }
  if (!handoff || !Array.isArray(handoff.ids) || Date.now() - (handoff.at || 0) > 10 * 60 * 1000) return null;
  return handoff;
}

// The checkbox column: select rows for the bulk buttons; the header box
// selects / clears every row shown.
function syncSelectAll() {
  const all = document.getElementById("selectAll");
  if (!all) return;
  const shown = Object.keys(page.getView());
  const n = shown.filter((k) => selected.has(k)).length;
  all.checked = shown.length > 0 && n === shown.length;
  all.indeterminate = n > 0 && n < shown.length;
}

function selectColumn() {
  return {
    id: "sel",
    first: true,
    label: "",
    chooserLabel: "Selection",
    headerRender(th) {
      const all = document.createElement("input");
      all.type = "checkbox";
      all.id = "selectAll";
      all.title = "Select all shown / none";
      all.addEventListener("click", (e) => e.stopPropagation());
      all.addEventListener("change", () => {
        const shown = Object.keys(page.getView());
        shown.forEach((k) => (all.checked ? selected.add(k) : selected.delete(k)));
        document.querySelectorAll("#collectionTable .row-check").forEach((b) => (b.checked = selected.has(b.closest("tr").dataset.key)));
        updateShownButtons();
      });
      th.appendChild(all);
      setTimeout(syncSelectAll);
    },
    render(cell, key) {
      cell.classList.add("no-row-play", "sel-cell");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "row-check";
      box.checked = selected.has(key);
      box.addEventListener("change", () => {
        if (box.checked) selected.add(key);
        else selected.delete(key);
        updateShownButtons();
      });
      cell.appendChild(box);
    },
  };
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
    extraColumns: [
      selectColumn(),
      ...appColumns({
        jobs,
        events,
        page: () => page,
        statusEl: () => page.statusEl,
      }),
    ],
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
      jobButton("locateShown", "Locate", "Match the selected items (or, with none selected, the ones shown) to local files", locateShown),
      jobButton(
        "exportShown",
        "Export",
        "Add the selected located items (or, with none selected, the ones shown) to rekordbox (previews the changes first)",
        exportShown
      ),
      {
        id: "clearSelection",
        label: "Clear selection",
        title: "Unselect every row (the buttons then act on the rows shown)",
        run: () => {
          selected.clear();
          document.querySelectorAll("#collectionTable .row-check").forEach((b) => (b.checked = false));
          updateShownButtons();
        },
      },
      {
        id: "downloadOwnedMissing",
        label: "Download owned missing",
        title: "Download the selected (or shown) items you own on Bandcamp that aren't on your drive (shows the releases first)",
        className: "job-btn",
        run: async (statusEl, button) => {
          button.disabled = true;
          const items = page.getItems();
          const keys = targetIds().filter((k) => downloadable(items[k]));
          if (await downloadFlow(keys, "collection", { jobs, statusEl })) {
            await page.reload();
            keys.forEach((k) => page.refreshRow(k));
          }
          button.disabled = false;
        },
      },
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
        ? (item.links && item.links.discogs) || `https://www.discogs.com/search/?type=all&q=${encodeURIComponent([item.artist, item.title].filter(Boolean).join(" "))}`
        : null,
    onView: (shown, total) => {
      statusFilter.onView(shown, total);
      updateShownButtons();
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

  const imported = takeImportedSelection();
  if (imported) {
    // New Bandcamp items join as the extension adds them: they're selected as they appear.
    selected.clear();
    imported.ids.forEach((id) => selected.add(id));
    statusFilter.reset();
    sourceFilter.reset();
    page.refilter();
    page.sortBy("modified", -1);
    updateShownButtons();
    page.statusEl.textContent =
      `${imported.summary ? `${imported.summary} ` : ""}The ${imported.ids.length} imported and merged items are selected, ` +
      "newest Modified first: Export Selected to RB adds them to rekordbox.";
  }
})();

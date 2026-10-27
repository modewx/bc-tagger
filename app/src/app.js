// The local app's collection page: the shared collection page on top of the
// server's mirror, plus Owned / Located / Rekordbox columns and job buttons.

import { createCollectionPage } from "../../shared/collection/collectionPage";
import { HttpDataSource, apiJson } from "../../shared/datasource/HttpDataSource";
import { ExtensionBridge } from "../../shared/datasource/extensionBridge";
import { pageEvents } from "../../shared/datasource/serverEvents";
import { Jobs, progressText, resultText } from "./jobs";
import { buildNav } from "./nav";
import { appColumns, downloadable, isLocated, localPlayUrl, localDuration } from "./columns";
import { downloadFlow, fullReleasesToggle } from "./downloads";
import { startDevReload } from "./devReload";
import { createStatusFilter, createSourceFilter, sourceOf, playableItem } from "./statusFilter";
import { runExport } from "./exportFlow";
import { createIndexStatus } from "./indexStatus";
import { logNote } from "./importLogs";
import { selectLastImportButton } from "./lastImport";
import { tickTargets } from "./rowTicks";

const bridge = new ExtensionBridge();
const events = pageEvents();
const ds = new HttpDataSource({ bridge, events });
const jobs = new Jobs(events);
const nav = buildNav("collection");
nav.trackImports(events);
const statusFilter = createStatusFilter();
const sourceFilter = createSourceFilter();
const fullReleases = fullReleasesToggle();

let page = null;

// Toolbar buttons that use the file index wait while the drive is scanned.
const SCAN_BLOCKED = ["locateShown", "exportShown"];
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
// there are any, else the rows currently shown (search + tags + Show). The
// selection is kept in this browser across pages and reloads.
const SELECTION_KEY = "bc_app_selection";
const selected = new Set(
  (() => {
    try {
      const ids = JSON.parse(localStorage.getItem(SELECTION_KEY) || "[]");
      return Array.isArray(ids) ? ids : [];
    } catch (e) {
      return [];
    }
  })()
);
let lastTicked = null; // for Shift-click ranges of checkboxes
function saveSelection() {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify([...selected]));
  } catch (e) {
    /* not kept */
  }
}
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
  // Export sends located items only: count those, and say how many selected ones are skipped.
  const items = page.getItems();
  const located = selectedIds().filter((k) => isLocated(items[k])).length;
  if (exp) exp.textContent = sel ? `Export selected to RB (${located})…` : `Export shown (${shown})…`;
  const hint = document.getElementById("exportHint");
  if (hint) hint.textContent = sel > located ? `${sel - located} not located ${sel - located > 1 ? "are" : "is"} skipped` : "";
  if (dl) dl.textContent = sel ? "Download owned missing (selected)" : "Download owned missing";
  if (clear) {
    clear.hidden = !sel;
    clear.textContent = `Clear selection (${sel})`;
  }
  syncSelectAll();
}

// After an import (the preview hands over what it imported and merged): those
// items selected, all others not, newest Modified first, ready for "Export
// selected to RB". Consumed once.
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

// Exactly these items selected (all filters off), newest Modified first: after
// an import, and "Select last import". Items not in the collection yet (new
// Bandcamp items the extension is still adding) are selected as they appear.
// Returns how many are in the collection now.
function selectOnly(ids) {
  selected.clear();
  ids.forEach((id) => selected.add(id));
  saveSelection();
  statusFilter.reset();
  sourceFilter.reset();
  page.refilter();
  page.sortBy("modified", -1);
  updateShownButtons();
  const items = page.getItems();
  return ids.filter((id) => id in items).length;
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
        saveSelection();
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
      // A tick on a highlighted row ticks every highlighted row; Shift ticks a range.
      box.addEventListener("click", (e) => {
        const keys = tickTargets(page, key, e.shiftKey, lastTicked);
        lastTicked = key;
        keys.forEach((k) => {
          if (box.checked) selected.add(k);
          else selected.delete(k);
          const other = document.querySelector(`#collectionTable tr[data-key="${k}"] .row-check`);
          if (other) other.checked = box.checked;
        });
        saveSelection();
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
  // The extension bridge answers in the background (up to 1 s): page fetches and
  // tag writes check it when they run, so the collection doesn't wait for it.
  bridge.connect(1000).then(() => nav.setExtension(bridge.info));
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
    // Toolbar: what to do with the selected (or shown) items; the drive; Tools ▾ (maintenance) and Columns ▾.
    // Locate / Export latest 10 are in Settings → Test.
    extraToolbarButtons: [
      jobButton("locateShown", "Locate", "Match the selected items (or, with none selected, the ones shown) to local files", locateShown),
      jobButton(
        "exportShown",
        "Export",
        "Add the selected located items (or, with none selected, the ones shown) to rekordbox (previews the changes first)",
        exportShown
      ),
      {
        id: "downloadOwnedMissing",
        label: "Download owned missing",
        title:
          "Download the selected (or shown) items you own on Bandcamp that aren't on your drive. " +
          "With Download Full Releases ticked: each track's whole album or EP.",
        className: "job-btn",
        run: async (statusEl, button) => {
          button.disabled = true;
          const items = page.getItems();
          const keys = targetIds().filter((k) => downloadable(items[k]));
          if (await downloadFlow(keys, "collection", { jobs, statusEl, fullRelease: fullReleases.checked() })) {
            await page.reload();
            keys.forEach((k) => page.refreshRow(k));
          }
          button.disabled = false;
        },
      },
      selectLastImportButton((ids) => selectOnly(ids)),
      {
        id: "clearSelection",
        label: "Clear selection",
        title: "Unselect every row (the buttons then act on the rows shown)",
        run: () => {
          selected.clear();
          saveSelection();
          document.querySelectorAll("#collectionTable .row-check").forEach((b) => (b.checked = false));
          updateShownButtons();
        },
      },
      {
        id: "rescanDrive",
        label: "Rescan drive",
        title: "Full rescan of the music folders. Locate/Export only do a quick scan of files added since the items were tagged.",
        className: "job-btn",
        sepBefore: true,
        run: async (statusEl, button) => {
          button.disabled = true;
          await indexStatus.rescan(statusEl);
          button.disabled = false;
          await page.reload();
        },
      },
      { ...jobButton("refreshOwnership", "Refresh ownership", "Check which items you own on Bandcamp", refreshOwnership), group: "tools" },
    ],
    localPlayUrl,
    localDuration,
    playable: playableItem,
    autoFetchArt: false, // no Bandcamp fetches on scroll: stored art only (Tools → Refresh thumbnails)
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
    onItemsUpdated: () => updateShownButtons(), // e.g. a selected item got located
  });

  // File index status next to "Rescan drive".
  indexStatus = createIndexStatus({ events, jobs, onScanning: updateScanBlocked });
  SCAN_BLOCKED.forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.dataset.title = b.title;
  });
  document.getElementById("rescanDrive").after(indexStatus.el, indexStatus.hint);
  document.getElementById("downloadOwnedMissing").after(fullReleases.el);
  const exportHint = document.createElement("span");
  exportHint.id = "exportHint";
  exportHint.className = "export-hint";
  document.getElementById("exportShown").after(exportHint);
  updateShownButtons();

  // Let the wide table scroll sideways on narrow screens.
  const table = document.getElementById("collectionTable");
  const scroller = document.createElement("div");
  scroller.id = "tableScroll";
  table.before(scroller);
  scroller.appendChild(table);
  sourceFilter.mount(document.getElementById("searchBar"), () => page.refilter());
  statusFilter.mount(document.getElementById("searchBar"), scroller, () => page.refilter());

  events.on("tags", () => refreshHealth());
  // Back from a hidden tab (its stream was closed): catch up.
  events.on("resume", () => {
    page.reload();
    indexStatus.refresh();
    refreshHealth();
  });
  refreshHealth();
  setInterval(refreshHealth, 30000);
  startDevReload();

  try {
    await page.start();
  } catch (e) {
    page.statusEl.textContent = `Could not load the collection from the server: ${e.message}`;
  }
  events.start(); // after the items: the stream holds a connection for good

  // The kept selection: only items still in the collection.
  const items = page.getItems();
  [...selected].forEach((k) => !(k in items) && selected.delete(k));
  saveSelection();
  updateShownButtons();

  const imported = takeImportedSelection();
  if (imported) {
    // New Bandcamp items join as the extension adds them: they're selected as they appear.
    selectOnly(imported.ids);
    page.statusEl.textContent =
      `${imported.summary ? `${imported.summary} ` : ""}The ${imported.ids.length} imported and merged items are selected, ` +
      "newest Modified first: Export Selected to RB adds them to rekordbox.";
    const note = logNote(imported.log);
    if (note) scroller.before(note);
  }
})();

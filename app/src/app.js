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
import { createStatusFilter } from "./statusFilter";

const bridge = new ExtensionBridge();
const events = new ServerEvents();
const ds = new HttpDataSource({ bridge, events });
const jobs = new Jobs(events);
const nav = buildNav("collection");
const statusFilter = createStatusFilter();

let page = null;

// A toolbar button that runs a server job and reports progress in the status line.
function jobButton(id, label, title, start) {
  return {
    id,
    label,
    title,
    className: "job-btn",
    run: async (statusEl, button) => {
      button.disabled = true;
      statusEl.textContent = `${label}: starting…`;
      let job;
      try {
        job = await start((j) => (statusEl.textContent = `${label}: ${progressText(j)}`));
      } catch (e) {
        job = { status: "error", error: e.message };
      }
      statusEl.textContent = `${label}: ${resultText(job)}`;
      button.disabled = false;
      await page.reload();
      if (statusFilter.active()) page.refilter(); // e.g. newly located items join "Located"
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
async function exportShown(onProgress) {
  const ids = shownIds();
  if (!ids.length) return { status: "done", result: { message: "no items shown" } };
  const preview = await jobs.run("/api/rekordbox/export", { ids, dry_run: true }, (j) =>
    onProgress({ ...j, progress: { ...j.progress, message: `preview · ${(j.progress || {}).message || ""}` } })
  );
  if (preview.status !== "done") return preview;
  const d = preview.result || {};
  const n = (v) => (Array.isArray(v) ? v.length : v || 0);
  if (!d.changed) {
    const none = n(d.skipped_items) >= n(d.selected_items); // selected = all shown; skipped = not located
    return { status: "done", result: { message: none ? "none of the shown items are located" : "rekordbox is already up to date" } };
  }
  const lines = [
    `Export ${ids.length} shown items to rekordbox?`,
    `${d.db_path || ""}`,
    "",
    `• ${n(d.content_added)} tracks added to the collection (${n(d.content_existing)} already there)`,
    `• ${n(d.playlists_created)} new playlists in "${(d.folder || {}).name || ""}"`,
    `• ${n(d.entries_added)} playlist entries added, ${n(d.entries_removed)} removed`,
  ];
  if (n(d.skipped_items)) lines.push(`• ${n(d.skipped_items)} items skipped (not located)`);
  if (n(d.failed_files)) lines.push(`• ${n(d.failed_files)} files rekordbox can't take`);
  if (!confirm(lines.join("\n"))) return { status: "done", result: { message: "cancelled" } };
  return jobs.run("/api/rekordbox/export", { ids }, onProgress);
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
    colWidthKey: "bc_app_col_widths_v1",
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
        (p) => jobs.run("/api/rekordbox/export", { latest: 10 }, p)
      ),
      jobButton("refreshOwnership", "Refresh ownership", "Check which items you own on Bandcamp", refreshOwnership),
      jobButton("locateShown", "Locate shown", "Match the items shown below to local files", locateShown),
      jobButton(
        "exportShown",
        "Export shown",
        "Add the located items shown below to rekordbox (previews the changes first)",
        exportShown
      ),
    ],
    localPlayUrl,
    filterItem: statusFilter.filterItem,
    onView: (shown, total) => {
      statusFilter.onView(shown, total);
      updateShownButtons(shown);
    },
  });

  // Let the wide table scroll sideways on narrow screens.
  const table = document.getElementById("collectionTable");
  const scroller = document.createElement("div");
  scroller.id = "tableScroll";
  table.before(scroller);
  scroller.appendChild(table);
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

// The local app's collection page: the shared collection page on top of the
// server's mirror, plus Owned / Located / Rekordbox columns and job buttons.

import { createCollectionPage } from "../../shared/collection/collectionPage";
import { HttpDataSource, apiJson } from "../../shared/datasource/HttpDataSource";
import { ExtensionBridge } from "../../shared/datasource/extensionBridge";
import { ServerEvents } from "../../shared/datasource/serverEvents";
import { Jobs, progressText, resultText } from "./jobs";
import { buildNav } from "./nav";
import { appColumns, localPlayUrl } from "./columns";

const bridge = new ExtensionBridge();
const events = new ServerEvents();
const ds = new HttpDataSource({ bridge, events });
const jobs = new Jobs(events);
const nav = buildNav("collection");

let page = null;
let settings = null;

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
  const connecting = bridge.connect(1000);
  settings = await apiJson("/api/settings").catch(() => null);
  await connecting;
  nav.setExtension(bridge.info);
  bridge.on("connect", (info) => nav.setExtension(info));

  page = createCollectionPage({
    dataSource: ds,
    topBarStart: nav.el,
    colWidthKey: "bc_app_col_widths_v1",
    extraColumns: appColumns({
      jobs,
      page: () => page,
      settings: () => settings,
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
    ],
    localPlayUrl,
  });

  // Let the wide table scroll sideways on narrow screens.
  const table = document.getElementById("collectionTable");
  const scroller = document.createElement("div");
  scroller.id = "tableScroll";
  table.before(scroller);
  scroller.appendChild(table);

  events.on("tags", () => refreshHealth());
  events.start();
  refreshHealth();
  setInterval(refreshHealth, 30000);

  try {
    await page.start();
  } catch (e) {
    page.statusEl.textContent = `Could not load the collection from the server: ${e.message}`;
  }
})();

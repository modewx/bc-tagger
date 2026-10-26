// Import preview (/import/?batch=<id>): the batch's rows in the shared
// collection table, with a checkbox per row, the Bandcamp match and its
// alternatives, located state, flags/notes, editable tags (kept in the batch),
// tints (not located: light red; duplicate: cream yellow) and "Import selected".

import { createCollectionPage } from "../../shared/collection/collectionPage";
import { HttpDataSource, apiJson } from "../../shared/datasource/HttpDataSource";
import { ExtensionBridge } from "../../shared/datasource/extensionBridge";
import { ServerEvents } from "../../shared/datasource/serverEvents";
import { Jobs, progressText } from "./jobs";
import { buildNav } from "./nav";
import { sourceColumn, localPlayUrl } from "./columns";
import { openPopover, closePopover } from "./popover";
import { getBatch, updateRow, commitBatch, discardBatch, rowToItem } from "./importApi";
import { statsLine } from "./importTab";
import { playableItem } from "./statusFilter";

const batchId = new URLSearchParams(location.search).get("batch");
const bridge = new ExtensionBridge();
const events = new ServerEvents();
const jobs = new Jobs(events);
const nav = buildNav("import");

let batch = null;
let page = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const rowOf = (item) => item._row;
const pct = (c) => (typeof c === "number" ? `${Math.round(c <= 1 ? c * 100 : c)}%` : "");

// Rows of the batch as table items. Edits go to the batch, not the collection.
class ImportDataSource extends HttpDataSource {
  async getItems() {
    batch = await getBatch(batchId);
    renderInfo();
    const items = {};
    batch.rows.forEach((r) => {
      const it = rowToItem(r);
      items[it.id] = it;
    });
    return items;
  }
  async setItemTags(key, tags) {
    try {
      await updateRow(batchId, key.slice(1), { tags });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  // Refreshed stream links belong to the preview only.
  persistFiles() {
    return Promise.resolve();
  }
  persistArt() {
    return Promise.resolve();
  }
  persistFields() {
    return Promise.resolve();
  }
  onItemsChanged(cb) {
    let t = null;
    const later = () => {
      clearTimeout(t);
      t = setTimeout(cb, 300);
    };
    this.events.on("import", (d) => (!d || !d.batch_id || d.batch_id === batchId) && later());
  }
}
const ds = new ImportDataSource({ bridge, events });

// --- header: process info, stats, actions ---------------------------------------

const info = el("div", "import-info");
const title = el("h1", "import-title", "Import preview");
const stats = el("div", "import-stats");
const proc = el("div", "import-process");
info.append(title, stats, proc);

function renderInfo() {
  if (!batch) return;
  title.textContent = `Import preview · ${batch.source || batch.id}`;
  stats.textContent = statsLine(batch.stats);
  const checked = batch.rows.filter((r) => r.checked).length;
  const btn = document.getElementById("importSelected");
  if (btn) {
    btn.textContent = `Import selected (${checked})`;
    btn.disabled = !checked || !!batch.committed_at;
  }
  proc.textContent = batch.committed_at
    ? `Imported ${new Date(batch.committed_at).toLocaleString()}.`
    : batch.status && !/done|ready|resolved|complete/.test(batch.status)
    ? `Processing: ${batch.status}`
    : "Review the rows, fix matches and tags, then Import selected. Rows found on Bandcamp are added to the tagger; the rest to Other.";
}

// --- columns ---------------------------------------------------------------------

function selectColumn() {
  return {
    id: "sel",
    first: true,
    label: "",
    headerRender(th) {
      const all = document.createElement("input");
      all.type = "checkbox";
      all.id = "selectAll";
      all.title = "Select all / none";
      const rows = batch ? batch.rows : [];
      const n = rows.filter((r) => r.checked).length;
      all.checked = rows.length > 0 && n === rows.length;
      all.indeterminate = n > 0 && n < rows.length;
      all.addEventListener("click", (e) => e.stopPropagation());
      all.addEventListener("change", () => setChecked(batch.rows, all.checked));
      th.appendChild(all);
    },
    render(cell, key, item) {
      cell.classList.add("no-row-play", "sel-cell");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "row-check";
      box.checked = rowOf(item).checked;
      box.addEventListener("change", () => setChecked([rowOf(item)], box.checked));
      cell.appendChild(box);
    },
  };
}

async function setChecked(rows, checked) {
  rows.forEach((r) => (r.checked = checked));
  rows.forEach((r) => {
    const box = document.querySelector(`tr[data-key="r${r.n}"] .row-check`);
    if (box) box.checked = checked;
  });
  syncSelectAll();
  renderInfo();
  // Save to the batch, a few at a time.
  const queue = rows.slice();
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift();
      await updateRow(batchId, r.n, { checked }).catch((e) => console.warn("[import] row", r.n, e.message));
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

function syncSelectAll() {
  const all = document.getElementById("selectAll");
  if (!all || !batch) return;
  const n = batch.rows.filter((r) => r.checked).length;
  all.checked = n === batch.rows.length;
  all.indeterminate = n > 0 && n < batch.rows.length;
}

async function patchRow(row, patch, note) {
  closePopover();
  page.statusEl.textContent = note || "Saving…";
  try {
    await updateRow(batchId, row.n, patch);
    page.statusEl.textContent = "";
  } catch (e) {
    page.statusEl.textContent = `Not saved: ${e.message}`;
  }
  await page.reload();
  page.refreshRow(`r${row.n}`);
}

function candidateLabel(c) {
  return [c.title, c.artist || c.band_name].filter(Boolean).join(" — ") || c.url || "?";
}

function matchPopover(anchor, row) {
  openPopover(anchor, (pop) => {
    pop.appendChild(el("div", "pop-head", row.source === "bandcamp" ? "Bandcamp match" : "Not on Bandcamp"));
    pop.appendChild(el("div", "pop-meta", `From the file (line ${row.line ?? "?"}): ${row.raw || ""}`));
    const cands = row.match.candidates.length ? row.match.candidates : row.match.candidate ? [row.match.candidate] : [];
    cands.forEach((c, i) => {
      const r = el("div", "pop-file");
      const name = el("a", "pop-file-name", candidateLabel(c));
      if (c.url) {
        name.href = c.url;
        name.target = "_blank";
      }
      r.append(name, el("div", "pop-file-meta", [c.kind || c.type, pct(c.confidence ?? c.score)].filter(Boolean).join(" · ")));
      const chosen = row.match.candidate && (row.match.candidate.id ?? row.match.candidate.url) === (c.id ?? c.url);
      const btns = el("div", "pop-actions");
      const use = el("button", chosen ? "" : "primary", chosen ? "Chosen" : "Use this");
      use.disabled = chosen;
      use.addEventListener("click", () => patchRow(row, { candidate: c.id ?? c.url ?? i }, "Fetching the Bandcamp page…"));
      btns.appendChild(use);
      r.appendChild(btns);
      pop.appendChild(r);
    });
    const foot = el("div", "pop-actions");
    if (row.source === "bandcamp") {
      const none = el("button", "danger", "Not on Bandcamp");
      none.addEventListener("click", () => patchRow(row, { candidate: null }));
      foot.appendChild(none);
    }
    const manual = el("button", "", "Set manually…");
    manual.addEventListener("click", () => {
      pop.innerHTML = "";
      pop.appendChild(el("div", "pop-head", "Artist and title"));
      const a = document.createElement("input");
      a.placeholder = "Artist";
      a.value = row.artist || "";
      const t = document.createElement("input");
      t.placeholder = "Title";
      t.value = row.title || "";
      [a, t].forEach((i) => (i.className = "pop-input"));
      const save = el("button", "primary", "Look up again");
      save.addEventListener("click", () => patchRow(row, { artist: a.value.trim() || null, title: t.value.trim() }, "Looking up on Bandcamp…"));
      const actions = el("div", "pop-actions");
      actions.appendChild(save);
      pop.append(a, t, actions);
      t.focus();
    });
    foot.appendChild(manual);
    const q = encodeURIComponent([row.artist, row.title].filter(Boolean).join(" "));
    const search = el("a", "pop-link", "Search Bandcamp");
    search.href = `https://bandcamp.com/search?q=${q}`;
    search.target = "_blank";
    foot.appendChild(search);
    pop.appendChild(foot);
  });
}

function matchColumn() {
  return {
    id: "match",
    label: "Match",
    after: "artist",
    sortKey: "match",
    compare: (a, b) => (rowOf(a).match.confidence ?? -1) - (rowOf(b).match.confidence ?? -1),
    render(cell, key, item) {
      cell.classList.add("no-row-play", "match-cell");
      const row = rowOf(item);
      const c = row.match.candidate;
      const chip = el("button", "chip " + (row.source === "bandcamp" ? "match-bc" : "match-none"));
      chip.textContent = row.source === "bandcamp" && c ? `${pct(c.confidence ?? row.match.confidence) || "match"}` : "none";
      chip.title = c ? candidateLabel(c) : "Not found on Bandcamp: click to pick a candidate or set it manually";
      chip.addEventListener("click", () => matchPopover(chip, row));
      cell.appendChild(chip);
      const alts = row.match.candidates.length;
      if (alts > 1) cell.appendChild(el("span", "muted", ` ${alts} options`));
    },
  };
}

function locatedColumn() {
  return {
    id: "located",
    label: "Located",
    after: "match",
    sortKey: "located",
    compare: (a, b) => Number(!!(a.local && a.local.status === "located")) - Number(!!(b.local && b.local.status === "located")),
    render(cell, key, item) {
      cell.classList.add("status-cell");
      const local = item.local || { status: "unknown" };
      const best = local.best || {};
      const files = Array.isArray(best.tracks) && best.tracks.length ? best.tracks : best.path ? [best] : [];
      const label = local.status === "located" ? `✓ ${files.length > 1 ? files.length + " files" : String(best.format || "file").toUpperCase()}` : local.status === "missing" ? "✗" : "–";
      const chip = el("span", `chip loc-${local.status}`, label);
      chip.title = files.map((f) => f.path).join("\n") || (local.status === "missing" ? "Not found in the local folders" : "Not located");
      cell.appendChild(chip);
    },
  };
}

function notesColumn() {
  return {
    id: "notes",
    label: "Notes",
    after: "located",
    render(cell, key, item) {
      cell.classList.add("status-cell", "notes-cell");
      const row = rowOf(item);
      if (row.duplicate) {
        const d = el("span", "note-icon dup-icon", "⧉");
        d.title = `Already in your collection (${row.duplicate}): its tags will be merged.`;
        cell.appendChild(d);
      }
      if (row.flags.length || row.note) {
        const f = el("span", "note-icon flag-icon", "⚑");
        f.title = [row.flags.length ? `Flags: ${row.flags.join(", ")}` : "", row.note ? `Note: ${row.note}` : "", row.raw ? `Line ${row.line}: ${row.raw}` : ""]
          .filter(Boolean)
          .join("\n");
        cell.appendChild(f);
        if (row.flags.length) cell.appendChild(el("span", "muted", ` ${row.flags.length}`));
      }
    },
  };
}

// --- actions ----------------------------------------------------------------------

async function importSelected(statusEl, button) {
  const n = batch.rows.filter((r) => r.checked).length;
  if (!confirm(`Import ${n} selected rows? Rows found on Bandcamp go to the tagger (the extension adds them), the rest to Other. Duplicates merge tags.`)) return;
  button.disabled = true;
  statusEl.textContent = "Importing…";
  try {
    const res = await commitBatch(batchId);
    const job = res && res.job_id ? await jobs.watch(res.job_id, (j) => (statusEl.textContent = `Importing: ${progressText(j)}`)) : null;
    const r = (job && job.result) || res || {};
    // Let the extension pick up the new Bandcamp items right away.
    if (bridge.connected) await bridge.call("syncNow", {}).catch(() => {});
    statusEl.textContent =
      "Imported: " +
      Object.entries(r)
        .filter(([, v]) => typeof v === "number")
        .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`)
        .join(", ");
    const link = el("a", "", "Open the collection →");
    link.href = "/";
    statusEl.append(" ", link);
  } catch (e) {
    statusEl.textContent = `Import failed: ${e.message}`;
    button.disabled = false;
  }
  await page.reload();
  renderInfo();
}

async function discard(statusEl) {
  if (!confirm("Discard this import? Nothing is added to your collection.")) return;
  await discardBatch(batchId).catch((e) => (statusEl.textContent = e.message));
  location.href = "/settings/#import";
}

// --- start --------------------------------------------------------------------------

(async () => {
  if (!batchId) {
    document.body.textContent = "No import selected. Start one in Settings → Import.";
    return;
  }
  await bridge.connect(1000);
  nav.setExtension(bridge.info);
  const top = el("div", "import-top");
  top.append(nav.el, info);
  page = createCollectionPage({
    dataSource: ds,
    topBarStart: top,
    colWidthKey: "bc_import_col_widths_v2",
    baseToolbar: false,
    extraColumns: [selectColumn(), sourceColumn(), matchColumn(), locatedColumn(), notesColumn()],
    extraToolbarButtons: [
      { id: "importSelected", label: "Import selected", className: "job-btn", run: importSelected },
      { id: "discardImport", label: "Discard", run: discard },
    ],
    localPlayUrl,
    playable: playableItem,
    rowClass: (item) => {
      const row = rowOf(item);
      if (!row) return "";
      if (row.duplicate) return "row-duplicate";
      return item.local && item.local.status === "located" ? "" : "row-missing";
    },
    titleUrl: (item) => (item.source === "other" ? null : item.url || item.item_url || null),
  });
  const table = document.getElementById("collectionTable");
  const scroller = el("div");
  scroller.id = "tableScroll";
  table.before(scroller);
  scroller.appendChild(table);
  events.on("job", (j) => {
    if (batch && j && j.id === batch.job_id) {
      proc.textContent = `Processing: ${progressText(j)}`;
      if (j.status === "done" || j.status === "error") page.reload().then(renderInfo);
    }
  });
  events.start();
  await page.start();
  renderInfo();
  nav.setHealth(await apiJson("/api/health").catch(() => null));
})();

// Import preview (/import/?batch=<id>): the batch's rows in the shared
// collection table, with a checkbox per row, the release (album, position,
// track number), the Bandcamp match (where it came from, alternatives, Open on
// Bandcamp, a pasted URL), located state, flags/notes (rows to confirm stand
// out), editable tags (kept in the batch), tints (not located: light red;
// duplicate: cream yellow), a Show filter and "Import selected".

import { createCollectionPage } from "../../shared/collection/collectionPage";
import { HttpDataSource, apiJson } from "../../shared/datasource/HttpDataSource";
import { ExtensionBridge } from "../../shared/datasource/extensionBridge";
import { ServerEvents } from "../../shared/datasource/serverEvents";
import { Jobs, progressText } from "./jobs";
import { buildNav } from "./nav";
import { sourceColumn, localPlayUrl } from "./columns";
import { openPopover, closePopover } from "./popover";
import { getBatch, updateRow, commitBatch, discardBatch, resumeLookups, rowToItem, matchSource, bandcampSearchUrl, openOnBandcampUrl, cleanBandcampUrl } from "./importApi";
import { statsLine } from "./importTab";
import { rememberImport } from "./openImport";
import { playableItem } from "./statusFilter";

const batchId = new URLSearchParams(location.search).get("batch");
document.body.classList.add("import-page");
const bridge = new ExtensionBridge();
const events = new ServerEvents();
const jobs = new Jobs(events);
const nav = buildNav("import");
nav.trackImports(events);

let batch = null;
let page = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const rowOf = (item) => item.importRow;
// The batch's current row for an item (a reload replaces the row objects that
// event handlers of other rows captured).
const rowNow = (item) => (batch && batch.rows.find((r) => r.n === item.importRow.n)) || item.importRow;
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
  // No Bandcamp page fetches from the preview (no lazy thumbnails or stream
  // lookups for rows matched by URL): Bandcamp lookup is paused, and a long
  // list would mean a fetch per row.
  canFetchPages() {
    return false;
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
const pending = el("div", "import-pending");
const unavailable = el("div", "import-unavailable");
unavailable.id = "lookupUnavailable";
const proc = el("div", "import-process");

// Show: narrow the rows to what needs a look.
const SHOW = [
  ["all", "All rows", () => true],
  ["confirm", "To confirm", (r) => r.needsConfirmation],
  ["unmatched", "No Bandcamp match", (r) => r.source !== "bandcamp"],
  ["unavailable", "Bandcamp lookup unavailable", (r) => r.lookupUnavailable && r.source !== "bandcamp"],
  ["duplicates", "Already in the collection", (r) => !!r.duplicate],
  ["missing", "Not located", (r) => !(r.local && r.local.status === "located")],
  ["flagged", "Flagged", (r) => r.flags.length > 0 || !!r.note],
];
const showSel = el("select", "import-show");
showSel.id = "importShow";
SHOW.forEach(([v, label]) => showSel.appendChild(new Option(label, v)));
const showLabel = el("label", "import-show-label", "Show ");
showLabel.appendChild(showSel);
info.append(title, stats, showLabel, unavailable, pending, proc);
const showFilter = (item) => (SHOW.find(([v]) => v === showSel.value) || SHOW[0])[2](rowNow(item));

function renderInfo() {
  if (!batch) return;
  title.textContent = `Import preview · ${batch.source || batch.id}`;
  const confirmN = batch.rows.filter((r) => r.needsConfirmation).length;
  stats.textContent = [statsLine(batch.stats), confirmN ? `${confirmN} to confirm` : ""].filter(Boolean).join(" · ");
  const blockedRows = batch.rows.filter((r) => r.lookupUnavailable && r.source !== "bandcamp");
  const blocked = blockedRows.length;
  const lookups = batch.lookups || {};
  const paused = lookups.state === "paused";
  const why = paused
    ? "Bandcamp is rate-limiting, so the lookup paused. Resume it later, or"
    : lookups.reason === "challenge" || blockedRows.some((r) => r.lookupReason === "challenge")
      ? `Bandcamp showed its bot check (“Client Challenge”) to the server${lookups.at ? ` at ${new Date(lookups.at).toLocaleTimeString()}` : ""}, so it stopped looking rows up`
      : lookups.state === "off" || blockedRows.some((r) => r.lookupReason === "off")
      ? "Bandcamp lookups are turned off on this server"
      : "the lookup failed";
  unavailable.hidden = !blocked;
  unavailable.textContent = !blocked
    ? ""
    : paused
    ? `Bandcamp lookup paused with ${blocked} row${blocked > 1 ? "s" : ""} left: ${why} for those rows: Open on Bandcamp, ` +
      "then Link to import on the page (or paste its URL). "
    : `Bandcamp lookup unavailable for ${blocked} row${blocked > 1 ? "s" : ""}: ${why}. ` +
      "For those rows: Open on Bandcamp, then Link to import on the page (or paste its URL).";
  if (blocked && paused) {
    const resume = el("button", "mini-btn", "Resume lookups");
    resume.id = "resumeLookups";
    resume.addEventListener("click", async () => {
      resume.disabled = true;
      try {
        const res = await resumeLookups(batch.id);
        const est = res.estimate && res.estimate.text ? ` (${res.estimate.text})` : "";
        proc.textContent = `Looking up again${est}…`;
        await jobs.watch(res.job_id, (j) => (proc.textContent = `Looking up again${est}: ${progressText(j)}`));
      } catch (e) {
        proc.textContent = `Couldn't resume: ${e.message}`;
      }
      await page.reload();
      renderInfo();
    });
    unavailable.appendChild(resume);
  }
  const pr = batch.pendingReleases;
  pending.hidden = !pr.length;
  pending.textContent = pr.length ? `${pr.length} release${pr.length > 1 ? "s" : ""} not importable yet (no tracklist): ` : "";
  pending.title = pr.map((p) => `Line ${p.line}: ${[p.artist, p.release].filter(Boolean).join(" – ")}${p.reason ? ` (${p.reason})` : ""}`).join("\n");
  if (pr.length) pending.append(pr.map((p) => [p.artist, p.release].filter(Boolean).join(" – ")).join("; "));
  const checked = batch.rows.filter((r) => r.checked).length;
  const btn = document.getElementById("importSelected");
  if (btn) {
    btn.textContent = `Import selected (${checked})`;
    btn.disabled = !checked || batch.committed;
  }
  proc.textContent = batch.committed
    ? `Imported${batch.committed_at ? " " + new Date(batch.committed_at).toLocaleString() : ""}.`
    : batch.status === "error"
    ? `Import failed: ${batch.error || "unknown error"}`
    : batch.status && !/done|ready|resolved|complete/.test(batch.status)
    ? `Processing: ${batch.status}${batch.estimate && batch.estimate.text ? ` (${batch.estimate.text})` : ""}`
    : "Review the rows, fix matches and tags, then Import selected. Rows matched on Bandcamp are added to the tagger; " +
      "the rest to Other. For a row without a match: Open on Bandcamp, then link the page (the tagger's button on it) or paste its URL in Match.";
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
      box.addEventListener("change", () => setChecked([rowNow(item)], box.checked));
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
  let saved = null;
  try {
    saved = await updateRow(batchId, row.n, patch);
    page.statusEl.textContent = "";
  } catch (e) {
    page.statusEl.textContent = `Not saved: ${e.message}`;
  }
  await page.reload();
  page.refreshRow(`r${row.n}`);
  return saved;
}

function candidateLabel(c) {
  return [c.title, c.artist || c.band_name].filter(Boolean).join(" — ") || c.url || "?";
}

// Match source → chip label, class and the sentence in the popover.
const SOURCES = {
  collection: ["in collection", "match-bc", "Already in your collection: its tags are merged on import."],
  search: ["search", "match-bc", "Found by the Bandcamp search."],
  picked: ["picked", "match-bc", "Picked by you from the search results."],
  url: ["URL", "match-url", "You pasted its Bandcamp page: open it and the tagger links the row from the page. Imported without it, the row goes to Other with that link."],
  file: ["from file", "match-bc", "The Bandcamp URL given in the import file."],
  linked: ["linked", "match-bc", "Linked by you on its Bandcamp page (the tagger's “Link to import” button)."],
  candidates: ["options", "match-cand", "The search found possible matches: pick one."],
  error: ["lookup failed", "match-none", "The Bandcamp lookup failed for this row."],
  unavailable: [
    "lookup unavailable",
    "match-unavail",
    "Bandcamp lookup unavailable: Bandcamp showed its bot check (“Client Challenge”) to the server, which stopped looking rows up. Open on Bandcamp, then link the page with the tagger's button on it, or paste its URL here.",
  ],
  notbc: ["not on Bandcamp", "match-none", "You marked it as not on Bandcamp: it goes to Other."],
  pending: ["not looked up", "match-none", "Not looked up yet."],
  none: ["unmatched", "match-none", "No Bandcamp match yet: Open on Bandcamp, then link the page with the tagger's button on it, or paste its URL here."],
};
const UNAVAILABLE_WHY = {
  challenge: "Bandcamp showed its bot check (“Client Challenge”) to the server, which stopped looking rows up.",
  rate_limited: "Bandcamp is rate-limiting, so the lookup paused (Resume lookups at the top, later).",
  off: "Bandcamp lookups are turned off on this server.",
  error: "The lookup failed (no answer from Bandcamp).",
};
function sourceInfo(row) {
  const src = matchSource(row);
  const info = SOURCES[src] || [src, "match-bc", `Match source: ${src}.`];
  if (src !== "unavailable") return info;
  const why = UNAVAILABLE_WHY[row.lookupReason] || UNAVAILABLE_WHY.error;
  return [info[0], info[1], `Bandcamp lookup unavailable: ${why} Open on Bandcamp, then link the page with the tagger's button on it, or paste its URL here.`];
}

// "Open on Bandcamp" in a normal tab: the row's link hint, else a search.
function openLink(row, text, url) {
  const href = url || openOnBandcampUrl(row);
  const a = el("a", "pop-link open-bc", text || "Open on Bandcamp ↗");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.title =
    href === bandcampSearchUrl(row)
      ? `Search Bandcamp for “${[row.artist, row.title].filter(Boolean).join(" ")}” in a new tab`
      : `Open the link from the import (${href}) in a new tab`;
  return a;
}

// Paste a Bandcamp page URL to set the match by hand.
function urlForm(row) {
  const wrap = el("div", "pop-url");
  const input = document.createElement("input");
  input.className = "pop-input match-url";
  input.placeholder = "Paste a Bandcamp track or album URL";
  input.value = row.match.url || "";
  if (!input.value && row.hints.bandcamp) input.placeholder = `Paste a Bandcamp track or album URL (the import has ${row.hints.bandcamp})`;
  const err = el("div", "pop-meta pop-err");
  const use = el("button", "primary", "Use URL");
  // The server keeps the URL (nothing is fetched); opening that page with the
  // extension links the row (it reads the page's item), and Open on Bandcamp
  // opens it.
  const submit = async () => {
    const url = cleanBandcampUrl(input.value);
    if (!url) {
      err.textContent = "That isn't a Bandcamp track or album page (…/track/… or …/album/…).";
      return;
    }
    const saved = await patchRow(row, { match_url: url }, "Saving the URL…");
    if (!saved) return;
    if (saved.match.url !== url) {
      page.statusEl.textContent = "This server doesn't take a URL yet: open it and use Link to import on the page. ";
      page.statusEl.appendChild(openLink(saved, "Open it ↗", url));
      return;
    }
    page.statusEl.textContent = "Saved. Open it (Open on Bandcamp) and the tagger links the row from the page. ";
    page.statusEl.appendChild(openLink(saved, "Open it ↗", url));
  };
  use.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  const actions = el("div", "pop-actions");
  actions.appendChild(use);
  wrap.append(el("div", "pop-label", "Bandcamp URL"), input, err, actions);
  return wrap;
}

function matchPopover(anchor, row) {
  openPopover(anchor, (pop) => {
    const [, , sentence] = sourceInfo(row);
    pop.appendChild(el("div", "pop-head", row.source === "bandcamp" ? "Bandcamp match" : "No Bandcamp match"));
    pop.appendChild(el("div", "pop-meta match-source", sentence));
    if (row.duplicate) {
      const d = row.duplicate;
      pop.appendChild(
        el("div", "pop-meta", `In your collection as ${[d.title, d.artist].filter(Boolean).join(" — ") || d.of}${d.tags.length ? ` (tags: ${d.tags.join(", ")})` : ""}.`)
      );
    }
    pop.appendChild(el("div", "pop-meta", `From the file (line ${row.line ?? "?"}): ${row.raw || ""}`));
    const chosenId = row.match.chosen && (row.match.chosen.id ?? row.match.chosen.url);
    const cands = row.match.candidates.length ? row.match.candidates : row.match.chosen ? [row.match.chosen] : [];
    cands.forEach((c) => {
      const r = el("div", "pop-file");
      const name = el("a", "pop-file-name", candidateLabel(c));
      if (c.url) {
        name.href = c.url;
        name.target = "_blank";
        name.rel = "noopener";
      }
      r.append(name, el("div", "pop-file-meta", [c.type || c.kind, pct(c.confidence ?? c.score)].filter(Boolean).join(" · ")));
      const chosen = chosenId != null && (c.id ?? c.url) === chosenId;
      const btns = el("div", "pop-actions");
      const use = el("button", chosen ? "" : "primary", chosen ? "Chosen" : "Use this");
      use.disabled = chosen || !c.id;
      use.addEventListener("click", () => patchRow(row, { choose: c.id }));
      btns.appendChild(use);
      r.appendChild(btns);
      pop.appendChild(r);
    });
    pop.appendChild(urlForm(row));
    const foot = el("div", "pop-actions");
    const hint = cleanBandcampUrl(row.hints.bandcamp);
    if (hint) foot.appendChild(openLink(row, "Open the import's link ↗", hint));
    foot.appendChild(openLink(row, "Search Bandcamp ↗", bandcampSearchUrl(row)));
    if (row.source === "bandcamp") {
      const none = el("button", "danger", "Not on Bandcamp");
      none.title = "Import this row into Other instead";
      none.addEventListener("click", () => patchRow(row, { choose: null }));
      foot.appendChild(none);
    }
    const edit = el("button", "", "Edit artist/title…");
    edit.addEventListener("click", () => {
      pop.innerHTML = "";
      pop.appendChild(el("div", "pop-head", "Artist and title"));
      const a = document.createElement("input");
      a.placeholder = "Artist";
      a.value = row.artist || "";
      const t = document.createElement("input");
      t.placeholder = "Title";
      t.value = row.title || "";
      [a, t].forEach((i) => (i.className = "pop-input"));
      const fields = () => ({ artist: a.value.trim() || null, title: t.value.trim() });
      const save = el("button", "", "Save");
      save.addEventListener("click", () => patchRow(row, fields()));
      const actions = el("div", "pop-actions");
      // After the bot check the server doesn't look up again.
      if (!row.lookupUnavailable) {
        const again = el("button", "primary", "Save and look up again");
        again.addEventListener("click", () => patchRow(row, { ...fields(), re_resolve: true }, "Looking up on Bandcamp…"));
        actions.appendChild(again);
      }
      actions.appendChild(save);
      pop.append(a, t, el("div", "pop-meta", "Used for the row, the Bandcamp lookup and Open on Bandcamp."), actions);
      t.focus();
    });
    foot.appendChild(edit);
    pop.appendChild(foot);
  });
}

// Album, vinyl position and track number (rows are single tracks; a whole
// release was expanded into its tracks).
function releaseColumn() {
  const albumOf = (item) => String(rowOf(item).album || "");
  return {
    id: "release",
    label: "Release",
    after: "artist",
    sortKey: "release",
    compare: (a, b) => albumOf(a).localeCompare(albumOf(b)) || (rowOf(a).track_num ?? 0) - (rowOf(b).track_num ?? 0),
    render(cell, key, item) {
      cell.classList.add("release-cell");
      const row = rowOf(item);
      if (row.album) cell.appendChild(el("div", "release-title", row.album));
      const pos = [row.position, row.track_num != null ? `track ${row.track_num}` : null].filter(Boolean).join(" · ");
      const meta = [pos, row.year, row.label].filter(Boolean).join(" · ");
      if (meta) cell.appendChild(el("div", "release-meta", meta));
      cell.title = [
        row.album_artist && `Album artist: ${row.album_artist}`,
        row.catalog && `Catalog: ${row.catalog}`,
        row.duration && `Duration: ${row.duration}`,
        row.expanded_from != null && `From the release on line ${row.expanded_from}`,
      ]
        .filter(Boolean)
        .join("\n");
    },
  };
}

function matchColumn() {
  return {
    id: "match",
    label: "Match",
    after: "release",
    sortKey: "match",
    compare: (a, b) => matchSource(rowOf(a)).localeCompare(matchSource(rowOf(b))) || (rowOf(a).match.confidence ?? -1) - (rowOf(b).match.confidence ?? -1),
    render(cell, key, item) {
      cell.classList.add("no-row-play", "match-cell");
      const row = rowOf(item);
      const [label, cls] = sourceInfo(row);
      const src = matchSource(row);
      const chip = el("button", `chip ${cls}`);
      chip.dataset.source = src;
      const conf = src === "search" ? pct(row.match.confidence) : "";
      chip.textContent = src === "candidates" ? `${row.match.candidates.length} ${label}` : [label, conf].filter(Boolean).join(" ");
      chip.title = (row.match.chosen ? candidateLabel(row.match.chosen) + "\n" : "") + sourceInfo(row)[2];
      chip.addEventListener("click", () => matchPopover(chip, rowNow(item)));
      cell.appendChild(chip);
      if (row.source !== "bandcamp") cell.appendChild(openLink(row, cleanBandcampUrl(row.hints.bandcamp) ? "Open link ↗" : "Search ↗"));
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
        const dup = row.duplicate;
        const d = el("span", "note-icon dup-icon", "⧉");
        d.title = `Already in your collection (${[dup.title, dup.artist].filter(Boolean).join(" — ") || dup.of}): its tags will be merged.`;
        cell.appendChild(d);
      }
      if (row.needsConfirmation) {
        const c = el("span", "chip confirm-chip", "confirm");
        c.title = `Needs your confirmation: the reading and the files disagree.${row.note ? `\n${row.note}` : ""}`;
        cell.appendChild(c);
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
    rememberImport(null);
    const job = res && res.job_id ? await jobs.watch(res.job_id, (j) => (statusEl.textContent = `Importing: ${progressText(j)}`)) : null;
    const r = (job && job.result) || res || {};
    // Let the extension pick up the new Bandcamp items right away.
    if (bridge.connected) await bridge.call("syncNow", {}).catch(() => {});
    statusEl.textContent =
      "Imported: " +
      Object.entries(r)
        .map(([k, v]) => [k, Array.isArray(v) ? v.length : v])
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
  rememberImport(null);
  location.href = "/settings/#import";
}

// --- start --------------------------------------------------------------------------

(async () => {
  if (!batchId) {
    document.body.textContent = "No import selected. Start one in Settings → Import.";
    return;
  }
  rememberImport(batchId); // edits are saved as they're made; this page can be left and reopened
  await bridge.connect(1000);
  nav.setExtension(bridge.info);
  const top = el("div", "import-top");
  top.append(nav.el, info);
  page = createCollectionPage({
    dataSource: ds,
    topBarStart: top,
    colWidthKey: "bc_import_col_widths_v2",
    baseToolbar: false,
    hideColumns: ["date", "thumb"], // nothing is added yet; no art is fetched here
    extraColumns: [selectColumn(), { ...sourceColumn(), after: "index" }, releaseColumn(), matchColumn(), locatedColumn(), notesColumn()],
    filterItem: showFilter,
    clearExtraFilters: () => (showSel.value = "all"),
    extraToolbarButtons: [
      { id: "importSelected", label: "Import selected", className: "job-btn", run: importSelected },
      { id: "discardImport", label: "Discard", run: discard },
    ],
    localPlayUrl,
    playable: playableItem,
    rowClass: (item) => {
      const row = rowOf(item);
      if (!row) return "";
      const tint = row.duplicate ? "row-duplicate" : item.local && item.local.status === "located" ? "" : "row-missing";
      return [tint, row.needsConfirmation ? "row-confirm" : ""].filter(Boolean).join(" ");
    },
    titleUrl: (item) => (item.source === "other" ? null : item.url || item.item_url || null),
  });
  showSel.addEventListener("change", () => page.refilter());
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

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
import { getBatch, updateRow, commitBatch, discardBatch, resumeLookups, setDefaultTags, relocateRows, relocateRow, searchFiles, listFolder, rowToItem, matchSource, bandcampSearchUrl, openOnBandcampUrl, cleanBandcampUrl } from "./importApi";
import { statsLine } from "./importTab";
import { rememberImport } from "./openImport";
import { downloadFileTitle, downloadFlow, fullReleaseOf, fullReleasesToggle, stateLabel, trackDownloads } from "./downloads";
import { playableItem } from "./statusFilter";
import { logNote } from "./importLogs";

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
// The batch's default tags, and whether they go on every track.
const defaults = el("label", "import-defaults");
const defaultsAll = document.createElement("input");
defaultsAll.type = "checkbox";
defaultsAll.id = "previewDefaultAll";
const defaultsText = el("span", "import-defaults-tags");
defaults.append(defaultsText, defaultsAll, "Add default tags to all tracks");
defaultsAll.addEventListener("change", async () => {
  const want = defaultsAll.checked;
  defaultsAll.disabled = true;
  page.statusEl.textContent = want ? "Adding the default tags to all tracks…" : "Default tags only on untagged tracks…";
  try {
    await setDefaultTags(batchId, batch.defaultTags, want);
    page.statusEl.textContent = "";
  } catch (e) {
    defaultsAll.checked = !want;
    page.statusEl.textContent = e.status === 404 || e.status === 405 ? "This server can't change the default tags yet." : `Not changed: ${e.message}`;
  }
  defaultsAll.disabled = false;
  await page.reload();
  renderInfo();
});
const unavailable = el("div", "import-unavailable");
unavailable.id = "lookupUnavailable";
// Import from Files: collection items that aren't located yet get their file on commit.
const locations = el("details", "import-locations");
locations.id = "locationUpdates";
locations.hidden = true;
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
info.append(title, stats, showLabel, defaults, unavailable, locations, pending, proc);
const showFilter = (item) => (SHOW.find(([v]) => v === showSel.value) || SHOW[0])[2](rowNow(item));

function renderLocations() {
  const list = batch.locationUpdates || [];
  locations.hidden = !list.length;
  if (!list.length) return;
  const wasOpen = locations.open;
  locations.innerHTML = "";
  const summary = el(
    "summary",
    "",
    batch.committed
      ? `Locations updated (${list.length}): collection items that weren't located, now located to these files.`
      : `Locations to update (${list.length}): collection items that aren't located yet get these files on Import ` +
          "selected, whether or not their rows are ticked."
  );
  const ul = el("ul", "location-list");
  list.forEach((u) => {
    const li = el("li", "");
    li.dataset.item = u.id || "";
    li.append(el("span", "loc-name", [u.artist, u.title].filter(Boolean).join(" – ") || u.id || "?"), " → ", el("code", "loc-path", u.path));
    ul.appendChild(li);
  });
  locations.append(summary, ul);
  locations.open = wasOpen;
}

function renderInfo() {
  if (!batch) return;
  title.textContent = `Import preview · ${batch.source || batch.id}`;
  renderLocations();
  defaultsText.textContent = `Default tags: ${batch.defaultTags.join(", ") || "none"} · `;
  defaults.hidden = !batch.defaultTags.length || batch.committed;
  if (!defaultsAll.disabled) defaultsAll.checked = batch.defaultTagsAll;
  const confirmN = batch.rows.filter((r) => r.needsConfirmation).length;
  stats.textContent = [statsLine(batch.stats), confirmN ? `${confirmN} to confirm` : ""].filter(Boolean).join(" · ");
  const blockedRows = batch.rows.filter((r) => r.lookupUnavailable && r.source !== "bandcamp");
  const blocked = blockedRows.length;
  const lookups = batch.lookups || {};
  const paused = lookups.state === "paused";
  const why = paused
    ? "Bandcamp is rate-limiting, so the lookup paused. Resume it later, or"
    : lookups.reason === "challenge" || blockedRows.some((r) => r.lookupReason === "challenge")
      ? `Bandcamp showed its bot check (“Client Challenge”) to ${lookedUpBy()}${lookups.at ? ` at ${new Date(lookups.at).toLocaleTimeString()}` : ""}, so it stopped looking rows up`
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
    chooserLabel: "Selection",
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
  musicbrainz: [
    "MusicBrainz",
    "match-cand",
    "Found on MusicBrainz (no Bandcamp item): its Bandcamp/Discogs links are the row's hints. Open on Bandcamp, then link the page with the tagger's button on it.",
  ],
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
// Who made this batch's Bandcamp requests: the server, or the user's browser (the extension).
const lookedUpBy = () => (batch && batch.lookupVia === "browser" ? "your browser" : "the server");
const UNAVAILABLE_WHY = {
  challenge: () => `Bandcamp showed its bot check (“Client Challenge”) to ${lookedUpBy()}, which stopped looking rows up.`,
  rate_limited: "Bandcamp is rate-limiting, so the lookup paused (Resume lookups at the top, later).",
  off: "Bandcamp lookups are turned off on this server.",
  error: "The lookup failed (no answer from Bandcamp).",
};
function sourceInfo(row) {
  const src = matchSource(row);
  const info = SOURCES[src] || [src, "match-bc", `Match source: ${src}.`];
  if (src !== "unavailable") return info;
  const reason = UNAVAILABLE_WHY[row.lookupReason] || UNAVAILABLE_WHY.error;
  const why = typeof reason === "function" ? reason() : reason;
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
    pop.appendChild(el("div", "pop-meta", row.path ? `From ${row.path}` : `From the file (line ${row.line ?? "?"}): ${row.raw || ""}`));
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
      const fromMb = String(c.id || "").startsWith("mb:");
      r.append(
        name,
        el("div", "pop-file-meta", [fromMb ? "MusicBrainz" : c.type || c.kind, c.album, c.year, pct(c.confidence ?? c.score)].filter(Boolean).join(" · "))
      );
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

// --- Downloads (owned releases) ---------------------------------------------------------
// Offered for missing rows whose Bandcamp item is owned (the server's row.owned):
// Download File, and Download Full Release when the track's album or EP is owned.

const refOf = (row) => `${batchId}:${row.n}`;
const downloadableRow = (row) =>
  row.source === "bandcamp" && !!row.item && !(row.local && row.local.status === "located") && !!row.owned && row.owned.status === "owned";
const rowIsAlbum = (row) => String((row.item && row.item.id) || "").startsWith("a");
const fullReleases = fullReleasesToggle();
const dlState = trackDownloads(events, (d) => {
  if (!String(d.ref).startsWith(`${batchId}:`)) return;
  page.refreshRow(`r${String(d.ref).split(":").pop()}`);
});
const downloadRows = async (rows, fullRelease = false) => {
  if (!(await downloadFlow(rows.map(refOf), "import", { jobs, statusEl: page.statusEl, fullRelease }))) return;
  await page.reload(); // what the server located, even if a live update was missed
  rows.forEach((r) => page.refreshRow(`r${r.n}`));
  renderInfo();
};

// --- Located: where the row's file is; locate again, pick, or set it by hand -----------

const fmtSize = (f) => [String(f.format || "").toUpperCase(), f.root_kind === "owned" ? "owned folder" : null].filter(Boolean).join(" · ");
const fileLine = (f) => [f.title, f.artist, f.album].filter(Boolean).join(" — ") || (f.path || "").split("/").pop();

function fileRow(f, actions) {
  const r = el("div", "pop-file");
  r.append(el("div", "pop-file-name", fileLine(f)), el("div", "pop-file-meta", [fmtSize(f), f.path].filter(Boolean).join(" · ")));
  if (actions.length) {
    const btns = el("div", "pop-actions");
    actions.forEach(([label, cls, run]) => {
      const b = el("button", cls, label);
      b.addEventListener("click", run);
      btns.appendChild(b);
    });
    r.appendChild(btns);
  }
  return r;
}

function setFileForm(pop, row) {
  const box = el("div", "pop-url set-file");
  box.appendChild(el("div", "pop-label", "Set file: search your music folders"));
  const q = document.createElement("input");
  q.className = "pop-input set-file-q";
  q.value = [row.artist, row.title].filter(Boolean).join(" ");
  const results = el("div", "set-file-results");
  const search = async () => {
    results.textContent = "Searching…";
    let found = [];
    try {
      found = await searchFiles(q.value.trim());
    } catch (e) {
      results.textContent = e.status === 404 ? "This server can't search the files yet." : `Search failed: ${e.message}`;
      return;
    }
    results.innerHTML = "";
    if (!found.length) results.appendChild(el("div", "pop-meta", "No files match."));
    found.forEach((f) => results.appendChild(fileRow(f, [["Use this", "primary", () => patchRow(row, { path: f.path }, "Setting the file…")]])));
  };
  q.addEventListener("keydown", (e) => e.key === "Enter" && search());
  const go = el("button", "", "Search");
  go.addEventListener("click", search);
  const browse = el("button", "", "Browse…");
  browse.id = "browseFiles";
  browse.title = "Pick the file in your music folders";
  browse.addEventListener("click", () => {
    box.remove();
    folderBrowser(pop, row);
  });
  const a1 = el("div", "pop-actions");
  a1.append(go, browse);
  box.append(q, a1, results);
  pop.appendChild(box);
  q.focus();
  search();
}

const dirOf = (p) => (p ? String(p).replace(/\/[^/]*$/, "") : null);

// Pick the row's file in the music folders. Opens in the last folder a file
// was picked from (the server's last_browse_dir), else the folder of the row's
// best guess, else the list of music folders.
async function folderBrowser(pop, row) {
  const box = el("div", "pop-url folder-browser");
  box.id = "folderBrowser";
  const crumbs = el("div", "fb-crumbs");
  const list = el("div", "fb-list");
  const msg = el("div", "pop-meta fb-msg");
  box.append(el("div", "pop-label", "Pick the file"), crumbs, msg, list);
  pop.appendChild(box);

  // The music folders, so the breadcrumb starts at the one we're in.
  let roots = [];
  const rootOf = (p) => roots.filter((r) => p === r || p.startsWith(r + "/")).sort((a, b) => b.length - a.length)[0];

  // A folder outside the music folders (or gone) is refused: say so, show the list of folders.
  async function open(path, note = "") {
    msg.textContent = note;
    let d;
    try {
      d = await listFolder(path);
    } catch (e) {
      if (e.status === 404 && e.message === "Not Found") msg.textContent = "This server can't browse folders yet."; // no such route
      else if (path) return open(null, `Can't open ${path}: ${e.message}`);
      else msg.textContent = `Can't list your music folders: ${e.message}`;
      return;
    }
    if (!d.path) roots = d.dirs.map((f) => f.path);
    crumbs.innerHTML = "";
    const top = el("button", "fb-crumb", "Music folders");
    top.addEventListener("click", () => open(null));
    crumbs.appendChild(top);
    if (d.path) {
      const root = rootOf(d.path) || d.path;
      const crumb = (label, at) => {
        crumbs.append(" / ");
        const b = el("button", "fb-crumb", label);
        b.dataset.path = at;
        b.title = at;
        b.addEventListener("click", () => open(at));
        crumbs.appendChild(b);
      };
      crumb(root, root);
      let acc = root;
      d.path
        .slice(root.length)
        .split("/")
        .filter(Boolean)
        .forEach((part) => {
          acc += "/" + part;
          crumb(part, acc);
        });
    }
    list.innerHTML = "";
    if (d.path) {
      const up = el("button", "fb-entry fb-up", "↑ Up");
      up.addEventListener("click", () => open(d.parent || null));
      list.appendChild(up);
    }
    d.dirs.forEach((f) => {
      const b = el("button", "fb-entry fb-dir", `📁 ${f.name}`);
      b.dataset.path = f.path;
      b.addEventListener("click", () => open(f.path));
      list.appendChild(b);
    });
    d.files.forEach((f) => {
      const b = el("button", "fb-entry fb-file", `♪ ${f.name}`);
      b.dataset.path = f.path;
      const tagged = [f.title, f.artist].filter(Boolean).join(" — ");
      if (tagged) b.appendChild(el("span", "muted", ` ${tagged}`));
      b.addEventListener("click", () => patchRow(row, { path: f.path }, "Setting the file…"));
      list.appendChild(b);
    });
    if (!d.dirs.length && !d.files.length) list.appendChild(el("div", "pop-meta", "No folders or audio files here."));
    const first = list.querySelector(".fb-dir, .fb-file");
    if (first) first.focus();
  }

  // Arrow keys move between entries; Enter opens / picks (they're buttons).
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...list.querySelectorAll(".fb-entry")];
    const i = items.indexOf(document.activeElement);
    const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) next.focus();
    e.preventDefault();
  });

  const settings = await apiJson("/api/settings").catch(() => ({}));
  const last = (settings.settings || settings).last_browse_dir;
  const local = row.local || {};
  const guess = dirOf((local.best && local.best.path) || ((local.candidates || [])[0] || {}).path);
  roots = (await listFolder(null).catch(() => ({ dirs: [] }))).dirs.map((f) => f.path);
  open(last || guess || null);
}

function locatedPopover(anchor, row) {
  openPopover(anchor, (pop) => {
    const local = row.local || { status: "unknown" };
    const best = local.best || null;
    const head = local.status === "located" ? (local.manual ? "Located (set manually)" : "Located") : local.status === "candidates" ? "Possible files" : "Not found on your drive";
    pop.appendChild(el("div", "pop-head", head));
    if (best) {
      const files = Array.isArray(best.tracks) && best.tracks.length ? best.tracks : [best];
      files.forEach((f) => pop.appendChild(fileRow(f, [])));
    }
    (local.candidates || []).forEach((c) => pop.appendChild(fileRow(c, [["Use this", "primary", () => patchRow(row, { path: c.path }, "Setting the file…")]])));
    const foot = el("div", "pop-actions");
    const again = el("button", "", "Locate again");
    again.title = "Look for new files on your drive and match this row again";
    again.addEventListener("click", async () => {
      closePopover();
      page.statusEl.textContent = "Locating again…";
      try {
        const r = await relocateRow(batchId, row.n);
        page.statusEl.textContent = r.local && r.local.status === "located" ? "Located." : "Still not found.";
      } catch (e) {
        page.statusEl.textContent = `Couldn't locate: ${e.message}`;
      }
      await page.reload();
      page.refreshRow(`r${row.n}`);
    });
    const setFile = el("button", "", "Set file…");
    setFile.addEventListener("click", () => {
      foot.remove();
      setFileForm(pop, row);
    });
    foot.append(again, setFile);
    if (downloadableRow(row)) {
      const dl = el("button", "", "Download File");
      dl.id = "downloadRow";
      dl.title = downloadFileTitle(row.owned, rowIsAlbum(row));
      dl.addEventListener("click", () => {
        closePopover();
        downloadRows([row]);
      });
      foot.appendChild(dl);
      if (fullReleaseOf(row.owned, row.item.id)) {
        const full = el("button", "", "Download Full Release");
        full.id = "downloadRowFullRelease";
        full.title = "Download the whole album or EP this track is on into the downloads folder, then locate it";
        full.addEventListener("click", () => {
          closePopover();
          downloadRows([row], true);
        });
        foot.appendChild(full);
      }
    }
    if (local.manual) {
      const auto = el("button", "", "Back to automatic");
      auto.addEventListener("click", () => patchRow(row, { path: null }, "Locating…"));
      foot.appendChild(auto);
    }
    pop.appendChild(foot);
  });
}

function locatedColumn() {
  return {
    id: "located",
    label: "Located",
    after: "match",
    sortKey: "located",
    compare: (a, b) => Number(!!(a.local && a.local.status === "located")) - Number(!!(b.local && b.local.status === "located")),
    render(cell, key, item) {
      cell.classList.add("status-cell", "no-row-play", "located-cell");
      const local = item.local || { status: "unknown" };
      const best = local.best || {};
      const files = Array.isArray(best.tracks) && best.tracks.length ? best.tracks : best.path ? [best] : [];
      const label =
        local.status === "located"
          ? local.manual
            ? "✓ set manually"
            : `✓ ${files.length > 1 ? files.length + " files" : String(best.format || "file").toUpperCase()}`
          : local.status === "candidates"
          ? `? ${(local.candidates || []).length}`
          : local.status === "missing"
          ? "✗"
          : "–";
      const chip = el("button", `chip loc-${local.status}`, label);
      chip.dataset.status = local.status + (local.manual ? "-manual" : "");
      chip.title = local.manual ? `Set manually: ${best.path}` : files.map((f) => f.path).join("\n") || "Not found in your music folders: click to locate again or set the file";
      chip.addEventListener("click", () => locatedPopover(chip, rowNow(item)));
      cell.appendChild(chip);
      const d = dlState[refOf(rowOf(item))];
      if (d && d.state !== "done") cell.appendChild(el("span", `busy-note${d.state === "failed" ? " err-note" : ""}`, stateLabel(d)));
    },
  };
}

// What the import file's flags mean (annotations-import-rules.md, §5).
const FLAGS = {
  artist_missing: "No artist in the text (left empty unless guessed).",
  artist_guessed: "The artist was inferred from context.",
  artist_corrected: "The artist was changed from what was written (a typo, or a label instead of the artist).",
  no_separator: "The artist/title split was inferred (no separator in the line).",
  order_ambiguous: "Could be title/artist either way.",
  title_corrected: "The title was changed to the release's spelling (from the local files).",
  needs_user_confirmation: "Your reading and the files disagree: please confirm.",
  match_by_track_num: "Untitled or generic track: matched on album + track number.",
  title_generic: "A real but generic title (e.g. “Untitled 4”).",
  title_unknown: "Only a side or position is known (e.g. B1).",
  split_release: "One “A / B” line split into two tracks.",
  possible_typo: "Kept as written, but probably misspelled.",
  low_confidence: "A weak reading: check it.",
  duplicate_existing: "Already in your collection: its tags are merged on import.",
  tag_unknown: "Has tags that aren't in your vocabulary.",
};

// The row's notes: what's flagged (in plain words), the note, the duplicate
// and the original line from the file.
function notesPopover(anchor, row) {
  openPopover(anchor, (pop) => {
    pop.classList.add("notes-pop");
    pop.appendChild(el("div", "pop-head", row.needsConfirmation ? "Notes · please confirm" : "Notes"));
    if (row.duplicate) {
      const d = row.duplicate;
      const what = [d.title, d.artist].filter(Boolean).join(" — ") || d.of;
      pop.appendChild(el("div", "pop-meta note-dup", `⧉ Already in your collection as ${what}${d.tags.length ? ` (tags: ${d.tags.join(", ")})` : ""}: its tags are merged on import.`));
    }
    if (row.flags.length) {
      const list = el("ul", "note-flags");
      row.flags.forEach((f) => {
        const li = el("li", f === "needs_user_confirmation" ? "flag-confirm" : "", FLAGS[f] || f.replace(/_/g, " "));
        li.dataset.flag = f;
        li.title = f;
        list.appendChild(li);
      });
      pop.appendChild(list);
    }
    if (row.note) pop.appendChild(el("div", "pop-meta note-text", `Note: ${row.note}`));
    if (row.raw || row.path) pop.appendChild(el("div", "pop-meta note-line", fromText(row)));
  });
}

function notesColumn() {
  return {
    id: "notes",
    label: "Notes",
    after: "located",
    render(cell, key, item) {
      cell.classList.add("status-cell", "notes-cell", "no-row-play");
      const row = rowOf(item);
      const open = (e) => notesPopover(e.currentTarget, rowNow(item));
      const clickable = (node) => {
        node.classList.add("note-open");
        node.setAttribute("role", "button");
        node.tabIndex = 0;
        node.addEventListener("click", open);
        node.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open(e)));
        return node;
      };
      if (row.duplicate) {
        const dup = row.duplicate;
        const d = clickable(el("span", "note-icon dup-icon", "⧉"));
        d.title = `Already in your collection (${[dup.title, dup.artist].filter(Boolean).join(" — ") || dup.of}): its tags will be merged.`;
        cell.appendChild(d);
      }
      if (row.needsConfirmation) {
        const c = clickable(el("span", "chip confirm-chip", "confirm"));
        c.title = `Needs your confirmation: the reading and the files disagree.${row.note ? `\n${row.note}` : ""}`;
        cell.appendChild(c);
      }
      if (row.flags.length || row.note) {
        const f = clickable(el("span", "note-icon flag-icon", "⚑"));
        f.title = [row.flags.length ? `Flags: ${row.flags.join(", ")}` : "", row.note ? `Note: ${row.note}` : "", row.raw || row.path ? fromText(row) : ""]
          .filter(Boolean)
          .join("\n");
        cell.appendChild(f);
        if (row.flags.length) cell.appendChild(el("span", "muted", ` ${row.flags.length}`));
      }
    },
  };
}

// Where a row came from: its line in the file, or (Import from Files) its file.
function fromText(row) {
  return row.path ? `File: ${row.path}` : `Line ${row.line ?? "?"}: ${row.raw || ""}`;
}

// --- actions ----------------------------------------------------------------------

// The commit's log: "Import log saved: …" with View and Show in Finder.
function showLogNote(r) {
  const old = document.getElementById("importLogNote");
  if (old) old.remove();
  const note = logNote(r);
  if (note) info.appendChild(note);
}

async function importSelected(statusEl, button) {
  const n = batch.rows.filter((r) => r.checked).length;
  if (!confirm(`Import ${n} selected rows? Rows found on Bandcamp go to the tagger (the extension adds them), the rest to Other. Duplicates merge tags.`)) return;
  button.disabled = true;
  statusEl.textContent = "Importing…";
  try {
    const res = await commitBatch(batchId);
    rememberImport(null);
    const job = res && res.job_id ? await jobs.watch(res.job_id, (j) => (statusEl.textContent = `Importing: ${progressText(j)}`)) : null;
    if (job && job.status === "error") {
      // Stopped part way: the server still logs what it imported (the batch's last log).
      statusEl.textContent = `Import stopped: ${job.error || "error"}. Import selected again carries on (rows already imported are skipped).`;
      const logs = (await getBatch(batchId).catch(() => null) || {}).logs || [];
      showLogNote(logs.length ? { log: logs[logs.length - 1], log_md: logs[logs.length - 1].replace(/\.json$/, ".md") } : null);
      button.disabled = false;
      return;
    }
    const r = (job && job.result) || res || {};
    const log = ["log", "log_md", "log_dir", "log_warning", "log_error"].reduce((o, k) => (r[k] ? { ...o, [k]: r[k] } : o), {});
    // Let the extension pick up the new Bandcamp items right away.
    if (bridge.connected) await bridge.call("syncNow", {}).catch(() => {});
    statusEl.textContent =
      "Imported: " +
      Object.entries(r)
        .map(([k, v]) => [k, Array.isArray(v) ? v.length : v])
        .filter(([, v]) => typeof v === "number")
        .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`)
        .join(", ");
    // The collection opens with exactly what was imported and merged
    // selected, newest Modified first, ready for "Export Selected to RB".
    if (Array.isArray(r.selected)) {
      try {
        localStorage.setItem("bc_after_import", JSON.stringify({ ids: r.selected, at: Date.now(), batch: batchId, summary: statusEl.textContent, log }));
      } catch (e) {
        /* no handoff: the link below still opens the collection */
      }
      location.href = "/";
      return;
    }
    const link = el("a", "", "Open the collection →");
    link.href = "/";
    statusEl.append(" ", link);
    showLogNote(log);
  } catch (e) {
    statusEl.textContent = `Import failed: ${e.message}`;
    button.disabled = false;
  }
  await page.reload();
  renderInfo();
}

// Look for files added since (a quick scan), then locate the missing rows
// again, or every row. Hand-set files stay.
async function locateAgain(statusEl, button) {
  const all = document.getElementById("locateAllRows").checked;
  button.disabled = true;
  statusEl.textContent = "Locating again…";
  try {
    const { job_id } = await relocateRows(batchId, all ? "all" : "missing");
    const job = await jobs.watch(job_id, (j) => (statusEl.textContent = `Locating again: ${progressText(j)}`));
    const r = job.result || {};
    statusEl.textContent =
      job.status === "error"
        ? `Locate again failed: ${job.error || "error"}`
        : `Locate again: ${(r.newly_located || []).length} newly located, ${r.still_missing ?? "?"} still missing (${r.checked ?? 0} checked).`;
  } catch (e) {
    statusEl.textContent = e.status === 404 || e.status === 405 ? "This server can't locate import rows again yet." : `Locate again failed: ${e.message}`;
  }
  button.disabled = false;
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
    hideColumns: ["date", "modified", "thumb"], // nothing is added or changed yet; no art is fetched here
    // Import from Files: the rows folder by folder, under the folder's path.
    groupBy: (item) => (batch && batch.fromFiles ? rowNow(item).folder || null : null),
    extraColumns: [selectColumn(), { ...sourceColumn(), after: "index" }, releaseColumn(), matchColumn(), locatedColumn(), notesColumn()],
    filterItem: showFilter,
    clearExtraFilters: () => (showSel.value = "all"),
    extraToolbarButtons: [
      { id: "importSelected", label: "Import selected", className: "job-btn", run: importSelected },
      { id: "locateAgain", label: "Locate again", run: locateAgain },
      {
        id: "downloadOwnedMissing",
        label: "Download owned missing",
        title:
          "Download the selected rows you own on Bandcamp that aren't on your drive. " +
          "With Download Full Releases ticked: each track's whole album or EP.",
        run: async (statusEl, button) => {
          button.disabled = true;
          await downloadRows(batch.rows.filter((r) => r.checked && downloadableRow(r)), fullReleases.checked());
          button.disabled = false;
          await page.reload();
          renderInfo();
        },
      },
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
  document.getElementById("downloadOwnedMissing").after(fullReleases.el);
  // "Locate again": missing rows by default, every row on request.
  const allRows = document.createElement("label");
  allRows.className = "locate-all";
  allRows.innerHTML = '<input type="checkbox" id="locateAllRows"> all rows';
  allRows.title = "Locate every row again, not only the ones not found (files you set by hand stay)";
  document.getElementById("locateAgain").after(allRows);
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

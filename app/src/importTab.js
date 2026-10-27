// Settings → Import: pick a bc-tagger-import/1 file, choose default tags,
// start the import (the server resolves rows on Bandcamp and locates them),
// then map unknown tags and continue to the preview page. Or Import from
// Files: folders, each with an "added since" date; then straight to the preview.
// An import stays open on the server until it's imported or discarded:
// coming back here (or reloading) picks it up at its step (#import/<id>).

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { ServerEvents } from "../../shared/datasource/serverEvents";
import { Jobs, progressText, resultText } from "./jobs";
import { listBatches, getBatch, startImport, applyTagMap, discardBatch, resumeLookups, startFileImport, fileImportDefaults, dateInputValue } from "./importApi";
import { folderPicker } from "./folderPicker";
import { rememberImport, rememberedImport, stepLabel, stepOf, stepUrl } from "./openImport";
import { runBrowserLookups, lookupsText } from "./browserLookups";
import { renderPastImports } from "./importLogs";

const STAT_LABELS = [
  ["total", "rows"],
  ["bandcamp", "on Bandcamp"],
  ["found", "found", true],
  ["in_collection", "in your collection", true],
  ["picked", "picked", true],
  ["linked", "linked", true],
  ["needs_pick", "to pick", true],
  ["other", "other"],
  ["located", "located"],
  ["duplicates", "duplicates"],
  ["flagged", "flagged"],
  ["unknown_tags", "unknown tags", true],
];

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  });
  children.flat().forEach((c) => e.append(c instanceof Node ? c : document.createTextNode(String(c))));
  return e;
}

// The batch's stats; the details (found, picked, …) only when not zero.
export function statsLine(stats) {
  const n = (k) => (stats[k] && typeof stats[k] === "object" ? Object.keys(stats[k]).length : stats[k]);
  return STAT_LABELS.filter(([k, , optional]) => stats && stats[k] != null && !(optional && !n(k)))
    .map(([k, label]) => `${n(k)} ${label}`)
    .join(" · ");
}

const previewUrl = (id) => `/import/?batch=${encodeURIComponent(id)}`;

// A chosen multi-select over the vocabulary (jQuery + chosen globals).
function tagSelect(id, vocab, selected, width) {
  const sel = el("select", { multiple: true, id, class: "chosen-select", "data-placeholder": "Add tags…" });
  const all = [...new Set([...vocab, ...selected])];
  all.forEach((t) => sel.appendChild(new Option(t, t, false, selected.includes(t))));
  return {
    node: sel,
    init: () => $(sel).chosen({ width: width || "100%", no_results_text: "No tag" }),
    get: () => $(sel).val() || [],
  };
}

export function createImportTab(container, { bridge } = {}) {
  const events = new ServerEvents().start();
  const jobs = new Jobs(events);
  let vocab = [];
  let fileData = null;
  let fileName = "";
  let defaultTags = null;

  const fileInput = el("input", { type: "file", id: "importFile", accept: ".json,application/json" });
  const fileInfo = el("div", { class: "help", id: "importFileInfo" });
  const tagsHolder = el("div", { id: "importDefaultTagsHolder" });
  const allBox = el("input", { type: "checkbox", id: "importDefaultAll" });
  // Where the Bandcamp lookups run.
  const viaServer = el("input", { type: "radio", name: "importLookup", value: "server", id: "importLookupServer", checked: true });
  const viaBrowser = el("input", { type: "radio", name: "importLookup", value: "browser", id: "importLookupBrowser" });
  const start = el("button", { type: "button", id: "importStart", disabled: true }, "Start import");
  const progress = el("div", { class: "import-progress", id: "importProgress", hidden: true });
  const openCard = el("div", { class: "import-open", id: "importOpen", hidden: true });
  const mapping = el("div", { class: "import-mapping", id: "importMapping", hidden: true });
  const batches = el("div", { id: "importBatches" });
  const pastImports = el("div", { id: "importLogs" });
  // The progress (and mapping step) sit under whichever import started: the file's or the folders'.
  const jsonRun = el("div", { class: "field" }, start, progress);

  // Import from Files: folder rows (path, Browse…, added since, ×), Default tags (pool), the lookup choice.
  let folders = [];
  let filesTags = null;
  const weekAgo = () => dateInputValue(new Date(Date.now() - 7 * 864e5).toISOString());
  const folderList = el("div", { id: "importFolders", class: "import-folders" });
  const addFolder = el("button", { type: "button", class: "secondary", id: "importFolderAdd" }, "+ Add folder");
  const filesInfo = el("div", { class: "help", id: "importFilesInfo" });
  const filesTagsHolder = el("div", { id: "importFilesDefaultTagsHolder" });
  const filesAllBox = el("input", { type: "checkbox", id: "importFilesDefaultAll" });
  const filesViaServer = el("input", { type: "radio", name: "importFilesLookup", value: "server", id: "importFilesLookupServer", checked: true });
  const filesViaBrowser = el("input", { type: "radio", name: "importFilesLookup", value: "browser", id: "importFilesLookupBrowser" });
  const filesStart = el("button", { type: "button", id: "importFilesStart" }, "Start import");
  const filesRun = el("div", { class: "field" }, filesStart);

  function renderFolders() {
    folderList.innerHTML = "";
    folders.forEach((f, i) => {
      const path = el("input", { type: "text", class: "path folder-path", placeholder: "/path/to/folder", spellcheck: "false" });
      path.value = f.path;
      path.addEventListener("input", () => (f.path = path.value));
      const since = el("input", { type: "date", class: "folder-since", title: "Files added on or after this day" });
      since.value = f.since || "";
      since.addEventListener("change", () => (f.since = since.value));
      const browse = el("button", { type: "button", class: "secondary folder-browse" }, "Browse…");
      const del = el("button", { type: "button", class: "icon folder-del", title: "Remove this folder" }, "×");
      del.addEventListener("click", () => {
        folders.splice(i, 1);
        renderFolders();
      });
      const picker = el("div", { class: "folder-picker-holder" });
      browse.addEventListener("click", () => {
        if (picker.firstChild) return (picker.innerHTML = "");
        picker.appendChild(
          folderPicker({
            start: path.value.trim() || null,
            onPick: (p) => {
              f.path = path.value = p;
              picker.innerHTML = "";
            },
            onClose: () => (picker.innerHTML = ""),
          })
        );
      });
      folderList.append(
        el("div", { class: "folder-row", "data-i": i }, path, browse, el("label", { class: "since-label" }, "added since ", since), del),
        picker
      );
    });
  }
  addFolder.addEventListener("click", () => {
    folders.push({ path: "", since: weekAgo() });
    renderFolders();
  });

  container.append(
    el(
      "section",
      { id: "sec_import", "data-tab": "import" },
      openCard,
      el("h2", {}, "Import a track list"),
      el(
        "p",
        { class: "help" },
        "A bc-tagger-import/1 file (a hand-written list parsed into rows). Rows found on Bandcamp become tagger items " +
          "(the extension adds them); the rest go to the Other collection. Nothing is added until you review the preview " +
          "and click Import selected."
      ),
      el("div", { class: "field" }, el("label", { class: "field-label", for: "importFile" }, "File"), fileInput, fileInfo),
      el(
        "div",
        { class: "field" },
        el("label", { class: "field-label" }, "Default tags"),
        tagsHolder,
        el("label", { class: "check-label" }, allBox, " Add default tags to all tracks"),
        el("div", { class: "help" }, "Off: only tracks with no tags get them. On: every track gets them on top of its own tags.")
      ),
      el(
        "div",
        { class: "field" },
        el("label", { class: "field-label" }, "Look up on Bandcamp"),
        el("label", { class: "check-label" }, viaServer, " by the server"),
        el("label", { class: "check-label" }, viaBrowser, " in my browser (the Bc Tagger extension, while this page stays open)"),
        el(
          "div",
          { class: "help" },
          "In your browser, the searches run in your Chrome session, paced by General → Bandcamp requests; they stop on Bandcamp's bot check or rate limit."
        )
      ),
      jsonRun,
      mapping
    ),
    el(
      "section",
      { id: "sec_import_files", "data-tab": "import" },
      el("h2", {}, "Import from Files"),
      el(
        "p",
        { class: "help" },
        "Audio files added to these folders since a date: one row per track (a track in several formats counts once), " +
          "folder by folder, oldest release first. Rows are already located to their files. Files already in your " +
          "collection show as duplicates, unticked. A Bandcamp link in a file's tags matches it directly; the rest are " +
          "looked up. Nothing is added until you click Import selected in the preview."
      ),
      el("div", { class: "field" }, el("label", { class: "field-label" }, "Folders"), folderList, addFolder, filesInfo),
      el(
        "div",
        { class: "field" },
        el("label", { class: "field-label" }, "Default tags"),
        filesTagsHolder,
        el("label", { class: "check-label" }, filesAllBox, " Add default tags to all tracks")
      ),
      el(
        "div",
        { class: "field" },
        el("label", { class: "field-label" }, "Look up on Bandcamp"),
        el("label", { class: "check-label" }, filesViaServer, " by the server"),
        el("label", { class: "check-label" }, filesViaBrowser, " in my browser (the Bc Tagger extension, while this page stays open)")
      ),
      filesRun
    ),
    el(
      "section",
      { id: "sec_import_batches", "data-tab": "import" },
      el("h2", {}, "Imports"),
      el("p", { class: "help" }, "Imports are kept until you discard them, so you can come back to a preview later."),
      batches
    ),
    el(
      "section",
      { id: "sec_import_logs", "data-tab": "import" },
      el("h2", {}, "Past imports"),
      el("p", { class: "help" }, "Each Import selected saves a log of what it imported (newest first)."),
      pastImports
    )
  );

  // --- file -------------------------------------------------------------------

  fileInput.addEventListener("change", async () => {
    fileData = null;
    start.disabled = true;
    const f = fileInput.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.format !== "bc-tagger-import/1" || !Array.isArray(data.items)) {
        throw new Error(`expected format bc-tagger-import/1 with items (got ${data.format || "no format"})`);
      }
      fileData = data;
      fileName = f.name;
      const unknown = Object.keys(data.unknown_tags || {});
      const existing = data.items.filter((it) => it.existing_id).length;
      const confirm = data.items.filter((it) => (it.flags || []).includes("needs_user_confirmation")).length;
      const pending = Array.isArray(data.pending_releases) ? data.pending_releases.length : 0;
      fileInfo.className = "help";
      fileInfo.textContent = [
        `${data.items.length} rows from ${data.source || f.name}`,
        existing ? `${existing} already in your collection` : "",
        confirm ? `${confirm} to confirm` : "",
        pending ? `${pending} release${pending > 1 ? "s" : ""} not importable yet (no tracklist)` : "",
        unknown.length ? `${unknown.length} tags not in your vocabulary (you'll map them next)` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      start.disabled = false;
    } catch (e) {
      fileInfo.className = "help err";
      fileInfo.textContent = `Can't use this file: ${e.message}`;
    }
  });

  // --- start + progress ---------------------------------------------------------

  const setHash = (id) => history.replaceState(null, "", `${location.search}#import/${encodeURIComponent(id)}`);

  start.addEventListener("click", async () => {
    if (!fileData) return;
    start.disabled = true;
    jsonRun.appendChild(progress);
    progress.hidden = false;
    progress.className = "import-progress";
    progress.textContent = "Starting…";
    let res;
    try {
      res = await startImport(fileData, fileName, defaultTags ? defaultTags.get() : [], allBox.checked, viaBrowser.checked ? "browser" : "server");
    } catch (e) {
      progress.className = "import-progress err";
      progress.textContent = `Import failed: ${e.message}`;
      start.disabled = false;
      return;
    }
    rememberImport(res.batch_id);
    setHash(res.batch_id);
    const est = res.estimate && res.estimate.text ? ` (${res.estimate.text})` : "";
    if (await follow(res.batch_id, res.job_id, est)) await afterLookups(res.batch_id);
    start.disabled = false;
    loadBatches();
  });

  // Import from Files: the server picks the files, looks them up, then the preview (no mapping step).
  filesStart.addEventListener("click", async () => {
    const chosen = folders.map((f) => ({ path: f.path.trim(), since: f.since })).filter((f) => f.path);
    filesInfo.className = "help err";
    if (!chosen.length) return (filesInfo.textContent = "Add a folder first.");
    if (chosen.some((f) => !f.since)) return (filesInfo.textContent = "Pick an “added since” date for every folder.");
    filesInfo.className = "help";
    filesInfo.textContent = "";
    filesStart.disabled = true;
    filesRun.appendChild(progress);
    progress.hidden = false;
    progress.className = "import-progress";
    progress.textContent = "Starting…";
    let res;
    try {
      res = await startFileImport({
        folders: chosen,
        lookup: filesViaBrowser.checked ? "browser" : "server",
        defaultTags: filesTags ? filesTags.get() : ["pool"],
        defaultTagsAll: filesAllBox.checked,
      });
    } catch (e) {
      progress.className = "import-progress err";
      progress.textContent = `Import failed: ${e.message}`;
      filesStart.disabled = false;
      return;
    }
    rememberImport(res.batch_id);
    setHash(res.batch_id);
    const est = res.estimate && res.estimate.text ? ` (${res.estimate.text})` : "";
    if (await follow(res.batch_id, res.job_id, est)) await afterLookups(res.batch_id);
    filesStart.disabled = false;
    loadBatches();
  });

  // After the server's first job: a browser batch waits for this page to run
  // its lookups; then (or for a server batch, now) the mapping step / preview.
  async function afterLookups(id) {
    const b = await getBatch(id).catch(() => null);
    if (b && stepOf(b) === "browser") return driveBrowser(id);
    return afterResolve(id);
  }

  // Run a browser batch's lookups through the extension, then follow the
  // locate job the server starts, then the next step.
  let driving = null;
  async function driveBrowser(id) {
    if (driving === id) return;
    driving = id;
    progress.hidden = false;
    progress.className = "import-progress";
    try {
      if (!bridge || !bridge.connected) {
        progress.className = "import-progress err";
        progress.textContent =
          "This import looks up in your browser: open this page in the Chrome profile that has the Bc Tagger extension (connected) and it carries on.";
        return;
      }
      let st;
      try {
        st = await runBrowserLookups(id, bridge, (s) => (progress.textContent = lookupsText(s)));
      } catch (e) {
        progress.className = "import-progress err";
        progress.textContent = `Lookups in your browser stopped: ${e.message}`;
        return;
      }
      progress.textContent = lookupsText(st);
      if (st.state === "paused") {
        progress.className = "import-progress err";
        const again = el("button", { type: "button", class: "mini-btn", id: "importResumeBrowser" }, "Resume in my browser");
        again.addEventListener("click", async () => {
          again.disabled = true;
          await resumeLookups(id).catch(() => {});
          driveBrowser(id);
        });
        progress.append(" ", again);
        return;
      }
      if (st.state === "stopped") progress.className = "import-progress err";
      const b = await getBatch(id);
      const jobId = (b.job && b.job.id) || b.job_id;
      if (b.status === "resolving" && jobId && !(await follow(id, jobId))) return;
      const now = await getBatch(id);
      if (now.status === "ready") await afterResolve(id);
    } finally {
      driving = null;
    }
  }

  // Follow a batch's lookups (its job) until they're done; also after a
  // reload or coming back from another page: nothing was cancelled meanwhile.
  let following = null;
  async function follow(batchId, jobId, est = "") {
    following = batchId;
    progress.hidden = false;
    progress.className = "import-progress";
    progress.textContent = `Looking up rows on Bandcamp${est}…`;
    const known = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`).then((r) => r.ok, () => false);
    if (!known) {
      following = null;
      progress.className = "import-progress err";
      progress.textContent = "The lookups of this import stopped (the server restarted?). Discard it and start again.";
      return false;
    }
    const job = await jobs.watch(jobId, (j) => {
      if (following === batchId) progress.textContent = `Looking up rows on Bandcamp and locating files${est}: ${progressText(j)}`;
    });
    following = null;
    if (job.status === "error") {
      progress.className = "import-progress err";
      progress.textContent = `Import failed: ${job.error || "error"}`;
      return false;
    }
    progress.textContent = `Done: ${resultText(job)}`;
    return true;
  }

  // Back to an open import's step: its progress, the mapping step, or (when
  // asked for it by id) the preview.
  async function resume(id, explicit) {
    let batch;
    try {
      batch = await getBatch(id);
    } catch (e) {
      if (rememberedImport() === id) rememberImport(null); // discarded meanwhile
      return;
    }
    if (batch.committed) {
      if (rememberedImport() === id) rememberImport(null);
      if (explicit) location.href = previewUrl(id);
      return;
    }
    rememberImport(id);
    (batch.fromFiles ? filesRun : jsonRun).appendChild(progress);
    showOpen(batch);
    const step = stepOf(batch);
    const jobId = (batch.job && batch.job.id) || batch.job_id;
    if (step === "browser") {
      setHash(id);
      driveBrowser(id);
    } else if (step === "progress") {
      setHash(id);
      if (following !== id && jobId && (await follow(id, jobId))) await afterLookups(id);
    } else if (step === "interrupted") {
      setHash(id);
      progress.hidden = false;
      progress.className = "import-progress err";
      progress.textContent = batch.error || "The lookups were interrupted (the server restarted).";
    } else if (step === "mapping") {
      setHash(id);
      progress.hidden = false;
      progress.className = "import-progress";
      progress.textContent = statsLine(batch.stats);
      if (mapping.hidden || mapping.dataset.batch !== id) showMapping(batch);
    } else if (["review", "committing"].includes(step) && explicit) {
      location.href = previewUrl(id);
    }
  }

  // The open import, at the top of the tab.
  function showOpen(batch) {
    openCard.hidden = false;
    openCard.innerHTML = "";
    const step = stepOf(batch);
    const del = el("button", { type: "button", class: "secondary", id: "importDiscardOpen" }, "Discard");
    del.addEventListener("click", () => discard(batch.id));
    let go;
    if (step === "interrupted" && batch.resumable) {
      // Finishes from the server's cache: only rows never fetched go to Bandcamp.
      go = el("button", { type: "button", id: "importResume" }, "Resume lookups");
      go.addEventListener("click", async () => {
        go.disabled = true;
        try {
          const res = await resumeLookups(batch.id);
          const est = res.estimate && res.estimate.text ? ` (${res.estimate.text})` : "";
          openCard.hidden = true;
          if (await follow(batch.id, res.job_id, est)) await afterResolve(batch.id);
        } catch (e) {
          go.disabled = false;
          progress.className = "import-progress err";
          progress.textContent = `Couldn't resume: ${e.message}`;
        }
        loadBatches();
      });
    } else {
      go = el("a", { class: "button-link", id: "importContinue", href: stepUrl(batch) }, step === "review" ? "Continue review →" : "Continue →");
    }
    openCard.append(
      el("strong", {}, "Open import: "),
      `${batch.source || batch.id} · ${stepLabel(batch).replace(/^Import:? ?/, "")} `,
      go,
      " ",
      del
    );
  }

  async function discard(id) {
    if (!confirm("Discard this import? Nothing is added to your collection; rows already imported stay.")) return;
    await discardBatch(id).catch(() => {});
    if (rememberedImport() === id) rememberImport(null);
    openCard.hidden = true;
    mapping.hidden = true;
    progress.hidden = true;
    history.replaceState(null, "", `${location.search}#import`);
    loadBatches();
  }

  async function afterResolve(batchId) {
    const batch = await getBatch(batchId);
    const blocked = batch.rows.filter((r) => r.lookupUnavailable && r.source !== "bandcamp").length;
    progress.textContent =
      statsLine(batch.stats) + (blocked ? ` · Bandcamp lookup unavailable for ${blocked} rows (bot check): link them by hand in the preview` : "");
    const unknown = Object.keys(batch.unknownTags || {});
    if (unknown.length) showMapping(batch);
    else location.href = previewUrl(batchId);
  }

  // --- tag mapping step -------------------------------------------------------

  function showMapping(batch) {
    mapping.hidden = false;
    mapping.dataset.batch = batch.id;
    mapping.innerHTML = "";
    const counts = {};
    batch.rows.forEach((r) => r.tags.forEach((t) => (counts[t] = (counts[t] || 0) + 1)));
    const selects = {};
    const rows = Object.entries(batch.unknownTags).map(([tag, suggested]) => {
      const s = tagSelect(`map_${tag}`, vocab, Array.isArray(suggested) ? suggested : [], "100%");
      selects[tag] = s;
      return el(
        "div",
        { class: "map-row", "data-tag": tag },
        el("div", { class: "map-tag" }, tag, el("span", { class: "muted" }, counts[tag] ? ` · ${counts[tag]} row${counts[tag] > 1 ? "s" : ""}` : "")),
        el("div", {}, s.node)
      );
    });
    const status = el("span", { class: "help", id: "mappingStatus" });
    const apply = async (unmapped) => {
      const map = {};
      Object.entries(selects).forEach(([tag, s]) => {
        const v = s.get();
        if (v.length) map[tag] = v;
      });
      status.textContent = "Applying…";
      try {
        await applyTagMap(batch.id, map, unmapped);
        location.href = previewUrl(batch.id);
      } catch (e) {
        status.className = "help err";
        status.textContent = `Not applied: ${e.message}`;
      }
    };
    mapping.append(
      el("h3", {}, `${rows.length} tags aren't in your vocabulary`),
      el(
        "p",
        { class: "help" },
        "Map each one to one or more of your tags (pre-filled with the file's suggestions), or leave it empty. Then " +
          "either create the unmapped ones as new tags, or drop them from the rows."
      ),
      el("div", { class: "mapping-rows import-mapping-rows" }, rows),
      el(
        "div",
        { class: "import-actions" },
        el("button", { type: "button", id: "mapCreate", onclick: () => apply("create") }, "Create unmapped tags"),
        el("button", { type: "button", id: "mapIgnore", class: "secondary", onclick: () => apply("ignore") }, "Ignore new tags"),
        status
      )
    );
    Object.values(selects).forEach((s) => s.init());
    mapping.scrollIntoView({ block: "start" });
  }

  // --- previous imports -----------------------------------------------------------

  async function loadBatches() {
    batches.innerHTML = "";
    let list = [];
    try {
      list = await listBatches();
    } catch (e) {
      batches.appendChild(el("p", { class: "help" }, e.status === 404 ? "This server can't import yet." : `Can't list imports: ${e.message}`));
      return [];
    }
    if (!list.length) {
      batches.appendChild(el("p", { class: "help" }, "No imports yet."));
      return list;
    }
    list.forEach((b) => {
      const when = b.created_at ? new Date(b.created_at).toLocaleString() : "";
      const del = el("button", { type: "button", class: "icon", title: "Discard this import" }, "×");
      del.addEventListener("click", () => discard(b.id));
      batches.appendChild(
        el(
          "div",
          { class: "batch-row", "data-batch": b.id },
          el("a", { href: b.committed ? previewUrl(b.id) : stepUrl(b) }, b.source || b.id),
          el("span", { class: "muted" }, [when, b.committed ? "imported" : stepLabel(b).replace(/^Import:? ?/, ""), statsLine(b.stats)].filter(Boolean).join(" · ")),
          b.committed ? "" : el("a", { class: "button-link", href: stepUrl(b) }, "Resume"),
          del
        )
      );
    });
    return list;
  }

  return {
    // `id`: the import asked for (#import/<id>); otherwise the newest open one.
    async show(id) {
      if (!defaultTags) {
        vocab = await apiJson("/api/tags").catch(() => []);
        defaultTags = tagSelect("importDefaultTags", vocab, vocab.includes("must") ? ["must"] : [], "420px");
        tagsHolder.appendChild(defaultTags.node);
        defaultTags.init();
      }
      if (!filesTags) {
        filesTags = tagSelect("importFilesDefaultTags", vocab, ["pool"], "420px");
        filesTagsHolder.appendChild(filesTags.node);
        filesTags.init();
        try {
          folders = await fileImportDefaults();
        } catch (e) {
          filesInfo.className = "help err";
          filesInfo.textContent = e.status === 404 ? "This server can't import from files yet." : `Can't read the default folders: ${e.message}`;
          filesStart.disabled = e.status === 404;
        }
        if (!folders.length) folders = [{ path: "", since: weekAgo() }];
        renderFolders();
      }
      const list = await loadBatches();
      renderPastImports(pastImports);
      const legacy = new URLSearchParams(location.search).get("map"); // older links
      const open = list.filter((b) => !b.committed);
      const target = id || legacy || (open[0] && open[0].id);
      if (target) resume(target, !!(id || legacy));
      else openCard.hidden = true;
    },
  };
}

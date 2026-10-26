// Settings → Import: pick a bc-tagger-import/1 file, choose default tags,
// start the import (the server resolves rows on Bandcamp and locates them),
// then map unknown tags and continue to the preview page.

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { ServerEvents } from "../../shared/datasource/serverEvents";
import { Jobs, progressText, resultText } from "./jobs";
import { listBatches, getBatch, startImport, applyTagMap, discardBatch } from "./importApi";

const STAT_LABELS = [
  ["total", "rows"],
  ["bandcamp", "on Bandcamp"],
  ["other", "other"],
  ["located", "located"],
  ["duplicates", "duplicates"],
  ["flagged", "flagged"],
  ["unknown_tags", "unknown tags"],
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

export function statsLine(stats) {
  return STAT_LABELS.filter(([k]) => stats && stats[k] != null)
    .map(([k, label]) => `${typeof stats[k] === "object" ? Object.keys(stats[k]).length : stats[k]} ${label}`)
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

export function createImportTab(container) {
  const events = new ServerEvents().start();
  const jobs = new Jobs(events);
  let vocab = [];
  let fileData = null;
  let fileName = "";
  let defaultTags = null;

  const fileInput = el("input", { type: "file", id: "importFile", accept: ".json,application/json" });
  const fileInfo = el("div", { class: "help", id: "importFileInfo" });
  const tagsHolder = el("div", { id: "importDefaultTagsHolder" });
  const start = el("button", { type: "button", id: "importStart", disabled: true }, "Start import");
  const progress = el("div", { class: "import-progress", id: "importProgress", hidden: true });
  const mapping = el("div", { class: "import-mapping", id: "importMapping", hidden: true });
  const batches = el("div", { id: "importBatches" });

  container.append(
    el(
      "section",
      { id: "sec_import", "data-tab": "import" },
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
        el("div", { class: "help" }, "Added to rows that have no tags. Tags already in the file are kept.")
      ),
      el("div", { class: "field" }, start, progress),
      mapping
    ),
    el(
      "section",
      { id: "sec_import_batches", "data-tab": "import" },
      el("h2", {}, "Imports"),
      el("p", { class: "help" }, "Imports are kept until you discard them, so you can come back to a preview later."),
      batches
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

  start.addEventListener("click", async () => {
    if (!fileData) return;
    start.disabled = true;
    progress.hidden = false;
    progress.className = "import-progress";
    progress.textContent = "Starting…";
    let batchId;
    try {
      const res = await startImport(fileData, fileName, defaultTags ? defaultTags.get() : []);
      batchId = res.batch_id;
      const job = await jobs.watch(res.job_id, (j) => (progress.textContent = `Looking up rows on Bandcamp and locating files: ${progressText(j)}`));
      if (job.status === "error") throw new Error(job.error || "import failed");
      progress.textContent = `Done: ${resultText(job)}`;
    } catch (e) {
      progress.className = "import-progress err";
      progress.textContent = `Import failed: ${e.message}`;
      start.disabled = false;
      return;
    }
    await afterResolve(batchId);
    loadBatches();
  });

  async function afterResolve(batchId) {
    const batch = await getBatch(batchId);
    progress.textContent = statsLine(batch.stats);
    const unknown = Object.keys(batch.unknownTags || {});
    if (unknown.length) showMapping(batch);
    else location.href = previewUrl(batchId);
  }

  // --- tag mapping step -------------------------------------------------------

  function showMapping(batch) {
    mapping.hidden = false;
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
      return;
    }
    if (!list.length) {
      batches.appendChild(el("p", { class: "help" }, "No imports yet."));
      return;
    }
    list.forEach((b) => {
      const when = b.created_at ? new Date(b.created_at).toLocaleString() : "";
      const del = el("button", { type: "button", class: "icon", title: "Discard this import" }, "×");
      del.addEventListener("click", async () => {
        if (!confirm("Discard this import? Rows already imported stay in your collection.")) return;
        await discardBatch(b.id).catch(() => {});
        loadBatches();
      });
      batches.appendChild(
        el(
          "div",
          { class: "batch-row" },
          el("a", { href: previewUrl(b.id) }, b.source || b.id),
          el("span", { class: "muted" }, [when, b.committed ? "imported" : b.status || "", statsLine(b.stats)].filter(Boolean).join(" · ")),
          del
        )
      );
    });
  }

  return {
    async show() {
      if (!defaultTags) {
        vocab = await apiJson("/api/tags").catch(() => []);
        defaultTags = tagSelect("importDefaultTags", vocab, vocab.includes("must") ? ["must"] : [], "420px");
        tagsHolder.appendChild(defaultTags.node);
        defaultTags.init();
      }
      loadBatches();
      // Coming back to an import that still needs its tags mapped.
      const resume = new URLSearchParams(location.search).get("map");
      if (resume) afterResolve(resume);
    },
  };
}

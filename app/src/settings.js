// Settings page: edits the server's settings (GET/PUT /api/settings).
// Known keys get a dedicated editor; unknown keys still show up under
// "Advanced" so new server settings are editable without a UI change.

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { ExtensionBridge } from "../../shared/datasource/extensionBridge";
import { buildNav } from "./nav";
import { startDevReload } from "./devReload";
import { confirmDialog } from "./dialog";
import { createMappingEditor } from "./mappingEditor";
import { attachSavedMappings } from "./savedMappings";
import { createTestTab } from "./testTab";
import { createImportTab } from "./importTab";
import { createPreviewUsage } from "./previewUsage";

const TABS = [
  ["general", "General"],
  ["rekordbox", "Rekordbox"],
  ["previews", "Previews"],
  ["import", "Import"],
  ["test", "Test"], // test-only actions (Locate / Export latest 10)
];
let importTab = null;
let previewUsage = null;

// "#import/<batch id>" → {tab: "import", arg: "<batch id>"}; unknown tabs → null.
function fromHash() {
  const [tab, ...rest] = location.hash.replace(/^#/, "").split("/");
  if (!TABS.some(([id]) => id === tab)) return null;
  return { tab, arg: rest.length ? decodeURIComponent(rest.join("/")) : null };
}

// [id, tab, title, help]
const SECTIONS = [
  ["folders", "general", "Music folders", "Where the indexer looks for your files. Files are referenced in place, never moved."],
  ["matching", "general", "Matching", "How tagged Bandcamp items are matched to local files."],
  ["bandcamp", "general", "Bandcamp", "Ownership normally comes from the extension's live session; these are the fallback."],
  ["lookups", "general", "Import", "Where an import looks rows up, and where its logs go."],
  ["downloads", "general", "Downloads", "Download (in the Located column) gets releases you own from your Bandcamp collection."],
  ["bandcamp_requests", "general", "Bandcamp requests", "Lower values are faster, but can trigger Bandcamp's rate limiting (HTTP 429); then the server backs off and waits."],
  ["server", "general", "Server", ""],
  ["advanced", "general", "Advanced", ""],
  ["rb_target", "rekordbox", "Target library", "Where exports write. Your main collection needs an explicit opt-in, and every export to it shows a dry run first."],
  ["rb_playlists", "rekordbox", "Playlists", "Which rekordbox playlists each tag goes to."],
  ["rb_files", "rekordbox", "Files", ""],
  [
    "previews",
    "previews",
    "Previews",
    "Quick-starting copies of your AIFF and ALAC files (Opus), kept on this Mac: they play at once, even with the " +
      "music drive asleep or unplugged. Made in the background (an import, a download, a first play) or all at once " +
      "with Build previews in the collection's Tools ▾.",
  ],
];

const FIELDS = {
  roots_preset: { section: "folders", type: "preset", label: "Folder preset" },
  owned_root: {
    section: "folders",
    type: "path",
    label: "Owned folder",
    help: "Bandcamp purchases (downloader output: <artist>/<year> - <release>/).",
  },
  not_owned_roots: {
    section: "folders",
    type: "roots",
    label: "Not-owned folders",
    help: "E.g. Soulseek downloads. Optional globs limit what is indexed (e.g. **/*.aiff).",
  },
  extra_roots: {
    section: "folders",
    type: "roots-kind",
    label: "More folders",
    help: "Indexed in addition to the folders above, each marked owned or not owned (e.g. the test folders).",
  },
  format_preference: {
    section: "matching",
    type: "order",
    label: "Format preference",
    help: "When several files match, the first format in this list wins.",
  },
  match_threshold: { section: "matching", type: "ratio", label: "Auto-accept matches at or above" },
  quick_scan_margin_days: {
    section: "matching",
    type: "int",
    label: "Quick scan: also look this many days before the tag date",
    help: "Locate and Export only check files created or changed since the oldest selected item was tagged, minus this margin. The full drive is only scanned with Rescan drive.",
  },
  full_rescan_hint_days: {
    section: "matching",
    type: "int",
    label: "Suggest a full rescan after (days)",
    help: "The collection page suggests Rescan drive when the last full scan is older than this.",
  },
  candidate_threshold: {
    section: "matching",
    type: "ratio",
    label: "Offer candidates at or above",
    help: "Below auto-accept, matches are listed for you to confirm in the Located column.",
  },
  rekordbox_target: { section: "rb_target", type: "target", label: "Target library" },
  allow_main_writes: { section: "rb_target", type: "part" }, // edited by the target editor
  rekordbox_db_path: {
    section: "rb_target",
    type: "path",
    label: "Test library database",
    help: "Exports go here while the target is Test. Writes need the test-library marker file in its folder.",
  },
  rekordbox_main_db_path: {
    section: "rb_target",
    type: "path",
    label: "Main library database",
    help: "Your real collection. Exports go here while the target is Main, and write only when allowed above; bc-tagger backs it up before every write.",
  },
  playlist_folder: {
    section: "rb_playlists",
    type: "text",
    label: "Target folder",
    help: "The rekordbox folder for bc-tagger's playlists: plain playlist names below (and every tag in Auto mode) go inside it.",
  },
  tag_playlist_mode: { section: "rb_playlists", type: "mapping", label: "Tags → playlists" },
  tag_playlist_map: { section: "rb_playlists", type: "part" }, // edited by the mapping editor
  playlist_mappings: { section: "rb_playlists", type: "part" }, // per library: the folder and mapping above, and Save mapping
  xml_output_dir: {
    section: "rb_files",
    type: "path",
    label: "XML export folder",
    placeholder: "default: the server's data folder / exports",
  },
  bandcamp_username: { section: "bandcamp", type: "text", label: "Bandcamp username" },
  bandcamp_request_interval_s: {
    section: "bandcamp_requests",
    type: "number",
    min: 0.1,
    step: 0.1,
    label: "Server lookups: seconds between requests",
    help: "The import's Bandcamp lookups. Default 1, at least 0.1. Lower is faster; a 429 from Bandcamp makes the server back off.",
  },
  bandcamp_browser_concurrency: {
    section: "bandcamp_requests",
    type: "number",
    min: 1,
    max: 4,
    step: 1,
    label: "Browser actions: parallel requests",
    help: "Fix album IDs, Refresh player files and thumbnails, and loading a track to play, through the extension. Default 2.",
  },
  bandcamp_browser_spacing_ms: {
    section: "bandcamp_requests",
    type: "number",
    min: 100,
    step: 50,
    label: "Browser actions: spacing (ms)",
    help: "The wait before the next request once one finishes. Default 400.",
  },
  cookies_file: { section: "bandcamp", type: "path", label: "Cookies file", help: "Netscape cookies.txt." },
  server_port: {
    section: "server",
    type: "int",
    label: "Port",
    help: "Takes effect after the server restarts. Update the server URL in the extension popup to match.",
  },
  seed_export_json: { section: "advanced", type: "path", label: "Seed export JSON" },
  app_dist_dir: { section: "advanced", type: "path", label: "App build folder", placeholder: "default: bc-tagger/app/dist" },
  lookup_source: {
    section: "lookups",
    type: "select",
    label: "Look rows up on",
    options: ["bandcamp", "musicbrainz", "both"],
    help:
      "bandcamp (default): Bandcamp's search. musicbrainz: MusicBrainz only, no Bandcamp requests; rows get its Bandcamp/Discogs links as hints. " +
      "both: Bandcamp first, then MusicBrainz for what Bandcamp didn't find.",
  },
  import_log_dir: {
    section: "lookups",
    type: "path",
    label: "Import log folder",
    placeholder: "default: import-logs in the server's data folder",
    help: "Import selected saves a log of everything it imported here, named by date and time.",
  },
  downloads_dir: {
    section: "downloads",
    type: "path",
    label: "Download into",
    placeholder: "default: the owned folder",
    help: "Must be inside your owned folder. Each release gets its own <artist>/<year> - <release>/ folder.",
  },
  download_format: {
    section: "downloads",
    type: "select",
    label: "Audio format",
    options: ["aiff-lossless", "flac", "wav", "alac", "mp3-320", "mp3-v0", "aac-hi", "vorbis"],
  },
  download_parallel: {
    section: "downloads",
    type: "number",
    min: 1,
    max: 8,
    step: 1,
    label: "Parallel downloads",
    help: "How many releases download at once. Default 4. More is faster, but Bandcamp can slow down or refuse them.",
  },
  download_timeout_s: {
    section: "downloads",
    type: "number",
    min: 30,
    step: 10,
    label: "Download timeout (s)",
    help: "How long a download may go without data before it's retried (the reason shows in its row). At least 30; default 180.",
  },
  preview_cache_gb: {
    section: "previews",
    type: "number",
    min: 0,
    step: 0.5,
    label: "Space for previews (GB)",
    help:
      "Default 3.5: about 850 five-minute tracks. 0 turns previews off. Saving a lower value drops the least " +
      "recently played previews at once, down to it.",
  },
  preview_bitrate_kbps: {
    section: "previews",
    type: "number",
    min: 32,
    max: 256,
    step: 8,
    label: "Bitrate (kbps)",
    help: "Opus; default 96. For new previews: the ones made keep theirs (Clear previews, then build again).",
  },
  preview_build_parallel: {
    section: "previews",
    type: "number",
    min: 1,
    max: 32,
    step: 1,
    label: "Parallel encoders",
    help: "How many files Build previews encodes at once (one reader feeds them from the drive). Default: this Mac's cores but two.",
  },
  downloader_dir: { section: "advanced", type: "path", label: "Downloader folder" },
  dev_extension_build_dir: { section: "advanced", type: "path", label: "Dev extension build folder" },
};

const nav = buildNav("settings");
nav.trackImports();
const bridge = new ExtensionBridge();

let loaded = {}; // last saved values (without presets)
let presets = {};
let values = {}; // current form values
const editors = {}; // key -> {get(), set(v)}

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

function changed() {
  values = {};
  Object.entries(editors).forEach(([k, ed]) => (values[k] = ed.get()));
  const dirty = Object.keys(values).filter((k) => JSON.stringify(values[k]) !== JSON.stringify(loaded[k]));
  document.getElementById("saveBtn").disabled = !dirty.length;
  document.getElementById("revertBtn").disabled = !dirty.length;
  document.getElementById("saveState").textContent = dirty.length ? `${dirty.length} unsaved change${dirty.length > 1 ? "s" : ""}` : "";
  document
    .querySelectorAll(".field[data-key]") // settings fields only (the Import tab has others)
    .forEach((f) => f.classList.toggle("dirty", dirty.some((k) => (f.dataset.keys || f.dataset.key).split(" ").includes(k))));
  document.querySelectorAll("#tabs [data-tab]").forEach((b) =>
    b.classList.toggle("dirty", dirty.some((k) => tabOf(k) === b.dataset.tab))
  );
  return dirty;
}

function tabOf(key) {
  const def = FIELDS[key] || { section: "advanced" };
  return (SECTIONS.find(([id]) => id === def.section) || [])[1];
}

// --- Editors -----------------------------------------------------------------

function textEditor(key, def, numeric) {
  const input = el("input", {
    type: numeric ? "number" : "text",
    id: `f_${key}`,
    placeholder: def.placeholder || "",
    spellcheck: "false",
    oninput: () => {
      if (def.type === "path" && ["owned_root", "not_owned_roots"].includes(key)) markCustomPreset();
      changed();
    },
  });
  if (def.type === "path") input.classList.add("path");
  ["min", "max", "step"].forEach((a) => def[a] != null && input.setAttribute(a, def[a]));
  return {
    node: input,
    get: () => (numeric ? Number(input.value) : input.value),
    set: (v) => (input.value = v == null ? "" : v),
  };
}

function selectEditor(key, def) {
  const sel = el("select", { id: `f_${key}`, onchange: () => changed() });
  (def.options || []).forEach((o) => sel.appendChild(new Option(o, o)));
  return {
    node: sel,
    get: () => sel.value,
    set: (v) => {
      if (v && ![...sel.options].some((o) => o.value === v)) sel.appendChild(new Option(v, v));
      sel.value = v || "";
    },
  };
}

function ratioEditor(key) {
  const num = el("input", { type: "number", min: "0", max: "1", step: "0.01", id: `f_${key}`, class: "ratio-num" });
  const range = el("input", { type: "range", min: "0", max: "1", step: "0.01", "aria-label": key });
  num.addEventListener("input", () => {
    range.value = num.value;
    changed();
  });
  range.addEventListener("input", () => {
    num.value = range.value;
    changed();
  });
  return {
    node: el("div", { class: "ratio" }, range, num),
    get: () => Number(num.value),
    set: (v) => {
      num.value = v;
      range.value = v;
    },
  };
}

function orderEditor() {
  const list = el("ol", { class: "order" });
  let items = [];
  const render = () => {
    list.innerHTML = "";
    items.forEach((name, i) => {
      const up = el("button", { type: "button", title: "Move up", disabled: i === 0 }, "↑");
      const down = el("button", { type: "button", title: "Move down", disabled: i === items.length - 1 }, "↓");
      up.addEventListener("click", () => move(i, -1));
      down.addEventListener("click", () => move(i, 1));
      list.appendChild(el("li", {}, el("span", { class: "order-name" }, name), up, down));
    });
  };
  const move = (i, d) => {
    [items[i], items[i + d]] = [items[i + d], items[i]];
    render();
    changed();
  };
  return {
    node: list,
    get: () => items.slice(),
    set: (v) => {
      items = Array.isArray(v) ? v.slice() : [];
      render();
    },
  };
}

// A list of folders with optional globs; `withKind` adds an owned / not owned
// choice per folder (extra_roots). Only the preset's own lists switch the
// preset to "custom" when edited.
function rootsEditor({ withKind = false } = {}) {
  const wrap = el("div", { class: "roots" });
  const rows = el("div", {});
  let roots = [];
  const add = el("button", { type: "button", class: "secondary" }, "Add folder");
  const edited = () => {
    if (!withKind) markCustomPreset();
    changed();
  };
  const render = () => {
    rows.innerHTML = "";
    roots.forEach((r, i) => {
      const path = el("input", { type: "text", class: "path", value: r.path, placeholder: "/path/to/folder", spellcheck: "false" });
      const globs = el("input", {
        type: "text",
        class: "globs",
        value: (r.globs || []).join(", "),
        placeholder: "globs (optional), e.g. **/*.aiff",
        spellcheck: "false",
      });
      const del = el("button", { type: "button", class: "icon", title: "Remove this folder" }, "×");
      path.addEventListener("input", () => {
        r.path = path.value;
        edited();
      });
      globs.addEventListener("input", () => {
        r.globs = globs.value.split(",").map((g) => g.trim()).filter(Boolean);
        changed();
      });
      del.addEventListener("click", () => {
        roots.splice(i, 1);
        render();
        edited();
      });
      const cells = [path, globs];
      if (withKind) {
        const kind = el("select", { class: "kind", "aria-label": "Kind" });
        kind.append(new Option("owned", "owned", false, r.kind === "owned"), new Option("not owned", "not_owned", false, r.kind !== "owned"));
        kind.addEventListener("change", () => {
          r.kind = kind.value;
          changed();
        });
        cells.push(kind);
      }
      rows.appendChild(el("div", { class: withKind ? "root-row with-kind" : "root-row" }, ...cells, del));
    });
  };
  add.addEventListener("click", () => {
    roots.push(withKind ? { path: "", globs: [], kind: "not_owned" } : { path: "", globs: [] });
    render();
    changed();
  });
  wrap.append(rows, add);
  return {
    node: wrap,
    get: () =>
      roots.map((r) => {
        const out = { path: r.path, globs: (r.globs || []).slice() };
        if (withKind) out.kind = r.kind === "owned" ? "owned" : "not_owned";
        return out;
      }),
    set: (v) => {
      roots = (Array.isArray(v) ? v : []).map((r) =>
        typeof r === "string"
          ? { path: r, globs: [], kind: "not_owned" }
          : { path: r.path || "", globs: (r.globs || []).slice(), kind: r.kind }
      );
      render();
    },
  };
}

function presetEditor() {
  const box = el("div", { class: "preset" });
  let current = "custom";
  const names = [...Object.keys(presets), "custom"];
  const radios = names.map((name) => {
    const r = el("input", { type: "radio", name: "roots_preset", value: name, id: `preset_${name}` });
    r.addEventListener("change", () => {
      current = name;
      if (presets[name]) {
        editors.owned_root.set(presets[name].owned_root);
        editors.not_owned_roots.set(presets[name].not_owned_roots);
      }
      changed();
    });
    const label = { test: "Test folders", production: "Production folders", custom: "Custom" }[name] || name;
    return el("label", { class: "radio", for: `preset_${name}` }, r, ` ${label}`);
  });
  box.append(...radios);
  return {
    node: box,
    get: () => current,
    set: (v) => {
      current = v || "custom";
      const r = box.querySelector(`input[value="${current}"]`);
      if (r) r.checked = true;
    },
  };
}

function markCustomPreset() {
  if (!editors.roots_preset || !editors.owned_root) return;
  const owned = editors.owned_root.get();
  const roots = JSON.stringify(editors.not_owned_roots.get());
  const match = Object.keys(presets).find(
    (p) => presets[p].owned_root === owned && JSON.stringify(presets[p].not_owned_roots) === roots
  );
  editors.roots_preset.set(match || "custom");
}

function genericEditor(key, value) {
  if (typeof value === "boolean") {
    const box = el("input", { type: "checkbox", id: `f_${key}`, onchange: changed });
    return { node: box, get: () => box.checked, set: (v) => (box.checked = !!v) };
  }
  if (typeof value === "number") return textEditor(key, {}, true);
  if (typeof value === "string") return textEditor(key, { type: "text" });
  const area = el("textarea", { id: `f_${key}`, rows: "3", oninput: changed, spellcheck: "false" });
  return {
    node: area,
    get: () => {
      try {
        return JSON.parse(area.value);
      } catch (e) {
        return area.value;
      }
    },
    set: (v) => (area.value = JSON.stringify(v, null, 2)),
  };
}

// The main-collection opt-in: one checkbox drives rekordbox_target ("test" |
// "main") and allow_main_writes. Ticking it asks first, with a clear warning
// and a backup reminder; unticking returns to the test library.
// Target (Test / Main): the library exports read from and write to, and that
// the Playlists section shows. Separate from "Allow … main collection": a main
// target with writes locked is read-only (exports stop at the dry run).
function targetEditor() {
  let target = "test";
  const radios = {};
  const radio = (value, text) => {
    const r = el("input", { type: "radio", name: "rbTarget", id: `f_target_${value}`, value });
    r.addEventListener("change", () => {
      if (!r.checked) return;
      target = value;
      paint();
      showLibrary(target); // its own Target folder and mapping
      changed();
      loadMappingData(target); // the Playlists marks follow the chosen library
    });
    radios[value] = r;
    return el("label", { class: "target-radio", for: `f_target_${value}` }, r, ` ${text}`);
  };
  const choice = el("div", { class: "target-choice", role: "radiogroup", "aria-label": "Target library" }, radio("test", "Test library"), radio("main", "Main library"));
  const box = el("input", { type: "checkbox", id: "f_allow_main_writes" });
  const label = el("label", { class: "target-toggle", for: "f_allow_main_writes" }, box, " Allow bc-tagger to write to my main rekordbox collection");
  const banner = el("div", { class: "main-banner", id: "mainTargetBanner", hidden: true });
  const paint = () => {
    Object.entries(radios).forEach(([v, r]) => (r.checked = v === target));
    const path = (editors.rekordbox_main_db_path && editors.rekordbox_main_db_path.get()) || "~/Library/Pioneer/rekordbox/master.db";
    banner.hidden = target !== "main";
    banner.classList.toggle("read-only", !box.checked);
    banner.textContent = box.checked
      ? `MAIN LIBRARY · writes enabled: exports write to ${path}. Each export shows a dry run and asks before writing. rekordbox must be closed.`
      : `MAIN LIBRARY · read-only: exports to ${path} stop at the dry run until you allow writes below.`;
  };
  box.addEventListener("change", async () => {
    if (box.checked) {
      box.checked = false;
      const ok = await confirmDialog({
        id: "mainLibraryConfirm",
        danger: true,
        title: "Write to your main rekordbox collection?",
        body: mainWarning(),
        requireAck: "I've made a backup of my rekordbox library (File → Library → Backup Library)",
        confirmLabel: "Allow writes to my main collection",
      });
      box.checked = ok;
    }
    paint(); // unticking locks writes; the target stays as chosen
    changed();
  });
  const node = el("div", { class: "target" }, choice, banner, label);
  return {
    node,
    parts: {
      rekordbox_target: { get: () => target, set: (v) => ((target = v === "main" ? "main" : "test"), paint()) },
      allow_main_writes: { get: () => box.checked, set: (v) => ((box.checked = !!v), paint()) },
    },
  };
}

function mainWarning() {
  const path = (editors.rekordbox_main_db_path && editors.rekordbox_main_db_path.get()) || "~/Library/Pioneer/rekordbox/master.db";
  const wrap = el("div", {});
  wrap.append(
    el("div", { class: "warn-box" }, "bc-tagger will write to your real rekordbox library: ", el("code", {}, path), " (and its masterPlaylists6.xml)."),
    el(
      "ul",
      {},
      el("li", {}, "Quit rekordbox before exporting: the server refuses to write while it runs, and while the test library is switched in."),
      el("li", {}, "Exports only add tracks and playlist entries. Existing tracks are never edited, and playlists bc-tagger didn't create are never deleted."),
      el("li", {}, "Before each write bc-tagger copies master.db and masterPlaylists6.xml to its own backup folder (the last 5 are kept)."),
      el("li", {}, "Every export shows a dry run (playlists to create, tracks to add, entries per playlist) and asks before writing.")
    ),
    el("p", {}, "Make your own backup first: in rekordbox, File → Library → Backup Library."),
    el("p", { class: "muted" }, "Takes effect when you save settings. Unticking it locks writes again; the target stays as chosen.")
  );
  return wrap;
}

let mapping = null;
let savedMaps = null; // the mappings kept per Target folder (a server with playlist_mappings)

function mappingEditor() {
  mapping = createMappingEditor({ onChange: changed, onSave: "playlist_mappings" in loaded ? () => savedMaps && savedMaps.save() : null });
  return {
    node: mapping.node,
    parts: {
      tag_playlist_mode: { get: mapping.getMode, set: mapping.setMode },
      tag_playlist_map: { get: mapping.getMap, set: mapping.setMap },
    },
  };
}

// Each rekordbox library's own Target folder and mapping (a server with playlist_mappings: {test|main: {folder, mode,
// map, saved}}). The page shows the library picked in the Target radios, before it's saved, and keeps the other's
// edits meanwhile; Save settings sends both. (The flat playlist_folder / tag_playlist_* keys mirror the library in
// use on the server: the page doesn't edit them then.)
let libMaps = null; // the page's copy
let shownLib = null;
const folderField = () => document.getElementById("f_playlist_folder");

function syncShown() {
  if (!libMaps || !libMaps[shownLib]) return;
  Object.assign(libMaps[shownLib], { folder: folderField().value.trim(), mode: mapping.getMode(), map: mapping.getMap() });
}

function loadLibrary(lib) {
  shownLib = libMaps[lib] ? lib : Object.keys(libMaps)[0];
  const e = libMaps[shownLib] || { folder: "", mode: "auto", map: {} };
  folderField().value = e.folder || "";
  mapping.load({ mode: e.mode, map: e.map });
  mapping.setTargetFolder(folderField().value);
  mapping.setSaveNote("");
  if (savedMaps) savedMaps.reset();
}

function showLibrary(lib) {
  if (!libMaps || lib === shownLib) return;
  syncShown();
  loadLibrary(lib);
}

const libraryMappings = {
  get() {
    syncShown();
    return JSON.parse(JSON.stringify(libMaps));
  },
  set(v) {
    libMaps = JSON.parse(JSON.stringify(v || {}));
    loadLibrary(editors.rekordbox_target ? editors.rekordbox_target.get() : "test");
  },
};

// Vocabulary and the target library's playlists for the mapping editor.
// `target`: the library to read the playlists from (the Target radios, before
// they're saved); none: the saved one.
let mappingLoads = 0;
async function loadMappingData(target) {
  if (!mapping) return;
  const load = ++mappingLoads; // a slower earlier load (quick radio switches) mustn't win
  mapping.loading();
  // New tags start with their own name in a custom mapping: not a change of the user's (for Save mapping's question).
  const vocabulary = (tags) => {
    const clean = savedMaps && savedMaps.isClean();
    mapping.setVocabulary(tags);
    if (clean) savedMaps.reset();
  };
  apiJson("/api/tags")
    .then(vocabulary)
    .catch(() => vocabulary([]));
  let playlists = null; // null: not available (older server, library unreadable)
  try {
    playlists = await apiJson(`/api/rekordbox/playlists${target ? `?target=${target}` : ""}`);
  } catch (e) {
    /* not available */
  }
  if (load === mappingLoads) mapping.setPlaylists(playlists);
}

function makeEditor(key, def, value) {
  switch (def.type) {
    case "target": return targetEditor();
    case "mapping": return mappingEditor();
    case "preset": return presetEditor();
    case "roots": return rootsEditor();
    case "roots-kind": return rootsEditor({ withKind: true });
    case "order": return orderEditor();
    case "ratio": return ratioEditor(key);
    case "int":
    case "number": return textEditor(key, def, true);
    case "select": return selectEditor(key, def);
    case "path":
    case "text": return textEditor(key, def, false);
    default: return genericEditor(key, value);
  }
}

// --- Page --------------------------------------------------------------------

function render(main, data) {
  const tabs = el("nav", { id: "tabs", role: "tablist" });
  TABS.forEach(([id, label]) => {
    const b = el("button", { type: "button", role: "tab", "data-tab": id, id: `tab_${id}` }, label);
    b.addEventListener("click", () => showTab(id));
    tabs.appendChild(b);
  });
  main.appendChild(tabs);

  const sections = {};
  SECTIONS.forEach(([id, tab, title, help]) => {
    const body = el("div", { class: "section-body" });
    sections[id] = body;
    main.appendChild(
      el("section", { id: `sec_${id}`, "data-tab": tab }, el("h2", {}, title), help ? el("p", { class: "help" }, help) : "", body)
    );
  });
  const keys = [...Object.keys(FIELDS).filter((k) => k in data), ...Object.keys(data).filter((k) => !(k in FIELDS))];
  keys.forEach((key) => {
    const def = FIELDS[key] || { section: "advanced", label: key };
    if (def.type === "part") return; // edited by a composite editor
    const ed = makeEditor(key, def, data[key]);
    const owned = ed.parts ? Object.keys(ed.parts).filter((k) => k in data) : [key];
    if (ed.parts) owned.forEach((k) => (editors[k] = ed.parts[k]));
    else editors[key] = ed;
    const label = el("label", { class: "field-label", for: `f_${key}` }, def.label || key);
    const field = el("div", { class: "field", "data-key": key, "data-keys": owned.join(" ") }, label, ed.node);
    if (def.help) field.appendChild(el("div", { class: "help" }, def.help));
    if (key === "rekordbox_db_path") field.appendChild(el("div", { class: "help", id: "dbStatus" }));
    sections[def.section].appendChild(field);
  });
  SECTIONS.forEach(([id]) => {
    if (!sections[id].children.length) document.getElementById(`sec_${id}`).remove();
  });
  if ("playlist_mappings" in data && mapping && editors.playlist_folder) {
    ["playlist_folder", "tag_playlist_mode", "tag_playlist_map"].forEach((k) => delete editors[k]);
    editors.playlist_mappings = libraryMappings;
    document.querySelectorAll("#sec_rb_playlists .field").forEach((f) => (f.dataset.keys = "playlist_mappings"));
  }

  // Plain mapping names resolve inside the target folder.
  const folderInput = document.getElementById("f_playlist_folder");
  if (mapping && folderInput) {
    mapping.setTargetFolder(folderInput.value);
    folderInput.addEventListener("input", () => mapping.setTargetFolder(folderInput.value));
    if (editors.playlist_mappings) {
      savedMaps = attachSavedMappings({
        input: folderInput,
        mapping,
        saved: () => (libMaps && libMaps[shownLib] && libMaps[shownLib].saved) || {},
        // Only the shown library's saved mappings (its folder, mode and map as stored): the page's other unsaved
        // settings stay unsaved.
        store: async (maps) => {
          const lib = shownLib;
          const body = { playlist_mappings: { [lib]: { ...loaded.playlist_mappings[lib], saved: maps } } };
          const s = await apiJson("/api/settings", { method: "PUT", body });
          loaded.playlist_mappings = { ...loaded.playlist_mappings, [lib]: s.playlist_mappings[lib] };
          libMaps[lib].saved = JSON.parse(JSON.stringify(s.playlist_mappings[lib].saved));
          changed();
          return s.playlist_mappings[lib].saved;
        },
        onLoaded: () => {
          mapping.setTargetFolder(folderInput.value);
          changed();
        },
      });
    }
  }
  const previewsBody = document.querySelector("#sec_previews .section-body");
  if (previewsBody) previewUsage = createPreviewUsage(previewsBody);
  importTab = createImportTab(main, { bridge });
  createTestTab(main);
  const start = fromHash();
  showTab(start ? start.tab : "general", start && start.arg);
}

function showTab(id, arg) {
  document.querySelectorAll("#tabs [data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === id);
    b.setAttribute("aria-selected", b.dataset.tab === id ? "true" : "false");
  });
  document.querySelectorAll("main section[data-tab]").forEach((sec) => (sec.hidden = sec.dataset.tab !== id));
  const hash = arg ? `#${id}/${encodeURIComponent(arg)}` : `#${id}`;
  if (location.hash !== hash) history.replaceState(null, "", `${location.search}${hash}`);
  // The Import and Test tabs aren't settings: no save bar there.
  const bar = document.getElementById("saveBar");
  if (bar) bar.hidden = id === "import" || id === "test";
  if (id === "import" && importTab) importTab.show(arg);
  if (id === "previews" && previewUsage) previewUsage.refresh();
  if (id === "rekordbox" && mapping && arg && arg.startsWith("tags=")) mapping.focusTags(arg.slice(5).split(",").filter(Boolean));
}

function fill(data) {
  Object.entries(editors).forEach(([k, ed]) => ed.set(data[k]));
  if (mapping && "playlist_folder" in data) mapping.setTargetFolder(document.getElementById("f_playlist_folder").value);
  if (savedMaps) savedMaps.reset();
  changed();
}

// Save settings keeps each changed library's mapping among its saved ones too (when it's custom, or its folder has
// one already), so a later pick of that folder brings back what was saved, not an older Save mapping.
function withSavedMaps(body) {
  if (!body.playlist_mappings) return body;
  const libs = JSON.parse(JSON.stringify(body.playlist_mappings));
  Object.entries(libs).forEach(([lib, e]) => {
    const was = (loaded.playlist_mappings || {})[lib] || {};
    const same = was.folder === e.folder && was.mode === e.mode && JSON.stringify(was.map) === JSON.stringify(e.map);
    if (same || !e.folder || (e.mode !== "custom" && !(e.folder in (e.saved || {})))) return;
    e.saved = { ...(e.saved || {}), [e.folder]: { mode: e.mode, map: e.map } };
  });
  return { ...body, playlist_mappings: libs };
}

async function save() {
  const dirty = changed();
  if (!dirty.length) return;
  const body = {};
  dirty.forEach((k) => (body[k] = values[k]));
  const state = document.getElementById("saveState");
  const btn = document.getElementById("saveBtn");
  btn.disabled = true;
  state.className = "";
  state.textContent = "Saving…";
  try {
    const saved = await apiJson("/api/settings", { method: "PUT", body: withSavedMaps(body) });
    delete saved.presets;
    delete saved.derived; // read-only, computed by the server
    loaded = saved;
    fill(saved);
    state.className = "ok";
    state.textContent = "Saved.";
    if (previewUsage) previewUsage.refresh(); // a lower cap has dropped some
    nav.setTarget(saved);
    refreshHealth();
    loadMappingData(); // the target library may have changed
  } catch (e) {
    btn.disabled = false;
    state.className = "err";
    state.textContent = `Not saved: ${e.message}`;
  }
}

async function refreshHealth() {
  try {
    const h = await apiJson("/api/health");
    nav.setHealth(h);
    const s = document.getElementById("dbStatus");
    if (s && h.db) {
      s.textContent = h.db.is_test
        ? "✓ This folder is the marked test library: exports may write to it."
        : "⚠ Not the marked test library: exports will refuse to write to it.";
      s.className = `help ${h.db.is_test ? "ok" : "err"}`;
    }
  } catch (e) {
    nav.setHealth(null, e);
  }
}

(async () => {
  document.body.appendChild(el("header", { id: "settingsHeader" }, nav.el));
  const main = el("main", { id: "settings" });
  document.body.appendChild(main);
  const footer = el(
    "footer",
    { id: "saveBar" },
    el("span", { id: "saveState" }),
    el("button", { type: "button", id: "revertBtn", class: "secondary", disabled: true, onclick: () => fill(loaded) }, "Revert"),
    el("button", { type: "button", id: "saveBtn", disabled: true, onclick: save }, "Save settings")
  );
  document.body.appendChild(footer);

  bridge.connect(1000).then(() => nav.setExtension(bridge.info));
  bridge.on("connect", (info) => nav.setExtension(info));

  try {
    const data = await apiJson("/api/settings");
    presets = data.presets || {};
    delete data.presets;
    delete data.derived; // read-only, computed by the server
    loaded = data;
    render(main, data);
    fill(data);
    nav.setTarget(data);
    loadMappingData();
  } catch (e) {
    main.appendChild(el("p", { class: "err" }, `Could not load settings: ${e.message}`));
  }
  refreshHealth();
  startDevReload();
  window.addEventListener("hashchange", () => {
    const h = fromHash();
    if (h) showTab(h.tab, h.arg);
  });

  window.addEventListener("beforeunload", (e) => {
    if (changed().length) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
})();

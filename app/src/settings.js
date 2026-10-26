// Settings page: edits the server's settings (GET/PUT /api/settings).
// Known keys get a dedicated editor; unknown keys still show up under
// "Advanced" so new server settings are editable without a UI change.

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { ExtensionBridge } from "../../shared/datasource/extensionBridge";
import { buildNav } from "./nav";
import { startDevReload } from "./devReload";
import { confirmDialog } from "./dialog";
import { createMappingEditor } from "./mappingEditor";

const TABS = [
  ["general", "General"],
  ["rekordbox", "Rekordbox"],
];

// [id, tab, title, help]
const SECTIONS = [
  ["folders", "general", "Music folders", "Where the indexer looks for your files. Files are referenced in place, never moved."],
  ["matching", "general", "Matching", "How tagged Bandcamp items are matched to local files."],
  ["bandcamp", "general", "Bandcamp", "Ownership normally comes from the extension's live session; these are the fallback."],
  ["server", "general", "Server", ""],
  ["advanced", "general", "Advanced", ""],
  ["rb_target", "rekordbox", "Target library", "Where exports write. Your main collection needs an explicit opt-in, and every export to it shows a dry run first."],
  ["rb_playlists", "rekordbox", "Playlists", "Which rekordbox playlists each tag goes to."],
  ["rb_files", "rekordbox", "Files", ""],
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
  candidate_threshold: {
    section: "matching",
    type: "ratio",
    label: "Offer candidates at or above",
    help: "Below auto-accept, matches are listed for you to confirm in the Located column.",
  },
  rekordbox_target: { section: "rb_target", type: "target", label: "Main collection" },
  allow_main_writes: { section: "rb_target", type: "part" }, // edited by the target editor
  rekordbox_db_path: {
    section: "rb_target",
    type: "path",
    label: "Test library database",
    help: "Used while the main collection isn't enabled. Writes need the test-library marker file in its folder.",
  },
  rekordbox_main_db_path: {
    section: "rb_target",
    type: "path",
    label: "Main library database",
    help: "Your real collection. Only written when enabled above; bc-tagger backs it up before every write.",
  },
  playlist_folder: {
    section: "rb_playlists",
    type: "text",
    label: "Target folder",
    help: "The rekordbox folder for bc-tagger's playlists: plain playlist names below (and every tag in Auto mode) go inside it.",
  },
  tag_playlist_mode: { section: "rb_playlists", type: "mapping", label: "Tags → playlists" },
  tag_playlist_map: { section: "rb_playlists", type: "part" }, // edited by the mapping editor
  xml_output_dir: {
    section: "rb_files",
    type: "path",
    label: "XML export folder",
    placeholder: "default: the server's data folder / exports",
  },
  bandcamp_username: { section: "bandcamp", type: "text", label: "Bandcamp username" },
  cookies_file: { section: "bandcamp", type: "path", label: "Cookies file", help: "Netscape cookies.txt." },
  server_port: {
    section: "server",
    type: "int",
    label: "Port",
    help: "Takes effect after the server restarts. Update the server URL in the extension popup to match.",
  },
  seed_export_json: { section: "advanced", type: "path", label: "Seed export JSON" },
  app_dist_dir: { section: "advanced", type: "path", label: "App build folder", placeholder: "default: bc-tagger/app/dist" },
  downloads_dir: { section: "advanced", type: "path", label: "Downloads folder" },
  downloader_dir: { section: "advanced", type: "path", label: "Downloader folder" },
  dev_extension_build_dir: { section: "advanced", type: "path", label: "Dev extension build folder" },
};

const nav = buildNav("settings");
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
  document.querySelectorAll(".field").forEach((f) => f.classList.toggle("dirty", dirty.some((k) => (f.dataset.keys || f.dataset.key).split(" ").includes(k))));
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
  return {
    node: input,
    get: () => (numeric ? Number(input.value) : input.value),
    set: (v) => (input.value = v == null ? "" : v),
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
function targetEditor() {
  const box = el("input", { type: "checkbox", id: "f_allow_main_writes" });
  const label = el("label", { class: "target-toggle", for: "f_allow_main_writes" }, box, " Allow bc-tagger to write to my main rekordbox collection");
  const banner = el("div", { class: "main-banner", hidden: true });
  const paint = () => {
    banner.hidden = !box.checked;
    const path = (editors.rekordbox_main_db_path && editors.rekordbox_main_db_path.get()) || "~/Library/Pioneer/rekordbox/master.db";
    banner.textContent = `MAIN LIBRARY: exports write to ${path}. Each export shows a dry run and asks before writing. rekordbox must be closed.`;
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
        confirmLabel: "Use my main collection",
      });
      box.checked = ok;
    }
    paint();
    changed();
  });
  // Checked only when both settings say so (the server needs both to write).
  let target = "test";
  let allow = false;
  const sync = () => {
    box.checked = target === "main" && allow;
    paint();
  };
  const node = el("div", { class: "target" }, label, banner);
  return {
    node,
    parts: {
      rekordbox_target: { get: () => (box.checked ? "main" : "test"), set: (v) => ((target = v), sync()) },
      allow_main_writes: { get: () => box.checked, set: (v) => ((allow = !!v), sync()) },
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
    el("p", { class: "muted" }, "Takes effect when you save settings. Untick the box to go back to the test library.")
  );
  return wrap;
}

let mapping = null;

function mappingEditor() {
  mapping = createMappingEditor({ onChange: changed });
  return {
    node: mapping.node,
    parts: {
      tag_playlist_mode: { get: mapping.getMode, set: mapping.setMode },
      tag_playlist_map: { get: mapping.getMap, set: mapping.setMap },
    },
  };
}

// Vocabulary and the target library's playlists for the mapping editor.
async function loadMappingData() {
  if (!mapping) return;
  apiJson("/api/tags").then(mapping.setVocabulary).catch(() => {});
  try {
    mapping.setPlaylists(await apiJson("/api/rekordbox/playlists"));
  } catch (e) {
    mapping.setPlaylists(null); // not available (older server, library unreadable)
  }
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
    case "int": return textEditor(key, def, true);
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

  // Plain mapping names resolve inside the target folder.
  const folderInput = document.getElementById("f_playlist_folder");
  if (mapping && folderInput) {
    mapping.setTargetFolder(folderInput.value);
    folderInput.addEventListener("input", () => mapping.setTargetFolder(folderInput.value));
  }
  showTab(location.hash === "#rekordbox" ? "rekordbox" : "general");
}

function showTab(id) {
  document.querySelectorAll("#tabs [data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === id);
    b.setAttribute("aria-selected", b.dataset.tab === id ? "true" : "false");
  });
  document.querySelectorAll("main section[data-tab]").forEach((sec) => (sec.hidden = sec.dataset.tab !== id));
  if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
}

function fill(data) {
  Object.entries(editors).forEach(([k, ed]) => ed.set(data[k]));
  if (mapping && "playlist_folder" in data) mapping.setTargetFolder(document.getElementById("f_playlist_folder").value);
  changed();
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
    const saved = await apiJson("/api/settings", { method: "PUT", body });
    delete saved.presets;
    loaded = saved;
    fill(saved);
    state.className = "ok";
    state.textContent = "Saved.";
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

  window.addEventListener("beforeunload", (e) => {
    if (changed().length) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
})();

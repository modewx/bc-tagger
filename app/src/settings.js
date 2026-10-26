// Settings page: edits the server's settings (GET/PUT /api/settings).
// Known keys get a dedicated editor; unknown keys still show up under
// "Advanced" so new server settings are editable without a UI change.

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { ExtensionBridge } from "../../shared/datasource/extensionBridge";
import { buildNav } from "./nav";
import { startDevReload } from "./devReload";

const SECTIONS = [
  ["folders", "Music folders", "Where the indexer looks for your files. Files are referenced in place, never moved."],
  ["matching", "Matching", "How tagged Bandcamp items are matched to local files."],
  ["rekordbox", "rekordbox", "Export target. Writes are refused unless the database folder is the marked test library."],
  ["bandcamp", "Bandcamp", "Ownership normally comes from the extension's live session; these are the fallback."],
  ["server", "Server", ""],
  ["advanced", "Advanced", ""],
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
  rekordbox_db_path: { section: "rekordbox", type: "path", label: "Database (master.db)" },
  playlist_folder: {
    section: "rekordbox",
    type: "text",
    label: "Playlist folder",
    help: "One playlist per tag is created inside this folder.",
  },
  xml_output_dir: {
    section: "rekordbox",
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
  document.querySelectorAll(".field").forEach((f) => f.classList.toggle("dirty", dirty.includes(f.dataset.key)));
  return dirty;
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

function rootsEditor() {
  const wrap = el("div", { class: "roots" });
  const rows = el("div", {});
  let roots = [];
  const add = el("button", { type: "button", class: "secondary" }, "Add folder");
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
        markCustomPreset();
        changed();
      });
      globs.addEventListener("input", () => {
        r.globs = globs.value.split(",").map((g) => g.trim()).filter(Boolean);
        changed();
      });
      del.addEventListener("click", () => {
        roots.splice(i, 1);
        render();
        markCustomPreset();
        changed();
      });
      rows.appendChild(el("div", { class: "root-row" }, path, globs, del));
    });
  };
  add.addEventListener("click", () => {
    roots.push({ path: "", globs: [] });
    render();
    changed();
  });
  wrap.append(rows, add);
  return {
    node: wrap,
    get: () => roots.map((r) => ({ path: r.path, globs: (r.globs || []).slice() })),
    set: (v) => {
      roots = (Array.isArray(v) ? v : []).map((r) => (typeof r === "string" ? { path: r, globs: [] } : { path: r.path || "", globs: (r.globs || []).slice() }));
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

function makeEditor(key, def, value) {
  switch (def.type) {
    case "preset": return presetEditor();
    case "roots": return rootsEditor();
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
  const sections = {};
  SECTIONS.forEach(([id, title, help]) => {
    const body = el("div", { class: "section-body" });
    sections[id] = body;
    main.appendChild(el("section", { id: `sec_${id}` }, el("h2", {}, title), help ? el("p", { class: "help" }, help) : "", body));
  });
  const keys = [...Object.keys(FIELDS).filter((k) => k in data), ...Object.keys(data).filter((k) => !(k in FIELDS))];
  keys.forEach((key) => {
    const def = FIELDS[key] || { section: "advanced", label: key };
    const ed = makeEditor(key, def, data[key]);
    editors[key] = ed;
    const label = el("label", { class: "field-label", for: `f_${key}` }, def.label || key);
    const field = el("div", { class: "field", "data-key": key }, label, ed.node);
    if (def.help) field.appendChild(el("div", { class: "help" }, def.help));
    if (key === "rekordbox_db_path") field.appendChild(el("div", { class: "help", id: "dbStatus" }));
    sections[def.section].appendChild(field);
  });
  SECTIONS.forEach(([id]) => {
    if (!sections[id].children.length) document.getElementById(`sec_${id}`).remove();
  });
}

function fill(data) {
  Object.entries(editors).forEach(([k, ed]) => ed.set(data[k]));
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
    refreshHealth();
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

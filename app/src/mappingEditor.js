// Tag → rekordbox playlists mapping (settings tag_playlist_mode + tag_playlist_map).
//
// "Auto" (default): every tag exports to a playlist named like the tag inside
// the target folder. Unticking it opens one row per tag with a list of
// playlist names (+ to add, × to remove). Name forms:
//   name        a playlist inside the target folder
//   a/b         a path inside the target folder
//   /a/b        a path from the library root
// Missing playlists/folders are created by the export; a folder or a smart
// playlist can't take songs. Tags with no names aren't exported.

const norm = (p) => String(p || "").replace(/^\/+|\/+$/g, "");

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function createMappingEditor({ onChange }) {
  let mode = "auto";
  let map = {};
  let vocab = [];
  let folder = "bc-tagger";
  let playlists = null; // [{path, name, kind, count}] or null when unavailable
  let filter = "";

  const root = el("div", "mapping");
  const autoLabel = el("label", "mapping-auto");
  const autoBox = document.createElement("input");
  autoBox.type = "checkbox";
  autoBox.id = "mappingAuto";
  autoLabel.append(autoBox, " Auto: one playlist per tag, named like the tag (inside the target folder)");

  const panel = el("div", "mapping-panel");
  const help = el("p", "help");
  help.innerHTML =
    "Add one or more playlists per tag. <code>Name</code> = a playlist in the target folder, " +
    "<code>Sub/Name</code> = inside a folder there, <code>/Folder/Name</code> = from the top of your library. " +
    "Missing playlists and folders are created. Tags left empty aren't exported.";
  const head = el("div", "mapping-head");
  const filterInput = document.createElement("input");
  filterInput.type = "search";
  filterInput.placeholder = "Filter tags…";
  filterInput.className = "mapping-filter";
  const summary = el("span", "mapping-summary");
  head.append(filterInput, summary);
  const warning = el("div", "mapping-warning", "No tag has a playlist yet: an export would add nothing to rekordbox.");
  const source = el("p", "help mapping-source");
  const datalist = document.createElement("datalist");
  datalist.id = "playlistOptions";
  const rows = el("div", "mapping-rows");
  panel.append(help, head, warning, source, datalist, rows);
  root.append(autoLabel, panel);

  // --- name resolution ----------------------------------------------------------

  function resolve(name) {
    const n = name.trim();
    if (!n) return null;
    if (/\/\//.test(n) || (n.length > 1 && n.endsWith("/"))) return { error: "empty folder name in the path" };
    const path = n.startsWith("/") ? norm(n) : norm(`${folder}/${n}`);
    if (!path) return { error: "no playlist name" };
    return { path };
  }

  function statusOf(name) {
    const r = resolve(name);
    if (!r) return null;
    if (r.error) return { cls: "bad", text: r.error };
    if (!playlists) return { cls: "", text: r.path };
    const hit = playlists.find((p) => norm(p.path) === r.path);
    if (!hit) {
      const parent = r.path.split("/").slice(0, -1).join("/");
      const parentKnown = !parent || playlists.some((p) => norm(p.path) === parent && p.kind === "folder");
      return { cls: "new", text: parentKnown ? "will be created" : "will be created (with its folders)", title: r.path };
    }
    if (hit.kind === "folder") return { cls: "bad", text: "is a folder", title: r.path };
    if (hit.kind === "smart") return { cls: "bad", text: "is a smart playlist", title: r.path };
    return { cls: "ok", text: `exists${hit.count != null ? ` · ${hit.count}` : ""}`, title: r.path };
  }

  // --- rendering ------------------------------------------------------------------

  function tagsToShow() {
    const extra = Object.keys(map).filter((t) => !vocab.includes(t));
    return [...vocab, ...extra];
  }

  function entryRow(tag, value) {
    const row = el("div", "map-entry");
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.placeholder = tag;
    input.setAttribute("list", "playlistOptions");
    input.spellcheck = false;
    const status = el("span", "map-status");
    const del = el("button", "icon", "×");
    del.type = "button";
    del.title = "Remove this playlist";
    const paint = () => {
      const st = statusOf(input.value);
      status.className = "map-status" + (st && st.cls ? " " + st.cls : "");
      status.textContent = st ? st.text : "";
      status.title = st && st.title ? st.title : "";
    };
    input.addEventListener("input", () => {
      paint();
      collect();
    });
    del.addEventListener("click", () => {
      const list = row.parentElement;
      row.remove();
      if (!list.querySelector(".map-entry")) list.prepend(entryRow(tag, "")); // keep one input per tag
      collect();
    });
    paint();
    row.append(input, status, del);
    return row;
  }

  function render() {
    rows.innerHTML = "";
    tagsToShow().forEach((tag) => {
      const row = el("div", "map-row");
      row.dataset.tag = tag;
      const name = el("div", "map-tag", tag);
      const list = el("div", "map-entries");
      const names = map[tag] && map[tag].length ? map[tag] : [""];
      names.forEach((n) => list.appendChild(entryRow(tag, n)));
      const add = el("button", "map-add", "+");
      add.type = "button";
      add.title = `Add another playlist for "${tag}"`;
      add.addEventListener("click", () => {
        const r = entryRow(tag, "");
        list.appendChild(r);
        r.querySelector("input").focus();
      });
      row.append(name, list, add);
      rows.appendChild(row);
    });
    applyFilter();
    refreshMeta();
  }

  function renderOptions() {
    datalist.innerHTML = "";
    (playlists || [])
      .filter((p) => p.kind === "playlist")
      .forEach((p) => {
        const path = norm(p.path);
        const inside = folder && path.startsWith(norm(folder) + "/");
        const o = document.createElement("option");
        o.value = inside ? path.slice(norm(folder).length + 1) : "/" + path;
        o.label = p.count != null ? `${p.count} tracks` : "";
        datalist.appendChild(o);
      });
    source.textContent = playlists
      ? `${playlists.filter((p) => p.kind === "playlist").length} playlists in the target library (suggested as you type).`
      : "Can't list the target library's playlists right now; names are still saved and created on export.";
  }

  function repaint() {
    rows.querySelectorAll(".map-entry").forEach((row) => {
      const input = row.querySelector("input");
      const status = row.querySelector(".map-status");
      const st = statusOf(input.value);
      status.className = "map-status" + (st && st.cls ? " " + st.cls : "");
      status.textContent = st ? st.text : "";
      status.title = st && st.title ? st.title : "";
    });
  }

  function applyFilter() {
    const f = filter.trim().toLowerCase();
    rows.querySelectorAll(".map-row").forEach((r) => (r.hidden = !!f && !r.dataset.tag.toLowerCase().includes(f)));
  }

  function refreshMeta() {
    const mapped = Object.keys(map).length;
    summary.textContent = `${mapped} of ${tagsToShow().length} tags mapped`;
    warning.hidden = mode !== "custom" || mapped > 0;
    panel.hidden = mode !== "custom";
    autoBox.checked = mode !== "custom";
  }

  // Read the inputs back into `map` (only tags with at least one name).
  function collect() {
    const next = {};
    rows.querySelectorAll(".map-row").forEach((r) => {
      const names = [...r.querySelectorAll(".map-entry input")].map((i) => i.value.trim()).filter(Boolean);
      if (names.length) next[r.dataset.tag] = [...new Set(names)];
    });
    map = next;
    refreshMeta();
    onChange();
  }

  autoBox.addEventListener("change", () => {
    mode = autoBox.checked ? "auto" : "custom";
    refreshMeta();
    onChange();
  });
  filterInput.addEventListener("input", () => {
    filter = filterInput.value;
    applyFilter();
  });

  render();
  renderOptions();

  return {
    node: root,
    getMode: () => mode,
    setMode(v) {
      mode = v === "custom" ? "custom" : "auto";
      refreshMeta();
    },
    getMap: () => JSON.parse(JSON.stringify(map)),
    setMap(v) {
      map = v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : {};
      render();
    },
    setVocabulary(tags) {
      vocab = Array.isArray(tags) ? tags : [];
      render();
    },
    setTargetFolder(name) {
      folder = name || "";
      renderOptions();
      repaint();
    },
    setPlaylists(list) {
      playlists = Array.isArray(list) ? list : null;
      renderOptions();
      repaint();
    },
    // Any entry that can't work (folder, smart playlist, bad path)?
    problems: () => [...rows.querySelectorAll(".map-status.bad")].length,
  };
}

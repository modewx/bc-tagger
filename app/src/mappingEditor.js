// Tag → rekordbox playlists mapping (settings tag_playlist_mode + tag_playlist_map).
//
// "Auto" (default): every tag exports to a playlist named like the tag inside
// the target folder. Unticking it opens one row per tag with a list of
// playlist names (+ to add, × to remove), each tag that has no saved mapping
// starting with its own name (tags added to the vocabulary later too). A tag
// whose names are all removed is kept as [] (not exported), so it isn't
// prefilled again. Name forms:
//   name        a playlist inside the target folder
//   a/b         a path inside the target folder
//   /a/b        a path from the library root
// Missing playlists/folders are created by the export (shown in yellow); a
// folder or a smart playlist can't take songs (red). Tags with no names
// aren't exported.

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
  let focus = []; // tags to point out (Settings → #rekordbox/tags=a,b, from an import)
  let scrolled = false;

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
  const focusNote = el("div", "mapping-focus-note");
  focusNote.hidden = true;
  root.append(autoLabel, focusNote, panel);

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
      const text = `does not exist: will be created on export${parentKnown ? "" : " (with its folders)"}`;
      return { cls: "new", text, title: `${r.path}\n${text}` };
    }
    if (hit.kind === "folder") return { cls: "bad", text: "is a folder", title: r.path };
    if (hit.kind === "smart") return { cls: "bad", text: "is a smart playlist", title: r.path };
    return { cls: "ok", text: `exists${hit.count != null ? ` · ${hit.count} track${hit.count === 1 ? "" : "s"}` : ""}`, title: r.path };
  }

  // --- rendering ------------------------------------------------------------------

  function tagsToShow() {
    const extra = [...Object.keys(map), ...focus].filter((t, i, all) => !vocab.includes(t) && all.indexOf(t) === i);
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
    const paint = () => paintEntry(row, input, status);
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

  // Once the tags are listed: to the first pointed-out one (or the note, in Auto mode).
  function scrollToFocus() {
    if (scrolled || !focus.length) return;
    const first = rows.querySelector(".map-row.map-focus");
    if (mode === "custom" && !first) return;
    (mode === "custom" ? first : focusNote).scrollIntoView({ block: "center" });
    scrolled = true;
  }

  function render() {
    rows.innerHTML = "";
    tagsToShow().forEach((tag) => {
      const row = el("div", "map-row" + (focus.includes(tag) ? " map-focus" : ""));
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

  // An entry's status next to it; a playlist that will be created gets a
  // light-yellow highlight, one that can't work stays red.
  function paintEntry(row, input, status) {
    const st = statusOf(input.value);
    status.className = "map-status" + (st && st.cls ? " " + st.cls : "");
    status.textContent = st ? st.text : "";
    status.title = st && st.title ? st.title : "";
    row.classList.toggle("missing", !!st && st.cls === "new");
    row.classList.toggle("invalid", !!st && st.cls === "bad");
  }

  function repaint() {
    rows.querySelectorAll(".map-entry").forEach((row) => paintEntry(row, row.querySelector("input"), row.querySelector(".map-status")));
  }

  // Tags with no saved mapping start with their own name (custom mode only).
  function prefill() {
    const missing = tagsToShow().filter((t) => !(t in map));
    missing.forEach((t) => (map[t] = [t]));
    return missing.length > 0;
  }

  function applyFilter() {
    const f = filter.trim().toLowerCase();
    rows.querySelectorAll(".map-row").forEach((r) => (r.hidden = !!f && !r.dataset.tag.toLowerCase().includes(f)));
  }

  function refreshMeta() {
    const mapped = Object.values(map).filter((names) => names.length).length;
    summary.textContent = `${mapped} of ${tagsToShow().length} tags mapped`;
    warning.hidden = mode !== "custom" || mapped > 0;
    panel.hidden = mode !== "custom";
    autoBox.checked = mode !== "custom";
    focusNote.hidden = !focus.length;
    focusNote.textContent = !focus.length
      ? ""
      : mode === "custom"
      ? `New tags: ${focus.join(", ")} (highlighted below). Give each the playlists it goes to; a tag left empty isn't exported.`
      : `New tags: ${focus.join(", ")}. In Auto mode each one gets its own playlist, named like the tag. Untick Auto to choose playlists.`;
  }

  // Read the inputs back into `map` (a tag with every name removed: [], not exported).
  function collect() {
    const next = {};
    rows.querySelectorAll(".map-row").forEach((r) => {
      const names = [...r.querySelectorAll(".map-entry input")].map((i) => i.value.trim()).filter(Boolean);
      next[r.dataset.tag] = [...new Set(names)];
    });
    map = next;
    refreshMeta();
    onChange();
  }

  autoBox.addEventListener("change", () => {
    mode = autoBox.checked ? "auto" : "custom";
    if (mode === "custom" && prefill()) render();
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
    // The tag list and the target library's playlists load after the page; data-vocab and
    // data-playlists on the editor say they're in (loading() clears them for a reload).
    loading() {
      delete root.dataset.vocab;
      delete root.dataset.playlists;
    },
    setVocabulary(tags) {
      vocab = Array.isArray(tags) ? tags : [];
      root.dataset.vocab = "1";
      const added = mode === "custom" && prefill(); // new tags start with their own name
      render();
      scrollToFocus();
      if (added) onChange();
    },
    setTargetFolder(name) {
      folder = name || "";
      renderOptions();
      repaint();
    },
    setPlaylists(list) {
      playlists = Array.isArray(list) ? list : null;
      root.dataset.playlists = "1";
      renderOptions();
      repaint();
    },
    // Point out these tags (e.g. an import's new ones): listed, highlighted, scrolled to.
    focusTags(tags) {
      focus = Array.isArray(tags) ? tags.filter(Boolean) : [];
      scrolled = false;
      if (mode === "custom") prefill();
      render();
      scrollToFocus();
    },
    // Any entry that can't work (folder, smart playlist, bad path)?
    problems: () => [...rows.querySelectorAll(".map-status.bad")].length,
  };
}

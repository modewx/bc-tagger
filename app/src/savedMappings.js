// Settings → Playlists: a tag → playlist mapping kept per Target folder, for each rekordbox library (settings
// `playlist_mappings[library].saved`: {folder: {mode, map}}), so changing the folder doesn't lose the mapping made for
// the one before.
//
// - "Save mapping" (next to Auto, while it's unticked) stores the mapping being edited under the Target folder
//   shown, at once. It saves nothing else: the page's other unsaved settings wait for Save settings.
// - The Target folder offers the saved folders: as you type (our own list, not the browser's), and from its ▾.
// - Picking or typing a saved folder loads its mapping into the editor (Save settings makes it the active one).
//   Changes not saved yet in the editor: asked first. A new name keeps the editor as it is.

import { confirmDialog } from "./dialog";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const nameOf = (v) => String(v || "").trim();

/**
 * @param {object} o
 * @param {HTMLInputElement} o.input  the Target folder input
 * @param {object} o.mapping          the mapping editor (createMappingEditor)
 * @param {function} o.saved          () → the stored {folder: {mode, map}} (of the library shown)
 * @param {function} o.store          (maps) → Promise of the stored maps, as the server saved them
 * @param {function} o.onLoaded       a saved mapping went into the editor (the page's unsaved changes follow)
 */
export function attachSavedMappings({ input, mapping, saved, store, onLoaded }) {
  let baseline = mapping.stateKey(); // the editor as last loaded or saved: anything else is unsaved

  // Our own suggestions instead of the browser's form history.
  input.setAttribute("autocomplete", "off");
  const list = document.createElement("datalist");
  list.id = "savedPlaylistFolders";
  input.setAttribute("list", list.id);
  const arrow = el("button", "secondary folder-arrow", "▼");
  arrow.type = "button";
  arrow.id = "playlistFolderMenuBtn";
  arrow.title = "Target folders with a saved mapping";
  const menu = el("div", "folder-menu");
  menu.id = "playlistFolderMenu";
  menu.hidden = true;
  const box = el("div", "folder-chooser");
  input.replaceWith(box);
  box.append(input, arrow, list, menu);

  const folders = () => Object.keys(saved() || {}).sort((a, b) => a.localeCompare(b));

  function refreshList() {
    list.innerHTML = "";
    folders().forEach((f) => {
      const o = document.createElement("option");
      o.value = f;
      list.appendChild(o);
    });
  }

  function openMenu() {
    menu.innerHTML = "";
    const names = folders();
    if (!names.length) menu.appendChild(el("div", "folder-menu-empty", "No saved mappings yet: untick Auto, map the tags, then Save mapping."));
    names.forEach((f) => {
      const b = el("button", "folder-option", f);
      b.type = "button";
      b.dataset.folder = f;
      b.addEventListener("click", () => {
        menu.hidden = true;
        input.value = f;
        input.dispatchEvent(new Event("input", { bubbles: true })); // the page's listeners, and use(f) below
      });
      menu.appendChild(b);
    });
    menu.hidden = false;
    const first = menu.querySelector("button");
    if (first) first.focus();
  }
  arrow.addEventListener("click", () => (menu.hidden ? openMenu() : (menu.hidden = true)));
  document.addEventListener("click", (e) => !box.contains(e.target) && (menu.hidden = true));
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      menu.hidden = true;
      input.focus();
    }
  });

  // A saved folder's mapping into the editor (asked first when the editor has changes not saved).
  let loadedFor = nameOf(input.value);
  let asking = false; // one question at a time
  async function use(name) {
    const entry = (saved() || {})[name];
    if (!entry || name === loadedFor || asking) return;
    if (mapping.stateKey() !== baseline) {
      asking = true;
      const ok = await confirmDialog({
        id: "replaceMappingConfirm",
        title: `Load the mapping saved for “${name}”?`,
        body: "The mapping being edited has changes that aren't saved. Loading replaces them (Cancel keeps them, for Save mapping under this folder name).",
        confirmLabel: "Load it",
      });
      asking = false;
      if (!ok) {
        loadedFor = name; // kept for this name: not asked again until another folder is picked
        return;
      }
    }
    mapping.load(entry);
    baseline = mapping.stateKey();
    loadedFor = name;
    mapping.setSaveNote(`Mapping saved for “${name}” loaded.`);
    onLoaded();
  }
  // Typed and left (or Enter), or picked from the suggestions.
  input.addEventListener("change", () => use(nameOf(input.value)));
  input.addEventListener("input", (e) => {
    if (!e.inputType || e.inputType === "insertReplacementText") use(nameOf(input.value));
  });

  mapping.saveButton.title = "Keep this mapping for the Target folder above (pick the folder again later to get it back)";
  // Save mapping: the editor's mapping under the folder shown.
  async function save() {
    const name = nameOf(input.value);
    if (!name) {
      mapping.setSaveNote("Give the Target folder a name first.");
      return;
    }
    mapping.saveButton.disabled = true;
    mapping.setSaveNote("Saving…");
    try {
      await store({ ...(saved() || {}), [name]: { mode: mapping.getMode(), map: mapping.getMap() } });
      baseline = mapping.stateKey();
      loadedFor = name;
      refreshList();
      mapping.setSaveNote(`Saved for “${name}”.`);
    } catch (e) {
      mapping.setSaveNote(`Not saved: ${e.message}`);
    } finally {
      mapping.saveButton.disabled = false;
    }
  }

  refreshList();
  return {
    save,
    // Nothing changed in the editor since it was loaded or saved.
    isClean: () => mapping.stateKey() === baseline,
    // The page filled the editor (loaded, reverted, saved): that's the editor's saved state now.
    reset() {
      baseline = mapping.stateKey();
      loadedFor = nameOf(input.value);
      refreshList();
    },
  };
}

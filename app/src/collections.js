// Collections (Phase 8): the server's collections, which one the collection page shows (All: every item, or one
// collection), and the bar to pick, create, rename and delete them. The choice is kept in this browser
// ("bc_app_collection"); ?collection=<id|all> sets it. A server without collections: no bar, the page as before.

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { confirmDialog } from "./dialog";

export const ALL = "all";
const KEY = "bc_app_collection";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const byPos = (a, b) => (a.pos ?? a.id) - (b.pos ?? b.id) || a.id - b.id;

/** The server's collections by `pos` ([{id, name, pos, count}]), or null without them (an older server). */
export async function listCollections() {
  try {
    const list = await apiJson("/api/collections");
    return Array.isArray(list) ? list.slice().sort(byPos) : null;
  } catch (e) {
    return null;
  }
}

const parse = (v) => (v == null || v === "" || v === ALL ? ALL : /^\d+$/.test(String(v)) ? Number(v) : ALL);

/** The collection to show: ?collection=, else the one kept in this browser, else All. */
export function chosenCollection() {
  const fromUrl = new URLSearchParams(location.search).get("collection");
  if (fromUrl != null) return parse(fromUrl);
  try {
    return parse(localStorage.getItem(KEY));
  } catch (e) {
    return ALL;
  }
}

/** Keep `v` as the one shown (and in the URL, if it names one: a reload shows the same). */
export function keepCollection(v) {
  try {
    localStorage.setItem(KEY, String(v));
  } catch (e) {
    /* not kept */
  }
  const url = new URL(location.href);
  if (url.searchParams.has("collection")) {
    url.searchParams.set("collection", String(v));
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }
}

// A track that Remove from collection or Delete collection leaves in no collection is deleted everywhere (the user,
// 2026-10-28), after a confirmation that names each one. The server says which first (dry_run). An older server
// doesn't know dry_run (it would act): it's asked only once the server has pending deletes.
let deletesKnown = null;
export function serverDeletes() {
  deletesKnown =
    deletesKnown ||
    apiJson("/api/tagger/pending-deletes").then(
      () => true,
      () => false
    );
  return deletesKnown;
}

/**
 * The confirmation when an action would delete tracks everywhere: each of them (title, artist; the list scrolls),
 * and what happens to the others. True for Delete.
 */
export function confirmDeletes({ id, title, wouldDelete, others }) {
  const n = wouldDelete.length;
  const body = el("div");
  body.append(
    el("p", null, `${plural(n, "track")} ${n === 1 ? "is" : "are"} in no other collection, so ${n === 1 ? "it's" : "they're"} deleted everywhere, with ${n === 1 ? "its" : "their"} tags (in the extension too):`)
  );
  const list = el("ul", "would-delete");
  wouldDelete.forEach((t) => list.append(el("li", null, [t.title || t.id, t.artist].filter(Boolean).join(" — "))));
  body.append(list);
  if (others) body.append(el("p", "muted", others));
  return confirmDialog({ id, danger: true, title, body, confirmLabel: "Delete" });
}

/** A name for a collection, asked in a dialog (empty or taken: can't confirm); null if cancelled. */
export async function askName({ id, title, value = "", confirmLabel, taken }) {
  const input = el("input", "collection-name");
  input.type = "text";
  input.id = `${id}Name`;
  input.value = value;
  input.maxLength = 80;
  input.setAttribute("aria-label", "Name");
  const note = el("p", "muted");
  const body = el("div");
  body.append(input, note);
  let okBtn = null;
  const check = () => {
    const name = input.value.trim();
    const clash = !!name && name !== value && taken(name);
    note.textContent = clash ? `There's already a collection called “${name}”.` : "";
    if (okBtn) okBtn.disabled = !name || clash || name === value;
  };
  input.addEventListener("input", check);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault(); // (else the Enter goes on to the button focused once the dialog closes)
    if (okBtn && !okBtn.disabled) okBtn.click();
  });
  const ok = await confirmDialog({
    id,
    title,
    body,
    confirmLabel,
    onOpen: ({ ok: b }) => {
      okBtn = b;
      check();
      input.focus();
      input.select();
    },
  });
  return ok ? input.value.trim() : null;
}

/**
 * The bar at the top of the collection page: the dropdown (All, then the collections, each with its count) and
 * Create Collection, Rename, Delete.
 * @param {object} o
 * @param {string|number} o.current   the one shown
 * @param {(v: string|number) => void} o.onPick   another one chosen (or made, or the shown one deleted)
 * @param {() => HTMLElement} o.statusEl
 */
export function createCollectionsBar({ current, onPick, statusEl, onDeleted = () => {} }) {
  let list = [];
  let allCount = null;
  const select = el("select", "collection-select");
  select.id = "collectionSelect";
  select.setAttribute("aria-label", "Collection");
  const label = el("label", "collections-label", "Collections ");
  label.appendChild(select);
  const button = (id, text, title) => {
    const b = el("button", "toolbar-btn", text);
    b.type = "button";
    b.id = id;
    b.title = title;
    return b;
  };
  const create = button("createCollection", "Create Collection", "A new, empty collection");
  const rename = button("renameCollection", "Rename", "Rename this collection");
  const del = button("deleteCollection", "Delete", "Delete this collection: its tracks stay in All and in your other collections");
  const bar = el("div", "collections-bar");
  bar.id = "collectionsBar";
  bar.append(label, create, rename, del);

  const byId = (id) => list.find((c) => c.id === id) || null;
  const nameOf = (v) => (v === ALL ? "All" : (byId(v) || {}).name || `#${v}`);
  const taken = (name) => list.some((c) => c.name.toLowerCase() === name.toLowerCase());
  const say = (text) => (statusEl().textContent = text);

  function paint() {
    select.innerHTML = "";
    select.appendChild(new Option(allCount != null ? `All (${allCount})` : "All", ALL));
    list.forEach((c) => select.appendChild(new Option(`${c.name} (${c.count ?? 0})`, String(c.id))));
    select.value = String(current);
    rename.disabled = current === ALL;
    del.disabled = current === ALL || current === 0;
    del.title = current === 0 ? "“Collection” can't be deleted" : current === ALL ? "Pick a collection to delete" : del.title;
  }

  select.addEventListener("change", () => onPick(parse(select.value)));

  create.addEventListener("click", async () => {
    const name = await askName({ id: "createCollectionDialog", title: "Create Collection", confirmLabel: "Create", taken });
    if (!name) return;
    try {
      const made = await apiJson("/api/collections", { method: "POST", body: { name } });
      await api.refresh();
      say(`Created “${made.name || name}”: empty. Import to Collection copies the selected tracks into it.`);
      onPick(made.id);
    } catch (e) {
      say(`Create Collection: ${e.message}`);
    }
  });

  rename.addEventListener("click", async () => {
    const c = byId(current);
    if (!c) return;
    const name = await askName({ id: "renameCollectionDialog", title: `Rename “${c.name}”`, value: c.name, confirmLabel: "Rename", taken });
    if (!name) return;
    try {
      await apiJson(`/api/collections/${c.id}`, { method: "PATCH", body: { name } });
      await api.refresh();
      say(`Renamed “${c.name}” to “${name}”.`);
    } catch (e) {
      say(`Rename: ${e.message}`);
    }
  });

  del.addEventListener("click", async () => {
    const c = byId(current);
    if (!c || c.id === 0) return;
    const url = `/api/collections/${c.id}`;
    // Tracks only in it are deleted with it: which, first.
    let doomed = [];
    try {
      if (await serverDeletes()) doomed = (await apiJson(`${url}?dry_run=true`, { method: "DELETE" })).would_delete || [];
    } catch (e) {
      say(`Delete: ${e.message}`);
      return;
    }
    const title = `Delete the collection “${c.name}”?`;
    const others = (c.count ?? 0) - doomed.length;
    const ok = doomed.length
      ? await confirmDeletes({
          id: "deleteCollectionDeletes",
          title,
          wouldDelete: doomed,
          others: others > 0 ? `The other ${plural(others, "track")} stay in your other collections, with their tags.` : "",
        })
      : await confirmDialog({
          id: "deleteCollectionConfirm",
          danger: true,
          title,
          body:
            `The ${plural(c.count ?? 0, "track")} in it stay in All and in your other collections, with their tags. Nothing ` +
            "else changes: no file, preview or rekordbox entry is touched.",
          confirmLabel: "Delete collection",
        });
    if (!ok) return;
    try {
      await apiJson(doomed.length ? `${url}?delete_orphans=true` : url, { method: "DELETE" });
      if (doomed.length) onDeleted(doomed);
      await api.refresh();
      say(`Deleted the collection “${c.name}”` + (doomed.length ? `, and ${plural(doomed.length, "track")} only in it.` : "."));
      onPick(ALL);
    } catch (e) {
      say(`Delete: ${e.message}`);
    }
  });

  const api = {
    el: bar,
    list: () => list,
    nameOf,
    byId,
    /** Read the collections again (counts, names), or take `fetched`; one shown that's gone: All. Null: this
     *  server has no collections. */
    async refresh(fetched) {
      const fresh = fetched !== undefined ? fetched : await listCollections();
      if (!fresh) return null; // no collections on this server
      list = fresh;
      if (current !== ALL && !byId(current)) {
        current = ALL;
        paint();
        onPick(ALL);
      } else paint();
      return list;
    },
    setCurrent(v) {
      current = v;
      paint();
    },
    setAllCount(n) {
      allCount = n;
      paint();
    },
  };
  paint();
  return api;
}

const LAST_IMPORT_KEY = "bc_import_collection";

/**
 * Where an import goes ("Import selected … into [Collection ▾]"): every collection, the last used (else
 * "Collection") first chosen. Hidden on a server without collections (value() null: the commit sends none).
 */
export function createImportCollectionPicker() {
  const select = el("select", "import-collection");
  select.id = "importCollection";
  const label = el("label", "import-collection-label", "into ");
  label.title = "The collection the imported tracks go into (an open import chooses now, at Import selected)";
  label.appendChild(select);
  label.hidden = true;
  let list = null;
  const remember = () => {
    try {
      localStorage.setItem(LAST_IMPORT_KEY, select.value);
    } catch (e) {
      /* not kept */
    }
  };
  select.addEventListener("change", remember);
  const ready = listCollections().then((l) => {
    list = l && l.length ? l : null;
    if (!list) return;
    list.forEach((c) => select.appendChild(new Option(c.name, String(c.id))));
    let last = null;
    try {
      last = localStorage.getItem(LAST_IMPORT_KEY);
    } catch (e) {
      /* none */
    }
    select.value = list.some((c) => String(c.id) === last) ? last : String(list.some((c) => c.id === 0) ? 0 : list[0].id);
    label.hidden = false;
  });
  return {
    el: label,
    ready,
    /** The chosen collection's id, or null (no collections on this server). */
    value: () => (list ? Number(select.value) : null),
    name: () => ((list || []).find((c) => String(c.id) === select.value) || {}).name || "",
    used: remember,
  };
}

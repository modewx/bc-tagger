// "Drop folders here (or click)": a box with a big "+" for folders dragged from Finder (the import preview's top
// bar, and Settings → Import from Files). The page gets their paths (`onFolders`).
//
// - A dropped folder's absolute path isn't given to the page: the server finds it (POST /api/fs/find-folder) by
//   its name and a sample of its audio files (path inside it and size; dropWalk.js). Several dropped folders are
//   looked for at once. Found once: used. In several places: a small chooser, in the server's order (the copies
//   with all the files first). Not found (or the search ran out of time): the folder picker. No audio files in
//   it: said, nothing looked for.
// - A drop that carries the paths as text (file:// URLs in text/uri-list, or an absolute path) uses them as they
//   are. Files instead of folders: "Drop a folder".
// - Click (or Enter): the folder picker, from the folder last browsed (settings' last_browse_dir).
// - While something is dragged over the window, the box lights up; a drop that misses it does nothing (the browser
//   would otherwise open the file and leave the page).

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { folderPicker } from "./folderPicker";
import { walkFolder, droppedPaths, isAudio, baseName } from "./dropWalk";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function lastBrowseDir() {
  const s = await apiJson("/api/settings").catch(() => ({}));
  return (s.settings || s).last_browse_dir || null;
}

/**
 * @param {object} o
 * @param {string} o.id
 * @param {(paths: string[]) => Promise<string|{text: string, err?: boolean}>} o.onFolders  the folders found or
 *        picked; resolves with a line for the box
 * @param {() => object} [o.findContext]  extra fields for find-folder (the import's batch_id)
 * @returns {{el: HTMLElement, say: (text: string, err?: boolean) => void, setHidden: (hidden: boolean) => void}}
 */
export function createFolderDrop({ id, onFolders, findContext = () => ({}) }) {
  const wrap = el("div", "folder-drop-wrap");
  const box = el("div", "folder-drop");
  box.id = id;
  box.tabIndex = 0;
  box.setAttribute("role", "button");
  box.title = "Drop folders from Finder here, or click to pick one";
  box.append(el("span", "fd-plus", "+"), el("span", "fd-text", "Drop folders here (or click)"));
  const status = el("div", "fd-status");
  status.id = `${id}Status`;
  const panel = el("div", "folder-drop-panel");
  panel.id = `${id}Panel`;
  panel.hidden = true;
  wrap.append(box, status, panel);

  function say(text, err = false) {
    status.textContent = text || "";
    status.title = text || "";
    status.classList.toggle("err", !!err);
  }

  // --- the panel under the box: the chooser, or the folder picker ---------------------------------------------------
  // One question at a time: each waits for the one before.
  let asking = Promise.resolve();
  let closePanel = null;
  function ask(build) {
    const turn = asking.then(
      () =>
        new Promise((resolve) => {
          panel.innerHTML = "";
          panel.hidden = false;
          const done = (v) => {
            if (closePanel !== close) return;
            closePanel = null;
            panel.hidden = true;
            panel.innerHTML = "";
            document.removeEventListener("mousedown", outside, true);
            document.removeEventListener("keydown", onKey, true);
            resolve(v);
          };
          const close = () => done(null);
          const outside = (e) => !wrap.contains(e.target) && close();
          const onKey = (e) => e.key === "Escape" && close();
          closePanel = close;
          document.addEventListener("mousedown", outside, true);
          document.addEventListener("keydown", onKey, true);
          build(panel, done);
        })
    );
    asking = turn;
    return turn;
  }

  // The folder picker (from the folder last browsed); resolves with the path, or null.
  const pick = (note) =>
    ask(async (p, done) => {
      if (note) p.appendChild(el("div", "fd-note", note));
      const holder = el("div");
      p.appendChild(holder);
      const start = await lastBrowseDir();
      if (closePanel) holder.appendChild(folderPicker({ start, onPick: (path) => done(path), onClose: () => done(null) }));
    });

  // A folder found in several places: which one.
  const choose = (name, matches) =>
    ask((p, done) => {
      p.appendChild(el("div", "fd-note", `“${name}” is in ${matches.length} places: which one?`));
      const list = el("div", "fd-choices");
      matches.forEach((m) => {
        const b = el("button", "fd-choice");
        b.type = "button";
        b.dataset.path = m.path;
        b.append(el("span", "fd-path", m.path));
        if (m.audio_files != null) b.append(el("span", "fd-count", plural(m.audio_files, "audio file")));
        b.addEventListener("click", () => done(m.path));
        list.appendChild(b);
      });
      const other = el("button", "secondary fd-browse", "Another folder…");
      other.type = "button";
      const skip = el("button", "secondary fd-skip", "Skip it");
      skip.type = "button";
      other.addEventListener("click", () => {
        done(undefined); // this question ends; the picker comes next
      });
      skip.addEventListener("click", () => done(null));
      const actions = el("div", "fd-actions");
      actions.append(other, skip);
      p.append(list, actions);
      const first = list.querySelector("button");
      if (first) first.focus();
    }).then((v) => (v === undefined ? pick(`Pick “${name}”:`) : v));

  // --- finding what was dropped ------------------------------------------------------------------------------------
  let lines = [];
  const show = () => {
    const errs = lines.filter((l) => l.err).length;
    say(lines.map((l) => l.text).join(" · "), errs > 0 && errs === lines.length);
  };

  async function resolveOne(f, i) {
    const set = (text, err = false) => {
      lines[i] = { text, err };
      show();
    };
    if (f.path) return f.path;
    let matches;
    let stopped = false;
    try {
      const w = await walkFolder(f.entry);
      if (!w.files.length && !w.capped) {
        set(`No audio files in “${f.name}”`, true);
        return null;
      }
      if (!w.files.length) {
        set(`Couldn't read “${f.name}” in time`, true);
        const p = await pick(`Couldn't read “${f.name}” in time: pick it, or Cancel.`);
        if (p) set(`Picked “${f.name}”`);
        return p;
      }
      const r = await apiJson("/api/fs/find-folder", { method: "POST", body: { name: f.name, files: w.files, count: w.count, ...findContext() } });
      matches = (r && r.matches) || [];
      stopped = !!(r && r.timed_out);
    } catch (e) {
      set(e.status === 404 || e.status === 405 ? `This server can't find dropped folders yet: pick “${f.name}”` : `Couldn't look for “${f.name}”: ${e.message}`, true);
      const p = await pick(`Pick “${f.name}”:`);
      if (!p) set(`“${f.name}” skipped`);
      return p;
    }
    if (matches.length === 1) {
      set(`Found “${f.name}”`);
      return matches[0].path;
    }
    if (!matches.length) {
      const why = stopped ? `Stopped searching for “${f.name}” before finding it` : `Couldn't find “${f.name}” on this Mac`;
      set(why, true);
      const p = await pick(`${why}: pick it, or Cancel.`);
      if (p) set(`Picked “${f.name}”`);
      return p;
    }
    set(`“${f.name}” is in ${matches.length} places`);
    const p = await choose(f.name, matches);
    set(p ? `Picked “${f.name}”` : `“${f.name}” skipped`);
    return p;
  }

  async function add(paths) {
    const unique = [...new Set(paths.filter(Boolean))];
    if (!unique.length) return;
    say(`Adding ${unique.length === 1 ? `“${baseName(unique[0])}”` : plural(unique.length, "folder")}…`);
    let res;
    try {
      res = await onFolders(unique);
    } catch (e) {
      res = { text: `Not added: ${e.message}`, err: true };
    }
    if (res && typeof res === "object") say(res.text, res.err);
    else say(res || "");
  }

  async function dropped({ entries, paths, fileNames }) {
    const folders = [];
    const loose = [];
    const byName = new Map(entries.map((en) => [en.name, en]));
    paths.forEach((p) => {
      const en = byName.get(baseName(p));
      byName.delete(baseName(p));
      if (en ? en.isFile : isAudio(p)) loose.push(baseName(p));
      else folders.push({ name: baseName(p), path: p });
    });
    byName.forEach((en) => (en.isDirectory ? folders.push({ name: en.name, entry: en }) : loose.push(en.name)));
    if (!entries.length && !paths.length) loose.push(...fileNames);
    if (!folders.length) return say(loose.length ? "Drop a folder (not files)" : "Nothing to add: drop a folder", true);
    lines = folders.map((f) => ({ text: f.path ? `“${f.name}”` : `Finding “${f.name}”…` }));
    if (loose.length) lines.push({ text: `${plural(loose.length, "file")} skipped: drop folders` });
    show();
    const found = await Promise.all(folders.map(resolveOne));
    if (!found.some(Boolean)) return;
    await add(found);
  }

  // Click / Enter: pick one.
  const browse = async () => {
    if (closePanel) return closePanel();
    const p = await pick();
    if (p) await add([p]);
  };
  box.addEventListener("click", browse);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      browse();
    }
  });

  // --- dragging over the window ------------------------------------------------------------------------------------
  // The page's own drags (a link, a row) aren't for the box.
  let internal = false;
  document.addEventListener("dragstart", () => (internal = true));
  document.addEventListener("dragend", () => (internal = false));
  const external = (e) => !internal && !!e.dataTransfer && [...e.dataTransfer.types].some((t) => t === "Files" || t === "text/uri-list");
  const usable = () => wrap.getClientRects().length > 0; // shown (not hidden, nor in a tab not shown)
  let depth = 0;
  const lit = (on) => {
    wrap.classList.toggle("dragging", on);
    if (!on) box.classList.remove("over");
  };
  window.addEventListener("dragenter", (e) => {
    if (!external(e)) return;
    depth++;
    if (usable()) lit(true);
  });
  window.addEventListener("dragleave", (e) => {
    if (!external(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) lit(false);
  });
  window.addEventListener("dragover", (e) => {
    if (!external(e)) return;
    e.preventDefault(); // else a drop opens the file in the tab
    const on = usable() && box.contains(e.target);
    e.dataTransfer.dropEffect = on ? "copy" : "none";
    box.classList.toggle("over", on);
  });
  window.addEventListener("drop", (e) => {
    if (!external(e)) return;
    e.preventDefault();
    depth = 0;
    lit(false);
    if (!usable()) return;
    if (!box.contains(e.target)) return say("Drop folders on the + box");
    // What the drop holds is only readable now, during the event.
    const dt = e.dataTransfer;
    const entries = [...(dt.items || [])]
      .filter((it) => it.kind === "file")
      .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
      .filter(Boolean);
    const paths = droppedPaths(dt.getData("text/uri-list"), dt.getData("text/plain"));
    const fileNames = [...(dt.files || [])].map((f) => f.name);
    dropped({ entries, paths, fileNames });
  });

  return {
    el: wrap,
    say,
    setHidden(hidden) {
      wrap.hidden = hidden;
      if (hidden && closePanel) closePanel();
    },
  };
}

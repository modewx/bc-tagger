// Setting a file by hand: "Set file…" in the Located popovers of the collection and the import preview. A search of
// the music folders' file index, or Browse… through the folders; the page's `use(path)` sets the file picked.

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { searchFiles, listFolder } from "./importApi";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const fmtSize = (f) => [String(f.format || "").toUpperCase(), f.root_kind === "owned" ? "owned folder" : null].filter(Boolean).join(" · ");
const fileLine = (f) => [f.title, f.artist, f.album].filter(Boolean).join(" — ") || (f.path || "").split("/").pop();

export function fileRow(f, actions) {
  const r = el("div", "pop-file");
  r.append(el("div", "pop-file-name", fileLine(f)), el("div", "pop-file-meta", [fmtSize(f), f.path].filter(Boolean).join(" · ")));
  if (actions.length) {
    const btns = el("div", "pop-actions");
    actions.forEach(([label, cls, run]) => {
      const b = el("button", cls, label);
      b.addEventListener("click", run);
      btns.appendChild(b);
    });
    r.appendChild(btns);
  }
  return r;
}

/**
 * "Set file…": a search of the music folders' files (starting with `query`, e.g. artist and title), and Browse….
 * `use(path)` sets the file picked; `local` (the row's or item's located state) is where Browse… may open.
 */
export function setFileForm(pop, { query, local, use }) {
  const box = el("div", "pop-url set-file");
  box.appendChild(el("div", "pop-label", "Set file: search your music folders"));
  const q = document.createElement("input");
  q.className = "pop-input set-file-q";
  q.value = query || "";
  const results = el("div", "set-file-results");
  const search = async () => {
    results.textContent = "Searching…";
    let found = [];
    try {
      found = await searchFiles(q.value.trim());
    } catch (e) {
      results.textContent = e.status === 404 ? "This server can't search the files yet." : `Search failed: ${e.message}`;
      return;
    }
    results.innerHTML = "";
    if (!found.length) results.appendChild(el("div", "pop-meta", "No files match."));
    found.forEach((f) => results.appendChild(fileRow(f, [["Use this", "primary", () => use(f.path)]])));
  };
  q.addEventListener("keydown", (e) => e.key === "Enter" && search());
  const go = el("button", "", "Search");
  go.addEventListener("click", search);
  const browse = el("button", "", "Browse…");
  browse.id = "browseFiles";
  browse.title = "Pick the file in your music folders";
  browse.addEventListener("click", () => {
    box.remove();
    folderBrowser(pop, { local, use });
  });
  const a1 = el("div", "pop-actions");
  a1.append(go, browse);
  box.append(q, a1, results);
  pop.appendChild(box);
  q.focus();
  search();
}

const dirOf = (p) => (p ? String(p).replace(/\/[^/]*$/, "") : null);

// Pick the file in the music folders. Opens in the last folder a file was
// picked from (the server's last_browse_dir), else the folder of the best
// guess (`local`), else the list of music folders.
export async function folderBrowser(pop, { local, use }) {
  const box = el("div", "pop-url folder-browser");
  box.id = "folderBrowser";
  const crumbs = el("div", "fb-crumbs");
  const list = el("div", "fb-list");
  const msg = el("div", "pop-meta fb-msg");
  box.append(el("div", "pop-label", "Pick the file"), crumbs, msg, list);
  pop.appendChild(box);

  // The music folders, so the breadcrumb starts at the one we're in.
  let roots = [];
  const rootOf = (p) => roots.filter((r) => p === r || p.startsWith(r + "/")).sort((a, b) => b.length - a.length)[0];

  // A folder outside the music folders (or gone) is refused: say so, show the list of folders.
  async function open(path, note = "") {
    msg.textContent = note;
    let d;
    try {
      d = await listFolder(path);
    } catch (e) {
      if (e.status === 404 && e.message === "Not Found") msg.textContent = "This server can't browse folders yet."; // no such route
      else if (path) return open(null, `Can't open ${path}: ${e.message}`);
      else msg.textContent = `Can't list your music folders: ${e.message}`;
      return;
    }
    if (!d.path) roots = d.dirs.map((f) => f.path);
    crumbs.innerHTML = "";
    const top = el("button", "fb-crumb", "Music folders");
    top.addEventListener("click", () => open(null));
    crumbs.appendChild(top);
    if (d.path) {
      const root = rootOf(d.path) || d.path;
      const crumb = (label, at) => {
        crumbs.append(" / ");
        const b = el("button", "fb-crumb", label);
        b.dataset.path = at;
        b.title = at;
        b.addEventListener("click", () => open(at));
        crumbs.appendChild(b);
      };
      crumb(root, root);
      let acc = root;
      d.path
        .slice(root.length)
        .split("/")
        .filter(Boolean)
        .forEach((part) => {
          acc += "/" + part;
          crumb(part, acc);
        });
    }
    list.innerHTML = "";
    if (d.path) {
      const up = el("button", "fb-entry fb-up", "↑ Up");
      up.addEventListener("click", () => open(d.parent || null));
      list.appendChild(up);
    }
    d.dirs.forEach((f) => {
      const b = el("button", "fb-entry fb-dir", `📁 ${f.name}`);
      b.dataset.path = f.path;
      b.addEventListener("click", () => open(f.path));
      list.appendChild(b);
    });
    d.files.forEach((f) => {
      const b = el("button", "fb-entry fb-file", `♪ ${f.name}`);
      b.dataset.path = f.path;
      const tagged = [f.title, f.artist].filter(Boolean).join(" — ");
      if (tagged) b.appendChild(el("span", "muted", ` ${tagged}`));
      b.addEventListener("click", () => use(f.path));
      list.appendChild(b);
    });
    if (!d.dirs.length && !d.files.length) list.appendChild(el("div", "pop-meta", "No folders or audio files here."));
    const first = list.querySelector(".fb-dir, .fb-file");
    if (first) first.focus();
  }

  // Arrow keys move between entries; Enter opens / picks (they're buttons).
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...list.querySelectorAll(".fb-entry")];
    const i = items.indexOf(document.activeElement);
    const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) next.focus();
    e.preventDefault();
  });

  const settings = await apiJson("/api/settings").catch(() => ({}));
  const last = (settings.settings || settings).last_browse_dir;
  const guess = dirOf((local && local.best && local.best.path) || (((local && local.candidates) || [])[0] || {}).path);
  roots = (await listFolder(null).catch(() => ({ dirs: [] }))).dirs.map((f) => f.path);
  open(last || guess || null);
}

// Picking a folder of the music folders (the server's /api/fs/list, which only
// lists what's under them): breadcrumbs, Up, the subfolders, and "Use this folder".

import { listFolder } from "./importApi";

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * @param {object} o
 * @param {string} [o.start]   the folder to open first (else the list of music folders)
 * @param {(path: string) => void} o.onPick
 * @param {() => void} [o.onClose]
 * @returns {HTMLElement}
 */
export function folderPicker({ start, onPick, onClose }) {
  const box = node("div", "folder-picker");
  const crumbs = node("div", "fp-crumbs");
  const msg = node("div", "help fp-msg");
  const list = node("div", "fp-list");
  const use = node("button", "fp-use", "Use this folder");
  use.type = "button";
  use.disabled = true;
  const cancel = node("button", "secondary fp-cancel", "Cancel");
  cancel.type = "button";
  const actions = node("div", "fp-actions");
  actions.append(use, cancel);
  box.append(crumbs, msg, list, actions);

  let here = null;
  let roots = [];
  const rootOf = (p) => roots.filter((r) => p === r || p.startsWith(r + "/")).sort((a, b) => b.length - a.length)[0];

  async function open(path, note = "") {
    msg.textContent = note;
    let d;
    try {
      d = await listFolder(path);
    } catch (e) {
      if (path) return open(null, `Can't open ${path}: ${e.message}`);
      msg.textContent = `Can't list your music folders: ${e.message}`;
      return;
    }
    if (!d.path) roots = d.dirs.map((f) => f.path);
    here = d.path;
    use.disabled = !here;
    use.title = here || "Open a folder first";
    crumbs.innerHTML = "";
    const top = node("button", "fp-crumb", "Music folders");
    top.type = "button";
    top.addEventListener("click", () => open(null));
    crumbs.appendChild(top);
    if (here) {
      const root = rootOf(here) || here;
      let acc = "";
      [root, ...here.slice(root.length).split("/").filter(Boolean)].forEach((part, i) => {
        acc = i ? `${acc}/${part}` : root;
        const at = acc;
        crumbs.append(" / ");
        const b = node("button", "fp-crumb", part);
        b.type = "button";
        b.title = at;
        b.addEventListener("click", () => open(at));
        crumbs.appendChild(b);
      });
    }
    list.innerHTML = "";
    if (here) {
      const up = node("button", "fp-entry fp-up", "↑ Up");
      up.type = "button";
      up.addEventListener("click", () => open(d.parent || null));
      list.appendChild(up);
    }
    d.dirs.forEach((f) => {
      const b = node("button", "fp-entry fp-dir", `📁 ${f.name}`);
      b.type = "button";
      b.dataset.path = f.path;
      b.addEventListener("click", () => open(f.path));
      list.appendChild(b);
    });
    if (!d.dirs.length) list.appendChild(node("div", "help", "No folders here."));
  }

  use.addEventListener("click", () => here && onPick(here));
  cancel.addEventListener("click", () => onClose && onClose());
  open(start || null);
  return box;
}

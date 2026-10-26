// Import logs: after each Import selected the server saves a JSON log and a
// Markdown summary, named by date and time, in the import log folder (Settings
// → General → Import). Here: the "Import log saved" note, the log viewer, Show
// in Finder, and the Past imports list on the Import tab.

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { confirmDialog } from "./dialog";

const enc = encodeURIComponent;

export const listLogs = () => apiJson("/api/import/logs");
export const revealLog = (name) => apiJson("/api/import/logs/reveal", { method: "POST", body: name ? { name } : {} });

async function logText(name) {
  const r = await fetch(`/api/import/logs/${enc(name)}`);
  if (!r.ok) throw new Error(r.status === 404 ? "the log file isn't there any more" : `HTTP ${r.status}`);
  return r.text();
}

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

// **bold** and `code` inside a line, as DOM (no HTML from the file).
function inline(text) {
  const frag = document.createDocumentFragment();
  text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).forEach((part) => {
    if (!part) return;
    if (/^\*\*.+\*\*$/.test(part)) frag.appendChild(node("strong", "", part.slice(2, -2)));
    else if (/^`.+`$/.test(part)) frag.appendChild(node("code", "", part.slice(1, -1)));
    else frag.appendChild(document.createTextNode(part));
  });
  return frag;
}

const tableCells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

// Just what the server's logs use: # headings, lines, | tables |, **bold**, `code`.
export function renderMarkdown(md) {
  const root = node("div", "md-log");
  const lines = String(md || "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const heading = /^(#{1,6}) (.*)$/.exec(line);
    if (heading) {
      root.appendChild(node(heading[1].length === 1 ? "h4" : "h5", "", heading[2]));
      i++;
    } else if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const table = node("table", "md-table");
      const body = rows.filter((r, n) => !(n === 1 && /^\s*\|[\s|:-]+\|?\s*$/.test(r)));
      body.forEach((r, n) => {
        const tr = document.createElement("tr");
        tableCells(r).forEach((c) => {
          const cell = document.createElement(n === 0 ? "th" : "td");
          cell.appendChild(inline(c));
          tr.appendChild(cell);
        });
        (n === 0 ? table.createTHead() : table.tBodies[0] || table.createTBody()).appendChild(tr);
      });
      root.appendChild(node("div", "md-table-wrap")).appendChild(table);
    } else if (line.trim()) {
      const p = node("p");
      p.appendChild(inline(line));
      root.appendChild(p);
      i++;
    } else {
      i++;
    }
  }
  return root;
}

const revealError = (e) => (e.status === 403 ? "Show in Finder only works on this Mac" : `Couldn't show it: ${e.message}`);

// The log, rendered, with Show in Finder.
export async function viewLog(log) {
  let body;
  try {
    const text = await logText(log.md || log.name);
    body = log.md ? renderMarkdown(text) : node("pre", "md-log", text);
  } catch (e) {
    body = `Can't read ${log.md || log.name}: ${e.message}`;
  }
  const reveal = await confirmDialog({
    id: "importLogDialog",
    title: `Import log · ${log.name}`,
    body,
    confirmLabel: "Show in Finder",
    cancelLabel: "Close",
    wide: true,
  });
  if (reveal) await revealLog(log.name).catch((e) => alert(revealError(e)));
}

// "View" and "Show in Finder" for one log; `note` reports Finder problems.
function logButtons(log, note) {
  const view = node("button", "mini-btn log-view", "View");
  view.type = "button";
  view.addEventListener("click", () => viewLog(log));
  const finder = node("button", "mini-btn log-reveal", "Show in Finder");
  finder.type = "button";
  finder.addEventListener("click", async () => {
    note.textContent = "";
    try {
      await revealLog(log.name);
    } catch (e) {
      note.textContent = revealError(e);
    }
  });
  return [view, finder];
}

// After Import selected: "Import log saved: <name>  View  Show in Finder" from
// the commit result ({log, log_md, log_dir, log_warning, log_error}), or null.
export function logNote(r) {
  if (!r || !(r.log || r.log_error)) return null;
  const box = node("div", "import-log-note");
  box.id = "importLogNote";
  const err = node("span", "log-err");
  if (r.log) {
    box.append("Import log saved: ", node("code", "", r.log), " ", ...logButtons({ name: r.log, md: r.log_md }, err), err);
    if (r.log_dir) box.title = r.log_dir;
    if (r.log_warning) box.appendChild(node("div", "log-err", r.log_warning));
  } else {
    box.appendChild(node("span", "log-err", `The import worked, but its log couldn't be written: ${r.log_error}`));
  }
  return box;
}

// "12 added · 6 merged · 4 to Other · 9 located"
export function countsText(c) {
  if (!c) return "";
  const n = (k) => c[k] || 0;
  return [
    `${n("added_to_tagger")} added`,
    n("merged") ? `${n("merged")} merged` : "",
    n("added_to_other") + n("merged_into_other") ? `${n("added_to_other") + n("merged_into_other")} to Other` : "",
    n("not_imported") ? `${n("not_imported")} not imported` : "",
    n("unchecked") ? `${n("unchecked")} unticked` : "",
    n("imported_earlier") ? `${n("imported_earlier")} by an earlier attempt` : "",
    `${n("located")} located`,
    n("downloaded") ? `${n("downloaded")} downloaded` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// The Import tab's Past imports: newest first, with the folder they're in.
export async function renderPastImports(container) {
  container.innerHTML = "";
  let data;
  try {
    data = await listLogs();
  } catch (e) {
    container.appendChild(node("p", "help", e.status === 404 ? "This server doesn't keep import logs yet." : `Can't list the import logs: ${e.message}`));
    return;
  }
  const folderNote = node("span", "log-err");
  const open = node("button", "mini-btn", "Open folder");
  open.type = "button";
  open.id = "importLogsFolder";
  open.addEventListener("click", async () => {
    folderNote.textContent = "";
    try {
      await revealLog(null);
    } catch (e) {
      folderNote.textContent = revealError(e);
    }
  });
  const folder = node("p", "help import-logs-dir");
  folder.append("Saved in ", node("code", "", data.dir || "?"), " ", open, " ", folderNote);
  container.appendChild(folder);
  if (data.warning) container.appendChild(node("p", "help err", data.warning));
  const logs = data.logs || [];
  if (!logs.length) {
    container.appendChild(node("p", "help", "No import logs yet: Import selected saves one."));
    return;
  }
  logs.forEach((log) => {
    const row = node("div", "batch-row log-row");
    row.dataset.log = log.name;
    const when = log.logged_at ? new Date(log.logged_at).toLocaleString() : "";
    const err = node("span", "log-err");
    row.append(
      node("span", "log-when", when),
      node("strong", "log-name", log.batch_name || log.batch_id || log.name),
      log.status === "partial" ? node("span", "chip log-partial", "partial") : "",
      node("span", "muted log-counts", countsText(log.counts)),
      ...logButtons(log, err),
      err
    );
    container.appendChild(row);
  });
}

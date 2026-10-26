// The import the user is working on: the newest batch that isn't imported yet.
// The server keeps a batch until it's imported or discarded, and leaving a
// page never cancels anything, so every page can show the open import and
// link back to its step. Its id is also kept in localStorage.

import { listBatches } from "./importApi";

const KEY = "bc_open_import";

export function rememberImport(id) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch (e) {
    /* ignore */
  }
}

export function rememberedImport() {
  try {
    return localStorage.getItem(KEY);
  } catch (e) {
    return null;
  }
}

// Batches not imported yet, newest first.
export async function openImports() {
  return (await listBatches()).filter((b) => !b.committed);
}

// "progress" (looking up / locating), "mapping" (unknown tags to map),
// "review" (the preview) or "error".
export function stepOf(batch) {
  if (batch.status === "resolving") return "progress";
  if (batch.status === "error") return "error";
  if (batch.stats && batch.stats.unknown_tags > 0) return "mapping";
  return "review";
}

export function stepUrl(batch) {
  const id = encodeURIComponent(batch.id);
  return stepOf(batch) === "review" ? `/import/?batch=${id}` : `/settings/#import/${id}`;
}

// One line for the open import, e.g. "Import: looking up 48/150" or
// "Import ready to review". `live` is the latest progress {current, total, message}.
export function stepLabel(batch, live) {
  const total = (batch.stats && batch.stats.total) || "";
  switch (stepOf(batch)) {
    case "progress": {
      const p = live || {};
      const count = p.total ? ` ${p.current || 0}/${p.total}` : total ? ` (${total} rows)` : "";
      return `Import: ${p.message || `looking up${count}`}…`;
    }
    case "mapping":
      return `Import: ${batch.stats.unknown_tags} tag${batch.stats.unknown_tags > 1 ? "s" : ""} to map`;
    case "error":
      return "Import failed";
    default:
      return `Import ready to review${total ? ` (${total} rows)` : ""}`;
  }
}

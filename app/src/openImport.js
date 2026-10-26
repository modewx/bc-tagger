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

// "progress" (looking up / locating), "interrupted" (the server restarted
// during the lookups: resumable), "mapping" (unknown tags to map), "review"
// (the preview), "committing", "committed" or "error". From the server's
// `step`, or (older servers) from the status and stats.
const STEPS = {
  resolving: "progress",
  locating: "progress",
  interrupted: "interrupted",
  mapping: "mapping",
  ready: "review",
  committing: "committing",
  committed: "committed",
  error: "error",
};
export function stepOf(batch) {
  if (batch.step && STEPS[batch.step]) return STEPS[batch.step];
  if (batch.status === "resolving") return "progress";
  if (batch.status === "error") return "error";
  if ((batch.unknownCount ?? (batch.stats && batch.stats.unknown_tags)) > 0) return "mapping";
  return "review";
}

export function stepUrl(batch) {
  const id = encodeURIComponent(batch.id);
  return ["review", "committing", "committed"].includes(stepOf(batch)) ? `/import/?batch=${id}` : `/settings/#import/${id}`;
}

// One line for the open import, e.g. "Import: looking up 48/150" or
// "Import ready to review". `live` is the latest progress {current, total, message}.
export function stepLabel(batch, live) {
  const total = (batch.stats && batch.stats.total) || "";
  const unknown = batch.unknownCount ?? (batch.stats && batch.stats.unknown_tags) ?? 0;
  switch (stepOf(batch)) {
    case "progress": {
      const p = live || batch.progress || {};
      const count = p.total ? ` ${p.current || 0}/${p.total}` : total ? ` (${total} rows)` : "";
      const what = batch.step === "locating" ? "locating files" : "looking up";
      return `Import: ${p.message || `${what}${count}`}…`;
    }
    case "interrupted":
      return "Import interrupted: resume the lookups";
    case "committing":
      return "Import: importing…";
    case "mapping":
      return `Import: ${unknown} tag${unknown > 1 ? "s" : ""} to map`;
    case "error":
      return "Import failed";
    default:
      return `Import ready to review${total ? ` (${total} rows)` : ""}`;
  }
}

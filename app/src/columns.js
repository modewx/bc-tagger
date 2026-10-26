// Local-app columns: Owned, Located (+ match details / candidates) and
// Rekordbox (status + per-item export), inserted after "Artist".

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { openPopover, closePopover } from "./popover";
import { progressText, resultText } from "./jobs";

const LOCAL_RANK = { located: 0, candidates: 1, missing: 2, unknown: 3 };
const OWNED_RANK = { owned: 0, not_owned: 1, unknown: 2 };
const RB_RANK = { exported: 0, partial: 1, none: 2 };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function localOf(item) {
  return item.local || { status: "unknown", best: null, candidates: [] };
}

// Files a located item resolves to (one per track; several for an album).
function locatedFiles(local) {
  const best = local && local.best;
  if (!best) return [];
  if (Array.isArray(best.tracks) && best.tracks.length) return best.tracks;
  return best.path ? [best] : [];
}

function fmtFormat(f) {
  return f ? String(f).toUpperCase() : "";
}

function fmtConfidence(c) {
  if (typeof c !== "number") return "";
  return `${Math.round(c <= 1 ? c * 100 : c)}%`;
}

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleString();
}

function basename(p) {
  return String(p || "").split("/").pop();
}

function dirname(p) {
  const parts = String(p || "").split("/");
  parts.pop();
  return parts.join("/");
}

/**
 * @param {object} ctx  {jobs, page(), settings(), statusEl()}
 */
export function appColumns(ctx) {
  const busy = {}; // item id -> label while a per-item job runs

  async function itemJob(key, label, path, body) {
    busy[key] = label;
    ctx.page().refreshRow(key);
    let job = null;
    try {
      job = await ctx.jobs.run(path, body, (j) => {
        busy[key] = `${label} ${progressText(j)}`;
        const s = document.querySelector(`#collectionTable tr[data-key="${key}"] .busy-note`);
        if (s) s.textContent = busy[key];
      });
    } catch (e) {
      job = { status: "error", error: e.message };
    }
    delete busy[key];
    ctx.statusEl().textContent = `${key}: ${label} ${resultText(job)}`;
    await ctx.page().reload();
    ctx.page().refreshRow(key);
    return job;
  }

  const locate = (key) => itemJob(key, "locating…", "/api/locate", { ids: [key] });
  const exportItem = (key) => itemJob(key, "exporting…", "/api/rekordbox/export", { ids: [key] });

  async function decide(key, path, decision) {
    try {
      await apiJson(`/api/matches/${encodeURIComponent(key)}/${decision}`, { method: "POST", body: { path } });
    } catch (e) {
      ctx.statusEl().textContent = `${decision} failed: ${e.message}`;
      return;
    }
    closePopover();
    await locate(key); // re-run the match so the decision takes effect
  }

  function busyNote(cell, key) {
    if (!busy[key]) return false;
    cell.appendChild(el("span", "busy-note", busy[key]));
    return true;
  }

  // ---- Located ---------------------------------------------------------------

  function fileRow(file, key, actions) {
    const row = el("div", "pop-file");
    const name = el("div", "pop-file-name", basename(file.path));
    const meta = el("div", "pop-file-meta");
    meta.textContent = [fmtFormat(file.format), fmtConfidence(file.confidence), dirname(file.path)]
      .filter(Boolean)
      .join(" · ");
    row.title = file.path;
    row.append(name, meta);
    if (actions.length) {
      const btns = el("div", "pop-actions");
      actions.forEach(([label, decision, cls]) => {
        const b = el("button", cls || "", label);
        b.addEventListener("click", () => decide(key, file.path, decision));
        btns.appendChild(b);
      });
      row.appendChild(btns);
    }
    return row;
  }

  function locatedPopover(anchor, key, item) {
    const local = localOf(item);
    openPopover(anchor, (pop) => {
      const files = locatedFiles(local);
      const heads = {
        located: files.length > 1 ? `Located: ${files.length} files` : "Located",
        candidates: "Possible matches: confirm the right one",
        missing: "Not found in the local folders",
        unknown: "Not located yet",
      };
      pop.appendChild(el("div", "pop-head", heads[local.status] || local.status));
      if (local.status === "located") {
        files.forEach((f) => pop.appendChild(fileRow(f, key, files.length === 1 ? [["Wrong file", "reject", "danger"]] : [])));
      }
      (local.candidates || []).forEach((c) =>
        pop.appendChild(fileRow(c, key, [["Confirm", "confirm", "primary"], ["Reject", "reject", "danger"]]))
      );
      if (local.located_at) pop.appendChild(el("div", "pop-meta", `checked ${fmtWhen(local.located_at)}`));
      const foot = el("div", "pop-actions");
      const again = el("button", "primary", local.status === "unknown" ? "Locate" : "Locate again");
      again.addEventListener("click", () => {
        closePopover();
        locate(key);
      });
      foot.appendChild(again);
      pop.appendChild(foot);
    });
  }

  function renderLocated(cell, key, item) {
    cell.classList.add("no-row-play", "status-cell");
    if (busyNote(cell, key)) return;
    const local = localOf(item);
    const files = locatedFiles(local);
    let label = "–";
    let title = "Not located yet (click for options)";
    if (local.status === "located") {
      const t = local.tracks || (local.best && local.best.track_counts);
      label = files.length > 1 ? `✓ ${files.length} files` : `✓ ${fmtFormat(files[0] && files[0].format) || "file"}`;
      if (t && t.total) label = `✓ ${t.located}/${t.total}`;
      title = files.map((f) => f.path).join("\n");
    } else if (local.status === "candidates") {
      label = `? ${(local.candidates || []).length}`;
      title = "Possible matches; click to confirm";
    } else if (local.status === "missing") {
      label = "✗";
      title = "Not found in the local folders";
    }
    const chip = el("button", `chip loc-${local.status}`, label);
    chip.title = title;
    chip.addEventListener("click", () => locatedPopover(chip, key, item));
    cell.appendChild(chip);
  }

  // ---- Owned -----------------------------------------------------------------

  // Owned on Bandcamp but the only local copy is in a not-owned (e.g. Soulseek)
  // folder: worth re-downloading in better quality. And the reverse.
  function ownershipHint(item) {
    const o = item.owned || {};
    const local = localOf(item);
    if (local.status !== "located") return null;
    const s = ctx.settings() || {};
    const paths = locatedFiles(local).map((f) => f.path || "");
    const inOwnedRoot = s.owned_root && paths.some((p) => p.startsWith(s.owned_root));
    const notOwnedRoots = (s.not_owned_roots || []).map((r) => r.path).filter(Boolean);
    const onlyNotOwned = paths.length && paths.every((p) => notOwnedRoots.some((r) => p.startsWith(r)));
    if (o.status === "owned" && onlyNotOwned) {
      return "Owned on Bandcamp, but the local copy is in a not-owned folder: re-download for better quality?";
    }
    if (o.status === "not_owned" && inOwnedRoot) return "Not owned on Bandcamp, but found in the owned folder.";
    return null;
  }

  function renderOwned(cell, key, item) {
    cell.classList.add("status-cell");
    const o = item.owned || { status: "unknown" };
    const labels = { owned: "owned", not_owned: "—", unknown: "?" };
    const chip = el("span", `chip own-${o.status}`, labels[o.status] || o.status);
    const meta = o.checked_at ? `\n${o.source || ""} · checked ${fmtWhen(o.checked_at)}` : "";
    chip.title = { owned: "Owned on Bandcamp", not_owned: "Not owned on Bandcamp", unknown: "Ownership unknown (Refresh ownership)" }[o.status] + meta;
    cell.appendChild(chip);
    const hint = ownershipHint(item);
    if (hint) {
      const h = el("span", "chip hint", "!");
      h.title = hint;
      cell.appendChild(h);
    }
  }

  // ---- Rekordbox -------------------------------------------------------------

  function renderRekordbox(cell, key, item) {
    cell.classList.add("no-row-play", "status-cell");
    if (busyNote(cell, key)) return;
    const rb = item.rekordbox || { status: "none" };
    const located = localOf(item).status === "located";
    if (rb.status === "exported" || rb.status === "partial") {
      const chip = el("span", `chip rb-${rb.status}`, rb.status === "exported" ? "✓ in RB" : "partial");
      chip.title = (rb.playlists || []).length ? `Playlists: ${rb.playlists.join(", ")}` : "In the rekordbox collection";
      cell.appendChild(chip);
    }
    if (rb.status !== "exported") {
      const btn = el("button", "mini-btn", "Export");
      btn.disabled = !located;
      btn.title = located ? "Add to rekordbox (one playlist per tag)" : "Locate the file first";
      btn.addEventListener("click", () => exportItem(key));
      cell.appendChild(btn);
    }
  }

  return [
    {
      id: "owned",
      label: "Owned",
      after: "artist",
      sortKey: "owned",
      compare: (a, b) => (OWNED_RANK[(a.owned || {}).status] ?? 3) - (OWNED_RANK[(b.owned || {}).status] ?? 3),
      render: renderOwned,
    },
    {
      id: "located",
      label: "Located",
      after: "owned",
      sortKey: "located",
      compare: (a, b) => (LOCAL_RANK[localOf(a).status] ?? 4) - (LOCAL_RANK[localOf(b).status] ?? 4),
      render: renderLocated,
    },
    {
      id: "rekordbox",
      label: "Rekordbox",
      after: "located",
      sortKey: "rekordbox",
      compare: (a, b) =>
        (RB_RANK[(a.rekordbox || {}).status] ?? 3) - (RB_RANK[(b.rekordbox || {}).status] ?? 3),
      render: renderRekordbox,
    },
  ];
}

// Play located tracks from disk (the server transcodes what Chrome can't play).
export function localPlayUrl(item) {
  if (item.tralbum_type === "a") return null;
  const files = locatedFiles(localOf(item));
  if (localOf(item).status !== "located" || files.length !== 1) return null;
  return `/api/files/stream?path=${encodeURIComponent(files[0].path)}`;
}

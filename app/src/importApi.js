// Import batches on the server (Phase 3). All shape knowledge about the
// server's batch/row JSON lives here: the Import tab and the preview page use
// the normalized form below.
//
// Batch: {id, status, committed, error, source, created_at, job_id, stats,
//         unknownTags: {tag: [suggested]}, newTags, defaultTags, rows: [Row]}
// Row:   {n, line, raw, kind, artist, title, album, album_artist, track_num, position, duration, year,
//         label, catalog, expanded_from, tags, flags, note, checked, needsConfirmation,
//         source: "bandcamp" | "other", duplicate: null | {of, source, title, artist, tags},
//         via: how the row got its Bandcamp item ("collection" | "resolved" | "chosen" | "linked" | null),
//         match: {status, source, confidence, query, url, error, chosen, candidates, item}, item (tagger item or null),
//         lookupUnavailable, lookupReason ("challenge" | "off" | "error": why the server didn't look it up),
//         hints: {bandcamp, discogs} (links from the file or a metadata lookup), local,
//         links: {discogs, youtube}, committed}
// Batch.pendingReleases: [{line, artist, release, tags, reason}] (not importable yet)

import { apiJson } from "../../shared/datasource/HttpDataSource";

const enc = encodeURIComponent;

function normDuplicate(d, r) {
  if (!d && r.existing_id) d = { of: r.existing_id, source: /^o/.test(r.existing_id) ? "other" : "bandcamp", tags: r.existing_tags };
  if (!d) return null;
  if (typeof d === "string") return { of: d, source: null, title: null, artist: null, tags: [] };
  return { of: d.of || d.id || null, source: d.source || null, title: d.title || null, artist: d.artist || null, tags: d.tags || [] };
}

// The server's resolver stops on Bandcamp's bot check; rows it didn't look up
// say so ("unavailable", or an error naming the challenge / bot-check page).
function lookupUnavailable(r, match) {
  if (r.lookup === "unavailable" || r.lookup_status === "unavailable") return true;
  if (match.status === "unavailable" || match.status === "challenge") return true;
  return match.status === "error" && /challenge|bot.?check/i.test(String(match.error || match.message || ""));
}

function normRow(r, i) {
  const match = r.match || r.resolve || {};
  const chosen = match.chosen || match.candidate || null;
  const bc = r.bandcamp || null; // the server's {item, via}
  return {
    n: r.n ?? r.index ?? r.row ?? i,
    line: r.line,
    raw: r.raw,
    kind: r.kind || "track",
    artist: r.artist ?? null,
    title: r.title || "",
    album: r.album ?? null,
    album_artist: r.album_artist ?? null,
    track_num: r.track_num ?? null,
    position: r.position ?? null,
    duration: r.duration ?? null,
    expanded_from: r.expanded_from ?? null,
    label: r.label ?? null,
    catalog: r.catalog ?? null,
    year: r.year ?? null,
    tags: Array.isArray(r.tags) ? r.tags : [],
    flags: Array.isArray(r.flags) ? r.flags : [],
    note: r.note || null,
    checked: r.checked !== false,
    source: r.source || (bc || chosen || r.item || match.item ? "bandcamp" : "other"),
    via: (bc && bc.via) || null,
    duplicate: normDuplicate(r.duplicate || r.duplicate_of, r),
    needsConfirmation: (Array.isArray(r.flags) ? r.flags : []).includes("needs_user_confirmation"),
    lookupUnavailable: lookupUnavailable(r, match),
    lookupReason: match.reason || (/challenge|bot.?check/i.test(String(match.error || "")) ? "challenge" : null),
    match: {
      status: match.status || null,
      source: match.source || match.match_source || r.match_source || null,
      error: match.error || match.message || null,
      confidence: match.confidence ?? (chosen && chosen.confidence) ?? null,
      query: match.query || null,
      url: match.url || match.match_url || null,
      chosen,
      candidates: Array.isArray(match.candidates) ? match.candidates : [],
      item: match.item || null,
    },
    item: (bc && bc.item) || match.item || r.item || null,
    // The Bandcamp item's ownership ({status, track_owned, album_owned, full_release}); null when unknown.
    owned: r.owned || null,
    local: r.located || r.local || null,
    links: r.links || {},
    hints: {
      bandcamp: (r.hints && r.hints.bandcamp_url) || r.bandcamp_url || (r.links && r.links.bandcamp) || null,
      discogs: (r.hints && r.hints.discogs_url) || r.discogs_url || null,
    },
    committed: r.committed || null,
  };
}

export function normBatch(b) {
  if (!b) return null;
  const rows = (b.rows || b.items || []).map(normRow);
  return {
    id: b.batch_id || b.id,
    status: b.status || (b.job && b.job.status) || null,
    committed: b.status === "committed" || !!b.committed_at,
    committed_at: b.committed_at || null,
    error: b.error || null,
    source: b.name || b.source || b.filename || "",
    created_at: b.created_at || null,
    job_id: b.job_id || (b.job && b.job.id) || null,
    stats: b.stats || {},
    // Where it is (the server's reopen fields): step, the running job and its progress.
    step: b.step || null, // resolving | locating | interrupted | mapping | ready | committing | committed | error
    progress: b.progress || null,
    job: b.job || (b.job_id ? { id: b.job_id } : null),
    resumable: !!b.resumable,
    unknownTags: b.unknown_tags && typeof b.unknown_tags === "object" ? b.unknown_tags : {},
    unknownCount:
      typeof b.unknown_tags === "number"
        ? b.unknown_tags
        : b.unknown_tags && typeof b.unknown_tags === "object"
        ? Object.keys(b.unknown_tags).length
        : null, // older servers' lists: from stats
    newTags: b.new_tags || [],
    defaultTags: b.default_tags || [],
    defaultTagsAll: !!b.default_tags_all, // default tags on every row, not only untagged ones
    pendingReleases: Array.isArray(b.pending_releases) ? b.pending_releases : [],
    lookups: b.bandcamp_lookups || null, // {state: "on" | "off" | "stopped" | "paused", reason, error, at}
    lookupVia: b.lookup === "browser" ? "browser" : "server", // who makes the Bandcamp requests
    estimate: b.estimate || null, // {lookups, cached, requests, seconds, interval_s, text}
    logs: Array.isArray(b.logs) ? b.logs : [], // its import logs (JSON file names), oldest first
    rows,
  };
}

export const listBatches = () => apiJson("/api/import").then((l) => (Array.isArray(l) ? l : (l && l.batches) || []).map(normBatch));
export const getBatch = (id) => apiJson(`/api/import/${enc(id)}`).then(normBatch);
// lookup: "server" (the server looks rows up on Bandcamp) or "browser" (the
// extension does, in the user's Chrome, while the Import tab is open).
export const startImport = (file, name, defaultTags, defaultTagsAll = false, lookup = "server") =>
  apiJson("/api/import", { method: "POST", body: { file, name, default_tags: defaultTags, default_tags_all: defaultTagsAll, lookup } });
// Change an open batch's default tags: `all` puts them on every row, else only on untagged rows.
export const setDefaultTags = (id, tags, all) =>
  apiJson(`/api/import/${enc(id)}/default-tags`, { method: "PUT", body: { tags, all } });
// patch: any of {tags, checked, choose: <candidate id> | null, artist, title, album, re_resolve,
//        match_url (a Bandcamp page the user found; stored, not fetched), link_item}
export const updateRow = (id, n, patch) =>
  apiJson(`/api/import/${enc(id)}/rows/${enc(n)}`, { method: "PUT", body: patch }).then((r) => (r ? normRow(r, n) : r));
export const applyTagMap = (id, map, unmapped) =>
  apiJson(`/api/import/${enc(id)}/tags`, { method: "POST", body: { map, unmapped } });
export const commitBatch = (id) => apiJson(`/api/import/${enc(id)}/commit`, { method: "POST", body: {} });
// Locate rows again after files were added: "missing" | "all" | [n] (→ {job_id};
// the job's result has newly_located, still_missing). Hand-set files stay.
export const relocateRows = (id, rows = "missing") =>
  apiJson(`/api/import/${enc(id)}/locate`, { method: "POST", body: { rows, scan: "quick" } });
export const relocateRow = (id, n) => apiJson(`/api/import/${enc(id)}/rows/${enc(n)}/locate`, { method: "POST", body: {} }).then((r) => normRow(r, n));
// Files in the index matching every word of `q` (artist, title, album, path).
export const searchFiles = (q) => apiJson(`/api/index/search?q=${enc(q)}&limit=25`);

// A folder of the music folders (no path: the roots), for picking a file:
// {path, parent, dirs: [{name, path}], files: [{name, path, title, artist, album, format}]}.
export async function listFolder(path) {
  const d = await apiJson(path ? `/api/fs/list?path=${enc(path)}` : "/api/fs/list");
  const isDir = (e) => e.type === "dir" || e.kind === "dir" || e.is_dir === true;
  const entries = Array.isArray(d.entries) ? d.entries : [];
  const name = (e) => e.name || String(e.path || "").replace(/\/$/, "").split("/").pop();
  const withName = (e) => ({ ...e, name: name(e) });
  return {
    path: d.path || null,
    parent: d.parent ?? null,
    dirs: (d.dirs || d.roots || entries.filter(isDir)).map(withName),
    files: (d.files || entries.filter((e) => !isDir(e))).map(withName),
  };
}
// Lookups paused by Bandcamp's rate limiting: carry on (→ {job_id, estimate}).
export const resumeLookups = (id) => apiJson(`/api/import/${enc(id)}/resume`, { method: "POST", body: {} });
export const discardBatch = (id) => apiJson(`/api/import/${enc(id)}`, { method: "DELETE" });

// Where a row's Bandcamp match came from, for the preview's Match column.
// The server's match.source when it sends one, else from the status.
const VIA = { collection: "collection", chosen: "picked", linked: "linked" };

export function matchSource(row) {
  const m = row.match;
  if (row.via) return VIA[row.via] || (m.source === "file" || m.source === "file_url" ? "file" : "search");
  if (row.lookupUnavailable && row.source !== "bandcamp") return "unavailable";
  if (row.duplicate && row.duplicate.source !== "other" && row.source === "bandcamp") return "collection";
  // The server names where it looked even when nothing was found ("search"):
  // only a match (accepted, chosen, candidates) takes its source.
  const mb = m.source === "musicbrainz";
  if (m.status === "manual") return m.url || m.source === "url" ? "url" : m.chosen ? (mb ? "musicbrainz" : "picked") : "notbc"; // chosen null: "not on Bandcamp"
  if (m.status === "accepted") return mb ? "musicbrainz" : m.source === "file" || m.source === "file_url" ? "file" : m.source && m.source !== "search" ? m.source : "search";
  if (m.status === "candidates") return mb ? "musicbrainz" : "candidates";
  if (m.status === "in_collection") return "collection";
  if (m.status === "error") return "error";
  if (m.status === "pending") return "pending";
  return "none";
}

// Bandcamp's own search for a row, for the user to look at in a normal tab.
export function bandcampSearchUrl(row) {
  const q = [row.artist, row.kind === "album" ? row.album || row.title : row.title].filter(Boolean).join(" ");
  return `https://bandcamp.com/search?q=${enc(q)}&item_type=${row.kind === "album" ? "a" : "t"}`;
}

// "Open on Bandcamp": the page the user pasted, else the row's link hint (from
// the file), else Bandcamp's search.
export function openOnBandcampUrl(row) {
  return cleanBandcampUrl(row.match.url) || cleanBandcampUrl(row.hints.bandcamp) || bandcampSearchUrl(row);
}

// A pasted Bandcamp track/album page URL (artist.bandcamp.com or a label's
// own domain), cleaned of query and fragment; null if it isn't one.
export function cleanBandcampUrl(text) {
  let u;
  try {
    u = new URL(String(text || "").trim());
  } catch (e) {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !/^\/(track|album)\/[^/]+\/?$/.test(u.pathname)) return null;
  return `https://${u.host}${u.pathname.replace(/\/$/, "")}`;
}

// One table item per row (the shared table renders items): the Bandcamp
// match's tagger item when there is one (so its stream link plays), plus the
// row's own fields.
export function rowToItem(row) {
  const base = row.item || {};
  const key = `r${row.n}`;
  return {
    ...base,
    id: key,
    bandcamp_id: base.id || null,
    title: row.title || base.title || "",
    artist: row.artist || base.artist || "",
    album_title: row.album || base.album_title || null,
    tags: row.tags,
    tralbum_type: row.kind === "album" ? "a" : "t",
    source: row.source,
    url: base.url || base.item_url || (row.match.chosen && row.match.chosen.url) || null,
    links: row.links,
    local: row.local || base.local || null,
    owned: row.owned || base.owned || null,
    importRow: row, // not "_row": the table compares items without _ fields, and row-only changes must show
  };
}

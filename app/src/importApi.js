// Import batches on the server (Phase 3). All shape knowledge about the
// server's batch/row JSON lives here: the Import tab and the preview page use
// the normalized form below.
//
// Batch: {id, status, committed, error, source, created_at, job_id, stats,
//         unknownTags: {tag: [suggested]}, newTags, defaultTags, rows: [Row]}
// Row:   {n, line, raw, kind, artist, title, album, album_artist, track_num, position, duration, year,
//         label, catalog, expanded_from, tags, flags, note, checked, needsConfirmation,
//         source: "bandcamp" | "other", duplicate: null | {of, source, title, artist, tags},
//         match: {status, source, confidence, query, url, chosen, candidates}, item (tagger item or null),
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

function normRow(r, i) {
  const match = r.match || r.resolve || {};
  const chosen = match.chosen || match.candidate || null;
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
    source: r.source || (chosen || r.item || match.item ? "bandcamp" : "other"),
    duplicate: normDuplicate(r.duplicate || r.duplicate_of, r),
    needsConfirmation: (Array.isArray(r.flags) ? r.flags : []).includes("needs_user_confirmation"),
    match: {
      status: match.status || null,
      source: match.source || null,
      confidence: match.confidence ?? (chosen && chosen.confidence) ?? null,
      query: match.query || null,
      url: match.url || match.match_url || null,
      chosen,
      candidates: Array.isArray(match.candidates) ? match.candidates : [],
      item: match.item || null,
    },
    item: match.item || r.item || null,
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
    unknownTags: b.unknown_tags || {},
    newTags: b.new_tags || [],
    defaultTags: b.default_tags || [],
    pendingReleases: Array.isArray(b.pending_releases) ? b.pending_releases : [],
    rows,
  };
}

export const listBatches = () => apiJson("/api/import").then((l) => (Array.isArray(l) ? l : (l && l.batches) || []).map(normBatch));
export const getBatch = (id) => apiJson(`/api/import/${enc(id)}`).then(normBatch);
export const startImport = (file, name, defaultTags) =>
  apiJson("/api/import", { method: "POST", body: { file, name, default_tags: defaultTags } });
// patch: any of {tags, checked, choose: <candidate id> | null, artist, title, album, re_resolve, match_url}
export const updateRow = (id, n, patch) =>
  apiJson(`/api/import/${enc(id)}/rows/${enc(n)}`, { method: "PUT", body: patch }).then((r) => (r ? normRow(r, n) : r));
export const applyTagMap = (id, map, unmapped) =>
  apiJson(`/api/import/${enc(id)}/tags`, { method: "POST", body: { map, unmapped } });
export const commitBatch = (id) => apiJson(`/api/import/${enc(id)}/commit`, { method: "POST", body: {} });
export const discardBatch = (id) => apiJson(`/api/import/${enc(id)}`, { method: "DELETE" });

// Where a row's Bandcamp match came from, for the preview's Match column.
// The server's match.source when it sends one, else from the status.
export function matchSource(row) {
  const m = row.match;
  if (m.source) return m.source;
  if (row.duplicate && row.duplicate.source !== "other" && row.source === "bandcamp") return "collection";
  if (m.status === "manual") return m.url ? "url" : m.item && !m.candidates.length ? "linked" : "picked";
  if (m.status === "accepted") return "search";
  if (m.status === "candidates") return "candidates";
  if (m.status === "error") return "error";
  return "none";
}

// Bandcamp's own search for a row, for the user to look at in a normal tab.
export function bandcampSearchUrl(row) {
  const q = [row.artist, row.kind === "album" ? row.album || row.title : row.title].filter(Boolean).join(" ");
  return `https://bandcamp.com/search?q=${enc(q)}&item_type=${row.kind === "album" ? "a" : "t"}`;
}

// "Open on Bandcamp": the row's link hint (file or metadata lookup) when it
// has one, else Bandcamp's search.
export function openOnBandcampUrl(row) {
  return cleanBandcampUrl(row.hints.bandcamp) || bandcampSearchUrl(row);
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
    _row: row,
  };
}

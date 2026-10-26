// Import batches on the server (Phase 3). All shape knowledge about the
// server's batch/row JSON lives here: the Import tab and the preview page use
// the normalized form below.
//
// Batch: {id, status, source, created_at, job_id, stats, unknownTags: {tag: [suggested]}, rows: [Row]}
// Row:   {n, line, raw, kind, artist, title, album, tags, flags, note, checked,
//         source: "bandcamp" | "other", duplicate (id of the existing item or null),
//         match: {status, confidence, candidate, candidates}, item (tagger item or null), local}

import { apiJson } from "../../shared/datasource/HttpDataSource";

const enc = encodeURIComponent;

function normRow(r, i) {
  const match = r.match || r.resolve || {};
  return {
    n: r.n ?? r.index ?? r.row ?? i,
    line: r.line,
    raw: r.raw,
    kind: r.kind || "track",
    artist: r.artist ?? null,
    title: r.title || "",
    album: r.album ?? null,
    tags: Array.isArray(r.tags) ? r.tags : [],
    flags: Array.isArray(r.flags) ? r.flags : [],
    note: r.note || null,
    checked: r.checked !== false,
    source: r.source || (r.item || match.candidate ? "bandcamp" : "other"),
    duplicate: r.duplicate_of || (r.duplicate && (r.duplicate.id || r.duplicate)) || null,
    match: {
      status: match.status || null,
      confidence: match.confidence ?? null,
      candidate: match.candidate || null,
      candidates: Array.isArray(match.candidates) ? match.candidates : [],
    },
    item: r.item || match.item || null,
    local: r.local || null,
    other: r.other || null, // the `other` item this row would create / merge into
    raw_row: r,
  };
}

export function normBatch(b) {
  if (!b) return null;
  const rows = (b.rows || b.items || []).map(normRow);
  return {
    id: b.batch_id || b.id,
    status: b.status || (b.job && b.job.status) || null,
    source: b.source || b.filename || "",
    created_at: b.created_at || null,
    committed_at: b.committed_at || null,
    job_id: b.job_id || (b.job && b.job.id) || null,
    stats: b.stats || {},
    unknownTags: b.unknown_tags || {},
    defaultTags: b.default_tags || [],
    rows,
  };
}

export const listBatches = () => apiJson("/api/import").then((l) => (Array.isArray(l) ? l : (l && l.batches) || []).map(normBatch));
export const getBatch = (id) => apiJson(`/api/import/${enc(id)}`).then(normBatch);
export const startImport = (data, filename, defaultTags) =>
  apiJson("/api/import", { method: "POST", body: { data, filename, default_tags: defaultTags } });
export const updateRow = (id, n, patch) =>
  apiJson(`/api/import/${enc(id)}/rows/${enc(n)}`, { method: "PUT", body: patch });
export const applyTagMap = (id, map, unmapped) =>
  apiJson(`/api/import/${enc(id)}/tags`, { method: "POST", body: { map, unmapped } }).then(normBatch);
export const commitBatch = (id) => apiJson(`/api/import/${enc(id)}/commit`, { method: "POST", body: {} });
export const discardBatch = (id) => apiJson(`/api/import/${enc(id)}`, { method: "DELETE" });

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
    local: row.local || base.local || null,
    _row: row,
  };
}

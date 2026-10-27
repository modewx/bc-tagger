// Server jobs (locate, export, ownership refresh, ...): start one, then follow
// its progress over SSE, polling /api/jobs/{id} as a fallback.

import { apiJson } from "../../shared/datasource/HttpDataSource";

export class Jobs {
  constructor(events) {
    this.events = events;
    this.watchers = new Map(); // job id -> {onProgress, resolve, timer}
    // A job's events can arrive before its start call has answered: keep the
    // latest of jobs nobody watches yet, for watch() to start from.
    this.early = new Map();
    events.on("job", (job) => {
      if (job && job.id && !this.watchers.has(job.id)) {
        this.early.set(job.id, job);
        if (this.early.size > 20) this.early.delete(this.early.keys().next().value);
      }
      this._update(job);
    });
    // Back from a hidden tab: check the jobs being watched now (their events were missed).
    events.on("resume", () =>
      this.watchers.forEach((w) => {
        clearTimeout(w.timer);
        w.poll();
      })
    );
  }

  // POST `path` (which answers {job_id}) and resolve with the finished job.
  async run(path, body, onProgress) {
    const { job_id } = await apiJson(path, { method: "POST", body: body || {} });
    return this.watch(job_id, onProgress);
  }

  watch(id, onProgress) {
    return new Promise((resolve) => {
      const w = { onProgress, resolve, timer: null };
      this.watchers.set(id, w);
      const early = this.early.get(id);
      this.early.delete(id);
      if (early) this._update(early);
      const poll = (w.poll = async () => {
        if (!this.watchers.has(id)) return;
        try {
          this._update(await apiJson(`/api/jobs/${encodeURIComponent(id)}`));
        } catch (e) {
          /* keep polling */
        }
        if (this.watchers.has(id)) {
          clearTimeout(w.timer);
          w.timer = setTimeout(poll, this.events.connected ? 3000 : 1000);
        }
      });
      w.timer = setTimeout(poll, 300);
    });
  }

  _update(job) {
    const w = job && this.watchers.get(job.id);
    if (!w) return;
    if (w.onProgress) w.onProgress(job);
    if (job.status === "done" || job.status === "error") {
      clearTimeout(w.timer);
      this.watchers.delete(job.id);
      w.resolve(job);
    }
  }
}

export function progressText(job) {
  const p = job.progress || {};
  const total = p.total || 0;
  const count = total ? ` ${p.current || 0}/${total}` : "";
  const msg = p.message ? ` · ${p.message}` : "";
  return `${job.status}${count}${msg}`;
}

// One line for a finished job. Results differ per job kind, so show its
// numeric fields (located: 3, missing: 2, ...) plus a short message if any.
// What a Locate/Export's scan did, from the job result's `scan`, e.g.
// "checked 586 files new or changed since Oct 18 · via Spotlight".
const METHODS = { "spotlight+walk": "Spotlight", spotlight: "Spotlight", walk: "folder walk", fsevents: "FSEvents" };

export function scanSummary(r) {
  const s = r && typeof r === "object" ? r.scan || r.quick_scan : null;
  if (!s || typeof s !== "object") return "";
  if (s.mode === "none") return "no scan";
  if (s.skipped) return `no scan: ${typeof s.skipped === "string" ? s.skipped : "skipped"}`;
  if (s.mode === "full") return `full scan · ${s.files ?? "?"} files`;
  const d = s.cutoff ? new Date(s.cutoff) : null;
  const date = d && !isNaN(d) ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  const methods = [
    ...new Set(
      (s.roots || [])
        .map((x) => x.method)
        .filter((m) => m && !/^skipped/.test(m))
        .map((m) => METHODS[m] || m)
    ),
  ];
  const skippedRoots = (s.roots || []).filter((x) => /^skipped/.test(x.method || "")).length;
  return [
    `checked ${s.checked ?? 0} files new or changed${date ? ` since ${date}` : ""}`,
    s.added ? `${s.added} new` : "",
    methods.length ? `via ${methods.join(" + ")}` : "",
    skippedRoots ? `${skippedRoots} folder${skippedRoots > 1 ? "s" : ""} not mounted` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function resultText(job) {
  if (job.status === "error") return `failed: ${job.error || "error"}`;
  const r = job.result;
  if (r == null) return "done";
  if (typeof r !== "object") return `done: ${r}`;
  const scan = scanSummary(r);
  const parts = [];
  Object.entries(r).forEach(([k, v]) => {
    if (typeof v === "number") parts.push(`${k.replace(/_/g, " ")}: ${v}`);
    else if (Array.isArray(v) && parts.length < 8) parts.push(`${k.replace(/_/g, " ")}: ${v.length}`);
  });
  if (typeof r.message === "string") parts.push(r.message);
  const main = parts.length ? `done · ${parts.slice(0, 8).join(", ")}` : "done";
  return scan ? `${main} (${scan})` : main;
}

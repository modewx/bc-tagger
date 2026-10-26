// Server jobs (locate, export, ownership refresh, ...): start one, then follow
// its progress over SSE, polling /api/jobs/{id} as a fallback.

import { apiJson } from "../../shared/datasource/HttpDataSource";

export class Jobs {
  constructor(events) {
    this.events = events;
    this.watchers = new Map(); // job id -> {onProgress, resolve, timer}
    events.on("job", (job) => this._update(job));
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
      const poll = async () => {
        if (!this.watchers.has(id)) return;
        try {
          this._update(await apiJson(`/api/jobs/${encodeURIComponent(id)}`));
        } catch (e) {
          /* keep polling */
        }
        if (this.watchers.has(id)) w.timer = setTimeout(poll, this.events.connected ? 3000 : 1000);
      };
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
export function resultText(job) {
  if (job.status === "error") return `failed: ${job.error || "error"}`;
  const r = job.result;
  if (r == null) return "done";
  if (typeof r !== "object") return `done: ${r}`;
  const parts = [];
  Object.entries(r).forEach(([k, v]) => {
    if (typeof v === "number" || typeof v === "boolean") parts.push(`${k.replace(/_/g, " ")}: ${v}`);
    else if (Array.isArray(v) && parts.length < 8) parts.push(`${k.replace(/_/g, " ")}: ${v.length}`);
  });
  if (typeof r.message === "string") parts.push(r.message);
  return parts.length ? `done · ${parts.slice(0, 8).join(", ")}` : "done";
}

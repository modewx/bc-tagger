// Previews (the server's previews.py): "Build previews" (Tools ▾) for the selected or shown items: a dry run
// first, in a dialog (how many, how much of the cap, roughly how long), then the build with its progress and
// Cancel in the status line, and what it did at the end. The rows follow the server's `preview` events, so the
// next player made for a row plays its new preview (one playing keeps its source).

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { confirmDialog } from "./dialog";

const DRIVE_MB_S = 120; // the music drive's read speed, for the estimate

export function fmtBytes(b) {
  b = Number(b) || 0;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1).replace(/\.0$/, "")} GB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`;
  return `${b ? Math.max(1, Math.round(b / 1024)) : 0} KB`;
}

function fmtClock(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function fmtMinutes(s) {
  const min = Math.round(s / 60);
  if (min < 1) return "under a minute";
  if (min < 60) return `about ${min} min`;
  return `about ${Math.floor(min / 60)} h ${min % 60} min`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const basename = (p) => String(p || "").split("/").pop();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// The dry run, in words.
function planBody(plan, what) {
  const body = el("div", "preview-plan");
  const p = (text, cls) => body.appendChild(el("p", cls, text));
  const has = [
    plan.already ? `${plural(plan.already, "track")} already ${plan.already === 1 ? "has" : "have"} one` : "",
    plan.native ? `${plural(plan.native, "track")} ${plan.native === 1 ? "plays" : "play"} as ${plan.native === 1 ? "it is" : "they are"} (MP3, FLAC, WAV…)` : "",
    plan.missing ? `${plural(plan.missing, "file")} ${plan.missing === 1 ? "isn't" : "aren't"} in the index (Rescan drive)` : "",
  ].filter(Boolean);
  p(`Of ${what}: ${plural(plan.needed, "track")} ${plan.needed === 1 ? "needs" : "need"} a preview${has.length ? `; ${has.join("; ")}` : ""}.`);
  if (!plan.planned) return body;
  if (plan.left_out) {
    const why = [
      plan.fits_cap ? "" : "the space for previews is full (raise it in Settings → Previews)",
      plan.fits_space ? "" : "this Mac would drop below the 2 GB it keeps free",
    ].filter(Boolean);
    p(
      `${plan.planned} of them fit; ${plural(plan.left_out, "track")} (about ${fmtBytes(plan.left_out_bytes)}) ${plan.left_out === 1 ? "is" : "are"} left out: ${why.join(", and ") || "no room"}.`,
      "warn-box"
    );
  }
  p(
    `About ${fmtBytes(plan.planned_bytes)} of the ${fmtBytes(plan.cap_bytes)} for previews (${plan.used_bytes ? `${fmtBytes(plan.used_bytes)} used now` : "none used yet"}; ` +
      `${fmtBytes(plan.free_bytes)} free on this Mac). Opus at ${plan.kbps} kbps.`
  );
  p(
    `Time: ${fmtMinutes((plan.source_bytes || 0) / (DRIVE_MB_S * 1024 ** 2))}, to read ${fmtBytes(plan.source_bytes)} from the music drive at ` +
      `about ${DRIVE_MB_S} MB/s (${plural(plan.parallel, "encoder")} at once). An estimate: the drive's speed decides.`
  );
  p("The music drive must stay connected until it's done. Cancel stops it at any time; what's built is kept.", "muted");
  return body;
}

function progressLine(job) {
  const p = job.progress || {};
  if (p.built == null && !p.total) return `Build previews: ${p.message || "starting…"}`;
  return [
    `Build previews: ${p.built || 0}/${p.total || 0} built`,
    p.failed ? `${p.failed} failed` : "",
    p.read_mb_s != null ? `${Math.round(p.read_mb_s)} MB/s` : "",
    p.eta_s != null ? `ETA ${fmtClock(p.eta_s)}` : "",
    p.current_file ? basename(p.current_file) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function summary(job) {
  if (job.status === "error") return [`Build previews failed: ${job.error || "error"}`, []];
  const r = job.result || {};
  const parts = [`Build previews: ${r.built || 0} built, ${r.failed || 0} failed, ${r.skipped || 0} skipped`];
  if (r.cancelled) parts.push(`cancelled${r.not_built ? ` (${r.not_built} not built)` : ""}`);
  if (r.stopped) parts.push(`stopped: ${r.stopped}`);
  if (r.elapsed_s != null) parts.push(`in ${fmtClock(r.elapsed_s)}${r.read_mb_s ? ` at ${Math.round(r.read_mb_s)} MB/s` : ""}`);
  return [parts.join(" · "), Array.isArray(r.errors) ? r.errors : []];
}

// Follow a build in `statusEl`: its progress with Cancel, then what it did (errors in a list to open).
async function follow(jobs, jobId, statusEl) {
  statusEl.innerHTML = "";
  const text = el("span", "preview-progress", "Build previews: starting…");
  const cancel = el("button", "preview-cancel", "Cancel");
  cancel.type = "button";
  cancel.id = "cancelPreviewBuild";
  cancel.addEventListener("click", async () => {
    cancel.disabled = true;
    cancel.textContent = "Cancelling…";
    try {
      await apiJson(`/api/previews/build/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: {} });
    } catch (e) {
      cancel.disabled = false;
      cancel.textContent = "Cancel";
      text.textContent = `${text.textContent} (couldn't cancel: ${e.message})`;
    }
  });
  statusEl.append(text, " ", cancel);
  const job = await jobs.watch(jobId, (j) => statusEl.contains(text) && (text.textContent = progressLine(j)));
  const [line, errors] = summary(job);
  statusEl.innerHTML = "";
  statusEl.append(line);
  if (errors.length) {
    const list = el("details", "preview-errors");
    list.appendChild(el("summary", "", plural(errors.length, "error")));
    const ul = el("ul");
    errors.forEach((e) => ul.appendChild(el("li", "", `${basename(e.path)}: ${e.reason || e.error || e.status || "failed"}`)));
    list.appendChild(ul);
    statusEl.append(" ", list);
  }
  return job;
}

/**
 * Build previews: the dry run, the confirm, then the build followed in `statusEl`.
 * @param {object} o
 * @param {{ids?: string[], all?: boolean}} o.target  what to build for (the server takes the located files)
 * @param {string} o.what  the target in words ("the 12 selected items")
 */
export async function buildPreviews({ jobs, statusEl, button, target, what }) {
  button.disabled = true;
  try {
    statusEl.textContent = "Build previews: checking…";
    let plan;
    try {
      ({ plan } = await apiJson("/api/previews/build", { method: "POST", body: { ...target, dry_run: true } }));
    } catch (e) {
      statusEl.textContent = `Build previews: ${e.message}`;
      return;
    }
    const ok = await confirmDialog({
      id: "previewBuildConfirm",
      title: plan.planned ? `Build ${plural(plan.planned, "preview")}?` : "Nothing to build",
      body: planBody(plan, what),
      confirmLabel: `Build ${plural(plan.planned, "preview")}`,
      infoOnly: !plan.planned,
    });
    if (!ok) {
      statusEl.textContent = "";
      return;
    }
    let started;
    try {
      started = await apiJson("/api/previews/build", { method: "POST", body: target });
    } catch (e) {
      if (e.status === 409) return void (await followRunning(jobs, statusEl)); // one is running: follow it
      statusEl.textContent = `Build previews: ${e.message}`;
      return;
    }
    await follow(jobs, started.job_id, statusEl);
  } finally {
    button.disabled = false;
  }
}

/** A build that's running (started before this page, or elsewhere): its progress and Cancel in `statusEl`. */
export async function followRunning(jobs, statusEl, button) {
  let status = null;
  try {
    status = await apiJson("/api/previews/status");
  } catch (e) {
    return;
  }
  if (!status || !status.batch || !status.batch.job_id) return;
  if (button) button.disabled = true;
  try {
    await follow(jobs, status.batch.job_id, statusEl);
  } finally {
    if (button) button.disabled = false;
  }
}

/**
 * Keep the rows' `preview` flags as the server makes and drops previews (SSE `preview`): a row whose flag changes
 * is drawn again, so its next player takes the new source (a player in use is kept).
 */
export function followPreviews(getPage, events) {
  let changes = new Map(); // path -> preview made (true) / dropped (false), since the last apply
  let cleared = false;
  let timer = null;
  const apply = () => {
    const page = getPage();
    if (!page) return;
    const [now, clear] = [changes, cleared];
    changes = new Map();
    cleared = false;
    const redraw = [];
    Object.entries(page.getItems()).forEach(([key, item]) => {
      const best = item && item.local && item.local.best;
      if (!best) return;
      const release = Array.isArray(best.tracks) && best.tracks.length > 0;
      const files = release ? best.tracks : best.path ? [best] : [];
      let touched = false;
      files.forEach((f) => {
        let v = f.preview === true;
        if (clear) v = false;
        if (now.has(f.path)) v = now.get(f.path);
        if (v !== (f.preview === true)) {
          f.preview = v;
          touched = true;
        }
      });
      if (!touched) return;
      if (release) best.preview = files.every((t) => t.preview === true); // a release's own: all of its tracks
      redraw.push(key);
    });
    redraw.forEach((k) => page.refreshRow(k));
  };
  events.on("preview", (ev) => {
    if (!ev || typeof ev !== "object") return;
    if (ev.cleared) {
      cleared = true;
      changes.clear(); // made before the clear: gone too
    } else if (ev.path && typeof ev.preview === "boolean") changes.set(ev.path, ev.preview);
    else return;
    clearTimeout(timer);
    timer = setTimeout(apply, 300);
  });
}

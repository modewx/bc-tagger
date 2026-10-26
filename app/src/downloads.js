// Downloading owned releases (Phase 4) with the user's Bandcamp downloader.
// Always a dry run first (which releases, where, in which format, what's
// skipped or refused), the user confirms, then the job; the state of each
// item or row ("t123", "a456" or "<batch>:<n>") arrives as SSE `download` events.

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { progressText } from "./jobs";

export const planDownload = (ids, scope) => apiJson("/api/download", { method: "POST", body: { ids, scope, dry_run: true } });
export const startDownload = (ids, scope) => apiJson("/api/download", { method: "POST", body: { ids, scope } });

const LABELS = {
  queued: "queued for download",
  downloading: "downloading…",
  done: "downloaded",
  skipped: "skipped",
  failed: "download failed",
};

// "download failed: not in your Bandcamp collection", "downloading…", …
export function stateLabel(d) {
  const label = LABELS[d.state] || d.state;
  return d.message && !["downloading", "queued"].includes(d.state) && d.message !== label ? `${label}: ${d.message}` : label;
}

// Live state per ref, from the server's events; onChange(d) for each one.
export function trackDownloads(events, onChange) {
  const state = {};
  events.on("download", (d) => {
    if (!d || !d.ref) return;
    state[d.ref] = d;
    onChange(d);
  });
  return state;
}

function reasons(items) {
  const counts = {};
  items.forEach((i) => (counts[i.message || i.state] = (counts[i.message || i.state] || 0) + 1));
  return Object.entries(counts)
    .map(([m, n]) => `${n} ${m}`)
    .join("; ");
}

// The confirm text for a plan: each release (its id is what the downloader
// is asked for) and what won't be downloaded, and why.
export function planText(plan) {
  const releases = plan.releases || [];
  const items = plan.items || [];
  const skipped = items.filter((i) => i.state === "skipped");
  const failed = items.filter((i) => i.state === "failed");
  const lines = [];
  if (releases.length) {
    lines.push(`Download ${releases.length} release${releases.length > 1 ? "s" : ""} → ${plan.destination} (${plan.format}):`);
    // The release's own item has its real title (the plan's may be a URL slug).
    const titleOf = (r) => ((items.find((i) => i.item_id === r.release) || {}).title || r.title);
    releases.slice(0, 30).forEach((r) => lines.push(`• ${[r.artist, titleOf(r)].filter(Boolean).join(" – ") || r.release}  [${r.release}]`));
    if (releases.length > 30) lines.push(`… and ${releases.length - 30} more`);
  }
  if (skipped.length) lines.push(`Skipped: ${reasons(skipped)}.`);
  if (failed.length) lines.push(`Not downloadable: ${reasons(failed)}.`);
  return { text: lines.join("\n"), releases: releases.length };
}

// Plan → confirm → download, with progress in statusEl. Returns the finished
// job, or null when nothing was started.
export async function downloadFlow(ids, scope, { jobs, statusEl }) {
  if (!ids.length) {
    statusEl.textContent = "Download: nothing to download (no owned item that isn't on your drive).";
    return null;
  }
  statusEl.textContent = "Download: checking what to download…";
  let plan;
  try {
    plan = await planDownload(ids, scope);
  } catch (e) {
    statusEl.textContent = `Download: ${e.message}`;
    return null;
  }
  const { text, releases } = planText(plan);
  if (!releases) {
    statusEl.textContent = `Download: nothing to download. ${text}`.trim();
    return null;
  }
  if (!confirm(text)) {
    statusEl.textContent = "";
    return null;
  }
  let job;
  try {
    const { job_id } = await startDownload(ids, scope);
    job = await jobs.watch(job_id, (j) => (statusEl.textContent = `Downloading: ${progressText(j)}`));
  } catch (e) {
    statusEl.textContent = `Download: ${e.message}`;
    return null;
  }
  const r = job.result || {};
  const done = (r.releases || []).filter((x) => x.ok).length;
  const failed = (r.releases || []).length - done;
  statusEl.textContent =
    job.status === "error"
      ? `Download failed: ${job.error || "error"}`
      : `Download: ${done} of ${(r.releases || []).length} releases downloaded${failed ? `, ${failed} failed` : ""}` +
        (r.stopped ? ` (stopped: ${r.stopped})` : "") +
        ".";
  return job;
}

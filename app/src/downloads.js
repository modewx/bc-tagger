// Downloading owned releases (Phase 4) with the user's Bandcamp downloader.
// A dry run first (which releases, where, in which format, what's skipped or
// refused), then the job right away: downloads only add files to the downloads
// folder, so there's nothing to confirm. The state of each item or row ("t123",
// "a456" or "<batch>:<n>") arrives as SSE `download` events.
//
// "Download File": the track itself when it was bought on its own, else its
// release. "Download Full Release" (fullRelease): the whole album or EP the
// track is on, which must be owned.

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { progressText } from "./jobs";

const downloadBody = (ids, scope, fullRelease, dryRun) => ({
  ids,
  scope,
  ...(fullRelease ? { full_release: true } : {}),
  ...(dryRun ? { dry_run: true } : {}),
});
export const planDownload = (ids, scope, fullRelease) => apiJson("/api/download", { method: "POST", body: downloadBody(ids, scope, fullRelease, true) });
export const startDownload = (ids, scope, fullRelease) => apiJson("/api/download", { method: "POST", body: downloadBody(ids, scope, fullRelease, false) });

// The album or EP a download of the whole release would fetch, when it's owned
// and isn't the item itself (album items have no separate full release).
export const fullReleaseOf = (owned, ownId) => {
  const release = owned && owned.status === "owned" ? owned.full_release : null;
  return release && release !== ownId ? release : null;
};

// "Download File" (owned): what it fetches, for its tooltip.
export const downloadFileTitle = (owned, isAlbum) =>
  isAlbum
    ? "Download this release from your Bandcamp collection into the downloads folder, then locate it"
    : owned && owned.track_owned
    ? "Download this track (bought on its own) into the downloads folder, then locate it"
    : "Download the release this track is on (it isn't owned on its own) into the downloads folder, then locate it";

// The "Download Full Releases" box next to "Download owned missing": when
// ticked, that button fetches each selected track's whole album or EP.
// Remembered in this browser, for both pages.
const FULL_KEY = "bc_download_full_releases";
export function fullReleasesToggle() {
  const label = document.createElement("label");
  label.className = "full-releases-toggle";
  label.title = "Download owned missing fetches the whole album or EP of each track (like Download Full Release on each)";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = "downloadFullReleases";
  try {
    box.checked = localStorage.getItem(FULL_KEY) === "1";
  } catch (e) {
    /* not remembered */
  }
  box.addEventListener("change", () => {
    try {
      localStorage.setItem(FULL_KEY, box.checked ? "1" : "0");
    } catch (e) {
      /* not remembered */
    }
  });
  label.append(box, " Download Full Releases");
  return { el: label, checked: () => box.checked };
}

const LABELS = {
  queued: "queued for download",
  downloading: "downloading…",
  done: "downloaded",
  skipped: "skipped",
  failed: "download failed",
};

// "download failed: not in your Bandcamp collection", "waiting to download …",
// "downloading 42 %", "retry 1/3: read timed out", "downloaded (after 1 retry: …)", …
export function stateLabel(d) {
  if ((d.state === "downloading" || d.state === "queued") && d.message) return d.message; // the server's plain progress
  if (d.state === "downloading" && d.percent != null) return `downloading ${Math.round(d.percent)} %`;
  if (d.state === "done" && /^downloaded/.test(d.message || "")) return d.message; // "downloaded again: …"
  const label = LABELS[d.state] || d.state;
  return d.message && !["downloading", "queued"].includes(d.state) && d.message !== label ? `${label}: ${d.message}` : label;
}

// A download that's having trouble (Bandcamp errors, retries): its note is amber.
export const troubled = (d) => !!d && d.state === "downloading" && /^(retry \d|Bandcamp error)/.test(d.message || "");

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

// A plan in one line for the status: the releases (named; the downloader is
// asked for their ids), where they go, and what won't be downloaded and why.
export function planText(plan) {
  const releases = plan.releases || [];
  const items = plan.items || [];
  const skipped = items.filter((i) => i.state === "skipped");
  const failed = items.filter((i) => i.state === "failed");
  const notes = [skipped.length ? `Skipped: ${reasons(skipped)}.` : "", failed.length ? `Not downloadable: ${reasons(failed)}.` : ""]
    .filter(Boolean)
    .join(" ");
  // The release's own item has its real title (the plan's may be a URL slug).
  const titleOf = (r) => ((items.find((i) => i.item_id === r.release) || {}).title || r.title);
  const names = releases.slice(0, 5).map((r) => [r.artist, titleOf(r)].filter(Boolean).join(" – ") || r.release);
  if (releases.length > 5) names.push(`… ${releases.length - 5} more`);
  const head = releases.length
    ? `${releases.length} release${releases.length > 1 ? "s" : ""} → ${plan.destination} (${plan.format}): ${names.join("; ")}.`
    : "";
  return { text: [head, notes].filter(Boolean).join(" "), notes, releases: releases.length };
}

// Plan → download, with progress in statusEl. Returns the finished job, or
// null when nothing was started.
export async function downloadFlow(ids, scope, { jobs, statusEl, fullRelease = false }) {
  if (!ids.length) {
    statusEl.textContent = "Download: nothing to download (no owned item that isn't on your drive).";
    return null;
  }
  statusEl.textContent = fullRelease ? "Download: checking the full releases…" : "Download: checking what to download…";
  let plan;
  try {
    plan = await planDownload(ids, scope, fullRelease);
  } catch (e) {
    statusEl.textContent = `Download: ${e.message}`;
    return null;
  }
  const { text, notes, releases } = planText(plan);
  if (!releases) {
    statusEl.textContent = `Download: nothing to download. ${text}`.trim();
    return null;
  }
  statusEl.textContent = `Downloading ${text}`;
  let job;
  try {
    const { job_id } = await startDownload(ids, scope, fullRelease);
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
        ` → ${plan.destination}.` +
        (notes ? ` ${notes}` : "");
  return job;
}

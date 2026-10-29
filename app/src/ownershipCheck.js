// Refreshing ownership: Tools → Refresh ownership, and first thing in "Download owned missing" (both pages), so
// items bought since the last check are downloaded too. Through the extension (this browser's Bandcamp session)
// when it's connected, else the server's cookie-file job. One refresh at a time: a click while one runs waits for
// it. The Download buttons also reuse one that finished in the last minute (kept per tab, across the collection
// and import pages), so repeated clicks don't each go to Bandcamp; Tools → Refresh ownership always checks again.

const KEY = "bc_ownership_refresh";
const REUSE_MS = 60000;
let running = null;

export const isChallenge = (error) => /bot check|Client Challenge/i.test(error || "");

const whenText = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleString();
};

async function run({ bridge, jobs }, onProgress) {
  if (bridge.connected) {
    onProgress({ status: "running", progress: { message: "fetching your Bandcamp collection via the extension" } });
    const result = await bridge.call("refreshOwnership", {}, 120000);
    return { status: "done", result };
  }
  return jobs.run("/api/ownership/refresh", {}, onProgress);
}

// A refresh that worked, or met the bot check (not asked again for a minute), within the last minute.
function recent() {
  try {
    const r = JSON.parse(sessionStorage.getItem(KEY) || "null");
    return r && Date.now() - r.at < REUSE_MS ? r.job : null;
  } catch (e) {
    return null;
  }
}

function remember(job) {
  try {
    if (job.status === "done" || isChallenge(job.error)) sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), job }));
    else sessionStorage.removeItem(KEY);
  } catch (e) {
    /* not kept: the next click checks again */
  }
}

/**
 * Refresh ownership; resolves with the finished job ({status: "done", result} or {status: "error", error}), never
 * rejects. `reuse`: a refresh from the last minute is answered at once ({..., reused: true}).
 * @param {object} ctx  {bridge, jobs}
 */
export function refreshOwnership(ctx, onProgress = () => {}, { reuse = false } = {}) {
  const done = reuse && recent();
  if (done) return Promise.resolve({ ...done, reused: true });
  if (!running) {
    running = run(ctx, onProgress)
      .catch((e) => ({ status: "error", error: e.message }))
      .then((job) => {
        running = null;
        remember(job);
        return job;
      });
  }
  return running;
}

/**
 * Before a download: refresh ownership (or reuse a recent refresh), saying so in the status line. Then `reread()`
 * reads the rows again (the Owned column shows the new state). Resolves with {stop} on a bot check (nothing more
 * goes to Bandcamp: no download), else with {failed: reason} when the stored ownership is used.
 */
export async function ownershipFirst(ctx, statusEl, reread) {
  statusEl.textContent = "Download: checking ownership on Bandcamp…";
  const job = await refreshOwnership(ctx, () => {}, { reuse: true });
  await reread();
  if (job.status === "done") return {};
  return isChallenge(job.error) ? { stop: job.error } : { failed: job.error || "error" };
}

// The newest ownership check among these rows' `owned` ({checked_at}), or null.
export function lastCheck(owneds) {
  const times = owneds.map((o) => o && o.checked_at).filter(Boolean).sort();
  return times.length ? times[times.length - 1] : null;
}

// For the status, when the refresh failed: what the download goes by instead.
export function staleNote(reason, checkedAt) {
  return `Couldn't refresh ownership (${reason}); ${checkedAt ? `using the check from ${whenText(checkedAt)}` : "no earlier check stored"}.`;
}

// The bot check: nothing downloaded, and the way on. (The reason's first sentence: what Bandcamp showed.)
export function challengeText(reason, checkedAt) {
  const what = reason.split(/(?<=\.)\s/)[0].replace(/\.?$/, ".");
  return (
    `Download: stopped, nothing downloaded. ${what} ` +
    (checkedAt ? `Ownership was last checked ${whenText(checkedAt)}. ` : "") +
    "Once Bandcamp lets you in again, use Tools → Refresh ownership, then Download."
  );
}

/**
 * Why none of the rows can be downloaded, with counts, e.g. "nothing to download: 3 not owned (ownership checked
 * 27/10/2026, 04:13:00), 2 already on your drive". Each row ({owned, located, other, unmatched}) counts once.
 */
export function nothingText(rows) {
  const n = { notOwned: 0, unknown: 0, located: 0, other: 0, unmatched: 0 };
  const notOwned = [];
  rows.forEach((r) => {
    if (r.other) n.other += 1;
    else if (r.unmatched) n.unmatched += 1;
    else if (r.located) n.located += 1;
    else if (r.owned && r.owned.status === "not_owned") {
      n.notOwned += 1;
      notOwned.push(r.owned);
    } else if (!r.owned || r.owned.status !== "owned") n.unknown += 1;
  });
  const checked = lastCheck(notOwned);
  const parts = [
    n.notOwned && `${n.notOwned} not owned${checked ? ` (ownership checked ${whenText(checked)})` : ""}`,
    n.unknown && `${n.unknown} with ownership unknown`,
    n.located && `${n.located} already on your drive`,
    n.unmatched && `${n.unmatched} not matched to a Bandcamp item`,
    n.other && `${n.other} not from Bandcamp`,
  ].filter(Boolean);
  return `Download: nothing to download${parts.length ? `: ${parts.join(", ")}` : " (nothing selected or shown)"}.`;
}

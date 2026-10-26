// "Look up in my browser" for an import: the server lists the Bandcamp
// requests its lookups need (searches and release pages); this page has the
// extension make them in the user's Chrome, paced by Settings → Bandcamp
// requests (parallel requests, spacing), and posts the answers back, which
// the server reads exactly like its own. Repeats until nothing is pending.
// A bot check makes the server stop the lookups; a 429/503 pauses them
// (resumable). Nothing here runs unless this page is open.

import { apiJson, limitsFromSettings } from "../../shared/datasource/HttpDataSource";

const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const lookupsState = (id) => apiJson(`/api/import/${enc(id)}/lookups?limit=20`);
const postAnswers = (id, results) => apiJson(`/api/import/${enc(id)}/lookups`, { method: "POST", body: { results } });

// state: {state: "waiting"|"done"|"stopped"|"paused"|"server", reason?, error?, pending, pending_count, done, total}
export async function runBrowserLookups(id, bridge, onProgress = () => {}) {
  const limits = await apiJson("/api/settings").then(limitsFromSettings, () => ({}));
  const parallel = Math.max(1, Math.min(4, Math.round(limits.concurrency || 2)));
  const spacing = Math.max(100, Math.round(limits.spacingMs || 400));
  let st = await lookupsState(id);
  onProgress(st);
  while (st.state === "waiting" && (st.pending || []).length) {
    if (!bridge.connected) {
      throw new Error("the extension isn't connected: open this page in the Chrome profile that has Bc Tagger");
    }
    const queue = st.pending.slice();
    const results = [];
    let stop = null;
    let nextStart = 0; // starts are at least `spacing` apart, across the parallel requests
    const worker = async () => {
      while (queue.length && !stop) {
        const wait = nextStart - Date.now();
        nextStart = Math.max(nextStart, Date.now()) + spacing;
        if (wait > 0) await sleep(wait);
        if (stop) return;
        const req = queue.shift();
        let r;
        try {
          r = await bridge.call("bandcampRequest", { method: req.method, url: req.url, body: req.body }, 30000);
        } catch (e) {
          stop = `the extension couldn't make the request: ${e.message}`;
          return;
        }
        results.push({ key: req.key, method: req.method, url: req.url, body: req.body, status: r.status, text: r.text || "" });
        if (r.challenge) stop = "challenge";
        else if (r.status === 429 || r.status === 503) stop = "rate_limited";
        onProgress({ ...st, fetching: results.length, of: st.pending.length });
      }
    };
    await Promise.all(Array.from({ length: parallel }, worker));
    if (results.length) st = await postAnswers(id, results); // the server stops / pauses on a challenge or 429
    onProgress(st);
    if (stop && !["challenge", "rate_limited"].includes(stop)) throw new Error(stop);
    if (stop) break;
  }
  return st;
}

export function lookupsText(st) {
  if (!st) return "";
  const n = st.total ? ` ${st.done || 0}/${st.total}` : "";
  if (st.state === "waiting") return `Looking up in your browser${n}${st.fetching ? ` (requests ${st.fetching}/${st.of})` : ""}…`;
  if (st.state === "done") return `Looked up in your browser${n}; locating files…`;
  if (st.state === "stopped") return `Stopped: ${st.error || "Bandcamp showed its bot check (“Client Challenge”) to your browser"}.`;
  if (st.state === "paused") return `Paused: ${st.error || "Bandcamp is rate-limiting"}. Resume later.`;
  return "";
}

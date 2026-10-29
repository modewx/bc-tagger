// A timing log of the tagger's actions (star, un-star, tags; on Bandcamp pages and the collection pages), for the
// popup's "Copy timings": from the action to the screen changing (measured by the page), the wait in the queue, the
// storage write and the server push, with the page type, its widgets and the open Bandcamp tabs. The last MAX
// entries, in memory and in chrome.storage.session (kept while the browser runs, across worker restarts). A few
// timestamps per action; nothing of the store is logged.
import { onFlush } from "./itemsStore";

const MAX = 100;
const KEY = "bcTimings";
let entries = null; // loaded from session storage on first use (once: calls meanwhile wait for the same read)
let loading = null;
let saveTimer = null;

async function all() {
  if (!entries) {
    loading =
      loading ||
      chrome.storage.session
        .get(KEY)
        .catch(() => ({}))
        .then((got) => (entries = entries || (Array.isArray(got[KEY]) ? got[KEY] : [])));
    await loading;
  }
  return entries;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.session.set({ [KEY]: entries }).catch(() => {}), 1000);
}

/** An action reached the worker: {opId, kind, page, widgets, ids}. */
export async function noteOp(op) {
  const list = await all();
  const entry = { ...op, at: Date.now() };
  list.push(entry);
  if (list.length > MAX) list.splice(0, list.length - MAX);
  chrome.tabs.query({ url: ["*://*.bandcamp.com/*"] }, (tabs) => {
    entry.bandcampTabs = (tabs || []).length;
    save();
  });
}

/** The page's own time, from the action to the screen showing it. */
export async function noteScreen(opId, screenMs) {
  const e = (await all()).find((x) => x.opId === opId);
  if (e) {
    e.screenMs = Math.round(screenMs);
    save();
  }
}

// A write: the actions it carried waited in the queue until it started.
onFlush(({ ms, startedAt }) => {
  (entries || []).forEach((e) => {
    if (e.writeMs == null && e.at <= startedAt) {
      e.queueMs = startedAt - e.at;
      e.writeMs = ms;
    }
  });
  save();
});

/** A push to the server of these items: its own time, and since each action. */
export function notePush(ids, start, end, error = null) {
  const sent = new Set(ids);
  (entries || []).forEach((e) => {
    if (e.pushMs == null && (e.ids || []).some((id) => sent.has(id))) {
      e.pushMs = end - start;
      e.pushedAfterMs = end - e.at;
      if (error) e.pushError = error;
    }
  });
  save();
}

const pad = (s, n) => String(s).padEnd(n);
const ms = (v) => (v == null ? "-" : `${v} ms`);

/** The log as text, oldest first. */
export async function timingsText() {
  const list = await all();
  const head = `bc-tagger timings (${list.length}): action | page | widgets | Bandcamp tabs | on screen | queue | write | push (after)`;
  const lines = list.map((e) =>
    [
      new Date(e.at).toISOString().replace("T", " ").slice(0, 19),
      pad(e.kind, 7),
      pad(e.page || "?", 10),
      `widgets ${e.widgets ?? "-"}`,
      `tabs ${e.bandcampTabs ?? "-"}`,
      `screen ${ms(e.screenMs)}`,
      `queue ${ms(e.queueMs)}`,
      `write ${ms(e.writeMs)}`,
      `push ${ms(e.pushMs)}${e.pushedAfterMs != null ? ` (${e.pushedAfterMs} ms after)` : ""}${e.pushError ? ` error: ${e.pushError}` : ""}`,
    ].join(" | ")
  );
  return [head, ...lines].join("\n");
}

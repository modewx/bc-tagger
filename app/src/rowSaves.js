// Saving an import's row edits (ticks, tags) so that none is ever lost: one request per action (A's bulk
// `PUT /api/import/<id>/rows {ns, changes}`; a server without it gets one PUT per row, a few at a time), tried
// again while it fails for a reason that passes (no answer, 5xx), and kept in localStorage until the server has
// it. A reload (or a crash) before then shows the edits from there and sends them again; leaving with edits not
// saved asks first. An edit the server refuses (the row or the batch isn't there) is dropped and said.

import { apiJson } from "../../shared/datasource/HttpDataSource";

const RETRY_MS = [1000, 2000, 5000, 10000, 30000];
const PARALLEL = 6; // per-row saves at once, without the bulk form
const enc = encodeURIComponent;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const transient = (e) => !e.status || e.status >= 500 || e.status === 408 || e.status === 429;

/**
 * @param {string} batchId
 * @param {(s: {state: "saving"|"saved"|"retrying"|"failed", pending: number, error?: string, retryAt?: number}) => void} onState
 */
export function createRowSaves(batchId, onState = () => {}) {
  const KEY = `bc_import_pending:${batchId}`;
  const pending = new Map(); // row n -> {checked?, tags?}: what the server doesn't have yet
  try {
    Object.entries(JSON.parse(localStorage.getItem(KEY) || "{}")).forEach(([n, p]) => pending.set(Number(n), p));
  } catch (e) {
    /* nothing kept */
  }
  let bulk = true; // until the server says it has no bulk form
  let current = null; // the run under way
  let again = false;
  let attempt = 0;
  let timer = null;
  let retryAt = 0;
  let error = null; // why edits are waiting (transient) or were dropped (refused)
  let waiters = []; // save() promises: {left: Set<n>, changes, resolve, error}

  function persist() {
    try {
      if (pending.size) localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(pending)));
      else localStorage.removeItem(KEY);
    } catch (e) {
      /* the page still saves */
    }
  }

  function report() {
    if (error && pending.size && transient(error)) onState({ state: "retrying", pending: pending.size, error: error.message, retryAt });
    else if (current || pending.size) onState({ state: "saving", pending: pending.size });
    else if (error) onState({ state: "failed", pending: 0, error: error.message });
    else onState({ state: "saved", pending: 0 });
  }

  // Rows `ns` are done with `changes`: saved, or (refused) dropped. A save() waiting on them hears it.
  function done(ns, changes, refused = null) {
    ns.forEach((n) => {
      const p = pending.get(n);
      if (p) {
        Object.keys(changes).forEach((f) => same(p[f], changes[f]) && delete p[f]);
        if (!Object.keys(p).length) pending.delete(n);
      }
      waiters.forEach((w) => {
        if (!w.left.has(n) || !Object.keys(w.changes).every((f) => same(w.changes[f], changes[f]))) return;
        w.left.delete(n);
        if (refused) w.error = refused.message;
      });
    });
    persist();
    waiters = waiters.filter((w) => {
      if (w.left.size) return true;
      w.resolve(w.error ? { ok: false, error: w.error } : { ok: true });
      return false;
    });
  }

  async function send(ns, changes) {
    if (bulk) {
      try {
        await apiJson(`/api/import/${enc(batchId)}/rows`, { method: "PUT", body: { ns, changes } });
        return done(ns, changes);
      } catch (e) {
        // No bulk form here (or not this one): one row at a time.
        if (![404, 405, 422].includes(e.status)) throw e;
        bulk = false;
      }
    }
    const queue = ns.slice();
    let failed = null;
    const worker = async () => {
      while (queue.length && !(failed && transient(failed))) {
        const n = queue.shift();
        try {
          await apiJson(`/api/import/${enc(batchId)}/rows/${enc(n)}`, { method: "PUT", body: changes });
          done([n], changes);
        } catch (e) {
          if (transient(e)) failed = e;
          else {
            done([n], changes, e);
            failed = failed || e;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
    if (failed) throw failed;
  }

  async function pass() {
    do {
      again = false;
      // Rows with the same changes go together (a tick on 300 rows: one request).
      const groups = new Map();
      pending.forEach((p, n) => {
        const k = JSON.stringify(p);
        if (!groups.has(k)) groups.set(k, { ns: [], changes: { ...p } });
        groups.get(k).ns.push(n);
      });
      let failed = null;
      for (const { ns, changes } of groups.values()) {
        try {
          await send(ns, changes);
        } catch (e) {
          if (transient(e)) throw e; // the server is away: all of it later
          if (bulk) done(ns, changes, e); // (per row, send() dropped them one by one)
          failed = failed || e;
        }
      }
      error = failed;
    } while (again);
  }

  function run() {
    if (current) {
      again = true;
      return current;
    }
    clearTimeout(timer);
    retryAt = 0;
    current = pass()
      .then(() => (attempt = 0))
      .catch((e) => {
        error = e;
        const wait = RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)];
        retryAt = Date.now() + wait;
        timer = setTimeout(run, wait);
      })
      .finally(() => {
        current = null;
        report();
      });
    report();
    return current;
  }

  window.addEventListener("beforeunload", (e) => {
    if (!pending.size) return;
    e.preventDefault();
    e.returnValue = ""; // "Leave site? Changes you made may not be saved."
  });
  window.addEventListener("online", () => pending.size && run());
  if (pending.size) setTimeout(run, 0); // left before the server had them: again

  return {
    /** Save `changes` ({checked} / {tags}) for rows `ns`: resolves {ok: true} once the server has them, or
     *  {ok: false, error} if it refused; while the server can't be reached it keeps trying. */
    save(ns, changes) {
      // An earlier save of the same rows and fields: superseded (only the latest goes).
      waiters.forEach((w) => ns.forEach((n) => Object.keys(changes).some((f) => f in w.changes) && w.left.delete(n)));
      waiters = waiters.filter((w) => w.left.size || (w.resolve(w.error ? { ok: false, error: w.error } : { ok: true }), false));
      ns.forEach((n) => pending.set(n, { ...(pending.get(n) || {}), ...changes }));
      persist();
      const p = new Promise((resolve) => waiters.push({ left: new Set(ns), changes, resolve, error: null }));
      run();
      return p;
    },
    /** The edits not saved yet, over rows just read from the server (so a reload doesn't undo them). */
    overlay(rows) {
      rows.forEach((r) => pending.has(r.n) && Object.assign(r, pending.get(r.n)));
      return rows;
    },
    /** Everything saved now, or throws why not. */
    async flush() {
      if (!pending.size && !current) return;
      await run();
      if (pending.size) throw new Error(`${pending.size} row${pending.size > 1 ? "s" : ""} not saved yet${error ? ` (${error.message})` : ""}`);
    },
    retry: () => run(),
    pending: () => pending.size,
    /** Forget this batch's unsaved edits (it's discarded). */
    clear() {
      [...pending.keys()].forEach((n) => done([n], pending.get(n)));
      clearTimeout(timer);
      error = null;
      report();
    },
  };
}

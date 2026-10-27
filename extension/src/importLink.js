// "Link this page to an import row" (Phase 3). For the tagger widgets on an
// album or track page, the local server says which rows of open imports fit
// each item (POST /api/import/link-candidates, one request for the page's items:
// the row's Bandcamp link from the file is this page or its album, or artist +
// title agree). Items with
// fitting rows get a "Link to import" button: pick the row, and the page's item
// (the same data the ☆ saves) goes to the server (POST …/rows/<n>/link).
// Linked as soon as the page opens: a row whose pasted URL is this page
// (GET /api/import/open-rows), and a row whose file link is this page, when
// it has no Bandcamp item yet and clearly fits one item here.
// Nothing here fetches from Bandcamp: it only reads the page the user is on.

const AUTO_SCORE = 0.8;
const VIA = { collection: "in your collection", resolved: "found", chosen: "picked", linked: "linked" };

function send(msg) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError;
      resolve(res || { ok: false, error: "no answer from the extension" });
    })
  );
}

const rowKey = (row) => `${row.batch_id}/${row.n}`;

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function pageKey(u) {
  try {
    const x = new URL(u, location.href);
    return `${x.host}${x.pathname.replace(/\/$/, "")}`;
  } catch (e) {
    return null;
  }
}

function rowLabel(row) {
  const what = [row.artist, row.title].filter(Boolean).join(" – ") || `row ${row.n + 1}`;
  return `${what}${row.album ? ` (${row.album})` : ""}`;
}

function notice(text) {
  let box = document.getElementById("bct-import-notice");
  if (!box) {
    box = document.createElement("div");
    box.id = "bct-import-notice";
    document.body.appendChild(box);
  }
  const line = document.createElement("div");
  line.textContent = text;
  box.appendChild(line);
}

const pageUrl = location.href.split(/[?#]/)[0];
const linked = new Set(); // rows linked from this page view
const LINK_BATCH_MS = 300;
let queued = [];
let waiting = null; // {timer, done, resolve}: the targets waiting to be asked about
let asking = Promise.resolve();
let firstBatch = true;

/**
 * Asks the server about the targets in one request: these, and any added within
 * LINK_BATCH_MS (e.g. items that show up later on the page).
 * @param {{container: HTMLElement, item: object}[]} targets  tagger widgets and their items
 */
export function setupImportLinks(targets) {
  queued.push(...targets);
  if (!waiting) {
    let resolve;
    waiting = { done: new Promise((r) => (resolve = r)), resolve };
  }
  const w = waiting;
  clearTimeout(w.timer);
  w.timer = setTimeout(() => {
    waiting = null;
    const batch = queued.splice(0);
    asking = asking.then(() => linkTargets(batch)).then(w.resolve, (e) => {
      console.warn("[bc-tagger] import links", e);
      w.resolve();
    });
  }, LINK_BATCH_MS);
  return w.done;
}

async function linkTargets(targets) {
  const usable = targets.filter(({ container, item }) => container && item && /^[at]\d+$/.test(String(item.id || "")));
  if (!usable.length) return;
  // Rows whose pasted URL is this page: once per page view.
  let pasted = [];
  if (firstBatch) {
    firstBatch = false;
    const open = await send({ type: "importOpenRows" });
    pasted = (open.ok && Array.isArray(open.rows) ? open.rows : []).filter((r) => r.match_url && pageKey(r.match_url) === pageKey(pageUrl));
  }
  const res = await send({ type: "importLinkCandidates", items: usable.map((t) => t.item), page_url: pageUrl });
  const results = res.ok && Array.isArray(res.results) ? res.results : [];
  const asked = usable.map((t, i) => ({ ...t, rows: Array.isArray(results[i]) ? results[i] : [] }));
  const withRows = asked.filter((t) => t.rows.length);
  if (!withRows.length && !pasted.length) return;

  async function link(row, item, button) {
    const r = await send({ type: "linkImportRow", batch_id: row.batch_id, n: row.n, item, page_url: pageUrl });
    if (!r.ok) {
      notice(`bc-tagger: couldn't link ${rowLabel(row)}: ${r.error}`);
      return false;
    }
    linked.add(rowKey(row));
    if (button) {
      button.textContent = `Linked ✓ ${rowLabel(row)}`;
      button.disabled = true;
    }
    notice(`bc-tagger: linked this page's “${item.title}” to the import row ${rowLabel(row)}${row.batch_name ? ` (${row.batch_name})` : ""}.`);
    return true;
  }

  function menu(button, item, rows) {
    document.querySelectorAll(".bct-link-menu").forEach((m) => m.remove());
    const m = document.createElement("div");
    m.className = "bct-link-menu";
    const head = document.createElement("div");
    head.className = "bct-link-head";
    head.textContent = `Link “${item.title}” to an import row:`;
    m.appendChild(head);
    rows
      .filter((row) => !linked.has(rowKey(row)))
      .forEach((row) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "bct-link-row" + (row.hint_match || row.score >= AUTO_SCORE ? " likely" : "");
        const now = row.via ? ` · now: ${VIA[row.via] || row.via}` : "";
        b.textContent = `${rowLabel(row)}${row.batch_name ? ` · ${row.batch_name}` : ""}${now}`;
        b.addEventListener("click", async (e) => {
          e.stopPropagation();
          m.remove();
          await link(row, item, button);
        });
        m.appendChild(b);
      });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "bct-link-close";
    close.textContent = "Cancel";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      m.remove();
    });
    m.appendChild(close);
    button.after(m);
  }

  // Pasted URLs: the one track here with the row's title (or the page's only item).
  for (const row of pasted) {
    const tracks = usable.filter(({ item }) => item.tralbum_type === "t");
    const fits = tracks.filter(({ item }) => norm(item.title) && norm(item.title) === norm(row.title));
    const only = fits.length === 1 ? fits[0] : usable.length === 1 ? usable[0] : null;
    if (only) await link(row, only.item, null);
    else notice(`bc-tagger: the import row ${rowLabel(row)} has this page's URL: use “Link to import” on its track.`);
  }

  // Rows whose file link is this page: link the one item that clearly fits.
  const autoFor = new Map(); // row key -> [{row, target}]
  withRows.forEach((t) =>
    t.rows
      .filter((row) => row.hint_match && !row.bandcamp_id && row.score >= AUTO_SCORE)
      .forEach((row) => autoFor.set(rowKey(row), [...(autoFor.get(rowKey(row)) || []), { row, target: t }]))
  );
  for (const hits of autoFor.values()) {
    if (hits.length === 1 && !linked.has(rowKey(hits[0].row))) await link(hits[0].row, hits[0].target.item, null);
  }

  withRows.forEach(({ container, item, rows }) => {
    if (rows.every((row) => linked.has(rowKey(row)))) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "bct-link-btn";
    b.textContent = "Link to import";
    b.title = "Link this item to a row of an import waiting in bc-tagger";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!b.disabled) menu(b, item, rows);
    });
    container.appendChild(b);
  });
}

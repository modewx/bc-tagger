// "Link this page to an import row" (Phase 3). For each tagger widget on an
// album or track page, the local server says which rows of open imports fit
// the page's item (POST /api/import/link-candidates: the row's Bandcamp link
// from the file is this page or its album, or artist + title agree). Items with
// fitting rows get a "Link to import" button: pick the row, and the page's item
// (the same data the ☆ saves) goes to the server (POST …/rows/<n>/link).
// A row whose file link is this page, with no Bandcamp item yet and clearly
// fitting one item here, is linked as soon as the page opens.
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

/**
 * @param {{container: HTMLElement, item: object}[]} targets  the page's tagger widgets and their items
 */
export async function setupImportLinks(targets) {
  const pageUrl = location.href.split(/[?#]/)[0];
  const usable = targets.filter(({ container, item }) => container && item && /^[at]\d+$/.test(String(item.id || "")));
  if (!usable.length) return;
  const asked = await Promise.all(
    usable.map(async (t) => {
      const res = await send({ type: "importLinkCandidates", item: t.item, page_url: pageUrl });
      return { ...t, rows: res.ok && Array.isArray(res.rows) ? res.rows : [] };
    })
  );
  const withRows = asked.filter((t) => t.rows.length);
  if (!withRows.length) return;
  const linked = new Set();

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

  // Rows whose file link is this page: link the one item that clearly fits.
  const autoFor = new Map(); // row key -> [{row, target}]
  withRows.forEach((t) =>
    t.rows
      .filter((row) => row.hint_match && !row.bandcamp_id && row.score >= AUTO_SCORE)
      .forEach((row) => autoFor.set(rowKey(row), [...(autoFor.get(rowKey(row)) || []), { row, target: t }]))
  );
  for (const hits of autoFor.values()) {
    if (hits.length === 1) await link(hits[0].row, hits[0].target.item, null);
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

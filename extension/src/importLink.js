// "Link this page to an import row" (Phase 3). When the local server has
// imports with rows still waiting for their Bandcamp page, each tagger widget
// on an album or track page gets a "Link to import" button: pick the row, and
// the page's item (the same data the ☆ saves) goes to the server, which marks
// the row matched. A row whose pasted URL is this page is linked as soon as
// the user opens it, when exactly one item on the page fits the row.
// Nothing here fetches from Bandcamp: it only reads the page the user is on.

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function cleanUrl(u) {
  try {
    const x = new URL(u, location.href);
    return `https://${x.host}${x.pathname.replace(/\/$/, "")}`;
  } catch (e) {
    return null;
  }
}

function send(msg) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError;
      resolve(res || { ok: false, error: "no answer from the extension" });
    })
  );
}

function rowLabel(row) {
  const where = [row.album, row.position || (row.track_num != null ? `#${row.track_num}` : null)].filter(Boolean).join(" · ");
  return `line ${row.line ?? "?"}: ${[row.artist, row.title].filter(Boolean).join(" – ")}${where ? ` (${where})` : ""}`;
}

// How well an import row fits a page item (higher is better).
function fit(row, item, pageUrl) {
  let s = 0;
  const rowUrls = [row.match_url, row.hint].map(cleanUrl).filter(Boolean);
  const itemUrls = [item.url, item.item_url, item.album_url, pageUrl].map(cleanUrl).filter(Boolean);
  if (rowUrls.some((u) => itemUrls.includes(u))) s += 2;
  if (norm(row.title) && norm(row.title) === norm(item.title)) s += 4;
  if (row.track_num != null && row.track_num === item.track_num) s += 1;
  if (norm(row.artist) && norm(row.artist) === norm(item.artist)) s += 1;
  if (item.tralbum_type === "a") s -= 1; // rows are tracks
  return s;
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
  if (!targets.length) return;
  const res = await send({ type: "importRows" });
  if (!res.ok || !Array.isArray(res.rows) || !res.rows.length) return;
  let open = res.rows;
  const pageUrl = cleanUrl(location.href);
  const buttons = [];

  async function link(row, item, button) {
    const r = await send({ type: "linkImportRow", batch_id: row.batch_id, n: row.n, item });
    if (!r.ok) {
      notice(`bc-tagger: couldn't link ${rowLabel(row)}: ${r.error}`);
      return false;
    }
    open = open.filter((x) => !(x.batch_id === row.batch_id && x.n === row.n));
    if (button) {
      button.textContent = `Linked ✓ ${rowLabel(row)}`;
      button.disabled = true;
    }
    notice(`bc-tagger: linked this page's “${item.title}” to import row ${rowLabel(row)}.`);
    if (!open.length) buttons.forEach((b) => !b.disabled && b.remove());
    return true;
  }

  function menu(button, item) {
    document.querySelectorAll(".bct-link-menu").forEach((m) => m.remove());
    const m = document.createElement("div");
    m.className = "bct-link-menu";
    const ranked = open
      .map((row) => ({ row, s: fit(row, item, pageUrl) }))
      .sort((a, b) => b.s - a.s || (a.row.line ?? 0) - (b.row.line ?? 0))
      .slice(0, 40);
    const head = document.createElement("div");
    head.className = "bct-link-head";
    head.textContent = `Link “${item.title}” to an import row:`;
    m.appendChild(head);
    ranked.forEach(({ row, s }) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "bct-link-row" + (s >= 4 ? " likely" : "");
      b.textContent = rowLabel(row) + (row.batch_name ? ` · ${row.batch_name}` : "");
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

  // Pasted URLs: the row's page is this one.
  for (const row of open.filter((r) => cleanUrl(r.match_url) === pageUrl)) {
    const fits = targets.filter(({ item }) => item.tralbum_type === "t" && fit(row, item, pageUrl) >= 6);
    const only = fits.length === 1 ? fits[0] : targets.length === 1 ? targets[0] : null;
    if (only) await link(row, only.item, null);
    else notice(`bc-tagger: import row ${rowLabel(row)} has this page's URL: use “Link to import” on its track.`);
  }
  if (!open.length) return;

  targets.forEach(({ container, item }) => {
    if (!container || !item || !item.id) return;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "bct-link-btn";
    b.textContent = "Link to import";
    b.title = "Link this item to a row of an import waiting in bc-tagger";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!b.disabled) menu(b, item);
    });
    container.appendChild(b);
    buttons.push(b);
  });
}

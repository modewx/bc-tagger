// Import page: preview an Export file against current storage, then let the
// background script merge it in (see importData in background.js).

const fileInput = document.getElementById("file");
const summary = document.getElementById("summary");
const modes = document.getElementById("modes");
const importBtn = document.getElementById("import");
const result = document.getElementById("result");
const collectionLink = document.getElementById("openCollection");

document.getElementById("title").textContent = `Import into ${chrome.runtime.getManifest().name}`;

let data = null;

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function show(el, text, cls) {
  el.hidden = false;
  el.textContent = text;
  el.className = `box ${cls || ""}`;
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

// An order file ({format: "bc-tagger-order/1", order: [ids]}) only sets "#".
const isOrderFile = (d) => !!d && Array.isArray(d.order) && !d.taggedItems;

async function preview() {
  const existing = (await send({ type: "getTaggedItems" })) || {};
  if (selectedMode() === "order") {
    const ids = isOrderFile(data) ? data.order : Object.keys(data.taggedItems);
    const listed = ids.filter((id) => id in existing).length;
    show(
      summary,
      [
        `File: ${ids.length} items in order.`,
        `Here now: ${Object.keys(existing).length} items.`,
        `→ ${listed} get their "#" from the file; ${Object.keys(existing).length - listed} others go after, in their current order. Nothing else changes.`,
      ].join("\n")
    );
    return;
  }
  const incoming = data.taggedItems;
  const ids = Object.keys(incoming);
  const both = ids.filter((id) => id in existing);
  const differ = both.filter((id) => JSON.stringify(existing[id].tags || []) !== JSON.stringify(incoming[id].tags || []));
  const onlyHere = Object.keys(existing).filter((id) => !(id in incoming));
  const mode = selectedMode();
  const lines = [
    `File: ${ids.length} items, ${(data.tags || []).length} tags.`,
    `Here now: ${Object.keys(existing).length} items.`,
    `New from the file: ${ids.length - both.length}. In both: ${both.length} (${differ.length} with different tags).`,
  ];
  if (mode === "merge" && differ.length) lines.push(`→ ${differ.length} items here will take the file's tags.`);
  if (mode === "keep" && differ.length) lines.push(`→ ${differ.length} items keep their current tags.`);
  if (mode === "replace" && onlyHere.length) lines.push(`→ ${onlyHere.length} items only here will be DELETED.`);
  show(summary, lines.join("\n"), mode === "replace" && onlyHere.length ? "warn" : "");
}

fileInput.addEventListener("change", async () => {
  data = null;
  importBtn.disabled = true;
  result.hidden = true;
  const file = fileInput.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const orderOnly = isOrderFile(parsed);
    if (!orderOnly && (!parsed || typeof parsed.taggedItems !== "object" || Array.isArray(parsed.taggedItems))) {
      throw new Error("this is not a Bc Tagger export (no taggedItems) or order file");
    }
    data = parsed;
    // An order file has no items: only "Set the # order only" can use it.
    document.querySelectorAll('input[name="mode"]').forEach((r) => (r.disabled = orderOnly && r.value !== "order"));
    if (orderOnly) document.querySelector('input[name="mode"][value="order"]').checked = true;
    modes.hidden = false;
    await preview();
    importBtn.disabled = false;
  } catch (e) {
    modes.hidden = true;
    show(summary, `Can't use this file: ${e.message}`, "err");
  }
});

modes.addEventListener("change", () => data && preview());

importBtn.addEventListener("click", async () => {
  const mode = selectedMode();
  if (mode === "replace" && !confirm("Replace all items in this extension with the file's items?")) return;
  importBtn.disabled = true;
  const res = await send({ type: "importData", data, mode });
  if (res && res.ok && mode === "order") {
    show(result, `"#" set for ${res.numbered} items from the file; ${res.after} others after them.`, "ok");
    collectionLink.hidden = false;
    await preview();
  } else if (res && res.ok) {
    show(result, `Imported. Storage now has ${res.items} items and ${res.tags} tags.`, "ok");
    collectionLink.hidden = false;
    await preview();
  } else {
    show(result, `Import failed: ${(res && res.error) || chrome.runtime.lastError?.message || "unknown error"}`, "err");
    importBtn.disabled = false;
  }
});

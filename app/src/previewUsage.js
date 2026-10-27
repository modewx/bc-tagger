// Settings → Previews: what the previews take (of their space, and of this Mac's free space), a build or the
// background work under way, and Clear previews (asks first). Follows the server's `preview` events.

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { pageEvents } from "../../shared/datasource/serverEvents";
import { confirmDialog } from "./dialog";
import { fmtBytes } from "./previewBuild";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const basename = (p) => String(p || "").split("/").pop();

export function createPreviewUsage(parent) {
  const box = el("div", "preview-usage");
  box.id = "previewUsage";
  const lines = el("div", "pu-lines");
  lines.id = "previewUsageText";
  const clear = el("button", "secondary danger", "Clear previews");
  clear.type = "button";
  clear.id = "clearPreviews";
  const note = el("span", "pu-note");
  note.id = "previewClearState";
  box.append(el("h3", "", "Usage"), lines, el("div", "pu-actions"));
  box.lastChild.append(clear, note);
  parent.appendChild(box);

  let status = null;
  async function refresh() {
    try {
      status = await apiJson("/api/previews/status");
    } catch (e) {
      lines.textContent = `Not available: ${e.message}`;
      clear.disabled = true;
      return;
    }
    const s = status;
    lines.innerHTML = "";
    const line = (text, cls) => lines.appendChild(el("p", cls, text));
    line(
      s.cap_bytes > 0
        ? `${plural(s.count, "preview")}: ${fmtBytes(s.bytes)} of ${fmtBytes(s.cap_bytes)}.`
        : `${plural(s.count, "preview")} (${fmtBytes(s.bytes)}). Previews are off (0 GB).`
    );
    line(`Free on this Mac: ${fmtBytes(s.free_bytes)}. No preview is written when that would drop below ${fmtBytes(s.min_free_bytes)}.`, "muted");
    if (s.skipped_low_space) {
      const last = s.last_skip && (typeof s.last_skip === "string" ? s.last_skip : basename(s.last_skip.path));
      line(`${plural(s.skipped_low_space, "preview")} skipped for lack of space${last ? ` (the last: ${last})` : ""}.`, "err");
    }
    if (s.batch) line(`Building: ${s.batch.built || 0}/${s.batch.total || 0} (follow it in the collection).`);
    else if (s.building || s.queued) line(`In the background: ${s.building || 0} being made, ${s.queued || 0} queued.`, "muted");
    clear.disabled = !s.count && !s.batch;
  }

  clear.addEventListener("click", async () => {
    const s = status || { count: 0, bytes: 0 };
    const ok = await confirmDialog({
      id: "clearPreviewsConfirm",
      danger: true,
      title: "Clear all previews?",
      body:
        `Deletes the ${plural(s.count, "preview")} (${fmtBytes(s.bytes)}) from this Mac${s.batch ? ", and stops the build under way" : ""}. ` +
        "Tracks then play from the music drive until previews are made again.",
      confirmLabel: "Clear previews",
    });
    if (!ok) return;
    clear.disabled = true;
    note.className = "pu-note";
    note.textContent = "Clearing…";
    try {
      const r = await apiJson("/api/previews", { method: "DELETE" });
      note.textContent = `Cleared: ${plural(r.deleted || 0, "preview")} (${fmtBytes(r.bytes)}).`;
    } catch (e) {
      note.className = "pu-note err";
      note.textContent = `Not cleared: ${e.message}`;
    }
    await refresh();
  });

  let t = null;
  pageEvents()
    .on("preview", () => {
      clearTimeout(t);
      t = setTimeout(refresh, 500);
    })
    .start();
  refresh();
  return { refresh };
}

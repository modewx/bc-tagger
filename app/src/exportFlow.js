// Every export to rekordbox goes through here. When the target is the user's
// MAIN library (or the caller asks), it runs a dry run first, shows the diff
// (playlists to create, tracks to add, entries per playlist) and writes only
// after the user confirms, passing the server's confirm_token back.

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { confirmDialog } from "./dialog";

const count = (v) => (Array.isArray(v) ? v.length : Number(v) || 0);
const base = (p) => String(p || "").split("/").pop();

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// A collapsible list (shows the first `max` entries).
function listBlock(title, entries, render, max = 40) {
  const d = el("details");
  d.appendChild(el("summary", `${title} (${entries.length})`));
  const ul = el("ul");
  entries.slice(0, max).forEach((x) => ul.appendChild(el("li", render(x))));
  if (entries.length > max) ul.appendChild(el("li", `… and ${entries.length - max} more`, "muted"));
  d.appendChild(ul);
  return d;
}

// Tracks not added because their playlist already holds the same song as another
// file (the server's entries_same_song), by playlist, with both files.
function sameSongBlock(entries) {
  const block = el("details", null, "same-song");
  block.open = true;
  block.appendChild(el("summary", `Already in the playlist as another file (${entries.length})`));
  const byPlaylist = new Map();
  entries.forEach((e) => byPlaylist.set(e.playlist, [...(byPlaylist.get(e.playlist) || []), e]));
  const ul = el("ul");
  byPlaylist.forEach((list, playlist) => {
    const li = el("li", playlist);
    const songs = el("ul");
    list.forEach((e) => {
      const song = [e.artist, e.title].filter(Boolean).join(" – ") || base(e.path);
      const x = el("li", `${song}: ${e.message || "already in playlist (other file)"}`);
      x.appendChild(el("div", `this file: ${e.path}`, "muted same-song-path"));
      x.appendChild(el("div", `in the playlist: ${(e.existing && e.existing.path) || "?"}`, "muted same-song-path"));
      songs.appendChild(x);
    });
    li.appendChild(songs);
    ul.appendChild(li);
  });
  block.appendChild(ul);
  return block;
}

// Messages of everything that would make the write fail. `blockers` comes
// from the server; `errors` (playlist mapping problems) predates it.
function blockersOf(d) {
  const list = (Array.isArray(d.blockers) ? d.blockers : []).map((b) => (typeof b === "string" ? b : b.message || b.code));
  if (!list.length && Array.isArray(d.errors)) list.push(...d.errors);
  return list;
}

// The dry-run diff as dialog content.
export function diffView(d, target) {
  const wrap = el("div");
  if (target === "main") {
    wrap.appendChild(el("div", "This writes to your MAIN rekordbox library. Quit rekordbox first.", "warn-box"));
  }
  wrap.appendChild(el("p", d.db_path || "", "muted"));
  // Blockers make the write fail (rekordbox running, test library switched in,
  // playlist errors, ...): shown first, and the confirm button stays disabled.
  const blockers = blockersOf(d);
  if (blockers.length) {
    const box = el("div", null, "warn-box blockers");
    box.appendChild(el("strong", "Can't write yet:"));
    const ul = el("ul");
    blockers.forEach((b) => ul.appendChild(el("li", b)));
    box.appendChild(ul);
    // The main library with writes locked: say where to allow them.
    if ((Array.isArray(d.blockers) ? d.blockers : []).some((b) => b && b.code === "main_writes_locked")) {
      const a = el("a", "Allow writes to your main collection in Settings → Rekordbox →");
      a.href = "/settings/#rekordbox";
      a.target = "_blank";
      a.className = "allow-writes-link";
      box.appendChild(a);
    }
    wrap.appendChild(box);
  }
  (Array.isArray(d.warnings) ? d.warnings : []).forEach((w) =>
    wrap.appendChild(el("p", "⚠ " + (typeof w === "string" ? w : w.message || w.code), "muted"))
  );
  // Entry totals: from per_playlist when the server sends it.
  const per = Array.isArray(d.per_playlist) && d.per_playlist.length ? d.per_playlist : null;
  const added = per ? per.reduce((n, p) => n + count(p.add), 0) : count(d.entries_added);
  const removed = per ? per.reduce((n, p) => n + count(p.remove), 0) : count(d.entries_removed);
  const ul = el("ul");
  [
    `${count(d.content_added)} tracks added to rekordbox's collection (${count(d.content_existing)} already there)`,
    `${count(d.playlists_created)} new playlists` +
      (count(d.folders_created) ? `, ${count(d.folders_created)} new folders` : d.folder && d.folder.created ? ` and the folder "${d.folder.name}"` : ""),
    `${added} playlist entries added, ${removed} removed`,
  ].forEach((t) => ul.appendChild(el("li", t)));
  if (count(d.skipped_items)) ul.appendChild(el("li", `${count(d.skipped_items)} items skipped (not located)`));
  if (count(d.failed_files)) ul.appendChild(el("li", `${count(d.failed_files)} files rekordbox can't take`));
  wrap.appendChild(ul);
  if (count(d.entries_same_song)) wrap.appendChild(sameSongBlock(d.entries_same_song));

  // Where each tag goes (the tag → playlist mapping): new tags and tags that aren't exported pointed out,
  // with a link to map them.
  const tp = Array.isArray(d.tag_playlists) ? d.tag_playlists : [];
  if (tp.length) {
    const block = listBlock("Tags → playlists", tp, (t) =>
      `${t.tag}${t.new ? " (new tag)" : ""} → ${(t.playlists || []).length ? t.playlists.join(", ") : "not exported (no playlist)"}`
    );
    block.classList.add("tag-playlists");
    const toMap = tp.filter((t) => t.new || !(t.playlists || []).length).map((t) => t.tag);
    if (toMap.length) {
      const a = el("a", "Map these tags in Settings →");
      a.href = `/settings/#rekordbox/${encodeURIComponent(`tags=${toMap.join(",")}`)}`;
      a.target = "_blank";
      a.className = "map-tags-link";
      block.appendChild(a);
      block.open = true;
    }
    wrap.appendChild(block);
  }

  if (Array.isArray(d.folders_created) && d.folders_created.length) {
    wrap.appendChild(listBlock("Folders to create", d.folders_created, (p) => p));
  }
  if (Array.isArray(d.playlists_created) && d.playlists_created.length) {
    wrap.appendChild(listBlock("Playlists to create", d.playlists_created, (p) => (typeof p === "string" ? p : p.path || p.name)));
  }
  if (Array.isArray(d.content_added) && d.content_added.length) {
    wrap.appendChild(
      listBlock("Tracks to add", d.content_added, (c) => (typeof c === "string" ? base(c) : base(c.path) || c.title || JSON.stringify(c)))
    );
  }
  // Entries per playlist (+added / −removed); the server's per_playlist when present.
  if (per) {
    wrap.appendChild(
      listBlock(
        "Entries per playlist",
        per,
        (p) =>
          `${p.playlist}: +${count(p.add)}${count(p.remove) ? ` / −${count(p.remove)}` : ""}${p.exists === false ? " (new)" : ""}` +
          (count(p.same_song) ? ` · ${count(p.same_song)} already there as another file` : ""),
        200
      )
    );
    return wrap;
  }
  const byPlaylist = {};
  const key = (e) => e.playlist || e.playlist_path || e.tag || "?";
  (Array.isArray(d.entries_added) ? d.entries_added : []).forEach((e) =>
    (byPlaylist[key(e)] = byPlaylist[key(e)] || { add: [], rem: [] }).add.push(e)
  );
  (Array.isArray(d.entries_removed) ? d.entries_removed : []).forEach((e) =>
    (byPlaylist[key(e)] = byPlaylist[key(e)] || { add: [], rem: [] }).rem.push(e)
  );
  const names = Object.keys(byPlaylist).sort();
  if (names.length) {
    const d2 = el("details");
    d2.appendChild(el("summary", `Entries per playlist (${names.length} playlists)`));
    const ul2 = el("ul");
    names.forEach((n) => {
      const { add, rem } = byPlaylist[n];
      const li = el("li", `${n}: +${add.length}${rem.length ? ` / −${rem.length}` : ""}`);
      li.title = [...add.map((e) => "+ " + base(e.path)), ...rem.map((e) => "− " + base(e.path))].join("\n");
      ul2.appendChild(li);
    });
    d2.appendChild(ul2);
    wrap.appendChild(d2);
  }
  return wrap;
}

export async function exportTarget() {
  try {
    const s = await apiJson("/api/settings");
    return s.rekordbox_target === "main" ? "main" : "test";
  } catch (e) {
    return "test";
  }
}

/**
 * @param {import("./jobs").Jobs} jobs
 * @param {{ids?: string[], latest?: number}} selection
 * @param {function} onProgress
 * @param {{ask?: boolean}} [opts]  ask even when the target is the test library
 */
export async function runExport(jobs, selection, onProgress, { ask = false } = {}) {
  const target = await exportTarget();
  if (target !== "main" && !ask) return jobs.run("/api/rekordbox/export", selection, onProgress);

  // "Add them anyway": also add tracks whose playlist already has the same song as another file.
  let addSameSong = false;
  // The preview is only the first step: never show it as "done".
  const dryRun = () =>
    jobs.run("/api/rekordbox/export", { ...selection, ...(addSameSong ? { add_same_song: true } : {}), dry_run: true }, (j) =>
      onProgress({
        ...j,
        status: j.status === "done" ? "running" : j.status,
        progress: { ...(j.progress || {}), message: `dry run · ${(j.progress || {}).message || ""}` },
      })
    );
  const preview = await dryRun();
  if (preview.status !== "done") return preview;
  let d = preview.result || {};
  if (!d.changed && !count(d.entries_same_song)) {
    const none = count(d.skipped_items) >= count(d.selected_items); // selected = all; skipped = not located
    return { status: "done", result: { message: none ? "none of these items are located" : "rekordbox is already up to date" } };
  }
  const titleOf = (d) => {
    // What's sent: the selection minus what's skipped (not located).
    const n = count(d.selected_items) - count(d.skipped_items) || (selection.ids || selection.rows || []).length || selection.latest;
    // Import rows (Transfer to rekordbox) don't join the bc-tagger collection.
    return selection.rows
      ? `Transfer ${n} rows to ${target === "main" ? "your MAIN rekordbox library" : "rekordbox"} (not added to your collection here)?`
      : target === "main"
      ? `Export ${n} items to your MAIN rekordbox library?`
      : `Export ${n} items to rekordbox?`;
  };
  const canConfirm = (d) => !blockersOf(d).length && d.can_confirm !== false;
  const body = el("div");
  body.appendChild(diffView(d, target));
  let shown = null; // the dialog's title and confirm button
  if (count(d.entries_same_song)) {
    // Ticking it runs the dry run again with them added, and shows that.
    const box = el("input");
    box.type = "checkbox";
    box.id = "addSameSong";
    const note = el("span", "", "muted");
    const label = el("label", null, "add-same-song");
    label.append(box, " Add them anyway (the playlist then has the song twice, as two files)", note);
    box.addEventListener("change", async () => {
      addSameSong = box.checked;
      box.disabled = true;
      if (shown) shown.ok.disabled = true;
      note.textContent = " · updating the dry run…";
      const again = await dryRun();
      box.disabled = false;
      note.textContent = "";
      if (again.status === "done") {
        d = again.result || {};
        body.firstChild.replaceWith(diffView(d, target));
      } else {
        addSameSong = box.checked = !box.checked;
        note.textContent = ` · dry run failed: ${again.error || "error"}`;
      }
      if (shown) {
        shown.title.textContent = titleOf(d);
        shown.ok.disabled = !canConfirm(d);
      }
    });
    body.appendChild(label);
  }
  const ok = await confirmDialog({
    id: "exportConfirm",
    danger: target === "main",
    title: titleOf(d),
    body,
    confirmLabel: target === "main" ? "Write to my main library" : "Export",
    confirmDisabled: !canConfirm(d),
    onOpen: (handles) => (shown = handles),
  });
  const blockers = blockersOf(d);
  if (blockers.length) return { status: "error", error: blockers.join("; ") };
  if (!ok) return { status: "done", result: { message: "cancelled" } };
  const write = { ...selection };
  if (addSameSong) write.add_same_song = true;
  if (d.confirm_token) write.confirm_token = d.confirm_token;
  return jobs.run("/api/rekordbox/export", write, onProgress);
}

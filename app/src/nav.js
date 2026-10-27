// The local app's header: page links + server / extension / rekordbox status,
// and the open import (if any), linked to its step.

import { pageEvents } from "../../shared/datasource/serverEvents";
import { getBatch } from "./importApi";
import { openImports, rememberImport, stepLabel, stepOf, stepUrl } from "./openImport";

function pill(id) {
  const s = document.createElement("span");
  s.className = "pill";
  s.id = id;
  return s;
}

function ago(iso) {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function buildNav(active) {
  const nav = document.createElement("nav");
  nav.id = "appNav";
  // Shown while exports target the user's main rekordbox library.
  const mainBanner = document.createElement("a");
  mainBanner.id = "mainLibraryBanner";
  mainBanner.href = "/settings/#rekordbox";
  mainBanner.hidden = true;
  nav.appendChild(mainBanner);
  const brand = document.createElement("span");
  brand.className = "brand";
  brand.textContent = "bc-tagger";
  nav.appendChild(brand);
  const links = {};
  [
    ["collection", "/", "Collections"],
    ["settings", "/settings/", "Settings"],
    ["import", "/settings/#import", "Import"],
  ].forEach(([id, href, label]) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    a.id = `navLink_${id}`;
    if (id === active) a.className = "active";
    links[id] = a;
    nav.appendChild(a);
  });
  // The open import: where it is, linked back to its step.
  const importPill = document.createElement("a");
  importPill.id = "navImport";
  importPill.className = "pill import-pill";
  importPill.hidden = true;
  const server = pill("navServer");
  const ext = pill("navExt");
  const db = pill("navDb");
  nav.append(importPill, server, ext, db);

  function setPill(p, text, kind, title) {
    p.textContent = text;
    p.className = `pill ${kind || ""}`;
    p.title = title || "";
  }

  // Keep the Import link and the pill on the open import; live progress from
  // the server's import events and the job, never cancelling anything.
  let tracking = null;
  async function refreshImport(live) {
    let open = [];
    try {
      open = await openImports();
    } catch (e) {
      return; // server offline: keep what's shown
    }
    const b = open[0];
    if (!b) {
      importPill.hidden = true;
      links.import.href = "/settings/#import";
      return;
    }
    rememberImport(b.id);
    const href = stepUrl(b);
    links.import.href = href;
    importPill.href = href;
    importPill.hidden = false;
    importPill.textContent = stepLabel(b, live);
    importPill.title = `${b.source || b.id}${open.length > 1 ? ` (+${open.length - 1} more open)` : ""}: click to continue`;
    importPill.className = `pill import-pill step-${stepOf(b)}`;
    if (stepOf(b) === "progress" && !live && tracking !== b.id) pollJob(b);
  }
  // A reload or a new page during lookups: follow the batch's job.
  async function pollJob(b) {
    tracking = b.id;
    const full = b.job && b.job.id ? null : await getBatch(b.id).catch(() => null);
    const jobId = (b.job && b.job.id) || (full && full.job_id);
    while (jobId && tracking === b.id) {
      const job = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`).then((r) => (r.ok ? r.json() : null), () => null);
      if (!job || job.status === "done" || job.status === "error") break;
      importPill.textContent = stepLabel(b, job.progress);
      await new Promise((r) => setTimeout(r, 2000));
    }
    tracking = null;
    refreshImport();
  }

  return {
    el: nav,
    // Show the open import (call once per page). On the page's one stream: pass it when the page starts
    // it itself (after its first load); without, it's started here.
    trackImports(events) {
      const ev = events || pageEvents().start();
      let t = null;
      ev.on("import", (d) => {
        clearTimeout(t);
        const live = d && d.phase && !["done", "error", "linked", "row", "tags"].includes(d.phase) ? d : null;
        t = setTimeout(() => refreshImport(live), live ? 0 : 300);
      });
      ev.on("resume", () => refreshImport());
      refreshImport();
    },
    // settings: the server's settings (rekordbox_target, rekordbox_main_db_path)
    // The target library: no banner for the test library; main read-only (writes
    // locked) or main with writes enabled (the stronger one).
    setTarget(settings) {
      const main = !!settings && settings.rekordbox_target === "main";
      const writable = main && !!settings.allow_main_writes;
      mainBanner.hidden = !main;
      mainBanner.classList.toggle("read-only", main && !writable);
      document.documentElement.classList.toggle("target-main", main);
      if (main) {
        const path = settings.rekordbox_main_db_path || "~/Library/Pioneer/rekordbox/master.db";
        mainBanner.textContent = writable ? "MAIN LIBRARY · writes enabled" : "MAIN LIBRARY · read-only";
        mainBanner.title = writable
          ? `${path}\nEvery export shows a dry run and asks before writing. Click to change.`
          : `${path}\nExports stop at the dry run until you allow writes in Settings → Rekordbox. Click to change.`;
      }
    },
    setHealth(health, error) {
      if (error || !health) {
        setPill(server, "server offline", "bad", error ? String(error.message || error) : "");
        return;
      }
      const src = health.items_source || {};
      const from =
        src.kind === "extension"
          ? `synced from the extension ${ago(src.synced_at)}`
          : src.kind === "export-json"
          ? "from the export JSON (extension not synced yet)"
          : "";
      setPill(server, `${health.items} items`, src.kind === "extension" ? "ok" : "warn", `Server ${health.version}. Items ${from}.`);
      const dbInfo = health.db || {};
      if (dbInfo.target === "main") setPill(db, "rekordbox: MAIN library", "bad", dbInfo.path || "");
      else {
        setPill(
          db,
          dbInfo.is_test ? "rekordbox: test library" : "rekordbox: NOT the test library",
          dbInfo.is_test ? "ok" : "bad",
          dbInfo.path || ""
        );
      }
    },
    setExtension(info) {
      if (info) {
        setPill(ext, "extension connected", "ok", `${info.name} ${info.version || ""}: tag edits are saved in the extension.`);
      } else {
        setPill(
          ext,
          "extension not connected",
          "warn",
          "Tag edits are queued on the server and applied by the extension on its next sync. " +
            "Refreshing players/thumbnails needs the extension (open this page in the Chrome profile that has Bc Tagger, " +
            "and check its server URL in the popup)."
        );
      }
    },
  };
}

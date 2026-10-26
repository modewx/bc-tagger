// The file index: "Full scan 12 min ago · 41,037 files", live progress while
// a full scan runs, and the server's hints (e.g. a drive was missing at the
// last full scan, or it's old: run Rescan drive). Full scans are manual only;
// Locate/Export do a small date-based quick scan. Fed by GET
// /api/index/status, SSE `index` events and the scan job's own events.

import { apiJson } from "../../shared/datasource/HttpDataSource";
import { resultText } from "./jobs";

const nf = new Intl.NumberFormat();

function ago(iso) {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/**
 * @param {object} o
 * @param {import("../../shared/datasource/serverEvents").ServerEvents} o.events
 * @param {import("./jobs").Jobs} o.jobs
 * @param {function(boolean)} [o.onScanning]  called when a scan starts / ends
 */
export function createIndexStatus({ events, jobs, onScanning }) {
  const el = document.createElement("span");
  el.id = "indexStatus";
  el.className = "index-status";
  const hint = document.createElement("span");
  hint.id = "indexHint";
  hint.className = "index-hint";
  hint.hidden = true;

  let status = null; // last /api/index/status
  let available = true; // false on an older server without the endpoint
  let scanning = false;
  let progress = null; // {current, total, message}

  function setScanning(v) {
    if (v === scanning) return;
    scanning = v;
    if (onScanning) onScanning(v);
  }

  function render() {
    el.hidden = !available && !scanning;
    el.classList.toggle("scanning", scanning);
    if (scanning) {
      const p = progress || {};
      const count = p.total ? ` ${nf.format(p.current || 0)}/${nf.format(p.total)}` : p.current ? ` ${nf.format(p.current)} files` : "";
      el.textContent = `Scanning the drive…${count}`;
      el.title = p.message || "";
    } else if (status && status.last_scan_at) {
      el.textContent = `Full scan ${ago(status.last_scan_at)} · ${nf.format(status.files || 0)} files`;
      el.title = (status.roots || [])
        .map((r) => `${r.mounted === false ? "✗ not mounted" : r.complete === false ? "⚠ incomplete" : "✓"} ${r.path} (${nf.format(r.files || 0)} files)`)
        .join("\n");
    } else if (status) {
      el.textContent = "No full scan yet";
      el.title = "";
    }
    const text = scanning ? "" : hintsOf(status).join(" · ");
    hint.hidden = !text;
    hint.textContent = text;
  }

  // The server's hints ([string] or [{code, message}]); before it had them,
  // derive one from incomplete_roots.
  function hintsOf(st) {
    if (!st) return [];
    if (Array.isArray(st.hints)) return st.hints.map((h) => (typeof h === "string" ? h : h.message || h.code)).filter(Boolean);
    const missing = st.incomplete_roots || [];
    return missing.length ? [`Drive was missing at the last full scan (${missing.join(", ")}): run Rescan drive`] : [];
  }

  async function refresh() {
    try {
      status = await apiJson("/api/index/status");
      available = true;
      setScanning(!!status.scanning);
    } catch (e) {
      if (e.status === 404) available = false;
    }
    render();
  }

  // SSE `index`: either a full status, or a progress/phase event.
  events.on("index", (d) => {
    if (!d || typeof d !== "object") return;
    if ("last_scan_at" in d || "files" in d) {
      status = { ...(status || {}), ...d };
      setScanning(!!d.scanning);
    } else {
      const phase = d.state || d.phase || d.event || "";
      if (/start|progress|running/.test(phase)) setScanning(true);
      if (d.progress || d.current != null) progress = d.progress || d;
      if (/finish|done|end|error/.test(phase)) {
        setScanning(false);
        refresh();
      }
    }
    render();
  });

  // The scan job's own progress (works with or without `index` events).
  events.on("job", (j) => {
    if (!j || j.kind !== "scan") return;
    if (j.status === "queued" || j.status === "running") {
      setScanning(true);
      progress = j.progress;
      render();
    } else {
      setScanning(false);
      refresh();
    }
  });

  setInterval(render, 60000); // keep "N min ago" current
  refresh();

  return {
    el,
    hint,
    refresh,
    isScanning: () => scanning,
    // The "Rescan drive" toolbar action.
    async rescan(statusEl) {
      setScanning(true);
      render();
      let job;
      try {
        job = await jobs.run("/api/index/scan", {}, (j) => {
          progress = j.progress;
          render();
        });
      } catch (e) {
        job = { status: "error", error: e.message };
      }
      setScanning(false);
      await refresh();
      statusEl.textContent = `Rescan drive: ${resultText(job)}`;
      return job;
    },
  };
}

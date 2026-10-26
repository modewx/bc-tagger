// The local app's header: page links + server / extension / rekordbox status.

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
  const brand = document.createElement("span");
  brand.className = "brand";
  brand.textContent = "bc-tagger";
  nav.appendChild(brand);
  [
    ["collection", "/", "Collection"],
    ["settings", "/settings/", "Settings"],
  ].forEach(([id, href, label]) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = label;
    if (id === active) a.className = "active";
    nav.appendChild(a);
  });
  const server = pill("navServer");
  const ext = pill("navExt");
  const db = pill("navDb");
  nav.append(server, ext, db);

  function setPill(p, text, kind, title) {
    p.textContent = text;
    p.className = `pill ${kind || ""}`;
    p.title = title || "";
  }

  return {
    el: nav,
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
      setPill(
        db,
        dbInfo.is_test ? "rekordbox: test library" : "rekordbox: NOT the test library",
        dbInfo.is_test ? "ok" : "bad",
        dbInfo.path || ""
      );
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

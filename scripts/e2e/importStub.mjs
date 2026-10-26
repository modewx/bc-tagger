// A stand-in for the server's import API (Phase 3, shapes as documented by
// Session A in LOCAL_COLLECTION_PLAN.md), served with page.route() so the
// import UI's details can be tested on states the real server only produces
// with the live site (the real-server import test covers the flow). Rows use
// A's shape (row.bandcamp = {item, via}). The "resolver": rows already in the
// collection (existing_id) match it; a row with a link hint (bandcamp_url) is
// resolved from it (match.source "file_url"), except rows listed in
// `unavailable`, which get the bot-check error A's resolver reports; "Maybe
// Track" gets candidates; the rest are unmatched.

export function importStub(file, { located = [], unavailable = [], paused = [] } = {}) {
  const calls = [];
  let unknown = { ...file.unknown_tags };
  let status = "ready";
  const UNAVAILABLE = "Unavailable: Bandcamp search unavailable (the HTML search returns a bot-check page)";
  const itemFor = (c, it) => ({ id: c.id, raw_id: Number(c.id.slice(1)), tralbum_type: c.id[0], title: c.title, artist: c.artist, item_url: c.url });
  // A's row shape: row.bandcamp = {item, via} when the row has a Bandcamp item.
  function resolveFromHint(r) {
    const c = { id: `t80000000${String(r.line).padStart(2, "0")}`, type: "track", title: r.title, artist: r.artist, url: r.hints.bandcamp_url, confidence: 0.97 };
    r.match = { status: "accepted", source: "file_url", confidence: c.confidence, query: r.hints.bandcamp_url, candidates: [c], chosen: c };
    r.bandcamp = { item: itemFor(c), via: "resolved" };
    r.source = "bandcamp";
  }
  const rows = file.items.map((it, n) => {
    const r = {
      n,
      line: it.line,
      raw: it.raw,
      kind: it.kind || "track",
      artist: it.artist ?? null,
      title: it.title,
      album: it.album ?? null,
      album_artist: it.album_artist ?? null,
      track_num: it.track_num ?? null,
      position: it.position ?? null,
      label: null,
      catalog: null,
      year: null,
      tags: it.tags.length ? it.tags : ["must"],
      flags: it.flags || [],
      note: it.note || null,
      checked: true,
      source: "other",
      match: { status: "none", source: null, confidence: 0, query: [it.artist, it.title].filter(Boolean).join(" "), candidates: [], chosen: null },
      bandcamp: null,
      duplicate: it.existing_id ? { of: it.existing_id, source: "bandcamp", title: it.title, artist: it.artist, tags: it.existing_tags || [] } : null,
      hints: { bandcamp_url: it.bandcamp_url || null, discogs_url: it.discogs_url || null },
      located: located.includes(it.line) ? { status: "located", best: { path: `/e2e/${it.title}.aiff`, format: "aiff" }, candidates: [] } : { status: "missing", best: null, candidates: [] },
      links: { discogs: null, youtube: null },
      committed: null,
    };
    if (it.existing_id) {
      r.match.status = "in_collection";
      r.bandcamp = { item: { id: it.existing_id, title: it.title, artist: it.artist, tralbum_type: "t" }, via: "collection" };
      r.source = "bandcamp";
    } else if (unavailable.includes(it.line)) {
      Object.assign(r.match, { status: "error", error: UNAVAILABLE });
    } else if (paused.includes(it.line)) {
      Object.assign(r.match, { status: "unavailable", reason: "rate_limited", error: "Bandcamp is rate-limiting; try again later" });
    } else if (it.bandcamp_url) {
      resolveFromHint(r);
    } else if (it.title === "Maybe Track") {
      r.match.status = "candidates";
      r.match.candidates = [
        { id: "t7000000001", type: "track", title: "Maybe Track", artist: "Two Options", album: null, url: "https://twooptions.bandcamp.com/track/maybe-track", confidence: 0.62 },
        { id: "t7000000002", type: "track", title: "Maybe Track (Dub)", artist: "Two Options", album: null, url: "https://twooptions.bandcamp.com/track/maybe-track-dub", confidence: 0.41 },
      ];
    }
    return r;
  });
  const stats = () => ({
    total: rows.length,
    bandcamp: rows.filter((r) => r.source === "bandcamp").length,
    other: rows.filter((r) => r.source === "other").length,
    located: rows.filter((r) => r.located.status === "located").length,
    duplicates: rows.filter((r) => r.duplicate).length,
    flagged: rows.filter((r) => r.flags.length).length,
    unknown_tags: Object.keys(unknown).length,
    checked: rows.filter((r) => r.checked).length,
    needs_pick: rows.filter((r) => r.match.status === "candidates").length,
  });
  let lookups = paused.length ? { state: "paused", reason: "rate_limited", error: "Bandcamp is rate-limiting; try again later" } : { state: "on" };
  const batch = () => ({
    bandcamp_lookups: lookups,
    batch_id: "e2e-b1",
    name: file.source,
    created_at: "2026-10-26T08:00:00Z",
    status,
    error: null,
    default_tags: ["must"],
    stats: stats(),
    unknown_tags: unknown,
    new_tags: [],
    pending_releases: file.pending_releases || [],
    rows,
  });
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  async function install(page) {
    await page.route(/\/api\/import(\/.*)?$/, async (route) => {
      const req = route.request();
      const p = new URL(req.url()).pathname;
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      calls.push({ method: req.method(), path: p, body });
      if (p === "/api/import" && req.method() === "POST") return json(route, { batch_id: "e2e-b1", job_id: "e2e-import-1" });
      if (p === "/api/import") return json(route, [{ batch_id: "e2e-b1", name: file.source, created_at: "2026-10-26T08:00:00Z", status, stats: stats() }]);
      if (p === "/api/import/e2e-b1" && req.method() === "DELETE") return json(route, { deleted: true });
      if (p === "/api/import/e2e-b1") return json(route, batch());
      if (p === "/api/import/e2e-b1/resume") {
        if (lookups.state !== "paused") return json(route, { detail: "not paused" }, 400);
        lookups = { state: "on" };
        rows.forEach((r) => r.match.reason === "rate_limited" && Object.assign(r.match, { status: "none", reason: null, error: null }));
        return json(route, { job_id: "e2e-import-1", estimate: { lookups: 1, text: "~1 lookup ≈ 3 s" } });
      }
      if (p === "/api/import/e2e-b1/tags") {
        rows.forEach((r) => {
          r.tags = [...new Set(r.tags.flatMap((t) => (body.map[t] ? body.map[t] : unknown[t] && body.unmapped === "ignore" ? [] : [t])))];
        });
        const new_tags = body.unmapped === "create" ? Object.keys(unknown).filter((t) => !body.map[t]) : [];
        unknown = {};
        return json(route, { unknown_tags: {}, new_tags, rows_changed: rows.length });
      }
      const m = p.match(/^\/api\/import\/e2e-b1\/rows\/(\d+)$/);
      if (m) {
        const r = rows[Number(m[1])];
        ["tags", "checked", "artist", "title", "album"].forEach((k) => k in body && (r[k] = body[k]));
        if ("match_url" in body) {
          Object.assign(r.match, { status: "manual", source: "url", url: body.match_url, chosen: null });
          r.hints.bandcamp_url = body.match_url; // as A's server: the URL the user set is the row's link hint
        }
        if (body.re_resolve) {
          if (r.hints.bandcamp_url) resolveFromHint(r);
          else Object.assign(r, { source: "other", bandcamp: null, match: { ...r.match, status: "none", source: null, chosen: null, candidates: [] } });
        }
        if ("choose" in body) {
          const c = r.match.candidates.find((x) => x.id === body.choose) || null;
          Object.assign(r.match, { status: "manual", chosen: c });
          r.bandcamp = c ? { item: itemFor(c), via: "chosen" } : null;
          r.source = c ? "bandcamp" : "other";
        }
        return json(route, r);
      }
      if (p === "/api/import/e2e-b1/commit") {
        status = "committed";
        const picked = rows.filter((r) => r.checked);
        return json(route, {
          pending_adds: picked.filter((r) => r.source === "bandcamp" && !r.duplicate).length,
          tag_merges: picked.filter((r) => r.duplicate).length,
          other_added: picked.filter((r) => r.source === "other").length,
          other_merged: 0,
          new_tags: [],
          skipped: rows.length - picked.length,
        });
      }
      return json(route, { detail: "not in the stub" }, 404);
    });
    await page.route(/\/api\/jobs\/e2e-import-1$/, (route) =>
      json(route, { id: "e2e-import-1", kind: "import", status: "done", progress: { current: rows.length, total: rows.length }, result: { batch_id: "e2e-b1", stats: stats() } })
    );
  }

  return { install, calls, rows };
}

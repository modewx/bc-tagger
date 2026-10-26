// A stand-in for the server's import API (Phase 3, shapes as documented by
// Session A in LOCAL_COLLECTION_PLAN.md), served with page.route() so the
// import UI can be tested before the server implements it. There's no
// Bandcamp lookup: rows match only when already in the collection
// (existing_id) or when the user links a page or pastes a URL; the file's
// bandcamp_url is a hint (hints.bandcamp_url). One row has candidates (as a
// metadata lookup might give) to exercise picking.

export function importStub(file, { located = [] } = {}) {
  const calls = [];
  let unknown = { ...file.unknown_tags };
  let status = "ready";
  const rows = file.items.map((it, n) => {
    const kind = it.kind || "track";
    const cands =
      it.title === "Maybe Track"
        ? [
            { id: "t7000000001", type: "track", title: "Maybe Track", artist: "Two Options", album: null, url: "https://twooptions.bandcamp.com/track/maybe-track", confidence: 0.62 },
            { id: "t7000000002", type: "track", title: "Maybe Track (Dub)", artist: "Two Options", album: null, url: "https://twooptions.bandcamp.com/track/maybe-track-dub", confidence: 0.41 },
          ]
        : [];
    const chosen = it.existing_id ? { id: it.existing_id, type: "track", title: it.title, artist: it.artist, url: null, confidence: 1 } : null;
    return {
      n,
      line: it.line,
      raw: it.raw,
      kind,
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
      source: chosen ? "bandcamp" : "other",
      match: {
        status: it.existing_id ? "accepted" : cands.length ? "candidates" : "none",
        source: it.existing_id ? "collection" : cands.length ? "candidates" : "none",
        confidence: chosen ? chosen.confidence : null,
        query: [it.artist, it.title].filter(Boolean).join(" "),
        url: null,
        chosen,
        candidates: cands,
        item: it.existing_id ? { id: it.existing_id, title: it.title, artist: it.artist, tralbum_type: "t" } : null,
      },
      duplicate: it.existing_id ? { of: it.existing_id, source: "bandcamp", title: it.title, artist: it.artist, tags: it.existing_tags || [] } : null,
      hints: { bandcamp_url: it.bandcamp_url || null, discogs_url: it.discogs_url || null },
      located: located.includes(it.line) ? { status: "located", best: { path: `/e2e/${it.title}.aiff`, format: "aiff" }, candidates: [] } : { status: "missing", best: null, candidates: [] },
      links: { discogs: null, youtube: null },
      committed: null,
    };
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
  const batch = () => ({
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
        if ("choose" in body) {
          const c = r.match.candidates.find((x) => x.id === body.choose) || null;
          Object.assign(r.match, { status: c ? "manual" : "none", source: c ? "picked" : "none", chosen: c, url: null, item: null });
          r.source = c ? "bandcamp" : "other";
        }
        if ("match_url" in body) {
          const chosen = { id: null, type: /\/album\//.test(body.match_url) ? "album" : "track", title: r.title, artist: r.artist, url: body.match_url, confidence: null };
          Object.assign(r.match, { status: "manual", source: "url", chosen, url: body.match_url });
          r.source = "bandcamp";
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

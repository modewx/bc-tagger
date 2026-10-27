// DataSource for the local app: reads the server's mirror over HTTP, and writes
// (tags, refreshed links) through the extension, which owns the data. When the
// extension is unreachable, tag edits are queued on the server and the
// extension applies them the next time it syncs.

// {concurrency, spacingMs} from /api/settings (or its {settings} wrapper).
export function limitsFromSettings(data) {
  const s = (data && data.settings) || data || {};
  return { concurrency: s.bandcamp_browser_concurrency, spacingMs: s.bandcamp_browser_spacing_ms };
}

export async function apiJson(path, { method = "GET", body } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }
  if (!res.ok) {
    const detail =
      data && data.detail
        ? typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)
        : String(text).slice(0, 200);
    const err = new Error(detail || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export class HttpDataSource {
  /**
   * @param {object} opts
   * @param {import("./extensionBridge").ExtensionBridge} opts.bridge
   * @param {import("./serverEvents").ServerEvents} opts.events
   */
  constructor({ bridge, events }) {
    this.name = "http";
    this.bridge = bridge;
    this.events = events;
    this.pageFetchUnavailableReason =
      "Bandcamp fetches need the Bc Tagger extension (not connected to this page).";
    this.collection = "all"; // which items getItems() reads: "all", or a collection's id (local app, Phase 8)
  }

  async init() {}

  async getTags() {
    const tags = await apiJson("/api/tags");
    return Array.isArray(tags) ? tags : [];
  }

  async getItems() {
    const one = this.collection != null && this.collection !== "all";
    const [data, pending] = await Promise.all([
      apiJson(one ? `/api/items?collection=${encodeURIComponent(this.collection)}` : "/api/items"),
      apiJson("/api/tag-edits/pending").catch(() => []),
    ]);
    // Items with a queued edit the extension hasn't applied yet (the server
    // already shows the queued tags in the mirror).
    const pendingIds = new Set((pending || []).map((e) => e.item_id || e.id));
    const list = Array.isArray(data) ? data : (data && data.items) || [];
    const items = {};
    this.sources = {};
    list.forEach((it) => {
      if (!it || it.id == null) return;
      this.sources[it.id] = it.source || "bandcamp";
      if (pendingIds.has(it.id)) it._tagsPending = true;
      items[it.id] = it;
    });
    return items;
  }

  async setItemTags(id, tags) {
    // `other` items belong to the server, not the extension: the server
    // applies their edits right away.
    if ((this.sources && this.sources[id] === "other") || /^o[0-9a-f]+$/.test(id)) {
      try {
        await apiJson("/api/tag-edits", { method: "POST", body: { id, tags } });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    if (this.bridge.connected) {
      try {
        await this.bridge.call("setItemTags", { id, tags });
        return { ok: true };
      } catch (e) {
        // The extension doesn't have this item (it only exists on the server):
        // a queued edit would be dropped by the extension, so don't queue it.
        if (/not-found/.test(e.message)) {
          return { ok: false, error: "this item isn't in the extension's collection" };
        }
        console.warn("[tags] extension write failed, queueing on the server", e.message);
      }
    }
    try {
      await apiJson("/api/tag-edits", { method: "POST", body: { id, tags } });
      return { ok: true, queued: true };
    } catch (e) {
      console.error("[tags] could not queue the edit", e);
      return { ok: false, error: e.message };
    }
  }

  // Refreshed links/art/fields are caches: save them through the extension when
  // it's there, otherwise keep them for this page view only.
  _persist(op, payload) {
    if (!this.bridge.connected) return Promise.resolve();
    return this.bridge.call(op, payload).catch((e) => console.warn(`[${op}]`, e.message));
  }

  persistFiles(files) {
    return this._persist("persistFiles", { files });
  }

  persistArt(art) {
    return this._persist("persistArt", { art });
  }

  persistFields(updates) {
    return this._persist("persistFields", { updates });
  }

  // Settings → Bandcamp requests: the throttle for page fetches.
  bandcampLimits() {
    return apiJson("/api/settings").then(limitsFromSettings);
  }

  // Cross-origin bandcamp pages can't be fetched from the app's origin; the
  // extension fetches them (with the live Bandcamp session) on our behalf.
  canFetchPages() {
    return this.bridge.connected;
  }

  async fetchPage(url, opts) {
    const r = await this.bridge.call("fetchPage", {
      url,
      credentials: (opts && opts.credentials) || "omit",
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, challenge: !!r.challenge, text: async () => r.text };
  }

  // Vocabulary changes arrive from the extension (instantly) and from the
  // server (after a sync).
  onTagsChanged(cb) {
    this.bridge.on("event", (event, data) => {
      if (event === "tagsChanged") cb(Array.isArray(data) ? data : []);
    });
    this.events.on("tags", () => this.getTags().then(cb).catch(() => {}));
  }

  // The server announces changed items (sync pushes, jobs); bursts (a full
  // sync announces every item) collapse into one reload.
  onItemsChanged(cb) {
    let t = null;
    const later = () => {
      clearTimeout(t);
      t = setTimeout(cb, 400);
    };
    this.events.on("item", later);
    this.events.on("ownership", later);
  }
}

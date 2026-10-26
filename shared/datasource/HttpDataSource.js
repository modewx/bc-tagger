// DataSource for the local app: reads the server's mirror over HTTP, and writes
// (tags, refreshed links) through the extension, which owns the data. When the
// extension is unreachable, tag edits are queued on the server and the
// extension applies them the next time it syncs.

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
    const detail = data && data.detail ? JSON.stringify(data.detail) : String(text).slice(0, 200);
    const err = new Error(`${method} ${path}: HTTP ${res.status} ${detail}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export class HttpDataSource {
  /** @param {{bridge: import("./extensionBridge").ExtensionBridge}} opts */
  constructor({ bridge }) {
    this.name = "http";
    this.bridge = bridge;
    this.pageFetchUnavailableReason =
      "Bandcamp fetches need the Bc Tagger extension (not connected to this page).";
  }

  async init() {}

  async getTags() {
    const tags = await apiJson("/api/tags");
    return Array.isArray(tags) ? tags : [];
  }

  async getItems() {
    const data = await apiJson("/api/items");
    const list = Array.isArray(data) ? data : (data && data.items) || [];
    const items = {};
    list.forEach((it) => {
      if (!it || it.id == null) return;
      // A queued (not yet applied) edit is what the user last chose: show it.
      if (Array.isArray(it.pending_tags)) {
        it.tags = it.pending_tags;
        it._tagsPending = true;
      }
      items[it.id] = it;
    });
    return items;
  }

  async setItemTags(id, tags) {
    if (this.bridge.connected) {
      try {
        await this.bridge.call("setItemTags", { id, tags });
        return { ok: true };
      } catch (e) {
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
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.text };
  }

  onTagsChanged(cb) {
    this.bridge.on("event", (event, data) => {
      if (event === "tagsChanged") cb(Array.isArray(data) ? data : []);
    });
  }

  // The extension tells us when its storage changed; give its sync push a
  // moment to reach the server before re-reading the mirror.
  onItemsChanged(cb) {
    let t = null;
    this.bridge.on("event", (event) => {
      if (event !== "itemsChanged" && event !== "synced") return;
      clearTimeout(t);
      t = setTimeout(cb, event === "synced" ? 100 : 2500);
    });
  }
}

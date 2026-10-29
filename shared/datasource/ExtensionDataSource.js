// DataSource for extension pages: talks to the background script, which owns
// chrome.storage.local (this page never reads it or listens to it: it asks the
// worker, and catches up when it's shown or focused).
//
// DataSource interface (also implemented by HttpDataSource):
//   init()                      -> Promise           one-time setup before the first load
//   getTags()                   -> Promise<string[]> the tag vocabulary
//   getItems()                  -> Promise<{[id]: item}> in storage order
//   setItemTags(id, tags)       -> Promise<{ok, queued?}>
//   persistFiles({id: file})    -> Promise           refreshed stream links
//   persistArt({id: art_url})   -> Promise           refreshed thumbnails
//   persistFields({id: {..}})   -> Promise           e.g. fixed artists
//   canFetchPages()             -> bool              can bandcamp pages be fetched?
//   fetchPage(url, {credentials}) -> Promise<{ok, status, text()}>
//   bandcampLimits?()           -> Promise<{concurrency, spacingMs} | null>  Settings → Bandcamp requests
//   onTagsChanged(cb(tags))                          live vocabulary updates
//   onItemsChanged?(cb)                              optional: items changed elsewhere (here: the popup's collection)

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError;
      resolve(res);
    });
  });
}

export class ExtensionDataSource {
  constructor() {
    this.name = "extension";
  }

  // Seed the vocabulary from the bundled tags.json if storage has none yet.
  async init() {
    const tags = await send({ type: "getTags" });
    if (tags == null) {
      $.getJSON(chrome.runtime.getURL("tags.json"), (seed) => {
        chrome.runtime.sendMessage({ type: "updateTags", tags: seed });
      });
    }
  }

  getTags() {
    return send({ type: "getTags" });
  }

  // The collection chosen in the popup (a collection: its members; All: every item), from the worker.
  getItems() {
    return send({ type: "shownItems" }).then((res) => {
      if (!res) return {};
      this.revs = { rev: res.rev, tagsRev: res.tagsRev };
      return res.items || {};
    });
  }

  setItemTags(id, tags, meta = {}) {
    return send({ ...meta, type: "updateTaggedItemTags", id, tags });
  }

  // The timing log: this page's time from an edit to the screen.
  noteTiming(opId, screenMs) {
    send({ type: "timing", opId, screenMs });
  }

  persistFiles(files) {
    return send({ type: "updateTaggedItemFiles", files });
  }

  persistArt(art) {
    return send({ type: "updateTaggedItemArt", art });
  }

  persistFields(updates) {
    return send({ type: "updateTaggedItemFields", updates });
  }

  // The server's Settings → Bandcamp requests when it's reachable, else null
  // (the defaults).
  bandcampLimits() {
    return send({ type: "bandcampLimits" }).then((res) => (res && res.ok ? res.limits : null));
  }

  // Extension pages have host_permissions for bandcamp, so plain fetch works.
  canFetchPages() {
    return true;
  }

  fetchPage(url, opts) {
    return fetch(url, opts);
  }

  // The page shown or focused: what changed meanwhile (another tab, the popup, the app), one small message when
  // nothing did.
  _catchUp() {
    if (this._watching) return;
    this._watching = { tags: [], items: [] };
    const check = () => {
      if (document.visibilityState !== "visible") return;
      send({ type: "revs" }).then((now) => {
        if (!now || !this.revs) return;
        const was = this.revs;
        this.revs = { ...this.revs, ...now };
        if (now.tagsRev !== was.tagsRev) this.getTags().then((tags) => this._watching.tags.forEach((cb) => cb(tags || [])));
        if (now.rev !== was.rev) this._watching.items.forEach((cb) => cb());
      });
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
  }

  onTagsChanged(cb) {
    this._catchUp();
    this._watching.tags.push(cb);
  }

  // Another collection chosen in the popup, or items changed elsewhere: the rows again (only changed rows redraw).
  onItemsChanged(cb) {
    this._catchUp();
    this._watching.items.push(cb);
  }
}

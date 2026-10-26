// DataSource for extension pages: talks to the background script, which owns
// chrome.storage.local.
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
//   onTagsChanged(cb(tags))                          live vocabulary updates
//   onItemsChanged?(cb)                              optional: items changed elsewhere

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

  getItems() {
    return send({ type: "getTaggedItems" }).then((items) => items || {});
  }

  setItemTags(id, tags) {
    return send({ type: "updateTaggedItemTags", id, tags });
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

  // Extension pages have host_permissions for bandcamp, so plain fetch works.
  canFetchPages() {
    return true;
  }

  fetchPage(url, opts) {
    return fetch(url, opts);
  }

  onTagsChanged(cb) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.tags) {
        cb(changes.tags.newValue || []);
      }
    });
  }
}

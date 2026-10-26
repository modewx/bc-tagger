// ---------------------------------------------------------------------------
// Tag vocabulary helpers
//
// Data lives in chrome.storage.local:
//   - taggedItems: { [id]: { ...metadata, tags: string[] } }  (the saved tracks)
//   - tags:        string[]                                    (the vocabulary / dropdown options)
//
// Golden rule: the vocabulary must always contain every tag that any saved
// track uses, plus the full tags.json seed. If a used tag were missing from the
// vocabulary it could silently disappear from a track when its tags are edited.
// ---------------------------------------------------------------------------

function usedTagsFrom(taggedItems) {
  const used = new Set();
  Object.values(taggedItems || {}).forEach((item) => {
    const tags = item && Array.isArray(item.tags) ? item.tags : [];
    tags.forEach((t) => {
      if (t != null && t !== "") used.add(t);
    });
  });
  return used;
}

// Ordered, de-duplicated union: keep seed order first, then any extras.
function unionTags(...lists) {
  const seen = new Set();
  const out = [];
  lists.forEach((list) => {
    (list || []).forEach((t) => {
      if (t != null && t !== "" && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    });
  });
  return out;
}

// Restore/maintain the complete vocabulary: tags.json ∪ existing ∪ used-by-tracks.
function ensureTagsComplete(cb) {
  const finish = (merged) => {
    chrome.storage.local.set({ tags: merged }, () => cb && cb(merged));
  };
  chrome.storage.local.get(["tags", "taggedItems"], ({ tags, taggedItems }) => {
    const existing = Array.isArray(tags) ? tags : [];
    const used = [...usedTagsFrom(taggedItems)];
    fetch(chrome.runtime.getURL("tags.json"))
      .then((response) => response.json())
      .then((seed) => finish(unionTags(seed, existing, used)))
      .catch(() => finish(unionTags(existing, used))); // still guarantee used tags
  });
}

// Push the current tag list to every tab so open Bandcamp pages can refresh
// their annotation dropdowns without a reload.
function broadcastTags(tags) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { type: "tagsUpdated", tags }, () => {
        void chrome.runtime.lastError; // ignore tabs with no content script
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("taggedItems", ({ taggedItems }) => {
    if (!taggedItems) {
      chrome.storage.local.set({ taggedItems: {} });
    }
  });
  ensureTagsComplete();
});

// Also heal on browser startup, in case anything was ever written partially.
chrome.runtime.onStartup.addListener(() => {
  ensureTagsComplete();
});

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "getTaggedItems") {
    chrome.storage.local.get("taggedItems", ({ taggedItems }) => {
      sendResponse(taggedItems || {});
    });
    return true;
  }

  if (request.type === "addTaggedItem") {
    chrome.storage.local.get("taggedItems", ({ taggedItems }) => {
      const items = taggedItems || {};
      items[request.item.id] = request.item;
      chrome.storage.local.set({ taggedItems: items });
    });
    return false;
  }

  if (request.type === "removeTaggedItem") {
    chrome.storage.local.get("taggedItems", ({ taggedItems }) => {
      const items = taggedItems || {};
      delete items[request.id];
      chrome.storage.local.set({ taggedItems: items });
    });
    return false;
  }

  if (request.type === "updateTaggedItemFiles") {
    // Merge refreshed stream URLs back in: { files: { [id]: { "mp3-128": url } } }.
    chrome.storage.local.get("taggedItems", ({ taggedItems }) => {
      const items = taggedItems || {};
      Object.entries(request.files || {}).forEach(([id, file]) => {
        if (items[id]) items[id].file = file;
      });
      chrome.storage.local.set({ taggedItems: items }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (request.type === "updateTaggedItemArt") {
    // Merge rebuilt thumbnail URLs back in: { art: { [id]: art_url } }.
    chrome.storage.local.get("taggedItems", ({ taggedItems }) => {
      const items = taggedItems || {};
      Object.entries(request.art || {}).forEach(([id, art_url]) => {
        if (items[id]) items[id].art_url = art_url;
      });
      chrome.storage.local.set({ taggedItems: items }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (request.type === "updateTaggedItemFields") {
    // Merge arbitrary fields into items without reordering: { updates: { [id]: {..} } }.
    chrome.storage.local.get("taggedItems", ({ taggedItems }) => {
      const items = taggedItems || {};
      Object.entries(request.updates || {}).forEach(([id, fields]) => {
        if (items[id] && fields && typeof fields === "object") {
          Object.assign(items[id], fields);
        }
      });
      chrome.storage.local.set({ taggedItems: items }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (request.type === "updateTaggedItemTags") {
    // Update one item's tags (inline editing from the collection page).
    chrome.storage.local.get("taggedItems", ({ taggedItems }) => {
      const items = taggedItems || {};
      if (items[request.id]) {
        items[request.id].tags = Array.isArray(request.tags) ? request.tags : [];
        chrome.storage.local.set({ taggedItems: items }, () => sendResponse({ ok: true }));
      } else {
        sendResponse({ ok: false, reason: "not-found" });
      }
    });
    return true;
  }

  if (request.type === "getTags") {
    // Return the vocabulary, defensively unioned with every tag used by saved
    // tracks so a dropdown can always represent (and never drop) a track's tags.
    chrome.storage.local.get(["tags", "taggedItems"], ({ tags, taggedItems }) => {
      const existing = Array.isArray(tags) ? tags : [];
      const used = [...usedTagsFrom(taggedItems)];
      const merged = unionTags(existing, used);

      if (merged.length > 0) {
        if (merged.length !== existing.length) {
          chrome.storage.local.set({ tags: merged });
        }
        sendResponse(merged);
      } else {
        // Nothing stored yet: seed from tags.json.
        fetch(chrome.runtime.getURL("tags.json"))
          .then((response) => response.json())
          .then((seed) => {
            const seeded = unionTags(seed, used);
            chrome.storage.local.set({ tags: seeded });
            sendResponse(seeded);
          })
          .catch(() => sendResponse(merged));
      }
    });
    return true;
  }

  if (request.type === "addTag") {
    const name = (request.tag || "").trim();
    chrome.storage.local.get("tags", ({ tags }) => {
      const current = Array.isArray(tags) ? tags : [];
      if (!name) {
        sendResponse({ ok: false, reason: "empty" });
        return;
      }
      if (current.includes(name)) {
        sendResponse({ ok: false, reason: "exists" });
        return;
      }
      const updated = [...current, name];
      chrome.storage.local.set({ tags: updated }, () => {
        broadcastTags(updated);
        sendResponse({ ok: true, tags: updated });
      });
    });
    return true;
  }

  if (request.type === "updateTags") {
    chrome.storage.local.set({ tags: request.tags }, () => {
      broadcastTags(request.tags);
    });
    return false;
  }

  return false;
});

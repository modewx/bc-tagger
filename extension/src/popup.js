$(function () {
  console.log("------- loaded popup.js");

  let allTags = [];

  const tagNameInput = document.getElementById("tagName");
  const suggestions = document.getElementById("tagSuggestions");
  const allTagsSelect = document.getElementById("allTags");
  const tagCount = document.getElementById("tagCount");
  const toast = document.getElementById("toast");

  let toastTimer = null;
  function showToast(message, kind) {
    toast.textContent = message;
    toast.className = kind === "success" ? "success show" : "show";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.className = toast.className.replace("show", "").trim();
    }, 2200);
  }

  function openTabIfNotExists(url) {
    chrome.tabs.query({ url: chrome.runtime.getURL(url) }, (tabs) => {
      if (tabs.length === 0) {
        chrome.tabs.create({ url });
      } else {
        chrome.tabs.update(tabs[0].id, { active: true });
      }
    });
  }

  // --- See Tags panel -----------------------------------------------------
  function togglePanel(panelId, buttonId) {
    const panel = document.getElementById(panelId);
    const button = document.getElementById(buttonId);
    const isOpen = panel.classList.toggle("open");
    button.classList.toggle("active", isOpen);
  }

  function renderAllTags() {
    allTagsSelect.innerHTML = "";
    allTags.forEach((tag) => {
      const row = document.createElement("div");
      row.className = "tag-row";

      const name = document.createElement("span");
      name.className = "tag-name";
      name.textContent = tag;

      const del = document.createElement("button");
      del.type = "button";
      del.className = "tag-delete";
      del.textContent = "x";
      del.title = `Delete "${tag}"`;
      del.addEventListener("click", () => deleteTag(tag));

      row.appendChild(name);
      row.appendChild(del);
      allTagsSelect.appendChild(row);
    });
    tagCount.textContent = `${allTags.length} tag${allTags.length === 1 ? "" : "s"}`;
  }

  function deleteTag(tag) {
    // Don't delete a tag that tracks still use, so no track loses an annotation
    // (the vocabulary would also just restore it via the used-tags union).
    chrome.runtime.sendMessage({ type: "getTaggedItems" }, (taggedItems) => {
      const used = Object.values(taggedItems || {}).filter(
        (it) => Array.isArray(it.tags) && it.tags.includes(tag)
      );
      if (used.length > 0) {
        showToast(`"${tag}" is used by ${used.length} track${used.length === 1 ? "" : "s"}`);
        return;
      }
      const updated = allTags.filter((t) => t !== tag);
      chrome.runtime.sendMessage({ type: "updateTags", tags: updated });
      allTags = updated;
      renderAllTags();
      showToast(`Deleted "${tag}"`, "success");
    });
  }

  // --- Create tag autocomplete -------------------------------------------
  function renderSuggestions(query) {
    const q = query.trim().toLowerCase();
    suggestions.innerHTML = "";

    if (!q) {
      suggestions.classList.remove("open");
      return;
    }

    const matches = allTags.filter((t) => t.toLowerCase().includes(q));
    if (matches.length === 0) {
      suggestions.classList.remove("open");
      return;
    }

    matches.forEach((tag) => {
      const item = document.createElement("div");
      item.textContent = tag;
      if (tag.toLowerCase() === q) {
        item.classList.add("exists");
        item.textContent = `${tag} (exists)`;
      }
      item.addEventListener("mousedown", (e) => {
        // mousedown fires before the input blurs
        e.preventDefault();
        tagNameInput.value = tag;
        suggestions.classList.remove("open");
        tagNameInput.focus();
      });
      suggestions.appendChild(item);
    });
    suggestions.classList.add("open");
  }

  function sanitize(value) {
    // Keep internal spaces (tags like "new beat"); just collapse runs and trim.
    return value.replace(/\s+/g, " ").trim();
  }

  function createTag() {
    const name = sanitize(tagNameInput.value);
    tagNameInput.value = name;

    if (!name) {
      showToast("Tag name cannot be empty");
      return;
    }

    chrome.runtime.sendMessage({ type: "addTag", tag: name }, (res) => {
      if (res && res.ok) {
        allTags = res.tags;
        renderAllTags();
        tagNameInput.value = "";
        suggestions.classList.remove("open");
        showToast(`Created "${name}"`, "success");
        tagNameInput.focus();
      } else if (res && res.reason === "exists") {
        showToast("Tag already exists");
      } else {
        showToast("Could not create tag");
      }
    });
  }

  // --- Events -------------------------------------------------------------
  document.getElementById("createTag").addEventListener("click", createTag);

  document.getElementById("seeTags").addEventListener("click", () => {
    togglePanel("seeTagsPanel", "seeTags");
  });

  // See Collection: the local app when its server answers, else the bundled page.
  document.getElementById("seeCollection").addEventListener("click", (e) => {
    if (e.shiftKey) {
      openTabIfNotExists("collection.html");
      return;
    }
    chrome.runtime.sendMessage({ type: "serverStatus" }, (res) => {
      if (res && res.health) openOrFocus(res.url + "/");
      else openTabIfNotExists("collection.html");
    });
  });

  function openOrFocus(url) {
    chrome.tabs.query({ url: url + "*" }, (tabs) => {
      if (tabs && tabs.length) chrome.tabs.update(tabs[0].id, { active: true });
      else chrome.tabs.create({ url });
    });
  }

  document.getElementById("importLink").addEventListener("click", (e) => {
    e.preventDefault();
    openTabIfNotExists("import.html");
  });

  // Dev builds can reload themselves after a rebuild.
  const devReload = document.getElementById("devReload");
  if (__DEV_BUILD__) {
    devReload.hidden = false;
    devReload.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.reload();
    });
  }

  // --- Local app / server status ----------------------------------------
  const serverDot = document.getElementById("serverDot");
  const serverText = document.getElementById("serverText");
  const serverEditRow = document.getElementById("serverEditRow");
  const serverUrlInput = document.getElementById("serverUrl");

  function ago(ms) {
    if (!ms) return "never";
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return `${Math.round(s / 3600)} h ago`;
  }

  function renderServer(res) {
    const host = res && res.url ? res.url.replace(/^https?:\/\//, "") : "";
    serverUrlInput.value = (res && res.url) || "";
    if (res && res.health) {
      const st = res.status || {};
      const last = Math.max(st.lastPushAt || 0, st.lastFullAt || 0);
      serverDot.className = "dot up";
      serverText.textContent = `Local app: ${host} · synced ${ago(last)}`;
      const own = st.ownership || {};
      serverText.title =
        `${res.health.items} items on the server.` +
        (own.error ? ` Ownership: ${own.error}.` : own.count != null ? ` ${own.count} owned items.` : "") +
        (st.syncWarning ? ` Note: ${st.syncWarning}.` : "") +
        (st.lastError ? ` Last error: ${st.lastError}` : "");
    } else {
      serverDot.className = "dot down";
      serverText.textContent = `Local app: offline (${host})`;
      serverText.title = "The bc-tagger server isn't answering; See Collection opens the built-in page.";
    }
  }

  function refreshServer() {
    chrome.runtime.sendMessage({ type: "serverStatus" }, renderServer);
  }

  document.getElementById("serverEdit").addEventListener("click", () => {
    serverEditRow.classList.toggle("open");
    if (serverEditRow.classList.contains("open")) serverUrlInput.focus();
  });

  document.getElementById("serverSave").addEventListener("click", () => {
    const raw = serverUrlInput.value.trim() || "http://127.0.0.1:8765";
    let url = null;
    try {
      const u = new URL(raw);
      if (u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname)) url = `${u.protocol}//${u.host}`;
    } catch (e) {
      /* invalid */
    }
    if (!url) {
      showToast("Use http://127.0.0.1:<port> or http://localhost:<port>");
      return;
    }
    chrome.storage.local.set({ bcServer: { url } }, () => {
      serverEditRow.classList.remove("open");
      showToast("Server URL saved", "success");
      setTimeout(refreshServer, 300);
    });
  });

  document.getElementById("serverSync").addEventListener("click", () => {
    serverText.textContent = "Local app: syncing…";
    chrome.runtime.sendMessage({ type: "syncNow" }, (res) => {
      if (res && res.ok) showToast("Synced to the local server", "success");
      else showToast(`Sync failed: ${(res && res.error) || "server offline"}`);
      refreshServer();
    });
  });

  refreshServer();

  // Export the full database (saved tracks + tag vocabulary) as a JSON backup.
  const exportLink = document.querySelector(".link-to-download");
  if (exportLink) {
    exportLink.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "getTaggedItems" }, (taggedItems) => {
        chrome.runtime.sendMessage({ type: "getTags" }, (tags) => {
          const payload = JSON.stringify({ taggedItems: taggedItems || {}, tags: tags || [] }, null, 2);
          const blob = new Blob([payload], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          const stamp = new Date().toISOString().slice(0, 10);
          a.href = url;
          a.download = `bc-tagger-export-${stamp}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          showToast("Exported backup", "success");
        });
      });
    });
  }

  tagNameInput.addEventListener("input", () => {
    renderSuggestions(tagNameInput.value);
  });

  tagNameInput.addEventListener("blur", () => {
    // Delay so a mousedown on a suggestion still registers.
    setTimeout(() => suggestions.classList.remove("open"), 120);
  });

  tagNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      createTag();
    } else if (e.key === "Escape") {
      suggestions.classList.remove("open");
    }
  });

  // --- Load tags ----------------------------------------------------------
  chrome.runtime.sendMessage({ type: "getTags" }, (tags) => {
    allTags = Array.isArray(tags) ? tags : [];
    renderAllTags();
  });

  // Autofocus the input so creating a tag is just: click extension, type, Enter.
  tagNameInput.focus();
});

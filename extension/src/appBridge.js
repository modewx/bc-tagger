// Content script for the local app (http://127.0.0.1/* and http://localhost/*,
// any port). Only activates on the server origin configured in the popup; then
// relays the page's requests to the background script and pushes storage
// changes back. The page side is shared/datasource/extensionBridge.js.

import { DEFAULT_SERVER_URL, sameServerOrigin } from "./serverSync";

function post(msg) {
  window.postMessage(msg, location.origin);
}

function activate() {
  const manifest = chrome.runtime.getManifest();
  const hello = () =>
    post({ bcTagger: "hello", name: manifest.name, version: manifest.version, id: chrome.runtime.id });

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    // Cut off by an extension reload: a fresh copy (injected by the background) answers.
    if (!chrome.runtime || !chrome.runtime.id) return;
    const d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.bcTagger === "ping") {
      hello();
      return;
    }
    if (d.bcTagger !== "request") return;
    const reply = (ok, result, error) => post({ bcTagger: "response", id: d.id, ok, result, error });
    try {
      chrome.runtime.sendMessage({ type: "appBridge", op: d.op, payload: d.payload }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) reply(false, null, err.message);
        else if (!res) reply(false, null, "no answer from the extension");
        else reply(!!res.ok, res.result, res.error);
      });
    } catch (err) {
      // e.g. "Extension context invalidated" after the extension reloaded.
      reply(false, null, err.message);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.tags) post({ bcTagger: "event", event: "tagsChanged", data: changes.tags.newValue || [] });
    if (changes.taggedItems) post({ bcTagger: "event", event: "itemsChanged" });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "bridgeEvent") post({ bcTagger: "event", event: msg.event, data: msg.data });
  });

  hello();
}

chrome.storage.local.get("bcServer", ({ bcServer }) => {
  const url = (bcServer && bcServer.url) || DEFAULT_SERVER_URL;
  if (sameServerOrigin(location.origin, url)) activate();
});

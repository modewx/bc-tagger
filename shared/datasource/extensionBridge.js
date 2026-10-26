// Page side of the extension bridge used by the local app.
//
// The extension injects a content script (extension/src/appBridge.js) into the
// local server's pages. It relays window.postMessage requests to the background
// script, so the app can edit tags in chrome.storage (the source of truth) and
// fetch Bandcamp pages with the user's session, without knowing the extension ID.
//
// Messages (all carry a `bcTagger` field):
//   page -> ext:  {bcTagger:"ping"} | {bcTagger:"request", id, op, payload}
//   ext  -> page: {bcTagger:"hello", name, version, dev}
//                 {bcTagger:"response", id, ok, result, error}
//                 {bcTagger:"event", event, data}

export class ExtensionBridge {
  constructor() {
    this.info = null; // the hello payload, once connected
    this.pending = new Map();
    this.nextId = 1;
    this.listeners = { connect: [], event: [] };
    window.addEventListener("message", (e) => this._onMessage(e));
  }

  get connected() {
    return !!this.info;
  }

  // Resolves true once the extension answers, false after `timeoutMs`.
  connect(timeoutMs = 800) {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok) => {
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.on("connect", () => done(true));
      window.postMessage({ bcTagger: "ping" }, location.origin);
    });
  }

  on(name, cb) {
    this.listeners[name].push(cb);
  }

  call(op, payload, timeoutMs = 60000) {
    if (!this.connected) return Promise.reject(new Error("extension not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`extension did not answer (${op})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      window.postMessage({ bcTagger: "request", id, op, payload }, location.origin);
    });
  }

  _onMessage(e) {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.bcTagger === "hello") {
      const first = !this.info;
      this.info = d;
      if (first) this.listeners.connect.forEach((cb) => cb(d));
    } else if (d.bcTagger === "response") {
      const p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      clearTimeout(p.timer);
      if (d.ok) p.resolve(d.result);
      else p.reject(new Error(d.error || "extension error"));
    } else if (d.bcTagger === "event") {
      this.listeners.event.forEach((cb) => cb(d.event, d.data));
    }
  }
}

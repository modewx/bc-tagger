// The server's SSE stream (/api/events): `job` (a job dict), `item` ({id}),
// `tags`, `ownership`. EventSource reconnects by itself (server sends retry).
//
// Chrome allows 6 connections per host across all tabs, and each stream holds
// one for as long as it's open. So a page has one stream (pageEvents()), and
// it's closed while the tab is hidden. When the tab shows again it reopens and
// fires `resume` (local, not from the server): what the page shows may be stale,
// so `on("resume", ...)` catches up.

export class ServerEvents {
  constructor(url = "/api/events") {
    this.url = url;
    this.handlers = {};
    this.source = null;
    this.connected = false;
    this.started = false;
  }

  on(event, cb) {
    (this.handlers[event] = this.handlers[event] || []).push(cb);
    if (this.source) this._listen(event);
    return this;
  }

  start() {
    if (this.started || typeof EventSource === "undefined") return this;
    this.started = true;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => (document.hidden ? this._close() : this._resume()));
      if (document.hidden) return this; // opened when the tab is shown
    }
    this._open();
    return this;
  }

  _open() {
    this.source = new EventSource(this.url);
    this._bound = {};
    this.source.onopen = () => (this.connected = true);
    this.source.onerror = () => (this.connected = false);
    Object.keys(this.handlers).forEach((e) => this._listen(e));
  }

  _close() {
    if (!this.source) return;
    this.source.close();
    this.source = null;
    this.connected = false;
  }

  _resume() {
    if (this.source) return;
    this._open();
    (this.handlers.resume || []).forEach((cb) => cb());
  }

  _listen(event) {
    if (event === "resume" || this._bound[event]) return;
    this._bound[event] = true;
    this.source.addEventListener(event, (e) => {
      let data = null;
      try {
        data = JSON.parse(e.data);
      } catch (err) {
        data = e.data;
      }
      (this.handlers[event] || []).forEach((cb) => cb(data));
    });
  }
}

let shared = null;

// The page's one stream: every module of a page uses this one (each open
// stream holds one of the browser's 6 connections to the server).
export function pageEvents() {
  return (shared = shared || new ServerEvents());
}

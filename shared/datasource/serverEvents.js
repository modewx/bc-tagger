// The server's SSE stream (/api/events): `job` (a job dict), `item` ({id}),
// `tags`, `ownership`. EventSource reconnects by itself (server sends retry).

export class ServerEvents {
  constructor(url = "/api/events") {
    this.url = url;
    this.handlers = {};
    this.source = null;
    this.connected = false;
  }

  on(event, cb) {
    (this.handlers[event] = this.handlers[event] || []).push(cb);
    if (this.source) this._listen(event);
    return this;
  }

  start() {
    if (this.source || typeof EventSource === "undefined") return this;
    this.source = new EventSource(this.url);
    this.source.onopen = () => (this.connected = true);
    this.source.onerror = () => (this.connected = false);
    Object.keys(this.handlers).forEach((e) => this._listen(e));
    return this;
  }

  _listen(event) {
    if (this._bound && this._bound[event]) return;
    this._bound = this._bound || {};
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

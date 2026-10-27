// The players' own controls (rows and the docked top-bar player): play/pause,
// a seek bar, and "current / duration". Chrome's native controls drop a click on
// the timeline that lands before the file's length is known (a sleeping drive
// takes a second or two), so the page owns the timeline: a click sets a
// fraction of the bar, which is applied as soon as the length arrives. One click
// is enough; a later click before that replaces it.
//
// The <audio> has no controls and preload "none". Its metadata loads once the
// pointer rests on the player (DWELL_MS) or the bar gets focus: only a head
// start, never while the pointer passes over rows (in the local app every load
// reads the music drive).

const DWELL_MS = 150;
const STEP_S = 5; // arrow keys on the bar

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fmt(s) {
  if (!Number.isFinite(s) || s < 0) return "–:––";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

const clamp = (f) => Math.min(1, Math.max(0, f));

/**
 * Wraps `audio` in its controls; the wrapper (audio.bctPlayer) is what goes in
 * a cell or the top bar.
 * @param {HTMLAudioElement} audio
 * @param {{duration?: number|null}} [o]  the file's length if known (cached by the server): shown before
 *   anything loads; the file's own length wins once it's in
 * @returns {HTMLElement}
 */
export function attachRowPlayer(audio, { duration: known = null } = {}) {
  audio.controls = false;
  audio.preload = "none";

  const wrap = el("div", "row-player");
  const play = el("button", "rp-play");
  play.type = "button";
  const bar = el("div", "rp-bar");
  bar.tabIndex = 0;
  bar.setAttribute("role", "slider");
  bar.setAttribute("aria-label", "Position");
  bar.setAttribute("aria-valuemin", "0");
  const fill = el("div", "rp-fill");
  const thumb = el("div", "rp-thumb");
  const track = el("div", "rp-track");
  track.append(fill, thumb);
  bar.appendChild(track);
  const time = el("span", "rp-time");
  wrap.append(play, bar, time, audio);
  audio.bctPlayer = wrap;

  let target = null; // a fraction of the track to start at, once its length is known
  let dragging = null; // the fraction under the pointer while dragging

  const duration = () => (audio.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
  const length = () => duration() || (known > 0 ? known : 0); // for showing; seeks wait for the file's own

  function paint() {
    const d = length();
    const shown = dragging != null ? dragging : target != null ? target : d ? audio.currentTime / d : 0;
    const pct = `${clamp(shown) * 100}%`;
    fill.style.width = pct;
    thumb.style.left = pct;
    const loading = target != null || (!audio.paused && audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA);
    wrap.classList.toggle("loading", loading);
    const at = dragging != null ? dragging : target;
    time.textContent = loading && !d ? "loading…" : `${fmt(at != null && d ? at * d : audio.currentTime)} / ${d ? fmt(d) : "–:––"}`;
    const playing = !audio.paused;
    play.textContent = playing ? "❚❚" : "▶";
    play.title = playing ? "Pause" : "Play";
    play.setAttribute("aria-label", play.title);
    bar.setAttribute("aria-valuemax", String(Math.round(d)));
    bar.setAttribute("aria-valuenow", String(Math.round(d ? clamp(shown) * d : 0)));
    bar.setAttribute("aria-valuetext", d ? `${fmt(clamp(shown) * d)} of ${fmt(d)}` : "not loaded");
  }

  // Start at `frac` of the track and play: now if its length is known, else as
  // soon as it is (playing asks for the file).
  function seekTo(frac) {
    frac = clamp(frac);
    const d = duration();
    if (d) {
      target = null;
      audio.currentTime = frac * d;
    } else {
      target = frac;
    }
    if (audio.paused) audio.play().catch(() => {});
    paint();
  }

  audio.addEventListener("loadedmetadata", () => {
    if (target != null && duration()) {
      const f = target;
      target = null;
      audio.currentTime = f * duration();
    }
    paint();
  });
  ["timeupdate", "durationchange", "play", "pause", "playing", "waiting", "ended", "seeked", "emptied", "error"].forEach((t) =>
    audio.addEventListener(t, paint)
  );

  play.addEventListener("click", () => {
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });

  const fracAt = (e) => {
    const r = track.getBoundingClientRect();
    return r.width ? clamp((e.clientX - r.left) / r.width) : 0;
  };
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    bar.focus({ preventScroll: true });
    bar.setPointerCapture(e.pointerId);
    dragging = fracAt(e);
    paint();
  });
  bar.addEventListener("pointermove", (e) => {
    if (dragging == null) return;
    dragging = fracAt(e);
    paint();
  });
  const release = (e, apply) => {
    if (dragging == null) return;
    const f = apply ? fracAt(e) : null;
    dragging = null;
    if (f != null) seekTo(f);
    else paint();
  };
  bar.addEventListener("pointerup", (e) => release(e, true));
  bar.addEventListener("pointercancel", (e) => release(e, false));

  bar.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      play.click();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const d = duration();
      if (!d) return loadMetadata();
      audio.currentTime = Math.min(d, Math.max(0, audio.currentTime + (e.key === "ArrowRight" ? STEP_S : -STEP_S)));
      paint();
    }
  });

  // The head start: the metadata once the pointer rests on the player, or the bar gets focus.
  let dwell = null;
  function loadMetadata() {
    clearTimeout(dwell);
    if (audio.preload !== "none") return; // once
    audio.preload = "metadata"; // Chrome may resume the fetch for this alone
    // Not once it's loading or has started: load() would start over (or stop it).
    if (audio.paused && audio.readyState === HTMLMediaElement.HAVE_NOTHING && audio.networkState !== HTMLMediaElement.NETWORK_LOADING) audio.load();
  }
  wrap.addEventListener("pointerenter", () => {
    clearTimeout(dwell);
    dwell = setTimeout(loadMetadata, DWELL_MS);
  });
  wrap.addEventListener("pointerleave", () => clearTimeout(dwell));
  bar.addEventListener("focus", loadMetadata);

  paint();
  return wrap;
}

// What to move around for a player's audio: its controls with it.
export const playerOf = (audio) => (audio && audio.bctPlayer) || audio;

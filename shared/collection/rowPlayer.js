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
const STEP_S = 5; // ←/→ on the bar
const VOLUME_STEP = 0.1; // ↑/↓ on the bar

// One volume and mute for every player (only one plays at a time), kept in this browser.
const VOLUME_KEY = "bc_player_volume";
const MUTED_KEY = "bc_player_muted";
const sound = (() => {
  const out = { volume: 1, muted: false };
  try {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY));
    if (Number.isFinite(v)) out.volume = Math.min(1, Math.max(0, v));
    out.muted = localStorage.getItem(MUTED_KEY) === "1";
  } catch (e) {
    /* storage unavailable: defaults */
  }
  return out;
})();
function setSound(patch) {
  Object.assign(sound, patch);
  sound.volume = Math.min(1, Math.max(0, sound.volume));
  try {
    localStorage.setItem(VOLUME_KEY, String(sound.volume));
    localStorage.setItem(MUTED_KEY, sound.muted ? "1" : "0");
  } catch (e) {
    /* not kept */
  }
  document.querySelectorAll(".row-player").forEach((p) => p.paintSound && p.paintSound());
}

const PLAY_ICON = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 1.5v9l7.5-4.5z" fill="currentColor"/></svg>';
const PAUSE_ICON =
  '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><rect x="2" y="1.5" width="3" height="9" rx="0.6" fill="currentColor"/>' +
  '<rect x="7" y="1.5" width="3" height="9" rx="0.6" fill="currentColor"/></svg>';
const SPEAKER =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 6h3l4-3v10L5 10H2z" fill="currentColor"/>' +
  '<path class="rp-wave" d="M11 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6 6 0 0 1 0 9" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
  '<path class="rp-x" d="M11 6l4 4M15 6l-4 4" stroke="currentColor" stroke-width="1.4"/></svg>';

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
  // Volume: the speaker mutes; the slider shows while the pointer is on the speaker (or it has focus).
  const vol = el("div", "rp-vol");
  const speaker = el("button", "rp-speaker");
  speaker.type = "button";
  speaker.innerHTML = SPEAKER;
  const slider = el("input", "rp-volume");
  slider.type = "range";
  slider.min = "0";
  slider.max = "1";
  slider.step = "0.05";
  slider.setAttribute("aria-label", "Volume");
  const pop = el("div", "rp-vol-pop");
  pop.appendChild(slider);
  vol.append(pop, speaker);
  wrap.append(play, bar, time, vol, audio);
  audio.bctPlayer = wrap;

  function paintSound() {
    audio.volume = sound.volume;
    audio.muted = sound.muted;
    slider.value = String(sound.muted ? 0 : sound.volume);
    const silent = sound.muted || sound.volume === 0;
    vol.classList.toggle("muted", silent);
    speaker.title = sound.muted ? "Unmute" : "Mute";
    speaker.setAttribute("aria-label", speaker.title);
  }
  wrap.paintSound = paintSound;
  paintSound();
  audio.addEventListener("play", paintSound); // a player that was out of the page meanwhile
  speaker.addEventListener("click", () => setSound({ muted: !sound.muted, volume: sound.volume || 0.5 }));
  slider.addEventListener("input", () => setSound({ volume: parseFloat(slider.value), muted: false }));

  let target = null; // a fraction of the track to start at, once its length is known
  let resumeAt = null; // seconds to go back to once a swapped source's length is known
  let dragging = null; // the fraction under the pointer while dragging
  let wanted = false; // asked to play and not paused since (a source that fails leaves it: its replacement plays on)
  audio.addEventListener("play", () => (wanted = true));
  audio.addEventListener("pause", () => (wanted = false));

  const duration = () => (audio.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
  const length = () => duration() || (known > 0 ? known : 0); // for showing; seeks wait for the file's own

  function paint() {
    const d = length();
    const now = resumeAt != null ? resumeAt : audio.currentTime;
    const shown = dragging != null ? dragging : target != null ? target : d ? now / d : 0;
    const pct = `${clamp(shown) * 100}%`;
    fill.style.width = pct;
    thumb.style.left = pct;
    // (A paused player waiting for a length isn't loading: it loads when played.)
    const loading = !audio.paused && (target != null || resumeAt != null || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA);
    wrap.classList.toggle("loading", loading);
    const at = dragging != null ? dragging : target;
    time.textContent = loading && !d ? "loading…" : `${fmt(at != null && d ? at * d : now)} / ${d ? fmt(d) : "–:––"}`;
    const playing = !audio.paused;
    if (play.dataset.icon !== String(playing)) {
      play.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
      play.dataset.icon = String(playing);
    }
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
    if (resumeAt != null && duration()) {
      audio.currentTime = Math.min(resumeAt, duration());
      resumeAt = null;
    }
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
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setSound({ volume: sound.volume + (e.key === "ArrowUp" ? VOLUME_STEP : -VOLUME_STEP), muted: false });
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

  // Another source for the same track: the "Use previews" toggle, or the original of a preview that failed
  // (keepLoading: a player not started yet goes on loading as it was; else it loads the new one when asked).
  // A player that has started carries on from the same moment, playing if it was (or was about to).
  wrap.swapSource = (url, { keepLoading = false } = {}) => {
    if (audio.src === new URL(url, location.href).href) return;
    const at = resumeAt != null ? resumeAt : audio.currentTime;
    const resume = !audio.paused || wanted;
    if (!resume && !(at > 0)) {
      if (!keepLoading) audio.preload = "none";
      audio.src = url;
      paint();
      return;
    }
    resumeAt = at > 0 ? at : null; // a click's target (not loaded yet) stays, for the new source
    audio.src = url;
    if (resume) audio.play().catch(() => {});
    paint();
  };

  paint();
  return wrap;
}

// What to move around for a player's audio: its controls with it.
export const playerOf = (audio) => (audio && audio.bctPlayer) || audio;

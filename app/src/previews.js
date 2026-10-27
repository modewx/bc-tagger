// "Use previews" (on by default): the local players stream the server's preview
// of a file when it has one (Opus 96k, made by the server); off, the original,
// to hear the difference. Kept in this browser. Next to it, what the track
// that's playing (or last played) is heard from.
//
// A stream URL says which of the two it plays (`src=preview` / `src=original`),
// decided when its player is made (or the toggle swaps it): the server serves
// exactly that, so a preview built meanwhile never changes what a playing
// player's URL returns (a seek past the preview's size would fail).

const KEY = "bc_use_previews";
const STREAM = "/api/files/stream";

export function usePreviews() {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch (e) {
    return true;
  }
}

/** The stream URL of a local file: its preview, or the original. */
export function streamUrl(path, preview) {
  return `${STREAM}?path=${encodeURIComponent(path)}&src=${preview ? "preview" : "original"}`;
}

const parse = (url) => {
  try {
    return new URL(url, location.href);
  } catch (e) {
    return null;
  }
};

/** A preview that can't be played (the server no longer has it): the original of the same file; else null. */
export function originalOf(url) {
  const u = parse(url);
  if (!u || u.pathname !== STREAM || u.searchParams.get("src") !== "preview") return null;
  // (Not searchParams.set: it would encode the path another way, so the same file's url wouldn't compare equal.)
  return u.pathname + u.search.replace(/([?&])src=preview(?=&|$)/, "$1src=original");
}

// What a player's URL plays.
function heardFrom(url) {
  const u = parse(url);
  if (!u) return null;
  if (u.pathname !== STREAM) return "Bandcamp stream";
  return u.searchParams.get("src") === "preview" ? "preview" : "original";
}

/**
 * @param {object} o
 * @param {() => void} o.onChange  the setting changed (players take the new source)
 */
export function previewToggle({ onChange }) {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.id = "usePreviews";
  box.checked = usePreviews();
  const label = document.createElement("label");
  label.className = "mode-toggle previews-toggle";
  label.title = "Play the server's preview of a file when it has one (quick to load); off: the original file";
  label.append(box, " Use previews");
  const playing = document.createElement("span");
  playing.id = "playingSource";
  playing.className = "playing-source";
  const el = document.createElement("span");
  el.className = "previews";
  el.append(label, playing);

  let last = null; // the player playing, or last played
  const show = () => {
    const what = last ? heardFrom(last.getAttribute("src") || "") : null;
    playing.textContent = what ? `▶ ${what}` : "";
    playing.title = what ? `The track playing (or last played) is heard from: ${what}` : "";
  };
  box.addEventListener("change", () => {
    try {
      localStorage.setItem(KEY, box.checked ? "1" : "0");
    } catch (e) {
      /* not kept */
    }
    onChange();
    show();
  });
  // Any player starting (rows, the docked player); and its source changing (the toggle, or a preview's fallback).
  document.addEventListener(
    "play",
    (e) => {
      if (e.target && e.target.tagName === "AUDIO" && e.target.dataset.key) {
        last = e.target;
        show();
      }
    },
    true
  );
  document.addEventListener("loadstart", (e) => e.target === last && show(), true);
  return { el };
}

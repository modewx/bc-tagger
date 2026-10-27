// "Use previews" (on by default): the local players stream the server's preview
// of a file when it has one (Opus 96k, made by the server); off, the original
// (`preview=0`), to hear the difference. Kept in this browser. Next to it, what
// the track that's playing (or last played) is heard from.

const KEY = "bc_use_previews";

export function usePreviews() {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch (e) {
    return true;
  }
}

/**
 * @param {object} o
 * @param {() => void} o.onChange                the setting changed (players take the new source)
 * @param {(key: string) => string|null} o.sourceOf  what a row's player is heard from ("preview", "original", ...)
 */
export function previewToggle({ onChange, sourceOf }) {
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

  let lastKey = null;
  const show = () => {
    const what = lastKey ? sourceOf(lastKey) : null;
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
  // Any player starting (rows, the docked player).
  document.addEventListener(
    "play",
    (e) => {
      if (e.target && e.target.tagName === "AUDIO" && e.target.dataset.key) {
        lastKey = e.target.dataset.key;
        show();
      }
    },
    true
  );
  return { el };
}

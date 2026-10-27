// Inline tag editors: the same chosen multi-select widget the Bandcamp content
// script uses for annotation. Relies on the jQuery + chosen globals.

// Tags not in the vocabulary yet (e.g. an import's): offered like the others,
// highlighted in the dropdown and in the chosen chips, created later.
const NEW_TAG_TITLE = "new: not in your tag list yet";
function markNewOption(o, isNew) {
  o.classList.toggle("new-tag", isNew);
  o.title = isNew ? NEW_TAG_TITLE : "";
}

// Chosen copies an option's classes to its dropdown entry but not to the chip of
// a selected tag: mark those chips here.
export function markNewChips(wrap) {
  const sel = wrap.querySelector("select");
  if (!sel) return;
  wrap.querySelectorAll(".chosen-choices li.search-choice").forEach((li) => {
    const close = li.querySelector("a.search-choice-close");
    const o = close ? sel.options[Number(close.dataset.optionArrayIndex)] : null;
    const isNew = !!o && o.classList.contains("new-tag");
    li.classList.toggle("new-tag", isNew);
    li.title = isNew ? NEW_TAG_TITLE : "";
  });
}

// Live updates (an item's tags from the server, a new tag) must never rebuild a
// chosen field under the cursor: chosen:updated clears the search text being
// typed and moves the highlighted result, and chosen picks results by option
// index, so changing the options of an open field can pick the wrong tag. So a
// field is only redrawn when what it shows changed, and a field in use (focused
// or open) gets its update when it's left.
const drawn = new WeakMap(); // select -> the options and selection chosen shows
const stateOf = (sel) =>
  [...sel.options].map((o) => `${o.value}${o.selected ? "\u0001" : ""}${o.classList.contains("new-tag") ? "\u0002" : ""}`).join("\n");

// Chosen shows the select as it is now (after building it, or the user's own pick).
export function chosenDrawn(sel) {
  drawn.set(sel, stateOf(sel));
}

function chosenOf(sel) {
  const c = sel.nextElementSibling;
  return c && c.classList.contains("chosen-container") ? c : null;
}

export function chosenInUse(sel) {
  const c = chosenOf(sel);
  return !!c && (c.classList.contains("chosen-container-active") || c.classList.contains("chosen-with-drop") || c.contains(document.activeElement));
}

const deferred = new WeakMap(); // select -> Map(name -> the update waiting for the field to be left)

// Run `update` now, or once the field is left. Per `name`, the latest update
// waiting wins (it reads the data when it runs).
export function whenChosenFree(sel, update, name = "sync") {
  if (!chosenInUse(sel)) {
    update();
    return;
  }
  const waiting = deferred.get(sel);
  if (waiting) {
    waiting.set(name, update);
    return;
  }
  deferred.set(sel, new Map([[name, update]]));
  const c = chosenOf(sel);
  const check = () =>
    setTimeout(() => {
      if (!deferred.has(sel) || chosenInUse(sel)) return;
      c.removeEventListener("focusout", check);
      const updates = deferred.get(sel);
      deferred.delete(sel);
      updates.forEach((fn) => fn());
    }, 150); // chosen closes its dropdown ~100 ms after the blur
  c.addEventListener("focusout", check);
}

// chosen:updated, only if the select changed since chosen last drew it.
export function redrawChosen(sel) {
  if (drawn.get(sel) === stateOf(sel)) return;
  $(sel).trigger("chosen:updated");
  chosenDrawn(sel);
}

// Build a chosen tag editor wrapped in a div so the whole widget can be moved
// (teleported) as one element between a row and the top bar. Options: the
// vocabulary, then `newTags` (highlighted), then any other tag the item has
// (an item's tags are never dropped).
export function buildTagEditorWrap(item, key, vocab, onChange, newTags = []) {
  const wrap = document.createElement("div");
  wrap.className = "tag-editor-wrap";
  wrap.dataset.key = key;

  const current = Array.isArray(item.tags) ? item.tags : [];
  const sel = document.createElement("select");
  sel.multiple = true;
  sel.className = "chosen-select tag-editor";
  sel.setAttribute("data-placeholder", "Add tags...");

  const seen = {};
  [...vocab, ...newTags].forEach((t) => {
    if (seen[t]) return;
    seen[t] = true;
    const o = new Option(t, t, false, current.includes(t));
    markNewOption(o, newTags.includes(t) && !vocab.includes(t));
    sel.appendChild(o);
  });
  current.forEach((t) => {
    if (!seen[t]) sel.appendChild(new Option(t, t, false, true));
  });

  wrap.appendChild(sel);
  const $sel = $(sel);
  $sel.chosen({ width: "100%", no_results_text: "No tag" });
  chosenDrawn(sel);
  const choices = wrap.querySelector(".chosen-choices");
  if (choices) new MutationObserver(() => markNewChips(wrap)).observe(choices, { childList: true });
  markNewChips(wrap);
  $sel.on("change", () => {
    chosenDrawn(sel);
    const tags = $sel.val() || [];
    item.tags = tags;
    onChange(key, tags, wrap);
  });
  return wrap;
}

// Reconcile a chosen multi-select's options with the current vocabulary: add new
// tags, drop deleted ones, keep current selections. (Same approach the Bandcamp
// content script uses for live tag updates.) `newTags` are offered too, highlighted.
// A field in use is updated once it's left.
export function syncChosenOptions(sel, vocab, newTags = []) {
  whenChosenFree(sel, () => syncNow(sel, vocab, newTags));
}

function syncNow(sel, vocab, newTags) {
  const isNew = (t) => newTags.includes(t) && !vocab.includes(t);
  const tags = [...vocab, ...newTags.filter(isNew)];
  const $sel = $(sel);
  const selected = $sel.val() || [];
  const keep = {};
  tags.forEach((t) => (keep[t] = true));
  selected.forEach((t) => (keep[t] = true));
  const have = {};
  [...sel.querySelectorAll("option")].forEach((o) => {
    if (o.value === "") return; // keep placeholder
    if (keep[o.value]) have[o.value] = true;
    else o.remove();
  });
  tags.forEach((t) => {
    if (!have[t]) sel.appendChild(new Option(t, t));
  });
  [...sel.options].forEach((o) => o.value && markNewOption(o, isNew(o.value)));
  $sel.val(selected);
  redrawChosen(sel);
  const wrap = sel.closest(".tag-editor-wrap");
  if (wrap) markNewChips(wrap);
}

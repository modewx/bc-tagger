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
  const choices = wrap.querySelector(".chosen-choices");
  if (choices) new MutationObserver(() => markNewChips(wrap)).observe(choices, { childList: true });
  markNewChips(wrap);
  $sel.on("change", () => {
    const tags = $sel.val() || [];
    item.tags = tags;
    onChange(key, tags, wrap);
  });
  return wrap;
}

// Reconcile a chosen multi-select's options with the current vocabulary: add new
// tags, drop deleted ones, keep current selections. (Same approach the Bandcamp
// content script uses for live tag updates.) `newTags` are offered too, highlighted.
export function syncChosenOptions(sel, vocab, newTags = []) {
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
  $sel.trigger("chosen:updated");
  const wrap = sel.closest(".tag-editor-wrap");
  if (wrap) markNewChips(wrap);
}

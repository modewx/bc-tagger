// Inline tag editors: the same chosen multi-select widget the Bandcamp content
// script uses for annotation. Relies on the jQuery + chosen globals.

// Build a chosen tag editor wrapped in a div so the whole widget can be moved
// (teleported) as one element between a row and the top bar.
export function buildTagEditorWrap(item, key, vocab, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "tag-editor-wrap";
  wrap.dataset.key = key;

  const current = Array.isArray(item.tags) ? item.tags : [];
  const sel = document.createElement("select");
  sel.multiple = true;
  sel.className = "chosen-select tag-editor";
  sel.setAttribute("data-placeholder", "Add tags...");

  const seen = {};
  vocab.forEach((t) => {
    seen[t] = true;
    sel.appendChild(new Option(t, t, false, current.includes(t)));
  });
  current.forEach((t) => {
    if (!seen[t]) sel.appendChild(new Option(t, t, false, true));
  });

  wrap.appendChild(sel);
  const $sel = $(sel);
  $sel.chosen({ width: "100%", no_results_text: "No tag" });
  $sel.on("change", () => {
    const tags = $sel.val() || [];
    item.tags = tags;
    onChange(key, tags, wrap);
  });
  return wrap;
}

// Reconcile a chosen multi-select's options with the current vocabulary: add new
// tags, drop deleted ones, keep current selections. (Same approach the Bandcamp
// content script uses for live tag updates.)
export function syncChosenOptions(sel, tags) {
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
  $sel.val(selected);
  $sel.trigger("chosen:updated");
}

// "Tag N selected" (collection and import pages): one tag box, under the player, for every selected row at once.
// It shows the tags all of them have (the others: "+N tags on some rows"). Adding a tag adds it to each, removing one
// removes it from each, and each row keeps its other tags. Selected rows count even when the filter hides them (the
// box says how many). The rows' Tags cells change at once; the page saves the change in one go (`save`).

import { chosenDrawn, redrawChosen, whenChosenFree } from "../../shared/collection/tagEditor";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * @param {object} o
 * @param {object} o.page      the collection page (getItems, getView, setTagsLocally, getVocabulary)
 * @param {function} o.selected  () → the selected rows' keys
 * @param {function} o.save      ({add, remove, edits: [{id, tags}]}) → Promise of a line for the box, or nothing
 */
export function createBulkTagger({ page, selected, save }) {
  const box = el("div", "bulk-tagger");
  box.id = "bulkTagger";
  box.hidden = true;
  const head = el("div", "bulk-head");
  const title = el("span", "bulk-title");
  title.id = "bulkTitle";
  const hiddenNote = el("span", "bulk-hidden");
  hiddenNote.id = "bulkHidden";
  head.append(title, hiddenNote);
  const sel = document.createElement("select");
  sel.multiple = true;
  sel.id = "bulkTagSelect";
  sel.className = "chosen-select bulk-tag-editor";
  sel.setAttribute("data-placeholder", "Add a tag to all of them…");
  const some = el("div", "bulk-some");
  some.id = "bulkSome";
  const state = el("div", "bulk-state");
  state.id = "bulkState";
  box.append(head, sel, some, state);

  let keys = [];
  let common = []; // the tags every selected row has: what the field shows
  let built = false;

  const tagsOf = (k) => ((page.getItems()[k] || {}).tags || []).slice();

  // The field's options: the vocabulary, the new tags (an import's), and any tag a selected row has.
  function options(extra) {
    const { vocab, newTags } = page.getVocabulary();
    const want = [...new Set([...vocab, ...newTags, ...extra])];
    const have = new Set([...sel.options].map((o) => o.value));
    want.forEach((t) => !have.has(t) && sel.appendChild(new Option(t, t)));
    [...sel.options].forEach((o) => (o.selected = common.includes(o.value)));
  }

  function build() {
    if (built) return;
    built = true;
    $(sel).chosen({ width: "100%", no_results_text: "No tag" });
    chosenDrawn(sel);
    $(sel).on("change", onChange);
  }

  // Follow the rows: the selection, and their tags (changed here, in a row, or elsewhere). Not under the cursor:
  // a field in use is updated once it's left.
  function refresh() {
    keys = selected();
    box.hidden = !keys.length;
    if (!keys.length) return;
    build();
    const shown = page.getView();
    const hidden = keys.filter((k) => !(k in shown)).length;
    title.textContent = `Tag ${keys.length} selected`;
    hiddenNote.textContent = hidden ? `${hidden} of them hidden by the filter` : "";
    whenChosenFree(sel, () => {
      const lists = keys.map(tagsOf);
      const all = new Set(lists.flat());
      common = [...all].filter((t) => lists.every((l) => l.includes(t)));
      const partial = [...all].filter((t) => !common.includes(t)).sort((a, b) => a.localeCompare(b));
      some.textContent = partial.length ? `+${partial.length} tag${partial.length > 1 ? "s" : ""} on some rows` : "";
      some.title = partial.join(", ");
      options([...all]);
      redrawChosen(sel);
    }, "bulk");
  }

  async function onChange() {
    chosenDrawn(sel);
    const now = $(sel).val() || [];
    const add = now.filter((t) => !common.includes(t));
    const remove = common.filter((t) => !now.includes(t));
    if (!add.length && !remove.length) return;
    keys = selected();
    const edits = keys
      .map((id) => {
        const tags = tagsOf(id);
        const next = [...tags.filter((t) => !remove.includes(t)), ...add.filter((t) => !tags.includes(t))];
        return { id, tags: next };
      })
      .filter((e, i) => JSON.stringify(e.tags) !== JSON.stringify(tagsOf(keys[i])));
    const changed = page.setTagsLocally(edits);
    common = [...common.filter((t) => !remove.includes(t)), ...add];
    state.textContent = "Saving…";
    state.className = "bulk-state";
    refresh();
    let line = "";
    try {
      line = (await save({ add, remove, edits: changed })) || "";
    } catch (e) {
      line = `Not saved: ${e.message}`;
    }
    state.textContent = line;
    state.classList.toggle("err", /^Not saved|not saved/.test(line));
  }

  return { el: box, refresh };
}

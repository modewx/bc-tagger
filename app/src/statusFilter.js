// "Show" filter for the local app: narrow the collection by local / owned /
// rekordbox status (combined with the search box and the tag filter).

const STORAGE_KEY = "bc_app_status_filter";

const local = (it) => (it.local || {}).status || "unknown";
const owned = (it) => (it.owned || {}).status || "unknown";
const rb = (it) => (it.rekordbox || {}).status || "none";

export const STATUS_FILTERS = [
  ["all", "All items", () => true],
  ["export_ready", "Located, not in rekordbox", (it) => local(it) === "located" && rb(it) !== "exported"],
  ["in_rekordbox", "In rekordbox", (it) => rb(it) === "exported" || rb(it) === "partial"],
  ["located", "Located", (it) => local(it) === "located"],
  ["candidates", "Needs confirming", (it) => local(it) === "candidates"],
  ["missing", "Not found locally", (it) => local(it) === "missing"],
  ["unknown", "Not located yet", (it) => local(it) === "unknown"],
  ["owned", "Owned", (it) => owned(it) === "owned"],
  ["owned_missing", "Owned, not found locally", (it) => owned(it) === "owned" && local(it) === "missing"],
  ["not_owned", "Not owned", (it) => owned(it) === "not_owned"],
  ["hints", "With a warning (!)", (it) => ((it.local || {}).hints || []).length > 0],
];

export function createStatusFilter() {
  let current = "all";
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (STATUS_FILTERS.some(([id]) => id === saved)) current = saved;
  } catch (e) {
    /* ignore */
  }
  const predicate = () => STATUS_FILTERS.find(([id]) => id === current)[2];

  const label = document.createElement("label");
  label.className = "status-filter";
  label.htmlFor = "statusFilter";
  label.textContent = "Show";
  const select = document.createElement("select");
  select.id = "statusFilter";
  STATUS_FILTERS.forEach(([id, text]) => select.appendChild(new Option(text, id, false, id === current)));
  const count = document.createElement("span");
  count.id = "viewCount";
  const empty = document.createElement("p");
  empty.id = "emptyState";
  empty.hidden = true;

  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, current);
    } catch (e) {
      /* ignore */
    }
  };

  return {
    active: () => current !== "all",
    // Back to "All items" (Go To Playing clears every filter); the page re-renders.
    reset() {
      current = "all";
      select.value = current;
      save();
    },
    filterItem: (item) => predicate()(item),
    onView: (shown, total) => {
      count.textContent = shown === total ? `${total} items` : `${shown} of ${total}`;
      empty.hidden = shown > 0 || total === 0;
      empty.textContent = `No items match the search, tag filter and “${select.selectedOptions[0].text}”.`;
    },
    // Put the controls next to the search box (and the empty-state note after
    // the table); `refilter` re-runs the view.
    mount(container, afterTable, refilter) {
      const group = document.createElement("span");
      group.className = "status-filter-group"; // wraps as one unit
      group.append(label, select, count);
      container.append(group);
      afterTable.after(empty);
      select.addEventListener("change", () => {
        current = select.value;
        save();
        refilter();
      });
    },
  };
}

// "Bandcamp" / "Other" checkboxes: which collections to show. Items from an
// older server have no `source`: they're Bandcamp (tagger) items.
const SOURCE_KEY = "bc_app_source_filter";

export const sourceOf = (item) => (item && item.source === "other" ? "other" : "bandcamp");

export function createSourceFilter() {
  let shown = { bandcamp: true, other: true };
  try {
    shown = { ...shown, ...JSON.parse(localStorage.getItem(SOURCE_KEY) || "{}") };
  } catch (e) {
    /* ignore */
  }
  const wrap = document.createElement("span");
  wrap.className = "source-filter";
  const boxes = {};
  [
    ["bandcamp", "Bandcamp"],
    ["other", "Other"],
  ].forEach(([id, label]) => {
    const l = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `source_${id}`;
    box.checked = shown[id] !== false;
    boxes[id] = box;
    l.append(box, " " + label);
    wrap.appendChild(l);
  });
  return {
    filterItem: (item) => shown[sourceOf(item)] !== false,
    active: () => !shown.bandcamp || !shown.other,
    reset() {
      shown = { bandcamp: true, other: true };
      Object.values(boxes).forEach((b) => (b.checked = true));
    },
    mount(container, refilter) {
      container.appendChild(wrap);
      Object.entries(boxes).forEach(([id, box]) =>
        box.addEventListener("change", () => {
          shown[id] = box.checked;
          try {
            localStorage.setItem(SOURCE_KEY, JSON.stringify(shown));
          } catch (e) {
            /* ignore */
          }
          refilter();
        })
      );
    },
  };
}

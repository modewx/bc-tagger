// Persisted per-column widths (survive re-renders and reloads), stored by
// column id under a per-page localStorage key, so adding or reordering
// columns never shifts them onto the wrong column.
function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch (e) {
    return {};
  }
}
function save(key, w) {
  try {
    localStorage.setItem(key, JSON.stringify(w));
  } catch (e) {
    /* ignore */
  }
}

// Widths saved by position under an older key: map them to ids with the
// column order that key was written with, once.
function migrate(storageKey, legacy) {
  if (!legacy || !legacy.key) return;
  try {
    if (localStorage.getItem(storageKey) != null) return;
    const old = JSON.parse(localStorage.getItem(legacy.key) || "null");
    if (!old) return;
    const byId = {};
    Object.entries(old).forEach(([i, w]) => {
      const id = legacy.order[Number(i)];
      if (id && w) byId[id] = w;
    });
    save(storageKey, byId);
  } catch (e) {
    /* ignore */
  }
}

/**
 * Make each header draggable on its right edge to resize its column.
 * @param {HTMLTableElement} table
 * @param {string} storageKey
 * @param {string[]} ids          column ids, in header order
 * @param {{key: string, order: string[]}} [legacy]  position-based widths to migrate
 */
export function setupColumnResizing(table, storageKey, ids, legacy) {
  migrate(storageKey, legacy);
  const ths = [...table.querySelectorAll("thead th")];
  const widths = load(storageKey);
  ths.forEach((th, i) => {
    const id = ids[i];
    if (widths[id]) th.style.width = widths[id] + "px";
    const grip = document.createElement("div");
    grip.className = "col-resizer";
    grip.title = "Drag to resize · double-click to reset";
    th.appendChild(grip);
    grip.addEventListener("click", (e) => e.stopPropagation()); // don't sort when resizing
    grip.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      th.style.width = "";
      const saved = load(storageKey);
      delete saved[id];
      save(storageKey, saved);
    });
    grip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.pageX;
      const startW = th.offsetWidth;
      const onMove = (ev) => {
        th.style.width = Math.max(40, startW + ev.pageX - startX) + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        const saved = load(storageKey);
        saved[id] = th.offsetWidth;
        save(storageKey, saved);
      };
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
  // Self-heal: saved widths that leave a column without a width of its own
  // squeezed to a sliver (e.g. after a layout change) are dropped.
  requestAnimationFrame(() => {
    if (!table.offsetWidth) return; // not shown: nothing to measure
    const squeezed = ths.some((th, i) => !widths[ids[i]] && th.offsetWidth < 36);
    if (squeezed && Object.keys(widths).length) {
      save(storageKey, {});
      ths.forEach((th) => (th.style.width = ""));
    }
  });
}

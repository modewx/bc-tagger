// Persisted per-column widths (survive re-renders and reloads), stored by
// column position under a per-page localStorage key.
function loadColWidths(storageKey) {
  try {
    return JSON.parse(localStorage.getItem(storageKey)) || {};
  } catch (e) {
    return {};
  }
}
function saveColWidths(storageKey, w) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(w));
  } catch (e) {
    /* ignore */
  }
}

// Make each header draggable on its right edge to resize its column.
export function setupColumnResizing(table, storageKey) {
  const ths = [...table.querySelectorAll("thead th")];
  const widths = loadColWidths(storageKey);
  ths.forEach((th, i) => {
    if (widths[i]) th.style.width = widths[i] + "px";
    const grip = document.createElement("div");
    grip.className = "col-resizer";
    th.appendChild(grip);
    grip.addEventListener("click", (e) => e.stopPropagation()); // don't sort when resizing
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
        const saved = loadColWidths(storageKey);
        saved[i] = th.offsetWidth;
        saveColWidths(storageKey, saved);
      };
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

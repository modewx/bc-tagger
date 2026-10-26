// A single small popover anchored to a table cell (match details, candidates).
// Closes on outside click, Escape, or scroll of the anchor out of view.

let current = null;

export function closePopover() {
  if (!current) return;
  current.el.remove();
  document.removeEventListener("mousedown", current.onDown, true);
  document.removeEventListener("keydown", current.onKey, true);
  current = null;
}

export function openPopover(anchor, build) {
  const reopen = current && current.anchor === anchor;
  closePopover();
  if (reopen) return null; // second click on the same anchor toggles it off

  const el = document.createElement("div");
  el.className = "popover";
  build(el);
  document.body.appendChild(el);

  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const left = Math.max(8, Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - w - 8));
  el.style.left = left + "px";
  el.style.top = window.scrollY + r.bottom + 4 + "px";

  const onDown = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover();
  };
  const onKey = (e) => {
    if (e.key === "Escape") closePopover();
  };
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  current = { el, anchor, onDown, onKey };
  return el;
}

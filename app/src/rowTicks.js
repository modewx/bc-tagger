// Ticking rows on the collection page and the import preview: a tick on a
// highlighted row applies to every highlighted row, and Shift on a checkbox
// ticks the range from the last checkbox clicked (Gmail-style). Returns the
// keys a tick on `key` applies to.
export function tickTargets(page, key, shift, lastKey) {
  if (shift && lastKey && lastKey !== key) return page.rangeKeys(lastKey, key);
  if (page.isHighlighted(key)) return page.highlightedKeys();
  return [key];
}

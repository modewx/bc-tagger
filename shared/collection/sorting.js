// --- Sorting ---------------------------------------------------------------

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function tagRank(tags) {
  if (tags.includes("must")) return 0;
  if (tags.includes("pool")) return 1;
  return 2; // neither -> last
}

// Tags minus the special must/pool, sorted alphabetically (the disambiguator).
function secondaryTags(tags) {
  return tags.filter((t) => t !== "must" && t !== "pool").sort();
}

function cmpTagArrays(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length; // shorter prefix first
}

export function cmpTags(a, b) {
  const ta = a.tags || [];
  const tb = b.tags || [];
  const ra = tagRank(ta);
  const rb = tagRank(tb);
  if (ra !== rb) return ra - rb;
  return cmpTagArrays(secondaryTags(ta), secondaryTags(tb));
}

export function cmpDate(a, b) {
  return (Date.parse(a.date_added) || 0) - (Date.parse(b.date_added) || 0);
}

export function cmpText(field) {
  return (a, b) =>
    String(a[field] || "").toLowerCase().localeCompare(String(b[field] || "").toLowerCase());
}

// --- Search ----------------------------------------------------------------

// A "label" proxy: the bandcamp subdomain (often the label/artist account).
function labelOf(item) {
  const u = item.url || item.album_url || item.item_url;
  try {
    return new URL(u).host.replace(/\.bandcamp\.com$/, "");
  } catch (e) {
    return "";
  }
}

function searchHaystack(item) {
  return [item.title, item.artist, item.album_title, labelOf(item)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

// Multi-term substring match (every whitespace-separated term must appear).
export function matchesSearch(item, terms) {
  if (!terms.length) return true;
  const hay = searchHaystack(item);
  return terms.every((t) => hay.includes(t));
}

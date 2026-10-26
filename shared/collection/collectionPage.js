// The collection page (table, players, inline tag editing, search/sort/filter,
// column resizing, Bandcamp refresh tools), shared by the extension's bundled
// "See Collection" page and the local app. All data access goes through a
// DataSource (see shared/datasource/); page-specific columns and toolbar
// buttons are passed in as options.
//
// Relies on the jQuery + chosen globals (loaded by <script> tags).

import {
  streamUrlOf,
  isPlayable,
  pickStreamFromTralbum,
  pageUrlFor,
  tralbumOf,
  embedSrcFromKey,
  thumbUrl,
  artUrlFromPage,
  splitArtistFromTitle,
  createBandcampFetcher,
} from "./bandcamp";
import { fmtDate, cmpDate, cmpText, cmpTags, matchesSearch } from "./sorting";
import { setupColumnResizing } from "./columnResize";
import { buildTagEditorWrap, syncChosenOptions } from "./tagEditor";

const SHELL_HTML = `
  <div id="topBar">
    <div id="topControls">
      <div id="searchBar">
        <label for="searchInput">Search</label>
        <input type="text" id="searchInput" placeholder="title, artist, album, label..." autocomplete="off" />
      </div>
      <div id="tagFilter">
        <label for="tagFilterSelect">Filter by tags</label>
        <select id="tagFilterSelect" multiple class="chosen-select" data-placeholder="Type tags to filter..."></select>
        <label class="filter-mode"><input type="checkbox" id="filterAnd" checked /> AND</label>
        <label class="filter-mode"><input type="checkbox" id="filterOr" /> OR</label>
      </div>
      <div id="toolbar">
        <span id="refreshStatus"></span>
      </div>
    </div>
    <div id="playerArea">
      <div id="globalPlayer" class="hidden">
        <div id="gpInfo">
          <div id="gpTitle"></div>
          <div id="gpArtist"></div>
        </div>
        <div id="gpPlayerCol">
          <div id="gpAudioHolder"></div>
          <button id="gpGoto">Go To Playing</button>
        </div>
        <div id="gpTagHolder"></div>
      </div>
      <label class="mode-toggle"><input type="checkbox" id="globalModeToggle" /> global player</label>
    </div>
  </div>
  <table id="collectionTable">
    <!-- Table content will be generated dynamically -->
  </table>
`;

/**
 * @param {object} opts
 * @param {object} opts.dataSource          see shared/datasource/DataSource.js
 * @param {HTMLElement} [opts.mount]        where the page shell is inserted (prepended)
 * @param {HTMLElement} [opts.topBarStart]  extra element placed first in the sticky top bar
 * @param {string} [opts.colWidthKey]       localStorage key for the resized column widths (by column id)
 * @param {object} [opts.legacyColWidths]   {key, order}: older position-based widths to migrate once
 * @param {Array}  [opts.extraColumns]      [{id, label, after, sortKey?, compare?(a,b), render(cell,key,item)}]
 * @param {Array}  [opts.extraToolbarButtons] [{id, label, run(statusEl, button)}] after the base buttons
 * @param {function} [opts.localPlayUrl]    (item, key) -> url of a local file to play, or null
 * @param {function} [opts.filterItem]      (item) -> false hides the row (extra filters, e.g. statuses)
 * @param {function} [opts.onView]          (shown, total) after each filter/search
 * @param {function} [opts.clearExtraFilters] reset the extra filters (Go To Playing)
 * @param {boolean}  [opts.baseToolbar]     false hides the Bandcamp tools (refresh players, ...)
 * @param {function} [opts.rowClass]        (item, key) -> extra class names for the row
 * @param {function} [opts.titleUrl]        (item) -> link for the title, instead of its Bandcamp page
 * @param {function} [opts.playable]        (item) -> false: nothing to play (no Bandcamp page, no local file)
 *
 * Columns may also have headerRender(th) to fill their header themselves, and
 * first: true to go before every other column.
 */
export function createCollectionPage(opts) {
  const ds = opts.dataSource;
  const mount = opts.mount || document.body;
  const colWidthKey = opts.colWidthKey || "bc_collection_col_widths_by_id";
  const bc = createBandcampFetcher((url, o) => ds.fetchPage(url, o));
  const { fetchFreshStream, resolveAlbumDoc, resolveItemArt, resolveTrackTralbum, resolveTrackPlayerData } = bc;

  // --- Shell -----------------------------------------------------------------
  const shell = document.createElement("div");
  shell.innerHTML = SHELL_HTML;
  mount.prepend(...shell.childNodes);
  if (opts.topBarStart) document.getElementById("topBar").prepend(opts.topBarStart);

  const BASE_TOOLBAR = [
    { id: "refreshPlayers", label: "Refresh player files", run: refreshAllFiles },
    { id: "refreshThumbs", label: "Refresh thumbnails", run: refreshAllThumbnails },
    { id: "fixArtists", label: "Fix artists", run: fixArtists },
    {
      id: "fixAlbumIds",
      label: "Fix album IDs",
      title: "Read the real album of tracks tagged on their own page (needed to see ownership through the album)",
      run: fixAlbumIds,
    },
  ];
  const toolbar = document.getElementById("toolbar");
  const statusEl = document.getElementById("refreshStatus");
  [...(opts.baseToolbar === false ? [] : BASE_TOOLBAR), ...(opts.extraToolbarButtons || [])].forEach((b) => {
    const btn = document.createElement("button");
    btn.id = b.id;
    btn.className = "toolbar-btn" + (b.className ? " " + b.className : "");
    btn.textContent = b.label;
    if (b.title) btn.title = b.title;
    btn.addEventListener("click", () => b.run(statusEl, btn));
    toolbar.insertBefore(btn, statusEl);
  });

  // ---------------------------------------------------------------------------
  // Players
  //
  // Two modes (toggle top-right, persisted):
  //  - Per-row (default): each track row has its own <audio>; one plays at a time
  //    (others pause). Good for skimming. Playback stops on re-render.
  //  - Global: one persistent <audio> in the sticky top bar that survives
  //    re-renders, so you can keep listening while sorting/filtering.
  // "Now Playing" + Go To Playing + the playing-row highlight work in both modes.
  // ---------------------------------------------------------------------------

  let globalMode = (() => {
    try {
      return localStorage.getItem("bc_global_player_mode") === "1";
    } catch (e) {
      return false;
    }
  })();
  let playingKey = null;
  let playingItem = null;
  let playingAudio = null; // the single <audio> that is (or last was) current
  let playingTagWrap = null; // the playing track's tag editor (teleports with it)

  // Reposition the live player on scroll/resize (header-aware), rAF-throttled, so
  // it docks to the top bar when its row is hidden behind the header / off screen
  // and returns to the row when the row is visible again.
  let placeScheduled = false;
  function schedulePlace() {
    if (placeScheduled) return;
    placeScheduled = true;
    requestAnimationFrame(() => {
      placeScheduled = false;
      placePlaying();
    });
  }
  window.addEventListener("scroll", schedulePlace, { passive: true });
  window.addEventListener("resize", schedulePlace);

  function nowPlayingBox() {
    return {
      wrap: document.getElementById("globalPlayer"),
      holder: document.getElementById("gpAudioHolder"),
      tagHolder: document.getElementById("gpTagHolder"),
      title: document.getElementById("gpTitle"),
      artist: document.getElementById("gpArtist"),
    };
  }

  function highlightPlayingRow() {
    const table = document.getElementById("collectionTable");
    if (!table) return;
    table.querySelectorAll("tr.playing-row").forEach((r) => r.classList.remove("playing-row"));
    if (!playingKey) return;
    const row = table.querySelector(`tr[data-key="${playingKey}"]`);
    if (row) row.classList.add("playing-row");
  }

  // Per-row mode: a title + Go To Playing indicator at the top (no teleport).
  function updateNowPlaying(item) {
    const { wrap, title, artist } = nowPlayingBox();
    if (!item) {
      wrap.classList.add("hidden");
      return;
    }
    title.textContent = item.title || "";
    artist.textContent = item.artist || "";
    wrap.classList.remove("hidden");
  }

  function isElementInView(el) {
    const r = el.getBoundingClientRect();
    const bar = document.getElementById("topBar");
    const barH = bar ? bar.offsetHeight : 0;
    return r.bottom > barH + 4 && r.top < (window.innerHeight || document.documentElement.clientHeight);
  }

  function playButton(label) {
    const btn = document.createElement("button");
    btn.className = "player-btn";
    btn.textContent = label;
    return btn;
  }

  // A real per-row <audio>. Hover loads metadata (so the timeline is seekable
  // before play); clicking the timeline while paused starts playback there.
  function makeRowAudio(url, item, key) {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = url;

    audio.addEventListener(
      "pointerenter",
      () => {
        if (audio.preload !== "metadata") {
          audio.preload = "metadata";
          audio.load();
        }
      },
      { once: true }
    );
    audio.addEventListener("seeked", () => {
      if (audio.paused) audio.play().catch(() => {});
    });
    audio.addEventListener("play", () => onAudioPlay(audio, item, key));
    // On end, keep the player in place (shows the play button at the end of the
    // track); it only moves/changes when another track starts.
    return audio;
  }

  // A local-file <audio> (local app). If the file can't be decoded/streamed,
  // fall back to the Bandcamp player for this row and stop trying local.
  function makeLocalAudio(url, item, key) {
    const audio = makeRowAudio(url, item, key);
    audio.classList.add("local-audio");
    audio.addEventListener("error", () => {
      item._localFailed = true;
      const wasCurrent = playingAudio === audio;
      if (wasCurrent) playingAudio = null;
      audio.remove(); // may be docked in the top bar (global mode)
      const cell = document.querySelector(`#collectionTable tr[data-key="${key}"] td.player-cell`);
      if (!cell) return;
      renderPlayerCell(cell, key, item);
      cell.title = "The local file could not be played; using the Bandcamp player.";
      if (wasCurrent) {
        const fallback = cell.querySelector("audio");
        if (fallback) fallback.play().catch(() => {});
      }
    });
    return audio;
  }

  // Any row audio that starts playing becomes the single current player (others
  // pause). In global mode the element then teleports between its row and the top
  // bar; in per-row mode it stays put (and playback ends on the next re-render).
  function onAudioPlay(audio, item, key) {
    if (playingAudio && playingAudio !== audio) {
      try { playingAudio.pause(); } catch (e) { /* ignore */ }
      if (globalMode) {
        returnToRow(playingAudio, playingKey);
        returnTagWrapToRow(playingTagWrap, playingKey);
      }
    }
    if (globalMode && key !== playingKey) playingTagWrap = null; // new track -> its own editor
    playingAudio = audio;
    playingKey = key;
    playingItem = item;
    highlightPlayingRow();
    if (globalMode) {
      ensurePlayingTagWrap();
      placePlaying();
    } else {
      updateNowPlaying(item);
    }
  }

  // Put `audio` in a row's player cell as its only player: anything else
  // there (a fresh player rendered meanwhile, a Play button) is dropped, so a
  // row never shows two players for its track.
  function dockInto(cell, audio) {
    [...cell.children].forEach((child) => {
      if (child === audio) return;
      child.querySelectorAll("audio").forEach((a) => a.pause());
      if (child.tagName === "AUDIO") child.pause();
      child.remove();
    });
    if (audio.parentElement !== cell) cell.appendChild(audio);
  }

  // Move a no-longer-current audio back into its own row cell, or drop it.
  function returnToRow(audio, key) {
    const cell = document.querySelector(`#collectionTable tr[data-key="${key}"] td.player-cell`);
    if (cell) {
      dockInto(cell, audio);
    } else if (audio.parentElement) {
      audio.remove();
    }
  }

  // Global mode: keep the live audio in its row while the row is on screen; dock
  // it in the top bar otherwise, so playback + controls survive scroll/filter.
  // "On screen" = below the sticky header and above the viewport bottom.
  let suppressPlaceUntil = 0; // during a Go-To-Playing smooth scroll

  function placePlaying() {
    if (!globalMode || !playingAudio) return;
    if (Date.now() < suppressPlaceUntil) return; // let Go To Playing settle
    ensurePlayingTagWrap();
    const { wrap, holder, tagHolder, title, artist } = nowPlayingBox();
    const row = playingKey
      ? document.querySelector(`#collectionTable tr[data-key="${playingKey}"]`)
      : null;
    const cell = row ? row.querySelector("td.player-cell") : null;
    const tagsCell = row ? row.querySelector("td.tags-cell") : null;
    if (cell && isElementInView(cell)) {
      dockInto(cell, playingAudio);
      if (playingTagWrap && tagsCell && playingTagWrap.parentElement !== tagsCell) {
        tagsCell.innerHTML = "";
        tagsCell.appendChild(playingTagWrap);
      }
      wrap.classList.add("hidden");
    } else {
      if (playingAudio.parentElement !== holder) {
        [...holder.querySelectorAll("audio")].forEach((a) => {
          if (a !== playingAudio) a.remove();
        });
        holder.appendChild(playingAudio);
      }
      if (playingTagWrap && playingTagWrap.parentElement !== tagHolder) {
        [...tagHolder.querySelectorAll(".tag-editor-wrap")].forEach((w) => {
          if (w !== playingTagWrap) w.remove();
        });
        tagHolder.appendChild(playingTagWrap);
      }
      title.textContent = (playingItem && playingItem.title) || "";
      artist.textContent = (playingItem && playingItem.artist) || "";
      wrap.classList.remove("hidden");
    }
  }

  // Play a track in a row (used by the row-click shortcut and the Play button for
  // not-yet-resolved tracks): reuse an existing audio, else resolve a link first.
  async function playTrack(item, key, cell, btn) {
    if (!cell) return;
    if (cell.querySelector("iframe")) return; // the full Bandcamp player is loaded: use it
    const existing = cell.querySelector("audio");
    if (existing) {
      existing.play().catch(() => {}); // reuse (no-op if it's already playing)
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "Loading..."; }
    let url = isPlayable(item) ? streamUrlOf(item) : null;
    if (!url) {
      try {
        url = await fetchFreshStream(item);
        if (url) {
          item.file = { "mp3-128": url };
          ds.persistFiles({ [key]: item.file });
        }
      } catch (e) {
        console.warn("play load failed", key, (e && e.message) || e);
      }
    }
    if (btn) { btn.disabled = false; btn.textContent = "▶ Play"; }
    if (!url) {
      loadEmbed(cell, key);
      return;
    }
    cell.innerHTML = "";
    const audio = makeRowAudio(url, item, key);
    cell.appendChild(audio);
    audio.play().catch(() => {});
  }

  function goToPlaying() {
    if (!playingKey) return;
    let row = document.querySelector(`#collectionTable tr[data-key="${playingKey}"]`);
    if (!row) {
      // Playing track is filtered/searched out -> clear filters and re-render.
      document.getElementById("searchInput").value = "";
      $("#tagFilterSelect").val([]).trigger("chosen:updated");
      if (opts.clearExtraFilters) opts.clearExtraFilters();
      computeView();
      row = document.querySelector(`#collectionTable tr[data-key="${playingKey}"]`);
    }
    if (!row) return;
    // Immediately dock the player + tag editor back into the row, then scroll to
    // it (and keep them there during the smooth scroll).
    if (globalMode && playingAudio) {
      const cell = row.querySelector("td.player-cell");
      if (cell) dockInto(cell, playingAudio);
      const tagsCell = row.querySelector("td.tags-cell");
      if (playingTagWrap && tagsCell && playingTagWrap.parentElement !== tagsCell) {
        tagsCell.innerHTML = "";
        tagsCell.appendChild(playingTagWrap);
      }
      nowPlayingBox().wrap.classList.add("hidden");
      suppressPlaceUntil = Date.now() + 800;
    }
    row.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ---------------------------------------------------------------------------
  // Thumbnails
  // ---------------------------------------------------------------------------

  // Lazily fetch a row's thumbnail only when it scrolls near view, so we never
  // burst-fetch the whole collection at once (which gets rate-limited).
  const thumbObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const cell = entry.target;
        thumbObserver.unobserve(cell);
        const item = cell._item;
        const key = cell._key;
        if (!item) return;
        resolveItemArt(item).then((url) => {
          if (!url) return;
          item.art_url = url;
          ds.persistArt({ [key]: url });
          const img = document.createElement("img");
          img.loading = "lazy";
          img.alt = "";
          img.src = url;
          cell.innerHTML = "";
          cell.appendChild(img);
        });
      });
    },
    { rootMargin: "300px" }
  );

  function observeForArt(cell, key, item) {
    cell.innerHTML = "";
    const ph = document.createElement("span");
    ph.className = "no-thumb";
    cell.appendChild(ph);
    if (!pageUrlFor(item)) return; // nothing fetchable
    if (!ds.canFetchPages()) return; // e.g. local app without the extension
    cell._item = item;
    cell._key = key;
    thumbObserver.observe(cell);
  }

  function renderThumb(cell, key, item) {
    cell.innerHTML = "";
    const turl = thumbUrl(item);
    if (turl) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = "";
      img.src = turl;
      // Stale/broken stored art -> placeholder, then lazily re-resolve from the page.
      img.onerror = () => observeForArt(cell, key, item);
      cell.appendChild(img);
    } else {
      observeForArt(cell, key, item);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  let allItems = {};
  let currentView = {}; // items currently shown (after search + tag filter)
  let allTagsVocab = []; // tag vocabulary, for the inline tag editors
  let indexByKey = {}; // key -> position in the stored JSON order (the "#" column)
  let sortColumn = "index"; // "index" (JSON order, default) | a column's sortKey
  let sortDir = 1; // 1 = ascending, -1 = descending

  // Recompute the visible set from the search box + tag filter, then render.
  function computeView() {
    const q = (document.getElementById("searchInput").value || "").trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const selected = $("#tagFilterSelect").val() || [];

    const useAnd = !document.getElementById("filterOr").checked; // AND unless OR is picked

    const entries = Object.entries(allItems).filter(([key, item]) => {
      if (selected.length) {
        const tags = item.tags || [];
        const ok = useAnd
          ? selected.every((t) => tags.includes(t))
          : selected.some((t) => tags.includes(t));
        if (!ok) return false;
      }
      if (!matchesSearch(item, terms)) return false;
      if (opts.filterItem && !opts.filterItem(item)) return false;
      return true;
    });
    currentView = Object.fromEntries(entries);
    renderCollectionTable(currentView);
    if (opts.onView) opts.onView(entries.length, Object.keys(allItems).length);
  }

  // Lazily turn a Tags cell into a chosen multi-select (same widget as track
  // annotation) when it scrolls into view, so we don't instantiate ~900 at once.
  const tagEditorObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const cell = entry.target;
        tagEditorObserver.unobserve(cell);
        cell.innerHTML = "";
        cell.appendChild(makeTagEditor(cell._item, cell._key));
      });
    },
    { rootMargin: "300px" }
  );

  function makeTagEditor(item, key) {
    const wrap = buildTagEditorWrap(item, key, allTagsVocab, onTagsEdited);
    if (item._tagsPending) wrap.classList.add("tags-pending");
    return wrap;
  }

  // Save an inline tag edit. The local app may only be able to queue it (when
  // the extension is unreachable); mark the editor so that's visible.
  // Tag edits made here that the data source may not reflect yet (the local
  // app reads the server mirror, which catches up after the extension's
  // debounced push). A reload in between must not undo them.
  const localTagEdits = new Map(); // key -> {tags, at}
  const LOCAL_EDIT_TTL_MS = 30000;

  function onTagsEdited(key, tags, wrap) {
    localTagEdits.set(key, { tags: tags.slice(), at: Date.now() });
    Promise.resolve(ds.setItemTags(key, tags)).then((res) => {
      const pending = !!(res && res.queued);
      const failed = !!(res && res.ok === false);
      if (failed) localTagEdits.delete(key);
      const item = allItems[key];
      if (item) item._tagsPending = pending;
      wrap.classList.toggle("tags-pending", pending);
      wrap.classList.toggle("tags-error", failed);
      wrap.title = failed ? `Not saved: ${res.error || "error"}` : pending ? "Queued: the extension applies it on its next sync." : "";
    });
  }

  // Make sure the playing track has a (teleportable) tag editor to move around.
  function ensurePlayingTagWrap() {
    if (playingTagWrap || !playingKey) return;
    const cell = document.querySelector(`#collectionTable tr[data-key="${playingKey}"] td.tags-cell`);
    if (cell) {
      let wrap = cell.querySelector(".tag-editor-wrap");
      if (!wrap) {
        tagEditorObserver.unobserve(cell);
        cell.innerHTML = "";
        wrap = makeTagEditor(playingItem, playingKey);
        cell.appendChild(wrap);
      }
      playingTagWrap = wrap;
    } else {
      playingTagWrap = makeTagEditor(playingItem, playingKey); // row not rendered yet
    }
  }

  // Move a no-longer-current tag editor back into its own row, or drop it.
  function returnTagWrapToRow(wrap, key) {
    if (!wrap) return;
    const cell = document.querySelector(`#collectionTable tr[data-key="${key}"] td.tags-cell`);
    if (cell) {
      if (wrap.parentElement !== cell) {
        cell.innerHTML = "";
        cell.appendChild(wrap);
      }
    } else if (wrap.parentElement) {
      wrap.remove();
    }
  }

  // When the tag vocabulary changes anywhere (e.g. Create Tag in the popup),
  // refresh the filter and every open inline tag editor live — no reload needed.
  function onVocabChanged(tags) {
    allTagsVocab = Array.isArray(tags) ? tags : [];
    const filter = document.getElementById("tagFilterSelect");
    if (filter) syncChosenOptions(filter, allTagsVocab);
    document.querySelectorAll("select.tag-editor").forEach((sel) => syncChosenOptions(sel, allTagsVocab));
  }

  function renderTagsCell(cell, key, item) {
    cell.classList.add("tags-cell");
    cell.innerHTML = "";
    // Reuse the live teleporting editor for the playing track (global mode).
    if (globalMode && key === playingKey && playingTagWrap) {
      cell.appendChild(playingTagWrap);
      return;
    }
    // Otherwise show the tags as text until the editor is lazily built on scroll.
    const text = document.createElement("span");
    text.textContent = item.tags && item.tags.length ? item.tags.join(", ") : "—";
    cell.appendChild(text);
    cell._item = item;
    cell._key = key;
    tagEditorObserver.observe(cell);
  }

  // A chosen multi-select tag filter (same widget style as track annotation):
  // type to autocomplete, add several tags, and the collection filters live.
  function renderTagFilter(tags) {
    const sel = $("#tagFilterSelect");
    sel.empty();
    (tags || []).forEach((tag) => sel.append(new Option(tag, tag)));
    sel.chosen({ no_results_text: "No matching tag", width: "420px" });
    sel.on("change", computeView);
  }

  function openInNewTab(url) {
    if (url) window.open(url, "_blank").focus();
  }

  // Load the full Bandcamp embedded player inline (used for albums and as a
  // fallback when a track's stream can't be resolved).
  function loadEmbed(cell, key) {
    const src = embedSrcFromKey(key);
    if (!src) {
      cell.textContent = "no player";
      return;
    }
    const frame = document.createElement("iframe");
    frame.setAttribute("seamless", "");
    frame.style.border = "0";
    frame.style.width = "100%";
    frame.style.height = "120px";
    frame.src = src;
    cell.innerHTML = "";
    cell.appendChild(frame);
  }

  function renderPlayerCell(cell, key, item) {
    cell.classList.add("player-cell");
    cell.innerHTML = "";
    if (opts.playable && !opts.playable(item)) {
      cell.appendChild(document.createTextNode("—"));
      cell.title = "Nothing to play: not on Bandcamp and not found locally";
      return;
    }
    const isTrack = item.tralbum_type !== "a";

    // Albums are multi-track -> inline embedded player (either mode).
    if (!isTrack) {
      const btn = playButton("Play album");
      btn.addEventListener("click", () => loadEmbed(cell, key));
      cell.appendChild(btn);
      return;
    }

    // Global mode: the currently-playing track reuses the one live (teleporting)
    // audio element; placePlaying() may relocate it to the top bar afterwards.
    if (globalMode && key === playingKey && playingAudio) {
      cell.appendChild(playingAudio);
      return;
    }

    // Local app: prefer the located local file.
    const localUrl = !item._localFailed && opts.localPlayUrl ? opts.localPlayUrl(item, key) : null;
    if (localUrl) {
      cell.appendChild(makeLocalAudio(localUrl, item, key));
      return;
    }

    // A live link -> inline <audio>; else a Play button that resolves one.
    if (isPlayable(item)) {
      cell.appendChild(makeRowAudio(streamUrlOf(item), item, key));
      return;
    }
    const btn = playButton("▶ Play");
    btn.addEventListener("click", () => playTrack(item, key, cell, btn));
    cell.appendChild(btn);
  }

  // Columns, in display order. sortKey = sortable; compare(a, b) sorts items.
  const BASE_COLUMNS = [
    {
      id: "index",
      label: "#",
      sortKey: "index",
      render: (cell, key) => {
        cell.classList.add("index-cell");
        cell.textContent = (indexByKey[key] || 0) + 1;
      },
    },
    {
      id: "date",
      label: "Added",
      sortKey: "date",
      compare: cmpDate,
      render: (cell, key, item) => {
        cell.classList.add("date-cell");
        cell.textContent = fmtDate(item.date_added);
      },
    },
    {
      id: "thumb",
      label: "Thumbnail",
      render: (cell, key, item) => {
        cell.classList.add("thumb-cell");
        renderThumb(cell, key, item);
        $(cell).click(() => openInNewTab(pageUrlFor(item)));
      },
    },
    {
      id: "title",
      label: "Title",
      sortKey: "title",
      compare: cmpText("title"),
      render: (cell, key, item) => {
        const a = document.createElement("a");
        a.href = (opts.titleUrl && opts.titleUrl(item)) || pageUrlFor(item) || "#";
        a.target = "_blank";
        a.textContent = item.title || ""; // text, never HTML: titles come from Bandcamp
        cell.appendChild(a);
      },
    },
    {
      id: "artist",
      label: "Artist",
      sortKey: "artist",
      compare: cmpText("artist"),
      render: (cell, key, item) => {
        cell.innerText = item.artist || "";
      },
    },
    { id: "player", label: "Player", render: renderPlayerCell },
    { id: "tags", label: "Tags", sortKey: "tags", compare: cmpTags, render: renderTagsCell },
  ];

  const columns = BASE_COLUMNS.slice();
  (opts.extraColumns || []).forEach((col) => {
    if (col.first) {
      columns.unshift(col);
      return;
    }
    const at = columns.findIndex((c) => c.id === col.after);
    columns.splice(at === -1 ? columns.length : at + 1, 0, col);
  });

  function renderCollectionTable(items) {
    const collectionTable = document.getElementById("collectionTable");
    // Preserve the live playing audio across the rebuild (global mode) by docking
    // it in the top bar before the table is cleared.
    if (globalMode && playingAudio && collectionTable.contains(playingAudio)) {
      document.getElementById("gpAudioHolder").appendChild(playingAudio);
    }
    if (globalMode && playingTagWrap && collectionTable.contains(playingTagWrap)) {
      document.getElementById("gpTagHolder").appendChild(playingTagWrap);
    }
    thumbObserver.disconnect(); // drop observations from the previous render
    tagEditorObserver.disconnect();
    collectionTable.innerHTML = "";

    // Sortable header. No sortKey = not sortable.
    const header = collectionTable.createTHead();
    const headerRow = header.insertRow(0);
    columns.forEach((col) => {
      const th = document.createElement("th");
      th.className = `col-${col.id}`;
      if (col.headerRender) col.headerRender(th);
      else th.textContent = col.label;
      if (col.title) th.title = col.title;
      if (col.sortKey) {
        th.style.cursor = "pointer";
        if (sortColumn === col.sortKey) {
          const arrow = document.createElement("span");
          arrow.className = "sort-arrow";
          arrow.textContent = sortDir === 1 ? " ▲" : " ▼"; // ▲ / ▼
          th.appendChild(arrow);
        }
        th.addEventListener("click", () => {
          if (sortColumn === col.sortKey) {
            sortDir = -sortDir; // toggle asc <-> desc
          } else {
            sortColumn = col.sortKey;
            sortDir = 1; // first click = ascending
          }
          renderCollectionTable(currentView);
        });
      }
      headerRow.appendChild(th);
    });

    // Keep original (storage/JSON) order until a column is clicked.
    const entries = Object.entries(items);
    const sortCol = columns.find((c) => c.sortKey === sortColumn);
    if (sortColumn === "index") {
      entries.sort((x, y) => ((indexByKey[x[0]] || 0) - (indexByKey[y[0]] || 0)) * sortDir);
    } else if (sortCol && sortCol.compare) {
      entries.sort((x, y) => sortCol.compare(x[1], y[1]) * sortDir);
    }

    const tbody = collectionTable.createTBody();
    entries.forEach(([key, item]) => {
      const row = tbody.insertRow();
      row.dataset.key = key;
      if (opts.rowClass) {
        const cls = opts.rowClass(item, key);
        if (cls) row.className = cls;
      }
      columns.forEach((col) => {
        const cell = row.insertCell();
        cell.classList.add(`col-${col.id}`);
        col.render(cell, key, item);
      });

      // Global mode: clicking the "white space" of a row plays it. Ignore clicks on
      // the interactive bits (title link, thumbnail, tag editor, player controls).
      if (globalMode && item.tralbum_type !== "a") {
        row.classList.add("clickable-row");
        row.addEventListener("click", (e) => {
          if (e.target.closest("a, img, .no-thumb, button, audio, input, select, .chosen-container, .tags-cell, .thumb-cell, .no-row-play")) {
            return;
          }
          // The current cell: in-place row updates replace cells.
          playTrack(allItems[key] || item, key, row.querySelector("td.player-cell"));
        });
      }
    });

    setupColumnResizing(collectionTable, colWidthKey, columns.map((c) => c.id), opts.legacyColWidths);

    if (globalMode) {
      highlightPlayingRow(); // live audio survives re-render
      placePlaying(); // dock to row (if visible) or top bar
    } else {
      // Per-row audio is destroyed by re-render, so playback stops -> clear state.
      playingAudio = null;
      playingKey = null;
      playingItem = null;
      playingTagWrap = null;
      updateNowPlaying(null);
      highlightPlayingRow();
    }
  }

  // ---------------------------------------------------------------------------
  // Toolbar actions (Bandcamp page fetches)
  // ---------------------------------------------------------------------------

  function needsPageFetch(statusEl) {
    if (ds.canFetchPages()) return false;
    if (statusEl) statusEl.textContent = ds.pageFetchUnavailableReason || "Bandcamp fetches are unavailable here.";
    return true;
  }

  // Bulk "Refresh player files": rebuild cached streams for all tracks. Fetches
  // each album page once (tracks share albums) with limited concurrency.
  async function refreshAllFiles(statusEl, button) {
    if (needsPageFetch(statusEl)) return;
    if (button) button.disabled = true;

    const tracks = Object.entries(allItems).filter(([key, item]) => item.tralbum_type === "t");
    const filesToPersist = {};
    let done = 0, updated = 0;

    const setStatus = () => {
      if (statusEl) statusEl.textContent = `Refreshing players ${done}/${tracks.length}... (${updated} set)`;
    };
    setStatus();

    // resolveAlbumDoc dedupes per album and the throttle handles concurrency/429.
    await Promise.all(
      tracks.map(([key, item]) =>
        resolveAlbumDoc(item).then((doc) => {
          const tralbum = doc && tralbumOf(doc);
          if (tralbum) {
            const fresh = pickStreamFromTralbum(tralbum, item);
            if (fresh) {
              item.file = { "mp3-128": fresh };
              filesToPersist[key] = item.file;
              updated++;
            }
          }
          done++;
          setStatus();
        })
      )
    );

    if (Object.keys(filesToPersist).length) {
      await ds.persistFiles(filesToPersist);
    }
    if (statusEl) {
      statusEl.textContent = `Refreshed ${updated} of ${tracks.length} tracks.`;
    }
    if (button) button.disabled = false;
    renderCollectionTable(allItems);
  }

  // Bulk "Refresh thumbnails": for items with no art at all, fetch each album
  // page once and read its art_id, then build + cache the thumbnail URL.
  async function refreshAllThumbnails(statusEl, button) {
    if (needsPageFetch(statusEl)) return;
    if (button) button.disabled = true;

    // Items with no resolvable thumbnail at all (stale-art_id items are fixed
    // lazily via the img onerror path). resolveItemArt dedupes per album.
    const targets = Object.entries(allItems).filter(([key, item]) => !thumbUrl(item));
    const artToPersist = {};
    let done = 0, updated = 0;

    const setStatus = () => {
      if (statusEl) statusEl.textContent = `Thumbnails ${done}/${targets.length}... (${updated} set)`;
    };
    setStatus();

    await Promise.all(
      targets.map(([key, item]) =>
        resolveItemArt(item).then((url) => {
          if (url) {
            item.art_url = url;
            artToPersist[key] = url;
            updated++;
          }
          done++;
          setStatus();
        })
      )
    );

    if (Object.keys(artToPersist).length) {
      await ds.persistArt(artToPersist);
    }
    console.log(`[thumbnails] checked=${targets.length} set=${updated} (per-URL failures logged above as "[art] failed ...")`);

    if (statusEl) {
      statusEl.textContent = `Thumbnails: set ${updated} of ${targets.length} (any failures in console).`;
    }
    if (button) button.disabled = false;
    renderCollectionTable(allItems);
  }

  // "Fix artists": fill empty artist fields. Titles like "Artist - Title" are
  // split locally; the rest are read from the Bandcamp page's tralbum.artist
  // (and the missing thumbnail is grabbed in the same fetch). Order is preserved.
  async function fixArtists(statusEl, button) {
    if (button) button.disabled = true;

    const dashUpdates = {};
    const toFetch = [];
    Object.entries(allItems).forEach(([key, item]) => {
      if (item.artist) return;
      const split = splitArtistFromTitle(item.title);
      if (split) {
        item.artist = split.artist;
        item.title = split.title;
        dashUpdates[key] = { artist: split.artist, title: split.title };
      } else {
        toFetch.push([key, item]); // canonical resolver handles custom domains too
      }
    });

    let fixed = 0;

    // 1) Dash-splits are instant: persist and show them right away.
    if (Object.keys(dashUpdates).length) {
      fixed += Object.keys(dashUpdates).length;
      await ds.persistFields(dashUpdates);
      renderCollectionTable(currentView);
    }

    // 2) Fetch the rest (slow due to rate-limiting), saving progress in batches so
    //    nothing is lost if the page is closed partway through.
    if (!ds.canFetchPages()) toFetch.length = 0;
    let done = 0;
    let pending = {};
    const flush = async () => {
      if (Object.keys(pending).length) {
        const batch = pending;
        pending = {};
        await ds.persistFields(batch);
      }
    };
    const setStatus = () => {
      if (statusEl) statusEl.textContent = `Fixing artists: ${fixed} set, ${done}/${toFetch.length} looked up...`;
    };
    setStatus();

    await Promise.all(
      toFetch.map(([key, item]) =>
        resolveAlbumDoc(item).then(async (doc) => {
          const tralbum = doc && tralbumOf(doc);
          if (tralbum) {
            let artist = tralbum.artist;
            if (Array.isArray(tralbum.trackinfo)) {
              const ti = tralbum.trackinfo.find((x) => String(x.id) === String(item.raw_id));
              if (ti && ti.artist) artist = ti.artist; // prefer per-track artist
            }
            const art = artUrlFromPage(doc);
            const fields = {};
            if (artist && !item.artist) {
              item.artist = artist;
              fields.artist = artist;
              fixed++;
            }
            if (art && !item.art_url) {
              item.art_url = art;
              fields.art_url = art;
            }
            if (Object.keys(fields).length) pending[key] = fields;
          }
          done++;
          setStatus();
          if (Object.keys(pending).length >= 20) await flush(); // periodic save
        })
      )
    );
    await flush();

    if (statusEl) statusEl.textContent = `Fixed ${fixed} artists.`;
    if (button) button.disabled = false;
    renderCollectionTable(currentView);
  }

  // "Fix album IDs": tracks tagged on their own track page used to get "a" +
  // the track's own id as album_id, and tracks tagged from a fan collection
  // page got none (plus an album_url built from the track's slug), so
  // ownership through the album couldn't work. Read the real album from each
  // track page (current.album_id and album_url; null for a single) or, when
  // that page can't be read (custom domains), from Bandcamp's embedded player
  // data, and mark the item checked so it isn't fetched again. Items whose
  // track is gone stay as they are (never removed) and are retried next time.
  async function fixAlbumIds(statusEl, button) {
    if (needsPageFetch(statusEl)) return;
    if (button) button.disabled = true;

    const targets = Object.entries(allItems).filter(
      ([key, item]) =>
        item.tralbum_type === "t" &&
        !item.album_checked &&
        (!item.album_id || String(item.album_id) === `a${item.raw_id}`)
    );
    let done = 0, fixed = 0, singles = 0, viaPlayer = 0;
    let pending = {};
    const flush = async () => {
      if (Object.keys(pending).length) {
        const batch = pending;
        pending = {};
        await ds.persistFields(batch);
      }
    };
    const setStatus = () => {
      if (statusEl) statusEl.textContent = `Album IDs: ${done}/${targets.length} checked (${fixed} fixed, ${singles} singles)...`;
    };
    setStatus();

    await Promise.all(
      targets.map(([key, item]) =>
        resolveTrackTralbum(item).then(async (tralbum) => {
          const current = tralbum && tralbum.current;
          let fields = null;
          if (current && "album_id" in current) {
            const album_id = current.album_id ? `a${current.album_id}` : null;
            let album_url = null;
            try {
              if (album_id && tralbum.album_url) album_url = new URL(tralbum.album_url, tralbum.url || item.url || item.item_url).href;
            } catch (e) {
              /* keep null */
            }
            fields = { album_id, album_url, album_checked: true };
          } else {
            const player = await resolveTrackPlayerData(item);
            if (player && "album_id" in player) {
              // No album page URL here: keep the stored one.
              fields = { album_id: player.album_id ? `a${player.album_id}` : null, album_checked: true };
              viaPlayer++;
            }
          }
          if (fields) {
            Object.assign(item, fields);
            pending[key] = fields;
            if (fields.album_id) fixed++;
            else singles++;
          }
          done++;
          setStatus();
          if (Object.keys(pending).length >= 20) await flush(); // periodic save
        })
      )
    );
    await flush();

    const missed = targets.length - fixed - singles;
    if (statusEl) {
      statusEl.textContent =
        `Album IDs: ${fixed} fixed, ${singles} singles` +
        (viaPlayer ? ` (${viaPlayer} from the embedded player)` : "") +
        (missed ? `, ${missed} not found on Bandcamp (kept as they are; retried next time).` : ".");
    }
    if (button) button.disabled = false;
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  function setItems(items) {
    allItems = items || {};
    indexByKey = {};
    Object.keys(allItems).forEach((k, i) => { indexByKey[k] = i; });
    computeView();
  }

  async function start() {
    ds.onTagsChanged(onVocabChanged);
    if (ds.onItemsChanged) ds.onItemsChanged(() => reload());

    await ds.init();

    const dbTags = await ds.getTags();
    allTagsVocab = Array.isArray(dbTags) ? dbTags : [];
    renderTagFilter(dbTags);

    // Go To Playing.
    const gpGoto = document.getElementById("gpGoto");
    if (gpGoto) gpGoto.addEventListener("click", goToPlaying);

    // Player mode toggle (global vs per-row); persisted, per-row is the default.
    const modeToggle = document.getElementById("globalModeToggle");
    if (modeToggle) {
      modeToggle.checked = globalMode;
      modeToggle.addEventListener("change", () => {
        globalMode = modeToggle.checked;
        try { localStorage.setItem("bc_global_player_mode", globalMode ? "1" : "0"); } catch (e) { /* ignore */ }
        // Stop playback and reset, then re-render in the new mode.
        try { if (playingAudio) playingAudio.pause(); } catch (e) { /* ignore */ }
        if (playingAudio && playingAudio.parentElement) playingAudio.remove();
        if (playingTagWrap && playingTagWrap.parentElement) playingTagWrap.remove();
        playingAudio = null;
        playingKey = null;
        playingItem = null;
        playingTagWrap = null;
        updateNowPlaying(null);
        renderCollectionTable(currentView);
      });
    }

    // AND/OR filter mode: mutually exclusive checkboxes (radio-like), AND default.
    const filterAnd = document.getElementById("filterAnd");
    const filterOr = document.getElementById("filterOr");
    if (filterAnd && filterOr) {
      filterAnd.addEventListener("click", () => {
        filterAnd.checked = true;
        filterOr.checked = false;
        computeView();
      });
      filterOr.addEventListener("click", () => {
        filterOr.checked = true;
        filterAnd.checked = false;
        computeView();
      });
    }

    // Live search (debounced) across title / artist / album / label.
    const searchInput = document.getElementById("searchInput");
    if (searchInput) {
      let t = null;
      searchInput.addEventListener("input", () => {
        clearTimeout(t);
        t = setTimeout(computeView, 120);
      });
    }

    // Load items after the vocab so inline tag editors have their options.
    setItems(await ds.getItems());
  }

  // --- Live updates (local app) ------------------------------------------------

  // Item data without the page's own per-session flags (`_...`).
  function dataOf(item) {
    const out = {};
    Object.keys(item || {}).forEach((k) => {
      if (k[0] !== "_") out[k] = item[k];
    });
    return out;
  }

  // Point every live tag editor of `key` (in its row or docked in the top
  // bar) at the item's current tags.
  function syncTagEditors(key) {
    const item = allItems[key];
    if (!item) return 0;
    const sels = document.querySelectorAll(`.tag-editor-wrap[data-key="${key}"] select.tag-editor`);
    sels.forEach((sel) => {
      [...sel.options].forEach((o) => (o.selected = (item.tags || []).includes(o.value)));
      $(sel).trigger("chosen:updated");
      sel.parentElement.classList.toggle("tags-pending", !!item._tagsPending);
    });
    return sels.length;
  }

  // A player cell that is in use: the current track, a loaded Bandcamp embed
  // (albums, fallback), or any audio that is playing.
  function playerInUse(cell, key) {
    if (key === playingKey) return true;
    if (cell.querySelector("iframe")) return true;
    return [...cell.querySelectorAll("audio")].some((a) => !a.paused);
  }

  // Re-render one row's cells from its (updated) item. A player in use is
  // kept, and live tag editors are updated in place.
  function refreshRow(key) {
    const item = allItems[key];
    const row = document.querySelector(`#collectionTable tr[data-key="${key}"]`);
    if (!row || !item) return;
    if (opts.rowClass) {
      const keep = ["playing-row", "clickable-row"].filter((c) => row.classList.contains(c));
      row.className = [opts.rowClass(item, key), ...keep].filter(Boolean).join(" ");
    }
    columns.forEach((col, i) => {
      const old = row.cells[i];
      if (!old) return;
      if (col.id === "player" && playerInUse(old, key)) return;
      if (col.id === "tags") {
        if (syncTagEditors(key)) return;
        tagEditorObserver.unobserve(old);
      }
      if (col.id === "thumb") thumbObserver.unobserve(old);
      if (col.id === "player") old.querySelectorAll("audio").forEach((a) => a.pause());
      const cell = document.createElement("td");
      cell.classList.add(`col-${col.id}`);
      col.render(cell, key, item);
      row.replaceChild(cell, old);
    });
  }

  function sameTags(a, b) {
    return JSON.stringify(a || []) === JSON.stringify(b || []);
  }

  // Apply a fresh copy of the items. Existing items are updated in place
  // (keeping object identity, so players, editors and the playing track stay
  // bound to them); only changed rows re-render, unless items were added or
  // removed, which re-renders the view.
  function applyItemUpdates(fresh) {
    fresh = fresh || {};
    const keys = Object.keys(fresh);
    const structural =
      keys.length !== Object.keys(allItems).length || keys.some((k) => !(k in allItems));
    const changed = [];
    keys.forEach((k) => {
      const old = allItems[k];
      const nu = fresh[k];
      // Keep a recent local tag edit until the source reflects it.
      const local = localTagEdits.get(k);
      if (local) {
        if (sameTags(nu.tags, local.tags) || Date.now() - local.at > LOCAL_EDIT_TTL_MS) localTagEdits.delete(k);
        else nu.tags = local.tags.slice();
      }
      if (!old) return;
      fresh[k] = old;
      const oldData = dataOf(old);
      if (JSON.stringify(oldData) === JSON.stringify(dataOf(nu)) && !!old._tagsPending === !!nu._tagsPending) {
        return;
      }
      Object.keys(oldData).forEach((f) => {
        if (!(f in nu)) delete old[f];
      });
      Object.assign(old, nu);
      if (!nu._tagsPending) delete old._tagsPending;
      changed.push(k);
    });
    if (structural) {
      setItems(fresh);
      changed.forEach(syncTagEditors); // e.g. the playing track's editor in the top bar
      return;
    }
    changed.forEach((k) => {
      if (k in currentView) refreshRow(k);
      else syncTagEditors(k);
    });
  }

  // Re-fetch items (e.g. after a local-app job, or an edit made elsewhere);
  // keeps the filters, the sort and the playing track.
  async function reload() {
    applyItemUpdates(await ds.getItems());
  }

  return {
    start,
    reload,
    refreshRow,
    refilter: () => computeView(),
    getView: () => currentView,
    render: () => renderCollectionTable(currentView),
    getItems: () => allItems,
    statusEl,
  };
}

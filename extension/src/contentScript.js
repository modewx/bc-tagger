'use strict';
const cheerio = require('cheerio');
const { setupImportLinks } = require('./importLink');

// A copy injected again after the extension reloaded (refreshContentScripts in
// background.js): the previous copy can no longer reach the extension, so its
// widgets go and this one adds its own.
document.querySelectorAll(".tagger-container, .bct-link-btn, .bct-link-menu").forEach((n) => n.remove());

// Content script file will run in the context of web page.
// With content script you can manipulate the web pages using
// Document Object Model (DOM).
// You can also pass information to the parent extension.

// We execute this script by making an entry in manifest.json file
// under `content_scripts` property

// For more information on Content Scripts,
// See https://developer.chrome.com/extensions/content_scripts
// const req = require('tinyreq');
console.log("---- Extension contentScript")


function parseTrackInfo(str, trackUrl) {
  // const page = $($.parseHTML( str ));
  // const object = {}
  // const scriptWithRaw = page('script[data-tralbum]')
  // // console.log(scriptWithRaw)
  // if (scriptWithRaw.length > 0) {
  //   object.raw = scriptWithRaw.data('tralbum')
  // }
  // object.title = object.raw.trackinfo[0].title
  // object.url = trackUrl
  // object.trackId = object.raw.trackinfo[0].track_id
  // return object;
  const gg = cheerio.load(str)
  const object = {}
  const scriptWithRaw = gg('script[data-tralbum]')
  
  // console.log(scriptWithRaw)
  if (scriptWithRaw.length > 0) {
    object.raw = scriptWithRaw.data('tralbum')
  }
  object.title = object.raw.trackinfo[0].title
  object.url = trackUrl
  object.trackId = object.raw.trackinfo[0].track_id
  return object;
}
function getCurrentRawUrl() {
  return window.location.href.split('?')[0];
}
// console.log("========")
// console.log($("propOpenWrapper"))

// Log `title` of current active web page
const pageTitle = document.head.getElementsByTagName('title')[0].innerHTML;
const currentUrl = getCurrentRawUrl();
const albumPage = currentUrl.includes("/album/");
const trackPage =  currentUrl.includes("/track/");
const collectionPage = !albumPage && !trackPage;


let pageData = {}
let collectionData = {}
let tracksData = []
let lastItemId = ""
let first_load = true;
let autoScrollToBottom = false;

console.log(
  `Page title is: '${pageTitle}' - evaluated by Chrome extension's 'contentScript.js' file. url ${currentUrl}, albumpage: ${albumPage}, trackpage: ${trackPage}, collectionpage ${collectionPage} id ${chrome.runtime.id}`
);

let observer = null;
var insertedNodes = [];
if (collectionPage) {
  observer = new MutationObserver(function(mutations) {
    
    if ("fan_data" in pageData && "collection_data" in pageData) {

      var body = {
        "fan_id": pageData.fan_data.fan_id,
        "older_than_token": pageData.collection_data.last_token,
        "count": 20
      }; 
      fetch('/api/fancollection/1/collection_items', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8'
        },
        body: JSON.stringify(body)
      })
      .then(function(response) {
          // When the page is loaded convert it to text
          return response.json();
      })
      .then(function(json) {
        let prevLastId = lastItemId;  
          let last = json.items.slice(-1)[0]
          if (last !== undefined) {
          lastItemId = `${last.tralbum_type}${last.tralbum_id}`
          }

  
          var newItemDict = json.items
          .reduce((r, val) => {
            r[`${val.tralbum_type}${val.tralbum_id}`] = val;
            return r;
          }, {})
          
          collectionData = {
            ...collectionData,
            ...newItemDict,
          }
          pageData.collection_data.last_token = json.last_token;
          pageData["more_available"] = json.more_available;
    if (autoScrollToBottom) {

      
        let it = $(`.${prevLastId}`);



        // console.log("&&&&&&& --- last item " + it + prevLastId)
        // console.log(it)
        // if (it !== undefined) {

        var offset = it.offset();
      //   var offset = $("collection-item-container_2299630825").offset()
        $('html, body').animate({
            scrollTop: offset.top,
            scrollLeft: offset.left
        }, {duration: 50}, 1000);


    }

        
    // The items just added to the page: their state from the extension (only theirs), then their widgets.
    const added = [];
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((addedNode) => {
        let tralbumId = addedNode.getAttribute('data-tralbumid');
        let itemType = addedNode.getAttribute("data-tralbumtype");
        let id = `${itemType}${tralbumId}`;
        let image_url = addedNode.querySelector("img.collection-item-art").src;
        added.push({ element: addedNode, id, trackdata: extractCollectionItemData(collectionData[id], image_url) });
      });
    });
    addWidgets(added);


      });

      
      
        // mutations.forEach(function(mutation) {
        // for (var i = 0; i < mutation.addedNodes.length; i++)
        //     insertedNodes.push(mutation.addedNodes[i]);
        // })
        // console.log(insertedNodes);


    }

   

    // getTaggedItems((taggedItems) => {
    //   mutations.forEach((mutation) => {
    //     for (var i = 0; i < mutation.addedNodes.length; i++)
    //         //insertedNodes.push(mutation.addedNodes[i]);
  
    //         // itemUrl = element.querySelector('.collection-title-details a') 
    //         const tralbumId = element.getAttribute('data-tralbumid');
    //         let itemType = element.getAttribute("data-tralbumtype");
    //         console.log(`****** itemid ${tralbumId}`);
    //         let id = `${itemType}${tralbumId}`;
    //         trackdata = extractCollectionItemData(collectionData[id])//itemType === "a" ? extractAlbumData(collectionData[itemId]) : extractTrackData(collectionData[itemId]); 
    //         createTagButton(taggedItems, mutation.addedNodes[i], id, trackdata);
    //     })
    //     });
    //   });
    first_load = true;
    // if (autoScrollToBottom) {
    //   let it = $("collection-items > ol:last-child");
    //   var offset = it.offset();
    //   //   var offset = $("collection-item-container_2299630825").offset()
    //     $('html, body').animate({
    //         scrollTop: offset.top,
    //         scrollLeft: offset.left
    //     }, {duration: 50}, 1000);

    //   }
    
    
  });

  observer.observe(document.querySelector("#collection-items ol"), { childList: true});
  // observer.observe(document.querySelector("#collection-items"), { childList: true, subtree: true });
  let dataBlob = JSON.parse(document.querySelector("#pagedata").getAttribute("data-blob"));
  pageData = dataBlob;
  collectionData = pageData["item_cache"]["collection"];
  // window.scrollTo(0, document.body.scrollHeight);
  // pageData = 

  // $('#centerWrapper').animate({scrollTop: document.body.scrollHeight},"fast");


  // //WORKS
//   var offset = $(`.${pageData.collection_data.sequence.slice(-1)}`).offset();
// //   var offset = $("collection-item-container_2299630825").offset()
// $('html, body').animate({
//     scrollTop: offset.top,
//     scrollLeft: offset.left
// }, 1000);


  let expand =  document.createElement("button");
  expand.innerHTML = "Expand All Collection"
  document.querySelector(".expand-container").appendChild(
    expand
  );

  expand.addEventListener("click", (event) => {
    event.stopPropagation();

    // $("collection-items > ol:last_child")
    document.querySelector(".show-more").click();
    autoScrollToBottom = true;
    
    
  });

//$("#centerWrapper")[0].scrollTo(0, $("#centerWrapper")[0].scrollHeight);

  // function logURL(requestDetails) {
}



function getTrackInfo(trackUrl, cb) {
  req(trackUrl, function (error, html) {
    if (error) {
      cb(error, null)
    } else {
      const trackInfo = htmlParser.parseTrackInfo(html, trackUrl)
      cb(null, trackInfo)
    }
  })
}

function toggleStar(tagButton) {
  if (tagButton.innerHTML === "☆") {
    tagButton.innerHTML = "★";
  } else {
    tagButton.innerHTML = "☆";
  }
}

function setStar(tagButton, active) {
  var star = tagButton.getElementsByTagName('span')[0];
  if (active) {
    // star.classList.add("filled");
    tagButton.innerHTML = "★";
  } else {
    // star.classList.remove("filled");
    tagButton.innerHTML = "☆";
  }
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to a 32-bit integer
  }
  return hash.toString();
}

// This page is a client of the extension's worker, which owns the data ("many to one"): it never reads
// chrome.storage or listens to it, and the worker never sends it anything unasked. It asks for the state of its own
// items when it loads, and again when it's shown or focused (a version check first: one small answer when nothing
// changed), so a tab in the background does no work. A star or a tag change here is drawn at once and sent as a
// change; the worker queues it and writes it later, with others.
//
// Stars (Phase 9b): in a collection, filled when the item is in it; a star or a tag adds it there only; un-starring
// takes it out of it only, and deletes it (with its tags) when that was its last collection (the worker decides, from
// its own copy). All (chosen in the popup, never the default) isn't a collection but every one at once: filled when
// the item is in any, drawn differently (`.bct-all`); a star or any tag edit puts the item into every collection it
// isn't in; un-starring deletes it from all of them, at once. No collection known yet (the server never reached): filled
// when saved.
const ALL = "all";
const page = {
  rev: null, // the worker's version of what's below
  tagsRev: null,
  ids: new Set(), // the items with a widget here
  items: {}, // the saved ones: id -> item
  member: new Map(), // id -> Set(collection ids)
  active: null, // a collection id, ALL, or null (none known)
  list: [], // the collections by pos: [{id, name, pos}]
  tags: [], // the tag list
  changed: false, // changes sent since this page last asked for a write
};
const pageType = albumPage ? "album" : trackPage ? "track" : "collection";
const send = (msg, cb) => {
  try {
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError;
      if (cb) cb(res);
    });
  } catch (e) {
    // cut off by an extension reload: a fresh copy of this script takes over
  }
};
const memberOf = (id) => page.member.get(id) || new Set();
function starred(id) {
  if (page.active === ALL && page.list.length) return memberOf(id).size > 0;
  if (page.active === ALL || page.active == null) return id in page.items;
  return memberOf(id).has(page.active);
}
// Where a star (or a first tag) puts an item: the collection shown; in All, every collection.
const targets = () => (page.active === ALL ? page.list.map((c) => c.id) : page.active == null ? [] : [page.active]);

function setStarClass(tagButton) {
  tagButton.classList.toggle("bct-all", page.active === ALL);
  tagButton.title =
    page.active === ALL
      ? "All: a star or a tag puts this into every collection; un-starring deletes it (and its tags) from all of them"
      : "";
}
const redrawStars = () =>
  document.querySelectorAll(".tag-button[data-item-id], .tag-button[data-now-id]").forEach((b) => {
    setStar(b, starred(b.dataset.itemId || b.dataset.nowId));
    setStarClass(b);
  });
// Every widget of `id` (its row, and the now-playing box when it shows that track) as the page's state has it, so a
// change made in one shows in the other at once: the stars, and with `tags` the dropdowns (all but `from`).
function mirror(id, tags = null, from = null) {
  document.querySelectorAll(`.tag-button[data-item-id="${id}"], .tag-button[data-now-id="${id}"]`).forEach((b) => setStar(b, starred(id)));
  if (tags) {
    document.querySelectorAll(`select.chosen-select[data-item-id="${id}"]`).forEach((sel) => sel !== from && $(sel).val(tags).trigger("chosen:updated"));
  }
}

// The state of `ids` (default: every item here) from the worker; `force`: even if the version is the same.
function pull(ids = null, force = false, done = null) {
  const want = ids || [...page.ids];
  send({ type: "pageState", ids: want, rev: force || ids ? null : page.rev }, (res) => {
    if (res && !res.same) {
      want.forEach((id) => {
        if (res.items && res.items[id]) page.items[id] = res.items[id];
        else delete page.items[id];
        if (res.member && res.member[id]) page.member.set(id, new Set(res.member[id]));
        else page.member.delete(id);
      });
      page.active = res.active === undefined ? null : res.active;
      page.list = res.list || [];
      if (!ids) page.rev = res.rev;
      redrawStars();
    }
    if (done) done();
  });
}
function pullTags(done = null) {
  send({ type: "tagsState", rev: page.tagsRev }, (res) => {
    if (res && !res.same && Array.isArray(res.tags)) {
      const first = page.tagsRev == null;
      page.tags = res.tags;
      page.tagsRev = res.rev;
      if (!first) refreshTagOptions(page.tags);
    }
    if (done) done();
  });
}
// Shown or focused: catch up (another tab, the popup or the app may have changed something meanwhile).
function catchUp() {
  if (document.visibilityState !== "visible" || !page.ids.size) return;
  pull();
  pullTags();
  if (nowPlaying.stale) showNowPlaying();
}
// Hidden or closing after changes here: the worker writes them now rather than after its short wait.
function writeSoon() {
  if (!page.changed) return;
  page.changed = false;
  send({ type: "flushNow" });
}
document.addEventListener("visibilitychange", () => (document.visibilityState === "visible" ? catchUp() : writeSoon()));
window.addEventListener("focus", catchUp);
window.addEventListener("pagehide", writeSoon);

// When the user acted: the last key or pointer press (a change event from chosen carries no time of its own).
let lastInputAt = 0;
["keydown", "pointerdown"].forEach((t) => document.addEventListener(t, (e) => (lastInputAt = e.timeStamp), true));
const actionStart = () => (performance.now() - lastInputAt < 1000 ? lastInputAt : performance.now());

// A change to the worker, with what the timing log needs: the page's own time from the action (`event.timeStamp`)
// to the next frame showing it.
let opSeq = 0;
function sendChange(msg, kind, since, answered = null) {
  const opId = `${Date.now().toString(36)}-${++opSeq}`;
  page.changed = true;
  send({ ...msg, kind, opId, page: pageType, widgets: page.ids.size }, answered);
  requestAnimationFrame(() => setTimeout(() => send({ type: "timing", opId, screenMs: performance.now() - since }), 0));
}

// When the tag list changed elsewhere (the popup, an import, the app), the dropdowns here get the new tags, without
// losing current selections; read when the page is shown or a dropdown opens.
function refreshTagOptions(tags) {
  $(".chosen-select").each(function () {
    const sel = $(this);
    const selected = sel.val() || [];

    // Options to keep: the new vocabulary, plus any tag currently applied to
    // this track (so a track never loses a tag even if it left the vocabulary).
    const keep = {};
    tags.forEach((t) => { keep[t] = true; });
    selected.forEach((t) => { keep[t] = true; });

    const have = {};
    sel.find("option").each(function () {
      const val = this.value;
      if (val === "") return; // keep the empty placeholder option
      if (keep[val]) {
        have[val] = true;
      } else {
        $(this).remove(); // drop a deleted tag
      }
    });

    // Add newly created tags, in vocabulary order.
    tags.forEach((tag) => {
      if (!have[tag]) {
        sel.append(new Option(tag));
      }
    });

    sel.val(selected);
    sel.trigger("chosen:updated");
  });
}

// chosen sizes its search box on every key by copying 7 computed styles onto a div it adds to <body>, measuring it
// and removing it: a style recalc and layout of the whole page per key (and work for any extension watching the
// page). Sized from the text's length instead, without reading layout.
let chosenPatched = false;
function patchChosen(select) {
  const chosen = $(select).data("chosen");
  if (chosenPatched || !chosen || !chosen.is_multiple) return;
  Object.getPrototypeOf(chosen).search_field_scale = function () {
    if (!this.is_multiple) return;
    const n = this.get_search_field_value().length;
    this.search_field[0].style.width = `min(170px, calc(${n + 1}ch + 25px))`;
  };
  chosenPatched = true;
}

function extractMetadata(element) {
  const metadata = {};

  // Extract song name
  const songElement = element.querySelector(".track-title");
  metadata.songName = songElement ? songElement.textContent.trim() : "";

  // Extract artist name
  const artistElement = element.querySelector(".artist");
  metadata.artistName = artistElement ? artistElement.textContent.trim() : "";

  // Extract album name
  const albumElement = element.querySelector(".album");
  metadata.albumName = albumElement ? albumElement.textContent.trim() : "";

  // Extract release date
  const releaseDateElement = element.querySelector(".released");
  metadata.releaseDate = releaseDateElement ? releaseDateElement.textContent.trim() : "";

  // Extract genre
  const genreElement = element.querySelector(".genre");
  metadata.genre = genreElement ? genreElement.textContent.trim() : "";

  // Extract thumbnail URL
  const thumbnailElement = element.querySelector(".art img");
  metadata.thumbnailUrl = thumbnailElement ? thumbnailElement.src : "";

  return metadata;
}


// The dropdown's template and the tag list: read once for the page, not per widget.
let widgetParts = null;
const loadWidgetParts = () =>
  widgetParts ||
  (widgetParts = new Promise((resolve) => $.get(chrome.runtime.getURL('/taggerTemplate.html'), (data) => pullTags(() => resolve(data)))));

// `opts.now`: the now-playing box (below an album's player); `opts.label`: a label before it; `opts.place(container)`:
// where it goes.
function createTagButton(element, itemUrl, trackdata, opts = {}) {
  const uniqueId = itemUrl;//hashCode(itemUrl);

  const container = document.createElement("div");
  container.classList.add("tagger-container")

  const tagButton = document.createElement("button");
  tagButton.classList.add("tag-button");

  const star = document.createElement("span");
  star.classList.add("star");

  tagButton.innerHTML = "☆";

  const taggedItem = page.items[uniqueId];
  if (opts.now) tagButton.dataset.nowId = uniqueId;
  else tagButton.dataset.itemId = uniqueId;
  if (opts.now) container.classList.add("bct-now");
  tagButton.appendChild(star);
  container.appendChild(tagButton);

  loadWidgetParts().then((data) => {

    // $(data).append($('<option>', {
    //   value: 'My opinion',
    //   text: 'My option'
    // }));
    // console.log("---data")
    // console.log(data)
    let taggerDiv = $('<div>')
    let tagger = $(data).find("select");
    tagger.attr("id", opts.now ? "bct-now-tagger" : `tagger_${uniqueId}`);
    tagger.attr("data-item-id", uniqueId);
    // $(data).append('<option>Bar</option>');
  //   chrome.runtime.sendMessage({ type: "getTags" }, (tags) => {

  //     console.log(tags)

  //  tags.forEach((tag) => {
  //   tagger.append( new Option(tag) );
  //  });

  // Tags come from the DB (seeded from tags.json), so newly created tags are
  // available without rebuilding or editing tags.json.
  {
      page.tags.forEach((tag) => {
        tagger.append( new Option(tag) );
      });

      let default_tags = [
        "must"
      ];

      const saved = page.items[uniqueId] || taggedItem;
      if (saved !== undefined && "tags" in saved) {
        default_tags = saved.tags;

      }

      tagger.val(default_tags)

      // tagger.appendTo($(container));
      taggerDiv.append(tagger)
      $(container).append(taggerDiv)
      // $(container).child.insertAdjacentElement('beforebegin', 0);
      tagger.chosen({
          no_results_text: "Oops, nothing found!",
          width: "180px"
      });
      patchChosen(tagger);
      // The tag list may have changed elsewhere since the page was shown: checked as the dropdown opens.
      tagger.on("chosen:showing_dropdown", () => pullTags());

      // Persist tag changes immediately: adding/removing a tag is an
      // annotation, so it should save (and star) the track without needing
      // the star button. The star stays the explicit save/un-save toggle.
      tagger.on("change", () => {
        const since = actionStart();
        const currentTags = tagger.val() || [];
        const existingItem = page.items[uniqueId];
        // A tag edit puts the item where a star would: the collection shown when it isn't in it; in All, every
        // collection (an add where it is already changes nothing).
        const joins = page.active === ALL ? targets() : starred(uniqueId) ? [] : targets();
        const item = existingItem
          ? { ...existingItem, tags: currentTags } // its tags in place; the rest (date_added too) intact
          : { ...trackdata, date_added: new Date().toISOString(), tags: currentTags };
        page.items[uniqueId] = item;
        if (joins.length) page.member.set(uniqueId, new Set([...memberOf(uniqueId), ...joins]));
        setStar(tagButton, starred(uniqueId));
        mirror(uniqueId, currentTags, tagger[0]);
        sendChange({ type: "addTaggedItem", item, collections: joins }, "tags", since);
      });

      // .val(["hola","mundo","cruel"]).trigger('chosen:updated');
    //..
  }
    
   
   
    // console.log("@@@@@@@ appended");

  });

  page.ids.add(uniqueId);
  setStarClass(tagButton);
  if (starred(uniqueId)) {
    // star.classList.add("filled");
    setStar(tagButton, true);
  }
  
  
  
  if (opts.label) {
    const label = document.createElement("span");
    label.className = "bct-now-label";
    label.textContent = opts.label;
    container.prepend(label);
  }

  // element.appendChild(container);
  if (opts.place) {
    opts.place(container);
  }
  else if (albumPage) {
    if (trackdata.tralbum_type == "t") {
      element.children[2].insertAdjacentElement("afterEnd", container);
    }
    else if (trackdata.tralbum_type == "a"){
      // /element.children[1].insertAdjacentElement("beforebegin", container);
      element.querySelector("#trackInfoInner").children[3].insertAdjacentElement("afterEnd", container);
    }
  }
  else if (trackPage) {
    // Below the player, as on album pages, when its row has no room to the right: the one-track layout (its row is
    // the play button and the title, across), or a row where it ends up with no width.
    const player = element.querySelector(".inline_player");
    const k = element.querySelector(".inline_player table tbody tr");
    if (player && (player.classList.contains("one-track") || !k)) {
      player.insertAdjacentElement("afterend", container);
    } else {
      k.appendChild(container);
      if (player && !container.getBoundingClientRect().width) player.insertAdjacentElement("afterend", container);
    }
    //element.querySelector(".track_info").children[0].insertAdjacentElement('beforebegin', container);
    
  }
  else {
    // return;
    // var k = element.querySelector(".collection-item-details-container").children[3].insertAdjacentElement('beforebegin', container);
    //element.querySelector(`.${uniqueId}`).appendChild(container)
    // element.querySelector(`.${uniqueId}`).insertAdjacentElement("beforeend", container)
    element.querySelector(`.${uniqueId}`).parentElement.children[1].insertAdjacentElement("afterEnd", container);
  
    //element.querySelector(`#collection-item-container_${uniqueId.slice(1)}`).appendChild(container)
  }
  

  tagButton.addEventListener("click", (event) => {
    event.stopPropagation();
    Promise.resolve().then(() => mirror(uniqueId)); // its other widget, once the page's state has the change

    let tags = $(container).find(".chosen-select").chosen().val()
    // console.log("%%%%%%%%%%%%%%%%")
    // console.log(tags)

    // star.classList.toggle("filled");

    {
      const since = event.timeStamp || performance.now();
      const saved = page.items[uniqueId];
      if (page.active != null && page.active !== ALL) {
        // A collection is shown: the star is its membership (tags stay; the item stays in All and elsewhere).
        const collection = page.active;
        const members = memberOf(uniqueId);
        if (members.has(collection)) {
          setStar(tagButton, false);
          page.member.set(uniqueId, new Set([...members].filter((c) => c !== collection)));
          // Its last collection: the worker deletes it (and says so).
          sendChange({ type: "setMembership", op: "remove", collections: [collection], id: uniqueId }, "unstar", since, (res) => {
            if (res && res.deleted) {
              delete page.items[uniqueId];
              page.member.delete(uniqueId);
            }
          });
        } else if (saved) {
          setStar(tagButton, true);
          page.member.set(uniqueId, new Set([...members, collection]));
          sendChange({ type: "setMembership", op: "add", collections: [collection], id: uniqueId, item: saved }, "star", since);
        } else {
          const newItem = { ...trackdata, date_added: new Date().toISOString(), tags: tags };
          setStar(tagButton, true);
          page.items[uniqueId] = newItem;
          page.member.set(uniqueId, new Set([collection]));
          sendChange({ type: "addTaggedItem", item: newItem, collections: [collection] }, "star", since);
        }
        return;
      }
      if (starred(uniqueId)) {
        // All: un-starring deletes the item and its tags from every collection, at once (no confirmation in the
        // extension: the user's choice).
        setStar(tagButton, false);
        delete page.items[uniqueId];
        page.member.delete(uniqueId);
        sendChange({ type: "removeTaggedItem", id: uniqueId }, "unstar", since);
      } else {
        // All: into every collection (none known yet: saved, and the server puts it into its first collection).
        const collections = targets();
        setStar(tagButton, true);
        page.member.set(uniqueId, new Set([...memberOf(uniqueId), ...collections]));
        if (saved) {
          sendChange({ type: "setMembership", op: "add", collections, id: uniqueId, item: saved }, "star", since);
        } else {
          const newItem = { ...trackdata, date_added: new Date().toISOString(), tags: tags };
          page.items[uniqueId] = newItem;
          sendChange({ type: "addTaggedItem", item: newItem, collections }, "star", since);
        }
      }
    }


    // if (star.classList.contains("filled")) {
    //   const metadata = extractMetadata(element);
    //   const newItem = {
    //     uniqueId: uniqueId,
    //     ...metadata,
    //   };

    //   chrome.runtime.sendMessage({ type: "addTaggedItem", item: newItem });
    // } else {
    //   chrome.runtime.sendMessage({ type: "removeTaggedItem", uniqueId });
    // }
  });

  // const dropdownArrow = document.createElement("span");
  // dropdownArrow.classList.add("dropdown-arrow");
  // container.appendChild(dropdownArrow);

  // const dropdownMenu = document.createElement("div");
  // dropdownMenu.classList.add("dropdown-menu");
  // tagButton.appendChild(dropdownMenu);

  // const favoriteTagOption = document.createElement("div");
  // // favoriteTagOption.innerText = "Favorite";
  // favoriteTagOption.classList.add("tag-option");
  //dropdownMenu.appendChild(favoriteTagOption);

  // Add more tag options based on the internal list of tags
  // ...

  // dropdownArrow.addEventListener("click", (event) => {
  //   event.stopPropagation();
  //   dropdownMenu.classList.toggle("visible");
  // });
  return container;
}

function extractAlbumData(tralbum) {

  return {
    title: "title" in tralbum.current ? tralbum.current.title : null,
    item_type: tralbum.type,
    artist: tralbum.artist,
    about: tralbum.current.about,
    band_id: tralbum.current.band_id,
    publish_date: tralbum.current.publish_date,
    raw_id: tralbum.id,
    item_type: tralbum.item_type,
    tralbum_type: "a",
    id: `a${tralbum.id}`,
    release_date: tralbum.album_release_date,
    art_id: tralbum.art_id,
    url: tralbum.url
  }
}



function extractCollectionItemData(tralbum, art_url) {
  // For a track, url_hints.slug is the track's own slug, so it can't name or
  // locate the album; the collection data has the album's id and title.
  const isTrack = tralbum.tralbum_type === "t";
  return {
    track_num: -1,
    title: tralbum.item_title,
    album_title: isTrack ? tralbum.album_title || null : tralbum.url_hints.slug,
    url: tralbum.item_url,
    tralbum_type: tralbum.tralbum_type,
    artist: tralbum.band_name,
    raw_id: tralbum.item_id,
    band_id: tralbum.band_id,
    publish_date: null,
    id: `${tralbum.tralbum_type}${tralbum.tralbum_id}`,
    item_url: tralbum.item_url,
    art_id: tralbum.item_art_id,
    album_id: isTrack && tralbum.album_id ? `a${tralbum.album_id}` : null,
    collected_count: tralbum.also_collected_count,
    album_url: isTrack ? null : `https://${tralbum.url_hints.subdomain}.bandcamp.com/album/${tralbum.url_hints.slug}`,
    art_url: art_url
  }
}

// TODO: Refactor so that it takes always tralbum and optional track id, first extracts album metadata then track metadata if it's a track
function extractTrackData(tralbum, album_data, item_url, art_url, album_artist=null) {
  // let data = extractAlbumData(tralbum);
  const track_num = "track_num" in tralbum ? tralbum.track_num : tralbum.trackinfo[0].track_num;
  // Album pages pass a trackinfo entry plus the album's data. On a track page
  // `tralbum` is the track itself: its album is current.album_id (null for a
  // single), not album_data.id, which would be "a" + the track's own id.
  let album_id;
  if ("album_id" in tralbum) album_id = tralbum.album_id;
  else if (tralbum.current) album_id = tralbum.current.album_id ? `a${tralbum.current.album_id}` : null;
  else album_id = album_data.id;
  const file = "file" in tralbum ? tralbum.file : tralbum.trackinfo[0].track_num;
  const album_title = album_data.title;

  const release_date = "release_date" in tralbum ? tralbum.release_date : tralbum.album_release_date;
  return {
    track_num: track_num,
    title: "title" in tralbum ? tralbum.title : tralbum.trackinfo[0].title ,
    album_title: album_title,
    item_type: "track",
    file: file,
    tralbum_type: "t",
    artist: tralbum.artist? tralbum.artist : album_artist,
    raw_id: tralbum.id,
    about: album_data.about,
    band_id: "band_id" in tralbum ? tralbum.band_id : album_data.band_id,
    publish_date: album_data.publish_date,
    id: `t${tralbum.id}`,
    release_date: tralbum.album_release_date,
    art_id: tralbum.art_id,
    album_id: album_id,
    url: tralbum.url,
    album_url: "album_url" in tralbum ? tralbum.album_url : album_data.url,
    item_url: item_url,
    art_url: art_url
  }
}

// "Now playing" (album pages): a box right below the player for the track it has loaded (before any play, the first),
// following it as it changes: next, previous, a row's play, the next track at the end of one. It's the same item as
// that track's row (`mirror`). Read from the player's title link and title (what Bandcamp's player changes), and its
// media events; a tab in the background only notes it, and catches up when shown or focused.
const nowPlaying = { id: null, container: null, stale: false, tracks: [], data: new Map() };
function playerTrackId() {
  const tracks = nowPlaying.tracks;
  const path = (url) => {
    try {
      return new URL(url, location.href).pathname;
    } catch (e) {
      return null;
    }
  };
  const link = document.querySelector(".inline_player a.title_link");
  const href = link && link.getAttribute("href");
  if (href && href !== "#") {
    const t = tracks.find((x) => x.title_link && path(x.title_link) === path(href));
    if (t) return `t${t.track_id}`;
  }
  const title = ((document.querySelector(".inline_player .title") || {}).textContent || "").trim();
  const t = title && tracks.find((x) => x.title === title);
  if (t) return `t${t.track_id}`;
  return nowPlaying.id || (tracks[0] ? `t${tracks[0].track_id}` : null);
}
function showNowPlaying() {
  if (document.hidden) {
    nowPlaying.stale = true;
    return;
  }
  nowPlaying.stale = false;
  const id = playerTrackId();
  const player = document.querySelector("#trackInfoInner .inline_player");
  if (!id || !player || !nowPlaying.data.has(id) || (id === nowPlaying.id && nowPlaying.container && nowPlaying.container.isConnected)) return;
  nowPlaying.id = id;
  if (nowPlaying.container) nowPlaying.container.remove();
  const t = nowPlaying.tracks.find((x) => `t${x.track_id}` === id) || {};
  nowPlaying.container = createTagButton(player, id, nowPlaying.data.get(id), {
    now: true,
    label: `Now playing: ${t.track_num != null ? `${t.track_num}. ` : ""}${t.title || ""}`,
    place: (c) => player.insertAdjacentElement("afterend", c),
  });
}
let nowTimer = null;
const showNowPlayingSoon = () => {
  clearTimeout(nowTimer);
  nowTimer = setTimeout(showNowPlaying, 150);
};
function followPlayer() {
  const player = document.querySelector("#trackInfoInner .inline_player");
  if (!player) return;
  new MutationObserver(showNowPlayingSoon).observe(player, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["href"] });
  ["loadstart", "play", "ended"].forEach((type) => document.addEventListener(type, showNowPlayingSoon, true));
  showNowPlaying();
}

// New widgets for `entries` ([{element, id, trackdata}]): their items' state from the worker first (one message for
// all of them), then the widgets; `done(containers)`.
function addWidgets(entries, done = null) {
  entries = entries.filter((e) => e.id);
  if (!entries.length) return;
  const ids = entries.map((e) => e.id);
  const first = page.rev == null;
  ids.forEach((id) => page.ids.add(id));
  const make = () => {
    const containers = entries.map((e) => createTagButton(e.element, e.id, e.trackdata));
    if (done) done(containers);
  };
  if (first) pull(null, true, make);
  else pull(ids, true, make);
}

{
  
  let allElements = [];
  if (trackPage) {
    
    allElements = document.querySelectorAll(".leftMiddleColumns");
  }
  else if (albumPage) {
    allElements = [
      ...document.querySelectorAll(".track_row_view"),
      ...document.querySelectorAll(".leftMiddleColumns")
    ];
  }
  else if (collectionPage){
    const collectionAlbumElements = document.querySelectorAll(".collection-item-container");
    const collectionTrackElements = document.querySelectorAll(".collection-item-compact");
    allElements = [
      ...collectionAlbumElements,
      ...collectionTrackElements,
    ];

  }
  
  

  // Combine all the NodeLists into a single array
  // const allElements = [
  //   ...trackElements,
  //   ...albumElements,
  //   ...collectionAlbumElements,
  //   ...collectionTrackElements,
  // ];

  const scriptWithRaw = $('script[data-tralbum]')
  let tralbum = {};
  let albumData = {}

  let art_url = $("#tralbumArt img").attr("src");
  
  // console.log(scriptWithRaw)
  if (albumPage || trackPage) {
    if (scriptWithRaw.length > 0) {
      tralbum = scriptWithRaw.data('tralbum');

    }
    
    albumData = extractAlbumData(tralbum);
    if (trackPage) {
      // (A single, on no album, has none.)
      const fromAlbum = document.querySelector(".fromAlbum");
      albumData.title = fromAlbum ? fromAlbum.innerHTML : null;
    }
  }



  const entries = [];
  allElements.forEach((element, index) => {
    var aElement = element.querySelector(".title a");
    let itemUrl = "";
    let itemId = "";
    if (aElement) {
      itemUrl = aElement.href;
    }
    else {

      itemUrl = getCurrentRawUrl();
    }


    let trackdata = {}
    if (collectionPage) {
      // itemUrl = element.querySelector('.collection-title-details a') 
      itemId = element.getAttribute('data-tralbumid');
      let itemType = element.getAttribute("data-tralbumtype");
      // if (itemType == "t") {

      //   return;

      //   trac
      // }
      itemId = `${itemType}${itemId}`;
      if (!(itemId in collectionData)) {
        return
      }
      let image_url = element.querySelector("img.collection-item-art").src;
      trackdata = extractCollectionItemData(collectionData[itemId], image_url)//itemType === "a" ? extractAlbumData(collectionData[itemId]) : extractTrackData(collectionData[itemId]); 

      // console.log("!!!!!!")
      // console.log(trackdata)

      

    }
    else {
      // if (!albumPage && !trackPage) {
      //   return;
      // }
      // const itemUrl = .href;
      let tralbumFor = {};

      trackdata = albumPage && index <  tralbum.trackinfo.length ? extractTrackData(tralbum.trackinfo[index], albumData, itemUrl, art_url, tralbum["artist"])  : (trackPage ? extractTrackData(tralbum, albumData, itemUrl, art_url, tralbum["artist"]) : albumData);
     
      // console.log("---- itemurl: " + trackdata["item_url"]);
      // trackdata = extractTrackData(tralbumFor, albumData)
      // console.log(trackdata)
      // itemId = `${trackdata.tralbum_type}${trackdata.id}`
      itemId = trackdata.id;
      


      // $.get(chrome.runtime.getURL('/taggerTemplate.html'), function(data) {
      //   $(data).appendTo('#trackInfo');
      //   $(".chosen-select").chosen({
      //     no_results_text: "Oops, nothing found!"
      //   });
      //   console.log("@@@@@@@ appended");

      //   fetch(itemUrl)
      // .then(function(response) {
      //     return response.text()
      // })
      // .then(function(html) {
      //     // Initialize the DOM parser
      //     var parser = new DOMParser();

      //     // Parse the text
      //     // var doc = parser.parseFromString(html, "text/html");

      //     const res = parseTrackInfo(html);

      //     // You can now even select part of that html as you would in the regular DOM 
      //     // Example:
      //     // var docArticle = doc.querySelector('article').innerHTML;

      //     console.log(res);
      // })
      // .catch(function(err) {  
      //     console.log('Failed to fetch page: ', err);  
      // });
      //   // Or if you're using jQuery 1.8+:
      //   // $($.parseHTML(data)).appendTo('body');
      // });
    }
    entries.push({ element, id: itemId, trackdata });
  });
  addWidgets(entries, (containers) => {
    // Imports waiting for a Bandcamp page can be linked to this one.
    const linkTargets = albumPage || trackPage ? containers.map((container, i) => ({ container, item: entries[i].trackdata })) : [];
    setupImportLinks(linkTargets).catch((e) => console.warn("[bc-tagger] import links", e));
    if (albumPage && Array.isArray(tralbum.trackinfo)) {
      nowPlaying.tracks = tralbum.trackinfo;
      entries.forEach((e) => e.trackdata.tralbum_type === "t" && nowPlaying.data.set(e.id, e.trackdata));
      followPlayer();
    }
  });
}

function updateDropdownMenu() {
  // Get the list of tags from the background script and update the dropdown menu
  chrome.runtime.sendMessage({ type: "getTags" }, (tags) => {
    const dropdownMenus = document.querySelectorAll(".tagger");
    dropdownMenus.forEach((menu) => {
      // Update the menu with the current list of tags
    });
  });
}


// // Communicate with background file by sending a message
// chrome.runtime.sendMessage(
//   {
//     type: 'GREETINGS',
//     payload: {
//       message: 'Hello, my name is Con. I am from ContentScript.',
//     },
//   },
//   (response) => {
//     console.log(response.message);
//   }
// );

// // Listen for message
// chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
//   if (request.type === 'COUNT') {
//     console.log(`Current count is ${request.payload.count}`);
//   }

//   // Send an empty response
//   // See https://github.com/mozilla/webextension-polyfill/issues/130#issuecomment-531531890
//   sendResponse({});
//   return true;
// });

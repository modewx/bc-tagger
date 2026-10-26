'use strict';
const cheerio = require('cheerio');

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
  console.log("------observer setr")
  observer = new MutationObserver(function(mutations) {
      console.log(`------observer w first cond ${"fan_data" in pageData} coll ${"collection_data" in pageData}`)
      console.log(pageData)
    
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
        console.log("####### ")
          console.log(json)
          let last = json.items.slice(-1)[0]
          if (last !== undefined) {
          lastItemId = `${last.tralbum_type}${last.tralbum_id}`
          }

          console.log(`-last ${lastItemId}`)
  
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
          console.log("####### len " + Object.entries(collectionData).length)
          console.log(collectionData)
          console.log("last_tokem " + json["last_token"]);


          console.log("------ autoscroll " + autoScrollToBottom)
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

        
    getTaggedItems((taggedItems) => {

      mutations.forEach((mutation) => {
        console.log(mutation)
        mutation.addedNodes.forEach((addedNode) => {
          let tralbumId = addedNode.getAttribute('data-tralbumid');
          let itemType = addedNode.getAttribute("data-tralbumtype");
          let id = `${itemType}${tralbumId}`;

          // console.log(Object.keys(collectionData))
          // console.log("id " + id + " is " + (id in collectionData));
          let image_url = addedNode.querySelector("img.collection-item-art").src;
          let trackdata = extractCollectionItemData(collectionData[id], image_url);//itemType
          // console.log(id);
          createTagButton(taggedItems, addedNode, id, trackdata);
        });
        
      });

    });


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
  console.log("%%%%%%%%%%")
  console.log(pageData);
  console.log(collectionData)
  console.log(`collection len ${Object.keys(collectionData).length}`)
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

function getTaggedItems(callback) {
  chrome.runtime.sendMessage({ type: "getTaggedItems" }, (taggedItems) => {
    callback(taggedItems);
  });
}

// When a tag is created/updated elsewhere (e.g. the popup), add any new tags to
// every annotation dropdown on the page without losing current selections, so
// no page reload is needed.
chrome.runtime.onMessage.addListener((request) => {
  if (request && request.type === "tagsUpdated") {
    const tags = request.tags || [];
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
});

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


function createTagButton(taggedItems, element, itemUrl, trackdata) {
  const uniqueId = itemUrl;//hashCode(itemUrl);

  const container = document.createElement("div");
  container.classList.add("tagger-container")

  const tagButton = document.createElement("button");
  tagButton.classList.add("tag-button");

  const star = document.createElement("span");
  star.classList.add("star");

  tagButton.innerHTML = "☆";

  const taggedItem = taggedItems[uniqueId];//taggedItems.find((item) => item.uniqueId === uniqueId);
  tagButton.appendChild(star);
  container.appendChild(tagButton);
  console.log(`--- tagged unique ${uniqueId}`);
  console.log(taggedItems);
  console.log(taggedItem);

  $.get(chrome.runtime.getURL('/taggerTemplate.html'), (data) => {

    // $(data).append($('<option>', {
    //   value: 'My opinion',
    //   text: 'My option'
    // }));
    // console.log("---data")
    // console.log(data)
    let taggerDiv = $('<div>')
    let tagger = $(data).find("select");
    tagger.attr("id", `tagger_${uniqueId}`);
    // $(data).append('<option>Bar</option>');
  //   chrome.runtime.sendMessage({ type: "getTags" }, (tags) => {

  //     console.log(tags)

  //  tags.forEach((tag) => {
  //   tagger.append( new Option(tag) );
  //  });

  // Tags come from the DB (seeded from tags.json), so newly created tags are
  // available without rebuilding or editing tags.json.
  chrome.runtime.sendMessage({ type: "getTags" }, (tags) => {
      (tags || []).forEach((tag) => {
        tagger.append( new Option(tag) );
      });

      let default_tags = [
        "must"
      ];

      if (taggedItem !== undefined && "tags" in taggedItem) {
        default_tags = taggedItem.tags;

      }

    // console.log("^^^^^^^^^^^^^");
    console.log(default_tags)

      tagger.val(default_tags)

      // tagger.appendTo($(container));
      taggerDiv.append(tagger)
      $(container).append(taggerDiv)
      // $(container).child.insertAdjacentElement('beforebegin', 0);
      $(".chosen-select").chosen({
          no_results_text: "Oops, nothing found!",
          width: "180px"
      });

      // Persist tag changes immediately: adding/removing a tag is an
      // annotation, so it should save (and star) the track without needing
      // the star button. The star stays the explicit save/un-save toggle.
      tagger.on("change", () => {
        const currentTags = $(container).find(".chosen-select").chosen().val() || [];
        getTaggedItems((currentTaggedItems) => {
          const existingItem = currentTaggedItems[uniqueId];
          if (existingItem) {
            // Already saved: update its tags in place, keep the rest of the
            // metadata (including date_added) intact.
            const updatedItem = {
              ...existingItem,
              tags: currentTags,
            };
            chrome.runtime.sendMessage({ type: "addTaggedItem", item: updatedItem });
          } else {
            // Not saved yet: annotating it saves it, and the star reflects that.
            const metadata = { ...trackdata };
            metadata["date_added"] = new Date().toISOString();
            const newItem = {
              ...metadata,
              tags: currentTags,
            };
            chrome.runtime.sendMessage({ type: "addTaggedItem", item: newItem });
            setStar(tagButton, true);
          }
        });
      });

      // .val(["hola","mundo","cruel"]).trigger('chosen:updated');
    //..
  });
    
   
   
    // console.log("@@@@@@@ appended");

  });

  if (taggedItem) {
    // star.classList.add("filled");
    setStar(tagButton, true);
  }
  
  
  
  // element.appendChild(container);
  if (albumPage) {
    if (trackdata.tralbum_type == "t") {
      element.children[2].insertAdjacentElement("afterEnd", container);
    }
    else if (trackdata.tralbum_type == "a"){
      // /element.children[1].insertAdjacentElement("beforebegin", container);
      element.querySelector("#trackInfoInner").children[3].insertAdjacentElement("afterEnd", container);
    }
  }
  else if (trackPage) {
    var k = element.querySelectorAll(".inline_player table tbody tr")[0];
    
    // m_url = element.querySelector(".track_row_view .title-col .title a");
    // console.log("==== url" )
    // console.log(m_url)

    // element.querySelectorAll(".inline_player table tbody tr")[0];
    // title-col
   
    console.log(k);
    k.appendChild(container);
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

    let tags = $(container).find(".chosen-select").chosen().val()
    // console.log("%%%%%%%%%%%%%%%%")
    // console.log(tags)

    // star.classList.toggle("filled");

    getTaggedItems((currentTaggedItems) => {
      const itemInCollection = currentTaggedItems[uniqueId];
      console.log("--item in coll?");
      console.log(itemInCollection);
      console.log("All items: ")
      console.log(currentTaggedItems)
      if (itemInCollection) {
        // Handle removing the item from the internal collection
        setStar(tagButton, false);
        console.log("@@@2222 removing " + uniqueId)
        chrome.runtime.sendMessage({ type: "removeTaggedItem", id: uniqueId });
    
      }
      else {
          // const metadata = extractMetadata(element);
          const metadata = trackdata;
          // metadata["itemUrl"] = itemUrl;
          console.log(`++++++ TOADD id ${uniqueId} metadata ${itemUrl}`);
          // console.log(metadata)
          metadata["date_added"] = new Date().toISOString();
          
          setStar(tagButton, true);
          const newItem = {
            ...metadata,
            tags: tags
          };
          console.log(newItem);
          chrome.runtime.sendMessage({ type: "addTaggedItem", item: newItem });

      }

    });


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
  console.log("---- extractCollectionItemData");
  console.log(tralbum);
  return {
    track_num: -1,
    title: tralbum.item_title,
    album_title: tralbum.url_hints.slug,
    url: tralbum.item_url,
    tralbum_type: tralbum.tralbum_type,
    artist: tralbum.band_name,
    raw_id: tralbum.item_id,
    band_id: tralbum.band_id,
    publish_date: null,
    id: `${tralbum.tralbum_type}${tralbum.tralbum_id}`,
    item_url: tralbum.item_url,
    art_id: tralbum.item_art_id,
    album_id: null,
    collected_count: tralbum.also_collected_count,
    album_url: `https://${tralbum.url_hints.subdomain}.bandcamp.com/album/${tralbum.url_hints.slug}`,
    art_url: art_url
  }
}

// TODO: Refactor so that it takes always tralbum and optional track id, first extracts album metadata then track metadata if it's a track
function extractTrackData(tralbum, album_data, item_url, art_url, album_artist=null) {
  console.log("#####")
  console.log(album_data)
  // let data = extractAlbumData(tralbum);
  const track_num = "track_num" in tralbum ? tralbum.track_num : tralbum.trackinfo[0].track_num;
  const album_id = "album_id" in tralbum ? tralbum.album_id : album_data.id;// "album_id" in tralbum ?  tralbum.album_id : album_data.id;
  const file = "file" in tralbum ? tralbum.file : tralbum.trackinfo[0].track_num;
  const album_title = album_data.title;

  const release_date = "release_date" in tralbum ? tralbum.release_date : tralbum.album_release_date;
  console.log(tralbum);
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

getTaggedItems((taggedItems) => {
  
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

      console.log(`********* obj ${tralbum}`)
      console.log(tralbum);
    }
    
    albumData = extractAlbumData(tralbum);
    if (trackPage) {
      albumData.title = document.querySelector(".fromAlbum").innerHTML;
    }
    console.log("&&&&&&&&& ")
    console.log(albumData)
  }



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
      console.log(`****** itemid ${itemUrl}`);
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
      console.log("---- itemurl: " +itemUrl + " --- index " + index + " 888888");
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
    createTagButton(taggedItems, element, itemId, trackdata);
  });
});

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

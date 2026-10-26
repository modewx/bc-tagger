function renderTagList(tags) {
    const tagList = document.getElementById("tagList");
  
    // Clear the tag list content
    tagList.innerHTML = "";
  
    tags.forEach((tag) => {
      const tagElement = document.createElement("div");
      tagElement.classList.add("tag");
  
      const tagName = document.createElement("span");
      tagName.innerText = tag;
      tagElement.appendChild(tagName);
  
      if (tag !== "Favorite") {
        const removeTagBtn = document.createElement("button");
        removeTagBtn.innerText = "Remove";
        removeTagBtn.addEventListener("click", () => {
          // Remove the tag from the list of tags
          const updatedTags = tags.filter((t) => t !== tag);
          chrome.runtime.sendMessage({ type: "updateTags", tags: updatedTags });
  
          // Re-render the tag list
          renderTagList(updatedTags);
        });
        tagElement.appendChild(removeTagBtn);
      }
  
      tagList.appendChild(tagElement);
    });
  }
  
  document.getElementById("addTagBtn").addEventListener("click", () => {
    const tagNameInput = document.getElementById("tagName");
    const tagName = tagNameInput.value.trim();
  
    if (tagName) {
      // Add the new tag to the list of tags
      chrome.runtime.sendMessage({ type: "getTags" }, (tags) => {
        if (!tags.includes(tagName)) {
          const updatedTags = [...tags, tagName];
          chrome.runtime.sendMessage({ type: "updateTags", tags: updatedTags });
  
          // Re-render the tag list
          renderTagList(updatedTags);
  
          // Clear the input field
          tagNameInput.value = "";
        } else {
          alert("Tag already exists!");
        }
      });
    } else {
      alert("Tag name cannot be empty!");
    }
  });
  
  // Get the list of tags and render the tag list
  chrome.runtime.sendMessage({ type: "getTags" }, (tags) => {
    renderTagList(tags);
  });
  
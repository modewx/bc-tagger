const nullthrows = (v) => {
    if (v == null) throw new Error("it's a null");
    return v;
}

function injectCode(src) {
    const script = document.createElement('script');
    // This is why it works!
    script.src = src;
    script.onload = function() {
        console.log("script injected");
        // this.remove();
    };

    // This script runs before the <head> element is created,
    // so we add the script to <html> instead.
    nullthrows(document.head || document.documentElement).appendChild(script);
}

function injectLink(href) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    // This is why it works!
    link.href = href;

    link.onload = function() {
        console.log("link injected");
        // this.remove();
    };

    // This script runs before the <head> element is created,
    // so we add the script to <html> instead.
    nullthrows(document.head || document.documentElement).appendChild(link);
}



injectCode(chrome.runtime.getURL('jquery_2.1.1_jquery.min.js'));
injectCode(chrome.runtime.getURL('chosen_1.8.7.min.js'));

injectLink("https://cdn.rawgit.com/harvesthq/chosen/gh-pages/chosen.min.css");
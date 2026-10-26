console.log("------- running")

let payButtonClicked = false;

/** Try to find and click the US Pay button. Returns true if clicked. */
function tryClickPayButton() {
    if (payButtonClicked) return true;
    const selectors = [
        "#one-time-cta",
        "button[data-id='one-time-cta']",
        "button[data-atomic-wait-task='select_pay']",
        "button[data-fpti='modxo_consent_submit_button_clicked']",
    ];
    for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn && !btn.disabled && !btn.getAttribute("aria-disabled")?.includes("true")) {
            console.log("Clicking Pay button via selector:", sel);
            payButtonClicked = true;
            btn.click();
            return true;
        }
    }
    return false;
}

function checkElementEnabled(targetSelector, observer, callback) {
    const $elem = $(targetSelector);
    console.log(`-- checkElementEnabled: ${targetSelector}`);
    if ($elem.length > 0 && !$elem.prop("disabled")) {
        console.log("Button appeared and is enabled:", $elem[0]);
        callback($elem);
        observer.disconnect();
    }
}

function createObserverFor(targetSelector, callback) {
    const observer = new MutationObserver((mutationsList, obs) => {
        for (const mutation of mutationsList) {
            if (mutation.type === "childList" || mutation.type === "attributes") {
                checkElementEnabled(targetSelector, obs, callback);
            }
        }
    });
    return observer;
}

let m = document.querySelector(".escape-controls span");
if ( m !== null) {
    console.log( document.querySelector(".escape-controls span"))
     m = document.querySelector(".escape-controls span").children[1]
}

console.log(m)
if (m !== null && m !== undefined){
m.click()
}

m = document.querySelector(".footer-button button");
if (m !== null && m !== undefined) {
    console.log("---------Did click----");
    m.click()
}

    // observer on data-testid=stacked-payment-options
setTimeout(() => {
 m =$("button[data-testid='currency-conversion-option-link']") //$("button:contains(See currency options)")
 console.log("currency opts")
 console.log(m[0])

 if (m && m.length) {
    m.click()

    // TODO change to observer
    setTimeout(() => {
        // let currency = $( "input[type='radio'][name$='vendorConversion']" )[0].nextSibling;
        let currency = $( "button[data-testid='vendorConversion']");
        currency.click()
        // fuck you aypal
        console.log("vendor" )
        console.log(currency[0])

        // $(`button[data-testid=currency-conversion-btn]`).click()
        setTimeout(() =>{
            console.log("====== click Pay ")
            let button = $("button[data-testid='currency-conversion-btn']");
            console.log(button)
            button.click();

            // setTimeout(
            //     () => {
            //         console.log("====== click Complete Purchase ");
            //         let button = $("button[data-testid='payment-submit-btn']");
            //         console.log(button);
            //         button.click();
            //     },
            //     1200
            // )
            // $("#payment-submit-btn").click()

            const targetSelector = "button[data-id='payment-submit-btn']";

           
            console.log("set observer");
            // Observe the entire document body for changes
            createObserverFor(targetSelector, (element) => element.click()).observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["disabled"]
            });
        },600)
    }, 400);
}
else {
    console.log("----- no currency conversion must be US site");
    // Immediate click if button already in DOM (MutationObserver only fires on changes)
    tryClickPayButton();
    // Observer for when button appears dynamically
    createObserverFor("button[data-id='one-time-cta']", (element) => {
        if (!payButtonClicked) {
            payButtonClicked = true;
            console.log("----------- clicking (observer)");
            element.click();
        }
    }).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled"]
    });
    // Polling fallback in case observer misses it (e.g. button in shadow DOM or iframe)
    const pollInterval = setInterval(() => {
        if (tryClickPayButton()) {
            clearInterval(pollInterval);
        }
    }, 300);
    setTimeout(() => clearInterval(pollInterval), 8000);
}

}, 400);

if (!m || !m.length) {
    setTimeout(() => {
        console.log("----- US site fallback");
        tryClickPayButton();
        const pollInterval = setInterval(() => {
            if (tryClickPayButton()) {
                clearInterval(pollInterval);
            }
        }, 300);
        setTimeout(() => clearInterval(pollInterval), 8000);
    }, 1000);
}
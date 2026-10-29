// Automatic steps on Bandcamp checkout and PayPal pages. The popup's
// "Checkout / PayPal automation" (checkoutAutomation in chrome.storage.local,
// on unless set to false) turns it off: then nothing here runs on the page,
// no listeners, no changes, no clicks. A change applies when the page next loads.
//
// On paypal.com: paypalCheckout.js (the card issuer's currency, never PayPal's
// conversion, then Pay). On Bandcamp's checkout: its two buttons, as before.
import { isPaypalHost, runPaypalCheckout } from "./paypalCheckout";

chrome.storage.local.get("checkoutAutomation", ({ checkoutAutomation }) => {
  if (checkoutAutomation === false) {
    console.log("[bc-tagger] checkout automation is off");
    return;
  }
  if (isPaypalHost(location.hostname)) runPaypalCheckout();
  else automateBandcampCheckout();
});

function automateBandcampCheckout() {
  console.log("[bc-tagger] bandcamp checkout");
  let m = document.querySelector(".escape-controls span");
  if (m !== null) m = m.children[1];
  if (m !== null && m !== undefined) m.click();

  m = document.querySelector(".footer-button button");
  if (m !== null && m !== undefined) {
    console.log("[bc-tagger] bandcamp checkout: footer button");
    m.click();
  }
}

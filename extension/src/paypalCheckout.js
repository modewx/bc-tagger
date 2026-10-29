// PayPal's pay page (the PayPal part of checkout.js): choose the card issuer's currency instead of PayPal's
// conversion, then Pay. PayPal's page is a single-page app, so the step is read from the page, whatever the URL:
//
//   trigger  the order details say "Conversion options available" (PayPal's rate): open them
//   link     "Available currency options": open the Currency options screen (a client-side route or a full load)
//   tab      the Currency options tabs: the non-USD one (the second, if it isn't USD; else the first that isn't).
//            Radix tabs switch on mousedown, not click: pointer and mouse events, then focus and Enter
//   use      "Use <that currency>" (never "Use USD"), once its tab is chosen
//   pay      Pay, only when no conversion is offered at all (a USD order), or this checkout chose the card issuer's
//            currency and the page no longer shows PayPal's rate
//
// Anything else (PayPal's rate still shown after the choice, no currency options, no non-USD tab, a step that
// changes nothing even after a retry): stop, with a notice on the page; Pay is the user's. Pay is never clicked
// while the page shows PayPal's rate.
//
// Each step is done once, again at most once if nothing changed after `retryMs`. The progress is kept in
// sessionStorage by the checkout's token: it survives a full load and never loops. Driven by a MutationObserver on
// the page, with a short poll as a fallback. No imports: scripts/e2e/paypalCheckout.test.mjs runs it on fixtures.

export const isPaypalHost = (host) => /(^|\.)paypal\.com$/i.test(String(host || ""));

const SEL = {
  trigger: 'button[aria-expanded][data-dd-action-name="Order details Tab"]',
  link: 'a[data-atomic-wait-intent="Open_Currency_Conversion_Options_Screen"]',
  tabs: '[role="tablist"] [role="tab"]',
  use: 'button[data-atomic-wait-intent="Submit_Currency_Conversion_Options"]',
  pay: ["#one-time-cta", "button[data-id='one-time-cta']", "button[data-atomic-wait-task='select_pay']"],
};
// "PayPal rate: …", "PayPal's conversion rate: …" (PayPal writes a curly apostrophe).
const PAYPAL_RATE = /PayPal(?:['’]s)?\s+(?:conversion\s+)?rate/i;
const OFFERED = /Conversion options available/i;
const NOTICE_ID = "bc-tagger-paypal-notice";
const NOTICE = "bc-tagger: couldn't choose the card issuer's currency; pick it and press Pay yourself";

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const disabled = (el) => !!el && (el.disabled || el.getAttribute("aria-disabled") === "true");

/**
 * @param {object} [o]
 * @param {Document} [o.doc]
 * @param {Window} [o.win]
 * @param {Storage} [o.storage]   where the progress is kept (sessionStorage)
 * @param {number} [o.retryMs]    a step that changed nothing is done again after this, once
 * @param {number} [o.settleMs]   how long the pay page must hold still before Pay (or the notice)
 * @param {number} [o.pollMs]     the fallback poll
 * @returns {{stop: () => void}}
 */
export function runPaypalCheckout({
  doc = document,
  win = window,
  storage = win.sessionStorage,
  retryMs = 3000,
  settleMs = 1200,
  pollMs = 250,
  log = (msg) => console.log(`[bc-tagger] paypal: ${msg}`),
} = {}) {
  const token = new URLSearchParams(win.location.search).get("token") || win.location.pathname;
  const KEY = `bc-tagger:paypal:${token}`;
  let st = { acts: {} };
  try {
    st = { acts: {}, ...(JSON.parse(storage.getItem(KEY)) || {}) };
  } catch (e) {
    /* none kept */
  }
  const save = () => {
    try {
      storage.setItem(KEY, JSON.stringify(st));
    } catch (e) {
      /* kept in memory only */
    }
  };

  let observer = null;
  let poll = null;
  let settling = null; // {key, since}: the pay page held still in this state since
  let finished = false;

  function finish() {
    finished = true;
    if (observer) observer.disconnect();
    clearInterval(poll);
  }

  function showNotice() {
    if (doc.getElementById(NOTICE_ID)) return;
    const box = doc.createElement("div");
    box.id = NOTICE_ID;
    box.setAttribute("role", "status");
    box.textContent = NOTICE;
    box.style.cssText =
      "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;max-width:90vw;" +
      "background:#fff4e5;color:#7a4100;border:1px solid #f0b46c;border-radius:8px;padding:10px 14px;" +
      "font:14px/1.4 -apple-system,system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.18)";
    (doc.body || doc.documentElement).appendChild(box);
  }

  function stop(reason) {
    st.stopped = reason;
    save();
    log(`stopped: ${reason}`);
    showNotice();
    finish();
  }

  // Do `step` once; again once if the page hasn't moved on after retryMs; then stop.
  function act(step, fn) {
    const a = st.acts[step];
    const now = Date.now();
    if (a && now - a.at < retryMs) return;
    if (a && a.tries >= 2) return stop(`${step}: nothing changed, even after a retry`);
    st.acts[step] = { at: now, tries: (a ? a.tries : 0) + 1 };
    save();
    log(a ? `${step} (again)` : step);
    fn();
  }

  // Radix TabsTrigger changes on mousedown (left button, no ctrl), on Enter/Space, and on focus; not on click.
  function pressTab(tab) {
    const base = { bubbles: true, cancelable: true, composed: true, view: win, button: 0, ctrlKey: false };
    const Pointer = win.PointerEvent || win.MouseEvent;
    tab.dispatchEvent(new Pointer("pointerdown", { ...base, buttons: 1, pointerType: "mouse", isPrimary: true }));
    tab.dispatchEvent(new win.MouseEvent("mousedown", { ...base, buttons: 1 }));
    tab.dispatchEvent(new Pointer("pointerup", { ...base, buttons: 0, pointerType: "mouse", isPrimary: true }));
    tab.dispatchEvent(new win.MouseEvent("mouseup", { ...base, buttons: 0 }));
    tab.dispatchEvent(new win.MouseEvent("click", { ...base, buttons: 0 }));
  }
  function keyTab(tab) {
    tab.focus();
    ["keydown", "keyup"].forEach((type) =>
      tab.dispatchEvent(new win.KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true, cancelable: true }))
    );
  }

  const payButton = () => {
    for (const sel of SEL.pay) {
      const btn = doc.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  };
  const shown = (el) => !!el && el.getClientRects().length > 0;
  const pageText = () => (doc.body ? doc.body.innerText || doc.body.textContent || "" : "");

  // The Currency options screen: choose the non-USD tab, then "Use <it>".
  function options(tabs, use) {
    const name = (t) => norm(t.textContent);
    const target = tabs[1] && name(tabs[1]) !== "USD" ? tabs[1] : tabs.find((t) => name(t) !== "USD");
    if (!target) return stop("no currency but USD");
    const currency = name(target);
    if (target.getAttribute("aria-selected") !== "true") {
      const a = st.acts.tab;
      if (a && !a.key && Date.now() - a.at > Math.min(800, retryMs / 2)) {
        a.key = true; // the mouse didn't switch it: focus and Enter (a retry tries the mouse again, then this)
        save();
        log(`tab ${currency}: focus and Enter`);
        keyTab(target);
        return;
      }
      return act("tab", () => pressTab(target));
    }
    const label = norm(use.textContent);
    if (label !== `Use ${currency}` || label === "Use USD" || disabled(use)) return; // not yet (its label follows the tab)
    act("use", () => {
      st.chosen = currency;
      save();
      use.click();
    });
  }

  function tick() {
    if (finished) return;
    if (st.paid || st.stopped) return finish();
    const tabs = [...doc.querySelectorAll(SEL.tabs)];
    const use = doc.querySelector(SEL.use);
    if (tabs.length && use) {
      settling = null;
      return options(tabs, use);
    }
    const paypalRate = PAYPAL_RATE.test(pageText());
    const pay = payButton();
    const ready = !!pay && !disabled(pay) && shown(pay);
    if (!st.chosen) {
      const link = doc.querySelector(SEL.link);
      if (shown(link)) {
        settling = null;
        return act("link", () => link.click());
      }
      const trigger = doc.querySelector(SEL.trigger);
      if (trigger && trigger.getAttribute("aria-expanded") === "false" && (OFFERED.test(trigger.textContent) || PAYPAL_RATE.test(trigger.textContent))) {
        settling = null;
        return act("trigger", () => trigger.click());
      }
    }
    if (!ready) {
      settling = null;
      return;
    }
    // The pay page, with nothing left to choose: it must hold still a moment (it may still be filling in).
    const offered = paypalRate || [...doc.querySelectorAll(SEL.trigger)].some((t) => OFFERED.test(t.textContent));
    const state = `${st.chosen || ""}|${paypalRate}|${offered}`;
    if (!settling || settling.key !== state) {
      settling = { key: state, since: Date.now() };
      return;
    }
    if (Date.now() - settling.since < settleMs) return;
    if (paypalRate) return stop(st.chosen ? `still PayPal's rate after choosing ${st.chosen}` : "PayPal's rate, and no currency options");
    if (!st.chosen && offered) return stop("conversion options, but none could be opened");
    st.paid = true;
    save();
    log(st.chosen ? `Pay (in ${st.chosen}, the card issuer's rate)` : "Pay (no conversion offered)");
    pay.click();
    finish();
  }

  if (st.paid || st.stopped) {
    log(st.paid ? "paid already for this checkout" : `stopped earlier: ${st.stopped}`);
    if (st.stopped) showNotice();
    return { stop: finish };
  }
  observer = new win.MutationObserver(() => tick());
  observer.observe(doc.body || doc.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-selected", "aria-expanded", "aria-disabled", "disabled", "data-state", "hidden"],
  });
  poll = setInterval(tick, pollMs);
  log(st.chosen ? `started (${st.chosen} chosen earlier in this checkout)` : "started");
  tick();
  return { stop: finish };
}

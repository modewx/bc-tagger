// The PayPal part of checkout.js (extension/src/paypalCheckout.js) on a sanitized stand-in of PayPal's pay flow
// (fixtures/paypal/paypal-flow.html), from file:// with every other request aborted: no network, no PayPal.
// Run: npm run test:paypal
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(ROOT, "scripts/e2e/fixtures/paypal/paypal-flow.html");
// The module as the content script has it, minus `export` (it imports nothing).
const SOURCE = fs.readFileSync(path.join(ROOT, "extension/src/paypalCheckout.js"), "utf8").replace(/^export /gm, "");
// Its waits, shorter (the real ones: retry 3000 ms, settle 1200 ms, poll 250 ms).
const QUICK = { retryMs: 200, settleMs: 100, pollMs: 40 };
const HOLD = 2 * (QUICK.retryMs + QUICK.settleMs); // past another retry and the settle: a late Pay would have come by then

let browser;
let context;
before(async () => {
  browser = await chromium.launch();
  context = await browser.newContext();
  await context.route("**/*", (route) => (route.request().url().startsWith("file://") ? route.continue() : route.abort()));
});
after(async () => {
  await browser.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fresh tab on the stand-in; the PayPal logic runs on each load of it, as the content script does.
async function checkout(params) {
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => /\[bc-tagger\] paypal:/.test(m.text()) && logs.push(m.text().replace("[bc-tagger] paypal: ", "")));
  await page.addInitScript(
    ({ source, options }) => {
      const run = new Function(`${source}\nreturn runPaypalCheckout;`)();
      document.addEventListener("DOMContentLoaded", () => run(options));
    },
    { source: SOURCE, options: QUICK }
  );
  const query = new URLSearchParams({ token: "EC-E2E000TEST", ...params });
  await page.goto(`file://${FIXTURE}?${query}`);
  return {
    page,
    logs,
    clicks: () => page.evaluate(() => window.__clicks()),
    notice: () => page.evaluate(() => (document.getElementById("bc-tagger-paypal-notice") || {}).textContent || null),
    until: (fn, timeout = 8000) => page.waitForFunction(fn, null, { timeout, polling: 50 }),
  };
}
const NOTICE = "bc-tagger: couldn't choose the card issuer's currency; pick it and press Pay yourself";
const paid = "window.__clicks().includes('pay')";
const noticed = "!!document.getElementById('bc-tagger-paypal-notice')";

test("the whole path, in one page: order details → currency options → the EUR tab (switched by mousedown, like Radix) → Use EUR → Pay", async () => {
  const c = await checkout({ screen: "pay-collapsed" });
  await c.until(paid);
  assert.deepEqual(await c.clicks(), ["trigger", "link", "tab:EUR", "use:EUR", "pay"]);
  assert.deepEqual(c.logs.slice(1), ["trigger", "link", "tab", "use", "Pay (in EUR, the card issuer's rate)"]);
  await c.page.close();
});

test("the same with full page loads (the link and Use load a new page): the progress is kept for the checkout's token", async () => {
  const c = await checkout({ screen: "pay-collapsed", mode: "full" });
  await c.until(paid);
  assert.deepEqual(await c.clicks(), ["trigger", "link", "tab:EUR", "use:EUR", "pay"]);
  assert.match(c.logs.join("\n"), /started \(EUR chosen earlier in this checkout\)/);
  await c.page.close();
});

test("tabs that only switch on Enter (focus and Enter), and a second tab that is USD (the first that isn't)", async () => {
  const c = await checkout({ screen: "options", tabs: "EUR,USD", keysOnly: "1" });
  await c.until(paid);
  assert.deepEqual(await c.clicks(), ["tab:EUR", "use:EUR", "pay"]);
  assert.ok(c.logs.includes("tab EUR: focus and Enter"));
  await c.page.close();
});

test("a USD order (no conversion offered): Pay", async () => {
  const c = await checkout({ screen: "pay-usd" });
  await c.until(paid);
  assert.deepEqual(await c.clicks(), ["pay"]);
  assert.equal(await c.notice(), null);
  await c.page.close();
});

test("Pay is never clicked while the page shows PayPal's rate: order details or currency options that won't open → the notice", async () => {
  for (const screen of ["pay-collapsed", "pay-expanded"]) {
    const c = await checkout({ screen, stuck: "1" });
    await c.until(noticed);
    await sleep(HOLD); // held
    const clicks = await c.clicks();
    assert.ok(!clicks.includes("pay"), `${screen}: ${clicks}`);
    assert.deepEqual(clicks, screen === "pay-collapsed" ? ["trigger", "trigger"] : ["link", "link"], "once, then once more");
    assert.equal(await c.notice(), NOTICE);
    await c.page.close();
  }
});

test("PayPal's rate still shown after Use EUR: the notice, no Pay", async () => {
  const c = await checkout({ screen: "pay-collapsed", after: "pay-still" });
  await c.until(noticed);
  await sleep(HOLD);
  assert.deepEqual(await c.clicks(), ["trigger", "link", "tab:EUR", "use:EUR"]);
  assert.match(c.logs.join("\n"), /stopped: still PayPal's rate after choosing EUR/);
  await c.page.close();
});

test('"Use USD" is never clicked: tabs that won\'t switch → the notice', async () => {
  const c = await checkout({ screen: "options", frozen: "1" });
  await c.until(noticed);
  await sleep(HOLD);
  assert.deepEqual(await c.clicks(), [], "no Use USD, no Pay");
  assert.match(c.logs.join("\n"), /stopped: tab: nothing changed, even after a retry/);
  await c.page.close();
});

test("no currency but USD: the notice, no Pay", async () => {
  const c = await checkout({ screen: "options", tabs: "USD" });
  await c.until(noticed);
  await sleep(200); // stopped: nothing listens any more
  assert.deepEqual(await c.clicks(), []);
  assert.match(c.logs.join("\n"), /stopped: no currency but USD/);
  await c.page.close();
});

test("a checkout that stopped stays stopped on its next load (no loop): the notice again, nothing clicked", async () => {
  const c = await checkout({ screen: "options", tabs: "USD" });
  await c.until(noticed);
  await c.page.reload();
  await c.until(noticed);
  await sleep(200); // stopped: nothing listens any more
  assert.deepEqual(await c.clicks(), []);
  assert.match(c.logs.join("\n"), /stopped earlier: no currency but USD/);
  await c.page.close();
});

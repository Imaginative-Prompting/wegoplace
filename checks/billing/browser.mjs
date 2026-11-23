// The plan's card on the account page, in a browser (Chrome for Testing), through the stand-in
// Stripe's Checkout and Portal pages (checks/lib/stripe-standin.mjs): nothing reaches Stripe.
//
//   node checks/billing/browser.mjs [--port <port>] [--shots <folder>] [--look]
//
// It holds:
//   1. a host with no plan: the card offers more room in words (the free limit, the pool, that the
//      people on their trips share it), what they use, and Stripe's own price on its two buttons;
//      no assistant named while it is off;
//   2. "Get more room": Stripe's Checkout (here the stand-in's) at the monthly price; paid, back on the
//      account page, which reads the plan until it is on and says so; the address loses ?plan=done;
//   3. the card with the plan: the pool, monthly and the day it renews, "Manage your plan";
//   4. "Manage your plan": the Portal; cancelled there to the end of the period and back, the card
//      says the day it ends and that nothing is removed;
//   5. "Don't cancel" in the Portal: the card says the day it renews again;
//   6. refunded in full (charge.refunded): the plan ends, and the card says so and why (with the day when the server
//      gives it), that nothing is removed, and offers more room again; then every other way a plan ends (the row set to
//      each reason and status the server can answer, and one it doesn't know), each with its own words: none is silent;
//   7. sales paused (PLAN_SALES "paused", a second server): a host without the plan is told in words it isn't on sale,
//      and the buy button can't be pressed and says why; no yearly button;
//   7c. a plan given by the site's operator (0046), on a server that sells no plan (a third server): the card says it's
//      on and given, the pool and the assistant, with nothing to buy or manage;
//   8. no page error.
// --shots: the card in each state, light and dark, at 390 and 320; with --look at 1440 and at 320
// with the phone's text a step larger (Safari's 115%: laid out at 278 CSS px on the 320 screen).
// Everyone in it is made up.

import fs from "node:fs";
import path from "node:path";
import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";
import { startStripe } from "../lib/stripe-standin.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8857);
const shots = flag("--shots");
const LOOK = argv.includes("--look");
const STILL_SIZES = LOOK
  ? [{ label: "1440", width: 1440, height: 900, scale: 1, mobile: false }, { label: "320-text115", width: 278, height: 557, scale: 2.3, mobile: true }]
  : [{ label: "390", width: 390, height: 844, scale: 2, mobile: true }, { label: "320", width: 320, height: 640, scale: 2, mobile: true }];
if (shots) fs.mkdirSync(shots, { recursive: true });
const t = new Report("the plan's card, in a browser, through the stand-in Stripe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = "whsec_check_not_real";
const KEY = "sk_test_check_not_real";

let server, paused, given, stripe, chrome, code = 1;
try {
  stripe = await startStripe({ secret: SECRET, key: KEY });
  server = await startServer({
    name: "billing-browser", port,
    vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_check_month", STRIPE_PRICE_YEARLY: "price_check_year", STRIPE_API_BASE: stripe.base },
    secrets: { STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET },
  });
  await server.start();
  const { origin } = server;
  const ada = new Person(origin, "Ada Reyes");
  if ((await ada.signUp()).status !== 200) throw new CheckError("couldn't make the host");
  await ada.post("/api/trips", { name: "Lake week", default_tz: "UTC" });

  chrome = await openChrome();
  const page = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
  await page.setCookie(origin, "wgp_session", ada.jar.cookies.get("wgp_session"));
  const text = (id) => page.eval(`(document.getElementById(${JSON.stringify(id)})?.textContent ?? "").replace(/\\s+/g, " ").trim()`);
  const shown = (id) => page.eval(`(() => { const n = document.getElementById(${JSON.stringify(id)}); return !!n && !n.hidden && n.getClientRects().length > 0; })()`);
  // Read once the page itself is shown, not only its card: the card is painted while the page is still hidden for its
  // other calls, and read then a line of it has no box, so shown() says no though its words are there (21 Nov: 7b and 7c
  // each red once on a busy run, their state lines "").
  const card = async () => (await page.until(`!document.getElementById("account").hidden`, "the account page shown", 20000), {
    title: await text("plan-title"), lead: await text("plan-lead"), use: await text("plan-use"), state: (await shown("plan-state")) ? await text("plan-state") : "",
    monthly: (await shown("btn-plan-monthly")) ? await text("btn-plan-monthly") : null, yearly: (await shown("btn-plan-yearly")) ? await text("btn-plan-yearly") : null,
    manage: await shown("btn-plan-manage"), msg: (await shown("msg-plan")) ? await text("msg-plan") : "" });
  const still = async (name) => {
    if (!shots) return;
    for (const size of STILL_SIZES) for (const scheme of ["light", "dark"]) {
      await page.size({ width: size.width, height: size.height, mobile: size.mobile });
      await page.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: size.mobile });
      await page.scheme(scheme);
      await page.eval(`(document.getElementById("plan").scrollIntoView({ block: "start" }), 1)`);
      await sleep(400);
      // Two frames drawn first, and a blank capture taken again (headless Chrome sometimes hands back
      // only the page's ground after a change).
      let png = null;
      for (let i = 0; i < 2 && !(png && png.length > 20_000); i++) {
        await page.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))");
        png = Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64");
      }
      fs.writeFileSync(path.join(shots, `${name}-${size.label}-${scheme}.png`), png);
    }
    await page.size({ width: 390, height: 844, mobile: true });
    await page.scheme("light");
  };

  t.part("1. A host with no plan");
  await page.goto(`${origin}/account`);
  await page.until(`!document.getElementById("account").hidden && !document.getElementById("plan").hidden`, "the account page with its plan card", 20000);
  const offer = await card();
  t.same("the card offers more room in words, with what they use and Stripe's own prices, and no assistant while it's off",
    offer, { title: "More room", lead: "You have 1 GB free across the trips you host. The plan makes it 50 GB. The people on your trips share it: nobody else pays.",
      use: "You use 0 MB of 1 GB.", state: "", monthly: "Get more room, $5.00 a month", yearly: "Or $50.00 a year", manage: false, msg: "" });
  await still("1-offer");

  t.part("2. Get more room: Checkout, paid, back");
  await page.click("#btn-plan-monthly");
  await page.until(`location.href.startsWith(${JSON.stringify(`${stripe.base}/pay/`)}) && !!document.getElementById("sc-pay")`, "the stand-in's Checkout", 20000);
  t.same("Stripe's Checkout (here the stand-in's), at the monthly price", await page.eval(`document.getElementById("sc-price").textContent`), "5.00 USD a month");
  await page.click("#sc-pay");
  await page.until(`location.origin === ${JSON.stringify(origin)} && location.pathname === "/account" && document.getElementById("plan-title")?.textContent === "Your plan"`, "back on the account page with the plan", 30000);
  await page.until(`/your plan is on/.test(document.getElementById("msg-plan")?.textContent ?? "")`, "the thanks", 20000).catch(() => {});
  const paid = await card();
  t.same("paid: back on the account page, which says the plan is on", [paid.title, paid.msg, await page.eval("location.search + location.hash")], ["Your plan", "Thanks: your plan is on.", "#plan"]);

  t.part("3. The card with the plan");
  t.ok("the pool, monthly and the day it renews, and Manage your plan",
    paid.lead === "50 GB across the trips you host. The people on your trips share it: nobody else pays." && /^Monthly, renews on [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/.test(paid.state) && paid.manage && paid.monthly === null && paid.use === "You use 0 MB of 50 GB.", JSON.stringify(paid));
  await still("2-plan");

  t.part("4. Manage your plan: the Portal");
  await page.click("#btn-plan-manage");
  await page.until(`location.href.startsWith(${JSON.stringify(`${stripe.base}/portal/`)}) && !!document.getElementById("sp-cancel")`, "the stand-in's Portal", 20000);
  await page.click("#sp-cancel");
  await page.until(`location.origin === ${JSON.stringify(origin)} && location.pathname === "/account" && !document.getElementById("plan").hidden`, "back on the account page", 20000);
  await page.until(`/ends on/.test(document.getElementById("plan-state")?.textContent ?? "")`, "the day it ends", 15000).catch(() => {});
  const ending = await card();
  t.ok("cancelled there to the end of the period: the card says the day it ends, and that nothing is removed",
    /^It ends on [A-Z][a-z]{2} \d{1,2}, \d{4}; nothing you've added is removed\.$/.test(ending.state) && ending.manage, JSON.stringify(ending));
  await still("3-ending");

  t.part("5. Don't cancel, in the Portal");
  await page.click("#btn-plan-manage");
  await page.until(`location.href.startsWith(${JSON.stringify(`${stripe.base}/portal/`)}) && !!document.getElementById("sp-renew")`, "the stand-in's Portal, cancelling", 20000);
  await page.click("#sp-renew");
  await page.until(`location.origin === ${JSON.stringify(origin)} && location.pathname === "/account" && !document.getElementById("plan").hidden`, "back on the account page", 20000);
  await page.until(`/renews on/.test(document.getElementById("plan-state")?.textContent ?? "")`, "the day it renews", 15000).catch(() => {});
  const renewing = await card();
  t.ok("not cancelled after all: the card says the day it renews again", /^Monthly, renews on [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/.test(renewing.state) && renewing.manage, JSON.stringify(renewing));

  t.part("5b. Past due: the plan stays on, and the card says how to fix it");
  const adaSub = server.sql(`SELECT id FROM billing_subscriptions WHERE user_id = '${ada.user.id}'`)[0].id;
  stripe.sub(adaSub).status = "past_due";
  t.same("  (Stripe says so through the webhook)", (await stripe.send(origin, "customer.subscription.updated", { id: adaSub })).status, 200);
  await page.eval(`(location.reload(), 1)`);
  await page.until(`/didn't go through/.test(document.getElementById("plan-state")?.textContent ?? "")`, "the card, past due", 20000).catch(() => {});
  const due = await card();
  const dueRoom = JSON.parse(await page.eval(`fetch("/api/account/plan", { credentials: "same-origin" }).then((r) => r.json()).then((b) => JSON.stringify({ active: b.plan?.active, status: b.plan?.status, limit: b.room?.limit, pool: b.room?.pool }))`));
  t.ok("the card says \"Your last payment didn't go through: update how you pay in Manage your plan. The plan stays on while it's tried again.\" and no \"renews on\", the plan still on (its pool, Manage your plan, no buy button)",
    due.state === "Your last payment didn't go through: update how you pay in Manage your plan. The plan stays on while it's tried again."
      && due.lead === paid.lead && due.manage && due.monthly === null, JSON.stringify(due));
  t.same("  and the room is still the plan's: the limit every upload is held to is the pool (check:billing uploads over the free limit while past due)",
    dueRoom, { active: true, status: "past_due", limit: dueRoom.pool, pool: 50 * 1024 ** 3 });
  await still("3b-past-due");
  stripe.sub(adaSub).status = "active";
  await stripe.send(origin, "customer.subscription.updated", { id: adaSub });

  t.part("6. Refunded: the plan ends, and the card says why");
  const adaCustomer = server.sql(`SELECT customer FROM billing_customers WHERE user_id = '${ada.user.id}'`)[0].customer;
  const refund = await stripe.send(origin, "charge.refunded", stripe.charge(adaCustomer, { refunded: true }));
  t.same("  (the refund reaches the Worker's webhook)", refund.status, 200);
  await page.eval(`(location.reload(), 1)`);
  await page.until(`/refunded/.test(document.getElementById("plan-state")?.textContent ?? "") && !document.getElementById("plan").hidden`, "the card after the refund", 20000).catch(() => {});
  const refunded = await card();
  t.ok("the card says the plan ended because the payment was refunded, that nothing is removed, and offers more room again",
    /^More room$/.test(refunded.title) && /^Your plan ended( on [A-Z][a-z]{2} \d{1,2}, \d{4})?: the payment was refunded\. Nothing you've added is removed[.;]/.test(refunded.state)
      && !refunded.manage && !!refunded.monthly, JSON.stringify(refunded));
  await still("4-refunded");
  // Every other ending the server can answer (src/billing/plan.js), set on Ada's row, the page read again.
  const ENDINGS = [
    ["canceled", "canceled", ""], ["payment_failed", "unpaid", ": the payment didn't go through"], ["payment_failed", "canceled", ": the payment didn't go through"],
    ["never_paid", "incomplete_expired", ": the first payment didn't go through"], ["dispute_lost", "canceled", ": the payment was disputed with your bank"],
    [null, "canceled", ""], ["a_reason_not_known_yet", "canceled", ""],
  ];
  for (const [reason, status, why] of ENDINGS) {
    server.sql(`UPDATE billing_subscriptions SET ended_reason = ${reason === null ? "NULL" : `'${reason}'`}, status = '${status}' WHERE user_id = '${ada.user.id}'`);
    // The old page is marked and the new one waited for: the ending before says "Your plan ended" too, so without the
    // mark the wait could match the old page and the card be read from the new one mid-load (21 Nov: state "" once in six).
    await page.eval(`(window.__oldPage = 1, location.reload(), 1)`);
    await page.until(`!window.__oldPage && !document.getElementById("plan").hidden && /^Your plan ended/.test(document.getElementById("plan-state")?.textContent ?? "")`, `the card, ended (${reason})`, 20000).catch(() => {});
    const c = await card();
    const want = new RegExp(`^Your plan ended( on [A-Z][a-z]{2} \\d{1,2}, \\d{4})?${why.replace(/[.'*+?^${}()|[\]\\]/g, "\\$&")}\\. Nothing you've added is removed[.;]`);
    t.ok(`ended, ${reason ?? "no reason"} (${status}): ${why ? `"${why.slice(2)}"` : "the day only"}, and nothing removed`, want.test(c.state) && !!c.monthly && !c.manage, JSON.stringify(c.state));
  }

  t.part("7. Stripe refusing Checkout: the person reads the app's plain words, and nothing else");
  const di = new Person(origin, "Di Moreau");
  if ((await di.signUp()).status !== 200) throw new CheckError("couldn't make the host for Stripe refusing");
  await page.setCookie(origin, "wgp_session", di.jar.cookies.get("wgp_session"));
  await page.goto(`${origin}/account`);
  await page.until(`!document.getElementById("plan").hidden && !document.getElementById("btn-plan-monthly").hidden`, "the card offering the plan", 20000);
  stripe.failNext(1);
  await page.click("#btn-plan-monthly");
  await page.until(`!document.getElementById("msg-plan").hidden && /couldn't/.test(document.getElementById("msg-plan").textContent)`, "the refusal under the card", 20000).catch(() => {});
  const refusal = JSON.parse(await page.eval(`JSON.stringify({ msg: document.getElementById("msg-plan").textContent.replace(/\\s+/g, " ").trim(),
    detail: document.getElementById("detail").hidden ? "" : document.getElementById("detail").textContent, at: location.pathname })`));
  t.same("the words under the card are the server's, alone (no \"Something went wrong\", no detail, Stripe's own message nowhere)",
    refusal, { msg: "The payment page couldn't be opened just now. Nothing was charged. Try again in a minute.", detail: "", at: "/account" });

  t.part("7b. Sales paused: a host without the plan is told so");
  paused = await startServer({
    name: "billing-browser-paused", port: port + 1,
    vars: { PLAN_ENABLED: "true", PLAN_SALES: "paused", STRIPE_PRICE_MONTHLY: "price_check_month", STRIPE_PRICE_YEARLY: "price_check_year", STRIPE_API_BASE: stripe.base },
    secrets: { STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET },
  });
  await paused.start();
  const bo = new Person(paused.origin, "Bo Lind");
  if ((await bo.signUp()).status !== 200) throw new CheckError("couldn't make the host on the paused server");
  await page.setCookie(paused.origin, "wgp_session", bo.jar.cookies.get("wgp_session"));
  await page.goto(`${paused.origin}/account`);
  await page.until(`location.origin === ${JSON.stringify(paused.origin)} && !document.getElementById("plan").hidden`, "the card, sales paused", 20000);
  const p = await card();
  const button = JSON.parse(await page.eval(`JSON.stringify((() => { const b = document.getElementById("btn-plan-monthly"); return { disabled: b.disabled, why: b.getAttribute("aria-description") }; })())`));
  t.ok("the card says the plan isn't on sale right now, the buy button can't be pressed and says why, and there's no yearly button",
    /The plan isn't on sale right now\.$/.test(p.state) && button.disabled && button.why === "The plan isn't on sale right now." && p.yearly === null && p.title === "More room",
    JSON.stringify({ ...p, button }));
  await still("5-paused");

  t.part("7c. A plan given by the site's operator, the site selling none");
  given = await startServer({
    name: "billing-browser-given", port: port + 2,
    vars: { PLAN_ENABLED: "", ASSISTANT_ENABLED: "", ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5" },
    secrets: { OPENROUTER_API_KEY: "sk-or-check-not-real" },
  });
  await given.start();
  const cy = new Person(given.origin, "Cy Moreau");
  if ((await cy.signUp()).status !== 200) throw new CheckError("couldn't make the host on the third server");
  await cy.post("/api/trips", { name: "Coast week", default_tz: "UTC" });
  given.sql(`INSERT INTO plan_grants (user_id, granted_at, reason) VALUES ('${cy.user.id}', unixepoch(), 'a made-up reason')`);
  await page.setCookie(given.origin, "wgp_session", cy.jar.cookies.get("wgp_session"));
  await page.goto(`${given.origin}/account`);
  // Waited for until its state line is the given plan's (a card read the moment it shows was red once in nine on 21 Nov);
  // if it never says so, the line below prints what it says instead.
  await page.until(`location.origin === ${JSON.stringify(given.origin)} && !document.getElementById("plan").hidden && /^It was given to you/.test(document.getElementById("plan-state")?.textContent ?? "")`, "the card, a given plan", 20000).catch(() => {});
  t.same("the card: on and given, the pool and the assistant, nothing charged and nothing to manage, no buttons", await card(), {
    title: "Your plan", lead: "50 GB across the trips you host, and the assistant on each of them, for everyone on it. The people on your trips share it.",
    use: "You use 0 MB of 50 GB.", state: "It was given to you: nothing is charged, and there's nothing to manage.", monthly: null, yearly: null, manage: false, msg: "" });
  t.same("  the assistant's month not shown (nothing used, far from its end), and the account's words name the assistant's conversations",
    [await shown("plan-ai"), await shown("plan-buy"), /conversations with the assistant/.test(await text("yours-words"))], [false, false, true]);
  await still("6-given");

  t.part("8. Nothing went wrong in the page");
  t.same("no page error", page.errors, []);
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await chrome?.close();
  await server?.stop();
  await paused?.stop();
  await given?.stop();
  await stripe?.close();
}
process.exit(code);

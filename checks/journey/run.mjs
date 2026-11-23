// The whole journey a new person makes, in real browsers, across the pages outside a trip and the
// app together: two made-up people, each in a browser of their own (Chrome for Testing, with a
// passkey device), against a real server.
//
//   node checks/journey/run.mjs [--port 8791] [--shots <folder>]
//
//    1. Ada signs up (a name and a passkey; no password) and lands on Your trips, empty.
//    2. She makes a trip with dates and its time zone, found by its city; the app opens on it.
//    3. She adds a plan by hand, on its first day.
//    4. She makes a join link.
//    5. Ben opens the link signed out, signs up from it, and joins.
//    6. A purchase split between them: Ada adds it, Ben's Split says what he owes; he marks it paid,
//       and Ada's Split says they're even.
//    7. A message in the chat about the plan, from its page's "Chat about this": Ben's open chat
//       shows it within seconds.
//    8. A photo in Memories: Ben sees it.
//    9. Ada hands the trip over: Ben accepts; then Ben deletes it by its name.
//
// A step the app can't do yet is named, as WAITING, with whose it is, and the journey goes on
// around it. It is a standing check: it fails when a step a new person needs stops working.
// With --shots, a still of every step at 390 and at 1440, numbered in order.
//
// Its server and browsers are its own. Everyone in it is made up.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckError, startServer } from "../lib/server.mjs";
import { Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";
import { makeAccount } from "../lib/signin-page.mjs";
import { DESKTOP, PHONE } from "../lib/look.mjs";
import { scene } from "../lib/images.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8791);
const shots = flag("--shots");
if (shots) fs.mkdirSync(shots, { recursive: true });
const t = new Report("a new person's whole journey");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-journey-"));
let server, chrome;
let code = 1;
let n = 0;

/** A still of where a person is, at a phone's width and a desk's, numbered in the journey's order. */
async function still(page, name) {
  n += 1;
  if (!shots) return;
  const stem = `${String(n).padStart(2, "0")}-${name}`;
  for (const size of [PHONE, DESKTOP]) {
    await page.size(size);
    await sleep(450);
    await page.shot(path.join(shots, `${stem}-${size.width}.png`));
  }
  await page.size(PHONE);
  await sleep(200);
}
const waiting = (what, whose) => t.ok(`WAITING (${whose}): ${what}. The journey goes on without it.`, true);
const where = (page) => page.eval("location.pathname + location.hash");

try {
  server = await startServer({ name: "journey", port });
  await server.start();
  const { origin } = server;
  const sql = (q) => server.sql(q);
  chrome = await openChrome();
  const ada = await chrome.page(PHONE);
  const ben = await chrome.page(PHONE);

  // ── 1. signing up ─────────────────────────────────────────────────────────────────────────
  t.part("1. Ada signs up");
  await ada.goto(`${origin}/trips`);
  await ada.until(`location.pathname === "/login" && !document.getElementById("p-signin")?.hidden`, "the sign-in page");
  t.same("Your trips, signed out, goes to the sign-in page, which will come back to it", await where(ada), "/login");
  await still(ada, "signin");
  // Making an account, as a person does it (checks/lib/signin-page.mjs): the passkey button, back without one here, a name.
  await makeAccount(ada, "Ada Journey");
  await ada.until(`location.pathname === "/trips" && document.getElementById("page") && !document.getElementById("page").hidden`, "Your trips", 20000);
  t.same("a name and a passkey make her account, signed in, and she's back on Your trips, which says she has none yet",
    [sql("SELECT name FROM users")[0]?.name, (await ada.passkeys()).length, await ada.eval(`!document.getElementById("none").hidden`)], ["Ada Journey", 1, true]);
  await still(ada, "trips-empty");

  // ── 2. making a trip ──────────────────────────────────────────────────────────────────────
  t.part("2. Ada makes a trip");
  await ada.type("#make-name", "Coast and the high pass");
  await ada.eval(`(() => { document.getElementById("make-from").value = "2027-06-01"; document.getElementById("make-to").value = "2027-06-12"; return true; })()`);
  await ada.click("#make-where");
  await ada.type("#make-where", "lima");
  await ada.until(`!!document.querySelector("#make-where-list .tr-zone-city")`, "the list of towns");
  await ada.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await ada.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await still(ada, "trip-form");
  await ada.click("#btn-make");
  await ada.until(`location.pathname.startsWith("/t/")`, "the trip in the app", 20000);
  const trip = sql("SELECT id, name, starts_on, ends_on, default_tz FROM trips")[0];
  t.same("the trip is made with its dates, and its zone and first area from the town typed into \"Where\"; the app opens on it",
    [trip.name, trip.starts_on, trip.ends_on, trip.default_tz, await ada.eval("location.pathname"), sql("SELECT id, name FROM areas")], ["Coast and the high pass", "2027-06-01", "2027-06-12", "America/Lima", `/t/${trip.id}/`, [{ id: "lima", name: "Lima" }]]);
  await ada.until(`!!document.querySelector("#view .empty button[data-plan-add]")`, "the empty agenda", 20000);
  await still(ada, "agenda-empty");

  // ── 3. a plan by hand ─────────────────────────────────────────────────────────────────────
  t.part("3. A plan, by hand");
  await ada.click("#view .empty button[data-plan-add]");
  await ada.until(`!!document.getElementById("pe-title")`, "the plan sheet");
  await sleep(700);
  await ada.type("#pe-title", "Dinner by the harbor");
  await ada.click(`.pe-day[data-day="2027-06-01"]`);
  await ada.eval(`(() => { const i = document.getElementById("pe-time"); i.value = "19:30"; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  await still(ada, "plan-sheet");
  // The sheet eases to its new height as the day and time fill it (sheet.js): press Add once it holds still, as a person
  // does (21 Nov: pressed 13 ms after the time, the click met Add's old place, y 274, while it rose to y 47).
  await ada.until(`new Promise((ok) => { const s = document.querySelector(".sh-root .sh-sheet"); if (!s) return ok(false); const a = Math.round(s.getBoundingClientRect().top);
    requestAnimationFrame(() => requestAnimationFrame(() => ok(Math.round(s.getBoundingClientRect().top) === a))); })`, "the plan sheet holding still", 5000);
  await ada.click('.sh-root [data-act="save"]');
  await ada.until(`document.body.innerText.includes("Dinner by the harbor") && !document.querySelector(".sh-root")`, "the plan on the agenda", 20000);
  const plan = await (async () => { for (let i = 0; i < 40; i++) { const r = sql(`SELECT id, title, starts_at, tz FROM events WHERE trip_id = '${trip.id}'`)[0]; if (r) return r; await sleep(250); } return null; })();
  t.same("the plan is on the agenda and on the server: its name, its day and time in the trip's zone",
    [plan?.title, plan?.tz, plan ? new Date(plan.starts_at * 1000).toISOString() : null], ["Dinner by the harbor", "America/Lima", "2027-06-02T00:30:00.000Z"]);
  await still(ada, "plan-added");

  // ── 4. a join link ────────────────────────────────────────────────────────────────────────
  t.part("4. Ada makes a join link");
  await ada.goto(`${origin}/trips/${trip.id}`);
  await ada.until(`!document.getElementById("page").hidden`, "the trip's people");
  await ada.eval(`(() => { const d = document.querySelector(".tr-linkset"); if (d) d.open = true; return 1; })()`);   // Make a link is under Link settings
  await ada.click("#btn-link");
  await ada.until(`!document.getElementById("made").hidden`, "the link");
  const link = await ada.eval(`document.getElementById("made-url").value`);
  t.ok("the trip's people page makes a link to send, shown whole", /\/join\/[A-Za-z0-9_-]{20,}$/.test(link), link);
  await still(ada, "join-link");

  // ── 5. Ben joins ──────────────────────────────────────────────────────────────────────────
  t.part("5. Ben opens the link, signs up from it, and joins");
  await ben.goto(link);
  await ben.until(`!document.getElementById("as-visitor")?.hidden`, "the join page, signed out");
  t.same("the link's page names the trip and who hosts it, and offers to join by name, or sign in",
    await ben.eval(`[document.getElementById("trip-name").textContent, document.getElementById("trip-host").textContent]`), ["Coast and the high pass", "Hosted by Ada Journey"]);
  await still(ben, "join-visitor");
  await ben.click("#go-signin");
  await ben.until(`location.pathname === "/login"`, "the sign-in page");
  await makeAccount(ben, "Ben Journey");
  await ben.until(`location.pathname.startsWith("/join/") && !document.getElementById("as-account")?.hidden`, "back on the link's page, signed in", 20000);
  await still(ben, "join-signed-in");
  await ben.click("#btn-join");
  await ben.until(`location.pathname === "/t/${trip.id}/"`, "the trip in the app", 20000);
  await ben.until(`document.body.innerText.includes("Dinner by the harbor")`, "Ada's plan on Ben's agenda", 20000);
  t.same("Ben is on the trip, and his app opens on it with Ada's plan",
    sql(`SELECT COUNT(*) AS n FROM trip_members WHERE trip_id = '${trip.id}' AND left_at IS NULL`)[0].n, 2);
  await still(ben, "joined");

  // ── 6. a purchase ─────────────────────────────────────────────────────────────────────────
  t.part("6. A purchase split between them");
  await ada.goto(`${origin}/t/${trip.id}/#/split`);
  await ada.until(`!!document.querySelector("#rt-fixed .fab")`, "Split");
  await ada.click("#rt-fixed .fab");
  await ada.until(`!!document.querySelector(".sp-amtin")`, "the purchase sheet");
  await sleep(700);   // the sheet has finished rising: a click lands where it's aimed
  t.same("the purchase sheet opens with Ada as the one who paid", await ada.eval(`document.querySelector('[role="radio"][aria-checked="true"]')?.textContent.trim()`), "AJYou");
  await ada.type(".sp-amtin", "48.00");
  await ada.type('[data-f="description"]', "Bus tickets");
  await still(ada, "purchase-sheet");
  await ada.click('[data-act="save"]');
  await ada.until(`document.body.innerText.includes("Bus tickets") && !document.querySelector(".sh-root")`, "the purchase in the feed", 20000);
  const pu = await (async () => { for (let i = 0; i < 40; i++) { const r = sql(`SELECT amount_minor FROM purchases WHERE trip_id = '${trip.id}'`)[0]; if (r) return r; await sleep(250); } return null; })();
  t.same("Ada adds it: 48.00, split between the two of them", [pu?.amount_minor, sql(`SELECT COUNT(*) AS n FROM purchase_shares s JOIN purchases p ON p.id = s.purchase_id WHERE p.trip_id = '${trip.id}'`)[0].n], [4800, 2]);
  await still(ada, "purchase-added");
  await ben.goto(`${origin}/t/${trip.id}/#/split`);
  await ben.until(`document.body.innerText.includes("Bus tickets")`, "the purchase on Ben's Split", 20000);
  const owes = await ben.eval(`[document.querySelector('[data-sp="headline-words"]')?.textContent, document.querySelector('[data-sp="headline-amount"]')?.textContent]`);
  t.ok("Ben's Split says what he owes, and to whom: \"You owe Ada Journey\", 24.00", owes[0] === "You owe Ada Journey" && /\b24\.00$/.test(owes[1] || ""), JSON.stringify(owes));
  await still(ben, "split-owes");
  // Ben pays Ada back: Settle up, "Mark paid" on his payment, the payment filled in, Mark paid.
  await ben.click('[data-act="settle"]');
  await ben.until(`!!document.querySelector('.sh-root .sp-tr-go[data-act="mark-paid"]')`, "Settle up with Ben's payment");
  await sleep(700);
  await ben.click('.sh-root .sp-tr-go[data-act="mark-paid"]');
  await ben.until(`(() => { const r = [...document.querySelectorAll(".sh-root")]; return r.length === 1 && r[0].querySelector(".sh-title")?.textContent.trim() === "Mark paid"; })()`, "the payment, filled in");
  await sleep(700);
  t.same("Mark paid opens the payment filled in: his half, from him, to her", await ben.eval(`[document.querySelector(".sp-amtin").value, [...document.querySelectorAll('[data-grp="paid"] [aria-checked="true"], [data-grp="to"] [aria-checked="true"]')].map((c) => c.textContent.trim())]`), ["24.00", ["BJYou", "AJAda Journey"]]);
  await still(ben, "payment-sheet");
  await ben.click('.sh-root [data-act="save"]');
  const paid = await (async () => { for (let i = 0; i < 40; i++) { const r = sql(`SELECT kind, amount_minor FROM purchases WHERE trip_id = '${trip.id}' AND kind = 'payment'`)[0]; if (r) return r; await sleep(250); } return null; })();
  t.same("Mark paid sends it: a payment of 24.00", paid, { kind: "payment", amount_minor: 2400 });
  await ada.goto(`${origin}/t/${trip.id}/#/split`);
  await ada.until(`/You're settled up/.test(document.querySelector(".sp-hero")?.innerText ?? "")`, "Ada's Split, settled", 20000);
  t.ok("Ada's Split says they're settled, and the bus tickets are still what was spent", /48\.00 spent together/.test(await ada.eval(`document.querySelector(".sp-hero").innerText`)), await ada.eval(`document.querySelector(".sp-hero").innerText`));
  await still(ada, "split-even");

  // ── 7. the chat ───────────────────────────────────────────────────────────────────────────
  t.part("7. A message about the plan");
  await ben.goto(`${origin}/t/${trip.id}/#/chat`);
  await ben.until(`!!document.querySelector(".ch-input")`, "Ben's chat");
  await ada.goto(`${origin}/t/${trip.id}/#/e/${encodeURIComponent(plan.id)}`);
  await ada.until(`document.body.innerText.includes("Dinner by the harbor")`, "the plan's page");
  await ada.until(`!!document.querySelector("[data-plan-chat]")`, "\"Chat about this\" on the plan's page");
  t.ok("the plan's page has \"Chat about this\"", /chat about this/i.test(await ada.eval(`(() => { const b = document.querySelector("[data-plan-chat]"); return b ? (b.getAttribute("aria-label") || b.textContent || "") : ""; })()`)));
  await ada.click("[data-plan-chat]");
  await ada.until(`!!document.querySelector(".ch-card-held")`, "the plan held above the box");
  await ada.type(".ch-input", "Shall we book a table?");
  await still(ada, "chat-about-plan");
  const sent = Date.now();
  await ada.eval(`document.querySelector(".ch-box").requestSubmit(), true`);
  await ben.until(`[...document.querySelectorAll(".ch-msg")].some((m) => /book a table/.test(m.textContent) && m.querySelector("a.ch-card"))`, "the message on Ben's chat", 10000);
  t.ok(`Ben's open chat shows Ada's message about the plan, as a card over her words (${Date.now() - sent} ms)`, Date.now() - sent < 8000);
  await still(ben, "chat-seen");

  // ── 8. a photo ────────────────────────────────────────────────────────────────────────────
  t.part("8. A photo in Memories");
  const photo = path.join(work, "harbor.png");
  fs.writeFileSync(photo, scene(1200, 800, 205));   // made, not photographed: a sky over a ridge
  await ada.goto(`${origin}/t/${trip.id}/#/memories`);
  await ada.until(`!!document.querySelector(".me-fab")`, "Memories");
  // Add photos opens the phone's own picker first (a real tap, which is what lets a page open it); the picker is answered
  // with the photo, and the one sheet opens holding it.
  await ada.send("DOM.enable");
  await ada.send("Page.setInterceptFileChooserDialog", { enabled: true });
  const chooser = new Promise((ok) => { const off = ada.on((m) => { if (m.method === "Page.fileChooserOpened") { off(); ok(m.params); } }); });
  await ada.click(".me-fab");
  const opened = await Promise.race([chooser, sleep(8000).then(() => null)]);
  t.ok("Add photos opens the phone's picker at once", !!opened);
  if (!opened) throw new CheckError("Add photos opened no picker");
  await ada.send("DOM.setFileInputFiles", { files: [photo], backendNodeId: opened.backendNodeId });
  await ada.send("Page.setInterceptFileChooserDialog", { enabled: false });
  await ada.until(`document.querySelectorAll(".me-pickrow").length === 1`, "the sheet, holding the photo picked");
  await ada.eval(`(() => { const i = document.getElementById("me-cap-in"); i.value = "The harbor at dusk"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await still(ada, "photo-composer");
  await ada.until(`!document.querySelector(".me-go").disabled`, "Upload ready");
  await ada.eval(`document.querySelector(".me-go").click(), true`);
  await ada.until(`document.querySelectorAll(".me-card").length === 1`, "the memory in the feed", 30000);
  await still(ada, "photo-posted");
  await ben.goto(`${origin}/t/${trip.id}/#/memories`);
  await ben.until(`document.querySelectorAll(".me-card").length === 1 && document.body.innerText.includes("The harbor at dusk")`, "the memory on Ben's feed", 20000);
  t.ok("Ada's photo is in Memories, and Ben sees it with its caption", true);
  await still(ben, "photo-seen");

  // ── 9. handing over, and deleting ─────────────────────────────────────────────────────────
  t.part("9. Ada hands the trip over; Ben deletes it");
  await ada.goto(`${origin}/trips/${trip.id}`);
  await ada.until(`!document.getElementById("page").hidden`, "the trip's people");
  const offer = `#people .ac-way:nth-child(2) .tr-row-acts button:first-child`;
  await ada.click(offer);
  await ada.until(`document.querySelector(${JSON.stringify(offer)}).classList.contains("lg-armed")`, "the offer to ask again");
  await ada.click(offer);
  await ada.until(`/Offered to Ben Journey/.test(document.getElementById("people").closest("section, main, body").innerText)`, "the offer made", 10000);
  await still(ada, "handover-offered");
  await ben.goto(`${origin}/trips`);
  await ben.until(`document.querySelectorAll("#offers .tr-offer").length === 1`, "the offer on Ben's list", 20000);
  await still(ben, "handover-offer");
  await ben.click("#offers .tr-offer .ds-button--white");
  await ben.until(`/You host/.test(document.body.innerText)`, "Ben hosting", 10000);
  t.same("Ada offers the trip to Ben, he accepts, and he hosts it", sql(`SELECT host_id FROM trips WHERE id = '${trip.id}'`)[0].host_id, sql("SELECT id FROM users WHERE name = 'Ben Journey'")[0].id);
  await still(ben, "handover-accepted");
  await ben.goto(`${origin}/trips/${trip.id}`);
  await ben.until(`!document.getElementById("page").hidden`, "the trip's people, as host");
  await ben.click("#btn-delete");
  await ben.until(`document.getElementById("delete-dialog").open`, "the delete dialog");
  await ben.eval(`(() => { const i = document.getElementById("dlg-name"); i.value = "Coast and the high pass"; i.dispatchEvent(new Event("input")); return true; })()`);
  await still(ben, "delete-by-name");
  await ben.click("#dlg-delete");
  await ben.until(`location.pathname === "/trips"`, "Your trips again", 20000);
  t.same("Ben deletes it by typing its name: it's gone for both of them", sql(`SELECT COUNT(*) AS n FROM trips WHERE id = '${trip.id}'`)[0].n, 0);
  await still(ben, "deleted");

  const errors = [ada, ben].flatMap((p) => p.errors).filter((e) => !/WebSocket connection to .* failed/.test(e));
  t.same("no errors on either person's pages, the whole way", errors, []);
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await chrome?.close();
  await server?.stop();
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(code);

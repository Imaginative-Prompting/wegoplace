#!/usr/bin/env node
/* "Chat about this" on a place and on a purchase (model §17): the chat with the thing held above
 * its box, as a plan's page has had it since the notes became messages.
 *
 *   node scripts/chat_about_check.mjs [--shots <folder>]
 *
 * On a server of its own, a made-up trip of three made-up people. It holds:
 *   1. A PLACE'S PAGE has "Chat about this" beside Change and lists what was said about it under
 *      "Said about this place", oldest first, by name ("Nothing said about it yet." before).
 *   2. Its button opens the chat with the place held above the box ("Place", its name); what is
 *      sent from there is a message about the place, and it shows last on the place's page.
 *   3. A PURCHASE'S DRAWER has "Chat about this" (its own row, not beside Delete); the chat holds it
 *      as "Purchase", what it was, the amount and who paid, and never the split (no share, no
 *      "owes", nobody else's name). Sent from there, it is a message about the purchase.
 *   4. A drawer with a change not saved yet says so and stays; a payment's drawer has no button.
 *   5. Both messages carry their cards in the chat; another person's message about the place reaches
 *      the open place page with no reload.
 *   6. A LINK TO THE CHAT ABOUT A THING (what an AI app hands the person): #/chat?about=place:<id>
 *      opens the chat holding the place, and the query is gone from the address; &part=before holds
 *      the time before a plan; a payment, an unknown kind or a thing not on the phone holds nothing;
 *      a link followed while the chat is open holds its thing. No page has an error.
 *
 * PLANTED (red when put in by hand):
 *   - chat.js's purchase card without who paid: section 3's "the amount and who paid" fails.
 *   - split.js chatRowHtml() answering "": section 3 finds no button.
 *   - split.js going to the chat with a change not saved: section 4 fails.
 */
import fs from "node:fs";
import path from "node:path";
import { CheckError, startServer } from "../checks/lib/server.mjs";
import { Person, Report } from "../checks/lib/person.mjs";
import { openChrome } from "../checks/lib/chrome.mjs";
import { freeLoopbackPort } from "./lib/browser.mjs";

// Send, and tapped again (up to three times, 5 s each) while the words are still in the box: on a loaded machine
// the box can move between where the tap was aimed and the press (15 Nov; check:chat-agenda the same).
const sendIt = async (page) => {
  for (let i = 0; i < 3; i++) {
    await page.click(".ch-send");
    if (await page.until(`document.getElementById("ch-input").value === ""`, "the box emptied by the send", 5000).then(() => true, () => false)) return;
  }
};

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const shots = flag("--shots");
if (shots) fs.mkdirSync(shots, { recursive: true });
const t = new Report("\"Chat about this\" on a place and on a purchase");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server, chrome, code = 1;
try {
  server = await startServer({ name: "chat-about", port: await freeLoopbackPort() });
  await server.start();
  const { origin } = server;
  const [ada, ben, cleo] = ["Ada Reyes", "Ben Okafor", "Cleo Tran"].map((n) => new Person(origin, n));
  for (const p of [ada, ben, cleo]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const made = await ada.post("/api/trips", { name: "Coast week", default_tz: "UTC", starts_on: day(-1), ends_on: day(5), currencies: ["EUR"] });
  if (made.status !== 201) throw new CheckError(`trip: ${made.status} ${made.text}`);
  const trip = made.json.trip.id;
  const T = `/api/trips/${trip}`;
  for (const p of [ben, cleo]) {
    const link = (await ada.post(`${T}/links`, { uses: 1 })).json.link;
    await p.post(`/api/join/${link.code}`);
  }
  const placed = await ada.call("PUT", `${T}/places`, { places: [{ id: "harbour-cafe", name: "The harbour café", kind: "food", subkind: "cafe", why: "Coffee by the boats." }] });
  if (placed.status >= 300) throw new CheckError(`place: ${placed.status} ${placed.text}`);
  // Logged by Ada, paid by Ben, split three ways: who owes what must never reach the chat.
  const bought = await ada.post(`${T}/purchases`, { id: "pu-fish", description: "Fish market lunch", amount_minor: 4200, currency: "EUR", amount_exp: 2, paid_by: ben.user.id,
    spent_at: Math.floor(Date.now() / 1000),
    shares: [ada, ben, cleo].map((p) => ({ user_id: p.user.id, weight: 1, share_minor: 1400 })) });
  if (bought.status >= 300) throw new CheckError(`purchase: ${bought.status} ${bought.text}`);
  const paid = await ada.post(`${T}/purchases`, { id: "pay-1", kind: "payment", description: "", amount_minor: 1400, currency: "EUR", amount_exp: 2, paid_by: ada.user.id,
    spent_at: Math.floor(Date.now() / 1000), shares: [{ user_id: ben.user.id, weight: 1, share_minor: 1400 }] });
  if (paid.status >= 300) throw new CheckError(`payment: ${paid.status} ${paid.text}`);
  const boat = await ada.post(`${T}/events`, { id: "boat", title: "Boat to the island", starts_at: Math.floor(Date.now() / 1000) + 86400, tz: "UTC" });
  if (boat.status >= 300) throw new CheckError(`event: ${boat.status} ${boat.text}`);
  const M = `${T}/messages`;

  chrome = await openChrome();
  const page = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
  await page.setCookie(origin, "wgp_session", ada.jar.cookies.get("wgp_session"));
  await page.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(ada.user.id), sameSite: "Lax" });
  const go = async (hash, ready, what) => { await page.open(`${origin}/t/${trip}/${hash}`); await page.until(ready, what, 20000); await sleep(600); };
  const shoot = async (name) => {
    if (!shots) return;
    for (const [w, h] of [[390, 844], [320, 640]]) for (const scheme of ["light", "dark"]) {
      await page.size({ width: w, height: h, mobile: true });
      await page.scheme(scheme);
      await sleep(400);
      let png = null;
      for (let tries = 0; tries < 4 && !(png?.length > 20000); tries++) {
        await page.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        png = Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64");
        if (png.length <= 20000) await sleep(500);
      }
      fs.writeFileSync(path.join(shots, `${name}-${w}-${scheme}.png`), png);
    }
    await page.size({ width: 390, height: 844, mobile: true });
    await page.scheme("light");
  };
  const serverAbout = async (body) => {
    for (let i = 0; i < 50; i++) {
      const row = server.sql(`SELECT about_kind, about_id FROM messages WHERE trip_id = '${trip}' AND body = '${body.replace(/'/g, "''")}'`)[0];
      if (row) return row;
      await sleep(200);
    }
    return null;
  };
  const SAID = `JSON.stringify({ head: document.querySelector(".pl-said .h2")?.textContent.trim() || null,
    rows: [...document.querySelectorAll(".pl-said .ch-said-row")].map((r) => [r.querySelector(".ch-said-who b").textContent, r.querySelector(".ch-said-body").textContent]),
    none: document.querySelector(".pl-said .pl-said-none")?.textContent || null })`;

  t.part("1. A place's page");
  await go("#/p/harbour-cafe", `!!document.querySelector('[data-act="chat"]') && !!document.querySelector(".pl-said-none, .pl-said .ch-said-row")`, "the place's page");
  let said = JSON.parse(await page.eval(SAID));
  const row = await page.eval(`[...document.querySelectorAll("#photo .ph-acts .btn")].map((b) => b.textContent.trim()).join("|")`);
  t.same("\"Chat about this\" beside Change; \"Said about this place\" says nothing was said yet", [row.startsWith("Change|Chat about this"), said.head, said.none], [true, "Said about this place", "Nothing said about it yet."]);
  await ben.post(M, { id: "m-place-1", body: "They close at three on Sundays", about: { kind: "place", id: "harbour-cafe" } });
  const came = await page.until(`document.querySelectorAll(".pl-said .ch-said-row").length === 1`, "Ben's message on the open page", 20000).then(() => true, () => false);
  said = JSON.parse(await page.eval(SAID));
  t.same("another person's message about the place reaches the open page, by name, with no reload", [came, said.rows], [true, [["Ben Okafor", "They close at three on Sundays"]]]);
  await shoot("1-place");

  t.part("2. Chat about the place");
  await page.click('[data-act="chat"]');
  await page.until(`location.hash.startsWith("#/chat") && !!document.querySelector(".ch-held .ch-card-kind")`, "the chat holding the place", 20000);
  await sleep(600);
  const heldPlace = JSON.parse(await page.eval(`JSON.stringify([document.querySelector(".ch-held .ch-card-kind").textContent.trim(), document.querySelector(".ch-held .ch-card-title").textContent.trim()])`));
  t.same("the chat holds the place above the box: \"Place\", its name", heldPlace, ["Place", "The harbour café"]);
  await shoot("2-chat-place");
  await page.type("#ch-input", "Meet there at ten");
  await sendIt(page);
  t.same("what is sent from there is a message about the place", await serverAbout("Meet there at ten"), { about_kind: "place", about_id: "harbour-cafe" });
  await go("#/p/harbour-cafe", `document.querySelectorAll(".pl-said .ch-said-row").length === 2`, "the place's page with both");
  said = JSON.parse(await page.eval(SAID));
  t.same("and it shows last on the place's page", said.rows.at(-1), ["You", "Meet there at ten"]);

  t.part("3. Chat about a purchase");
  await go("#/split/pu-fish", `!!document.querySelector('.sh-sheet [data-act="chat"]')`, "the purchase's drawer");
  const inFoot = await page.eval(`!!document.querySelector('.sp-foot [data-act="chat"]')`);
  t.ok("the drawer has \"Chat about this\" in its own row, not beside Delete", !inFoot);
  await shoot("3-purchase-drawer");
  await page.click('.sh-sheet [data-act="chat"]');
  await page.until(`location.hash.startsWith("#/chat") && !!document.querySelector(".ch-held .ch-card-kind")`, "the chat holding the purchase", 20000);
  await sleep(600);
  const heldBuy = JSON.parse(await page.eval(`JSON.stringify({ kind: document.querySelector(".ch-held .ch-card-kind").textContent.trim(), title: document.querySelector(".ch-held .ch-card-title").textContent.trim(),
    text: document.querySelector(".ch-held").innerText.replace(/\\s+/g, " ").trim() })`));
  t.same("the chat holds it as \"Purchase\", what it was", [heldBuy.kind, heldBuy.title], ["Purchase", "Fish market lunch"]);
  t.ok("with the amount and who paid", /€42\.00 · paid by Ben Okafor/.test(heldBuy.text), heldBuy.text);
  t.ok("and never the split: no share, no \"owes\", nobody else's name", !/14\.00|owe|each|split|Ada|Cleo/i.test(heldBuy.text), heldBuy.text);
  await shoot("4-chat-purchase");
  await page.type("#ch-input", "Was the tip in this?");
  await sendIt(page);
  t.same("sent from there, it is a message about the purchase", await serverAbout("Was the tip in this?"), { about_kind: "purchase", about_id: "pu-fish" });
  await page.until(`[...document.querySelectorAll(".ch-msg")].some((m) => /Was the tip in this\\?/.test(m.textContent) && /Fish market lunch/.test(m.textContent))`, "the message with its card", 15000);
  const cards = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll(".ch-msg .ch-card-kind")].map((k) => k.textContent.trim()))`));
  t.ok("both messages carry their cards in the chat", cards.includes("Place") && cards.includes("Purchase"), JSON.stringify(cards));

  t.part("4. A change not saved, and a payment");
  await go("#/split/pu-fish", `!!document.querySelector(".sp-amtin")`, "the drawer again");
  await page.eval(`(() => { const i = document.querySelector(".sp-amtin"); i.focus(); i.value = "43.00"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await sleep(300);
  await page.click('.sh-sheet [data-act="chat"]');
  await sleep(700);
  const stayed = JSON.parse(await page.eval(`JSON.stringify({ hash: location.hash, drawer: !!document.querySelector(".sh-sheet .sp-amtin"), toast: [...document.querySelectorAll(".toast, #toast, [role=status]")].map((n) => n.textContent.trim()).find((s) => /Save the change first/.test(s)) || null })`));
  t.same("with a change not saved, the drawer says so and stays", [stayed.hash.startsWith("#/chat"), stayed.drawer, stayed.toast], [false, true, "Save the change first, or close it."]);
  // The payment's own drawer, not the purchase's still closing (a hash change: the same document, and the purchase's sheet
  // leaves only after its transition): one sheet left, its amount the payment's 14 (the purchase's is 42).
  await go("#/split/pay-1", `document.querySelectorAll(".sh-sheet").length === 1 && /14/.test(document.querySelector(".sh-sheet .sp-amtin")?.value ?? "")`, "the payment's own drawer, the purchase's gone");
  t.ok("a payment's drawer has no \"Chat about this\"", !(await page.eval(`!!document.querySelector('.sh-sheet [data-act="chat"]')`)));

  t.part("6. A link to the chat about a thing");
  const heldNow = `JSON.stringify({ hash: location.hash, kind: document.querySelector(".ch-held .ch-card-kind")?.textContent.trim() || null, title: document.querySelector(".ch-held .ch-card-title")?.textContent.trim() || null })`;
  const viaLink = async (q) => {
    await page.open(`${origin}/t/${trip}/#/chat?${q}`);
    await page.until(`!!document.querySelector(".ch-box")`, "the chat", 20000);
    await sleep(800);
    return JSON.parse(await page.eval(heldNow));
  };
  let h = await viaLink("about=place:harbour-cafe");
  t.same("#/chat?about=place:<id> opens the chat holding the place, and the query is gone from the address", [h.kind, h.title, h.hash], ["Place", "The harbour café", "#/chat"]);
  h = await viaLink("about=event:boat&part=before");
  t.same("&part=before holds the time before the plan", [h.kind, h.title], ["Free time", "Before Boat to the island"]);
  const none = [];
  for (const q of ["about=purchase:pay-1", "about=thing:harbour-cafe", "about=place:not-on-this-trip"]) none.push((await viaLink(q)).kind);
  t.same("a payment, a kind the chat doesn't know and a thing not on the phone hold nothing", none, [null, null, null]);
  await page.eval(`(location.hash = "#/chat?about=purchase:pu-fish", 1)`);
  await page.until(`!!document.querySelector(".ch-held .ch-card-kind")`, "the purchase held in the open chat", 15000).catch(() => {});
  h = JSON.parse(await page.eval(heldNow));
  t.same("a link followed while the chat is open holds its thing", [h.kind, h.title, h.hash], ["Purchase", "Fish market lunch", "#/chat"]);

  t.ok("no page has an error", page.errors.length === 0, JSON.stringify(page.errors.slice(0, 3)));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await chrome?.close();
  await server?.stop();
}
process.exit(code);

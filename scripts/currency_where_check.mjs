#!/usr/bin/env node
/* The money of where the trip goes (public/js/trips.js guessFromWhere, trip-people.js offerCurrencyOf),
 * in a real browser on a server of its own, as a phone in the United States:
 *
 *   1. Make a trip: the phone's guess first (US dollar, "A guess from your phone's region"); a town
 *      picked in Where makes its country's money the guess instead, saying so (Porto: euro, Portugal;
 *      Kyoto: yen, Japan); let go of the town and the phone's guess is back; the trip is made with the
 *      town's.
 *   2. A currency the person chose is left alone: one added by hand, then a town picked, and the
 *      currencies are as they were.
 *   3. An account with its own home currency: the town's leads, as the guess, and the home one stays;
 *      a town whose money is the account's own changes nothing (its main stays main).
 *   4. The trip's page, Where it goes: a second city in another country offers its money, in words with
 *      one button, and adds nothing by itself; the button adds it after the trip's own; a city in a
 *      country whose money the trip has offers nothing.
 *
 *   node scripts/gate.mjs --only currency_where_check
 *
 * Made-up people. A stranger's walk found it (16 Nov): a trip to Porto made on a US phone got the dollar.
 *
 * PLANTED (red when put in by hand): guessFromWhere() returning at once (1 and 3 fail); offerCurrencyOf()
 * returning at once (4 fails).
 */
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { openChrome } from "../checks/lib/chrome.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import fs from "node:fs";
import path from "node:path";

// WGP_SHOTS=<folder>: stills of the form and the offer, light and dark (made-up people).
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
async function stills(page, name, sel) {
  if (!SHOTS) return;
  for (const scheme of ["light", "dark"]) {
    await page.scheme(scheme);
    await page.eval(`(document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: "center" }), 1)`);
    await new Promise((r) => setTimeout(r, 400));
    const { data } = await page.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, `390-${scheme}-${name}.png`), Buffer.from(data, "base64"));
  }
  await page.scheme("light");
}

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await startServer({ name: "currency-where", port: await freeLoopbackPort() });
ownServer(server.origin);
let chrome = null;
try {
  await server.start();
  const { origin } = server;
  chrome = await openChrome();
  const asPhone = async (who) => {
    const p = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
    await p.send("Emulation.setLocaleOverride", { locale: "en-US" });
    await p.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
    await p.setCookie(origin, "wgp_session", who.jar.cookies.get("wgp_session"));
    await p.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(who.user.id), sameSite: "Lax" });
    return p;
  };
  // The currencies as the form shows them: each chip's code and its mark, and the sentence under them.
  const chips = (p, box) => p.eval(`JSON.stringify({ chips: [...document.querySelectorAll("#${box} .tr-cur")].map((c) => c.querySelector(".tr-cur-code").textContent + (c.dataset.guess !== undefined ? " guess" : (c.querySelector(".tr-cur-main")?.textContent === "main" ? " main" : ""))), why: (document.querySelector("#${box} .tr-cur-why") || {}).textContent || "" })`).then(JSON.parse);
  const pickTown = async (p, field, list, words) => {
    await p.eval(`(() => { const i = document.getElementById(${JSON.stringify(field)}); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
    await p.type(`#${field}`, words);
    await p.until(`!!document.querySelector("#${list} .tr-zone-city")`, `the towns for "${words}"`);
    await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await sleep(400);
  };

  section("1. Make a trip, on a US phone");
  const ada = new Person(origin, "Ada Reyes");
  await ada.signUp();
  const p = await asPhone(ada);
  await p.goto(`${origin}/trips`);
  await p.until(`!document.getElementById("page").hidden && document.querySelector("#make-curs .tr-cur") ? 1 : 0`, "Your trips with its guess");
  const phone = await chips(p, "make-curs");
  check("the phone's guess: the US dollar, said to be one", JSON.stringify(phone.chips) === '["USD guess"]' && /phone's region \(United States\)/.test(phone.why), JSON.stringify(phone));
  await pickTown(p, "make-where", "make-where-list", "porto");
  const porto = await chips(p, "make-curs");
  await stills(p, "make-trip-porto", "#make-curs");
  check("Porto picked: the euro is the guess instead, from where the trip goes", JSON.stringify(porto.chips) === '["EUR guess"]' && porto.why === "A guess from where the trip goes (Portugal). Take it off if it's wrong.", JSON.stringify(porto));
  await pickTown(p, "make-where", "make-where-list", "kyoto");
  const kyoto = await chips(p, "make-curs");
  check("Kyoto picked instead: the yen, from Japan", JSON.stringify(kyoto.chips) === '["JPY guess"]' && /\(Japan\)/.test(kyoto.why), JSON.stringify(kyoto));
  await p.eval(`(() => { const i = document.getElementById("make-where"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await sleep(300);
  const back = await chips(p, "make-curs");
  check("the town let go: the phone's guess is back", JSON.stringify(back.chips) === '["USD guess"]' && /phone's region/.test(back.why), JSON.stringify(back));
  await pickTown(p, "make-where", "make-where-list", "porto");
  await p.type("#make-name", "Porto long weekend");
  await p.eval(`(() => { document.getElementById("make-from").value = "2027-05-01"; document.getElementById("make-to").value = "2027-05-04"; return 1; })()`);
  await p.click("#btn-make");
  await p.until(`location.pathname.startsWith("/t/")`, "the trip", 20000);
  const tripId = (await p.eval("location.pathname")).split("/")[2];
  const made = (await ada.get(`/api/trips/${tripId}`)).json.trip;
  check("the trip is made with the town's money", JSON.stringify(made.currencies) === '["EUR"]', JSON.stringify(made.currencies));

  section("2. A currency the person chose is left alone");
  await p.goto(`${origin}/trips`);
  await p.until(`document.querySelector("#make-curs .tr-cur") ? 1 : 0`, "the form again");
  // With a trip on the list the form waits behind "Make a trip".
  await p.click("#make-open");
  await p.until(`!document.getElementById("form-make").hidden ? 1 : 0`, "the form, opened");
  await p.eval(`(() => { const s = document.getElementById("make-cur"); s.value = "GBP"; s.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`);
  await sleep(200);
  const chosen = await chips(p, "make-curs");
  await pickTown(p, "make-where", "make-where-list", "porto");
  const after = await chips(p, "make-curs");
  check("a currency added by hand, then a town: the currencies stay as they were", JSON.stringify(after.chips) === JSON.stringify(chosen.chips) && chosen.chips.includes("GBP"), `${JSON.stringify(chosen.chips)} → ${JSON.stringify(after.chips)}`);
  await p.close();

  section("3. An account with its own home currency");
  const ben = new Person(origin, "Ben Okafor");
  await ben.signUp();
  server.sql(`UPDATE users SET native_currency = 'USD' WHERE id = '${ben.user.id}'`);
  const b = await asPhone(ben);
  await b.goto(`${origin}/trips`);
  await b.until(`document.querySelector("#make-curs .tr-cur") ? 1 : 0`, "Ben's form");
  const home = await chips(b, "make-curs");
  await pickTown(b, "make-where", "make-where-list", "kyoto");
  const withHome = await chips(b, "make-curs");
  await stills(b, "make-trip-home-and-kyoto", "#make-curs");
  check("his home currency first; Kyoto picked: the yen leads, as the guess, and his dollar stays", JSON.stringify(home.chips) === '["USD main"]' && JSON.stringify(withHome.chips) === '["JPY guess","USD"]', `${JSON.stringify(home.chips)} → ${JSON.stringify(withHome)}`);
  await b.close();
  // The town's money is the account's own already: nothing changes, and its main stays main.
  const cleo = new Person(origin, "Cleo Tran");
  await cleo.signUp();
  server.sql(`UPDATE users SET native_currency = 'EUR' WHERE id = '${cleo.user.id}'`);
  const c = await asPhone(cleo);
  await c.goto(`${origin}/trips`);
  await c.until(`document.querySelector("#make-curs .tr-cur") ? 1 : 0`, "Cleo's form");
  await pickTown(c, "make-where", "make-where-list", "lisbon");
  const own = await chips(c, "make-curs");
  check("a euro account going to Lisbon: its euro stays main, nothing guessed", JSON.stringify(own.chips) === '["EUR main"]' && own.why === "", JSON.stringify(own));
  await c.close();

  section("4. The trip's page: a second city in another country");
  const q = await asPhone(ada);
  await q.goto(`${origin}/trips/${tripId}`);
  await q.until(`!document.getElementById("page").hidden`, "the trip's page");
  await pickTown(q, "area-where", "area-where-list", "lisbon");
  await q.until(`!document.getElementById("btn-area").disabled`, "Lisbon picked");
  await q.click("#btn-area");
  await q.until(`[...document.querySelectorAll("#areas .ac-way-label")].some((n) => n.textContent === "Lisbon")`, "Lisbon added", 15000);
  await sleep(300);
  check("a city in the trip's own money's country (Lisbon): nothing offered", (await q.eval(`document.getElementById("cur-offer").hidden`)) === true);
  await pickTown(q, "area-where", "area-where-list", "kyoto");
  await q.until(`!document.getElementById("btn-area").disabled`, "Kyoto picked");
  await q.click("#btn-area");
  await q.until(`!document.getElementById("cur-offer").hidden`, "the offer", 15000);
  const offer = await q.eval(`JSON.stringify({ words: document.querySelector("#cur-offer .meta").textContent, btn: document.querySelector("#cur-offer button").textContent })`).then(JSON.parse);
  await stills(q, "trip-page-kyoto-offer", "#cur-offer");
  const still = (await ada.get(`/api/trips/${tripId}`)).json.trip.currencies;
  check("Kyoto: its money offered in words with one button, and nothing added by itself", offer.words === "Kyoto is in Japan, where people pay in Japanese Yen. It isn't one of the trip's currencies yet." && offer.btn === "Add Japanese Yen" && JSON.stringify(still) === '["EUR"]', `${JSON.stringify(offer)} | ${JSON.stringify(still)}`);
  await q.click("#cur-offer button");
  await q.until(`document.getElementById("cur-offer").hidden`, "the offer gone", 15000);
  const now = (await ada.get(`/api/trips/${tripId}`)).json.trip.currencies;
  check("pressed: the yen is the trip's, after the euro", JSON.stringify(now) === '["EUR","JPY"]', JSON.stringify(now));
  await q.close();
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  await chrome?.close().catch(() => {});
  await server.stop().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

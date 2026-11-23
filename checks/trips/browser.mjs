// The pages outside a trip, in a browser, with two people: Your trips (/trips) and a trip's
// people and settings (/trips/<id>), as public/trips.html, js/trips.js, public/trip-people.html
// and js/trip-people.js draw them. Each person has a browser of their own (checks/lib/chrome.mjs)
// signed in with their own session; what one does, the other's page shows the next time it
// asks, and what the other's page then tries is answered as things are now, in words.
//
// It also holds the app's address for a trip (/t/<id>/ is the app's own document, /t/<id> goes
// to the slash form) and what the list kept on the phone does: drawn with no signal, gone when
// the person signs out, never drawn for someone else.
//
//   node checks/trips/browser.mjs [--port 8791] [--keep] [--shots <folder>]
//
// Its server and browser are its own (startServer, openChrome); it runs through the channel's
// queue like every browser check. Everyone in it is made up.

import fs from "node:fs";
import path from "node:path";
import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";
import { DESKTOP, NARROW, PHONE, SIZES, TABLET, looks } from "../lib/look.mjs";
import { formatBytes } from "../../public/js/shared/bytes.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8791);
const shots = flag("--shots");
const keep = argv.includes("--keep");
if (shots) fs.mkdirSync(shots, { recursive: true });

const t = new Report("the pages outside a trip");
const { layouts: measure, readable } = looks({ t, shots });

// What these pages hold at every size besides the kit's measurements: each row's icon (or a
// person's initials) stays in its own column, left of the row's first line of words, never on
// a line of its own; and a trip's name and its dates read as one thing (the wordmark is never
// between them).
const OWN = `(() => {
  const bad = [];
  for (const row of document.querySelectorAll(".ac-way")) {
    if (row.closest("[hidden]") || !row.getBoundingClientRect().height) continue;
    const icon = row.firstElementChild, main = row.querySelector(".ac-way-main");
    if (!icon || !main || icon === main) continue;
    const a = icon.getBoundingClientRect(), b = main.getBoundingClientRect();
    const firstLine = b.top + Math.min(b.height, 30);
    if (!(a.right <= b.left + 0.5 && a.top < firstLine && a.bottom > b.top)) bad.push("the icon of " + JSON.stringify(main.textContent.trim().slice(0, 28)) + " isn't beside its first line");
  }
  const n = document.getElementById("trip-name"), m = document.getElementById("trip-meta"), w = document.getElementById("brand");
  if (n && m && w && !m.hidden) {
    const N = n.getBoundingClientRect(), M = m.getBoundingClientRect(), W = w.getBoundingClientRect();
    if (W.height && W.top >= N.bottom - 1 && W.bottom <= M.top + 1) bad.push("the wordmark sits between the trip's name and its dates");
  }
  return bad;
})()`;
/** The kit's measurements and these pages' own, at 320 as well as 390, 820 and 1440. */
const layouts = (page, what, file) => measure(page, what, file, { sizes: [NARROW, ...SIZES], extra: OWN });
const everyPage = [];
let server, chrome;
let code = 1;

/** Signs a browser in as `person`: the session cookie and the page's note of who it is. */
async function signInto(page, person) {
  await page.setCookie(server.origin, "wgp_session", person.jar.cookies.get("wgp_session"));
  await page.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: encodeURIComponent(person.user.id), sameSite: "Lax" });
}
const said = (page, id) => page.eval(`(() => { const b = document.getElementById(${JSON.stringify(id)}); return b && !b.hidden ? b.querySelector("span").textContent : null; })()`);
async function says(page, id, words, within = 15000) {
  const end = Date.now() + within;
  for (;;) {
    const got = await said(page, id).catch(() => null);
    if (got && words.test(got)) return got;
    if (Date.now() > end) return got ?? "(nothing was said)";
    await new Promise((r) => setTimeout(r, 60));
  }
}
const shown = (page, id) => page.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return !!e && !e.closest("[hidden]"); })()`);
const loaded = (page) => page.until(`!document.getElementById("page").hidden || !document.getElementById("failed").hidden`, "the page to load");
const asking = (page, selector) => page.eval(`document.querySelector(${JSON.stringify(selector)}).classList.contains("lg-armed")`);
/** The second press of a button that asks twice (its first press may count what's waiting first). */
async function pressTwice(page, selector) {
  await page.click(selector);
  await page.until(`document.querySelector(${JSON.stringify(selector)}).classList.contains("lg-armed")`, `${selector} to ask`);
  await page.click(selector);
}
const KEPT = `(() => { try { return JSON.parse(localStorage.getItem("wgp.trips") || "null"); } catch { return "unreadable"; } })()`;

try {
  server = await startServer({ name: "trips-browser", port, keep });
  await server.start();
  const { origin } = server;
  chrome = await openChrome();
  const open = async (o) => { const page = await chrome.page(o); everyPage.push(page); return page; };

  const mira = new Person(origin, "Mira Check");
  const ned = new Person(origin, "Ned Check");
  for (const p of [mira, ned]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}'s account`);

  // ── Your trips, empty, and making one ───────────────────────────────────────────────────
  t.part("A new account's currency: a guess from the phone");
  // Mira's account has no home currency yet. Three phones: Dutch with no region in its language
  // and its clock in Amsterdam (the guess comes from the zone), English set to the United Kingdom
  // (from the language), and French on UTC (no guess at all).
  const guessed = [];
  for (const [locale, zone] of [["nl", "Europe/Amsterdam"], ["en-GB", "Asia/Tokyo"], ["fr", "UTC"]]) {
    const p = await open(PHONE);
    // A phone's language reaches a page twice, and on a phone the two agree: in the browser's
    // languages (navigator.languages, what the guess reads) and in Intl's own default.
    await p.send("Network.setUserAgentOverride", { userAgent: await p.eval("navigator.userAgent"), acceptLanguage: locale });
    await p.send("Emulation.setLocaleOverride", { locale });
    await p.send("Emulation.setTimezoneOverride", { timezoneId: zone });
    await signInto(p, mira);
    await p.goto(`${origin}/trips`);
    await loaded(p);
    guessed.push(await p.eval(`[navigator.language, [...document.querySelectorAll("#make-curs .tr-cur")].map((c) => c.textContent + (c.hasAttribute("data-guess") ? " (dashed)" : "")), document.querySelector("#make-curs .tr-cur-why")?.textContent ?? ""]`));
    // The form shows no currency field (25 Nov): the guess is what the one quiet line says and what is sent.
    guessed.at(-1).push(await p.eval(`document.getElementById("make-zone-said").textContent`));
    if (locale === "nl") await layouts(p, "Your trips, a guessed currency", "trips-guess");
  }
  t.same("a Dutch phone in Amsterdam is given the euro, guessed from its time zone, and the line says so",
    [guessed[0].slice(0, 3), / in Euro\. Change them in the trip's details\.$/.test(guessed[0][3])],
    [["nl", ["EUREuroguess (dashed)"], "A guess from your phone's time zone (Netherlands). Take it off if it's wrong."], true]);
  t.same("an English phone set to the United Kingdom is given the pound, from its region, whatever its clock says",
    [guessed[1].slice(0, 3), / in British Pound\. Change them in the trip's details\.$/.test(guessed[1][3])],
    [["en-GB", ["GBPBritish Poundguess (dashed)"], "A guess from your phone's region (United Kingdom). Take it off if it's wrong."], true]);
  t.same("a French phone on UTC names no country: no guess, no currency, and the line names none", [guessed[2].slice(0, 3), /, in /.test(guessed[2][3])], [["fr", [], ""], false]);

  t.part("Your trips, before there are any");
  const phone = await open(PHONE);
  t.same("(the person's home currency is the euro)", (await mira.call("PATCH", "/api/me", { native_currency: "EUR" })).status, 200);
  await signInto(phone, mira);
  await phone.goto(`${origin}/trips`);
  await loaded(phone);
  t.same("signed in with no trip: the page says so, and that a friend's link is the other way in; the form to make one is there",
    [await shown(phone, "none"), await phone.eval(`document.getElementById("none").textContent.includes("link a friend sent you")`), await shown(phone, "form-make"), await shown(phone, "storage")],
    [true, true, true, false]);
  const phoneZone = await phone.eval("Intl.DateTimeFormat().resolvedOptions().timeZone");
  // The zone is said in a line under "Where", by its city and its offset; the zone database's region word shows nowhere.
  const cityOf = (z) => z.split("/").at(-1).replace(/_/g, " ");
  const zoneLine = await phone.eval(`document.getElementById("make-zone-said").textContent`);
  t.ok(`the time zone starts as the phone's own, with the person's home currency, said in one quiet line under "Where": ${zoneLine}`,
    zoneLine.startsWith(`On ${cityOf(phoneZone)}`) && zoneLine.endsWith("(your phone's), in Euro. Change them in the trip's details.") && !/ · (Europe|America|Asia|Africa|Pacific|Australia|Atlantic|Indian)\b/.test(zoneLine));
  t.same("the form has no time zone or currency field of its own to fill in (they are the trip's details)", await phone.eval(`[document.getElementById("make-zone-field").hidden, document.getElementById("make-cur").closest(".field").hidden, !!document.getElementById("make-zone-change")]`), [true, true, false]);
  t.same("the currencies it sends start with the person's home currency, marked main", await phone.eval(`[...document.querySelectorAll("#make-curs .tr-cur")].map((c) => c.textContent)`), ["EUREuromain"]);
  await layouts(phone, "Your trips, with none", "trips-none");
  await readable(phone, "Your trips");

  t.part("Making a trip");
  await phone.click("#btn-make");
  t.same("with no name it says so, and makes nothing", [await says(phone, "msg-make", /name/), server.sql("SELECT COUNT(*) AS n FROM trips")[0].n], ["Give the trip a name.", 0]);
  await phone.type("#make-name", "  Lisbon   in April ");
  await phone.eval(`(() => { document.getElementById("make-from").value = "2031-04-02"; return true; })()`);
  await phone.click("#btn-make");
  t.same("one date without the other is refused in words", await says(phone, "msg-make", /both/), "Give both dates, or neither if they aren't known yet.");
  // Where the trip is, found by typing its town: that one answer is the trip's zone and its first area.
  await phone.click("#make-where");
  await phone.type("#make-where", "lis");
  await phone.until(`!!document.querySelector("#make-where-list .tr-zone-city")`, "the list of towns");
  t.same("typing \"lis\" finds Lisbon first, named with its country and its offset on the trip's first day (GMT+1 in April), the first one marked",
    await phone.eval(`(() => { const o = document.querySelector("#make-where-list .tr-zone-opt"); return [o.querySelector(".tr-zone-city").textContent, o.querySelector(".tr-zone-where").textContent, o.getAttribute("aria-selected"), document.getElementById("make-where").getAttribute("aria-expanded")]; })()`),
    ["Lisbon, Portugal", "GMT+1", "true", "true"]);
  t.ok("the list opens under the field, so what is typed stays in sight",
    await phone.eval(`document.getElementById("make-where-list").getBoundingClientRect().top >= document.getElementById("make-where").getBoundingClientRect().bottom - 0.5`));
  if (shots) await phone.shot(path.join(shots, "trips-zone-open-390-light.png"));
  await phone.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await phone.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  t.same("Enter chooses it: the field names it, the list closes, and the line under it says the trip's zone",
    await phone.eval(`[document.getElementById("make-where").value, document.getElementById("make-where-list").hidden, document.getElementById("make-zone-said").textContent]`),
    ["Lisbon, Portugal · GMT+1", true, "On Lisbon time, GMT+1, in Euro. Change them in the trip's details."]);
  t.ok("and what the town means for the map is said under the field",
    /^The trip's map is made around Lisbon, \d+ km across\./.test(await phone.eval(`document.getElementById("make-where-said").textContent`)));
  await phone.eval(`(() => {
    document.getElementById("make-to").value = "2031-04-09";
    const cur = document.getElementById("make-cur");
    for (const c of ["EUR", "GBP"]) { cur.value = c; cur.dispatchEvent(new Event("change")); }   // EUR again changes nothing
    return true;
  })()`);
  t.same("the currencies it sends are in order, the first marked main", await phone.eval(`[...document.querySelectorAll("#make-curs .tr-cur")].map((c) => c.textContent)`), [
    "EUREuromain", "GBPBritish Pound"]);
  await layouts(phone, "making a trip, filled in", "trips-make");
  await phone.click("#btn-make");
  await phone.until(`location.pathname.startsWith("/t/")`, "the new trip to open in the app");
  const lisbon = server.sql("SELECT id, name, starts_on, ends_on, default_tz, currencies, host_id FROM trips")[0];
  t.same("the trip is made as filled in, its name tidied, hosted by its maker", { ...lisbon, id: undefined },
    { id: undefined, name: "Lisbon in April", starts_on: "2031-04-02", ends_on: "2031-04-09", default_tz: "Europe/Lisbon", currencies: '["EUR","GBP"]', host_id: mira.user.id });
  const made = server.sql("SELECT id, name, parent, west, south, east, north FROM areas");
  t.ok(`and with its first area, the town that was picked, a box that holds the middle of Lisbon: what the trip's map is made around (${JSON.stringify(made)})`,
    made.length === 1 && made[0].id === "lisbon" && made[0].name === "Lisbon" && made[0].parent === null
      && made[0].west < -9.14 && made[0].east > -9.14 && made[0].south < 38.72 && made[0].north > 38.72);
  t.same("and the page goes to the trip in the app, at its own address", await phone.where(), `/t/${lisbon.id}/`);
  t.ok("WAITING (trips in the client, wgp-client): that the app at /t/<id>/ opens this trip. Until it lands, /t/<id>/ is the app's document and nothing more.", true);
  const T = `/api/trips/${lisbon.id}`;

  t.part("The app's address for a trip");
  // Asked as the person who made it (a page address under the Worker needs a session; signed
  // out it goes to sign in, and back).
  const home = await mira.get("/", { page: true });
  const at = await mira.get(`/t/${lisbon.id}/`, { page: true });
  const header = (r, name) => r.headers.find(([k]) => k === name)?.[1] ?? null;
  const keepHeaders = (r) => ["content-type", "cache-control", "x-content-type-options", "referrer-policy"].map((h) => header(r, h));
  t.same("/t/<id>/ answers the app's document: the same bytes and headers as /", [at.status, at.text === home.text && home.text.length > 500, keepHeaders(at)], [200, true, keepHeaders(home)]);
  const bare = await mira.get(`/t/${lisbon.id}?from=list`, { page: true });
  t.same("/t/<id> goes to the slash form, keeping what follows the ?", [bare.status, bare.location], [308, `/t/${lisbon.id}/?from=list`]);
  const out = await new Person(origin, "x").get(`/t/${lisbon.id}/`, { page: true });
  t.same("signed out, it goes to sign in, and back to the trip after", [out.status, out.location], [302, `${origin}/login?next=${encodeURIComponent(`/t/${lisbon.id}/`)}`]);

  // ── the list, as a host ─────────────────────────────────────────────────────────────────
  t.part("Your trips, as the host of one");
  await phone.goto(`${origin}/trips`);
  await loaded(phone);
  t.same("the trip is listed: its name opens it in the app, with its dates, that you host it, and how many are on it",
    await phone.eval(`[...document.querySelectorAll("#list .tr-trip")].map((r) => [r.querySelector(".tr-trip-name").textContent, r.querySelector(".tr-trip-name").getAttribute("href"), !!r.querySelector(".pill svg") && r.querySelector(".pill").textContent, r.querySelector(".meta").textContent.includes("only you on it"), r.querySelector("a.tr-row-btn").getAttribute("href")])`),
    [["Lisbon in April", `/t/${lisbon.id}/`, "You host it", true, `/trips/${lisbon.id}`]]);
  t.same("a host sees their storage: the numbers in words, then the bar", [await shown(phone, "storage"), await phone.eval(`document.querySelector("#meter .tr-meter-words").textContent`)], [true, "0 MB of 1 GB used"]);
  t.ok("no price anywhere on it", !/price|pay|plan|upgrade|\$|€|£/i.test(await phone.eval(`document.getElementById("storage").textContent`)));
  await layouts(phone, "Your trips, as a host", "trips-host");

  // ── a trip's people, and a link ─────────────────────────────────────────────────────────
  t.part("A trip's people and settings, as its host");
  await phone.goto(`${origin}/trips/${lisbon.id}`);
  await loaded(phone);
  t.same("the page names the trip and lists who is on it; it has no way to the trip of its own (the one Back is the way back)",
    [await phone.eval(`document.getElementById("trip-name").textContent`), await phone.eval(`document.getElementById("open-trip") ? document.getElementById("open-trip").getAttribute("href") : null`),
      await phone.eval(`[...document.querySelectorAll("#people .ac-way-label")].map((n) => n.textContent)`)],
    ["Lisbon in April", null, ["Mira Check"]]);
  t.same("the host can't leave, and is told the two ways out; the host can delete it", [await phone.eval(`document.getElementById("leave-words").textContent.startsWith("You host this trip")`), await shown(phone, "delete-card")], [true, true]);
  await phone.eval(`(() => { document.getElementById("link-days").value = "3"; document.getElementById("link-uses").value = "2"; return true; })()`);
  await phone.eval(`(() => { const d = document.querySelector(".tr-linkset"); if (d) d.open = true; return 1; })()`);   // Make a link is under Link settings
  await phone.click("#btn-link");
  await phone.until(`!document.getElementById("made").hidden`, "the new link");
  const url = await phone.eval(`document.getElementById("made-url").value`);
  const linkRow = server.sql(`SELECT max_uses, expires_at - created_at AS life FROM trip_links WHERE trip_id = '${lisbon.id}'`)[0];
  t.ok("a link is made as chosen (3 days, 2 people) and shown once, whole, to copy", /^http:\/\/localhost:\d+\/join\/[A-Za-z0-9_-]{20,}$/.test(url) && linkRow.max_uses === 2 && linkRow.life === 3 * 86400, { url, linkRow });
  t.same("and listed, with who made it and how long it works", await phone.eval(`[...document.querySelectorAll("#links .ac-way")].map((r) => r.querySelector(".meta").textContent.includes("0 of 2 people"))`), [true]);
  await layouts(phone, "a trip's people, as its host, with a link just made", "people-host");
  await readable(phone, "a trip's people");

  t.part("Joining by that link, and the other person's pages");
  const joined = await ned.post(`/api/join/${url.split("/").pop()}`);
  t.same("(the other person joins by it)", [joined.status, joined.json?.joined], [200, true]);
  const tablet = await open(TABLET);
  await signInto(tablet, ned);
  await tablet.goto(`${origin}/trips`);
  await loaded(tablet);
  t.same("their list shows the trip, hosted by the one who made it, and no storage block (they host nothing)",
    [await tablet.eval(`[...document.querySelectorAll("#list .meta")].map((m) => m.textContent.endsWith("hosted by Mira Check"))`), await shown(tablet, "storage")], [[true], false]);
  await tablet.goto(`${origin}/trips/${lisbon.id}`);
  await loaded(tablet);
  t.same("a member sees everyone, with no buttons to remove or hand over; Leave is theirs; deleting isn't",
    [await tablet.eval(`[...document.querySelectorAll("#people .ac-way-label")].map((n) => n.textContent)`), await tablet.eval(`document.querySelectorAll("#people button").length`),
      await tablet.eval(`!!document.querySelector("#leave-actions button")`), await shown(tablet, "delete-card"), await tablet.eval(`document.querySelectorAll("#links button").length`)],
    [["Mira Check", "Ned Check"], 0, true, false, 0]);
  t.ok("the storage block tells a member whose room it is, in words, and no price",
    /Mira Check, who hosts it, has 1 GB left of 1 GB/.test(await tablet.eval(`document.getElementById("storage").textContent`)) && !/price|\$/.test(await tablet.eval(`document.getElementById("storage").textContent`)));
  await layouts(tablet, "a trip's people, as a member", "people-member");

  // ── handing it over, with both pages open ───────────────────────────────────────────────
  t.part("Handing the trip over, both pages open");
  await phone.goto(`${origin}/trips/${lisbon.id}`);
  await loaded(phone);
  const offerBtn = `#people .ac-way:nth-child(2) .tr-row-acts button:first-child`;
  await pressTwice(phone, offerBtn);
  t.same("the host offers it: the page says what happens next, and the member is marked as offered, in words",
    [await says(phone, "msg-people", /Offered to Ned Check/), await phone.eval(`document.querySelector("#people .ac-way:nth-child(2) .pill-accent")?.textContent`)],
    ["Offered to Ned Check. You host it until they accept; you can take the offer back until then.", "Offered to host"]);
  await tablet.goto(`${origin}/trips`);
  await loaded(tablet);
  t.same("the member's list shows the offer as its own card, saying what hosting means, with Accept and Decline",
    [await tablet.eval(`document.querySelectorAll("#offers .tr-offer").length`), await tablet.eval(`document.querySelector("#offers .tr-offer h2").textContent`),
      await tablet.eval(`document.querySelector("#offers .tr-offer").textContent.includes("count against your storage")`),
      await tablet.eval(`[...document.querySelectorAll("#offers .tr-offer button")].map((b) => b.textContent)`)],
    [1, "Mira Check offered you “Lisbon in April” to host", true, ["Accept: I'll host it", "Decline"]]);
  await layouts(tablet, "Your trips, with an offer to host", "trips-offer");
  await tablet.click("#offers .tr-offer .ds-button--white");
  t.same("they accept: the list says so, and they host it now", [await says(tablet, "msg-list", /host/), server.sql(`SELECT host_id FROM trips WHERE id = '${lisbon.id}'`)[0].host_id],
    ["You host “Lisbon in April” now.", ned.user.id]);
  // The old host's page still shows them as host: what it tries next is answered as things are.
  await pressTwice(phone, `#people .ac-way:nth-child(2) .tr-row-acts button:last-child`);
  t.same("the old host's open page tries to remove someone: refused in words, nothing changes, and the page reads the trip again",
    [await says(phone, "msg-people", /host/), server.sql(`SELECT left_at FROM trip_members WHERE trip_id = '${lisbon.id}' AND user_id = '${ned.user.id}'`)[0].left_at,
      await phone.until(`document.querySelectorAll("#people button").length === 0`, "the page to show it isn't the host now").then(() => true)],
    ["Only the trip's host can do that.", null, true]);

  // ── the details, from either side ───────────────────────────────────────────────────────
  t.part("The trip's details, changed by a member");
  const ev = await ned.post(`${T}/events`, { id: "e-tram", title: "Tram 28", starts_at: Date.UTC(2031, 3, 4, 10) / 1000, tz: "Europe/Lisbon" });
  t.same("(the new host puts an event on its third day)", ev.status, 201);
  await phone.eval(`(() => { document.getElementById("d-from").value = ""; document.getElementById("d-to").value = ""; return true; })()`);
  await phone.click("#btn-details");
  t.same("clearing the dates while it has events is refused, naming the days", await says(phone, "msg-details", /events/),
    "The trip has events from 2031-04-04 to 2031-04-04, so its dates can't be cleared.");
  // Waits for this answer's own words: the one before (clearing the dates) also names the events.
  // The dates are set again and saved again (up to three times) when it hasn't come in 5 s: on a
  // loaded machine the page could repaint the form from a refresh after the first answer and put the
  // old dates back before the tap (15 Nov, under a gate and three other runs).
  let outside = "";
  for (let i = 0; i < 3 && !/events start on days/.test(outside); i++) {
    await phone.eval(`(() => { document.getElementById("d-from").value = "2031-04-05"; document.getElementById("d-to").value = "2031-04-09"; return true; })()`);
    await phone.click("#btn-details");
    outside = await says(phone, "msg-details", /events start on days/, 5000);
  }
  t.ok("dates that would leave the event outside are refused, naming its days", /events start on days from 2031-04-04 to 2031-04-04/.test(outside), outside);
  await phone.eval(`(() => { document.getElementById("d-from").value = "2031-04-02"; document.getElementById("d-to").value = "2031-04-10"; document.getElementById("d-name").value = "Lisbon, a long week"; document.getElementById("d-interests").value = "Trams, tiles, and nothing before nine."; return true; })()`);
  await phone.click("#btn-details");
  await says(phone, "msg-details", /Saved/);
  t.same("a member saves the details: only what changed is sent, and it is the trip's now",
    server.sql(`SELECT name, starts_on, ends_on, interests FROM trips WHERE id = '${lisbon.id}'`)[0],
    { name: "Lisbon, a long week", starts_on: "2031-04-02", ends_on: "2031-04-10", interests: "Trams, tiles, and nothing before nine." });
  await tablet.goto(`${origin}/trips/${lisbon.id}`);
  await loaded(tablet);
  t.same("the other person's page shows it the next time it asks", await tablet.eval(`document.getElementById("trip-name").textContent`), "Lisbon, a long week");

  // ── leaving ─────────────────────────────────────────────────────────────────────────────
  t.part("Leaving");
  await pressTwice(phone, "#leave-actions button");
  await phone.until(`location.pathname === "/trips"`, "the list of trips");
  await loaded(phone);
  t.same("the member leaves: back on their list, which says so and no longer has the trip",
    [await says(phone, "arrived", /left/), await shown(phone, "none")], ["You left the trip. What you added stays on it, and a link brings you back.", true]);
  await phone.goto(`${origin}/trips/${lisbon.id}`);
  await loaded(phone);
  t.same("its people page now answers as a trip that isn't theirs, with the way back", await phone.eval(`document.getElementById("failed-text").textContent`),
    "This trip isn't one of yours, or it was deleted. Your trips");

  // ── no signal, and whose list it is ─────────────────────────────────────────────────────
  t.part("Your trips with no signal");
  await tablet.goto(`${origin}/trips`);
  await loaded(tablet);
  const keptList = await tablet.eval(KEPT);
  t.same("the list the page got is kept on the phone, with whose it is", [keptList?.who, keptList?.trips?.map((x) => x.name)], [ned.user.id, ["Lisbon, a long week"]]);
  await tablet.requests("*/api/*", "fail");
  await tablet.goto(`${origin}/trips`);
  await loaded(tablet);
  t.same("with no connection it draws that list and says, in words, what needs one; making a trip is off",
    [await tablet.eval(`[...document.querySelectorAll("#list .tr-trip-name")].map((n) => n.textContent)`), await shown(tablet, "offline"),
      await tablet.eval(`document.getElementById("offline-text").textContent.includes("Making a trip")`), await tablet.eval(`document.getElementById("btn-make").disabled && document.getElementById("make-name").disabled`)],
    [["Lisbon, a long week"], true, true, true]);
  await layouts(tablet, "Your trips with no signal", "trips-offline");
  await tablet.goto(`${origin}/trips/${lisbon.id}`);
  await loaded(tablet);
  t.ok("a trip's people page says it needs a connection, and links back to the list", (await tablet.eval(`document.getElementById("failed-text").textContent`)).startsWith("This page needs a connection."));
  await tablet.requests("*/api/*", "off");
  // Someone else signs in on this browser (no signing out in between): the list isn't theirs.
  await signInto(tablet, mira);
  await tablet.requests("*/api/*", "fail");
  await tablet.goto(`${origin}/trips`);
  await loaded(tablet);
  t.same("another account on this phone, with no signal, is never shown the first one's list", [await shown(tablet, "page"), await tablet.eval(`document.getElementById("failed-text").textContent.startsWith("No connection")`)], [false, true]);
  await tablet.requests("*/api/*", "off");

  // ── deleting, by the host ───────────────────────────────────────────────────────────────
  t.part("The delete dialog, for a trip with people and a photo on it");
  const desk = await open(DESKTOP);
  await signInto(desk, ned);
  const LONG = "Porto, the Douro valley and the long way back along the coast to Lisbon by train";
  const porto = (await ned.post("/api/trips", { name: LONG, default_tz: "Europe/Lisbon", starts_on: "2031-06-01", ends_on: "2031-06-12" })).json?.trip;
  const portoLink = (await ned.post(`/api/trips/${porto.id}/links`, {})).json?.link;
  const mirasBack = await mira.post(`/api/join/${portoLink.code}`);
  const photo = Buffer.alloc(48 * 1024, 7);
  const up = await ned.post(`/api/trips/${porto.id}/media/begin`, { name: "harbour.jpg", mime: "image/jpeg", bytes: photo.length, kind: "photo" });
  const part = await ned.call("PUT", `/api/trips/${porto.id}/media/part?key=${encodeURIComponent(up.json.key)}&id=${encodeURIComponent(up.json.uploadId)}&n=1`, photo, { headers: { "Content-Type": "application/octet-stream" } });
  const done = await ned.post(`/api/trips/${porto.id}/media/finish`, { key: up.json.key, id: up.json.uploadId, parts: [{ n: 1, etag: part.json?.etag }] });
  t.same("(a second trip, with the longest kind of name, another person on it and a photo stored)", [porto?.name.length, mirasBack.status, done.status], [LONG.length, 200, 200]);
  const bought = await ned.post(`/api/trips/${porto.id}/purchases`, { id: "pu-train", description: "Train tickets", amount_minor: 4800, currency: "EUR", amount_exp: 2,
    split_mode: "weight", spent_at: Date.UTC(2031, 5, 3, 9) / 1000, shares: [{ user_id: ned.user.id, weight: 1, share_minor: 2400 }, { user_id: mira.user.id, weight: 1, share_minor: 2400 }] });
  t.same("(and a purchase the other person owes half of)", bought.status, 201);
  const goes = (await ned.call("DELETE", `/api/trips/${porto.id}`, {})).json?.goes;
  await desk.goto(`${origin}/trips/${porto.id}`);
  await loaded(desk);
  await layouts(desk, "a trip's people, with a long name", "people-long");
  await desk.click("#btn-delete");
  await desk.until(`document.getElementById("delete-dialog").open`, "the dialog");
  t.same("its dialog says what goes, in the server's own numbers for that trip: the other person, the photo and its size, the purchase, and that someone still owes",
    await desk.eval(`[...document.querySelectorAll("#dlg-goes .ac-list-row")].map((r) => r.textContent)`),
    [goes.members === 2 ? "1 other person loses it, as you do." : `(the server said ${goes.members} people)`,
      `${goes.photos === 1 ? "1 photo goes" : `${goes.photos} photos go`}, ${formatBytes(goes.bytes)} in all.`,
      goes.purchases === 1 ? "1 purchase goes, with who owes whom." : `(the server said ${goes.purchases} purchases)`,
      goes.someone_owes ? "Someone still owes money on it. Settle up first if that matters: afterwards nobody can see it." : "(the server said nobody owes)"]);
  await layouts(desk, "the delete dialog for a trip with people and a photo", "people-delete-full");
  await desk.click("#dlg-cancel");
  t.same("Keep it closes the dialog, and nothing goes", [await desk.eval(`document.getElementById("delete-dialog").open`), server.sql(`SELECT COUNT(*) AS n FROM trips WHERE id = '${porto.id}'`)[0].n], [false, 1]);

  t.part("Deleting the trip");
  await desk.goto(`${origin}/trips/${lisbon.id}`);
  await loaded(desk);
  await desk.click("#btn-delete");
  await desk.until(`document.getElementById("delete-dialog").open`, "the dialog");
  t.same("the dialog says what goes, from the server's numbers, and asks for the name typed",
    [await desk.eval(`document.getElementById("dlg-title").textContent`), await desk.eval(`[...document.querySelectorAll("#dlg-goes .ac-list-row")].map((r) => r.textContent)`),
      await desk.eval(`document.getElementById("dlg-delete").disabled`)],
    ["Delete “Lisbon, a long week”?", ["Nobody else is on it.", "It holds no photos, videos or pictures."], true]);
  await layouts(desk, "deleting a trip, the dialog open", "people-delete");
  await desk.type("#dlg-name", "Lisbon");
  t.same("a name that isn't it leaves the button off", await desk.eval(`document.getElementById("dlg-delete").disabled`), true);
  await desk.eval(`(() => { const i = document.getElementById("dlg-name"); i.value = "  Lisbon, a long week "; i.dispatchEvent(new Event("input")); return true; })()`);
  t.same("its name, with spaces around it, switches it on", await desk.eval(`document.getElementById("dlg-delete").disabled`), false);
  await desk.click("#dlg-delete");
  await desk.until(`location.pathname === "/trips"`, "the list of trips");
  await loaded(desk);
  t.same("it is deleted: back on the list, which says so; the trip is gone from the server",
    [await says(desk, "arrived", /deleted/), server.sql(`SELECT COUNT(*) AS n FROM trips WHERE id = '${lisbon.id}'`)[0].n], ["The trip is deleted, for everyone who was on it.", 0]);

  t.part("A trip the app left because it was gone, and the changes that went with it");
  const GONE = "That trip isn't one of yours any more, or it was deleted.";
  const arrive = async (query) => {
    await desk.goto(`${origin}/trips?${query}`);
    await loaded(desk);
    return [await says(desk, "arrived", /trip/), await desk.eval(`document.getElementById("arrived").classList.contains("lg-msg-err")`), await desk.eval("location.pathname + location.search")];
  };
  t.same("with nothing waiting for it, the list says only that it's gone, and the address loses its question",
    await arrive("gone=1"), [GONE, false, "/trips"]);
  t.same("with changes that hadn't been sent, it says how many went with it, marked as a loss (the warning's mark, not only its colour)",
    [await arrive("gone=1&unsent=3"), await desk.eval(`document.querySelector("#arrived svg").innerHTML.includes("M12 4.5")`)],
    [[`${GONE} 3 changes made here hadn't been sent, and went with it.`, true, "/trips"], true]);
  await layouts(desk, "a gone trip's unsent changes", "trips-gone-unsent");
  t.same("  (one change, said as one)", (await arrive("gone=1&unsent=1"))[0], `${GONE} 1 change made here hadn't been sent, and went with it.`);
  t.same("  (a count that isn't one is left out: none said, nothing marked)", [await arrive("gone=1&unsent=x"), (await arrive("gone=1&unsent=0"))[1]], [[GONE, false, "/trips"], false]);

  t.part("Signing out takes the kept list with it");
  await desk.goto(`${origin}/account`);
  await desk.until(`!document.getElementById("account").hidden`, "the account page");
  t.ok("(the list is kept on this phone before)", (await desk.eval(KEPT))?.who === ned.user.id);
  await desk.click("#btn-signout");
  await desk.until(`location.pathname === "/login"`, "the sign-in page");
  t.same("after signing out the phone holds no list of trips", await desk.eval(KEPT), null);

  t.part("Underneath");
  const errors = everyPage.flatMap((p) => p.errors);
  t.ok("no page threw an error or logged one", errors.length === 0, errors.slice(0, 8).join("\n        "));
  const failed = server.log().split("\n").filter((line) => /Uncaught|✘|\[ERROR\]|\b500\b/.test(line));
  t.ok("nothing failed inside the server", failed.length === 0, failed.slice(0, 8).join("\n        "));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  if (keep && server) console.log(`kept: ${server.work}`);
  await chrome?.close().catch((e) => console.error(e.message));
  await server?.stop();
}
process.exit(code);

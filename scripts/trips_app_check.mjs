#!/usr/bin/env node
/* Trips inside the app, in a real browser, on a server of its own.
 *
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
 *     --label "wegoplace trips_app_check.mjs" -- node scripts/trips_app_check.mjs
 *
 * WGP_SHOTS=<folder> also writes pictures at 320, 390, 768 and 1440 wide in both themes, to look
 * at: Your trips, a trip just made (every section of it, with nothing in it), the rows in
 * Other that lead out of a trip, Your trips saying a trip is gone. Nothing is asserted from them.
 *
 * The server is this check's own (checks/lib/server.mjs: an empty database, a port of its own),
 * and the browser is sent to it whatever the caller set (scripts/lib/browser.mjs, ownServer).
 * Two made-up people sign up with passkeys over plain HTTP (checks/lib/person.mjs). One
 * browser is "the phone": first the host's, later the other person's.
 *
 * WHAT IT PROVES
 *   1. THE REAL FLOW. A person makes a trip on Your trips (/trips) by typing a name and
 *      pressing the button, with no currency chosen, and lands in the app at /t/<id>/, which
 *      opens THAT trip: its name, its id, its own database on the phone ("wegoplace:<id>"),
 *      and the phone's list of trips naming it. A TRIP WITH NOTHING IN IT says so as a fact
 *      about the trip ("No plans yet", "No places yet"), never as waiting for signal; the
 *      bar is Agenda, Places, Split, Memories, Other; an address for a section that is gone
 *      lands on the Agenda; and once its one plan is in the past the Agenda names THIS trip.
 *   2. A TRIP WITH NO CURRENCY OF ITS OWN works in Split: a new purchase is in the person's
 *      home currency, the picker offers it, and the purchase reaches the server in it. Added
 *      through the sheet: the + button, a number, Add.
 *   3. TWO TRIPS ARE KEPT APART. A second trip, with an event and a purchase of its own, opens
 *      at its own address with only its own things, in its own database; the first is
 *      untouched; what the phone remembers about one (Split's currencies) is not the other's,
 *      and is stored under that trip's name.
 *   4. THE APP'S OWN ADDRESS "/" goes to the trip opened last, and keeps the section
 *      ("/#/split"). A phone that keeps no trip goes to Your trips.
 *   5. WITH NO ANSWER FROM THE API each trip still opens from what the phone keeps, a change
 *      made then waits in THAT trip's queue, and is sent to that trip's address when the API
 *      answers again.
 *   6. A PHONE FROM BEFORE. The one database a phone had before a trip had an address
 *      ("wegoplace"), holding a trip and a change never sent: "/" goes to that trip, its rows
 *      and the waiting change move into the trip's own database, the change is sent, the old
 *      database is left empty; and the feed's old rows move when Memories opens. A CHANGE
 *      THE SERVER NOW REFUSES, planted at the head of that old queue (a plan on a trip with
 *      no dates), does not hold the queue: it is dropped, the person is told what it was and
 *      why in a sentence, and the change behind it is sent.
 *   7. A TRIP THAT IS GONE. The host deletes a trip from another device while the phone has
 *      it open with a change waiting: the phone goes to Your trips, which says so and is
 *      told how many unsent changes went with the trip; that trip's rows, its waiting
 *      change and its offline map are off the phone; the other trip is whole; "/" no longer goes to the trip
 *      that is gone.
 *   8. A TRIP THAT ISN'T YOURS. Another person, on the same phone: the first person's trips
 *      are cleared before anything is shown; a trip they aren't on, opened by its address,
 *      goes to Your trips with nothing of it on the phone.
 *   9. A TRIP NEVER OPENED ON THIS PHONE, with no answer from the API: the Agenda and Places
 *      say they are waiting for signal, not that the trip is empty.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";

const server = await startServer({ name: "trips-app", port: await freeLoopbackPort() });
ownServer(server.origin);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// What the phone keeps: every database of the app's with how many rows each store has, the
// unsent changes of each trip, and the phone's list of trips.
const PHONE = `(async () => {
  const out = { dbs: {}, kept: null, old: localStorage.getItem("wgp.old-trip"),
    // What the phone remembers about one trip is stored as "<key>@<trip id>".
    choices: Object.keys(localStorage).filter((k) => k.includes("@")).sort(),
    bare: ["wgp.map.cam", "wgp.pack.folded", "wgp.split.display", "wgp.split.currency"].filter((k) => localStorage.getItem(k) !== null) };
  for (const d of await indexedDB.databases()) {
    if (!/^wegoplace/.test(d.name)) continue;
    const db = await new Promise((res, rej) => { const r = indexedDB.open(d.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const stores = {};
    for (const s of db.objectStoreNames) {
      const rows = await new Promise((res) => { const q = db.transaction([s]).objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); });
      stores[s] = s === "queue" ? rows.map((o) => o.kind + ":" + o.op + ":" + o.id) : s === "meta" ? rows.map((r) => r.k).sort() : rows.map((r) => r.id).sort();
      if (s === "meta") { const t = rows.find((r) => r.k === "trip"); stores.trip = t && t.v ? t.v.id : null; }
    }
    db.close();
    out.dbs[d.name] = stores;
  }
  try { out.kept = JSON.parse(localStorage.getItem("wgp.kept") || "null"); } catch { out.kept = "unreadable"; }
  return JSON.stringify(out);
})()`;

let b = null;
try {
  await server.start();
  const T0 = Math.floor(Date.now() / 1000);
  const day = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date(Date.now() + d * 86400e3));

  const host = new Person(server.origin, "Mara Voss"), other = new Person(server.origin, "Teo Lind");
  await host.signUp(); await other.signUp();
  const hostId = (await host.me()).id, otherId = (await other.me()).id;

  const { boot, evalIn, waitFor, appSettled, sleep } = await import("./lib/standalone_cdp.mjs");
  b = await boot({ vw: 390, vh: 844, dsf: 1 });
  const { cdp, S } = b;
  const page = (expr) => evalIn(cdp, S, expr);
  const phone = async () => JSON.parse(await page(PHONE));
  const inStore = (body) => page(`import("/js/store.js").then(({ store }) => { ${body} })`);
  const where = () => page(`location.pathname + location.search + location.hash`);
  // The browser becomes a person: their session cookie, and the readable cookie that names them.
  const become = async (person) => {
    for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: server.origin }, S);
    await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: person.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
    const who = person.jar.cookies.get("wgp_who");
    if (who) await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: who, sameSite: "Lax" }, S);
  };
  const go = async (address) => { await cdp.send("Page.navigate", { url: `${server.origin}${address}` }, S); await sleep(300); };
  // Open an address of the app and wait for the trip's page to have settled there.
  const openApp = async (address, ready = `document.querySelector("#view") && document.querySelector("#view").childElementCount ? 1 : 0`, label = "the app") => {
    await go(address);
    await waitFor(cdp, S, `/^\\/t\\/[^/]+\\/$/.test(location.pathname) ? 1 : 0`, { label: `${label}: a trip's address` });
    await appSettled(cdp, S);
    try { await waitFor(cdp, S, ready, { label }); } catch (e) {
      // What was on the screen instead, so a timeout says what happened and not only that it did.
      const seen = await page(`(location.pathname + location.hash + " :: " + ((document.querySelector("#view") || document.body).innerText || "").replace(/\\s+/g, " ").trim().slice(0, 400))`).catch(() => "");
      throw new Error(`${e.message}\n      on screen: ${seen}`);
    }
    await sleep(400);
  };
  const tap = async (sel, label = sel) => {
    const got = await page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return 0; if (n.disabled) return -1; n.click(); return 1; })()`);
    if (got !== 1) throw new Error(`tap: ${label} ${got === 0 ? "is not there" : "is disabled"}`);
    await sleep(160);
  };
  const type = async (sel, value) => {
    const ok = await page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return 0; n.focus(); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
    if (!ok) throw new Error(`type: ${sel} is not there`);
    await sleep(140);
  };
  const addPurchase = async (amount) => {
    await tap("#rt-fixed .fab", "the + button");
    await waitFor(cdp, S, `document.querySelector(".sp-amtin") ? 1 : 0`, { label: "the new purchase sheet" });
    await sleep(600);
    const cur = await page(`document.querySelector('[data-act="cur"]').textContent.trim()`);
    await type(".sp-amtin", amount);
    await tap('[data-act="save"]', "Add");
    await sleep(900);
    return cur;
  };
  // What the API was sent, by address: every write the page makes. And every page asked for,
  // so an address a page tidies away once it has read it can still be read here.
  const writes = [];
  const pages = [];
  cdp.on((m) => {
    if (m.sessionId !== S || m.method !== "Network.requestWillBeSent") return;
    const r = m.params.request;
    if (m.params.type === "Document") { const u = new URL(r.url); pages.push(u.pathname + u.search); }
    if (r.method !== "GET" && /\/api\//.test(r.url)) writes.push({ method: r.method, path: new URL(r.url).pathname, body: r.postData || "" });
  });
  // A picture of what is on screen now, at each width and in both themes, for a person to look at.
  const look = async (name) => {
    if (!SHOTS) return;
    const was = await page(`document.documentElement.getAttribute("data-theme") || ""`);
    for (const theme of ["light", "dark"]) {
      await page(`(document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)}), document.documentElement.setAttribute("data-lum", ${JSON.stringify(theme)}), 1)`);
      await sleep(600);
      for (const w of [320, 768, 1440, 390]) {
        await b.metrics(w, 844, 2);
        await sleep(350);
        await b.shot(path.join(SHOTS, `${w}-${theme}-${name}.png`));
      }
    }
    await page(`(${JSON.stringify(was)} ? document.documentElement.setAttribute("data-theme", ${JSON.stringify(was)}) : document.documentElement.removeAttribute("data-theme"), 1)`);
    await b.metrics(390, 844, 1);
    await sleep(300);
  };
  const apiOff = async (off) => { await cdp.send("Network.setBlockedURLs", { urls: off ? ["*/api/*"] : [] }, S); };

  // ── 1. the real flow ────────────────────────────────────────────────────────────────────
  section("1. a trip made on Your trips opens in the app at its own address");
  await become(host);
  await go("/");
  await waitFor(cdp, S, `location.pathname === "/trips" ? 1 : 0`, { label: "a phone that keeps no trip goes to Your trips" });
  check('"/" on a phone that keeps no trip goes to Your trips', (await where()) === "/trips", await where());
  await waitFor(cdp, S, `document.querySelector("#form-make") && !document.querySelector("#page").hidden && !document.querySelector("#make-name").disabled ? 1 : 0`, { label: "the form that makes a trip" });
  await look("your-trips-before-any");
  await type("#make-name", "Harbor week");
  // A new account is offered a currency guessed from the phone, marked as a guess (check:trips-browser
  // holds it); this trip is made without one, so the guess is taken off with its x first.
  const guessed = await page(`(() => { const c = document.querySelector("#make-curs .tr-cur[data-guess]"); if (!c) return ""; const code = c.querySelector(".tr-cur-code").textContent; c.querySelector(".tr-cur-off").click(); return code; })()`);
  const left = await page(`JSON.stringify([...document.querySelectorAll("#make-curs .tr-cur .tr-cur-code")].map((n) => n.textContent.trim()))`);
  const chosen = `guessed ${guessed || "nothing"}, left ${left}`;
  await page(`(document.querySelector("#form-make").requestSubmit(), 1)`);
  await waitFor(cdp, S, `/^\\/t\\/[^/]+\\/$/.test(location.pathname) ? 1 : 0`, { label: "making it lands in the app" });
  await appSettled(cdp, S);
  await waitFor(cdp, S, `document.querySelector("#view") && document.querySelector("#view").childElementCount ? 1 : 0`, { label: "the app's first screen" });
  await sleep(600);
  const first = (await page(`location.pathname`)).replace(/^\/t\/|\/$/g, "");
  const A = `/api/trips/${first}`;
  const snapA = (await host.get(A)).json;
  check("the trip is on the server under the id in the address, with no currency of its own",
    snapA && snapA.trip && snapA.trip.id === first && snapA.trip.name === "Harbor week" && Array.isArray(snapA.trip.currencies) && snapA.trip.currencies.length === 0,
    JSON.stringify(snapA && snapA.trip && { id: snapA.trip.id, name: snapA.trip.name, currencies: snapA.trip.currencies, chosen }));
  const opened = JSON.parse(await inStore(`return JSON.stringify({ id: store.tripId(), trip: store.trip() && { id: store.trip().id, name: store.trip().name, host: store.trip().host_id }, me: store.me().id, pending: store.pending() });`));
  check("the app opened THAT trip: its id from the address, its name, hosted by this person",
    opened.id === first && opened.trip && opened.trip.id === first && opened.trip.name === "Harbor week" && opened.trip.host === hostId && opened.me === hostId, JSON.stringify(opened));
  let ph = await phone();
  check("the phone keeps it in a database of its own, and none under the name from before",
    !!ph.dbs[`wegoplace:${first}`] && ph.dbs[`wegoplace:${first}`].trip === first && !ph.dbs.wegoplace, Object.keys(ph.dbs).join(" "));
  check("the phone's list of trips names it, as this person's, opened last",
    ph.kept && ph.kept.who === hostId && ph.kept.last === first && ph.kept.trips[first] && ph.kept.trips[first].name === "Harbor week", JSON.stringify(ph.kept));
  if (SHOTS) {
    // A trip just made, with nothing in it: every section, as the person who made it finds it.
    for (const [name, hash] of [["agenda", "#/"], ["places", "#/places"], ["pack", "#/pack"], ["memories", "#/memories"], ["split", "#/split"], ["other", "#/settings"]]) {
      await openApp(`/t/${first}/?${Date.now()}${hash}`, undefined, `a new trip: ${name}`);
      await sleep(900);
      await look(`new-trip-${name}`);
    }
  }

  // ── 1b. the ways out of the trip ─────────────────────────────────────────────────────────
  section("1b. Other names the ways out of the trip");
  await openApp(`/t/${first}/?${Date.now()}#/settings`, `document.querySelector("#st-sections a.st-row") && document.querySelector("#st-trip .st-tripname") ? 1 : 0`, "More");
  const outs = JSON.parse(await page(`JSON.stringify({
    rows: [...document.querySelectorAll("[data-st-you], #st-sections a.st-row, #st-sections button.st-row")].filter((a) => !/^#/.test(a.getAttribute("href") ?? "")).map((a) => { const r = a.getBoundingClientRect();
      return [a.querySelector(".ds-item-title").textContent.trim(), a.getAttribute("href") ?? a.id, r.height >= 44 && r.width > 0]; }),
    trip: document.querySelector("#st-trip").innerText })`));
  check("the ways out: Your account (you), this trip's people and settings, AI apps (a button: the Connect your AI sheet), Your trips; each a target a thumb can hit",
    JSON.stringify(outs.rows.map(([, ...rest]) => rest)) === JSON.stringify([["/account", true], [`/trips/${first}`, true], ["st-apps", true], ["/trips", true]])
      && outs.rows.slice(1).map((r) => r[0]).join() === "People and settings,AI apps,Your trips", JSON.stringify(outs.rows));
  check("a trip made without dates says so under its name: no bare dash, no broken date",
    /Harbor week/.test(outs.trip) && /Dates not set yet/.test(outs.trip) && !/NaN|Invalid|^\s*–\s*$/m.test(outs.trip), JSON.stringify(outs.trip));

  // ── 1c. a trip with nothing in it ───────────────────────────────────────────────────────
  section("1c. a trip with nothing in it says so, and carries nothing of any other trip");
  const emptyOf = async () => JSON.parse(await page(`JSON.stringify({
    words: (document.querySelector("#view .empty") || { innerText: "" }).innerText.replace(/\\s+/g, " ").trim(),
    bar: [...document.querySelectorAll(".tabbar .tab")].map((a) => a.dataset.tab), more: !!document.querySelector(".head-more[href='#/settings']"),
    route: document.querySelector("#view").dataset.route })`));
  await openApp(`/t/${first}/?${Date.now()}#/`, `document.querySelector("#view .empty") ? 1 : 0`, "the Agenda of a trip with no plans");
  let none = await emptyOf();
  check("the Agenda: no plans yet, said as a fact about the trip, not as waiting for signal",
    (/How do you want to plan it\?/.test(none.words) || /No plans yet/.test(none.words)) && !/signal/i.test(none.words), none.words);
  check("the bar, the same for everyone: Itinerary, Places, Split, Photos, Chat; More is your picture",
    none.bar.join() === "agenda,places,split,memories,chat" && none.more, `${none.bar.join()}; your picture to More: ${none.more}`);
  await page(`(location.hash = "#/hike", 1)`);
  await sleep(900);
  none = await emptyOf();
  check("an old address for a section that is gone lands on the Agenda", none.route === "agenda" && /^#\/?$/.test(await page(`location.hash || "#/"`)), `${none.route} ${await page(`location.hash`)}`);
  await openApp(`/t/${first}/?${Date.now()}#/places`, `document.querySelector("#view .empty") ? 1 : 0`, "Places of a trip with none");
  none = await emptyOf();
  check("Places: nothing added yet, said as a fact about the trip", /No places yet/.test(none.words) && /Nothing has been added/.test(none.words) && !/signal/i.test(none.words), none.words);
  // One plan, three weeks ago: the trip is over, and the Agenda says which trip that was.
  // (A trip takes a plan only on one of its days, so for this step the trip has dates, a
  // month ago; they are taken away again below, and the trip is as the person made it.)
  const dated = await host.call("PATCH", A, { starts_on: day(-24), ends_on: day(-20) });
  const past = await host.post(`${A}/events`, { id: "e-past", title: "Ferry out", starts_at: T0 - 21 * 86400, tz: "Europe/Lisbon", kind: "transit" });
  check("another device gives the trip dates a month ago and one plan in them", dated.status === 200 && past.status === 201, `${dated.status} ${dated.text.slice(0, 200)} / ${past.status} ${past.text.slice(0, 300)}`);
  await openApp(`/t/${first}/?${Date.now()}#/`, `document.querySelector("#view .ag-lede") ? 1 : 0`, "the Agenda, the trip's one plan in the past");
  const lede = await page(`document.querySelector("#view .ag-lede").innerText.replace(/\\s+/g, " ").trim()`);
  check("after the last plan the Agenda names this trip", past.status === 201 && /That was Harbor week/.test(lede) && /1 plan\b/.test(lede), `${past.status} ${lede}`);
  const unpast = await host.call("DELETE", `${A}/events/e-past`);
  const undated = await host.call("PATCH", A, { starts_on: null, ends_on: null });
  await openApp(`/t/${first}/?${Date.now()}#/`, `document.querySelector("#view .empty") ? 1 : 0`, "the Agenda, empty again");
  check("the plan and the dates removed, the Agenda is empty again", unpast.status === 200 && undated.status === 200 && undated.json.trip.starts_on === null && /How do you want to plan it\?|No plans yet/.test((await emptyOf()).words), `${unpast.status} ${undated.status} ${undated.text.slice(0, 200)}`);

  // ── 2. no currency of its own ──────────────────────────────────────────────────────────
  section("2. Split on a trip with no currency of its own");
  await openApp(`/t/${first}/#/split`, `document.querySelector("#rt-fixed .fab") ? 1 : 0`, "Split");
  const curNone = await addPurchase("12.00");
  let rowsA = (await host.get(A)).json.purchases;
  check("with no home currency either, a purchase is in US dollars, said on the chip", /USD/.test(curNone) && rowsA.length === 1 && rowsA[0].currency === "USD" && rowsA[0].amount_minor === 1200,
    `${curNone} / ${JSON.stringify(rowsA.map((p) => [p.currency, p.amount_minor]))}`);
  // The person says their home currency is the euro ON THIS PHONE, with the server out of reach.
  // The trip's list as the server last gave it has no euro in it, so only the phone's own
  // reading of the rule (the trip's, then the person's, then the ones used) can offer it.
  await apiOff(true);
  await inStore(`return store.setNativeCurrency("EUR");`);
  await openApp(`/t/${first}/?${Date.now()}#/split`, `document.querySelector("#rt-fixed .fab") ? 1 : 0`, "Split, the home currency just chosen, the API unreachable");
  check("the choice waits on the phone, and is still the phone's answer after a reload",
    (await inStore(`return store.pending();`)) === 1 && (await inStore(`return store.myNativeCurrency();`)) === "EUR",
    JSON.stringify({ pending: await inStore(`return store.pending();`), home: await inStore(`return store.myNativeCurrency();`), server: (await inStore(`return JSON.stringify(store.currencies());`)) }));
  await tap("#rt-fixed .fab", "the + button");
  await waitFor(cdp, S, `document.querySelector(".sp-amtin") ? 1 : 0`, { label: "the new purchase sheet, the API unreachable" });
  await sleep(600);
  await tap('[data-act="cur"]', "the currency chip");
  await sleep(300);
  const offeredOff = JSON.parse(await page(`JSON.stringify([...document.querySelectorAll(".sp-currow button")].map((n) => n.textContent.replace(/\\s+/g, " ").trim()))`));
  check("the picker offers the home currency before the server has heard of it", offeredOff.some((t) => /EUR/.test(t)), offeredOff.join(" | "));
  await apiOff(false);
  await page(`import("/js/store.js").then(({ store }) => (store.flush(), 1))`);
  await waitFor(cdp, S, `import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, { label: "the home currency sent" });
  const home = await host.get("/api/me");
  check("the server has the choice once it answers", home.status === 200 && /"native_currency":\s*"EUR"/.test(home.text), `${home.status} ${home.text.slice(0, 200)}`);
  await openApp(`/t/${first}/?${Date.now()}#/split`, `document.querySelector("#rt-fixed .fab") ? 1 : 0`, "Split again");
  await waitFor(cdp, S, `import("/js/store.js").then(({ store }) => store.myNativeCurrency() === "EUR" ? 1 : 0)`, { label: "the home currency on the phone" });
  await tap("#rt-fixed .fab", "the + button");
  await waitFor(cdp, S, `document.querySelector(".sp-amtin") ? 1 : 0`, { label: "the new purchase sheet" });
  await sleep(600);
  await tap('[data-act="cur"]', "the currency chip");
  await sleep(300);
  const offered = JSON.parse(await page(`JSON.stringify([...document.querySelectorAll(".sp-currow button")].map((n) => n.textContent.replace(/\\s+/g, " ").trim()))`));
  check("the picker offers the person's home currency on a trip with none", offered.some((t) => /EUR/.test(t)), offered.join(" | "));
  await page(`([...document.querySelectorAll(".sp-currow button")].find((n) => /EUR/.test(n.textContent)).click(), 1)`);
  await sleep(300);
  const curHome = await page(`document.querySelector('[data-act="cur"]').textContent.trim()`);
  await type(".sp-amtin", "30.00");
  await tap('[data-act="save"]', "Add");
  await sleep(900);
  rowsA = (await host.get(A)).json.purchases;
  check("a purchase in the home currency reaches the server in it, at this trip's address",
    /EUR/.test(curHome) && rowsA.length === 2 && rowsA.some((p) => p.currency === "EUR" && p.amount_minor === 3000)
      && writes.some((w) => w.method === "POST" && w.path === `${A}/purchases`), `${curHome} / ${JSON.stringify(rowsA.map((p) => [p.currency, p.amount_minor]))}`);
  // The next new purchase starts in the home currency: with no trip currency it is the main one.
  await openApp(`/t/${first}/?${Date.now()}#/split`, `document.querySelector("#rt-fixed .fab") ? 1 : 0`, "Split a third time");
  await tap("#rt-fixed .fab", "the + button");
  await waitFor(cdp, S, `document.querySelector(".sp-amtin") ? 1 : 0`, { label: "the new purchase sheet" });
  await sleep(600);
  const curNext = await page(`document.querySelector('[data-act="cur"]').textContent.trim()`);
  check("the next new purchase starts in the home currency", /EUR/.test(curNext), curNext);

  // ── 3. two trips kept apart ────────────────────────────────────────────────────────────
  section("3. a second trip has its own address, its own things, its own database");
  const made2 = await host.post("/api/trips", { name: "Ridge walk", default_tz: "Europe/Lisbon", starts_on: day(10), ends_on: day(13), currencies: ["CHF"] });
  const second = made2.json.trip.id, B = `/api/trips/${second}`;
  const shares = [{ user_id: hostId, weight: 1, share_minor: 4500 }];
  const seeded = [
    await host.post(`${B}/events`, { id: "e-hut", title: "Night at the hut", starts_at: T0 + 10 * 86400, tz: "Europe/Lisbon", kind: "plan" }),
    await host.post(`${B}/purchases`, { id: "pu-hut", description: "Hut", amount_minor: 4500, currency: "CHF", amount_exp: 2, split_mode: "weight", spent_at: T0, day: day(10), shares }),
  ];
  check("a second trip, with an event and a purchase of its own", made2.status === 201 && seeded.every((r) => r.status === 201),
    `${made2.status} ${seeded.map((r) => `${r.status}${r.status === 201 ? "" : ` ${r.text.slice(0, 160)}`}`).join(" ")}`);
  await openApp(`/t/${second}/#/split`, `document.querySelector(".sp-feed") && /Hut/.test(document.querySelector(".sp-feed").innerText) ? 1 : 0`, "the second trip's Split");
  const inB = JSON.parse(await inStore(`return JSON.stringify({ id: store.tripId(), name: store.trip().name, purchases: store.purchases().map((p) => p.id), events: store.events().map((e) => e.id), currencies: store.currencies() });`));
  check("it shows only its own purchase and event", inB.id === second && inB.name === "Ridge walk" && inB.purchases.join() === "pu-hut" && inB.events.join() === "e-hut", JSON.stringify(inB));
  const feedB = await page(`document.querySelector(".sp-feed").innerText`);
  check("nothing of the first trip is on its screen", /Hut/.test(feedB) && !/12\.00|30\.00/.test(feedB), feedB.replace(/\n+/g, " | ").slice(0, 200));
  await tap("#rt-fixed .fab", "the + button");
  await waitFor(cdp, S, `document.querySelector(".sp-amtin") ? 1 : 0`, { label: "the new purchase sheet" });
  await sleep(600);
  const curB = await page(`document.querySelector('[data-act="cur"]').textContent.trim()`);
  check("a new purchase there starts in ITS currency, not the one last used on the other trip", /CHF/.test(curB), curB);
  // Choosing a currency in the picker is what the phone remembers, for THIS trip.
  await tap('[data-act="cur"]', "the currency chip");
  await sleep(300);
  await page(`([...document.querySelectorAll(".sp-currow button")].find((n) => /CHF/.test(n.textContent)).click(), 1)`);
  await sleep(300);
  ph = await phone();
  const dbA = ph.dbs[`wegoplace:${first}`], dbB = ph.dbs[`wegoplace:${second}`];
  check("two databases, each holding its own trip's rows",
    dbA && dbB && dbA.trip === first && dbB.trip === second && dbA.purchases.length === 2 && dbB.purchases.join() === "pu-hut" && dbB.events.join() === "e-hut" && dbA.events.length === 0,
    JSON.stringify({ a: dbA && [dbA.trip, dbA.purchases.length, dbA.events.length], b: dbB && [dbB.trip, dbB.purchases, dbB.events] }));
  check("the phone's list names both, the second opened last", ph.kept.last === second && Object.keys(ph.kept.trips).sort().join() === [first, second].sort().join(), JSON.stringify(ph.kept));
  check("the currencies last used are remembered for each trip under its own name, and none for the phone as a whole",
    ph.choices.includes(`wgp.split.currency@${first}`) && ph.choices.includes(`wgp.split.currency@${second}`) && ph.bare.length === 0, JSON.stringify({ choices: ph.choices, bare: ph.bare }));

  // ── 4. the app's own address ───────────────────────────────────────────────────────────
  section('4. "/" goes to the trip opened last');
  await go("/#/split");
  await waitFor(cdp, S, `/^\\/t\\//.test(location.pathname) ? 1 : 0`, { label: '"/" sends the person on' });
  check('"/#/split" goes to the trip opened last, at Split', (await where()) === `/t/${second}/#/split`, await where());
  await openApp(`/t/${first}/#/`, undefined, "the first trip again");
  await go("/");
  await waitFor(cdp, S, `/^\\/t\\//.test(location.pathname) ? 1 : 0`, { label: '"/" sends the person on' });
  check('after opening the first again, "/" goes to the first', (await where()).replace(/#\/?$/, "") === `/t/${first}/`, await where());

  // ── 5. no answer from the API ──────────────────────────────────────────────────────────
  section("5. with no answer from the API a trip opens from the phone, and a change waits in its own queue");
  await apiOff(true);
  await openApp(`/t/${second}/?${Date.now()}#/split`, `document.querySelector(".sp-feed") && /Hut/.test(document.querySelector(".sp-feed").innerText) ? 1 : 0`, "the second trip with the API unreachable");
  check("the second trip opens from what the phone keeps", /Hut/.test(await page(`document.querySelector(".sp-feed").innerText`)));
  const n0 = writes.length;
  await addPurchase("7.50");
  ph = await phone();
  check("a purchase added now waits in the second trip's queue, and not in the first's",
    ph.dbs[`wegoplace:${second}`].queue.length === 1 && /^purchase:create:/.test(ph.dbs[`wegoplace:${second}`].queue[0]) && ph.dbs[`wegoplace:${first}`].queue.length === 0,
    JSON.stringify({ second: ph.dbs[`wegoplace:${second}`].queue, first: ph.dbs[`wegoplace:${first}`].queue }));
  check("the server has not heard of it", (await host.get(B)).json.purchases.length === 1);
  await openApp(`/t/${first}/?${Date.now()}#/split`, `document.querySelector(".sp-feed") && /30\\.00/.test(document.querySelector(".sp-feed").innerText) ? 1 : 0`, "the first trip with the API unreachable");
  const feedA = await page(`document.querySelector(".sp-feed").innerText`);
  check("the first trip opens from the phone too, without the other's waiting purchase", /12\.00/.test(feedA) && /30\.00/.test(feedA) && !/7\.50|Hut/.test(feedA), feedA.replace(/\n+/g, " | ").slice(0, 200));
  check("opening the first trip sent nothing of the second's", (await inStore(`return store.pending();`)) === 0);
  await apiOff(false);
  await openApp(`/t/${second}/?${Date.now()}#/split`, `document.querySelector(".sp-feed") ? 1 : 0`, "the second trip, the API answering again");
  await waitFor(cdp, S, `import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, { label: "the waiting purchase sent" });
  const sent = writes.slice(n0).filter((w) => w.method === "POST" && /\/purchases$/.test(w.path));
  const rowsB = (await host.get(B)).json.purchases;
  check("when the API answers again it is sent to the second trip's address, once",
    sent.length >= 1 && sent.every((w) => w.path === `${B}/purchases`) && rowsB.length === 2 && rowsB.some((p) => p.amount_minor === 750) && (await host.get(A)).json.purchases.length === 2,
    `${sent.map((w) => w.path).join(" ")} / second ${rowsB.length}`);

  // ── 6. a phone from before ─────────────────────────────────────────────────────────────
  section('6. a phone from before: one database, "wegoplace", with a trip and a change never sent');
  // Made from the real thing: the first trip's own database is copied to the name from before,
  // with a purchase waiting in its queue (added with the API unreachable), a feed row in the
  // feed's old database, and then every trace of the new arrangement is taken off the phone.
  await apiOff(true);
  await openApp(`/t/${first}/?${Date.now()}#/split`, `document.querySelector("#rt-fixed .fab") ? 1 : 0`, "the first trip, the API unreachable");
  await addPurchase("99.00");
  await go("/login?boot=1");
  await sleep(500);
  const planted = JSON.parse(await page(`(async () => {
    const open = (name, v, up) => new Promise((res, rej) => { const r = v ? indexedDB.open(name, v) : indexedDB.open(name); if (up) r.onupgradeneeded = () => up(r.result); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const all = (db, s) => new Promise((res) => { const q = db.transaction([s]).objectStore(s).getAll(); q.onsuccess = () => res(q.result); });
    const src = await open(${JSON.stringify(`wegoplace:${first}`)});
    const names = [...src.objectStoreNames];
    const data = {};
    for (const s of names) data[s] = await all(src, s);
    const version = src.version;
    src.close();
    const old = await open("wegoplace", version, (db) => {
      db.createObjectStore("meta", { keyPath: "k" });
      for (const s of names) if (s !== "meta" && s !== "queue") db.createObjectStore(s, { keyPath: "id" });
      db.createObjectStore("queue", { keyPath: "seq", autoIncrement: true });
    });
    // AHEAD of that purchase in the queue, a change from before that the server now refuses: a
    // new plan whose id has an underscore, as ids did before they took hyphens. It must not hold
    // the purchase behind it.
    const head = { ...data.queue[0], seq: data.queue[0].seq - 0.5, kind: "event", op: "create", id: "e_old_plan",
      payload: { id: "e_old_plan", title: "Old plan", starts_at: ${T0} + 86400, tz: "Europe/Lisbon", kind: "plan" } };
    data.queue.unshift(head);
    await new Promise((res, rej) => {
      const t = old.transaction(names, "readwrite");
      t.oncomplete = res; t.onerror = () => rej(t.error);
      for (const s of names) for (const row of data[s]) { if (s === "meta" && row.k === "adopted") continue; t.objectStore(s).put(row); }
    });
    old.close();
    const feed = await open("wegoplace-memories", 1, (db) => db.createObjectStore("memories", { keyPath: "id" }));
    await new Promise((res, rej) => { const t = feed.transaction(["memories"], "readwrite"); t.oncomplete = res; t.onerror = () => rej(t.error);
      t.objectStore("memories").put({ id: "m-old", caption: "From before", created_by: ${JSON.stringify(hostId)}, created_at: ${T0}, user_name: "Mara Voss", initials: "MV", tags: [], media: [] }); });
    feed.close();
    // The new arrangement, gone: this trip's own databases emptied, the list of trips removed.
    const there = new Set((await indexedDB.databases()).map((d) => d.name));
    for (const name of [${JSON.stringify(`wegoplace:${first}`)}, ${JSON.stringify(`wegoplace-memories:${first}`)}]) {
      if (!there.has(name)) continue;      // opening a name that was never there would make it, with no store in it
      const db = await open(name).catch(() => null);
      if (!db) continue;
      const stores = [...db.objectStoreNames];
      if (stores.length) await new Promise((res) => { const t = db.transaction(stores, "readwrite"); t.oncomplete = res; for (const s of stores) t.objectStore(s).clear(); });
      db.close();
    }
    localStorage.removeItem("wgp.kept"); localStorage.removeItem("wgp.old-trip");
    // And its choices, as a phone from before stored them: once, for its one trip.
    for (const k of Object.keys(localStorage)) if (k.endsWith(${JSON.stringify(`@${first}`)})) localStorage.removeItem(k);
    localStorage.setItem("wgp.split.currency", "EUR,USD");
    localStorage.setItem("wgp.map.cam", JSON.stringify({ lng: 1, lat: 2, zoom: 3, at: Date.now() }));
    return JSON.stringify({ queue: data.queue.map((o) => o.kind + ":" + o.op), purchases: data.purchases.length });
  })()`));
  ph = await phone();
  check("the plant: the old database holds the trip, three purchases and two changes waiting (one the server will refuse, first); the trip's own is empty; no list of trips",
    planted.queue.join() === "event:create,purchase:create" && ph.dbs.wegoplace && ph.dbs.wegoplace.trip === first && ph.dbs.wegoplace.purchases.length === 3
      && ph.dbs.wegoplace.queue.join() === ph.dbs.wegoplace.queue.filter((q, i) => (i === 0 ? q === "event:create:e_old_plan" : /^purchase:create:/.test(q))).join() && ph.dbs.wegoplace.queue.length === 2
      && ph.dbs[`wegoplace:${first}`].purchases.length === 0 && ph.kept === null,
    JSON.stringify({ planted, old: ph.dbs.wegoplace && [ph.dbs.wegoplace.trip, ph.dbs.wegoplace.purchases.length, ph.dbs.wegoplace.queue], own: ph.dbs[`wegoplace:${first}`] && ph.dbs[`wegoplace:${first}`].purchases, kept: ph.kept }));
  await go("/#/split");
  await waitFor(cdp, S, `/^\\/t\\//.test(location.pathname) ? 1 : 0`, { label: '"/" sends the old phone on' });
  check('"/" on that phone goes to the trip it held, at the section asked for', (await where()) === `/t/${first}/#/split`, await where());
  await appSettled(cdp, S);
  await waitFor(cdp, S, `document.querySelector(".sp-feed") && /99\\.00/.test(document.querySelector(".sp-feed").innerText) ? 1 : 0`, { label: "the old phone's trip, with its waiting purchase, and still no API" });
  ph = await phone();
  check("with no API at all, its rows and its waiting changes are in the trip's own database now, in their order",
    ph.dbs[`wegoplace:${first}`].trip === first && ph.dbs[`wegoplace:${first}`].purchases.length === 3
      && ph.dbs[`wegoplace:${first}`].queue.length === 2 && ph.dbs[`wegoplace:${first}`].queue[0] === "event:create:e_old_plan" && /^purchase:create:/.test(ph.dbs[`wegoplace:${first}`].queue[1])
      && ph.dbs[`wegoplace:${first}`].meta.includes("adopted"),
    JSON.stringify(ph.dbs[`wegoplace:${first}`]));
  check("the old database is left with nothing in it", Object.entries(ph.dbs.wegoplace).every(([k, v]) => k === "trip" ? v === null : v.length === 0), JSON.stringify(ph.dbs.wegoplace));
  check("what the old phone remembered (the currencies used, where the map was) is the trip's now, and no longer the phone's",
    ph.choices.includes(`wgp.split.currency@${first}`) && ph.choices.includes(`wgp.map.cam@${first}`) && ph.bare.length === 0, JSON.stringify({ choices: ph.choices, bare: ph.bare }));
  check("the phone's list names the trip again, and remembers which trip the old databases held", ph.kept && ph.kept.last === first && ph.old === first, JSON.stringify({ kept: ph.kept, old: ph.old }));
  check("the server still has not heard of the waiting purchase", (await host.get(A)).json.purchases.length === 2);
  await apiOff(false);
  await page(`import("/js/store.js").then(({ store }) => (store.flush(), store.refresh(), 1))`);
  await waitFor(cdp, S, `import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, { label: "the old phone's queue emptied" });
  const refusedSaid = await waitFor(cdp, S, `(() => { const t = document.querySelector("#toast"); return t && t.textContent.trim() ? t.textContent.trim() : 0; })()`, { label: "the person is told a change was refused", timeout: 6000 }).catch(() => "");
  const afterOld = (await host.get(A)).json;
  rowsA = afterOld.purchases;
  const sentOld = writes.filter((w) => w.path === `${A}/events` || w.path === `${A}/purchases`).slice(-2).map((w) => `${w.method} ${w.path.slice(A.length)}`);
  // A change carried over from the old app and then refused is said by name in the message
  // that stays until it is tapped (old-queue.js "refused"), not in one that goes by itself.
  check("the refused change went first, was dropped, and the person is told, by name, in the message that stays", sentOld.join() === "POST /events,POST /purchases" && !afterOld.events.some((e) => e.id === "e_old_plan")
    && typeof refusedSaid === "string" && /^“Old plan”, which you added before the update, wasn't kept: the trip couldn't take it as it was written\.\s*OK$/.test(refusedSaid), JSON.stringify({ sentOld, said: refusedSaid, events: afterOld.events.map((e) => e.id) }));
  check("the change behind it, that never left the old phone, reaches the server at the trip's address", rowsA.length === 3 && rowsA.some((p) => p.amount_minor === 9900), JSON.stringify(rowsA.map((p) => p.amount_minor)));
  // Loading the page again moves nothing twice.
  await openApp(`/t/${first}/?${Date.now()}#/split`, `document.querySelector(".sp-feed") && /99\\.00/.test(document.querySelector(".sp-feed").innerText) ? 1 : 0`, "the trip, loaded again");
  await sleep(800);
  check("loading again sends it no second time", (await host.get(A)).json.purchases.length === 3 && (await inStore(`return store.pending();`)) === 0);
  await apiOff(true);
  await openApp(`/t/${first}/?${Date.now()}#/memories`, `document.querySelector(".me-root, .me-feed, [data-view=\\"memories\\"], #view .me-head") ? 1 : 0`, "Memories, the API unreachable");
  const feedShown = await waitFor(cdp, S, `/From before/.test(document.querySelector("#view").innerText) ? 1 : 0`, { label: "the feed's old row on screen", timeout: 12000 }).then(() => true, () => false);
  check("the feed's old row is on screen with no API", feedShown, feedShown ? "" : (await page(`document.querySelector("#view").innerText`)).replace(/\s+/g, " ").slice(0, 300));
  ph = await phone();
  check("the feed's old row moved into the trip's own feed database, and shows with no API",
    (ph.dbs[`wegoplace-memories:${first}`] || {}).memories && ph.dbs[`wegoplace-memories:${first}`].memories.includes("m-old") && ph.dbs["wegoplace-memories"].memories.length === 0,
    JSON.stringify({ own: ph.dbs[`wegoplace-memories:${first}`], old: ph.dbs["wegoplace-memories"] }));
  await apiOff(false);

  // ── 7. a trip that is gone ─────────────────────────────────────────────────────────────
  section("7. the host deletes a trip elsewhere while this phone has it open with a change waiting");
  await apiOff(true);
  await openApp(`/t/${second}/?${Date.now()}#/split`, `document.querySelector("#rt-fixed .fab") ? 1 : 0`, "the second trip, the API unreachable");
  await addPurchase("5.00");
  check("a change is waiting on the second trip", (await inStore(`return store.pending();`)) === 1);
  // Each trip's offline map is on the phone (planted: no route gives a trip one yet).
  const mapsOf = () => page(`caches.open("wgp-tiles-v1").then((c) => c.keys()).then((ks) => ks.map((k) => new URL(k.url).pathname).sort().join(" "))`);
  await page(`caches.open("wgp-tiles-v1").then(async (c) => { for (const id of ${JSON.stringify([first, second])}) await c.put("/api/trips/" + id + "/tiles", new Response("a planted map")); return 1; })`);
  const hadMaps = await mapsOf();
  const hadChoices = (await phone()).choices;
  const gone = await host.call("DELETE", B, { confirm: "Ridge walk" });
  check("the trip is deleted from another device", gone.status === 200 && gone.json && gone.json.ok === true, `${gone.status} ${gone.text.slice(0, 160)}`);
  await apiOff(false);
  const n1 = writes.length;
  await page(`import("/js/store.js").then(({ store }) => (store.refresh(), 1))`);
  await waitFor(cdp, S, `location.pathname === "/trips" ? 1 : 0`, { label: "the phone leaves the trip that is gone" });
  await waitFor(cdp, S, `document.querySelector("#arrived") && !document.querySelector("#arrived").hidden && document.querySelector("#arrived").textContent.trim() ? 1 : 0`, { label: "Your trips says what happened" });
  const said = await page(`document.querySelector("#arrived").textContent.trim()`);
  // (Your trips tidies its own address to /trips once it has read why the person arrived.)
  await look("your-trips-a-trip-gone");
  check("the phone goes to Your trips, which says the trip is gone", (await where()) === "/trips" && /^That trip isn't one of yours any more, or it was deleted\./.test(said), `${await where()} / ${said}`);
  check("Your trips is told that one unsent change went with it", pages.includes("/trips?gone=1&unsent=1"), pages.slice(-4).join(" "));
  ph = await phone();
  check("that trip's rows and its waiting change are off the phone",
    Object.entries(ph.dbs[`wegoplace:${second}`]).every(([k, v]) => k === "trip" ? v === null : v.length === 0), JSON.stringify(ph.dbs[`wegoplace:${second}`]));
  check("the waiting change was not sent to anything", !writes.slice(n1).some((w) => w.path.startsWith(B) && w.method !== "GET"), JSON.stringify(writes.slice(n1).map((w) => `${w.method} ${w.path}`)));
  check("the other trip is whole on the phone", ph.dbs[`wegoplace:${first}`].trip === first && ph.dbs[`wegoplace:${first}`].purchases.length === 3, JSON.stringify(ph.dbs[`wegoplace:${first}`].purchases));
  const maps = await mapsOf();
  check("the gone trip's offline map is off the phone, and the other trip's is still there",
    hadMaps === [`/api/trips/${first}/tiles`, `/api/trips/${second}/tiles`].sort().join(" ") && maps === `/api/trips/${first}/tiles`, `${hadMaps} -> ${maps}`);
  check("the phone's list no longer names the trip that is gone", ph.kept && !ph.kept.trips[second] && !!ph.kept.trips[first] && ph.kept.last !== second, JSON.stringify(ph.kept));
  check("what the phone remembered about the trip that is gone went with it, and the other trip's stayed",
    hadChoices.some((k) => k.endsWith(`@${second}`)) && !ph.choices.some((k) => k.endsWith(`@${second}`)) && ph.choices.some((k) => k.endsWith(`@${first}`)),
    JSON.stringify({ before: hadChoices, after: ph.choices }));
  await go("/");
  await waitFor(cdp, S, `/^\\/t\\//.test(location.pathname) ? 1 : 0`, { label: '"/" sends the person on' });
  check('"/" goes to the trip that is left', (await where()).replace(/#\/?$/, "") === `/t/${first}/`, await where());

  // ── 8. a trip that isn't yours ─────────────────────────────────────────────────────────
  section("8. another person on the same phone");
  const theirs = await other.post("/api/trips", { name: "Lake days", default_tz: "Europe/Lisbon", currencies: ["EUR"] });
  const third = theirs.json.trip.id;
  await go("/login?boot=2");
  await sleep(400);
  await become(other);
  await openApp(`/t/${third}/#/`, undefined, "the other person's trip");
  await waitFor(cdp, S, `import("/js/store.js").then(({ store }) => store.me().id === ${JSON.stringify(otherId)} && store.trip() && store.trip().id === ${JSON.stringify(third)} ? 1 : 0)`, { label: "the other person's trip opened" });
  ph = await phone();
  check("the first person's trip is cleared off the phone before the other's opens",
    Object.entries(ph.dbs[`wegoplace:${first}`] || {}).every(([k, v]) => k === "trip" ? v === null : v.length === 0) && ph.dbs[`wegoplace:${third}`] && ph.dbs[`wegoplace:${third}`].trip === third,
    JSON.stringify({ first: ph.dbs[`wegoplace:${first}`], third: ph.dbs[`wegoplace:${third}`] && ph.dbs[`wegoplace:${third}`].trip }));
  check("the phone's list is the other person's now, and names only their trip", ph.kept && ph.kept.who === otherId && Object.keys(ph.kept.trips).join() === third, JSON.stringify(ph.kept));
  await go(`/t/${first}/#/split`);
  await waitFor(cdp, S, `location.pathname === "/trips" ? 1 : 0`, { label: "a trip that isn't theirs sends them to Your trips" });
  await waitFor(cdp, S, `document.querySelector("#arrived") && !document.querySelector("#arrived").hidden && document.querySelector("#arrived").textContent.trim() ? 1 : 0`, { label: "Your trips says what happened" });
  ph = await phone();
  const saidTheirs = await page(`document.querySelector("#arrived").textContent.trim()`);
  check("a trip they aren't on, opened by its address, goes to Your trips, which says it isn't one of theirs",
    (await where()) === "/trips" && saidTheirs === "That trip isn't one of yours any more, or it was deleted.", `${await where()} / ${saidTheirs}`);
  check("…with nothing of it on the phone, and the list still only their own",
    Object.entries(ph.dbs[`wegoplace:${first}`] || {}).every(([k, v]) => k === "trip" ? v === null : v.length === 0) && Object.keys(ph.kept.trips).join() === third, JSON.stringify({ first: ph.dbs[`wegoplace:${first}`], kept: ph.kept }));

  // ── 9. a trip this phone has never reached ────────────────────────────────────────────────
  section("9. a trip opened for the first time with no answer from the API");
  const made4 = await other.post("/api/trips", { name: "Never opened", default_tz: "UTC" });
  const fourth = made4.json && made4.json.trip && made4.json.trip.id;
  await apiOff(true);
  await openApp(`/t/${fourth}/?${Date.now()}#/`, `document.querySelector("#view .empty") ? 1 : 0`, "a trip never opened here, the API unreachable");
  const waitA = (await emptyOf()).words;
  await page(`(location.hash = "#/places", 1)`);
  await waitFor(cdp, S, `document.querySelector("#view").dataset.route === "places" && document.querySelector("#view .empty") ? 1 : 0`, { label: "Places, the API unreachable" });
  const waitP = (await emptyOf()).words;
  check("nothing of it is on the phone yet, and both screens say they are waiting for signal, not that the trip is empty",
    made4.status === 201 && /No itinerary yet/.test(waitA) && /Waiting for signal/.test(waitA) && /No places yet/.test(waitP) && /Waiting for signal/.test(waitP), `${made4.status} / ${waitA} / ${waitP}`);
  await apiOff(false);

  check("no page error", b.pageErrors.length === 0, b.pageErrors.join(" | "));
} catch (e) {
  fail++; failures.push("the check ran to its end");
  console.log(`  FAIL  the check ran to its end   -> ${e && e.stack ? e.stack : e}`);
} finally {
  if (b) await b.done().catch(() => {});
  await server.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(fail ? 1 : 0);

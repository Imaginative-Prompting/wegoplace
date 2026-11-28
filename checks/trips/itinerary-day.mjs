// A busy day on the Itinerary, on a phone (public/js/agenda.js): fifteen plans on one day, some at once, one in another
// time zone, a flight into another, a stay checking in while a plan is on, one past midnight; the phone's clock set to
// 15:10 that day, when three plans are on at once.
//
//   node checks/trips/itinerary-day.mjs [--port <port>] [--shots <folder>] [--scheme dark] [--width 390]
//
// On a server of its own. It holds:
//   1. ONE TIME COLUMN A DAY: every title of the day starts at one left edge, the rows with a zone chip or an end on
//      the next day included (each card was its own grid, and a wider time pushed only its own title right). And a day
//      with no zone chip and nothing past midnight keeps the narrow column it always had (58 px).
//   2. A CHECK-IN DURING A PLAN stands right after that plan, before the plan's free time (it stood under "30m free",
//      reading as happening in that half hour).
//   3. OPENED WHILE PLANS ARE ON, the first of them is wholly on screen: below the day's heading and above the tab bar
//      and the + (they float over the list's foot, and a card behind them counted as on screen).
//   4. A PLAN'S NOTE keeps its line breaks.
//   And no page has an error.
//
// Planted (AGENDA_DAY_PLANT=<name>, agenda.js served with that fix taken out): column (1 red), stay (2 red),
// ceil (3 red), note (4 red); wide (every day's column made wide: 1's narrow-day claim red).
// Everyone and everything in it is made up.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";
import { sendAs } from "../lib/demo.mjs";
import { seedTrip } from "../../tools/seed-trip.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8796);
const shots = flag("--shots");
const scheme = flag("--scheme") ?? "light";
const WIDTH = Number(flag("--width") ?? 440);
if (![390, 440].includes(WIDTH)) { console.error("--width 390 or 440"); process.exit(2); }
const HEIGHT = WIDTH === 440 ? 956 : 844;
const PLANT = process.env.AGENDA_DAY_PLANT || "";
const PLANTS = {
  column: ["var(--ag-when-w, minmax(58px, auto))", "minmax(58px, auto)"],
  stay: ["    staysWithin(c, i + 1 < d.cards.length ? startMs(d.cards[i + 1]) : null);\n", ""],
  ceil: ["(tall ? r.top + tall : r.bottom) <= chromeCeil() - 8", "(tall ? r.top + tall : r.bottom) <= el.getBoundingClientRect().bottom - 8"],
  note: ["color: var(--ink-2); white-space: pre-line; }", "color: var(--ink-2); }"],
  wide: ["const v = `${Math.max(58, Math.ceil(w))}px`;", "const v = `${Math.max(99, Math.ceil(w))}px`;"],
};
if (PLANT && !PLANTS[PLANT]) { console.error(`AGENDA_DAY_PLANT is one of ${Object.keys(PLANTS).join(", ")}`); process.exit(2); }
if (shots) fs.mkdirSync(shots, { recursive: true });
const t = new Report("a busy day on the Itinerary");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The day: Wed 10 Mar 2027, the trip in Lima (UTC-5 all year).
const LIMA = "America/Lima";
const at = (day, hm) => { const [h, m] = hm.split(":").map(Number); return Date.UTC(2027, 2, day, h + 5, m) / 1000; };
const ev = (id, kind, title, s, e, extra = {}) => ({ id, kind, title, starts_at: at(10, s), ends_at: e < s ? at(11, e) : at(10, e), tz: LIMA, ...extra });
const SEED = {
  trip: { name: "A busy day (made up)", starts_on: "2027-03-09", ends_on: "2027-03-12", default_tz: LIMA, currencies: ["PEN"] },
  areas: [{ id: "harbour", name: "Harbour", west: -77.2, south: -12.1, east: -77.1, north: -12.0, sort: 1 }],
  places: [
    { id: "p-inn", name: "Harbour Steps Inn", kind: "lodging", subkind: "hotel", area: "harbour", lat: -12.07, lng: -77.15 },
    { id: "p-museum", name: "Museum of the Old Port, the textiles wing", kind: "sight", subkind: "museum", area: "harbour", lat: -12.071, lng: -77.151 },
    { id: "p-pier", name: "The breakwater", kind: "sight", subkind: "viewpoint", area: "harbour", lat: -12.072, lng: -77.153 },
  ],
  events: [
    // The day before: plain times only, nothing in another zone, nothing past midnight.
    { id: "e-00", kind: "transit", title: "Arrive at the harbour", starts_at: at(9, "16:00"), ends_at: at(9, "17:00"), tz: LIMA },
    ev("e-01", "meal", "Breakfast at the market stalls", "06:30", "07:15"),
    ev("e-02", "transit", "Van to the upper valley", "07:00", "08:30"),
    ev("e-03", "activity", "Terraces walk with the guide", "08:30", "11:00", { place_id: "p-pier" }),
    ev("e-04", "activity", "Weaving demonstration", "09:00", "10:00"),
    { id: "e-05", kind: "activity", title: "Call with the bank (their time)", starts_at: Date.UTC(2027, 2, 10, 15, 0) / 1000, ends_at: Date.UTC(2027, 2, 10, 15, 30) / 1000, tz: "Europe/Madrid" },
    ev("e-06", "meal", "Lunch under the pepper tree", "11:30", "12:30"),
    ev("e-07", "plan", "Pick up the laundry", "12:00", "13:00"),
    ev("e-08", "activity", "Museum of the old port", "13:30", "15:30", { place_id: "p-museum" }),
    { id: "e-09", kind: "flight", title: "XY 77 to La Paz", starts_at: at(10, "14:00"), ends_at: Date.UTC(2027, 2, 10, 20, 45) / 1000, tz: LIMA, end_tz: "America/La_Paz" },
    { id: "e-10", kind: "lodging", title: "Check in: Harbour Steps Inn", starts_at: at(10, "15:00"), ends_at: at(12, "11:00"), tz: LIMA, place_id: "p-inn" },
    ev("e-11", "activity", "Boat to the sea lions", "15:00", "16:00"),
    ev("e-12", "transit", "Taxi back from the pier", "16:30", "17:00"),
    ev("e-13", "meal", "Dinner on the corner", "19:30", "21:00", { detail: "Table for six under Ana.\nCash only after ten." }),
    ev("e-14", "activity", "Live music at the plaza", "21:00", "22:00"),
    ev("e-15", "activity", "Night market, past midnight", "23:30", "01:30"),
  ],
};
// The phone's clock: 15:10 that day (museum, flight and boat all on), running on from there.
const NOW = Date.parse("2027-03-10T15:10:00-05:00");
const CLOCK = `(() => { const off = ${NOW} - Date.now(); const R = Date;
  class D extends R { constructor(...a) { if (a.length) super(...a); else super(R.now() + off); } static now() { return R.now() + off; } }
  D.UTC = R.UTC; D.parse = R.parse; globalThis.Date = D; })();`;

let server, chrome;
try {
  server = await startServer({ name: "itinerary-day", port });
  await server.start();
  const { origin } = server;
  const ana = new Person(origin, "Ana Busyday");
  if ((await ana.signUp()).status !== 200) throw new CheckError("couldn't make Ana's account");
  const { tripId } = await seedTrip(SEED, sendAs(ana));

  chrome = await openChrome();
  const page = await chrome.page({ width: WIDTH, height: HEIGHT, mobile: true, passkeys: false, before: CLOCK });
  await page.scheme(scheme);
  await page.send("Emulation.setTimezoneOverride", { timezoneId: LIMA });
  await page.setCookie(origin, "wgp_session", ana.jar.cookies.get("wgp_session"));
  await page.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(ana.user.id), sameSite: "Lax" });
  if (PLANT) {
    const [from, to] = PLANTS[PLANT];
    const src = fs.readFileSync(path.join(ROOT, "public/js/agenda.js"), "utf8");
    if (!src.includes(from)) throw new CheckError(`the ${PLANT} plant didn't take: agenda.js has changed`);
    const body = Buffer.from(src.replace(from, to)).toString("base64");
    page.on((m) => { if (m.method === "Fetch.requestPaused") page.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body }).catch(() => {}); });
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/agenda.js*" }] });
  }
  // Captured as it stands: page.shot() waits for the page to come to rest, and a live card pulses as long as it's live.
  const shot = async (name) => { if (!shots) return; await sleep(400);
    fs.writeFileSync(path.join(shots, `${name}-${WIDTH}-${scheme}.png`), Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64")); };

  await page.goto(`${origin}/t/${encodeURIComponent(tripId)}/#/`);
  await page.until(`!!document.querySelector('#view .ag-day[data-today="1"] .ag-card')`, "today on the Itinerary", 25000);
  await sleep(1500);
  await shot("opened");
  const DAY = `document.querySelector('#view .ag-day[data-today="1"]')`;

  // 3. Opened while plans are on: the first live one, wholly between the day's heading and the floating chrome.
  const live = JSON.parse(await page.eval(`(() => { const c = document.querySelector('.ag-slot[data-live="1"] .ag-card'); if (!c) return "null";
    const r = c.getBoundingClientRect(); const head = ${DAY}.querySelector(".ag-dayhead").getBoundingClientRect();
    const foot = Math.min(...[...document.querySelectorAll(".tabbar, .ag-fab")].map((n) => n.getBoundingClientRect()).filter((b) => b.height && b.top > innerHeight / 2).map((b) => b.top), innerHeight);
    return JSON.stringify({ title: c.querySelector(".ag-title").textContent.trim(), top: Math.round(r.top), bottom: Math.round(r.bottom), head: Math.round(head.bottom), foot: Math.round(foot) }); })()`));
  console.log(`  opened at 15:10: ${JSON.stringify(live)}, scrollTop ${await page.eval(`document.querySelector("#view").scrollTop`)}`);
  t.ok("opened at 15:10, the first plan on now is wholly on screen, above the tab bar and the +",
    !!live && live.top >= live.head - 1 && live.bottom <= live.foot, JSON.stringify(live));

  // 1. One time column a day.
  const lefts = JSON.parse(await page.eval(`JSON.stringify([...${DAY}.querySelectorAll(".ag-card")].map((c) => [c.querySelector(".ag-title").textContent.trim().slice(0, 24), Math.round(c.querySelector(".ag-title").getBoundingClientRect().left)]))`));
  const edges = [...new Set(lefts.map(([, x]) => x))];
  t.ok(`every title of the day (${lefts.length}) starts at one left edge, the zone and past-midnight rows included`,
    lefts.length >= 14 && edges.length === 1, JSON.stringify(edges.length === 1 ? edges : lefts));

  const narrow = JSON.parse(await page.eval(`(() => { const d = document.querySelector('#view .ag-day[data-day="2027-03-09"]'); const c = d && d.querySelector(".ag-card"); return JSON.stringify(c ? { col: getComputedStyle(c).gridTemplateColumns.split(" ")[0], when: d.querySelector(".ag-list").style.getPropertyValue("--ag-when-w") } : null); })()`));
  t.ok("a day with plain times only keeps the narrow time column (58 px)", !!narrow && narrow.col === "58px", JSON.stringify(narrow));

  // 2. The check-in during the boat stands right after it, before its free time.
  const order = JSON.parse(await page.eval(`JSON.stringify([...${DAY}.querySelectorAll(".ag-list > li")].map((li) => li.querySelector(".ag-stay") ? "stay:" + li.textContent.replace(/\\s+/g, " ").trim().slice(0, 30) : li.querySelector(".ag-card") ? "card:" + li.querySelector(".ag-title").textContent.trim() : "rail:" + li.textContent.replace(/\\s+/g, " ").trim().slice(0, 20)))`));
  const boat = order.indexOf("card:Boat to the sea lions");
  t.ok("the 15:00 check-in stands right after the 15:00 boat, before the boat's free time",
    boat >= 0 && /^stay:.*Check in/.test(order[boat + 1] || ""), JSON.stringify(order.slice(Math.max(0, boat - 1), boat + 4)));
  await page.eval(`(() => { const c = [...document.querySelectorAll("#view a.ag-card")].find((r) => /Boat to the sea/.test(r.textContent)); const v = document.querySelector("#view"); v.scrollTop += c.getBoundingClientRect().top - 260; return 1; })()`);
  await sleep(400);
  await shot("boat-checkin");

  // 4. A plan's note, line for line.
  await page.goto(`${origin}/t/${encodeURIComponent(tripId)}/#/e/e-13`);
  await page.until(`!!document.querySelector(".ag-d-body .ag-d-p")`, "the dinner's note", 20000);
  const lines = await page.eval(`document.querySelector(".ag-d-body .ag-d-p").innerText`);
  t.ok("a plan's note keeps its line break", lines === "Table for six under Ana.\nCash only after ten.", JSON.stringify(lines));
  await shot("note");

  t.ok("no page error", page.errors.length === 0, page.errors.join(" | "));
} catch (e) {
  t.ok(`ran to the end`, false, e instanceof CheckError ? e.message : (e.stack || String(e)));
} finally {
  await chrome?.close().catch(() => {});
  await server?.stop().catch(() => {});
}
process.exit(t.end());

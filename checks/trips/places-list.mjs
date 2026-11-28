// Places at a phone's width (public/js/places.js), on a phone set to US English (feet and miles): a list measured from
// one place, where several places stand a few metres apart, and a place's note written on two lines.
//
//   node checks/trips/places-list.mjs [--port <port>] [--shots <folder>] [--scheme dark] [--width 390]
//
// On a server of its own. It holds:
//   1. THE DISTANCES AS SHOWN NEVER FALL down the list (in feet, places that read "70 ft" stood above "60 ft": the
//      list tied places on metres rounded to 10 m and put them in name order, while feet are shown rounded to 10 ft).
//      Then the same in metres, on a phone set to British English.
//   2. A PLACE'S NOTE keeps its line break, on its page.
//   And no page has an error.
//
// Planted (PLACES_LIST_PLANT=<name>, places.js served with that fix taken out): order (1 red), why (2 red).
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
const port = Number(flag("--port") ?? 8794);
const shots = flag("--shots");
const scheme = flag("--scheme") ?? "light";
const WIDTH = Number(flag("--width") ?? 440);
if (![390, 440].includes(WIDTH)) { console.error("--width 390 or 440"); process.exit(2); }
const HEIGHT = WIDTH === 440 ? 956 : 844;
const PLANT = process.env.PLACES_LIST_PLANT || "";
const PLANTS = {
  order: ["if (ad && fmtDistance(a.dist) !== fmtDistance(b.dist)) return a.dist - b.dist;", "if (ad && Math.round(a.dist / 10) !== Math.round(b.dist / 10)) return a.dist - b.dist;"],
  why: ["color:var(--ink-1);white-space:pre-line}\n.pl-facts", "color:var(--ink-1)}\n.pl-facts"],
};
if (PLANT && !PLANTS[PLANT]) { console.error(`PLACES_LIST_PLANT is one of ${Object.keys(PLANTS).join(", ")}`); process.exit(2); }
if (shots) fs.mkdirSync(shots, { recursive: true });
const t = new Report("Places at a phone's width");

// Places a set number of metres north of the anchor (a metre of latitude is 1/111,320 of a degree).
const LAT = -12.07, LNG = -77.15;
const north = (m) => +(LAT + m / 111320).toFixed(7);
const P = (id, name, m, extra = {}) => ({ id, name, kind: "food", subkind: "restaurant", area: "harbour", lat: north(m), lng: LNG, ...extra });
const SEED = {
  trip: { name: "Places a few steps apart (made up)", starts_on: "2027-03-09", ends_on: "2027-03-12", default_tz: "America/Lima", currencies: ["PEN"] },
  areas: [{ id: "harbour", name: "Harbour", west: -77.2, south: -12.1, east: -77.1, north: -12.0, sort: 1 }],
  places: [
    P("p-anchor", "The square's fountain", 0, { kind: "sight", subkind: "plaza", why: "Meet here.\nThe bench on the shady side." }),
    // 18 m (59 ft: "60 ft") and 21 m (69 ft: "70 ft"): one 10 m step, two in feet. Names put the farther first.
    P("p-a", "Ancla del Malecón", 21.2),
    P("p-f", "Faro de la Plaza", 18.0),
    P("p-m", "Marea de la Plaza", 18.4),
    // 44 m ("140 ft") and 46 m ("150 ft"), the same 10 m step: names again the wrong way round.
    P("p-b", "Brisa del Cerro", 46.2),
    P("p-g", "Gaviota del Cerro", 44.0),
    P("p-z", "Zafiro, far up the hill", 300),
  ],
  events: [],
};

let server, chrome;
try {
  server = await startServer({ name: "places-list", port });
  await server.start();
  const { origin } = server;
  const ana = new Person(origin, "Ana Placelist");
  if ((await ana.signUp()).status !== 200) throw new CheckError("couldn't make Ana's account");
  const { tripId } = await seedTrip(SEED, sendAs(ana));

  chrome = await openChrome();
  const src = PLANT ? fs.readFileSync(path.join(ROOT, "public/js/places.js"), "utf8") : "";
  if (PLANT && !src.includes(PLANTS[PLANT][0])) throw new CheckError(`the ${PLANT} plant didn't take: places.js has changed`);
  const phone = async (locale) => {
    const page = await chrome.page({ width: WIDTH, height: HEIGHT, mobile: true, passkeys: false,
      before: `Object.defineProperty(navigator, "language", { get: () => ${JSON.stringify(locale)} }); Object.defineProperty(navigator, "languages", { get: () => [${JSON.stringify(locale)}] });` });
    await page.scheme(scheme);
    await page.setCookie(origin, "wgp_session", ana.jar.cookies.get("wgp_session"));
    await page.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(ana.user.id), sameSite: "Lax" });
    if (PLANT) {
      const body = Buffer.from(src.replace(PLANTS[PLANT][0], PLANTS[PLANT][1])).toString("base64");
      page.on((m) => { if (m.method === "Fetch.requestPaused") page.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body }).catch(() => {}); });
      await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/places.js*" }] });
    }
    return page;
  };
  const shot = async (page, name) => { if (shots) await page.shot(path.join(shots, `${name}-${WIDTH}-${scheme}.png`)); };

  // 1. The list from the fountain, in feet, then in metres.
  const errors = [];
  for (const [locale, unit] of [["en-US", "ft"], ["en-GB", "m"]]) {
    const page = await phone(locale);
    await page.goto(`${origin}/t/${encodeURIComponent(tripId)}/#/places?near=p-anchor`);
    await page.until(`document.querySelectorAll("#view .pl-row .pl-far").length >= 6`, "the list with its distances", 25000);
    await new Promise((r) => setTimeout(r, 800));
    const rows = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll("#view .pl-row")].filter((r) => r.querySelector(".pl-far")).map((r) => [r.querySelector(".pl-name, h3, strong")?.textContent.trim() ?? r.textContent.trim().slice(0, 20), r.querySelector(".pl-far").textContent.trim()]))`));
    // The figure in feet (miles never appear here) or metres; one unit across the list.
    const nums = rows.map(([, d]) => { const m = d.match(/^([\d.,]+)\s*(ft|m|mi|km)$/); return m ? { n: Number(m[1].replace(/,/g, "")), u: m[2] } : null; });
    const sameUnit = nums.every((x) => x && x.u === unit);
    const rising = nums.every((x, i) => i === 0 || (x && nums[i - 1] && x.n >= nums[i - 1].n));
    t.ok(`${locale}: the distances shown (${unit}) never fall down the list`, rows.length >= 6 && sameUnit && rising, JSON.stringify(rows));
    await shot(page, `list-${locale}`);
    errors.push(...page.errors);
    await page.close();
  }

  // 2. The fountain's note, line for line.
  const page = await phone("en-US");
  await page.goto(`${origin}/t/${encodeURIComponent(tripId)}/#/p/p-anchor`);
  await page.until(`!!document.querySelector("#view .pl-why")`, "the fountain's page", 20000);
  const why = await page.eval(`document.querySelector("#view .pl-why").innerText`);
  t.ok("a place's note keeps its line break", why === "Meet here.\nThe bench on the shady side.", JSON.stringify(why));
  await shot(page, "note");
  errors.push(...page.errors);

  t.ok("no page error", errors.length === 0, errors.join(" | "));
} catch (e) {
  t.ok("ran to the end", false, e instanceof CheckError ? e.message : (e.stack || String(e)));
} finally {
  await chrome?.close().catch(() => {});
  await server?.stop().catch(() => {});
}
process.exit(t.end());

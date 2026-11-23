#!/usr/bin/env node
/* The towns a trip can say it goes to (public/towns/, public/js/city-search.js). No browser.
 *
 *   node scripts/towns_check.mjs
 *
 * The table is some 2,500 small files, read as a person types. This reads them from the disk
 * through the very module the picker uses, and proves:
 *   1. THE TABLE HOLDS TOGETHER: its index names a date and the files' first lines carry it;
 *      no file is over the weight the picker is promised; every line reads as a town; and
 *      EVERY town is found from every one of its names: the file the picker would ask for
 *      has it (or, for a run of letters that was split, the file for exactly those letters).
 *   2. WHAT IS TYPED FINDS THE PLACE, with its zone and where its box is: the names people
 *      type for the places trips go to, in their own spelling and in others'; a name shown is
 *      the one typed where that is one of the town's names; two towns of one name are told
 *      apart; a country finds a zone and no position; what no list of towns has finds nothing
 *      (the picker then offers a map link).
 *   3. NO REGION WORD OF THE ZONE DATABASE is in anything shown ("Lima, Peru", never
 *      "Lima · America").
 *   4. THE BOX a town gets: 12 km to each side up to 100,000 people, 20 km from a million, and
 *      it holds what a visit goes to.
 *   5. WITH THE TABLE OUT OF REACH the answer says so and still finds a zone by its name; a
 *      file read once is not asked for again.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  CAP_BYTES, HEAD_ROWS, acrossKm, areaAcrossKm, areaIdFor, areaOf, boxFor, fileFor, fileName, findTowns, fold, laterWords, placeWords, planWords, rowLabel, rowWhere,
  squash, townSource, zoneNear, zonePlace, zoneRows, zoneWords,
} from "../public/js/city-search.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(REPO, "public/towns");
let pass = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) pass++;
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 600) : ""}`); }
}

// ── 1. the table holds together ─────────────────────────────────────────────────────────
const index = JSON.parse(fs.readFileSync(path.join(DIR, "index.json"), "utf8"));
const onDisk = fs.readdirSync(DIR).filter((n) => n !== "index.json" && n !== "near.txt" && n !== "LICENSE.txt");
check("the index names the day of its snapshot and its source", /^\d{4}-\d{2}-\d{2}$/.test(index.made) && /GeoNames/.test(index.source) && /CC BY 4\.0/.test(index.source), `${index.made} / ${index.source}`);
check("every file is a table file by its name (t-<letters and digits>.txt)", onDisk.every((n) => /^t-[a-z0-9]+\.txt$/.test(n)), onDisk.filter((n) => !/^t-[a-z0-9]+\.txt$/.test(n)).slice(0, 5).join(", "));

const texts = new Map();            // prefix -> the file's text
for (const n of onDisk) texts.set(n.slice(2, -4), fs.readFileSync(path.join(DIR, n), "utf8"));
const heavy = [...texts].filter(([, t]) => Buffer.byteLength(t) > CAP_BYTES).map(([p]) => p);
check(`no file weighs more than ${CAP_BYTES / 1000} KB`, heavy.length === 0, heavy.slice(0, 8).join(", "));
const undated = [...texts].filter(([, t]) => !t.startsWith("# GeoNames") || !t.slice(0, t.indexOf("\n")).includes(index.made) || !t.slice(0, t.indexOf("\n")).includes("CC BY 4.0")).map(([p]) => p);
check("every file's first line names GeoNames, its license and the snapshot's day", undated.length === 0, undated.slice(0, 8).join(", "));

// The files the index promises are the files there are.
const promised = new Set([...index.first]);
for (const [p, next] of Object.entries(index.split)) for (const ch of next) promised.add(p + ch);
check("the files the index promises are exactly the files on the disk", promised.size === texts.size && [...promised].every((p) => texts.has(p)),
  `${promised.size} promised, ${texts.size} on the disk; e.g. ${[...promised].filter((p) => !texts.has(p)).slice(0, 4)} / ${[...texts.keys()].filter((p) => !promised.has(p)).slice(0, 4)}`);

// Every line is a town, and every town is found from each of its names.
const lineSets = new Map([...texts].map(([p, t]) => [p, new Set(t.split("\n"))]));
const seen = new Set();
let badLines = 0, lost = 0, names = 0;
const lostEg = [], badEg = [];
for (const [, t] of texts) {
  for (const line of t.split("\n")) {
    if (!line || line[0] === "#" || seen.has(line)) continue;
    seen.add(line);
    const c = line.split("|");
    const z = parseInt(c[3], 36), lat = parseInt(c[4], 36) / 100, lng = parseInt(c[5], 36) / 100, people = parseInt(c[6], 36) * 100;
    if (c.length < 7 || c.length > 8 || !c[0] || !index.countries[c[1]] || !(z >= 0 && z < index.zones.length) || !(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180) || !(people >= 0)) {
      badLines++; if (badEg.length < 4) badEg.push(line.slice(0, 80)); continue;
    }
    const keys = new Set([squash(c[0]), ...(c[7] ? c[7].split(";").map(squash) : []), ...(people >= 100000 ? laterWords(c[0]) : [])]);
    for (const k of keys) {
      if (!k) continue;
      names++;
      const p = fileFor(index, k);
      if (!p || !lineSets.get(p).has(line)) { lost++; if (lostEg.length < 4) lostEg.push(`${c[0]} by "${k}" (file "${p}")`); }
    }
  }
}
check("the table says how many towns it holds, and holds them", seen.size === index.towns && index.towns > 150000, `${seen.size} lines, the index says ${index.towns}`);
check("every line reads as a town: a name, a country the index knows, a zone, a position, a size", badLines === 0, `${badLines}, e.g. ${badEg.join(" / ")}`);
check(`every town is in the file the picker asks for, from every one of its names (${names} names)`, lost === 0, `${lost} not found, e.g. ${lostEg.join("; ")}`);

// A split file: the towns named exactly its letters, and the largest of the rest.
const splitHeads = Object.keys(index.split).filter((p) => texts.get(p).split("\n").filter((l) => l && l[0] !== "#").length < HEAD_ROWS);
check(`a file that was split still holds ${HEAD_ROWS} towns or more (its largest), so a few letters typed show the towns people mean`, splitHeads.length === 0, splitHeads.slice(0, 6).join(", "));

// ── 2. what is typed finds the place ────────────────────────────────────────────────────
let asked = [];
const disk = async (name) => {
  asked.push(name);
  const f = path.join(DIR, name);
  if (!fs.existsSync(f)) return { ok: false, status: 404 };
  const text = fs.readFileSync(f, "utf8");
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};
const source = townSource({ base: "", fetcher: disk });
const ZONES = [...new Set([...Intl.supportedValuesOf("timeZone"), "UTC"])];
const find = async (typed) => (await findTowns(source, typed, { zones: ZONES })).rows;
const inBox = (box, lat, lng) => lat >= box.south && lat <= box.north && lng >= box.west && lng <= box.east;
const shownEverywhere = [];          // every label and time this check sees, for part 3

/** The first row for what was typed: its label, zone, and (a town) the center of its box within a few km of `at`. */
async function first(typed, { label, zone, at, kind = "city", town }) {
  const rows = await find(typed);
  for (const r of rows) shownEverywhere.push(`${rowLabel(r)} · ${rowWhere(r)}`);
  const r = rows[0];
  if (!r) { check(`"${typed}" finds ${label}`, false, "nothing found"); return null; }
  const box = r.kind === "city" ? boxFor(r) : null;
  const mid = box ? [(box.south + box.north) / 2, (box.west + box.east) / 2] : null;
  const near = !at || (mid && Math.abs(mid[0] - at[0]) < 0.05 && Math.abs(mid[1] - at[1]) < 0.05);
  check(`"${typed}" finds ${label}, ${zone}${at ? `, its box around ${at.join(", ")}` : ", a zone and no position"}`,
    r.kind === kind && rowLabel(r) === label && r.zone === zone && near && (!town || r.town === town) && (kind === "city" || (r.lat == null && r.lng == null)),
    JSON.stringify({ label: rowLabel(r), kind: r.kind, town: r.town, zone: r.zone, mid }));
  return r;
}

const kyoto = await first("Kyoto", { label: "Kyoto, Japan", zone: "Asia/Tokyo", at: [35.02, 135.75] });
await first("kyoto", { label: "Kyoto, Japan", zone: "Asia/Tokyo", at: [35.02, 135.75] });
await first("Kioto", { label: "Kioto, Japan", zone: "Asia/Tokyo", at: [35.02, 135.75], town: "Kyoto" });
await first("Firenze", { label: "Firenze, Italy", zone: "Europe/Rome", at: [43.78, 11.25], town: "Florence" });
await first("Florence", { label: "Florence, Italy", zone: "Europe/Rome", at: [43.78, 11.25] });
await first("Lisboa", { label: "Lisboa, Portugal", zone: "Europe/Lisbon", at: [38.73, -9.15], town: "Lisbon" });
const cusco = await first("Cusco", { label: "Cusco, Peru", zone: "America/Lima", at: [-13.53, -71.97] });
await first("Cuzco", { label: "Cuzco, Peru", zone: "America/Lima", at: [-13.53, -71.97], town: "Cusco" });
await first("Machu Picchu", { label: "Machu Picchu, Peru", zone: "America/Lima", at: [-13.16, -72.52], town: "Machupicchu" });
await first("machu p", { label: "Machu Picchu, Peru", zone: "America/Lima", at: [-13.16, -72.52], town: "Machupicchu" });
// A name that is also a zone's: the town's row says it, by the name typed, and the zone's own row
// ("New York, United States", from America/New_York) doesn't stand beside it to read the same.
await first("new york", { label: "New York, United States", zone: "America/New_York", at: [40.71, -74.01], town: "New York City" });
await first("Machupicchu", { label: "Machupicchu, Peru", zone: "America/Lima", at: [-13.16, -72.52] });
await first("Thira", { label: "Thíra, Greece", zone: "Europe/Athens", at: [36.42, 25.43], town: "Firá" });
await first("Fira", { label: "Firá, Greece", zone: "Europe/Athens", at: [36.42, 25.43] });
await first("Hallstatt", { label: "Hallstatt, Austria", zone: "Europe/Vienna", at: [47.56, 13.65] });
await first("Vík", { label: "Vík, Iceland", zone: "Atlantic/Reykjavik", at: [63.42, -19.01], town: "Vík í Mýrdal" });
await first("Dubrovnik", { label: "Dubrovnik, Croatia", zone: "Europe/Zagreb", at: [42.64, 18.11] });
await first("Zermatt", { label: "Zermatt, Switzerland", zone: "Europe/Zurich", at: [46.02, 7.75] });
const porto = await first("Porto", { label: "Porto, Portugal", zone: "Europe/Lisbon", at: [41.15, -8.61] });
await first("São Paulo", { label: "São Paulo, Brazil", zone: "America/Sao_Paulo", at: [-23.55, -46.64] });
await first("sao paulo", { label: "São Paulo, Brazil", zone: "America/Sao_Paulo", at: [-23.55, -46.64] });
await first("Seville", { label: "Seville, Spain", zone: "Europe/Madrid", at: [37.38, -5.97], town: "Sevilla" });
await first("lis", { label: "Lisbon, Portugal", zone: "Europe/Lisbon", at: [38.73, -9.15] });
await first("Lima", { label: "Lima, Peru", zone: "America/Lima", at: [-12.04, -77.03] });
await first("Singapore", { label: "Singapore", zone: "Asia/Singapore", at: [1.29, 103.85] });
await first("Japan", { label: "Japan", zone: "Asia/Tokyo", kind: "country" });
await first("japan", { label: "Japan", zone: "Asia/Tokyo", kind: "country" });
await first("Peru", { label: "Peru", zone: "America/Lima", kind: "country" });
await first("Azores", { label: "Azores, Portugal", zone: "Atlantic/Azores", kind: "zone" });
await first("utc", { label: "UTC", zone: "UTC", kind: "zone" });

{
  const rows = await find("Springfield");
  const labels = rows.map(rowLabel);
  check("Springfield: several, each told apart by its state", rows.length >= 5 && new Set(labels).size === labels.length
    && labels.includes("Springfield, Missouri, United States") && labels.includes("Springfield, Illinois, United States") && labels.includes("Springfield, Massachusetts, United States"), labels.join(" | "));
  check("…and in different zones: Illinois' is Chicago's, Massachusetts' is New York's",
    rows.find((r) => r.region === "Illinois")?.zone === "America/Chicago" && rows.find((r) => r.region === "Massachusetts")?.zone === "America/New_York");
}
{
  const rows = await find("Paris");
  check("Paris: France first, then Texas", rowLabel(rows[0]) === "Paris, France" && rows[0].zone === "Europe/Paris" && rowLabel(rows[1]) === "Paris, Texas, United States", rows.slice(0, 3).map(rowLabel).join(" | "));
}
{
  // A town found by another of its names is shown by the name that was typed, unless that makes
  // it read exactly like another row: then it says its own.
  const rows = await find("Porto");
  const labels = rows.map(rowLabel);
  check("Porto: no two rows read the same (a town found as \"Porto\" beside Italy's Porto says its own name)", new Set(labels).size === labels.length && labels[0] === "Porto, Portugal", labels.join(" | "));
}
{
  // What one more town costs the map of the others, from the server's plan. Depths never show.
  const plan = (regions) => ({ regions, left_out: [], lowered: [], bytes: { now: 1, would: 2 }, max_depth: 15 });
  check("the plan: nothing lost says nothing", planWords(plan([{ id: "kyoto", name: "Kyoto", now: 15, would: 15 }, { id: null, name: "Nara", now: null, would: 15 }]), "Nara") === "");
  check("the plan: a level lost by one town is a sentence naming it",
    planWords(plan([{ id: "kyoto", name: "Kyoto", now: 15, would: 14 }, { id: null, name: "Nara", now: null, would: 14 }]), "Nara")
      === "The whole trip's map has to fit on a phone: with Nara added, Kyoto loses a level of street detail.");
  const three = planWords(plan([{ id: "a", name: "Kyoto", now: 15, would: 13 }, { id: "b", name: "Osaka", now: 14, would: 13 }, { id: "c", name: "Kobe", now: 14, would: null }, { id: null, name: "Tokyo", now: null, would: 12 }]), "Tokyo");
  check("the plan: several towns, different losses, one left off, and the new one short of every street",
    three === "The whole trip's map has to fit on a phone: with Tokyo added, Kyoto and Osaka lose up to 2 levels of street detail. Kobe would be left off the map to make room. Tokyo's own map would show less than every street.", three);
  check("the plan: the new town itself left out is said", /^Nara is too large to fit beside the rest/.test(planWords(plan([{ id: "kyoto", name: "Kyoto", now: 15, would: 15 }, { id: null, name: "Nara", now: null, would: null }]), "Nara")));
  check("the plan: no number of a depth is ever in the words", !/\b1[0-5]\b/.test(three));
  check("the plan: an answer that can't be read says nothing", planWords(null, "Nara") === "" && planWords({ error: "maps off" }, "Nara") === "");
  const kyoto = (await find("Kyoto"))[0];
  check("an area's width read back from its bounds is the box it was given", areaAcrossKm(areaOf(kyoto)) === acrossKm(kyoto), `${areaAcrossKm(areaOf(kyoto))} / ${acrossKm(kyoto)}`);
}
{
  const rows = await find("Australia");
  const zs = rows.filter((r) => r.kind === "country");
  check("Australia: a country of several zones lists them, and each row says which", zs.length >= 4 && zs[0].zone === "Australia/Sydney" && /^Sydney time, GMT\+1[01]$/.test(rowWhere(zs[0])), zs.map((r) => `${rowLabel(r)} · ${rowWhere(r)}`).join(" | "));
}
{
  const rows = await find("united s");
  check(`"united s": the United States before its outlying islands`, rows[0] && rows[0].kind === "country" && rows[0].name === "United States", rows.map(rowLabel).join(" | "));
}
{
  const rows = await find("york");
  check(`"york": York, and New York by its later word`, rowLabel(rows[0]) === "York, United Kingdom" && (await find("new york")).some((r) => r.town === "New York City"), rows.map(rowLabel).join(" | "));
}
{
  // What no list of towns has. The picker offers a map link under every list, and alone here.
  const bali = await find("Bali");
  const called = bali.filter((r) => squash(r.name) === "bali");
  check(`"Bali" finds towns CALLED Bali and none of them in Indonesia: the island is not a town (the map link is for it)`, called.length >= 3 && called.every((r) => r.kind === "city" && r.cc !== "ID"), bali.map(rowLabel).join(" | "));
  check(`"Santorini" finds nothing`, (await find("Santorini")).length === 0, (await find("Santorini")).map(rowLabel).join(" | "));
  check(`"Amalfi Coast" finds nothing`, (await find("Amalfi Coast")).length === 0, (await find("Amalfi Coast")).map(rowLabel).join(" | "));
  check("a town that isn't in the table finds nothing", (await find("zzzq")).length === 0 && (await find("Xqwv Blorf")).length === 0);
  check("nothing typed finds nothing", (await find("")).length === 0 && (await find("  ")).length === 0 && (await find("…")).length === 0);
}
check("one letter typed already offers that letter's largest towns", (await find("k")).length === 8 && (await find("k")).every((r) => r.kind === "city" && r.people > 1000000), (await find("k")).map(rowLabel).join(" | "));
check("eight rows at most", (await find("san")).length === 8 && (await findTowns(source, "san", { limit: 3, zones: ZONES })).rows.length === 3);

// ── 3. no region word of the zone database ──────────────────────────────────────────────
for (const typed of ["lima", "new york", "buenos", "indiana", "kolkata", "st johns", "port of", "argentina", "tokyo", "mexico"]) for (const r of await find(typed)) shownEverywhere.push(`${rowLabel(r)} · ${rowWhere(r)}`);
const regionWord = shownEverywhere.filter((s) => /(^|[ ·,])(America|Europe|Asia|Africa|Pacific|Atlantic|Indian|Antarctica|Arctic|Australia|Etc)( \/|$| ·)/.test(s) && !/^(Australia|South Africa|Central African Republic|American Samoa) ·/.test(s) && !/, (Australia|South Africa|Central African Republic|American Samoa) ·/.test(s));
check(`nothing shown carries the zone database's region word (${shownEverywhere.length} rows read)`, regionWord.length === 0 && shownEverywhere.every((s) => !s.includes("/") || /GMT|UTC/.test(s) && !/[A-Za-z]\/[A-Z]/.test(s)), regionWord.slice(0, 6).join(" | "));
const idx = await source.index();
check(`a stored zone is said as a place with its country: "Tokyo, Japan", "Buenos Aires, Argentina", "UTC"`,
  zonePlace(idx, "Asia/Tokyo") === "Tokyo, Japan" && zonePlace(idx, "America/Argentina/Buenos_Aires") === "Buenos Aires, Argentina" && zonePlace(idx, "UTC") === "UTC" && zonePlace(null, "America/Lima") === "Lima",
  [zonePlace(idx, "Asia/Tokyo"), zonePlace(idx, "America/Argentina/Buenos_Aires"), zonePlace(idx, "UTC")].join(" | "));
check(`a zone said as a time: "Tokyo time, GMT+9"`, zoneWords("Asia/Tokyo", new Date("2027-01-15T12:00:00Z")) === "Tokyo time, GMT+9" && zoneWords("America/Lima", new Date("2027-01-15T12:00:00Z")) === "Lima time, GMT-5" && zoneWords("UTC") === "UTC");

// ── 4. the box ──────────────────────────────────────────────────────────────────────────
const halfKm = (box) => ((box.north - box.south) / 2) * 110.574;
check("a town of 800 people gets 12 km to each side", Math.abs(halfKm(boxFor({ lat: 47.56, lng: 13.65, people: 800 })) - 12) < 0.05);
check("so does a city of 100,000", Math.abs(halfKm(boxFor({ lat: 40, lng: 0, people: 100000 })) - 12) < 0.05);
check("a city of a million gets 20 km, and one of ten million no more", Math.abs(halfKm(boxFor({ lat: 40, lng: 0, people: 1000000 })) - 20) < 0.05 && Math.abs(halfKm(boxFor({ lat: 40, lng: 0, people: 10000000 })) - 20) < 0.05);
check("in between it grows with the size: 316,000 people get 16 km", Math.abs(halfKm(boxFor({ lat: 40, lng: 0, people: 316228 })) - 16) < 0.05);
{
  const b = boxFor({ lat: 60, lng: 10, people: 1000 });
  const wideKm = ((b.east - b.west) / 2) * 111.32 * Math.cos((60 * Math.PI) / 180);
  check("the box is as wide on the ground as it is tall, far from the equator too", Math.abs(wideKm - 12) < 0.1, String(wideKm));
  const d = boxFor({ lat: -17, lng: 179.95, people: 1000 });
  check("a box across the 180° line has its west greater than its east", d.west > d.east && d.west > 179 && d.east < -179, JSON.stringify(d));
}
if (kyoto) check("Kyoto's box holds its station, Gion, Arashiyama and Fushimi Inari", [[34.9858, 135.7588], [35.0037, 135.7751], [35.0094, 135.6668], [34.9671, 135.7727]].every(([la, ln]) => inBox(boxFor(kyoto), la, ln)), JSON.stringify(boxFor(kyoto)));
if (cusco) check("Cusco's box holds the Plaza de Armas, San Pedro station and the airport", [[-13.5167, -71.9788], [-13.5226, -71.9836], [-13.5357, -71.9388]].every(([la, ln]) => inBox(boxFor(cusco), la, ln)), JSON.stringify(boxFor(cusco)));
if (porto) check("Porto's box holds São Bento, the Ribeira and the airport", [[41.1456, -8.6107], [41.1406, -8.6130], [41.2421, -8.6786]].every(([la, ln]) => inBox(boxFor(porto), la, ln)), JSON.stringify(boxFor(porto)));
check("an area's id is the name in the letters an id takes, numbered when taken", areaIdFor("São Paulo") === "sao-paulo" && areaIdFor("Kyoto", ["kyoto"]) === "kyoto-2" && areaIdFor("Kyoto", ["kyoto", "kyoto-2"]) === "kyoto-3" && areaIdFor("…") === "area" && /^[a-z0-9-]+$/.test(areaIdFor("St. John's")));

// ── 4b. the area a picked row gives a trip, and a spot that is no town ───────────────────
if (kyoto) {
  const a = areaOf(kyoto, []);
  check("Kyoto picked gives the trip an area: its id, its name, the four edges of its box", a && a.id === "kyoto" && a.name === "Kyoto" && inBox(a, 34.9858, 135.7588) && Object.keys(a).sort().join() === "east,id,name,north,south,west", JSON.stringify(a));
  check("…and a sentence that says so, with how far across", placeWords(kyoto) === `The trip's map is made around Kyoto, ${acrossKm(kyoto)} km across. More can be added later.` && acrossKm(kyoto) === 40, placeWords(kyoto));
  check("a second Kyoto on the same trip gets another id", areaOf(kyoto, ["kyoto"]).id === "kyoto-2");
}
{
  const japan = (await find("Japan"))[0];
  check("a country gives no area, and its sentence asks for a town", areaOf(japan) === null && areaOf(null) === null && /^Japan sets the time zone\. Name a town/.test(placeWords(japan)), placeWords(japan));
  const spot = { kind: "spot", name: "Bali", lat: -8.5069, lng: 115.2625, people: 0, zone: "Asia/Makassar" };
  const a = areaOf(spot);
  check("a spot from a map link gives an area with the name that was typed, 24 km across", a && a.id === "bali" && a.name === "Bali" && acrossKm(spot) === 24 && inBox(a, -8.5069, 115.2625), JSON.stringify(a));
  const near = async (lat, lng) => { const z = await zoneNear(source, lat, lng); return z ? z.zone : null; };
  check("the zone at a spot is the one its nearest towns keep: Ubud, Oia, the Amalfi coast, the Grand Canyon",
    (await near(-8.5069, 115.2625)) === "Asia/Makassar" && (await near(36.4618, 25.3753)) === "Europe/Athens" && (await near(40.634, 14.6027)) === "Europe/Rome" && (await near(36.1069, -112.1129)) === "America/Phoenix",
    [await near(-8.5069, 115.2625), await near(36.4618, 25.3753), await near(40.634, 14.6027), await near(36.1069, -112.1129)].join(" | "));
  check("a park a square or two from any town still finds its zone (Uluru)", (await near(-25.3444, 131.0369)) === "Australia/Darwin", String(await near(-25.3444, 131.0369)));
  check("the open sea has none: the zone is left as it was", (await near(0.5, -150.5)) === null);
  const nearText = fs.readFileSync(path.join(DIR, "near.txt"), "utf8");
  const license = fs.existsSync(path.join(DIR, "LICENSE.txt")) ? fs.readFileSync(path.join(DIR, "LICENSE.txt"), "utf8") : "";
  check("the folder carries its license: GeoNames, CC BY 4.0, the snapshot's day and what was changed",
    /GeoNames/.test(license) && /Attribution 4\.0/.test(license) && license.includes(`Snapshot of ${index.made}`) && /What was changed/.test(license), license.slice(0, 80));
  check("near.txt's first line names GeoNames, its license and the snapshot's day", nearText.startsWith("# GeoNames") && nearText.slice(0, nearText.indexOf("\n")).includes(index.made) && nearText.slice(0, nearText.indexOf("\n")).includes("CC BY 4.0"));
}

// ── 5. out of reach; and nothing asked for twice ────────────────────────────────────────
{
  asked = [];
  const again = townSource({ base: "", fetcher: disk });
  await findTowns(again, "Kyoto", { zones: ZONES });
  await findTowns(again, "kyot", { zones: ZONES });
  await findTowns(again, "Kyoto", { zones: ZONES });
  check("typing on within the same letters reads no file twice", asked.length === 2 && asked[0] === "index.json" && asked[1] === fileName(fileFor(idx, "kyoto")), asked.join(" "));
  let tries = 0;
  const none = townSource({ base: "", fetcher: async () => { tries++; throw new TypeError("Failed to fetch"); } });
  const out = await findTowns(none, "tokyo", { zones: ZONES });
  check("with the table out of reach the answer says so, and still finds a zone by its name", out.reached === false && out.rows.length >= 1 && out.rows[0].kind === "zone" && out.rows[0].zone === "Asia/Tokyo" && rowLabel(out.rows[0]) === "Tokyo", JSON.stringify(out.rows.slice(0, 2)));
  const before = tries;
  await findTowns(none, "tokyo", { zones: ZONES });
  check("…and asks again the next time (the signal may be back)", tries > before);
  let n = 0;
  const half = townSource({ base: "", fetcher: async (name) => { n++; if (name !== "index.json") throw new TypeError("Failed to fetch"); return disk(name); } });
  const part = await findTowns(half, "japan", { zones: ZONES });
  check("with only the index kept, a country is still found, and the answer says the towns were not", part.reached === false && part.rows[0] && part.rows[0].kind === "country" && part.rows[0].zone === "Asia/Tokyo", JSON.stringify(part.rows.slice(0, 2)));
  check("zones by name alone: \"new y\" is New York", zoneRows("new y", ZONES)[0]?.zone === "America/New_York" && zoneRows("", ZONES).length === 0);
}
check("names are compared without marks, capitals, spaces or punctuation", fold("  São   PAULO ") === "sao paulo" && squash("Machu Picchu") === "machupicchu" && squash("St. John’s") === "stjohns" && squash("Køge") === "koge" && squash("Łódź") === "lodz" && squash("Weißenburg") === "weissenburg");

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log("FAILED:\n  " + failures.join("\n  ")); process.exit(1); }

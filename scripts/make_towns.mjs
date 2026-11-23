#!/usr/bin/env node
/* Makes public/towns/: the towns a trip can say it goes to, each with its country, region,
 * time zone, position and size, from GeoNames' files (https://www.geonames.org/, CC BY 4.0).
 *
 * DON'T RUN THIS CASUALLY. What it writes is about ten megabytes in some 2,500 files, and
 * every run that changes them adds that much to the repository's history for good. It was run
 * once, from one dated snapshot. Run it again only to take a newer snapshot on purpose, and
 * say the new date in the commit.
 *
 *   node scripts/make_towns.mjs <folder of GeoNames files> --date <YYYY-MM-DD, the day they were downloaded>
 *        [--out <folder>]   default public/towns
 *        [--measure]        write nothing; print what it would write
 *
 * THE FOLDER holds five files from https://download.geonames.org/export/dump/ (the two zips
 * unzipped): cities500.txt, alternateNamesV2.txt, countryInfo.txt, timeZones.txt,
 * admin1CodesASCII.txt. They are GeoNames' and large, and are not in the repository. What is
 * committed is this script and what it made.
 *
 * WHAT IS KEPT
 *   - every town of 500 people or more, and every capital, that has a time zone this Node knows;
 *   - a town's OTHER NAMES, cut down to what a person types in Latin letters:
 *       names GeoNames tags with a language (any language), written in Latin letters;
 *       names it gives with no language, when they are a letter or two away from a name
 *       already kept ("Machu Piccho" beside Machupicchu, "Thira" beside Thera);
 *       never a link, a postal code, an airport's code, or a name that only adds words to the
 *       town's own ("Kota Denpasar": typing Denpasar finds it already);
 *   - a town's region (GeoNames' first-level division: a state, a prefecture) when another
 *     town of that name is in the same country, so two Springfields can be told apart;
 *   - each country's English name and its time zones, the zone of its largest town first;
 *     the countries in the order of their people, the most first.
 *
 * NAMES IN OTHER SCRIPTS WERE LEFT OUT. The app is in English and the picker compares Latin
 * letters. Measured on the snapshot of 2026-11-15, keeping every tagged name in every script
 * came to 428,252 other names in 19,553 files, 80.6 MB as these files are laid out (against
 * about 100,000 names, 2,500 files and 10 MB). Whoever translates the app: that is the cost
 * to weigh, and a smaller cut (the app's own languages) is the place to start.
 *
 * THE FILES (docs/CONTRACTS.md, "A town says where a trip is")
 *   index.json   { made, source, towns, first: "the first letters that have a file",
 *                  zones: [zone id…], countries: { CC: [name, [zone…]] },
 *                  split: { letters: "the next letters that have a file" } }
 *   near.txt     for a spot that is no town (a pasted map link): "square:zone" pairs, both in
 *                base 36. A square is one degree each way, numbered (lat + 90) * 360 + (lng + 180)
 *                from their whole parts; its zone is the one most of its towns' people keep.
 *   t-<letters>.txt  one file for each run of first letters, named by them (a name is compared
 *                with its marks, capitals, spaces and punctuation taken out: "saopaulo").
 *                A file holds every town with a name that starts with its letters, largest
 *                first, unless that would pass 48 KB: then the letters are split one further
 *                (index.json's `split` says which), and the file holds the towns named exactly
 *                its letters and the 40 largest of the rest.
 *                First line: "# " and the source and date. Then one town a line:
 *                  name|CC|region|zone|lat|lng|people|other;names
 *                zone: its place in index.json's zones; lat, lng: hundredths of a degree;
 *                people: hundreds. All four are whole numbers in base 36 ("-" before a negative).
 *                A town of 100,000 or more is also filed under each later word of its name
 *                ("york" finds New York); the picker works those words out the same way.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { fold, squash, laterWords, fileName, cellOf, CAP_BYTES, HEAD_ROWS } from "../public/js/city-search.js";

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv.splice(i, 2)[1]; };
const MEASURE = argv.includes("--measure") && !!argv.splice(argv.indexOf("--measure"), 1);
const DATE = flag("--date", "");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(flag("--out", path.join(REPO, "public/towns")));
const RAW = argv[0];
if (!RAW || !/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error("usage: node scripts/make_towns.mjs <folder of GeoNames files> --date <YYYY-MM-DD> [--out <folder>] [--measure]\n"
    + "Read the top of this file first: what it writes is large, and it is not for running casually.");
  process.exit(2);
}
const file = (name) => {
  const f = path.join(RAW, name);
  if (!fs.existsSync(f)) { console.error(`${f} is not there. It comes from https://download.geonames.org/export/dump/ (cities500 and alternateNamesV2 come zipped).`); process.exit(2); }
  return f;
};
const lines = (name) => fs.readFileSync(file(name), "utf8").split(/\r?\n/);

const validZone = (() => { const seen = new Map(); return (z) => { if (!seen.has(z)) { let ok = true; try { new Intl.DateTimeFormat("en-US", { timeZone: z }); } catch { ok = false; } seen.set(z, ok); } return seen.get(z); }; })();
const n36 = (n) => Math.round(n).toString(36);
// A name fit for a line of the table and for typing: Latin letters once folded, three or more.
const LATIN = /^[a-z][a-z0-9 .'-]{2,}$/;
const fitsLine = (s) => !/[|;\n\r\t#]/.test(s);
// GeoNames' "languages" that are not languages.
const NOT_NAMES = new Set(["link", "post", "iata", "icao", "faac", "unlc", "wkdt", "abbr", "phon", "piny", "tcid"]);

/** Within one letter of each other for a short name, two for a long one. */
function near(a, b) {
  const lim = Math.max(a.length, b.length) < 8 ? 1 : 2;
  if (Math.abs(a.length - b.length) > lim) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < least) least = v;
    }
    if (least > lim) return false;
    prev = cur;
  }
  return prev[b.length] <= lim;
}

// ── the source ──────────────────────────────────────────────────────────────────────────
const countryName = new Map();      // CC -> English name
const countryPeople = new Map();    // CC -> how many people (the order countries are offered in)
for (const line of lines("countryInfo.txt")) {
  if (!line || line.startsWith("#")) continue;
  const c = line.split("\t");
  if (c[0] && c[4]) { countryName.set(c[0], c[4]); countryPeople.set(c[0], Number(c[7]) || 0); }
}
const zoneCountry = new Map();      // zone id -> CC
for (const line of lines("timeZones.txt").slice(1)) {
  const c = line.split("\t");
  if (c[0] && c[1] && validZone(c[1])) zoneCountry.set(c[1], c[0]);
}
const regionName = new Map();       // "CC.code" -> the region's name
for (const line of lines("admin1CodesASCII.txt")) {
  const c = line.split("\t");
  if (c[0] && c[1]) regionName.set(c[0], c[1]);
}
const towns = [];
const byId = new Map();
let unnamed = 0;
for (const line of lines("cities500.txt")) {
  if (!line) continue;
  const c = line.split("\t");
  const t = { id: c[0], name: c[1], lat: Number(c[4]), lng: Number(c[5]), code: c[7], cc: c[8], a1: c[10], people: Number(c[14]) || 0, zone: c[17], named: [] };
  if (t.people < 500 && t.code !== "PPLC") continue;
  if (!t.name || !fitsLine(t.name) || !countryName.has(t.cc) || !t.zone || !validZone(t.zone)) continue;
  if (!Number.isFinite(t.lat) || !Number.isFinite(t.lng) || Math.abs(t.lat) > 90 || Math.abs(t.lng) > 180) continue;
  if (!squash(t.name)) { unnamed++; continue; }      // a name with no Latin letter in it: nothing to type
  towns.push(t);
  byId.set(t.id, t);
}
// alternateNamesV2.txt: alternateNameId, geonameid, isolanguage, alternate name, … It is
// hundreds of megabytes, so it is read a line at a time and only the towns' rows are kept.
for await (const line of readline.createInterface({ input: fs.createReadStream(file("alternateNamesV2.txt"), "utf8"), crlfDelay: Infinity })) {
  const c = line.split("\t");
  const t = byId.get(c[1]);
  if (!t || !c[3] || NOT_NAMES.has(c[2]) || !/^[a-z]{0,3}$/.test(c[2])) continue;
  t.named.push([c[2], c[3]]);
}
towns.sort((a, b) => b.people - a.people || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || Number(a.id) - Number(b.id));

function otherNames(t) {
  const own = fold(t.name);
  const had = new Set([own]);
  const out = [];
  for (const [lang, n] of t.named) {
    if (!lang || !fitsLine(n)) continue;
    const f = fold(n);
    if (!LATIN.test(f) || had.has(f) || f.includes(own)) continue;
    had.add(f); out.push(n);
  }
  const known = [squash(t.name), ...out.map(squash)];
  for (const [lang, n] of t.named) {
    if (lang || !fitsLine(n)) continue;
    const f = fold(n);
    if (!LATIN.test(f) || had.has(f) || f.includes(own)) continue;
    const s = squash(n);
    if (known.some((k) => s === k || near(s, k))) { had.add(f); out.push(n); }
  }
  return out;
}

// ── the table ───────────────────────────────────────────────────────────────────────────
const zones = [...new Set([...zoneCountry.keys(), ...towns.map((t) => t.zone)])].sort();
const zoneAt = new Map(zones.map((z, i) => [z, i]));
const sameName = new Map();         // "name|CC" -> how many towns
for (const t of towns) { const k = `${fold(t.name)}|${t.cc}`; sameName.set(k, (sameName.get(k) || 0) + 1); }

// A country's zones: the ones the source gives the country, the zone of its largest town
// first (the towns are largest first). A zone a few of its towns keep that is another
// country's (a base abroad) is not the country's. A country the source gives no zone has the
// zones its towns are in.
const ownZones = new Map();         // CC -> Set of zone ids the source gives it
for (const [zone, cc] of zoneCountry) { if (!ownZones.has(cc)) ownZones.set(cc, new Set()); ownZones.get(cc).add(zone); }
const countryZones = new Map();
for (const t of towns) {
  const own = ownZones.get(t.cc);
  if (own && !own.has(t.zone)) continue;
  let list = countryZones.get(t.cc);
  if (!list) countryZones.set(t.cc, (list = []));
  const z = zoneAt.get(t.zone);
  if (!list.includes(z)) list.push(z);
}
for (const [zone, cc] of zoneCountry) {
  if (!countryName.has(cc)) continue;
  let list = countryZones.get(cc);
  if (!list) countryZones.set(cc, (list = []));
  const z = zoneAt.get(zone);
  if (!list.includes(z)) list.push(z);
}

const entries = [];                 // [key, line], largest town first
const written = new Set();          // the source has a few towns twice over, word for word: once is enough
let others = 0;
for (const t of towns) {
  const alts = otherNames(t);
  const region = sameName.get(`${fold(t.name)}|${t.cc}`) > 1 ? (regionName.get(`${t.cc}.${t.a1}`) || "") : "";
  const line = [t.name, t.cc, fitsLine(region) ? region : "", n36(zoneAt.get(t.zone)), n36(t.lat * 100), n36(t.lng * 100), n36(t.people / 100)].join("|")
    + (alts.length ? `|${alts.join(";")}` : "");
  if (written.has(line)) continue;
  written.add(line);
  const keys = new Set([squash(t.name), ...alts.map(squash), ...(t.people >= 100000 ? laterWords(t.name) : [])]);
  others += alts.length;
  for (const k of keys) if (k) entries.push([k, line]);
}

const HEADER = `# GeoNames (geonames.org), CC BY 4.0, snapshot of ${DATE}. Made by scripts/make_towns.mjs: don't edit by hand.`;
const files = new Map();            // prefix -> text
const split = {};                   // prefix -> the next letters that have a file
const bytes = (s) => Buffer.byteLength(s);
function node(prefix, items) {
  const uniq = [...new Set(items.map((e) => e[1]))];
  const whole = `${HEADER}\n${uniq.join("\n")}\n`;
  if (bytes(whole) <= CAP_BYTES || prefix.length >= 12) { files.set(prefix, whole); return; }
  const exact = items.filter((e) => e[0] === prefix).map((e) => e[1]);
  files.set(prefix, `${HEADER}\n${[...new Set([...exact, ...uniq.slice(0, HEAD_ROWS)])].join("\n")}\n`);
  const kids = new Map();
  for (const e of items) {
    if (e[0].length <= prefix.length) continue;
    const p = e[0].slice(0, prefix.length + 1);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(e);
  }
  split[prefix] = [...kids.keys()].map((p) => p.at(-1)).sort().join("");
  for (const [p, its] of kids) node(p, its);
}
const top = new Map();
for (const e of entries) { const p = e[0][0]; if (!top.has(p)) top.set(p, []); top.get(p).push(e); }
for (const [p, its] of top) node(p, its);

// near.txt: for a spot that is no town (a pasted map link), the zone most people keep in its
// one-degree square of the planet.
const cellZones = new Map();        // cell -> Map(zone index -> people)
for (const t of towns) {
  const cell = cellOf(t.lat, t.lng);
  if (!cellZones.has(cell)) cellZones.set(cell, new Map());
  const m = cellZones.get(cell), z = zoneAt.get(t.zone);
  m.set(z, (m.get(z) || 0) + Math.max(1, t.people));
}
const pairs = [...cellZones.keys()].sort((a, b) => a - b).map((cell) => `${cell.toString(36)}:${[...cellZones.get(cell)].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0].toString(36)}`);
const nearLines = [];
for (let i = 0; i < pairs.length; i += 400) nearLines.push(pairs.slice(i, i + 400).join(","));
const nearText = `${HEADER}\n${nearLines.join("\n")}\n`;

const index = {
  made: DATE,
  source: "GeoNames (https://www.geonames.org/), CC BY 4.0",
  towns: written.size,
  first: [...top.keys()].sort().join(""),
  zones,
  // The most people first: typing "united s" offers the United States before its outlying islands.
  countries: Object.fromEntries([...countryZones.keys()].sort((a, b) => countryPeople.get(b) - countryPeople.get(a) || (a < b ? -1 : 1)).map((cc) => [cc, [countryName.get(cc), countryZones.get(cc)]])),
  split: Object.fromEntries(Object.keys(split).sort().map((k) => [k, split[k]])),
};
const indexText = JSON.stringify(index) + "\n";

let total = bytes(indexText) + bytes(nearText), gz = zlib.gzipSync(indexText, { level: 9 }).length + zlib.gzipSync(nearText, { level: 9 }).length, biggest = ["", 0], over = 0, deepest = 0;
for (const [p, text] of files) {
  const b = bytes(text);
  total += b; gz += zlib.gzipSync(text, { level: 9 }).length;
  if (b > biggest[1]) biggest = [p, b];
  if (b > CAP_BYTES) over++;
  if (p.length > deepest) deepest = p.length;
}
console.log(`${written.size} towns (${unnamed} left out: no Latin letter in the name), ${others} other names, ${zones.length} zones, ${Object.keys(index.countries).length} countries`);
console.log(`${files.size} files, index.json (${(bytes(indexText) / 1024).toFixed(0)} KB) and near.txt (${(bytes(nearText) / 1024).toFixed(0)} KB, ${pairs.length} squares): ${(total / 1e6).toFixed(1)} MB, ${(gz / 1e6).toFixed(1)} MB gzip; the biggest is ${fileName(biggest[0])} at ${(biggest[1] / 1024).toFixed(0)} KB; ${over} over ${CAP_BYTES / 1000} KB; the longest file name has ${deepest} letters`);

if (MEASURE) process.exit(0);
// The folder's license, beside the files as every vendored thing has it.
const licenseText = `The files in this folder (index.json, near.txt and every t-*.txt) are made from the GeoNames
geographical database (https://www.geonames.org/), which is licensed under the Creative Commons
Attribution 4.0 License (https://creativecommons.org/licenses/by/4.0/).

Snapshot of ${DATE}. What was changed: only towns of 500 people or more and capitals are kept, with
their names in Latin letters, their country, region, time zone, position and population, rounded
and cut into files by the first letters of each name. Made by scripts/make_towns.mjs.
`;

// Only what this script makes is ever removed: index.json, near.txt, LICENSE.txt and t-<letters and digits>.txt.
fs.mkdirSync(OUT, { recursive: true });
for (const name of fs.readdirSync(OUT)) if (name === "index.json" || name === "near.txt" || name === "LICENSE.txt" || /^t-[a-z0-9]+\.txt$/.test(name)) fs.rmSync(path.join(OUT, name));
for (const [p, text] of files) fs.writeFileSync(path.join(OUT, fileName(p)), text);
fs.writeFileSync(path.join(OUT, "index.json"), indexText);
fs.writeFileSync(path.join(OUT, "near.txt"), nearText);
fs.writeFileSync(path.join(OUT, "LICENSE.txt"), licenseText);
console.log(`written to ${path.relative(REPO, OUT) || OUT}`);

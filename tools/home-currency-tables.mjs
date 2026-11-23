#!/usr/bin/env node
// Writes the two tables in public/js/shared/home-currency.js again, from their sources:
//
//   node tools/home-currency-tables.mjs <cldr currencyData.json> <tzdata zone.tab>
//
// currencyData.json is the Unicode CLDR's supplemental currency data (the cldr-core package,
// supplemental/currencyData.json; Unicode License v3); zone.tab is from the IANA time zone
// database (public domain). Each region gets its current legal tender: no end date, not marked
// as not tender, the latest start if there are two. Regions whose money public/js/money.js
// doesn't know are left out, and named. Then update the versions in the module's header.

import fs from "node:fs";
import path from "node:path";
import { CURRENCY_CODES } from "../public/js/money.js";

const [cldr, zoneTab] = process.argv.slice(2);
if (!cldr || !zoneTab) { console.error("usage: node tools/home-currency-tables.mjs <currencyData.json> <zone.tab>"); process.exit(2); }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const target = path.join(ROOT, "public/js/shared/home-currency.js");

const known = new Set(CURRENCY_CODES);
const data = JSON.parse(fs.readFileSync(cldr, "utf8")).supplemental;
const regions = {};
const left = [];
for (const [r, list] of Object.entries(data.currencyData.region)) {
  if (!/^[A-Z]{2}$/.test(r)) continue;
  const now = list.flatMap((o) => Object.entries(o)).filter(([, v]) => !v._to && v._tender !== "false")
    .sort((a, b) => String(b[1]._from).localeCompare(String(a[1]._from)));
  if (!now.length) continue;
  if (known.has(now[0][0])) regions[r] = now[0][0]; else left.push(`${r} ${now[0][0]}`);
}
const zones = {};
for (const line of fs.readFileSync(zoneTab, "utf8").split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const [cc, , tz] = line.split("\t");
  if (cc && tz) zones[tz] = cc;
}
const rows = (items, per) => { const out = []; for (let i = 0; i < items.length; i += per) out.push(`  "${items.slice(i, i + per).join(" ")}",`); return out.join("\n"); };
const REGIONS = `const REGIONS = [\n${rows(Object.keys(regions).sort().map((r) => r + regions[r]), 16)}\n].join(" ");`;
const ZONES = `const ZONES = [\n${rows(Object.keys(zones).sort().map((z) => `${z}=${zones[z]}`), 6)}\n].join(" ");`;
let src = fs.readFileSync(target, "utf8");
const swap = (name, text) => {
  const re = new RegExp(`const ${name} = \\[\\n[\\s\\S]*?\\n\\]\\.join\\(" "\\);`);
  if (!re.test(src)) throw new Error(`no ${name} table in ${target}`);
  src = src.replace(re, text);
};
swap("REGIONS", REGIONS);
swap("ZONES", ZONES);
fs.writeFileSync(target, src);
console.log(`CLDR ${data.version._cldrVersion}: ${Object.keys(regions).length} regions, ${Object.keys(zones).length} zones; left out (money the app doesn't know): ${left.join(", ") || "none"}`);

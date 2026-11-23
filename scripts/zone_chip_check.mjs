#!/usr/bin/env node
/* A zone as a chip beside a time (public/js/util.js, tzChip). No browser.
 *
 *   - letters where the zone has them, GMT and the hours where it has none;
 *   - NEVER a bare signed number: "06:05 +00 Wed" reads as a count of days;
 *   - every zone this machine knows, in winter and in summer, gives a chip that fits the rule.
 */
import { tzChip, tzLabel } from "../public/js/util.js";

let pass = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) pass++;
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 400) : ""}`); }
}
const WINTER = Date.UTC(2027, 0, 15, 12) / 1000;
const SUMMER = Date.UTC(2027, 6, 15, 12) / 1000;

for (const [tz, when, want] of [
  ["America/New_York", WINTER, "EST"], ["America/New_York", SUMMER, "EDT"],
  ["Europe/Lisbon", WINTER, "GMT"], ["Europe/Lisbon", SUMMER, "GMT+1"],
  ["America/Lima", WINTER, "GMT-5"], ["Pacific/Fiji", SUMMER, "GMT+12"],
  ["Asia/Kolkata", WINTER, "GMT+5:30"], ["Asia/Kathmandu", SUMMER, "GMT+5:45"],
  ["UTC", WINTER, "UTC"],
]) {
  const got = tzChip(when, tz);
  check(`${tz}, ${when === WINTER ? "January" : "July"}: ${want}`, got === want, got);
}

// What the rule is, as a pattern: letters alone, or GMT with hours (and minutes when it has them).
const FITS = /^(?:[A-Z]{2,5}|GMT[+-]\d{1,2}(?::\d{2})?)$/;
const BARE = /^[+\-\u2212]?\d/;
const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
check("this machine lists its time zones", zones.length > 300, String(zones.length));
const bad = [];
for (const tz of zones) for (const when of [WINTER, SUMMER]) {
  const got = tzChip(when, tz);
  if (!FITS.test(got) || BARE.test(got)) bad.push(`${tz}: "${got}" (the browser said "${tzLabel(when, tz)}")`);
}
check(`every one of them, in January and in July, is letters or GMT and the hours; none is a bare signed number`, bad.length === 0, bad.slice(0, 8).join("; "));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(failures.length ? 1 : 0);

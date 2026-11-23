#!/usr/bin/env node
/* Opening hours: the one format, the strict reader, the lenient reader, the writer, open-now.
 *
 *   node scripts/hours_check.mjs
 *
 * No browser and no server: public/js/shared/hours.js is pure, and this imports it the way the
 * Worker does. What it holds to:
 *
 *   - the strict reader takes the format and nothing else, and says what was wrong;
 *   - the lenient reader converts old spellings ONLY when it understood every word, so a
 *     remark like "approx" or "unverified" keeps the text out of the hours field;
 *   - whatever either reader accepts, written back and read strictly, is the same hours;
 *   - a wrong "Open" is never produced from text that doesn't say when (bare "9-5").
 */
import { HOURS_FORMAT, openState, readHours, readOldHours, writeHours } from "../public/js/shared/hours.js";

let pass = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) pass++;
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + detail : ""}`); }
}
const section = (s) => console.log(`\n${s}`);

section("the strict reader: the format");
for (const [text, canonical] of [
  ["Tue-Sat 12:30-15:00, 19:00-23:00; Sun 12:30-16:00", null],
  ["Daily 09:00-18:00", null],
  ["24 hours", null],
  ["Mon, Wed, Fri 09:00-17:00", null],
  ["Fri-Sat 18:00-02:00", null],
  ["Mon-Fri 09:00-17:00; Sat 10:00-13:00", null],
  ["  Mon-Fri   09:00-17:00 ;Sat 10:00-13:00 ", "Mon-Fri 09:00-17:00; Sat 10:00-13:00"],   // spaces may vary
  ["Mon-Sun 08:00-20:00", "Daily 08:00-20:00"],                                           // one spelling is stored
  ["Sat-Mon 10:00-14:00", "Mon, Sat-Sun 10:00-14:00"],                                    // a run may wrap the week
  ["Sun 12:00-16:00; Tue-Sat 12:00-23:00", "Tue-Sat 12:00-23:00; Sun 12:00-16:00"],       // groups in week order
  ["Daily 19:00-23:00, 12:00-15:00", "Daily 12:00-15:00, 19:00-23:00"],                   // windows in time order
  ["Daily 00:00-24:00", "24 hours"],
  ["Sat 20:00-24:00", null],
]) {
  const r = readHours(text);
  check(`accepts "${text}"`, r.ok && r.text === (canonical || text), r.ok ? `stored as "${r.text}"` : r.error.slice(0, 120));
}

section("the strict reader: everything else is refused, with the reason and the format");
for (const [text, reason] of [
  ["", /empty/],
  ["Mo-Fr 09:00-18:00", /"Mo-Fr" is not a day/],
  ["mon-fri 09:00-17:00", /"mon-fri" is not a day/],
  ["Monday 09:00-17:00", /"Monday" is not a day/],
  ["Mon-Fri 9:00-17:00", /"9:00-17:00" is not a time window/],
  ["Mon-Fri 9am-5pm", /not a time window/],
  ["Mon-Fri 09:00-17:00 approx", /not a time window/],
  ["Approx Mon-Fri 09:00-17:00", /"Approx Mon-Fri" is not a day/],
  ["Mon-Fri 09:00-17:00 (unverified)", /not a time window/],
  ["09:00-17:00", /names no days/],
  ["Mon-Fri", /names no times/],
  ["Mon-Fri 09:00-17:00;", /semicolon/],
  ["Mon 09:00-12:00; Mon 14:00-16:00", /Mon is given hours twice/],
  ["Mon-Wed 09:00-12:00; Wed-Fri 14:00-16:00", /Wed is given hours twice/],
  ["Mon, Mon-Tue 09:00-12:00", /names Mon twice/],
  ["Mon-Mon 09:00-12:00", /a day to itself/],
  ["Daily 09:00-12:00, 11:00-13:00", /overlap/],
  ["Daily 09:00-09:00", /same minute/],
  ["Daily 25:00-26:00", /not a time of day/],
  ["Daily 09:60-10:00", /not a time of day/],
  ["Daily 09:00-24:30", /not a time of day/],
  ["24/7", /./],
  ["24 Hours", /./],
  ["Open daily", /./],
  ["Closed", /./],
]) {
  const r = readHours(text);
  check(`refuses "${text}"`, !r.ok && reason.test(r.error) && r.error.endsWith(HOURS_FORMAT), r.ok ? `accepted as "${r.text}"` : r.error.slice(0, 110));
}
check("a refusal of something that isn't text says so", !readHours(null).ok && !readHours(900).ok && !readHours(["Daily 09:00-17:00"]).ok);

section("the lenient reader: old spellings that say exactly when");
for (const [text, canonical] of [
  ["Mo-Fr 09:00-18:00", "Mon-Fri 09:00-18:00"],
  ["Mo-Su 12:00-15:00, 18:00-22:00", "Daily 12:00-15:00, 18:00-22:00"],
  ["Tu-Fr 17:30-22:30; Sa 12:30-15:30 and 19:00-22:30; closed Su-Mo", "Tue-Fri 17:30-22:30; Sat 12:30-15:30, 19:00-22:30"],
  ["Mon-Sat 09:00-13:00 & 15:00-19:30; Sun 16:30-19:30", "Mon-Sat 09:00-13:00, 15:00-19:30; Sun 16:30-19:30"],
  ["Mon-Sat 09:00-13:00 and 15:00-19:00. Sunday 16:30-19:30.", "Mon-Sat 09:00-13:00, 15:00-19:00; Sun 16:30-19:30"],
  ["Monday to Friday 9:00 to 17:30; closed weekends", "Mon-Fri 09:00-17:30"],
  ["Mon-Fri 9am-5pm", "Mon-Fri 09:00-17:00"],
  ["Mon–Fri 9.30am–6pm", "Mon-Fri 09:30-18:00"],
  ["Tuesdays 10:00-14:00", "Tue 10:00-14:00"],
  ["Mo 09:00-17:00; Tu 07:00-17:00; We-Th 09:00-17:00; Su closed", "Mon, Wed-Thu 09:00-17:00; Tue 07:00-17:00"],
  ["Tue-Sun 12:30-17:00; closed Monday", "Tue-Sun 12:30-17:00"],
  ["Mo-We 12:00-02:00; Th-Sa 12:00-03:00", "Mon-Wed 12:00-02:00; Thu-Sat 12:00-03:00"],
  ["Fri-Sat 6pm-2am", "Fri-Sat 18:00-02:00"],
  ["08:00-22:00 daily", "Daily 08:00-22:00"],
  ["Every day 08:00-22:00", "Daily 08:00-22:00"],
  ["09:00-16:00", "Daily 09:00-16:00"],
  ["Weekdays 09:00-17:00; weekends 10:00-14:00", "Mon-Fri 09:00-17:00; Sat-Sun 10:00-14:00"],
  ["24/7", "24 hours"], ["24h", "24 hours"], ["Open 24h", "24 hours"], ["Open 24 hours, daily", "24 hours"],
  ["Open at all times", "24 hours"], ["Always open", "24 hours"],
  ["Daily 09:00-18:00", "Daily 09:00-18:00"],          // already the format: unchanged
]) {
  const r = readOldHours(text);
  check(`converts "${text}"`, r.ok && r.text === canonical, r.ok ? `got "${r.text}", wanted "${canonical}"` : r.error.slice(0, 120));
}

section("the lenient reader: text with anything it doesn't understand is not hours");
for (const text of [
  "Approx Mo-Sa 09:00-18:00",
  "Mo-Su 09:00-21:00 (unverified)",
  "Mo-Sa 08:00-20:00 (map tag, unverified); closed Sunday",
  "Typically 08:00-23:00 daily - confirm on arrival",
  "Reported Mon-Sat 19:00-24:00; closed Sunday - verify",
  "Tue-Sun 10:00-18:00; closed Monday and on public holidays",
  "Mon-Fri 09:00-19:30; Sat, Sun & holidays 09:00-18:00",
  "Emergency 24/7",
  "Cash machine 24h; branch Mo-Fr 09:00-18:00",
  "Not verified",
  "Open 24h; daylight only in practice",
  "Generally daily, roughly 09:00-19:00/20:00",
  "Lunch 12:00-16:00 and dinner 19:00-23:00",
  "Mon-Fri from 08:00",
  "Sat mornings",
  "9-5",                                   // morning to afternoon, or evening to dawn? It doesn't say.
  "Mon-Fri 9-5",
  "10-6 daily",
  "Mon 09:00-12:00; 14:00-16:00",          // times with no day beside times that have one
  "Mon-Fri 09:00-17:00; closed Friday",    // open and closed on the same day
  "Mon 09:00-12:00; Mon 14:00-16:00",
  "Closed",
  "",
]) {
  const r = readOldHours(text);
  check(`leaves "${text}" alone`, !r.ok && typeof r.error === "string" && r.error.length > 0, r.ok ? `read as "${r.text}"` : "");
}

section("round trip: what a reader accepts, written and read strictly, is the same hours");
{
  let n = 0, bad = "";
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const text of ["Tue-Sat 12:30-15:00, 19:00-23:00; Sun 12:30-16:00", "Fri-Sat 18:00-02:00", "24 hours", "Mo-We 12:00-02:00; Th-Sa 12:00-03:00",
    "Sat-Mon 10:00-14:00", "Mon, Wed, Fri 09:00-17:00; Tue 07:00-12:00, 13:00-20:30; Sun 00:00-24:00", "Monday to Friday 9am to 5:30pm"]) {
    const first = readOldHours(text);
    const again = first.ok ? readHours(first.text) : null;
    n++;
    if (!first.ok || !again.ok || again.text !== first.text || !same(writeHours(again.hours), writeHours(first.hours))) bad = text;
  }
  check(`${n} texts survive write-then-read`, !bad, bad);
  check("writing nothing gives nothing", writeHours(null) === "" && writeHours({ always: false, windows: [] }) === "");
}

section("open now (day 0 is Sunday; minutes after midnight, in the place's zone)");
{
  const H = (t) => readHours(t).hours;
  const at = (day, hh, mm = 0) => ({ day, min: hh * 60 + mm });
  const lunch = H("Tue-Sat 12:30-15:00, 19:00-23:00; Sun 12:30-16:00");
  let s = openState(lunch, at(2, 13));
  check("open inside a window, with the closing time", s.open && s.until === 15 * 60 && s.mins === 120, JSON.stringify(s));
  s = openState(lunch, at(2, 16));
  check("between two windows: closed, opens later today", !s.open && s.today && s.at === 19 * 60, JSON.stringify(s));
  s = openState(lunch, at(1, 13));
  check("a day not named is closed, and the next opening is tomorrow's", !s.open && s.tomorrow && s.day === 2 && s.at === 12 * 60 + 30, JSON.stringify(s));
  s = openState(lunch, at(0, 17));
  check("after the last window of the week, the next opening is found across the closed day", !s.open && !s.today && !s.tomorrow && s.day === 2, JSON.stringify(s));
  const bar = H("Fri-Sat 18:00-02:00");
  s = openState(bar, at(6, 1));
  check("a window that runs past midnight is still open after it (Friday's, at 01:00 Saturday)", s.open && s.until === 120 && s.mins === 60, JSON.stringify(s));
  s = openState(bar, at(0, 1));
  check("Saturday's late window is open at 01:00 Sunday", s.open && s.until === 120, JSON.stringify(s));
  s = openState(bar, at(1, 1));
  check("and Sunday's night, which has none, is closed at 01:00 Monday", !s.open && s.day === 5, JSON.stringify(s));
  s = openState(bar, at(5, 2));
  check("closing time is not open (02:00 exactly, the night before had no window)", !s.open, JSON.stringify(s));
  s = openState(H("24 hours"), at(3, 3));
  check("24 hours is always open", s.open && s.always);
  check("no hours, or no time, says nothing", openState(null, at(1, 1)) === null && openState(lunch, null) === null);
  check("a reader's refusal has no hours to ask about", readHours("Approx 9-5").hours === undefined && readOldHours("Approx 9-5").hours === undefined);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }

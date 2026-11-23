#!/usr/bin/env node
/* A plan typed by hand, the rules with no browser: public/js/plan-form.js.
 *   node scripts/plan_form_check.mjs
 * The form's values become an event (instants read in the trip's zone, never the phone's),
 * an event becomes the form's values again, and a change writes only what differs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = process.env.PLAN_FORM || path.join(HERE, "../public/js/plan-form.js");
const { readPlan, formOf, changesOf, readLink, dayAfter, dayBefore, hasDates, workedEndDay, KINDS } = await import(MOD);
const { clockOf } = await import(path.join(path.dirname(MOD), "shared/clock.js"));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "   -> " + JSON.stringify(detail) : ""}`); }
};
const at = (epoch, tz) => { const c = clockOf(epoch, tz); return `${c.date} ${c.time}`; };
const base = { title: "Dinner by the harbor", kind: "meal", day: "2027-05-08", time: "19:30", endDay: "", endTime: "", placeId: "", detail: "", url: "" };
const LIS = { zone: "Europe/Lisbon" };

console.log("\nthe form becomes an event");
let r = readPlan(base, LIS);
check("a time is read in the trip's zone, whatever zone this machine is in",
  r.event && at(r.event.starts_at, "Europe/Lisbon") === "2027-05-08 19:30" && r.event.tz === "Europe/Lisbon" && r.event.all_day === 0 && r.event.ends_at === null, r);
check("…and the same form in another zone is another instant", readPlan(base, { zone: "Asia/Tokyo" }).event.starts_at === r.event.starts_at - 8 * 3600, readPlan(base, { zone: "Asia/Tokyo" }));
check("the name is trimmed and its inner spaces settled", readPlan({ ...base, title: "  Ferry   out " }, LIS).event.title === "Ferry out");
check("no name is refused under the name", (r = readPlan({ ...base, title: "   " }, LIS)).field === "title" && /what the plan is/.test(r.words), r);
check("a name past 200 characters is refused with its length", (r = readPlan({ ...base, title: "a".repeat(201) }, LIS)).field === "title" && /201/.test(r.words), r);
check("an unknown kind is a plan", readPlan({ ...base, kind: "party" }, LIS).event.kind === "plan" && KINDS.length === 6);
check("no day is refused", readPlan({ ...base, day: "" }, LIS).field === "day");

console.log("\nno time: the plan takes the day");
r = readPlan({ ...base, time: "" }, LIS);
check("all day, from the first minute of that day there", r.event && r.event.all_day === 1 && at(r.event.starts_at, "Europe/Lisbon") === "2027-05-08 00:00" && r.event.ends_at === null, r);
r = readPlan({ ...base, time: "", endDay: "2027-05-10", kind: "lodging" }, LIS);
check("…through a later day: it ends on that day", r.event && r.event.all_day === 1 && at(r.event.ends_at, "Europe/Lisbon") === "2027-05-10 00:00", r);
check("an end time with no start time is refused under the time", (r = readPlan({ ...base, time: "", endTime: "21:00" }, LIS)).field === "time", r);

console.log("\nan end");
r = readPlan({ ...base, endTime: "21:15" }, LIS);
check("later the same day", r.event && at(r.event.ends_at, "Europe/Lisbon") === "2027-05-08 21:15", r);
r = readPlan({ ...base, time: "22:40", endTime: "06:10" }, LIS);
check("an end at or before the start's clock, no day chosen, is the next day", r.event && at(r.event.ends_at, "Europe/Lisbon") === "2027-05-09 06:10", r);
r = readPlan({ ...base, time: "15:00", endDay: "2027-05-11", endTime: "11:00", kind: "lodging" }, LIS);
check("a chosen end day is kept", r.event && at(r.event.ends_at, "Europe/Lisbon") === "2027-05-11 11:00", r);
check("an end day with no end time is refused", (r = readPlan({ ...base, endDay: "2027-05-09" }, LIS)).field === "end" && /time it ends/.test(r.words), r);
check("an end day before the start is refused", readPlan({ ...base, endDay: "2027-05-07", endTime: "10:00" }, LIS).field === "end");
check("the same day chosen as the end, with an earlier time, is refused (not moved a day)", (r = readPlan({ ...base, endDay: "2027-05-08", endTime: "10:00" }, LIS)).field === "end" && /before it starts/.test(r.words), r);

console.log("\nthe clocks change");
// Europe/Lisbon, 28 March 2027: 01:00 becomes 02:00. 31 October 2027: 02:00 becomes 01:00.
check("a time the clocks skip is refused in a sentence", (r = readPlan({ ...base, day: "2027-03-28", time: "01:30" }, LIS)).field === "time" && /clocks skip/.test(r.words), r);
r = readPlan({ ...base, day: "2027-10-31", time: "01:30" }, LIS);
check("a time that happens twice is its first reading", r.event && at(r.event.starts_at, "Europe/Lisbon") === "2027-10-31 01:30" && clockOf(r.event.starts_at, "Europe/Lisbon").offset === "+01:00", r.event && clockOf(r.event.starts_at, "Europe/Lisbon"));
// America/Havana changes at midnight: 14 March 2027, 00:00 becomes 01:00.
r = readPlan({ ...base, day: "2027-03-14", time: "" }, { zone: "America/Havana" });
check("a day whose midnight is skipped still starts on that day", r.event && clockOf(r.event.starts_at, "America/Havana").date === "2027-03-14", r.event && at(r.event.starts_at, "America/Havana"));

console.log("\na link and a note");
check("a bare address gets https", readLink("example.com/menu").url === "https://example.com/menu");
check("a whole address is kept", readLink(" http://example.com/a?b=1 ").url === "http://example.com/a?b=1");
check("none is none", readLink("  ").url === "");
check("words are not a link", /doesn't look like a link/.test(readLink("see the menu").words || "") && /doesn't look like a link/.test(readLink("menu").words || ""));
check("another scheme is not a link", !!readLink("javascript:alert(1)").words && !!readLink("ftp://example.com/x").words);
check("a link past 500 characters is refused", /500/.test(readLink(`example.com/${"a".repeat(500)}`).words || ""));
check("a bad link is shown under the link", readPlan({ ...base, url: "not a link" }, LIS).field === "url");
check("a note past 4000 characters is refused with its length", (r = readPlan({ ...base, detail: "n".repeat(4001) }, LIS)).field === "detail" && /4001/.test(r.words), r);
r = readPlan({ ...base, placeId: "harbor-grill", detail: "  Table for six.  ", url: "example.com" }, LIS);
check("place, note and link go with it", r.event.place_id === "harbor-grill" && r.event.detail === "Table for six." && r.event.url === "https://example.com/", r.event);

console.log("\nan event becomes the form again");
const ev = (form, opts = LIS) => ({ id: "e1", ...readPlan(form, opts).event });
for (const [name, form] of [
  ["a time", base],
  ["all day", { ...base, time: "" }],
  ["an end the same day", { ...base, endTime: "21:15" }],
  ["an end the next day", { ...base, time: "22:40", endDay: "2027-05-09", endTime: "06:10" }],
  ["a stay over three nights, all day", { ...base, kind: "lodging", time: "", endDay: "2027-05-11" }],
  ["everything", { ...base, placeId: "harbor-grill", detail: "Table for six.", url: "https://example.com/" }],
]) {
  const back = formOf(ev(form));
  check(`${name}: the same values come back`, JSON.stringify(back) === JSON.stringify(form), back);
}
const flight = { id: "f1", title: "Flight home", kind: "flight", starts_at: readPlan({ ...base, time: "10:00" }, LIS).event.starts_at, tz: "Europe/Lisbon", end_tz: "America/New_York", all_day: 0, ends_at: null, place_id: null, detail: "", url: "", source: "import" };
flight.ends_at = flight.starts_at + 8 * 3600;   // 18:00 Lisbon is 13:00 New York
check("an arrival in another zone is shown in that zone", formOf(flight).endTime === "13:00" && formOf(flight).endDay === "", formOf(flight));
r = readPlan({ ...formOf(flight), endTime: "13:30" }, { zone: flight.tz, endZone: flight.end_tz });
check("…and a new arrival time is read in that zone", r.event && r.event.ends_at === flight.ends_at + 1800, r);

console.log("\na change writes only what differs");
const was = ev({ ...base, endTime: "21:15", detail: "Table for six." });
check("nothing changed, nothing written", Object.keys(changesOf(was, readPlan(formOf(was), LIS).event)).length === 0, changesOf(was, readPlan(formOf(was), LIS).event));
let ch = changesOf(was, readPlan({ ...formOf(was), title: "Dinner on the pier" }, LIS).event);
check("a new name writes the name alone", JSON.stringify(Object.keys(ch)) === '["title"]' && ch.title === "Dinner on the pier", ch);
ch = changesOf(was, readPlan({ ...formOf(was), time: "20:00" }, LIS).event);
check("a new time writes the start alone", JSON.stringify(Object.keys(ch)) === '["starts_at"]', ch);
ch = changesOf(was, readPlan({ ...formOf(was), endTime: "" }, LIS).event);
check("the end cleared writes null", JSON.stringify(ch) === '{"ends_at":null}', ch);
ch = changesOf(was, readPlan({ ...formOf(was), time: "", endTime: "" }, LIS).event);
check("made all day: the start, the end and the flag", "starts_at" in ch && ch.ends_at === null && ch.all_day === 1 && Object.keys(ch).length === 3, ch);
ch = changesOf(flight, readPlan({ ...formOf(flight), detail: "Seats 14A to 14C" }, { zone: flight.tz, endZone: flight.end_tz }).event);
check("a note on a flight touches neither its zones nor its times", JSON.stringify(ch) === '{"detail":"Seats 14A to 14C"}', ch);
const moment = { ...was, ends_at: was.starts_at };   // an end equal to the start is a moment, not a span
check("an end equal to the start reads as no end, and saving it unchanged writes nothing",
  formOf(moment).endTime === "" && Object.keys(changesOf(moment, readPlan(formOf(moment), LIS).event)).length === 0, changesOf(moment, readPlan(formOf(moment), LIS).event));

console.log("\nleaving from, or arriving in, another time zone");
// The flight from home: New York 18:00, Lisbon 06:05 the next morning, on a trip in Lisbon.
const NY = "America/New_York";
const home = { ...base, title: "Flight to Lisbon", kind: "flight", day: "2027-05-07", time: "18:00", endTime: "06:05" };
const NYLIS = { zone: NY, endZone: "Europe/Lisbon" };
r = readPlan(home, NYLIS);
check("leaves at 18:00 New York time, lands at 06:05 Lisbon time the next day",
  r.event && at(r.event.starts_at, NY) === "2027-05-07 18:00" && at(r.event.ends_at, "Europe/Lisbon") === "2027-05-08 06:05" && r.event.tz === NY && r.event.end_tz === "Europe/Lisbon", r);
check("…the end day it worked out is the next day", workedEndDay(home, NYLIS) === "2027-05-08", workedEndDay(home, NYLIS));
check("…and 06:05 in New York's zone would have been six hours of flying fewer", readPlan(home, { zone: NY }).event.ends_at - r.event.ends_at === 5 * 3600, readPlan(home, { zone: NY }));
check("…picked as its end day, the same flight", readPlan({ ...home, endDay: "2027-05-08" }, NYLIS).event.ends_at === r.event.ends_at);
check("…in the trip's zone, unchanged, it is a 12-hour flight", (() => { const e = readPlan(home, { zone: "Europe/Lisbon" }).event; return e.ends_at - e.starts_at === 12 * 3600 + 5 * 60 && e.end_tz === null; })());
// The way home: Lisbon 11:30, New York 14:10 the same day (an earlier clock, a later instant).
const back = { ...home, title: "Flight home", day: "2027-05-14", time: "11:30", endTime: "14:10" };
r = readPlan(back, { zone: "Europe/Lisbon", endZone: NY });
check("the way home lands the same day: 11:30 Lisbon, 14:10 New York",
  r.event && at(r.event.ends_at, NY) === "2027-05-14 14:10" && r.event.end_tz === NY && r.event.tz === "Europe/Lisbon" && workedEndDay(back, { zone: "Europe/Lisbon", endZone: NY }) === "", r);
// Over the date line eastward: Tokyo 10:00, Honolulu 22:00 the evening BEFORE.
const hop = { ...home, day: "2027-05-08", time: "10:00", endTime: "22:00" };
r = readPlan(hop, { zone: "Asia/Tokyo", endZone: "Pacific/Honolulu" });
check("Tokyo 10:00 to Honolulu 22:00 lands the evening before, seven hours later",
  r.event && at(r.event.ends_at, "Pacific/Honolulu") === "2027-05-07 22:00" && r.event.ends_at - r.event.starts_at === 7 * 3600, r);
check("…and the worked-out end day is the day before", workedEndDay(hop, { zone: "Asia/Tokyo", endZone: "Pacific/Honolulu" }) === "2027-05-07");
check("…picked by hand, the day before is taken across zones", readPlan({ ...hop, endDay: "2027-05-07" }, { zone: "Asia/Tokyo", endZone: "Pacific/Honolulu" }).event.ends_at === r.event.ends_at);
check("…and refused in one zone", readPlan({ ...hop, endDay: "2027-05-07" }, { zone: "Asia/Tokyo" }).field === "end");
check("in one zone an end day before the start is refused in those words, with times or without",
  ["10:00", ""].every((t) => { const x = readPlan({ ...hop, time: t, endTime: t ? "22:00" : "", endDay: "2027-05-07" }, { zone: "Asia/Tokyo" }); return x.field === "end" && /can't end before the day it starts/.test(x.words); }),
  ["10:00", ""].map((t) => readPlan({ ...hop, time: t, endTime: t ? "22:00" : "", endDay: "2027-05-07" }, { zone: "Asia/Tokyo" })));
check("…and two days before is refused even across zones", readPlan({ ...hop, endDay: "2027-05-06" }, { zone: "Asia/Tokyo", endZone: "Pacific/Honolulu" }).field === "end");
check("a picked end day that is before the start is refused in a sentence", (r = readPlan({ ...back, endDay: "2027-05-13" }, { zone: "Europe/Lisbon", endZone: NY })).field === "end" && /ends before it starts/.test(r.words), r);
check("an end zone with no end writes no end zone", readPlan({ ...home, endTime: "" }, NYLIS).event.end_tz === null);
check("the same zone twice writes no end zone", readPlan(home, { zone: NY, endZone: NY }).event.end_tz === null);
check("a day before the start with no times is refused: the day can't say which comes first", readPlan({ ...home, time: "", endTime: "", endDay: "2027-05-06" }, NYLIS).field === "time");
check("in one zone a night bus is still the next day", workedEndDay({ ...base, time: "22:40", endTime: "06:10" }, LIS) === dayAfter(base.day) && workedEndDay(base, LIS) === "");
check("the day before the first of a month", dayBefore("2027-06-01") === "2027-05-31" && dayBefore("2028-03-01") === "2028-02-29");
// Changes: the end's zone as it means, never as it is spelled.
const flown = { id: "ev_f", ...readPlan(home, NYLIS).event };
check("a flight read back opens with its times in each of its zones",
  (() => { const f = formOf(flown); return f.time === "18:00" && f.endTime === "06:05" && f.day === "2027-05-07" && f.endDay === "2027-05-08"; })(), formOf(flown));
ch = changesOf(flown, readPlan(formOf(flown), NYLIS).event);
check("saved unchanged, nothing is written", Object.keys(ch).length === 0, ch);
ch = changesOf(flown, readPlan(formOf(flown), { zone: NY }).event);
check("the arrival zone closed: the end is New York's and end_tz is cleared", ch.end_tz === null && "ends_at" in ch && !("tz" in ch), ch);
ch = changesOf({ ...flown, end_tz: null, tz: "Europe/Lisbon" }, readPlan(formOf({ ...flown, end_tz: null, tz: "Europe/Lisbon" }), { zone: "Europe/Lisbon", endZone: "Europe/Lisbon" }).event);
check("an end in the start's zone, spelled either way, is no change", Object.keys(ch).length === 0, ch);
ch = changesOf({ ...flown, end_tz: NY, tz: NY }, readPlan(formOf({ ...flown, end_tz: NY, tz: NY }), { zone: NY }).event);
check("an end_tz that repeats the tz is not rewritten", Object.keys(ch).length === 0, ch);
ch = changesOf(flown, readPlan({ ...formOf(flown), endTime: "" , endDay: "" }, NYLIS).event);
check("the end taken off takes its zone with it", ch.ends_at === null && ch.end_tz === null, ch);

console.log("\nsmall things");
check("the day after the last of a month", dayAfter("2027-05-31") === "2027-06-01" && dayAfter("2028-02-28") === "2028-02-29");
check("a trip has dates only with both", hasDates({ starts_on: "2027-05-06", ends_on: "2027-05-12" }) && !hasDates({ starts_on: null, ends_on: null }) && !hasDates({ starts_on: "2027-05-06" }) && !hasDates(null));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

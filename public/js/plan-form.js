// A plan typed by hand: the form's values turned into an event, and an event turned back
// into the form's values. Pure (no store, no DOM), so node checks it
// (scripts/plan_form_check.mjs); the sheet that shows the form is plan-editor.js.
//
// The form, as the person fills it:
//   title     what it is, required
//   kind      one of KINDS
//   day       "YYYY-MM-DD", a day of the trip
//   time      "HH:MM", or "" for a plan that takes the day ("All day")
//   endDay    "" for the same day, or a later day
//   endTime   "HH:MM" or ""
//   placeId   a place of the trip, or ""
//   detail    a note
//   url       a link
//
// An event keeps instants (epoch seconds) and the zone they are read in: `tz` for its start,
// `end_tz` for its end when that is another zone (a flight that lands somewhere else; null
// means "ends in the zone it started in"). The sheet reads both in the trip's zone unless the
// person says a plan leaves from, or arrives in, another one.

import { readClock, clockOf, isZone } from "./shared/clock.js";

// "plan" is stored as it always was; it is named "Other" ("Plan" as one kind of plan read as every plan).
export const KINDS = [
  ["plan", "Other"], ["activity", "Activity"], ["meal", "Food"],
  ["lodging", "Stay"], ["transit", "Transit"], ["flight", "Flight"],
];
export const TITLE_MAX = 200;
export const DETAIL_MAX = 4000;
export const URL_MAX = 500;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The day after `day` ("YYYY-MM-DD"). */
export function dayAfter(day) {
  return new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
}
/** The day before `day`. */
export function dayBefore(day) {
  return new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

/**
 * The instant a clock time means in a zone, for a form: a time the clocks skip is refused in
 * a sentence; a time that happens twice (the hour the clocks repeat) is its first reading.
 */
function instant(day, time, tz) {
  const r = readClock(`${day}T${time}`, tz);
  if (typeof r.epoch === "number") return { epoch: r.epoch };
  if (r.readings && r.readings.length) return { epoch: r.readings[0].epoch };
  return { words: `${time} doesn't happen on that day there: the clocks skip it. Pick a time an hour later.` };
}

/** The first instant of a day in a zone (midnight, or the first hour that exists when the clocks skip it). */
function startOfDay(day, tz) {
  for (const t of ["00:00", "00:30", "01:00", "02:00", "03:00"]) {
    const r = instant(day, t, tz);
    if (typeof r.epoch === "number") return r.epoch;
  }
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
}

/**
 * A link as the person typed it, made whole: "example.com/menu" is "https://example.com/menu".
 * Answers { url } ("" for none) or { words }.
 */
export function readLink(typed) {
  const s = String(typed || "").trim();
  if (!s) return { url: "" };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let u = null;
  try { u = new URL(withScheme); } catch { u = null; }
  if (!u || !/^https?:$/.test(u.protocol) || !u.hostname.includes(".") || /\s/.test(s)) {
    return { words: "That doesn't look like a link. A link is a web address, like example.com/menu." };
  }
  if (u.href.length > URL_MAX) return { words: `A link is at most ${URL_MAX} characters.` };
  return { url: u.href };
}

/**
 * Where an end with no day picked falls: the first time its clock reads `endTime`, in its own
 * zone, after the start. In one zone that is the start's day or the next (a night bus that
 * leaves at 22:40 arrives at 06:10 the next day). Across zones it can be the day before too:
 * a flight that leaves Tokyo at 10:00 lands in Honolulu at 22:00 the evening before.
 * Answers { epoch, day } or { words }.
 */
function firstEndAfter(start, day, endTime, tz, ez) {
  const days = tz === ez ? [day, dayAfter(day)] : [dayBefore(day), day, dayAfter(day)];
  let words = "";
  for (const d of days) {
    const r = instant(d, endTime, ez);
    if (r.words) { words = words || r.words; continue; }
    if (r.epoch > start) return { epoch: r.epoch, day: d };
  }
  return { words: words || "It ends before it starts. Pick a later time, or a later day." };
}

/**
 * The day the end falls on when the person hasn't picked one: "" when it is the start's own day,
 * or there is no end to place. The sheet shows it in "Ends on" (zone and endZone as readPlan's).
 */
export function workedEndDay(form, { zone, endZone = "" } = {}) {
  const tz = isZone(zone) ? zone : "UTC";
  const ez = isZone(endZone) ? endZone : tz;
  const day = String(form.day || ""), time = String(form.time || ""), endTime = String(form.endTime || "");
  if (!DAY_RE.test(day) || !TIME_RE.test(time) || !TIME_RE.test(endTime)) return "";
  const s = instant(day, time, tz);
  if (s.words) return "";
  const e = firstEndAfter(s.epoch, day, endTime, tz, ez);
  return e.words || e.day === day ? "" : e.day;
}

/**
 * The form's values as an event's fields.
 *   zone      the zone the start is read in (the trip's, or another the person chose)
 *   endZone   the zone the end is read in ("" for the start's)
 * Answers { event } with title, kind, starts_at, ends_at, tz, end_tz, all_day, place_id,
 * detail, url, or { field, words }: which field to show the sentence under. end_tz is null
 * unless the end is read in another zone than the start.
 */
export function readPlan(form, { zone, endZone = "" } = {}) {
  const tz = isZone(zone) ? zone : "UTC";
  const ez = isZone(endZone) ? endZone : tz;
  const title = String(form.title || "").replace(/\s+/g, " ").trim();
  if (!title) return { field: "title", words: "Say what the plan is." };
  if (title.length > TITLE_MAX) return { field: "title", words: `That's ${title.length} characters; a plan's name is at most ${TITLE_MAX}.` };
  const kind = KINDS.some(([k]) => k === form.kind) ? form.kind : "plan";
  const day = String(form.day || "");
  if (!DAY_RE.test(day)) return { field: "day", words: "Pick the day." };
  const time = String(form.time || "");
  if (time && !TIME_RE.test(time)) return { field: "time", words: "A time is written like 19:30." };
  const endDay = String(form.endDay || "");
  if (endDay && !DAY_RE.test(endDay)) return { field: "end", words: "Pick the day it ends." };
  // Across zones an end can be on the day before (eastward over the date line); in one zone never.
  if (endDay && endDay < day && (ez === tz || endDay < dayBefore(day))) return { field: "end", words: "It can't end before the day it starts." };
  const endTime = String(form.endTime || "");
  if (endTime && !TIME_RE.test(endTime)) return { field: "end", words: "A time is written like 21:00." };

  let starts_at, ends_at = null, all_day = 0;
  if (!time) {
    // A plan that takes the day. An end time alone has nothing to end.
    if (endTime) return { field: "time", words: "Add the time it starts, or clear the time it ends." };
    all_day = 1;
    starts_at = startOfDay(day, tz);
    if (endDay && endDay > day) ends_at = startOfDay(endDay, ez);
    else if (endDay && endDay < day) return { field: "time", words: "Add the times it leaves and arrives: across time zones the day alone can't say which comes first." };
  } else {
    const s = instant(day, time, tz);
    if (s.words) return { field: "time", words: s.words };
    starts_at = s.epoch;
    if (endTime) {
      if (endDay) {
        const e = instant(endDay, endTime, ez);
        if (e.words) return { field: "end", words: e.words };
        if (e.epoch <= starts_at) return { field: "end", words: "It ends before it starts. Pick a later time, or a later day." };
        ends_at = e.epoch;
      } else {
        const e = firstEndAfter(starts_at, day, endTime, tz, ez);
        if (e.words) return { field: "end", words: e.words };
        ends_at = e.epoch;
      }
    } else if (endDay && endDay !== day) {
      return { field: "end", words: "Add the time it ends, or set it back to the same day." };
    }
  }

  const detail = String(form.detail || "").trim();
  if (detail.length > DETAIL_MAX) return { field: "detail", words: `That's ${detail.length} characters; a note is at most ${DETAIL_MAX}.` };
  const link = readLink(form.url);
  if (link.words) return { field: "url", words: link.words };

  // A zone for the end only when there is an end, and it is another zone than the start's.
  const end_tz = ends_at != null && ez !== tz ? ez : null;
  return { event: { title, kind, starts_at, ends_at, tz, end_tz, all_day, place_id: form.placeId || null, detail, url: link.url } };
}

/** An event as the form's values: the other way. */
export function formOf(e) {
  const tz = isZone(e.tz) ? e.tz : "UTC";
  const ez = isZone(e.end_tz) ? e.end_tz : tz;
  const start = clockOf(Number(e.starts_at), tz);
  const hasEnd = e.ends_at != null && Number(e.ends_at) > Number(e.starts_at);
  const end = hasEnd ? clockOf(Number(e.ends_at), ez) : null;
  const allDay = !!e.all_day;
  return {
    title: e.title || "",
    kind: KINDS.some(([k]) => k === e.kind) ? e.kind : "plan",
    day: start.date,
    time: allDay ? "" : start.time,
    endDay: end && end.date !== start.date ? end.date : "",
    endTime: end && !allDay ? end.time : "",
    placeId: e.place_id || "",
    detail: e.detail || "",
    url: e.url || "",
  };
}

/**
 * What a change of the form writes: only the fields that differ from the event as it is, so a
 * field the form does not show (where the row came from) is never touched. The end's zone is
 * compared as what it means (its own, or the start's when it has none), so an event whose
 * end_tz merely repeats its tz is not rewritten. An empty object means nothing changed.
 */
export function changesOf(e, next) {
  const out = {};
  const same = (a, b) => (a == null ? "" : a) === (b == null ? "" : b);
  for (const k of ["title", "kind", "tz", "place_id", "detail", "url"]) if (!same(e[k], next[k])) out[k] = next[k];
  if (Number(e.starts_at) !== Number(next.starts_at)) out.starts_at = next.starts_at;
  const was = e.ends_at != null && Number(e.ends_at) > Number(e.starts_at) ? Number(e.ends_at) : null;
  if (was !== next.ends_at) out.ends_at = next.ends_at;
  if ((e.all_day ? 1 : 0) !== next.all_day) out.all_day = next.all_day;
  const endIn = (x) => (x.ends_at == null ? "" : x.end_tz || x.tz || "");
  if (next.ends_at != null && endIn(e) !== endIn(next)) out.end_tz = next.end_tz;
  else if (next.ends_at == null && e.end_tz) out.end_tz = null;
  return out;
}

/**
 * The days a plan can be put on: the trip's, each { day, weekday }, or [] for a trip with no
 * dates. `daysBetween` lives in shared/clock.js; this only guards the trip's shape.
 */
export function hasDates(trip) {
  return !!(trip && DAY_RE.test(String(trip.starts_on || "")) && DAY_RE.test(String(trip.ends_on || "")));
}

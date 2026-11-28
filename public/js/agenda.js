// agenda.js — the trip as one continuous scroll, plus the two detail screens that hang off it.
//
// Mounted for ONE router route, `#/e/:id`, wearing two faces, plus the list at `#/`:
//
//   #/                  ctx.route "agenda"   the scroll
//   #/e/:id             ctx.route "event"    the event this id names
//   #/e/:id?gap=1       ctx.route "event"    the GAP THAT ENDS AT this id
//
// WHY THE GAP PAGE IS A QUERY AND NOT ITS OWN ROUTE: router.js is the authority on the route
// table (SHELL contract) and it has no gap route, so inventing `#/g/:id` would fall through
// parse() and bounce to `#/`. It is not a workaround, either — it is the correct address.
// docs/API.md fixes a gap note's `event_id` to the event that FOLLOWS the gap, precisely
// because a gap's own edges move whenever either neighbour moves while "the run-up to lunch
// at the fonda" is stable as long as lunch exists. The gap IS identified by its following event,
// so `#/e/lunch?gap=1` names it exactly and survives the itinerary being re-imported.
//
// One consequence has to be handled and is: router.handle() keys its "same screen" check on
// the PATH ONLY, so `#/e/lunch` -> `#/e/lunch?gap=1` never remounts. The detail view
// therefore subscribes to router.onNavigate() and re-reads the query itself. onNavigate fires
// twice per navigation (SHELL contract), so the listener is idempotent by construction: it
// compares the face it is showing against the face the URL asks for and returns if they match.
//
// WHY NOT A CALENDAR GRID: with one to four events a day, a time grid spends ninety percent
// of a 390px screen drawing empty hours. What people actually ask on a trip is "what's next,
// and how long have I got" — which is a question about the SPACE BETWEEN events, not about
// where they sit on a 24-hour ruler. So the gaps are first-class objects here: every pair of
// consecutive same-day events is joined by a rail that says how much room is in it, the one
// you are standing in says how much is left, and every one of them is TAPPABLE, because a gap
// is now a page you can hang notes on.
//
// THREE MODELLING DECISIONS THAT THE REAL DATA FORCED, all visible in the connector maths:
//
//   1. LODGING IS NOT A TIMELINE EVENT. A stay runs from 15:00 one day to 11:00 two days on, and
//      its check-in time is nominal — the flight that actually gets you to its city can leave at
//      19:25, four hours AFTER you have supposedly checked in. Left in the spine it eats the
//      gap it sits in and every later gap on the day reads as an overlap. So events with
//      kind 'lodging' and an end time are lifted out into a day band that repeats on every
//      night they cover, which is also the only way "where am I sleeping" is answerable on
//      a day whose single event is a day trip out of town.
//
//   2. AN EVENT THAT ENDS ON A LATER DAY DOES NOT BLOCK THE REST OF TODAY. Same reason. Only
//      an event that starts and ends inside one day contributes its end to the running
//      "free from" mark.
//
//   3. GAPS ARE MEASURED FROM A RUNNING MAX, not from the previous card's end. A day can hold
//      one long plan, 09:00–16:00, with an office check-in and a luggage sort inside it.
//      Pairwise maths would announce a 6h gap while you are standing in the office. The
//      running max makes those read as overlaps (tight rails) and puts the one real gap
//      where it belongs: after the long plan has ended, the free afternoon.
//
// TIME IS ALWAYS THE EVENT'S ZONE. util.fmtTime(e.starts_at, e.tz) everywhere, and the
// arrival side always falls back e.end_tz || e.tz. A device-local render puts a
// departure from another zone hours off its real time and somebody misses a plane.
//
// Intentional omissions on this screen, and why each is excluded rather than unbuilt:
//
//   * THE ADD-EVENT FLOW, entire. Events are not user-authored any more; notes are. The
//     bottom sheet, the FAB and the hide-on-scroll machinery that kept the FAB off the card
//     underneath it are all gone, which also hands the bottom-right quadrant back — the
//     shell owns bottom-LEFT and expects views to keep clear of it, and now nothing here
//     competes for either corner.
//   * EVERY LOCK ICON, and the whole "locked" vocabulary with it. It appeared on literally
//     every card, so it distinguished nothing, and the word only ever explained a control
//     that no longer exists. Its slot on the card now carries DISTANCE TO, which is the one
//     number that changes as you walk.
//   * EDIT / DELETE on the event screen. Nothing here is user-authored, so they had nothing
//     left to act on.
//   * PHOTO CREDITS. The CC BY / CC BY-SA obligation is met on one
//     Settings → Image credits page covering every image, so no card, band or hero carries
//     credit chrome. shotFor() still refuses an image whose row has no `image_license`,
//     because that is a data bug (migration 0003 says so) and rendering it would be a
//     licence violation no attributions page can retro-fix.
//
// DISTANCE IS ONE GPS READ, CACHED. util.getPosition() is called ONCE per mount and every
// row reads util.lastPosition() synchronously. Not watchPosition: four of these eleven days
// have no signal and no charger, and a watch keeps the GPS chip awake for as long as an
// installed PWA is open, which is all day. It is straight-line distance and it is labelled
// as such — never a misleading walk time from a different anchor.
//
// I PUBLISH ONE ROUTE CONTRACT, kept stable and emitted from the gap page rather
// than from the rail: #/places?near=<place_id>&free=<minutes>. "near" is the place you are
// sitting in (the event before the gap, falling back to the one after it) and "free" is how
// many minutes are left. places.js reads both and degrades to the plain list without them.
//
// STYLES: CONTRACTS.md assigns .ag-* to this module and styles.css to the shell, so the
// stylesheet carries no .ag- rules and there is nowhere else for them to live. They are
// injected once, from here, built entirely out of the shell's tokens. No bare element
// selectors, per the same contract.

import { store } from "./store.js";
import { GUEST_AI_LINE } from "./guest.js";
import { eventPhoto, pictureOf } from "./shared/photo.js";
import { ensurePhotoCss, photoHand, wantsPhoto } from "./photo-hand.js";
import { start as startPictures } from "./picture-wait.js";
import { openSheet } from "./sheet.js";
import {
  emptyWaysHTML, openPlanWithAiSheet, injectPlanAiStyles,
} from "./plan-ai.js";
import { openInvite } from "./invite.js";
import {
  fmtTime, fmtDay, tzChip, dayKey, toMs, esc, clip, fmtAgo, fmtSpan, localNameOf,
  haversine, fmtDistance, getPosition, lastPosition, positionDenied, positionPermission, inkOn,
} from "./util.js";
import { getIcon, categoryOf } from "./icons.js";
import { fmtMoney } from "./money.js";
// A plan added, changed or removed by hand: the sheet is plan-editor.js. This file only
// offers the ways in (the empty Agenda's button, the + button, "Change" on a plan's page).
import { openPlanEditor } from "./plan-editor.js";
import { toast } from "./toast.js";
// Agenda motion helpers. breathe() is the one ambient loop (the "now" marker),
// reducedMotion()/ms() so this file never restates the tokens. The ring
// glide and the drain tween are WAAPI here rather than motion.js primitives because both are
// bound to this module's own geometry (a pill's offsetLeft, a gap's minute maths).
import { breathe, reducedMotion, ms } from "./motion.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// A gap shorter than this is not free time — it is a doorway. Twenty minutes is the
// number, and it matches real plans: a flight lands at 20:50 and the pickup is at 20:50.
const TIGHT_MS = 20 * MIN;

// An event with no ends_at is a moment, not a span ("Land in Costa Alta"). It still deserves to
// read as "now" for a little while after it happens, but it gets no countdown and no
// progress fill, because there is no honest number to put in them.
const POINT_LIVE_MS = 30 * MIN;

const TICK_MS = 60_000;

// The two easing tokens, read live from the stylesheet the same way motion.js reads its own —
// motion.js deliberately does not export them, and hard-coding the curves here would be a
// second place where cubic-bezier(.2,.8,.2,1) is written down.
const easeOutTok = () =>
  getComputedStyle(document.documentElement).getPropertyValue("--ease-out").trim() || "cubic-bezier(.2,.8,.2,1)";

// ────────────────────────────────────────────────────────────────────────────────────────
// formatting
// ────────────────────────────────────────────────────────────────────────────────────────

// Weekday only ("Sat"), for an arrival that lands on a different date than the departure.
function dow(epoch, tz) { return fmtDay(epoch, tz).split(" ")[0]; }

// The zone beside a time, on the two kinds of plan that can have a foreign clock: util.tzChip,
// the same words wherever a zone is a chip ("EDT" beside "GMT-5", never a bare "-05").
const zoneChip = tzChip;

// "2027-06-01" → epoch ms at UTC midnight. These are calendar dates with no zone; formatting
// them in America/Lima would read UTC midnight as the previous evening and label the trip a
// day early. The shell does the same thing for the same reason.
function isoToMs(iso) { return Date.parse(`${iso}T00:00:00Z`); }
function msToIso(ms) { return new Date(ms).toISOString().slice(0, 10); }

// ────────────────────────────────────────────────────────────────────────────────────────
// glyphs
// ────────────────────────────────────────────────────────────────────────────────────────
//
// TWO SOURCES, AND THE SPLIT IS DELIBERATE.
//
// Anything that NAMES A THING — an event's kind, the place it happens at — comes from
// icons.js, so a pharmacy is the same cross in the agenda, in Places and on the map, and so
// the "no two icons differ by hue alone" rule is enforced in exactly one file. See kindIcon()
// below for how an event is resolved onto that vocabulary.
//
// The handful below are pure interface marks — a chevron, a copy affordance, a send arrow.
// They name no domain object, icons.js has no vocabulary for them, and they are drawn here
// rather than fetched so nothing on this screen ever needs a network request.
const UI = {
  chev: '<path d="m9 5 7 7-7 7"/>',
  ext: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15"/>',
  tick: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  send: '<path d="M4.5 12h14"/><path d="m12.5 5.5 6.5 6.5-6.5 6.5"/>',
  note: '<path d="M5 4.5h14v11l-4 4H5v-15Z"/><path d="M19 15.5h-4v4"/><path d="M8.5 9h7M8.5 12.5h4"/>',
  clock: '<circle cx="12" cy="12" r="8.8"/><path d="M12 7.2V12l3.4 2"/>',
  pencil: '<path d="M4.5 19.5h3.6L19 8.6 15.4 5 4.5 15.9v3.6Z"/><path d="m13.4 7 3.6 3.6"/>',
  chat: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V17h0A2.5 2.5 0 0 1 4 14.5v-8Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  near: '<path d="M12 21s6.5-5.9 6.5-10.4a6.5 6.5 0 1 0-13 0C5.5 15.1 12 21 12 21Z"/><circle cx="12" cy="10.4" r="2.4"/>',
  // Withdrawing your own note. A lidded bin, not an X: an X on a note beside a
  // "Copy" and a "Send" reads as "dismiss this row", and this one does not come back.
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.7 7l.8 11.4A1.6 1.6 0 0 0 9.1 20h5.8a1.6 1.6 0 0 0 1.6-1.6L17.3 7"/><path d="M10.5 10.5v6M13.5 10.5v6"/>',
};
const ui = (name, cls) =>
  `<svg class="ico${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" aria-hidden="true">${UI[name] || UI.clock}</svg>`;

const KIND_WORD = { flight: "Flight", meal: "Food", lodging: "Stay", activity: "Activity", transit: "Transit", plan: "Other" };

// An unknown kind must still land on a real glyph and a real tint rather than on `undefined`.
const kindOf = (e) => (KIND_WORD[e.kind] ? e.kind : "plan");

// EVENT KIND -> A SUBKIND ICONS.JS ACTUALLY KNOWS. icons.js is built around places, so its
// per-KIND fallbacks are chosen to be visibly generic — categoryOf('flight') is 'transit' and
// the transit fallback is a BUS, which on a flight card is not "generic", it is wrong. These
// six hints steer each event kind onto the glyph the SUB table already holds for it:
// flight→plane, transit→car, meal→bowl, lodging→hotel, activity→hiker. 'plan' has no honest
// specific mark and deliberately keeps the practical fallback.
const EVENT_SUB = { flight: "flight", transit: "transfer", meal: "meal", lodging: "hotel", activity: "walk", plan: "" };

// The place always wins where there is one: "Estación Alba Verde" draws a train and not a
// generic transfer car, which is the entire point of icons.js giving every SUBkind its own
// glyph. Falls back to the event's own kind for the rows with no place_id.
function kindIcon(e, place, opts) {
  return place && place.kind
    ? getIcon(place.kind, place.subkind, opts)
    : getIcon(e.kind, EVENT_SUB[kindOf(e)], opts);
}

function planToneVars(e, place) {
  const pk = kindOf(e);
  let tok = `--plan-${pk}`;
  if (pk !== "flight" && pk !== "transit" && place && place.kind) {
    tok = `--cat-${categoryOf(place.kind)}`;
  }
  return `--ds-k:var(${tok});--ds-k-bg:var(${tok}-bg);--ds-k-edge:var(${tok}-edge)`;
}
function placeToneVars(place) {
  if (!place || !place.kind) return "";
  const tok = `--cat-${categoryOf(place.kind)}`;
  return `--ds-k:var(${tok});--ds-k-bg:var(${tok}-bg);--ds-k-edge:var(${tok}-edge)`;
}

// ────────────────────────────────────────────────────────────────────────────────────────
// distance — ONE fix, cached, straight line, and labelled as such
// ────────────────────────────────────────────────────────────────────────────────────────

// A place at exactly 0,0 has not been geocoded; it is not a point 2,600 km off Ghana.
// An import can ship some (a restaurant nobody looked up), and without this
// guard every card for them would claim a confident five-thousand-kilometre distance.
function hasCoords(p) {
  return !!p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng) &&
    (Math.abs(+p.lat) > 0.01 || Math.abs(+p.lng) > 0.01);
}

// Metres from the cached fix to a place, or NaN. Synchronous by design: a row renderer cannot
// await, and the SHELL contract is explicit that a view calls getPosition() once and then
// reads lastPosition() per row.
function metresTo(place) {
  const pos = lastPosition();
  if (!pos || !hasCoords(place)) return NaN;
  return haversine(pos, { lat: +place.lat, lng: +place.lng });
}

// THE STRING SAYS WHAT IT IS. Never print a bogus combo like "5182 km away · 2 min walk" on
// a row, because the walk time was a researched number measured from the place's own anchor
// and had nothing to do with where the reader was standing. So this is never called a walk:
// it is a straight line from a cached GPS fix, and the accessible name says "in a straight
// line" out loud where there is room for it.
//
// ONLY NEAR (100 km). From home before a trip every plan is thousands of kilometres off, and the same number on every
// row says nothing; on the trip the distances appear by themselves. Farther than this, no distance and no glyph.
const NEAR_M = 100000;
function distHTML(place, cls) {
  const m = metresTo(place);
  if (!Number.isFinite(m) || m > NEAR_M) return "";
  const s = fmtDistance(m);
  return `<span class="ag-dist${cls ? ` ${cls}` : ""}" role="img" aria-label="${esc(s)} away in a straight line"
    >${ui("near", "ag-dist-g")}<span class="num">${esc(s)}</span></span>`;
}

// ────────────────────────────────────────────────────────────────────────────────────────
// what has been said about a plan
// ────────────────────────────────────────────────────────────────────────────────────────
//
// Notes on plans are messages in the trip's chat now (migration 0027), not a store of their own.
// The Agenda says HOW MANY have been written about each plan, and the plan's
// page shows them. The count is the snapshot's (store.talkAbout), so it is there with no signal.
//
// ON THE CARD it hangs where the notes hung: one small chip pegged to the card's
// lower edge, the chat's glyph and the number, which opens the plan's page. The slot pays for
// the overhang in layout (data-hang="1"), so the row below never moves. A message about the
// empty time BEFORE a plan is counted on the free time in front of it, not on the card.
// A person's paper on the free time (the rail's words): their own note colour and initials,
// read from the roster, and their name's initials when they have left it. The initials carry
// who it is; the colour only reinforces the label.
function initialsFrom(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
function noteSkin(n) {
  const m = (store.members() || []).find((x) => x && x.id === n.user_id);
  const color = (m && m.note_color) || "";
  const initials = (m && m.initials) || initialsFrom(n.user_name);
  return color
    ? { style: `--nc:${color};--nc-on:${inkOn(color) || "#ffffff"}`, initials }
    : { style: "", initials };
}

function talkHangHTML(eventId) {
  const n = store.talkAbout("event", eventId);
  if (!n) return "";
  return `<span class="ag-hang"><a class="ag-talk" href="#/e/${encodeURIComponent(eventId)}"
    aria-label="${esc(`${n} message${n === 1 ? "" : "s"} about this plan`)}">${ui("chat", "ag-talk-g")}<span class="num">${n}</span></a></span>`;
}

// ────────────────────────────────────────────────────────────────────────────────────────
// pictures
// ────────────────────────────────────────────────────────────────────────────────────────
//
// THE PICTURE BELONGS TO THE PLACE, NOT THE EVENT (migration 0003, and it is the right call):
// one stay can be three lodging events and must not carry three copies of one photograph.
//
// It is always place.image_url — the ~640px card crop — never the ~800px image_hero, on both
// the list and the event detail. sw.js precaches both tiers off /img/CREDITS.json, but the
// precache is allowed to drop the hero tier when storage is short, and one file per place
// used everywhere this module renders is the smallest promise to keep. Place detail
// (places.js) is welcome to the hero — one screen, opened deliberately.
//
// THE LICENCE GATE STAYS EVEN THOUGH THE CREDIT LINE IS GONE. Attribution moved
// to one Settings → Image credits page, which satisfies CC BY at the level of the app; it did
// not make an image with NO recorded licence safe to show. migration 0003 calls such a row a
// bug, the importer already drops them, and this refuses independently rather than trusting
// the row. The Airbnb photos import with image_license 'own' precisely so they pass here.
//
// SINCE THE PICTURES ROUTE (model §6) the photograph is the event's own picture, else its place's
// picture, else the place's old columns until the cutover moves them (shared/photo.js says which
// wins and why). A picture is one file, so it is both the card and the hero.
function shotFor(e) {
  const p = e.place_id ? store.place(e.place_id) : null;
  const shot = eventPhoto(e, p);
  return shot ? { src: shot.card } : null;
}

// alt is EMPTY on purpose. The picture is a crop of the place whose name is set in type two
// centimetres away; a screen reader announcing "The high pass" and then "The high
// pass" again is worse than an image it skips. width/height are the CSS box, so the row
// reserves its space before a single byte arrives and nothing under the thumb reflows as the
// list decodes on scroll.
function imgHTML(shot, w, h, cls) {
  return `<img class="${cls || "ag-shot"}" src="${esc(shot.src)}" alt="" width="${w}" height="${h}" loading="lazy" decoding="async">`;
}

// ────────────────────────────────────────────────────────────────────────────────────────
// model — pure, no DOM. Everything the renderer needs, computed once per paint.
// ────────────────────────────────────────────────────────────────────────────────────────

function startMs(e) { return toMs(e.starts_at); }
function endMs(e) {
  if (e.ends_at == null) return null;
  const s = startMs(e), x = toMs(e.ends_at);
  return x > s ? x : null;                       // ends_at == starts_at is a moment, not a span
}
function endZone(e) { return e.end_tz || e.tz; }

// The tz label is noise on twenty-five of twenty-seven events and load-bearing on the other
// two. CONTRACTS.md: show it where tz differs from the trip default, OR where the arrival
// zone differs from the departure zone. On a flagged event BOTH clocks get a label — the
// flight home departs in the trip's own zone, so labelling only the arrival would
// invite the reader to assume the departure is EDT too.
function tzFlagged(e, defaultTz) {
  return e.tz !== defaultTz || (e.end_tz && e.end_tz !== e.tz);
}

// Every calendar day of the trip, plus any day an event lands on outside it.
function tripDayKeys(trip, events) {
  const keys = new Set();
  if (trip && trip.starts_on && trip.ends_on) {
    const end = isoToMs(trip.ends_on);
    for (let t = isoToMs(trip.starts_on), i = 0; t <= end && i < 400; t += DAY, i++) keys.add(msToIso(t));
  }
  for (const e of events) keys.add(dayKey(e.starts_at, e.tz));
  return [...keys].filter(Boolean).sort();
}

function daysCovered(fromKey, toKey) {
  const out = [];
  const end = isoToMs(toKey);
  for (let t = isoToMs(fromKey), i = 0; t <= end && i < 60; t += DAY, i++) out.push(msToIso(t));
  return out;
}

// What an event contributes to the running "free from" mark. See decisions 2 and 3 up top.
function contributesAt(c) {
  const s = startMs(c);
  const e = endMs(c);
  if (e != null && !c.all_day && dayKey(c.ends_at, endZone(c)) === dayKey(c.starts_at, c.tz)) return e;
  return s;
}

function buildModel(now) {
  const trip = store.trip();
  const events = store.events();
  const defaultTz = (trip && trip.default_tz) || (events[0] && events[0].tz) || "UTC";

  const byKey = new Map();
  const touch = (k) => {
    let d = byKey.get(k);
    if (!d) { d = { key: k, stays: [], cards: [], rails: [], carried: [] }; byKey.set(k, d); }
    return d;
  };
  for (const k of tripDayKeys(trip, events)) touch(k);

  const spine = [];
  for (const e of events) {
    const sKey = dayKey(e.starts_at, e.tz);
    const end = endMs(e);
    // Decision 1 at the top of the file. A lodging row with no end time has no span to draw,
    // so it stays an ordinary card rather than becoming a band with nothing to say.
    if (e.kind === "lodging" && end != null) {
      const eKey = dayKey(e.ends_at, endZone(e));
      for (const k of daysCovered(sKey, eKey)) {
        touch(k).stays.push({ e, startsHere: k === sKey, endsHere: k === eKey });
      }
    } else {
      touch(sKey).cards.push(e);
      spine.push(e);
      // A PLAN THAT RUNS OVER MIDNIGHT (a night bus, a flight) is carried onto each later day it
      // reaches, as a stay is: the first screen of that day shows it, and while it is still going
      // that is what is happening now. An end at 00:00 reaches no further.
      if (end != null && !e.all_day) {
        const eKey = dayKey(e.ends_at, endZone(e));
        const atMidnight = fmtTime(e.ends_at, endZone(e)) === "00:00";
        // Onto the days the trip already has, never a new one (the flight home lands the day
        // after the trip's last, in another zone: that is not a day of the trip).
        for (const k of daysCovered(sKey, eKey)) {
          if (k === sKey || (k === eKey && atMidnight) || !byKey.has(k)) continue;
          byKey.get(k).carried.push({ e, endsHere: k === eKey });
        }
      }
    }
  }

  // THE GLOBAL RUNNING MAX, kept alongside the per-day rails rather than replacing them.
  // Rails only ever exist BETWEEN two cards of one day, so a first-card-of-the-day gap has no
  // rail — but a gap note can still be anchored to that card, and a note nobody can reach is
  // a note that may as well not have been written. freeBefore answers "what was the last
  // thing that finished before this event, anywhere in the trip", which is the only honest
  // way to measure that run-up. It is used ONLY by that fallback; the day rails below are
  // unchanged, so nothing that already rendered moves.
  spine.sort((a, b) => startMs(a) - startMs(b) || (a.id < b.id ? -1 : 1));
  const freeBefore = new Map();
  let running = null;
  for (const c of spine) {
    freeBefore.set(c.id, running);
    const at = contributesAt(c);
    running = running == null ? at : Math.max(running, at);
  }

  const days = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  const tripStart = trip && trip.starts_on ? isoToMs(trip.starts_on) : null;
  const tripEnd = trip && trip.ends_on ? isoToMs(trip.ends_on) : null;
  const total = tripStart != null && tripEnd != null ? Math.round((tripEnd - tripStart) / DAY) + 1 : 0;

  for (const d of days) {
    d.cards.sort((a, b) => startMs(a) - startMs(b) || (a.id < b.id ? -1 : 1));
    d.stays.sort((a, b) => startMs(a.e) - startMs(b.e));
    d.ms = isoToMs(d.key);
    d.n = tripStart != null && d.ms >= tripStart && d.ms <= tripEnd
      ? Math.round((d.ms - tripStart) / DAY) + 1 : 0;
    d.total = total;
    d.rails = railsFor(d.cards);
    // The lead gap only materialises when somebody has actually written about it — otherwise
    // every day would open with an "11h gap" band describing the night's sleep.
    d.lead = null;
    const first = d.cards[0];
    if (first && store.talkAbout("event", first.id, "before")) {
      const from = freeBefore.get(first.id);
      if (from != null && startMs(first) > from) {
        d.lead = { kind: "gap", from, to: startMs(first), gap: startMs(first) - from, prev: null, next: first };
      }
    }
  }

  const todayKey = dayKey(now, defaultTz);
  const first = events.length ? startMs(events[0]) : null;
  const last = events.reduce((m, e) => Math.max(m, endMs(e) ?? startMs(e)), 0) || null;
  // A trip with dates is under way from its second day on, whatever its plans say: on its third
  // day, with nothing planned until breakfast, it is not "Leaving today" (a stranger's walk, 16 Nov:
  // the head said "Not yet · Leaving today" and the agenda opened on its first day, two days back).
  // On its first day, before its first plan, it is still "Leaving today"; outside its days, or
  // without dates, the plans decide, as before.
  const onItsDays = !!(trip && trip.starts_on && trip.ends_on && todayKey > trip.starts_on && todayKey <= trip.ends_on);
  const phase = first == null ? "empty" : onItsDays ? "during"
    : now < first ? "before" : last != null && now > last ? "after" : "during";

  const model = { trip, events, defaultTz, days, todayKey, phase, first, last, now, freeBefore };
  model.live = phase === "during" ? findLive(model, now) : null;
  // "Next" is only meaningful once the trip is running. Before it starts, the lede already
  // says how far away everything is, and tagging the first flight "Next · 9d 20h" reads as
  // a countdown that has been left switched on.
  model.next = phase === "during" && !(model.live.cards.length || model.live.gap)
    ? nextUp(model, now) : null;
  return model;
}

// Connector between cards[i] and cards[i+1]. See decisions 2 and 3 at the top of the file.
//
// A TIGHT RAIL NOW CARRIES ITS MEASUREMENTS TOO. It draws as a plain rule and is not tappable
// — twelve minutes between a landing and a pickup is a doorway, not free time — but the gap
// page has to be able to describe it if a note was anchored there, and inventing the span at
// that point would mean two places computing the same number two ways.
function railsFor(cards) {
  const rails = [];
  let freeAt = null;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    freeAt = freeAt == null ? contributesAt(c) : Math.max(freeAt, contributesAt(c));

    const n = cards[i + 1];
    if (!n) break;
    // An all-day event has no inside, so nothing is measured across its edges. The trek days
    // get a plain rule between the 04:00 pickup and "The trek, day 1", not "35m gap".
    if (c.all_day || n.all_day) { rails.push({ kind: "tight", prev: c, next: n }); continue; }
    const to = startMs(n);
    const gap = to - freeAt;
    rails.push(gap >= TIGHT_MS
      ? { kind: "gap", from: freeAt, to, gap, prev: c, next: n }
      : { kind: "tight", from: freeAt, to, gap, prev: c, next: n });
  }
  return rails;
}

// THE GAP THAT ENDS AT `anchorId`, for the gap page. Reuses whatever the day rails already
// computed so the page and the rail can never disagree by a minute, and falls back to the
// lead gap for a first-card-of-the-day anchor.
function findGap(model, anchorId) {
  for (const d of model.days) {
    const i = d.cards.findIndex((c) => c.id === anchorId);
    if (i < 0) continue;
    if (i > 0) {
      const r = d.rails[i - 1];
      if (r && r.from != null) return { ...r, day: d };
      return null;                              // an all-day neighbour: there is no span to state
    }
    return d.lead ? { ...d.lead, day: d } : null;
  }
  return null;
}

// One concept, two renderings. A card is live when now is inside it; a connector is live
// when now is inside the gap it draws. They are mutually exclusive by construction — the
// gap only exists in the space no card occupies.
function findLive(model, now) {
  const cards = [];
  let gap = null;
  for (const d of model.days) {
    for (const c of d.cards) {
      const s = startMs(c);
      if (c.all_day) {
        if (dayKey(now, c.tz) === dayKey(c.starts_at, c.tz)) cards.push({ e: c, day: d, allDay: true });
        continue;
      }
      const e = endMs(c);
      const until = e ?? s + POINT_LIVE_MS;
      if (s <= now && now < until) cards.push({ e: c, day: d, allDay: false, from: s, to: e, point: e == null });
    }
    if (gap) continue;
    // d.lead is checked alongside the rails: it is a real gap that happens to have no rail
    // before it (see buildModel), and standing inside one and being told nothing is live
    // would be wrong for the same reason the rail case is.
    for (const r of [...(d.lead ? [d.lead] : []), ...d.rails]) {
      if (r.kind === "gap" && r.from <= now && now < r.to) { gap = { ...r, day: d }; break; }
    }
  }
  return { cards, gap: cards.length ? null : gap };
}

// Nothing is live: it is 02:00, or the last card of the day has finished. Point at whatever
// comes next instead of leaving the screen with no anchor at all.
function nextUp(model, now) {
  for (const d of model.days) {
    for (const c of d.cards) if (startMs(c) > now) return { e: c, day: d };
  }
  return null;
}

const liveSignature = (m) => {
  const l = m.live;
  const parts = [m.todayKey, m.phase];
  if (l && l.cards.length) parts.push("c:" + l.cards.map((x) => x.e.id).join(","));
  // A lead gap has no `prev` — nothing scheduled precedes it — so the id of the event that
  // FOLLOWS it is the only stable half of the pair, which is also how the gap is addressed.
  else if (l && l.gap) parts.push("g:" + (l.gap.prev ? l.gap.prev.id : "^") + ">" + l.gap.next.id);
  else if (m.next) parts.push("n:" + m.next.e.id);
  return parts.join("|");
};

// ── re-render hygiene ──────────────────────────────────────────────────────────────────
//
// store.js dedups "change" on the WHOLE cache, but this module renders a SLICE of it: a
// packing tick is a real change that still fires "change", and repainting the agenda for it
// re-creates every <img> — a re-created <img> repaints from cache with a visible blink,
// which causes idle image flicker. So both views fingerprint exactly what they
// read — trip, roster, events, the places those events point at, every note wall, and the
// GPS fix the distances render from — and skip the rebuild when none of it moved.
//
// One fingerprint serves both views on purpose: the gap face renders the whole model (rails
// need every event), so the detail's honest slice IS the agenda's, and a second narrower
// hash would be a second thing to keep honest.
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return `${str.length}.${(h >>> 0).toString(36)}`;
}

// WHAT THE HASH IS ALLOWED TO SEE, and why it is a projection rather than JSON.stringify.
//
// A post-mount background refresh must not emit changes the agenda treats as new;
// JSON.stringify causes that when comparing full snapshots. A snapshot that arrives from /api/trip carries
// server-side fields this screen never renders — updated_at, trip_id, created_by, whatever a
// migration adds next — and it carries them in whatever key order the JSON came in. Hashing
// the raw row therefore reports "changed" for a refresh that changed nothing anybody can see,
// and every one of those false positives cost a full repaint.
//
// So the hash reads exactly the columns the renderers read, in a fixed order, and nothing
// else. A field that appears in this list must be one some function above actually renders;
// a field that is not rendered must not be here, or the flash comes back.
const EV_K = ["id", "title", "kind", "starts_at", "ends_at", "tz", "end_tz", "all_day",
              "place_id", "detail", "url", "picture"];
const PL_K = ["id", "name", "name_local", "address", "kind", "subkind", "lat", "lng",
              "image_url", "image_license", "elevation_m", "gmaps_place_id", "picture"];
const MB_K = ["id", "note_color", "initials"];
const TR_K = ["id", "name", "starts_on", "ends_on", "default_tz"];
function pick(o, keys) {
  let out = "";
  // A picture is an object: its address is what changes when it is replaced.
  for (const k of keys) out += "\u0001" + (o && o[k] != null ? (typeof o[k] === "object" ? String(o[k].url ?? JSON.stringify(o[k])) : String(o[k])) : "");
  return out;
}
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function dataSlice() {
  const p = lastPosition();
  // Rounded to four places — about eleven metres, well under the granularity fmtDistance
  // prints. An unrounded fix wobbles on every GPS sample and would repaint the list for a
  // number that renders identically.
  const fix = p ? `${(+p.lat).toFixed(4)},${(+p.lng).toFixed(4)}` : "";
  let acc = pick(store.trip(), TR_K) + "|" + fix + "|";
  const members = typeof store.members === "function" ? (store.members() || []).slice() : [];
  for (const m of members.sort(byId)) acc += pick(m, MB_K);
  acc += "|";
  const events = store.events().slice().sort(byId);
  const places = new Map();
  for (const e of events) {
    acc += pick(e, EV_K);
    if (e.place_id && !places.has(e.place_id)) places.set(e.place_id, store.place(e.place_id) || null);
    acc += `~${store.talkAbout("event", e.id)}:${store.talkAbout("event", e.id, "before")}`;
  }
  acc += "|";
  for (const k of [...places.keys()].sort()) acc += pick(places.get(k), PL_K);
  const linked = typeof store.purchases === "function"
    ? (store.purchases() || []).filter((p) => !p.deleted_at && p.event_id).sort(byId)
    : [];
  acc += "|" + packSlice()
    + "|" + linked.map((p) => `${p.id}:${p.event_id}:${p.description}:${p.amount_minor}:${p.currency}:${p.paid_by}`).join(",");
  return fnv(acc);
}

// ────────────────────────────────────────────────────────────────────────────────────────
// agenda rendering
// ────────────────────────────────────────────────────────────────────────────────────────

// Suppressed when the place name is just the title again.
function pinLine(place, e) {
  if (!place) return "";
  if (e && String(place.name).trim() === String(e.title).trim()) return "";
  return `<span class="ag-where">${ui("near")}<span class="ag-where-t">${esc(place.name)}</span></span>`;
}

function timeLine(e, model) {
  if (e.all_day) return `<span class="ag-t">All day</span>`;
  const flag = tzFlagged(e, model.defaultTz);
  const en = endMs(e);
  // Each end is one piece (.ag-end): a time, its zone, its weekday, and for the second end the
  // arrow before it. On a narrow card the line breaks BETWEEN the ends, never inside one: a
  // zone chip alone on the next line reads as belonging to nothing.
  let html = `<span class="ag-end"><span class="ag-t num">${esc(fmtTime(e.starts_at, e.tz))}</span>`;
  if (flag) html += `<span class="ag-tz">${esc(zoneChip(e.starts_at, e.tz))}</span>`;
  html += `</span>`;
  if (en != null) {
    const ez = endZone(e);
    const crosses = dayKey(e.ends_at, ez) !== dayKey(e.starts_at, e.tz);
    html += `<span class="ag-end"><span class="ag-to">→</span><span class="ag-t2 num">${esc(fmtTime(e.ends_at, ez))}</span>`;
    if (flag) html += `<span class="ag-tz">${esc(zoneChip(e.ends_at, ez))}</span>`;
    if (crosses) html += `<span class="ag-t2">${esc(dow(e.ends_at, ez))}</span>`;
    html += `</span>`;
  }
  return html;
}

// A photograph is shown (16:9 card media) only when the plan or place has a photo.
function mediaHTML(shot) {
  if (!shot) return "";
  return `<span class="ag-media ag-media-hero ag-pic">${imgHTML(shot, 320, 180)}</span>`;
}

function cardHTML(e, model, live, isNext, isHero, isPast = false) {
  const place = e.place_id ? store.place(e.place_id) : null;
  const shot = shotFor(e);
  const hero = !!(isHero && shot);
  const attrs = [`data-live="${live ? 1 : 0}"`];
  if (isNext) attrs.push(`data-next="1"`);
  if (isPast && !live) attrs.push(`data-past="1"`);
  if (live && live.e.id) attrs.push(`data-liveid="${esc(e.id)}"`);

  let badge = "";
  let fill = "";
  if (live) {
    if (live.allDay) badge = `<span class="ag-livepill">Today</span>`;
    else if (live.point) badge = `<span class="ag-livepill">Now</span>`;
    else {
      const pct = Math.max(0, Math.min(100, ((model.now - live.from) / (live.to - live.from)) * 100));
      badge = `<span class="ag-livepill ag-cd">${esc(fmtSpan(live.to - model.now))} left</span>`;
      fill = `<span class="ag-fill" style="width:${pct.toFixed(2)}%"></span>`;
    }
  } else if (isNext) {
    badge = `<span class="ag-nextpill">Next · ${esc(fmtSpan(startMs(e) - model.now))}</span>`;
  }

  const dist = live ? "" : distHTML(place);
  const hang = talkHangHTML(e.id);
  if (hang) attrs.push(`data-hang="1"`);

  // The chat chip is a SIBLING of the card's anchor, never a child: an <a> inside an <a> is
  // invalid and unreachable.
  return `<li class="ag-slot" data-k="c:${esc(e.id)}" style="${planToneVars(e, place)}" ${attrs.join(" ")}>
  <a class="ag-card${hero || shot ? " ag-card-hero" : ""}" href="#/e/${encodeURIComponent(e.id)}">
    <span class="ag-when">${timeLine(e, model)}</span>
    <span class="ag-cardbody">
      ${fill}
      ${badge || dist ? `<span class="ag-headend">${badge}${dist}</span>` : ""}
      <span class="ag-title">${esc(e.title)}</span>
      ${pinLine(place, e)}
    </span>
    <span class="ag-kind">${kindIcon(e, place, { cls: "ag-kind-g" })}</span>
    ${mediaHTML(shot)}
  </a>
  ${hang}
</li>`;
}

const railKey = (r) => `r:${r.prev ? r.prev.id : "^"}>${r.next ? r.next.id : "$"}`;

function gapTalkHTML(total) {
  if (!total) return "";
  return `<span class="ag-talk ag-talk-gap" aria-hidden="true">${ui("chat", "ag-talk-g")}<span class="num">${total}</span></span>`;
}
const gapTalkWords = (total) => (total ? `, ${total} message${total === 1 ? "" : "s"} about this time` : "");

function railHTML(r, model, isLive) {
  const key = esc(railKey(r));
  const total = r.next ? store.talkAbout("event", r.next.id, "before") : 0;
  if (r.kind === "tight" && !total) return `<li class="ag-rail ag-rail-tight" data-k="${key}"></li>`;

  const href = `#/e/${encodeURIComponent(r.next.id)}?gap=1`;
  const talk = gapTalkHTML(total);
  const gapAttr = `data-gap-open="${esc(r.next.id)}"`;

  if (!isLive) {
    const tight = r.kind === "tight";
    const label = tight
      ? `Before ${esc(clip(r.next.title, 24))}`
      : `${esc(fmtSpan(r.gap))} free`;
    return `<li class="ag-rail${tight ? " ag-rail-tight" : ""}" data-k="${key}">
  <a class="ag-gaplink" href="${href}" ${gapAttr}${total ? ` aria-label="${esc(`${tight ? `Before ${r.next.title}` : `${fmtSpan(r.gap)} free`}${gapTalkWords(total)}`)}"` : ""}>
    <i class="ag-gaprail" aria-hidden="true"></i>
    <span class="ag-gaprow"><span class="ag-gap">${label}</span>${talk}${ui("chev", "ag-chev")}</span>
  </a>
</li>`;
  }
  const left = r.to - model.now;
  const frac = Math.max(0, Math.min(1, left / (r.to - r.from)));
  return `<li class="ag-rail ag-rail-live" data-k="${key}" data-liverail="1">
  <span class="ag-drain" style="transform:scaleY(${frac.toFixed(5)})"></span>
  <a class="ag-gaplink ag-nowgap" href="${href}" ${gapAttr}>
    <i class="ag-nowdot" aria-hidden="true"></i>
    <span class="ag-nowgap-row">
      <span class="ag-nowgap-t">Now</span>
      <span class="ag-nowgap-sub"><span class="ag-cd">${esc(fmtSpan(left))}</span> until ${esc(clip(r.next.title, 26))}</span>
      <span class="ag-nowrule" aria-hidden="true"></span>
      ${talk}
      ${ui("chev", "ag-chev")}
    </span>
  </a>
</li>`;
}

// PACK FOR TODAY. A packing list "for the day" (repeat: "daily") is packed where the day is
// read: at the top of each of its days, above the stays. On the trip's today it is the list
// itself, ticked right here, and a tick here is the tick Pack shows (store.tickPacking, the
// same write, waiting on the phone with no signal like any other). On its other days it is
// one line: what was packed on a day gone, how many things on a day to come, and the way to
// the list. A day that is none of its days shows nothing.
//
// Your own things and the group's, which anyone may tick (store.packMine); someone else's
// are theirs to pack and are not here. A list that carries nothing of either shows nothing:
// a band that says "0 of 0" is a chore, not a reminder.
// A list ticked full here stays open on this visit, so the last row isn't taken from under the
// finger that ticked it; packed already when the Itinerary opens, the band is its one line (the
// rows would stand between the person and the day's plans, and the line still opens Pack).
const tickedHere = new Set();
const PACK_SUN = '<circle cx="12" cy="12" r="3.6"/><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7"/>';
const PACK_TICK = '<path d="m5 12.5 4.5 4.5L19 7.5"/>';
const PACK_CHECK = '<svg class="ag-pk-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5 9.5 17.5 19.5 6.5"/></svg>';

/** Is `day` one of a list for the day's days? store.packDay's rule, for any day. */
function packsOn(list, day, trip) {
  if (list.dates) return list.dates.includes(day);
  if (trip && trip.starts_on && trip.ends_on) return day >= trip.starts_on && day <= trip.ends_on;
  return true;
}

/** The lists for the day that are packed on `day`, each with your things and the group's on it. */
function packsFor(day) {
  const me = store.me();
  if (!me || !me.id) return [];
  const trip = store.trip();
  const things = [...store.packing(me.id), ...store.packing("group")];
  const out = [];
  for (const list of store.packLists()) {
    if (list.repeat !== "daily" || !packsOn(list, day, trip)) continue;
    const at = store.packDay(list.key);
    const rows = [];
    for (const item of things) {
      const bag = list.bags.find((b) => b.key === store.packBag(item.id, list.key));
      if (!bag) continue;
      rows.push({ item, bag, done: store.packTicked(item.id, list.key, day), group: item.owner === "group" });
    }
    if (rows.length) out.push({ list, day, rows, open: at.open && at.day === day, past: !!at.day && day < at.day });
  }
  return out;
}

function packHTML(p) {
  const total = p.rows.length;
  const done = p.rows.filter((r) => r.done).length;
  const all = done === total;
  const href = `#/pack?list=${encodeURIComponent(p.list.key)}`;
  // Packed is a tick AND the words; not packed is the sun and the count. Never the hue alone.
  const glyph = (tick) => `<span class="ag-stay-shot ag-stay-tile"><svg class="ico ag-stay-g ag-pk-g" viewBox="0 0 24 24" aria-hidden="true">${tick ? PACK_TICK : PACK_SUN}</svg></span>`;
  const count = all ? `all ${total} packed` : `${done} of ${total} packed`;
  if (p.open && all && !tickedHere.has(p.list.key)) {
    return `<div class="ag-staywrap" data-k="pk:${esc(p.list.key)}">
  <a class="ag-stay ag-pk" href="${href}" data-packed="1">
    ${glyph(true)}
    <span class="ag-stay-body">
      <span class="ag-stay-name">Pack for today</span>
      <span class="ag-stay-meta">${esc(p.list.name)} · ${count}</span>
    </span>
    ${ui("chev", "ag-chev")}
  </a>
</div>`;
  }
  if (!p.open) {
    const meta = p.past ? count : `${total} ${total === 1 ? "thing" : "things"}`;
    return `<div class="ag-staywrap" data-k="pk:${esc(p.list.key)}">
  <a class="ag-stay ag-pk" href="${href}"${p.past && all ? ' data-packed="1"' : ""}>
    ${glyph(p.past && all)}
    <span class="ag-stay-body">
      <span class="ag-stay-name">Pack for the day</span>
      <span class="ag-stay-meta">${esc(p.list.name)} · ${meta}</span>
    </span>
    ${ui("chev", "ag-chev")}
  </a>
</div>`;
  }
  // One bag on the list says nothing on each row; two or more, and each row names its own.
  const bags = p.list.bags.length > 1;
  const rows = p.rows.map((r) => {
    const meta = [r.group ? "The group's" : "", bags ? r.bag.name : ""].filter(Boolean).join(" · ");
    return `<li><button type="button" class="ag-pk-i" data-pack-tick="${esc(r.item.id)}" data-pack-list="${esc(p.list.key)}" data-pack-day="${esc(p.day)}" aria-pressed="${r.done}"${r.done ? ' data-done="1"' : ""}>
      <span class="ag-pk-box">${PACK_CHECK}</span>
      <span class="ag-pk-l">${esc(r.item.label)}${r.item.qty > 1 ? ` <span class="ag-pk-q">×${esc(r.item.qty)}</span>` : ""}</span>
      ${meta ? `<span class="ag-pk-m">${esc(meta)}</span>` : ""}
    </button></li>`;
  }).join("");
  return `<div class="ag-staywrap ag-pk-today" data-k="pk:${esc(p.list.key)}">
  <a class="ag-stay ag-pk" href="${href}"${all ? ' data-packed="1"' : ""}>
    ${glyph(all)}
    <span class="ag-stay-body">
      <span class="ag-stay-name">Pack for today</span>
      <span class="ag-stay-meta">${esc(p.list.name)} · ${count}</span>
    </span>
    ${ui("chev", "ag-chev")}
  </a>
  <ul class="ag-pk-list" aria-label="${esc(p.list.name)}, to pack today">${rows}</ul>
</div>`;
}

/** What the bands read, for dataSlice(): a tick, a bag or a list changing repaints the day. */
function packSlice() {
  const me = store.me();
  if (!me || !me.id) return "";
  const daily = store.packLists().filter((l) => l.repeat === "daily");
  if (!daily.length) return "";
  let acc = JSON.stringify(daily.map((l) => [l.key, l.name, l.dates || null, l.bags.map((b) => [b.key, b.name])]));
  const things = [...store.packing(me.id), ...store.packing("group")].sort(byId);
  for (const l of daily) {
    const at = store.packDay(l.key);
    acc += `|${l.key}:${at.day}:${at.open}`;
    for (const item of things) {
      const bag = store.packBag(item.id, l.key);
      if (!bag) continue;
      acc += `;${item.id},${item.label},${item.qty || ""},${bag}`;
      if (at.day && store.packTicked(item.id, l.key, at.day)) acc += ",t";
    }
  }
  // A day gone says what was packed on it: its ticks are read where they are drawn, and they
  // only change on the day itself, which the line above already follows.
  return acc;
}

// A PLAN CARRIED ONTO A LATER DAY (one that runs over midnight): a band at the top of the day,
// built as a stay's band is. While it is still going: "Still going: Night bus to …", "Arrives
// 02:45"; otherwise when it began and when it ends. It opens the plan.
function carriedHTML(c, model) {
  const e = c.e, ez = endZone(e);
  const place = e.place_id ? store.place(e.place_id) : null;
  const now = model.now, start = startMs(e), end = endMs(e);
  const going = now >= start && end != null && now < end;
  const verb = e.kind === "flight" || e.kind === "transit" ? "arrives" : "until";
  const ends = `${c.endsHere ? "" : `${dow(e.ends_at, ez)} `}${fmtTime(e.ends_at, ez)}`;
  const meta = going ? `${verb === "arrives" ? "Arrives" : "Until"} ${ends}`
    : `From ${dow(e.starts_at, e.tz)} ${fmtTime(e.starts_at, e.tz)} · ${verb} ${ends}`;
  return `<div class="ag-staywrap" data-k="g:${esc(e.id)}" style="${planToneVars(e, place)}">
  <a class="ag-stay ag-carried" href="#/e/${encodeURIComponent(e.id)}"${going ? ' data-going="1"' : ""}>
    <span class="ag-stay-body">
      <span class="ag-stay-name">${going ? "Still going: " : ""}${esc(e.title)}</span>
      <span class="ag-stay-meta">${meta}</span>
    </span>
    <span class="ag-kind ag-stay-kind" aria-hidden="true">${kindIcon(e, place, { cls: "ag-kind-g" })}</span>
    ${ui("chev", "ag-chev")}
  </a>
</div>`;
}

// A STAY IS NAMED BY WHAT HAPPENS THAT DAY: "Check in · <stay>" on its first day, "Staying at <stay>" on the nights
// between, "Check out · <stay>" on its last (a stay's title often says "Check in: …" itself, which on the day you leave
// read as the wrong thing). The stay is its title with any such word in front taken off, or its place's name.
const STAY_WORD = /^\s*(?:check[\s-]*(?:in|out)|stay(?:ing)?(?:\s+at)?|lodging)\s*[:\-–—·]?\s+/i;
function stayName(e, place) {
  const t = String(e.title || "").replace(STAY_WORD, "").trim();
  return t || (place && place.name) || String(e.title || "");
}
function stayWords(s, place) {
  const e = s.e, ez = endZone(e), name = stayName(e, place);
  const inAt = e.all_day ? "" : fmtTime(e.starts_at, e.tz), outAt = e.all_day ? "" : fmtTime(e.ends_at, ez);
  const outDay = dow(e.ends_at, ez);
  if (s.startsHere && s.endsHere) return { name, meta: e.all_day ? "" : `In ${inAt} · out ${outAt}` };
  if (s.startsHere) return { name: `Check in · ${name}`, meta: e.all_day ? `Until ${outDay}` : `${inAt} · out ${outDay} ${outAt}` };
  if (s.endsHere) return { name: `Check out · ${name}`, meta: e.all_day ? "Today" : `By ${outAt}` };
  return { name: `Staying at ${name}`, meta: e.all_day ? `Until ${outDay}` : `Until ${outDay} ${outAt}` };
}

/** A stay's row: at the top of a night it runs through (a div among the day's stays), or in time order among the plans
 * on the day it starts or ends (an li in the day's list: inList). */
function stayHTML(s, inList = false) {
  const e = s.e;
  const place = e.place_id ? store.place(e.place_id) : null;
  const shot = shotFor(e);
  const words = stayWords(s, place);
  const trailing = shot
    ? `<span class="ag-stay-shot">${imgHTML(shot, 28, 28, "ag-stay-img")}</span>`
    : `<span class="ag-kind ag-stay-kind" aria-hidden="true">${kindIcon(e, place, { cls: "ag-kind-g" })}</span>`;
  const hang = talkHangHTML(e.id);
  const tag = inList ? "li" : "div";
  return `<${tag} class="ag-staywrap${inList ? " ag-staywrap-in" : ""}" data-k="s:${esc(e.id)}" style="${planToneVars(e, place)}"${hang ? ' data-hang="1"' : ""}>
  <a class="ag-stay" href="#/e/${encodeURIComponent(e.id)}">
    <span class="ag-stay-body">
      <span class="ag-stay-name">${esc(words.name)}</span>
      ${words.meta ? `<span class="ag-stay-meta">${esc(words.meta)}</span>` : ""}
    </span>
    ${distHTML(place, "ag-stay-dist")}
    ${trailing}
  </a>
  ${hang}
</${tag}>`;
}

// ────────────────────────────────────────────────────────────────────────────────────────
// which card gets the day's one banner
// ────────────────────────────────────────────────────────────────────────────────────────
//
// ONE BANNER PER DAY, and it is the day's MOST SIGNIFICANT MOMENT — not its first, which is
// what this used to be. First-imaged is stable and never embarrassing, but on a trek day it hands
// the banner to a 06:15 walking transition into the forest, while THE HIGH PASS — the high
// point of the entire trek and the thing the whole day is
// about — gets a 100px thumbnail. A day that opens on its own establishing shot is worth more
// than a day that opens on whatever happened to be photographed first.
//
// There is no significance column, so the score is built from four signals that are all in
// the data, weighted so that the strong ones cannot be outvoted by the weak ones:
//
//   1. EVENT KIND — is this a thing you do, or the tissue between things? An 'activity' or the
//      day's 'flight' is the day; 'transit', 'lodging' and 'plan' are how you got there and
//      what you must not forget. 'plan' scores zero, which is what stops a day opening on
//      "Get the train tickets" — that row hangs off the day's great sight and
//      would otherwise inherit all of its weight.
//   2. PLACE KIND — a 'sight' is a place that exists to be gone to. This is the signal
//      is_anchor is often mistaken for; is_anchor is true of every hotel, airport and
//      restaurant in the trip and false of every single point on the trail, so it marks
//      "fixed logistics", not "worth seeing", and is deliberately not used here.
//   3. ELEVATION PROMINENCE — on a trek day the high point IS the day. Scored relative to the
//      day's own range, so it says nothing on a day with no vertical range (city places carry
//      elevation_m 0, which is "unknown" here and never "sea level"), and capped below the two
//      kind signals so it tie-breaks between sights rather than overriding what a thing is.
//      Without that cap a day opens on a station transfer that happens to stand high up
//      instead of on the sight the day is for.
//   4. DURATION — mild and capped at two hours, so a fifty-minute ruin outranks a ten-minute
//      one without an eight-hour "luggage gap" ever winning a day.
//
// Only a card with a photograph can be a hero: the treatment IS a 16:9 photograph, and the
// typed tiles are built for the 100px thumb box. Exactly one card per day wins, by strict
// greater-than over the day's cards in time order, so ties go to the earlier moment and the
// result is deterministic. Nothing here reads the clock, so the minute tick can still never
// resize a card.
const HERO_EVENT_W = { activity: 4, flight: 4, meal: 2, transit: 1, lodging: 1, plan: 0 };
const HERO_PLACE_W = { sight: 3, activity: 1, food: 1, drink: 1, lodging: 0, transit: 0, practical: 0 };
const HERO_ELEV_MAX = 2;      // below the 3 a 'sight' earns: altitude ranks sights, it does not create them
const HERO_DUR_MAX = 1;

const elevOf = (e) => {
  const p = e.place_id ? store.place(e.place_id) : null;
  const m = p ? Number(p.elevation_m) : 0;
  return Number.isFinite(m) && m > 0 ? m : 0;    // 0 in the data means "not recorded"
};

function heroScore(e, lo, span) {
  const p = e.place_id ? store.place(e.place_id) : null;
  let s = (HERO_EVENT_W[kindOf(e)] || 0) + (p ? (HERO_PLACE_W[p.kind] || 0) : 0);
  const m = elevOf(e);
  if (span > 0 && m > 0) s += HERO_ELEV_MAX * ((m - lo) / span);
  const st = startMs(e), en = endMs(e);
  if (en != null) s += Math.min(HERO_DUR_MAX, (en - st) / (2 * HOUR));
  return s;
}

function heroPick(cards) {
  const shot = cards.filter((c) => shotFor(c));
  if (!shot.length) return null;
  // The range is taken over the candidates only, and only over recorded elevations: one lone
  // number is no range at all, and a city place at 0 must not drag the floor to sea level.
  const known = shot.map(elevOf).filter((m) => m > 0);
  const lo = known.length ? Math.min(...known) : 0;
  const hi = known.length ? Math.max(...known) : 0;
  const span = known.length > 1 && hi > lo ? hi - lo : 0;
  let best = null, bestScore = -Infinity;
  for (const c of shot) {
    const s = heroScore(c, lo, span);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best.id;
}

// A day, as KEYED PARTS rather than one string. Every row the day contains carries a stable
// key — the event it is about, or the pair a rail joins — so a repaint can recognise a row it
// has already drawn and leave that row's live DOM (and its already-decoded <img>) alone. See
// patchKeyed() in the agenda view for what consumes this; keeping rows and images untouched
// across refreshes is why it exists in this shape.
const cardKey = (e) => `c:${e.id}`;

function dayParts(d, model) {
  const isToday = d.key === model.todayKey;
  const isPast = !!model.todayKey && d.key < model.todayKey;
  const live = model.live;
  const liveById = new Map();
  if (live) for (const c of live.cards) liveById.set(c.e.id, c);
  const nextId = model.next ? model.next.e.id : null;
  const liveRail = live && live.gap ? live.gap : null;
  const isLiveRail = (r) => !!(liveRail && liveRail.prev === r.prev && liveRail.next === r.next);

  const heroId = heroPick(d.cards);

  // A TIMED STAY TAKES ITS PLACE IN THE DAY on the day it starts (at its check-in) and the day it ends (at its
  // check-out): checking in at 15:00 comes after the 11:30 car pick-up, not above it. On the nights between, and for a
  // stay with no times, it stays at the top of the day. It still adds nothing to the day's gaps (decision 1).
  const timedHere = (s) => !s.e.all_day && (s.startsHere || s.endsHere);
  const stayAt = (s) => (s.startsHere ? startMs(s.e) : endMs(s.e));
  const placed = d.stays.filter(timedHere).sort((a, b) => stayAt(a) - stayAt(b));
  const rows = [];
  let k = 0;
  // At the same minute as a plan, a check-out goes first (you leave, then go) and a check-in after.
  const before = (s, t) => (s.startsHere ? stayAt(s) < t : stayAt(s) <= t);
  const staysBefore = (t) => { while (k < placed.length && (t == null || before(placed[k], t))) { rows.push([`s:${placed[k].e.id}`, stayHTML(placed[k], true)]); k++; } };
  if (d.cards.length) staysBefore(startMs(d.cards[0]));
  if (d.lead) rows.push([railKey(d.lead), railHTML(d.lead, model, isLiveRail(d.lead))]);
  // One that falls while a plan is on (a check-in at 15:00 during a 15:00-16:00 boat) stands right after that plan,
  // BEFORE its free time: placed before the next plan, it stood under "30m free" and read as happening then (27 Nov).
  const staysWithin = (c, nextStart) => {
    const end = endMs(c);
    if (end == null) return;
    while (k < placed.length && stayAt(placed[k]) < end && (nextStart == null || stayAt(placed[k]) < nextStart)) {
      rows.push([`s:${placed[k].e.id}`, stayHTML(placed[k], true)]); k++;
    }
  };
  for (let i = 0; i < d.cards.length; i++) {
    const c = d.cards[i];
    if (i) staysBefore(startMs(c));
    rows.push([cardKey(c), cardHTML(c, model, liveById.get(c.id) || null, c.id === nextId, c.id === heroId, isPast)]);
    staysWithin(c, i + 1 < d.cards.length ? startMs(d.cards[i + 1]) : null);
    const r = d.rails[i];
    if (r) rows.push([railKey(r), railHTML(r, model, isLiveRail(r))]);
  }
  staysBefore(null);
  if (!d.cards.length && !placed.length) rows.push(["none", `<li class="ag-nothing" data-k="none">Nothing scheduled.</li>`]);

  return {
    key: d.key,
    today: isToday,
    past: isPast,
    // The heading's INNER html only: the <h2> element itself survives every repaint, because
    // it carries data-pinned — the sticky-shadow state the scroll spy writes onto it.
    head: `<span class="ag-dayhead-date">${isToday ? `Today, ${esc(fmtDay(d.ms, "UTC"))}` : esc(fmtDay(d.ms, "UTC"))}</span>` +
      (d.n ? `<span class="ag-dayhead-n">Day ${d.n}${d.total ? ` of ${d.total}` : ""}</span>` : ""),
    stays: [
      ...(d.carried || []).map((c) => [`g:${c.e.id}`, carriedHTML(c, model)]),
      ...packsFor(d.key).map((p) => [`pk:${p.list.key}`, packHTML(p)]),
      ...d.stays.filter((s) => !timedHere(s)).map((s) => [`s:${s.e.id}`, stayHTML(s)]),
    ],
    rows,
  };
}

function stripPills(model) {
  return model.days.map((d) => {
    const cls = ["ag-pill"];
    if (d.key === model.todayKey) cls.push("ag-pill-today");
    if (!d.cards.length && !d.stays.length) cls.push("ag-pill-bare");
    const label = fmtDay(d.ms, "UTC");            // "Tue Jun 1"
    const bits = label.split(" ");
    return [`p:${d.key}`, `<button type="button" class="${cls.join(" ")}" data-k="p:${esc(d.key)}" data-jump="${esc(d.key)}"
      aria-label="${esc(label)}"><span class="ag-pill-dow">${esc(bits[0])}</span><span
      class="ag-pill-num num">${esc(bits[2] || "")}</span></button>`];
  });
}

function ledeHTML(model) {
  if (model.phase === "before") {
    const startsKey = model.trip && model.trip.starts_on ? model.trip.starts_on : model.days[0].key;
    const days = Math.max(0, Math.round((isoToMs(startsKey) - isoToMs(model.todayKey)) / DAY));
    const e = model.events[0];
    const flag = e && tzFlagged(e, model.defaultTz);
    return `<div class="ag-lede">
  <span class="ag-lede-big">${days === 0 ? "Starts today" : days === 1 ? "Starts tomorrow" : `Starts in ${days} days`}</span>
  ${e ? `<span class="ag-lede-sub">First: ${esc(clip(e.title, 46))}, ${esc(fmtDay(e.starts_at, e.tz))}${
      e.all_day ? "" : ` at ${esc(fmtTime(e.starts_at, e.tz))}${flag ? ` ${esc(zoneChip(e.starts_at, e.tz))}` : ""}`}</span>` : ""}
</div>`;
  }
  if (model.phase === "after") {
    const n = model.events.length;
    return `<div class="ag-lede">
  <span class="ag-lede-eyebrow">Home</span>
  <span class="ag-lede-big">That was ${esc(clip((model.trip && model.trip.name) || "the trip", 28))}</span>
  <span class="ag-lede-sub">${model.days.length} days, ${n} plan${n === 1 ? "" : "s"}.</span>
</div>`;
  }
  return "";
}

function agendaParts(model) {
  if (!model.events.length) {
    if (!model.trip) {
      return {
        empty: `<div class="empty ds">
  <h2 class="ds-h2">No itinerary yet</h2>
  <p class="ds-body">Waiting for signal.</p>
</div>`,
      };
    }
    const head = `<header class="ds-head ag-tripname-head"><h1 class="ag-tripname-t ag-tripname-flow ds-h1">${esc(model.trip.name || "")}</h1><div class="ds-head-end"></div></header>`;
    const guest = !!store.me()?.guest;
    if (!guest && !store.places().length) {
      const people = typeof store.members === "function" ? store.members().filter((m) => !m.left_at).length : 0;
      return { ways: true, empty: `${head}<div class="empty ag-empty-ways">${emptyWaysHTML(true, { trip: model.trip, people, invite: true })}</div>` };
    }
    return {
      empty: `${head}<div class="empty ds">
  <h2 class="ds-h2">No plans yet</h2>
  <p class="ds-body">This trip's itinerary is empty.</p>
  <button type="button" class="ds-button ds-button--white ds-button--lg" data-plan-add>Add a plan</button>
  <p class="ag-empty-ai">${store.me()?.guest ? GUEST_AI_LINE : `An AI app can fill the trip in too. Connect one from <a href="/account#ai-apps">Your account</a>.`}</p>
</div>`,
    };
  }
  return {
    title: (model.trip && model.trip.name) || "",
    pills: stripPills(model),
    lede: ledeHTML(model),
    days: model.days.map((d) => dayParts(d, model)),
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────
// agenda view
// ────────────────────────────────────────────────────────────────────────────────────────

// ── THE AGENDA'S DOM OUTLIVES ITS MOUNT ───────────────────────────────────────────────────
//
// Coming back from an event is not a repaint. router.js does el.replaceChildren() and calls
// this module again, so every <img> on the screen is a NEW ELEMENT with no decoded bytes: 57
// of them go blank and fill in together. Measured from a screencast of a real back — texture
// across the list falls to 3% of its settled value and stays under half for 13 frames of 41,
// about 200ms of an agenda with no photographs on it. That is the report exactly, and no
// amount of keyed patching could ever have reached it: the patcher only runs once there is
// something to patch, and here there was nothing.
//
// So the tree is kept. On unmount it is filed here; on the next mount, if it is still around
// and attached to nothing, it is put straight back — the same nodes, the same <img> elements,
// the same decoded pixels. Measured on the same screencast rig: detaching this root and
// re-attaching it costs ZERO image load events and the photographs do not drop a single
// frame (texture 100% throughout).
//
// isConnected is the whole guard. A root still in the document is a root the pop animation is
// showing in its ghost, and stealing it would blank the outgoing screen mid-slide; that case
// simply builds fresh, which is what always used to happen.
let kept = null;
// THE DAY BEING READ, per trip, while this page lives (memory only, never stored): coming back to
// the Agenda from any section returns to it, if the day is still on the trip, within half an
// hour of leaving and on the same day in the trip's zone. Past that it places as a first visit
// does (now or next): a Home Screen app stays open for days, and nobody should open it on
// Thursday at Tuesday's plans.
const READ_MS = 30 * 60 * 1000;
const readDays = new Map();       // trip id -> { day, at (ms), today (the trip's day then) }

function mountAgenda(el, ctx) {
  tickedHere.clear();               // a new visit: a list packed in full is its one line again
  const reused = kept && kept.root && !kept.root.isConnected ? kept : null;
  const root = reused ? reused.root : document.createElement("div");
  if (!reused) root.className = "ag ds";
  el.append(root);

  let model = buildModel(Date.now());
  let sig = "";
  let slice = "";                   // dataSlice() as of the last paint
  let didPlace = false;
  // A re-place is due (back past the limits: placed as a first visit once the router has re-asserted its offset). Until
  // it runs no other paint may place: a repaint in that window (the location row's, 21 Nov) used to take the "back"
  // path with the list still at the router's offset, and the re-place then found it placed and left the list at the top.
  let replaceDue = false;
  let dead = false;
  // The first-mount stagger has run (first mount ONLY). A REUSED tree counts as
  // already entered: those sections did not arrive, they were never gone, and fading them up
  // 8px again on top of the router's own pop slide is two animations for one arrival.
  let entered = !!reused;

  // ── THE DOM PATCHER ────────────────────────────────────────────────────────────────────
  //
  // The fault as it was seen: the agenda looks right for about half a second, then the day
  // strip animates back over to the first date and back to where it was, and AT THAT MOMENT
  // every on-screen image flashes. One cause, three symptoms. A post-mount background refresh
  // reported a change (see dataSlice() above for the half of the fix that stops it reporting
  // one at all), and the repaint that followed rewrote whole day sections and the whole strip.
  // Rewriting a section re-creates its <img> elements, which re-decode together — the
  // synchronised flash. Rewriting the strip throws away the scrollLeft the reader set with
  // their thumb and drops the pill's highlight, and the scroll spy then re-lights and
  // re-centres it: the strip travelling to date one and back.
  //
  // So the unit of a repaint is the ROW now — a card, a rail, a stay band, a pill — and there
  // is exactly ONE code path, used from the first frame onwards. That is not tidiness: a path
  // that only runs sometimes is a path whose idempotence nobody ever exercises, and this
  // screen has to be idempotent the ten-thousandth time.
  //
  // THREE RULES. Every symptom above is one of them being broken:
  //
  //   1. A row whose HTML is byte-identical to what is already there IS NOT TOUCHED — not
  //      rebuilt, not re-inserted, not re-attributed. A refresh that changes nothing visible
  //      performs zero mutations, so there is nothing to see.
  //   2. A row that genuinely changed is MORPHED, not replaced. Its live nodes stay exactly
  //      where they are and only the attributes and text that actually differ are written.
  //      Adopting the <img> elements into a rebuilt subtree was tried first and is not
  //      enough: re-inserting an <img> re-runs the image-data algorithm, so the load event
  //      fires again and the picture repaints — measured, two loads for one note being added
  //      and then withdrawn. A node that never moves cannot do that.
  //   3. THE STRIP ELEMENT IS NEVER REPLACED. It is a scroller and its scrollLeft is a
  //      reading position, which makes it UI state — kept across every re-render, exactly as
  //      #view's own scrollTop is.
  const build = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  // Rule 2. Walk the live node `a` and the freshly built `b` in step, writing only what
  // differs. Positional rather than keyed, which is the right trade at this scale: a card's
  // shape is fixed markup and the pieces that come and go — a badge, a distance, a hanging
  // note — are siblings in a known order, so the alignment holds and the cost is a handful of
  // nodes per changed row.
  //
  // THE ATTRIBUTE GUARD IS THE WHOLE POINT. setAttribute("src", theSameString) re-runs the
  // image-data algorithm and repaints the picture, so an unconditional attribute copy would be
  // the flash again by a different route. Nothing is written unless it differs.
  //
  // What this deliberately does NOT do is preserve attributes the renderer did not emit — it
  // cannot, or a stale state could never clear. The two that matter both re-assert themselves
  // in the same frame: syncActive() puts the pill's highlight back after the strip is patched,
  // and tweenDrain() re-aims the live rail's bar after every paint.
  function morph(a, b) {
    if (a.nodeType !== b.nodeType || (a.nodeType === 1 && a.tagName !== b.tagName)) {
      a.replaceWith(b);
      return b;
    }
    if (a.nodeType !== 1) { if (a.data !== b.data) a.data = b.data; return a; }
    for (const at of [...a.attributes]) if (!b.hasAttribute(at.name)) a.removeAttribute(at.name);
    for (const at of b.attributes) if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    let ac = a.firstChild, bc = b.firstChild;
    while (ac && bc) {
      const an = ac.nextSibling, bn = bc.nextSibling;
      morph(ac, bc);
      ac = an; bc = bn;
    }
    while (ac) { const n = ac.nextSibling; ac.remove(); ac = n; }
    while (bc) { const n = bc.nextSibling; a.appendChild(bc); bc = n; }
    return a;
  }

  // Reconcile one parent's keyed children against `rows` — [key, html] pairs — given `prev`,
  // the map of what each key rendered as last time. Children carrying no data-k (the strip's
  // travelling ring) are stepped over and never removed. Returns the new key -> html map.
  //
  // The order pass at the end only ever calls insertBefore on a node that is in the wrong
  // place. That matters as much as rule 1 does: re-inserting an <img>'s ancestor is a
  // re-attach, and a re-attached image can repaint.
  function patchKeyed(parent, rows, prev) {
    const have = new Map();
    for (const n of parent.children) { const k = n.dataset ? n.dataset.k : null; if (k) have.set(k, n); }
    const out = [];
    const next = new Map();
    for (const [k, html] of rows) {
      next.set(k, html);
      const old = have.get(k);
      if (old && prev.get(k) === html) { have.delete(k); out.push(old); continue; }
      const fresh = build(html);
      if (old) { have.delete(k); out.push(morph(old, fresh)); continue; }
      out.push(fresh);
    }
    for (const n of have.values()) n.remove();
    let ref = parent.firstElementChild;
    const skip = () => { while (ref && !(ref.dataset && ref.dataset.k)) ref = ref.nextElementSibling; };
    skip();
    // A child marked data-tail (the strip's later-days arrow) stays last: past the last keyed
    // child, new ones go in before it, not after.
    const tail = parent.querySelector(":scope > [data-tail]");
    for (const node of out) {
      if (node === ref) { ref = ref.nextElementSibling; skip(); continue; }
      parent.insertBefore(node, ref || tail);
    }
    return next;
  }

  // The scaffold: three boxes, built once, and the only children `root` ever gets. Building it
  // up front is what lets everything below address a box rather than hunt for one.
  //
  // ADOPTED FROM THE PREVIOUS MOUNT when the tree is being reused. The records are what make
  // rule 1 work — "a row whose HTML is byte-identical is not touched" is a comparison against
  // these maps, and starting them empty over a fully rendered tree would walk and re-attribute
  // every row on arrival for no reason.
  let titleEl = reused ? reused.titleEl : null;
  let stripEl = reused ? reused.stripEl : null;
  let ledeEl = reused ? reused.ledeEl : null;
  let daysEl = reused ? reused.daysEl : null;
  let emptyEl = reused ? reused.emptyEl : null;
  let pPills = reused ? reused.pPills : new Map();   // pill key -> html, as of the last paint
  let pShells = reused ? reused.pShells : new Map(); // day key  -> section shell html
  let pDays = reused ? reused.pDays : new Map();     // day key  -> { head, stays: Map, rows: Map }
  let pLede = reused ? reused.pLede : null;
  // THE LOCATION QUESTION IS THE PERSON'S TO ASK. Opening the Itinerary reads a position only
  // when the browser says it's already allowed (getPosition quiet); otherwise one quiet row offers "Show distance from
  // me", and only that tap asks. After a refusal the row is gone for good on this phone; once allowed, distances come
  // back on every later open without it.
  let locPerm = "unknown", locBusy = false;
  // The browser's answer comes a moment after the first paint. Repaint only when it changes the row, and keep the day
  // in view where it was: the row sits above the days, and its arriving must not move what the person is reading.
  positionPermission().then((st) => {
    const was = locRowHtml(); locPerm = st;
    if (dead || !root.isConnected || locRowHtml() === was) return;
    repaintHolding();
  });
  function repaintHolding() {
    const top = el.getBoundingClientRect().top;
    const day = el.scrollTop > 4 ? [...root.querySelectorAll(".ag-day")].find((d) => d.getBoundingClientRect().bottom > top + 1) : null;
    const was = day ? day.getBoundingClientRect().top : 0;
    paint(true);
    if (day && day.isConnected) { const moved = day.getBoundingClientRect().top - was; if (Math.abs(moved) >= 1) el.scrollTop += moved; }
  }
  const locRowHtml = () => {
    if (lastPosition() || positionDenied() || locPerm === "granted" || locPerm === "denied") return "";
    if (!store.places().some(hasCoords)) return "";
    return `<p class="ag-locrow"><button type="button" class="ag-locask" data-loc-ask${locBusy ? ' aria-busy="true"' : ""}>`
      + `${locBusy ? "Finding you…" : "Show distance from me"}</button></p>`;
  };
  let pEmpty = reused ? reused.pEmpty : null;
  let syncFab = () => {};
  let markSelected = () => {};

  function resetRecords() {
    pPills = new Map(); pShells = new Map(); pDays = new Map(); pLede = null; pEmpty = null;
    activeKey = null;
  }

  function ensureShell(empty) {
    const more = root.querySelector(".head-more");
    if (empty) {
      if (emptyEl && emptyEl.isConnected) return;
      root.replaceChildren();
      stripEl = ledeEl = daysEl = titleEl = null;
      resetRecords();
      emptyEl = build(`<div class="ag-emptybox"></div>`);
      root.append(emptyEl);
      if (more) root.append(more);
      return;
    }
    if (stripEl && stripEl.isConnected) return;
    root.replaceChildren();
    emptyEl = null;
    resetRecords();
    titleEl = build(`<header class="ds-head ag-tripname" data-empty="1"><h1 class="ag-tripname-t ds-h1"></h1>`
      + `<div class="ds-head-end"><button type="button" class="ag-headadd ds-button ds-button--white ds-button--sm" data-plan-add>+ Add a plan</button></div></header>`);
    if (more) titleEl.querySelector(".ds-head-end").append(more);
    stripEl = build(`<div class="ag-strip" role="group" aria-label="Jump to a day">`
      + `<button class="ag-stripmore" type="button" data-strip-more="-1" aria-label="Earlier days"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6 8.5 12l6 6"/></svg></button>`
      + `<button class="ag-stripmore" type="button" data-strip-more="1" data-tail aria-label="Later days"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg></button>`
      + `</div>`);
    ledeEl = build(`<div class="ag-ledeslot"></div>`);
    daysEl = build(`<div class="ag-days"></div>`);
    root.append(titleEl, stripEl, ledeEl, daysEl);
  }

  // Rule 3's bookkeeping. The strip's offset is read back off the live element wherever it is
  // needed, but a hand on it also ends any restore window — see holdStrip().
  //
  // BOUND PER MOUNT, not once per shell. The strip element now outlives the mount that built
  // it, and a listener registered inside ensureShell would keep writing into the FIRST mount's
  // stripX and reading the first mount's stripWant for the rest of the session — a stale
  // closure that also pins that whole scope in memory. bindStrip() re-points it whenever the
  // element changes and unmount takes it off.
  // Which ends have more days past them: the arrows show only there (data-more on the strip).
  const markEnds = () => {
    const s = stripEl;
    if (!s) return;
    const max = s.scrollWidth - s.clientWidth;
    const more = [s.scrollLeft > 2 ? "start" : "", s.scrollLeft < max - 2 ? "end" : ""].filter(Boolean).join(" ");
    if ((s.dataset.more || "") !== more) s.dataset.more = more;
  };
  const onStripScroll = () => { const s = stripEl; if (s && stripWant == null) stripX = s.scrollLeft; markEnds(); };
  // A MOUSE WHEEL TURNED OVER THE STRIP SCROLLS IT SIDEWAYS (the layouts, 16 Nov: on a desktop it
  // ran off the edge and a wheel did nothing). Only a mostly-vertical turn is taken: a trackpad's
  // sideways swipe is the strip's own scroll already. At an end, the turn goes on to the page.
  const onStripWheel = (ev) => {
    const s = stripEl;
    if (!s || Math.abs(ev.deltaY) <= Math.abs(ev.deltaX) || s.scrollWidth <= s.clientWidth) return;
    const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * s.clientWidth : ev.deltaY;
    const before = s.scrollLeft;
    s.scrollLeft = before + dy;
    if (s.scrollLeft !== before) { ev.preventDefault(); stripWant = null; }
  };
  let stripBound = null;
  function bindStrip() {
    if (stripBound === stripEl) return;
    if (stripBound) { stripBound.removeEventListener("scroll", onStripScroll); stripBound.removeEventListener("wheel", onStripWheel); }
    stripBound = stripEl;
    if (stripBound) {
      stripBound.addEventListener("scroll", onStripScroll, { passive: true });
      stripBound.addEventListener("wheel", onStripWheel, { passive: false });
      markEnds();
    }
  }

  // Put `next` on screen. Nothing here replaces a container; everything goes through
  // patchKeyed, which is where rules 1 and 2 live.
  function applyParts(next) {
    if (next.empty) {
      ensureShell(true);
      bindStrip();
      root.classList.toggle("ag-empty", true);
      if (pEmpty !== next.empty) {
        const more = root.querySelector(".head-more");
        emptyEl.innerHTML = next.empty;
        pEmpty = next.empty;
        const end = emptyEl.querySelector(".ds-head-end");
        if (more && end) end.append(more);
      }
      syncFab();
      return;
    }
    root.classList.toggle("ag-empty", false);
    ensureShell(false);
    bindStrip();

    // Rule 3. Dropping a pill can clamp the offset even when the element survives, so it is
    // read before and written back after — and only when it actually moved, because assigning
    // scrollLeft the value it already has is still a write.
    const x = stripEl.scrollLeft;
    pPills = patchKeyed(stripEl, next.pills, pPills);
    if (stripEl.scrollLeft !== x) stripEl.scrollLeft = x;
    markEnds();
    // A pill that HAD to be rebuilt (the day rolled over) lost the class setActive wrote on
    // it. Re-assert it here rather than by clearing activeKey: clearing it would let setActive
    // run its centring scroll again, and the strip travelling on its own is the bug.
    syncActive();

    const lede = next.lede + locRowHtml();
    if (pLede !== lede) { ledeEl.innerHTML = lede; pLede = lede; }
    if (titleEl) {
      const t = titleEl.querySelector(".ag-tripname-t");
      if (t && t.textContent !== next.title) t.textContent = next.title;
      const empty = next.title ? "" : "1";
      if (titleEl.dataset.empty !== empty) titleEl.dataset.empty = empty;
    }

    // Day sections first — create, drop, reorder — then each section's insides. The shell's
    // html is a pure function of its key, so an existing section is never rebuilt.
    pShells = patchKeyed(daysEl, next.days.map((d) => [`d:${d.key}`,
      `<section class="ag-day" data-k="d:${esc(d.key)}" data-day="${esc(d.key)}"><h2 class="ag-dayhead"></h2><div class="ag-stays"></div><ol class="ag-list"></ol></section>`]), pShells);

    // daysEl has no unkeyed children, so after the order pass child i IS day i.
    const alive = new Set();
    for (let i = 0; i < next.days.length; i++) {
      const d = next.days[i];
      const sec = daysEl.children[i];
      if (!sec) continue;
      alive.add(d.key);
      const rec = pDays.get(d.key) || { head: null, stays: new Map(), rows: new Map() };
      if (d.today) { if (sec.dataset.today !== "1") sec.dataset.today = "1"; }
      else if (sec.dataset.today) delete sec.dataset.today;
      if (d.past) { if (sec.dataset.past !== "1") sec.dataset.past = "1"; }
      else if (sec.dataset.past) delete sec.dataset.past;
      const head = sec.firstElementChild;                   // .ag-dayhead — never replaced: it
      if (rec.head !== d.head) {                            // carries data-pinned, the sticky
        head.innerHTML = d.head;                            // shadow state the spy writes, and
        rec.head = d.head;                                  // that state is lost with the node
      }
      rec.stays = patchKeyed(sec.children[1], d.stays, rec.stays);
      rec.rows = patchKeyed(sec.lastElementChild, d.rows, rec.rows);
      fitWhen(sec.lastElementChild);
      pDays.set(d.key, rec);
    }
    for (const k of [...pDays.keys()]) if (!alive.has(k)) pDays.delete(k);
    markPlace();
    markSelected();
    syncFab();
  }

  // ONE TIME COLUMN A DAY (27 Nov). Each card is its own grid, so a card whose time is wider (a zone chip, the
  // weekday of an end past midnight) widened only its own first column and its title stood right of every other
  // title of the day. The day's list takes its widest time (each end is kept whole: timeLine) as every card's
  // column. Measured after each paint; a list not laid out (a hidden view) is measured on the next one.
  function fitWhen(list) {
    if (!list) return;
    let w = 0;
    for (const n of list.querySelectorAll(".ag-card .ag-end")) w = Math.max(w, n.getBoundingClientRect().width);
    if (!w) return;
    const v = `${Math.max(58, Math.ceil(w))}px`;
    if (list.style.getPropertyValue("--ag-when-w") !== v) list.style.setProperty("--ag-when-w", v);
  }
  // The times are drawn in the mono face; until it has loaded they were measured in the fallback's widths.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!dead) for (const l of root.querySelectorAll(".ag-list")) fitWhen(l); });

  // Two panes: the place picked on the map beside the Itinerary; the first plan at it is marked,
  // and marked again after every redraw of the parts (a card whose words change is rebuilt).
  let pickedPlace = null;
  function markPlace() {
    for (const n of root.querySelectorAll(".ag-card[data-on]")) n.removeAttribute("data-on");
    if (!pickedPlace) return null;
    const e = store.events().filter((x) => x.place_id === pickedPlace).sort((a, b) => toMs(a.starts_at) - toMs(b.starts_at))[0];
    const card = e && root.querySelector(`a.ag-card[href="#/e/${CSS.escape(encodeURIComponent(e.id))}"]`);
    if (card) card.dataset.on = "1";
    return card;
  }

  // `blind` means "the router is about to move #view and has not done it yet, so do not ask
  // the spy which day is on screen — it would answer day one, because scrollTop is still 0".
  // See the takeState() read at the bottom of this function for who passes it.
  function paint(keepScroll, blind) {
    const y = keepScroll ? el.scrollTop : null;
    model = buildModel(Date.now());
    sig = liveSignature(model);
    slice = dataSlice();
    applyParts(agendaParts(model));
    measureStrip();
    observeStrip();
    // Only when it actually moved. A no-op repaint must not write to the scroller either —
    // an assignment that changes nothing fires no event, but one that clamps does.
    if (y != null && el.scrollTop !== y) el.scrollTop = y;
    if (!blind) spy(true);
    enterOnce();
    tweenDrain(model.now);
    armBreathe();
    // A cold first launch paints an empty shell before the snapshot lands, and there is
    // nothing to aim at yet. Re-arm rather than burning the one chance to place the view.
    if (!didPlace) requestAnimationFrame(() => requestAnimationFrame(placeInitial));
  }

  // ── first-mount stagger ──
  // Day sections fade up 8px, ~40ms apart, ONCE per mount — and only the first paint that
  // actually has days. A cold start paints the empty shell first and the snapshot's arrival
  // IS the first appearance, so the flag is only spent when there is something to enter.
  // Background-sync re-renders can never reach this: `entered` is already true, and the
  // dataSlice() hash upstream stops identical data from painting at all.
  function enterOnce() {
    if (entered) return;
    if (!daysEl || !daysEl.children.length) return;
    entered = true;
    if (reducedMotion()) return;
    const dur = ms("--dur", 220), easing = easeOutTok();
    let i = 0;
    for (const s of root.querySelectorAll(".ag-days > .ag-day")) {
      // `backwards` fill so a section is invisible through its own delay instead of popping
      // in and then animating. No `forwards`: it plays TO resting style (motion.js's rule).
      s.animate(
        [{ opacity: 0, transform: "translate3d(0,8px,0)" }, { opacity: 1, transform: "none" }],
        { duration: dur, easing, delay: 40 * i++, fill: "backwards" });
    }
  }

  // ── the drain tween (moves continuously — minute-tick tween, not a jump) ──
  // The bar's resting transform is set to where it SHOULD be at the next minute boundary and
  // a linear player animates from where it is now to that value — so between ticks the fill
  // moves every frame, and if the phone sleeps mid-minute (WAAPI stops while hidden) the
  // resting style is already the correct end state and the visibility tick re-syncs the next
  // leg. scaleY on a 2px compositor layer; layout is never touched.
  function tweenDrain(now) {
    const g = model.live && model.live.gap;
    const drain = root.querySelector(".ag-rail-live .ag-drain");
    if (!g || !drain) return;
    const span = g.to - g.from;
    const at = (t) => Math.max(0, Math.min(1, (g.to - t) / span));
    const a = at(now);
    const end = Math.min(now + TICK_MS, g.to);
    const b = at(end);
    for (const p of drain.getAnimations()) p.cancel();
    if (reducedMotion()) { drain.style.transform = `scaleY(${a.toFixed(5)})`; return; }
    drain.style.transform = `scaleY(${b.toFixed(5)})`;
    if (end <= now || a === b) return;
    drain.animate(
      [{ transform: `scaleY(${a.toFixed(5)})` }, { transform: `scaleY(${b.toFixed(5)})` }],
      { duration: end - now, easing: "linear" });
  }

  // ── the "now" marker breathes ──
  // motion.breathe() on the live card's spine node — a mark, never text — or on the live
  // rail's drain when the live thing is a gap. breathe() itself owns the reduced-motion kill,
  // the pause while the app is hidden, and its own singleton-ness; this only has to aim it,
  // and to not re-aim it at the same node (a restart snaps opacity back to 1 mid-cycle).
  let breather = { stop() {}, el: null };
  function armBreathe() {
    const node = root.querySelector('.ag-slot[data-live="1"] .ag-kind, .ag-rail-live .ag-nowdot')
      || root.querySelector(".ag-rail-live .ag-drain");
    if (node && node === breather.el && node.isConnected) return;
    breather.stop();
    breather = node ? { ...breathe(node), el: node } : { stop() {}, el: null };
  }

  // ONE GPS READ FOR THE WHOLE SCREEN. getPosition never rejects — null simply means no fix —
  // so there is no catch here and no call site that needs one. Every row then reads
  // lastPosition() synchronously while rendering, which is the SHELL contract's instruction
  // and the reason the list can paint distances on the very first frame after a relaunch.
  getPosition({ quiet: true }).then((p) => { if (p && !dead && dataSlice() !== slice) paint(true); });

  // The sticky day headers have to park directly under the sticky day strip, and the strip's
  // height depends on the rendered font. Measuring beats hard-coding a number that is wrong
  // the first time anybody changes a padding token.
  //
  // TWO NUMBERS COME OUT OF THIS, not one. --ag-strip-h is where a day heading parks.
  // --ag-stick-h is the whole sticky stack, strip PLUS the heading that pins under it, and it
  // is what everything below the chrome has to clear. scroll-padding-top on the scrollport and
  // scroll-margin-top on the sections are the same measurement stated to the two APIs that use
  // it: without it, every scroll the BROWSER performs — focusing a card with a keyboard, a
  // fragment link, a restored position — parks its target under two layers of sticky bar.
  //
  // WHERE THE STRIP'S FOOT STICKS, from the top of the scrollport: the view's own top padding
  // (the phone's safe area plus the list's top space), the strip's sticky top (negative) and its
  // height. Its height alone was the old measure, right only with no safe area: on an iPhone with
  // a notch the strip sticks 47 pt down, and every placement parked a day's top under it (its
  // header pinned and its first band hidden: the night bus's "Still going" line, 15 Nov).
  function stripFoot() {
    const strip = stripEl;
    if (!strip) return 0;
    const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
    const top = parseFloat(getComputedStyle(strip).top) || 0;
    return Math.max(strip.offsetHeight, pad + top + strip.offsetHeight);
  }

  function measureStrip() {
    const strip = stripEl;
    if (!strip) return;
    const head = root.querySelector(".ag-dayhead");
    const headH = head ? head.offsetHeight : 0;
    // The trip's name sticks above the strip: a day heading parks under both.
    // Its exact height, not offsetHeight's whole pixels: rounded down, the strip stuck a part of a
    // pixel low and a sliver of the list showed between the two (plans_check's bars, 16 Nov).
    const titleH = titleEl && titleEl.isConnected ? titleEl.getBoundingClientRect().height : 0;
    root.style.setProperty("--ag-tripname-h", `${titleH}px`);
    const stick = titleH + strip.offsetHeight + headH;
    root.style.setProperty("--ag-strip-h", `${titleH + strip.offsetHeight}px`);
    root.style.setProperty("--ag-head-h", `${headH}px`);
    root.style.setProperty("--ag-stick-h", `${stick}px`);
    // #view belongs to the shell; agenda states its own scroll geometry on it while mounted
    // and hands it back untouched on unmount rather than reaching into styles.css.
    el.style.scrollPaddingTop = `${stripFoot() + headH + 8}px`;
  }

  // A measurement taken once is a measurement that goes stale. The strip's height moves when
  // the webfont swaps in, when the phone is rotated, and when a pill's label changes width
  // enough to wrap — and a stale --ag-strip-h parks every day heading at the wrong offset,
  // which is exactly the "first card tucked under the header" failure. Re-measure whenever the
  // box actually changes rather than only when this module happens to repaint.
  const stripRO = typeof ResizeObserver === "function" ? new ResizeObserver(() => { measureStrip(); markEnds(); }) : null;
  function observeStrip() {
    if (!stripRO) return;
    stripRO.disconnect();
    const strip = stripEl;
    if (strip) stripRO.observe(strip);
    // The trip's name above it: written after the first measure (empty, it has no height), so
    // its own size change measures again.
    if (titleEl) stripRO.observe(titleEl);
    const head = root.querySelector(".ag-dayhead");
    if (head) stripRO.observe(head);
  }

  // WHERE THE STICKY CHROME ENDS, in viewport coordinates. The strip is always there; a day
  // heading is only part of the floor while one is actually pinned against the strip's lower
  // edge, which is most of the time but not at the very top of the list.
  function chromeFloor() {
    const strip = stripEl;
    const top = el.getBoundingClientRect().top + stripFoot();
    let floor = top;
    for (const head of root.querySelectorAll(".ag-dayhead")) {
      const r = head.getBoundingClientRect();
      if (r.top <= top + 1 && r.bottom > floor) floor = r.bottom;
    }
    return floor;
  }

  // A restored scroll position is the reader's, and it is kept — but a position restored to
  // the pixel can leave the card at the top of the screen sliced in half by the sticky header
  // that is sitting on it, which is what coming back from an event detail looked like. Nudge
  // up by exactly the overlap so the topmost card the reader can see is a whole card. Capped:
  // this is a correction, not a re-placement, and it must never turn into a jump to somewhere
  // the reader did not ask to be.
  function clearChrome() {
    const floor = chromeFloor();
    for (const n of root.querySelectorAll(".ag-slot, .ag-stay")) {
      const r = n.getBoundingClientRect();
      if (r.bottom <= floor + 0.5) continue;          // wholly behind the chrome: not the top card
      if (r.top >= floor - 0.5) return;               // the top card already clears it
      const by = floor - r.top + 8;
      if (by > 0 && by < 320) el.scrollTop = Math.max(0, el.scrollTop - by);
      return;
    }
  }

  // ── scroll spy: which day is under the strip ──
  let spyRAF = 0;
  let activeKey = null;
  // ── NOTHING TRAVELS WHILE THE SCREEN IS STILL ARRIVING ───────────────────────────────────
  //
  // Coming back from an event is a MOUNT, not a repaint, and the mount runs in this order:
  //
  //   1. paint(false) — synchronous, and #view.scrollTop is still 0, because the router
  //      restores it only after mod.default() returns. So the spy honestly reports day one,
  //      setActive lights day one, and the ring is created there.
  //   2. the router assigns el.scrollTop = <the saved position>.
  //   3. that fires a scroll event, the spy wakes, and setActive moves to the real day —
  //      which, being an ordinary selection change, GLIDES. The whole width of the strip.
  //
  // Measured on a real back (real tap into an event, real history.back()): the ring's left
  // goes 16px at t=47ms to 224px at t=55ms with a player attached, and the player is still
  // running at t=274ms. That is the report, frame for frame. The z-order work and the keyed
  // patcher never touched it because neither one is on this path: nothing REPAINTED, the
  // screen was rebuilt from nothing and then told where to be.
  //
  // So step 3 is a PLACEMENT, not a transition — the same principle as on
  // a first mount, applied to the one piece of this screen that animates on arrival. The flag
  // is cleared by the first real hand on the app, so a reader who starts scrolling
  // immediately still gets the glide they are supposed to get, and by a short frame budget
  // otherwise, so it can never wedge on.
  let placing = true;
  // The strip's horizontal offset, kept live. It is UI state in exactly
  // the sense #view's scrollTop is: somebody put it there with a thumb, and no repaint,
  // refresh or re-light is entitled to move it.
  let stripX = 0;
  // `instant` for programmatic jumps: a smooth strip scroll queued in the same frame as a
  // large el.scrollTop jump gets cancelled by it, and the lit pill ends up off screen.
  // A DAY CHOSEN BY ITS PILL keeps the ring until the person's own hand moves the list. The
  // spy's line can't always agree with a tap: a last day too short to reach the top never
  // crosses it, and the scroll the tap made would otherwise hand the ring back to the day
  // before (the film, 15 Nov: "a tap that didn't take"). Let go by a touch, a wheel or a key on
  // the list, never by a repaint or by the scroll the tap itself made.
  let chosen = null;
  const letGo = () => { chosen = null; };
  function spy(instant) {
    const strip = stripEl;
    if (!strip) return;
    // Slightly BELOW the strip's lower edge: scrollToEl parks a section 8px under the strip,
    // and a threshold at the edge itself would light the previous day's pill instead.
    const top = el.getBoundingClientRect().top;
    const foot = stripFoot();
    const line = top + foot + 12;
    let hit = null;
    for (const s of root.querySelectorAll(".ag-day")) {
      const r = s.getBoundingClientRect();
      if (r.top <= line) hit = s;
      // The sticky-header shadow (gaining its shadow with a fade as sections pin).
      // A heading is pinned exactly when its section's top has passed the pin line but the
      // section itself is still under it — the same geometry the day-pill decision reads, in
      // the same pass, so pinning can never disagree with the lit pill. The fade itself is a
      // CSS opacity transition on the heading's ::after; this only flips the state.
      const head = s.querySelector(".ag-dayhead");
      if (head) {
        const pinned = r.top <= top + foot - 4 && r.bottom > top + foot;
        if ((head.dataset.pinned === "1") !== pinned) {
          if (pinned) head.dataset.pinned = "1"; else delete head.dataset.pinned;
        }
      }
    }
    if (chosen && root.querySelector(`.ag-day[data-day="${CSS.escape(chosen)}"]`)) { setActive(chosen, instant); return; }
    setActive(hit ? hit.dataset.day : (root.querySelector(".ag-day") || {}).dataset?.day, instant);
  }

  // The classes and the ring, WITHOUT touching the strip's scroll offset and without gliding.
  // Called after a repaint that had to rebuild a pill: the state is re-asserted onto the new
  // node, and moveRing's `place` flag says "this is where the ring already is, not somewhere
  // it should travel to".
  function syncActive() {
    if (!stripEl || !activeKey) return;
    let hit = null;
    for (const p of stripEl.querySelectorAll(".ag-pill")) {
      const on = p.dataset.jump === activeKey;
      p.classList.toggle("ag-pill-here", on);
      if (on) { p.setAttribute("aria-current", "date"); hit = p; }
      else p.removeAttribute("aria-current");
    }
    if (hit) moveRing(stripEl, hit, true);
  }

  function setActive(key, instant) {
    const strip = stripEl;
    if (!strip || !key || key === activeKey) return;
    activeKey = key;
    for (const p of strip.querySelectorAll(".ag-pill")) {
      const on = p.dataset.jump === key;
      p.classList.toggle("ag-pill-here", on);
      if (on) {
        p.setAttribute("aria-current", "date");
        // The centring scroll is SUPPRESSED while a saved strip position is being restored.
        // Coming back from an event runs the whole sequence — mount at the top,
        // the router re-asserting the vertical offset over three frames, the spy re-lighting
        // the day that offset lands on — and every step of it wants to re-centre the pill,
        // which is precisely the "it re-animates over" complaint: the strip travels somewhere
        // the reader did not put it. The reader's own position is the authority; centring
        // resumes the moment the restore window closes.
        if (stripWant == null) {
          // Manual, not scrollIntoView: that would also scroll #view vertically and fight the
          // scroll the user is in the middle of.
          const want = p.offsetLeft - strip.clientWidth / 2 + p.offsetWidth / 2;
          const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
          // `placing` joins instant and reduced-motion here for the same reason they are
          // here: an arriving screen states where it is, it does not travel there.
          strip.scrollTo({ left: Math.max(0, want), behavior: instant || calm || placing ? "auto" : "smooth" });
        }
        // The ring is positioned in the strip's CONTENT space, so it is correct at any scroll
        // offset and must move whether or not the strip did. `placing` says "this is where the
        // ring already belongs", exactly as syncActive()'s flag does.
        moveRing(strip, p, placing);
      } else p.removeAttribute("aria-current");
    }
  }

  // ── the day strip's own reading position ───────────────────────────────────────────────
  // #view's scrollTop is not the whole story on this screen: the strip is a second scroller,
  // horizontal, and it was coming back from an event re-centred on whatever day the spy
  // happened to light — an animated slide the reader did not ask for, over a position they
  // had set by hand.
  //
  // The router keeps one record per HISTORY ENTRY, exactly as it does for the vertical
  // offset, and for the same reason: "#/ from the tab bar" and "#/ from backing out of an
  // event" are two entries, and handing the first one the second one's number is the bug in a
  // different costume.
  //
  // RESTORED INSTANTLY AND HELD. Assigning scrollLeft once is not enough — the restore
  // sequence spans several frames (the router settles scrollTop over three of them, each
  // firing a scroll event, each waking the spy) and any one of them would re-centre over the
  // top of it. So the value is re-asserted for six frames and the centring scroll stands down
  // for the same window. There is no animation anywhere in this path: it is the same number
  // written to the same property, so nothing moves and nothing to see.
  let stripWant = null;
  function holdStrip(x) {
    stripWant = x;
    stripX = x;
    const apply = () => {
      const strip = stripEl;
      if (strip && strip.scrollLeft !== stripWant) strip.scrollLeft = stripWant;
    };
    apply();
    let n = 0;
    const step = () => {
      if (dead || stripWant == null) return;
      apply();
      if (++n < 6) requestAnimationFrame(step);
      else stripWant = null;                  // centring is the strip's business again
    };
    requestAnimationFrame(step);
  }

  // ── the ring that GLIDES ──
  // ONE animated ring element under the pills, not per-pill borders: .ag-pill-here no longer
  // draws its own fill or border — this span carries both and travels between pills. It is
  // positioned in the strip's CONTENT space (offsetLeft, absolute inside the sticky strip) so
  // it rides the strip's own horizontal scroll for free, including the smooth centring scroll
  // running at the same time. The glide is a FLIP on the ring itself: geometry is written
  // instantly (left/top/width/height — set, never tweened), then one transform player runs
  // from the inverted old box to rest. Widths differ by a digit at most ("Fri 28" vs "Mon 1"),
  // so the scale correction on a 1px border is invisible in flight.
  //
  // A ring that was just created has no previous box, so it PLACES rather than glides. `place`
  // is the same instruction stated deliberately: after a repaint that rebuilt a pill, the ring
  // has not moved and must not be animated as though it had.
  //
  // ── THE DESTINATION'S LABEL MUST NOT DISAPPEAR MID-GLIDE ───────────────────────────────
  // Reported three times. The first two remedies were both about PAINT ORDER, and both were
  // wrong, so the reasoning is written down here rather than re-derived a fourth time.
  //
  //   THE TEXT STATE IS APPLIED AT ANIMATION START, and that part was always right.
  //   setActive() toggles .ag-pill-here on the destination pill BEFORE calling this, so the
  //   destination wears its active ink, weight AND FILL on the first frame of the glide. Keep
  //   that ordering: swapping the class after the player resolves is the bug at its most
  //   obvious.
  //
  //   PAINT ORDER IS NOT THE LEVER. Stacking the pills above the ring (.ag-ring z-index 0,
  //   .ag-pill z-index 1) and the label still vanished on the phone. Measured afterwards in
  //   Safari 26.5 against a real scroll of #view, the destination pill's box loses its glyphs
  //   for the whole flight and gets them back on the frame the player finishes — with that
  //   z-order in force. .ag-strip is a backdrop-filter surface, the animation promotes this
  //   ring to a layer composited against that surface, and a z-index declared inside cannot
  //   reorder across the boundary. Chrome obeys the z-index; WebKit does not have to.
  //
  //   SO NOTHING OPAQUE TRAVELS ANY MORE. The ring's opaque fill moved onto .ag-pill-here,
  //   which paints it under its own text and cannot be composited away from it; this element
  //   glides as a 1px OUTLINE. A line cannot erase a label whatever the layer order turns out
  //   to be, which is the point — the fix no longer depends on being right about compositing.
  //   See the .ag-pill-here / .ag-ring rules in AG_CSS for the measurements.
  function moveRing(strip, pill, place) {
    let ring = strip.querySelector(".ag-ring");
    let fresh = false;
    if (!ring) {
      ring = document.createElement("span");
      ring.className = "ag-ring";
      ring.setAttribute("aria-hidden", "true");
      strip.prepend(ring);                      // first child: pills paint over it in DOM order
      fresh = true;
    }
    const to = { x: pill.offsetLeft, y: pill.offsetTop, w: pill.offsetWidth, h: pill.offsetHeight };
    const from = fresh ? null : {
      x: parseFloat(ring.style.left) || 0, y: parseFloat(ring.style.top) || 0,
      w: parseFloat(ring.style.width) || to.w, h: parseFloat(ring.style.height) || to.h,
    };
    ring.style.left = `${to.x}px`;
    ring.style.top = `${to.y}px`;
    ring.style.width = `${to.w}px`;
    ring.style.height = `${to.h}px`;
    for (const p of ring.getAnimations()) p.cancel();
    if (!from || place || reducedMotion() || !to.w || !to.h) return;
    const dx = from.x - to.x, dy = from.y - to.y;
    const sw = from.w / to.w, sh = from.h / to.h;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sw - 1) < 0.01 && Math.abs(sh - 1) < 0.01) return;
    ring.animate(
      [{ transform: `translate3d(${dx}px,${dy}px,0) scale(${sw},${sh})` }, { transform: "none" }],
      { duration: ms("--dur", 220), easing: easeOutTok() });
  }

  const onScroll = () => {
    if (spyRAF) return;
    spyRAF = requestAnimationFrame(() => { spyRAF = 0; spy(); });
  };
  el.addEventListener("scroll", onScroll, { passive: true });

  // ── scrolling to a target ──
  function scrollToEl(node, extra = 0) {
    if (!node) return;
    const strip = stripEl;
    const off = (strip ? stripFoot() : 0) + 8 + extra;
    const y = el.scrollTop + node.getBoundingClientRect().top - el.getBoundingClientRect().top - off;
    el.scrollTop = Math.max(0, y);
    spy(true);
    // Say which day this was, rather than letting the line rule infer it. Landing on a live
    // card sits it below its own day heading, which leaves the PREVIOUS day's empty tail
    // across the line — technically the owner of that pixel, and not what the reader sees.
    const own = node.closest(".ag-day");
    if (own) setActive(own.dataset.day, true);
  }

  // Opening the app and seeing what is next should take zero taps: land on the live moment,
  // or on whatever is next, or — before the trip — on day one.
  function placeInitial() {
    if (didPlace || replaceDue || !root.querySelector(".ag-day")) return;
    didPlace = true;
    // router.js restores a saved scrollTop after mount. If it restored anything, the user is
    // coming back from a detail view and their position is the right answer, not ours.
    const tripId = store.trip() && store.trip().id;
    const back = tripId ? readDays.get(tripId) : null;
    const fresh = !!back && Date.now() - back.at < READ_MS && back.today === model.todayKey;
    if (el.scrollTop > 4) {
      // The router put the list back where it was (a step back in history, which is also how a
      // tab returns to a section). Within the limits that is the place being read; past them
      // (half an hour, or the trip's day turned) the Agenda places itself as a first visit does,
      // once the router has finished re-asserting its offset (three frames).
      if (!back || fresh) { clearChrome(); spy(true); return; }
      readDays.delete(tripId);
      didPlace = false;
      replaceDue = true;
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        replaceDue = false;
        if (dead) return;
        el.scrollTop = 0;
        placeInitial();
      }))));
      return;
    }
    if (fresh) {
      const day = root.querySelector(`.ag-day[data-day="${CSS.escape(back.day)}"]`);
      if (day) { chosen = back.day; scrollToEl(day); return; }
    }
    // Before the trip, day one is already the first thing under the "9 days out" card, so
    // scrolling to it only pushes that card off screen. The top IS the answer here.
    if (model.phase === "before") { spy(true); return; }
    // DURING THE TRIP THE FIRST SCREEN IS TODAY: today's header at the top under the strip, the
    // ring on today, and the live moment or what's next brought into view below it when it is
    // later today. It used to place the live moment itself, which in the evening is tomorrow's
    // first plan and at night can sit in yesterday's section: the first screen of the day then
    // rang and named another day (the film, 15 Nov). Today keeps the ring, as a day chosen by its
    // pill does, until the person's own hand moves the list.
    if (model.phase === "during") {
      const today = root.querySelector(`.ag-day[data-day="${CSS.escape(model.todayKey)}"]`);
      if (today) {
        let live = root.querySelector(".ag-rail-live") || root.querySelector('.ag-slot[data-live="1"]') || root.querySelector('.ag-slot[data-next="1"]');
        if (live && live.closest(".ag-day") !== today) live = null;
        chosen = model.todayKey;
        scrollToEl(today);
        if (live && !wholeInView(live)) {
          const head = today.querySelector(".ag-dayhead");
          scrollToEl(live, head ? head.offsetHeight + 8 : 0);
        }
        return;
      }
    }
    let node = root.querySelector(".ag-rail-live")
      || root.querySelector('.ag-slot[data-live="1"]')
      || root.querySelector('.ag-slot[data-next="1"]');
    if (!node) {
      const key = model.phase === "after" ? model.days[model.days.length - 1].key
        : model.phase === "before" ? model.days[0].key : model.todayKey;
      node = root.querySelector(`.ag-day[data-day="${CSS.escape(key)}"]`) || root.querySelector(".ag-day");
    }
    // Clear the target's own day heading, measured rather than guessed. It is not only
    // cosmetic: park the card any lower and its day SECTION starts below the scroll-spy's
    // line, so the strip lights the previous day while the reader is looking at this one.
    const head = node.classList.contains("ag-day") ? null : node.closest(".ag-day")?.querySelector(".ag-dayhead");
    if (node.classList.contains("ag-day")) chosen = node.dataset.day;
    scrollToEl(node, head ? head.offsetHeight + 8 : 0);
  }

  // NO ROOM AT THE FOOT (20 Nov: on a phone the Itinerary scrolled far past its last row, into empty space).
  // A day placed near the end stands as high as the list lets it; the strip keeps its ring by `chosen`, not by where
  // the day stands, until the hand moves the list. The end of the list is its last row and the page's clearance.


  // ── the minute tick ──
  // Surgical, not a re-render: a re-render every sixty seconds would throw away the scroll
  // position of a list somebody is reading while walking. A full paint only happens when the
  // live TARGET changes — an event starting or ending, or the day rolling over.
  function tick() {
    const now = Date.now();
    const fresh = buildModel(now);
    if (liveSignature(fresh) !== sig) {
      // The live target moved — an event began or ended, or the day rolled over. Repaint,
      // holding the scroll: the reader did not ask to be moved just because a clock ticked.
      // paint() patches by day section, so only the day that lost the live card and the day
      // that gained it are actually rebuilt.
      paint(true);
      return;
    }
    model = fresh;
    const live = model.live;
    if (live && live.cards.length) {
      for (const c of live.cards) {
        if (c.allDay || c.point) continue;
        const slot = root.querySelector(`.ag-slot[data-liveid="${CSS.escape(c.e.id)}"]`);
        if (!slot) continue;
        const cd = slot.querySelector(".ag-cd");
        const fill = slot.querySelector(".ag-fill");
        if (cd) cd.textContent = `${fmtSpan(c.to - now)} left`;
        if (fill) fill.style.width = `${Math.max(0, Math.min(100, ((now - c.from) / (c.to - c.from)) * 100)).toFixed(2)}%`;
      }
    } else if (live && live.gap) {
      const rail = root.querySelector(".ag-rail-live");
      if (rail) {
        const cd = rail.querySelector(".ag-cd");
        if (cd) cd.textContent = fmtSpan(live.gap.to - now);
        // The drain is never set to a value any more — it is tweened toward the next minute
        // boundary, so the fill moves continuously instead of jumping 1/60th per tick.
        tweenDrain(now);
      }
    } else if (model.next) {
      const slot = root.querySelector('.ag-slot[data-next="1"] .ag-nextpill');
      if (slot) slot.textContent = `Next · ${fmtSpan(startMs(model.next.e) - now)}`;
    }
  }

  // Align to the minute boundary, then run every minute. A timer started at :37 updates the
  // countdown at :37 of every minute, which is up to fifty-nine seconds of visible lag on a
  // number whose whole job is to be current.
  let interval = 0;
  const align = setTimeout(() => { tick(); interval = setInterval(tick, TICK_MS); }, TICK_MS - (Date.now() % TICK_MS));

  // A phone that has been in a pocket for four hours resumes with a frozen clock on screen.
  // placeInitial too, and not only as belt-and-braces: an installed PWA can be launched or
  // restored while hidden, and requestAnimationFrame does not run in a page that is not
  // being composited — so the one-shot placement would silently never happen and the app
  // would open at the top of the trip instead of at now. It is idempotent.
  const onVis = () => {
    if (document.visibilityState !== "visible") return;
    tick();
    placeInitial();
  };
  document.addEventListener("visibilitychange", onVis);

  // The one guard applyParts cannot provide: skip even MODELLING when nothing this view
  // reads has moved — a packing tick fires "change" too, and it should cost the agenda
  // nothing but this hash.
  const offChange = store.on("change", () => { if (dataSlice() !== slice) paint(true); });

  // A hand on the strip ends the restore window early — the reader has taken it back, and
  // re-asserting an old offset under a moving thumb is the worst version of this feature.
  // NAMED, and taken off again at unmount. They used to be anonymous, which was fine while
  // the root died with the mount; now that it survives, an anonymous listener would be a
  // second handler on the same node every time the screen is revisited — each one closing
  // over a dead mount's setActive and fighting the live one over activeKey.
  const onRootDown = (ev) => {
    if (stripWant != null && ev.target.closest(".ag-strip")) stripWant = null;
  };
  // Is this wholly on screen, below the pinned bars and above what floats over the list's foot? On a phone #view runs
  // under the tab bar and the +: a card behind them counted as on screen, so the Itinerary opened with the live plan
  // hidden under the tab bar (27 Nov). Beside a rail (a tablet) the tab bar is a column, not a foot: only what stands in
  // the lower half of the list counts.
  function chromeCeil() {
    const v = el.getBoundingClientRect();
    let ceil = v.bottom;
    for (const n of document.querySelectorAll(".tabbar, .dock > *, .ag-fab")) {
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height || r.top < v.top + v.height / 2 || r.right <= v.left || r.left >= v.right) continue;
      ceil = Math.min(ceil, r.top);
    }
    return ceil;
  }
  const wholeInView = (node, tall = 0) => {
    const r = node.getBoundingClientRect();
    return r.top >= chromeFloor() - 0.5 && (tall ? r.top + tall : r.bottom) <= chromeCeil() - 8;
  };
  // A new plan starts on the day the reader is looking at (the strip's lit day), and when it
  // is saved the list goes to it: the card itself, or its day when it draws as a stay. A plan
  // already wholly on screen is left where it is: moving the list to show what is shown only
  // slides the lines above it under their day's heading.
  const addPlan = (opts = {}) => openPlanEditor({
    day: opts.day || activeKey || "",
    startTime: opts.startTime || "",
    endTime: opts.endTime || "",
    onSaved: (id, day, meta) => {
      if (dead) return;
      didPlace = true;
      const card = root.querySelector(`a[href="#/e/${CSS.escape(encodeURIComponent(id))}"]`);
      const slot = card && card.classList.contains("ag-card") ? card.closest(".ag-slot") || card : null;
      const dayEl = root.querySelector(`.ag-day[data-day="${CSS.escape(day)}"]`);
      const head = slot ? slot.closest(".ag-day")?.querySelector(".ag-dayhead") : null;
      if (slot) { if (!wholeInView(slot)) scrollToEl(slot, head ? head.offsetHeight + 8 : 0); }
      else if (dayEl && !wholeInView(dayEl, 96)) scrollToEl(dayEl);
      if (meta && meta.isNew && slot && !reducedMotion()) {
        slot.animate(
          [{ opacity: 0, transform: "translate3d(0, 12px, 0) scale(.98)" }, { opacity: 1, transform: "none" }],
          { duration: ms("--dur-slow", 320), easing: "cubic-bezier(.22, 1.15, .36, 1)" },
        );
      }
      if (meta && meta.isNew) {
        toast("Added to the itinerary", {
          action: {
            label: "Undo",
            onClick: () => {
              if (typeof store.deleteEvent === "function") store.deleteEvent(id).catch(() => {});
            },
          },
        });
      }
    },
  });
  const openGapSheet = (anchorId) => {
    const e = store.event(anchorId);
    if (!e) return;
    const nowMs = Date.now();
    const m = buildModel(nowMs);
    const g = findGap(m, anchorId);
    const tight = !g || g.gap < TIGHT_MS;
    const inside = g && !tight && nowMs >= g.from && nowMs < g.to;
    const defaultTz = (m.trip && m.trip.default_tz) || e.tz;
    const tz = e.tz || defaultTz || "UTC";
    const left = inside ? g.to - nowMs : 0;
    const pct = inside ? Math.max(0, Math.min(100, ((nowMs - g.from) / (g.to - g.from)) * 100)) : 0;
    const sheetTitle = inside ? "Free right now" : (g && tight ? "The run-up" : "Free time");
    const spanText = tight
      ? `Before ${clip(e.title, 28)}`
      : `${fmtSpan(inside ? left : g.gap)}${inside ? " left" : " free"}`;
    const timeText = g && g.from != null && g.to != null && g.gap > 0
      ? `${fmtTime(g.from, tz)} → ${fmtTime(g.to, tz)} · ${fmtDay(g.to, tz)}${tight ? ` · ${fmtSpan(g.gap)} between` : ""}`
      : fmtDay(e.starts_at, tz);
    const subHtml = !g
      ? `<p class="ag-gapsheet-sub">Nothing scheduled.</p>`
      : tight && g.prev
        ? `<p class="ag-gapsheet-sub">Back-to-back with ${esc(clip(g.prev.title, 26))}.</p>`
        : g.prev
          ? `<p class="ag-gapsheet-sub">After ${esc(clip(g.prev.title, 32))} · before ${esc(clip(e.title, 32))}</p>`
          : `<p class="ag-gapsheet-sub">Before ${esc(clip(e.title, 32))}</p>`;
    const content = build(`<div class="ds ag-gapsheet">
      <p class="ag-gapsheet-time num">${esc(timeText)}</p>
      <h2 class="ds-h2 ag-gapsheet-title">${esc(spanText)}</h2>
      ${subHtml}
      ${inside ? `<div class="ag-g-bar" role="img" aria-label="${esc(fmtSpan(left))} of this gap remaining"><span class="ag-g-barfill" style="width:${pct.toFixed(2)}%"></span></div>` : ""}
      <div class="ag-gapsheet-acts">
        <button type="button" class="ds-button ds-button--white ds-button--lg ag-gapsheet-add" data-gap-add>Add a plan here</button>
        <button type="button" class="ds-button ds-button--gray ds-button--lg" data-plan-chat="before" data-gap-sheet-chat>${ui("chat")}Chat about this time</button>
      </div>
      ${afterCardHTML(e, defaultTz)}
      <div class="ag-gapsheet-links"></div>
      ${saidSectionHTML("gap")}
    </div>`);
    const links = content.querySelector(".ag-gapsheet-links");
    if (g && !tight) {
      const anchor = (g.prev && g.prev.place_id && store.place(g.prev.place_id))
        || (g.next.place_id && store.place(g.next.place_id)) || null;
      if (anchor) {
        const mins = Math.max(1, Math.round((g.to - Math.max(nowMs, g.from)) / MIN));
        links.append(build(`<a class="ag-gapsheet-link" href="#/places?near=${encodeURIComponent(anchor.id)}&free=${mins}">${ui("near")}<span>What's near ${esc(clip(anchor.name, 26))}</span>${ui("chev", "ag-chev")}</a>`));
      }
    }
    links.append(build(`<a class="ag-gapsheet-link" href="#/e/${encodeURIComponent(anchorId)}?gap=1">${ui("chat")}<span>Open free time & notes</span>${ui("chev", "ag-chev")}</a>`));
    let sheetDead = false;
    let stopSaid = null;
    const box = content.querySelector("[data-said]");
    const sh = openSheet({
      title: sheetTitle,
      contentEl: content,
      onClose: () => {
        sheetDead = true;
        if (stopSaid) { stopSaid(); stopSaid = null; }
      },
    });
    if (box) {
      import("./chat.js").then((c) => {
        if (sheetDead) return;
        c.chatStyles();
        stopSaid = c.watchAbout("event", anchorId, "before", (list) => {
          if (sheetDead || !box.isConnected) return;
          box.innerHTML = list.length
            ? c.saidHtml(list)
            : `<p class="ag-notes-none">Nothing said about this time yet.</p>`;
        });
      }).catch(() => {});
    }
    content.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-gap-add]")) {
        sh.close();
        const day = g && g.day ? g.day.key : dayKey(e.starts_at, tz);
        const startTime = g && g.from != null && g.gap > 0 ? fmtTime(g.from, tz) : "";
        const endTime = g && g.to != null && g.gap > 0 ? fmtTime(g.to, tz) : fmtTime(e.starts_at, tz);
        addPlan({ day, startTime, endTime });
        return;
      }
      if (ev.target.closest("[data-gap-sheet-chat]")) {
        sh.close();
        import("./chat.js").then(({ chatAbout }) => chatAbout("event", anchorId, { part: "before" })).catch(() => {
          toast("The chat couldn't open. Try again.");
        });
        return;
      }
      if (ev.target.closest("a.ag-gapsheet-link, a.ag-after")) {
        sh.close();
      }
    });
  };
  markSelected = () => {
    if (!ctx.two) return;
    const m = String(location.hash || "").match(/^#\/e\/([^/?]+)/);
    const openId = m ? decodeURIComponent(m[1]) : "";
    for (const n of root.querySelectorAll(".ag-card[data-selected]")) n.removeAttribute("data-selected");
    if (!openId) return;
    const card = root.querySelector(`a.ag-card[href="#/e/${CSS.escape(encodeURIComponent(openId))}"]`);
    if (card) card.dataset.selected = "1";
  };
  const offSelected = ctx.two && typeof ctx.router.onNavigate === "function"
    ? ctx.router.onNavigate(markSelected)
    : () => {};
  // The + button, on the shell's fixed layer like Split's and Memories': there whenever the
  // trip is on this phone, except the empty choice screen which already puts its own actions front-and-centre.
  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "fab ds ds-fab ag-fab";
  fab.dataset.planAdd = "";
  fab.setAttribute("aria-label", "Add a plan");
  fab.innerHTML = ui("plus");
  const wantFab = () => {
    const t = store.trip();
    if (!t) return false;
    if (!store.events().length && !store.places().length && !store.me()?.guest) return false;
    return true;
  };
  syncFab = () => { fab.hidden = !wantFab(); };
  syncFab();
  fab.addEventListener("click", () => addPlan());
  ((ctx.router && typeof ctx.router.fixedLayer === "function") ? ctx.router.fixedLayer() : document.body).append(fab);
  const offFab = store.on("change", syncFab);

  // A tick on Pack for today is Pack's own write (store.tickPacking), so Pack shows it and it
  // waits on the phone with no signal like any tick. The store's change repaints the row.
  const tickToday = async (btn) => {
    const { packTick: id, packList: list, packDay: day } = btn.dataset;
    tickedHere.add(list);
    const at = store.packDay(list);
    if (!at.open || at.day !== day) { paint(true); return; }    // the trip's day turned since it was drawn
    try { await store.tickPacking(id, list, day, !store.packTicked(id, list, day)); }
    catch (e) {
      const said = e && e.message ? String(e.message) : "";
      toast(said ? said[0].toUpperCase() + said.slice(1) : "Couldn't change that.");
      paint(true);
    }
  };
  const onRootClick = (ev) => {
    if (ev.target.closest("[data-loc-ask]")) {
      if (locBusy) return;
      locBusy = true; paint(true);
      // The person's own ask: the browser may show its question now. A refusal is kept (util.js) and the row goes.
      getPosition().then(() => positionPermission()).then((st) => { locPerm = st; locBusy = false; if (!dead) paint(true); });
      return;
    }
    if (ev.target.closest("[data-plan-ai]")) {
      const people = typeof store.members === "function" ? store.members().filter((m) => !m.left_at).length : 0;
      openPlanWithAiSheet({
        trip: store.trip(),
        place: (store.places()[0] && store.places()[0].name) || (store.trip() && store.trip().place) || "",
        people,
        onConnected: () => paint(true),
      });
      return;
    }
    const gapOpen = ev.target.closest("[data-gap-open]");
    if (gapOpen) {
      ev.preventDefault();
      openGapSheet(gapOpen.dataset.gapOpen);
      return;
    }
    if (ev.target.closest("[data-plan-add]")) { addPlan(); return; }
    if (ev.target.closest("[data-invite]")) { const t = store.trip(); openInvite({ tripId: store.tripId(), tripName: (t && t.name) || "" }); return; }
    const tick = ev.target.closest("[data-pack-tick]");
    if (tick) { tickToday(tick); return; }
    const more = ev.target.closest("[data-strip-more]");
    if (more && stripEl) {
      // Most of a strip's width, so the last day in view is the first after the move.
      stripWant = null;
      stripEl.scrollBy({ left: Number(more.dataset.stripMore) * Math.max(120, stripEl.clientWidth - 120), behavior: reducedMotion() ? "auto" : "smooth" });
      return;
    }
    const jump = ev.target.closest("[data-jump]");
    if (!jump) return;
    stripWant = null;               // an explicit jump outranks a restore in flight
    // A tap in the first frames of a cold start must win: otherwise the pending
    // auto-placement fires a frame later and drags the user back to "now".
    didPlace = true;
    chosen = jump.dataset.jump;
    const day = root.querySelector(`.ag-day[data-day="${CSS.escape(jump.dataset.jump)}"]`);
    scrollToEl(day);
  };
  root.addEventListener("pointerdown", onRootDown, { passive: true });
  // The hand on the list lets a chosen day go (the strip's own pills are a choice, not a scroll).
  const onHand = (ev) => { if (!(ev.target && ev.target.closest && ev.target.closest(".ag-strip"))) letGo(); };
  el.addEventListener("touchstart", onHand, { passive: true });
  el.addEventListener("wheel", onHand, { passive: true });
  el.addEventListener("keydown", onHand);
  root.addEventListener("click", onRootClick);

  // ── IS THIS AN ARRIVAL OR A RETURN? ────────────────────────────────────────────────────
  // Read BEFORE the first paint, not after, and the ordering is the whole point. takeState()
  // answers a record on a traversal to an entry we made — a back out of an event — and null
  // on a fresh push, so a non-null record is the router promising to restore #view's scrollTop
  // the moment this function returns. Until it does, scrollTop is 0, and a scroll spy asked
  // during the first paint honestly reports DAY ONE: it lights day one's pill and puts the
  // ring there, one frame before the restore drags it back. Measured, that frame is real — the
  // ring's left is 16px at t=41ms and 224px at t=48ms. So on a return the first paint does not
  // ask. The restore's own scroll event is the first thing entitled to an opinion.
  const saved = typeof ctx.router.takeState === "function" ? ctx.router.takeState() : null;

  // Synchronous first paint. Reads are synchronous by contract, so whatever IndexedDB
  // hydrated is on screen before the first frame — waiting for a store "change" would mean
  // a device with a warm cache and no signal renders an empty agenda and stays there.
  paint(false, !!saved);

  // Saved synchronously at navigation-start by the router, beside #view's scrollTop. It reads
  // the live strip rather than a cached number for the same reason the scroll save does: the
  // value is only true in that instant.
  const offKeep = typeof ctx.router.keepState === "function"
    ? ctx.router.keepState(() => {
        const strip = stripEl;
        return { stripX: strip ? Math.round(strip.scrollLeft) : Math.round(stripX) };
      })
    : () => {};

  // The strip's own offset is applied here rather than up there, because holdStrip() needs a
  // strip on screen and the first paint is what puts one there. A record never leaks from one
  // history entry onto another: takeState() answered null on a fresh push, so `saved` is null
  // and nothing below runs — tapping the Agenda tab is not a return to anything.
  //
  // `saved.stripX > 0` was wrong and it was wrong in the direction that hurts: a reader whose
  // strip was at 0 — which is most readers, most of the time, since the strip starts there —
  // got no restore window at all, so the centring scroll was free to slide the strip somewhere
  // on arrival. Zero is a position. The only thing that means "nothing to restore" is a null
  // record, which is what takeState() answers on a fresh push.
  if (saved) holdStrip(saved.stripX || 0);

  // ── close the placing window ──────────────────────────────────────────────────────────
  // Two ways out, whichever comes first.
  //
  //   A HAND. The first real input ends it, so a reader who starts scrolling the instant the
  //   screen lands gets the glide the design promises rather than a ring that snaps. capture
  //   + once, on the document, so it fires wherever the touch lands and unhooks itself.
  //
  //   A FRAME BUDGET. Six frames, the same window holdStrip() holds the strip for, and for
  //   the same reason: the router settles scrollTop over three frames and each one wakes the
  //   spy. Without the budget a screen nobody touches would place forever, and the next day
  //   the reader scrolled past would snap instead of glide.
  const endPlacing = () => { placing = false; };
  for (const t of ["pointerdown", "touchstart", "wheel", "keydown"]) {
    document.addEventListener(t, endPlacing, { capture: true, once: true, passive: true });
  }
  let placeFrames = 0;
  const placeTick = () => {
    if (dead || !placing) return;
    if (++placeFrames >= 6) {
      placing = false;
      // A return that skipped the first spy has been lit by the restore's scroll event long
      // before now. If it somehow was not — a restore of 0, a scroller that never moved —
      // this is the backstop, and it runs while `placing` is still the thing it was: a
      // placement, so the ring states where it is rather than travelling there.
      if (!activeKey) spy(true);
      return;
    }
    requestAnimationFrame(placeTick);
  };
  requestAnimationFrame(placeTick);

  const unmount = () => {
    dead = true;
    placing = false;
    for (const t of ["pointerdown", "touchstart", "wheel", "keydown"]) {
      document.removeEventListener(t, endPlacing, { capture: true });
    }
    breather.stop();                // the ambient loop must not outlive the marker it points at
    offFab();
    fab.remove();
    clearTimeout(align);
    clearInterval(interval);
    stripWant = null;
    offKeep();
    if (spyRAF) cancelAnimationFrame(spyRAF);
    document.removeEventListener("visibilitychange", onVis);
    el.removeEventListener("scroll", onScroll);
    if (stripRO) stripRO.disconnect();
    root.removeEventListener("pointerdown", onRootDown);
    root.removeEventListener("click", onRootClick);
    el.removeEventListener("touchstart", onHand);
    el.removeEventListener("wheel", onHand);
    el.removeEventListener("keydown", onHand);
    // The day being read when the Agenda is left (see readDays).
    const leftTrip = store.trip() && store.trip().id;
    if (leftTrip && activeKey) readDays.set(leftTrip, { day: activeKey, at: Date.now(), today: model ? model.todayKey : null });
    if (stripBound) { stripBound.removeEventListener("scroll", onStripScroll); stripBound.removeEventListener("wheel", onStripWheel); stripBound = null; }
    offSelected();
    // File the tree for the next mount, records and all. The router removes it from #view
    // itself — either by replaceChildren() or by carrying it off in a pop ghost — so nothing
    // here detaches anything; this only remembers where it went.
    kept = { root, titleEl, stripEl, ledeEl, daysEl, emptyEl, pPills, pShells, pDays, pLede, pEmpty };
    // #view is the shell's element. Whatever scroll geometry this view wrote onto it comes
    // back off, so places.js does not inherit an agenda-shaped scroll-padding.
    el.style.scrollPaddingTop = "";
    offChange();
  };

  // TWO PANES (from 1024, router.js): beside the Itinerary, the page a plan leads to, or, with
  // none open, the trip's map. map.js is loaded only here, never on a phone's Itinerary.
  if (!ctx.two) return unmount;
  const rest = (paneEl) => {
    const host = document.createElement("div");
    host.className = "ag-rest";
    paneEl.append(host);
    let handle = null, gone = false;
    // Bare: the map beside the Itinerary is only the map; a pin tapped marks the first plan at that
    // place in the list, brought into view.
    const mark = (placeId) => {
      pickedPlace = placeId || null;
      const card = markPlace();
      if (card) card.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    };
    import("./map.js").then((m) => {
      if (gone) return;
      handle = m.mountMap(host, ctx, { bleed: false, filter: { kind: "all", sub: "all" }, bare: true, onPick: mark });
    }).catch((e) => console.error("[agenda] the trip's map", e));
    return () => { gone = true; if (handle) handle.destroy(); handle = null; mark(null); host.remove(); };
  };
  return { unmount, rest };
}

// ────────────────────────────────────────────────────────────────────────────────────────
// maps — one button, Google Maps only
// ────────────────────────────────────────────────────────────────────────────────────────

// Google Maps, full stop. The universal /maps/search URL opens the app where it
// is installed and the web map where it is not, on both platforms — the old iOS sniff that
// picked maps.apple.com is deleted, not disabled. A place at 0,0 has not been geocoded, and
// handing "?query=0,0" to somebody showing a taxi driver their phone points at the Atlantic;
// name plus address finds the restaurant. query_place_id pins the exact listing when the
// seed carries one.
function mapsUrl(place) {
  const u = new URL("https://www.google.com/maps/search/");
  u.searchParams.set("api", "1");
  u.searchParams.set("query", hasCoords(place) ? `${place.lat},${place.lng}`
    : [place.name, place.address].filter(Boolean).join(", "));
  if (place.gmaps_place_id) u.searchParams.set("query_place_id", place.gmaps_place_id);
  return u.toString();
}

// THE ADDRESS BAND. Full-bleed and wall-to-wall in a different background, not a rounded card
// so it serves as the section SEPARATOR on this screen: a card floating inside
// a page reads as one more item rather than as the boundary between the plan and the place.
//
// Tapping the address copies it. Direct tap-to-copy is both the gesture users expect and the
// only one that works with what the address is FOR — CONTRACTS.md's "address ambiguity"
// section is about a taxi driver being told the wrong 28 de Julio, and the fix for that is
// pasting the exact string into a message rather than retyping it from a screen.
//
// The two buttons span the full width BETWEEN them (flex:1 each), which is the other half of
// the same note: they were offset left inside a card, leaving a dead column on the right of
// the one screen that has the least room to waste.
function purchasesSectionHTML(eId) {
  const list = typeof store.purchases === "function"
    ? store.purchases().filter((p) => !p.deleted_at && p.event_id === eId)
    : [];
  if (!list.length) return "";
  const members = typeof store.members === "function" ? store.members() : [];
  const rows = list.map((p) => {
    const amt = fmtMoney(p.amount_minor, p.amount_exp, p.currency);
    const payer = p.paid_by ? members.find((m) => m.id === p.paid_by) : null;
    const who = payer && payer.name ? `Paid by ${payer.name}` : "";
    return `<a class="ds-item ag-d-pay" href="#/split/${encodeURIComponent(p.id)}">
    <span class="ds-item-main">
      <span class="ds-item-title">${esc(p.description || "Purchase")}</span>
      ${who ? `<span class="ds-item-sub">${esc(who)}</span>` : ""}
    </span>
    <span class="ds-item-trail"><span class="ds-amount">${esc(amt)}</span></span>
    ${ui("chev", "ag-chev")}
  </a>`;
  }).join("");
  return `<section class="ag-sec ag-d-split">
  <h2 class="ag-d-h2">Paid for this</h2>
  <div class="ag-d-paylist">${rows}</div>
</section>`;
}

function placeBandHTML(place) {
  const addr = place.address || "";
  const local = localNameOf(place);       // "" when it is the name again: util.js
  return `<section class="ag-band" style="${placeToneVars(place)}">
  <div class="ag-band-in">
    <div class="ag-b-head">
      <a class="ag-b-lead" href="#/p/${encodeURIComponent(place.id)}" aria-label="${esc(place.name)}: the place's details"><span class="ag-b-ico" aria-hidden="true">${getIcon(place.kind, place.subkind, { cls: "ag-kind-g" })}</span><span class="ag-b-name">${esc(place.name)}${
        local ? ` <span class="ag-b-local">${esc(local)}</span>` : ""}</span>${ui("chev", "ag-b-go")}</a>
      ${distHTML(place, "ag-b-dist")}
    </div>
    ${addr ? `<button type="button" class="ag-b-addr" data-copy="${esc(addr)}"
      aria-label="Copy address: ${esc(addr)}"><span class="ag-b-addrt wrap-any">${esc(addr)}</span
      ><span class="ag-b-copy">${ui("copy")}<span class="ag-b-copyw">Copy</span></span></button>` : ""}
    ${place.address_note ? `<p class="ag-b-note wrap-any">${esc(place.address_note)}</p>` : ""}
    <div class="ag-b-acts">
      <a class="ds-button ds-button--white ds-button--lg ag-b-act ag-b-act-maps" href="${esc(mapsUrl(place))}" target="_blank" rel="noopener">${ui("ext")}Open in Maps</a>
    </div>
  </div>
</section>`;
}

// ────────────────────────────────────────────────────────────────────────────────────────
// event detail  #/e/:id   ·   gap detail  #/e/:id?gap=1
// ────────────────────────────────────────────────────────────────────────────────────────

// THE HEADER, REBUILT. Earlier layout stacked icon+kind, title, timespan and day·time all hard against
// the left edge with a large dead column on the right — four rows of ragged left type on the
// widest single block in the app. Two of those rows are pairs, so each pair now uses the full
// width with its second half right-aligned: KIND ······ DATE on the eyebrow, and
// TIMES ······ DURATION under the title. Nothing was made smaller; the width is simply used.
function eventHeadHTML(e, defaultTz, place) {
  const flag = tzFlagged(e, defaultTz);
  const en = endMs(e);
  const ez = endZone(e);

  let times;
  if (e.all_day) {
    times = `<span class="ag-d-t">All day</span>`;
  } else {
    // Each end one piece, as on the card (timeLine()).
    times = `<span class="ag-end"><span class="ag-d-t num">${esc(fmtTime(e.starts_at, e.tz))}</span>`;
    if (flag) times += `<span class="ag-tz">${esc(zoneChip(e.starts_at, e.tz))}</span>`;
    times += `</span>`;
    if (en != null) {
      times += `<span class="ag-end"><span class="ag-to">→</span><span class="ag-d-t num">${esc(fmtTime(e.ends_at, ez))}</span>`;
      if (flag) times += `<span class="ag-tz">${esc(zoneChip(e.ends_at, ez))}</span>`;
      times += `</span>`;
    }
  }

  // The right column: how long it lasts, or — for an event that ends on another date — which
  // date it ends on, because that is the more surprising fact of the two.
  let right = "";
  if (en != null && !e.all_day) {
    const crosses = dayKey(e.ends_at, ez) !== dayKey(e.starts_at, e.tz);
    right = crosses
      ? `<span class="ag-d-dur">${esc(fmtSpan(en - startMs(e)))} · ends ${esc(fmtDay(e.ends_at, ez))}</span>`
      : `<span class="ag-d-dur">${esc(fmtSpan(en - startMs(e)))}</span>`;
  }

  return `<header class="ag-d-head" style="${planToneVars(e, place)}">
  <div class="ag-d-top">
    <span class="ag-d-kind">${kindIcon(e, place, { cls: "ag-d-kindg" })}${esc(KIND_WORD[kindOf(e)])}</span>
    <span class="ag-d-date">${esc(fmtDay(e.starts_at, e.tz))}</span>
  </div>
  <h1 class="ds-h1 ag-d-title">${esc(e.title)}</h1>
  <div class="ag-d-clock">
    <span class="ag-d-times">${times}</span>
    ${right}
  </div>
</header>`;
}

// THE SLIM CARD FOR WHAT COMES AFTER THE GAP. Slim is the specification and it is also the
// point: the gap page is about the empty time, and the next thing is the boundary that gives
// the emptiness a size. A full event card here would out-shout the number the page exists for.
function afterCardHTML(e, defaultTz) {
  const place = e.place_id ? store.place(e.place_id) : null;
  const flag = tzFlagged(e, defaultTz);
  const where = place && String(place.name).trim() !== String(e.title).trim() ? place.name : "";
  return `<a class="ag-after" href="#/e/${encodeURIComponent(e.id)}" style="${planToneVars(e, place)}">
  <span class="ag-after-g">${kindIcon(e, place, { cls: "ag-after-ico" })}</span>
  <span class="ag-after-body">
    <span class="ag-after-eyebrow">Then</span>
    <span class="ag-after-title">${esc(clip(e.title, 54))}</span>
    <span class="ag-after-meta"><span class="num">${esc(e.all_day ? "All day" : fmtTime(e.starts_at, e.tz))}</span>${
      flag && !e.all_day ? ` <span class="ag-tz">${esc(zoneChip(e.starts_at, e.tz))}</span>` : ""}${
      where ? ` · ${esc(clip(where, 28))}` : ""}</span>
  </span>
  ${ui("chev", "ag-chev")}
</a>`;
}

// THE HEADLINE NUMBER, and the three honest answers it has.
//
//   inside it   "2h 14m left"   — the one the page exists for, with a draining bar
//   ahead/past  "3h 15m free"
//   TIGHT       no number at all — because the number would be wrong or absurd. A rail is
//               tight when the span is under twenty minutes, INCLUDING when it is negative:
//               a bag drop can end at 15:00 with lunch starting at 14:30, so the honest
//               measurement is minus thirty minutes and "−30m free" is not a thing to print.
//               Such a page is only ever reached from a note anchored to it, and the note is
//               what the reader came for; the header says what it can and gets out of the way.
function gapHeadHTML(g, now) {
  const tight = g.gap < TIGHT_MS;
  const inside = !tight && now >= g.from && now < g.to;
  const left = g.to - now;
  const pct = inside ? Math.max(0, Math.min(100, ((now - g.from) / (g.to - g.from)) * 100)) : 0;
  // g.from / g.to are epoch MILLISECONDS. util's formatters take either unit and sniff which
  // (see toMs), so these pass through unconverted — the gap is measured in the zone of the
  // event that ENDS it, which is the clock the reader is about to be standing under.
  const tz = g.next.tz;

  const big = tight
    ? `Before ${esc(clip(g.next.title, 26))}`
    : `${esc(fmtSpan(inside ? left : g.gap))}${inside ? " left" : " free"}`;

  // Times only where they describe something. An overlap's "15:00 → 14:30" reads as a typo.
  const clock = tight
    ? (g.gap > 0
        ? `<div class="ag-d-clock"><span class="ag-d-times num">${esc(fmtTime(g.from, tz))} → ${esc(fmtTime(g.to, tz))}</span><span class="ag-d-dur">${esc(fmtSpan(g.gap))} between</span></div>`
        : "")
    : `<div class="ag-d-clock">
    <span class="ag-d-times num">${esc(fmtTime(g.from, tz))} → ${esc(fmtTime(g.to, tz))}</span>
    ${g.prev ? `<span class="ag-d-dur">after ${esc(clip(g.prev.title, 22))}</span>` : ""}
  </div>`;

  // One line, factual: the header already says "Before X"; this says only why
  // there is no number.
  const sub = tight && g.prev
    ? `<p class="ag-g-sub">Back-to-back with ${esc(clip(g.prev.title, 26))}.</p>`
    : "";

  return `<header class="ag-d-head ag-g-head">
  <div class="ag-d-top">
    <span class="ag-d-kind">${ui("clock", "ag-d-kindg")}${inside ? "Free right now" : tight ? "The run-up" : "Free time"}</span>
    <span class="ag-d-date">${esc(fmtDay(g.to, tz))}</span>
  </div>
  <h1 class="h1 ag-d-title ag-g-big">${big}</h1>
  ${clock}
  ${sub}
  ${inside ? `<div class="ag-g-bar" role="img" aria-label="${esc(fmtSpan(left))} of this gap remaining"
    ><span class="ag-g-barfill" style="width:${pct.toFixed(2)}%"></span></div>` : ""}
</header>`;
}

// ────────────────────────────────────────────────────────────────────────────────────────
// what has been said, on the plan's page
// ────────────────────────────────────────────────────────────────────────────────────────
//
// The plan's page has no note box any more (migration 0027: notes are the chat's messages).
// "Chat about this" writes one; this section lists what has been said, filled in by
// mountDetail's watchSaid() once the chat's module has read what this phone holds.
function saidSectionHTML(face) {
  return `<section class="ag-d-notes ag-d-said">
  <h2 class="ag-d-h2">${ui("chat", "ag-d-h2g")}${face === "gap" ? "Said about this time" : "Said about this plan"}</h2>
  <div data-said="1"></div>
</section>`;
}

// ────────────────────────────────────────────────────────────────────────────────────────

function mountDetail(el, ctx) {
  const id = ctx.params.id;
  const root = document.createElement("div");
  root.className = "ag ag-detail ds";
  el.append(root);

  // Which face the URL is asking for: the plan, or the free time before it (?gap=1). The router
  // does not remount for a query-only change, so this is re-read on every navigation. An old
  // link that still carries ?note=<id> opens the same page.
  const query = () => new URLSearchParams(String(location.hash).split("?")[1] || "");
  const wantGap = () => query().get("gap") === "1";
  let showing = null;                 // "event" | "gap" — what is actually on screen
  let slice = "";                     // dataSlice() as of the last full paint
  let dead = false;
  let removed = false;                // this plan was just removed here: see the Change button
  let photoOwed = false;              // opened by a link to add its photo (?photo=add)

  // Its own photo, by hand (photo-hand.js): Add a photo / Change photo / Remove photo beside
  // Chat about this. A plan with no photo of its own shows its place's; one added here is the
  // plan's alone (the place keeps its own). The file field lives on el, outside every repaint.
  ensurePhotoCss();
  const ph = photoHand({
    target: { trip: store.tripId(), kind: "event", id },
    stored: () => pictureOf(store.event(id)),
    repaint: () => { if (!dead && showing === "event") paint(); },
    inputHost: el,
    start: () => startPictures(store),
    noun: "plan",
  });

  // ── WHAT HAS BEEN SAID ABOUT IT (migration 0027) ───────────────────────────────────────
  // Notes on plans are messages in the chat now, and this page lists the ones about this plan
  // (or, on the free time's face, about the time before it), oldest first, newest last, from
  // what the chat holds on this phone and the plan's own read when there is signal (chat.js
  // watchAbout). Writing one is the chat's: "Chat about this" opens it with this plan held
  // above the box. The chat's module is loaded here, not with the Agenda.
  const chat = import("./chat.js");
  let said = { face: null, stop: null, list: null };
  function watchSaid(face) {
    if (said.face === face) { paintSaid(); return; }
    if (said.stop) said.stop();
    said = { face, stop: null, list: null };
    if (!face) return;
    chat.then((c) => {
      if (dead || said.face !== face) return;
      c.chatStyles();
      said.stop = c.watchAbout("event", id, face === "gap" ? "before" : null, (list) => { said.list = list; paintSaid(); });
    }).catch((e) => console.warn("[agenda] the chat's module didn't load", e));
  }
  function paintSaid() {
    const box = root.querySelector("[data-said]");
    if (!box || !said.list) return;
    if (!said.list.length) {
      box.innerHTML = `<p class="ag-notes-none">${said.face === "gap" ? "Nothing said about this time yet." : "Nothing said about it yet."}</p>`;
      return;
    }
    chat.then((c) => { if (!dead && box.isConnected && said.list) box.innerHTML = c.saidHtml(said.list); });
  }

  getPosition({ quiet: true }).then((p) => { if (p && !dead && dataSlice() !== slice) paint(); });

  function paint() {
    const facing = wantGap() ? "gap" : "event";
    showing = facing;
    slice = dataSlice();
    const e = store.event(id);
    if (!e) {
      root.className = "ag ag-detail ds";
      root.innerHTML = `<div class="empty ds">
  <h2 class="ds-h2">Not on this phone</h2>
  <p class="ds-body">Waiting for signal.</p>
</div>`;
      watchSaid(null);
      return;
    }
    if (facing === "gap") paintGap(e); else { paintEvent(e); ph.painted(); }
    watchSaid(facing);
    if (photoOwed && facing !== "gap") { photoOwed = false; queueMicrotask(() => { if (!dead) ph.arrive(); }); }
  }

  function paintEvent(e) {
    const trip = store.trip();
    const defaultTz = (trip && trip.default_tz) || e.tz;
    const place = e.place_id ? store.place(e.place_id) : null;
    const shot = shotFor(ph.view(e));
    root.className = "ag ag-detail ds";

    root.innerHTML = `
${shot ? `<figure class="ag-d-shot"><span class="ag-media ag-media-hero">${imgHTML(shot, 358, 201)}</span></figure>` : ""}
${eventHeadHTML(e, defaultTz, place)}
<div class="ph-acts ag-d-acts"><button type="button" class="ds-button ds-button--gray ds-button--lg" data-plan-change>${ui("pencil")}Change</button><button type="button" class="ds-button ds-button--gray ds-button--lg" data-plan-chat>${ui("chat")}Chat about this</button></div>
${place ? placeBandHTML(place) : ""}
${e.detail ? `<section class="ag-d-body">${e.detail.split(/\n{2,}/).map((p) => `<p class="ag-d-p wrap-any">${esc(p.trim())}</p>`).join("")}</section>` : ""}
${e.url ? `<a class="ag-d-link wrap-any" href="${esc(e.url)}" target="_blank" rel="noopener">${ui("ext")}${esc(clip(e.url, 60))}</a>` : ""}
${purchasesSectionHTML(e.id)}
${saidSectionHTML("event")}
${ph.html({ cls: "ag-d-photo" })}`;
  }

  function paintGap(e) {
    const trip = store.trip();
    const defaultTz = (trip && trip.default_tz) || e.tz;
    const model = buildModel(Date.now());
    const g = findGap(model, id);
    // NOT "ag-gap" — that class is the rail's little duration label and would set a 12px
    // --ink-2 body font on the whole page by inheritance.
    root.className = "ag ag-detail ag-gp ds";

    // No measurable gap in front of this event — it is the first thing in the trip, or its
    // neighbour is an all-day block with no inside. Say so and offer the event itself rather
    // than rendering a page whose headline number would have to be invented.
    const head = g
      ? gapHeadHTML(g, Date.now())
      : `<header class="ag-d-head ag-g-head">
  <div class="ag-d-top">
    <span class="ag-d-kind">${ui("clock", "ag-d-kindg")}Free time</span>
    <span class="ag-d-date">${esc(fmtDay(e.starts_at, e.tz))}</span>
  </div>
  <h1 class="ds-h1 ag-d-title ag-g-big">Before ${esc(clip(e.title, 26))}</h1>
  <p class="ag-g-sub">Nothing scheduled.</p>
</header>`;

    // The one route contract this module publishes, unchanged: places.js reads ?near= and
    // ?free= and re-sorts by distance from the place you are sitting in. The anchor is the
    // event BEFORE the gap — where you actually are — falling back to the one after it.
    let nearBtn = "";
    // Only where there is actually time to spend. Offering "what's near" on a rail that
    // measures minus thirty minutes is the app inventing an afternoon.
    if (g && g.gap >= TIGHT_MS) {
      const anchor = (g.prev && g.prev.place_id && store.place(g.prev.place_id))
        || (g.next.place_id && store.place(g.next.place_id)) || null;
      if (anchor) {
        const mins = Math.max(1, Math.round((g.to - Math.max(Date.now(), g.from)) / MIN));
        nearBtn = `<a class="ds-button ds-button--gray ds-button--lg ds-button--block ag-g-near" href="#/places?near=${encodeURIComponent(anchor.id)}&free=${mins}"
          >${ui("near")}<span class="ag-g-neart">What's near ${esc(clip(anchor.name, 24))}</span>${ui("chev", "ag-chev")}</a>`;
      }
    }

    root.innerHTML = `${head}
<div class="ag-d-acts">
  <button type="button" class="ds-button ds-button--white ds-button--lg" data-gap-add>Add a plan here</button>
  <button type="button" class="ds-button ds-button--gray ds-button--lg" data-plan-chat="before">${ui("chat")}Chat about this time</button>
</div>
${afterCardHTML(e, defaultTz)}
${nearBtn}
${saidSectionHTML("gap")}`;
  }

  // ── interaction ──
  let copyTimer = 0;

  root.addEventListener("click", async (ev) => {
    if (ev.target.closest("[data-gap-add]")) {
      const e = store.event(id);
      const g = findGap(buildModel(Date.now()), id);
      const tz = (e && e.tz) || (store.trip() && store.trip().default_tz) || "UTC";
      openPlanEditor({
        day: g && g.day ? g.day.key : (e ? dayKey(e.starts_at, tz) : ""),
        startTime: g && g.from != null && g.gap > 0 ? fmtTime(g.from, tz) : "",
        endTime: g && g.to != null && g.gap > 0 ? fmtTime(g.to, tz) : (e ? fmtTime(e.starts_at, tz) : ""),
      });
      return;
    }
    if (ph.click(ev.target)) return;
    const talk = ev.target.closest("[data-plan-chat]");
    if (talk) {
      // The trip's chat, with this plan (or the time before it) held above its box: the next
      // message is about it, and it shows here when it lands.
      const part = talk.dataset.planChat === "before" ? "before" : null;
      chat.then(({ chatAbout }) => chatAbout("event", id, { part })).catch((e) => {
        console.warn("[agenda] chat not loaded", e);
        toast("The chat couldn't open. Try again.");
      });
      return;
    }
    if (ev.target.closest("[data-plan-change]")) {
      // Removed: this page has nothing left to show, so it goes back where it was opened
      // from, and the repaint that would say "not on this phone" is skipped on the way.
      openPlanEditor({ eventId: id, onRemoved: () => { removed = true; ctx.router.back(); } });
      return;
    }
    const copy = ev.target.closest("[data-copy]");
    if (copy) {
      const text = copy.dataset.copy;
      // TWO PATHS, TRIED IN ORDER, and the second is not dead code. clipboard.writeText needs
      // a secure context — which an installed PWA always is — but it also REJECTS rather than
      // being absent when the document is not focused or the permission is refused, and a
      // caught rejection that gives up is a button that silently does nothing. Measured: it
      // rejects with NotAllowedError under automation. So a rejection falls through to the
      // execCommand path rather than ending the attempt. This is the string somebody hands to
      // a taxi driver in a city with two 28 de Julios; failing quietly is not an option.
      let ok = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(text); ok = true; } catch { ok = false; }
      }
      if (!ok) {
        try {
          const t = document.createElement("textarea");
          t.value = text; t.setAttribute("readonly", "");
          t.style.position = "fixed"; t.style.top = "0"; t.style.opacity = "0";
          document.body.append(t);
          t.select(); t.setSelectionRange(0, text.length);
          ok = document.execCommand("copy");
          t.remove();
        } catch { ok = false; }
      }
      const word = copy.querySelector(".ag-b-copyw");
      const mark = copy.querySelector(".ico");
      if (word) word.textContent = ok ? "Copied" : "Press and hold";
      if (mark && ok) mark.innerHTML = UI.tick;
      copy.classList.toggle("ag-b-addr-done", ok);
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        if (word) word.textContent = "Copy";
        if (mark) mark.innerHTML = UI.copy;
        copy.classList.remove("ag-b-addr-done");
      }, 2200);
    }
  });

  const offChange = store.on("change", () => {
    // A change that moved nothing this page reads (a packing tick elsewhere) costs one hash
    // and no DOM — the wholesale rebuild below is what makes idle images blink.
    if (removed || dataSlice() === slice) return;
    paint();
  });

  // This screen has no second scroller to remember, and saying so matters: registration is a
  // single slot, so without this the AGENDA's snapshot function stays registered — and holds
  // its detached root alive — for as long as a detail screen is open.
  const offKeep = typeof ctx.router.keepState === "function"
    ? ctx.router.keepState(() => null)
    : () => {};

  // The router does not remount for a query-only change of hash, and `#/e/x` <-> `#/e/x?gap=1`
  // is exactly that. onNavigate fires twice per navigation, so this compares what is on screen
  // against what the URL asks for and does nothing when they already agree.
  const offNav = ctx.router.onNavigate(() => {
    const want = wantGap() ? "gap" : "event";
    // A link to add its photo followed while the page is open: the block brought into view
    // (onNavigate's second announcement finds it there already; arrive() is cheap and the same).
    if (want === showing) { if (wantsPhoto(location.hash) && showing === "event") ph.arrive(); return; }
    paint();
    el.scrollTop = 0;
  });

  photoOwed = wantsPhoto(location.hash);
  paint();
  // The page opens at the top, where the detail starts. The router owns the
  // one case where entry is not the top — a traversal back onto a page somebody had scrolled.
  requestAnimationFrame(() => { if (!dead && el.scrollTop <= 4) el.scrollTop = 0; });

  return () => {
    dead = true;
    clearTimeout(copyTimer);
    if (said.stop) said.stop();
    ph.stop();
    offKeep();
    offChange();
    offNav();
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────
// mount
// ────────────────────────────────────────────────────────────────────────────────────────

export default function mount(el, ctx) {
  injectStyles();
  injectPlanAiStyles();
  return ctx.route === "event" ? mountDetail(el, ctx) : mountAgenda(el, ctx);
}

// ────────────────────────────────────────────────────────────────────────────────────────
// styles — .ag-* only, built from the shell's tokens, injected once
// ────────────────────────────────────────────────────────────────────────────────────────

let injected = false;
function injectStyles() {
  if (injected || document.getElementById("ag-styles")) { injected = true; return; }
  injected = true;
  const s = document.createElement("style");
  s.id = "ag-styles";
  s.textContent = AG_CSS;
  document.head.append(s);
}

const AG_CSS = `
/* ── Itinerary & Plan pages on NeedWright's design system (.ds) ──────────────────────────── */
.ag {
  position: relative;
  --ag-thumb: 100px;
  --ag-hn-w: 44px;
  --ag-hn-h: 38px;
  --ag-hn-over: 14px;
  padding-bottom: 0;
  --ag-strip-h: 47px;
  --ag-stick-h: 86px;
}
@media (min-width: 760px) {
  .ag { max-width: 720px; margin-inline: auto; width: 100%; }
  .ag.ag-detail { max-width: 560px; }
}
@media (max-width: 300px) { .ag { --ag-thumb: 64px; } }
.ag.ag-empty { max-width: 560px; margin-inline: auto; }
.ag-day, .ag-slot, .ag-stay, .ag-staywrap, .ag-rail { scroll-margin-top: calc(var(--ag-stick-h) + 8px); }

/* ── top trip header (.ds-head) & sticky day strip ──────────────────────────────────────── */
.ag-tripname {
  position: sticky; top: calc(var(--sp-4) * -1); z-index: 5;
  margin: calc(var(--sp-4) * -1) calc(var(--sp-4) * -1) 0;
  padding: var(--sp-1) max(var(--sp-4), var(--sa-left));
  min-height: var(--control-44); box-sizing: border-box;
  background: var(--canvas);
  color: var(--ink-1);
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
}
.ag-tripname-t {
  flex: 1 1 auto; min-width: 0; margin: 0; color: var(--ink-1);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ag-tripname[data-empty="1"] { display: none; }
.ag-tripname[data-empty="1"] + .ag-strip { margin-top: calc(var(--sp-4) * -1); }
.ag-headadd { display: none; }
@media (min-width: 768px), (orientation: landscape) and (max-height: 420px) and (min-width: 480px) {
  .ag-tripname { min-height: 48px; }
  .ag-headadd { display: inline-flex; }
  .fab.ag-fab { display: none; }
}
.ag-tripname-head {
  position: static; margin: 0 0 var(--sp-3); padding: 0;
  min-height: var(--control-44); background: transparent;
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
}
.ag-tripname-flow { white-space: normal; }

.ag-strip {
  position: sticky; top: calc(var(--sp-4) * -1 + var(--ag-tripname-h, 0px)); z-index: 4;
  display: flex; gap: var(--sp-2);
  margin: 0 calc(var(--sp-4) * -1) var(--sp-3);
  padding: var(--sp-2) max(var(--sp-4), var(--sa-left));
  overflow-x: auto; scrollbar-width: none;
  background: var(--canvas);
  border-bottom: 1px solid var(--hair);
  scroll-padding-inline: var(--sp-4);
}
.ag-strip::-webkit-scrollbar { display: none; }
.ag-rest { position: relative; height: 100%; }
.ag-stripmore { display: none; }
@media (min-width: 1024px) {
  .ag-stripmore {
    display: grid; place-items: center;
    position: sticky; z-index: 2; flex: 0 0 auto;
    width: 88px; height: 30px; padding: 0; border: 0; color: var(--ink-2);
    visibility: hidden; cursor: pointer; pointer-events: none;
  }
  .ag-stripmore svg {
    pointer-events: auto;
    width: 30px; height: 30px; padding: 6px;
    border-radius: var(--radius-full); border: 1px solid var(--edge-strong);
    background: var(--chrome); fill: none; stroke: currentColor;
    stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
  }
  .ag-stripmore[data-strip-more="-1"] {
    left: calc(var(--sp-2) * -1); margin: 0 -88px 0 calc(var(--sp-2) * -1);
    justify-items: start; padding-left: var(--sp-2);
    background: linear-gradient(to right, var(--canvas) 40px, transparent 88px);
  }
  .ag-stripmore[data-strip-more="1"] {
    right: calc(var(--sp-2) * -1); margin: 0 calc(var(--sp-2) * -1) 0 -88px;
    justify-items: end; padding-right: var(--sp-2);
    background: linear-gradient(to left, var(--canvas) 40px, transparent 88px);
  }
  .ag-strip[data-more~="start"] .ag-stripmore[data-strip-more="-1"],
  .ag-strip[data-more~="end"] .ag-stripmore[data-strip-more="1"] { visibility: visible; }
  @media (hover: hover) and (pointer: fine) {
    .ag-stripmore:hover svg { color: var(--ink-1); background: var(--well); }
  }
}

.ag-pill {
  position: relative; z-index: 1; flex: 0 0 auto;
  display: inline-flex; flex-wrap: wrap; align-items: baseline; align-content: center; gap: 4px;
  height: 30px; padding: 0 9px;
  border-radius: var(--radius-full);
  border: 1px solid transparent;
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
}
.ag-pill::before {
  content: ""; position: absolute; left: 0; right: 0;
  top: 50%; height: var(--tap); transform: translateY(-50%);
}
.ag-pill-dow { font-size: var(--size-12); font-weight: 700; letter-spacing: .02em; line-height: 1; }
.ag-pill-num { font-size: var(--size-14); font-weight: 700; line-height: 1; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.ag-pill-bare .ag-pill-num { color: var(--ink-2); font-weight: 400; }
.ag-pill[data-press="1"] { background: var(--fill-active); background-clip: padding-box; }
@media (hover: hover) and (pointer: fine) {
  .ag-pill:active { background: var(--fill-active); background-clip: padding-box; }
}
.ag-pill-here { color: var(--ink-1); background: var(--gray-3); background-clip: padding-box; }
.ag-pill-here .ag-pill-num { color: var(--ink-1); font-weight: 700; }
.ag-ring {
  position: absolute; left: 0; top: 0; z-index: 0;
  border: 1px solid var(--ink-1); border-radius: var(--radius-full);
  background: transparent; pointer-events: none; transform-origin: 0 0;
}
.ag-pill-today { color: var(--ink-1); }
.ag-pill-today .ag-pill-num { color: var(--ink-1); font-weight: 700; }
.ag-pill-today::after {
  content: ""; position: absolute; left: 9px; right: 9px; bottom: 2px;
  height: 2px; border-radius: var(--radius-8); background: currentColor;
}

/* ── lede ────────────────────────────────────────────────────────────────────────────────── */
.ag-lede { display: flex; flex-direction: column; gap: 3px; margin-bottom: var(--sp-5); }
.ag-lede-eyebrow {
  font-size: var(--size-12); font-weight: 600; color: var(--ink-2);
}
.ag-lede-big {
  font-family: var(--type-head); font-weight: 500;
  font-size: var(--size-28); line-height: 1.15; letter-spacing: var(--track-head);
  font-variant-numeric: tabular-nums; color: var(--ink-1);
}
.ag-lede-sub { font-size: var(--size-14); line-height: 1.45; color: var(--ink-2); }
/* "Show distance from me": a quiet text row (the system's fine line), a 44 px target, its words underlined. */
.ag-locrow { margin: 0 0 var(--sp-3); }
.ag-locask { min-height: var(--control-44); padding: 0; border: 0; background: none; font: inherit;
  font-size: var(--size-14); color: var(--ink-1); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.ag-locask[aria-busy="true"] { color: var(--ink-2); text-decoration: none; cursor: default; }

/* ── day headings ─────────────────────────────────────────────────────────────────────────── */
.ag-day + .ag-day { margin-top: var(--sp-5); }
.ag-dayhead {
  position: sticky; top: calc(var(--ag-strip-h) - var(--sp-4)); z-index: 3;
  display: flex; align-items: baseline; gap: var(--sp-2);
  margin: 0 calc(var(--sp-4) * -1);
  padding: var(--sp-2) max(var(--sp-4), var(--sa-left)) 7px;
  background: var(--canvas);
  border-bottom: 1px solid var(--hair);
}
.ag-dayhead::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  box-shadow: 0 1px 0 var(--edge), var(--shadow-pop);
  opacity: 0; transition: opacity var(--dur-150) var(--ease-standard);
}
.ag-dayhead[data-pinned="1"]::after { opacity: 1; }
.ag-dayhead-date {
  font-family: var(--type-head); font-weight: 500;
  font-size: var(--size-20); line-height: 1.25; letter-spacing: var(--track-head);
  color: var(--ink-1);
}
.ag-day[data-past="1"] .ag-dayhead-date { color: var(--ink-2); }
.ag-dayhead-n {
  margin-left: auto;
  font-size: var(--size-12); font-weight: 500;
  color: var(--ink-2);
}
.ag-nothing { padding: var(--sp-3) 0; font-size: var(--size-14); color: var(--ink-2); }

/* ── stay bands, carried plans, Pack for today ───────────────────────────────────────────── */
.ag-stays { display: flex; flex-direction: column; margin-top: var(--sp-2); }
.ag-stays:empty { display: none; }
.ag-stay {
  position: relative;
  display: flex; align-items: center; gap: var(--sp-3);
  min-height: var(--tap);
  margin: 0 calc(var(--sp-2) * -1);
  padding: 6px var(--sp-2) 6px calc(var(--sp-2) + 4px);
  border-radius: var(--radius-12);
  background: transparent; border: 0; color: inherit;
}
.ag-stay::before {
  content: ""; position: absolute; left: 2px; top: 7px; bottom: 7px; width: 3px;
  border-radius: var(--radius-full); background: var(--ds-k, var(--edge)); pointer-events: none;
}
.ag-pk { padding-left: var(--sp-2); }
.ag-pk::before { display: none; }
.ag-stay[data-press="1"] { background: var(--fill-active); }
@media (hover: hover) and (pointer: fine) {
  .ag-stay:hover { background: var(--fill); }
  .ag-stay:active { background: var(--fill-active); }
}
.ag-stay-shot {
  position: relative; flex: 0 0 auto;
  width: 34px; height: 34px; border-radius: var(--radius-8); overflow: hidden;
  background: var(--well); border: 1px solid var(--hair);
}
.ag-stay:not(.ag-pk):not(.ag-carried) .ag-stay-shot {
  width: 28px; height: 28px; border-radius: var(--radius-full); border: 0;
}
.ag-stay-kind { flex: 0 0 auto; margin-top: 0; }
.ag-stay-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.ag-stay-tile { display: grid; place-items: center; }
.ag-stay-g { width: 18px; height: 18px; color: var(--ink-2); }
.ag-stay-body { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.ag-stay-name { font-size: var(--size-14); font-weight: 600; color: var(--ink-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-stay-meta { font-size: var(--size-12); color: var(--ink-2); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-stay-dist { flex: 0 0 auto; }
.ag-pk .ag-chev, .ag-carried .ag-chev { flex: 0 0 auto; width: 16px; height: 16px; color: var(--ink-3); }
.ag-carried[data-going="1"] .ag-stay-name { color: var(--ink-1); font-weight: 700; }
.ag-pk[data-packed="1"] .ag-stay-shot { background: var(--positive-bg); border-color: var(--positive-edge); }
.ag-pk[data-packed="1"] .ag-pk-g { color: var(--positive); }
.ag-pk:not([data-packed]) .ag-pk-g { color: var(--ink-1); }
.ag-pk-list { list-style: none; margin: 2px 0 var(--sp-2); padding: 0; display: flex; flex-direction: column; }
.ag-pk-i {
  display: flex; align-items: center; gap: var(--sp-3);
  width: calc(100% + var(--sp-2) * 2); min-height: var(--tap);
  margin: 0 calc(var(--sp-2) * -1); padding: 4px var(--sp-2);
  border: 0; border-radius: var(--radius-12); background: transparent;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.ag-pk-i[data-press="1"] { background: var(--fill-active); }
@media (hover: hover) and (pointer: fine) {
  .ag-pk-i:active { background: var(--fill-active); }
}
.ag-pk-box { flex: 0 0 auto; width: 34px; display: grid; place-items: center; }
.ag-pk-box::before {
  content: ""; grid-area: 1 / 1; width: 22px; height: 22px;
  border-radius: var(--radius-8); border: 1.5px solid var(--edge-strong);
  background: var(--well); box-sizing: border-box;
}
.ag-pk-check {
  grid-area: 1 / 1; width: 14px; height: 14px; fill: none; stroke: var(--on-solid);
  stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; opacity: 0; transform: scale(.5);
}
.ag-pk-i[data-done="1"] .ag-pk-box::before { background: var(--solid); border-color: var(--solid); }
.ag-pk-i[data-done="1"] .ag-pk-check { opacity: 1; transform: none; }
@media (prefers-reduced-motion: no-preference) {
  .ag-pk-check { transition: opacity var(--dur-150) var(--ease-standard), transform var(--dur-150) var(--ease-spring); }
}
.ag-pk-l { flex: 1 1 auto; min-width: 0; font-size: var(--size-14); font-weight: 500; color: var(--ink-1); overflow-wrap: anywhere; }
.ag-pk-q { font-weight: 500; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.ag-pk-i[data-done="1"] .ag-pk-l { color: var(--ink-2); text-decoration: line-through; text-decoration-thickness: 1px; }
.ag-pk-m { flex: 0 1 auto; min-width: 0; font-size: var(--size-12); color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ── itinerary rows: 3-column kind-coloured (time | body | kind icon) ──────────────────────── */
.ag-list { position: relative; margin: var(--sp-2) 0 0; padding: 0; list-style: none; }
.ag-slot { position: relative; padding: 2px 0; border-bottom: 1px solid var(--hair); }
.ag-slot:last-child { border-bottom: 0; }
.ag-card {
  position: relative; overflow: hidden;
  display: grid; grid-template-columns: var(--ag-when-w, minmax(58px, auto)) minmax(0, 1fr) auto; align-items: start;
  column-gap: var(--sp-3);
  width: calc(100% + var(--sp-2) * 2); min-height: var(--tap);
  margin: 0 calc(var(--sp-2) * -1); padding: 10px var(--sp-2) 10px calc(var(--sp-2) + 4px);
  border: 0; border-radius: var(--radius-16);
  background: transparent; color: inherit;
  transition: background var(--dur-150) var(--ease-standard), transform var(--dur-150) var(--ease-standard);
}
.ag-card > .ag-pic { grid-column: 1 / -1; margin-top: 8px; }
.ag-card::before {
  content: ""; position: absolute; left: 2px; top: 10px; bottom: 10px; width: 3px;
  border-radius: var(--radius-full); background: var(--ds-k, var(--edge)); pointer-events: none;
}
.ag-card[data-press="1"] { transform: scale(.99); background: var(--fill-active); }
@media (hover: hover) and (pointer: fine) {
  .ag-card:hover { background: var(--fill); }
  .ag-card:active { transform: scale(.99); background: var(--fill-active); }
}
.ag-card[data-on="1"],
.ag-card[data-selected="1"] { background: var(--well); box-shadow: 0 0 0 2px var(--ring-soft); }

.ag-when {
  position: relative; display: flex; flex-direction: column; align-items: flex-start;
  gap: 2px; padding-top: 1px; font-family: var(--type-mono);
}
.ag-end { display: inline-flex; align-items: baseline; gap: 4px; white-space: nowrap; }
.ag-d-times > .ag-end { gap: 6px; }
.ag-t { font-size: var(--size-14); font-weight: 600; color: var(--ink-1); font-variant-numeric: tabular-nums; line-height: 20px; }
.ag-t2, .ag-to { font-size: var(--size-12); font-weight: 500; color: var(--ink-2); font-variant-numeric: tabular-nums; line-height: 16px; }
.ag-slot[data-past="1"] .ag-t,
.ag-slot[data-past="1"] .ag-title { color: var(--ink-2); font-weight: 500; }
.ag-slot[data-past="1"] .ag-pic,
.ag-slot[data-past="1"] .ag-kind { opacity: 0.75; }
.ag-slot[data-past="1"] .ag-card::before { opacity: 0.6; }
.ag-tz {
  font-family: var(--type-mono); font-size: var(--size-12); font-weight: 500; letter-spacing: 0;
  padding: 0 5px; border-radius: var(--radius-8);
  background: var(--gray-3); color: var(--ink-2);
}

.ag-cardbody { position: relative; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ag-fill {
  position: absolute; inset: -4px auto -4px calc(var(--sp-2) * -1); width: 0;
  background: var(--ring-soft); border-radius: var(--radius-12); pointer-events: none;
  -webkit-mask-image: linear-gradient(to right, var(--ink-1) calc(100% - 24px), transparent);
  mask-image: linear-gradient(to right, var(--ink-1) calc(100% - 24px), transparent);
}
.ag-headend, .ag-title, .ag-where, .ag-pic { position: relative; }
.ag-headend { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 1px; }
.ag-title { display: block; font-size: var(--size-16); font-weight: 600; line-height: 22px; color: var(--ink-1); overflow-wrap: anywhere; }
.ag-where { display: flex; align-items: center; gap: 4px; font-size: var(--size-14); line-height: 20px; color: var(--ink-2); min-width: 0; }
.ag-where .ico { flex: 0 0 auto; width: 14px; height: 14px; stroke-width: 1.8; }
.ag-where-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-dist {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: var(--size-12); font-weight: 600; color: var(--ink-2);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.ag-dist-g { width: 13px; height: 13px; stroke-width: 1.8; }
.ag-kind {
  position: relative; display: grid; place-items: center;
  width: 28px; height: 28px; border-radius: var(--radius-full);
  color: var(--ds-k, var(--ink-2)); background: var(--ds-k-bg, var(--well));
  border: 1px solid var(--ds-k-edge, transparent); margin-top: 1px;
}
.ag-kind-g { width: 15px; height: 15px; }

.ag-media { position: relative; display: block; overflow: hidden; background: var(--well); }
.ag-pic, .ag-media-hero {
  width: 100%; aspect-ratio: 16 / 9; margin-top: var(--sp-2);
  border: 1px solid var(--edge); border-radius: var(--radius-16);
}
.ag-shot { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: cover; }

.ag-slot[data-live="1"] .ag-card { background: var(--well); }
.ag-slot[data-live="1"] .ag-kind { background: var(--ds-k, var(--solid)); border-color: var(--ds-k, var(--solid)); color: var(--on-solid); }
.ag-livepill {
  font-size: var(--size-12); font-weight: 700; letter-spacing: .03em;
  padding: 2px 8px; border-radius: var(--radius-full);
  background: var(--ds-k, var(--solid)); color: var(--on-solid);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.ag-nextpill {
  font-size: var(--size-12); font-weight: 600; letter-spacing: .02em;
  padding: 2px 8px; border-radius: var(--radius-full);
  background: var(--gray-3); color: var(--ink-1);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}

/* ── hanging chat chips ──────────────────────────────────────────────────────────────────── */
.ag-hang {
  position: absolute; z-index: 2;
  left: var(--ag-hang-l, 0px); right: 0; bottom: var(--ag-hang-b, 0px);
  display: flex; align-items: flex-start; gap: 8px; height: var(--ag-hn-h); pointer-events: none;
}
.ag-hang > * { pointer-events: auto; }
.ag-slot > .ag-hang { --ag-hang-l: calc(58px + var(--sp-3)); --ag-hang-b: 4px; }
.ag-slot:has(.ag-card-hero) > .ag-hang { --ag-hang-l: var(--sp-2); }
.ag-staywrap > .ag-hang { --ag-hang-l: var(--sp-3); --ag-hang-b: 0px; }
.ag-slot[data-hang="1"] { padding-bottom: calc(4px + var(--ag-hn-h) - var(--ag-hn-over)); }
.ag-slot[data-hang="1"] .ag-card { padding-bottom: 18px; }
.ag-staywrap { position: relative; }
.ag-staywrap[data-hang="1"] { padding-bottom: calc(var(--ag-hn-h) - var(--ag-hn-over)); }
.ag-staywrap[data-hang="1"] .ag-stay { padding-bottom: calc(6px + var(--ag-hn-over)); }
.ag-talk {
  position: relative; flex: 0 0 auto;
  display: inline-flex; align-items: center; gap: 5px;
  min-width: var(--ag-hn-w); height: 30px; margin-top: 4px; padding: 0 10px 0 9px;
  border-radius: var(--radius-full); border: 1px solid var(--edge);
  background: var(--chrome); color: var(--ink-1);
  font-size: var(--size-12); font-weight: 600; line-height: 1; text-decoration: none;
}
.ag-talk::before { content: ""; position: absolute; left: 0; right: 0; bottom: -4px; height: var(--tap); }
.ag-talk-g { width: 14px; height: 14px; stroke-width: 1.8; flex: 0 0 auto; }
.ag-talk[data-press="1"] { background: var(--fill-active); }
@media (hover: hover) and (pointer: fine) {
  .ag-talk:active { background: var(--fill-active); }
}

/* ── gap rails & Now live divider ────────────────────────────────────────────────────────── */
.ag-rail { position: relative; display: flex; align-items: center; min-height: var(--tap); }
.ag-rail-tight { min-height: 10px; }
.ag-gaplink {
  display: flex; align-items: center; gap: var(--sp-2);
  width: calc(100% + var(--sp-2) * 2); min-height: var(--tap);
  margin: 0 calc(var(--sp-2) * -1); padding: var(--sp-1) var(--sp-2);
  border-radius: var(--radius-12); color: inherit; text-decoration: none;
}
.ag-gaplink[data-press="1"] { background: var(--fill-active); }
@media (hover: hover) and (pointer: fine) {
  .ag-gaplink:hover { background: var(--fill); }
  .ag-gaplink:active { background: var(--fill-active); }
}
.ag-gaprail { flex: 0 0 58px; height: 1px; border-bottom: 1px dashed var(--edge); }
.ag-gaprow { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; }
.ag-gap { font-size: var(--size-12); font-weight: 600; letter-spacing: .015em; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.ag-chev { width: 14px; height: 14px; stroke-width: 2; color: var(--ink-3); flex: 0 0 auto; }
.ag-talk-gap { margin: 0 2px 0 6px; height: 24px; min-width: 0; pointer-events: none; }
.ag-talk-gap::before { content: none; }

.ag-rail-live { min-height: var(--tap); }
.ag-drain {
  position: absolute; left: 0; top: 4px; bottom: 4px; width: 2px;
  background: var(--ink-1); border-radius: var(--radius-full);
  transform-origin: bottom; transform: scaleY(0); z-index: 1;
}
.ag-nowgap { gap: var(--sp-2); padding-left: 10px; }
.ag-nowdot {
  flex: 0 0 auto; width: 8px; height: 8px; border-radius: var(--radius-full);
  background: var(--ink-1); box-shadow: 0 0 0 3px var(--ring-soft);
}
.ag-nowgap-row { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: var(--sp-2); }
.ag-nowgap-t { font-size: var(--size-14); font-weight: 600; color: var(--ink-1); white-space: nowrap; }
.ag-nowgap-sub { font-size: var(--size-14); font-weight: 500; color: var(--ink-1); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ag-nowgap-sub .ag-cd { font-variant-numeric: tabular-nums; font-weight: 600; }
.ag-nowrule { flex: 1 1 auto; min-width: 12px; height: 1px; background: var(--edge); }

/* ── free-time bottom sheet ──────────────────────────────────────────────────────────────── */
.ag-gapsheet { display: flex; flex-direction: column; gap: var(--sp-1); }
.ag-gapsheet-time { font-family: var(--type-mono); font-size: var(--size-14); color: var(--ink-2); font-variant-numeric: tabular-nums; }
.ag-gapsheet-title { margin: 0; color: var(--ink-1); }
.ag-gapsheet-sub { font-size: var(--size-14); color: var(--ink-2); margin-bottom: var(--sp-2); }
.ag-gapsheet-acts { display: flex; flex-direction: column; gap: 8px; margin-top: var(--sp-2); }
.ag-gapsheet-links { display: flex; flex-direction: column; margin-top: var(--sp-2); border-top: 1px solid var(--hair); }
.ag-gapsheet-link {
  display: flex; align-items: center; gap: 10px; min-height: var(--tap);
  padding: var(--sp-2) 0; color: var(--ink-1); font-size: var(--size-16);
  text-decoration: none; border-bottom: 1px solid var(--hair);
}
.ag-gapsheet-link:last-child { border-bottom: 0; }
.ag-gapsheet-link span { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-gapsheet-link .ico { width: 16px; height: 16px; color: var(--ink-2); flex: 0 0 auto; }
.ag-gapsheet .ag-g-bar { margin: var(--sp-2) 0; }
.ag-gapsheet .ag-after { margin-top: var(--sp-3); }
.ag-gapsheet .ag-d-notes { margin-top: var(--sp-3); }

/* ── plan & gap detail views (#/e/:id, #/e/:id?gap=1) ────────────────────────────────────── */
.ag-detail { padding-bottom: var(--sp-4); }

.ag-d-shot { margin: 0 0 var(--sp-4); }
.ag-d-shot .ag-media-hero { margin-top: 0; border-radius: var(--radius-24); }
.ag-d-head { display: flex; flex-direction: column; gap: var(--sp-2); }
.ag-d-acts { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-3); }
/* A plan's two things to do, side by side: Change, and Chat about this. Its photo's own buttons are further down. */
.ag-detail > .ag-d-acts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.ag-detail > .ag-d-acts .ds-button { min-width: 0; white-space: nowrap; }
.ag-detail .ph:has(.ag-d-photo) { margin-top: var(--sp-5, 24px); }
.ph .ag-d-acts { margin-top: 0; }
.ag-detail .ph .ag-d-acts { flex-wrap: nowrap; }
.ag-detail .ph .ag-d-acts :is(.btn, .ds-button) {
  flex: 1 1 auto; min-width: 0; padding: 0 10px; gap: 6px;
  font-size: var(--size-14); white-space: nowrap;
}
.ag-detail .ph .ag-d-acts :is(.btn, .ds-button) .ico { width: 15px; height: 15px; flex: 0 0 auto; }
.ag-detail .ph .ag-d-acts:has([data-photo="remove"]) {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
}
@media (max-width: 359px) {
  .ag-detail .ph .ag-d-acts :is(.btn, .ds-button) { padding: 0 8px; gap: 4px; }
  .ag-detail .ph .ag-d-acts :is(.btn, .ds-button) .ico { display: none; }
}
.ag-d-acts .btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  height: var(--control-44); padding: 0 18px; border-radius: var(--radius-16);
  border: 1px solid var(--edge); background: var(--fill); color: var(--ink-2);
  font-family: var(--type-ui); font-size: var(--size-16); font-weight: 500; cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .ag-d-acts .btn:hover { background: var(--fill-hover); color: var(--ink-1); }
}
.ag-d-acts .btn .ico { width: 18px; height: 18px; stroke-width: 1.8; }
.ag-d-acts .btn[data-armed] { color: var(--warning); border-color: var(--warning-edge); background: var(--warning-bg); }
.ag-empty-ways.empty { align-items: stretch; padding: var(--sp-4) 0 var(--sp-6); text-align: left; }
.ag-empty-ai { max-width: 38ch; margin-top: var(--sp-2); line-height: 1.45; font-size: var(--size-14); color: var(--ink-2); }
.ag-empty-ai a { color: var(--ink-1); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }

.ag-d-top { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); }
.ag-d-kind {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0;
  padding: 3px 10px 3px 8px; border-radius: var(--radius-full);
  background: var(--ds-k-bg, var(--well));
  border: 1px solid var(--ds-k-edge, var(--edge));
  font-size: var(--size-14); font-weight: 600;
  color: var(--ds-k, var(--ink-2));
}
.ag-d-kindg { flex: 0 0 auto; width: 15px; height: 15px; stroke-width: 1.9; }
.ag-d-date {
  flex: 0 0 auto; text-align: right;
  font-size: var(--size-14); font-weight: 400; color: var(--ink-2);
}
.ag-d-title { color: var(--ink-1); font-size: var(--size-28); }
.ag-d-clock { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
.ag-d-times { display: inline-flex; align-items: baseline; flex-wrap: wrap; gap: 6px; min-width: 0; font-family: var(--type-mono); }
.ag-d-t { font-size: var(--size-20); font-weight: 600; color: var(--ink-1); font-variant-numeric: tabular-nums; }
.ag-d-dur { flex: 0 0 auto; text-align: right; font-size: var(--size-14); font-weight: 500; color: var(--ink-2); font-variant-numeric: tabular-nums; }

/* ── place band on plan page ─────────────────────────────────────────────────────────────── */
.ag-band {
  margin: var(--sp-4) calc(var(--sp-4) * -1);
  background: var(--well);
  border-block: 1px solid var(--ds-k-edge, var(--hair));
}
.ag-band-in {
  display: flex; flex-direction: column; gap: 6px;
  padding: var(--sp-4) max(var(--sp-4), var(--sa-left));
}
.ag-b-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }
.ag-b-lead { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* The place's name opens its details (one row in place of a second button). */
a.ag-b-lead { min-height: var(--control-44); color: inherit; text-decoration: none; -webkit-tap-highlight-color: transparent; }
.ag-b-go { flex: 0 0 auto; width: 16px; height: 16px; color: var(--ink-3); }
.ag-b-ico {
  flex: 0 0 auto; display: grid; place-items: center;
  width: 26px; height: 26px; border-radius: var(--radius-full);
  background: var(--ds-k-bg, var(--gray-3)); border: 1px solid var(--ds-k-edge, transparent);
  color: var(--ds-k, var(--ink-2));
}
.ag-b-name { font-size: var(--size-16); font-weight: 600; color: var(--ink-1); min-width: 0; }
.ag-b-local { font-weight: 400; color: var(--ink-2); }
.ag-b-dist { flex: 0 0 auto; }
.ag-b-addr {
  display: flex; align-items: flex-start; gap: var(--sp-3);
  width: 100%; min-height: var(--tap);
  margin: 0 calc(var(--sp-2) * -1); padding: var(--sp-2);
  border-radius: var(--radius-12); text-align: left; color: inherit;
  border: 0; background: transparent; cursor: pointer;
}
.ag-b-addr[data-press="1"] { background: var(--fill-active); }
@media (hover: hover) and (pointer: fine) {
  .ag-b-addr:active { background: var(--fill-active); }
}
.ag-b-addrt { flex: 1 1 auto; font-size: var(--size-16); line-height: 1.45; color: var(--ink-1); }
.ag-b-copy { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; font-size: var(--size-12); font-weight: 700; color: var(--ink-1); }
.ag-b-copy .ico { width: 15px; height: 15px; stroke-width: 1.9; }
.ag-b-addr-done .ag-b-copy { color: var(--positive); }
.ag-b-note { font-size: var(--size-14); line-height: 1.45; color: var(--ink-2); }
.ag-b-acts { display: flex; gap: var(--sp-2); margin-top: var(--sp-2); }
.ag-b-act { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ag-b-act .ico { width: 16px; height: 16px; stroke-width: 1.8; flex: 0 0 auto; }
/* Wide two-pane: "+ Add a plan" in the left head is white, so Open in Maps goes gray here. */
#view[data-two="1"] .ag-b-act-maps {
  background: var(--fill); border-color: var(--edge); color: var(--ink-1); font-weight: 500;
}
@media (hover: hover) and (pointer: fine) {
  #view[data-two="1"] .ag-b-act-maps:hover { background: var(--fill-hover); }
}

.ag-d-body { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: var(--sp-4); }
.ag-d-p { font-size: var(--size-16); line-height: 1.55; color: var(--ink-2); white-space: pre-line; }
.ag-d-link {
  display: inline-flex; align-items: center; gap: 6px; margin-top: var(--sp-3);
  font-size: var(--size-14); font-weight: 600; color: var(--ink-1);
  text-decoration: underline; text-underline-offset: 3px;
}
.ag-d-link .ico { flex: 0 0 auto; width: 15px; height: 15px; stroke-width: 1.9; }

/* ── linked purchases on plan page ───────────────────────────────────────────────────────── */
.ag-d-split { margin-top: var(--sp-5); padding-top: var(--sp-4); border-top: 1px solid var(--hair); }
.ag-d-paylist { display: flex; flex-direction: column; margin-top: var(--sp-2); }
.ds-item.ag-d-pay { grid-template-columns: minmax(0, 1fr) auto auto; column-gap: 10px; }

/* ── gap page ────────────────────────────────────────────────────────────────────────────── */
.ag-g-big { font-variant-numeric: tabular-nums; }
.ag-g-sub { font-size: var(--size-14); line-height: 1.5; color: var(--ink-2); }
.ag-g-bar {
  height: 6px; border-radius: var(--radius-full); overflow: hidden;
  background: var(--well); border: 1px solid var(--edge);
}
.ag-g-barfill { display: block; height: 100%; background: var(--solid); }
.ag-after {
  display: flex; align-items: center; gap: var(--sp-3);
  margin-top: var(--sp-4); padding: var(--sp-3);
  border-block: 1px solid var(--hair); background: transparent; color: inherit;
  border-radius: var(--radius-16);
}
@media (hover: hover) and (pointer: fine) {
  .ag-after:hover { background: var(--fill); }
  .ag-after:active { background: var(--fill-active); }
}
.ag-after[data-press="1"] { background: var(--fill-active); }
.ag-after-g {
  flex: 0 0 auto; display: grid; place-items: center;
  width: 36px; height: 36px; border-radius: var(--radius-12);
  background: var(--ds-k-bg, var(--well));
  border: 1px solid var(--ds-k-edge, var(--hair));
  color: var(--ds-k, var(--ink-1));
}
.ag-after-ico { width: 18px; height: 18px; }
.ag-after-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1 1 auto; }
.ag-after-eyebrow { font-size: var(--size-12); font-weight: 600; color: var(--ink-2); }
.ag-after-title { font-size: var(--size-16); font-weight: 600; line-height: 1.3; color: var(--ink-1); }
.ag-after-meta { font-size: var(--size-14); color: var(--ink-2); }
.ag-after .ag-chev { flex: 0 0 auto; color: var(--ink-3); }
.ag-g-near { margin-top: var(--sp-3); max-width: 100%; overflow: hidden; }
.ag-g-neart { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ag-g-near .ico { width: 16px; height: 16px; stroke-width: 1.8; flex: 0 0 auto; }

/* ── what has been said ──────────────────────────────────────────────────────────────────── */
.ag-d-notes { margin-top: var(--sp-5); }
.ag-d-h2 {
  display: flex; align-items: center; gap: 6px;
  font-family: var(--type-head); font-weight: 500; font-size: var(--size-20); letter-spacing: var(--track-head);
  color: var(--ink-1); margin-bottom: var(--sp-3);
}
.ag-d-h2g { width: 18px; height: 18px; stroke-width: 1.8; color: var(--ink-2); }
.ag-notes-none { font-size: var(--size-14); line-height: 1.5; color: var(--ink-2); }

@media (prefers-reduced-motion: reduce) {
  .ag-dayhead::after, .ag-card { transition: none; }
}
`;

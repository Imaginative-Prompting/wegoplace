// GET  /api/trips/<trip>  -> { trip, members, areas, places, events,
//                              packing, packing_lists, packing_placements, packing_ticks, packing_starters,
//                              note_colors, purchases, currencies, fx, storage, handover, tiles, rev }
//
// `storage` is what every member may see of the host's room: { host_id, limit, host_used,
// trip_bytes } (src/trips/storage.js). `handover` is the trip's offer to a member, or null
// (src/trips/members.js). `tiles` is the trip's offline map (served at GET …/tiles): null when it
// has none and none is being made, else { state, version, bytes, at, source, note, glyphs }
// (src/map/; docs/API.md "The trip's map").
//
// `packing` is the caller's own items and the group's; `packing_placements` and
// `packing_ticks` are theirs. `packing_lists` are the trip's lists, each with its bags in
// order; `packing_starters` its suggested items (src/api/packing.js says how they fit).
// There is no import: a trip is filled through the routes that write each thing (areas,
// places, events, packing lists and starters), which hold every row to the same checks
// (tools/seed-trip.mjs puts a seed file through them).
//
// GET returns the WHOLE app state, not just the trip row, because that is store.js's wire
// contract and the contract is load-bearing: the client hydrates IndexedDB from one
// snapshot, so there is exactly one request that has to have succeeded before the signal
// goes. Five separate fetches would be five ways to be half-offline — a phone that caught
// events on the last bar and missed places has an agenda full of events pointing at places
// it cannot name. The per-collection routes still exist for curl and debugging; nothing in
// the app calls them.
//
// Which trip, and whether the caller is on it, is settled before this file runs: the route
// table wraps every row under /api/trips/<trip> (src/trips/access.js) and hands the trip's
// row over as ctx.data.trip.
//
// This file is also where the other trip routes get their shared pieces: the id/field
// validators and the error constructor.
//
// The imports below are circular — events.js and friends import err and the validators from here.
// That is fine in ESM: every binding involved is a hoisted function declaration or is only
// read inside a handler, i.e. long after both modules have finished evaluating. The
// alternative — a second copy of each SELECT in this file — is what let end_tz go missing
// from the API while sitting correctly in the schema and the seed.

import { tilesShape } from "../map/shape.js";
import { json } from "./json.js";
import { listEvents } from "./events.js";
import { listPlaces } from "./places.js";
import { listReferences } from "./references.js";
import { listPacking, listPlacements, listTicks } from "./packing.js";
import { listPackingLists } from "./packing/lists.js";
import { listStarters } from "./packing/starters.js";
import { listAreas } from "../trips/areas.js";
// The three keys migration 0011 added to this snapshot. Both modules own their own surface —
// purchases.js the rows and their shares, fx.js the cached rate table — and this file only
// composes them, the same way it composes places and events. See splitKeys() below for the
// one rule that governs all three: nothing they do may be able to fail this request.
import { listPurchases } from "./purchases.js";
import { kickRates, readFxTable } from "./fx.js";
import { messageCounts } from "./messages.js";
import { tripCurrencies, tripShape } from "../trips/access.js";
import { storageLine } from "../trips/storage.js";
import { handoverShape } from "../trips/members.js";
import { picturesOf, pictureShape } from "../trips/pictures.js";
import { REV, write } from "../trips/rev.js";
import { newestChangeFor } from "../trips/changes.js";
import { errorLine } from "../log.js";

export const nowSec = () => Math.floor(Date.now() / 1000);
// headers: a 429's Retry-After (every refusal for too many says, in words and in seconds, when to try again).
export const err = (status, error, extra, headers) => json({ error, ...extra }, status, headers);

// ── a person's color ──────────────────────────────────────────────────────────────────
// Each person has one color: it marks their face in Split, in Chat and wherever people appear,
// beside their initials. The first four hues were the auto-assigner's, one per person on a trip,
// and they have to survive DEUTERANOPIA: for someone red-green colorblind, two people landing on
// a pair they cannot separate undoes the only reason the color exists.
//
// There is no red and no green in this palette at all, so the forbidden pair cannot occur.
// The four are separated by hue AND by lightness, which is the part that survives when hue
// collapses: under deuteranopia they read as dark blue, light blue, dark amber, pale mauve —
// four distinct values in a greyscale sense, not four names for the same grey.
//
//   #0072B2  deep blue      #56B4E9  sky
//   #E69F00  amber          #CC79A7  mauve
//
// Color is still never the only signal: every face carries the person's initials, which is
// what actually names them. The hue is how you scan a screen of people at a glance.
/* TWENTY, not four. Four was the number the AUTO-assigner needed — one distinct hue per
   traveller, chosen so no two people on a four-person trip could collide. Picking your own is
   a different job: your face already carries your INITIALS, so the color is not what names
   you and it no longer has to survive being told apart from three others at a glance. What it
   still has to do is stay legible, and every hue below was measured against the ink inkOn()
   computes for it — the tightest is Leather at 4.83 : 1, and scripts/theme_contrast.js
   re-checks all twenty on every run.
   The first four are the originals and stay first, so nobody's existing color changes. */
export const NOTE_COLORS = [
  "#0072B2", "#E69F00", "#CC79A7", "#56B4E9",
  "#009E73", "#4CAF88", "#0F9B9B", "#8BC34A",
  "#F0C808", "#D55E00", "#E8743B", "#A8763E",
  "#C2185B", "#B5179E", "#7B5BD6", "#5B6ABF",
  "#78909C", "#6D6875", "#2E2E2E", "#E0E0E0",
];

// The names above, as data. A person picks their own hue (Your color, on the account page and
// in More), and every picker has to print the name beside every swatch, because a
// grid of four coloured dots is, to the person this palette was designed for, a grid of about
// two. The names ship from here WITH the palette so there is one table rather than a copy in
// settings.js and another in agenda.js, drifting apart the first time a fifth hue is added.
export const NOTE_COLOR_NAMES = {
  "#0072B2": "Deep blue", "#E69F00": "Amber",   "#CC79A7": "Mauve",   "#56B4E9": "Sky",
  "#009E73": "Green",     "#4CAF88": "Sea",     "#0F9B9B": "Teal",    "#8BC34A": "Moss",
  "#F0C808": "Sun",       "#D55E00": "Rust",    "#E8743B": "Coral",   "#A8763E": "Leather",
  "#C2185B": "Cherry",    "#B5179E": "Magenta", "#7B5BD6": "Violet",  "#5B6ABF": "Indigo",
  "#78909C": "Slate",     "#6D6875": "Heather", "#2E2E2E": "Charcoal", "#E0E0E0": "Paper",
};
export const noteColorList = () =>
  NOTE_COLORS.map((hex) => ({ hex, name: NOTE_COLOR_NAMES[hex] || hex }));

// The check PATCH /api/me makes before it writes (functions/api/me.js). It lives here, beside
// the palette, so the validator cannot end up looking at a different list from the one the
// pickers were offered. An arbitrary hex from a client is refused rather than stored: the ink
// on a face is COMPUTED from its hue by inkOn(), so a color nobody measured is a set of
// initials nobody can read, on everyone else's screen.
export const isNoteColor = (v) => typeof v === "string" && NOTE_COLORS.includes(v);

// "ada reyes" -> AR, "ada" -> AD. Two characters, because with four people one letter
// collides often enough to matter and a face has room for exactly two.
export function initialsOf(name) {
  const parts = String(name || "").trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

// FNV-1a over the user id. Deterministic and stable across devices and reinstalls, which a
// "next free colour" counter would not be.
function hueIndex(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % NOTE_COLORS.length;
}

// Assign on first read, then persist. The hash picks the STARTING hue and the loop walks
// forward past any hue somebody already holds: with four ids into four buckets a pure hash
// collides better than half the time, and two people with identical stickies is the exact
// failure this column exists to prevent. Persisting means the answer never changes once
// given, even as the roster grows.
//
// Scoped to everyone who has ever been on this trip: the uniqueness has to hold across
// everyone who can have written a note here, and a member who left still has notes on the
// agenda. A colour is the account's, so someone who joins with one keeps it, even if a member
// already wears it (the initials are what name a person).
//
// A colour given here shows on the trip's roster, so giving one is a write to the trip: its
// rev goes up and the member rows take it. Answers that rev, or null when nobody needed one.
/** A hue for `id` that nobody in `taken` wears, starting from its own (or its own, if all are). */
function pickColour(id, taken) {
  const start = hueIndex(id);
  for (let k = 0; k < NOTE_COLORS.length; k++) {
    const c = NOTE_COLORS[(start + k) % NOTE_COLORS.length];
    if (!taken.has(c)) return c;
  }
  return NOTE_COLORS[start];
}

/**
 * The colour to give `userId` in the same write that puts them on trip `tripId` (a join, a new
 * trip), so that reading the trip never has to: null when they already have one. Read from the
 * colours the trip's people wear now; the write guards it with `note_color IS NULL`.
 */
/** The colour a person not yet in the database (a guest being made) would be given on this trip. */
export async function colourForNew(env, tripId, userId) {
  const rows = (await env.DB.prepare(
    "SELECT u.note_color FROM trip_members m JOIN users u ON u.id = m.user_id WHERE m.trip_id = ?1 AND u.deleted_at IS NULL AND u.note_color IS NOT NULL",
  ).bind(tripId).all()).results || [];
  return pickColour(userId, new Set(rows.map((r) => r.note_color)));
}

export async function colourFor(env, tripId, userId) {
  const rows = (await env.DB.prepare(
    `SELECT id, note_color FROM users WHERE id = ?2
     UNION SELECT u.id, u.note_color FROM trip_members m JOIN users u ON u.id = m.user_id WHERE m.trip_id = ?1 AND u.deleted_at IS NULL`,
  ).bind(tripId, userId).all()).results || [];
  const me = rows.find((r) => r.id === userId);
  if (!me || me.note_color) return null;
  return pickColour(userId, new Set(rows.filter((r) => r.note_color).map((r) => r.note_color)));
}

// The backstop, for rows from before joins gave colours: a read finds a living member without
// one. A join and a new trip give it in their own write (colourFor), so this finds nobody.
export async function ensureNoteColors(env, tripId) {
  const rows = await env.DB.prepare(
    "SELECT u.id, u.note_color FROM trip_members m JOIN users u ON u.id = m.user_id " +
    // A deleted account keeps its name and nothing else, its colour included: it is never
    // given one again (and a read never writes for it).
    "WHERE m.trip_id = ?1 AND u.deleted_at IS NULL ORDER BY u.id").bind(tripId).all();
  const users = rows.results || [];
  if (!users.some((u) => !u.note_color)) return null;

  const taken = new Set(users.filter((u) => u.note_color).map((u) => u.note_color));
  const stmts = [];
  for (const u of users) {
    if (u.note_color) continue;
    const colour = pickColour(u.id, taken);
    taken.add(colour);
    // The IS NULL guard makes two concurrent first-reads idempotent instead of racing.
    stmts.push(env.DB.prepare(
      "UPDATE users SET note_color = ?1 WHERE id = ?2 AND note_color IS NULL").bind(colour, u.id));
    stmts.push(env.DB.prepare(
      `UPDATE trip_members SET rev = ${REV(1)} WHERE trip_id = ?1 AND user_id = ?2`).bind(tripId, u.id));
  }
  // The trip's rev after it, for a caller that is about to answer with one.
  return (await write(env, tripId, stmts)).rev;
}

// Ids may come from the client (see the idempotency note in events.js), so they are
// constrained to what can sit in a URL path segment and an IndexedDB key without escaping.
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const validId = (v) => typeof v === "string" && ID_RE.test(v);

// Epoch SECONDS everywhere, matching the schema and seed. A client that passes Date.now()
// lands ~1000x in the future and silently sorts to the bottom of the agenda forever, which
// looks like "my event vanished" rather than like a bug. Catch it at the boundary.
const MAX_EPOCH_SEC = 1e11;
export function validEpoch(v) {
  return Number.isInteger(v) && v > 0 && v < MAX_EPOCH_SEC;
}

// A bad IANA zone does not fail here — it fails later, inside Intl on every phone, and
// util.js's fmtTime throwing takes the whole agenda render with it. Reject it once, on
// write, instead of once per device.
export function validTz(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

export function str(v, max, { trim = true } = {}) {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (trim) s = s.trim();
  return s.length > max ? s.slice(0, max) : s;
}

// ── the three keys migration 0011 added, and the rule that governs all of them ──────────
//
// THIS IS THE MOST LOAD-BEARING ROUTE IN THE APP. It is the one request that has to have
// succeeded before the signal goes; a 500 here is not a missing tab, it is a phone with no
// trip on it. AGENTS.md records the time that actually happened: a migration applied --local
// only, then code deployed that selected a column the remote database did not have, and
// /api/trip threw for every user at once.
//
// So EVERY read below is individually wrapped, and a failure costs its OWN KEY and nothing
// else. If migration 0011 has not reached the database this route is talking to, the answer is
// a trip with no purchases and no rates — which is exactly the app as it was last week — and
// not a 500. That is deliberately a different trade from the rest of this file: places and
// events are the app, and a snapshot without them is not worth serving.
//
// Nothing client-side reads trip.currencies off the trip row — store.js keeps the short list
// as its own `meta` singleton, fed by the `currencies` key below.
const safe = async (what, fn) => {
  try {
    return await fn();
  } catch (e) {
    console.warn(JSON.stringify({ trip_part_unavailable: what, error: errorLine(e) }));
    return null;
  }
};

/** Where the trip's currency short list STARTS — the trip's own list, as stored on its row. */
const seededCurrencies = (trip) => tripCurrencies(trip);

/**
 * Everybody's chosen home currency, by user id. It rides the MEMBER ROW as `native_currency`
 * (members carry native_currency) because store.js's myNativeCurrency()
 * reads it off the roster, and it also feeds the union below — the currency you want your
 * totals in belongs in the picker's short list whether or not anybody has spent in it yet.
 *
 * A SEPARATE QUERY rather than one more column on the roster SELECT above, for the reason
 * given at the top of this block: that SELECT is the roster, and the roster failing is the
 * snapshot failing. This one can fail on its own and cost only itself.
 */
async function nativeCurrencies(env, tripId) {
  const rs = await env.DB.prepare(
    "SELECT u.id, u.native_currency FROM trip_members m JOIN users u ON u.id = m.user_id " +
    "WHERE m.trip_id = ?1"
  ).bind(tripId).all();
  const out = new Map();
  for (const r of (rs && rs.results) || []) {
    const c = String(r.native_currency || "").trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(c)) out.set(r.id, c);
  }
  return out;
}

/**
 * The AI apps that have written to a trip, from its list of changes (src/trips/changes.js): a change an app made says
 * so in its source ("oauth:<the app's name>", src/mcp/server.js). One line an app and the person it acts for, in the
 * order they first wrote: its name, the person, how many writes (an undo isn't one), the first and the last. This
 * trip's changes only, so no other trip's count can be read here.
 */
export async function appsAddingTo(env, tripId) {
  const rows = await env.DB.prepare(
    `SELECT source, user_id, COUNT(*) AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM trip_changes
     WHERE trip_id = ?1 AND source LIKE 'oauth:%' AND kind IN ('write', 'create')
     GROUP BY source, user_id ORDER BY first_at, source`,
  ).bind(tripId).all();
  return (rows.results ?? []).map((r) => ({ app: String(r.source).slice("oauth:".length), by: r.user_id, count: r.n, first_at: r.first_at, last_at: r.last_at }));
}

/**
 * The people of a trip, as the snapshot's `members`: everyone who is or has been on it. Someone
 * who left or was removed stays in the list with `left_at`, and an account that was deleted
 * with `deleted`, because what they wrote and paid is still on the trip under their id and the
 * app has to be able to name it. `role` is 'host' for the one account the trip's row names.
 */
export async function listMembers(env, trip) {
  const rows = await env.DB.prepare(
    "SELECT u.id, u.name, u.note_color, u.initials, u.deleted_at, u.guest, u.avatar, m.joined_at, m.left_at, m.rev " +
    "FROM trip_members m JOIN users u ON u.id = m.user_id WHERE m.trip_id = ?1 ORDER BY m.joined_at, u.name"
  ).bind(trip.id).all();
  // INITIALS ARE CHOSEN, WITH A DERIVED DEFAULT. initialsOf(name) is a good guess and a bad
  // rule — two people called Alex Rivera and Ana Ruiz both come out "AR" — so a stored value
  // wins and NULL means "keep guessing".
  return (rows.results || []).map((r) => ({
    id: r.id, name: r.name, role: r.id === trip.host_id ? "host" : "member",
    joined_at: r.joined_at, left_at: r.left_at ?? null, deleted: !!r.deleted_at, guest: !!r.guest,
    note_color: r.note_color || null, initials: r.initials || initialsOf(r.name), rev: r.rev,
    // The picture they drew, by its hash (GET /api/avatars/<hash>), only when there is one: a trip where nobody draws
    // answers byte for byte as before.
    ...(r.avatar ? { avatar: r.avatar } : {}),
  }));
}

export async function onRequestGet(ctx) {
  const { user: u } = ctx.data;
  let { trip } = ctx.data;

  // Being on the trip was checked by the route table, and nothing here enrolls anyone. The
  // caller's row in trip_members is also the roster the packing tabs read: it is how the app
  // knows whose own lists exist.

  // Both bootstraps run before anything is read, and both only write when there is something
  // missing: a colour nobody has been given, or a person with no packing views at all. They
  // are here rather than in a setup step because there is no setup step — a phone that
  // registers on hotel wifi the night before has exactly this one request to get everything
  // it needs. Each is a write to the trip when it writes, so each takes the trip's rev up.
  await ensureNoteColors(ctx.env, trip.id);

  // The rev this answer carries is read BEFORE the collections. If someone writes while they
  // are being read, this answer may hold the newer row under an older rev, and the client's
  // next look at the rev sends it back for the snapshot once more. The other order would let
  // a write slip between the two unseen.
  const now = await ctx.env.DB.prepare("SELECT rev, data_rev, message_seq FROM trips WHERE id = ?1").bind(trip.id).first();
  trip = { ...trip, rev: now?.rev ?? trip.rev, data_rev: now?.data_rev ?? trip.data_rev, message_seq: now?.message_seq ?? trip.message_seq };

  // SINCE MY LAST (?since=<the rev of the snapshot the phone holds>, migration 0036). The rows written after
  // it, what went after it (trip_gone), and whole only the small collections that moved; what is worked out
  // from the whole trip (the people, the currencies, the storage line, the newest change) is sent as always.
  // A since under the trip's floor (what went before it isn't remembered) or past its rev: the whole trip,
  // with nothing said. store.js merges a delta into what it holds (public/js/shared/delta.js).
  const since = await sinceFor(ctx.env, trip, new URL(ctx.request.url).searchParams.get("since"));
  const delta = since === null ? null : await deltaOf(ctx.env, trip.id, since, u);

  // note_color and initials ride on the member row so the UI can draw a legend, and so a
  // message whose author is not in this list is still the only case needing a fallback.
  const members = await listMembers(ctx.env, trip);

  // Ten small queries in parallel. The whole trip is ~500 rows; the cost of composing it
  // here is nothing next to the cost of a client that has to be online eleven times.
  //
  // The last four are migration 0011's, and every one of them is wrapped so that it resolves
  // rather than rejects — see the block above splitKeys' helpers. readFxTable() holds that
  // guarantee itself and needs no wrapper; the other three go through safe(), which answers
  // null for "this source is not available" and is the only value the composition below treats
  // as a failure.
  const [
    areas, places, events, packing, packing_lists, packing_placements, packing_ticks, packing_starters,
    purchases, seeded, natives, fx, storage, offer, pictures, chatAbout, mute, newestChange, references,
  ] = await Promise.all([
      !delta || delta.moved.areas ? listAreas(ctx.env, trip.id) : null,
      listPlaces(ctx.env, trip.id, delta ? { since, also: delta.pictured.place } : {}),
      listEvents(ctx.env, trip.id, delta ? { since, also: delta.pictured.event } : {}),
      listPacking(ctx.env, trip.id, u, delta ? { since } : {}),
      !delta || delta.moved.lists ? listPackingLists(ctx.env, trip.id) : null,
      !delta || delta.moved.placements ? listPlacements(ctx.env, trip.id, u) : null,
      !delta || delta.moved.ticks ? listTicks(ctx.env, trip.id, u) : null,
      !delta || delta.moved.starters ? listStarters(ctx.env, trip.id) : null,
      safe("purchases", () => listPurchases(ctx.env, trip.id, delta ? { since, also: delta.pictured.purchase } : {})),
      safe("trip currencies", () => seededCurrencies(trip)),
      safe("native currencies", () => nativeCurrencies(ctx.env, trip.id)),
      readFxTable(ctx.env),
      storageLine(ctx.env, trip, nowSec()),
      ctx.env.DB.prepare("SELECT to_user, offered_by, offered_at, rev FROM trip_handovers WHERE trip_id = ?1").bind(trip.id).first(),
      delta ? delta.pictures : picturesOf(ctx.env, trip.id),
      !delta || delta.moved.chat ? messageCounts(ctx.env, trip.id) : null,
      ctx.env.DB.prepare("SELECT chat_muted FROM trip_members WHERE trip_id = ?1 AND user_id = ?2").bind(trip.id, u.id).first(),
      newestChangeFor(ctx.env, trip.id, u),
      // The trip's reference list (migration 0048): always sent, [] included (an absent collection reads as unchanged).
      listReferences(ctx.env, trip.id, delta ? { since } : {}),
    ]);

  // The AI apps adding to this trip (its list of changes, by the app and the person it acts for).
  const appsAdding = await appsAddingTo(ctx.env, trip.id);

  // Fire a rate refresh in the background if the table is due, and NEVER await it: the one
  // request that has to succeed on hotel wifi does not get to depend on a third party being up
  // kickRates() holds the waitUntil and cannot throw or reject.
  kickRates(ctx, fx);

  // native_currency rides the member row, exactly like note_color and initials above, so
  // store.js's myNativeCurrency() can read it off the roster. `natives` being null — the column
  // is not there yet — leaves the field OFF the row rather than putting null on it, so the
  // client's `(mine && mine.native_currency) || "USD"` takes the same branch either way.
  const roster = natives
    ? members.map((m) => (natives.has(m.id) ? { ...m, native_currency: natives.get(m.id) } : m))
    : members;

  // THE PICKER'S SHORT LIST, computed rather than stored: only the currencies a trip needs.
  // Two items on most trips, not a scroll through 180.
  //
  // It is a UNION, and that is why there is no PATCH for it and no screen that can configure it
  // wrong: trips.currencies is where the trip STARTS (a seed may say JPY and USD), and anything
  // anybody actually pays in, plus everybody's chosen home currency, is in the list from then
  // on by construction. Paying for one thing in EUR puts EUR in the list.
  //
  // THE ORDER IS PART OF THE CONTRACT AND IT IS NOT ALPHABETICAL. store.js's currencies() says
  // "in the server's order — first entry is the trip's home currency", and split.js leans on
  // that hard: a drawer opened on a device that has not chosen a currency yet is denominated in
  // `list[0]`, so this array decides what the next purchase is priced in.
  //
  // MEASURED, NOT REASONED: sorting the union alphabetically — which is what an earlier
  // version of this function did — means one €50 dinner on a trip priced in JPY moves `list[0]`
  // from JPY to EUR, and every later purchase on every device opens in euros until somebody
  // notices. A test database showed it: a whole harness run changed currency underneath itself.
  //
  // So the order is: the SEEDED list first, exactly as stored, because a trip that declares its
  // currencies has declared its home one (that is `trips.currencies`, and it is the answer this
  // should normally be using). Then everything discovered since, MOST USED FIRST, with the
  // alphabet only as a tie-break so the result is still deterministic. Most-used is not a
  // guess: it is the closest thing to "what this trip is actually priced in" that can be read
  // off the data, it needs no configuration, and it cannot be flipped by a single outlier the
  // way the alphabet can. A currency somebody has only chosen as their native one has no
  // purchases at all, sorts last, and correctly never becomes the default for anybody else.
  //
  // OMITTED ENTIRELY when all three sources failed, and that is not tidiness. applySnapshot()
  // reads `if (Array.isArray(snap.currencies))`, so an empty array MEANS "the trip has no
  // currencies" and would wipe a list the phone already had; an absent key means "unchanged".
  // An empty union from sources that all answered is a real answer and is sent as [].
  const anySource = purchases !== null || seeded !== null || natives !== null;
  const ok = (c) => /^[A-Z]{3}$/.test(String(c || "").toUpperCase());
  const home = (seeded || []).map((c) => String(c).toUpperCase()).filter(ok);

  // How often each currency is paid in, over every purchase: from the rows when they're all here, else counted
  // (a delta holds only the purchases that changed).
  const uses = new Map();
  const counted = delta && purchases !== null ? await currencyUses(ctx.env, trip.id) : null;
  for (const [c0, n] of counted ?? (purchases || []).map((p) => [p.currency, 1])) {
    const c = String(c0 || "").toUpperCase();
    if (ok(c)) uses.set(c, (uses.get(c) || 0) + n);
  }
  for (const c of natives ? natives.values() : []) if (!uses.has(c)) uses.set(c, 0);
  const found = [...uses.keys()].sort((a, b) => (uses.get(b) - uses.get(a)) || (a < b ? -1 : 1));

  const currencies = [...new Set([...home, ...found])];

  // `packing` is the item rows, as it always was; the lists, placements, ticks and starters
  // hang beside it (migration 0019 made the lists the trip's).
  // note_colors is the PALETTE, not anybody's colour — the four hexes with their names, so a
  // client can draw the picker without holding a second copy of a table the server validates
  // against. It rides the snapshot rather than getting its own route for the usual reason:
  // the phone gets exactly one request in before the signal goes, and a picker that only
  // works on wifi is a picker that does not work on this trip.
  //
  // `purchases`, `currencies` and `fx` are migration 0011's, and they are additive in exactly
  // the same sense: a phone still running last week's bundle destructures the keys it knows and
  // ignores these three. store.js has been ready for all three since it was written — ROWSTORES
  // already lists "purchases", and applySnapshot() already reads `currencies` and `fx` by name.
  // Until this line existed, a purchase made on one phone reached D1 and stopped there.
  //
  // `purchases` is ALWAYS present when the query worked, [] included — applySnapshot() treats
  // an absent collection as "unchanged", not "empty", so omitting the key on a trip with no
  // purchases would make a locally-deleted purchase immortal. It is omitted ONLY when the read
  // failed outright, which is the one case where "unchanged" is the correct thing to say.
  // Each place's and event's picture, the trip's cover, each purchase's receipt (pictures.js).
  const pictureOf = (kind, id) => pictures.get(`${kind}:${id}`) ?? null;
  // A delta's pictures are those of the rows it sends (and the cover): read for them alone.
  if (delta) await delta.fillPictures(ctx.env, trip.id, { place: places.map((p) => p.id), event: events.map((e) => e.id), purchase: (purchases || []).map((p) => p.id) }, pictures);
  for (const p of places) p.picture = pictureOf("place", p.id);
  for (const e of events) e.picture = pictureOf("event", e.id);
  for (const p of purchases || []) if (p.kind === "purchase") p.receipt = pictureOf("purchase", p.id);
  return json({
    // newest_change: the rev of the newest line in the trip's list of changes this person has
    // something to notice in (src/trips/changes.js), for the mark on Other; null when none.
    ...(delta ? { delta: true, since, gone: delta.gone } : {}),
    // The keys in the order a whole answer always had them (parity reads the text); a delta leaves out the small
    // collections that didn't move.
    trip: { ...tripShape(trip), cover: pictureOf("cover", ""), newest_change: newestChange }, members: roster,
    ...(areas !== null ? { areas } : {}), places, events, packing,
    ...(packing_lists !== null ? { packing_lists } : {}), ...(packing_placements !== null ? { packing_placements } : {}),
    ...(packing_ticks !== null ? { packing_ticks } : {}), ...(packing_starters !== null ? { packing_starters } : {}),
    note_colors: noteColorList(),
    ...(purchases !== null ? { purchases } : {}),
    references,
    ...(anySource ? { currencies } : {}),
    fx,
    storage, handover: handoverShape(offer), tiles: tilesShape(trip),
    // The chat's counter and how many messages are about each thing (the messages themselves are
    // read from …/messages), and whether this person has muted it.
    chat: { seq: trip.message_seq, ...(chatAbout !== null ? { about: chatAbout } : {}), muted: !!mute?.chat_muted },
    // Each AI app that has written to this trip: its name, who it acts for, how many changes it has made here and
    // when the first and last were. Only when one has: a trip no app has touched answers as it always did.
    ...(appsAdding.length ? { apps_adding: appsAdding } : {}),
    rev: trip.rev, data_rev: trip.data_rev,
    // Whether this site makes maps (a map maker is bound): a trip with no area says what an area
    // would bring only where one does.
    maps: !!ctx.env.MAPS,
  });
}


// ── since my last (migration 0036) ─────────────────────────────────────────────────────────────

/** The since a phone asked for, when the trip can answer it: from its floor up to its rev; else null (the whole trip). */
async function sinceFor(env, trip, raw) {
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null;
  const since = Number(raw);
  if (since > trip.rev) return null;
  const floor = await env.DB.prepare("SELECT rev FROM trip_delta_floor WHERE trip_id = ?1").bind(trip.id).first();
  return since < (floor?.rev ?? 0) ? null : since;
}

/**
 * What moved after `since`: what went (by table, someone's own packing item only to them), which small
 * collections are sent whole, the rows whose picture changed (sent again with it), and the pictures.
 */
async function deltaOf(env, tripId, since, user) {
  const [goneRows, flags, pics] = await env.DB.batch([
    env.DB.prepare("SELECT tbl, row_key, private_to FROM trip_gone WHERE trip_id = ?1 AND rev > ?2").bind(tripId, since),
    env.DB.prepare(`SELECT
        EXISTS (SELECT 1 FROM areas WHERE trip_id = ?1 AND rev > ?2) AS areas,
        EXISTS (SELECT 1 FROM packing_lists WHERE trip_id = ?1 AND rev > ?2) AS lists,
        EXISTS (SELECT 1 FROM packing_bags WHERE trip_id = ?1 AND rev > ?2) AS bags,
        EXISTS (SELECT 1 FROM packing_items WHERE trip_id = ?1 AND rev > ?2) AS items,
        EXISTS (SELECT 1 FROM packing_placements WHERE trip_id = ?1 AND rev > ?2) AS placements,
        EXISTS (SELECT 1 FROM packing_ticks WHERE trip_id = ?1 AND rev > ?2) AS ticks,
        EXISTS (SELECT 1 FROM packing_starters WHERE trip_id = ?1 AND rev > ?2) AS starters,
        EXISTS (SELECT 1 FROM messages WHERE trip_id = ?1 AND rev > ?2 AND about_kind IS NOT NULL) AS chat,
        EXISTS (SELECT 1 FROM trip_members WHERE trip_id = ?1 AND rev > ?2) AS members`).bind(tripId, since),
    env.DB.prepare("SELECT target_kind, target_id FROM pictures WHERE trip_id = ?1 AND rev > ?2").bind(tripId, since),
  ]);
  const gone = { places: [], events: [], purchases: [], packing: [], references: [] };
  const wentFrom = new Set();
  const pictured = { place: [], event: [], purchase: [] };
  for (const g of goneRows.results ?? []) {
    wentFrom.add(g.tbl);
    if (g.tbl === "packing_items") { if (g.private_to === null || g.private_to === user.id) gone.packing.push(g.row_key); }
    else if (g.tbl === "trip_references") gone.references.push(g.row_key);
    else if (g.tbl in gone) gone[g.tbl].push(g.row_key);
    else if (g.tbl === "pictures") { const [kind, ...id] = g.row_key.split("/"); if (kind in pictured) pictured[kind].push(id.join("/")); }
  }
  for (const p of pics.results ?? []) if (p.target_kind in pictured) pictured[p.target_kind].push(p.target_id);
  const f = flags.results?.[0] ?? {};
  const items = !!f.items || wentFrom.has("packing_items");
  const moved = {
    areas: !!f.areas || wentFrom.has("areas"),
    lists: !!f.lists || !!f.bags || wentFrom.has("packing_lists") || wentFrom.has("packing_bags"),
    // Placements and ticks are read through their items' owners: an item that moved or went moves them.
    placements: !!f.placements || wentFrom.has("packing_placements") || items,
    ticks: !!f.ticks || wentFrom.has("packing_ticks") || items,
    starters: !!f.starters || wentFrom.has("packing_starters"),
    // The counts of what was said about each thing, and the words before each plan with their writers' names
    // (a rename moves the writer's member row).
    chat: !!f.chat || !!f.members,
  };
  return {
    moved, gone, pictured,
    pictures: new Map(),
    /** The pictures of the rows this delta sends, and the cover, into `into`. */
    async fillPictures(env2, trip, ids, into) {
      const rows = (await env2.DB.prepare(
        `SELECT * FROM pictures WHERE trip_id = ?1 AND (target_kind = 'cover'
           OR (target_kind = 'place' AND target_id IN (SELECT value FROM json_each(?2)))
           OR (target_kind = 'event' AND target_id IN (SELECT value FROM json_each(?3)))
           OR (target_kind = 'purchase' AND target_id IN (SELECT value FROM json_each(?4))))`,
      ).bind(trip, JSON.stringify(ids.place), JSON.stringify(ids.event), JSON.stringify(ids.purchase)).all()).results ?? [];
      for (const r of rows) into.set(`${r.target_kind}:${r.target_id}`, pictureShape(r));
    },
  };
}

/** How many purchases are paid in each currency, over the whole trip: [[currency, n], …]. */
async function currencyUses(env, tripId) {
  const rows = (await env.DB.prepare("SELECT currency, COUNT(*) AS n FROM purchases WHERE trip_id = ?1 GROUP BY currency").bind(tripId).all()).results ?? [];
  return rows.map((r) => [r.currency, r.n]);
}

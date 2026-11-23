// A trip: making one, the trips an account is on, changing one's details, and its rev.
//
//   GET   /api/trips               -> { trips }        the trips the account is on now
//   POST  /api/trips               -> { trip, rev }    201; the maker is its host
//   PATCH /api/trips/<trip>        -> { trip, rev }    any member: name, dates, zone, currencies, interests
//   GET   /api/trips/<trip>/rev    -> { rev }          the cheap "did anything change"
//   GET   /api/trips/<trip>        -> the whole trip (src/api/trip.js)
//   DELETE /api/trips/<trip> { confirm: "<the trip's name>" } -> { ok, deleted, files }   host only
//
// A new trip starts with one packing list, "Leaving home" (its bags: Main bag, Day bag, On me).
// Its dates can't change so that an event would start outside them, nor be cleared while it
// has events: the refusal names the first and last day an event starts on.
//
// Any account can make a trip. Nobody is ever put on one by signing in: people join by a link
// (links.js). Its host deletes it, typing its name; everything it stores goes in one write,
// its files to the drain (delete.js, drain.js). Afterwards, asking for it answers exactly as a
// trip you aren't on: no tombstone.

import {
  TRIP_CURRENCIES_MAX, TRIP_NAME_MAX, TRIPS_HOSTED_MAX,
} from "../../public/js/shared/limits.js";
import { json, readJson } from "../api/json.js";
import { colourFor, err, nowSec, validId, validTz } from "../api/trip.js";
import { tripShape } from "./access.js";
import { FIRST_LIST } from "../api/packing/lists.js";
import { INTERESTS_MAX } from "../../public/js/shared/limits.js";
import { dayIn } from "../../public/js/shared/trip-rules.js";
import { moved, write } from "./rev.js";
import { hostOnly } from "./access.js";
import { tripDeleteSteps } from "./delete.js";
import { tripBytes } from "./storage.js";
import { guestRefused, isGuest, waysIn } from "../accounts/guests.js";

const COLS = `t.id, t.name, t.starts_on, t.ends_on, t.default_tz, t.currencies, t.collage_seed,
    t.collage_version, t.host_id, t.created_by, t.created_at, t.updated_at, t.rev, t.interests, t.tiles`;

// ── what a trip's fields may be ────────────────────────────────────────────────────────────

/** A trip's name as kept: trimmed, runs of spaces made one, no control characters. Else null. */
function cleanTripName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || [...name].length > TRIP_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** A calendar day that exists, as YYYY-MM-DD. */
function validDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

const DATES = "starts_on and ends_on are YYYY-MM-DD, both or neither (null when not known yet), and ends_on is not before starts_on";
const empty = (v) => v === null || v === undefined || v === "";

/** The dates as stored ('' is "not known yet"), or `bad`. */
function readDates(starts, ends) {
  if (empty(starts) && empty(ends)) return { starts_on: "", ends_on: "" };
  if (!validDay(starts) || !validDay(ends) || ends < starts) return { bad: err(400, "bad dates", { need: DATES, reason: "A trip's dates are its first and last day, YYYY-MM-DD, the last not before the first; leave both out while they're not known." }) };
  return { starts_on: starts, ends_on: ends };
}

/** What the group cares about, in their words (docs/guides/trip-setup.md): free text, trimmed. Else `bad`. */
function readInterests(value) {
  if (value === null || value === undefined) return { interests: "" };
  if (typeof value !== "string" || value.trim().length > INTERESTS_MAX) {
    return { bad: err(400, "bad interests", { need: `text of at most ${INTERESTS_MAX} characters: who's going, food, what they love and don't, pace, how they get around, money`, reason: `What the group cares about is text, at most ${INTERESTS_MAX} characters.` }) };
  }
  return { interests: value.trim() };
}

/**
 * Dates a trip may change to, given its events: each event starts on a day of the trip (in
 * its own zone), so new dates that would leave one outside are refused, and so is clearing the
 * dates while it has events. The refusal names the first and last day an event starts on.
 * Moving a whole trip by some days is a later feature, not this.
 */
async function datesHoldEvents(env, tripId, starts, ends) {
  const rows = await env.DB.prepare("SELECT starts_at, tz FROM events WHERE trip_id = ?1").bind(tripId).all();
  const days = (rows.results || []).map((e) => dayIn(e.starts_at, e.tz)).sort();
  if (!days.length) return null;
  const first = days[0], last = days[days.length - 1];
  if (!starts) {
    return err(409, "events outside", { reason: `The trip has events from ${first} to ${last}, so its dates can't be cleared.`, first_event_day: first, last_event_day: last });
  }
  if (first < starts || last > ends) {
    return err(409, "events outside", {
      reason: `The trip's events start on days from ${first} to ${last}; these dates would leave some outside. Choose dates that hold them, or move those events first.`,
      first_event_day: first, last_event_day: last,
    });
  }
  return null;
}

/** The trip's own currency list as stored (a JSON array of ISO codes, in the order given), or `bad`. */
function readCurrencies(value) {
  if (!Array.isArray(value) || value.length > TRIP_CURRENCIES_MAX)
    return { bad: err(400, "bad currencies", { need: `an array of at most ${TRIP_CURRENCIES_MAX} three-letter codes`, reason: `A trip's currencies are a list of at most ${TRIP_CURRENCIES_MAX} three-letter codes (PEN, USD, EUR), the main one first.` }) };
  const codes = [];
  for (const item of value) {
    const code = String(item ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code))
      return { bad: err(400, "bad currencies", { need: `an array of at most ${TRIP_CURRENCIES_MAX} three-letter codes`, got: item, reason: `"${String(item).slice(0, 20)}" isn't a currency's three-letter code (PEN, USD, EUR).` }) };
    if (!codes.includes(code)) codes.push(code);
  }
  return { currencies: JSON.stringify(codes) };
}

// ── GET /api/trips ─────────────────────────────────────────────────────────────────────────
// The trips the account is on now, the next to start first and the ones without dates last.
// `role` is the caller's; `members` counts the people on the trip now. `chat.from_others` is the
// order (seq) of the newest message someone else wrote there and didn't delete, 0 when none: the
// page compares it with where the caller's reading stopped on that phone to say "New messages". A
// message made from a note on a plan (migration 0027) never counts: everyone had read it as a note.
// Read from the top of (trip_id, seq), so it stops at the first message that isn't the caller's.
export async function listTrips({ env, data }) {
  const rows = await env.DB.prepare(
    `SELECT ${COLS},
       (SELECT COUNT(*) FROM trip_members x WHERE x.trip_id = t.id AND x.left_at IS NULL) AS members
       , (SELECT h.offered_at FROM trip_handovers h WHERE h.trip_id = t.id AND h.to_user = ?1) AS offered_at
       , (SELECT u.name FROM users u WHERE u.id = t.host_id) AS host_name
       , (SELECT g.seq FROM messages g WHERE g.trip_id = t.id AND g.author != ?1 AND g.deleted_at IS NULL
          AND g.from_note = 0 ORDER BY g.seq DESC LIMIT 1) AS others_seq
       , (SELECT json_object('url', '/media/' || c.r2_key, 'width', c.width, 'height', c.height) FROM pictures c
          WHERE c.trip_id = t.id AND c.target_kind = 'cover') AS cover_json
     FROM trip_members m JOIN trips t ON t.id = m.trip_id
     WHERE m.user_id = ?1 AND m.left_at IS NULL
     ORDER BY t.starts_on = '', t.starts_on, t.created_at, t.id`,
  ).bind(data.user.id).all();
  // `offered_to_me`: the host offers this trip to the caller (members.js), so the home screen
  // can show the offer without the trip being opened.
  return json({
    trips: (rows.results || []).map((t) => ({
      ...tripShape(t), role: t.host_id === data.user.id ? "host" : "member", members: t.members,
      host: { id: t.host_id, name: t.host_name },
      offered_to_me: t.offered_at ? { offered_at: t.offered_at } : null,
      chat: { from_others: t.others_seq ?? 0 },
      // The trip's cover picture, small, for its row (model §6): { url, width, height } or null.
      cover: t.cover_json ? JSON.parse(t.cover_json) : null,
    })),
  });
}

// ── POST /api/trips ────────────────────────────────────────────────────────────────────────
// { name, default_tz, starts_on?, ends_on?, currencies?, id? }
//
// `id` is for a client that makes the trip's id itself, so a create sent twice (the first
// answer lost on a bad connection) lands on the trip it already made. Without one the server
// makes it. Either way an id says nothing about the trip.
export async function createTrip({ request, env, data }) {
  const u = data.user;
  if (isGuest(u)) return guestRefused(env, `You're a guest. Add ${waysIn(env)} on your account page to make a trip of your own.`);
  const b = await readJson(request);

  const id = b.id === undefined ? crypto.randomUUID() : String(b.id);
  if (!validId(id)) return err(400, "bad id", { id });
  const name = cleanTripName(b.name);
  if (!name) return err(400, "bad name", { need: `1 to ${TRIP_NAME_MAX} characters` });
  if (!validTz(b.default_tz)) return err(400, "bad default_tz", { need: "an IANA time zone, like America/Lima", reason: `The trip's time zone is a name like America/Lima or Europe/Lisbon; "${String(b.default_tz ?? "").slice(0, 40)}" isn't one.` });
  const dates = readDates(b.starts_on, b.ends_on);
  if (dates.bad) return dates.bad;
  const money = b.currencies === undefined ? { currencies: "[]" } : readCurrencies(b.currencies);
  if (money.bad) return money.bad;
  const said = readInterests(b.interests);
  if (said.bad) return said.bad;

  const now = nowSec();
  const seed = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const colour = await colourFor(env, id, u.id);
  // The limit is inside the insert, so two creates sent at once can't both pass it. The
  // member row is written only for the trip this request made (its id, its host, its second).
  const [made] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO trips (id, name, starts_on, ends_on, default_tz, currencies, collage_seed, collage_version,
         host_id, created_by, created_at, updated_at, rev, interests)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8, ?9, ?9, 1, ?11
       WHERE (SELECT COUNT(*) FROM trips WHERE host_id = ?8) < ?10
       ON CONFLICT(id) DO NOTHING`,
    ).bind(id, name, dates.starts_on, dates.ends_on, b.default_tz, money.currencies, seed, u.id, now, TRIPS_HOSTED_MAX, said.interests),
    env.DB.prepare(
      `INSERT INTO trip_members (trip_id, user_id, joined_at, rev)
       SELECT ?1, ?2, ?3, 1 WHERE EXISTS (SELECT 1 FROM trips WHERE id = ?1 AND host_id = ?2 AND created_at = ?3)
       ON CONFLICT(trip_id, user_id) DO NOTHING`,
    ).bind(id, u.id, now),
    // The list a trip starts with, so the app never shows one with none (the guide sets more).
    env.DB.prepare(
      `INSERT INTO packing_lists (trip_id, key, name, sort, repeat, created_at, updated_at, rev)
       SELECT ?1, ?4, ?5, 0, 'once', ?3, ?3, 1 WHERE EXISTS (SELECT 1 FROM trips WHERE id = ?1 AND host_id = ?2 AND created_at = ?3)
       ON CONFLICT(trip_id, key) DO NOTHING`,
    ).bind(id, u.id, now, FIRST_LIST.key, FIRST_LIST.name),
    // The maker's colour on notes, if they have none yet: the roster is whole from the first
    // read, and that read writes nothing.
    ...(colour ? [env.DB.prepare(
      `UPDATE users SET note_color = ?3 WHERE id = ?2 AND note_color IS NULL
         AND EXISTS (SELECT 1 FROM trips WHERE id = ?1 AND host_id = ?2 AND created_at = ?4)`,
    ).bind(id, u.id, colour, now)] : []),
    ...FIRST_LIST.bags.map(([key, bag], i) => env.DB.prepare(
      `INSERT INTO packing_bags (trip_id, list_key, key, name, sort, rev)
       SELECT ?1, ?4, ?5, ?6, ?7, 1 WHERE EXISTS (SELECT 1 FROM trips WHERE id = ?1 AND host_id = ?2 AND created_at = ?3)
       ON CONFLICT(trip_id, list_key, key) DO NOTHING`,
    ).bind(id, u.id, now, FIRST_LIST.key, key, bag, i)),
  ]);

  if (!made.meta.changes) {
    const there = await env.DB.prepare(`SELECT ${COLS} FROM trips t WHERE t.id = ?1`).bind(id).first();
    // The same create again: answered with the trip it made. Anyone else's id is a collision.
    if (there) {
      return there.created_by === u.id && there.host_id === u.id
        ? json({ trip: tripShape(there), rev: there.rev })
        : err(409, "id already exists", { id });
    }
    return err(409, "too many trips", { max: TRIPS_HOSTED_MAX, reason: `an account can host ${TRIPS_HOSTED_MAX} trips at a time` });
  }

  const trip = await env.DB.prepare(`SELECT ${COLS} FROM trips t WHERE t.id = ?1`).bind(id).first();
  return json({ trip: tripShape(trip), rev: trip.rev }, 201);
}

// ── PATCH /api/trips/<trip> ────────────────────────────────────────────────────────────────
// Any member. A key that is absent is left alone. The dates are judged as they will be after
// the change (both or neither), so sending one of them changes that one.
export async function patchTrip({ request, env, data }) {
  const { trip } = data;
  const b = await readJson(request);
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const KEYS = ["name", "starts_on", "ends_on", "default_tz", "currencies", "interests"];
  if (!KEYS.some(has)) return err(400, "nothing to patch", { keys: KEYS, reason: `Nothing was sent to change. A trip's details are ${KEYS.join(", ")}.` });

  const set = {};
  if (has("name")) {
    const name = cleanTripName(b.name);
    if (!name) return err(400, "bad name", { need: `1 to ${TRIP_NAME_MAX} characters` });
    set.name = name;
  }
  if (has("default_tz")) {
    if (!validTz(b.default_tz)) return err(400, "bad default_tz", { need: "an IANA time zone, like America/Lima", reason: `The trip's time zone is a name like America/Lima or Europe/Lisbon; "${String(b.default_tz ?? "").slice(0, 40)}" isn't one.` });
    set.default_tz = b.default_tz;
  }
  if (has("starts_on") || has("ends_on")) {
    const dates = readDates(has("starts_on") ? b.starts_on : trip.starts_on, has("ends_on") ? b.ends_on : trip.ends_on);
    if (dates.bad) return dates.bad;
    const stranded = await datesHoldEvents(env, trip.id, dates.starts_on, dates.ends_on);
    if (stranded) return stranded;
    set.starts_on = dates.starts_on;
    set.ends_on = dates.ends_on;
  }
  if (has("interests")) {
    const said = readInterests(b.interests);
    if (said.bad) return said.bad;
    set.interests = said.interests;
  }
  if (has("currencies")) {
    const money = readCurrencies(b.currencies);
    if (money.bad) return money.bad;
    set.currencies = money.currencies;
  }

  const keys = Object.keys(set);
  const sets = keys.map((k, i) => `${k} = ?${i + 1}`).join(", ");
  const n = keys.length;
  // bump() has already taken the trip's rev up in this batch; this row is the trip itself, so
  // there is nothing to stamp.
  const { rev } = await write(env, trip.id, [
    env.DB.prepare(`UPDATE trips SET ${sets}, updated_at = ?${n + 1} WHERE id = ?${n + 2}`)
      .bind(...keys.map((k) => set[k]), nowSec(), trip.id),
  ]);
  const after = await env.DB.prepare(`SELECT ${COLS} FROM trips t WHERE t.id = ?1`).bind(trip.id).first();
  return json({ trip: tripShape(after), rev });
}

// ── GET /api/trips/<trip>/rev ──────────────────────────────────────────────────────────────
// The route table has already read the trip's row to check the caller is on it, and the rev
// is on that row: this answer costs the one query every trip route costs.
// rev moves on every write; data_rev on every write but the chat's; seq on the chat's (docs/API.md,
// "The rev"): a phone reads the whole trip when data_rev moved, the new messages when seq did.
export const tripRev = ({ data }) => json({ rev: data.trip.rev, data_rev: data.trip.data_rev, seq: data.trip.message_seq });

// ── DELETE /api/trips/<trip> ───────────────────────────────────────────────────────────────
// The host only, typing the trip's name (trimmed and in Unicode NFC, otherwise exactly as it
// is). Without it, or with something else, the answer is 400 "confirm" with what would go, so
// the dialog can tell the truth: the people on it, the photos and videos (how many, and how
// much space), the boards shared from it, the purchases, and whether anyone still owes money.
// With it: one write removes every row (src/trips/delete.js) and queues every file for the
// drain, so what the trip held stops counting at once.
const sameName = (a, b) => String(a ?? "").trim().normalize("NFC") === String(b ?? "").trim().normalize("NFC");

async function whatGoes(env, trip, now) {
  const [counts, owing] = await Promise.all([
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM trip_members WHERE trip_id = ?1 AND left_at IS NULL) AS members,
         (SELECT COUNT(*) FROM media_objects WHERE trip_id = ?1 AND state = 'stored' AND role = 'original' AND kind = 'photo') AS photos,
         (SELECT COUNT(*) FROM media_objects WHERE trip_id = ?1 AND state = 'stored' AND role = 'original' AND kind = 'video') AS videos,
         (SELECT COUNT(*) FROM collage_shares WHERE trip_id = ?1 AND revoked_at IS NULL) AS boards,
         (SELECT COUNT(*) FROM purchases WHERE trip_id = ?1 AND kind = 'purchase') AS purchases,
         (SELECT COUNT(*) FROM purchases WHERE trip_id = ?1 AND kind = 'payment') AS payments,
         (SELECT COUNT(*) FROM pictures WHERE trip_id = ?1 AND role = 'picture') AS pictures,
         (SELECT COUNT(*) FROM pictures WHERE trip_id = ?1 AND role = 'receipt') AS receipts,
         (SELECT COALESCE(SUM(bytes), 0) FROM media_objects WHERE trip_id = ?1 AND state = 'stored' AND role = 'map') AS map_bytes`,
    ).bind(trip.id).first(),
    // Someone owes money when, in some currency, what they paid isn't what their shares came to.
    env.DB.prepare(
      `SELECT 1 AS yes FROM (
         SELECT currency, paid_by AS user_id, amount_minor AS amount FROM purchases WHERE trip_id = ?1
         UNION ALL SELECT p.currency, s.user_id, -s.share_minor FROM purchase_shares s JOIN purchases p ON p.id = s.purchase_id WHERE p.trip_id = ?1
       ) GROUP BY currency, user_id HAVING SUM(amount) != 0 LIMIT 1`,
    ).bind(trip.id).first(),
  ]);
  return {
    members: counts.members, photos: counts.photos, videos: counts.videos, pictures: counts.pictures, receipts: counts.receipts,
    bytes: await tripBytes(env, trip.id, now),
    boards: counts.boards, purchases: counts.purchases, payments: counts.payments, someone_owes: !!owing,
    // A map the host uploaded, counted in `bytes` with the rest (0 when the map is the server's cut).
    map_bytes: Number(counts.map_bytes) || 0,
  };
}

export async function deleteTrip({ request, env, data }) {
  const { trip, host } = data;
  if (!host) return hostOnly();
  const now = nowSec();
  const b = await readJson(request);
  if (!sameName(b.confirm, trip.name)) {
    return err(400, "confirm", {
      need: trip.name,
      reason: `Type the trip's name, "${trip.name}", to delete it. Everything it holds goes, for everyone on it, and can't be brought back.`,
      goes: await whatGoes(env, trip, now),
    });
  }
  const steps = tripDeleteSteps(env, trip.id, now);
  const done = await env.DB.batch(steps.map((s) => s.stmt));
  await moved(env, trip.id, null, { gone: true });
  const files = steps.reduce((n, step, i) => n + (step.stmt.queues ? done[i].meta.changes : 0), 0);
  return json({ ok: true, deleted: true, files });
}

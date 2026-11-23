// Under /api/trips/<trip>/ (the route table checks the caller is on the trip: src/trips/access.js):
// GET    events      -> { events }              every event of the trip, by start
// POST   events      -> { event, rev }          201; created_by is the session user, always
// PATCH  events/:id  -> { event, rev }          any member
// DELETE events/:id  -> { ok, deleted, rev }    any member
// PUT    events      { events: [...] } -> { events, rev }        adds each, or changes the one with
//                    that id (only the fields sent), in ONE write; a refused row refuses them all,
//                    named by its place in the list (the MCP's put_events; model §16)
// DELETE events      { ids: [...] }   -> { ok, deleted, rev }   removes each, with its picture, in
//                    one write (the MCP's remove_events); the chat's messages about it stay, with its name
// The two batches read what they check once, not per row: a request stays within the 50 D1
// queries a free account allows (check:queries).
//
// Any member changes or removes any event (model §4: the author rule is gone; rows an import
// brought in are no longer locked). An event is looked up by its id AND its trip, always.
//
// What holds (model §6, §16; docs/guides/itinerary.md):
//   * a new event's id, when the writer chooses it: lowercase letters, digits, hyphens
//     (public/js/shared/trip-rules.js). Events from before keep theirs;
//   * it starts on a day of the trip, in its own zone: one outside the dates is refused with
//     them, which catches a wrong year. A trip without dates takes no events. The same rule
//     from the trip's side is in src/trips/trips.js (dates that would leave an event outside);
//   * one of the six kinds; a place of this trip; an end that isn't before the start.
//   * `source` says where a row came from when it wasn't typed in the app (an import, an AI's
//     change). The app leaves it empty.

import { json, readJson } from "./json.js";
import { REV, write } from "../trips/rev.js";
import { goneSteps } from "../trips/pictures.js";
import { err, nowSec, str, validEpoch, validTz } from "./trip.js";
import { dayIn, onTripDay, readNewId } from "../../public/js/shared/trip-rules.js";
import { EVENTS_MAX, ROWS_PER_WRITE_MAX } from "../../public/js/shared/limits.js";

// end_tz is in this list because leaving it out IS the miss-your-plane bug: a flight that
// lands in another zone renders its arrival in the DEPARTURE zone. Every renderer does
// fmtTime(ends_at, end_tz || tz), so a missing column here is the only way the value can fail
// to arrive.
const COLS =
  "id, trip_id, starts_at, ends_at, tz, end_tz, all_day, title, kind, place_id, detail, url, " +
  "source, created_by, created_at, updated_at, rev";

const KINDS = ["flight", "meal", "lodging", "activity", "transit", "plan"];

// Integer flags come back as the 0/1 the column holds. No boolean translation layer, so
// there is nothing to get backwards between here, IndexedDB, and the agenda.
const shape = (r) => ({
  id: r.id, trip_id: r.trip_id, starts_at: r.starts_at, ends_at: r.ends_at, tz: r.tz,
  end_tz: r.end_tz ?? null,
  all_day: r.all_day, title: r.title, kind: r.kind, place_id: r.place_id, detail: r.detail,
  url: r.url, source: r.source ?? "",
  created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at, rev: r.rev,
});

async function getEvent(env, tripId, id) {
  return await env.DB.prepare(`SELECT ${COLS} FROM events WHERE trip_id = ?2 AND id = ?1`).bind(id, tripId).first();
}

// Shared by POST and PATCH. Returns { fields } or { bad } — a Response ready to return.
async function readFields(ctx, body, { partial, placeIds = null }) {
  const f = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has("title")) {
    const title = str(body.title, 200);
    if (!title) return { bad: err(400, "title required", { reason: "An event needs a title." }) };
    f.title = title;
  }
  if (!partial || has("starts_at")) {
    if (!validEpoch(body.starts_at))
      return { bad: err(400, "starts_at must be epoch seconds", { got: body.starts_at, reason: "An event needs its start: a day, or a day and time, in its time zone." }) };
    f.starts_at = body.starts_at;
  }
  if (!partial || has("tz")) {
    if (!validTz(body.tz)) return { bad: err(400, "tz must be an IANA zone", { got: body.tz, reason: `An event's time zone is a name like America/Lima or Europe/Lisbon; "${String(body.tz ?? "").slice(0, 40)}" isn't one.` }) };
    f.tz = body.tz;
  }
  // NULL means "ends in the zone it started in", which is everything that does not fly.
  // Never required, but when present it has to be a real zone for the same reason tz does:
  // Intl throws on a bad one, on every phone, once per render.
  if (has("end_tz")) {
    if (body.end_tz === null || body.end_tz === "") f.end_tz = null;
    else if (!validTz(body.end_tz)) return { bad: err(400, "end_tz must be an IANA zone", { got: body.end_tz, reason: `The zone an event ends in is a name like America/Lima or Europe/Lisbon; "${String(body.end_tz).slice(0, 40)}" isn't one.` }) };
    else f.end_tz = body.end_tz;
  } else if (!partial) {
    f.end_tz = null;
  }
  if (has("ends_at")) {
    if (body.ends_at === null) f.ends_at = null;
    else if (!validEpoch(body.ends_at)) return { bad: err(400, "ends_at must be epoch seconds or null", { reason: "An event's end is a day, or a day and time, or nothing." }) };
    else f.ends_at = body.ends_at;
  } else if (!partial) {
    f.ends_at = null;
  }
  if (!partial || has("all_day")) f.all_day = body.all_day ? 1 : 0;
  if (!partial || has("kind")) {
    const kind = str(body.kind, 20) || "plan";
    if (!KINDS.includes(kind)) return { bad: err(400, "unknown kind", { kinds: KINDS, reason: `An event's kind is one of: ${KINDS.join(", ")}.` }) };
    f.kind = kind;
  }
  if (!partial || has("detail")) f.detail = str(body.detail, 4000);
  if (!partial || has("url")) {
    const url = str(body.url, 500);
    if (url && !/^https?:\/\//i.test(url)) return { bad: err(400, "url must be http(s)", { reason: "An event's link is a web address starting with http:// or https://." }) };
    f.url = url;
  }
  if (!partial || has("place_id")) {
    const pid = body.place_id ? String(body.place_id) : null;
    if (pid) {
      // (trip, place) is a foreign key. Without this check D1 raises a constraint error the
      // caller cannot act on; with it the client gets the id it got wrong.
      // A batch reads the trip's places once and passes them in (putEvents).
      const hit = placeIds ? placeIds.has(pid) : await ctx.env.DB.prepare("SELECT 1 AS ok FROM places WHERE trip_id = ?2 AND id = ?1")
        .bind(pid, ctx.data.trip.id).first();
      if (!hit) return { bad: err(400, "unknown place_id", { place_id: pid, reason: `No place on this trip has the id "${pid.slice(0, 64)}".` }) };
    }
    f.place_id = pid;
  }
  if (has("source")) f.source = str(body.source, 200);
  else if (!partial) f.source = "";
  return { fields: f };
}

/**
 * The rule that an event starts on a day of the trip, in its own zone. Answers null, or the
 * refusal to send.
 */
const ENDS_FIRST = "This event ends before it starts.";

function startsOnTripDay(trip, starts, tz) {
  const day = dayIn(starts, tz);
  const on = onTripDay(day, trip, `This event starts in ${tz}`);
  return on.ok ? null : err(400, "not a day of the trip", {
    reason: on.error, day, starts_on: trip.starts_on || null, ends_on: trip.ends_on || null,
  });
}

// Exported so GET /api/trip can build the single snapshot store.js hydrates from without a
// second copy of this SELECT. Two copies of a column list is exactly how end_tz went missing.
// since (a rev) answers only the rows written after it, and those named in also (ids, as for a picture changed):
// GET /api/trips/<id>?since= (src/api/trip.js, migration 0036's indexes).
export async function listEvents(env, tripId, { since = null, also = [] } = {}) {
  const rows = since === null
    ? await env.DB.prepare(`SELECT ${COLS} FROM events WHERE trip_id = ?1 ORDER BY starts_at, id`).bind(tripId).all()
    // The ids that changed off the (trip, rev) index, then each row by its key: never the whole table.
    : await env.DB.prepare(`SELECT ${COLS.split(",").map((c) => `e.${c.trim()}`).join(", ")} FROM (SELECT id FROM events WHERE trip_id = ?1 AND rev > ?2
        UNION SELECT value FROM json_each(?3)) AS w CROSS JOIN events e ON e.trip_id = ?1 AND e.id = w.id
        ORDER BY e.starts_at, e.id`).bind(tripId, since, JSON.stringify(also)).all();
  return (rows.results || []).map(shape);
}

export async function onRequestGet(ctx) {
  return json({ events: await listEvents(ctx.env, ctx.data.trip.id) });
}

export async function onRequestPost(ctx) {
  const { user: u, trip } = ctx.data;

  const body = await readJson(ctx.request);

  // The client may name the row. That is what makes a queued offline write safe to replay:
  // four days without signal means the flush happens over a cell tower that drops the
  // response half the time, and a POST that generates its own id server-side would create a
  // duplicate event on every retry. With a client id the insert is idempotent — a replay
  // that finds its own row already there gets that row back, not a second one.
  const id = body.id === undefined ? crypto.randomUUID() : body.id;
  // A create sent again (the answer lost on a bad connection) finds its row: hand it back,
  // unchanged. An id is unique within the trip, so the row it finds is this trip's.
  const there = typeof id === "string" ? await getEvent(ctx.env, trip.id, id) : null;
  if (there) return json({ event: shape(there), rev: trip.rev });
  const okId = readNewId(id);
  if (!okId.ok) return err(400, "bad id", { id, reason: okId.error });

  const r = await readFields(ctx, body, { partial: false });
  if (r.bad) return r.bad;
  const f = r.fields;
  if (f.ends_at != null && f.ends_at < f.starts_at) return err(400, "ends_at is before starts_at", { reason: ENDS_FIRST });
  const outside = startsOnTripDay(trip, f.starts_at, f.tz);
  if (outside) return outside;
  // A ceiling against a loop: every member's phone holds every event.
  const held = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE trip_id = ?1").bind(trip.id).first();
  if (held.n >= EVENTS_MAX) return err(409, "too many events", { max: EVENTS_MAX, reason: `A trip holds at most ${EVENTS_MAX} events.` });
  const ts = nowSec();

  const { rev, results: [ins] } = await write(ctx.env, trip.id, [ctx.env.DB.prepare(
    "INSERT INTO events (id, trip_id, starts_at, ends_at, tz, end_tz, all_day, title, kind, " +
    "place_id, detail, url, source, created_by, created_at, updated_at, rev) " +
    `VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, ${REV(2)}) ` +
    "ON CONFLICT(trip_id, id) DO NOTHING"
  ).bind(id, trip.id, f.starts_at, f.ends_at, f.tz, f.end_tz, f.all_day, f.title, f.kind,
    f.place_id, f.detail, f.url, f.source, u.id, ts)]);

  const row = await getEvent(ctx.env, trip.id, id);
  // Made by a create that arrived a moment before this one: the same answer as a replay.
  if (!ins.meta.changes) return json({ event: shape(row), rev });
  return json({ event: shape(row), rev }, 201);
}

export async function patchEvent(ctx) {
  const { trip } = ctx.data;
  const id = String(ctx.params.id || "");
  const row = await getEvent(ctx.env, trip.id, id);
  if (!row) return err(404, "no such event", { id, reason: `There's no event "${id.slice(0, 64)}" on this trip.` });

  const body = await readJson(ctx.request);
  const r = await readFields(ctx, body, { partial: true });
  if (r.bad) return r.bad;
  const f = r.fields;

  const starts = f.starts_at ?? row.starts_at;
  const ends = "ends_at" in f ? f.ends_at : row.ends_at;
  if (ends != null && ends < starts) return err(400, "ends_at is before starts_at", { reason: ENDS_FIRST });
  if ("starts_at" in f || "tz" in f) {
    const outside = startsOnTripDay(trip, starts, f.tz ?? row.tz);
    if (outside) return outside;
  }

  const keys = Object.keys(f);
  if (!keys.length) return json({ event: shape(row), rev: trip.rev });

  const sets = keys.map((k, i) => `${k} = ?${i + 1}`).join(", ");
  const n = keys.length;
  const { rev } = await write(ctx.env, trip.id, [ctx.env.DB.prepare(
    `UPDATE events SET ${sets}, updated_at = ?${n + 1}, rev = ${REV(n + 3)} ` +
    `WHERE id = ?${n + 2} AND trip_id = ?${n + 3}`
  ).bind(...keys.map((k) => f[k]), nowSec(), id, trip.id)]);

  return json({ event: shape(await getEvent(ctx.env, trip.id, id)), rev });
}

export async function deleteEvent(ctx) {
  const { trip } = ctx.data;
  const id = String(ctx.params.id || "");
  const row = await getEvent(ctx.env, trip.id, id);

  // Already gone reads as success. A delete that was queued offline can reach the server
  // twice; answering 404 on the second one would leave a permanent failure stuck at the
  // head of store.js's flush queue with nothing behind it able to drain.
  if (!row) return json({ ok: true, deleted: false, rev: trip.rev });

  // A purchase that pointed at it floats, keeping its money (migration 0019 says why this isn't
  // the foreign key's job). The chat's messages about it stay, saying its name (migration 0027:
  // its notes are among them).
  const { rev } = await write(ctx.env, trip.id, [
    ctx.env.DB.prepare(`UPDATE purchases SET event_id = NULL, rev = ${REV(2)} WHERE trip_id = ?2 AND event_id = ?1`).bind(id, trip.id),
    // Its picture goes with it (the file to the drain).
    ...goneSteps(ctx.env, trip.id, "event", JSON.stringify([id]), nowSec()),
    ctx.env.DB.prepare("DELETE FROM events WHERE id = ?1 AND trip_id = ?2").bind(id, trip.id),
  ]);
  return json({ ok: true, deleted: true, rev });
}

// ── PUT events: a batch ────────────────────────────────────────────────────────────────────

/** A route's refusal as one row of a batch's: its own words, with where it was in the list. */
async function rowOf(response, index, id) {
  const body = await response.json().catch(() => ({}));
  return { index, id: id ?? null, ...body };
}

export async function putEvents(ctx) {
  const { user: u, trip } = ctx.data;
  const b = await readJson(ctx.request);
  if (!Array.isArray(b.events) || !b.events.length) return err(400, "bad events", { need: "events: a list of at least one event" });
  if (b.events.length > ROWS_PER_WRITE_MAX) return err(400, "too many rows", { max: ROWS_PER_WRITE_MAX, reason: `A write is at most ${ROWS_PER_WRITE_MAX} rows: send the rest in another.` });
  const [had, places] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(`SELECT ${COLS} FROM events WHERE trip_id = ?1`).bind(trip.id),
    ctx.env.DB.prepare("SELECT id FROM places WHERE trip_id = ?1").bind(trip.id),
  ]);
  const existing = new Map((had.results || []).map((r) => [r.id, r]));
  const placeIds = new Set((places.results || []).map((r) => r.id));
  const rows = [];
  const steps = [];
  const seen = new Set();
  const ts = nowSec();
  let added = 0;
  for (const [index, raw] of b.events.entries()) {
    const body = raw && typeof raw === "object" ? raw : {};
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) { rows.push({ index, id: null, error: "id required", reason: "Every event in a batch has its id: lowercase letters, digits and hyphens, chosen by the writer." }); continue; }
    if (seen.has(id)) { rows.push({ index, id, error: "named twice", reason: "This event is in the list twice; send it once." }); continue; }
    seen.add(id);
    const row = existing.get(id);
    if (!row) {
      const okId = readNewId(id);
      if (!okId.ok) { rows.push({ index, id, error: "bad id", reason: okId.error }); continue; }
    }
    const r = await readFields(ctx, body, { partial: Boolean(row), placeIds });
    if (r.bad) { rows.push(await rowOf(r.bad, index, id)); continue; }
    const f = r.fields;
    const starts = f.starts_at ?? row?.starts_at;
    const ends = "ends_at" in f ? f.ends_at : row?.ends_at ?? null;
    if (ends != null && ends < starts) { rows.push({ index, id, error: "ends_at is before starts_at", reason: ENDS_FIRST }); continue; }
    if (!row || "starts_at" in f || "tz" in f) {
      const outside = startsOnTripDay(trip, starts, f.tz ?? row?.tz);
      if (outside) { rows.push(await rowOf(outside, index, id)); continue; }
    }
    if (row) {
      const keys = Object.keys(f);
      if (!keys.length) continue;
      const n = keys.length;
      steps.push(ctx.env.DB.prepare(`UPDATE events SET ${keys.map((k, i) => `${k} = ?${i + 1}`).join(", ")}, updated_at = ?${n + 1}, rev = ${REV(n + 3)} WHERE id = ?${n + 2} AND trip_id = ?${n + 3}`)
        .bind(...keys.map((k) => f[k]), ts, id, trip.id));
    } else {
      added += 1;
      steps.push(ctx.env.DB.prepare(
        "INSERT INTO events (id, trip_id, starts_at, ends_at, tz, end_tz, all_day, title, kind, place_id, detail, url, source, created_by, created_at, updated_at, rev) " +
        `VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, ${REV(2)})`,
      ).bind(id, trip.id, f.starts_at, f.ends_at, f.tz, f.end_tz, f.all_day, f.title, f.kind, f.place_id, f.detail, f.url, f.source, u.id, ts));
    }
  }
  if (rows.length) return err(400, "bad events", { rows, reason: "Nothing was written: the rows named here were refused." });
  if (existing.size + added > EVENTS_MAX) return err(409, "too many events", { max: EVENTS_MAX, reason: `A trip holds at most ${EVENTS_MAX} events.` });
  const ids = JSON.stringify([...seen]);
  let rev = trip.rev;
  if (steps.length) {
    try {
      ({ rev } = await write(ctx.env, trip.id, steps));
    } catch (e) {
      // An event or a place written at the same moment (a unique id, a place removed).
      if (/UNIQUE|FOREIGN KEY/i.test(String(e?.message || e))) return err(409, "changed meanwhile", { reason: "Someone changed these events or their places a moment ago. Read them again, then send the batch." });
      throw e;
    }
  }
  const back = await ctx.env.DB.prepare(`SELECT ${COLS} FROM events WHERE trip_id = ?1 AND id IN (SELECT value FROM json_each(?2))`).bind(trip.id, ids).all();
  const byId = new Map((back.results || []).map((r) => [r.id, shape(r)]));
  return json({ events: [...seen].map((id) => byId.get(id)).filter(Boolean), rev });
}

// ── DELETE events: a batch ─────────────────────────────────────────────────────────────────

export async function deleteEvents(ctx) {
  const { trip } = ctx.data;
  const b = await readJson(ctx.request);
  if (!Array.isArray(b.ids) || !b.ids.length || !b.ids.every((x) => typeof x === "string")) return err(400, "bad ids", { need: "ids: a list of event ids" });
  if (b.ids.length > ROWS_PER_WRITE_MAX) return err(400, "too many rows", { max: ROWS_PER_WRITE_MAX, reason: `A write is at most ${ROWS_PER_WRITE_MAX} rows: send the rest in another.` });
  const ids = JSON.stringify([...new Set(b.ids)]);
  const there = (await ctx.env.DB.prepare("SELECT id FROM events WHERE trip_id = ?1 AND id IN (SELECT value FROM json_each(?2))").bind(trip.id, ids).all()).results || [];
  // Already gone reads as success (a replayed delete): only what is there is removed.
  if (!there.length) return json({ ok: true, deleted: 0, rev: trip.rev });
  const gone = JSON.stringify(there.map((r) => r.id));
  const { rev } = await write(ctx.env, trip.id, [
    ctx.env.DB.prepare(`UPDATE purchases SET event_id = NULL, rev = ${REV(1)} WHERE trip_id = ?1 AND event_id IN (SELECT value FROM json_each(?2))`).bind(trip.id, gone),
    ...goneSteps(ctx.env, trip.id, "event", gone, nowSec()),
    ctx.env.DB.prepare("DELETE FROM events WHERE trip_id = ?1 AND id IN (SELECT value FROM json_each(?2))").bind(trip.id, gone),
  ]);
  return json({ ok: true, deleted: there.length, rev });
}

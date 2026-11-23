// A trip's reference list (migration 0048): short notes the whole group needs at hand that belong to no day and no
// place (money and ATMs, emergency numbers, the embassy, a door code). Shown by js/references.js; sent with the trip's
// snapshot (src/api/trip.js, its key "references"); an AI reads and writes it through the MCP (get_trip,
// set_references), each write recorded with its undo (src/trips/changes.js).
//
// Under /api/trips/<trip>/ (the route table checks the caller is on the trip). Any member, as with plans:
//   GET    references                         -> { references }              the whole list, in its order
//   POST   references  { id, title, body?, position? }  -> { reference, rev }  adds one (a create sent again
//                                                                            answers the row it made)
//   PATCH  references/<id>  { title?, body?, position? } -> { reference, rev }  changes what's sent
//   DELETE references/<id>                    -> { ok, deleted, rev }        already gone reads as success
//   PUT    references  { references: [...] }  -> { references, rev }         adds each, or changes the one with that
//                                                                            id (only what's sent); all or nothing
//   DELETE references  { ids: [...] }         -> { ok, deleted, rev }
// What holds: a title (REFERENCE_TITLE_MAX characters), a text ('' allowed, REFERENCE_TEXT_MAX), a position a finite
// number; at most REFERENCES_MAX items a trip. Refused in words, each row of a PUT named with what was wrong.

import { json, readJson } from "./json.js";
import { err, nowSec } from "./trip.js";
import { REV, write } from "../trips/rev.js";
import { REFERENCE_TEXT_MAX, REFERENCE_TITLE_MAX, REFERENCES_MAX, ROWS_PER_WRITE_MAX } from "../../public/js/shared/limits.js";
import { readNewId } from "../../public/js/shared/trip-rules.js";

const COLS = "id, trip_id, title, body, position, created_by, created_at, updated_at, rev";
const ORDER = "ORDER BY position, created_at, id";

/** The list, in its order; since (a rev): only the items written after it (src/api/trip.js, a phone's delta). */
export async function listReferences(env, tripId, { since = null } = {}) {
  const rows = since === null
    ? await env.DB.prepare(`SELECT ${COLS} FROM trip_references WHERE trip_id = ?1 ${ORDER}`).bind(tripId).all()
    : await env.DB.prepare(`SELECT ${COLS} FROM trip_references WHERE trip_id = ?1 AND rev > ?2 ${ORDER}`).bind(tripId, since).all();
  return rows.results || [];
}

const getOne = (env, tripId, id) => env.DB.prepare(`SELECT ${COLS} FROM trip_references WHERE trip_id = ?1 AND id = ?2`).bind(tripId, id).first();

/** One item's fields, merged onto what it was (`before`, or none for a new one): { fields } or { error } in words. */
function readFields(raw, before) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "An item is an object: { id, title, body }." };
  const has = (k) => Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== undefined;
  const f = {};
  if (!before || has("title")) {
    const t = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!t) return { error: `An item needs a title: a few words saying what it is ("Emergency numbers"), at most ${REFERENCE_TITLE_MAX} characters.` };
    if ([...t].length > REFERENCE_TITLE_MAX) return { error: `A title is at most ${REFERENCE_TITLE_MAX} characters.` };
    f.title = t;
  }
  if (has("body") || !before) {
    if (raw.body !== undefined && raw.body !== null && typeof raw.body !== "string") return { error: "body is the item's text: a string, line breaks kept." };
    const b = String(raw.body ?? "").replace(/\r\n?/g, "\n").trim();
    if ([...b].length > REFERENCE_TEXT_MAX) return { error: `An item's text is at most ${REFERENCE_TEXT_MAX} characters.` };
    f.body = b;
  }
  if (has("position")) {
    if (typeof raw.position !== "number" || !Number.isFinite(raw.position)) return { error: "position is a number: the list is in its order, low first." };
    f.position = raw.position;
  }
  return { fields: f };
}

export async function onRequestGet(ctx) {
  return json({ references: await listReferences(ctx.env, ctx.data.trip.id) });
}

/** The end of the list: one past the highest position. */
const nextPosition = async (env, tripId) =>
  ((await env.DB.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM trip_references WHERE trip_id = ?1").bind(tripId).first())?.p ?? 0) + 1;

export async function postReference(ctx) {
  const { trip, user } = ctx.data;
  const body = await readJson(ctx.request);
  const id = body.id === undefined ? `rf-${crypto.randomUUID()}` : body.id;
  // A create sent again (its answer lost on a bad connection) finds its row: hand it back, unchanged.
  const there = typeof id === "string" ? await getOne(ctx.env, trip.id, id) : null;
  if (there) return json({ reference: there, rev: trip.rev });
  const okId = readNewId(id);
  if (!okId.ok) return err(400, "bad id", { id, reason: okId.error });
  const r = readFields(body, null);
  if (r.error) return err(400, "bad reference", { reason: r.error });
  const held = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM trip_references WHERE trip_id = ?1").bind(trip.id).first();
  if (held.n >= REFERENCES_MAX) return err(409, "too many references", { max: REFERENCES_MAX, reason: `A trip's reference list holds at most ${REFERENCES_MAX} items: change or remove one first.` });
  const f = r.fields;
  const position = f.position ?? await nextPosition(ctx.env, trip.id);
  const ts = nowSec();
  const { rev, results: [ins] } = await write(ctx.env, trip.id, [ctx.env.DB.prepare(
    `INSERT INTO trip_references (trip_id, id, title, body, position, created_by, created_at, updated_at, rev)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ${REV(1)}) ON CONFLICT(trip_id, id) DO NOTHING`,
  ).bind(trip.id, id, f.title, f.body, position, user.id, ts)]);
  const row = await getOne(ctx.env, trip.id, id);
  return json({ reference: row, rev }, ins.meta.changes ? 201 : 200);
}

export async function patchReference(ctx) {
  const { trip } = ctx.data;
  const id = String(ctx.params.id || "");
  const row = await getOne(ctx.env, trip.id, id);
  if (!row) return err(404, "no such reference", { id, reason: `There's no item "${id.slice(0, 64)}" on this trip's reference list.` });
  const r = readFields(await readJson(ctx.request), row);
  if (r.error) return err(400, "bad reference", { reason: r.error });
  const keys = Object.keys(r.fields);
  if (!keys.length) return json({ reference: row, rev: trip.rev });
  const n = keys.length;
  const { rev } = await write(ctx.env, trip.id, [ctx.env.DB.prepare(
    `UPDATE trip_references SET ${keys.map((k, i) => `${k} = ?${i + 1}`).join(", ")}, updated_at = ?${n + 1}, rev = ${REV(n + 3)}
     WHERE id = ?${n + 2} AND trip_id = ?${n + 3}`,
  ).bind(...keys.map((k) => r.fields[k]), nowSec(), id, trip.id)]);
  return json({ reference: await getOne(ctx.env, trip.id, id), rev });
}

export async function deleteReference(ctx) {
  const { trip } = ctx.data;
  const id = String(ctx.params.id || "");
  const row = await getOne(ctx.env, trip.id, id);
  // Already gone reads as success: a removal queued offline can arrive twice.
  if (!row) return json({ ok: true, deleted: false, rev: trip.rev });
  const { rev } = await write(ctx.env, trip.id, [ctx.env.DB.prepare("DELETE FROM trip_references WHERE trip_id = ?1 AND id = ?2").bind(trip.id, id)]);
  return json({ ok: true, deleted: true, rev });
}

/** PUT references: adds each, or changes the one with that id (only what's sent). All or nothing. */
export async function putReferences(ctx) {
  const { trip, user } = ctx.data;
  const b = await readJson(ctx.request);
  if (!Array.isArray(b.references) || !b.references.length) return err(400, "bad references", { need: "references: a list of at least one item", reason: "Send references: a list of at least one item, each { id, title, body }." });
  if (b.references.length > ROWS_PER_WRITE_MAX) return err(400, "too many rows", { max: ROWS_PER_WRITE_MAX, reason: `A write is at most ${ROWS_PER_WRITE_MAX} rows: send the rest in another.` });
  const have = await listReferences(ctx.env, trip.id);
  const byId = new Map(have.map((r) => [r.id, r]));
  const rows = [];
  const changed = new Map();
  let next = Math.max(0, ...have.map((r) => Number(r.position) || 0)) + 1;
  b.references.forEach((raw, index) => {
    const id = typeof raw?.id === "string" ? raw.id : null;
    if (id === null) { rows.push({ index, id, error: "Each item needs its id: a new one of your own (\"rf-emergency\"), or the id of the one it changes." }); return; }
    if (changed.has(id)) { rows.push({ index, id, error: "This id is in the list twice. Send each item once." }); return; }
    const before = byId.get(id);
    if (!before) { const okId = readNewId(id); if (!okId.ok) { rows.push({ index, id, error: okId.error }); return; } }
    const r = readFields(raw, before ?? null);
    if (r.error) { rows.push({ index, id, error: r.error }); return; }
    const f = { ...(before ?? {}), ...r.fields };
    if (!before && f.position === undefined) f.position = next++;
    changed.set(id, { isNew: !before, f });
  });
  if (rows.length) return err(400, "bad references", { rows });
  const total = have.length + [...changed.values()].filter((c) => c.isNew).length;
  if (total > REFERENCES_MAX) return err(409, "too many references", { max: REFERENCES_MAX, reason: `A trip's reference list holds at most ${REFERENCES_MAX} items; this would make ${total}.` });
  const ts = nowSec();
  const sql = `INSERT INTO trip_references (trip_id, id, title, body, position, created_by, created_at, updated_at, rev)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ${REV(1)})
    ON CONFLICT(trip_id, id) DO UPDATE SET title = excluded.title, body = excluded.body, position = excluded.position,
      updated_at = excluded.updated_at, rev = excluded.rev`;
  const { rev } = await write(ctx.env, trip.id, [...changed.entries()].map(([id, { f }]) =>
    ctx.env.DB.prepare(sql).bind(trip.id, id, f.title, f.body ?? "", f.position ?? 0, user.id, ts)));
  const written = await ctx.env.DB.prepare(`SELECT ${COLS} FROM trip_references WHERE trip_id = ?1 AND id IN (SELECT value FROM json_each(?2)) ${ORDER}`)
    .bind(trip.id, JSON.stringify([...changed.keys()])).all();
  return json({ references: written.results || [], rev });
}

/** DELETE references { ids }: removes each that is there; one that isn't is passed over. */
export async function deleteReferences(ctx) {
  const { trip } = ctx.data;
  const b = await readJson(ctx.request);
  if (!Array.isArray(b.ids) || !b.ids.length || !b.ids.every((x) => typeof x === "string")) return err(400, "bad ids", { reason: "ids: the ids of the items to remove." });
  if (b.ids.length > ROWS_PER_WRITE_MAX) return err(400, "too many rows", { max: ROWS_PER_WRITE_MAX, reason: `A write is at most ${ROWS_PER_WRITE_MAX} rows.` });
  const { rev, results: [del] } = await write(ctx.env, trip.id, [ctx.env.DB.prepare(
    "DELETE FROM trip_references WHERE trip_id = ?1 AND id IN (SELECT value FROM json_each(?2)) RETURNING id",
  ).bind(trip.id, JSON.stringify(b.ids))]);
  // Counted by the rows it returns: the database's own count takes in what the delete's triggers wrote too.
  return json({ ok: true, deleted: (del.results ?? []).length, rev });
}

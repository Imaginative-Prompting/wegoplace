// Packing: what each person (and the group) brings, seen through the trip's lists.
//
// Under /api/trips/<trip>/ (the route table checks the caller is on the trip):
//   GET    packing[?owner=<id|group>] -> { items, lists, placements, ticks, starters }
//   POST   packing                    -> { item, rev }      201
//   PATCH  packing/<id>               -> { item, rev }      (or PATCH packing with the id in the body)
//   DELETE packing/<id>               -> { ok, deleted, rev } (or ?id=, or the id in the body)
//   PUT    packing/ticks  { item_id, list_key, day?, ticked } -> { tick, rev }
//   PUT    packing/items  { items: [...] } -> { items, rev }   a batch of adds and changes, one write
// The trip's lists and bags are ./packing/lists.js; its suggested items ./packing/starters.js.
//
// THE MODEL (model §5, §17; docs/guides/packing.md):
//   * The trip defines its lists, each packed once or for the day, and each list's bags.
//   * An item is the thing itself, and belongs to a person or to the group ('group'). It has
//     at most one bag on each list (`bags`, { list key: bag key }); with none on a list it isn't
//     carried on that leg.
//   * A tick belongs to an item ON A LIST: ticking the rain jacket for one list doesn't tick it
//     for another. A packed-once list's tick has no day; a daily list's tick carries the trip's
//     day, sent by the app (the Itinerary's day, in the trip's time zone, never the phone's):
//     a real date, and one of the list's dates when it names any. A trip without dates still
//     takes ticks; when it has dates, a list for every day takes only the trip's days. Only an
//     item that is on the list can be ticked there.
//
// WHO: a session may touch its own items and the group's, nothing else. Reading somebody
// else's list is 403, and that includes the trip's host. On the group list whoever ticks is
// usually not whoever typed it, so writes are scoped by owner, not by author. A group item's
// tick is the group's: one tick, whoever made it.
//
// Every row is looked up by its id and its trip together.

import { json, readJson } from "./json.js";
import { REV, write } from "../trips/rev.js";
import { err, nowSec, str, validId } from "./trip.js";
import { isDay, onTripDay } from "../../public/js/shared/trip-rules.js";
import { PACKING_ITEMS_PER_OWNER_MAX, ROWS_PER_WRITE_MAX } from "../../public/js/shared/limits.js";
import { listPackingLists } from "./packing/lists.js";
import { listStarters } from "./packing/starters.js";

const COLS = "id, trip_id, owner, label, note, qty, sort, category, created_by, created_at, updated_at, rev";

export const GROUP = "group";

// Sub-grouping inside a bag. Fixed set: the app draws an icon per category.
export const CATEGORIES = ["clothes", "documents", "electronics", "toiletries", "gear", "meds", "misc"];

const shape = (r) => ({
  id: r.id, trip_id: r.trip_id, owner: r.owner, label: r.label, note: r.note, qty: r.qty,
  sort: r.sort, category: r.category || "misc",
  created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at, rev: r.rev,
});

export const mayTouch = (owner, user) => owner === GROUP || owner === user.id;

// The words for packing's refusals, one place for the single routes and the batch.
const NOT_YOURS = "That's on another person's list: only they change it. Your own items and the group's are yours to change.";
const NOT_YOURS_TO_ADD = "An item goes on your own list or the group's (owner \"group\"), not on another person's.";
const noListWords = (list, keys) => `This trip has no packing list "${String(list).slice(0, 64)}"${keys ? `; its lists are ${keys.join(", ")}` : ""}.`;
const noBagWords = (list, bag, keys) => `The list "${list}" has no bag "${String(bag).slice(0, 64)}"; its bags are ${keys.join(", ")}.`;
const CATEGORY_WORDS = `An item's category is one of: ${CATEGORIES.join(", ")}.`;
const noItemWords = (id) => `There's no packing item "${String(id).slice(0, 64)}" on this trip.`;

/** A ceiling against a loop: an owner's items (a person's, or the group's) on one trip. Answers the refusal, or null. */
async function tooManyItems(env, tripId, owner) {
  const held = await env.DB.prepare("SELECT COUNT(*) AS n FROM packing_items WHERE trip_id = ?1 AND owner = ?2").bind(tripId, owner).first();
  if (held.n < PACKING_ITEMS_PER_OWNER_MAX) return null;
  return err(409, "too many items", { max: PACKING_ITEMS_PER_OWNER_MAX, reason: `A packing list holds at most ${PACKING_ITEMS_PER_OWNER_MAX} items (the group's counts on its own).` });
}

async function getItem(env, tripId, id) {
  return await env.DB.prepare(`SELECT ${COLS} FROM packing_items WHERE id = ?1 AND trip_id = ?2`).bind(id, tripId).first();
}

// ── readers, shared with the trip's snapshot ─────────────────────────────────────────────
// Scoped to what this session may read: the caller's own and the group's.

// since (a rev) answers only the rows written after it, and those named in also (ids, as for a picture changed):
// GET /api/trips/<id>?since= (src/api/trip.js, migration 0036's indexes).
export async function listPacking(env, tripId, user, { since = null } = {}) {
  const rows = since === null
    ? await env.DB.prepare(`SELECT ${COLS} FROM packing_items WHERE trip_id = ?1 AND owner IN (?2, ?3) ORDER BY owner, sort, label`)
      .bind(tripId, user.id, GROUP).all()
    : await env.DB.prepare(`SELECT ${COLS.split(",").map((c) => `e.${c.trim()}`).join(", ")} FROM (SELECT id FROM packing_items WHERE trip_id = ?1 AND rev > ?4) AS w
        CROSS JOIN packing_items e ON e.id = w.id WHERE e.owner IN (?2, ?3) ORDER BY e.owner, e.sort, e.label`)
      .bind(tripId, user.id, GROUP, since).all();
  return (rows.results || []).map(shape);
}

export async function listPlacements(env, tripId, user) {
  const rows = await env.DB.prepare(
    `SELECT p.item_id, p.list_key, p.bag_key, p.rev FROM packing_placements p JOIN packing_items i ON i.id = p.item_id
     WHERE p.trip_id = ?1 AND i.owner IN (?2, ?3) ORDER BY p.item_id, p.list_key`,
  ).bind(tripId, user.id, GROUP).all();
  return rows.results || [];
}

export async function listTicks(env, tripId, user) {
  const rows = await env.DB.prepare(
    `SELECT t.item_id, t.list_key, t.day, t.created_by, t.created_at, t.rev FROM packing_ticks t JOIN packing_items i ON i.id = t.item_id
     WHERE t.trip_id = ?1 AND i.owner IN (?2, ?3) ORDER BY t.item_id, t.list_key, t.day`,
  ).bind(tripId, user.id, GROUP).all();
  return (rows.results || []).map((t) => ({ ...t, day: t.day || null }));
}

export async function onRequestGet(ctx) {
  const { user: u, trip } = ctx.data;
  const wanted = new URL(ctx.request.url).searchParams.get("owner");
  if (wanted && !mayTouch(wanted, u)) return err(403, "forbidden", { reason: "Another person's list is theirs: you can read your own and the group's." });
  const [items, lists, placements, ticks, starters] = await Promise.all([
    listPacking(ctx.env, trip.id, u), listPackingLists(ctx.env, trip.id), listPlacements(ctx.env, trip.id, u),
    listTicks(ctx.env, trip.id, u), listStarters(ctx.env, trip.id),
  ]);
  // ?owner= narrows the items to one of the two lists the caller may read, and their
  // placements and ticks with them. The trip's lists and starters are the same either way.
  const mine = wanted ? new Set(items.filter((i) => i.owner === wanted).map((i) => i.id)) : null;
  return json({
    items: mine ? items.filter((i) => mine.has(i.id)) : items,
    lists,
    placements: mine ? placements.filter((p) => mine.has(p.item_id)) : placements,
    ticks: mine ? ticks.filter((t) => mine.has(t.item_id)) : ticks,
    starters,
  });
}

// ── an item's bags ─────────────────────────────────────────────────────────────────────────

/**
 * `bags` from a write, checked against the trip's lists: { list key: bag key, or null for
 * "not carried on this list" }. Answers { bags } or { bad }.
 */
async function readBags(env, tripId, value) {
  if (value === undefined) return { bags: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { bad: err(400, "bad bags", { need: "bags: { list key: bag key, or null to take it off that list }" }) };
  }
  const entries = Object.entries(value);
  if (!entries.length) return { bags: {} };
  const rows = await env.DB.prepare("SELECT list_key, key FROM packing_bags WHERE trip_id = ?1").bind(tripId).all();
  const have = new Map();
  for (const r of rows.results || []) (have.get(r.list_key) ?? have.set(r.list_key, new Set()).get(r.list_key)).add(r.key);
  for (const [list, bag] of entries) {
    if (!have.has(list)) return { bad: err(400, "no such list", { list_key: list, lists: [...have.keys()], reason: noListWords(list, [...have.keys()]) }) };
    if (bag !== null && (typeof bag !== "string" || !have.get(list).has(bag))) {
      return { bad: err(400, "no such bag", { list_key: list, bag_key: bag, bags: [...have.get(list)], reason: noBagWords(list, bag, [...have.get(list)]) }) };
    }
  }
  return { bags: value };
}

/** The statements that put an item in its bags (or take it off a list, with that list's ticks). */
function placeStatements(env, tripId, itemId, bags) {
  return Object.entries(bags).flatMap(([list, bag]) => (bag === null
    ? [
      env.DB.prepare("DELETE FROM packing_ticks WHERE item_id = ?1 AND list_key = ?2").bind(itemId, list),
      env.DB.prepare("DELETE FROM packing_placements WHERE item_id = ?1 AND list_key = ?2").bind(itemId, list),
    ]
    : [env.DB.prepare(
      `INSERT INTO packing_placements (item_id, trip_id, list_key, bag_key, rev) VALUES (?1, ?2, ?3, ?4, ${REV(2)})
       ON CONFLICT(item_id, list_key) DO UPDATE SET bag_key = excluded.bag_key, rev = excluded.rev`,
    ).bind(itemId, tripId, list, bag)]));
}

/** A bag removed between the check and the write: the same answer the check gives. */
async function orNoSuchBag(work) {
  try { return await work(); } catch (e) {
    if (/FOREIGN KEY/i.test(String(e?.message || e))) return err(409, "no such bag", { reason: "a bag named here was removed a moment ago; read the trip again" });
    throw e;
  }
}

// ── POST packing ───────────────────────────────────────────────────────────────────────────

export async function onRequestPost(ctx) {
  const { user: u, trip } = ctx.data;
  const b = await readJson(ctx.request);
  const owner = b.owner === undefined ? u.id : String(b.owner);
  if (!mayTouch(owner, u)) return err(403, "forbidden", { reason: NOT_YOURS_TO_ADD });

  const label = str(b.label, 200);
  if (!label) return err(400, "label required", { reason: "An item needs a label: what it is." });
  const category = b.category === undefined ? "misc" : str(b.category, 20);
  if (!CATEGORIES.includes(category)) return err(400, "bad category", { allowed: CATEGORIES, reason: CATEGORY_WORDS });

  // A client-supplied id: a queued add replayed after a dropped answer must not become two of
  // the same thing in the bag.
  const id = b.id === undefined ? crypto.randomUUID() : String(b.id);
  if (!validId(id)) return err(400, "bad id", { id });
  const there = await getItem(ctx.env, trip.id, id);
  if (there) {
    // A replay of our own write gets its row back. Anything else is a real collision.
    if (!mayTouch(there.owner, u)) return err(409, "id already exists", { id });
    return json({ item: shape(there), rev: trip.rev });
  }

  // The bags are checked BEFORE anything is written, and written in the same batch as the
  // item: an item with no bag is "not carried anywhere", which isn't what someone who just
  // typed it into a bag means.
  const placed = await readBags(ctx.env, trip.id, b.bags);
  if (placed.bad) return placed.bad;
  const full = await tooManyItems(ctx.env, trip.id, owner);
  if (full) return full;

  const ts = nowSec();
  return orNoSuchBag(async () => {
    const { rev, results: [ins] } = await write(ctx.env, trip.id, [
      ctx.env.DB.prepare(
        "INSERT INTO packing_items (id, trip_id, owner, section, label, note, qty, sort, category, created_by, created_at, updated_at, rev) " +
        `VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ${REV(2)}) ON CONFLICT(id) DO NOTHING`,
      ).bind(id, trip.id, owner, label, str(b.note, 1000), str(b.qty, 40), Number.isInteger(b.sort) ? b.sort : 0, category, u.id, ts),
      ...placeStatements(ctx.env, trip.id, id, Object.fromEntries(Object.entries(placed.bags).filter(([, bag]) => bag !== null))),
    ]);
    const row = await getItem(ctx.env, trip.id, id);
    if (!ins.meta.changes) {
      if (!row || !mayTouch(row.owner, u)) return err(409, "id already exists", { id });
      return json({ item: shape(row), rev });
    }
    return json({ item: shape(row), rev }, 201);
  });
}

// ── PATCH packing/<id> ─────────────────────────────────────────────────────────────────────

// The path is canonical (what store.js's queue sends); the body id still works for a
// hand-written call, and a mismatch between the two is a client bug worth naming.
function idFrom(ctx, body) {
  const inPath = ctx.params && ctx.params.id ? String(ctx.params.id) : "";
  const inBody = body && body.id != null ? String(body.id) : "";
  if (inPath && inBody && inPath !== inBody) return { bad: err(400, "id in path and body disagree") };
  return { id: inPath || inBody };
}

export async function onRequestPatch(ctx) {
  const { user: u, trip } = ctx.data;
  const b = await readJson(ctx.request);
  const r = idFrom(ctx, b);
  if (r.bad) return r.bad;
  const id = r.id;
  if (!id) return err(400, "id required");

  const row = await getItem(ctx.env, trip.id, id);
  if (!row) return err(404, "no such item", { id, reason: noItemWords(id) });
  if (!mayTouch(row.owner, u)) return err(403, "forbidden", { reason: NOT_YOURS });

  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const f = {};
  if (has("label")) {
    const label = str(b.label, 200);
    if (!label) return err(400, "label cannot be blank", { reason: "An item's label can't be blank." });
    f.label = label;
  }
  if (has("note")) f.note = str(b.note, 1000);
  if (has("qty")) f.qty = str(b.qty, 40);
  if (has("sort")) f.sort = Number.isInteger(b.sort) ? b.sort : 0;
  if (has("category")) {
    const category = str(b.category, 20);
    if (!CATEGORIES.includes(category)) return err(400, "bad category", { allowed: CATEGORIES, reason: CATEGORY_WORDS });
    f.category = category;
  }
  if (has("owner")) {
    // Moving an item between the group's list and your own (claiming the stove, or handing it
    // back). You must be able to touch the row, and the destination must be yours or group.
    const owner = String(b.owner);
    if (!mayTouch(owner, u)) return err(403, "forbidden", { reason: NOT_YOURS_TO_ADD });
    if (owner !== row.owner) {
      const full = await tooManyItems(ctx.env, trip.id, owner);
      if (full) return full;
    }
    f.owner = owner;
  }
  const placed = await readBags(ctx.env, trip.id, b.bags);
  if (placed.bad) return placed.bad;

  const keys = Object.keys(f);
  const moves = placeStatements(ctx.env, trip.id, id, placed.bags);
  if (!keys.length && !moves.length) return json({ item: shape(row), rev: trip.rev });

  const n = keys.length;
  return orNoSuchBag(async () => {
    const { rev } = await write(ctx.env, trip.id, [
      ctx.env.DB.prepare(
        `UPDATE packing_items SET ${keys.map((k, i) => `${k} = ?${i + 1}, `).join("")}updated_at = ?${n + 1}, rev = ${REV(n + 3)} WHERE id = ?${n + 2} AND trip_id = ?${n + 3}`,
      ).bind(...keys.map((k) => f[k]), nowSec(), id, trip.id),
      ...moves,
    ]);
    return json({ item: shape(await getItem(ctx.env, trip.id, id)), rev });
  });
}

// ── DELETE packing/<id> ────────────────────────────────────────────────────────────────────

export async function onRequestDelete(ctx) {
  const { user: u, trip } = ctx.data;
  const qid = new URL(ctx.request.url).searchParams.get("id");
  const pid = ctx.params && ctx.params.id ? String(ctx.params.id) : "";
  const id = String(pid || qid || (await readJson(ctx.request)).id || "");
  if (!id) return err(400, "id required");

  const row = await getItem(ctx.env, trip.id, id);
  // Already gone is success: a replayed delete that 404s would wedge the head of store.js's
  // queue. No `id` in the answer: store.js's unwrap() treats any body with an id as a row.
  if (!row) return json({ ok: true, deleted: false, rev: trip.rev });
  if (!mayTouch(row.owner, u)) return err(403, "forbidden", { reason: NOT_YOURS });

  const { rev } = await write(ctx.env, trip.id, [
    ctx.env.DB.prepare("DELETE FROM packing_ticks WHERE item_id = ?1").bind(id),
    ctx.env.DB.prepare("DELETE FROM packing_placements WHERE item_id = ?1").bind(id),
    ctx.env.DB.prepare("DELETE FROM packing_items WHERE id = ?1 AND trip_id = ?2").bind(id, trip.id),
  ]);
  return json({ ok: true, deleted: true, rev });
}

// ── PUT packing/items: a batch ─────────────────────────────────────────────────────────────
// { items: [...] } -> { items, rev }. Adds each item (to `owner`: the caller's own list by
// default, or "group"), or changes the one with that id (only the fields sent, as PATCH does),
// in ONE write: a refused row refuses them all, named by its place in the list. Each row is
// held to what POST and PATCH hold it to. It reads what it checks once (the trip's items, bags
// and counts), not per row, so a request stays within a free account's 50 D1 queries
// (check:queries). The MCP's put_packing_items.

export async function putItems(ctx) {
  const { user: u, trip } = ctx.data;
  const b = await readJson(ctx.request);
  if (!Array.isArray(b.items) || !b.items.length) return err(400, "bad items", { need: "items: a list of at least one item" });
  if (b.items.length > ROWS_PER_WRITE_MAX) return err(400, "too many rows", { max: ROWS_PER_WRITE_MAX, reason: `A write is at most ${ROWS_PER_WRITE_MAX} rows: send the rest in another.` });
  const [had, bagRows] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(`SELECT ${COLS} FROM packing_items WHERE trip_id = ?1`).bind(trip.id),
    ctx.env.DB.prepare("SELECT list_key, key FROM packing_bags WHERE trip_id = ?1").bind(trip.id),
  ]);
  const existing = new Map((had.results || []).map((r) => [r.id, r]));
  const count = new Map();
  for (const r of had.results || []) count.set(r.owner, (count.get(r.owner) ?? 0) + 1);
  const bags = new Map();
  for (const r of bagRows.results || []) (bags.get(r.list_key) ?? bags.set(r.list_key, new Set()).get(r.list_key)).add(r.key);
  const rows = [];
  const steps = [];
  const ids = [];
  const ts = nowSec();
  for (const [index, raw] of b.items.entries()) {
    const it = raw && typeof raw === "object" ? raw : {};
    const fail = (error, extra = {}) => rows.push({ index, id: it.id ?? null, error, ...extra });
    const has = (k) => Object.prototype.hasOwnProperty.call(it, k);
    const id = it.id === undefined ? crypto.randomUUID() : String(it.id);
    if (!validId(id)) { fail("bad id", { reason: `"${id.slice(0, 64)}" isn't an id an item can have: letters, digits, dots, hyphens and underscores, at most 64.` }); continue; }
    if (ids.includes(id)) { fail("named twice", { reason: `"${id}" is in the list twice; send it once.` }); continue; }
    const row = existing.get(id);
    // Its bags, against the trip's lists.
    const placed = it.bags === undefined ? {} : it.bags;
    if (!placed || typeof placed !== "object" || Array.isArray(placed)) { fail("bad bags", { need: "bags: { list key: bag key, or null to take it off that list }", reason: "An item's bags name, for each list, the bag it goes in (or null to take it off that list)." }); continue; }
    const badBag = Object.entries(placed).find(([list, bag]) => !bags.has(list) || (bag !== null && (typeof bag !== "string" || !bags.get(list).has(bag))));
    if (badBag) {
      const [list, bag] = badBag;
      if (!bags.has(list)) fail("no such list", { list_key: list, lists: [...bags.keys()], reason: noListWords(list, [...bags.keys()]) });
      else fail("no such bag", { list_key: list, bag_key: bag, bags: [...bags.get(list)], reason: noBagWords(list, bag, [...bags.get(list)]) });
      continue;
    }
    if (row) {
      if (!mayTouch(row.owner, u)) { fail("forbidden", { reason: NOT_YOURS }); continue; }
      const f = {};
      if (has("label")) { const label = str(it.label, 200); if (!label) { fail("label cannot be blank", { reason: "An item's label can't be blank." }); continue; } f.label = label; }
      if (has("note")) f.note = str(it.note, 1000);
      if (has("qty")) f.qty = str(it.qty, 40);
      if (has("sort")) f.sort = Number.isInteger(it.sort) ? it.sort : 0;
      if (has("category")) { const c = str(it.category, 20); if (!CATEGORIES.includes(c)) { fail("bad category", { allowed: CATEGORIES, reason: CATEGORY_WORDS }); continue; } f.category = c; }
      if (has("owner")) {
        const owner = String(it.owner);
        if (!mayTouch(owner, u)) { fail("forbidden", { reason: NOT_YOURS_TO_ADD }); continue; }
        if (owner !== row.owner) { count.set(owner, (count.get(owner) ?? 0) + 1); count.set(row.owner, count.get(row.owner) - 1); }
        f.owner = owner;
      }
      const keys = Object.keys(f);
      const n = keys.length;
      if (n) {
        steps.push(ctx.env.DB.prepare(
          `UPDATE packing_items SET ${keys.map((k, i) => `${k} = ?${i + 1}, `).join("")}updated_at = ?${n + 1}, rev = ${REV(n + 3)} WHERE id = ?${n + 2} AND trip_id = ?${n + 3}`,
        ).bind(...keys.map((k) => f[k]), ts, id, trip.id));
      }
      steps.push(...placeStatements(ctx.env, trip.id, id, placed));
    } else {
      const owner = it.owner === undefined ? u.id : String(it.owner);
      if (!mayTouch(owner, u)) { fail("forbidden", { reason: NOT_YOURS_TO_ADD }); continue; }
      const label = str(it.label, 200);
      if (!label) { fail("label required", { reason: "A new item needs a label: what it is." }); continue; }
      const category = it.category === undefined ? "misc" : str(it.category, 20);
      if (!CATEGORIES.includes(category)) { fail("bad category", { allowed: CATEGORIES, reason: CATEGORY_WORDS }); continue; }
      count.set(owner, (count.get(owner) ?? 0) + 1);
      steps.push(ctx.env.DB.prepare(
        "INSERT INTO packing_items (id, trip_id, owner, section, label, note, qty, sort, category, created_by, created_at, updated_at, rev) " +
        `VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ${REV(2)})`,
      ).bind(id, trip.id, owner, label, str(it.note, 1000), str(it.qty, 40), Number.isInteger(it.sort) ? it.sort : 0, category, u.id, ts));
      steps.push(...placeStatements(ctx.env, trip.id, id, Object.fromEntries(Object.entries(placed).filter(([, bag]) => bag !== null))));
    }
    ids.push(id);
  }
  if (rows.length) return err(400, "bad items", { rows, reason: "Nothing was written: the rows named here were refused." });
  const over = [...count].find(([, n]) => n > PACKING_ITEMS_PER_OWNER_MAX);
  if (over) return err(409, "too many items", { max: PACKING_ITEMS_PER_OWNER_MAX, reason: `A list holds at most ${PACKING_ITEMS_PER_OWNER_MAX} items.` });
  let rev = trip.rev;
  if (steps.length) {
    try {
      ({ rev } = await write(ctx.env, trip.id, steps));
    } catch (e) {
      if (/FOREIGN KEY|UNIQUE/i.test(String(e?.message || e))) return err(409, "changed meanwhile", { reason: "Someone changed these items or the lists' bags a moment ago. Read the packing again, then send the batch." });
      throw e;
    }
  }
  const back = await ctx.env.DB.prepare(`SELECT ${COLS} FROM packing_items WHERE trip_id = ?1 AND id IN (SELECT value FROM json_each(?2))`).bind(trip.id, JSON.stringify(ids)).all();
  const byId = new Map((back.results || []).map((r) => [r.id, shape(r)]));
  return json({ items: ids.map((id) => byId.get(id)).filter(Boolean), rev });
}

// ── PUT packing/ticks ──────────────────────────────────────────────────────────────────────
// { item_id, list_key, day?, ticked }. Setting what is already so is success that changes
// nothing (a tick queued offline can arrive twice).

export async function putTick(ctx) {
  const { user: u, trip } = ctx.data;
  const b = await readJson(ctx.request);
  if (typeof b.ticked !== "boolean") return err(400, "bad ticked", { need: "ticked: true or false" });
  const itemId = typeof b.item_id === "string" ? b.item_id : "";
  const listKey = typeof b.list_key === "string" ? b.list_key : "";
  const item = itemId ? await getItem(ctx.env, trip.id, itemId) : null;
  if (!item) return err(404, "no such item", { item_id: b.item_id ?? null, reason: noItemWords(b.item_id ?? "") });
  if (!mayTouch(item.owner, u)) return err(403, "forbidden", { reason: NOT_YOURS });

  const list = await ctx.env.DB.prepare(
    `SELECT l.repeat, l.dates, p.bag_key FROM packing_lists l
     LEFT JOIN packing_placements p ON p.list_key = l.key AND p.item_id = ?3
     WHERE l.trip_id = ?1 AND l.key = ?2`,
  ).bind(trip.id, listKey, itemId).first();
  if (!list) return err(404, "no such list", { list_key: b.list_key ?? null, reason: noListWords(b.list_key ?? "") });
  if (!list.bag_key) return err(400, "not on that list", { reason: "the item has no bag on that list, so there is nothing to tick there; give it a bag first" });

  let day = "";
  if (list.repeat === "daily") {
    if (!isDay(b.day)) return err(400, "bad day", { reason: "a tick on a list for the day carries the trip's day it is for, YYYY-MM-DD" });
    const dates = list.dates ? JSON.parse(list.dates) : null;
    if (dates && !dates.includes(b.day)) return err(400, "not a day of that list", { day: b.day, dates, reason: `${b.day} isn't one of that list's days: ${dates.join(", ")}.` });
    // A list for every day: every day of the trip, when the trip has dates.
    if (!dates && trip.starts_on && trip.ends_on) {
      const on = onTripDay(b.day, trip, `A tick for ${b.day}`);
      if (!on.ok) return err(400, "not a day of the trip", { reason: on.error, day: b.day, starts_on: trip.starts_on, ends_on: trip.ends_on });
    }
    day = b.day;
  } else if (b.day !== undefined && b.day !== null && b.day !== "") {
    return err(400, "bad day", { reason: "a list that is packed once is ticked once: its tick has no day" });
  }

  const now = await ctx.env.DB.prepare("SELECT 1 FROM packing_ticks WHERE item_id = ?1 AND list_key = ?2 AND day = ?3")
    .bind(itemId, listKey, day).first();
  const tick = { item_id: itemId, list_key: listKey, day: day || null };
  if (!!now === b.ticked) return json({ tick: { ...tick, ticked: b.ticked }, rev: trip.rev });
  const { rev } = await write(ctx.env, trip.id, [b.ticked
    ? ctx.env.DB.prepare(
      `INSERT INTO packing_ticks (item_id, trip_id, list_key, day, created_by, created_at, rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ${REV(2)})
       ON CONFLICT(item_id, list_key, day) DO NOTHING`,
    ).bind(itemId, trip.id, listKey, day, u.id, nowSec())
    : ctx.env.DB.prepare("DELETE FROM packing_ticks WHERE item_id = ?1 AND list_key = ?2 AND day = ?3").bind(itemId, listKey, day)]);
  return json({ tick: { ...tick, ticked: b.ticked }, rev });
}

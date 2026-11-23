// The trip's packing lists and the bags on each.
//
// Under /api/trips/<trip>/ (the route table checks the caller is on the trip). Any member:
//   PUT    packing/lists  { lists: [...] } -> { lists, rev }   adds each list, or changes the one with that key
//   DELETE packing/lists/<key>             -> { ok, deleted, rev }
// Read with the rest of packing (GET packing) and in the trip's snapshot.
//
// A list is { key, name, sort, repeat, dates, bags: [{ key, name }] } (docs/guides/packing.md):
//   * `repeat` is `once` (packed one time, before leaving) or `daily` (what goes in the bag each
//     day out; its ticks belong to a day). `dates` names the days of a daily list, or is null
//     for every day. A named date is a real date, and a day of the trip when the trip has dates
//     (refused with them, like an event). Shortening the trip later doesn't look at lists: a
//     date left outside just never shows.
//   * `bags` sent with a list are added, or changed (a name, a `sort`), and nothing is removed
//     by being left out: two phones that each add a bag, knowing only the bags they last saw,
//     both keep theirs. A bag goes only when the write says so, `{ key, remove: true }`. A bag
//     that holds items (anyone's) can't be removed, nor one a starter starts in, and neither
//     can a list that holds any; the refusal says how many. A new bag without a `sort` goes
//     after the others, in the order sent. A trip always has at least one list: the last can't
//     be removed (rename it, or add another first).
//   * A list's `repeat` can't change while people have ticked it: a tick for a day means
//     nothing on a list packed once, and the other way round.
// A PUT is all or nothing. A list or a bag that is new takes a key a writer chooses:
// lowercase letters, digits and hyphens. Lists from before keep theirs.

import { json, readJson } from "../json.js";
import { err, nowSec } from "../trip.js";
import { REV, write } from "../../trips/rev.js";
import { PACKING_BAGS_MAX, PACKING_LIST_DATES_MAX, PACKING_LISTS_MAX, PACKING_NAME_MAX } from "../../../public/js/shared/limits.js";
import { isDay } from "../../../public/js/shared/trip-rules.js";

const KEY = /^[a-z0-9-]{1,40}$/;

/** The trip's lists, each with its bags in order. Shared with GET packing and the snapshot. */
export async function listPackingLists(env, tripId) {
  const [lists, bags] = await Promise.all([
    env.DB.prepare("SELECT key, name, sort, repeat, dates, rev FROM packing_lists WHERE trip_id = ?1 ORDER BY sort, key").bind(tripId).all(),
    env.DB.prepare("SELECT list_key, key, name, sort, rev FROM packing_bags WHERE trip_id = ?1 ORDER BY sort, key").bind(tripId).all(),
  ]);
  return (lists.results || []).map((l) => ({
    key: l.key, name: l.name, sort: l.sort, repeat: l.repeat, dates: l.dates ? JSON.parse(l.dates) : null, rev: l.rev,
    bags: (bags.results || []).filter((b) => b.list_key === l.key).map((b) => ({ key: b.key, name: b.name, sort: b.sort, rev: b.rev })),
  }));
}

/** The list a new trip starts with (src/trips/trips.js writes it with the trip). */
export const FIRST_LIST = { key: "leaving-home", name: "Leaving home", bags: [["main-bag", "Main bag"], ["day-bag", "Day bag"], ["on-me", "On me"]] };

const name = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

export async function putLists({ request, env, data }) {
  const { trip } = data;
  const b = await readJson(request);
  if (!Array.isArray(b.lists) || !b.lists.length) return err(400, "bad lists", { need: "lists: a list of at least one packing list" });

  const [have, placed, ticked, starting] = await Promise.all([
    listPackingLists(env, trip.id),
    env.DB.prepare("SELECT list_key, bag_key, COUNT(*) AS n FROM packing_placements WHERE trip_id = ?1 GROUP BY list_key, bag_key").bind(trip.id).all(),
    env.DB.prepare("SELECT list_key, COUNT(*) AS n FROM packing_ticks WHERE trip_id = ?1 GROUP BY list_key").bind(trip.id).all(),
    env.DB.prepare("SELECT bags FROM packing_starters WHERE trip_id = ?1").bind(trip.id).all(),
  ]);
  const startsIn = (list, bag) => (starting.results || []).filter((s) => JSON.parse(s.bags || "{}")[list] === bag).length;
  const byKey = new Map(have.map((l) => [l.key, l]));
  const inBag = (list, bag) => (placed.results || []).find((r) => r.list_key === list && r.bag_key === bag)?.n ?? 0;
  const ticks = (list) => (ticked.results || []).find((r) => r.list_key === list)?.n ?? 0;

  const rows = [];
  const out = new Map();
  b.lists.forEach((raw, index) => {
    const fail = (error, more = {}) => rows.push({ index, key: raw?.key ?? null, error, ...more });
    if (!raw || typeof raw !== "object" || typeof raw.key !== "string") return fail("A list needs a key.");
    if (out.has(raw.key)) return fail("This key is in the list twice. Send each list once.");
    const before = byKey.get(raw.key);
    if (!before && !KEY.test(raw.key)) return fail(`"${raw.key.slice(0, 40)}" can't be a list's key: lowercase letters, digits and hyphens, at most 40 ("leaving-home").`);
    const has = (k) => Object.prototype.hasOwnProperty.call(raw, k);
    const l = before
      ? { ...before, bags: before.bags.map((x) => ({ ...x })) }
      : { key: raw.key, name: "", sort: byKey.size + out.size, repeat: "once", dates: null, bags: [] };
    if (has("name") || !before) {
      const n = name(raw.name);
      if (!n || n.length > PACKING_NAME_MAX) return fail(`A list needs a name of 1 to ${PACKING_NAME_MAX} characters: it is a tab and a sentence ("3 of 9 packed for Leaving home").`);
      l.name = n;
    }
    if (has("sort")) {
      if (!Number.isInteger(raw.sort) || raw.sort < 0) return fail("sort is a whole number from 0.");
      l.sort = raw.sort;
    }
    if (has("repeat")) {
      if (!["once", "daily"].includes(raw.repeat)) return fail(`repeat is "once" (packed one time, before leaving) or "daily" (what goes in the bag each day out).`);
      if (before && raw.repeat !== before.repeat && ticks(raw.key)) {
        return fail(`People have ticked "${before.name}" ${ticks(raw.key)} time(s), so it can't change between packed once and for the day. Make a new list instead.`);
      }
      l.repeat = raw.repeat;
    }
    if (has("dates")) l.dates = raw.dates;
    if (l.repeat === "once") {
      if (l.dates !== null && l.dates !== undefined && !(Array.isArray(l.dates) && !l.dates.length)) return fail("Only a list for the day names dates. A list packed once has none.");
      l.dates = null;
    } else if (l.dates !== null && l.dates !== undefined) {
      if (!Array.isArray(l.dates) || !l.dates.length || l.dates.length > PACKING_LIST_DATES_MAX) {
        return fail(`dates is a list of 1 to ${PACKING_LIST_DATES_MAX} days (YYYY-MM-DD), or null for every day of the trip.`);
      }
      const bad = l.dates.find((d) => !isDay(d));
      if (bad !== undefined) return fail(`${JSON.stringify(bad)} isn't a date. Days are written YYYY-MM-DD.`);
      if (trip.starts_on && trip.ends_on) {
        const outside = l.dates.find((d) => d < trip.starts_on || d > trip.ends_on);
        if (outside) return fail(`${outside} isn't a day of the trip. The trip runs from ${trip.starts_on} to ${trip.ends_on}.`);
      }
      l.dates = [...new Set(l.dates)].sort();
    } else l.dates = null;
    l.touched = [];
    l.removed = [];
    if (has("bags")) {
      const bagWords = `A list has 1 to ${PACKING_BAGS_MAX} bags: where a thing physically is ("Carry-on", "Day pack", "On me").`;
      if (!Array.isArray(raw.bags) || raw.bags.length > PACKING_BAGS_MAX * 2) return fail(bagWords);
      const seen = new Set();
      let next = Math.max(-1, ...l.bags.map((x) => x.sort)) + 1;
      for (const bag of raw.bags) {
        if (!bag || typeof bag.key !== "string") return fail("Each bag needs a key and a name.");
        if (seen.has(bag.key)) return fail(`The bag "${bag.key.slice(0, 40)}" is in the list twice.`);
        seen.add(bag.key);
        const at = l.bags.findIndex((x) => x.key === bag.key);
        const was = at < 0 ? null : l.bags[at];
        if (bag.remove !== undefined && bag.remove !== false) {
          if (bag.remove !== true) return fail(`remove is true, to remove the bag "${bag.key.slice(0, 40)}"; leave it out to keep the bag.`);
          // Already gone is success: a removal sent twice must not turn into an error.
          if (was) { l.bags.splice(at, 1); l.removed.push(was.key); }
          continue;
        }
        if (!was && !KEY.test(bag.key)) return fail(`"${bag.key.slice(0, 40)}" can't be a bag's key: lowercase letters, digits and hyphens, at most 40 ("carry-on").`);
        const n = bag.name === undefined && was ? was.name : name(bag.name);
        if (!n || n.length > PACKING_NAME_MAX) return fail(`A bag needs a name of 1 to ${PACKING_NAME_MAX} characters, the way the group will say it.`);
        let sort;
        if (bag.sort !== undefined) {
          if (!Number.isInteger(bag.sort) || bag.sort < 0) return fail("A bag's sort is a whole number from 0.");
          sort = bag.sort;
        } else sort = was ? was.sort : next++;
        const now = { key: bag.key, name: n, sort };
        if (was) l.bags[at] = { ...was, ...now }; else l.bags.push(now);
        l.touched.push(bag.key);
      }
      const held = l.removed.map((key) => ({ key, items: inBag(l.key, key) })).filter((x) => x.items);
      if (held.length) {
        return fail(`A bag that holds items can't be removed: ${held.map((x) => `"${x.key}" holds ${x.items} (counting everyone's)`).join(", ")}. Keep it, or move the items to another bag first.`, { held });
      }
      const suggested = l.removed.map((key) => ({ key, starters: startsIn(l.key, key) })).filter((x) => x.starters);
      if (suggested.length) {
        return fail(`Suggested items start in ${suggested.map((x) => `"${x.key}" (${x.starters})`).join(", ")}, so it can't be removed. Set the starters again without it first.`, { suggested });
      }
      if (!l.bags.length || l.bags.length > PACKING_BAGS_MAX) return fail(bagWords);
      l.bags.sort((a, b) => a.sort - b.sort || (a.key < b.key ? -1 : 1));
    } else if (!before) return fail("A new list needs its bags: two to four is usual, one for a day list.");
    out.set(l.key, l);
  });
  if (rows.length) return err(400, "bad lists", { rows });
  if (new Set([...byKey.keys(), ...out.keys()]).size > PACKING_LISTS_MAX) return err(400, "too many lists", { max: PACKING_LISTS_MAX, reason: `A trip has at most ${PACKING_LISTS_MAX} packing lists.` });

  const now = nowSec();
  const stmts = [];
  for (const l of out.values()) {
    stmts.push(env.DB.prepare(
      `INSERT INTO packing_lists (trip_id, key, name, sort, repeat, dates, created_at, updated_at, rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ${REV(1)})
       ON CONFLICT(trip_id, key) DO UPDATE SET name = excluded.name, sort = excluded.sort, repeat = excluded.repeat,
         dates = excluded.dates, updated_at = excluded.updated_at, rev = excluded.rev`,
    ).bind(trip.id, l.key, l.name, l.sort, l.repeat, l.dates ? JSON.stringify(l.dates) : null, now));
    // Only a bag the write names goes, and only empty (checked above, and again here in case
    // an item landed since: then it stays, and the answer shows it).
    if (l.removed.length) {
      stmts.push(env.DB.prepare(
        `DELETE FROM packing_bags WHERE trip_id = ?1 AND list_key = ?2 AND key IN (SELECT value FROM json_each(?3))
           AND NOT EXISTS (SELECT 1 FROM packing_placements p WHERE p.trip_id = ?1 AND p.list_key = ?2 AND p.bag_key = packing_bags.key)`,
      ).bind(trip.id, l.key, JSON.stringify(l.removed)));
    }
    for (const bag of l.bags.filter((x) => l.touched.includes(x.key))) {
      stmts.push(env.DB.prepare(
        `INSERT INTO packing_bags (trip_id, list_key, key, name, sort, rev) VALUES (?1, ?2, ?3, ?4, ?5, ${REV(1)})
         ON CONFLICT(trip_id, list_key, key) DO UPDATE SET name = excluded.name, sort = excluded.sort, rev = excluded.rev`,
      ).bind(trip.id, l.key, bag.key, bag.name, bag.sort));
    }
  }
  const { rev } = await write(env, trip.id, stmts);
  return json({ lists: await listPackingLists(env, trip.id), rev });
}

export async function deleteList({ env, data, params }) {
  const { trip } = data;
  let key;
  try { key = decodeURIComponent(params.key); } catch { return err(400, "bad key"); }
  const [list, held, starters] = await Promise.all([
    env.DB.prepare("SELECT key FROM packing_lists WHERE trip_id = ?1 AND key = ?2").bind(trip.id, key).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM packing_placements WHERE trip_id = ?1 AND list_key = ?2").bind(trip.id, key).first(),
    env.DB.prepare("SELECT id, bags FROM packing_starters WHERE trip_id = ?1").bind(trip.id).all(),
  ]);
  // Already gone is success: a removal sent twice must not turn into an error.
  if (!list) return json({ ok: true, deleted: false, rev: trip.rev });
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM packing_lists WHERE trip_id = ?1").bind(trip.id).first();
  if (count.n <= 1) return err(409, "last list", { reason: "A trip always has at least one packing list. Rename this one, or add another first." });
  if (held.n) return err(409, "list in use", { reason: `${held.n} item(s) have a bag on this list. Take them off it first, or keep the list.`, items: held.n });
  const named = (starters.results || []).filter((s) => key in JSON.parse(s.bags || "{}")).map((s) => s.id);
  if (named.length) {
    return err(409, "list in use", { reason: `${named.length} suggested item(s) start in a bag on this list. Set the starters again without it first.`, starters: named.slice(0, 20) });
  }
  try {
    const { rev } = await write(env, trip.id, [
      env.DB.prepare("DELETE FROM packing_ticks WHERE trip_id = ?1 AND list_key = ?2").bind(trip.id, key),
      env.DB.prepare("DELETE FROM packing_bags WHERE trip_id = ?1 AND list_key = ?2").bind(trip.id, key),
      env.DB.prepare("DELETE FROM packing_lists WHERE trip_id = ?1 AND key = ?2").bind(trip.id, key),
    ]);
    return json({ ok: true, deleted: true, rev });
  } catch (e) {
    // An item was put in one of its bags between the look and the write: the look's answer.
    if (/FOREIGN KEY/i.test(String(e?.message || e))) return err(409, "list in use", { reason: "An item was just put on this list. Read the trip again." });
    throw e;
  }
}

// The trip's starters: its suggested items, the whole list (docs/guides/packing.md).
//
// Under /api/trips/<trip>/ (the route table checks the caller is on the trip). Any member:
//   PUT   packing/starters  { starters: [...] } -> { starters, rev }   replaces the whole list
//   PATCH packing/starters  { starters: [...] } -> { starters, added, changed, removed, not_found, rev }
//         adds or changes each one sent, found by its scope and label (case and spaces around it
//         aside; a letter's case outside A–Z counts), and removes one only when it comes with
//         "remove": true. One left out stays as it is: nothing is removed by leaving it out
//         (model §5). This is the MCP's way (set_packing_starters); the app's own list and the
//         cutover's tool send the whole list with PUT.
// Read with the rest of packing (GET packing) and in the trip's snapshot.
//
// A starter is { scope: person|group, label, category, note?, qty?, bags: { list key: bag key } }.
// Each bag must be on its list; a list left out of `bags` means it isn't carried there. They
// are offered behind a button and never added to anyone's list for them: a person adds the
// ones they want, and then the items are theirs. Replacing the starters changes nobody's items.

import { json, readJson } from "../json.js";
import { err } from "../trip.js";
import { REV, write } from "../../trips/rev.js";
import { PACKING_STARTERS_MAX } from "../../../public/js/shared/limits.js";
import { CATEGORIES } from "../packing.js";

export async function listStarters(env, tripId) {
  const rows = await env.DB.prepare(
    "SELECT id, scope, label, category, note, qty, bags, sort, rev FROM packing_starters WHERE trip_id = ?1 ORDER BY sort, id",
  ).bind(tripId).all();
  return (rows.results || []).map((s) => ({ ...s, qty: s.qty ?? null, bags: JSON.parse(s.bags || "{}") }));
}

export async function putStarters({ request, env, data }) {
  const { trip } = data;
  const b = await readJson(request);
  if (!Array.isArray(b.starters)) return err(400, "bad starters", { need: "starters: the whole list of suggested items (an empty list removes them all)" });
  if (b.starters.length > PACKING_STARTERS_MAX) return err(400, "too many starters", { max: PACKING_STARTERS_MAX, reason: `A trip has at most ${PACKING_STARTERS_MAX} suggested items; this sends ${b.starters.length}.` });

  const onList = await bagsOf(env, trip.id);
  const rows = [];
  const out = [];
  const ids = new Set();
  b.starters.forEach((raw, index) => {
    const fail = (error) => rows.push({ index, label: raw?.label ?? null, error });
    const read = readStarter(raw, onList, { partial: false });
    if (read.error) return fail(read.error);
    let id = typeof raw.id === "string" && /^[a-z0-9-]{1,64}$/.test(raw.id) ? raw.id : `starter-${index + 1}`;
    while (ids.has(id)) id = `${id}-${index + 1}`;
    ids.add(id);
    out.push({ id, ...read.starter, sort: index });
  });
  if (rows.length) return err(400, "bad starters", { rows });
  return replaceAll(env, trip, out);
}

/** The bags of each list of the trip: Map list key -> Set of bag keys. */
async function bagsOf(env, tripId) {
  const bags = await env.DB.prepare("SELECT list_key, key FROM packing_bags WHERE trip_id = ?1").bind(tripId).all();
  const onList = new Map();
  for (const r of bags.results || []) (onList.get(r.list_key) ?? onList.set(r.list_key, new Set()).get(r.list_key)).add(r.key);
  return onList;
}

/** A label as it is kept and matched: spaces around it gone, runs of spaces one. */
const cleanLabel = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

/**
 * One starter as a write sends it: { starter: { scope, label, category, note, qty, bags (JSON) } }
 * or { error }. `partial`: a change to one that is there, where only scope and label are needed
 * and what isn't sent stays (`starter` then holds only what was sent).
 */
function readStarter(raw, onList, { partial }) {
  if (!raw || typeof raw !== "object") return { error: "A starter is an object: scope, label, category and bags." };
  if (!["person", "group"].includes(raw.scope)) return { error: `scope is "person" (everyone packs their own) or "group" (one is enough for all).` };
  const label = cleanLabel(raw.label);
  if (!label || label.length > 200) return { error: "label is the thing in a few words, at most 200 characters." };
  const starter = { scope: raw.scope, label };
  if (!partial || raw.category !== undefined) {
    if (!CATEGORIES.includes(raw.category)) return { error: `category is one of ${CATEGORIES.join(", ")}.` };
    starter.category = raw.category;
  }
  if (!partial || raw.note !== undefined) {
    const note = raw.note === undefined || raw.note === null ? "" : String(raw.note).trim();
    if (note.length > 1000) return { error: "note is at most 1000 characters." };
    starter.note = note;
  }
  if (!partial || raw.qty !== undefined) {
    if (raw.qty !== undefined && raw.qty !== null && (!Number.isInteger(raw.qty) || raw.qty < 1 || raw.qty > 999)) return { error: "qty is a whole number, and only when a fact of the trip sets it; otherwise leave it out." };
    starter.qty = raw.qty ?? null;
  }
  if (!partial || raw.bags !== undefined) {
    const placed = raw.bags ?? {};
    if (typeof placed !== "object" || Array.isArray(placed) || placed === null) return { error: "bags is { list key: bag key }." };
    for (const [list, bag] of Object.entries(placed)) {
      if (!onList.has(list)) return { error: `There is no list "${list}" in this trip. Its lists: ${[...onList.keys()].join(", ") || "none yet"}.` };
      if (!onList.get(list).has(bag)) return { error: `The list "${list}" has no bag "${bag}". Its bags: ${[...onList.get(list)].join(", ")}.` };
    }
    starter.bags = JSON.stringify(placed);
  }
  return { starter };
}

/** PATCH packing/starters: add or change each one sent, remove one only when it says so. One write. */
export async function patchStarters({ request, env, data }) {
  const { trip } = data;
  const b = await readJson(request);
  if (!Array.isArray(b.starters) || !b.starters.length) return err(400, "bad starters", { need: "starters: the ones to add, change, or (with \"remove\": true) remove; the others stay" });
  if (b.starters.length > PACKING_STARTERS_MAX) return err(400, "too many starters", { max: PACKING_STARTERS_MAX, reason: `A trip has at most ${PACKING_STARTERS_MAX} suggested items; this sends ${b.starters.length}.` });
  const onList = await bagsOf(env, trip.id);
  const rows = [];
  const seen = new Set();
  const sent = [];
  b.starters.forEach((raw, index) => {
    const fail = (error) => rows.push({ index, label: raw?.label ?? null, error });
    const removing = raw?.remove === true;
    const read = readStarter(raw, onList, { partial: true });
    if (read.error) return fail(read.error);
    const key = `${read.starter.scope}\n${read.starter.label.toLowerCase()}`;
    if (seen.has(key)) return fail("This starter is named twice in one call; send it once.");
    seen.add(key);
    sent.push({ index, removing, ...read.starter, category: read.starter.category });
  });
  if (rows.length) return err(400, "bad starters", { rows });
  const there = "trip_id = ?1 AND scope = ?2 AND lower(label) = lower(?3)";
  const steps = [];
  for (const s of sent) {
    if (s.removing) {
      steps.push(env.DB.prepare(`DELETE FROM packing_starters WHERE ${there}`).bind(trip.id, s.scope, s.label));
      continue;
    }
    // Changed where it is (only what was sent), else added at the end of the list. A new one
    // needs its category: added without one, the guard below refuses the whole write.
    const fields = ["category", "note", "qty", "bags"].filter((f) => s[f] !== undefined);
    if (fields.length) {
      steps.push(env.DB.prepare(`UPDATE packing_starters SET ${fields.map((f, i) => `${f} = ?${i + 4}`).join(", ")}, rev = ${REV(1)} WHERE ${there}`)
        .bind(trip.id, s.scope, s.label, ...fields.map((f) => s[f])));
    }
    steps.push(env.DB.prepare(
      `INSERT INTO packing_starters (trip_id, id, scope, label, category, note, qty, bags, sort, rev)
       SELECT ?1, ?4, ?2, ?3, ?5, ?6, ?7, ?8, (SELECT COALESCE(MAX(sort), -1) + 1 FROM packing_starters WHERE trip_id = ?1), ${REV(1)}
       WHERE NOT EXISTS (SELECT 1 FROM packing_starters WHERE ${there})`,
    ).bind(trip.id, s.scope, s.label, `starter-${crypto.randomUUID().slice(0, 13)}`, s.category ?? null, s.note ?? "", s.qty ?? null, s.bags ?? "{}"));
  }
  // The ceiling, held inside the write: past it, this statement fails and nothing is written.
  steps.push(env.DB.prepare(
    `INSERT INTO packing_starters (trip_id) SELECT NULL WHERE (SELECT COUNT(*) FROM packing_starters WHERE trip_id = ?1) > ?2`,
  ).bind(trip.id, PACKING_STARTERS_MAX));
  const before = new Map((await listStarters(env, trip.id)).map((x) => [`${x.scope}\n${x.label.toLowerCase()}`, x]));
  let rev;
  try {
    ({ rev } = await write(env, trip.id, steps));
  } catch (e) {
    const msg = String(e?.message || e);
    if (/NOT NULL/i.test(msg)) {
      const missing = sent.filter((s) => !s.removing && s.category === undefined && !before.has(`${s.scope}\n${s.label.toLowerCase()}`));
      if (missing.length) return err(400, "bad starters", { rows: missing.map((s) => ({ index: s.index, label: s.label, error: `A new starter needs its category: one of ${CATEGORIES.join(", ")}.` })) });
      return err(400, "too many starters", { max: PACKING_STARTERS_MAX, reason: `A trip holds at most ${PACKING_STARTERS_MAX} starters.` });
    }
    throw e;
  }
  const after = await listStarters(env, trip.id);
  const now = new Set(after.map((x) => `${x.scope}\n${x.label.toLowerCase()}`));
  const tally = { added: [], changed: [], removed: [], not_found: [] };
  for (const s of sent) {
    const k = `${s.scope}\n${s.label.toLowerCase()}`;
    if (s.removing) (before.has(k) && !now.has(k) ? tally.removed : tally.not_found).push(s.label);
    else (before.has(k) ? tally.changed : tally.added).push(s.label);
  }
  return json({ starters: after, ...tally, rev });
}

/** The whole list, replaced: PUT's write. */
async function replaceAll(env, trip, out) {
  const { rev } = await write(env, trip.id, [
    env.DB.prepare("DELETE FROM packing_starters WHERE trip_id = ?1").bind(trip.id),
    ...out.map((s) => env.DB.prepare(
      `INSERT INTO packing_starters (trip_id, id, scope, label, category, note, qty, bags, sort, rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ${REV(1)})`,
    ).bind(trip.id, s.id, s.scope, s.label, s.category, s.note, s.qty, s.bags, s.sort)),
  ]);
  return json({ starters: await listStarters(env, trip.id), rev });
}

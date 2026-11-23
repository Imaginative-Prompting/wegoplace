// "Since my last": how a phone takes in an answer of GET /api/trips/<id> (src/api/trip.js), whole or a delta,
// in one place that the app's store (public/js/store.js) and the server's property check
// (checks/trips/delta.mjs) both use, so the check holds the merge the app runs.
//
// A WHOLE answer is the trip. A DELTA (delta: true, since: N) is what changed after rev N:
//   - the four row stores (events, places, packing, purchases) hold only the rows written after N (and any
//     whose picture changed), and `gone` names, for each, the ids that went: those are removed, then these
//     rows put in;
//   - every other collection is either absent (unchanged) or whole (replace it), as in a whole answer.
// The rule for every collection but the row stores is the store's own, from before deltas: absent means
// "unchanged", present means "this is all of it".

export const ROW_STORES = Object.freeze(["events", "places", "packing", "purchases"]);

/**
 * Takes a row store's part of an answer into `map` (id → row). Whole: the map becomes exactly these rows.
 * Delta: the ids gone are removed, then these rows put in (a row deleted and written again after N is in
 * both, and ends present). `keep` makes the stored form of a row (the store freezes it).
 */
export function takeRows(map, rows, { delta = false, gone = [], keep = (r) => r } = {}) {
  if (!Array.isArray(rows)) return;               // absent: unchanged
  if (!delta) map.clear();
  else for (const id of gone ?? []) map.delete(id);
  for (const row of rows) map.set(row.id, keep(row));
}

/** The other collections, each replaced when present: the keys of an answer the store keeps as they come. */
export const WHOLE_KEYS = Object.freeze(["trip", "members", "areas", "currencies", "fx", "storage", "handover", "tiles",
  "packing_lists", "packing_placements", "packing_ticks", "packing_starters", "note_colors", "maps"]);

/**
 * A phone's held trip as plain data (for checks; the store keeps the same in its own forms): { rev, data_rev,
 * rows: { events: Map, … }, <each WHOLE_KEYS key>, chat: { seq, about, muted } }. Takes `answer` in.
 */
export function takeAnswer(held, answer) {
  const next = held ?? { rev: null, data_rev: null, rows: Object.fromEntries(ROW_STORES.map((s) => [s, new Map()])), chat: {} };
  for (const s of ROW_STORES) takeRows(next.rows[s], answer[s], { delta: answer.delta === true, gone: answer.gone?.[s] });
  for (const k of WHOLE_KEYS) if (answer[k] !== undefined) next[k] = answer[k];
  if (answer.chat && typeof answer.chat === "object") {
    next.chat = { ...next.chat, seq: answer.chat.seq, muted: answer.chat.muted, ...(answer.chat.about !== undefined ? { about: answer.chat.about } : {}) };
  }
  next.rev = answer.rev;
  next.data_rev = answer.data_rev;
  return next;
}

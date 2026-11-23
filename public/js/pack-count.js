// How much of your own packing is done, said the way Packing says it: on the list you last opened on your own
// things (or the trip's first list), what you carry on it and how many of those are packed (on a list for the day,
// today). Packing and More both count through here, so the two never disagree.

import { tripIdFromPath, tripKey } from "./trip-here.js";

/** Where the list a tab last showed is kept, per trip (`<prefix>mine`, `<prefix>group`): packing.js's kList writes it. */
export const LIST_KEY = "wgp.pack.list.";

/** The bag an item sits in on a list, or null: "not carried". A placement naming a bag the list no longer has is not carried. */
export function bagKeyOn(S, itemId, list) {
  const k = S.packBag(itemId, list.key);
  return k && list.bags.some((b) => b.key === k) ? k : null;
}

/** The list your own things open on: the one stored for this trip, else the first. Null with no lists. */
export function myListOf(S) {
  const lists = S.packLists();
  if (!lists.length) return null;
  let want = "";
  const key = tripKey(`${LIST_KEY}mine`, tripIdFromPath(location.pathname));
  try { want = localStorage.getItem(key) || ""; } catch { /* private mode */ }
  return lists.find((l) => l.key === want) || lists[0];
}

/** { done, carried } of your own things on your list, or null when there is nothing to count (no list, nothing carried,
 *  or a list for the day on another day). */
export function myPackCount(S) {
  const me = S.me && S.me();
  const list = me && me.id ? myListOf(S) : null;
  if (!list) return null;
  // A list for the day on a day that isn't one of its own has nothing to count (Packing says when it is packed instead).
  const { day, open } = S.packDay(list.key);
  if (!open) return null;
  let carried = 0, done = 0;
  for (const r of S.packing(me.id)) {
    if (!bagKeyOn(S, r.id, list)) continue;
    carried++;
    if (S.packTicked(r.id, list.key, day)) done++;
  }
  return carried ? { done, carried } : null;
}

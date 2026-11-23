// The server said this trip is gone: it was deleted, or this person is no longer on it (it
// answers both in the same words, and only to a signed-in account). The phone stops keeping
// the trip, and only that trip: its stored rows, the changes still waiting to be sent for it
// (the server would refuse each one), what its feed last showed, and the pictures the worker
// kept for it, and what the phone remembered about it (where its map was left, and so on).
// Then Your trips, which says so, and says how many changes went unsent with it.
//
// Loaded by the shell only when store.js emits "gone" (index.html), so the app does not carry
// it at every start.

import { forgetTrip, openExisting } from "./forget.js";
import { dbName, dropKept, dropTripKeys } from "./trip-here.js";

const FEED = "wegoplace-memories";
const STORE = "wegoplace";
const WAIT_MS = 4000;

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

// Which kept pictures were this trip's is written nowhere but in its feed's rows: a picture's
// key names no trip. Read before those rows go.
async function pictureKeys(id) {
  const { db } = await openExisting(dbName(FEED, id));
  if (!db) return [];
  try {
    if (!db.objectStoreNames.contains("memories")) return [];
    const rows = await request(db.transaction(["memories"], "readonly").objectStore("memories").getAll());
    const keys = new Set();
    for (const r of rows || []) {
      for (const m of (r && r.media) || []) {
        for (const k of [m.key, m.r2_key, m.thumb_key]) if (typeof k === "string" && k) keys.add(k);
      }
    }
    return [...keys];
  } finally { db.close(); }
}

// How many changes were still waiting to be sent for this trip. They go with it (the server
// would refuse each one), and the person is told how many: a loss is said, not hidden.
async function waitingChanges(id) {
  try {
    const { db } = await openExisting(dbName(STORE, id));
    if (!db) return 0;
    try {
      if (!db.objectStoreNames.contains("queue")) return 0;
      return Number(await request(db.transaction(["queue"], "readonly").objectStore("queue").count())) || 0;
    } finally { db.close(); }
  } catch { return 0; }
}

/** Your trips' address for a person arriving from a trip that is gone, `unsent` changes lost with it. */
export const goneAddress = (unsent = 0) => `/trips?gone=1${unsent > 0 ? `&unsent=${Math.floor(unsent)}` : ""}`;

/**
 * Stop keeping the trip `id` on this phone, then go to Your trips (or to `to`). Resolves when
 * everything that could be removed has been; never rejects, and always goes.
 */
export async function leaveGoneTrip(id, { to = "" } = {}) {
  const unsent = await waitingChanges(id);   // counted before the rows go
  try {
    const keys = await pictureKeys(id);
    if (keys.length) {
      const { mediaCache } = await import("./memories-save.js");
      // Bounded: a worker that never answers must not keep the person on a trip that is gone.
      await Promise.race([mediaCache.forget(keys), new Promise((r) => setTimeout(r, WAIT_MS))]);
    }
  } catch (e) { console.warn("[trip-gone] kept pictures not dropped", e); }
  try { await forgetTrip(id); } catch (e) { console.warn("[trip-gone] stored rows not dropped", e); }
  try { dropKept(id); } catch { /* the list is rewritten the next time a trip opens */ }
  try { dropTripKeys(id); } catch { /* signing out clears them */ }
  location.replace(to || goneAddress(unsent));
}

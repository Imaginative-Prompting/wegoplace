// A phone that had the app before a trip had an address keeps ONE database, "wegoplace", with
// one trip in it, and maybe changes that never reached the server. Now each trip has its own
// database ("wegoplace:<trip>"). The first time such a phone opens the trip its old database
// holds, everything in it moves into that trip's database: the rows, so the trip still opens
// with no signal, and the queue, so nothing typed on the trail is lost. Then the old one goes.
//
// The order is what makes it safe to be interrupted at any point:
//   1. copy into the trip's database, in ONE transaction that also writes meta "adopted";
//   2. only when that has committed, empty the old database.
// Stopped before 1 commits: nothing changed, it runs again. Stopped after 1: the trip's
// database says "adopted", so the next run copies nothing twice and goes on to 2.
// The old database is left, empty, and never deleted: a delete waits for every other copy of
// the app to let go of it, and every later open of that name waits behind the delete (see
// emptyDatabase in forget.js).
//
// The memories feed has an old database of its own ("wegoplace-memories"); it moves the same
// way when the feed first opens (adoptOldRows), found by the trip id remembered here.
//
// THE QUEUE IS NEVER EMPTIED UNREAD. Every unsent change that comes over is marked OLD_MARK:
// it was written by the app as it was, in that app's shapes, and store.js turns it into this
// app's (old-queue.js) before anything is sent. A change that turns up in the old database
// AFTER the move (another window of the old app was still open and wrote one) joins the
// trip's queue the same way on the next load. The old packing screen kept a queue of its own
// in a third database ("wegoplace-pack"): adoptOldPack brings it, with the lists and bags it
// names, as the record OLD_PACK in the trip's meta.

import { openExisting } from "./forget.js";
import { TRIP_ID, adoptOldKeys } from "./trip-here.js";
import { OLD_MARK } from "./old-queue.js";

export const OLD_STORE = "wegoplace";
/** The old packing screen's database: one store "kv", records "struct" and "queue". */
export const OLD_PACK_STORE = "wegoplace-pack";
/** meta key in a trip's database: { views, sections, placements, queue } from OLD_PACK_STORE, unsent. */
export const OLD_PACK = "old-pack";
/** localStorage: the trip the old databases held. A "wgp." key: signing out clears it. */
export const OLD_TRIP_KEY = "wgp.old-trip";

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const done = (t) => new Promise((resolve, reject) => {
  t.oncomplete = () => resolve();
  t.onerror = () => reject(t.error);
  t.onabort = () => reject(t.error);
});

function remembered() {
  try { return localStorage.getItem(OLD_TRIP_KEY) || ""; } catch { return ""; }
}
function remember(id) {
  try { localStorage.setItem(OLD_TRIP_KEY, id); } catch { /* the feed's old rows stay where they are */ }
}

async function tripIn(old) {
  if (!old.objectStoreNames.contains("meta")) return "";
  const row = await request(old.transaction(["meta"], "readonly").objectStore("meta").get("trip"));
  const id = row && row.v && row.v.id;
  return typeof id === "string" && TRIP_ID.test(id) ? id : "";
}

async function empty(old) {
  const stores = [...old.objectStoreNames];
  if (stores.length) {
    const t = old.transaction(stores, "readwrite");
    for (const s of stores) t.objectStore(s).clear();
    await done(t);
  }
}

/** The trip the database from before holds; "" when there is none, or it holds no trip. */
export async function oldTripId() {
  const { db: old } = await openExisting(OLD_STORE);
  if (!old) return "";
  try { return await tripIn(old); } catch { return ""; } finally { old.close(); }
}

/**
 * Move the old database into `db`, the open database of the trip `tripId`, when the old one
 * holds that trip. Resolves to { moved, rows, waiting }: `moved` false when there was nothing
 * to move (no old database, or it holds another trip); `waiting` is how many unsent changes
 * came with it. Rejects only if the copy itself failed, and then the old database is whole.
 */
export async function adoptOldStore(db, tripId) {
  const { db: old } = await openExisting(OLD_STORE);
  if (!old) return { moved: false, rows: 0, waiting: 0 };
  try {
    if ((await tripIn(old)) !== tripId) return { moved: false, rows: 0, waiting: 0 };
    remember(tripId);
    // What the phone remembered about its one trip (where the map was, the currencies used)
    // was that trip's too.
    adoptOldKeys(tripId);

    const meta = db.transaction(["meta"], "readonly").objectStore("meta");
    const [adopted, hasTrip] = await Promise.all([request(meta.get("adopted")), request(meta.get("trip"))]);
    let rows = 0, waiting = 0;
    if (adopted) {
      // Moved already, on an earlier load. Whatever waits in the old queue now was written
      // after that, and goes to the end of the trip's.
      if (old.objectStoreNames.contains("queue") && db.objectStoreNames.contains("queue")) {
        const late = await request(old.transaction(["queue"], "readonly").objectStore("queue").getAll());
        if (late && late.length) {
          const write = db.transaction(["queue"], "readwrite");
          const finished = done(write);
          for (const row of late) { const { seq, ...op } = row; write.objectStore("queue").add({ ...op, from: OLD_MARK }); waiting++; }
          await finished;
        }
      }
    } else {
      const names = [...old.objectStoreNames].filter((n) => db.objectStoreNames.contains(n));
      const read = old.transaction(names, "readonly");
      const data = {};
      await Promise.all(names.map(async (n) => { data[n] = await request(read.objectStore(n).getAll()); }));

      const write = db.transaction([...new Set([...names, "meta"])], "readwrite");
      const finished = done(write);
      // The trip's database already has a snapshot (an earlier copy failed half way through a
      // load, and the app went on): its rows are newer than the old ones. Only the unsent
      // changes still matter, and they join the end of the queue.
      const queueOnly = !!hasTrip;
      for (const n of names) {
        if (queueOnly && n !== "queue") continue;
        const os = write.objectStore(n);
        for (const row of data[n] || []) {
          if (n === "queue") {
            waiting++;
            if (queueOnly) { const { seq, ...op } = row; os.add({ ...op, from: OLD_MARK }); } else os.put({ ...row, from: OLD_MARK });
          } else { rows++; os.put(row); }
        }
      }
      write.objectStore("meta").put({ k: "adopted", v: Date.now() });
      await finished;
    }
    await empty(old);
    return { moved: true, rows, waiting };
  } finally {
    old.close();
  }
}

/**
 * The old packing screen's unsent changes, with the lists and bags it knew them by, into the
 * meta record OLD_PACK of `db`, the open database of the trip `tripId`. Only when the old
 * databases held that trip. Copy first (joined to what an earlier load brought), empty after.
 * Resolves to how many changes came. With nothing waiting there is nothing to bring: what
 * the old screen knew of lists and bags is the server's to say now.
 */
export async function adoptOldPack(db, tripId) {
  if (remembered() !== tripId) return 0;
  const { db: old } = await openExisting(OLD_PACK_STORE);
  if (!old) return 0;
  try {
    if (!old.objectStoreNames.contains("kv")) return 0;
    const kv = old.transaction(["kv"], "readonly").objectStore("kv");
    const [struct, queue] = await Promise.all([request(kv.get("struct")), request(kv.get("queue"))]);
    const waiting = queue && Array.isArray(queue.v) ? queue.v : [];
    if (waiting.length) {
      const s = (struct && struct.v) || {};
      const write = db.transaction(["meta"], "readwrite");
      const finished = done(write);
      const meta = write.objectStore("meta");
      const had = await request(meta.get(OLD_PACK));
      const before = (had && had.v) || { views: [], sections: [], placements: [], queue: [] };
      const byId = (a, b) => [...new Map([...(a || []), ...(b || [])].map((r) => [r.id, r])).values()];
      const byPlace = (a, b) => [...new Map([...(a || []), ...(b || [])].map((r) => [`${r.item_id}\u0000${r.view_id}`, r])).values()];
      meta.put({ k: OLD_PACK, v: {
        views: byId(before.views, s.views), sections: byId(before.sections, s.sections),
        // Where each thing sat: how a list or bag renamed with no signal is found again.
        placements: byPlace(before.placements, s.placements),
        queue: [...(before.queue || []), ...waiting],
      } });
      await finished;
    }
    await empty(old);
    return waiting.length;
  } finally {
    old.close();
  }
}

/**
 * The offline map the app kept before a map belonged to a trip: one archive in the cache
 * `cacheName`, at an address under /tiles/. It is the map of the trip that phone had, so it
 * moves to that trip's address `url` and the map still draws with no signal after the app
 * updates. Copy first, remove after: stopped in between, the next call finds the copy and
 * only removes. Resolves true when an old archive was found.
 */
export async function adoptOldArchive(cacheName, tripId, url) {
  if (typeof caches === "undefined" || !tripId || remembered() !== tripId) return false;
  const c = await caches.open(cacheName);
  const old = (await c.keys()).filter((req) => {
    const path = new URL(req.url).pathname;
    return path.startsWith("/tiles/") && path.endsWith(".pmtiles");
  });
  if (!old.length) return false;
  if (!(await c.match(url))) {
    const res = await c.match(old[0]);
    if (res && res.ok) await c.put(url, res);
  }
  for (const req of old) await c.delete(req);
  return true;
}

/**
 * The same move for a database that is only rows (the memories feed's): the rows of `store`
 * in the old database `oldName` go into `db`, when the old databases held the trip `tripId`.
 * Rows the trip's database already has are left as they are: they are newer.
 */
export async function adoptOldRows(db, oldName, store, tripId) {
  if (remembered() !== tripId) return { moved: false, rows: 0 };
  const { db: old } = await openExisting(oldName);
  if (!old) return { moved: false, rows: 0 };
  try {
    let rows = 0;
    if (old.objectStoreNames.contains(store) && db.objectStoreNames.contains(store)) {
      const all = await request(old.transaction([store], "readonly").objectStore(store).getAll());
      const write = db.transaction([store], "readwrite");
      const finished = done(write);
      const os = write.objectStore(store);
      for (const row of all || []) {
        rows++;
        // add(), not put(): a row already there fails its own request and nothing else.
        const r = os.add(row);
        r.onerror = (e) => { e.preventDefault(); e.stopPropagation(); rows--; };
      }
      await finished;
    }
    await empty(old);
    return { moved: true, rows };
  } finally {
    old.close();
  }
}

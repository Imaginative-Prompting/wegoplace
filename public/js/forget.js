// What this phone keeps about a signed-in person, and how to take it all away.
//
// Signing out, or deleting the account, has to leave nothing of the person behind on a phone
// somebody else may pick up: the trips the app stored to work offline, the changes still
// waiting to be sent, the kit list, the pictures the service worker kept. A session that
// merely expires is a different thing and clears nothing: the same person signs back in and
// their waiting changes are sent. A DIFFERENT person signing in is the third case: what is
// stored belongs to somebody else, so it goes before any of it is shown or sent, and the
// first person's unsent changes are lost with it (nobody else may send them).
//
// No imports and no DOM, so the sign-in page and the account page can load it without loading
// the app. It opens the databases by name, which is why the names live in the table below and
// scripts/forget_check.mjs fails when a module opens one that is not listed.
//
// The pages that sign a person out:
//   const n = await waitingChanges();      // ask twice when n > 0, showing waitingWords(n)
//   ...the sign-out or delete request succeeds...
//   await forgetThisPhone();
//
// The app, before it reads what is stored: ownerVerdict(storedOwner, sessionAccount()).

/**
 * Every IndexedDB database the app opens or ever opened, and where each keeps changes not yet
 * sent. `retired` marks one that no code opens any more: a phone that had the app before
 * still has it, with a person's things in it, so it is still counted and still emptied.
 * `perTrip` marks one the app keeps once for EACH trip, named "<name>:<trip id>"; the bare
 * name is then the single database a phone had before a trip had an address (trip-adopt.js
 * moves it into its trip's), counted and emptied like a retired one. databasesHere() turns
 * this table into the databases actually on the phone.
 */
export const DATABASES = [
  // store.js: a trip (events, places, packing and its lists, notes, purchases), and its
  // write queue.
  { name: "wegoplace", waiting: { store: "queue" }, perTrip: true },
  // Until packing moved onto the trip's lists (sw.js v60), packing.js kept each person's bags
  // here, with their own queue as one record. Whatever that queue still holds was never sent.
  { name: "wegoplace-pack", waiting: { store: "kv", key: "queue" }, retired: true },
  // memories.js: what a trip's feed last showed.
  { name: "wegoplace-memories", waiting: null, perTrip: true },
  // chat.js: a trip's messages as last seen, and its outbox (messages, changes and deletes not
  // yet sent).
  { name: "wegoplace-chat", waiting: { store: "outbox" }, perTrip: true },
  // picture-wait.js: a trip's pictures made on this phone and not yet on the server (receipts,
  // places' and plans' photos, the cover), and removals not yet sent.
  { name: "wegoplace-picture-wait", waiting: { store: "waiting" }, perTrip: true },
];

/**
 * localStorage: the trips this phone keeps, written by trip-here.js (its KEPT_KEY; the two
 * names are held equal by scripts/forget_check.mjs). Read here by name so this file keeps
 * having no imports.
 */
export const KEPT_TRIPS_KEY = "wgp.kept";
const TRIP_ID = /^[A-Za-z0-9_.-]{1,64}$/;

function keptTripIds() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEPT_TRIPS_KEY) || "null");
    if (!raw || typeof raw.trips !== "object" || !raw.trips) return [];
    return Object.keys(raw.trips).filter((id) => TRIP_ID.test(id));
  } catch { return []; }
}

/**
 * Cache Storage that holds a person's things: their trips' photos and videos, the pictures their
 * trips' people drew (js/pictures.js), and the files of the towns' table their typing asked for (the files are public, but WHICH of them a phone has
 * says what somebody typed into "Where").
 */
export const PRIVATE_CACHES = ["wegoplace-media-v1", "wegoplace-towns-v1", "wegoplace-pictures-v1"];

// Where map.js keeps a trip's offline map: one cache, each trip's archive at the trip's own
// address. Signing out leaves them (a map of a place is not a person's data, and it is the
// biggest thing a phone would have to fetch again); a trip that is gone takes its own with it.
export const TRIP_MAPS = "wgp-tiles-v1";
export const tripMapAddress = (id) => `/api/trips/${encodeURIComponent(id)}/tiles`;

/**
 * Cache Storage that stays, each on purpose: files anyone may fetch, the same for every person.
 * A name ending in "-" stands for every cache that starts with it. A cache the code opens that
 * is in neither list fails scripts/forget_check.mjs: a trip's own map or pictures belong above.
 */
export const KEPT_CACHES = [
  "wegoplace-shell-",     // the app's own files, one cache per version
  "wegoplace-pages",      // which build each open page is (tab ids and versions, nothing of a person's): sw.js shellFor()
  "wegoplace-tiles-v1",   // the map's glyphs and sprites
  "wegoplace-img-v1",     // place photographs, public files
  TRIP_MAPS,              // each trip's offline map: a map of a region, the same for everyone on the trip
];

/** localStorage keys that describe the phone, not the person. Every other "wgp." key goes. */
export const KEPT_KEYS = ["wgp.theme", "wgp.kbh", "wgp.epoch"];

// ── the epoch ──────────────────────────────────────────────────────────────────────────
// A copy of the app that was open, or frozen in the background, when the person signed out
// still has their trip in memory, and it would write that back to the databases just emptied,
// or send its waiting changes under whoever signs in next. So forgetting changes one word in
// localStorage, which every tab reads synchronously: a copy of the app remembers the word it
// was born with and stops the moment the two differ. A "storage" event carries the change to
// open tabs at once; the comparison catches the ones that were asleep.
const EPOCH_KEY = "wgp.epoch";

/** The phone's current epoch: "" until the first sign-out or account delete on this phone. */
export function epoch() {
  try { return localStorage.getItem(EPOCH_KEY) || ""; } catch { return ""; }
}

/**
 * For a page that holds a person's data in memory. Returns left(): true once this phone has
 * been cleared since the page loaded. `leave` runs once, the first time that is noticed: by
 * the storage event, by a page coming back from the back-forward cache, or by a call to left().
 */
export function watchEpoch(leave) {
  const born = epoch();
  let gone = false;
  const left = () => {
    if (!gone && epoch() !== born) {
      gone = true;
      try { leave(); } catch { /* leaving is best effort; the guards still hold */ }
    }
    return gone;
  };
  try {
    addEventListener("storage", (e) => { if (e.key === EPOCH_KEY || e.key === null) left(); });
    addEventListener("pageshow", () => left());
    document.addEventListener("visibilitychange", () => left());
  } catch { /* no window: a worker or a test calls left() itself */ }
  return left;
}

const idb = () => { try { return globalThis.indexedDB || null; } catch { return null; } };

// Opening a database that does not exist would create it. onupgradeneeded only fires for a
// database being made (or raised), so aborting there leaves nothing behind.
// Answers { db } for one that exists, { absent: true } for one that does not, and
// { failed: true } when the browser would not open it: those rows may still be there.
/**
 * Open a database only if it is already there: { db } when it is, { absent } when nothing was
 * ever stored under the name (nothing is created), { failed } when it would not open.
 */
export function openExisting(name) {
  const f = idb();
  if (!f) return Promise.resolve({ absent: true });
  return new Promise((resolve) => {
    let made = false;
    let req;
    try { req = f.open(name); } catch { resolve({ failed: true }); return; }
    req.onupgradeneeded = () => { made = true; try { req.transaction.abort(); } catch { /* already gone */ } };
    req.onsuccess = () => { if (made) { req.result.close(); resolve({ absent: true }); } else resolve({ db: req.result }); };
    // Aborting the creation above also ends the request in an error: that one is "absent".
    req.onerror = (e) => { e.preventDefault?.(); resolve(made ? { absent: true } : { failed: true }); };
    req.onblocked = () => resolve({ failed: true });
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function countWaiting(db, where) {
  if (!where || !db.objectStoreNames.contains(where.store)) return 0;
  const os = db.transaction([where.store], "readonly").objectStore(where.store);
  if (!where.key) return (await request(os.count())) || 0;
  const rec = await request(os.get(where.key));
  return rec && Array.isArray(rec.v) ? rec.v.length : 0;
}

/**
 * Every database on this phone that may hold a person's things: [{ name, base, waiting }].
 * The names in the table; and for a per-trip one, a database for each trip the phone's own
 * list names and for each the browser lists (where it can list them: the phone's list is what
 * makes this complete where it can't, which is why store.js writes a trip into that list
 * BEFORE it opens the trip's database). `base` is the table's name, the one a page puts into
 * words when something could not be cleared.
 */
export async function databasesHere() {
  const out = new Map();
  const add = (name, d) => { if (!out.has(name)) out.set(name, { name, base: d.name, waiting: d.waiting }); };
  let listed = [];
  try {
    const f = idb();
    if (f && typeof f.databases === "function") listed = (await f.databases()) || [];
  } catch { listed = []; }
  const ids = keptTripIds();
  for (const d of DATABASES) {
    add(d.name, d);
    if (!d.perTrip) continue;
    for (const id of ids) add(`${d.name}:${id}`, d);
    for (const row of listed) {
      const n = row && row.name;
      if (typeof n === "string" && n.startsWith(`${d.name}:`) && TRIP_ID.test(n.slice(d.name.length + 1))) add(n, d);
    }
  }
  return [...out.values()];
}

/** How many changes made on this phone have not reached the server. 0 when storage is unreadable. */
export async function waitingChanges() {
  let n = 0;
  for (const d of await databasesHere()) {
    const { db } = await openExisting(d.name);
    if (!db) continue;                       // not there, or unreadable: counts as none
    try { n += await countWaiting(db, d.waiting); } catch { /* unreadable counts as none */ }
    db.close();
  }
  return n;
}

/** The words a page shows before it asks a second time (no full stop). "" when nothing is waiting. */
export function waitingWords(n) {
  if (!(n > 0)) return "";
  return n === 1 ? "1 change hasn't been sent" : `${n} changes haven't been sent`;
}

async function emptyDatabase(name) {
  const { db, failed } = await openExisting(name);
  if (failed) return false;                  // it would not open: its rows may still be there
  if (!db) return true;                      // nothing was ever stored under this name
  let ok = true;
  try {
    const stores = [...db.objectStoreNames];
    if (stores.length) {
      await new Promise((resolve, reject) => {
        const t = db.transaction(stores, "readwrite");
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
        for (const s of stores) t.objectStore(s).clear();
      });
    }
  } catch { ok = false; }
  db.close();
  // The emptied database stays. Deleting it would wait for every other copy of the app to let
  // go of it, and until then every later open of that name waits behind the delete: the next
  // person to sign in would get an app that never finishes starting, because of a tab asleep
  // in the background. Empty is enough.
  return ok;
}

/**
 * Remove everything this phone keeps about the person: stored trips and the changes waiting to
 * be sent, the kit list, the feed, kept pictures, and every remembered choice that is not about
 * the phone itself. Moves the epoch first, so any open copy of the app stops writing and leaves.
 * Resolves to { ok, failed }: `failed` names what could not be cleared.
 */
export async function forgetThisPhone() {
  const failed = [];
  // First, so every other copy of the app stops before its rows go.
  try {
    localStorage.setItem(EPOCH_KEY, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  } catch { failed.push("localStorage"); }

  // Before the remembered choices go below: the phone's list of trips is one of them, and it
  // is how each trip's database is found.
  for (const d of await databasesHere()) {
    if (!(await emptyDatabase(d.name)) && !failed.includes(d.base)) failed.push(d.base);
  }
  // This browser's push subscription: the phone stops hearing the trips of whoever was signed in.
  // (Signing out tells the server first, public/js/auth.js; here the browser lets it go, so a
  // push service answers "gone" to anything still sent, and the server's row goes with it.)
  try {
    const reg = await globalThis.navigator?.serviceWorker?.getRegistration?.();
    const sub = await reg?.pushManager?.getSubscription?.();
    if (sub) await sub.unsubscribe();
  } catch { failed.push("push"); }
  if (globalThis.caches) {
    for (const c of PRIVATE_CACHES) {
      try { await caches.delete(c); } catch { failed.push(c); }
    }
  }
  try {
    const gone = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("wgp.") && !KEPT_KEYS.includes(k)) gone.push(k);
    }
    for (const k of gone) localStorage.removeItem(k);
  } catch { if (!failed.includes("localStorage")) failed.push("localStorage"); }
  return { ok: failed.length === 0, failed };
}

// ── whose data this is ─────────────────────────────────────────────────────────────────
// The session cookie is not readable from a page, on purpose. Beside it the server sets a
// second cookie that IS readable and holds nothing but the account's id, so a page can tell,
// before it reads a single stored row and with no network, whether the session belongs to the
// person the stored data belongs to.
/**
 * Remove what this phone keeps of ONE trip: its stored rows, the changes waiting to be sent
 * for it, what its feed last showed, its offline map. For a trip the server says is gone (deleted, or the
 * person is no longer on it): everything else on the phone stays. Kept pictures are the
 * caller's to drop first (memories know which were this trip's; see trip-gone.js), and so is
 * the phone's list of trips. Resolves to { ok, failed } like forgetThisPhone.
 */
export async function forgetTrip(id) {
  const failed = [];
  if (!TRIP_ID.test(String(id || ""))) return { ok: false, failed: ["trip"] };
  for (const d of DATABASES) {
    if (!d.perTrip) continue;
    if (!(await emptyDatabase(`${d.name}:${id}`))) failed.push(d.name);
  }
  // Its offline map, the largest thing the phone kept for it.
  try {
    if (typeof caches !== "undefined" && (await caches.has(TRIP_MAPS))) {
      await (await caches.open(TRIP_MAPS)).delete(tripMapAddress(id));
    }
  } catch { failed.push("map"); }
  return { ok: failed.length === 0, failed };
}

export const WHO_COOKIE = "wgp_who";

/** The id of the account this browser's session belongs to; "" when the server set no such cookie. */
export function sessionAccount(cookies) {
  let all = cookies;
  if (all === undefined) { try { all = document.cookie; } catch { all = ""; } }
  for (const part of String(all || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === WHO_COOKIE) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ""; }
    }
  }
  return "";
}

/**
 * May data stored for `owner` be shown and sent under the account `account`?
 *   "same"     yes: it is theirs, or nothing is stored for anyone
 *   "other"    no: it is somebody else's. Clear the phone before reading anything.
 *   "unknown"  not known yet (no cookie): show it, as an offline phone must, send nothing, and
 *              settle it with the first answer from the server.
 */
export function ownerVerdict(owner, account) {
  if (!owner) return "same";
  if (!account) return "unknown";
  return String(owner) === String(account) ? "same" : "other";
}

// Which trip this page is, and which trips this phone keeps.
//
// A trip's page is /t/<id>/. Everything a module needs to know about "which trip" comes from
// here, read once from the address when the page loads: going from one trip to another is a
// full page load, so every module stays bound to ONE trip for the life of the page.
//
// No document and no network in this file: the address and the storage are handed in, so
// scripts/trip_here_check.mjs runs it under plain node.

/** A trip's id, as the server accepts one (src/api/trip.js). */
export const TRIP_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** The id in an address like "/t/<id>/" (or "/t/<id>"); "" when the address names no trip. */
export function tripIdFromPath(pathname) {
  const m = /^\/t\/([^/]+)\/?$/.exec(String(pathname || ""));
  if (!m) return "";
  let id = "";
  try { id = decodeURIComponent(m[1]); } catch { return ""; }
  return TRIP_ID.test(id) ? id : "";
}

/** The app's address for a trip, with an optional "#/…" part. */
export function tripPath(id, hash = "") {
  return `/t/${encodeURIComponent(id)}/${hash && hash !== "#" ? (hash.startsWith("#") ? hash : `#${hash}`) : ""}`;
}

/** The API address of something a trip holds: tripApi("t1") is the trip, tripApi("t1", "/events") its events. */
export function tripApi(id, rest = "") {
  if (!TRIP_ID.test(String(id || ""))) throw new Error("tripApi: no trip");
  return `/api/trips/${encodeURIComponent(id)}${rest}`;
}

/** The name of one trip's IndexedDB database: one snapshot and one queue of unsent changes per trip. */
export function dbName(base, id) {
  if (!TRIP_ID.test(String(id || ""))) throw new Error("dbName: no trip");
  return `${base}:${id}`;
}

/** The trip id a database name carries; "" for a name that isn't one trip's (the database from before trips). */
export function tripOfDb(base, name) {
  const s = String(name || "");
  if (!s.startsWith(`${base}:`)) return "";
  const id = s.slice(base.length + 1);
  return TRIP_ID.test(id) ? id : "";
}

// ── the trips this phone keeps ────────────────────────────────────────────────────────────
// localStorage "wgp.kept": { v: 1, who, last, trips: { <id>: { name, at } } }. A "wgp." key,
// so signing out clears it with everything else about the person (forget.js). `who` is the
// account it was written for: a list written for somebody else is never read.
export const KEPT_KEY = "wgp.kept";

const storageOf = (storage) => {
  if (storage) return storage;
  try { return globalThis.localStorage || null; } catch { return null; }
};

function read(storage, who) {
  const empty = { v: 1, who: who || "", last: "", trips: {} };
  const ls = storageOf(storage);
  if (!ls) return empty;
  let raw = null;
  try { raw = JSON.parse(ls.getItem(KEPT_KEY) || "null"); } catch { return empty; }
  if (!raw || raw.v !== 1 || typeof raw.trips !== "object" || !raw.trips) return empty;
  // Written for another account: not this person's list. Written before the account was
  // known (who ""), or read before it is: the list is what the phone has.
  if (who && raw.who && raw.who !== who) return empty;
  const trips = {};
  for (const [id, t] of Object.entries(raw.trips)) {
    if (!TRIP_ID.test(id) || !t || typeof t !== "object") continue;
    trips[id] = { name: typeof t.name === "string" ? t.name : "", at: Number(t.at) || 0 };
  }
  const last = typeof raw.last === "string" && trips[raw.last] ? raw.last : "";
  return { v: 1, who: who || raw.who || "", last, trips };
}

function write(storage, rec) {
  const ls = storageOf(storage);
  if (!ls) return false;
  try { ls.setItem(KEPT_KEY, JSON.stringify(rec)); return true; } catch { return false; }
}

/** The account the list was written for; "" when there is no list, or it was written before the account was known. */
export function keptOwner({ storage } = {}) {
  const ls = storageOf(storage);
  if (!ls) return "";
  try {
    const raw = JSON.parse(ls.getItem(KEPT_KEY) || "null");
    return raw && raw.v === 1 && typeof raw.who === "string" ? raw.who : "";
  } catch { return ""; }
}

/** The trips this phone keeps, the one opened last first: [{ id, name, at }]. */
export function keptTrips({ storage, who = "" } = {}) {
  const rec = read(storage, who);
  return Object.entries(rec.trips).map(([id, t]) => ({ id, name: t.name, at: t.at }))
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}

/** The trip this phone opened last and still keeps; "" when it keeps none. */
export function lastTrip({ storage, who = "" } = {}) {
  const rec = read(storage, who);
  if (rec.last) return rec.last;
  const all = keptTrips({ storage, who });
  return all.length ? all[0].id : "";
}

/** This phone opened the trip, and keeps it from now on. */
export function noteOpened(id, { storage, who = "", name = "", now = Date.now() } = {}) {
  if (!TRIP_ID.test(String(id || ""))) return false;
  const rec = read(storage, who);
  rec.trips[id] = { name: name || (rec.trips[id] && rec.trips[id].name) || "", at: now };
  rec.last = id;
  if (who) rec.who = who;
  // No bound on the list, on purpose: it is also how signing out finds each trip's database
  // where the browser can't list databases (forget.js), so a trip dropped from it to save a
  // few bytes would be a trip left on the phone.
  return write(storage, rec);
}

/** The phone no longer keeps the trip (it was deleted, or the person is no longer on it). */
export function dropKept(id, { storage, who = "" } = {}) {
  const rec = read(storage, who);
  if (!rec.trips[id]) return false;
  delete rec.trips[id];
  if (rec.last === id) rec.last = "";
  return write(storage, rec);
}

// ── what the phone remembers about one trip ──────────────────────────────────────────────
// Where the map was left, which packing list was open, which sections were folded, the
// currencies last used in Split, the pictures this phone keeps for it (pictures-offline.js): each
// is about ONE trip, so each is stored once per
// trip, under "<key>@<trip id>" ("@" is in no trip id). Still "wgp." keys: signing out clears
// them all. An entry that ends in "." is the start of a family of keys.
export const TRIP_KEYS = ["wgp.map.cam", "wgp.map.said", "wgp.pack.folded", "wgp.pack.list.", "wgp.split.display", "wgp.split.currency", "wgp.pics",
  "wgp.assistant", "wgp.assistant.shared"];

const isTripKey = (key) => TRIP_KEYS.some((k) => (k.endsWith(".") ? key.startsWith(k) && key.length > k.length : key === k));

/** The name a choice about the trip `id` is stored under. */
export function tripKey(key, id) {
  if (!TRIP_ID.test(String(id || ""))) throw new Error("tripKey: no trip");
  return `${key}@${id}`;
}

const keysOf = (ls) => {
  const out = [];
  try { for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (typeof k === "string") out.push(k); } } catch { /* unreadable: none */ }
  return out;
};

/** The trip is gone from this phone: what was remembered about it goes too. Returns how many keys. */
export function dropTripKeys(id, { storage } = {}) {
  const ls = storageOf(storage);
  if (!ls || !TRIP_ID.test(String(id || ""))) return 0;
  let n = 0;
  for (const k of keysOf(ls)) {
    const at = k.lastIndexOf("@");
    if (at < 0 || k.slice(at + 1) !== id || !isTripKey(k.slice(0, at))) continue;
    try { ls.removeItem(k); n++; } catch { /* stays; signing out still clears it */ }
  }
  return n;
}

/**
 * A phone from before a trip had an address stored these choices once, for its one trip. They
 * become that trip's (called when its old database moves, trip-adopt.js). A choice already
 * made for the trip since wins. Returns how many moved.
 */
export function adoptOldKeys(id, { storage } = {}) {
  const ls = storageOf(storage);
  if (!ls || !TRIP_ID.test(String(id || ""))) return 0;
  let n = 0;
  for (const k of keysOf(ls)) {
    if (k.includes("@") || !isTripKey(k)) continue;
    try {
      const v = ls.getItem(k);
      if (v !== null && ls.getItem(tripKey(k, id)) === null) { ls.setItem(tripKey(k, id), v); n++; }
      ls.removeItem(k);
    } catch { /* stays where it was; nothing reads it there */ }
  }
  return n;
}

/**
 * Where the app's own address "/" goes: the trip this phone opened last, else Your trips.
 * `hash` is kept for a trip ("/#/split" opens Split of the last trip).
 */
export function homeAddress({ storage, who = "", hash = "" } = {}) {
  const id = lastTrip({ storage, who });
  return id ? tripPath(id, hash) : "/trips";
}

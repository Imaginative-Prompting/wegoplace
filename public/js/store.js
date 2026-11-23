// store.js — the offline-first data layer. Nothing else in the app calls fetch().
//
// THE CONSTRAINT: four days on a trail with no signal, and no "save for offline"
// button anywhere in the UI. So:
//   * reads are synchronous accessors over an in-memory mirror hydrated from IndexedDB.
//     They never await, never touch the network, and cannot fail.
//   * a background refresh replaces the cache and emits "change". Views re-render from
//     whatever is there; they never know whether it came from the wire or from disk.
//   * writes apply to the mirror immediately, land in a durable queue, and drain whenever
//     the radio comes back. A write made in a tent on day 2 is indistinguishable, to the
//     view that made it, from one made on hotel wifi.
//
// WHICH TRIP: the one in the page's address, /t/<id>/ (trip-here.js). This module is bound to
// that one trip for the life of the page: its database is the trip's own ("wegoplace:<id>"),
// and every address below that starts /api/trips/:trip/ is that trip's. Going to another trip
// is a page load. `:trip` below stands for /api/trips/<id>.
//
// WIRE CONTRACT (docs/API.md is the authority; the server's files are src/):
//
//   GET    /api/me                -> { id, name, note_color, initials }
//   PATCH  /api/me                body = { note_color? , initials? , native_currency? }
//                                    -> { me }   NO id in the path, ever: the row it writes is
//                                    whoever holds the session cookie.
//   GET    :trip                  -> { trip, members, areas, places, events, packing, notes,
//                                      note_colors, purchases, currencies, fx, tiles }
//                                    one snapshot, the whole app state. ~370 rows; splitting
//                                    it into five requests would only add five ways to be
//                                    half-offline. 404 {"error":"no such trip"} for a trip
//                                    that was deleted or that this account isn't on: see
//                                    "a trip that is gone" in refresh().
//   POST   :trip/events           body = a COMPLETE event row including its id -> { event }
//   PATCH  :trip/events/:id       body = patch -> { event }
//   DELETE :trip/events/:id       -> { ok: true }
//   POST   :trip/notes            body = a complete note row including its id -> { note }
//   DELETE :trip/notes/:id        author only -> { ok } (no id: see unwrap below)
//   POST   :trip/packing          body = a complete packing row including its id -> { item }
//   PATCH  :trip/packing/:id      body = patch -> { item }
//   DELETE :trip/packing/:id      -> { ok: true }
//   POST   :trip/purchases        body = a COMPLETE purchase row including its id AND its
//                                    complete `shares` array -> { purchase }
//                                    201 fresh / 200 replay. See below: this POST must APPLY
//                                    a folded edit, not merely tolerate a retry.
//   PATCH  :trip/purchases/:id    body = patch -> { purchase }
//                                    Any patch touching amount_minor / currency / amount_exp /
//                                    split_mode / shares must carry ALL FIVE — the queue fold
//                                    is a shallow merge and an array field is replaced
//                                    wholesale, so a partial economic patch loses everybody
//                                    else's share the moment two offline edits fold.
//   DELETE :trip/purchases/:id    author OR payer -> { ok, deleted } (no id: see unwrap below)
//   POST   /api/fx/refresh        -> { fx }   the only non-row call in this file. Not queued:
//                                    it writes nothing that belongs to anybody.
//
// Write responses are ENVELOPED ({ event } / { item } / { note } / { me } / { purchase });
// unwrap() below is the one place that knows it. Reads are enveloped too, but the snapshot is
// destructured by name in applySnapshot, so it does not need the same treatment.
//
// Two properties of that contract are load-bearing, not stylistic:
//   1. ids are generated on the CLIENT. An event created offline needs a real id the moment
//      it exists, so it can be edited and deleted before it has ever been sent. POST must
//      therefore upsert on the supplied id — a retried create after a flaky response must
//      not produce a second row.
//   2. every row carries updated_at, epoch MILLISECONDS, monotonic per device. starts_at,
//      ends_at and a purchase's spent_at stay epoch SECONDS to match the seed and the schema;
//      util.toMs() papers over the difference for display so no view has to care.
//   3. a purchase POST must APPLY the body, not merely tolerate it. enqueue() folds a later
//      update into a pending create while KEEPING prev.op === "create", so a POST body can
//      legitimately carry post-creation edits. If the original POST landed and its response
//      was lost — a market stall, one bar of signal, the case this app exists for — an
//      `ON CONFLICT DO NOTHING` upsert would discard those edits and answer 200: the write
//      would appear to succeed and the amount would be wrong.
//
// THIS IS NOT LAST-WRITE-WINS, whatever updated_at looks like. Nothing compares it. The client
// sends it on every write and the API ignores it: packing.js's PATCH allowlist never reads it
// and stamps `updated_at = nowSec()` itself, events.js does the same, and replayQueue() below
// replays queued ops onto a fresh snapshot with no timestamp check either. The rule the system
// actually implements is LAST DEVICE TO RECONNECT WINS, which on a shared list is the opposite
// of what a four-day offline window wants: a three-day-old queued op flushing on reconnect
// silently reverts a decision somebody else made yesterday, with no conflict and no trace.
// Verified against the live API — a PATCH stamped three days in the past overwrote a newer one.
// Note also that the two sides do not even share units (client ms, server seconds), so a
// comparison added naively later would be wrong in both directions. Making this real needs the
// units unified AND a guard against a phone whose clock is wrong in the FUTURE direction —
// otherwise one skewed device wedges a shared row for the rest of the trip.

import { setUnits, toMs, uid } from "./util.js";
// The ONE implementation of the largest-remainder allocation, and the reason this file has no
// copy of it: share_minor's computation lives on the CLIENT and the check
// on the server, precisely so that a rounding rule exists once. addPurchase() and
// updatePurchase() recompute every share through it rather than trusting a caller, so the
// number the view shows and the number the settle-up reads came out of the same function.
// public/js/money.js is a pure module — no DOM, no imports back into the app — so
// scripts/split_math_check.mjs can test the real code under plain node.
import { allocate } from "./money.js";
// What the phone keeps and whose it is: see the file. Three things here lean on it.
//   1. A phone that was cleared (somebody signed out, in this tab or another) is never written
//      back to and never asked to send: phoneCleared().
//   2. What is stored belongs to one account. Before a row of it is read, the account of the
//      session is compared with it, and somebody else's data is removed first: ownerGate().
//   3. Until that comparison has an answer, nothing queued is sent: accountKnown.
import { forgetThisPhone, ownerVerdict, sessionAccount, watchEpoch } from "./forget.js";
// Which trip this page is, and the list of trips this phone keeps.
import { dbName, keptOwner, noteOpened, tripApi, tripIdFromPath } from "./trip-here.js";
// The one database a phone had before a trip had an address, moved into its trip's.
import { OLD_PACK, adoptOldPack, adoptOldStore } from "./trip-adopt.js";
// What that phone had not sent yet, turned from the old app's shapes into this one's.
import { OLD_MARK, translateOld } from "./old-queue.js";
import { PACKING_BAGS_MAX, PACKING_LISTS_MAX, PACKING_NAME_MAX } from "./shared/limits.js";
import { within } from "./net.js";
import { PACKING_ITEM_FIELDS, dayIn, isDay } from "./shared/trip-rules.js";
import { live } from "./live.js";
import { takeRows } from "./shared/delta.js";

// THE TRIP, from the address, once. "" on a page that names none (the app's own address "/",
// which only sends the person on: see index.html); nothing below runs for it, ready() refuses.
const TRIP = tripIdFromPath(typeof location === "undefined" ? "" : location.pathname);
/** The API address of something this trip holds: T() is the trip, T("/events") its events. */
const T = (rest = "") => tripApi(TRIP, rest);

// One database per trip, "wegoplace:<trip id>": its snapshot and its queue of unsent changes.
// DB_BASE alone is the single database a phone had before a trip had an address (trip-adopt.js).
const DB_BASE = "wegoplace";
// 2 (was 1): "purchases" joined ROWSTORES, and onupgradeneeded below is the ONLY place an
// object store is ever created. Without this bump a phone that already has the app never
// fires it, so `purchases` never exists, so hydrate()'s
// db.transaction([...ROWSTORES, "meta", "queue"]) throws NotFoundError synchronously, ready()
// rejects, index.html catches that and mounts an EMPTY app, and every later transaction
// throws too. Total offline data loss on upgrade, on exactly the phones this app exists for.
// The bump and the ROWSTORES line move together or not at all.
// 3 (was 2): "notes" left ROWSTORES (migration 0027: notes on plans are messages in the chat, kept
// by chat.js), and the upgrade below deletes its object store, so a phone keeps no second copy of
// them that nothing reads or clears.
// 4 (was 3): "references" joined ROWSTORES (migration 0048: the trip's reference list, js/references.js).
const DB_VERSION = 4;
const ROWSTORES = ["events", "places", "packing", "purchases", "references"];

// One place to change if the api role lands different paths.
// `me` is the odd one out and flush() knows it: it is a SINGLETON, not a collection, so its
// PATCH goes to the base path with no id appended. The row it writes is whoever holds the
// session cookie — see functions/api/me.js for why that is the security model and not a
// shortcut.
// A kind missing from here makes `WIRE[op.kind]` undefined, so flush() builds the path
// "undefined/<id>", the server 404s it, and flush() classifies that 4xx as a permanent refusal
// and DROPS the op. The write disappears with nothing but a console.warn and a toast.
const WIRE = TRIP ? {
  event: T("/events"), note: T("/messages"), packing: T("/packing"), me: "/api/me",
  purchase: T("/purchases"), place: T("/places"), reference: T("/references"),
} : {};

const HEARTBEAT_MS = 90_000;      // background pull while online and foregrounded
const RETRY_MS = [5_000, 15_000, 60_000];
const COLD_BOOT_WAIT_MS = 8_000;  // see ready()

// ── event emitter ───────────────────────────────────────────────────────────────────────
// "change" = the data changed. "status" = connectivity or the pending count changed.
// Deliberately separate: a network blip must not force every view to re-render and blow
// away a half-typed note.
// "gone" = the server said this trip was deleted, or this account is no longer on it.
// "told" = changes made in the app as it was before could not be carried over as they were
// written; the argument is every such case not yet seen (old-queue.js: oldLines() is their
// sentences). store.oldTold() is the same list at any time, until dismissOldTold().
const listeners = { change: new Set(), status: new Set(), reject: new Set(), gone: new Set(), told: new Set() };
function emit(name, arg) {
  for (const fn of listeners[name] || []) {
    try { fn(arg); } catch (e) { console.error(`[store] ${name} listener threw`, e); }
  }
}

// ── IndexedDB ───────────────────────────────────────────────────────────────────────────
let dbp = null;
function openDB() {
  if (dbp) return dbp;
  // No trip in the address: nothing to keep, and no name to keep it under.
  if (!TRIP) { dbp = Promise.resolve(null); return dbp; }
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(DB_BASE, TRIP), DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "k" });
      for (const s of ROWSTORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
      }
      // The queue is ordered by its autoincrement key and drained in that order, so a
      // create always reaches the server before the update that follows it.
      if (!db.objectStoreNames.contains("queue"))
        db.createObjectStore("queue", { keyPath: "seq", autoIncrement: true });
      // Notes live in the chat now (see DB_VERSION).
      if (db.objectStoreNames.contains("notes")) db.deleteObjectStore("notes");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => {
    // Private-mode Safari can refuse IndexedDB outright. The app still has to run: fall
    // back to memory only, which means no offline persistence but no white screen either.
    console.error("[store] IndexedDB unavailable, running memory-only", e);
    return null;
  });
  return dbp;
}

// True once this phone's stored data has been cleared since the page loaded. The page is on
// its way to the sign-in page by then; what matters is that nothing it still holds in memory
// reaches the databases or the server on the way out.
// startingOver: this tab cleared the phone itself (see startOver) and is about to reload into
// the app as the person who is signed in; only the writes stop.
let startingOver = false;
const phoneCleared = watchEpoch(() => { if (!startingOver) location.replace("/login"); });

/** The sign-in page, told to come back here: this trip, this section. */
function signInAddress() {
  return `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
}

async function tx(stores, mode, fn) {
  // Nothing is written back once the phone was cleared, or once the server has said this trip
  // is gone (its rows are being removed: see "a trip that is gone" in refresh()).
  if (mode === "readwrite" && (phoneCleared() || gone)) return null;
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    out = fn(t);
  });
}
const reqp = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// ── in-memory mirror ────────────────────────────────────────────────────────────────────
// Rows are frozen on the way in. `ev.title = "..."` from a view is a bug that would silently
// desync the cache from IndexedDB; frozen rows turn it into a throw at the call site.
const cache = {
  trip: null,
  me: null,
  // The trip roster. Not a ROWSTORE: it is a small, server-owned list that is only ever
  // replaced wholesale, so it rides in `meta` alongside trip and me. It carries note_color
  // and initials, which is what lets a sticky note render in its author's colour. Notes
  // ALSO denormalise those two fields onto every row — that is the copy that still works for
  // somebody who has left the trip — so this is the fallback, not the source of truth.
  //
  // It is now mutated in exactly ONE place: setNoteColor()'s optimistic apply, which is a
  // person recoloring themselves and having to see it land before the flush.
  members: [],
  // The trip's AREAS: its regions and the neighborhoods under them, each { id, name, parent,
  // west, south, east, north, sort }. A place points at one by id; public/js/areas.js reads
  // them for the words on a row and for the regions the map names. Nothing in the app edits
  // them, so they are server-owned and replaced wholesale, and ride `meta` like the roster.
  areas: [],
  appsAdding: [],
  // The trip's own offline map, as the snapshot says it (docs/API.md, "The trip's map"): null
  // for no map and none being made, else { state, version, bytes, at, source, note, glyphs,
  // ready }. map.js reads it (mapState()): `ready` is "there is an archive to read now",
  // `version` changes with each new map.
  tiles: null,
  // Whether this site makes maps at all (the snapshot's `maps`): true, false, or null while no
  // snapshot has said. A site with no map maker can't keep the promise "say where the trip is
  // and its map gets made", so the Map asks before it says that.
  maps: null,
  // The PALETTE of people's colors — [{ hex, name }], off the snapshot. Nobody's color: the ones
  // the server will accept, so the two pickers can draw themselves offline without this file
  // holding a second copy of a table PATCH /api/me validates against. Empty until the first
  // sync, and a picker with nothing to offer correctly draws nothing.
  noteColors: [],
  // The trip's SHORT LIST of currencies — ["PEN", "USD"] on one trip, not a scroll through
  // 180. Server-owned and replaced wholesale, so it rides `meta` next to members and the
  // palette rather than being a rowstore. GET /api/trip computes it as a UNION of the trip's
  // seeded list, every currency actually used on a purchase, and every member's native
  // currency — which is why there is no PATCH for it and no screen that can configure it
  // wrong: paying for one thing in EUR puts EUR in the list by construction.
  currencies: [],
  // The cached exchange table, USD-based: fx.rates[X] is how many X one USD buys, so USD
  // itself is 1 and is not in the map. fetched_at === 0 means "never fetched", which is a real
  // answer the settle-up has to render honestly (per-currency totals, which need no rate at
  // all) rather than papering over with a zero. No rate is ever written onto a purchase —
  // Intentional trade-off: the amount stays stored AS PAID.
  fx: fxOf(null),
  // What packing is built from besides the items: the trip's lists with their bags, the bag
  // each item sits in on each list, what is ticked, and the trip's suggested items. See
  // "packing: lists, bags, ticks" below.
  pack: emptyPack(),
  events: new Map(),
  places: new Map(),
  packing: new Map(),
  purchases: new Map(),
  // The trip's reference list (migration 0048, js/references.js): notes the group needs at hand, of no day or place.
  references: new Map(),
  // How many of the chat's messages are about each thing, off the snapshot: { event, place,
  // purchase, before } (src/api/messages.js messageCounts). The Agenda says it on each plan.
  chat: { event: {}, place: {}, purchase: {}, before: {}, before_recent: {} },
};
let queue = [];                   // pending writes, ordered by seq
let clock = 0;                    // monotonic updated_at source
let lastSync = 0;
// SINCE MY LAST (GET the trip ?since=, migration 0036). `held` is the rev and data_rev of what this phone
// holds, kept with it; a pull asks for what changed after that rev. `wholeNext` asks for the whole trip
// instead: until a first one has landed, and after a write the server refused and this phone dropped (its
// optimistic row is in what's held, and only a whole answer takes it out). Both kept in meta.
let held = null;
let wholeNext = true;
let lastPullAt = 0;
const PULL_ANYWAY_MS = 15 * 60_000;   // a pull at least this often, for what moves without the trip's rev (rates, storage)
let netOk = true;                 // observed reachability, not navigator.onLine
let readyP = null;

// Both halves or neither: a key added here and not cleared in invalidate() serves a stale
// array for the whole session, and every screen reading it quietly stops updating.
const sortedCache = { events: null, places: null, purchases: null, references: null };
function invalidate() { sortedCache.events = null; sortedCache.places = null; sortedCache.purchases = null; sortedCache.references = null; }

/**
 * Object.freeze is SHALLOW and a purchase carries a `shares` ARRAY, so freezing the row alone
 * hands every view a mutable child — `row.shares[0].share_minor = 1` or `row.shares.push(…)`
 * from a view would succeed and the mirror would quietly stop matching IndexedDB, which is
 * precisely the class of bug freezing rows exists to turn into a throw at the call site.
 * Deep enough for the shape we actually store: scalars, plus one array of scalar-only objects.
 *
 * In place, not a copy. The queue's fold REPLACES a payload's array wholesale
 * ({ ...prev.payload, ...op.payload }) and never mutates one, so freezing an array that a
 * queue op also references cannot break the fold.
 *
 * It must be used at EVERY row-entry site — put(), hydrate(), applySnapshot() and BOTH
 * replayQueue() branches. Missing the replay branches would mean a row is correctly frozen
 * until you edit it offline and mutable afterwards, which is the worst version of this bug
 * because it only appears on the trail.
 */
function freezeRow(row) {
  if (row && Array.isArray(row.shares)) {
    for (const s of row.shares) Object.freeze(s);
    Object.freeze(row.shares);
  }
  return Object.freeze(row);
}

/**
 * The exchange table, normalised and frozen on the way in — from a snapshot, from IndexedDB,
 * or from POST /api/fx/refresh. Three call sites, one shape, so no caller has to defend
 * against a half-written table: a missing `rates` becomes {} and a never-fetched table is
 * `fetched_at: 0`, which the settle-up renders as "no rates yet" rather than as zero money.
 *
 * Frozen for the same reason rows are: fx() hands the same object to every screen, and
 * `fx.rates.PEN = 4` from a view would desync the mirror from IndexedDB silently. Frozen, it
 * throws where it is written.
 */
function fxOf(v) {
  const src = v && typeof v === "object" ? v : {};
  const rates = src.rates && typeof src.rates === "object" ? { ...src.rates } : {};
  return Object.freeze({
    base: src.base || "USD",
    rates: Object.freeze(rates),
    fetched_at: src.fetched_at || 0,
    next_at: src.next_at || 0,
  });
}

function put(kind, row) {
  cache[kind].set(row.id, freezeRow(row));
  invalidate();
}
function drop(kind, id) { cache[kind].delete(id); invalidate(); }

// ── monotonic clock ─────────────────────────────────────────────────────────────────────
// Last-write-wins is only correct if a device's own stamps never go backwards. Phone clocks
// do go backwards — NTP corrections, timezone-crossing flights, a manual fix at 4000 m. So
// take max(wall clock, last + 1) and persist the high-water mark across launches.
function stamp() {
  const t = Math.max(Date.now(), clock + 1);
  clock = t;
  setMeta("clock", t);            // fire and forget; a lost write only costs 1 ms of skew
  return t;
}

async function setMeta(k, v) {
  try { await tx(["meta"], "readwrite", (t) => t.objectStore("meta").put({ k, v })); }
  catch (e) { console.warn("[store] meta write failed", k, e); }
}

// A screen's own copy of something it read from the server and keeps for when there is no
// signal (the trip's list of changes): in this trip's database, so it goes with the trip and
// with the person, under "aside:<name>". hydrate() leaves these keys alone; the screen reads
// its own when it mounts.
async function readAside(name) {
  try { return (await tx(["meta"], "readonly", (t) => reqp(t.objectStore("meta").get(`aside:${name}`))))?.v ?? null; }
  catch { return null; }
}
const keepAside = (name, v) => setMeta(`aside:${name}`, v);

// ── HTTP ────────────────────────────────────────────────────────────────────────────────
// Every request is given up at net.js's limit (12 s a read, 20 s a write, to the end of its
// body), and one given up is no signal: the pill says Offline, the write stays queued, and the
// retries carry on.
//
// Returns { ok, status, body } and never throws for an HTTP status — callers need to tell
// "the server said no" (drop the write) from "the radio is off" (keep it) and an exception
// erases that distinction.
async function req(method, path, body) {
  // The same answer a signed-out request gets, and for the same reason it is not a refusal:
  // nothing is dropped from the queue on the strength of it.
  if (phoneCleared()) return { ok: false, status: 401, body: null };
  const init = {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    cache: "no-store",
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return within(method, (signal) => answer(path, { ...init, signal }));
}

async function answer(path, init) {
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    setNet(false);
    return { ok: false, status: 0, body: null, offline: true };
  }
  setNet(true);
  // The middleware 401s any API request without a session. Only bounce to login on a real
  // response — doing it on a network error would throw the user out of a working offline app.
  if (res.status === 401) {
    location.replace(signInAddress());
    return { ok: false, status: 401, body: null };
  }
  // PROVE THE ANSWER CAME FROM THE API. A hotel captive portal returns a genuine 200
  // text/html for every request: res.ok is true, res.json() throws, and reporting ok here
  // would make flush() delete the op from the durable queue for a write the server never saw
  // — silently, since the optimistic row stays on screen. Every route in functions/api/*
  // answers application/json (the 401 above is the one text/plain case, and it has already
  // returned), so a non-JSON body means we are talking to something that is not the API.
  // Treat that as "the radio is not really back": keep the op, do not advance lastSync.
  // sw.js's typeOk() defends the CACHE against exactly this; this is the queue's copy.
  const ct = res.headers.get("Content-Type") || "";
  const emptyBody = res.status === 204 || res.headers.get("Content-Length") === "0";
  if (!ct.includes("json") && !emptyBody) {
    setNet(false);
    return { ok: false, status: 0, body: null, offline: true };
  }
  let parsed = null;
  try { parsed = await res.json(); } catch { /* a legitimately empty body — see emptyBody */ }
  // A JSON content-type with a body that did not parse is a truncated or rewritten response,
  // not an accepted write. Same treatment: transient, keep the op.
  if (res.ok && !emptyBody && parsed === null) {
    setNet(false);
    return { ok: false, status: 0, body: null, offline: true };
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

function setNet(ok) {
  if (netOk === ok) return;
  netOk = ok;
  emit("status", status());
}

// navigator.onLine only reports whether an interface is up. In the mountains it says true on a
// bar of signal that carries nothing, and inside a hotel captive portal. Trust an actual
// completed request instead, and let navigator.onLine === false be the one thing that can
// short-circuit to "definitely not".
function isOnline() { return navigator.onLine !== false && netOk; }
// The shell's sync line pulses on `pending || syncing`: pending covers the ordinary case, because an
// op leaves the queue only after a 2xx, and syncing covers the tail — the moment between
// the last op being accepted and the flush's `finally` firing. A background refresh
// deliberately does NOT light it: nothing of the user's is in flight during a read, and a
// line that blinks by itself every minute would be visual noise.
function status() {
  return { online: isOnline(), pending: waitingCount(), lastSync, syncing: flushing };
}

// ── whose data this is ──────────────────────────────────────────────────────────────────
// Everything on the phone was stored for one account: the one in meta "me". A session can
// end without anybody pressing Sign out (it expires, the cookie is cleared), and that clears
// nothing, so the same person can sign back in and have their waiting changes sent. But the
// next session may be somebody else's. They must not be shown the first person's trip or
// kit list, and their first sync must not carry the first person's queued writes under
// their name. Those writes are lost in that case; nobody else may send them.
//
// accountKnown: the stored data is known to belong to the session's account. Nothing is
// flushed until it is true. It becomes true at boot when the server's readable cookie names
// the stored owner (or nothing is stored), and otherwise on the first answer from /api/me.
let accountKnown = false;

async function storedOwner() {
  try {
    const me = await tx(["meta"], "readonly", (t) => reqp(t.objectStore("meta").get("me")));
    const row = await me;
    return (row && row.v && row.v.id) || "";
  } catch { return ""; }
}

/** Somebody else's data is on this phone: remove all of it and start again, empty. Never returns. */
async function startOver() {
  startingOver = true;
  await forgetThisPhone();
  location.reload();
  await new Promise(() => {});
}

async function ownerGate() {
  const account = sessionAccount();
  // Two things on the phone say whose it is: this trip's database, and the list of trips the
  // phone keeps (a person's OTHER trips are in databases this page never opens). Either one
  // naming somebody else means somebody else's things are here.
  if (ownerVerdict(keptOwner(), account) === "other") await startOver();
  const verdict = ownerVerdict(await storedOwner(), account);
  if (verdict === "other") await startOver();
  accountKnown = verdict === "same";
}

// ── the phone keeps this trip ───────────────────────────────────────────────────────────
// Written before the trip's database is, so signing out can always find that database
// (forget.js reads the list), and again whenever the trip's name or the account becomes known.
let keptAs = "";
function keepHere() {
  const who = (cache.me && cache.me.id) || sessionAccount() || "";
  const name = (cache.trip && cache.trip.name) || "";
  const as = `${who}\n${name}`;
  if (as === keptAs) return;
  keptAs = as;
  if (!phoneCleared()) noteOpened(TRIP, { who, name });
}

// ── the database from before a trip had an address ──────────────────────────────────────
// See trip-adopt.js. Before the owner gate: what it moves carries its owner with it (meta
// "me"), and the gate then judges it like anything else stored here.
async function adoptOld() {
  const db = await openDB();
  if (!db) return;
  try {
    const got = await adoptOldStore(db, TRIP);
    if (got.moved) console.info(`[store] moved the stored trip into its own database (${got.rows} rows, ${got.waiting} waiting)`);
    const packed = await adoptOldPack(db, TRIP);
    if (packed) console.info(`[store] brought the old packing screen's unsent changes (${packed})`);
  } catch (e) {
    // The old database is whole (the copy is one transaction). The trip opens from the server
    // if there is signal, and the move is tried again on the next load.
    console.error("[store] could not move the stored trip", e);
  }
}

// ── hydrate ─────────────────────────────────────────────────────────────────────────────
async function hydrate() {
  const db = await openDB();
  if (!db) return;
  await tx([...ROWSTORES, "meta", "queue"], "readonly", (t) => {
    for (const s of ROWSTORES) {
      t.objectStore(s).getAll().onsuccess = (e) => {
        for (const row of e.target.result) cache[s].set(row.id, freezeRow(row));
      };
    }
    t.objectStore("queue").getAll().onsuccess = (e) => { queue = e.target.result || []; };
    t.objectStore("meta").getAll().onsuccess = (e) => {
      for (const { k, v } of e.target.result) {
        if (k === "trip") cache.trip = v;
        else if (k === "me") { cache.me = v; setUnits(v && v.units); }
        else if (k === "members") cache.members = Array.isArray(v) ? v : [];
        else if (k === "areas") cache.areas = Array.isArray(v) ? v : [];
        else if (k === "apps_adding") cache.appsAdding = Array.isArray(v) ? v : [];
        else if (k === "tiles") cache.tiles = v && typeof v === "object" ? v : null;
        else if (k === "maps") cache.maps = typeof v === "boolean" ? v : null;
        else if (k === "note_colors") cache.noteColors = Array.isArray(v) ? v : [];
        else if (k === "currencies") cache.currencies = Array.isArray(v) ? v : [];
        else if (k === "chat") cache.chat = chatOf(v);
        else if (k === "fx") cache.fx = fxOf(v);
        else if (k === "chat_muted") cache.chatMuted = v === null ? null : !!v;
        else if (k === "pack") cache.pack = packFromRecord(v);
        else if (k === OLD_PACK) oldPack = v && typeof v === "object" ? v : null;
        else if (k === OLD_TOLD) oldTold = Array.isArray(v) ? v : [];
        else if (k === "clock") clock = v || 0;
        else if (k === "last_sync") lastSync = v || 0;
        else if (k === "held") held = v && Number.isInteger(v.rev) ? v : null;
        else if (k === "whole_next") wholeNext = v !== false;
      }
    };
  });
  invalidate();
  // The queue was persisted but the mirror was persisted post-rebase; replaying is
  // idempotent (put / merge / delete), so do it again rather than reason about which
  // launch wrote what.
  replayQueue();
  // Baseline for the change dedup, taken AFTER the replay so it describes exactly what the
  // first render will show. Without it the first background refresh always looks like a
  // change, which would cause a wasted repaint on launch on the screen
  // people actually look at — the agenda, on wake, with its photographs.
  lastSig = signature();
}

// ── snapshot + rebase ───────────────────────────────────────────────────────────────────
// Server truth lands wholesale, then every unflushed local write is replayed on top. Without
// this replay a queued delete resurrects its row on the very next refresh, which looks
// exactly like the app losing your edits.
// ── what the phone had not sent when the app changed under it ───────────────────────────
// trip-adopt.js brings the old app's unsent changes over marked OLD_MARK, and the old packing
// screen's as the record OLD_PACK. They are in that app's shapes, so NONE of them is sent
// until old-queue.js has turned them into this app's, and that needs the trip's lists as the
// server has them now: it happens once, right after the first snapshot lands (refresh()), in
// one transaction. flush() waits for it. A phone with no signal keeps them as they are.
let oldPack = null;
const OLD_TOLD = "old-told";           // meta: old-queue.js cases said and not yet seen
let oldTold = [];
const fromOld = () => !!oldPack || queue.some((q) => q.from === OLD_MARK);
// How many changes wait: the queue, and the old packing screen's that have not joined it yet.
const waitingCount = () => queue.length + (oldPack && Array.isArray(oldPack.queue) ? oldPack.queue.length : 0);

// What a carried change is about, in the person's words: kept on the change so a refusal can
// name it (flush()). A new thing's name is in the change; a changed or removed one's is the
// name the trip has for it now, read from the snapshot as the server sent it (`raw`), because
// in the cache the waiting change has already been applied (a removed thing is not there).
function carriedLabel(op, raw) {
  if (op.kind === "me") return "";
  const p = op.payload || {};
  const nameOf = (r) => (r ? r.title || r.description || r.label || r.name || r.body || "" : "");
  const rows = !ownsNoRow(op.kind) && raw && Array.isArray(raw[storeOf(op.kind)]) ? raw[storeOf(op.kind)] : [];
  const row = rows.find((r) => r && r.id === op.id) || null;
  const text = op.op === "create" ? nameOf(p) : nameOf(row) || nameOf(p);
  return String(text).replace(/\s+/g, " ").trim().slice(0, 80);
}

async function translateOldNow(raw) {
  const marked = queue.filter((q) => q.from === OLD_MARK);
  let result;
  try {
    result = translateOld({
      ops: marked, old: oldPack, lists: cache.pack.lists, placements: cache.pack.placements,
      item: (id) => cache.packing.get(id) || null, makeKey: packKey, now: Date.now(),
    });
  } catch (e) {
    // Never a queue held for good behind this: they go as they were written, the server says
    // what it can't take, and the person is told the packing ones didn't come over.
    console.error("[store] could not carry the old app's changes over as this app's", e);
    result = { ops: marked.map(({ from, seq, ...op }) => op), told: oldPack ? [{ case: "failed" }] : [] };
  }
  const gone = new Set(marked.map((q) => q.seq));
  const fresh = result.ops.map((op) => ({ ...op, carried: { label: carriedLabel(op, raw) } }));
  const say = [...oldTold, ...result.told];
  const done = await tx(["queue", "meta"], "readwrite", (t) => {
    const os = t.objectStore("queue");
    for (const s of gone) os.delete(s);
    for (const op of fresh) { const r = os.add(op); r.onsuccess = () => { op.seq = r.result; }; }
    t.objectStore("meta").delete(OLD_PACK);
    // What is said about them is kept until the person has seen it (dismissOldTold): the
    // message must outlive a reload, because it is said once.
    if (say.length) t.objectStore("meta").put({ k: OLD_TOLD, v: say });
    return true;
  }).catch((e) => { console.error("[store] could not store the carried-over changes", e); return false; });
  // Not stored (the database refused): nothing changed, and the next snapshot tries again.
  if (!done) return;
  queue = [...queue.filter((q) => !gone.has(q.seq)), ...fresh].sort((a, b) => a.seq - b.seq);
  oldPack = null;
  oldTold = say;
  replayQueue();
  setMeta("pack", packRecord());
  if (result.told.length) emit("told", oldTold.slice());
  emit("status", status());
}

// A carried change the trip refused (flush()): it joins what is said until tapped.
async function tellRefused(list) {
  const more = list.map(({ op, status }) => ({ case: "refused", kind: op.kind, op: op.op, label: (op.carried && op.carried.label) || "", status }));
  oldTold = [...oldTold, ...more];
  await tx(["meta"], "readwrite", (t) => { t.objectStore("meta").put({ k: OLD_TOLD, v: oldTold }); }).catch(() => {});
  emit("told", oldTold.slice());
}

/** The person has seen what was said about the changes that were not carried over. */
async function dismissOldTold() {
  oldTold = [];
  await tx(["meta"], "readwrite", (t) => { t.objectStore("meta").delete(OLD_TOLD); }).catch(() => {});
}

function applySnapshot(snap) {
  // This page is one trip. An answer about another one (it cannot happen while the address
  // names the trip, and must not matter if it ever does) is not applied.
  if (snap.trip && snap.trip.id !== TRIP) { console.error("[store] a snapshot of another trip, ignored", snap.trip.id); return; }
  if (snap.trip) cache.trip = snap.trip;
  if (Array.isArray(snap.members)) {
    cache.members = snap.members;
    if (cache.me && cache.me.id) {
      const mine = cache.members.find((m) => m && m.id === cache.me.id);
      if (mine) {
        cache.me = Object.freeze({
          ...cache.me,
          note_color: mine.note_color ?? cache.me.note_color ?? null,
          initials: mine.initials ?? cache.me.initials ?? null,
          avatar: "avatar" in mine ? (mine.avatar ?? null) : (cache.me.avatar ?? null),
        });
      }
    }
  }
  if (Array.isArray(snap.areas)) cache.areas = snap.areas;
  cache.appsAdding = Array.isArray(snap.apps_adding) ? snap.apps_adding : [];
  // Present and null is an answer ("this trip has no map"); absent is "unchanged".
  if ("tiles" in snap) cache.tiles = snap.tiles && typeof snap.tiles === "object" ? snap.tiles : null;
  if (typeof snap.maps === "boolean") cache.maps = snap.maps;
  if (Array.isArray(snap.note_colors)) cache.noteColors = snap.note_colors;
  if (Array.isArray(snap.currencies)) cache.currencies = snap.currencies;
  if (snap.fx) cache.fx = fxOf(snap.fx);
  if (snap.chat && snap.chat.about) cache.chat = chatOf(snap.chat.about);
  // Whether this person muted the trip's chat (no notifications from it): the snapshot's, kept.
  if (snap.chat && typeof snap.chat === "object" && "muted" in snap.chat) cache.chatMuted = !!snap.chat.muted;
  // Each of the four on its own, by the same rule as the rowstores below: absent means
  // "unchanged", not "empty".
  if (Array.isArray(snap.packing_lists)) cache.pack.lists = listsOf(snap.packing_lists);
  if (Array.isArray(snap.packing_placements)) {
    cache.pack.placements = new Map(snap.packing_placements.map((p) => [placeKey(p.item_id, p.list_key), p.bag_key]));
  }
  if (Array.isArray(snap.packing_ticks)) {
    cache.pack.ticks = new Set(snap.packing_ticks.map((t) => tickKey(t.item_id, t.list_key, t.day)));
  }
  if (Array.isArray(snap.packing_starters)) cache.pack.starters = startersOf(snap.packing_starters);
  // An absent collection means "unchanged", not "empty"; a delta's rows are merged (public/js/shared/delta.js).
  for (const s of ROWSTORES) takeRows(cache[s], snap[s], { delta: snap.delta === true, gone: snap.gone?.[s], keep: freezeRow });
  if (Number.isInteger(snap.rev)) held = { rev: snap.rev, data_rev: snap.data_rev ?? null };
  snapshots += 1;
  invalidate();
  replayQueue();
}

// ── packing: lists, bags, ticks ─────────────────────────────────────────────────────────
// A trip's packing is its items (a rowstore, like events) seen through the TRIP's lists. A
// list has bags. An item has one bag on a list, or none ("not carried"). A tick belongs to an
// item on a list, and on a list for the day to that day as well. Lists and bags are the whole
// trip's: one person's rename is everyone's.
//
// None of the four is a rowstore. They are small, they arrive whole in every snapshot, and a
// write to one is an EFFECT on the set rather than a row to adopt (a tick has no id, a bag
// lives inside its list). So they are kept as one record, and their queued writes are replayed
// by effect, the way `me` is.
//
// What is kept is only what a screen reads: no rev, no created_at, nobody's name on a tick.
// That makes a write made here equal, byte for byte, to the server's copy of it, so the
// snapshot that confirms a tick does not repaint the list it was made on.
const SEP = "\u0000";                 // no id and no key can hold it
const placeKey = (item, list) => `${item}${SEP}${list}`;
const tickKey = (item, list, day) => `${item}${SEP}${list}${SEP}${day || ""}`;
const PACK_KINDS = ["pack-tick", "pack-place", "pack-list", "pack-bag"];
const isPackKind = (kind) => PACK_KINDS.includes(kind);
// A note waiting from before notes moved into the chat (made by this app before it was updated,
// or carried over from the old one): sent as a message about its plan (wireOf), and owning no row
// here. Nothing writes one now.
const ownsNoRow = (kind) => isPackKind(kind) || kind === "note";
let snapshots = 0;                    // how many have landed; see commit()

function emptyPack() {
  return { lists: Object.freeze([]), placements: new Map(), ticks: new Set(), starters: Object.freeze([]) };
}
// The server's order, (sort, key). Keys are plain ASCII, so comparing them as strings here
// puts two bags with the same sort in the order the database does.
const bySort = (a, b) => (a.sort || 0) - (b.sort || 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const bagOf = (b) => Object.freeze({ key: String(b.key), name: String(b.name || ""), sort: b.sort || 0 });
function listOf(l) {
  return Object.freeze({
    key: String(l.key),
    name: String(l.name || ""),
    sort: l.sort || 0,
    repeat: l.repeat === "daily" ? "daily" : "once",
    dates: Array.isArray(l.dates) && l.dates.length ? Object.freeze(l.dates.slice()) : null,
    bags: Object.freeze((Array.isArray(l.bags) ? l.bags : []).filter((b) => b && b.key != null).map(bagOf).sort(bySort)),
  });
}
const listsOf = (v) => Object.freeze(
  (Array.isArray(v) ? v : []).filter((l) => l && l.key != null).map(listOf).sort(bySort));
const startersOf = (v) => Object.freeze((Array.isArray(v) ? v : []).filter((x) => x && x.label).map((x) => Object.freeze({
  id: String(x.id || ""),
  scope: x.scope === "group" ? "group" : "person",
  label: String(x.label),
  category: x.category || "misc",
  note: x.note || "",
  qty: x.qty ?? null,
  bags: Object.freeze({ ...(x.bags && typeof x.bags === "object" ? x.bags : {}) }),
  sort: x.sort || 0,
})));

// To IndexedDB and back. A Map and a Set do survive structuredClone, but the record is read
// by people too (DevTools on a phone that will not sync), and two plain arrays say what they
// hold.
const packRecord = () => ({
  lists: cache.pack.lists,
  placements: [...cache.pack.placements],
  ticks: [...cache.pack.ticks],
  starters: cache.pack.starters,
});
function packFromRecord(v) {
  const src = v && typeof v === "object" ? v : {};
  return {
    lists: listsOf(src.lists),
    placements: new Map(Array.isArray(src.placements) ? src.placements : []),
    ticks: new Set(Array.isArray(src.ticks) ? src.ticks : []),
    starters: startersOf(src.starters),
  };
}

function packForgetTicks(itemId, listKey) {
  const head = `${placeKey(itemId, listKey)}${SEP}`;
  for (const k of cache.pack.ticks) if (k.startsWith(head)) cache.pack.ticks.delete(k);
}
// An item that is gone takes its bags and its ticks with it, as it does on the server.
function packForgetItem(itemId) {
  const head = `${itemId}${SEP}`;
  for (const k of cache.pack.placements.keys()) if (k.startsWith(head)) cache.pack.placements.delete(k);
  for (const k of cache.pack.ticks) if (k.startsWith(head)) cache.pack.ticks.delete(k);
}
function packPlaceAll(itemId, bags) {
  for (const [list, bag] of Object.entries(bags || {})) {
    if (bag) cache.pack.placements.set(placeKey(itemId, list), bag);
  }
}

/**
 * One packing write's effect on what the phone shows. Called when the write is made and
 * again from replayQueue() over every snapshot until the server has taken it, so it must give
 * the same result however many times it runs, and must not mind the thing it names being gone
 * (a bag renamed here and removed on another phone renames nothing).
 */
function packApply(op) {
  const pack = cache.pack;
  const p = op.payload || {};
  if (op.kind === "pack-tick") {
    const k = tickKey(p.item_id, p.list_key, p.day);
    if (p.ticked) pack.ticks.add(k); else pack.ticks.delete(k);
    return;
  }
  if (op.kind === "pack-place") {
    if (p.bag_key) { pack.placements.set(placeKey(p.item_id, p.list_key), p.bag_key); return; }
    // Off the list: its ticks there go too, which is what the server does with them.
    pack.placements.delete(placeKey(p.item_id, p.list_key));
    packForgetTicks(p.item_id, p.list_key);
    return;
  }
  if (op.kind === "pack-list") {
    const cur = pack.lists.find((l) => l.key === op.id);
    const rest = pack.lists.filter((l) => l.key !== op.id);
    if (op.op === "delete") { pack.lists = listsOf(rest); return; }
    if (!cur && op.op !== "create") return;
    // The bags come from the list as it stands; a create that has not been sent yet is the
    // only write that brings its own.
    pack.lists = listsOf([...rest, {
      ...(cur || { repeat: "once", dates: null }), ...p, key: op.id, bags: cur ? cur.bags : p.bags,
    }]);
    return;
  }
  if (op.kind === "pack-bag") {
    const list = pack.lists.find((l) => l.key === p.list_key);
    if (!list) return;
    const cur = list.bags.find((b) => b.key === p.key);
    const bags = list.bags.filter((b) => b.key !== p.key);
    if (op.op !== "delete") {
      if (!cur && op.op !== "create") return;
      bags.push({ ...(cur || {}), ...p });
    }
    pack.lists = listsOf(pack.lists.map((l) => (l === list ? { ...l, bags } : l)));
  }
}

function replayQueue() {
  for (const op of queue) {
    // The singleton (WIRE.me). It owns no row in any ROWSTORE — it patches the signed-in
    // user — so it is replayed by re-applying its EFFECT rather than by merging into
    // cache[kind]. Without this branch a colour changed on the trail is undone by every
    // snapshot that lands before the queue drains, which on this trip is every one of them.
    if (op.kind === "me") {
      // BOTH fields, independently. They fold into one PATCH but they are two separate
      // effects, and replaying only the colour let a snapshot undo an initials edit made
      // offline — the same bug the colour branch was written to stop, one field over.
      if (op.payload && op.payload.note_color) applyNoteColor(op.id, op.payload.note_color);
      if (op.payload && op.payload.initials) applyInitials(op.id, op.payload.initials);
      if (op.payload && op.payload.tab_layout) applyMe({ tab_layout: op.payload.tab_layout });
      // A THIRD independent line, not a branch off the other two. The comment above records
      // that replaying only the colour let a snapshot undo an initials edit made offline;
      // replaying the currency conditionally on either of them would be the same bug a third
      // time, and it would show up as "the totals went back to dollars overnight".
      if (op.payload && op.payload.native_currency) applyNativeCurrency(op.id, op.payload.native_currency);
      continue;
    }
    // Lists, bags, placements and ticks own no row either. Same reason, same shape of fix.
    if (isPackKind(op.kind)) { packApply(op); continue; }
    if (op.kind === "note") continue;
    const kind = storeOf(op.kind);
    if (op.op === "delete") {
      cache[kind].delete(op.id);
      if (op.kind === "packing") packForgetItem(op.id);
      continue;
    }
    if (op.op === "create") {
      // A new packing item goes out with the bags it starts in (`bags`, one request instead
      // of one per list). They are placements, not a column, so they never reach the row.
      const { bags, ...row } = op.payload;
      // A place goes out as the few fields its form has; the row on screen is that over the
      // values the server gives every new place (placeRow).
      cache[kind].set(op.id, freezeRow(op.kind === "packing" ? row : op.kind === "place" ? placeRow(op.id, op.payload) : { ...op.payload }));
      if (op.kind === "packing") packPlaceAll(op.id, bags);
      continue;
    }
    const cur = cache[kind].get(op.id);
    if (cur) cache[kind].set(op.id, freezeRow({ ...cur, ...op.payload }));
  }
  invalidate();
}

// THE DEFAULT BRANCH IS "packing", so a kind that is not named here does not throw — commit(),
// replayQueue() and flush()'s adopt all file its rows into the packing Map instead, where they
// surface as ghost rows on the Pack screen. Every new kind gets an explicit arm. The kinds in
// PACK_KINDS never come here: they own no row, and each caller turns them away first.
const storeOf = (kind) =>
  (kind === "event" ? "events"
    : kind === "purchase" ? "purchases"
      : kind === "place" ? "places"
        : kind === "reference" ? "references"
          : "packing");

// ── change dedup ────────────────────────────────────────────────────────────────────────
// Background sync must not cause random full re-renders or image flicker while idle;
// never repaint unchanged screens.
//
// THE BUG, precisely: refresh() emitted "change" every time the snapshot came back, whether
// or not a byte of it had moved. Every mounted module re-renders on "change" — which means
// every <img src> in the agenda is re-created, and a re-created <img> repaints from the
// cache with a visible blink. On an idle phone that is a screen flickering by itself every
// sixty seconds for no reason at all. Nothing was wrong with the modules; they were being
// told, truthfully, that the store had refreshed, and inferring that the data was new.
//
// THE FIX lives here rather than in each view, so that every screen gets it once and no
// future screen has to remember to. Serialise the cache, hash it, and only emit when the
// hash actually moved.
//
// What is hashed is the RESULT — post-snapshot, post-replayQueue — not the wire payload.
// That is deliberate: the thing a listener re-renders from is the cache, so the cache is
// what has to be compared. It also makes the check correct when the queue changes without
// the server changing (a local write flushing, an op being dropped), which a payload hash
// would miss.
//
// Ids are sorted before hashing so that the API returning the same rows in a different
// order is not mistaken for an edit. Two independent 32-bit hashes plus the byte length are
// concatenated per collection: a single 32-bit hash collides once in 4 billion, which over
// a nine-day trip is unlikely but would present as a screen that silently stops updating,
// and that is not a failure worth saving twenty microseconds for.
function hashPair(str) {
  let a = 0x811c9dc5;              // FNV-1a
  let b = 5381;                    // djb2
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = (Math.imul(b, 33) ^ c) >>> 0;
  }
  return `${str.length}.${(a >>> 0).toString(36)}.${b.toString(36)}`;
}

function signature() {
  const parts = [
    hashPair(JSON.stringify(cache.trip || null)),
    hashPair(JSON.stringify(cache.me || null)),
    hashPair(JSON.stringify(cache.members || [])),
    // The areas and the map's state, for the reason the palette is in here (below): a
    // snapshot whose only news is a new area, or a map that has just been cut, has to repaint
    // the screens that show them and has to reach IndexedDB.
    hashPair(JSON.stringify(cache.areas || [])),
    hashPair(JSON.stringify(cache.appsAdding || [])),
    hashPair(JSON.stringify(cache.tiles || null)),
    hashPair(String(cache.maps)),
    // The palette is in here for a reason that is not repainting: a snapshot whose ONLY new
    // content is note_colors — which is every snapshot on the launch after this build ships
    // — would otherwise hash equal, skip persistAll(), and leave the picker's own table out
    // of IndexedDB. Correct on wifi, empty on the first cold offline launch.
    hashPair(JSON.stringify(cache.noteColors || [])),
    // Both money singletons are in here for exactly that reason, one field over. A snapshot
    // whose only new content is `fx` — which is every snapshot for the first day after this
    // ships — would otherwise hash equal, emitChange() would return false, persistAll() would
    // be SKIPPED, and the rates would be correct on wifi and MISSING on the first cold offline
    // launch: the settle-up's totals gone at exactly the moment there is no way to fetch them.
    //
    // The trade this buys is a real one and it is the right way round: fx.fetched_at is inside
    // the hash, so a genuine rate refresh repaints every mounted screen. The provider updates
    // about daily and next_at is respected, so that is roughly once a day — the correct price
    // for the rate age being truthful offline. A short fixed TTL would not be.
    hashPair(JSON.stringify(cache.currencies || [])),
    hashPair(JSON.stringify(cache.chatMuted ?? null)),
    hashPair(JSON.stringify(cache.fx || null)),
    // Packing's lists, placements and ticks. In here for the repaint (a tick made on another
    // phone has to redraw this one) and for the reason the palette is: a snapshot whose only
    // news is a new bag must still reach IndexedDB. Sorted, so the server answering the same
    // ticks in another order is not an edit.
    hashPair(JSON.stringify(cache.pack.lists)),
    hashPair([...cache.pack.placements].map(([k, bag]) => `${k}${SEP}${bag}`).sort().join("\n")),
    hashPair([...cache.pack.ticks].sort().join("\n")),
    hashPair(JSON.stringify(cache.pack.starters)),
  ];
  for (const s of ROWSTORES) {
    const ids = [...cache[s].keys()].sort();
    let acc = "";
    for (const id of ids) acc += JSON.stringify(cache[s].get(id));
    parts.push(`${s}:${hashPair(acc)}`);
  }
  return parts.join("|");
}

let lastSig = null;

/**
 * Emit "change" only if the cache differs from what listeners were last shown.
 * EVERY path that used to call emit("change") goes through this — not just refresh().
 * A local write that emits directly would leave lastSig stale, and the next background
 * refresh would then compare against a snapshot of the world from before that write.
 * Returns true if it emitted.
 */
function emitChange() {
  const sig = signature();
  if (sig === lastSig) return false;
  lastSig = sig;
  emit("change");
  return true;
}

async function persistAll() {
  try {
    await tx([...ROWSTORES, "meta"], "readwrite", (t) => {
      for (const s of ROWSTORES) {
        const os = t.objectStore(s);
        os.clear();
        for (const row of cache[s].values()) os.put(row);
      }
      const meta = t.objectStore("meta");
      if (cache.trip) meta.put({ k: "trip", v: cache.trip });
      if (cache.me) meta.put({ k: "me", v: cache.me });
      meta.put({ k: "members", v: cache.members });
      meta.put({ k: "areas", v: cache.areas });
      meta.put({ k: "apps_adding", v: cache.appsAdding });
      meta.put({ k: "tiles", v: cache.tiles });
      meta.put({ k: "maps", v: cache.maps });
      meta.put({ k: "note_colors", v: cache.noteColors });
      meta.put({ k: "currencies", v: cache.currencies });
      meta.put({ k: "chat", v: cache.chat });
      meta.put({ k: "chat_muted", v: cache.chatMuted ?? null });
      // structuredClone (which is what IndexedDB uses) copies a frozen object happily and
      // hands back a mutable one, so writing the frozen fx table here is safe and hydrate()
      // re-freezes what it reads.
      meta.put({ k: "fx", v: cache.fx });
      meta.put({ k: "pack", v: packRecord() });
      meta.put({ k: "last_sync", v: lastSync });
      meta.put({ k: "held", v: held });
      meta.put({ k: "whole_next", v: wholeNext });
    });
  } catch (e) {
    // A full disk or an evicted origin. Everything still works this session from memory;
    // shouting is the right response because the next cold start will be empty.
    console.error("[store] persist failed — offline cache may be stale", e);
  }
}

// ── refresh ─────────────────────────────────────────────────────────────────────────────
// refresh() and flush() are mutually exclusive, and that is not defensive tidiness — it is
// a bug fix. A snapshot fetched while the queue is draining does not contain the row the
// very next request is about to create; by the time it lands, that row's op has already
// left the queue, so replayQueue() cannot put it back and the row blinks out of the list a
// second after the user added it. Neither side ever waits on the other: whichever loses the
// race is re-kicked by the winner's tail.
let refreshing = null;
let refreshQueued = false;
// The server has said this trip is gone (see refresh). Nothing more is asked or sent.
let gone = false;

async function refresh() {
  if (gone) return false;
  if (refreshing) return refreshing;
  if (flushing) { refreshQueued = true; return false; }
  refreshing = (async () => {
    if (!isOnline()) return false;
    const since = !wholeNext && held && Number.isInteger(held.rev) ? held.rev : null;
    const [meRes, tripRes] = await Promise.all([req("GET", "/api/me"), req("GET", since === null ? T() : `${T()}?since=${since}`)]);
    if (meRes.ok && meRes.body && meRes.body.id) {
      // The server has said who this is. If what the phone holds was stored for somebody
      // else, none of it survives this line: not the rows, not the queue, not the other
      // trips the phone keeps.
      if (cache.me && cache.me.id && cache.me.id !== meRes.body.id) await startOver();
      if (ownerVerdict(keptOwner(), meRes.body.id) === "other") await startOver();
      if (!accountKnown) { accountKnown = true; emit("status", status()); }
      // TWO FIELDS FOR IDENTITY, PLUS ANY PREFERENCE THAT LIVES ONLY HERE. (Who hosts a trip
      // is the trip's `host_id`; an account has no rank of its own.)
      //
      // This used to be exactly the identity and that was right while every other
      // field on a user was also a fact about a MEMBER: note_color and initials are read off
      // cache.members, because a sticky written by someone who later left the trip still has
      // to render as theirs. tab_layout is not like that. It is a preference about this app
      // that belongs to nobody but you, it is on no roster, and rebuilding `me` without it
      // deleted it on the very next refresh — so the bar sprang back to the default about a
      // second after you rearranged it, with the write already safely in the database.
      //
      // `?? null` rather than a truthiness guard: null IS the meaningful answer for "never
      // chosen", and a server that omits the key entirely should read the same as one that
      // sends null, since tabs.js treats both as "use the shipped default".
      cache.me = {
        id: meRes.body.id,
        name: meRes.body.name,
        note_color: meRes.body.note_color ?? null,
        initials: meRes.body.initials ?? null,
        avatar: meRes.body.avatar ?? null,
        tab_layout: meRes.body.tab_layout ?? null,
        // Kilometers or miles (model §3): null until the person picks; util.js reads the phone's
        // language until then. Every distance drawn follows it (fmtDistance).
        units: meRes.body.units ?? null,
        // A guest (js/guest.js): on the trip by its link with only a name. Screens word what an account
        // can do differently for them.
        guest: meRes.body.guest === true,
      };
      setUnits(cache.me.units);
      setMeta("me", cache.me);
    }
    // A TRIP THAT IS GONE. The server answers a deleted trip and one this account is no longer
    // on in the same words, 404 {"error":"no such trip"}, and only says so to a signed-in
    // account (signed out is the 401 above; no signal is no answer at all). On exactly that
    // answer the phone stops keeping the trip: "gone" tells the shell, which removes what was
    // stored (the changes still waiting too: the server would refuse each one) and goes to
    // Your trips. Any other failure leaves the cache untouched: whatever this phone already
    // had is still the best it has.
    if (tripRes.status === 404 && tripRes.body && tripRes.body.error === "no such trip" && meRes.ok) {
      gone = true;
      clearTimeout(retryTimer);
      emit("gone", { trip: TRIP, waiting: queue.length });
      return false;
    }
    if (!tripRes.ok) return false;

    applySnapshot(tripRes.body || {});
    if (tripRes.body && tripRes.body.delta !== true) wholeNext = false;
    keepHere();
    lastSync = Date.now();
    lastPullAt = lastSync;
    if (fromOld()) await translateOldNow(tripRes.body || {});

    // Both of these are skipped when the snapshot changed nothing, and both matter. The
    // emit prevents repaints and image flicker on an idle screen. Rewriting all
    // ~370 rows to IndexedDB to store bytes that are already there is the same no-op with
    // a battery cost, on the phone that has to last four days without a charger; only the
    // clock is worth persisting.
    const dirty = emitChange();
    if (dirty) await persistAll();
    else await setMeta("last_sync", lastSync);

    emit("status", status());        // lastSync moved even when the data did not
    return true;
  })().catch((e) => {
    console.error("[store] refresh failed", e);
    return false;
  }).finally(() => {
    refreshing = null;
    if (queue.length) flush();          // whatever we made it skip, run it now
  });
  return refreshing;
}

// ── write queue ─────────────────────────────────────────────────────────────────────────
// Coalescing matters more here than in a normal app: four days offline means a packing item
// can be toggled a dozen times before anything is sent. An op is removed only after a 2xx, and
// one that has never gone out is safe to fold into. Two never are:
//   - the op on the wire (inflightSeq). Its payload was captured before the request started,
//     so a fold would be sent by nobody and then deleted by the 2xx that completes it.
//   - an op that went out and got no definite answer (op.sent, set and stored by flush()). The
//     server may have applied it: a create sent again is answered "already there, unchanged",
//     so an edit folded into it would be lost, and a delete that cancelled it would leave the
//     row the server made with nothing to remove it.
let inflightSeq = null;
let memSeq = 0;                    // key source when IndexedDB is unavailable
const foldable = (q) => q.seq !== inflightSeq && !q.sent;

async function enqueue(op) {
  const i = queue.findIndex((q) => q.kind === op.kind && q.id === op.id && foldable(q));
  if (i >= 0) {
    const prev = queue[i];
    if (op.op === "delete") {
      if (prev.op === "create") {
        // Created and destroyed without ever reaching the server. Send nothing.
        await removeOps(queue.filter((q) => q.kind === op.kind && q.id === op.id && foldable(q)));
        emit("status", status());
        return;
      }
      await removeOps([prev]);
    } else if (prev.op === "create" || prev.op === "update") {
      // Fold the patch into the pending op and keep its original seq, so a create that was
      // queued first still goes out first.
      prev.payload = { ...prev.payload, ...op.payload };
      await tx(["queue"], "readwrite", (t) => { t.objectStore("queue").put(prev); });
      emit("status", status());
      return;
    }
  }
  op.seq = (await tx(["queue"], "readwrite", (t) => {
    const r = t.objectStore("queue").add(op);
    r.onsuccess = () => { op.seq = r.result; };
  }).then(() => op.seq).catch(() => null)) ?? (memSeq = Math.max(memSeq, queue.at(-1)?.seq || 0) + 1);
  queue.push(op);
  queue.sort((a, b) => a.seq - b.seq);
  emit("status", status());
}

async function removeOps(ops) {
  const seqs = new Set(ops.map((o) => o.seq).filter((s) => s != null));
  if (!seqs.size) return;
  queue = queue.filter((q) => !seqs.has(q.seq));
  await tx(["queue"], "readwrite", (t) => {
    const os = t.objectStore("queue");
    for (const s of seqs) os.delete(s);
  }).catch(() => {});
}

// Every write route answers with the row inside a named envelope. Reaching for res.body.id
// directly finds nothing, silently: the write still succeeds, but the server's normalised
// row (trimmed title, server-assigned created_at) never replaces the optimistic one, so the
// cache quietly disagrees with the database until the next full refresh.
function unwrap(body) {
  if (!body || typeof body !== "object") return null;
  // A place is written through the route that takes a list, so its answer is a list of the
  // one row sent: { places: [row], warnings, rev }.
  const place = Array.isArray(body.places) && body.places.length === 1 ? body.places[0] : null;
  const row = body.event || body.item || body.note || body.me || body.purchase || body.reference || place || body;
  return row && row.id ? row : null;
}

// ── flush ───────────────────────────────────────────────────────────────────────────────
let flushing = false;
let retryTimer = null;
let retryStep = 0;
let askedWho = false;             // one refresh per retry round while the account is unknown

async function flush() {
  if (gone) return;
  if (flushing || refreshing || !queue.length) return;
  // Not until the queue is known to be this person's (see ownerGate). refresh() is what
  // finds out, and its own tail calls back here; the retry timer covers a refresh that
  // could not reach the server, so an unanswered question never becomes a tight loop.
  if (!accountKnown) {
    scheduleRetry();
    if (!askedWho) { askedWho = true; refresh(); }
    return;
  }
  // netOk only ever clears on a completed request, so bailing here without arming anything
  // leaves nothing in the system that can discover the radio came back: every re-probe path
  // is itself guarded by isOnline(). A cold boot with a queue hit exactly that dead end —
  // ready() -> refresh() fails -> flush() returns here -> no timer, no packets, forever.
  // There is work to send, so always leave a re-probe armed.
  if (!isOnline()) { scheduleRetry(); return; }
  // Changes from the app as it was before wait for the snapshot that lets them be turned
  // into this app's (translateOldNow). Nothing goes ahead of them: order is part of a queue.
  if (fromOld()) {
    scheduleRetry();
    if (!askedWho) { askedWho = true; refresh(); }
    return;
  }
  flushing = true;
  let sentAny = false;
  const rejected = [];
  const refusedCarried = [];
  const nearby = [];
  try {
    // Re-read queue[0] each iteration: a mutation during flush appends to the same array.
    while (queue.length && isOnline()) {
      const op = queue[0];
      const payload = op.payload && { ...op.payload };   // snapshot; see inflightSeq above
      const wire = wireOf(op, payload);
      let res;
      inflightSeq = op.seq;
      try {
        res = await req(wire.method, wire.path, wire.body);
      } finally {
        inflightSeq = null;
      }

      // A new packing item names the bags it starts in, and one of them was removed on
      // another phone before this left. Refusing the bags must not cost the item: it goes
      // again without them and lands as "not carried", which its owner can see and fix. The
      // person is told through the same event a refused move uses.
      if (op.kind === "packing" && op.op === "create" && payload && payload.bags &&
          (res.status === 400 || res.status === 409) && res.body &&
          /^no such (list|bag)$/.test(res.body.error || "")) {
        const { bags, ...bare } = op.payload;
        op.payload = bare;
        await tx(["queue"], "readwrite", (t) => { t.objectStore("queue").put(op); }).catch(() => {});
        rejected.push({
          op: { kind: "pack-place", op: "update", id: op.id, payload: { item_id: op.id, label: bare.label } },
          status: res.status, body: res.body,
        });
        continue;
      }

      if (res.ok) {
        await removeOps([op]);
        sentAny = true;
        // A new place within a few metres of one of the same kind is written all the same,
        // and the answer names the other so the person can be asked whether it is one place.
        if (op.kind === "place" && res.body && Array.isArray(res.body.warnings)) {
          for (const w of res.body.warnings) if (w && w.id && w.near) nearby.push({ id: w.id, near: w.near, meters: w.meters });
        }
        // Adopt the server's version of the row unless a later local edit is still queued
        // for it — otherwise the response would clobber an edit made mid-flush.
        // A packing structure write has no row to adopt: its effect has been on screen since
        // it was made, and the refresh after this drain brings the server's copy of it.
        const row = ownsNoRow(op.kind) ? null : unwrap(res.body);
        if (row && !queue.some((q) => q.kind === op.kind && q.id === op.id)) {
          // storeOf() has no answer for the singleton and its default is `packing` — adopting
          // through it would file a user row in the packing list. It adopts into the roster
          // and the notes instead, which is where a colour actually lives on this client.
          if (op.kind === "me") {
            applyNoteColor(row.id, row.note_color || null);
            // The server answers with EVERY field whichever one was patched (readMe()), so
            // adopting only the colour would blank the initials the server just confirmed —
            // and adopting two of three would blank the currency. Guarded rather than
            // unconditional because functions/api/me.js does not answer native_currency yet
            // (the column exists; the route is another build's), and a missing key must not
            // wipe a choice this device has already applied.
            if (row.initials) applyInitials(row.id, row.initials);
            if (row.native_currency) applyNativeCurrency(row.id, row.native_currency);
            // Guarded the same way and for the same reason: a server that does not answer
            // tab_layout must not blank a bar this device has already redrawn. `null` from the
            // server IS a meaningful answer though — it means "never chosen" — so the guard is
            // on the KEY being present, not on the value being truthy.
            if ("tab_layout" in row) applyMe({ tab_layout: row.tab_layout || null });
          }
          else {
            // A place's or an event's own answer doesn't carry its picture (the snapshot does, and
            // a picture changes only by its own route): the one this phone has stays on the row.
            const had = cache[storeOf(op.kind)].get(row.id);
            put(storeOf(op.kind), had && had.picture && !("picture" in row) ? { ...row, picture: had.picture } : row);
          }
          // Usually a no-op: the server echoes the row the optimistic copy already had, and
          // a repaint of every open screen for a byte-identical row is the flicker again.
          emitChange();
        }
        continue;
      }
      // 401 is transient, not a rejection. req() has already bounced to /login; the ops must
      // survive that reload so they drain after re-login. Dropping them here erases the queue
      // moments before the redirect that would have fixed it — and _middleware's lookupUser()
      // returns null on any D1 error, so one hiccup mid-drain 401s a four-day queue away.
      // packing.js's sibling queue treats 401 as transient for exactly this reason.
      if (res.status === 0 || res.status === 401 || res.status === 408 ||
          res.status === 429 || res.status >= 500) {
        lastTransient = res.status;              // what scheduleRetry tells, if it goes on (error-report.js)
        // NO DEFINITE ANSWER: nothing came back (or it was given up, or something that isn't the
        // API answered), the request timed out, or the server broke partway. The write may have
        // been applied all the same. From here the op counts as sent: nothing is folded into it,
        // so an edit or a delete made meanwhile goes as its own write after it (enqueue()). 401
        // and 429 are refused before anything is written, so they leave the op as it was.
        if (!op.sent && res.status !== 401 && res.status !== 429) {
          op.sent = true;
          await tx(["queue"], "readwrite", (t) => { t.objectStore("queue").put(op); }).catch(() => {});
        }
        break;                                   // transient: keep the op, back off, retry
      }
      // 4xx: the server has rejected this write permanently — a permission failure, or a
      // row that no longer exists. Keeping it would wedge the queue behind it forever, so
      // drop it and tell the UI, which is the only honest thing to do.
      console.warn("[store] write rejected, dropping", op, res.status, res.body);
      await removeOps([op]);
      // Its optimistic row is in what this phone holds; a delta never names it, so the next pull is whole.
      wholeNext = true;
      setMeta("whole_next", true);
      // Emitted after the drain, not here: a listener that reacts by calling refresh() —
      // which is exactly what the shell does — would otherwise re-enter the store while
      // the rest of the queue is still going out.
      //
      // A change carried over from the app as it was before (op.carried) is not said the way
      // one just made is: the person made it weeks ago and is not watching for it. It goes
      // into the message that stays until tapped (old-queue.js "refused"). Removing a thing
      // that is already gone is what they wanted: nothing to say.
      if (op.carried) { if (!(op.op === "delete" && res.status === 404)) refusedCarried.push({ op, status: res.status }); }
      else rejected.push({ op, status: res.status, body: res.body });
      sentAny = true;
    }
  } finally {
    flushing = false;
    emit("status", status());
  }
  for (const r of rejected) emit("reject", r);
  if (refusedCarried.length) await tellRefused(refusedCarried);
  for (const n of nearby) emit("place-near", n);
  if (queue.length) scheduleRetry();
  else retryStep = 0;
  // Reconcile after a drain so the cache matches what the server actually accepted — and
  // pick up anything a refresh attempt skipped while this was running.
  if (sentAny || refreshQueued) { refreshQueued = false; refresh(); }
}

// What one queued write is on the wire. Rows are the common case and the last four lines.
function wireOf(op, payload) {
  const base = WIRE[op.kind];
  // The singleton: /api/me takes NO id in the path, and must not. Its row is whoever holds
  // the session cookie, so a path that could name a user would be a path that recolours
  // somebody else's sticky. op.id is still the user's id — it is what enqueue() folds on, so
  // three taps on three swatches offline leave one PATCH.
  if (op.kind === "me") return { method: "PATCH", path: base, body: payload };
  // A waiting note goes as a message about its plan, with its own id (so it lands once however
  // often it is sent); one about the empty time before a plan, about that time. Its removal is the
  // message's (the chat's rule: its author, or the host).
  if (op.kind === "note") {
    if (op.op === "delete") return { method: "DELETE", path: T(`/messages/${encodeURIComponent(op.id)}`) };
    const about = { kind: "event", id: payload.event_id, ...(payload.anchor_kind === "gap" ? { part: "before" } : {}) };
    return { method: "POST", path: T("/messages"), body: { id: op.id, body: payload.body, about } };
  }
  if (op.kind === "pack-tick") {
    const body = { item_id: payload.item_id, list_key: payload.list_key, ticked: !!payload.ticked };
    if (payload.day) body.day = payload.day;
    return { method: "PUT", path: `${WIRE.packing}/ticks`, body };
  }
  // A move is the item's PATCH with nothing in it but the one bag, so it cannot touch the
  // label. null takes the item off that list.
  if (op.kind === "pack-place") {
    return {
      method: "PATCH", path: `${WIRE.packing}/${encodeURIComponent(payload.item_id)}`,
      body: { bags: { [payload.list_key]: payload.bag_key || null } },
    };
  }
  // Lists and bags go one at a time, each naming only what it changes. The server adds or
  // changes what a write names and leaves the rest alone, so a phone that was offline while
  // someone else added a bag does not take that bag away by not knowing about it.
  if (op.kind === "pack-list") {
    if (op.op === "delete") return { method: "DELETE", path: `${WIRE.packing}/lists/${encodeURIComponent(op.id)}` };
    const { name, sort, repeat, bags } = payload;
    const list = { key: op.id };
    if (name !== undefined) list.name = name;
    if (sort !== undefined) list.sort = sort;
    if (op.op === "create") { list.repeat = repeat || "once"; list.bags = bags; }
    return { method: "PUT", path: `${WIRE.packing}/lists`, body: { lists: [list] } };
  }
  if (op.kind === "pack-bag") {
    const bag = { key: payload.key };
    if (op.op === "delete") bag.remove = true;
    else {
      if (payload.name !== undefined) bag.name = payload.name;
      if (payload.sort !== undefined) bag.sort = payload.sort;
    }
    return { method: "PUT", path: `${WIRE.packing}/lists`, body: { lists: [{ key: payload.list_key, bags: [bag] }] } };
  }
  // A place is added or changed through the one route that takes a list, as a list of one.
  // A change names only what changes and null clears; a NEW place has nothing to clear, so
  // a null folded into it (a pin put on and taken off again before any signal) is left out.
  if (op.kind === "place" && op.op !== "delete") {
    const fields = op.op === "create"
      ? Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== null && v !== undefined))
      : payload;
    return { method: "PUT", path: base, body: { places: [{ ...fields, id: op.id }] } };
  }
  // A packing item goes as exactly the fields its route takes (shared/trip-rules.js): the row's
  // own stamps stay on the phone, and the route refuses anything else by name.
  if (op.kind === "packing" && op.op !== "delete") {
    const body = Object.fromEntries(Object.entries(payload).filter(([k]) => PACKING_ITEM_FIELDS.includes(k)));
    return op.op === "create" ? { method: "POST", path: base, body } : { method: "PATCH", path: `${base}/${encodeURIComponent(op.id)}`, body };
  }
  if (op.op === "create") return { method: "POST", path: base, body: payload };
  if (op.op === "update") return { method: "PATCH", path: `${base}/${encodeURIComponent(op.id)}`, body: payload };
  return { method: "DELETE", path: `${base}/${encodeURIComponent(op.id)}` };
}

// A sync that keeps failing with the server answering (offline is no error: status 0) is said once a round, after
// SYNC_TELL_AFTER tries in a row, as an event js/error-report.js reports: the status and the tries, nothing of the changes.
const SYNC_TELL_AFTER = 5;
let lastTransient = 0;

function scheduleRetry() {
  clearTimeout(retryTimer);
  const wait = RETRY_MS[Math.min(retryStep, RETRY_MS.length - 1)];
  retryStep += 1;
  if (retryStep === SYNC_TELL_AFTER && lastTransient !== 0) {
    try { dispatchEvent(new CustomEvent("wgp:sync-failing", { detail: { status: lastTransient, tries: retryStep } })); } catch { /* never in the way */ }
  }
  retryTimer = setTimeout(() => { askedWho = false; setNet(true); flush(); }, wait);   // optimistic re-probe
}

// ── permission ──────────────────────────────────────────────────────────────────────────
// THE API IS THE AUTHORITY. This check exists so the UI can hide controls and so an
// impossible write never enters the queue and blocks it — it is not security.
// This is the author rule, and it is packing's (a person's own line). A plan has no author
// rule: any member changes any plan, so updateEvent() and deleteEvent() do not come here.
function canEdit(row) {
  const me = cache.me;
  return !!(row && me && me.id && row.created_by === me.id);
}
// A PURCHASE IS AUTHOR **OR** PAYER, and it is deliberately neither of the two rules above.
//
// Not the events rule (author only): if Ada logs "Teo paid 120 for the taxi" and gets
// the amount wrong, Teo has to be able to fix it — it is Teo's money, so tapping
// an item to switch to an unequal split is a thing the payer does as naturally as the author.
//
// Not the packing rule (owner === 'group' opens it to everyone): a shared ledger any member
// can silently rewrite is a ledger nobody trusts, and this schema has no soft delete and no
// audit trail to appeal to afterwards. Two people is enough to repair any mistake; a
// participant who is neither and thinks their share is wrong asks the payer. That is a real
// limitation and it is the right one.
//
// created_by === 'seed' matches no user id, so a seeded purchase would be locked for
// everybody, which is the correct default and needs no special case.
//
// Like the packing rule, this predicate lives in THREE FILES THAT MUST MOVE TOGETHER: here,
// functions/api/purchases.js's mayTouchPurchase(), and the split view's own canEdit().
// docs/CONTRACTS.md records the packing rule the same way for the same reason.
//
// A PAYMENT adds one person: whoever received it (its one share). Both sides of the money can
// say "that didn't happen", or fix the amount that arrived. src/api/purchases.js's
// mayTouchPurchase() says the same.
function canEditPurchase(row) {
  const me = cache.me;
  if (!(row && me && me.id)) return false;
  if (row.created_by === me.id || row.paid_by === me.id) return true;
  return row.kind === "payment" && (row.shares || []).some((s) => s && s.user_id === me.id);
}

function assertOwn(row, what) {
  if (!row) throw new Error(`${what} not found`);
  if (!canEdit(row)) {
    throw new Error(row.created_by === "seed"
      ? `${what} is part of the itinerary and cannot be edited — add a note instead`
      : `${what} belongs to someone else`);
  }
}

// Must match initialsOf() in functions/api/trip.js: the server computes this for synced
// notes and the client for optimistic ones, and two spellings would make a note change its
// initials the moment it reached the wire.
function initialsOf(name) {
  const parts = String(name || "").trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

function requireMe() {
  const me = cache.me;
  if (!me || !me.id) throw new Error("not signed in yet");
  return me;
}
function tripId() { return TRIP; }

// ── mutations ───────────────────────────────────────────────────────────────────────────
async function commit(kind, op, id, payload, nextRow) {
  const s = storeOf(kind);
  if (op === "delete") drop(s, id); else put(s, nextRow);
  // Through emitChange() rather than emit() so lastSig moves with the write. If a local
  // mutation emitted directly, lastSig would still describe the world from before it, and
  // the next background refresh could compare equal against that stale signature and skip
  // a repaint that was genuinely needed.
  emitChange();
  const seen = snapshots;
  await enqueue({ kind, op, id, payload, at: Date.now() });
  // enqueue() waits on IndexedDB before the op joins the queue. A snapshot that lands inside
  // that wait replaces the mirror and finds no op to replay, so the row just written is gone
  // from the screen (and a patch to it a moment later throws "not found") until the next
  // refresh. The op is in the queue now: play the queue over that snapshot.
  if (snapshots !== seen) { replayQueue(); emitChange(); }
  // Persist the mirror too: an app killed by iOS between the write and the flush must come
  // back with the write still visible, not just still queued.
  persistAll();
  flush();
  return nextRow;
}

// The same for a packing structure write. Only its own record is written back: a tick must
// not cost a rewrite of every row on the trip.
async function packCommit(kind, op, id, payload) {
  packApply({ kind, op, id, payload });
  emitChange();
  const seen = snapshots;
  await enqueue({ kind, op, id, payload, at: Date.now() });
  if (snapshots !== seen) { replayQueue(); emitChange(); }
  setMeta("pack", packRecord());
  flush();
}

// Queued writes that no longer have anything to act on (a move of an item deleted a moment
// later). Never the one on the wire: its answer is already on its way.
async function dropQueued(match) {
  await removeOps(queue.filter((q) => q.seq !== inflightSeq && match(q)));
}

async function addEvent(partial = {}) {
  const me = requireMe();
  const now = stamp();
  const row = {
    id: partial.id || uid("ev"),
    trip_id: tripId(),
    starts_at: partial.starts_at ?? Math.floor(Date.now() / 1000),
    ends_at: partial.ends_at ?? null,
    tz: partial.tz || (cache.trip && cache.trip.default_tz) || "UTC",
    // The zone it ends in, when that is another (a flight that lands elsewhere): left off, a
    // plan made by hand would land in the zone it left from, on this phone and on the server.
    end_tz: partial.end_tz || null,
    all_day: partial.all_day ? 1 : 0,
    title: String(partial.title || "").trim(),
    kind: partial.kind || "plan",
    place_id: partial.place_id || null,
    detail: partial.detail || "",
    url: partial.url || "",
    created_by: me.id,
    created_at: now,
    updated_at: now,
  };
  return commit("event", "create", row.id, row, row);
}

// Any member changes or removes any plan (docs/API.md, the permission rules): a plan is the
// trip's, whoever typed it and wherever it came from. So there is no author rule here.
async function updateEvent(id, patch = {}) {
  const cur = cache.events.get(id);
  if (!cur) throw new Error("event not found");
  const p = { ...patch, updated_at: stamp() };
  delete p.id; delete p.created_by; delete p.created_at;   // never patchable
  return commit("event", "update", id, p, { ...cur, ...p });
}

async function deleteEvent(id) {
  const cur = cache.events.get(id);
  if (!cur) throw new Error("event not found");
  await commit("event", "delete", id, null, null);
}

// ── places by hand ──────────────────────────────────────────────────────────────────────
// A place a person adds, changes or removes: on the phone at once and queued like a
// purchase. Any member may (docs/API.md). The form's rules are public/js/place-form.js; this
// only carries the write.
//
// What the server gives a new place for everything the form does not have (src/api/places.js),
// so the row on screen before the answer is the row the answer brings.
const PLACE_BLANK = {
  name_local: "", area: null, address: "", address_note: "", lat: null, lng: null, rating: 0, rating_count: 0,
  price_level: 0, hours: "", phone: "", website: "", why: "", notes: "", near_anchor: "", walk_minutes: 0,
  confidence: "medium", source: "", is_anchor: 0, elevation_m: 0, checkout: "",
};
function placeRow(id, fields) {
  return { ...PLACE_BLANK, tags: [], ...fields, id, trip_id: tripId() };
}

// `fields` is what the form read (name, kind, subkind, and any of area, address, why, website,
// lat + lng), with the id the form made for it. Only what is given goes on the wire.
async function addPlace(id, fields = {}) {
  requireMe();
  if (!id || cache.places.has(id)) throw new Error("a new place needs an id no place has");
  const sent = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || (v === "" && k !== "why")) continue;
    sent[k] = v;
  }
  if (!sent.name || !sent.kind || !sent.subkind) throw new Error("a place needs a name, a kind and a subkind");
  if (sent.why === undefined) sent.why = "";
  return commit("place", "create", id, sent, placeRow(id, sent));
}

// `changes` names only the fields that change; null clears one (a pin: lat and lng together).
async function updatePlace(id, changes = {}) {
  const cur = cache.places.get(id);
  if (!cur) throw new Error("place not found");
  const p = { ...changes };
  delete p.id; delete p.trip_id;
  if (!Object.keys(p).length) return cur;
  return commit("place", "update", id, p, { ...cur, ...p });
}

// What still points at a place: the plans at it and the places said to be near it (the server
// refuses a removal while either exists), and the purchases made there (they stay, and stop
// naming it).
function placeUses(id) {
  return {
    events: [...cache.events.values()].filter((e) => e.place_id === id),
    places: [...cache.places.values()].filter((p) => p.near_anchor === id && p.id !== id),
    purchases: [...cache.purchases.values()].filter((p) => p.place_id === id).length,
  };
}

// The trip's reference list (js/references.js). A new item goes at the end of the list.
async function addReference(id, { title, body = "" } = {}) {
  requireMe();
  if (!id || cache.references.has(id)) throw new Error("a new item needs an id no item has");
  if (!String(title || "").trim()) throw new Error("an item needs a title");
  const position = Math.max(0, ...[...cache.references.values()].map((r) => Number(r.position) || 0)) + 1;
  // The id rides on the create: a create sent again (its answer lost) finds its row instead of making a second.
  const sent = { id, title: String(title).trim(), body: String(body || ""), position };
  return commit("reference", "create", id, sent, { ...sent, trip_id: tripId(), created_at: Date.now() });
}
async function updateReference(id, changes = {}) {
  const cur = cache.references.get(id);
  if (!cur) throw new Error("that item isn't on the list any more");
  const p = {};
  for (const k of ["title", "body", "position"]) if (k in changes) p[k] = changes[k];
  if (!Object.keys(p).length) return cur;
  return commit("reference", "update", id, p, { ...cur, ...p });
}
async function deleteReference(id) {
  const cur = cache.references.get(id);
  if (!cur) throw new Error("that item isn't on the list any more");
  await commit("reference", "delete", id, { title: cur.title }, null);
}

async function deletePlace(id) {
  const cur = cache.places.get(id);
  if (!cur) throw new Error("place not found");
  const uses = placeUses(id);
  if (uses.events.length || uses.places.length) throw new Error("place in use");
  // The name rides on the write (it never goes on the wire): if the server keeps the place,
  // the sentence that says so can name it after the row has left this phone.
  await commit("place", "delete", id, { name: cur.name }, null);
}

// The trip's dates, set by any member. NOT queued, unlike every write above: a plan goes on
// a day of its trip, so every phone has to agree which days those are before one is put
// there, and a pair of dates waiting in one phone's queue would let a second phone set
// another pair. The answer is { ok, status, body, offline? }, and the caller says what
// happened; on success the trip on this phone has the dates at once.
async function setTripDates(starts_on, ends_on) {
  const res = await req("PATCH", T(""), { starts_on, ends_on });
  if (res.ok && res.body && res.body.trip) {
    cache.trip = { ...(cache.trip || {}), ...res.body.trip };
    invalidate();
    emitChange();
    persistAll();
  }
  return res;
}

// Notes on plans are messages in the chat (migration 0027): chat.js writes them, and a note
// still waiting on this phone from before goes as one (wireOf). talkAbout() below says how many
// there are about each plan, for the Agenda.

// ── YOUR OWN COLOR ───────────────────────────────────────────────────────────────────────
// The palette is the SERVER'S (functions/api/trip.js NOTE_COLORS) and arrives on the
// snapshot, so this file holds no hex codes and the two pickers cannot drift from the table
// PATCH /api/me validates against. Empty before the first sync, which correctly draws no
// picker rather than a picker offering colours the server would refuse.
function noteColors() { return (cache.noteColors || []).slice(); }

// Where a colour actually lives on this client, and it is THREE places by the time it is on
// screen: the roster row the agenda falls back to, every note this person has already written
// (the API denormalises the colour onto note rows so a sticky from somebody who left the trip
// still renders as theirs), and — after the flush — the database. All of the local ones have
// to move together, or the wall recolours one sticky at a time as snapshots catch up, which
// looks exactly like the app losing the change.
//
// Frozen replacements rather than mutation: rows are frozen on the way into the cache, and
// `row.note_color = …` here would throw at this line instead of silently desyncing.
/* INITIALS ARE THE SAME SHAPE OF WRITE AS THE COLOUR, so they take the same path: apply to
   the member row and to every note that member has already written, then queue one folded
   PATCH. Notes carry a denormalised copy of both so a sticky whose author has left the trip
   still renders as theirs — which means changing yours has to rewrite them here too, exactly
   as the colour does, or the agenda keeps showing the old pair until the next full sync. */
function applyInitials(userId, initials) {
  if (!userId) return;
  cache.members = (cache.members || []).map((m) =>
    (m && m.id === userId ? Object.freeze({ ...m, initials }) : m));
  if (cache.me && cache.me.id === userId) cache.me = Object.freeze({ ...cache.me, initials });
  invalidate();
}

function myInitials() {
  const me = cache.me;
  if (!me || !me.id) return "";
  const mine = (cache.members || []).find((m) => m && m.id === me.id);
  return (mine && mine.initials) || initialsOf(me.name);
}

async function setInitials(raw) {
  const me = requireMe();
  /* The server validates this too, and its rule is the one that counts — this is here so a
     bad value never reaches the optimistic cache, not as the gate. */
  const next = String(raw || "").trim().toUpperCase();
  if (!/^[\p{L}\p{N}]{1,3}$/u.test(next)) throw new Error("initials must be 1-3 letters or digits");
  if (myInitials() === next) return next;
  applyInitials(me.id, next);
  emitChange();
  await enqueue({ kind: "me", op: "update", id: me.id, payload: { initials: next }, at: Date.now() });
  persistAll();
  flush();
  return next;
}

// ── tab layout ──────────────────────────────────────────────────────────────────────────
// The order of the bottom bar, and which sections are in it. Per USER, not per trip: it is a
// preference about this app, not a fact about this holiday, and it should follow you to a new
// phone the same way your color does.
//
// STORED AS A JSON STRING in users.tab_layout, and handed out as an array. NULL means "never
// chosen", which resolves to the shipped default — so a person who never opens the setting has
// no row to migrate and sees no change, ever.
//
// NOT VALIDATED HERE BEYOND "is it JSON". tabs.js's resolve() is the authority on what a legal
// layout is, and it is written to repair anything rather than reject it; duplicating those
// rules in this file is how the bar and the editor start disagreeing about what is legal.
function myTabLayout() {
  const me = cache.me;
  if (!me || !me.id) return null;
  const raw = me.tab_layout;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

async function setTabLayout(ids) {
  const me = requireMe();
  const next = JSON.stringify(Array.isArray(ids) ? ids : []);
  if ((cache.me && cache.me.tab_layout) === next) return ids;
  // The singleton, not a rowstore row — the same shape as setNoteColor/setInitials, and the
  // reason applyMe() below exists: `me` has no Map to put() into.
  applyMe({ tab_layout: next });
  emitChange();
  await enqueue({ kind: "me", op: "update", id: me.id, payload: { tab_layout: next }, at: Date.now() });
  persistAll();
  flush();
  return ids;
}

// Merge a patch into the `me` singleton. Frozen replacement rather than mutation, for the same
// reason every row in this file is frozen: a view that writes through a returned object would
// desync the mirror from IndexedDB with no throw anywhere.
function applyMe(patch) {
  if (!cache.me) return;
  cache.me = Object.freeze({ ...cache.me, ...patch });
  if ("units" in patch) setUnits(cache.me.units);
  invalidate();
}

function applyNoteColor(userId, hex) {
  if (!userId) return;
  cache.members = (cache.members || []).map((m) =>
    (m && m.id === userId ? Object.freeze({ ...m, note_color: hex }) : m));
  // Your own color is also on `me`, which the shell's head and rail and More read: recolored with the roster, so every
  // face of you takes it on the same change (20 Nov: a blue pick kept the old pink ring on the head until a reload).
  if (cache.me && cache.me.id === userId) cache.me = Object.freeze({ ...cache.me, note_color: hex });
  invalidate();
}

/** Your own color right now — read from the roster, which is the same
 *  source agenda.js's noteSkin() falls back to. Null until the first sync. */
function myNoteColor() {
  const me = cache.me;
  if (!me || !me.id) return null;
  const mine = (cache.members || []).find((m) => m && m.id === me.id);
  return (mine && mine.note_color) || null;
}

// Optimistic, queued, offline-safe — the same three properties every other write here has,
// which is the whole reason this does not go out as a bare fetch(). The sticky recolours in
// the frame the swatch is tapped and the PATCH leaves whenever there is a radio.
//
// The value is checked against the palette before it enters the queue. That is not security
// — functions/api/me.js checks it again and is the authority — it is so an impossible write
// never gets in front of the queue, where a permanent 400 would be dropped a day later with
// the person's actual choice already forgotten.
async function setNoteColor(hex) {
  const me = requireMe();
  const palette = cache.noteColors || [];
  if (!palette.some((c) => c && c.hex === hex)) throw new Error("that isn't one of the colors to pick from");
  if (myNoteColor() === hex) return hex;              // already yours; nothing to send
  applyNoteColor(me.id, hex);
  // Through emitChange() for the same reason commit() uses it: a direct emit would leave
  // lastSig describing the world from before this write, and the next background refresh
  // could compare equal against it and skip a repaint that was genuinely needed.
  emitChange();
  // kind:"me" is the queue's one singleton — see WIRE and flush(). It folds like any other
  // update, so three taps on three swatches while offline still leave exactly one PATCH.
  await enqueue({ kind: "me", op: "update", id: me.id, payload: { note_color: hex }, at: Date.now() });
  persistAll();
  flush();
  return hex;
}

// ── packing ─────────────────────────────────────────────────────────────────────────────
// WHO MAY DO WHAT is the server's rule (mayTouch in src/api/packing.js), kept in step here:
// a person's items are theirs alone, and the group's items are anyone's to tick and to move.
// Renaming and deleting a line stay with whoever added it, the group's lines included.
const packMine = (row) =>
  !!(row && cache.me && cache.me.id && (row.owner === "group" || row.owner === cache.me.id));
const packList = (key) => cache.pack.lists.find((l) => l.key === key) || null;

/**
 * `partial.bags` is { list key: bag key }: the bag the new thing starts in on each list it is
 * carried on. A list left out is a list it is not carried on. A bag this phone does not know
 * is dropped here rather than sent to be refused.
 */
async function addPacking(owner, partial = {}) {
  const me = requireMe();
  const now = stamp();
  const peers = [...cache.packing.values()].filter((r) => r.owner === owner);
  const row = {
    id: partial.id || uid("pk"),
    trip_id: tripId(),
    owner,
    label: String(partial.label || "").trim(),
    note: partial.note || "",
    qty: partial.qty || "",
    sort: partial.sort ?? peers.reduce((m, r) => Math.max(m, r.sort || 0), 0) + 10,
    category: partial.category || "misc",
    created_by: me.id,
    created_at: now,
    updated_at: now,
  };
  const bags = {};
  for (const [list, bag] of Object.entries(partial.bags || {})) {
    const l = packList(list);
    if (bag && l && l.bags.some((x) => x.key === bag)) bags[list] = bag;
  }
  packPlaceAll(row.id, bags);
  return commit("packing", "create", row.id, Object.keys(bags).length ? { ...row, bags } : row, row);
}

// The thing itself: label, quantity, note, category, order. Where it sits is placePacking()
// and whether it is packed is tickPacking(); neither can be changed from here, so nothing on
// the rename path can move a thing or untick it.
async function setPacking(id, patch = {}) {
  const cur = cache.packing.get(id);
  if (!cur) throw new Error("packing item not found");
  if (cur.owner !== "group") assertOwn(cur, "packing item");
  const p = { ...patch, updated_at: stamp() };
  delete p.id; delete p.created_by; delete p.created_at; delete p.owner; delete p.bags;
  return commit("packing", "update", id, p, { ...cur, ...p });
}

async function deletePacking(id) {
  const cur = cache.packing.get(id);
  assertOwn(cur, "packing item");
  // Its queued moves and ticks would be refused ("no such item") once the delete has gone.
  await dropQueued((q) => (q.kind === "pack-place" || q.kind === "pack-tick") && q.payload && q.payload.item_id === id);
  packForgetItem(id);
  await commit("packing", "delete", id, null, null);
}

/**
 * The day a list is being packed for at this moment, and whether it can be ticked now.
 * A list packed once has no day and is always open. A list for the day is ticked for the
 * TRIP's day (the trip's time zone, never the phone's: a phone still on home time must not
 * start a fresh day in the middle of the afternoon), and only on a day that is one of the
 * list's: one of its named dates, or any day of the trip when it names none. A trip without
 * dates has no days to be outside of.
 */
function packDay(listKey) {
  const list = packList(listKey);
  if (!list || list.repeat !== "daily") return { day: null, open: !!list };
  const trip = cache.trip || {};
  let day;
  try { day = dayIn(Math.floor(Date.now() / 1000), trip.default_tz || "UTC"); }
  catch { day = dayIn(Math.floor(Date.now() / 1000), "UTC"); }      // a zone this engine does not know
  if (list.dates) return { day, open: list.dates.includes(day) };
  if (trip.starts_on && trip.ends_on) return { day, open: day >= trip.starts_on && day <= trip.ends_on };
  return { day, open: true };
}

/** Tick or untick an item on one list. `day` is packDay()'s for a list for the day, else null. */
async function tickPacking(itemId, listKey, day, ticked) {
  requireMe();
  const item = cache.packing.get(itemId);
  if (!item) throw new Error("That thing isn't on the list any more.");
  if (!packMine(item)) throw new Error("That thing is on someone else's list.");
  const list = packList(listKey);
  if (!list) throw new Error("That list was removed.");
  if (!cache.pack.placements.has(placeKey(itemId, listKey))) {
    throw new Error("That thing isn't carried on this list, so there is nothing to tick.");
  }
  const d = list.repeat === "daily" ? day : null;
  if (list.repeat === "daily" && !isDay(d)) throw new Error("A list for the day is ticked for one day of the trip.");
  await packCommit("pack-tick", "update", tickKey(itemId, listKey, d),
    { item_id: itemId, list_key: listKey, day: d, ticked: !!ticked, label: item.label, list_name: list.name });
}

/** Put an item in a bag on one list, or (bag null) take it off that list: "not carried". */
async function placePacking(itemId, listKey, bagKey) {
  requireMe();
  const item = cache.packing.get(itemId);
  if (!item) throw new Error("That thing isn't on the list any more.");
  if (!packMine(item)) throw new Error("That thing is on someone else's list.");
  const list = packList(listKey);
  if (!list) throw new Error("That list was removed.");
  const bag = bagKey ? list.bags.find((x) => x.key === bagKey) : null;
  if (bagKey && !bag) throw new Error("That bag was removed.");
  if ((cache.pack.placements.get(placeKey(itemId, listKey)) || null) === (bagKey || null)) return;
  // A tick still waiting to be sent for a list the thing has just left would be refused.
  if (!bagKey) {
    await dropQueued((q) => q.kind === "pack-tick" && q.payload && q.payload.item_id === itemId && q.payload.list_key === listKey);
  }
  await packCommit("pack-place", "update", placeKey(itemId, listKey), {
    item_id: itemId, list_key: listKey, bag_key: bagKey || null, label: item.label, bag_name: bag ? bag.name : "",
  });
}

// A key for a new list or bag, made from its name: lowercase letters, digits and hyphens, the
// server's rule for a key a writer chooses. Two phones that add "Beach bag" with no signal
// make the same key, and the trip ends up with one beach bag, which is what was meant.
function packKey(name, taken, fallback) {
  const base = String(name).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "") || fallback;
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  return key;
}
function packName(value, what) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name) throw new Error(`${what} needs a name.`);
  if (name.length > PACKING_NAME_MAX) throw new Error(`${what} name can be ${PACKING_NAME_MAX} characters at most.`);
  return name;
}
const nextSort = (rows) => rows.reduce((m, r) => Math.max(m, r.sort || 0), -1) + 1;
const packHeld = (listKey, bagKey) => {
  let n = 0;
  const tail = `${SEP}${listKey}`;
  for (const [k, bag] of cache.pack.placements) if (k.endsWith(tail) && (bagKey == null || bag === bagKey)) n++;
  return n;
};

/** A new list, packed once, with its bags (names, in order). Answers its key. */
async function addPackList(name, bagNames) {
  requireMe();
  const lists = cache.pack.lists;
  if (lists.length >= PACKING_LISTS_MAX) throw new Error(`A trip has ${PACKING_LISTS_MAX} packing lists at most.`);
  const n = packName(name, "A list");
  const taken = new Set();
  const bags = [];
  for (const raw of (bagNames || []).slice(0, PACKING_BAGS_MAX)) {
    const bn = packName(raw, "A bag");
    const key = packKey(bn, taken, "bag");
    taken.add(key);
    bags.push({ key, name: bn, sort: bags.length });
  }
  if (!bags.length) throw new Error("A list needs at least one bag.");
  const key = packKey(n, new Set(lists.map((l) => l.key)), "list");
  await packCommit("pack-list", "create", key, { name: n, sort: nextSort(lists), repeat: "once", bags });
  return key;
}

/** Rename a list, or move it in the order: patch is { name } and/or { sort }. */
async function setPackList(key, patch = {}) {
  requireMe();
  const list = packList(key);
  if (!list) throw new Error("That list was removed.");
  const p = {};
  if (patch.name !== undefined) p.name = packName(patch.name, "A list");
  if (Number.isInteger(patch.sort) && patch.sort >= 0) p.sort = patch.sort;
  if (!Object.keys(p).length || Object.keys(p).every((k) => p[k] === list[k])) return;
  await packCommit("pack-list", "update", key, p);
}

async function deletePackList(key) {
  requireMe();
  const list = packList(key);
  if (!list) return;
  if (cache.pack.lists.length <= 1) throw new Error("A trip keeps at least one packing list. Rename this one, or add another first.");
  const held = packHeld(key, null);
  if (held) throw new Error(`${held} thing${held === 1 ? " still has" : "s still have"} a bag on “${list.name}”. Take ${held === 1 ? "it" : "them"} off it first.`);
  await dropQueued((q) => q.kind === "pack-bag" && q.payload && q.payload.list_key === key);
  await packCommit("pack-list", "delete", key, { name: list.name });
}

/** A new bag on a list. Answers its key. */
async function addPackBag(listKey, name) {
  requireMe();
  const list = packList(listKey);
  if (!list) throw new Error("That list was removed.");
  if (list.bags.length >= PACKING_BAGS_MAX) throw new Error(`A list has ${PACKING_BAGS_MAX} bags at most.`);
  const n = packName(name, "A bag");
  const key = packKey(n, new Set(list.bags.map((x) => x.key)), "bag");
  await packCommit("pack-bag", "create", `${listKey}${SEP}${key}`,
    { list_key: listKey, key, name: n, sort: nextSort(list.bags) });
  return key;
}

async function setPackBag(listKey, bagKey, patch = {}) {
  requireMe();
  const list = packList(listKey);
  const bag = list && list.bags.find((x) => x.key === bagKey);
  if (!bag) throw new Error("That bag was removed.");
  const p = { list_key: listKey, key: bagKey };
  if (patch.name !== undefined) p.name = packName(patch.name, "A bag");
  if (Number.isInteger(patch.sort) && patch.sort >= 0) p.sort = patch.sort;
  if (["name", "sort"].every((k) => p[k] === undefined || p[k] === bag[k])) return;
  await packCommit("pack-bag", "update", `${listKey}${SEP}${bagKey}`, p);
}

// Only an empty bag goes, and never a list's last one. The count here is what THIS phone can
// see (your things and the group's); the server counts everyone's and may still say no, which
// arrives as a "reject" with the number in it.
async function deletePackBag(listKey, bagKey) {
  requireMe();
  const list = packList(listKey);
  const bag = list && list.bags.find((x) => x.key === bagKey);
  if (!bag) return;
  if (list.bags.length <= 1) throw new Error("A list keeps at least one bag. Rename this one, or add another first.");
  const held = packHeld(listKey, bagKey);
  if (held) throw new Error(`“${bag.name}” still holds ${held} thing${held === 1 ? "" : "s"}. Move ${held === 1 ? "it" : "them"} to another bag first.`);
  await packCommit("pack-bag", "delete", `${listKey}${SEP}${bagKey}`, { list_key: listKey, key: bagKey, name: bag.name });
}


// ── PURCHASES ───────────────────────────────────────────────────────────────────────────
// A purchase is an ordinary row and goes through commit() like every other one: the
// offline queue in public/js/store.js already folds writes per row and survives four days
// without signal, and offline market purchases are expected, not an edge case.
//
// MONEY IS AN INTEGER COUNT OF MINOR UNITS. amount_minor + currency + amount_exp, never a
// float, never a decimal string. The whole settle-up rests on SUM(share_minor) ===
// amount_minor holding EXACTLY, so that every net balance sums to exactly zero, so that the
// fewest-transfers matcher terminates at zero rather than at a fraction of a céntimo. A float
// split of 10.00 three ways sums to 10.000000000000002 and the matcher eventually prints a
// transfer of 0.00.
//
// THE EXPONENT RIDES THE ROW. Minor units are not universally 1/100 (JPY and CLP are 0, KWD
// is 3), and a lookup table is code: correcting a wrong entry in it eight months from now
// would silently re-scale every historical row in that currency by 100x, with no migration
// and no trace. The row's own amount_exp is authoritative for its own arithmetic. The ISO
// table in money.js is consulted for one thing — picking the default when a purchase is
// CREATED — and it is the caller's job to pass it.
//
// VALIDATION BEFORE ENQUEUE, AND IT IS NOT SECURITY. functions/api/purchases.js is the
// authority and checks all of this again. This copy exists so that an impossible write never
// gets in FRONT of the queue, where a permanent 400 would be dropped a day later with the
// person's actual input already forgotten — the same reasoning setNoteColor() gives for
// checking the palette locally.
const SPLIT_MODES = ["weight", "exact"];
// Nobody splits a taxi 33 ways, and it happens to keep functions/api/purchases.js's one
// membership query inside D1's 100-bound-parameter cap.
const MAX_PARTICIPANTS = 32;
// Number.isSafeInteger is the real bound — D1 stores a 64-bit integer and JS reads it back as
// a double, so anything past 2^53 comes back WRONG rather than rejected. 1e15 is well under
// that and already absurd: a billion dollars at a market stall is a typo.
const MAX_AMOUNT_MINOR = 1e15;

// ALL FIVE OR NONE, and this is the queue, not tidiness. enqueue()'s fold is a SHALLOW merge
// ({ ...prev.payload, ...op.payload }) and so is replayQueue()'s update branch, so an ARRAY
// field is replaced WHOLESALE by whichever patch lands last. An incremental "just change
// Maya's share" patch silently discards everybody else's the moment two edits fold — which
// offline is most of the time. Send the whole economic tuple or none of it and the fold cannot
// be wrong. functions/api/purchases.js refuses a partial one by name, at 400.
const ECONOMIC = ["amount_minor", "currency", "amount_exp", "split_mode", "shares"];

// spent_at is epoch SECONDS on both sides, exactly like events.starts_at, so this is the same
// bound functions/api/trip.js's validEpoch() uses. A client that passed Date.now() would land
// ~1000x in the future and sit at one end of the feed forever, which reads as "my purchase
// vanished" rather than as a bug.
const validSeconds = (v) => Number.isInteger(v) && v > 0 && v < 1e11;

// The roster ids, or null when this phone has never synced. Null means "there is nothing to
// check against", NOT "nobody is on this trip": refusing a purchase because the roster has not
// landed would fail closed on a cold offline launch, which is the one moment this app exists
// for. The server holds the real check (requireMember() plus a per-id trip_members lookup —
// the first surface in this codebase whose body names other users).
function rosterIds() {
  const ids = new Set((cache.members || []).map((m) => m && m.id).filter(Boolean));
  return ids.size ? ids : null;
}

/**
 * Validate the economic tuple and RESOLVE share_minor. Shared by addPurchase() and
 * updatePurchase() so there is one spelling of these rules on the client, the way there is one
 * in functions/api/purchases.js's readFields().
 *
 * share_minor is RECOMPUTED here and never taken from the caller. One implementation of the
 * rounding, one answer, on every device: allocate() is seeded with the purchase id, so the
 * odd céntimo of a three-way split lands on the same person on four phones that are all
 * offline and have never spoken to each other.
 *
 * There is NO branch for the equal case (equal and unequal are stored with the same shape,
 * not two kinds of purchase). Under split_mode 'exact' the weights ARE minor
 * amounts and must sum to the amount, so totalWeight === total, every floor is the weight
 * itself, the remainder is zero, and allocate() hands the weights straight back.
 */
function economicsOf(src, id) {
  const amount = src.amount_minor;
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error("amount must be a positive whole number of minor units");
  if (amount > MAX_AMOUNT_MINOR) throw new Error("that amount is implausibly large");

  const currency = String(src.currency == null ? "" : src.currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("pick a currency");

  // Defaulted only when genuinely absent, then checked. `Number.isInteger(x) ? x : 2` would
  // quietly turn a typo into 2 and store a hundred-fold wrong amount, which is exactly the
  // class of thing this check exists to catch before it reaches the queue.
  const exp = src.amount_exp === undefined || src.amount_exp === null ? 2 : src.amount_exp;
  if (!Number.isInteger(exp) || exp < 0 || exp > 4) throw new Error("bad currency exponent");
  // The exponent is NOT cross-checked against the code here. That check needs the ISO table,
  // which lives in money.js and is where the caller got the exponent from in the first place;
  // a second copy of that table in this file is precisely how end_tz went missing. The server
  // holds the cross-check for the ~25 currencies whose exponent is not 2.

  const mode = src.split_mode === undefined || src.split_mode === null ? "weight" : String(src.split_mode);
  if (!SPLIT_MODES.includes(mode)) throw new Error("unknown split mode");

  // CONTRACT ORDER: user_id ascending, applied on the way in, once. It is load-bearing twice
  // over — allocate()'s tie-break rotation has to land on the same person on every device, and
  // signature() hashes JSON.stringify(row), so a shares array that came back in a different
  // order every snapshot would hash differently every time, fire "change", re-render every
  // mounted module and blink the agenda's photographs (via the money
  // screen). functions/api/purchases.js sorts the same way, on the way in, for the same reason.
  const input = (Array.isArray(src.shares) ? src.shares : []).slice()
    .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
  if (!input.length) throw new Error("somebody has to be splitting it");
  if (input.length > MAX_PARTICIPANTS) throw new Error("too many people are splitting that");
  // Checked before the roster check rather than left to it: rosterIds() is null on a phone
  // that has never synced, and without this a share with no user_id would sail past every
  // check here and become a permanent 400 four days later.
  if (input.some((s) => !s || typeof s.user_id !== "string" || !s.user_id))
    throw new Error("every share needs a person");
  if (new Set(input.map((s) => s.user_id)).size !== input.length)
    throw new Error("somebody is in the split twice");
  const roster = rosterIds();
  if (roster && input.some((s) => !roster.has(s.user_id)))
    throw new Error("somebody in the split is not on this trip");

  const weights = input.map((s) => s.weight);
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0))
    throw new Error("a share has to be a whole number, and not negative");
  const sumW = weights.reduce((a, w) => a + w, 0);
  if (sumW <= 0) throw new Error("the shares are all zero");
  if (mode === "exact" && sumW !== amount)
    throw new Error("exact shares have to add up to the amount");

  // Once for the whole set, not once per person: allocate() distributes the remainder across
  // the list, so it only has an answer for a share in the context of all the others.
  const resolved = allocate(amount, weights, id);
  return {
    amount_minor: amount,
    currency,
    amount_exp: exp,
    split_mode: mode,
    shares: input.map((s, i) => ({
      user_id: s.user_id, weight: s.weight, share_minor: resolved[i],
    })),
  };
}

/**
 * The payload is a COMPLETE row, and that is not a style note: replayQueue() re-applies a
 * create as `{ ...op.payload }`, so a field missing here is a field missing PERMANENTLY on any
 * device that replays it. The key order is deliberately the same as functions/api/purchases.js's
 * shape(), so the row the server echoes back differs from the optimistic one only where it
 * genuinely differs (trimmed text, seconds instead of milliseconds) rather than in every byte.
 *
 * A BLANK DESCRIPTION IS LEGAL. The quick-entry path skips it
 * and falls back to the attachment name or the entry time when rendering;
 * an empty description is expected, and the list of what the
 * server enforces does not include it, and functions/api/purchases.js accepts "" for exactly
 * this reason. Throwing here would make the headline flow a permanent 400 — dropped days
 * later, silently, with the purchase gone.
 */
async function addPurchase(partial = {}) {
  const me = requireMe();
  const now = stamp();
  const id = partial.id || uid("pu");
  const eco = economicsOf(partial, id);

  // paid_by is WHOSE MONEY LEFT and it is not the author: logging a purchase somebody else
  // paid for is a normal thing to do and the column exists for it; who paid
  // defaults to you when omitted.
  const paid_by = partial.paid_by || me.id;
  const roster = rosterIds();
  if (roster && !roster.has(paid_by)) throw new Error("that person is not on this trip");

  const spent_at = partial.spent_at ?? Math.floor(Date.now() / 1000);
  if (!validSeconds(spent_at)) throw new Error("spent_at must be epoch seconds");

  const day = String(partial.day || "").trim();
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("day must be an ISO date");

  const row = {
    id,
    trip_id: tripId(),
    description: String(partial.description || "").trim().slice(0, 200),
    amount_minor: eco.amount_minor,
    currency: eco.currency,
    amount_exp: eco.amount_exp,
    paid_by,
    split_mode: eco.split_mode,
    spent_at,
    // The attachment: three optional fields, independent, none required; purchases can
    // attach to a day/event/place or float unattached. A floating
    // purchase is "" and two nulls, and it is fully legal. The ids are not checked against the
    // local cache on purpose — the server validates them, and refusing an id this phone has
    // not synced yet would block a legitimate write mid-sync.
    day,
    event_id: partial.event_id || null,
    place_id: partial.place_id || null,
    note: String(partial.note || "").slice(0, 1000),
    kind: "purchase",
    shares: eco.shares,
    created_by: me.id,
    created_at: now,
    updated_at: now,
  };
  return commit("purchase", "create", row.id, row, row);
}

/**
 * What makes a row a payment, as the server checks it on every write (src/api/purchases.js's
 * paymentShape()): one share, for someone other than the person who paid, and no day, event
 * or place. Checked here first so a row the server would refuse never reaches the queue.
 */
function assertPaymentShape({ paid_by, shares, day, event_id, place_id }) {
  if (!Array.isArray(shares) || shares.length !== 1) throw new Error("a payment goes to one person");
  if (shares[0].user_id === paid_by) throw new Error("a payment goes to someone other than the person who paid it");
  if (day || event_id || place_id) throw new Error("a payment isn't tied to a day, a plan or a place");
}

/**
 * A payment: one person gave another money to settle up. The same row as a purchase, through
 * the same queue (it works with no signal), with `kind: "payment"` and ONE share: the person
 * who received it, for the whole amount. No description, no day, nothing attached.
 *
 *   addPayment({ from, to, amount_minor, currency, amount_exp })
 *
 * `from` is the person who paid (you, unless said). Whoever writes it down need be neither.
 */
async function addPayment(partial = {}) {
  const me = requireMe();
  const now = stamp();
  const id = partial.id || uid("pu");
  const from = partial.from || me.id;
  const to = String(partial.to || "");
  if (!to) throw new Error("say who received it");
  const roster = rosterIds();
  if (roster && !roster.has(from)) throw new Error("that person is not on this trip");
  const eco = economicsOf({
    amount_minor: partial.amount_minor, currency: partial.currency, amount_exp: partial.amount_exp,
    split_mode: "exact", shares: [{ user_id: to, weight: partial.amount_minor }],
  }, id);
  assertPaymentShape({ paid_by: from, shares: eco.shares });

  const spent_at = partial.spent_at ?? Math.floor(Date.now() / 1000);
  if (!validSeconds(spent_at)) throw new Error("spent_at must be epoch seconds");

  // The same keys in the same order as a purchase's row (and the server's shape()).
  const row = {
    id,
    trip_id: tripId(),
    description: "",
    amount_minor: eco.amount_minor,
    currency: eco.currency,
    amount_exp: eco.amount_exp,
    paid_by: from,
    split_mode: eco.split_mode,
    spent_at,
    day: "",
    event_id: null,
    place_id: null,
    note: "",
    kind: "payment",
    shares: eco.shares,
    created_by: me.id,
    created_at: now,
    updated_at: now,
  };
  return commit("purchase", "create", row.id, row, row);
}

/**
 * Correct a payment: who paid, who received it, how much, in which currency. Anything left
 * out stays. It is still one share for the whole amount afterwards, so the amount and the
 * receiver always travel together.
 */
async function updatePayment(id, patch = {}) {
  const cur = cache.purchases.get(id);
  if (!cur) throw new Error("payment not found");
  if (cur.kind !== "payment") throw new Error("that is a purchase, not a payment");
  const to = String(patch.to || (cur.shares[0] && cur.shares[0].user_id) || "");
  const amount = patch.amount_minor ?? cur.amount_minor;
  const p = {
    amount_minor: amount,
    currency: patch.currency ?? cur.currency,
    amount_exp: patch.amount_exp ?? cur.amount_exp,
    split_mode: "exact",
    shares: [{ user_id: to, weight: amount }],
  };
  if (patch.from && patch.from !== cur.paid_by) p.paid_by = patch.from;
  if ("spent_at" in patch) p.spent_at = patch.spent_at;
  return updatePurchase(id, p);
}

/**
 * The after-the-fact unequal split is an ORDINARY UPDATE — tapping an existing
 * purchase to switch to an unequal split updates a purchase that
 * was already saved and already synced. Equal is what a purchase is born with, not a mode it is
 * locked into, so there is no second write path and no conversion step: the weights and the
 * mode are patched on the row that is already there. If the create is still queued the fold
 * merges this into it and one POST goes out carrying the final answer.
 */
async function updatePurchase(id, patch = {}) {
  const cur = cache.purchases.get(id);
  if (!cur) throw new Error("purchase not found");
  if (!canEditPurchase(cur))
    throw new Error("that purchase is someone else's — whoever added it or paid for it can change it");

  const p = { ...patch };
  delete p.id; delete p.trip_id; delete p.created_by; delete p.created_at;   // never patchable
  delete p.kind;   // fixed when the row is made

  const touched = ECONOMIC.filter((k) => k in p);
  if (touched.length && touched.length !== ECONOMIC.length)
    throw new Error(`changing the amount or the split has to send all of: ${ECONOMIC.join(", ")}`);
  if (touched.length) {
    const eco = economicsOf(p, id);
    p.amount_minor = eco.amount_minor;
    p.currency = eco.currency;
    p.amount_exp = eco.amount_exp;
    p.split_mode = eco.split_mode;
    p.shares = eco.shares;
  }

  // paid_by moves money between people but touches no sum, so it needs no companion and is
  // freely patchable on its own — as are description, note, day, event_id, place_id, spent_at.
  if ("paid_by" in p) {
    p.paid_by = String(p.paid_by || "");
    const roster = rosterIds();
    if (!p.paid_by) throw new Error("somebody has to have paid");
    if (roster && !roster.has(p.paid_by)) throw new Error("that person is not on this trip");
  }
  if ("spent_at" in p && !validSeconds(p.spent_at)) throw new Error("spent_at must be epoch seconds");
  if ("day" in p) {
    p.day = String(p.day || "").trim();
    if (p.day && !/^\d{4}-\d{2}-\d{2}$/.test(p.day)) throw new Error("day must be an ISO date");
  }
  if ("description" in p) p.description = String(p.description || "").trim().slice(0, 200);
  if ("note" in p) p.note = String(p.note || "").slice(0, 1000);
  if ("event_id" in p) p.event_id = p.event_id || null;
  if ("place_id" in p) p.place_id = p.place_id || null;

  // A payment must still be one after the change: the row as it will be, not only what changed.
  if (cur.kind === "payment") assertPaymentShape({ ...cur, ...p });

  p.updated_at = stamp();
  return commit("purchase", "update", id, p, { ...cur, ...p });
}

async function deletePurchase(id) {
  const cur = cache.purchases.get(id);
  if (!cur) throw new Error("purchase not found");
  if (!canEditPurchase(cur))
    throw new Error("that purchase is someone else's — whoever added it or paid for it can delete it");
  await commit("purchase", "delete", id, null, null);
}

// ── the trip's currencies, the cached rates, and your own ───────────────────────────────

/** The trip's short list, in the server's order — first entry is the trip's home currency. */
function currencies() { return (cache.currencies || []).slice(); }

/** The cached exchange table. Frozen on the way in (fxOf), so this is the object itself. */
function fx() { return cache.fx; }

/**
 * "I just got signal — show me my totals." The one non-row call in this file, and it keeps
 * "nothing else in the app calls fetch()" true: the rates come from OUR origin, never from a
 * third party on the phone, because that would be a second network dependency, a CORS surface
 * and a captive-portal failure mode on the device with the least signal.
 *
 * GET /api/trip carries the rates too, but its refresh is fired through waitUntil() on the
 * server, so the numbers would otherwise arrive on the NEXT snapshot — up to HEARTBEAT_MS
 * later.
 *
 * NOT a queued write: it changes nothing on the server that belongs to anybody, so there is
 * nothing to replay and nothing to fold. Offline it is a no-op that returns the table it
 * already has — isOnline() is false, and req() would coerce a captive portal's 200 text/html
 * into { ok:false, status:0 } anyway.
 */
async function refreshRates() {
  if (!isOnline()) return cache.fx;
  const res = await req("POST", "/api/fx/refresh");
  if (res.ok && res.body && res.body.fx && res.body.fx.rates) {
    cache.fx = fxOf(res.body.fx);
    // persistAll() only when the hash actually moved, for the same reason refresh() does it
    // that way; otherwise just the one meta key, so a rate poll on a phone that is already
    // current does not rewrite ~370 rows to IndexedDB.
    if (emitChange()) persistAll(); else setMeta("fx", cache.fx);
  }
  return cache.fx;
}

// Your native currency: the one the settle-up totals are shown in. Per USER, not per trip —
// Converted to each user's native currency, so two people on one trip
// can want two different answers. The same SINGLETON shape as note_color and initials, so it
// takes the same path: apply locally, emit, enqueue one folded kind:"me" PATCH, persist, flush.
//
// Unlike applyNoteColor() there is only ONE place to touch — purchases deliberately do not
// denormalise it, because there is no leave/remove route in this app and so a share's user_id
// is always in store.members(). The day a leave route appears, that decision reverses.
function applyNativeCurrency(userId, code) {
  if (!userId) return;
  cache.members = (cache.members || []).map((m) =>
    (m && m.id === userId ? Object.freeze({ ...m, native_currency: code }) : m));
  invalidate();
}

/** Defaults to USD rather than null: the settle-up has to name a currency to render at all. */
function myNativeCurrency() {
  const me = cache.me;
  if (!me || !me.id) return "USD";
  const mine = (cache.members || []).find((m) => m && m.id === me.id);
  return (mine && mine.native_currency) || "USD";
}

async function setNativeCurrency(raw) {
  const me = requireMe();
  const code = String(raw || "").trim().toUpperCase();
  // Shape only, and NOT membership of cache.currencies. The picker offers money.js's ISO
  // table, and refusing a code merely because this trip has not spent anything in it yet would
  // block the very first thing a person does — choose their home currency before there is a
  // single purchase to widen the list with. functions/api/me.js is the authority.
  if (!/^[A-Z]{3}$/.test(code)) throw new Error("pick a currency");
  if (myNativeCurrency() === code) return code;      // already yours; nothing to send
  applyNativeCurrency(me.id, code);
  emitChange();
  await enqueue({ kind: "me", op: "update", id: me.id, payload: { native_currency: code }, at: Date.now() });
  persistAll();
  flush();
  return code;
}

// ── read accessors ──────────────────────────────────────────────────────────────────────
// Synchronous by contract. Arrays are fresh copies so a caller may sort them in place; the
// rows inside are shared and frozen.
function events() {
  if (!sortedCache.events) {
    sortedCache.events = [...cache.events.values()].sort(
      (a, b) => a.starts_at - b.starts_at || (a.created_at || 0) - (b.created_at || 0) ||
                (a.id < b.id ? -1 : 1));
  }
  return sortedCache.events.slice();
}
/** The trip's reference list, in its order (position, then when each was added). */
function references() {
  if (!sortedCache.references) {
    sortedCache.references = [...cache.references.values()].sort(
      (a, b) => (a.position ?? 0) - (b.position ?? 0) || toMs(a.created_at) - toMs(b.created_at) || (a.id < b.id ? -1 : 1));
  }
  return sortedCache.references.slice();
}
function places() {
  if (!sortedCache.places) {
    sortedCache.places = [...cache.places.values()].sort(
      (a, b) => a.name.localeCompare(b.name, "en"));
  }
  return sortedCache.places.slice();
}
function packing(owner) {
  return [...cache.packing.values()]
    .filter((r) => r.owner === owner)
    .sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.label.localeCompare(b.label, "en"));
}
/**
 * The newest two messages about the time before a plan, oldest first, as of the last snapshot:
 * [{ id, author, author_name, body, created_at }]. The Agenda writes them on the free time.
 */
function talkBefore(eventId) {
  const list = cache.chat && cache.chat.before_recent && cache.chat.before_recent[eventId];
  return Array.isArray(list) ? list.slice() : [];
}

/** The chat's counts as kept: every key there, each a map of id to a whole number. */
function chatOf(v) {
  const out = { event: {}, place: {}, purchase: {}, before: {}, before_recent: {} };
  if (v && typeof v === "object") for (const k of Object.keys(out)) if (v[k] && typeof v[k] === "object") out[k] = { ...v[k] };
  return out;
}
/**
 * How many of the chat's messages are about a thing, as of the last snapshot: a plan's own
 * (talkAbout("event", id)), the time before it (talkAbout("event", id, "before")), a place's, a
 * purchase's. A plan's own leaves out those about the time before it.
 */
function talkAbout(kind, id, part = null) {
  const c = cache.chat || chatOf(null);
  if (part === "before") return (kind === "event" && c.before[id]) || 0;
  const all = (c[kind] && c[kind][id]) || 0;
  return kind === "event" ? Math.max(0, all - (c.before[id] || 0)) : all;
}

/**
 * The feed: NEWEST FIRST, and the tie-break goes through toMs() for the same reason the notes did
 * does.
 *
 * spent_at is epoch SECONDS on BOTH sides — functions/api/purchases.js validEpoch-checks it
 * exactly like starts_at — so it is comparable raw, and it is the primary key of this sort
 * because "the taxi yesterday" is a normal thing to add today. created_at is NOT comparable
 * raw: the API returns seconds and stamp() writes milliseconds, so an unflushed purchase and
 * a synced one differ by a factor of a thousand and every pending row would pin itself to one
 * end of the feed regardless of when it was entered. That is exactly the bug notes() was fixed
 * for and a purchases feed hits it identically.
 */
function purchases() {
  if (!sortedCache.purchases) {
    sortedCache.purchases = [...cache.purchases.values()].sort(
      (a, b) => (b.spent_at || 0) - (a.spent_at || 0) ||
                (toMs(b.created_at) || 0) - (toMs(a.created_at) || 0) ||
                (a.id < b.id ? 1 : -1));
  }
  return sortedCache.purchases.slice();
}

// Never null, so `row.created_by === store.me().id` is safe before the first /api/me lands.
// A null id matches nothing, which correctly hides every edit control until identity is known.
const ANON = Object.freeze({ id: null, name: "" });

// ── lifecycle ───────────────────────────────────────────────────────────────────────────
// Ask the OS to stop treating this origin as disposable. Everything the trip depends on
// offline — the itinerary, the notes, and BOTH write queues — lives in IndexedDB in a
// best-effort origin, next to ~10 MB of precached shell, tiles and photographs. sw.js already
// reasons about iOS evicting an over-quota origin WHOLE; this is the one call that changes
// that classification, and it was never made. Eviction takes the unflushed queue with it, and
// by construction that queue is the only copy of anything written on the trail.
// Fire-and-forget: it needs no permission prompt in practice, and a browser that refuses or
// does not implement it must not break boot.
let persisted = null;                 // null = not asked yet / unsupported
async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return;
    persisted = await navigator.storage.persisted?.() || false;
    if (!persisted) persisted = await navigator.storage.persist();
    console.info("[store] persistent storage:", persisted);
  } catch (e) {
    console.warn("[store] persist() failed", e);
  }
}

async function ready() {
  if (readyP) return readyP;
  readyP = (async () => {
    if (!TRIP) throw new Error("no trip in the address");
    requestPersistence();                         // not awaited; boot must not wait on it
    // The phone's list names this trip before the trip's database exists. Not when the list
    // is somebody else's: the gate below clears the phone first, and the page starts again.
    if (ownerVerdict(keptOwner(), sessionAccount()) !== "other") keepHere();
    await adoptOld();
    await ownerGate();                            // before a single stored row is read
    await hydrate();
    keepHere();
    const cold = cache.events.size === 0 && cache.places.size === 0;
    if (cold) {
      // The "reads never await the network" rule describes the steady state. On the very
      // first launch there is nothing to read, and flashing an empty agenda before the data
      // arrives half a second later is worse than a brief spinner. Capped, so a cold start
      // with no signal still boots — into an empty app with an offline banner, honestly.
      await Promise.race([refresh(), new Promise((r) => setTimeout(r, COLD_BOOT_WAIT_MS))]);
    } else {
      refresh();                                  // warm: never awaited
    }
    wireTriggers();
    flush();
  })();
  return readyP;
}

/**
 * The heartbeat's pull and the one on coming back: the trip's rev first (one row), and the trip only when
 * what the snapshot holds moved since this phone's (data_rev), or it's owed a whole one, or it hasn't pulled
 * in PULL_ANYWAY_MS. An answer that says nothing moved still counts as hearing from the server.
 */
async function refreshIfMoved() {
  if (gone) return false;
  if (wholeNext || !held || held.data_rev === null || Date.now() - lastPullAt > PULL_ANYWAY_MS || !isOnline()) return refresh();
  const r = await req("GET", T("/rev"));
  if (r.ok && r.body && r.body.data_rev === held.data_rev) {
    lastSync = Date.now();
    await setMeta("last_sync", lastSync);
    emit("status", status());
    return true;
  }
  return refresh();
}

let wired = false;
function wireTriggers() {
  if (wired) return;
  wired = true;
  // The trip's socket (live.js): another person's change arrives within seconds, and does what the
  // heartbeat below does. Without a socket nothing changes: the heartbeat goes on.
  live.on("data", () => { if (queue.length) flush(); else refresh(); });
  addEventListener("online", () => { setNet(true); retryStep = 0; flush(); refresh(); });
  addEventListener("offline", () => setNet(false));
  // Coming back to the app is the single most likely moment for the radio to have returned
  // — walking out of a valley, landing, reconnecting to hotel wifi.
  addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    setNet(true);
    flush();
    if (Date.now() - lastSync > HEARTBEAT_MS) refreshIfMoved();
  });
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    // The heartbeat must PROBE the radio, not consume the last verdict. netOk is only ever
    // cleared by a failed request and only ever set by a successful one, so a heartbeat that
    // skipped while offline could never be the thing that noticed the signal returned — and a
    // phone that reacquires a cell radio while the app is open fires no `online` event and no
    // visibilitychange. Optimistically clearing the latch first is the same trick
    // scheduleRetry() already uses; a failed probe puts it straight back.
    if (!isOnline()) setNet(true);
    if (queue.length) flush(); else refreshIfMoved();
  }, HEARTBEAT_MS);
}

export const store = {
  ready,

  trip: () => cache.trip,
  // The trip this page is, from its address: known before anything is stored or fetched.
  tripId,
  // The API address of something this trip holds, for the modules that fetch for themselves
  // (memories.js): store.tripApi("/memories") is /api/trips/<id>/memories.
  tripApi: T,
  // The sign-in page, told to come back to this trip and section.
  signInAddress,
  events,
  places,
  packing,
  talkAbout,
  talkBefore,
  purchases,
  me: () => cache.me || ANON,
  // Fresh array, frozen rows — the roster is read for people's colors.
  members: () => (cache.members || []).slice(),
  // The trip's areas (the same array until the next snapshot, so a reader can tell "unchanged"
  // by identity) and the state of its offline map.
  areas: () => cache.areas || [],
  appsAdding: () => cache.appsAdding || [],
  tiles: () => cache.tiles || null,
  // Does this site make maps? true, false, or null when no snapshot has said yet.
  mapsMade: () => cache.maps,
  // The palette of people's colors off the snapshot, and the one write that changes YOUR row in
  // it. Every picker of Your color goes through exactly these two.
  noteColors,
  myNoteColor,
  setNoteColor,
  myInitials,
  setInitials,
  tabLayout: myTabLayout,
  setTabLayout,

  // Split. Purchases are an ordinary rowstore; the two money singletons ride `meta`
  // exactly like the roster and the palette, so they survive a cold offline launch.
  currencies,
  fx,
  refreshRates,
  myNativeCurrency,
  setNativeCurrency,

  addEvent,
  updateEvent,
  deleteEvent,
  setTripDates,
  addPlace,
  updatePlace,
  deletePlace,
  references,
  addReference,
  updateReference,
  deleteReference,
  placeUses,
  setPacking,
  addPacking,
  deletePacking,

  // Packing's structure. The lists are the trip's, frozen, in order, each with its bags.
  packLists: () => cache.pack.lists,
  packStarters: () => cache.pack.starters,
  packBag: (itemId, listKey) => cache.pack.placements.get(placeKey(itemId, listKey)) || null,
  packTicked: (itemId, listKey, day) => cache.pack.ticks.has(tickKey(itemId, listKey, day)),
  packHeld,
  packDay,
  tickPacking,
  placePacking,
  addPackList,
  setPackList,
  deletePackList,
  addPackBag,
  setPackBag,
  deletePackBag,
  addPurchase,
  updatePurchase,
  deletePurchase,
  addPayment,
  updatePayment,

  on(name, fn) {
    (listeners[name] || (listeners[name] = new Set())).add(fn);
    return () => listeners[name].delete(fn);
  },
  off(name, fn) { listeners[name] && listeners[name].delete(fn); },

  online: isOnline,
  pending: () => waitingCount(),
  readAside,
  keepAside,
  // Whether this person muted this trip's chat (null before the first snapshot), and the chat
  // header's own write of it, kept as the server answered it.
  chatMuted: () => cache.chatMuted ?? null,
  setChatMuted: (v) => { cache.chatMuted = !!v; setMeta("chat_muted", cache.chatMuted); emit("change"); },
  oldTold: () => oldTold.slice(),
  dismissOldTold,
  // For the other modules that keep their own data and queue on this phone (packing.js,
  // memories.js): the same two answers this file acts on. See the import of forget.js.
  accountKnown: () => accountKnown,
  phoneCleared,
  // Whether the OS promised not to evict this origin. null until the answer is known (or the
  // browser has no such notion). Surfaced so the Settings card can tell the trip owner whether
  // the four phones actually got persistent storage BEFORE they leave, rather than finding out
  // at 4200 m that one of them did not.
  persisted: () => persisted,

  // Additive conveniences. They exist so four view modules do not each write the same
  // three-line find() and the same ownership comparison — divergence there is how a
  // permission rule quietly stops matching the API.
  event: (id) => cache.events.get(id) || null,
  place: (id) => cache.places.get(id) || null,
  purchase: (id) => cache.purchases.get(id) || null,
  canEdit,
  // Author OR payer, and NOT canEdit() — see the comment on the function. assertOwn() is
  // author-only and would lock a payer out of their own money.
  canEditPurchase,
  lastSync: () => lastSync,
  status,
  // These two are the app's "try now": the Settings sync button, the shell's netpill tap, and
  // the retry after a rejected write. They are the only manual way out of a stale offline
  // verdict, so a call from outside the store clears the netOk latch before trying — without
  // this, tapping "Sync now" on a phone that has signal again sends literally nothing.
  refresh: () => { setNet(true); return refresh(); },
  flush: () => { setNet(true); return flush(); },
};

export default store;

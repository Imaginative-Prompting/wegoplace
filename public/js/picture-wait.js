// Pictures made on this phone and not yet on the server, for any target: a purchase's receipt, a
// place's or a plan's photo, the trip's cover. Taking one is free and needs no signal: it is made
// to its size (picture-make.js), held in this trip's own database, and sent once the row it
// belongs to is on the server. Until then whatever shows it says it waits; a refusal stays, with
// the server's words, until the person replaces or removes it (a picture never disappears without
// a word). One store, one retry schedule and one count for every kind; forget.js clears it.
// Sent means forgotten in a transaction awaited to its end; a page closed in the milliseconds
// between the server's 200 and that end sends it once more on the next launch: a PUT that replaces,
// so the cost is the bytes, never a second picture (known and left, 15 Nov).
//
// Not in store.js's write queue, which carries rows: a picture is
// bytes, and a queue stalled on a 600 KB upload would hold every row behind it.
//
// A target is { trip, kind, id }:
//   kind "purchase" (a receipt; id = the purchase), "place", "event"   PUT/DELETE /api/trips/<trip>/pictures/<kind>/<id>
//   kind "cover" (no id)                                                PUT/DELETE /api/trips/<trip>/pictures/cover
// (src/trips/pictures.js; ?license=own: the person's own picture.)
//
//   start(store)                       for the trip's store: reads what waits, sends it whenever there is signal
//   startForTrip(tripId)               a page with no trip store (the trip's own page): the cover only
//   await holdPicture(target, file)    -> { status: "sent" } | { status: "waiting" } | { status: "refused", reason }
//                                         made to the target's size here; a file that can't be made is refused in words
//   await holdMade(target, made, { wait })   the same with a picture already made ({ blob, w, h });
//                                         wait: false answers at once and lets the sending go on
//   await removePicture(target, { onServer })   one waiting here goes at once; one on the server when there is signal
//   await rowGone(target)              the row itself was deleted: whatever waits for it goes
//   waitingFor(target)                 -> null | { state: "waiting" | "refused" | "removing", url, w, h, reason, status }
//   on("change", fn)                   -> the unsubscribe; called whenever what waits changes
//   waitingCount()                     how many wait (refused ones not counted)
//   sendWaiting()                      sends now; answers how many still wait
//
// What this phone holds, one record per target in the "waiting" store, keyed `${kind}:${id}`:
//   { key, kind, id, op: "put", blob, w, h, bytes, added_at, refused: null | { status, reason } }
//   { key, kind, id, op: "remove", added_at }

import { PICTURE_LIMITS } from "./shared/limits.js";
import { makePicture } from "./picture-make.js";
import { dbName, tripApi } from "./trip-here.js";
import { within, sendBytes } from "./net.js";

export const DB_BASE = "wegoplace-picture-wait";
const RETRY_MS = [3_000, 10_000, 30_000, 60_000, 120_000];
const KINDS = new Set(["purchase", "place", "event", "cover"]);

/** The size a target's picture is made to: a receipt's, or a picture's (as the server's roleOf). */
export const limitsFor = (kind) => (kind === "purchase" ? PICTURE_LIMITS.receipt : PICTURE_LIMITS.picture);

const keyOf = (target) => `${target.kind}:${target.kind === "cover" ? "" : target.id}`;
function check(target) {
  if (!target || !KINDS.has(target.kind)) throw new Error(`picture-wait: no such kind: ${target && target.kind}`);
  if (S && S.storeless && target.kind !== "cover") throw new Error("picture-wait: started for a page with no trip store, which holds the cover only (start(store) for the rest)");
  if (target.kind !== "cover" && !target.id) throw new Error("picture-wait: a target needs its id");
  if (S && target.trip && target.trip !== TRIP) throw new Error("picture-wait: started for another trip");
}

// ── the trip's database ─────────────────────────────────────────────────────────────────────
let TRIP = "";
let dbP = null;
function db() {
  if (dbP) return dbP;
  dbP = new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(DB_BASE, TRIP), 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("waiting", { keyPath: "key" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbP;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("waiting", mode);
    const out = fn(t.objectStore("waiting"));
    t.oncomplete = () => resolve(out && "result" in out ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// What waits, in memory, by key: read once, then kept in step with every write here.
const held = new Map();
const urls = new Map();          // key -> an object URL for its waiting picture
let readP = null;
let S = null;                    // the trip's store
const views = new Set();

function changed() {
  for (const fn of views) { try { fn(); } catch (e) { console.warn("[picture-wait] a view threw", e); } }
}
function urlOf(key) {
  const r = held.get(key);
  if (!r || r.op !== "put" || !r.blob) return null;
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(r.blob));
  return urls.get(key);
}
function dropUrl(key) {
  const u = urls.get(key);
  if (u) { URL.revokeObjectURL(u); urls.delete(key); }
}
function read() {
  if (readP) return readP;
  readP = (async () => {
    try { for (const r of await tx("readonly", (s) => s.getAll())) held.set(r.key, r); }
    catch (e) { console.warn("[picture-wait] couldn't read what waits on this phone", e); }
    changed();
  })();
  return readP;
}
async function keep(rec) {
  if (S && S.phoneCleared && S.phoneCleared()) return;
  dropUrl(rec.key);
  held.set(rec.key, rec);
  changed();
  await tx("readwrite", (s) => s.put(rec));
}
async function forget(key) {
  dropUrl(key);
  held.delete(key);
  changed();
  await tx("readwrite", (s) => s.delete(key)).catch(() => {});
}

// ── the API ─────────────────────────────────────────────────────────────────────────────────

/**
 * A page with no trip store (the trip's own page, trips.html and trip-people.html, where the cover is
 * changed): only the cover hangs on nothing the store queues, so that is all such a page holds; its
 * rows go when there is signal, as from the app. A place's or a plan's picture needs start(store).
 */
export function startForTrip(tripId) {
  return start({
    tripId: () => tripId, trip: () => ({ id: tripId }), pending: () => 0, phoneCleared: () => false,
    refresh: async () => {}, on: () => () => {}, place: () => null, event: () => null, purchase: () => null, storeless: true,
  });
}

export function start(store) {
  if (S === store) return read();
  if (S && S.storeless && !store.storeless && store.tripId() === TRIP) S = null;   // the app's own store takes over from a page's stand-in
  S = store;
  TRIP = store.tripId();
  read().then(() => sendWaiting());
  addEventListener("online", () => sendWaiting());
  // The row a picture belongs to reaches the server through the store's queue: each time that
  // queue empties, a picture that was waiting for its row can go.
  store.on("status", (st) => { if (st && !st.pending && st.online) sendWaiting(); });
  return readP;
}

export function on(what, fn) {
  if (what !== "change") throw new Error(`picture-wait: no such event: ${what}`);
  views.add(fn);
  return () => views.delete(fn);
}

export function waitingFor(target) {
  check(target);
  const key = keyOf(target);
  const r = held.get(key);
  if (!r) return null;
  if (r.op === "remove") return { state: "removing" };
  return r.refused
    ? { state: "refused", url: urlOf(key), w: r.w, h: r.h, reason: r.refused.reason, status: r.refused.status }
    : { state: "waiting", url: urlOf(key), w: r.w, h: r.h };
}

export const waitingCount = () => [...held.values()].filter((r) => !r.refused).length;

/** What became of a target after a send: sent, waiting, or refused with the server's words. */
function outcome(key) {
  const r = held.get(key);
  if (!r) return { status: "sent" };
  if (r.refused) return { status: "refused", reason: r.refused.reason };
  return { status: "waiting" };
}

export async function holdMade(target, made, { wait = true } = {}) {
  check(target);
  const key = keyOf(target);
  await keep({ key, kind: target.kind, id: target.kind === "cover" ? null : target.id, op: "put",
    blob: made.blob, w: made.w, h: made.h, bytes: made.blob.size, added_at: Date.now(), refused: null });
  // wait: false leaves the sending to go on by itself (a drawer that closes on Save doesn't
  // stand while 600 KB goes up); the answer is then "waiting" until it has.
  if (!wait) { sendWaiting(); return outcome(key); }
  await sendWaiting();
  return outcome(key);
}

export async function holdPicture(target, file) {
  check(target);
  let made;
  try { made = await makePicture(file, limitsFor(target.kind)); }
  catch (e) { return { status: "refused", reason: e.message }; }
  return holdMade(target, made);
}

export async function removePicture(target, { onServer = true } = {}) {
  check(target);
  const key = keyOf(target);
  if (onServer) await keep({ key, kind: target.kind, id: target.kind === "cover" ? null : target.id, op: "remove", added_at: Date.now() });
  else await forget(key);
  await sendWaiting();
}

export async function rowGone(target) {
  check(target);
  const key = keyOf(target);
  if (held.has(key)) await forget(key);
}

// ── sending ─────────────────────────────────────────────────────────────────────────────────
let sending = null;
let retryStep = 0;
let retryTimer = 0;

function scheduleRetry() {
  clearTimeout(retryTimer);
  const ms = RETRY_MS[Math.min(retryStep, RETRY_MS.length - 1)];
  retryStep++;
  retryTimer = setTimeout(() => sendWaiting(), ms);
}

// A picture's bytes go up through net.js's upload, given up only when nothing moves for 30 s; the
// rest is a short call under its limit (20 s for a write). Either way, given up is no signal.
async function call(method, path, body, type) {
  if (body instanceof Blob) {
    const r = await sendBytes(path, body, { method, type });
    return { ok: r.ok, status: r.status, json: r.body };
  }
  return within(method, async (signal) => {
    try {
      const res = await fetch(path, {
        method, credentials: "same-origin", body, signal,
        headers: { Accept: "application/json", ...(type ? { "Content-Type": type } : {}) },
      });
      let json = null;
      try { json = await res.json(); } catch { if (signal.aborted) return { ok: false, status: 0, json: null }; }
      return { ok: res.ok, status: res.status, json };
    } catch {
      return { ok: false, status: 0, json: null };      // no signal
    }
  });
}

/** The row a target hangs on, as this phone's store has it (the cover hangs on the trip). */
function rowOf(r) {
  if (r.kind === "cover") return S.trip ? S.trip() : true;
  const find = S[r.kind];
  return typeof find === "function" ? find.call(S, r.id) : null;
}

export async function sendWaiting() {
  if (!S) return 0;
  if (sending) return sending;
  sending = (async () => {
    await read();
    let sentAny = false, transient = false;
    for (const r of [...held.values()]) {
      if (r.refused) continue;
      if (S.phoneCleared && S.phoneCleared()) break;
      // A page with no trip store knows the cover's row only: anything else waits for the app (it
      // would read as "its row is gone" here, and be dropped unsent).
      if (S.storeless && r.kind !== "cover") continue;
      const row = rowOf(r);
      // The row is gone from this phone (deleted here, or refused by the server, which the store
      // has already said): its picture has nothing to hang on.
      if (!row && !S.pending()) { await forget(r.key); continue; }
      // Its row hasn't reached the server yet: the picture goes after it.
      if (!row || S.pending()) { transient = true; continue; }
      const path = tripApi(TRIP, r.kind === "cover" ? "/pictures/cover" : `/pictures/${r.kind}/${encodeURIComponent(r.id)}`);
      const res = r.op === "remove"
        ? await call("DELETE", path)
        : await call("PUT", `${path}?license=own`, r.blob, r.blob.type || "image/jpeg");
      if (res.ok) {
        // Sent: the record goes only if it is still the one that was sent (a newer picture taken
        // while this one was on its way stays, and goes next).
        if (held.get(r.key) === r) await forget(r.key);
        sentAny = true;
        continue;
      }
      if (res.status === 0 || res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500) {
        transient = true;
        break;
      }
      if (res.status === 404 && r.op === "put" && /^no such /.test(res.json?.error || "")) {
        // Not on the server (yet, or any more): the next refresh tells which.
        transient = true;
        continue;
      }
      if (r.op === "remove") { await forget(r.key); sentAny = true; continue; }
      const reason = res.json?.reason || (res.status === 413 ? "It is too big to keep." : "It couldn't be kept.");
      if (held.get(r.key) === r) await keep({ ...r, refused: { status: res.status, reason } });
    }
    if (sentAny) {
      // The row's picture comes with the trip: read it now rather than at the next beat.
      try { await S.refresh(); } catch { /* the next refresh brings it */ }
    }
    if (transient) scheduleRetry();
    else retryStep = 0;
    return waitingCount();
  })();
  try { return await sending; } finally { sending = null; }
}

/** For the checks: what this module holds, without the pictures. */
export const pictureWaitState = () => ({
  trip: TRIP,
  held: [...held.values()].map((r) => ({ key: r.key, kind: r.kind, id: r.id, op: r.op, bytes: r.bytes || 0, w: r.w || 0, h: r.h || 0, refused: r.refused })),
});

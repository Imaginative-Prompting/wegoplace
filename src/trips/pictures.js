// Pictures (model §6, §17): one stored image per place, event, the trip's cover, and a purchase's
// receipt. Under /api/trips/<trip>/ (the route table checks the caller is on the trip):
//
//   PUT    pictures/<kind>/<id>              the bytes (the app's way: the phone made the one size)
//   PUT    pictures/cover                    ?license=&credit=&source= on each PUT
//   POST   pictures/<kind>/<id>/from-url     { url, license, credit, source }   (by address)
//   POST   pictures/cover/from-url
//   POST   pictures/<kind>/<id>/upload-link  { license, credit, source } -> { url, expires_at }
//   POST   pictures/cover/upload-link
//   DELETE pictures/<kind>/<id>, DELETE pictures/cover   -> { ok, removed, freed_bytes, rev }
//   and, with no session (the token is the credential): PUT /pictures/upload/<token>
//
// <kind> is place, event or purchase (its receipt). Each answers { picture, rev }, or a refusal
// in words. The snapshot carries each place's and event's `picture`, the trip's `cover` and
// each purchase's `receipt`.
//
// ONE STORED FORM. Whatever way the bytes come, they are read here (src/trips/image.js: JPEG,
// PNG, WebP or AVIF, by their first bytes; the size from their own header) and held to their
// role's one size (PICTURE_LIMITS in public/js/shared/limits.js). They are stored as given: the
// app makes the size on the phone, which re-encodes (a photo's location data goes); by address
// and by upload link the bytes are kept as they came.
//
// STORAGE. A picture is a media_objects row like every file (role 'picture' or 'receipt'), so it
// counts toward the trip's host. Its row is written first, pending, by ONE conditional insert
// that succeeds only if the thing it hangs on exists and the host's storage holds it; the bytes
// go to the bucket after, and the picture is stored by the write that points at it.
//
// REPLACING AND REMOVING go through one function, replaceSteps(): by hand (the app, these
// routes) the old file goes to the drain in the same write; under a change (the MCP: model §9,
// env.CHANGE) the old file is held for the change's undo (files_held): its media_objects row
// stays, stored and counted, and no `pictures` row points at it. Deleting the place, event,
// purchase or trip takes its picture with it (goneSteps, used by their delete paths, the same way).

import { json, readJson } from "../api/json.js";
import { err, nowSec } from "../api/trip.js";
import { mayTouchPurchase } from "../api/purchases.js";
import { randomId, sha256Hex } from "../accounts/util.js";
import { newChange } from "./changes.js";
import { readImage } from "./image.js";
import { fitsSql, limitFor, reservationCut, storageFull } from "./storage.js";
import { queueFiles } from "./drain.js";
import { REV, write } from "./rev.js";
import {
  PICTURE_CREDIT_MAX, PICTURE_FETCH_SECONDS, PICTURE_LICENSE_MAX, PICTURE_LIMITS, PICTURE_LINK_SECONDS,
  PICTURE_REDIRECTS_MAX, PICTURE_SOURCE_MAX,
} from "../../public/js/shared/limits.js";

const KINDS = ["place", "event", "purchase"];
const roleOf = (kind) => (kind === "purchase" ? "receipt" : "picture");
const WHAT = { place: "place", event: "event", purchase: "purchase", cover: "trip" };
export const pictureUrl = (key) => `/media/${key}`;

/** The SQL that says the thing a picture hangs on exists, for parameters ?T (trip) and ?I (its id). */
function targetSql(kind, t, i) {
  // The cover's id is '' (every statement binds the id, and D1 refuses a bound parameter the SQL
  // doesn't name, so it is named here too).
  if (kind === "cover") return `EXISTS (SELECT 1 FROM trips WHERE id = ${t} AND ${i} = '')`;
  if (kind === "place") return `EXISTS (SELECT 1 FROM places WHERE trip_id = ${t} AND id = ${i})`;
  if (kind === "event") return `EXISTS (SELECT 1 FROM events WHERE trip_id = ${t} AND id = ${i})`;
  return `EXISTS (SELECT 1 FROM purchases WHERE trip_id = ${t} AND id = ${i} AND kind = 'purchase')`;
}

/** What the address names: { kind, id } or a refusal. The cover has no id. */
function targetOf(params, cover) {
  if (cover) return { kind: "cover", id: "" };
  let kind, id;
  try { kind = decodeURIComponent(params.kind ?? ""); id = decodeURIComponent(params.id ?? ""); } catch { return { bad: err(400, "bad address") }; }
  if (!KINDS.includes(kind)) {
    return { bad: err(404, "no such kind", { reason: "A picture hangs on a place, an event or the trip's cover; a receipt on a purchase.", kinds: [...KINDS, "cover"] }) };
  }
  if (!id || id.length > 64) return { bad: err(400, "bad id") };
  return { kind, id };
}

const noSuchTarget = (kind, id) => err(404, `no such ${WHAT[kind]}`, {
  id, reason: kind === "purchase"
    ? "There is no purchase by that id on this trip (a payment has no receipt). Save the purchase first, then its receipt."
    : `There is no ${WHAT[kind]} by that id on this trip. Save it first, then its picture.`,
});

// ── license, credit and source ────────────────────────────────────────────────────────────
const FREE = { cc0: "CC0", "public domain": "Public domain", own: "own" };

/**
 * A picture's license, credit and source (model §6): credit and source are required unless the
 * license is CC0, Public domain or own; a license that forbids commercial use or changes (NC,
 * ND, in any spelling) is refused. Answers { license, credit, source } or { bad }.
 */
export function readLicense(value) {
  const text = (v, max) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : v == null ? "" : null);
  const license = text(value?.license), credit = text(value?.credit), source = text(value?.source);
  if (license === null || credit === null || source === null) return { bad: err(400, "bad license", { reason: "license, credit and source are text." }) };
  if (!license || license.length > PICTURE_LICENSE_MAX) {
    return { bad: err(400, "bad license", { reason: `A picture needs its license: "own" for your own photo, "CC0", "Public domain", or the one it was published under ("CC BY 4.0"), up to ${PICTURE_LICENSE_MAX} characters.` }) };
  }
  if (/(^|[\s-])(NC|ND)([\s-]|$)/i.test(license) || /non-?commercial|no-?deriv/i.test(license)) {
    return { bad: err(400, "license refused", { reason: `"${license}" forbids commercial use or changes (NC or ND), so the picture can't be used here. Pick one without those, or your own photo.` }) };
  }
  const free = FREE[license.toLowerCase()];
  if (credit.length > PICTURE_CREDIT_MAX) return { bad: err(400, "bad credit", { reason: `A credit is up to ${PICTURE_CREDIT_MAX} characters.` }) };
  if (source && (source.length > PICTURE_SOURCE_MAX || !/^https:\/\/[^\s]+$/i.test(source))) {
    return { bad: err(400, "bad source", { reason: `A source is the https address the picture was published at, up to ${PICTURE_SOURCE_MAX} characters.` }) };
  }
  if (!free && (!credit || !source)) {
    return { bad: err(400, "credit needed", { reason: `Under "${license}" a picture needs its credit (who made it) and its source (where it was published). Only CC0, Public domain and your own photo go without.` }) };
  }
  return { license: free ?? license, credit, source };
}

// ── who ───────────────────────────────────────────────────────────────────────────────────
/** A receipt is the purchase's: whoever may edit the purchase. A place's, an event's or the cover's picture: any member. */
async function mayEdit(env, trip, user, kind, id) {
  if (kind !== "purchase") return null;
  const row = await env.DB.prepare("SELECT created_by, paid_by, kind FROM purchases WHERE trip_id = ?1 AND id = ?2").bind(trip.id, id).first();
  if (!row || row.kind !== "purchase") return noSuchTarget(kind, id);
  if (!mayTouchPurchase(row, user, [])) {
    return err(403, "forbidden", { reason: "A purchase's receipt is added by whoever may change the purchase: who logged it, or who paid." });
  }
  return null;
}

// ── storing ───────────────────────────────────────────────────────────────────────────────
function hex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/avif": ".avif" };

export const pictureShape = (r) => r ? {
  url: pictureUrl(r.r2_key), width: r.width, height: r.height, bytes: r.bytes, mime: r.mime,
  license: r.license, credit: r.credit, source: r.source, created_by: r.created_by, created_at: r.created_at, rev: r.rev,
} : null;

/**
 * The statements that replace or remove the picture on (kind, id), for one write.
 * By hand (the app, these routes) the old file goes to the drain. Under a change (the MCP,
 * model §9: env.CHANGE) it is held for the change's undo: its media_objects row stays stored and
 * counted, files_held names the change, and no picture points at it (src/trips/changes.js).
 * `next` is the new picture's row, or null to remove.
 */
export function replaceSteps(env, { tripId, kind, id, next, now }) {
  const how = env.CHANGE ? "change" : "hand";
  const at = "trip_id = ?1 AND target_kind = ?2 AND target_id = ?3";
  const steps = [];
  const old = `SELECT r2_key FROM pictures WHERE ${at}${next ? " AND r2_key != ?4" : ""}`;
  const oldParams = next ? [tripId, kind, id, next.r2_key] : [tripId, kind, id];
  if (how === "hand") {
    steps.push(queueFiles(env, old.replace("SELECT r2_key", "SELECT r2_key, NULL AS upload_id"), oldParams, now));
  } else {
    steps.push(holdFiles(env, old, oldParams, tripId, now));
  }
  if (next) {
    // Only where the thing still exists, and only on a stored file: a picture row never points
    // at a file still pending (the drain's abandon step deletes pending rows, and a picture
    // pointing at one would stop it), nor hangs on nothing.
    steps.push(env.DB.prepare(
      `INSERT INTO pictures (trip_id, target_kind, target_id, role, r2_key, mime, width, height, bytes, license, credit, source, created_by, created_at, rev)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ${REV(1)}
       WHERE ${targetSql(kind, "?1", "?3")} AND EXISTS (SELECT 1 FROM media_objects WHERE r2_key = ?5 AND state = 'stored')
       ON CONFLICT(trip_id, target_kind, target_id) DO UPDATE SET role = excluded.role, r2_key = excluded.r2_key, mime = excluded.mime,
         width = excluded.width, height = excluded.height, bytes = excluded.bytes, license = excluded.license, credit = excluded.credit,
         source = excluded.source, created_by = excluded.created_by, created_at = excluded.created_at, rev = excluded.rev`,
    ).bind(tripId, kind, id, roleOf(kind), next.r2_key, next.mime, next.width, next.height, next.bytes, next.license, next.credit, next.source,
      next.created_by, now));
  } else {
    steps.push(env.DB.prepare(`DELETE FROM pictures WHERE ${at}`).bind(tripId, kind, id));
  }
  if (how === "hand") {
    // The old file's row goes with its file: every file queued for the drain has no row.
    steps.push(env.DB.prepare("DELETE FROM media_objects WHERE trip_id = ?1 AND r2_key IN (SELECT r2_key FROM files_to_delete) AND r2_key NOT IN (SELECT r2_key FROM pictures)").bind(tripId));
  }
  return steps;
}

/**
 * The statements that take the pictures of things being deleted with them (places, events,
 * purchases: `ids` a JSON array of their ids): by hand, files to the drain and rows gone; under
 * a change, the files held for its undo. For the delete paths of places, events and purchases,
 * in their own write.
 */
export function goneSteps(env, tripId, kind, ids, now) {
  const theirs = "SELECT r2_key FROM pictures WHERE trip_id = ?1 AND target_kind = ?2 AND target_id IN (SELECT value FROM json_each(?3))";
  const rows = env.DB.prepare("DELETE FROM pictures WHERE trip_id = ?1 AND target_kind = ?2 AND target_id IN (SELECT value FROM json_each(?3))").bind(tripId, kind, ids);
  if (env.CHANGE) return [holdFiles(env, theirs, [tripId, kind, ids], tripId, now), rows];
  return [
    queueFiles(env, theirs.replace("SELECT r2_key", "SELECT r2_key, NULL AS upload_id"), [tripId, kind, ids], now),
    rows,
    env.DB.prepare("DELETE FROM media_objects WHERE trip_id = ?1 AND r2_key IN (SELECT r2_key FROM files_to_delete) AND r2_key NOT IN (SELECT r2_key FROM pictures)").bind(tripId),
  ];
}

/** Holds the files a SELECT of `r2_key` names for the open change's undo (inside its write's batch). */
function holdFiles(env, select, params, tripId, now) {
  const n = params.length;
  return env.DB.prepare(
    `INSERT OR IGNORE INTO files_held (r2_key, trip_id, change_id, held_at)
     SELECT k.r2_key, ?${n + 1}, (SELECT change_id FROM change_open), ?${n + 2} FROM (${select}) k`,
  ).bind(...params, tripId, now);
}

/**
 * Stores `bytes` as the picture on (kind, id): read, held to its size, its row reserved by one
 * conditional insert (the thing exists, the host's storage holds it), the bytes put, and then
 * one write that points the picture at it and frees what it replaced. Answers a Response.
 */
async function store(env, { trip, user, kind, id, bytes, meta }) {
  const img = readImage(bytes);
  if (img.bad) return err(415, "not a picture", { reason: `That is ${img.bad}. A picture is a JPEG, PNG, WebP or AVIF.` });
  const role = roleOf(kind);
  const limit = PICTURE_LIMITS[role];
  const px = Math.max(img.width, img.height);
  if (bytes.byteLength > limit.bytes || px > limit.px) {
    return err(413, "too big", {
      max_px: limit.px, max_bytes: limit.bytes, got: { px, bytes: bytes.byteLength },
      reason: `A ${role} is at most ${limit.px} px on its long side and ${Math.round(limit.bytes / 1024)} KB; this one is ${px} px and ${Math.ceil(bytes.byteLength / 1024)} KB.`,
    });
  }
  const now = nowSec();
  const key = `p/${hex(1)}/${hex(16)}/${hex(6)}${EXT[img.mime]}`;
  const limitBytes = await limitFor(env, trip.host_id);
  const reserved = await env.DB.prepare(
    `INSERT INTO media_objects (r2_key, user_id, trip_id, role, kind, mime, orig_name, bytes, state, created_at)
     SELECT ?1, ?2, ?3, ?4, 'photo', ?5, '', ?6, 'pending', ?7
     WHERE ${targetSql(kind, "?3", "?8")} AND ${fitsSql({ trip: "?3", needed: "?6", limit: "?9", cut: "?10" })}`,
  ).bind(key, user.id, trip.id, role, img.mime, bytes.byteLength, now, id, limitBytes, reservationCut(now)).run();
  if (!reserved.meta.changes) {
    const there = await env.DB.prepare(`SELECT ${targetSql(kind, "?1", "?2")} AS yes`).bind(trip.id, id).first();
    if (!there?.yes) return noSuchTarget(kind, id);
    return storageFull(env, { trip, user, needed: bytes.byteLength, now });
  }
  try {
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: img.mime } });
  } catch (e) {
    await env.DB.prepare("DELETE FROM media_objects WHERE r2_key = ?1").bind(key).run();
    return err(502, "store failed", { reason: "The picture couldn't be stored just now. Try again.", detail: String(e?.message || e) });
  }
  const next = { r2_key: key, mime: img.mime, width: img.width, height: img.height, bytes: bytes.byteLength, ...meta, created_by: user.id };
  await pause(env, id, "before-write");
  let rev;
  try {
    ({ rev } = await write(env, trip.id, [
      // Stored only while the thing it hangs on is still there.
      env.DB.prepare(`UPDATE media_objects SET state = 'stored', stored_at = ?2 WHERE r2_key = ?1 AND state = 'pending' AND ${targetSql(kind, "?3", "?4")}`)
        .bind(key, now, trip.id, id),
      ...replaceSteps(env, { tripId: trip.id, kind, id, next, now }),
    ]));
  } catch (e) {
    // The thing went between the reservation and this write (a foreign key or the stored
    // guard): the new file goes too.
    await env.DB.batch([
      queueFiles(env, "SELECT ?1 AS r2_key, NULL AS upload_id", [key], now),
      env.DB.prepare("DELETE FROM media_objects WHERE r2_key = ?1 AND r2_key NOT IN (SELECT r2_key FROM pictures)").bind(key),
    ]);
    if (/FOREIGN KEY|CHECK|constraint/i.test(String(e?.message || e))) return noSuchTarget(kind, id);
    throw e;
  }
  await pause(env, id, "before-read");
  const row = await env.DB.prepare("SELECT * FROM pictures WHERE trip_id = ?1 AND target_kind = ?2 AND target_id = ?3").bind(trip.id, kind, id).first();
  if (!row || row.r2_key !== key) {
    // This file isn't the picture: the thing was deleted in between (no row), or someone else's
    // picture was set over it (another key). Either way this file goes, unless it is the one.
    await env.DB.batch([
      queueFiles(env, "SELECT ?1 AS r2_key, NULL AS upload_id WHERE NOT EXISTS (SELECT 1 FROM pictures WHERE r2_key = ?1)", [key], now),
      env.DB.prepare("DELETE FROM media_objects WHERE r2_key = ?1 AND r2_key NOT IN (SELECT r2_key FROM pictures)").bind(key),
    ]);
    if (!row) return noSuchTarget(kind, id);
    return err(409, "picture changed", { reason: "Someone else just set this picture. This is theirs; set yours again to replace it.", picture: pictureShape(row) });
  }
  return json({ picture: pictureShape(row), rev }, 200);
}

/**
 * For the checks only: hold a store of the thing `id` for some milliseconds at one point
 * ("before-write": the bytes are in the bucket and the row reserved; "before-read": the write
 * is done), so a check can plant what another person does in between. PICTURE_STORE_PAUSE is
 * "<ms>:<id>:<point>", several joined by commas, honoured only when the site itself is on
 * localhost.
 */
async function pause(env, id, point) {
  const set = String(env.PICTURE_STORE_PAUSE || "");
  if (!set || !/^http:\/\/localhost:\d+$/.test(env.PUBLIC_ORIGIN ?? "")) return;
  for (const one of set.split(",")) {
    const [ms, forId, at] = one.split(":");
    if (forId === id && at === point) await new Promise((r) => setTimeout(r, Math.min(Number(ms) || 0, 10000)));
  }
}

/** Reads a body of at most `max` bytes: answers the bytes, or null when it is longer (it stops reading there). */
export async function readCapped(stream, max) {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch { /* already done */ } return null; }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

const tooBigBody = (role) => err(413, "too big", {
  max_px: PICTURE_LIMITS[role].px, max_bytes: PICTURE_LIMITS[role].bytes,
  reason: `A ${role} is at most ${PICTURE_LIMITS[role].px} px on its long side and ${Math.round(PICTURE_LIMITS[role].bytes / 1024)} KB.`,
});

// ── the app's way ─────────────────────────────────────────────────────────────────────────
async function putPicture({ request, env, data, params }, cover) {
  const { trip, user } = data;
  const target = targetOf(params, cover);
  if (target.bad) return target.bad;
  const q = new URL(request.url).searchParams;
  const meta = readLicense({ license: q.get("license"), credit: q.get("credit"), source: q.get("source") });
  if (meta.bad) return meta.bad;
  const who = await mayEdit(env, trip, user, target.kind, target.id);
  if (who) return who;
  const role = roleOf(target.kind);
  const bytes = await readCapped(request.body, PICTURE_LIMITS[role].bytes);
  if (!bytes) return tooBigBody(role);
  return store(env, { trip, user, ...target, bytes, meta });
}
export const putTargetPicture = (ctx) => putPicture(ctx, false);
export const putCover = (ctx) => putPicture(ctx, true);

async function removePicture({ env, data, params }, cover) {
  const { trip, user } = data;
  const target = targetOf(params, cover);
  if (target.bad) return target.bad;
  if (target.kind === "purchase") {
    const who = await mayEdit(env, trip, user, target.kind, target.id);
    if (who && who.status === 403) return who;
  }
  const row = await env.DB.prepare("SELECT bytes FROM pictures WHERE trip_id = ?1 AND target_kind = ?2 AND target_id = ?3").bind(trip.id, target.kind, target.id).first();
  // Already gone is success: a removal sent twice must not turn into an error.
  if (!row) return json({ ok: true, removed: false, freed_bytes: 0, rev: trip.rev });
  const { rev } = await write(env, trip.id, replaceSteps(env, { tripId: trip.id, ...target, next: null, now: nowSec() }));
  return json({ ok: true, removed: true, freed_bytes: row.bytes, rev });
}
export const deleteTargetPicture = (ctx) => removePicture(ctx, false);
export const deleteCover = (ctx) => removePicture(ctx, true);

// ── by address ────────────────────────────────────────────────────────────────────────────
// https, port 443, no credentials, a name not an address, nothing private; redirects followed
// by hand and each one held to the same rules, at most PICTURE_REDIRECTS_MAX; the whole fetch
// within PICTURE_FETCH_SECONDS; never more of the answer read than the limit and one byte. The
// refusal is one of a fixed list, never the far server's own words.
const PRIVATE_NAME = /(^|\.)(localhost|localdomain|local|internal|intranet|lan|home|corp|home\.arpa)$/i;
export function addressProblem(raw) {
  let u;
  try { u = new URL(raw); } catch { return "not an address"; }
  if (u.protocol !== "https:") return "not https";
  if (u.port && u.port !== "443") return "not port 443";
  if (u.username || u.password) return "credentials in the address";
  // A name may end in a dot ("localhost.", "box.internal."): the same name, so the dots go first.
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return "an address, not a name";
  if (!host.includes(".") || PRIVATE_NAME.test(host)) return "a private name";
  return null;
}
const FETCH_WORDS = {
  "not an address": "That isn't a web address.",
  "not https": "Only https addresses are fetched.",
  "not port 443": "Only the usual https port is fetched.",
  "credentials in the address": "An address with a name and password in it isn't fetched.",
  "an address, not a name": "A picture is fetched by its site's name, not a number.",
  "a private name": "That site's name is a private one; only public sites are fetched.",
  redirects: `The address sent the fetch on more than ${PICTURE_REDIRECTS_MAX} times.`,
  "too slow": `The site didn't send the picture within ${PICTURE_FETCH_SECONDS} seconds.`,
  unreachable: "The site couldn't be reached.",
  refused: "The site didn't send a picture (it answered with an error).",
};
const fetchRefused = (code) => err(400, "fetch failed", { cause: code, reason: FETCH_WORDS[code] ?? "The picture couldn't be fetched." });

/** For the checks only: send every fetch to a stand-in on this machine, naming the asked address (honoured on loopback only). */
function via(env) {
  const set = env?.PICTURE_FETCH_VIA;
  if (!set) return null;
  try {
    const u = new URL(set);
    if (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return u.href;
  } catch { /* not an address */ }
  console.warn("[pictures] PICTURE_FETCH_VIA is not a loopback address; fetches go to the address asked");
  return null;
}

// Hosts that serve a sized copy by its address: asked for 1280, then 960 px, until it fits.
// Wikimedia serves sized copies only at its standard widths (measured 14 Nov 2026: 1280 and 960
// answer; 1600 and 1024 are refused), so a width between them would cost a refused request.
const WIKIMEDIA_WIDTHS = [1280, 960];
function sizedCopies(raw) {
  const u = new URL(raw);
  if (u.hostname === "upload.wikimedia.org") {
    const m = u.pathname.match(/^\/wikipedia\/([^/]+)\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+)$/);
    if (m) return WIKIMEDIA_WIDTHS.map((w) => `https://upload.wikimedia.org/wikipedia/${m[1]}/thumb/${m[2]}/${m[3]}/${m[4]}/${w}px-${m[4]}`).concat([raw]);
  }
  return [raw];
}

async function fetchOnce(env, raw, max, signal, agent) {
  let current = raw;
  for (let hop = 0; ; hop++) {
    const problem = addressProblem(current);
    if (problem) return { bad: problem };
    const stand = via(env);
    let res;
    try {
      res = stand
        ? await fetch(stand, { headers: { "X-Fetch-For": current, Accept: "image/*", "User-Agent": agent }, redirect: "manual", signal })
        : await fetch(current, { headers: { Accept: "image/*", "User-Agent": agent }, redirect: "manual", signal });
    } catch (e) {
      return { bad: e?.name === "AbortError" ? "too slow" : "unreachable" };
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hop >= PICTURE_REDIRECTS_MAX) return { bad: "redirects" };
      const to = res.headers.get("Location");
      if (!to) return { bad: "refused" };
      try { current = new URL(to, current).href; } catch { return { bad: "not an address" }; }
      continue;
    }
    if (!res.ok) return { bad: "refused" };
    try {
      const bytes = await readCapped(res.body, max);
      return bytes ? { bytes } : { big: true };
    } catch (e) {
      return { bad: e?.name === "AbortError" ? "too slow" : "unreachable" };
    }
  }
}

async function fromUrl({ request, env, data, params }, cover) {
  const { trip, user } = data;
  // Fetching by address relies on Cloudflare's network refusing private addresses a public name
  // resolves to; a site run anywhere else turns it off (docs/API.md, README).
  if (String(env.PICTURE_FETCH_BY_ADDRESS || "").toLowerCase() === "off") {
    return err(404, "not offered", { reason: "Fetching pictures by their address isn't offered on this site. Upload the picture instead." });
  }
  const target = targetOf(params, cover);
  if (target.bad) return target.bad;
  const b = await readJson(request);
  const meta = readLicense(b);
  if (meta.bad) return meta.bad;
  if (typeof b.url !== "string") return fetchRefused("not an address");
  const problem = addressProblem(b.url);
  if (problem) return fetchRefused(problem);
  const who = await mayEdit(env, trip, user, target.kind, target.id);
  if (who) return who;
  if (!(await env.PICTURE_LIMITER.limit({ key: `fetch:${user.id}` })).success) {
    return err(429, "too many", { reason: "That's a lot of pictures fetched in a minute. Wait a minute, then go on." }, { "Retry-After": "60" });
  }
  // Is there room for the most a picture may be, before anything is fetched?
  const role = roleOf(target.kind);
  const max = PICTURE_LIMITS[role].bytes;
  const now = nowSec();
  const room = await env.DB.prepare(`SELECT ${fitsSql({ trip: "?1", needed: "?2", limit: "?3", cut: "?4" })} AS yes`)
    .bind(trip.id, max, await limitFor(env, trip.host_id), reservationCut(now)).first();
  if (!room?.yes) return storageFull(env, { trip, user, needed: max, now });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PICTURE_FETCH_SECONDS * 1000);
  try {
    // Large collections refuse or slow clients that don't say who they are: the app and this
    // site's own address, nothing about the person.
    const agent = `WeGoPlace (+${new URL(request.url).origin})`;
    let got = null;
    const tries = sizedCopies(b.url);
    for (const [i, address] of tries.entries()) {
      got = await fetchOnce(env, address, max, ctl.signal, agent);
      if (got.bytes) {
        const img = readImage(got.bytes);
        if (!img.bad && Math.max(img.width, img.height) <= PICTURE_LIMITS[role].px) break;
        if (img.bad) break;           // not a picture: the next size won't be one either
        got = { big: true };
        continue;                     // too big: the next, smaller copy
      }
      // A sized copy the site won't serve (wider than the original, a width it doesn't make):
      // the next one. Only the last address's refusal is the answer; a problem with an address
      // or the time running out stops at once.
      if (got.bad === "refused" && i < tries.length - 1) continue;
      if (got.bad) break;
    }
    if (got.bad) return fetchRefused(got.bad);
    if (got.big) return tooBigBody(role);
    return store(env, { trip, user, ...target, bytes: got.bytes, meta: { ...meta, source: meta.source || b.url } });
  } finally {
    clearTimeout(timer);
  }
}
export const fromUrlTarget = (ctx) => fromUrl(ctx, false);
export const fromUrlCover = (ctx) => fromUrl(ctx, true);

// ── an upload link ────────────────────────────────────────────────────────────────────────
async function makeLink({ request, env, data, params }, cover) {
  const { trip, user } = data;
  const target = targetOf(params, cover);
  if (target.bad) return target.bad;
  const meta = readLicense(await readJson(request));
  if (meta.bad) return meta.bad;
  const who = await mayEdit(env, trip, user, target.kind, target.id);
  if (who) return who;
  const there = await env.DB.prepare(`SELECT ${targetSql(target.kind, "?1", "?2")} AS yes`).bind(trip.id, target.id).first();
  if (!there?.yes) return noSuchTarget(target.kind, target.id);
  if (!(await env.PICTURE_LIMITER.limit({ key: `link:${user.id}` })).success) {
    return err(429, "too many", { reason: "That's a lot of upload links in a minute. Wait a minute, then go on." }, { "Retry-After": "60" });
  }
  const token = randomId(32);
  const now = nowSec();
  const expires = now + PICTURE_LINK_SECONDS;
  // A link an AI made (env.CHANGE) keeps its app and summary: the picture sent to it is written
  // as a change of its own, with an undo, when it comes.
  await env.DB.prepare(
    `INSERT INTO picture_links (token_hash, trip_id, target_kind, target_id, license, credit, source, created_by, created_at, expires_at, change_source, change_summary)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  ).bind(await sha256Hex(token), trip.id, target.kind, target.id, meta.license, meta.credit, meta.source, user.id, now, expires,
    env.CHANGE?.source ?? null, env.CHANGE?.summary ?? null).run();
  // Printed for someone else (an AI app sends the picture there): the site's own address.
  const origin = env.PUBLIC_ORIGIN;
  return json({ url: `${origin}/pictures/upload/${token}`, method: "PUT", expires_at: expires, max_bytes: PICTURE_LIMITS[roleOf(target.kind)].bytes, max_px: PICTURE_LIMITS[roleOf(target.kind)].px }, 201);
}
export const makeTargetLink = (ctx) => makeLink(ctx, false);
export const makeCoverLink = (ctx) => makeLink(ctx, true);

const noSuchLink = () => err(404, "no such link", { reason: "That upload link doesn't work: it was used, it ran out, or it never was. Ask for a new one." });

/** PUT /pictures/upload/<token>: no session; the token is the credential, used once. Nothing of the body is read for a link that doesn't work. */
export async function uploadByLink({ request, env, params }) {
  const token = String(params.token || "");
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return noSuchLink();
  const now = nowSec();
  const hash = await sha256Hex(token);
  // Taken in one statement: a link used twice at once is used once.
  const claimed = await env.DB.prepare("UPDATE picture_links SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2").bind(hash, now).run();
  if (!claimed.meta.changes) return noSuchLink();
  const link = await env.DB.prepare("SELECT * FROM picture_links WHERE token_hash = ?1").bind(hash).first();
  const [trip, user] = await Promise.all([
    env.DB.prepare("SELECT id, host_id, rev FROM trips WHERE id = ?1").bind(link.trip_id).first(),
    env.DB.prepare(
      "SELECT u.id FROM users u JOIN trip_members m ON m.user_id = u.id WHERE u.id = ?1 AND m.trip_id = ?2 AND m.left_at IS NULL AND u.deleted_at IS NULL",
    ).bind(link.created_by, link.trip_id).first(),
  ]);
  // The trip is gone, or whoever made the link isn't on it any more: the link is dead.
  if (!trip || !user) return noSuchLink();
  const role = roleOf(link.target_kind);
  const bytes = await readCapped(request.body, PICTURE_LIMITS[role].bytes);
  if (!bytes) return tooBigBody(role);
  const change = link.change_source ? newChange({ user, source: link.change_source, summary: link.change_summary }) : null;
  return store(change ? { ...env, CHANGE: change } : env, {
    trip, user: { id: user.id }, kind: link.target_kind, id: link.target_id, bytes,
    meta: { license: link.license, credit: link.credit, source: link.source },
  });
}

/** Every picture of a trip, for its snapshot: Map "<kind>:<id>" -> shape. */
export async function picturesOf(env, tripId) {
  const rows = await env.DB.prepare("SELECT * FROM pictures WHERE trip_id = ?1").bind(tripId).all();
  return new Map((rows.results || []).map((r) => [`${r.target_kind}:${r.target_id}`, pictureShape(r)]));
}

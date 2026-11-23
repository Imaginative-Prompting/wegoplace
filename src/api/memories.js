// Memories — the cards. Media bytes live next door in ./media.js; this file owns the rows
// that give a pile of R2 objects a caption, a date, an author and a set of tags.
//
// Under /api/trips/<trip>/ (the route table checks the caller is on the trip):
//   GET    memories[?tag=&before=&before_id=&limit=]  -> {memories, tags, next_before…}
//   GET    memories/tags                              -> {tags:[{tag,count}]}
//   GET    memories/:id                               -> {memory}
//   POST   memories                                   -> {memory, rev}   201; 200 when sent again
//   PATCH  memories/:id   {framing}                   -> {memory, rev}
//   DELETE memories/:id                               -> {ok, deleted, freed_bytes, rev}
//
// ── AUTHORSHIP COMES FROM THE SESSION, FULL STOP ────────────────────────────────────────
// created_by is ctx.data.user.id and the request body's opinion about who wrote this is
// never read. The review already caught this class of bug elsewhere in the app: a body field
// that names a user is a body field that lets anyone forge one. There is no code path here
// where a client-supplied identifier reaches a created_by column.
//
// ── PERMISSIONS ARE THE STANDING SPINE ──────────────────────────────────────────────────
// Any trip member reads everything. The AUTHOR deletes their own memory — and so does the
// trip's host, because somebody has to be able to remove a photo that should not be on a
// shared wall and the alternative is a D1 console. Nobody edits anyone else's, and nobody edits
// their own either: there is no PATCH. A memory is a photo and a caption somebody posted; a
// caption that can change under a reader is the failure notes on plans refused, for the same
// reason. Delete and re-post is the edit.
//
// ── TAGS ARE ROWS ───────────────────────────────────────────────────────────────────────
// "pick from tags you or your friends already created" is SELECT DISTINCT tag; grouping the
// feed by a tag is a WHERE. Normalised lowercase and trimmed on write so "Cusco", "cusco "
// and "CUSCO" are one chip and not three.

import { json, readJson } from "./json.js";
import { ensureNoteColors, err, initialsOf, nowSec, str, validId } from "./trip.js";
import { mediaUrl, validKey } from "./media.js";
import { revokeStatements } from "./collage.js";
import { queueFiles } from "../trips/drain.js";
import { REV, write } from "../trips/rev.js";
import { SPECS, told } from "./ignored.js";
import { readClock } from "../../public/js/shared/clock.js";
import { dayIn } from "../../public/js/shared/trip-rules.js";

const MAX_MEDIA = 40;          // one card; the grid stops being a card long before this
const MAX_TAGS = 8;
const MAX_TAG_LEN = 32;
const MAX_CAPTION = 2000;
const DEFAULT_LIMIT = 40;
// D1 caps a statement at 100 bound parameters and the media/tag fan-out binds one per
// memory id, so the page size is a database limit wearing a product's clothes.
const MAX_LIMIT = 90;

const KINDS = ["photo", "video"];

// `tags` is a reserved id: GET memories/tags is the suggest list, so no memory may ever
// be addressable at that path. Client ids are uuids, so this costs nothing real.
const RESERVED_IDS = ["tags"];

// Lowercase, trimmed, inner whitespace collapsed. Anything that is not a letter, number,
// space or hyphen is dropped rather than rejected — a tag typed with an emoji or a stray
// comma should become the tag the user meant, not a 400 in the middle of posting a photo.
export function normTag(v) {
  const s = String(v == null ? "" : v)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, MAX_TAG_LEN);
}

// ── shaping ─────────────────────────────────────────────────────────────────────────────
// Author name, initials and colour are denormalised onto every card for the same reason
// notes on plans did: four days from signal the client cannot look up an author it
// never cached, and initials — not hue — are what actually name the person. For someone
// colourblind, the colour reinforces, it never carries the identity alone.
const shapeMedia = (r) => ({
  id: r.id,
  kind: r.kind,
  key: r.r2_key,
  thumb_key: r.thumb_key || "",
  url: mediaUrl(r.r2_key),                                   // the ORIGINAL. What a save fetches.
  thumb_url: r.thumb_key ? mediaUrl(r.thumb_key) : "",       // the derivative. What the feed shows.
  mime: r.mime || "",
  orig_name: r.orig_name || "",
  width: r.width || 0,
  height: r.height || 0,
  duration_s: r.duration_s || 0,
  bytes: r.bytes || 0,
  sort: r.sort || 0,
  // ── framing (0012) ────────────────────────────────────────────────────────────────────
  // Presentation state that sits BESIDE the bytes: a crop the whole app honours, and a loop
  // window for video. NULL means "not set" and every consumer falls back to the same defaults
  // it used before this column existed, which is why no backfill was needed.
  focal_x: r.focal_x === null || r.focal_x === undefined ? null : Number(r.focal_x),
  focal_y: r.focal_y === null || r.focal_y === undefined ? null : Number(r.focal_y),
  zoom: r.zoom === null || r.zoom === undefined ? null : Number(r.zoom),
  trim_start_s: r.trim_start_s === null || r.trim_start_s === undefined ? null : Number(r.trim_start_s),
  trim_end_s: r.trim_end_s === null || r.trim_end_s === undefined ? null : Number(r.trim_end_s),
});

const shapeMemory = (m, media, tags, boards) => ({
  id: m.id,
  trip_id: m.trip_id,
  caption: m.caption || "",
  created_by: m.created_by,
  created_at: m.created_at,
  // When it happened (migration 0029): the trip-zone day, and the moment its photographs were taken
  // where a file said; null = when it was posted. `at` is the order the feed pages in.
  day: m.day ?? null,
  taken_at: m.taken_at ?? null,
  at: m.at ?? m.created_at,
  user_name: m.user_name || "",
  initials: initialsOf(m.user_name),
  note_color: m.note_color || null,
  tags,
  media,
  bytes: media.reduce((s, x) => s + (x.bytes || 0), 0),
  // How many live shared boards show a photograph from it: deleting it unshares them.
  boards,
  rev: m.rev,
});

const MEM_SELECT =
  "SELECT m.id, m.trip_id, m.caption, m.created_by, m.created_at, m.day, m.taken_at, m.at, m.rev, " +
  "u.name AS user_name, u.note_color AS note_color " +
  "FROM memories m LEFT JOIN users u ON u.id = m.created_by";

/** When a memory happened, as SQL: its own order, else when it was posted (the index's expression). */
const AT = "COALESCE(m.at, m.created_at)";
/** The earliest a photograph's time can be, and how far ahead of now (a phone's clock, a time zone). */
const TAKEN_MIN = Date.parse("1990-01-01T00:00:00Z") / 1000;
const TAKEN_AHEAD = 2 * 86400;
/** A taken_at as sent: seconds in range, null (none), or undefined (one that can't be). */
function readTaken(v, now) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < TAKEN_MIN || n > now + TAKEN_AHEAD) return undefined;
  return n;
}
/**
 * A day as sent: "YYYY-MM-DD" on the calendar, null (none), or undefined (one that can't be). It
 * keeps the photographs' window: from 1990 to two days from now, read in the trip's zone, so a
 * phone whose clock runs fast can't put a memory under a day still to come (it would sit at the
 * top of the feed until then).
 */
function readDay(v, now, tz) {
  if (v === null || v === undefined) return null;
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (!m) return undefined;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3] || +m[1] < 1990) return undefined;
  if (v > dayIn(now + TAKEN_AHEAD, tz || "UTC")) return undefined;
  return v;
}
/** The last second of a day in a zone (the order of a memory with a day and no time: the newest of its day). */
function endOfDay(day, tz) {
  for (const t of ["23:59:59", "23:30", "23:00"]) {
    const r = readClock(`${day}T${t}`, tz || "UTC");
    if (r.epoch !== undefined) return r.epoch;
    if (r.readings?.length) return r.readings.at(-1).epoch;
  }
  return Date.parse(`${day}T23:59:59Z`) / 1000;
}
/** The order a memory pages in: its photographs' time, else the end of its day, else none (created_at). */
const atOf = (day, taken, tz) => taken ?? (day ? endOfDay(day, tz) : null);
const NOT_TAKEN = {
  day: "A day is written YYYY-MM-DD, is on the calendar, and is from 1990 to two days from now; this one wasn't, so the memory is on the day it was posted.",
  taken_at: "When the photographs were taken is seconds from 1990 to now; this one couldn't be, so it wasn't kept.",
};

// One round trip per collection instead of one per card. memory_media joins media_objects
// only for orig_name — every other column it needs is already on the row 0007 gave it.
async function hydrate(env, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map((_, i) => `?${i + 1}`).join(",");

  const media = await env.DB.prepare(
    "SELECT mm.id, mm.memory_id, mm.kind, mm.r2_key, mm.thumb_key, mm.mime, mm.width, " +
    "mm.height, mm.duration_s, mm.bytes, mm.sort, " +
    "mm.focal_x, mm.focal_y, mm.zoom, mm.trim_start_s, mm.trim_end_s, " +
    "mo.orig_name AS orig_name " +
    "FROM memory_media mm LEFT JOIN media_objects mo ON mo.r2_key = mm.r2_key " +
    `WHERE mm.memory_id IN (${marks}) ORDER BY mm.memory_id, mm.sort, mm.id`
  ).bind(...ids).all();

  const tags = await env.DB.prepare(
    `SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${marks}) ORDER BY memory_id, tag`
  ).bind(...ids).all();

  const boards = await env.DB.prepare(
    "SELECT i.memory_id, COUNT(DISTINCT i.share_id) AS n FROM collage_share_items i JOIN collage_shares s ON s.id = i.share_id " +
    `WHERE s.revoked_at IS NULL AND i.memory_id IN (${marks}) GROUP BY i.memory_id`
  ).bind(...ids).all();
  const boardsOf = new Map((boards.results || []).map((r) => [r.memory_id, Number(r.n) || 0]));

  const byMedia = new Map(ids.map((id) => [id, []]));
  for (const r of media.results || []) (byMedia.get(r.memory_id) || []).push(shapeMedia(r));
  const byTag = new Map(ids.map((id) => [id, []]));
  for (const r of tags.results || []) (byTag.get(r.memory_id) || []).push(r.tag);

  return rows.map((m) => shapeMemory(m, byMedia.get(m.id) || [], byTag.get(m.id) || [], boardsOf.get(m.id) ?? 0));
}

async function tagCounts(env, tripId) {
  const rows = await env.DB.prepare(
    "SELECT t.tag AS tag, COUNT(*) AS n FROM memory_tags t " +
    "JOIN memories m ON m.id = t.memory_id WHERE m.trip_id = ?1 " +
    "GROUP BY t.tag ORDER BY n DESC, t.tag"
  ).bind(tripId).all();
  return (rows.results || []).map((r) => ({ tag: r.tag, count: Number(r.n) || 0 }));
}

// ── dispatch ────────────────────────────────────────────────────────────────────────────
// The route table hands memories and memories/<seg> here.
export async function onRequest(ctx) {
  const seg = [].concat(ctx.params?.path || []).filter(Boolean);
  const method = ctx.request.method.toUpperCase();

  if (seg.length > 1) return err(404, "not found");
  const id = seg[0] || "";

  if (!id) {
    if (method === "GET") return listMemories(ctx);
    if (method === "POST") return told(createMemory, SPECS.memory)(ctx);
    return err(405, "method not allowed", { allowed: ["GET", "POST"] });
  }
  if (id === "tags") {
    if (method === "GET") return listTags(ctx);
    return err(405, "method not allowed", { allowed: ["GET"] });
  }
  if (method === "GET") return readMemory(ctx, id);
  if (method === "PATCH") return told((c) => patchFraming(c, id), SPECS.memoryEdit)(ctx);
  if (method === "DELETE") return deleteMemory(ctx, id);
  return err(405, "method not allowed", { allowed: ["GET", "PATCH", "DELETE"] });
}

// ── PATCH memories/<id> ────────────────────────────────────────────────────────────
// Body: { framing?: { "<mediaId>": { focal_x?, focal_y?, zoom?, trim_start_s?, trim_end_s? } },
//         day?: "YYYY-MM-DD" | null, taken_at?: seconds | null }
//
// day and taken_at (migration 0029): when the memory happened. A key not sent stays as it is; null
// takes it away (both null: when it was posted). Only the memory's own poster changes them; one that
// can't be is refused in words, as an edit is a choice, not a gesture.
//
// FRAMING ONLY. This route cannot touch the caption, the tags, the media list or the bytes —
// it writes five numbers on rows that already belong to this memory. Keeping it that narrow is
// what lets it be a plain last-write-wins PATCH with no conflict story: two people cropping the
// same photo differently is a race nobody will ever run, and if they did, the loser re-crops.
//
// EVERY VALUE IS CLAMPED, NOT REJECTED. A crop is a direct-manipulation gesture — a finger on a
// photo — and the client sends whatever the finger did. Refusing a zoom of 4.2 with a 400 would
// drop the write on the floor (store.js treats 4xx as permanent), so the sensible answer to an
// out-of-range number is the nearest in-range one.
async function patchFraming(ctx, id) {
  const { trip, user } = ctx.data;

  const body = await readJson(ctx.request);
  const framing = body && body.framing;
  const dayAsked = !!body && (Object.hasOwn(body, "day") || Object.hasOwn(body, "taken_at"));
  if (!dayAsked && (!framing || typeof framing !== "object" || Array.isArray(framing))) {
    return err(400, "framing must be an object keyed by media id");
  }
  if (framing !== undefined && (!framing || typeof framing !== "object" || Array.isArray(framing))) {
    return err(400, "framing must be an object keyed by media id");
  }
  let dayStep = null;
  if (dayAsked) {
    const mem = await ctx.env.DB.prepare("SELECT created_by, day, taken_at FROM memories WHERE id = ?1 AND trip_id = ?2").bind(id, trip.id).first();
    if (!mem) return err(404, "not found", { reason: "This memory isn't on the trip any more: someone deleted it." });
    if (mem.created_by !== user.id) {
      return err(403, "not yours", { reason: "When a memory happened is changed by whoever posted it." });
    }
    const day = Object.hasOwn(body, "day") ? readDay(body.day, nowSec(), trip.default_tz) : mem.day;
    if (day === undefined) return err(400, "bad day", { reason: NOT_TAKEN.day.replace(/; this one.*$/, ".") });
    const taken = Object.hasOwn(body, "taken_at") ? readTaken(body.taken_at, nowSec()) : mem.taken_at;
    if (taken === undefined) return err(400, "bad taken_at", { reason: "taken_at is seconds from 1990 to now, or null." });
    dayStep = ctx.env.DB.prepare(`UPDATE memories SET day = ?3, taken_at = ?4, at = ?5, rev = ${REV(2)} WHERE id = ?1 AND trip_id = ?2`)
      .bind(id, trip.id, day ?? null, taken ?? null, atOf(day ?? null, taken ?? null, trip.default_tz));
  }

  const owned = await ctx.env.DB.prepare(
    "SELECT mm.id FROM memory_media mm JOIN memories m ON m.id = mm.memory_id " +
    "WHERE mm.memory_id = ?1 AND m.trip_id = ?2"
  ).bind(id, trip.id).all();
  const ids = new Set((owned.results || []).map((r) => r.id));
  // (A memory of words alone has no media rows; its day was found above.)
  if (!ids.size && !dayAsked) return err(404, "not found", { reason: "This memory isn't on the trip any more: someone deleted it." });

  // A number, clamped, or null to clear. `undefined` means the key was absent and the column is
  // left exactly as it was — which is what makes this safe to call with a partial patch.
  const num = (v, lo, hi) => {
    if (v === null) return null;
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(hi, Math.max(lo, n));
  };

  const stmts = [];
  for (const [mid, patch] of Object.entries(framing ?? {})) {
    if (!ids.has(mid) || !patch || typeof patch !== "object") continue;
    const set = [];
    const args = [];
    const put = (col, v) => { if (v !== undefined) { set.push(col + " = ?" + (args.length + 1)); args.push(v); } };
    put("focal_x", num(patch.focal_x, 0, 1));
    put("focal_y", num(patch.focal_y, 0, 1));
    // 8x is past the point where any phone photo has pixels left; it is a stop, not a policy.
    put("zoom", num(patch.zoom, 1, 8));
    put("trim_start_s", num(patch.trim_start_s, 0, 86400));
    put("trim_end_s", num(patch.trim_end_s, 0, 86400));
    if (!set.length) continue;
    args.push(mid);
    stmts.push(ctx.env.DB.prepare(
      "UPDATE memory_media SET " + set.join(", ") + " WHERE id = ?" + args.length
    ).bind(...args));
  }
  if (dayStep) stmts.push(dayStep);
  if (!stmts.length) return readMemory(ctx, id, trip.rev);
  // The framing is on the media rows; the card is what a reader holds, so the card takes the rev.
  const { rev } = await write(ctx.env, trip.id, [
    ...stmts,
    ctx.env.DB.prepare(`UPDATE memories SET rev = ${REV(2)} WHERE id = ?1 AND trip_id = ?2`).bind(id, trip.id),
  ]);
  return readMemory(ctx, id, rev);
}

// ── GET memories ───────────────────────────────────────────────────────────────────
// Newest first, by when each happened (`at`: the photographs' time, else the end of its day, else created_at). The cursor is (at, id)
// and not `at` alone: four photos posted
// in the same second off one phone share a timestamp, and a cursor that can only say "older
// than 1787200000" either repeats them on the next page or skips them. `tags` is the whole
// trip's tag list regardless of ?tag=, because it is the filter bar — computing it inside
// the filter would make every chip but the selected one disappear the moment you tap one.
async function listMemories(ctx) {
  const { trip } = ctx.data;

  await ensureNoteColors(ctx.env, trip.id);

  const q = new URL(ctx.request.url).searchParams;
  const tag = normTag(q.get("tag") || "");
  const limitRaw = Number(q.get("limit"));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : DEFAULT_LIMIT;

  const beforeRaw = Number(q.get("before"));
  const before = Number.isInteger(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;
  const beforeId = str(q.get("before_id"), 64);

  const where = ["m.trip_id = ?1"];
  const binds = [trip.id];
  if (tag) {
    binds.push(tag);
    where.push(`m.id IN (SELECT memory_id FROM memory_tags WHERE tag = ?${binds.length})`);
  }
  if (before != null) {
    binds.push(before);
    const a = binds.length;
    if (beforeId) {
      binds.push(before, beforeId);
      where.push(`(${AT} < ?${a} OR (${AT} = ?${a + 1} AND m.id < ?${a + 2}))`);
    } else {
      where.push(`${AT} < ?${a}`);
    }
  }
  binds.push(limit + 1);

  const rows = await ctx.env.DB.prepare(
    `${MEM_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${AT} DESC, m.id DESC LIMIT ?${binds.length}`
  ).bind(...binds).all();

  const page = (rows.results || []).slice(0, limit);
  const more = (rows.results || []).length > limit;
  const last = page[page.length - 1];

  return json({
    memories: await hydrate(ctx.env, page),
    tags: await tagCounts(ctx.env, trip.id),
    limit,
    has_more: more,
    next_before: more && last ? (last.at ?? last.created_at) : null,
    next_before_id: more && last ? last.id : null,
  });
}

// ── GET memories/tags ──────────────────────────────────────────────────────────────
async function listTags(ctx) {
  return json({ tags: await tagCounts(ctx.env, ctx.data.trip.id) });
}

// ── GET memories/:id ───────────────────────────────────────────────────────────────
// `rev`: given by a write that answers with the card, so its answer carries the trip's rev too.
async function readMemory(ctx, id, rev) {
  const { trip } = ctx.data;
  if (!validId(id)) return err(400, "bad id", { id });

  await ensureNoteColors(ctx.env, trip.id);
  const row = await ctx.env.DB.prepare(`${MEM_SELECT} WHERE m.id = ?1 AND m.trip_id = ?2`)
    .bind(id, trip.id).first();
  if (!row) return err(404, "no such memory", { id, reason: "This memory isn't on the trip any more: someone deleted it." });

  const [memory] = await hydrate(ctx.env, [row]);
  return json(rev === undefined ? { memory } : { memory, rev });
}

// ── POST memories ──────────────────────────────────────────────────────────────────
// {id?, caption?, tags?, media:[{key, thumb_key?, kind?, w?, h?, duration?}]}
//
// The MEDIA ENTRIES ARE NOT TRUSTED FOR ANYTHING THE SERVER ALREADY KNOWS. mime and bytes
// come off the media_objects row that `finish` wrote from R2's own answer, never off the
// body — a client that under-reports `bytes` here would under-report the meter somebody is
// eventually billed from. Width, height and duration DO come from the body, because they are
// things only the browser that decoded the file can know and no isolate here can check.
//
// Every key must be an object THIS user uploaded TO THIS TRIP, in state 'stored', not already
// attached to another memory. That last clause is what stops a member from stapling somebody
// else's photo onto their own card.
async function createMemory(ctx) {
  const { user: u, trip } = ctx.data;

  const b = await readJson(ctx.request);

  // Client-supplied id, same as events and notes and for the same reason: a post that is
  // retried after a half-succeeded flush must land on the row it already made, not a second
  // copy of the same eight photos.
  const id = b.id === undefined ? crypto.randomUUID() : String(b.id);
  if (!validId(id) || RESERVED_IDS.includes(id)) return err(400, "bad id", { id });

  // When it happened, as the phone read it from the photographs (or the person chose). One that
  // can't be is taken as none rather than refused (a refused post is a lost post on a phone: the
  // store drops a 4xx), and the answer names it (`not_taken`), so the app can say so.
  const ts = nowSec();
  const notTaken = [];
  let day = readDay(b.day, ts, trip.default_tz);
  if (day === undefined) { day = null; notTaken.push({ field: "day", reason: NOT_TAKEN.day }); }
  let taken = readTaken(b.taken_at, ts);
  if (taken === undefined) { taken = null; notTaken.push({ field: "taken_at", reason: NOT_TAKEN.taken_at }); }
  const at = atOf(day, taken, trip.default_tz);

  // An id another trip holds is not in this trip: the same answer as somebody else's id here.
  const replay = async () => {
    const row = await ctx.env.DB.prepare(`${MEM_SELECT} WHERE m.id = ?1 AND m.trip_id = ?2`)
      .bind(id, trip.id).first();
    if (!row || row.created_by !== u.id) return err(409, "id already exists", { id });
    const [memory] = await hydrate(ctx.env, [row]);
    return json({ memory, rev: trip.rev, ...(notTaken.length ? { not_taken: notTaken } : {}) });
  };

  // A post queued on the trail can arrive twice: its answer lost on the way, the phone sends it
  // again. Answer the second one with the row the first one made, the rule every queued write here
  // keeps, and look for it FIRST, before anything about its photographs is checked: by then the
  // first one has attached them, and every check below would refuse them as somebody's already
  // ("media already attached"), for good, though the memory is there.
  const prior = await ctx.env.DB.prepare("SELECT id FROM memories WHERE id = ?1").bind(id).first();
  if (prior) return replay();

  const caption = str(b.caption, MAX_CAPTION);

  const rawTags = Array.isArray(b.tags) ? b.tags : [];
  const tags = [...new Set(rawTags.map(normTag).filter(Boolean))].slice(0, MAX_TAGS);

  const rawMedia = Array.isArray(b.media) ? b.media : [];
  if (!rawMedia.length && !caption) return err(400, "a memory needs media or a caption", { reason: "A memory needs a photograph, a video or some words." });
  if (rawMedia.length > MAX_MEDIA)
    return err(413, "too many media in one memory", { got: rawMedia.length, max: MAX_MEDIA, reason: `A memory holds at most ${MAX_MEDIA} photographs and videos; this one has ${rawMedia.length}.` });

  const wanted = [];
  const seen = new Set();
  for (let i = 0; i < rawMedia.length; i++) {
    const m = rawMedia[i] || {};
    const key = String(m.key || "");
    const thumbKey = String(m.thumb_key || "");
    if (!validKey(key)) return err(400, "bad media key", { index: i, key: m.key });
    if (thumbKey && !validKey(thumbKey)) return err(400, "bad thumb key", { index: i, thumb_key: m.thumb_key });
    // The same key twice in one card would render the photo twice and, worse, would put two
    // memory_media rows on one object — so the delete path's key set would free bytes once
    // while the card claimed them twice. Caught here rather than deduped silently: a client
    // that sends a duplicate has a bug in its picker, and hiding it makes that bug invisible.
    for (const k of thumbKey ? [key, thumbKey] : [key]) {
      if (seen.has(k)) return err(400, "duplicate key in one memory", { index: i, key: k });
      seen.add(k);
    }
    wanted.push({
      key, thumbKey,
      kind: KINDS.includes(m.kind) ? m.kind : "",
      width: Math.max(0, Math.min(100000, Math.trunc(Number(m.w ?? m.width) || 0))),
      height: Math.max(0, Math.min(100000, Math.trunc(Number(m.h ?? m.height) || 0))),
      duration: Math.max(0, Math.min(86400, Number(m.duration ?? m.duration_s) || 0)),
      sort: i,
    });
  }

  // One SELECT for every key mentioned, original and thumb alike.
  const keys = [...new Set(wanted.flatMap((w) => (w.thumbKey ? [w.key, w.thumbKey] : [w.key])))];
  const objects = new Map();
  if (keys.length) {
    if (keys.length > 90) return err(413, "too many media in one memory", { keys: keys.length, reason: `A memory holds at most ${MAX_MEDIA} photographs and videos.` });
    const marks = keys.map((_, i) => `?${i + 1}`).join(",");
    const rows = await ctx.env.DB.prepare(
      `SELECT r2_key, user_id, role, kind, mime, bytes, state FROM media_objects ` +
      `WHERE r2_key IN (${marks}) AND trip_id = ?${keys.length + 1}`
    ).bind(...keys, trip.id).all();
    for (const r of rows.results || []) objects.set(r.r2_key, r);
  }

  const attachedRows = keys.length
    ? await ctx.env.DB.prepare(
      `SELECT r2_key AS k FROM memory_media WHERE r2_key IN (${keys.map((_, i) => `?${i + 1}`).join(",")}) ` +
      `UNION SELECT thumb_key AS k FROM memory_media WHERE thumb_key IN (${keys.map((_, i) => `?${i + 1}`).join(",")})`
    ).bind(...keys).all()
    : { results: [] };
  const alreadyAttached = new Set((attachedRows.results || []).map((r) => r.k));

  const media = [];
  for (const w of wanted) {
    const o = objects.get(w.key);
    if (!o) return err(400, "unknown media key", { key: w.key });
    if (o.user_id !== u.id) return err(403, "forbidden", { reason: "That photo or video was uploaded by another person: a memory is made of your own uploads.", key: w.key });
    if (o.state !== "stored") return err(409, "upload not finished", { key: w.key, state: o.state });
    if (o.role !== "original") return err(400, "key is not an original", { key: w.key });
    if (alreadyAttached.has(w.key)) return err(409, "media already attached", { key: w.key });

    if (w.thumbKey) {
      const t = objects.get(w.thumbKey);
      if (!t) return err(400, "unknown thumb key", { thumb_key: w.thumbKey });
      if (t.user_id !== u.id) return err(403, "forbidden", { reason: "That thumbnail was made by another person: a memory is made of your own uploads.", thumb_key: w.thumbKey });
      if (t.role !== "thumb") return err(400, "thumb_key is not a thumb", { thumb_key: w.thumbKey });
      if (t.state !== "stored") return err(409, "thumb not finished", { thumb_key: w.thumbKey });
      if (alreadyAttached.has(w.thumbKey)) return err(409, "thumb already attached", { thumb_key: w.thumbKey });
    }

    media.push({
      id: crypto.randomUUID(),
      kind: w.kind || o.kind || "photo",
      key: w.key,
      thumbKey: w.thumbKey,
      mime: o.mime || "",       // server's, not the body's
      bytes: Number(o.bytes) || 0,
      width: w.width, height: w.height, duration: w.duration, sort: w.sort,
    });
  }

  await ensureNoteColors(ctx.env, trip.id);

  // ONE BATCH, WHICH IS ONE TRANSACTION. The card and its media rows land together or not at
  // all. Split across two statements — a memories INSERT followed by the media inserts — a
  // failure between them leaves a memory with no photos in it, and the client's retry then
  // hits the replay path above and is handed that empty card back as if it were the answer.
  // "The upload succeeded and the photos are gone" is the worst failure this tab has.
  //
  // The memories INSERT deliberately carries NO ON CONFLICT clause: if two copies of the
  // same post genuinely race, the second one's whole transaction rolls back rather than
  // stapling a second set of media rows onto the first one's card. The catch below turns
  // that into the same replay answer.
  const stmts = [ctx.env.DB.prepare(
    `INSERT INTO memories (id, trip_id, caption, created_by, created_at, day, taken_at, at, rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ${REV(2)})`
  ).bind(id, trip.id, caption, u.id, ts, day, taken, at)];
  for (const m of media) {
    stmts.push(ctx.env.DB.prepare(
      "INSERT INTO memory_media (id, memory_id, kind, r2_key, thumb_key, mime, width, height, " +
      "duration_s, bytes, sort) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
    ).bind(m.id, id, m.kind, m.key, m.thumbKey, m.mime, m.width, m.height, m.duration, m.bytes, m.sort));
  }
  for (const t of tags) {
    stmts.push(ctx.env.DB.prepare(
      "INSERT INTO memory_tags (memory_id, tag) VALUES (?1, ?2) ON CONFLICT DO NOTHING"
    ).bind(id, t));
  }

  let rev;
  try {
    ({ rev } = await write(ctx.env, trip.id, stmts));
  } catch (e) {
    const row = await ctx.env.DB.prepare("SELECT created_by FROM memories WHERE id = ?1").bind(id).first();
    if (row) return replay();                       // lost the race with our own retry
    return err(500, "could not save memory", { detail: String(e && e.message || e) });
  }

  const row = await ctx.env.DB.prepare(`${MEM_SELECT} WHERE m.id = ?1 AND m.trip_id = ?2`)
    .bind(id, trip.id).first();
  const [memory] = await hydrate(ctx.env, [row]);
  return json({ memory, rev, ...(notTaken.length ? { not_taken: notTaken } : {}) }, 201);
}

// ── DELETE memories/:id ─────────────────────────────────────────────────────────────────
// Author or the trip's host. Its files (original AND thumb) go to the drain in the same
// batch as its rows, so what it held stops counting at once (src/trips/storage.js). And it
// leaves every board one of its photographs is on: those shares are revoked, their files to
// the drain too (src/api/collage.js); the answer says how many boards were unshared, and
// their maker can share again.
//
// ALREADY GONE IS SUCCESS, and the body carries no `id` field — both because a delete queued on the trail can arrive twice, and store.js's
// unwrap() resurrects any response object that has an `id`.
async function deleteMemory(ctx, id) {
  const { user: u, trip, host } = ctx.data;
  if (!validId(id)) return err(400, "bad id", { id });

  const row = await ctx.env.DB.prepare(
    "SELECT id, created_by FROM memories WHERE id = ?1 AND trip_id = ?2"
  ).bind(id, trip.id).first();
  if (!row) return json({ ok: true, deleted: false, freed_bytes: 0, freed_objects: 0, boards_unshared: 0, rev: trip.rev });
  if (row.created_by !== u.id && !host)
    return err(403, "forbidden", { reason: "Only the person who made this memory, or the trip's host, can delete it." });

  const mediaRows = await ctx.env.DB.prepare(
    "SELECT r2_key, thumb_key FROM memory_media WHERE memory_id = ?1"
  ).bind(id).all();
  const keys = [...new Set((mediaRows.results || [])
    .flatMap((r) => [r.r2_key, r.thumb_key])
    .filter((k) => k && validKey(k)))];

  const freed = keys.length
    ? await ctx.env.DB.prepare(
      `SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS n FROM media_objects WHERE state = 'stored' AND r2_key IN (SELECT value FROM json_each(?1))`,
    ).bind(JSON.stringify(keys)).first()
    : { bytes: 0, n: 0 };
  const boards = ((await ctx.env.DB.prepare(
    `SELECT DISTINCT s.id FROM collage_shares s JOIN collage_share_items i ON i.share_id = s.id
     WHERE s.trip_id = ?1 AND s.revoked_at IS NULL AND i.memory_id = ?2`,
  ).bind(trip.id, id).all()).results || []).map((r) => r.id);

  const ts = nowSec();
  const stmts = [
    // The boards it is on, unshared.
    ...revokeStatements(ctx.env, trip.id, boards, ts, "memory"),
    // Its files, to the drain, before their rows go.
    queueFiles(ctx.env, "SELECT r2_key, NULL AS upload_id FROM memory_media WHERE memory_id = ?1 UNION SELECT thumb_key, NULL FROM memory_media WHERE memory_id = ?1", [id], ts),
    ctx.env.DB.prepare("DELETE FROM memory_tags WHERE memory_id = ?1").bind(id),
    ctx.env.DB.prepare("DELETE FROM memory_media WHERE memory_id = ?1").bind(id),
    // The authorship term is restated inside the DELETE rather than trusted from the SELECT
    // above: two requests from one session can interleave, and a WHERE that repeats the
    // check cannot remove somebody else's memory however the read raced.
    ctx.env.DB.prepare(
      "DELETE FROM memories WHERE id = ?1 AND trip_id = ?2 AND (created_by = ?3 OR ?4 = 1)"
    ).bind(id, trip.id, u.id, host ? 1 : 0),
  ];
  if (keys.length) stmts.push(ctx.env.DB.prepare("DELETE FROM media_objects WHERE r2_key IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(keys)));

  const { rev } = await write(ctx.env, trip.id, stmts);
  return json({
    ok: true, deleted: true,
    freed_bytes: Number(freed.bytes) || 0, freed_objects: Number(freed.n) || 0,
    boards_unshared: boards.length,
    rev,
  });
}

// Under /api/trips/<trip>/ (the route table checks the caller is on the trip):
// POST   collage/share        -> mint a public share for the board this device just rendered
// POST   collage/share/<id>/video, …/item  -> its looping render, and its photographs
// GET    collage/shares       -> the trip's shares
// DELETE collage/share/<id>   -> revoke one: the page stops answering and its files go
// Every write answers with the trip's `rev`.
//
// STORAGE (src/trips/storage.js): a board's files count against the trip's host until it is
// revoked. Each upload here puts its row first, at its size, only if it fits the host's limit,
// then the file (a file that can't be put takes its row back). Revoking a board, which its
// maker or the host may do, sends its files to the drain (src/trips/drain.js) and frees them
// at once; the share's row stays, revoked, so its link answers "gone". Deleting a memory
// revokes every board one of its photographs is on (src/api/memories.js): a photograph's item
// records the memory it came from (`memory`, from this landing on; older items don't know).
//
// A share is a SNAPSHOT: the caller renders the board it is looking at and
// posts the finished picture, and that picture is what a stranger sees forever. It cannot be a
// query re-run against the trip, because a share deliberately outlives the trip's storage
// window and the media may be gone by the time anyone opens it.
//
// THE BODY IS THE IMAGE, RAW. Not multipart, not base64: an export is 1-3 MB and base64 would
// add a third to it for no reason on the one connection that is usually a phone on hotel wifi.
// The metadata rides in the query string, which is a handful of short values.
import { json } from "./json.js";
import { err, nowSec } from "./trip.js";
import { formatBytes } from "../../public/js/shared/bytes.js";
import { REV, write } from "../trips/rev.js";
import { fitsNow, fitsSql, limitFor, reservationCut, storageFull } from "../trips/storage.js";
import { BOARDS_PER_TRIP_MAX } from "../../public/js/shared/limits.js";
import { queueFiles } from "../trips/drain.js";
import { sizeOf, stripMetadata } from "../media/strip.js";
import { GROUNDS } from "../../public/js/shared/board-look.js";

/**
 * The statements that revoke shares of a trip, by id: their files to the drain, their
 * photographs' rows gone, the share revoked. The ids are read before the batch, so the order
 * of its statements can't hide one from another. For one batch, after write()'s bump (rows
 * take REV(1)).
 */
export function revokeStatements(env, tripId, shareIds, now, why) {
  const ids = "SELECT id FROM collage_shares WHERE trip_id = ?1 AND revoked_at IS NULL AND id IN (SELECT value FROM json_each(?2))";
  const p = [tripId, JSON.stringify(shareIds)];
  return [
    queueFiles(env, `SELECT r2_key, NULL AS upload_id FROM collage_share_items WHERE share_id IN (${ids})
      UNION SELECT image_key, NULL FROM collage_shares WHERE id IN (${ids}) UNION SELECT video_key, NULL FROM collage_shares WHERE id IN (${ids})`, p, now),
    env.DB.prepare(`DELETE FROM collage_share_items WHERE share_id IN (${ids})`).bind(...p),
    env.DB.prepare(`UPDATE collage_shares SET revoked_at = ?3, revoked_why = ?4, rev = ${REV(1)} WHERE trip_id = ?1 AND revoked_at IS NULL AND id IN (SELECT value FROM json_each(?2))`).bind(...p, now, why),
  ];
}

const MAX_IMAGE = 12 * 1024 * 1024;

const BOARD_FIELDS = ["bx", "by", "bw", "bh", "bs", "bg"];
/**
 * The board as its maker saw it, from the query (migration 0041): where the board is in the share's picture (bx, by,
 * bw, bh: fractions of its width and height), the picture's pixels per board unit (bs) and the board's material (bg).
 * All six or none: none is a share drawn as before (its whole picture the board). Answers { board } or { refused }.
 */
export function boardOfQuery(q) {
  const given = BOARD_FIELDS.filter((k) => q.has(k));
  if (!given.length) return { board: null };
  const why = (reason) => ({ refused: { error: "bad board", reason } });
  if (given.length !== BOARD_FIELDS.length) {
    return why(`A board is sent with all of ${BOARD_FIELDS.join(", ")}, or none of them; this one is missing ${BOARD_FIELDS.filter((k) => !q.has(k)).join(", ")}.`);
  }
  const num = (k) => { const v = q.get(k); return /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v ?? "") ? Number(v) : NaN; };
  const [x, y, w, h, scale] = ["bx", "by", "bw", "bh", "bs"].map(num);
  const ground = q.get("bg");
  const EPS = 1e-4;
  if (![x, y, w, h, scale].every(Number.isFinite)) return why("The board's place and scale are numbers.");
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 + EPS || y + h > 1 + EPS) {
    return why("The board's place is a rectangle inside the picture: bx and by from 0, bw and bh above 0, and bx + bw and by + bh at most 1.");
  }
  if (!(scale > 0 && scale <= 64)) return why("The board's scale (the picture's pixels per board unit) is above 0 and at most 64.");
  if (!Object.hasOwn(GROUNDS, ground)) return why(`The board's material is one of ${Object.keys(GROUNDS).join(", ")}.`);
  return { board: { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y), scale, ground } };
}
const MAX_VIDEO = 40 * 1024 * 1024;
const GONE_BOARD = "This board was taken down, so nothing more can be added to it.";

/** 128 bits, url-safe. THE ID IS THE SECRET — there is no other gate on a share link. */
function mintId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function onRequest(ctx) {
  const seg = [].concat(ctx.params?.path || []).filter(Boolean);
  const method = ctx.request.method.toUpperCase();

  // MOST SPECIFIC FIRST. `share` + POST matched /share/<id>/video too, so the looping render
  // was being handed to createShare() as if it were the still — which rejected it as an
  // unsupported image type and cost the share its motion, silently, because the client treats
  // the video as best-effort.
  if (seg[0] === "share" && seg[1] && seg[2] === "video" && method === "POST")
    return attachVideo(ctx, seg[1]);
  if (seg[0] === "share" && seg[1] && seg[2] === "item" && method === "POST")
    return attachItem(ctx, seg[1]);
  if (seg[0] === "share" && seg.length === 1 && method === "POST") return createShare(ctx);
  if (seg[0] === "share" && seg[1] && method === "DELETE") return revokeShare(ctx, seg[1]);
  if (seg[0] === "shares" && method === "GET") return listShares(ctx);
  return err(404, "not found");
}

async function createShare(ctx) {
  const { trip, user } = ctx.data;
  // At most BOARDS_PER_TRIP_MAX boards shared from a trip at once (one revoked doesn't count).
  const boards = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM collage_shares WHERE trip_id = ?1 AND revoked_at IS NULL").bind(trip.id).first();
  if ((boards?.n ?? 0) >= BOARDS_PER_TRIP_MAX) {
    return err(409, "too many boards", { max: BOARDS_PER_TRIP_MAX, reason: `A trip can have ${BOARDS_PER_TRIP_MAX} boards shared at once. Stop sharing an old one first.` });
  }

  const q = new URL(ctx.request.url).searchParams;
  const mime = (q.get("mime") || "image/jpeg").slice(0, 60);
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) return err(400, "unsupported image type");
  const width = Math.max(0, Math.min(20000, Number(q.get("w")) || 0));
  const height = Math.max(0, Math.min(20000, Number(q.get("h")) || 0));
  const title = (q.get("title") || "").slice(0, 120);
  const { board, refused } = boardOfQuery(q);
  if (refused) return err(400, refused.error, { reason: refused.reason });

  const buf = await ctx.request.arrayBuffer();
  if (!buf || !buf.byteLength) return err(400, "no image");
  if (buf.byteLength > MAX_IMAGE) return err(413, "image too large", { max_bytes: MAX_IMAGE, reason: `A board's picture can be at most ${formatBytes(MAX_IMAGE)}, and this one is ${formatBytes(buf.byteLength)}. Fewer photographs make a smaller board.` });

  const id = mintId();
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const key = `shares/${id}.${ext}`;
  // The row first, only if it fits the host's limit; then the file. Asked first, so a board that doesn't fit writes nothing.
  const now = nowSec();
  if (!(await fitsNow(ctx.env, trip, buf.byteLength, now))) return storageFull(ctx.env, { trip, user, needed: buf.byteLength, now });
  const { rev, results: [made] } = await write(ctx.env, trip.id, [ctx.env.DB.prepare(
    "INSERT INTO collage_shares (id, trip_id, created_by, created_at, title, image_key, " +
    "image_mime, width, height, bytes, board_x, board_y, board_w, board_h, board_scale, board_ground, rev) " +
    `SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?13,?14,?15,?16,?17,?18,${REV(2)} ` +
    `WHERE ${fitsSql({ trip: "?2", needed: "?10", limit: "?11", cut: "?12" })}`
  ).bind(id, trip.id, user.id, now, title, key, mime, width, height, buf.byteLength, await limitFor(ctx.env, trip.host_id), reservationCut(now),
    board?.x ?? null, board?.y ?? null, board?.w ?? null, board?.h ?? null, board?.scale ?? null, board?.ground ?? null)]);
  if (!made.meta.changes) return storageFull(ctx.env, { trip, user, needed: buf.byteLength, now });
  // httpMetadata so the public route can stream it straight back with the right type and a
  // long cache: a share is immutable by construction — a new render is a new id.
  try {
    await ctx.env.MEDIA.put(key, buf, {
      httpMetadata: { contentType: mime, cacheControl: "public, max-age=31536000, immutable" },
    });
  } catch (e) {
    await ctx.env.DB.prepare("DELETE FROM collage_shares WHERE id = ?1").bind(id).run();
    return err(502, "could not store the board", { detail: String(e?.message || e) });
  }

  return json({ share: { id, url: `/s/${id}`, title, width, height, bytes: buf.byteLength, rev }, rev }, 201);
}

// POST collage/share/<id>/video — attach the looping render to a share that already has
// its still. TWO CALLS, not one: the still is the funnel and must land even if recording fails
// or the phone cannot record at all, so a share is never held hostage to the harder half.
async function attachVideo(ctx, id) {
  const { trip } = ctx.data;

  const q = new URL(ctx.request.url).searchParams;
  const mime = (q.get("mime") || "video/mp4").slice(0, 60);
  if (!/^video\/(mp4|webm)/.test(mime)) return err(400, "unsupported video type");

  const row = await ctx.env.DB.prepare(
    "SELECT id, video_bytes FROM collage_shares WHERE id = ?1 AND trip_id = ?2 AND revoked_at IS NULL"
  ).bind(id, trip.id).first();
  if (!row) return err(404, "not found", { reason: GONE_BOARD });

  const buf = await ctx.request.arrayBuffer();
  if (!buf || !buf.byteLength) return err(400, "no video");
  if (buf.byteLength > MAX_VIDEO) return err(413, "video too large", { max_bytes: MAX_VIDEO, reason: `A board's video can be at most ${formatBytes(MAX_VIDEO)}, and this one is ${formatBytes(buf.byteLength)}. Fewer photographs make a smaller board.` });

  const ext = /webm/.test(mime) ? "webm" : "mp4";
  const key = `shares/${id}.${ext}`;
  // The row first (the video's bytes on the share), only if it fits; a video sent again
  // replaces the last one, so only what it adds counts against the limit. Asked first, so one that doesn't fit writes nothing.
  const now = nowSec();
  const had = (await ctx.env.DB.prepare("SELECT COALESCE(video_bytes, 0) AS b FROM collage_shares WHERE id = ?1 AND trip_id = ?2").bind(id, trip.id).first())?.b ?? 0;
  if (!(await fitsNow(ctx.env, trip, buf.byteLength - had, now))) return storageFull(ctx.env, { trip, user: ctx.data.user, needed: buf.byteLength, now });
  const { rev, results: [set] } = await write(ctx.env, trip.id, [ctx.env.DB.prepare(
    `UPDATE collage_shares SET video_key = ?1, video_mime = ?2, video_bytes = ?3, rev = ${REV(5)} WHERE id = ?4 AND trip_id = ?5 ` +
    `AND ${fitsSql({ trip: "?5", needed: "(?3 - COALESCE(video_bytes, 0))", limit: "?6", cut: "?7" })}`
  ).bind(key, mime, buf.byteLength, id, trip.id, await limitFor(ctx.env, trip.host_id), reservationCut(now))]);
  if (!set.meta.changes) return storageFull(ctx.env, { trip, user: ctx.data.user, needed: buf.byteLength, now });
  try {
    await ctx.env.MEDIA.put(key, buf, {
      httpMetadata: { contentType: mime, cacheControl: "public, max-age=31536000, immutable" },
    });
  } catch (e) {
    await ctx.env.DB.prepare("UPDATE collage_shares SET video_key = NULL, video_mime = NULL, video_bytes = NULL WHERE id = ?1").bind(id).run();
    return err(502, "could not store the video", { detail: String(e?.message || e) });
  }

  return json({ share: { id, url: `/s/${id}`, video_bytes: buf.byteLength, rev }, rev });
}

// POST collage/share/<id>/item?idx=&kind=&mime=&w=&h=&fx=&fy=&fw=&fh=&rot=
//
// One photograph, at ITS OWN resolution, beside the flattened board. See migration 0014 for
// why: no single canvas can hold twenty 12-megapixel photos at full size, so the board is the
// overview and these are what you actually look at when you tap one.
//
// Best-effort by design. Every item is a separate call, and a share is already complete and
// shareable before the first one lands — a phone that gives up halfway leaves a board whose
// prints are not all tappable, which is a smaller loss than a share that failed.
async function attachItem(ctx, id) {
  const { trip } = ctx.data;

  const row = await ctx.env.DB.prepare(
    "SELECT id FROM collage_shares WHERE id = ?1 AND trip_id = ?2 AND revoked_at IS NULL"
  ).bind(id, trip.id).first();
  if (!row) return err(404, "not found", { reason: GONE_BOARD });

  const q = new URL(ctx.request.url).searchParams;
  // The memory the photograph came from, so deleting it takes the photograph off the board.
  const memory = q.get("memory") || null;
  if (memory) {
    const m = await ctx.env.DB.prepare("SELECT 1 FROM memories WHERE id = ?1 AND trip_id = ?2").bind(memory, trip.id).first();
    if (!m) return err(400, "no such memory", { memory, reason: "The memory this photograph came from was deleted meanwhile." });
  }
  // The photograph itself, among the memory's (migration 0026): its thumbnail is what the board's
  // page draws when a tile needs no more than that. Left out (an app from before, an older
  // board), the item keeps none and the page uses the original. Named, it must be one of the
  // memory's own.
  const media = q.get("media") || null;
  let thumbKey = "";
  if (media) {
    if (!memory) return err(400, "media without its memory", { media, reason: "A photograph's media id comes with the memory it belongs to (memory=<id>)." });
    const mm = await ctx.env.DB.prepare("SELECT thumb_key FROM memory_media WHERE id = ?1 AND memory_id = ?2").bind(media, memory).first();
    if (!mm) return err(400, "no such media", { media, memory, reason: "That photograph isn't one of the memory's; it may have been taken out of it meanwhile." });
    thumbKey = mm.thumb_key || "";
  }
  const idx = Math.max(0, Math.min(9999, Number(q.get("idx")) || 0));
  const kind = q.get("kind") === "video" ? "video" : "photo";
  const asked = (q.get("mime") || "image/jpeg").slice(0, 60);
  if (!/^(image|video)\//.test(asked)) return err(400, "unsupported type");
  const num = (k) => { const n = Number(q.get(k)); return Number.isFinite(n) ? n : 0; };
  // Which fastener holds it, as the app chose (an unsigned 32-bit number); none for an app that doesn't send one.
  const pinSaid = q.get("pin");
  if (pinSaid != null && !(/^\d{1,10}$/.test(pinSaid) && Number(pinSaid) <= 0xffffffff)) {
    return err(400, "bad pin", { reason: "A photograph's pin is a whole number from 0 to 4294967295, the app's own for it." });
  }
  const pin = pinSaid == null ? null : Number(pinSaid);

  const sent = await ctx.request.arrayBuffer();
  if (!sent || !sent.byteLength) return err(400, "no bytes");
  if (sent.byteLength > (kind === "video" ? MAX_VIDEO : MAX_IMAGE)) return err(413, "too large", { max_bytes: kind === "video" ? MAX_VIDEO : MAX_IMAGE, reason: `A ${kind} on a board can be at most ${formatBytes(kind === "video" ? MAX_VIDEO : MAX_IMAGE)}, and this one is ${formatBytes(sent.byteLength)}. Fewer photographs make a smaller board.` });
  // A board's link is open to anyone: what's kept for it carries nothing a camera wrote into the file (where and when it
  // was taken, the device), whatever the phone sent (src/media/strip.js; the trip's own original is left as it is).
  const clean = stripMetadata(new Uint8Array(sent));
  if (clean.refused) return err(415, "unsupported type", { reason: clean.refused });
  const buf = clean.bytes;
  // Its size, as the page says it: what the app sent, or (an app that didn't know sends 0) the file's own header's.
  const said = { width: Math.round(num("w")), height: Math.round(num("h")) };
  const size = said.width > 0 && said.height > 0 ? said : (sizeOf(buf) ?? { width: 0, height: 0 });

  // The type is the cleaned bytes' own, never only what was said.
  const mime = clean.format === "mp4" ? (/^video\/(mp4|quicktime)$/.test(asked) ? asked : "video/mp4") : `image/${clean.format}`;
  const ext = (mime.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "").slice(0, 5);
  const key = `shares/${id}/i${idx}.${ext}`;
  // The row first, only if it fits (an item sent again replaces its slot, so only what it adds
  // counts); then the file. Asked first, so one that doesn't fit writes nothing.
  const now = nowSec();
  const was = (await ctx.env.DB.prepare("SELECT COALESCE(bytes, 0) AS b FROM collage_share_items WHERE share_id = ?1 AND idx = ?2").bind(id, idx).first())?.b ?? 0;
  if (!(await fitsNow(ctx.env, trip, buf.byteLength - was, now))) return storageFull(ctx.env, { trip, user: ctx.data.user, needed: buf.byteLength, now });
  const { rev, results: [put] } = await write(ctx.env, trip.id, [
    ctx.env.DB.prepare(
      "INSERT OR REPLACE INTO collage_share_items " +
      "(share_id, idx, kind, r2_key, mime, bytes, width, height, fx, fy, fw, fh, rot, memory_id, thumb_key, pin) " +
      "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?18,?19 " +
      `WHERE ${fitsSql({ trip: "?15", needed: "(?6 - COALESCE((SELECT bytes FROM collage_share_items WHERE share_id = ?1 AND idx = ?2), 0))", limit: "?16", cut: "?17" })}`
    ).bind(id, idx, kind, key, mime, buf.byteLength,
      size.width, size.height,
      num("fx"), num("fy"), num("fw"), num("fh"), num("rot"), memory, trip.id, await limitFor(ctx.env, trip.host_id), reservationCut(now), kind === "photo" ? thumbKey : "", pin),
    ctx.env.DB.prepare(`UPDATE collage_shares SET rev = ${REV(2)} WHERE id = ?1 AND trip_id = ?2`).bind(id, trip.id),
  ]);
  if (!put.meta.changes) return storageFull(ctx.env, { trip, user: ctx.data.user, needed: buf.byteLength, now });
  try {
    await ctx.env.MEDIA.put(key, buf, {
      httpMetadata: { contentType: mime, cacheControl: "public, max-age=31536000, immutable" },
    });
  } catch (e) {
    await ctx.env.DB.prepare("DELETE FROM collage_share_items WHERE share_id = ?1 AND idx = ?2").bind(id, idx).run();
    return err(502, "could not store the photograph", { detail: String(e?.message || e) });
  }

  return json({ ok: true, idx, bytes: buf.byteLength, rev });
}

// The trip's boards, newest first, the 50 most recent, to any member (they are made of the
// trip's memories, which every member sees). A revoked board stays listed, as long as it is
// among those 50, so its maker sees that it stopped and why; its files are gone already.
// `memories` names the memories a live board's photographs come from (none for a board from
// before photographs recorded their memory, nor for a revoked one: its photographs went with it).
async function listShares(ctx) {
  const tripId = ctx.data.trip.id;
  const [rows, shown] = await Promise.all([
    ctx.env.DB.prepare(
      "SELECT id, created_at, created_by, title, width, height, bytes, revoked_at, revoked_why, rev FROM collage_shares " +
      "WHERE trip_id = ?1 ORDER BY created_at DESC, id LIMIT 50"
    ).bind(tripId).all(),
    ctx.env.DB.prepare(
      "SELECT DISTINCT i.share_id, i.memory_id FROM collage_share_items i JOIN collage_shares s ON s.id = i.share_id " +
      "WHERE s.trip_id = ?1 AND s.revoked_at IS NULL AND i.memory_id IS NOT NULL ORDER BY i.share_id, i.memory_id"
    ).bind(tripId).all(),
  ]);
  const memoriesOf = new Map();
  for (const r of shown.results || []) (memoriesOf.get(r.share_id) ?? memoriesOf.set(r.share_id, []).get(r.share_id)).push(r.memory_id);
  return json({
    shares: (rows.results || []).map((r) => ({
      id: r.id, url: `/s/${r.id}`, created_at: r.created_at, created_by: r.created_by, title: r.title || "",
      width: r.width, height: r.height, bytes: r.bytes, revoked: !!r.revoked_at, revoked_at: r.revoked_at ?? null,
      revoked_why: r.revoked_why ?? null, memories: r.revoked_at ? [] : memoriesOf.get(r.id) ?? [], rev: r.rev,
    })),
  });
}

// Its maker or the trip's host. Revoking twice is success that changes nothing.
async function revokeShare(ctx, id) {
  const { trip, user, host } = ctx.data;
  const row = await ctx.env.DB.prepare("SELECT created_by, revoked_at FROM collage_shares WHERE id = ?1 AND trip_id = ?2").bind(id, trip.id).first();
  if (!row || row.revoked_at) return json({ ok: true, revoked: false, rev: trip.rev });
  if (row.created_by !== user.id && !host) return err(403, "forbidden", { reason: "only its maker or the trip's host revokes a board" });
  // Why it stopped, for its maker to see: they revoked it themselves, or the host did.
  const why = row.created_by === user.id ? "maker" : "host";
  const { rev } = await write(ctx.env, trip.id, revokeStatements(ctx.env, trip.id, [id], nowSec(), why));
  return json({ ok: true, revoked: true, rev });
}

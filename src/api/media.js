// Media upload — the bytes half of the Memories tab.
//
// Under /api/trips/<trip>/ (the route table checks the caller is on the trip, and every key
// named here is looked up inside that trip: another trip's key is "no such"):
//   GET    media/config                       -> the tunable constants, one copy
//   POST   media/begin   {name,mime,bytes,..,id?} -> {key, uploadId, part_size, parts}   201; 200 when
//                                                 sent again with its id while its upload is under way
//   POST   media/part    ?key=&id=&n=  (bin)  -> {n, etag}
//   POST   media/finish  {key,id,parts[]}     -> {ok, key, bytes, url, rev}    the same answer when sent
//                                                 again after it stored the file
//   POST   media/abort   {key,id}             -> {ok}
//   POST   media/thumb   ?for=&mime=   (bin)  -> {key, bytes, url, rev}
//   DELETE media/object  ?key=                -> {ok, deleted, freed_bytes, rev}   unattached only;
//                                                 an upload under way is cancelled
//
// The trip's rev goes up when stored bytes change (finish, thumb, delete), not while an
// upload is still in pieces: nothing anyone can read has changed until it lands.
//
// ── STORAGE (src/trips/storage.js) ──────────────────────────────────────────────────────
// What the trip's host holds is read from the rows. Every file begins with ONE conditional
// insert of its row at its declared size, which succeeds only if it fits the host's limit:
// `begin` for an original (the row holds its bytes for a day while the upload is under way),
// `thumb` for a thumbnail. An upload past its day no longer holds them, so `part` and
// `finish` refuse it (409 "upload expired": begin again); it can still be cancelled. A write that doesn't fit is refused before any bytes move, with
// what is in the way. `finish` refuses an upload that came out bigger than it declared (its
// file goes to the drain), so nobody can reserve a byte and store a gigabyte. The uploader or
// the trip's host can cancel an upload under way (DELETE media/object), which frees its bytes
// at once. The meter is GET /api/account/storage and the snapshot's `storage`.
//
// ── THE FIDELITY GUARANTEE, IN CODE ─────────────────────────────────────────────────────
// Nothing in this file reads, rewrites, compresses, transcodes or re-encodes a single byte
// of an original. `begin` mints a key, `part` hands R2 the ArrayBuffer it was given, and
// `finish` calls complete(). The object that lands in the bucket is byte-for-byte what the
// browser handed the fetch. There is no image pipeline here and there is not going to be
// one: the whole point of the tab is that a person gets their own photo back, not our idea of it.
//
// ── WHY MULTIPART, AND WHY NOT PRESIGNED URLS ───────────────────────────────────────────
// The Workers request body limit is ~100MB. A 4K video off a phone is bigger than
// that, so "PUT the file" cannot work at any part count of one. Presigned S3 URLs would
// dodge the limit but need an R2 access key minted, stored and shipped to a phone — a
// credential that outlives the session cookie and that nothing else in this app has. The
// binding's own multipart API needs no credential at all: the session cookie that already
// gates every other route gates this one, and R2 is reached through the binding.
//
// PART SIZE IS 8 MiB AND THAT IS A HOSTEL-WIFI DECISION, not an R2 one. R2's floor is 5 MiB
// and its ceiling is 5 GiB; 8 MiB is the size where a part still lands inside a phone's
// patience on a bad connection, and where losing one costs you 8 MiB of re-upload instead of
// the whole video. Retry is per part: re-POST the same n, take the new etag, carry on. R2
// keeps whichever upload of part n landed last, so a retried part is not a duplicate.
//
// ── sha256 IS CLIENT-DECLARED AND IS NOT A SERVER-SIDE CHECK ────────────────────────────
// It is recorded because it is the handle the on-device fidelity test compares against,
// and because it makes the key content-identifying. It is NOT verified here, and the code
// must not pretend otherwise: WebCrypto's digest() takes a whole buffer, there is no
// streaming SHA-256 in Workers, and a 128MB isolate cannot hold a 4K video to hash it. The
// integrity claim this service actually makes is narrower and stronger — we never touch the
// bytes — and it is verified from OUTSIDE, by hashing what went up and what came back down.
//
// ── KEYS ARE MINTED HERE AND ARE OPAQUE TO CLIENTS ──────────────────────────────────────
// `o/<ab>/<sha-or-random>/<12 random hex><ext>`. The random tail is what makes the key
// WRITE-ONCE: two people uploading the identical photo get two keys, so a key's bytes can
// never change under a cache, which is what earns `immutable` on the serving route. The hash
// prefix is there so a future dedup pass has something to group on; it is deliberately not
// load-bearing today, because a client that lies about its hash must not be able to land on
// somebody else's key.

import { json, readJson } from "./json.js";
import { err, nowSec, str } from "./trip.js";
import { formatBytes } from "../../public/js/shared/bytes.js";
import { bump, moved } from "../trips/rev.js";
import { fitsNow, fitsSql, limitFor, reservationCut, storageFull } from "../trips/storage.js";
import { queueFiles } from "../trips/drain.js";
import { hostOnly } from "../trips/access.js";
import { MAP_UPLOAD_MAX_BYTES } from "../../public/js/shared/limits.js";
import { stripMetadata } from "../media/strip.js";
import { readNewId } from "../../public/js/shared/trip-rules.js";

// ── tunables, in one named place ────────────────────────────────────────────────────────────
export const PART_SIZE = 8 * 1024 * 1024;              // 8 MiB. R2 floor is 5 MiB.
export const MAX_BYTES = 8 * 1024 * 1024 * 1024;       // 8 GiB per file.
export const MAX_PARTS = 10000;                        // R2's own ceiling.
export const THUMB_MAX_BYTES = 2 * 1024 * 1024;        // a 480px webp is ~40KB; 2MiB is slack.
// The iOS save budget. NOT used by this file — it is published through media/config so
// the save path has one place to read it and one place to tune it after the
// on-device calibration. Blob memory, not a per-video rule: navigator.share() needs one
// gesture per CALL, so files pack greedily until the next one would cross this.
export const SHARE_BATCH_BUDGET_BYTES = 350 * 1024 * 1024;

// The file input's accept list. HEIC/HEIF and QuickTime are named EXPLICITLY, not left to
// the wildcards: Safari transcodes HEIC->JPEG and re-encodes HEVC at PICK time — before any
// of this code runs — when the input does not declare it can take them. That conversion is
// the one fidelity loss this service cannot undo, so the mitigation lives at the only point
// it can, in the markup, and it is published from here so there is a single spelling of it.
export const ACCEPT = [
  "image/*", "video/*",
  "image/heic", "image/heif", "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/quicktime", "video/mp4", "video/webm",
].join(",");

const THUMB_MIMES = ["image/webp", "image/jpeg", "image/png"];
const KINDS = ["photo", "video"];
const SHA_RE = /^[0-9a-f]{64}$/;

// Keys are minted by mintKey() and only ever travel back to us verbatim. The guard exists
// because they arrive in a query string and in a JSON body, and a key is used to index D1
// and to address R2 — a path segment that can hold ".." or a leading slash is a traversal
// waiting for a careless join.
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,199}$/;
export const validKey = (k) =>
  typeof k === "string" && KEY_RE.test(k) && !k.split("/").includes("..");

const EXT_BY_MIME = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
  "image/heic": ".heic", "image/heif": ".heif", "image/avif": ".avif",
  "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
};

function hex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// The extension is cosmetic — Content-Type on the way out comes from the registry, never
// from the key — but it is what makes an object recognisable in `wrangler r2 object list`
// and what a download-fallback filename ends up wearing.
function extOf(name, mime) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ""));
  if (m) return "." + m[1].toLowerCase();
  return EXT_BY_MIME[String(mime || "").toLowerCase()] || "";
}

function mintKey(role, sha, name, mime) {
  const digest = SHA_RE.test(sha) ? sha : hex(32);
  const ext = role === "thumb" ? ".webp" : extOf(name, mime);
  return `${role === "thumb" ? "t" : "o"}/${digest.slice(0, 2)}/${digest}/${hex(6)}${ext}`;
}

// A mime type is stored and served verbatim, so it has to be a mime type and not a header
// injection. Parameters (`; codecs=...`) are kept: they are load-bearing for video.
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}(;[ -~]{0,128})?$/;
export const validMime = (m) => typeof m === "string" && MIME_RE.test(m);

const kindOfMime = (m) => (String(m || "").toLowerCase().startsWith("video/") ? "video" : "photo");

export const mediaUrl = (key) => `/media/${key}`;

// ────────────────────────────────────────────────────────────────────────────────────────
// Dispatch. The route table hands us media/<action>; a bare media address lands here too,
// with no path, and answers with the route list rather than a bare 404: a wrong URL should
// say so.
export async function onRequest(ctx) {
  const action = [].concat(ctx.params?.path || []).join("/");
  const method = ctx.request.method.toUpperCase();

  if (!ctx.env.MEDIA) return err(503, "MEDIA bucket not bound");

  const table = {
    "config:GET": config,
    "begin:POST": begin,
    "part:POST": part,
    "part:PUT": part,
    "finish:POST": finish,
    "abort:POST": abort,
    "thumb:POST": thumb,
    "thumb:PUT": thumb,
    "object:DELETE": deleteObject,
  };
  const fn = table[`${action}:${method}`];
  if (fn) return fn(ctx);

  const known = Object.keys(table).map((k) => k.split(":")[0]);
  if (known.includes(action))
    return err(405, "method not allowed", { action, allowed: Object.keys(table).filter((k) => k.startsWith(action + ":")).map((k) => k.split(":")[1]) });
  return err(404, "no such media route", { action, routes: [...new Set(known)] });
}

// ── GET media/config ───────────────────────────────────────────────────────────────
async function config() {
  return json({
    part_size: PART_SIZE,
    max_bytes: MAX_BYTES,
    max_parts: MAX_PARTS,
    thumb_max_bytes: THUMB_MAX_BYTES,
    thumb_mimes: THUMB_MIMES,
    share_batch_budget_bytes: SHARE_BATCH_BUDGET_BYTES,
    accept: ACCEPT,
  });
}

// ── POST media/begin ───────────────────────────────────────────────────────────────
// {name, mime, bytes, kind?, sha256?} -> {key, uploadId, part_size, parts, ...}
//
// `bytes` is declared up front for one reason: it fixes the part count, which is what lets
// `part` reject a client that sliced at the wrong size. R2 requires every part but the last
// to be identical in size, and a client that slices at 5 MiB against our 8 MiB plan does not
// fail until complete(), forty parts later, with an error that names nothing useful.
async function begin(ctx) {
  const { user: u, trip } = ctx.data;

  const b = await readJson(ctx.request);
  const name = str(b.name, 255);
  const mime = str(b.mime, 191);
  const bytes = Number(b.bytes);

  if (!validMime(mime)) return err(400, "bad mime", { mime, reason: `A file's type is written like image/jpeg or video/mp4; "${String(b.mime ?? "").slice(0, 40)}" isn't one.` });
  if (!Number.isInteger(bytes) || bytes <= 0)
    return err(400, "bytes must be a positive integer", { bytes: b.bytes });
  if (bytes > MAX_BYTES) return err(413, "file too large", { bytes, max_bytes: MAX_BYTES, reason: `A file can be at most ${formatBytes(MAX_BYTES)}, and this one is ${formatBytes(bytes)}.` });

  const parts = Math.ceil(bytes / PART_SIZE);
  if (parts > MAX_PARTS) return err(413, "too many parts", { parts, max_parts: MAX_PARTS });

  // A trip's map, uploaded (option 4 of docs/map-options.md): the host's, at most
  // MAP_UPLOAD_MAX_BYTES, kept like any file and counted against the host's storage.
  const isMap = b.kind === "map";
  if (isMap && !ctx.data.host) return hostOnly();
  if (isMap && bytes > MAP_UPLOAD_MAX_BYTES) {
    return err(413, "map too large", { bytes, max_bytes: MAP_UPLOAD_MAX_BYTES, reason: `A trip's map can be at most ${formatBytes(MAP_UPLOAD_MAX_BYTES)}, and this one is ${formatBytes(bytes)}. Cut a smaller area, or fewer zoom levels.` });
  }
  const kind = isMap ? "map" : KINDS.includes(b.kind) ? b.kind : kindOfMime(mime);
  const sha256 = SHA_RE.test(String(b.sha256 || "")) ? String(b.sha256) : "";
  const ts = nowSec();

  // The phone's own id for this upload, when it names one (migration 0042). A begin sent again with
  // it (the first answer lost on the way) is handed the upload the first one opened, while that is
  // still under way: the file's room is held once, not twice for a day. The same id for another
  // file is refused in words. One whose upload finished, lapsed or was cancelled begins afresh.
  let beginId = null;
  if (b.id !== undefined && b.id !== null) {
    const okId = readNewId(b.id);
    if (!okId.ok) return err(400, "bad id", { id: b.id, reason: okId.error });
    beginId = okId.id;
    const was = await ctx.env.DB.prepare(
      "SELECT r2_key, upload_id, kind, mime, orig_name, bytes FROM media_objects " +
      "WHERE trip_id = ?1 AND user_id = ?2 AND begin_id = ?3 AND state = 'pending' AND upload_id != '' AND created_at > ?4 " +
      "ORDER BY created_at DESC LIMIT 1"
    ).bind(trip.id, u.id, beginId, reservationCut(ts)).first();
    if (was) {
      if (Number(was.bytes) !== bytes || was.mime !== mime || was.orig_name !== name || was.kind !== kind) {
        return err(409, "id already used", { id: beginId, reason: `"${beginId}" already names an upload under way of another file: choose another id for this one.` });
      }
      return json({
        key: was.r2_key, uploadId: was.upload_id,
        part_size: PART_SIZE, parts, bytes, mime, kind, name,
      });
    }
  }
  const key = mintKey("original", sha256, name, mime);

  // The row first, at the declared size, and only if it fits the host's limit: from here until
  // it finishes (or a day passes) these bytes are held for it.
  const held = await ctx.env.DB.prepare(
    "INSERT INTO media_objects (r2_key, upload_id, user_id, trip_id, role, kind, mime, " +
    "orig_name, bytes, sha256, state, thumb_for, created_at, stored_at, begin_id) " +
    "SELECT ?1, '', ?2, ?3, ?12, ?4, ?5, ?6, ?7, ?8, 'pending', '', ?9, NULL, ?13 " +
    `WHERE ${fitsSql({ trip: "?3", needed: "?7", limit: "?10", cut: "?11" })}`
  ).bind(key, u.id, trip.id, kind, mime, name, bytes, sha256, ts, await limitFor(ctx.env, trip.host_id), reservationCut(ts), isMap ? "map" : "original", beginId).run();
  if (!held.meta.changes) return storageFull(ctx.env, { trip, user: u, needed: bytes, now: ts });

  let mpu;
  try {
    mpu = await ctx.env.MEDIA.createMultipartUpload(key, {
      httpMetadata: { contentType: mime },
      customMetadata: { orig_name: name, sha256, user: u.id },
    });
  } catch (e) {
    await ctx.env.DB.prepare("DELETE FROM media_objects WHERE r2_key = ?1 AND state = 'pending'").bind(key).run();
    return err(502, "could not open upload", { detail: String(e && e.message || e) });
  }
  await ctx.env.DB.prepare("UPDATE media_objects SET upload_id = ?2 WHERE r2_key = ?1").bind(key, mpu.uploadId).run();

  return json({
    key, uploadId: mpu.uploadId,
    part_size: PART_SIZE, parts, bytes, mime, kind, name,
  }, 201);
}

// Every part/finish/abort call re-reads the row that opened the upload and re-checks the
// uploader. The uploadId alone is not an authorisation: it is a handle, it travels in a
// query string, and it ends up in server logs.
// An upload holds its declared size for RESERVATION_SECONDS from when it began (storage.js).
// Past that the room is no longer its, so it may no longer take parts or finish: holding the
// room and being allowed to finish are one condition. It can still be cancelled.
const expired = (key) => err(409, "upload expired", {
  key, reason: "This upload took more than a day, so the room it held is no longer kept for it. Begin it again.",
});

async function pendingUpload(ctx, key, uploadId, { lapsed = false, stored = false } = {}) {
  if (!validKey(key)) return { error: err(400, "bad key", { key }) };
  if (!uploadId || typeof uploadId !== "string" || uploadId.length > 512)
    return { error: err(400, "bad uploadId") };
  const { user: u, trip } = ctx.data;
  const row = await ctx.env.DB.prepare(
    "SELECT r2_key, upload_id, user_id, trip_id, mime, bytes, state, created_at FROM media_objects " +
    "WHERE r2_key = ?1 AND trip_id = ?2"
  ).bind(key, trip.id).first();
  if (!row) return { error: err(404, "no such upload", { key }) };
  if (row.user_id !== u.id) return { error: err(403, "forbidden", { reason: "This upload was started by another person: only they can go on with it." }) };
  // `stored`: finish sent again for this very upload (the same person, the same uploadId), its
  // answer lost on the way: it was stored, and that is the answer.
  if (stored && row.state === "stored" && row.upload_id === uploadId) return { u, trip, row, stored: true };
  if (row.state !== "pending") return { error: err(409, "upload already " + row.state, { key, state: row.state }) };
  if (row.upload_id !== uploadId) return { error: err(409, "uploadId mismatch", { key }) };
  if (!lapsed && row.created_at <= reservationCut(nowSec())) return { error: expired(key) };
  return { u, trip, row };
}

// ── POST media/part?key=&id=&n= ────────────────────────────────────────────────────
// Body is the raw slice. 8 MiB in an isolate that gets 128 MB is comfortable, and reading it
// as an ArrayBuffer rather than streaming it through is what lets us MEASURE the part before
// R2 sees it — a wrongly-sliced upload dies here, on part 2, naming the size we wanted.
async function part(ctx) {
  const q = new URL(ctx.request.url).searchParams;
  const key = q.get("key") || "";
  const uploadId = q.get("id") || "";
  const n = Number(q.get("n"));

  const g = await pendingUpload(ctx, key, uploadId);
  if (g.error) return g.error;

  const total = Math.ceil(g.row.bytes / PART_SIZE);
  if (!Number.isInteger(n) || n < 1 || n > total)
    return err(400, "bad part number", { n: q.get("n"), parts: total });

  let buf;
  try { buf = await ctx.request.arrayBuffer(); }
  catch (e) { return err(400, "could not read part body", { detail: String(e && e.message || e) }); }

  const want = n < total ? PART_SIZE : g.row.bytes - PART_SIZE * (total - 1);
  if (buf.byteLength !== want)
    return err(400, "wrong part size", { n, got: buf.byteLength, want, part_size: PART_SIZE });

  try {
    const mpu = ctx.env.MEDIA.resumeMultipartUpload(key, uploadId);
    const p = await mpu.uploadPart(n, buf);
    // etag is what complete() is keyed on. A retried part returns a NEW etag and the old one
    // stops being valid, so the client must replace, not append.
    return json({ n, etag: p.etag, bytes: buf.byteLength });
  } catch (e) {
    return err(502, "part upload failed", { n, detail: String(e && e.message || e) });
  }
}

// ── POST media/finish {key, id, parts:[{n,etag}]} ──────────────────────────────────
async function finish(ctx) {
  const b = await readJson(ctx.request);
  const key = String(b.key || "");
  const uploadId = String(b.id || b.uploadId || "");

  const g = await pendingUpload(ctx, key, uploadId, { stored: true });
  if (g.error) return g.error;
  // Sent again after it was stored (the first answer lost on a bad connection): what the first one
  // answered, read from what was stored, and nothing written. Without this the phone was told
  // "upload already stored", a refusal, and its upload failed for good with the file on the server.
  if (g.stored) {
    const obj = await ctx.env.MEDIA.head(key);
    return json({
      ok: true, key, bytes: Number(g.row.bytes), mime: g.row.mime, url: mediaUrl(key),
      etag: obj?.httpEtag || "", rev: g.trip.rev ?? null,
    });
  }

  const total = Math.ceil(g.row.bytes / PART_SIZE);
  const list = Array.isArray(b.parts) ? b.parts : [];
  if (list.length !== total)
    return err(400, "part count mismatch", { got: list.length, want: total });

  const parts = [];
  for (let i = 0; i < list.length; i++) {
    const n = Number(list[i]?.n ?? list[i]?.partNumber);
    const etag = String(list[i]?.etag || "");
    if (!Number.isInteger(n) || n < 1 || n > total || !etag)
      return err(400, "bad part entry", { index: i, entry: list[i] });
    parts.push({ partNumber: n, etag });
  }
  parts.sort((a, z) => a.partNumber - z.partNumber);
  for (let i = 0; i < parts.length; i++)
    if (parts[i].partNumber !== i + 1)
      return err(400, "parts must be 1..N with no gaps", { at: i + 1, got: parts[i].partNumber });

  let obj;
  try {
    const mpu = ctx.env.MEDIA.resumeMultipartUpload(key, uploadId);
    obj = await mpu.complete(parts);
  } catch (e) {
    return err(502, "complete failed", { detail: String(e && e.message || e) });
  }

  // R2's size, not the client's claim. The declared `bytes` only ever governed the part
  // arithmetic; what gets metered and what gets served is what actually landed.
  const size = Number(obj.size);
  const ts = nowSec();
  // Bigger than it said: the row held only what was declared, so the file goes (to the drain)
  // and the upload is refused. Otherwise one byte could reserve room for a gigabyte.
  if (size > Number(g.row.bytes)) {
    await ctx.env.DB.batch([
      queueFiles(ctx.env, "SELECT ?1 AS r2_key, NULL AS upload_id", [key], ts),
      ctx.env.DB.prepare("DELETE FROM media_objects WHERE r2_key = ?1").bind(key),
    ]);
    return err(400, "bigger than declared", { declared: Number(g.row.bytes), bytes: size, reason: "The file that arrived is bigger than the size the upload began with, so it wasn't kept. Begin again with its real size." });
  }
  // Stored only while it still holds its room: the same condition as above, in the write, so
  // an upload that lapses while R2 puts it together can't slip through.
  const done = await ctx.env.DB.batch([
    bump(ctx.env, g.trip.id),
    ctx.env.DB.prepare(
      "UPDATE media_objects SET state = 'stored', bytes = ?2, stored_at = ?3 " +
      "WHERE r2_key = ?1 AND state = 'pending' AND created_at > ?4"
    ).bind(key, size, ts, reservationCut(ts)),
  ]);
  await moved(ctx.env, g.trip.id, done[0].results[0]?.rev ?? null);
  if (!done[1].meta.changes) {
    const now = await ctx.env.DB.prepare("SELECT state FROM media_objects WHERE r2_key = ?1").bind(key).first();
    if (now?.state !== "stored") {
      // It lapsed, or was cancelled, in between: the file R2 just made goes to the drain.
      await ctx.env.DB.batch([
        queueFiles(ctx.env, "SELECT ?1 AS r2_key, NULL AS upload_id WHERE NOT EXISTS (SELECT 1 FROM media_objects WHERE r2_key = ?1 AND state = 'stored')", [key], ts),
        ctx.env.DB.prepare("DELETE FROM media_objects WHERE r2_key = ?1 AND state = 'pending'").bind(key),
      ]);
      return expired(key);
    }
    // Finished twice at once: the other one stored it, and this answers the same.
  }

  return json({
    ok: true, key, bytes: size, mime: g.row.mime, url: mediaUrl(key),
    etag: obj.httpEtag || "", rev: done[0].results[0]?.rev ?? null,
  });
}

// ── POST media/abort {key, id} ─────────────────────────────────────────────────────
// R2 charges for the parts of an abandoned multipart upload and the binding cannot list
// them, so the only way they ever go away is this call or a bucket lifecycle rule. The
// client calls it on cancel and on a fatal upload error.
async function abort(ctx) {
  const b = await readJson(ctx.request);
  const key = String(b.key || "");
  const uploadId = String(b.id || b.uploadId || "");

  const g = await pendingUpload(ctx, key, uploadId, { lapsed: true });
  if (g.error) {
    // Aborting something already aborted is success, same rule as deleting an already-gone
    // note: this call rides the same flaky connection the upload just died on.
    if (g.error.status === 409 || g.error.status === 404) return json({ ok: true, aborted: false });
    return g.error;
  }

  try { await ctx.env.MEDIA.resumeMultipartUpload(key, uploadId).abort(); } catch { /* already gone */ }
  // The row goes, and what it held is free at once.
  await ctx.env.DB.prepare("DELETE FROM media_objects WHERE r2_key = ?1 AND state = 'pending'").bind(key).run();
  return json({ ok: true, aborted: true });
}

// ── POST media/thumb?for=<original key>&mime=image/webp ────────────────────────────
// THE THUMBNAIL IS CLIENT-GENERATED AND THAT IS A PLATFORM FACT, NOT A SHORTCUT.
// A Worker has no image decoder: no canvas, no WASM codec small enough to ship in the
// bundle, and Cloudflare Images is a separate paid product that is not bound here. Decoding
// a 4K HEIC or seeking a video for a poster frame is not something this isolate can do at
// all. The browser already decoded the file to show the user a preview, so it generates the
// ~480px webp and posts it here as a single small PUT.
//
// The derivative NEVER replaces the original. It is its own key, its own row, its own bytes
// in the meter, and memory_media carries both — thumb_key for the feed, r2_key for the save.
async function thumb(ctx) {
  const { user: u, trip } = ctx.data;

  const q = new URL(ctx.request.url).searchParams;
  const mime = q.get("mime") || "image/webp";
  const forKey = q.get("for") || "";

  if (!THUMB_MIMES.includes(mime)) return err(400, "bad thumb mime", { mime, allowed: THUMB_MIMES });
  if (forKey && !validKey(forKey)) return err(400, "bad for key", { for: forKey });

  if (forKey) {
    const orig = await ctx.env.DB.prepare(
      "SELECT user_id, role FROM media_objects WHERE r2_key = ?1 AND trip_id = ?2"
    ).bind(forKey, trip.id).first();
    if (!orig) return err(404, "no such original", { for: forKey });
    if (orig.user_id !== u.id) return err(403, "forbidden", { reason: "A thumbnail goes with a file you uploaded yourself." });
    if (orig.role !== "original") return err(400, "for must name an original", { for: forKey });
  }

  let buf;
  try { buf = await ctx.request.arrayBuffer(); }
  catch (e) { return err(400, "could not read thumb body", { detail: String(e && e.message || e) }); }
  if (!buf.byteLength) return err(400, "empty thumb");
  if (buf.byteLength > THUMB_MAX_BYTES)
    return err(413, "thumb too large", { bytes: buf.byteLength, max_bytes: THUMB_MAX_BYTES });
  // A thumbnail is what a shared board's page draws for anyone with its link: it keeps nothing a camera wrote into a
  // file, whatever was sent (the app draws it on a canvas, which keeps none anyway; src/media/strip.js).
  const clean = stripMetadata(new Uint8Array(buf));
  if (clean.refused || clean.format === "mp4") return err(415, "bad thumb", { reason: "A thumbnail is a JPEG, PNG or WebP picture." });
  buf = clean.bytes;

  const key = mintKey("thumb", "", "", mime);
  // The row first, only if it fits the host's limit; then the file. A file that can't be put
  // takes its row back with it. Asked first, so a thumbnail that doesn't fit writes nothing (not even the rev).
  const ts = nowSec();
  if (!(await fitsNow(ctx.env, trip, buf.byteLength, ts))) return storageFull(ctx.env, { trip, user: u, needed: buf.byteLength, now: ts });
  const done = await ctx.env.DB.batch([
    bump(ctx.env, trip.id),
    ctx.env.DB.prepare(
      "INSERT INTO media_objects (r2_key, upload_id, user_id, trip_id, role, kind, mime, " +
      "orig_name, bytes, sha256, state, thumb_for, created_at, stored_at) " +
      "SELECT ?1, '', ?2, ?3, 'thumb', 'photo', ?4, '', ?5, '', 'stored', ?6, ?7, ?7 " +
      `WHERE ${fitsSql({ trip: "?3", needed: "?5", limit: "?8", cut: "?9" })}`
    ).bind(key, u.id, trip.id, mime, buf.byteLength, forKey, ts, await limitFor(ctx.env, trip.host_id), reservationCut(ts)),
  ]);
  await moved(ctx.env, trip.id, done[0].results[0]?.rev ?? null);
  if (!done[1].meta.changes) return storageFull(ctx.env, { trip, user: u, needed: buf.byteLength, now: ts });
  try {
    await ctx.env.MEDIA.put(key, buf, {
      httpMetadata: { contentType: mime },
      customMetadata: { thumb_for: forKey, user: u.id },
    });
  } catch (e) {
    await ctx.env.DB.prepare("DELETE FROM media_objects WHERE r2_key = ?1").bind(key).run();
    return err(502, "thumb upload failed", { detail: String(e && e.message || e) });
  }

  return json({ key, bytes: buf.byteLength, mime, url: mediaUrl(key), rev: done[0].results[0]?.rev ?? null }, 201);
}

// ── DELETE media/object?key= ───────────────────────────────────────────────────────
// The cancel path. An object that has been attached to a memory is NOT deletable here —
// that is DELETE memories/:id's job. This one hands back what a person uploaded and didn't
// use, and cancels an upload still under way, which frees the bytes it held at once. Whoever
// uploaded it may, and so may the trip's host: the trip's storage counts against the host,
// and a member's upload can't be left holding the host's space.
async function deleteObject(ctx) {
  const { user: u, trip, host } = ctx.data;

  const key = new URL(ctx.request.url).searchParams.get("key") || "";
  if (!validKey(key)) return err(400, "bad key", { key });

  const row = await ctx.env.DB.prepare(
    "SELECT r2_key, user_id, bytes, state, upload_id FROM media_objects WHERE r2_key = ?1 AND trip_id = ?2"
  ).bind(key, trip.id).first();
  if (!row) return json({ ok: true, deleted: false, freed_bytes: 0, rev: trip.rev });
  if (row.user_id !== u.id && !host) return err(403, "forbidden", { reason: "Only the person who uploaded this file, or the trip's host, can delete it." });
  if (trip.tiles === key) return err(409, "the trip's map", { key, reason: "This file is the trip's map. Make the map from the trip's areas again (or upload another) first; then this one goes by itself." });

  const attached = await ctx.env.DB.prepare(
    "SELECT 1 AS ok FROM memory_media WHERE r2_key = ?1 OR thumb_key = ?1"
  ).bind(key).first();
  if (attached) return err(409, "attached to a memory", { key, hint: "DELETE memories/:id", reason: "This file is in a memory: delete the memory to delete it." });

  const ts = nowSec();
  const freed = Number(row.bytes) || 0;
  const done = await ctx.env.DB.batch([
    bump(ctx.env, trip.id),
    queueFiles(ctx.env, "SELECT r2_key, CASE WHEN state = 'pending' THEN NULLIF(upload_id, '') END AS upload_id FROM media_objects WHERE r2_key = ?1", [key], ts),
    ctx.env.DB.prepare("DELETE FROM media_objects WHERE r2_key = ?1 AND trip_id = ?2").bind(key, trip.id),
  ]);
  await moved(ctx.env, trip.id, done[0].results[0]?.rev ?? null);
  return json({ ok: true, deleted: true, freed_bytes: freed, rev: done[0].results[0]?.rev ?? null });
}

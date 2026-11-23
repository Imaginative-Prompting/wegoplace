// GET|HEAD /media/<key>  ->  bytes out of the MEDIA R2 bucket, byte-exact, with real Range.
//
// This is the read half of the fidelity guarantee. What went into the bucket comes out of
// it: no transform, no re-encode, no content negotiation, no "we serve webp to browsers that
// take webp". A HEIC a phone uploaded is a HEIC on the way down, and the sha256
// of the response body equals the sha256 of the file that was picked. That property is the whole
// reason the tab exists, and it is exactly one line of code — hand R2's stream to the
// Response — so the only way to lose it is to add something.
//
// ── WHY RANGE IS NOT OPTIONAL ───────────────────────────────────────────────────────────
// iOS Safari will not scrub a video without 206s. It probes with `Range: bytes=0-1`, and a
// server that answers 200 with the whole body gets a player that either refuses to seek or
// re-downloads a 400MB file every time somebody drags the scrubber. Same arithmetic as
// functions/tiles/[[path]].js, which is proven against MapLibre's pmtiles reader; the
// difference here is that a media player emits open-ended ranges (`bytes=1048576-`) as its
// NORMAL mode, where pmtiles never did, so that path is the hot one rather than the corner.
//
// ── WHY `immutable` IS HONEST HERE ──────────────────────────────────────────────────────
// Keys are minted in functions/api/media.js with a random tail and are never written twice.
// There is no update path for an object — a memory is deleted, not edited — so a cached copy
// can never be stale, and the service worker can keep originals forever with cache-first and
// no revalidation. `private` because the bucket sits behind the session cookie.
//
// ── AUTHORISATION ───────────────────────────────────────────────────────────────────────
// 401 comes free: the gate refuses every path that is not in its PUBLIC list, and /media is
// not. This file's job is the trip: the key's row says which trip the file belongs to, and
// the caller has to be on it. Not on it, and a key with no row in media_objects (even if the
// object exists in the bucket), are the same 404, so neither the bucket nor another trip's
// files can be found by guessing.

import { validKey } from "./api/media.js";
import { tripFor } from "./trips/access.js";

const plain = (status, msg, extra) => new Response(msg, {
  status, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", ...(extra || {}) },
});

// 416 must carry the real size or the client has nothing to retry against.
const unsatisfiable = (size) => new Response(null, {
  status: 416, headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
});

// A single range only. RFC 9110 lets a server ignore a Range it will not honour; no media
// element asks for a multipart one, so `bytes=0-1,5-6` falls through to a plain 200 rather
// than growing a multipart/byteranges encoder nothing would exercise.
function parseRange(header) {
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/.exec(header || "");
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") return { suffix: Number(b) };                 // "the last N bytes"
  return { start: Number(a), end: b === "" ? null : Number(b) };
}

// RFC 6266: the ASCII fallback is quoted with quotes and backslashes escaped, and the real
// name rides filename* as percent-encoded UTF-8. `inline` because the viewer plays and
// displays these; the save path fetches the blob and names the File itself.
function disposition(name) {
  const safe = String(name || "").replace(/[\r\n]/g, "").slice(0, 255);
  if (!safe) return "inline";
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "\\$&");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function baseHeaders(obj, row) {
  const h = new Headers();
  // Content-Type comes from the REGISTRY, not from the key's extension and not from R2's
  // own metadata: the registry is what the upload recorded from the browser, it is the only
  // copy that survives a key whose extension is missing, and serving a .mov as
  // application/octet-stream is the difference between a video that plays and a download.
  h.set("Content-Type", row.mime || obj.httpMetadata?.contentType || "application/octet-stream");
  // Advertised on every response, not just 206s. A client that does not see Accept-Ranges on
  // the first reply is entitled to stop asking for ranges and pull the whole file.
  h.set("Accept-Ranges", "bytes");
  h.set("Cache-Control", "private, max-age=31536000, immutable");
  h.set("Content-Disposition", disposition(row.orig_name));
  h.set("X-Content-Type-Options", "nosniff");
  if (obj.httpEtag) h.set("ETag", obj.httpEtag);
  if (obj.uploaded) h.set("Last-Modified", new Date(obj.uploaded).toUTCString());
  return h;
}

export async function onRequest(ctx) {
  const { request, env, params } = ctx;
  if (request.method !== "GET" && request.method !== "HEAD")
    return plain(405, "method not allowed", { Allow: "GET, HEAD" });
  if (!env.MEDIA) return plain(503, "MEDIA bucket not bound");

  // Segments arrive already decoded by Pages; decoding again would corrupt any key holding
  // a literal %. Keys are minted from [0-9a-f] and one extension, so nothing legitimate
  // needs escaping in the first place.
  const segs = [].concat(params.path || []);
  if (!segs.length || segs.some((s) => !s || s === "." || s === ".."))
    return plain(404, "not found");
  const key = segs.join("/");
  if (!validKey(key)) return plain(404, "not found");

  // The registry read is the authorisation AND the content type. An object in the bucket
  // with no row here does not exist as far as this route is concerned.
  //
  // The address has no trip in it (a key is one file, wherever it is shown), so the trip
  // comes from the row, and the caller has to be on that trip now. Someone who left, or was
  // never on it, gets the same 404 as a key that was never minted.
  const row = await env.DB.prepare(
    "SELECT r2_key, mime, orig_name, bytes, state, trip_id FROM media_objects WHERE r2_key = ?1"
  ).bind(key).first();
  if (!row || row.state !== "stored") return plain(404, "not found");
  if (!ctx.data.user || !(await tripFor(env, row.trip_id, ctx.data.user.id))) return plain(404, "not found");

  if (request.method === "HEAD") {
    const head = await env.MEDIA.head(key);
    if (!head) return plain(404, "not found");
    const h = baseHeaders(head, row);
    h.set("Content-Length", String(head.size));
    return new Response(null, { status: 200, headers: h });
  }

  return rangedGet(env.MEDIA, key, request, (obj) => baseHeaders(obj, row), () => plain(404, "not found"));
}

/**
 * A GET of one object out of an R2 bucket, Range and all: 200 with the whole file when no single range is asked
 * for (and 304/412 for a precondition), 206 for a bounded, open-ended or suffix range, 416 with the real size for
 * one past the end. `headersFor(obj)` gives every answer's headers (Accept-Ranges among them); `missing()` is the
 * route's own answer for an object that isn't there. /s/'s files (src/share-page.js) are served by it too.
 */
export async function rangedGet(bucket, key, request, headersFor, missing) {
  const spec = parseRange(request.headers.get("Range"));

  if (!spec) {
    // No Range: hand R2 the request headers so it evaluates If-None-Match/If-Modified-Since
    // itself — quotes, weak validators and all. A failed precondition comes back as an
    // R2Object with no body.
    const obj = await bucket.get(key, { onlyIf: request.headers });
    if (!obj) return missing();
    const h = headersFor(obj);
    if (!obj.body) {
      const conditional = request.headers.has("If-None-Match") || request.headers.has("If-Modified-Since");
      return new Response(null, { status: conditional ? 304 : 412, headers: h });
    }
    h.set("Content-Length", String(obj.size));
    return new Response(obj.body, { status: 200, headers: h });
  }

  // A fully-bounded range resolves without knowing the object size, so one R2 op serves it.
  // Open-ended and suffix ranges cannot: turning "the last 16 KiB" into an offset needs the
  // size first, and a guessed Content-Range that disagrees with the bytes is what makes a
  // video element report a corrupt stream rather than a bad response.
  let start, endWanted, size = null;
  if (spec.suffix != null || spec.end == null) {
    const head = await bucket.head(key);
    if (!head) return missing();
    size = head.size;
    if (spec.suffix != null) {
      if (spec.suffix === 0) return unsatisfiable(size);
      start = Math.max(0, size - spec.suffix);
    } else {
      start = spec.start;
    }
    endWanted = size - 1;
    if (start >= size) return unsatisfiable(size);
  } else {
    start = spec.start;
    endWanted = spec.end;
    if (endWanted < start) return plain(400, "bad range");
  }

  let obj;
  try {
    obj = await bucket.get(key, { range: { offset: start, length: endWanted - start + 1 } });
  } catch { obj = null; }
  // An offset past the end of the object is a 416, not a 404, and R2 signals it either by
  // throwing or by returning nothing depending on the offset. Both land here, and both need
  // the real size before the client can retry.
  if (!obj) {
    const head = await bucket.head(key);
    return head ? unsatisfiable(head.size) : missing();
  }
  if (start >= obj.size) return unsatisfiable(obj.size);

  // R2 clamps a length that runs past the end of the object, so the end actually being sent
  // is recomputed from the object size: Content-Range and Content-Length have to describe
  // the bytes on the wire, not the bytes that were asked for.
  const end = Math.min(endWanted, obj.size - 1);
  const h = headersFor(obj);
  h.set("Content-Range", `bytes ${start}-${end}/${obj.size}`);
  h.set("Content-Length", String(end - start + 1));
  return new Response(obj.body, { status: 206, headers: h });
}

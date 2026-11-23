// Bytes out of the TILES R2 bucket, with real HTTP Range support.
//
// MapLibre's pmtiles protocol does not fetch tiles. It fetches byte ranges out of one large
// .pmtiles archive — a header read, then directory reads, then a range per tile — and it
// trusts the response. A route that ignores Range and answers 200 with the whole body looks
// like it works, because the pmtiles reader slices the buffer it was given and finds the
// right bytes; it just does that after pulling a multi-hundred-megabyte archive into a
// phone's memory, once per request, until the tab dies. So: 206, Content-Range,
// Accept-Ranges, and the slicing done in R2 rather than in the Worker.
//
// ../reader's _middleware.js withRange is the reference for the header arithmetic, but not
// for the mechanism: it does res.arrayBuffer() and slices, which buffers the entire object
// in the Worker. R2 takes an offset/length natively and hands back a stream, so nothing here
// ever holds more than the requested range.
//
// Two addresses. /api/trips/<trip>/tiles serves the one archive the trip's `tiles` names, to
// the people on that trip (tripTiles). /tiles/fonts/<font>/<range>.pbf serves the label fonts the
// map draws its words with (fonts): the same for every trip, so not a trip's address, and only to
// someone on a trip. The old /tiles/<key>, an archive by its name from before archives belonged
// to trips, went once the app's map stopped asking it (14 Nov; check:routes holds it gone).
// The service worker's fetches are same-origin and carry the cookie, so the offline precache works.

const TYPES = {
  pmtiles: "application/octet-stream",
  json: "application/json",
  pbf: "application/x-protobuf",   // MapLibre glyph ranges and sprite vectors
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  woff2: "font/woff2",
};

const plain = (status, msg, extra) => new Response(msg, {
  status, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", ...(extra || {}) },
});

// 416 must carry the real size or the client has nothing to retry against.
const unsatisfiable = (size) => new Response(null, {
  status: 416, headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
});

// A single range only. RFC 9110 lets a server ignore a Range it will not honour, and the
// pmtiles protocol never asks for a multipart one, so `bytes=0-1,5-6` falls through to a
// plain 200 instead of growing a multipart/byteranges encoder that nothing would exercise.
function parseRange(header) {
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/.exec(header || "");
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") return { suffix: Number(b) };                 // "the last N bytes"
  return { start: Number(a), end: b === "" ? null : Number(b) };
}

function baseHeaders(obj, key) {
  const h = new Headers();
  // Content-Type is derived from the key, not from R2 metadata: `wrangler r2 object put`
  // stores no content type unless told to, and an archive served as application/octet-stream
  // by accident is fine while one served as text/plain is not.
  h.set("Content-Type", TYPES[key.split(".").pop().toLowerCase()] || "application/octet-stream");
  // Advertised on every response, not just on 206s. A client that does not see
  // Accept-Ranges on the first reply is entitled to give up on ranges and ask for the lot.
  h.set("Accept-Ranges", "bytes");
  if (obj.httpEtag) h.set("ETag", obj.httpEtag);
  if (obj.uploaded) h.set("Last-Modified", new Date(obj.uploaded).toUTCString());
  // `private` because this bucket sits behind the session cookie. Short, because the service
  // worker owns the offline copy — HTTP caching here only saves repeat ranges within a
  // session, and a long max-age would just make a corrected extract invisible for a week.
  h.set("Cache-Control", "private, max-age=3600");
  return h;
}

/**
 * An address under /tiles/ that no row answers (the old /tiles/<key> among them): a plain 404,
 * never the app's page. src/index.js hands it here, behind the gate.
 */
export const noTile = () => plain(404, "not found");

/** GET|HEAD /tiles/fonts/<font>/<range>.pbf: a label font's glyph range, stored at fonts/… */
export async function fonts(ctx) {
  const { request, env, params } = ctx;
  if (request.method !== "GET" && request.method !== "HEAD")
    return plain(405, "method not allowed", { Allow: "GET, HEAD" });
  if (!env.TILES) return plain(503, "TILES bucket not bound");
  if (!ctx.data.user?.onTrip) {
    return new Response(JSON.stringify({ error: "no trip" }), {
      status: 403, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // Each segment decoded once: the Worker's router hands them as the address has them, and the
  // map asks for its fonts by name ("Noto%20Sans%20Regular"), stored as "Noto Sans Regular". (Pages
  // decoded them itself; on the Worker, undecoded, every label font answered 404.) No key has a
  // literal %, so one decode is right; a segment that won't decode is no key.
  let segs;
  try { segs = [].concat(params.path || []).map((s) => decodeURIComponent(s)); } catch { return plain(404, "not found"); }
  if (!segs.length || segs.some((s) => !s || s === "." || s === ".." || s.includes("/")))
    return plain(404, "not found");
  return serveArchive(ctx, `fonts/${segs.join("/")}`);
}

/**
 * GET|HEAD /api/trips/<trip>/tiles: the trip's own offline map, the archive its `tiles` names
 * (members only: the route table checks). A trip without one answers 404 "no map"; the app
 * then draws its own ground with the places on it.
 */
export async function tripTiles(ctx) {
  const { request, env, data } = ctx;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method not allowed", allow: ["GET", "HEAD"] }), {
      status: 405, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Allow: "GET, HEAD" },
    });
  }
  if (!env.TILES) return plain(503, "TILES bucket not bound");
  if (!data.trip.tiles) {
    return new Response(JSON.stringify({ error: "no map", reason: "This trip has no offline map yet." }), {
      status: 404, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  // A map someone uploaded is a file (MEDIA); one the server cut, or named by hand, is in TILES.
  return serveArchive(ctx, data.trip.tiles, data.trip.tiles_source === "upload" ? env.MEDIA : env.TILES);
}

/** One object of the TILES bucket, whole or by Range. */
async function serveArchive(ctx, key, bucket = ctx.env.TILES) {
  const { request, env } = ctx;

  if (request.method === "HEAD") {
    const head = await bucket.head(key);
    if (!head) return plain(404, "not found");
    const h = baseHeaders(head, key);
    h.set("Content-Length", String(head.size));
    return new Response(null, { status: 200, headers: h });
  }

  const spec = parseRange(request.headers.get("Range"));

  if (!spec) {
    // No Range: hand R2 the request headers so it evaluates If-None-Match itself, quotes,
    // weak validators and all. A failed precondition comes back as an R2Object with no body.
    const obj = await bucket.get(key, { onlyIf: request.headers });
    if (!obj) return plain(404, "not found");
    const h = baseHeaders(obj, key);
    if (!obj.body)
      return new Response(null, { status: request.headers.has("If-None-Match") ? 304 : 412, headers: h });
    h.set("Content-Length", String(obj.size));
    return new Response(obj.body, { status: 200, headers: h });
  }

  // A fully-bounded range — the only form the pmtiles protocol emits — resolves without
  // knowing the object size, so one R2 op serves it. Open-ended and suffix ranges cannot:
  // turning "the last 16 KiB" into an offset requires the size first, and a guess ships a
  // Content-Range that disagrees with the bytes, which the pmtiles reader reports as a
  // corrupt archive rather than as a bad response.
  let start, endWanted;
  if (spec.suffix != null || spec.end == null) {
    const head = await bucket.head(key);
    if (!head) return plain(404, "not found");
    if (spec.suffix != null) {
      if (spec.suffix === 0) return unsatisfiable(head.size);
      start = Math.max(0, head.size - spec.suffix);
    } else {
      start = spec.start;
    }
    endWanted = head.size - 1;
    if (start >= head.size) return unsatisfiable(head.size);
  } else {
    start = spec.start;
    endWanted = spec.end;
    if (endWanted < start) return plain(400, "bad range");
  }

  let obj;
  try {
    obj = await bucket.get(key, { range: { offset: start, length: endWanted - start + 1 } });
  } catch {
    obj = null;
  }
  // An offset past the end of the object is a 416, not a 404, and R2 signals it either by
  // throwing or by handing back nothing depending on the offset. Both land here, and both
  // need the real size before the client can retry — one extra head, on a path the pmtiles
  // protocol never takes.
  if (!obj) {
    const head = await bucket.head(key);
    return head ? unsatisfiable(head.size) : plain(404, "not found");
  }
  if (start >= obj.size) return unsatisfiable(obj.size);

  // R2 clamps a length that runs past the end of the object, so the end actually being sent
  // is recomputed from the object size. Content-Range and Content-Length have to describe
  // the bytes on the wire, not the bytes that were asked for.
  const end = Math.min(endWanted, obj.size - 1);
  const h = baseHeaders(obj, key);
  h.set("Content-Range", `bytes ${start}-${end}/${obj.size}`);
  h.set("Content-Length", String(end - start + 1));
  return new Response(obj.body, { status: 206, headers: h });
}

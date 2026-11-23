// A picture a person draws in place of their initials: the bytes it is stored as, the hash that names it, and the walk
// that proves a stranger's bytes are one. Imported by the Worker (src/accounts/avatar.js) and by the app alike, so a
// blob the app offers is exactly a blob the server takes, and the name the server gives it is the one the app would
// have given. It imports nothing, touches no DOM, and runs in workerd and a browser the same.
//
// THE SHAPE, as the app's pad and faces hold it (public/ds/drawing.js):
//   { palette, strokes: [{ ink, brush, pts: [[x, y], …] }, …] }
//     palette  the palette's place in the app's list (eight today, PALETTE_COUNT; the list only grows at its end, so a
//              stored place never means another palette). A picture always sits on its palette's ground.
//     ink      0 or 1: which of the palette's two inks.
//     brush    the stroke's width in thousandths of the picture's width, 1 to 254 (the pad's three are 22, 52 and
//              110); BRUSH_FILL (255) is a dot broad enough to cover the whole circle, so "fill" is an ordinary stroke
//              Undo takes back and the format needs nothing else for it.
//     pts      integer points on a GRID x GRID square with the picture's circle inscribed in it; one point is a dot.
//
// THE BYTES, big-endian:
//   offset  size  field
//   0..2    3     magic 0x57 0x47 0x44 ("WGD")
//   3       1     version, 1
//   4       1     palette
//   5..     -     strokes, back to back, to the end:
//                   +0  1   brush (1..255)
//                   +1  1   ink (0 or 1)
//                   +2  2   point count, at least 1
//                   +4  2n  n x [x, y], one byte each
// Two bytes a point, absolute, never deltas: 255 steps across the circle is finer than a finger after smoothing, and a
// flat record needs no varint reader. A uint16 count, so a long stroke never has to be split. No stroke count: a
// stroke says its own length, so there is no count to disagree with the content. No color value, no timestamp, no
// name: the palette's index is all the color there is, and nothing that is not the drawing is in it.
//
// THE ONE PROPERTY THAT MATTERS MOST: someone who never draws changes nothing anywhere. The server carries a person's
// drawing as a hash on their row only when there is one (an absent key, never a null), and a face with no drawing
// draws the initials it always drew.

export const GRID = 255;
/** Palettes the app's list holds (public/ds/palettes.js). An index at or past it is refused: the app couldn't draw it. */
export const PALETTE_COUNT = 8;
export const INKS = 2;
/** The brush byte that is Fill: a dot that covers the circle. Below it, thousandths of the picture's width. */
export const BRUSH_FILL = 255;

/* A backstop against a hostile payload, not a limit on drawing: 16 KiB is about 8,000 points, which nobody reaches with
   a finger. The base64url length is checked before decoding, so ten megabytes are refused without being decoded. */
export const DRAWING_BYTES_MAX = 16384;
export const DRAWING_B64_MAX = Math.ceil(DRAWING_BYTES_MAX / 3) * 4;

const MAGIC = [0x57, 0x47, 0x44];
const VERSION = 1;
const HEAD = 5;
const STROKE_HEAD = 4;

const byte = (v) => {
  const n = Math.round(Number(v));
  return n >= 0 ? (n <= 255 ? n : 255) : 0;
};

/** Whether a stroke as the pad holds it is one this format can carry. */
const strokeOk = (s) => s && (s.ink === 0 || s.ink === 1) && Number.isInteger(s.brush) && s.brush >= 1 && s.brush <= BRUSH_FILL
  && Array.isArray(s.pts) && s.pts.length > 0 && s.pts.length <= 0xffff;

/**
 * The bytes of a drawing, or null when it isn't one (a palette past the list, no strokes, a stroke with a bad ink or
 * brush). Points are clamped to the grid here as well as at capture: this is the last thing between a stray float and a
 * byte that would wrap to the other side of the circle.
 */
export function encode(drawing) {
  const d = drawing;
  if (!d || !Number.isInteger(d.palette) || d.palette < 0 || d.palette >= PALETTE_COUNT || !Array.isArray(d.strokes)) return null;
  const strokes = d.strokes.filter((s) => s && Array.isArray(s.pts) && s.pts.length);
  if (!strokes.length || !strokes.every(strokeOk)) return null;
  let n = HEAD;
  for (const s of strokes) n += STROKE_HEAD + s.pts.length * 2;
  const out = new Uint8Array(n);
  out[0] = MAGIC[0]; out[1] = MAGIC[1]; out[2] = MAGIC[2]; out[3] = VERSION; out[4] = d.palette;
  let i = HEAD;
  for (const s of strokes) {
    out[i++] = s.brush;
    out[i++] = s.ink;
    out[i++] = (s.pts.length >> 8) & 0xff;
    out[i++] = s.pts.length & 0xff;
    for (const p of s.pts) { out[i++] = byte(p[0]); out[i++] = byte(p[1]); }
  }
  return out;
}

/**
 * The walk that says whether bytes are a drawing, allocating nothing: what the server asks of a stranger's bytes before
 * it stores them. Strict: bad magic, an unknown version, a palette past the list, a brush of 0, an ink past 1, a stroke
 * of no points, a stroke claiming more points than there are bytes, a byte left over at the end, or nothing at all past
 * the head are each a no. A half-understood drawing would be a stranger's picture drawn wrong on everyone's screen; the
 * initials are a perfectly good answer that already exists.
 */
export function validate(bytes) {
  if (!bytes || typeof bytes.length !== "number") return false;
  if (bytes.length < HEAD + STROKE_HEAD + 2 || bytes.length > DRAWING_BYTES_MAX) return false;
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2] || bytes[3] !== VERSION) return false;
  if (bytes[4] >= PALETTE_COUNT) return false;
  let i = HEAD;
  while (i < bytes.length) {
    if (i + STROKE_HEAD > bytes.length) return false;
    const brush = bytes[i], ink = bytes[i + 1], n = (bytes[i + 2] << 8) | bytes[i + 3];
    if (brush < 1 || ink >= INKS || n === 0) return false;
    i += STROKE_HEAD + n * 2;
    if (i > bytes.length) return false;
  }
  return true;
}

/** The drawing the bytes hold, or null. Never throws: it runs while a screen is drawn, and null means initials. */
export function decode(bytes) {
  try {
    if (!validate(bytes)) return null;
    const strokes = [];
    let i = HEAD;
    while (i < bytes.length) {
      const brush = bytes[i], ink = bytes[i + 1], n = (bytes[i + 2] << 8) | bytes[i + 3];
      i += STROKE_HEAD;
      const pts = new Array(n);
      for (let k = 0; k < n; k++) { pts[k] = [bytes[i], bytes[i + 1]]; i += 2; }
      strokes.push({ ink, brush, pts });
    }
    return { palette: bytes[4], strokes };
  } catch {
    return null;
  }
}

/* ── when a drawing outgrows the ceiling ─────────────────────────────────────────────────────────────────────────────
   Ramer–Douglas–Peucker per stroke, iterative so a pathological stroke can't overflow the stack. `eps` is in grid
   units; the ladder's rungs are a fraction of a pixel at the sizes a picture is ever shown at. The drawing is never
   refused for its size: it is simplified a rung at a time, the WHOLE drawing at each rung (one fidelity, not two), and
   past the last rung its oldest strokes go first, so the newest mark always lands. The pad redraws from what comes
   back, because that is the one moment the points stored are not the points drawn. */
const LADDER = [0, 2, 3, 4, 6, 9, 13, 20];

function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const e2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1, best = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] - ax, py = pts[i][1] - ay;
      let d2;
      // Distance to the segment, not the line: a stroke that comes back on itself has its ends together, and the
      // line's distance would divide by nothing and keep no point at all.
      if (len2 === 0) d2 = px * px + py * py;
      else {
        let t = (px * dx + py * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = px - t * dx, qy = py - t * dy;
        d2 = qx * qx + qy * qy;
      }
      if (d2 > far) { far = d2; best = i; }
    }
    if (far > e2 && best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

const simplified = (d, eps) => ({ palette: d.palette, strokes: d.strokes.map((s) => ({ ink: s.ink, brush: s.brush, pts: eps > 0 ? rdp(s.pts, eps) : s.pts.slice() })) });

/** The drawing fitted under the ceiling: { bytes, drawing, eps }, or null when it isn't a drawing at all. */
export function fit(drawing) {
  if (!encode(drawing)) return null;
  const src = { palette: drawing.palette, strokes: drawing.strokes.filter((s) => s && Array.isArray(s.pts) && s.pts.length) };
  for (const eps of LADDER) {
    const d = simplified(src, eps);
    const bytes = encode(d);
    if (bytes.length <= DRAWING_BYTES_MAX) return { bytes, drawing: d, eps };
  }
  const eps = LADDER[LADDER.length - 1];
  let d = simplified(src, eps);
  while (d.strokes.length > 1) {
    d = { palette: d.palette, strokes: d.strokes.slice(1) };
    const bytes = encode(d);
    if (bytes.length <= DRAWING_BYTES_MAX) return { bytes, drawing: d, eps };
  }
  // One stroke that alone won't fit: its newest points, as many as fit.
  const max = (DRAWING_BYTES_MAX - HEAD - STROKE_HEAD) >> 1;
  const s = d.strokes[0];
  d = { palette: d.palette, strokes: [{ ink: s.ink, brush: s.brush, pts: s.pts.slice(Math.max(0, s.pts.length - max)) }] };
  return { bytes: encode(d), drawing: d, eps };
}

/* ── the name ────────────────────────────────────────────────────────────────────────────────────────────────────────
   SHA-256 of the bytes, its first 9 bytes, base64url: 12 characters. Enough because of who computes it: the app never
   sends a name, it sends bytes, and the server names them itself, so nobody can make their bytes take another's name.
   crypto.subtle is the same in workerd and a browser (it needs a secure context: https or localhost). */
export async function hashOf(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return toB64url(new Uint8Array(d, 0, 9));
}

/** A drawing's name off the wire, or null: a whitelist, since it goes into an address and an attribute. */
export const isDrawingHash = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{12}$/.test(v) ? v : null);

/* ── base64url ──────────────────────────────────────────────────────────────────────────────────────────────────────
   In chunks of a multiple of three bytes, so the pieces' base64 joins into the whole's (btoa pads each piece). */
const B64_CHUNK = 8190;

export function toB64url(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) out += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK)));
  return out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes of a base64url string, or null for anything else (or anything longer than a drawing can be). */
export function fromB64url(s) {
  try {
    if (typeof s !== "string" || s.length > DRAWING_B64_MAX || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

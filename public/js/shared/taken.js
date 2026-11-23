// When a photograph was taken, where the file says so: the EXIF original time (DateTimeOriginal,
// with OffsetTimeOriginal when the camera wrote one), read from the picked file's own bytes before
// the picture is made smaller (making it smaller drops the EXIF block, which is the point there).
//
// A memory's day (docs/CONTRACTS.md) is the earliest of its photographs' times. Nothing else is a
// "time the file says": a file's lastModified is when it was saved or picked on many phones, and a
// guess would put a memory on a wrong day without a word, so with no EXIF time the answer is null
// and the memory is on the day it is posted.
//
// Read: JPEG (the APP1 "Exif" segment), PNG (the eXIf chunk), and HEIC / HEIF / AVIF (the "Exif"
// item an ISO media file's meta box points at). Only the first 256 KB is read: every one of them
// keeps its EXIF near the start.
//
//   takenAt(file, zone) -> Promise<number | null>   unix seconds
//   exifTime(bytes)     -> { local: "YYYY-MM-DDTHH:MM:SS", offset: "+09:00" | null } | null
//   localToUnix(local, offset, zone) -> number | null
//
// Pure apart from takenAt reading the file; no network, no DOM.

const HEAD = 256 * 1024;

/** The unix seconds a picked file says it was taken, read in `zone` when the file names no offset. */
export async function takenAt(file, zone) {
  if (!file || typeof file.slice !== "function") return null;
  let bytes;
  try { bytes = new Uint8Array(await file.slice(0, HEAD).arrayBuffer()); } catch { return null; }
  const t = exifTime(bytes);
  return t ? localToUnix(t.local, t.offset, zone) : null;
}

/** The earliest of several files' times, or null when none says. */
export async function earliestTaken(files, zone) {
  let best = null;
  for (const f of files || []) {
    const t = await takenAt(f, zone);
    if (t != null && (best == null || t < best)) best = t;
  }
  return best;
}

/** The EXIF original time in a file's first bytes, or null. */
export function exifTime(bytes) {
  const tiff = tiffIn(bytes);
  return tiff ? readTiff(bytes, tiff) : null;
}

// ── where the TIFF block is ────────────────────────────────────────────────────────────────
function tiffIn(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return inJpeg(b);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return inPng(b);
  if (ascii(b, 4, 4) === "ftyp") return inBmff(b);
  return null;
}

function inJpeg(b) {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xd9 || marker === 0xda) return null;            // end, or the picture itself: no EXIF before it
    if (marker === 0xff) { i += 1; continue; }                       // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    if (marker === 0xe1 && ascii(b, i + 4, 6) === "Exif\0\0") return { start: i + 10, end: Math.min(b.length, i + 2 + len) };
    i += 2 + len;
  }
  return null;
}

function inPng(b) {
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    if (type === "eXIf") return { start: i + 8, end: Math.min(b.length, i + 8 + len) };
    if (type === "IDAT" || type === "IEND") return null;
    i += 12 + len;
  }
  return null;
}

// ISO base media (HEIC, HEIF, AVIF): meta → iinf (the item whose type is "Exif") and iloc (where
// its bytes are). The item starts with a 4-byte offset to the TIFF header (usually "Exif\0\0").
function inBmff(b) {
  const top = boxes(b, 0, b.length);
  const meta = top.find((x) => x.type === "meta");
  if (!meta) return null;
  const inner = boxes(b, meta.body + 4, meta.end);                    // meta is a full box: version and flags first
  const iinf = inner.find((x) => x.type === "iinf");
  const iloc = inner.find((x) => x.type === "iloc");
  if (!iinf || !iloc) return null;
  const id = exifItemId(b, iinf);
  if (id == null) return null;
  const at = itemExtent(b, iloc, id);
  if (!at || at.offset + 4 > b.length) return null;
  const skip = u32be(b, at.offset);
  const start = at.offset + 4 + skip;
  return start < b.length ? { start, end: Math.min(b.length, at.offset + at.length) } : null;
}

function boxes(b, from, to) {
  const out = [];
  let i = from;
  while (i + 8 <= to) {
    let size = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    let body = i + 8;
    if (size === 1) { if (i + 16 > to) break; size = u32be(b, i + 8) * 2 ** 32 + u32be(b, i + 12); body = i + 16; }
    else if (size === 0) size = to - i;
    if (size < 8) break;
    out.push({ type, start: i, body, end: Math.min(to, i + size) });
    i += size;
  }
  return out;
}

function exifItemId(b, iinf) {
  const version = b[iinf.body];
  let i = iinf.body + 4;
  const count = version === 0 ? u16be(b, i) : u32be(b, i);
  i += version === 0 ? 2 : 4;
  for (const e of boxes(b, i, iinf.end).slice(0, count)) {
    if (e.type !== "infe") continue;
    const v = b[e.body];
    if (v < 2) continue;
    let j = e.body + 4;
    const id = v === 2 ? u16be(b, j) : u32be(b, j);
    j += v === 2 ? 2 : 4;
    j += 2;                                                         // protection index
    if (ascii(b, j, 4) === "Exif") return id;
  }
  return null;
}

function itemExtent(b, iloc, want) {
  const version = b[iloc.body];
  let i = iloc.body + 4;
  const sizes = u16be(b, i); i += 2;
  const offSize = sizes >> 12, lenSize = (sizes >> 8) & 15, baseSize = (sizes >> 4) & 15, idxSize = version >= 1 ? sizes & 15 : 0;
  const count = version < 2 ? u16be(b, i) : u32be(b, i);
  i += version < 2 ? 2 : 4;
  const num = (n) => { const v = n === 0 ? 0 : n === 4 ? u32be(b, i) : n === 8 ? u32be(b, i) * 2 ** 32 + u32be(b, i + 4) : n === 2 ? u16be(b, i) : NaN; i += n; return v; };
  for (let k = 0; k < count && i < iloc.end; k++) {
    const id = version < 2 ? u16be(b, i) : u32be(b, i);
    i += version < 2 ? 2 : 4;
    let method = 0;
    if (version >= 1) { method = u16be(b, i) & 15; i += 2; }
    i += 2;                                                         // data reference index
    const base = num(baseSize);
    const extents = u16be(b, i); i += 2;
    let first = null;
    for (let e = 0; e < extents; e++) {
      if (idxSize) num(idxSize);
      const off = num(offSize), len = num(lenSize);
      if (first == null) first = { offset: base + off, length: len };
    }
    if (id === want) return method === 0 && first && Number.isFinite(first.offset) ? first : null;
  }
  return null;
}

// ── the TIFF block: IFD0 → the EXIF IFD → DateTimeOriginal ─────────────────────────────────
function readTiff(b, { start, end }) {
  if (start + 8 > end) return null;
  const order = ascii(b, start, 2);
  const le = order === "II";
  if (!le && order !== "MM") return null;
  const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 2 ** 24 : b[o] * 2 ** 24 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
  if (u16(start + 2) !== 42) return null;
  const entries = (ifd) => {
    const at = start + ifd;
    if (ifd < 8 || at + 2 > end) return [];
    const n = u16(at);
    const out = [];
    for (let k = 0; k < n; k++) {
      const e = at + 2 + k * 12;
      if (e + 12 > end) break;
      out.push({ tag: u16(e), type: u16(e + 2), count: u32(e + 4), value: e + 8 });
    }
    return out;
  };
  const text = (e) => {
    if (!e || e.type !== 2 || !e.count) return null;
    const at = e.count <= 4 ? e.value : start + u32(e.value);
    if (at + e.count > end) return null;
    return ascii(b, at, e.count).replace(/\0+$/, "").trim();
  };
  const ifd0 = entries(u32(start + 4));
  const exifPtr = ifd0.find((e) => e.tag === 0x8769);
  const exif = exifPtr ? entries(u32(exifPtr.value)) : [];
  const original = text(exif.find((e) => e.tag === 0x9003)) || text(exif.find((e) => e.tag === 0x9004));
  const m = original && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(original);
  if (!m || m[1] === "0000") return null;
  const offset = text(exif.find((e) => e.tag === 0x9011)) || text(exif.find((e) => e.tag === 0x9012));
  return { local: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`, offset: offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : null };
}

// ── a wall-clock time to a moment ──────────────────────────────────────────────────────────
/** "2027-06-03T14:22:10" with "+09:00" (or, with none, read in `zone`) to unix seconds; null when it can't be a time. */
export function localToUnix(local, offset, zone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(String(local || ""));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(wall);
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1) return null;   // 31 June is no day
  if (offset) {
    const o = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
    return Math.round((wall - (o[1] === "-" ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3])) * 60000) / 1000);
  }
  // In the trip's zone: the offset that zone had at that wall time (two tries settle a change of
  // the clocks; in the hour that doesn't exist the later reading is taken).
  let guess = wall;
  for (let k = 0; k < 2; k++) guess = wall - offsetMs(guess, zone);
  return Math.round(guess / 1000);
}

function offsetMs(ms, zone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: zone || "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  } catch { return 0; }
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(ms / 1000) * 1000;
}

const ascii = (b, at, n) => { let s = ""; for (let k = 0; k < n && at + k < b.length; k++) s += String.fromCharCode(b[at + k]); return s; };
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => b[i] * 2 ** 24 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

// A file for a public page, with what a camera writes into it taken out: where and when it was taken, the device, any
// comment or editing history. A shared board's photographs and videos are the trip's originals (public/js/memories.js
// copies each beside the board), and a board's link is open to anyone, so what /s/<id>/ serves must carry none of it.
// Pure, on the file's bytes, in the Worker and in Node.
//
//   stripMetadata(bytes) -> { bytes, format }   or { refused: reason }
//   sizeOf(bytes)        -> { width, height }   as the picture is shown (a JPEG or a video turned on its side, the
//                           other way round), read from the file's own header; or null when it can't be read
//
// What it keeps: the picture and the sound, and what they need to show right.
//   JPEG  every APPn segment but JFIF (APP0), the colour profile (APP2) and Adobe's (APP14) goes, and every comment;
//         a photo turned by its Exif orientation keeps that one value, in a new Exif of its own, so it isn't shown on
//         its side.
//   PNG   the text chunks (tEXt, zTXt, iTXt), eXIf and tIME go.
//   WebP  the EXIF and XMP chunks go, and VP8X's flags for them.
//   MP4 / MOV  the metadata boxes (udta and meta, in the movie and in each track, and XMP's uuid box) are emptied in place:
//         made "free" boxes of the same size, every byte zero, so no offset in the file moves.
// The format is read from the bytes, never from what the sender says. Anything else (HEIC and AVIF, whose metadata
// lives among the image's own items; any other format) is refused: a public page gets only what this can clean.

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const eq = (b, at, s) => s.length <= b.length - at && [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
const u16 = (b, at, le) => (le ? b[at] | (b[at + 1] << 8) : (b[at] << 8) | b[at + 1]);
const u32 = (b, at, le) => (le ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 2 ** 24 : b[at] * 2 ** 24 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]));
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** What kind of file the bytes are, by their own first bytes. */
export function sniff(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (eq(b, 0, "\x89PNG\r\n\x1a\n")) return "png";
  if (eq(b, 0, "RIFF") && eq(b, 8, "WEBP")) return "webp";
  if (eq(b, 4, "ftyp")) {
    const brands = new TextDecoder().decode(b.subarray(8, Math.min(b.length, 8 + Math.min(u32(b, 0), 64))));
    return /heic|heix|hevc|heim|heis|mif1|msf1|avif|avis/.test(brands) ? "heif" : "mp4";
  }
  if (["moov", "mdat", "wide", "free", "skip", "pnot"].some((t) => eq(b, 4, t))) return "mp4";
  return "other";
}

// ── JPEG ──
function exifOrientation(seg) {
  // seg: an APP1's payload after its length: "Exif\0\0" then a TIFF header.
  if (!eq(seg, 0, "Exif\0\0")) return 1;
  const t = 6, le = eq(seg, t, "II");
  if (!le && !eq(seg, t, "MM")) return 1;
  const ifd = t + u32(seg, t + 4, le);
  if (ifd + 2 > seg.length) return 1;
  const n = u16(seg, ifd, le);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > seg.length) break;
    if (u16(seg, e, le) === 0x0112) { const v = u16(seg, e + 8, le); return v >= 1 && v <= 8 ? v : 1; }
  }
  return 1;
}
/** An APP1 holding an Exif with one value: the orientation. */
function orientationOnly(v) {
  // "MM", 42, the first IFD at 8; one entry: tag 0x0112 (orientation), SHORT, count 1, the value; no next IFD.
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, v, 0, 0, 0, 0, 0, 0];
  const body = concat([ascii("Exif\0\0"), Uint8Array.from(tiff)]);
  const len = body.length + 2;
  return concat([Uint8Array.from([0xff, 0xe1, len >> 8, len & 255]), body]);
}
const KEEP_APP = new Set([0xe0, 0xe2, 0xee]);
function stripJpeg(b) {
  const out = [b.subarray(0, 2)];
  let orientation = 1, at = 2;
  while (at < b.length) {
    if (b[at] !== 0xff) return { refused: "This JPEG's segments don't read right." };
    let m = b[at + 1], start = at;
    while (m === 0xff) { at++; m = b[at + 1]; }
    if (m === 0xd9) { out.push(b.subarray(start, at + 2)); at += 2; break; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { out.push(b.subarray(start, at + 2)); at += 2; continue; }
    const len = u16(b, at + 2);
    const end = at + 2 + len;
    if (len < 2 || end > b.length) return { refused: "This JPEG's segments don't read right." };
    if (m === 0xda) { out.push(b.subarray(start)); at = b.length; break; } // the scan and everything after it: the picture
    const isApp = m >= 0xe0 && m <= 0xef;
    if (m === 0xe1) orientation = Math.max(orientation, exifOrientation(b.subarray(at + 4, end)));
    if ((isApp && !KEEP_APP.has(m)) || m === 0xfe) { at = end; continue; }
    out.push(b.subarray(start, end));
    at = end;
  }
  if (orientation !== 1) out.splice(1, 0, orientationOnly(orientation));
  return { bytes: concat(out), format: "jpeg" };
}

// ── PNG ──
const DROP_PNG = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
function stripPng(b) {
  const out = [b.subarray(0, 8)];
  let at = 8;
  while (at + 12 <= b.length) {
    const len = u32(b, at), type = String.fromCharCode(...b.subarray(at + 4, at + 8)), end = at + 12 + len;
    if (end > b.length) return { refused: "This PNG's chunks don't read right." };
    if (!DROP_PNG.has(type)) out.push(b.subarray(at, end));
    at = end;
    if (type === "IEND") break;
  }
  return { bytes: concat(out), format: "png" };
}

// ── WebP ──
function stripWebp(b) {
  const chunks = [];
  let at = 12;
  while (at + 8 <= b.length) {
    const type = String.fromCharCode(...b.subarray(at, at + 4)), len = u32(b, at + 4, true), end = at + 8 + len + (len & 1);
    if (at + 8 + len > b.length) return { refused: "This WebP's chunks don't read right." };
    if (type !== "EXIF" && type !== "XMP ") {
      const c = b.slice(at, Math.min(end, b.length));
      if (type === "VP8X") c[8] &= ~(0x08 | 0x04);
      chunks.push(c);
    }
    at = end;
  }
  const body = concat(chunks), size = 4 + body.length;
  const head = concat([ascii("RIFF"), Uint8Array.from([size & 255, (size >> 8) & 255, (size >> 16) & 255, (size >>> 24) & 255]), ascii("WEBP")]);
  return { bytes: concat([head, body]), format: "webp" };
}

// ── MP4 / MOV ──
const XMP_UUID = [0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac];
/** Each box between `from` and `to`: { at, header, end, type }. */
function* boxes(b, from, to) {
  let at = from;
  while (at + 8 <= to) {
    let size = u32(b, at), header = 8;
    const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
    if (size === 1) { if (at + 16 > to) return; size = u32(b, at + 8) * 2 ** 32 + u32(b, at + 12); header = 16; }
    else if (size === 0) size = to - at;
    if (size < header || at + size > to) return;
    yield { at, header, end: at + size, type };
    at += size;
  }
}
/** A box made a "free" box of the same size, every byte after its header zero. */
function emptyBox(b, box) {
  b.set(ascii("free"), box.at + 4);
  b.fill(0, box.at + box.header, box.end);
}
function stripMp4(src) {
  const b = src.slice();
  let emptied = 0;
  const inside = (from, to, depth) => {
    for (const box of boxes(b, from, to)) {
      if (box.type === "udta" || box.type === "meta") { emptyBox(b, box); emptied++; }
      else if (depth < 3 && (box.type === "trak" || box.type === "mdia" || box.type === "minf")) inside(box.at + box.header, box.end, depth + 1);
    }
  };
  for (const box of boxes(b, 0, b.length)) {
    if (box.type === "moov") inside(box.at + box.header, box.end, 1);
    else if (box.type === "meta" || box.type === "udta") { emptyBox(b, box); emptied++; }
    else if (box.type === "uuid" && XMP_UUID.every((x, i) => b[box.at + box.header + i] === x)) { emptyBox(b, box); emptied++; }
  }
  return { bytes: b, format: "mp4", emptied };
}

// ── the size, from the file's own header ──
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
function jpegSize(b) {
  let at = 2, orientation = 1;
  while (at + 4 <= b.length && b[at] === 0xff) {
    const m = b[at + 1];
    if (m === 0xff) { at++; continue; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { at += 2; continue; }
    const len = u16(b, at + 2), end = at + 2 + len;
    if (len < 2 || end > b.length || m === 0xda) return null;
    if (m === 0xe1) orientation = Math.max(orientation, exifOrientation(b.subarray(at + 4, end)));
    if (SOF.has(m) && len >= 7) {
      const height = u16(b, at + 5), width = u16(b, at + 7);
      return orientation >= 5 ? { width: height, height: width } : { width, height };
    }
    at = end;
  }
  return null;
}
function webpSize(b) {
  for (let at = 12; at + 8 <= b.length;) {
    const type = String.fromCharCode(...b.subarray(at, at + 4)), len = u32(b, at + 4, true), d = at + 8;
    if (type === "VP8X" && d + 10 <= b.length) return { width: 1 + (b[d + 4] | (b[d + 5] << 8) | (b[d + 6] << 16)), height: 1 + (b[d + 7] | (b[d + 8] << 8) | (b[d + 9] << 16)) };
    if (type === "VP8 " && d + 10 <= b.length) return { width: u16(b, d + 6, true) & 0x3fff, height: u16(b, d + 8, true) & 0x3fff };
    if (type === "VP8L" && d + 5 <= b.length && b[d] === 0x2f) {
      const bits = u32(b, d + 1, true);
      return { width: (bits & 0x3fff) + 1, height: (Math.floor(bits / 2 ** 14) & 0x3fff) + 1 };
    }
    at = d + len + (len & 1);
  }
  return null;
}
function mp4Size(b) {
  // The first track with a picture (an audio track's tkhd says 0 × 0): its tkhd's width and height (16.16), swapped
  // when its matrix turns it a quarter turn (a phone held upright records sideways and says so here).
  for (const moov of boxes(b, 0, b.length)) {
    if (moov.type !== "moov") continue;
    for (const trak of boxes(b, moov.at + moov.header, moov.end)) {
      if (trak.type !== "trak") continue;
      for (const tkhd of boxes(b, trak.at + trak.header, trak.end)) {
        if (tkhd.type !== "tkhd") continue;
        const c = tkhd.at + tkhd.header, v1 = b[c] === 1, matrix = c + (v1 ? 52 : 40), size = c + (v1 ? 88 : 76);
        if (size + 8 > tkhd.end) continue;
        const width = Math.round(u32(b, size) / 65536), height = Math.round(u32(b, size + 4) / 65536);
        if (!width || !height) continue;
        return u32(b, matrix) === 0 ? { width: height, height: width } : { width, height };
      }
    }
  }
  return null;
}

/** The picture's size as it is shown, from the file's own header; null when the header can't be read. */
export function sizeOf(input) {
  const b = input instanceof Uint8Array ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
  const kind = sniff(b);
  const size = kind === "jpeg" ? jpegSize(b)
    : kind === "png" ? (eq(b, 12, "IHDR") ? { width: u32(b, 16), height: u32(b, 20) } : null)
      : kind === "webp" ? webpSize(b)
        : kind === "mp4" ? mp4Size(b) : null;
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** The bytes with every place a camera or an editor keeps its metadata taken out, or why they can't be. */
export function stripMetadata(input) {
  // A plain Uint8Array over the same bytes: a Node Buffer's slice() is a view, not a copy, and the cleaners below copy
  // with slice() before they change anything, so the bytes they're given are never changed.
  const b = input instanceof Uint8Array ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
  const kind = sniff(b);
  if (kind === "jpeg") return stripJpeg(b);
  if (kind === "png") return stripPng(b);
  if (kind === "webp") return stripWebp(b);
  if (kind === "mp4") return stripMp4(b);
  if (kind === "heif") return { refused: "A board takes JPEG, PNG or WebP photographs (HEIC and AVIF keep where they were taken in a way this site can't take out). Send it as a JPEG." };
  return { refused: "A board takes JPEG, PNG or WebP photographs, and MP4 or MOV videos." };
}

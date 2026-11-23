// What a picture is, read from its own bytes: its type by its first bytes, its size from its own
// header. Never from the request's Content-Type or a width it claims (model §6). JPEG, PNG,
// WebP and AVIF; anything else (SVG included) is not a picture here.
//
//   readImage(bytes) -> { mime, width, height } | { bad: "<what it is instead>" }
//
// The size is the one AS SHOWN: a JPEG a phone stored on its side with an EXIF orientation of 5
// to 8 reports its width and height turned, as does an AVIF with a quarter-turn (irot); and an
// AVIF's size is its largest image's (a tile's or a thumbnail's extents can come first).

const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));
const be16 = (b, at) => (b[at] << 8) | b[at + 1];
const be32 = (b, at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const le16 = (b, at) => b[at] | (b[at + 1] << 8);
const le24 = (b, at) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

/** JPEG: the frame header (SOF0 to SOF15, but DHT, JPG and DAC, which share the range) holds the size. */
function jpeg(b) {
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return { bad: "a JPEG whose header can't be read" };
    const marker = b[at + 1];
    if (marker === 0xff) { at += 1; continue; }                 // fill bytes
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const length = be16(b, at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { mime: "image/jpeg", height: be16(b, at + 5), width: be16(b, at + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) break;              // end, or the image data: no frame header before it
    at += 2 + length;
  }
  return { bad: "a JPEG whose size can't be read" };
}

/** WebP: lossy (VP8), lossless (VP8L) or extended (VP8X) each keep the size in their own way. */
function webp(b) {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 " && b.length >= 30) return { mime: "image/webp", width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  if (chunk === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && b.length >= 30) return { mime: "image/webp", width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  return { bad: "a WebP whose size can't be read" };
}

/** A JPEG's EXIF orientation (1 to 8), or 1 when it says nothing. 5 to 8 turn it on its side. */
function jpegOrientation(b) {
  let at = 2;
  while (at + 4 < b.length) {
    if (b[at] !== 0xff) return 1;
    const marker = b[at + 1];
    const length = (b[at + 2] << 8) | b[at + 3];
    if (marker === 0xda || marker === 0xd9) return 1;
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(at + 4, at + 10)) === "Exif\0\0") {
      const tiff = at + 10;
      const little = b[tiff] === 0x49;                 // "II" little-endian, "MM" big
      const u16 = (o) => (little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const u32 = (o) => (little ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > b.length) return 1;
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > b.length) return 1;
        if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
      }
      return 1;
    }
    at += 2 + length;
  }
  return 1;
}

/** AVIF: the largest image spatial extents in the file (a tile's or a thumbnail's can come first), turned by irot. */
function avifSize(b) {
  let best = null;
  let turned = false;
  const end = Math.min(b.length - 12, 256 * 1024);
  for (let at = 4; at < end; at++) {
    if (b[at] === 0x69 && b[at + 1] === 0x73 && b[at + 2] === 0x70 && b[at + 3] === 0x65) {        // "ispe"
      const w = ((b[at + 8] << 24) >>> 0) + (b[at + 9] << 16) + (b[at + 10] << 8) + b[at + 11];
      const h = ((b[at + 12] << 24) >>> 0) + (b[at + 13] << 16) + (b[at + 14] << 8) + b[at + 15];
      if (!best || w * h > best.w * best.h) best = { w, h };
    }
    if (b[at] === 0x69 && b[at + 1] === 0x72 && b[at + 2] === 0x6f && b[at + 3] === 0x74) {        // "irot"
      turned = (b[at + 4] & 0x03) % 2 === 1;                                                          // 90 or 270 degrees
    }
  }
  if (!best) return null;
  return turned ? { width: best.h, height: best.w } : { width: best.w, height: best.h };
}

/** AVIF: an ISO file of brand avif or avis; its size from its image spatial extents, as shown. */
function avif(b) {
  const size = avifSize(b);
  return size ? { mime: "image/avif", ...size } : { bad: "an AVIF whose size can't be read" };
}

export function readImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 16) return { bad: "too short to be a picture" };
  let got;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    got = jpeg(b);
    if (!got.bad && jpegOrientation(b) >= 5) got = { ...got, width: got.height, height: got.width };   // on its side: as shown
  }
  else if (b[0] === 0x89 && ascii(b, 1, 7) === "PNG\r\n\x1a\n") {
    got = ascii(b, 12, 4) === "IHDR" ? { mime: "image/png", width: be32(b, 16), height: be32(b, 20) } : { bad: "a PNG whose size can't be read" };
  } else if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") got = webp(b);
  else if (ascii(b, 4, 4) === "ftyp" && ["avif", "avis"].includes(ascii(b, 8, 4))) got = avif(b);
  else {
    const head = ascii(b, 0, Math.min(b.length, 256)).trimStart().toLowerCase();
    return { bad: head.startsWith("<svg") || head.startsWith("<?xml") ? "an SVG (drawings aren't taken: a photo or a picture is)" : "not a JPEG, PNG, WebP or AVIF" };
  }
  if (got.bad) return got;
  if (!(got.width > 0 && got.height > 0)) return { bad: "a picture with no size" };
  return got;
}

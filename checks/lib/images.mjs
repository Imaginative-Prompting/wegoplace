// Pictures for the checks, made here: a PNG of any size (gray, or noise so it won't compress),
// and one small JPEG, WebP and AVIF of a flat colour (40 x 30, made once with Pillow and kept as
// they came out). Nothing of anyone's; no image library needed to run a check.

import zlib from "node:zlib";

const TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A gray PNG, width x height. With noise, its bytes are about width x height (it won't compress). */
export function png(width, height, { noise = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;        // bit depth
  ihdr[9] = 0;        // gray
  const raw = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;    // no filter on each row
  if (noise) for (let i = 0; i < raw.length; i++) if (i % (width + 1)) raw[i] = (Math.random() * 256) | 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAeACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCSiiivBPbCiiigAooooAKKKKACiiigAooooA//2Q==", "base64");

/**
 * A real JPEG of exactly `bytes` bytes (at least JPEG's own), for a check that counts bytes: the picture, then `fill`
 * after its end. What is kept for a board or as a thumbnail is cleaned first (src/media/strip.js) and must be a picture;
 * cleaning keeps everything after a JPEG's picture data byte for byte, so this is stored at the size it was sent.
 */
export function jpegOfSize(bytes, fill = 0) {
  if (bytes < JPEG.length) throw new Error(`a JPEG is at least ${JPEG.length} bytes`);
  return Buffer.concat([JPEG, Buffer.alloc(bytes - JPEG.length, fill)]);
}
/** A movie's boxes (ftyp, then the frames' mdat) of exactly `bytes` bytes: an MP4 as far as the cleaner reads, kept as sent. */
export function mp4OfSize(bytes, fill = 0) {
  const ftyp = Buffer.from("\0\0\0\x14ftypisom\0\0\x02\0isom", "latin1");
  const mdat = Buffer.alloc(bytes - ftyp.length, fill);
  mdat.writeUInt32BE(mdat.length, 0);
  mdat.write("mdat", 4, "latin1");
  return Buffer.concat([ftyp, mdat]);
}
export const WEBP = Buffer.from("UklGRkgAAABXRUJQVlA4IDwAAABwAwCdASooAB4APrVap06nJSOiJWgA4BaJZwDBvoAARMak4QAA+47/7FnLYF4/7UwSRk7ZKjcfNgiuAAA=", "base64");
export const AVIF = Buffer.from("AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAAHwAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAAKAAAAB4AAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAAJ21kYXQSAAoGGBUn6wIQMhMUAAMMMMQAstBjXnXPZZokgY2Q", "base64");
// The same 40 x 30 picture stored as a phone stores one held upright: a JPEG with EXIF orientation 6,
// an AVIF with a quarter-turn (irot). Shown, each is 30 x 40.
export const JPEG_TURNED = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAeACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCCiiivNOUKKKKACiiigAooooAKKKKACiiigD//2Q==", "base64");
export const AVIF_TURNED = Buffer.from("AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD1bWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAEdAAAAHgAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAAB0aXBycAAAAFRpcGNvAAAAFGlzcGUAAAAAAAAAKAAAAB4AAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAAAlpcm90AwAAABhpcG1hAAAAAAAAAAEAAQUBAoMEhQAAACZtZGF0EgAKBhgVJ+sCEDISFAADDDDEALLRNdS80vHXb7Qr", "base64");
/** An AVIF whose first image extents are a small one's (as a thumbnail's or a tile's can be): the
 * real 40 x 30 extents come after. Shown, it is 40 x 30. */
export function avifSmallFirst() {
  const ftypEnd = AVIF.readUInt32BE(0);
  const small = Buffer.alloc(20);
  small.writeUInt32BE(20, 0); small.write("ispe", 4, "ascii"); small.writeUInt32BE(0, 8); small.writeUInt32BE(8, 12); small.writeUInt32BE(6, 16);
  return Buffer.concat([AVIF.subarray(0, ftypEnd), small, AVIF.subarray(ftypEnd)]);
}
export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30"/></svg>');

/**
 * A colour PNG that reads as a picture in a still, made, not photographed: a sky over a ridge,
 * its colours and skyline turned by `hue` (0 to 360) so each picture differs from the next.
 * Small (tens of KB: flat runs compress), and within every picture limit at its default size.
 */
export function scene(width = 800, height = 600, hue = 200) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;        // bit depth
  ihdr[9] = 2;        // RGB
  const rgb = (h, s, l) => {
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  };
  // A ridge across it, its shape from the hue, so no two pictures have the same skyline.
  const ridge = Array.from({ length: width }, (_, x) => {
    const t = x / width;
    return Math.round(height * (0.6 - 0.12 * Math.sin(t * Math.PI * (1.3 + (hue % 7) / 5) + hue) - 0.05 * Math.sin(t * Math.PI * 5.1 + hue / 3)));
  });
  const ground = 30 + (hue % 80);            // ochre to green
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    // Sky: light low down, deeper above. Ground: darker toward the bottom of the frame.
    const sky = rgb(hue, 0.55, 0.8 - 0.32 * (1 - y / height));
    const land = rgb(ground, 0.35, 0.42 - 0.22 * (y / height));
    for (let x = 0; x < width; x++) raw.set(y < ridge[x] ? sky : land, row + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

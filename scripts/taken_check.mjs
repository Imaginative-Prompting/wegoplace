#!/usr/bin/env node
// When a photograph was taken (public/js/shared/taken.js), with no browser: files built here byte
// by byte, as a camera and a phone write them, and read back.
//   node scripts/taken_check.mjs [path/to/taken.js]
import path from "node:path";
import { pathToFileURL } from "node:url";

const where = process.argv[2] ? path.resolve(process.argv[2]) : new URL("../public/js/shared/taken.js", import.meta.url).pathname;
const { exifTime, localToUnix, takenAt, earliestTaken } = await import(pathToFileURL(where).href);

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}   -> ${detail}`); } };

// ── building files ─────────────────────────────────────────────────────────────────────────
const bytes = (...parts) => {
  const out = [];
  for (const p of parts) for (const x of (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)) out.push(x);
  return Uint8Array.from(out);
};
const be16 = (n) => [(n >> 8) & 255, n & 255];
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n) => [n & 255, (n >> 8) & 255];
const le32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

/** A TIFF block: IFD0 with Make and the EXIF pointer; the EXIF IFD with the original time (and its offset). */
function tiff({ le = true, time = "2027:06:03 14:22:10", offset = null, digitized = null } = {}) {
  const w16 = le ? le16 : be16, w32 = le ? le32 : be32;
  const make = "Made-up Camera\0";
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
  // Layout: header 8 | IFD0 (2 entries) | EXIF IFD | strings.
  const ifd0At = 8, ifd0Len = 2 + 2 * 12 + 4;
  const exifAt = ifd0At + ifd0Len;
  const exifEntries = [time && [0x9003, time + "\0"], digitized && [0x9004, digitized + "\0"], offset && [0x9011, offset + "\0"]].filter(Boolean);
  const exifLen = 2 + exifEntries.length * 12 + 4;
  let data = exifAt + exifLen;
  const blobs = [];
  const entry = (tag, s) => {
    const v = ascii(s);
    const e = [...w16(tag), ...w16(2), ...w32(v.length)];
    if (v.length <= 4) { e.push(...v, ...Array(4 - v.length).fill(0)); return e; }
    e.push(...w32(data)); blobs.push(v); data += v.length;
    return e;
  };
  const ifd0 = [...w16(2), ...entry(0x010f, make), ...w16(0x8769), ...w16(4), ...w32(1), ...w32(exifAt), ...w32(0)];
  const exif = [...w16(exifEntries.length), ...exifEntries.flatMap(([t, s]) => entry(t, s)), ...w32(0)];
  return [...ascii(le ? "II" : "MM"), ...w16(42), ...w32(ifd0At), ...ifd0, ...exif, ...blobs.flat()];
}
const jpeg = (t, { before = [] } = {}) => {
  const app1 = bytes("Exif\0\0", t);
  return bytes([0xff, 0xd8], before, [0xff, 0xe1], be16(app1.length + 2), app1, [0xff, 0xdb], be16(4), [0, 0], [0xff, 0xda], be16(2), [1, 2, 3], [0xff, 0xd9]);
};
const png = (t) => {
  const chunk = (type, data) => bytes(be32(data.length), type, data, [0, 0, 0, 0]);
  return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], chunk("IHDR", Array(13).fill(0)), chunk("eXIf", t), chunk("IDAT", [1, 2]), chunk("IEND", []));
};
/** HEIC: ftyp, meta (hdlr, iinf with an hvc1 item and an Exif item, iloc), mdat holding the Exif item. */
function heic(t) {
  const box = (type, ...body) => { const b = bytes(...body); return bytes(be32(b.length + 8), type, b); };
  const full = (type, v, ...body) => box(type, [v, 0, 0, 0], ...body);
  const exifItem = bytes(be32(6), "Exif\0\0", t);                     // offset to the TIFF header, then it
  const ftyp = box("ftyp", "heic", be32(0), "mif1heic");
  const build = (mdatAt) => {
    const iinf = full("iinf", 0, be16(2), full("infe", 2, be16(1), be16(0), "hvc1", "\0"), full("infe", 2, be16(2), be16(0), "Exif", "\0"));
    // iloc version 0: offset 4, length 4, base 0; two items, one extent each.
    const iloc = full("iloc", 0, [0x44, 0x00], be16(2), be16(1), be16(0), be16(1), be32(mdatAt + 8 + exifItem.length), be32(3),
      be16(2), be16(0), be16(1), be32(mdatAt + 8), be32(exifItem.length));
    return full("meta", 0, full("hdlr", 0, be32(0), "pict", Array(12).fill(0), "\0"), iinf, iloc);
  };
  const meta0 = build(0);
  const mdatAt = ftyp.length + meta0.length;
  return bytes(ftyp, build(mdatAt), box("mdat", exifItem, [9, 9, 9]));
}
const file = (b) => ({ slice: (a, z) => ({ arrayBuffer: async () => b.slice(a, z).buffer }) });

// ── what it holds ──────────────────────────────────────────────────────────────────────────
console.log("\nreading the time");
check("JPEG, little-endian (most phones): the time and the offset", JSON.stringify(exifTime(jpeg(tiff({ offset: "+09:00" })))) === JSON.stringify({ local: "2027-06-03T14:22:10", offset: "+09:00" }), JSON.stringify(exifTime(jpeg(tiff({ offset: "+09:00" })))));
check("JPEG, big-endian (many cameras), no offset", JSON.stringify(exifTime(jpeg(tiff({ le: false })))) === JSON.stringify({ local: "2027-06-03T14:22:10", offset: null }), JSON.stringify(exifTime(jpeg(tiff({ le: false })))));
check("JPEG with a JFIF segment before the EXIF one", exifTime(jpeg(tiff(), { before: [0xff, 0xe0, ...be16(16), ..."JFIF\0".split("").map((c) => c.charCodeAt(0)), 1, 1, 0, 0, 1, 0, 1, 0, 0] }))?.local === "2027-06-03T14:22:10");
check("with no original time, the digitized time", exifTime(jpeg(tiff({ time: null, digitized: "2027:06:04 08:00:00" })))?.local === "2027-06-04T08:00:00");
check("a camera that never set its clock (0000:00:00) says nothing", exifTime(jpeg(tiff({ time: "0000:00:00 00:00:00" }))) === null);
check("PNG's eXIf chunk", exifTime(png(tiff({ offset: "-05:00" })))?.offset === "-05:00");
check("HEIC: the Exif item the meta box points at", JSON.stringify(exifTime(heic(tiff({ offset: "+02:00" })))) === JSON.stringify({ local: "2027-06-03T14:22:10", offset: "+02:00" }), JSON.stringify(exifTime(heic(tiff({ offset: "+02:00" })))));
check("a JPEG with no EXIF, a GIF, a few bytes, nothing: null", exifTime(bytes([0xff, 0xd8, 0xff, 0xdb], be16(4), [0, 0], [0xff, 0xda], be16(2), [0xff, 0xd9])) === null
  && exifTime(bytes("GIF89a", Array(20).fill(0))) === null && exifTime(bytes([1, 2, 3])) === null && exifTime(new Uint8Array(0)) === null);
check("a broken EXIF block (a pointer past its end) says nothing and doesn't throw", (() => { const t = tiff(); t[4] = 250; t[5] = 250; try { return exifTime(jpeg(t)) === null; } catch { return false; } })());

console.log("\nthe moment");
check("with its offset: 14:22:10 at +09:00 is 05:22:10 UTC", localToUnix("2027-06-03T14:22:10", "+09:00", "America/Lima") === Date.UTC(2027, 5, 3, 5, 22, 10) / 1000);
check("with none, read in the trip's zone: 14:22 in Lima is 19:22 UTC", localToUnix("2027-06-03T14:22:10", null, "America/Lima") === Date.UTC(2027, 5, 3, 19, 22, 10) / 1000);
check("…and across a change of the clocks (New York, summer): 14:00 is 18:00 UTC", localToUnix("2027-07-01T14:00:00", null, "America/New_York") === Date.UTC(2027, 6, 1, 18) / 1000);
check("…and in winter: 14:00 is 19:00 UTC", localToUnix("2027-01-15T14:00:00", null, "America/New_York") === Date.UTC(2027, 0, 15, 19) / 1000);
check("a day that doesn't exist (31 June) is no time", localToUnix("2027-06-31T10:00:00", null, "UTC") === null);
check("an unknown zone reads as UTC rather than failing", localToUnix("2027-06-03T10:00:00", null, "Not/AZone") === Date.UTC(2027, 5, 3, 10) / 1000);

console.log("\nfiles");
const a = file(jpeg(tiff({ time: "2027:06:03 16:00:00", offset: "-05:00" })));
const b = file(jpeg(tiff({ time: "2027:06:03 09:15:00", offset: "-05:00" })));
const none = file(bytes([0xff, 0xd8, 0xff, 0xd9]));
check("one file", (await takenAt(a, "America/Lima")) === Date.UTC(2027, 5, 3, 21) / 1000);
check("the earliest of several, those that say nothing passed over", (await earliestTaken([none, a, b], "America/Lima")) === Date.UTC(2027, 5, 3, 14, 15) / 1000);
check("none that says: null (the memory is on the day it is posted)", (await earliestTaken([none], "America/Lima")) === null && (await earliestTaken([], "UTC")) === null);
check("a file that can't be read: null", (await takenAt({ slice: () => ({ arrayBuffer: async () => { throw new Error("gone"); } }) }, "UTC")) === null && (await takenAt(null, "UTC")) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

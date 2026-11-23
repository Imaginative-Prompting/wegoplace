// WHAT A STRANGER WITH A BOARD'S LINK CAN READ OUT OF ITS PICTURES. A shared board's photographs and videos are the
// trip's originals, copied beside it (public/js/memories.js), and its link is open to anyone, so what the site keeps
// for it carries nothing a camera writes into a file: where and when it was taken, the device, a comment
// (src/media/strip.js, on every board item and every thumbnail). First the rule on files made here, each with a
// camera's metadata put in (marked, so a byte of it left is found); then a server: a photograph and a video with a
// place in them put on a board, fetched signed out, with no byte of it left; and a thumbnail the same.
//
//   node checks/media/strip.mjs [--port <n>] [--rules-only]   (the rule alone, no server)

import zlib from "node:zlib";
import { CheckError, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { AVIF, JPEG, JPEG_TURNED, WEBP, png } from "../lib/images.mjs";
import { sizeOf, sniff, stripMetadata } from "../../src/media/strip.js";

const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : await freePort());
const t = new Report("what a board's link lets a stranger read out of its pictures");

// ── files with a camera's metadata in them ──
const MARKS = ["WGP-GPS-48.8566N-2.3522E", "WGP-CAMERA-Pixel-9", "WGP-COMMENT", "WGP-IPTC", "WGP-XMP", "ISO6709", "+48.8566+002.3522"];
const b = (...parts) => Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));
const be16 = (n) => [n >> 8, n & 255], be32 = (n) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const le32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
const carries = (bytes) => MARKS.filter((m) => Buffer.from(bytes).includes(Buffer.from(m, "latin1")));

/** An Exif (big-endian TIFF): the orientation, a description and the camera's model as text, and a GPS IFD. */
function exif(orientation) {
  const desc = Buffer.from(`${MARKS[0]}\0`, "latin1"), model = Buffer.from(`${MARKS[1]}\0`, "latin1");
  const ifd0 = 8, n0 = 4, gps = ifd0 + 2 + n0 * 12 + 4, nGps = 1, data = gps + 2 + nGps * 12 + 4;
  const entry = (tag, type, count, value) => [...be16(tag), ...be16(type), ...be32(count), ...be32(value)];
  const tiff = b("MM", [0, 42], be32(ifd0), be16(n0),
    entry(0x010e, 2, desc.length, data), entry(0x0110, 2, model.length, data + desc.length),
    [...be16(0x0112), ...be16(3), ...be32(1), ...be16(orientation), 0, 0], entry(0x8825, 4, 1, gps), be32(0),
    be16(nGps), [...be16(0x0001), ...be16(2), ...be32(2), 0x4e, 0, 0, 0], be32(0), desc, model);
  return b("Exif\0\0", tiff);
}
const segment = (marker, payload) => b([0xff, marker], be16(payload.length + 2), payload);
/** The real JPEG with a camera's APP1 (Exif, turned), an XMP APP1, an IPTC APP13 and a comment put in after SOI. */
const JPEG_GPS = b(JPEG.subarray(0, 2), segment(0xe1, exif(6)), segment(0xe1, b("http://ns.adobe.com/xap/1.0/\0", MARKS[4])),
  segment(0xed, b("Photoshop 3.0\0", MARKS[3])), segment(0xfe, b(MARKS[2])), JPEG.subarray(2));
const pngChunk = (type, data) => { const td = b(type, data); return b(be32(data.length), td, be32(zlib.crc32(td))); };
const PNG_PLAIN = png(4, 4);
const iend = PNG_PLAIN.length - 12;
const PNG_GPS = b(PNG_PLAIN.subarray(0, iend), pngChunk("tEXt", b("Comment\0", MARKS[2])), pngChunk("eXIf", exif(1).subarray(6)),
  pngChunk("iTXt", b("XML:com.adobe.xmp\0\0\0\0\0", MARKS[4])), PNG_PLAIN.subarray(iend));
const riffChunk = (type, data) => b(type, le32(data.length), data, data.length & 1 ? [0] : []);
const webpBody = b(WEBP.subarray(12), riffChunk("EXIF", exif(1).subarray(6)), riffChunk("XMP ", b(MARKS[4])));
const WEBP_GPS = b("RIFF", le32(4 + webpBody.length), "WEBP", webpBody);
const box = (type, ...payload) => { const p = b(...payload); return b(be32(p.length + 8), type, p); };
const MP4_GPS = b(box("ftyp", "isom", be32(512), "isommp41"),
  box("moov", box("mvhd", Buffer.alloc(100)), box("udta", box("\xa9xyz", be16(18), be16(0), MARKS[6])),
    box("meta", Buffer.alloc(4), box("keys", be32(0), be32(1), be32(44), "mdta", `com.apple.quicktime.location.${MARKS[5]}`)),
    box("trak", box("tkhd", Buffer.alloc(84)), box("udta", box("\xa9cmt", MARKS[2])))),
  box("uuid", [0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac], MARKS[4]),
  box("mdat", "the frames: kept, byte for byte"));
// A movie with a sound track (its tkhd 0 × 0) and then a picture track 320 × 180, turned a quarter (or not) by its matrix.
const tkhd = (w, h, turned) => box("tkhd", Buffer.alloc(40), be32(turned ? 0 : 0x10000), be32(turned ? 0x10000 : 0), Buffer.alloc(28), be32(w * 65536), be32(h * 65536));
const movie = (turned) => b(box("ftyp", "isom", be32(512), "isommp41"),
  box("moov", box("mvhd", Buffer.alloc(100)), box("trak", tkhd(0, 0, false)), box("trak", tkhd(320, 180, turned))), box("mdat", "frames"));
const orientationOf = (bytes) => {
  const at = Buffer.from(bytes).indexOf(Buffer.from([0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1]));
  return at < 0 ? 1 : bytes[at + 9];
};

let server, code = 1;
try {
  t.part("The rule, on files with a camera's metadata in them");
  t.same("each made file does carry the marks it's meant to (so finding none after means something)",
    [carries(JPEG_GPS).length, carries(PNG_GPS).length, carries(WEBP_GPS).length, carries(MP4_GPS).length], [5, 4, 3, 4]);
  // A Node Buffer's slice() is a view: a cleaner that copied with it would empty the caller's own file (and every later
  // test here would run on a file already emptied), and a tool comparing the cleaned bytes with the ones it read would
  // see no change. So this runs first, on copies, and the files themselves are counted again at the end.
  const fixtures = [JPEG_GPS, PNG_GPS, WEBP_GPS, MP4_GPS], pristine = fixtures.map((f) => Buffer.from(f));
  const given = fixtures.map((f) => Buffer.from(f));
  for (const f of given) stripMetadata(f);
  t.same("the bytes it's given are never changed (a JPEG, a PNG, a WebP and an MP4, each given as a Node Buffer)",
    given.map((f, i) => f.equals(pristine[i])), [true, true, true, true]);
  const j = stripMetadata(JPEG_GPS);
  t.same("a JPEG: no place, camera, comment, IPTC or XMP left; the picture's own bytes (its scan) untouched; still turned the way the camera turned it",
    [carries(j.bytes), Buffer.from(j.bytes).subarray(-JPEG.length + 2).equals(JPEG.subarray(2)), orientationOf(j.bytes), sniff(j.bytes)], [[], true, 6, "jpeg"]);
  t.same("  a JPEG turned with nothing else in it stays turned", orientationOf(stripMetadata(JPEG_TURNED).bytes), 6);
  const p = stripMetadata(PNG_GPS);
  t.same("a PNG: its text, eXIf and XMP chunks go, and it is the plain PNG again, byte for byte", [carries(p.bytes), Buffer.from(p.bytes).equals(PNG_PLAIN)], [[], true]);
  const w = stripMetadata(WEBP_GPS);
  t.same("a WebP: its EXIF and XMP chunks go, and it is the plain WebP again, byte for byte", [carries(w.bytes), Buffer.from(w.bytes).equals(WEBP)], [[], true]);
  const m = stripMetadata(MP4_GPS);
  t.same("an MP4/MOV: its place (©xyz), Apple's location key, a track's comment and its XMP emptied in place; the same size, the frames byte for byte",
    [carries(m.bytes), m.bytes.length, Buffer.from(m.bytes).subarray(-31).equals(MP4_GPS.subarray(-31))], [[], MP4_GPS.length, true]);
  t.same("a picture's size as it's shown, from its own header: a JPEG (turned: the other way round), a PNG, a WebP, a movie's picture track (turned by its matrix: the other way round), the same after cleaning; none from what it can't read",
    [sizeOf(JPEG), sizeOf(JPEG_TURNED), sizeOf(stripMetadata(JPEG_GPS).bytes), sizeOf(PNG_GPS), sizeOf(WEBP_GPS), sizeOf(stripMetadata(WEBP_GPS).bytes),
      sizeOf(movie(false)), sizeOf(movie(true)), sizeOf(stripMetadata(movie(true)).bytes), sizeOf(MP4_GPS), sizeOf(AVIF), sizeOf(Buffer.from("just text"))],
    [{ width: 40, height: 30 }, { width: 30, height: 40 }, { width: 30, height: 40 }, { width: 4, height: 4 }, { width: 40, height: 30 }, { width: 40, height: 30 },
      { width: 320, height: 180 }, { width: 180, height: 320 }, { width: 180, height: 320 }, null, null, null]);
  t.same("HEIC/AVIF and anything else: refused, in words", [typeof stripMetadata(AVIF).refused, typeof stripMetadata(Buffer.from("just text")).refused], ["string", "string"]);
  t.same("  and the files it cleaned above are as they were made, every mark still in them (what the server is sent below)",
    fixtures.map((f, i) => f.equals(pristine[i])), [true, true, true, true]);

  // ── a board on a server, read by a stranger ──
  if (argv.includes("--rules-only")) { code = t.end(); process.exit(code); }
  server = await startServer({ name: "media-strip", port });
  await server.start();
  const o = server.origin;
  const host = new Person(o, "Host Strip");
  await host.signUp();
  const trip = (await host.post("/api/trips", { name: "Strip Trip", default_tz: "UTC" })).json.trip.id;
  const T = `/api/trips/${trip}`;
  const share = (await host.call("POST", `${T}/collage/share?mime=image/jpeg&w=10&h=10&title=Board`, JPEG, { headers: { "Content-Type": "image/jpeg" } })).json;
  const id = share?.share?.id ?? share?.id;
  const put = (idx, kind, mime, bytes, size = "&w=10&h=10") => host.call("POST", `${T}/collage/share/${id}/item?idx=${idx}&kind=${kind}&mime=${encodeURIComponent(mime)}${size}&fx=0&fy=0&fw=1&fh=1&rot=0`, bytes, { headers: { "Content-Type": "application/octet-stream" } });
  const photo = await put(0, "photo", "image/jpeg", JPEG_GPS), video = await put(1, "video", "video/quicktime", MP4_GPS), heic = await put(2, "photo", "image/heic", AVIF);
  const stranger = new Person(o, "Stranger Strip");
  const get = async (path) => { const r = await fetch(`${o}${path}`); return { status: r.status, type: r.headers.get("content-type"), bytes: Buffer.from(await r.arrayBuffer()) }; };
  const servedPhoto = await get(`/s/${id}/i/0`), servedVideo = await get(`/s/${id}/i/1`);
  t.part("A board's photograph and video, fetched by someone signed out");
  t.same("a photograph with its place in it, put on a board, then fetched by a stranger: none of it in any byte served; still a turned JPEG",
    [photo.status, servedPhoto.status, servedPhoto.type, carries(servedPhoto.bytes), orientationOf(servedPhoto.bytes)], [200, 200, "image/jpeg", [], 6]);
  t.same("a video with its place in it, the same: none of it in any byte served", [video.status, servedVideo.status, carries(servedVideo.bytes), servedVideo.bytes.length], [200, 200, [], MP4_GPS.length]);
  t.same("a HEIC photograph: refused in words (415), nothing stored, the board's other prints as they were",
    [heic.status, typeof heic.json?.reason, (await get(`/s/${id}/i/2`)).status], [415, "string", 404]);
  t.ok("  (a stranger is signed out: no cookie went with those fetches)", !stranger.signedIn);
  {
    // An app that didn't know a picture's size sends 0 (or nothing): the file's own header says it.
    const zero = await put(3, "photo", "image/jpeg", JPEG_GPS, "&w=0&h=0"), none = await put(4, "video", "video/mp4", movie(true), "");
    const rows = server.sql(`SELECT idx, width, height FROM collage_share_items WHERE share_id = '${id}' AND idx IN (0, 3, 4) ORDER BY idx`).map((r) => [r.idx, r.width, r.height]);
    const html = (await get(`/s/${id}`)).bytes.toString("utf8");
    const native = (i) => new RegExp(`/s/${id}/i/${i}"[^>]*data-native-width="(\\d+)" data-native-height="(\\d+)"`).exec(html)?.slice(1).map(Number);
    t.same("a picture sent without its size is kept with its own (a JPEG turned: shown upright; a movie turned by its matrix), one sent with it as sent; the board's page says each",
      [zero.status, none.status, rows, native(3), native(4), native(0)], [200, 200, [[0, 10, 10], [3, 30, 40], [4, 180, 320]], [30, 40], [180, 320], [10, 10]]);
  }
  const thumb = await host.call("POST", `${T}/media/thumb?mime=image/jpeg`, JPEG_GPS, { headers: { "Content-Type": "application/octet-stream" } });
  const kept = thumb.json?.url ? await host.get(thumb.json.url) : null;
  t.same("a thumbnail sent with a camera's metadata in it is kept without it (it's what a board's page draws)",
    [thumb.status, kept ? carries(Buffer.from(kept.text, "latin1")) : "not kept"], [201, []]);
  // ── boards shared before the fix: tools/strip-shared-media.mjs, on this server's own bucket ──
  t.part("Boards shared before the fix, cleaned in place by tools/strip-shared-media.mjs");
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path"), crypto = await import("node:crypto");
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-strip-old-"));
  const legacy = { 5: ["image/jpeg", JPEG_GPS], 6: ["video/quicktime", MP4_GPS], 7: ["image/heic", AVIF], 8: ["image/jpeg", JPEG] };
  const oldThumb = `thumbs/strip-check-old.jpg`;
  // Put in with the server stopped, as the tool itself runs: a bucket written under a running server once reset its fetches.
  await server.halt();
  for (const [idx, [mime, bytes]] of Object.entries(legacy)) {
    const file = path.join(dir, `i${idx}`);
    fs.writeFileSync(file, bytes);
    server.put("wegoplace-media", `shares/${id}/old${idx}`, file);
    server.sql(`INSERT INTO collage_share_items (share_id, idx, kind, r2_key, mime, bytes, width, height, fx, fy, fw, fh, rot, memory_id, thumb_key)
      VALUES ('${id}', ${idx}, '${mime.startsWith("video") ? "video" : "photo"}', 'shares/${id}/old${idx}', '${mime}', ${bytes.length}, ${idx === "5" || idx === "8" ? "0, 0" : "10, 10"}, 0, 0, 1, 1, 0, NULL, '${idx === "5" ? oldThumb : ""}')`);
  }
  fs.writeFileSync(path.join(dir, "thumb"), JPEG_GPS);
  server.put("wegoplace-media", oldThumb, path.join(dir, "thumb"));
  await server.start();
  const tool = (...args) => spawnSync(process.execPath, ["tools/strip-shared-media.mjs", "--local", server.state, ...args], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."), encoding: "utf8" });
  const fetchAll = async () => { const all = {}; for (const i of [5, 6, 7, 8]) all[i] = (await get(`/s/${id}/i/${i}`)).bytes; return all; };
  const hashes = (all) => Object.fromEntries(Object.entries(all).map(([i, b]) => [i, crypto.createHash("sha256").update(b).digest("hex")]));
  const before = await fetchAll(), thumbBefore = (await get(`/s/${id}/i/5/thumb`)).bytes;
  t.same("  (as an older board stored them: the photograph, the video and the thumbnail carry their place)",
    [carries(before[5]).length > 0, carries(before[6]).length > 0, carries(thumbBefore).length > 0], [true, true, true]);
  await server.halt();
  const dryRun = tool("--dry-run");
  await server.start();
  const afterDry = await fetchAll();
  const sizes = () => server.sql(`SELECT idx, width, height FROM collage_share_items WHERE share_id = '${id}' AND idx IN (5, 6, 8) ORDER BY idx`).map((r) => [r.idx, r.width, r.height]);
  t.ok("a dry run says what it would clean (counts and sizes, never what a file holds) and changes nothing",
    dryRun.status === 0 && /would clean 3 /.test(dryRun.stdout) && /would give 2 board items their size/.test(dryRun.stdout) && JSON.stringify(hashes(afterDry)) === JSON.stringify(hashes(before))
      && JSON.stringify(sizes()) === JSON.stringify([[5, 0, 0], [6, 10, 10], [8, 0, 0]]) && !carries(Buffer.from(dryRun.stdout)).length, dryRun.stdout + dryRun.stderr);
  await server.halt();
  const real = tool();
  await server.start();
  const after = await fetchAll();
  const thumbAfter = (await get(`/s/${id}/i/5/thumb`)).bytes;
  t.ok("the run cleans them in place: fetched by a stranger now, no byte of the place left in the photograph, the video or the thumbnail",
    real.status === 0 && /cleaned 3 /.test(real.stdout) && !carries(after[5]).length && !carries(after[6]).length && !carries(thumbAfter).length, real.stdout + real.stderr);
  t.same("  a HEIC is left as it is, and listed by key and size; one already clean is untouched; the photograph still turned",
    [/left: shares\/[0-9a-f]+\/old7 \(heif, \d+ bytes\)/.test(real.stdout), hashes(after)[8] === hashes(before)[8], hashes(after)[7] === hashes(before)[7], orientationOf(after[5])], [true, true, true, 6]);
  t.same("  each cleaned item's size is what's stored now (the host's room counts it)",
    server.sql(`SELECT idx, bytes FROM collage_share_items WHERE share_id = '${id}' AND idx IN (5, 6) ORDER BY idx`).map((r) => r.bytes), [after[5].length, after[6].length]);
  const twice = (await server.halt(), tool());
  await server.start();
  t.same("  an item stored with no size gets its own from its header, cleaned (turned: upright) or already clean; one with a size keeps it",
    [/gave 2 board items their size/.test(real.stdout), sizes()], [true, [[5, 30, 40], [6, 10, 10], [8, 40, 30]]]);
  t.ok("  run again: nothing left to clean, and no size left to give", twice.status === 0 && /cleaned 0 /.test(twice.stdout) && /gave 0 board items their size/.test(twice.stdout), twice.stdout);
  fs.rmSync(dir, { recursive: true, force: true });
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  code = 2;
} finally {
  await server?.stop().catch(() => {});
}
process.exit(code);

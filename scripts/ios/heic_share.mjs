#!/usr/bin/env node
// A board shared from an iPhone with a HEIC photo on it: in an iPhone Simulator's Safari, real touches.
// Off the gate (scripts/ios/README.md says what it needs). On the gate's server (WGP_BASE, WGP_GATE_CARD).
//
//   LAB_UDID=<a device of your own> IOS_AXE=<the AXe binary> WGP_BASE=… WGP_GATE_CARD=… node scripts/ios/heic_share.mjs <out folder>
//
// It puts three memories on the gate's made-up trip, removed when it ends: two JPEG photos and one HEIC (a
// made-up picture, turned into HEIC with sips). The trip's host, on the phone, opens the board and presses
// "Create a share link". What it proves: the share's sentence says nothing was lost; the board's page has a
// print for each of the three, every one opening its own picture; and none of those pictures carries camera
// data (no Exif block in the file the page serves). The device is erased first and shut down at the end,
// whatever happens.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect } from "./phone.mjs";
import { scene } from "../../checks/lib/images.mjs";
import { makeApi, seedMemories } from "../lib/seed_memories.mjs";
import { ORIGIN, tripApi, tripPath } from "../lib/gate_trip.mjs";
import { freeLoopbackPort } from "../lib/browser.mjs";

const out = path.resolve(process.argv[2] || "");
if (!process.argv[2]) { console.error("usage: node scripts/ios/heic_share.mjs <out folder>"); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const PART = 8 * 1024 * 1024;

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 600) : ""}`); }
};

// The HEIC: a made-up picture (a sky over a ridge), as an iPhone would keep it, with made-up camera data in it
// (a maker, a model and a place: Pillow writes them into a JPEG, and sips keeps them in the HEIC it makes).
const CAMERA = "MadeUpCam";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-heic-"));
const png = path.join(dir, "ridge.png"), withExif = path.join(dir, "ridge.jpg"), heic = path.join(dir, "IMG_0001.HEIC"), thumb = path.join(dir, "thumb.jpg");
fs.writeFileSync(png, scene(3024, 4032, 11));
const exifPy = path.join(dir, "exif.py");
fs.writeFileSync(exifPy, [
  "import sys",
  "from PIL import Image",
  "im = Image.open(sys.argv[1]).convert('RGB')",
  "ex = Image.Exif()",
  `ex[0x010F] = '${CAMERA}'`,
  "ex[0x0110] = 'Model 1'",
  "ex[0x8825] = {1: 'N', 2: (45.0, 30.0, 0.0), 3: 'E', 4: (6.0, 15.0, 0.0)}",
  "im.save(sys.argv[2], quality=92, exif=ex.tobytes())",
].join("\n"));
execSync(`python3 ${JSON.stringify(exifPy)} ${JSON.stringify(png)} ${JSON.stringify(withExif)}`, { stdio: "ignore" });
execSync(`sips -s format heic ${JSON.stringify(withExif)} --out ${JSON.stringify(heic)}`, { stdio: "ignore" });
execSync(`sips -s format jpeg -Z 480 ${JSON.stringify(png)} --out ${JSON.stringify(thumb)}`, { stdio: "ignore" });
const heicBytes = fs.readFileSync(heic), thumbBytes = new Uint8Array(fs.readFileSync(thumb));
fs.rmSync(dir, { recursive: true, force: true });

const api = await makeApi();
const photos = await seedMemories(2);
let heicMemory = null;
const keys = [];
let phone = null;
let code = 1;
// Whatever throws, even outside this file's awaits (the relay's own handlers), the device goes down.
const downNow = (why) => {
  console.log(`\nSTOPPED (${why})`);
  try { execSync(`/usr/bin/xcrun simctl shutdown ${process.env.LAB_UDID}`, { stdio: "ignore" }); } catch { /* already down */ }
  console.log(`  note  the device shut down at ${new Date().toTimeString().slice(0, 8)}`);
  process.exit(1);
};
process.on("uncaughtException", (e) => downNow(e?.stack || e));
process.on("unhandledRejection", (e) => downNow(e?.stack || e));
try {
  const beg = await api(tripApi("/media/begin"), { method: "POST", body: { name: "IMG_0001.HEIC", mime: "image/heic", bytes: heicBytes.length, kind: "photo" } });
  if (beg.status !== 201) throw new Error("media/begin: " + beg.text);
  const { key, uploadId, parts } = beg.json;
  const etags = [];
  for (let n = 1; n <= parts; n++) {
    const r = await api(`${tripApi("/media/part")}?key=${encodeURIComponent(key)}&id=${encodeURIComponent(uploadId)}&n=${n}`,
      { method: "POST", body: heicBytes.subarray((n - 1) * PART, Math.min(n * PART, heicBytes.length)) });
    if (r.status !== 200) throw new Error(`media/part ${n}: ` + r.text);
    etags.push({ n, etag: r.json.etag });
  }
  const fin = await api(tripApi("/media/finish"), { method: "POST", body: { key, id: uploadId, parts: etags } });
  if (fin.status !== 200) throw new Error("media/finish: " + fin.text);
  keys.push(key);
  const th = await api(`${tripApi("/media/thumb")}?for=${encodeURIComponent(key)}&mime=image/jpeg`, { method: "POST", body: thumbBytes });
  if (th.json?.key) keys.push(th.json.key);
  const made = await api(tripApi("/memories"), { method: "POST",
    body: { caption: "The ridge from the pass", tags: ["standalone verify"], media: [{ key, thumb_key: th.json.key, kind: "photo", w: 3024, h: 4032 }] } });
  if (made.status !== 201) throw new Error("memories POST: " + made.text);
  heicMemory = made.json.memory.id;
  check("setup: a HEIC photo's memory beside two JPEG ones, the HEIC carrying camera data (the control)",
    heicBytes.includes(Buffer.from("Exif")) && heicBytes.includes(Buffer.from(CAMERA)), `${heicBytes.length} bytes of HEIC`);

  const listen = await freeLoopbackPort();
  phone = await connect({ listen, upstream: Number(new URL(ORIGIN).port), out, said: [], pageErrors: [] });
  phone.cookie({ name: "wgp_session", value: api.session, maxAge: 3600 });
  // The first address installs the app to the Home Screen and opens it from its icon (at "/"); the second is
  // the trip's memories, inside that app.
  const memoriesAt = `http://localhost:${listen}${tripPath("#/memories")}`;
  const tab = await phone.openTab(memoriesAt);
  await tab.go(memoriesAt);
  await tab.wait(`document.querySelector('.me-viewbtn[data-view="collage"]') ? 1 : 0`, "the view toggle", 60000);
  await tab.touchEl('.me-viewbtn[data-view="collage"]');
  await tab.wait(`document.querySelectorAll(".cg-item").length >= 3 ? 1 : 0`, "the board with its three prints", 60000);
  await tab.shot("heic-1-board");
  await tab.touchEl(".cg-look");
  await tab.wait(`document.querySelector(".cg-sharelink") ? 1 : 0`, "the sheet's share button", 20000);
  await tab.touchEl(".cg-sharelink");
  const said = await tab.wait(`(() => { const s = document.querySelector(".cg-lookstat"); const t = s ? s.textContent : ""; return /^Link (copied|ready)/.test(t) ? t : 0; })()`, "the share's sentence", 240000);
  const url = await tab.page(`document.querySelector(".cg-shareurl").value`);
  await tab.shot("heic-2-shared");
  check("the share's sentence says nothing was lost", !/won't open/.test(said), said);
  const sharePath = new URL(url).pathname;
  const html = await (await fetch(`${ORIGIN}${sharePath}`)).text();
  const tiles = (html.match(/aria-label="Open (photograph|video) \d+ of \d+"/g) || []).length;
  check("the board's page has a print for each of the three", tiles === 3, `${tiles} prints on ${sharePath}`);
  const files = [];
  for (let n = 0; n < tiles; n++) {
    const r = await fetch(`${ORIGIN}${sharePath}/i/${n}`);
    const buf = Buffer.from(await r.arrayBuffer());
    files.push({ n, status: r.status, type: r.headers.get("content-type"), bytes: buf.length, exif: buf.includes(Buffer.from("Exif\0\0")) || buf.includes(Buffer.from(CAMERA)) });
  }
  check("every print opens its own picture", files.length === 3 && files.every((f) => f.status === 200 && /^image\//.test(f.type || "") && f.bytes > 1000), JSON.stringify(files));
  check("none of them carries camera data", files.every((f) => !f.exif), JSON.stringify(files.map((f) => f.exif)));
  console.log(`\n${pass} passed, ${fail} failed`);
  code = fail ? 1 : 0;
} catch (e) {
  console.log(`\nSTOPPED: ${e?.stack || e}\n${pass} passed, ${fail} failed before it stopped`);
  code = 1;
} finally {
  if (phone) { try { await phone.done(); } catch { /* down */ } }
  console.log(`  note  the device shut down at ${new Date().toTimeString().slice(0, 8)}`);
  if (heicMemory) { try { await api(tripApi(`/memories/${heicMemory}`), { method: "DELETE" }); } catch { /* gone */ } }
  while (keys.length) { const k = keys.pop(); try { await api(`${tripApi("/media/object")}?key=${encodeURIComponent(k)}`, { method: "DELETE" }); } catch { /* gone */ } }
  await photos.cleanup().catch(() => {});
}
process.exit(code);

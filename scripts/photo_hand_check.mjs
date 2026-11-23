#!/usr/bin/env node
/* A photo added by hand (public/js/photo-hand.js over picture-make.js and picture-wait.js): a
 * place's page, a plan's page and the trip's cover, as two people do it on two phones, with the
 * phone's own picker (the file chooser a tap opens), on a server of its own.
 *
 *   node scripts/photo_hand_check.mjs
 *   <the queue> -- node scripts/photo_hand_check.mjs
 *
 * What it holds:
 *   1. A PLACE, with signal: "Add a photo" opens the phone's picker; the photo picked is made on
 *      the phone: upright (a camera's quarter-turn applied), 1600 px on its long side, under
 *      600 KB, a JPEG with none of the camera's data (no Exif, no GPS, no camera name), sent
 *      with license "own". The page shows it with Change photo and Remove photo, and nothing
 *      to say once it is there.
 *   2. THE OTHER PHONE, open on the same place: the photo arrives without a reload.
 *   3. A PLAN: it shows its place's photo until it has its own; "Add a photo" there is the
 *      plan's alone (the place keeps its own).
 *   4. NO SIGNAL: a photo picked with none is shown at once, and the page says it waits; the
 *      server still has the old one. Reopened with no signal it still waits. When the signal is
 *      back it goes by itself, and the page says nothing more.
 *   5. A REFUSAL: the host's storage full, the other person picks one: the page says "Not sent:"
 *      and the server's own sentence; the picture stays on the card. Remove takes the unsent
 *      one and the one on the server shows again.
 *   6. REMOVE asks twice, takes the photo from the server, and the other phone loses it too.
 *   7. THE COVER on the trip's page, by a link (?photo=add#cover): the words say what to do and
 *      the button has the focus; the cover goes up; the other person's Your trips shows it.
 *   8. A LINK INTO THE APP (what an AI app hands the person): #/p/<id>?photo=add and
 *      #/e/<id>?photo=add bring the photo's buttons into view, focused, nothing taken; signed
 *      out, the sign-in page keeps the whole address to come back to (the cover's too).
 *   9. KEPT FOR NO SIGNAL: the other phone, its service worker in control, keeps the plan's photo;
 *      with no signal on the page already open (onLine false, a request only the network answers
 *      fails), the photo still comes, past the browser's cache, from the copy the phone keeps.
 *  10. No page error on either phone.
 *
 * The photos are made here by ffmpeg (a test pattern, nothing of anyone's), one of them given a
 * made-up camera's Exif: a quarter-turn, a GPS position and a camera name, so what is stored can
 * be read for each.
 *
 * PLANTED (red when put in by hand):
 *   - photo-hand.js view() answering the row as it is: section 4's "the page shows the photo
 *     picked with no signal" fails (the old one shows).
 *   - auth.js nextPath() without the address's # (the server's redirect never sees it): both of
 *     section 8's signed-out lines fail.
 *   - photo-hand.js removing with onServer: false always: section 6's "gone from the server" fails.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";

const FIXDIR = process.env.WGP_FIXTURES || path.join(os.tmpdir(), "wgp-photo-fixtures");
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// ── the photos ─────────────────────────────────────────────────────────────────────────────
// A made-up camera's Exif (big-endian TIFF): Make "TestCam-WGP", Orientation 6 (the picture is
// stored on its side and shown turned a quarter clockwise), and a GPS position 12°34'56" S,
// 76°54'32.1" W.
const CAMERA = "TestCam-WGP";
function exifApp1() {
  const t = Buffer.alloc(164);
  t.write("MM", 0, "ascii"); t.writeUInt16BE(42, 2); t.writeUInt32BE(8, 4);
  const entry = (at, tag, type, count, value) => { t.writeUInt16BE(tag, at); t.writeUInt16BE(type, at + 2); t.writeUInt32BE(count, at + 4); value(at + 8); };
  t.writeUInt16BE(3, 8);
  entry(10, 0x010f, 2, 12, (v) => t.writeUInt32BE(50, v));
  entry(22, 0x0112, 3, 1, (v) => t.writeUInt16BE(6, v));
  entry(34, 0x8825, 4, 1, (v) => t.writeUInt32BE(62, v));
  t.writeUInt32BE(0, 46);
  t.write(`${CAMERA}\0`, 50, "ascii");
  t.writeUInt16BE(4, 62);
  entry(64, 1, 2, 2, (v) => t.write("S\0", v, "ascii"));
  entry(76, 2, 5, 3, (v) => t.writeUInt32BE(116, v));
  entry(88, 3, 2, 2, (v) => t.write("W\0", v, "ascii"));
  entry(100, 4, 5, 3, (v) => t.writeUInt32BE(140, v));
  t.writeUInt32BE(0, 112);
  [[12, 1], [34, 1], [5600, 100], [76, 1], [54, 1], [3210, 100]].forEach(([n, d], i) => { t.writeUInt32BE(n, 116 + i * 8); t.writeUInt32BE(d, 120 + i * 8); });
  const body = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), t]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}
function fixtures() {
  fs.mkdirSync(FIXDIR, { recursive: true });
  const ffmpeg = (args, what) => {
    try { execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "inherit"] }); }
    catch (e) { throw new Error(`ffmpeg could not make ${what} (${e.code === "ENOENT" ? "ffmpeg is not installed" : e.message}). This check needs ffmpeg.`); }
  };
  const make = (name, w, h, src) => {
    const file = path.join(FIXDIR, name);
    if (!fs.existsSync(file)) ffmpeg(["-f", "lavfi", "-i", `${src}=size=${w}x${h}:rate=1`, "-frames:v", "1", "-q:v", "2", file], name);
    return file;
  };
  // The camera's: 4032 x 3024 as stored, on its side; with its Exif put straight after the start.
  const plain = make("camera-plain.jpg", 4032, 3024, "testsrc2");
  const turned = path.join(FIXDIR, "camera-turned.jpg");
  if (!fs.existsSync(turned)) { const j = fs.readFileSync(plain); fs.writeFileSync(turned, Buffer.concat([j.subarray(0, 2), exifApp1(), j.subarray(2)])); }
  return {
    turned,                                              // shown 3024 x 4032: made 1200 x 1600
    wide: make("wide.jpg", 3000, 2000, "testsrc"),      // made 1600 x 1067
    third: make("third.jpg", 2400, 1800, "rgbtestsrc"), // made 1600 x 1200
  };
}
const FIX = fixtures();

const server = await startServer({ name: "photo-hand", port: await freeLoopbackPort() });
ownServer(server.origin);

const phones = [];
try {
  await server.start();
  const ana = new Person(server.origin, "Ana Ferreira-Holt"), ben = new Person(server.origin, "Ben Okafor-Lind");
  await ana.signUp(); await ben.signUp();
  const made = await ana.post("/api/trips", { name: "Lake week", default_tz: "Europe/Lisbon", starts_on: "2027-05-01", ends_on: "2027-05-07" });
  const trip = made.json.trip.id, T = `/api/trips/${trip}`;
  const link = await ana.post(`${T}/links`, {});
  const joined = await ben.post(`/api/join/${link.json.link.code}`);
  await ana.call("PUT", `${T}/places`, { places: [{ id: "lake-hut", name: "The lake hut", kind: "lodging", subkind: "hostel", why: "Where we sleep." }] });
  await ana.post(`${T}/events`, { id: "boat", title: "Boat across the lake", starts_at: Date.UTC(2027, 4, 2, 9) / 1000, tz: "Europe/Lisbon", place_id: "lake-hut" });
  const snap = async () => (await ana.get(T)).json;
  const placePic = async () => ((await snap()).places.find((p) => p.id === "lake-hut") || {}).picture || null;
  const eventPic = async () => ((await snap()).events.find((e) => e.id === "boat") || {}).picture || null;
  check("two people on a trip with a place and a plan on it, and no pictures", made.status === 201 && joined.status < 300 && !(await placePic()) && !(await eventPic()),
    `${made.status} ${joined.status}`);
  const until = async (fn, label, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 400)); }
  };

  const { boot, evalIn, waitFor, appSettled, sleep } = await import("./lib/standalone_cdp.mjs");

  // A phone: one browser, signed in as one person (or nobody), with the picker intercepted so a
  // tap's file chooser is seen and answered with a real file.
  async function phoneOf(person) {
    const b = await boot({ vw: 390, vh: 844, dsf: 1 });
    phones.push(b);
    const { cdp, S } = b;
    for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: server.origin }, S);
    if (person) {
      await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: person.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
      const who = person.jar.cookies.get("wgp_who");
      if (who) await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: who, sameSite: "Lax" }, S);
    }
    await cdp.send("DOM.enable", {}, S);
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, S);
    const choosers = [];
    cdp.on((m) => { if (m.sessionId === S && m.method === "Page.fileChooserOpened") choosers.push(m.params); });
    const page = (expr) => evalIn(cdp, S, expr);
    const wait = (expr, label, timeout) => waitFor(cdp, S, expr, { label, ...(timeout ? { timeout } : {}) });
    let nav = 0;
    const phone = {
      b, cdp, S, page, wait,
      async go(url) {
        await cdp.send("Page.navigate", { url }, S);
        await sleep(300);
        await appSettled(cdp, S).catch(() => {});
      },
      // A fresh document every time on the trip's app.
      async app(hash) { await phone.go(`${server.origin}/t/${trip}/?n=${++nav}#${hash}`); },
      // A real tap on an element's middle (Chrome's mouse: what the picker needs to open).
      async tap(selector) {
        const r = JSON.parse(await page(`JSON.stringify((() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; n.scrollIntoView({ block: "center" }); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })())`));
        if (!r) throw new Error(`nothing to tap: ${selector}`);
        await sleep(150);
        for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 }, S);
      },
      // Tap the photo's button and answer the picker that opens with a real file.
      async pick(file, selector = '#photo [data-photo="pick"]') {
        const before = choosers.length;
        await phone.tap(selector);
        const end = Date.now() + 8000;
        while (choosers.length === before && Date.now() < end) await sleep(100);
        const c = choosers[before];
        if (!c) return false;
        await cdp.send("DOM.setFileInputFiles", { files: [file], backendNodeId: c.backendNodeId }, S);
        return true;
      },
      block: async () => JSON.parse(await page(`JSON.stringify((() => { const b = document.getElementById("photo"); if (!b) return null;
        const say = b.querySelector(".ph-say"); const hero = document.querySelector(".pl-hero img, .ag-d-shot img, #cover-pic img");
        return { state: b.dataset.photoState, buttons: [...b.querySelectorAll("[data-photo]")].map((x) => x.textContent.trim()),
          say: say && !say.hidden ? say.textContent.trim() : "", hero: hero ? hero.getAttribute("src") : "",
          heroDrawn: !!hero && hero.complete && hero.naturalWidth > 0, focused: !!document.activeElement && document.activeElement.matches('#photo [data-photo="pick"]'),
          inView: (() => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })() }; })())`)),
      offline: (on) => cdp.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S),
      look: async (name) => { if (SHOTS) await b.shot(path.join(SHOTS, `photo-${name}.png`)); },
    };
    return phone;
  }

  // What the stored file is, read in a page as the trip's people read it.
  const READ_FILE = (url) => `(async () => { const r = await fetch(${JSON.stringify(url)}); const buf = new Uint8Array(await r.arrayBuffer());
    const text = new TextDecoder("latin1").decode(buf); const bmp = await createImageBitmap(new Blob([buf]));
    const lat = [0, 0, 0, 12, 0, 0, 0, 1, 0, 0, 0, 34, 0, 0, 0, 1]; let gps = false;
    for (let i = 0; i + lat.length <= buf.length && !gps; i++) { let k = 0; while (k < lat.length && buf[i + k] === lat[k]) k++; if (k === lat.length) gps = true; }
    return JSON.stringify({ status: r.status, bytes: buf.length, jpeg: buf[0] === 0xff && buf[1] === 0xd8, exif: text.includes("Exif"), camera: text.includes(${JSON.stringify(CAMERA)}), gps, w: bmp.width, h: bmp.height }); })()`;

  const A = await phoneOf(ana);
  const B = await phoneOf(ben);

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────────
  section("1. a place, with signal: a camera's photo, made on the phone");
  await B.app("/p/lake-hut");                       // the other phone open on it before
  await B.wait(`document.getElementById("photo") ? 1 : 0`, "the place on the other phone");
  await A.app("/p/lake-hut");
  await A.wait(`document.getElementById("photo") ? 1 : 0`, "the place's photo buttons");
  let blk = await A.block();
  check("a place with no photo offers \"Add a photo\" beside Change, and shows none", blk.buttons.join("|") === "Add a photo" && !blk.hero && blk.state === "none"
    && (await A.page(`!!document.querySelector('#photo .pl-change [data-act="change"]')`)), JSON.stringify(blk));
  await A.look("place-none");
  const opened = await A.pick(FIX.turned);
  check("the button opens the phone's picker (a file chooser, for pictures)", opened && (await A.page(`document.querySelector("input.ph-file").accept`)) === "image/*");
  const pic1 = await until(placePic, "the place's picture on the server");
  check("the photo reached the server as the place's, the person's own", !!pic1 && pic1.license === "own" && pic1.url.startsWith("/media/"), JSON.stringify(pic1));
  if (pic1) {
    check("made upright and to its size on the phone: 1200 x 1600 from a 4032 x 3024 on its side", pic1.width === 1200 && pic1.height === 1600, `${pic1.width} x ${pic1.height}`);
    const f = JSON.parse(await A.page(READ_FILE(pic1.url)));
    check("the stored file is a JPEG of that size, under 600 KB", f.status === 200 && f.jpeg && f.w === 1200 && f.h === 1600 && f.bytes <= 600 * 1024, JSON.stringify(f));
    check("none of the camera's data is in it: no Exif, no GPS position, no camera name", !f.exif && !f.gps && !f.camera, JSON.stringify(f));
    await A.wait(`(() => { const i = document.querySelector(".pl-hero img"); return i && i.getAttribute("src") === ${JSON.stringify(pic1.url)} && i.complete && i.naturalWidth > 0 ? 1 : 0; })()`, "the hero drawn from the server's picture");
    blk = await A.block();
    check("the page shows it, with Change photo and Remove photo, and nothing to say", blk.heroDrawn && blk.buttons.join("|") === "Change photo|Remove photo" && !blk.say && blk.state === "stored", JSON.stringify(blk));
    await A.look("place-stored");

    // ── 2 ────────────────────────────────────────────────────────────────────────────────────
    section("2. the other phone, open on the same place");
    const live = await until(async () => (await B.block()).hero === pic1.url, "the photo on the other phone", 30000);
    check("the photo arrives on the other phone without a reload", !!live, JSON.stringify(await B.block()));
  }

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────────
  section("3. a plan: its place's photo until it has its own");
  await A.app("/e/boat");
  await A.wait(`document.getElementById("photo") ? 1 : 0`, "the plan's photo buttons");
  blk = await A.block();
  check("the plan shows its place's photo, and offers \"Add a photo\" of its own (in its own row, Change and Chat about this at the top)", !!pic1 && blk.hero === pic1.url && blk.buttons.join("|") === "Add a photo"
    && (await A.page(`!!document.querySelector(".ag-detail > .ag-d-acts [data-plan-change]") && !!document.querySelector(".ag-detail > .ag-d-acts [data-plan-chat]") && !document.querySelector("#photo [data-plan-change]")`)), JSON.stringify(blk));
  await A.pick(FIX.wide);
  const ev1 = await until(eventPic, "the plan's picture on the server");
  check("the plan's own photo, 1600 x 1067, on the plan", !!ev1 && ev1.width === 1600 && ev1.height === 1067 && ev1.license === "own", JSON.stringify(ev1));
  check("the place keeps its own", !!pic1 && ((await placePic()) || {}).url === pic1.url);
  if (ev1) await A.wait(`(() => { const i = document.querySelector(".ag-d-shot img"); return i && i.getAttribute("src") === ${JSON.stringify(ev1.url)} ? 1 : 0; })()`, "the plan's hero");
  await A.look("plan-own");

  // The photo on the card, once the browser has drawn it (5 s at most): the state changes as the img's src is set, and its
  // decode comes after. Read at once, a busy machine's page hadn't drawn it yet: 1 run in 2 on 23 Nov, rework's own tip
  // too. A photo that never draws is still red: the read after says so.
  const drawnFrom = (P, start) => P.wait(`(() => { const i = document.querySelector(".pl-hero img, .ag-d-shot img, #cover-pic img"); return i && (i.getAttribute("src") || "").startsWith(${JSON.stringify(start)}) && i.complete && i.naturalWidth > 0 ? 1 : 0; })()`, "the photo drawn", 5000).catch(() => null);

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────────
  section("4. no signal: kept on the phone, said, and sent when it can be");
  await A.offline(true);
  await A.pick(FIX.third);
  await A.wait(`(document.querySelector("#photo") || { dataset: {} }).dataset.photoState === "waiting" ? 1 : 0`, "the photo waiting");
  await drawnFrom(A, "blob:");
  blk = await A.block();
  check("the page shows the photo picked with no signal (on this phone), Change photo and Remove photo", blk.hero.startsWith("blob:") && blk.heroDrawn && blk.buttons.join("|") === "Change photo|Remove photo", JSON.stringify(blk));
  check("it says the photo waits for signal", blk.say === "Waiting to send. It goes when there's signal.", blk.say);
  check("the server still has the one before", ((await eventPic()) || {}).url === (ev1 || {}).url);
  await A.look("plan-waiting");
  // Opened again with no signal (the shell from the service worker, the photo from this phone).
  await A.cdp.send("Network.setBypassServiceWorker", { bypass: false }, A.S);
  const swReady = await A.page(`navigator.serviceWorker && navigator.serviceWorker.controller ? 1 : 0`);
  if (swReady) {
    await A.go(`${server.origin}/t/${trip}/?again=1#/e/boat`);
    await A.wait(`(document.querySelector("#photo") || { dataset: {} }).dataset.photoState === "waiting" ? 1 : 0`, "the photo still waiting after opening again", 20000).catch(() => null);
    await drawnFrom(A, "blob:");
    blk = await A.block();
    check("opened again with no signal, the photo still waits and still shows", !!blk && blk.state === "waiting" && blk.hero.startsWith("blob:") && blk.heroDrawn, JSON.stringify(blk));
  } else console.log("  note  (no service worker in control on this phone yet: the reopening with no signal is held in section 9 instead)");
  await A.offline(false);
  const ev2 = await until(async () => { const p = await eventPic(); return p && ev1 && p.url !== ev1.url ? p : null; }, "the waiting photo sent", 60000);
  check("with the signal back it goes by itself: the server has the new one (1600 x 1200)", !!ev2 && ev2.width === 1600 && ev2.height === 1200, JSON.stringify(ev2));
  if (ev2) await A.wait(`(() => { const b = document.getElementById("photo"); const i = document.querySelector(".ag-d-shot img"); return b && b.dataset.photoState === "stored" && i && i.getAttribute("src") === ${JSON.stringify(ev2.url)} ? 1 : 0; })()`, "the page on the sent photo", 30000).catch(() => null);
  blk = await A.block();
  check("and the page shows the sent one with nothing more to say", !!ev2 && blk.hero === ev2.url && !blk.say && blk.state === "stored", JSON.stringify(blk));

  // ── 5 ──────────────────────────────────────────────────────────────────────────────────────
  section("5. a refusal in the server's words: the host's storage full");
  const used = (await ana.get("/api/account/storage")).json.used;
  await server.halt();
  await server.start({ vars: { STORAGE_LIMIT_BYTES: String(used + 4096) } });
  await B.app("/p/lake-hut");
  await B.wait(`document.getElementById("photo") ? 1 : 0`, "the place on the other phone");
  await B.pick(FIX.wide);
  await B.wait(`(document.querySelector("#photo") || { dataset: {} }).dataset.photoState === "refused" ? 1 : 0`, "the photo refused", 30000).catch(() => null);
  blk = await B.block();
  check("the page says \"Not sent:\" and the server's own sentence (the host's space, for someone who isn't the host)",
    /^Not sent: This trip's host has .+ left of .+, and this needs .+\. .*Only the host can free space\.$/.test(blk.say), blk.say);
  check("the refused photo stays on the card, with Change photo and Remove photo", blk.hero.startsWith("blob:") && blk.buttons.join("|") === "Change photo|Remove photo", JSON.stringify(blk));
  check("the server keeps the place's photo as it was", ((await placePic()) || {}).url === (pic1 || {}).url);
  await B.look("place-refused");
  await server.halt();
  await server.start({ vars: { STORAGE_LIMIT_BYTES: "" } });
  await B.tap('#photo [data-photo="remove"]');
  await B.tap('#photo [data-photo="remove"]');
  await B.wait(`(document.querySelector("#photo") || { dataset: {} }).dataset.photoState === "stored" ? 1 : 0`, "the stored one again", 20000).catch(() => null);
  blk = await B.block();
  check("Remove takes the unsent one, and the one on the server shows again", !!pic1 && blk.hero === pic1.url && blk.state === "stored", JSON.stringify(blk));
  check("the server's photo was not touched", ((await placePic()) || {}).url === (pic1 || {}).url);

  // ── 6 ──────────────────────────────────────────────────────────────────────────────────────
  section("6. remove: asked twice, gone from the server and the other phone");
  await A.app("/p/lake-hut");
  await A.wait(`(document.querySelector("#photo") || { dataset: {} }).dataset.photoState === "stored" ? 1 : 0`, "the place's photo");
  await A.tap('#photo [data-photo="remove"]');
  blk = await A.block();
  check("the first tap asks again; nothing is removed yet", blk.buttons.includes("Tap again to remove") && blk.state === "stored", JSON.stringify(blk));
  await A.tap('#photo [data-photo="remove"]');
  const gone = await until(async () => !(await placePic()), "the place's picture gone from the server");
  check("the second tap takes it from the server", !!gone);
  await A.wait(`(document.querySelector("#photo") || { dataset: {} }).dataset.photoState === "none" ? 1 : 0`, "the page without it", 20000).catch(() => null);
  blk = await A.block();
  check("the page offers \"Add a photo\" again, with no hero", blk.buttons.join("|") === "Add a photo" && !blk.hero, JSON.stringify(blk));
  const goneB = await until(async () => !(await B.block()).hero, "the other phone without it", 30000);
  check("the other phone loses it without a reload", !!goneB, JSON.stringify(await B.block()));

  // ── 7 ──────────────────────────────────────────────────────────────────────────────────────
  section("7. the cover, on the trip's page, by a link");
  await A.go(`${server.origin}/trips/${trip}?photo=add#cover`);
  await A.wait(`document.getElementById("photo") && !document.getElementById("page").hidden ? 1 : 0`, "the trip's page with its cover");
  await sleep(400);
  blk = await A.block();
  check("the link's words say what to do, the button has the focus, in view", blk.say === "Pick the trip's cover: tap Add a photo." && blk.focused && blk.inView && blk.buttons.join("|") === "Add a photo", JSON.stringify(blk));
  await A.look("cover-link");
  await A.pick(FIX.wide);
  const listCover = async () => (((await ben.get("/api/trips")).json.trips || []).find((t) => t.id === trip) || {}).cover || null;
  const cover = await until(listCover, "the cover on the server");
  check("the cover reached the server, the person's own", !!cover && String(cover.url).startsWith("/media/"), JSON.stringify(cover));
  await A.wait(`(document.querySelector("#photo") || { dataset: {} }).dataset.photoState === "stored" ? 1 : 0`, "the page on the stored cover", 30000).catch(() => null);
  await drawnFrom(A, "/media/");
  blk = await A.block();
  check("the page shows the cover with Change photo and Remove", !!cover && blk.hero === cover.url && blk.heroDrawn && blk.buttons.join("|") === "Change photo|Remove", JSON.stringify(blk));
  await A.look("cover-stored");
  await B.go(`${server.origin}/trips`);
  await B.wait(`document.querySelector(".tr-trip") ? 1 : 0`, "Your trips on the other phone");
  const row = await until(async () => (await B.page(`(document.querySelector(".tr-trip img.tr-cover") || { src: "" }).src`)) || null, "the cover on Your trips", 15000);
  check("the other person's Your trips shows it", !!cover && !!row && row.endsWith(cover.url), String(row));

  // ── 8 ──────────────────────────────────────────────────────────────────────────────────────
  section("8. a link into the app, to a card's \"Add a photo\"");
  for (const [hash, noun, sel] of [["/p/lake-hut?photo=add", "place", ".pl-page"], ["/e/boat?photo=add", "plan", ".ag-detail"]]) {
    await A.app(hash);
    await A.wait(`document.querySelector(${JSON.stringify(sel)}) && document.getElementById("photo") ? 1 : 0`, `the ${noun} by its link`);
    await sleep(500);
    blk = await A.block();
    check(`#${hash}: the ${noun}'s photo buttons in view, the first focused, the words saying what to do, nothing taken`,
      blk.inView && blk.focused && new RegExp(`^Pick the photo for this ${noun}: tap (Add a photo|Change photo)\\.$`).test(blk.say) && blk.state !== "waiting", JSON.stringify(blk));
  }
  const C = await phoneOf(null);
  for (const [url, keep] of [[`${server.origin}/t/${trip}/#/p/lake-hut?photo=add`, "#/p/lake-hut?photo=add"], [`${server.origin}/trips/${trip}?photo=add#cover`, `/trips/${trip}?photo=add#cover`]]) {
    await C.go(url);
    await C.wait(`location.pathname === "/login" ? 1 : 0`, "the sign-in page", 20000).catch(() => null);
    // Where the page goes once signed in: the server's redirect never sees the #, the page keeps it.
    const next = await C.page(`import("/js/auth.js").then((m) => m.nextPath())`);
    check(`signed out, the sign-in page keeps the whole address to come back to (${keep})`, next.endsWith(keep), next);
  }

  // ── 9 ──────────────────────────────────────────────────────────────────────────────────────
  section("9. kept for no signal on the other phone");
  await B.cdp.send("Network.setBypassServiceWorker", { bypass: false }, B.S);
  await B.cdp.send("Network.setCacheDisabled", { cacheDisabled: false }, B.S);
  await B.app("/e/boat");
  await B.wait(`navigator.serviceWorker && navigator.serviceWorker.controller ? 1 : 0`, "the service worker in control", 45000).catch(() => null);
  await B.app("/e/boat");
  const key = ev2 ? ev2.url.slice("/media/".length) : "";
  const kept = await until(async () => (await B.page(`(async () => { try { return (await caches.match(${JSON.stringify(ev2 ? ev2.url : "/none")})) ? 1 : 0; } catch { return 0; } })()`)) === 1, "the plan's photo kept", 30000);
  check("the plan's photo is kept on the other phone", !!kept && !!key, key);
  // No signal on the page ALREADY OPEN (no navigation: CDP lifts its offline as a page starts to
  // leave): the page itself says it is offline, a request only the network can answer fails, and
  // the plan's photo still comes, past the browser's own cache (no-store), from the copy the
  // phone keeps. Proven where the photo is shown, not on a page opened after.
  await B.offline(true);
  await sleep(300);
  const off = JSON.parse(await B.page(`(async () => {
    const fetched = async (url) => { try { const r = await fetch(url, { cache: "no-store", credentials: "same-origin" }); const b = r.ok ? (await r.arrayBuffer()).byteLength : 0; return { status: r.status, bytes: b }; } catch (e) { return { failed: String(e && e.name || e) }; } };
    return JSON.stringify({ onLine: navigator.onLine, controlled: !!navigator.serviceWorker.controller, network: await fetched("/api/me"), photo: await fetched(${JSON.stringify(ev2 ? ev2.url : "/none")}) }); })()`));
  check("with no signal, on the page already open: the page is offline (onLine false, the network's own answer fails)", off.onLine === false && !!off.network.failed && off.controlled, JSON.stringify(off));
  check("… and the plan's photo still comes from the copy the phone keeps (no-store)", !!ev2 && off.photo.status === 200 && off.photo.bytes === ev2.bytes, JSON.stringify(off.photo));
  await B.offline(false);

  // ── 10 ─────────────────────────────────────────────────────────────────────────────────────
  section("10. page errors");
  for (const [n, p] of [["the first phone", A], ["the other phone", B]]) check(`no page error on ${n}`, p.b.pageErrors.length === 0, p.b.pageErrors.join(" | ").slice(0, 400));
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  for (const b of phones) await b.done().catch(() => {});
  await server.stop().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

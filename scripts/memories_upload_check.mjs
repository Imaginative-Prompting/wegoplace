#!/usr/bin/env node
/* A memory, put up and brought back down as a person does it: a real photograph and a real
 * video through the composer's own file input, on a server of its own, two made-up people
 * with a browser each.
 *
 *   node scripts/memories_upload_check.mjs [--big]
 *   <the queue> -- node scripts/memories_upload_check.mjs
 *
 * What it holds:
 *   1. THE SECTION: Memories mounts with nothing thrown, says it is empty, and its + is in the
 *      router's fixed layer.
 *   2. THE UPLOAD: a camera-size JPEG and an H.264 video go up through the composer. The video
 *      goes in 8 MiB parts (not one body), every part is accepted, a thumbnail is made in the
 *      browser for each, and the job says a label while it works.
 *   3. THE OTHER PERSON'S PHONE, from cold: the card is there with its caption, its tag, who
 *      put it up, a duration on the video, both thumbnails decoded and no original fetched;
 *      no delete for somebody else's memory. The server holds the exact byte counts, the
 *      decoded sizes, the duration and the file names.
 *   4. THE VIEWER: a modal over an inert page; the video is the ORIGINAL, plays (muted) and
 *      scrubs, and the server answered with real ranges.
 *   5. THE PROMISE: what "Save" hands to the share sheet is byte for byte what went up
 *      (sha256), in one sheet.
 *   6. WHO MAY: the other person can't delete it (403); nobody signed out reads the feed or a
 *      file (401); a card somebody else deletes leaves this phone's kept feed.
 *   7. A PART DROPPED ON THE WIRE parks the job as "Waiting for signal" with what it had sent,
 *      and when the signal is back only that part is sent again; the stored file has the
 *      source's hash.
 *   8. DELETE asks with the count and the size, frees the bytes off the meter, and the file
 *      is gone, not only its row.
 *   9. A SIX-ITEM MEMORY shows four cells and "+2"; the filter row and the composer offer the
 *      tags another person made.
 *
 * The fixtures are made here by ffmpeg (a test pattern: no photograph of anybody's), once,
 * and kept in WGP_FIXTURES (default: a folder in the temp directory). The video is about
 * 20 MiB (three parts); --big makes it over 120 MiB (seventeen parts) for the long road.
 * Nothing is played aloud: the video is muted before it plays.
 *
 * PLANTED (red here when put in public/js/memories.js by hand): a dropped part starting the file over
 * from part 1 ("only the dropped part was sent again" fails: 6 part requests for a 3-part video).
 *
 * Off the gate: it needs ffmpeg and takes a few minutes of uploads. The server and its
 * database are this run's own and are thrown away with it.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import { pickPhotos, cdpPage, madePhoto } from "./lib/photo_picker.mjs";

const BIG = process.argv.includes("--big");
const FIXDIR = process.env.WGP_FIXTURES || path.join(os.tmpdir(), "wgp-upload-fixtures");
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PART = 8 * 1024 * 1024;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// ── the fixtures: real files, made here ────────────────────────────────────────────────────
// A real H.264 MP4, so the poster frame, the <video> element and the scrub are genuine; a real
// baseline JPEG at a camera's size, so createImageBitmap and the canvas thumbnail are genuine.
const VIDEO = BIG ? { name: "clip-long.mp4", seconds: 29, rate: "44M", max: "60M", least: 120 * 1024 * 1024 }
  : { name: "clip.mp4", seconds: 12, rate: "14M", max: "20M", least: 2 * PART + 1 };
const PHOTO = { name: "frame.jpg", w: 4032, h: 2678 };
function fixtures() {
  fs.mkdirSync(FIXDIR, { recursive: true });
  const ffmpeg = (args, what) => {
    try { execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "inherit"] }); }
    catch (e) { throw new Error(`ffmpeg could not make ${what} (${e.code === "ENOENT" ? "ffmpeg is not installed" : e.message}). This check needs ffmpeg.`); }
  };
  const video = path.join(FIXDIR, VIDEO.name), photo = path.join(FIXDIR, PHOTO.name);
  if (!fs.existsSync(video) || fs.statSync(video).size < VIDEO.least) {
    console.log(`  (making the video once: ${VIDEO.seconds} s of a test pattern, kept in ${FIXDIR})`);
    ffmpeg(["-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=30:duration=${VIDEO.seconds}`, "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv420p", "-b:v", VIDEO.rate, "-maxrate", VIDEO.max, "-bufsize", VIDEO.max, "-movflags", "+faststart", video], "the video");
  }
  if (!fs.existsSync(photo)) {
    ffmpeg(["-f", "lavfi", "-i", `testsrc2=size=${PHOTO.w}x${PHOTO.h}:rate=1`, "-frames:v", "1", "-q:v", "3", photo], "the photograph");
  }
  const v = fs.readFileSync(video), p = fs.readFileSync(photo);
  return {
    video: { path: video, name: VIDEO.name, bytes: v.length, sha: sha256(v), parts: Math.ceil(v.length / PART) },
    photo: { path: photo, name: PHOTO.name, bytes: p.length, sha: sha256(p), buf: p },
  };
}

const FIX = fixtures();
console.log(`  the photograph: ${FIX.photo.bytes} bytes; the video: ${(FIX.video.bytes / 1048576).toFixed(1)} MiB, ${FIX.video.parts} parts`);

const server = await startServer({ name: "upload", port: await freeLoopbackPort() });
ownServer(server.origin);

const phones = [];
try {
  await server.start();
  const first = new Person(server.origin, "Ines Marlow"), other = new Person(server.origin, "Kofi Brandt");
  await first.signUp(); await other.signUp();
  const made = await first.post("/api/trips", { name: "Lake week", default_tz: "Europe/Lisbon" });
  const trip = made.json.trip.id, T = `/api/trips/${trip}`;
  const link = await first.post(`${T}/links`, {});
  const joined = await other.post(`/api/join/${link.json.link.code}`);
  check("two people on a trip with no memories", made.status === 201 && joined.status < 300, `${made.status} ${joined.status}`);
  const feedOf = async (who) => (await who.get(`${T}/memories`)).json.memories;
  // The host's meter: what the trips they host hold, and how many files this one has.
  const meterOf = async (who) => { const m = (await who.get("/api/account/storage")).json; return { used: m.used, files: (m.trips.find((t) => t.id === trip) || { files: 0 }).files }; };

  const { boot, evalIn, waitFor, appSettled, sleep } = await import("./lib/standalone_cdp.mjs");

  // A phone: one browser, signed in as one person, with every request it makes written down.
  async function phoneOf(person) {
    const b = await boot({ vw: 390, vh: 844, dsf: 1 });
    phones.push(b);
    const { cdp, S } = b;
    for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: server.origin }, S);
    await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: person.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
    const who = person.jar.cookies.get("wgp_who");
    if (who) await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: who, sameSite: "Lax" }, S);
    await cdp.send("DOM.enable", {}, S);
    const net = [];                          // { url, path, method, status }
    const errors = [];
    const kill = { n: 0, fired: false };     // the part to drop on the wire, once
    cdp.on(async (m) => {
      if (m.sessionId !== S) return;
      if (m.method === "Network.requestWillBeSent") {
        const u = new URL(m.params.request.url);
        net.push({ id: m.params.requestId, url: m.params.request.url, path: u.pathname, search: u.search, method: m.params.request.method, status: 0 });
      } else if (m.method === "Network.responseReceived") {
        const e = net.find((x) => x.id === m.params.requestId);
        if (e) e.status = m.params.response.status;
      } else if (m.method === "Runtime.exceptionThrown") {
        errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || "exception");
      } else if (m.method === "Fetch.requestPaused") {
        const { requestId, request } = m.params;
        try {
          if (kill.n && !kill.fired && Number(new URL(request.url).searchParams.get("n")) === kill.n) {
            kill.fired = true;
            await cdp.send("Fetch.failRequest", { requestId, errorReason: "ConnectionAborted" }, S);
            return;
          }
          await cdp.send("Fetch.continueRequest", { requestId }, S);
        } catch { /* the page went away */ }
      }
    });
    const page = (expr) => evalIn(cdp, S, expr);
    const wait = (expr, label, timeout) => waitFor(cdp, S, expr, { label, ...(timeout ? { timeout } : {}) });
    let nav = 0;
    return {
      b, cdp, S, page, wait, net, errors, kill,
      // A fresh document every time: the feed is read again, never the last page's copy.
      async memories() {
        await cdp.send("Page.navigate", { url: `${server.origin}/t/${trip}/?n=${++nav}#/memories` }, S);
        await sleep(300);
        await appSettled(cdp, S);
        await wait(`document.querySelector("#view .me-feed") ? 1 : 0`, "the Memories feed", 45000);
        await sleep(300);
      },
      // The composer's own file input, given real files.
      async pick(files, label) {
        await pickPhotos({ ...cdpPage(cdp, S), files: files });   // Add photos: the phone's picker first, then the sheet
        await wait(`document.querySelectorAll(".me-pickrow").length === ${files.length} ? 1 : 0`, `${files.length} file(s) picked (${label})`);
      },
      partPosts: () => net.filter((r) => r.method === "POST" && r.path === `${T}/media/part`),
      look: async (name) => { if (SHOTS) await b.shot(path.join(SHOTS, `upload-${name}.png`)); },
    };
  }

  const A = await phoneOf(first);

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────────
  section("1. the section");
  await A.memories();
  check("Memories mounts and nothing is thrown", A.errors.length === 0, A.errors.join(" | "));
  const empty = await A.page(`(document.querySelector("#view .empty") || { textContent: "" }).textContent.replace(/\\s+/g, " ").trim()`);
  check("the empty feed says so", empty.length > 0, empty);
  check("the + is in the router's fixed layer, not in the scroller", await A.page(`!!document.querySelector(".me-fab") && !document.querySelector("#view .me-fab")`));
  await A.look("empty");

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────────
  section(`2. the upload: a ${PHOTO.w}×${PHOTO.h} JPEG and a ${(FIX.video.bytes / 1048576).toFixed(0)} MiB video`);
  await A.pick([FIX.photo.path, FIX.video.path], "first");
  const accept = await A.page(`document.querySelector("input.me-file").accept`);
  check("the file input names HEIC, HEIF, QuickTime and MP4 outright", ["image/heic", "image/heif", "video/quicktime", "video/mp4"].every((t) => accept.includes(t)), accept);
  await A.page(`(() => { const i = document.querySelector("#me-cap-in"); i.value = "First light on the water"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await A.page(`(() => { const i = document.querySelector(".me-tagin"); i.value = "Lake Shore"; i.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector(".me-tagadd").click(); return 1; })()`);
  await A.look("composer");
  await A.page(`(document.querySelector(".me-go").click(), 1)`);
  await A.wait(`document.querySelectorAll(".me-job").length > 0 || document.querySelectorAll(".me-card").length > 0 ? 1 : 0`, "a job appears");
  const jobLabel = await A.page(`(document.querySelector(".me-jobstate") || { textContent: "" }).textContent`);
  check("the job in flight is a label, not a sentence", jobLabel === "" || /^(Uploading|Finishing|Waiting for signal)$/.test(jobLabel), jobLabel || "(already done)");
  const jobEnd = await waitFor(A.cdp, A.S,
    `document.querySelectorAll('.me-job[data-state="failed"]').length ? "failed" : (document.querySelectorAll(".me-job").length === 0 && document.querySelectorAll(".me-card").length === 1 ? "done" : null)`,
    { timeout: BIG ? 900000 : 300000, every: 1000, label: "the upload ends" });
  check("the upload went through the app's own road in parts", jobEnd === "done", jobEnd);
  const parts = A.partPosts();
  check("the video went up in 8 MiB parts, not one body", parts.length === FIX.video.parts + 1, `${parts.length} part requests (${FIX.video.parts} for the video, 1 for the photograph)`);
  check("every part was accepted", parts.every((p) => p.status === 200), parts.map((p) => p.status).join(","));
  check("a thumbnail was made in the browser for each", A.net.filter((r) => r.path === `${T}/media/thumb`).length === 2, String(A.net.filter((r) => r.path === `${T}/media/thumb`).length));
  await A.look("uploaded");

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────────
  section("3. the other person's phone, from cold");
  const B = await phoneOf(other);
  await B.memories();
  await B.wait(`document.querySelectorAll(".me-card").length === 1 ? 1 : 0`, "the card on the other phone");
  await B.wait(`[...document.querySelectorAll(".me-card .me-cell img")].every((i) => i.complete) ? 1 : 0`, "its thumbnails", 30000);
  const card = JSON.parse(await B.page(`JSON.stringify((() => { const c = document.querySelector(".me-card"); const text = (s) => (c.querySelector(s) || { textContent: "" }).textContent.trim();
    return { id: c.dataset.id, cells: c.querySelectorAll(".me-cell").length, caption: text(".me-cap"), who: text(".me-who"), initials: text(".me-ava"),
      tags: [...c.querySelectorAll(".me-tag")].map((t) => t.textContent.trim()), del: !!c.querySelector(".me-del"), save: !!c.querySelector(".me-saveall"), dur: text(".me-dur"),
      thumbs: [...c.querySelectorAll(".me-cell img")].map((i) => i.naturalWidth > 0) }; })())`));
  check("both items are in the card, with the caption", card.cells === 2 && card.caption === "First light on the water", JSON.stringify(card));
  check("it names who put it up, not who is looking", /Ines/.test(card.who) && card.initials.length > 0, `${card.who} / ${card.initials}`);
  check("the tag is on it", card.tags.some((t) => t.toLowerCase() === "lake shore"), JSON.stringify(card.tags));
  check("somebody else's memory has no delete, and has Save", card.del === false && card.save === true, JSON.stringify({ del: card.del, save: card.save }));
  check("the video's cell carries its length", /\d+:\d\d/.test(card.dur), card.dur);
  check("the feed drew from thumbnails, both decoded", card.thumbs.length === 2 && card.thumbs.every(Boolean), JSON.stringify(card.thumbs));
  check("the feed fetched no original", !B.net.some((r) => r.path.startsWith("/media/o/")), B.net.filter((r) => r.path.startsWith("/media/")).map((r) => r.path.slice(0, 16)).join(","));
  const mem = (await feedOf(other))[0];
  const vRow = mem.media.find((m) => m.kind === "video"), pRow = mem.media.find((m) => m.kind === "photo");
  check("the server holds the exact byte counts", vRow.bytes === FIX.video.bytes && pRow.bytes === FIX.photo.bytes, `${vRow.bytes} / ${pRow.bytes}`);
  check("the sizes the browser decoded reached the rows", pRow.width === PHOTO.w && pRow.height === PHOTO.h && vRow.width === 1920 && vRow.height === 1080, `${pRow.width}x${pRow.height}, ${vRow.width}x${vRow.height}`);
  check("the video's length reached its row", Math.abs(vRow.duration_s - VIDEO.seconds) < 1.5, String(vRow.duration_s));
  check("the file names are as they were", vRow.orig_name === FIX.video.name && pRow.orig_name === FIX.photo.name, `${vRow.orig_name}, ${pRow.orig_name}`);
  check("the other phone is the other person", (await B.page(`import("/js/store.js").then((m) => m.store.me().id)`)) === other.user.id);
  await B.look("other-phone");

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────────
  section("4. the viewer: the original plays and scrubs");
  await B.page(`(document.querySelectorAll(".me-cell")[0].click(), 1)`);
  await B.wait(`document.querySelector(".me-view") ? 1 : 0`, "the viewer");
  const open = JSON.parse(await B.page(`JSON.stringify((() => { const v = document.querySelector(".me-view");
    return { scrim: !!v.querySelector(".me-vscrim"), items: v.querySelectorAll(".me-vitem").length, modal: v.getAttribute("aria-modal"),
      inert: document.getElementById("view").hasAttribute("inert") && document.querySelector(".tabbar").hasAttribute("inert") }; })())`));
  check("the viewer is a modal over a scrim, the page and the tab bar inert, every item a slide", open.scrim && open.modal === "true" && open.inert && open.items === 2, JSON.stringify(open));
  const vIdx = mem.media.findIndex((m) => m.kind === "video");
  await B.page(`(() => { const track = document.querySelector(".me-vtrack"); track.scrollTo({ left: track.children[${vIdx}].offsetLeft, behavior: "instant" }); track.dispatchEvent(new Event("scroll")); return 1; })()`);
  await sleep(1500);
  const vstate = JSON.parse(await waitFor(B.cdp, B.S, `(() => { const v = document.querySelector(".me-view video");
    return v && (v.currentSrc || v.src) ? JSON.stringify({ src: v.currentSrc || v.src, controls: v.controls, inline: v.playsInline, poster: !!v.poster, count: (document.querySelector(".me-vcount") || { textContent: "" }).textContent }) : null; })()`,
    { timeout: 30000, label: "the video in the viewer, with its original" }));
  check("the video's slide has the thumbnail as its poster and the browser's own controls, inline", vstate.poster && vstate.controls && vstate.inline, JSON.stringify(vstate));
  check("the video is the ORIGINAL, not the thumbnail", new URL(vstate.src).pathname.startsWith("/media/o/"), vstate.src);
  await B.look("viewer");
  // Muted before it plays: nothing is heard.
  const played = JSON.parse(await B.page(`(async () => { const v = document.querySelector(".me-view video"); v.muted = true; v.volume = 0;
    try { await v.play(); } catch (e) { return JSON.stringify({ err: String(e) }); }
    await new Promise((r) => setTimeout(r, 1500));
    return JSON.stringify({ t: v.currentTime, w: v.videoWidth, muted: v.muted }); })()`));
  check("the video decodes and plays (muted)", played.t > 0.1 && played.w === 1920 && played.muted === true, JSON.stringify(played));
  const to = Math.round(VIDEO.seconds * 0.8);
  const scrubbed = JSON.parse(await B.page(`(async () => { const v = document.querySelector(".me-view video"); v.currentTime = ${to};
    await new Promise((r) => { const d = setTimeout(r, 15000); v.addEventListener("seeked", () => { clearTimeout(d); r(); }, { once: true }); });
    await new Promise((r) => setTimeout(r, 600)); v.pause();
    return JSON.stringify({ t: v.currentTime, ready: v.readyState }); })()`));
  check(`scrubbing to ${to} s lands there`, scrubbed.t > to - 1 && scrubbed.ready >= 2, JSON.stringify(scrubbed));
  const ranges = B.net.filter((r) => r.status === 206 && r.path.startsWith("/media/o/"));
  check("the server answered the original with real ranges (206)", ranges.length > 0, `${ranges.length} × 206`);
  await B.page(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
  await sleep(600);
  check("Escape closes the viewer and the page is no longer inert", await B.page(`!document.querySelector(".me-view") && !document.getElementById("view").hasAttribute("inert")`));

  // ── 5 ──────────────────────────────────────────────────────────────────────────────────────
  section("5. the promise: what Save hands over is what went up, byte for byte");
  const saved = JSON.parse(await B.page(`(async () => {
    const mod = await import("/js/memories-save.js");
    const items = ${JSON.stringify(mem.media)};
    const files = [];
    const share = navigator.share, can = navigator.canShare;
    navigator.canShare = () => true;
    navigator.share = async (d) => { files.push(...(d.files || [])); };
    const s = mod.createSaveSession(items);
    let guard = 0;
    while (!s.done && guard++ < 10) await s.saveNext();
    navigator.share = share; navigator.canShare = can;
    const out = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((x) => x.toString(16).padStart(2, "0")).join("");
      out.push({ name: f.name, type: f.type, bytes: buf.byteLength, sha: h });
    }
    return JSON.stringify({ sheets: s.plan.batchCount, files: out, budget: mod.SHARE_BATCH_BYTES });
  })()`));
  const got = {};
  for (const f of saved.files) got[f.type.startsWith("video") ? "video" : "photo"] = f;
  check("Save handed over both files", saved.files.length === 2, JSON.stringify(saved.files.map((f) => [f.name, f.bytes])));
  check("the video is byte for byte the one that went up (sha256)", !!got.video && got.video.sha === FIX.video.sha && got.video.bytes === FIX.video.bytes, `${got.video && got.video.sha.slice(0, 16)} / ${FIX.video.sha.slice(0, 16)}`);
  check("the photograph is byte for byte the one that went up (sha256)", !!got.photo && got.photo.sha === FIX.photo.sha && got.photo.bytes === FIX.photo.bytes, `${got.photo && got.photo.sha.slice(0, 16)} / ${FIX.photo.sha.slice(0, 16)}`);
  check("both fit one share sheet (the budget is 350 MB)", saved.sheets === 1 && saved.budget === 350 * 1024 * 1024, `${saved.sheets} sheet(s), budget ${saved.budget}`);

  // ── 6 ──────────────────────────────────────────────────────────────────────────────────────
  section("6. who may");
  const otherDelete = await B.page(`fetch(${JSON.stringify(`${T}/memories/${mem.id}`)}, { method: "DELETE" }).then((r) => r.status)`);
  check("the other person can't delete it from their browser (403)", otherDelete === 403, String(otherDelete));
  const nobody = new Person(server.origin, "Nobody Signed In");
  const anonFeed = await nobody.get(`${T}/memories`), anonFile = await nobody.call("HEAD", `/media/${vRow.key}`);
  check("signed out, the feed and a file are 401", anonFeed.status === 401 && anonFile.status === 401, `${anonFeed.status} ${anonFile.status}`);
  // A memory somebody else deletes leaves this phone's kept feed too.
  const ghostId = `mem_${crypto.randomUUID()}`;
  const ghost = await first.post(`${T}/memories`, { id: ghostId, caption: "Here and gone", tags: [], media: [] });
  await B.memories();
  await B.wait(`document.querySelector('.me-card[data-id="${ghostId}"]') ? 1 : 0`, "the new card arrives on the other phone", 30000);
  const unghost = await first.call("DELETE", `${T}/memories/${ghostId}`);
  await B.memories();
  await sleep(3000);
  check("a card its author deleted is gone from the other phone's feed", ghost.status === 201 && unghost.status < 300 && !(await B.page(`!!document.querySelector('.me-card[data-id="${ghostId}"]')`)), `${ghost.status} ${unghost.status}`);

  // ── 7 ──────────────────────────────────────────────────────────────────────────────────────
  section("7. a part dropped on the wire");
  await A.memories();
  await A.cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*${T}/media/part*`, requestStage: "Request" }] }, A.S);
  const dropAt = Math.min(3, FIX.video.parts);
  A.kill.n = dropAt; A.kill.fired = false;
  const partsBefore = A.partPosts().length;
  const cardsBefore = await A.page(`document.querySelectorAll(".me-card").length`);
  await A.pick([FIX.video.path], "second");
  await A.page(`(document.querySelector(".me-go").click(), 1)`);
  const parked = await waitFor(A.cdp, A.S, `document.querySelector('.me-job[data-state="waiting"]') ? document.querySelector(".me-jobstate").textContent : null`,
    { timeout: 180000, every: 250, label: "the job parks after the dropped part" });
  check(`part ${dropAt} was dropped on the wire, and the job says "Waiting for signal" (not a failure)`, A.kill.fired === true && parked === "Waiting for signal", parked);
  const atPark = Number(await A.page(`(document.querySelector(".me-bar") || { getAttribute: () => 0 }).getAttribute("aria-valuenow") || 0`));
  check("the parked job kept what it had sent", atPark >= 10, `${atPark}%`);
  await A.look("parked");
  await A.page(`(window.dispatchEvent(new Event("online")), 1)`);
  await waitFor(A.cdp, A.S, `document.querySelectorAll(".me-job").length === 0 && document.querySelectorAll(".me-card").length > ${cardsBefore} ? 1 : null`,
    { timeout: BIG ? 900000 : 300000, every: 1000, label: "the upload ends after the signal is back" });
  A.kill.n = 0;
  await A.cdp.send("Fetch.disable", {}, A.S);
  const sentThisRound = A.partPosts().length - partsBefore;
  check("only the dropped part was sent again, not the whole video", sentThisRound === FIX.video.parts + 1, `${sentThisRound} part requests for a ${FIX.video.parts}-part video (1 of them the dropped one, sent again)`);
  const resumed = (await feedOf(first)).find((m) => m.id !== mem.id && m.media.length === 1);
  const down = await fetch(`${server.origin}/media/${resumed.media[0].key}`, { headers: { Cookie: first.jar.header() } });
  const whole = Buffer.from(await down.arrayBuffer());
  check("the stored file is whole", resumed.media[0].bytes === FIX.video.bytes && down.status === 200 && whole.length === FIX.video.bytes, `${resumed.media[0].bytes} in its row, ${whole.length} down, ${down.status}`);
  check("and it comes back down with the source's hash", sha256(whole) === FIX.video.sha, `${sha256(whole).slice(0, 16)} / ${FIX.video.sha.slice(0, 16)}`);

  // ── 8 ──────────────────────────────────────────────────────────────────────────────────────
  section("8. delete");
  const before = await meterOf(first);
  const nCards = await A.page(`document.querySelectorAll(".me-card").length`);
  await A.page(`(document.querySelector('.me-card[data-id="${resumed.id}"] .me-del').click(), 1)`);
  await A.wait(`document.querySelector(".sh-root .me-dokill") ? 1 : 0`, "the delete question");
  const asks = await A.page(`(document.querySelector(".sh-root .sh-body") || { textContent: "" }).textContent.replace(/\\s+/g, " ").trim()`);
  check("the question names what goes, in photos and videos, and how big", /\d+ (photos?|videos?)( and \d+ videos?)? · [\d.]+ \w+/.test(asks) && !/\bitems?\b/.test(asks), asks.slice(0, 160));
  await A.look("delete-question");
  await A.page(`(document.querySelector(".sh-root .me-dokill").click(), 1)`);
  await A.wait(`document.querySelectorAll(".me-card").length === ${nCards - 1} ? 1 : 0`, "the card leaves the feed", 30000);
  const after = await meterOf(first);
  // The video and its thumbnail both leave: the meter falls by the video's bytes and a thumbnail's.
  const freed = before.used - after.used;
  check("delete took the video and its thumbnail off the host's meter", freed >= FIX.video.bytes && freed < FIX.video.bytes + 1024 * 1024 && after.files === before.files - 2,
    `${before.used} → ${after.used} (${freed - FIX.video.bytes} bytes of thumbnail), files ${before.files} → ${after.files}`);
  const gone = await first.call("HEAD", `/media/${resumed.media[0].key}`);
  const goneThumb = await first.call("HEAD", `/media/${resumed.media[0].thumb_key}`);
  check("the file and its thumbnail are gone, not only their rows", gone.status === 404 && goneThumb.status === 404, `${gone.status} ${goneThumb.status}`);

  // ── 9 ──────────────────────────────────────────────────────────────────────────────────────
  section("9. a six-item memory, and the tags somebody else made");
  async function small(name) {
    const begun = (await first.post(`${T}/media/begin`, { name, mime: "image/jpeg", bytes: FIX.photo.bytes, kind: "photo" })).json;
    const sent = [];
    for (let n = 1; n <= begun.parts; n++) {
      const r = await first.call("POST", `${T}/media/part?key=${encodeURIComponent(begun.key)}&id=${encodeURIComponent(begun.uploadId)}&n=${n}`,
        FIX.photo.buf.subarray((n - 1) * begun.part_size, Math.min(FIX.photo.bytes, n * begun.part_size)), { headers: { "Content-Type": "application/octet-stream" } });
      sent.push({ n, etag: r.json.etag });
    }
    await first.post(`${T}/media/finish`, { key: begun.key, id: begun.uploadId, parts: sent });
    return begun.key;
  }
  const six = [];
  for (let i = 1; i <= 6; i++) six.push({ key: await small(`six-${i}.jpg`), kind: "photo", w: PHOTO.w, h: PHOTO.h });
  const bigId = `mem_${crypto.randomUUID()}`, soloId = `mem_${crypto.randomUUID()}`;
  const big = await first.post(`${T}/memories`, { id: bigId, caption: "Six frames", tags: ["Walk", "day 2"], media: six });
  const solo = await first.post(`${T}/memories`, { id: soloId, caption: "No tag", tags: [], media: [] });
  check("a six-item memory is made in one request", big.status === 201 && solo.status === 201, `${big.status} ${solo.status} ${big.text.slice(0, 200)}`);
  await B.memories();
  await B.wait(`document.querySelector('.me-card[data-id="${bigId}"] .me-cell') ? 1 : 0`, "the six-item card", 45000);
  const grid = JSON.parse(await B.page(`JSON.stringify((() => { const c = document.querySelector('.me-card[data-id="${bigId}"]');
    return { cells: c.querySelectorAll(".me-cell").length, n: c.querySelector(".me-grid").dataset.n, extra: (c.querySelector(".me-extra") || { textContent: "" }).textContent }; })())`));
  check('more than four items show four cells and "+2"', grid.cells === 4 && grid.extra === "+2" && grid.n === "5", JSON.stringify(grid));
  const chips = JSON.parse(await B.page(`JSON.stringify([...document.querySelectorAll(".me-tags .chip")].map((c) => c.dataset.tag))`));
  check("the filter row offers the tags the other person made", chips.includes("walk") && chips.includes("day 2"), JSON.stringify(chips));
  await B.page(`([...document.querySelectorAll(".me-tags .chip")].find((c) => c.dataset.tag === "walk").click(), 1)`);
  await sleep(700);
  const filtered = JSON.parse(await B.page(`JSON.stringify([...document.querySelectorAll(".me-card")].map((c) => c.dataset.id))`));
  check("a chip shows the memories with that tag, and every chip stays", filtered.includes(bigId) && !filtered.includes(soloId)
    && (await B.page(`document.querySelectorAll(".me-tags .chip").length`)) === chips.length, JSON.stringify(filtered));
  await B.look("filtered");
  await B.page(`([...document.querySelectorAll(".me-tags .chip")].find((c) => c.dataset.tag === "walk").click(), 1)`);
  await sleep(500);
  // Add photos: the phone's picker first, answered with a made-up photo, then its sheet with the tags.
  await pickPhotos({ ...cdpPage(B.cdp, B.S), files: [madePhoto()] });
  await B.wait(`document.querySelector(".me-tagpick .chip") ? 1 : 0`, "the composer's tags");
  const offered = JSON.parse(await B.page(`JSON.stringify([...document.querySelectorAll(".me-tagpick .chip")].map((c) => c.dataset.tag))`));
  check("the composer offers those tags before anything is typed", offered.includes("walk") && offered.includes("day 2"), JSON.stringify(offered));

  section("nothing was thrown on either phone");
  check("no page error on either phone", A.errors.length === 0 && B.errors.length === 0, [...A.errors, ...B.errors].join(" | "));
} catch (e) {
  check("the check ran to its end", false, e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n    ") : String(e));
} finally {
  for (const b of phones) await b.done().catch(() => {});
  await server.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(fail ? 1 : 0);

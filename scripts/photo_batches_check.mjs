#!/usr/bin/env node
/* A big pick of photos goes in (public/js/memories.js partsOf, startUpload, hardFail, discardJob;
 * shared/limits.js MEMORY_MEDIA_MAX): on a server of its own, one made-up person with a phone at
 * 440x956, standalone.
 *
 *   node scripts/photo_batches_check.mjs
 *   <the queue> -- node scripts/photo_batches_check.mjs
 *
 * What it holds:
 *   1. A HUNDRED AT ONCE: 100 files picked together (photos of several sizes, ten of 3-5 MB, four
 *      HEIC Chrome can't draw, two short videos) go in as three posts of 34, 33 and 33, in the order
 *      picked, posted in that order, each with the caption and the tag. Each post is on its own
 *      photos' day and earliest time; one whose photos say no time is on the pick's day, without
 *      one. Every file is attached, each was begun once (POST media/begin), no stored file is left
 *      unattached, a HEIC still uploads (with no thumbnail), and no card ever says "Rejected (".
 *      The cards say "Post n of 3", how many of how many are sent, and the bytes.
 *   2. A REFUSAL IN WORDS: 41 files are two posts (21, 20). The first post is answered 413 with the
 *      server's reason (CDP Fetch.fulfillRequest): its card shows that reason, and the second post
 *      goes in all the same. Retried and refused with no reason at all, the card says plain words
 *      and no number. Discard: its files and thumbnails leave the server (the unattached count
 *      goes back to what it was, by the keys this post made).
 *   3. A DISCARD WITHOUT SIGNAL: refused, then discarded while every DELETE fails: the files stay
 *      listed on the phone (localStorage) through an "online" that still fails; with signal back
 *      and the app opened again, they leave the server.
 *   4. THE APP CLOSED MID-UPLOAD (a phone puts a Home Screen app away and starts it again): six photos uploaded, the
 *      post held unanswered, the page loaded again. Memories opened again removes the files of that job, which no
 *      page runs any more (Web Locks): nothing is left unattached.
 *   5. THE WORDS: the composer says "Upload all 100" for photos and videos together (the full words its name), "Upload
 *      41 photos" for one kind; the delete prompt says "32 photos and 1 video · <size>"; the viewer says when a post
 *      happened as its card does, with its day ("Sun May 3 · 09:00 · posted <today>"), not when it was posted.
 *   6. A PHOTO NOTHING HERE CAN DRAW (the HEICs: no thumbnail, an original Chrome can't read): its feed tile shows a
 *      photo glyph, not an empty square; the viewer says "This photo won't open full size: this browser can't read
 *      it." over it, with Save still there and no crop button (nothing to crop on); a photo it can draw keeps it.
 *   7. SIGNAL LOST MID-PART: the phone says "offline" while the part going up hangs (held unanswered): the card says
 *      "Waiting for signal" within 3 s, not after the 30 s stall; "online", it goes on within 5 s, and posts.
 *   8. A SLOW SERVER, WITH SIGNAL: every part answered 35 s after it is sent (past the 30 s a part may go with nothing
 *      moving): the upload still finishes and posts, its card never says "Waiting for signal", and no attempt waits
 *      more than 5 s after the one before it ended (a stalled part goes again at once, with twice the patience).
 *   9. No page error.
 *
 * The files are made here by ffmpeg (test patterns) and sips (the HEIC), once, and kept in
 * WGP_FIXTURES (default: a folder in the temp directory); some photos carry a made-up camera's
 * Exif time. Nothing is played aloud.
 *
 * Stills (WGP_SHOTS=<dir>): the composer with the 100, the job cards, the refused card, the viewer's line and the
 * delete prompt, light and dark.
 *
 * PLANTED (BATCH_PLANT=<name>; each serves public/js/memories.js, or net.js for "offline", changed, never writes it):
 *   - split: partsOf() returning the whole pick as one post: 1 goes red (the server's 413).
 *   - reason: refusalWords() dropping the server's sentence: 2's card shows other words.
 *   - discard: discardJob() leaving the files on the server: 2 and 3 go red.
 *   - orphan: keepOpen() writing nothing down: 4 goes red (the twelve files stay).
 *   - viewer: the viewer saying when the post was posted: 5's viewer line goes red.
 *   - glyph: a photo with no thumbnail drawn as an empty tile again: 6's feed tile goes red.
 *   - words: the viewer's sentence for a photo it can't draw never shown: 6's viewer goes red.
 *   - cropthumb: the cropper without its fall-back to the thumbnail: 6's cropper draws nothing.
 *   - crop: the crop button left on a photo with nothing to draw: 6's "crop button is gone" goes red.
 *   - stallpark: a part given up for a stall parked to wait for signal, as before: 8 goes red.
 *   - offline: net.js without the "offline" give-up: 7's "Waiting for signal" within 3 s goes red.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import { pickPhotos, cdpPage } from "./lib/photo_picker.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXDIR = process.env.WGP_FIXTURES || path.join(os.tmpdir(), "wgp-batches-fixtures");
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// ── the plants ─────────────────────────────────────────────────────────────────────────────
const PLANT = process.env.BATCH_PLANT || "";
const PLANTS = {
  split: ["  const n = Math.max(1, Math.ceil(all.length / max));\n", "  const n = 1;\n"],
  reason: ["  if (said) return said;\n", ""],
  discard: ["  const urls = jobUrls(job);\n", "  const urls = [];\n"],
  orphan: ["function keepOpen(job) {\n", "function keepOpen(job) {\n  return;\n"],
  glyph: ["          : mm.kind === \"video\" ? \"\" : `<span class=\"me-cellnone\" aria-hidden=\"true\">${ico(\"photo\")}</span>`) +\n", "          : \"\") +\n"],
  words: ["      if (!img.getAttribute(\"src\")) item.querySelector(\".me-vnone\").hidden = false;\n", ""],
  offline: ["    addEventListener(\"offline\", lost);\n", "", "js/net.js"],
  cropthumb: ["  if (!isVideo) el.addEventListener(\"error\", () => { const t = thumbUrlOf(m); if (t && el.getAttribute(\"src\") !== t) el.src = t; });\n", ""],
  stallpark: ["            if (res.stalled && navigator.onLine !== false && jobs.includes(job)) {\n", "            if (false) {\n"],
  crop: ["    frameBtn.hidden = it.dataset.unreadable === \"1\" && !it.querySelector(\"img\")?.getAttribute(\"src\");\n", ""],
  viewer: ["  const when = whenSaid(mem, { withDay: true });\n", "  const when = `${fmtDay(mem.created_at, tripTz())} · ${fmtTime(mem.created_at, tripTz())}`;\n"],
};
if (PLANT && !PLANTS[PLANT]) throw new Error(`BATCH_PLANT is one of ${Object.keys(PLANTS).join(", ")}`);
const PLANT_FILE = PLANT ? PLANTS[PLANT][2] || "js/memories.js" : "";
const PLANTED = PLANT ? (() => {
  const src = fs.readFileSync(path.join(REPO, "public", PLANT_FILE), "utf8");
  const t = src.replace(PLANTS[PLANT][0], PLANTS[PLANT][1]);
  if (t === src) throw new Error(`the ${PLANT} plant didn't take`);
  return t;
})() : null;
if (PLANT) console.log(`PLANTED: ${PLANT} (${PLANT_FILE})`);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// ── the files ──────────────────────────────────────────────────────────────────────────────
// A made-up camera's Exif (big-endian TIFF): IFD0 points at an Exif IFD holding DateTimeOriginal.
function exifWith(when) {
  const t = Buffer.alloc(80);
  t.write("MM", 0, "ascii"); t.writeUInt16BE(42, 2); t.writeUInt32BE(8, 4);
  t.writeUInt16BE(1, 8);
  t.writeUInt16BE(0x8769, 10); t.writeUInt16BE(4, 12); t.writeUInt32BE(1, 14); t.writeUInt32BE(26, 18);
  t.writeUInt32BE(0, 22);
  t.writeUInt16BE(1, 26);
  t.writeUInt16BE(0x9003, 28); t.writeUInt16BE(2, 30); t.writeUInt32BE(20, 32); t.writeUInt32BE(44, 36);
  t.writeUInt32BE(0, 40);
  t.write(`${when}\0`, 44, "ascii");
  const body = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), t]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}
const run = (cmd, args, what) => {
  try { execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] }); }
  catch (e) { throw new Error(`${cmd} could not make ${what} (${e.code === "ENOENT" ? `${cmd} is not here` : e.message}). This check needs ffmpeg and sips.`); }
};
const pad = (i) => String(i + 1).padStart(3, "0");
// Which of the hundred is what (indices from 0, in the order picked): the posts are 0-33, 34-66
// and 67-99. The first post's photos say May 3, the earliest the LAST of them (09:00); the second's
// May 4 from 10:00 (its first); the third's say nothing (the HEICs and a video are there).
const VIDEOS = new Set([40, 80]);
const HEICS = new Set([70, 75, 85, 90]);
const HEAVY = new Set([0, 10, 20, 30, 45, 55, 65, 72, 88, 95]);
const SIZES = ["640x480", "1600x1200", "3000x2000"];
const clock = (i) => {
  if (i <= 33) { const m = 33 - i; return `2026:05:03 09:${String(m).padStart(2, "0")}:00`; }
  if (i <= 66) { const m = i - 34; return `2026:05:04 10:${String(m).padStart(2, "0")}:00`; }
  return null;
};
function fixtures() {
  fs.mkdirSync(FIXDIR, { recursive: true });
  const base = (name, make) => { const f = path.join(FIXDIR, name); if (!fs.existsSync(f)) make(f); return f; };
  const sized = SIZES.map((s) => base(`base-${s}.jpg`, (f) => run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${s}:rate=1`, "-frames:v", "1", "-q:v", "4", f], "a photo")));
  // A phone camera's weight: a 12 MP frame with grain, 3-5 MB.
  const heavy = [12, 14, 17].map((a) => base(`base-heavy-${a}.jpg`, (f) => run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=4032x3024:rate=1", "-vf", `noise=alls=${a}:allf=t`, "-frames:v", "1", "-q:v", "3", f], "a heavy photo")));
  const heic = base("base.heic", (f) => run("sips", ["-s", "format", "heic", sized[1], "--out", f], "a HEIC"));
  const video = base("base.mp4", (f) => run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-b:v", "3M", f], "a video"));
  const dir = path.join(FIXDIR, "pick");
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < 100; i++) {
    let name, src;
    if (VIDEOS.has(i)) { name = `v${pad(i)}.mp4`; src = video; }
    else if (HEICS.has(i)) { name = `p${pad(i)}.heic`; src = heic; }
    else { name = `p${pad(i)}.jpg`; src = HEAVY.has(i) ? heavy[i % 3] : sized[i % 3]; }
    const f = path.join(dir, name);
    const when = name.endsWith(".jpg") ? clock(i) : null;
    const bytes = fs.readFileSync(src);
    fs.writeFileSync(f, when ? Buffer.concat([bytes.subarray(0, 2), exifWith(when), bytes.subarray(2)]) : bytes);
    files.push(f);
  }
  return files;
}
const FILES = fixtures();
const NAMES = FILES.map((f) => path.basename(f));
const heavyMb = [...HEAVY].map((i) => fs.statSync(FILES[i]).size / 1048576);
// Lisbon in May is UTC+1: 09:00 there is 08:00 UTC.
const P1_TAKEN = Date.UTC(2026, 4, 3, 8, 0) / 1000, P2_TAKEN = Date.UTC(2026, 4, 4, 9, 0) / 1000;

const server = await startServer({ name: "photo-batches", port: await freeLoopbackPort() });
ownServer(server.origin);

let phone = null;
try {
  await server.start();
  const ana = new Person(server.origin, "Ana Ferreira-Holt");
  await ana.signUp();
  const made = await ana.post("/api/trips", { name: "Lake week", default_tz: "Europe/Lisbon", starts_on: "2026-05-01", ends_on: "2026-05-07" });
  const trip = made.json.trip.id, T = `/api/trips/${trip}`;
  check("a trip of 1 to 7 May 2026, in Lisbon", made.status === 201, String(made.status));
  check("the hundred files: 94 photos (4 HEIC, 10 of 3-5 MB), 2 videos", FILES.length === 100 && heavyMb.every((m) => m >= 3 && m <= 5.2),
    `heavy ${heavyMb.map((m) => m.toFixed(1)).join(", ")} MB`);
  const feed = async () => (await ana.get(`${T}/memories?limit=90`)).json.memories;
  // Stored or under way, of this trip, in no memory: what a post that never went in leaves holding the host's storage.
  const unattached = (keys = null) => Number(server.sql(`SELECT COUNT(*) AS n FROM media_objects mo WHERE mo.trip_id = '${trip}' AND mo.state IN ('pending', 'stored')
    AND NOT EXISTS (SELECT 1 FROM memory_media mm WHERE mm.r2_key = mo.r2_key OR mm.thumb_key = mo.r2_key)
    ${keys ? `AND mo.r2_key IN (${keys.map((k) => `'${k.replace(/'/g, "''")}'`).join(",") || "''"})` : ""}`)[0].n);

  const { boot, evalIn, waitFor, appSettled, sleep } = await import("./lib/standalone_cdp.mjs");
  const b = await boot({ vw: 440, vh: 956, dsf: 1 });
  phone = b;
  const { cdp, S } = b;
  await b.setInsets({ top: 59, right: 0, bottom: 34, left: 0 }).catch(() => {});
  const theme = (t) => cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: t }, { name: "prefers-reduced-motion", value: "reduce" }] }, S);
  await theme("light");
  for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: server.origin }, S);
  await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: ana.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
  const who = ana.jar.cookies.get("wgp_who");
  if (who) await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: who, sameSite: "Lax" }, S);
  await cdp.send("DOM.enable", {}, S);
  const page = (expr) => evalIn(cdp, S, expr);
  const wait = (expr, label, timeout) => waitFor(cdp, S, expr, { label, ...(timeout ? { timeout } : {}) });
  const look = async (name) => { if (SHOTS) await b.shot(path.join(SHOTS, `batches-${name}.png`)); };

  // What the phone asks: each begin by its file's name, each post's id and media in order.
  const begun = new Map(), posts = [];
  cdp.on((m) => {
    if (m.sessionId !== S || m.method !== "Network.requestWillBeSent") return;
    const r = m.params.request;
    if (r.method !== "POST") return;
    let body = null;
    try { body = JSON.parse(r.postData || "null"); } catch { body = null; }
    if (r.url.includes(`${T}/media/begin`) && body) begun.set(body.name, (begun.get(body.name) || 0) + 1);
    else if (new URL(r.url).pathname === `${T}/memories` && body) posts.push({ id: body.id, n: (body.media || []).length, refused: false });
  });

  // One Fetch handler for everything this check answers in the server's place: the plant, a post
  // refused, a DELETE with no signal.
  const rules = { refuse: null, dropFails: false, hold: false, holdParts: false, garble: null, slowParts: 0 };
  const heldIds = [], heldParts = [];
  cdp.on((m) => {
    if (m.sessionId !== S || m.method !== "Fetch.requestPaused") return;
    const { requestId, request: r } = m.params;
    const p = new URL(r.url).pathname;
    const go = () => cdp.send("Fetch.continueRequest", { requestId }, S).catch(() => {});
    if (PLANTED && p.endsWith(`/${PLANT_FILE}`)) {
      cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }],
        body: Buffer.from(PLANTED).toString("base64") }, S).catch(() => {});
      return;
    }
    if (r.method === "POST" && p === `${T}/memories` && rules.hold) { heldIds.push(requestId); return; }
    if (r.method === "POST" && p === `${T}/media/part` && rules.holdParts) { heldParts.push(requestId); return; }
    if (r.method === "POST" && p === `${T}/media/part` && rules.slowParts) { setTimeout(go, rules.slowParts); return; }
    if (r.method === "GET" && rules.garble && p === rules.garble) {
      cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "image/heic" }, { name: "Cache-Control", value: "no-store" }],
        body: Buffer.from("not a picture any browser reads").toString("base64") }, S).catch(() => {});
      return;
    }
    if (r.method === "POST" && p === `${T}/memories` && rules.refuse) {
      let body = null;
      try { body = JSON.parse(r.postData || "null"); } catch { body = null; }
      const answer = body && rules.refuse(body);
      if (answer) {
        const last = posts.findLast((x) => x.id === body.id);
        if (last) last.refused = true;
        cdp.send("Fetch.fulfillRequest", { requestId, responseCode: answer.status,
          responseHeaders: [{ name: "Content-Type", value: "application/json" }],
          body: Buffer.from(JSON.stringify(answer.body)).toString("base64") }, S).catch(() => {});
        return;
      }
    }
    if (r.method === "DELETE" && p === `${T}/media/object` && rules.dropFails) {
      cdp.send("Fetch.failRequest", { requestId, errorReason: "InternetDisconnected" }, S).catch(() => {});
      return;
    }
    go();
  });
  // What passes through this check: the plants' files and the posts and removals always; the parts going up and the
  // originals coming down only in the sections that need them (every byte of them would come through here).
  const intercept = (more = []) => cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/memories.js*" }, { urlPattern: "*/js/net.js*" },
    { urlPattern: `*${T}/memories*` }, { urlPattern: `*${T}/media/object*` }, ...more.map((urlPattern) => ({ urlPattern }))] }, S);
  await intercept();

  // Every job card's words, as they change, for the whole page's life: a card that ever says "Rejected (" is caught.
  const WATCH = `(() => { if (window.__cards) return 1; window.__cards = new Set(); const box = () => document.querySelector(".me-jobs");
    const note = () => { for (const c of document.querySelectorAll(".me-job")) window.__cards.add(c.textContent.replace(/\\s+/g, " ").trim()); };
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true }); note(); return 1; })()`;
  let nav = 0;
  const memoriesTab = async () => {
    await cdp.send("Page.navigate", { url: `${server.origin}/t/${trip}/?n=${++nav}#/memories` }, S);
    await sleep(300);
    await appSettled(cdp, S);
    await wait(`document.querySelector("#view .me-feed") ? 1 : 0`, "the Memories feed", 45000);
    await page(WATCH);
    await sleep(300);
  };
  const cardsSeen = async () => JSON.parse(await page(`JSON.stringify([...(window.__cards || [])])`));
  const cards = async () => JSON.parse(await page(`JSON.stringify([...document.querySelectorAll(".me-job")].map((c) => ({ state: c.dataset.state,
    name: c.querySelector(".me-jobname").textContent.trim(), label: c.querySelector(".me-jobstate").textContent.trim(),
    how: (c.querySelector(".me-jobhow") || { textContent: "" }).textContent.trim(), why: (c.querySelector(".me-jobwhy") || { textContent: "" }).textContent.trim(),
    retry: !!c.querySelector(".me-retry"), discard: !!c.querySelector(".me-discard") })))`));
  const compose = async (files, caption, tag = "") => {
    await pickPhotos({ ...cdpPage(cdp, S), files });
    await wait(`(() => { const s = document.querySelector(".me-whensay"); return s && s.textContent && !/^Reading/.test(s.textContent) ? 1 : 0; })()`, "when it happened, read", 60000);
    await page(`(() => { const i = document.querySelector("#me-cap-in"); i.value = ${JSON.stringify(caption)}; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
    if (tag) await page(`(() => { document.querySelector(".me-more").open = true; const i = document.querySelector("#me-tag-in"); i.value = ${JSON.stringify(tag)};
      document.querySelector(".me-tagadd").click(); return 1; })()`);
    return page(`document.querySelector(".me-go").textContent.trim()`);
  };
  const go = () => page(`(document.querySelector(".me-go").click(), 1)`);

  await memoriesTab();
  const before = unattached();
  check("nothing unattached to start with", before === 0, String(before));

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────────
  section("1. a hundred at once");
  const button = await compose(FILES, "Market day", "market");
  const named = await page(`document.querySelector(".me-go").getAttribute("aria-label")`);
  await look("composer-100-light");
  await theme("dark"); await sleep(250); await look("composer-100-dark"); await theme("light");
  check("the composer says \"Upload all 100\", its name the full words", button === "Upload all 100" && named === "Upload 98 photos and 2 videos", `${button} / ${named}`);
  await go();
  await wait(`document.querySelectorAll(".me-job").length ? 1 : 0`, "the job cards");
  let c = await cards();
  check("three cards, each saying what it holds: Post 1 of 3 (34 photos), Post 2 and 3 of 3 (32 photos and a video)",
    JSON.stringify(c.map((x) => x.name)) === JSON.stringify(["Post 1 of 3 · 34 photos", "Post 2 of 3 · 32 photos and 1 video", "Post 3 of 3 · 32 photos and 1 video"]), JSON.stringify(c.map((x) => x.name)));
  check("the first uploads, the other two wait their turn", c[0]?.label === "Uploading" && c[1]?.label === "Queued" && c[2]?.label === "Queued", JSON.stringify(c.map((x) => x.label)));
  await look("100-light");
  await theme("dark"); await sleep(250); await look("100-dark"); await theme("light");
  // Part way: how many of how many, and the bytes.
  const mid = await wait(`(() => { const h = document.querySelector('.me-job[data-state="uploading"] .me-jobhow'); return h && /^([1-9]\\d*) of 3[34] sent · .+ of .+$/.test(h.textContent.trim()) ? h.textContent.trim() : null; })()`, "a card part way", 120000).catch(() => null);
  check("a card part way says how many of how many are sent, and the bytes", !!mid, String(mid));
  if (mid) { await look("100-partway-light"); await theme("dark"); await sleep(250); await look("100-partway-dark"); await theme("light"); }
  // Until nothing is under way: every job posted (the feed's three cards) or refused (a card left, failed).
  await wait(`document.querySelectorAll('.me-job:not([data-state="failed"])').length === 0 && (document.querySelector(".me-job") || document.querySelectorAll(".me-card").length === 3) ? 1 : 0`, "nothing under way", 600000)
    .catch(async (e) => { console.log(`  (cards then: ${JSON.stringify(await cards())})`); throw e; });
  check("no card left, refused or otherwise", (await cards()).length === 0, JSON.stringify(await cards()));
  const mine = (await feed()).filter((m) => m.caption === "Market day");
  const byPost = posts.filter((p) => !p.refused).map((p) => mine.find((m) => m.id === p.id)).filter(Boolean);
  const sizes = byPost.map((m) => m.media.length);
  check("three posts, 34, 33 and 33, posted in that order", JSON.stringify(sizes) === "[34,33,33]" && mine.length === 3, `${JSON.stringify(sizes)} of ${mine.length}`);
  const order = byPost.flatMap((m) => [...m.media].sort((a, z) => a.sort - z.sort).map((x) => x.orig_name));
  check("every file in one of them, in the order picked", JSON.stringify(order) === JSON.stringify(NAMES), `${order.slice(0, 3).join(",")}… (${order.length})`);
  check("each has the caption and the tag", byPost.every((m) => m.caption === "Market day" && JSON.stringify(m.tags) === '["market"]'), JSON.stringify(byPost.map((m) => m.tags)));
  const when = byPost.map((m) => ({ day: m.day, taken_at: m.taken_at }));
  check("each on its own photos' day and earliest time; the one whose photos say none on the pick's day, no time",
    JSON.stringify(when) === JSON.stringify([{ day: "2026-05-03", taken_at: P1_TAKEN }, { day: "2026-05-04", taken_at: P2_TAKEN }, { day: "2026-05-03", taken_at: null }]), JSON.stringify(when));
  const twice = NAMES.filter((n) => begun.get(n) !== 1);
  check("each file begun once, nothing uploaded twice", begun.size === 100 && !twice.length, `${begun.size} begun; not once: ${twice.slice(0, 5).map((n) => `${n}×${begun.get(n) || 0}`).join(", ")}`);
  const heic = byPost.flatMap((m) => m.media).filter((x) => /\.heic$/.test(x.orig_name));
  check("the four HEICs Chrome can't draw are in, with no thumbnail", heic.length === 4 && heic.every((x) => !x.thumb_key && x.bytes > 0), JSON.stringify(heic.map((x) => [x.orig_name, x.thumb_key, x.bytes])));
  const vids = byPost.flatMap((m) => m.media).filter((x) => x.kind === "video");
  check("the two videos are in, each with its poster", vids.length === 2 && vids.every((x) => x.thumb_key), JSON.stringify(vids.map((x) => [x.orig_name, !!x.thumb_key])));
  const left = unattached();
  check("nothing stored is left unattached", left === 0, String(left));
  let seen = await cardsSeen();
  check("no card ever said \"Rejected (\"", seen.length > 0 && !seen.some((t) => t.includes("Rejected (")), `${seen.length} card texts seen`);
  // The viewer, on the first post (its photos taken 3 May at 09:00, posted today), and its delete prompt.
  const today = await page(`new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Lisbon", weekday: "short", month: "short", day: "numeric" }).formatToParts(new Date()).filter((p) => p.type !== "literal").map((p) => p.value).join(" ")`);
  await page(`(document.querySelector('.me-card[data-id="${byPost[0].id}"] .me-cell').click(), 1)`);
  await wait(`document.querySelector(".me-view .me-vwhen") ? 1 : 0`, "the viewer");
  const vwhen = await page(`document.querySelector(".me-view .me-vwhen").textContent.trim()`);
  const cwhen = await page(`document.querySelector('.me-card[data-id="${byPost[0].id}"] .me-when').textContent.trim()`);
  check("the viewer says when it happened, as the card does, with its day", vwhen === `Sun May 3 · 09:00 · posted ${today}` && cwhen === `09:00 · posted ${today}`, `viewer "${vwhen}", card "${cwhen}"`);
  await look("viewer-when-light");
  await theme("dark"); await sleep(250); await look("viewer-when-dark"); await theme("light");
  await page(`(document.querySelector(".me-vclose").click(), 1)`);
  await wait(`!document.querySelector(".me-view") ? 1 : 0`, "the viewer closed");
  await page(`(document.querySelector('.me-card[data-id="${byPost[1].id}"] [aria-label^=Delete]').click(), 1)`);
  await wait(`document.querySelector(".me-delsheet .lead") ? 1 : 0`, "the delete prompt");
  const lead = await page(`document.querySelector(".me-delsheet .lead").textContent.trim()`);
  check("the delete prompt says what goes: \"32 photos and 1 video · <size>\"", /^32 photos and 1 video · \d/.test(lead), lead);
  await look("delete-light");
  await theme("dark"); await sleep(250); await look("delete-dark"); await theme("light");
  await page(`(document.querySelector(".me-docancel").click(), 1)`);
  await wait(`!document.querySelector(".me-delsheet") ? 1 : 0`, "the prompt closed");

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────────
  section("2. a refusal in words");
  const REASON = "A memory holds at most 40 photographs and videos; this one has 21.";
  let refusedId = null;
  rules.refuse = (body) => {
    if (!refusedId && (body.media || []).length === 21) refusedId = body.id;
    return body.id === refusedId ? { status: 413, body: { error: "too many media in one memory", got: 21, max: 40, reason: REASON } } : null;
  };
  const small = FILES.filter((f, i) => !HEAVY.has(i) && !VIDEOS.has(i) && !HEICS.has(i)).slice(0, 41);
  const one = await compose(small, "Refused part");
  check("photos of one kind are said: \"Upload 41 photos\"", one === "Upload 41 photos", one);
  await go();
  await wait(`(() => { const j = [...document.querySelectorAll(".me-job")]; return j.length === 1 && j[0].dataset.state === "failed" ? 1 : 0; })()`, "one card refused, the other posted", 180000)
    .catch(async (e) => { console.log(`  (cards then: ${JSON.stringify(await cards())})`); throw e; });
  c = await cards();
  check("the refused card says the server's reason, with Retry and Discard", c.length === 1 && c[0].name === "Post 1 of 2 · 21 photos" && c[0].label === "Not posted" && c[0].why === REASON && c[0].retry && c[0].discard, JSON.stringify(c));
  await look("refused-light");
  await theme("dark"); await sleep(250); await look("refused-dark"); await theme("light");
  const second = (await feed()).filter((m) => m.caption === "Refused part");
  check("the second post went in all the same (20)", second.length === 1 && second[0].media.length === 20, JSON.stringify(second.map((m) => m.media.length)));
  // Retried, and refused with no reason at all: plain words, no number.
  rules.refuse = (body) => (body.id === refusedId ? { status: 400, body: { error: "bad request" } } : null);
  await page(`(document.querySelector(".me-retry").click(), 1)`);
  await wait(`(() => { const j = document.querySelector(".me-job"); return j && j.dataset.state === "failed" && !j.querySelector(".me-jobwhy")?.textContent.includes("at most 40") ? 1 : 0; })()`, "refused again, no reason", 60000);
  c = await cards();
  check("refused with no reason: plain words for what to do, no number", c.length === 1 && c[0].why === "The server didn't take this post. Retry, or Discard it." && !/\d/.test(`${c[0].label} ${c[0].why}`), JSON.stringify(c));
  const keysOf = () => JSON.parse(server.sql(`SELECT json_group_array(r2_key) AS k FROM media_objects WHERE trip_id = '${trip}'
    AND (orig_name IN (${small.slice(0, 21).map((f) => `'${path.basename(f)}'`).join(",")}) OR thumb_for IN (SELECT r2_key FROM media_objects WHERE trip_id = '${trip}' AND orig_name IN (${small.slice(0, 21).map((f) => `'${path.basename(f)}'`).join(",")})))
    AND NOT EXISTS (SELECT 1 FROM memory_media mm WHERE mm.r2_key = media_objects.r2_key OR mm.thumb_key = media_objects.r2_key)`)[0].k);
  const refusedKeys = keysOf();
  const held = unattached(refusedKeys);
  check("the refused post's files are on the server, unattached (21 and their thumbnails)", held === 42 && unattached() === 42, `${held} of ${refusedKeys.length} keys; trip ${unattached()}`);
  await page(`(document.querySelector(".me-discard").click(), 1)`);
  await wait(`document.querySelectorAll(".me-job").length === 0 ? 1 : 0`, "the card gone");
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await sleep(250); gone = unattached(refusedKeys) === 0; }
  check("Discard takes its files off the server: unattached back to what it was", gone && unattached() === before, `${unattached(refusedKeys)} of its own left; trip ${unattached()} (was ${before})`);
  rules.refuse = null;

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────────
  section("3. a discard without signal");
  let offId = null;
  rules.refuse = (body) => { if (!offId) offId = body.id; return body.id === offId ? { status: 413, body: { error: "too many media in one memory", reason: REASON } } : null; };
  const three = small.slice(21, 24);
  await compose(three, "No signal");
  await go();
  await wait(`(() => { const j = document.querySelector(".me-job"); return j && j.dataset.state === "failed" ? 1 : 0; })()`, "refused", 60000);
  c = await cards();
  check("a pick of 40 or fewer is one card, with no \"Post 1 of 1\": \"3 photos\"", c.length === 1 && c[0].name === "3 photos", JSON.stringify(c.map((x) => x.name)));
  rules.dropFails = true;
  await page(`(document.querySelector(".me-discard").click(), 1)`);
  await wait(`document.querySelectorAll(".me-job").length === 0 ? 1 : 0`, "the card gone");
  await sleep(800);
  await page(`(window.dispatchEvent(new Event("online")), 1)`);
  await sleep(800);
  const listed = JSON.parse(await page(`localStorage.getItem("wgp.memdrop") || "[]"`));
  check("with no signal, its files wait on the phone, still on the server", listed.length === 6 && unattached() === 6, `${listed.length} listed; ${unattached()} unattached`);
  rules.dropFails = false;
  await memoriesTab();
  gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await sleep(250); gone = unattached() === before; }
  const after = JSON.parse(await page(`localStorage.getItem("wgp.memdrop") || "[]"`));
  check("with signal back and the app opened again, they leave the server and the phone's list", gone && after.length === 0, `${unattached()} unattached; ${after.length} listed`);

  // One file keeps its name; one video is "1 video" only among others (a single file is always its name).
  let oneId = null;
  rules.refuse = (body) => { if (!oneId) oneId = body.id; return body.id === oneId ? { status: 413, body: { error: "too many media in one memory", reason: REASON } } : null; };
  await compose([FILES[40]], "One video");
  await go();
  await wait(`(() => { const j = document.querySelector(".me-job"); return j && j.dataset.state === "failed" ? 1 : 0; })()`, "refused", 60000);
  c = await cards();
  check("a single file's card keeps its name", c.length === 1 && c[0].name === "v041.mp4", JSON.stringify(c.map((x) => x.name)));
  await page(`(document.querySelector(".me-discard").click(), 1)`);
  gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await sleep(250); gone = unattached() === before; }
  check("and its Discard leaves nothing", gone, String(unattached()));
  seen = await cardsSeen();
  check("no card anywhere says \"items\"", !seen.some((t) => /\bitems?\b/.test(t)), seen.filter((t) => /\bitems?\b/.test(t)).slice(0, 2).join(" | "));
  rules.refuse = null;

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────────
  section("4. the app closed mid-upload");
  // The post held unanswered (the phone put the app away before it was answered), then the page loaded again.
  rules.hold = true;
  await compose(small.slice(24, 30), "Closed mid-way");
  await go();
  await wait(`(() => { const j = document.querySelector(".me-job"); return j && j.dataset.state === "posting" ? 1 : 0; })()`, "posting, held", 60000);
  const open = JSON.parse(await page(`localStorage.getItem("wgp.memopen") || "{}"`));
  const waiting = unattached();
  check("while it runs, its twelve files (six and their thumbnails) are written down on the phone, unattached on the server",
    Object.values(open).reduce((n, o) => n + o.urls.length, 0) === 12 && waiting === 12, `${Object.values(open).map((o) => o.urls.length)} written; ${waiting} unattached`);
  await memoriesTab();
  rules.hold = false;
  for (const id of heldIds.splice(0)) await cdp.send("Fetch.failRequest", { requestId: id, errorReason: "Aborted" }, S).catch(() => {});
  gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await sleep(250); gone = unattached() === before; }
  const noted = JSON.parse(await page(`localStorage.getItem("wgp.memopen") || "{}"`));
  check("opened again, Memories removes that job's files from the server and its note from the phone", gone && !Object.keys(noted).length, `${unattached()} unattached (was ${before}); ${Object.keys(noted).length} jobs noted`);
  check("and nothing was posted", !(await feed()).some((m) => m.caption === "Closed mid-way"));

  // ── 6 ──────────────────────────────────────────────────────────────────────────────────────
  section("6. a photo nothing here can draw");
  // Four photos, the third a HEIC (Chrome can't draw it: no thumbnail is made, and the original won't open).
  await compose([FILES[0], FILES[1], FILES[70], FILES[2]], "Four, one a HEIC");
  await go();
  await wait(`document.querySelectorAll(".me-job").length === 0 ? 1 : 0`, "posted", 120000);
  const third = (await feed()).find((m) => m.caption === "Four, one a HEIC");
  await wait(`document.querySelector('.me-card[data-id="${third.id}"]') ? 1 : 0`, "its card");
  const heicAt = [...third.media].sort((a, z) => a.sort - z.sort).findIndex((x) => /\.heic$/.test(x.orig_name));
  // Its fourth photo's original answered with bytes no browser reads, from before any viewer opens (one loaded
  // already would come from the browser's memory): used at the end of this section.
  rules.garble = new URL([...third.media].sort((a, z) => a.sort - z.sort)[3].url, server.origin).pathname;
  await intercept([`*${rules.garble}*`]);
  const tile = JSON.parse(await page(`JSON.stringify((() => { const c = document.querySelectorAll('.me-card[data-id="${third.id}"] .me-cell')[${heicAt}]; if (!c) return null;
    const g = c.querySelector(".me-cellnone"); const r = g && g.getBoundingClientRect(); return { img: !!c.querySelector("img"), glyph: !!g && getComputedStyle(g).display !== "none" && r.width > 0 && !!g.querySelector("svg") }; })())`));
  check("its feed tile shows a photo glyph, not an empty square", heicAt === 2 && tile && !tile.img && tile.glyph, `${heicAt} ${JSON.stringify(tile)}`);
  await page(`(document.querySelectorAll('.me-card[data-id="${third.id}"] .me-cell')[${heicAt}].scrollIntoView({ block: "center" }), 1)`);
  await sleep(300);
  await look("heic-tile-light");
  await theme("dark"); await sleep(250); await look("heic-tile-dark"); await theme("light");
  await page(`(document.querySelectorAll('.me-card[data-id="${third.id}"] .me-cell')[${heicAt}].click(), 1)`);
  const said = await wait(`(() => { const n = document.querySelectorAll(".me-view .me-vitem")[${heicAt}]?.querySelector(".me-vnone"); return n && !n.hidden ? n.textContent.trim() : null; })()`, "the viewer's words", 15000).catch(() => null);
  const saveThere = await page(`(() => { const b = document.querySelector(".me-view .me-vsave"); return !!b && !b.disabled && getComputedStyle(b).visibility !== "hidden"; })()`);
  check("the viewer says it won't open full size, with Save still there", said === "This photo won't open full size: this browser can't read it." && saveThere, `${said} / save ${saveThere}`);
  await look("heic-viewer-light");
  await theme("dark"); await sleep(250); await look("heic-viewer-dark"); await theme("light");
  const cropGone = await page(`(() => { const b = document.querySelector(".me-view .me-vframe"); return !!b && b.hidden && getComputedStyle(b).display === "none"; })()`);
  check("nothing to crop on: its crop button is gone", cropGone);
  await page(`(document.querySelector(".me-vclose").click(), 1)`);
  await wait(`!document.querySelector(".me-view") ? 1 : 0`, "the viewer closed");
  await page(`(document.querySelectorAll('.me-card[data-id="${third.id}"] .me-cell')[0].click(), 1)`);
  await wait(`document.querySelector(".me-view .me-vframe") ? 1 : 0`, "the viewer on a readable photo");
  await sleep(800);
  const cropThere = await page(`(() => { const b = document.querySelector(".me-view .me-vframe"); return !b.hidden && getComputedStyle(b).display !== "none"; })()`);
  check("a photo it can draw keeps its crop button", cropThere);
  await page(`(document.querySelector(".me-vclose").click(), 1)`);
  await wait(`!document.querySelector(".me-view") ? 1 : 0`, "the viewer closed");
  // A photo with a thumbnail whose original this browser can't read (a HEIC from an iPhone, seen on another phone):
  // made by answering its original with bytes no browser reads. The viewer keeps the thumbnail and the crop button,
  // and the cropper draws the thumbnail.
  await page(`(document.querySelectorAll('.me-card[data-id="${third.id}"] .me-cell')[3].click(), 1)`);
  await wait(`document.querySelector(".me-view .me-vframe") ? 1 : 0`, "the viewer");
  await wait(`document.querySelectorAll(".me-view .me-vitem")[3]?.dataset.unreadable === "1" ? 1 : 0`, "its original found unreadable", 15000);
  const thumbKept = await page(`(() => { const it = document.querySelectorAll(".me-view .me-vitem")[3]; const i = it.querySelector("img"); return i.naturalWidth > 0 && it.querySelector(".me-vnone").hidden && !document.querySelector(".me-vframe").hidden; })()`);
  await page(`(document.querySelector(".me-vframe").click(), 1)`);
  const drawn = await wait(`(() => { const i = document.querySelector(".me-fr .me-frmedia"); return i && i.complete && i.naturalWidth > 0 ? i.naturalWidth : 0; })()`, "the cropper's picture", 10000).catch(() => 0);
  check("an original it can't read, with a thumbnail: the viewer keeps the thumbnail and the crop, and the cropper draws the thumbnail", thumbKept && drawn > 0 && drawn <= 480, `thumb kept ${thumbKept}; cropper drew ${drawn} px wide`);
  await page(`(document.querySelector(".sh-sheet .sh-x, .sh-sheet [aria-label=Close]")?.click(), 1)`);
  await sleep(500);
  rules.garble = null;
  await intercept();
  await page(`(document.querySelector(".me-vclose")?.click(), 1)`);
  await wait(`!document.querySelector(".me-view") ? 1 : 0`, "the viewer closed").catch(() => {});

  // ── 7 ──────────────────────────────────────────────────────────────────────────────────────
  section("7. signal lost mid-part");
  // A phone that loses its signal says so (the window's "offline") while the part going up neither moves nor fails:
  // its connection just hangs. Made here by holding every part request unanswered, then saying "offline". (Chrome's
  // own offline fails a request at once, which hides the hang a phone's radio leaves.)
  const heavy3 = [...HEAVY].slice(0, 3).map((i) => FILES[i]);
  await compose(heavy3, "Hotel line");
  rules.holdParts = true;
  await intercept([`*${T}/media/part*`]);
  await go();
  await wait(`(() => { const j = document.querySelector(".me-job"); return j && j.dataset.state === "uploading" ? 1 : 0; })()`, "uploading", 60000);
  for (let i = 0; i < 100 && !heldParts.length; i++) await sleep(100);
  await sleep(500);
  const t0 = Date.now();
  await page(`(window.dispatchEvent(new Event("offline")), 1)`);
  const waited = await wait(`document.querySelector('.me-job[data-state="waiting"]') ? 1 : 0`, "waiting for signal", 3000).then(() => Date.now() - t0).catch(() => null);
  check("the phone says offline mid-part, its connection silent: \"Waiting for signal\" within 3 s", heldParts.length > 0 && waited != null, `${waited} ms; ${heldParts.length} part(s) held`);
  rules.holdParts = false;
  for (const id of heldParts.splice(0)) await cdp.send("Fetch.failRequest", { requestId: id, errorReason: "InternetDisconnected" }, S).catch(() => {});
  await intercept();
  await sleep(500);
  const t1 = Date.now();
  await page(`(window.dispatchEvent(new Event("online")), 1)`);
  const resumed = await wait(`document.querySelector('.me-job[data-state="uploading"]') ? 1 : 0`, "uploading again", 5000).then(() => Date.now() - t1).catch(() => null);
  check("signal back (\"online\"): it goes on within 5 s", resumed != null, `${resumed} ms`);
  await wait(`document.querySelectorAll(".me-job").length === 0 ? 1 : 0`, "posted", 120000).catch(() => {});
  const hotel = (await feed()).find((m) => m.caption === "Hotel line");
  check("and it posts, all three, each begun once", !!hotel && hotel.media.length === 3 && heavy3.every((f) => begun.get(path.basename(f)) === (f === FILES[0] ? 3 : 2)),
    `${hotel ? hotel.media.length : "none"}; begun ${heavy3.map((f) => begun.get(path.basename(f)))}`);

  // ── 8 ──────────────────────────────────────────────────────────────────────────────────────
  section("8. a slow server, with signal");
  // Every part answered 35 s after it is sent: longer than the 30 s a part may go with nothing moving (a hotel line
  // whose buffers swallow the bytes, a server slow to answer). The phone has signal throughout.
  await page(`(window.__cards = new Set(), 1)`);
  const attempts = new Map();
  const offNet = cdp.on((m) => {
    if (m.sessionId !== S) return;
    if (m.method === "Network.requestWillBeSent" && m.params.request.url.includes(`${T}/media/part`)) attempts.set(m.params.requestId, { t0: Date.now(), t1: null });
    else if ((m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") && attempts.has(m.params.requestId)) attempts.get(m.params.requestId).t1 = Date.now();
  });
  rules.slowParts = 35000;
  await intercept([`*${T}/media/part*`]);
  await compose([FILES[1], FILES[2]], "Slow server");
  await go();
  await wait(`document.querySelectorAll(".me-job").length === 0 ? 1 : 0`, "posted", 200000).catch(() => {});
  rules.slowParts = 0;
  await intercept();
  offNet();
  const slow = (await feed()).find((m) => m.caption === "Slow server");
  check("a slow server, every part answered after 35 s: the upload still finishes and posts", !!slow && slow.media.length === 2, slow ? `${slow.media.length}` : "not posted");
  const slowSeen = await cardsSeen();
  check("its card never says \"Waiting for signal\" while the phone has signal", slowSeen.length > 0 && !slowSeen.some((t) => t.includes("Waiting for signal")),
    slowSeen.filter((t) => t.includes("Waiting")).slice(0, 1).join(""));
  const spans = [...attempts.values()].sort((a, z) => a.t0 - z.t0);
  const gaps = spans.slice(1).map((x, i) => (spans[i].t1 != null ? x.t0 - spans[i].t1 : Infinity));
  check("never idle more than a few seconds between one part attempt and the next", spans.length >= 2 && gaps.every((g) => g <= 5000),
    `${spans.length} attempts; gaps ${gaps.map((g) => (Number.isFinite(g) ? `${(g / 1000).toFixed(1)}s` : "open")).join(", ")}`);

  // ── 9 ──────────────────────────────────────────────────────────────────────────────────────
  section("9. page errors");
  check("no page error", b.pageErrors.length === 0, b.pageErrors.join(" | ").slice(0, 400));
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  if (phone) await phone.done().catch(() => {});
  await server.stop().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

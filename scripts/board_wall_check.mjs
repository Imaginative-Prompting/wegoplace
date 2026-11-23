#!/usr/bin/env node
/* The board is a board on a wall: on the gate's made-up trip with sixteen memories of its own (removed afterwards),
 * at 390 with motion on, by real touches and a trackpad's pinch.
 *
 *   node scripts/gate.mjs --who <session> --only board_wall
 *
 * WHAT IT PROVES
 *   0. The empty board holds its words: with no photo on the trip, at 390 and at 1440, the card ("No photos yet", Add
 *      photos) is inside the board's frame by its margin, on the cork, not a dialog over the board.
 *  0b. The first photo on an empty board, added from its card at 390: the board takes it, and Save or share and the
 *      appearance button stay on the board's stage, the view toggle above it still the thing under a finger.
 *   1. The board opens whole, on its wall: the board's edge holds every print, the whole board is on the screen, and
 *      wall shows round it. At 390 the + button floats over the screen's foot and Save or share over its head: the
 *      opened board ends above the one and starts below the other.
 *  1c. A small board on a short screen: 3 photos at 320 x 568 (its status bar 20 above), where the + button needs
 *      more of the stage than at 390. The opened board still ends above it.
 *   2. Every print is bare, even with a stored "polaroid" style (the look kept in this browser).
 *   3. Pan and zoom can't lose the board: dragged hard in every direction some of it shows; zoomed all the way in AT
 *      EACH CORNER of the board and dragged hard outward (to the camera's clamp), once the camera has come to rest
 *      (the fling and the spring back over), the board still covers at least half the screen each way; zoomed right out, all of it shows. At 16 photos here, and again on boards of 40
 *      and 200 (3b).
 *   4. The saved image draws the same board: Save image's plan (collage-export.js) and the app's board are one size.
 *   5. A photo added grows the board and the prints glide to their places: the board's edge moves (data-grow), and
 *      once the glide is over every print rests exactly where its inline place says, inside the board.
 *
 * PLANTED: BOARDWALL_PLANT=1 serves collage.js, collage-layout.js and memories.js as they were before the board
 * (BEFORE): there is no board (1, 3, 4, 5) and the prints wear their stored style (2). BOARDWALL_PLANT=clamp serves
 * today's collage.js with the view allowed past the board by its whole band (the first clamp): zoomed in at a corner
 * the screen goes (nearly) all wall, and 3 and 3b go red. BOARDWALL_PLANT=fab serves today's memories.js with no
 * bottom inset for the + button: the opened board runs under it, and 1 goes red. BOARDWALL_PLANT=head serves it with
 * no head band: Save or share covers the board's top, and 1 goes red. BOARDWALL_PLANT=empty serves it with the
 * empty card left where it was (the screen's middle, 300 px): at 390 it hangs off the board, and 0 goes red.
 * BOARDWALL_PLANT=footcap serves collage.js with the foot band's ceiling at 30% of the stage, as the head's: at 320
 * the board of 3 opens under the +, and 1c goes red.
 * BOARDWALL_PLANT=spring serves collage.js with the spring back at 0.4 rad/s (seconds, not 330 ms): a corner's camera
 * hasn't come to rest in the 4 s it is given, and 3 goes red.
 * BOARDWALL_PLANT=pos serves memories.css with the board's stage positioned only while it is empty: once the first
 * photo arrives the buttons land on the page's head, over the view toggle, and 0b goes red.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, REPO, appSettled, boot, evalIn, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { seedMemories } from "./lib/seed_memories.mjs";
import { tripApi, tripPath } from "./lib/gate_trip.mjs";
import { makeApi } from "./lib/seed_memories.mjs";
import { pickPhotos, cdpPage } from "./lib/photo_picker.mjs";

const PLANT = !!process.env.BOARDWALL_PLANT;
const PLANT_CLAMP = process.env.BOARDWALL_PLANT === "clamp";
const PLANT_FAB = process.env.BOARDWALL_PLANT === "fab";
const PLANT_HEAD = process.env.BOARDWALL_PLANT === "head";
const PLANT_EMPTY = process.env.BOARDWALL_PLANT === "empty";
const PLANT_POS = process.env.BOARDWALL_PLANT === "pos";
const PLANT_FOOTCAP = process.env.BOARDWALL_PLANT === "footcap";
const PLANT_SPRING = process.env.BOARDWALL_PLANT === "spring";
const BEFORE = "6e2a28b";
const PLANTED = PLANT_POS
  ? (() => { const s = fs.readFileSync(path.join(REPO, "public/css/memories.css"), "utf8");
      const t = s.replace('.me-stage[data-stage="collage"], .me-stage-empty { position: relative; }', ".me-stage-empty { position: relative; }");
      if (t === s) throw new Error("the stage plant changed nothing"); return { "/css/memories.css": t }; })()
  : PLANT_EMPTY
  ? (() => { const s = fs.readFileSync(path.join(REPO, "public/js/memories.js"), "utf8");
      const t = s.replace("function placeEmpty(stage) {", "function placeEmpty(stage) { return;");
      if (t === s) throw new Error("the empty plant changed nothing"); return { "/js/memories.js": t }; })()
  : PLANT_HEAD
  ? (() => { const s = fs.readFileSync(path.join(REPO, "public/js/memories.js"), "utf8");
      const t = s.replace("out.top = Math.max(0, Math.max(", "out.top = 0 * Math.max(0, Math.max(");
      if (t === s) throw new Error("the head plant changed nothing"); return { "/js/memories.js": t }; })()
  : PLANT_FAB
  ? (() => { const s = fs.readFileSync(path.join(REPO, "public/js/memories.js"), "utf8");
      const t = s.replace("fitInset: () => {", "fitInset: () => ({ bottom: 0 }), fitInsetToday: () => {");
      if (t === s) throw new Error("the + plant changed nothing"); return { "/js/memories.js": t }; })()
  : PLANT_FOOTCAP
  ? (() => { const s = fs.readFileSync(path.join(REPO, "public/js/collage.js"), "utf8");
      const t = s.replace("insetB = band(ins && ins.bottom, 0.4);", "insetB = band(ins && ins.bottom, 0.3);");
      if (t === s) throw new Error("the foot ceiling plant changed nothing"); return { "/js/collage.js": t }; })()
  : PLANT_SPRING
  ? (() => { const s = fs.readFileSync(path.join(REPO, "public/js/collage.js"), "utf8");
      const t = s.replace("const SPRING_W = 15;", "const SPRING_W = 0.4;");
      if (t === s) throw new Error("the spring plant changed nothing"); return { "/js/collage.js": t }; })()
  : PLANT_CLAMP
  ? (() => { const s = fs.readFileSync(path.join(REPO, "public/js/collage.js"), "utf8");
      const t = s.replace("const allow = Math.min(band, view / (2 * k));", "const allow = band;");
      if (t === s) throw new Error("the clamp plant changed nothing"); return { "/js/collage.js": t }; })()
  : PLANT ? Object.fromEntries(["public/js/collage.js", "public/js/collage-layout.js", "public/js/memories.js"]
  .map((f) => [f.replace(/^public/, ""), execFileSync("git", ["show", `${BEFORE}:${f}`], { cwd: REPO, encoding: "utf8" })])) : null;

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
};
const J = async (c, S, e) => JSON.parse(await evalIn(c, S, `Promise.resolve(${e}).then((v) => JSON.stringify(v))`));

// A made-up photo for the one added in 5 (ffmpeg's test pattern).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-boardwall-"));
const PHOTO = path.join(tmp, "added.jpg");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1200x900:rate=1", "-frames:v", "1", "-q:v", "4", PHOTO]);

// The files a plant serves, into one browser page.
const plantInto = async (C, S2) => {
  if (!PLANTED) return;
  C.on((m) => { if (m.sessionId !== S2 || m.method !== "Fetch.requestPaused") return;
    const body = PLANTED[new URL(m.params.request.url).pathname];
    if (!body) { C.send("Fetch.continueRequest", { requestId: m.params.requestId }, S2).catch(() => {}); return; }
    const type = new URL(m.params.request.url).pathname.endsWith(".css") ? "text/css" : "text/javascript";
    C.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: `${type}; charset=utf-8` }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(body).toString("base64") }, S2).catch(() => {}); });
  await C.send("Fetch.enable", { patterns: Object.keys(PLANTED).map((x) => ({ urlPattern: `*${x}*` })) }, S2);
};

const memoryIds = async () => new Set((((await (await makeApi())(tripApi("/memories?limit=90"))).json || {}).memories || []).map((m) => m.id));

// 0. The empty board, before any photo: its card inside the board's frame by the margin, at 390 and 1440.
// 0b. At 390, the first photo added from the card: the buttons stay on the stage.
{
  const EMPTY_MARGIN = 16;
  const held = ((((await (await makeApi())(tripApi("/memories?limit=90"))).json) || {}).memories || []).length;
  const seen = [];
  let first = null;                 // 0b, read at 390
  const firstMade = new Set();      // 0b's upload, by id, removed below
  let was = null;                   // the trip's memories before 0b's upload
  try {
    // 1440 first: 0b, at 390, adds the trip's first photo.
    for (const [vw, vh] of held ? [] : [[1440, 900], [390, 844]]) {
      const e = await boot({ vw, vh, reduceMotion: true });
      try {
        if (vw === 390) await e.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });
        await plantInto(e.cdp, e.S);
        await e.cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/memories")}` }, e.S);
        await appSettled(e.cdp, e.S);
        await waitFor(e.cdp, e.S, `document.querySelector('.me-viewbtn[data-view="collage"]') ? 1 : 0`, { label: "the view toggle" });
        await evalIn(e.cdp, e.S, `(document.querySelector('.me-viewbtn[data-view="collage"]').click(), 1)`);
        await waitFor(e.cdp, e.S, `document.querySelector(".me-altempty") && document.querySelector(".cg-board") ? 1 : 0`, { label: "the empty board and its words", timeout: 20000 });
        await sleep(1500);
        seen.push(await J(e.cdp, e.S, `(() => { const bd = document.querySelector(".cg-board"), c = document.querySelector(".me-altempty").getBoundingClientRect();
          const r = bd.getBoundingClientRect(), k = r.width / bd.offsetWidth;
          const L = r.left + bd.clientLeft * k, T = r.top + bd.clientTop * k, R = L + bd.clientWidth * k, B = T + bd.clientHeight * k;
          const gap = Math.min(c.left - L, R - c.right, c.top - T, B - c.bottom);
          return { vw: ${vw}, card: [c.left, c.top, c.width, c.height].map(Math.round), cork: [L, T, R - L, B - T].map(Math.round), gap: Math.round(gap * 10) / 10,
            words: [...document.querySelectorAll(".me-altempty h2, .me-altempty .me-emptyadd")].filter((n) => n.getClientRects().length).map((n) => n.textContent.trim()) }; })()`));
        if (vw === 390) {
          // 0b. The card's Add photos, one photo, uploaded on this page (no reload: the board mounted empty).
          was = await memoryIds();
          // Add photos: the phone's picker first, answered with the photo, then its one sheet.
          await pickPhotos({ ...cdpPage(e.cdp, e.S), open: `document.querySelector(".me-altempty .me-emptyadd")`, files: [PHOTO] });
          await waitFor(e.cdp, e.S, `document.querySelectorAll(".me-pickrow").length === 1 ? 1 : 0`, { label: "one picked", timeout: 10000 });
          await evalIn(e.cdp, e.S, `([...document.querySelectorAll(".sh-root .sh-head .btn")].find((b) => /^Upload/.test(b.textContent)).click(), 1)`);
          const took = await waitFor(e.cdp, e.S, `document.querySelectorAll(".cg-item").length >= 1 && !document.querySelector(".me-altempty") && !document.querySelector(".sh-root") ? 1 : 0`, { label: "the first photo on the board", timeout: 60000 }).then(() => true, () => false);
          for (const id of await memoryIds()) if (!was.has(id)) firstMade.add(id);
          await sleep(1200);
          first = await J(e.cdp, e.S, `(() => { const st = document.querySelector('.me-stage[data-stage="collage"]'), s = st.getBoundingClientRect();
            const btns = [...st.querySelectorAll(":scope > .cg-look")].map((n) => { const r = n.getBoundingClientRect(); return { share: n.classList.contains("cg-look-share"), box: [r.left, r.top, r.right, r.bottom].map(Math.round),
              onStage: r.left >= s.left - 0.5 && r.right <= s.right + 0.5 && r.top >= s.top - 0.5 && r.bottom <= s.bottom + 0.5 }; });
            const t = document.querySelector('.me-viewbtn[data-view="feed"]'), tr = t.getBoundingClientRect(), hit = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
            const v = document.querySelector('.me-viewbtn[data-view="collage"]'), vr = v.getBoundingClientRect(), hit2 = document.elementFromPoint(vr.left + vr.width / 2, vr.top + vr.height / 2);
            return { took: ${took}, prints: document.querySelectorAll(".cg-item").length, stageTop: Math.round(s.top), buttons: btns, toggleFree: !!hit && (hit === t || t.contains(hit)) && !!hit2 && (hit2 === v || v.contains(hit2)) }; })()`);
        }
      } finally { await e.done().catch(() => {}); }
    }
  } catch (err) { seen.push({ stopped: String(err && err.message || err).slice(0, 200) }); }
  check("0. the empty board holds its words: \"No photos yet\" and Add photos on the cork, inside the frame by the margin, at 390 and 1440",
    !held && seen.length === 2 && seen.every((x) => x.gap >= EMPTY_MARGIN - 1 && x.words && x.words.includes("No photos yet") && x.words.includes("Add photos")),
    held ? `the trip already holds ${held} memories, so there is no empty board to read` : JSON.stringify(seen));
  check("0b. the first photo, added from the empty board's card at 390: Save or share and the appearance button stay on the board's stage, the view toggle free",
    !held && !!first && first.took && first.prints >= 1 && first.buttons.length === 2 && first.buttons.every((x) => x.onStage) && first.toggleFree,
    held ? "no empty board to add to" : JSON.stringify(first));
  if (was && !firstMade.size) { await sleep(3000); for (const id of await memoryIds()) if (!was.has(id)) firstMade.add(id); }
  if (firstMade.size) {
    const api = await makeApi();
    for (const id of firstMade) {
      const r = await api(tripApi(`/memories/${id}`), { method: "DELETE" });
      if (r.status !== 200 && r.status !== 404) console.log(`could not remove 0b's memory ${id}: ${r.status}`);
    }
  }
}

// 1c. A small board on a short screen: 3 photos of this check's own (removed after) at 320 x 568.
{
  let small = null;
  const few = await seedMemories(3);
  try {
    const e = await boot({ vw: 320, vh: 568, reduceMotion: true });
    try {
      await e.setInsets({ top: 20, right: 0, bottom: 0, left: 0 });
      await plantInto(e.cdp, e.S);
      await e.cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/memories")}` }, e.S);
      await appSettled(e.cdp, e.S);
      await waitFor(e.cdp, e.S, `document.querySelector('.me-viewbtn[data-view="collage"]') ? 1 : 0`, { label: "the view toggle" });
      await evalIn(e.cdp, e.S, `(document.querySelector('.me-viewbtn[data-view="collage"]').click(), 1)`);
      await waitFor(e.cdp, e.S, `document.querySelectorAll(".cg-item").length >= 3 ? 1 : 0`, { label: "the small board", timeout: 20000 });
      await sleep(1500);
      // Two boxes that overlap, not one height against another: a + beside the board is clear of it.
      small = await J(e.cdp, e.S, `(() => { const hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
        const bd = document.querySelector(".cg-board").getBoundingClientRect(), f = document.querySelector(".me-fab");
        const fr = f && f.getClientRects().length && getComputedStyle(f).display !== "none" ? f.getBoundingClientRect() : null;
        return { prints: document.querySelectorAll(".cg-item").length, board: [bd.left, bd.top, bd.right, bd.bottom].map(Math.round),
          fab: fr && [fr.left, fr.top, fr.right, fr.bottom].map(Math.round), clear: !!fr && !hit(fr, bd) }; })()`);
    } finally { await e.done().catch(() => {}); }
  } catch (err) { small = { stopped: String(err && err.message || err).slice(0, 200) }; }
  finally { await few.cleanup().catch(() => {}); }
  check("1c. a small board on a short screen (3 photos at 320 x 568) opens above the + button", !!small && small.prints >= 3 && small.clear, JSON.stringify(small));
}

const seed = await seedMemories(16);
let b = null;
let code = 1;
let madeBefore = null;      // the trip's memories before 5's upload
const uploaded = new Set(); // 5's upload, by id, noted while the trip holds only this check's 17 (the list pages at 40)
try {
  b = await boot({ vw: 390, vh: 844, reduceMotion: false });
  const { cdp, S } = b;
  await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });
  // A stored style from before every print went bare.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem("wgp.collage.look", JSON.stringify({ background: "corkboard", frame: "polaroid", perMemory: 0 })); } catch {}` }, S);
  await plantInto(cdp, S);
  const touch = async (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 6, radiusY: 6, force: 1, id: 1 }] }, S);
  const tap = async (sel) => {
    const p = await J(cdp, S, `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) throw new Error("nothing to tap: " + sel);
    await touch("touchStart", p.x, p.y); await sleep(60); await touch("touchEnd"); await sleep(700);
  };
  const still = () => evalIn(cdp, S, `new Promise((done) => { let last = "", same = 0; const t0 = performance.now();
    const f = () => { const n = document.querySelector(".cg-cam"); const k = n ? n.style.transform : "";
      same = k === last ? same + 1 : 0; last = k; if (same >= 8 || performance.now() - t0 > 4000) done(1); else requestAnimationFrame(f); }; requestAnimationFrame(f); })`);
  // The board and every print on the screen, and what of the board is in view.
  const READ = `(() => { const root = document.querySelector(".cg-root"); const bd = document.querySelector(".cg-board"); if (!root) return null;
    const r = root.getBoundingClientRect(); const B = bd ? bd.getBoundingClientRect() : null;
    const prints = [...document.querySelectorAll(".cg-item")].map((n) => n.getBoundingClientRect());
    const ix = B ? Math.max(0, Math.min(B.right, r.right) - Math.max(B.left, r.left)) : 0, iy = B ? Math.max(0, Math.min(B.bottom, r.bottom) - Math.max(B.top, r.top)) : 0;
    return { root: [r.left, r.top, r.width, r.height].map(Math.round), board: B ? [B.left - r.left, B.top - r.top, B.width, B.height].map(Math.round) : null,
      prints: prints.length, inside: !!B && prints.every((p) => p.left >= B.left - 1 && p.right <= B.right + 1 && p.top >= B.top - 1 && p.bottom <= B.bottom + 1),
      whole: !!B && B.left >= r.left - 1 && B.right <= r.right + 1 && B.top >= r.top - 1 && B.bottom <= r.bottom + 1,
      wallShows: !!B && (B.left - r.left > 2 || r.right - B.right > 2 || B.top - r.top > 2 || r.bottom - B.bottom > 2),
      fab: (() => { const f = document.querySelector(".me-fab"); if (!f || !f.getClientRects().length || getComputedStyle(f).display === "none") return null;
        const q = f.getBoundingClientRect(); return { top: Math.round(q.top), clear: !!B && B.bottom <= q.top + 0.5 }; })(),
      head: (() => { const hs = [...document.querySelectorAll(".cg-look")].filter((n) => n.getClientRects().length).map((n) => n.getBoundingClientRect());
        if (!hs.length || !B) return null; const over = hs.filter((q) => q.right > B.left && q.left < B.right);
        return { bottom: Math.round(Math.max(...hs.map((q) => q.bottom))), clear: over.every((q) => B.top >= q.bottom - 0.5) }; })(),
      seen: Math.round(ix * iy), frames: [...new Set([...document.querySelectorAll(".cg-item")].map((n) => n.dataset.frame))] }; })()`;

  // Zoomed all the way in at each corner of the board, then dragged hard outward: how much of the screen is board,
  // each way (fractions of the board's width and height on the screen).
  const corners = async (C, S2, read) => {
    const out = [];
    const r0 = await J(C, S2, read);
    const [rx, ry, rw, rh] = r0.root;
    for (const [fx, fy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const f = await J(C, S2, read);
      const [bx, by, bw, bh] = f.board;
      const px = Math.round(rx + bx + (fx ? bw - 3 : 3)), py = Math.round(ry + by + (fy ? bh - 3 : 3));
      for (let i = 0; i < 40; i++) { await C.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: px, y: py, deltaX: 0, deltaY: -120, modifiers: 2 }, S2); await sleep(20); }
      await sleep(300);
      const sx = Math.round(rx + rw / 2), sy = Math.round(ry + rh / 2), dx = fx ? -1 : 1, dy = fy ? -1 : 1;
      for (let k = 0; k < 3; k++) {
        await C.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: sx, y: sy, radiusX: 6, radiusY: 6, force: 1, id: 1 }] }, S2);
        for (let i = 1; i <= 12; i++) { await C.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: sx + dx * 50 * i, y: sy + dy * 50 * i, radiusX: 6, radiusY: 6, force: 1, id: 1 }] }, S2); await sleep(12); }
        await C.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, S2); await sleep(250);
      }
      await sleep(500);
      // Read at rest. A hard drag ends in a fling that coasts into the edge, and the camera springs back to its clamp
      // (collage.js: FRICTION ~700 ms, SPRING_W ~330 ms): read before it rests, on the 16-photo board it was still past
      // the clamp (0.486 to 0.496 of the screen at 750 ms, 0.498 to 0.500 at rest), and a corner went red now and then.
      // At rest: the camera's transform unchanged over four reads 50 ms apart; one that never rests in 4 s is red too.
      // k is the camera's scale, read from its matrix (the transform is a matrix, not scale()).
      const SHARE = `(() => { const r = document.querySelector(".cg-root").getBoundingClientRect(); const B = document.querySelector(".cg-board").getBoundingClientRect();
        return { w: Math.max(0, Math.min(B.right, r.right) - Math.max(B.left, r.left)) / r.width, h: Math.max(0, Math.min(B.bottom, r.bottom) - Math.max(B.top, r.top)) / r.height,
          k: new DOMMatrix(getComputedStyle(document.querySelector(".cg-cam")).transform).a, t: document.querySelector(".cg-cam").style.transform }; })()`;
      let g = await J(C, S2, SHARE), same = 0;
      for (let i = 0; i < 80 && same < 4; i++) { await sleep(50); const n = await J(C, S2, SHARE); same = n.t === g.t ? same + 1 : 0; g = n; }
      out.push({ corner: `${fx ? "right" : "left"}-${fy ? "bottom" : "top"}`, w: Math.round(g.w * 100) / 100, h: Math.round(g.h * 100) / 100, k: Number(Number(g.k).toFixed(2)), rest: same >= 4 });
      for (let i = 0; i < 40; i++) { await C.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: sx, y: sy, deltaX: 0, deltaY: 160, modifiers: 2 }, S2); await sleep(20); }
      await sleep(400);
    }
    return out;
  };
  const third = (cs) => cs.every((c) => c.rest && c.w >= 0.49 && c.h >= 0.49);

  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/memories")}` }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `document.querySelector('.me-viewbtn[data-view="collage"]') ? 1 : 0`, { label: "the view toggle" });
  await tap('.me-viewbtn[data-view="collage"]');
  await waitFor(cdp, S, `document.querySelectorAll(".cg-item").length >= 16 ? 1 : 0`, { label: "the board", timeout: 20000 });
  await still();
  const open = await J(cdp, S, READ);
  check("1. the board opens whole on its wall: its edge holds every print, all of it on the screen, wall round it, above the + button and below Save or share",
    !!open && !!open.board && open.inside && open.whole && open.wallShows && open.prints >= 16 && !!open.fab && open.fab.clear && !!open.head && open.head.clear, JSON.stringify(open));
  check("2. every print is bare, even with a stored \"polaroid\" style", !!open && open.frames.length === 1 && open.frames[0] === "bare", JSON.stringify(open && open.frames));

  // 3. hard drags in every direction, then zoomed in and dragged, then zoomed right out
  // With no board (the plant from before it) the rest has nothing to measure: said, and stopped there.
  if (!open || !open.board) throw new Error("no board on the page: 3, 4 and 5 can't be measured");
  const mid = { x: Math.round(open.root[0] + open.root[2] / 2), y: Math.round(open.root[1] + open.root[3] / 2) };
  const drag = async (dx, dy) => {
    await touch("touchStart", mid.x, mid.y);
    for (let i = 1; i <= 12; i++) { await touch("touchMove", mid.x + (dx * i) / 12, mid.y + (dy * i) / 12); await sleep(12); }
    await touch("touchEnd"); await sleep(300); await still();
  };
  const seenAfter = [];
  for (const [dx, dy] of [[600, 0], [-1200, 0], [0, 900], [0, -1800]]) { await drag(dx, dy); seenAfter.push((await J(cdp, S, READ)).seen); }
  for (let i = 0; i < 14; i++) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: mid.x, y: mid.y, deltaX: 0, deltaY: -80, modifiers: 2 }, S); await sleep(30); }
  await sleep(300); await still();
  for (const [dx, dy] of [[900, 900], [-1800, -1800]]) { await drag(dx, dy); seenAfter.push((await J(cdp, S, READ)).seen); }
  for (let i = 0; i < 30; i++) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: mid.x, y: mid.y, deltaX: 0, deltaY: 120, modifiers: 2 }, S); await sleep(25); }
  await sleep(400); await still();
  const out = await J(cdp, S, READ);
  const edge16 = await corners(cdp, S, READ);
  check("3. dragged hard every way some of the board shows; zoomed all the way in at each corner and dragged to the clamp, the board is at least half the screen each way; zoomed out, all of it",
    seenAfter.every((a) => a > 2000) && out.whole && third(edge16), JSON.stringify({ seenAfter, corners: edge16, zoomedOut: out.board, whole: out.whole }));

  // 4. Save image's board, for the same photos, against the app's
  const same = await J(cdp, S, `(async () => {
    const L = await import("/js/collage-layout.js"); const X = await import("/js/collage-export.js");
    const res = await fetch(location.pathname.replace(/\\/$/, "").replace(/^\\/t\\//, "/api/trips/") + "/memories", { credentials: "same-origin" });
    const rows = (await res.json()).memories || [];
    // The board's own seed, as memories.js reads it: the trip's collage_seed, else its id.
    const id = location.pathname.split("/")[2];
    const trip = await fetch("/api/trips/" + id, { credentials: "same-origin" }).then((r) => r.json()).catch(() => ({}));
    const t = trip.trip || trip;
    const lay = L.layoutCollage(L.mediaFromMemories(rows, { order: "chrono", perMemory: 0 }), { seed: (t && t.collage_seed) || id });
    const plan = X.planExport(lay, { theme: "light" });
    const bd = document.querySelector(".cg-board");
    return { app: bd ? [parseFloat(bd.style.left), parseFloat(bd.style.top), parseFloat(bd.style.width), parseFloat(bd.style.height)] : null,
      saved: plan.boardUnits ? [plan.boardUnits.x, plan.boardUnits.y, plan.boardUnits.w, plan.boardUnits.h] : null }; })()`);
  check("4. Save image draws the same board as the app, for the same photos", !!same.app && !!same.saved && same.app.every((v, i) => Math.abs(v - same.saved[i]) < 0.02),
    JSON.stringify(same));

  // 5. One more photo, by the Feed's add: the board grows, the prints glide, and rest exactly on the new layout.
  // The memory it makes is this check's: noted by id (the ones there before are known) and removed at the end.
  const before = await J(cdp, S, READ);
  madeBefore = await memoryIds();
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "" }, S);
  await evalIn(cdp, S, `(window.__grow = [], new MutationObserver((l) => { for (const m of l) if (m.target.classList && m.target.classList.contains("cg-board") && m.target.dataset.grow === "1") window.__grow.push(performance.now()); })
    .observe(document.querySelector(".cg-root"), { subtree: true, attributes: true, attributeFilter: ["data-grow", "style"] }), 1)`);
  await pickPhotos({ ...cdpPage(cdp, S), open: `document.querySelector("#rt-fixed .fab, .me-fab") || document.querySelector(".me-headadd")`, files: [PHOTO] });
  await waitFor(cdp, S, `document.querySelectorAll(".me-pickrow").length === 1 ? 1 : 0`, { label: "one picked", timeout: 10000 });
  await evalIn(cdp, S, `([...document.querySelectorAll(".sh-root .sh-head .btn")].find((b) => /^Upload/.test(b.textContent)).click(), 1)`);
  const grew = await waitFor(cdp, S, `document.querySelectorAll(".cg-item").length >= 17 ? 1 : 0`, { label: "the added photo on the board", timeout: 60000 }).then(() => true, () => false);
  await sleep(900); await still();
  for (const id of await memoryIds()) if (!madeBefore.has(id)) uploaded.add(id);
  const after = await J(cdp, S, READ);
  const rest = await J(cdp, S, `(() => { const bad = [...document.querySelectorAll(".cg-item")].filter((n) => {
      const a = new DOMMatrix(getComputedStyle(n).transform), want = new DOMMatrix(n.style.transform);
      return Math.abs(a.e - want.e) > 0.5 || Math.abs(a.f - want.f) > 0.5 || Math.abs(a.a - want.a) > 1e-3 || n.getAnimations().length; });
    return { prints: document.querySelectorAll(".cg-item").length, offPlace: bad.length, grewMarks: (window.__grow || []).length }; })()`);
  check("5. a photo added: the board grows, the prints glide, and every one rests exactly on the new layout, inside the board",
    grew && after.inside && rest.offPlace === 0 && rest.prints >= 17 && after.board && before.board,
    JSON.stringify({ before: before.board, after: after.board, rest }));

  // 3b. The same at 40 and at 200 photos: a fresh page for each, after more memories are seeded.
  await b.done(); b = null;
  for (const n of [40, 200]) {
    const more = await seedMemories(n - 17 > 0 ? n - 17 : 0);
    const p = await boot({ vw: 390, vh: 844, reduceMotion: true });
    try {
      await p.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });
      await plantInto(p.cdp, p.S);
      await p.cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/memories")}` }, p.S);
      await appSettled(p.cdp, p.S);
      await waitFor(p.cdp, p.S, `document.querySelector('.me-viewbtn[data-view="collage"]') ? 1 : 0`, { label: "the view toggle" });
      await evalIn(p.cdp, p.S, `(document.querySelector('.me-viewbtn[data-view="collage"]').click(), 1)`);
      await waitFor(p.cdp, p.S, `document.querySelectorAll(".cg-item").length >= ${Math.min(n, 30)} ? 1 : 0`, { label: `the board of ${n}`, timeout: 60000 });
      await sleep(1500);
      const cs = await corners(p.cdp, p.S, READ);
      check(`3b. ${n} photos: zoomed all the way in at each corner and dragged to the clamp, the board is at least half the screen each way`, third(cs), JSON.stringify(cs));
    } finally { await p.done().catch(() => {}); await more.cleanup().catch(() => {}); }
  }

  console.log(`\n${pass} passed, ${fail} failed${PLANT_POS ? " (PLANTED: the board's stage positioned only while empty)" : PLANT_EMPTY ? " (PLANTED: the empty card left in the screen's middle)" : PLANT_HEAD ? " (PLANTED: no head band for Save or share)" : PLANT_FOOTCAP ? " (PLANTED: the foot band's ceiling at 30%)" : PLANT_FAB ? " (PLANTED: no inset for the + button)" : PLANT_CLAMP ? " (PLANTED: the first clamp, the whole band)" : PLANT_SPRING ? " (PLANTED: a spring back that takes seconds)" : PLANT ? " (PLANTED: the board's files from before)" : ""}`);
  if (fail) console.log(`failed: ${failures.join(" | ")}`);
  code = fail ? 1 : 0;
} catch (e) {
  console.log(`\nSTOPPED: ${e?.stack || e}\n${pass} passed, ${fail} failed before it stopped`);
} finally {
  if (b) await b.done().catch(() => {});
  if (madeBefore) {
    try {
      // Still in flight when 5 read the list: one more look, while the 3b memories may be gone or not yet made.
      if (!uploaded.size) for (const id of await memoryIds()) if (!madeBefore.has(id)) uploaded.add(id);
      const api = await makeApi();
      for (const id of uploaded) {
        const r = await api(tripApi(`/memories/${id}`), { method: "DELETE" });
        if (r.status !== 200 && r.status !== 404) console.log(`could not remove the uploaded memory ${id}: ${r.status}`);
      }
    } catch (e) { console.log("could not remove the uploaded memory: " + e.message); }
  }
  await seed.cleanup().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);

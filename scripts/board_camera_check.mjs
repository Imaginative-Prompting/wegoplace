#!/usr/bin/env node
/* The board stays where the person left it: panned, then the Feed looked at, then the board again, every print
 * is where it was on the screen. On the gate's made-up trip, with six memories of its own (removed afterwards),
 * at 390, by a real drag and real taps.
 *
 *   node scripts/gate.mjs --who <session> --only board_camera
 *
 * WHAT IT PROVES
 *   1. The drag really moved the board (a print's place on the screen changed by more than 40 px): the control.
 *   2. Feed, then the board again: that print is back where the drag left it, within a pixel.
 *
 *   3. The first Collage after a reload, with its entrance (motion on), fits the board as the same board fits with no
 *      entrance at all (reduced motion): the same prints, each the same width on the screen, within half a pixel.
 *
 * PLANTED: BOARDCAM_PLANT=1 serves collage.js as it was before (BEFORE): the board, measured at 1×1 while the Feed
 * was over it, comes back somewhere else (2), and the fit measured mid-entrance is about 2% off (3).
 */
import { execFileSync } from "node:child_process";
import { BASE, REPO, appSettled, boot, evalIn, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { seedMemories } from "./lib/seed_memories.mjs";
import { tripPath } from "./lib/gate_trip.mjs";

// BOARDCAM_PLANT=1: collage.js as it was before (BEFORE). BOARDCAM_PLANT=measure: today's collage.js with measure()
// measuring a hidden board again (its first line taken out): the zoom survives the Feed, the place doesn't (2 red).
const PLANT = !!process.env.BOARDCAM_PLANT;
const PLANT_MEASURE = process.env.BOARDCAM_PLANT === "measure";
const plantedCollage = () => PLANT_MEASURE
  ? execFileSync("cat", ["public/js/collage.js"], { cwd: REPO, encoding: "utf8" }).replace(/^    if \(root\.offsetWidth <= 1 \|\| root\.offsetHeight <= 1\) return;\n/m, "")
  : execFileSync("git", ["show", `${BEFORE}:public/js/collage.js`], { cwd: REPO, encoding: "utf8" });
const BEFORE = "f5c5627";

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 600) : ""}`); }
};
const J = async (c, S, e) => JSON.parse(await evalIn(c, S, `Promise.resolve(${e}).then((v) => JSON.stringify(v))`));

const seed = await seedMemories(6);
let b = null;
let code = 1;
try {
  // Motion on: the view's fade keeps the board's stage hidden while the board is handed its rows again, where a lost place shows.
  b = await boot({ vw: 390, vh: 844, reduceMotion: false });
  const { cdp, S } = b;
  await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });
  if (PLANT) {
    const old = plantedCollage();
    cdp.on((m) => {
      if (m.sessionId !== S || m.method !== "Fetch.requestPaused") return;
      cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }],
        body: Buffer.from(old).toString("base64") }, S).catch(() => {});
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/collage.js*" }] }, S);
  }
  const touch = async (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 6, radiusY: 6, force: 1, id: 1 }] }, S);
  const tap = async (sel) => {
    const p = await J(cdp, S, `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) throw new Error("nothing to tap: " + sel);
    await touch("touchStart", p.x, p.y); await sleep(60); await touch("touchEnd"); await sleep(700);
  };
  // Where a print is on the screen, and how wide (its zoom).
  // The same print every time (the board rebuilds its nodes in another order after the Feed: the first in the page is
  // not always the same print).
  let followed = null;
  const where = () => J(cdp, S, `(() => { const n = document.querySelector(${JSON.stringify(followed ? `.cg-item[data-id="${followed}"]` : ".cg-item")}); const r = n && n.getBoundingClientRect(); const root = document.querySelector(".cg-root");
    return r ? { id: n.dataset.id, x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, board: root ? [root.offsetWidth, root.offsetHeight] : null } : null; })()`);
  const still = () => evalIn(cdp, S, `new Promise((done) => { let last = "", same = 0; const t0 = performance.now();
    const f = () => { const n = document.querySelector(".cg-item"); const r = n && n.getBoundingClientRect(); const k = r ? [r.x, r.y].map(Math.round).join() : "";
      same = k === last ? same + 1 : 0; last = k; if (same >= 8 || performance.now() - t0 > 4000) done(1); else requestAnimationFrame(f); }; requestAnimationFrame(f); })`);

  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/memories")}` }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `document.querySelector('.me-viewbtn[data-view="collage"]') ? 1 : 0`, { label: "the view toggle" });
  await tap('.me-viewbtn[data-view="collage"]');
  await waitFor(cdp, S, `document.querySelectorAll(".cg-item").length >= 6 ? 1 : 0`, { label: "the board" });
  await still();
  const fitted = await where();
  followed = fitted && fitted.id;
  // Zoom in first (a wheel with ctrl held, as a trackpad's pinch reaches the page): away from the whole board, where
  // the pan has more than one legal place and a lost place shows.
  const mid = await J(cdp, S, `(() => { const r = document.querySelector(".cg-item").parentElement.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  for (let i = 0; i < 6; i++) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: mid.x, y: mid.y, deltaX: 0, deltaY: -60, modifiers: 2 }, S); await sleep(40); }
  await sleep(400);
  await still();
  const start = await where();
  // A real drag across the board: down and to the left, slowly, so it ends where the finger lifts.
  const host = await J(cdp, S, `(() => { const r = document.querySelector(".cg-item").closest("[data-bg], .cg-root, .me-stage")?.getBoundingClientRect() || { x: 0, y: 200, width: 390, height: 500 }; return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  await touch("touchStart", host.x, host.y);
  for (let i = 1; i <= 16; i++) { await touch("touchMove", host.x - i * 6, host.y + i * 5); await sleep(16); }
  await touch("touchEnd"); await sleep(400);
  await still();
  const panned = await where();
  const moved = Math.hypot(panned.x - start.x, panned.y - start.y);
  check("1. the board zoomed in past the whole board, and the drag moved it (the controls)", start && panned && fitted && panned.id === start.id && start.w > fitted.w * 1.3 && moved > 40,
    JSON.stringify({ fitted, start, panned, moved: Math.round(moved) }));

  await tap('.me-viewbtn[data-view="feed"]');
  await sleep(900);
  const hidden = await J(cdp, S, `(() => { const n = document.querySelector(".cg-item"); const r = n && n.getBoundingClientRect(); return r ? { w: r.width, h: r.height } : null; })()`);
  await tap('.me-viewbtn[data-view="collage"]');
  await sleep(500);
  await still();
  const back = await where();
  const off = back && panned ? Math.hypot(back.x - panned.x, back.y - panned.y) : Infinity;
  check("2. Feed, then the board again: the print is where the drag left it, within a pixel, at the same zoom", back && back.id === panned.id && off <= 1 && Math.abs(back.w - panned.w) <= 0.5,
    JSON.stringify({ panned, back, off: Math.round(off * 10) / 10, whileHidden: hidden }));

  await b.done(); b = null;

  // 3. The first open's fit with the entrance (motion on) against the fit with none (reduced motion).
  const widthOnOpen = async (reduceMotion) => {
    const p = await boot({ vw: 390, vh: 844, reduceMotion });
    try {
      await p.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });
      if (PLANT) {
        const old = plantedCollage();
        p.cdp.on((m) => { if (m.sessionId === p.S && m.method === "Fetch.requestPaused") p.cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }], body: Buffer.from(old).toString("base64") }, p.S).catch(() => {}); });
        await p.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/collage.js*" }] }, p.S);
      }
      await p.cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/memories")}` }, p.S);
      await appSettled(p.cdp, p.S);
      await waitFor(p.cdp, p.S, `document.querySelector('.me-viewbtn[data-view="collage"]') ? 1 : 0`, { label: "the view toggle" });
      await evalIn(p.cdp, p.S, `(document.querySelector('.me-viewbtn[data-view="collage"]').click(), 1)`);
      await waitFor(p.cdp, p.S, `document.querySelectorAll(".cg-item").length >= 6 ? 1 : 0`, { label: "the board" });
      await sleep(2500);
      // Every print's width, by id: the page's order of the prints is not the board's (it differs between two opens).
      return await J(p.cdp, p.S, `Object.fromEntries([...document.querySelectorAll(".cg-item")].map((n) => [n.dataset.id, Math.round(n.getBoundingClientRect().width * 100) / 100]))`);
    } finally { await p.done(); }
  };
  const movingAll = await widthOnOpen(false), restingAll = await widthOnOpen(true);
  const ids = Object.keys(movingAll || {}).sort(), same = ids.join() === Object.keys(restingAll || {}).sort().join();
  const worst = ids.reduce((w, id) => { const d = Math.abs(movingAll[id] - (restingAll[id] ?? Infinity)); return d > w.d ? { id, d } : w; }, { id: null, d: 0 });
  const moving = { id: worst.id || ids[0], w: movingAll[worst.id || ids[0]] }, resting = { id: moving.id, w: restingAll[moving.id] };
  check("3. the first Collage after a reload fits as it does with no entrance: every print the same width, within half a pixel",
    ids.length >= 6 && same && worst.d <= 0.5, JSON.stringify({ prints: ids.length, samePrints: same, widest: { moving, resting, ratio: moving.w && resting.w ? Math.round(moving.w / resting.w * 10000) / 10000 : null } }));

  console.log(`\n${pass} passed, ${fail} failed${PLANT ? " (PLANTED: collage.js from before)" : ""}`);
  if (fail) console.log(`failed: ${failures.join(" | ")}`);
  code = fail ? 1 : 0;
} catch (e) {
  console.log(`\nSTOPPED: ${e?.stack || e}\n${pass} passed, ${fail} failed before it stopped`);
} finally {
  if (b) { try { await b.done(); } catch { /* gone */ } }
  await seed.cleanup().catch(() => {});
}
process.exit(code);

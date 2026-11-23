#!/usr/bin/env node
/* A SHEET GROWS WITH THE SYSTEM'S MOTION (public/js/sheet.js: the sheet follows its content). When a sheet's content
 * grows after a request, the sheet eases to its new height instead of jumping in one frame (20 Nov, on the board: "Create
 * a share link" finished and everything below the link moved ~240 px at once). The gate's made-up trip, its host, 390.
 *
 *   1. THE BOARD'S SHARE SHEET: its link arriving (the field it shows) grows the sheet. Its height, sampled every frame,
 *      takes more than two values on the way, never passes where it ends, and ends at the sheet's own height.
 *   2. A SHEET GROWING BY ANY ROW (a plan's sheet, a 240 px block put in its body): the same, and a tap at a field's
 *      middle while it moves still reaches the field (nothing blocks a tap).
 *   3. A PLAN'S SHEET AS ITS DAY AND TIME ARE SET: a tap at Add's middle at any frame of the move lands on the sheet (no
 *      veil, never swallowed); the move is over within 400 ms; what lies under Add's old place, and any frame where Add's
 *      middle shows something else, is said.
 *   4. WITH REDUCED MOTION it simply arrives: one step, no values between.
 * In 1, the link focused and selected to copy (read-only) leaves the scrim translucent; in 3, the plan's title field
 * focused turns it solid at once. Every move (1, 2) is over within 400 ms. The Board's photos are its own (seedMemories), removed at the end.
 *
 * Planted: SHEETGROW_PLANT=jump serves sheet.js without the observer (1, 2 and 3 red: two heights, the jump);
 * =readonly serves it counting a read-only field as typing (1's scrim red: the ground in one frame).
 *
 *   node scripts/gate.mjs --only sheet_grow_check
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, boot, evalIn, waitFor, sleep, appSettled, signInAs } from "./lib/standalone_cdp.mjs";
import { tripPath, HOST } from "./lib/gate_trip.mjs";
import { seedMemories } from "./lib/seed_memories.mjs";

const PLANT = process.env.SHEETGROW_PLANT || "";
if (PLANT && PLANT !== "jump" && PLANT !== "readonly") throw new Error(`no such plant: ${PLANT}`);
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// The sheet's height every frame for 900 ms after `grow` runs: the values it took, in order, and where it ended.
const SAMPLE = (grow) => `new Promise((ok) => {
  const sheet = document.querySelector(".sh-root[data-open='1'] .sh-sheet");
  const start = sheet.offsetHeight, seen = [start];
  (${grow})();
  const t0 = performance.now();
  let doneMs = 0;
  const tick = () => {
    const h = Math.round(sheet.getBoundingClientRect().height);
    if (h !== seen[seen.length - 1]) { seen.push(h); doneMs = Math.round(performance.now() - t0); }
    if (performance.now() - t0 < 900) requestAnimationFrame(tick);
    else ok(JSON.stringify({ start, seen, doneMs, end: Math.round(sheet.getBoundingClientRect().height), natural: sheet.scrollHeight }));
  };
  requestAnimationFrame(tick);
})`;
const judge = (name, m) => {
  const steps = m.seen.length, over = m.seen.some((h) => h > m.end + 1);
  check(`${name}: the sheet grows over several frames (${steps} heights from ${m.start} to ${m.end}), never past where it ends`,
    m.end - m.start > 40 && steps > 3 && !over, JSON.stringify(m.seen.slice(0, 30)));
  // Safe under a thumb: the move is over quickly, so nothing travels for long under a finger.
  check(`${name}: the move is over within 400 ms (${m.doneMs} ms)`, m.doneMs > 0 && m.doneMs <= 400, JSON.stringify({ doneMs: m.doneMs }));
};

const b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: false });
const { cdp, S } = b;
const ev = (e) => evalIn(cdp, S, e);
if (PLANT) {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/js/sheet.js"), "utf8");
  const t = PLANT === "readonly" ? src.replace("    if (a.readOnly || a.disabled) return false;\n", "") : src.replace("  if (follow) follow.observe(sheet);\n", "");
  if (t === src) throw new Error("the jump plant didn't take");
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(t).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/sheet.js*" }] }, S);
}
const go = async (hash, ready) => {
  await cdp.send("Page.navigate", { url: "about:blank" }, S);
  await sleep(100);
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath(hash)}` }, S);
  await appSettled(cdp, S).catch(() => {});
  await waitFor(cdp, S, `${ready} ? 1 : 0`, { label: hash, timeout: 30000 });
  await sleep(800);
};
// The scrim's color and the page's ground, as computed colors, so the two can be compared.
const SCRIM = `JSON.stringify((() => { const sc = document.querySelector(".sh-root[data-open='1'] .sh-scrim"), t = document.createElement("div");
  t.style.color = "var(--ground)"; document.body.append(t); const ground = getComputedStyle(t).color; t.remove();
  return { scrim: sc ? getComputedStyle(sc).backgroundColor : null, ground, focused: document.activeElement && (document.activeElement.className || document.activeElement.tagName) }; })())`;
// A plan's sheet: the visible "Add a plan" (at 390 the Itinerary's own head button is hidden; the floating one shows).
const openPlan = async () => {
  await go("#/", `document.querySelector("#view .ag-day")`);
  await ev(`(() => { const x = [...document.querySelectorAll("[data-plan-add]")].find((y) => y.getClientRects().length); x.click(); return 1; })()`);
  await entered();
  await sleep(400);
};
const entered = () => waitFor(cdp, S, `document.querySelector(".sh-root[data-entered='1']") ? 1 : 0`, { label: "the sheet arrived", timeout: 10000 });
// The board's own photos: the gate's trip has none of its own once the board checks have cleaned up theirs (21 Nov: this
// check found an empty Board and waited 30 s for a photo that was never there).
let seed = null;
try {
  seed = await seedMemories(2, { tag: "sheet grow" });
  await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });
  await signInAs(cdp, S, HOST.key);

  section("1. The board's share sheet, its link arriving");
  await ev(`(localStorage.setItem("wgp.memview", "collage"), 1)`);
  await go("#/memories", `document.querySelectorAll(".cg-item").length > 0`);
  const opened = await ev(`(() => { const x = [...document.querySelectorAll(".cg-look")].find((y) => /share/i.test(y.textContent) && y.getClientRects().length); if (!x) return 0; x.click(); return 1; })()`);
  check("the board's Save or share opens its sheet", !!opened);
  if (opened) {
    await entered();
    await sleep(400);
    const m = JSON.parse(await ev(SAMPLE(`() => { const f = document.querySelector(".sh-root .me-frout"); f.hidden = false;
      document.querySelector(".sh-root .cg-shareurl").value = "${BASE}/b/made-up-share-link"; document.querySelector(".sh-root .cg-lookstat").textContent = "Anyone with this link sees the board."; }`)));
    judge("the link arriving", m);
    // The app focuses and selects the link to copy (memories.js); a read-only field raises no keyboard, so the scrim stays
    // translucent: the page above the sheet never turns to the ground in one frame (21 Nov, the film's pop).
    const sc = JSON.parse(await ev(`new Promise((ok) => { const f = document.querySelector(".sh-root .cg-shareurl"); f.focus(); f.select();
      requestAnimationFrame(() => requestAnimationFrame(() => ok(${SCRIM}))); })`));
    check("the link focused and selected to copy: the scrim stays translucent, not the ground", !!sc.scrim && sc.scrim !== sc.ground && /cg-shareurl/.test(sc.focused || ""), JSON.stringify(sc));
  }

  // (Packing's New item sheet was this case until 21 Nov; it now stands at its tallest, its list scrolling inside, so a
  // row put in can't grow it: a plan's sheet has the room.)
  section("2. A sheet growing by any row: a plan's sheet");
  await openPlan();
  const m2 = JSON.parse(await ev(SAMPLE(`() => { const d = document.createElement("div"); d.style.height = "240px"; d.dataset.grown = "1";
    document.querySelector(".sh-root .sh-body").prepend(d); }`)));
  judge("a 240 px row put in", m2);
  // A tap while it moves: the sheet's first field takes it (no veil, no pointer-events off).
  await ev(`(() => { document.querySelector(".sh-root [data-grown]").remove(); return 1; })()`);
  await sleep(700);
  const tap = JSON.parse(await ev(`new Promise((ok) => { const d = document.createElement("div"); d.style.height = "240px";
    document.querySelector(".sh-root .sh-body").append(d);
    requestAnimationFrame(() => requestAnimationFrame(() => { const f = document.querySelector(".sh-root .sh-body input, .sh-root .sh-body textarea");
      const r = f.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      ok(JSON.stringify({ moving: document.querySelector(".sh-root").dataset.settle === "1", reaches: hit === f || f.contains(hit) })); })); })`));
  check("  while it moves, a tap at a field's middle reaches the field", tap.reaches, JSON.stringify(tap));

  section("3. A plan's sheet growing as its day and time are set, and a tap on Add while it moves");
  await ev(`(document.querySelector(".sh-root [data-act='close'], .sh-root .sh-close")?.click(), 1)`);
  await sleep(500);
  await openPlan();
  // Day and time set as a person does; every frame: where Add is, and what lies at the middle of where Add WAS (what a
  // thumb aimed at the old place would meet), until it holds still.
  const plan = JSON.parse(await ev(`new Promise((ok) => {
    const add = document.querySelector('.sh-root [data-act="save"]'), r0 = add.getBoundingClientRect(), x0 = r0.left + r0.width / 2, y0 = r0.top + r0.height / 2;
    const day = document.querySelector(".sh-root .pe-day"); if (day) day.click();
    const t = document.getElementById("pe-time"); if (t) { t.value = "19:30"; t.dispatchEvent(new Event("input", { bubbles: true })); t.dispatchEvent(new Event("change", { bubbles: true })); }
    const CTRL = "button, a, input, textarea, select, [role=button], [role=radio], [tabindex]:not([tabindex='-1'])";
    const name = (n) => { if (!n) return "nothing"; const c = n.closest(CTRL); if (c) return (c.getAttribute("aria-label") || c.textContent.trim().slice(0, 30) || c.tagName) + " (control)"; return n.className ? String(n.className).slice(0, 30) : n.tagName; };
    const t0 = performance.now(), at = [];
    const root = document.querySelector(".sh-root[data-open='1']");
    let reachedAll = true, inSheet = true, last = r0.top, doneMs = 0, firstMiss = null;
    const desc = (n) => n ? n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + "." + String(n.className).split(" ").slice(0, 2).join(".") + " «" + (n.textContent || "").trim().slice(0, 20) + "»" : "nothing";
    const tick = () => {
      const r = add.getBoundingClientRect(), hitNow = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hitNow || !root.contains(hitNow)) inSheet = false;
      if (!(hitNow === add || add.contains(hitNow))) { if (reachedAll) firstMiss = { at: Math.round(performance.now() - t0), hit: desc(hitNow), add: desc(add), addRect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }; reachedAll = false; }
      const old = name(document.elementFromPoint(x0, y0));
      if (!at.length || at[at.length - 1] !== old) at.push(old);
      if (Math.round(r.top) !== Math.round(last)) { last = r.top; doneMs = Math.round(performance.now() - t0); }
      if (performance.now() - t0 < 900) requestAnimationFrame(tick);
      else ok(JSON.stringify({ moved: Math.round(r0.top - r.top), doneMs, reachedAll, inSheet, firstMiss, atOldPlace: at }));
    };
    requestAnimationFrame(tick);
  })`));
  console.log(`  note  the plan sheet: Add moved ${plan.moved} px in ${plan.doneMs} ms; under Add's old place, in turn: ${plan.atOldPlace.join(" → ")}`);
  if (!plan.reachedAll) console.log(`  note  at ${plan.firstMiss.at} ms a tap at Add's middle met ${plan.firstMiss.hit} (Add at ${plan.firstMiss.addRect.join(",")})`);
  // A tap lands on whatever the sheet shows under the finger at that instant: nothing over it, no veil, never swallowed.
  check("  a tap at Add's middle at any frame of the move lands on the sheet itself (no veil, never swallowed)", plan.inSheet, JSON.stringify(plan));
  check("  the plan sheet's move is over within 400 ms", plan.doneMs <= 400, JSON.stringify({ doneMs: plan.doneMs, moved: plan.moved }));
  // The rule the read-only case must not break: a real text field taking focus turns the scrim solid at once.
  const typed = JSON.parse(await ev(`new Promise((ok) => { document.getElementById("pe-title").focus(); requestAnimationFrame(() => requestAnimationFrame(() => ok(${SCRIM}))); })`));
  check("  its title field focused: the scrim is the ground at once (the keyboard is coming)", typed.scrim === typed.ground, JSON.stringify(typed));
  await ev(`(document.activeElement && document.activeElement.blur(), 1)`);
  await ev(`(document.querySelector(".sh-root [data-act='close'], .sh-root .sh-close")?.click(), 1)`);
  await sleep(500);

  section("4. With reduced motion it simply arrives");
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
  await openPlan();
  const m3 = JSON.parse(await ev(SAMPLE(`() => { const d = document.createElement("div"); d.style.height = "240px"; document.querySelector(".sh-root .sh-body").prepend(d); }`)));
  check(`reduced motion: from ${m3.start} to ${m3.end} in one step`, m3.end - m3.start > 60 && m3.seen.length === 2, JSON.stringify(m3.seen));
  console.log(`\npage errors: ${b.pageErrors.length ? b.pageErrors.join(" | ").slice(0, 300) : "none"}`);
} catch (e) {
  fail++; failures.push(`threw: ${e.message}`); console.log(`  FAIL  threw: ${e.stack || e}`);
} finally {
  await seed?.cleanup().catch(() => {});
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  FAILED  ${f}`); process.exit(1); }

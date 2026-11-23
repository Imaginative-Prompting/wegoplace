#!/usr/bin/env node
/* V5 item 9 — "WHEN THE KEYBOARD OPENS, NOTHING MOVES EXCEPT THE INSIDE OF THE SHEET",
 * measured through REAL INPUT, and honest about the one thing it cannot measure.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE REPLACED THE SYNTHETIC KEYBOARD HARNESS (pack_keyboard_harness.js, retired)
 *
 * That harness reported 92/92 on a build then found broken on a phone, and the reason is worth
 * writing down rather than repeating: it triggered every behaviour SYNTHETICALLY. It shadowed
 * the visualViewport getters and dispatched the events itself, and it assigned scrollTop by
 * hand to "play iOS's attack". Both are descriptions of iOS written in JavaScript, so what
 * they proved is that sheet.js agrees with the harness's description — not that it survives
 * a thumb. It is kept, because exercising the measurement path is worth something; it just
 * cannot be the thing that says a fix is done.
 *
 * EVERYTHING HERE IS A REAL EVENT. Scrolling is a real touch flick, with real momentum, out
 * of Input.dispatchTouchEvent. Every button and every field is reached by a real tap at real
 * coordinates. The one reveal that walks scroll ancestors — the engine's own, the one iOS
 * uses for the keyboard — is triggered by a real Tab keypress onto a field that is genuinely
 * outside its scrollport, which is the same code path and is also a real user flow (iOS's
 * keyboard next/previous arrows dispatch exactly this). Nothing in this file assigns a scroll
 * offset, and nothing in this file redefines a browser API.
 *
 * WHAT IT CANNOT PROVE, STATED UP FRONT. Headless Chrome has no software keyboard. So the
 * iOS-specific half — visualViewport.height shrinking (and, MEASURED ON iOS 26, window.inner-
 * Height shrinking WITH it, which this file previously stated the opposite of: 714 -> 377 with
 * the keys up, vv.offsetTop 0 -> 337), and
 * WebKit sliding the LAYOUT viewport up and reporting it as visualViewport.offsetTop — cannot
 * be produced honestly here at all. Arm C emulates it and is REPORTED SEPARATELY AND NOT
 * COUNTED, for exactly the reason above. What Arms A, B and D do prove is the part that is
 * common to every engine: that the page cannot be moved by a real gesture, by a real focus,
 * by the engine's own ancestor-walking reveal, or by a real viewport resize.
 *
 * MEASURED IN SCREEN COORDINATES, NOT CLIENT ONES. getBoundingClientRect() is relative to the
 * LAYOUT viewport, and the whole of the iOS failure is the layout viewport moving under a
 * page that is trying to stand still. A client rect that holds while the layout viewport
 * slides is a page that moved on the glass; a client rect that CHANGES by exactly the offset
 * is a page that did not. So every assertion below is on (rect.y - visualViewport.offsetTop),
 * which is where the pixel actually is on the screen — which is what the eye measures.
 *
 * Dev-only. scripts/ is outside pages_build_output_dir, so nothing here ships.
 *
 *   this lane's dev server must be running; WGP_BASE=http://127.0.0.1:<port> says where
 *   node scripts/pack_kb_real_harness.js
 *
 * No dependencies: Node 22+ has a global WebSocket and fetch, which is the whole CDP client.
 */
const { baseUrl, launchChrome } = require("./lib/browser.mjs");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const ORIGIN = baseUrl();   // WGP_BASE or --base=<url>: this lane's dev server (scripts/lib/browser.mjs)
const HOST = new URL(ORIGIN).hostname;

const W = 390, H = 844;          // iPhone 14-ish, the phone in hand
const KB = 336;                  // a real iOS keyboard on that screen

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const emulated = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
// Arm C only. Kept out of the count on purpose — see the header.
function note(name, ok, detail) {
  emulated.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "  ok" : "  XX"}  [emulated, not counted] ${name}${detail ? "  — " + detail : ""}`);
}

function cookie() {
  const vars = fs.readFileSync(path.join(REPO, ".dev.vars"), "utf8");
  const m = /^AUTH_SECRET\s*=\s*(.+)$/m.exec(vars);
  if (!m) throw new Error("no AUTH_SECRET in .dev.vars");
  const secret = m[1].trim().replace(/^["']|["']$/g, "");
  const msg = `u_admin.${Math.floor(Date.now() / 1000) + 3600}`;
  return `${msg}.${crypto.createHmac("sha256", secret).update(msg).digest("hex")}`;
}

// ── CDP ────────────────────────────────────────────────────────────────────────────────
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      }
    });
    ws.addEventListener("error", () => reject(new Error("websocket failed")));
    ws.addEventListener("open", () => resolve({
      send(method, params = {}) {
        const mid = ++id;
        return new Promise((res, rej) => {
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close() { try { ws.close(); } catch { /* already gone */ } },
    }));
  });
}

async function launch() {
  // The shared launcher: Chrome for Testing, headless, muted, on a port read from its own
  // fresh profile (scripts/lib/browser.mjs). It is the only thing that starts a browser.
  const browser = await launchChrome({ args: [
    "--hide-scrollbars",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", "about:blank",
  ] });
  const target = await browser.pageTarget();
  const c = await connect(target.webSocketDebuggerUrl);
  c.kill = () => browser.close();
  return c;
}

async function evaluate(c, expression) {
  const r = await c.send("Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error("eval threw: " + ((r.exceptionDetails.exception || {}).description
      || r.exceptionDetails.text));
  }
  return r.result.value;
}

// ── real input ─────────────────────────────────────────────────────────────────────────
const point = (x, y) => [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 0 }];

async function tap(c, x, y) {
  await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(x, y) });
  await sleep(60);
  await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(120);
}

async function press(c, x, y, ms) {
  await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(x, y) });
  await sleep(ms);
  await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(120);
}

// A REAL flick, with real momentum: touchStart, a stream of touchMoves, touchEnd, and then
// whatever the compositor decides to do about it. Nothing here assigns scrollTop, which is
// the difference between this and every harness that has passed on a broken build.
async function flick(c, x, y0, y1, steps, stepMs) {
  await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(x, y0) });
  for (let i = 1; i <= steps; i++) {
    await c.send("Input.dispatchTouchEvent",
      { type: "touchMove", touchPoints: point(x, y0 + (y1 - y0) * i / steps) });
    await sleep(stepMs);
  }
  await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function key(c, code, keyName) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await c.send("Input.dispatchKeyEvent",
      { type, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, key: keyName });
  }
  await sleep(150);
}

// Centre of the FIRST match that is actually on screen, in layout-viewport coordinates, or
// null if none is. The "on screen" part is not fussiness: a tap dispatched at an off-screen
// point lands on whatever IS at those coordinates, so a harness that guesses is quietly
// testing a different element than the one it names. The list is long and mostly scrolled
// past, so querySelector() alone picks a row nobody can see.
// `bot` is the margin kept clear at the foot of the screen: 70 for controls in the PAGE, so
// a tap never lands on the tab bar that overlaps it, and 4 for controls inside a sheet, whose
// pinned footer legitimately sits over that bar.
async function centre(c, sel, bot = 70) {
  return evaluate(c, `(() => {
    for (const e of document.querySelectorAll(${JSON.stringify(sel)})) {
      const b = e.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) continue;
      const y = b.y + b.height / 2, x = b.x + b.width / 2;
      if (b.top < 8 || b.bottom > window.innerHeight - ${bot}) continue;
      if (x < 0 || x > window.innerWidth) continue;
      return { x, y };
    }
    return null;
  })()`);
}

async function frames(c, n = 4) {
  await evaluate(c, `new Promise(r => { let i = ${n};
    const t = () => (--i <= 0) ? r(1) : requestAnimationFrame(t); requestAnimationFrame(t); })`);
}

// ── the snapshot ───────────────────────────────────────────────────────────────────────
// Everything behind the sheet that must not move, in ONE JSON-comparable object, in SCREEN
// coordinates. See the header for why the visualViewport offset is subtracted rather than
// ignored.
const SNAP = `(() => {
  const off = window.visualViewport ? window.visualViewport.offsetTop : 0;
  const left = window.visualViewport ? window.visualViewport.offsetLeft : 0;
  const r = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    // Rounded to 1/100 px. Sub-hundredth noise is float error in the rect itself, not motion.
    const q = (n) => Math.round(n * 100) / 100;
    return [q(b.x - left), q(b.y - off), q(b.width), q(b.height)];
  };
  const view = document.getElementById("view");
  return {
    viewScrollTop: view ? view.scrollTop : null,
    viewScrollLeft: view ? view.scrollLeft : null,
    winX: window.scrollX, winY: window.scrollY,
    list: r(".pk-list"), firstItem: r(".pk-item"), lastItem: (() => {
      const all = document.querySelectorAll(".pk-item");
      if (!all.length) return null;
      const b = all[all.length - 1].getBoundingClientRect();
      const q = (n) => Math.round(n * 100) / 100;
      return [q(b.x - left), q(b.y - off), q(b.width), q(b.height)];
    })(),
    secHead: r(".pk-sec-head"),
  };
})()`;

// Is the sheet showing the TOP of its own form, with the first field actually inside the
// scrollport? Not a keyboard question, but it is the other half of "the new item and edit
// item flow is horrendous": a sheet that opens scrolled to the far end of its own content
// hides the field the sheet was opened for.
const FORM_TOP = `(() => {
  const b = document.querySelector(".sh-body");
  if (!b) return null;
  const pr = b.getBoundingClientRect();
  const f = document.querySelector('.sh-body [name="label"], .sh-body input, .sh-body textarea');
  const fr = f ? f.getBoundingClientRect() : null;
  return {
    scrollTop: b.scrollTop,
    scrollMax: Math.max(0, b.scrollHeight - b.clientHeight),
    firstFieldVisible: fr ? (fr.top >= pr.top - 1 && fr.bottom <= pr.bottom + 1) : null,
  };
})()`;

const diff = (a, b) => Object.keys(a)
  .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
  .map((k) => `${k}: ${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])}`).join("; ");

// ── boot ───────────────────────────────────────────────────────────────────────────────
// The visualViewport shim used by Arm C ONLY, and installed only for that arm's document.
const VV_SHIM = `(() => {
  const vv = window.visualViewport;
  if (!vv) return;
  const p = Object.getPrototypeOf(vv);
  const gh = Object.getOwnPropertyDescriptor(p, "height").get;
  const gt = Object.getOwnPropertyDescriptor(p, "offsetTop").get;
  window.__kb = { h: 0, top: 0 };
  Object.defineProperty(p, "height", { configurable: true,
    get() { return gh.call(this) - window.__kb.h; } });
  Object.defineProperty(p, "offsetTop", { configurable: true,
    get() { return gt.call(this) + window.__kb.top; } });
  window.__setKb = (h, top) => {
    window.__kb = { h: h || 0, top: top || 0 };
    vv.dispatchEvent(new Event("resize"));
    vv.dispatchEvent(new Event("scroll"));
  };
})();`;

let bootScript = null;
async function boot(c, { shim = false } = {}) {
  await c.send("Emulation.setDeviceMetricsOverride",
    { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  if (bootScript) {
    await c.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: bootScript });
    bootScript = null;
  }
  if (shim) {
    bootScript = (await c.send("Page.addScriptToEvaluateOnNewDocument",
      { source: VV_SHIM })).identifier;
  }
  // Cache-busting query, not just the hash: without it a second navigate is SAME-DOCUMENT
  // and the shim registration never runs.
  await c.send("Page.navigate", { url: `${ORIGIN}/t/demo-2027/?kbreal=${Date.now()}#/pack` });
  for (let i = 0; i < 120; i++) {
    await sleep(200);
    if (await evaluate(c, `!!document.querySelector(".pk-item")`)) break;
  }
  await sleep(900);
}

// Scroll the pack list a long way down with real flicks, and let the momentum die. A page
// frozen at 0 proves nothing: every bug in this area shows up as a jump toward the top.
async function scrollDown(c) {
  for (let i = 0; i < 3; i++) { await flick(c, 195, 700, 240, 12, 14); await sleep(500); }
  await sleep(700);
  await frames(c);
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// ARM A — the new-item flow, entirely by thumb, with no emulation of any kind.
// ═══════════════════════════════════════════════════════════════════════════════════════
async function armA(c) {
  console.log("\n── ARM A · new item, real taps, no emulation ──────────────────────────");
  await boot(c);
  const overflow = await evaluate(c,
    `(() => { const v = document.getElementById("view"); return v.scrollHeight - v.clientHeight; })()`);
  check("A0 pack screen has more content than fits", overflow > 400, `${overflow}px of overflow`);

  await scrollDown(c);
  const parked = await evaluate(c, SNAP);
  check("A1 a real flick actually scrolled the page", parked.viewScrollTop > 200,
    `#view.scrollTop = ${parked.viewScrollTop}`);

  const fab = await centre(c, ".pk-fab");
  if (!fab) throw new Error("no .pk-fab on screen");
  await tap(c, fab.x, fab.y);
  await sleep(700);
  check("A2 the tap opened the New item sheet",
    (await evaluate(c, `(document.querySelector(".sh-title")||{}).textContent`)) === "New item");

  const opened = await evaluate(c, SNAP);
  check("A3 opening the sheet moved nothing behind it",
    JSON.stringify(parked) === JSON.stringify(opened), diff(parked, opened) || "identical");

  // sheet.js focuses the label field synchronously inside the tap's own task — which is what
  // makes iOS raise the keyboard at all — so this is the state a phone is in on arrival.
  check("A4 the label field has focus on arrival",
    (await evaluate(c, `(document.activeElement||{}).name`)) === "label");
  const aTop = await evaluate(c, FORM_TOP);
  check("A4b New item opens at the TOP of its form, with the Item field on screen",
    aTop && aTop.scrollTop === 0 && aTop.firstFieldVisible === true, JSON.stringify(aTop));

  // Now a real tap on each field in turn. Real hit-testing, real focus, real engine reveal.
  const FIELDS = [["label", "Item"], ["qty", "Quantity or size"], ["note", "Note"]];
  for (let n = 0; n < FIELDS.length; n++) {
    const [field, name] = FIELDS[n];
    const pt = await centre(c, `.sh-body [name="${field}"]`, 4);
    if (!pt) { check(`A5.${n} ${name} field reachable`, false, "not on screen"); continue; }
    await tap(c, pt.x, pt.y);
    await sleep(400);
    const now = await evaluate(c, SNAP);
    check(`A5.${n} real tap on the ${name} field moved nothing behind the sheet`,
      JSON.stringify(parked) === JSON.stringify(now), diff(parked, now) || "identical");
  }

  // THE ENGINE'S OWN REVEAL, triggered honestly. Scroll the sheet's body with a real flick so
  // the label field is genuinely above the scrollport, then Tab back onto it. Tab-onto-an
  // -offscreen-field is the code path that walks scroll ancestors and calls scrollIntoView on
  // each — the same one iOS runs for the keyboard, and a real user flow in its own right (the
  // keyboard's next/previous arrows dispatch exactly this).
  await flick(c, 195, 620, 380, 10, 14);       // scroll the SHEET body down
  await sleep(600);
  const sheetScrolled = await evaluate(c,
    `(() => { const b = document.querySelector(".sh-body"); return b ? b.scrollTop : 0; })()`);
  check("A6 the sheet's own body scrolled under a real flick", sheetScrolled > 0,
    `.sh-body.scrollTop = ${sheetScrolled}`);
  const beforeTab = await evaluate(c, SNAP);
  for (let i = 0; i < 6; i++) await key(c, 9, "Tab");
  await sleep(400);
  const afterTab = await evaluate(c, SNAP);
  check("A7 six real Tabs — the engine's ancestor-walking reveal — moved nothing behind",
    JSON.stringify(beforeTab) === JSON.stringify(afterTab),
    diff(beforeTab, afterTab) || "identical");
  check("A8 the page is still exactly where the thumb parked it",
    JSON.stringify(parked) === JSON.stringify(afterTab),
    diff(parked, afterTab) || "identical");

  // Close by tapping the backdrop, which is one of the two ways out of this sheet.
  await tap(c, 195, 40);
  await sleep(800);
  const closed = await evaluate(c, SNAP);
  check("A9 the sheet closed", !(await evaluate(c, `!!document.querySelector(".sh-root")`)));
  check("A10 closing restored the page byte-exactly",
    JSON.stringify(parked) === JSON.stringify(closed), diff(parked, closed) || "identical");
  check("A11 the page can be scrolled again once the sheet is gone",
    (await evaluate(c, `document.getElementById("view").style.overflowY`)) !== "hidden",
    `#view inline overflow-y = "${await evaluate(c, `document.getElementById("view").style.overflowY`)}"`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// ARM B — the EDIT flow, reached the way a thumb reaches it, plus a REAL viewport resize.
// The resize is genuine: Emulation.setDeviceMetricsOverride shrinks the actual viewport and
// the engine really relayouts and really gets its chance to re-reveal the focused field. It
// is Android's keyboard mechanism rather than iOS's, and it is labelled as such.
// ═══════════════════════════════════════════════════════════════════════════════════════
async function armB(c) {
  console.log("\n── ARM B · edit item, real taps, plus a REAL viewport shrink ──────────");
  await boot(c);
  await scrollDown(c);
  const parked = await evaluate(c, SNAP);

  // A real long-press on a row is the app's own way into "Where it goes"; the row's move
  // button is the other. Use the button — it is a tap, and taps are what the report is about.
  const move = await centre(c, ".pk-item [data-act='move']");
  if (!move) throw new Error("no move control on a visible row");
  await tap(c, move.x, move.y);
  await sleep(700);
  check("B1 the move sheet opened", !!(await evaluate(c, `!!document.querySelector(".sh-root")`)));
  const onWhere = await evaluate(c, SNAP);
  check("B2 opening the move sheet moved nothing behind it",
    JSON.stringify(parked) === JSON.stringify(onWhere), diff(parked, onWhere) || "identical");

  const edit = await centre(c, "[data-act='edititem']", 4);
  if (!edit) throw new Error("no Edit item button in the move sheet — is the tapped row one "
    + "u_admin may edit? canEditRow() gates that footer.");
  await tap(c, edit.x, edit.y);
  // The move sheet finishes leaving before the editor opens (packing.js defers it to onClose).
  await sleep(1100);
  check("B3 the editor opened in EDIT mode",
    (await evaluate(c, `(document.querySelector(".sh-title")||{}).textContent`)) === "Edit item");
  const onEdit = await evaluate(c, SNAP);
  check("B4 close-then-open across two sheets left the page where it was",
    JSON.stringify(parked) === JSON.stringify(onEdit), diff(parked, onEdit) || "identical");
  check("B5 the edit sheet does NOT autofocus a text field (no keyboard on arrival)",
    !["INPUT", "TEXTAREA"].includes(await evaluate(c, `(document.activeElement||{}).tagName`)),
    `activeElement = ${await evaluate(c, `(document.activeElement||{}).tagName`)}`);

  const bTop = await evaluate(c, FORM_TOP);
  check("B5b Edit item opens at the TOP of its form, with the Item field on screen",
    bTop && bTop.scrollTop === 0 && bTop.firstFieldVisible === true, JSON.stringify(bTop));

  const pt = await centre(c, '.sh-body [name="label"]', 4);
  if (!pt) throw new Error("no label field on screen in the editor");
  await tap(c, pt.x, pt.y);
  await sleep(400);
  const focused = await evaluate(c, SNAP);
  // Asserted BEFORE the "nothing moved" check below, and the order is not cosmetic: a tap
  // that missed and hit the backdrop closes the sheet, restores the page, and would make
  // "nothing moved" pass for the worst possible reason.
  check("B6a the tap landed in the field, and the sheet is still open",
    (await evaluate(c, `!!document.querySelector(".sh-root") && (document.activeElement||{}).name === "label"`)),
    `sheet=${await evaluate(c, `!!document.querySelector(".sh-root")`)} active=${await evaluate(c, `(document.activeElement||{}).name`)}`);
  check("B6 real tap into the edit form's label field moved nothing behind",
    JSON.stringify(parked) === JSON.stringify(focused), diff(parked, focused) || "identical");

  // REAL RESIZE, with the field still focused. Not a shimmed getter: the viewport genuinely
  // becomes 508px tall and the engine genuinely relayouts and re-reveals.
  await c.send("Emulation.setDeviceMetricsOverride",
    { width: W, height: H - KB, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  await frames(c);
  const shrunk = await evaluate(c, SNAP);
  check("B6b the sheet survived the resize", !!(await evaluate(c, `!!document.querySelector(".sh-root")`)));
  const stillFocused = await evaluate(c, `(document.activeElement||{}).name`);
  check("B7 the field kept focus across a real viewport resize", stillFocused === "label",
    `activeElement name = ${stillFocused}`);
  // #view's own box legitimately changes height when the LAYOUT viewport shrinks — that is
  // what a resize IS, and it is the half iOS does not do. What must not change is where the
  // list is: its scroll offset, and the screen position of its rows.
  check("B8 a real 336px viewport shrink did not scroll the page",
    parked.viewScrollTop === shrunk.viewScrollTop,
    `#view.scrollTop ${parked.viewScrollTop} -> ${shrunk.viewScrollTop}`);
  check("B9 a real 336px viewport shrink did not move the pack rows on screen",
    JSON.stringify(parked.firstItem) === JSON.stringify(shrunk.firstItem)
      && JSON.stringify(parked.list) === JSON.stringify(shrunk.list),
    `firstItem ${JSON.stringify(parked.firstItem)} -> ${JSON.stringify(shrunk.firstItem)}`);
  // And the sheet must have come with it: the whole point of shrinking is that the sheet now
  // rides on top of the space the keys would own.
  const sheetBox = await evaluate(c,
    `(() => { const s = document.querySelector(".sh-sheet"); if (!s) return null;
       const b = s.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)]; })()`);
  check("B10 the sheet re-sized itself onto the smaller viewport",
    sheetBox && sheetBox[1] <= H - KB + 1, `.sh-sheet top/bottom = ${JSON.stringify(sheetBox)}`);

  await c.send("Emulation.setDeviceMetricsOverride",
    { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  await tap(c, 195, 40);                       // backdrop
  await sleep(900);
  const closed = await evaluate(c, SNAP);
  check("B11 the edit flow left the page byte-exactly where it started",
    JSON.stringify(parked) === JSON.stringify(closed), diff(parked, closed) || "identical");
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// ARM D — the manage sheet, the third and last sheet on this screen that contains text
// fields. Same assertions, same real taps.
// ═══════════════════════════════════════════════════════════════════════════════════════
async function armD(c) {
  console.log("\n── ARM D · bags-and-legs sheet, real taps ────────────────────────────");
  await boot(c);
  await scrollDown(c);
  // The "Lists and bags…" control lives in the tools row near the top, so come back up for it — with real
  // flicks — and then park as far down as still leaves it reachable. Parking at 0 would make
  // "the page did not move" true for the wrong reason.
  for (let i = 0; i < 4; i++) { await flick(c, 195, 240, 720, 12, 14); await sleep(500); }
  await sleep(700);
  let manage = await centre(c, "[data-act='managebags']");
  for (let i = 0; i < 5 && manage; i++) {
    await flick(c, 195, 500, 440, 8, 20);         // a short, gentle nudge downward
    await sleep(600);
    const still = await centre(c, "[data-act='managebags']");
    if (!still) { await flick(c, 195, 440, 520, 8, 20); await sleep(700); break; }
    manage = still;
  }
  await sleep(500);
  await frames(c);
  const parked = await evaluate(c, SNAP);
  check("D0 parked away from the top of the list", parked.viewScrollTop > 0,
    `#view.scrollTop = ${parked.viewScrollTop}`);

  manage = await centre(c, "[data-act='managebags']");
  if (!manage) { check("D1 manage control reachable", false, "not on screen"); return; }
  await tap(c, manage.x, manage.y);
  await sleep(800);
  check("D1 the bags sheet opened", !!(await evaluate(c, `!!document.querySelector(".sh-root")`)));
  const onManage = await evaluate(c, SNAP);
  check("D2 opening the bags sheet moved nothing behind it",
    JSON.stringify(parked) === JSON.stringify(onManage), diff(parked, onManage) || "identical");
  check("D3 the bags sheet does NOT autofocus a rename field",
    !["INPUT", "TEXTAREA"].includes(await evaluate(c, `(document.activeElement||{}).tagName`)),
    `activeElement = ${await evaluate(c, `(document.activeElement||{}).tagName`)}`);

  const dTop = await evaluate(c, FORM_TOP);
  check("D3b the bags sheet opens at the TOP of its own list",
    dTop && dTop.scrollTop === 0, JSON.stringify(dTop));

  const rename = await centre(c, ".sh-body input[data-rename]", 4);
  if (rename) {
    await tap(c, rename.x, rename.y);
    await sleep(400);
    const now = await evaluate(c, SNAP);
    check("D4 real tap into a rename field moved nothing behind",
      JSON.stringify(parked) === JSON.stringify(now), diff(parked, now) || "identical");
  } else {
    check("D4 a rename field was on screen to tap", false, "none visible");
  }

  await tap(c, 195, 30);
  await sleep(900);
  const closed = await evaluate(c, SNAP);
  check("D5 the bags sheet left the page byte-exactly where it started",
    JSON.stringify(parked) === JSON.stringify(closed), diff(parked, closed) || "identical");
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// ARM C — EMULATED iOS. Reported, not counted. This is the arm whose ancestor produced a
// green 92/92 on a build found broken on a phone, and it is kept only to exercise the
// measurement path: it says sheet.js agrees with this file's description of iOS, and that
// is all it can ever say.
// ═══════════════════════════════════════════════════════════════════════════════════════
async function armC(c) {
  console.log("\n── ARM C · emulated iOS keyboard (NOT COUNTED — see the file header) ──");
  await boot(c, { shim: true });
  await scrollDown(c);
  const parked = await evaluate(c, SNAP);

  const fab = await centre(c, ".pk-fab");
  await tap(c, fab.x, fab.y);
  await sleep(700);
  const pt = await centre(c, '.sh-body [name="label"]', 4);
  if (pt) { await tap(c, pt.x, pt.y); await sleep(300); }

  // iOS shrinks the visual viewport AND slides the layout viewport up. Both halves.
  for (const [h, top] of [[KB, 0], [KB, 120], [KB, 200]]) {
    await evaluate(c, `window.__setKb(${h}, ${top})`);
    await sleep(300);
    await frames(c);
    const now = await evaluate(c, SNAP);
    note(`kb=${h} offsetTop=${top}: page still on the same pixels of glass`,
      JSON.stringify(parked) === JSON.stringify(now), diff(parked, now) || "identical");
    const rootTop = await evaluate(c,
      `(() => { const r = document.querySelector(".sh-root");
         return r ? Math.round(r.getBoundingClientRect().top) : null; })()`);
    note(`kb=${h} offsetTop=${top}: the sheet's root is pinned to the visual viewport`,
      rootTop === top, `.sh-root top = ${rootTop}, expected ${top}`);
    const bodyTop = await evaluate(c, `document.body.style.top`);
    note(`kb=${h} offsetTop=${top}: the frozen page is pinned by the same offset`,
      bodyTop === `${top}px`, `body.style.top = "${bodyTop}"`);
  }

  await evaluate(c, `window.__setKb(0, 0)`);
  await sleep(300);
  await tap(c, 195, 40);
  await sleep(900);
  const closed = await evaluate(c, SNAP);
  note("after the keys came down and the sheet closed, the page is byte-exact",
    JSON.stringify(parked) === JSON.stringify(closed), diff(parked, closed) || "identical");
}

// ═══════════════════════════════════════════════════════════════════════════════════════
(async () => {
  const c = await launch();
  try {
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    await c.send("Network.enable");
    // The SW precaches the app's JS. Without this the harness tests whatever shipped last and
    // believes a fix landed when it did not.
    await c.send("Network.setBypassServiceWorker", { bypass: true });
    await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await c.send("Network.setCookie",
      { name: "s2", value: cookie(), domain: HOST, path: "/" });

    await armA(c);
    await armB(c);
    await armD(c);
    await armC(c);
  } finally {
    await c.kill();
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} real-input checks passed`);
  console.log(`${emulated.filter((e) => e.ok).length}/${emulated.length} emulated-iOS observations agreed (NOT proof)`);
  console.log("\nNOT PROVED HERE, and it is the half a person actually sees:");
  console.log("  * a real iOS software keyboard. Headless Chrome has none, so the visual");
  console.log("    viewport never shrinks on its own and WebKit never slides the layout");
  console.log("    viewport up. Arm C describes that; it does not reproduce it.");
  console.log("  * the keyboard's own rise animation racing the sheet's 320ms slide.");
  console.log("  * WKWebView-in-standalone behaviour, which differs from Safari's.");
  if (bad.length) {
    console.log("\nFAILED:");
    for (const r of bad) console.log(`  - ${r.name}${r.detail ? "  — " + r.detail : ""}`);
    process.exit(1);
  }
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

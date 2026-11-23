#!/usr/bin/env node
/* Split: its nine promises, driven by REAL INPUT in
 * real Chrome against this lane's real dev server (WGP_BASE) and the real local D1.
 *
 *   node scripts/split_harness.mjs            # --shots to also write PNGs
 *
 * Chrome needs the Bash sandbox disabled (it cannot create its ProcessSingleton socket
 * otherwise), and the launcher (scripts/lib/browser.mjs) starts it only through the queue:
 *   WGP_BASE=http://127.0.0.1:<port> python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node <this file>
 *
 * PLANTED (16 Nov): SPLIT_FAST_DRAG=1 brings a row in with a fling and no pause after it. Without
 * tap()'s wait for a still target, §4's tap on the 10.00 row opened the 48.00 purchase beside it
 * (the list still coasting under the finger); with it, green.
 *
 * SPLIT_REACH_BAND=1 starts §4's feed row with its foot inside #view but under the 70 px tap()
 * keeps clear of the tab bar, where a drag that coasted under load once left it. Add
 * SPLIT_PLANT_OLD_REACH=1 for the rule from before (the band was the host's alone): reachIn
 * then never drags it, and §4's tap fails with where the row was.
 * (16 Nov, on 56ddc94: plain 106/106; SPLIT_REACH_BAND 107/107, the row dragged from a foot at
 * 804 of 844 and tapped at 672; with SPLIT_PLANT_OLD_REACH too, §4's tap fails as v101's gate did:
 * "inside the band (4–844) yet refused by centre()", the row at 733–804.)
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS ALONGSIDE scripts/split_ui_harness.mjs
 *
 * That harness is the wide one: every screen state, every copy string, read-only rows, the
 * attachment picker, reduced motion. It reaches all of it with `node.click()` and by
 * assigning `input.value` and dispatching an `input` event by hand. That is enough to walk a
 * screen, and it is NOT enough to say a screen works — scripts/pack_kb_real_harness.js
 * exists because its synthetic ancestor reported 92/92 on a build that was broken on a phone.
 * A dispatched `input` event does not hit-test, does not move focus, does not run
 * sheet.js's `touchstart` handler, and cannot notice that the button it "tapped" was under
 * the tab bar.
 *
 * So EVERYTHING HERE IS A REAL EVENT.
 *
 *   * Every tap is Input.dispatchTouchEvent at real coordinates, on an element this file has
 *     first measured to be genuinely on screen and inside its own scrollport. A tap on
 *     something that is not visible is a failure here, not a silent success.
 *   * Every character is Input.dispatchKeyEvent — keyDown carrying `text`, then keyUp — into
 *     whatever the browser says has focus. Nothing assigns `.value`. Which means the field
 *     has to have really been focused, by a real tap or by split.js's own autofocus, or the
 *     characters go nowhere and the check fails.
 *   * Scrolling inside the drawer is a real touch drag on .sh-body. Nothing assigns
 *     scrollTop.
 *   * "Offline" is Network.emulateNetworkConditions, so navigator.onLine really goes false.
 *   * The on-screen keyboard is a real Emulation.setDeviceMetricsOverride viewport shrink
 *     with the field really focused — the engine really relayouts and really gets its chance
 *     to re-reveal. (See "WHAT THIS CANNOT PROVE" below: that is Android's keyboard
 *     mechanism, not iOS's.)
 *
 * THE ROUTE IS NOT INJECTED. BUILD 4 wired `#/split` and `#/split/:id` into
 * public/js/router.js, so this harness boots off the files in the repo and patches nothing.
 * If the route table regresses, section 0 fails at the first assertion instead of quietly
 * testing a spliced copy.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IT PROVES, in the order the task list asks for it:
 *
 *   1. A purchase added through the drawer, by thumb, lands in the feed.
 *   2. The split defaults to EVERYONE on the trip.
 *   3. Deselecting people changes the shares, and the disclosure's prefill agrees.
 *   4. An ALREADY SAVED, ALREADY FLUSHED purchase converts to an unequal split.
 *   5. Shares sum to the amount EXACTLY — including the 3-way split of 10.00, which is the
 *      case a float would get wrong and the case a naive `amount/n` would drop a céntimo on.
 *   6. Settle-up gives the FEWEST-TRANSFER answer on a fixture whose answer was worked out
 *      by hand, in this file's comments, before the code ever ran.
 *   7. A purchase entered with the radio OFF survives a reload and flushes on reconnect.
 *   8. The fast path costs exactly two taps and the number.
 *   9. The drawer behaves when the on-screen keyboard opens.
 *
 * WHAT THIS CANNOT PROVE, stated up front so nothing here is over-claimed:
 *
 *   * A real iOS software keyboard. Headless Chrome has none: the visual viewport never
 *     shrinks on its own and WebKit never slides the LAYOUT viewport up underneath a page
 *     that is trying to stand still. Section 5 shrinks the viewport for real, which is
 *     Android's mechanism and exercises the same relayout-and-reveal path; the iOS-specific
 *     half is scripts/pack_kb_real_harness.js's Arm C, which reports it and deliberately
 *     does not count it.
 *   * The service worker. boot() bypasses it so this harness tests exactly what is in
 *     public/ rather than whatever a cached VERSION shipped last. Section 6's reload
 *     therefore takes the DOCUMENT off the dev server while /api/* stays blocked — which is
 *     the honest way to test "the row survived the reload and the queue is durable" without
 *     testing the cache. That the shell itself mounts #/split from the SW cache with the
 *     radio cut is scripts/split_wiring_check.mjs section 5, and it is not repeated here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, REPO, appSettled, boot, evalIn, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { TRIP, d1 as gateD1 } from "./lib/gate_trip.mjs";

const SHOTS = process.argv.includes("--shots");
// Stills go where the environment says, and to a folder under the temp directory otherwise:
// never into the tree.
const SHOT_DIR = process.env.WGP_SHOTS || path.join(os.tmpdir(), "wgp-split-shots");

const W = 390, H = 844;     // an iPhone 14-ish screen, a common phone
const KB = 336;             // a real iOS keyboard on that screen (pack_kb_real_harness.js's number)

// ── the ledger ──────────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + detail : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// ── plumbing ────────────────────────────────────────────────────────────────────────────
// Evaluate, retrying across the navigation window where the execution context has been torn
// down but the new one has not been announced yet. Section 6 reloads mid-run, and without
// this every check either side of it is a coin toss.
async function ev(cdp, S, expr, tries = 6) {
  for (let i = 0; ; i++) {
    try { return await evalIn(cdp, S, expr); }
    catch (e) {
      const m = String(e);
      if (i >= tries || !/context was destroyed|Cannot find context|Inspected target/i.test(m)) throw e;
      await sleep(400);
    }
  }
}
// Read a structure out of the page. Wrapped in Promise.resolve rather than `await`, because
// Runtime.evaluate compiles its expression as a SCRIPT and a top-level await is a syntax error
// there — which surfaces as "missing ) after argument list" and looks like a quoting bug.
const J = async (cdp, S, expr) =>
  JSON.parse(await ev(cdp, S, `Promise.resolve(${expr}).then((v) => JSON.stringify(v))`));
const inStore = (cdp, S, body) => ev(cdp, S,
  `(async () => { const { store } = await import("/js/store.js"); ${body} })()`);

// A SYNCHRONOUS pause, because d1() is synchronous and every caller below reads like a
// sentence rather than a promise chain. Atomics.wait on a throwaway SharedArrayBuffer is the
// only way to actually block this thread without spinning a core.
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// (The gate's database, read while its server runs: scripts/lib/gate_trip.mjs, which tries a
// statement again on the local database's passing faults.)
const d1 = (sql, tries = 4) => gateD1(sql, tries);

// ── real input ──────────────────────────────────────────────────────────────────────────
// One finger, 12px of radius, because a thumb is not a pixel. Every coordinate below came
// out of a getBoundingClientRect() taken moments earlier, so a layout that moved between the
// measurement and the tap makes the tap land somewhere else — and the assertions notice.
const finger = (x, y) => [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 0 }];

let taps = 0;          // decisions: the taps a person makes
let caretTaps = 0;     // taps whose only job is to put the caret in a field before typing

/**
 * The centre of an element, in layout-viewport coordinates, ONLY IF IT IS REALLY ON SCREEN.
 *
 * `bot` is the margin kept clear at the foot of the screen: 70 for controls in the page, so
 * a tap can never land on the tab bar that overlaps them, and 4 for controls inside a sheet,
 * whose head and pinned footer legitimately sit over that bar. Returning null rather than
 * guessing is the whole point: a harness that dispatches a tap at an off-screen coordinate
 * is testing whatever IS at that coordinate, under the name of the thing it meant to hit.
 */
async function centre(cdp, S, sel, { bot = 70, nth = 0, root = "document" } = {}) {
  return ev(cdp, S, `(() => {
    const all = [...${root}.querySelectorAll(${JSON.stringify(sel)})];
    const e = all[${nth}];
    if (!e) return null;
    const b = e.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) return null;
    if (b.top < 4 || b.bottom > window.innerHeight - ${bot}) return null;
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (x < 0 || x > window.innerWidth) return null;
    return { x, y, w: Math.round(b.width), h: Math.round(b.height) };
  })()`);
}

/** A real touch drag. Slow, many steps, so the compositor's fling is negligible and the
 *  scroll offset it produces is the one that was asked for rather than a guess plus inertia. */
async function drag(cdp, S, x, y0, y1, steps = 14, stepMs = 12, after = 220) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: finger(x, y0) }, S);
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent",
      { type: "touchMove", touchPoints: finger(x, y0 + (y1 - y0) * i / steps) }, S);
    await sleep(stepMs);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, S);
  await sleep(after);
}

/**
 * Bring `sel` into its scrollport with REAL drags, then return its centre.
 *
 * The drawer is six member chips tall on this trip and the disclosure sits under all of it,
 * so half the controls this file taps start below the fold. The scroll that reaches them is
 * the same scroll a thumb makes: a drag on .sh-body, never an assignment to scrollTop.
 *
 * Only UPWARD drags (finger up, content up) are used inside a sheet unless `down` is asked
 * for: the settle sheet is `dragFrom: "body"`, where a downward drag at the scroll top is a
 * DISMISS, and a helper that dismissed the sheet it was trying to read would make every
 * assertion after it fail for the wrong reason.
 */
//
// The band a target has to end up in is the host's box AND what centre() accepts: from 4 px
// below the top of the screen to `bot` above its foot. The host alone isn't enough: #view runs
// down under the tab bar, so a feed row whose foot sat between the screen's foot less 70 and
// #view's foot less 12 was inside the host, refused by centre(), and never dragged (v101's gate,
// 22:13, under load: the drag before it coasted the row into that strip).
//
// When it gives up it says why and where everything was (lastReach), and tap() puts that in
// its failure.
let lastReach = null;
async function reachIn(cdp, S, sel, { host = ".sh-body", bot = 4, nth = 0, tries = 8 } = {}) {
  lastReach = null;
  const giveUp = (why, geo) => { lastReach = { why, ...(geo || {}) }; return null; };
  for (let i = 0; i < tries; i++) {
    const c = await centre(cdp, S, sel, { bot, nth });
    if (c) return c;
    const geo = await J(cdp, S, `(() => {
      const h = document.querySelector(${JSON.stringify(host)});
      const all = [...document.querySelectorAll(${JSON.stringify(sel)})];
      const e = all[${nth}];
      if (!h || !e) return null;
      const hb = h.getBoundingClientRect(), eb = e.getBoundingClientRect();
      return { hx: Math.round(hb.x + hb.width / 2), htop: Math.round(hb.y), hbot: Math.round(hb.y + hb.height),
        top: Math.round(eb.y), bot: Math.round(eb.y + eb.height), inner: window.innerHeight,
        at: Math.round(h.scrollTop), max: Math.max(0, Math.round(h.scrollHeight - h.clientHeight)) };
    })() || null`);
    if (!geo) return giveUp(`no ${host} or no ${sel}`);
    // Where the target may sit: inside the host and inside what centre() accepts.
    const ceil = Math.max(geo.htop, 4);
    const floor = process.env.SPLIT_PLANT_OLD_REACH ? geo.hbot : Math.min(geo.hbot, geo.inner - bot);
    // How far the content has to travel, and in which direction. Clamped to most of the
    // host's height so one drag never overshoots the whole list.
    const span = Math.max(120, (geo.hbot - geo.htop) * 0.7);
    let want = 0;
    if (geo.bot > floor - 12) want = Math.min(span, geo.bot - (floor - 60));
    else if (geo.top < ceil + 12) want = -Math.min(span, (ceil + 60) - geo.top);
    else return giveUp(`inside the band (${ceil}–${floor}) yet refused by centre()`, geo);
    if (want > 0 && geo.at >= geo.max - 1) return giveUp("below the band with the host scrolled to its end", geo);
    if (want < 0 && geo.at <= 1) return giveUp("above the band with the host at its top", geo);
    const mid = (geo.htop + geo.hbot) / 2;
    if (process.env.SPLIT_FAST_DRAG) await drag(cdp, S, geo.hx, mid + want / 2, mid - want / 2, 2, 0, 0);
    else await drag(cdp, S, geo.hx, mid + want / 2, mid - want / 2);
    lastReach = { why: `still outside the band after ${i + 1} drag(s)`, ...geo };
  }
  return null;
}

/** Until `sel` has kept the same box for five frames with nothing animating on it or around it
 *  (a list still coasting from a drag, a row sliding into its new place), at most 3 s; the ms it took. */
function still(cdp, S, sel, nth = 0) {
  return ev(cdp, S, `new Promise((done) => {
    const t0 = performance.now(); let last = "", same = 0;
    const f = () => {
      const e = [...document.querySelectorAll(${JSON.stringify(sel)})][${nth}];
      const b = e && e.getBoundingClientRect();
      const k = b ? [b.x, b.y, b.width, b.height].map(Math.round).join() : "";
      const moving = !!e && document.getAnimations().some((a) => a.playState === "running" && a.effect && a.effect.target
        && (a.effect.target.contains(e) || e.contains(a.effect.target)));
      same = k === last && !moving ? same + 1 : 0;
      last = k;
      if (same >= 5 || performance.now() - t0 > 3000) done(Math.round(performance.now() - t0));
      else requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  })`);
}

/** A real tap. `label` is what the failure will be called, so it is worth spelling out.
 *  Measured only once the target has stopped moving: a box read while the list still coasts from
 *  the drag that brought it in is a point over another row by the time the finger lands. */
async function tap(cdp, S, sel, { label = sel, bot = 4, nth = 0, host = ".sh-body", caret = false } = {}) {
  let c = null;
  lastReach = null;
  for (let i = 0; i < 3 && !c; i++) {
    if (!(await centre(cdp, S, sel, { bot, nth }))) await reachIn(cdp, S, sel, { host, bot, nth });
    const settled = await still(cdp, S, sel, nth);
    c = await centre(cdp, S, sel, { bot, nth });
    if (c) c.settled = settled;
  }
  if (!c) throw new Error(`tap: ${label} is not on screen (selector ${sel})${lastReach ? `; last reach: ${JSON.stringify(lastReach)}` : ""}`);
  const dis = await ev(cdp, S,
    `(() => { const n = [...document.querySelectorAll(${JSON.stringify(sel)})][${nth}];
      return n && n.disabled ? 1 : 0; })()`);
  if (dis) throw new Error(`tap: ${label} is disabled`);
  // What is under the finger as it lands, and whether anything on the page is still animating.
  Object.assign(c, JSON.parse(await ev(cdp, S, `JSON.stringify((() => { const n = document.elementFromPoint(${c.x}, ${c.y}), r = n && n.closest("[data-id]");
    return { under: r ? r.dataset.id : null, anims: document.getAnimations().filter((a) => a.playState === "running").length }; })())`)));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: finger(c.x, c.y) }, S);
  await sleep(70);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, S);
  if (caret) caretTaps++; else taps++;
  await sleep(180);
  return c;
}

// Characters, as a keyboard makes them. keyDown carrying `text` is what Chrome turns into a
// composed character (it is what puppeteer's Keyboard.down does); a bare rawKeyDown types
// nothing, which is a failure mode worth knowing about because it looks like a dead field.
function keyBits(ch) {
  if (ch >= "0" && ch <= "9") return { code: `Digit${ch}`, vk: 48 + Number(ch) };
  if (ch === ".") return { code: "Period", vk: 190 };
  if (ch === ",") return { code: "Comma", vk: 188 };
  if (ch === " ") return { code: "Space", vk: 32 };
  const up = ch.toUpperCase();
  if (up >= "A" && up <= "Z") return { code: `Key${up}`, vk: up.charCodeAt(0) };
  return { code: "", vk: 0 };
}
async function keyChar(cdp, S, ch) {
  const { code, vk } = keyBits(ch);
  const base = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    modifiers: ch >= "A" && ch <= "Z" ? 8 : 0 };
  await cdp.send("Input.dispatchKeyEvent",
    { ...base, type: "keyDown", text: ch, unmodifiedText: ch.toLowerCase() }, S);
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" }, S);
  await sleep(18);
}
async function keyNamed(cdp, S, key, code, vk, commands) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp.send("Input.dispatchKeyEvent",
    { ...base, type: "rawKeyDown", ...(commands ? { commands, modifiers: 4 } : {}) }, S);
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp", ...(commands ? { modifiers: 4 } : {}) }, S);
  await sleep(60);
}

/**
 * Type into WHATEVER HAS FOCUS, having first asserted that the thing with focus is the field
 * we meant. That assertion is not ceremony: it is the difference between "the drawer accepted
 * the amount" and "the harness put a string in a variable". If a real tap missed, or
 * sheet.js's touchstart handler stopped focusing text fields, the characters land on the
 * document and this throws instead of passing.
 */
async function typeInto(cdp, S, sel, text, { clear = false } = {}) {
  const focused = await ev(cdp, S,
    `(() => { const a = document.activeElement; return a && a.matches(${JSON.stringify(sel)}) ? 1 : 0; })()`);
  if (!focused) {
    const who = await ev(cdp, S, `(() => { const a = document.activeElement;
      return a ? a.tagName + "." + (a.className || "") : "(none)"; })()`);
    throw new Error(`type: ${sel} does not have focus — activeElement is ${who}`);
  }
  if (clear) {
    // Select-all through the editing pipeline (the `commands` escape hatch is how a real
    // Cmd+A reaches WebContents on a Mac), then one real Backspace over the selection.
    await keyNamed(cdp, S, "a", "KeyA", 65, ["selectAll"]);
    await keyNamed(cdp, S, "Backspace", "Backspace", 8);
  }
  for (const ch of text) await keyChar(cdp, S, ch);
  await sleep(140);
}

/**
 * Wait for the drawer to be REALLY OPEN, on the app's own signal.
 *
 * `sleep(900)` used to stand here, and it was a bet: split.js focused the amount from a
 * setTimeout sized off --dur-slow, so the harness slept for longer than it believed that
 * timer to be and hoped. A bet that pays out on a quiet machine and not on a busy one is
 * exactly the flake this file exists to make impossible in the app, and it has no business
 * being in the check either.
 *
 * sheet.js now stamps `data-entered="1"` on .sh-root at the moment its entry transition really
 * lands, and focuses from that same moment. So this waits on the attribute — the app's own
 * definition of open, not a second one kept over here — and then, when a field is named, on
 * that field actually holding focus. Both are polled by waitFor with a real timeout, so a
 * drawer that never arrives fails as "timed out: the drawer's entry transition" rather than
 * as a mystery three assertions later.
 */
async function drawerReady(cdp, S, { focus = "" } = {}) {
  // The TOPMOST sheet, not the first one in the document: the currency and attachment
  // pickers stack on the open drawer, and the drawer underneath them is already entered —
  // waiting on it would be waiting on something that landed a section ago.
  await waitFor(cdp, S, `(() => { const rs = document.querySelectorAll(".sh-root");
    const r = rs[rs.length - 1]; return r && r.dataset.entered === "1" ? 1 : 0; })()`,
    { label: "the topmost sheet's entry transition" });
  // The focus wait DOES NOT THROW, deliberately. "the amount field has focus" is the check
  // this whole screen is judged on, and it has to be reported by check() as a named failure
  // with the activeElement that was there instead — not swallowed into a helper's timeout
  // message. So this waits generously, gives up quietly, and lets the assertion speak.
  let got = !focus;
  if (focus) {
    try {
      await waitFor(cdp, S,
        `(() => { const a = document.activeElement; return a && a.matches(${JSON.stringify(focus)}) ? 1 : 0; })()`,
        { timeout: 8000, label: `${focus} to hold focus` });
      got = true;
    } catch { got = false; }
  }
  // One frame past the signal, so anything the caller does next measures a settled box. This
  // is a paint boundary, not a guess at a duration — it does not grow with load.
  await ev(cdp, S, `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`);
  return got;
}

// A GENUINE cold load at a given hash. Page.navigate to a URL differing only in the fragment
// is a SAME-DOCUMENT navigation — Chrome fires a hashchange and reloads nothing — so the hash
// is set first and the reload is a real reload. (split_ui_harness.mjs learned this the
// expensive way; the note is repeated because the trap is invisible at the call site.)
async function reloadTo(cdp, S, hash) {
  await ev(cdp, S, `location.hash = ${JSON.stringify(hash)}`);
  await sleep(150);
  await cdp.send("Page.reload", { ignoreCache: true }, S);
}

// store.me() answers from the IndexedDB CACHE the instant hydrate() finishes and only becomes
// the session's user when the background /api/me lands. That is what makes the app usable
// offline and what makes "assert immediately after a reload" wrong.
const waitMe = (cdp, S, id) => waitFor(cdp, S,
  `(async () => { const { store } = await import("/js/store.js"); return store.me().id === ${JSON.stringify(id)} ? 1 : 0; })()`,
  { label: `store.me() === ${id}` });

// ── the independent solver ──────────────────────────────────────────────────────────────
/**
 * The TRUE minimum number of transfers for a set of net balances, by exhaustive search — no
 * greedy, no heuristic, and deliberately NOT money.js's settle().
 *
 * Minimum transfers = (people with a non-zero balance) − (the largest number of disjoint
 * subsets each of which sums to zero). A zero-sum group of size k always settles in exactly
 * k−1 payments and never fewer, so maximising the number of groups minimises the payments.
 * Over ≤ 6 people that is a bitmask DP small enough to be obviously right: `best[m]` is the
 * most zero-sum groups the members of mask `m` can be cut into.
 *
 * This is the thing that makes section 7 an assertion rather than a tautology. Comparing
 * settle()'s answer to settle()'s answer proves nothing; comparing it to the true optimum,
 * computed a completely different way, is what "fewest transfers" means.
 */
function trueMinTransfers(nets) {
  const v = nets.filter((n) => n !== 0);
  const n = v.length;
  if (!n) return 0;
  const sum = new Array(1 << n).fill(0);
  for (let m = 1; m < (1 << n); m++) {
    const low = m & -m;
    sum[m] = sum[m ^ low] + v[31 - Math.clz32(low)];
  }
  const best = new Array(1 << n).fill(-1);
  best[0] = 0;
  for (let m = 1; m < (1 << n); m++) {
    // Fix the lowest set member, and try every subset of `m` that contains it.
    const low = m & -m;
    for (let s = m; s > 0; s = (s - 1) & m) {
      if (!(s & low)) continue;
      if (sum[s] !== 0) continue;
      const rest = best[m ^ s];
      if (rest >= 0 && rest + 1 > best[m]) best[m] = rest + 1;
    }
    if (best[m] < 0) {
      // No partition into zero-sum groups at all (only possible when `m` itself does not sum
      // to zero); treated as one group, which is what the caller's whole-set call never is.
      best[m] = 0;
    }
  }
  return n - best[(1 << n) - 1];
}

const created = [];   // purchase ids this run made, cleaned out of D1 at the end
// The purchases this phone was already carrying when the run started. Module scope, not
// run()'s try block, because the cleanup in the FINALLY has to be able to see it — a guard
// that is out of scope at the moment of the DELETE is not a guard.
let BASE_SET = new Set();

/**
 * The id of the row this run has just minted — the one on the feed that was not there before.
 *
 * `document.querySelector(".sp-row").dataset.id` stood here, i.e. "the first row in the DOM",
 * which is only the new one while the feed is sorted newest-first AND the phone started
 * empty. On a phone that already holds a ledger that is a coin toss, and it is a DANGEROUS
 * one: whatever this returns is pushed onto `created`, and everything on `created` is DELETED
 * from D1 in the finally block. A mis-read here does not fail a check, it destroys one of
 * a real person's rows.
 *
 * So the row is identified by the only thing that cannot be confused — being new. `known`
 * carries every id this run has already accounted for, baseline included; this waits for one
 * that is not in it, records it, and returns it. It waits rather than reads because saving is
 * a store write, a FLIP and a re-render, and the assertion afterwards is about the row, not
 * about how quickly the frame landed.
 */
async function mintedRow(cdp, S, known) {
  const id = await waitFor(cdp, S, `(() => {
    const skip = ${JSON.stringify([...known])};
    for (const r of document.querySelectorAll(".sp-row")) {
      if (!skip.includes(r.dataset.id)) return r.dataset.id;
    }
    return 0;
  })()`, { label: "a feed row this run has not seen before" });
  known.add(id);
  created.push(id);
  return id;
}

// ════════════════════════════════════════════════════════════════════════════════════════
const run = async () => {
  if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });
  // reduceMotion FALSE. The sheet's slide, the FLIP on the feed and the deferred unmount are
  // part of what a real tap has to survive, and motion.js kills all of it under the reduce
  // query — a harness that runs with motion off is a harness that never waits for the frame
  // in which a control is still moving under the finger.
  const b = await boot({ vw: W, vh: H, dsf: 2, reduceMotion: false });
  const { cdp, S } = b;
  const shot = async (name) => { if (SHOTS) await b.shot(path.join(SHOT_DIR, `${name}.png`)); };

  try {
    // Touch, explicitly. setDeviceMetricsOverride({mobile:true}) usually implies it; when it
    // does not, Input.dispatchTouchEvent throws "Touch events are not supported" and every
    // section of this file fails at once, which is a confusing way to learn one flag was off.
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, S);
    await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });

    // ── 0. the screen mounts, off the repo's own router ────────────────────────────────
    section("0. the real router mounts the real module — nothing is patched");
    await cdp.send("Page.navigate", { url: BASE + `/t/${TRIP}/#/split` }, S);
    await appSettled(cdp, S);
    await waitFor(cdp, S, `document.querySelector("#view") ? 1 : 0`, { label: "the app shell" });
    const me = await waitFor(cdp, S,
      `(async () => { const { store } = await import("/js/store.js"); const m = store.me(); return m && m.id ? m.id : 0; })()`,
      { label: "store.ready() + /api/me" });
    await waitFor(cdp, S, `document.querySelector(".sp-h1") ? 1 : 0`, { label: "the Split screen" });
    check("#/split resolves out of ROUTES in the repo and mounts split.js",
      await ev(cdp, S, `document.querySelector("#view").dataset.route`) === "split");
    check("the injected stylesheet is on the page exactly once, and parsed whole",
      await ev(cdp, S, `document.querySelectorAll("#sp-styles").length`) === 1 &&
      await ev(cdp, S, `document.getElementById("sp-styles").sheet.cssRules.length`) > 120,
      `${await ev(cdp, S, `document.getElementById("sp-styles").sheet.cssRules.length`)} rules`);
    check("no exception reached the page on mount", b.pageErrors.length === 0,
      b.pageErrors.join(" | ") || "clean");

    const members = await J(cdp, S,
      `import("/js/store.js").then(({ store }) => store.members().map((m) => ({ id: m.id, name: m.name, initials: m.initials })))`);
    check("the roster the split selector renders is there", members.length >= 4,
      members.map((m) => `${m.initials}:${m.name}`).join(", "));
    const HOME = await inStore(cdp, S, `return store.myNativeCurrency()`);
    // Section 7's fixture is denominated in a currency this trip has never used, so that the
    // settle sheet's "By currency" block over it contains NOTHING but the fixture. EUR is the
    // choice; if it were ever also the home currency the isolation would be gone, so say so
    // rather than quietly settle a mixed block.
    check("the home currency is not EUR, so section 7's fixture block can be isolated",
      HOME !== "EUR", `home = ${HOME}`);
    const FX = "EUR", FXSYM = "€";
    console.log(`        me=${me}  members=${members.length}  home=${HOME}  fixture=${FX}`);

    // ── THE BASELINE ──────────────────────────────────────────────────────────────────
    //
    // WHAT THIS PHONE ALREADY HAD, established before one assertion is made about it.
    //
    // This block used to be a single check that the §8 empty-state copy was on screen, and it
    // held only because of two things it never said out loud: that boot() hands over a
    // browser profile with an empty IndexedDB, and that GET /api/trips/<id> did not carry
    // `purchases`, so nothing the local D1 held could reach the feed. The first is still this
    // file's to guarantee. THE SECOND IS NO LONGER TRUE: functions/api/trip.js now puts
    // `purchases`, `currencies` and `fx` on the snapshot, which is what makes Split a shared
    // ledger rather than a notebook on one phone — so every row in the local D1 arrives on this
    // feed before the first assertion is made, and so do rows a CONCURRENT run of this file is
    // minting into the same database while this one reads it.
    //
    // Nothing below may assume an empty table. That is not defensive coding, it is the only way
    // this file can be run twice at once, or on a lane that has real rows, or after any other harness has
    // left a row behind — and the failure it prevents is the least useful one there is: a check
    // that passes on a clean laptop and fails on the one the app is actually being built on.
    //
    // So the baseline is MEASURED and then asserted against, and both branches are real:
    //
    //   * nothing synced  -> the §8 empty copy must be on screen, with no rows and no settle
    //                        card over them. This is the branch that runs today.
    //   * rows synced     -> the feed must render exactly those rows, with the settle card,
    //                        and must NOT be showing the empty copy over them.
    //
    // Either way the ids are remembered, every later count is relative to them, and the
    // cleanup at the foot of this file refuses to touch them. NOTHING HERE DELETES ANYTHING
    // IT DID NOT CREATE — the rows sitting in the local D1 are someone's, and a harness that
    // tidies the database it is testing against is a harness that can only be run once.
    //
    // lastSync() is waited on first, and it is not ceremony either: until the first snapshot
    // lands split.js renders three SKELETON rows rather than the empty state (emptyHtml()'s
    // `if (!S.lastSync())` branch), so asserting the copy before that is a race this file
    // would lose on a slow machine and win on a fast one.
    await waitFor(cdp, S,
      `(async () => { const { store } = await import("/js/store.js"); return store.lastSync() ? 1 : 0; })()`,
      { label: "the first snapshot to land (store.lastSync())" });
    const baseIds = await J(cdp, S,
      `import("/js/store.js").then(({ store }) => store.purchases().map((p) => p.id))`);
    BASE_SET = new Set(baseIds);
    const known = new Set(baseIds);          // grows with every row this run mints
    console.log(`        baseline: ${baseIds.length} purchase${baseIds.length === 1 ? "" : "s"} already on this phone` +
      (baseIds.length ? ` — ${baseIds.slice(0, 6).join(", ")}${baseIds.length > 6 ? ", …" : ""}` : ""));
    const feedTxt = await ev(cdp, S, `document.querySelector("#view").innerText`);
    const feedRows = await ev(cdp, S, `document.querySelectorAll(".sp-row").length`);
    const feedCards = await ev(cdp, S, `document.querySelectorAll('#view [data-act="settle"]').length`);
    if (!baseIds.length) {
      check("an empty feed says what to do, in the brief's own words",
        /Nothing to split yet/.test(feedTxt) && /Split keeps the tally/.test(feedTxt) &&
        feedRows === 0 && feedCards === 0,
        feedTxt.replace(/\n+/g, " ").slice(0, 110));
    } else {
      check("the feed opens on exactly the purchases this phone had synced — and NOT on the empty state",
        feedRows === baseIds.length && feedCards === 1 && !/Nothing to split yet/.test(feedTxt),
        `${feedRows} rows for ${baseIds.length} baseline purchases, ${feedCards} way into Settle up` +
        (/Nothing to split yet/.test(feedTxt) ? " — and the empty words are over the top of them" : ""));
    }
    check("the FAB is parked in the ROUTER's fixed layer, not inside #view",
      await ev(cdp, S, `(document.querySelector("#rt-fixed .fab") || {}).ariaLabel`) === "Add a purchase");
    await shot("h-01-empty");

    // ── 1. the fast path ───────────────────────────────────────────────────────────────
    // The most common purchase, "You paid · everyone splits · same currency as last
    // time", costs TWO TAPS AND THE NUMBER. It is the row most purchases are, and
    // it is the one thing on this screen a redesign could quietly cost. Counted, by thumb.
    section("1. the fast path, by thumb — the keypad up at once, and the sheet rising in one move");
    taps = 0; caretTaps = 0;
    // The sheet's top edge, sampled every frame from the tap until it has stopped: it must rise
    // ONCE, straight to its full height, never stop at half and then jump (what a focus after
    // the slide did: "opens to half height then teleports to full height").
    await ev(cdp, S, `(window.__rise = [], (() => { const t0 = performance.now(); const step = () => {
      const sh = document.querySelector(".sh-root:last-of-type .sh-sheet");
      if (sh) window.__rise.push(Math.round(sh.getBoundingClientRect().top));
      if (performance.now() - t0 < 1200) requestAnimationFrame(step); };
      requestAnimationFrame(step); })(), 1)`);
    await tap(cdp, S, "#rt-fixed .fab", { label: "the FAB", bot: 4 });
    // NOT a sleep. The drawer's own data-entered, then the field actually holding focus —
    // see drawerReady(). If either never happens this fails as a timeout naming the thing
    // that did not happen.
    const amountFocused = await drawerReady(cdp, S, { focus: ".sp-amtin" });
    check("the tap opened the sheet, titled for a new purchase",
      /Add a purchase/.test(await ev(cdp, S, `(document.querySelector(".sh-title") || {}).textContent || ""`)));
    check("THE KEYPAD IS UP AT ONCE: the amount field has focus from the same tap",
      amountFocused, await ev(cdp, S, `(document.activeElement || {}).className || "(none)"`));
    check("…and the sheet is at its full height already",
      await ev(cdp, S, `(() => { const rs = document.querySelectorAll(".sh-root"); const r = rs[rs.length - 1]; return !!r && r.dataset.tall === "1"; })()`));
    await sleep(900);
    const rise = await ev(cdp, S, `JSON.stringify(window.__rise)`);
    const tops = JSON.parse(rise).filter((v, i, a) => i === 0 || v !== a[i - 1]);
    const ups = tops.slice(1).every((v, i) => v <= tops[i]);
    check("THE SHEET ROSE IN ONE MOVE: its top only ever went up, and came to rest once",
      tops.length >= 2 && ups, tops.join(" → "));
    check("Add purchase starts DISABLED and RECOLOURED — never dimmed (no text is quieted with opacity)",
      await ev(cdp, S, `(() => { const n = document.querySelector('[data-act="save"]');
        return !!n && n.disabled && getComputedStyle(n).opacity === "1" && n.textContent.trim() === "Add purchase"; })()`));

    const pre = await J(cdp, S, `(() => ({
      paid: [...document.querySelectorAll('[data-grp="paid"] .sp-person')]
        .filter((n) => n.getAttribute("aria-checked") === "true").map((n) => n.dataset.id),
      split: (document.querySelector('[data-slot="ans-split"]') || {}).textContent || "",
      open: [...document.querySelectorAll(".sp-pane")].filter((n) => !n.hidden).length,
      cur: document.querySelector('[data-act="cur"]').textContent.trim() }))()`);
    check("paid-by is pre-selected: YOU", pre.paid.length === 1 && pre.paid[0] === me, pre.paid.join(","));
    check("THE SPLIT DEFAULTS TO EVERYONE ON THE TRIP, evenly, and its row says so",
      pre.split === "Everyone, evenly", pre.split);
    check("every row is closed on open", pre.open === 0, `${pre.open} open`);
    check("the currency beside the amount is its code", /^[A-Z]{3}$/.test(pre.cur), pre.cur);
    await shot("h-02-drawer");

    // THE NUMBER, typed. Real keys into a really-focused field: nothing here sets .value.
    await typeInto(cdp, S, ".sp-amtin", "48.00");
    check("the digits reached the field as a keyboard would make them",
      await ev(cdp, S, `document.querySelector(".sp-amtin").value`) === "48.00",
      await ev(cdp, S, `JSON.stringify(document.querySelector(".sp-amtin").value)`));
    check("Add un-disables the moment the amount parses",
      await ev(cdp, S, `!document.querySelector('[data-act="save"]').disabled`));
    await tap(cdp, S, '[data-act="save"]', { label: "Add purchase" });
    await sleep(1000);

    // THE FAST PATH IS TWO TAPS AND A NUMBER: the +, then Add purchase. The keypad came up with
    // the sheet. Counted rather than assumed, so a redesign that quietly adds a third fails here.
    check("THE FAST PATH COSTS TWO TAPS AND A NUMBER — the +, Add purchase",
      taps === 2, `${taps} decision taps, ${caretTaps} caret taps`);
    const feed1 = await ev(cdp, S, `document.querySelector(".sp-feed").innerText`);
    check("the purchase is in the feed", /48\.00/.test(feed1),
      feed1.replace(/\n+/g, " | ").slice(0, 140));
    const P1 = await mintedRow(cdp, S, known);
    check("the id is client-minted with the uid('pu') prefix", /^pu-/.test(P1), P1);
    // Addressed BY ID, not as "the first row". On a phone with a ledger already on it the
    // first row in the DOM is whatever sorts newest, which is not necessarily the one this
    // section just made.
    check("…its row says who paid and your share, in words", /You paid/.test(await ev(cdp, S, `document.querySelector('.sp-row[data-id="${P1}"]').innerText`)) &&
      /your share /.test(await ev(cdp, S, `document.querySelector('.sp-row[data-id="${P1}"]').innerText`)),
      await ev(cdp, S, `document.querySelector('.sp-row[data-id="${P1}"]').innerText.replace(/\\n+/g, " | ")`));
    check("the payer wears their initials mark, one per row",
      /^[A-Z?]{2}$/.test(await ev(cdp, S, `document.querySelector('.sp-row[data-id="${P1}"] .sp-mark').textContent`)) &&
      (await ev(cdp, S, `document.querySelectorAll('.sp-row[data-id="${P1}"] .sp-mark').length`)) === 1,
      await ev(cdp, S, `document.querySelector('.sp-row[data-id="${P1}"] .sp-mark').textContent`));
    check(baseIds.length
      ? "\"Everyone's balances\" is there (it was already: this phone opened with a ledger)"
      : "\"Everyone's balances\" appeared with the first purchase",
      await ev(cdp, S, `document.querySelectorAll('#view [data-act="settle"]').length`) === 1);
    await shot("h-03-one-row");

    // ── 2. it is really a row ──────────────────────────────────────────────────────────
    section("2. the row reached D1, and the shares sum to the amount");
    await inStore(cdp, S, `await store.flush(); return 1;`);
    await sleep(1400);
    const r1 = d1(`SELECT amount_minor, amount_exp, currency, paid_by, split_mode, created_by
      FROM purchases WHERE id = '${P1}'`);
    check("one row, exactly once (the POST upserts on the client id)", r1.length === 1);
    check("the amount is stored AS PAID, in integer minor units",
      r1[0] && r1[0].amount_minor === 4800 && r1[0].amount_exp === 2,
      r1[0] && `${r1[0].currency} ${r1[0].amount_minor} exp ${r1[0].amount_exp}`);
    check("created_by is the session user, taken from the cookie and never from the body",
      r1[0] && r1[0].created_by === me);
    const s1 = d1(`SELECT user_id, weight, share_minor FROM purchase_shares
      WHERE purchase_id = '${P1}' ORDER BY user_id`);
    check("everyone on the trip is in the split, at weight 1",
      s1.length === members.length && s1.every((s) => s.weight === 1),
      s1.map((s) => s.share_minor).join("+"));
    check("THE INVARIANT — SUM(share_minor) = amount_minor",
      s1.reduce((a, s) => a + s.share_minor, 0) === 4800,
      `${s1.reduce((a, s) => a + s.share_minor, 0)} = 4800`);

    // ── 3. deselecting, and the 3-way split of 10.00 ───────────────────────────────────
    // 10.00 over three people is the case that separates an app that does money from an app
    // that does arithmetic on floats: 1000/3 is not an integer, `amount/n` rounded three
    // times is 3.33+3.33+3.33 = 9.99, and the missing céntimo is somebody's. allocate()
    // hands the remainder out one minor unit at a time, so the shares are 334/333/333 in some
    // order and they sum EXACTLY.
    section("3. deselecting people changes the shares — and 10.00 three ways still sums");
    const three = [me, ...members.filter((m) => m.id !== me).slice(0, 2).map((m) => m.id)];
    const dropped = members.filter((m) => !three.includes(m.id)).map((m) => m.id);
    taps = 0; caretTaps = 0;
    await tap(cdp, S, "#rt-fixed .fab", { label: "the FAB", bot: 4 });
    await drawerReady(cdp, S, { focus: ".sp-amtin" });
    await typeInto(cdp, S, ".sp-amtin", "10.00");
    await tap(cdp, S, '[data-act="open-split"]', { label: "the Split row" });
    for (const id of dropped) {
      await tap(cdp, S, `[data-grp="split"] .sp-person[data-id="${CSS_ESC(id)}"]`,
        { label: `deselect ${id}` });
    }
    const afterDrop = await J(cdp, S, `(() => ({
      on: [...document.querySelectorAll('[data-grp="split"] .sp-person')]
        .filter((n) => n.getAttribute("aria-checked") === "true").map((n) => n.dataset.id),
      note: (document.querySelector('[data-slot="split-note"]') || {}).textContent || "" }))()`);
    check("the people this thumb tapped are the people who came off",
      afterDrop.on.length === three.length && three.every((id) => afterDrop.on.includes(id)),
      `${afterDrop.on.length} left: ${afterDrop.on.join(",")}`);

    // Evenly, each person still in shows their share beside their name: the shares as the
    // sheet would save them. Equal is arithmetic, not a mode: saveDrawer() stores weights when
    // the amounts are the equal split.
    const prefill = await J(cdp, S, `(() => ({
      vals: [...document.querySelectorAll(".sp-uin")].map((n) => n.value),
      said: document.querySelector('[data-slot="ans-split"]').textContent,
      by: ([...document.querySelectorAll('.sp-seg [role="radio"]')].find((b) => b.getAttribute("aria-checked") === "true") || {}).textContent || "" }))()`);
    const cents = prefill.vals.map((v) => Math.round(Number(v) * 100)).sort((a, b) => a - b);
    check("one share beside each person still in the split, and they are the EQUAL share",
      prefill.vals.length === 3 && JSON.stringify(cents) === JSON.stringify([333, 333, 334]),
      prefill.vals.join(" / "));
    check("…and the Split row says it in words: 3 people, evenly",
      prefill.said === "3 people, evenly" && /Evenly/.test(prefill.by), `${prefill.said} (${prefill.by})`);
    await shot("h-04-three-way");
    await tap(cdp, S, '[data-act="save"]', { label: "Add" });
    await sleep(1000);
    const P2 = await mintedRow(cdp, S, known);
    await inStore(cdp, S, `await store.flush(); return 1;`);
    await sleep(1400);
    const s2 = d1(`SELECT user_id, weight, share_minor FROM purchase_shares
      WHERE purchase_id = '${P2}' ORDER BY user_id`);
    const mode2 = (d1(`SELECT split_mode FROM purchases WHERE id = '${P2}'`)[0] || {}).split_mode;
    check("D1 has exactly the three people the thumb left selected",
      s2.length === 3 && three.every((id) => s2.some((s) => s.user_id === id)),
      s2.map((s) => s.user_id).join(","));
    check("A THREE-WAY SPLIT OF 10.00 IS 334/333/333 AND SUMS TO EXACTLY 1000",
      s2.reduce((a, s) => a + s.share_minor, 0) === 1000 &&
      JSON.stringify(s2.map((s) => s.share_minor).sort((a, x) => a - x)) === JSON.stringify([333, 333, 334]),
      s2.map((s) => s.share_minor).join("+"));
    check("…and it is still an EQUAL split — weights, not exact amounts",
      mode2 === "weight" && s2.every((s) => s.weight === 1), `split_mode ${mode2}`);
    check("…so the feed row has one mark and your share, and does NOT say unequal",
      await ev(cdp, S, `(() => { const r = document.querySelector('.sp-row[data-id="${P2}"]');
        return r.querySelectorAll(".sp-mark").length === 1 && /your share \\D*3\\.3[34]$/.test(r.querySelector(".sp-mine").textContent) && !/unequal/.test(r.innerText); })()`),
      await ev(cdp, S, `document.querySelector('.sp-row[data-id="${P2}"]').innerText.replace(/\\n+/g, " | ")`));

    // ── 4. unequal after the fact ──────────────────────────────────────────────────────
    // This is the PRIMARY unequal path: it could be after someone has already added an
    // item. So it is done on P2, which is already
    // saved, already flushed, and already sitting in D1 with three equal weights.
    section("4. unequal on an ALREADY SAVED, ALREADY SYNCED purchase");
    check("the row under test really is in D1 already, as an equal split",
      d1(`SELECT id FROM purchases WHERE id = '${P2}'`).length === 1 && mode2 === "weight");
    taps = 0; caretTaps = 0;
    // Which row the click reached: a tap that lands on another purchase is someone editing the
    // wrong money. (This row sits far down the trip's list and is dragged into view first.)
    await ev(cdp, S, `(window.__rowTapped = null, document.addEventListener("click", (e) => { const r = e.target.closest && e.target.closest(".sp-row"); if (r && window.__rowTapped === null) window.__rowTapped = r.dataset.id; }, { capture: true, once: true }), 1)`);
    // SPLIT_REACH_BAND=1 starts the row where v101's gate found it: its foot 40 px above the
    // screen's, inside #view and under the 70 px centre() keeps clear (set by scrollTop: this is
    // where the row starts, not how it is reached; the reach and the tap stay real).
    if (process.env.SPLIT_REACH_BAND) {
      // Set, then measured once the page has settled: scrolling moves the header too, and the
      // row with it. Set again until it stays in the strip (three times at most).
      const ROW = `.sp-row[data-id="${P2}"]`;
      let band = null;
      for (let i = 0; i < 3; i++) {
        await ev(cdp, S, `(() => { const v = document.querySelector("#view"), e = document.querySelector(${JSON.stringify(ROW)});
          if (v && e) v.scrollTop += e.getBoundingClientRect().bottom - (window.innerHeight - 40); return 1; })()`);
        await sleep(400);
        await still(cdp, S, ROW);
        band = await J(cdp, S, `(() => { const v = document.querySelector("#view"), e = document.querySelector(${JSON.stringify(ROW)});
          if (!v || !e) return null; const b = e.getBoundingClientRect(), vb = v.getBoundingClientRect();
          return { rowBot: Math.round(b.bottom), inner: window.innerHeight, viewBot: Math.round(vb.bottom), tries: ${i + 1} }; })() || null`);
        if (band && band.rowBot > band.inner - 70 && band.rowBot < band.viewBot - 12) break;
      }
      check("planted start: the row's foot is inside #view and under centre()'s margin, settled",
        !!band && band.rowBot > band.inner - 70 && band.rowBot < band.viewBot - 12, JSON.stringify(band));
    }
    const at4 = await tap(cdp, S, `.sp-row[data-id="${P2}"]`, { label: "the feed row", bot: 70, host: "#view" });
    const reached = await ev(cdp, S, `window.__rowTapped`);
    check("the tap on the 10.00 row opened that row, no other",
      reached === P2, `tapped at y ${Math.round(at4.y)} (still after ${at4.settled} ms); under the finger as it landed ${String(at4.under).slice(0, 8)}, ${at4.anims} animation(s) running; reached ${String(reached).slice(0, 8)} (P2 ${P2.slice(0, 8)})`);
    // No `focus` here, and that is the assertion below: the EDIT drawer must arrive with
    // nothing focused. Waiting on data-entered rather than a sleep is what makes "no field is
    // focused on open" a statement about the settled drawer instead of about a drawer that
    // simply had not got round to focusing anything yet.
    await drawerReady(cdp, S);
    check("the SAME drawer opens, titled Edit purchase",
      /Edit purchase/.test(await ev(cdp, S, `(document.querySelector(".sh-title") || {}).textContent || ""`)));
    check("no field is focused on open — this drawer opens for reading as often as writing",
      await ev(cdp, S, `!(document.activeElement && document.activeElement.classList.contains("sp-amtin"))`));
    check("the amount is prefilled from the row",
      await ev(cdp, S, `document.querySelector(".sp-amtin").value`) === "10.00");
    await tap(cdp, S, '[data-act="open-split"]', { label: "the Split row" });
    await sleep(300);
    // 5.00 / 3.00 / 2.00 — deliberately nothing like 334/333/333, so isEqualSplit() cannot
    // call it equal by accident, and it still sums to exactly 10.00.
    const WANT = { [three[0]]: "5.00", [three[1]]: "3.00", [three[2]]: "2.00" };
    for (const id of three) {
      await tap(cdp, S, `.sp-uin[data-id="${CSS_ESC(id)}"]`, { label: `the share field for ${id}`, caret: true });
      await sleep(120);
      await typeInto(cdp, S, `.sp-uin[data-id="${CSS_ESC(id)}"]`, WANT[id], { clear: true });
    }
    const sum4 = await J(cdp, S, `(() => ({
      state: document.querySelector('[data-slot="sum"]').dataset.state,
      words: document.querySelector('[data-slot="sum"]').innerText.trim(),
      by: ([...document.querySelectorAll('.sp-seg [role="radio"]')].find((b) => b.getAttribute("aria-checked") === "true") || {}).textContent || "",
      vals: [...document.querySelectorAll(".sp-uin")].map((n) => n.dataset.id + "=" + n.value),
      save: !document.querySelector('[data-act="save"]').disabled }))()`);
    check("typing the shares chose By amount by itself; the line under the list tracked every keystroke and the button followed",
      sum4.state === "ok" && /10\.00 of .*10\.00/.test(sum4.words) && /By amount/.test(sum4.by) && sum4.save,
      `${sum4.state}: ${sum4.words} (${sum4.by}) — ${sum4.vals.join(" ")}`);
    await shot("h-05-unequal");
    await tap(cdp, S, '[data-act="save"]', { label: "Save changes" });
    await sleep(1100);
    // This path costs 3 taps and the share amounts. The three decisions are
    // the row, Split and Save changes; putting the caret in each share field is part of
    // entering the amounts, exactly as the amount field's (auto-given) focus is part of "the
    // number" in the two-tap row. Both numbers are printed so neither is hidden.
    check("THREE TAPS AND THE SHARE AMOUNTS — the primary unequal path",
      taps === 3, `${taps} decision taps + ${caretTaps} caret taps, one per share field typed into`);
    await inStore(cdp, S, `await store.flush(); return 1;`);
    await sleep(1400);
    const s4 = d1(`SELECT user_id, weight, share_minor FROM purchase_shares
      WHERE purchase_id = '${P2}' ORDER BY user_id`);
    const mode4 = (d1(`SELECT split_mode FROM purchases WHERE id = '${P2}'`)[0] || {}).split_mode;
    const want4 = three.slice().sort().map((id) => Math.round(Number(WANT[id]) * 100));
    check("D1 now holds split_mode 'exact', with the typed amounts as the weights",
      mode4 === "exact" && JSON.stringify(s4.map((s) => s.share_minor)) === JSON.stringify(want4) &&
      s4.every((s) => s.weight === s.share_minor),
      `${mode4}: ` + s4.map((s) => `${s.share_minor}`).join("/"));
    check("…and it STILL sums to exactly the amount",
      s4.reduce((a, s) => a + s.share_minor, 0) === 1000,
      `${s4.reduce((a, s) => a + s.share_minor, 0)} = 1000`);
    check("the feed says so in WORDS beside your share, carried by no hue at all",
      /your share .*5\.00, unequal/.test(await ev(cdp, S, `document.querySelector('.sp-row[data-id="${P2}"]').innerText`)),
      await ev(cdp, S, `document.querySelector('.sp-row[data-id="${P2}"]').innerText.replace(/\\n+/g, " | ")`));

    // ── 5. the keyboard ────────────────────────────────────────────────────────────────
    // V5 item 9: "when the keyboard opens, nothing moves except the inside of the sheet".
    // Everything here is measured in SCREEN coordinates (client rect minus the visual
    // viewport's offset), because the whole of the iOS failure is the layout viewport sliding
    // under a page that is trying to stand still — a client rect that holds while the layout
    // viewport moves is a page that MOVED on the glass.
    section("5. the on-screen keyboard — the drawer's half of V5 item 9");
    // The height the shell remembers from the last time a real keyboard was measured.
    // Headless Chrome never raises one, so sheet.js's goTall() would fall back to a 42% guess
    // and this section would be measuring its own guess. Seeding the number a real phone
    // would already have stored is a FIXTURE, not a simulated event: no behaviour is faked,
    // the drawer simply knows what it knows on the second focus of its life.
    await ev(cdp, S, `localStorage.setItem("wgp.kbh", "${KB}"), 1`);
    const SNAP = `(() => {
      const off = window.visualViewport ? window.visualViewport.offsetTop : 0;
      const q = (n) => Math.round(n * 100) / 100;
      const r = (sel) => { const e = document.querySelector(sel); if (!e) return null;
        const bb = e.getBoundingClientRect(); return [q(bb.x), q(bb.y - off), q(bb.width), q(bb.height)]; };
      const v = document.getElementById("view");
      return { viewTop: v ? v.scrollTop : null, winY: window.scrollY, bodyTop: document.body.style.top,
        feed: r(".sp-feed"), firstRow: r(".sp-row"), head: r(".sp-head") };
    })()`;
    const parked = await J(cdp, S, SNAP);
    await tap(cdp, S, "#rt-fixed .fab", { label: "the FAB", bot: 4 });
    await drawerReady(cdp, S, { focus: ".sp-amtin" });
    const opened = await J(cdp, S, SNAP);
    check("K1 opening the drawer moved nothing behind it",
      JSON.stringify(parked) === JSON.stringify(opened),
      JSON.stringify(parked) + " -> " + JSON.stringify(opened));
    check("K2 the app behind the sheet is inert, so a stray tap cannot reach it",
      await ev(cdp, S, `!!document.querySelector("#view[inert]")`));
    // The + itself asked for the keypad: the amount is focused in that tap, and the sheet is at
    // its tall detent from its first frame.
    const tall = await J(cdp, S, `(() => ({
      tall: (document.querySelector(".sh-root") || {}).dataset ? document.querySelector(".sh-root").dataset.tall : null,
      focus: (document.activeElement || {}).className || "",
      kb: Number(localStorage.getItem("wgp.kbh")) }))()`);
    check("K3 the + took the sheet to its TALL detent with the amount focused, before any key rose",
      tall.tall === "1" && /sp-amtin/.test(tall.focus), JSON.stringify(tall));
    // THE BUTTON AT THE FOOT, ABOVE THE KEYS. On a phone the keyboard is an overlay: the sheet
    // keeps its full-screen box and its foot passes behind the keys, and sheet.js writes the
    // keys' height to --sh-kb (and data-kb) from visualViewport. Headless Chrome raises no
    // keyboard, so the numbers a phone's keyboard makes are written here by hand: the button
    // must then stand above the key line, full width, in the sheet's foot.
    const keyLine = H - KB;
    const addBox = await J(cdp, S, `(() => { const root = document.querySelector(".sh-root:last-of-type");
      root.style.setProperty("--sh-kb", "${KB}px"); root.dataset.kb = "1";
      return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const n = document.querySelector('[data-act="save"]'), bb = n.getBoundingClientRect(),
          sh = document.querySelector(".sh-root:last-of-type .sh-sheet").getBoundingClientRect();
        res({ top: Math.round(bb.top), bot: Math.round(bb.bottom), w: Math.round(bb.width), sheetW: Math.round(sh.width),
          head: !!n.closest(".sh-head"), words: n.textContent.trim() }); }))); })()`);
    check("K4 Add purchase is the sheet's FOOT button, full width, standing above the key line",
      !addBox.head && addBox.bot <= keyLine && addBox.bot > keyLine - 90 && addBox.w >= addBox.sheetW - 40 && addBox.words === "Add purchase",
      `Add ${addBox.top}–${addBox.bot}, ${addBox.w} wide of ${addBox.sheetW}; key line ${keyLine}`);
    await shot("h-06a-keys-by-hand");
    await ev(cdp, S, `(() => { const root = document.querySelector(".sh-root:last-of-type"); root.style.removeProperty("--sh-kb"); delete root.dataset.kb; return 1; })()`);

    // A REAL viewport shrink, with the field really focused. Not a shimmed getter: the
    // viewport genuinely becomes 508px tall, the engine genuinely relayouts, and it genuinely
    // gets its chance to re-reveal the focused field by scrolling something.
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: W, height: H - KB, deviceScaleFactor: 2, mobile: true }, S);
    await sleep(750);
    const shrunk = await J(cdp, S, SNAP);
    const shrunkState = await J(cdp, S, `(() => { const s = document.querySelector(".sh-sheet");
      const a = document.querySelector('[data-act="save"]').getBoundingClientRect();
      return { open: !!document.querySelector(".sh-root"),
        focus: (document.activeElement || {}).className || "",
        sheetBot: s ? Math.round(s.getBoundingClientRect().bottom) : null,
        addBot: Math.round(a.bottom), inner: window.innerHeight }; })()`);
    check("K5 the drawer survived a real 336px viewport shrink and kept the field focused",
      shrunkState.open && /sp-amtin/.test(shrunkState.focus), JSON.stringify(shrunkState));
    check("K6 the sheet re-sized itself onto the smaller viewport",
      shrunkState.sheetBot !== null && shrunkState.sheetBot <= shrunkState.inner + 1,
      `.sh-sheet bottom ${shrunkState.sheetBot}, viewport ${shrunkState.inner}`);
    check("K7 Add purchase is STILL on screen with the keys up, at the foot of what is left",
      shrunkState.addBot > shrunkState.inner - 90 && shrunkState.addBot <= shrunkState.inner,
      `Add bottom ${shrunkState.addBot} of ${shrunkState.inner}`);
    check("K8 the feed behind it did not scroll and the page was not moved on the glass",
      parked.viewTop === shrunk.viewTop && parked.winY === shrunk.winY,
      `#view.scrollTop ${parked.viewTop} -> ${shrunk.viewTop}, scrollY ${parked.winY} -> ${shrunk.winY}`);
    await shot("h-06-keyboard");

    // Type with the keys "up". The whole point of the tall detent plus the button held above
    // the keys is that the sheet is still usable in 508px, so use it in 508px.
    await typeInto(cdp, S, ".sp-amtin", "7.50");
    check("K9 the amount field still takes real keystrokes with the viewport shrunk",
      await ev(cdp, S, `document.querySelector(".sp-amtin").value`) === "7.50");
    // A real tap into the SECOND text field, which is what sheet.js's touchstart handler is
    // for: go tall, scroll the drawer so the field is above the key line, then focus — in one
    // gesture, because WebKit has already decided whether to move the PAGE by the time
    // focusin runs.
    const descPt = await tap(cdp, S, '[data-f="description"]', { label: "the description field", caret: true });
    await sleep(320);
    const onDesc = await J(cdp, S, `(() => { const d = document.querySelector('[data-f="description"]');
      const bb = d.getBoundingClientRect();
      return { focus: (document.activeElement || {}).dataset ? document.activeElement.dataset.f : null,
        bot: Math.round(bb.bottom), inner: window.innerHeight }; })()`);
    check("K10 a real tap on the description field focused IT, not whatever slid under the finger",
      onDesc.focus === "description", JSON.stringify(onDesc));
    check("K11 …and the drawer scrolled it clear of the keys rather than moving the page",
      onDesc.bot <= onDesc.inner, `field bottom ${onDesc.bot} of ${onDesc.inner}`);
    const during = await J(cdp, S, SNAP);
    check("K12 nothing behind the sheet moved through any of it",
      parked.viewTop === during.viewTop && parked.winY === during.winY,
      JSON.stringify(parked) + " -> " + JSON.stringify(during));
    await typeInto(cdp, S, '[data-f="description"]', "Keys up");
    check("K13 the description took real keystrokes too",
      await ev(cdp, S, `document.querySelector('[data-f="description"]').value`) === "Keys up");

    // The keys come down. A real resize back, then out through the backdrop — which is what
    // cancel means on this drawer, and which must discard.
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: W, height: H, deviceScaleFactor: 2, mobile: true }, S);
    await sleep(600);
    // The backdrop is `inset: 0`, so centre() correctly refuses it — its centre is underneath
    // the sheet. The strip of it above the drawer is where a thumb actually reaches it, and
    // 30px down is inside that strip whichever detent the drawer settled at. Asserted first,
    // because a tap that missed and landed on the sheet leaves it open and every check below
    // would then be reporting on the wrong thing.
    const scrimTop = await J(cdp, S, `(() => { const s = document.querySelector(".sh-sheet");
      return { sheetTop: s ? Math.round(s.getBoundingClientRect().top) : null }; })()`);
    check("K14a the backdrop is genuinely exposed above the drawer at y=30",
      scrimTop.sheetTop !== null && scrimTop.sheetTop > 30, `.sh-sheet top = ${scrimTop.sheetTop}`);
    await cdp.send("Input.dispatchTouchEvent",
      { type: "touchStart", touchPoints: finger(W / 2, 30) }, S);
    await sleep(70);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, S);
    await sleep(900);
    const closed = await J(cdp, S, SNAP);
    check("K14 a real tap on the backdrop dismissed the drawer",
      (await ev(cdp, S, `document.querySelectorAll(".sh-root").length`)) === 0);
    // NO NEW ROW, rather than "no 7.50 anywhere on the feed". The old spelling would be
    // defeated by a baseline row that happens to cost 7.50 — and would then be reporting on
    // a real dinner instead of on the discard.
    const strays = await J(cdp, S, `(() => {
      const skip = ${JSON.stringify([...known])};
      return [...document.querySelectorAll(".sp-row")]
        .map((r) => r.dataset.id).filter((id) => !skip.includes(id)); })()`);
    check("K15 …and discarded — the 7.50 that was typed minted no row at all",
      strays.length === 0, strays.join(",") || "no new rows");
    check("K16 closing left the page byte-exactly where the thumb parked it",
      JSON.stringify(parked) === JSON.stringify(closed),
      JSON.stringify(parked) + " -> " + JSON.stringify(closed));
    check("K17 …with no `inert` left on #view, which would make the next screen unreachable",
      !(await ev(cdp, S, `!!document.querySelector("#view[inert]")`)));

    // ── 6. no signal ───────────────────────────────────────────────────────────────────
    // Amounts entered in a market with no bars are the normal case, not the edge
    // case. So the radio really goes off — navigator.onLine really becomes false — the
    // purchase is entered by thumb exactly as it was on wifi, and then the page is RELOADED
    // before anything has flushed.
    section("6. entered with the radio off, survives a reload, flushes on reconnect");
    await cdp.send("Network.emulateNetworkConditions",
      { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, S);
    await inStore(cdp, S, `try { await store.refresh(); } catch (e) {} return 1;`);
    await sleep(700);
    check("O1 the browser really is offline and the store has derived it",
      (await ev(cdp, S, `navigator.onLine ? 1 : 0`)) === 0 &&
      (await inStore(cdp, S, `return store.online() ? 1 : 0`)) === 0);
    const beforeOff = await ev(cdp, S, `document.querySelectorAll(".sp-row").length`);
    await tap(cdp, S, "#rt-fixed .fab", { label: "the FAB", bot: 4 });
    await drawerReady(cdp, S, { focus: ".sp-amtin" });
    await typeInto(cdp, S, ".sp-amtin", "9.90");
    await tap(cdp, S, '[data-act="save"]', { label: "Add" });
    await sleep(900);
    const P3 = await mintedRow(cdp, S, known);
    check("O2 the purchase appears IMMEDIATELY, with no network at all",
      (await ev(cdp, S, `document.querySelectorAll(".sp-row").length`)) === beforeOff + 1 &&
      /9\.90/.test(await ev(cdp, S, `document.querySelector('.sp-row[data-id="${P3}"]').innerText`)),
      `${beforeOff} -> ${await ev(cdp, S, `document.querySelectorAll(".sp-row").length`)} rows`);
    check("O3 it looks exactly like a synced row — no per-row sync state (v3 item 4)",
      await ev(cdp, S, `!document.querySelector(".sp-row [class*=pending],.sp-row [class*=queue]")`));
    const queued = await inStore(cdp, S, `return store.pending()`);
    check("O4 the durable queue is carrying it", queued >= 1, `${queued} queued`);
    check("O5 it is NOT in D1 yet — nothing was sent",
      d1(`SELECT id FROM purchases WHERE id = '${P3}'`).length === 0);
    await shot("h-07-offline");

    // THE RELOAD. The document has to come from somewhere, and this harness bypasses the
    // service worker on purpose (see the header), so the radio comes back for the shell while
    // /api/* stays blocked — the app boots with no server it can reach, which is the state the
    // assertion is about. Whether the SHELL itself boots from the SW cache with the radio
    // genuinely cut is scripts/split_wiring_check.mjs section 5, and is not re-proved here.
    //
    // THE ORDER OF THESE TWO CALLS IS THE WHOLE TEST. Restoring the radio first cost this
    // harness a run: `offline: false` fires a real `online` event in the renderer, store.js
    // reacts to it by flushing, and the POST was already out the door before the block landed
    // a round-trip later — so the reload was measuring a queue that had nothing left in it.
    // Block first, restore second, and the flush that the online event kicks off is refused.
    await cdp.send("Network.setBlockedURLs", { urls: ["*/api/*"] }, S);
    await cdp.send("Network.emulateNetworkConditions",
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
    await sleep(900);
    check("O6 the radio is back but the server is not — and the write is still owed",
      (await inStore(cdp, S, `return store.pending()`)) >= 1 &&
      d1(`SELECT id FROM purchases WHERE id = '${P3}'`).length === 0,
      `${await inStore(cdp, S, `return store.pending()`)} queued`);
    await reloadTo(cdp, S, "#/split");
    await sleep(2600);
    await waitFor(cdp, S, `document.querySelector(".sp-h1") ? 1 : 0`, { label: "Split after the reload" });
    const survived = await J(cdp, S, `(async () => { const { store } = await import("/js/store.js");
      const r = store.purchase(${JSON.stringify(P3)});
      return { row: r ? r.amount_minor : null, shares: r ? r.shares.length : 0,
        pending: store.pending(),
        onFeed: !!document.querySelector('.sp-row[data-id=${JSON.stringify(P3)}]') }; })()`);
    check("O7 THE PURCHASE SURVIVED THE RELOAD — off IndexedDB, with its shares",
      survived.row === 990 && survived.shares === members.length && survived.onFeed,
      JSON.stringify(survived));
    check("O8 …and so did the queue: the write is still owed to the server",
      survived.pending >= 1, `${survived.pending} queued after the reload`);
    check("O9 it is still not in D1 — the reload sent nothing either",
      d1(`SELECT id FROM purchases WHERE id = '${P3}'`).length === 0);

    await cdp.send("Network.setBlockedURLs", { urls: [] }, S);
    await inStore(cdp, S, `await store.flush(); return 1;`);
    await sleep(2200);
    await waitFor(cdp, S,
      `(async () => { const { store } = await import("/js/store.js"); return store.pending() === 0 ? 1 : 0; })()`,
      { label: "the queue drained" });
    const flushed = d1(`SELECT amount_minor FROM purchases WHERE id = '${P3}'`);
    check("O10 THE QUEUE DRAINED WHEN THE SERVER CAME BACK, and D1 has the typed amount",
      flushed.length === 1 && flushed[0].amount_minor === 990,
      flushed[0] && String(flushed[0].amount_minor));
    check("O11 …with the whole share map, not a fragment of one",
      d1(`SELECT COUNT(*) n, SUM(share_minor) s FROM purchase_shares WHERE purchase_id = '${P3}'`)[0].n
        === members.length &&
      d1(`SELECT SUM(share_minor) s FROM purchase_shares WHERE purchase_id = '${P3}'`)[0].s === 990);
    await waitMe(cdp, S, me);

    // ── 7. settle up ───────────────────────────────────────────────────────────────────
    // A FIXTURE WHOSE ANSWER WAS WORKED OUT BEFORE THE CODE RAN, and denominated in a
    // currency this trip has never used so that the settle sheet's "By currency" block over
    // it contains nothing else. Four people: A = you, and B, C, D from the roster.
    //
    //   F1  A pays €120.00, split A B C D   ->  3000 each
    //   F2  B pays  €40.00, split A B       ->  2000 each
    //   F3  C pays  €60.00, split C D       ->  3000 each
    //
    //   A: paid 12000, share 3000+2000 = 5000  ->  net +7000   is owed €70.00
    //   B: paid  4000, share 3000+2000 = 5000  ->  net -1000   owes    €10.00
    //   C: paid  6000, share 3000+3000 = 6000  ->  net     0   settled
    //   D: paid     0, share 3000+3000 = 6000  ->  net -6000   owes    €60.00
    //                                              sum = 0
    //
    // Three non-zero balances and no proper subset of them sums to zero (7000-1000,
    // 7000-6000, -1000-6000 are all non-zero), so the minimum is 3 - 1 = TWO transfers, and
    // there is only one two-transfer answer:  D pays A €60.00,  B pays A €10.00.
    // money.js sorts the biggest payment first, so that is also the order.
    section("7. settle up — the fewest-transfer answer on a hand-computed fixture");
    const A = me;
    const [B, C, D] = members.filter((m) => m.id !== me).slice(0, 3).map((m) => m.id);
    const nameOfId = (id) => (members.find((m) => m.id === id) || {}).name;
    // Who pays whom as this phone says it: the viewer is "You" (split.js paysWords()).
    // Settle up's lines name people by their first names (each is unique on the gate's trip).
    const first = (id) => String(nameOfId(id)).split(/\s+/)[0];
    const paysAs = (from, to) => `${from === me ? "You" : first(from)} ${from === me ? "pay" : "pays"} ${to === me ? "you" : first(to)}`;
    const FIX = [
      { amount: "120.00", payer: A, split: [A, B, C, D] },
      { amount: "40.00",  payer: B, split: [A, B] },
      { amount: "60.00",  payer: C, split: [C, D] },
    ];
    // ── THE EUR BASELINE, and why this block needs one at all ─────────────────────────
    //
    // This fixture used to assert ABSOLUTE numbers — "A is owed €70.00" — and that held
    // only because of an assumption it never wrote down: that the EUR block on the settle sheet
    // could contain nothing but the three rows immediately below. That was true for exactly as
    // long as GET /api/trips/<id> did not carry `purchases`. It now does, so the EUR block can also
    // hold rows this run never made: rows another member added, and — the case that actually
    // bit — rows a CONCURRENT run of this very file is minting into the same local D1 while
    // this one reads it.
    //
    // That cross-run interference is not a bug. It is the feature: two runs used to be
    // invisible to each other precisely because purchases stopped at the database, and the day
    // that was fixed is the day a purchase made on one person's phone started reaching another's.
    // What has to change is the fixture, which is now stated as a DELTA: whatever EUR this
    // phone already had, these three purchases must move each person's net by exactly the
    // amounts hand-computed below. On a clean machine the baseline is zero and every number is
    // the same number it always was.
    const eurBase = await J(cdp, S, `(async () => {
      const { store } = await import("/js/store.js");
      const { netBalances } = await import("/js/money.js");
      const rows = store.purchases().filter((p) => p.currency === ${JSON.stringify(FX)});
      const led = netBalances(rows, store.members().map((m) => m.id),
        { to: ${JSON.stringify(FX)}, toExp: 2, rates: {} });
      return { rows: rows.length, net: Object.fromEntries(led.net),
               paid: Object.fromEntries(led.paid), owed: Object.fromEntries(led.owed),
               back: Object.fromEntries(led.back), got: Object.fromEntries(led.got) }; })()`);
    console.log(`        ${FX} baseline: ${eurBase.rows} purchase${eurBase.rows === 1 ? "" : "s"}` +
      ` already on this phone${eurBase.rows ? " — the fixture is asserted as a delta on top" : ""}`);

    for (let i = 0; i < FIX.length; i++) {
      const f = FIX[i];
      await tap(cdp, S, "#rt-fixed .fab", { label: "the FAB", bot: 4 });
      await drawerReady(cdp, S, { focus: ".sp-amtin" });
      await typeInto(cdp, S, ".sp-amtin", f.amount);
      if (i === 0) {
        // Only once: the device remembers the last currency it was told about, so F2 and F3
        // open in EUR already. That is the remembered default, used rather than
        // described.
        await tap(cdp, S, '[data-act="cur"]', { label: "the currency chip" });
        await tap(cdp, S, '[data-act="other-cur"]', { label: "Other currency…" });
        await drawerReady(cdp, S);                 // the picker STACKS; drawerReady reads the topmost
        await tap(cdp, S, '.sh-root:last-of-type [data-f="filter"]', { label: "the currency filter", caret: true });
        await typeInto(cdp, S, '.sh-root:last-of-type [data-f="filter"]', FX);
        await sleep(260);
        await tap(cdp, S, `.sh-root:last-of-type [data-code="${FX}"]`, { label: FX });
        await sleep(700);
      }
      check(`F${i + 1} the sheet is denominated in ${FX}`,
        new RegExp(FX).test(await ev(cdp, S, `document.querySelector('[data-act="cur"]').textContent`)),
        await ev(cdp, S, `document.querySelector('[data-act="cur"]').textContent.trim()`));
      check(`F${i + 1} …and the amount survived the currency it was typed before`,
        await ev(cdp, S, `document.querySelector(".sp-amtin").value`) === f.amount,
        await ev(cdp, S, `document.querySelector(".sp-amtin").value`));
      if (f.payer !== A) {
        await tap(cdp, S, '[data-act="open-paid"]', { label: "the Paid by row" });
        await tap(cdp, S, `[data-grp="paid"] .sp-person[data-id="${CSS_ESC(f.payer)}"]`,
          { label: `paid by ${nameOfId(f.payer)}` });
      }
      await tap(cdp, S, '[data-act="open-split"]', { label: "the Split row" });
      for (const m of members) {
        if (f.split.includes(m.id)) continue;
        await tap(cdp, S, `[data-grp="split"] .sp-person[data-id="${CSS_ESC(m.id)}"]`,
          { label: `drop ${m.id} from the split` });
      }
      const state = await J(cdp, S, `(() => ({
        paid: [...document.querySelectorAll('[data-grp="paid"] .sp-person')]
          .filter((n) => n.getAttribute("aria-checked") === "true").map((n) => n.dataset.id),
        on: [...document.querySelectorAll('[data-grp="split"] .sp-person')]
          .filter((n) => n.getAttribute("aria-checked") === "true").map((n) => n.dataset.id) }))()`);
      check(`F${i + 1} the sheet holds the fixture the thumb just built`,
        state.paid.length === 1 && state.paid[0] === f.payer &&
        state.on.length === f.split.length && f.split.every((id) => state.on.includes(id)),
        `paid ${state.paid} · split ${state.on.length}`);
      await tap(cdp, S, '[data-act="save"]', { label: "Add" });
      await sleep(1000);
      await mintedRow(cdp, S, known);
    }
    await inStore(cdp, S, `await store.flush(); return 1;`);
    await sleep(1600);

    await tap(cdp, S, '#view [data-act="settle"]', { label: "Everyone's balances", bot: 70, host: "#view" });
    await drawerReady(cdp, S);
    check("the settle sheet opened",
      /Settle up/.test(await ev(cdp, S, `(document.querySelector(".sh-title") || {}).textContent || ""`)));
    // TWO LEGITIMATE WORLDS, and this has to assert the strongest TRUE statement in whichever
    // one the machine is in — the same repair the empty-state check above needed, for the same
    // reason. Before functions/api/fx.js existed the phone could not have a rate for anything,
    // so the sheet opened converted with a banner naming the currency that was
    // missing. Now GET /api/trips/<id> carries the rate table beside note_colors, so EUR converts on
    // the first snapshot and there is nothing left to warn about. A check written for only the
    // first world fails on every machine with a working network; one written for only the
    // second fails on a machine that has never been online — which is the machine this entire
    // app exists for. So store.fx() decides which sentence is the true one and BOTH are
    // asserted. Neither branch is a skip.
    const banner = await ev(cdp, S, `(document.querySelector(".sp-banner") || {}).innerText || ""`);
    const fxRate = await inStore(cdp, S, `return store.fx().rates[${JSON.stringify(FX)}] || 0`);
    if (fxRate) {
      const sheetTxt = await ev(cdp, S, `(document.querySelector('.sh-root:last-of-type [data-slot="settle"]') || {}).innerText || ""`);
      check(`with a rate for ${FX}, there is NO banner and the fixture is inside the totals`,
        banner === "" && !/No exchange rate/.test(sheetTxt) && /Converted at rates from /.test(sheetTxt),
        `rate ${fxRate} · banner "${banner.replace(/\n+/g, " ").slice(0, 60)}"`);
    } else {
      check(`with no rate for ${FX}, the banner NAMES it and counts the purchases left out`,
        new RegExp(`No exchange rate for ${FX} yet`).test(banner) && /purchases? (isn't|aren't) counted until there is/.test(banner),
        banner.replace(/\n+/g, " ").slice(0, 140));
    }
    await tap(cdp, S, '[data-mode="currency"]', { label: "By currency" });
    await sleep(500);
    await shot("h-08-settle");

    // The block for the fixture's currency, read off the screen.
    const block = await J(cdp, S, `(() => {
      const d = document.querySelector('.sh-root:last-of-type .sp-block[data-cur="${FX}"]');
      if (!d) return null;
      return {
        head: (d.querySelector(".sp-block-head") || {}).textContent || "",
        bal: [...d.querySelectorAll(".sp-bal")].map((r) => ({
          id: r.dataset.id,
          name: r.querySelector(".sp-bal-name").textContent,
          net: r.querySelector(".sp-bal-say").textContent,
          color: getComputedStyle(r.querySelector(".sp-bal-say")).color,
          sub: (document.getElementById(r.getAttribute("aria-controls")) || {}).textContent || "",
          bars: r.querySelectorAll(".sp-bar").length })),
        count: (d.querySelector(".sp-plan-sum") || {}).textContent || "",
        trs: [...d.querySelectorAll(".sp-plan li")].map((r) => ({
          words: r.querySelector(".sp-tr-words").textContent,
          amt: r.querySelector(".num").textContent,
          go: (r.querySelector(".sp-tr-go") || {}).textContent || "",
          marks: r.querySelectorAll(".sp-mark, svg").length })) };
    })()`);
    check(`the sheet has a block of its own for ${FX}, named in words`, !!block && new RegExp(`\\(${FX}\\)$`).test(block.head),
      block && block.head);

    const byId = (id) => (block.bal.find((r) => r.id === id) || {});

    // THE HAND-COMPUTED ANSWER, worked out before the code ever ran, in minor units:
    //
    //   pu1  €120.00 paid by A, split A B C D   ->  30.00 each
    //   pu2  € 40.00 paid by B, split A B       ->  20.00 each
    //   pu3  € 60.00 paid by C, split C D       ->  30.00 each
    //
    //   A  paid 120.00  share 50.00  net +70.00
    //   B  paid  40.00  share 50.00  net -10.00
    //   C  paid  60.00  share 60.00  net   0
    //   D  paid   0.00  share 60.00  net -60.00      sum = 0  ✓
    //
    // Stated as the CONTRIBUTION of these three rows, so it can be added to whatever this
    // phone already had. Everybody not named contributes nothing at all, which is itself an
    // assertion: a fixture that touched somebody it never mentioned would be a bug.
    const DELTA = {
      [A]: { net: +7000, paid: 12000, share: 5000 },
      [B]: { net: -1000, paid: 4000, share: 5000 },
      [C]: { net: 0, paid: 6000, share: 6000 },
      [D]: { net: -6000, paid: 0, share: 6000 },
    };
    // fmtMoney's spelling, reproduced for a 2-digit currency: grouped thousands, two decimals,
    // magnitude only — the sign lives in the words. Grouping matters the moment a baseline
    // pushes a total past €1,000, which is exactly when a hand-typed "€1070.00" would be wrong.
    const NF2 = new Intl.NumberFormat("en-US",
      { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });
    const eur = (m) => `${FXSYM}${NF2.format(Math.abs(m) / 100)}`;

    const expected = new Map();
    for (const m of members) {
      const d = DELTA[m.id] || { net: 0, paid: 0, share: 0 };
      const net = (eurBase.net[m.id] || 0) + d.net;
      const paid = (eurBase.paid[m.id] || 0) + d.paid;
      const share = (eurBase.owed[m.id] || 0) + d.share;
      const back = eurBase.back[m.id] || 0, got = eurBase.got[m.id] || 0;
      const you = m.id === me;
      expected.set(m.id, {
        net, paid, share,
        words: net > 0 ? `${you ? "are" : "is"} owed ${eur(net)}` : net < 0 ? `${you ? "owe" : "owes"} ${eur(net)}` : "settled",
        sub: `Paid ${eur(paid)}. Share ${eur(share)}.` + (back ? ` Paid back ${eur(back)}.` : "") + (got ? ` Got back ${eur(got)}.` : ""),
      });
    }
    for (const id of [A, B, C, D]) {
      const name = nameOfId(id);
      const want = expected.get(id);
      const got = byId(id);
      const delta = DELTA[id].net;
      check(`balance — ${name} moves by ${delta > 0 ? "+" : ""}${(delta / 100).toFixed(2)} ` +
        `to "${want.words}", and opens to what makes it`,
        got.net === want.words && got.sub === want.sub && got.name === (id === me ? "You" : name),
        `got ${JSON.stringify({ name: got.name, net: got.net, sub: got.sub })}` +
        (eurBase.rows ? ` over a baseline of ${eurBase.rows} ${FX} row(s)` : ""));
    }
    // A by-currency block lists the people who paid or share something in that currency.
    // Somebody at zero who is IN it still appears (C here: paid 60.00, share 60.00, even);
    // somebody outside it does not, because they are not "even" in a currency they never
    // touched.
    const inBlock = members.filter((m) => { const e = expected.get(m.id); return e.paid !== 0 || e.share !== 0; });
    const zeroIn = inBlock.filter((m) => expected.get(m.id).net === 0);
    check("the block lists exactly the people in this currency, a zero balance among them included",
      block.bal.length === inBlock.length && inBlock.every((m) => block.bal.some((r) => r.id === m.id)) &&
      zeroIn.every((m) => byId(m.id).net === "settled"),
      `${block.bal.length} rows for ${inBlock.length} people in ${FX} (${zeroIn.length} of them at zero), ` +
      `of ${members.length} members`);
    // WORDS CARRY DIRECTION, NEVER COLOR (the brief's second principle): no bars, and every
    // balance's phrase in one ink, whichever way it goes.
    check("no bars, and \"owes\", \"is owed\" and \"settled\" all in one ink",
      block.bal.every((r) => r.bars === 0) && new Set(block.bal.map((r) => r.color)).size === 1,
      block.bal.map((r) => `${r.name}: ${r.net}`).join(" | "));

    // FEWEST TRANSFERS. On a clean table the answer is the hand-computed 2 and the exact pair
    // below; over a baseline it is whatever the exhaustive solver at the top of this file says,
    // which knows nothing about money.js and is the only thing that makes this an assertion
    // rather than settle() being compared with settle(). Both branches are real and neither is
    // a skip — this is the same repair the empty-state and PEN/USD blocks needed.
    const eurNets = block.bal.map((r) => (expected.get(r.id) || { net: 0 }).net);
    const trueMin = trueMinTransfers(eurNets);
    const WORD = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
    check(`FEWEST PAYMENTS: ${trueMin}, said in words, and it is the TRUE minimum`,
      new RegExp(`^${WORD[trueMin] || trueMin} payments? settles? everyone\\.$`).test(block.count) &&
      block.trs.length === trueMin,
      `${block.count} · ${block.trs.length} rows · exhaustive solver ${trueMin}` +
      (eurBase.rows ? ` (hand-computed 2 plus a baseline of ${eurBase.rows} ${FX} row(s))` : ""));
    if (!eurBase.rows) {
      const EXP_TR = [
        { words: paysAs(D, A), amt: `${FXSYM}60.00` },
        { words: paysAs(B, A), amt: `${FXSYM}10.00` },
      ];
      check("…and the two transfers are exactly the two the fixture has, biggest first",
        JSON.stringify(block.trs.map((t) => ({ words: t.words, amt: t.amt }))) === JSON.stringify(EXP_TR),
        JSON.stringify(block.trs.map((t) => `${t.words} ${t.amt}`)));
    } else {
      // The exact pair cannot be named over a baseline, but two things still must hold: the
      // list is ordered biggest-payment-first (it is the one somebody has to go and do), and
      // every payment settles a real debt rather than inventing one.
      const amts = block.trs.map((t) => Number(String(t.amt).replace(/[^0-9.]/g, "")) * 100);
      // The viewer's own come first (what they pay, then what they're paid: split.js), each
      // group biggest-payment-first.
      const group = (w) => (/^You pay /.test(w) ? 0 : / pays you$/.test(w) ? 1 : 2);
      const gs = block.trs.map((t) => group(t.words));
      check("…and the transfers are the viewer's own first, each group biggest-payment-first, every one positive",
        amts.every((v, i) => v > 0 && (i === 0 || gs[i - 1] < gs[i] || (gs[i - 1] === gs[i] && amts[i - 1] >= v))),
        JSON.stringify(block.trs.map((t) => `${t.words} ${t.amt}`)));
    }
    check("each payment is a sentence, an amount and its own Mark paid, with no marks or arrows",
      block.trs.every((t) => t.marks === 0 && /\bpays?\b/.test(t.words) && t.go === "Mark paid"),
      JSON.stringify(block.trs));

    // And the OTHER block — the messy real rows this run made, including the unequal one —
    // held to the same standard by the exhaustive solver at the top of this file, which
    // knows nothing about money.js.
    const other = await J(cdp, S, `(() => {
      for (const d of document.querySelectorAll(".sh-root:last-of-type .sp-block[data-cur]")) {
        const cur = d.dataset.cur;
        if (!cur || cur === "${FX}") continue;
        return { head: cur,
          nets: [...d.querySelectorAll(".sp-bal")].map((r) => ({ net: r.querySelector(".sp-bal-say").textContent })),
          n: [...d.querySelectorAll('.sp-tr-go[data-act="mark-paid"]')].length,
          trs: [...d.querySelectorAll(".sp-plan li")].map((r) =>
            r.querySelector(".sp-tr-words").textContent + " " + r.querySelector(".num").textContent) };
      }
      return null;
    })()`);
    if (other) {
      // THE BLOCK NAMES ITS OWN CURRENCY AND THAT IS WHAT THE QUERY HAS TO ASK FOR. This used
      // to bind HOME — store.myNativeCurrency() — and the two are not the same fact: HOME is
      // the currency the VIEWER wants totals in, while the currency these rows were actually
      // minted in is the drawer's default, i.e. the trip's FIRST ENABLED currency, which comes
      // off GET /api/trips/<id>'s `currencies`. On this trip those are USD and PEN respectively, and
      // the moment the snapshot started carrying `currencies` the query matched nothing: every
      // net came out zero, "they sum to zero" passed on six zeroes, and the exhaustive solver
      // was asked for the minimum number of transfers between nothing and answered 0 against a
      // screen showing 5. Reading the code off the eyebrow the screen has just drawn cannot
      // drift from what is on screen, which is the only thing this check was ever about.
      const CUR = other.head || HOME;
      // Recompute the nets from D1 — the server's own rows, not the screen's — and ask the
      // exhaustive solver what the minimum is.
      // EVERYTHING THE TRIP HAS IN THAT CURRENCY, not only this run's rows: the block on screen
      // settles the whole ledger (the trip's own purchases, the payments already made, and what
      // this run added), so the solver is given the same. A payment is a row like any other
      // here: who gave gains its amount, who received carries it as their share.
      const rows = d1(`SELECT p.id, p.amount_minor, p.paid_by FROM purchases p
        WHERE p.trip_id = '${TRIP}' AND p.currency = '${CUR}'`);
      const sharesOf = new Map();
      for (const s of d1(`SELECT s.purchase_id, s.user_id, s.share_minor FROM purchase_shares s
        JOIN purchases p ON p.id = s.purchase_id WHERE p.trip_id = '${TRIP}' AND p.currency = '${CUR}'`)) {
        if (!sharesOf.has(s.purchase_id)) sharesOf.set(s.purchase_id, []);
        sharesOf.get(s.purchase_id).push(s);
      }
      // The guard that would have caught the above the day it appeared, instead of letting a
      // check pass over an empty set. A block on screen with no rows behind it is a failure.
      const mine = rows.filter((r) => created.includes(r.id)).length;
      check(`the ${CUR} block is drawn over rows this run really created`, mine > 0,
        `${rows.length} rows in D1 for ${CUR}, ${mine} of them this run's`);
      const net = new Map(members.map((m) => [m.id, 0]));
      for (const r of rows) {
        net.set(r.paid_by, net.get(r.paid_by) + r.amount_minor);
        for (const s of sharesOf.get(r.id) || []) net.set(s.user_id, net.get(s.user_id) - s.share_minor);
      }
      const vals = [...net.values()];
      check(`the ${CUR} block: every net is derived from D1 and they sum to zero`,
        vals.reduce((a, v) => a + v, 0) === 0 && vals.some((v) => v !== 0), vals.join(","));
      const min = trueMinTransfers(vals);
      check(`the ${CUR} block settles in the TRUE minimum number of transfers`,
        other.n === min, `screen ${other.n}, exhaustive solver ${min} — ${other.trs.join(" | ")}`);
    } else {
      check("the sheet has a second block, for the currency the run's own rows are in",
        false, "no non-fixture block found");
    }

    // ── 8. the invariant, over every row this run made ─────────────────────────────────
    section("8. the invariant, over every purchase this run created");
    const all = d1(`SELECT p.id, p.amount_minor, p.currency,
      (SELECT COUNT(*) FROM purchase_shares s WHERE s.purchase_id = p.id) n,
      (SELECT SUM(share_minor) FROM purchase_shares s WHERE s.purchase_id = p.id) tot
      FROM purchases p WHERE p.id IN (${created.map((i) => `'${i}'`).join(",")})`);
    check("every purchase reached D1", all.length === created.length,
      `${all.length} of ${created.length}`);
    check("SUM(share_minor) = amount_minor ON EVERY ROW, no exceptions",
      all.every((r) => r.tot === r.amount_minor && r.n > 0),
      all.map((r) => `${r.currency} ${r.tot}/${r.amount_minor}`).join("  "));
    check("no purchase has an orphaned or missing share row",
      d1(`SELECT COUNT(*) n FROM purchase_shares s
        LEFT JOIN purchases p ON p.id = s.purchase_id WHERE p.id IS NULL`)[0].n === 0);

    check("no exception reached the page in the whole run", b.pageErrors.length === 0,
      b.pageErrors.join(" | ") || "clean");

  } finally {
    // Leave D1 the way it was found: children first, which is the order every delete in this
    // codebase uses, because D1 enforces the foreign key.
    //
    // THE GUARD IS NOT DEFENSIVE PROGRAMMING, it is the last line of a rule this file lives
    // by: nothing is deleted that this run did not create. `created` is only ever fed by
    // mintedRow(), which refuses any id the baseline already carried — this re-checks it at
    // the moment of the DELETE, because that is where being wrong costs someone a row rather
    // than a red line of output.
    // AND IT IS RETRIED, AND THEN VERIFIED, because a cleanup that fails quietly is how the
    // next run gets a poisoned baseline. This loop used to be a bare try/catch whose comment
    // said "a row that never made it is not a cleanup failure" — true, and it also swallowed
    // the case where the row DID make it and the DELETE lost, which is the one that matters.
    // Measured on 2026-08-22: one `wrangler d1 execute` in a three-run sequence failed for a
    // reason it never got to report, and left a purchase and its three shares behind.
    for (const id of created) {
      if (BASE_SET.has(id)) {
        console.log(`  SKIPPED cleanup of ${id} — it was on this phone before the run started`);
        continue;
      }
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          d1(`DELETE FROM purchase_shares WHERE purchase_id = '${id}'`);
          d1(`DELETE FROM purchases WHERE id = '${id}'`);
          break;
        } catch (e) {
          // Whatever went wrong is worth SAYING, even on an attempt that is about to succeed:
          // "the third try worked" is the difference between a flaky database and a flaky
          // harness, and nobody can tell them apart from silence.
          console.log(`  cleanup of ${id} failed (attempt ${attempt}/3): ${String(e).split("\n")[0].slice(0, 160)}`);
          if (attempt < 3) await sleep(600);
        }
      }
    }
    // The tally below is printed AFTER this block, so a leak is a failing check and not a
    // footnote. It is also the only assertion in this file about the state the NEXT run
    // inherits, which is the state this whole triage was about.
    if (created.length) {
      const left = d1(`SELECT id FROM purchases WHERE id IN (${created.map((i) => `'${i}'`).join(",")})`);
      check("the run left D1 exactly as it found it — every row it created is gone again",
        left.length === 0, left.map((r) => r.id).join(", ") || "nothing left behind");
    }
    await b.done();
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (SHOTS) console.log(`screenshots in ${SHOT_DIR}`);
  if (fail) { console.log(`\n${fail} FAILED:`); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
};

// Member ids are the server's own (letters, digits, - and _), so they are safe in an
// attribute selector as they stand — but the escape is here rather than in six call sites
// because the first id with a hyphen-leading segment or a digit first would break every one
// of them at once, silently, as "not on screen".
function CSS_ESC(s) { return String(s).replace(/["\\]/g, "\\$&"); }

run().catch((e) => { console.error("\nFATAL", e); process.exit(1); });

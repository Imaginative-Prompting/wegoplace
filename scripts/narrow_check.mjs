#!/usr/bin/env node
/* SMALL AND SIDEWAYS PHONES: every screen a person reaches inside a trip (a11y_check's walk: the six sections and
 * their pages, Packing, Changes, the credits, People and settings, Your trips, Your account, every add sheet open
 * and Settle up), the made-up trip's host, at
 *
 *   320 x 568 (a small phone, its status bar 20 above), 360 x 780 (a common Android width),
 *   844 x 390 (a phone on its side: the notch 47 at each side, the home bar 21 below), 667 x 375 (a smaller phone on
 *   its side, no notch), and
 *   768 x 1024 (a tablet, its status bar 24 above, its home bar 20 below),
 *
 * with the safe areas set through Chrome's own override and read back from the page first (scripts/lib/narrow.mjs,
 * the measure narrow_public_check shares). On each screen:
 *
 *   1. the page doesn't scroll sideways;
 *   2. nothing a person reads or taps runs off the side of the screen (what a sideways scroller holds is its own);
 *   3. no words are cut: no box a person reads or taps runs past the box that clips it, and no text clipped
 *      without an ellipsis;
 *   4. on its side, no words and no control's symbol under the notch (the left and right safe areas); a row's
 *      ground may run under it;
 *   5. nothing held to the screen (a bar, the rail, a sheet's foot: in nothing that scrolls up and down) runs past
 *      its top or foot, or stands under the status bar or the home bar;
 *   6. no control under another or under a bar, and no words under a bar: two held to the screen never overlap,
 *      and every control a person can see (and every word, under what is held to the screen) takes a tap at its
 *      middle, or its scroller can still bring it out from under what lies there;
 *   7. controls are met in the order they are seen: no row or column of them laid out reversed, none reordered.
 *
 * Itinerary, Places, Split and Packing are judged again scrolled to their very end, where a last row has nowhere
 * further to go. NARROW_SHOTS=<folder> keeps a still of each screen that goes red (through the stills queue only).
 *
 * The map's own surface (its pins and labels pan; map_fit_check and map_discs_check hold them) and Photos'
 * board (board_wall_check) are not judged here.
 *
 *   node scripts/gate.mjs --only narrow_check
 *
 * PLANTED: NARROW_PLANT=wide serves styles.css with Split's Settle up button given a fixed width of 400 px
 * (red on Split at 320 and 360); NARROW_PLANT=notch serves it without the rule that widens the rail by the
 * left safe area (red on every screen on its side: the rail's symbols and names under the notch);
 * NARROW_PLANT=sheetcut serves it with a sheet's fields 600 px wide, nothing of their own clipped (red on the add
 * sheets built of fields, a plan's, a place's, Photos' and Packing's: the sheet's body, which scrolls up and down,
 * then scrolls sideways too, and their names and boxes are cut at its side); NARROW_PLANT=short serves it with the
 * rail's foot as it was (no rule drawing its places closer on a short screen, no home bar in its padding): red on
 * every screen on its side, More past the screen's foot, under the home bar. NARROW_PLANT=chatbox serves css/chat.css
 * without the rule that starts the chat's box beside the rail: from 768 the box lies over the rail's foot (6 red on
 * Chat at 768 and on its side: More and the box overlap, and a tap at More's middle reaches the box). NARROW_PLANT=mapcol serves
 * js/map.js with its three buttons in a column on a short screen too (6 red on Places' map on its side: the compass
 * under the page's head). NARROW_PLANT=maprev lays that row out reversed, the compass at the right (7 red on Places' map
 * on its side: the keyboard meets the buttons right to left). NARROW_PLANT=foot gives a list no room at its foot (6 red
 * on a list scrolled to its end: its last row's amount or button under the +). NARROW_PLANT=pill serves styles.css with
 * the rail from 768 only, as before 19 Nov (the pill at 667 x 375 on its side); NARROW_PLANT=railjs serves js/tabs.js
 * with RAIL from 768 only (at 667 x 375 the rail drawn but read after the page); NARROW_PLANT=noarm serves styles.css
 * without the rail's 480 width (at 390 x 377, a phone upright with its keys up, the rail); NARROW_PLANT=moresheet serves
 * styles.css without your picture stepping out while a sheet is open (at 320, Split's Add a purchase and Settle up:
 * the picture under the sheet's own buttons). NARROW_PLANT=chipshrink serves styles.css with a chip let to shrink under
 * what it holds, as WebKit did (Chrome keeps a flex item's min-content by itself; min-width: 0 takes that away): red on
 * the add sheets with a row of kinds, a plan's and a place's, the kind's symbol and name past the chip's edge.
 *
 * Before the screens, at each phone: the bar's shape. The rail at the left, read first, from 768 and on any screen
 * on its side no taller than 420 and from 480 wide (tabs.js RAIL: 19 Nov, at 667 x 375 a 72 px pill left a place's
 * card and the map above it less room than they need); the pill at the foot on a phone held upright, and on one
 * whose keys shrink its page in a browser tab (390 x 377, first of all).
 */
import { BASE, boot, evalIn, waitFor, sleep, appSettled } from "./lib/standalone_cdp.mjs";
import { tripPath, TRIP } from "./lib/gate_trip.mjs";
import { PHONES, setPhone, judge, insetsHonest } from "./lib/narrow.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLANT = process.env.NARROW_PLANT || "";
if (PLANT && !["wide", "notch", "sheetcut", "short", "foot", "chatbox", "mapcol", "maprev", "pill", "railjs", "noarm", "moresheet", "chipshrink"].includes(PLANT)) throw new Error(`no such plant: ${PLANT}`);
// The file a plant serves in place of the real one: styles.css, or for the chat's box, css/chat.css.
const PLANTED_FILE = PLANT === "chatbox" ? "css/chat.css" : PLANT === "mapcol" || PLANT === "maprev" ? "js/map.js" : PLANT === "railjs" ? "js/tabs.js" : "styles.css";
const PLANTED = PLANT ? (() => {
  const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public", PLANTED_FILE), "utf8");
  if (PLANT === "pill") {
    const t = css.replace(/, \(orientation: landscape\) and \(max-height: 420px\) and \(min-width: 480px\)( and \(max-width: 1023\.98px\))?/g, "")
      .replace(/\(max-width: 767\.98px\) and \(orientation: portrait\), \(max-width: 767\.98px\) and \(min-height: 420\.02px\), \(max-width: 479\.98px\)/g, "(max-width: 767.98px)");
    if (t === css || /@media[^{]*orientation: landscape/.test(t)) throw new Error("the pill plant didn't take");
    return t; }
  if (PLANT === "noarm") {
    const t = css.replaceAll(" and (min-width: 480px)", "").replaceAll(", (max-width: 479.98px)", "");
    if (t === css || t.includes("479.98")) throw new Error("the noarm plant didn't take");
    return t; }
  if (PLANT === "railjs") {
    const t = css.replace('export const RAIL = "(min-width: 768px), (orientation: landscape) and (max-height: 420px) and (min-width: 480px)";', 'export const RAIL = "(min-width: 768px)";');
    if (t === css) throw new Error("the railjs plant changed nothing");
    return t; }
  if (PLANT === "maprev") {
    const t = css.replace("@media (max-height: 500px){ .mp-btns{flex-direction:row} }", "@media (max-height: 500px){ .mp-btns{flex-direction:row-reverse} }");
    if (t === css) throw new Error("the maprev plant changed nothing");
    return t; }
  if (PLANT === "mapcol") {
    const t = css.replace("@media (max-height: 500px){ .mp-btns{flex-direction:row} }", "");
    if (t === css) throw new Error("the mapcol plant changed nothing");
    return t; }
  if (PLANT === "chatbox") {
    const t = css.replace(/\/\* From 768 the rail stands at the left, and the box starts beside it[\s\S]*?\n\}\n/, "");
    if (t === css) throw new Error("the chatbox plant changed nothing");
    return t; }
  if (PLANT === "wide") return css + "\n#view .sp-settle{width:400px;flex:none;max-width:none}\n";
  if (PLANT === "moresheet") {
    const t = css.replace(/body:has\(\.sh-root\[data-open="1"\]\) \.head-more \{[^}]*\}\n/, "");
    if (t === css) throw new Error("the moresheet plant didn't take");
    return t;
  }
  if (PLANT === "chipshrink") {
    const t = css.replace(".chip { flex-shrink: 0; max-width: 100%; min-width: 0; }\n.chip > svg, .chip > .ico, .chip > img { flex: 0 0 auto; }\n.chip > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n",
      ".chip { flex-shrink: 1; min-width: 0; }\n");
    if (t === css) throw new Error("the chipshrink plant didn't take");
    return t; }
  if (PLANT === "sheetcut") return css + "\n.sh-body .field{min-width:600px}\n";
  if (PLANT === "foot") return css + "\n#view{padding-bottom:0 !important}\n";
  if (PLANT === "short") {
    const a = css.replace(/\/\* A phone on its side is short[\s\S]*?\n\}\n/, "");
    const t = a.replace(" padding-bottom: calc(var(--sp-4) + var(--sa-bottom)); }", " }");
    if (a === css || t === a) throw new Error("the short plant didn't take both out");
    return t; }
  const t = css.replace(/\/\* A phone on its side: the rail stands[\s\S]*?\n\}\n/, "");
  if (t === css) throw new Error("the notch plant changed nothing");
  return t; })() : null;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 1500) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

const b = await boot({ vw: 320, vh: 568, dsf: 2, reduceMotion: true });
const { cdp, S } = b;
const page = (expr) => evalIn(cdp, S, expr);
if (PLANTED) {
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: `${PLANTED_FILE.endsWith(".js") ? "text/javascript" : "text/css"}; charset=utf-8` }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(PLANTED).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*/${PLANTED_FILE}*` }] }, S);
}
const go = async (url, ready) => {
  await cdp.send("Page.navigate", { url: "about:blank" }, S);
  await sleep(100);
  await cdp.send("Page.navigate", { url }, S);
  await appSettled(cdp, S).catch(() => {});
  await waitFor(cdp, S, `${ready} ? 1 : 0`, { label: url, timeout: 30000 });
  await sleep(900);
  // The page asked for, not one it was sent on to (a sign-in, another section).
  const asked = new URL(url), at = JSON.parse(await page(`JSON.stringify([location.pathname, location.hash])`));
  if (at[0] !== asked.pathname || at[1] !== asked.hash) throw new Error(`asked for ${asked.pathname}${asked.hash}, at ${at[0]}${at[1]}`);
};
const inTrip = (hash) => `${BASE}${tripPath(hash)}`;
const openSheet = async (tap) => {
  await page(`(() => { const n = ${tap}; if (!n) return 0; n.click(); return 1; })()`);
  await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1'] .sh-sheet") ? 1 : 0`, { label: "the sheet", timeout: 10000 });
  await sleep(800);
};
const closeSheet = async () => {
  await page(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
  await sleep(700);
};
const toFoot = async () => {
  await page(`(() => { const v = document.getElementById("view"); v.scrollTop = v.scrollHeight; return 1; })()`);
  await sleep(700);
};
const ADD = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((n) => getComputedStyle(n).display !== "none") || document.querySelector("#rt-fixed .fab")`;

// The bar's shape: the rail at the left, read first, from 768 and on a screen on its side no taller than 420 and from
// 480 wide (tabs.js RAIL); the pill at the foot on a phone held upright.
const BAR_SHAPE = `JSON.stringify((() => { const n = document.querySelector(".tabbar"); const r = n.getBoundingClientRect();
  return { first: document.body.dataset.bar === "first", l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), fixed: getComputedStyle(n).position === "fixed" }; })())`;
const isRail = (bar, w, h) => bar.first && !bar.fixed && bar.l === 0 && bar.t === 0 && bar.h >= h - 1 && bar.w < w / 3;
const isPill = (bar, h) => !bar.first && bar.fixed && bar.t > h / 2 && bar.t + bar.h <= h;

try {
  // A phone held upright with its keys up, in a browser tab whose page they shrink (Safari's: 390 x 377): wider than
  // tall it isn't, but "landscape" in a query is only that, so without the width the rail would come and go with the
  // keys. It keeps the pill.
  section("390 upright, its keys up (the page 390 x 377)");
  await setPhone(cdp, S, { w: 390, h: 377, insets: { top: 0, right: 0, bottom: 0, left: 0 } });
  await go(inTrip("#/"), `document.querySelector("#view .ag-day")`);
  const typing = JSON.parse(await page(BAR_SHAPE));
  check("390 x 377 (a phone upright, its keys up): the bar is the pill, read last, not the rail", isPill(typing, 377), JSON.stringify(typing));
  for (const ph of PHONES) {
    section(ph.name);
    await setPhone(cdp, S, ph);
    // NARROW_SHOTS=<folder>: a still of each screen that goes red. Only through the stills queue, never beside it.
    const shot = process.env.NARROW_SHOTS ? async (label) => { fs.mkdirSync(process.env.NARROW_SHOTS, { recursive: true });
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, S);
      fs.writeFileSync(path.join(process.env.NARROW_SHOTS, label.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".png"), Buffer.from(data, "base64")); } : null;
    const look = (screen) => judge(page, check, ph, screen, shot);

    await go(inTrip("#/"), `document.querySelector("#view .ag-day")`);
    // Honest only if the page reads the insets given.
    if (!(await insetsHonest(page, check, ph))) throw new Error("the safe-area emulation isn't honest");
    const bar = JSON.parse(await page(BAR_SHAPE));
    const rail = ph.w >= 768 || (ph.w > ph.h && ph.h <= 420 && ph.w >= 480);
    check(`${ph.name}: the bar is ${rail ? "the rail at the left, read first" : "the pill at the screen's foot, read last"}`,
      rail ? isRail(bar, ph.w, ph.h) : isPill(bar, ph.h), JSON.stringify(bar));

    await look("Itinerary");
    await toFoot();
    await look("Itinerary, scrolled to its end");
    await openSheet(`document.querySelector("#view [data-plan-add]") || document.querySelector("#rt-fixed .fab")`);
    await look("Itinerary: Add a plan");
    await closeSheet();
    await go(inTrip("#/e/e-02"), `document.querySelector("#view h1, #view h2")`);
    await look("A plan");

    await go(inTrip("#/places"), `document.querySelectorAll("#view .pl-row").length > 3`);
    await look("Places");
    await toFoot();
    await look("Places, scrolled to its end");
    const placeHref = await page(`(document.querySelector("#view a.pl-row") || { getAttribute: () => "" }).getAttribute("href") || ""`);
    await openSheet(ADD("#view .pl-headadd"));
    await look("Places: Add a place");
    await closeSheet();
    await go(inTrip("#/places?view=map"), `document.querySelector("#view .mp-root .mp-scale")`);
    await look("Places: the map");
    if (placeHref) {
      await go(inTrip(placeHref), `document.querySelector("#view .pl-title h1")`);
      await look("A place");
    }

    await go(inTrip("#/split"), `document.querySelectorAll("#view .sp-row").length > 3`);
    await look("Split");
    await toFoot();
    await look("Split, scrolled to its end");
    await openSheet(ADD("#view [data-act='add']"));
    await look("Split: Add a purchase");
    await closeSheet();
    await openSheet(`document.querySelector("#view .sp-settle")`);
    await look("Split: Settle up");
    await closeSheet();
    const buy = await page(`(([...document.querySelectorAll("#view .sp-row")].find((r) => r.dataset.kind !== "payment") || {}).dataset || {}).id || ""`);
    if (buy) {
      await go(inTrip(`#/split/${buy}`), `document.querySelector(".sh-root[data-open='1'] .sh-sheet")`);
      await look("A purchase");
      await closeSheet();
    }

    await go(inTrip("#/memories"), `document.querySelector("#view .me-top")`);
    await look("Photos");
    // Add photos opens the phone's picker first: stood in here by one made-up photo, so its one sheet opens.
    await page(`(async () => { const c = document.createElement("canvas"); c.width = c.height = 64; c.getContext("2d").fillRect(0, 0, 64, 64);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg")); const file = new File([blob], "made-up.jpg", { type: "image/jpeg" });
      const real = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () { if (this.type !== "file") return real.call(this); HTMLInputElement.prototype.click = real;
        const dt = new DataTransfer(); dt.items.add(file); this.files = dt.files; setTimeout(() => this.dispatchEvent(new Event("change", { bubbles: true })), 30); };
      return 1; })()`);
    await openSheet(ADD("#view .me-headadd"));
    await look("Photos: Add photos");
    await closeSheet();

    await go(inTrip("#/chat"), `document.querySelector("#view .ch-input, #view [class^='ch-']")`);
    await look("Chat");
    await go(inTrip("#/settings"), `document.querySelector("#view .st-title")`);
    await look("More");
    await go(inTrip("#/pack"), `document.querySelector("#view .pk-own")`);
    await look("Packing");
    await toFoot();
    await look("Packing, scrolled to its end");
    await openSheet(ADD("#view [data-act='add-item']"));
    await look("Packing: Add an item");
    await closeSheet();
    await go(inTrip("#/changes"), `document.querySelector("#view h1, #view .chg-line, #view .empty")`);
    await look("Changes");
    await go(inTrip("#/settings/credits"), `document.querySelector("#view h1, #view h2")`);
    await look("Image credits");

    await go(`${BASE}/trips/${encodeURIComponent(TRIP)}`, `document.querySelector("main, #page, body > *")`);
    await look("People and settings");
    await go(`${BASE}/trips`, `document.querySelector("#make-title")`);
    await look("Your trips");
    await go(`${BASE}/account`, `document.getElementById("yours")`);
    await look("Your account");
  }
  check("no exception reached the page", b.pageErrors.length === 0, b.pageErrors.join(" | ") || "clean");
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  await b.done();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

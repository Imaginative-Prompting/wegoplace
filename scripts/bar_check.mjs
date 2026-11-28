#!/usr/bin/env node
/* THE BAR, as the layouts made it (16 Nov: the tabs along the foot of the screen, out of sight while a
 * list is scrolled toward its end and back as soon as it's scrolled toward its start, Packing under
 * More), on the gate's made-up trip
 * as its host, in a real browser:
 *
 *   1. THE FIVE, FOR EVERYONE: Itinerary, Places, Split, Photos, Chat, in that order. An account
 *      carrying a layout stored with the old tab bar editor (Packing on the bar, Split off it) gets the
 *      five. More is your picture at the top right (.head-more, named "More", to #/settings); More lists
 *      Packing and Changes and has no editor. Photos' own page says Photos.
 *   1e. SCROLLED, NOTHING UNDER YOU: on each main screen a list scrolled down by a finger's wheel, at 390 and 440: no
 *      words of the page (outside the head that holds your picture) meet your picture's box (27 Nov: Split's was fixed
 *      at the top right and sat on a scrolled row's amount). BAR_PLANT=spfixed.
 *   2. UNDER 768, A PILL: floating at the foot, narrower than the screen, round, the page running
 *      under it to the screen's foot. Every name shows, each on one line in its fifth, at 12 px, from 320.
 *   2b. NOTHING READS THROUGH IT: the pill shot without and with a line of the page's ink under it; no
 *      pixel behind a name changes by more than 1.25:1, and each name keeps 4.5:1 against what it
 *      stands on, light and dark.
 *   2c. THE TAB YOU'RE ON: one highlight under it (public/ds/shell.css .ds-tab-hl), over that tab's fifth, its name
 *      wholly inside; it slides there (320 ms on the spring), and with reduced motion it is simply there. On More's
 *      own screen no tab is lit, the highlight is gone and your picture is current. At 320, 360, 390 and 400.
 *   3. IT DUCKS: down a long page the bar leaves the screen (and the + rides down with it); a
 *      finger's width back up and it is there. With "reduce motion" it still goes and comes, without
 *      a slide (no transition time).
 *   4. THE +'s ROOM: on the Itinerary, Places, Split and Packing, scrolled to the end with the bar
 *      there, the last words on the page end above the +.
 *   4b. AT THE END, NO EMPTY BAND (20 Nov: on a phone the Itinerary scrolled far past its last row, into empty
 *      space): on the same four, scrolled down to the very end as a finger does (no way back up), the bar is
 *      there on its own, and below the last thing drawn (words, or a card's box) only the page's clearance, 48 px at
 *      most, before the first thing floating over the foot (the +, the bar, the offline pill).
 *   5. THE SAVING LINE at the screen's very foot, under the pill; the offline pill above the bar.
 *   6. THE MAP'S FOOT: its scale and "Nearby" stand above the pill with the panel shut.
 *   7. FROM 768 A RAIL at the left (84 wide, you, More, at its foot), FROM 1024 A SIDEBAR (232, names
 *      beside the symbols); the page starts after it.
 *   8. A SHEET, from 768, is a dialog in the middle of the page with a ×, its four corners round,
 *      and the × closes it; under 768 it rises from the foot.
 *   8b. TURNED (a phone on its side has the rail, tabs.js RAIL): a sheet with no × of its own opened upright and the
 *      phone turned: as a dialog it has its ×, which closes it; turned back, its grab and no ×. Sent away down a
 *      page on its side, then turned upright: the pill is at the foot, not away.
 *   8c. A SHEET GOES BY ITS OWN SLIDE: a button inside it given a 40 ms transform transition and pressed as the sheet
 *      opens and as it closes: its end neither counts as the sheet arriving nor takes it down mid-slide; the sheet's
 *      own end does both.
 *   9. THE DAY STRIP ON A DESKTOP (1440, 1024): an arrow at each end with more days past it; a mouse
 *      wheel turned over it moves the days and not the page; a trackpad's sideways swipe still
 *      does; the arrow moves it on; at its end the last day shows whole. At 390, no arrows.
 *
 *   node scripts/gate.mjs --only bar_check
 *
 * PLANTED (red when put in by hand): tabs.js layout() reading the stored layout again (1); styles.css
 * --bar-glass at the 72% it was (2b); shell.css's highlight without its transition (2c); styles.css without body[data-fab]'s --fab-room (4); map.js
 * barOver() returning 0 (6); sheet.js asDialog() false (8); agenda.js without the strip's wheel (9). BAR_PLANT=sheetturn
 * and BAR_PLANT=duckturn (8b), BAR_PLANT=sheetend (8c), BAR_PLANT=endaway (4b), see below.
 */
import { BASE, boot, evalIn, waitFor, sleep, appSettled } from "./lib/standalone_cdp.mjs";
import { tripPath, d1, HOST, TRIP, TRIP_NAME } from "./lib/gate_trip.mjs";
import fs from "node:fs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const FIVE = ["agenda", "places", "split", "memories", "chat"];
const NAMES = ["Itinerary", "Places", "Split", "Photos", "Chat"];

// What the bar is, where it stands, and what the page around it does.
const BAR = `JSON.stringify((() => {
  const bar = document.querySelector(".tabbar"), r = bar.getBoundingClientRect(), cs = getComputedStyle(bar);
  const tabs = [...bar.querySelectorAll(".tab")];
  const v = document.getElementById("view").getBoundingClientRect();
  return { ids: tabs.map((a) => a.dataset.tab), names: tabs.map((a) => a.textContent.trim()),
    shown: tabs.map((a) => { const s = a.querySelector("span:not(.ds-tab-dot)"); return s ? Math.round(s.getBoundingClientRect().width) : 0; }),
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], radius: parseFloat(cs.borderTopLeftRadius),
    position: cs.position, state: document.body.dataset.tabs || "here", vw: innerWidth, vh: innerHeight,
    view: [Math.round(v.left), Math.round(v.top), Math.round(v.right), Math.round(v.bottom)],
    trans: cs.transitionDuration };
})())`;
const J = async (cdp, S, expr) => JSON.parse(await evalIn(cdp, S, expr));
// The lowest bottom of any words on the page (an element with text of its own), and the +.
const FOOT = `JSON.stringify((() => {
  let low = 0, what = "";
  for (const n of document.querySelectorAll("#view *")) {
    if (![...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
    const b = n.getBoundingClientRect();
    if (!b.width || !b.height || getComputedStyle(n).visibility === "hidden") continue;
    if (b.bottom > low) { low = b.bottom; what = n.textContent.trim().slice(0, 40); }
  }
  const f = document.querySelector("#rt-fixed .fab"), fr = f ? f.getBoundingClientRect() : null;
  return { low: Math.round(low), what, fabTop: fr ? Math.round(fr.top) : null, fab: document.body.dataset.fab, state: document.body.dataset.tabs || "here", vh: innerHeight };
})())`;

const original = d1(`SELECT tab_layout FROM users WHERE id = '${HOST.id}'`)[0]?.tab_layout ?? null;
const putBack = () => d1(`UPDATE users SET tab_layout = ${original === null ? "NULL" : `'${String(original).replace(/'/g, "''")}'`} WHERE id = '${HOST.id}'`);

// BAR_PLANT=sheetturn serves js/sheet.js drawing the × only if asked or a dialog at open (8b: no × on its side);
// BAR_PLANT=duckturn serves js/tabs.js without the layout's change bringing the bar back (8b: the pill away upright);
// BAR_PLANT=sheetend serves js/sheet.js taking any bubbling transform end for its own (8c: 2 red, at the button's end on open and on close);
// BAR_PLANT=railkeep serves js/tabs.js with paintBar dropping the rail's own parts (7: the bar redrawn by paintBar
// loses its logo, trip, rows and you);
// BAR_PLANT=spfixed serves js/split.js with its head's end Split's own again (.sp-head-end alone), your picture fixed at
// the top right as before 27 Nov (1b: off Split's head row; 1e: a scrolled row's amount under it, at 390 and 440);
// BAR_PLANT=moredeep serves js/tabs.js with your picture kept one level deeper (1c: on a plan's and a place's page);
// BAR_PLANT=tabshort serves ds/shell.css without a tab's 44 px (2: the pill's tabs under a tap's size);
// BAR_PLANT=coarse36 serves styles.css without the wide rail's 44 px for a coarse pointer (7: a finger's rows at 36);
// BAR_PLANT=headroom serves styles.css without Photos' head wrapping on a phone (1d: its view control under your picture
// at 320 and 390, 2 red);
// BAR_PLANT=endaway serves js/tabs.js without the bar coming back at the end of a list (4b: the bar away at the end on
// each of the four, the room it keeps a band of nothing under the last row).
const PLANT = process.env.BAR_PLANT || "";
if (PLANT && !["sheetturn", "duckturn", "sheetend", "railkeep", "spfixed", "moredeep", "tabshort", "coarse36", "headroom", "endaway"].includes(PLANT)) throw new Error(`no such plant: ${PLANT}`);
const PLANTED_FILE = PLANT === "sheetturn" || PLANT === "sheetend" ? "js/sheet.js" : PLANT === "coarse36" || PLANT === "headroom" ? "styles.css" : PLANT === "tabshort" ? "ds/shell.css" : PLANT === "spfixed" ? "js/split.js" : "js/tabs.js";
const PLANTED = PLANT ? (() => {
  const src = fs.readFileSync(new URL(`../public/${PLANTED_FILE}`, import.meta.url), "utf8");
  const t = PLANT === "sheetturn"
    ? src.replace('`<button class="sh-x" type="button" aria-label="Close"${closeButton ? "" : " data-dialog-only"}>`', '(closeButton || asDialog() ? `<button class="sh-x" type="button" aria-label="Close">` : `<button class="sh-x" type="button" aria-label="Close" hidden style="display:none">`)')
    : PLANT === "sheetend" ? src.replaceAll('if (e.target === sheet && e.propertyName === "transform")', 'if (e.propertyName === "transform")')
    : PLANT === "railkeep" ? src.replace("  nav.prepend(...before);\n  nav.append(...after);\n", "")
    : PLANT === "coarse36" ? src.replace(/@media \(min-width: 1024px\) and \(pointer: coarse\) \{[^}]*\}\n\}/, "")
    : PLANT === "tabshort" ? src.replace("  min-height: var(--control-44);   /* a tap target, whatever the name shows */\n", "")
    : PLANT === "moredeep" ? src.replace('more.toggleAttribute("data-away", !MORE_ON.has(route.name));', 'more.toggleAttribute("data-away", false);')
    : PLANT === "headroom" ? src.replace("  #view .me-top { flex-wrap: wrap; row-gap: var(--sp-2); }\n", "")
    : PLANT === "endaway" ? src.replace("    if (max > 0 && y >= max - 2) { here(); return; }\n", "")
    : PLANT === "spfixed" ? src.replace('`<div class="sp-head-end ds-head-end">`', '`<div class="sp-head-end">`')
    : src.replace('  matchMedia(RAIL).addEventListener("change", here);\n', "");
  if (t === src) throw new Error(`the ${PLANT} plant didn't take`);
  return t; })() : null;

const b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: false });
const { cdp, S } = b;
if (PLANTED) {
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: PLANTED_FILE.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(PLANTED).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*/${PLANTED_FILE}*` }] }, S);
}
const go = async (hash, mark) => {
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath(hash)}` }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `${mark} ? 1 : 0`, { label: hash, timeout: 30000 });
  await sleep(700);
};
const size = async (w, h, dsf = 2) => {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dsf, mobile: w < 1000 }, S);
  await sleep(300);
};
try {
  await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });

  section("1. The five, for everyone");
  // An account that had used the old editor: Packing on the bar, Split taken off.
  d1(`UPDATE users SET tab_layout = '["agenda","places","pack","memories","other"]' WHERE id = '${HOST.id}'`);
  await go("#/", `document.querySelector(".tabbar .tab") && document.querySelector("#view .ag-day, #view .empty")`);
  const one = await J(cdp, S, BAR);
  check("an account with a layout stored by the old editor (Packing on, Split off) gets the five: " + NAMES.join(", "),
    one.ids.join() === FIVE.join() && one.names.join() === NAMES.join(), `${one.ids.join()} · ${one.names.join()}`);
  const you = await J(cdp, S, `JSON.stringify((() => { const m = document.querySelector(".head-more"); if (!m) return null; const r = m.getBoundingClientRect();
    return { label: m.getAttribute("aria-label"), href: m.getAttribute("href"), initials: m.textContent.trim(), box: [Math.round(r.left), Math.round(r.top), Math.round(r.width)], vw: innerWidth }; })())`);
  check("More is your picture at the top right: named More, your initials, to More's page, 44 px to press",
    !!you && /^More\b/.test(you.label) && you.href === "#/settings" && /^[A-Z]{1,2}$/.test(you.initials) && you.box[2] >= 44 && you.box[0] > you.vw - 80 && you.box[1] < 120, JSON.stringify(you));
  await go("#/settings", `document.querySelector("#view #st-sections")`);
  const more = await J(cdp, S, `JSON.stringify({ title: document.querySelector(".st-title").textContent.trim(),
    links: [...document.querySelectorAll("#view #st-sections a, #view #st-sections button.st-row")].map((a) => a.getAttribute("href") ?? a.id),
    editor: !!document.querySelector("#st-tabedit, #st-tbar, .st-grip"), heads: [...document.querySelectorAll("#view .st-label")].map((h) => h.textContent.trim()) })`);
  check("More is titled More, lists Packing, Changes, People and settings, AI apps (a button: the Connect your AI sheet) and Your trips, and has no tab bar editor",
    more.title === "More" && /^#\/pack,#\/changes,\/trips\/[^,]+,st-apps,\/trips$/.test(more.links.join()) && !more.editor && more.heads.join() === "This trip,You,Appearance,This app", JSON.stringify(more));
  await go("#/memories", `document.querySelector("#view .me-title")`);
  const photos = await evalIn(cdp, S, `document.querySelector("#view .me-title").textContent.trim()`);
  check("Photos' own page says Photos", photos === "Photos", photos);

  section("1b. Your picture on each screen's own head row");
  // A screen that has moved has its head (.ds-head) with your picture in it; one that hasn't has its own head row,
  // and the picture is put on it by that screen's offset (styles.css). Its centre line within 2 px of the row's.
  for (const [hash, row] of [["#/", ".ag-tripname-t, h1.ag-tripname"], ["#/places", ".pl-top"], ["#/split", ".sp-head"], ["#/memories", ".me-title"], ["#/chat", ".ch-head"], ["#/settings", ".st-title"]]) {
    await go(hash, `document.querySelector("#view .ds-head, #view ${row.split(", ").join(", #view ")}")`);
    const at = await J(cdp, S, `JSON.stringify((() => { const m = document.querySelector(".head-more").getBoundingClientRect();
      const r = (document.querySelector("#view .ds-head") || document.querySelector("#view ${row.split(", ").join(", #view ")}")).getBoundingClientRect();
      return { picture: +(m.top + m.height / 2).toFixed(1), row: +(r.top + r.height / 2).toFixed(1) }; })())`);
    check(`${hash}: your picture's centre line is on its head row's (within 2 px)`, Math.abs(at.picture - at.row) <= 2, JSON.stringify(at));
  }

  section("1d. Nothing in a main screen's head runs under your picture, at 320 and 390");
  // Every element of the head's row that draws something (words, a control, a picture), not the row itself, whose box
  // meets your picture's (more than half a pixel). The five tabs and More, at the narrowest phone and a common one.
  const HEADS = [["#/", ".ag-tripname"], ["#/places", ".pl-top"], ["#/split", ".sp-head"], ["#/memories", ".me-top"], ["#/chat", ".ch-head"], ["#/settings", ".st-title"]];
  for (const [w, h] of [[320, 640], [390, 844]]) {
    await size(w, h);
    for (const [hash, row] of HEADS) {
      await go(hash, `document.querySelector("#view .ds-head, #view ${row}")`);
      const hit = await J(cdp, S, `JSON.stringify((() => {
        const m = document.querySelector(".head-more"); if (!m || getComputedStyle(m).display === "none") return { picture: null, under: [] };
        const p = m.getBoundingClientRect(), head = document.querySelector("#view .ds-head") || document.querySelector("#view ${row}");
        const draws = (el) => el.matches("button, a, input, select, svg, img, canvas, [role=img]") || [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const under = [...head.querySelectorAll("*")].filter((el) => !el.closest(".head-more") && draws(el) && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
          .filter((el) => { const r = el.getBoundingClientRect(); return Math.min(r.right, p.right) - Math.max(r.left, p.left) > 0.5 && Math.min(r.bottom, p.bottom) - Math.max(r.top, p.top) > 0.5; })
          .map((el) => (el.className && typeof el.className === "string" ? el.tagName.toLowerCase() + "." + el.className.split(" ")[0] : el.tagName.toLowerCase()) + " " + (el.textContent || "").trim().slice(0, 20));
        return { picture: [Math.round(p.left), Math.round(p.top), Math.round(p.width)], under };
      })())`);
      check(`${w}, ${hash}: nothing in the head runs under your picture`, !!hit.picture && hit.under.length === 0, JSON.stringify(hit));
    }
  }
  await size(390, 844);

  section("1e. Scrolled down a main screen, nothing of the page under your picture, at 390 and 440");
  // 27 Nov: on Split your picture was fixed at the top right while its head scrolled away, and sat on a scrolled row's
  // amount. On each main screen, a list scrolled down by a finger's wheel (or, where the wheel lands on something that
  // takes it, Photos' board, by the page's own scroll): no words of the page (outside the head that holds the picture,
  // which 1d reads) that are what's drawn there meet the picture's box. Words slid under a head's solid band, covered
  // by it, are not under the picture.
  for (const [w, h] of [[390, 844], [440, 956]]) {
    await size(w, h);
    // Chat's messages scroll in a pane of their own, under its head; More is a short page.
    for (const [hash, row] of HEADS.filter(([x]) => x !== "#/settings" && x !== "#/chat")) {
      await go(hash, `document.querySelector("#view .ds-head, #view ${row}")`);
      for (let i = 0; i < 6; i++) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: w / 2, y: h / 2, deltaX: 0, deltaY: 300 }, S); await sleep(120); }
      await evalIn(cdp, S, `(() => { const v = document.getElementById("view"); if (v && !v.scrollTop && !document.scrollingElement.scrollTop) v.scrollTop = 1800; return 1; })()`);
      await sleep(800);
      const hit = await J(cdp, S, `JSON.stringify((() => {
        const m = document.querySelector(".head-more"); if (!m || getComputedStyle(m).display === "none" || !m.getClientRects().length) return { picture: null, under: [], moved: 0 };
        const p = m.getBoundingClientRect(), own = m.closest(".ds-head");
        const under = [];
        const walk = document.createTreeWalker(document.getElementById("view"), NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const el = n.parentElement;
          if (!n.textContent.trim() || !el || m.contains(el) || (own && own.contains(el)) || getComputedStyle(el).visibility === "hidden") continue;
          const r = document.createRange(); r.selectNodeContents(n);
          for (const b of r.getClientRects()) {
            const x0 = Math.max(b.left, p.left), x1 = Math.min(b.right, p.right), y0 = Math.max(b.top, p.top), y1 = Math.min(b.bottom, p.bottom);
            if (x1 - x0 <= 0.5 || y1 - y0 <= 0.5) continue;
            // Drawn there, or covered: what is on top at the middle of where they meet, the picture set aside.
            m.style.visibility = "hidden";
            const top = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
            m.style.visibility = "";
            if (top && (top === el || el.contains(top) || top.contains(el))) { under.push(n.textContent.trim().slice(0, 24)); break; }
          }
        }
        const v = document.getElementById("view"), moved = Math.round(Math.max(v ? v.scrollTop : 0, document.scrollingElement.scrollTop));
        // A page no taller than the screen has nothing to scroll under the picture (Photos' board on the made-up trip).
        const room = Math.round(Math.max(v ? v.scrollHeight - v.clientHeight : 0, document.scrollingElement.scrollHeight - innerHeight));
        return { picture: [Math.round(p.left), Math.round(p.top), Math.round(p.width)], under: [...new Set(under)].slice(0, 4), moved, room };
      })())`);
      check(`${w}, ${hash} scrolled ${hit.moved} px: no words of the page under your picture`, (hit.moved > 0 || hit.room <= 8) && hit.under.length === 0, JSON.stringify(hit));
    }
  }
  await size(390, 844);

  section("1c. One level deeper, the page's top right is its own");
  // A plan's page and a place's page, each opened cold (a fresh page with nothing behind it, so no Back dock, whose
  // own rule would hide the picture anyway): your picture is not in the head, and the page's top right is its own.
  for (const [list, link, what] of [["#/", '#view a[href^="#/e/"]', "a plan's page"], ["#/places", '#view a[href^="#/p/"]', "a place's page"]]) {
    await go(list, `document.querySelector('${link}')`);
    const href = await evalIn(cdp, S, `document.querySelector('${link}').getAttribute("href")`);
    await cdp.send("Page.navigate", { url: "about:blank" }, S);
    await sleep(200);
    await go(href, `document.querySelector("#view h1, #view h2")`);
    const deep = await J(cdp, S, `JSON.stringify((() => { const m = document.querySelector(".head-more"), shown = !!m && getComputedStyle(m).display !== "none";
      const r = m ? m.getBoundingClientRect() : null, hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return { shown, onTop: !!hit && !!hit.closest(".head-more"), hash: location.hash, back: document.body.dataset.back }; })())`);
    check(`${what} (${deep.hash}), opened cold (no Back): your picture is not in its head, and nothing of it covers the page's top right`, deep.back === "0" && !deep.shown && !deep.onTop, JSON.stringify(deep));
  }

  section("2. Under 768, a pill");
  await go("#/", `document.querySelector("#view .ag-day")`);
  const p = await J(cdp, S, BAR);
  check("390: fixed at the foot, narrower than the screen, standing off its foot, round",
    p.position === "fixed" && p.box[0] >= 8 && p.box[2] <= p.vw - 16 && p.box[1] + p.box[3] < p.vh - 8 && p.radius >= p.box[3] / 2 - 1, JSON.stringify(p));
  check("390: the page runs under it to the screen's foot", p.view[3] === p.vh, JSON.stringify(p.view));
  check("390: every name shows", p.shown.every((w) => w > 10), p.shown.join());
  const tall = await J(cdp, S, `JSON.stringify([...document.querySelectorAll(".tabbar .tab")].map((a) => Math.round(a.getBoundingClientRect().height)))`);
  check("390: every tab is a tap's size, 44 px tall or more", tall.every((h) => h >= 44), tall.join());
  // The narrowest width that shows names: each fits its tab, at the app's floor of 12px.
  await size(360, 740);
  await go("#/", `document.querySelector("#view .ag-day")`);
  const fit = await J(cdp, S, `JSON.stringify([...document.querySelectorAll(".tabbar .tab")].map((a) => { const s = a.querySelector("span:not(.ds-tab-dot)");
    return { w: Math.round(a.getBoundingClientRect().width), name: Math.round(s.scrollWidth), px: parseFloat(getComputedStyle(s).fontSize), lines: Math.round(s.getBoundingClientRect().height / parseFloat(getComputedStyle(s).lineHeight || 14)) }; }))`);
  check("360: every name fits its tab on one line, at 12px or more", fit.every((t) => t.name <= t.w - 4 && t.px >= 12 && t.lines <= 1), JSON.stringify(fit));
  await size(320, 640);
  await go("#/", `document.querySelector("#view .ag-day")`);
  const fit320 = await J(cdp, S, `JSON.stringify([...document.querySelectorAll(".tabbar .tab")].map((a) => { const s = a.querySelector("span:not(.ds-tab-dot)");
    return { w: Math.round(a.getBoundingClientRect().width), name: Math.round(s.scrollWidth), px: parseFloat(getComputedStyle(s).fontSize), lines: Math.round(s.getBoundingClientRect().height / parseFloat(getComputedStyle(s).lineHeight || 14)) }; }))`);
  check("320: every name shows and fits its fifth on one line, at 12px or more", fit320.every((t) => t.name <= t.w - 2 && t.px >= 12 && t.lines <= 1), JSON.stringify(fit320));
  await size(390, 844);

  section("2b. Nothing reads through the pill");
  // A line of the page's own ink, under the pill at the names' height (16 Nov: a list's line read
  // through it between Itinerary and Split). Not darkest-to-lightest behind a name: the tab you're
  // on has its highlight, a rounded shape, inside the name's box, and that range is the
  // highlight's own (the first run, 16 Nov 06:33, read it as the line). A headless browser draws no backdrop blur, so this is the pill with its fill alone: the case
  // of a browser without the blur, the worst one.
  for (const scheme of ["light", "dark"]) {
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, S);
    await go("#/places", `document.querySelectorAll("#view .pl-row").length > 8`);
    // Two pictures of the pill with its names and symbols hidden: without the line, then with it.
    // What the line changes, pixel by pixel behind each name, is how far it reads through; the
    // name's contrast is against what it stands on (the mean of the second picture there).
    const clip = await J(cdp, S, `JSON.stringify((() => {
      const bar = document.querySelector(".tabbar"), r = bar.getBoundingClientRect();
      const hide = document.createElement("style");
      hide.id = "bar-check-hide";
      hide.textContent = ".tabbar .tab > * { visibility: hidden !important; }";
      document.head.append(hide);
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })())`);
    await sleep(300);
    const shoot = async () => (await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } }, S)).data;
    const plain = await shoot();
    await evalIn(cdp, S, `(() => { const s = document.querySelector(".tabbar .tab span:not(.ds-tab-dot)").getBoundingClientRect();
      const line = document.createElement("div");
      line.id = "bar-check-line";
      line.textContent = "Closed · Galería Junco del Paso · Police Station · Closed · Galería Junco del Paso · Police Station";
      line.style.cssText = "position:fixed;left:0;right:0;z-index:2;white-space:nowrap;overflow:hidden;font:700 18px/1 system-ui;color:var(--ink);top:" + (s.top + s.height / 2 - 9) + "px";
      document.body.append(line); return 1; })()`);
    await sleep(300);
    const lined = await shoot();
    const read = await J(cdp, S, `(async () => {
      document.getElementById("bar-check-hide").remove();
      document.getElementById("bar-check-line").remove();
      const px = async (data) => { const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0); return { g, k: img.width / ${clip.width} }; };
      const A = await px("${plain}"), B = await px("${lined}");
      const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      const lum = (d, i) => 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
      const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const out = [];
      for (const a of document.querySelectorAll(".tabbar .tab")) {
        const s = a.querySelector("span:not(.ds-tab-dot)"), r = s.getBoundingClientRect();
        // The name's colour as a pixel (a computed color-mix() is color(srgb 0–1 …), not rgb()).
        const dot = document.createElement("canvas").getContext("2d");
        dot.fillStyle = getComputedStyle(s).color; dot.fillRect(0, 0, 1, 1);
        const ink = lum(dot.getImageData(0, 0, 1, 1).data, 0);
        const box = (P) => P.g.getImageData(Math.round((r.left - ${clip.x}) * P.k), Math.round((r.top - ${clip.y}) * P.k), Math.max(1, Math.round(r.width * P.k)), Math.max(1, Math.round(r.height * P.k))).data;
        const da = box(A), db = box(B);
        let worst = 1, sum = 0, n = 0;
        for (let i = 0; i < db.length; i += 4) { const la = lum(da, i), lb = lum(db, i); worst = Math.max(worst, ratio(la, lb)); sum += lb; n++; }
        out.push({ tab: a.dataset.tab, name: Math.round(ratio(ink, sum / n) * 100) / 100, through: Math.round(worst * 100) / 100 });
      }
      return JSON.stringify(out);
    })()`);
    check(`${scheme}: with a line of the page's ink under the pill, every name keeps 4.5:1 or more against what it stands on`, read.every((t) => t.name >= 4.5), JSON.stringify(read));
    check(`${scheme}: and the line can't be read through it (no pixel behind a name changes by more than 1.25:1)`, read.every((t) => t.through <= 1.25), JSON.stringify(read));
  }
  await cdp.send("Emulation.setEmulatedMedia", { features: [] }, S);

  section("2c. The tab you're on: one highlight that slides to it");
  // The highlight (public/ds/shell.css .ds-tab-hl) stands over the current tab's fifth, its name wholly inside it; it
  // moves by transform, 320 ms on the spring, and reduced motion leaves it no time to travel.
  const HL = `JSON.stringify((() => {
    const bar = document.querySelector(".tabbar"), hl = bar.querySelector(".ds-tab-hl"), a = bar.querySelector('.tab[aria-current="page"]');
    const more = document.querySelector(".head-more"), cs = hl ? getComputedStyle(hl) : null;
    const out = { tab: a ? a.dataset.tab : null, more: more ? more.getAttribute("aria-current") : null, opacity: cs ? Number(cs.opacity) : null,
      trans: cs ? cs.transitionDuration + " " + cs.transitionTimingFunction : null };
    if (!a || !hl) return out;
    const h = hl.getBoundingClientRect(), c = a.getBoundingClientRect(), n = a.querySelector("span:not(.ds-tab-dot)").getBoundingClientRect();
    return { ...out, over: Math.round(Math.abs(h.left + h.width / 2 - (c.left + c.width / 2)) * 10) / 10, hlW: Math.round(h.width), cellW: Math.round(c.width),
      inside: Math.round(Math.min(n.left - h.left, h.right - n.right) * 10) / 10 };
  })())`;
  for (const [w, h] of [[320, 640], [360, 740], [390, 844], [400, 860]]) {
    await size(w, h);
    const rows = [];
    for (const [id, hash, ready] of [["agenda", "#/", `document.querySelector("#view .ag-day")`], ["places", "#/places", `document.querySelector("#view .pl-row")`],
      ["split", "#/split", `document.querySelector("#view .sp-row")`], ["memories", "#/memories", `document.querySelector("#view .me-title")`],
      ["chat", "#/chat", `document.querySelector("#view .ch-input, #view [class^='ch-']")`]]) {
      await go(hash, `${ready} && document.querySelector('.tabbar .tab[data-tab="${id}"][aria-current="page"]')`);
      await sleep(450);
      rows.push(await J(cdp, S, HL));
    }
    check(`${w}: with each of the five current, the highlight stands over its fifth (centred within 1 px) and its name is wholly inside`,
      rows.every((r) => r.over <= 1 && r.inside >= 2 && r.opacity === 1), JSON.stringify(rows.map((r) => [r.tab, r.over, r.inside, r.hlW, r.cellW])));
  }
  await size(390, 844);
  await go("#/settings", `document.querySelector("#view .st-title")`);
  await sleep(300);
  const onMore = await J(cdp, S, HL);
  check("on More's own page no tab is lit, the highlight is gone, and your picture is current", onMore.tab === null && onMore.opacity === 0 && onMore.more === "page", JSON.stringify(onMore));
  await go("#/", `document.querySelector("#view .ag-day")`);
  const moving = await J(cdp, S, HL);
  check("it slides: 320 ms on the spring", /^0\.32s\b/.test(moving.trans) && /cubic-bezier\(0\.3, 1\.4, 0\.5, 1\)/.test(moving.trans), moving.trans);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
  const hlStill = await J(cdp, S, HL);
  check("with reduced motion it is simply there (no time to travel)", parseFloat(hlStill.trans) <= 0.001, hlStill.trans);
  await cdp.send("Emulation.setEmulatedMedia", { features: [] }, S);

  section("3. It ducks");
  const duckOn = async (hash, mark, label, motion) => {
    await go(hash, mark);
    for (const y of [60, 140, 240, 360, 520]) { await evalIn(cdp, S, `(document.getElementById("view").scrollTop = ${y}, 1)`); await sleep(90); }
    await sleep(500);
    const down = await J(cdp, S, BAR);
    const fabDown = await J(cdp, S, FOOT);
    for (const y of [508, 496]) { await evalIn(cdp, S, `(document.getElementById("view").scrollTop = ${y}, 1)`); await sleep(90); }
    await sleep(500);
    const up = await J(cdp, S, BAR);
    const fabUp = await J(cdp, S, FOOT);
    check(`${label}, ${motion}: down the page the bar leaves the screen and the + rides down`, down.state === "away" && down.box[1] >= down.vh && fabDown.fabTop > fabUp.fabTop, `top ${down.box[1]} of ${down.vh}; + ${fabDown.fabTop} vs ${fabUp.fabTop}`);
    check(`${label}, ${motion}: 12px back up, it is there`, up.state === "here" && up.box[1] + up.box[3] <= up.vh, `${up.state} ${JSON.stringify(up.box)}`);
    return down.trans;
  };
  const slid = await duckOn("#/", `document.querySelector("#view .ag-day")`, "Itinerary", "with motion");
  check("with motion it slides", /[1-9]/.test(slid), slid);
  await duckOn("#/places", `document.querySelectorAll("#view .pl-row").length > 8`, "Places", "with motion");
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
  const still = await duckOn("#/", `document.querySelector("#view .ag-day")`, "Itinerary", "reduce motion");
  check("with reduce motion it is there or not, no slide", still.split(",").every((t) => parseFloat(t) === 0), still);

  section("4. The +'s room");
  for (const [name, hash, mark] of [["Itinerary", "#/", `document.querySelector("#view .ag-day")`], ["Places", "#/places", `document.querySelectorAll("#view .pl-row").length > 8`],
    ["Split", "#/split", `document.querySelectorAll("#view .sp-row").length > 3`], ["Packing", "#/pack", `document.querySelector("#view .pk-root")`]]) {
    await go(hash, mark);
    await evalIn(cdp, S, `(() => { const v = document.getElementById("view"); v.scrollTop = v.scrollHeight; return 1; })()`);
    await sleep(500);
    await evalIn(cdp, S, `(() => { const v = document.getElementById("view"); v.scrollTop = v.scrollTop - 12; return 1; })()`);
    await sleep(600);
    const f = await J(cdp, S, FOOT);
    check(`${name}, scrolled to the end, the bar there: the last words end above the +`, f.fab === "1" && f.state === "here" && f.fabTop !== null && f.low <= f.fabTop - 8, JSON.stringify(f));
  }

  section("4b. At the end, no empty band");
  for (const [name, hash, mark] of [["Itinerary", "#/", `document.querySelector("#view .ag-day")`], ["Places", "#/places", `document.querySelectorAll("#view .pl-row").length > 8`],
    ["Split", "#/split", `document.querySelectorAll("#view .sp-row").length > 3`], ["Packing", "#/pack", `document.querySelector("#view .pk-root")`]]) {
    await go(hash, mark);
    // Down as a finger goes: steps of 120, never back up, until the list can go no further.
    for (let i = 0; i < 400; i++) {
      const at = Number(await evalIn(cdp, S, `(() => { const v = document.getElementById("view"), max = v.scrollHeight - v.clientHeight; v.scrollTop = Math.min(max, v.scrollTop + 120); return max - v.scrollTop; })()`));
      await sleep(40);
      if (at <= 0) break;
    }
    await sleep(700);
    const f = await J(cdp, S, FOOT);
    // The last thing drawn: words, or a box that shows (a card's ground, edge or shadow), not a wrapper a screen tall.
    const drawn = await J(cdp, S, `JSON.stringify((() => { let low = 0, what = "";
      for (const n of document.querySelectorAll("#view *")) {
        const b = n.getBoundingClientRect(), cs = getComputedStyle(n);
        if (!b.width || !b.height || b.height > innerHeight / 2 || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
        const words = [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
        const shows = !/rgba\\(0, 0, 0, 0\\)|transparent/.test(cs.backgroundColor) || parseFloat(cs.borderBottomWidth) > 0 && cs.borderBottomStyle !== "none" || cs.boxShadow !== "none";
        if ((words || shows) && b.bottom > low) { low = b.bottom; what = (n.className && typeof n.className === "string" ? n.className.split(" ")[0] : n.tagName.toLowerCase()) + " " + (n.textContent || "").trim().slice(0, 30); }
      }
      return { low: Math.round(low), what }; })())`);
    const fl = await J(cdp, S, `JSON.stringify((() => { const tops = ["#rt-fixed .fab", ".tabbar", "#netpill"].map((q) => document.querySelector(q))
      .filter((n) => n && n.getClientRects().length && !n.hidden && getComputedStyle(n).visibility !== "hidden").map((n) => n.getBoundingClientRect().top).filter((t) => t < innerHeight);
      return { floatTop: tops.length ? Math.round(Math.min(...tops)) : innerHeight }; })())`);
    const room = fl.floatTop - drawn.low;
    check(`${name}, scrolled down to its end: the bar there on its own, and below the last thing drawn 48 px at most before what floats over the foot`,
      f.state === "here" && room >= 8 && room <= 48, JSON.stringify({ state: f.state, drawn, ...fl, room }));
  }

  section("5. The saving line, and the offline pill");
  await go("#/", `document.querySelector("#view .ag-day")`);
  const line = await J(cdp, S, `JSON.stringify((() => { const n = document.getElementById("netline").getBoundingClientRect(), t = document.querySelector(".tabbar").getBoundingClientRect(); return { top: Math.round(n.top), bottom: Math.round(n.bottom), barBottom: Math.round(t.bottom), vh: innerHeight }; })())`);
  check("the saving line is at the screen's very foot, under the pill", line.bottom === line.vh && line.top >= line.barBottom, JSON.stringify(line));
  await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
  await waitFor(cdp, S, `!document.getElementById("netpill").hidden ? 1 : 0`, { label: "the offline pill" });
  await sleep(400);
  const off = await J(cdp, S, `JSON.stringify((() => { const n = document.getElementById("netpill").getBoundingClientRect(), t = document.querySelector(".tabbar").getBoundingClientRect(); return { bottom: Math.round(n.bottom), barTop: Math.round(t.top) }; })())`);
  check("offline: the pill that says so stands above the bar", off.bottom <= off.barTop, JSON.stringify(off));
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);

  section("6. The map's foot");
  await go("#/map", `document.querySelector(".mp-root .mp-scale") && document.querySelector(".mp-grab")`);
  await evalIn(cdp, S, `(() => { const g = document.querySelector(".mp-grab"); if (g.getAttribute("aria-expanded") === "true") g.click(); return 1; })()`);
  await sleep(900);
  const mp = await J(cdp, S, `JSON.stringify((() => { const t = document.querySelector(".tabbar").getBoundingClientRect(), s = document.querySelector(".mp-scale").getBoundingClientRect(), n = document.querySelector(".mp-peek").getBoundingClientRect();
    return { barTop: Math.round(t.top), scale: Math.round(s.bottom), nearby: Math.round(n.bottom), nearbyShown: n.height > 0, open: document.querySelector(".mp-grab").getAttribute("aria-expanded") }; })())`);
  check("390, the panel shut: the scale and \"Nearby\" stand above the pill", mp.open === "false" && mp.nearbyShown && mp.scale <= mp.barTop - 4 && mp.nearby <= mp.barTop - 4, JSON.stringify(mp));

  section("7. A rail from 768, a sidebar from 1024");
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
  for (const [w, h, want, beside] of [[768, 1024, 84, false], [1024, 768, 248, true], [1440, 900, 248, true]]) {
    await size(w, h, 1);
    await go("#/", `document.querySelector("#view .ag-day") && document.querySelector("[data-rail-brand][data-is]")`);
    const r = await J(cdp, S, BAR);
    // You: your picture at the foot of the narrow rail; on the wide one, your row (your picture, your name).
    const more2 = await J(cdp, S, `JSON.stringify((() => { const shown = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
      const pic = document.querySelector('.head-more'), row = document.querySelector('[data-rail-you]'), you = shown(row) ? row : pic, m = you.getBoundingClientRect(), last = document.querySelector('.tab[data-tab="chat"]').getBoundingClientRect(),
      a = document.querySelector('.tab[data-tab="agenda"]'), i = a.querySelector("svg").getBoundingClientRect(), s = a.querySelector("span:not(.ds-tab-dot)").getBoundingClientRect();
      return { you: you === row ? "row" : "picture", picShown: shown(pic), moreBottom: Math.round(m.bottom), chatBottom: Math.round(last.bottom), nameBeside: s.left >= i.right, nameUnder: s.top >= i.bottom - 1 }; })())`);
    check(`${w}: the bar is down the left, ${want} wide, the whole height; the page starts after it`,
      r.box[0] === 0 && r.box[2] === want && r.box[1] === 0 && r.box[3] === r.vh && r.view[0] === want, `${JSON.stringify(r.box)} view ${JSON.stringify(r.view)}`);
    check(`${w}: you stand at its foot, apart from the five (${beside ? "your row, your picture at the top right gone" : "your picture"})`,
      more2.moreBottom >= r.vh - 120 && more2.moreBottom - more2.chatBottom > 120 && more2.you === (beside ? "row" : "picture") && (beside ? !more2.picShown : true), JSON.stringify(more2));
    check(`${w}: ${beside ? "names beside the symbols" : "names under the symbols"}`, beside ? more2.nameBeside : more2.nameUnder, JSON.stringify(more2));
    const rail = await J(cdp, S, `JSON.stringify((() => { const nav = document.querySelector(".tabbar"), shown = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0;
      const brand = nav.querySelector("[data-rail-brand]"), first = nav.querySelector(".tab").getBoundingClientRect();
      return { brand: brand?.dataset.is || "", brandAbove: !!brand && brand.getBoundingClientRect().bottom <= first.top, svg: !!brand?.querySelector("svg"),
        trip: shown(nav.querySelector(".rail-trip")) ? nav.querySelector("[data-rail-trip-name]").textContent : null,
        dates: shown(nav.querySelector("[data-rail-trip-dates]")) ? nav.querySelector("[data-rail-trip-dates]").textContent : null,
        rows: [...nav.querySelectorAll(".rail-rest .ds-nav")].filter(shown).map((a) => [a.querySelector("span").textContent.trim(), a.getAttribute("href")]),
        you: shown(nav.querySelector("[data-rail-you]")) ? nav.querySelector("[data-rail-you-name]").textContent : null,
        ground: getComputedStyle(nav).backgroundColor, page: getComputedStyle(document.body).backgroundColor }; })())`);
    if (beside) {
      check(`${w}: under the trip's name, its dates`, !!rail.dates && /\d/.test(rail.dates), String(rail.dates));
    check(`${w}: at the top the wordmark, then the trip's name; after the five, Changes, Packing, People (the trip's page) and Settings; your name at the foot`,
        rail.brand === "word" && rail.svg && rail.brandAbove && rail.trip === TRIP_NAME
        && rail.rows.map((x) => x[0]).join() === "Changes,Packing,People,Settings" && rail.rows[2][1] === `/trips/${encodeURIComponent(TRIP)}` && rail.you === HOST.name, JSON.stringify(rail));
    } else {
      check(`${w}: at the top the W and its hikers; nothing of the wide rail's rows`, rail.brand === "mark" && rail.svg && rail.brandAbove && rail.trip === null && !rail.rows.length && rail.you === null, JSON.stringify(rail));
    }
    check(`${w}: the rail is the page's own ground`, rail.ground === rail.page, `${rail.ground} / ${rail.page}`);
    // Each tab a tap's size, and its name clear of the next tab (a name that spills into the next tab is read as that one).
    const stack = await J(cdp, S, `JSON.stringify([...document.querySelectorAll(".tabbar .tab")].map((a, i, all) => { const r = a.getBoundingClientRect(), s = a.querySelector("span:not(.ds-tab-dot)").getBoundingClientRect(), next = all[i + 1] ? all[i + 1].getBoundingClientRect() : null;
      return { tab: a.dataset.tab, h: Math.round(r.height), nameBottom: Math.round(s.bottom), nextTop: next ? Math.round(next.top) : null, nameRight: Math.round(s.right), nextLeft: next ? Math.round(next.left) : null }; }))`);
    // Under 1024 a tab is a tap's size (44); the wide rail's rows are the mock-up's 36, a row a pointer reads.
    const least = beside ? 36 : 44;
    const clash = stack.filter((t) => t.h < least || (t.nextTop !== null && (beside ? t.nameBottom > t.nextTop && t.nameRight > t.nextLeft : t.nameBottom > t.nextTop)));
    check(`${w}: every tab is ${least} px tall or more, and its name clear of the next tab`, !clash.length, JSON.stringify(clash.length ? clash : stack.map((t) => t.h)));
  }
  {
    // On the wide rail, a row of what More lists lights as a tab does, and no tab is lit with it.
    await size(1440, 900, 1);
    await go("#/pack", `document.querySelector("#view [class*='pk-']")`);
    const lit = await J(cdp, S, `JSON.stringify({ rows: [...document.querySelectorAll(".rail-rest [aria-current]")].map((a) => a.textContent.trim()), tabs: [...document.querySelectorAll(".tabbar .tab[aria-current]")].map((a) => a.dataset.tab) })`);
    check("1440: on Packing, the rail's Packing row is lit and no tab", lit.rows.join() === "Packing" && !lit.tabs.length, JSON.stringify(lit));
    // The bar redrawn (paintBar, the app's own module, given another set of tabs and then its own again): the logo
    // and the trip stay before the tabs, what More lists and you after them.
    const kept = await J(cdp, S, `(async () => { const { paintBar } = await import("/js/tabs.js"); const nav = document.querySelector(".tabbar");
      const order = () => [...nav.children].map((c) => c.matches("[data-rail-brand]") ? "logo" : c.matches(".rail-trip") ? "trip" : c.matches(".rail-rest") ? "rest" : c.matches(".tab") ? "tab" : c.matches(".ds-tab-hl") ? "hl" : "?").filter((x, i, a) => x !== "tab" || a[i - 1] !== "tab").join(" ");
      const redrawn = paintBar(nav, ["agenda", "places", "split", "memories"]); const mid = order(); paintBar(nav); await new Promise((r) => requestAnimationFrame(r));
      return JSON.stringify({ redrawn, mid, after: order() }); })()`);
    // The wide rail's rows by pointer: 36 or more for a mouse, 44 or more for a finger (a tablet on its side).
    const ROWS = `JSON.stringify({ coarse: matchMedia("(pointer: coarse)").matches, h: [...document.querySelectorAll(".tabbar .tab, .rail-rest .ds-nav, .ds-rail-you")].map((e) => Math.round(e.getBoundingClientRect().height)) })`;
    const fine = await J(cdp, S, ROWS);
    check("1440 with a mouse: the rail's rows are the mock-up's 36 px or more", !fine.coarse && fine.h.length >= 10 && fine.h.every((h) => h >= 36), JSON.stringify(fine));
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, S);
    await go("#/pack", `document.querySelector("#view [class*='pk-']")`);
    const finger = await J(cdp, S, ROWS);
    check("1440 with a finger (pointer: coarse): every row of the rail is 44 px or more", finger.coarse && finger.h.length >= 10 && finger.h.every((h) => h >= 44), JSON.stringify(finger));
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }, S);
    await go("#/pack", `document.querySelector("#view [class*='pk-']")`);
    check("1440: the bar redrawn keeps the logo and the trip before the tabs, what More lists and you after them",
      kept.redrawn && kept.mid === "logo trip hl tab rest" && kept.after === "logo trip hl tab rest", JSON.stringify(kept));
  }

  section("8. A sheet: a dialog from 768, from the foot under it");
  for (const [w, h, dsf] of [[768, 1024, 1], [390, 844, 2]]) {
    await size(w, h, dsf);
    await go("#/", `document.querySelector("#view .ag-day") && document.querySelector("#rt-fixed .fab")`);
    await evalIn(cdp, S, `(document.querySelector("#rt-fixed .fab").click(), 1)`);
    await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1'] .sh-sheet") ? 1 : 0`, { label: `the sheet at ${w}` });
    await sleep(800);
    const sh = await J(cdp, S, `JSON.stringify((() => { const s = document.querySelector(".sh-sheet"), r = s.getBoundingClientRect(), cs = getComputedStyle(s), x = s.querySelector(".sh-x");
      const rail = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--rail-w")) || 0;
      return { box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], mid: Math.round((r.left + r.right) / 2), pageMid: Math.round(rail + (innerWidth - rail) / 2),
        corners: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomLeftRadius, cs.borderBottomRightRadius].map(parseFloat), x: !!x && x.getBoundingClientRect().width >= 32, vh: innerHeight, w: Math.round(r.width) }; })())`);
    if (w >= 768) {
      check(`${w}: a dialog in the middle of the page, at most 560 wide, all four corners round, with a ×`,
        Math.abs(sh.mid - sh.pageMid) <= 2 && sh.w <= 560 && sh.box[3] < sh.vh - 16 && sh.corners.every((c) => c >= 8) && sh.x, JSON.stringify(sh));
      await evalIn(cdp, S, `(document.querySelector(".sh-sheet .sh-x").click(), 1)`);
      await sleep(900);
      check(`${w}: the × closes it`, await evalIn(cdp, S, `document.querySelector(".sh-root[data-open='1']") ? 0 : 1`) === 1);
    } else {
      check(`${w}: it rises from the foot`, sh.box[3] === sh.vh && sh.box[0] === 0, JSON.stringify(sh));
      await evalIn(cdp, S, `(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
      await sleep(900);
    }
  }
  section("8b. Turned: a sheet, and the bar sent away");
  // A sheet that doesn't ask for a × (the Itinerary's Add a plan) opened upright, then the phone turned on its side
  // (the rail, the sheet a dialog with no grab): its × is there and closes it. Turned back upright with it open, the
  // grab is back and the × gone again.
  await size(390, 844);
  await go("#/", `document.querySelector("#view .ag-day") && document.querySelector("#rt-fixed .fab")`);
  await evalIn(cdp, S, `(document.querySelector("#rt-fixed .fab").click(), 1)`);
  await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1'] .sh-sheet") ? 1 : 0`, { label: "the sheet at 390" });
  await sleep(800);
  const XG = `JSON.stringify((() => { const s = [...document.querySelectorAll(".sh-root[data-open='1'] .sh-sheet")].pop(); const x = s && s.querySelector(".sh-x"), g = s && s.querySelector(".sh-grab");
    const on = (n) => !!n && n.getBoundingClientRect().width >= 32 && getComputedStyle(n).display !== "none";
    return { open: !!s, x: on(x), grab: !!g && g.getBoundingClientRect().height > 0, rail: document.body.dataset.bar === "first" }; })())`;
  const up1 = await J(cdp, S, XG);
  await size(844, 390);
  await sleep(600);
  const side = await J(cdp, S, XG);
  await size(390, 844);
  await sleep(600);
  const up2 = await J(cdp, S, XG);
  check("390 upright: Add a plan rises from the foot with its grab and no ×", up1.open && up1.grab && !up1.x && !up1.rail, JSON.stringify(up1));
  check("turned to 844 x 390 with it open: the rail, and the sheet's × is there (no grab)", side.open && side.x && !side.grab && side.rail, JSON.stringify(side));
  check("turned back upright: the grab again, no ×", up2.open && up2.grab && !up2.x && !up2.rail, JSON.stringify(up2));
  await size(844, 390);
  await sleep(600);
  await evalIn(cdp, S, `(([...document.querySelectorAll(".sh-root[data-open='1'] .sh-x")].pop() || { click() {} }).click(), 1)`);
  await sleep(900);
  check("on its side, that × closes it", await evalIn(cdp, S, `document.querySelector(".sh-root[data-open='1']") ? 0 : 1`) === 1);
  // On its side, down a long page: the bar's "away" is set though the rail doesn't read it. Turned upright, the pill is
  // there, not away until a scroll up.
  await go("#/", `document.querySelector("#view .ag-day")`);
  await evalIn(cdp, S, `(() => { const v = document.getElementById("view"); v.scrollTop = 0; return 1; })()`);
  await sleep(500);
  for (const y of [200, 500, 900, 1300]) {
    await evalIn(cdp, S, `(document.getElementById("view").scrollTop = ${y}, 1)`);
    await sleep(250);
  }
  const away = await J(cdp, S, BAR);
  await size(390, 844);
  await sleep(700);
  const back = await J(cdp, S, BAR);
  check("down a long page on its side the bar is sent away (only the pill reads it)", away.state === "away" && away.position !== "fixed", JSON.stringify({ state: away.state, position: away.position }));
  check("turned upright there: the pill is at the foot, not away", back.state === "here" && back.position === "fixed" && back.box[1] + back.box[3] <= back.vh, JSON.stringify({ state: back.state, box: back.box, vh: back.vh }));

  section("8c. A sheet goes by its own slide, not a button's");
  // transitionend bubbles. A button inside the sheet that eases its own transform on a press (Add a purchase's Add)
  // sends one up too; taken for the sheet's, it tore the sheet down mid-slide on close, and called it arrived early on
  // open. Here a button in Add a plan is given a 40 ms transform transition and pressed as the sheet moves: its end
  // comes long before the sheet's own slide. Motion on for it: the sections above leave reduced motion on.
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] }, S);
  await size(390, 844);
  await go("#/", `document.querySelector("#view .ag-day") && document.querySelector("#rt-fixed .fab")`);
  const SLIDE = (phase) => `(async () => {
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const childEnd = (btn) => new Promise((r) => { btn.addEventListener("transitionend", () => r(Math.round(performance.now())), { once: true }); setTimeout(() => r(null), 600); });
    let st = document.getElementById("slide-probe");
    if (!st) { st = document.createElement("style"); st.id = "slide-probe"; st.textContent = ".sh-root .sh-sheet .btn{transition:transform 40ms linear !important}"; document.head.append(st); }
    if (${JSON.stringify(phase)} === "open") {
      document.querySelector("#rt-fixed .fab").click();
      const root = [...document.querySelectorAll(".sh-root")].pop(), sheet = root.querySelector(".sh-sheet");
      const btn = sheet.querySelector(".btn");
      void btn.offsetWidth;
      const t0 = Math.round(performance.now());
      btn.style.transform = "scale(0.96)";
      const ended = await childEnd(btn);
      await pause(30);
      const early = root.dataset.entered === "1";
      await pause(900);
      return JSON.stringify({ slide: getComputedStyle(sheet).transitionDuration, child: ended === null ? null : ended - t0, enteredAtChild: early, enteredLater: root.dataset.entered === "1" });
    }
    const root = [...document.querySelectorAll(".sh-root[data-open='1']")].pop(), sheet = root.querySelector(".sh-sheet");
    const btn = sheet.querySelector(".btn");
    // Back to rest with no transition of its own (one set and reversed in the same moment never ends, so it would
    // send no end of its own to tell apart), then pressed as the sheet starts to leave.
    btn.style.setProperty("transition", "none", "important");   // over the probe's own !important
    btn.style.transform = "";
    void btn.offsetWidth;
    btn.style.removeProperty("transition");
    void btn.offsetWidth;
    const t0 = Math.round(performance.now());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    btn.style.transform = "scale(0.96)";
    const ended = await childEnd(btn);
    await pause(30);
    const upAtChild = root.isConnected;
    await pause(1200);
    return JSON.stringify({ slide: getComputedStyle(sheet).transitionDuration, child: ended === null ? null : ended - t0, upAtChild, goneLater: !root.isConnected });
  })()`;
  const opened = JSON.parse(await evalIn(cdp, S, SLIDE("open")));
  check("opening: a button's own transform end (40 ms in) doesn't count as the sheet arriving",
    opened.child !== null && opened.child < 200 && !opened.enteredAtChild, JSON.stringify(opened));
  check("opening: the sheet says it has arrived once its own slide ends", opened.enteredLater, JSON.stringify(opened));
  const closed = JSON.parse(await evalIn(cdp, S, SLIDE("close")));
  check("closing: a button's own transform end (40 ms in) leaves the sheet up, still sliding",
    closed.child !== null && closed.child < 200 && closed.upAtChild, JSON.stringify(closed));
  check("closing: the sheet is gone once its own slide ends", closed.goneLater, JSON.stringify(closed));
  await evalIn(cdp, S, `(document.getElementById("slide-probe")?.remove(), 1)`);

  section("9. The day strip on a desktop");
  // 16 Nov: at 1440 the strip ran off the right edge ("Sa…") with nothing saying there was more,
  // and a mouse wheel didn't move it.
  const STRIP = `JSON.stringify((() => { const s = document.querySelector(".ag-strip"), v = document.getElementById("view");
    const vis = (d) => { const b = s.querySelector('[data-strip-more="' + d + '"]'); if (!b) return null; const cs = getComputedStyle(b), r = b.getBoundingClientRect(), sr = s.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility === "visible" && r.width > 0 && r.left >= sr.left - 1 && r.right <= sr.right + 1; };
    const pills = [...s.querySelectorAll(".ag-pill")], last = pills.at(-1);
    return { x: Math.round(s.scrollLeft), max: s.scrollWidth - s.clientWidth, earlier: vis(-1), later: vis(1), page: Math.round(v.scrollTop),
      order: [...s.children].filter((n) => n.matches(".ag-pill, .ag-stripmore")).map((n) => n.matches(".ag-stripmore") ? "arrow" : "pill").join(",").replace(/(pill,)+pill/, "pills"),
      lastClipped: last ? last.getBoundingClientRect().right > s.getBoundingClientRect().right : null,
      mid: (() => { const r = s.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })() }; })())`;
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
  for (const [w, h] of [[1440, 900], [1024, 768]]) {
    await size(w, h, 1);
    await go("#/", `document.querySelector("#view .ag-day") && document.querySelectorAll(".ag-strip .ag-pill").length > 6`);
    await evalIn(cdp, S, `(document.querySelector(".ag-strip").scrollLeft = 0, document.getElementById("view").scrollTop = 0, 1)`);
    await sleep(400);
    const s0 = await J(cdp, S, STRIP);
    check(`${w}: at its start, an arrow at its right end says there are later days; none at its left`, s0.max > 0 && s0.later === true && s0.earlier === false && s0.order === "arrow,pills,arrow", JSON.stringify(s0));
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: s0.mid[0], y: s0.mid[1], deltaX: 0, deltaY: 240 }, S);
    await sleep(500);
    const s1 = await J(cdp, S, STRIP);
    check(`${w}: a mouse wheel turned over it moves the days, not the page`, s1.x > s0.x && s1.page === s0.page, `strip ${s0.x} → ${s1.x}, page ${s0.page} → ${s1.page}`);
    check(`${w}: and now the left arrow says there are earlier days`, s1.earlier === true, JSON.stringify(s1));
    // From its start again: the wheel may have taken it to its end (at 1440 it runs over by little).
    await evalIn(cdp, S, `(document.querySelector(".ag-strip").scrollLeft = 0, 1)`);
    await sleep(300);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: s0.mid[0], y: s0.mid[1], deltaX: 120, deltaY: 0 }, S);
    await sleep(500);
    const s2 = await J(cdp, S, STRIP);
    check(`${w}: a trackpad's sideways swipe still moves it`, s2.x > 0, `0 → ${s2.x}`);
    await evalIn(cdp, S, `(document.querySelector('.ag-strip [data-strip-more="1"]').click(), 1)`);
    await sleep(500);
    const s3 = await J(cdp, S, STRIP);
    check(`${w}: the right arrow moves it on`, s3.x > s2.x || s3.x === s3.max, `${s2.x} → ${s3.x} of ${s3.max}`);
    await evalIn(cdp, S, `(document.querySelector(".ag-strip").scrollLeft = 1e6, 1)`);
    await sleep(400);
    const s4 = await J(cdp, S, STRIP);
    check(`${w}: at its end the last day shows whole and the right arrow is gone`, s4.later === false && s4.lastClipped === false && s4.earlier === true, JSON.stringify(s4));
  }
  await size(390, 844);
  await go("#/", `document.querySelector("#view .ag-day")`);
  const phone = await J(cdp, S, STRIP);
  check("390: no arrows (the finger has the strip)", phone.earlier === false && phone.later === false, JSON.stringify(phone));

  check("no exception reached the page", b.pageErrors.length === 0, b.pageErrors.join(" | ") || "clean");
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  try { putBack(); } catch (e) { console.log(`could not put the account's layout back: ${e.message}`); }
  await b.done();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

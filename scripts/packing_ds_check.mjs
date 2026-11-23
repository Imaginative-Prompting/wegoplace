#!/usr/bin/env node
/* PACKING, ON THE DESIGN SYSTEM (flow 7, packing-mock.html), in a browser on the gate's made-up trip as its host, at
 * 390 (and 320), reduced motion so every state is the final one.
 *
 *   node scripts/gate.mjs --only packing_ds_check
 *
 * It holds:
 *   1. THE HEAD: titled Packing, on the system (the screen inside .ds); no Back of its own (the dock is the one Back).
 *   2. MINE AND GROUP are one sliding control (ds-modes): the highlight sits on the chosen one, and choosing the other
 *      moves it there (by one cell).
 *   3. THE ONE BIG NUMBER is how many are left on the list on screen: what the line's own words count (carried less
 *      packed), and the line is filled to the same share.
 *   4. ONE LIST, NO BAGS: the things on the list on screen in one run by kind, as many as the line counts carried; no
 *      bag heading, no line under a thing about the other lists; what isn't on the list under "Not on this list".
 *   5. A THING is a line pressed at 48 px or more, with a 24 px box; ticked, the box is the system's solid and the words
 *      go quiet (ink-2, regular weight), and the big number is one less. Unticked again, as it was.
 *   6. THE TOOLS are the system's fade buttons, Hide packed and Lists; "Collapse all" is gone.
 *   7. HIDE PACKED takes a packed thing off the screen, and its kind's label with it when nothing else of that kind is
 *      left on the list.
 *   8. AT 320 nothing runs off the side. 9. No page errors.
 * The one tick it makes is taken back, and Hide packed is put back as it was.
 *
 * PLANTED (PACKDS_PLANT=<name>; each serves js/packing.js changed, never writes it):
 *   still   the switch's highlight never moved off Mine: 1 red (2).
 *   count   the big number counting everything carried, not what is left: 1 red (5; with nothing packed at the start
 *           the two counts agree, and the tick is what tells them apart).
 *   loud    a packed thing's words kept at full weight: 1 red (5).
 *   bagword the list's add button naming a bag again ("Add to Main bag"): 1 red (4).
 */
import fs from "node:fs";
import { BASE, boot, evalIn, waitFor, sleep, appSettled } from "./lib/standalone_cdp.mjs";
import { tripPath } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

const PLANT = process.env.PACKDS_PLANT || "";
if (PLANT && !["still", "count", "loud", "bagword"].includes(PLANT)) throw new Error("PACKDS_PLANT is still, count, loud or bagword");
const PLANTED = PLANT ? (() => {
  const src = fs.readFileSync(new URL("../public/js/packing.js", import.meta.url), "utf8");
  const t = PLANT === "still" ? src.replace('    if (own && shownTab && shownTab !== tab) requestAnimationFrame(() => own.style.setProperty("--ds-i", tab === "group" ? "1" : "0"));\n', "")
      .replace('    const shownAt = (shownTab || tab) === "group" ? 1 : 0;', "    const shownAt = 0;")
    : PLANT === "count" ? src.replace("    const left = g.carried - g.done;", "    const left = g.carried;")
    : PLANT === "bagword" ? src.replace("<span>Add a thing</span>", "<span>Add to Main bag</span>")
    : src.replace('.pk-item[data-done="1"] .pk-label{color:var(--ink-2);font-weight:400}', '.pk-item[data-done="1"] .pk-label{color:var(--ink-2)}');
  if (t === src) throw new Error(`the ${PLANT} plant didn't take`);
  return t;
})() : null;

const b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: true });
const { cdp, S } = b;
const J = async (e) => JSON.parse(await evalIn(cdp, S, e));
const ev = (e) => evalIn(cdp, S, e);
if (PLANTED) {
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(PLANTED).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/packing.js*" }] }, S);
  console.log(`PLANTED: ${PLANT}`);
}
const go = async () => {
  await cdp.send("Page.navigate", { url: "about:blank" }, S);
  await sleep(100);
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/pack")}` }, S);
  await appSettled(cdp, S).catch(() => {});
  await waitFor(cdp, S, `document.querySelector("#view .pk-hero") ? 1 : 0`, { label: "Packing", timeout: 30000 });
  await sleep(500);
};
const SUM = `JSON.stringify((() => { const n = document.querySelector("#view .pk-sum-n"), m = document.querySelector("#view .pk-meter"), f = m && m.querySelector(".pk-meter-fill");
  const x = m && m.getAttribute("aria-label").match(/^(\\d+) of (\\d+) packed/);
  return { big: n ? Number(n.textContent) : null, packed: x ? Number(x[1]) : null, carried: x ? Number(x[2]) : null,
    share: m && f ? f.getBoundingClientRect().width / m.getBoundingClientRect().width : null }; })())`;
let ticked = null, hid = false;

try {
  await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });
  await ev(`(localStorage.setItem("wgp.pack.tab", "mine"), localStorage.removeItem("wgp.pack.hidedone"), 1)`);
  await go();

  section("1. The head");
  const head = await J(`JSON.stringify({ title: (document.querySelector("#view .pk-head h1") || {}).textContent || null, ds: !!document.querySelector("#view .pk-root.ds"),
    back: !!document.querySelector("#view .ds-head-back, #view .pk-head [aria-label^='Back']") })`);
  check("titled Packing, on the system, with no Back of its own", head.title === "Packing" && head.ds && !head.back, JSON.stringify(head));

  section("2. Mine and Group");
  const sw = `JSON.stringify((() => { const own = document.querySelector("#view .pk-own"), hl = own.querySelector(".ds-modes-hl"), on = own.querySelector('[aria-selected="true"]');
    const cells = [...own.querySelectorAll(".ds-mode")], h = hl.getBoundingClientRect(), o = on.getBoundingClientRect();
    return { modes: own.classList.contains("ds-modes"), n: cells.length, on: on.dataset.tab, i: getComputedStyle(own).getPropertyValue("--ds-i").trim(),
      under: Math.abs((h.left + h.width / 2) - (o.left + o.width / 2)) <= 2 }; })())`;
  const mine = await J(sw);
  await ev(`(document.querySelector('[data-act="owner"][data-tab="group"]').click(), 1)`);
  await sleep(400);
  const group = await J(sw);
  await ev(`(document.querySelector('[data-act="owner"][data-tab="mine"]').click(), 1)`);
  await sleep(400);
  const back = await J(sw);
  check("one sliding control of two, its highlight under the chosen one, and choosing Group moves it there and back",
    mine.modes && mine.n === 2 && mine.on === "mine" && mine.under && group.on === "group" && group.i === "1" && group.under && back.on === "mine" && back.under,
    JSON.stringify({ mine, group, back }));

  section("3. The one big number");
  const sum = await J(SUM);
  check("the big number is what is left: carried less packed, as the line's words count", sum.big !== null && sum.big === sum.carried - sum.packed, JSON.stringify(sum));
  check("the line is filled to the share packed", sum.share !== null && Math.abs(sum.share - sum.packed / sum.carried) < 0.02, JSON.stringify(sum));

  section("4. One list, no bags");
  const one = await J(`JSON.stringify({ lists: document.querySelectorAll("#view .pk-on").length, rows: document.querySelectorAll("#view .pk-on .pk-item").length,
    heads: [...document.querySelectorAll("#view .pk-sec-head")].map((h) => h.textContent.trim().replace(/\\s+/g, " ")), lines: document.querySelectorAll("#view .pk-else").length,
    bin: !!document.querySelector("#view .pk-bin"), words: document.querySelector("#view .pk-bags").textContent })`);
  check("the things on the list in one run, as many as the line counts; the only heading is \"Not on this list\"; no line about other lists",
    one.lists === 1 && one.rows === sum.carried && one.heads.length === 1 && /^Not on this list/.test(one.heads[0]) && one.lines === 0 && one.bin
      && !/Main bag|Day bag|On me|not carried/.test(one.words), JSON.stringify({ ...one, words: one.words.slice(0, 120), carried: sum.carried }));

  section("5. A thing");
  const row = `JSON.stringify((() => { const li = document.querySelector('#view .pk-item[data-id="ID"]'), t = li.querySelector(".pk-tick"), box = li.querySelector(".pk-box"), l = li.querySelector(".pk-label");
    const probe = document.createElement("i"); probe.style.color = "var(--ink-2)"; probe.style.background = "var(--solid)"; li.append(probe); const ps = getComputedStyle(probe); const ink2 = ps.color, solid = ps.backgroundColor; probe.remove();
    const tb = t.getBoundingClientRect(), bb = box.getBoundingClientRect(), ls = getComputedStyle(l), bs = getComputedStyle(box);
    return { done: li.dataset.done, h: Math.round(tb.height), box: [Math.round(bb.width), Math.round(bb.height)], boxBg: bs.backgroundColor, solid, color: ls.color, ink2, weight: ls.fontWeight }; })())`;
  ticked = await ev(`(() => { const t = document.querySelector('#view button.pk-tick[aria-checked="false"]'); return t ? t.closest(".pk-item").dataset.id : null; })()`);
  if (!ticked) check("a thing to tick", false, "no unticked thing on the list");
  else {
    const before = await J(row.replace("ID", ticked));
    const sumBefore = await J(SUM);
    await ev(`(document.querySelector('#view .pk-item[data-id="${ticked}"] button.pk-tick').click(), 1)`);
    await waitFor(cdp, S, `document.querySelector('#view .pk-item[data-id="${ticked}"][data-done="1"]') ? 1 : 0`, { label: "the tick", timeout: 8000 });
    await sleep(400);
    const after = await J(row.replace("ID", ticked));
    const sumAfter = await J(SUM);
    check("a thing is pressed at 48 px or more, with a 24 px box", before.h >= 48 && before.box.join() === "24,24", JSON.stringify(before));
    check("ticked: the box is the system's solid, the words quiet (ink-2, regular), the big number one less",
      after.done === "1" && after.boxBg === after.solid && after.color === after.ink2 && Number(after.weight) <= 400 && sumAfter.big === sumBefore.big - 1, JSON.stringify({ after, sumBefore, sumAfter }));

    section("7. Hide packed");
    const kindOf = await ev(`(() => { const li = document.querySelector('#view .pk-item[data-id="${ticked}"]'); const ul = li.closest(".pk-list");
      return JSON.stringify({ alone: ul.querySelectorAll(".pk-item").length === 1, label: ul.previousElementSibling ? ul.previousElementSibling.textContent.trim() : null }); })()`);
    const k = JSON.parse(kindOf);
    await ev(`(document.querySelector('[data-act="hide"]').click(), 1)`);
    hid = true;
    await sleep(600);
    const gone = await J(`JSON.stringify({ row: !!document.querySelector('#view .pk-item[data-id="${ticked}"]'),
      label: [...document.querySelectorAll("#view .pk-on .pk-cat")].map((c) => c.textContent.trim()).includes(${JSON.stringify(k.label)}) })`);
    check(`Hide packed takes the packed thing away${k.alone ? ", and its kind's label with it (nothing else of that kind is left on the list)" : ""}`, !gone.row && (!k.alone || !gone.label), JSON.stringify({ k, gone }));
    await ev(`(document.querySelector('[data-act="hide"]').click(), 1)`);
    hid = false;
    await sleep(500);
    await ev(`(document.querySelector('#view .pk-item[data-id="${ticked}"] button.pk-tick').click(), 1)`);
    await waitFor(cdp, S, `document.querySelector('#view .pk-item[data-id="${ticked}"][data-done="0"]') ? 1 : 0`, { label: "the tick taken back", timeout: 8000 });
    ticked = null;
    const sumBack = await J(SUM);
    check("unticked again: the big number as it was", sumBack.big === sumBefore.big, JSON.stringify({ sumBefore, sumBack }));
  }

  section("6. The tools");
  const tools = await J(`JSON.stringify({ words: [...document.querySelectorAll("#view .pk-tools button")].map((x) => [x.dataset.act, x.classList.contains("ds-button--fade")]), foldall: !!document.querySelector('[data-act="foldall"]') })`);
  const named = await J(`JSON.stringify((document.querySelector('[data-act="managebags"]') || {}).textContent || "")`);
  check("Hide packed and Lists, the system's fade buttons; no Collapse all", tools.words.map((w) => w[0]).join() === "hide,managebags" && named.trim() === "Lists" && tools.words.every((w) => w[1]) && !tools.foldall, JSON.stringify({ tools, named }));

  section("8. At 320");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 2, mobile: true }, S);
  await go();
  const over = Number(await ev(`document.documentElement.scrollWidth - innerWidth`));
  // Every box of the screen inside the width, but the lists' strip's own pills (the strip scrolls sideways in its box).
  const wide = await J(`JSON.stringify([...document.querySelectorAll("#view .pk-root *")].filter((n) => !n.closest(".pk-views > *") && n.getClientRects().length && n.getBoundingClientRect().right > innerWidth + 0.5).map((n) => n.tagName.toLowerCase() + "." + String(n.className).split(" ")[0]).slice(0, 4))`);
  check("320: nothing runs off the side (the lists' strip scrolls inside its own box)", over <= 0 && wide.length === 0, JSON.stringify({ over, wide }));

  section("9. No page errors");
  check("nothing thrown", b.pageErrors.length === 0, b.pageErrors.join(" | ").slice(0, 400));
} catch (e) {
  fail++; failures.push(`stopped: ${e.message}`);
  console.log(`  FAIL  stopped: ${e.stack || e}`);
} finally {
  if (hid) await ev(`(document.querySelector('[data-act="hide"]') && document.querySelector('[data-act="hide"]').click(), 1)`).catch(() => {});
  if (ticked) await ev(`(() => { const t = document.querySelector('#view .pk-item[data-id="${ticked}"] button.pk-tick'); if (t && t.getAttribute("aria-checked") === "true") t.click(); return 1; })()`).catch(() => {});
  await ev(`(localStorage.removeItem("wgp.pack.hidedone"), 1)`).catch(() => {});
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }

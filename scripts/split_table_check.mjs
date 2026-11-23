#!/usr/bin/env node
/* SPLIT ON A WIDE SCREEN (split.js "the page"): the made-up trip's host, in a real browser.
 *
 *   1. 1440 and 1180: two columns. The feed on the left, no wider than 640; on the right the
 *      headline and everything Settle up says (the payments that settle everyone, the balances,
 *      "Record another payment"), standing still while the feed scrolls a long way. Nothing opens
 *      as a sheet to read balances there: "Everyone's balances" isn't drawn.
 *   2. 1179, 1100, 1024 and 768: one column, no wider than 640 and centred; the headline above the
 *      feed with "Everyone's balances"; no Settle up content beside it.
 *   3. Every width: the amounts in one column (each row's total ends on the same right edge, and
 *      so does each "your share"), and from 768 no floating +: the add is named in the head.
 *   4. A purchase opened at 1440: its sheet is a dialog.
 *   5. 390: one column at the phone's width, the headline above the feed, the amounts still one
 *      right edge.
 *
 *   node scripts/gate.mjs --only split_table_check
 *
 * PLANTED (red when put in by hand): split.js without its 1180 rule (1); its 768 max-width (2);
 * .sp-mine without justify-self:end (3).
 */
import { BASE, boot, evalIn, waitFor, sleep, appSettled } from "./lib/standalone_cdp.mjs";
import { tripPath } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const J = async (cdp, S, expr) => JSON.parse(await evalIn(cdp, S, expr));

const PAGE = `JSON.stringify((() => {
  const shown = (n) => !!n && getComputedStyle(n).display !== "none" && n.getBoundingClientRect().width > 0;
  const box = (n) => { const r = n.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width) }; };
  const view = document.getElementById("view").getBoundingClientRect();
  const rows = [...document.querySelectorAll("#view .sp-feed .sp-row")].filter((r) => r.getBoundingClientRect().height > 0).slice(0, 14);
  const totals = rows.map((r) => Math.round(r.querySelector(".sp-total").getBoundingClientRect().right));
  const mines = rows.map((r) => r.querySelector(".sp-mine")).filter(Boolean).map((n) => Math.round(n.getBoundingClientRect().right));
  const hero = document.querySelector("#view .sp-hero"), wide = document.querySelector("#view .sp-wide");
  const f = document.querySelector("#rt-fixed .fab"), fr = f && getComputedStyle(f).display !== "none" ? f.getBoundingClientRect() : null;
  const ha = [...document.querySelectorAll("#view .head-add")].find((n) => getComputedStyle(n).display !== "none");
  const bal = document.querySelector('#view [data-act="settle"]');
  return { vw: innerWidth, view: { l: Math.round(view.left), r: Math.round(view.right) }, feed: box(document.querySelector("#view .sp-feed")),
    hero: box(hero), heroText: hero.innerText.replace(/\\s+/g, " ").slice(0, 80),
    wide: shown(wide) ? { ...box(wide), plan: !!wide.querySelector(".sp-plan, [data-sp='plan-none']"), bals: wide.querySelectorAll(".sp-bal").length,
      record: !!wide.querySelector('[data-act="record"]') } : null,
    balances: shown(bal), totals, mines, rows: rows.length,
    headAdd: ha ? ha.textContent.trim() : null, headIcon: !!(ha && ha.querySelector("svg")), fab: fr ? { l: Math.round(fr.left), t: Math.round(fr.top) } : null };
})())`;

const b = await boot({ vw: 1440, vh: 900, dsf: 1, reduceMotion: true });
const { cdp, S } = b;
const size = async (w, h) => { await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: w < 1000 ? 2 : 1, mobile: w < 1000 }, S); await sleep(400); };
const go = async () => {
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/split")}` }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `document.querySelectorAll("#view .sp-row").length > 6 && document.querySelector("#view .sp-hero") ? 1 : 0`, { label: "Split", timeout: 30000 });
  // The same address again is a move within the page: the scroll a run before left stays. From the top.
  await evalIn(cdp, S, `(document.getElementById("view").scrollTop = 0, 1)`);
  await sleep(700);
};
const oneEdge = (xs) => xs.length > 2 && Math.max(...xs) - Math.min(...xs) <= 1;
try {
  for (const [w, h] of [[1440, 900], [1180, 800], [1179, 800], [1100, 800], [1024, 768], [768, 1024]]) {
    section(`${w}`);
    await size(w, h);
    await go();
    const t = await J(cdp, S, PAGE);
    check(`${w}: every total ends on one right edge, and so does every "your share"`, oneEdge(t.totals) && oneEdge(t.mines), JSON.stringify({ totals: t.totals, mines: t.mines }));
    // On the design system the head's + is the white button's icon, beside the words "Add a purchase".
    check(`${w}: no floating +: the add is named in the head ("Add a purchase", with its + icon)`, !t.fab && t.headAdd === "Add a purchase" && t.headIcon, JSON.stringify({ fab: t.fab, headAdd: t.headAdd, headIcon: t.headIcon }));
    // From 1180 (where the feed's 480, the gap and the side fit beside the 248 rail), two columns.
    if (w >= 1180) {
      check(`${w}: the feed on the left, no wider than 640`, t.feed.w <= 640 && t.feed.w >= 480, JSON.stringify(t.feed));
      check(`${w}: the headline and Settle up's content on the right of it: the plan, the balances and "Record another payment"`,
        !!t.wide && t.hero.l >= t.feed.r + 24 && t.wide.l >= t.feed.r + 24 && t.wide.plan && t.wide.bals >= 2 && t.wide.record && /owe|owed|settled/i.test(t.heroText),
        JSON.stringify({ hero: t.hero, wide: t.wide, feed: t.feed }));
      check(`${w}: nothing opens as a sheet to read balances: "Everyone's balances" isn't drawn`, !t.balances);
      await evalIn(cdp, S, `(document.getElementById("view").scrollTop = 1500, 1)`);
      await sleep(500);
      const t2 = await J(cdp, S, PAGE);
      check(`${w}: and the right column stands still while the feed scrolls a long way`,
        t2.hero.t === t.hero.t && t2.hero.t >= 0 && t2.feed.t < t.feed.t - 200, JSON.stringify({ before: t.hero.t, after: t2.hero.t, feedMoved: t.feed.t - t2.feed.t }));
    } else {
      const mid = (t.view.l + t.view.r) / 2;
      check(`${w}: one column, no wider than 640, centred`, t.feed.w <= 640 && Math.abs((t.feed.l + t.feed.r) / 2 - mid) <= 24 && !t.wide, JSON.stringify({ feed: t.feed, view: t.view, wide: t.wide }));
      check(`${w}: the headline above the feed, with "Everyone's balances"`, t.hero.b <= t.feed.t && t.balances, JSON.stringify({ hero: t.hero, feed: t.feed, balances: t.balances }));
    }
  }

  section("A purchase opened, 1440");
  await size(1440, 900);
  await go();
  await evalIn(cdp, S, `([...document.querySelectorAll("#view .sp-feed .sp-row")].find((r) => r.dataset.kind !== "payment").click(), 1)`);
  await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1'] .sh-sheet") ? 1 : 0`, { label: "the purchase's sheet" });
  await sleep(700);
  const sh = await J(cdp, S, `JSON.stringify((() => { const s = document.querySelector(".sh-sheet").getBoundingClientRect(); return { w: Math.round(s.width), bottom: Math.round(s.bottom), vh: innerHeight }; })())`);
  check("its sheet is a dialog, not a sheet from the foot", sh.w <= 560 && sh.bottom < sh.vh - 16, JSON.stringify(sh));
  await evalIn(cdp, S, `(document.querySelector(".sh-scrim").click(), 1)`);
  await sleep(600);

  section("390");
  await size(390, 844);
  await go();
  const p = await J(cdp, S, PAGE);
  check("390: one column at the phone's width, the headline above the feed", !p.wide && p.hero.b <= p.feed.t && p.balances, JSON.stringify({ hero: p.hero, feed: p.feed }));
  check("390: every total ends on one right edge, and so does every \"your share\"", oneEdge(p.totals) && oneEdge(p.mines), JSON.stringify({ totals: p.totals, mines: p.mines }));
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

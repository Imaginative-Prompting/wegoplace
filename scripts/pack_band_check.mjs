#!/usr/bin/env node
/* "PACK FOR TODAY" FOLLOWS AT ONCE (the layouts, 16 Nov; agenda.js packHTML/packSlice): on the made-up
 * trip, its host, the page's clock on a day the list "A day out" is packed for, the Itinerary open
 * the whole time and never left. Counted from what the band says when the check begins (the made-up
 * trip already has things on that list):
 *
 *   1. Three more of the host's things put on the list (as Packing puts them): the band says three
 *      more to pack, within 2 s, without leaving the Itinerary.
 *   2. One of them ticked on this phone: one more packed, within 2 s.
 *   3. Another ticked on another phone (a second page, the same person): one more packed here when
 *      that change arrives, the time it took said; still without leaving.
 *   4. It takes back what it did (the ticks, then the three placements) and the list is as found.
 *
 *   node scripts/gate.mjs --only pack_band_check
 *
 * PLANTED (red when put in by hand): agenda.js packSlice() returning "" (1, 2, 3).
 */
import { BASE, boot, evalIn, waitFor, sleep, appSettled } from "./lib/standalone_cdp.mjs";
import { tripPath } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const LIST = "day-out";
const L = JSON.stringify(LIST);
const STORE = (body) => `import("/js/store.js").then(async ({ store }) => { ${body} })`;
const BAND = `JSON.stringify((() => { const n = [...document.querySelectorAll("#view .ag-pk")].find((a) => /Pack for today/.test(a.textContent)); return n ? (n.querySelector(".ag-stay-meta") || {}).textContent || "" : null; })())`;
// What the band says, as numbers: "2 of 5 packed", "all 5 packed"; no band is 0 of 0.
const counts = (t) => {
  if (!t) return { done: 0, of: 0 };
  const all = /all (\d+) packed/.exec(t);
  if (all) return { done: +all[1], of: +all[1] };
  const m = /(\d+) of (\d+) packed/.exec(t);
  return m ? { done: +m[1], of: +m[2] } : { done: -1, of: -1 };
};
const ONLIST = STORE(`const me = store.me(); return JSON.stringify([...store.packing(me.id), ...store.packing("group")]
  .map((it) => [it.id, store.packBag(it.id, ${L}) || "", store.packTicked(it.id, ${L}, store.packDay(${L}).day) ? "t" : ""]).filter((x) => x[1]).sort());`);
const clockAt = (ms) => `(() => { const Real = Date, shift = ${ms} - Real.now();
  class Shifted extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + shift); } static now() { return Real.now() + shift; } }
  window.Date = Shifted; })()`;

const b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: true });
const { cdp, S } = b;
// Read the band until it says `want`, for at most `ms`: what it said last, and how long it took.
const until = async (sess, want, ms) => {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = JSON.parse(await evalIn(cdp, sess, BAND));
    const c = counts(last);
    if (c.done === want.done && c.of === want.of) return { ok: true, last, ms: Date.now() - t0 };
    await sleep(100);
  }
  return { ok: false, last, ms: Date.now() - t0 };
};
let other = null, placed = [], day = null, found = null;
try {
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/")}` }, S);
  await appSettled(cdp, S);
  const when = JSON.parse(await evalIn(cdp, S, STORE(`const t = store.trip(), l = store.packLists().find((x) => x.key === ${L});
    if (!l) return JSON.stringify(null);
    const days = l.dates && l.dates.length ? l.dates : [t.starts_on];
    return JSON.stringify({ day: days[Math.min(1, days.length - 1)], name: l.name });`)));
  if (!when) throw new Error(`the made-up trip has no list "${LIST}"`);
  day = when.day;
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: clockAt(Date.parse(`${day}T17:00:00Z`)) }, S);
  // A reload, not a navigation to the same address: that one moves within the page, and the clock
  // is only set on a new document.
  await cdp.send("Page.reload", { ignoreCache: true }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `document.querySelector("#view .ag-day") ? 1 : 0`, { label: "the Itinerary", timeout: 30000 });
  await sleep(1000);
  const at = JSON.parse(await evalIn(cdp, S, STORE(`return JSON.stringify(store.packDay(${L}));`)));
  check(`made up: the page's clock on ${day}, a day "${when.name}" is packed for`, at.day === day && at.open, JSON.stringify(at));
  found = await evalIn(cdp, S, ONLIST);
  const c0 = counts(JSON.parse(await evalIn(cdp, S, BAND)));

  // 1. Three more of the host's own things put on the list, in its first bag.
  placed = JSON.parse(await evalIn(cdp, S, STORE(`const me = store.me(), l = store.packLists().find((x) => x.key === ${L});
    const free = store.packing(me.id).filter((it) => !store.packBag(it.id, l.key)).slice(0, 3);
    for (const it of free) await store.placePacking(it.id, l.key, l.bags[0].key);
    return JSON.stringify(free.map((it) => it.id));`)));
  check("made up: three more of the host's things put on it", placed.length === 3, JSON.stringify(placed));
  const r1 = await until(S, { done: c0.done, of: c0.of + 3 }, 2000);
  check(`1. the band says three more to pack (${c0.of} → ${c0.of + 3}) within 2 s, without leaving the Itinerary`, r1.ok, `${JSON.stringify(r1.last)} after ${r1.ms} ms`);

  // 2. One of them ticked on this phone.
  await evalIn(cdp, S, STORE(`await store.tickPacking(${JSON.stringify(placed[0])}, ${L}, ${JSON.stringify(day)}, true); return 1;`));
  const r2 = await until(S, { done: c0.done + 1, of: c0.of + 3 }, 2000);
  check("2. one ticked here: one more packed, within 2 s", r2.ok, `${JSON.stringify(r2.last)} after ${r2.ms} ms`);

  // 3. Another phone: a second page, the same person, its own store and the same clock.
  await waitFor(cdp, S, STORE(`return store.pending() === 0 ? 1 : 0;`), { label: "this phone's changes sent", timeout: 15000 });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: S2 } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  other = { targetId, S2 };
  await cdp.send("Page.enable", {}, S2);
  await cdp.send("Runtime.enable", {}, S2);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: clockAt(Date.parse(`${day}T17:00:00Z`)) }, S2);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S2);
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/pack")}` }, S2);
  await appSettled(cdp, S2);
  await waitFor(cdp, S2, STORE(`return store.packBag(${JSON.stringify(placed[1])}, ${L}) ? 1 : 0;`), { label: "the other phone has the list", timeout: 30000 });
  await evalIn(cdp, S2, STORE(`await store.tickPacking(${JSON.stringify(placed[1])}, ${L}, ${JSON.stringify(day)}, true); return 1;`));
  await waitFor(cdp, S2, STORE(`return store.pending() === 0 ? 1 : 0;`), { label: "the other phone's tick sent", timeout: 15000 });
  const r3 = await until(S, { done: c0.done + 2, of: c0.of + 3 }, 120000);
  check("3. ticked on another phone: one more packed here when it arrives (the time after it was sent)", r3.ok, `${JSON.stringify(r3.last)} after ${r3.ms} ms`);
  const route = await evalIn(cdp, S, `document.getElementById("view").dataset.route`);
  check("and the Itinerary was never left", route === "agenda", route);
  check("no exception reached the page", b.pageErrors.length === 0, b.pageErrors.join(" | ") || "clean");
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  if (other) await cdp.send("Target.closeTarget", { targetId: other.targetId }).catch(() => {});
  // 4. Take back what this run did: the ticks, then the three placements; then the list as found.
  if (placed.length && day) {
    try {
      await evalIn(cdp, S, STORE(`for (const id of ${JSON.stringify(placed)}) { if (store.packTicked(id, ${L}, ${JSON.stringify(day)})) await store.tickPacking(id, ${L}, ${JSON.stringify(day)}, false); }
        for (const id of ${JSON.stringify(placed)}) await store.placePacking(id, ${L}, null); return 1;`));
      await waitFor(cdp, S, STORE(`return store.pending() === 0 ? 1 : 0;`), { label: "the clean-up sent", timeout: 15000 });
      const now = await evalIn(cdp, S, ONLIST);
      check("4. what it did is taken back: the list is as it was found", now === found, `found ${found}, now ${now}`);
    } catch (e) { fail++; failures.push("4. taken back"); console.log(`  FAIL  could not take back what this run did: ${e.message}`); }
  }
  await b.done();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/* The Agenda opened on a day of the trip says that day (public/js/agenda.js placeInitial):
 * today's header at the top under the strip, the ring on today, nothing of another day above it,
 * and the live moment or what's next in view. The same for the day the placement lands on after
 * the trip (the last day).
 *
 *   node scripts/gate.mjs --only agenda_today_check
 *
 * The made-up trip, its host's phone, the page's clock moved to an hour of a day (a cold open:
 * a new document), at 390 and 320. Hours across the day: before its first plan, mid-morning,
 * midday, evening, late at night.
 *
 * A plan running over midnight (the made-up trip's night bus) is carried onto the next day: at 00:30
 * that day's first screen shows "Still going: …" with when it arrives, today ringed; at 03:00, once
 * arrived, the line says when it ran.
 *
 * PLANTED: the placement on the live moment or what's next without today's header (the old
 * placeInitial): "the ring is on today" fails in the morning.
 */
import { BASE, appSettled, boot, evalIn, signInAs, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { TRIP, HOST } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const at = (day, hour, minute, zone) => {
  for (let h = -24; h < 48; h++) {
    const t = Date.parse(`${day}T00:00:00Z`) + h * 3600000;
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
    const g = (k) => p.find((x) => x.type === k).value;
    if (`${g("year")}-${g("month")}-${g("day")}` === day && +g("hour") === hour) return t + minute * 60000;
  }
  throw new Error(`no ${hour}:00 on ${day}`);
};

// What the top of the Agenda says: the ringed pill, the pinned header, the day whose header is the
// first under the strip, and how far below the strip it stands (0..few px when it is at the top;
// negative when it is above, under the strip).
const READ = `JSON.stringify((() => {
  const v = document.querySelector("#view"), strip = document.querySelector(".ag-strip");
  const line = strip ? strip.getBoundingClientRect().bottom : v.getBoundingClientRect().top;
  const lit = (document.querySelector(".ag-pill[aria-current]") || { dataset: {} }).dataset.jump || "";
  const pinned = [...document.querySelectorAll('.ag-dayhead[data-pinned="1"]')].map((h) => h.closest(".ag-day").dataset.day);
  const days = [...document.querySelectorAll(".ag-day")].map((d) => ({ day: d.dataset.day, top: Math.round(d.getBoundingClientRect().top - line), bottom: Math.round(d.getBoundingClientRect().bottom - line) }));
  const showing = days.filter((d) => d.bottom > 2 && d.top < v.getBoundingClientRect().bottom - line);
  const live = document.querySelector('.ag-rail-live, .ag-slot[data-live="1"], .ag-slot[data-next="1"]');
  const lr = live ? live.getBoundingClientRect() : null;
  return { lit, pinned, first: showing[0] ? showing[0].day : "", firstTop: showing[0] ? showing[0].top : null,
    liveDay: live ? live.closest(".ag-day").dataset.day : "", liveInView: !!lr && lr.top >= line - 1 && lr.top < v.getBoundingClientRect().bottom - 20 };
})())`;

// 390 as an iPhone with a notch (the safe area: 47 above, 34 below), 320 with none: the strip
// sticks lower under a safe area, and a placement that forgot it parked the day under the strip.
for (const [vw, vh, inset] of [[390, 844, true], [320, 640, false]]) {
  section(`opened on a day of the trip (${vw} wide${inset ? ", a phone's safe area" : ""})`);
  const b = await boot({ vw, vh, dsf: 1 });
  const { cdp, S } = b;
  try {
    if (inset) await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });
    await signInAs(cdp, S, HOST.id);
    const page = (e) => evalIn(cdp, S, e);
    await cdp.send("Page.navigate", { url: `${BASE}/t/${TRIP}/#/` }, S);
    await appSettled(cdp, S);
    const trip = JSON.parse(await page(`fetch("/api/trips/${TRIP}").then((r) => r.json()).then((j) => JSON.stringify(j.trip))`));
    const dayN = (n) => { const d = new Date(`${trip.starts_on}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    let clockId = null;
    const cases = [];
    for (const n of [2, 5, 8]) for (const [h, m] of [[6, 30], [8, 30], [11, 0], [14, 0], [19, 30], [23, 30]]) cases.push([dayN(n), h, m]);
    cases.push([dayN(13), 10, 0]);                              // after the trip: the last day
    // A plan that runs over midnight (the made-up trip's night bus): the day after, at 00:30 while
    // it is still going and at 03:00 once it has arrived.
    const ev = JSON.parse(await page(`fetch("/api/trips/${TRIP}").then((r) => r.json()).then((j) => JSON.stringify(j.events))`));
    const dk = (s, z) => new Intl.DateTimeFormat("en-CA", { timeZone: z || trip.default_tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(s * 1000));
    const night = ev.find((e) => e.ends_at && !e.all_day && e.kind !== "lodging" && dk(e.starts_at, e.tz) !== dk(e.ends_at, e.end_tz || e.tz)
      && dk(e.starts_at, e.tz) >= trip.starts_on && dk(e.ends_at, e.end_tz || e.tz) <= trip.ends_on);
    check("the made-up trip has a plan that runs over midnight", !!night, night ? `${night.title}` : "none");
    const nightDay = night ? dk(night.ends_at, night.end_tz || night.tz) : null;
    if (night) { cases.push([nightDay, 0, 30, night]); cases.push([nightDay, 3, 0, night]); }
    for (const [day, h, m, carried] of cases) {
      if (clockId) await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: clockId }, S);
      const t = at(day, h, m, trip.default_tz);
      clockId = (await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const Real = Date, off = ${t} - Real.now();
        class Moved extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + off); } static now() { return Real.now() + off; } } window.Date = Moved; })()` }, S)).identifier;
      await cdp.send("Page.navigate", { url: "about:blank" }, S);
      await sleep(120);
      await cdp.send("Page.navigate", { url: `${BASE}/t/${TRIP}/#/` }, S);
      await appSettled(cdp, S);
      await waitFor(cdp, S, `document.querySelector(".ag-day") && document.querySelector(".ag-pill[aria-current]") ? 1 : 0`, { label: "the Agenda" });
      await sleep(900);
      const r = JSON.parse(await page(READ));
      const want = day > trip.ends_on ? trip.ends_on : day;
      const label = `${day} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      // Today's header at the top, or the list further into today with today's header pinned:
      // either way the first day showing is today, it is the ringed one, and no header pinned
      // names another day.
      const ok = r.lit === want && r.pinned.every((p) => p === want) && r.first === want && (r.firstTop >= -4 || r.pinned.includes(want));
      check(`${label}: the ring and the header say ${want}, and no other day shows above it${r.liveDay === want ? ", the live moment or what's next in view" : ""}`,
        ok && (r.liveDay !== want || r.liveInView), JSON.stringify(r));
      if (carried) {
        const band = JSON.parse(await page(`JSON.stringify((() => { const w = document.querySelector('.ag-day[data-day="${want}"] [data-k="g:${carried.id}"]'); if (!w) return null;
          const a = w.querySelector("a"), r = a.getBoundingClientRect(), v = document.querySelector("#view").getBoundingClientRect();
          const head = document.querySelector('.ag-day[data-day="${want}"] .ag-dayhead').getBoundingClientRect();
          // On screen means below the day's header (pinned or not) and above the screen's foot: not under the sticky bars.
          return { name: a.querySelector(".ag-stay-name").textContent, meta: a.querySelector(".ag-stay-meta").textContent, href: a.getAttribute("href"), inView: r.top >= head.bottom - 1 && r.bottom <= v.bottom, top: Math.round(r.top), head: Math.round(head.bottom) }; })())`));
        const going = h === 0;
        check(`${label}: the plan from the night before is on the first screen, ${going ? "still going, on screen" : "arrived, at the top of the day"}, and opens the plan`,
          !!band && (band.inView || !going) && band.href === `#/e/${encodeURIComponent(carried.id)}` && (going ? band.name.startsWith("Still going: ") && /^Arrives \d\d:\d\d$/.test(band.meta) : !band.name.startsWith("Still going") && /^From \w+ \d\d:\d\d · arrives \d\d:\d\d$/.test(band.meta)),
          JSON.stringify(band));
      }
    }
    if (clockId) await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: clockId }, S);
    check("no page error", b.pageErrors.length === 0, b.pageErrors.join(" | ").slice(0, 300));
  } finally { await b.done(); }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

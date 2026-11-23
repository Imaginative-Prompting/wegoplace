#!/usr/bin/env node
/* Where the Agenda is when a person chooses a day, and when they come back to it
 * (public/js/agenda.js: the spy's `chosen` day, `readDays`).
 *
 *   node scripts/gate.mjs --only agenda_place_check
 *
 * WHAT IT PROVES
 *   1. A day chosen by its pill keeps the ring, and is in view, until the person's own hand moves
 *      the list: on a trip whose LAST day is one line (too short to reach the top: the list has no empty
 *      room at its foot, so that day stands as high as the list's end lets it, its header in view), and on one
 *      whose FIRST day is one line, at 390 and 320. The scroll the tap made doesn't take it back,
 *      nor does a repaint (a plan added on another phone); a wheel on the list does.
 *   2. Coming back to the Agenda from another section (Places; Changes, behind Other), within
 *      minutes, returns to the day being read. Half an hour later, or past midnight in the trip's zone, it lands on now or next, as
 *      a first visit does. The page's clock is moved WHILE IT RUNS (no reload), so the Agenda's
 *      memory of the day is the one the person had.
 *
 * PLANTED, each red here when put in public/js/agenda.js by hand (and taken out again):
 *   - the spy not yielding to a chosen day: 1's "the last day keeps the ring" fails;
 *   - the day read not remembered on leaving: 2's "within minutes" fails;
 *   - no half-hour limit: 2's "half an hour later" fails.
 *
 * Its two short trips are made through the routes and deleted at the end, each by the id it
 * was given; on the made-up trip it changes nothing.
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

async function phone(vw, vh) {
  const b = await boot({ vw, vh, dsf: 1 });
  const { cdp, S } = b;
  await signInAs(cdp, S, HOST.id);
  const page = (expr) => evalIn(cdp, S, expr);
  let clockId = null;
  const me = {
    b, cdp, S, page,
    api: (method, p, body) => page(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, credentials: "same-origin",
      headers: { "Content-Type": "application/json" }${body === undefined ? "" : `, body: ${JSON.stringify(JSON.stringify(body))}`} })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`),
    async clock(ms) {
      if (clockId) await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: clockId }, S);
      clockId = null;
      if (ms == null) return;
      const r = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
        const Real = Date, off = ${Math.round(ms)} - Real.now();
        class Moved extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + off); } static now() { return Real.now() + off; } }
        window.Date = Moved;
      })()` }, S);
      clockId = r.identifier;
    },
    // The clock moved on by `ms` in the running page: nothing reloads, so what the page holds
    // in memory stays.
    later: (ms) => page(`(() => { const Base = window.Date, off = ${Math.round(ms)};
      class Later extends Base { constructor(...a) { if (a.length) super(...a); else super(Base.now() + off); } static now() { return Base.now() + off; } }
      window.Date = Later; return 1; })()`),
    async open(trip, hash = "#/") {
      await cdp.send("Page.navigate", { url: "about:blank" }, S);
      await sleep(150);
      await cdp.send("Page.navigate", { url: `${BASE}/t/${trip}/${hash}` }, S);
      await appSettled(cdp, S);
      await waitFor(cdp, S, `document.querySelector(".ag-day") && document.querySelector(".ag-pill[aria-current]") ? 1 : 0`, { label: "the Agenda" });
      await sleep(600);
    },
    lit: () => page(`(document.querySelector(".ag-pill[aria-current]") || { dataset: {} }).dataset.jump || ""`),
    // Where a day's heading is: on screen under the strip, and how far down.
    where: (day) => page(`(() => { const v = document.querySelector("#view"), d = document.querySelector('.ag-day[data-day="${day}"]'), s = document.querySelector(".ag-strip");
      if (!d) return null; const r = d.getBoundingClientRect(), vr = v.getBoundingClientRect();
      return { top: Math.round(r.top - (s ? s.getBoundingClientRect().bottom : vr.top)), inView: r.top < vr.bottom - 40 && r.bottom > (s ? s.getBoundingClientRect().bottom : vr.top) }; })()`),
    // The first day showing under the strip: the day placed at the top shows no other day above it.
    firstShowing: () => page(`(() => { const s = document.querySelector(".ag-strip"), v = document.querySelector("#view"); const line = s ? s.getBoundingClientRect().bottom : v.getBoundingClientRect().top;
      const d = [...document.querySelectorAll(".ag-day")].find((x) => x.getBoundingClientRect().bottom > line + 2); return d ? d.dataset.day : ""; })()`),
    pill: async (day) => { await page(`(document.querySelector('.ag-pill[data-jump="${day}"]').click(), 1)`); await sleep(900); },
    // A person's own hand on the list: a wheel over it, and the list moving with it.
    async wheel(dy) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(vw / 2), y: Math.round(vh * 0.6), deltaX: 0, deltaY: dy }, S);
      await sleep(700);
    },
    async section(tab) {
      const ok = await page(`(() => { const t = document.querySelector('.tabbar .tab[data-tab="${tab}"]'); if (t) { t.click(); return 1; } location.hash = ${JSON.stringify(tab === "agenda" ? "#/" : `#/${tab}`)}; return 2; })()`);
      if (tab === "agenda") await waitFor(cdp, S, `document.querySelector(".ag-day") && document.querySelector(".ag-pill[aria-current]") ? 1 : 0`, { label: "back on the Agenda" });
      else await waitFor(cdp, S, `!document.querySelector(".ag-day") ? 1 : 0`, { label: `on ${tab}` });
      await sleep(700);
      return ok;
    },
  };
  return me;
}

const made = [];                 // [id, name] of the trips this check made
const at = (day, hour, zone) => {
  for (let h = -24; h < 48; h++) {
    const t = Date.parse(`${day}T00:00:00Z`) + h * 3600000;
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
    const g = (k) => p.find((x) => x.type === k).value;
    if (`${g("year")}-${g("month")}-${g("day")}` === day && +g("hour") === hour) return t;
  }
  throw new Error(`no ${hour}:00 on ${day} in ${zone}`);
};
const ZONE = "Europe/Lisbon";
// A trip of three days in 2027: one of them with ONE line, the others full.
async function shortTrip(P, which) {
  const id = `agenda-place-${which}-${Date.now().toString(36)}`;
  const name = `Agenda place ${which} (a made-up trip)`;
  const r = await P.api("POST", "/api/trips", { id, name, default_tz: ZONE, starts_on: "2027-09-06", ends_on: "2027-09-08" });
  if (r.status !== 201 && r.status !== 200) throw new Error(`making ${name}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  made.push([id, name]);
  const days = ["2027-09-06", "2027-09-07", "2027-09-08"];
  const short = which === "last" ? 2 : 0;
  let n = 0;
  for (let d = 0; d < 3; d++) {
    const hours = d === short ? [9] : [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    for (const h of hours) {
      n += 1;
      const e = await P.api("POST", `/api/trips/${id}/events`, { id: `ap-${n}`, kind: "plan", title: d === short ? "The one thing that day" : `Plan ${n}`,
        starts_at: Math.floor(at(days[d], h, ZONE) / 1000), tz: ZONE });
      if (e.status !== 201 && e.status !== 200) throw new Error(`a plan on ${name}: ${e.status} ${JSON.stringify(e.body).slice(0, 160)}`);
    }
  }
  return { id, days };
}

let P = null;
try {
  // ── 1. a day chosen by its pill ─────────────────────────────────────────────────────────
  for (const [vw, vh] of [[390, 844], [320, 640]]) {
    section(`1. a day chosen by its pill keeps the ring until the hand moves the list (${vw} wide)`);
    P = await phone(vw, vh);
    for (const which of ["last", "first"]) {
      const t = await shortTrip(P, which);
      await P.clock(at("2027-08-01", 10, ZONE));          // before the trip: the Agenda opens at its top
      await P.open(t.id);
      const target = which === "last" ? t.days[2] : t.days[1];
      await P.pill(target);
      const right = { lit: await P.lit(), where: await P.where(target) };
      check(`${which} day short: the tapped day (${target}) is lit and in view after the scroll the tap made`, right.lit === target && !!right.where && right.where.inView, JSON.stringify(right));
      const above = await P.firstShowing();
      const atEnd = String(await P.page(`(() => { const v = document.getElementById("view"); return v.scrollTop >= v.scrollHeight - v.clientHeight - 2; })()`)) === "true";
      // A day that can't reach the top (the list keeps no empty room at its foot: 20 Nov) stands as high as the list's end lets it.
      check("…at the top under the strip, or, too short to reach it, as high as the list's end lets it", above === target || atEnd && right.where.top >= 0, JSON.stringify({ above, atEnd, top: right.where.top }));
      await sleep(1500);
      check("…and still lit a moment later (the spy didn't take it back)", (await P.lit()) === target, await P.lit());
      // A repaint: a plan added on another phone, heard by this one.
      const e = await P.api("POST", `/api/trips/${t.id}/events`, { id: `ap-late-${which}`, kind: "plan", title: "Added on another phone", starts_at: Math.floor(at(t.days[0], 21, ZONE) / 1000), tz: ZONE });
      await P.page(`import("/js/store.js").then(async ({ store }) => { await store.refresh(); return 1; })`);
      await sleep(1200);
      check("…and a repaint doesn't take it either", e.status < 300 && (await P.lit()) === target, `${e.status} ${await P.lit()}`);
      if (which === "first") {
        await P.pill(t.days[0]);
        check("the short first day, chosen, is lit too", (await P.lit()) === t.days[0], await P.lit());
        await P.pill(target);
      }
      // The hand on the list: the spy reads the list again.
      await P.wheel(which === "last" ? -2600 : 900);
      const after = await P.lit();
      check("a wheel on the list lets the chosen day go: the ring follows the list again", after !== "" && (which === "last" ? after !== target : true) && (await P.where(after)).inView, `${after}`);
    }
    await P.b.done(); P = null;
  }

  // ── 2. coming back ──────────────────────────────────────────────────────────────────────
  section("2. coming back from another section: the day being read, within limits");
  P = await phone(390, 844);
  const snap = (await P.api("GET", `/api/trips/${TRIP}`)).body;
  const trip = snap.trip;
  const day = (n) => { const d = new Date(`${trip.starts_on}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const today = day(4), read = day(8), next = day(5);
  const nowOrNext = (lit) => lit === today || lit === next;
  // a. within minutes
  await P.clock(at(today, 10, trip.default_tz));
  await P.open(TRIP);
  const first = await P.lit();
  check(`a first visit during the trip lands on now or next (${today})`, nowOrNext(first), first);
  await P.pill(read);
  await P.section("places");
  await P.later(5 * 60 * 1000);
  await P.section("agenda");
  const back = { lit: await P.lit(), where: await P.where(read) };
  check(`back from Places five minutes later: the day being read (${read}), in view`, back.lit === read && !!back.where && back.where.inView, JSON.stringify(back));
  // a2. by way of Changes (the screen behind Other, where an undo is), back by the Agenda's tab
  await P.page(`(location.hash = "#/changes", 1)`);
  await waitFor(P.cdp, P.S, `!document.querySelector(".ag-day") ? 1 : 0`, { label: "on Changes" });
  await sleep(700);
  await P.later(2 * 60 * 1000);
  await P.section("agenda");
  const viaChanges = { lit: await P.lit(), where: await P.where(read) };
  check(`back from Changes two minutes later: the day being read (${read}), not the top`, viaChanges.lit === read && !!viaChanges.where && viaChanges.where.inView, JSON.stringify(viaChanges));
  // b. half an hour later
  await P.section("places");
  await P.later(31 * 60 * 1000);
  await P.section("agenda");
  const late = await P.lit();
  check("back half an hour after leaving: now or next again, as a first visit", nowOrNext(late) && late !== read, late);
  // c. past midnight in the trip's zone (left at 23:50, back at 00:05)
  await P.clock(at(today, 23, trip.default_tz) + 50 * 60 * 1000);
  await P.open(TRIP);
  await P.pill(read);
  await P.section("places");
  await P.later(15 * 60 * 1000);
  await P.section("agenda");
  const morning = await P.lit();
  check("back fifteen minutes later but past midnight there: now or next, not the day read yesterday", morning !== read && morning !== "", morning);
  check("no page error", P.b.pageErrors.length === 0, P.b.pageErrors.join(" | ").slice(0, 300));
} catch (e) {
  fail++;
  failures.push(`the check stopped: ${e.message}`);
  console.log(`  FAIL  the check stopped: ${e.stack || e.message}`);
} finally {
  try {
    if (!P) P = await phone(390, 844);
    for (const [id, name] of made) {
      const r = await P.api("DELETE", `/api/trips/${id}`, { confirm: name });
      if (r.status >= 300) console.log(`  note  couldn't delete ${id}: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    }
    const left = ((await P.api("GET", "/api/trips")).body?.trips || []).filter((t) => made.some(([id]) => id === t.id)).length;
    check("the trips it made are gone", left === 0, `${left} left`);
    await P.clock(null);
  } catch (e) { check("the trips it made are gone", false, e.message); }
  if (P) await P.b.done();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

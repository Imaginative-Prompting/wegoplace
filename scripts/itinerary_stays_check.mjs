#!/usr/bin/env node
/* THE ITINERARY'S STAYS AND DISTANCES (agenda.js stayWords, the day's rows, distHTML), on the gate's made-up trip as
 * its host, in the app window at 440 x 956:
 *
 *   1. A STAY IS NAMED BY WHAT HAPPENS THAT DAY: "Check in · <stay>" on its first day, "Staying at <stay>" on the
 *      days between, "Check out · <stay>" on its last; never "Check in" on a day it doesn't start.
 *   2. A TIMED STAY TAKES ITS PLACE IN THE DAY: on the day it starts it sits among the plans at its check-in time, on
 *      the day it ends at its check-out time (a check-out at the same minute as a plan before it, a check-in after);
 *      on the days between it is at the top of the day, above the plans. Every timed stay of the trip, every day.
 *   3. DISTANCES ONLY NEAR: with the phone in another country (New York, thousands of km from the trip) no plan shows a
 *      distance; with it at one of the trip's places, the plans within 100 km of it show theirs and none farther does.
 *
 *   node scripts/gate.mjs --only itinerary_stays_check
 *
 * PLANTED (ITIN_PLANT=<name>, served in place of public/js/agenda.js):
 *   title  the stay rows named by their titles again: 1 red (1).
 *   top    every stay at the top of its days again: 2 red (2).
 *   far    distances shown however far: 2 red (3: the far phone, and the far plans with the phone near).
 */
import fs from "node:fs";
import { BASE, boot, evalIn, waitFor, sleep, appSettled } from "./lib/standalone_cdp.mjs";
import { tripPath } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

const PLANT = process.env.ITIN_PLANT || "";
const PLANTS = ["title", "top", "far"];
if (PLANT && !PLANTS.includes(PLANT)) throw new Error(`ITIN_PLANT is one of ${PLANTS.join(", ")}`);
const PLANTED = PLANT ? (() => {
  const src = fs.readFileSync(new URL("../public/js/agenda.js", import.meta.url), "utf8");
  const t = PLANT === "title" ? src.replace("const e = s.e, ez = endZone(e), name = stayName(e, place);", "const e = s.e, ez = endZone(e), name = e.title;")
      .replace("return { name: `Check in · ${name}`,", "return { name,").replace("return { name: `Check out · ${name}`,", "return { name,").replace("return { name: `Staying at ${name}`,", "return { name,")
    : PLANT === "top" ? src.replace("const timedHere = (s) => !s.e.all_day && (s.startsHere || s.endsHere);", "const timedHere = () => false;")
    : src.replace("if (!Number.isFinite(m) || m > NEAR_M) return \"\";", "if (!Number.isFinite(m)) return \"\";");
  if (t === src) throw new Error(`the ${PLANT} plant didn't take`);
  return t;
})() : null;

const b = await boot({ vw: 440, vh: 956, dsf: 2, reduceMotion: true });
const { cdp, S } = b;
await b.setInsets({ top: 59, right: 0, bottom: 34, left: 0 });
const J = async (e) => JSON.parse(await evalIn(cdp, S, e));
if (PLANTED) {
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(PLANTED).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/agenda.js*" }] }, S);
}
// The phone somewhere: the fix the app reads, the cached one forgotten, the Itinerary drawn again from a new document.
async function phoneAt(lat, lng) {
  await cdp.send("Browser.grantPermissions", { origin: new URL(BASE).origin, permissions: ["geolocation"] });
  await cdp.send("Emulation.setGeolocationOverride", { latitude: lat, longitude: lng, accuracy: 20 }, S);
  await evalIn(cdp, S, `import("/js/util.js").then((u) => { u.clearPosition(); return 1; })`);
  await cdp.send("Page.reload", { ignoreCache: true }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `document.querySelector("#view .ag-day .ag-list") ? 1 : 0`, { label: "the Itinerary", timeout: 30000 });
  await waitFor(cdp, S, `import("/js/util.js").then((u) => { const p = u.lastPosition(); return p && Math.abs(p.lat - ${lat}) < 1e-6 ? 1 : 0; })`, { label: "the phone's fix", timeout: 15000 });
  await sleep(700);
}
// Every row of the Itinerary that opens a plan, with that plan's distance from the fix (straight line) and whether it
// shows one. A plan carried over from the night before never shows one, and is left out.
const DISTANCES = `import("/js/store.js").then(async ({ store }) => {
  const { haversine, lastPosition } = await import("/js/util.js");
  const pos = lastPosition(), out = [];
  for (const r of document.querySelectorAll("#view .ag-slot, #view .ag-stay:not(.ag-pk):not(.ag-carried)")) {
    const a = r.matches("a") ? r : r.querySelector("a[href^='#/e/']");
    const id = decodeURIComponent(((a && a.getAttribute("href")) || "").replace("#/e/", ""));
    const e = store.events().find((x) => x.id === id), p = e && e.place_id ? store.place(e.place_id) : null;
    if (!p || !(Math.abs(+p.lat) > 0.01 || Math.abs(+p.lng) > 0.01)) continue;
    out.push({ title: e.title, m: Math.round(haversine(pos, { lat: +p.lat, lng: +p.lng })), shows: !!r.querySelector(".ag-dist") });
  }
  return JSON.stringify(out);
})`;

try {
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/")}` }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `document.querySelector("#view .ag-day .ag-list") ? 1 : 0`, { label: "the Itinerary", timeout: 30000 });

  // The trip's timed stays, each day they cover, and every row of those days, from the page.
  const seen = await J(`import("/js/store.js").then(async ({ store }) => {
    const { dayKey, toMs } = await import("/js/util.js");
    const ms = (t) => toMs(t);
    const stays = store.events().filter((e) => e.kind === "lodging" && e.ends_at && !e.all_day).map((e) => ({ id: e.id, title: e.title,
      first: dayKey(e.starts_at, e.tz), last: dayKey(e.ends_at, e.end_tz || e.tz), in: ms(e.starts_at), out: ms(e.ends_at) }));
    const days = [...document.querySelectorAll("#view .ag-day")].map((d) => ({ day: d.dataset.day,
      top: [...d.querySelectorAll(".ag-stays > [data-k^='s:']")].map((n) => ({ id: n.dataset.k.slice(2), name: n.querySelector(".ag-stay-name").textContent })),
      list: [...d.querySelectorAll(".ag-list > *")].map((n) => {
        const k = n.dataset.k || "";
        if (k.startsWith("s:")) return { stay: k.slice(2), name: n.querySelector(".ag-stay-name").textContent };
        if (k.startsWith("c:")) { const e = store.events().find((x) => x.id === k.slice(2)); return { card: k.slice(2), at: e ? ms(e.starts_at) : null }; }
        return { other: n.className.split(" ")[0] };
      }) }));
    return JSON.stringify({ stays, days });
  })`);
  const byDay = new Map(seen.days.map((d) => [d.day, d]));
  check(`the made-up trip has timed stays to read (${seen.stays.length}), over several days`, seen.stays.length >= 3, seen.stays.map((s) => `${s.title} ${s.first}..${s.last}`).join(" | "));

  section("1. A stay is named by what happens that day");
  {
    const wrong = [];
    for (const d of seen.days) {
      for (const r of [...d.top, ...d.list.filter((x) => x.stay).map((x) => ({ id: x.stay, name: x.name }))]) {
        const s = seen.stays.find((x) => x.id === r.id);
        if (!s) continue;
        const want = d.day === s.first && d.day === s.last ? null : d.day === s.first ? /^Check in · \S/ : d.day === s.last ? /^Check out · \S/ : /^Staying at \S/;
        if (want && !want.test(r.name)) wrong.push(`${d.day}: "${r.name}"`);
        if (d.day !== s.first && /^Check in/.test(r.name)) wrong.push(`${d.day}: "${r.name}" (not its first day)`);
      }
    }
    check("every stay row says Check in on its first day, Staying at between, Check out on its last", !wrong.length, wrong.slice(0, 6).join(" | ") || `${seen.days.length} days read`);
  }

  section("2. A timed stay takes its place in the day");
  {
    const wrong = [];
    let placedCount = 0, topCount = 0;
    for (const s of seen.stays) {
      for (const d of seen.days) {
        if (d.day < s.first || d.day > s.last) continue;
        const atEnds = d.day === s.first || d.day === s.last;
        const i = d.list.findIndex((x) => x.stay === s.id);
        if (!atEnds) {
          if (!d.top.some((x) => x.id === s.id) || i >= 0) wrong.push(`${s.title} on ${d.day}: not at the top`);
          else topCount++;
          continue;
        }
        if (i < 0) { wrong.push(`${s.title} on ${d.day}: not among the plans`); continue; }
        placedCount++;
        const at = d.day === s.first ? s.in : s.out, leaving = d.day !== s.first;
        const cards = d.list.map((x, j) => ({ ...x, j })).filter((x) => x.card);
        const late = cards.filter((c) => c.j < i && (leaving ? c.at >= at : c.at > at));
        const early = cards.filter((c) => c.j > i && (leaving ? c.at < at : c.at <= at));
        if (late.length || early.length) wrong.push(`${s.title} on ${d.day}: ${late.length} later plan(s) above it, ${early.length} earlier below`);
      }
    }
    check(`every timed stay sits at its check-in on its first day and its check-out on its last (${placedCount}), at the top between (${topCount})`,
      !wrong.length && placedCount >= 4, wrong.slice(0, 6).join(" | "));
    // The case from the trip itself: checking in at 15:00 comes after a plan earlier that day.
    const first = seen.stays[0], fd = byDay.get(first.first);
    const iStay = fd.list.findIndex((x) => x.stay === first.id), iEarlier = fd.list.findIndex((x) => x.card && x.at < first.in);
    check(`"${first.title}": its check-in is below the day's earlier plan`, iEarlier >= 0 && iStay > iEarlier, JSON.stringify({ iEarlier, iStay }));
  }

  section("3. Distances only near");
  await phoneAt(40.7128, -74.006);
  const far = await J(DISTANCES);
  check(`the phone in New York: none of the ${far.length} plans with a place shows a distance`, far.length >= 20 && far.every((r) => !r.shows), far.filter((r) => r.shows).slice(0, 4).map((r) => `${r.title} ${r.m} m`).join(" | "));
  const near = await J(`import("/js/store.js").then(({ store }) => { const e = store.events().find((x) => x.place_id && x.kind === "meal"); const p = store.place(e.place_id); return JSON.stringify({ lat: +p.lat, lng: +p.lng }); })`);
  await phoneAt(near.lat, near.lng);
  const here = await J(DISTANCES);
  const within = here.filter((r) => r.m <= 100000), beyond = here.filter((r) => r.m > 100000);
  check(`the phone at one of the trip's places: the ${within.length} plans within 100 km show theirs, the ${beyond.length} farther show none`,
    within.length >= 5 && beyond.length >= 5 && within.every((r) => r.shows) && beyond.every((r) => !r.shows),
    [...within.filter((r) => !r.shows), ...beyond.filter((r) => r.shows)].slice(0, 4).map((r) => `${r.title} ${r.m} m ${r.shows}`).join(" | "));

  check("no page errors", !b.pageErrors.length, b.pageErrors.join(" | ").slice(0, 300));
} finally {
  await cdp.send("Emulation.clearGeolocationOverride", {}, S).catch(() => {});
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }

#!/usr/bin/env node
/* A trip under way before its first plan (public/js/agenda.js buildModel's phase): a trip whose days
 * began two days ago and whose first plan is tomorrow is under way. Opened cold, the Agenda says
 * nothing of "Not yet" or "Leaving today", and its first screen is today: today's header at the top
 * under the strip (or, with too little after it to reach the top, as high as the list's end lets it: the
 * list keeps no empty room at its foot), the ring on today, tomorrow's plan as what's next. On its first day, before its
 * first plan, it still says "Leaving today".
 *
 * A stranger's walk found it (16 Nov): on the third day of a trip made by hand, with breakfast the
 * first plan, the head said "Not yet · Leaving today" and the Agenda opened on the trip's first day.
 *
 *   node scripts/gate.mjs --only agenda_started_check
 *
 * And THE TRIP'S NAME heads the Agenda (a stranger's walk: nowhere did the first screen say which trip
 * it was): over the strip, sticking with it, on the first screen at both sizes, with today still at the
 * top under the strip; above "No plans yet" on a trip with none.
 *
 * Its own server, one made-up person, the real clock (the trip's days are set around today, in UTC).
 *
 * PLANTED (red when put in by hand): the phase from the plans alone (agenda.js, `onItsDays` false):
 * the head says "Leaving today" and the first screen is the trip's first day; the trip's name never
 * put in the shell (agenda.js ensureShell without titleEl).
 */
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { openChrome } from "../checks/lib/chrome.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import fs from "node:fs";
import path from "node:path";

// WGP_SHOTS=<folder>: stills of each Agenda read, light and dark (made-up).
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
async function stills(page, name) {
  if (!SHOTS) return;
  for (const scheme of ["light", "dark"]) {
    await page.scheme(scheme);
    await new Promise((r) => setTimeout(r, 400));
    const { data } = await page.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, `${name}-${scheme}.png`), Buffer.from(data, "base64"));
  }
  await page.scheme("light");
}
// The trip's name over the strip: its words, and whether it stands whole on screen, just above the strip.
const NAME = `JSON.stringify((() => { const n = document.querySelector("#view .ag-tripname"), s = document.querySelector(".ag-strip"); if (!n) return null; const r = n.getBoundingClientRect(), t = s.getBoundingClientRect(); return { words: (n.querySelector(".ag-tripname-t") || n).textContent, top: Math.round(r.top), bottom: Math.round(r.bottom), stripTop: Math.round(t.top), shown: r.height > 0 && r.top >= 0 }; })())`;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (n) => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// What the top of the Agenda says (as agenda_today_check reads it): the head's words, the ringed
// pill, and the first day under the strip with how far below it it stands.
const READ = `JSON.stringify((() => {
  const v = document.querySelector("#view"), strip = document.querySelector(".ag-strip");
  const line = strip ? strip.getBoundingClientRect().bottom : v.getBoundingClientRect().top;
  const lede = (document.querySelector("#view .ag-lede") || {}).innerText || "";
  const lit = (document.querySelector(".ag-pill[aria-current]") || { dataset: {} }).dataset.jump || "";
  const days = [...document.querySelectorAll(".ag-day")].map((d) => ({ day: d.dataset.day, top: Math.round(d.getBoundingClientRect().top - line), bottom: Math.round(d.getBoundingClientRect().bottom - line) }));
  const showing = days.filter((d) => d.bottom > 2 && d.top < v.getBoundingClientRect().bottom - line);
  const next = document.querySelector('.ag-slot[data-next="1"]');
  const today = days.find((d) => d.day === lit);
  return { lede, lit, atEnd: v.scrollTop >= v.scrollHeight - v.clientHeight - 2, litTop: today ? today.top : null, first: showing[0] ? showing[0].day : "", firstTop: showing[0] ? showing[0].top : null, next: next ? next.innerText.replace(/\\s+/g, " ").slice(0, 80) : "" };
})())`;

const server = await startServer({ name: "agenda-started", port: await freeLoopbackPort() });
ownServer(server.origin);
let chrome = null;
try {
  await server.start();
  const ada = new Person(server.origin, "Ada Reyes");
  await ada.signUp();
  const tripOn = async (name, from, to) => {
    const t = await ada.post("/api/trips", { name, default_tz: "UTC", starts_on: from, ends_on: to });
    if (t.status !== 201) throw new Error(`trip: ${t.status} ${t.text}`);
    const id = t.json.trip.id;
    const at = Math.floor(new Date(`${day(1)}T10:00:00Z`).getTime() / 1000);
    const e = await ada.post(`/api/trips/${id}/events`, { id: "ev-tomorrow", title: "Harbour walk", kind: "activity", starts_at: at, tz: "UTC" });
    if (e.status >= 300) throw new Error(`plan: ${e.status} ${e.text}`);
    return id;
  };
  const under = await tripOn("Coast days", day(-2), day(2));       // its third day today
  const first = await tripOn("Porto in November", day(0), day(3));      // its first day today
  const bare = (await ada.post("/api/trips", { name: "Nothing planned yet", default_tz: "UTC", starts_on: day(5), ends_on: day(8) })).json.trip.id;
  check("made up: a trip on its third day and one on its first, each with its first plan tomorrow", !!under && !!first);

  chrome = await openChrome();
  for (const [vw, vh] of [[390, 844], [320, 640]]) {
    const page = await chrome.page({ width: vw, height: vh, mobile: true, passkeys: false });
    await page.setCookie(server.origin, "wgp_session", ada.jar.cookies.get("wgp_session"));
    await page.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: encodeURIComponent(ada.user.id), sameSite: "Lax" });
    await page.goto(`${server.origin}/t/${under}/#/`);
    await page.until(`document.querySelector(".ag-day") && document.querySelector(".ag-pill[aria-current]") ? 1 : 0`, "the Agenda", 20000);
    await sleep(1500);
    const r = JSON.parse(await page.eval(READ));
    check(`${vw}: on its third day the head says nothing of "Not yet" or "Leaving today"`, !/Not yet|Leaving today|days out|Leaves tomorrow|Starts/i.test(r.lede), JSON.stringify(r.lede));
    check(`${vw}: and the first screen is today, ringed, its header at the top under the strip, or as high as the list's end lets it`,
      r.lit === day(0) && (r.first === day(0) && Math.abs(r.firstTop) <= 6 || r.atEnd && r.litTop !== null && r.litTop >= -6 && r.litTop < vh / 2), JSON.stringify(r));
    check(`${vw}: tomorrow's plan is what's next`, /Harbour walk/.test(r.next), r.next);
    const name = JSON.parse(await page.eval(NAME));
    check(`${vw}: the trip's name heads the first screen, just above the strip`, !!name && name.words === "Coast days" && name.shown && Math.abs(name.bottom - name.stripTop) <= 1, JSON.stringify(name));
    await stills(page, `${vw}-agenda-third-day`);
    await page.eval(`(document.querySelector("#view").scrollTop += 500, 1)`);
    await sleep(500);
    const scrolled = JSON.parse(await page.eval(NAME));
    check(`${vw}: and it stays there as the list scrolls`, !!scrolled && scrolled.shown && scrolled.top === name.top && Math.abs(scrolled.bottom - scrolled.stripTop) <= 1, JSON.stringify(scrolled));
    await page.goto(`${server.origin}/t/${first}/#/`);
    await page.until(`document.querySelector(".ag-day") ? 1 : 0`, "the other trip's Agenda", 20000);
    await sleep(1500);
    const f = JSON.parse(await page.eval(READ));
    check(`${vw}: on a trip's first day, before its first plan, it still says "Starts today", and what's first`, /^Starts today\nFirst: Harbour walk, \w{3} \w{3} \d{1,2} at 10:00$/.test(f.lede.trim()), JSON.stringify(f.lede));
    await stills(page, `${vw}-agenda-first-day`);
    await page.goto(`${server.origin}/t/${bare}/#/`);
    await page.until(`document.querySelector("#view .empty") ? 1 : 0`, "the empty Agenda", 20000);
    await sleep(800);
    const empty = await page.eval(`(document.querySelector("#view .ag-tripname-flow") || {}).textContent || ""`);
    check(`${vw}: a trip with no plans: its name over "No plans yet"`, empty === "Nothing planned yet", JSON.stringify(empty));
    await stills(page, `${vw}-agenda-empty`);
    await page.close();
  }
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  await chrome?.close().catch(() => {});
  await server.stop().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

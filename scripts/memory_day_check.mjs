#!/usr/bin/env node
/* A memory's day, the app's side (docs/API.md "When a memory happened"; public/js/memories.js,
 * shared/taken.js): on a server of its own, two made-up people with a phone each.
 *
 *   node scripts/memory_day_check.mjs
 *   <the queue> -- node scripts/memory_day_check.mjs
 *
 * What it holds:
 *   1. FROM THE PHOTOS: a photo whose camera wrote when it was taken (EXIF DateTimeOriginal, no
 *      offset: read in the trip's zone) offers that day in the composer, says so with the time,
 *      and posts day and taken_at; the feed puts it under that day, with the time it was taken
 *      and "posted <day>".
 *   2. A DAY BY HAND: a photo that says nothing says so; a day chosen in the picker is posted as
 *      the day alone (no time invented); the card shows no time.
 *   3. THE ORDER: newest first by when it happened (the server's `at`), the memory posted with
 *      neither on the day it was posted (after the trip): the phone's and the server's the same.
 *   4. CHANGING IT: the poster's card has "When it happened"; another day is a day by hand (its
 *      time goes), the photos' own day keeps their time; the card moves under its new day.
 *   5. SOMEONE ELSE'S: no such button on another person's card, and the server's refusal names why.
 *   6. A TIME THAT CAN'T BE: a camera whose clock says 1985 is said to be wrong in the composer,
 *      before posting, and the memory goes on the day it is posted. A phone whose own clock runs a
 *      month fast takes a photo ten days ahead of the server for the past: the server keeps no time
 *      or day (not_taken), the memory is posted all the same, and the person is told. The picker offers
 *      no day later than two days from now (a trip that runs on past today).
 *   7. No page error on any phone.
 *
 * The photos are made here by ffmpeg (test patterns), each given a made-up camera's Exif time.
 *
 * Stills (WGP_SHOTS=<dir>): WGP_LOOK=<width>x<height>x<scale>:<light|dark> takes them at that size
 * and theme, with an iPhone's safe area (default 390x844x1, the system's theme, none).
 *
 * PLANTED (red when put in by hand):
 *   - memories.js memories() ordering by created_at: section 3 fails.
 *   - memories.js whenOf() answering {}: sections 1 and 2's posts carry no day.
 *   - memories.js without the not_taken words: section 6's "the person is told" fails.
 *   - memories.js dayChoices() without the window: section 6's picker offers December.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import { pickPhotos, cdpPage } from "./lib/photo_picker.mjs";

const FIXDIR = process.env.WGP_FIXTURES || path.join(os.tmpdir(), "wgp-memday-fixtures");
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const LOOK = /^(\d+)x(\d+)x([\d.]+):(light|dark)$/.exec(process.env.WGP_LOOK || "");
const LOOK_NAME = LOOK ? `${LOOK[1]}${LOOK[1] === "278" ? "-text115" : ""}-${LOOK[4]}` : "";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// ── the photos ─────────────────────────────────────────────────────────────────────────────
// A made-up camera's Exif (big-endian TIFF): IFD0 points at an Exif IFD holding DateTimeOriginal.
function exifWith(when) {
  const t = Buffer.alloc(80);
  t.write("MM", 0, "ascii"); t.writeUInt16BE(42, 2); t.writeUInt32BE(8, 4);
  t.writeUInt16BE(1, 8);
  t.writeUInt16BE(0x8769, 10); t.writeUInt16BE(4, 12); t.writeUInt32BE(1, 14); t.writeUInt32BE(26, 18);
  t.writeUInt32BE(0, 22);
  t.writeUInt16BE(1, 26);
  t.writeUInt16BE(0x9003, 28); t.writeUInt16BE(2, 30); t.writeUInt32BE(20, 32); t.writeUInt32BE(44, 36);
  t.writeUInt32BE(0, 40);
  t.write(`${when}\0`, 44, "ascii");
  const body = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), t]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}
function fixtures() {
  fs.mkdirSync(FIXDIR, { recursive: true });
  const plain = path.join(FIXDIR, "plain.jpg");
  if (!fs.existsSync(plain)) {
    try { execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1600x1200:rate=1", "-frames:v", "1", "-q:v", "3", plain], { stdio: ["ignore", "ignore", "inherit"] }); }
    catch (e) { throw new Error(`ffmpeg could not make the photo (${e.code === "ENOENT" ? "ffmpeg is not installed" : e.message}). This check needs ffmpeg.`); }
  }
  const j = fs.readFileSync(plain);
  const timed = (name, when) => { const f = path.join(FIXDIR, name); fs.writeFileSync(f, Buffer.concat([j.subarray(0, 2), exifWith(when), j.subarray(2)])); return f; };
  // Ten days from now, as a camera in Lisbon writes it: ahead of the server, the past to a phone a month fast.
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(Date.now() + 10 * 86400000)).map((x) => [x.type, x.value]));
  return {
    ahead: timed("taken-ten-days-ahead.jpg", `${p.year}:${p.month}:${p.day} ${p.hour}:${p.minute}:${p.second}`),
    may3: timed("taken-may-3.jpg", "2026:05:03 14:05:00"),
    old: timed("taken-1985.jpg", "1985:07:01 10:00:00"),
    plain,
  };
}
const FIX = fixtures();
// The trip is in the past (a photograph's time can't be after it is posted: the server keeps none
// more than two days ahead). 14:05 on 3 May 2026 in Lisbon (WEST, UTC+1): 13:05 UTC.
const MAY3_TAKEN = Date.UTC(2026, 4, 3, 13, 5) / 1000;

const server = await startServer({ name: "memory-day", port: await freeLoopbackPort() });
ownServer(server.origin);

const phones = [];
try {
  await server.start();
  const ana = new Person(server.origin, "Ana Ferreira-Holt"), ben = new Person(server.origin, "Ben Okafor-Lind");
  await ana.signUp(); await ben.signUp();
  const made = await ana.post("/api/trips", { name: "Lake week", default_tz: "Europe/Lisbon", starts_on: "2026-05-01", ends_on: "2026-05-07" });
  const trip = made.json.trip.id, T = `/api/trips/${trip}`;
  const link = await ana.post(`${T}/links`, {});
  const joined = await ben.post(`/api/join/${link.json.link.code}`);
  check("two people on a trip of 1 to 7 May 2026, in Lisbon", made.status === 201 && joined.status < 300, `${made.status} ${joined.status}`);
  const feed = async () => (await ana.get(`${T}/memories?limit=90`)).json.memories;

  const { boot, evalIn, waitFor, appSettled, sleep } = await import("./lib/standalone_cdp.mjs");

  async function phoneOf(person, { clockAheadDays = 0 } = {}) {
    const b = await boot(LOOK ? { vw: +LOOK[1], vh: +LOOK[2], dsf: +LOOK[3] } : { vw: 390, vh: 844, dsf: 1 });
    phones.push(b);
    const { cdp, S } = b;
    if (LOOK) {
      await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 }).catch(() => {});
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: LOOK[4] }, { name: "prefers-reduced-motion", value: "reduce" }] }, S);
    }
    // A phone whose own clock is wrong: every new document's Date runs that far ahead.
    if (clockAheadDays) await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const Real = Date, off = ${clockAheadDays * 86400000};
      class Moved extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + off); } static now() { return Real.now() + off; } } window.Date = Moved; })()` }, S);
    for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: server.origin }, S);
    await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: person.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
    const who = person.jar.cookies.get("wgp_who");
    if (who) await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: who, sameSite: "Lax" }, S);
    await cdp.send("DOM.enable", {}, S);
    const page = (expr) => evalIn(cdp, S, expr);
    const wait = (expr, label, timeout) => waitFor(cdp, S, expr, { label, ...(timeout ? { timeout } : {}) });
    let nav = 0;
    const phone = {
      b, cdp, S, page, wait,
      async memories() {
        await cdp.send("Page.navigate", { url: `${server.origin}/t/${trip}/?n=${++nav}#/memories` }, S);
        await sleep(300);
        await appSettled(cdp, S);
        await wait(`document.querySelector("#view .me-feed") ? 1 : 0`, "the Memories feed", 45000);
        await sleep(300);
      },
      // The composer, a file given to its own input; answers what "When it happened" shows once read.
      async compose(file) {
        await pickPhotos({ ...cdpPage(cdp, S), files: [file] });   // Add photos: the phone's picker first, then the sheet
        await wait(`(() => { const s = document.querySelector(".me-whensay"); return s && s.textContent && !/^Reading/.test(s.textContent) ? 1 : 0; })()`, "when it happened, read");
        return phone.when();
      },
      when: async () => JSON.parse(await page(`JSON.stringify({ value: document.querySelector("#me-day").value, say: document.querySelector(".me-whensay").textContent,
        options: [...document.querySelectorAll("#me-day option")].map((o) => o.value) })`)),
      async choose(sel, value) { await page(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`); },
      async upload(count) {
        await page(`(document.querySelector(".me-go").click(), 1)`);
        await waitFor(cdp, S, `document.querySelectorAll(".me-job").length === 0 && document.querySelectorAll(".me-card").length === ${count} ? 1 : 0`, { timeout: 60000, label: `${count} card(s)` });
      },
      // The feed as it reads: headings and cards in order, each card's time line.
      feedRead: async () => JSON.parse(await page(`JSON.stringify([...document.querySelectorAll(".me-feed > .me-day, .me-feed > .me-card")].map((n) => n.classList.contains("me-day")
        ? { day: n.textContent.trim() } : { id: n.dataset.id, cap: (n.querySelector(".me-cap") || { textContent: "" }).textContent.trim(), when: (n.querySelector(".me-when") || { textContent: "" }).textContent.trim(), dayset: !!n.querySelector(".me-dayset") }))`)),
      look: async (name) => { if (SHOTS) await b.shot(path.join(SHOTS, `${LOOK_NAME ? LOOK_NAME + "-" : "memday-"}${name}.png`)); },
    };
    return phone;
  }
  const A = await phoneOf(ana);
  await A.memories();
  const postedDay = await A.page(`new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Lisbon", weekday: "short", month: "short", day: "numeric" }).formatToParts(new Date()).filter((p) => p.type !== "literal").map((p) => p.value).join(" ")`);

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────────
  section("1. from the photos: the day and the time they were taken");
  let w = await A.compose(FIX.may3);
  check("the composer offers the photo's day, chosen, and says it with the time", w.value === "2026-05-03" && w.say === "From the photos: taken Sun May 3 at 14:05.", JSON.stringify(w));
  check("the picker has the trip's seven days and \"the day it's posted\"", w.options.length === 8 && w.options[0] === "" && w.options[1] === "2026-05-01" && w.options[7] === "2026-05-07", JSON.stringify(w.options));
  await A.look("composer-from-photos");
  await A.page(`(() => { const i = document.querySelector("#me-cap-in"); i.value = "Morning on the water"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await A.upload(1);
  let mem = (await feed()).find((m) => m.caption === "Morning on the water");
  check("posted with its day and the time it was taken", !!mem && mem.day === "2026-05-03" && mem.taken_at === MAY3_TAKEN && mem.at === MAY3_TAKEN, JSON.stringify(mem && { day: mem.day, taken_at: mem.taken_at, at: mem.at }));
  let f = await A.feedRead();
  check("the feed puts it under its day, with the time and when it was posted", f[0].day === "Sun May 3" && f[1].cap === "Morning on the water" && f[1].when === `14:05 · posted ${postedDay}`, JSON.stringify(f));

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────────
  section("2. a day by hand");
  w = await A.compose(FIX.plain);
  check("a photo that says nothing: the day it's posted, said", w.value === "" && /^The photos don't say when they were taken/.test(w.say), JSON.stringify(w));
  await A.choose("#me-day", "2026-05-05");
  w = await A.when();
  check("a day chosen is said to be chosen by hand", w.value === "2026-05-05" && w.say === "Chosen by hand.", JSON.stringify(w));
  await A.look("composer-chosen-by-hand");
  await A.page(`(() => { const i = document.querySelector("#me-cap-in"); i.value = "The long table"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await A.upload(2);
  mem = (await feed()).find((m) => m.caption === "The long table");
  check("posted with the day alone: no time invented", !!mem && mem.day === "2026-05-05" && mem.taken_at === null, JSON.stringify(mem && { day: mem.day, taken_at: mem.taken_at }));
  f = await A.feedRead();
  const card = f.find((x) => x.cap === "The long table");
  check("its card says only when it was posted", !!card && card.when === `posted ${postedDay}`, JSON.stringify(card));

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────────
  section("3. the order: by when it happened");
  w = await A.compose(FIX.plain);
  await A.page(`(() => { const i = document.querySelector("#me-cap-in"); i.value = "Packing up"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await A.upload(3);
  f = await A.feedRead();
  const order = f.map((x) => x.day || x.cap);
  check("the feed: the one posted today (after the trip), then 5 May, then 3 May, each under its day", JSON.stringify(order) === JSON.stringify([postedDay, "Packing up", "Tue May 5", "The long table", "Sun May 3", "Morning on the water"]), JSON.stringify(order));
  const srv = (await feed()).map((m) => m.caption);
  check("the server's feed has the same order", JSON.stringify(srv) === JSON.stringify(["Packing up", "The long table", "Morning on the water"]), JSON.stringify(srv));
  await A.look("feed-by-day");

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────────
  section("4. changing when it happened");
  const idOf = (cap) => f.find((x) => x.cap === cap).id;
  const sheetFor = async (cap) => {
    await A.page(`(document.querySelector('.me-card[data-id="${idOf(cap)}"] .me-dayset').click(), 1)`);
    await A.wait(`document.querySelector("#me-dayedit") ? 1 : 0`, "the day sheet");
  };
  await sheetFor("Morning on the water");
  let say = await A.page(`document.querySelector(".me-daysay").textContent`);
  await A.look("when-it-happened-sheet");
  check("the sheet opens on its day, saying the photos were taken then", (await A.page(`document.querySelector("#me-dayedit").value`)) === "2026-05-03" && say === "The photos were taken that day, at 14:05.", say);
  await A.choose("#me-dayedit", "2026-05-04");
  check("another day is said to be by hand", (await A.page(`document.querySelector(".me-daysay").textContent`)) === "Chosen by hand.");
  await A.page(`(document.querySelector(".me-daysave").click(), 1)`);
  await A.wait(`!document.querySelector("#me-dayedit") ? 1 : 0`, "the sheet closed");
  mem = (await feed()).find((m) => m.caption === "Morning on the water");
  check("on the server: the new day, its time gone (a day by hand)", !!mem && mem.day === "2026-05-04" && mem.taken_at === null, JSON.stringify(mem && { day: mem.day, taken_at: mem.taken_at }));
  await A.wait(`[...document.querySelectorAll(".me-feed > .me-day")].some((h) => h.textContent.trim() === "Mon May 4") ? 1 : 0`, "the card under its new day");
  f = await A.feedRead();
  check("the card moved under Mon May 4", JSON.stringify(f.map((x) => x.day || x.cap)).includes(`"Mon May 4","Morning on the water"`), JSON.stringify(f.map((x) => x.day || x.cap)));
  await sheetFor("Packing up");
  await A.choose("#me-dayedit", "2026-05-06");
  await A.page(`(document.querySelector(".me-daysave").click(), 1)`);
  await A.wait(`!document.querySelector("#me-dayedit") ? 1 : 0`, "the sheet closed");
  mem = (await feed()).find((m) => m.caption === "Packing up");
  check("one posted with no day can be given one", !!mem && mem.day === "2026-05-06", JSON.stringify(mem && { day: mem.day }));

  // ── 5 ──────────────────────────────────────────────────────────────────────────────────────
  section("5. someone else's memory");
  const B = await phoneOf(ben);
  await B.memories();
  await B.wait(`document.querySelectorAll(".me-card").length === 3 ? 1 : 0`, "the three cards on the other phone");
  const fb = await B.feedRead();
  check("another person's cards have no \"When it happened\"", fb.filter((x) => x.id).every((x) => !x.dayset), JSON.stringify(fb.filter((x) => x.id).map((x) => x.dayset)));
  check("the other phone reads the same order", JSON.stringify(fb.map((x) => x.day || x.cap)) === JSON.stringify((await A.feedRead()).map((x) => x.day || x.cap)));
  const refused = await ben.call("PATCH", `${T}/memories/${idOf("The long table")}`, { day: "2026-05-02" });
  check("the server refuses it in words", refused.status === 403 && /posted it/.test(refused.json?.reason || ""), `${refused.status} ${refused.json?.reason}`);

  // ── 6 ──────────────────────────────────────────────────────────────────────────────────────
  section("6. a time that can't be");
  w = await A.compose(FIX.old);
  check("a camera whose clock says 1985: said to be wrong before posting, the day it's posted chosen", w.value === ""
    && w.say === "The photos' clock says Mon Jul 1, 1985, which can't be right: it goes on the day it's posted, unless you pick one." && !w.options.includes("1985-07-01"), JSON.stringify(w));
  await A.look("composer-clock-wrong");
  await A.page(`(() => { const i = document.querySelector("#me-cap-in"); i.value = "Old camera"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await A.upload(4);
  mem = (await feed()).find((m) => m.caption === "Old camera");
  check("posted on the day it was posted", !!mem && mem.day === null && mem.taken_at === null, JSON.stringify(mem && { day: mem.day, taken_at: mem.taken_at }));
  // A trip that runs on past today: the picker offers its days only up to two days from now.
  await ana.call("PATCH", T, { ends_on: "2026-12-31" });
  await A.memories();
  w = await A.compose(FIX.plain);
  const lastOk = await A.page(`new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 2 * 86400000))`);
  check("the picker offers no day later than two days from now", w.options.at(-1) === lastOk && w.options.every((k) => k <= lastOk), `${w.options.at(-1)} (two days from now: ${lastOk}; ${w.options.length} options)`);
  await A.page(`(document.querySelector(".sh-x") || { click() {} }).click(), 1`);
  const C = await phoneOf(ana, { clockAheadDays: 30 });
  await C.memories();
  w = await C.compose(FIX.ahead);
  check("a phone a month fast reads a photo ten days ahead as the past, and offers its day", /^From the photos: taken /.test(w.say) && w.value !== "", JSON.stringify(w));
  await C.page(`(() => { const i = document.querySelector("#me-cap-in"); i.value = "Fast clock"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await C.upload(5);
  mem = (await feed()).find((m) => m.caption === "Fast clock");
  check("the server keeps no day or time it can't have, and posts it all the same, on the day it was posted", !!mem && mem.day === null && mem.taken_at === null, JSON.stringify(mem && { day: mem.day, taken_at: mem.taken_at }));
  const toastText = await C.wait(`(() => { const t = [...document.querySelectorAll(".toast, #toast, [role=status]")].map((n) => n.textContent.trim()).find((s) => /couldn't be kept/.test(s)); return t || null; })()`, "the toast", 10000).catch(() => null);
  check("the person is told", toastText === "Posted, on the day it was posted: the day in the photos couldn't be kept.", String(toastText));
  await C.look("told");

  // ── 7 ──────────────────────────────────────────────────────────────────────────────────────
  section("7. page errors");
  await A.memories();
  await A.look("feed-by-the-day-it-happened");
  for (const [n, p] of [["the first phone", A], ["the other phone", B], ["the phone a month fast", C]]) check(`no page error on ${n}`, p.b.pageErrors.length === 0, p.b.pageErrors.join(" | ").slice(0, 400));
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  for (const b of phones) await b.done().catch(() => {});
  await server.stop().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

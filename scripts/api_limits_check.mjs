#!/usr/bin/env node
/* THE SERVER TAKES A REQUEST AND NEVER ANSWERS: the app's own limits on the API (js/net.js), and that a
 * write given up and sent again is applied once.
 *
 *   node scripts/gate.mjs --only api_limits_check
 *
 * On a server of its own, one made-up person and their trip, the browser talking to it through a
 * server of this check's (scripts/lib/hold_proxy.mjs) that passes everything through until it is told
 * to hold a request: read to its end, never answered. It holds:
 *   1. A READ, the trip's pull: given up at READ_LIMIT_MS, not sooner and not much later; the phone
 *      says it is offline then; the held connection is closed by the browser by then.
 *   2. A NEW PLAN, ITS WRITE HELD, THEN EDITED: the write given up at WRITE_LIMIT_MS, offline, still
 *      waiting, and stored as sent; the edit made then waits as a write of its own. The held write is
 *      then applied after all (as a line that drops the answer, not the request, does), the hold lifts,
 *      and the write sent again is taken: the server has the plan once, with the edit.
 *   3. A NEW PLAN, ITS WRITE HELD, THEN DELETED: the same, and the delete still goes: the server has
 *      no such plan.
 *   4. AN UPLOAD'S BEGIN HELD: given up at the write's limit, applied after all, and sent again with
 *      the same id: the server holds ONE upload for it, and the photo goes up.
 *   5. AN UPLOAD'S PART HELD after its last byte: given up STALL_MS later, not sooner and not much
 *      later, and sent again; the memory is posted.
 *
 * PLANTED (API_PLANT=<name>, served by this check's server as the files pass through):
 *   limit   net.js's three limits ten minutes long: 1, 2's give-up, 4's give-up and 5 red.
 *   unsent  store.js folding into a write sent without an answer: 2's edit lost and 3's plan left
 *           on the server, red.
 *   noid    memories.js's begin without its id: 4's one upload red (two).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import { holdProxy } from "./lib/hold_proxy.mjs";
import { pickPhotos, cdpPage } from "./lib/photo_picker.mjs";

const NET = fs.readFileSync(new URL("../public/js/net.js", import.meta.url), "utf8");
const num = (name) => Number(((new RegExp(`^export const ${name} = ([\\d_]+);`, "m").exec(NET) || [])[1] || "").replaceAll("_", ""));
const READ = num("READ_LIMIT_MS"), WRITE = num("WRITE_LIMIT_MS"), STALL = num("STALL_MS");
const LATE = 4000;                        // how far past a limit the give-up may come
const LOOK = 15000;                       // how far past a limit this check looks before it stops

const PLANT = process.env.API_PLANT || "";
if (PLANT && !["limit", "unsent", "noid"].includes(PLANT)) throw new Error(`no such plant: ${PLANT}`);
let planted = false;
const rewrite = (p, text) => {
  let t = text;
  if (PLANT === "limit" && p === "/js/net.js") t = t.replace(/^(export const (READ_LIMIT_MS|WRITE_LIMIT_MS|STALL_MS) = )[\d_]+;/gm, "$1600000;");
  if (PLANT === "unsent" && p === "/js/store.js") t = t.replace("const foldable = (q) => q.seq !== inflightSeq && !q.sent;", "const foldable = (q) => q.seq !== inflightSeq;");
  if (PLANT === "noid" && p === "/js/memories.js") t = t.replace("kind: it.kind, id: it.beginId }", "kind: it.kind }");
  if (t !== text) planted = true;
  return t;
};

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const near = (ms, limit) => ms >= limit - 500 && ms <= limit + LATE;

// A small real photograph (a test pattern), made once by ffmpeg.
const FIXDIR = process.env.WGP_FIXTURES || path.join(os.tmpdir(), "wgp-upload-fixtures");
fs.mkdirSync(FIXDIR, { recursive: true });
const PHOTO = path.join(FIXDIR, "held-frame.jpg");
if (!fs.existsSync(PHOTO)) execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1600x1200:rate=1", "-frames:v", "1", "-q:v", "3", PHOTO]);

const server = await startServer({ name: "api-limits", port: await freeLoopbackPort() });
ownServer(server.origin);
let px = null, b = null;
try {
  await server.start();
  const host = new Person(server.origin, "Noor Halvard");
  await host.signUp();
  // Its days run from two days ago to ten days on, so a plan made now starts on one of them.
  const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  const made = await host.post("/api/trips", { name: "Held line (a made-up trip)", default_tz: "Europe/Lisbon", starts_on: day(-2), ends_on: day(10) });
  const trip = made.json.trip.id, T = `/api/trips/${trip}`;
  check("a made-up person and their trip, on a server of this check's own", made.status === 201, String(made.status));

  px = await holdProxy(server.origin, { rewrite });
  console.log(`through ${px.origin}${PLANT ? `, PLANTED: ${PLANT}` : ""}; limits read ${READ}, write ${WRITE}, stall ${STALL}`);
  const { boot, evalIn, waitFor, appSettled, sleep } = await import("./lib/standalone_cdp.mjs");
  b = await boot({ vw: 390, vh: 844, dsf: 1 });
  const { cdp, S } = b;
  await cdp.send("DOM.enable", {}, S);
  // Cookies don't keep to a port: the person's session, set for localhost, is the browser's here too.
  for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: px.origin }, S);
  await cdp.send("Network.setCookie", { url: px.origin, name: "wgp_session", value: host.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
  const who = host.jar.cookies.get("wgp_who");
  if (who) await cdp.send("Network.setCookie", { url: px.origin, name: "wgp_who", value: who, sameSite: "Lax" }, S);
  const page = (e) => evalIn(cdp, S, e);
  const STORE = `(await import("/js/store.js")).store`;
  // The queue as the phone has stored it (the trip's database, "wegoplace:<trip>"): each write
  // waiting, in order, and whether it went out with no definite answer.
  const queued = async () => JSON.parse(await page(`(async () => {
    const db = await new Promise((r) => { const o = indexedDB.open(${JSON.stringify(`wegoplace:${trip}`)}); o.onsuccess = () => r(o.result); o.onerror = () => r(null); });
    if (!db || !db.objectStoreNames.contains("queue")) { if (db) db.close(); return "[]"; }
    const rows = await new Promise((r) => { const q = db.transaction("queue").objectStore("queue").getAll(); q.onsuccess = () => r(q.result); q.onerror = () => r([]); });
    db.close();
    rows.sort((a, b) => a.seq - b.seq);
    return JSON.stringify(rows.map((o) => ({ kind: o.kind, op: o.op, id: o.id, sent: !!o.sent, title: o.payload && o.payload.title }))); })()`));
  const until = async (expr, cap) => {
    const t0 = Date.now();
    while (Date.now() - t0 < cap) { if (await page(expr).catch(() => false)) return Date.now() - t0; await sleep(100); }
    return null;
  };
  await cdp.send("Page.navigate", { url: `${px.origin}/t/${trip}/#/` }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `document.querySelector("#view") && document.querySelector(".tabbar") ? 1 : 0`, { timeout: 45000, label: "the app" });
  await until(`(async () => ${STORE}.online())()`, 15000);
  await sleep(1500);
  const offline = `(async () => !${STORE}.online())()`;

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────────
  section(`1. a read held (the trip's pull): given up at ${READ} ms`);
  px.hold((r) => r.method === "GET" && r.path === T);
  const t1 = Date.now();
  page(`(async () => { ${STORE}.refresh(); return 1; })()`).catch(() => {});
  const off1 = await until(offline, READ + LOOK);
  const h1 = px.held.find((h) => h.path === T);
  check("the server really took the pull and held it", !!h1);
  check(`the phone says it is offline at the read's limit (${READ} ms), not sooner, not much later`, off1 !== null && near(off1, READ), off1 === null ? "still online" : `${off1} ms`);
  check("the browser closed the held connection by then: nothing left open", !!h1 && h1.closed > 0 && h1.closed - t1 <= READ + LATE, h1 ? `${h1.closed ? h1.closed - t1 + " ms" : "still open"}` : "");
  px.release();
  page(`(async () => { ${STORE}.refresh(); return 1; })()`).catch(() => {});
  await until(`(async () => ${STORE}.online())()`, 20000);

  // ── 2 and 3 ────────────────────────────────────────────────────────────────────────────────
  // A new plan's write, held, given up; then the plan edited (2) or deleted (3) while it waits.
  async function heldPlan(label, then) {
    const id = `ev-held-${label}-${Date.now().toString(36)}`;
    px.hold((r) => r.method === "POST" && r.path === `${T}/events` && r.body.includes(id));
    const t0 = Date.now();
    await page(`(async () => { await ${STORE}.addEvent({ id: ${JSON.stringify(id)}, title: "A plan held (${label})" }); return 1; })()`);
    const off = await until(offline, WRITE + LOOK);
    const h = px.held.find((x) => x.body.includes(id));
    const q = await queued();
    const mine = q.filter((o) => o.id === id);
    check(`${label}: the server took the new plan's write and held it`, !!h);
    check(`${label}: the write is given up at its limit (${WRITE} ms), not sooner, not much later; the phone says offline`, off !== null && near(off, WRITE), off === null ? "still online" : `${off} ms`);
    check(`${label}: the write still waits, stored as sent with no answer`, mine.length === 1 && mine[0].op === "create" && mine[0].sent, JSON.stringify(mine));
    await then(id);
    const q2 = (await queued()).filter((o) => o.id === id);
    // The held write applied after all, as when a line drops the answer and not the request; then the hold lifts.
    const late = h ? await px.applyLate(h) : { status: 0 };
    check(`${label}: the held write, applied late, makes the plan`, late.status === 201, `${late.status} ${JSON.stringify(late.json)}`);
    px.release();
    page(`(async () => { ${STORE}.refresh(); return 1; })()`).catch(() => {});
    const drained = await until(`(async () => ${STORE}.status().pending === 0 && ${STORE}.online())()`, 60000);
    check(`${label}: once the hold lifts, everything waiting goes`, drained !== null, drained === null ? JSON.stringify(await queued()) : `${drained} ms`);
    return { id, q2, t0 };
  }

  section("2. a new plan, its write held, then edited");
  const edited = await heldPlan("edited", async (id) => {
    await page(`(async () => { await ${STORE}.updateEvent(${JSON.stringify(id)}, { title: "A plan held (edited), then renamed" }); return 1; })()`);
    const q = (await queued()).filter((o) => o.id === id);
    check("edited: the edit waits as a write of its own, behind the one sent", q.length === 2 && q[0].op === "create" && q[1].op === "update", JSON.stringify(q));
  });
  {
    const rows = server.sql(`SELECT id, title FROM events WHERE id = '${edited.id}' OR title LIKE 'A plan held (edited)%'`);
    check("edited: the server has the plan once, with the edit", rows.length === 1 && rows[0].title === "A plan held (edited), then renamed", JSON.stringify(rows));
  }

  section("3. a new plan, its write held, then deleted");
  const deleted = await heldPlan("deleted", async (id) => {
    await page(`(async () => { await ${STORE}.deleteEvent(${JSON.stringify(id)}); return 1; })()`);
    const q = (await queued()).filter((o) => o.id === id);
    check("deleted: the delete waits as a write of its own, behind the one sent", q.length === 2 && q[0].op === "create" && q[1].op === "delete", JSON.stringify(q));
  });
  {
    const rows = server.sql(`SELECT id, title FROM events WHERE id = '${deleted.id}'`);
    check("deleted: the server has no such plan", rows.length === 0, JSON.stringify(rows));
  }

  // ── 4 and 5 ────────────────────────────────────────────────────────────────────────────────
  section(`4. an upload's begin held: given up at ${WRITE} ms, sent again with its id`);
  await cdp.send("Page.navigate", { url: `${px.origin}/t/${trip}/?n=1#/memories` }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `document.querySelector("#view .me-feed") ? 1 : 0`, { timeout: 45000, label: "the Memories feed" });
  px.hold((r) => r.method === "POST" && r.path === `${T}/media/begin`);
  await pickPhotos({ ...cdpPage(cdp, S), files: [PHOTO] });   // Add photos: the phone's picker first, then the sheet
  await waitFor(cdp, S, `document.querySelectorAll(".me-pickrow").length === 1 ? 1 : 0`, { label: "the photo picked" });
  await page(`(() => { const i = document.querySelector("#me-cap-in"); i.value = "Held at the pass"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await page(`(document.querySelector(".me-go").click(), 1)`);
  const t4 = Date.now();
  let h4 = null;
  while (Date.now() - t4 < 10000 && !(h4 = px.held.find((h) => h.path === `${T}/media/begin`))) await sleep(100);
  check("the server took the begin and held it", !!h4);
  while (h4 && !h4.closed && Date.now() - t4 < WRITE + LOOK) await sleep(100);
  check(`the begin is given up at the write's limit (${WRITE} ms): the browser closed it`, !!h4 && h4.closed > 0 && near(h4.closed - h4.at, WRITE), h4 ? (h4.closed ? `${h4.closed - h4.at} ms` : "still open") : "");
  const beginLate = h4 ? await px.applyLate(h4) : { status: 0, json: null };
  check("the held begin, applied late, reserves the upload", beginLate.status === 200 || beginLate.status === 201, `${beginLate.status}`);
  px.release();

  section(`5. its part held after the last byte: given up ${STALL} ms later, sent again`);
  px.hold((r) => r.method === "POST" && r.path === `${T}/media/part` && !px.held.some((h) => h.path === `${T}/media/part`));
  // Signal again: the waiting job wakes (it listens for "online").
  await page(`(dispatchEvent(new Event("online")), 1)`);
  let h5 = null;
  const t5 = Date.now();
  while (Date.now() - t5 < 60000 && !(h5 = px.held.find((h) => h.path === `${T}/media/part`))) await sleep(200);
  check("the begin, sent again, was taken, and the part reached the server and was held", !!h5, h5 ? "" : JSON.stringify(px.seen.filter((s) => s.path.includes("/media/")).map((s) => `${s.method} ${s.path}`)));
  while (h5 && !h5.closed && Date.now() - t5 < 60000 + STALL + LOOK) await sleep(200);
  check(`the part, all its bytes sent, is given up ${STALL} ms after its last byte with no answer, not sooner, not much later`,
    !!h5 && h5.closed > 0 && near(h5.closed - h5.ended, STALL), h5 ? (h5.closed ? `${h5.closed - h5.ended} ms after its last byte` : "still open") : "");
  px.release();
  await page(`(dispatchEvent(new Event("online")), 1)`);
  // Asked of the server: the memory there with its caption, and the photo stored.
  const tp = Date.now();
  let mem = [], stored = [];
  while (Date.now() - tp < 120000) {
    mem = server.sql(`SELECT id FROM memories WHERE trip_id = '${trip}' AND caption = 'Held at the pass'`);
    stored = server.sql(`SELECT r2_key FROM media_objects WHERE trip_id = '${trip}' AND role = 'original' AND state = 'stored'`);
    if (mem.length && stored.length) break;
    await sleep(1000);
  }
  check("the photo goes up, sent again, and the memory is posted (the server has both)", mem.length === 1 && stored.length === 1,
    `${Date.now() - tp} ms; memories ${mem.length}, stored ${stored.length}`);
  const ups = server.sql(`SELECT r2_key, begin_id, state FROM media_objects WHERE trip_id = '${trip}' AND role = 'original'`);
  check("the server holds ONE upload for the photo, not two", ups.length === 1, JSON.stringify(ups));
  const begins = px.seen.filter((s) => s.method === "POST" && s.path === `${T}/media/begin`).length;
  check("its begin was sent at least twice (held, then again)", begins >= 2, `${begins}`);
  const errs = b.pageErrors || [];
  check("nothing thrown on the page", errs.length === 0, errs.join(" | ").slice(0, 400));
} catch (e) {
  fail++; failures.push(`stopped: ${e.message}`);
  console.log(`  FAIL  stopped: ${e.stack || e}`);
} finally {
  if (b) await b.done().catch(() => {});
  if (px) await px.close().catch(() => {});
  await server.stop().catch(() => {});
}
if (PLANT && !planted) { console.log(`\nError: the ${PLANT} plant changed nothing`); process.exit(1); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }

// Live updates (model §10; src/trips/room.js, src/trips/live.js): every open tab of a trip hears
// {"rev": n} within seconds of a write to it, and nothing else; only someone on the trip, from the
// site's own page, can open one; a person who goes is dropped by the write that takes them off;
// a write still answers when the room can't be reached. And, read from the code, every write that
// moves a trip's rev tells the room, so a new write path can't skip it.
//
//   npm run check:live        (about a minute; its own servers on 8791 and 8795)
//
// Everyone here is made up.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CheckError, ROOT, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { McpClient, connect } from "../lib/mcp.mjs";
import { balanced } from "../../tools/refusals.mjs";
import { LIVE_PER_PERSON } from "../../public/js/shared/limits.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const logTo = flag("--log");   // the servers' logs, written there at the end (for looking into a failure)
const t = new Report("live updates");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
let failing;
let code = 1;
const opened = [];

/**
 * A tab's socket on a trip, as a browser opens it: the person's cookie, the page's origin. Its
 * frames are read here, by hand, so a close counts the moment the room's close frame arrives with
 * its code (what a browser's close event reports). A local server holds the connection itself
 * open after a close the room starts outside a socket's own event until it stops, so a client
 * that waited for the connection to end would wait for that, not for the room.
 */
function listen(on, person, tripId, { origin = on.origin, headers = {} } = {}) {
  const u = new URL(on.origin);
  const s = { messages: [], heard: [], closed: null, opened: false, socket: null };
  const frame = (op, payload) => {
    const body = Buffer.from(payload);
    const mask = crypto.randomBytes(4);
    const head = body.length < 126 ? Buffer.from([0x80 | op, 0x80 | body.length]) : Buffer.from([0x80 | op, 0x80 | 126, body.length >> 8, body.length & 255]);
    return Buffer.concat([head, mask, Buffer.from(body.map((b, i) => b ^ mask[i % 4]))]);
  };
  s.send = (text) => s.socket?.write(frame(1, text));
  s.close = () => { try { s.socket?.write(frame(8, Buffer.from([0x03, 0xe8]))); s.socket?.end(); } catch { /* gone */ } };
  const req = http.request({ host: u.hostname, port: u.port, path: `/api/trips/${encodeURIComponent(tripId)}/live`, method: "GET", headers: {
    Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
    Cookie: person.jar.header(), "CF-Connecting-IP": person.address, ...(origin ? { Origin: origin } : {}), ...headers } });
  req.on("upgrade", (res, socket, head) => {
    s.opened = true;
    s.socket = socket;
    let buf = head;
    const read = () => {
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let at = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
        if (buf.length < at + len) return;
        const payload = buf.subarray(at, at + len);
        buf = buf.subarray(at + len);
        if (op === 1) { const text = payload.toString(); s.heard.push({ at: Date.now(), text }); try { s.messages.push(JSON.parse(text)); } catch { s.messages.push(text); } }
        else if (op === 8) { s.closed ??= { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005, reason: payload.subarray(2).toString() }; try { socket.write(frame(8, payload.subarray(0, 2))); } catch { /* gone */ } }
        else if (op === 9) socket.write(frame(10, payload));
      }
    };
    socket.on("data", (d) => { buf = Buffer.concat([buf, d]); read(); });
    socket.on("error", () => {});
    socket.on("close", () => { s.closed ??= { code: 1006, reason: "" }; });
    read();
  });
  req.on("response", (res) => { s.closed = { code: 0, reason: `refused ${res.statusCode}` }; res.resume(); });
  req.on("error", () => { s.closed ??= { code: 1006, reason: "error" }; });
  req.end();
  s.until = async (holds, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (holds(s)) return true; await sleep(20); } return holds(s); };
  s.lastRev = () => [...s.messages].reverse().find((m) => typeof m?.rev === "number")?.rev ?? null;
  opened.push(s);
  return s;
}

/** An upgrade asked for by hand, for the ones that must be refused: their status and body. */
function upgrade(on, pathName, headers) {
  const u = new URL(on.origin);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: pathName, method: "GET", headers: {
      Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"), ...headers } });
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve({ status: 101 }); });
    req.on("response", (res) => { let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => { let json = null; try { json = JSON.parse(body); } catch { /* not JSON */ } resolve({ status: res.statusCode, json }); }); });
    req.on("error", reject);
    req.end();
  });
}

async function person(on, name) {
  const p = new Person(on.origin, name);
  const res = await p.signUp();
  if (res.status !== 200) throw new CheckError(`couldn't make ${name}: ${res.status} ${res.text}`);
  return p;
}
async function bring(host, tripId, joiner) {
  const link = await host.post(`/api/trips/${tripId}/links`, { uses: 1 });
  const res = await joiner.post(`/api/join/${link.json.link.code}`);
  if (res.status !== 200) throw new CheckError(`couldn't join: ${res.status} ${res.text}`);
  return res;
}
let n = 0;
const event = (who, tripId, extra = {}) => who.post(`/api/trips/${tripId}/events`, { id: `ev-${++n}`, title: `Event ${n}`, starts_at: Date.UTC(2027, 3, 3, 9) / 1000, tz: "UTC", ...extra });

/** The functions in a source file that move a trip's rev without telling its room. */
export function silentWrites(file, text) {
  const out = [];
  // Comments don't write: blanked, keeping every offset.
  const src = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).replace(/(^|[ \t])\/\/.*$/gm, (c) => c.replace(/./g, " "));
  const MOVES = /\bbump\(|\bbumpChat\(|rev\s*=\s*rev\s*\+\s*1|\btripDeleteSteps\(/g;
  const starts = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)[^{]*\{/gm)].map((m) => ({ name: m[1], open: m.index + m[0].length - 1 }));
  for (const m of src.matchAll(MOVES)) {
    const fn = starts.filter((s) => s.open < m.index).at(-1);
    if (!fn) continue;
    const end = balanced(src, fn.open);
    if (m.index > end) continue;                                   // not inside a function body
    const body = src.slice(fn.open, end);
    if (/^(bump|write|tripDeleteSteps|moved)$/.test(fn.name)) continue;   // the definitions themselves
    // A function that only builds statements for its caller's batch says so by its name: …Steps.
    if (/Steps$/.test(fn.name)) continue;
    const tells = m[0].startsWith("tripDeleteSteps") ? /\bmoved\([^)]*gone:\s*true/.test(body) : /\bmoved\(/.test(body);
    if (!tells) out.push(`${file}: ${fn.name} (${m[0].replace(/\($/, "")})`);
  }
  return out;
}

try {
  t.part("Read from the code: every write that moves a trip's rev tells its room");
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) files.push(p); } };
  walk(path.join(ROOT, "src"));
  const silent = files.flatMap((f) => silentWrites(path.relative(ROOT, f), fs.readFileSync(f, "utf8")));
  const moving = files.filter((f) => /\bbump\(|rev\s*=\s*rev\s*\+\s*1|tripDeleteSteps\(/.test(fs.readFileSync(f, "utf8"))).length;
  t.ok(`no function moves a rev, or deletes a trip, without moved() (${moving} files move one)`, silent.length === 0, silent.join("\n        "));
  const planted = silentWrites("src/planted.js", `export async function sneaky(env, id) {
  await env.DB.batch([bump(env, id), env.DB.prepare("UPDATE events SET title = 'x'")]);
}
export async function told(env, id) {
  const done = await env.DB.batch([bump(env, id)]);
  await moved(env, id, done[0].results[0].rev);
}
export async function names(env) {
  await env.DB.prepare("UPDATE trips SET rev = rev + 1 WHERE id IN (SELECT 1)").run();
}
export async function wipe(env, id) {
  await env.DB.batch(tripDeleteSteps(env, id).map((s) => s.stmt));
  await moved(env, id, 3);
}`);
  t.same("  (planted: a bump with no moved(), one with it, a rev moved by hand, a trip deleted without telling the room it's gone)", planted,
    ["src/planted.js: sneaky (bump)", "src/planted.js: names (rev = rev + 1)", "src/planted.js: wipe (tripDeleteSteps)"]);
  const room = fs.readFileSync(path.join(ROOT, "src/trips/room.js"), "utf8");
  const sends = [...room.matchAll(/\.send\(/g)].length;
  const revOnly = [...room.matchAll(/\.send\((JSON\.stringify\(\{ rev \}\)|message)\)/g)].length;
  t.ok(`the room sends nothing but the rev (${sends} sends, each of { rev })`, sends > 0 && sends === revOnly && /const message = JSON\.stringify\(\{ rev \}\);/.test(room), [sends, revOnly]);
  t.ok("  (and it sets no alarm or timer, so it hibernates)", !/setAlarm|setTimeout|setInterval/.test(room));

  server = await startServer({ name: "live", port });
  await server.start();
  const on = server;
  const ana = await person(on, "Ana Live");
  const ben = await person(on, "Ben Live");
  const cai = await person(on, "Cai Live");
  const T = (await ana.post("/api/trips", { name: "Live check", default_tz: "UTC", starts_on: "2027-04-01", ends_on: "2027-04-09" })).json.trip.id;
  await bring(ana, T, ben);
  await bring(ana, T, cai);

  t.part("Opening a tab's socket");
  const b1 = listen(on, ben, T);
  const opens = await b1.until((s) => s.messages.length > 0);
  const now = (await ben.get(`/api/trips/${T}/rev`)).json?.rev;
  t.same("someone on the trip opens one and hears the trip's rev at once, and nothing else", [opens, b1.messages[0], Object.keys(b1.messages[0] ?? {})], [true, { rev: now }, ["rev"]]);
  const LIVE = `/api/trips/${T}/live`;
  const cookieOf = (p) => ({ Cookie: p.jar.header(), "CF-Connecting-IP": p.address, Origin: on.origin });
  const outsider = await person(on, "Dee Live");
  const other = (await outsider.post("/api/trips", { name: "Not theirs", default_tz: "UTC" })).json.trip.id;
  const refused = {
    "no session": await upgrade(on, LIVE, { Origin: on.origin }),
    "someone not on the trip": await upgrade(on, LIVE, cookieOf(outsider)),
    "another trip's room": await upgrade(on, `/api/trips/${other}/live`, cookieOf(ben)),
    "another site's page": await upgrade(on, LIVE, { ...cookieOf(ben), Origin: "https://elsewhere.example" }),
    "no origin at all": await upgrade(on, LIVE, { Cookie: ben.jar.header(), "CF-Connecting-IP": ben.address }),
  };
  t.same("refused, each before any socket: no session 401, not on the trip and another trip's room 404, another site's page and no origin 403",
    Object.fromEntries(Object.entries(refused).map(([k, v]) => [k, [v.status, v.json?.error]])),
    { "no session": [401, "unauthorized"], "someone not on the trip": [404, "no such trip"], "another trip's room": [404, "no such trip"],
      "another site's page": [403, "cross site"], "no origin at all": [403, "cross site"] });
  const plain = await ben.get(LIVE);
  t.same("  (the address asked for as a page is a 426: it's only a socket)", [plain.status, plain.json?.error], [426, "websocket only"]);
  // A browser with no wgp_who note yet (or whose session is renewed that day): the gate has cookies to
  // add to the 101. That threw once (the 101's headers can't be changed), and the socket never opened.
  const noNote = listen(on, { ...ben, jar: { header: () => ben.jar.header().split("; ").filter((c) => !c.startsWith("wgp_who=")).join("; ") } }, T);
  await noNote.until((s) => s.messages.length > 0 || s.closed);
  t.same("a page with no wgp_who note opens it too (the gate's cookie for it rides on the 101)", [noNote.messages[0], noNote.closed], [{ rev: now }, null]);
  const forged = listen(on, ben, T, { headers: { "x-wgp-user": cai.user.id, "x-wgp-rev": "999999", "x-wgp-session": "made-up" } });
  await forged.until((s) => s.messages.length > 0);
  t.same("headers naming another person, another rev or session are dropped before the room: it hears the real rev", forged.messages[0], { rev: now });

  t.part("A write, heard by the others' tabs");
  const a1 = listen(on, ana, T);
  const c1 = listen(on, cai, T);
  await Promise.all([a1, c1].map((s) => s.until((x) => x.messages.length > 0)));
  const sent = Date.now();
  const wrote = await event(ana, T);
  const heardAll = await Promise.all([b1, c1, a1].map((s) => s.until((x) => x.lastRev() === wrote.json?.rev)));
  const took = Math.max(...[b1, c1].map((s) => (s.heard.at(-1)?.at ?? Infinity) - sent));
  t.ok(`one person's write reaches every tab of the trip, theirs too, with its new rev (${took} ms after it was sent)`, wrote.status === 201 && heardAll.every(Boolean) && took < 3000, [wrote.status, b1.messages, c1.messages]);
  const read = (await ben.get(`/api/trips/${T}`)).json;
  t.same("and the other's next read has the change, at that rev", [read.rev, read.events.some((e) => e.id === `ev-${n}`)], [wrote.json?.rev, true]);
  t.ok("  (every message is { rev } and nothing else)", opened.every((s) => s.messages.every((m) => m && typeof m === "object" && Object.keys(m).join() === "rev")));

  const joinedBefore = b1.lastRev();
  const eli = await person(on, "Eli Live");
  const joined = await bring(ana, T, eli);
  const renamed = await cai.call("PATCH", "/api/me", { name: "Cai Renamed" });
  const after = (await ben.get(`/api/trips/${T}/rev`)).json?.rev;
  await b1.until((s) => s.lastRev() === after);
  t.same("joining by a link and a name change on the account are heard too (each a write outside write())",
    [joined.status, renamed.status, b1.lastRev() > joinedBefore, b1.lastRev()], [200, 200, true, after]);

  const { tokens } = await connect(on.origin, ana, { address: ana.address, name: "Live App" });
  const mcp = new McpClient(on.origin, tokens.json.access_token);
  await mcp.initialize();
  const byAi = await mcp.call("put_events", { trip_id: T, summary: "An AI's event", events: [{ id: "ev-ai", title: "From the AI", starts: "2027-04-04T10:00", tz: "UTC" }] });
  const aiRev = (await ben.get(`/api/trips/${T}/rev`)).json?.rev;
  t.ok("an AI's write through the MCP is heard the same way", !byAi.isError && await b1.until((s) => s.lastRev() === aiRev), byAi.text?.slice(0, 200));

  t.part("A burst of writes, on another phone");
  const before = b1.messages.length;
  const heardBefore = b1.heard.length;
  const burstStart = (await ben.get(`/api/trips/${T}/rev`)).json?.rev;
  const burstFrom = Date.now();
  for (let i = 0; i < 20; i++) await event(ana, T);
  const burstMs = Date.now() - burstFrom;
  const burstEnd = (await ben.get(`/api/trips/${T}/rev`)).json?.rev;
  await b1.until((s) => s.lastRev() === burstEnd);
  const burst = b1.messages.slice(before).map((m) => m.rev);
  const rising = burst.every((r, i) => i === 0 || r > burst[i - 1]);
  // What a tab following docs/API.md's rule does with them: it reads only for a rev newer than it
  // holds, at most once a second (one read at the first poke, then one at the end of each second
  // in which newer ones came).
  const arrivals = b1.heard.slice(heardBefore).map((h) => h.at);
  let reads = 0, next = 0, pending = false;
  for (const at of arrivals) { if (at >= next) { reads += 1; next = at + 1000; pending = false; } else pending = true; }
  if (pending) reads += 1;
  console.log(`    (the burst: 20 writes in ${burstMs} ms; the other phone heard ${burst.length} pokes and, by the rule, reads the trip ${reads} times)`);
  t.ok(`twenty writes in a row: the other tab hears at most one poke a write, each newer than the last, the last the trip's rev (${burst.length} pokes)`,
    burst.length <= 20 && burst.length > 0 && rising && burst.at(-1) === burstEnd && burstEnd - burstStart === 20, burst);
  const one = b1.messages.length;
  const batch = await ana.call("PUT", `/api/trips/${T}/events`, { events: Array.from({ length: 50 }, (_, i) => ({ id: `ev-b${i}`, title: `Batch ${i}`, starts_at: Date.UTC(2027, 3, 5) / 1000, tz: "UTC" })) });
  await b1.until((s) => s.lastRev() === batch.json?.rev);
  t.same("  (fifty events in one batch are one write: one poke)", [batch.status, b1.messages.length - one], [200, 1]);

  t.part("Who is dropped, and by what");
  const c2 = listen(on, cai, T);
  await c2.until((s) => s.messages.length > 0);
  const removed = await ana.call("DELETE", `/api/trips/${T}/members/${cai.user.id}`);
  t.ok("someone the host removes: every one of their tabs closes at once (4001), by the removal itself",
    removed.status === 200 && await c1.until((s) => s.closed) && await c2.until((s) => s.closed) && c1.closed.code === 4001 && c2.closed.code === 4001, [removed.status, c1.closed, c2.closed]);
  t.ok("  (the forged socket, which claimed to be theirs, is still open: it was always Ben's)", forged.closed === null);
  const e1 = listen(on, eli, T);
  await e1.until((s) => s.messages.length > 0);
  const left = await eli.call("DELETE", `/api/trips/${T}/members/${eli.user.id}`);
  t.ok("someone who leaves: theirs close too", left.status === 200 && await e1.until((s) => s.closed) && e1.closed.code === 4001, [left.status, e1.closed]);
  const reopened = await upgrade(on, LIVE, cookieOf(cai));
  t.same("  (and they can't open one again: they aren't on the trip)", reopened.status, 404);

  const benPhone = ben.otherBrowser();
  if ((await benPhone.signIn()).status !== 200) throw new CheckError("ben's second browser couldn't sign in");
  const bPhone = listen(on, benPhone, T);
  await bPhone.until((s) => s.messages.length > 0);
  await ben.post("/api/auth/logout");
  const afterOut = await event(ana, T);
  t.ok("signing out on one browser closes that browser's tabs only; the other still hears the trip",
    await b1.until((s) => s.closed) && b1.closed.code === 4001 && forged.closed?.code === 4001 && await bPhone.until((s) => s.lastRev() === afterOut.json?.rev) && bPhone.closed === null,
    [b1.closed, forged.closed, bPhone.closed, bPhone.messages.slice(-2)]);
  await benPhone.post("/api/auth/logout/all");
  t.ok("signing out everywhere closes the rest", await bPhone.until((s) => s.closed) && bPhone.closed.code === 4001, bPhone.closed);

  const gone = (await ana.post("/api/trips", { name: "Going", default_tz: "UTC" })).json.trip.id;
  const g1 = listen(on, ana, gone);
  await g1.until((s) => s.messages.length > 0);
  const deleted = await ana.call("DELETE", `/api/trips/${gone}`, { confirm: "Going" });
  t.ok("a trip deleted: every tab of it closes (4004)", deleted.status === 200 && await g1.until((s) => s.closed) && g1.closed.code === 4004, [deleted.status, g1.closed]);

  t.part("What a tab may do, and how many");
  const a2 = listen(on, ana, T);
  await a2.until((s) => s.messages.length > 0);
  a2.send("ping");
  t.same("\"ping\" is answered \"pong\" (by the room's auto-response, which doesn't wake it)", await a2.until((s) => s.heard.some((h) => h.text === "pong")), true);
  a2.send("anything else");
  t.ok("anything else closes the socket (1003): it only listens", await a2.until((s) => s.closed) && a2.closed.code === 1003, a2.closed);
  // Opened one after another, so which is oldest is known (opened at once, the room's order is theirs).
  const many = [];
  for (let i = 0; i <= LIVE_PER_PERSON; i++) {
    const s = listen(on, ana, T);
    await s.until((x) => x.messages.length > 0 || x.closed);
    many.push(s);
  }
  await sleep(300);
  const open = many.filter((s) => !s.closed).length;
  t.same(`one person's ${LIVE_PER_PERSON + 1}th socket on a trip closes their oldest (4008); ${LIVE_PER_PERSON} stay open`,
    [many[0].closed?.code ?? null, open], [4008, LIVE_PER_PERSON]);

  t.part("When the room can't be reached");
  // Its own port, four above: the one just above is the client lane's own server (8792).
  failing = await startServer({ name: "live-failing", port: port + 4, vars: { ROOM_FAIL: "on" } });
  await failing.start();
  const fa = await person(failing, "Fay Live");
  const fb = await person(failing, "Gus Live");
  const F = (await fa.post("/api/trips", { name: "Unreachable", default_tz: "UTC", starts_on: "2027-04-01", ends_on: "2027-04-09" })).json.trip.id;
  await bring(fa, F, fb);
  const fs1 = listen(failing, fb, F);
  await fs1.until((s) => s.messages.length > 0);
  const still = await event(fa, F);
  await sleep(1200);
  const logged = failing.log().split("\n").filter((l) => l.includes("room_unreachable")).length;
  t.same("a write still answers, with its new rev, and the read has it; the room's absence is logged, and the tab, hearing nothing, would ask /rev as before",
    [still.status, (await fb.get(`/api/trips/${F}`)).json.events.some((e) => e.id === `ev-${n}`), logged > 0, fs1.lastRev() < still.json?.rev],
    [201, true, true, true]);

  t.part("Underneath");
  const failed = [server, failing].flatMap((s) => s.log().split("\n")).filter((l) => /Uncaught|✘|\[ERROR\]/.test(l));
  t.ok("nothing failed inside the servers", failed.length === 0, failed.slice(0, 6).join("\n        "));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  if (logTo) fs.writeFileSync(logTo, [server, failing].filter(Boolean).map((s) => s.log()).join("\n----\n"));
  for (const s of opened) s.close();
  await server?.stop();
  await failing?.stop();
}
process.exit(code);

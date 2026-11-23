// A drawn picture in place of the initials (migration 0043; the format public/js/shared/avatar.js, the routes
// src/accounts/avatar.js), on a server of its own, everyone made up:
//   1. the format: a picture round-trips; every hostile blob is refused whole, never half read; a picture past the
//      ceiling is fitted, never refused; the hash the server gives is the one this process computes;
//   2. drawing nothing: no roster row and no /api/me answer carries an `avatar` key (parity holds every other answer);
//   3. one draws, the other on the trip hears the trip move within seconds, sees the hash on the roster (whole and as
//      a delta) and reads the same bytes; the same picture again writes nothing;
//   4. who may read one: its own, a trip-mate (and a picture of someone who left the trip), never someone on no trip
//      with it, nobody signed out, nobody who left;
//   5. a guest draws too; bad input is refused in words; the hour's limit, with nothing written past it;
//   6. two people sending the same bytes share one stored picture, which goes when nobody holds it (back to
//      initials, a deleted account); the data download carries the picture.
//
//   npm run check:avatar [-- --port <port>]       (its server on 8884 and the inspector on 9884 unless said)
//
// PLANTS (AVATAR_PLANT=<name>): each puts one fault into the tree's own source for the run, and the check must go
// red. The source is put back when the run ends; a run that was killed leaves a backup, which the next run restores
// before anything else.
//   anyone    GET /api/avatars/<hash> reads to anyone signed in
//   nullkey   the roster carries `avatar: null` for someone who never drew
//   nosweep   a picture nobody holds any more is kept
//   norev     a new picture doesn't move its person's trips
//   lenient   the format takes a stroke that claims more points than it has
//   nolimit   the hour's limit is never reached

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CheckError, ROOT, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";

const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 8884);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the plants ──────────────────────────────────────────────────────────────────────────────────────────────────────
const PLANTS = {
  anyone: ["src/accounts/avatar.js", "`SELECT d.bytes FROM drawings d WHERE d.hash = ?1 AND (", "`SELECT d.bytes FROM drawings d WHERE d.hash = ?1 AND (1 OR "],
  nullkey: ["src/api/trip.js", "...(r.avatar ? { avatar: r.avatar } : {}),", "avatar: r.avatar ?? null,"],
  nosweep: ["src/accounts/avatar.js", "    ...change,\n    sweepDrawings(db),", "    ...change,"],
  norev: ["src/accounts/avatar.js", "    ...tripRevs(db, userId),\n  ];", "    db.prepare(\"SELECT 1\"), db.prepare(\"SELECT 1\"),\n  ];"],
  lenient: ["public/js/shared/avatar.js", "    i += STROKE_HEAD + n * 2;\n    if (i > bytes.length) return false;", "    i += STROKE_HEAD + n * 2;\n    if (i > bytes.length) return true;"],
  nolimit: ["src/accounts/avatar.js", "if ((row?.n ?? 0) < AVATAR_WRITES_PER_HOUR) return null;", "if ((row?.n ?? 0) < 1e9) return null;"],
};
const PLANT = process.env.AVATAR_PLANT || "";
const BACKUP = path.join(ROOT, ".wrangler", "avatar-plant-backup.json");
function restore() {
  if (!fs.existsSync(BACKUP)) return;
  const { file, text } = JSON.parse(fs.readFileSync(BACKUP, "utf8"));
  fs.writeFileSync(path.join(ROOT, file), text);
  fs.rmSync(BACKUP);
}
restore();
if (PLANT) {
  const p = PLANTS[PLANT];
  if (!p) { console.error(`no such plant: ${PLANT} (${Object.keys(PLANTS).join(", ")})`); process.exit(2); }
  const [file, from, to] = p;
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  if (text.split(from).length !== 2) { console.error(`the ${PLANT} plant's text isn't in ${file} once`); process.exit(2); }
  fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
  fs.writeFileSync(BACKUP, JSON.stringify({ file, text }));
  fs.writeFileSync(path.join(ROOT, file), text.replace(from, to));
  console.log(`(planted: ${PLANT}, in ${file})`);
}
process.on("exit", restore);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(1); });

// After the plant, so a planted format module is the one read.
const A = await import(`../../public/js/shared/avatar.js?run=${Date.now()}`);
const { AVATAR_WRITES_PER_HOUR } = await import("../../public/js/shared/limits.js");

// ── a trip's socket, read by hand (as checks/live/run.mjs reads one) ────────────────────────────────────────────────
function listen(origin, person, tripId) {
  const u = new URL(origin);
  const s = { messages: [], socket: null };
  const req = http.request({ host: u.hostname, port: u.port, path: `/api/trips/${encodeURIComponent(tripId)}/live`, method: "GET", headers: {
    Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
    Cookie: person.jar.header(), "CF-Connecting-IP": person.address, Origin: origin } });
  req.on("upgrade", (res, socket, head) => {
    s.socket = socket;
    let buf = head;
    const read = () => {
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, at = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
        if (buf.length < at + len) return;
        const payload = buf.subarray(at, at + len);
        buf = buf.subarray(at + len);
        if (op === 1) { try { s.messages.push(JSON.parse(payload.toString())); } catch { /* not JSON */ } }
      }
    };
    socket.on("data", (d) => { buf = Buffer.concat([buf, d]); read(); });
    socket.on("error", () => {});
    read();
  });
  req.on("error", () => {});
  req.end();
  s.lastRev = () => [...s.messages].reverse().find((m) => typeof m?.rev === "number")?.rev ?? null;
  s.until = async (holds, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (holds()) return true; await sleep(25); } return holds(); };
  s.close = () => { try { s.socket?.destroy(); } catch { /* gone */ } };
  return s;
}

/** The bytes of an answer, as they came (the helper's own reads them as text). */
async function bytesOf(origin, person, p) {
  const headers = { "CF-Connecting-IP": person.address };
  const cookie = person.jar.header();
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(origin + p, { headers });
  return { status: res.status, type: res.headers.get("content-type"), bytes: new Uint8Array(await res.arrayBuffer()) };
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const t = new Report("a drawn picture");
let server, code = 1;
const sockets = [];
try {
  t.part("1. The format");
  {
    const d = { palette: 5, strokes: [{ ink: 1, brush: 110, pts: [[20, 30], [200, 210], [127, 127]] }, { ink: 0, brush: A.BRUSH_FILL, pts: [[127, 127]] }] };
    const bytes = A.encode(d);
    t.ok("a picture round-trips: encode, the strict walk, decode, base64url and back", bytes && A.validate(bytes) && JSON.stringify(A.decode(bytes)) === JSON.stringify(d)
      && same(A.fromB64url(A.toB64url(bytes)), bytes), bytes ? bytes.length : "no bytes");
    const cut = (b, n) => b.slice(0, b.length - n);
    const at = (b, i, v) => { const c = b.slice(); c[i] = v; return c; };
    const hostile = {
      "a stroke claiming more points than it has": cut(bytes, 2),
      "a byte left over at the end": new Uint8Array([...bytes, 7]),
      "another magic": at(bytes, 0, 0x46),
      "a version this app doesn't know": at(bytes, 3, 2),
      "a palette past the list": at(bytes, 4, A.PALETTE_COUNT),
      "a brush of 0": at(bytes, 5, 0),
      "an ink past the second": at(bytes, 6, 2),
      "a stroke of no points": (() => { const c = bytes.slice(); c[7] = 0; c[8] = 0; return c; })(),
      "nothing past the head": bytes.slice(0, 5),
      "past the ceiling": new Uint8Array(A.DRAWING_BYTES_MAX + 1),
      "not bytes at all": "drawing",
    };
    const taken = Object.entries(hostile).filter(([, b]) => A.validate(b) || A.decode(b) !== null).map(([k]) => k);
    t.ok(`every hostile blob is refused whole (${Object.keys(hostile).length} kinds), never half read`, taken.length === 0, taken.join("; "));
    t.ok("encode refuses what isn't a picture (a palette past the list, an ink of 2, a brush of 0, no strokes)",
      [{ palette: 8, strokes: d.strokes }, { palette: 0, strokes: [{ ink: 2, brush: 9, pts: [[1, 1]] }] }, { palette: 0, strokes: [{ ink: 0, brush: 0, pts: [[1, 1]] }] }, { palette: 0, strokes: [] }]
        .every((x) => A.encode(x) === null));
    const huge = { palette: 0, strokes: Array.from({ length: 40 }, (_, k) => ({ ink: k % 2, brush: 22, pts: Array.from({ length: 400 }, (_, i) => [(i * 13 + k) % 256, (i * 7 + k * 3) % 256]) })) };
    const fitted = A.fit(huge);
    t.ok("a picture past the ceiling is fitted under it, never refused, and still a picture", fitted && fitted.bytes.length <= A.DRAWING_BYTES_MAX && A.validate(fitted.bytes) && fitted.drawing.strokes.length > 0,
      fitted ? `${fitted.bytes.length} bytes at eps ${fitted.eps}, ${fitted.drawing.strokes.length} strokes` : "none");
  }

  server = await startServer({ name: "avatar", port });
  await server.start();
  const { origin } = server;
  const day = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
  const person = async (name) => { const p = new Person(origin, name); if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${name}`); return p; };
  const tripOf = async (p, name) => (await p.post("/api/trips", { name, default_tz: "UTC", starts_on: day(1), ends_on: day(4) })).json.trip.id;
  const bring = async (host, trip, joiner, body = {}) => {
    const link = await host.post(`/api/trips/${trip}/links`, { uses: 1 });
    const res = await joiner.post(`/api/join/${link.json.link.code}`, body);
    if (res.status !== 200) throw new CheckError(`couldn't join: ${res.status} ${res.text}`);
  };
  const put = (p, drawing) => p.call("PUT", "/api/me/avatar", { drawing });
  const drop = (p) => p.call("DELETE", "/api/me/avatar");
  const roster = async (p, trip, q = "") => (await p.get(`/api/trips/${trip}${q}`)).json;
  const rowOf = (snap, id) => (snap?.members ?? []).find((m) => m.id === id);
  const revOf = (trip) => server.sql(`SELECT rev FROM trips WHERE id = '${trip}'`)[0].rev;
  const drawings = () => server.sql("SELECT COUNT(*) AS n FROM drawings")[0].n;

  const hana = await person("Hana Mori"), kai = await person("Kai Lund"), stranger = await person("Sol Vey");
  const trip = await tripOf(hana, "Lake week");
  await bring(hana, trip, kai);
  const hanaId = (await hana.me()).id, kaiId = (await kai.me()).id;

  t.part("2. Drawing nothing");
  {
    const snap = await roster(kai, trip);
    const meH = await hana.get("/api/me");
    t.ok("nobody has drawn: no roster row carries an `avatar` key, and /api/me has none",
      snap.members.length === 2 && snap.members.every((m) => !("avatar" in m)) && !("avatar" in meH.json) && drawings() === 0,
      JSON.stringify(snap.members.map((m) => Object.keys(m))));
  }

  t.part("3. One draws; the other sees it within seconds");
  const picture = A.encode({ palette: 3, strokes: [{ ink: 0, brush: 52, pts: [[60, 60], [190, 190]] }, { ink: 1, brush: 22, pts: [[190, 60], [60, 190]] }] });
  const pictureHash = await A.hashOf(picture);
  {
    const sock = listen(origin, kai, trip);
    sockets.push(sock);
    await sock.until(() => sock.lastRev() !== null, 5000);
    const before = revOf(trip), heardBefore = sock.lastRev();
    const sent = Date.now();
    const res = await put(hana, A.toB64url(picture));
    t.same("the picture is taken, named by the hash this process computes from the same bytes", [res.status, res.json?.me?.avatar], [200, pictureHash]);
    const heard = await sock.until(() => (sock.lastRev() ?? 0) > (heardBefore ?? before), 5000);
    t.ok("the trip moved, and Kai's open socket hears its new rev within seconds", revOf(trip) > before && heard,
      `rev ${before} -> ${revOf(trip)}; heard ${heardBefore} -> ${sock.lastRev()} after ${Date.now() - sent} ms`);
    const snap = await roster(kai, trip);
    const delta = await roster(kai, trip, `?since=${before}`);
    t.same("the roster carries Hana's hash, whole and in the delta since the rev before", [rowOf(snap, hanaId)?.avatar, rowOf(delta, hanaId)?.avatar, "avatar" in (rowOf(snap, kaiId) ?? {})], [pictureHash, pictureHash, false]);
    const read = await bytesOf(origin, kai, `/api/avatars/${pictureHash}`);
    t.ok("Kai reads the very bytes Hana sent", read.status === 200 && same(read.bytes, picture) && read.type === "application/octet-stream", `${read.status} ${read.type} ${read.bytes.length} bytes`);
    const revNow = revOf(trip);
    const again = await put(hana, A.toB64url(picture));
    t.same("the same picture again: answered as the first, nothing written (the trip doesn't move)", [again.status, again.json?.me?.avatar, revOf(trip)], [200, pictureHash, revNow]);
  }

  t.part("4. Who may read one");
  {
    const own = await bytesOf(origin, hana, `/api/avatars/${pictureHash}`);
    const out = await bytesOf(origin, new Person(origin, "nobody"), `/api/avatars/${pictureHash}`);
    const far = await bytesOf(origin, stranger, `/api/avatars/${pictureHash}`);
    const unknown = await bytesOf(origin, kai, "/api/avatars/AAAAAAAAAAAA");
    t.same("its own 200; someone on no trip with it 404 (as a name nobody holds); signed out 401",
      [own.status, far.status, unknown.status, out.status], [200, 404, 404, 401]);
    // Kai draws, then leaves: Hana still sees Kai's picture (Kai stays on the roster, marked as left); Kai no longer
    // sees Hana's.
    const kaiPic = A.encode({ palette: 6, strokes: [{ ink: 0, brush: A.BRUSH_FILL, pts: [[127, 127]] }] });
    const kaiHash = (await put(kai, A.toB64url(kaiPic))).json?.me?.avatar;
    const left = await kai.call("DELETE", `/api/trips/${trip}/members/${kaiId}`);
    const hanaReadsKai = await bytesOf(origin, hana, `/api/avatars/${kaiHash}`);
    const kaiReadsHana = await bytesOf(origin, kai, `/api/avatars/${pictureHash}`);
    t.same("after Kai leaves: Hana still reads Kai's picture (Kai is on the roster, as left); Kai reads Hana's no more",
      [left.status, hanaReadsKai.status, kaiReadsHana.status], [200, 200, 404]);
  }

  t.part("5. A guest; what's refused; the hour's limit");
  {
    const guest = new Person(origin, "x");
    await bring(hana, trip, guest, { name: "Ivo Guest" });
    const g = await put(guest, A.toB64url(A.encode({ palette: 0, strokes: [{ ink: 0, brush: 52, pts: [[10, 10], [240, 240]] }] })));
    const gMe = await guest.me();
    t.ok("a guest draws too, and the trip's host reads it", g.status === 200 && gMe.guest === true && !!gMe.avatar
      && (await bytesOf(origin, hana, `/api/avatars/${gMe.avatar}`)).status === 200, `${g.status} ${JSON.stringify(gMe)}`);
    const lia = await person("Lia Park");
    const big = "A".repeat(A.DRAWING_B64_MAX + 4);
    const tries = [await lia.call("PUT", "/api/me/avatar", {}), await put(lia, "not base64!"), await put(lia, A.toB64url(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))), await put(lia, big)];
    t.same("nothing sent, not base64url, not a picture, past the ceiling: refused in words, nothing stored",
      [...tries.map((r) => r.status), tries.every((r) => typeof r.json?.reason === "string"), "avatar" in (await lia.me())], [400, 400, 400, 413, true, false]);
    const one = A.toB64url(A.encode({ palette: 1, strokes: [{ ink: 0, brush: 52, pts: [[1, 1]] }] }));
    let last = null;
    for (let i = 0; i < AVATAR_WRITES_PER_HOUR; i++) last = i % 2 ? await drop(lia) : await put(lia, one);
    const held = (await lia.me()).avatar ?? null;
    const over = AVATAR_WRITES_PER_HOUR % 2 ? await drop(lia) : await put(lia, one);
    const after = (await lia.me()).avatar ?? null;
    t.ok(`${AVATAR_WRITES_PER_HOUR} changes in an hour go through; the next is 429 in words with when to try again, and changes nothing`,
      last.status === 200 && over.status === 429 && /in an hour/.test(over.json?.reason ?? "") && Number(over.headers.find(([k]) => k === "retry-after")?.[1]) > 0 && after === held,
      `${last.status}, then ${over.status} ${over.json?.reason ?? ""}`);
  }

  t.part("6. One stored picture for the same bytes; gone when nobody holds it; in the data download");
  {
    const mo = await person("Mo Reyes");
    const n0 = drawings();
    await put(mo, A.toB64url(picture));
    t.same("Mo sends the very bytes Hana did: the same name, still one stored picture", [(await mo.me()).avatar, drawings()], [pictureHash, n0]);
    const exp = (await hana.get("/api/account/export")).json;
    t.ok("Hana's data download carries her picture: its name, its strokes and its bytes as stored",
      exp?.account?.picture?.hash === pictureHash && JSON.stringify(exp.account.picture.drawing) === JSON.stringify(A.decode(picture)) && exp.account.picture.bytes === A.toB64url(picture),
      JSON.stringify(exp?.account?.picture ?? null).slice(0, 200));
    const back = await drop(hana);
    t.same("Hana back to initials: her row has none, and the picture stays while Mo holds it", [back.status, "avatar" in back.json.me, drawings(), rowOf(await roster(hana, trip), hanaId) && "avatar" in rowOf(await roster(hana, trip), hanaId)], [200, false, n0, false]);
    const gone = await mo.call("DELETE", "/api/me", { confirm: "delete" });
    t.same("Mo's account deleted: nobody holds it now, and it is gone", [gone.status, drawings(), server.sql(`SELECT COUNT(*) AS n FROM drawings WHERE hash = '${pictureHash}'`)[0].n], [200, n0 - 1, 0]);
    const none = (await stranger.get("/api/account/export")).json;
    t.ok("a download of someone who never drew (Sol) has no `picture` key", none?.account && !("picture" in none.account), JSON.stringify(Object.keys(none?.account ?? {})));
  }
  const orphans = server.sql("SELECT COUNT(*) AS n FROM drawings WHERE hash NOT IN (SELECT avatar FROM users WHERE avatar IS NOT NULL)")[0].n;
  t.same("at the end, no stored picture that nobody holds", orphans, 0);
  code = t.end();
} catch (e) {
  console.error(e instanceof CheckError ? `couldn't run: ${e.message}` : e);
  code = 2;
} finally {
  for (const s of sockets) s.close();
  if (server) await server.stop();
}
process.exit(code);

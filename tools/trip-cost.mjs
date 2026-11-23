// WHAT ONE BIG TRIP COSTS, read off the database. A made-up trip about ten times the first one's size goes in
// through the routes on a fresh local database: 20 people, 30 days, ~600 plans, ~2,000 places (a trip holds at most 2,000: PLACES_MAX), 5,000 chat
// messages, ~420 purchases, 300 memories with their photos, and a year of changes (each made as an app makes
// one, through the MCP). Then every route a phone calls in a day's use is called, three times each, and D1's
// own count of rows read and written (each query's meta, src/query-count.js), the answer's size and its time
// on the local Worker are written down. report.md: the table, sorted by rows read, and the month.
//
//   node tools/trip-cost.mjs --out <a new folder> [--port 8899] [--keep] [--detail]
//
// 8899 is outside every port a check names (8791–8805, 8812–8876): this runs for 20 minutes and may run while a gate does.
//
// --detail: each request's queries one by one too (COUNT_QUERIES=detail), in detail.md: every query that read
// 100 rows or more, with its rows read, for each route measured.
//
// Everything in it is made up (seed/demo-trip.json, copied and spread out; names below). Nothing leaves this
// machine. --keep leaves the server running at the end for a look (Ctrl-C stops it).

import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { startServer, CheckError } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { startModel } from "../checks/lib/model-standin.mjs";
import { demoTripOn, loadDemo } from "../checks/lib/demo.mjs";
import { connect, McpClient } from "../checks/lib/mcp.mjs";

const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const OUT = flag("--out");
const port = Number(flag("--port") ?? 8899);
if (!OUT) { console.error("--out <a new folder> is needed"); process.exit(2); }
if (fs.existsSync(path.join(OUT, "report.md"))) { console.error(`${OUT} holds a report already`); process.exit(2); }

// ── the big seed: the made-up trip, spread over 30 days and 20 people ──
const DAY = 86400;
const MORE = ["Bo Lindqvist", "Cai Moreno", "Dara Quinn", "Edda Holm", "Femi Adeyemi", "Gil Navarro", "Hana Ito", "Ivo Petrov", "Jun Park",
  "Kofi Mensah", "Lena Varga", "Mika Saarinen", "Noor Haddad", "Otto Brandt", "Pia Rossi", "Ravi Menon"];
function bigSeed() {
  const s = loadDemo();
  const base = s.people.map((p) => p.key);                         // 4: the host first
  const people = [...s.people, ...MORE.map((name, i) => ({ key: `p${String(i + 5).padStart(2, "0")}`, name }))];
  const groups = [0, 1, 2, 3, 4].map((g) => people.slice(g * 4, g * 4 + 4).map((p) => p.key)); // 5 groups of 4
  const who = (key, k) => groups[k % 5][base.indexOf(key)] ?? key;
  const PLACE_COPIES = 6, EVENT_COPIES = 10, MONEY_COPIES = 10;
  const pid = (id, k) => (id && k ? `${id}-${k}` : id);
  const places = [];
  for (let k = 0; k < PLACE_COPIES; k++) for (const p of s.places) {
    places.push({ ...p, id: pid(p.id, k), name: k ? `${p.name} ${k + 1}` : p.name, ...(p.near_anchor ? { near_anchor: pid(p.near_anchor, k) } : {}) });
  }
  const events = [];
  for (let k = 0; k < EVENT_COPIES; k++) for (const e of s.events) {
    events.push({ ...e, id: pid(e.id, k), starts_at: e.starts_at + k * 2 * DAY, ...(e.ends_at ? { ends_at: e.ends_at + k * 2 * DAY } : {}),
      ...(e.place_id ? { place_id: pid(e.place_id, k % PLACE_COPIES) } : {}) });
  }
  const purchases = [], payments = [];
  for (let k = 0; k < MONEY_COPIES; k++) {
    for (const p of s.purchases) purchases.push({ ...p, id: pid(p.id, k), paid_by: who(p.paid_by, k), spent_at: p.spent_at + k * 2 * DAY,
      shares: p.shares.map((x) => ({ ...x, person: who(x.person, k) })), ...(p.event_id ? { event_id: pid(p.event_id, k) } : {}), ...(p.place_id ? { place_id: pid(p.place_id, k % PLACE_COPIES) } : {}) });
    for (const p of s.payments ?? []) payments.push({ ...p, id: pid(p.id, k), ...Object.fromEntries(["from", "to", "paid_by", "person"].filter((f) => p[f]).map((f) => [f, who(p[f], k)])),
      ...(p.shares ? { shares: p.shares.map((x) => ({ ...x, person: who(x.person, k) })) } : {}), ...(p.spent_at ? { spent_at: p.spent_at + k * 2 * DAY } : {}) });
  }
  const packing_items = [];
  for (let g = 0; g < 5; g++) for (const it of s.packing_items) {
    if (it.owner === "group" && g) continue;
    packing_items.push({ ...it, id: pid(it.id, g), owner: it.owner === "group" ? "group" : who(it.owner, g) });
  }
  return { ...s, trip: { ...s.trip, name: "Thirty days, twenty people (a made-up trip)", ends_on: "2027-06-30" }, people, places, events, purchases, payments, packing_items };
}

// ── a seeded random number, so every run makes the same trip ──
let seedN = 20271116;
const rnd = () => { seedN = (seedN * 1103515245 + 12345) % 2147483648; return seedN / 2147483648; };
const pick = (list) => list[Math.floor(rnd() * list.length)];
// A write that hit a limit (429) waits as the answer says, or 5 s, and goes again: the build keeps to the
// app's own limits (30 chat messages a minute a person, 300 MCP calls a minute an account).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function patiently(send) {
  for (let tries = 0; ; tries++) {
    const r = await send();
    const limited = r.status === 429 || (r.isError && /429|too many/i.test(JSON.stringify(r.json ?? r)));
    if (!limited || tries > 40) return r;
    await sleep(1000 * (Number(r.json?.retry_after) || 5));
  }
}
const pool = async (n, width, fn) => { let i = 0; await Promise.all(Array.from({ length: width }, async () => { while (i < n) await fn(i++); })); };

const say = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
let server, model;
try {
  model = await startModel({ key: "sk-or-cost-not-real" });
  // Push keys, so a phone's subscription can be told again (PUT /api/account/push) as the chat does on opening. Nothing is
  // sent anywhere: only the measuring member subscribes, and a person's own message notifies nobody's phone of theirs.
  const b64url = (u8) => Buffer.from(u8).toString("base64url");
  const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const vapidJwk = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);
  const VAPID = { VAPID_PUBLIC_KEY: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", vapidPair.publicKey))),
    VAPID_PRIVATE_KEY: JSON.stringify({ kty: vapidJwk.kty, crv: vapidJwk.crv, d: vapidJwk.d, x: vapidJwk.x, y: vapidJwk.y }) };
  const phoneKey = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])).publicKey)));
  server = await startServer({
    name: "trip-cost", port,
    vars: { COUNT_QUERIES: argv.includes("--detail") ? "detail" : "on", PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true",
      ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5", OPENROUTER_API_BASE: model.base },
    secrets: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", OPENROUTER_API_KEY: "sk-or-cost-not-real", ...VAPID },
  });
  await server.start();
  const seed = bigSeed();
  say(`a fresh server on ${server.origin}; putting in ${seed.people.length} people, ${seed.places.length} places, ${seed.events.length} plans, ${seed.purchases.length} purchases…`);
  const demo = await demoTripOn(server.origin, seed);
  const T = `/api/trips/${demo.tripId}`;
  const keys = seed.people.map((p) => p.key);
  const now = Math.floor(Date.now() / 1000);
  server.sql(`INSERT INTO billing_subscriptions (id, user_id, customer, status, interval, current_period_end, held, updated_at, synced_at)
    VALUES ('sub_cost', '${demo.ids[keys[0]]}', 'cus_cost', 'active', 'month', ${now + 30 * DAY}, 0, ${now}, ${Date.now()})`);

  say("5,000 chat messages, one in five about a plan or a place…");
  const LINES = ["Who's up for an early start?", "I'll bring the snacks.", "Meet at the door at nine.", "The bus was late again.", "Anyone seen my charger?",
    "That view was worth the climb.", "Booked it.", "Can we move dinner to eight?", "I'm in.", "Rain tomorrow, bring a jacket."];
  await pool(5000, 20, async (i) => {
    const by = demo.people[keys[i % keys.length]];
    const about = i % 5 === 0 ? (i % 10 === 0 ? { kind: "event", id: pick(seed.events).id } : { kind: "place", id: pick(seed.places).id }) : undefined;
    const r = await patiently(() => by.post(`${T}/messages`, { id: `m-${i}`, body: `${pick(LINES)} (${i})`, ...(about ? { about } : {}) }));
    if (r.status !== 201) throw new CheckError(`message ${i}: ${r.status} ${r.text.slice(0, 200)}`);
  });

  say("300 memories, each with a photo uploaded by its author…");
  const photo = Buffer.alloc(8 * 1024, 7);
  await pool(300, 4, async (i) => {
    const by = demo.people[pick(keys)];
    const b = await by.post(`${T}/media/begin`, { name: `m${i}.jpg`, mime: "image/jpeg", bytes: photo.length, kind: "photo" });
    const pt = await by.call("PUT", `${T}/media/part?key=${encodeURIComponent(b.json.key)}&id=${encodeURIComponent(b.json.uploadId)}&n=1`, photo, { headers: { "Content-Type": "application/octet-stream" } });
    await by.post(`${T}/media/finish`, { key: b.json.key, id: b.json.uploadId, parts: [{ n: 1, etag: pt.json?.etag }] });
    const m = await patiently(() => by.post(`${T}/memories`, { id: `mem-${i}`, caption: `Day ${1 + (i % 30)}`, media: [{ key: b.json.key, w: 10, h: 10 }] }));
    if (m.status !== 201) throw new CheckError(`memory ${i}: ${m.status} ${m.text.slice(0, 200)}`);
  });

  say("a year of changes: 1,500 notes on places, each written by an app as its own change…");
  const host = demo.people[keys[0]];
  const app = await connect(server.origin, host, { name: "Cost App", address: host.address });
  if (app.tokens?.status !== 200) throw new CheckError("couldn't connect an app");
  const mcp = new McpClient(server.origin, app.tokens.json.access_token);
  await mcp.initialize();
  await pool(1500, 4, async (i) => {
    const r = await patiently(() => mcp.call("put_places", { trip_id: demo.tripId, summary: `A note (${i})`, places: [{ id: pick(seed.places).id, notes: `Checked again (${i}).` }] }));
    if (r.isError) throw new CheckError(`change ${i}: ${JSON.stringify(r.json ?? r).slice(0, 200)}`);
  });
  // A conversation of the member's own with the assistant (two turns), for its reads.
  const member = demo.people[keys[1]];
  await member.post(`${T}/assistant/conversations`, { id: "c-cost" });
  model.next({ words: "Day 3 has a boat trip at eleven." });
  await member.post(`${T}/assistant/conversations/c-cost/ask`, { id: "q-cost", words: "What's on day 3?" });

  const counts = Object.fromEntries(["places", "events", "messages", "purchases", "memories", "trip_changes", "packing_items", "trip_members"].map((t) =>
    [t, server.sql(`SELECT COUNT(*) AS n FROM ${t} WHERE trip_id = '${demo.tripId}'`)[0].n]));
  say(`the trip: ${JSON.stringify(counts)}`);

  // ── each route a phone calls, measured ──
  const seen = () => server.log().split("\n").filter((l) => l.startsWith('{"d1_queries"')).map((l) => JSON.parse(l));
  const items = (j) => { if (Array.isArray(j)) return j.length; if (!j || typeof j !== "object") return 0; return Object.values(j).reduce((s, v) => s + (Array.isArray(v) ? v.length : 0), 0); };
  const rows = [];
  const details = [];
  async function measure(label, doIt, { tool = null, writes = false } = {}) {
    const runs = [];
    for (let k = 0; k < 3; k++) {
      const before = seen().length;
      const t0 = performance.now();
      const r = await doIt(k);
      const ms = performance.now() - t0;
      let line = null;
      for (let w = 0; w < 50 && !line; w++) {
        const now = seen().slice(before);
        line = (tool ? now.find((l) => l.tool === tool) : now.at(-1)) ?? null;
        if (!line) await new Promise((res) => setTimeout(res, 50));
      }
      // What a phone downloads: Cloudflare compresses a dynamic answer at brotli 4 for a browser that takes br
      // (Safari sends "gzip, deflate, br"), gzip 8 otherwise (blog.cloudflare.com/this-is-brotli-from-origin).
      // The local server doesn't compress, so these are the same bytes compressed as the edge would.
      const body = Buffer.from(r.text ?? JSON.stringify(r.json ?? r));
      const br4 = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } }).length;
      const gz8 = zlib.gzipSync(body, { level: 8 }).length;
      runs.push({ status: r.status ?? (r.isError ? 400 : 200), bytes: body.length, br4, gz8, ms, items: items(r.json),
        q: line?.d1_queries ?? null, read: line?.rows_read ?? null, written: line?.rows_written ?? null, detail: line?.detail ?? null });
    }
    const mid = (f) => runs.map((x) => x[f]).sort((a, b) => a - b)[1];
    if (runs[1].detail) details.push({ label, queries: runs[1].detail.filter((d) => d.read >= 100).sort((a, b) => b.read - a.read) });
    rows.push({ label, status: runs[1].status, queries: mid("q"), read: mid("read"), written: mid("written"), kb: mid("bytes") / 1024, br4kb: mid("br4") / 1024, gz8kb: mid("gz8") / 1024, ms: mid("ms"), items: mid("items"), writes });
    say(`  ${label}: ${mid("read")} rows read, ${mid("written")} written, ${(mid("bytes") / 1024).toFixed(1)} KB, ${mid("ms").toFixed(0)} ms`);
  }
  const ev = seed.events[300], pl = seed.places[1500];
  // The local server, asked as Safari asks: what encoding it answers (none is expected: wrangler dev doesn't compress).
  {
    const safari = await fetch(`${server.origin}${T}`, { headers: { Cookie: member.jar.header(), "Accept-Encoding": "gzip, deflate, br", Origin: server.origin } });
    const got = Buffer.from(await safari.arrayBuffer());
    say(`  asked as Safari asks: Content-Encoding ${safari.headers.get("content-encoding") ?? "none"}, ${(got.length / 1024).toFixed(1)} KB as it came`);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "safari.json"), JSON.stringify({ content_encoding: safari.headers.get("content-encoding"), bytes: got.length }) + "\n");
  }
  say("measuring, as a member (and an app for the MCP's reads)…");
  await measure("GET /api/me (every refresh)", () => member.get("/api/me"));
  await measure("GET /api/trips/:trip, the whole trip (every refresh)", () => member.get(T));
  // Since my last (0036): a phone holding the trip at rev R asks for what changed after it.
  {
    const held = (await member.get(`${T}/rev`)).json.rev;
    await measure("GET /api/trips/:trip?since=<held>, nothing changed", () => member.get(`${T}?since=${held}`));
    const other = demo.people[keys[2]];
    await measure("GET /api/trips/:trip?since=<held>, after one plan changed", async (k) => {
      await other.call("PATCH", `${T}/events/${encodeURIComponent(seed.events[10 + k].id)}`, { detail: `Changed ${k}` });
      return member.get(`${T}?since=${held}`);
    });
    await measure("GET /api/trips/:trip?since=<held>, after one place deleted", async (k) => {
      const id = `p-measure-${k}`;
      await other.call("PUT", `${T}/places`, { places: [{ id, name: `Measured ${k}`, kind: "sight", subkind: "viewpoint", why: "Measured." }] });
      const before = (await member.get(`${T}/rev`)).json.rev;
      const gone = await other.call("DELETE", `${T}/places/${id}`);
      if (gone.status !== 200) throw new CheckError(`a place to delete: ${gone.status}`);
      return member.get(`${T}?since=${before}`);
    });
  }
  await measure("GET /api/trips (Your trips)", () => member.get("/api/trips"));
  await measure("GET …/rev", () => member.get(`${T}/rev`));
  await measure("GET …/messages?limit=50 (the chat opens)", () => member.get(`${T}/messages?limit=50`));
  await measure("GET …/messages?after=<last>&limit=200 (the chat catches up)", () => member.get(`${T}/messages?after=4990&limit=200`));
  await measure("GET …/messages?before=<oldest>&limit=50 (scrolling back)", () => member.get(`${T}/messages?before=2500&limit=50`));
  await measure("GET …/messages?about=event:<id> (said about a plan)", () => member.get(`${T}/messages?about=event:${encodeURIComponent(ev.id)}&limit=200`));
  await measure("GET …/messages?about=place:<id> (said about a place)", () => member.get(`${T}/messages?about=place:${encodeURIComponent(pl.id)}&limit=200`));
  await measure("GET …/changes (the list of changes)", () => member.get(`${T}/changes`));
  await measure("GET …/memories (Memories)", () => member.get(`${T}/memories`));
  await measure("GET …/memories/tags", () => member.get(`${T}/memories/tags`));
  await measure("GET …/assistant (the assistant's room)", () => member.get(`${T}/assistant`));
  await measure("GET …/assistant/conversations/:id", () => member.get(`${T}/assistant/conversations/c-cost`));
  await measure("GET /api/account/plan", () => member.get("/api/account/plan"));
  await measure("GET /api/account/storage", () => member.get("/api/account/storage"));
  await measure("POST /api/fx/refresh (Split opens)", () => member.post("/api/fx/refresh", {}));
  await measure("POST …/messages (a message)", (k) => member.post(`${T}/messages`, { id: `m-measure-${k}`, body: "Measured." }), { writes: true });
  await measure("PATCH …/events/:id (a plan changed)", (k) => member.call("PATCH", `${T}/events/${encodeURIComponent(ev.id)}`, { detail: `Measured ${k}` }), { writes: true });
  await measure("POST …/purchases (a purchase)", (k) => member.post(`${T}/purchases`, { id: `pu-measure-${k}`, description: "Measured", amount_minor: 1000, currency: "PEN", paid_by: demo.ids[keys[1]], spent_at: seed.events[0].starts_at, split_mode: "weight", shares: [{ user_id: demo.ids[keys[1]], weight: 1, share_minor: 1000 }] }), { writes: true });
  // Since 16 Nov: what a phone sends on its own (its push subscription each time the chat opens, a page's error report),
  // a person's export, and a guest joining by the link and being sent a link back in by the host.
  await measure("PUT /api/account/push (a notified phone opens the chat)", () => member.call("PUT", "/api/account/push",
    { endpoint: "https://fcm.googleapis.com/fcm/send/trip-cost-member", keys: { p256dh: phoneKey, auth: b64url(new Uint8Array(16).fill(7)) }, words: true }), { writes: true });
  await measure("POST /api/errors (a page's error report)", (k) => member.post("/api/errors",
    { kind: "error", name: "TypeError", message: `Measured ${k}`, stack: "at /js/app.js:1:1", file: "/js/app.js", line: 1, col: 1, place: "/t/:trip/", version: "v-cost" }), { writes: true });
  await measure("GET /api/account/export?day= (a person's export)", () => member.get(`/api/account/export?day=${new Date().toISOString().slice(0, 10)}`));
  const guestLink = (await host.post(`${T}/links`, { uses: 10 })).json.link.code;
  const guests = [];
  await measure("POST /api/join/:code as a guest (a friend joins with a name)", async (k) => {
    const g = new Person(server.origin, `Guest ${k + 1}`);
    const r = await g.post(`/api/join/${guestLink}`, { name: `Guest ${k + 1}` });
    guests.push(g.jar.cookies.get("wgp_who") ?? null);      // its id, from the page's note of who (no request: the last one measured is the join)
    return r;
  }, { writes: true });
  await measure("POST …/members/:guest/rejoin (the host's link back in)", (k) => host.post(`${T}/members/${encodeURIComponent(guests[k] ?? "")}/rejoin`, {}), { writes: true });
  for (const [tool, args] of [["get_trip", {}], ["list_events", {}], ["list_places", {}], ["get_packing", {}], ["get_split", {}], ["list_messages", {}], ["list_changes", {}]]) {
    await measure(`MCP ${tool}`, () => mcp.call(tool, { trip_id: demo.tripId, ...args }), { tool });
  }

  // ── the report ──
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "results.json"), `${JSON.stringify({ made: new Date().toISOString(), trip: counts, routes: rows }, null, 2)}\n`);
  const sorted = [...rows].sort((a, b) => b.read - a.read);
  const md = ["| Route | Rows read | Rows written | Queries | Things answered | Answer | On the wire (brotli 4 / gzip 8) | Time (local) |", "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...sorted.map((r) => `| ${r.label} | ${r.read.toLocaleString("en-US")} | ${r.written.toLocaleString("en-US")} | ${r.queries} | ${r.items.toLocaleString("en-US")} | ${r.kb.toFixed(1)} KB | ${r.br4kb.toFixed(1)} / ${r.gz8kb.toFixed(1)} KB | ${r.ms.toFixed(0)} ms |`)];
  fs.writeFileSync(path.join(OUT, "table.md"), `${md.join("\n")}\n`);
  if (details.length) fs.writeFileSync(path.join(OUT, "detail.md"), details.filter((d) => d.queries.length).map((d) =>
    [`## ${d.label}`, "", "| Rows read | The query (its first words) |", "|---:|---|", ...d.queries.map((q) => `| ${q.read.toLocaleString("en-US")} | \`${q.sql.replace(/\|/g, "\\|")}\` |`), ""].join("\n")).join("\n"));
  say(`written: ${path.resolve(OUT)}/results.json and table.md`);
  if (argv.includes("--keep")) { say(`kept on ${server.origin}; Ctrl-C stops it`); await new Promise(() => {}); }
} catch (error) {
  console.error(error instanceof CheckError ? `CAN'T: ${error.message}` : error);
  process.exitCode = 1;
} finally {
  if (!argv.includes("--keep")) { await server?.stop(); await model?.close(); }
}

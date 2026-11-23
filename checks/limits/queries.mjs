// Every request within the free plan's 50 D1 queries (src/query-count.js):
// the app's heaviest requests on a trip the size of the first one, and every MCP tool at its
// largest allowed batch. Each number is printed, and held to QUERY_CEILING, so a later change that
// adds a query per row fails here.
//
//   npm run check:queries        (a few minutes; its own server on 8791)
//
// The big trip is the made-up demo trip (seed/demo-trip.json, from tools/demo-seed.mjs: the first
// trip's size, 331 places and 60 events), put in whole by checks/lib/demo.mjs: its four people,
// their purchases, payments, packing items and pictures; the batches are made-up rows. Everyone here is made up.

import fs from "node:fs";
import path from "node:path";
import { CheckError, ROOT, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { McpClient, connect } from "../lib/mcp.mjs";
import { demoTrip } from "../../tools/demo-seed.mjs";
import { demoTripOn } from "../lib/demo.mjs";
import { ROWS_PER_WRITE_MAX } from "../../public/js/shared/limits.js";

export const QUERY_CEILING = 50;
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const t = new Report(`every request within ${QUERY_CEILING} D1 queries`);
let server;
let code = 1;
const rows = [];

/** The queries the last request (or tool call) made, read from the server's log after `mark`. */
function lastCount(mark, match) {
  const lines = server.log().slice(mark).split("\n").filter((l) => l.includes('"d1_queries"'));
  const found = lines.map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean).filter(match);
  return found.at(-1)?.d1_queries ?? null;
}
/** D1's own rows read by the last request matching, after `mark` (src/query-count.js). */
function lastRead(mark, match) {
  const lines = server.log().slice(mark).split("\n").filter((l) => l.includes('"d1_queries"'));
  const found = lines.map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean).filter(match);
  return found.at(-1)?.rows_read ?? null;
}
async function measure(what, run, match) {
  const mark = server.log().length;
  const res = await run();
  await new Promise((r) => setTimeout(r, 150));     // the log line follows the answer
  const n = lastCount(mark, match);
  rows.push([what, n]);
  return { res, n };
}
const hold = (what, n, extra = true, detail = "") => t.ok(`${what}: ${n} queries`, n !== null && n <= QUERY_CEILING && extra, detail);

try {
  server = await startServer({ name: "queries", port, vars: { COUNT_QUERIES: "detail" } });
  await server.start();
  const seedText = fs.readFileSync(path.join(ROOT, "seed/demo-trip.json"), "utf8");
  t.ok("(the demo trip's file is what tools/demo-seed.mjs makes: no hand edit, no generator change left unwritten)", seedText === JSON.stringify(demoTrip(), null, 2) + "\n");
  const demo = await demoTripOn(server.origin, JSON.parse(seedText));
  const { seed, host } = demo;
  const friend = demo.people[seed.people.find((p) => !p.host).key];
  const big = demo.tripId;
  const snap = (await host.get(`/api/trips/${big}`)).json;
  const pictured = snap.places.filter((p) => p.picture).length + snap.events.filter((e) => e.picture).length + snap.purchases.filter((p) => p.receipt).length + (snap.trip.cover ? 1 : 0);
  // The host's snapshot holds the group's items and the host's own, never another person's list.
  const hostSees = seed.packing_items.filter((i) => i.owner === "group" || i.owner === seed.people.find((p) => p.host).key).length;
  t.same(`(the big trip: the first trip's size, its four people, 42 purchases and 3 payments, 40 packing items (the host sees ${hostSees}: theirs and the group's), 13 pictures)`,
    [snap.places.length, snap.events.length, snap.purchases.length, snap.packing.length, pictured, demo.filled],
    [331, 60, 45, hostSees, 13, { purchases: 42, payments: 3, items: 40, pictures: 13 }]);

  t.part("The app's heaviest requests, on that trip");
  const path_ = (p) => (l) => l.path === p && !l.tool;
  hold("the trip's whole snapshot (GET /api/trips/<id>)", (await measure("snapshot", () => host.get(`/api/trips/${big}`), path_(`/api/trips/${big}`))).n);
  hold("the host's storage meter", (await measure("storage meter", () => host.get("/api/account/storage"), path_("/api/account/storage"))).n);
  hold("the trips list", (await measure("trips list", () => host.get("/api/trips"), path_("/api/trips"))).n);
  hold("the trip's people", (await measure("people", () => host.get(`/api/trips/${big}/people`), path_(`/api/trips/${big}/people`))).n);
  hold("the packing (GET …/packing)", (await measure("packing", () => host.get(`/api/trips/${big}/packing`), path_(`/api/trips/${big}/packing`))).n);
  hold("Split's purchases", (await measure("purchases", () => host.get(`/api/trips/${big}/purchases`), path_(`/api/trips/${big}/purchases`))).n);
  const chat = `/api/trips/${big}/messages`;
  const about = { kind: "event", id: seed.events[0].id };
  for (let i = 0; i < 5; i++) await friend.post(chat, { id: `msg-${i}`, body: `Hello ${i}`, about });
  hold("a message about an event (POST …/messages)", (await measure("message", () => host.post(chat, { id: "msg-h", body: "On my way", about }), path_(chat))).n);
  hold("the chat's largest window (GET …/messages?limit=100)", (await measure("chat window", () => host.get(`${chat}?limit=100`), path_(chat))).n);
  hold("what changed in the chat (GET …/messages?after=0)", (await measure("chat changes", () => host.get(`${chat}?after=0&limit=100`), path_(chat))).n);
  hold("a message changed (PATCH …/messages/<id>)", (await measure("message edit", () => host.call("PATCH", `${chat}/msg-h`, { body: "Here" }), path_(`${chat}/msg-h`))).n);
  hold("a message deleted by the host (DELETE …/messages/<id>)", (await measure("message delete", () => host.call("DELETE", `${chat}/msg-0`), path_(`${chat}/msg-0`))).n);
  // Rows read, where one message must not read the whole chat: four people fill it as fast as the limit
  // lets them (23 each, with what they sent above, under 30 in the minute), then the host's next message is measured.
  for (const [k, who] of [host, ...seed.people.filter((p) => !p.host).map((p) => demo.people[p.key])].entries()) {
    for (let i = 0; i < 23; i++) { const r = await who.post(chat, { id: `fill-${k}-${i}`, body: `Filling ${i}` }); if (r.status !== 201) throw new CheckError(`a message to fill the chat: ${r.status}`); }
  }
  const inChat = server.sql(`SELECT COUNT(*) AS n FROM messages WHERE trip_id = '${big}'`)[0].n;
  const markRead = server.log().length;
  const posted = await host.post(chat, { id: "msg-read", body: "Measured" });
  await new Promise((r) => setTimeout(r, 150));
  const readBy = lastRead(markRead, path_(chat));
  t.ok(`a message posted reads its sender's last minute, not the whole chat: ${readBy} rows read with ${inChat} messages in it`,
    posted.status === 201 && readBy !== null && readBy < inChat / 2, String(readBy));
  // Rows read by a purchase: a trip far from the cap isn't counted (src/api/purchases.js counts only once its rev could
  // be there); the count read every purchase of the trip on every purchase.
  {
    const held = server.sql(`SELECT COUNT(*) AS n FROM purchases WHERE trip_id = '${big}'`)[0].n;
    const markBuy = server.log().length;
    const bought = await host.post(`/api/trips/${big}/purchases`, { id: "pu-read", description: "Measured", amount_minor: 100, currency: "USD",
      paid_by: host.user.id, spent_at: Math.floor(Date.now() / 1000), split_mode: "weight", shares: [{ user_id: host.user.id, weight: 1, share_minor: 100 }] });
    await new Promise((r) => setTimeout(r, 150));
    const buyRead = lastRead(markBuy, path_(`/api/trips/${big}/purchases`));
    t.ok(`a purchase reads what it writes, not every purchase of the trip: ${buyRead} rows read with ${held} purchases on it`,
      bought.status === 201 && buyRead !== null && buyRead < held, `${bought.status} ${buyRead}`);
  }
  hold("the chat muted (PUT …/chat/mute)", (await measure("mute", () => host.call("PUT", `/api/trips/${big}/chat/mute`, { muted: true }), path_(`/api/trips/${big}/chat/mute`))).n);
  hold("the trip's map made again (POST …/tiles/cut; a site without a map maker answers at once)", (await measure("map cut", () => host.post(`/api/trips/${big}/tiles/cut`), path_(`/api/trips/${big}/tiles/cut`))).n);
  hold("a map upload made the trip's (POST …/tiles/use, one that isn't there)", (await measure("map use", () => host.post(`/api/trips/${big}/tiles/use`, { key: "o/ab/none/x.pmtiles" }), path_(`/api/trips/${big}/tiles/use`))).n);
  hold("the host's storage meter, with the map's line", (await measure("meter with map", () => host.get("/api/account/storage"), path_("/api/account/storage"))).n);

  t.part(`Every MCP tool at its largest batch (${ROWS_PER_WRITE_MAX} rows)`);
  const c = await connect(server.origin, host, { address: host.address, name: "Queries App" });
  const mcp = new McpClient(server.origin, c.tokens.json.access_token);
  await mcp.initialize();
  // The snapshot's newest change (src/trips/changes.js newestChangeFor): 60 changes by the host's app, then
  // a member's snapshot reads the newest of them, not the month of them.
  for (let i = 0; i < 60; i++) {
    const r = await mcp.call("put_places", { trip_id: big, summary: `A note (${i})`, places: [{ id: seed.places[i].id, notes: `Checked (${i}).` }] });
    if (r.isError) throw new CheckError(`a change on the big trip: ${JSON.stringify(r.json ?? r).slice(0, 200)}`);
  }
  {
    const mark = server.log().length;
    await friend.get(`/api/trips/${big}`);
    await new Promise((r) => setTimeout(r, 150));
    const line = server.log().slice(mark).split("\n").filter((l) => l.includes('"d1_queries"')).map((l) => JSON.parse(l.slice(l.indexOf("{")))).filter(path_(`/api/trips/${big}`)).at(-1);
    const newest = (line?.detail ?? []).find((d) => /FROM trip_changes/.test(d.sql) && /rev/.test(d.sql.slice(0, 30)));
    t.ok(`the snapshot's newest change reads from the newest end, not the month: ${newest?.read} rows read with 60 changes`, newest && newest.read < 10, JSON.stringify(newest));
  }
  const tool = async (name, args, label = name) => {
    const { res, n } = await measure(label, () => mcp.call(name, args), (l) => l.tool === name);
    hold(`${label}`, n, !res.isError, res.isError ? res.text.slice(0, 200) : "");
    return res;
  };
  const made = await mcp.call("create_trip", { name: "Queries trip", starts_on: "2027-03-01", ends_on: "2027-03-31", default_tz: "UTC" });
  const T = made.json.trip.id;
  const N = ROWS_PER_WRITE_MAX;
  await tool("put_areas", { trip_id: T, summary: "Areas", areas: [{ id: "town", name: "Town", west: -1, south: -1, east: 1, north: 1 }, ...Array.from({ length: N - 1 }, (_, i) => ({ id: `a-${i}`, name: `Area ${i}`, parent: "town" }))] }, `put_areas (${N})`);
  await tool("put_places", { trip_id: T, summary: "Places", places: Array.from({ length: N }, (_, i) => ({ id: `p-${i}`, name: `Place ${i}`, kind: "sight", subkind: "landmark", why: "x", area: "town", lat: 0.001 + (i % 20) / 100, lng: 0.001 + Math.floor(i / 20) / 100 })) }, `put_places (${N})`);
  const ev = (i) => ({ id: `e-${i}`, kind: "plan", title: `Event ${i}`, starts: `2027-03-${String(1 + (i % 28)).padStart(2, "0")}T${String(8 + (i % 10)).padStart(2, "0")}:00`, tz: "UTC" });
  await tool("put_events", { trip_id: T, summary: "Events", events: Array.from({ length: N }, (_, i) => ev(i)) }, `put_events (${N}, new)`);
  await tool("put_events", { trip_id: T, summary: "Events moved", events: Array.from({ length: N }, (_, i) => ({ id: `e-${i}`, detail: "Moved." })) }, `put_events (${N}, changed)`);
  await tool("set_packing_lists", { trip_id: T, summary: "Lists", lists: [{ key: "leaving-home", bags: [{ key: "day-bag", name: "Daypack" }] }, { key: "trek", name: "Trek", bags: [{ key: "pack", name: "Pack" }] }] });
  await tool("set_packing_starters", { trip_id: T, summary: "Starters", starters: Array.from({ length: N }, (_, i) => ({ scope: "person", label: `Starter ${i}`, category: "gear", bags: { "leaving-home": "day-bag" } })) }, `set_packing_starters (${N})`);
  await tool("put_packing_items", { trip_id: T, summary: "Items", items: Array.from({ length: N }, (_, i) => ({ id: `i-${i}`, list: i % 2 ? "group" : "mine", label: `Item ${i}`, category: "gear" })) }, `put_packing_items (${N})`);
  await tool("put_purchase", { trip_id: T, summary: "A purchase", purchase: { id: "pp", description: "x", amount: "10.00", currency: "EUR", spent_on: "2027-03-02", split: { mode: "even", people: [host.user.id] } } });
  for (const name of ["get_trip", "list_events", "list_places", "get_packing", "get_split", "list_changes", "list_trips"]) await tool(name, name === "list_trips" ? {} : { trip_id: T });
  // The chat's read at its largest page.
  await tool("list_messages", { trip_id: T, limit: 100 });
  // A link into the app reads the whole trip to know the thing is on it.
  await tool("open_in_app", { trip_id: T, open: "event", id: "e-0", add_photo: true });
  const changes = (await mcp.call("list_changes", { trip_id: T, limit: 200 })).json?.changes ?? [];
  const evChange = changes.find((x) => x.summary === "Events moved")?.id;
  await tool("undo_change", { trip_id: T, change_id: evChange }, `undo_change (${N} rows)`);
  await tool("remove_events", { trip_id: T, summary: "No events", ids: Array.from({ length: N }, (_, i) => `e-${i}`) }, `remove_events (${N})`);
  await tool("remove_places", { trip_id: T, summary: "No places", ids: Array.from({ length: N }, (_, i) => `p-${i}`) }, `remove_places (${N})`);

  t.part("Deleting, on the big trip");
  hold("deleting the big trip", (await measure("trip delete", () => host.call("DELETE", `/api/trips/${big}`, { confirm: seed.trip.name }), path_(`/api/trips/${big}`))).n);
  hold("deleting an account (the host's, its trips with it)", (await measure("account delete", () => host.call("DELETE", "/api/me", { confirm: "delete" }), path_("/api/me"))).n);

  console.log("\n  what each costs, in D1 queries:");
  for (const [what, n] of rows) console.log(`    ${String(n ?? "?").padStart(5)}  ${what}`);
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await server?.stop();
}
process.exit(code);

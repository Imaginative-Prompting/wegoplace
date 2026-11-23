// "Since my last", held by one property: whatever is written, by whom, in whatever order, a phone that took
// in deltas holds exactly what a whole snapshot holds at the same rev, row for row (src/api/trip.js since=,
// migration 0036, public/js/shared/delta.js, which the app's store merges with).
//
//   node checks/trips/delta.mjs [--port 8879] [--steps 400] [--seed 1] [--plant <name>]
//
// Random sequences of writes by four made-up people across every table the snapshot sends:
//   - plans, places and areas added, edited and deleted;
//   - packing items (the group's and a person's own), lists with bags, an item's bags, ticks, starters;
//   - purchases with their shares, changed and deleted; pictures put and taken off;
//   - messages about things; a person's rename;
//   - an app's change and its undo through the list of changes;
//   - a fourth person who joins and later leaves.
// Five phones pull at random points (two of them one person's), each by the shared merge. One goes offline for a
// stretch, its person's writes queued and sent when it's back, and pulls only then. After every pull, the phone's
// state is compared with a whole snapshot taken at once, as the same person, at the same rev.
//
// --plant gone_places: the delete trigger on places left off (a deleted place must outlive a delta).
// --plant shares_alone: a purchase's shares changed without its rev moving (a delta must miss it).
// Each must fail. Everyone in it is made up.

import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { png } from "../lib/images.mjs";
import { connect, McpClient } from "../lib/mcp.mjs";
import { takeAnswer, ROW_STORES, WHOLE_KEYS } from "../../public/js/shared/delta.js";

const argv = process.argv.slice(2);
const flag = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const port = Number(flag("--port", 8879));
const STEPS = Number(flag("--steps", 400));
const plant = flag("--plant", null);
let seed = Number(flag("--seed", 1)) * 7919 + 13;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (list) => list[Math.floor(rnd() * list.length)];
const t = new Report(`a phone's deltas, against the whole trip${plant ? ` (planted: ${plant})` : ""}`);

/** A phone's state as comparable text: row stores as rows sorted by id, the rest as they are, keys sorted. */
function stateOf(held) {
  const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
  const out = { rev: held.rev, data_rev: held.data_rev, chat: held.chat };
  for (const s of ROW_STORES) out[s] = [...held.rows[s].values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  // fx is the site's table of rates, not the trip's, refreshed on its own clock (a snapshot kicks a refresh in
  // the background, and the next one reads it): it's no part of what a delta carries or misses.
  for (const k of WHOLE_KEYS) if (k !== "fx") out[k] = held[k];
  return sortKeys(out);
}
/** The first difference between two states, in words. */
function firstDifference(a, b, at = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return `${at}: ${a.length} things held, ${b.length} in the whole trip`;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDifference(a[k], b[k], `${at}.${k}`); if (d) return d; }
  }
  return `${at}: held ${JSON.stringify(a)?.slice(0, 160)}, the whole trip has ${JSON.stringify(b)?.slice(0, 160)}`;
}

let server, code = 1;
try {
  server = await startServer({ name: "delta", port });
  await server.start();
  const o = server.origin;
  const P = { ada: new Person(o, "Ada Reyes"), ben: new Person(o, "Ben Okafor"), cleo: new Person(o, "Cleo Tran"), dee: new Person(o, "Dee Marsh") };
  for (const p of Object.values(P)) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
  const trip = (await P.ada.post("/api/trips", { name: "Property week", default_tz: "UTC", starts_on: day(0), ends_on: day(9), currencies: ["EUR"] })).json.trip.id;
  const T = `/api/trips/${trip}`;
  const join = async (who) => P[who].post(`/api/join/${(await P.ada.post(`${T}/links`, { uses: 1 })).json.link.code}`);
  for (const who of ["ben", "cleo"]) if ((await join(who)).status !== 200) throw new CheckError(`${who} couldn't join`);
  const app = await connect(o, P.ada, { name: "Property App", address: P.ada.address });
  const mcp = new McpClient(o, app.tokens.json.access_token);
  await mcp.initialize();

  if (plant === "gone_places") server.sql("DROP TRIGGER gone_places");
  if (plant === "shares_alone") {
    // A share rewritten while its purchase's rev stays: the purchase PATCH's own UPDATE puts the old rev back
    // (a trigger, so the route's code is as it is).
    server.sql(`CREATE TRIGGER plant_shares_alone AFTER INSERT ON purchase_shares BEGIN
      UPDATE purchases SET rev = rev - 1 WHERE id = NEW.purchase_id AND rev = (SELECT rev FROM trips WHERE id = purchases.trip_id); END`);
  }

  // ── what exists, as the host sees it, for choosing what to write next ──
  const t0 = Math.floor(Date.now() / 1000) + 3600;
  let n = 0;
  const id = (p) => `${p}-${++n}`;
  const known = { events: [], places: [], areas: [], items: { group: [], ada: [], ben: [], cleo: [], dee: [] }, lists: [], placed: new Set(), bagged: [], purchases: [], changes: [] };
  const members = new Set(["ada", "ben", "cleo"]);
  const tally = {};
  const why = {};
  const did = (what, r) => {
    const ok = r && (r.status ?? (r.isError ? 400 : 200)) < 300;
    tally[what] = tally[what] ?? { ok: 0, no: 0 }; tally[what][ok ? "ok" : "no"]++;
    if (!ok) why[what] = `${r?.status} ${JSON.stringify(r?.json ?? r).slice(0, 220)}`;
    return ok;
  };

  const OPS = [
    ["plan added", async (w) => { const e = id("e"); if (did("plan added", await P[w].post(`${T}/events`, { id: e, title: `Plan ${n}`, starts_at: t0 + Math.floor(rnd() * 8) * 86400, tz: "UTC" }))) known.events.push(e); }],
    ["plan edited", async (w) => known.events.length && did("plan edited", await P[w].call("PATCH", `${T}/events/${pick(known.events)}`, { title: `Plan, changed ${n++}` }))],
    ["plan deleted", async (w) => { if (!known.events.length) return; const e = pick(known.events); if (did("plan deleted", await P[w].call("DELETE", `${T}/events/${e}`))) known.events = known.events.filter((x) => x !== e); }],
    ["place added", async (w) => { const p = id("p"); if (did("place added", await P[w].call("PUT", `${T}/places`, { places: [{ id: p, name: `Place ${n}`, kind: "sight", subkind: "viewpoint", why: "A view." }] }))) known.places.push(p); }],
    ["place edited", async (w) => known.places.length && did("place edited", await P[w].call("PUT", `${T}/places`, { places: [{ id: pick(known.places), notes: `Note ${n++}` }] }))],
    ["place deleted", async (w) => { if (!known.places.length) return; const p = pick(known.places); if (did("place deleted", await P[w].call("DELETE", `${T}/places/${p}`))) known.places = known.places.filter((x) => x !== p); }],
    ["area added", async (w) => { const a = id("a"); if (did("area added", await P[w].call("PUT", `${T}/areas`, { areas: [{ id: a, name: `Area ${n}`, sort: n }] }))) known.areas.push(a); }],
    ["area deleted", async (w) => { if (!known.areas.length) return; const a = pick(known.areas); if (did("area deleted", await P[w].call("DELETE", `${T}/areas/${a}`))) known.areas = known.areas.filter((x) => x !== a); }],
    ["item added", async (w) => { const mine = rnd() < 0.5; const k = id("k"); if (did("item added", await P[w].post(`${T}/packing`, { id: k, label: `Thing ${n}`, category: "gear", owner: mine ? P[w].user.id : "group" }))) known.items[mine ? w : "group"].push(k); }],
    ["item edited", async (w) => { const list = [...known.items.group, ...known.items[w]]; return list.length && did("item edited", await P[w].call("PATCH", `${T}/packing/${pick(list)}`, { label: `Thing, changed ${n++}` })); }],
    ["item deleted", async (w) => { const own = rnd() < 0.5 ? w : "group"; if (!known.items[own].length) return; const k = pick(known.items[own]); if (did("item deleted", await P[w].call("DELETE", `${T}/packing/${k}`))) known.items[own] = known.items[own].filter((x) => x !== k); }],
    ["list set", async (w) => { const l = known.lists.length && rnd() < 0.5 ? pick(known.lists) : `list-${++n}`; if (did("list set", await P[w].call("PUT", `${T}/packing/lists`, { lists: [{ key: l, name: `List ${n}`, bags: [{ key: "pack", name: "Pack" }, { key: `bag-${n}`, name: "Bag" }] }] }))) if (!known.lists.includes(l)) known.lists.push(l); }],
    // A list with an item's bag on it can't be deleted (by design): only one nothing is packed into.
    ["list deleted", async (w) => { const free = known.lists.filter((x) => !known.placed.has(x)); if (!free.length) return; const l = pick(free); if (did("list deleted", await P[w].call("DELETE", `${T}/packing/lists/${l}`))) known.lists = known.lists.filter((x) => x !== l); }],
    ["item's bag", async (w) => { const list = [...known.items.group, ...known.items[w]]; if (!list.length || !known.lists.length) return; const l = pick(known.lists); const k = pick(list); if (did("item's bag", await P[w].call("PUT", `${T}/packing/items`, { items: [{ id: k, bags: { [l]: "pack" } }] }))) { known.placed.add(l); known.bagged.push([k, l, w]); } }],
    // A tick is on an item with a bag on that list (the group's, or the person's own): one a bag was put on.
    ["tick", async (w) => { const can = known.bagged.filter(([k, , by]) => known.items.group.includes(k) || (by === w && known.items[w].includes(k))); if (!can.length) return; const [k, l] = pick(can); did("tick", await P[w].call("PUT", `${T}/packing/ticks`, { item_id: k, list_key: l, ticked: rnd() < 0.7 })); }],
    ["starter", async (w) => did("starter", await P[w].call("PATCH", `${T}/packing/starters`, { starters: [{ scope: "group", label: `Starter ${n++ % 5}`, category: "gear", ...(rnd() < 0.3 ? { remove: true } : {}) }] }))],
    ["purchase added", async (w) => {
      const u = id("u"); const who = [...members].filter((x) => x !== "dee" || members.has("dee"));
      const shares = who.slice(0, 1 + Math.floor(rnd() * who.length)).map((x) => ({ user_id: P[x].user.id, weight: 1, share_minor: 0 }));
      const total = 100 * shares.length; shares.forEach((s) => { s.share_minor = 100; });
      const currency = pick(["EUR", "USD"]);
      if (did("purchase added", await P[w].post(`${T}/purchases`, { id: u, description: `Thing ${n}`, amount_minor: total, currency, paid_by: P[w].user.id, spent_at: t0, split_mode: "weight", shares }))) known.purchases.push({ id: u, by: w, currency });
    }],
    ["purchase and shares changed", async () => {
      const still = known.purchases.filter((x) => members.has(x.by)); if (!still.length) return; const p = pick(still);
      const who = [...members]; const sh = who.slice(0, 1 + Math.floor(rnd() * who.length)).map((x) => ({ user_id: P[x].user.id, weight: 1, share_minor: 50 }));
      did("purchase and shares changed", await P[p.by].call("PATCH", `${T}/purchases/${p.id}`, { amount_minor: 50 * sh.length, currency: p.currency, amount_exp: 2, split_mode: "weight", shares: sh, note: `Changed ${n++}` }));
    }],
    ["purchase deleted", async () => { const still = known.purchases.filter((x) => members.has(x.by)); if (!still.length) return; const p = pick(still); if (did("purchase deleted", await P[p.by].call("DELETE", `${T}/purchases/${p.id}`))) known.purchases = known.purchases.filter((x) => x !== p); }],
    ["picture put", async (w) => known.places.length && did("picture put", await P[w].call("PUT", `${T}/pictures/place/${pick(known.places)}?license=own`, png(40, 30), { headers: { "Content-Type": "application/octet-stream" } }))],
    ["picture off", async (w) => known.places.length && did("picture off", await P[w].call("DELETE", `${T}/pictures/place/${pick(known.places)}`))],
    ["message about a plan", async (w) => known.events.length && did("message about a plan", await P[w].post(`${T}/messages`, { id: id("m"), body: "About this", about: { kind: "event", id: pick(known.events), ...(rnd() < 0.5 ? { part: "before" } : {}) } }))],
    ["message about a place", async (w) => known.places.length && did("message about a place", await P[w].post(`${T}/messages`, { id: id("m"), body: "Said here", about: { kind: "place", id: pick(known.places) } }))],
    ["rename", async (w) => did("rename", await P[w].call("PATCH", "/api/me", { name: `${P[w].name.split(" ")[0]} ${["Vale", "Reyes", "Arbor", "Stone"][n++ % 4]}` }))],
    ["an app's change", async () => {
      const e = id("e");
      const r = await mcp.call("put_events", { trip_id: trip, summary: `App plan ${n}`, events: [{ id: e, kind: "plan", title: `App plan ${n}`, starts: day(2) + "T10:00", tz: "UTC" }] });
      if (did("an app's change", r)) { known.events.push(e); const list = (await mcp.call("list_changes", { trip_id: trip, limit: 5 })).json?.changes ?? []; if (list[0]?.id) known.changes.push(list[0].id); }
    }],
    ["undo through Changes", async (w) => { if (!known.changes.length) return; const c = known.changes.pop(); did("undo through Changes", await P[w].post(`${T}/changes/${c}/undo`, {})); }],
  ];

  // ── the phones ──
  const phones = [
    { name: "Ada's phone", who: "ada", held: null }, { name: "Ben's phone", who: "ben", held: null }, { name: "Ben's other phone", who: "ben", held: null },
    { name: "Cleo's phone", who: "cleo", held: null }, { name: "Dee's phone", who: "dee", held: null, off: true },
  ];
  const offline = phones[3];
  let compared = 0, deltas = 0, wholes = 0;
  const wrong = [];
  async function pull(phone) {
    if (phone.off) return;
    const since = phone.held ? phone.held.rev : null;
    const r = await P[phone.who].get(since === null ? T : `${T}?since=${since}`);
    if (r.status !== 200) throw new CheckError(`${phone.name}: ${r.status} ${r.text.slice(0, 160)}`);
    phone.held = takeAnswer(phone.held, r.json);
    if (r.json.delta) deltas++; else wholes++;
    const whole = takeAnswer(null, (await P[phone.who].get(T)).json);
    compared++;
    const d = firstDifference(stateOf(phone.held), stateOf(whole));
    if (d && wrong.length < 5) wrong.push(`${phone.name} after pull ${compared} (since ${since}): ${d}`);
  }
  for (const p of phones.slice(0, 4)) await pull(p);

  let away = null;
  for (let step = 0; step < STEPS; step++) {
    // Dee joins a third of the way through, and leaves at two thirds (her phone stops: the trip is gone to it).
    if (step === Math.floor(STEPS / 3)) { if ((await join("dee")).status === 200) { members.add("dee"); phones[4].off = false; await pull(phones[4]); } }
    if (step === Math.floor((2 * STEPS) / 3) && members.has("dee")) { await P.dee.call("DELETE", `${T}/members/${P.dee.user.id}`); members.delete("dee"); phones[4].off = true; }
    // Cleo's phone goes offline for a stretch: her writes wait in its queue, and go when it's back.
    if (step === Math.floor(STEPS / 5)) away = [];
    if (step === Math.floor(STEPS / 2) && away) { for (const op of away) await op(); away = null; await pull(offline); }
    const who = pick([...members]);
    const [, op] = pick(OPS);
    if (who === "cleo" && away) away.push(() => op("cleo")); else await op(who);
    if (rnd() < 0.25) { const phone = pick(phones.filter((p) => !p.off && !(p === offline && away))); await pull(phone); }
  }
  for (const p of phones) await pull(p);

  t.ok(`every phone's state after its deltas equals the whole trip at the same rev, row for row (${compared} pulls compared: ${deltas} deltas, ${wholes} whole)`,
    wrong.length === 0 && deltas > 50, wrong.join(" | "));
  const failed = Object.entries(tally).filter(([, v]) => v.ok === 0).map(([k]) => k);
  t.ok(`every kind of write was made at least once (${Object.entries(tally).map(([k, v]) => `${k} ${v.ok}`).join(", ")})`, failed.length === 0, `never made: ${failed.map((k) => `${k} (${why[k]})`).join(" | ")}`);
  const log = server.log().split("\n").filter((l) => /Uncaught|✘|\[ERROR\]/.test(l));
  t.ok("nothing failed inside the server", log.length === 0, log.slice(0, 3).join(" | "));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await server?.stop();
}
process.exit(code);

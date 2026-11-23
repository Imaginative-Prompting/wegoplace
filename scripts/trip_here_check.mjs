#!/usr/bin/env node
/* Which trip a page is, and which trips this phone keeps (public/js/trip-here.js). No browser,
 * no server:
 *   node scripts/trip_here_check.mjs
 *
 * WHAT IT PROVES
 *   - The trip's id is read from "/t/<id>/" and from nothing else: not "/", not "/trips/<id>",
 *     not an id the server would refuse, not a longer path.
 *   - The addresses built for a trip: the app's ("/t/<id>/#/split") and the API's
 *     ("/api/trips/<id>/events"); neither is ever built without a trip.
 *   - One database per trip, and the trip read back from a database's name; the database from
 *     before trips names no trip.
 *   - The list of trips this phone keeps: empty to start, the one opened last first, a trip
 *     dropped, a list written for another account never read, a broken value read as empty,
 *     storage that throws read as empty.
 *   - Where "/" goes: the trip opened last, with the "#/…" part kept; Your trips when the phone
 *     keeps none.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = await import(path.join(REPO, "public/js/trip-here.js"));

let pass = 0, fail = 0;
const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok    ${name}   — ${JSON.stringify(got)}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}   -> got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); }
}
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// A stand-in for localStorage.
function memory(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, raw: m,
    get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null };
}
const byKey = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
const dump = (st) => byKey(Object.fromEntries(st.raw));
const broken = { getItem() { throw new Error("no storage"); }, setItem() { throw new Error("no storage"); } };

console.log("\nthe trip in the address");
check("/t/<id>/", T.tripIdFromPath("/t/harbor-week/"), "harbor-week");
check("/t/<id> (before the server's redirect)", T.tripIdFromPath("/t/harbor-week"), "harbor-week");
check("dots and underscores", T.tripIdFromPath("/t/a_b.c-9/"), "a_b.c-9");
check("the app's own address", T.tripIdFromPath("/"), "");
check("Your trips", T.tripIdFromPath("/trips"), "");
check("a trip's people page", T.tripIdFromPath("/trips/harbor-week"), "");
check("a longer path", T.tripIdFromPath("/t/harbor-week/more/"), "");
check("an id the server refuses", T.tripIdFromPath("/t/harbor%20week/"), "");
check("an id too long", T.tripIdFromPath(`/t/${"a".repeat(65)}/`), "");
check("a broken escape", T.tripIdFromPath("/t/%E0%A4%A/"), "");
check("nothing", T.tripIdFromPath(undefined), "");

console.log("\naddresses for a trip");
check("the app", T.tripPath("harbor-week"), "/t/harbor-week/");
check("the app at a section", T.tripPath("harbor-week", "#/split"), "/t/harbor-week/#/split");
check("a section given without its #", T.tripPath("harbor-week", "/split"), "/t/harbor-week/#/split");
check("a bare # adds nothing", T.tripPath("harbor-week", "#"), "/t/harbor-week/");
check("the trip itself", T.tripApi("harbor-week"), "/api/trips/harbor-week");
check("its events", T.tripApi("harbor-week", "/events"), "/api/trips/harbor-week/events");
check("never without a trip", throws(() => T.tripApi("", "/events")), true);
check("never with an id the server refuses", throws(() => T.tripApi("a/b", "/events")), true);

console.log("\none database per trip");
check("the name", T.dbName("wegoplace", "harbor-week"), "wegoplace:harbor-week");
check("never without a trip", throws(() => T.dbName("wegoplace", "")), true);
check("the trip read back", T.tripOfDb("wegoplace", "wegoplace:harbor-week"), "harbor-week");
check("the database from before trips", T.tripOfDb("wegoplace", "wegoplace"), "");
check("another base", T.tripOfDb("wegoplace", "wegoplace-memories:harbor-week"), "");
check("the memories base", T.tripOfDb("wegoplace-memories", "wegoplace-memories:harbor-week"), "harbor-week");

console.log("\nthe trips this phone keeps");
{
  const s = memory();
  check("none to start", T.keptTrips({ storage: s }), []);
  check("no last trip", T.lastTrip({ storage: s }), "");
  check("/ goes to Your trips", T.homeAddress({ storage: s, hash: "#/split" }), "/trips");
  T.noteOpened("harbor-week", { storage: s, who: "u1", name: "Harbor week", now: 1000 });
  T.noteOpened("ridge-walk", { storage: s, who: "u1", name: "Ridge walk", now: 2000 });
  check("the one opened last first", T.keptTrips({ storage: s, who: "u1" }).map((t) => t.id), ["ridge-walk", "harbor-week"]);
  check("names kept", T.keptTrips({ storage: s, who: "u1" })[1], { id: "harbor-week", name: "Harbor week", at: 1000 });
  check("the last trip", T.lastTrip({ storage: s, who: "u1" }), "ridge-walk");
  check("/ goes to it, section kept", T.homeAddress({ storage: s, who: "u1", hash: "#/split" }), "/t/ridge-walk/#/split");
  T.noteOpened("harbor-week", { storage: s, who: "u1", now: 3000 });
  check("opened again: last, its name kept", T.keptTrips({ storage: s, who: "u1" })[0], { id: "harbor-week", name: "Harbor week", at: 3000 });
  check("read before the account is known", T.lastTrip({ storage: s }), "harbor-week");
  check("whose list it is", T.keptOwner({ storage: s }), "u1");
  check("another account reads none of it", T.keptTrips({ storage: s, who: "u2" }), []);
  check("…and / sends them to Your trips", T.homeAddress({ storage: s, who: "u2" }), "/trips");
  check("dropping the last trip", T.dropKept("harbor-week", { storage: s, who: "u1" }), true);
  check("the other becomes the last", T.lastTrip({ storage: s, who: "u1" }), "ridge-walk");
  check("dropping one not kept", T.dropKept("nowhere", { storage: s, who: "u1" }), false);
  check("an id the server refuses is never kept", T.noteOpened("a/b", { storage: s, who: "u1" }), false);
}
{
  const s = memory();
  for (let i = 0; i < 45; i++) T.noteOpened(`trip-${i}`, { storage: s, who: "u1", now: 1000 + i });
  const kept = T.keptTrips({ storage: s, who: "u1" });
  check("no trip falls off the list: signing out finds each one's database by it", [kept.length, kept[0].id, kept[44].id], [45, "trip-44", "trip-0"]);
}
console.log("\nwhat the phone remembers about one trip");
{
  const s = memory({ "wgp.map.cam": "old-cam", "wgp.pack.list.mine": "l1", "wgp.pack.folded": "{}", "wgp.split.currency": "EUR,USD", "wgp.theme": "dark", "wgp.pack.tab": "group",
    "wgp.split.display@ridge-walk": "CHF", "wgp.map.cam@harbor-week": "newer" });
  check("a choice's name for a trip", T.tripKey("wgp.map.cam", "harbor-week"), "wgp.map.cam@harbor-week");
  check("no name without a trip", (() => { try { T.tripKey("wgp.map.cam", ""); return "named"; } catch { return "threw"; } })(), "threw");
  check("an old phone's choices become its trip's: three move, one was already made since", T.adoptOldKeys("harbor-week", { storage: s }), 3);
  check("…under the trip's names, the newer one kept, the old names gone, the phone's own untouched", dump(s),
    byKey({ "wgp.theme": "dark", "wgp.pack.tab": "group", "wgp.split.display@ridge-walk": "CHF", "wgp.map.cam@harbor-week": "newer",
      "wgp.pack.list.mine@harbor-week": "l1", "wgp.pack.folded@harbor-week": "{}", "wgp.split.currency@harbor-week": "EUR,USD" }));
  check("a second run moves nothing", T.adoptOldKeys("harbor-week", { storage: s }), 0);
  check("a trip that is gone takes its four choices with it", T.dropTripKeys("harbor-week", { storage: s }), 4);
  check("…and nothing else", dump(s), byKey({ "wgp.theme": "dark", "wgp.pack.tab": "group", "wgp.split.display@ridge-walk": "CHF" }));
  check("a trip whose id ends another's is not touched", (() => { const m = memory({ "wgp.map.cam@a-walk": "1", "wgp.map.cam@walk": "2" }); T.dropTripKeys("walk", { storage: m }); return dump(m); })(), { "wgp.map.cam@a-walk": "1" });
  check("a key that only looks like a trip's is left", (() => { const m = memory(byKey({ "wgp.kept@walk": "x", "wgp.pack.list.@walk": "y" })); T.dropTripKeys("walk", { storage: m }); return dump(m); })(), byKey({ "wgp.kept@walk": "x", "wgp.pack.list.@walk": "y" }));
  check("storage that throws: nothing moved, nothing dropped", [T.adoptOldKeys("walk", { storage: broken }), T.dropTripKeys("walk", { storage: broken })], [0, 0]);
}
check("a broken value reads as empty", T.keptTrips({ storage: memory({ "wgp.kept": "{not json" }) }), []);
check("another version reads as empty", T.keptTrips({ storage: memory({ "wgp.kept": JSON.stringify({ v: 9, trips: { a: { at: 1 } } }) }) }), []);
check("rows that aren't trips are left out", T.keptTrips({ storage: memory({ "wgp.kept": JSON.stringify({ v: 1, who: "", last: "zz", trips: { "a b": { at: 1 }, ok: { name: 5, at: "7" }, nil: null } }) }) }), [{ id: "ok", name: "", at: 7 }]);
check("no list: nobody's", T.keptOwner({ storage: memory() }), "");
check("a broken value: nobody's", T.keptOwner({ storage: memory({ "wgp.kept": "{not json" }) }), "");
check("storage that throws reads as empty", T.keptTrips({ storage: broken }), []);
check("…and as nobody's", T.keptOwner({ storage: broken }), "");
check("…and a write to it says it failed", T.noteOpened("harbor-week", { storage: broken }), false);
check("…and / still has an answer", T.homeAddress({ storage: broken }), "/trips");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }

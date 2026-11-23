#!/usr/bin/env node
// public/js/old-queue.js: the changes a phone made with no signal in the app as it was before
// (v54), turned into the changes this app sends. No browser, no server.
//   node scripts/old_queue_check.mjs
// This holds, one by one, the rules for a phone that comes back with the old app's queue after the cutover.
import { OLD_MARK, translateOld, oldWords, oldLines } from "../public/js/old-queue.js";

let pass = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? `   -> ${detail}` : ""}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// store.js's packKey, as it is there.
function makeKey(name, taken, fallback) {
  const base = String(name).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "") || fallback;
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  return key;
}

// A trip as the server has it after its own move: two lists packed once, one for the day.
const lists = () => [
  { key: "leaving-home", name: "Leaving Home", sort: 0, repeat: "once", bags: [{ key: "main-bag", name: "Main bag", sort: 0 }, { key: "day-bag", name: "Day bag", sort: 1 }] },
  { key: "the-trek", name: "The trek", sort: 1, repeat: "once", bags: [{ key: "duffel", name: "Duffel", sort: 0 }] },
  { key: "each-day", name: "Each day", sort: 2, repeat: "daily", bags: [{ key: "pockets", name: "Pockets", sort: 0 }] },
];
// What the old packing screen knew: each list and bag by an id.
// It saved them with its unsent changes ALREADY APPLIED: a list or bag it renamed with no
// signal is here under the new name only (`names`), and one it removed is not here at all.
const old = (queue, names = {}, without = []) => ({
  views: [
    { id: "pv_home", owner: "u_one", name: "Leaving Home", sort: 0 },
    { id: "pv_trek", owner: "u_one", name: "The trek", sort: 1 },
  ].filter((v) => !without.includes(v.id)).map((v) => ({ ...v, name: names[v.id] || v.name })),
  sections: [
    { id: "ps_main", view_id: "pv_home", name: "Main bag", sort: 0 },
    { id: "ps_day", view_id: "pv_home", name: "Day bag", sort: 1 },
    { id: "ps_duffel", view_id: "pv_trek", name: "Duffel", sort: 0 },
  ].filter((s) => !without.includes(s.id)).map((s) => ({ ...s, name: names[s.id] || s.name })),
  placements: [
    { item_id: "pk_socks", view_id: "pv_home", section_id: "ps_main" },
    { item_id: "pk_socks", view_id: "pv_trek", section_id: "ps_duffel" },
    { item_id: "pk_stove", view_id: "pv_trek", section_id: "ps_duffel" },
  ],
  queue,
});
const things = new Map([
  ["pk_socks", { id: "pk_socks", label: "Wool socks", owner: "u_one" }],
  ["pk_stove", { id: "pk_stove", label: "Stove", owner: "group" }],
  ["pk_loose", { id: "pk_loose", label: "Spare laces", owner: "u_one" }],
]);
const S = "\u0000";
const sits = () => new Map([
  [`pk_socks${S}leaving-home`, "main-bag"], [`pk_socks${S}the-trek`, "duffel"], [`pk_socks${S}each-day`, "pockets"],
  [`pk_stove${S}the-trek`, "duffel"],
]);
const run = (ops, queue = null, over = {}, names = {}, without = []) => translateOld({
  ops: ops.map((o, i) => ({ ...o, from: OLD_MARK, seq: i + 1 })), old: queue ? old(queue, names, without) : null,
  lists: lists(), placements: sits(), item: (id) => things.get(id) || null, makeKey, now: 99, ...over,
});
const kinds = (r) => r.ops.map((o) => `${o.kind} ${o.op}`);

console.log("\n1. what is sent as it was written");
{
  const ops = [
    { kind: "note", op: "create", id: "nt_1", payload: { id: "nt_1", body: "By the gate", event_id: "ev_1" }, at: 5 },
    { kind: "event", op: "update", id: "ev_1", payload: { title: "A walk" }, at: 6 },
    { kind: "purchase", op: "delete", id: "pu_1", payload: null, at: 7 },
    { kind: "me", op: "update", id: "u_one", payload: { initials: "ON" }, at: 8 },
  ];
  const r = run(ops);
  check("a plan, a note, a purchase and a settings change come through as written", same(r.ops, ops), JSON.stringify(r.ops));
  check("… without the mark or the old place in line", r.ops.every((o) => !("from" in o) && !("seq" in o)));
  check("… and nothing is said", r.told.length === 0);
}

console.log("\n2. a packing thing");
{
  const r = run([{ kind: "packing", op: "create", id: "pk_new", at: 5,
    payload: { id: "pk_new", owner: "u_one", section: "Clothes", label: "Rain hat", note: "", qty: "", done: 0, sort: 40, trip_id: "t", created_by: "u_one", created_at: 5, updated_at: 5 } }]);
  const p = r.ops[0] && r.ops[0].payload;
  check("a new thing is sent without the fields that are gone", r.ops.length === 1 && p && !("done" in p) && !("section" in p) && p.label === "Rain hat" && p.owner === "u_one" && p.sort === 40, JSON.stringify(r.ops));
  check("a new thing that was never ticked and sits nowhere says nothing", r.told.length === 0, JSON.stringify(r.told));
  const d = run([{ kind: "packing", op: "delete", id: "pk_socks", payload: null, at: 5 }]);
  check("a removal is sent as written", same(kinds(d), ["packing delete"]) && d.ops[0].id === "pk_socks");
  const u = run([{ kind: "packing", op: "update", id: "pk_socks", payload: { label: "Thick wool socks", section: "Clothes", updated_at: 6 }, at: 6 }]);
  check("a change keeps what the thing still has (its words), without `section`", u.ops.length === 1 && same(u.ops[0].payload, { label: "Thick wool socks", updated_at: 6 }), JSON.stringify(u.ops));
}

console.log("\n3. the tick");
{
  const r = run([{ kind: "packing", op: "update", id: "pk_socks", payload: { done: 1, updated_at: 6 }, at: 6 }]);
  check("a change that was only the tick sends no change to the thing", !r.ops.some((o) => o.kind === "packing"), JSON.stringify(kinds(r)));
  const ticks = r.ops.filter((o) => o.kind === "pack-tick");
  check("it becomes one tick on every list the thing sits on that is packed once", same(ticks.map((t) => t.payload.list_key).sort(), ["leaving-home", "the-trek"]), JSON.stringify(ticks.map((t) => t.payload)));
  check("… never on a list for the day", !ticks.some((t) => t.payload.list_key === "each-day"));
  check("… with no day, ticked, and the words a refusal would need", ticks.every((t) => t.payload.day === null && t.payload.ticked === true && t.payload.item_id === "pk_socks" && t.payload.label === "Wool socks" && t.payload.list_name), JSON.stringify(ticks[0]));
  check("… keyed as the store keys a tick (thing, list, no day)", ticks.every((t) => t.id === `pk_socks${S}${t.payload.list_key}${S}`));
  const off = run([{ kind: "packing", op: "update", id: "pk_socks", payload: { done: 0, updated_at: 6 }, at: 6 }]);
  check("a tick taken off is taken off the same lists", same(off.ops.map((o) => [o.kind, o.payload.list_key, o.payload.ticked]), [["pack-tick", "leaving-home", false], ["pack-tick", "the-trek", false]]), JSON.stringify(off.ops));
  const no = run([{ kind: "packing", op: "update", id: "pk_loose", payload: { done: 1, updated_at: 6 }, at: 6 }]);
  check("a tick on a thing that sits on no list is said, and nothing is sent", no.ops.length === 0 && same(no.told, [{ case: "tick-nowhere", label: "Spare laces" }]), JSON.stringify(no));
  const quiet = run([{ kind: "packing", op: "update", id: "pk_loose", payload: { done: 0, updated_at: 6 }, at: 6 }]);
  check("a tick taken off a thing on no list says nothing (nothing changed)", quiet.ops.length === 0 && quiet.told.length === 0);
  const both = run([{ kind: "packing", op: "update", id: "pk_socks", payload: { done: 1, label: "Socks", updated_at: 6 }, at: 6 }]);
  check("a change with words and a tick sends both, the change first", same(kinds(both), ["packing update", "pack-tick update", "pack-tick update"]) && same(both.ops[0].payload, { label: "Socks", updated_at: 6 }) && both.ops[1].payload.label === "Socks", JSON.stringify(both.ops));
  const dead = run([
    { kind: "packing", op: "update", id: "pk_socks", payload: { done: 1, updated_at: 6 }, at: 6 },
    { kind: "packing", op: "delete", id: "pk_socks", payload: null, at: 7 },
  ]);
  check("a thing ticked and then removed is only removed", same(kinds(dead), ["packing delete"]), JSON.stringify(kinds(dead)));
}

console.log("\n4. the old packing screen's queue: what adds is carried");
{
  const r = run([], [{ t: "place.put", item_id: "pk_loose", view_id: "pv_home", section_id: "ps_day", at: 3 }]);
  check("a thing put in a bag goes to the trip's list and bag of the same names", same(r.ops, [{ kind: "pack-place", op: "update", id: `pk_loose${S}leaving-home`, at: 3, payload: { item_id: "pk_loose", list_key: "leaving-home", bag_key: "day-bag", label: "Spare laces", bag_name: "Day bag" } }]), JSON.stringify(r.ops));
  const same1 = run([], [{ t: "place.put", item_id: "pk_socks", view_id: "pv_home", section_id: "ps_main" }]);
  check("a thing put where it already is sends nothing", same1.ops.length === 0 && same1.told.length === 0);
  const off = run([], [{ t: "place.del", item_id: "pk_stove", view_id: "pv_trek" }]);
  check("a thing taken off a list is taken off it", off.ops.length === 1 && off.ops[0].kind === "pack-place" && off.ops[0].payload.bag_key === null && off.ops[0].payload.list_key === "the-trek", JSON.stringify(off.ops));
  const nothing = run([], [{ t: "place.del", item_id: "pk_loose", view_id: "pv_trek" }]);
  check("… and one that isn't on it sends nothing", nothing.ops.length === 0 && nothing.told.length === 0);

  const bag = run([], [
    { t: "sec.create", id: "ps_new", body: { view_id: "pv_trek", name: "Summit  pack", sort: 4 } },
    { t: "place.put", item_id: "pk_stove", view_id: "pv_trek", section_id: "ps_new" },
  ]);
  check("a new bag is added to the trip's list, then the thing goes in it", same(kinds(bag), ["pack-bag create", "pack-place update"]) && same(bag.ops[0].payload, { list_key: "the-trek", key: "summit-pack", name: "Summit pack", sort: 1 }) && bag.ops[1].payload.bag_key === "summit-pack", JSON.stringify(bag.ops));
  const twin = run([], [
    { t: "sec.create", id: "ps_twin", body: { view_id: "pv_home", name: "day bag", sort: 4 } },
    { t: "place.put", item_id: "pk_loose", view_id: "pv_home", section_id: "ps_twin" },
  ]);
  check("a new bag with a name the list already has is that bag: nothing added, the thing goes in it", same(kinds(twin), ["pack-place update"]) && twin.ops[0].payload.bag_key === "day-bag", JSON.stringify(twin.ops));

  const list = run([], [
    { t: "view.create", id: "pv_new", body: { owner: "u_one", name: "Beach day", sort: 5, trip_id: "t" } },
    { t: "sec.create", id: "ps_a", body: { view_id: "pv_new", name: "Tote", sort: 0 } },
    { t: "sec.create", id: "ps_b", body: { view_id: "pv_new", name: "Cooler", sort: 1 } },
    { t: "place.put", item_id: "pk_loose", view_id: "pv_new", section_id: "ps_b" },
  ]);
  check("a new list is made once, with the bags the queue adds to it, packed once", same(kinds(list), ["pack-list create", "pack-place update"]) && list.ops[0].id === "beach-day" && same(list.ops[0].payload, { name: "Beach day", sort: 3, repeat: "once", bags: [{ key: "tote", name: "Tote", sort: 0 }, { key: "cooler", name: "Cooler", sort: 1 }] }), JSON.stringify(list.ops));
  check("… and a thing put in one of them lands there", list.ops[1] && list.ops[1].payload.list_key === "beach-day" && list.ops[1].payload.bag_key === "cooler");
  const bare = run([], [{ t: "view.create", id: "pv_bare", body: { owner: "u_one", name: "Laundry", sort: 5 } }]);
  check("a new list with no bag of its own gets one (a list keeps at least one bag)", bare.ops.length === 1 && same(bare.ops[0].payload.bags, [{ key: "main-bag", name: "Main bag", sort: 0 }]), JSON.stringify(bare.ops));
  const known = run([], [
    { t: "view.create", id: "pv_mine", body: { owner: "u_two", name: "the trek", sort: 0 } },
    { t: "sec.create", id: "ps_mine", body: { view_id: "pv_mine", name: "Duffel", sort: 0 } },
    { t: "place.put", item_id: "pk_loose", view_id: "pv_mine", section_id: "ps_mine" },
  ]);
  check("a new list with a name the trip has is that list: only the thing's place is sent", same(kinds(known), ["pack-place update"]) && known.ops[0].payload.list_key === "the-trek" && known.ops[0].payload.bag_key === "duffel", JSON.stringify(known.ops));
  const undone = run([], [
    { t: "view.create", id: "pv_gone", body: { owner: "u_one", name: "Mistake", sort: 5 } },
    { t: "sec.create", id: "ps_gone", body: { view_id: "pv_gone", name: "Bag", sort: 0 } },
    { t: "place.put", item_id: "pk_loose", view_id: "pv_gone", section_id: "ps_gone" },
    { t: "view.delete", id: "pv_gone" },
  ]);
  check("a list made and removed again with no signal leaves nothing, and nothing is said", undone.ops.length === 0 && undone.told.length === 0, JSON.stringify(undone));
  const renamedNew = run([], [
    { t: "view.create", id: "pv_new", body: { owner: "u_one", name: "Beech day", sort: 5 } },
    { t: "view.patch", id: "pv_new", body: { name: "Beach day" } },
  ]);
  check("a list made and then renamed with no signal is made under its last name", renamedNew.ops.length === 1 && renamedNew.ops[0].payload.name === "Beach day" && renamedNew.told.length === 0, JSON.stringify(renamedNew));
}

console.log("\n5. what would change a list or a bag for everyone is not carried, and is said");
{
  const r = run([], [
    { t: "view.patch", id: "pv_trek", body: { name: "Salkantay" } },
    { t: "sec.patch", id: "ps_day", body: { name: "Daypack" } },
    { t: "view.order", owner: "u_one", order: ["pv_trek", "pv_home"] },
    { t: "sec.order", view_id: "pv_home", order: ["ps_day", "ps_main"] },
  ], {}, { pv_trek: "Salkantay", ps_day: "Daypack" });
  check("a rename and a new order send nothing", r.ops.length === 0, JSON.stringify(r.ops));
  check("the renames are said by the name the trip still has: the list found by what sits on it, the bag by being the one left", same(r.told, [
    { case: "list-renamed", from: "The trek", to: "Salkantay" },
    { case: "bag-renamed", from: "Day bag", to: "Daypack" },
  ]), JSON.stringify(r.told));
  const intoRenamed = run([], [
    { t: "sec.patch", id: "ps_duffel", body: { name: "Big bag" } },
    { t: "place.put", item_id: "pk_loose", view_id: "pv_trek", section_id: "ps_duffel" },
  ], {}, { ps_duffel: "Big bag" });
  check("a thing put in a bag renamed with no signal still goes in that bag (found by what sits in it)", intoRenamed.ops.length === 1 && intoRenamed.ops[0].payload.bag_key === "duffel" && intoRenamed.ops[0].payload.list_key === "the-trek" && same(intoRenamed.told, [{ case: "bag-renamed", from: "Duffel", to: "Big bag" }]), JSON.stringify(intoRenamed));
  const onRenamedList = run([], [
    { t: "view.patch", id: "pv_trek", body: { name: "Salkantay" } },
    { t: "sec.create", id: "ps_new", body: { view_id: "pv_trek", name: "Top lid", sort: 3 } },
  ], {}, { pv_trek: "Salkantay" });
  check("a bag added to a list renamed with no signal is added to that list", onRenamedList.ops.length === 1 && onRenamedList.ops[0].kind === "pack-bag" && onRenamedList.ops[0].payload.list_key === "the-trek", JSON.stringify(onRenamedList));
  const unknown = translateOld({ ops: [], makeKey, lists: lists(), placements: new Map(), item: () => null,
    old: { views: [{ id: "pv_a", name: "Renamed A" }, { id: "pv_b", name: "Renamed B" }], sections: [], placements: [], queue: [{ t: "view.patch", id: "pv_a", body: { name: "Renamed A" } }] } });
  check("a renamed list that can't be told from another is still said, by the new name alone", same(unknown.told, [{ case: "list-renamed", from: "", to: "Renamed A" }]) && /kept its old name/.test(oldWords(unknown.told[0])) && oldWords(unknown.told[0]).includes("“Renamed A”"), JSON.stringify(unknown.told) + " " + oldWords(unknown.told[0] || {}));
  // What the old app removed is gone from what it saved: only the id is left.
  const bagGone = run([], [{ t: "sec.delete", id: "ps_day" }], {}, {}, ["ps_day"]);
  check("a removed bag sends nothing and is said, without a name when two could be it (never the wrong name)", bagGone.ops.length === 0 && same(bagGone.told, [{ case: "bag-removed", name: "", list: "" }]) && /^The bag you removed is still here\./.test(oldWords(bagGone.told[0])), JSON.stringify(bagGone));
  const twoLists = lists().slice(0, 2);
  const bagGone2 = run([], [{ t: "sec.delete", id: "ps_day" }], { lists: twoLists }, {}, ["ps_day"]);
  check("… named: the trip's one bag that nothing the phone still knows became", same(bagGone2.told, [{ case: "bag-removed", name: "Day bag", list: "Leaving Home" }]), JSON.stringify(bagGone2.told));
  const listGone = run([], [{ t: "view.delete", id: "pv_home" }], { lists: twoLists }, {}, ["pv_home", "ps_main", "ps_day"]);
  check("a removed list sends nothing and is said by name when it is the only one left over", listGone.ops.length === 0 && same(listGone.told, [{ case: "list-removed", name: "Leaving Home" }]), JSON.stringify(listGone));
  const listGoneQuiet = run([], [{ t: "view.delete", id: "pv_home" }], {}, {}, ["pv_home", "ps_main", "ps_day"]);
  check("… and without a name when two could be it (never the wrong name)", same(listGoneQuiet.told, [{ case: "list-removed", name: "" }]) && /^The list you removed is still here\./.test(oldWords(listGoneQuiet.told[0])), JSON.stringify(listGoneQuiet.told));
  const sameName = run([], [{ t: "view.patch", id: "pv_trek", body: { name: "the  Trek" } }]);
  check("a rename to the name it has says nothing", sameName.told.length === 0);
  const lost = run([], [
    { t: "place.put", item_id: "pk_loose", view_id: "pv_home", section_id: "ps_never" },
    { t: "sec.create", id: "ps_x", body: { view_id: "pv_never", name: "Side pocket", sort: 0 } },
  ]);
  check("a place or a bag whose list or bag the phone no longer knows is said, not sent", lost.ops.length === 0 && same(lost.told, [{ case: "place-lost", label: "Spare laces" }, { case: "bag-lost", name: "Side pocket" }]), JSON.stringify(lost));
}

console.log("\n6. the order things go in");
{
  const r = run([
    { kind: "packing", op: "create", id: "pk_new", at: 1, payload: { id: "pk_new", owner: "u_one", label: "Rain hat", done: 1, section: "Clothes" } },
    { kind: "note", op: "create", id: "nt_1", at: 2, payload: { id: "nt_1", body: "x" } },
  ], [
    { t: "sec.create", id: "ps_new", body: { view_id: "pv_home", name: "Hat box", sort: 3 } },
    { t: "place.put", item_id: "pk_new", view_id: "pv_home", section_id: "ps_new" },
  ]);
  check("the thing, then its bag, then its place, then its tick", same(kinds(r), ["packing create", "note create", "pack-bag create", "pack-place update", "pack-tick update"]), JSON.stringify(kinds(r)));
  check("a new thing made ticked is ticked on the list its place put it on, by its own label", r.ops[4] && r.ops[4].payload.list_key === "leaving-home" && r.ops[4].payload.ticked === true && r.ops[4].payload.label === "Rain hat" && r.ops[3].payload.label === "Rain hat", JSON.stringify(r.ops.slice(3)));
  const gone = run([{ kind: "packing", op: "delete", id: "pk_stove", payload: null, at: 1 }], [{ t: "place.put", item_id: "pk_stove", view_id: "pv_home", section_id: "ps_main" }]);
  check("a place for a thing removed in the same queue is not sent", same(kinds(gone), ["packing delete"]), JSON.stringify(kinds(gone)));
}

console.log("\n7. what could go wrong with the input");
{
  check("nothing waiting gives nothing", same(translateOld({ makeKey }), { ops: [], told: [] }));
  const odd = run([], [null, { t: 5 }, { t: "unknown.kind", id: "x" }, { t: "place.put" }]);
  check("records that aren't changes, and kinds this never had, are passed over without a throw", Array.isArray(odd.ops));
  const input = [{ kind: "packing", op: "update", id: "pk_socks", payload: { done: 1 }, at: 6, from: OLD_MARK, seq: 4 }];
  const copy = JSON.stringify(input);
  translateOld({ ops: input, lists: lists(), placements: sits(), item: (id) => things.get(id), makeKey });
  check("what it is given is left as it was", JSON.stringify(input) === copy);
}

console.log("\n8. the words");
{
  const cases = [
    { case: "list-renamed", from: "The trek", to: "Salkantay" }, { case: "bag-renamed", from: "Day bag", to: "Daypack" },
    { case: "list-removed", name: "Leaving Home" }, { case: "bag-removed", name: "Duffel", list: "The trek" },
    { case: "bag-lost", name: "Side pocket" }, { case: "place-lost", label: "Spare laces" },
    { case: "tick-nowhere", label: "Spare laces" }, { case: "failed" },
  ];
  const lines = cases.map(oldWords);
  check("every case has a sentence, and it names what the person called the thing", lines.every((l) => l.length > 20) && lines[0].includes("“The trek”") && lines[0].includes("“Salkantay”") && lines[6].includes("“Spare laces”"), JSON.stringify(lines));
  check("no sentence shows a status number, a key or an id", lines.every((l) => !/\(\d{3}\)|[a-z]{2}_[a-z0-9]|\bkey\b|\bid\b/.test(l)));
  check("a case with its names missing still reads as a sentence", cases.every((c) => { const l = oldWords({ case: c.case }); return l.length > 20 && !/undefined|null|“”/.test(l); }), cases.map((c) => oldWords({ case: c.case })).join(" | "));
  check("a long name is cut short", oldWords({ case: "tick-nowhere", label: "x".repeat(90) }).length < 110);
  check("a case this doesn't know says nothing", oldWords({ case: "something else" }) === "" && oldWords(null) === "");
  for (const l of lines) console.log(`        ${l}`);
  check("up to three are said in full, in order", same(oldLines(cases.slice(0, 3)), lines.slice(0, 3)));
  const many = oldLines(cases.slice(0, 7));
  check("more than three: the first two, and how many more", many.length === 3 && same(many.slice(0, 2), lines.slice(0, 2)) && many[2] === "and 5 more packing changes from before the update weren't carried over.", JSON.stringify(many));
  check("the same line twice is said once, and nothing gives nothing", oldLines([cases[5], cases[5]]).length === 1 && same(oldLines([]), []) && same(oldLines(null), []));
}

console.log("\n9. a carried change the trip then refused");
{
  const r = (o) => oldWords({ case: "refused", ...o });
  const lines = [
    [{ kind: "purchase", op: "update", label: "Taxi to the harbor", status: 403 }, "Your change to “Taxi to the harbor” from before the update wasn't kept: only whoever added it or paid for it can change it now."],
    [{ kind: "purchase", op: "delete", label: "Taxi to the harbor", status: 403 }, "“Taxi to the harbor” is still here. You removed it before the update, but only whoever added it or paid for it can remove it."],
    [{ kind: "event", op: "delete", label: "Harbor walk", status: 403 }, "“Harbor walk” is still here. You removed it before the update, but it isn't yours to remove."],
    [{ kind: "note", op: "delete", label: "Bring cash", status: 403 }, "“Bring cash” is still here. You removed it before the update, but only whoever wrote it can remove it."],
    [{ kind: "event", op: "update", label: "Harbor walk", status: 403 }, "Your change to “Harbor walk” from before the update wasn't kept: it isn't yours to change now."],
    [{ kind: "event", op: "update", label: "Harbor walk", status: 404 }, "Your change to “Harbor walk” from before the update wasn't kept: it is no longer on the trip."],
    [{ kind: "note", op: "create", label: "Meet at the gate", status: 404 }, "“Meet at the gate”, which you added before the update, wasn't kept: what it belonged to is no longer on the trip."],
    [{ kind: "packing", op: "create", label: "Wool socks", status: 400 }, "“Wool socks”, which you added before the update, wasn't kept: the trip couldn't take it as it was written."],
    [{ kind: "event", op: "update", label: "", status: 403 }, "A change you made before the update wasn't kept: it isn't yours to change now."],
    [{ kind: "me", op: "update", label: "", status: 400 }, "A change to your own settings from before the update wasn't kept: the trip couldn't take it as it was written."],
  ];
  for (const [t, want] of lines) check(`${t.kind} ${t.op} ${t.status}${t.label ? "" : ", no name"}: ${want.slice(0, 44)}…`, r(t) === want, r(t));
  const refused = { case: "refused", kind: "purchase", op: "update", label: "Taxi to the harbor", status: 403 };
  const packing = [{ case: "bag-renamed", from: "Day bag", to: "Daypack" }, { case: "list-removed", name: "Trek" }, { case: "tick-nowhere", label: "Sun hat" }];
  const after = oldLines([packing[0], packing[1], refused, packing[2]]);
  check("it counts toward 'and N more', which then says changes, not packing changes", after.length === 3 && after[2] === "and 2 more changes from before the update weren't carried over.", after[2]);
  const first = oldLines([refused, ...packing]);
  check("said first, the rest still counted as packing changes", first.length === 3 && first[0] === lines[0][1] && first[2] === "and 2 more packing changes from before the update weren't carried over.", first[2]);
  check("one refusal and two others are all said in full", oldLines([refused, packing[0], packing[1]]).length === 3 && !/more/.test(oldLines([refused, packing[0], packing[1]])[2]));
}

console.log("\n10. the first script: one text, in the file and inline in every page that starts through it");
{
  const fs = await import("node:fs");
  const read = (p) => fs.readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8");
  const file = read("js/fresh-app.js"), page = read("index.html"), sw = read("sw.js");
  check("index.html carries public/js/fresh-app.js inline, word for word", file.length > 2000 && page.includes(`<script>\n${file}</script>`));
  check("nothing in it spells a script tag or an HTML comment (either would end the inline copy)", !/<\/?script|<!--/i.test(file));
  check("index.html's own module waits for it, and imports the app only after", /if \(window\.__shellReady\) await window\.__shellReady;/.test(page) && page.indexOf("await window.__shellReady") < page.indexOf('import("/js/store.js")') && !/^\s*import\s.*from\s/m.test(page.slice(page.indexOf("await window.__shellReady"))));
  check("the worker keeps the file with the shell", /"\/js\/fresh-app\.js",/.test(sw));
  // Every page that starts a module through the guard carries it INLINE, never by its src: a worker keeps its own copy of
  // the file, and a new page loading it by its src ran the old guard (21 Nov, shell_build_check A).
  const pages = fs.readdirSync(new URL("../public/", import.meta.url)).filter((f) => f.endsWith(".html")).sort();
  const guarded = pages.filter((f) => /freshApp|__shellReady/.test(read(f)));
  check(`every page that starts through the guard (${guarded.length}) carries it inline, word for word`,
    guarded.length >= 6 && guarded.every((f) => read(f).includes(`<script>\n${file}</script>`)),
    guarded.filter((f) => !read(f).includes(`<script>\n${file}</script>`)).join(", ") || guarded.join(", "));
  check("no page loads the guard by its src", pages.every((f) => !/<script[^>]*src="\/js\/fresh-app\.js"/.test(read(f))),
    pages.filter((f) => /<script[^>]*src="\/js\/fresh-app\.js"/.test(read(f))).join(", ") || "none");
  check("index.html's marker is not the old worker's: data-app=\"wegoplace-app\"", /<html[^>]*data-app="wegoplace-app"/.test(page) && !page.includes('data-app="wegoplace"'));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);

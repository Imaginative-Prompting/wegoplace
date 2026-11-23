// The guides hold true (model §16; the guides' README, "Rules for these files"), through the MCP
// itself: part of check:mcp.
//   * each get_*_guide tool serves its guide exactly as src/mcp/guides/ has it;
//   * every tool a guide names in backticks is one the MCP registers;
//   * every fenced `json example:<tool>` block runs through that real tool, in the order the
//     guides are read (trip-setup, places, itinerary, packing, pictures, split), on one made-up
//     trip, as one person's app, and is taken. TRIP_ID and the MEMBER_ID_… names become the
//     trip's and its members'. What the examples point at but no example makes is made first
//     and listed (ASSUMED), so the list shows what a guide leaves to an earlier conversation;
//   * every refusal a guide describes is planted and happens as the guide says.

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/server.mjs";

const ORDER = ["trip-setup", "places", "itinerary", "packing", "pictures", "split"];
const GUIDE_TOOL = { "trip-setup": "get_trip_guide", itinerary: "get_itinerary_guide", places: "get_places_guide", packing: "get_packing_guide", pictures: "get_pictures_guide", split: "get_split_guide" };
const DIR = path.join(ROOT, "src/mcp/guides");

// What the examples point at that no example makes: places an event or a picture names.
const ASSUMED = [
  { id: "lisbon-airport", name: "Lisbon airport", kind: "transit", subkind: "airport", why: "Where the flight lands.", area: "lisbon", lat: 38.7742, lng: -9.1342 },
  { id: "tasca-do-largo", name: "Tasca do Largo", kind: "food", subkind: "restaurant", why: "Saturday's lunch.", area: "alfama", lat: 38.7118, lng: -9.1296 },
  { id: "miradouro-do-exemplo", name: "Miradouro do Exemplo", kind: "sight", subkind: "viewpoint", why: "The view at dusk.", area: "alfama", lat: 38.7116, lng: -9.1309 },
];

export async function guides({ t, server, person, app, bring }) {
  const text = Object.fromEntries(ORDER.map((g) => [g, fs.readFileSync(path.join(DIR, `${g}.md`), "utf8")]));
  const host = await person("Rae Guide");
  const { mcp } = await app(host, { name: "Guide App" });

  t.part("The guides, as the tools serve them");
  for (const g of ORDER) {
    const got = await mcp.call(GUIDE_TOOL[g], {});
    t.ok(`${GUIDE_TOOL[g]} serves ${g}.md exactly`, !got.isError && got.text === text[g], got.text.slice(0, 80));
  }
  const registered = new Set(await mcp.toolNames());
  const named = new Set();
  for (const g of ORDER) {
    for (const m of text[g].matchAll(/`((?:get|list|put|remove|set|create|update|undo|picture)_[a-z_]+)`/g)) named.add(m[1]);
    for (const m of text[g].matchAll(/```json example:([a-z_]+)/g)) named.add(m[1]);
  }
  const notTools = [...named].filter((x) => !registered.has(x) && !/^(list_key|picture_url|set_by)$/.test(x));
  t.ok(`every tool a guide names is one the MCP has (${named.size} named)`, notTools.length === 0, notTools.join(", "));

  t.part("Every example, through its tool");
  // The members the examples name, made and brought onto the trip once it exists.
  const tokens = [...new Set(ORDER.flatMap((g) => [...text[g].matchAll(/MEMBER_ID[_A-Z0-9]*/g)].map((m) => m[0])))];
  let tripId = null;
  const members = {};
  const fill = (s) => tokens.reduce((acc, k) => acc.replaceAll(`"${k}"`, JSON.stringify(members[k])), s.replaceAll('"TRIP_ID"', JSON.stringify(tripId)));
  for (const g of ORDER) {
    const blocks = [...text[g].matchAll(/```json example:([a-z_]+)\n([\s\S]*?)```/g)];
    for (const [index, [, tool, body]] of blocks.entries()) {
      if (g === "places" && index === 0) {
        // Before the first place card: the ones the later examples point at (ASSUMED).
        const made = await mcp.call("put_places", { trip_id: tripId, summary: "What the examples point at", places: ASSUMED });
        t.ok(`  (made first, as the examples assume them: ${ASSUMED.map((p) => p.id).join(", ")})`, !made.isError, made.text.slice(0, 300));
      }
      let args;
      try { args = JSON.parse(fill(body)); } catch (e) { t.ok(`${g}.md, ${tool} example ${index + 1}: is JSON`, false, String(e)); continue; }
      const res = await mcp.call(tool, args);
      t.ok(`${g}.md, ${tool} example ${index + 1} is taken`, !res.isError, res.text.slice(0, 500));
      if (tool === "create_trip" && !res.isError) {
        tripId = res.json.trip.id;
        for (const k of tokens) {
          const p = await person(`Member ${k.replace("MEMBER_ID_", "").replace("OF_", "").toLowerCase()} Guide`);
          await bring(host, tripId, p);
          members[k] = p.user.id;
        }
      }
    }
  }

  // packing.md's two starters examples, one after the other: the first's stay after the second.
  const firstStarters = [...text.packing.matchAll(/```json example:set_packing_starters\n([\s\S]*?)```/g)][0];
  if (firstStarters) {
    const wanted = JSON.parse(fill(firstStarters[1])).starters.map((x) => x.label);
    const have = new Set(((await mcp.call("get_packing", { trip_id: tripId })).json?.starters ?? []).map((x) => x.label));
    t.ok(`packing.md: the first starters example's ${wanted.length} are all still there after the second`, wanted.every((l) => have.has(l)), wanted.filter((l) => !have.has(l)));
  }

  t.part("Every refusal a guide describes, as it describes it");
  const T = tripId;
  const refused = async (what, tool, args, test) => {
    const res = await mcp.call(tool, { trip_id: T, summary: what, ...args });
    t.ok(`${what}`, res.isError && test(res), res.text.slice(0, 400));
  };
  // itinerary.md
  await refused("itinerary.md: an event of any other kind is refused", "put_events", { events: [{ id: "x-kind", kind: "party", title: "x", starts: "2027-05-09T20:00", tz: "Europe/Lisbon" }] }, (r) => /kind/.test(r.text));
  await refused("itinerary.md: an event outside the trip's dates is refused, with those dates in the error", "put_events", { events: [{ id: "x-year", kind: "plan", title: "x", starts: "2026-05-09T10:00", tz: "Europe/Lisbon" }] }, (r) => /2027-05-07/.test(r.text) && /2027-05-16/.test(r.text));
  await refused("itinerary.md: changing the dates so an event falls outside is refused, naming the first and last day with events", "update_trip", { ends_on: "2027-05-07" }, (r) => /2027-05-07/.test(r.text) && /2027-05-08/.test(r.text));
  await refused("itinerary.md: a time that happens twice is refused with both readings", "put_events", { events: [{ id: "x-twice", kind: "plan", title: "x", starts: "2027-10-31T01:30", tz: "Europe/Lisbon" }] }, (r) => (r.json?.readings ?? []).map((x) => x.at).join() === "2027-10-31T01:30+01:00,2027-10-31T01:30+00:00");
  // places.md, trip-setup.md
  await refused("places.md, trip-setup.md: coordinates outside the place's area are refused", "put_places", { places: [{ id: "x-far", name: "x", kind: "food", subkind: "cafe", why: "x", area: "alfama", lat: 41.15, lng: -8.61 }] }, (r) => /bounds|inside|area/i.test(r.text));
  await refused("places.md: a subkind not on the list is refused, and the error carries the list", "put_places", { places: [{ id: "x-sub", name: "x", kind: "food", subkind: "gastropub", why: "x" }] }, (r) => /viewpoint/.test(r.text) && /cafe/.test(r.text));
  await refused("places.md: hours in another form are refused, with the format in the error", "put_places", { places: [{ id: "x-hours", name: "x", kind: "food", subkind: "cafe", why: "x", hours: "Mo-Fr 9am-5pm approx" }] }, (r) => /Tue-Sat|Daily|24 hours/.test(r.text));
  // packing.md
  // A list a starter is on, planted here (the examples' own may change). The guide teaches lists, not bags (21 Nov).
  await mcp.call("set_packing_lists", { trip_id: T, summary: "A list for the check", lists: [{ key: "check-list", name: "Check list" }] });
  const planted = await mcp.call("set_packing_starters", { trip_id: T, summary: "One starter on the check list", starters: [{ scope: "person", label: "Check item", category: "gear", on: ["check-list"] }] });
  t.ok("  (a starter planted on a list of its own)", !planted.isError, planted.text.slice(0, 300));
  await refused("packing.md: removing a whole list a starter is on is refused, saying how many", "set_packing_lists", { lists: [{ key: "check-list", remove: true }] }, (r) => /\b1\b/.test(r.text) && /starter|suggest/i.test(r.text));
  const off = await mcp.call("set_packing_starters", { trip_id: T, summary: "The check item off the list", starters: [{ scope: "person", label: "Check item", on: [] }] });
  const gone = await mcp.call("set_packing_lists", { trip_id: T, summary: "The check list removed", lists: [{ key: "check-list", remove: true }] });
  t.ok("  (with nothing on it, a list is removed with remove: true)", !off.isError && !gone.isError, `${off.text.slice(0, 200)} ${gone.text.slice(0, 200)}`);
  // pictures.md
  const pic = (extra) => ({ place_id: "miradouro-do-exemplo", url: "https://pics.example/harbour.png", license: "CC BY 4.0", credit: "A photographer", source: "https://pics.example/", ...extra });
  await refused("pictures.md: a license that forbids commercial use (NC) is refused", "set_picture", pic({ license: "CC BY-NC 4.0" }), (r) => /NC or ND/.test(r.text));
  await refused("pictures.md: a license that forbids changes (ND) is refused", "set_picture", pic({ license: "CC BY-ND 4.0" }), (r) => /NC or ND/.test(r.text));
  await refused("pictures.md: a picture from a licensed source without its credit and source is refused", "set_picture", pic({ credit: undefined, source: undefined }), (r) => /credit/.test(r.text) && /source/.test(r.text));
  await refused("pictures.md: a picture over 1600 px on its long side is refused with the limits in the error", "set_picture", pic({ url: "https://pics.example/wide.png" }), (r) => /1600/.test(r.text) && /600/.test(r.text));
  await refused("pictures.md: a picture over 600 kB is refused with the limits in the error", "set_picture", pic({ url: "https://pics.example/big.png" }), (r) => /600/.test(r.text) && /1600/.test(r.text));
  const link = await mcp.call("picture_upload", { trip_id: T, summary: "A photo of the view", place_id: "miradouro-do-exemplo", license: "own" });
  const put = (body) => link.json?.url ? fetch(link.json.url, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body }) : { status: `no link: ${link.text.slice(0, 120)}` };
  const firstTry = await put(Buffer.from("not a picture at all"));
  const secondTry = await put(Buffer.from("not a picture at all"));
  t.same("pictures.md: an upload link is used up by its first upload, even one that is refused", [firstTry.status, secondTry.status], [415, 404]);
  // split.md
  await refused("split.md: an exact split whose amounts don't add up is refused, with the difference", "put_purchase", { purchase: { id: "x-exact", description: "x", amount: "24.00", currency: "EUR", split: { mode: "exact", amounts: { [members.MEMBER_ID_1]: "8.00", [members.MEMBER_ID_2]: "8.00" } } } }, (r) => /difference/.test(r.text) && /800/.test(r.text));
  const other = await person("Lin Guide");
  await bring(host, T, other);
  const otherApp = (await app(other, { name: "Lin's App" })).mcp;
  const theirs = await otherApp.call("put_purchase", { trip_id: T, summary: "Change the lunch", purchase: { id: "lunch-tasca", description: "Changed", amount: "1.00", currency: "EUR", split: { mode: "even", people: [other.user.id] } } });
  t.ok("split.md: a change to someone else's purchase is refused", theirs.isError && theirs.json?.refused === 403, theirs.text.slice(0, 300));
  for (const [field, value] of [["description", "Dinner"], ["split", { mode: "even", people: [members.MEMBER_ID_1] }], ["event_id", "lunch-tasca"], ["place_id", "tasca-do-largo"]]) {
    await refused(`split.md: a payment with ${field === "split" ? "a split" : `${field === "description" ? "a description" : `an ${field.replace("_id", "")}`}`} is refused`, "put_payment",
      { payment: { id: `x-pay-${field}`, from: members.MEMBER_ID_OF_ANA, to: members.MEMBER_ID_OF_SAM, amount: "5.00", currency: "EUR", [field]: value } }, (r) => r.text.includes(field));
  }
}

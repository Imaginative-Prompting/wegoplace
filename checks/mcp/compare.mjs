// tools/compare-trips.mjs on two made-up trips: what it pairs, what it says differs, and what
// only one has. No server. Part of check:changes' run (node only).
//
//   node checks/mcp/compare.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Report } from "../lib/person.mjs";
import { ROOT } from "../lib/server.mjs";
import { compareTrips, reportOf } from "../../tools/compare-trips.mjs";

const t = new Report("comparing two trips");
const at = (day, hm, off = "+01:00") => Date.parse(`${day}T${hm}:00${off}`) / 1000;
const real = {
  trip: { name: "Coast trip" },
  areas: [{ id: "lisbon", name: "Lisbon" }, { id: "porto", name: "Porto" }],
  places: [
    { id: "cafe-a", name: "Café Árvore", kind: "food", subkind: "cafe", hours: "Daily 08:00-18:00", lat: 38.7120, lng: -9.1300 },
    { id: "view-b", name: "Miradouro B", kind: "sight", subkind: "viewpoint", lat: 38.7130, lng: -9.1310, picture: { url: "/media/x" } },
    { id: "only-real", name: "Old bookshop", kind: "shopping", subkind: "books", lat: 38.7, lng: -9.14 },
  ],
  events: [
    { id: "e1", title: "Coffee", kind: "meal", starts_at: at("2027-05-08", "09:00"), tz: "Europe/Lisbon", place_id: "cafe-a", detail: "Counter." },
    { id: "e2", title: "Flight home", kind: "flight", starts_at: at("2027-05-16", "07:40"), ends_at: at("2027-05-16", "10:20", "-04:00"), tz: "Europe/Lisbon", end_tz: "America/New_York" },
  ],
  packing_lists: [{ key: "travel", name: "Carry-on only" }],
  packing_starters: [{ scope: "person", label: "Passport", category: "documents" }],
};
const built = {
  trip: { name: "Coast trip, rebuilt" },
  areas: [{ id: "a1", name: "lisbon" }],
  places: [
    { id: "p1", name: "Cafe Arvore", kind: "food", subkind: "cafe", hours: "Daily 08:00-17:00", lat: 38.7121, lng: -9.1301 },
    { id: "p2", name: "The viewpoint", kind: "sight", subkind: "viewpoint", lat: 38.71305, lng: -9.13105 },
    { id: "p3", name: "A bakery", kind: "food", subkind: "bakery", lat: 38.69, lng: -9.2 },
  ],
  events: [
    { id: "x1", title: "Coffee", kind: "meal", starts_at: at("2027-05-08", "09:30"), tz: "Europe/Lisbon", place_id: "p1", detail: "" },
  ],
  packing_lists: [{ key: "l", name: "carry-on only" }],
  packing_starters: [{ scope: "person", label: "passport", category: "documents" }, { scope: "group", label: "Charger", category: "gear" }],
};
// A pair the first version made on a real comparison: two places sharing only the city's name.
// (Lisbon is one of the trip's areas; the two are 130 m apart, so too far to pair by nearness.)
real.places.push({ id: "bank-c", name: "Caja Lisbon (branch + ATM)", kind: "practical", subkind: "atm", lat: 38.7200, lng: -9.15 });
built.places.push({ id: "p4", name: "Hospital Regional de Lisbon", kind: "practical", subkind: "hospital", lat: 38.7212, lng: -9.15 });
// One name inside the other, no location on one side: the same pharmacy chain's branch.
real.places.push({ id: "farm-r", name: "MiFarma - Avenida Central (open to 23:00)", kind: "practical", subkind: "pharmacy", lat: 38.73, lng: -9.16 });
built.places.push({ id: "farm-b", name: "Mifarma", kind: "practical", subkind: "pharmacy" });
const cmp = compareTrips(real, built);
t.same("areas pair by name, case aside; one is only in the real trip", [cmp.score.areas.matched, cmp.sections[0][2]], [1, ["Porto"]]);
t.same("places pair by name with accents aside, and by being near one of the same kind; a bank and a hospital sharing only the city's name stay apart",
  [cmp.score.places.matched, cmp.sections[1][2], cmp.sections[1][3]], [3, ["Old bookshop", "Caja Lisbon (branch + ATM)"], ["A bakery", "Hospital Regional de Lisbon"]]);
t.same("  (and one name holding the other's, \"Mifarma\" in \"MiFarma - Avenida Central (open to 23:00)\", pairs though one has no location)",
  cmp.sections[1][1].find((p) => p.built === "Mifarma")?.name, "MiFarma - Avenida Central (open to 23:00)");
const cafe = cmp.sections[1][1].find((p) => p.name === "Café Árvore");
const view = cmp.sections[1][1].find((p) => p.name === "Miradouro B");
t.same("a pair's differences are named: the hours; a picture one has and the other hasn't",
  [cafe?.diffs.map((d) => d[0]), view?.built, view?.diffs.map((d) => d[0])], [["hours"], "The viewpoint", ["picture"]]);
const coffee = cmp.sections[2][1][0];
t.same("events pair by day and title; a later start, and a detail one has and one hasn't, are named; the place is the same place by name",
  [cmp.score.events.matched, coffee?.diffs.map((d) => d[0]).sort(), cmp.sections[2][2]], [1, ["detail", "starts"], ["2027-05-16 Flight home"]]);
t.same("packing lists and starters pair by name (and scope); one starter only in the rebuilt trip",
  [cmp.score.packing.lists_matched, cmp.score.packing.starters_matched, cmp.sections[4][3]], [1, 1, ["group: Charger"]]);
const words = reportOf(cmp, { realName: "Coast trip", builtName: "Coast trip, rebuilt" });
t.ok("the report has the score and each section", /\| Places \| 5 \| 5 \| 3 \|/.test(words) && /## Events/.test(words) && /Only in the real trip \(1\)/.test(words), words.slice(0, 300));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-compare-"));
fs.writeFileSync(path.join(scratch, "a.json"), JSON.stringify(real));
fs.writeFileSync(path.join(scratch, "b.json"), JSON.stringify(built));
const run = (out) => spawnSync(process.execPath, [path.join(ROOT, "tools/compare-trips.mjs"), "--real", path.join(scratch, "a.json"), "--built", path.join(scratch, "b.json"), "--out", out], { encoding: "utf8" });
const okRun = spawnSync(process.execPath, [path.join(ROOT, "tools/compare-trips.mjs"), "--real", path.join(scratch, "a.json"), "--built", path.join(scratch, "b.json"), "--out", path.join(scratch, "report.md"), "--json", path.join(scratch, "pairs.json")], { encoding: "utf8" });
const pairs = fs.existsSync(path.join(scratch, "pairs.json")) ? JSON.parse(fs.readFileSync(path.join(scratch, "pairs.json"), "utf8")) : null;
t.ok("as a command, it writes the report outside the tree, and with --json every pair as JSON",
  okRun.status === 0 && fs.existsSync(path.join(scratch, "report.md")) && pairs?.sections?.find((x) => x.title === "Places")?.pairs?.length === 3, okRun.stderr);
const inTree = run(path.join(ROOT, "report.md"));
t.ok("a report inside the tree is refused (it names the trip's places)", inTree.status === 2 && !fs.existsSync(path.join(ROOT, "report.md")), inTree.stderr);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(t.end());

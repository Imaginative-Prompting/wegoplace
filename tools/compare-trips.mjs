#!/usr/bin/env node
// Two trips, compared field by field: how close a trip rebuilt through the MCP comes to the one
// it was rebuilt from (the MCP brief's test: "an AI rebuilds the trip from the planning docs
// through the MCP alone, and the result is compared with the real trip").
//
//   node tools/compare-trips.mjs --real <snapshot.json> --built <snapshot.json> --out <report.md> [--json <pairs.json>]
//
// A snapshot is what GET /api/trips/<id> answers. The report names the trip's places, so it
// is written outside the tree (refused inside it).
//
// Matching, since the two never share ids: an area by its name; a place by its name (letters
// and digits only, accents aside), else by most of its name's own words (not the trip's place
// names, not "the" or "office") within 2 km, else by being within MATCH_METERS of one of the same
// kind; or by one name holding the other's distinctive words, within 500 m or unplaced;
// an event by its day and title, else by its day and start time. For each pair, the fields
// that differ; then what only one of them has.

import fs from "node:fs";
import path from "node:path";
import { clockOf } from "../public/js/shared/clock.js";
import { metersBetween } from "../public/js/shared/trip-rules.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MATCH_METERS = 75;

const plain = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Words that say where, or nothing: shared by many places of one trip, so a name match on them
// alone pairs a hospital with a bank. The trip's own place names are added per comparison.
const COMMON = new Set(["the", "and", "del", "las", "los", "por", "con", "for", "intl", "international", "branch", "office", "station"]);
let tripWords = new Set();
const words = (s) => new Set(plain(s).split(" ").filter((w) => w.length > 2 && !COMMON.has(w) && !tripWords.has(w)));
const overlap = (a, b) => { const x = words(a); const y = words(b); if (!x.size || !y.size) return 0; let n = 0; for (const w of x) if (y.has(w)) n += 1; return n / Math.max(x.size, y.size); };
const dist = (a, b) => (a.lat != null && b.lat != null ? metersBetween({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }) : null);

/** Pairs rows of a and b by `key` first, then by `near`; answers { pairs, onlyA, onlyB }. */
function pair(a, b, key, near) {
  const left = new Set(b);
  const pairs = [];
  const onlyA = [];
  for (const x of a) {
    let hit = b.find((y) => left.has(y) && key(x) && key(x) === key(y));
    if (!hit && near) hit = [...left].map((y) => [y, near(x, y)]).filter(([, s]) => s > 0).sort((p, q) => q[1] - p[1])[0]?.[0];
    if (hit) { pairs.push([x, hit]); left.delete(hit); } else onlyA.push(x);
  }
  return { pairs, onlyA, onlyB: [...left] };
}

const FIELDS = {
  place: ["kind", "subkind", "area", "address", "hours", "phone", "website", "price_level", "near_anchor", "walk_minutes"],
  event: ["kind", "tz", "end_tz", "all_day", "place_id"],
};
const same = (x, y) => JSON.stringify(x ?? "") === JSON.stringify(y ?? "");

export function compareTrips(real, built) {
  const out = { sections: [], score: {} };
  // Areas.
  const areas = pair(real.areas ?? [], built.areas ?? [], (x) => plain(x.name));
  out.score.areas = { real: real.areas?.length ?? 0, built: built.areas?.length ?? 0, matched: areas.pairs.length };
  // Places: by name, then nearby of the same kind.
  // The trip's area names (Lima, Cusco, Machu Picchu) say where, not which place.
  tripWords = new Set([...(real.areas ?? []), ...(built.areas ?? [])].flatMap((a) => plain(a.name).split(" ")).filter((w) => w.length > 2));
  const places = pair(real.places ?? [], built.places ?? [], (x) => plain(x.name), (x, y) => {
    const d = dist(x, y);
    if (d != null && d > 2000) return 0;                       // two places 2 km apart are two places
    const n = overlap(x.name, y.name);
    if (n >= 0.5) return 1 + n;                                // most of the name's own words in common
    // One name inside the other ("Mifarma" in "MiFarma - Avenida El Sol"), its words distinctive
    // enough (two of them, or one of 5 letters or more), and a few streets apart or unplaced.
    const [a, b] = [words(x.name), words(y.name)].sort((p, q) => p.size - q.size);
    const inside = a.size > 0 && [...a].every((w) => b.has(w)) && (a.size >= 2 || [...a][0].length >= 5);
    if (inside && (d == null || d <= 500)) return 1.25;
    if (x.kind === y.kind && d != null && d <= MATCH_METERS) return 1 - d / (MATCH_METERS * 2);   // the same kind of place, a few steps apart
    return 0;
  });
  const placeDiffs = places.pairs.map(([x, y]) => {
    const diffs = FIELDS.place.filter((f) => !same(x[f], y[f])).map((f) => [f, x[f], y[f]]);
    const d = dist(x, y);
    if (d == null ? (x.lat != null) !== (y.lat != null) : d > 50) diffs.push(["where", x.lat != null ? `${x.lat},${x.lng}` : "unknown", y.lat != null ? `${y.lat},${y.lng}${d != null ? ` (${Math.round(d)} m away)` : ""}` : "unknown"]);
    if (Boolean(x.picture) !== Boolean(y.picture)) diffs.push(["picture", Boolean(x.picture), Boolean(y.picture)]);
    return { name: x.name, built: y.name, diffs };
  });
  out.score.places = { real: real.places?.length ?? 0, built: built.places?.length ?? 0, matched: places.pairs.length,
    kind_same: places.pairs.filter(([x, y]) => x.kind === y.kind).length, subkind_same: places.pairs.filter(([x, y]) => x.subkind === y.subkind).length,
    hours_same: places.pairs.filter(([x, y]) => same(x.hours, y.hours)).length, within_50m: places.pairs.filter(([x, y]) => { const d = dist(x, y); return d != null && d <= 50; }).length };
  // Events: by day and title, then by day and start.
  const view = (e) => ({ ...e, day: clockOf(e.starts_at, e.tz).date, start: e.all_day ? "all day" : clockOf(e.starts_at, e.tz).time,
    end: e.ends_at != null ? (e.all_day ? clockOf(e.ends_at, e.end_tz || e.tz).date : `${clockOf(e.ends_at, e.end_tz || e.tz).date} ${clockOf(e.ends_at, e.end_tz || e.tz).time}`) : null });
  const re = (real.events ?? []).map(view);
  const be = (built.events ?? []).map(view);
  const realPlace = new Map((real.places ?? []).map((p) => [p.id, p.name]));
  const builtPlace = new Map((built.places ?? []).map((p) => [p.id, p.name]));
  const events = pair(re, be, (x) => `${x.day} ${plain(x.title)}`, (x, y) => (x.day === y.day ? (x.start === y.start ? 1 : 0) + overlap(x.title, y.title) : 0));
  const eventDiffs = events.pairs.map(([x, y]) => {
    const diffs = FIELDS.event.filter((f) => f !== "place_id" && !same(x[f], y[f])).map((f) => [f, x[f], y[f]]);
    if (x.start !== y.start) diffs.push(["starts", `${x.day} ${x.start}`, `${y.day} ${y.start}`]);
    if (!same(x.end, y.end)) diffs.push(["ends", x.end, y.end]);
    const xp = plain(realPlace.get(x.place_id)); const yp = plain(builtPlace.get(y.place_id));
    if (xp !== yp) diffs.push(["place", realPlace.get(x.place_id) ?? null, builtPlace.get(y.place_id) ?? null]);
    if (Boolean(x.detail) !== Boolean(y.detail)) diffs.push(["detail", x.detail ? "written" : "none", y.detail ? "written" : "none"]);
    return { name: `${x.day} ${x.title}`, built: y.title, diffs };
  });
  out.score.events = { real: re.length, built: be.length, matched: events.pairs.length,
    start_same: events.pairs.filter(([x, y]) => x.day === y.day && x.start === y.start).length, place_same: eventDiffs.filter((d) => !d.diffs.some((f) => f[0] === "place")).length };
  // Packing: lists, bags, starters.
  const lists = pair(real.packing_lists ?? [], built.packing_lists ?? [], (x) => plain(x.name));
  const starters = pair(real.packing_starters ?? [], built.packing_starters ?? [], (x) => `${x.scope} ${plain(x.label)}`, (x, y) => (x.scope === y.scope ? overlap(x.label, y.label) : 0));
  out.score.packing = { lists_real: real.packing_lists?.length ?? 0, lists_built: built.packing_lists?.length ?? 0, lists_matched: lists.pairs.length,
    starters_real: real.packing_starters?.length ?? 0, starters_built: built.packing_starters?.length ?? 0, starters_matched: starters.pairs.length };
  out.sections = [
    ["Areas", areas.pairs.map(([x, y]) => ({ name: x.name, built: y.name, diffs: [] })), areas.onlyA.map((x) => x.name), areas.onlyB.map((x) => x.name)],
    ["Places", placeDiffs, places.onlyA.map((x) => x.name), places.onlyB.map((x) => x.name)],
    ["Events", eventDiffs, events.onlyA.map((x) => `${x.day} ${x.title}`), events.onlyB.map((x) => `${x.day} ${x.title}`)],
    ["Packing lists", lists.pairs.map(([x, y]) => ({ name: x.name, built: y.name, diffs: [] })), lists.onlyA.map((x) => x.name), lists.onlyB.map((x) => x.name)],
    ["Packing starters", starters.pairs.map(([x, y]) => ({ name: `${x.scope}: ${x.label}`, built: y.label, diffs: x.category !== y.category ? [["category", x.category, y.category]] : [] })),
      starters.onlyA.map((x) => `${x.scope}: ${x.label}`), starters.onlyB.map((x) => `${x.scope}: ${x.label}`)],
  ];
  return out;
}

export function reportOf(cmp, { realName, builtName }) {
  const lines = [`# ${builtName}, compared with ${realName}`, "", "## The score", "", "| | the real trip | rebuilt | matched | |", "|---|---|---|---|---|"];
  const s = cmp.score;
  lines.push(`| Areas | ${s.areas.real} | ${s.areas.built} | ${s.areas.matched} | |`);
  lines.push(`| Places | ${s.places.real} | ${s.places.built} | ${s.places.matched} | same kind ${s.places.kind_same}, subkind ${s.places.subkind_same}, hours ${s.places.hours_same}, within 50 m ${s.places.within_50m} |`);
  lines.push(`| Events | ${s.events.real} | ${s.events.built} | ${s.events.matched} | same start ${s.events.start_same}, same place ${s.events.place_same} |`);
  lines.push(`| Packing lists | ${s.packing.lists_real} | ${s.packing.lists_built} | ${s.packing.lists_matched} | |`);
  lines.push(`| Packing starters | ${s.packing.starters_real} | ${s.packing.starters_built} | ${s.packing.starters_matched} | |`, "");
  for (const [title, pairs, onlyReal, onlyBuilt] of cmp.sections) {
    lines.push(`## ${title}`, "");
    const differing = pairs.filter((p) => p.diffs.length);
    if (differing.length) {
      lines.push(`### Matched, differing (${differing.length} of ${pairs.length})`, "");
      for (const p of differing) lines.push(`- **${p.name}**${p.built !== p.name ? ` (rebuilt as "${p.built}")` : ""}: ${p.diffs.map(([f, a, b]) => `${f} ${JSON.stringify(a)} → ${JSON.stringify(b)}`).join("; ")}`);
      lines.push("");
    }
    if (onlyReal.length) lines.push(`### Only in the real trip (${onlyReal.length})`, "", ...onlyReal.map((n) => `- ${n}`), "");
    if (onlyBuilt.length) lines.push(`### Only in the rebuilt one (${onlyBuilt.length})`, "", ...onlyBuilt.map((n) => `- ${n}`), "");
  }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
  const real = flag("--real");
  const built = flag("--built");
  const out = flag("--out");
  const jsonOut = flag("--json");
  if (!real || !built || !out) { console.error("usage: node tools/compare-trips.mjs --real <snapshot.json> --built <snapshot.json> --out <report.md>"); process.exit(2); }
  for (const file of [out, jsonOut].filter(Boolean)) {
    if (!path.relative(ROOT, path.resolve(file)).startsWith("..")) { console.error("refused: the report names the trip's places; write it outside the tree."); process.exit(2); }
  }
  const a = JSON.parse(fs.readFileSync(real, "utf8"));
  const b = JSON.parse(fs.readFileSync(built, "utf8"));
  const cmp = compareTrips(a, b);
  fs.writeFileSync(out, reportOf(cmp, { realName: a.trip?.name ?? "the real trip", builtName: b.trip?.name ?? "the rebuilt trip" }) + "\n");
  if (jsonOut) {
    // Every pair and every row only one trip has, by section, for a person or a script to read.
    fs.writeFileSync(jsonOut, JSON.stringify({ score: cmp.score, sections: cmp.sections.map(([title, pairs, onlyReal, onlyBuilt]) => ({ title, pairs, onlyReal, onlyBuilt })) }, null, 2) + "\n");
  }
  console.log(JSON.stringify(cmp.score));
}

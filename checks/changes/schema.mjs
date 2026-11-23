// What a change records, held to the schema (model §9; src/trips/changes.js). No server: the
// migrations applied in memory, in order.
//
//   * every table is on TRACKED (it has its triggers) or on UNTRACKED (with why no tool writes
//     it): a table added later fails here until it is one or the other;
//   * each trigger records its table's columns, every one and nothing else, before and after,
//     so a column added later can't be left out of a change (run tools/change-triggers.mjs into
//     a new migration that drops and makes the triggers again);
//   * each tracked table has exactly the triggers TRACKED says, and no trigger records a table
//     that isn't tracked;
//   * migrations/0023_changes.sql holds the triggers tools/change-triggers.mjs writes, as written.
//
//   node checks/changes/schema.mjs        (part of check:changes)

import fs from "node:fs";
import path from "node:path";
import { Report } from "../lib/person.mjs";
import { ROOT } from "../lib/server.mjs";
import { TRACKED, UNTRACKED } from "../../src/trips/changes.js";
import { TRACKED_AT_0023, columnsOf, schemaUpTo, triggersSql } from "../../tools/change-triggers.mjs";

const t = new Report("what a change records, against the schema");
const db = schemaUpTo("9999");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
const triggers = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();

t.part("Every table is recorded or named as one no tool writes");
const tracked = new Set(TRACKED.map((x) => x.table));
const neither = tables.filter((x) => !tracked.has(x) && !(x in UNTRACKED));
t.ok("no table is on neither list", neither.length === 0, neither.join(", "));
const both = tables.filter((x) => tracked.has(x) && x in UNTRACKED);
t.ok("no table is on both", both.length === 0, both.join(", "));
const ghosts = [...tracked, ...Object.keys(UNTRACKED)].filter((x) => !tables.includes(x) && !["d1_migrations", "_cf_KV", "_cf_METADATA", "sqlite_sequence"].includes(x));
t.ok("each list names only tables there are", ghosts.length === 0, ghosts.join(", "));
// A planted table, to show the first rule can fail.
const planted = schemaUpTo("9999");
planted.exec("CREATE TABLE trip_souvenirs (trip_id TEXT, id TEXT)");
const plantedNames = planted.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
t.ok("  (a table added with neither is caught: trip_souvenirs)", plantedNames.filter((x) => !tracked.has(x) && !(x in UNTRACKED)).join() === "trip_souvenirs");

t.part("Each trigger records its table's columns exactly");
/** The columns a trigger's json_object() calls name, per side (OLD, NEW). */
function recorded(sql) {
  const sides = {};
  for (const m of sql.matchAll(/json_object\(([^)]*)\)/g)) {
    const pairs = [...m[1].matchAll(/'([a-z_0-9]+)',\s*(OLD|NEW)\.([a-z_0-9]+)/g)];
    const side = pairs[0]?.[2];
    if (!side) continue;
    const bad = pairs.filter((p) => p[1] !== p[3] || p[2] !== side);
    sides[side] = { cols: pairs.map((p) => p[1]), bad: bad.length };
  }
  return sides;
}
for (const x of TRACKED) {
  const cols = columnsOf(db, x.table);
  const mine = triggers.filter((g) => g.tbl_name === x.table && g.name.startsWith("changes_"));
  const ops = mine.map((g) => g.name.replace(`changes_${x.table}_`, "")).sort();
  t.same(`${x.table}: its triggers are ${x.ops.join(", ")}`, ops, [...x.ops].sort());
  for (const g of mine) {
    const sides = recorded(g.sql);
    const want = g.name.endsWith("_insert") ? ["NEW"] : g.name.endsWith("_delete") ? ["OLD"] : ["NEW", "OLD"];
    t.ok(`  ${g.name} records every column of ${x.table}, each as itself, on ${want.join(" and ")}`,
      want.every((s) => sides[s] && sides[s].bad === 0 && JSON.stringify(sides[s].cols) === JSON.stringify(cols)) && Object.keys(sides).length === want.length,
      { columns: cols, recorded: sides });
  }
}
const stray = triggers.filter((g) => g.name.startsWith("changes_") && !tracked.has(g.tbl_name));

t.part("What went from a trip, for a phone asking since its last (migration 0036)");
// The tables the trip's snapshot sends, from which a row can be deleted: each has one trigger, gone_<table>,
// that writes the row into trip_gone under its own table's name, and no other table has one.
const GONE = ["areas", "places", "events", "purchases", "packing_items", "packing_lists", "packing_bags", "packing_placements",
  "packing_ticks", "packing_starters", "pictures", "trip_references"];
const goneTriggers = triggers.filter((g) => g.name.startsWith("gone_"));
for (const table of GONE) {
  const g = goneTriggers.filter((x) => x.tbl_name === table);
  t.ok(`${table}: one trigger records what went, under its own name`, g.length === 1 && g[0].name === `gone_${table}`
    && /AFTER DELETE/i.test(g[0].sql) && g[0].sql.includes("INSERT INTO trip_gone") && g[0].sql.includes(`'${table}'`), g.map((x) => x.name).join(", ") || "none");
}
const strayGone = goneTriggers.filter((g) => !GONE.includes(g.tbl_name));
t.ok("no other table has one", strayGone.length === 0, strayGone.map((g) => g.name).join(", "));
t.ok("no trigger records a table that isn't tracked", stray.length === 0, stray.map((g) => g.name).join(", "));
// A planted column, to show the rule can fail.
planted.exec("ALTER TABLE places ADD COLUMN souvenir TEXT");
const placesInsert = planted.prepare("SELECT sql FROM sqlite_master WHERE name = 'changes_places_insert'").get().sql;
t.ok("  (a column added to a tracked table is caught: places.souvenir)", JSON.stringify(recorded(placesInsert).NEW.cols) !== JSON.stringify(columnsOf(planted, "places")));

t.part("Whose a private row is");
const packing = await import("../../src/api/packing.js");
const changes = await import("../../src/trips/changes.js");
t.same("the group's packing list is the same word in src/api/packing.js and src/trips/changes.js", changes.GROUP, packing.GROUP);

t.part("The migration holds the triggers as the tool writes them");
const migration = fs.readFileSync(path.join(ROOT, "migrations/0023_changes.sql"), "utf8");
t.ok("migrations/0023_changes.sql ends with exactly what tools/change-triggers.mjs writes from 0022's schema",
  migration.trimEnd().endsWith(triggersSql(schemaUpTo("0022"), TRACKED_AT_0023).trimEnd()));

process.exit(t.end());

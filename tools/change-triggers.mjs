#!/usr/bin/env node
// The triggers that record a change (model §9; migrations/0023_changes.sql), written from the
// schema the migrations before them make, so each one records exactly its table's columns.
//
//   node tools/change-triggers.mjs [--upto 0022]     prints the triggers' SQL
//
// check:changes holds the migration's triggers to the schema the same way: every table that
// holds a trip's rows has its three triggers or is on UNTRACKED (src/trips/changes.js), and each
// trigger records the table's columns, no more and no fewer. A table or column added later fails
// that check until this is run again into a new migration that drops and remakes the triggers.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { TRACKED } from "../src/trips/changes.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** The schema the migrations up to `upto` (inclusive) make, in memory. */
export function schemaUpTo(upto) {
  const db = new DatabaseSync(":memory:");
  const dir = path.join(ROOT, "migrations");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (f.slice(0, 4) > upto) break;
    db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
  }
  return db;
}

export const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

const obj = (cols, side) => `json_object(${cols.map((c) => `'${c}', ${side}.${c}`).join(", ")})`;
const key = (t, side) => `json_array(${t.key.map((c) => `${side}.${c}`).join(", ")})`;
const privateTo = (t, side) => t.private ? t.private.replaceAll("$", side) : "NULL";

/**
 * The tracked tables as 0023 made their triggers: today's, and the ones a later migration took
 * away with their triggers, where they stood (0027: notes on plans became messages in the chat).
 */
// Tables a later migration made, with their own three triggers written there by the same pattern (0048: a trip's quick
// reference list): not 0023's.
export const LATER = new Set(["trip_references"]);
export const TRACKED_AT_0023 = TRACKED.filter((t) => !LATER.has(t.table)).flatMap((t) => t.table === "events"
  ? [t, { table: "event_notes", key: ["id"], ops: ["insert", "update", "delete"] }]
  : [t]);

/** The SQL of the triggers of `tables` (every tracked table's, by default). */
export function triggersSql(db, tables = TRACKED) {
  const out = [];
  for (const t of tables) {
    const cols = columnsOf(db, t.table);
    if (!cols.length) throw new Error(`no table ${t.table}`);
    const open = "EXISTS (SELECT 1 FROM change_open)";
    const row = (when, before, after, side) =>
      `INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)\n  SELECT change_id, '${t.table}', ${key(t, side)}, ${privateTo(t, side)}, ${before}, ${after} FROM change_open;`;
    const name = (op) => `changes_${t.table}_${op}`;
    if (t.ops.includes("insert")) {
      out.push(`CREATE TRIGGER ${name("insert")} AFTER INSERT ON ${t.table} WHEN ${open}\nBEGIN\n  ${row("insert", "NULL", obj(cols, "NEW"), "NEW")}\nEND;`);
    }
    if (t.ops.includes("update")) {
      const changed = t.watch ? ` AND (${t.watch.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ")})` : "";
      out.push(`CREATE TRIGGER ${name("update")} AFTER UPDATE ON ${t.table} WHEN ${open}${changed}\nBEGIN\n  ${row("update", obj(cols, "OLD"), obj(cols, "NEW"), "NEW")}\nEND;`);
    }
    if (t.ops.includes("delete")) {
      out.push(`CREATE TRIGGER ${name("delete")} AFTER DELETE ON ${t.table} WHEN ${open}\nBEGIN\n  ${row("delete", obj(cols, "OLD"), "NULL", "OLD")}\nEND;`);
    }
  }
  return out.join("\n\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--upto");
  const upto = i < 0 ? "0022" : argv[i + 1];
  // Before 0027 the notes' table was tracked too.
  console.log(triggersSql(schemaUpTo(upto), upto < "0027" ? TRACKED_AT_0023 : TRACKED));
}

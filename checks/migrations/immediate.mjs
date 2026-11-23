// Every migration, as a remote D1 runs a file (`wrangler d1 execute --remote --file`): each file one transaction,
// foreign keys on, and every key checked at the statement that touches it. A remote run doesn't keep
// `PRAGMA defer_foreign_keys` in force through the file, so a migration that drops a table while a row elsewhere
// still points at it fails there, though it passes locally, where the pragma holds to the file's end. On 20 Nov the
// first remote run of 0019 stopped so (purchase_shares pointing at purchases); this check would have caught it.
//
//   node checks/migrations/immediate.mjs
//
// It runs the migrations in order on an empty database, with every defer pragma taken out. After 0018 it adds a
// made-up trip with a row in every table that 0019 drops or that points at one (a place, an event with a note, a
// purchase with its shares, a packing list with a section and an item placed in it), so each drop meets a row
// pointing at it. Then the rest, to the last. It holds:
//   1. every file runs, and no key is broken at the end;
//   2. the made-up rows come through (each table's count);
//   3. planted: 0019 with purchase_shares dropped after purchases again fails here, as the remote did.
//
// No server, no browser. Everyone in it is made up.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Report } from "../lib/person.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = path.join(ROOT, "migrations");
const FILES = fs.readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const SEED_AFTER = "0018_";

/** A file as a remote D1 runs it: the defer pragma isn't in force, so it's taken out. */
const immediate = (sql) => sql.replace(/^\s*PRAGMA\s+defer_foreign_keys\s*=\s*\w+\s*;\s*$/gim, "");

// The made-up trip, at 0018's schema: one row in every table 0019 drops, and in each that points at one.
const SEED = `
INSERT INTO users (id, name, created_at) VALUES ('u-ada', 'Ada Made-up', 1790000000), ('u-ben', 'Ben Made-up', 1790000000);
INSERT INTO trips (id, name, starts_on, ends_on, default_tz, created_by, created_at, host_id, rev)
  VALUES ('t-one', 'A made-up week', '2027-05-01', '2027-05-07', 'UTC', 'u-ada', 1790000000, 'u-ada', 1);
INSERT INTO places (id, trip_id, name, kind, subkind, area, address, lat, lng, why)
  VALUES ('p-one', 't-one', 'A made-up cafe', 'food', 'cafe', 'Centre', '1 Made-up Street', 1.5, 2.5, 'Somewhere to sit');
INSERT INTO events (id, trip_id, starts_at, tz, title, kind, place_id, created_by, created_at, updated_at)
  VALUES ('e-one', 't-one', 1790003600, 'UTC', 'Coffee', 'meal', 'p-one', 'u-ada', 1790000000, 1790000000);
INSERT INTO event_notes (id, event_id, user_id, body, created_at) VALUES ('n-one', 'e-one', 'u-ben', 'Made-up note', 1790000000);
INSERT INTO purchases (id, trip_id, description, amount_minor, currency, paid_by, split_mode, spent_at, event_id, place_id, created_by, created_at, updated_at, kind)
  VALUES ('pu-one', 't-one', 'Two coffees', 600, 'EUR', 'u-ada', 'weight', 1790003600, 'e-one', 'p-one', 'u-ada', 1790000000, 1790000000, 'purchase');
INSERT INTO purchase_shares (purchase_id, user_id, weight, share_minor) VALUES ('pu-one', 'u-ada', 1, 300), ('pu-one', 'u-ben', 1, 300);
INSERT INTO packing_views (id, trip_id, owner, name) VALUES ('v-one', 't-one', 'u-ada', 'Leaving home');
INSERT INTO packing_sections (id, view_id, name) VALUES ('s-one', 'v-one', 'Main bag');
INSERT INTO packing_items (id, trip_id, owner, section, label, created_by, created_at, updated_at)
  VALUES ('i-one', 't-one', 'u-ada', 'Main bag', 'Charger', 'u-ada', 1790000000, 1790000000);
INSERT INTO packing_placements (item_id, view_id, section_id) VALUES ('i-one', 'v-one', 's-one');
`;

/** Runs the migrations, each as one transaction, keys checked at once; `swap` replaces one file's text. */
function run(swap = null) {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  for (const f of FILES) {
    const sql = immediate(swap && f.startsWith(swap.file) ? swap.sql : fs.readFileSync(path.join(DIR, f), "utf8"));
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      return { db, failed: f, error: String(e?.message ?? e) };
    }
    if (f.startsWith(SEED_AFTER)) db.exec(`BEGIN; ${SEED} COMMIT;`);
  }
  return { db, failed: null, error: null };
}

const t = new Report("every migration, as a remote D1 runs a file: keys checked at each statement");
t.part("1. Every file, in order, with a made-up trip in it from 0018");
const whole = run();
t.ok(`every file runs (${FILES.length}, ${FILES[0]} to ${FILES.at(-1)}), each as one transaction with every key checked at once`,
  whole.failed === null, `${whole.failed}: ${whole.error}`);
const broken = whole.failed ? null : whole.db.prepare("PRAGMA foreign_key_check").all();
t.same("  and no key is broken at the end", broken?.length ?? -1, 0);

t.part("2. The made-up trip came through");
const count = (table) => { try { return whole.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } catch { return null; } };
t.same("its place, event, purchase and its two shares, packing list, bag, item, its placement, and the note (now a message)",
  ["places", "events", "purchases", "purchase_shares", "packing_lists", "packing_bags", "packing_items", "packing_placements", "messages"].map(count),
  [1, 1, 1, 2, 1, 1, 1, 1, 1]);

t.part("3. Planted: 0019 dropping purchases while its shares point at it, as it once did");
const f19 = FILES.find((f) => f.startsWith("0019_"));
const text19 = fs.readFileSync(path.join(DIR, f19), "utf8");
const planted = text19.replace(/^DROP TABLE purchase_shares;\n/m, "");
const old = run({ file: "0019_", sql: planted });
t.ok("(planted: with purchase_shares still there when purchases is dropped, 0019 fails here with the remote's own error)",
  planted !== text19 && old.failed === f19 && /FOREIGN KEY constraint failed/.test(old.error), `${old.failed}: ${old.error}`);

process.exit(t.end());

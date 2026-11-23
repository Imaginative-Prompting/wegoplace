// A check server's own storage, read straight from its files: every table of its database (to show a refused
// call wrote nothing), and the files in its buckets (to show a refused upload stored nothing).
//
//   const db = dbOf(server)            the server's D1 file
//   const before = db.snap()           every table (but what any request touches), as text a table
//   db.diff(before, db.snap())         the tables that differ
//   bucketFiles(server)                how many files the local buckets hold
//
// Used by check:access and check:limits. Tables any request may touch, whoever it's from, are left out: a session
// and its limits, and the runtime's own.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const EVERY_REQUEST = new Set(["sessions", "rate_limits", "d1_migrations", "_cf_KV", "_cf_METADATA", "sqlite_sequence"]);

function find(dir, test) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const f = find(p, test); if (f) return f; } else if (test(p, e.name)) return p;
  }
  return null;
}

export function dbOf(server) {
  const file = find(server.state, (p, name) => name.endsWith(".sqlite") && name !== "metadata.sqlite" && p.includes("D1"));
  if (!file) throw new Error("couldn't find the server's database file");
  /** Every table's rows (but a trip's own, when `except` names one), as text a table. */
  const snap = (except = null) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const out = new Map();
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
        if (EVERY_REQUEST.has(name)) continue;
        const cols = db.prepare(`SELECT name FROM pragma_table_info('${name}')`).all().map((c) => c.name);
        const where = !except ? "" : cols.includes("trip_id") ? ` WHERE trip_id IS NOT '${except}'` : name === "trips" ? ` WHERE id IS NOT '${except}'` : "";
        out.set(name, JSON.stringify(db.prepare(`SELECT * FROM "${name}"${where} ORDER BY rowid`).all()));
      }
      return out;
    } finally { db.close(); }
  };
  const diff = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
  return { file, snap, diff };
}

/** How many files the server's local buckets hold (R2's blobs, every bucket). */
export function bucketFiles(server) {
  let n = 0;
  const walk = (dir, inR2) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const r2 = inR2 || /r2/i.test(e.name);
      if (e.isDirectory()) walk(p, r2);
      else if (r2 && !e.name.endsWith(".sqlite") && !e.name.endsWith("-wal") && !e.name.endsWith("-shm")) n++;
    }
  };
  walk(server.state, false);
  return n;
}

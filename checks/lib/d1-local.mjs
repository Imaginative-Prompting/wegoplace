// D1 in this process, for a check that calls the Worker's modules directly (no server): node:sqlite with
// every migration applied in order, answering the calls the Worker makes:
//   db.prepare(sql).bind(...).first() / .all() -> { results } / .run() -> { meta: { changes } };  db.batch([…])
// D1 is SQLite underneath, so the SQL is the Worker's own, numbered parameters (?1) and all.
//
//   const db = d1Local();            // a fresh database with migrations/ applied
//   db.sql("SELECT …")               // rows, for the check's own reads

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function d1Local({ migrations = path.join(ROOT, "migrations") } = {}) {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const f of fs.readdirSync(migrations).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) raw.exec(fs.readFileSync(path.join(migrations, f), "utf8"));
  const plain = (v) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v);
  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...a) => statement(sql, a.map(plain)),
    async first() { const r = raw.prepare(sql).get(...args); return r === undefined ? null : { ...r }; },
    async all() { return { results: raw.prepare(sql).all(...args).map((r) => ({ ...r })), success: true }; },
    async run() { const r = raw.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return {
    prepare: (sql) => statement(sql),
    // D1 runs a batch as one transaction: all of it or none.
    async batch(list) {
      raw.exec("BEGIN");
      try {
        const out = [];
        for (const s of list) out.push(/^\s*(SELECT|WITH)\b/i.test(s.sql) ? await s.all() : await s.run());
        raw.exec("COMMIT");
        return out;
      } catch (e) { raw.exec("ROLLBACK"); throw e; }
    },
    sql: (q, ...a) => raw.prepare(q).all(...a).map((r) => ({ ...r })),
    raw,
  };
}

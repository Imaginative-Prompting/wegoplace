// ROWS OF THE GATE'S DATABASE, read or written while its server runs.
//
// One function, for the gate itself (scripts/lib/gate_db.mjs, which counts the trip's rows
// around every check) and for a check (scripts/lib/gate_trip.mjs, d1()). `database` is the
// card's: { wrangler, work, state, config }.
//
// A statement is tried again on the local database's passing faults (a second process on one
// SQLite file now and then answers "internal error" or "database is locked" to a statement
// that is fine a moment later); a statement that is wrong fails the same way every time and
// is thrown.

import { execFileSync } from "node:child_process";

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The rows of each statement of `sql` (statements parted by ";"), in order. */
export function d1EachOn(database, sql, tries = 3) {
  const { wrangler, work, state, config } = database;
  for (let attempt = 1; ; attempt++) {
    try {
      const out = execFileSync(wrangler, ["d1", "execute", "wegoplace", "--local", "--persist-to", state, "--json", "--command", sql, "-c", config],
        { cwd: work, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" } });
      return JSON.parse(out.slice(out.indexOf("["))).map((statement) => statement.results);
    } catch (e) {
      const passing = /internal error|Failed to parse body as JSON|D1_ERROR|SQLITE_BUSY|database is locked/i
        .test(String(e.stdout || "") + String(e.stderr || "") + String(e.message || ""));
      if (attempt >= tries || !passing) throw e;
      console.log(`        d1() met a passing fault of the local database (attempt ${attempt} of ${tries}), trying again: ${String(sql).replace(/\s+/g, " ").slice(0, 70)}…`);
      pause(500 * attempt);
    }
  }
}

/** The rows of `sql`'s last statement. */
export const d1On = (database, sql, tries = 3) => d1EachOn(database, sql, tries).at(-1);

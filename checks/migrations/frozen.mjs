// A branch may edit a migration's comments, never its SQL (D1 applies migrations by file name and never runs one twice,
// so an edited statement would be one database's schema and not another's). Every migrations/*.sql the base has, its
// comments and its spacing taken out, is held byte for byte to the base's: the branch it lands on (FROZEN_BASE, else
// the first of origin/rework, rework, origin/main and main that this clone has). origin/rework comes first: a lane's
// clone keeps a local rework that goes stale (21 Nov: one from 19 Nov held every tip, the live one's included, red),
// while origin/rework is what a push lands on. The output names the base it read, and its commit.
//
//   node checks/migrations/frozen.mjs [FROZEN_BASE=<ref>]
//
// PLANTED: FROZEN_PLANT=statement reads one migration with a statement added (red, naming it); FROZEN_PLANT=comment
// with one comment changed (green: comments may change).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Report } from "../lib/person.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLANT = process.env.FROZEN_PLANT || "";
if (PLANT && !["statement", "comment"].includes(PLANT)) throw new Error("FROZEN_PLANT is statement or comment");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
const has = (ref) => { try { git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`); return true; } catch { return false; } };
const BASE = process.env.FROZEN_BASE || ["origin/rework", "rework", "origin/main", "main"].find(has) || null;
const t = new Report(`a migration's SQL as ${BASE ?? "its base"} has it`);
if (!BASE) { t.ok("a base branch to hold the migrations to (FROZEN_BASE, or origin/rework, rework, origin/main or main)", false, "none here"); process.exit(t.end()); }
console.log(`  base: ${BASE} at ${git("rev-parse", "--short=8", `${BASE}^{commit}`).trim()} (${process.env.FROZEN_BASE ? "FROZEN_BASE" : "the first of origin/rework, rework, origin/main, main here"})`);

/** SQL with its comments and spacing taken out: what D1 runs. Strings are kept whole (a "--" inside one is text). */
export function statementsOf(sql) {
  let out = "", i = 0;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < sql.length; j++) { if (sql[j] === c) { if (sql[j + 1] === c) { j++; continue; } break; } }
      out += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "-" && n === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += " "; continue; }
    if (c === "/" && n === "*") { const e = sql.indexOf("*/", i + 2); i = e < 0 ? sql.length : e + 2; out += " "; continue; }
    out += c; i++;
  }
  return out.replace(/\s+/g, " ").trim();
}

const files = fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
const changed = [];
let compared = 0, commented = 0;
for (const f of files) {
  const rel = `migrations/${f}`;
  let was;
  try { was = git("show", `${BASE}:${rel}`); } catch { continue; }   // new on this branch: nothing to hold it to
  let now = fs.readFileSync(path.join(ROOT, rel), "utf8");
  if (PLANT === "statement" && f === files.find((x) => x.startsWith("0004"))) now = `${now}\nSELECT 1;\n`;
  if (PLANT === "comment" && f === files.find((x) => x.startsWith("0004"))) now = now.replace(/--/, "-- (a planted word)");
  compared++;
  if (was !== now) commented++;
  if (statementsOf(was) !== statementsOf(now)) changed.push(rel);
}
t.ok(`every migration's SQL is as ${BASE} has it (${compared} compared; ${commented} with edited comments)`, compared > 40 && changed.length === 0, changed.join(" | "));
t.same("  (the reading keeps a string whole and takes out both kinds of comment)",
  [statementsOf("SELECT '--not a comment' -- a comment\nFROM t /* another */ ;"), statementsOf("A  \n\n B")], ["SELECT '--not a comment' FROM t ;", "A B"]);
process.exit(t.end());

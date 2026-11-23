// What must not ship when this repository is published, read from the whole tree
// (tools/open-source-scan.mjs). First its rules, on planted text with made-up sources, each
// category found and a clean text passing; then the tree itself, against the live database's
// export and the owner's brief, both outside the tree. It fails while anything is found: until the
// scrub before launch, it is expected to fail, and its report says where.
//
//   npm run check:open-source -- --backup <export.sql> [--brief <brief.md>] --out <report.md outside the tree>
//   npm run check:open-source       (a clone with no export: only the rules that need nothing from outside)
//
// The brief: --brief, else WGP_BRIEF, else the first 16-wegoplace/brief.md found walking up from this tree, or from
// the clone a worktree belongs to (findBrief). With --backup, a brief that isn't found is a refusal (red, naming
// where it looked), never a category passed without reading it.
//
// Nothing here is real: the planted names, ids and words are made up.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Report } from "../lib/person.mjs";
import { CATEGORIES, PASSES, report, scanTree, scanner, sourcesFrom } from "../../tools/open-source-scan.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const backup = flag("--backup");
const named = flag("--brief") ?? process.env.WGP_BRIEF ?? null;

/**
 * Where the brief is: the first `16-wegoplace/brief.md` in a folder above `root`, or above the clone a worktree of it
 * belongs to (a worktree may sit anywhere; its clone sits under the channel's folder). { found, looked }.
 */
export function findBrief(root, commonDir = gitCommonDir(root)) {
  const looked = [];
  for (const start of [root, commonDir && path.dirname(commonDir)].filter(Boolean)) {
    for (let d = path.resolve(start); ; d = path.dirname(d)) {
      const at = path.join(d, "16-wegoplace", "brief.md");
      looked.push(at);
      if (fs.existsSync(at)) return { found: at, looked };
      if (path.dirname(d) === d) break;
    }
  }
  return { found: null, looked };
}
function gitCommonDir(root) {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
const where = named ? { found: fs.existsSync(named) ? named : null, looked: [named] } : findBrief(ROOT);
const brief = where.found;
const out = flag("--out");
const t = new Report("what must not ship");

t.part("The rules, on planted text");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-oss-"));
try {
  // A made-up export and brief.
  const dump = path.join(work, "dump.sql");
  fs.writeFileSync(dump, `CREATE TABLE users (id TEXT, name TEXT, is_admin INTEGER); INSERT INTO users VALUES ('u_zxq81kd', 'Zelda Quorn', 0);
INSERT INTO users VALUES ('u_olek', 'olek marsh', 0);
CREATE TABLE credentials (id TEXT); INSERT INTO credentials VALUES ('cred-0f9e8d7c6b');
CREATE TABLE invites (code TEXT); INSERT INTO invites VALUES ('PLANTED42');
CREATE TABLE events (title TEXT, detail TEXT); INSERT INTO events VALUES ('Sunrise over the planted lake', NULL);
CREATE TABLE purchases (description TEXT, note TEXT); INSERT INTO purchases VALUES ('Planted boat tickets', 'Paid at the planted pier');
CREATE TABLE trips (id TEXT, name TEXT, created_by TEXT); INSERT INTO trips VALUES ('zork-2031', 'Zork, a planted week', 'u_zxq81kd');`);
  const words = path.join(work, "brief.md");
  fs.writeFileSync(words, "Planted: we want the boats to leave early because the wind picks up after noon every day.\n");
  const src = sourcesFrom({ backup: dump, brief: words });
  const scan = scanner(src);
  const plant = {
    owner: "// Made by Zelda for the planted trip.",
    names: "// Olek booked the planted boat.",
    ids: 'const id = "u_zxq81kd";',
    trip: "<li>Sunrise over the planted lake</li> and zork-2031",
    words: "the boats to leave early because the wind picks up after noon",
    marks: ["// (h", "is, 13 Nov) keep it short"].join(""),
    keys: ['const AUTH_SECRET = "', "A".repeat(32), '";'].join(""),
    emails: `write to ${["zelda.quorn", "mailbox.planted.org"].join("@")}`,   // built from pieces, so this file carries none
  };
  for (const [k, text] of Object.entries(plant)) t.ok(`  ${k}: ${CATEGORIES[k]}`, (scan(text)[k] ?? 0) > 0, scan(text));
  // Made-up ids in a real one's shape; the real ones are in the production config, outside the tree.
  t.same("  account: a D1 database's id and a KV store's id in wrangler.jsonc; a placeholder of zeros is no one's",
    [scan('"database_id": "4d2c8e1a-7b3f-4c9d-8e2a-1f6b5c3d9e07"', "wrangler.jsonc").account ?? 0, scan('"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "9f3a1c7e5b2d4086a1e3c5b7d9f2a4c6" }]', "wrangler.jsonc").account ?? 0,
      scan('"database_id": "00000000-0000-0000-0000-000000000000"', "wrangler.jsonc").account ?? 0, scan('"id": "00000000000000000000000000000000"', "wrangler.jsonc").account ?? 0], [1, 1, 0, 0]);
  // How the site was built: each planted line found, built from pieces (this file carries none).
  const D = ["direct", "or"].join(""), P = ["Produc", "tion"].join(""), O = ["own", "er"].join("");
  const processPlants = [`// once (${P} step 20.5)`, `// --remote: the ${D} runs it`, `// at the ${D}'s word`, `// (the ${O}'s step at the cutover)`, `// see ${P} steps`];
  t.same(`  process: ${CATEGORIES.process}`, processPlants.map((l) => scan(l, "tools/x.mjs").process ?? 0), processPlants.map(() => 1));
  t.same("  process: read in every file (scripts, src, public, checks, a migration, wrangler.jsonc, README.md) but AGENTS.md, its one exception",
    ["scripts/lib/x.mjs", "src/x.js", "public/js/x.js", "checks/x/run.mjs", "migrations/0099_x.sql", "wrangler.jsonc", "README.md", "AGENTS.md"].map((f) => scan(processPlants[0], f).process ?? 0),
    [1, 1, 1, 1, 1, 1, 1, 0]);
  t.same("  process: what isn't process passes (the owner's name, the owner's own Chrome, a film's director, production builds)",
    [`// the ${O}'s name, in any case`, `// never the ${O}'s own Chrome`, "// a film director", "// a production build of the site"].map((l) => scan(l, "tools/x.mjs").process ?? 0), [0, 0, 0, 0]);
  const clean = 'Made-up: Ida Journey wrote "Lunch at Fonda Check" to ida@check.example; his own ticket. Zeldas aren\'t Zelda-like? The session is `wgp_session=${token}`.';
  // Place-name data (public/towns/): a town that shares a word with a person or the first trip is a
  // town; keys and emails in it are still found.
  t.same("  public/towns/ is read for keys and emails, never for names or the first trip's words",
    [scan("Zelda\tOlek", "public/towns/t-ze.txt").names ?? 0, scan("Zelda", "public/towns/t-ze.txt").owner ?? 0, (scan("Zelda", "public/js/x.js").owner ?? 0) > 0, scan(plant.emails, "public/towns/t-pl.txt").emails ?? 0],
    [0, 0, true, 1]);
  // An address may be the site's own (its support address, written in the legal pages) or a documentation or check
  // domain; any other is someone's: a personal mailbox at a mail provider is red wherever it is written.
  const mailbox = (local, domain) => `Write to ${[local, domain].join("@")} with questions.`;   // built from pieces, so this file carries none
  t.same("  emails: the site's own address passes; a mailbox at a mail provider, or any other domain, is red",
    [scan(mailbox("support", "wegoplace.com"), "public/privacy.html").emails ?? 0, scan(mailbox("help", "mail.wegoplace.com"), "public/terms.html").emails ?? 0,
      scan(mailbox("a.traveller", "gmail.com"), "public/privacy.html").emails ?? 0, scan(mailbox("support", "wegoplace.co"), "public/terms.html").emails ?? 0,
      scan(mailbox("support", "wegoplace.com.example.net"), "public/terms.html").emails ?? 0],
    [0, 0, 1, 1, 0]);
  const cleanFound = scan(clean);
  t.same("  a text with none of it passes (made-up names, an example address, a template, a word that only contains a name)", Object.keys(cleanFound).filter((k) => k !== "names" && k !== "owner"), []);
  t.same("  (a name inside a longer word isn't one; on its own it is)", [scan("Zeldas").owner ?? 0, scan("Zelda.").owner ?? 0], [0, 1]);
  t.same("  (a name is found in any case: stored as \"olek marsh\", written Olek, OLEK, olek; the owner's ZELDA and zelda too)",
    [scan("Olek").names, scan("OLEK").names, scan("olek").names, scan("ZELDA").owner, scan("zelda").owner], [1, 1, 1, 1, 1]);
  t.same("  (the owner is a source of its own, from the export: the account that made the trip, kept out of the other names)", [src.owner.includes("Zelda"), src.names.includes("Zelda")], [true, false]);
  // A named pass: in public/js/packing.js only, the plain starter list's own labels, matched
  // exactly, don't count as the first trip's words; the same words elsewhere do.
  const starters = 'const PLAIN = (() => {\n  add("gear", 1, ["Planted boat tickets", "Socks"]);\n})();\n';
  t.same("  (packing.js's own starter labels pass by name there; a label written only in this planted text counts elsewhere; anything else of the trip in that file still counts)",
    [scan(starters, "public/js/packing.js").trip ?? 0, scan(starters, "public/js/split.js").trip ?? 0, scan(starters + "// Paid at the planted pier", "public/js/packing.js").trip ?? 0], [0, 1, 1]);
  // The app's REAL starter labels (read from the tree's packing.js) pass in every file: a check or a guide that uses
  // the app's own words isn't using the trip's. Another of the trip's words beside one still counts.
  const realLabel = PASSES[0].read(fs.readFileSync(path.join(ROOT, PASSES[0].file), "utf8"))[0];
  const withLabel = scanner({ ...src, trip: [...src.trip, realLabel] });
  t.same(`  (the app's real starter labels, "${realLabel}" among them, pass in any file; the trip's other words beside one still count)`,
    [!!realLabel, withLabel(`pack the ${realLabel}`, "checks/mcp/run.mjs").trip ?? 0, withLabel(`pack the ${realLabel} // Paid at the planted pier`, "checks/mcp/run.mjs").trip ?? 0], [true, 0, 1]);
  // Finding the brief: from a tree under the channel's folder, from a worktree elsewhere through its clone, and nowhere.
  const channel = path.join(work, "channel");
  fs.mkdirSync(path.join(channel, "16-wegoplace", "lanes", "server"), { recursive: true });
  fs.writeFileSync(path.join(channel, "16-wegoplace", "brief.md"), "Planted.\n");
  fs.mkdirSync(path.join(work, "elsewhere", "wt-x"), { recursive: true });
  t.same("  the brief, found walking up from a lane, from a worktree elsewhere by its clone, and not found where there is none",
    [findBrief(path.join(channel, "16-wegoplace", "lanes", "server"), null).found, findBrief(path.join(work, "elsewhere", "wt-x"), path.join(channel, "16-wegoplace", "lanes", "server", ".git")).found,
      findBrief(path.join(work, "elsewhere", "wt-x"), null).found],
    [path.join(channel, "16-wegoplace", "brief.md"), path.join(channel, "16-wegoplace", "brief.md"), null]);
  const own = fs.readFileSync(path.join(ROOT, "tools/open-source-scan.mjs"), "utf8") + fs.readFileSync(path.join(ROOT, "checks/open-source/run.mjs"), "utf8");
  t.same("  (the scanner and this check carry none of what they look for, by shape)", ["marks", "keys", "emails", "process"].map((k) => scanner({ names: [], ids: [], trip: [], brief: null })(own, "tools/open-source-scan.mjs")[k] ?? 0), [0, 0, 0, 0]);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

t.part("The tree");
// Without the export (a public clone has none, and never should), only the rules that need nothing
// from outside run: keys, cookies, emails, marks, the account's ids. It says what it skipped.
const shapesOnly = !backup;
const reportTo = out ?? path.join(os.tmpdir(), "wgp-open-source.md");
if (!path.relative(ROOT, path.resolve(reportTo)).startsWith("..")) { console.error("refused: the report goes outside the tree."); process.exit(2); }
const src = sourcesFrom({ backup, brief });
const FROM_OUTSIDE = ["owner", "names", "ids", "trip", ...(brief ? [] : ["words"])];
// A brief asked for by name, or one a full scan needs, that isn't there: refused, never a category passed unread.
if (!brief && (named || !shapesOnly)) t.ok(`brief not found at ${where.looked.length === 1 ? where.looked[0] : `any of ${where.looked.length} places (${where.looked[0]} … ${where.looked.at(-1)})`}: pass --brief <brief.md> or set WGP_BRIEF`, false);
if (shapesOnly) console.log(`    (no --backup: the names, ids and the first trip's words aren't looked for${brief ? "" : ", nor the brief's runs"}; only what needs nothing from outside)`);
else t.ok(`(read from outside the tree: ${src.owner.length} forms of the owner's name, ${src.names.length} other names, ${src.ids.length} ids, ${src.trip.length} pieces of the first trip, ${src.brief ? `${src.brief.size} runs from the brief` : "NO brief"})`, src.owner.length > 0 && src.names.length > 0 && src.trip.length > 0 && !!src.brief);
const result = scanTree(src);
fs.writeFileSync(reportTo, report(result, src) + "\n");
const by = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, result.hits.reduce((n, h) => n + (h.found[k] ?? 0), 0)]));
for (const [k, what] of Object.entries(CATEGORIES)) {
  if ((shapesOnly || k === "words") && FROM_OUTSIDE.includes(k)) continue;
  t.ok(`none of: ${what} (${by[k]} in ${result.hits.filter((h) => h.found[k]).length} files)`, by[k] === 0);
}
console.log(`\n  report: ${reportTo}`);
process.exit(t.end());

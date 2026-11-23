#!/usr/bin/env node
// What must not ship when this repository is published (decided 13 Nov: a new public repo with a
// fresh history), read from the whole working tree: every file git tracks, and every file it
// would add. It holds none of what it looks for. What to look for is read at run time from
// outside the tree:
//
//   --backup <export.sql>  the live database's export (read-only, never in the tree): the people's
//                          names (whole and first), their account and passkey ids and invite codes,
//                          and the first trip's own words: its events' titles and details, its
//                          purchases' descriptions and notes, its notes, memories' captions,
//                          packing labels and notes, its places' why and notes, its name and id;
//   --brief <brief.md>     the owner's words (16-wegoplace/brief.md): a run of 8 words shared with it;
//
// and by shape, with nothing read: words attributed to the owner by a mark (a possessive or a
// pronoun beside words, note, pick, said, asked, …), private keys, API keys, tokens and secrets
// written as values, session cookies, real email addresses, and the account-bound ids in
// wrangler.jsonc (the D1 database's id, an account id).
//
//   node tools/open-source-scan.mjs --backup <export.sql> [--brief <brief.md>] --out <report.md>
//
// The report goes outside the tree (it names the files, never what was found in them: counts and
// paths only). Exit 1 while anything is found; check:open-source holds the rules with plants.
// Nothing is changed: the scrub is its own piece.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NOT_TEXT = /\.(png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|mp3|mp4|webm|ogg|wav|m4a|wasm|bin|pdf|zip|gz|pmtiles|pbf|sqlite)$/i;
const RUN = 8;
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** The categories, in the report's order, each with what it means. */
export const CATEGORIES = {
  owner: "the owner's name (the account that made the first trip), in any case",
  names: "a person's name (from the live database's accounts), in any case",
  ids: "an account id, a passkey id or an invite code (from the live database)",
  trip: "the first trip's own words: a title, a detail, a description, a note, a caption, a label, its name or id",
  words: `a run of ${RUN} words from the owner's brief`,
  marks: "words attributed to the owner by a mark",
  keys: "a private key, an API key, a token or a secret written as a value, or a session cookie",
  emails: "a real email address",
  account: "an id bound to the owner's Cloudflare account (wrangler.jsonc)",
  process: "how the site was built rather than what the code does: a numbered go-live step, or who on the team acts",
};

// `process` is looked for in every file but these, each with its reason.
export const PROCESS_EXCEPT = new Map([
  ["AGENTS.md", "the repository's own instructions to the people and agents building it; rewritten as a whole before publishing"],
]);

// The marks, built from pieces so this file's own lines carry none.
const HIS = ["h", "is"].join("");
const HE = ["h", "e"].join("");
const OWNER = ["own", "er"].join("");
const MARKED = new RegExp(`\\(${HIS}[,:]|\\b${HIS} (?:words|word|note|notes|pick|call|ask|answer|reply|answers)\\b|\\b${HE} (?:said|asked|wrote|picked|answered)\\b|\\bthe ${OWNER} (?:said|asked|wrote)\\b`, "i");
// How the site was built, in its own words: a go-live step by number, the session that coordinated the
// work, a step or a yes that was the owner's to give. Built from pieces too.
const DIRECTOR = ["direct", "or"].join("");
const PRODUCTION = ["produc", "tion"].join("");
const PROCESS = new RegExp(`\\b${PRODUCTION} steps?\\b|\\bthe ${DIRECTOR}\\b|\\b${DIRECTOR}['’]s\\b|\\bthe ${OWNER}['’]s (?:step|yes|call|go)\\b`, "i");
const KEYS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\b(?:wgp_session|s2)=(?!\$|<|\{|"|'|\s|;|$)[A-Za-z0-9._%-]{16,}/,
  /\b(?:secret|token|password|api[_-]?key|auth[_-]?secret)\s*[:=]\s*["'`][A-Za-z0-9+/=_.-]{24,}["'`]/i,
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Addresses that are no one's: documentation's own domains and the made-up ones checks use.
const NO_ONES = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|example|test|invalid|localhost|check\.example|wegoplace\.com|users\.noreply\.github\.com)$|^(?:noreply|no-reply|git)@/i;

/** What to look for, read from outside the tree. */
export function sourcesFrom({ backup, brief }) {
  const src = { owner: [], names: [], ids: [], trip: [], brief: null };
  if (backup) {
    const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    db.exec(fs.readFileSync(backup, "utf8"));
    const col = (sql) => { try { return db.prepare(sql).all().map((r) => r.v).filter((v) => typeof v === "string" && v.trim()); } catch { return []; } };
    const forms = (list) => [...new Set(list.flatMap((n) => [n.trim(), ...n.trim().split(/\s+/).filter((w) => w.length >= 3)]))];
    // The owner: the account that made the first trip (or the old site's admin), a source of its
    // own, so its count is seen apart. Matched in any case, as every name is: the accounts write
    // names in lowercase and prose writes them capitalized (the owner's name passed unseen in
    // 155 lines until 14 Nov).
    src.owner = forms(col("SELECT name AS v FROM users WHERE id IN (SELECT created_by FROM trips)").concat(col("SELECT name AS v FROM users WHERE is_admin = 1")));
    const owner = new Set(src.owner.map((n) => n.toLowerCase()));
    src.names = forms(col("SELECT name AS v FROM users")).filter((n) => !owner.has(n.toLowerCase()));
    src.ids = [...new Set([...col("SELECT id AS v FROM users"), ...col("SELECT id AS v FROM credentials"), ...col("SELECT code AS v FROM invites")])].filter((v) => v.length >= 6);
    src.trip = [...new Set([
      ...col("SELECT title AS v FROM events"), ...col("SELECT detail AS v FROM events"),
      ...col("SELECT description AS v FROM purchases"), ...col("SELECT note AS v FROM purchases"),
      ...col("SELECT body AS v FROM event_notes"), ...col("SELECT caption AS v FROM memories"),
      ...col("SELECT label AS v FROM packing_items"), ...col("SELECT note AS v FROM packing_items"),
      ...col("SELECT why AS v FROM places"), ...col("SELECT notes AS v FROM places"),
      ...col("SELECT name AS v FROM trips"), ...col("SELECT id AS v FROM trips"), ...col("SELECT title AS v FROM collage_shares"),
    ].map((v) => v.trim()))].filter((v) => v.length >= 12 || /^[a-z0-9]+-[0-9]{4}$/.test(v));
    db.close();
  }
  if (brief) src.brief = runsOf(words(fs.readFileSync(brief, "utf8")));
  return src;
}

const words = (text) => Array.from(text.toLowerCase().matchAll(WORD), (m) => m[0].replace(/’/g, "'"));
/** Every run of RUN words in a text, as one string each. */
const runsOf = (ws) => { const s = new Set(); for (let i = 0; i + RUN <= ws.length; i++) s.add(ws.slice(i, i + RUN).join(" ")); return s; };
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One pattern for many strings: whole words, case as written (names) or any case (the rest). */
const any = (list, { words: whole = true, caseless = false } = {}) => {
  if (!list.length) return null;
  const alts = [...list].sort((a, b) => b.length - a.length).map(escape).join("|");
  return new RegExp(whole ? `(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])` : `(?:${alts})`, `gu${caseless ? "i" : ""}`);
};

/**
 * What may pass, by name and with its reason: strings that are the first trip's words only
 * because the first trip took them from the app, read from the file that holds them (never
 * written here). `everywhere`: they pass in every file, not only their own (a check or a guide
 * that uses the app's own starter labels uses the app's words, not the trip's).
 */
export const PASSES = [{
  file: "public/js/packing.js",
  everywhere: true,
  what: "the plain starter list's labels",
  why: "they are code: the app's own suggested packing list, which the first trip's list was made from",
  read: (text) => {
    const at = text.indexOf("const PLAIN = (() => {");
    if (at < 0) return [];
    const block = text.slice(at, text.indexOf("})();", at));
    return [...block.matchAll(/\badd\("[a-z]+", \d+, \[(.*)\]\);/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  },
}];

/**
 * Place-name data: the towns the app finds a trip's place by (public/towns/, GeoNames, CC BY 4.0).
 * Its words are towns, and towns share their words with people and with the first trip's places
 * (a town can be called what someone is called), so the passes for names, the owner's name, the
 * first trip's words and the brief's runs don't read it. Keys, emails, ids and marks still do.
 */
export const PLACE_DATA = /^public\/towns\//;

/** A scanner for these sources: text (and its path) -> { category: count }. */
export function scanner(src) {
  const owner = any(src.owner ?? [], { caseless: true });
  const names = any(src.names, { caseless: true });
  const ids = any(src.ids, { words: false });
  const trip = any(src.trip, { caseless: true });
  // What passes in every file, read once from the tree's own files.
  const everywhere = new Set(PASSES.filter((p) => p.everywhere).flatMap((p) => {
    try { return p.read(fs.readFileSync(path.join(ROOT, p.file), "utf8")); } catch { return []; }
  }).map((x) => x.toLowerCase()));
  return (text, file = "") => {
    const found = {};
    const add = (k, n) => { if (n) found[k] = (found[k] ?? 0) + n; };
    const places = PLACE_DATA.test(file);
    if (owner && !places) add("owner", (text.match(owner) ?? []).length);
    if (names && !places) add("names", (text.match(names) ?? []).length);
    if (ids) add("ids", (text.match(ids) ?? []).length);
    if (trip && !places) {
      // A file's named pass: its own strings of that kind, matched exactly, don't count.
      const pass = PASSES.find((p) => p.file === file);
      const allowed = pass ? new Set(pass.read(text).map((x) => x.toLowerCase())) : null;
      add("trip", (text.match(trip) ?? []).filter((m) => !everywhere.has(m.toLowerCase()) && (!allowed || !allowed.has(m.toLowerCase()))).length);
    }
    if (src.brief?.size && !places) { const ws = words(text); let n = 0; for (let i = 0; i + RUN <= ws.length; i++) if (src.brief.has(ws.slice(i, i + RUN).join(" "))) n += 1; add("words", n); }
    add("marks", text.split("\n").filter((l) => MARKED.test(l)).length);
    add("keys", text.split("\n").filter((l) => KEYS.some((re) => re.test(l))).length);
    add("emails", (text.match(EMAIL) ?? []).filter((e) => !NO_ONES.test(e)).length);
    if (!PROCESS_EXCEPT.has(file)) add("process", text.split("\n").filter((l) => PROCESS.test(l)).length);
    if (/(^|\/)wrangler\.jsonc?$/.test(file)) {
      // An id bound to an account; a placeholder of zeros (the tree's, for a deploy of your own) is no one's.
      add("account", (text.match(/"(?:database_id|account_id|id)"\s*:\s*"[0-9a-f-]{20,}"/g) ?? []).filter((m) => !/"[0-]+"$/.test(m)).length);
    }
    return found;
  };
}

/** The tree's files: tracked, and untracked but not ignored (what the next commit could add). */
export function treeFiles(root = ROOT) {
  const list = (args) => execFileSync("git", ["ls-files", "-z", ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }).split("\0").filter(Boolean);
  return [...new Set([...list([]), ...list(["--others", "--exclude-standard"])])].sort();
}

/** Every file's findings: [{ file, found }], and the files not read (not text). */
export function scanTree(src, root = ROOT) {
  const scan = scanner(src);
  const hits = [];
  const skipped = [];
  for (const file of treeFiles(root)) {
    const full = path.join(root, file);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue;
    if (NOT_TEXT.test(file)) { skipped.push(file); continue; }
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) { skipped.push(file); continue; }
    const found = scan(buf.toString("utf8"), file);
    if (Object.keys(found).length) hits.push({ file, found });
  }
  return { hits, skipped };
}

/** The report: counts and paths, never what was found. */
export function report({ hits, skipped }, src, when = new Date().toISOString().slice(0, 16)) {
  const total = (k) => hits.reduce((n, h) => n + (h.found[k] ?? 0), 0);
  const lines = [
    `# What must not ship: the tree read (${when}Z)`, "",
    `Read by tools/open-source-scan.mjs from every file git tracks or would add (${hits.length} files with something, ${skipped.length} not text and not read). ` +
      "Counts and paths only: what was found is never written here. Looked for: " +
      `${(src.owner ?? []).length} forms of the owner's name, ${src.names.length} other names, ${src.ids.length} ids and ${src.trip.length} pieces of the first trip's own words from the live database's export, ` +
      `${src.brief ? `${src.brief.size} runs of ${RUN} words from the brief` : "no brief (not given)"}, and the shapes below.`, "",
    "| what | found | files |", "| --- | ---: | ---: |",
    ...Object.entries(CATEGORIES).map(([k, what]) => `| ${what} | ${total(k)} | ${hits.filter((h) => h.found[k]).length} |`), "",
  ];
  for (const [k, what] of Object.entries(CATEGORIES)) {
    const files = hits.filter((h) => h.found[k]).sort((a, b) => b.found[k] - a.found[k]);
    if (!files.length) continue;
    lines.push(`## ${what} (${total(k)} in ${files.length} files)`, "", ...files.map((h) => `- \`${h.file}\`: ${h.found[k]}`), "");
  }
  lines.push("## Passed by name", "", ...PASSES.map((p) => `- \`${p.file}\`: ${p.what}, matched exactly. Why: ${p.why}.`), "");
  if (skipped.length) lines.push("## Not read (not text)", "", `${skipped.length} files: pictures, fonts, map data. Pictures carry what their own metadata says; public/img's are checked before launch.`, "");
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
  const backup = flag("--backup");
  const brief = flag("--brief") ?? path.join(ROOT, "../../brief.md");
  const out = flag("--out");
  if (!backup || !out) { console.error("usage: node tools/open-source-scan.mjs --backup <export.sql> [--brief <brief.md>] --out <report.md outside the tree>"); process.exit(2); }
  if (!path.relative(ROOT, path.resolve(out)).startsWith("..")) { console.error("refused: the report goes outside the tree."); process.exit(2); }
  const src = sourcesFrom({ backup, brief: fs.existsSync(brief) ? brief : null });
  const result = scanTree(src);
  fs.writeFileSync(out, report(result, src) + "\n");
  const n = result.hits.reduce((a, h) => a + Object.values(h.found).reduce((x, y) => x + y, 0), 0);
  console.log(`${n} found in ${result.hits.length} files; report: ${out}`);
  process.exit(n ? 1 : 0);
}

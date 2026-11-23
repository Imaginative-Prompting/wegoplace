#!/usr/bin/env node
/* Every design-system class a page draws has its rule in a stylesheet that page loads.
 *
 *   node scripts/ds_links_check.mjs        (on the gate: node scripts/gate.mjs --only ds_links_check)
 *
 * No browser. /design links every stylesheet of the system, so it can't show a page that forgot one: in the app,
 * a `.ds-button` with no controls.css drew as plain text. It holds:
 *   1. THE SHELL'S PRIMITIVES: the app's page (index.html) links tokens, base, controls, lists, feedback, sheets,
 *      avatar and shell, once each, before styles.css.
 *   2. NOTHING DRAWN BARE: for each page in public/ (but /design), every `ds-` class written by the page or by a script
 *      it loads (its <script>s, and what they import, statically or by import(), followed through public/) has a rule
 *      in a stylesheet the page links or in a style it or its scripts put in the page.
 *
 * PLANTED (DSLINKS_PLANT=<name>; each changes only what this check reads):
 *   nocontrols  index.html read without its link to controls.css: 1 red (1).
 *   bare        index.html read writing a class no stylesheet has (ds-nothing-here): 1 red (2).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(REPO, "public");
const PLANT = process.env.DSLINKS_PLANT || "";
if (PLANT && !["nocontrols", "bare"].includes(PLANT)) throw new Error("DSLINKS_PLANT is nocontrols or bare");

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

let planted = false;
function read(abs) {
  let t = fs.readFileSync(abs, "utf8");
  if (abs === path.join(PUB, "index.html")) {
    const n = PLANT === "nocontrols" ? t.replace('<link rel="stylesheet" href="/ds/controls.css">\n', "")
      : PLANT === "bare" ? t.replace("</body>", '<span class="ds-nothing-here"></span>\n</body>') : t;
    if (n !== t) planted = true;
    t = n;
  }
  return t;
}
const noComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1").replace(/<!--[\s\S]*?-->/g, "");
const fromUrl = (u) => (u.startsWith("/") ? path.join(PUB, u.split(/[?#]/)[0]) : null);

// A script's whole graph: the file and everything it imports under public/.
function graph(entry, seen = new Set()) {
  if (!entry || seen.has(entry) || !fs.existsSync(entry)) return seen;
  seen.add(entry);
  const t = read(entry);
  for (const m of t.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'`]([^"'`]+\.m?js)["'`]/g)) {
    const spec = m[1];
    const abs = spec.startsWith("/") ? fromUrl(spec) : spec.startsWith(".") ? path.resolve(path.dirname(entry), spec) : null;
    if (abs && abs.startsWith(PUB)) graph(abs, seen);
  }
  return seen;
}
// The ds- classes a text writes: ds-words inside quotes, not a custom property (--ds-), an attribute (data-ds-) or a
// file name (ds/…).
function written(t) {
  const out = new Set();
  for (const q of noComments(t).matchAll(/(["'`])((?:(?!\1)[\s\S]){0,4000}?)\1/g)) {
    for (const m of q[2].matchAll(/(?<![\w/-])ds-[a-z][a-z0-9-]*(?![\w/.-]*\.(?:css|js|html))/g)) out.add(m[0]);
  }
  return out;
}
// The ds- classes a stylesheet (or a style in a script or a page) has a rule for.
const ruled = (css) => new Set([...noComments(css).matchAll(/\.(ds-[a-z][a-z0-9-]*)/g)].map((m) => m[1]));

const pages = fs.readdirSync(PUB).filter((f) => f.endsWith(".html") && f !== "design.html").sort();

section("1. The shell's primitives on the app's page");
{
  const t = read(path.join(PUB, "index.html"));
  const links = [...t.matchAll(/<link rel="stylesheet" href="\/ds\/([a-z]+)\.css">/g)].map((m) => m[1]);
  const WANT = ["tokens", "base", "controls", "lists", "feedback", "sheets", "avatar", "shell"];
  const missing = WANT.filter((w) => !links.includes(w)), twice = links.filter((l, i) => links.indexOf(l) !== i);
  const before = t.indexOf('href="/styles.css"'), last = Math.max(...WANT.map((w) => t.indexOf(`href="/ds/${w}.css"`)));
  check(`index.html links ${WANT.join(", ")}, once each, before styles.css`, !missing.length && !twice.length && before > last,
    missing.length ? `missing: ${missing.join(", ")}` : twice.length ? `twice: ${twice.join(", ")}` : `before styles.css: ${before > last}`);
}

section("2. Nothing drawn bare");
for (const page of pages) {
  const html = read(path.join(PUB, page));
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => fromUrl(m[1])).filter((p) => p && fs.existsSync(p));
  const scripts = new Set();
  for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) graph(fromUrl(m[1]), scripts);
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    for (const i of m[1].matchAll(/import\s*\(\s*["'`](\/[^"'`]+\.m?js)["'`]|\bfrom\s*["'`](\/[^"'`]+\.m?js)["'`]/g)) graph(fromUrl(i[1] || i[2]), scripts);
  }
  const has = new Set();
  for (const s of sheets) for (const c of ruled(fs.readFileSync(s, "utf8"))) has.add(c);
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) for (const c of ruled(m[1])) has.add(c);
  const writes = new Set(written(html.replace(/<style\b[\s\S]*?<\/style>/g, "")));
  for (const s of scripts) {
    const t = read(s);
    for (const c of written(t)) writes.add(c);
    for (const c of ruled(t)) has.add(c);       // a style a script puts in the page
  }
  const bare = [...writes].filter((c) => !has.has(c)).sort();
  check(`${page}: every ds- class it draws has a rule it loads (${writes.size} drawn, ${scripts.size} scripts, ${sheets.length} stylesheets)`, !bare.length, bare.join(", "));
}

if (PLANT && !planted) { console.log(`\nError: the ${PLANT} plant changed nothing`); process.exit(1); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }

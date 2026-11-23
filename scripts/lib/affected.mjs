// WHICH CHECKS A BRANCH'S FILES CAN AFFECT (gate.mjs --affected <base>).
//
// A check runs when any file it reads changed since <base>. What a check reads is
//   1. its own script and everything that script imports (followed through scripts/lib, checks/lib, and into public/
//      and src/ where a node check imports the app's modules), and
//   2. what HARNESSES.md's "What each check reads" table declares for it: files, globs and names. A declared module
//      or page counts with everything it loads: a .js or .mjs with its static imports and its import("literal")s, an
//      .html with its scripts, its inline modules' imports and its stylesheets, a .css with its @imports.
//      @app is the app around every browser check: public/index.html as loaded (the shell: its scripts, inline
//      modules and stylesheets), the worker, the manifest, the headers, public/vendor, and the server (src, migrations,
//      wrangler.jsonc). A section's own module (packing.js, split.js) is not in it: the router loads those by name.
// A check with no row always runs; so do the CORE checks, whatever changed; and every check runs when the gate itself
// or the packages change. Nothing here guesses: a check that might read a file declares it, or a glob around it.

import fs from "node:fs";
import path from "node:path";

/** Checks that run whatever changed (by their gate script, as gate.mjs lists them). */
// check:parity is here because what a route serves changes with files no declaration would name (20 Nov: flow 7 added
// pack-count.js, and the app page's theme script changed /authorize's answer, and parity was red behind the gate).
export const CORE = ["checks/journey/run.mjs", "checks/parity/run.mjs", "sw_version_check.mjs", "sw_topup_test.mjs", "a11y_check.mjs", "first_screens_check.mjs"];
/** A change to one of these runs every check: the gate, how it picks, and what installs the tools. */
export const EVERYTHING = ["scripts/gate.mjs", "scripts/lib/affected.mjs", "package.json", "package-lock.json"];
/** @app, as tokens (expanded like any declaration). */
export const APP = ["public/index.html", "public/sw.js", "public/manifest.webmanifest", "public/_headers", "public/vendor/**",
  "src/**", "migrations/**", "wrangler.jsonc"];

/** A glob as a RegExp over a repo-relative path: `**` any depth, `*` within one folder, `{a,b}` either. */
export function globRe(glob) {
  let re = "", depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; } }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") { re += "(?:"; depth++; }
    else if (c === "}" && depth) { re += ")"; depth--; }
    else if (c === "," && depth) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const isGlob = (s) => /[*?{]/.test(s);

/** The files `file` loads, repo-relative, that are there (one level). */
export function loads(root, file) {
  const abs = path.join(root, file);
  let src;
  try { src = fs.readFileSync(abs, "utf8"); } catch { return []; }
  const specs = [];
  if (/\.(m?js)$/.test(file)) {
    for (const m of src.matchAll(/(?:^|[\s;}])(?:import|export)\s[^"'`;]*?\sfrom\s*["']([^"']+)["']/g)) specs.push(m[1]);
    for (const m of src.matchAll(/(?:^|[\s;}])import\s*["']([^"']+)["']/g)) specs.push(m[1]);
    for (const m of src.matchAll(/\bimport\(\s*["']([^"'`$]+)["']\s*\)/g)) specs.push(m[1]);
  } else if (/\.html$/.test(file)) {
    for (const m of src.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) specs.push(m[1]);
    for (const m of src.matchAll(/<link\b[^>]*\brel="(?:stylesheet|modulepreload)"[^>]*\bhref="([^"]+)"/g)) specs.push(m[1]);
    for (const m of src.matchAll(/<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="(?:stylesheet|modulepreload)"/g)) specs.push(m[1]);
    for (const block of src.matchAll(/<script\b[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)) {
      for (const m of block[1].matchAll(/(?:import|export)\s[^"'`;]*?\sfrom\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"'`$]+)["']\s*\)/g)) specs.push(m[1] || m[2] || m[3]);
    }
  } else if (/\.css$/.test(file)) {
    for (const m of src.matchAll(/@import\s+(?:url\()?["']?([^"')\s;]+)/g)) specs.push(m[1]);
  }
  const out = [];
  for (let spec of specs) {
    spec = spec.split(/[?#]/)[0];
    if (!spec || /^[a-z]+:/i.test(spec)) continue;                       // node:, https:, data:
    let rel;
    if (spec.startsWith("/")) rel = path.posix.join("public", spec);     // the site's root is public/
    else if (spec.startsWith(".")) rel = path.posix.join(path.posix.dirname(file), spec);
    else continue;                                                        // a package
    rel = path.posix.normalize(rel);
    if (fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isFile()) out.push(rel);
  }
  return out;
}

/** `file` and everything it loads, all the way down. */
export function closure(root, file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const f of loads(root, file)) closure(root, f, seen);
  return seen;
}

/** HARNESSES.md's "What each check reads" table: Map(check script -> [token…]). */
export function declarations(root, file = "scripts/HARNESSES.md") {
  const md = fs.readFileSync(path.join(root, file), "utf8");
  const at = md.indexOf("\n## What each check reads");
  const out = new Map();
  if (at < 0) return out;
  const section = md.slice(at + 1).split(/\n## /)[0];
  for (const line of section.split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    const tokens = [...m[2].matchAll(/`([^`]+)`/g)].map((t) => t[1]);
    out.set(m[1].trim(), tokens);
  }
  return out;
}

/** The gate's name for a check's script: what gate.mjs --list prints, without "scripts/", "../" or arguments. */
export const nameOf = (script) => script.replace(/^scripts\//, "").replace(/^\.\.\//, "").split(" ")[0];
/** A check's script, repo-relative. */
const scriptOf = (name) => (name.includes("/") ? name : `scripts/${name}`);

/** What a check reads: { files: Set, globs: [RegExp, source][] }. */
export function readsOf(root, name, tokens) {
  const files = new Set(), globs = [];
  for (const f of closure(root, scriptOf(name))) files.add(f);
  const expand = (tok) => {
    if (tok === "@app") { for (const t of APP) expand(t); return; }
    if (tok === "(its imports)") return;
    if (isGlob(tok)) { globs.push([globRe(tok), tok]); return; }
    for (const f of closure(root, tok)) files.add(f);
    files.add(tok);
  };
  for (const t of tokens) expand(t);
  return { files, globs };
}

/**
 * The checks to run for `changed` (repo-relative paths), from `names` (the gate's checks), with why:
 * [{ name, why }]. `decl` is declarations(); `core` and `everything` default to CORE and EVERYTHING.
 */
export function pick(root, names, changed, { decl = declarations(root), core = CORE, everything = EVERYTHING } = {}) {
  const all = changed.find((f) => everything.includes(f));
  const out = [];
  for (const name of names) {
    if (all) { out.push({ name, why: `${all} changed: every check` }); continue; }
    if (core.includes(name)) { out.push({ name, why: "core" }); continue; }
    if (!decl.has(name)) { out.push({ name, why: "no declaration: always runs" }); continue; }
    const { files, globs } = readsOf(root, name, decl.get(name));
    const hit = changed.find((f) => files.has(f) || globs.some(([re]) => re.test(f)));
    if (hit) out.push({ name, why: `reads ${hit}` });
  }
  return out;
}

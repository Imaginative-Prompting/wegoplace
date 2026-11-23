#!/usr/bin/env node
/* The safe-area tokens: every inset the app reads goes through four custom properties.
 *
 *   node scripts/safe_area_tokens_check.mjs          (npm run check:safe-area)
 *
 * No browser and no server: it reads public/ as files.
 *
 * public/styles.css reads each env(safe-area-inset-*) exactly once, into --sa-top, --sa-right,
 * --sa-bottom and --sa-left, each with a 0px fallback (env() with no fallback is an empty
 * substitution in a browser that doesn't know the keyword, and poisons the calc() it sits in).
 * A test can then set those four on <html> and see the app as it is on a notched phone.
 *
 * What it holds to:
 *   - the four token declarations are in styles.css, each once, each with its 0px fallback;
 *   - no other raw env(safe-area-inset-*) in public/ but the ones listed in KNOWN below, file by
 *     file and count by count: a new one is red, and so is a listed one that has gone while the
 *     list still names it (the list shrinks with the code).
 *
 * KNOWN is meant to shrink to zero: the tokens move to ds/tokens.css (which every page but Terms
 * and Privacy loads; those two load styles.css), and each use below reads var(--sa-*) instead.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIDES = ["top", "right", "bottom", "left"];
const RAW = /env\(\s*safe-area-inset-(top|right|bottom|left)\s*(,[^)]*)?\)/g;

// The raw uses still in the tree, with why each isn't a token yet.
const KNOWN = {
  "public/css/legal.css": { count: 2, why: "Terms and Privacy's page padding" },
  "public/css/signin.css": { count: 4, why: "the sign-in page loads no styles.css, so no tokens" },
  "public/report.html": { count: 4, why: "Report a bug's page (/report) loads no styles.css, so no tokens" },
  "public/ds/overlays.css": { count: 3, why: "the design system's overlays; the design page loads no styles.css" },
  "public/ds/sheets.css": { count: 1, why: "the design system's sheet; the design page loads no styles.css" },
  "public/styles.css": { count: 2, why: "the page dock (.page-dock and its body padding)" },
};

let pass = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? `   -> ${detail}` : ""}`); }
};

/** Every .css, .js and .html file under public/, as { path: text } (the vendored and image folders left out). */
function readPublic() {
  const files = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^(vendor|img|icons)$/.test(e.name)) walk(p); continue; }
      if (/\.(css|js|html)$/.test(e.name)) files[path.relative(REPO, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(path.join(REPO, "public"));
  return files;
}

const files = readPublic();
// PLANTED: SAFE_AREA_PLANT=new-raw adds a raw use in a new place (red); =no-fallback takes --sa-top's 0px away (red).
const plant = process.env.SAFE_AREA_PLANT ?? "";
if (plant === "new-raw") files["public/css/planted.css"] = ".x { padding-top: env(safe-area-inset-top); }\n";
if (plant === "no-fallback") files["public/styles.css"] = files["public/styles.css"].replace("--sa-top: env(safe-area-inset-top, 0px);", "--sa-top: env(safe-area-inset-top);");

console.log("The four tokens, in public/styles.css");
const styles = files["public/styles.css"] ?? "";
for (const side of SIDES) {
  const decls = [...styles.matchAll(new RegExp(`--sa-${side}\\s*:\\s*env\\(\\s*safe-area-inset-${side}\\s*(,[^)]*)?\\)`, "g"))];
  check(`--sa-${side} is declared once, from env(safe-area-inset-${side}, 0px)`,
    decls.length === 1 && /^,\s*0px\s*$/.test(decls[0][1] ?? ""), decls.map((d) => d[0]).join(" | ") || "not declared");
}

console.log("\nNo raw env(safe-area-inset-*) but the known ones");
const found = {};
for (const [file, text] of Object.entries(files)) {
  for (const m of text.matchAll(RAW)) {
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    const isToken = file === "public/styles.css" && new RegExp(`--sa-${m[1]}\\s*:\\s*$`).test(text.slice(lineStart, m.index));
    if (isToken) continue;
    (found[file] ??= []).push(text.slice(0, m.index).split("\n").length);
  }
}
const unknown = Object.keys(found).filter((f) => !KNOWN[f]);
check("no file outside the list has one", unknown.length === 0, unknown.map((f) => `${f}:${found[f].join(",")}`).join(" "));
for (const [file, known] of Object.entries(KNOWN)) {
  const n = found[file]?.length ?? 0;
  check(`${file}: ${known.count} (${known.why})`, n === known.count,
    n > known.count ? `${n}, at lines ${found[file].join(", ")}: a new one; read it through var(--sa-*)`
      : `${n}: one has gone, so take it off this list`);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

#!/usr/bin/env node
/* The app's two faces are found, offline too, and the heading face's stand-in keeps its place.
 *
 *   node scripts/fonts_check.mjs          (on the gate: node scripts/gate.mjs --only fonts_check)
 *
 * No browser. It reads public/ and holds:
 *   1. THE HEADING FACE LOADS: --font-display's first family has an @font-face in styles.css whose file
 *      exists, and sw.js precaches that file. The same for --font-ui's.
 *   2. NOTHING NAMES A FONT THAT ISN'T THERE: every font a page preloads exists and is precached, and
 *      sw.js lists no font file that isn't in public/.
 *   3. THE STAND-IN IS MEASURED: --font-display's second family is a metric-matched fallback, its
 *      @font-faces taking local fonts with size-adjust and ascent and descent overrides, and between
 *      them covering every weight from 100 to 900 (a weight with no face would fall to an unadjusted
 *      font and the heading would jump when the real face arrives).
 *
 * PLANTED (FONTS_PLANT=<name>, each changes only what this check reads, never a file):
 *   oldfont     sw.js read listing the old Fraunces file in place of the heading face's: 3 red (1, and 2 twice: the
 *               pages' preloads no longer precached, and a listed file that isn't there).
 *   preload     login.html read preloading the old Fraunces file: 1 red (2).
 *   nofallback  styles.css read without the fallback's bold face: 1 red (3).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(REPO, "public");
const PLANT = process.env.FONTS_PLANT || "";
const PLANTS = ["oldfont", "preload", "nofallback"];
if (PLANT && !PLANTS.includes(PLANT)) throw new Error(`FONTS_PLANT is one of ${PLANTS.join(", ")}`);
const OLD = "/vendor/fonts/fraunces-latin-standard-normal.woff2";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

let planted = false;
function read(rel) {
  let t = fs.readFileSync(path.join(PUB, rel), "utf8");
  const put = (from, to) => { const n = t.replace(from, to); if (n !== t) planted = true; t = n; };
  if (PLANT === "oldfont" && rel === "sw.js") put(/"\/vendor\/fonts\/bricolage-grotesque-[^"]+\.woff2"/, `"${OLD}"`);
  if (PLANT === "preload" && rel === "login.html") put(/(<link rel="preload" href=")\/vendor\/fonts\/bricolage-grotesque-[^"]+\.woff2/, `$1${OLD}`);
  if (PLANT === "nofallback" && rel === "styles.css") put(/@font-face \{\n  font-family: 'Bricolage Grotesque Fallback';\n  font-weight: 550 900;[^}]*\}\n/, "");
  return t;
}

const css = read("styles.css");
const sw = read("sw.js");
const listed = new Set([...sw.matchAll(/^\s*"(\/[^"]+)",/gm)].map((m) => m[1]));
const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
const family = (b) => (b.match(/font-family:\s*'([^']+)'/) || [])[1];
const stack = (v) => (css.match(new RegExp(`--${v}:\\s*([^;]+);`)) || [])[1]?.split(",").map((s) => s.trim().replace(/^'|'$/g, "")) || [];
const exists = (u) => !!u && fs.existsSync(path.join(PUB, u));

section("1. The heading face loads");
for (const v of ["font-display", "font-ui"]) {
  const first = stack(v)[0];
  const face = faces.find((b) => family(b) === first);
  const file = face && (face.match(/url\('([^']+)'\)/) || [])[1];
  check(`--${v}'s face '${first}' loads a file that exists`, exists(file), file);
  check(`sw.js precaches '${first}''s file`, !!file && listed.has(file), file);
}

section("2. Nothing names a font that isn't there");
{
  const pages = fs.readdirSync(PUB).filter((f) => f.endsWith(".html"));
  const pre = pages.flatMap((f) => [...read(f).matchAll(/<link rel="preload" href="([^"]+\.woff2)"/g)].map((m) => [f, m[1]]));
  const lost = pre.filter(([, u]) => !exists(u) || !listed.has(u)).map(([f, u]) => `${f}: ${u}`);
  check(`every font the pages preload exists and is precached (${pre.length} preloads)`, pre.length >= 6 && !lost.length, lost.join(", "));
  const swFonts = [...listed].filter((u) => u.startsWith("/vendor/fonts/"));
  const gone = swFonts.filter((u) => !exists(u));
  check(`sw.js lists no font file that isn't there (${swFonts.length} listed)`, swFonts.length >= 2 && !gone.length, gone.join(", "));
}

section("3. The stand-in is measured");
{
  const second = stack("font-display")[1];
  const fb = faces.filter((b) => family(b) === second);
  const local = fb.every((b) => /src:\s*local\(/.test(b));
  const measured = fb.every((b) => /size-adjust:\s*[\d.]+%/.test(b) && /ascent-override:\s*[\d.]+%/.test(b) && /descent-override:\s*[\d.]+%/.test(b));
  check(`--font-display's second family '${second}' is local fonts, each sized and set to the heading face's measures (${fb.length} faces)`,
    fb.length >= 1 && local && measured);
  const ranges = fb.map((b) => (b.match(/font-weight:\s*(\d+)\s+(\d+)/) || []).slice(1).map(Number)).filter((r) => r.length === 2)
    .sort((a, b) => a[0] - b[0]);
  let at = 100, gap = "";
  for (const [lo, hi] of ranges) { if (lo > at + 1) gap = `${at}–${lo}`; at = Math.max(at, hi); }
  if (at < 900) gap = gap || `${at}–900`;
  check("between them they cover every weight from 100 to 900", ranges.length >= 1 && ranges[0][0] <= 100 && !gap,
    ranges.map((r) => r.join("–")).join(", ") + (gap ? `; nothing for ${gap}` : ""));
}

if (PLANT && !planted) { console.log(`\nError: the ${PLANT} plant changed nothing`); process.exit(1); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }

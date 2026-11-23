#!/usr/bin/env node
/* What the pad holds and what is stored are one picture: public/ds/drawing.js (the pad and the faces) against
 * public/js/shared/avatar.js (the bytes, the same module the server checks them with), and js/pictures.js's holders.
 *
 *   node scripts/picture_format_check.mjs        (on the gate: node scripts/gate.mjs --only picture_format_check)
 *
 * No browser. It holds:
 *   1. ONE SHAPE: the grid, the Fill brush and the number of palettes are the same in both; the pad's three brushes
 *      are brushes the format carries.
 *   2. THE POINTS ENCODED ARE THE POINTS DRAWN: drawings of every kind (a line, a dot, Fill, both inks, every
 *      palette, a stroke of 2,000 points, the grid's corners) come back from encode and decode exactly, and draw the
 *      same markup.
 *   3. TOO BIG IS FITTED, NEVER REFUSED: a drawing past the 16 KiB ceiling is simplified up the ladder until it fits,
 *      decodes, and keeps every stroke's ends.
 *   4. DRAW NOTHING AND NOTHING CHANGES: a face's holder for no hash, or for one that isn't one, is nothing at all;
 *      for a hash, an empty holder that names it.
 *
 * PLANTED (PFORMAT_PLANT=<name>; each changes only what this check imports):
 *   fill    drawing.js read with Fill at 254: 1 red (1).
 *   drop    the format read dropping a stroke's last point on encode: 1 red (2), 1 red (3).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLANT = process.env.PFORMAT_PLANT || "";
if (PLANT && !["fill", "drop"].includes(PLANT)) throw new Error("PFORMAT_PLANT is fill or drop");

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// The modules, copied so a plant changes what is imported and nothing on disk.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-pformat-"));
let planted = false;
function copy(rel, change) {
  const to = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let t = fs.readFileSync(path.join(REPO, rel), "utf8");
  if (change) { const n = change(t); if (n !== t) planted = true; t = n; }
  fs.writeFileSync(to, t);
}
for (const rel of ["public/js/util.js", "public/js/net.js", "public/js/forget.js", "public/ds/palettes.js", "public/ds/avatar.js"]) copy(rel);
copy("public/ds/drawing.js", (t) => (PLANT === "fill" ? t.replace("export const FILL = 255;", "export const FILL = 254;") : t));
copy("public/js/shared/avatar.js", (t) => (PLANT === "drop" ? t.replace(/(export function encode\(drawing\) \{)/, "$1\n  if (drawing && Array.isArray(drawing.strokes)) drawing = { ...drawing, strokes: drawing.strokes.map((s) => (s && Array.isArray(s.pts) && s.pts.length > 1 ? { ...s, pts: s.pts.slice(0, -1) } : s)) };") : t));
copy("public/js/pictures.js");
let D, F, P, PALETTES;
try {
  D = await import(pathToFileURL(path.join(tmp, "public/ds/drawing.js")).href);
  F = await import(pathToFileURL(path.join(tmp, "public/js/shared/avatar.js")).href);
  P = await import(pathToFileURL(path.join(tmp, "public/js/pictures.js")).href);
  ({ PALETTES } = await import(pathToFileURL(path.join(tmp, "public/ds/palettes.js")).href));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

section("1. One shape");
check(`the grid is ${D.GRID} in both`, D.GRID === F.GRID, `${D.GRID} / ${F.GRID}`);
check(`Fill is the same brush in both (${D.FILL})`, D.FILL === F.BRUSH_FILL, `${D.FILL} / ${F.BRUSH_FILL}`);
check(`the palettes the pad offers are the palettes the format takes (${PALETTES.length})`, PALETTES.length === F.PALETTE_COUNT, `${PALETTES.length} / ${F.PALETTE_COUNT}`);
check("the pad's three brushes are brushes the format carries", D.BRUSHES.every((b) => Number.isInteger(b) && b >= 1 && b < F.BRUSH_FILL), D.BRUSHES.join(", "));

section("2. The points encoded are the points drawn");
{
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const line = (n) => Array.from({ length: n }, () => [rnd(256), rnd(256)]);
  const CASES = [
    ["a line", { palette: 0, strokes: [{ ink: 0, brush: 52, pts: line(30) }] }],
    ["a dot", { palette: 1, strokes: [{ ink: 1, brush: 110, pts: [[127, 127]] }] }],
    ["Fill, then a line over it", { palette: 4, strokes: [{ ink: 0, brush: D.FILL, pts: [[127, 127]] }, { ink: 1, brush: 22, pts: line(12) }] }],
    ["the grid's corners", { palette: 7, strokes: [{ ink: 0, brush: 22, pts: [[0, 0], [255, 0], [255, 255], [0, 255]] }] }],
    ["a stroke of 2,000 points", { palette: 3, strokes: [{ ink: 1, brush: 52, pts: line(2000) }] }],
    ...PALETTES.map((p, i) => [`the ${p.name} palette, both inks`, { palette: i, strokes: [{ ink: 0, brush: 22, pts: line(5) }, { ink: 1, brush: 110, pts: line(3) }] }]),
  ];
  const off = [];
  for (const [what, d] of CASES) {
    const bytes = F.encode(d);
    const back = bytes && F.decode(bytes);
    if (!back || JSON.stringify(back) !== JSON.stringify(d) || D.pictureSvg(back) !== D.pictureSvg(d)) off.push(what);
  }
  check(`all ${CASES.length} drawings come back exactly and draw the same`, !off.length, off.join(", "));
}

section("3. Too big is fitted, never refused");
{
  let seed = 11;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const big = { palette: 2, strokes: Array.from({ length: 40 }, (_, k) => ({ ink: k % 2, brush: 52, pts: Array.from({ length: 400 }, (_, i) => [Math.round(127 + 100 * Math.cos(i / 20 + k)), Math.round(127 + 100 * Math.sin(i / 17 + k)) + (rnd(3) - 1)].map((v) => Math.max(0, Math.min(255, v)))) })) };
  const raw = F.encode(big);
  const f = F.fit(big);
  const back = f && F.decode(f.bytes);
  const endsKept = !!back && back.strokes.every((s, i) => {
    const o = f.drawing.strokes[i];
    return s.pts.length >= 1 && JSON.stringify(s.pts[0]) === JSON.stringify(o.pts[0]) && JSON.stringify(s.pts[s.pts.length - 1]) === JSON.stringify(o.pts[o.pts.length - 1]);
  });
  check(`a drawing of ${raw ? raw.length : "?"} bytes is fitted under ${F.DRAWING_BYTES_MAX} (eps ${f ? f.eps : "?"}), decodes, and keeps every stroke's ends`,
    !!raw && raw.length > F.DRAWING_BYTES_MAX && !!f && f.eps > 0 && f.bytes.length <= F.DRAWING_BYTES_MAX && !!back && endsKept
    && JSON.stringify(back) === JSON.stringify(f.drawing), f ? `${f.bytes.length} bytes, ${back ? back.strokes.length : 0} strokes` : "no fit");
}

section("4. Draw nothing and nothing changes");
check("a face's holder for no hash is nothing", P.pictureHolder("") === "" && P.pictureHolder(undefined) === "" && P.pictureHolder(null) === "");
check("for something that isn't a hash, nothing", ['"><img src=x>', "short", "a".repeat(13), "with space!"].every((h) => P.pictureHolder(h) === ""));
check("for a hash, an empty holder that names it", P.pictureHolder("AbCdEf012_-x") === '<span class="ds-face-pic" data-face-hash="AbCdEf012_-x"></span>', P.pictureHolder("AbCdEf012_-x"));

if (PLANT && !planted) { console.log(`\nError: the ${PLANT} plant changed nothing`); process.exit(1); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }

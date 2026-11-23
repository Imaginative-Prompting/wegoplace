#!/usr/bin/env node
/* A drawn picture, without a browser: the shape the pad and the faces hold (public/ds/drawing.js) and the face's
 * markup (public/ds/avatar.js).
 *
 *   node scripts/picture_check.mjs        (on the gate: node scripts/gate.mjs --only picture_check)
 *
 * It holds:
 *   1. DRAW NOTHING AND NOTHING CHANGES: a face with no picture, with a picture that isn't one (each of the hostile
 *      shapes in 2), or with a hash nothing has loaded, is byte for byte the initials it always was, plus at most the
 *      empty holder a hash waits in.
 *   2. ONLY A PICTURE IS DRAWN: checkDrawing refuses, without throwing, a palette out of the list, an ink but 0 or 1,
 *      a brush of 0 or over 255, a point off the grid or not an integer, a stroke with no points, no strokes, and an
 *      object whose reading throws.
 *   3. ONE GEOMETRY, ONE GROUND, ONE INK: a one-point stroke is "M p L p" (a dot with a round cap); a line is
 *      midpoint quadratics through its points; each stroke is one <path> at its brush's width (brush / 1000 of the
 *      picture), all in the one ink the face says (var(--ds-pic-ink)), on the ground the face says
 *      (var(--ds-pic-ground)), whatever palette and inks the picture was stored with; no colour of its own in the
 *      markup; a Fill (the old pad's) is not drawn, and a picture that was only a Fill is its ground.
 *
 * PLANTED (PICTURE_PLANT=<name>; each changes only what this check reads or calls, never a file):
 *   lenient   checkDrawing read accepting an ink of 2: 3 red (the face no longer the initials in 1; the refusal and
 *             the empty markup in 2).
 *   joined    pictureSvg read drawing every stroke into one path: 2 red (3: the paths, and the Fill picture's lines).
 *   oldink    pictureSvg read painting each stroke in its old palette ink again: 2 red (3: the one ink, no colour).
 *   fillback  pictureSvg read drawing a Fill again: 1 red (3).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLANT = process.env.PICTURE_PLANT || "";
const PLANTS = ["lenient", "joined", "oldink", "fillback"];
if (PLANT && !PLANTS.includes(PLANT)) throw new Error(`PICTURE_PLANT is one of ${PLANTS.join(", ")}`);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// The modules, copied to a temporary folder so a plant can change what is imported.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-picture-"));
let planted = false;
function copy(rel, change) {
  const to = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let t = fs.readFileSync(path.join(REPO, rel), "utf8");
  if (change) { const n = change(t); if (n !== t) planted = true; t = n; }
  fs.writeFileSync(to, t);
}
copy("public/js/util.js");
copy("public/ds/palettes.js");
copy("public/ds/drawing.js", (t) => {
  if (PLANT === "lenient") t = t.replace("(s.ink !== 0 && s.ink !== 1)", "(s.ink !== 0 && s.ink !== 1 && s.ink !== 2)");
  if (PLANT === "joined") t = t.replace(/for \(const s of drawnStrokes\(d\)\) \{\n    body \+= `<path d="\$\{strokePathD\(s\.pts\)\}"/, 'for (const s of drawnStrokes(d).slice(0, 1)) {\n    body += `<path d="${drawnStrokes(d).map((x) => strokePathD(x.pts)).join("")}"');
  if (PLANT === "oldink") t = t.replace('style="stroke:${INK}"', 'style="stroke:${PALETTES[d.palette].inks[s.ink]}"');
  if (PLANT === "fillback") t = t.replace("export const drawnStrokes = (d) => d.strokes.filter((s) => s.brush < FILL);", "export const drawnStrokes = (d) => d.strokes;");
  return t;
});
copy("public/ds/avatar.js");
let D, A, PALETTES;
try {
  D = await import(pathToFileURL(path.join(tmp, "public/ds/drawing.js")).href);
  A = await import(pathToFileURL(path.join(tmp, "public/ds/avatar.js")).href);
  ({ PALETTES } = await import(pathToFileURL(path.join(tmp, "public/ds/palettes.js")).href));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const good = { palette: 2, strokes: [{ ink: 0, brush: 52, pts: [[40, 120], [100, 60], [160, 130], [220, 90]] }, { ink: 1, brush: 22, pts: [[127, 200]] }] };
const fill = { palette: 6, strokes: [{ ink: 1, brush: D.FILL, pts: [[127, 127]] }] };
const s = (strokes, palette = 0) => ({ palette, strokes });
const HOSTILE = {
  "palette 8 (past the list)": s([{ ink: 0, brush: 52, pts: [[1, 1]] }], 8),
  "palette -1": s([{ ink: 0, brush: 52, pts: [[1, 1]] }], -1),
  "palette 1.5": s([{ ink: 0, brush: 52, pts: [[1, 1]] }], 1.5),
  "ink 2": s([{ ink: 2, brush: 52, pts: [[1, 1]] }]),
  "brush 0": s([{ ink: 0, brush: 0, pts: [[1, 1]] }]),
  "brush 256": s([{ ink: 0, brush: 256, pts: [[1, 1]] }]),
  "a point at 256": s([{ ink: 0, brush: 52, pts: [[256, 1]] }]),
  "a point at -1": s([{ ink: 0, brush: 52, pts: [[1, -1]] }]),
  "a point at 3.5": s([{ ink: 0, brush: 52, pts: [[3.5, 1]] }]),
  "a point of three numbers": s([{ ink: 0, brush: 52, pts: [[1, 1, 1]] }]),
  "a stroke with no points": s([{ ink: 0, brush: 52, pts: [] }]),
  "no strokes": s([]),
  "strokes not a list": { palette: 0, strokes: "x" },
  "a string": "<svg onload=alert(1)>",
  "an object whose reading throws": new Proxy({}, { get() { throw new Error("no"); } }),
};

section("1. Draw nothing and nothing changes");
{
  const name = "Ada Reyes";
  const base = A.faceHtml({ name, size: 44 });
  const diffs = [];
  for (const [what, d] of [["null", null], ...Object.entries(HOSTILE)]) {
    let got;
    try { got = A.faceHtml({ name, size: 44, drawing: d }); } catch (e) { got = "threw " + e.message; }
    if (got !== base) diffs.push(what);
  }
  check(`a face with no picture, or with any of ${Object.keys(HOSTILE).length} things that aren't one, is the initials byte for byte`, !diffs.length, diffs.join(", ") || base);
  const waiting = A.faceHtml({ name, size: 44, picture: "abcdef0123456789" });
  check("a hash nothing has loaded adds only its empty holder", waiting === base.replace(/<\/span>$/, '<span class="ds-face-pic" data-face-hash="abcdef0123456789"></span></span>'), waiting);
  check("a hash that isn't one adds nothing", A.faceHtml({ name, size: 44, picture: '"><img src=x>' }) === base);
}

section("2. Only a picture is drawn");
{
  const let_in = [];
  for (const [what, d] of Object.entries(HOSTILE)) {
    let r;
    try { r = D.checkDrawing(d); } catch (e) { r = "threw"; }
    if (r !== null) let_in.push(what);
  }
  check(`checkDrawing refuses all ${Object.keys(HOSTILE).length} hostile shapes, and never throws`, !let_in.length, let_in.join(", "));
  check("checkDrawing takes a real picture and a Fill", D.checkDrawing(good) === good && D.checkDrawing(fill) === fill);
  check("pictureSvg of a thing that isn't a picture is nothing", Object.values(HOSTILE).every((d) => D.pictureSvg(d) === ""));
}

section("3. One geometry");
{
  check("a one-point stroke is M p L p (a round cap: a dot)", D.strokePathD([[12, 34]]) === "M12,34L12,34", D.strokePathD([[12, 34]]));
  check("a line is midpoint quadratics through its points", D.strokePathD([[0, 0], [10, 0], [20, 10]]) === "M0,0Q10,0 15,5L20,10", D.strokePathD([[0, 0], [10, 0], [20, 10]]));
  const svg = D.pictureSvg(good);
  const paths = [...svg.matchAll(/<path d="([^"]*)" fill="none" style="stroke:([^"]*)" stroke-width="([^"]*)" stroke-linecap="round" stroke-linejoin="round"\/>/g)];
  check("each stroke is one path at brush / 1000 of the picture", paths.length === good.strokes.length
    && paths.every((m, i) => m[1] === D.strokePathD(good.strokes[i].pts) && Math.abs(+m[3] - (good.strokes[i].brush / 1000) * 255) < 0.01),
    paths.map((m) => m[3]).join(" | "));
  check("every stroke, whichever ink it was stored with, is in the one ink the face says", paths.length && paths.every((m) => m[2] === "var(--ds-pic-ink, var(--ink-1))"),
    paths.map((m) => m[2]).join(" | "));
  check("on the ground the face says, filling the square", svg.includes('<rect width="255" height="255" style="fill:var(--ds-pic-ground, var(--gray-3))"/>'), svg.slice(0, 160));
  const own = [...svg.matchAll(/#[0-9A-Fa-f]{3,8}\b|rgba?\(/g)].map((m) => m[0]);
  check("the markup names no colour of its own (not the stored palette's, not any)", !own.length && PALETTES.every((P) => ![P.ground, ...P.inks].some((c) => svg.includes(c))), own.join(", "));
  const filled = { palette: 3, strokes: [{ ink: 0, brush: D.FILL, pts: [[127, 127]] }, ...good.strokes.map((x) => ({ ...x, ink: 1 }))] };
  const fsvg = D.pictureSvg(filled);
  const fpaths = [...fsvg.matchAll(/<path /g)].length;
  const fonly = D.pictureSvg(fill);
  check("a Fill is not drawn: \"fill, then draw in the other ink\" keeps its lines on the ground, and a lone Fill is the ground",
    fpaths === good.strokes.length && !/stroke-width="(3[0-9]{2}|[4-9][0-9]{2})/.test(fsvg) && fonly.includes("<rect") && !fonly.includes("<path"),
    `${fpaths} paths; lone Fill: ${fonly.includes("<path") ? "drawn" : "the ground"}`);
  check("the pad's three brushes are 22, 52 and 110 thousandths", D.BRUSHES.join() === "22,52,110");
}

if (PLANT && !planted) { console.log(`\nError: the ${PLANT} plant changed nothing`); process.exit(1); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }

// collage_layout_test.mjs — the unit test for public/js/collage-layout.js.
//
//   node scripts/collage_layout_test.mjs            # run everything
//   node scripts/collage_layout_test.mjs --verbose  # print stats per case
//
// No test framework: it asserts, it prints, and it exits non-zero on the first failure it
// can no longer ignore (it runs every case, then exits 1 if any failed). The layout engine
// is pure data with no DOM, so this is the whole verification surface for it — the renderers
// are verified separately, in a browser, against the Layout this produces.
//
// Node >= 22 detects the ESM syntax in public/js/collage-layout.js even though the repo has
// no package.json; there is a data-URL fallback below for anything older.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../public/js/collage-layout.js");

let L;
try {
  L = await import("file://" + SRC);
} catch {
  const code = readFileSync(SRC, "utf8");
  L = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const {
  layoutCollage, mediaFromMemories, normaliseMedia, layoutSignature, validateLayout,
  boundsOf, itemAABB, outerRect, frameMetrics, buildIndex, queryRect, pickTopAt,
  shouldUseOriginal, originalZoomFor, rngFrom, hash32, makeSeed,
  FRAMES, BACKGROUNDS, DEFAULTS, LAYOUT_VERSION, THUMB_LONG_EDGE_PX, SOFTEN_FACTOR,
  boardOf, BOARD, boardTall,
} = L;

const VERBOSE = process.argv.includes("--verbose");
const DEG = Math.PI / 180;

let passed = 0;
const failures = [];
let group = "";

function section(name) { group = name; console.log("\n── " + name + " " + "─".repeat(Math.max(0, 74 - name.length))); }
function ok(msg, extra) { passed++; console.log("  PASS  " + msg + (extra ? "   " + extra : "")); }
function fail(msg, detail) {
  failures.push(group + " / " + msg + (detail ? "\n         " + detail : ""));
  console.log("  FAIL  " + msg + (detail ? "\n        " + detail : ""));
}
function check(cond, msg, detail) { cond ? ok(msg) : fail(msg, detail); return !!cond; }
function checkClose(a, b, eps, msg) {
  const d = Math.abs(a - b);
  d <= eps ? ok(msg, `(|${fmt(a)} - ${fmt(b)}| = ${fmt(d)} <= ${eps})`)
    : fail(msg, `|${a} - ${b}| = ${d} > ${eps}`);
}
const fmt = (v) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v));
const pct = (v) => (v * 100).toFixed(2) + "%";

// ── deep structural diff, used for the determinism proof ──────────────────────────────────
function deepDiff(a, b, path = "", out = []) {
  if (out.length > 40) return out;
  if (a === b) return out;
  const ta = a === null ? "null" : typeof a, tb = b === null ? "null" : typeof b;
  if (ta !== tb) { out.push(`${path}: type ${ta} vs ${tb}`); return out; }
  if (ta !== "object") {
    if (typeof a === "number" && Object.is(a, b)) return out;
    out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${path}: array vs object`); return out; }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i]))
    out.push(`${path}: keys [${ka}] vs [${kb}]`);
  for (const k of new Set([...ka, ...kb])) deepDiff(a?.[k], b?.[k], path ? path + "." + k : k, out);
  return out;
}

// ── fixture media ─────────────────────────────────────────────────────────────────────────
// Real-ish dimensions: iPhone 4:3 stills both ways up, 16:9 and 9:16 video, the odd pano and
// a square crop, plus rows with MISSING dimensions to exercise the fallback.
const SHAPES = [
  [4032, 3024], [3024, 4032], [1920, 1080], [1080, 1920],
  [4032, 3024], [3024, 4032], [2048, 2048], [5000, 1400],
  [1440, 2560], [3840, 2160],
];

function makeMedia(n, opts = {}) {
  const r = rngFrom("fixture:" + (opts.tag || "") + ":" + n);
  const out = [];
  for (let i = 0; i < n; i++) {
    const shape = opts.shape ? opts.shape(i, r) : SHAPES[Math.floor(r() * SHAPES.length)];
    const isVideo = opts.allPhotos ? false : r() < (opts.videoRate ?? 0.18);
    const missingDims = opts.missingDims && i % 11 === 3;
    out.push({
      id: `md_${i}`,
      memoryId: `mem_${Math.floor(i / 3)}`,
      kind: isVideo ? "video" : "photo",
      key: `o/ab/${i}/deadbeef${i}.${isVideo ? "mov" : "jpg"}`,
      thumb_key: `t/cd/${i}/cafe${i}.webp`,
      mime: isVideo ? "video/quicktime" : "image/jpeg",
      width: missingDims ? 0 : shape[0],
      height: missingDims ? 0 : shape[1],
      duration_s: isVideo ? 1 + r() * 40 : 0,
      bytes: 1000 + i,
      sort: i,
    });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════════════════
section("determinism");
// ══════════════════════════════════════════════════════════════════════════════════════════
{
  const media = makeMedia(120, { tag: "det" });
  const a = layoutCollage(media, { seed: "trip_demo_2027" });
  const b = layoutCollage(media, { seed: "trip_demo_2027" });

  const diff = deepDiff(a, b);
  check(diff.length === 0, "same seed + same media -> deep-equal Layout",
    diff.slice(0, 5).join("\n         "));
  check(JSON.stringify(a) === JSON.stringify(b), "…and byte-identical JSON",
    `len ${JSON.stringify(a).length} vs ${JSON.stringify(b).length}`);
  check(layoutSignature(a) === layoutSignature(b), "…and identical layoutSignature()");

  // A third run interleaved with other layouts, to prove there is no hidden module state.
  layoutCollage(makeMedia(40, { tag: "noise" }), { seed: "other" });
  layoutCollage(media, { seed: "different_seed" });
  const c = layoutCollage(media, { seed: "trip_demo_2027" });
  check(JSON.stringify(a) === JSON.stringify(c),
    "…and still identical after other layouts ran in between (no module state)");

  const other = layoutCollage(media, { seed: "trip_demo_2027_reroll" });
  check(layoutSignature(a) !== layoutSignature(other), "a different seed re-rolls the board");
  let moved = 0;
  for (let i = 0; i < a.items.length; i++)
    if (a.items[i].x !== other.items[i].x || a.items[i].rot !== other.items[i].rot) moved++;
  check(moved > a.items.length * 0.9, "…and re-roll moves essentially every item",
    `${moved}/${a.items.length} moved`);

  // Source-level guards. The first is the one call that would silently destroy all of the
  // above; the second is what keeps this module runnable in node. Comments are stripped
  // first — the file talks about both of these at length.
  const src = readFileSync(SRC, "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check(!/Math\.random\s*\(/.test(code), "no Math.random() anywhere in collage-layout.js");
  check(!/\bdocument\b|\bwindow\.|navigator\./.test(code), "no DOM globals in collage-layout.js");
  // One import, of a leaf of values (the grounds and how the board looks), which itself imports nothing and touches
  // no DOM: nothing can drag a DOM dependency in.
  const imports = [...code.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  const reexports = [...code.matchAll(/^\s*export\s*\{[^}]*\}\s*from\s+"([^"]+)"/gm)].map((m) => m[1]);
  check([...imports, ...reexports].every((f) => f === "./shared/board-look.js" || f === "./shared/fasteners.js"),
    "it imports only the two shared leaves (board-look.js, fasteners.js)", JSON.stringify([...imports, ...reexports]));
  for (const name of ["fasteners.js"]) {
    const leaf2 = readFileSync(new URL("../public/js/shared/" + name, import.meta.url), "utf8");
    check(!/^\s*import\s/m.test(leaf2) && !/\bdocument\b|\bwindow\.|navigator\./.test(leaf2), `${name} imports nothing and touches no DOM`);
  }
  {
    const leaf = readFileSync(new URL("../public/js/shared/board-look.js", import.meta.url), "utf8");
    check(!/^\s*import\s/m.test(leaf) && !/\bdocument\b|\bwindow\.|navigator\./.test(leaf), "board-look.js imports nothing and touches no DOM");
  }

  // Intrinsic traits: appending media must not re-tilt what is already on the board.
  const grown = media.concat(makeMedia(9, { tag: "grown" }).map((m, i) => ({ ...m, id: "new_" + i })));
  const g = layoutCollage(grown, { seed: "trip_demo_2027" });
  const rotById = new Map(g.items.map((it) => [it.mediaId, it.rot]));
  let sameRot = 0;
  for (const it of a.items) if (rotById.get(it.mediaId) === it.rot) sameRot++;
  check(sameRot === a.items.length,
    "adding media never changes an existing item's rotation (per-item seeded streams)",
    `${sameRot}/${a.items.length} unchanged`);

  // Quantisation: every emitted number is on the documented grid, which is what makes
  // byte-identity robust rather than luck.
  const onGrid = (v, q) => Math.abs(v * q - Math.round(v * q)) < 1e-9;
  let offGrid = null;
  for (const it of a.items) {
    for (const k of ["x", "y", "w", "h", "rot"]) if (!onGrid(it[k], 100)) offGrid = `${it.id}.${k}=${it[k]}`;
    if (!onGrid(it.aspect, 10000)) offGrid = `${it.id}.aspect=${it.aspect}`;
  }
  check(!offGrid, "all positions/sizes on a 0.01 grid, aspects on 1e-4", offGrid || "");
  check(!Object.is(a.items.find((i) => i.x === 0)?.x, -0), "no negative zero in output");
  check(a.version === LAYOUT_VERSION && typeof a.seed === "string" && BACKGROUNDS.includes(a.background),
    "Layout carries version, seed and a registered background", `background=${a.background}`);
  const autos = Array.from({ length: 40 }, (_, i) => layoutCollage(makeMedia(3, { tag: "auto" + i }), { seed: "auto-" + i }).background);
  const notCork = autos.filter((b) => b !== "corkboard");
  check(notCork.length === 0 && L.AUTO_BACKGROUND === "corkboard",
    "Automatic is the cork on every seed (40 seeds, nothing requested)", notCork.join(","));
  check(layoutCollage(makeMedia(3), { seed: "auto-0", background: "fridge" }).background === "fridge",
    "a ground that is picked is kept");
}

// ══════════════════════════════════════════════════════════════════════════════════════════
section("aspect fidelity — never distorted, never letterboxed");
// ══════════════════════════════════════════════════════════════════════════════════════════
{
  const media = makeMedia(200, { tag: "aspect", missingDims: true });
  const lay = layoutCollage(media, { seed: "aspect" });
  const norm = normaliseMedia(media);
  const byId = new Map(norm.map((m) => [m.mediaId, m]));

  let worstErr = 0, worstId = "";
  let badDim = null, tooSmall = null, tooBig = null, squareGuess = 0;
  for (const it of lay.items) {
    const srcAspect = byId.get(it.mediaId).aspect;
    const err = Math.abs(it.w / it.h - srcAspect) / srcAspect;
    if (err > worstErr) { worstErr = err; worstId = it.id; }
    if (!(it.w > 0 && it.h > 0)) badDim = it.id;
    // The pile is scaled to fit its board when it would overflow it (stats.fit), every print alike.
    if (Math.min(it.w, it.h) < DEFAULTS.minEdge * (lay.stats.fit || 1) - 0.02) tooSmall = `${it.id} short=${Math.min(it.w, it.h)}, fit ${lay.stats.fit}`;
    if (Math.max(it.w, it.h) > DEFAULTS.maxEdge + 0.02) tooBig = `${it.id} long=${Math.max(it.w, it.h)}`;
    if (it.aspect === 1) squareGuess++;
  }
  check(worstErr < 1e-3, "rendered w/h matches the source aspect for every item",
    `worst ${pct(worstErr)} on ${worstId}`);
  check(!badDim, "no zero or negative dimensions", badDim || "");
  check(!tooSmall, `short edge never below minEdge (${DEFAULTS.minEdge}) times the board's fit (${lay.stats.fit})`, tooSmall || "");
  check(!tooBig, `long edge never above maxEdge (${DEFAULTS.maxEdge})`, tooBig || "");

  // The fallback for a media row with no width/height must not be square.
  const noDims = normaliseMedia([{ id: "x", key: "o/a/b/c.jpg", width: 0, height: 0 }]);
  check(noDims[0].aspect !== 1 && noDims[0].aspect === DEFAULTS.fallbackAspect,
    "media rows with no dimensions fall back to 4:3, never to square",
    `aspect=${noDims[0].aspect}`);
  const absurd = normaliseMedia([{ id: "x", key: "o/a/b/c.jpg", width: 20000, height: 1 }]);
  check(absurd[0].aspect === DEFAULTS.fallbackAspect, "impossible metadata (20000x1) falls back");
  const pano = normaliseMedia([{ id: "x", key: "o/a/b/c.jpg", width: 5000, height: 1400 }]);
  checkClose(pano[0].aspect, 5000 / 1400, 1e-9, "a real 3.57:1 panorama keeps its true aspect");

  // Aspect evening: in a plain justified row a 3:4 portrait carries 4/3 / 3/4 = 1.78x less
  // area than a 4:3 landscape and reads as a bookmark next to it. `aspectEven` halves that
  // exponent, so the ratio should land near sqrt(1.78) = 1.33 and never near 1.78.
  const pairMedia = [
    { id: "land", key: "o/a/1/a.jpg", width: 4032, height: 3024 },
    { id: "port", key: "o/a/2/b.jpg", width: 3024, height: 4032 },
  ];
  const pair = layoutCollage(pairMedia, { seed: "pair" });
  const areaOf = (id) => { const it = pair.items.find((i) => i.mediaId === id); return it.w * it.h; };
  const ratio = areaOf("land") / areaOf("port");
  check(ratio < 1.5, "portrait and landscape carry comparable area, not comparable width",
    `landscape/portrait area ratio ${ratio.toFixed(3)}`);
  const flatPair = layoutCollage(pairMedia, { seed: "pair", aspectEven: false });
  const flatRatio = (() => {
    const l = flatPair.items.find((i) => i.mediaId === "land");
    const p = flatPair.items.find((i) => i.mediaId === "port");
    return (l.w * l.h) / (p.w * p.h);
  })();
  check(flatRatio > ratio + 0.2, "…and turning aspectEven off measurably widens that gap",
    `${flatRatio.toFixed(3)} with evening off vs ${ratio.toFixed(3)} with it on`);
  check(Math.abs(pair.items[0].w / pair.items[0].h - pair.items[0].aspect) < 1e-3 &&
    Math.abs(pair.items[1].w / pair.items[1].h - pair.items[1].aspect) < 1e-3,
    "…without either of them being distorted to get there");
}

// ══════════════════════════════════════════════════════════════════════════════════════════
section("controlled overlap — occlusion never eats a photo");
// ══════════════════════════════════════════════════════════════════════════════════════════
const overlapCases = [
  ["mixed 120", makeMedia(120, { tag: "ov" })],
  ["mixed 240", makeMedia(240, { tag: "ov2" })],
  ["all portrait 90", makeMedia(90, { tag: "port", shape: () => [3024, 4032] })],
  ["all landscape 90", makeMedia(90, { tag: "land", shape: () => [4032, 3024] })],
  ["all square 60", makeMedia(60, { tag: "sq", shape: () => [2048, 2048] })],
  ["all panorama 40", makeMedia(40, { tag: "pano", shape: () => [5000, 1400] })],
  ["all video 50", makeMedia(50, { tag: "vid", videoRate: 1 })],
];
for (const [name, media] of overlapCases) {
  const lay = layoutCollage(media, { seed: "overlap:" + name });
  const v = validateLayout(lay, { samples: 64 });
  const detail = `max union coverage ${pct(v.maxCoverage)}, mean ${pct(v.meanCoverage)}, ` +
    `${v.overlapping}/${v.count} items overlapped, ${lay.stats.iterations} iters, ` +
    `converged=${lay.stats.converged}`;
  check(v.overLimit.length === 0,
    `${name}: no item over ${pct(DEFAULTS.maxCoverage)} covered by items above it`,
    v.overLimit.length ? JSON.stringify(v.overLimit.slice(0, 3)) : detail);
  check(v.focalCovered.length === 0, `${name}: no focal centre covered`,
    v.focalCovered.length ? JSON.stringify(v.focalCovered.slice(0, 3)) : "");
  // The aesthetic half of the rule: it has to actually overlap, or it is a contact sheet.
  check(v.overlapping > v.count * 0.7,
    `${name}: overlap is real (>70% of items are overlapped at all)`,
    `${v.overlapping}/${v.count} = ${pct(v.overlapping / v.count)}`);
  check(lay.stats.converged, `${name}: solver converged inside its cap`,
    `${lay.stats.iterations} of ${DEFAULTS.sepIterations} iterations`);
  if (VERBOSE) console.log("        " + detail);
}
{
  // The separation pass has to be load-bearing, not decorative. Same media, same seed, same
  // jitter — only the solver disabled. If the control is clean the pass is proving nothing.
  const media = makeMedia(240, { tag: "ov2" });
  const solved = layoutCollage(media, { seed: "overlap:mixed 240" });
  const raw = layoutCollage(media, { seed: "overlap:mixed 240", sepIterations: 0 });
  const vr = validateLayout(raw, { samples: 64 });
  const vs = validateLayout(solved, { samples: 64 });
  check(vr.overLimit.length > 0,
    "control: with the separation pass disabled the raw jittered board DOES violate the cap",
    `${vr.overLimit.length} items over ${pct(DEFAULTS.maxCoverage)}, worst ${pct(vr.maxCoverage)}`);
  check(vs.overLimit.length === 0 && vs.maxCoverage < vr.maxCoverage,
    "…and the separation pass fixes every one of them",
    `worst ${pct(vr.maxCoverage)} -> ${pct(vs.maxCoverage)} in ${solved.stats.iterations} iterations`);
  check(Math.abs(vs.meanCoverage - vr.meanCoverage) < 0.05,
    "…without flattening the aesthetic: mean coverage barely moves",
    `mean ${pct(vr.meanCoverage)} -> ${pct(vs.meanCoverage)}`);
  // The solver's drive signal is the SUM of pairwise areas, which is an upper bound on the
  // union it claims to control. Tolerance is the measuring lattice's own error: a sampled
  // area is wrong by at most the boundary band, O(1/samples).
  check(solved.stats.maxCoverageBound + 1 / vs.samples >= vs.maxCoverage,
    "the solver's sum-of-pairs bound is >= the true union coverage (conservative, as documented)",
    `bound ${pct(solved.stats.maxCoverageBound)} vs union ${pct(vs.maxCoverage)} ` +
    `(lattice error <= ${pct(1 / vs.samples)})`);
  check(vs.maxCoverage < DEFAULTS.maxCoverage * 0.99,
    "…and solveMargin leaves real headroom, so passing is not a rounding coin toss",
    `worst item ${pct(vs.maxCoverage)} against a ${pct(DEFAULTS.maxCoverage)} rule`);

  // Focal discs: force the issue with a much larger disc than the default and confirm the
  // pass still clears it, since "focal centre never covered" is the rule with no tolerance.
  const wide = layoutCollage(makeMedia(120, { tag: "focal" }), { seed: "focal", focalFrac: 0.30 });
  const vw = validateLayout(wide, { samples: 48, focalFrac: 0.30 });
  check(vw.focalCovered.length === 0, "a 30%-radius focal disc is still never covered",
    `${wide.stats.iterations} iterations`);
}
{
  // The pathological input: the same media row repeated, so every item lands at the same
  // jittered spot with the same rotation. Without the deterministic escape direction the
  // solver divides by a zero-length separation vector and welds them together forever.
  const dup = Array.from({ length: 12 }, () => ({
    id: "same", key: "o/a/1/x.jpg", thumb_key: "t/a/1/x.webp", width: 4032, height: 3024,
  }));
  const lay = layoutCollage(dup, { seed: "dup" });
  const v = validateLayout(lay, { samples: 48 });
  check(v.overLimit.length === 0 && v.focalCovered.length === 0,
    "12 copies of one identical media row still separate",
    `max ${pct(v.maxCoverage)}, converged=${lay.stats.converged}`);
  check(lay.stats.converged, "…and the solver reports convergence honestly");
}

// ══════════════════════════════════════════════════════════════════════════════════════════
section("degenerate cases");
// ══════════════════════════════════════════════════════════════════════════════════════════
{
  const empty = layoutCollage([], { seed: "s" });
  check(empty.items.length === 0 &&
    empty.bounds.minX === 0 && empty.bounds.maxX === 0 &&
    empty.bounds.minY === 0 && empty.bounds.maxY === 0,
    "0 items: empty layout, zero bounds, no throw");
  check(BACKGROUNDS.includes(empty.background), "0 items: still names a background");

  const one = layoutCollage(makeMedia(1, { tag: "one" }), { seed: "one" });
  check(one.items.length === 1 && one.stats.converged, "1 item: lays out and converges");
  const b1 = one.bounds;
  check(b1.maxX > b1.minX && b1.maxY > b1.minY, "1 item: bounds is a real box",
    `${(b1.maxX - b1.minX).toFixed(1)} x ${(b1.maxY - b1.minY).toFixed(1)}`);
  check(Math.abs(b1.minX) < 0.02 && Math.abs(b1.minY) < 0.02,
    "1 item: board is normalised to the origin");

  const two = layoutCollage(makeMedia(2, { tag: "two" }), { seed: "two" });
  const v2 = validateLayout(two, { samples: 64 });
  check(two.items.length === 2 && v2.ok, "2 items: valid layout",
    `coverage ${pct(v2.maxCoverage)}`);

  for (const n of [3, 5, 7]) {
    const lay = layoutCollage(makeMedia(n, { tag: "small" + n }), { seed: "small" + n });
    const v = validateLayout(lay, { samples: 48 });
    check(v.ok, `${n} items: valid layout`, `coverage ${pct(v.maxCoverage)}`);
  }

  // 500 items — the stated ceiling. Also the perf measurement.
  const big = makeMedia(500, { tag: "big" });
  const t0 = process.hrtime.bigint();
  const lay500 = layoutCollage(big, { seed: "five_hundred" });
  const t1 = process.hrtime.bigint();
  const layMs = Number(t1 - t0) / 1e6;
  const v500 = validateLayout(lay500, { samples: 48 });
  check(lay500.items.length === 500, "500 items: all placed");
  check(v500.overLimit.length === 0 && v500.focalCovered.length === 0,
    "500 items: overlap rules hold",
    `max ${pct(v500.maxCoverage)}, ${lay500.stats.iterations} iters, converged=${lay500.stats.converged}`);
  check(layMs < 2000, "500 items: layout is fast enough to run on mount",
    `${layMs.toFixed(1)} ms`);
  console.log(`        board ${lay500.stats.boardWidth.toFixed(0)} x ${lay500.stats.boardHeight.toFixed(0)} ` +
    `canvas units, ${lay500.stats.rows} rows, ${lay500.stats.iterations} solver iterations, ${layMs.toFixed(1)} ms`);

  // All-portrait at scale is the set that breaks naive column packers.
  const port = layoutCollage(makeMedia(200, { tag: "p200", shape: () => [3024, 4032] }), { seed: "p200" });
  const pa = (port.bounds.maxX - port.bounds.minX) / (port.bounds.maxY - port.bounds.minY);
  check(pa > 0.6 && pa < 2.6, "200 all-portrait: board stays a sane shape, not a column",
    `board aspect ${pa.toFixed(2)}`);
  check(validateLayout(port, { samples: 48 }).overLimit.length === 0,
    "200 all-portrait: overlap rules hold");
}

// ══════════════════════════════════════════════════════════════════════════════════════════
section("bounds — rotation accounted for (the camera clamp depends on it)");
// ══════════════════════════════════════════════════════════════════════════════════════════
{
  const lay = layoutCollage(makeMedia(150, { tag: "bounds" }), { seed: "bounds" });

  // Brute force: rotate all four corners of every FRAME box and take the extremes. This is
  // the definition; itemAABB()'s |cos|w + |sin|h form is the optimisation of it.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of lay.items) {
    const r = outerRect(it);
    const a = it.rot * DEG, cos = Math.cos(a), sin = Math.sin(a);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const lx = sx * r.w / 2, ly = sy * r.h / 2;
      const px = cx + lx * cos - ly * sin;
      const py = cy + lx * sin + ly * cos;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
  }
  const eps = 0.02;
  check(Math.abs(minX - lay.bounds.minX) <= eps && Math.abs(minY - lay.bounds.minY) <= eps &&
    Math.abs(maxX - lay.bounds.maxX) <= eps && Math.abs(maxY - lay.bounds.maxY) <= eps,
    "bounds equals the brute-force rotated-corner extent of every frame box",
    `brute [${minX.toFixed(2)}, ${minY.toFixed(2)}, ${maxX.toFixed(2)}, ${maxY.toFixed(2)}] ` +
    `vs layout [${lay.bounds.minX}, ${lay.bounds.minY}, ${lay.bounds.maxX}, ${lay.bounds.maxY}]`);

  // And prove rotation actually widened it: the unrotated union must be strictly smaller.
  let uMinX = Infinity, uMinY = Infinity, uMaxX = -Infinity, uMaxY = -Infinity;
  for (const it of lay.items) {
    const r = outerRect(it);
    uMinX = Math.min(uMinX, r.x); uMinY = Math.min(uMinY, r.y);
    uMaxX = Math.max(uMaxX, r.x + r.w); uMaxY = Math.max(uMaxY, r.y + r.h);
  }
  const rotW = lay.bounds.maxX - lay.bounds.minX, flatW = uMaxX - uMinX;
  const rotH = lay.bounds.maxY - lay.bounds.minY, flatH = uMaxY - uMinY;
  check(rotW > flatW + 1 && rotH > flatH + 1,
    "the rotated bounding box is strictly larger than the unrotated one",
    `rotated ${rotW.toFixed(1)}x${rotH.toFixed(1)} vs unrotated ${flatW.toFixed(1)}x${flatH.toFixed(1)}`);

  // Every item is inside bounds.
  let outside = null;
  for (const it of lay.items) {
    const a = itemAABB(it);
    if (a.minX < lay.bounds.minX - eps || a.minY < lay.bounds.minY - eps ||
      a.maxX > lay.bounds.maxX + eps || a.maxY > lay.bounds.maxY + eps) outside = it.id;
  }
  check(!outside, "no item's rotated AABB escapes bounds", outside || "");
  check(Math.abs(lay.bounds.minX) < 0.02 && Math.abs(lay.bounds.minY) < 0.02,
    "bounds origin is normalised to (0, 0)");
  check(validateLayout(lay).boundsExact, "validateLayout agrees bounds is exact");

  // The frame box is what gets rotated, and it is bigger than the photo for a polaroid. Every photo is bare since
  // layout version 2, so a polaroid is measured as frameMetrics() alone (an old Layout may still carry one).
  const pol = null;
  {
    const fm = frameMetrics("polaroid", 300, 300);
    check(fm.h > 300 && fm.w > 300 && fm.foot > fm.pad, "polaroid frame metrics (kept for an old Layout) are larger than the photo, heavier at the foot");
  }
  if (pol) {
    const fm = frameMetrics("polaroid", pol.w, pol.h);
    check(fm.h > pol.h && fm.w > pol.w && fm.foot > fm.pad,
      "polaroid frame box is larger than its photo and heavier at the foot",
      `photo ${pol.w}x${pol.h} -> frame ${fm.w.toFixed(1)}x${fm.h.toFixed(1)}, pad ${fm.pad.toFixed(1)}, foot ${fm.foot.toFixed(1)}`);
    check(Math.abs(pol.frameBox.w - Math.round(fm.w * 100) / 100) < 0.02,
      "item.frameBox matches frameMetrics() exactly (renderers and bounds cannot drift)");
  }
  const bareM = frameMetrics("bare", 100, 100);
  check(bareM.dx === 0 && bareM.dy === 0 && bareM.w === 100 && bareM.h === 100,
    "'bare' frame box is the photo box");
}

// ══════════════════════════════════════════════════════════════════════════════════════════
section("cross-module contract: frame geometry vs collage-frames.js");
// ══════════════════════════════════════════════════════════════════════════════════════════
// `bounds` is computed from frame geometry and the camera clamps to `bounds`. If the visual
// registry paints a wider frame than the layout budgeted for, the outermost print sits outside
// the clamp and can never be scrolled to. That failure is invisible in either module alone, so
// it is checked across both — this is the seam, and it is asserted, not assumed.
{
  const peer = resolve(HERE, "../public/js/collage-frames.js");
  let F = null;
  try { F = await import("file://" + peer); } catch (e) { F = null; }
  if (!F || !F.FRAMES || typeof F.outerSize !== "function") {
    console.log("  SKIP  collage-frames.js not present or not exporting FRAMES/outerSize yet");
    console.log("        (another agent owns that file; re-run this once it lands)");
  } else {
    const keys = Object.keys(F.FRAMES);
    check(keys.length === FRAMES.length && FRAMES.every((k) => keys.includes(k)),
      "both modules register the same frame keys", `layout ${FRAMES} vs frames ${keys}`);

    let worst = 0, worstMsg = "";
    for (const key of FRAMES) {
      for (const [w, h] of [[400, 300], [300, 400], [900, 252], [130, 130], [640, 640]]) {
        const mine = frameMetrics(key, w, h);
        const theirs = F.outerSize(key, w, h);
        const dw = Math.abs(mine.w - theirs.w), dh = Math.abs(mine.h - theirs.h);
        if (Math.max(dw, dh) > worst) {
          worst = Math.max(dw, dh);
          worstMsg = `${key} ${w}x${h}: layout ${mine.w.toFixed(3)}x${mine.h.toFixed(3)} vs ` +
            `frames ${theirs.w.toFixed(3)}x${theirs.h.toFixed(3)}`;
        }
        // The inner media box must also land where the layout says it does, or the photo is
        // painted somewhere other than where the occlusion solver believed it was.
        if (typeof F.innerRect === "function") {
          const inner = F.innerRect(key, theirs.w, theirs.h);
          const dx = Math.abs(inner.x - -mine.dx), dy = Math.abs(inner.y - -mine.dy);
          if (Math.max(dx, dy) > worst) {
            worst = Math.max(dx, dy);
            worstMsg = `${key} ${w}x${h}: media inset layout ${(-mine.dx).toFixed(3)},` +
              `${(-mine.dy).toFixed(3)} vs frames ${inner.x.toFixed(3)},${inner.y.toFixed(3)}`;
          }
        }
      }
    }
    check(worst < 1e-6, "frameMetrics() and collage-frames.js agree to floating point",
      worst ? worstMsg : "5 aspect cases x 3 frames, outer box and media inset");

    if (typeof F.frameForHash === "function") {
      // Not an equality check — the layout deals from a bag and the registry rolls per item —
      // but the WEIGHTS must match or the two disagree about what a board looks like.
      const tally = { print: 0, polaroid: 0, bare: 0 };
      for (let i = 0; i < 30000; i++) tally[F.frameForHash(hash32("w" + i))]++;
      // `frame: "mixed"` EXPLICITLY. The default is now one uniform style for the whole board —
      // by design — so the dealer these three checks exist to test is the thing you
      // opt in to. Without naming it, they were asserting a mix against a board of polaroids.
      const lay = layoutCollage(makeMedia(600, { tag: "weights" }), { seed: "weights", frame: "mixed" });
      const mineTally = { print: 0, polaroid: 0, bare: 0 };
      for (const it of lay.items) mineTally[it.frame]++;
      let gap = 0;
      for (const k of FRAMES)
        gap = Math.max(gap, Math.abs(tally[k] / 30000 - mineTally[k] / lay.items.length));
      // Since layout version 2 every photo is bare, whatever `frame` asks: the dealer is gone from the layout.
      void gap;
      check(mineTally.bare === lay.items.length, "every photo is bare, even with frame: \"mixed\" asked (layout version 2)",
        JSON.stringify(mineTally));
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════
section("z-order, frames, video loops");
// ══════════════════════════════════════════════════════════════════════════════════════════
{
  const media = makeMedia(180, { tag: "mix" });
  // `frame: "mixed"` names the mode under test. The DEFAULT is one uniform style now, so a
  // board built without this option is correctly all polaroids and the three mix assertions
  // below would be measuring the wrong thing.
  const lay = layoutCollage(media, { seed: "mix", frame: "mixed" });

  let zOk = true;
  for (let i = 0; i < lay.items.length; i++) if (lay.items[i].z !== i) zOk = false;
  check(zOk, "z is 0..n-1, ascending, unique, and equals paint order");

  const lay2 = layoutCollage(media, { seed: "mix2", frame: "mixed" });
  check(lay2.items.every((it, i) => it.z === i && it.mediaId === lay.items[i].mediaId),
    "z-order is stable across seeds (only geometry re-rolls, not stacking)");

  const counts = {};
  for (const it of lay.items) counts[it.frame] = (counts[it.frame] || 0) + 1;
  check(Object.keys(counts).every((k) => FRAMES.includes(k)), "every frame key is registered",
    JSON.stringify(counts));
  check(Object.keys(counts).length === 1 && counts.bare === lay.items.length, "every photo on the board is bare (no polaroid, no print border)",
    JSON.stringify(counts));
  for (const f of ["polaroid", "print", "mixed"]) {
    const other = layoutCollage(media.slice(0, 24), { seed: "mix", frame: f });
    check(other.items.every((it) => it.frame === "bare"), `a stored style "${f}" reads as bare`, JSON.stringify([...new Set(other.items.map((it) => it.frame))]));
  }

  const norm = new Map(normaliseMedia(media).map((m) => [m.mediaId, m]));
  let panoPolaroid = null;
  for (const it of lay.items) {
    if (it.frame !== "polaroid") continue;
    const a = norm.get(it.mediaId).aspect;
    if (a >= 2.2 || a <= 1 / 2.2) panoPolaroid = `${it.id} aspect ${a.toFixed(2)}`;
  }
  check(!panoPolaroid, "no panorama or tower is put in a polaroid", panoPolaroid || "");

  // Video loop windows.
  let loopBad = null, photoBad = null, loops = 0;
  for (const it of lay.items) {
    if (it.kind === "video") {
      loops++;
      if (!(it.loopMs > 0)) loopBad = `${it.id} loopMs=${it.loopMs}`;
      if (it.durationMs >= 1200) {
        if (it.loopStartMs < 0) loopBad = `${it.id} negative start`;
        if (it.loopStartMs + it.loopMs > it.durationMs + 1)
          loopBad = `${it.id} window ${it.loopStartMs}+${it.loopMs} > duration ${it.durationMs}`;
        if (it.loopMs < DEFAULTS.loopMsMin - 1 || it.loopMs > DEFAULTS.loopMsMax + 1)
          loopBad = `${it.id} loopMs ${it.loopMs} outside [${DEFAULTS.loopMsMin}, ${DEFAULTS.loopMsMax}]`;
      }
    } else if (it.loopMs !== 0 || it.loopStartMs !== 0) photoBad = it.id;
  }
  check(loops > 0, "fixture contains videos", `${loops} of ${lay.items.length}`);
  check(!loopBad, "every video loop window sits inside its clip", loopBad || "");
  check(!photoBad, "photos carry loopStartMs = loopMs = 0", photoBad || "");
  const starts = lay.items.filter((i) => i.kind === "video" && i.durationMs > 8000).map((i) => i.loopStartMs);
  check(starts.length === 0 || starts.every((s) => s > 0),
    "loops on longer clips never start at frame 0 (the lens is still settling there)");

  // A clip shorter than the minimum loop, and a clip with no duration at all.
  const oddities = layoutCollage([
    { id: "tiny", kind: "video", key: "o/a/1/t.mov", width: 1920, height: 1080, duration_s: 0.6 },
    { id: "nodur", kind: "video", key: "o/a/2/n.mov", width: 1920, height: 1080, duration_s: 0 },
  ], { seed: "odd" });
  const tiny = oddities.items.find((i) => i.mediaId === "tiny");
  const nodur = oddities.items.find((i) => i.mediaId === "nodur");
  check(tiny.loopStartMs === 0 && tiny.loopMs === 600, "a 0.6s clip loops the whole clip",
    `${tiny.loopStartMs}..${tiny.loopStartMs + tiny.loopMs}`);
  check(nodur.loopStartMs === 0 && nodur.loopMs === DEFAULTS.loopMsUnknown,
    "a clip with no duration metadata gets the documented default window");
}

// ══════════════════════════════════════════════════════════════════════════════════════════
section("URLs and media normalisation");
// ══════════════════════════════════════════════════════════════════════════════════════════
{
  const lay = layoutCollage([
    { id: "a", key: "o/ab/cdef/12ab34cd.jpg", thumb_key: "t/9f/xyz/aa bb.webp", width: 4032, height: 3024 },
  ], { seed: "url" });
  const it = lay.items[0];
  check(it.thumbUrl === "/media/t/9f/xyz/aa%20bb.webp",
    "thumb URL matches memories-save.js mediaUrl(): per-segment encoding, slashes intact",
    it.thumbUrl);
  check(it.origUrl === "/media/o/ab/cdef/12ab34cd.jpg", "original URL likewise", it.origUrl);

  const injected = layoutCollage(
    [{ id: "a", key: "o/a/b/c.jpg", thumb_key: "t/a/b/c.webp", width: 100, height: 100 }],
    { seed: "url", mediaUrl: (k) => "/X/" + k },
  );
  check(injected.items[0].origUrl === "/X/o/a/b/c.jpg",
    "options.mediaUrl injects memories-save.js's builder so there is one spelling app-wide");

  // mediaFromMemories: chronological flatten, stable ties, sort respected.
  const memories = [
    { id: "m2", created_at: 200, media: [{ id: "b2", sort: 1, key: "k", width: 4, height: 3 }, { id: "b1", sort: 0, key: "k", width: 4, height: 3 }] },
    { id: "m1", created_at: 100, media: [{ id: "a1", sort: 0, key: "k", width: 4, height: 3 }] },
  ];
  const flat = mediaFromMemories(memories);
  check(flat.map((m) => m.id).join(",") === "a1,b1,b2",
    "mediaFromMemories() flattens oldest-first and honours media.sort", flat.map((m) => m.id).join(","));
  check(flat.every((m) => m.memoryId), "…and stamps memoryId on every media row");
  const feedOrder = mediaFromMemories(memories, { order: "given" });
  check(feedOrder.map((m) => m.id).join(",") === "b1,b2,a1", "order:'given' keeps the feed order");
  check(layoutCollage(flat, { seed: "s" }).items[0].id === "m1:a1",
    "LayoutItem.id is memoryId:mediaId");
}

// ══════════════════════════════════════════════════════════════════════════════════════════
section("spatial index, hit-testing, LOD policy");
// ══════════════════════════════════════════════════════════════════════════════════════════
{
  const lay = layoutCollage(makeMedia(220, { tag: "index" }), { seed: "index" });
  const ix = buildIndex(lay);
  const all = queryRect(ix, lay.bounds);
  check(all.length === lay.items.length, "queryRect over full bounds returns every item",
    `${all.length}/${lay.items.length}`);
  check(all.every((v, i) => i === 0 || v > all[i - 1]), "…in ascending z");

  // Cross-check against brute force on random viewports.
  const r = rngFrom("viewports");
  let mismatches = 0, totalVisible = 0, samples = 0;
  for (let t = 0; t < 60; t++) {
    const w = 300 + r() * 900, h = 300 + r() * 900;
    const x = lay.bounds.minX + r() * (lay.bounds.maxX - lay.bounds.minX);
    const y = lay.bounds.minY + r() * (lay.bounds.maxY - lay.bounds.minY);
    const rect = { minX: x, minY: y, maxX: x + w, maxY: y + h };
    const got = queryRect(ix, rect).join(",");
    const want = lay.items.map((it, i) => [itemAABB(it), i])
      .filter(([a]) => a.minX <= rect.maxX && rect.minX <= a.maxX && a.minY <= rect.maxY && rect.minY <= a.maxY)
      .map(([, i]) => i).join(",");
    if (got !== want) mismatches++;
    totalVisible += got ? got.split(",").length : 0;
    samples++;
  }
  check(mismatches === 0, "queryRect matches brute force on 60 random viewports",
    `mean ${(totalVisible / samples).toFixed(1)} items visible per viewport`);

  // Hit-testing: a point inside an item's frame returns the topmost item containing it.
  let hitBad = null, nullHits = 0;
  for (const it of lay.items) {
    const rr = outerRect(it);
    const px = rr.x + rr.w / 2, py = rr.y + rr.h / 2;
    const hit = pickTopAt(lay, px, py, ix);
    if (!hit) { nullHits++; continue; }
    // whatever it returned must actually contain the point, and be the highest z that does
    const containing = lay.items.filter((c) => {
      const cr = outerRect(c);
      const a = c.rot * DEG, cos = Math.cos(a), sin = Math.sin(a);
      const dx = px - (cr.x + cr.w / 2), dy = py - (cr.y + cr.h / 2);
      const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
      return Math.abs(lx) <= cr.w / 2 && Math.abs(ly) <= cr.h / 2;
    });
    const top = containing[containing.length - 1];
    if (hit.id !== top.id) hitBad = `${it.id}: got ${hit.id}, want ${top.id}`;
  }
  check(nullHits === 0, "every item's own centre hits something");
  check(!hitBad, "pickTopAt returns the TOPMOST item under the point", hitBad || "");
  const far = pickTopAt(lay, lay.bounds.minX - 5000, lay.bounds.minY - 5000, ix);
  check(far === null, "a point off the board hits nothing");

  // LOD: the whole policy, since there is no mid tier to get wrong.
  const it0 = lay.items[0];
  const longEdge = Math.max(it0.w, it0.h);
  const zc = originalZoomFor(it0, 3);
  check(!shouldUseOriginal(it0, zc * 0.98, 3) && shouldUseOriginal(it0, zc * 1.02, 3),
    "shouldUseOriginal flips exactly at originalZoomFor()", `crossover zoom ${zc.toFixed(3)} at dpr 3`);
  checkClose(longEdge * zc * 3, THUMB_LONG_EDGE_PX * SOFTEN_FACTOR, 1e-6,
    "…and that crossover is thumb long edge x soften factor in DEVICE pixels");
  check(!shouldUseOriginal(it0, 0.25, 3) && !shouldUseOriginal(it0, 0.5, 2),
    "at a fit-the-board zoom nothing asks for a 4K original");
  const fitZoom = 390 / (lay.bounds.maxX - lay.bounds.minX);
  const wantOrig = lay.items.filter((i) => shouldUseOriginal(i, fitZoom, 3)).length;
  check(wantOrig === 0, "at fit-to-screen zoom on a 390px phone at dpr 3, zero originals",
    `fit zoom ${fitZoom.toFixed(4)}`);
  const zoomedIn = lay.items.filter((i) => shouldUseOriginal(i, 1.0, 3)).length;
  check(zoomedIn === lay.items.length, "zoomed to 1:1 canvas units every item wants its original",
    `${zoomedIn}/${lay.items.length}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════
section("the board on its wall (boardOf)");
// ══════════════════════════════════════════════════════════════════════════════════════════
{
  // The board holds every photo (its rotated box; its fastener and lift shadow sit inside the margin) with the
  // margin all round, at 16, 40 and 200; its size is on the ladder, as tall as its shape; the band of wall surrounds it.
  for (const n of [16, 40, 200]) {
    const lay = layoutCollage(makeMedia(n, { tag: "board" + n }), { seed: "board" + n });
    const b = boardOf(lay.bounds, lay.stats.targetWidth, lay.stats.boardTall);
    const m = Math.max(BOARD.margin, BOARD.marginFrac * lay.stats.targetWidth);
    let worst = Infinity;
    for (const it of lay.items) {
      const a = itemAABB(it);
      worst = Math.min(worst, a.minX - b.x, a.minY - b.y, b.x + b.w - a.maxX, b.y + b.h - a.maxY);
    }
    check(worst >= m - 0.05, `${n} photos: the board holds every photo with its margin (${m.toFixed(1)} units) all round`, `closest ${worst.toFixed(2)}`);
    const onLadder = (v, min) => { const k = Math.log(v / min) / Math.log(BOARD.step); return Math.abs(v - min) < 0.02 || Math.abs(k - Math.round(k)) < 1e-3; };
    check(onLadder(b.w, BOARD.minW) && onLadder(b.h, BOARD.minH) && b.h >= b.w * BOARD.manyTall - 0.05, `${n} photos: the board's size is on its ladder, at least 3:4 tall`, `${b.w} x ${b.h}`);
    const band = BOARD.wallFrac * Math.min(b.w, b.h);
    check(Math.abs(b.wall.x - (b.x - band)) < 0.02 && Math.abs(b.wall.w - (b.w + 2 * band)) < 0.03, `${n} photos: a band of wall surrounds it`);
  }
  const e = boardOf(null, 0, boardTall(0));
  check(e.w === BOARD.minW && e.h === BOARD.minH, "no photos: the smallest board, never a speck", `${e.w} x ${e.h}`);

  // THE SHAPE GROWS WITH THE COUNT: a landscape 4:3 board for a few photos, the 3:4 portrait from BOARD.manyN, never
  // falling in between; and each small board is as tall as its shape asks.
  const talls = Array.from({ length: 30 }, (_, n) => boardTall(n));
  check(talls[0] === 0.75 && talls[3] === 0.75 && talls[12] === 1.3333 && talls[29] === 1.3333 && talls.every((t, i) => !i || t >= talls[i - 1]),
    "the board's shape: 4:3 landscape up to 3 photos, 3:4 portrait from 12, never falling", talls.slice(0, 14).join(" "));
  {
    let bad = "";
    for (const n of [1, 2, 3, 5, 8, 12]) {
      const lay = layoutCollage(makeMedia(n, { tag: "shape" + n }), { seed: "shape" + n });
      const b = boardOf(lay.bounds, lay.stats.targetWidth, lay.stats.boardTall);
      if (lay.stats.boardTall !== boardTall(n) || b.h < b.w * boardTall(n) - 0.05 || b.h > b.w * boardTall(n) * BOARD.step + 0.05) bad += ` ${n}: ${b.w}x${b.h} (${lay.stats.boardTall})`;
    }
    check(!bad, "1, 2, 3, 5, 8, 12 photos: each board has its count's shape, within a ladder step", bad);
  }

  // THE FIT AND THE DRAWN BOARD ARE ONE SIZE. The pile is fitted to fitRoom(target): the room of the board drawn
  // from the ROUNDED target width (stats.targetWidth). Fitted to the unrounded one, a target a hair above a ladder
  // rung put the room a rung above the drawn board's, and the pile overran the drawn margin. For each rung, the
  // targets just above where it is crossed whose rounding falls below it.
  {
    const qz2 = (v) => Math.round(v * 100) / 100;
    const need = (tw) => tw + 2 * Math.max(BOARD.margin, BOARD.marginFrac * tw);
    const cases = [], wrong = [];
    for (let k = 1; k < 40; k++) {
      const r = BOARD.minW * Math.pow(BOARD.step, k);
      let lo = 0, hi = r;
      for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (need(mid) > r) hi = mid; else lo = mid; }
      for (const d of [0.0005, 0.001, 0.002, 0.003, 0.004]) {
        const tw = hi + d;
        if (!(need(tw) > r && need(qz2(tw)) <= r)) continue;
        cases.push(k);
        for (const tall of [boardTall(1), boardTall(12)]) {
          const room = L.fitRoom(tw, tall), b = boardOf({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, qz2(tw), tall);
          const m = Math.max(BOARD.margin, BOARD.marginFrac * qz2(tw));
          if (Math.abs(room.w - (b.w - 2 * m)) > 0.02 || Math.abs(room.h - (b.h - 2 * m)) > 0.02) wrong.push(`rung ${k} +${d}: fit room ${room.w.toFixed(1)}, drawn ${(b.w - 2 * m).toFixed(1)}`);
        }
      }
    }
    check(cases.length >= 10 && wrong.length === 0, "a target a hair above a ladder rung: the room the pile is fitted to is the drawn board's",
      wrong.slice(0, 3).join("; ") || `${cases.length} targets over rungs ${[...new Set(cases)].join(",")}`);
  }

  // THE BOARD ONLY GROWS: adding photos to a board never makes it smaller. Over growing sets of
  // every fixture shape, one photo added never makes the board narrower or shorter. Control: the first rule (the
  // board sized from the photos' own extent) does shrink on the same sets.
  const extentRule = (lay) => { const bb = lay.bounds, cw = bb.maxX - bb.minX, ch = bb.maxY - bb.minY;
    const m = Math.max(BOARD.margin, BOARD.marginFrac * Math.min(cw, ch));
    const lad = (need, min) => need <= min ? min : min * Math.pow(BOARD.step, Math.ceil(Math.log(need / min) / Math.log(BOARD.step) - 1e-9));
    return { w: lad(cw + 2 * m, BOARD.minW), h: lad(ch + 2 * m, BOARD.minH) }; };
  const shrinks = [], controlShrinks = [];
  let inside = true;
  for (const tag of ["grow", "grow2", "grow3"]) {
    const all = makeMedia(120, { tag });
    let prev = boardOf(null, 0, boardTall(0)), prevC = null;
    for (let n = 1; n <= 120; n++) {
      const lay = layoutCollage(all.slice(0, n), { seed: tag });
      const b = boardOf(lay.bounds, lay.stats.targetWidth, lay.stats.boardTall), c = extentRule(lay);
      if (prev && (b.w < prev.w - 0.01 || b.h < prev.h - 0.01)) shrinks.push(`${tag} ${n - 1}->${n}: ${Math.round(prev.w)}x${Math.round(prev.h)} -> ${Math.round(b.w)}x${Math.round(b.h)}`);
      if (prevC && (c.w < prevC.w - 0.01 || c.h < prevC.h - 0.01)) controlShrinks.push(`${tag} ${n - 1}->${n}`);
      for (const it of lay.items) { const a = itemAABB(it); if (a.minX < b.x - 0.05 || a.minY < b.y - 0.05 || a.maxX > b.x + b.w + 0.05 || a.maxY > b.y + b.h + 0.05) inside = false; }
      prev = b; prevC = c;
    }
  }
  check(shrinks.length === 0, "one photo added never makes the board narrower or shorter, from the empty board (3 growing sets of 120)", shrinks.slice(0, 4).join("; ") || "never");
  check(inside, "…and the board holds every photo of every one of those 360 layouts");
  check(controlShrinks.length > 0, "control: the first rule (the board sized from the photos' extent) does shrink on the same sets", `${controlShrinks.length} times, e.g. ${controlShrinks.slice(0, 3).join(", ")}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════
section("PRNG");
// ══════════════════════════════════════════════════════════════════════════════════════════
{
  const a = rngFrom("seed-a"), b = rngFrom("seed-a"), c = rngFrom("seed-b");
  const sa = Array.from({ length: 200 }, a);
  const sb = Array.from({ length: 200 }, b);
  const sc = Array.from({ length: 200 }, c);
  check(sa.join() === sb.join(), "rngFrom is reproducible for one seed");
  check(sa.join() !== sc.join(), "…and decorrelates near-identical seeds");
  check(sa.every((v) => v >= 0 && v < 1), "…and stays in [0, 1)");
  const mean = sa.reduce((s, v) => s + v, 0) / sa.length;
  check(Math.abs(mean - 0.5) < 0.06, "…with a plausible mean", `mean ${mean.toFixed(4)}`);
  // Cheap bucket uniformity over a long run.
  const N = 200000, buckets = new Array(10).fill(0);
  const g = rngFrom("uniformity");
  for (let i = 0; i < N; i++) buckets[Math.floor(g() * 10)]++;
  const worst = Math.max(...buckets.map((v) => Math.abs(v / N - 0.1)));
  check(worst < 0.004, "…and uniform to <0.4% across 10 buckets over 200k draws",
    `worst deviation ${(worst * 100).toFixed(3)}%`);
  check(hash32("a") !== hash32("b") && hash32("a") === hash32("a") && hash32("a") >= 0,
    "hash32 is stable and discriminating");
  check(typeof makeSeed() === "string" && makeSeed() !== makeSeed(), "makeSeed mints fresh seeds");
  check(makeSeed("kept") === "kept", "makeSeed passes an existing seed straight through");
}

// ══════════════════════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(78));
if (failures.length) {
  console.log(`FAILED — ${passed} passed, ${failures.length} failed\n`);
  for (const f of failures) console.log("  * " + f);
  console.log("");
  process.exit(1);
}
console.log(`OK — ${passed} assertions passed`);
process.exit(0);

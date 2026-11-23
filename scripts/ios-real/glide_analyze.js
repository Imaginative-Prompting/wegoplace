/* Read every extracted frame of the REAL iOS Safari day-strip during a REAL touch scroll.
 * Question: on the frames the ring is in flight, is the destination date VISIBLE?
 * "Visible" = dark glyph pixels inside the ring's own box, not hit-testability. */
const fs = require("fs");
const path = require("path");
const { decodePNG, asciiCrop } = require("./png.js");

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter(f => f.endsWith(".png")).sort();

function analyze(png) {
  const { w, h, bpp, data } = png;
  // Background median luminance of the band (the paper/ink-bg).
  const lums = [];
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
    const j = (y * w + x) * bpp;
    lums.push(0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]);
  }
  lums.sort((a, b) => a - b);
  const bg = lums[lums.length >> 1];

  // Per-column glyph ink (pixels far from bg) and per-column accent-blue count.
  const ink = new Int32Array(w);
  const blue = new Int32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const j = (y * w + x) * bpp;
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (Math.abs(l - bg) > 40) ink[x]++;
    if (b - r > 28 && b > 90 && g >= r) blue[x]++;
  }
  // The ring is a 1px outline: two tall-ish blue columns (its left and right sides).
  let first = -1, last = -1, blueTot = 0;
  for (let x = 0; x < w; x++) { blueTot += blue[x]; if (blue[x] >= 6) { if (first < 0) first = x; last = x; } }
  return { bg: +bg.toFixed(1), ink, blue, ringL: first, ringR: last, blueTot,
    totInk: ink.reduce((a, b) => a + b, 0) };
}

const rows = [];
for (let i = 0; i < files.length; i++) {
  const png = decodePNG(fs.readFileSync(path.join(dir, files[i])));
  const a = analyze(png);
  let inRing = 0;
  if (a.ringL >= 0 && a.ringR > a.ringL + 8) {
    // ink strictly INSIDE the outline (skip the 3px of border on each side)
    for (let x = a.ringL + 3; x <= a.ringR - 3; x++) inRing += a.ink[x];
  }
  rows.push({ f: files[i], i, ringL: a.ringL, ringR: a.ringR, w: a.ringR - a.ringL, inRing, totInk: a.totInk, bg: a.bg, png });
}

// Ring motion => flight. A frame is "in flight" if ringL differs from the previous frame.
let moving = [];
for (let i = 1; i < rows.length; i++) if (Math.abs(rows[i].ringL - rows[i - 1].ringL) > 1) moving.push(i);

console.log("frames:", rows.length);
console.log("ring x positions seen:", [...new Set(rows.map(r => r.ringL))].filter(v => v >= 0).sort((a, b) => a - b).join(","));
console.log("frames where the ring MOVED:", moving.length, moving.length ? `(indices ${moving[0]}..${moving[moving.length - 1]})` : "");

// Group into flights (runs of movement with <=6 frame gaps)
const flights = [];
for (const i of moving) {
  const last = flights[flights.length - 1];
  if (last && i - last[last.length - 1] <= 6) last.push(i); else flights.push([i]);
}
console.log("distinct glides:", flights.length);

for (let k = 0; k < flights.length; k++) {
  const fl = flights[k];
  const a = Math.max(0, fl[0] - 2), b = Math.min(rows.length - 1, fl[fl.length - 1] + 2);
  const seg = rows.slice(a, b + 1);
  const restBefore = rows[Math.max(0, a - 4)];
  const restAfter = rows[Math.min(rows.length - 1, b + 8)];
  console.log(`\n=== GLIDE ${k + 1}: frames ${a}..${b} (${b - a + 1} frames, ${((b - a + 1) / 120 * 1000).toFixed(0)}ms) ===`);
  console.log("  at rest BEFORE: ringL", restBefore.ringL, "inRing ink", restBefore.inRing);
  console.log("  at rest AFTER : ringL", restAfter.ringL, "inRing ink", restAfter.inRing);
  console.log("  in flight:");
  for (const r of seg) console.log(`    f${String(r.i).padStart(4)} ringL=${String(r.ringL).padStart(4)} w=${String(r.w).padStart(3)} inkInsideRing=${String(r.inRing).padStart(5)} totalStripInk=${r.totInk}`);
  const flightInk = seg.filter(r => r.inRing > 0).map(r => r.inRing);
  const worst = Math.min(...flightInk);
  const rest = Math.max(restBefore.inRing, restAfter.inRing);
  console.log(`  WORST in-flight ink inside the ring: ${worst}   AT REST: ${rest}   RATIO ${(worst / rest).toFixed(3)}`);
  const worstRow = seg.find(r => r.inRing === worst);
  console.log(`  --- ASCII luminance of the ring's box on the WORST frame (f${worstRow.i}) ---`);
  console.log(asciiCrop(worstRow.png, worstRow.ringL - 4, 0, worstRow.w + 8, worstRow.png.h, 56));
  const restRow = restAfter;
  console.log(`  --- same box AT REST (f${restRow.i}) ---`);
  console.log(asciiCrop(restRow.png, restRow.ringL - 4, 0, restRow.w + 8, restRow.png.h, 56));
}

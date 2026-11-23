/* DID THE PAGE BEHIND THE SHEET MOVE, IN PIXELS?
 * For each captured frame of the region above the sheet, find the vertical shift that best
 * aligns it with a reference frame. A page that stands still scores 0 on every frame; a page
 * that is pushed up by the keyboard scores the push. This asks the compositor, not the DOM —
 * the DOM can report an intermediate value that was never painted. */
const fs = require("fs");
const path = require("path");
const { decodePNG } = require("./png.js");

const dir = process.argv[2];
const refIdx = +(process.argv[3] || 0);
const MAXSHIFT = +(process.argv[4] || 420);
const files = fs.readdirSync(dir).filter(f => f.endsWith(".png")).sort();

function rowProfile(png) {
  const { w, h, bpp, data } = png;
  const p = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x += 2) {
      const j = (y * w + x) * bpp;
      s += 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2];
    }
    p[y] = s / (w / 2);
  }
  return p;
}
function bestShift(ref, cur) {
  const h = ref.length;
  let best = 0, bestErr = Infinity;
  for (let s = -MAXSHIFT; s <= MAXSHIFT; s += 2) {
    let err = 0, n = 0;
    for (let y = Math.max(0, -s); y < Math.min(h, h - s); y += 2) {
      const d = ref[y] - cur[y + s]; err += d * d; n++;
    }
    if (n < h / 6) continue;
    err /= n;
    if (err < bestErr) { bestErr = err; best = s; }
  }
  return { shift: best, err: Math.round(bestErr) };
}

const profs = files.map(f => rowProfile(decodePNG(fs.readFileSync(path.join(dir, f)))));
const ref = profs[refIdx];
const out = profs.map((p, i) => ({ i, ...bestShift(ref, p) }));
// A frame whose best alignment error is high is a DIFFERENT picture (sheet covering it), not
// a shifted one; report both so nothing is hidden.
console.log("frame  shift  err");
let moved = [];
for (const r of out) {
  if (r.shift !== 0) moved.push(r);
}
const step = Math.max(1, Math.floor(out.length / 60));
for (const r of out) if (r.i % step === 0 || r.shift !== 0) console.log(String(r.i).padStart(5), String(r.shift).padStart(6), String(r.err).padStart(6));
console.log("\nframes with a NON-ZERO vertical shift of the page behind:", moved.length, "of", out.length);
if (moved.length) console.log("  " + moved.map(m => `f${m.i}:${m.shift}px(err ${m.err})`).join("  "));

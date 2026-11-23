// collage_layout_preview.mjs — render a Layout to a PNG so a human can look at the geometry.
//
//   node scripts/collage_layout_preview.mjs [count] [seed] [out.png]
//
// This is a DIAGNOSTIC for the layout engine, not a renderer. It draws the data
// public/js/collage-layout.js produces — frame boxes, photo boxes, focal discs — with no
// media, no styling and no relationship to what collage.js will paint. Its job is to answer
// the one question the unit test cannot: does this read as prints tossed on a board, or as a
// contact sheet with the corners knocked off.
//
// No dependencies. PNG is encoded here with node's own zlib, because the alternative is
// installing something to look at a rectangle.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const { layoutCollage, outerRect, rngFrom, validateLayout } =
  await import("file://" + resolve(HERE, "../public/js/collage-layout.js"));

const COUNT = Number(process.argv[2] || 120);
const SEED = process.argv[3] || "preview";
const OUT = process.argv[4] || resolve(HERE, `../build/collage-layout/collage-layout-${COUNT}.png`);
const WIDTH = 1400;

// ── fixture media, same shapes as the unit test ───────────────────────────────────────────
const SHAPES = [
  [4032, 3024], [3024, 4032], [1920, 1080], [1080, 1920],
  [4032, 3024], [3024, 4032], [2048, 2048], [5000, 1400], [1440, 2560], [3840, 2160],
];
const r = rngFrom("preview:" + SEED + ":" + COUNT);
const media = Array.from({ length: COUNT }, (_, i) => {
  const s = SHAPES[Math.floor(r() * SHAPES.length)];
  const video = r() < 0.18;
  return {
    id: `md_${i}`, memoryId: `mem_${Math.floor(i / 3)}`,
    kind: video ? "video" : "photo",
    key: `o/a/${i}/x.${video ? "mov" : "jpg"}`, thumb_key: `t/a/${i}/x.webp`,
    width: s[0], height: s[1], duration_s: video ? 4 + r() * 30 : 0, sort: i,
  };
});

const lay = layoutCollage(media, { seed: SEED });
const v = validateLayout(lay, { samples: 48 });

// ── tiny raster ───────────────────────────────────────────────────────────────────────────
// Greys and a tan ground only. Luminance carries every distinction here, never hue —
// a diagnostic that needs colour vision to read is a useless diagnostic.
const bw = lay.bounds.maxX - lay.bounds.minX;
const bh = lay.bounds.maxY - lay.bounds.minY;
const PAD = 24;
const scale = (WIDTH - PAD * 2) / bw;
const W = WIDTH;
const H = Math.round(bh * scale + PAD * 2);
const buf = new Uint8Array(W * H * 3);
const GROUND = [188, 170, 140];
for (let i = 0; i < W * H; i++) { buf[i * 3] = GROUND[0]; buf[i * 3 + 1] = GROUND[1]; buf[i * 3 + 2] = GROUND[2]; }

const px = (x) => (x - lay.bounds.minX) * scale + PAD;
const py = (y) => (y - lay.bounds.minY) * scale + PAD;

function fillQuad(q, rgb, alpha = 1) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of q) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(H - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (let i = 0; i < q.length; i++) {
      const a = q[i], b = q[(i + 1) % q.length];
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc))
        xs.push(a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    if (xs.length < 2) continue;
    xs.sort((p, n) => p - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5)), x1 = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = x0; x <= x1; x++) {
        const o = (y * W + x) * 3;
        for (let c = 0; c < 3; c++) buf[o + c] = Math.round(buf[o + c] * (1 - alpha) + rgb[c] * alpha);
      }
    }
  }
}

function strokeQuad(q, rgb) {
  for (let i = 0; i < q.length; i++) line(q[i], q[(i + 1) % q.length], rgb);
}
function line(a, b, rgb) {
  const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) + 1;
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(a[0] + (b[0] - a[0]) * s / steps);
    const y = Math.round(a[1] + (b[1] - a[1]) * s / steps);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const o = (y * W + x) * 3;
    buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2];
  }
}
function disc(cx, cy, rad, rgb) {
  for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(H - 1, Math.ceil(cy + rad)); y++)
    for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(W - 1, Math.ceil(cx + rad)); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > rad * rad) continue;
      const o = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) buf[o + c] = Math.round(buf[o + c] * 0.45 + rgb[c] * 0.55);
    }
}

const rotQuad = (rect, rot) => {
  const a = rot * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  const cx = px(rect.x + rect.w / 2), cy = py(rect.y + rect.h / 2);
  const hw = rect.w * scale / 2, hh = rect.h * scale / 2;
  return [
    [cx - hw * cos + hh * sin, cy - hw * sin - hh * cos],
    [cx + hw * cos + hh * sin, cy + hw * sin - hh * cos],
    [cx + hw * cos - hh * sin, cy + hw * sin + hh * cos],
    [cx - hw * cos - hh * sin, cy - hw * sin + hh * cos],
  ];
};

for (const it of lay.items) {
  const fq = rotQuad(outerRect(it), it.rot);
  fillQuad(fq, [252, 250, 246]);                       // the frame's paper
  strokeQuad(fq, [120, 112, 102]);
  const pq = rotQuad({ x: it.x, y: it.y, w: it.w, h: it.h }, it.rot);
  fillQuad(pq, it.kind === "video" ? [64, 66, 70] : [150, 154, 160]);   // luminance, not hue
  strokeQuad(pq, [40, 40, 42]);
  const a = it.rot * Math.PI / 180;
  const pcx = px(it.x + it.w / 2), pcy = py(it.y + it.h / 2);
  const ocx = px(outerRect(it).x + outerRect(it).w / 2), ocy = py(outerRect(it).y + outerRect(it).h / 2);
  const rx = pcx - ocx, ry = pcy - ocy;
  disc(ocx + rx * Math.cos(a) - ry * Math.sin(a), ocy + rx * Math.sin(a) + ry * Math.cos(a),
    0.17 * Math.min(it.w, it.h) * scale, it.kind === "video" ? [235, 235, 235] : [30, 30, 30]);
}

// ── PNG ───────────────────────────────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  Buffer.from(buf.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
]));

console.log(`${OUT}
  ${lay.items.length} items, seed "${lay.seed}", background ${lay.background}
  board ${bw.toFixed(0)} x ${bh.toFixed(0)} canvas units -> ${W} x ${H} px
  frames ${JSON.stringify(lay.items.reduce((a, i) => (a[i.frame] = (a[i.frame] || 0) + 1, a), {}))}
  overlapped ${v.overlapping}/${v.count}, mean coverage ${(v.meanCoverage * 100).toFixed(1)}%, ` +
  `max ${(v.maxCoverage * 100).toFixed(1)}%, focal covered ${v.focalCovered.length}
  solver ${lay.stats.iterations} iterations, converged ${lay.stats.converged}`);

// collage-frames.js — the LOOK of the collage: frame registry + background (ground) registry.
//
// This file owns nothing about placement and nothing about the camera. It answers exactly two
// questions, for exactly two consumers:
//
//   1. "What does a framed print look like?"  — FRAMES, for the DOM renderer (collage.js) and
//      the export renderer (collage-export.js). Both consume the SAME numbers, so the exported
//      image cannot drift from the screen.
//   2. "What surface is it lying on?"          — GROUNDS, generated at runtime (seeded canvas
//      texture, never a shipped asset — this app precaches every byte, and a texture photo
//      would cost real trailhead wifi).
//
// ── THE FRAME CONTRACT (renderers code against this) ─────────────────────────────────────────
//
//   FRAMES[key] = {
//     key        'polaroid' | 'print' | 'bare'   (a fourth frame = one more entry here + one
//                                                 CSS block in collage.css; nothing else moves)
//     className  the class the DOM renderer puts on the item element, e.g. 'cg-f-polaroid'.
//                Renderers must take it from here, never hardcode it.
//     pads       {top,right,bottom,left} — paper border, as FRACTIONS OF THE ITEM'S OUTER
//                WIDTH. Width-relative on every side so borders are uniform at any aspect,
//                and so CSS (calc(var(--cg-w) * f)) and canvas (f * w) compute the same box.
//     radius     outer corner radius, canvas units (CSS px at zoom 1)
//     paper      does it draw a paper body (false for 'bare' — shadow only)
//     caption    has a caption slot (polaroid foot). The slot's box is the bottom pad.
//   }
//
//   DOM structure the CSS is written for (built by the renderer, styled by collage.css):
//     <div class="cg-item {className}" style="left;top;width;height;z-index;
//                                             --cg-w:<width>px; transform:rotate(<rot>deg)">
//       <div class="cg-media" [data-miss="1"]>            clipped media box (the photo area)
//         <img|video ...>                                  fills it, object-fit:cover
//         <span class="cg-play">{play icon}</span>         video affordance (shape, --on-shot)
//         <span class="cg-missmark">{miss icon}</span>     offline dashed-tray glyph
//       </div>
//       <div class="cg-cap">…</div>                        polaroid only, sits in the foot
//     </div>
//   `--cg-w` MUST mirror style.width; the frame CSS derives its borders from it (CSS percent
//   padding resolves against the containing block, so it cannot express "fraction of my own
//   width" — the custom property is the contract). Omitting it degrades to a zero border.
//
//   Geometry helpers (pure, DOM-free, unit-testable in bare node):
//     innerRect(key, w, h)          -> {x,y,w,h}  media box inside an outer box
//     outerSize(key, mw, mh)        -> {w,h}      outer box wrapping a media box
//     outerHeight(key, w, aspect)   -> h          for the layout pass: outer height of an item
//                                                 of outer width w framing media of `aspect`
//     frameForHash(u32)             -> key        deterministic weighted pick (layout may use
//                                                 it or roll its own; weights documented below)
//
//   Canvas twins (for collage-export.js; caller owns ctx.translate/rotate for the item):
//     drawFrame(ctx, key, w, h, {theme, scale, caption}) -> {x,y,w,h}
//         paints shadow + paper + inner keyline (+ caption) at (0,0,w,h) and returns the media
//         rect the caller draws the photo into. `scale` = export pixel ratio; canvas shadows
//         ignore the CTM, so it is applied to the shadow numbers explicitly.
//
// ── THE GROUND CONTRACT ──────────────────────────────────────────────────────────────────────
//
//   GROUNDS[key] = { key, className, base:{light,dark} }   keys: 'corkboard' | 'paper' | 'linen'
//     applyGround(el, key, theme?)   set the ground on the VIEWPORT element (never the camera
//                                    layer — the texture stays fixed while prints move over it;
//                                    zooming a noise texture is invisible and re-rastering a
//                                    world-sized ground is not). Re-call it after a theme
//                                    change; tiles are cached per (key, theme) so it is cheap.
//     paintGround(ctx, key, x,y,w,h, theme, scale?)   the export twin.
//     groundTile(key, theme)         the raw tile canvas (256 CSS px, drawn at 2x), cached.
//     resolveTheme()                 'light' | 'dark' from data-theme, else the media query.
//
//   Textures are generated from a FIXED seed through mulberry32 — same board every launch.
//   Math.random() does not appear in this file; a surface that re-speckles on re-render is
//   the same bug as a layout that reshuffles.
//
// ── Rules held here ──────────────────────────────────────────────────────────────────────────
//   - Photos win. Ground contrast stays inside a few % of luminance; frames are quiet paper.
//   - Both themes are designed, not inverted: paper dims like a print under lamp light in
//     dark theme, it does not go grey-on-grey. Tokens live in collage.css (three-state).
//   - Nothing here signals by hue: offline is the dashed tray SHAPE, video is
//     the play-disc SHAPE, both styled in collage.css with the --on-shot family.
//   - Cheap to composite: two-layer small-blur box-shadow, no filter(), no backdrop-filter.
//     Measured under 4x CPU throttle with 220 framed items.

// THE ONE SHARED IMPORT. collage-layout.js is a leaf module and is the single declaration
// of what a ground IS; this file supplies only the canvas textures for them.
import { GROUNDS as GROUND_SPEC } from "./collage-layout.js";

"use strict";

/* ── frames ─────────────────────────────────────────────────────────────────────────── */

export const FRAMES = {
  // Thick instant-film border, heavier at the foot (the classic ~6% sides / ~18% foot read),
  // with the foot doubling as the caption slot.
  polaroid: {
    key: "polaroid",
    className: "cg-f-polaroid",
    pads: { top: 0.06, right: 0.06, bottom: 0.18, left: 0.06 },
    radius: 2,
    paper: true,
    caption: true,
  },
  // A classic photo print: thin even white border.
  print: {
    key: "print",
    className: "cg-f-print",
    pads: { top: 0.03, right: 0.03, bottom: 0.03, left: 0.03 },
    radius: 1.5,
    paper: true,
    caption: false,
  },
  // No border at all — the photograph itself lying on the surface, shadow only.
  bare: {
    key: "bare",
    className: "cg-f-bare",
    pads: { top: 0, right: 0, bottom: 0, left: 0 },
    radius: 2,
    paper: false,
    caption: false,
  },
};

export const FRAME_KEYS = Object.keys(FRAMES);

/** Media box inside an outer box of (w,h). Pure; safe in bare node. */
export function innerRect(key, w, h) {
  const p = FRAMES[key].pads;
  const x = w * p.left;
  const y = w * p.top;
  return { x, y, w: w - w * (p.left + p.right), h: h - w * (p.top + p.bottom) };
}

/** Outer box wrapping a media box of (mw,mh). */
export function outerSize(key, mw, mh) {
  const p = FRAMES[key].pads;
  const w = mw / (1 - p.left - p.right);
  return { w, h: mh + w * (p.top + p.bottom) };
}

/** For the layout pass: outer height of an item of outer width `w` framing media of `aspect`
    (aspect = media w/h). */
export function outerHeight(key, w, aspect) {
  const p = FRAMES[key].pads;
  const mw = w * (1 - p.left - p.right);
  return mw / aspect + w * (p.top + p.bottom);
}

/** Deterministic weighted frame pick from any 32-bit hash the layout derives from its seed.
    Weights: print 45 / polaroid 35 / bare 20 — prints carry the board, polaroids accent it,
    bare keeps it from looking like a stationery catalogue. */
export function frameForHash(u32) {
  const r = (u32 >>> 0) % 100;
  return r < 45 ? "print" : r < 80 ? "polaroid" : "bare";
}

/* Shadow, stated once for both renderers. Two layers: a tight contact shadow that glues the
   print to the surface, and a soft offset drop that gives it thickness. Blurs are kept small
   on purpose — big-radius shadows are what makes a 220-item board expensive to rasterise.
   collage.css --cg-shadow is these same numbers; change them together. */
export const FRAME_SHADOW = {
  light: { rgb: "31,25,14", passes: [ { y: 1, blur: 2, a: 0.30 }, { y: 7, blur: 16, a: 0.22 } ] },
  dark:  { rgb: "0,0,0",    passes: [ { y: 1, blur: 2, a: 0.60 }, { y: 8, blur: 18, a: 0.50 } ] },
};

/* Paper + caption ink, per theme — the canvas twins of collage.css's tokens. A print is a
   physical object: in dark theme it dims like paper under lamp light rather than inverting. */
export const PAPER = {
  light: { paper: "#fdfaf3", ink: "#4b4332", keyline: "rgba(20,16,10,.10)" },
  dark:  { paper: "#ded6c6", ink: "#3a3428", keyline: "rgba(0,0,0,.26)" },
};

function pathRoundRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Export twin of the frame CSS. Caller has already translate()d to the item's top-left and
 * rotate()d around its centre; this paints shadow + paper (+ caption) at (0,0,w,h) in canvas
 * units and returns the media rect to draw the photo into. For 'bare' it paints the shadow
 * under a placeholder the photo will exactly cover.
 * opts: { theme:'light'|'dark' (required), scale:1 (export pixel ratio — canvas shadows ignore
 *         the CTM so offsets/blurs are multiplied by it here), caption:'' }
 */
export function drawFrame(ctx, key, w, h, opts) {
  const f = FRAMES[key];
  const theme = opts.theme === "dark" ? "dark" : "light";
  const scale = opts.scale || 1;
  const sh = FRAME_SHADOW[theme];
  const pal = PAPER[theme];
  const body = f.paper ? pal.paper : "#888880"; // bare: covered by the photo, only the shadow shows

  ctx.save();
  for (const p of sh.passes) {
    ctx.shadowColor = `rgba(${sh.rgb},${p.a})`;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = p.y * scale;
    ctx.shadowBlur = p.blur * scale;
    ctx.fillStyle = body;
    pathRoundRect(ctx, 0, 0, w, h, f.radius);
    ctx.fill();
  }
  ctx.restore();

  const r = innerRect(key, w, h);
  if (f.paper) {
    // Emulsion keyline where photo meets paper — the same inset 1px collage.css draws.
    ctx.save();
    ctx.strokeStyle = pal.keyline;
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    ctx.restore();
  }
  if (f.caption && opts.caption) {
    const foot = w * f.pads.bottom;
    ctx.save();
    ctx.fillStyle = pal.ink;
    ctx.font = `600 ${Math.max(12, Math.round(foot * 0.34))}px 'Bricolage Grotesque','Bricolage Grotesque Fallback',system-ui,sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const maxW = w * (1 - f.pads.left - f.pads.right);
    ctx.fillText(String(opts.caption), w / 2, h - foot / 2, maxW);
    ctx.restore();
  }
  return r;
}

/* ── grounds ────────────────────────────────────────────────────────────────────────── */

// DERIVED, NOT DECLARED. These colours used to be written out here and they had drifted from
// the screen's copy on every single ground — corkboard was #c2a173 here and #c9a678 there, and
// the same for paper and linen. Two tables meant two chances to be right. Now the palette comes
// from collage-layout.js, which is a leaf module both renderers import, and this file keeps
// only what is genuinely canvas-specific: the seeded textures below.
//
// The class names are retained for compatibility with applyGround(), which nothing calls.
export const GROUNDS = Object.fromEntries(Object.entries(GROUND_SPEC).map(([k, g]) => [k, {
  key: k,
  className: "cg-g-" + k,
  base: { light: g.fill.light, dark: g.fill.dark },
}]));

export const GROUND_KEYS = Object.keys(GROUNDS);

/** 'light' | 'dark' — the theme FAMILY, which is what everything in this file actually wants.
 *  data-lum is written on <html> by the shell before first paint for every theme including
 *  "system", so it answers for all of them; reading data-theme and comparing it to "dark" only
 *  answered for the one theme called "dark" and quietly returned "light" for every other dark
 *  one. The matchMedia line survives as the answer for a detached render with no shell. */
export function resolveTheme() {
  const lum = typeof document !== "undefined" && document.documentElement.dataset.lum;
  if (lum === "dark" || lum === "light") return lum;
  const t = typeof document !== "undefined" && document.documentElement.dataset.theme;
  if (t === "dark" || t === "light") return t;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark" : "light";
}

// mulberry32 — tiny seeded PRNG. Determinism is a correctness property on this screen; this is
// the only randomness source in the file and every ground has a FIXED seed.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TILE_CSS = 256;      // tile size in CSS px
const TILE_PX = 512;       // drawn at 2x so retina never sees soft speckle

// Tiles + data URLs cached per key+theme; generation runs once per session per combination.
const tileCache = new Map();
const urlCache = new Map();

function makeCanvas(px) {
  const c = document.createElement("canvas");
  c.width = px; c.height = px;
  return c;
}

/* Every mark is drawn 9 times on a 3x3 wrap so the tile seams perfectly. `marks` receives a
   draw(fn) that replays fn at each wrap offset. */
function tiled(ctx, drawAll) {
  const offs = [-TILE_PX, 0, TILE_PX];
  drawAll((fn) => {
    for (const ox of offs) for (const oy of offs) {
      ctx.save(); ctx.translate(ox, oy); fn(); ctx.restore();
    }
  });
}

/* Cork: warm tan with darker + lighter flecks and a few soft pores. Contrast is deliberately
   low — the board is a stage, the photos are the act. */
function drawCork(ctx, theme) {
  const rnd = mulberry32(0xC0CB0A2D);
  const dark = theme === "dark";
  ctx.fillStyle = GROUNDS.corkboard.base[theme];
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);

  // CORK IS GRANULES, AND THEY HAVE TO BE VISIBLE. The first version drew 850 flecks at alpha
  // .05-.13 and the board came out as flat brown — just a brown background that
  // looked nothing like a corkboard. Three things were wrong and all three are fixed here:
  //
  //   1. TOO FAINT. Real cork has genuine light/dark contrast between granules; a 5% wash is
  //      invisible once the tile is scaled down into an export.
  //   2. TOO SMALL. Granules were 1-3px on a 256px tile, so they averaged into the base colour
  //      at any size a person actually looks at the board.
  //   3. NO LARGER STRUCTURE. Cork reads as cork because of patches — clusters of granules in
  //      slightly different tones — not because of even noise. Even noise reads as JPEG grain.
  //
  // So: a coarse mottle first, then two passes of granules over it, then the dark pores.
  const mottle = dark
    ? ["#4a3826", "#382a1b", "#523f2b", "#31251a"]
    : ["#d4b183", "#bd9a6a", "#dcbc90", "#b08f60"];
  tiled(ctx, (put) => {
    for (let i = 0; i < 120; i++) {
      const x = rnd() * TILE_PX, y = rnd() * TILE_PX;
      const rw = 14 + rnd() * 34, rh = 10 + rnd() * 26, rot = rnd() * Math.PI;
      const a = 0.16 + rnd() * 0.20;
      const col = mottle[Math.floor(rnd() * mottle.length)];
      put(() => {
        ctx.globalAlpha = a; ctx.fillStyle = col;
        ctx.translate(x, y); ctx.rotate(rot);
        ctx.beginPath(); ctx.ellipse(0, 0, rw, rh, 0, 0, Math.PI * 2); ctx.fill();
      });
    }
  });

  const darks = dark ? ["#1d1610", "#2a2015", "#241b12"] : ["#7d5f3a", "#634b2c", "#8d6c42"];
  const lights = dark ? ["#6b5741", "#7d6749", "#5c4a35"] : ["#eddcbc", "#e0c69c", "#f2e4c8"];
  tiled(ctx, (put) => {
    // DENSE ENOUGH THAT THE GRANULES TOUCH. At 1400 the flecks read as confetti scattered on
    // brown; cork is granules PACKED together, so the base colour should barely show through.
    // Elongated, too — a cork granule is a squashed cell, not a dot.
    for (let i = 0; i < 3000; i++) {
      const x = rnd() * TILE_PX, y = rnd() * TILE_PX;
      const rw = 2.6 + rnd() * 8.5, rh = 1.4 + rnd() * 3.6, rot = rnd() * Math.PI;
      const lighter = rnd() < 0.46;
      const col = (lighter ? lights : darks)[Math.floor(rnd() * 3)];
      const a = 0.13 + rnd() * (dark ? 0.18 : 0.22);
      put(() => {
        ctx.globalAlpha = a; ctx.fillStyle = col;
        ctx.translate(x, y); ctx.rotate(rot);
        ctx.beginPath(); ctx.ellipse(0, 0, rw, rh, 0, 0, Math.PI * 2); ctx.fill();
      });
    }
    // The pores: small, properly dark, and few. They are what stops it reading as fabric.
    for (let i = 0; i < 150; i++) {
      const x = rnd() * TILE_PX, y = rnd() * TILE_PX;
      const r = 1.2 + rnd() * 3.2;
      const a = 0.22 + rnd() * 0.24;
      put(() => {
        ctx.globalAlpha = a; ctx.fillStyle = dark ? "#0b0805" : "#4a3520";
        ctx.beginPath(); ctx.ellipse(x, y, r, r * (0.6 + rnd() * 0.6), rnd() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  });
  ctx.globalAlpha = 1;
}


/* Paper: warm sheet with short pulp fibres and a faint mottle. */
function drawPaper(ctx, theme) {
  const rnd = mulberry32(0x9A9E12F3);
  const dark = theme === "dark";
  ctx.fillStyle = GROUNDS.paper.base[theme];
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  tiled(ctx, (put) => {
    for (let i = 0; i < 30; i++) { // mottle (rnd() before put(), see the cork note)
      const x = rnd() * TILE_PX, y = rnd() * TILE_PX, r = 18 + rnd() * 34;
      const col = rnd() < 0.5 ? (dark ? "#000" : "#8f7c58") : (dark ? "#efe4cf" : "#fff");
      put(() => {
        ctx.globalAlpha = 0.018;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      });
    }
    for (let i = 0; i < 1400; i++) { // fibres
      const x = rnd() * TILE_PX, y = rnd() * TILE_PX;
      const len = 4 + rnd() * 12, ang = rnd() * Math.PI;
      const light = rnd() < 0.5;
      const a = 0.028 + rnd() * 0.03, lw = 0.8 + rnd() * 0.8;
      put(() => {
        ctx.globalAlpha = a;
        ctx.strokeStyle = light ? (dark ? "#efe4cf" : "#ffffff") : (dark ? "#000000" : "#7a684a");
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
        ctx.stroke();
      });
    }
  });
  ctx.globalAlpha = 1;
}

/* Linen: a fine two-axis weave plus thread slubs. */
function drawLinen(ctx, theme) {
  const rnd = mulberry32(0x71E4E77B);
  const dark = theme === "dark";
  ctx.fillStyle = GROUNDS.linen.base[theme];
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  const step = 6; // 3 CSS px
  ctx.globalAlpha = dark ? 0.06 : 0.045;
  ctx.fillStyle = dark ? "#efe4cf" : "#8f7c58";
  for (let x = 0; x < TILE_PX; x += step) ctx.fillRect(x, 0, 1.6, TILE_PX);
  for (let y = 0; y < TILE_PX; y += step) ctx.fillRect(0, y, TILE_PX, 1.6);
  tiled(ctx, (put) => {
    for (let i = 0; i < 520; i++) { // slubs riding the threads (rnd() before put())
      const onX = rnd() < 0.5;
      const p = Math.floor(rnd() * (TILE_PX / step)) * step;
      const q = rnd() * TILE_PX, len = 3 + rnd() * 8;
      const a = 0.05 + rnd() * 0.045;
      const col = rnd() < 0.5 ? (dark ? "#efe4cf" : "#ffffff") : (dark ? "#000000" : "#7a684a");
      put(() => {
        ctx.globalAlpha = a;
        ctx.fillStyle = col;
        if (onX) ctx.fillRect(p, q, 1.6, len); else ctx.fillRect(q, p, len, 1.6);
      });
    }
  });
  ctx.globalAlpha = 1;
}

/* Slate: dense fine mineral speckle, no direction. Cool and quiet — it is the ground for the
   magnets, so it must not compete with them. */
function drawSlate(ctx, theme) {
  const rnd = mulberry32(0x51A7E001);
  const dark = theme === "dark";
  ctx.fillStyle = GROUNDS.slate.base[theme];
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  tiled(ctx, (put) => {
    for (let i = 0; i < 900; i++) {
      const x = rnd() * TILE_PX, y = rnd() * TILE_PX;
      const r = 0.5 + rnd() * 1.5;
      const lighter = rnd() < 0.55;
      const col = lighter ? (dark ? "#8d8a86" : "#ffffff") : (dark ? "#000000" : "#3b3835");
      const a = 0.03 + rnd() * (dark ? 0.05 : 0.06);
      put(() => {
        ctx.globalAlpha = a; ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      });
    }
  });
  ctx.globalAlpha = 1;
}

/* Fridge: brushed enamelled steel. Vertical striations plus one broad diagonal sheen — the two
   cues that stop a flat grey reading as card. The DOM twin builds the same two things out of
   repeating-linear-gradients; see GRAIN.fridge in collage.js. */
function drawFridge(ctx, theme) {
  const rnd = mulberry32(0xF81D6E11);
  const dark = theme === "dark";
  ctx.fillStyle = GROUNDS.fridge.base[theme];
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  // striations: fixed columns, varied alpha, so the pattern tiles without a visible seam
  for (let x = 0; x < TILE_PX; x += 2) {
    ctx.globalAlpha = (dark ? 0.035 : 0.05) + rnd() * (dark ? 0.03 : 0.05);
    ctx.fillStyle = rnd() < 0.5 ? (dark ? "#ffffff" : "#ffffff") : (dark ? "#000000" : "#93a0aa");
    ctx.fillRect(x, 0, 1, TILE_PX);
  }
  // the sheen, as a diagonal band. Drawn last so it lies over the striations like real light.
  const g = ctx.createLinearGradient(0, TILE_PX, TILE_PX, 0);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, dark ? "rgba(255,255,255,.045)" : "rgba(255,255,255,.22)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
}

const GROUND_DRAW = {
  corkboard: drawCork, paper: drawPaper, linen: drawLinen,
  slate: drawSlate, fridge: drawFridge,
};

/** The 256-CSS-px ground tile (drawn at 2x), cached per (key, theme). Browser only. */
export function groundTile(key, theme) {
  const k = key + "/" + theme;
  let c = tileCache.get(k);
  if (!c) {
    c = makeCanvas(TILE_PX);
    // Every key in the registry has a drawer, and this assertion is what keeps that true: the
    // old code indexed GROUND_DRAW blind, so a ground declared without a texture threw here
    // rather than at the point somebody forgot it.
    const draw = GROUND_DRAW[key];
    if (!draw) throw new Error(`collage-frames: no ground texture for "${key}"`);
    draw(c.getContext("2d"), theme);
    tileCache.set(k, c);
  }
  return c;
}

/**
 * Put a ground on the VIEWPORT element (not the camera layer — see header). Sets the registry
 * class, the base colour, and the generated tile. Call again after a theme change (cached, so
 * a re-call costs a few style writes).
 */
export function applyGround(el, key, theme) {
  const t = theme === "dark" || theme === "light" ? theme : resolveTheme();
  const g = GROUNDS[key];
  const uk = key + "/" + t;
  let url = urlCache.get(uk);
  if (!url) { url = groundTile(key, t).toDataURL("image/png"); urlCache.set(uk, url); }
  for (const o of GROUND_KEYS) el.classList.toggle(GROUNDS[o].className, o === key);
  el.dataset.cgGround = key;
  el.style.backgroundColor = g.base[t];
  el.style.backgroundImage = `url(${url})`;
  el.style.backgroundSize = `${TILE_CSS}px ${TILE_CSS}px`;
}

/**
 * Export twin: fill (x,y,w,h) on a 2d context with the ground at `scale` device px per canvas
 * unit (so the texture grain matches the on-screen size at any export ratio).
 */
export function paintGround(ctx, key, x, y, w, h, theme, scale) {
  const t = theme === "dark" || theme === "light" ? theme : resolveTheme();
  const s = scale || 1;
  ctx.save();
  ctx.fillStyle = GROUNDS[key].base[t];
  ctx.fillRect(x, y, w, h);
  const pat = ctx.createPattern(groundTile(key, t), "repeat");
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const f = (s * TILE_CSS) / TILE_PX; // tile is 2x; draw it back at CSS-pixel grain
  ctx.translate(x, y); ctx.scale(f, f);
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, w / f, h / f);
  ctx.restore();
}

/* ── fasteners ──────────────────────────────────────────────────────────────────────────
 *
 * Thumbtacks and magnets: the PHOTOREAL direction, chosen because the tacks
 * and magnets have to look realistic and appealing, and because the graphic direction conceded
 * the point in its own critique — if the aim is "looks like it's really holding the photo",
 * it loses to a photoreal direction, on the magnet especially.
 *
 * One file, two renderers, zero divergence: the same numbers feed a DOM recipe
 * (background gradients + box-shadow on a single round element — the vocabulary
 * collage.css already lives in, no filter(), no SVG <filter>) and a canvas twin
 * (createRadialGradient / createLinearGradient / ctx.shadow*, the vocabulary
 * drawFrame() already lives in). Everything here has an exact twin on the other
 * side BY CONSTRUCTION — that is the whole selection criterion for the vocabulary,
 * because the export/screen parity harness cannot see a fastener yet and the only
 * defence until it can is to make divergence inexpressible.
 *
 * THE LIGHT IS THE BOARD'S LIGHT, AND IT POINTS STRAIGHT DOWN.
 * collage.css's --cg-shadow offsets are (0, +y): every print on the board already
 * casts its shadow directly beneath itself. A photoreal fastener photographed under
 * a different lamp than the prints it holds is the uncanny middle in one move, so:
 * specular at top-centre, cast shadow straight below, both renderers, no exceptions.
 * Corollary: the fastener must NOT rotate with the print. A rotated item would swing
 * the highlight off vertical, so the DOM child carries rotate(-rot) and the canvas
 * twin does ctx.rotate(-rot * DEG) at the same point — the light stays nailed to the
 * room. (A round head makes this cheap: only the shading rotates, never the shape.)
 *
 * TWO OBJECTS, TWO PHYSICS — the difference is the SHADOW STORY, not the hue:
 *   TACK   = glossy plastic dome pushpin, ELEVATED ~half a head off the board by its
 *            pin. Sharp small specular (gloss), and a cast shadow that is OFFSET and
 *            SOFT — separation between object and shadow is what reads as "standing
 *            off the surface".
 *   MAGNET = satin enamel button, FLUSH against the paper it clamps. Broad dull sheen
 *            (satin), a visible cylinder side-wall at its foot, and a TIGHT dark
 *            contact shadow hugging the silhouette — contact is what reads as
 *            "pressed flat". Bigger and flatter than the tack: different silhouette
 *            proportions, so the two never read as a recolour (on a
 *            daltonized display substance must be carried by shape and value).
 *
 * VARIANTS ARE VALUE-SEPARATED, NEVER HUE-SEPARATED: each object gets a light / mid /
 * dark body (bone, brass, oxblood; cream, navy, charcoal). Adjacent-value collisions
 * with the backdrop are survived by the shadow story, not by an outline.
 *
 * Both themes are AUTHORED, not inverted (collage-frames.js:74-76 reasoning): dark
 * theme dims the bodies like everything else under the lamp, warms the specular to
 * lamp-light, and deepens shadow alpha the way --cg-shadow's dark half already does.
 *
 * DETERMINISM: nothing in this file draws randomness. Per-instance variation (which
 * colour, ±px of seat position) is the CALLER's job and must come from
 * hash32(layout.seed + ":" + item.id + ":fast") — the sanctioned stream — so both
 * renderers agree tack for tack and det.a === det.b holds in the export harness.
 *
 * SIZING: `d` is the head diameter in the caller's units (canvas units in the app).
 * Every internal length is a fraction of d, clamped where a fraction would fall
 * under a device pixel at d=14 — the smallest size that must still read as an
 * object rather than a bruise. Canvas shadows ignore the CTM, so drawTack/drawMagnet
 * take `scale` and multiply every shadowBlur/shadowOffset by it, exactly the way
 * drawFrame() does.
 *
 * Parameters worked out from physical lighting studies to match the reasoning above.
 */

const TAU = Math.PI * 2;

// The fasteners' inks, colours and DOM recipes live in ./shared/fasteners.js: the app, the export and a shared
// board's page draw the same tacks and magnets from one source.
import { SHADOW_RGB, SHADOW_A, SPEC_RGB, TACKS, MAGNETS, px, tackStyle, magnetStyle } from "./shared/fasteners.js";

const applyStyle = function (el, s) { for (var k in s) el.style[k] = s[k]; };
function applyTack(el, d, c, theme) { applyStyle(el, tackStyle(d, c, theme)); }
function applyMagnet(el, d, c, theme) { applyStyle(el, magnetStyle(d, c, theme)); }

/* ── THUMBTACK, canvas twin ───────────────────────────────────────────────────
 * Same numbers, restated in drawFrame()'s dialect. Caller has already translated
 * to the head centre and counter-rotated the print's rot; `scale` multiplies every
 * shadow length because canvas shadows ignore the CTM (collage-frames.js:52-54).
 * The CSS dome gradient's implicit radius is farthest-corner ≈ 0.86*d from the
 * (50%,30%) centre — restated literally so the ramp lands on the same pixels. */
function drawTack(ctx, cx, cy, d, c, theme, scale) {
  scale = scale || 1;
  var r = d / 2, sh = SHADOW_RGB[theme], a = SHADOW_A[theme], spec = SPEC_RGB[theme];
  var circle = function () { ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); };
  ctx.save();
  // Cast shadows: fill the silhouette twice with ctx.shadow* live — the fills
  // themselves land under the dome painted next, so only the shadows survive.
  circle();
  ctx.shadowColor = "rgba(" + sh + "," + a.soft + ")";
  ctx.shadowBlur = d * 0.20 * scale; ctx.shadowOffsetY = d * 0.17 * scale;
  ctx.fillStyle = c.rim; ctx.fill();
  ctx.shadowColor = "rgba(" + sh + "," + a.tight + ")";
  ctx.shadowBlur = d * 0.07 * scale; ctx.shadowOffsetY = d * 0.08 * scale;
  ctx.fill();
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  // Dome ramp, clipped to the head. Flat-ish: hi holds to 26%, the dark turn
  // is confined to the outer ~12% — see tackStyle for why (ball vs dome).
  circle(); ctx.clip();
  var g = ctx.createRadialGradient(cx, cy - r * 0.32, 0, cx, cy - r * 0.32, d * 0.83);
  g.addColorStop(0, c.hi); g.addColorStop(0.26, c.hi); g.addColorStop(0.62, c.mid);
  g.addColorStop(0.9, c.lo); g.addColorStop(1, c.rim);
  ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, d, d);
  if (c.metal) {
    g = ctx.createRadialGradient(cx, cy + r * 0.64, 0, cx, cy + r * 0.64, d * 0.26);
    g.addColorStop(0, "rgba(255,240,205,.38)"); g.addColorStop(1, "rgba(255,240,205,0)");
    ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, d, d);
  }
  // The moulded plateau ring — twin of the CSS ring layer (see tackStyle).
  var ringR = d * 0.30, ringT = Math.max(1, d * 0.05), ringEnd = ringR + ringT;
  g = ctx.createRadialGradient(cx, cy - r * 0.24, 0, cx, cy - r * 0.24, ringEnd);
  g.addColorStop(0, "rgba(" + spec + ",.08)");
  g.addColorStop(Math.max(0, (ringR - ringT) / ringEnd), "rgba(" + spec + ",.08)");
  g.addColorStop(ringR / ringEnd, "rgba(0,0,0,.13)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, d, d);
  // Bottom inner AO — the inset box-shadow's twin: dark near the lower rim,
  // gone by the middle of the dome.
  g = ctx.createRadialGradient(cx, cy + r * 1.1, r * 0.45, cx, cy + r * 1.1, r * 1.3);
  g.addColorStop(0, "rgba(0,0,0," + (theme === "dark" ? 0.30 : 0.22) + ")");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, d, d);
  // Bounce light at the dome's foot — the twin of the warm inset line.
  ctx.beginPath();
  ctx.arc(cx, cy, r - Math.max(0.5, d * 0.025), Math.PI * 0.25, Math.PI * 0.75);
  ctx.strokeStyle = "rgba(255,236,205," + (theme === "dark" ? 0.16 : 0.22) + ")";
  ctx.lineWidth = Math.max(1, d * 0.05);
  ctx.stroke();
  // Specular hotspot, same clamps as the CSS.
  var core = Math.max(0.9, d * 0.05), endR = Math.max(2.6, d * 0.17);
  g = ctx.createRadialGradient(cx, cy - r * 0.56, 0, cx, cy - r * 0.56, endR);
  g.addColorStop(0, "rgba(" + spec + ",.95)");
  g.addColorStop(Math.min(0.99, core / endR), "rgba(" + spec + ",.95)");
  g.addColorStop(Math.min(0.995, Math.max(1.5, d * 0.09) / endR), "rgba(" + spec + ",.42)");
  g.addColorStop(1, "rgba(" + spec + ",0)");
  ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, d, d);
  ctx.restore();
}

/* ── MAGNET, canvas twin ──────────────────────────────────────────────────────
 * Wall-then-face, matching the rebuilt DOM recipe: the whole silhouette is the
 * wall colour, then the top face is a hard-edged ELLIPSE (rx r*0.92, ry r*0.76,
 * centre lifted to 40% of the box) carrying a FLAT ramp with a thin dark rim —
 * the bottom ~22% of wall left showing under the face's curve is the cylinder
 * cue, and the ceiling-reflection band across the face is the flatness cue. The
 * ellipse is a circular gradient under a y-scale, blended into the wall colour
 * over its last ~1.5% so the edge anti-aliases the way the CSS ellipse does. */
function drawMagnet(ctx, cx, cy, d, c, theme, scale) {
  scale = scale || 1;
  var r = d / 2, sh = SHADOW_RGB[theme], a = SHADOW_A[theme], spec = SPEC_RGB[theme];
  var sheenA = theme === "dark" ? 0.32 : 0.30;
  var glintA = theme === "dark" ? 0.50 : 0.40;
  ctx.save();
  // AO ring first (it sits outside the silhouette): a stroke, not a shadow.
  var ring = Math.max(0.6, d * 0.025);
  ctx.beginPath(); ctx.arc(cx, cy, r + ring / 2, 0, TAU);
  ctx.strokeStyle = "rgba(" + sh + "," + a.ring + ")"; ctx.lineWidth = ring; ctx.stroke();
  // Contact-dominant shadows (flush object), silhouette filled with the wall
  // colour so the fills double as the cylinder side.
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU);
  ctx.shadowColor = "rgba(" + sh + "," + a.ambient + ")";
  ctx.shadowBlur = d * 0.14 * scale; ctx.shadowOffsetY = d * 0.09 * scale;
  ctx.fillStyle = c.side; ctx.fill();
  ctx.shadowColor = "rgba(" + sh + "," + a.tight + ")";
  ctx.shadowBlur = d * 0.05 * scale; ctx.shadowOffsetY = d * 0.045 * scale;
  ctx.fill();
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  // Dark seam where the wall meets the paper — the inset bottom hairline's twin.
  ctx.beginPath();
  ctx.arc(cx, cy, r - Math.max(0.5, d * 0.015), Math.PI * 0.2, Math.PI * 0.8);
  ctx.strokeStyle = "rgba(0,0,0," + (theme === "dark" ? 0.42 : 0.35) + ")";
  ctx.lineWidth = Math.max(1, d * 0.03);
  ctx.stroke();
  // The face ellipse: circular radial gradient under a y-scale — FLAT ramp, the
  // darkening confined to a thin rim (see magnetStyle for why).
  var fy = cy - r * 0.20, rx = r * 0.92, sy = 0.76 / 0.92;
  // (A canvas path keeps the coordinates it was built under, so the ellipse is
  // drawn inside a translate/scale that is restored before filling — the fills
  // and gradients below then run in plain item-local space.)
  var facePath = function (radius, a0, a1) {
    ctx.save();
    ctx.beginPath();
    ctx.translate(cx, fy); ctx.scale(1, sy);
    ctx.arc(0, 0, radius, a0 === undefined ? 0 : a0, a1 === undefined ? TAU : a1);
    ctx.restore();
  };
  ctx.save();
  ctx.translate(cx, fy); ctx.scale(1, sy);
  var g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, c.hi); g.addColorStop(0.74, c.mid); g.addColorStop(0.90, c.mid);
  g.addColorStop(0.96, c.lo); g.addColorStop(0.985, c.side); g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, rx, 0, TAU); ctx.fill();
  ctx.restore();
  // The ceiling band — twin of the CSS linear band, clipped to the face so it
  // runs edge to edge the way a flat face reflects the room.
  ctx.save();
  facePath(rx);
  ctx.clip();
  g = ctx.createLinearGradient(0, cy - r, 0, cy + r);
  g.addColorStop(0.10, "rgba(" + spec + ",0)");
  g.addColorStop(0.21, "rgba(" + spec + "," + sheenA + ")");
  g.addColorStop(0.31, "rgba(" + spec + "," + sheenA + ")");
  g.addColorStop(0.46, "rgba(" + spec + ",0)");
  ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, d, d);
  ctx.restore();
  // Top glint where the face's edge catches the ceiling — the inset light's twin.
  // The DOM's inset shadow is BLURRED, so a raw stroke overstates it; a shorter,
  // thinner, quieter arc is what actually matches the screen pixels.
  facePath(rx - Math.max(0.5, d * 0.02), Math.PI * 1.25, Math.PI * 1.75);
  ctx.strokeStyle = "rgba(" + spec + "," + (glintA * 0.7).toFixed(2) + ")";
  ctx.lineWidth = Math.max(1, d * 0.03);
  ctx.stroke();
  ctx.restore();
}


export const FASTENERS = {
  TACKS, MAGNETS, tackStyle, magnetStyle, applyTack, applyMagnet, drawTack, drawMagnet,
};

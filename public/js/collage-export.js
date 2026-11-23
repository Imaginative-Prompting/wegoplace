// collage-export.js — the collage as a picture you can post, and the path that hands it to
// the share sheet.
//
// Sharing is the reason the collage view exists, so this file has exactly one job and one
// rule about how it does it:
//
//   THE EXPORT CONSUMES THE SAME `Layout` THE SCREEN CONSUMES.
//
// Not "the same numbers, re-derived". The same object. `collage-layout.js` decides where every
// print lies; `collage.js` paints that with DOM nodes and CSS transforms; this file paints it
// with `drawImage` onto a 2D context. Nothing about placement is computed here — every x, y,
// w, h, rot, z and frame comes off the LayoutItem, and the frame paper and the ground come out
// of `collage-frames.js`, which is the single registry both renderers draw from. There is no
// second geometry model in this file and there must never be one: the moment the export knows
// something about placement that the screen does not, the picture a person posts stops being the
// picture they arranged.
//
// ── WHAT THE EXPORT IS, AND IS NOT ────────────────────────────────────────────────────────
// It is a NEW DERIVED IMAGE. It is not a copy of anybody's photographs. Originals are read
// (decoded into a canvas) and never re-encoded, never uploaded, never touched — the same
// promise `memories-save.js` makes about the save path, seen from the other end: a save moves
// the exact bytes, an export makes a picture OF them.
//
// A PUBLIC LINK IS OUT OF SCOPE AND IS NOT BUILT HERE. A URL a non-member can open means
// public read access to private trip media, which is an auth decision this file has no
// standing to make. Nothing in this module produces a durable URL; the only outputs are a
// Blob, a File, and an object URL that lives for one download.
//
// ── THE TWO HARD LIMITS, NAMED UP FRONT ───────────────────────────────────────────────────
//
// 1. CANVAS AREA. iOS Safari caps the total area of a canvas backing store, and going past it
//    does not throw — the canvas comes back BLANK, or `toBlob` hands you a black rectangle.
//    A silent blank export is the worst possible failure for a share button, so the size is
//    clamped by area AND by longest edge BEFORE the backing store is allocated, and the clamp
//    that fired is reported in the plan (`plan.clampedBy`) rather than being invisible.
//
// 2. MEDIA LOD. The media API serves exactly two tiers — a ~480px client-made webp thumb and
//    the 4K original. There is no mid tier and this file may not add one. So the export draws
//    THUMBS, and reaches for an original only where the export scale would visibly stretch a
//    thumb past its own pixels, capped hard by `maxOriginals` and skipped entirely offline.
//    The policy is `shouldUseOriginal()` from collage-layout.js — the SAME function the
//    interactive renderer's LOD uses, with the export scale standing in for zoom. A whole-board
//    export lands at a scale well under 1, so in the common case this fetches nothing at all.
//
// ── THE GESTURE RULE (why there is a session, not a `shareCollage()`) ─────────────────────
// `navigator.share()` needs transient user activation, and on Safari an `await` before the
// call spends it. Rendering a collage is unavoidably async — images have to load and the
// canvas has to encode. So this module mirrors `createSaveSession()` from memories-save.js
// exactly: the first tap renders and returns `{status:"ready"}`, the second tap reaches
// `navigator.share()` with nothing awaited in front of it. `prewarm()` exists so a view that
// knows a share is coming can render in the background and make Share a single tap.
//
// Capability is NOT re-probed here. `shareCapability()` lives in memories-save.js and this
// file imports it, because two probes are two answers and the UI would eventually show the
// wrong one. Same for the status vocabulary: "ready" | "shared" | "cancelled" | "error" |
// "unsupported" | "downloaded" mean here exactly what they mean there.
//
// ── ENTRY POINTS ──────────────────────────────────────────────────────────────────────────
//
//   planExport(layout, opts)            -> ExportPlan   pure, no DOM, no I/O. The geometry.
//   renderCollage(layout, opts)         -> {canvas, plan, ...}      pixels, no encode
//   exportCollage(layout, opts)         -> {blob, file, plan, ...}  pixels + encode
//   createExportSession(layout, opts)   -> session      the share path; obeys the gesture rule
//   shareExport(result, opts)           -> Promise      one file, one sheet, sync entry
//   downloadExport(result)              -> Promise      the no-share-sheet fallback
//   itemRects(layout, optsOrPlan)       -> rect[]       the structural-comparison seam
//
// ── VERIFICATION SEAM ─────────────────────────────────────────────────────────────────────
// `itemRects()` returns every drawn item's frame-box centre, size and rotation in EXPORT
// PIXELS, plus the same figures converted back to canvas units. `scripts/collage_export_check
// .mjs` samples the live DOM renderer's `getBoundingClientRect()` for the same layout and
// diffs the two, so "the export matches the screen" is a number and not an opinion.
//
// Owner prefix: none — this module builds no DOM beyond one detached <canvas> and one <a>.

"use strict";

import {
  FRAMES, GROUNDS, GROUND_KEYS,
  drawFrame, paintGround, resolveTheme, FASTENERS,
} from "./collage-frames.js";
import {
  BOARD_LOOK, boardOf, frameMetrics, shouldUseOriginal, fastenerFor, fastenerGeometry,
} from "./collage-layout.js";
import { shareCapability, canSaveToPhotos } from "./memories-save.js";
import { corkTileOf, woodOf } from "./shared/board-look.js";
// The fastener stream: one spelling for the app, the export and a shared board's page.
import { fastHash } from "./shared/fasteners.js";

/** Bump when a change would alter the pixels of an export for an unchanged Layout. */
// 2: the board on its wall (boardOf), the photos bare.
export const EXPORT_VERSION = 2;

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ── size limits ───────────────────────────────────────────────────────────────────────────

/**
 * Total pixels a single export canvas may occupy.
 *
 * 16,777,216 (= 4096²) is the area ceiling iOS Safari enforces on a canvas backing store. Past
 * it the canvas is not rejected — it is silently blank, which on this screen would mean a
 * share sheet carrying a black rectangle. 4 bytes per pixel puts the backing store at 64 MB at
 * the ceiling, which is also about as much as a phone should be asked to hold while the source
 * thumbnails are still decoded alongside it.
 */
export const MAX_CANVAS_PIXELS = 16777216;

/** Longest edge, independently of area. Older iOS devices refuse a dimension over 4096 even
 *  when the area would fit (a 8192 x 1024 panorama board is 8 Mpx and still fails). */
export const MAX_CANVAS_EDGE = 4096;

export const DEFAULTS = {
  // ── size ────────────────────────────────────────────────────────────────────────────────
  /** Target longest edge in pixels. 2048 is the size social platforms re-encode down to
   *  anyway, keeps the backing store near 12 MB for a typical board, and is comfortably inside
   *  every canvas limit. Raise it for a print; it is clamped, never obeyed blindly. */
  // 4096, NOT 2048. A person zooms in to look at the photos, and they have to look
  // good at that size; at the old one they did not survive any zoom at all. At 2048 a board of twenty
  // prints gives each one about 400px, which is a thumbnail — fine as a whole picture, useless
  // the moment somebody pinches. 4096 is MAX_CANVAS_EDGE and, on a 1.6:1 board, 10.4M pixels
  // against the 16.7M area ceiling, so it fits with room.
  targetLongEdge: 4096,
  /** Force an exact device-pixels-per-canvas-unit ratio instead of deriving one from
   *  targetLongEdge. Still clamped by area and edge. */
  pixelRatio: 0,
  /** Never magnify a board more than this. A four-photo board scaled to 2048px would be a
   *  wall of interpolation; past 4x there are no more pixels in the source to show. */
  maxScale: 4,
  /** ...and never shrink a print below legibility. A 500-item board hits this and exports
   *  larger than targetLongEdge asked for, up to the hard clamps. */
  minScale: 0.25,
  maxPixels: MAX_CANVAS_PIXELS,
  maxEdge: MAX_CANVAS_EDGE,
  /** Export a sub-rectangle of the board in canvas units ({minX,minY,maxX,maxY}), e.g. the
   *  camera's current view. null exports the whole board. */
  crop: null,

  // ── look ────────────────────────────────────────────────────────────────────────────────
  /** 'light' | 'dark' | '' (follow the app's three-state theme via resolveTheme()). */
  theme: "",
  /** Ground key override; defaults to layout.background. */
  background: "",
  /** false paints a flat ground colour with no texture (a hair faster, and what a caller
   *  wants if the collage is going to be composited onto something else). */
  ground: true,
  /** (item) => string | falsy. Captions only exist on frames that have a slot for one — the
   *  polaroid foot — which drawFrame() enforces. The Layout carries no caption, so the app
   *  passes this closure over its own memory titles. */
  captionFor: null,
  /** A play disc over videos. OFF by default and that is a deliberate honesty call: the export
   *  is a still image, and a play button on something that cannot play is a lie told to
   *  whoever it is shared with. Videos export as their poster frame, full stop. */
  playBadge: false,

  // ── media ───────────────────────────────────────────────────────────────────────────────
  /** 'auto' | false | true. 'auto' applies shouldUseOriginal() at the export scale — the same
   *  LOD rule the interactive renderer uses — so a whole-board export fetches nothing and a
   *  zoomed-in crop upgrades the two or three prints that would otherwise look soft. */
  // TRUE, not "auto". `auto` applies the interactive LOD rule, which correctly decides that a
  // whole-board view does not need 4K files — but an EXPORT is not a view, it is the thing
  // somebody zooms into afterwards, and the decision has to be made for the file rather than
  // for the screen it was made on.
  originals: true,
  /** Hard cap on 4K originals pulled for one export, whatever `originals` asks for. Eight 4K
   *  files is already ~100 MB through a phone. */
  // Raised with it. Eight was sized for "upgrade the two or three prints that look soft"; a
  // sharp export needs every print it can get. Still a cap, because a 200-print board on hotel
  // wifi is not a thing to attempt unbounded, and anything past it keeps its thumbnail.
  maxOriginals: 60,
  /** () => boolean. Defaults to navigator.onLine. Offline, `originals` is forced off — see the
   *  note in planExport. Injectable because navigator.onLine answers "is there a link", not
   *  "can I reach the trip", and on the trek those are different questions. */
  isOnline: null,
  /** Concurrent image loads. Six is polite to trailhead wifi and still saturates a good link. */
  concurrency: 6,
  /** Per-image load timeout, ms. A stalled thumb must not hold the whole export open. */
  imageTimeoutMs: 12000,
  /** Draw the not-downloaded tray for media that will not load. false omits the item's media
   *  but STILL DRAWS ITS FRAME — an export may not silently re-arrange the board. */
  showMissing: true,

  // ── output ──────────────────────────────────────────────────────────────────────────────
  /** JPEG by default: the ground and the paper fill every pixel so there is no alpha to keep,
   *  and a 2048px PNG of photographic content is ~20 MB where the JPEG is ~600 KB. A share
   *  sheet holding 20 MB is a slow sheet. */
  type: "image/jpeg",
  quality: 0.92,
  /** Base of the file name. The date and extension are appended. */
  name: "WeGoPlace-collage",

  // ── plumbing ────────────────────────────────────────────────────────────────────────────
  /**
   * (frame, w, h) -> {dx, dy, w, h} — the SAME injection seam `layoutCollage()` takes, for the
   * same reason: so a frame model can be changed in one place instead of forked into three.
   *
   * LEAVE IT NULL. Null means `frameMetrics()` from collage-layout.js, which is the binding
   * contract and what `bounds`, the occlusion solver and `pickTopAt()` were computed against.
   * It exists because a DOM renderer that treats the LayoutItem's photo box as its whole outer
   * box has a different, self-consistent geometry, and if that model is ever the one that ships
   * then the export must follow it rather than quietly drawing a different picture:
   *
   *     frameMetrics: (frame, w, h) => ({ dx: 0, dy: 0, w, h })
   *
   * Changing it is a decision about which renderer is right, never a tweak.
   */
  frameMetrics: null,
  signal: null,
  onProgress: null,
};

// ══════════════════════════════════════════════════════════════════════════════════════════
// The plan — pure geometry. No DOM, no network, no canvas.
// ══════════════════════════════════════════════════════════════════════════════════════════

/** The frame box of an item in canvas units, unrotated. `item.frameBox` is the number the
 *  solver and `bounds` actually used, so it wins; frameMetrics() is the fallback for a
 *  hand-built item. Identical by construction — collage-layout.js asserts it. */
function frameBoxOf(item, fm) {
  const f = fm ? fm(item.frame, item.w, item.h)
    : (item.frameBox || frameMetrics(item.frame, item.w, item.h));
  return { x: item.x + f.dx, y: item.y + f.dy, w: f.w, h: f.h };
}

/** Rotated AABB of a frame box. Not `itemAABB()` — that one always reads `item.frameBox`, and
 *  an injected frame model has to be visible to the crop test too or a print near the edge of a
 *  crop goes missing from the picture. With no injection the two are the same number. */
function aabbOf(fb, rot) {
  const a = (rot || 0) * DEG;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const hx = (c * fb.w + s * fb.h) / 2, hy = (s * fb.w + c * fb.h) / 2;
  const cx = fb.x + fb.w / 2, cy = fb.y + fb.h / 2;
  return { minX: cx - hx, minY: cy - hy, maxX: cx + hx, maxY: cy + hy };
}

const rectsOverlap = (a, b) =>
  a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

/**
 * Work out the export's canvas rectangle, its pixel scale, and every item's geometry in export
 * pixels. Pure and synchronous — safe to call to size a preview, to drive a test, or to decide
 * whether an export is worth starting at all.
 *
 * @param {object} layout   a Layout from collage-layout.js
 * @param {object} [opts]   see DEFAULTS
 * @returns {{
 *   version:number, scale:number, width:number, height:number,
 *   rect:{x:number,y:number,w:number,h:number},         // the exported region, canvas units
 *   theme:'light'|'dark', background:string, empty:boolean,
 *   clampedBy:''|'scale'|'area'|'edge', requestedScale:number,
 *   items: Array<{
 *     id, index, z, kind, frame,
 *     cx, cy, w, h, rot,          // FRAME BOX centre + size in EXPORT PIXELS, rot in degrees
 *     canvas: {x,y,w,h},          // ...and the same frame box in CANVAS UNITS, unrotated
 *     photo:  {x,y,w,h},          // the photo box inside the frame box, canvas units
 *     corners: [[x,y]x4],         // rotated frame corners, export pixels
 *     src, srcTier                // the URL that will be drawn, and 'thumb' | 'original' | ''
 *   }>,
 *   counts: { total:number, drawn:number, clipped:number, videos:number, originals:number }
 * }}
 */
export function planExport(layout, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const items = Array.isArray(layout && layout.items) ? layout.items.slice() : [];
  // z is the paint order and equals the array index, but a caller may hand us a filtered or
  // re-ordered list, so sort rather than assume.
  items.sort((a, b) => (a.z | 0) - (b.z | 0));

  const theme = o.theme === "light" || o.theme === "dark" ? o.theme : resolveTheme();
  const bgKey = GROUNDS[o.background] ? o.background
    : GROUNDS[layout && layout.background] ? layout.background
    : GROUND_KEYS[0];

  const b = (layout && layout.bounds) || null;
  // THE PICTURE IS THE BOARD ON ITS WALL: the board the app draws for these photos (boardOf), with its band of
  // wall round it, so the saved image is what the board looks like when it opens. A crop still wins.
  const st = (layout && layout.stats) || {};
  const board = boardOf(items.length ? b : null, st.targetWidth, st.boardTall);
  let rect;
  if (o.crop && Number.isFinite(o.crop.minX)) {
    rect = { x: o.crop.minX, y: o.crop.minY, w: o.crop.maxX - o.crop.minX, h: o.crop.maxY - o.crop.minY };
  } else {
    rect = { ...board.wall };
  }
  const empty = !items.length;

  // ── scale, then the two clamps that stop a phone from allocating a blank canvas ─────────
  const longEdge = Math.max(rect.w, rect.h);
  let scale = o.pixelRatio > 0 ? Number(o.pixelRatio) : numOr(o.targetLongEdge, 2048) / longEdge;
  const requested = scale;
  let clampedBy = "";
  const capped = clamp(scale, Math.max(0.01, o.minScale), Math.max(o.minScale, o.maxScale));
  if (capped !== scale) { clampedBy = "scale"; scale = capped; }

  const maxPixels = Math.max(1, numOr(o.maxPixels, MAX_CANVAS_PIXELS));
  const area = rect.w * scale * rect.h * scale;
  if (area > maxPixels) { scale *= Math.sqrt(maxPixels / area); clampedBy = "area"; }

  const maxEdge = Math.max(1, numOr(o.maxEdge, MAX_CANVAS_EDGE));
  const biggest = Math.max(rect.w, rect.h) * scale;
  if (biggest > maxEdge) { scale *= maxEdge / biggest; clampedBy = "edge"; }

  // Integer backing store; the rect grows by up to a pixel rather than the scale changing, so
  // the scale in the plan is exactly the scale the transform will use.
  const width = Math.max(1, Math.round(rect.w * scale));
  const height = Math.max(1, Math.round(rect.h * scale));

  const view = { minX: rect.x, minY: rect.y, maxX: rect.x + rect.w, maxY: rect.y + rect.h };
  const out = [];
  let clipped = 0, videos = 0, originals = 0;
  // OFFLINE MEANS THUMBS, FULL STOP. Four days of the trek have no radio; on those days an
  // original that is not already in the media cache is a request that hangs for the timeout and
  // then draws a not-downloaded tray over a photograph the thumb could have shown perfectly
  // well. `isOnline` is injectable for the same reason collage.js's is: navigator.onLine is a
  // link-layer fact, not a reachability one, and the app knows better than the browser does.
  const online = typeof o.isOnline === "function" ? !!o.isOnline()
    : (typeof navigator === "undefined" || navigator.onLine !== false);
  const wantOriginal = online && (o.originals === true || o.originals === "auto");

  const fm = typeof o.frameMetrics === "function" ? o.frameMetrics : null;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const fb = frameBoxOf(it, fm);
    // Rotation is about the FRAME BOX centre, so the AABB that decides visibility has to be
    // the rotated frame AABB — anything smaller is how a print at the edge of a crop goes
    // missing from the picture.
    if (!rectsOverlap(aabbOf(fb, it.rot), view)) { clipped++; continue; }

    const cxC = fb.x + fb.w / 2, cyC = fb.y + fb.h / 2;
    const cx = (cxC - rect.x) * scale, cy = (cyC - rect.y) * scale;
    const pw = fb.w * scale, ph = fb.h * scale;
    const rot = it.rot || 0;
    const a = rot * DEG, cos = Math.cos(a), sin = Math.sin(a);
    const hw = pw / 2, hh = ph / 2;
    const corners = [
      [cx - hw * cos + hh * sin, cy - hw * sin - hh * cos],
      [cx + hw * cos + hh * sin, cy + hw * sin - hh * cos],
      [cx + hw * cos - hh * sin, cy + hw * sin + hh * cos],
      [cx - hw * cos - hh * sin, cy - hw * sin + hh * cos],
    ];

    // LOD. `scale` is exactly what `zoom` means to shouldUseOriginal(): device pixels per
    // canvas unit. dpr is 1 because the export IS device pixels, there is no second ratio.
    let srcTier = it.thumbUrl ? "thumb" : (it.origUrl ? "original" : "");
    let src = it.thumbUrl || it.origUrl || "";
    const soft = o.originals === true ||
      (o.originals === "auto" && shouldUseOriginal(it, scale, 1));
    // NEVER FOR A VIDEO. A video's "original" is an .mp4, and the still export loads its source
    // with an <img> — so upgrading one hands the decoder a file it cannot read, the item falls
    // back to the not-downloaded tray, and a board of clips comes out as a row of dashed boxes.
    // The poster IS the thumbnail, and for a still that is the correct and only source.
    // (The VIDEO export is different and reaches for origUrl directly; see exportCollageVideo.)
    const isVideo = (it.kind || "photo") === "video";
    if (!isVideo && wantOriginal && soft && it.origUrl && originals < Math.max(0, o.maxOriginals | 0)) {
      src = it.origUrl; srcTier = "original"; originals++;
    }
    if (it.kind === "video") videos++;

    out.push({
      id: it.id, index: i, z: it.z | 0, kind: it.kind || "photo", frame: it.frame || "print",
      cx, cy, w: pw, h: ph, rot,
      canvas: { x: fb.x, y: fb.y, w: fb.w, h: fb.h },
      photo: { x: it.x, y: it.y, w: it.w, h: it.h },
      corners, src, srcTier,
      // THE CLIP ITSELF, and its loop window. `src` above is whatever tier the still export
      // wants — usually the thumbnail — which is exactly the wrong thing for the VIDEO export
      // to play. It needs the original, and it needs to know which slice of it to show.
      origUrl: it.origUrl || "",
      loopStartMs: it.loopStartMs | 0,
      loopMs: it.loopMs | 0,
      focal: it.focal || { x: 0.5, y: 0.5 },
      // Carried onto the plan so drawItem() can shrink the source window the same way the DOM
      // scales the <img>. Absent or <= 1 means "as shot", which is what every existing row is.
      zoom: Number(it.zoom) > 1 ? Number(it.zoom) : 1,
      item: it,
    });
  }

  return {
    version: EXPORT_VERSION,
    scale, width, height, rect, theme, background: bgKey, empty,
    // The board in this canvas's pixels (and in canvas units, for a comparison with the app's).
    board: { x: (board.x - rect.x) * scale, y: (board.y - rect.y) * scale, w: board.w * scale, h: board.h * scale },
    boardUnits: { x: board.x, y: board.y, w: board.w, h: board.h },
    // The layout's seed rides the plan so drawItem() can reproduce the fastener stream. It has
    // to be the SAME number collage.js hashes or the two renderers pick different tacks, which
    // is a disagreement the parity check is now written to catch.
    seed: (layout && layout.seed) || 0,
    clampedBy, requestedScale: requested,
    items: out,
    counts: { total: items.length, drawn: out.length, clipped, videos, originals },
  };
}

/**
 * The structural-comparison seam. Same numbers as `planExport().items`, stripped to what a
 * geometry diff needs, with the export-pixel figures converted back to CANVAS UNITS so they
 * can be compared directly against `getBoundingClientRect()` samples taken off the DOM
 * renderer. `canvasCx/canvasCy/canvasW/canvasH` are what both renderers must agree on.
 */
export function itemRects(layout, optsOrPlan = {}) {
  const plan = optsOrPlan && Array.isArray(optsOrPlan.items) && optsOrPlan.scale
    ? optsOrPlan : planExport(layout, optsOrPlan);
  const { scale, rect } = plan;
  return plan.items.map((p) => ({
    id: p.id, z: p.z, frame: p.frame, kind: p.kind, rot: p.rot,
    px: { cx: p.cx, cy: p.cy, w: p.w, h: p.h },
    canvasCx: p.cx / scale + rect.x,
    canvasCy: p.cy / scale + rect.y,
    canvasW: p.w / scale,
    canvasH: p.h / scale,
    photo: p.photo,
  }));
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Image loading
// ══════════════════════════════════════════════════════════════════════════════════════════

// SAME-ORIGIN, NO crossOrigin ATTRIBUTE, ON PURPOSE. /media/<key> is gated on the session
// cookie, so the request must carry credentials; an <img> with crossOrigin="anonymous" sends
// none and gets a 401. Same-origin images do not taint the canvas, so toBlob() still works —
// setting crossOrigin here would break authentication to buy nothing.
function loadImage(url, timeoutMs, signal) {
  return new Promise((resolve) => {
    if (!url) { resolve(null); return; }
    const img = new Image();
    img.decoding = "async";
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      img.onload = img.onerror = null;
      resolve(v);
    };
    const onAbort = () => { img.src = ""; finish(null); };
    const timer = setTimeout(() => { img.src = ""; finish(null); }, Math.max(1, timeoutMs));
    if (signal) {
      if (signal.aborted) { finish(null); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    // A decoded image of zero width is a 404 that the browser reported as a load; treat it as
    // missing so it wears the not-downloaded tray rather than drawing nothing at all.
    img.onload = () => finish(img.naturalWidth > 0 ? img : null);
    img.onerror = () => finish(null);
    img.src = url;
  });
}

/**
 * Decode one source into something drawImage() takes, preferring an ImageBitmap because it can
 * be CLOSED. That is the whole reason this is not just `new Image()`:
 *
 * A 500-print board is a stated case, and a decoded 480px thumb is ~0.7 MB while a decoded 4K
 * original is ~48 MB. Holding all of them at once — which is what "load everything, then paint"
 * does — is somewhere between 350 MB and several gigabytes on a phone that has neither. So the
 * renderer streams (see renderCollage) and every bitmap is released the moment its print is on
 * the canvas. `img.close()` makes that deterministic instead of a hope about GC.
 *
 * Originals additionally decode STRAIGHT DOWN to the size they will be drawn at. resizeWidth
 * preserves the aspect on its own, so this is the same picture out of a tenth of the memory.
 * Thumbs are left alone: they are already smaller than any plausible resize target, and
 * resizing one up would spend memory to add nothing.
 */
async function loadDrawable(p, o, scale) {
  if (!p.src) return null;
  if (typeof createImageBitmap === "function" && typeof fetch === "function") {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), Math.max(1, o.imageTimeoutMs));
      const onAbort = () => ctl.abort();
      if (o.signal) o.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(p.src, { credentials: "same-origin", signal: ctl.signal });
        if (!res.ok) return null;
        const blob = await res.blob();
        if (p.srcTier === "original") {
          // The width this photograph is actually drawn at, in EXPORT PIXELS. Capped so a
          // pathological scale cannot ask for a bitmap bigger than the canvas it lands on.
          const want = clamp(Math.ceil(p.photo.w * (scale || 1)), 1, MAX_CANVAS_EDGE);
          try {
            return await createImageBitmap(blob, { resizeWidth: want, resizeQuality: "high" });
          } catch { /* engine without the options bag; fall through to a plain decode */ }
        }
        return await createImageBitmap(blob);
      } finally {
        clearTimeout(t);
        if (o.signal) o.signal.removeEventListener("abort", onAbort);
      }
    } catch { return null; }
  }
  return loadImage(p.src, o.imageTimeoutMs, o.signal);
}

const release = (img) => { if (img && typeof img.close === "function") img.close(); };

/**
 * Load every planned source with a bounded number in flight. Resolves to a Map url -> image,
 * with a null for anything that could not be had; never rejects, because a missing thumb is an
 * offline board and not a failed export.
 *
 * The partner to paintPlan(), for a caller that wants the images in hand — a preview that
 * re-paints, a test. renderCollage() deliberately does NOT use it: this holds every decoded
 * image at once, which is exactly what a 500-print board on a phone cannot afford.
 */
export async function loadPlanImages(plan, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const report = typeof o.onProgress === "function" ? o.onProgress : () => {};
  const out = new Map();
  let done = 0;
  const total = plan.items.length;
  report({ phase: "loading", loaded: 0, total });
  plan.cork = await corkFor(plan, o);
  const width = Math.max(1, o.concurrency | 0);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, total) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      if (o.signal && o.signal.aborted) return;
      const p = plan.items[i];
      if (!out.has(p.src)) out.set(p.src, await loadDrawable(p, o, plan.scale));
      done++;
      report({ phase: "loading", loaded: done, total });
    }
  }));
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Painting
// ══════════════════════════════════════════════════════════════════════════════════════════

// The app's own tokens, read off the live document so the export follows whatever theme the
// user is actually in, with styles.css's values as the fallback for a detached render. Only
// the three surfaces canvas needs and CSS cannot hand it: the empty well, the offline tray's
// rule, and its glyph ink.
const TOKEN_FALLBACK = {
  light: { well: "#ece4d6", line: "#8a7e66", ink3: "#665f4a" },
  dark: { well: "#272320", line: "#7a7163", ink3: "#978d7e" },
};
function tokens(theme) {
  const fb = TOKEN_FALLBACK[theme] || TOKEN_FALLBACK.light;
  if (typeof getComputedStyle !== "function" || typeof document === "undefined") return fb;
  try {
    const cs = getComputedStyle(document.documentElement);
    const pick = (name, d) => (cs.getPropertyValue(name) || "").trim() || d;
    // Only trust the live tokens when the document's theme is the theme being exported —
    // exporting a light picture out of a dark app must not pick up dark surfaces.
    if (resolveTheme() !== theme) return fb;
    return {
      well: pick("--surface-2", fb.well),
      line: pick("--line-strong", fb.line),
      ink3: pick("--ink-3", fb.ink3),
    };
  } catch { return fb; }
}

// memories.js's offline glyph — the app's one shape for "not downloaded yet", restated here in
// its 24x24 viewBox because a canvas cannot use an <svg> the way the DOM renderer does. Same
// path data as collage.js's G_MISS; if that vocabulary changes, both move together.
const MISS_PATH = "M12 4.2v9.2 M8.4 10.2l3.6 3.2 3.6-3.2 " +
  "M4.6 16.4v1.8a1.6 1.6 0 0 0 1.6 1.6h1M10.6 19.8h2.8M16.8 19.8h1a1.6 1.6 0 0 0 1.6-1.6v-1.8";

// The app's offline dash: 9px on, 6px off (styles.css's .netline pattern). A dashed SHAPE, not
// a hue — state is never signalled by hue alone.
const MISS_DASH = [9, 6];

/**
 * Would drawFrame()'s caption land at 12 export pixels or more?
 *
 * Minimum caption size is 12px and a caption is not exempt just because it lives
 * inside a picture — illegible grey mush at 5px defeats having captions, and
 * never quieting text with opacity serves the same goal. collage.js makes exactly this call
 * on screen (`data-cap="off"` once CAP_PX * k drops under 12); the export's `scale` is the same
 * kind of number as the camera's `k`, so it makes it the same way. Below the floor a polaroid
 * keeps its foot and loses the writing, which is what a real print with a faded caption looks
 * like anyway.
 *
 * The font expression is drawFrame()'s own, restated because it is computed inside the draw
 * call and cannot be asked for. If that sizing changes, this moves with it.
 */
export const CAPTION_MIN_PX = 12;
function captionFits(frame, outerW, scale) {
  const foot = outerW * FRAMES[frame].pads.bottom;
  return Math.max(12, Math.round(foot * 0.34)) * scale >= CAPTION_MIN_PX;
}

/** Cover-crop the source rect: the exact arithmetic CSS `object-fit: cover` performs, with
 *  `object-position: focal.x*100% focal.y*100%`. The layout guarantees w/h === aspect, so this
 *  can neither distort nor letterbox whatever the source turns out to be. */
function coverRect(img, dw, dh, focal, zoom) {
  // naturalWidth for an <img>, videoWidth for a <video>, width for an ImageBitmap. A video's
  // `.width` is the ATTRIBUTE (0 unless set), so it must not be reached before videoWidth.
  const sw0 = img.naturalWidth || img.videoWidth || img.width;
  const sh0 = img.naturalHeight || img.videoHeight || img.height;
  const want = dw / dh;
  const have = sw0 / sh0;
  let sw = sw0, sh = sh0, sx = 0, sy = 0;
  const fx = clamp(focal.x, 0, 1), fy = clamp(focal.y, 0, 1);
  if (have > want) { sw = sh0 * want; sx = (sw0 - sw) * fx; }
  else if (have < want) { sh = sw0 / want; sy = (sh0 - sh) * fy; }
  // ZOOM shrinks the source window about the focal point — the exact twin of the DOM's
  // `transform: scale(z)` with `transform-origin` at the same point. Doing it here rather than
  // scaling the destination keeps every pixel the export draws a real source pixel.
  const z = Number(zoom) > 1 ? Math.min(8, Number(zoom)) : 1;
  if (z > 1) {
    const cx = sx + sw * fx, cy = sy + sh * fy;
    sw /= z; sh /= z;
    sx = clamp(cx - sw * fx, 0, Math.max(0, sw0 - sw));
    sy = clamp(cy - sh * fy, 0, Math.max(0, sh0 - sh));
  }
  return { sx, sy, sw, sh };
}

/** The not-downloaded tray, clipped to the frame's own window. Shape only. */
function drawMissing(ctx, r, tk) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.fillStyle = tk.well;
  ctx.fillRect(r.x, r.y, r.w, r.h);

  const inset = 6;
  ctx.strokeStyle = tk.line;
  ctx.lineWidth = 2;
  ctx.setLineDash(MISS_DASH);
  ctx.strokeRect(r.x + inset, r.y + inset, Math.max(0, r.w - inset * 2), Math.max(0, r.h - inset * 2));
  ctx.setLineDash([]);

  // 26 canvas units, the same size collage.css gives .cg-missmark .ico, but never wider than
  // half the window — a tiny print gets a smaller glyph rather than a glyph over its edges.
  const g = Math.min(26, r.w * 0.5, r.h * 0.5);
  if (g > 6 && typeof Path2D === "function") {
    ctx.translate(r.x + r.w / 2 - g / 2, r.y + r.h / 2 - g / 2);
    ctx.scale(g / 24, g / 24);
    ctx.strokeStyle = tk.ink3;
    ctx.lineWidth = 1.7;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke(new Path2D(MISS_PATH));
  }
  ctx.restore();
}

/** The video play disc — off by default, see DEFAULTS.playBadge. Dark disc, white ring inside,
 *  dark hairline outside: it reads by SHAPE over a bright sky and over a shadow alike. */
function drawPlay(ctx, r) {
  const d = Math.min(44, r.w * 0.42, r.h * 0.42);
  if (d < 12) return;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rad = d / 2;
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(12,10,8,.5)"; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = "rgba(0,0,0,.38)"; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, rad - 1.5, 0, Math.PI * 2);
  ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,255,255,.94)"; ctx.stroke();
  const t = rad * 0.46;
  ctx.beginPath();
  ctx.moveTo(cx - t * 0.62, cy - t);
  ctx.lineTo(cx - t * 0.62, cy + t);
  ctx.lineTo(cx + t * 0.9, cy);
  ctx.closePath();
  ctx.fillStyle = "#fff"; ctx.fill();
  ctx.restore();
}

/**
 * Paint a planned export onto a 2D context. Exported so a caller with its own canvas (a
 * preview tile, a test harness) can reuse the renderer without owning the encode.
 *
 * The context is left as it was found.
 */
// The cork photograph (BOARD_LOOK.cork), loaded once and kept: every export of a corkboard draws it.
let corkImage = null;
async function corkFor(plan, o) {
  if (plan.background !== "corkboard" || !o.ground) return null;
  if (!corkImage) corkImage = await loadImage(BOARD_LOOK.cork.url, numOr(o.timeoutMs, 8000), o.signal);
  return corkImage;
}

/** The wall, and the board hanging on it: its shadow, its material, its edge. The same board the app draws
 *  (collage.js .cg-board, from the same BOARD_LOOK), at the export's own scale. */
function paintBackdrop(ctx, plan, o) {
  const t = plan.theme, s = plan.scale, B = plan.board, key = plan.background;
  ctx.fillStyle = BOARD_LOOK.wall[t] || BOARD_LOOK.wall.light;
  ctx.fillRect(0, 0, plan.width, plan.height);
  if (!B) return;
  // The lamp's pool on the wall, centred on the board (BOARD_LOOK.pool), as in the app.
  {
    const R = (BOARD_LOOK.pool.size * Math.max(B.w, B.h)) / 2, cx = B.x + B.w / 2, cy = B.y + B.h / 2;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, BOARD_LOOK.pool[t] || BOARD_LOOK.pool.light);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, plan.width, plan.height);
  }
  const spec = BOARD_LOOK.frame[key] || { kind: "line", width: 2 };
  const radius = spec.kind === "enamel" ? (spec.radius || 0) * s : 0;
  const shape = () => {
    ctx.beginPath();
    if (radius && ctx.roundRect) ctx.roundRect(B.x, B.y, B.w, B.h, radius); else ctx.rect(B.x, B.y, B.w, B.h);
  };
  // One soft shadow on the wall (the app's two box-shadows, folded into one blur).
  ctx.save();
  ctx.shadowColor = t === "dark" ? "rgba(0,0,0,.62)" : "rgba(40,30,20,.28)";
  ctx.shadowBlur = (t === "dark" ? 48 : 36) * s;
  ctx.shadowOffsetY = (t === "dark" ? 18 : 14) * s;
  shape();
  ctx.fillStyle = GROUNDS[key].base[t];
  ctx.fill();
  ctx.restore();
  // At Night, the thin lit rim just outside the board's edge (BOARD_LOOK.rim; the shadow can't show on the wall).
  if (t === "dark" && BOARD_LOOK.rim && BOARD_LOOK.rim.dark) {
    ctx.save();
    const rw = Math.max(1, s);
    ctx.lineWidth = rw;
    ctx.strokeStyle = BOARD_LOOK.rim.dark;
    ctx.beginPath();
    if (radius && ctx.roundRect) ctx.roundRect(B.x - rw / 2, B.y - rw / 2, B.w + rw, B.h + rw, radius + rw / 2);
    else ctx.rect(B.x - rw / 2, B.y - rw / 2, B.w + rw, B.h + rw);
    ctx.stroke();
    ctx.restore();
  }
  // The material, inside the board's shape.
  ctx.save();
  shape();
  ctx.clip();
  const cork = key === "corkboard" ? plan.cork : null;
  if (cork) {
    const pat = ctx.createPattern(cork, "repeat");
    const f = (corkTileOf(plan.boardUnits) * s) / (cork.naturalWidth || cork.width);
    if (pat.setTransform && typeof DOMMatrix === "function") pat.setTransform(new DOMMatrix([f, 0, 0, f, B.x, B.y]));
    ctx.fillStyle = pat;
    ctx.fillRect(B.x, B.y, B.w, B.h);
    if (t === "dark") { ctx.fillStyle = BOARD_LOOK.cork.night; ctx.fillRect(B.x, B.y, B.w, B.h); }
  } else if (o.ground) {
    paintGround(ctx, key, B.x, B.y, B.w, B.h, t, s);
  }
  ctx.restore();
  // The edge, drawn inside the board as the app's border is: a wooden frame, an edge line, or enamel's fine line.
  // The wood frame grows with the board (BOARD_LOOK.frameFrac); the other edges keep their width in board units, so
  // the picture, seen whole, shows them as the app does with the board fitted.
  const U = plan.boardUnits;
  const w = (spec.kind === "wood" ? woodOf(U) : Math.max(spec.width || 1, 2)) * s;
  ctx.save();
  ctx.lineWidth = w;
  ctx.strokeStyle = spec.kind === "wood" ? BOARD_LOOK.wood[t] : spec.kind === "enamel" ? BOARD_LOOK.enamel[t] : BOARD_LOOK.line[t];
  ctx.beginPath();
  if (radius && ctx.roundRect) ctx.roundRect(B.x + w / 2, B.y + w / 2, B.w - w, B.h - w, Math.max(0, radius - w / 2));
  else ctx.rect(B.x + w / 2, B.y + w / 2, B.w - w, B.h - w);
  ctx.stroke();
  if (spec.kind === "wood") {
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeStyle = BOARD_LOOK.woodInner;
    ctx.strokeRect(B.x + w, B.y + w, B.w - 2 * w, B.h - 2 * w);
  }
  ctx.restore();
}

/** ONE print. The single place an item is painted — both the streaming renderer and the
 *  paintPlan() convenience path go through here, so they cannot draw different pictures. */
function drawItem(ctx, plan, p, img, o, tk) {
  const { scale, theme } = plan;
  // Rotate about the FRAME BOX CENTRE — the origin collage-layout.js's bounds, occlusion
  // solver and hit test all assume, and the one CSS gives for free with transform-origin
  // 50% 50% on an element whose box is the frame box.
  ctx.save();
  ctx.translate(p.cx, p.cy);
  if (p.rot) ctx.rotate(p.rot * DEG);
  ctx.scale(scale, scale);
  ctx.translate(-p.canvas.w / 2, -p.canvas.h / 2);

  // The frame's look comes out of the registry, never from a copy of it here. drawFrame()
  // returns the media window, which by construction equals the layout's photo box.
  const caption = FRAMES[p.frame].caption && typeof o.captionFor === "function"
    && captionFits(p.frame, p.canvas.w, scale)
    ? o.captionFor(p.item) : "";
  const media = drawFrame(ctx, p.frame, p.canvas.w, p.canvas.h, {
    theme, scale, caption: caption || "",
  });

  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(media.x, media.y, media.w, media.h);
    ctx.clip();
    const c = coverRect(img, media.w, media.h, p.focal, p.zoom);
    ctx.drawImage(img, c.sx, c.sy, c.sw, c.sh, media.x, media.y, media.w, media.h);
    ctx.restore();
    if (p.kind === "video" && o.playBadge) drawPlay(ctx, media);
  } else if (o.showMissing) {
    drawMissing(ctx, media, tk);
  } else {
    ctx.fillStyle = tk.well;
    ctx.fillRect(media.x, media.y, media.w, media.h);
  }

  // THE FASTENER, last, so it sits over the print it is holding. Twin of paintFastener() in
  // collage.js: same geometry function, same hash, same counter-rotation.
  //
  // THE COUNTER-ROTATION IS THE POINT. We are inside the item's transform, which has already
  // rotated by p.rot; rotating back by -p.rot at the head's centre leaves the specular pointing
  // at the top of the room instead of the top of the photograph. A tack lit by the picture it
  // holds is the uncanny middle in one move.
  //
  // `scale` is passed through because canvas shadows ignore the CTM — the same reason
  // drawFrame() takes it.
  const fkind = fastenerFor(plan.background);
  if (fkind) {
    const geo = fastenerGeometry(fkind, { w: p.canvas.w, h: p.canvas.h }, fastHash(plan.seed, p.id));
    const pal = fkind === "magnet" ? FASTENERS.MAGNETS : FASTENERS.TACKS;
    const draw = fkind === "magnet" ? FASTENERS.drawMagnet : FASTENERS.drawTack;
    const set = pal[theme] || pal.light;
    ctx.save();
    ctx.translate(geo.left + geo.d / 2, geo.top + geo.d / 2);
    if (p.rot) ctx.rotate(-p.rot * DEG);
    draw(ctx, 0, 0, geo.d, set[geo.variant % set.length], theme, scale);
    ctx.restore();
  }
  ctx.restore();
}


/**
 * Paint a planned export onto a 2D context from a Map of already-loaded images. Exported so a
 * caller with its own canvas (a preview tile, a test harness) can reuse the renderer without
 * owning the encode. renderCollage() does NOT use this — it streams, so that a 500-print board
 * never holds 500 decoded images at once.
 *
 * The context is left as it was found.
 */
export function paintPlan(ctx, plan, images, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const tk = tokens(plan.theme);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  paintBackdrop(ctx, plan, o);
  for (const p of plan.items) drawItem(ctx, plan, p, images && p.src ? images.get(p.src) : null, o, tk);
  ctx.restore();
  return plan;
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Render + encode
// ══════════════════════════════════════════════════════════════════════════════════════════

class AbortedError extends Error {
  constructor() { super("export aborted"); this.name = "AbortError"; }
}
const checkAbort = (o) => { if (o.signal && o.signal.aborted) throw new AbortedError(); };

/**
 * Render a Layout to a canvas. Nothing is encoded — the caller gets the pixels and decides.
 *
 * @returns {Promise<{canvas:HTMLCanvasElement, plan:object, width:number, height:number,
 *                    scale:number, missing:string[], drawn:number}>}
 */
export async function renderCollage(layout, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const report = typeof o.onProgress === "function" ? o.onProgress : () => {};
  report({ phase: "planning" });

  const plan = planExport(layout, o);
  checkAbort(o);

  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("no 2d context");
  const tk = tokens(plan.theme);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  plan.cork = await corkFor(plan, o);
  paintBackdrop(ctx, plan, o);

  // ── the streaming pass ──────────────────────────────────────────────────────────────────
  // Prints are painted in z order, so they cannot be drawn out of order; but they CAN be
  // fetched out of order. A sliding window of `concurrency` decodes runs ahead of the brush,
  // and each bitmap is closed the instant its print is down. Peak memory is therefore the
  // window, not the board: ~5 MB for six thumbs, and flat whether the board holds 12 prints
  // or 500. "Load everything, then paint" was 350 MB+ at 500 prints, which is a phone dying
  // at the exact moment somebody tries to share their trip.
  const n = plan.items.length;
  const win = Math.max(1, Math.min(o.concurrency | 0 || 1, n));
  const inflight = new Map();
  const start = (i) => { if (i < n && !inflight.has(i)) inflight.set(i, loadDrawable(plan.items[i], o, plan.scale)); };
  for (let i = 0; i < win; i++) start(i);

  const missing = [];
  report({ phase: "drawing", loaded: 0, total: n });
  for (let i = 0; i < n; i++) {
    if (o.signal && o.signal.aborted) {
      // Let the window drain before throwing, so nothing is left decoding into a canvas that
      // is about to be dropped.
      for (const pr of inflight.values()) release(await pr.catch(() => null));
      throw new AbortedError();
    }
    const p = plan.items[i];
    const img = await inflight.get(i).catch(() => null);
    inflight.delete(i);
    start(i + win);
    if (!img && p.src) missing.push(p.id);
    drawItem(ctx, plan, p, img, o, tk);
    release(img);
    if ((i & 15) === 15 || i === n - 1) report({ phase: "drawing", loaded: i + 1, total: n });
  }

  return {
    canvas, plan,
    width: plan.width, height: plan.height, scale: plan.scale,
    missing, drawn: n,
  };
}

// Not every engine encodes every type, and a silent fallback to PNG would hand a 20 MB file to
// a share sheet without saying so. Probe once, per type.
const typeCache = new Map();
function supportsType(type) {
  if (typeCache.has(type)) return typeCache.get(type);
  let ok = false;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    ok = c.toDataURL(type).startsWith("data:" + type);
  } catch { ok = false; }
  typeCache.set(type, ok);
  return ok;
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== "function") { reject(new Error("toBlob unavailable")); return; }
    canvas.toBlob((b) => {
      // toBlob(null) is how a canvas over the platform's limits fails. It is not a throw and it
      // must not become a silent black rectangle in somebody's camera roll.
      b ? resolve(b) : reject(new Error("canvas could not be encoded (over a platform limit?)"));
    }, type, quality);
  });
}

const EXT_OF = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function fileNameFor(o, type) {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${o.name}-${day}.${EXT_OF[type] || "jpg"}`;
}

/**
 * The whole export: render, encode, wrap in a File.
 *
 * @returns {Promise<{blob:Blob, file:File, canvas:HTMLCanvasElement, plan:object,
 *                    width:number, height:number, scale:number, bytes:number,
 *                    type:string, name:string, missing:string[]}>}
 */
export async function exportCollage(layout, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const report = typeof o.onProgress === "function" ? o.onProgress : () => {};
  const r = await renderCollage(layout, o);
  checkAbort(o);

  let type = o.type;
  if (!supportsType(type)) type = supportsType("image/jpeg") ? "image/jpeg" : "image/png";
  report({ phase: "encoding", type });

  const blob = await toBlob(r.canvas, type, o.quality);
  const name = fileNameFor(o, type);
  const file = new File([blob], name, { type, lastModified: Date.now() });
  report({ phase: "done", bytes: blob.size, width: r.width, height: r.height });

  return {
    blob, file, canvas: r.canvas, plan: r.plan,
    width: r.width, height: r.height, scale: r.scale,
    bytes: blob.size, type, name, missing: r.missing,
  };
}


// ══════════════════════════════════════════════════════════════════════════════════════════
// THE LOOPING VIDEO EXPORT
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// Renders the collage board out for download, either as a
// still image or as a looping video (playing each embedded clip). Without
// video export, a board full of
// clips rendered as motionless posters.
//
// THE STATIC PLATE IS DRAWN ONCE. A board can hold hundreds of prints, and redrawing all of
// them thirty times a second to animate three clips would cost the whole frame budget on the
// prints that never change. So renderCollage() paints the board exactly as the still export
// does — every photograph, every frame, every fastener — and each recorded frame is that one
// bitmap blitted, plus a redraw of ONLY the items that move. Cost is O(videos), not O(board).
//
// EACH CLIP PLAYS ITS OWN LOOP WINDOW, the same one the board plays on screen: the trim if
// somebody set one, otherwise the window collage-layout.js dealt it: the trim picks
// a short excerpt to loop inside the board.
//
// THE OUTPUT IS DOWNSCALED AND EVEN. Downscaling keeps export lighter and avoids memory
// spikes during encoding, and codecs require it: H.264 rejects odd
// dimensions outright, and a 4096px board is a phone running out of memory mid-record.
const VIDEO_DEFAULTS = {
  longEdge: 1080,     // cap. A looping board is watched on a phone, not graded on a monitor.
  fps: 30,
  seconds: 0,         // 0 = derive from the longest loop window on the board
  minSeconds: 2,
  maxSeconds: 12,
  bitsPerSecond: 6_000_000,
};

/** What this browser will actually record. mp4 first: it is the one an iPhone can save. */
export function videoExportType() {
  if (typeof MediaRecorder === "undefined") return "";
  const want = [
    'video/mp4;codecs="avc1.42E01E"',
    "video/mp4",
    'video/webm;codecs="vp9"',
    'video/webm;codecs="vp8"',
    "video/webm",
  ];
  for (const t of want) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* older */ } }
  return "";
}

export const canExportVideo = () => !!videoExportType();

/**
 * Render the board as a looping clip.
 *
 * Returns the same shape as exportCollage() so a caller can treat the two interchangeably:
 * { blob, file, width, height, seconds, type, name }.
 */
export async function exportCollageVideo(layout, opts = {}) {
  const o = Object.assign({}, DEFAULTS, VIDEO_DEFAULTS, opts);
  const report = typeof o.onProgress === "function" ? o.onProgress : () => {};
  const type = videoExportType();
  if (!type) throw new Error("this browser cannot record video");

  report({ phase: "planning" });
  // Plan at the VIDEO's size, not the still's: targetLongEdge drives planExport, and recording
  // a 4096px canvas is how a phone dies halfway through sharing a trip.
  const still = await renderCollage(layout, Object.assign({}, o, {
    targetLongEdge: o.longEdge, playBadge: false,
  }));
  checkAbort(o);

  // EVEN DIMENSIONS. H.264 refuses odd ones, and the failure is an empty file rather than an
  // error — the single most annoying way for this to go wrong.
  const W = Math.max(2, still.width - (still.width % 2));
  const H = Math.max(2, still.height - (still.height % 2));
  const plan = still.plan;
  const videos = plan.items.filter((p) => p.kind === "video" && p.origUrl);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("no 2d context");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const tk = tokens(plan.theme);

  // ── the clips ───────────────────────────────────────────────────────────────────────────
  report({ phase: "loading", videos: videos.length });
  const els = new Map();
  await Promise.all(videos.map((p) => new Promise((res) => {
    const v = document.createElement("video");
    v.muted = true;                 // a muted video is the only kind that may autoplay
    v.playsInline = true;
    v.preload = "auto";
    v.crossOrigin = "anonymous";
    v.src = p.origUrl;
    const startS = Math.max(0, (p.loopStartMs || 0) / 1000);
    const done = () => { els.set(p.id, { el: v, start: startS, len: Math.max(0.2, (p.loopMs || 0) / 1000 || 4) }); res(); };
    // A clip that will not load must not take the whole export down with it — it simply keeps
    // the poster the plate already has under it.
    v.addEventListener("error", () => res(), { once: true });
    v.addEventListener("loadeddata", () => {
      try { v.currentTime = startS; } catch { /* not seekable yet */ }
      done();
    }, { once: true });
    setTimeout(() => res(), 8000);
  })));
  checkAbort(o);

  // ── how long the loop is ────────────────────────────────────────────────────────────────
  // The longest window on the board, so no clip is cut mid-motion. Clamped at both ends: under
  // two seconds reads as a glitch, over twelve is a file nobody sends.
  let seconds = Number(o.seconds) || 0;
  if (!seconds) {
    let longest = 0;
    for (const { len } of els.values()) longest = Math.max(longest, len);
    seconds = longest || 5;
  }
  seconds = Math.min(o.maxSeconds, Math.max(o.minSeconds, seconds));

  // ── record ──────────────────────────────────────────────────────────────────────────────
  const stream = canvas.captureStream(o.fps);
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: o.bitsPerSecond });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });

  for (const { el, start } of els.values()) {
    try { el.currentTime = start; await el.play(); } catch { /* a clip that will not play keeps its poster */ }
  }

  report({ phase: "recording", seconds, videos: els.size });
  rec.start();
  const t0 = performance.now();
  let frames = 0;
  await new Promise((res) => {
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      if (t >= seconds) return res();
      if (o.signal && o.signal.aborted) return res();
      // The plate, then only what moves.
      ctx.drawImage(still.canvas, 0, 0, W, H);
      for (const p of videos) {
        const rec2 = els.get(p.id);
        if (!rec2 || rec2.el.readyState < 2) continue;
        // Hold each clip inside its own window. `loop` on the element would restart from 0.
        const rel = rec2.el.currentTime - rec2.start;
        if (rel < -0.05 || rel > rec2.len) {
          try { rec2.el.currentTime = rec2.start; } catch { /* seeking */ }
        }
        try { drawItem(ctx, plan, p, rec2.el, o, tk); } catch { /* one bad frame is not the export */ }
      }
      frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  rec.stop();
  await stopped;
  for (const { el } of els.values()) { try { el.pause(); el.removeAttribute("src"); el.load(); } catch { /* gone */ } }

  const blob = new Blob(chunks, { type });
  const ext = /mp4/.test(type) ? "mp4" : "webm";
  const name = fileNameFor(o, type).replace(/\.[a-z0-9]+$/i, "") + "." + ext;
  const file = new File([blob], name, { type, lastModified: Date.now() });
  report({ phase: "done", bytes: blob.size, seconds, frames });

  return {
    blob, file, canvas, plan,
    width: W, height: H, seconds, frames, fps: o.fps,
    bytes: blob.size, type, name, videos: els.size, missing: still.missing,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Handing it to the share sheet — memories-save.js's plumbing, one file instead of many
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// What is REUSED from memories-save.js and deliberately not re-implemented:
//   * shareCapability() / canSaveToPhotos() — the measured probe, one answer app-wide
//   * the gesture rule: navigator.share() is reached with no await in front of it
//   * the status vocabulary and the cancel semantics (AbortError is a dismissal, not a failure)
//
// What is NOT reused, and why: createSaveSession()/downloadBatch() fetch ORIGINALS out of R2 by
// key and length-check them against the media row. An export is one derived Blob that is
// already in memory and has no key, no row and no recorded length, so there is nothing for
// that path to fetch or verify. The batching does not apply either — one file is always one
// sheet and one tap. (The one-line fix that would remove even this much duplication is to
// export `dropAnchor` and a `shareFiles(files, opts)` from memories-save.js; that file is
// fenced to another session, so it is named here rather than edited.)

/** True when Share ends in the OS sheet. False means the caller must say "download", not
 *  "save to Photos" — memories-save.js's rule, and it binds here too. */
export const canShareImage = () => canSaveToPhotos();
export { shareCapability };

function classify(e) {
  if (!e) return "error";
  if (e.name === "AbortError") return "cancelled";
  return "error";
}

/**
 * Open the share sheet for one exported image.
 *
 * NOT an async function, and that is load-bearing: Safari spends transient user activation on
 * the first await, so an async wrapper makes navigator.share() throw NotAllowedError on exactly
 * the browser this feature exists for. Call it directly from the click handler with a result
 * that is already rendered.
 *
 * @param {{file:File}} result  from exportCollage()
 * @returns {Promise<{status:'shared'|'cancelled'|'error'|'unsupported', error?:Error}>}
 */
export function shareExport(result, opts = {}) {
  const file = result && result.file;
  if (!file) return Promise.resolve({ status: "error", error: new Error("nothing to share") });
  if (!canSaveToPhotos())
    return Promise.resolve({ status: "unsupported", error: new Error(shareCapability().reason) });
  // Re-check against the ACTUAL file: the probe proved a 4-byte JPEG can be shared, which says
  // nothing about a 12 MB one.
  if (typeof navigator.canShare === "function" && !navigator.canShare({ files: [file] }))
    return Promise.resolve({ status: "unsupported", error: new Error("canShare refused this file") });

  const payload = { files: [file] };
  if (opts.title) payload.title = opts.title;
  if (opts.text) payload.text = opts.text;

  let p;
  try { p = navigator.share(payload); }        // <- must be the first thing the gesture reaches
  catch (e) { return Promise.resolve({ status: classify(e), error: e }); }

  return p.then(
    // Resolved means the sheet was acted on. It does NOT mean "Save Image" specifically — iOS
    // resolves the same way for AirDrop or Messages. No caller may claim more than that.
    () => ({ status: "shared" }),
    (e) => ({ status: classify(e), error: e }),
  );
}

/** The path for browsers with no file share (Firefox, Chrome on Linux, any headless run): the
 *  browser's download folder, not Photos. Label it as a download; saying "Photos" here is a
 *  lie. Mirrors memories-save.js's dropAnchor(), including the 250ms revoke delay — revoking
 *  synchronously races WebKit's own read of the blob. */
export function downloadExport(result) {
  const file = result && result.file;
  if (!file) return Promise.reject(new Error("nothing to download"));
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  a.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px";
  document.body.appendChild(a);
  a.click();
  return new Promise((r) => setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
    r({ status: "downloaded", name: file.name, bytes: file.size });
  }, 250));
}

/**
 * A share in progress, shaped exactly like memories-save.js's createSaveSession() so the UI
 * that drives one drives the other.
 *
 *   const s = createExportSession(layout, { onProgress: render });
 *   button.textContent = s.supported ? "Share" : "Download";
 *   button.onclick = () => s.saveNext().then((r) => {
 *     if (r.status === "ready") return;       // rendered; the NEXT tap opens the sheet
 *     if (r.status === "cancelled") return;   // dismissed; the same image is still primed
 *     if (r.status === "error") show(r.error.message);
 *   });
 *
 * `prewarm()` turns that into a single tap: call it when the collage view settles and the
 * image is already encoded by the time anyone reaches for Share.
 */
export function createExportSession(layout, opts = {}) {
  const cap = shareCapability();
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  let controller = null;
  let primed = null;       // the rendered result for the CURRENT layout
  let priming = null;
  let current = layout;
  let cancelled = false;

  const emit = (phase, extra) => onProgress(Object.assign({ phase }, extra || {}));

  function prepare() {
    if (primed) return Promise.resolve(primed);
    if (priming) return priming;
    controller = new AbortController();
    const p = exportCollage(current, Object.assign({}, opts, {
      signal: controller.signal,
      onProgress: (e) => onProgress(e),
    })).then((out) => { primed = out; priming = null; return out; },
      (e) => { priming = null; throw e; });
    priming = p;
    return p;
  }

  return {
    capability: cap,
    supported: cap.files,
    /** True when the next tap opens the sheet rather than starting a render. */
    get ready() { return !!primed; },
    /** The rendered export, once there is one: {blob, file, canvas, plan, ...}. */
    get result() { return primed; },
    /** Swap the Layout (a re-roll, a new photo). Discards the primed image — it is a picture
     *  of an arrangement that no longer exists. */
    setLayout(next) {
      if (next === current) return;
      current = next;
      primed = null;
      priming = null;
      if (controller) controller.abort();
      controller = null;
    },
    /** Render + encode without sharing. Safe to call repeatedly; the second call is a no-op. */
    prewarm: () => prepare().then(() => ({ status: "ready" }), (e) => ({ status: classify(e), error: e })),
    /** The click handler. Not async on purpose — see shareExport(). */
    saveNext(shareOpts) {
      if (cancelled) return Promise.resolve({ status: "error", error: new Error("session aborted") });
      if (!cap.files) {
        // No share sheet anywhere in this browser: render if needed, then download. There is no
        // gesture rule on a download, so a single tap can do the whole thing.
        return prepare().then(downloadExport, (e) => ({ status: classify(e), error: e }));
      }
      if (primed) return shareExport(primed, Object.assign({}, opts, shareOpts));
      return prepare().then(
        (out) => ({ status: "ready", bytes: out.bytes, width: out.width, height: out.height }),
        (e) => ({ status: classify(e), error: e }),
      );
    },
    /** Stop an in-flight render. The session cannot be reused afterwards. */
    abort() {
      cancelled = true;
      if (controller) controller.abort();
      primed = null;
      priming = null;
      emit("aborted");
    },
  };
}

/**
 * One call for a caller that does not want to branch: share where there is a sheet, download
 * where there is not. NOTE the gesture rule — on the share path this only works when the
 * caller has already prewarmed, so `createExportSession` is the better entry for a button.
 */
export async function saveCollage(layout, opts = {}) {
  const out = await exportCollage(layout, opts);
  if (!canSaveToPhotos()) return Object.assign({ export: out }, await downloadExport(out));
  return Object.assign({ export: out }, await shareExport(out, opts));
}

export default {
  EXPORT_VERSION, DEFAULTS, MAX_CANVAS_PIXELS, MAX_CANVAS_EDGE,
  planExport, itemRects, paintPlan, loadPlanImages,
  renderCollage, exportCollage,
  createExportSession, shareExport, downloadExport, saveCollage,
  canShareImage, shareCapability,
};

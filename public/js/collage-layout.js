// collage-layout.js — the Memories collage: LAYOUT ONLY. Pure data, zero DOM.
//
// Separate LAYOUT (pure data) from RENDERING. This file is the
// layout half and it is the whole layout half: nothing about placement may live inside a
// renderer. `collage.js` (interactive), `collage-export.js` (canvas), `collage-frames.js`
// (frame/background registry) and `collage-video.js` all consume the `Layout` this returns
// and none of them may compute a position, a size, a rotation or a frame key of their own.
//
// Its imports are two leaves of values in ./shared/ (board-look.js: the grounds and how the board looks; fasteners.js). It touches no `document`, no `window`, no `navigator`, and runs unmodified
// in plain node (Node >= 22 detects the ESM syntax in a bare `.js`; this repo has no
// package.json). `scripts/collage_layout_test.mjs` is its test.
//
// ── THE CONTRACT (layout item shape, plus documented additive fields) ─────────────────────
//
//   LayoutItem = {
//     id, memoryId, mediaId,
//     kind: 'photo' | 'video',
//     x, y,                 // top-left of the PHOTO box, canvas units (CSS px at zoom 1),
//                           //   UNROTATED. See "GEOMETRY, STATED ONCE" below.
//     w, h,                 // rendered size of the PHOTO box, canvas units
//     rot,                  // degrees, deterministic, about the FRAME box centre
//     z,                    // stable paint order, 0..n-1, ascending = painted later = on top
//     frame,                // 'polaroid' | 'print' | 'bare'   (see FRAMES)
//     thumbUrl, origUrl,    // LOD sources
//     aspect,               // source aspect (w/h). w/h === aspect to within quantisation.
//     loopStartMs, loopMs,  // video only (0 for photos)
//     // ── additive, derived, safe to ignore; provided so every renderer agrees ──
//     frameBox: { dx, dy, w, h },   // frame outer box relative to (x, y). dx/dy are <= 0.
//     focal: { x, y },              // focal point in item-local 0..1 space (default .5/.5)
//     durationMs,                   // source duration, video only
//     mime, bytes
//   }
//   Layout = { items: [], bounds: {minX,minY,maxX,maxY}, seed, background, version, stats }
//
// ── GEOMETRY, STATED ONCE — read this before writing a renderer ───────────────────────────
//
// `x, y, w, h` describe the PHOTO, not the frame. `w / h` equals `aspect` to within
// quantisation (< 0.1%), which is the whole point: a renderer that sizes the photo box to
// `w x h` and paints with `object-fit: cover` can neither distort nor letterbox, whatever
// the source is. Never size a photo from a frame's box.
//
// The FRAME is bigger than the photo (a polaroid has a foot). `frameBox` gives its offset and
// size relative to `(x, y)`, and `frameMetrics(frame, w, h)` recomputes the same numbers.
// `collage-frames.js` holds the same model in `FRAMES[key].pads`, and the test asserts the two
// agree to floating point — a renderer painting a wider frame than the layout budgeted for
// pushes the outermost print outside the camera clamp, where it can never be scrolled to.
// PREFER `item.frameBox`: it is the number the solver and `bounds` actually used.
// Recommended DOM shape:
//
//     el.style.transform = `translate(${x + frameBox.dx}px, ${y + frameBox.dy}px) rotate(${rot}deg)`
//     el.style.width  = frameBox.w + 'px'
//     el.style.height = frameBox.h + 'px'
//     img.style.inset = `${-frameBox.dy}px ... ${-frameBox.dx}px`   // i.e. the frame padding
//
// ROTATION IS ABOUT THE FRAME BOX CENTRE — which is CSS's default `transform-origin: 50% 50%`
// on an element whose box IS the frame box. Do not set a transform-origin. `bounds`, the
// occlusion solver and `pickTopAt()` all assume exactly this origin; a renderer that rotates
// about the photo centre instead will drift out of the camera clamp.
//
// ── DETERMINISM IS A CORRECTNESS PROPERTY ─────────────────────────────────────────────────
//
// Same seed + same media set = byte-identical Layout. There is no `Math.random()` in this
// file and there must never be one: a board that reshuffles when it re-renders is a broken
// board (stable deterministic positions and rotations). The only thing that may
// change an arrangement is a new seed — that is what "re-roll" means, and the seed is
// persisted per trip by the caller.
//
// Two levels of stability, deliberately:
//   * Per-item traits — rotation, size multiplier, jitter, video loop window — are drawn from
//     a stream seeded by hash(seed + ':' + mediaId). They are INTRINSIC: adding a photo to
//     the trip never re-tilts the photos already on the board.
//   * Slot, z and frame come from the ordered pass, so they do move when the set changes.
//     Frame proportions are dealt from a shuffled bag rather than rolled per item, because a
//     per-item roll clumps and the board is supposed to MIX polaroids and prints.
//
// All floating-point output is quantised (0.01 for positions/sizes/degrees, 1e-4 for aspect)
// as the last step. That makes byte-identity robust: the solver runs in full precision, but
// nothing downstream can see a last-ULP difference between two engines' `Math.cos`.
//
// ── CONTROLLED OVERLAP IS THE AESTHETIC; OCCLUSION IS THE BUG ─────────────────────────────
//
// Placement is justified rows (aspect-aware, no distortion, handles all-portrait sets) with
// per-item jitter and rotation — prints tossed on a board. Then a separation pass enforces
// two hard rules and re-tests until they hold:
//
//   1. No item is more than `maxCoverage` (default 26%) covered by items painted ABOVE it.
//   2. No item's focal disc is touched at all by an item painted above it.
//
// The solver drives on the SUM of pairwise intersection areas, which is an upper bound on the
// union (coverers can overlap each other over the same photo). Conservative on purpose:
// passing the sum test implies passing the union test, so `validateLayout()` — which measures
// the true union — can never disagree with the solver in the dangerous direction. The pass is
// Jacobi (all displacements computed, then applied together) so it is order-independent, and
// the step decays, so it settles; there is a hard iteration cap on top of that, and
// `stats.converged` reports honestly when the cap was hit rather than pretending.
//
// ── ACCESSIBILITY / MOTION INVARIANTS ───────────────────────────────────────────────────
// Nothing here emits a colour, a hue, an opacity or an animation — those rules bind the
// renderers. What this file owes them: `frameMetrics()` never returns a border thinner than
// its `min`, so a frame edge stays a visible SHAPE rather than a hue difference, and
// `MIN_EDGE` keeps the smallest print big enough that a 44px tap target fits inside it.

// ── version ───────────────────────────────────────────────────────────────────────────────
// Bump when a change would move items for an unchanged seed. Persist it with the seed; a
// caller that sees a version it did not store knows the board moved for a reason.
// 2: every photo bare (no polaroid, no print border), on a board of its own size (boardOf).
export const LAYOUT_VERSION = 2;

// ── the registries this file is the source of truth for ───────────────────────────────────
// collage-frames.js registers exactly these keys. Adding a frame is: an entry in FRAME_SPECS
// here (so bounds and export agree) plus an entry in the renderer's registry.
export const FRAMES = ["polaroid", "print", "bare"];

// THE GROUND REGISTRY and how the board looks live in ./shared/board-look.js, a leaf the Worker imports too (a shared
// board's page draws the same board from the same values). Re-exported here for everything that read them here.
import { GROUNDS, BOARD_LOOK } from "./shared/board-look.js";
export { GROUNDS, BOARD_LOOK };
// Where a fastener sits, with its look, lives in ./shared/fasteners.js (a leaf the Worker imports too).
export { fastenerGeometry } from "./shared/fasteners.js";

/** Every ground key. Was a hand-written list that could — and did — fall out of step. */
export const BACKGROUNDS = Object.keys(GROUNDS);

/** The fastener a ground calls for. Unknown ground -> no fastener, never a wrong one. */
export const fastenerFor = (key) => (GROUNDS[key] && GROUNDS[key].fastener) || null;

// Frame geometry. THESE NUMBERS MUST EQUAL `FRAMES[key].pads` IN collage-frames.js — that
// module is the visual registry and this is the same model expressed for the layout pass:
// pads are fractions of the frame's OUTER WIDTH, which is what makes a border uniform in
// absolute units all the way round (a real print's border does not get thinner because the
// photo is portrait). `scripts/collage_layout_test.mjs` asserts the two agree, because a
// disagreement here is not a cosmetic bug: `bounds` is computed from frame geometry, so a
// renderer painting a wider frame than the layout budgeted for puts the outermost print
// outside the camera clamp and it can never be scrolled to.
//
// If the two ever need to differ, do NOT fork the numbers — pass `options.frameMetrics` to
// layoutCollage() and there is still exactly one definition.
export const FRAME_SPECS = {
  bare: { top: 0, right: 0, bottom: 0, left: 0 },
  print: { top: 0.03, right: 0.03, bottom: 0.03, left: 0.03 },
  polaroid: { top: 0.06, right: 0.06, bottom: 0.18, left: 0.06 },
};

// Proportions the frame bag is dealt in — the same weights collage-frames.js's `frameForHash`
// rolls, but dealt from a shuffled bag instead of rolled per item, so the counts are exact and
// the spread is even. `item.frame` from the layout is authoritative; a renderer must not
// re-roll a frame of its own or the board will disagree with its own export.
const FRAME_MIX = { print: 0.45, polaroid: 0.35, bare: 0.20 };

// A polaroid is a square-ish object. Putting a 3:1 panorama in one looks like a mistake, so
// panoramas and letterbox-portraits are re-dealt to a flat frame.
const PANORAMA_ASPECT = 2.2;
const TOWER_ASPECT = 1 / 2.2;

export const DEFAULTS = {
  // ── size ────────────────────────────────────────────────────────────────────────────────
  rowHeight: 300,        // nominal row height, canvas units. Canvas units are CSS px at
                         // zoom 1; the camera fits the board on mount, so this only sets the
                         // scale that `shouldUseOriginal()` reasons about.
  minEdge: 130,          // no item's short edge below this (uniform scale, aspect preserved)
  maxEdge: 900,          // no item's long edge above this (uniform scale, aspect preserved)
  sizeVary: 0.12,        // +/- per-item scale, applied after row justification
  aspectEven: true,      // pull extreme aspects toward equal AREA (see below)

  // ── board shape ─────────────────────────────────────────────────────────────────────────
  boardAspect: 0.62,     // target width:height of the PILE on a 3:4 portrait board, narrower than the board because
                         // the overlapping rows pack shorter than their area says: aimed at 0.62, a pile comes out
                         // near 3:4 and fills 80–90% of the board (at 0.75 it filled 65–80%, bare cork below). On a
                         // board of another shape (a few photos: see boardTall) the aim scales with it. One shape on
                         // every device, so the app, a shared board's page and the saved picture agree.
  density: 0.90,         // how much of the board area the photos occupy, before jitter
  // These four are the overlap dial and they are NEGATIVE on purpose: a positive gutter makes
  // a contact sheet, and the aesthetic is prints tossed on a board. Tuned by sweeping against
  // validateLayout() — at these values ~80% of items on a mixed board are overlapped by
  // something, mean coverage sits near 9% and the worst item lands just under the 26% cap, so
  // the separation pass is doing real work on every board rather than idling.
  gutterFrac: -0.050,    // horizontal gap between items in a row, fraction of row height
  rowGapFrac: -0.080,    // vertical gap between rows, same units
  jitterXFrac: 0.160,    // per-item x jitter, fraction of row height
  jitterYFrac: 0.170,    // per-item y jitter
  rowPhaseFrac: 0.26,    // per-row horizontal offset, fraction of row height. Without it every
                         // row starts at the same x and the eye reads horizontal bands through
                         // the jitter — the board looks like a knocked-about grid instead of a
                         // pile. Shifting whole rows is what hides the seams.

  // ── rotation ────────────────────────────────────────────────────────────────────────────
  // TILT IS BANDED, NOT UNIFORM. It used to be one range with a FLOOR of 0.9 degrees, which
  // meant no print was ever straight and none was ever really wonky — every photo sat at
  // between 1 and 5 degrees and the whole board read as a single lean: uniform, everything
  // tilted in the same way.
  //
  // A real handful of prints pushed onto a board has some dead straight, most a little off,
  // and a few properly crooked. That is three bands, dealt by weight, and the variety comes
  // from the GAPS between them rather than from a wider average.
  rotBands: [
    { w: 0.28, lo: 0.0, hi: 1.2 },    // straight, or as near as makes no difference
    { w: 0.50, lo: 2.2, hi: 6.5 },    // the ordinary toss
    { w: 0.22, lo: 8.0, hi: 14.0 },   // somebody was in a hurry
  ],
  rotMin: 0.0,           // kept: read by nothing else, but callers may still pass them
  rotMax: 6.5,
  rotWildChance: 0.16,   // superseded by rotBands; retained so an old opts object still works
  rotWildMax: 10.5,

  // ── overlap discipline ──────────────────────────────────────────────────────────────────
  maxCoverage: 0.26,     // spec says ~25-30% covered by items above. Solver drives on the
                         // conservative sum-of-pairs bound.
  solveMargin: 0.94,     // the solver targets maxCoverage * this, so a finished board sits
                         // INSIDE the stated rule rather than exactly on it. Without headroom
                         // every board lands at 26.000% and then output quantisation or a
                         // measuring lattice decides whether it passes, which is not a
                         // property, it is a coin toss.
  focalFrac: 0.17,       // focal disc radius, fraction of the photo's short edge
  sepIterations: 96,     // hard cap. The pass always terminates.
  sepStepFrac: 0.22,     // push per iteration, fraction of the pair's mean short edge
  sepDecay: 0.055,       // step multiplier is 1/(1 + decay*iteration) — guarantees settling

  // ── video ───────────────────────────────────────────────────────────────────────────────
  loopMsMin: 1800,
  loopMsMax: 4200,
  loopMsUnknown: 4000,   // duration missing from the media row

  // ── misc ────────────────────────────────────────────────────────────────────────────────
  background: null,      // null = Automatic (AUTO_BACKGROUND); otherwise one of BACKGROUNDS
  fallbackAspect: 4 / 3, // a media row with no width/height. NEVER square — a square guess is
                         // the one guess that is wrong for every real photo.
};

// Quantisation. Applied once, at the end.
const POS_Q = 100;      // 0.01 canvas units
const ROT_Q = 100;      // 0.01 degrees
const ASPECT_Q = 10000; // 1e-4

const DEG = Math.PI / 180;

// ══════════════════════════════════════════════════════════════════════════════════════════
// Seeded PRNG — implemented here, no dependency.
// xmur3 mixes a string into four 32-bit words; sfc32 is the generator. Both are the standard
// public-domain constructions. Chosen over a one-liner LCG because we draw several correlated
// values per item (jitter x, jitter y, rotation, size) and a weak generator shows its lattice
// as visible diagonal banding in exactly that situation.
// ══════════════════════════════════════════════════════════════════════════════════════════

/** 32-bit string hash (xmur3 finaliser). Exported: renderers need deterministic per-key
 *  choices too (texture variant, tape position) and must not invent a second hash. */
export function hash32(str) {
  let h = 1779033703 ^ String(str).length;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

function seedWords(str) {
  let h = 1779033703 ^ String(str).length;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const out = [];
  for (let i = 0; i < 4; i++) {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    out.push((h ^= h >>> 16) >>> 0);
  }
  return out;
}

/** A generator over [0, 1). Same string in, same sequence out, forever. */
export function rngFrom(seedString) {
  let [a, b, c, d] = seedWords(seedString);
  // sfc32. Warm up so short, similar seed strings ('s1' vs 's2') decorrelate immediately.
  const next = () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

/** Mint a fresh seed string. Called by the caller on "re-roll", never at render time. */
export function makeSeed(input) {
  if (input != null && input !== "") return String(input);
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return "s_" + c.randomUUID().replace(/-/g, "").slice(0, 16);
  if (c && typeof c.getRandomValues === "function") {
    const b = new Uint8Array(8);
    c.getRandomValues(b);
    return "s_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  return "s_" + Date.now().toString(36) + Math.floor(performance?.now?.() || 0).toString(36);
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Media normalisation
// ══════════════════════════════════════════════════════════════════════════════════════════

// The default URL builder. It is byte-for-byte the same string memories-save.js's `mediaUrl`
// produces, and that is load-bearing: sw.js caches by exact path, so two spellings of one key
// are two cache entries and one of them is always the one that is missing offline. This file
// cannot import memories-save.js (that module reaches for `navigator` and this one must run
// in node), so `options.mediaUrl` exists — collage.js SHOULD pass the real one through, and
// then there is provably one spelling.
function defaultMediaUrl(key) {
  const k = String(key || "").replace(/^\/+/, "");
  if (!k) return "";
  return "/media/" + k.split("/").map(encodeURIComponent).join("/");
}

const numOr = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/**
 * Flatten the feed's memory list into the media array `layoutCollage` wants.
 *
 * `memories` is what GET /api/memories returns (newest first), each with
 * `{ id, created_at, media: [{ id, kind, key, thumb_key, url, thumb_url, mime, width,
 * height, duration_s, bytes, sort }] }`.
 *
 * Default order is chronological — oldest first — so the board reads top-left to
 * bottom-right in time, which is what makes a trip board legible. Pass `{ order: 'given' }`
 * to keep the feed's newest-first order instead.
 */
export function mediaFromMemories(memories, opts = {}) {
  const order = opts.order || "chrono";
  // N PHOTOS FROM EACH MEMORY, rather than every photo from every memory: the
  // appearance drawer can pick N photos from each selected memory instead of
  // all of them. 0 or absent means no cap.
  //
  // It takes the FIRST n in the memory's own sort order, not a random n: the first shots of a
  // set are the ones somebody chose to lead with, and a random subset would also re-roll every
  // time the board was rebuilt, which is the one thing a seeded layout is careful never to do.
  const perMemory = Math.max(0, Number(opts.perMemory) || 0);
  const list = Array.isArray(memories) ? memories.slice() : [];
  if (order === "chrono") {
    // Stable: ties broken by id so two memories posted in the same second never swap.
    // When each memory happened (`at`, migration 0029: its photographs' time, else its day), else
    // when it was posted: a set posted after the trip reads at its place in the trip, not at the end.
    const when = (m) => Number(m.at ?? m.created_at) || 0;
    list.sort((a, b) => when(a) - when(b) ||
      String(a.id).localeCompare(String(b.id)));
  }
  const out = [];
  for (const m of list) {
    const media = Array.isArray(m.media) ? m.media.slice() : [];
    media.sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) ||
      String(a.id).localeCompare(String(b.id)));
    const take = perMemory > 0 ? media.slice(0, perMemory) : media;
    for (const mm of take) out.push({ ...mm, memoryId: m.id, memoryAt: m.at ?? m.created_at });
  }
  return out;
}

/**
 * Normalise raw media rows into the minimal record the engine needs. Exported because the
 * renderers want the same aspect/URL resolution when they build a placeholder for an item
 * that is not in the layout yet.
 */
export function normaliseMedia(rawList, opts = {}) {
  const urlOf = typeof opts.mediaUrl === "function" ? opts.mediaUrl : defaultMediaUrl;
  const fallbackAspect = numOr(opts.fallbackAspect, DEFAULTS.fallbackAspect);
  const out = [];
  const list = Array.isArray(rawList) ? rawList : [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m) continue;
    const key = m.key || m.r2_key || m.r2Key || "";
    const thumbKey = m.thumb_key || m.thumbKey || "";
    const mediaId = String(m.id || m.media_id || key || `m${i}`);
    const mime = String(m.mime || m.type || "").split(";")[0].trim().toLowerCase();
    const kind = m.kind === "video" || m.kind === "photo"
      ? m.kind
      : (mime.startsWith("video/") ? "video" : "photo");

    // ASPECT COMES FROM THE MEDIA RECORD. `width`/`height` are the real pixel dimensions the
    // uploader measured off the decoded file (memories.js writes them at thumb time). Only a
    // row missing them falls back, and the fallback is 4:3, never 1:1.
    const w = Number(m.width ?? m.w);
    const h = Number(m.height ?? m.h);
    let aspect = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w / h : fallbackAspect;
    // Guard absurd metadata (a corrupt row claiming 20000x1) without ever clamping a real
    // photo's shape: only genuinely impossible aspects are replaced.
    if (!Number.isFinite(aspect) || aspect <= 0.02 || aspect >= 50) aspect = fallbackAspect;

    const durationMs = Math.max(0, Math.round(numOr(m.duration_s ?? m.duration, 0) * 1000));
    const fx = Number(m.focal_x);
    const fy = Number(m.focal_y);

    out.push({
      mediaId,
      memoryId: String(m.memoryId ?? m.memory_id ?? ""),
      kind,
      aspect,
      thumbUrl: m.thumb_url || (thumbKey ? urlOf(thumbKey) : ""),
      origUrl: m.url || (key ? urlOf(key) : ""),
      key,
      thumbKey,
      mime,
      bytes: Math.max(0, Math.round(numOr(m.bytes, 0))),
      durationMs,
      focal: {
        x: Number.isFinite(fx) && fx >= 0 && fx <= 1 ? fx : 0.5,
        y: Number.isFinite(fy) && fy >= 0 && fy <= 1 ? fy : 0.5,
      },
      // ZOOM AND TRIM (migration 0012). Both are presentation state stored beside the media —
      // the bytes are never touched — and both default to "as it was before the column existed",
      // which is why an unset value is indistinguishable from the old behaviour.
      zoom: (() => { const z = Number(m.zoom); return Number.isFinite(z) && z > 1 ? Math.min(8, z) : 1; })(),
      trim: (() => {
        const a = Number(m.trim_start_s), b = Number(m.trim_end_s);
        if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
        return { startMs: Math.max(0, a * 1000), lenMs: (b - a) * 1000 };
      })(),
    });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Frame geometry
// ══════════════════════════════════════════════════════════════════════════════════════════

/**
 * The frame box for a photo box of `w x h`, as an offset and size relative to the photo's
 * top-left. `dx`/`dy` are <= 0 (the frame grows outward). THIS IS THE ONE DEFINITION —
 * collage-frames.js must build its CSS padding from these numbers, and collage-export.js must
 * paint to them, or the export and the screen will disagree and the camera clamp will be
 * wrong at the board edges.
 */
export function frameMetrics(frame, w, h) {
  const p = FRAME_SPECS[frame] || FRAME_SPECS.bare;
  // Outer width first: pads are fractions OF IT, so this is the fixed point of
  // ow = w + ow*left + ow*right. collage-frames.js's outerSize() solves the same equation.
  const ow = w / (1 - p.left - p.right);
  const padL = ow * p.left, padT = ow * p.top, padB = ow * p.bottom;
  return {
    dx: -padL,
    dy: -padT,
    w: ow,
    h: h + padT + padB,
    pad: padT,    // top / side border
    foot: padB,   // bottom border. Larger than `pad` on a polaroid; that is the caption slot.
  };
}

/** The un-rotated outer rect of an item, in canvas units. */
export function outerRect(item) {
  const f = item.frameBox || frameMetrics(item.frame, item.w, item.h);
  return { x: item.x + f.dx, y: item.y + f.dy, w: f.w, h: f.h };
}

/** The un-rotated photo rect of an item. */
export function photoRect(item) {
  return { x: item.x, y: item.y, w: item.w, h: item.h };
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Geometry primitives. Convex quads only, which is all a rotated rect ever is.
// ══════════════════════════════════════════════════════════════════════════════════════════

// Corners of a rect centred at (cx, cy), half-extents (hw, hh), rotated by (cos, sin).
// Winding is positive-signed-area, which is what clipPoly's inside test assumes.
function quad(cx, cy, hw, hh, cos, sin) {
  return [
    [cx - hw * cos + hh * sin, cy - hw * sin - hh * cos],
    [cx + hw * cos + hh * sin, cy + hw * sin - hh * cos],
    [cx + hw * cos - hh * sin, cy + hw * sin + hh * cos],
    [cx - hw * cos - hh * sin, cy - hw * sin + hh * cos],
  ];
}

function polyArea(p) {
  let s = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

// Sutherland-Hodgman. Exact for convex subject against convex clip, which is our only case —
// no sampling, no tolerance, no "close enough" in the constraint the whole aesthetic rests on.
function clipPoly(subject, clip) {
  let out = subject;
  const n = clip.length;
  for (let i = 0; i < n && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % n];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const inp = out;
    out = [];
    for (let j = 0, m = inp.length; j < m; j++) {
      const P = inp[j], Q = inp[(j + 1) % m];
      const dp = ex * (P[1] - a[1]) - ey * (P[0] - a[0]);
      const dq = ex * (Q[1] - a[1]) - ey * (Q[0] - a[0]);
      const pin = dp >= 0, qin = dq >= 0;
      if (pin) out.push(P);
      if (pin !== qin) {
        const t = dp / (dp - dq);
        out.push([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])]);
      }
    }
  }
  return out;
}

function intersectArea(a, b) {
  const c = clipPoly(a, b);
  if (c.length < 3) return 0;
  return Math.abs(polyArea(c));
}

function segDist2(a, b, px, py) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = px - a[0], wy = py - a[1];
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const dx = wx - t * vx, dy = wy - t * vy;
  return dx * dx + dy * dy;
}

function quadHitsCircle(q, cx, cy, r) {
  let inside = true;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    if ((b[0] - a[0]) * (cy - a[1]) - (b[1] - a[1]) * (cx - a[0]) < 0) { inside = false; break; }
  }
  if (inside) return true;
  const r2 = r * r;
  for (let i = 0; i < 4; i++) if (segDist2(q[i], q[(i + 1) % 4], cx, cy) <= r2) return true;
  return false;
}

function pointInQuad(q, px, py) {
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    if ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]) < 0) return false;
  }
  return true;
}

/**
 * AABB of ONE item WITH ROTATION ACCOUNTED FOR. A rotated rect's axis-aligned box is larger
 * than the rect — |cos|*w + |sin|*h wide, not w wide — and getting this wrong is exactly how
 * a camera clamp ends up cutting the corner off the outermost polaroid. It is the frame box
 * that is rotated, not the photo box.
 */
export function itemAABB(item) {
  const r = outerRect(item);
  const a = (item.rot || 0) * DEG;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const hx = (c * r.w + s * r.h) / 2;
  const hy = (s * r.w + c * r.h) / 2;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  return { minX: cx - hx, minY: cy - hy, maxX: cx + hx, maxY: cy + hy };
}

/** The content bounding box of a set of items, rotation included. Empty set -> a zero box. */
export function boundsOf(items) {
  if (!items || !items.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    const b = itemAABB(it);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * THE BOARD: a finite panel of its material, sized to the photos on it, hanging on an endless wall. One
 * rectangle for every renderer (the app, the export, a shared board's page), so they draw the same board.
 *
 *   width   from the layout's target width (stats.targetWidth), which only grows as photos are added: the target
 *           plus a margin each side.
 *   margin  the larger of BOARD.margin (canvas units) and BOARD.marginFrac of the target width, all round: room for
 *           every fastener and every lift shadow, and a border of material besides.
 *   shape   height:width by the number of photos (boardTall): a landscape 4:3 board for a few (BOARD.fewN or
 *           fewer), turning by steps to the 3:4 portrait at BOARD.manyN, so a new trip's first photos fill their
 *           board. Both the width and the shape only grow, so no side moves in when a photo is added.
 *   steps   each side is rounded UP to a ladder (BOARD.step apart, from BOARD.minW and BOARD.minH), so one photo
 *           added near the middle doesn't move the edge, and the board grows in visible steps.
 *   place   centred across the photos, a margin above them: the room to spare is cork at the foot. Never smaller
 *           than BOARD.minW by BOARD.minH: an empty board still holds its words.
 *   wall    a band of wall around the board (BOARD.wallFrac of its shorter side): what the camera opens on, and
 *           as far as it may go, so the first look says "a board on a wall" and the board can't be lost.
 *
 * Returns { x, y, w, h } (the board) and { wall: { x, y, w, h } } (the board with its band), canvas units.
 */
export const BOARD = { margin: 40, marginFrac: 0.06, step: 1.1, minW: 420, minH: 315, wallFrac: 0.08,
  fewTall: 3 / 4, manyTall: 4 / 3, fewN: 3, manyN: 12 };

/** The board's height:width for n photos: BOARD.fewTall up to BOARD.fewN, BOARD.manyTall from BOARD.manyN, evenly
 *  between. Never falls as n grows. */
export function boardTall(n) {
  const t = Math.min(1, Math.max(0, ((n || 0) - BOARD.fewN) / (BOARD.manyN - BOARD.fewN)));
  return qz(BOARD.fewTall + (BOARD.manyTall - BOARD.fewTall) * t, ASPECT_Q);
}

// The board's size for a target width and shape, and the room it leaves the photos (its size less the margin all
// round).
function boardSize(tw, tall) {
  const m = Math.max(BOARD.margin, BOARD.marginFrac * tw);
  const ladder = (need, min) => need <= min ? min : min * Math.pow(BOARD.step, Math.ceil(Math.log(need / min) / Math.log(BOARD.step) - 1e-9));
  const w = ladder(tw + 2 * m, BOARD.minW);
  const h = ladder(Math.max(w * tall, BOARD.minH), BOARD.minH);
  return { w, h, m };
}
function boardRoom(tw, tall) { const b = boardSize(tw, tall); return { w: b.w - 2 * b.m, h: b.h - 2 * b.m }; }
/** The room the pile is fitted to: that of the board drawn for this target width. The board is drawn from the
 *  rounded width (stats.targetWidth), so the room is too: from the unrounded one, a target a hair above a ladder
 *  rung put the room a rung above the drawn board's. */
export function fitRoom(targetW, tall) { return boardRoom(qz(targetW, POS_Q), tall); }
/** The board for a Layout: boardOf(layout.bounds, layout.stats.targetWidth, layout.stats.boardTall). */
export function boardOf(bounds, targetWidth, tall) {
  const has = bounds && Number.isFinite(bounds.minX) && bounds.maxX > bounds.minX && bounds.maxY > bounds.minY;
  const cx = has ? (bounds.minX + bounds.maxX) / 2 : 0, cy = has ? (bounds.minY + bounds.maxY) / 2 : 0;
  // From the target width when the layout gave one (it only grows as photos are added); a Layout without one (older,
  // or empty) is sized from its photos' own extent.
  const shape = tall > 0 ? tall : has ? BOARD.manyTall : BOARD.fewTall;
  const tw = has ? (targetWidth > 0 ? targetWidth : Math.max(bounds.maxX - bounds.minX, (bounds.maxY - bounds.minY) / shape)) : 0;
  const size = boardSize(tw, shape);
  const w = qz(size.w, POS_Q), h = qz(size.h, POS_Q);
  // Centred across; at the TOP the margin, so the room the board has to spare is cork at its foot, where the next
  // photos go (a pile centred in a tall board left bare cork above it as well as below).
  const x = qz(cx - w / 2, POS_Q), y = has ? qz(bounds.minY - size.m, POS_Q) : qz(cy - h / 2, POS_Q);
  const band = qz(BOARD.wallFrac * Math.min(w, h), POS_Q);
  return { x, y, w, h, wall: { x: x - band, y: y - band, w: w + 2 * band, h: h + 2 * band } };
}

/** The four rotated corners of an item's frame box, canvas units, positive winding. */
export function cornersOf(item) {
  const r = outerRect(item);
  const a = (item.rot || 0) * DEG;
  return quad(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, Math.cos(a), Math.sin(a));
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// The layout pass
// ══════════════════════════════════════════════════════════════════════════════════════════

/**
 * Produce a Layout from a media set and a seed.
 *
 *   layoutCollage(media, { seed, ...options }) -> Layout
 *
 * `media` is either raw rows from GET /api/memories (use `mediaFromMemories()` to flatten a
 * memory list first) or already-normalised records. `seed` is required in spirit — omitting
 * it uses the string "default", which is deterministic but shared by every trip.
 *
 * Options are DEFAULTS, shallow-merged. `options.mediaUrl` injects memories-save.js's
 * `mediaUrl` so there is one spelling of a media path in the app.
 */
export function layoutCollage(media, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const seed = String(opt.seed == null || opt.seed === "" ? "default" : opt.seed);

  // Frame geometry is injectable so `collage.js` can hand in collage-frames.js's own model and
  // the app provably has ONE definition of how big a frame is. The local default reproduces it
  // exactly; the seam exists so it stays that way rather than because they differ today.
  const fmOf = typeof opt.frameMetrics === "function" ? opt.frameMetrics : frameMetrics;

  const src = normaliseMedia(media, opt);
  const n = src.length;

  if (n === 0) {
    return {
      version: LAYOUT_VERSION,
      seed,
      background: pickBackground(seed, opt.background),
      items: [],
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      stats: emptyStats(),
    };
  }

  const H = Math.max(60, Number(opt.rowHeight) || DEFAULTS.rowHeight);

  // ── per-item intrinsic traits ───────────────────────────────────────────────────────────
  // Drawn from the item's OWN stream, so a photo's tilt and size never change because someone
  // else uploaded a picture. Order of draws inside this block is part of the contract: change
  // it and every board re-rolls (that is what LAYOUT_VERSION is for).
  const traits = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = rngFrom(seed + ":" + src[i].mediaId);
    const sizeMul = 1 + (r() * 2 - 1) * opt.sizeVary;
    const jx = (r() * 2 - 1) * opt.jitterXFrac * H;
    const jy = (r() * 2 - 1) * opt.jitterYFrac * H;
    // Pick a band by weight, then a magnitude inside it. Two rolls are spent whatever the
    // outcome so the stream stays aligned for every item — a layout must not change shape
    // because one photo happened to land in a different band.
    const bandRoll = r();
    const rMag = r();
    const sign = r() < 0.5 ? -1 : 1;
    const bands = Array.isArray(opt.rotBands) && opt.rotBands.length
      ? opt.rotBands
      : [{ w: 1, lo: opt.rotMin, hi: opt.rotMax }];
    let acc = 0, band = bands[bands.length - 1];
    const total = bands.reduce((t, x) => t + (x.w || 0), 0) || 1;
    for (const x of bands) { acc += (x.w || 0) / total; if (bandRoll <= acc) { band = x; break; } }
    let mag = band.lo + rMag * (band.hi - band.lo);
    // AN EXTREME ASPECT GETS A GENTLER TOSS. A rotated rectangle's axis-aligned box grows with
    // its LONG edge, so 14 degrees on a panorama sweeps far more board than 14 degrees on a
    // square — measured: the wide bands pushed the occlusion solver past its coverage cap on a
    // board of forty panoramas. Scaling the magnitude down by how extreme the shape is keeps
    // the character without letting one letterbox print eat its neighbours.
    const a0 = src[i].aspect || 1;
    // A HARD CEILING, not a scale. Dividing the magnitude still let a panorama reach 7-8
    // degrees, and a board of forty of them never settled — the solver ran its full 96
    // iterations and gave up. A letterbox print lies flat on a board in real life anyway;
    // it is the square-ish ones that get tossed about.
    const extreme = a0 >= PANORAMA_ASPECT || a0 <= TOWER_ASPECT;
    if (extreme) mag = Math.min(mag, 3.2);
    const rot = sign * mag;
    traits[i] = { sizeMul, jx, jy, rot: qz(rot, ROT_Q), loopR: r() };
  }

  // ── sizes: aspect-aware, never distorted ────────────────────────────────────────────────
  // Justified rows give every item in a row the SAME height, which is the classic photo-wall
  // pack and the reason nothing is ever squashed. Left alone that makes a 3:4 portrait carry
  // 56% of a 4:3 landscape's area, and on a tossed-prints board the portraits then read as
  // bookmarks. `aspectEven` pulls that back with a per-item scale of a^(-1/4), which halves
  // the exponent on area (area ends up proportional to sqrt(aspect) instead of aspect) —
  // portraits grow ~7%, landscapes shrink ~7%, and the row's right edge goes slightly ragged,
  // which on this board is a feature. The quarter power is two exact IEEE sqrts, deliberately:
  // Math.pow is not bit-identical across engines and this number feeds every position.
  const evenK = new Array(n);
  const base = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = src[i].aspect;
    evenK[i] = opt.aspectEven ? 1 / Math.sqrt(Math.sqrt(a)) : 1;
    const m = traits[i].sizeMul * evenK[i];
    // Nominal box at the nominal row height. Row justification re-derives w and h from the
    // aspect and the row's own height, so this only sets the board's target width.
    base[i] = clampBox(H * a * m, H * m, opt);
    base[i].a = a;
  }

  // ── target board width ──────────────────────────────────────────────────────────────────
  let totalArea = 0;
  for (let i = 0; i < n; i++) totalArea += base[i].w * base[i].h;
  const boardArea = totalArea / Math.max(0.2, Math.min(1, opt.density));
  // The pile's aim follows the board's shape: opt.boardAspect is the aim on a 3:4 portrait board.
  const tall = boardTall(n);
  const pileAspect = opt.boardAspect * BOARD.manyTall / tall;
  let targetW = Math.sqrt(boardArea * Math.max(0.4, pileAspect));
  // A board can never be narrower than its widest single print, or justification divides by a
  // negative row budget. One-item and two-item boards land here.
  let widest = 0;
  for (let i = 0; i < n; i++) if (base[i].w > widest) widest = base[i].w;
  if (targetW < widest) targetW = widest;

  const gutter = opt.gutterFrac * H;
  const rowGap = opt.rowGapFrac * H;

  // ── justified rows ──────────────────────────────────────────────────────────────────────
  // The classic photo-wall pack: fill a row until it exceeds the target width, then scale the
  // whole row UNIFORMLY so it fits exactly. Uniform per-row scale is the reason nothing is
  // ever letterboxed or squashed, and it is what makes an all-portrait set lay out as rows of
  // many narrow prints instead of one absurdly tall column.
  const rows = [];
  let row = [];
  let rowAspectSum = 0;
  for (let i = 0; i < n; i++) {
    row.push(i);
    rowAspectSum += base[i].a;
    const naturalW = rowAspectSum * H + gutter * (row.length - 1);
    if (naturalW >= targetW) {
      rows.push(row);
      row = [];
      rowAspectSum = 0;
    }
  }
  if (row.length) rows.push(row);

  const place = new Array(n);
  let cursorY = 0;
  for (let ri = 0; ri < rows.length; ri++) {
    const idxs = rows[ri];
    const last = ri === rows.length - 1;
    let aspectSum = 0;
    for (const i of idxs) aspectSum += base[i].a;
    const budget = targetW - gutter * (idxs.length - 1);
    // Row height: justify to the budget, except the final row which keeps nominal height —
    // stretching a two-photo final row to full width is the tell of a naive justified layout.
    // Clamped so a single ultra-wide panorama in its own row cannot produce a 12px-tall row.
    let rowH = last ? H : budget / Math.max(0.0001, aspectSum);
    if (!Number.isFinite(rowH) || rowH <= 0) rowH = H;
    rowH = Math.max(H * 0.55, Math.min(H * 1.9, rowH));

    // Per-item scale: the seeded size variance and the aspect evening, applied about each
    // item's own centre. This is what breaks the ruler-straight row without breaking the pack.
    const boxes = idxs.map((i) => {
      const m = traits[i].sizeMul * evenK[i];
      return { w: rowH * base[i].a * m, h: rowH * m };
    });

    // Re-justify on the SCALED widths. A single uniform per-row factor cannot change the
    // items' sizes relative to each other, so the evening and the variance both survive it —
    // but without this step the cursor advances by the unscaled width and every shrunk item
    // leaves a hole beside it. An all-panorama board is where that shows worst: evening pulls
    // a 3.6:1 print to 73% and the row ends up a third empty.
    let sum = 0;
    for (const b of boxes) sum += b.w;
    let rowScale = last || sum <= 0 ? 1 : budget / sum;
    rowScale = Math.max(0.65, Math.min(1.6, rowScale));

    // The min/max edge clamp lands HERE, on the final numbers. A row scales up as well as
    // down, so a clamp applied before justification is a clamp that does not hold.
    let rowW = gutter * (idxs.length - 1);
    let band = 0;
    for (let k = 0; k < boxes.length; k++) {
      boxes[k] = clampBox(boxes[k].w * rowScale, boxes[k].h * rowScale, opt);
      rowW += boxes[k].w;
      if (boxes[k].h > band) band = boxes[k].h;
    }

    // The row's own horizontal phase, seeded per row. Rows deliberately hang over the target
    // width on one side; `bounds` absorbs it and the board loses its seams.
    const phase = (rngFrom(seed + ":row:" + ri)() * 2 - 1) * opt.rowPhaseFrac * rowH;
    let cursorX = (last ? (targetW - rowW) / 2 : 0) + phase;
    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k];
      place[i] = {
        w: boxes[k].w,
        h: boxes[k].h,
        cx: cursorX + boxes[k].w / 2 + traits[i].jx,
        cy: cursorY + band / 2 + traits[i].jy,
        aspect: base[i].a,
      };
      cursorX += boxes[k].w + gutter;
    }
    cursorY += band + rowGap;
  }

  // ── frames, dealt from a shuffled bag ───────────────────────────────────────────────────
  // ONE FRAME FOR EVERYTHING, when the appearance drawer asks for it. `frame: "mixed"` (or
  // absent) keeps the dealt bag, which is the shipped look. Anything else that names a real
  // frame overrides every item — including the panorama/tower guard below, which only exists to
  // stop the RANDOM dealer putting a polaroid on a letterbox; a deliberate choice is allowed to.
  // UNIFORM BY DEFAULT. The dealt bag put polaroids next to bare prints next to bordered
  // prints, and the board looked unresolved rather than varied: one photo style for all of
  // them, polaroid or printout, reads better. So the
  // default is one style for the whole board and "mixed" is the thing you opt IN to, which is
  // the opposite of how it shipped.
  // EVERY PHOTO BARE (version 2). The photos sit on the board as themselves, with no border of any size: a
  // board's stored "photo style" (mixed, polaroid, print) is no longer read, and reads as bare. The other
  // frames stay in FRAMES and FRAME_SPECS so an old Layout still measures right if one is ever handed in.
  void opt.frame;
  const forced = "bare";
  // ONE EXCEPTION, AND IT IS NOT TASTE. A polaroid's mount and deep foot are sized for a
  // roughly square photo; on a letterbox they add an enormous box around a thin strip. The
  // random dealer has always refused that pairing, and an earlier version of this line let a
  // deliberate choice overrule it — which is how a board of forty panoramas stopped packing at
  // all: the solver ran its full 96 iterations and gave up. Extreme aspects take `print`
  // instead, which is the same bordered look without the foot.
  const frames = forced
    ? place.map((p2) => (forced === "polaroid" &&
        (p2.aspect >= PANORAMA_ASPECT || p2.aspect <= TOWER_ASPECT) ? "print" : forced))
    : dealFrames(n, seed, place);

  // ── working set for the solver ──────────────────────────────────────────────────────────
  // The free variables are the FRAME box centres; everything else is derived from them, so
  // "move an item" is unambiguous and the rotation origin never drifts.
  const work = new Array(n);
  for (let i = 0; i < n; i++) {
    const w = place[i].w, h = place[i].h;
    const fm = fmOf(frames[i], w, h);
    const rot = traits[i].rot;          // already quantised: the solver and the output agree
    const a = rot * DEG;
    // photo centre relative to frame centre, in the item's own unrotated frame
    const rx = w / 2 - fm.dx - fm.w / 2;
    const ry = h / 2 - fm.dy - fm.h / 2;
    const f = src[i].focal;
    work[i] = {
      i,
      w, h,
      ow: fm.w, oh: fm.h, odx: fm.dx, ody: fm.dy,
      rot, cos: Math.cos(a), sin: Math.sin(a),
      rx, ry,
      // focal offset from the photo centre, in the unrotated frame
      fx: (f.x - 0.5) * w,
      fy: (f.y - 0.5) * h,
      focalR: opt.focalFrac * Math.min(w, h),
      // the moving variable: frame box centre
      cx: place[i].cx - rx,
      cy: place[i].cy - ry,
      short: Math.min(w, h),
      photoArea: w * h,
    };
  }

  const solved = separate(work, opt, seed);

  // ── emit ────────────────────────────────────────────────────────────────────────────────
  const items = new Array(n);
  for (let i = 0; i < n; i++) {
    const wk = work[i];
    const s = src[i];
    const w = qz(wk.w, POS_Q);
    const aspect = qz(s.aspect, ASPECT_Q);
    // h derived from the quantised w and aspect so w/h === aspect to within 1e-4. A renderer
    // using object-fit:cover therefore cannot letterbox and cannot crop meaningfully.
    const h = qz(w / aspect, POS_Q);
    const fm = fmOf(frames[i], w, h);
    // Back out the photo top-left from the solved frame centre.
    const x = qz(wk.cx - fm.w / 2 - fm.dx, POS_Q);
    const y = qz(wk.cy - fm.h / 2 - fm.dy, POS_Q);
    const loop = loopWindow(s.durationMs, traits[i].loopR, opt);

    items[i] = {
      id: `${s.memoryId || "m"}:${s.mediaId}`,
      memoryId: s.memoryId,
      mediaId: s.mediaId,
      kind: s.kind,
      x, y, w, h,
      rot: wk.rot,
      z: i,
      frame: frames[i],
      thumbUrl: s.thumbUrl,
      origUrl: s.origUrl,
      aspect,
      // A TRIM SET BY HAND BEATS THE DEALT WINDOW. loopWindow() picks a pleasant few seconds
      // out of a clip nobody has told us anything about; s.trim is somebody having told us.
      // User trim selects a short clip excerpt to loop inside the board.
      loopStartMs: s.kind === "video" ? (s.trim ? s.trim.startMs : loop.start) : 0,
      loopMs: s.kind === "video" ? (s.trim ? s.trim.lenMs : loop.len) : 0,
      // additive
      frameBox: { dx: qz(fm.dx, POS_Q), dy: qz(fm.dy, POS_Q), w: qz(fm.w, POS_Q), h: qz(fm.h, POS_Q) },
      focal: { x: qz(s.focal.x, ASPECT_Q), y: qz(s.focal.y, ASPECT_Q) },
      zoom: qz(s.zoom || 1, ASPECT_Q),
      durationMs: s.durationMs,
      mime: s.mime,
      bytes: s.bytes,
    };
  }

  // THE BOARD ONLY GROWS. Its size is a function of the target width alone (boardOf), and the target width only
  // grows when a photo is added (it comes from the photos' total area). So the photos are made to fit the board,
  // not the board the photos: where the solved pile is wider than the target width or taller than the board's 3:4
  // allows (a wide print among few, a tall last row), every print is scaled down about the pile's centre, positions
  // and sizes together, so the overlaps and tilts are as solved. Most boards need nothing.
  let fit = 1;
  {
    const pile = boundsOf(items);
    const cw = pile.maxX - pile.minX, ch = pile.maxY - pile.minY;
    const room = fitRoom(targetW, tall);
    const f = Math.min(1, cw > 0 ? room.w / cw : 1, ch > 0 ? room.h / ch : 1);
    fit = f;
    if (f < 1) {
      const pcx = (pile.minX + pile.maxX) / 2, pcy = (pile.minY + pile.maxY) / 2;
      for (const it of items) {
        const fb = it.frameBox;
        const cx = it.x + fb.dx + fb.w / 2, cy = it.y + fb.dy + fb.h / 2;
        const ncx = pcx + (cx - pcx) * f, ncy = pcy + (cy - pcy) * f;
        it.w = qz(it.w * f, POS_Q); it.h = qz(it.h * f, POS_Q);
        it.frameBox = { dx: qz(fb.dx * f, POS_Q), dy: qz(fb.dy * f, POS_Q), w: qz(fb.w * f, POS_Q), h: qz(fb.h * f, POS_Q) };
        it.x = qz(ncx - it.frameBox.w / 2 - it.frameBox.dx, POS_Q);
        it.y = qz(ncy - it.frameBox.h / 2 - it.frameBox.dy, POS_Q);
      }
    }
  }

  // Normalise the board so its top-left corner sits at the origin. Renderers get to assume
  // bounds.minX/minY are 0-ish, which removes a whole class of sign bugs from the camera.
  const raw = boundsOf(items);
  const ox = -raw.minX, oy = -raw.minY;
  for (const it of items) {
    it.x = qz(it.x + ox, POS_Q);
    it.y = qz(it.y + oy, POS_Q);
  }
  const bounds = quantBounds(boundsOf(items));

  let photos = 0, videos = 0;
  for (const it of items) (it.kind === "video" ? videos++ : photos++);

  return {
    version: LAYOUT_VERSION,
    seed,
    background: pickBackground(seed, opt.background),
    items,
    bounds,
    stats: {
      count: n,
      photos,
      videos,
      rows: rows.length,
      targetWidth: qz(targetW, POS_Q),
      // The board's height:width (boardTall of the count): with targetWidth, what boardOf sizes the board from.
      boardTall: tall,
      // How much the pile was scaled to fit its board (1: not at all). A print's short edge is at least minEdge × fit.
      fit: qz(fit, ASPECT_Q),
      boardWidth: qz(bounds.maxX - bounds.minX, POS_Q),
      boardHeight: qz(bounds.maxY - bounds.minY, POS_Q),
      iterations: solved.iterations,
      converged: solved.converged,
      // The conservative sum-of-pairs coverage the solver drove on. The true union coverage
      // is <= this; validateLayout() measures it.
      maxCoverageBound: qz(solved.maxCoverage, ASPECT_Q),
      focalHits: solved.focalHits,
    },
  };
}

// Min/max edge clamps are UNIFORM scales applied to both edges, so the aspect survives them.
// A clamp that touched one edge would be the letterbox this file exists to prevent.
function clampBox(w, h, opt) {
  const up = opt.minEdge / Math.min(w, h);
  if (up > 1) { w *= up; h *= up; }
  const down = opt.maxEdge / Math.max(w, h);
  if (down < 1) { w *= down; h *= down; }
  return { w, h };
}

function emptyStats() {
  return {
    count: 0, photos: 0, videos: 0, rows: 0, targetWidth: 0, boardTall: boardTall(0), boardWidth: 0, boardHeight: 0,
    iterations: 0, converged: true, maxCoverageBound: 0, focalHits: 0,
  };
}

// Automatic is the cork: a board nobody has picked a ground for is a corkboard, on every trip.
export const AUTO_BACKGROUND = "corkboard";
function pickBackground(seed, requested) {
  if (requested && BACKGROUNDS.includes(requested)) return requested;
  return AUTO_BACKGROUND;
}

function qz(v, q) {
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v * q) / q;
  return r === 0 ? 0 : r;   // kills -0, which serialises differently in some paths
}

function quantBounds(b) {
  return {
    minX: qz(b.minX, POS_Q), minY: qz(b.minY, POS_Q),
    maxX: qz(b.maxX, POS_Q), maxY: qz(b.maxY, POS_Q),
  };
}

// ── video loop windows ────────────────────────────────────────────────────────────────────
// A short segment from a sensible offset — never the first frame, which on phone video is
// usually a lens still settling. `loop` on a <video> cannot express a sub-range, so
// collage-video.js drives it on `timeupdate`; these two numbers are its in and out points.
function loopWindow(durationMs, r, opt) {
  if (!durationMs || durationMs < 1200) {
    return { start: 0, len: durationMs > 0 ? durationMs : opt.loopMsUnknown };
  }
  const len = Math.min(opt.loopMsMax, Math.max(opt.loopMsMin, Math.round(durationMs * 0.5)));
  const window = Math.max(0, durationMs - len);
  const start = Math.round(window * (0.10 + 0.55 * r) / 10) * 10;
  return { start: Math.max(0, Math.min(window, start)), len: Math.round(len / 10) * 10 };
}

// ── frame dealing ─────────────────────────────────────────────────────────────────────────
// A bag, not a per-item roll. Rolling per item gives clumps — six polaroids in a row and then
// a bare patch — because that is what independent samples do. Dealing exact counts from a
// seeded Fisher-Yates shuffle gives the requested proportions AND an even spread, then two
// deterministic fix-up passes clean up what is left: runs of three, and panoramas that were
// dealt a polaroid (a 3:1 print in a square white frame reads as a bug).
function dealFrames(n, seed, place) {
  const bag = [];
  let assigned = 0;
  const keys = Object.keys(FRAME_MIX);
  for (let k = 0; k < keys.length; k++) {
    const want = k === keys.length - 1 ? n - assigned : Math.round(n * FRAME_MIX[keys[k]]);
    const c = Math.max(0, Math.min(n - assigned, want));
    for (let j = 0; j < c; j++) bag.push(keys[k]);
    assigned += c;
  }
  while (bag.length < n) bag.push("print");
  bag.length = n;

  const r = rngFrom(seed + ":frames");
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
  }

  // No polaroid on a panorama or a tower. Swap forward with the first flat-framed item that
  // is itself not extreme; if there is none, fall back to 'print' outright.
  for (let i = 0; i < n; i++) {
    const a = place[i].aspect;
    const extreme = a >= PANORAMA_ASPECT || a <= TOWER_ASPECT;
    if (!extreme || bag[i] !== "polaroid") continue;
    let swapped = false;
    for (let j = 0; j < n; j++) {
      if (bag[j] === "polaroid") continue;
      const aj = place[j].aspect;
      if (aj >= PANORAMA_ASPECT || aj <= TOWER_ASPECT) continue;
      const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
      swapped = true;
      break;
    }
    if (!swapped) bag[i] = "print";
  }

  // Break runs of three identical frames in placement order.
  for (let i = 2; i < n; i++) {
    if (bag[i] !== bag[i - 1] || bag[i] !== bag[i - 2]) continue;
    for (let j = i + 1; j < n; j++) {
      if (bag[j] === bag[i]) continue;
      const aj = place[j].aspect;
      if (bag[i] === "polaroid" && (aj >= PANORAMA_ASPECT || aj <= TOWER_ASPECT)) continue;
      const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
      break;
    }
  }
  return bag;
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// The separation pass
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// Jacobi relaxation with a decaying step and a hard iteration cap, so it ALWAYS terminates
// and its result never depends on the order pairs happen to be visited in.
//
// Broadphase is a uniform grid rebuilt each iteration. Without it this is O(n^2) exact
// polygon clips per iteration and a 500-item board takes seconds; with it each item tests
// against the handful of neighbours whose AABBs actually touch, which is the point at which
// "run it until it settles" becomes affordable.

function separate(work, opt, seed) {
  const n = work.length;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  let iterations = 0;
  let converged = n <= 1;
  let maxCoverage = 0;
  let focalHits = 0;

  if (n <= 1) return { iterations: 0, converged: true, maxCoverage: 0, focalHits: 0 };

  // A deterministic escape direction for the pathological case of two items whose centres are
  // exactly coincident (identical media, identical jitter). Without this the normalise below
  // divides by zero and the pair stays welded together forever.
  const escapeAngle = (i) => (hash32(seed + ":esc:" + i) % 3600) / 3600 * Math.PI * 2;

  const maxCov = opt.maxCoverage * (opt.solveMargin > 0 ? opt.solveMargin : 1);
  const covers = [];   // flat [j, interArea, focalHit] triples, reused every item

  for (let iter = 0; iter < opt.sepIterations; iter++) {
    iterations = iter + 1;
    dx.fill(0); dy.fill(0);

    const geo = buildGeometry(work);
    const grid = broadphase(geo);

    let violations = 0;
    let worst = 0;
    let hits = 0;
    const stepK = 1 / (1 + opt.sepDecay * iter);

    for (let i = 0; i < n; i++) {
      const gi = geo[i];
      const cands = grid.query(gi.aabb);

      // PHASE 1 — gather every coverer before deciding anything. The rule is about how much
      // of the photo is hidden IN TOTAL, so a per-pair test is the wrong test: two neighbours
      // taking 15% and 20% is a 35%-eaten photo and neither pair looks guilty on its own.
      covers.length = 0;
      let covSum = 0;
      let anyFocal = false;
      for (let c = 0; c < cands.length; c++) {
        const j = cands[c];
        if (j <= i) continue;            // only items painted ABOVE i can cover i
        const gj = geo[j];
        if (!aabbHit(gi.aabb, gj.aabb)) continue;

        const inter = intersectArea(gi.photo, gj.outer);
        const focalHit = quadHitsCircle(gj.outer, gi.focalX, gi.focalY, work[i].focalR);
        if (inter <= 0 && !focalHit) continue;

        covSum += inter;
        if (focalHit) { hits++; anyFocal = true; }
        covers.push(j, inter, focalHit ? 1 : 0);
      }

      const frac = covSum / work[i].photoArea;
      if (frac > worst) worst = frac;
      if (!covers.length || (frac <= maxCov && !anyFocal)) continue;

      violations++;
      // PHASE 2 — push away from each coverer along the centre-to-centre axis, sharing the
      // correction out in proportion to how much of the damage that coverer is doing. Both
      // items move, half each: shoving only the upper one cascades the whole board downstream
      // and takes many more iterations to settle.
      const excess = frac > maxCov ? Math.min(2, (frac - maxCov) / maxCov + 0.35) : 0;
      for (let c = 0; c < covers.length; c += 3) {
        const j = covers[c], inter = covers[c + 1], focalHit = covers[c + 2] === 1;
        const gj = geo[j];
        let vx = gj.cx - gi.cx, vy = gj.cy - gi.cy;
        let len = Math.sqrt(vx * vx + vy * vy);
        if (len < 1e-6) {
          // Exactly coincident centres — identical media, identical jitter. Without a
          // deterministic escape direction the pair divides by zero and stays welded.
          const a = escapeAngle(j);
          vx = Math.cos(a); vy = Math.sin(a); len = 1;
        }
        vx /= len; vy /= len;

        const mean = (work[i].short + work[j].short) / 2;
        // A covered focal centre is not a matter of degree — it is the one thing the spec
        // says may never happen — so it gets a full step regardless of area.
        let mag = focalHit ? opt.sepStepFrac * mean : 0;
        if (excess > 0 && covSum > 0) {
          mag = Math.max(mag, opt.sepStepFrac * mean * excess * (inter / covSum));
        }
        if (mag <= 0) continue;
        mag *= stepK;
        dx[i] -= vx * mag * 0.5; dy[i] -= vy * mag * 0.5;
        dx[j] += vx * mag * 0.5; dy[j] += vy * mag * 0.5;
      }
    }

    maxCoverage = worst;
    focalHits = hits;

    if (violations === 0) { converged = true; break; }

    for (let i = 0; i < n; i++) {
      work[i].cx += dx[i];
      work[i].cy += dy[i];
    }
  }

  // One last measurement on the FINAL positions — the loop above reports the state it saw
  // before its last push, and reporting a stale number in `stats` would be a lie.
  const geo = buildGeometry(work);
  const grid = broadphase(geo);
  let worst = 0, hits = 0;
  for (let i = 0; i < n; i++) {
    const gi = geo[i];
    let covSum = 0;
    for (const j of grid.query(gi.aabb)) {
      if (j <= i) continue;
      const gj = geo[j];
      if (!aabbHit(gi.aabb, gj.aabb)) continue;
      covSum += intersectArea(gi.photo, gj.outer);
      if (quadHitsCircle(gj.outer, gi.focalX, gi.focalY, work[i].focalR)) hits++;
    }
    const cov = covSum / work[i].photoArea;
    if (cov > worst) worst = cov;
  }
  return { iterations, converged: converged && hits === 0 && worst <= maxCov, maxCoverage: worst, focalHits: hits };
}

function buildGeometry(work) {
  const n = work.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const w = work[i];
    const outer = quad(w.cx, w.cy, w.ow / 2, w.oh / 2, w.cos, w.sin);
    // photo centre = frame centre + (rx, ry) rotated
    const pcx = w.cx + w.rx * w.cos - w.ry * w.sin;
    const pcy = w.cy + w.rx * w.sin + w.ry * w.cos;
    const photo = quad(pcx, pcy, w.w / 2, w.h / 2, w.cos, w.sin);
    const ac = Math.abs(w.cos), as = Math.abs(w.sin);
    const hx = (ac * w.ow + as * w.oh) / 2;
    const hy = (as * w.ow + ac * w.oh) / 2;
    out[i] = {
      outer, photo,
      cx: w.cx, cy: w.cy,
      focalX: pcx + w.fx * w.cos - w.fy * w.sin,
      focalY: pcy + w.fx * w.sin + w.fy * w.cos,
      aabb: { minX: w.cx - hx, minY: w.cy - hy, maxX: w.cx + hx, maxY: w.cy + hy },
    };
  }
  return out;
}

const aabbHit = (a, b) =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

function broadphase(geo) {
  const n = geo.length;
  let span = 0;
  let minX = Infinity, minY = Infinity;
  for (let i = 0; i < n; i++) {
    const a = geo[i].aabb;
    span = Math.max(span, a.maxX - a.minX, a.maxY - a.minY);
    if (a.minX < minX) minX = a.minX;
    if (a.minY < minY) minY = a.minY;
  }
  const cell = Math.max(1, span * 1.05);
  const map = new Map();
  const key = (gx, gy) => gx * 73856093 ^ gy * 19349663;
  for (let i = 0; i < n; i++) {
    const a = geo[i].aabb;
    const x0 = Math.floor((a.minX - minX) / cell), x1 = Math.floor((a.maxX - minX) / cell);
    const y0 = Math.floor((a.minY - minY) / cell), y1 = Math.floor((a.maxY - minY) / cell);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const k = key(gx, gy);
        let b = map.get(k);
        if (!b) { b = []; map.set(k, b); }
        b.push(i);
      }
    }
  }
  return {
    query(a) {
      const x0 = Math.floor((a.minX - minX) / cell), x1 = Math.floor((a.maxX - minX) / cell);
      const y0 = Math.floor((a.minY - minY) / cell), y1 = Math.floor((a.maxY - minY) / cell);
      const seen = new Set();
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          const b = map.get(key(gx, gy));
          if (!b) continue;
          for (let k = 0; k < b.length; k++) seen.add(b[k]);
        }
      }
      // Sorted so the caller's traversal is order-independent regardless of Set insertion.
      return [...seen].sort((p, q) => p - q);
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Validation — the honest measurement, not the solver's own conservative one
// ══════════════════════════════════════════════════════════════════════════════════════════

/**
 * Measure a finished Layout against the rules the spec states.
 *
 *   validateLayout(layout, { maxCoverage, samples }) ->
 *     { ok, count, maxCoverage, meanCoverage, overLimit: [...], focalCovered: [...],
 *       overlapping, boundsExact }
 *
 * Coverage here is the TRUE UNION of everything painted above an item, measured on a
 * `samples` x `samples` lattice over the item's own photo rect (default 64, i.e. ~0.02%
 * quantisation against a 26% threshold). The solver drives on the sum of pairwise areas,
 * which is an upper bound on this, so a layout the solver accepted always passes here — the
 * two can only ever disagree in the safe direction.
 */
export function validateLayout(layout, opts = {}) {
  const maxCov = Number.isFinite(opts.maxCoverage) ? opts.maxCoverage : DEFAULTS.maxCoverage;
  const N = Math.max(8, Math.min(256, Math.floor(opts.samples || 64)));
  const focalFrac = Number.isFinite(opts.focalFrac) ? opts.focalFrac : DEFAULTS.focalFrac;
  const items = (layout && layout.items) || [];
  const n = items.length;

  const geo = items.map((it) => {
    const a = (it.rot || 0) * DEG;
    const cos = Math.cos(a), sin = Math.sin(a);
    const r = outerRect(it);
    const ocx = r.x + r.w / 2, ocy = r.y + r.h / 2;
    const pcx = it.x + it.w / 2, pcy = it.y + it.h / 2;
    // photo centre expressed relative to the rotation origin, then rotated
    const rx = pcx - ocx, ry = pcy - ocy;
    const rpcx = ocx + rx * cos - ry * sin;
    const rpcy = ocy + rx * sin + ry * cos;
    const ac = Math.abs(cos), as = Math.abs(sin);
    const fx = ((it.focal ? it.focal.x : 0.5) - 0.5) * it.w;
    const fy = ((it.focal ? it.focal.y : 0.5) - 0.5) * it.h;
    return {
      cos, sin, ocx, ocy, pcx: rpcx, pcy: rpcy,
      outer: quad(ocx, ocy, r.w / 2, r.h / 2, cos, sin),
      photo: quad(rpcx, rpcy, it.w / 2, it.h / 2, cos, sin),
      aabb: {
        minX: ocx - (ac * r.w + as * r.h) / 2, maxX: ocx + (ac * r.w + as * r.h) / 2,
        minY: ocy - (as * r.w + ac * r.h) / 2, maxY: ocy + (as * r.w + ac * r.h) / 2,
      },
      focalR: focalFrac * Math.min(it.w, it.h),
      focalX: rpcx + fx * cos - fy * sin,
      focalY: rpcy + fx * sin + fy * cos,
    };
  });

  const overLimit = [];
  const focalCovered = [];
  let maxCoverage = 0;
  let sumCoverage = 0;
  let overlapping = 0;

  for (let i = 0; i < n; i++) {
    const gi = geo[i];
    const above = [];
    for (let j = i + 1; j < n; j++) if (aabbHit(gi.aabb, geo[j].aabb)) above.push(j);

    if (above.length) {
      let touches = false;
      for (const j of above) if (intersectArea(gi.photo, geo[j].outer) > 0) { touches = true; break; }
      if (touches) overlapping++;
    }

    let covered = 0;
    if (above.length) {
      const it = items[i];
      const { cos, sin, pcx, pcy } = gi;
      for (let a = 0; a < N; a++) {
        const lx = ((a + 0.5) / N - 0.5) * it.w;
        for (let b = 0; b < N; b++) {
          const ly = ((b + 0.5) / N - 0.5) * it.h;
          const px = pcx + lx * cos - ly * sin;
          const py = pcy + lx * sin + ly * cos;
          for (const j of above) {
            if (pointInQuad(geo[j].outer, px, py)) { covered++; break; }
          }
        }
      }
    }
    const frac = covered / (N * N);
    sumCoverage += frac;
    if (frac > maxCoverage) maxCoverage = frac;
    if (frac > maxCov) overLimit.push({ id: items[i].id, z: items[i].z, coverage: frac });

    for (const j of above) {
      if (quadHitsCircle(geo[j].outer, gi.focalX, gi.focalY, gi.focalR)) {
        focalCovered.push({ id: items[i].id, by: items[j].id });
        break;
      }
    }
  }

  const boundsExact = boundsMatches(layout, items);

  return {
    ok: overLimit.length === 0 && focalCovered.length === 0 && boundsExact,
    count: n,
    maxCoverage,
    meanCoverage: n ? sumCoverage / n : 0,
    overlapping,
    overLimit,
    focalCovered,
    boundsExact,
    samples: N,
  };
}

function boundsMatches(layout, items) {
  if (!layout || !layout.bounds) return false;
  if (!items.length) return true;
  const b = quantBounds(boundsOf(items));
  const t = layout.bounds;
  const eps = 1 / POS_Q + 1e-9;
  return Math.abs(b.minX - t.minX) <= eps && Math.abs(b.minY - t.minY) <= eps &&
    Math.abs(b.maxX - t.maxX) <= eps && Math.abs(b.maxY - t.maxY) <= eps;
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Serialisation — determinism has to be checkable, so it gets a canonical form
// ══════════════════════════════════════════════════════════════════════════════════════════

/**
 * A canonical string for a Layout. Two layouts are identical iff their signatures are equal.
 * Written explicitly rather than trusting `JSON.stringify` key order so that a future field
 * reordering cannot silently make a real difference invisible.
 */
export function layoutSignature(layout) {
  const L = layout || {};
  const parts = [
    "v" + L.version, "seed=" + L.seed, "bg=" + L.background,
    "bounds=" + [L.bounds?.minX, L.bounds?.minY, L.bounds?.maxX, L.bounds?.maxY].join(","),
  ];
  for (const it of L.items || []) {
    parts.push([
      it.id, it.memoryId, it.mediaId, it.kind,
      it.x, it.y, it.w, it.h, it.rot, it.z, it.frame,
      it.aspect, it.loopStartMs, it.loopMs,
      it.frameBox?.dx, it.frameBox?.dy, it.frameBox?.w, it.frameBox?.h,
      it.thumbUrl, it.origUrl,
    ].join("|"));
  }
  return parts.join("\n");
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Queries the renderers need. Pure data, kept here so virtualisation and hit-testing use the
// same geometry the solver used rather than a renderer's approximation of it.
// ══════════════════════════════════════════════════════════════════════════════════════════

/**
 * A uniform-grid spatial index over a Layout. Build once per layout; query per frame.
 *   const ix = buildIndex(layout);
 *   const visible = queryRect(ix, { minX, minY, maxX, maxY });   // z-ascending item indices
 */
export function buildIndex(layout, opts = {}) {
  const items = (layout && layout.items) || [];
  const n = items.length;
  const boxes = new Array(n);
  let span = 0, minX = Infinity, minY = Infinity;
  for (let i = 0; i < n; i++) {
    const a = itemAABB(items[i]);
    boxes[i] = a;
    span = Math.max(span, a.maxX - a.minX, a.maxY - a.minY);
    if (a.minX < minX) minX = a.minX;
    if (a.minY < minY) minY = a.minY;
  }
  if (!n) { minX = 0; minY = 0; }
  const cell = Math.max(1, (opts.cell || span * 1.25) || 1);
  const map = new Map();
  const key = (gx, gy) => gx + "," + gy;
  for (let i = 0; i < n; i++) {
    const a = boxes[i];
    const x0 = Math.floor((a.minX - minX) / cell), x1 = Math.floor((a.maxX - minX) / cell);
    const y0 = Math.floor((a.minY - minY) / cell), y1 = Math.floor((a.maxY - minY) / cell);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const k = key(gx, gy);
        let b = map.get(k);
        if (!b) { b = []; map.set(k, b); }
        b.push(i);
      }
    }
  }
  return { layout, items, boxes, cell, minX, minY, map, key };
}

/** Indices of items whose rotated AABB intersects `rect`, ascending z (paint order). */
export function queryRect(index, rect) {
  if (!index || !index.items.length) return [];
  const { cell, minX, minY, map, key, boxes } = index;
  const x0 = Math.floor((rect.minX - minX) / cell), x1 = Math.floor((rect.maxX - minX) / cell);
  const y0 = Math.floor((rect.minY - minY) / cell), y1 = Math.floor((rect.maxY - minY) / cell);
  const seen = new Set();
  for (let gx = x0; gx <= x1; gx++) {
    for (let gy = y0; gy <= y1; gy++) {
      const b = map.get(key(gx, gy));
      if (!b) continue;
      for (let k = 0; k < b.length; k++) {
        const i = b[k];
        if (seen.has(i)) continue;
        if (aabbHit(boxes[i], rect)) seen.add(i);
      }
    }
  }
  return [...seen].sort((p, q) => p - q);
}

/**
 * The topmost item actually under a canvas-space point, or null. Exact against the rotated
 * FRAME box — a tap on a polaroid's white foot is a tap on that polaroid, and a tap in the
 * gap between two tilted prints is a tap on the board.
 */
export function pickTopAt(layout, x, y, index) {
  const items = (layout && layout.items) || [];
  const ix = index || buildIndex(layout);
  const cands = queryRect(ix, { minX: x, minY: y, maxX: x, maxY: y });
  for (let k = cands.length - 1; k >= 0; k--) {
    const it = items[cands[k]];
    const r = outerRect(it);
    const a = (it.rot || 0) * DEG;
    const cos = Math.cos(a), sin = Math.sin(a);
    const dx = x - (r.x + r.w / 2), dy = y - (r.y + r.h / 2);
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    if (Math.abs(lx) <= r.w / 2 && Math.abs(ly) <= r.h / 2) return it;
  }
  return null;
}

// ── LOD policy, in one place ──────────────────────────────────────────────────────────────
// The media API serves exactly two tiers: a client-made webp thumb whose LONG edge is
// THUMB_LONG_EDGE_PX, and the 4K original. There is no mid tier and functions/ is fenced, so
// the entire LOD decision is this one comparison. Both the interactive renderer and the
// export renderer call it; neither invents its own threshold.
export const THUMB_LONG_EDGE_PX = 480;   // memories.js THUMB_PX. Keep in step.
// Below 1.0 a thumb is being upscaled. 1.15 leaves a little slack so a hair of zoom past
// parity does not immediately pull 4K originals over hostel wifi.
export const SOFTEN_FACTOR = 1.15;

/**
 * Does this item need its 4K original at this zoom?
 *   shouldUseOriginal(item, zoom, dpr) -> boolean
 * `zoom` is the camera scale (canvas units -> CSS px), `dpr` devicePixelRatio.
 * The caller applies this ONLY to the handful of items currently on screen — at the zoom
 * where it starts returning true, that set is small, which is the whole reason this is
 * affordable without a mid tier.
 */
export function shouldUseOriginal(item, zoom, dpr = 1, opts = {}) {
  const thumbPx = opts.thumbPx || THUMB_LONG_EDGE_PX;
  const factor = opts.factor || SOFTEN_FACTOR;
  const longEdge = Math.max(item.w, item.h) * (zoom || 1) * (dpr || 1);
  return longEdge > thumbPx * factor;
}

/** The zoom at which `item` crosses the softening threshold. Useful for prefetch scheduling. */
export function originalZoomFor(item, dpr = 1, opts = {}) {
  const thumbPx = opts.thumbPx || THUMB_LONG_EDGE_PX;
  const factor = opts.factor || SOFTEN_FACTOR;
  const longEdge = Math.max(item.w, item.h) * (dpr || 1);
  return longEdge > 0 ? (thumbPx * factor) / longEdge : Infinity;
}

export default {
  LAYOUT_VERSION, FRAMES, BACKGROUNDS, FRAME_SPECS, DEFAULTS,
  THUMB_LONG_EDGE_PX, SOFTEN_FACTOR,
  layoutCollage, mediaFromMemories, normaliseMedia, makeSeed, rngFrom, hash32,
  frameMetrics, outerRect, photoRect, cornersOf, itemAABB, boundsOf,
  validateLayout, layoutSignature, buildIndex, queryRect, pickTopAt,
  shouldUseOriginal, originalZoomFor,
};


// collage.js — the interactive renderer and the camera for the Memories collage board.
//
// Consumes a LAYOUT (plain data, computed elsewhere by
// collage-layout.js) and turns it into something you can put a finger on. It owns geometry ON
// SCREEN — culling, the camera, gestures, level of detail, the video assignment order — and it
// owns none of the geometry ON THE BOARD. Where an item sits is the layout's answer and this
// file never second-guesses it, which is what lets the export renderer draw the identical
// arrangement from the identical data.
//
// ── ENTRY POINT (this is the whole public surface) ────────────────────────────────────────
//
//   import { mount, unmount, current } from "./collage.js";
//   const board = mount(el, layout, opts);   // -> handle, and the handle IS the unmount fn
//   board();                                 // tear down (=== board.destroy(), === unmount())
//
//   board.setLayout(next)        swap in a new Layout (a re-roll); zoom RATIO is preserved
//   board.camera()               -> { x, y, k, minK, maxK, vw, vh }   screen = canvas*k + (x,y)
//   board.setCamera({x,y,k}, animate=false)   clamped; animate springs
//   board.bounds()               -> padded {minX,minY,maxX,maxY} the camera is clamped to
//   board.limits()               -> { x:{lo,hi}, y:{lo,hi} } legal translation at this scale
//   board.zoomToItem(id, animate=true)        -> boolean
//   board.fit(animate=true)      back to the whole board
//   board.invalidate()           re-measure after an external size change
//   board.retryMissing()         re-request thumbs wearing the not-downloaded tray
//   board.liveIds()              ids that currently have a DOM node (the virtualization)
//   board.originalIds()          ids currently holding a 4K original (the LOD)
//   board.videoIds()             the last published video candidate list, in order
//   board.itemAt(canvasX, canvasY)            topmost item at a canvas point, or null
//   board.root                   the .cg-root element
//
// `mount` returns a FUNCTION with methods hung off it, so it satisfies the app's own view
// contract (`mount(el, ctx) -> unmount`) at the same time as being a handle. The module-level
// `unmount()` tears down whatever is currently mounted and is there for the wiring session, so
// the Memories view toggle can unmount without having kept the handle. See MOUNT OPTIONS at
// the foot of this header for every field of `opts`.
//
// ── THE ONE COMPOSITED TRANSFORM ──────────────────────────────────────────────────────────
// Every item node is positioned ONCE, when it is created, in canvas coordinates. Pan and zoom
// never touch an item again: they write a single `transform` on `.cg-cam`, the layer the items
// live on. That is the difference between a board that pans at 60fps with three hundred prints
// on it and one that spends every frame re-styling three hundred nodes.
//
// The virtualization has a second, less obvious payoff here. A composited layer is rasterised
// over the union of what it paints; because only the items in the viewport plus a margin ring
// exist as nodes at all, that union stays near viewport-sized no matter how big the board is.
// A non-virtualized board would ask the compositor for a layer the size of the whole collage.
//
// `will-change: transform` is applied to `.cg-cam` (and the ground) only while a gesture or an
// animation is actually running, and taken off on settle. A permanent `will-change` is a
// permanent layer, and a permanent layer at high zoom is a permanent texture; the spec calls
// that out as its own bug and it is right.
//
// ── LEVEL OF DETAIL AGAINST THE REAL, TWO-TIER MEDIA API ──────────────────────────────────
// functions/api/media.js serves exactly two things and there is no third:
//     thumb     /media/t/<..>.webp     client-encoded, ~480px on the LONGEST edge
//     original  /media/o/<..>          the untouched 4K file the phone produced
// There is no mid tier and this file may not invent one. So the policy is arithmetic, not
// taste: a thumb is enough while the pixels it has cover the pixels the screen is asking for.
//
//     asking  = item.w * scale * devicePixelRatio      (device px across the item)
//     having  = 480 * min(1, aspect)                   (device px the thumb has across it)
//     ratio   = asking / having
//
// Upgrade to the original above LOD_UP, release it below LOD_DOWN, and LOD_UP > LOD_DOWN is
// the hysteresis — a camera parked exactly on the threshold cannot oscillate, because the two
// thresholds are not the same number. On top of that a released original has to STAY unwanted
// for LOD_RELEASE_MS before its node is dropped, so a pinch that crosses the line and comes
// straight back costs nothing. And the upgrade set is capped (MAX_ORIGINALS) and ordered by
// distance from the viewport centre, because at the zoom where thumbs soften only a handful of
// items are on screen and pulling 4K files for anything else is how you spend a data plan.
//
// ── VIDEO IS HOSTED HERE, NOT PLAYED HERE ─────────────────────────────────────────────────
// iOS caps concurrent video decoders and does not fail gracefully when you pass the cap — you
// do not get a slow video, you get a black rectangle and sometimes a dead pipeline for the rest
// of the page. The pool that fixes that lives in collage-video.js, which owns `<video>`
// elements; this file owns knowing WHICH items deserve one. Every reconcile it publishes an
// ordered, hard-capped candidate list (nearest the viewport centre first) to `opts.video`, and
// the cap is applied HERE as well as there, so a naive consumer physically cannot be handed
// more items than decoders. Without `opts.video` wired the board still works: video items show
// their poster thumb and a play disc, and tapping opens the item in the Memories viewer, which
// is also exactly the correct behaviour under prefers-reduced-motion.
//
// ── CLAMPING ──────────────────────────────────────────────────────────────────────────────
// You may never scroll out past where the pictures are, and you may never hit a hard wall.
// Those are two different requirements and both are load-bearing. The camera is clamped to
// `layout.bounds` (padded, so frame shadows are not shaved at min zoom) on both axes and in
// scale; going past the clamp is possible but RESISTED, with the standard asymptotic rubber
// band, and released it springs back critically damped. Minimum zoom is the scale at which the
// whole board fits, and at min zoom the board is centred rather than pinned to a corner.
//
// ── STYLES ────────────────────────────────────────────────────────────────────────────────
// public/css/collage.css owns APPEARANCE and is another agent's file. This module injects one
// `<style id="cg-base">` holding the STRUCTURAL rules the camera cannot work without —
// containment, transform-origin, touch-action, stacking — because a renderer whose geometry
// can be broken by editing a stylesheet is not a renderer. Everything in that sheet which is
// merely a LOOK is wrapped in `:where()`, which has zero specificity, so any rule at all in
// collage.css wins without needing a single `!important`.
//
// ── ACCESSIBILITY / MOTION INVARIANTS ───────────────────────────────────────────────────────
// Targets are >=44px (items are far larger; the play disc is exactly 44). Text is >=12px. The
// not-downloaded state is a DASHED tray plus a glyph — a shape, never a hue, never opacity on
// text. Animation is transform and opacity only and reads the motion tokens. Reduced motion
// kills momentum, kills the snap-back animation (it snaps), kills the LOD crossfade, and stops
// any video autoplay by never publishing a video candidate list at all.
//
// ── MOUNT OPTIONS ─────────────────────────────────────────────────────────────────────────
//   onOpen(detail)      tap handler. detail = { item, memoryId, mediaId, index, node, rect }.
//                       REQUIRED for tap-to-open. memories.js keeps openViewer() module-private
//                       today, so the wiring session passes a closure over it; this file
//                       deliberately does not reach into that module.
//   onCamera(cam)       called (throttled, and once on settle) with { x, y, k, minK, maxK }.
//   video               { update(list), pause(), resume(), release(node), destroy() } — the
//                       collage-video.js pool. `list` is [{ id, item, node, shot, poster }],
//                       nearest-centre first, length <= videoBudget. Called only when the set
//                       changes. `pause()` on hide/teardown, `resume()` when visible again.
//   frames              { decorate(node, item), release(node, item) } — collage-frames.js.
//                       `decorate` runs once, after the node's structure exists and before it
//                       is inserted; `release` runs when the node is unbound from its item.
//                       They pair around the BINDING, not around DOM attachment: a node that
//                       scrolls out is parked with its decoration intact and re-attached
//                       without a second decorate, so decoration must be idempotent-free and
//                       must not assume it is called every time the node appears on screen.
//   isOnline()          defaults to navigator.onLine. Used only to decide whether a failed
//                       thumb is "not downloaded yet" or a genuine error.
//   background          overrides layout.background (a key; becomes data-bg on the root).
//   ground              false disables the moving ground texture entirely.
//   videoBudget         concurrent decoders. Default VIDEO_POOL (3).
//   maxOriginals        LOD ceiling. Default MAX_ORIGINALS (6).
//   maxScale            absolute zoom ceiling. Default MAX_SCALE.
//   ringPx              margin ring, fraction of the viewport. Default RING.
//   dpr                 override devicePixelRatio (tests).
//   reducedMotion       override the media query (tests).
//   label               accessible name for the board. Default "Collage board".
//
// ── THE GEOMETRY CONTRACT, STATED SO THE EXPORT RENDERER CAN MATCH IT BYTE FOR BYTE ───────
// An item occupies the axis-aligned rect (x, y, w, h) in canvas units and is then rotated by
// `rot` degrees ABOUT ITS OWN CENTRE. In CSS that is `transform: translate3d(x,y,0) rotate(r)`
// with `transform-origin: 50% 50%`; on a 2D canvas it is translate(x+w/2, y+h/2), rotate,
// drawImage(-w/2, -h/2, w, h). Its rotated bounding box — which is what `bounds` must have been
// computed from — is w·|cos r| + h·|sin r| by w·|sin r| + h·|cos r| about the same centre.
//
// Owner prefix .cg-*.

import { reducedMotion as mqReducedMotion, ms } from "./motion.js";
// collage-layout.js is pure data with no imports and no DOM, so pulling one geometry helper in
// costs nothing and buys the thing that matters: ONE definition of where a frame sits. A
// second, local frame model here is exactly how the screen and the export came to disagree.
import { BOARD_LOOK, boardOf, frameMetrics, GROUNDS as GROUND_SPEC, fastenerFor, fastenerGeometry }
  from "./collage-layout.js";
import { GRAIN, POOL_NOISE, WALL_GRAIN, corkTileOf, woodOf } from "./shared/board-look.js";
import { fastHash as fastHashOf } from "./shared/fasteners.js";
// The fastener art. collage-frames.js is the LOOK registry for both renderers, which is why
// the tack and the magnet live there rather than here: the export draws the same two objects
// from the same numbers, and a second copy in this file is how the two would drift.
import { FASTENERS } from "./collage-frames.js";

// ── tunables ──────────────────────────────────────────────────────────────────────────────

/** Margin ring around the viewport that also gets nodes, as a fraction of the viewport. A
 *  bigger ring means fewer reconciles during a fling and more nodes alive; 0.55 is the point
 *  where a hard fling on a phone stops outrunning the hydrator. */
const RING = 0.55;

/** Reconcile once the camera has moved this fraction of the ring since the last one. At 0.4
 *  a fling reconciles roughly every 6-8 frames instead of every frame, and the ring is still
 *  more than twice the distance travelled in between. */
const RECONCILE_AT = 0.4;

/** Zoom-out factor that earns a reconcile mid-gesture. The ring is RING of the viewport in
 *  every direction, so the visible canvas rect may grow by roughly that much before it reaches
 *  items nobody has a node for. Zooming IN never triggers one at all — see reconcileMaybe. */
const ZOOM_OUT_AT = 1.35;

/** Retire ring, as a multiple of the adopt ring. Adopting and retiring at the SAME boundary
 *  means an item sitting on it is created and destroyed on alternate frames, and each cycle
 *  costs a style recalc, a layout and an image decode. Two different boundaries cannot
 *  oscillate. (Measured: pinching in and back out at fit produced ~750ms style/paint tasks
 *  before this and the park cache below existed.) */
const RETIRE_RING = 1.6;

/** How many retired nodes keep their loaded image and stay ready to be re-adopted. A pinch out
 *  and back in is the commonest gesture on this screen and it must not re-decode two hundred
 *  thumbs: parked records are re-attached with `src` untouched, so they cost an appendChild.
 *
 *  Two caps, because the right number during a gesture and the right number at rest are not
 *  the same number. PARK_MAX is what a pinch is allowed to hold — a decoded 480px webp is the
 *  better part of a megabyte, but a board zoomed all the way out has every one of them decoded
 *  anyway, so parking that many during the gesture adds no new peak. PARK_REST is what the
 *  board keeps once the camera has been still for PARK_REST_MS, which is what gives the memory
 *  back on a screen that will be open for a week on a phone with no charger. */
const PARK_MAX = 140;
const PARK_REST = 24;
const PARK_REST_MS = 4000;

/** Node creation budget per frame, in ms. Hydration is incremental precisely because the ring
 *  makes it safe to be late: a node that appears one frame after it entered the ring is still
 *  half a viewport away from being seen. */
const HYDRATE_MS = 4;

/** Budget for the catch-up pass once the camera has stopped. Bigger than HYDRATE_MS because
 *  nothing is competing for the frame any more, but NOT unbounded: filling a whole board in one
 *  task is a visible stall exactly when the user has just let go. */
const SETTLE_MS = 14;

/** iOS hard-caps concurrent video decoders and does NOT degrade gracefully past it — this is
 *  the reason collage-video.js exists at all. Three is the number that survives an iPhone with
 *  Safari's own tabs already holding decoders; it is deliberately not four. */
const VIDEO_POOL = 3;

/** Longest edge of a client-made thumb. memories.js THUMB_PX — restated, not imported, because
 *  importing memories.js from here would drag the whole feed module into the collage bundle.
 *  If that constant ever moves, this LOD arithmetic is what goes wrong. */
const THUMB_LONG_EDGE = 480;

const LOD_UP = 1.35;          // upgrade once the thumb is stretched 35% past its own pixels
const LOD_DOWN = 0.85;        // ...and only let go well below that. The gap IS the hysteresis.
const LOD_RELEASE_MS = 1600;  // and only after it has stayed unwanted this long
const MAX_ORIGINALS = 6;      // 4K files held at once
const MAX_ORIGINAL_FETCHES = 2;

const MAX_SCALE = 6;          // absolute zoom ceiling
const MIN_SCALE_HEADROOM = 3; // ...but never less than 3x the fit scale, or a one-photo board
                              // could not be zoomed at all

const RUBBER = 0.55;          // iOS's own resistance constant
const RUBBER_MAX = 0.32;      // overshoot asymptote, as a fraction of the viewport
const SPRING_W = 15;          // rad/s, critically damped snap-back (~330ms to settle)
const FRICTION = 1.8;         // per second, exponential; a fling coasts ~700ms
const MIN_FLING = 60;         // px/s below which a release is a stop, not a fling

const TAP_SLOP = 10;          // px of travel still counted as a tap
// Minimum touch-target floor, in SCREEN px. itemAt() grows its hit test — never the drawing — so a
// print stays tappable when the board is zoomed out far enough to make it smaller than this.
const MIN_TAP_PX = 44;
const TAP_MS = 550;
const DBL_MS = 280;           // a single tap waits this long to find out it was a double tap
const DBL_SLOP = 32;
const DBL_ZOOM = 2.2;         // double-tap target: this many item-widths across the viewport

/** Reserved for the browser's own back gesture. A pointerdown that starts inside this many px
 *  of the left or right edge is not ours: iOS Safari's interactive back/forward swipe begins
 *  there, and a canvas with `touch-action: none` will happily eat it. Losing the back gesture
 *  inside one view is a much worse bug than losing 22px of pan origin. */
const EDGE_GUARD = 22;

const GROUND_TILE = 96;       // canvas px per ground texture tile
const CAP_PX = 13;            // .cg-cap font-size in BASE_CSS; captions hide below 12px on screen

// ── glyphs (memories.js's vocabulary — the dash is the app's offline shape) ────────────────
const G_MISS = '<path d="M12 4.2v9.2"/><path d="m8.4 10.2 3.6 3.2 3.6-3.2"/><path d="M4.6 16.4v1.8a1.6 1.6 0 0 0 1.6 1.6h1M10.6 19.8h2.8M16.8 19.8h1a1.6 1.6 0 0 0 1.6-1.6v-1.8"/>';
const G_PLAY = '<path d="M9 6.8v10.4l8.4-5.2Z" fill="currentColor" stroke="none"/>';
const svg = (body, cls) =>
  `<svg class="cg-ico ${cls || ""}" viewBox="0 0 24 24" width="24" height="24" fill="none" ` +
  `stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ` +
  `aria-hidden="true">${body}</svg>`;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** An item's FRAME box: `{dx, dy, w, h}`, the outer box of the print relative to the item's
 *  (x, y) photo-box origin, with dx/dy <= 0.
 *
 *  `item.frameBox` is authoritative because it is the number the occlusion solver packed and
 *  the number `layout.bounds` was computed from — recomputing it is only the fallback for a
 *  hand-built item, and it recomputes it with the LAYOUT's own function so the two can never
 *  fork. collage-export.js resolves it identically; that is what makes the exported picture
 *  the same arrangement as the screen. */
function frameBoxOf(it) {
  const f = it && it.frameBox;
  if (f && Number.isFinite(f.w) && Number.isFinite(f.h)) return f;
  return frameMetrics(it.frame, it.w, it.h);
}

// ── the baseline stylesheet ───────────────────────────────────────────────────────────────
// Two layers, and the split is deliberate.
//
// STRUCTURE — containment, transform-origin, touch-action, stacking, the button reset — is
// what the camera cannot work without, so it lives here and not in a stylesheet somebody could
// edit into a broken renderer.
//
// LOOK — frame paper, shadow, caption strip, the play disc — is public/css/collage.css's job
// and another agent's file. These are DEFAULTS, and the cascade is arranged so that file wins
// without needing a single `!important`: the sheet is PREPENDED to <head>, before any author
// stylesheet, so collage.css beats an equal-specificity rule on document order alone. Frame
// rules are attribute selectors (0,2,0) rather than :where() precisely because the app's own
// `button` reset in styles.css is (0,0,1) and would otherwise flatten every frame to nothing —
// which it did, until a screenshot showed polaroids with no paper on them.
const BASE_CSS = `
.cg-root{position:absolute;inset:0;overflow:hidden;touch-action:none;overscroll-behavior:none;
  contain:layout paint;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;
  isolation:isolate;cursor:grab}
.cg-root[data-drag="1"]{cursor:grabbing}
.cg-ground{position:absolute;inset:-60%;transform-origin:0 0;pointer-events:none;z-index:0;
  background-repeat:repeat}
.cg-cam{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;z-index:1}
/* PADDING IS NEVER GEOMETRY HERE, AND THAT IS THE WHOLE POINT.
   An item's outer box and the photo window inside it are two numbers the LAYOUT computed —
   item.frameBox and item.x/y/w/h — and adopt() writes both inline. Deriving either from CSS
   padding is what made this renderer and the export renderer draw different pictures from one
   Layout: a photo box that comes out of a stylesheet cannot match a bounds box that came out
   of the solver, and it silently re-crops every photo through object-fit. Padding stays zero so
   the element's padding box IS its frame box, which is the origin .cg-shot's inline offsets are
   measured from. Frame CSS may paint (paper, radius, shadow); it may not move anything. */
.cg-item{position:absolute;left:0;top:0;margin:0;padding:0;border:0;background:none;
  box-sizing:border-box;
  transform-origin:50% 50%;display:block;-webkit-appearance:none;appearance:none;
  color:inherit;font:inherit;text-align:left;contain:layout style}
.cg-shot{position:absolute;display:block;overflow:hidden}
.cg-shot>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.cg-full{opacity:0}
.cg-full[data-on="1"]{opacity:1}
.cg-miss{position:absolute;inset:0;display:none;place-items:center}
.cg-item[data-miss="1"] .cg-miss{display:grid}
.cg-item[data-miss="1"] .cg-thumb{opacity:0}
.cg-play{position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;
  display:grid;place-items:center;pointer-events:none}
.cg-ui{position:absolute;inset:0;z-index:2;pointer-events:none}
.cg-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip-path:inset(50%);white-space:nowrap;border:0}

/* ---- look: defaults only. collage.css is loaded after this sheet and wins on ties. ---- */
/* The ground is DESIGNED for each theme, not inverted: a tan corkboard behind photographs is
   right in daylight and glares in a tent at 4am. Keyed on [data-lum], the theme FAMILY, so it
   holds for every dark theme rather than for the one that happens to be called "dark". */
/* THE WALL goes on for ever; the BOARD is an object hanging on it, as big as its photos. The wall is plain paint,
   warm off-white by day and a deep warm grey at Night, with a grain so faint it reads as paint, not pattern. */
.cg-root{background:${BOARD_LOOK.wall.light}}
.cg-ground{background-image:${WALL_GRAIN.light}}
:root[data-lum="dark"] .cg-root{background:${BOARD_LOOK.wall.dark}}
:root[data-lum="dark"] .cg-ground{background-image:${WALL_GRAIN.dark}}
/* The board: its material (the chosen ground) on a panel with an edge. Inside the camera, in canvas units, under
   every print; it never takes a tap (the board's own gestures are the root's). One soft shadow on the wall, and
   its edge drawn as a shape (a frame or an edge line), so colour is never the only edge. */
.cg-board{position:absolute;left:0;top:0;pointer-events:none;z-index:0;box-sizing:border-box;
  background-color:var(--cg-ground-fill);background-image:var(--cg-ground-image,none);
  background-size:var(--cg-ground-size,96px) var(--cg-ground-size,96px);background-repeat:repeat;
  box-shadow:${BOARD_LOOK.shadow.light}}
:root[data-lum="dark"] .cg-board{background-color:var(--cg-ground-fill-dk,var(--cg-ground-fill));
  background-image:var(--cg-ground-image-dk,var(--cg-ground-image,none));
  box-shadow:${BOARD_LOOK.shadow.dark}}
/* Corkboard and Slate: a narrow wooden frame, the same wood (darker at Night). */
.cg-board[data-bg="corkboard"],.cg-board[data-bg="slate"]{border:var(--cg-wood,${BOARD_LOOK.frame.corkboard.width}px) solid ${BOARD_LOOK.wood.light};
  box-shadow:${BOARD_LOOK.shadow.light},inset 0 0 0 1px ${BOARD_LOOK.woodInner}}
:root[data-lum="dark"] .cg-board[data-bg="corkboard"],:root[data-lum="dark"] .cg-board[data-bg="slate"]{border-color:${BOARD_LOOK.wood.dark};
  box-shadow:${BOARD_LOOK.shadow.dark},inset 0 0 0 1px ${BOARD_LOOK.woodInner}}
/* Paper and Linen: no frame; their edge line is a hairline on the screen (.cg-edge). */
/* Fridge: an enamel door, rounded corners, no frame. */
.cg-board[data-bg="fridge"]{border-radius:${BOARD_LOOK.frame.fridge.radius}px}
/* The lamp's pool on the wall, behind the board, in the camera (BOARD_LOOK.pool): a radial light and, over it, a faint
   noise as large as the pool (an SVG turbulence, not a tile) that dithers the gradient so it doesn't band. */
.cg-pool{position:absolute;left:0;top:0;pointer-events:none;z-index:0;border-radius:50%;
  background:radial-gradient(closest-side,${BOARD_LOOK.pool.light},rgb(255 252 244 / 0) 100%)}
:root[data-lum="dark"] .cg-pool{background:radial-gradient(closest-side,${BOARD_LOOK.pool.dark},rgb(255 226 186 / 0) 100%)}
.cg-pool::after{content:"";position:absolute;inset:0;border-radius:50%;opacity:${BOARD_LOOK.pool.noise};
  background-image:${POOL_NOISE};
  background-size:100% 100%}
/* The edge moves out as photos arrive (about 300 ms); at once under reduced motion. */
.cg-board[data-grow="1"]{transition:left 300ms cubic-bezier(.2,.7,.2,1),top 300ms cubic-bezier(.2,.7,.2,1),
  width 300ms cubic-bezier(.2,.7,.2,1),height 300ms cubic-bezier(.2,.7,.2,1)}
@media (prefers-reduced-motion: reduce){.cg-board[data-grow="1"]{transition:none}}
/* THE BOARD'S HAIRLINES, on the screen and not in the camera: the paper/linen edge line, the enamel's line and the
   Night rim are screen pixels at any zoom (in board units they were a fraction of a pixel with the board fitted).
   writeCamera() keeps it on the board's edge. */
.cg-edge{position:absolute;left:0;top:0;pointer-events:none;z-index:2;box-sizing:border-box;transform-origin:0 0}
.cg-edge[data-bg="paper"],.cg-edge[data-bg="linen"]{border:${BOARD_LOOK.hair.line}px solid ${BOARD_LOOK.line.light}}
:root[data-lum="dark"] .cg-edge[data-bg="paper"],:root[data-lum="dark"] .cg-edge[data-bg="linen"]{border-color:${BOARD_LOOK.line.dark}}
.cg-edge[data-bg="fridge"]{border:${BOARD_LOOK.hair.enamel}px solid ${BOARD_LOOK.enamel.light}}
:root[data-lum="dark"] .cg-edge[data-bg="fridge"]{border-color:${BOARD_LOOK.enamel.dark}}
:root[data-lum="dark"] .cg-edge{box-shadow:0 0 0 ${BOARD_LOOK.hair.rim}px ${BOARD_LOOK.rim.dark}}
/* THE FASTENER. It hangs above the print's top edge and must not be clipped by it — .cg-item
   is a <button>, whose overflow is visible, and nothing here sets otherwise.

   BOTH THEMES ARE WRITTEN AS CUSTOM PROPERTIES AND CSS PICKS ONE, the same trick the ground
   two rules up uses. The alternative — re-running the style builder on every theme change —
   means JS that has to notice the change, and the collage is the one screen you might be
   looking at when the sun comes up.

   The counter-rotation is on the element itself: the print tilts, the light does not. A
   thumbtack pushed into a board is lit by the room, so its highlight stays at the top no
   matter how the photo is hung. Same transform in the export twin. */
.cg-fast{
  position:absolute; left:0; top:0; pointer-events:none;
  background:var(--f-bg); box-shadow:var(--f-sh);
  border-radius:50%;
}
.cg-fast[data-kind="magnet"]{border-radius:50%}
:root[data-lum="dark"] .cg-fast{
  background:var(--f-bg-dk,var(--f-bg)); box-shadow:var(--f-sh-dk,var(--f-sh));
}
:root[data-lum="dark"] .cg-item[data-frame="polaroid"],
:root[data-lum="dark"] .cg-item[data-frame="print"]{background:var(--cg-paper-dk,#e6dfd1)}
/* THE SHADOW IS box-shadow AND MUST STAY box-shadow. Measured, 240 live nodes, iPhone 15 Pro
   metrics, scripted pan: two stacked drop-shadow filters cost mean 29.5ms / p95 75ms per
   frame; the identical look as box-shadow costs mean 8.3ms / p95 10ms, with zero frames over
   16ms. drop-shadow blurs an offscreen alpha mask per element per raster, and a collage is
   hundreds of elements. A frame is a rectangle, so a rectangle shadow is not an approximation
   — it is the same picture for a tenth of the cost. Only a non-rectangular silhouette (the
   stamp perforation in the list view) has any business using drop-shadow. */
.cg-item{box-shadow:0 1px 1.5px rgba(0,0,0,.20), 0 6px 14px rgba(0,0,0,.22)}
/* The three frames PAINT here; their geometry arrives inline from the layout (see above).
   Polaroid: thick paper border, heavier at the foot, room for a caption. */
.cg-item[data-frame="polaroid"]{background:var(--cg-paper,#fbf8f1);border-radius:3px}
/* Print: thin paper border, classic photo. */
.cg-item[data-frame="print"]{background:var(--cg-paper,#fbf8f1);border-radius:2px}
/* Bare: no frame, just the shadow. */
.cg-item[data-frame="bare"]{background:transparent;border-radius:2px}
.cg-shot{background:var(--cg-well,rgba(0,0,0,.10));border-radius:1px}
/* The caption lives in the polaroid's FOOT, and the foot is a fraction of the item's own
   width (collage-frames.js: 6% sides, 18% foot). --cg-w is set inline by adopt() because a
   percentage in CSS resolves against the containing block, not against the element's own
   width — the custom property is the only way to say "a fraction of me". */
.cg-cap{position:absolute;left:calc(var(--cg-w,150px) * .06);right:calc(var(--cg-w,150px) * .06);
  bottom:0;height:calc(var(--cg-w,150px) * .18);display:flex;align-items:center;
  overflow:hidden;font:500 13px/1.2 var(--font-ui,system-ui);color:var(--ink-2,#4c4535);
  text-overflow:ellipsis;white-space:nowrap}
/* A caption on a zoomable canvas is not UI text, it is part of the object — still enforce
   >=12px so illegible grey mush at 4px never appears; readability is the point of
   exists to stop. Below the zoom where CAP_PX would render under 12px, the polaroid keeps its
   foot and loses the writing. */
.cg-root[data-cap="off"] .cg-cap{display:none}
/* Not downloaded: a DASHED tray plus the glyph, clipped to the frame's own window. Shape, not
   hue, and not opacity: never a hue-only signal. */
.cg-item[data-miss="1"] .cg-shot{outline:2px dashed var(--ink-3,#665f4a);
  outline-offset:-5px;color:var(--ink-3,#665f4a);background:var(--surface-2,#ece4d6)}
/* The play disc sits over arbitrary photography AND over the empty well of a not-downloaded
   item, in both themes. A white ring alone vanishes on a pale sky; a dark ring alone vanishes
   in shadow. A dark disc with a white ring INSIDE and a dark hairline OUTSIDE reads on every
   one of them, and reads by shape rather than by hue. */
.cg-play{color:#fff;background:rgba(12,10,8,.5);border-radius:50%;
  box-shadow:0 0 0 1.5px rgba(255,255,255,.94) inset, 0 0 0 1px rgba(0,0,0,.38),
    0 1px 3px rgba(0,0,0,.35)}
.cg-item[data-focus="1"]{outline:3px solid var(--accent,#476786);outline-offset:3px}
`;

// ONE REGISTRY, TWO SHAPES. The colours come from collage-layout.js — the leaf module both
// renderers import — and the grain is stapled on here. setLayout() below is unchanged and
// still reads {fill, image, darkFill, darkImage}, so this is a change of SOURCE, not of shape.
const GROUNDS = Object.fromEntries(Object.entries(GROUND_SPEC).map(([k, g]) => [k, {
  fill: g.fill.light,
  darkFill: g.fill.dark,
  image: (GRAIN[k] || {}).light || "",
  darkImage: (GRAIN[k] || {}).dark || "",
}]));

let styleEl = null;
function ensureStyles() {
  if (styleEl && styleEl.isConnected) return;
  styleEl = document.getElementById("cg-base");
  if (styleEl) return;
  styleEl = document.createElement("style");
  styleEl.id = "cg-base";
  styleEl.textContent = BASE_CSS;
  // PREPENDED, not appended: see the BASE_CSS header. Being first in <head> is what lets
  // public/css/collage.css override any of the look defaults with the same selector.
  document.head.insertBefore(styleEl, document.head.firstChild);
}

// ── geometry helpers ──────────────────────────────────────────────────────────────────────

/** The rotated bounding box of an item, rotation about its own centre. This is the geometry
 *  contract in the header, in one function; culling and `bounds` must agree or items pop. */
function aabbOf(it) {
  const r = (Number(it.rot) || 0) * Math.PI / 180;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  // THE FRAME BOX, not the photo box: this AABB is what culls, what `bounds` is built from and
  // what double-tap zooms to, and all three have to agree with the box actually painted.
  const f = frameBoxOf(it);
  const w = f.w, h = f.h;
  const bw = w * c + h * s, bh = w * s + h * c;
  const cx = it.x + f.dx + w / 2, cy = it.y + f.dy + h / 2;
  return { x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2, cx, cy };
}

/** Uniform-grid index. A linear scan over 300 items is already cheap, but the reconcile runs
 *  inside a frame that also has to write a transform and hydrate nodes, and a grid turns the
 *  cull from "every item, every reconcile" into "the cells you can see". It is also what keeps
 *  a 2000-item board from quietly becoming the frame budget. */
function buildIndex(items) {
  const boxes = items.map(aabbOf);
  if (!items.length) return { boxes, cell: 1, cols: 0, rows: 0, ox: 0, oy: 0, grid: null };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, sum = 0;
  for (const b of boxes) {
    if (b.x0 < x0) x0 = b.x0; if (b.y0 < y0) y0 = b.y0;
    if (b.x1 > x1) x1 = b.x1; if (b.y1 > y1) y1 = b.y1;
    sum += Math.max(b.x1 - b.x0, b.y1 - b.y0);
  }
  const cell = Math.max(48, (sum / boxes.length) * 1.4);
  const cols = Math.max(1, Math.min(512, Math.ceil((x1 - x0) / cell) + 1));
  const rows = Math.max(1, Math.min(512, Math.ceil((y1 - y0) / cell) + 1));
  const grid = new Array(cols * rows);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const cx0 = clamp(Math.floor((b.x0 - x0) / cell), 0, cols - 1);
    const cx1 = clamp(Math.floor((b.x1 - x0) / cell), 0, cols - 1);
    const cy0 = clamp(Math.floor((b.y0 - y0) / cell), 0, rows - 1);
    const cy1 = clamp(Math.floor((b.y1 - y0) / cell), 0, rows - 1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = cy * cols + cx;
        (grid[k] || (grid[k] = [])).push(i);
      }
    }
  }
  return { boxes, cell, cols, rows, ox: x0, oy: y0, grid };
}

/** Rubber band. Asymptotic, so there is always give and never a wall: push forever and the
 *  overshoot approaches RUBBER_MAX of the viewport and stops getting easier. */
function rubber(over, dim) {
  const d = Math.max(1, dim * RUBBER_MAX);
  const a = Math.abs(over);
  return Math.sign(over) * (1 - 1 / ((a * RUBBER) / d + 1)) * d;
}

// ── the instance ──────────────────────────────────────────────────────────────────────────

let active = null;   // the currently mounted board, for the module-level unmount()

/**
 * Mount the collage board.
 *
 * @param {HTMLElement} el      container. It is filled, not appended to; its `position` is
 *                              forced to `relative` if it is static, and restored on unmount.
 * @param {object} layout       { items, bounds:{minX,minY,maxX,maxY}, seed, background }
 * @param {object} [opts]       see MOUNT OPTIONS in the file header
 * @returns {function} handle   call it to unmount; also carries the methods below
 */
export function mount(el, layout, opts = {}) {
  if (!el) throw new Error("collage: mount needs an element");
  if (active) { try { active.destroy(); } catch { /* a half-dead board is not a reason to fail */ } }
  ensureStyles();

  const reduced = () => (opts.reducedMotion != null ? !!opts.reducedMotion : mqReducedMotion());
  const dpr = () => clamp(opts.dpr || window.devicePixelRatio || 1, 1, 3);
  const online = () => (opts.isOnline ? !!opts.isOnline() : navigator.onLine !== false);
  const videoBudget = Math.max(0, opts.videoBudget == null ? VIDEO_POOL : opts.videoBudget | 0);
  const maxOriginals = Math.max(0, opts.maxOriginals == null ? MAX_ORIGINALS : opts.maxOriginals | 0);
  const ringFrac = opts.ringPx == null ? RING : Math.max(0.1, opts.ringPx);

  // ── DOM ────────────────────────────────────────────────────────────────────────────────
  const hostPos = el.style.position;
  if (getComputedStyle(el).position === "static") el.style.position = "relative";

  const root = document.createElement("div");
  root.className = "cg-root";
  root.tabIndex = 0;
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", opts.label || "Collage board");
  root.setAttribute("aria-roledescription", "Pan and zoom board");

  const ground = document.createElement("div");
  ground.className = "cg-ground";
  const cam = document.createElement("div");
  cam.className = "cg-cam";
  // The board: the first thing in the camera, under every print (boardOf: its size from the photos on it).
  const boardEl = document.createElement("div");
  boardEl.className = "cg-board";
  boardEl.setAttribute("aria-hidden", "true");
  // The lamp's pool on the wall, under the board.
  const poolEl = document.createElement("div");
  poolEl.className = "cg-pool";
  poolEl.setAttribute("aria-hidden", "true");
  cam.appendChild(boardEl);
  cam.insertBefore(poolEl, boardEl);
  let board = null;
  const ui = document.createElement("div");
  ui.className = "cg-ui";
  const live = document.createElement("p");
  live.className = "cg-sr";
  live.setAttribute("aria-live", "polite");
  ui.appendChild(live);

  const edgeEl = document.createElement("div");
  edgeEl.className = "cg-edge";
  edgeEl.setAttribute("aria-hidden", "true");
  root.append(ground, cam, edgeEl, ui);
  el.appendChild(root);

  // ── state ──────────────────────────────────────────────────────────────────────────────
  let items = [], index = null, byId = new Map();
  let vw = 1, vh = 1;
  // Whether the camera has been set against a real size: a board mounted into a hidden stage gets its first
  // fit at 1×1, which means nothing, and must be fitted again once it has a size (whoever measures it first).
  let framed = false;
  let minK = 1, maxK = MAX_SCALE;
  let insetB = 0;                     // the foot band the fit keeps clear (opts.fitInset), screen px
  let insetT = 0;                     // the head band it keeps clear, when the board would reach under it
  let pad = { x0: 0, y0: 0, x1: 1, y1: 1 };

  // The camera. screen = canvas * k + (x, y).
  const C = { x: 0, y: 0, k: 1 };
  let vx = 0, vy = 0;                 // fling velocity, screen px/s
  let anim = null;                    // { kind: 'spring'|'tween', ... }
  let raf = 0, lastTs = 0, running = false;

  const nodes = new Map();            // item id -> node record, currently in the DOM
  const parked = new Map();           // item id -> node record, detached but still loaded
  const free = [];                    // blank records, ready to be bound to anything
  let hydrateQueue = [];              // ids waiting for a node
  let lastReconcileCam = null;
  let dirtyView = true;
  let settled = false;

  // Dedupe marks for the grid query. An item can sit in several cells, and stamping is how a
  // query visits it once without allocating a Set per frame.
  let visitBuf = new Int32Array(0), visitTick = 0;

  let lastVideoIds = "";
  let lodTimer = 0, lastLod = 0;
  let inFlight = 0;
  let destroyed = false;
  let camNotifyAt = 0;

  // ── layout ingestion ───────────────────────────────────────────────────────────────────
  // THE GLIDE. A re-layout (photos added or taken away) re-flows the rows; each print already on the board glides
  // from where it was to its new place over about 300 ms, together with the board's edge, and ends exactly on the
  // new layout. Where every print was, by id, for the moment the new layout's nodes are placed.
  let glideFrom = null, glideUntil = 0;
  const placeOf = (it) => { const fb = frameBoxOf(it); return { w: fb.w, h: fb.h, t: `translate3d(${it.x + fb.dx}px, ${it.y + fb.dy}px, 0) rotate(${it.rot || 0}deg)` }; };
  function setLayout(next) {
    if (items.length && !reduced()) {
      glideFrom = new Map(items.map((it) => [it.id, placeOf(it)]));
      glideUntil = performance.now() + 400;
    } else glideFrom = null;
    layout = next || { items: [], bounds: null };
    items = Array.isArray(layout.items) ? layout.items : [];
    byId = new Map();
    for (let i = 0; i < items.length; i++) byId.set(items[i].id, i);
    index = buildIndex(items);
    visitBuf = new Int32Array(items.length);
    visitTick = 0;

    const b = layout.bounds && Number.isFinite(layout.bounds.minX)
      ? layout.bounds
      : items.length ? boundsFromItems() : null;
    // The camera's world is the board and a band of wall round it: it opens on that, and can't leave it, so
    // some of the board always shows and zoomed right out the whole board does.
    const was = board;
    board = boardOf(b, layout.stats && layout.stats.targetWidth, layout.stats && layout.stats.boardTall);
    pad = { x0: board.wall.x, y0: board.wall.y, x1: board.wall.x + board.wall.w, y1: board.wall.y + board.wall.h };
    // A board that grows (photos added) moves its edge out over about 300 ms; the first one is just there.
    boardEl.dataset.grow = was && (was.w !== board.w || was.h !== board.h || was.x !== board.x || was.y !== board.y) ? "1" : "0";
    // The edge's hairlines follow the board's edge out over the same 300 ms (none under reduced motion).
    edgeEl.style.transition = boardEl.dataset.grow === "1" && !reduced()
      ? "transform 300ms cubic-bezier(.2,.7,.2,1), width 300ms cubic-bezier(.2,.7,.2,1), height 300ms cubic-bezier(.2,.7,.2,1)" : "";
    if (edgeEl.style.transition) setTimeout(() => { edgeEl.style.transition = ""; }, 340);
    {
      const R = (BOARD_LOOK.pool.size * Math.max(board.w, board.h)) / 2;
      poolEl.style.left = `${board.x + board.w / 2 - R}px`;
      poolEl.style.top = `${board.y + board.h / 2 - R}px`;
      poolEl.style.width = poolEl.style.height = `${2 * R}px`;
    }
    boardEl.style.left = `${board.x}px`;
    boardEl.style.top = `${board.y}px`;
    boardEl.style.width = `${board.w}px`;
    boardEl.style.height = `${board.h}px`;
    boardEl.style.setProperty("--cg-wood", `${woodOf(board)}px`);
    edgeEl.dataset.bg = groundKey();

    const key = groundKey();
    root.dataset.bg = key;
    boardEl.dataset.bg = key;
    boardEl.style.setProperty("--cg-ground-size", `${key === "corkboard" ? corkTileOf(board) : GROUND_TILE}px`);
    const g = GROUNDS[key];
    if (opts.ground === false) {
      ground.style.display = "none";
    } else {
      ground.style.display = "";
      // Set as custom properties so collage.css can redefine either half per theme without
      // this module knowing what a corkboard looks like in the dark. The `-dk` pair is picked
      // up by the theme rules in BASE_CSS; a registry entry with no dark half falls back to
      // its light one rather than disappearing.
      root.style.setProperty("--cg-ground-fill", (g && g.fill) || "");
      root.style.setProperty("--cg-ground-image", (g && g.image) || "");
      root.style.setProperty("--cg-ground-fill-dk", (g && g.darkFill) || (g && g.fill) || "");
      root.style.setProperty("--cg-ground-image-dk", (g && g.darkImage) || (g && g.image) || "");
    }

    // Every live node is now suspect: ids may have gone, geometry may have moved. Nothing may
    // stay parked across a layout swap — a parked record is a bet that its item is unchanged.
    releaseAll();
    hydrateQueue = [];
    measure();
    dirtyView = true;
    lastReconcileCam = null;
    lastVideoIds = "";
  }

  function boundsFromItems() {
    if (!items.length) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of index.boxes) {
      if (b.x0 < minX) minX = b.x0; if (b.y0 < minY) minY = b.y0;
      if (b.x1 > maxX) maxX = b.x1; if (b.y1 > maxY) maxY = b.y1;
    }
    return { minX, minY, maxX, maxY };
  }

  // ── viewport + clamps ──────────────────────────────────────────────────────────────────
  function measure() {
    // A board with no size (hidden behind the List or Feed view) measures nothing: the camera keeps
    // the terms it was set in, so a layout handed to it meanwhile (setLayout) and its return to the
    // screen find the place the person left. Measured at 1×1, the pan was clamped to a 1-pixel
    // screen's one legal position and came back elsewhere.
    if (root.offsetWidth <= 1 || root.offsetHeight <= 1) return;
    // The board's own layout size, never its box on the screen: the view's entrance scales it
    // (.98 to 1), and a fit measured mid-entrance landed anywhere between 0.98x and 1.02x of right.
    vw = Math.max(1, root.offsetWidth);
    vh = Math.max(1, root.offsetHeight);
    const bw = pad.x1 - pad.x0, bh = pad.y1 - pad.y0;
    // Min zoom is CONTAIN: the whole board visible. That is the literal reading of "you can
    // only zoom out to where the pictures are" — cover would hide the far edge of a board
    // whose aspect differs from the phone's, which is most boards.
    // Bands the opening fit keeps clear: at the foot the page's floating +, at the head the controls floating at its
    // right (from `left` to the edge). The board fits between them, and only a pan or a zoom takes it under. The head
    // band counts only when the board, fitted without it, would reach under those controls. Each band has a ceiling
    // so a board always opens with room: the foot's is 40% of the stage (on a 320 x 568 phone the + takes 38%; at
    // 30% a small board opened under it), the head's 30%.
    insetB = 0; insetT = 0;
    let ins = null;
    try { ins = opts.fitInset ? opts.fitInset() : null; } catch { ins = null; }
    const band = (v, most) => Math.max(0, Math.min(vh * most, Number(v) || 0));
    insetB = band(ins && ins.bottom, 0.4);
    const k0 = Math.min(vw / bw, (vh - insetB) / bh);
    if (ins && ins.top > 0 && !((vw + bw * k0) / 2 <= (Number(ins.topLeft) || 0))) insetT = band(ins.top, 0.3);
    minK = Math.min(vw / bw, (vh - insetT - insetB) / bh);
    // Sanitise BEFORE maxK is derived from it: a degenerate bounds box (one item, zero span,
    // a layout still being built) must not turn maxK into NaN and every clamp with it.
    if (!Number.isFinite(minK) || minK <= 0) minK = 1;
    maxK = Math.max(opts.maxScale || MAX_SCALE, minK * MIN_SCALE_HEADROOM);
  }

  /** Where the camera translation is allowed to be on one axis at scale k. When the content is
   *  narrower than the viewport there is exactly one legal position — centred — and both ends
   *  of the range collapse onto it, which is what makes min zoom centre itself for free. */
  // THE BOARD CAN'T BE LOST. The view may pass the board's edge by its band of wall, but never by more than half
  // the view itself: zoomed in at an edge, at least half the screen is board (a third was all frame at 600%). The
  // shared board's page stops at the same place (src/share-page.js panLimit). With the board fitted
  // the view is wider than the wall's whole extent, so the allowance is the band and the opening is as it was.
  function limit(k, axis) {
    const view = axis === "x" ? vw : vh;
    const head = axis === "y" ? insetT : 0, foot = axis === "y" ? insetB : 0;
    const eff = view - head - foot;                     // the height between the bands the fit keeps clear
    const b0 = board ? (axis === "x" ? board.x : board.y) : (axis === "x" ? pad.x0 : pad.y0);
    const b1 = board ? b0 + (axis === "x" ? board.w : board.h) : (axis === "x" ? pad.x1 : pad.y1);
    const band = board ? b0 - (axis === "x" ? pad.x0 : pad.y0) : 0;
    const allow = Math.min(band, view / (2 * k));
    const c0 = b0 - allow;
    const c1 = b1 + allow;
    const span = (c1 - c0) * k;
    if (span <= eff) {
      const t = head + (eff - span) / 2 - c0 * k;
      return { lo: t, hi: t };
    }
    // Taller than the clear height but not the screen: anywhere from top at the top to foot at the band.
    if (span <= view) return { lo: Math.min(view - foot - c1 * k, head - c0 * k), hi: Math.max(view - foot - c1 * k, head - c0 * k) };
    return { lo: view - c1 * k, hi: -c0 * k };
  }

  const clampT = (t, k, axis) => {
    const l = limit(k, axis);
    return clamp(t, l.lo, l.hi);
  };

  /** Scale resistance, asymptotic in the same spirit as the translation rubber band: pinching
   *  past a zoom limit gives a little and then stops giving, however hard you pull. A plain
   *  power curve (which this used to be) has no floor — squeeze hard enough and the whole board
   *  shrinks to a postage stamp in a sea of corkboard before snapping back, which reads as a
   *  bug. The floor here is minK/(1+SCALE_GIVE) and the ceiling maxK*(1+SCALE_GIVE). */
  const SCALE_GIVE = 0.34;
  function looseScale(k) {
    if (k < minK) {
      const u = minK / k - 1;                       // how far under, in ratio terms
      return minK / (1 + SCALE_GIVE * (u / (u + 1)));
    }
    if (k > maxK) {
      const u = k / maxK - 1;
      return maxK * (1 + SCALE_GIVE * (u / (u + 1)));
    }
    return k;
  }

  /** Apply the camera with resistance instead of a wall. */
  function applyLoose(x, y, k) {
    C.k = looseScale(k);
    const lx = limit(C.k, "x"), ly = limit(C.k, "y");
    C.x = x < lx.lo ? lx.lo + rubber(x - lx.lo, vw) : x > lx.hi ? lx.hi + rubber(x - lx.hi, vw) : x;
    C.y = y < ly.lo ? ly.lo + rubber(y - ly.lo, vh) : y > ly.hi ? ly.hi + rubber(y - ly.hi, vh) : y;
  }

  function outOfBounds() {
    if (C.k < minK - 1e-6 || C.k > maxK + 1e-6) return true;
    const lx = limit(C.k, "x"), ly = limit(C.k, "y");
    return C.x < lx.lo - 0.5 || C.x > lx.hi + 0.5 || C.y < ly.lo - 0.5 || C.y > ly.hi + 0.5;
  }

  function settledTarget() {
    const k = clamp(C.k, minK, maxK);
    // Re-anchor on the viewport centre so a scale snap-back does not also slide the board.
    const cx = (vw / 2 - C.x) / C.k, cy = (vh / 2 - C.y) / C.k;
    let x = vw / 2 - cx * k, y = vh / 2 - cy * k;
    return { x: clampT(x, k, "x"), y: clampT(y, k, "y"), k };
  }

  // ── the frame loop ─────────────────────────────────────────────────────────────────────
  function schedule() { if (!raf && !destroyed) raf = requestAnimationFrame(tick); }

  function setBusy(on) {
    if (on === running) return;
    running = on;
    // Tight will-change: a layer while it moves, no layer while it sits.
    cam.style.willChange = on ? "transform" : "";
    ground.style.willChange = on ? "transform" : "";
  }

  function tick(ts) {
    raf = 0;
    if (destroyed) return;
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 1 / 60;
    lastTs = ts;
    if (dirtyView) settled = false;   // anything that moved the camera re-opens the settle pass

    let busy = drag.active;
    if (!drag.active) busy = integrate(dt) || busy;

    writeCamera();
    reconcileMaybe();
    hydrateSome();
    lodMaybe(ts);
    if (busy) notifyCamera(false);

    if (busy) { settled = false; setBusy(true); schedule(); return; }
    setBusy(false);
    if (hydrateQueue.length) { schedule(); return; }
    lastTs = 0;
    // onSettle refills the ring generously now that nothing else wants the frame, so it can
    // enqueue more hydration; `settled` is what stops that from looping forever.
    if (!settled) { settled = true; onSettle(); if (hydrateQueue.length) schedule(); }
  }

  function integrate(dt) {
    if (anim) {
      // Critically damped spring. It is the same integrator for the snap-back and for
      // double-tap/zoom-to, so an interrupted animation always hands over its velocity
      // instead of teleporting.
      const w = SPRING_W, t = anim.to;
      const step = (cur, vel, to) => {
        const a = -w * w * (cur - to) - 2 * w * vel;
        const nv = vel + a * dt;
        return [cur + nv * dt, nv];
      };
      [C.x, anim.vx] = step(C.x, anim.vx, t.x);
      [C.y, anim.vy] = step(C.y, anim.vy, t.y);
      [C.k, anim.vk] = step(C.k, anim.vk, t.k);
      // The scale test is RELATIVE: an absolute epsilon that reads as "arrived" at min zoom
      // (k ~ 0.1) is four orders of magnitude too strict at max zoom, and the spring would
      // crawl the last fraction of a percent for a second.
      const done = Math.abs(C.x - t.x) < 0.3 && Math.abs(C.y - t.y) < 0.3 &&
        Math.abs(C.k - t.k) < Math.max(1e-4, t.k * 8e-4) &&
        Math.abs(anim.vx) < 12 && Math.abs(anim.vy) < 12;
      if (done) { C.x = t.x; C.y = t.y; C.k = t.k; anim = null; vx = vy = 0; return false; }
      return true;
    }
    if (vx || vy) {
      const decay = Math.exp(-FRICTION * dt);
      vx *= decay; vy *= decay;
      applyLoose(C.x + vx * dt, C.y + vy * dt, C.k);
      if (Math.abs(vx) < MIN_FLING && Math.abs(vy) < MIN_FLING) { vx = vy = 0; }
      // The moment a fling carries the board past its edge, hand it to the spring. That is
      // what makes the boundary feel like resistance rather than a stop.
      if (outOfBounds()) { springTo(settledTarget(), vx, vy); vx = vy = 0; }
      return true;
    }
    return false;
  }

  function springTo(to, ivx = 0, ivy = 0) {
    if (reduced()) { C.x = to.x; C.y = to.y; C.k = to.k; anim = null; vx = vy = 0; dirtyView = true; return; }
    anim = { to, vx: ivx, vy: ivy, vk: 0 };
    schedule();
  }

  function writeCamera() {
    const d = dpr();
    // Snap to device pixels: an unsnapped composited translate shimmers text and hairlines,
    // and a print's white border is a hairline.
    const px = Math.round(C.x * d) / d, py = Math.round(C.y * d) / d;
    cam.style.transform = `translate3d(${px}px, ${py}px, 0) scale(${C.k})`;
    if (board) {
      edgeEl.style.transform = `translate3d(${px + board.x * C.k}px, ${py + board.y * C.k}px, 0)`;
      edgeEl.style.width = `${board.w * C.k}px`;
      edgeEl.style.height = `${board.h * C.k}px`;
      edgeEl.style.borderRadius = edgeEl.dataset.bg === "fridge" ? `${BOARD_LOOK.frame.fridge.radius * C.k}px` : "";
    }
    // Captions blink out below the zoom where they would be under 12px on screen. One
    // attribute on the root, written only when it changes, so this is not a per-frame cost.
    const capOn = CAP_PX * C.k >= 12;
    if (capOn !== capShown) { capShown = capOn; root.dataset.cap = capOn ? "on" : "off"; }
    writeGround(px, py);
  }
  let capShown = null;

  /** The ground moves with the board, and costs nothing per frame.
   *
   *  A tiled texture cannot simply be re-positioned every frame — background-position is a
   *  repaint of a viewport-sized layer, sixty times a second, on a phone. So the ground gets
   *  its own composited layer whose texture is rasterised at a QUANTIZED scale (powers of two)
   *  and whose transform carries the residual: panning writes only `transform` (composited, no
   *  repaint), and the texture re-rasterises once per zoom octave rather than once per frame.
   *  Same trick a map tile layer plays, for the same reason. */
  let groundOctave = null;
  function writeGround(px, py) {
    if (opts.ground === false) return;
    const kq = Math.pow(2, Math.floor(Math.log2(Math.max(1e-6, C.k))));
    const r = C.k / kq;                       // residual, always in [1, 2)
    if (groundOctave !== kq) {
      groundOctave = kq;
      const s = GROUND_TILE * kq;
      ground.style.backgroundSize = `${s}px ${s}px, ${s}px ${s}px, ${s}px ${s}px, ${s}px ${s}px`;
    }
    const tile = GROUND_TILE * kq;            // pre-scale period
    const ex = -0.6 * vw, ey = -0.6 * vh;     // the ground element's own origin (inset:-60%)
    const mod = (a, n) => ((a % n) + n) % n;
    const dx = mod((px - ex) / r, tile) - tile;
    const dy = mod((py - ey) / r, tile) - tile;
    ground.style.transform = `scale(${r}) translate3d(${dx}px, ${dy}px, 0)`;
  }

  function onSettle() {
    reconcile(true);
    runLod();
    publishVideo();
    notifyCamera(true);
    // Give the park cache back if the camera really has stopped. Rescheduled on every settle,
    // so a board being worked stays fast and a board left open stops holding bitmaps.
    clearTimeout(parkTimer);
    parkTimer = setTimeout(drainPark, PARK_REST_MS);
  }
  let parkTimer = 0;

  function notifyCamera(force) {
    if (!opts.onCamera) return;
    const now = performance.now();
    if (!force && now - camNotifyAt < 120) return;
    camNotifyAt = now;
    try { opts.onCamera({ x: C.x, y: C.y, k: C.k, minK, maxK }); } catch (e) { console.error("[collage]", e); }
  }

  // ── virtualization ─────────────────────────────────────────────────────────────────────
  function viewRect(ring, mult = 1) {
    const m = ring ? ringFrac * mult : 0;
    const x0 = (-C.x - vw * m) / C.k, y0 = (-C.y - vh * m) / C.k;
    const x1 = (-C.x + vw * (1 + m)) / C.k, y1 = (-C.y + vh * (1 + m)) / C.k;
    return { x0, y0, x1, y1 };
  }

  function query(rect, out) {
    out.length = 0;
    if (!index || !index.grid) return out;
    const { cell, cols, rows, ox, oy, grid, boxes } = index;
    const cx0 = clamp(Math.floor((rect.x0 - ox) / cell), 0, cols - 1);
    const cx1 = clamp(Math.floor((rect.x1 - ox) / cell), 0, cols - 1);
    const cy0 = clamp(Math.floor((rect.y0 - oy) / cell), 0, rows - 1);
    const cy1 = clamp(Math.floor((rect.y1 - oy) / cell), 0, rows - 1);
    visitTick++;
    for (let cy = cy0; cy <= cy1; cy++) {
      const base = cy * cols;
      for (let cx = cx0; cx <= cx1; cx++) {
        const bucket = grid[base + cx];
        if (!bucket) continue;
        for (let n = 0; n < bucket.length; n++) {
          const i = bucket[n];
          if (visitBuf[i] === visitTick) continue;
          visitBuf[i] = visitTick;
          const b = boxes[i];
          if (b.x1 < rect.x0 || b.x0 > rect.x1 || b.y1 < rect.y0 || b.y0 > rect.y1) continue;
          out.push(i);
        }
      }
    }
    return out;
  }

  const qbuf = [];

  function reconcileMaybe() {
    if (dirtyView || !lastReconcileCam) { reconcile(false); return; }
    const p = lastReconcileCam;
    // How far has the camera moved, in screen px, since the ring was last drawn? Reconcile
    // once that eats RECONCILE_AT of the ring — never every frame.
    const moved = Math.hypot(C.x - p.x, C.y - p.y);
    if (moved > Math.min(vw, vh) * ringFrac * RECONCILE_AT) { reconcile(false); return; }
    // ZOOM IS ASYMMETRIC AND TREATING IT AS SYMMETRIC IS EXPENSIVE. Zooming IN shrinks the
    // canvas rectangle the viewport covers: it can never reveal an item that was not already
    // inside the ring, so there is nothing to adopt, and the items it pushes off screen are
    // already decoded and cost nothing to leave alone until the gesture ends. Zooming OUT is
    // the only direction that needs new nodes.
    //
    // This matters far more than it looks. Traced over a scripted pinch at 240 items, image
    // DECODE was 19s of the run against 5s of main thread; a node adopted mid-pinch must be
    // decoded at whatever raster scale the pinch is passing through, so reconciling on every
    // small zoom step turns one gesture into hundreds of throwaway decodes. Reconciling only
    // on a meaningful zoom-OUT removed almost all of them.
    if (C.k < p.k * (1 / ZOOM_OUT_AT)) reconcile(false);
  }

  function reconcile(final) {
    dirtyView = false;
    lastReconcileCam = { x: C.x, y: C.y, k: C.k };
    // ONE query, at the retire ring; the adopt ring is a rect test on the results. Two rings,
    // so the boundary an item sits on to be created is not the boundary it sits on to be
    // destroyed, and a camera parked on either one cannot churn.
    const keepR = viewRect(true, RETIRE_RING);
    const addR = viewRect(true);
    query(keepR, qbuf);

    const keep = new Set();
    for (let n = 0; n < qbuf.length; n++) keep.add(items[qbuf[n]].id);
    for (const id of nodes.keys()) if (!keep.has(id)) retire(id);

    hydrateQueue = [];
    for (let n = 0; n < qbuf.length; n++) {
      const i = qbuf[n];
      const b = index.boxes[i];
      if (b.x1 < addR.x0 || b.x0 > addR.x1 || b.y1 < addR.y0 || b.y0 > addR.y1) continue;
      if (!nodes.has(items[i].id)) hydrateQueue.push(i);
    }
    if (hydrateQueue.length) {
      // Nearest the viewport centre first: if the budget runs out, the holes are in the ring
      // where nobody can see them, not in the middle of the screen.
      const ccx = (vw / 2 - C.x) / C.k, ccy = (vh / 2 - C.y) / C.k;
      hydrateQueue.sort((a, b) => {
        const A = index.boxes[a], B = index.boxes[b];
        return ((A.cx - ccx) ** 2 + (A.cy - ccy) ** 2) - ((B.cx - ccx) ** 2 + (B.cy - ccy) ** 2);
      });
      if (final) hydrateSome(SETTLE_MS);
      schedule();
    }
  }

  /** Two budgets, because there are two kinds of adopt and only one of them is expensive.
   *  Re-attaching a PARKED record is an appendChild and costs nothing worth counting. Binding a
   *  fresh record assigns a `src`, and the fetch, decode and raster that follow land AFTER this
   *  function has returned — outside any wall-clock budget it could keep. So fresh adopts are
   *  counted, not timed: at most FRESH_PER_FRAME image loads may start in one frame, which is
   *  what turns "two hundred thumbs decode at once" into a queue that drains over a few frames
   *  with the ring covering for it. */
  const FRESH_PER_FRAME = 24;
  function hydrateSome(budget) {
    if (!hydrateQueue.length) return;
    const cap = budget == null ? HYDRATE_MS : budget;
    const freshCap = cap === Infinity ? Infinity : FRESH_PER_FRAME;
    const t0 = performance.now();
    let fresh = 0;
    while (hydrateQueue.length) {
      const i = hydrateQueue.shift();
      const it = items[i];
      if (it && !nodes.has(it.id)) {
        if (!parked.has(it.id)) {
          if (fresh >= freshCap) { hydrateQueue.unshift(i); break; }
          fresh++;
        }
        adopt(it);
      }
      if (cap !== Infinity && performance.now() - t0 > cap) break;
    }
  }

  // ── nodes ──────────────────────────────────────────────────────────────────────────────
  function makeRecord() {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "cg-item";
    node.tabIndex = -1;   // keyboard drives the CAMERA, not a tab walk through 300 prints;
                          // the buttons stay real so pointer + assistive cursors work.
    const shot = document.createElement("span");
    shot.className = "cg-shot";
    const thumb = document.createElement("img");
    thumb.className = "cg-thumb";
    // Built with the node, never in adopt()'s fast path: a PARKED record comes straight back
    // into the DOM without re-running decoration, so anything created later would be missing on
    // every re-adopt. Sized and styled in the write below, which DOES run every time.
    const fast = document.createElement("span");
    fast.className = "cg-fast";
    fast.hidden = true;
    thumb.alt = "";
    thumb.decoding = "async";
    const miss = document.createElement("span");
    miss.className = "cg-miss";
    miss.innerHTML = svg(G_MISS);
    shot.append(thumb, miss);
    const cap = document.createElement("span");
    cap.className = "cg-cap";
    node.append(shot, cap, fast);
    const rec = { node, shot, thumb, cap, miss, fast, full: null, play: null, item: null, lodAt: 0 };
    // THE ONLY CLICKS THIS HANDLER MAY ACT ON ARE THE SYNTHETIC ONES. A finger tap produces
    // BOTH a pointer sequence (which the gesture recognizer below turns into an open, after
    // waiting out the double-tap window) and a native `click` — acting on both opened the
    // viewer twice, and made a double-tap-to-zoom open the viewer as well as zooming. The
    // discriminator is `detail`: a pointer-driven click carries the click count (>=1), while a
    // click synthesised by VoiceOver or by keyboard activation carries 0. So the recognizer
    // owns touch and mouse, and this handler exists purely so assistive technology can still
    // activate an item. The time guard is the belt to that pair of braces.
    node.addEventListener("click", (e) => {
      e.preventDefault();
      if (e.detail !== 0) return;
      if (performance.now() - lastPointerUp < 800) return;
      openItem(rec.item);
    });
    return rec;
  }

  /** The ground in force right now. One expression, because two would drift. */
  const groundKey = () => opts.background || (layout && layout.background) || "corkboard";

  /* FNV-1a over the layout seed and the item id. The essence file is emphatic that nothing in
     it may call Math.random() — the export harness asserts two exports of one Layout are
     byte-identical — so per-instance variety has to come from a stream both renderers can
     reproduce. This is that stream, and collage-export.js computes it the same way. */
  const fastHash = (it) => fastHashOf((layout && layout.seed) || 0, it.id);

  /**
   * THE FASTENER, on screen. Which one is the GROUND's decision and never the photo's —
   * enforced directly as a one-line lookup here precisely because the
   * ground registry carries it.
   *
   * BOTH THEMES ARE WRITTEN, and CSS picks. See the .cg-fast rules above.
   *
   * THE LIGHT DOES NOT ROTATE. The print tilts; the room's lamp does not. So the element
   * carries rotate(-rot), which cancels the parent's tilt and leaves the specular at the top of
   * the head. collage-export.js does the identical counter-rotation, and the parity check now
   * asserts the two agree rather than trusting that sentence.
   */
  function paintFastener(rec, it, fb) {
    const el = rec.fast;
    if (!el) return;
    const kind = fastenerFor(groundKey());
    if (!kind) { el.hidden = true; return; }

    const geo = fastenerGeometry(kind, fb, fastHash(it));
    const pal = kind === "magnet" ? FASTENERS.MAGNETS : FASTENERS.TACKS;
    const styleOf = kind === "magnet" ? FASTENERS.magnetStyle : FASTENERS.tackStyle;
    const li = pal.light[geo.variant % pal.light.length];
    const dk = pal.dark[geo.variant % pal.dark.length];
    const a = styleOf(geo.d, li, "light");
    const b = styleOf(geo.d, dk, "dark");

    el.dataset.kind = kind;
    el.hidden = false;
    el.style.width = a.width;
    el.style.height = a.height;
    el.style.borderRadius = a.borderRadius;
    el.style.left = geo.left + "px";
    el.style.top = geo.top + "px";
    el.style.transform = `rotate(${-(it.rot || 0)}deg)`;
    // A tack's style is one `background`; a magnet's is backgroundImage plus backgroundColor (its cylinder wall).
    // Both as one shorthand, the colour under the last image: reading only `background` drew a magnet with no face.
    const bgOf = (st) => st.background || (st.backgroundImage ? `${st.backgroundImage} ${st.backgroundColor || ""}`.trim() : st.backgroundColor || "");
    el.style.setProperty("--f-bg", bgOf(a));
    el.style.setProperty("--f-sh", a.boxShadow);
    el.style.setProperty("--f-bg-dk", bgOf(b));
    el.style.setProperty("--f-sh-dk", b.boxShadow);
  }

  function adopt(it) {
    // Parked: this exact item had a node a moment ago and its thumb is still decoded. Put the
    // node back and touch nothing else — no src assignment, so no refetch and no re-decode.
    const back = parked.get(it.id);
    if (back) {
      parked.delete(it.id);
      back.item = it;
      nodes.set(it.id, back);
      cam.appendChild(back.node);
      return back;
    }
    const rec = free.pop() || makeRecord();
    rec.item = it;
    const { node, shot, thumb } = rec;

    // ── THE GEOMETRY, AND IT COMES ENTIRELY FROM THE LAYOUT ──────────────────────────────
    // item.x/y/w/h is the PHOTO box. The FRAME around it is bigger (a polaroid has a foot),
    // and `item.frameBox` is that outer box relative to (x, y) with dx/dy <= 0. It is the box
    // the occlusion solver packed, the box `layout.bounds` was computed from, and the box the
    // export renderer draws — so it is the box this element must BE. Sizing the element to the
    // photo box instead loses the whole frame (measured: 152px of a polaroid's outer height),
    // rotates about the wrong centre, and leaves the camera clamped to a `bounds` larger than
    // anything painted, which is free space past the pictures.
    const fb = frameBoxOf(it);
    const to = placeOf(it);
    const from = glideFrom && performance.now() < glideUntil ? glideFrom.get(it.id) : null;
    if (from && (from.t !== to.t || from.w !== to.w || from.h !== to.h)) {
      node.style.transition = "none";
      node.style.width = from.w + "px";
      node.style.height = from.h + "px";
      node.style.transform = from.t;
      void node.offsetWidth;
      node.style.transition = "transform 300ms cubic-bezier(.2,.7,.2,1), width 300ms cubic-bezier(.2,.7,.2,1), height 300ms cubic-bezier(.2,.7,.2,1)";
      node.addEventListener("transitionend", function done(e) { if (e.target !== node || e.propertyName !== "transform") return; node.style.transition = ""; node.removeEventListener("transitionend", done); });
    } else node.style.transition = "";
    node.style.width = to.w + "px";
    node.style.height = to.h + "px";
    node.style.transform = to.t;
    // Frame decoration that scales with the print (caption foot, and anything collage.css
    // derives). A CSS percentage cannot express "a fraction of my own width"; this can.
    node.style.setProperty("--cg-w", fb.w + "px");
    // The photo window, placed inside the frame by the layout's own numbers. Inline, so no
    // stylesheet can move it and re-crop the photograph: w/h here are exactly item.aspect, so
    // object-fit:cover can neither distort nor letterbox.
    // THE CROP. object-position places the cover window; the scale pushes into it, anchored at
    // the same point so zooming does not slide the subject out of frame.
    //
    // The DOM used to do NEITHER of these — it was a bare object-fit:cover, which centres —
    // while collage-export.js's coverRect() has always honoured `focal`. So an off-centre crop
    // looked one way on the board and another in the export, and nothing measured it. The
    // parity harness now does.
    const fpx = (it.focal && it.focal.x != null ? it.focal.x : 0.5) * 100;
    const fpy = (it.focal && it.focal.y != null ? it.focal.y : 0.5) * 100;
    const zoom = it.zoom > 1 ? it.zoom : 1;
    thumb.style.objectPosition = fpx + "% " + fpy + "%";
    thumb.style.transformOrigin = fpx + "% " + fpy + "%";
    thumb.style.transform = zoom > 1 ? "scale(" + zoom + ")" : "";
    if (rec.full) {
      rec.full.style.objectPosition = thumb.style.objectPosition;
      rec.full.style.transformOrigin = thumb.style.transformOrigin;
      rec.full.style.transform = thumb.style.transform;
    }

    shot.style.left = (-fb.dx) + "px";
    shot.style.top = (-fb.dy) + "px";
    shot.style.width = it.w + "px";
    shot.style.height = it.h + "px";
    node.style.zIndex = String(it.z | 0);
    paintFastener(rec, it, fb);
    node.dataset.frame = it.frame || "print";
    node.dataset.kind = it.kind || "photo";
    node.dataset.id = it.id;
    node.dataset.miss = "";
    node.setAttribute("aria-label", labelOf(it));

    rec.cap.textContent = it.frame === "polaroid" && it.caption ? String(it.caption) : "";

    if (it.kind === "video" && !rec.play) {
      rec.play = document.createElement("span");
      rec.play.className = "cg-play";
      rec.play.innerHTML = svg(G_PLAY);
      shot.appendChild(rec.play);
    }
    if (rec.play) rec.play.style.display = it.kind === "video" ? "" : "none";

    // Thumb first, always. The original is an upgrade, never the first request.
    thumb.onload = () => { node.dataset.miss = ""; };
    thumb.onerror = () => {
      // Offline honesty, memories.js's rule: a thumb that cannot be answered from any cache
      // while there is no radio IS "not downloaded yet". With a radio it is a real error and
      // gets the same dashed tray, because a broken image icon is worse than a shape.
      node.dataset.miss = "1";
    };
    if (it.thumbUrl) {
      thumb.src = it.thumbUrl;
      if (thumb.complete && thumb.naturalWidth === 0) node.dataset.miss = "1";
    } else {
      node.dataset.miss = "1";
      thumb.removeAttribute("src");
    }

    if (opts.frames && opts.frames.decorate) {
      try { opts.frames.decorate(node, it); } catch (e) { console.error("[collage]", e); }
    }
    nodes.set(it.id, rec);
    cam.appendChild(node);
    return rec;
  }

  /** Take a node out of the DOM. The record is PARKED — still bound to its item, still holding
   *  its decoded thumb — so coming straight back costs an appendChild and nothing else. The
   *  4K original is always released here: that is the memory that actually matters. */
  function retire(id) {
    const rec = nodes.get(id);
    if (!rec) return;
    nodes.delete(id);
    dropFull(rec);
    if (opts.video && opts.video.release) {
      try { opts.video.release(rec.node); } catch (e) { console.error("[collage]", e); }
    }
    rec.node.remove();
    rec.node.dataset.focus = "";
    rec.lodAt = 0;
    parked.set(id, rec);
    trimPark(PARK_MAX);
  }

  /** Oldest out first: a Map iterates in insertion order, so the first key is the least
   *  recently parked.
   *
   *  `slice` bounds how many are released in one go, and it is not decoration. Dropping the
   *  `src` of a hundred images in a single task is a hundred image-cache evictions inside one
   *  frame; measured, the idle drain of ~116 parked records was a 340ms long task and the only
   *  one left in the whole pinch run. Releasing in slices costs a few more timer callbacks and
   *  nothing else. */
  function trimPark(cap, slice = Infinity) {
    let n = 0;
    while (parked.size > cap && n < slice) {
      const oldest = parked.keys().next().value;
      const dead = parked.get(oldest);
      parked.delete(oldest);
      release(dead);
      n++;
    }
    return parked.size > cap;
  }

  function drainPark() {
    clearTimeout(parkTimer);
    if (trimPark(PARK_REST, 12)) parkTimer = setTimeout(drainPark, 32);
  }

  /** Fully let go: unbind from the item, drop the image, keep only the blank shell. */
  function release(rec) {
    if (!rec) return;
    dropFull(rec);
    if (opts.frames && opts.frames.release) {
      try { opts.frames.release(rec.node, rec.item); } catch (e) { console.error("[collage]", e); }
    }
    rec.node.remove();
    rec.thumb.onload = rec.thumb.onerror = null;
    rec.thumb.removeAttribute("src");
    rec.item = null;
    rec.lodAt = 0;
    if (free.length < 80) free.push(rec);
  }

  function releaseAll() {
    // Retire first, not release: retire is the path that tells the video pool to take its
    // decoder back. A layout swap that skipped it would strand a <video> inside a node that is
    // about to be handed to a different item.
    for (const id of [...nodes.keys()]) retire(id);
    for (const r of parked.values()) release(r);
    parked.clear();
  }

  const labelOf = (it) => it.label
    ? String(it.label)
    : (it.kind === "video" ? "Video" : "Photo") + (it.caption ? ", " + it.caption : "");

  /** Open an ITEM, not a node. A tap is deferred by the double-tap window, and in those 280ms a
   *  fling can retire the node the finger landed on and hand its record to a different item —
   *  so holding the record and reading `rec.item` when the timer fires can open the wrong
   *  photo. The item is plain layout data and cannot go stale. */
  function openItem(it) {
    if (!it || !opts.onOpen) return;
    const rec = nodes.get(it.id);
    const node = rec ? rec.node : null;
    try {
      opts.onOpen({
        item: it, memoryId: it.memoryId, mediaId: it.mediaId,
        index: byId.get(it.id), node,
        rect: node ? node.getBoundingClientRect() : null,
      });
    } catch (e) { console.error("[collage]", e); }
  }

  // ── level of detail ────────────────────────────────────────────────────────────────────
  /** Device px the screen is asking for, over device px the thumb actually has.
   *
   *  `it.w` is the FRAME's width, a few px wider than the picture inside a polaroid or a print,
   *  so this reads slightly high and upgrades slightly early. That is the direction to be wrong
   *  in: erring the other way shows a visibly soft photo at a zoom where the user is clearly
   *  looking at it. */
  function lodRatio(it) {
    const a = it.aspect > 0 ? it.aspect : (it.h > 0 ? it.w / it.h : 1);
    const have = THUMB_LONG_EDGE * Math.min(1, a);   // thumb width; long edge is 480
    return (it.w * C.k * dpr()) / Math.max(1, have);
  }

  function lodMaybe(ts) {
    if (ts - lastLod < 140) return;
    lastLod = ts;
    runLod();
  }

  function runLod() {
    if (!maxOriginals) return;
    const now = performance.now();
    const vis = viewRect(false);
    const ccx = (vw / 2 - C.x) / C.k, ccy = (vh / 2 - C.y) / C.k;

    const candidates = [];
    for (const rec of nodes.values()) {
      const it = rec.item;
      if (!it || !it.origUrl) continue;
      const b = index.boxes[byId.get(it.id)];
      if (!b) continue;
      const onScreen = !(b.x1 < vis.x0 || b.x0 > vis.x1 || b.y1 < vis.y0 || b.y0 > vis.y1);
      const ratio = lodRatio(it);
      // Hysteresis, both halves: a node WITHOUT the original needs to beat LOD_UP; a node that
      // already has it only needs to beat LOD_DOWN to keep it. The band between the two is
      // where a camera resting on the threshold sits without thrashing.
      const want = onScreen && (rec.full ? ratio > LOD_DOWN : ratio > LOD_UP);
      if (want) candidates.push({ rec, it, d: (b.cx - ccx) ** 2 + (b.cy - ccy) ** 2 });
      else if (rec.full) {
        if (!rec.lodAt) rec.lodAt = now;
        else if (now - rec.lodAt > LOD_RELEASE_MS) dropFull(rec);
      }
    }
    candidates.sort((a, b) => a.d - b.d);
    const keep = candidates.slice(0, maxOriginals);
    const keepSet = new Set(keep.map((c) => c.it.id));
    // Anything holding an original that did not make the cut starts its release timer; it is
    // not dropped on the spot, so a pinch that crosses back does not re-download.
    for (const rec of nodes.values()) {
      if (rec.full && rec.item && !keepSet.has(rec.item.id)) {
        if (!rec.lodAt) rec.lodAt = now;
        else if (now - rec.lodAt > LOD_RELEASE_MS) dropFull(rec);
      }
    }
    for (const c of keep) {
      c.rec.lodAt = 0;
      if (!c.rec.full && inFlight < MAX_ORIGINAL_FETCHES) loadFull(c.rec);
    }

    // The release timers are the only piece of this module that has to fire while NOTHING is
    // moving: the camera stops, an item drops below the threshold, and LOD_RELEASE_MS later
    // its 4K original should be handed back. The rAF loop is asleep by then — deliberately —
    // so the pending release schedules its own wake-up. Without this a board left parked after
    // a zoom-out holds every original it ever fetched, which is the memory that matters most.
    let soonest = Infinity;
    for (const rec of nodes.values()) if (rec.full && rec.lodAt) soonest = Math.min(soonest, rec.lodAt);
    clearTimeout(lodTimer);
    if (soonest < Infinity) {
      lodTimer = setTimeout(runLod, Math.max(60, LOD_RELEASE_MS - (now - soonest) + 40));
    }
  }

  function loadFull(rec) {
    const it = rec.item;
    if (!it || !it.origUrl || rec.full) return;
    inFlight++;
    const img = document.createElement("img");
    img.className = "cg-full";
    img.alt = "";
    img.decoding = "async";
    rec.full = img;
    const done = () => { inFlight = Math.max(0, inFlight - 1); };
    img.onload = () => {
      done();
      if (rec.full !== img || !rec.item) return;
      rec.shot.insertBefore(img, rec.miss);
      // transform+opacity only; instant under reduced motion.
      if (reduced()) { img.dataset.on = "1"; return; }
      img.style.transition = `opacity ${ms("--dur", 220)}ms var(--ease-out, ease-out)`;
      requestAnimationFrame(() => { img.dataset.on = "1"; });
    };
    img.onerror = () => { done(); if (rec.full === img) rec.full = null; };
    img.src = it.origUrl;
  }

  function dropFull(rec) {
    const img = rec.full;
    if (!img) return;
    rec.full = null;
    rec.lodAt = 0;
    img.onload = img.onerror = null;
    img.removeAttribute("src");
    img.remove();
  }

  // ── video candidates ───────────────────────────────────────────────────────────────────
  /** Publish the ordered, capped set of video items that deserve a decoder. The cap is applied
   *  here as well as in the pool: two independent ceilings on the one resource iOS will not
   *  give back gracefully. Under reduced motion the list is always empty — posters only. */
  function publishVideo() {
    if (!opts.video || !opts.video.update) return;
    let list = [];
    // Nothing while the board has no size (hidden behind the List or Feed): its last size still says where
    // the screen was, and a print "in view" there would be handed a decoder no one sees.
    if (!reduced() && videoBudget > 0 && document.visibilityState === "visible" && root.offsetWidth > 1 && root.offsetHeight > 1) {
      const vis = viewRect(false);
      const ccx = (vw / 2 - C.x) / C.k, ccy = (vh / 2 - C.y) / C.k;
      const cand = [];
      for (const rec of nodes.values()) {
        const it = rec.item;
        if (!it || it.kind !== "video") continue;
        const b = index.boxes[byId.get(it.id)];
        if (!b || b.x1 < vis.x0 || b.x0 > vis.x1 || b.y1 < vis.y0 || b.y0 > vis.y1) continue;
        cand.push({ rec, it, d: (b.cx - ccx) ** 2 + (b.cy - ccy) ** 2 });
      }
      cand.sort((a, b) => a.d - b.d);
      list = cand.slice(0, videoBudget).map((c) => ({
        id: c.it.id, item: c.it, node: c.rec.node, shot: c.rec.shot, poster: c.rec.thumb,
      }));
    }
    const sig = list.map((v) => v.id).join("|");
    if (sig === lastVideoIds) return;
    lastVideoIds = sig;
    try { opts.video.update(list); } catch (e) { console.error("[collage]", e); }
  }

  // ── gestures ───────────────────────────────────────────────────────────────────────────
  const pts = new Map();          // pointerId -> {x, y}
  const drag = { active: false, mode: null, sx: 0, sy: 0, cx: 0, cy: 0, ck: 1, t0: 0, moved: 0 };
  const track = [];               // velocity samples
  let pinch = null;
  let tapTimer = 0, lastTap = 0, lastTapX = 0, lastTapY = 0, tapItem = null, lastPointerUp = -1e9;

  const local = (e) => {
    const r = root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function onDown(e) {
    if (destroyed) return;
    // Hand the browser its own back/forward gesture. See EDGE_GUARD.
    if (pts.size === 0 && (e.clientX < EDGE_GUARD || e.clientX > window.innerWidth - EDGE_GUARD)) return;
    const p = local(e);
    pts.set(e.pointerId, p);
    try { root.setPointerCapture(e.pointerId); } catch { /* mouse leaving the window */ }
    anim = null; vx = vy = 0;

    if (pts.size === 1) {
      drag.active = true; drag.mode = "pan";
      drag.sx = p.x; drag.sy = p.y; drag.cx = C.x; drag.cy = C.y; drag.ck = C.k;
      drag.t0 = performance.now(); drag.moved = 0;
      const hitNode = e.target && e.target.closest ? e.target.closest(".cg-item") : null;
      const hitRec = hitNode ? nodes.get(hitNode.dataset.id) : null;
      tapItem = hitRec ? hitRec.item : null;
      track.length = 0;
      track.push({ t: drag.t0, x: p.x, y: p.y });
      root.dataset.drag = "1";
      setBusy(true);
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = startPinch(a, b);
      drag.mode = "pinch";
      tapItem = null;
      if (tapTimer) { clearTimeout(tapTimer); tapTimer = 0; }
    }
    schedule();
  }

  function startPinch(a, b) {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    return { d0: d, k0: C.k, mx, my, cx: (mx - C.x) / C.k, cy: (my - C.y) / C.k };
  }

  function onMove(e) {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    pts.set(e.pointerId, p);

    if (pts.size >= 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const k = pinch.k0 * (d / pinch.d0);
      // Keep the canvas point that was under the midpoint under the midpoint. The translation
      // has to be computed from the RESISTED scale, not the raw one, or the board slides out
      // from under the fingers exactly when the pinch is fighting a limit.
      const kk = looseScale(k);
      applyLoose(mx - pinch.cx * kk, my - pinch.cy * kk, k);
      drag.moved = TAP_SLOP + 1;
      schedule();
      return;
    }
    if (!drag.active) return;
    const dx = p.x - drag.sx, dy = p.y - drag.sy;
    drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
    applyLoose(drag.cx + dx, drag.cy + dy, drag.ck);
    const t = performance.now();
    track.push({ t, x: p.x, y: p.y });
    while (track.length > 6) track.shift();
    schedule();
  }

  function onUp(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    try { root.releasePointerCapture(e.pointerId); } catch { /* already gone */ }

    if (pts.size >= 2 && pinch) {
      // Three fingers down and one lifted. The pinch baseline was measured between two
      // pointers that are no longer the two being used, so re-seed it from the current pair
      // instead of letting the scale jump by whatever their spacing happens to be.
      const [a, b] = [...pts.values()];
      pinch = startPinch(a, b);
      return;
    }
    if (pts.size === 1 && pinch) {
      // Second finger lifted mid-pinch: continue as a pan from where the remaining one is.
      const p = [...pts.values()][0];
      pinch = null;
      drag.active = true; drag.mode = "pan";
      drag.sx = p.x; drag.sy = p.y; drag.cx = C.x; drag.cy = C.y; drag.ck = C.k;
      track.length = 0; track.push({ t: performance.now(), x: p.x, y: p.y });
      return;
    }
    if (pts.size > 0) return;
    lastPointerUp = performance.now();

    const wasPinch = drag.mode === "pinch" || !!pinch;
    pinch = null;
    drag.active = false;
    drag.mode = null;
    root.dataset.drag = "";

    const now = performance.now();
    const isTap = !wasPinch && drag.moved <= TAP_SLOP && now - drag.t0 <= TAP_MS;

    if (isTap) {
      const p = local(e);
      const dbl = now - lastTap < DBL_MS && Math.hypot(p.x - lastTapX, p.y - lastTapY) < DBL_SLOP;
      if (dbl) {
        lastTap = 0;
        if (tapTimer) { clearTimeout(tapTimer); tapTimer = 0; }
        doubleTap(p);
      } else {
        lastTap = now; lastTapX = p.x; lastTapY = p.y;
        const it = tapItem;
        // A single tap has to wait out the double-tap window: opening the viewer on the first
        // of two taps and then zooming underneath it is the worse failure of the two.
        if (tapTimer) clearTimeout(tapTimer);
        tapTimer = setTimeout(() => { tapTimer = 0; openItem(it); }, DBL_MS);
      }
      schedule();
      return;
    }

    // Fling. Velocity from the tail of the sample buffer, which is steadier than the last
    // pointermove pair on a jittery digitiser.
    if (!reduced() && track.length >= 2) {
      const a = track[0], b = track[track.length - 1];
      const dt = Math.max(0.008, (b.t - a.t) / 1000);
      if (b.t - a.t < 140) { vx = (b.x - a.x) / dt; vy = (b.y - a.y) / dt; }
      const sp = Math.hypot(vx, vy);
      if (sp < MIN_FLING) vx = vy = 0;
      else if (sp > 6000) { vx *= 6000 / sp; vy *= 6000 / sp; }
    }
    if (outOfBounds()) { springTo(settledTarget(), vx, vy); vx = vy = 0; }
    schedule();
  }

  function onCancel(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size === 0) {
      drag.active = false; drag.mode = null; pinch = null; root.dataset.drag = "";
      if (outOfBounds()) springTo(settledTarget());
      schedule();
    }
  }

  function doubleTap(p) {
    const cx = (p.x - C.x) / C.k, cy = (p.y - C.y) / C.k;
    const hit = itemAt(cx, cy);
    // Zoomed in already? Take it back to the whole board. That makes double-tap a toggle
    // rather than a one-way ratchet into the picture.
    if (C.k > minK * 1.8) { animateTo(fitTarget()); return; }
    if (hit) { zoomToItem(hit.id); return; }
    const k = clamp(C.k * 2.2, minK, maxK);
    animateTo({ x: p.x - cx * k, y: p.y - cy * k, k });
  }

  /** Topmost item (highest z) whose rotated rect contains this canvas point. */
  function itemAt(x, y) {
    query({ x0: x, y0: y, x1: x, y1: y }, qbuf);
    let best = null;
    for (let n = 0; n < qbuf.length; n++) {
      const it = items[qbuf[n]];
      const r = -(it.rot || 0) * Math.PI / 180;
      // The tap target is the whole print — frame and all — because that is the object on
      // screen. Testing the photo box would make the polaroid's foot dead to the finger.
      const f = frameBoxOf(it);
      const cx = it.x + f.dx + f.w / 2, cy = it.y + f.dy + f.h / 2;
      const dx = x - cx, dy = y - cy;
      const lx = dx * Math.cos(r) - dy * Math.sin(r);
      const ly = dx * Math.sin(r) + dy * Math.cos(r);
      if (Math.abs(lx) <= f.w / 2 && Math.abs(ly) <= f.h / 2) {
        if (!best || (it.z | 0) >= (best.z | 0)) best = it;
      }
    }
    if (best) return best;

    // SLOP PASS — 44px touch-target floor at every zoom, which the exact pass alone cannot give.
    // Hit testing happens in CANVAS units, so an item's reachable size on GLASS is its box
    // times the camera scale: a 200px print at fit-to-board (k about 0.07) is 14 screen px,
    // a third of the 44px floor. Rather than forbid zooming out, grow the TEST — never the
    // drawing — until the target measures 44px on screen.
    // An item already at or above the floor gets a pad of exactly 0, so nothing about tapping
    // a zoomed-in board changes; and because the exact pass ran first, a precise tap on the
    // print you meant still wins over a neighbour's slop.
    const k = C.k || 1;
    const need = (MIN_TAP_PX / 2) / k;              // half a minimum target, in canvas units
    query({ x0: x - need, y0: y - need, x1: x + need, y1: y + need }, qbuf);
    let near = null, nearD = Infinity;
    for (let n = 0; n < qbuf.length; n++) {
      const it = items[qbuf[n]];
      const r = -(it.rot || 0) * Math.PI / 180;
      const f = frameBoxOf(it);
      const cx = it.x + f.dx + f.w / 2, cy = it.y + f.dy + f.h / 2;
      const dx = x - cx, dy = y - cy;
      const lx = dx * Math.cos(r) - dy * Math.sin(r);
      const ly = dx * Math.sin(r) + dy * Math.cos(r);
      const padX = Math.max(0, need - f.w / 2);
      const padY = Math.max(0, need - f.h / 2);
      if (Math.abs(lx) > f.w / 2 + padX || Math.abs(ly) > f.h / 2 + padY) continue;
      // Nearest centre, not topmost: every candidate here is SMALL (a big print takes pad 0
      // and could only have matched the exact pass), so what the finger meant is whatever it
      // landed closest to. Ties break upward in paint order.
      const d = dx * dx + dy * dy;
      if (d < nearD || (d === nearD && near && (it.z | 0) >= (near.z | 0))) { near = it; nearD = d; }
    }
    return near;
  }

  function fitTarget() {
    const k = minK;
    return { x: clampT(0, k, "x"), y: clampT(0, k, "y"), k };
  }

  function itemTarget(id, fill = DBL_ZOOM) {
    const i = byId.get(id);
    if (i == null) return null;
    const b = index.boxes[i];
    const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    const k = clamp(Math.min(vw / (bw * (fill / 2)), vh / (bh * (fill / 2))), minK, maxK);
    return { x: clampT(vw / 2 - b.cx * k, k, "x"), y: clampT(vh / 2 - b.cy * k, k, "y"), k };
  }

  function animateTo(to) {
    if (!to) return;
    if (reduced()) { C.x = to.x; C.y = to.y; C.k = to.k; anim = null; dirtyView = true; schedule(); return; }
    springTo(to, 0, 0);
  }

  // ── wheel / trackpad (desktop, and how the scripted measurements drive zoom) ────────────
  function onWheel(e) {
    e.preventDefault();
    anim = null; vx = vy = 0;
    const p = local(e);
    if (e.ctrlKey || e.metaKey) {
      const k = clamp(C.k * Math.exp(-e.deltaY / 180), minK * 0.85, maxK * 1.15);
      const cx = (p.x - C.x) / C.k, cy = (p.y - C.y) / C.k;
      applyLoose(p.x - cx * k, p.y - cy * k, k);
    } else {
      applyLoose(C.x - e.deltaX, C.y - e.deltaY, C.k);
    }
    clearTimeout(wheelSettle);
    wheelSettle = setTimeout(() => { if (outOfBounds()) springTo(settledTarget()); schedule(); }, 120);
    schedule();
  }
  let wheelSettle = 0;

  // ── keyboard: the camera, not a tab walk ───────────────────────────────────────────────
  function onKey(e) {
    // Cmd+0, Cmd+-, Cmd+= are the BROWSER's zoom, and Alt-arrow is its history. A canvas that
    // eats them has broken the page around it to make its own shortcuts work.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = (e.shiftKey ? 240 : 90);
    let handled = true;
    if (e.key === "ArrowLeft") nudge(step, 0);
    else if (e.key === "ArrowRight") nudge(-step, 0);
    else if (e.key === "ArrowUp") nudge(0, step);
    else if (e.key === "ArrowDown") nudge(0, -step);
    else if (e.key === "+" || e.key === "=") zoomBy(1.35);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.35);
    else if (e.key === "0") animateTo(fitTarget());
    else if (e.key === "Enter" || e.key === " ") {
      openItem(centreItem());
    } else handled = false;
    if (handled) { e.preventDefault(); announceCentre(); }
  }

  function nudge(dx, dy) {
    anim = null;
    const k = C.k;
    C.x = clampT(C.x + dx, k, "x"); C.y = clampT(C.y + dy, k, "y");
    dirtyView = true; schedule();
  }
  function zoomBy(f) {
    const k = clamp(C.k * f, minK, maxK);
    const cx = (vw / 2 - C.x) / C.k, cy = (vh / 2 - C.y) / C.k;
    animateTo({ x: clampT(vw / 2 - cx * k, k, "x"), y: clampT(vh / 2 - cy * k, k, "y"), k });
  }
  function centreItem() { return itemAt((vw / 2 - C.x) / C.k, (vh / 2 - C.y) / C.k); }

  let announced = "";
  function announceCentre() {
    const it = centreItem();
    const msg = it ? labelOf(it) : `Zoom ${(C.k / minK).toFixed(1)}x`;
    if (msg === announced) return;
    announced = msg;
    for (const rec of nodes.values()) rec.node.dataset.focus = rec.item === it ? "1" : "";
    live.textContent = msg;
  }

  // ── lifecycle plumbing ─────────────────────────────────────────────────────────────────
  /** Coming back into signal, the board should fill itself in. A thumb that failed while the
   *  radio was down is showing the dashed tray, and nothing would ever ask for it again — on a
   *  trip with four days of no coverage that is most of the board. Re-assigning `src` is the
   *  whole retry; the browser and the service worker do the rest. */
  function retryMissing() {
    if (!online()) return;
    const again = (rec) => {
      if (!rec.item || !rec.item.thumbUrl) return;
      if (rec.node.dataset.miss !== "1") return;
      rec.node.dataset.miss = "";
      rec.thumb.removeAttribute("src");
      rec.thumb.src = rec.item.thumbUrl;
    };
    for (const rec of nodes.values()) again(rec);
    for (const rec of parked.values()) again(rec);
  }

  function onVisibility() {
    if (document.visibilityState === "visible") {
      if (opts.video && opts.video.resume) { try { opts.video.resume(); } catch (e) { console.error("[collage]", e); } }
      lastVideoIds = "";
      publishVideo();
    } else {
      // Battery-critical screen on a trip with no charging: nothing decodes while hidden.
      if (opts.video && opts.video.pause) { try { opts.video.pause(); } catch (e) { console.error("[collage]", e); } }
      lastVideoIds = "";
    }
  }

  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    // The board hidden (the List or Feed view over it, its tab closed): it has no size, and nothing is
    // measured or moved, so it comes back where the person left it. (Measured at 1×1, the centre was
    // worked out in a 1-pixel screen's terms and the board came back somewhere else.)
    // Its videos stop there too: the pool is handed no prints (their decoders back), and the
    // showing below publishes them again.
    if (root.offsetWidth <= 1 || root.offsetHeight <= 1) {
      lastVideoIds = "";
      if (opts.video && opts.video.update) { try { opts.video.update([]); } catch (e) { console.error("[collage]", e); } }
      return;
    }
    // The point at the middle of the screen, read in the size the board had until now: after a turn of
    // the phone it is still at the middle. A board whose camera was never set against a real size has no
    // such point yet.
    const laidOut = framed;
    const cx0 = (vw / 2 - C.x) / C.k, cy0 = (vh / 2 - C.y) / C.k;
    const pk = C.k / (minK || 1);
    measure();
    // Hold the relative zoom across a rotation rather than the absolute one, so turning the
    // phone does not silently zoom the board.
    if (!laidOut) {
      // First given a size (mounted into a hidden stage): the whole board, as a first open shows it.
      const to = fitTarget();
      C.k = to.k; C.x = to.x; C.y = to.y;
      framed = true;
    } else {
      const k = clamp(pk * minK, minK, maxK);
      C.k = k; C.x = clampT(vw / 2 - cx0 * k, k, "x"); C.y = clampT(vh / 2 - cy0 * k, k, "y");
    }
    groundOctave = null;
    dirtyView = true;
    schedule();
  }) : null;

  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerup", onUp);
  root.addEventListener("pointercancel", onCancel);
  root.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("keydown", onKey);
  root.addEventListener("contextmenu", (e) => { if (pts.size) e.preventDefault(); });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", retryMissing);
  if (ro) ro.observe(root);

  // ── first paint ────────────────────────────────────────────────────────────────────────
  setLayout(layout);
  measure();
  const f = fitTarget();
  C.x = f.x; C.y = f.y; C.k = f.k;
  framed = vw > 1 && vh > 1;
  writeCamera();
  reconcile(true);
  hydrateSome(Infinity);   // the FIRST paint is allowed to be complete; nothing is moving yet
  runLod();
  publishVideo();

  // ── the handle ─────────────────────────────────────────────────────────────────────────
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (active === api) active = null;
    if (raf) cancelAnimationFrame(raf), raf = 0;
    if (tapTimer) clearTimeout(tapTimer);
    if (wheelSettle) clearTimeout(wheelSettle);
    if (lodTimer) clearTimeout(lodTimer);
    if (parkTimer) clearTimeout(parkTimer);
    root.removeEventListener("pointerdown", onDown);
    root.removeEventListener("pointermove", onMove);
    root.removeEventListener("pointerup", onUp);
    root.removeEventListener("pointercancel", onCancel);
    root.removeEventListener("wheel", onWheel);
    root.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", retryMissing);
    if (ro) ro.disconnect();
    if (opts.video) {
      try { opts.video.pause && opts.video.pause(); } catch (e) { console.error("[collage]", e); }
      try { opts.video.destroy && opts.video.destroy(); } catch (e) { console.error("[collage]", e); }
    }
    releaseAll();
    free.length = 0;
    root.remove();
    el.style.position = hostPos;
  }

  /**
   * The handle. It is a function so `mount()` also satisfies the app's `mount -> unmount`
   * view contract; the methods are there for the wiring session and for tests.
   */
  const api = function unmountThis() { destroy(); };
  api.destroy = destroy;
  api.root = root;
  /** Swap in a new Layout (a re-roll, or new media). Camera zoom ratio is preserved. */
  api.setLayout = (next) => {
    const ratio = C.k / (minK || 1);
    setLayout(next);
    const k = clamp(minK * ratio, minK, maxK);
    C.k = k; C.x = clampT(C.x, k, "x"); C.y = clampT(C.y, k, "y");
    settled = false;
    writeCamera(); reconcile(true); hydrateSome(Infinity); runLod(); schedule();
  };
  /** @returns {{x:number,y:number,k:number,minK:number,maxK:number,vw:number,vh:number}} */
  api.camera = () => ({ x: C.x, y: C.y, k: C.k, minK, maxK, vw, vh });
  /** The camera's world: the board with its band of wall (boardOf(layout.bounds, layout.stats.targetWidth, layout.stats.boardTall).wall), what it opens on at
   *  min zoom. Zoomed in, the view stops sooner (limit(): at least half the screen is board). */
  api.bounds = () => ({ minX: pad.x0, minY: pad.y0, maxX: pad.x1, maxY: pad.y1 });
  /** The legal translation range on each axis at the current scale. lo === hi means the content
   *  is smaller than the viewport on that axis and there is exactly one legal position. */
  api.limits = () => ({ x: limit(C.k, "x"), y: limit(C.k, "y") });
  /** Move the camera immediately, clamped. Used by tests and by deep links. */
  api.setCamera = (c, animate = false) => {
    const k = clamp(c.k == null ? C.k : c.k, minK, maxK);
    const to = { x: clampT(c.x == null ? C.x : c.x, k, "x"), y: clampT(c.y == null ? C.y : c.y, k, "y"), k };
    if (animate) { animateTo(to); return; }
    anim = null; vx = vy = 0;
    C.x = to.x; C.y = to.y; C.k = to.k;
    dirtyView = true; settled = false;
    writeCamera(); reconcile(true); hydrateSome(Infinity); runLod(); schedule();
  };
  /** Zoom so this item fills roughly 2/DBL_ZOOM of the viewport, centred. */
  api.zoomToItem = (id, animate = true) => {
    const to = itemTarget(id);
    if (!to) return false;
    if (animate) animateTo(to); else api.setCamera(to, false);
    return true;
  };
  /** Back to the whole board. */
  api.fit = (animate = true) => { const to = fitTarget(); animate ? animateTo(to) : api.setCamera(to, false); };
  /** Re-measure after the container changed size outside a ResizeObserver tick. */
  api.invalidate = () => { measure(); dirtyView = true; groundOctave = null; schedule(); };
  /** Ask every item wearing the not-downloaded tray to try again. Wired to `online` already;
   *  exposed so the tab's own sync line can trigger it when store.js sees the radio return. */
  api.retryMissing = retryMissing;
  /** Ids of every item that currently has a DOM node — the virtualization, observable. */
  api.liveIds = () => [...nodes.keys()];
  /** Ids currently holding a 4K original. */
  api.originalIds = () => [...nodes.values()].filter((r) => r.full).map((r) => r.item && r.item.id);
  /** The video candidate list as last published (ordered, capped). */
  api.videoIds = () => (lastVideoIds ? lastVideoIds.split("|") : []);
  api.itemAt = itemAt;

  function zoomToItem(id) { api.zoomToItem(id, true); }

  active = api;
  return api;
}

/** Tear down whatever board is mounted. The wiring session can call this without a handle. */
export function unmount() {
  if (active) { const a = active; active = null; a.destroy(); }
}

/** The board currently mounted, or null. */
export function current() { return active; }

export default { mount, unmount, current };

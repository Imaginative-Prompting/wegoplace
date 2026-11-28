// map.js — THE MAP BODY OF PLACES. Not a screen, not a tab: a body.
//
// Embedded under Places rather than living on the tab bar. Places owns the screen — the
// "Places" title, the list/map toggle, the category and subcategory filters — and this file
// owns the rectangle underneath them. So there is no header here, no filter row, and no app
// bar. What used to be a chip row in this file is now Places' filter row, and the two are
// joined by the URL query rather than by a shared object; see "the host contract" below.
//
// THE DESIGN DECISION, stated once: this view renders pins, the GPS
// dot, and bearing + distance on a GROUND THAT IS DRAWN WHEN IT CANNOT BE DOWNLOADED. Street
// tiles are a layer that slides in underneath when it can, and are never a dependency. Whole
// days of a trip can be on a trail with no signal, so the thing that has to work is
// the thing that needs no network at all: the browser's GPS works with the radio off,
// haversine and bearing are arithmetic, and the place coordinates are already in IndexedDB.
// "The old bridge, 4.2 km, NE" is a complete answer computed on a phone in a tent.
//
// ── TOUCH HANDLING ─────────────────────────────────────────────────────────────────────
// The third review found touch unresponsive: it dropped inputs.
//
// Hand-rolling the camera, pan, and pinch in this file dropped touches
// on Pointer Events, driving a MapLibre created with interactive:false through jumpTo() once
// per frame. Two things followed from that and both were felt in the hand:
//
//   1. every pointermove ran the FULL redraw — a canvas clear plus a graticule of hundreds of
//      moveTo/lineTo, then a clustering pass whose merge loop restarted its whole double loop
//      on every merge (O(g^3) over 312 places), then a DOM write per marker. The finger moved;
//      the camera answered a frame or three later, if the frame budget held.
//   2. every gesture was our own reimplementation of one MapLibre already ships and tunes:
//      no inertia, no touch-slop, no pointer bookkeeping for a third finger, and rotation and
//      pitch simply absent.
//
// So gestures are MapLibre's now. The map is created interactive with dragPan, pinch zoom,
// two-finger rotate and two-finger pitch all ON, and this module holds NO pointer handler over
// the canvas at all. What it holds instead is a MARKER LAYER PARENTED INSIDE
// map.getCanvasContainer(), which is the element MapLibre binds its handlers to — so a drag
// that begins on a pin still pans the map, exactly as it does on MapLibre's own markers, and
// the pins no longer eat the gesture that starts on them. Nothing else of ours is over the
// canvas: the controls, the scale and the sheet are siblings outside it.
//
// The redraw is bounded now too: clustering is a hash grid (O(n), one pass, no restarting
// merge), it only re-runs when the zoom, the bearing, the pitch or 32px of pan says the
// membership could have changed, and a pure pan re-projects each group's stored centre and
// writes one transform per marker.
//
// ONE CAMERA, TWO ENGINES. Everything below talks to `view`, an adapter with project /
// unproject / cam / jumpTo / easeTo. There are two implementations and both are live on every
// load, which is what keeps the second one honest:
//
//   FLAT — arithmetic Web Mercator, our own pointer gestures, north up. It is what mounts in
//          frame one, before 600 KB of MapLibre has been fetched and parsed, so the pins and
//          the drawn ground are on screen immediately. It is also the whole map on a device
//          with no WebGL2.
//   GL   — MapLibre. Created with the flat view's exact camera and handed control; the flat
//          view's pointer handlers are removed in the same tick. Rotate and pitch come with it.
//
// The projection uses a 512px tile because MapLibre's worldSize is tileSize * 2^zoom with
// tileSize 512: our zoom number and its zoom number are the same number, so the handover is a
// copy rather than a conversion.
//
// THE DRAWN GROUND (avoiding bare pins on a
// void) works under rotation and pitch, because it is painted
// through view.project() rather than in screen-axis arithmetic. It says two true things:
//   * the trip's regions (its top-level areas that have bounds) are plates a shade off the
//     ground around them: "inside a plate" means "this is ground the trip covers", and it is
//     the ground the trip's offline map, when it has one, is cut to.
//   * a two-weight graticule, minor in --line and every fifth line in --line-strong, anchored
//     to the ground so a pan visibly moves. The scale plate names what a square is worth.
// It paints only while there are no tiles. With tiles, the streets ARE the ground.
//
// NO ROUTING. .pmtiles ships render geometry, not a road graph. Tapping a pin hands off to
// Google Maps (Google only), which has routing. No redundant explanatory copy
// in the sheet: the button is the statement.
//
// ── the host contract ──────────────────────────────────────────────────────────────────
// Two hosts, one mount function, because the map must not care which one it got.
//
//   1. THE ROUTE. #/map is a REDIRECT to #/places?view=map — the default
//      export forwards and mounts nothing. The bleed:true form below still exists and works,
//      but nothing in the app reaches it any more.
//
//   2. EMBEDDED — the live path. places.js does:
//
//        import { mountMap } from "./map.js";
//        const map = mountMap(bodyEl, ctx, { bleed: false, filter: sel });
//        // bodyEl must be position:relative and have a real height; the map fills it.
//        map.setFilter({ kind, sub, q });   // whenever the filter row changes
//        map.select(placeId);               // e.g. from a "show on map" affordance
//        map.destroy();                     // from the view's own unmount
//
// WHERE THE MAP ACTUALLY SITS. The host element is laid out by places.js
// UNDER its sticky head and ABOVE #view's bottom padding, and both of those move: the second
// chip row appears when a category is picked and pushes the host down 40px, and the bottom
// padding leaves a strip of --ground between the map and the tab bar. The
// canvas has to reach the tab bar and must not reflow when chips appear, and neither is
// negotiable from inside a box that does both.
//
// So the root ESCAPES ITS HOST: it is absolutely positioned with measured negative top and
// bottom offsets that put its edges on #view's own padding box, and fitShell() re-derives
// them from the host's and #view's live rects whenever anything moves. The head is z-index 3 and translucent, so
// the chip rows now float ON the map instead of pushing it. Nothing in places.js changed —
// the correction is relative to the host, so it survives the router's transform on #view
// across view transitions in a way position:fixed would not.
//
// RESERVED SPACE. The shell's dock (back button + connectivity pill) is fixed to the
// BOTTOM-LEFT at z-index 8 and floats over this view. The scale plate is bottom-left too
// and sits ABOVE the sheet, which is where the dock is not; the sheet takes extra
// bottom padding under body[data-back="1"] so its last line is never underneath the dock.
//
// OWNERSHIP: this is the map role's only file besides scripts/extract_tiles.sh. The .mp-*
// rules live in a <style> block injected from here rather than in styles.css, which the shell
// role owns — CONTRACTS.md assigns .mp-* to this view but assigns the stylesheet to someone
// else, and the two are reconciled by keeping the rules with the code that needs them.
// Nothing here declares a colour of its own: every value is a token from styles.css, so the
// three-state theme keeps working untouched.

import {
  haversine, bearing, bearingDeg, fmtDistance, distanceUnits, esc, clip, toMs, notePositionRefused,
} from "./util.js";
import { toast } from "./toast.js";
import { getIcon, categoryOf, CATEGORY_LABEL } from "./icons.js";
import { placePhoto } from "./shared/photo.js";
import { tripIdFromPath, tripKey } from "./trip-here.js";
import { fetchWithin } from "./net.js";
import { readAreas, nearTrip, nearLng, widthOf, boxAround, boundsOf } from "./areas.js";
// The trip's map on the phone: what the trip says about it, the kept copy, and the keep itself,
// which also runs with this screen never opened (map-keep.js).
import {
  MAX_STASH_BYTES, GLYPHS_URL, archiveUrl, mapStateOf, said as saidOf, say as sayOf,
  cachedArchive as keptArchive, isCurrent, styleLayers, keepMap, keepState, onKeep, roomWords,
} from "./map-keep.js";
import { resolvedTheme, resolvedLum } from "./settings.js";
// Motion durations come from the CSS tokens via motion.js, so 220ms stays written down in
// one place. Renamed on import: easeTo() already has a parameter called ms.
import { ms as tokMs, reducedMotion } from "./motion.js";
// The open/closed answer, from the module that owns opening hours. This is an import CYCLE —
// places.js imports mountMap from here — and it is safe because all three are hoisted function
// declarations and nothing calls them at module scope: by the time a sheet renders, both
// modules have finished evaluating. Reimplementing an hours parser here would be the worse
// bug, because then there would be two of them and they would disagree.
import { parseHours, openState, nowInZone, placeWhat, placeMeta, placeRatingHtml, ensureCss as ensurePlacesCss } from "./places.js";

// ── constants ──────────────────────────────────────────────────────────────────────────

const TILE = 512;                 // must match MapLibre's tileSize; see the header note
const MIN_ZOOM = 3;
const MAX_ZOOM = 18;
const MAX_PITCH = 60;
const MAX_FIT_ZOOM = 16;          // fitting one tight cluster should not slam to street level
const FOCUS_ZOOM = 16;            // ?focus=<id>, and "centre on this pin"
// HOW LATE A GROUP SPLITS. A flat 48 px threshold is nearly a pin and a half, so two
// places a block apart were still one disc at street zoom. The radius now TIGHTENS with the
// zoom, and it starts tightening EARLY: 30 px holds only for the overview zooms, where the
// alternative is a whole country as a pin thicket, and from CLUSTER_TIGHT_ZOOM it falls away to 10 px —
// under a third of a pin body — at MAX_ZOOM.
//
// Measured over an old town's center before this pass: fourteen discs at z16, five of them 2s
// and 3s, and still six at z17 — at street-corner zoom a 2-cluster and a 3-cluster still
// would not split. The interpolation now reaches 16.7 px at z16 and 13.3 px at z17, so a
// pair a building apart is two pins with two names long before the camera runs out of zoom.
// Whatever still shares one disc is resolved by TAPPING it, never by zooming — see
// openCluster().
const CLUSTER_PX = 30;            // grouping radius at and below CLUSTER_TIGHT_ZOOM
const CLUSTER_TIGHT_PX = 10;      // …and at MAX_ZOOM. Interpolated in between.
const CLUSTER_TIGHT_ZOOM = 12;
// What a disc takes up, for the pass that keeps discs off each other and off pins (settle()).
// Half of .mp-cluster-body's 42 px; the pin's own box is PIN_SIDE_PX and PIN_UP_PX below.
const DISC_HALF_PX = 21;
const MARK_GAP_PX = 2;            // the least ground showing between a disc and its neighbor
// The fan. Tapping a cluster of up to one ring's worth of members ALWAYS opens it
// as a ring of its own pins around the spot they share, each on a leader line back to it — at
// ANY zoom, MAX_ZOOM included, and with no camera move. The count is replaced by the glyphs
// and the names, which is the whole point: the number was never the answer, and neither is a
// zoom the user did not ask for. Only a group too big for one ring is worth the camera.
const SPIDER_MIN_R = 50;          // ring radius floor, in px from the shared coordinate
const SPIDER_R_PER = 3;           // …plus this much per member
const SPIDER_RING_MAX = 8;        // above this the fan is a spiral rather than one ring
// How big a group a TAP fans in place instead of flying the camera at. The fault was
// exactly that a 2-cluster and a 3-cluster would not split, so the answer has to cover those
// and the four-way knots beside them. Measured higher and rejected: an eight-way fan opened
// over an old town at 390 m/screen put its ring straight through nine other discs, three of its
// eight names survived the collision test, and the ring read as debris rather than as an
// answer. Above this a zoom that actually separates the group is the better reply, and when
// no such zoom exists — coincident coordinates, or MAX_ZOOM — openCluster() fans anyway.
const FAN_TAP_MAX = 4;
const SPIDER_DROP_DZ = 0.35;      // a zoom change this big folds the fan back up
const LABEL_MIN_ZOOM = 10;        // below this only the selected pin is labelled
// Above this a cluster shows its count and nothing else. A region name earns its place when
// the clusters ARE the regions — four discs across a country, each reading its region's
// name. Zoomed into one district every cluster is the same city, and six identical labels
// stacked down the screen say nothing at all. The zoom alone doesn't settle that (a trip with
// forty places in one valley is a dozen discs in one region at an overview zoom): see
// nameGroups().
const REGION_LABEL_MAX_ZOOM = 9;
const CULL_PX = 90;               // keep markers this far outside the viewport before dropping
// The pin is drawn from its tip, so it occupies space up and out from the coordinate. Fitting
// bounds to the coordinates alone puts the easternmost pin under the controls and the
// northernmost one behind the chips — measured, not hypothetical.
const PIN_UP_PX = 40;
const PIN_SIDE_PX = 17;
const PIN_LABEL_PX = 18;
const TAP_SLOP_PX = 9;            // movement above this turns a tap into a drag (flat view)
const DOUBLE_TAP_MS = 320;
const CAM_TTL_MS = 12 * 3600e3;   // a saved camera older than this is stale; recompute instead
const SHEET_DRAG_DISMISS_PX = 44; // drag the grab bar down this far and the sheet closes
const RECLUSTER_PAN_PX = 32;      // pan further than this and cluster membership is re-derived
const SCALE_RULE_PX = 84;         // the ruler NEVER changes width. Only the value.

// THE REGIONS come from the trip: its top-level areas (public/js/areas.js reads them). The
// cluster labels name them, the drawn ground shades the ones that have bounds, and "where the
// trip is today" is the region of the place the itinerary is at. A trip with no areas has no
// plates and no region names, and is still a map of its places.

// The teardrop, as one path, rather than a CSS circle with a rotated square behind it: the
// square's corner has to sit under the circle's border, and every way of doing that leaves
// the border arc visible across the tail. viewBox 34x42, tip at (17, 40.8) — that point is
// what lands on the coordinate.
const PIN_PATH = "M17 40.8C17 40.8 2.5 26.4 2.5 17a14.5 14.5 0 1 1 29 0c0 9.4-14.5 23.8-14.5 23.8Z";

// VoiceOver reads "NE" as two letters. The pill stays abbreviated because it has to fit on a
// 390px screen next to a distance; the word goes in the aria-label.
const COMPASS_WORDS = {
  N: "north", NNE: "north-northeast", NE: "northeast", ENE: "east-northeast",
  E: "east", ESE: "east-southeast", SE: "southeast", SSE: "south-southeast",
  S: "south", SSW: "south-southwest", SW: "southwest", WSW: "west-southwest",
  W: "west", WNW: "west-northwest", NW: "northwest", NNW: "north-northwest",
};

// 1-2-5 ladder in metres, for the graticule step.
const NICE_M = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000,
                10000, 20000, 50000, 100000, 200000, 500000];
const GRID_MAJOR = 5;             // every fifth graticule line is drawn in --line-strong

// The trip's own offline map (docs/API.md, "The trip's map": GET /api/trips/<id>/tiles, with
// Range). The snapshot says whether there is one and which (store.tiles(): state, version,
// bytes, note, glyphs, ready); this address is only asked when it says there is one to read.
// The copy the phone keeps is stored under the bare address, with the version it is in a
// header of its own; what is read over the network names the version, so that no cache
// between here and the server can hand back a range of the map before it. Keeping it is
// map-keep.js's, and so is the budget (MAX_STASH_BYTES): above it a map is read by range from
// the network, and stops working the moment the signal does, unless the person says to keep it.
const TRIP = tripIdFromPath(location.pathname) || "";
const ARCHIVE_URL = archiveUrl(TRIP);
const archiveAt = (version) => (version ? `${ARCHIVE_URL}?v=${encodeURIComponent(version)}` : ARCHIVE_URL);
const GL_ERROR_BUDGET = 4;        // after the map is up, tolerate this many range failures

const SHEET_KEY = "wgp.map.sheet";
const CAM_KEY = "wgp.map.cam";
// A choice about this trip, stored once per trip: see TRIP_KEYS in trip-here.js.
const here = (k) => tripKey(k, tripIdFromPath(location.pathname));

// ── module-scope state, deliberately outside mount() ───────────────────────────────────
// The router caches the module namespace, so these survive navigation within a session:
// leaving the map for Pack and coming back returns to the same view rather than re-fitting,
// and the pmtiles header/directory cache is not re-read. The across-launch half is saveCam()
// and readSheetPref().

let lastCam = null;
let lastSelected = null;
let protoRegistered = false;
let sharedProtocol = null;
let sharedArchive = null;         // PMTiles instance, kept so remounts skip the header read
let sharedKey = "";               // the address the style reads it by (archiveAt(version))
let sharedVersion = null;         // the version of the map that instance reads
let webglVerdict = null;
let cssInjected = false;

// ── Web Mercator ───────────────────────────────────────────────────────────────────────

const MAX_LAT = 85.051129;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clampLat = (v) => clamp(v, -MAX_LAT, MAX_LAT);
const worldSize = (z) => TILE * Math.pow(2, z);

function mx(lng, ws) { return ((lng + 180) / 360) * ws; }
function my(lat, ws) {
  const s = Math.sin(clampLat(lat) * D2R);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * ws;
}
function unmx(x, ws) { return (x / ws) * 360 - 180; }
function unmy(y, ws) {
  const n = Math.PI - (2 * Math.PI * y) / ws;
  return R2D * Math.atan(Math.sinh(n));
}
// Metres per CSS pixel at a latitude. Mercator stretches with latitude, so a scale bar that
// ignores it is 3% wrong at 12° of latitude and would be 40% wrong in Iceland.
function mppAt(lat, z) {
  return (40075016.686 * Math.cos(clampLat(lat) * D2R)) / worldSize(z);
}
const wrapLng = (l) => ((((l + 180) % 360) + 360) % 360) - 180;

// A place with no coordinates is not a place at 0,0 — Null Island is 2,600 km off the coast
// of Ghana, and one pin there ruins every fit-bounds on the screen. Held out of the map.
function usable(p) {
  const la = Number(p && p.lat), ln = Number(p && p.lng);
  return Number.isFinite(la) && Number.isFinite(ln) &&
         Math.abs(la) <= 90 && Math.abs(ln) <= 180 &&
         !(Math.abs(la) < 1e-7 && Math.abs(ln) < 1e-7);
}

// ── small helpers ──────────────────────────────────────────────────────────────────────

// The two easing tokens as strings, for WAAPI. Lazy and cached, with the same empty-read
// retry motion.js uses: a module can run before its stylesheet applies.
const EASES = new Map();
function easeTok(name, fallback) {
  const hit = EASES.get(name);
  if (hit) return hit;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!v) return fallback;
  EASES.set(name, v);
  return v;
}
const easeOutTok = () => easeTok("--ease-out", "cubic-bezier(.2,.8,.2,1)");
const easeSpringTok = () => easeTok("--ease-spring", "cubic-bezier(.34,1.3,.64,1)");

// Chrome glyphs only — the three controls and the sheet's own marks. Everything that stands
// for a PLACE comes from icons.js, which is the module that guarantees no two of them differ
// by hue alone.
const icon = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICO = {
  // A north needle, not a compass rose: it has ONE unambiguous point and it is the shape that
  // rotates. The near half is knocked back so which end is north survives dichromacy.
  compass: '<path d="M12 3.4 16.4 20.6 12 17.1 7.6 20.6Z" fill="currentColor" stroke="none"/>' +
           '<path d="M12 17.1 7.6 20.6 12 3.4Z" fill="var(--surface)" stroke="none" opacity=".5"/>',
  fit: '<path d="M4 9V4.5h5M20 9V4.5h-5M4 15v4.5h5M20 15v4.5h-5"/>',
  locate: '<path d="M12 3.2v3.1M12 17.7v3.1M3.2 12h3.1M17.7 12h3.1M17.4 12a5.4 5.4 0 1 1-10.8 0 5.4 5.4 0 0 1 10.8 0ZM12.8 12a.8.8 0 1 1-1.6 0 .8.8 0 0 1 1.6 0Z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  up: '<path d="m6 14.5 6-6 6 6"/>',
  arrow: '<path d="M12 3.2 19.2 20.4 12 16.3 4.8 20.4Z" fill="currentColor" stroke="none"/>',
};

// Google Maps ONLY — no Apple/geo branches anywhere. The universal
// https form opens the native app where one is installed and the web where none is. It
// carries lat/lng as the target rather than a name string: one city can have an avenue and
// a street of the same name in two districts, 2.2 km apart, and a text search is a
// coin flip between them. Coordinates never are.
const googleMapsUrl = (p) => {
  const u = `https://www.google.com/maps/search/?api=1&query=${p.lat}%2C${p.lng}`;
  return p.gmaps_place_id ? `${u}&query_place_id=${encodeURIComponent(p.gmaps_place_id)}` : u;
};

const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
function catToneVars(kind) {
  const c = categoryOf(kind);
  return `--ds-k:var(--cat-${c});--ds-k-bg:var(--cat-${c}-bg);--ds-k-edge:var(--cat-${c}-edge);--ds-k-on:var(--cat-${c}-on)`;
}

// The open/closed pill for the abridged card. Same words and the same tone tokens the list
// row uses, because it is the same claim — but built here rather than imported, since
// places.js keeps openPill() private and a second export is a wider contract than one string.
// Every variant carries a WORD as well as a colour.
function openPillHtml(st) {
  if (!st) return "";
  if (st.always) return `<span class="pill pill-ok">Open 24 h</span>`;
  if (st.open) {
    return st.mins <= 45
      ? `<span class="pill pill-warn">Closing ${esc(hhmm(st.until))}</span>`
      : `<span class="pill pill-ok">Open till ${esc(hhmm(st.until))}</span>`;
  }
  if (st.today) return `<span class="pill pill-warn">Opens ${esc(hhmm(st.at))}</span>`;
  return `<span class="pill">Closed</span>`;
}

// ── styles ─────────────────────────────────────────────────────────────────────────────
// Injected once, from here, for the ownership reason in the header. Only .mp-* selectors,
// plus reuse of the shared kit (.btn, .pill, .meta, .ico) and — in the nearby list — of
// Places' OWN row (.pl-row and its children, matching the list view).
// That reuse is deliberate and safe in one direction only: this map is mounted by places.js,
// so its stylesheet is always in the document before these rules matter.
// Every colour is a token.

const CSS = `
.mp-root{
  position:relative; overflow:hidden;
  background:var(--canvas);
  color:var(--ink-1);
  /* Its edges and height are written and then measured (fitShell, measure): a transition of
     any length on it would hand the old box back to that read. */
  transition-property:none;
  /* Room the shell's fixed dock takes out of the bottom-left, added to the sheet so its last
     line is never underneath the back button. One number, used in two places. */
  --mp-dock:0px;
  --mp-scale-floor:0px;
  --mp-card-h:226px;
}
body[data-back="1"] .mp-root,
body[data-netpill="1"] .mp-root{--mp-dock:var(--back-h)}
body[data-back="1"][data-netpill="1"] .mp-root{--mp-dock:calc(var(--back-h) * 2)}
body[data-back="1"] .mp-root,
body[data-netpill="1"] .mp-root{--mp-scale-floor:calc(max(var(--mp-under, 0px), var(--tabbar-space, 0px)) + var(--sp-3) + var(--dock-room, 0px) + var(--sp-2))}
body[data-two="1"]:not([data-netpill="1"]) .mp-root{--mp-scale-floor:0px}

.mp-root[data-fit="bleed"]{
  margin-top:calc(-1 * var(--sp-4));
  margin-bottom:calc(-1 * var(--sp-6));
  margin-left:calc(-1 * max(var(--sp-4), var(--sa-left)));
  margin-right:calc(-1 * max(var(--sp-4), var(--sa-right)));
}
.mp-root[data-fit="fill"]{position:absolute; inset:0; margin:0}

.mp-surface{
  position:absolute; inset:0;
  user-select:none; -webkit-user-select:none; -webkit-touch-callout:none;
}
.mp-root[data-engine="flat"] .mp-surface{touch-action:none}
.mp-surface > .mp-gl{position:absolute; inset:0; overflow:hidden}
.mp-gl canvas:focus:not(:focus-visible){outline:none}
.mp-scrim{position:absolute; inset:0; background:var(--canvas); opacity:.06; pointer-events:none}
.mp-ink{position:absolute; inset:0; width:100%; height:100%; pointer-events:none}
.mp-layer{position:absolute; inset:0; pointer-events:none; touch-action:none}

/* Markers: category-coloured circular pins on Void/Light with contrasting glyph; dark circular clusters with mono count */
.mp-pin,.mp-cluster{
  position:absolute; left:0; top:0; width:0; height:0;
  pointer-events:auto; -webkit-tap-highlight-color:transparent;
}
.mp-pin-body{
  position:absolute; left:-16px; top:-34px; width:var(--control-32); height:var(--control-32);
  border-radius:var(--radius-full); display:grid; place-items:center;
  background:var(--ds-k, var(--solid)); color:var(--ds-k-on, var(--on-solid));
  border:2px solid var(--canvas); box-shadow:var(--shadow-pop);
  transform-origin:50% 100%;
  transition:transform var(--dur-fast, 120ms) var(--ease-standard);
}
.mp-pin-body::before{content:""; position:absolute; inset:-6px}
.mp-pin-glyph{
  display:grid; place-items:center; color:inherit;
}
/* NOTE TO ANYONE EDITING THIS BLOCK: no backticks in CSS template comments. */
.mp-pin-glyph .ico{width:16px; height:16px; stroke-width:1.9}
.mp-pin[data-anchor="1"] .mp-pin-body{
  box-shadow:0 0 0 2px var(--canvas), 0 0 0 3.5px var(--ds-k, var(--ink-1)), var(--shadow-pop);
}
.mp-pin[data-on="1"] .mp-pin-body{
  transform:scale(1.15);
  box-shadow:0 0 0 2px var(--canvas), 0 0 0 4px var(--ds-k, var(--ink-1)), var(--shadow-pop);
}
.mp-pin[data-press="1"] .mp-pin-body{transform:scale(.94)}
.mp-pin[data-on="1"][data-press="1"] .mp-pin-body{transform:scale(1.08)}
@media (hover: hover) and (pointer: fine){
  .mp-pin:active .mp-pin-body{transform:scale(.94)}
  .mp-pin[data-on="1"]:active .mp-pin-body{transform:scale(1.08)}
}
.mp-pin-label{
  position:absolute; left:50%; top:4px;
  transform:translateX(-50%) translateX(var(--lab-dx,0px));
  max-width:140px; padding:2px 7px; border-radius:var(--radius-8);
  background:var(--chrome); border:1px solid var(--edge); color:var(--ink-1);
  box-shadow:var(--shadow-pop);
  font-family:var(--type-ui); font-size:var(--size-12); font-weight:600; line-height:1.35;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.mp-pin[data-label="0"] .mp-pin-label{display:none}
.mp-pin[data-labpos="above"] .mp-pin-label{top:auto; bottom:42px}
.mp-pin[data-on="1"] .mp-pin-label{background:var(--ds-k, var(--solid)); border-color:var(--ds-k, var(--solid)); color:var(--ds-k-on, var(--on-solid))}

.mp-cluster-body{
  position:absolute; left:-21px; top:-21px; width:42px; height:42px;
  border-radius:var(--radius-full); display:grid; place-items:center;
  background:var(--chrome); border:1.5px solid var(--edge-strong);
  color:var(--ink-1); box-shadow:var(--shadow-pop);
  font-family:var(--type-mono); font-size:var(--size-14); font-weight:600;
  font-variant-numeric:tabular-nums; letter-spacing:var(--track-number);
  transition:transform var(--dur-fast, 120ms) var(--ease-standard);
}
.mp-cluster[data-cat="1"] .mp-cluster-body{
  background:var(--ds-k); color:var(--ds-k-on); border:2px solid var(--canvas);
}
.mp-cluster[data-mix="1"] .mp-cluster-body{
  background:radial-gradient(circle, var(--chrome) 0 64%, transparent 66%), var(--ds-ring);
  border:2px solid var(--canvas); color:var(--ink-1);
}
.mp-cluster[data-press="1"] .mp-cluster-body{transform:scale(.94)}
@media (hover: hover) and (pointer: fine){
  .mp-cluster:active .mp-cluster-body{transform:scale(.94)}
}
.mp-cluster-name{
  position:absolute; left:50%; top:24px; transform:translateX(-50%);
  padding:2px 7px; border-radius:var(--radius-8);
  background:var(--chrome); border:1px solid var(--edge); color:var(--ink-2);
  box-shadow:var(--shadow-pop);
  font-family:var(--type-ui); font-size:var(--size-12); font-weight:600; white-space:nowrap;
}

/* Spider fan */
.mp-legs{
  position:absolute; left:0; top:0; width:100%; height:100%;
  overflow:visible; pointer-events:none;
}
.mp-legs .mp-leg-case{stroke:var(--canvas); stroke-width:4; stroke-linecap:round; fill:none}
.mp-legs .mp-leg{stroke:var(--ink-2); stroke-width:1.6; stroke-linecap:round; fill:none}
.mp-hub{
  position:absolute; left:0; top:0; width:0; height:0;
  pointer-events:auto; -webkit-tap-highlight-color:transparent;
}
.mp-hub-body{
  position:absolute; left:-10px; top:-10px; width:20px; height:20px;
  border-radius:var(--radius-full); background:var(--chrome); border:2px solid var(--ink-1);
  box-shadow:var(--shadow-pop); transition:transform var(--dur-fast, 120ms) var(--ease-standard);
}
.mp-hub-body::before{content:""; position:absolute; left:-12px; right:-12px; top:-12px; bottom:-12px}
.mp-hub[data-press="1"] .mp-hub-body{transform:scale(.9)}
@media (hover: hover) and (pointer: fine){
  .mp-hub:active .mp-hub-body{transform:scale(.9)}
}
@media (prefers-reduced-motion:reduce){
  .mp-hub-body,.mp-cluster-body,.mp-pin-body{transition:none}
}

/* GPS dot */
.mp-me{position:absolute; left:0; top:0; width:0; height:0}
.mp-me-acc{
  position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  border-radius:var(--radius-full); background:var(--fill); opacity:.45; border:1px solid var(--edge-strong);
}
.mp-me-dot{
  position:absolute; left:-8px; top:-8px; width:16px; height:16px;
  border-radius:var(--radius-full); background:var(--solid);
  border:2.5px solid var(--canvas); box-shadow:var(--shadow-pop);
}
.mp-me[data-stale="1"] .mp-me-dot{background:var(--ink-2)}

/* Offline / map status card */
.mp-note{
  position:absolute; left:max(var(--sp-3), var(--sa-left)); right:max(var(--sp-3), var(--sa-right));
  top:calc(var(--mp-note-top, 0px) + var(--sp-3));
  display:flex; flex-wrap:wrap; align-items:center; gap:var(--sp-2) var(--sp-3);
  padding:var(--sp-3); border-radius:var(--radius-16);
  background:var(--chrome); border:1px solid var(--edge); box-shadow:var(--shadow-pop);
  color:var(--ink-1); font-size:var(--size-14); line-height:1.45;
}
.mp-note[hidden]{display:none}
.mp-note-t{flex:1 1 200px; min-width:0; margin:0}
.mp-note-acts{display:flex; gap:var(--sp-2); flex:0 0 auto}
.mp-note-acts .ds-button--white{background:var(--solid); color:var(--on-solid); border-color:transparent; font-weight:600}
.mp-note-acts .ds-button--gray{background:var(--fill); border-color:var(--edge); color:var(--ink-1); font-weight:600}
.mp-note-more{flex:1 1 100%; min-width:0; margin:0; color:var(--ink-2)}

/* Picker pin */
.mp-pickpin{
  position:absolute; left:50%; top:50%; width:34px; height:42px;
  transform:translate(-50%, -97.2%);
  pointer-events:none; filter:drop-shadow(0 2px 4px var(--backdrop));
}
.mp-pickpin[hidden]{display:none}
.mp-pickpin svg{display:block; width:100%; height:100%}
.mp-pickpin path{fill:var(--solid); stroke:var(--canvas); stroke-width:1.8}
.mp-pickpin circle{fill:var(--on-solid)}
.mp-root[data-pick="1"] .mp-sheet,
.mp-root[data-pick="1"] .mp-peek,
.mp-root[data-pick="1"] .mp-note{display:none}
.mp-root[data-bare="1"] .mp-sheet,
.mp-root[data-bare="1"] .mp-peek{display:none}
.mp-root[data-pick="1"] .mp-scale{left:calc(10px + var(--control-44) + var(--sp-2))}
.mp-root[data-pick="1"] .mp-pin,
.mp-root[data-pick="1"] .mp-cluster,
.mp-root[data-pick="1"] .mp-hub{pointer-events:none; opacity:.6}

/* Controls, scale & peek */
.mp-ctrls{
  position:absolute; right:max(var(--sp-3), var(--sa-right));
  bottom:max(var(--mp-chrome, 12px), var(--mp-floor, 0px));
  display:flex; flex-direction:column; align-items:flex-end; gap:8px;
}
.mp-btns{display:flex; flex-direction:column; align-items:flex-end; gap:8px}
@media (max-height: 500px){ .mp-btns{flex-direction:row} }
.mp-ctrl{
  position:relative; width:var(--control-44); height:var(--control-44); border-radius:var(--radius-full);
  display:grid; place-items:center;
  background:var(--fill); border:1px solid var(--edge);
  color:var(--ink-1); box-shadow:var(--shadow-pop);
  -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px);
  transition:background var(--dur-150) var(--ease-standard), transform var(--dur-150) var(--ease-standard);
}
.mp-ctrl[data-press="1"]{background:var(--fill-active); transform:scale(.95)}
@media (hover: hover) and (pointer: fine){
  .mp-ctrl:hover{background:var(--fill-hover)}
  .mp-ctrl:active{background:var(--fill-active); transform:scale(.95)}
}
.mp-ctrl svg{width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round}
.mp-ctrl[data-geo="on"]{background:var(--solid); color:var(--on-solid); border-color:var(--solid)}
.mp-ctrl[data-geo="locating"] svg{animation:mp-spin 1.6s linear infinite}
.mp-ctrl[data-geo="denied"]{color:var(--ink-3)}
.mp-needle{display:grid; place-items:center; transition:transform var(--dur-fast, 120ms) linear}
.mp-ctrl[data-north="1"] .mp-needle{color:var(--ink-2)}
@keyframes mp-spin{to{transform:rotate(360deg)}}

.mp-scale{
  position:absolute; left:max(var(--sp-3), var(--sa-left));
  bottom:max(var(--mp-chrome, 12px), var(--mp-scale-floor, 0px));
  display:flex; flex-direction:column; align-items:flex-start; gap:3px;
  padding:5px 8px 4px; border-radius:var(--radius-12);
  background:var(--fill); border:1px solid var(--edge);
  -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px);
  color:var(--ink-2); font-family:var(--type-mono); font-size:var(--size-12); font-weight:500;
  line-height:1.1; font-variant-numeric:tabular-nums; letter-spacing:var(--track-number);
  white-space:nowrap;
}
.mp-scale-t{padding-left:1px}
.mp-scale-rule{
  position:relative; width:84px; height:6px;
  border-left:1.5px solid currentColor; border-right:1.5px solid currentColor;
  border-bottom:1.5px solid currentColor;
}
.mp-scale-rule::after{
  content:""; position:absolute; left:50%; bottom:0; width:1.5px; height:3px;
  background:currentColor;
}

.mp-peek{
  display:inline-flex; align-items:center; gap:6px;
  height:var(--control-44); padding:0 var(--sp-3) 0 var(--sp-4);
  border-radius:var(--radius-full);
  background:var(--fill); border:1px solid var(--edge);
  box-shadow:var(--shadow-pop);
  -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px);
  color:var(--ink-1); font-family:var(--type-ui); font-size:var(--size-14); font-weight:600;
  white-space:nowrap;
}
.mp-peek svg{width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round}
.mp-peek[data-press="1"]{background:var(--fill-active)}
@media (hover: hover) and (pointer: fine){
  .mp-peek:active{background:var(--fill-active)}
}
.mp-root[data-sheet="open"] .mp-peek{display:none}

/* Sheet: nearby list & abridged card */
.mp-sheet{
  position:absolute; left:0; right:0; bottom:0;
  display:flex; flex-direction:column;
  height:calc(clamp(190px, 36%, 300px) + var(--mp-dock));
  background:var(--chrome);
  border-top:1px solid var(--edge);
  border-radius:var(--radius-24) var(--radius-24) 0 0;
  box-shadow:var(--shadow-pop);
  overflow:hidden;
  transition:transform var(--dur-320) var(--ease-standard);
  will-change:transform;
}
@media (max-height: 420px) and (min-width: 480px){ .mp-sheet{height:calc(150px + var(--mp-dock))} }
.mp-root[data-mode="card"] .mp-sheet{height:calc(var(--mp-card-h) + var(--mp-dock) + var(--mp-under, 0px))}
.mp-root[data-sheet="shut"] .mp-sheet{transform:translateY(101%); pointer-events:none}
.mp-root[data-dragging="1"] .mp-sheet{transition:none}

.mp-grab{
  flex:0 0 auto;
  display:block; width:100%; height:var(--control-44);
  background:var(--chrome);
  touch-action:none;
}
.mp-grab::after{
  content:""; display:block; width:36px; height:4px; border-radius:var(--radius-full);
  background:var(--gray-5); margin:calc((var(--control-44) - 4px) / 2) auto;
}
.mp-grab[data-press="1"]::after{background:var(--ink-2)}
@media (hover: hover) and (pointer: fine){
  .mp-grab:active::after{background:var(--ink-2)}
}

.mp-body{flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain;
  padding-bottom:calc(var(--mp-dock) + var(--mp-under, 0px))}
.mp-root:not([data-mode="card"]) .mp-body{
  padding-bottom:max(var(--foot-clear, 0px), calc(var(--mp-dock) + var(--mp-under, 0px) + var(--sp-6)))}
.mp-root[data-mode="card"] .mp-body{overflow:hidden}

.mp-list{display:flex; flex-direction:column}
.mp-list .pl-row{width:100%; text-align:left; border-top:1px solid var(--hair);
  padding:10px max(var(--sp-4), var(--sa-right)) 10px calc(max(var(--sp-4), var(--sa-left)) + 8px);
  border-radius:0}
.mp-list .pl-row::before{left:max(var(--sp-4), var(--sa-left))}
.mp-list .pl-row:first-child{border-top:0}
.mp-empty{padding:var(--sp-4) max(var(--sp-4), var(--sa-left)); color:var(--ink-2); font-size:var(--size-14)}

/* Abridged card */
.mp-card{
  display:flex; flex-direction:column; gap:7px;
  padding:0 max(var(--sp-4), var(--sa-right)) 10px max(var(--sp-4), var(--sa-left));
}
.mp-card-top{display:flex; align-items:center; gap:12px}
.mp-cat{
  flex:0 0 auto; width:44px; height:44px; border-radius:var(--radius-12);
  display:grid; place-items:center; overflow:hidden;
  background:var(--ds-k-bg, var(--gray-3)); border:1px solid var(--ds-k-edge, var(--hair)); color:var(--ds-k, var(--ink-1));
}
.mp-cat img{display:block; width:100%; height:100%; object-fit:cover}
.mp-cat .ico{width:20px; height:20px; stroke-width:1.8}
.mp-card-t{min-width:0}
.mp-title{
  font-family:var(--type-ui); font-weight:600; font-size:var(--size-16); line-height:1.3;
  letter-spacing:-.01em; color:var(--ink-1);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.mp-sub{
  margin-top:2px; font-size:var(--size-14); line-height:1.35; color:var(--ink-2);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.mp-x{
  position:relative; flex:0 0 auto; width:32px; height:32px; margin:-2px -6px 0 0;
  border-radius:var(--radius-full); display:grid; place-items:center; color:var(--ink-2);
}
/* 44px downward expander below grab bar */
.mp-x::before{content:""; position:absolute; left:-6px; right:-6px; top:0; height:var(--control-44)}
.mp-x[data-press="1"]{background:var(--fill-active); color:var(--ink-1)}
@media (hover: hover) and (pointer: fine){
  .mp-x:active{background:var(--fill-active); color:var(--ink-1)}
}
.mp-x svg{width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round}

.mp-pills{display:flex; align-items:center; gap:6px; flex-wrap:nowrap; overflow:hidden}
.mp-dist{
  flex:0 0 auto;
  display:inline-flex; align-items:center; gap:5px;
  padding:2px 8px; border-radius:var(--radius-full);
  background:var(--well); border:1px solid var(--edge); color:var(--ink-1);
  font-family:var(--type-mono); font-size:var(--size-12); font-weight:600;
  font-variant-numeric:tabular-nums; letter-spacing:var(--track-number);
}
.mp-dist svg{width:12px; height:12px; fill:currentColor; stroke:none}
.mp-pills .pill{flex:0 0 auto; display:inline-flex; align-items:center; padding:2px 8px;
  border-radius:var(--radius-full); font-size:var(--size-12); font-weight:600; line-height:1.35;
  background:var(--well); border:1px solid var(--edge); color:var(--ink-2)}
.mp-pills .pill.pill-ok{color:var(--positive); background:var(--positive-bg); border-color:var(--positive-edge)}
.mp-pills .pill.pill-warn{color:var(--warning); background:var(--warning-bg); border-color:var(--warning-edge)}

.mp-addr{
  font-size:var(--size-14); line-height:1.35; font-weight:500; color:var(--ink-2);
  overflow:hidden; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2;
}
.mp-acts{display:flex; gap:8px; margin-top:auto; padding-top:2px; margin-right:var(--mp-acts-r, 0px)}
@media (max-height: 420px) and (min-width: 480px){
  .mp-root{--mp-card-h:207px}
  .mp-card{gap:5px; padding-bottom:8px}
  .mp-addr{display:block; -webkit-line-clamp:unset; white-space:nowrap; text-overflow:ellipsis}
}
.mp-acts .btn{
  flex:1 1 0; min-width:0; height:var(--control-44); padding:0 14px;
  border-radius:var(--radius-16); font-size:var(--size-14); font-weight:600; line-height:1.2;
}
.mp-acts .btn.ds-button--white{background:var(--solid); color:var(--on-solid); border-color:transparent}
.mp-acts .btn.ds-button--gray{background:var(--fill); border-color:var(--edge); color:var(--ink-1)}
@media (hover: hover) and (pointer: fine){
  .mp-acts .btn.ds-button--white:hover{background:var(--solid-hover)}
  .mp-acts .btn.ds-button--gray:hover{background:var(--fill-hover)}
}
`;

function injectCss() {
  if (cssInjected || document.getElementById("mp-css")) { cssInjected = true; return; }
  // The guard that would have caught the backtick, in one line. A stylesheet that is not a
  // long string is not a stylesheet, and an unstyled map looks like a broken map rather than
  // like a broken build.
  if (typeof CSS !== "string" || CSS.length < 2000) {
    console.error("[map] stylesheet did not build — check for a stray backtick in the CSS template");
    return;
  }
  const s = document.createElement("style");
  s.id = "mp-css";
  s.textContent = CSS;
  document.head.append(s);
  cssInjected = true;
}

// ── persistence ────────────────────────────────────────────────────────────────────────
// Module scope covers navigation. localStorage covers a relaunch — but the CAMERA only for a
// while: reopening the app at breakfast should land on today's region, not on wherever the
// map was left last night. The SHEET state has no such expiry; it is a preference, and
// preserving user preference across visits.

const CAM_SAVE_MS = 500;
let camSavedAt = 0, camTimer = 0, camPending = null;
function flushCam() {
  clearTimeout(camTimer);
  camTimer = 0;
  if (!camPending) return;
  camSavedAt = Date.now();
  try {
    localStorage.setItem(here(CAM_KEY), JSON.stringify({ ...camPending, at: camSavedAt }));
  } catch { /* private mode; module scope still covers this session */ }
  camPending = null;
}
// Throttled, and called from every camera change rather than only from the last frame of an
// animation. An ease that is interrupted — the user grabs the map, or the PWA is backgrounded
// and rAF stops — otherwise never reaches its final frame and never writes anything, so the
// next launch restores a camera from two interactions ago. Leading write plus a TRAILING one:
// a throttle with no trailing edge silently discards the last position of every gesture.
function saveCam(cam, force) {
  camPending = cam;
  const since = Date.now() - camSavedAt;
  if (force || since >= CAM_SAVE_MS) flushCam();
  else if (!camTimer) camTimer = setTimeout(flushCam, CAM_SAVE_MS - since);
}

// Whether a stored camera is anywhere near the trip is asked where it is used (initialCamera):
// a camera can end up a continent away through a bad restore, a corrupted write, or a bug,
// and once it is in localStorage it comes back on every launch, on a screen whose content is
// all somewhere else. Refusing it costs nothing and makes the map self-healing.
function loadCam() {
  try {
    const v = JSON.parse(localStorage.getItem(here(CAM_KEY)) || "null");
    if (!v || !Number.isFinite(v.lng) || !Number.isFinite(v.lat) || !Number.isFinite(v.zoom)) return null;
    if (Date.now() - (v.at || 0) > CAM_TTL_MS) return null;
    return {
      lng: v.lng, lat: v.lat, zoom: clamp(v.zoom, MIN_ZOOM, MAX_ZOOM),
      bearing: Number.isFinite(v.bearing) ? v.bearing : 0,
      pitch: Number.isFinite(v.pitch) ? clamp(v.pitch, 0, MAX_PITCH) : 0,
      auto: !!v.auto,
      sheetH: Number.isFinite(v.sheetH) ? v.sheetH : null,
    };
  } catch { return null; }
}

// "open" unless the user has said otherwise. Someone who has never touched the handle should
// still be met by the nearest-to-you list, which is the map's single most useful answer.
let sheetPref = null;
function readSheetPref() {
  if (sheetPref) return sheetPref;
  try { sheetPref = localStorage.getItem(SHEET_KEY) === "shut" ? "shut" : "open"; }
  catch { sheetPref = "open"; }
  return sheetPref;
}
function writeSheetPref(v) {
  sheetPref = v;
  try { localStorage.setItem(SHEET_KEY, v); } catch { /* private mode */ }
}

// ── the URL query ──────────────────────────────────────────────────────────────────────
// Places writes it; we read it. See "the host contract" in the header.
function readQuery() {
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  return {
    kind: (q.get("kind") || "all").toLowerCase(),
    sub: (q.get("sub") || "all").toLowerCase(),
    text: (q.get("q") || "").trim().toLowerCase(),
    focus: q.get("focus") || null,
  };
}

function normFilter(f) {
  const pick = (a, b) => String((f && (f[a] != null ? f[a] : f[b])) || "").trim().toLowerCase();
  return {
    kind: pick("kind", "category") || "all",
    sub: pick("sub", "subkind") || "all",
    text: pick("text", "q"),
  };
}

// ── mount ──────────────────────────────────────────────────────────────────────────────
//
// ── ONE MAP, KEPT ALIVE ──────────────────────────────────────────────────────────────────
// Kept alive across tab switches so reopening avoids a 0.5–1s tile/context cold start: the cause was structural
// rather than slow: places.js calls mountMap() on every switch to the map face and destroy()
// on every switch away, and calling map.remove() in destroy() meant every return paid
// for a fresh WebGL2 context, a style parse, a pmtiles header read and a full tile fetch
// round — half a second of black before a single street appeared, on a screen the user had
// already been looking at a minute earlier.
//
// So mountMap() is now a DOOR onto a session that outlives it. createSession() builds the map
// exactly once per app run; mountMap() claims that session for a host element and destroy()
// merely RELEASES it — the root comes out of the DOM, the GPS watch stops, the rAF stops, and
// MapLibre keeps its context, its style, its loaded tiles and its camera untouched. Coming
// back re-parents one element and asks for one repaint, so the map is on screen in the frame
// the route change lands in, with the same tiles already decoded.
//
// TOKENS, because the crossfade overlaps. places.js fades the outgoing map out and calls
// destroy() when the animation lands — up to ~420 ms after the switch. Toggle back inside that
// window and the claim happens BEFORE the old handle's destroy(): every claim takes a fresh
// token, and release() is a no-op unless its token is still the current one. A stale destroy
// can therefore never pull the live map out from under the view that just claimed it.

let keeper = null;    // the one live session, or null before the first mount

/**
 * The embeddable form. Returns a handle rather than a bare unmount function, so places.js can
 * drive the map without a remount.
 *
 * @param {HTMLElement} el   host. With opts.bleed === false it must be position:relative and
 *                           have a real height; the map fills it (and then some — fitShell).
 * @param {{store, router, params, route}} ctx
 * @param {{bleed?: boolean, filter?: object}} opts
 * @returns {{root: HTMLElement, destroy(): void, setFilter(f): void, select(id, o?): void}}
 */
export function mountMap(el, ctx, opts = {}) {
  const bleed = opts.bleed !== false;
  // Its "Nearby" list is Places' own rows (.pl-row): their styles, wherever the map is drawn.
  ensurePlacesCss();
  // A session is only reusable for the same shape of host and the same data. A different
  // store means a different trip (or a different signed-in user), and a different bleed mode
  // means a different set of CSS rules on the root — both are rebuilds, not re-attachments.
  if (keeper && (keeper.disposed || keeper.bleed !== bleed || keeper.store !== ctx.store)) {
    keeper.dispose();
    keeper = null;
  }
  if (!keeper) keeper = createSession(ctx, { ...opts, bleed });
  const s = keeper;
  const token = s.claim(el, opts);
  return {
    root: s.root,
    destroy: () => { s.release(token); },
    setFilter: (f) => { if (s.owns(token)) s.setFilter(f); },
    select: (id, o) => { if (s.owns(token)) s.select(id, o || { center: true }); },
  };
}

/**
 * The map as a way to say WHERE: a pin fixed in the middle, the map moved under it. For the
 * sheet that puts a place on the map (spot-picker.js). It is the one live session, lent to
 * another host: its camera, its tiles and its pins come with it, and when the picker is done
 * the host that had the map (Places, in its map view) has it back, where it left it.
 *
 * @param {HTMLElement} el   position:relative, with a real height
 * @param {{store, router}} ctx
 * @param {{lat?: number, lng?: number, box?: {west, south, east, north}}} o  where to open:
 *        on a pin already placed, else on a box (the place's area), else where the map was
 * @returns {{spot(): {lat: number, lng: number}, move(dx: number, dy: number): void,
 *            zoom(dz: number): void, destroy(): void}}
 */
export function mountPicker(el, ctx, o = {}) {
  if (keeper && (keeper.disposed || keeper.bleed !== false || keeper.store !== ctx.store)) {
    keeper.dispose();
    keeper = null;
  }
  // A session made here is the same one Places will claim later: no filter of the URL's.
  if (!keeper) keeper = createSession(ctx, { bleed: false, filter: {} });
  const s = keeper;
  const token = s.pickStart(el, o);
  return {
    spot: () => s.pickSpot(),
    move: (dx, dy) => s.pickMove(dx, dy),
    zoom: (dz) => s.pickZoom(dz),
    destroy: () => { s.pickEnd(token); },
  };
}

function createSession(ctx, opts = {}) {
  injectCss();
  const { store, router } = ctx;
  const bleed = opts.bleed !== false;
  let host = null;         // the element we are currently attached to; set by claim()
  let scroller = null;
  let gen = 0;             // the current claim's token
  let cameraSet = false;   // the camera has been put somewhere on purpose: see initialCamera()
  // Who owns the filter. A host that passes opts.filter (places.js embedding the map under
  // its own chip rows) drives it exclusively through setFilter()/select(), and
  // the URL listeners below stay unregistered — the host's URL is #/places?near=…&view=map,
  // whose params mean something else entirely and would reset the filter on every hashchange.
  // With no opts.filter (the #/map route form) the URL query is the filter, as before.
  const urlDriven = opts.filter == null;

  const S = {
    dead: false,
    // The map was being made while this screen was open, and its streets haven't drawn yet: the
    // card says it's made and on its way, so the frame or the plain ground between the two is
    // never a blank map without a word (the stills of 15 Nov). Drawn: the first idle after the
    // archive's style is set, or the archive given up on.
    sawCut: false, drawn: false,
    detached: true,           // true until the first claim(), and again after every release()
    w: 0, h: 0, sheetH: 0, padTop: 0,
    names: [],                // the plates' names as last written: { id, name, x, y, w, h, clear } (paintPlates)
    chrome: [],               // where the scale and the buttons stand on the surface: { l, r, t, b } (readChrome)
    // Until the trip says where it is (its places, else its regions): the whole planet.
    cam: { lng: 0, lat: 20, zoom: MIN_ZOOM, bearing: 0, pitch: 0 },
    filter: normFilter(opts.filter || readQuery()),
    selected: lastSelected,
    sheet: readSheetPref(),
    places: [],
    me: null,                 // { lat, lng, acc, at }
    geo: "off",               // off | locating | on | denied | error
    follow: false,
    watch: null,
    raf: 0,
    map: null,                // MapLibre instance, or null
    tiles: false,
    glDead: false,
    glErrors: 0,
    markers: new Map(),
    drop: false,              // next layoutMarkers pass stagger-drops its newborn markers
    abort: new AbortController(),
  };

  // ── DOM ──
  const root = document.createElement("div");
  root.className = "mp-root ds";
  root.dataset.fit = bleed ? "bleed" : "fill";
  root.dataset.sheet = S.sheet;
  root.dataset.mode = "list";
  root.dataset.engine = "flat";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Map of trip places");
  root.innerHTML = `
    <div class="mp-surface">
      <div class="mp-gl" aria-hidden="true"></div>
      <div class="mp-scrim" hidden></div>
      <canvas class="mp-ink" aria-hidden="true"></canvas>
      <div class="mp-layer"></div>
    </div>
    <div class="mp-note" role="status" hidden></div>
    <div class="mp-pickpin" aria-hidden="true" hidden><svg viewBox="0 0 34 42"><path d="${PIN_PATH}"/><circle cx="17" cy="17" r="5"/></svg></div>
    <div class="mp-scale" aria-hidden="true">
      <span class="mp-scale-t"></span><span class="mp-scale-rule"></span>
    </div>
    <div class="mp-ctrls">
      <div class="mp-btns">
        <button class="mp-ctrl" data-act="north" type="button" aria-label="Face north">
          <span class="mp-needle">${icon(ICO.compass)}</span>
        </button>
        <button class="mp-ctrl" data-act="fit" type="button" aria-label="Show all places">${icon(ICO.fit)}</button>
        <button class="mp-ctrl" data-act="geo" type="button" aria-label="Show my location">${icon(ICO.locate)}</button>
      </div>
      <button class="mp-peek" type="button"><span class="mp-peek-t">Nearby</span>${icon(ICO.up)}</button>
    </div>
    <div class="mp-sheet">
      <button class="mp-grab" type="button" aria-expanded="true"
        aria-label="Hide the nearby panel"></button>
      <div class="mp-body"></div>
    </div>
  `;
  // Deliberately NOT appended here: claim() owns where the root lives, and the session is
  // built once for hosts it has not met yet.

  const surface = root.querySelector(".mp-surface");
  const glHost = root.querySelector(".mp-gl");
  const scrim = root.querySelector(".mp-scrim");
  const noteEl = root.querySelector(".mp-note");
  const pickPin = root.querySelector(".mp-pickpin");
  const canvas = root.querySelector(".mp-ink");
  const layer = root.querySelector(".mp-layer");
  const ctrls = root.querySelector(".mp-ctrls");
  const scaleEl = root.querySelector(".mp-scale");
  const scaleText = root.querySelector(".mp-scale-t");
  const needle = root.querySelector(".mp-needle");
  const northBtn = ctrls.querySelector('[data-act="north"]');
  const peek = root.querySelector(".mp-peek");
  const peekText = root.querySelector(".mp-peek-t");
  const sheet = root.querySelector(".mp-sheet");
  const grab = root.querySelector(".mp-grab");
  const body = root.querySelector(".mp-body");
  const g2d = canvas.getContext("2d");

  // The fan's leader lines, under everything else in the layer: one <svg> reused rather than a
  // node per leg, so opening and folding a fan is an attribute write and not a DOM rebuild.
  const legsEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  legsEl.setAttribute("class", "mp-legs");
  legsEl.setAttribute("aria-hidden", "true");
  legsEl.hidden = true;
  layer.append(legsEl);

  const hubEl = document.createElement("button");
  hubEl.type = "button";
  hubEl.className = "mp-hub";
  hubEl.hidden = true;
  hubEl.innerHTML = `<span class="mp-hub-body"></span>`;
  hubEl.setAttribute("aria-label", "Close this group");
  layer.append(hubEl);

  const meEl = document.createElement("div");
  meEl.className = "mp-me";
  meEl.hidden = true;
  meEl.innerHTML = `<div class="mp-me-acc"></div><div class="mp-me-dot"></div>`;
  layer.append(meEl);
  const meAcc = meEl.querySelector(".mp-me-acc");

  let live = null;   // { box, text, arrow } — the only bits of the card that update per fix

  // ── data + filter ──
  // The trip's areas, read again only when a snapshot brought new ones (store.areas() is the
  // same array until then).
  let areasFrom = null;
  let AR = readAreas([]);
  const areaLabel = (code) => AR.label(code);
  function readPlaces() {
    const rows = store.areas();
    if (rows !== areasFrom) { areasFrom = rows; AR = readAreas(rows); }
    S.places = store.places().filter(usable);
    if (S.selected && !S.places.some((p) => p.id === S.selected)) S.selected = null;
  }

  // Places' filter row, applied to pins. Kind is matched through categoryOf() so the spellings
  // display aliases ("sights", "do", "stays") and the ones the database uses resolve to the same
  // thing — one side being wrong would silently empty the map.
  function matches(p) {
    const f = S.filter;
    if (f.kind !== "all" && categoryOf(p.kind) !== categoryOf(f.kind)) return false;
    if (f.sub !== "all" && String(p.subkind || "").toLowerCase() !== f.sub) return false;
    if (f.text) {
      const hay = `${p.name || ""} ${p.name_local || ""} ${p.address || ""} ${p.subkind || ""} ${placeWhat(p)}`;
      if (!hay.toLowerCase().includes(f.text)) return false;
    }
    return true;
  }
  const visible = () => S.places.filter(matches);
  const placeById = (id) => S.places.find((p) => p.id === id) || null;

  // ── theme-derived values ──
  // The canvas needs colours as VALUES, not var() references, so they are re-read whenever the
  // theme changes rather than on every frame.
  let palette = null;
  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    const get = (n) => cs.getPropertyValue(n).trim();
    palette = {
      ground: get("--canvas") || get("--ground"),
      plate: get("--well") || get("--surface-2"),
      line: get("--hair") || get("--line"),
      lineStrong: get("--edge-strong") || get("--line-strong"),
      ink3: get("--ink-2") || get("--ink-3"),
      accent: get("--ink-1") || get("--solid") || get("--accent"),
      font: get("--type-ui") || get("--font-ui") || "system-ui, sans-serif",
    };
  }
  readPalette();

  // ── where the map actually sits ────────────────────────────────────────────────────────
  // The host is a box under a head that grows and above a padding we are not allowed to
  // reach. Rather than ask places.js to change, the root walks its own edges out onto #view's
  // padding box and keeps them there: if the chip row appears and pushes the host down 40px,
  // the next pass takes 40px more off the top and the canvas has not moved a pixel.
  // The offsets come from the HOST's box and the scroller's, never from the root's own: a
  // box that is in a transition reads as the old box straight after a write, and corrections
  // measured on the root itself were once applied again on every pass (71px a time, on a map
  // that then sat anywhere). That was under "reduce motion", while the app's rule there gave
  // every style change a very short transition; it gives none now (styles.css), and the root
  // and its host take no transitions under any setting (see the CSS).
  let shellTop = null, shellBottom = null;
  function fitShell() {
    if (!scroller || S.dead || S.detached || !host) return;
    const hr = host.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    const top = hr.top - sr.top, bottom = sr.bottom - hr.bottom;
    let moved = false;
    if (shellTop == null || Math.abs(top - shellTop) > 0.5) { shellTop = top; root.style.top = `${-top}px`; moved = true; }
    if (shellBottom == null || Math.abs(bottom - shellBottom) > 0.5) { shellBottom = bottom; root.style.bottom = `${-bottom}px`; moved = true; }
    // How much of the map is behind the head. Only the fit and centre maths care; the canvas
    // deliberately does not.
    S.padTop = Math.max(0, Math.round(shellTop));
    root.style.setProperty("--mp-note-top", `${S.padTop}px`);
    return moved;
  }

  // ── layout / sizing ──
  function measure() {
    if (S.dead || S.detached || !host) return;
    if (bleed) {
      const h = host.clientHeight;
      if (h > 0) root.style.height = `${h}px`;
    }
    fitShell();
    const r = surface.getBoundingClientRect();
    S.w = Math.round(r.width);
    S.h = Math.round(r.height);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    S.dpr = dpr;
    canvas.width = Math.max(1, Math.round(S.w * dpr));
    canvas.height = Math.max(1, Math.round(S.h * dpr));
    g2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    positionChrome();
    if (S.map) { try { S.map.resize(); } catch { /* torn down mid-frame */ } }
  }

  // Cached here rather than read per frame: sheet.offsetHeight forces layout, and the draw
  // loop runs on every camera change. A shut sheet contributes nothing, which is the whole
  // point of being able to shut it — the chrome drops with it and the map is seen clean.
  function barOver() {
    const bar = document.querySelector(".tabbar");
    if (!bar || getComputedStyle(bar).position !== "fixed") return 0;
    const b = bar.getBoundingClientRect(), r = root.getBoundingClientRect();
    if (!b.width || !b.height || b.right <= r.left || b.left >= r.right) return 0;      // beside the map: a rail
    if (b.top < r.top + r.height / 2 || b.top >= r.bottom) return 0;                     // not at its foot, or away
    return Math.round(r.bottom - b.top);
  }

  function positionChrome() {
    S.sheetH = S.sheet === "open" ? (sheet.offsetHeight || 0) : 0;
    // A bar that floats over the page's foot (the pill under 768) is over the map's foot too.
    // Measured, not styled: how far the bar reaches up into the map. With the panel shut the
    // scale and the buttons stand above it; with it open the panel's last row can scroll clear.
    S.under = barOver();
    root.style.setProperty("--mp-under", `${S.under}px`);
    // The scale and the buttons ride 12 px above the panel, but never up under the page's head: on a short screen a
    // place's card is taller than the strip they'd need above it (19 Nov, 667 x 375: the head cut their tops off).
    // There they stop 4 px under the head, over the card's top edge, where its grab bar is.
    const tallest = Math.max(ctrls.offsetHeight || 0, scaleEl ? scaleEl.offsetHeight || 0 : 0);
    const roof = S.h ? Math.max(12, S.h - (S.padTop || 0) - 4 - tallest) : Infinity;
    root.style.setProperty("--mp-chrome", `${Math.min(Math.max(S.sheetH, S.under) + 12, roof)}px`);
    readChrome();
  }

  // Where the map's own furniture stands on the surface: the scale and the buttons. A plate's
  // name and a pin's label are not written under them. Read here and four times a second
  // from draw() (they ride up with the panel), never per frame: a rect is a forced layout.
  // What floats over the map: its scale and its buttons, "Nearby" when the panel is shut, and
  // the screen's own + and tab bar where they stand over it. A plate's name and a pin's name
  // keep off all of them (a name half under a button reads as a fault); a pin stays where its
  // place is.
  function readChrome() {
    const base = surface.getBoundingClientRect();
    const peek = root.querySelector(".mp-peek");
    const fab = document.querySelector("#rt-fixed .fab");
    const rel = (n) => {
      const r = n && n.getBoundingClientRect();
      if (!r || !(r.width > 0 && r.height > 0)) return null;
      const c = { l: r.left - base.left, r: r.right - base.left, t: r.top - base.top, b: r.bottom - base.top };
      return c.r > 0 && c.l < S.w && c.b > 0 && c.t < S.h ? c : null;
    };
    S.chrome = [scaleEl, ctrls, peek, fab, ...document.querySelectorAll(".tabbar, .dock > *")].map(rel).filter(Boolean);
    // The band at the map's foot that the scale, "Nearby" and the + stand in: its top, where a
    // fit's room ends when the panel is shut (insets()). With the panel open the panel is lower
    // than they are, and they ride up with it. The buttons' row on a short screen stands there
    // too; its top is kept apart, since a fit keeps it clear either there or beside (insets()).
    const foot = [scaleEl, peek, fab, ...document.querySelectorAll(".dock > *")].map(rel).filter(Boolean);
    S.footTop = foot.length ? Math.min(...foot.map((c) => c.t)) : S.h;
    const row = inRow() ? rel(btns) : null;
    S.rowTop = row ? row.t : S.h;
    const scale = rel(scaleEl);
    S.scaleR = scale ? scale.r : 0;
    S.scaleBox = scale ? { x: scale.l - 4, y: scale.t - 4, w: scale.r - scale.l + 8, h: scale.b - scale.t + 8 } : null;
    const b = rel(btns);
    S.btnsL = b ? b.l : S.w;
    clearOfAdd(fab);
  }

  // The screen's own + floats over the panel's right end (narrow screens, above the tab bar). Over a place's card it
  // stood on the card's "Place page" (19 Nov, 667 x 375 on its side): the card's buttons end short of it, by the gap
  // between the two buttons. From the card's own right edge, which the buttons' margin doesn't move.
  let actsR = 0;
  function clearOfAdd(fab) {
    const acts = root.dataset.mode === "card" ? root.querySelector(".mp-acts") : null;
    let need = 0;
    const f = fab && fab.getBoundingClientRect();
    if (acts && f && f.width > 0 && getComputedStyle(fab).display !== "none") {
      const a = acts.getBoundingClientRect(), card = acts.parentElement;
      const right = card.getBoundingClientRect().right - (parseFloat(getComputedStyle(card).paddingRight) || 0);
      if (f.top < a.bottom && f.bottom > a.top && f.left < right && f.right > a.left) {
        need = Math.ceil(right - f.left + (parseFloat(getComputedStyle(acts).columnGap) || 8));
      }
    }
    if (need !== actsR) { actsR = need; root.style.setProperty("--mp-acts-r", `${need}px`); }
  }

  // The box a fit is allowed to use: the surface minus the chrome, minus the space a pin
  // occupies around its own coordinate. The top inset is the head floating over us.
  // The bottom: a place's point stands clear of the panel by its name's height (the old room), and
  // clear of the map's own furniture at its foot by FOOT_GAP_PX (15 Nov, map_fit_check: with only
  // the panel counted, a place at a fitted trip's foot landed under the scale, or with the panel
  // shut under "Nearby" or the +). The pin's body stands above its point, so the point clearing
  // their top is enough, and a name that would fall on them keeps off by itself (layoutLabels).
  // With the panel open the scale rides 12 px above it, its height from layout, so a fit made
  // while it is still moving up with the panel counts it the same. With the panel shut: where
  // "Nearby", the scale and the + stand.
  const FOOT_GAP_PX = 4;
  // The right: the column of the three buttons, 44 wide. Not the whole .mp-ctrls: "Nearby" stands in it too when the
  // panel is shut, 104 px wide where the buttons are 44, and a fit lost 60 px down the whole height of the map and sat
  // 30 px left of the middle (15 Nov). "Nearby" is at the map's foot, and footBand() keeps the places above it.
  // On a short screen the buttons lie in a row at the foot, beside the scale, and a fit keeps the places above that row
  // and so the whole width (a band down the right side lost 104 px of it to a strip nothing stood in).
  // Unless above the foot's furniture there is less than a fit's floor: on a phone on its side with the panel open the
  // map shows about 98 px between the head and the panel, a pin stands 40 px above its point, and a fit with no room put
  // the places' middle down among the scale and the buttons. Then they are kept beside the places instead, the scale
  // at the left and the buttons at the right, and the places have the strip's whole height between them. Not a choice
  // by area: with the panel shut the two are near a tie, and a rule by area would flip on a font's or a safe area's change.
  const ROOM_FLOOR_PX = 48;
  const btns = ctrls.querySelector(".mp-btns");
  const inRow = () => getComputedStyle(btns).flexDirection === "row";
  function footBand(row) {
    if (S.sheet === "open") return S.sheetH + 12 + Math.max(scaleEl ? scaleEl.offsetHeight : 0, row ? btns.offsetHeight : 0);
    readChrome();
    return S.h - Math.min(S.footTop ?? S.h, row ? (S.rowTop ?? S.h) : S.h);
  }
  const insets = () => {
    const top = S.padTop + 12 + PIN_UP_PX, row = inRow();
    const clearOfPanel = Math.max(S.sheetH + 16 + PIN_LABEL_PX, (S.under || 0) + 16 + PIN_LABEL_PX);
    const below = Math.max(clearOfPanel, footBand(row) + FOOT_GAP_PX);
    // The buttons from the surface's right edge where they stand, at least 24 + their width: on a phone on its side they
    // stand inside the right safe area, 47 px further in than 24.
    readChrome();
    const buttonsIn = Math.max(24 + btns.offsetWidth, S.w - (S.btnsL ?? S.w));
    if (S.h - top - below >= ROOM_FLOOR_PX) return { top, bottom: below, left: 24 + PIN_SIDE_PX, right: (row ? 24 : buttonsIn) + PIN_SIDE_PX };
    // Beside: the scale at the left and the buttons at the right, 12 px clear of each, more than a group's disc is wider
    // than a pin (21 px a side to 17). Up and down, the strip the map really shows between the head and the panel (or
    // the bar over its foot), which can be smaller than any room a fit would ask for: wantPoint() and fitTo() place the
    // points in that strip itself (19 Nov: at 667 x 375 with the panel open the strip is 82 px; a fit centred in a room
    // of the floor's height put the places' points at y 179, across the panel's top edge at 185).
    return { top, bottom: clearOfPanel, left: Math.max(24, (S.scaleR || 0) + 12) + PIN_SIDE_PX, right: buttonsIn + 12 + PIN_SIDE_PX,
      strip: { top: S.padTop, bottom: S.h - Math.max(S.sheetH || 0, S.under || 0) } };
  };
  // Where a point may stand in a short strip (insets(), "strip"), so what is drawn at it is wholly in view: a pin's body
  // stands PIN_UP_PX above its point, a group's disc DISC_HALF_PX round it. With room for both, the range that keeps
  // either clear; else the range that keeps one place's pin clear (a place's card: the one picked); else the pin's top
  // clear of the head.
  const STRIP_GAP_PX = 2;
  function stripRange(strip, one) {
    const lo = strip.top + PIN_UP_PX + STRIP_GAP_PX;
    const both = strip.bottom - DISC_HALF_PX - STRIP_GAP_PX, pin = strip.bottom - STRIP_GAP_PX;
    if (!one && both >= lo) return { lo, hi: both };
    if (pin >= lo) return { lo, hi: pin };
    return { lo, hi: lo };
  }

  // ══ the camera adapter ═══════════════════════════════════════════════════════════════
  // Everything below the two implementations talks to `view` and nothing else. See the
  // header: flat mounts first and is the whole map with no WebGL2; GL takes over when
  // MapLibre has loaded and brings rotation and pitch with it.

  let view = null;

  // A camera is remembered (for the next visit to the map, and across launches) only once the
  // map has been put somewhere on purpose: on the trip's places, or on a camera the person
  // left. The planet an empty trip opens on is nobody's choice, and remembering it would pin
  // the map there when the trip's first places arrive.
  function camChanged(quiet) {
    S.cam = view.cam();
    if (cameraSet) lastCam = S.cam;
    if (!quiet && cameraSet) saveCam({ ...S.cam, auto: !!(autoCam && sameCam(S.cam, autoCam)), sheetH: S.sheetH });
    paintNeedle();
    schedule();
    if (view.kind === "flat") scheduleRest();
  }

  // ── flat: arithmetic Mercator, north up ──
  function makeFlatView() {
    let anim = 0;
    const api = {
      kind: "flat",
      project(lng, lat) {
        const ws = worldSize(S.cam.zoom);
        let dx = mx(lng, ws) - mx(S.cam.lng, ws);
        // Antimeridian: without this a pin at -179 with the camera at 179 projects a whole
        // world away instead of just off the left edge. One country rarely needs it; a pan does.
        if (dx > ws / 2) dx -= ws; else if (dx < -ws / 2) dx += ws;
        return { x: dx + S.w / 2, y: my(lat, ws) - my(S.cam.lat, ws) + S.h / 2 };
      },
      unproject(sx, sy) {
        const ws = worldSize(S.cam.zoom);
        return {
          lng: unmx(mx(S.cam.lng, ws) + (sx - S.w / 2), ws),
          lat: unmy(clamp(my(S.cam.lat, ws) + (sy - S.h / 2), 0, ws), ws),
        };
      },
      cam: () => S.cam,
      stop() { if (anim) { cancelAnimationFrame(anim); anim = 0; } },
      jumpTo(next, o) {
        api.stop();
        const z = clamp(next.zoom == null ? S.cam.zoom : next.zoom, MIN_ZOOM, MAX_ZOOM);
        const ws = worldSize(z);
        // An offset is "put the target HERE on screen instead of in the middle", which in flat
        // space is a shift of the centre by that many pixels.
        const ox = next.offset ? next.offset[0] : 0;
        const oy = next.offset ? next.offset[1] : 0;
        S.cam = {
          lng: wrapLng(unmx(mx(next.lng == null ? S.cam.lng : next.lng, ws) - ox, ws)),
          lat: unmy(clamp(my(next.lat == null ? S.cam.lat : next.lat, ws) - oy, 0, ws), ws),
          zoom: z, bearing: 0, pitch: 0,
        };
        camChanged(o && o.quiet);
      },
      easeTo(target, msDur) {
        api.stop();
        if (!target) return;
        const dur = reducedMotion() ? 0 : (msDur == null ? 380 : msDur);
        if (dur <= 0) { api.jumpTo(target); return; }
        const from = { ...S.cam };
        const tz = clamp(target.zoom == null ? from.zoom : target.zoom, MIN_ZOOM, MAX_ZOOM);
        const tws = worldSize(tz);
        const ox = target.offset ? target.offset[0] : 0;
        const oy = target.offset ? target.offset[1] : 0;
        // Resolve the offset at the TARGET zoom, then interpolate centres in zoom-0 mercator
        // space so the path is a straight line on the ground rather than a curve that swings
        // north as the zoom changes.
        const tLng = unmx(mx(target.lng == null ? from.lng : target.lng, tws) - ox, tws);
        const tLat = unmy(clamp(my(target.lat == null ? from.lat : target.lat, tws) - oy, 0, tws), tws);
        const fx = mx(from.lng, TILE), fy = my(from.lat, TILE);
        const tx = mx(tLng, TILE), ty = my(tLat, TILE);
        const t0 = performance.now();
        const step = (now) => {
          if (S.dead) return;
          // Clamped at BOTH ends. A rAF callback is handed the timestamp of the frame it
          // belongs to, which is not guaranteed to be later than the performance.now()
          // captured just before it was scheduled — and a negative k is not a slow animation,
          // it is a cubic ease outside its domain, which throws the camera off the planet.
          const k = clamp((now - t0) / dur, 0, 1);
          const e = 1 - Math.pow(1 - k, 3);
          S.cam = {
            lng: unmx(fx + (tx - fx) * e, TILE),
            lat: unmy(fy + (ty - fy) * e, TILE),
            zoom: from.zoom + (tz - from.zoom) * e,
            bearing: 0, pitch: 0,
          };
          camChanged();
          anim = k < 1 ? requestAnimationFrame(step) : 0;
        };
        anim = requestAnimationFrame(step);
      },
      resize() { /* nothing cached */ },
    };
    return api;
  }

  // ── gl: MapLibre owns the gestures ──
  function makeGlView(map) {
    const opt = (t) => ({
      center: [t.lng == null ? S.cam.lng : t.lng, t.lat == null ? S.cam.lat : t.lat],
      zoom: t.zoom == null ? S.cam.zoom : t.zoom,
      ...(t.bearing == null ? {} : { bearing: t.bearing }),
      ...(t.pitch == null ? {} : { pitch: t.pitch }),
      ...(t.offset ? { offset: t.offset } : {}),
    });
    return {
      kind: "gl",
      project(lng, lat) {
        // The copy of this meridian nearest the camera: without it a pin at -179 with the
        // camera at 179 lands a whole world away (the flat view does the same in pixels).
        const p = map.project([nearLng(lng, map.getCenter().lng), lat]);
        return { x: p.x, y: p.y };
      },
      unproject(x, y) {
        const l = map.unproject([x, y]);
        return { lng: l.lng, lat: l.lat };
      },
      cam() {
        const c = map.getCenter();
        return {
          lng: wrapLng(c.lng), lat: c.lat, zoom: map.getZoom(),
          bearing: map.getBearing(), pitch: map.getPitch(),
        };
      },
      stop() { try { map.stop(); } catch { /* removed */ } },
      // MapLibre's jumpTo takes no offset (only its eased moves do), and a fit is a centre
      // PLUS an offset: dropped, the fit sat in the middle of the whole surface, with its
      // lowest pin under the panel. An ease of no length is the same jump, offset included.
      jumpTo(next) {
        try {
          if (next && next.offset) map.easeTo({ ...opt(next), duration: 0, essential: true });
          else map.jumpTo(opt(next));
        } catch { /* removed between frames */ }
      },
      easeTo(target, msDur) {
        const dur = reducedMotion() ? 0 : (msDur == null ? 380 : msDur);
        try { map.easeTo({ ...opt(target), duration: dur }); } catch { /* removed */ }
      },
      resize() { try { map.resize(); } catch { /* removed */ } },
    };
  }

  view = makeFlatView();

  // A debug handle, like __wgpMap further down: not used by the app. It is how a harness reads
  // the camera and the projection of whichever engine is live, and moves the camera, rather
  // than assuming them because nothing threw.
  try {
    window.__wgpMapView = {
      engine: () => view.kind,
      cam: () => ({ ...S.cam }),
      tiles: () => S.tiles,
      drawn: () => S.tiles && S.drawn,          // the archive's streets have drawn once (the "arriving" card's end)
      project: (lng, lat) => view.project(lng, lat),
      unproject: (x, y) => view.unproject(x, y),
      jumpTo: (c) => view.jumpTo(c),
      regions: () => AR.regions.map((r) => ({ id: r.id, name: r.name, bounds: r.bounds })),
      regionNames: () => S.names.map((n) => ({ id: n.id, name: n.name, x: n.x, y: n.y, w: n.w, h: n.h, clear: n.clear })),
      chrome: () => S.chrome.map((c) => ({ ...c })),
      insets: () => ({ ...insets() }),       // the room a fit uses now, in px in from each side of the surface
      mapVersion: () => (S.tiles ? sharedVersion : null),
    };
  } catch { /* no window */ }

  // ── camera helpers that work for BOTH engines ────────────────────────────────────────
  // Screen-space intent, expressed as a centre plus an offset, because that is the one form
  // both engines take: "put this point HERE on the screen" rather than "put it in the middle".

  // In a short strip (insets(), "strip") the point goes in the middle of where it may stand there, not of a room the
  // strip hasn't got.
  const wantPoint = (box) => {
    const x = box.left + Math.max(ROOM_FLOOR_PX, S.w - box.left - box.right) / 2;
    if (!box.strip) return { x, y: box.top + Math.max(ROOM_FLOOR_PX, S.h - box.top - box.bottom) / 2 };
    const { lo, hi } = stripRange(box.strip, box.one);
    return { x, y: (lo + hi) / 2 };
  };

  // The camera that puts (lng, lat) at the middle of the space the chrome leaves free rather
  // than at the middle of the screen. Everything that "centres" goes through this: an open
  // sheet covers the bottom of the surface, and a plain centre puts the one pin the user just
  // asked about directly underneath it.
  function cameraFor(lng, lat, zoom, box) {
    const w = wantPoint(box);
    return {
      lng, lat, zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM),
      offset: [w.x - S.w / 2, w.y - S.h / 2],
    };
  }

  // Fit, in the CAMERA's own frame. The points are taken into zoom-0 world pixels, rotated by
  // the current bearing, and bounded there — so a fit is still a fit when the map is turned.
  // (Pitch is ignored: a pitched fit is approximate by nature, and the answer is never wrong
  // enough to hide a pin.)
  function fitTo(pts, box) {
    if (!pts || !pts.length || !S.w || !S.h) return null;
    const th = -(S.cam.bearing || 0) * D2R;
    const cos = Math.cos(th), sin = Math.sin(th);
    // Points either side of the 180° line are a degree apart, not 359: every meridian is
    // written nearest the middle of the box that holds them all.
    const around = boxAround(pts.map((p) => [+p.lng, +p.lat]));
    const ref = around ? around.west + around.width / 2 : 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      const wx = mx(nearLng(+p.lng, ref), TILE), wy = my(+p.lat, TILE);
      const rx = wx * cos - wy * sin, ry = wx * sin + wy * cos;
      if (rx < x0) x0 = rx;
      if (rx > x1) x1 = rx;
      if (ry < y0) y0 = ry;
      if (ry > y1) y1 = ry;
    }
    const availW = Math.max(ROOM_FLOOR_PX, S.w - box.left - box.right);
    const range = box.strip ? stripRange(box.strip, box.one) : null;
    const availH = range ? Math.max(1, range.hi - range.lo) : Math.max(ROOM_FLOOR_PX, S.h - box.top - box.bottom);
    const spanX = x1 - x0, spanY = y1 - y0;
    const z = clamp(
      (spanX < 1e-9 && spanY < 1e-9)
        ? FOCUS_ZOOM
        : Math.min(Math.log2(availW / Math.max(spanX, 1e-9)),
                   Math.log2(availH / Math.max(spanY, 1e-9))),
      MIN_ZOOM, MAX_FIT_ZOOM);
    // Rotate the centre of the bounding box back out of the bearing frame.
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const wx = cx * cos + cy * sin, wy = -cx * sin + cy * cos;
    return cameraFor(wrapLng(unmx(wx, TILE)), unmy(clamp(wy, 0, TILE), TILE), z, box);
  }

  const easeTo = (t, msDur) => { if (t) view.easeTo(t, msDur); };

  // ── the drawn ground ──────────────────────────────────────────────────────────────────
  // Painted only while there are no tiles. It is not a placeholder for a map; on a phone that
  // has never reached R2 — which is four of the eleven days — it IS the map. Everything here
  // goes through view.project(), so it is correct under rotation and pitch as well as flat.

  function niceMetres(target) {
    for (const m of NICE_M) if (m >= target) return m;
    return NICE_M[NICE_M.length - 1];
  }

  // The marks on the map: each a disc of several places or one place's pin (buildGroups()).
  // Declared here because the ground below reads them, to write a plate's name clear of them.
  let groups = [];

  // The trip's regions that have bounds, drawn as projected quads. Inside one of these plates
  // is ground the trip covers; outside is not. Drawing them is the difference between "the map
  // is broken" and "you are 400 km from anywhere this trip goes".
  function paintPlates(g) {
    const names = [];
    g.save();
    for (const r of AR.bounded) {
      const b = r.bounds, wide = widthOf(b);
      // Both edges written nearest the camera, west of east, so a box across the 180° line is
      // one plate rather than a band round the planet.
      const west = nearLng(b.west + wide / 2, S.cam.lng) - wide / 2, east = west + wide;
      const q = [
        view.project(west, b.north), view.project(east, b.north),
        view.project(east, b.south), view.project(west, b.south),
      ];
      if (!q.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
      const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      if (maxX < -40 || minX > S.w + 40 || maxY < -40 || minY > S.h + 40) continue;
      g.beginPath();
      g.moveTo(q[0].x, q[0].y);
      for (let i = 1; i < 4; i++) g.lineTo(q[i].x, q[i].y);
      g.closePath();
      g.fillStyle = palette.plate;
      g.fill();
      g.strokeStyle = palette.lineStrong;
      g.lineWidth = 1;
      g.setLineDash([5, 4]);
      g.stroke();
      g.setLineDash([]);

      // Name the plate only while it still reads as an OBJECT. Zoomed into one district the city's
      // box IS the screen, and a label with its name clamped to the corner would be a permanent
      // sticker saying nothing the itinerary has not already said.
      const onW = Math.min(maxX, S.w) - Math.max(minX, 0);
      const onH = Math.min(maxY, S.h) - Math.max(minY, 0);
      if (onW * onH > S.w * S.h * 0.62) continue;
      g.font = `700 12px ${palette.font}`;
      g.fillStyle = palette.ink3;
      const words = r.name.toUpperCase();
      const at = nameSpot(r, words, g.measureText(words).width, q, { minX, maxX, minY, maxY }, names);
      g.fillText(words, at.x, at.y);
      names.push({ id: r.id, name: r.name, x: at.x, y: at.y - NAME_UP_PX, w: at.w, h: NAME_UP_PX + NAME_DOWN_PX, clear: at.clear,
        plate: { minX, maxX, minY, maxY } });
    }
    g.restore();
    S.names = names;
  }

  // WHERE A PLATE'S NAME GOES. It was always the plate's top left corner, which is as likely a
  // spot for a disc as any other: the name of the only region of a trip sat under two of its
  // own discs. It is written once, at the first of these spots that no disc or pin stands on
  // and that is on the screen clear of the head and the panel: inside the top left corner;
  // just above it, outside; inside and above the top right; inside and below the bottom left;
  // inside and below the bottom right. The spot it had last time is tried first, so the name
  // doesn't hop about while the camera zooms. With every spot taken it stays where it always
  // was. A plate that is turned or tilted keeps the corner: the other spots are worked out
  // from its box, and a turned plate doesn't fill its box.
  const NAME_UP_PX = 11, NAME_DOWN_PX = 4;      // 12 px capitals: what the words take above and below their line
  const NAME_PAD = 6;                           // breathing room between plate label and discs/pins
  const DISC_CLEAR = DISC_HALF_PX + 4;          // cluster disc radius + halo clearance
  const nameSpots = new Map();                  // a region's id → the spot its name had last
  function nameSpot(r, words, w, q, b, taken) {
    const first = { x: clamp(q[0].x + 8, 8, Math.max(8, S.w - 110)), y: clamp(q[0].y + 17, 20, Math.max(20, S.h - 8)), w, clear: false };
    if (Math.abs(S.cam.bearing || 0) > 1 || Math.abs(S.cam.pitch || 0) > 1) return first;
    const midX = Math.round((b.minX + b.maxX - w) / 2);
    const spots = [
      [b.minX + 8, b.minY + 17],
      [b.minX + 2, b.minY - 8],
      [b.minX + 2, b.minY - 24],
      [midX, b.minY - 8],
      [midX, b.minY - 24],
      [b.maxX - 8 - w, b.minY + 17],
      [b.maxX - 2 - w, b.minY - 8],
      [b.maxX - 2 - w, b.minY - 24],
      [b.minX + 8, b.maxY - 8],
      [b.minX + 2, b.maxY + 16],
      [b.maxX - 8 - w, b.maxY - 8],
      [b.maxX - 2 - w, b.maxY + 16],
    ];
    const marks = [];
    for (const m of groups) {
      const s = view.project(m.lng, m.lat);
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      marks.push(m.items.length > 1
        ? { l: s.x - DISC_CLEAR, r: s.x + DISC_CLEAR, t: s.y - DISC_CLEAR, b: s.y + DISC_CLEAR }
        : { l: s.x - PIN_SIDE_PX - 2, r: s.x + PIN_SIDE_PX + 2, t: s.y - PIN_UP_PX - 3, b: s.y + 3 });
    }
    // Another region's plate, a name already written this frame, and the map's own scale and
    // buttons are not free ground either.
    const others = S.chrome.slice();
    for (const n of taken) {
      others.push({ l: n.x, r: n.x + n.w, t: n.y, b: n.y + n.h });
      others.push({ l: n.plate.minX, r: n.plate.maxX, t: n.plate.minY, b: n.plate.maxY });
    }
    const top = (S.padTop || 0) + 4, bottom = S.h - (S.sheetH || 0) - 4;
    const canPlace = (x, y) => {
      const B = { l: x - NAME_PAD, r: x + w + NAME_PAD, t: y - NAME_UP_PX - NAME_PAD, b: y + NAME_DOWN_PX + NAME_PAD };
      if (B.l < 6 || B.r > S.w - 6 || B.t < top || B.b > bottom) return false;
      const hits = (o) => B.l < o.r && o.l < B.r && B.t < o.b && o.t < B.b;
      return !marks.some(hits) && !others.some(hits);
    };
    const last = nameSpots.get(r.id);
    const order = last != null && last < spots.length ? spots.map((_, i) => i).sort((a, b2) => (a === last ? -1 : b2 === last ? 1 : a - b2)) : spots.map((_, i) => i);
    for (const i of order) {
      if (!canPlace(spots[i][0], spots[i][1])) continue;
      nameSpots.set(r.id, i);
      return { x: spots[i][0], y: spots[i][1], w, clear: true };
    }
    const xStart = Math.max(8, Math.round(b.minX)), xEnd = Math.min(S.w - 8 - Math.ceil(w), Math.round(b.maxX - w));
    for (const y of [b.minY - 8, b.minY - 24, b.minY + 17, b.maxY + 16]) {
      for (let x = xStart; x <= xEnd; x += 12) {
        if (!canPlace(x, y)) continue;
        nameSpots.delete(r.id);
        return { x, y, w, clear: true };
      }
    }
    nameSpots.delete(r.id);
    return first;
  }

  // Two weights, and the weights are the two line tokens used for exactly what they are for.
  // MINOR is --line: a decorative hairline, texture rather than information. MAJOR is
  // --line-strong at FULL STRENGTH — measured 2.96:1 light and 3.18:1 dark against
  // --surface-2, the functional non-text threshold that token exists to meet. The old ground
  // had only the minor weight, which is precisely why it read as a void. Every fifth line
  // being visible is what makes a pan obviously a pan.
  //
  // Drawn as PROJECTED SEGMENTS rather than screen-axis rules, so it turns with the map.
  function paintGraticule(g, mpp) {
    // The visible ground, from the four corners. Under pitch the top corners can unproject to
    // the horizon or past it, so the span is sanity-checked before anything is drawn.
    const c = [view.unproject(0, 0), view.unproject(S.w, 0),
               view.unproject(S.w, S.h), view.unproject(0, S.h)];
    if (!c.every((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat))) return;
    let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
    for (const p of c) {
      w = Math.min(w, p.lng); e = Math.max(e, p.lng);
      s = Math.min(s, p.lat); n = Math.max(n, p.lat);
    }
    if (!(e > w) || !(n > s)) return;
    const midLat = (n + s) / 2;
    // Squares of so many meters, until the view is a good part of the planet: there a square
    // of meters is no square at all (it is five times wider at 78° than at the equator), and
    // the ground is the globe's own lines instead, every 10°, each 30° the stronger one.
    const globe = e - w > 60 || n - s > 60;
    if (globe && (e - w > 400 || n - s > 180)) return;
    const stepM = niceMetres(mpp * 34);
    const dLat = globe ? 10 : stepM / 110574;
    const dLng = globe ? 10 : stepM / (111320 * Math.max(0.2, Math.cos(midLat * D2R)));
    const majorEvery = globe ? 3 : GRID_MAJOR;
    if (globe) { s = Math.max(s, -80); n = Math.min(n, 80); }
    if (!(dLat > 0) || !(dLng > 0)) return;
    // The visible box can be much taller than the screen under pitch; cap the work.
    if ((e - w) / dLng > 200 || (n - s) / dLat > 200) return;

    const padLng = dLng, padLat = dLat;
    g.save();
    g.lineWidth = 1;
    for (const major of [false, true]) {
      g.strokeStyle = major ? palette.lineStrong : palette.line;
      g.beginPath();
      for (let i = Math.ceil(w / dLng); i * dLng <= e; i++) {
        if (major !== (((i % majorEvery) + majorEvery) % majorEvery === 0)) continue;
        const ln = i * dLng;
        for (let k = 0; k <= 4; k++) {
          const la = s - padLat + ((n - s + 2 * padLat) * k) / 4;
          const p = view.project(ln, la);
          if (k === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y);
        }
      }
      for (let j = Math.ceil(s / dLat); j * dLat <= n; j++) {
        if (major !== (((j % majorEvery) + majorEvery) % majorEvery === 0)) continue;
        const la = j * dLat;
        for (let k = 0; k <= 4; k++) {
          const ln = w - padLng + ((e - w + 2 * padLng) * k) / 4;
          const p = view.project(ln, la);
          if (k === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y);
        }
      }
      g.stroke();
    }
    g.restore();
  }

  function paintCanvas(mpp) {
    const g = g2d;
    g.clearRect(0, 0, S.w, S.h);
    if (!S.w || !S.h) return;

    if (!S.tiles) {
      // Opaque base first: this canvas sits above the GL host, which is either empty or
      // painting nothing but a background, and the root's --ground would otherwise show
      // through wherever the plates do not reach.
      g.fillStyle = palette.ground;
      g.fillRect(0, 0, S.w, S.h);
      paintPlates(g);
      paintGraticule(g, mpp);
    } else if (S.names.length) {
      S.names = [];          // the map's own tiles name the ground; no plate is drawn over them
    }

    // Bearing line: me -> selected. Drawn even when the target is off screen, because "which
    // way is it" is the question, and a line running off the edge answers it.
    const sel = S.selected && placeById(S.selected);
    if (sel && S.me) {
      const a = view.project(S.me.lng, S.me.lat);
      const b = view.project(+sel.lng, +sel.lat);
      g.save();
      g.strokeStyle = palette.accent;
      g.globalAlpha = 0.75;
      g.lineWidth = 2;
      g.lineCap = "round";
      g.setLineDash([7, 6]);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      g.restore();
    }
  }

  // ── the scale ──────────────────────────────────────────────────────────────────────────
  // Measured the way MapLibre's own control measures: two points on the ground under a fixed
  // run of pixels, so it is right under pitch and rotation too. The ELEMENT never changes
  // size — 84px of rule, always — and the NUMBER over it is what moves.
  let scaleLast = "";
  function metresPerPixel() {
    const y = Math.round(S.h / 2);
    const a = view.unproject(Math.round(S.w / 2) - SCALE_RULE_PX / 2, y);
    const b = view.unproject(Math.round(S.w / 2) + SCALE_RULE_PX / 2, y);
    const d = haversine(a, b) / SCALE_RULE_PX;
    return Number.isFinite(d) && d > 0 ? d : mppAt(S.cam.lat, S.cam.zoom);
  }
  // Two significant figures, so the value reads as a measurement and not as a readout.
  function roundNice(m) {
    const e = Math.pow(10, Math.floor(Math.log10(m)) - 1);
    return Math.round(m / e) * e;
  }
  function paintScale(mpp) {
    const metres = mpp * SCALE_RULE_PX;
    let label;
    if (distanceUnits() === "imperial") {
      // The account reads miles (util.js): feet under 1,000, then miles, rounded the same way.
      const feet = metres * 3.28084;
      if (feet < 1000) label = `${feet >= 10 ? Math.round(roundNice(feet)) : roundNice(feet).toFixed(1).replace(/\.0$/, "")} ft`;
      else { const mi = roundNice(metres / 1609.344); label = `${mi >= 10 ? Math.round(mi) : String(+mi.toFixed(2))} mi`; }
    } else {
      const span = roundNice(metres);
      label = span >= 1000
        ? `${(span / 1000).toFixed(span >= 10000 ? 0 : 1).replace(/\.0$/, "")} km`
        : `${span >= 10 ? Math.round(span) : span.toFixed(1).replace(/\.0$/, "")} m`;
    }
    if (label === scaleLast) return;
    scaleLast = label;
    scaleText.textContent = label;
    scaleEl.setAttribute("aria-label", `Scale: ${label}`);
  }

  function paintNeedle() {
    const b = S.cam.bearing || 0;
    needle.style.transform = `rotate(${(-b).toFixed(1)}deg)`;
    const north = Math.abs(b) < 0.5 && (S.cam.pitch || 0) < 0.5;
    northBtn.dataset.north = north ? "1" : "0";
    northBtn.setAttribute("aria-label", north ? "Facing north" : "Face north");
  }

  // ── markers ───────────────────────────────────────────────────────────────────────────
  // Marker bodies created while S.drop is set, in paint order, for the drop-in stagger.
  // Bodies, not the outer anchors: layoutMarkers rewrites the anchor's transform per frame,
  // and a WAAPI animation on the same property would mask that positioning for its duration.
  const spawned = [];
  const textWidths = new Map();
  function textWidth(s) {
    let w = textWidths.get(s);
    if (w == null) {
      g2d.save();
      g2d.font = `600 12px ${palette.font}`;
      w = Math.min(136, g2d.measureText(s).width);
      g2d.restore();
      textWidths.set(s, w);
    }
    return w;
  }
  const overlaps = (a, b) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  // Clustering, as a HASH GRID. Earlier clustering seeded groups by scanning every existing group
  // for every point and then ran a merge pass that restarted its whole double loop on each
  // merge — O(g^3) at 312 places, on every pointermove, which is most of what "horribly
  // unresponsive" was. This is one pass: each point looks only in its own cell and the eight
  // around it, so the work is linear in the number of pins and the constant is nine.
  let clusterAt = null;    // the camera the current grouping was derived at

  // The grouping radius is a function of the zoom, not a constant: see the note on
  // CLUSTER_PX. Everything that asks "would these still be one disc?" asks at a stated zoom,
  // because openCluster() has to answer that about a camera it has not moved to yet.
  function clusterPxAt(z) {
    if (z <= CLUSTER_TIGHT_ZOOM) return CLUSTER_PX;
    const k = Math.min(1, (z - CLUSTER_TIGHT_ZOOM) / Math.max(0.001, MAX_ZOOM - CLUSTER_TIGHT_ZOOM));
    return CLUSTER_PX + (CLUSTER_TIGHT_PX - CLUSTER_PX) * k;
  }
  const clusterPx = () => clusterPxAt(S.cam.zoom);

  function buildGroups(pts, radius) {
    const grid = new Map();
    const out = [];
    const put = (x, y, i) => {
      const k = `${Math.floor(x / radius)},${Math.floor(y / radius)}`;
      let a = grid.get(k);
      if (!a) { a = new Set(); grid.set(k, a); }
      a.add(i);
    };
    for (const it of pts) {
      // The selected pin is never absorbed: the card is describing it, so it has to be visible.
      if (it.p.id === S.selected) {
        out.push({ items: [it], cx: it.x, cy: it.y, solo: true });
        continue;
      }
      const gx = Math.floor(it.x / radius), gy = Math.floor(it.y / radius);
      let best = -1, bestD = radius;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const a = grid.get(`${gx + dx},${gy + dy}`);
          if (!a) continue;
          for (const gi of a) {
            const g = out[gi];
            if (g.solo) continue;
            const d = Math.hypot(g.cx - it.x, g.cy - it.y);
            if (d < bestD) { bestD = d; best = gi; }
          }
        }
      }
      if (best >= 0) {
        const g = out[best];
        g.items.push(it);
        g.cx += (it.x - g.cx) / g.items.length;
        g.cy += (it.y - g.cy) / g.items.length;
        put(g.cx, g.cy, best);
      } else {
        out.push({ items: [it], cx: it.x, cy: it.y });
        put(it.x, it.y, out.length - 1);
      }
    }
    settle(out);
    // Each group remembers WHERE IT IS on the ground, so a pan can re-project it without
    // re-deriving who belongs to it.
    for (const g of out) {
      const ll = view.unproject(g.cx, g.cy);
      g.lng = ll.lng; g.lat = ll.lat;
    }
    return out;
  }

  // NO DISC STANDS ON A DISC OR ON A PIN. The radius above answers "are these the same spot";
  // it cannot answer "do these two marks fit side by side", because a disc is 42 px across
  // and a radius under that leaves two discs 31 px apart, one on top of the other with the
  // count of the lower one cut in half. On a trip of three hundred places the overview was a
  // heap of them. So after the grouping, any disc whose box reaches another disc's, or a
  // pin's, takes it in, and the pass repeats until nothing touches: every merge removes a
  // mark, so it ends. Two PINS are left to the radius alone: a pin points at its place with
  // its tip, and a pair a building apart stays two named pins (see CLUSTER_PX).
  // The selected pin is never taken in (the card is describing it), and neither is an open
  // fan, which is not in this list at all: both are drawn above whatever is under them.
  // `list` holds { cx, cy } with `items` (the map's groups) or `n` (groupCountAt's); it is
  // changed in place.
  function settle(list) {
    const size = (g) => (g.items ? g.items.length : g.n);
    const box = (g) => (size(g) > 1
      ? { l: g.cx - DISC_HALF_PX, r: g.cx + DISC_HALF_PX, t: g.cy - DISC_HALF_PX, b: g.cy + DISC_HALF_PX }
      : { l: g.cx - PIN_SIDE_PX, r: g.cx + PIN_SIDE_PX, t: g.cy - PIN_UP_PX - 1, b: g.cy + 1 });
    const reach = DISC_HALF_PX * 2 + MARK_GAP_PX;      // no two marks further apart than this in x can touch
    for (let again = true; again;) {
      again = false;
      list.sort((a, b) => a.cx - b.cx);
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!a || a.solo) continue;
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          if (!b) continue;
          if (b.cx - a.cx > reach) break;
          if (b.solo || (size(a) < 2 && size(b) < 2)) continue;
          const A = box(a), B = box(b);
          if (A.l >= B.r + MARK_GAP_PX || B.l >= A.r + MARK_GAP_PX || A.t >= B.b + MARK_GAP_PX || B.t >= A.b + MARK_GAP_PX) continue;
          const na = size(a), nb = size(b), n = na + nb;
          a.cx = (a.cx * na + b.cx * nb) / n;
          a.cy = (a.cy * na + b.cy * nb) / n;
          if (a.items) a.items.push(...b.items); else a.n = n;
          list[j] = null;
          again = true;
        }
      }
      if (again) { let k = 0; for (const g of list) if (g) list[k++] = g; list.length = k; }
    }
    return list;
  }

  // ── the fan ───────────────────────────────────────────────────────────────────────────
  // One fan at a time, held as: the coordinate the members share, the member ids in a fixed
  // order, and the leg offsets. Members are pulled OUT of the clustering pass entirely while
  // the fan is open, so they cannot re-absorb into the disc they just came out of.
  let spider = null;   // { ids: string[], set: Set, lng, lat, zoom, legs: [{dx,dy}] }

  // Where the members sit relative to the coordinate. Up to SPIDER_RING_MAX they take one
  // ring, which is the shape that says "these are siblings"; beyond that the ring would put
  // pins closer together than a pin is wide, so it unwinds into a spiral whose arc step is
  // never less than one pin body.
  function spiderLegs(n) {
    const legs = [];
    if (n <= SPIDER_RING_MAX) {
      const r = SPIDER_MIN_R + n * SPIDER_R_PER;
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        legs.push({ dx: Math.cos(a) * r, dy: Math.sin(a) * r });
      }
      return legs;
    }
    let ang = -Math.PI / 2, rad = SPIDER_MIN_R;
    for (let i = 0; i < n; i++) {
      legs.push({ dx: Math.cos(ang) * rad, dy: Math.sin(ang) * rad });
      ang += Math.max(0.42, 40 / rad);
      rad += 9;
    }
    return legs;
  }

  // WOULD ZOOMING HELP? Run the same grouping rule buildGroups() runs, at a zoom the camera
  // has not moved to yet, and count the groups it would produce. More than one means the zoom
  // makes real progress and is the better answer; exactly one means no reachable zoom will
  // ever separate these, and the fan is the only honest way to open them.
  //
  // The exhaustive nearest-group search here is what the hash grid in buildGroups() is an
  // acceleration OF — over a handful of cluster members the two agree exactly, and the grid
  // would only cost a Map allocation per question. Bearing is not a parameter: a rotation is
  // rigid, so it cannot change a distance.
  function groupCountAt(pts, z) {
    const r = clusterPxAt(z);
    const ws = worldSize(z);
    const out = [];
    for (const p of pts) {
      const x = mx(+p.lng, ws), y = my(+p.lat, ws);
      let best = -1, bestD = r;
      for (let i = 0; i < out.length; i++) {
        const d = Math.hypot(out[i].cx - x, out[i].cy - y);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) {
        const g = out[best];
        g.n += 1;
        g.cx += (x - g.cx) / g.n;
        g.cy += (y - g.cy) / g.n;
      } else {
        out.push({ cx: x, cy: y, n: 1 });
      }
    }
    // …and the same second pass: two groups the radius parts are still one disc on the screen
    // if the one would stand on the other, and a camera sent there would have split nothing.
    return settle(out).length;
  }

  function openSpider(pts, lng, lat) {
    const ordered = pts.slice().sort((a, b) =>
      String(a.name).localeCompare(String(b.name), "en"));
    spider = {
      ids: ordered.map((p) => p.id),
      set: new Set(ordered.map((p) => p.id)),
      lng, lat, zoom: S.cam.zoom,
      legs: spiderLegs(ordered.length),
    };
    clusterAt = null;
    schedule();
  }
  function closeSpider() {
    if (!spider) return false;
    spider = null;
    legsEl.hidden = true;
    hubEl.hidden = true;
    clusterAt = null;
    schedule();
    return true;
  }
  hubEl.addEventListener("click", (e) => { e.stopPropagation(); closeSpider(); });

  // Membership can only change when the zoom, the rotation or a real amount of pan has
  // changed. A pure drag re-projects and writes one transform per marker — no clustering, no
  // DOM churn, nothing created or destroyed under a moving finger.
  function needsRecluster() {
    if (!clusterAt || S.drop) return true;
    const c = S.cam;
    if (Math.abs(c.zoom - clusterAt.zoom) > 0.001) return true;
    if (Math.abs((c.bearing || 0) - clusterAt.bearing) > 0.5) return true;
    if (Math.abs((c.pitch || 0) - clusterAt.pitch) > 0.5) return true;
    const p = view.project(clusterAt.lng, clusterAt.lat);
    return Math.hypot(p.x - S.w / 2, p.y - S.h / 2) > RECLUSTER_PAN_PX;
  }

  // WHICH DISC WEARS ITS REGION'S NAME. At the overview zooms a disc can stand for a region.
  // That holds only while the region IS that one disc: a dozen discs in one region would each
  // wear the same name, heaped on each other, hiding the counts and saying nothing. So a disc
  // wears the name when every place in it is in one region AND no other disc on screen holds
  // a place of that region. Otherwise the region's plate, which carries the name once, names it.
  function nameGroups(list) {
    const discsOf = new Map();          // a region's name → how many discs hold a place of it
    for (const g of list) {
      g.region = "";
      if (g.items.length < 2) continue;
      g.regions = new Set(g.items.map((i) => (AR.regionOf(i.p) || {}).name).filter(Boolean));
      for (const n of g.regions) discsOf.set(n, (discsOf.get(n) || 0) + 1);
    }
    if (S.cam.zoom > REGION_LABEL_MAX_ZOOM) return;
    for (const g of list) {
      if (g.items.length < 2 || g.regions.size !== 1) continue;
      const [n] = g.regions;
      if (discsOf.get(n) === 1) g.region = n;
    }
  }

  function layoutMarkers() {
    // A fan is pinned to one zoom. Zooming is the user saying "resolve this the other way", so
    // the fan folds and the ordinary clustering answers instead.
    if (spider && Math.abs(S.cam.zoom - spider.zoom) > SPIDER_DROP_DZ) closeSpider();

    if (needsRecluster()) {
      const pts = [];
      for (const p of visible()) {
        if (spider && spider.set.has(p.id)) continue;   // fanned out: never re-absorbed
        const s = view.project(+p.lng, +p.lat);
        if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
        if (s.x < -CULL_PX || s.x > S.w + CULL_PX || s.y < -CULL_PX || s.y > S.h + CULL_PX) continue;
        pts.push({ p, x: s.x, y: s.y });
      }
      groups = buildGroups(pts, clusterPx());
      nameGroups(groups);
      clusterAt = {
        zoom: S.cam.zoom, bearing: S.cam.bearing || 0, pitch: S.cam.pitch || 0,
        lng: S.cam.lng, lat: S.cam.lat,
      };
    } else {
      for (const g of groups) {
        const s = view.project(g.lng, g.lat);
        g.cx = s.x; g.cy = s.y;
      }
    }

    // The fan's members are laid out from the shared coordinate every frame, exactly like any
    // other marker — the leg offsets are screen-space constants, so the whole fan rides the
    // camera as one rigid thing and stays welded to the spot it came out of.
    const fan = paintFan();
    const all = fan.length ? groups.concat(fan) : groups;

    // Bodies reserve their space before any label is placed, so a label never lands on a pin
    // or on a cluster's own name. A FAN's labels play by a looser rule — see paintPin() — so
    // its own bodies and the labels already placed are kept as a separate, smaller list.
    const boxes = [];
    const fanBoxes = [];
    const placed = [];
    for (const g of all) {
      if (g.items.length > 1) {
        boxes.push({ x: g.cx - 22, y: g.cy - 22, w: 44, h: 44 });
        if (g.region) boxes.push({ x: g.cx - 42, y: g.cy + 22, w: 84, h: 18 });
      } else {
        const b = { x: g.cx - PIN_SIDE_PX, y: g.cy - PIN_UP_PX, w: PIN_SIDE_PX * 2, h: PIN_UP_PX + 1 };
        boxes.push(b);
        if (g.fan) fanBoxes.push(b);
      }
    }
    // A plate's name is on the ground under these labels: a pin's name doesn't go over it.
    // Nor under what floats over the map (readChrome: its scale and buttons, "Nearby", the + and
    // the tab bar), which are above them.
    for (const n of S.names) boxes.push({ x: n.x, y: n.y, w: n.w, h: n.h });
    for (const c of S.chrome) boxes.push({ x: c.l, y: c.t, w: c.r - c.l, h: c.b - c.t });

    // Selected first, then the fan — the user tapped it to read the names, so those labels
    // outrank everything that was already on screen — then anchors, then a stable name order.
    // The label that survives a collision is the one that matters most, and it does not
    // flicker while panning.
    const order = all.slice().sort((a, b) => {
      const rank = (g) => (g.items[0].p.id === S.selected ? 0 : g.fan ? 1 : (g.items[0].p.is_anchor ? 2 : 3));
      return rank(a) - rank(b) ||
        String(a.items[0].p.name).localeCompare(String(b.items[0].p.name), "en");
    });

    const seen = new Set();
    for (const g of order) {
      if (g.items.length > 1) { seen.add(paintCluster(g)); continue; }
      seen.add(paintPin(g, boxes, placed, fanBoxes));
    }
    for (const [key, node] of S.markers) {
      if (seen.has(key)) continue;
      node.remove();
      S.markers.delete(key);
    }

    // Drop-in stagger, on a filter change only. Opacity + translate on the marker
    // BODY (the anchor keeps its per-frame position transform untouched); backwards fill so a
    // delayed marker is invisible until its turn rather than popping in and then animating.
    // The delay is capped: the stagger is a rhythm, not a queue.
    if (S.drop) {
      S.drop = false;
      if (!reducedMotion() && spawned.length) {
        const dur = tokMs("--dur", 220);
        const easing = easeOutTok();
        spawned.forEach((n, i) => n.animate(
          [{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "none" }],
          { duration: dur, easing, delay: Math.min(i * 24, 240), fill: "backwards" }));
      }
    }
    spawned.length = 0;      // cleared every pass — pans and zooms create markers too
  }

  // The fan, projected. Returns pseudo-groups shaped exactly like the clustering pass's, so
  // everything downstream — label reservation, ordering, paintPin — treats a fanned pin as an
  // ordinary one. Also draws the leader lines and the hub, both in the same screen frame.
  function paintFan() {
    if (!spider) return [];
    // Filtered through matches(): a chip row that hides half the fan must hide it here too,
    // and a fan down to one member is not a fan.
    const members = spider.ids.map((id) => placeById(id)).filter((p) => p && matches(p));
    if (members.length < 2) { closeSpider(); return []; }
    if (spider.legs.length !== members.length) spider.legs = spiderLegs(members.length);
    const a = view.project(spider.lng, spider.lat);
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) return [];

    const out = [];
    let d = "";
    for (let i = 0; i < members.length; i++) {
      const leg = spider.legs[i] || { dx: 0, dy: 0 };
      const x = a.x + leg.dx, y = a.y + leg.dy;
      // ldx/ldy: the leg this member rode out on. paintPin() hangs the name on that side.
      out.push({ items: [{ p: members[i], x, y }], cx: x, cy: y, fan: true,
                 ldx: leg.dx, ldy: leg.dy, lng: spider.lng, lat: spider.lat });
      d += `M${a.x.toFixed(2)} ${a.y.toFixed(2)}L${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    // Two passes over one path: a --surface casing so the line reads over any tile, then the
    // line itself. Rebuilt only when the geometry actually changed, so a still fan writes
    // nothing at all.
    if (legsEl.dataset.d !== d) {
      legsEl.dataset.d = d;
      legsEl.innerHTML =
        `<path class="mp-leg-case" d="${d}"></path><path class="mp-leg" d="${d}"></path>`;
    }
    legsEl.hidden = false;
    hubEl.hidden = false;
    hubEl.style.transform = `translate3d(${a.x}px,${a.y}px,0)`;
    return out;
  }

  function paintCluster(g) {
    // Keyed by sorted membership, not by the first member: the grid pass can reorder items,
    // and a key that moves under a stable group would recreate its DOM node every frame.
    const ids = g.items.map((i) => i.p.id).sort();
    // Whether it wears its region's name is part of the key, not just the membership: the
    // node is built once, and a cluster that outlives its claim to the name (the camera
    // crosses REGION_LABEL_MAX_ZOOM, or a second disc of the region comes on screen) would
    // otherwise keep a label it no longer deserves.
    const key = `c:${g.region ? "r" : ""}:${ids.join(",")}`;
    let node = S.markers.get(key);
    if (!node) {
      node = document.createElement("button");
      node.type = "button";
      node.className = "mp-cluster";
      node.innerHTML = `<span class="mp-cluster-body"></span><span class="mp-cluster-name"></span>`;
      S.markers.set(key, node);
      layer.append(node);
      if (S.drop) spawned.push(node.firstElementChild);
      const name = g.region || "";      // nameGroups()
      const counts = new Map();
      for (const it of g.items) {
        const c = categoryOf(it.p.kind);
        counts.set(c, (counts.get(c) || 0) + 1);
      }
      const cats = [...counts.keys()];
      if (cats.length === 1) {
        node.dataset.cat = "1";
        node.setAttribute("style", catToneVars(cats[0]));
      } else if (cats.length > 1) {
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        let deg = 0;
        const stops = [];
        for (const [cat, n] of sorted) {
          const next = deg + (n / g.items.length) * 360;
          stops.push(`var(--cat-${cat}) ${deg.toFixed(1)}deg ${next.toFixed(1)}deg`);
          deg = next;
        }
        node.dataset.mix = "1";
        node.setAttribute("style", `--ds-ring:conic-gradient(${stops.join(",")})`);
      }
      node.dataset.ids = ids.join(",");
      node.querySelector(".mp-cluster-body").textContent = String(g.items.length);
      const nameEl = node.querySelector(".mp-cluster-name");
      nameEl.textContent = name;
      nameEl.hidden = !name;
      // No instruction copy here: "Zoom in." was both wrong — a tap now splits the
      // group at any zoom — and prose about the UI, which the standing copy rule forbids.
      node.setAttribute("aria-label",
        `${g.items.length} places${name ? ` near ${name}` : ""}` +
        `${cats.length === 1 ? `, all ${CATEGORY_LABEL[cats[0]]}` : ""}`);
    }
    // UNROUNDED. See the note in paintPin().
    node.style.transform = `translate3d(${g.cx}px,${g.cy}px,0)`;
    return key;
  }

  function paintPin(g, boxes, placed, fanBoxes) {
    const p = g.items[0].p;
    const key = `p:${p.id}`;
    let node = S.markers.get(key);
    if (!node) {
      node = document.createElement("button");
      node.type = "button";
      node.className = "mp-pin";
      node.dataset.id = p.id;
      node.setAttribute("style", catToneVars(p.kind));
      node.innerHTML =
        `<span class="mp-pin-body">` +
          `<span class="mp-pin-glyph">${getIcon(p.kind, p.subkind)}</span>` +
        `</span><span class="mp-pin-label"></span>`;
      node.querySelector(".mp-pin-label").textContent = p.name;
      node.dataset.anchor = p.is_anchor ? "1" : "0";
      S.markers.set(key, node);
      layer.append(node);
      if (S.drop) spawned.push(node.firstElementChild);
    }
    // The selected pin SPRINGS to 1.15 — animated only on the 0→1 edge (this
    // function runs every frame; the settled state must not re-trigger). The keyframes end
    // exactly on the CSS resting scale, so an animation that never gets a frame still lands
    // right. Deselection just eases back on the body's own .12s transition.
    const on = p.id === S.selected ? "1" : "0";
    if (on === "1" && node.dataset.on !== "1" && !reducedMotion()) {
      node.firstElementChild.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.15)" }],
        { duration: tokMs("--dur", 220), easing: easeSpringTok() });
    }
    node.dataset.on = on;

    let show = false;
    let dx = 0;
    let labPos = "below";
    const isSel = p.id === S.selected;
    // A fanned pin is labelled at any zoom: the tap that opened the fan was a request for the
    // names, and a ring of unlabelled glyphs would have answered it with less than the count.
    // THE MAP'S OWN EDGES (27 Nov): the surface runs on under the page's head (padTop) and under the place sheet
    // (sheetH), so a name there is cut mid-word ("Viejo de los Pescado…" under the head). Those edges count as the
    // controls do: a name that would cross one tries its other place, else goes; and a pin outside the room the map
    // shows (under the head or the sheet, or past a side) has no name at all, as the area names already keep inside it.
    const roomTop = (S.padTop || 0) + 2, roomBottom = S.h - (S.sheetH || 0) - 2;
    const inside = g.cx >= 0 && g.cx <= S.w && g.cy > roomTop && g.cy - PIN_UP_PX < roomBottom;
    if (inside && (isSel || g.fan || S.cam.zoom >= LABEL_MIN_ZOOM)) {
      const tw = textWidth(p.name);
      const w = Math.min(140, tw + 18);
      // Ordinarily a label is centred under its pin. A FANNED one HANGS OUTWARD along its own
      // leg instead — the left arm's name runs left, the right arm's runs right — because a
      // ring puts two names on the same baseline and the wider of the two then loses the
      // collision test. Measured at one doorway: three members, one of them with a name
      // thirty-two characters long, and the tap for names answered with two of three.
      // Hanging them outward makes the fan's own names structurally unable to collide, and it
      // reads as deliberate: the name is on the side the pin is on.
      const side = g.fan ? (g.ldx < -6 ? -1 : g.ldx > 6 ? 1 : 0) : 0;
      // NEVER UNDER THE MAP'S OWN CONTROLS (27 Nov): a fan's names play by a looser rule against pins and other names,
      // and a selected pin's ignores them, but a name under the full-screen button, the scale or the tab bar can't be
      // read at all: every label keeps clear of what floats over the map (readChrome). A fanned name the controls would
      // cover on its own side tries the other side of its pin, then goes, like a name the screen edge would crop.
      const underChrome = (b) => S.chrome.some((c) => overlaps({ x: c.l, y: c.t, w: c.r - c.l, h: c.b - c.t }, b))
        || b.y < roomTop || b.y + b.h > roomBottom;
      const sides = side ? [side, -side] : [0];
      for (const sd of sides) {
      let bx = sd < 0 ? g.cx - 6 - w : sd > 0 ? g.cx + 6 : g.cx - w / 2;
      // …and a name the SCREEN EDGE would crop slides back inside it rather than being
      // dropped: always for the two pins whose names are the point (the fan's, the selected
      // one's), and for any pin that is itself on screen, so the name stays under its pin. A
      // fit puts the outermost pin a pin's width from the edge, and that pin had no name.
      const pinOn = g.cx >= PIN_SIDE_PX && g.cx <= S.w - PIN_SIDE_PX;
      if ((g.fan || isSel || pinOn) && w <= S.w - 4) bx = clamp(bx, 2, S.w - 2 - w);
      dx = bx + w / 2 - g.cx;      // the shift from centred, handed to CSS as --lab-dx
      // A label that runs past the edge of the map is cropped mid-word by the surface, which
      // reads as a rendering fault rather than as a name. No label beats half a label.
      const onScreen = bx >= 2 && bx + w <= S.w - 2;
      const against = g.fan ? placed.concat(fanBoxes) : boxes;
      const hitsScale = (b) => !!(S.scaleBox && overlaps(S.scaleBox, b));
      const boxBelow = { x: bx, y: g.cy + 4, w, h: 17 };
      const boxBelowScale = { x: bx, y: g.cy + 4, w, h: 24 };
      const boxAbove = { x: bx, y: g.cy - 64, w, h: 22 };
      const fitsScaleBelow = !hitsScale(boxBelowScale);
      const fitsScaleAbove = !hitsScale(boxAbove);
      const belowOk = onScreen && fitsScaleBelow && !underChrome(boxBelow) && (isSel || !against.some((b) => overlaps(b, boxBelow)));
      const aboveOk = onScreen && boxAbove.y >= (S.padTop || 0) + 2 && fitsScaleAbove && !underChrome(boxAbove) && (isSel || !against.some((b) => overlaps(b, boxAbove)));
      let chosen = null;
      labPos = "below";
      if (belowOk) {
        chosen = boxBelow;
      } else if (aboveOk) {
        chosen = boxAbove;
        labPos = "above";
      } else if (isSel && onScreen && !fitsScaleBelow && boxAbove.y >= (S.padTop || 0) + 2 && !underChrome(boxAbove)) {
        chosen = boxAbove;
        labPos = "above";
      }
      if (chosen) {
        boxes.push(chosen);
        placed.push(chosen);
        show = true;
        break;
      }
      // The other side only when the controls are what stood in the way: a name dropped for crowding stays dropped, as
      // before (hung inward it would run across the fan's hub and legs).
      if (!(underChrome(boxBelow) || underChrome(boxAbove))) break;
      }
    }
    node.dataset.label = show ? "1" : "0";
    if (node.dataset.labpos !== labPos) node.dataset.labpos = labPos;
    // Written only when it changes: this runs per marker per frame, and a style write that
    // sets the value it already holds still dirties the element.
    const lab = show ? `${Math.round(dx)}px` : "0px";
    if (node.dataset.labdx !== lab) {
      node.dataset.labdx = lab;
      node.style.setProperty("--lab-dx", lab);
    }

    // The glyph is the identity; the aria-label says the same thing in words, SUBKIND first,
    // because "pharmacy" is what the reader is hunting for and "practical" is not.
    let label = `${p.name}, ${placeWhat(p)}`;
    if (S.me) {
      const to = { lat: +p.lat, lng: +p.lng };
      label += `, ${fmtDistance(haversine(S.me, to))} ${COMPASS_WORDS[bearing(S.me, to)] || ""}`;
    }
    node.setAttribute("aria-label", label);
    // ── half of smooth pinning: UNROUNDED ─────────────────────────────────────────────────
    // Never Math.round() here. The camera moves in real numbers, the GL canvas underneath
    // moves in real numbers, and every marker snapped to the nearest whole pixel — so across a
    // slow pan each pin held still for a frame or two and then jumped a pixel, out of step
    // with its neighbours and out of step with the ground. That is the wobble: not one pin
    // moving, but 40 pins each rounding at a different moment. A fractional translate3d is
    // composited on the GPU at sub-pixel precision, which is what "welded to the coordinate"
    // actually requires. The other half of the fix is WHEN this runs — see placeOverlay().
    node.style.transform = `translate3d(${g.cx}px,${g.cy}px,0)`;
    return key;
  }

  function layoutMe() {
    if (!S.me) { meEl.hidden = true; return; }
    const s = view.project(S.me.lng, S.me.lat);
    meEl.hidden = false;
    // Unrounded for the same reason the pins are: a GPS dot that ticks between whole pixels
    // while the ground slides under it looks like a bad fix, not like a smooth one.
    meEl.style.transform = `translate3d(${s.x}px,${s.y}px,0)`;
    // Cap the drawn radius: an early 2 km fix would otherwise paint the whole screen and hide
    // the map it is supposed to annotate. The real number stays in the sheet.
    const r = clamp((S.me.acc || 0) / mppAt(S.me.lat, S.cam.zoom), 0, Math.min(S.w, S.h) * 0.42);
    const d = Math.round(r * 2);
    meAcc.style.width = `${d}px`;
    meAcc.style.height = `${d}px`;
    meAcc.hidden = d < 12;
    meEl.dataset.stale = Date.now() - (S.me.at || 0) > 120000 ? "1" : "0";
  }

  // ── draw loop ─────────────────────────────────────────────────────────────────────────
  // One frame does: the ground (only when there are no tiles), the markers, the GPS dot, the
  // scale. Under MapLibre it is driven by the map's own move events, so it runs exactly as
  // often as the camera actually changes and not once more.
  //
  // ── the other half of smooth pinning: WHEN ─────────────────────────────────────────────
  // Unrounding the transforms is necessary and was not sufficient: handling MapLibre's
  // "move" by calling schedule(), which parks the work in a requestAnimationFrame — so the
  // pins were placed from the camera of the frame BEFORE the one MapLibre had already
  // painted the ground with. Every frame of a drag, the ground moved and the pins moved a
  // frame later; measured at 390x844 over a 2.4 px/frame drag the pins sat a mean 3.1 px
  // behind the tiles and swung 13 px out at the ends. That is not a rounding artefact, it is
  // a whole frame of lag, and it is what "wobble" looks like at 60 Hz.
  //
  // So the OVERLAY — markers, fan, GPS dot, the things that must agree with the ground pixel
  // for pixel — is placed SYNCHRONOUSLY inside the move handler, in the same task in which
  // MapLibre updated its transform and before it paints. That is exactly how MapLibre's own
  // Marker stays welded. The GROUND — the graticule, the plates, the scale readout, none of
  // which are anchored to a coordinate the eye is tracking — stays on the rAF, so the
  // expensive half still runs at most once per frame.
  function placeOverlay() {
    if (S.dead || S.detached || !S.w || !S.h) return;
    S.cam = view.cam();
    layoutMarkers();
    layoutMe();
  }

  // fitShell() reads two bounding rects and can write two style properties, so it is a forced
  // layout; running it inside a drag's per-frame path was pure cost. The host only moves when
  // a chip row appears or the shell resizes, both of which arrive through the ResizeObserver —
  // this is the safety net for anything that does not, at four times a second rather than
  // sixty.
  const FIT_EVERY_MS = 250;
  let fitAt = 0;
  function draw() {
    if (S.dead || S.detached || !S.w || !S.h) return;
    S.cam = view.cam();
    const t = performance.now();
    // An edge that moved changed the surface's size too: measured again before this frame
    // is painted, or the canvas keeps the old height and the ground stops short of the panel.
    // The same for the screen's density (a window dragged to another display, a page zoomed):
    // nothing resizes in CSS pixels, and the canvas would keep the old display's.
    if (t - fitAt > FIT_EVERY_MS) { fitAt = t; if (fitShell() || S.dpr !== Math.min(3, window.devicePixelRatio || 1)) measure(); else readChrome(); }
    // The marks first, then the ground: a plate's name is placed clear of the discs as they are
    // THIS frame. Ground first placed it against the frame before's, and the frame a tap's
    // flight ended on regrouped the discs after the name was written, one of them on it.
    layoutMarkers();
    layoutMe();
    const mpp = metresPerPixel();
    paintCanvas(mpp);
    paintScale(mpp);
  }
  function schedule() {
    if (S.raf || S.dead || S.detached) return;
    S.raf = requestAnimationFrame(() => { S.raf = 0; draw(); });
  }

  // The flat engine has no moveend of its own; a settle timer is the same idea, and it also
  // covers the case where a drag ends without the camera stopping on a frame boundary.
  let restTimer = 0;
  function scheduleRest() {
    clearTimeout(restTimer);
    restTimer = setTimeout(() => { if (!S.dead) resortList(); }, 260);
  }

  // ── flat-engine gestures ──────────────────────────────────────────────────────────────
  // Pointer Events, one code path for mouse and touch, ACTIVE ONLY WHILE THE FLAT ENGINE IS.
  // The moment MapLibre takes the camera these are removed — two gesture systems over one
  // canvas is the bug this whole pass is about.
  const ptrs = new Map();
  let gest = null;
  let dragDist = 0;
  let lastTap = 0, lastTapX = 0, lastTapY = 0;
  let flatOn = false;

  const localXY = (e) => {
    const r = surface.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  function pinchState() {
    const [a, b] = [...ptrs.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }
  function panBy(dx, dy) {
    const ws = worldSize(S.cam.zoom);
    view.jumpTo({
      lng: unmx(mx(S.cam.lng, ws) - dx, ws),
      lat: unmy(clamp(my(S.cam.lat, ws) - dy, 0, ws), ws),
      zoom: S.cam.zoom,
    });
  }
  // Pure: the camera that keeps the geographic point under (ax, ay) exactly where it is.
  function zoomedAround(nz, ax, ay) {
    const z = clamp(nz, MIN_ZOOM, MAX_ZOOM);
    const g = view.unproject(ax, ay);
    const ws = worldSize(z);
    return {
      lng: unmx(mx(g.lng, ws) - (ax - S.w / 2), ws),
      lat: unmy(clamp(my(g.lat, ws) - (ay - S.h / 2), 0, ws), ws),
      zoom: z,
    };
  }

  function onDown(e) {
    if (e.button != null && e.button > 0) return;
    view.stop();
    try { surface.setPointerCapture(e.pointerId); } catch { /* mouse leaving the window */ }
    ptrs.set(e.pointerId, localXY(e));
    if (ptrs.size === 1) dragDist = 0;
    if (ptrs.size === 2) gest = pinchState();
  }
  function onMove(e) {
    const prev = ptrs.get(e.pointerId);
    if (!prev) return;
    const now = localXY(e);
    ptrs.set(e.pointerId, now);
    if (ptrs.size === 1) {
      const dx = now.x - prev.x, dy = now.y - prev.y;
      dragDist += Math.hypot(dx, dy);
      if (dragDist > TAP_SLOP_PX) S.follow = false;
      panBy(dx, dy);
      return;
    }
    if (ptrs.size >= 2 && gest) {
      const g = pinchState();
      dragDist += Math.hypot(g.mx - gest.mx, g.my - gest.my) + Math.abs(g.dist - gest.dist);
      S.follow = false;
      panBy(g.mx - gest.mx, g.my - gest.my);
      if (gest.dist > 12 && g.dist > 12) {
        view.jumpTo(zoomedAround(S.cam.zoom + Math.log2(g.dist / gest.dist), g.mx, g.my));
      }
      gest = g;
    }
  }
  function onUp(e) {
    if (!ptrs.has(e.pointerId)) return;
    const at = localXY(e);
    const client = { x: e.clientX, y: e.clientY };
    ptrs.delete(e.pointerId);
    try { surface.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    gest = ptrs.size === 2 ? pinchState() : null;
    if (ptrs.size > 0 || dragDist > TAP_SLOP_PX) return;

    const t = performance.now();
    if (t - lastTap < DOUBLE_TAP_MS && Math.hypot(at.x - lastTapX, at.y - lastTapY) < 32) {
      lastTap = 0;
      easeTo(zoomedAround(S.cam.zoom + 1, at.x, at.y), 260);
      return;
    }
    lastTap = t; lastTapX = at.x; lastTapY = at.y;

    // With a captured pointer the browser fires click at the CAPTURE element, so a tap is
    // resolved here by hit-testing rather than by listening for click.
    const hit = document.elementFromPoint(client.x, client.y);
    const pin = hit && hit.closest && hit.closest(".mp-pin");
    if (pin) { select(pin.dataset.id); return; }
    const cl = hit && hit.closest && hit.closest(".mp-cluster");
    if (cl) { openCluster(cl); return; }
    if (hit && hit.closest && hit.closest(".mp-hub")) { closeSpider(); return; }
    // A tap on empty ground folds an open fan back up first — that is what it is for — and
    // otherwise clears the selection, which is also how the sheet falls back to whatever the
    // user's remembered preference is.
    if (closeSpider()) return;
    if (S.selected) select(null);
  }
  const gesturePrevent = (e) => e.preventDefault();

  function flatGestures(on) {
    if (on === flatOn) return;
    flatOn = on;
    const fn = on ? "addEventListener" : "removeEventListener";
    surface[fn]("pointerdown", onDown);
    surface[fn]("pointermove", onMove);
    surface[fn]("pointerup", onUp);
    surface[fn]("pointercancel", onUp);
    surface[fn]("dragstart", gesturePrevent);
    // Safari's pinch-to-zoom-the-page, which touch-action does not cover.
    for (const t of ["gesturestart", "gesturechange", "gestureend"]) surface[fn](t, gesturePrevent);
    if (!on) ptrs.clear();
  }
  flatGestures(true);

  // ── A TAP ALWAYS SPLITS THE GROUP ──────────────────────────────────────────────────────
  // Previously a cluster tap tried to fit to its members and at least 1.2 zoom levels in,
  // which is right until it is not: at MAX_ZOOM there is no zoom left to give, and for two
  // places in one building there is no zoom that would ever separate them. The tap then did
  // visibly nothing, which is the worst answer a control can give.
  //
  // Going further than just zooming in: the number carries less information than
  // icon+name, so never make the user zoom for it. A group of two or three answered with a
  // camera flight is still the map refusing to say what is under the disc — it says it a
  // second and a half later, from a viewport that has thrown away the surroundings the user
  // was reading. So up to FAN_TAP_MAX members the tap FANS, at every zoom, with the camera
  // left alone: two ATMs forty metres apart become two named pins where they stand.
  //
  // Above that a fan is a ring of glyphs over ground too small to hold them (see the note on
  // FAN_TAP_MAX for what that looked like), and the camera IS the better answer — but only if
  // it resolves anything. The question there is not "would a zoom pull every member apart",
  // which is no whenever a coincident pair hides inside a group of twenty; it is "would a
  // zoom split this group AT ALL". If it would, zoom, and whatever knot survives is smaller
  // and one tap from opening. If it would not — MAX_ZOOM, or these places genuinely share a
  // doorway — the fan opens regardless of size.
  // Every road resolves the group ON THE TAP; none of them asks the user to zoom.
  function openCluster(node) {
    const ids = new Set((node.dataset.ids || "").split(",").filter(Boolean));
    const pts = S.places.filter((p) => ids.has(p.id));
    if (pts.length < 2) return;
    if (spider) closeSpider();

    const box = insets();
    if (pts.length > FAN_TAP_MAX) {
      const t = fitTo(pts, box);
      // The zoom the camera would actually END on, clamps included — asking about a zoom we
      // cannot reach would otherwise do nothing at MAX_ZOOM.
      const z = t ? clamp(Math.max(t.zoom, S.cam.zoom + 1.2), MIN_ZOOM, MAX_ZOOM) : null;
      if (t && z > S.cam.zoom + 0.05 && groupCountAt(pts, z) > 1) { easeTo({ ...t, zoom: z }); return; }
    }

    // Fan the members out around the coordinate they share. The anchor is the cluster's own
    // centre, taken from the node's current position so the fan opens from exactly where the
    // disc the user hit was standing.
    const m = /translate3d\(([-\d.e+]+)px,\s*([-\d.e+]+)px/.exec(node.style.transform || "");
    const ax = m ? parseFloat(m[1]) : S.w / 2;
    const ay = m ? parseFloat(m[2]) : S.h / 2;
    const at = view.unproject(ax, ay);
    openSpider(pts, at.lng, at.lat);

    // A fan opening against an edge would hang half of itself off the screen. Only when it
    // would: an ordinary tap in the middle of the map must not shove the camera about.
    const r = SPIDER_MIN_R + Math.min(pts.length, SPIDER_RING_MAX) * SPIDER_R_PER + PIN_UP_PX;
    const need = ax - r < box.left || ax + r > S.w - box.right ||
                 ay - r < box.top || ay + r > S.h - box.bottom;
    if (need) easeTo(cameraFor(at.lng, at.lat, S.cam.zoom, box), tokMs("--dur", 220));
  }

  // Under MapLibre this is the ONLY tap path: the pins are real buttons inside the canvas
  // container, so a tap on one lands as a click here while a drag that starts on one is
  // MapLibre's to handle. Under the flat engine it serves keyboard activation only, where a
  // captured pointer never delivers click.
  layer.addEventListener("click", (e) => {
    const pin = e.target.closest(".mp-pin");
    if (pin) { select(pin.dataset.id); return; }
    const cl = e.target.closest(".mp-cluster");
    if (cl) openCluster(cl);
  });

  // ── selection ──
  // Selecting a pin OPENS the sheet without touching the stored preference: you tapped the pin
  // to be told something and the answer lives in the sheet. Clearing the selection returns to
  // whatever the user last chose for themselves.
  function select(id, o) {
    S.selected = id || null;
    lastSelected = S.selected;
    root.dataset.mode = S.selected ? "card" : "list";
    setSheet(S.bare ? "shut" : (id ? "open" : readSheetPref()), { remember: false });
    if (S.onPick && !(o && o.quiet)) { try { S.onPick(S.selected); } catch (e) { console.error("[map] onPick", e); } }
    renderSheet();
    clusterAt = null;          // the selected pin never clusters; re-derive with it solo
    schedule();
    if (o && o.center && id) {
      const p = placeById(id);
      // One place's pin, so in a short strip it may use the strip's whole height (stripRange()).
      if (p) easeTo(cameraFor(+p.lng, +p.lat, Math.max(S.cam.zoom, FOCUS_ZOOM), { ...insets(), one: true }));
    } else if (id) keepInView(placeById(id));
  }

  // A pin tapped on the map opens its card, and the card is taller than the panel was (or the panel was shut): the
  // picked place is kept where the map still shows it, moved only as far as that takes, never centred (19 Nov: on a
  // phone on its side its pin stood under the card's top edge).
  function keepInView(p) {
    if (!p || !Number.isFinite(+p.lng) || !Number.isFinite(+p.lat)) return;
    const s = view.project(+p.lng, +p.lat);
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) return;
    const box = { ...insets(), one: true };
    const ys = box.strip ? stripRange(box.strip, true) : { lo: box.top, hi: S.h - box.bottom };
    const xs = { lo: box.left, hi: Math.max(box.left, S.w - box.right) };
    const x = clamp(s.x, xs.lo, xs.hi), y = clamp(s.y, ys.lo, ys.hi);
    if (Math.abs(x - s.x) < 0.5 && Math.abs(y - s.y) < 0.5) return;
    easeTo({ lng: +p.lng, lat: +p.lat, zoom: S.cam.zoom, offset: [x - S.w / 2, y - S.h / 2] }, tokMs("--dur", 220));
  }

  // ── the sheet's open/shut state ──
  let settleTimer = 0;
  function setSheet(state, o) {
    const v = state === "shut" || S.bare ? "shut" : "open";
    if (o && o.remember) writeSheetPref(v);
    if (S.sheet === v) { positionChrome(); return; }
    S.sheet = v;
    root.dataset.sheet = v;
    grab.setAttribute("aria-expanded", String(v === "open"));
    grab.setAttribute("aria-label", v === "open" ? "Hide the nearby panel" : "Show the nearby panel");
    // The transform animates over 220ms and the chrome is positioned off the sheet's height,
    // so re-measure once now and once after the transition has landed.
    positionChrome();
    schedule();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { if (!S.dead) { positionChrome(); schedule(); } }, 250);
  }

  // Drag the grab bar down to dismiss. Sheets are dragged as well as tapped, and one that only
  // answers a precise tap on a 38px pill is awkward one-handed. The drag
  // lives on the BAR and not on the body: the list scrolls, and a body that both scrolls and
  // dismisses fights list scrolling.
  let grabFrom = null, grabDragged = false;
  grab.addEventListener("click", () => {
    if (grabDragged) { grabDragged = false; return; }   // the drag already decided
    setSheet(S.sheet === "open" ? "shut" : "open", { remember: true });
  });
  grab.addEventListener("pointerdown", (e) => {
    grabFrom = e.clientY;
    grabDragged = false;
    try { grab.setPointerCapture(e.pointerId); } catch { /* fine */ }
  });
  grab.addEventListener("pointermove", (e) => {
    if (grabFrom == null) return;
    const dy = e.clientY - grabFrom;
    if (dy <= 0) { sheet.style.transform = ""; return; }
    if (dy > 6) grabDragged = true;
    root.dataset.dragging = "1";
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const endGrab = (e) => {
    if (grabFrom == null) return;
    const dy = e.clientY - grabFrom;
    grabFrom = null;
    root.removeAttribute("data-dragging");
    sheet.style.transform = "";
    try { grab.releasePointerCapture(e.pointerId); } catch { /* fine */ }
    if (dy > SHEET_DRAG_DISMISS_PX) setSheet("shut", { remember: true });
    // grabDragged is deliberately NOT cleared here. A drag that fell short of the threshold
    // must snap back and do NOTHING; clearing the flag would let the click that follows toggle
    // the sheet, so a hesitant half-drag would close it anyway — the opposite of what the
    // hand just said. pointerdown clears the flag at the start of every gesture, so a real tap
    // is still a real tap.
  };
  grab.addEventListener("pointerup", endGrab);
  grab.addEventListener("pointercancel", endGrab);

  peek.addEventListener("click", () => setSheet("open", { remember: true }));

  // ── controls (exactly three) ──
  ctrls.addEventListener("click", (e) => {
    const b = e.target.closest(".mp-ctrl");
    if (!b) return;
    view.stop();
    switch (b.dataset.act) {
      // Compass: back to north, and flat. Two things in one tap because they are one
      // intention — "put the map back the way it reads".
      case "north":
        easeTo({ lng: S.cam.lng, lat: S.cam.lat, zoom: S.cam.zoom, bearing: 0, pitch: 0 }, 300);
        break;
      case "fit": {
        S.follow = false;
        const t = fitTo(visible(), insets());
        if (t) easeTo(t);
        break;
      }
      case "geo":
        // Denied is not a dead button. It asks again — the browser decides whether that is a
        // prompt or an instant refusal, and either way the control has answered the tap. (It
        // avoids opening a panel with an empty explanation —
        // a control that opens a panel to say nothing is worse than one that just retries.)
        // Refused: the tap still asks again (the person may have turned it on since), and says in words why nothing may
        // happen and where it's turned on, never a silent nothing.
        if (S.geo === "denied") {
          toast("Location is off for this site. Turn it on in your browser's settings for this site, then tap again.");
          setGeo("off"); startGeo(true); break;
        }
        if (!S.me) { startGeo(true); break; }   // no fix yet: follow as soon as one lands
        S.follow = true;
        easeTo(cameraFor(S.me.lng, S.me.lat, Math.max(S.cam.zoom, 15), insets()));
        break;
    }
  });

  // ── geolocation ───────────────────────────────────────────────────────────────────────
  // Needs no network: the GPS radio and the almanac are on the device. This is the single most
  // valuable thing on the map above 4,000 m, and it is also the only part that can prompt, so
  // the prompt is only raised when we know it will not surprise anyone.
  //
  // watchPosition rather than util.js getPosition(): every other view wants ONE cached read,
  // which is what getPosition() is for, but a dot on a map is the one place a live track is
  // the feature rather than a battery cost with no payoff.
  function setGeo(v) {
    S.geo = v;
    const b = ctrls.querySelector('[data-act="geo"]');
    if (!b) return;
    b.dataset.geo = v;
    b.setAttribute("aria-label",
      v === "denied" ? "Location permission is off"
        : v === "on" ? "Centre on my location"
        : "Show my location");
  }

  // `follow` is opt-in, and that is the whole point. A watch started automatically only has
  // permission to draw the dot; if it also recentred, the first fix would yank the camera off
  // whatever the user arrived to look at — a ?focus=<place> deep link, or the view they left
  // this screen on. Only a deliberate tap on the crosshair asks the map to follow.
  function startGeo(follow) {
    if (!navigator.geolocation || S.watch != null || S.dead) return;
    setGeo("locating");
    S.follow = !!follow;
    S.watch = navigator.geolocation.watchPosition(
      (pos) => {
        if (S.dead) return;
        S.me = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          acc: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : 0,
          at: pos.timestamp || Date.now(),
        };
        const first = S.geo !== "on";
        setGeo("on");
        // The list is sorted by distance from the fix, so the FIRST one re-sorts it; later
        // ones only move numbers, and rebuilding the list under a scrolling thumb is worse
        // than a stale metre.
        if (first) renderSheet(); else paintLive();
        if (S.follow) view.jumpTo(cameraFor(S.me.lng, S.me.lat, S.cam.zoom, insets()));
        schedule();
      },
      (err) => {
        if (S.dead) return;
        // 1 = PERMISSION_DENIED, and it is the only one worth giving up on. Position
        // unavailable and timeout are transient — a first fix in a canyon can take minutes —
        // so the watch stays alive and keeps trying.
        if (err && err.code === 1) { stopGeo(); setGeo("denied"); notePositionRefused(); }
        else setGeo(S.me ? "on" : "error");
        renderSheet();
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 }
    );
  }
  function stopGeo() {
    if (S.watch != null) { navigator.geolocation.clearWatch(S.watch); S.watch = null; }
  }

  async function maybeAutoGeo() {
    if (!navigator.geolocation) { setGeo("denied"); return; }
    // Only auto-start when the answer is already yes. A first-ever look at the map should not
    // throw a system dialog at someone who tapped the toggle to look around; once granted,
    // every later launch starts the watch with no interaction at all — which is the state the
    // phone will be in for the whole trip.
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const st = await navigator.permissions.query({ name: "geolocation" });
        if (S.dead) return;
        if (st.state === "granted") startGeo(false);
        else if (st.state === "denied") setGeo("denied");
        return;
      }
    } catch { /* Safari has historically rejected name:"geolocation" here */ }
    // No way to know the answer without asking, and the app never asks by itself: the dot waits
    // for the person's tap on the locate button.
  }

  // ── sheet content ─────────────────────────────────────────────────────────────────────
  // Two renderers, one panel. Neither of them explains anything: the standing copy rule is
  // that an explainer sentence in the UI is a defect, and the two this file used to carry
  // ("No routing here — download Google Maps offline areas…" and "Tap the crosshair to show
  // your position…") are gone. The crosshair explains itself by being a crosshair.

  function renderSheet() {
    live = null;
    const p = S.selected && placeById(S.selected);
    root.dataset.mode = p ? "card" : "list";
    if (p) renderCard(p); else renderList();
    positionChrome();
    paintLive();
    updatePeek();
  }

  // The collapsed pill names what it would reopen, so shutting the sheet does not also hide
  // what it was saying.
  function updatePeek() {
    const p = S.selected && placeById(S.selected);
    peekText.textContent = p ? clip(p.name, 18) : "Nearby";
    peek.setAttribute("aria-label", p ? `Show details for ${p.name}` : "Show nearby places");
  }

  // Distance is measured FROM THE USER or not at all. With no fix the rows are still ordered
  // nearest-first — from the middle of the visible map, which is the other honest origin —
  // and simply carry no number, rather than presenting a distance from somewhere you are not.
  function originForList() {
    if (S.me) return { origin: S.me, real: true };
    return { origin: view.unproject(S.w / 2, Math.max(0, S.h - S.sheetH) / 2), real: false };
  }

  // ...and when the origin IS the map, the list has to follow the map, or "nearby" is a claim
  // about wherever the camera happened to be when the panel was built. Only on moveend, only
  // when the centre has actually travelled a quarter of the screen, and only while the list is
  // the thing on screen: re-sorting under a scrolling thumb is its own bug. Scroll position is
  // carried across, because the rows are the same rows in a different order.
  let listOrigin = null;
  function resortList() {
    if (S.me || S.selected || S.sheet !== "open" || S.dead) return;
    const o = originForList().origin;
    if (listOrigin && haversine(listOrigin, o) < metresPerPixel() * S.w * 0.25) return;
    const top = body.scrollTop;
    renderList();
    body.scrollTop = top;
  }

  // The whole filtered list, nearest first, in Places' own row. No top-3 cap, no
  // prose, and it scrolls.
  function renderList() {
    const vis = visible();
    listOrigin = null;
    if (!vis.length) {
      // Three different nothings: a trip with no places, a trip whose places have no pins,
      // and a filter that leaves none of the pinned ones.
      const all = store.places().length;
      body.innerHTML = `<div class="mp-empty meta">${
        !all ? "No places on this trip yet."
          : !S.places.length ? (all === 1 ? "This trip's one place isn't on the map yet. It is in the list." : `None of this trip's ${all} places is on the map yet. They are in the list.`)
            : "Nothing in this filter is on the map."}</div>`;
      return;
    }
    const { origin, real } = originForList();
    listOrigin = real ? null : origin;
    const rows = vis
      .map((p) => ({ p, m: haversine(origin, { lat: +p.lat, lng: +p.lng }) }))
      .sort((a, b) => a.m - b.m);

    body.innerHTML = `<div class="mp-list">${rows.map(({ p, m }) => {
      const abbr = real ? bearing(S.me, { lat: +p.lat, lng: +p.lng }) : "";
      const rail = real
        ? `<span class="pl-far">${esc(fmtDistance(m))} ${esc(abbr)}</span>`
        : placeRatingHtml(p);
      const aria = `${p.name}, ${placeWhat(p)}` +
        (real ? `, ${fmtDistance(m)} ${COMPASS_WORDS[abbr] || ""}` : "");
      return `<button class="pl-row" type="button" data-pick="${esc(p.id)}"
          style="${catToneVars(p.kind)}" aria-label="${esc(aria)}">
        <span class="pl-ico">${getIcon(p.kind, p.subkind)}</span>
        <span class="pl-rowmain">
          <span class="pl-t">
            <span class="pl-name">${esc(p.name)}</span>
          </span>
          <span class="pl-meta">${placeMeta(p, [esc(areaLabel(p.area) || "")], { rating: real })}</span>
        </span>${rail}</button>`;
    }).join("")}</div>`;
  }

  // The abridged card, rebuilt. Fixed height, no internal scroll, clipped by the
  // sheet's own rounded box. Name, glyph/thumb, distance, open state, address, one action row — and
  // the CTA that hands everything else to the place page, which is where it belongs.
  function renderCard(p) {
    const trip = store.trip();
    const tz = (trip && trip.default_tz) || "UTC";
    let st = null;
    try { st = p.hours ? openState(parseHours(p.hours), nowInZone(tz)) : null; }
    catch { st = null; }
    const sub = [placeWhat(p), areaLabel(p.area)].filter(Boolean).join(" · ");
    const shot = placePhoto(p);
    const lead = shot && shot.card
      ? `<img src="${esc(shot.card)}" alt="" decoding="async">`
      : getIcon(p.kind, p.subkind);

    body.innerHTML = `
      <div class="mp-card">
        <div class="mp-card-top">
          <span class="mp-cat" style="${catToneVars(p.kind)}">${lead}</span>
          <div class="grow mp-card-t">
            <div class="mp-title">${esc(p.name)}</div>
            <div class="mp-sub">${esc(sub)}</div>
          </div>
          <button class="mp-x" type="button" data-act="clear" aria-label="Clear selection">
            ${icon(ICO.close)}
          </button>
        </div>
        <div class="mp-pills">
          <span class="mp-dist" hidden>${icon(ICO.arrow)}<span class="mp-dist-t"></span></span>
          ${openPillHtml(st)}
        </div>
        <div class="mp-addr">${esc(p.address || "")}</div>
        <div class="mp-acts">
          <button class="btn ds-button ds-button--white" type="button" data-act="gmaps">Open in Maps</button>
          <button class="btn ds-button ds-button--gray" type="button" data-act="details">Place page</button>
        </div>
      </div>
    `;
    const box = body.querySelector(".mp-dist");
    live = { box, text: box.querySelector(".mp-dist-t"), arrow: box.querySelector("svg"), last: "" };
  }

  // Only the numbers move between fixes. Rebuilding the card on every GPS tick would make its
  // buttons impossible to hit.
  function paintLive() {
    if (!live) return;
    const p = S.selected && placeById(S.selected);
    const to = p ? { lat: +p.lat, lng: +p.lng } : null;
    if (!to || !S.me) { live.box.hidden = true; return; }
    const m = haversine(S.me, to);
    const abbr = bearing(S.me, to);
    const t = `${fmtDistance(m)} · ${abbr}`;
    live.box.hidden = false;
    live.arrow.style.transform = `rotate(${bearingDeg(S.me, to).toFixed(1)}deg)`;
    if (live.last !== t) {
      live.text.textContent = t;
      live.last = t;
      live.box.setAttribute("aria-label",
        `${fmtDistance(m)} ${COMPASS_WORDS[abbr] || abbr} of you, straight line`);
    }
  }

  // Scoped to the sheet's BODY, not the sheet: the grab bar is a sibling with its own
  // handlers, and a delegated listener on the parent would fire for it too.
  body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act],[data-pick]");
    if (!b) return;
    if (b.dataset.pick) { select(b.dataset.pick, { center: true }); return; }
    const p = S.selected && placeById(S.selected);
    switch (b.dataset.act) {
      case "clear": select(null); break;
      case "details": if (p) router.go(`#/p/${encodeURIComponent(p.id)}`); break;
      // Handing off to another app, not navigating our own — location.href rather than
      // window.open, because an installed PWA blocks popups and open() silently does nothing.
      // Google only; the Apple/geo branch is deliberately omitted.
      case "gmaps": if (p) location.href = googleMapsUrl(p); break;
    }
  });

  // ── theme ─────────────────────────────────────────────────────────────────────────────
  // resolvedLum(), not resolvedTheme(): there are several themes now and only two basemap
  // flavours, so what the map needs is the FAMILY. Comparing the theme id to "dark" was right
  // when "dark" was the only dark theme and silently wrong the moment it was not — a night
  // theme would have drawn a daylight basemap under it.
  // The shell's control writes data-theme on <html>, and the OS can also flip underneath a
  // "system" choice. Both change the canvas colours (read as VALUES, not var()) and the
  // basemap flavour. Pins and clusters read DS tokens directly.
  const mqDark = matchMedia("(prefers-color-scheme: dark)");
  let themeNow = resolvedLum();
  const onTheme = () => {
    if (S.dead) return;
    readPalette();
    textWidths.clear();
    scaleLast = "";
    schedule();
    const next = resolvedLum();
    if (next === themeNow) return;    // data-theme churn that did not change what is on screen
    themeNow = next;
    if (S.map && !S.glDead) applyStyle();
  };
  mqDark.addEventListener("change", onTheme);
  const themeObs = new MutationObserver(onTheme);
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ── the query, and Places' filter row ─────────────────────────────────────────────────
  // Idempotent by construction: onNavigate fires TWICE per navigation (shell contract) and a
  // hashchange can repeat a URL, so both paths compare before doing anything at all.
  function applyFilter(f) {
    const next = normFilter(f);
    if (next.kind === S.filter.kind && next.sub === S.filter.sub && next.text === S.filter.text) return;
    S.filter = next;
    closeSpider();     // the fan described a group the filter has just redefined
    // Pins the filter just revealed drop in with a small stagger. The flag is
    // consumed by the next layoutMarkers() pass — markers born on any OTHER pass (panning
    // across the cull line, clusters splitting under a zoom) appear silently, so nothing
    // animates under a moving finger.
    S.drop = true;
    // A filter that hides the selected pin has to clear the card too, or the sheet is
    // describing something that is no longer on the map. select() re-renders for us.
    const sel = S.selected && placeById(S.selected);
    if (sel && !matches(sel)) { select(null); return; }
    renderSheet();
    schedule();
  }

  let lastFocus = null;
  function readUrl() {
    if (S.dead) return;
    const q = readQuery();
    applyFilter(q);
    if (!q.focus) { lastFocus = null; return; }
    if (q.focus === lastFocus) return;
    lastFocus = q.focus;
    const p = placeById(q.focus);
    if (p) select(p.id, { center: true });
  }
  const offNav = urlDriven && typeof router.onNavigate === "function"
    ? router.onNavigate(readUrl) : () => {};
  if (urlDriven) addEventListener("hashchange", readUrl);

  // ── store ─────────────────────────────────────────────────────────────────────────────
  // Places can land after mount: a cold boot resolves /api/trip while this view is already on
  // screen, and a background refresh can add rows at any time.
  const offChange = store.on("change", () => {
    if (S.dead) return;
    const had = S.places.length;
    readPlaces();
    renderSheet();
    // The first places of a trip: the map goes to them. The panel has just grown its list and
    // the host is moving in this same change (Places' head gains its row of chips), so the fit
    // is made against the panel as it now is, and made again once the layout has landed.
    if (!had && S.places.length) { measure(); initialCamera(); settleSoon(); }
    else if (!had) initialCamera();
    clusterAt = null;
    schedule();
    // The trip's offline map can arrive after the map is up (it was just cut), be cut again
    // (its version moves), or go.
    paintNote();
    if (S.map && !S.glDead) {
      const m = mapState();
      if (!m.ready) {
        archiveTried = false;
        if (S.tiles) { sharedArchive = null; sharedVersion = null; killTiles(); }
      } else if (S.tiles && sharedVersion !== m.version && navigator.onLine) {
        // A new map, and signal to read it by: the one on screen is the one before it.
        sharedArchive = null; sharedVersion = null; archiveTried = false;
        killTiles();
        bootTiles();
      } else if (!S.tiles && !archiveTried) bootTiles();
    }
  });

  const onResize = () => {
    if (S.dead || S.detached) return;
    measure();
    // A camera the map chose (the fit of the trip's places) follows the layout until the
    // person moves the map: the space the fit was made for has changed under it.
    if (autoCam && sameCam(view.cam(), autoCam)) fitPlaces();
    else { autoCam = null; initialCamera(); }
    clusterAt = null; schedule();
  };
  // The host can MOVE without changing size (the view scrolls back to its top after a route
  // change; the head above it grows a row), and nothing observes a move. So the layout is
  // read again a little after anything that can cause one: twice across the next frames, and
  // once more after the longest transition the app runs.
  let settleTimer2 = 0;
  function settleSoon() {
    requestAnimationFrame(() => requestAnimationFrame(onResize));
    clearTimeout(settleTimer2);
    settleTimer2 = setTimeout(onResize, 450);
  }
  let scrollRaf = 0;
  const onHostScroll = () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; onResize(); });
  };
  // Observed targets belong to the current host, so claim() re-points the observer and
  // release() disconnects it — a detached session must not be woken by a layout it is not in.
  const ro = new ResizeObserver(onResize);
  addEventListener("orientationchange", onResize);

  // ── initial camera ────────────────────────────────────────────────────────────────────
  // Order of preference, most specific first. The interesting one is the last: mid-trip the
  // map should open on where the trip actually IS, which is a question the itinerary can
  // answer and the map cannot.
  function currentRegionPlaces() {
    const now = Date.now();
    const evs = store.events().filter((e) => e.place_id);
    let hit = null;
    for (const e of evs) {
      const s = toMs(e.starts_at);
      const en = e.ends_at ? toMs(e.ends_at) : s + 3600e3;
      if (now >= s && now <= en) { hit = e; break; }
    }
    if (!hit) hit = evs.find((e) => toMs(e.starts_at) >= now) || evs[evs.length - 1];
    const p = hit && store.place(hit.place_id);
    if (!p || !usable(p)) return null;
    const r = AR.regionOf(p);
    if (!r) return [p];
    const near = S.places.filter((q) => AR.inRegion(r, q));
    return near.length ? near : [p];
  }

  let regionsShown = false;   // an empty trip was opened on its regions, once
  // Below this the surface is mid-layout, not a real viewport. fitTo() clamps its available
  // box to a 48 px floor, so fitting against a transient 30 px tall surface yields a camera
  // three zoom levels out — and cameraSet latches, so nothing ever corrects it. Waiting for
  // the ResizeObserver costs one frame.
  const MIN_FIT_PX = 120;

  function initialCamera() {
    if (cameraSet || S.w < MIN_FIT_PX || S.h < MIN_FIT_PX) return;

    const fid = readQuery().focus;
    if (fid) {
      const p = placeById(fid);
      if (p) {
        cameraSet = true;
        lastFocus = fid;
        S.selected = p.id;
        lastSelected = p.id;
        root.dataset.mode = "card";
        setSheet("open", { remember: false });
        renderSheet();                      // first: insets() needs the sheet's real height
        view.jumpTo(cameraFor(+p.lng, +p.lat, FOCUS_ZOOM, { ...insets(), one: true }));
        return;
      }
      if (!S.places.length) return;   // data not in yet; try again on the next "change"
    }

    if (lastCam) { cameraSet = true; view.jumpTo(lastCam, { quiet: true }); return; }
    const stored = loadCam();
    const sheetMoved = stored && stored.auto && stored.sheetH != null && Math.abs(stored.sheetH - S.sheetH) > 4;
    if (stored && !sheetMoved && nearTrip(AR, S.places, stored.lng, stored.lat)) {
      cameraSet = true; view.jumpTo(stored, { quiet: true }); return;
    }
    if (!S.places.length) {
      // No places yet. A trip that has drawn its regions still says where it is: open on
      // them, once, and not latched, so the places fit themselves when they land.
      if (!regionsShown && AR.bounded.length) {
        const corners = [];
        for (const r of AR.bounded) {
          const b = r.bounds;
          corners.push({ lng: b.west, lat: b.north }, { lng: b.west + widthOf(b), lat: b.south });
        }
        const open = fitTo(corners, insets());
        if (open) { regionsShown = true; view.jumpTo(open, { quiet: true }); }
      }
      return;
    }

    fitPlaces();
  }

  // The fit of the trip's places (where the trip is today, when the itinerary says). What it
  // chose is kept in autoCam, so the same fit can be made again if the layout changes before
  // the person has moved the map.
  let autoCam = null;
  const sameCam = (a, b) => !!a && !!b && Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(nearLng(a.lng, b.lng) - b.lng) < 1e-6 && Math.abs(a.zoom - b.zoom) < 1e-4;
  function fitPlaces() {
    const region = currentRegionPlaces();
    const target = fitTo(region && region.length ? region : S.places, insets());
    if (!target) return;
    cameraSet = true;
    view.jumpTo(target, { quiet: true });
    autoCam = view.cam();
    saveCam({ ...autoCam, auto: true, sheetH: S.sheetH }, true);
  }

  // ── tiles ─────────────────────────────────────────────────────────────────────────────

  // Only a YES is remembered. A browser refuses a WebGL2 context for reasons that pass —
  // the tab was in the background when we asked, another page had taken the last context —
  // and caching that "no" would turn one bad moment into no tiles for the rest of the app's
  // life. Re-asking costs one throwaway canvas per mount, which is per navigation, not per
  // frame.
  function webglOk() {
    if (webglVerdict) return true;
    try {
      const gl = document.createElement("canvas").getContext("webgl2");
      // A throwaway context still occupies one of the browser's small number of GL slots;
      // hand it back rather than waiting for GC to get round to it.
      if (gl) { const x = gl.getExtension("WEBGL_lose_context"); if (x) x.loseContext(); }
      webglVerdict = !!gl;
    } catch { webglVerdict = false; }
    return webglVerdict;
  }

  // The pmtiles Source interface over a Blob we already hold. This is what makes tiles work
  // with the radio off: the whole archive sits in Cache Storage and every "range request" is
  // a Blob.slice — a disk read, not a fetch. The library's own FileSource keys itself off
  // File.name and a Blob has none, so the key is supplied explicitly; it has to equal the URL
  // in the style, because Protocol looks archives up by exactly that string.
  class BlobSource {
    constructor(blob, key) { this.blob = blob; this.key = key; }
    getKey() { return this.key; }
    async getBytes(offset, length) {
      return { data: await this.blob.slice(offset, offset + length).arrayBuffer() };
    }
  }

  // What the trip says about its map, read the same way everywhere (map-keep.js).
  const mapState = () => mapStateOf(store.tiles());
  const hasArchive = () => mapState().ready;

  // What this phone has been told, or has answered, about this trip's map: which map's note
  // was put away, which big map the person said to keep, which they said not to.
  const said = () => saidOf(TRIP);
  const say = (patch) => sayOf(TRIP, patch);

  const mb = (bytes) => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;

  // Is the copy on the phone the map the trip has now?
  let keptVersion;                  // undefined: not looked yet; null: none kept
  async function lookKept() {
    const kept = await keptArchive(TRIP);
    const m = mapState();
    keptVersion = kept ? (isCurrent(kept, m) ? m.version : (kept.version || "")) : null;
    return kept;
  }

  // The whole archive and its label glyphs onto the phone, so day 4 looks like day 1. The
  // shell has usually done this already, with this screen never opened (index.html); a call
  // here joins that one or finds the map kept. What comes of it arrives below, whoever asked.
  const stashArchive = () => { keepMap({ tripId: TRIP, tiles: () => store.tiles() }); };
  const unhearKeep = onKeep((came) => {
    if (S.dead || came.tripId !== TRIP) return;
    if (came.archive === "kept" || came.archive === "current") keptVersion = came.version;
    paintNote();
  });

  // ── what the map has to say for itself ────────────────────────────────────────────────
  // One card, one thing at a time, the most pressing first: a map that is kept only on the
  // person's word (too big to keep without asking, or the browser is set to save data); a
  // phone too short of room to keep it; a map being made; one that could not be made; a note
  // about the one that was (a region left out to fit). A note is put away with "OK" and stays
  // away for that map.
  //
  // A TRIP THAT SAYS NOWHERE IT GOES HAS NO MAP TO MAKE (the server makes a trip's map around
  // its top-level areas with bounds; a trip made by hand without a town has none). The card
  // says so and carries the way to where a town is added: the trip's own page, "Where it goes".
  // Not on a site that makes no maps (the snapshot's `maps` is false): there the sentence
  // would promise what can't come, and the map goes on drawing the trip's places on plain ground.
  //
  // A MAP THAT COULDN'T BE MADE CAN BE ASKED FOR AGAIN, by the trip's host (the server holds
  // that: POST …/tiles/cut). The host's card has "Try again"; anybody else's says who can.
  // What the server answered is said under the sentence, in the server's own words when it
  // refused. `again` is this screen's: null (not asked), "asking", or the words that came back.
  let again = null;
  const WHERE_WORDS = "Say where this trip is and its map gets made.";
  const hostId = () => { const t = store.trip(); return (t && t.host_id) || ""; };
  const amHost = () => { const me = store.me(); return !!hostId() && !!me && me.id === hostId(); };
  const whoCan = () => {
    const h = (store.members() || []).find((x) => x && x.id === hostId());
    return h && h.name ? `${h.name} hosts this trip and can ask for it to be made again.` : "The trip's host can ask for it to be made again.";
  };
  async function askAgain() {
    if (again === "asking") return;
    again = "asking"; paintNote();
    let res = null, body = null;
    try {
      res = await fetchWithin(store.tripApi("/tiles/cut"), { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" });
      body = await res.json().catch(() => null);
    } catch { res = null; }
    if (S.dead) return;
    if (!res) again = "No signal. Try again when there is some.";
    else if (res.ok && body && body.asked) {
      // The same sentence, should it fail again, is a new thing to say: its "OK" is forgotten.
      say({ note: "" });
      again = "Asked. It comes by itself, usually within a few minutes.";
      store.refresh();
    } else again = (body && typeof body.reason === "string" && body.reason) || `The map couldn't be asked for (the server answered ${res.status}). Try again in a moment.`;
    paintNote();
  }
  function noteNow() {
    const m = mapState();
    const mine = said();
    const last = keepState(TRIP);
    const lastIs = (what) => !!last && last.version === m.version && last.archive === what;
    // An answer belongs to the failure it was given about: a map on its way, or made, ends it.
    if (m.state !== "failed" && again !== "asking") again = null;
    if (m.ready && keptVersion !== undefined && keptVersion !== m.version && mine.keep !== m.version && mine.skip !== m.version) {
      const acts = [["keep", "Keep it"], ["skip", "Not now"]];
      if (m.bytes > MAX_STASH_BYTES) return { kind: "keep", words: `This trip's map is ${mb(m.bytes)}. Keep it on this phone, for when there is no signal?`, acts, version: m.version };
      // Within the budget, and still not kept without a word: this browser is set to save data.
      if (lastIs("asks")) return { kind: "keep", words: `This browser is set to save data. Keep this trip's map (${mb(last.bytes || m.bytes)}) on this phone, for when there is no signal?`, acts, version: m.version };
    }
    if (m.ready && lastIs("no-room") && mine.room !== m.version) {
      return { kind: "room", words: roomWords(last.bytes || m.bytes), acts: [["ok", "OK"]], put: { room: m.version } };
    }
    if (m.state === "cutting" && !m.ready) { S.sawCut = true; return { kind: "cutting", words: "The map of this trip is being made. It comes by itself, usually within a few minutes.", acts: [] }; }
    if (m.ready && S.sawCut && !S.drawn && navigator.onLine && webglOk() && !S.glDead) return { kind: "arriving", words: "The map of this trip is made. It is on its way to this screen.", acts: [] };
    if (!m.ready && m.state === "none" && store.trip() && !mine.where && store.mapsMade() !== false
      && !(store.areas() || []).some((a) => a && !a.parent && a.west != null)) {
      return { kind: "where", words: WHERE_WORDS, more: navigator.onLine ? "" : "That needs signal.", acts: [["where", "Say where"], ["ok", "OK"]], put: { where: 1 } };
    }
    const key = `${m.state}:${m.version}:${m.note}`;
    if (m.state === "failed" && mine.note !== key) {
      const words = m.note || (m.ready ? "A new map of this trip couldn't be made. The one before it is still here." : "The map of this trip couldn't be made.");
      if (again === "asking") return { kind: "failed", words, more: "Asking for it to be made again…", acts: [] };
      // Not while a map the host uploaded is the one in use: asking again would replace it
      // (the server's rule for a cut asked for by hand), and nobody pressing "Try again" means that.
      if (m.ready && m.source === "upload") return { kind: "failed", words, acts: [["ok", "OK"]], put: { note: key } };
      if (amHost()) return { kind: "failed", words, more: again || "", acts: [["again", "Try again"], ["ok", "OK"]], put: { note: key } };
      return { kind: "failed", words, more: whoCan(), acts: [["ok", "OK"]], put: { note: key } };
    }
    if (m.note && m.state !== "failed" && mine.note !== key) return { kind: "note", words: m.note, acts: [["ok", "OK"]], put: { note: key } };
    return null;
  }
  let noteKey = "";
  function paintNote() {
    const n = noteNow();
    const sig = n ? `${n.kind}|${n.words}|${n.more || ""}|${n.acts.map(([a]) => a).join()}` : "";
    if (sig === noteKey) return;
    noteKey = sig;
    if (!n) { noteEl.hidden = true; noteEl.innerHTML = ""; noteEl.removeAttribute("data-kind"); return; }
    noteEl.dataset.kind = n.kind;
    noteEl.innerHTML = `<p class="mp-note-t">${esc(n.words)}</p>` +
      (n.more ? `<p class="mp-note-more">${esc(n.more)}</p>` : "") +
      (n.acts.length ? `<div class="mp-note-acts">${n.acts.map(([a, w], i) => (a === "where"
        // A way to another page is a link, and goes there by itself.
        ? `<a class="btn ds-button ds-button--white" href="/trips/${encodeURIComponent(TRIP)}#where" data-note="where">${w}</a>`
        : `<button type="button" class="btn ds-button ${a === "keep" ? "ds-button--white" : "ds-button--gray"}" data-note="${a}">${w}</button>`)).join("")}</div>` : "");
    noteEl.hidden = false;
  }
  noteEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-note]");
    if (!b) return;
    const n = noteNow();
    if (!n) return;
    if (b.dataset.note === "keep") { say({ keep: n.version }); paintNote(); keepMap({ tripId: TRIP, tiles: () => store.tiles(), again: true }); }
    else if (b.dataset.note === "skip") { say({ skip: n.version }); paintNote(); }
    else if (b.dataset.note === "ok") { say(n.put); again = null; paintNote(); }
    else if (b.dataset.note === "again") askAgain();
  });

  let ml = null, bm = null;
  let bootingTiles = false;
  // One try per answer: an archive that would not open is not asked for again on every
  // change of the trip, only when the trip's answer about its map changes.
  let archiveTried = false;

  function buildStyle() {
    return {
      version: 8,
      glyphs: GLYPHS_URL,
      sources: { proto: { type: "vector", url: `pmtiles://${sharedKey || ARCHIVE_URL}` } },
      // The basemap's layers without its points of interest, its highway shields and its
      // icons: map-keep.js, which keeps the fonts these layers draw with.
      layers: styleLayers(bm, resolvedLum()),
    };
  }

  // The ground with no archive behind it: one background layer in the app's own --ground, so
  // MapLibre has something valid to render while the canvas above paints the plates and the
  // graticule. A style with no sources cannot fail, which is the point — the map is up, and
  // gestures work, before anything has been fetched.
  function plainStyle() {
    return {
      version: 8,
      sources: {},
      layers: [{ id: "ground", type: "background", paint: { "background-color": palette.ground } }],
    };
  }

  function applyStyle() {
    try {
      S.map.setStyle(S.tiles ? buildStyle() : plainStyle());
    } catch { killGl(); }
  }

  // Tiles off, engine intact: the drawn ground comes back and the map keeps its gestures.
  function killTiles() {
    S.tiles = false;
    scrim.hidden = true;
    if (S.map && !S.glDead) { try { S.map.setStyle(plainStyle()); } catch { killGl(); } }
    schedule();
  }

  // Engine off: MapLibre is gone and the flat view takes the camera back, with the camera it
  // was holding. Rotation and pitch go with it, so the camera is levelled on the way out.
  function killGl() {
    if (S.glDead) return;
    S.glDead = true;
    S.tiles = false;
    scrim.hidden = true;
    let cam = S.cam;
    try { cam = view.cam(); } catch { /* the map is already gone */ }
    if (S.map) { try { S.map.remove(); } catch { /* already gone */ } S.map = null; }
    surface.append(scrim, canvas, layer);
    glHost.replaceChildren();
    root.dataset.engine = "flat";
    view = makeFlatView();
    flatGestures(true);
    S.cam = { lng: cam.lng, lat: cam.lat, zoom: cam.zoom, bearing: 0, pitch: 0 };
    paintNeedle();
    clusterAt = null;
    schedule();
    paintNote();                          // no streets are coming on this engine: no "on its way"
  }

  function loadGlCss() {
    const ID = "mp-gl-css";
    let node = document.getElementById(ID);
    if (node && node.dataset.done) return Promise.resolve();
    if (!node) {
      node = document.createElement("link");
      node.id = ID;
      node.rel = "stylesheet";
      node.href = "/vendor/maplibre/maplibre-gl.css";
      document.head.append(node);
    }
    return new Promise((res) => {
      const done = () => { node.dataset.done = "1"; res(); };
      node.addEventListener("load", done, { once: true });
      node.addEventListener("error", done, { once: true });   // proceed; worst case is ugly
      setTimeout(done, 4000);
    });
  }

  // ── the handover ──────────────────────────────────────────────────────────────────────
  // MapLibre is created with the camera the flat view is holding, then given the gestures:
  // our pointer handlers come off in the same tick that its own go on, so there is never a
  // frame with two gesture systems over one canvas.
  //
  // The marker layer and the ink canvas move INSIDE map.getCanvasContainer(). That element is
  // where MapLibre binds touchstart/touchmove/mousedown, so a drag that begins on one of our
  // pins bubbles into its handlers and pans the map — the same deal MapLibre's own Markers
  // get. Leaving them outside is what made the pins eat gestures.
  async function bootGl() {
    if (S.dead || !webglOk()) return;
    try {
      const [mlMod, bmMod] = await Promise.all([
        import("/vendor/maplibre/maplibre-gl.mjs"),
        import("/vendor/basemaps/basemaps.mjs"),
      ]);
      if (S.dead) return;
      ml = mlMod; bm = bmMod;

      // MapLibre positions its canvas from its own stylesheet. Loading it lazily keeps 83 KB
      // of CSS off the other screens, and the load is awaited because a Map created before
      // those rules apply measures its container wrong and never recovers.
      await loadGlCss();
      if (S.dead) return;

      const map = new ml.Map({
        container: glHost,
        style: plainStyle(),
        center: [S.cam.lng, S.cam.lat],
        zoom: S.cam.zoom,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        maxPitch: MAX_PITCH,
        // MapLibre handles pan, pinch-zoom, two-finger rotate and
        // two-finger pitch, with its own inertia and its own touch bookkeeping.
        interactive: true,
        dragPan: true,
        dragRotate: true,
        touchZoomRotate: true,
        touchPitch: true,
        doubleClickZoom: true,
        scrollZoom: true,
        keyboard: true,
        boxZoom: false,
        // A tiny snap so a two-finger twist that lands within 4 degrees of north settles ON
        // north instead of one degree off it forever.
        bearingSnap: 4,
        attributionControl: false, // the credit lives in Settings, not on the map
        fadeDuration: 0,
        // A trip can lie across the 180° line (Fiji, the Aleutians). Without the world's
        // copies MapLibre stops the camera at the line and draws nothing beyond it: half
        // the trip. The pins and plates are already placed nearest the camera (project()).
        renderWorldCopies: true,
        refreshExpiredTiles: false,
        trackResize: false,        // our ResizeObserver already calls resize()
        maxTileCacheSize: 64,
      });
      S.map = map;
      map.resize();

      // A debug handle. Not used by the app; it is how a harness reads the map's own style
      // and camera rather than assuming them because nothing threw.
      try { window.__wgpMap = map; } catch { /* no window */ }

      // Our overlays move into the element MapLibre listens on. Order matters: scrim, then
      // the ink canvas, then the pins, all above its canvas.
      const cc = map.getCanvasContainer();
      cc.append(scrim, canvas, layer);

      view = makeGlView(map);
      flatGestures(false);
      root.dataset.engine = "gl";
      // One frame per camera change, which under a drag is one frame per frame and on an idle
      // map is none at all. placeOverlay() is deliberately SYNCHRONOUS here; the
      // long note on the draw loop says why. schedule() still queues the ground and the scale.
      map.on("move", () => {
        if (S.dead || S.detached) return;
        S.cam = view.cam();
        paintNeedle();
        placeOverlay();
        schedule();
      });
      map.on("movestart", (e) => { if (e && e.originalEvent) S.follow = false; });
      // Under GL the pins are DOM inside MapLibre's own canvas container, so a tap on one
      // bubbles here as well; the fan must not fold on the tap that was aimed at a pin in it.
      map.on("click", (e) => {
        const t = e && e.originalEvent && e.originalEvent.target;
        if (t && t.closest && t.closest(".mp-pin,.mp-cluster,.mp-hub")) return;
        closeSpider();
      });
      map.on("moveend", () => {
        if (S.dead) return;
        S.cam = view.cam();
        if (cameraSet) { lastCam = S.cam; saveCam({ ...S.cam, auto: !!(autoCam && sameCam(S.cam, autoCam)), sheetH: S.sheetH }); }     // see camChanged()
        resortList();
        schedule();
      });
      map.on("error", (e) => {
        const msg = String((e && e.error && e.error.message) || "");
        // Glyph 404s only cost the labels; every fill and line still renders, and label-free
        // streets under our own pins are a perfectly good basemap.
        if (/glyph|font/i.test(msg)) return;
        // After the tiles are up, a failed range is usually the signal dropping mid-pan;
        // tearing the layer down for one of those would make the map flicker in and out at
        // the edge of coverage.
        if (!S.tiles || ++S.glErrors >= GL_ERROR_BUDGET) {
          console.warn("[map] tiles off:", msg || e);
          killTiles();
        }
      });
      paintNeedle();
      measure();
      schedule();

      // Now, and only now, the archive. The map is already on screen and already handling
      // touch; tiles are an upgrade to the ground, not a precondition for the map.
      bootTiles();
    } catch (e) {
      // No WebGL2, a blocked worker, a module that never arrived offline: they all mean the
      // flat engine keeps the map, which is a working map.
      console.info("[map] flat engine:", (e && e.message) || e);
      root.dataset.engine = "flat";
    }
  }

  async function bootTiles() {
    if (S.dead || !S.map || S.glDead || S.tiles || bootingTiles) return;
    // A trip with no offline map draws its own ground, and asks the server for nothing.
    if (!hasArchive()) return;
    bootingTiles = true;
    archiveTried = true;
    try {
      const pmMod = await import("/vendor/pmtiles/pmtiles.mjs");
      if (S.dead || !S.map) return;
      if (!sharedProtocol) sharedProtocol = new pmMod.Protocol();
      if (!protoRegistered) { ml.addProtocol("pmtiles", sharedProtocol.tile); protoRegistered = true; }

      if (!sharedArchive) {
        const now = mapState();
        const kept = await lookKept();
        if (S.dead || !S.map) return;
        // The copy on the phone when it is the map the trip has now, or when there is no
        // signal to read a newer one by (yesterday's map beats no map). Else the network.
        const current = isCurrent(kept, now);
        const useKept = kept && (current || !navigator.onLine);
        const version = useKept ? (current ? now.version : (kept.version || "")) : now.version;
        const key = archiveAt(version);
        const src = useKept ? new BlobSource(kept.blob, key)
          : (navigator.onLine ? new pmMod.FetchSource(key) : null);
        // No cached archive and no network: there are no tiles to be had. The drawn ground is
        // already on screen and correct, so this is a return, not an error.
        if (!src) return;
        const p = new pmMod.PMTiles(src);
        // Read the header BEFORE the style asks for a tile. A missing, truncated or
        // non-pmtiles file throws here, and the only consequence is that the ground stays
        // drawn rather than a half-built basemap firing errors at somebody.
        await p.getHeader();
        if (S.dead || !S.map) return;
        sharedArchive = p;
        sharedKey = key;
        sharedVersion = version;
        sharedProtocol.add(p);
      }
      paintNote();

      S.map.once("styledata", () => {
        if (S.dead) return;
        S.tiles = true;
        scrim.hidden = false;
        schedule();
      });
      S.map.setStyle(buildStyle());
      S.map.once("idle", () => { if (S.dead) return; S.drawn = true; paintNote(); });

      // Only once the visible map has settled — the stash is a background nicety and must
      // never compete for bandwidth with the tiles somebody is looking at right now.
      S.map.once("idle", () => { setTimeout(() => { if (!S.dead) stashArchive(); }, 4000); });
    } catch (e) {
      console.info("[map] rendering without tiles:", (e && e.message) || e);
      S.drawn = true;                        // nothing more is coming: the card says no more
      killTiles();
    } finally {
      bootingTiles = false;
    }
  }

  // ── go ────────────────────────────────────────────────────────────────────────────────
  // Once per session, not once per mount. The GL boot waits for the FIRST claim, because
  // MapLibre measures its container at construction and a container that is not in the
  // document measures nothing — but it happens once and never again, which is the whole of
  // Keeping it alive means the second visit finds the context, the style and the tiles already in hand.
  let booted = false;
  readPlaces();
  paintNote();
  renderSheet();        // before measure(), so insets() sees the sheet's real height
  paintNeedle();

  // ── attach / detach ───────────────────────────────────────────────────────────────────

  // Take the session onto a host element. Cheap by construction: one re-parent, one measure,
  // one repaint. Nothing here creates a map, reads a pmtiles header or fetches a tile.
  function claim(nextHost, o = {}) {
    if (S.dead) return 0;
    host = nextHost;
    // Bare or not is the claim's own: the next host (Places' map face on a phone) has its sheet back.
    S.bare = !!o.bare;
    S.onPick = typeof o.onPick === "function" ? o.onPick : null;
    root.dataset.bare = S.bare ? "1" : "";
    if (S.bare) setSheet("shut");
    scroller = bleed ? null : (host.closest(".rt-pane, #view") || null);   // in two panes, its pane
    S.detached = false;
    // A fresh host means fresh edges; see fitShell().
    shellTop = null; shellBottom = null;
    root.style.top = ""; root.style.bottom = "";
    host.append(root);

    ro.disconnect();
    ro.observe(host);
    ro.observe(sheet);
    if (scroller) { ro.observe(scroller); scroller.addEventListener("scroll", onHostScroll, { passive: true }); }

    if (o.filter != null) applyFilter(o.filter);
    measure();
    initialCamera();
    clusterAt = null;
    // The canvas the GL context last composited is still valid, but the browser may have
    // released the drawing buffer while the element was out of the tree; one repaint of an
    // unchanged camera is cheaper than any part of a rebuild and guarantees a painted frame.
    if (S.map && !S.glDead) {
      try { S.map.resize(); S.map.triggerRepaint(); } catch { /* torn down */ }
    }
    if (view.kind === "flat") flatGestures(true);
    placeOverlay();      // pins on screen in this task, not in the next frame
    schedule();
    maybeAutoGeo();      // the watch was stopped on release; restart it only now
    if (!booted) { booted = true; bootGl(); }
    settleSoon();        // the host may still be moving into place: see settleSoon()
    return ++gen;
  }

  // ── picking a spot ────────────────────────────────────────────────────────────────────
  // The session is lent to the picker's host and given back. What it is given back TO is the
  // host that had it, with that host's own token: its handle goes on working as if nothing
  // had happened, and the camera is where it left it.
  const PICK_ZOOM = 16;
  let picking = null;        // { token, prev: { host, token } | null, cam }
  function pickStart(el, o = {}) {
    if (S.dead) return 0;
    if (picking) pickEnd(picking.token);
    const prev = host && !S.detached ? { host, token: gen } : null;
    const cam = prev ? { ...S.cam } : null;
    root.dataset.pick = "1";
    pickPin.hidden = false;
    const token = claim(el, {});
    picking = { token, prev, cam };
    measure();
    const lat = Number(o.lat), lng = Number(o.lng);
    if (o.lat != null && o.lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
      view.jumpTo({ lng, lat, zoom: Math.max(S.cam.zoom || 0, PICK_ZOOM), bearing: 0, pitch: 0 }, { quiet: true });
    } else if (o.box && boundsOf(o.box)) {
      const b = boundsOf(o.box);
      const fit = fitTo([{ lng: b.west, lat: b.north }, { lng: b.west + widthOf(b), lat: b.south }], { top: 12, right: 12, bottom: 12, left: 12 });
      if (fit) view.jumpTo({ ...fit, bearing: 0, pitch: 0 }, { quiet: true });
    }
    schedule();
    return token;
  }
  // The spot under the pin: the middle of the map.
  function pickSpot() {
    const c = view.unproject(S.w / 2, S.h / 2);
    let lng = ((c.lng + 180) % 360 + 360) % 360 - 180;
    if (lng === -180 && c.lng > 0) lng = 180;
    return { lat: clampLat(c.lat), lng };
  }
  // The picker's keys and buttons: the map moved by so many pixels, or zoomed by so many
  // levels about the pin. (Fingers and the mouse move it through the map's own gestures.)
  function pickMove(dx, dy) {
    if (!picking || S.dead) return;
    const c = view.unproject(S.w / 2 + dx, S.h / 2 + dy);
    view.jumpTo({ lng: wrapLng(c.lng), lat: clampLat(c.lat) });
    schedule();
  }
  function pickZoom(dz) {
    if (!picking || S.dead) return;
    const c = pickSpot();
    easeTo({ lng: c.lng, lat: c.lat, zoom: clamp((S.cam.zoom || 0) + dz, MIN_ZOOM, MAX_ZOOM) }, 180);
  }
  function pickEnd(token) {
    if (!picking || picking.token !== token) return;
    const { prev, cam } = picking;
    picking = null;
    delete root.dataset.pick;
    pickPin.hidden = true;
    if (S.dead) return;
    if (prev && prev.host.isConnected) {
      claim(prev.host, {});
      gen = prev.token;                       // the host that had the map owns it again
      if (cam) view.jumpTo(cam, { quiet: true });
      schedule();
    } else {
      release(gen);
    }
  }

  // Hand the session back. Everything that costs the device while nobody is looking stops;
  // everything that costs time to rebuild stays. Note what is NOT here: map.remove(), the
  // marker cache, the abort controller, the theme observer and the store subscription all
  // survive, so a detached session keeps its data fresh and its tiles decoded.
  function release(token) {
    if (S.dead || token !== gen) return;   // a newer claim already owns it — see the header
    S.detached = true;
    view.stop();
    if (cameraSet) saveCam(S.cam, true);   // force past the throttle: the camera we will come back to
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    clearTimeout(settleTimer);
    clearTimeout(restTimer);
    stopGeo();                 // the GPS radio must not stay on for a view nobody is looking at
    ro.disconnect();
    clearTimeout(settleTimer2);
    if (scroller) scroller.removeEventListener("scroll", onHostScroll);
    root.remove();
    host = null;
    scroller = null;
  }

  // The real teardown, for the cases mountMap() cannot re-use a session at all: a different
  // store, a different bleed mode. Nothing in the app reaches it today.
  function dispose() {
    if (S.dead) return;
    release(gen);
    S.dead = true;
    S.abort.abort();
    unhearKeep();
    flatGestures(false);
    offChange();
    offNav();
    removeEventListener("hashchange", readUrl);
    removeEventListener("orientationchange", onResize);
    mqDark.removeEventListener("change", onTheme);
    themeObs.disconnect();
    if (S.map) { try { S.map.remove(); } catch { /* already gone */ } S.map = null; }
    S.markers.clear();
    root.remove();
  }

  return {
    root,
    bleed,
    store,
    get disposed() { return S.dead; },
    claim,
    release,
    dispose,
    pickStart,
    pickSpot,
    pickMove,
    pickZoom,
    pickEnd,
    owns: (token) => !S.dead && token === gen,
    setFilter: (f) => applyFilter(f),
    select: (id, o) => select(id, o || { center: true }),
  };
}

// The router's form. #/map REDIRECTS to Places: the map renders inside Places, so
// a standalone address — an old bookmark, a stale history entry — forwards to the same map
// under the Places head. Deferred one task: router.replace() re-enters handle(), and calling
// it synchronously from inside a mount lands a second navigation over an unfinished one
// (the same hazard places.js documents on its syncUrl()).
export default function mount(el, ctx) {
  const t = setTimeout(() => ctx.router.replace("#/places?view=map"), 0);
  return () => clearTimeout(t);
}

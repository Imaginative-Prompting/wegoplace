// collage-video.js — video playing IN PLACE on the collage canvas.
//
// The rule this file exists for: on the collage board a video is not a poster with a play
// button, it is a moving picture pinned to the surface, looping a few seconds of itself.
// This file is the only thing in the app that owns live <video> elements on that board.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE CONTRACT — what collage.js calls, and nothing else
// ─────────────────────────────────────────────────────────────────────────────────────────
//
//   import { createVideoPool, VIDEO_POOL_SIZE, segmentFor } from "./collage-video.js";
//
//   const pool = createVideoPool({ container: cameraViewportEl });
//
//   // when a video LayoutItem enters the virtualized set and has a live node:
//   pool.attach(item, mediaBoxEl);
//   // when that node is recycled or the item leaves the virtualized set:
//   pool.detach(item.id);
//   // after the camera moves (safe to call every frame — it self-throttles):
//   pool.update();
//   // view hidden / a sheet took over / the Memories viewer opened on top:
//   pool.pause();   pool.resume();
//   // view unmount:
//   pool.destroy();
//
//   pool.setViewport(fnOrRect);   // if "on screen" is not the container's own rect
//   pool.stats();                 // counters — see below, this is what verification reads
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// TWO WAYS TO DRIVE IT, AND collage.js ALREADY PICKED ONE
// ─────────────────────────────────────────────────────────────────────────────────────────
// collage.js's mount option `video` wants { update(list), pause(), resume(), release(node),
// destroy() }, where `list` is [{ id, item, node, shot, poster }] already ranked
// nearest-the-centre-first and already capped at its own videoBudget, published only when the
// SET changes. That object is exactly this pool, unmodified:
//
//   const pool = createVideoPool({ container: root });
//   mountCollage(el, { ..., video: pool });
//
//   * PUSHED — `update(list)` with an array. The renderer owns ranking; it has the layout
//     index and can answer "which videos are nearest the centre" without touching the DOM,
//     which is strictly cheaper than measuring rects. The pool stops ranking and simply
//     honours the list in order. This is the mode the app runs in.
//   * SELF-MEASURING — `update()` with no argument, plus attach()/detach(). The pool ranks
//     candidates itself off getBoundingClientRect(), which is correct under any camera
//     convention and needs no layout index. This is the mode the standalone tests run in and
//     the mode anything else embedding a board should use.
//
// Both modes share every rule below; only who decides the ordering differs. The first
// `update(list)` switches the pool to pushed mode for good.
//
// Interop details that matter, all of them one-liners:
//   * `release(node)` takes the ITEM node, and unbinds whichever candidate lives inside it.
//   * The mount element carries `data-live="1"` while a video is actually painting there, so
//     the renderer's own `.cg-play` disc can hide itself in CSS with no JS coupling
//     (public/css/collage.css fades it out once `[data-live="1"]` is on, and back when it goes).
//   * `playAffordance: "auto"` (the default) means: do not draw a play button in a box that
//     already contains a `.cg-play`. The renderer draws one for every video item; two would
//     be a bug, and one is the requirement.
//
// createVideoPool options, all optional except in the sense that the defaults are the policy:
//   container       the collage viewport element (default document.documentElement). Used for
//                   the viewport rect and to hear the first user gesture.
//   poolSize        override VIDEO_POOL_SIZE. Do not raise it without a real-iPhone measurement.
//   viewport        () => DOMRect | DOMRect — where "on screen" is.
//   playAffordance  default true; set false to own the play gesture in the renderer instead.
//   onChange        (stats) => void, fired when assignment changes. Telemetry only.
//   debug           console.warn on contract violations and platform refusals.
//
// pool.stats() returns:
//   poolSize created live playing peakLive assigned[] attached swaps blocked
//   autoplayRefused affordances reducedMotion suspended hidden
// `created` and `peakLive` are the two numbers that prove the decoder cap: BOTH are <=
// poolSize for the life of the pool, by construction rather than by luck.
//
// `segmentFor(item, durationSeconds)` is exported and pure: it is the deterministic answer to
// "which seconds does this clip loop", and it is what collage-export.js should call if a
// still of a video item ever needs to name a frame.
//
// `item` is a LayoutItem from collage-layout.js. This file reads:
//
//   id           stable identity; the handle for detach()
//   kind         must be 'video' — anything else is ignored, loudly in debug
//   origUrl      THE VIDEO SOURCE. There is no mid tier for video: the media API serves a
//                client-made webp poster and the 4K original, so playback is always the
//                original, streamed over Range. (functions/media/[[path]].js does real 206s.)
//   thumbUrl     the poster. Same webp the renderer already paints under us.
//   loopStartMs  optional, from the layout — the in point
//   loopMs       optional, from the layout — the segment length
//   durationMs   optional; if the layout knows it we skip a metadata round trip for the
//                segment maths and only correct it once real metadata lands
//   mediaId      optional; used (with id) as the deterministic hash key for the fallback
//                segment offset, so a board picks the same seconds every session
//
// `mediaBoxEl` is the element that BOXES the media — the same box the poster fills. The
// pool inserts an absolutely positioned <video> into it and removes it again on release, so
// the renderer's poster is what shows whenever no pool element is assigned. If that element
// computes to `position: static` the pool sets `position: relative` on it and restores the
// inline value on detach; that is the only style this file writes on a renderer node.
//
// Everything else — layout, frames, LOD for photos, gestures, virtualization — is somebody
// else's file. This one never reads the camera transform and never does layout maths: it
// ranks candidates off getBoundingClientRect(), which is true under any camera convention.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY A POOL, AND WHY IT IS A CAP AND NOT A BUDGET
// ─────────────────────────────────────────────────────────────────────────────────────────
// iOS hard-caps the number of concurrently decoding <video> elements (historically 1 on
// iPhone, ~4-16 on modern iOS/iPadOS depending on codec and resolution), and it DOES NOT
// FAIL GRACEFULLY past it: play() rejects, or worse, previously-playing elements silently
// go black or freeze on their last frame while the page keeps insisting they are playing.
// There is no API to ask how many you may have. So the number is ours, it is small, and it
// is enforced by construction: makeSlot() is the only place a <video> is ever created and it
// refuses past VIDEO_POOL_SIZE. Recycling means changing .src on an element we already own —
// which is why the cap holds no matter how far the camera pans.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THE LOOP DOES NOT FLASH BLACK
// ─────────────────────────────────────────────────────────────────────────────────────────
// Four independent things, because one is not enough:
//
//  1. We never let the element reach `ended`. The out point is clamped to duration minus
//     END_GUARD_S, and we seek back SEEK_LEAD_S before it, driven by requestVideoFrameCallback
//     (frame-accurate) rather than `timeupdate` (~250ms granularity — coarse enough to sail
//     past the end of a short clip).
//  2. `loop = true` is left ON as a pure safety net. It is not what makes the segment loop,
//     but if our seek ever misses, the browser's own wrap is still frame-continuous, where
//     an `ended` element paints its poster or black.
//  3. A seek on an already-playing element keeps painting the last decoded frame until the
//     new one arrives. What paints black is `load()` / clearing `src` / hitting `ended` —
//     so those happen only on RELEASE, when the element is already hidden.
//  4. The renderer's poster stays under the video the whole time and the video is only made
//     visible once a real frame has been presented (rVFC, or 'playing' + 'seeked', or a
//     REVEAL_TIMEOUT_MS backstop). A recycled element therefore goes poster -> live frame,
//     never poster -> black -> live frame.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// BATTERY
// ─────────────────────────────────────────────────────────────────────────────────────────
// Four trek days with no charging. Nothing decodes that is not on screen: leaving the
// viewport pauses instantly, and RELEASE_IDLE_MS later the element gives its decoder back.
// visibilitychange and pagehide pause everything. destroy() releases everything. The rank
// pass costs one batched read of a handful of rects, at most every RANK_MIN_MS.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// prefers-reduced-motion
// ─────────────────────────────────────────────────────────────────────────────────────────
// No autoplay at all — not "slower", none. Each attached video gets a >=48px play button over
// its poster (a real <button>, an accessible name, a glyph and a ring, so it is
// shape and not hue); pressing it borrows a pool element, plays the segment ONCE and then
// hands the decoder back, leaving the poster and the button. Watching a whole clip is the
// Memories viewer's job, which is where the renderer's tap already goes.
//
// The same affordance covers a PLATFORM REFUSAL. iOS Low Power Mode rejects even muted
// autoplay, and that refusal is document-wide, so the first NotAllowedError puts the WHOLE
// board on play buttons rather than only the two or three items nearest the middle. The next
// real gesture inside the collage lifts it and the board comes alive. A board that silently
// shows posters with no way to play them is exactly the failure that must not ship.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// STYLING
// ─────────────────────────────────────────────────────────────────────────────────────────
// This file injects one small <style id="cgv-style"> and owns no .css file: collage.css
// belongs to the renderer role and a stylesheet two agents edit is a merge conflict the night
// before a flight. Everything is prefixed .cgv- and built from the app's own tokens
// (--on-shot / --on-shot-veil, which are declared once in bare :root on purpose because what
// sits behind them is a photograph, not a themed surface).

import { reducedMotion } from "./motion.js";

// ── tunables, all in one place ───────────────────────────────────────────────────────────

/**
 * How many <video> elements may exist at once. START AT 3.
 *
 * iOS hard-caps concurrent video decoders and does not fail gracefully past the cap: play()
 * rejects, or already-playing elements go black/freeze while still reporting they play. The
 * cap is not discoverable at runtime, so this constant IS the policy. Three is chosen to sit
 * under the worst credible device limit while still reading as "the board is alive".
 * Raise it only against a measurement on a real iPhone, never because a desktop coped.
 */
export const VIDEO_POOL_SIZE = 3;

/** Ranking is a layout read; 8Hz is plenty for deciding which three videos are nearest. */
const RANK_MIN_MS = 120;

/** A slot may not change item more often than this — a fast pan must not thrash decoders. */
const SWAP_COOLDOWN_MS = 450;

/** A challenger must beat an incumbent by this many screen px to take its slot. */
const HYSTERESIS_PX = 64;

/** Paused-and-off-screen this long and the element hands its decoder back. */
const RELEASE_IDLE_MS = 2500;

/** Default segment length when the layout does not specify one. */
const DEFAULT_LOOP_MS = 4000;
/** Never loop something shorter than this; below it a loop reads as a glitch. */
const MIN_LOOP_MS = 1200;

/** Out point stays this far from the true end so `ended` can never fire. */
const END_GUARD_S = 0.12;
/** Seek back this early, so the seek is issued before the guard is reached. */
const SEEK_LEAD_S = 0.06;

/** Backstop for revealing the video if no frame callback ever arrives. */
const REVEAL_TIMEOUT_MS = 700;

const STYLE_ID = "cgv-style";

// ── tiny helpers ─────────────────────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// FNV-1a. Deterministic, no Math.random anywhere in this file: the same media picks the same
// seconds every session, which is the same rule the layout seed lives by.
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The segment for an item, in seconds. Layout values win; otherwise a deterministic offset
 * 8%-32% into the clip (past the shaky first moment, before the pocket shot at the end).
 * Returns { start, out, len }. `out` is Infinity only for an unknown/streaming duration,
 * where native `loop` is the whole behaviour.
 */
export function segmentFor(item, durationSec) {
  const d = num(durationSec);
  const startMs = num(item && item.loopStartMs);
  const lenMs = num(item && item.loopMs);

  if (d === null || !(d > 0) || !Number.isFinite(d)) {
    return { start: Math.max(0, (startMs || 0) / 1000), out: Infinity, len: Infinity };
  }

  const guard = Math.min(END_GUARD_S, d * 0.05);
  const usable = Math.max(0, d - guard);

  let len = lenMs !== null ? lenMs / 1000 : DEFAULT_LOOP_MS / 1000;
  len = clamp(len, Math.min(MIN_LOOP_MS / 1000, usable), Math.max(usable, 0.001));

  let start;
  if (startMs !== null) {
    start = clamp(startMs / 1000, 0, Math.max(0, usable - Math.min(len, usable)));
  } else {
    const room = Math.max(0, usable - len);
    const key = String((item && (item.mediaId || item.id)) || "");
    const phase = (hash32(key) % 1000) / 1000;          // deterministic in [0,1)
    start = Math.min(room, d * (0.08 + 0.24 * phase));
  }

  let out = Math.min(start + len, usable);
  if (out - start < Math.min(MIN_LOOP_MS / 1000, usable)) {
    start = Math.max(0, usable - len);
    out = usable;
  }
  return { start, out, len: out - start };
}

// ── the one injected stylesheet ──────────────────────────────────────────────────────────
// This file owns no .css: public/css/collage.css belongs to the renderer role, and a
// stylesheet two agents edit is a merge conflict waiting for the night before the flight.
// Everything here is prefixed .cgv- and uses the app's own tokens, so it themes correctly
// in both directions with no colour declared only inside a media query.
function ensureStyle(doc) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.cgv-v{position:absolute;inset:0;width:100%;height:100%;display:block;object-fit:cover;
  background:transparent;pointer-events:none;border-radius:inherit;
  visibility:hidden;opacity:0;transform:translateZ(0)}
.cgv-v[data-live="1"]{visibility:visible;opacity:1}
.cgv-play{position:absolute;left:50%;top:50%;margin:-24px 0 0 -24px;width:48px;height:48px;
  min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;
  padding:0;border:2px solid var(--on-shot,#fff);border-radius:50%;
  background:var(--on-shot-veil,rgba(10,8,6,.82));color:var(--on-shot,#fff);
  cursor:pointer;-webkit-appearance:none;appearance:none;line-height:0}
.cgv-play svg{width:20px;height:20px;display:block;fill:currentColor}
.cgv-play[data-press="1"]{transform:scale(.94)}
@media (hover: hover) and (pointer: fine){.cgv-play:active{transform:scale(.94)}}
@media (prefers-reduced-motion: reduce){
  .cgv-play:active,.cgv-play[data-press="1"]{transform:none}
}`;
  (doc.head || doc.documentElement).appendChild(s);
}

const PLAY_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M8 5.2v13.6a.8.8 0 0 0 1.22.68l11-6.8a.8.8 0 0 0 0-1.36l-11-6.8A.8.8 0 0 0 8 5.2Z"/></svg>';

// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * createVideoPool(options) -> pool
 *
 * options:
 *   container       Element. The collage viewport. Used for the default viewport rect and as
 *                   the place a first user gesture is heard (see the autoplay unlock below).
 *                   Defaults to document.documentElement.
 *   poolSize        Number. Override VIDEO_POOL_SIZE. Clamped to >= 1. Do not raise this
 *                   without a measurement on a real iPhone.
 *   viewport        () => DOMRect | DOMRect. Where "on screen" is. Defaults to the
 *                   container's rect intersected with the window.
 *   playAffordance  Boolean, default true. The reduced-motion / autoplay-refused play button.
 *                   Set false if the renderer wants to own that gesture itself.
 *   onChange        (stats) => void. Fires whenever assignment changes. Debug/telemetry only.
 *   debug           Boolean. console.warn on contract violations instead of silence.
 */
export function createVideoPool(options = {}) {
  const opts = options || {};
  const container =
    (opts.container && opts.container.nodeType === 1 ? opts.container : null) ||
    (typeof document !== "undefined" ? document.documentElement : null);
  const doc = container ? container.ownerDocument : (typeof document !== "undefined" ? document : null);
  const poolSize = Math.max(1, Math.floor(num(opts.poolSize) || VIDEO_POOL_SIZE));
  // true | false | "auto" (default). "auto" defers to a play affordance the renderer already
  // drew in the same box — see the interop note in the header.
  const affordanceMode = opts.playAffordance === undefined ? "auto" : opts.playAffordance;
  const debug = !!opts.debug;

  ensureStyle(doc);

  /** @type {Map<string, Cand>} attached candidates, keyed by LayoutItem id */
  const cands = new Map();
  /** @type {Slot[]} at most `poolSize`, created lazily, NEVER more. */
  const slots = [];

  let destroyed = false;
  let suspended = false;            // pause() from the renderer
  let hidden = doc ? doc.visibilityState === "hidden" : false;
  let unlocked = false;             // a user gesture has been seen in this container
  let autoplayRefused = false;      // the platform said no to muted autoplay, document-wide
  let rankQueued = false;
  let rankTimer = 0;
  let idleTimer = 0;
  let driven = false;               // a renderer has published a list; it owns the ranking
  let drivenWant = [];              // that list, as candidates, nearest-centre first
  let lastRank = 0;
  let swaps = 0;
  let peakLive = 0;
  let blockedCount = 0;

  const warn = (...a) => { if (debug) console.warn("[collage-video]", ...a); };

  // ── the candidate record ───────────────────────────────────────────────────────────────
  // One per attached video LayoutItem. Holds no <video>; a Slot lends it one.
  function Cand(item, el) {
    this.id = String(item.id);
    this.item = item;
    this.el = el;
    this.slot = null;
    this.btn = null;
    this.prevPosition = null;       // inline position we overwrote, restored on detach
    this.manual = false;            // played by an explicit press (reduced motion / blocked)
    this.blocked = false;           // muted autoplay was refused for this one
    this.dist = Infinity;
    this.visible = false;
  }

  // ── the pool element ───────────────────────────────────────────────────────────────────
  function Slot(el) {
    this.el = el;
    this.cand = null;
    this.since = 0;                 // when this slot last changed candidate
    this.idleAt = 0;                // when it went quiet with nothing on screen
    this.seg = null;                // { start, out, len }
    this.revealed = false;
    this.revealTimer = 0;
    this.rvfc = 0;                  // requestVideoFrameCallback handle
    this.playPending = false;       // a play() promise is in flight
    this.once = false;              // reduced-motion / manual: play the segment once
    this.gen = 0;                   // bumped on every (re)assign; stale callbacks check it
    this.metaListener = null;       // pending loadedmetadata handler, removed on release
  }

  // makeSlot is the ONLY place a <video> is constructed. The cap is enforced here, by
  // construction, so no code path anywhere can exceed it.
  function makeSlot() {
    if (slots.length >= poolSize) return null;
    const v = doc.createElement("video");
    // muted autoplay is the only autoplay iOS permits — and `muted` has to be set as a
    // PROPERTY before the first play(), not only as an attribute, or WebKit has been known
    // to evaluate the gesture requirement against an unmuted element.
    v.muted = true;
    v.defaultMuted = true;
    v.setAttribute("muted", "");
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("webkit-playsinline", "");     // iOS < 10 spelling, free to keep
    v.preload = "metadata";                        // per the brief: metadata, not auto
    v.setAttribute("preload", "metadata");
    v.controls = false;
    // Safety net only. The sub-range loop is driven by us; this exists so a missed seek
    // wraps frame-continuously instead of landing on `ended` (which paints poster/black).
    v.loop = true;
    v.disableRemotePlayback = true;                // do not offer this to AirPlay
    v.setAttribute("disableremoteplayback", "");
    v.className = "cgv-v";
    v.tabIndex = -1;
    v.setAttribute("aria-hidden", "true");         // decorative motion over an already-labelled poster
    const s = new Slot(v);
    v.addEventListener("playing", () => onPlaying(s));
    v.addEventListener("seeked", () => onSeeked(s));
    v.addEventListener("timeupdate", () => tick(s));   // coarse third line of defence
    v.addEventListener("error", () => onError(s));
    v.addEventListener("ended", () => onEnded(s));
    slots.push(s);
    return s;
  }

  const freeSlot = () => slots.find((s) => !s.cand) || (slots.length < poolSize ? makeSlot() : null);

  // ── autoplay unlock ────────────────────────────────────────────────────────────────────
  // iOS Low Power Mode refuses muted autoplay outright. The first real user gesture inside
  // the collage lifts that for the rest of the session, so we listen for one and retry.
  function onGesture() {
    if (unlocked && !autoplayRefused) return;
    unlocked = true;
    // A gesture is exactly what the policy was waiting for, so lift the refusal and let the
    // board come alive rather than leaving play buttons on items that can now simply play.
    if (!reducedMotion() && autoplayRefused) setAutoplayRefused(false);
    for (const s of slots) if (s.cand && !s.once) resumeIfNeeded(s);
    scheduleRank();
  }

  // The document-wide autoplay refusal. Flipping it on drops the whole board to posters with
  // play buttons; flipping it off clears them and lets ranking resume.
  function setAutoplayRefused(on) {
    if (autoplayRefused === on) return;
    autoplayRefused = on;
    if (on) {
      for (const s of slots) if (s.cand) release(s);
      for (const c of cands.values()) showAffordance(c);
    } else {
      for (const c of cands.values()) if (!c.blocked) hideAffordance(c);
    }
    scheduleRank();
  }

  // ── assignment ─────────────────────────────────────────────────────────────────────────

  function viewportRect() {
    if (typeof opts.viewport === "function") return opts.viewport();
    if (opts.viewport && typeof opts.viewport.width === "number") return opts.viewport;
    const w = (typeof window !== "undefined" && window.innerWidth) || 0;
    const h = (typeof window !== "undefined" && window.innerHeight) || 0;
    const r = container && container.getBoundingClientRect ? container.getBoundingClientRect() : null;
    if (!r || !r.width || !r.height) return { left: 0, top: 0, right: w, bottom: h, width: w, height: h };
    const left = Math.max(0, r.left), top = Math.max(0, r.top);
    const right = Math.min(w || r.right, r.right), bottom = Math.min(h || r.bottom, r.bottom);
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  // One batched read phase: every getBoundingClientRect happens here, with no style writes
  // interleaved, so the camera's transform is flushed once and not once per item.
  function measure() {
    const vp = viewportRect();
    const cx = vp.left + vp.width / 2;
    const cy = vp.top + vp.height / 2;
    const list = [];
    for (const c of cands.values()) {
      const r = c.el.isConnected ? c.el.getBoundingClientRect() : null;
      if (!r || r.width <= 0 || r.height <= 0) { c.visible = false; c.dist = Infinity; continue; }
      const on = r.right > vp.left && r.left < vp.right && r.bottom > vp.top && r.top < vp.bottom;
      c.visible = on;
      if (!on) { c.dist = Infinity; continue; }
      const dx = (r.left + r.width / 2) - cx;
      const dy = (r.top + r.height / 2) - cy;
      c.dist = Math.hypot(dx, dy);
      list.push(c);
    }
    list.sort((a, b) => (a.dist - b.dist) || (a.id < b.id ? -1 : 1));   // id tiebreak = stable
    return list;
  }

  // ── pushed mode: the renderer decides who gets a decoder ───────────────────────────────
  // collage.js publishes [{ id, item, node, shot, poster }], nearest-centre first, already
  // capped, and only when the SET changes. It computes that from its layout index, which is
  // cheaper and more exact than measuring rects, so in this mode the pool does no ranking of
  // its own at all — it honours the order it was given and keeps every other rule.

  /** Reconcile the candidate table with a renderer-published list, then assign in order. */
  function applyList(list) {
    driven = true;
    const seen = new Set();
    const want = [];
    for (const v of list || []) {
      if (!v) continue;
      const item = v.item || v;
      const el = v.shot || v.el || v.node;
      if (!item || item.kind !== "video" || !el || el.nodeType !== 1) continue;
      const id = String(v.id != null ? v.id : item.id);
      seen.add(id);
      let c = cands.get(id);
      if (!c || c.el !== el) { pool.attach(item, el); c = cands.get(id); }
      else c.item = item;
      if (c) want.push(c);
    }
    // Anything the renderer stopped naming goes back to its poster. The renderer drops items
    // the moment they leave the viewport, so this is also the off-screen stop in this mode.
    for (const c of [...cands.values()]) if (!seen.has(c.id)) pool.detach(c.id);
    drivenWant = want;
    syncDriven();
  }

  function syncDriven() {
    // A candidate detached since the list was published (release(node), or a re-attach under
    // the same id) must never be assigned again off a stale list.
    drivenWant = drivenWant.filter((c) => cands.get(c.id) === c);

    // Reduced motion and a platform refusal are STATES: hand the decoders back, the board is
    // posters now. Suspension and a hidden document are MOMENTS: pause and keep the
    // assignment, so coming back is a resumed frame rather than a reload and a poster.
    if (reducedMotion() || autoplayRefused) {
      for (const s of slots) if (s.cand) release(s);
      emit();
      return;
    }
    if (suspended || hidden) {
      for (const s of slots) pauseSlot(s);
      emit();
      return;
    }
    const wanted = new Set(drivenWant);
    for (const s of slots) if (s.cand && !wanted.has(s.cand)) release(s);
    for (const c of drivenWant) {
      if (c.blocked) continue;
      if (c.slot) { resumeIfNeeded(c.slot); continue; }
      const s = freeSlot();
      if (!s) break;                     // the renderer's cap and ours agree; this is the floor
      assign(s, c);
    }
    emit();
  }

  function rankNow() {
    if (destroyed || !doc) return;
    lastRank = now();
    if (driven) { syncDriven(); return; }

    // Reduced motion and suspension both mean: assign nothing new, and let what is playing
    // stop. Manual (button-pressed) playback still gets to keep its slot while on screen.
    const rm = reducedMotion();
    const ranked = measure();

    // 1. Anything assigned that is no longer on screen stops NOW. That is the battery rule
    //    and it does not wait for a cooldown. (pauseOffscreen() already did this on the last
    //    animation frame; this is the same rule applied to the fuller measurement.)
    for (const s of slots) {
      if (!s.cand) continue;
      if (!s.cand.visible || suspended || hidden) {
        pauseSlot(s);
        if (!s.idleAt) s.idleAt = now();
      } else {
        s.idleAt = 0;
        resumeIfNeeded(s);
      }
    }

    // 2. Hand back decoders that have been quiet a while. The camera has usually stopped
    //    calling update() by now — a fling ends — so an idle sweep is armed rather than
    //    waited for, otherwise RELEASE_IDLE_MS would be a promise the module never keeps.
    const t = now();
    let stillIdle = false;
    for (const s of slots) {
      if (!s.cand || !s.idleAt) continue;
      if (t - s.idleAt > RELEASE_IDLE_MS) release(s);
      else stillIdle = true;
    }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; }
    if (stillIdle) idleTimer = setTimeout(() => { idleTimer = 0; rankNow(); }, RELEASE_IDLE_MS + 60);

    if (rm || suspended || hidden || autoplayRefused) { emit(); return; }

    // 3. Fill free slots with the nearest unassigned visible candidates.
    for (const c of ranked) {
      if (c.slot || c.blocked) continue;
      const s = freeSlot();
      if (!s) break;
      assign(s, c);
    }

    // 4. Hysteresis swap: at most one per pass, and only when the incumbent is beaten by a
    //    clear margin AND its slot is off cooldown. Two videos at nearly equal distance must
    //    not trade a decoder back and forth every frame.
    const incumbents = ranked.filter((c) => c.slot && !c.slot.once).sort((a, b) => b.dist - a.dist);
    const open = ranked.filter((c) => !c.slot && !c.blocked);
    if (incumbents.length && open.length) {
      const worst = incumbents[0];
      const best = open[0];
      if (best.dist + HYSTERESIS_PX < worst.dist && t - worst.slot.since > SWAP_COOLDOWN_MS) {
        const s = worst.slot;
        release(s);
        assign(s, best);
        swaps++;
      }
    }
    emit();
  }

  function emit() {
    let live = 0;
    for (const s of slots) if (s.cand) live++;
    if (live > peakLive) peakLive = live;
    if (typeof opts.onChange === "function") { try { opts.onChange(stats()); } catch { /* telemetry must not break playback */ } }
  }

  // ── slot lifecycle ─────────────────────────────────────────────────────────────────────

  function assign(slot, cand, once = false) {
    if (destroyed || !cand || !cand.el || !cand.el.isConnected) return;
    if (slot.cand) release(slot);

    const url = String(cand.item.origUrl || "");
    if (!url) { warn("video item has no origUrl", cand.id); return; }

    slot.cand = cand;
    slot.since = now();
    slot.idleAt = 0;
    slot.once = !!once;
    slot.revealed = false;
    slot.seg = null;
    slot.gen++;
    cand.slot = slot;

    // High-water mark, counted where assignment actually happens rather than where stats are
    // emitted — a manual (button) play must show up in it too, because it is the number the
    // verification leans on to say the cap was never exceeded.
    let liveNow = 0;
    for (const s of slots) if (s.cand) liveNow++;
    if (liveNow > peakLive) peakLive = liveNow;

    const v = slot.el;
    v.dataset.live = "0";
    v.poster = cand.item.thumbUrl || "";

    // The media fragment starts the fetch at the in point rather than at byte zero, so the
    // very first painted frame is already the frame we want and no visible seek happens on
    // arrival. Fragments never reach the server and are stripped from the Cache API key, so
    // this does not fork the service worker's cache entry for the original.
    const seg0 = segmentFor(cand.item, num(cand.item.durationMs) !== null ? cand.item.durationMs / 1000 : null);
    v.src = Number.isFinite(seg0.start) && seg0.start > 0.05
      ? url + (url.includes("#") ? "" : "#t=" + seg0.start.toFixed(2))
      : url;

    ensurePositioned(cand);
    if (v.parentNode !== cand.el) cand.el.appendChild(v);

    const gen = slot.gen;
    const onMeta = () => {
      if (destroyed || slot.gen !== gen) return;
      const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
      slot.seg = segmentFor(cand.item, d);
      // Only correct the position if the fragment did not land us there already; an
      // unnecessary seek is an unnecessary chance to stutter.
      if (Number.isFinite(slot.seg.start) && Math.abs(v.currentTime - slot.seg.start) > 0.1) {
        try { v.currentTime = slot.seg.start; } catch { /* not seekable yet; tick() catches it */ }
      }
      tryPlay(slot);
    };
    if (v.readyState >= 1) {
      onMeta();
    } else {
      // Kept on the slot so release() can take it off again: an element that is recycled
      // before its metadata lands may never fire this, and one dangling closure per recycle
      // is a slow leak on a screen somebody pans around for twenty minutes.
      slot.metaListener = onMeta;
      v.addEventListener("loadedmetadata", onMeta, { once: true });
    }

    // Backstop: if no frame callback and no 'playing' ever arrives, reveal anyway rather
    // than leaving an invisible video over a poster forever.
    slot.revealTimer = setTimeout(function backstop() {
      if (destroyed || slot.gen !== gen) return;
      // Reveal only something there IS a frame for. readyState < HAVE_CURRENT_DATA means
      // nothing is decoded at this position; the renderer's poster underneath is strictly
      // better than an element with no picture, so wait another beat instead.
      if (slot.el.readyState >= 2) reveal(slot);
      else slot.revealTimer = setTimeout(backstop, REVEAL_TIMEOUT_MS);
    }, REVEAL_TIMEOUT_MS);
    hideAffordance(cand);
  }

  // Resume a slot that is assigned, on screen and paused — without stacking play() calls.
  // `playPending` matters because play() is a promise: on a slow connection it can be in
  // flight for a while, and calling it again every animation frame would be a queue of
  // promises whose rejections all land at once.
  function resumeIfNeeded(slot) {
    if (destroyed || !slot.cand || suspended || hidden || slot.playPending) return;
    if (!slot.el.paused) return;
    tryPlay(slot);
  }

  function tryPlay(slot) {
    if (destroyed || !slot.cand || suspended || hidden) return;
    const v = slot.el;
    v.muted = true;                       // re-assert: a stray unmute is an autoplay refusal
    const gen = slot.gen;
    slot.playPending = true;
    const p = v.play();
    if (p && typeof p.catch === "function") {
      p.then(() => { slot.playPending = false; if (slot.gen === gen) armFrameLoop(slot); })
       .catch((e) => {
         slot.playPending = false;
         if (destroyed || slot.gen !== gen || !slot.cand) return;
         const name = (e && e.name) || "";
         // AbortError is play() losing a race with our own pause()/release(), or with the
         // page being backgrounded or frozen. It is TRANSIENT and must not be mistaken for
         // an autoplay refusal: treating it as one would sprinkle play buttons over a board
         // whose only crime was that the phone locked for a moment.
         if (name === "AbortError" || name === "" || name === "InvalidStateError") {
           warn("play() interrupted (transient)", slot.cand.id, name);
           return;
         }
         const c = slot.cand;
         blockedCount++;
         if (name === "NotAllowedError") {
           // Muted autoplay refused — iOS Low Power Mode is the usual cause, and it is a
           // DOCUMENT-WIDE policy, not a property of this file. So the whole board switches
           // to play buttons rather than only the two or three items that happened to be
           // nearest the middle when the refusal landed: anything less would leave most of
           // the videos looking exactly like photos, with no way to play them, which is the
           // failure that must not ship.
           warn("autoplay refused", c.id, name);
           release(slot);
           setAutoplayRefused(true);
           return;
         }
         // NotSupportedError and friends: this SOURCE will not play here. Per-item.
         c.blocked = true;
         warn("play failed", c.id, name);
         release(slot);
         showAffordance(c);
       });
    } else {
      slot.playPending = false;           // pre-promise play(): nothing to await
      armFrameLoop(slot);
    }
  }

  // ── the segment loop ───────────────────────────────────────────────────────────────────
  // requestVideoFrameCallback fires once per PRESENTED frame, which is both the most precise
  // place to test the out point and free when nothing is presenting (hidden tab, paused
  // element) — exactly the battery shape we want. Where it does not exist we fall back to a
  // shared rAF ticker, and 'timeupdate' is a third line of defence in both cases.
  const hasRVFC = typeof HTMLVideoElement !== "undefined" &&
    HTMLVideoElement.prototype && "requestVideoFrameCallback" in HTMLVideoElement.prototype;

  let rafId = 0;
  function rafLoop() {
    rafId = 0;
    let any = false;
    for (const s of slots) if (s.cand && !s.el.paused) { tick(s); any = true; }
    if (any && !destroyed) rafId = requestAnimationFrame(rafLoop);
  }

  function armFrameLoop(slot) {
    if (hasRVFC) {
      const gen = slot.gen;
      const step = () => {
        if (destroyed || slot.gen !== gen || !slot.cand) return;
        reveal(slot);
        tick(slot);
        if (!slot.el.paused) slot.rvfc = slot.el.requestVideoFrameCallback(step);
      };
      slot.rvfc = slot.el.requestVideoFrameCallback(step);
    } else if (!rafId && !destroyed) {
      rafId = requestAnimationFrame(rafLoop);
    }
  }

  function tick(slot) {
    const v = slot.el;
    if (!slot.cand || v.paused) return;
    if (!slot.seg) {
      const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
      if (d === null) return;
      slot.seg = segmentFor(slot.cand.item, d);
    }
    const { start, out } = slot.seg;
    if (!Number.isFinite(out)) return;                 // unknown duration: native loop owns it
    const t = v.currentTime;
    if (t >= out - SEEK_LEAD_S || t < start - 0.25) {
      if (slot.once) {
        // Reduced motion / manual play: ONE pass of the segment, then the decoder goes back
        // to the pool and the item returns to its poster with the play button on it. It
        // does not park holding a decoder — under reduced motion this screen is a still
        // board, and a phone with no charger for four days should not be paying for three
        // idle decoders. Watching a whole clip is the viewer's job, not the board's.
        v.pause();
        const c = slot.cand;
        release(slot);
        if (c) { c.manual = false; showAffordance(c); }
        return;
      }
      if (v.readyState >= 2) {
        try { v.currentTime = start; } catch { /* transient; next tick retries */ }
      }
    }
  }

  function onPlaying(slot) { reveal(slot); armFrameLoop(slot); }
  function onSeeked(slot) { reveal(slot); }
  function onEnded(slot) {
    // With loop=true this should be unreachable. If a browser fires it anyway, recover on
    // the same frame rather than sitting on a poster.
    if (!slot.cand) return;
    warn("ended fired despite loop=true", slot.cand.id);
    try { slot.el.currentTime = slot.seg ? slot.seg.start : 0; slot.el.play(); } catch { /* give up quietly */ }
  }
  function onError(slot) {
    const c = slot.cand;
    if (!c) return;
    warn("media error", c.id, slot.el.error && slot.el.error.code);
    c.blocked = true;                      // do not re-assign a source that cannot decode
    release(slot);
    showAffordance(c);
  }

  // Reveal is idempotent and is the ONLY place the video becomes visible. Until it runs, the
  // renderer's poster is what the eye sees — which is what makes a recycle flash-free.
  function reveal(slot) {
    if (slot.revealed || !slot.cand) return;
    slot.revealed = true;
    if (slot.revealTimer) { clearTimeout(slot.revealTimer); slot.revealTimer = 0; }
    slot.el.dataset.live = "1";
    // The interop signal. The renderer's own play disc hides itself off this attribute in
    // CSS, so nothing has to reach across the file boundary to coordinate.
    try { slot.cand.el.dataset.live = "1"; } catch { /* not an HTMLElement; nothing to mark */ }
  }

  function pauseSlot(slot) {
    if (!slot.cand) return;
    if (!slot.el.paused) { try { slot.el.pause(); } catch { /* already gone */ } }
    if (slot.rvfc && slot.el.cancelVideoFrameCallback) {
      try { slot.el.cancelVideoFrameCallback(slot.rvfc); } catch { /* fine */ }
      slot.rvfc = 0;
    }
  }

  // Release hands the decoder back. This is the one path that can paint black, which is
  // exactly why the element is hidden BEFORE src is cleared and removed from the DOM after.
  function release(slot) {
    const c = slot.cand;
    slot.gen++;                                   // invalidate every in-flight callback
    pauseSlot(slot);
    if (slot.revealTimer) { clearTimeout(slot.revealTimer); slot.revealTimer = 0; }
    const v = slot.el;
    if (slot.metaListener) { v.removeEventListener("loadedmetadata", slot.metaListener); slot.metaListener = null; }
    v.dataset.live = "0";
    // removeAttribute + load() is what actually frees the media resource on WebKit; setting
    // src="" would issue a request for the page URL.
    v.removeAttribute("src");
    v.removeAttribute("poster");
    try { v.load(); } catch { /* fine */ }
    if (v.parentNode) v.parentNode.removeChild(v);
    if (c && c.el) { try { delete c.el.dataset.live; } catch { /* fine */ } }
    slot.cand = null;
    slot.seg = null;
    slot.once = false;
    slot.playPending = false;
    slot.revealed = false;
    slot.idleAt = 0;
    if (c) { c.slot = null; restorePosition(c); }
  }

  // ── the renderer node: minimal, reversible mutation ────────────────────────────────────

  function ensurePositioned(c) {
    if (c.prevPosition !== null) return;
    const cs = doc.defaultView ? doc.defaultView.getComputedStyle(c.el) : null;
    if (cs && cs.position === "static") {
      c.prevPosition = c.el.style.position;
      c.el.style.position = "relative";
    } else {
      c.prevPosition = false;                    // nothing was changed
    }
  }
  function restorePosition(c) {
    if (c.prevPosition === null || c.prevPosition === false) { c.prevPosition = null; return; }
    c.el.style.position = c.prevPosition;
    c.prevPosition = null;
  }

  // ── the play affordance ────────────────────────────────────────────────────────────────

  function showAffordance(c) {
    if (affordanceMode === false || !c || !c.el || !c.el.isConnected || c.btn) return;
    // "auto": the renderer already drew a play affordance in this box. One is the
    // requirement; two is a bug.
    if (affordanceMode === "auto" && c.el.querySelector(".cg-play")) return;
    ensurePositioned(c);
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "cgv-play";
    b.setAttribute("aria-label", "Play video");
    b.title = "Play video";
    b.innerHTML = PLAY_SVG;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();                       // do not also open the item in the viewer
      playManually(c);
    });
    c.el.appendChild(b);
    c.btn = b;
  }
  function hideAffordance(c) {
    if (c && c.btn) { if (c.btn.parentNode) c.btn.parentNode.removeChild(c.btn); c.btn = null; }
  }

  /** A real gesture: clears the blocked flag, borrows a slot, plays the segment once. */
  function playManually(c) {
    if (destroyed || !c) return;
    unlocked = true;
    c.blocked = false;
    c.manual = true;
    let s = freeSlot();
    if (!s) {
      // Every slot is busy. Take the one furthest from the centre — a deliberate press
      // outranks ambient playback.
      let worst = null;
      for (const sl of slots) if (sl.cand && (!worst || sl.cand.dist > worst.cand.dist)) worst = sl;
      if (worst) { release(worst); s = worst; }
    }
    if (!s) return;
    // Under reduced motion a press buys ONE pass and no more. Otherwise the press was the
    // gesture that lifted an autoplay refusal, and this item simply joins the living board.
    assign(s, c, reducedMotion());
  }

  // ── scheduling ─────────────────────────────────────────────────────────────────────────
  // update() is safe to call every animation frame. Two different clocks, deliberately:
  //
  //   * LEAVING THE VIEWPORT STOPS DECODING ON THE VERY NEXT FRAME. That is the battery rule
  //     and it must not wait on the ranking throttle — it costs at most `poolSize` rect
  //     reads (three), so there is no reason to make it cheaper than correct.
  //   * CHOOSING which items get the pool runs at most every RANK_MIN_MS. That one reads
  //     every attached candidate's rect, and 8Hz is plenty for a decision about which three
  //     videos are nearest the middle of the screen.
  //
  // A trailing timer guarantees the final camera position is always ranked, so the board
  // settles correctly after a fling rather than freezing mid-decision.
  function scheduleRank() {
    if (destroyed || rankQueued) return;
    rankQueued = true;
    requestAnimationFrame(onFrame);
  }

  function onFrame() {
    rankQueued = false;
    if (destroyed) return;
    pauseOffscreen();
    const dt = now() - lastRank;
    if (dt >= RANK_MIN_MS) {
      if (rankTimer) { clearTimeout(rankTimer); rankTimer = 0; }
      rankNow();
    } else if (!rankTimer) {
      rankTimer = setTimeout(() => { rankTimer = 0; rankNow(); }, RANK_MIN_MS - dt);
    }
  }

  // The cheap half: only the assigned elements, only "is it still on screen".
  function pauseOffscreen() {
    let anyLive = false;
    for (const s of slots) if (s.cand) { anyLive = true; break; }
    if (!anyLive) return;
    const vp = viewportRect();
    for (const s of slots) {
      if (!s.cand) continue;
      const el = s.cand.el;
      const r = el.isConnected ? el.getBoundingClientRect() : null;
      const on = !!r && r.width > 0 && r.height > 0 &&
        r.right > vp.left && r.left < vp.right && r.bottom > vp.top && r.top < vp.bottom;
      if (!on || suspended || hidden) {
        pauseSlot(s);
        if (!s.idleAt) s.idleAt = now();
      } else {
        // Back on screen before its decoder was handed back: resume in place, which keeps
        // the frame it was showing. Re-assigning would be a reload and a poster flash.
        s.idleAt = 0;
        resumeIfNeeded(s);
      }
    }
    // In pushed mode the renderer's list is the authority on WHO gets a decoder, so nothing
    // here may hand one back on an idle timer — the renderer would not know to ask again.
    if (driven) for (const s of slots) s.idleAt = 0;
  }

  // ── document-level listeners ───────────────────────────────────────────────────────────

  function onVisibility() {
    hidden = doc.visibilityState === "hidden";
    if (hidden) for (const s of slots) pauseSlot(s);
    scheduleRank();
  }
  function onPageHide() { hidden = true; for (const s of slots) pauseSlot(s); }
  function onPageShow() { hidden = doc.visibilityState === "hidden"; scheduleRank(); }

  const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  function onMotionPrefChange() {
    if (reducedMotion()) {
      for (const s of slots) release(s);
      for (const c of cands.values()) showAffordance(c);
    } else {
      // A per-item refusal (a source that will not decode) survives; it is not a motion
      // preference and hiding its button would just hide a broken item.
      for (const c of cands.values()) if (!c.blocked && !autoplayRefused) hideAffordance(c);
    }
    scheduleRank();
  }

  if (doc) {
    doc.addEventListener("visibilitychange", onVisibility);
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("pageshow", onPageShow);
    }
  }
  if (container) container.addEventListener("pointerdown", onGesture, { passive: true });
  if (mq) {
    if (mq.addEventListener) mq.addEventListener("change", onMotionPrefChange);
    else if (mq.addListener) mq.addListener(onMotionPrefChange);
  }

  // ── public surface ─────────────────────────────────────────────────────────────────────

  function stats() {
    let live = 0, playing = 0;
    const assigned = [];
    for (const s of slots) {
      if (!s.cand) continue;
      live++;
      assigned.push(s.cand.id);
      if (!s.el.paused) playing++;
    }
    return {
      poolSize,                 // the cap
      created: slots.length,    // <video> elements that exist — never exceeds poolSize
      live,                     // elements currently holding an item
      playing,
      peakLive,                 // high-water mark across the whole session
      assigned,
      attached: cands.size,
      swaps,
      blocked: blockedCount,       // lifetime count of refused/failed play() calls
      autoplayRefused,             // the platform is refusing muted autoplay right now
      affordances: [...cands.values()].filter((c) => c.btn).length,
      reducedMotion: reducedMotion(),
      suspended, hidden,
    };
  }

  const pool = {
    /**
     * Register a video LayoutItem that now has a live node.
     * Idempotent: re-attaching the same id re-points it at the new element.
     * @param {object} item  LayoutItem, kind 'video'
     * @param {Element} el   the box the media fills
     */
    attach(item, el) {
      if (destroyed || !item || !el || el.nodeType !== 1) return;
      if (item.kind !== "video") { warn("attach() ignored a non-video item", item && item.id); return; }
      const id = String(item.id);
      const existing = cands.get(id);
      if (existing) {
        const sameSource = String(existing.item.origUrl || "") === String(item.origUrl || "");
        if (existing.el === el && sameSource) { existing.item = item; return; }
        // Same id, different node or different source: this is a new thing wearing an old
        // name. Tear the old one down rather than leaving a <video> in the previous box.
        pool.detach(id);
      }
      const c = new Cand(item, el);
      cands.set(id, c);
      if (reducedMotion() || autoplayRefused) showAffordance(c);
      scheduleRank();
    },

    /** Unregister an item. Releases its pool element if it held one. */
    detach(id) {
      const c = cands.get(String(id));
      if (!c) return;
      if (c.slot) release(c.slot);
      hideAffordance(c);
      restorePosition(c);
      cands.delete(c.id);
      scheduleRank();
    },

    /**
     * Two callers, one method.
     *   update()      — self-measuring mode: re-rank off the DOM. Cheap and self-throttling;
     *                   call it whenever the camera moves, every frame is fine.
     *   update(list)  — pushed mode, collage.js's `video.update(list)` contract. `list` is
     *                   [{ id, item, node, shot, poster }] already ordered nearest-centre
     *                   first and already capped. Honoured in order; the pool stops ranking.
     */
    update(list) {
      if (destroyed) return;
      if (Array.isArray(list)) applyList(list);
      else scheduleRank();
    },

    /**
     * collage.js's `video.release(node)`: that ITEM node is being unbound from its item.
     * Whatever candidate lives inside it is detached and its decoder handed back.
     */
    release(node) {
      if (!node || node.nodeType !== 1) return;
      for (const c of [...cands.values()]) {
        if (c.el === node || node.contains(c.el)) pool.detach(c.id);
      }
    },

    /** Stop everything without forgetting anything — a sheet opened, the tab went away. */
    pause() {
      if (suspended) return;
      suspended = true;
      for (const s of slots) pauseSlot(s);
      emit();
    },

    /** Undo pause(). */
    resume() {
      if (!suspended) return;
      suspended = false;
      scheduleRank();
      for (const s of slots) if (s.cand) resumeIfNeeded(s);
    },

    /** Where "on screen" is, if it is not the container's rect. */
    setViewport(v) { opts.viewport = v; scheduleRank(); },

    /** Counters for verification: `created` and `peakLive` must never exceed `poolSize`. */
    stats,

    /** Full teardown. Every decoder released, every listener removed, every node cleaned. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (rankTimer) clearTimeout(rankTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (rafId) cancelAnimationFrame(rafId);
      for (const s of slots) release(s);
      for (const c of [...cands.values()]) { hideAffordance(c); restorePosition(c); }
      cands.clear();
      slots.length = 0;
      if (doc) {
        doc.removeEventListener("visibilitychange", onVisibility);
        if (typeof window !== "undefined") {
          window.removeEventListener("pagehide", onPageHide);
          window.removeEventListener("pageshow", onPageShow);
        }
      }
      if (container) container.removeEventListener("pointerdown", onGesture);
      if (mq) {
        if (mq.removeEventListener) mq.removeEventListener("change", onMotionPrefChange);
        else if (mq.removeListener) mq.removeListener(onMotionPrefChange);
      }
    },
  };

  return pool;
}

export default createVideoPool;

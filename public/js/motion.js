// motion.js — the app's motion primitives. Three functions, no framework, no state machine.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE CONTRACT
//
//   import { flip, drawCheck, breathe, reducedMotion, ms } from "./motion.js";
//
//   await flip(listEl, () => { …reorder/add/remove DOM… });   // FLIP a keyed list
//   await drawCheck(svgPathEl);                               // stroke-draw a checkmark
//   const b = breathe(nowMarkerEl); b.stop();                  // the ONE ambient loop
//
// RULES THIS FILE ENFORCES SO CALLERS DO NOT HAVE TO
//   * Transforms and opacity only. Nothing here tweens width, height, top or left — the one
//     deliberate exception is drawCheck's stroke-dashoffset, which repaints a 20px box and
//     never triggers layout. No `will-change` sprayed across a list either; translate3d
//     already promotes the row for the length of the animation and gives it back after.
//   * prefers-reduced-motion kills every one of them. flip() still MUTATES — it is a DOM
//     operation that happens to animate, not an animation — it just lands instantly.
//   * Durations and easings come from the CSS tokens at the end of styles.css, read once and
//     cached, so there is exactly one place where 220ms is written down.
//   * Nothing has `fill: forwards` except a departing ghost. Every animation here plays TO
//     the element's resting style, which means a phone that goes to sleep mid-animation (the
//     document is hidden, WAAPI stops) wakes up with correct final layout rather than a row
//     frozen 40px from where it belongs.
// ─────────────────────────────────────────────────────────────────────────────────────────

const MQ = matchMedia("(prefers-reduced-motion: reduce)");

/** True when the user has asked for less motion. Shared so six modules do not each write it. */
export function reducedMotion() { return MQ.matches; }

// ── tokens ───────────────────────────────────────────────────────────────────────────────
// Read lazily and cached, never at import time: a module can execute before its stylesheet
// has applied, and a value cached as "" then would be wrong for the rest of the session. An
// empty read is therefore NOT cached — it falls back and tries again next call.
const TOK = new Map();
function tok(name, fallback) {
  const hit = TOK.get(name);
  if (hit !== undefined) return hit;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!v) return fallback;
  TOK.set(name, v);
  return v;
}
/** A duration token as a NUMBER of milliseconds: ms("--dur") -> 220. */
export function ms(name, fallback = 220) {
  const v = tok(name, "");
  if (!v) return fallback;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return /ms$/.test(v) ? n : n * 1000;      // "0.22s" is legal CSS and would read as 0.22
}
const easeOut = () => tok("--ease-out", "cubic-bezier(.2,.8,.2,1)");

const ENTER_PX = 8;          // arrivals rise 8px, leavers sink 8px, both directions.
const AMBIENT_MS = 2000;     // the breathe loop. The one number in this file not from a token.

const settled = (p) => p.finished.then(() => {}, () => {});   // a cancelled player is not an error

// ── flip ─────────────────────────────────────────────────────────────────────────────────
// Measure, mutate, measure, invert, play. The single biggest "fluid" win in the app: a
// filter change or a pack regroup where surviving rows SLIDE to their new home instead of
// the list snapping to a new arrangement.
//
// Which elements move is decided by `data-key`, and only the OUTERMOST keyed elements inside
// `container` are animated. A keyed row nested inside a keyed section would inherit its
// section's transform and travel twice as far, so key the layer you want to see move: key
// the sections for a section reshuffle, key the rows for a regroup.
function keyed(container) {
  const out = [];
  for (const el of container.querySelectorAll("[data-key]")) {
    const anc = el.parentElement && el.parentElement.closest("[data-key]");
    if (anc && anc !== container && container.contains(anc)) continue;
    out.push(el);
  }
  return out;
}

// Positions are taken in the container's CONTENT space — relative to its box, plus its own
// scroll offset. Two things that would otherwise corrupt every delta cancel out: the page
// scrolling because the mutation changed the document height, and the container scrolling
// under its own content.
function snap(container, els) {
  const base = container.getBoundingClientRect();
  const sx = container.scrollLeft || 0, sy = container.scrollTop || 0;
  const m = new Map();
  for (const el of els) {
    const r = el.getBoundingClientRect();
    m.set(el.dataset.key, {
      el,
      x: r.left - base.left + sx, y: r.top - base.top + sy,
      vx: r.left, vy: r.top, w: r.width, h: r.height,
    });
  }
  return m;
}

/**
 * FLIP-animate a keyed list across a DOM mutation.
 * @param {Element} container   the list. Its keyed descendants are what move.
 * @param {() => void} mutate   reorders / adds / removes. Called synchronously, exactly once.
 * @param {{duration?: number, easing?: string, stagger?: number,
 *          enter?: boolean, exit?: boolean}} [opts]
 * @returns {Promise<void>}     resolves when every player has finished or been cancelled.
 */
export function flip(container, mutate, opts = {}) {
  if (typeof mutate !== "function") return Promise.resolve();
  // Reduced motion, or a container that is not on screen to measure: just do the work.
  if (!container || !container.isConnected || reducedMotion()) { mutate(); return Promise.resolve(); }

  const duration = opts.duration || ms("--dur", 220);
  const easing = opts.easing || easeOut();
  const stagger = opts.stagger || 0;
  const doEnter = opts.enter !== false;
  const doExit = opts.exit !== false;

  const first = snap(container, keyed(container));
  mutate();
  const second = snap(container, keyed(container));

  const players = [];
  let entered = 0;
  for (const [key, b] of second) {
    const a = first.get(key);
    if (!a) {
      // Arrival: fade up 8px. `backwards` fill so a staggered arrival is invisible during
      // its delay rather than popping in and then animating.
      if (!doEnter) continue;
      players.push(b.el.animate(
        [{ opacity: 0, transform: `translate3d(0,${ENTER_PX}px,0)` },
         { opacity: 1, transform: "none" }],
        { duration, easing, delay: stagger * entered++, fill: "backwards" }));
      continue;
    }
    const dx = a.x - b.x, dy = a.y - b.y;
    // Sub-pixel deltas are rounding, not movement, and animating them costs a composited
    // layer per row for something nobody can see.
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    players.push(b.el.animate(
      [{ transform: `translate3d(${dx}px,${dy}px,0)` }, { transform: "none" }],
      { duration, easing }));
  }

  if (doExit) for (const [key, a] of first) if (!second.has(key)) exit(container, a, duration, easing);

  return Promise.all(players.map(settled)).then(() => {});
}

// A leaver has already been taken out of the DOM by mutate() — but we still hold the node, so
// put it back as a fixed-position ghost at the coordinates it occupied and let it fade down.
// It goes back INSIDE the container, not onto <body>: descendant selectors and inherited type
// still apply, so the ghost looks like the row it was. `position: fixed` keeps it out of flow,
// so the surviving rows close the gap underneath it exactly as they would have anyway.
function exit(container, a, duration, easing) {
  const el = a.el;
  // Only a node that is genuinely OFF the page becomes a ghost. A row that left this
  // container but is still in the document has been re-parented — a pack item dropped into
  // another section, say — and turning that live node into a fixed-position ghost would tear
  // it out of the list it just joined.
  if (el.isConnected) return;
  const s = el.style;
  s.position = "fixed";
  s.left = `${a.vx}px`; s.top = `${a.vy}px`;
  s.width = `${a.w}px`; s.height = `${a.h}px`;
  s.margin = "0";
  s.pointerEvents = "none";                   // it is a picture of a row, not a row
  container.append(el);

  // `fixed` is viewport-relative UNLESS some ancestor has a transform — and the router gives
  // #view exactly that for the length of a page transition. Rather than reason about which
  // ancestor won, measure where the ghost actually landed and correct by the error.
  const r = el.getBoundingClientRect();
  if (Math.abs(r.left - a.vx) > 0.5) s.left = `${a.vx - (r.left - a.vx)}px`;
  if (Math.abs(r.top - a.vy) > 0.5) s.top = `${a.vy - (r.top - a.vy)}px`;

  const p = el.animate(
    [{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translate3d(0,${ENTER_PX}px,0)` }],
    { duration, easing, fill: "forwards" });
  // Deadline as well as `finished`, for the same reason sheet.js has one: WAAPI does not run
  // while the document is hidden, and a ghost that is never removed is a permanent smear over
  // the list. Whichever lands first wins; remove() twice is harmless.
  const drop = () => el.remove();
  settled(p).then(drop);
  setTimeout(drop, duration + 300);
}

// ── drawCheck ────────────────────────────────────────────────────────────────────────────
/**
 * Draw an SVG stroke on, from its start to its end.
 * @param {SVGPathElement} path  any element with getTotalLength() — path, line, polyline.
 * @param {number} [dur]         default 160ms: the packing tick duration.
 * @returns {Promise<void>}
 */
export function drawCheck(path, dur = 160) {
  if (!path || typeof path.getTotalLength !== "function") return Promise.resolve();
  let len = 0;
  // getTotalLength() throws in some engines on a path with no `d` yet, and returns 0 for a
  // display:none one. Either way there is nothing to draw and nothing to fail over.
  try { len = path.getTotalLength(); } catch { return Promise.resolve(); }
  if (!(len > 0)) return Promise.resolve();

  // The dasharray is the resting state, not part of the animation: one dash exactly as long
  // as the stroke, offset 0 = fully drawn. So the finished tick is correct even if the
  // animation never gets a frame.
  path.style.strokeDasharray = `${len}`;
  path.style.strokeDashoffset = "0";
  if (reducedMotion()) return Promise.resolve();
  return settled(path.animate(
    [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
    { duration: dur, easing: easeOut() }));
}

// ── breathe ──────────────────────────────────────────────────────────────────────────────
// The ONE permitted ambient loop in the app — the agenda's "now" marker — and it is a
// singleton by construction: starting a second one stops the first. Battery at 4,200 m is a
// feature, so it pauses whenever the app is not on screen and dies outright if the user turns
// on reduced motion while it is running.
//
// Point it at a MARK, never at text: it bottoms out at 0.55 opacity, and the accessibility rule is
// that no text in this app is ever quieted with alpha.
let ambient = null;

function stopAmbient() {
  if (!ambient) return;
  const { player, onVis, onMq } = ambient;
  ambient = null;
  player.cancel();
  document.removeEventListener("visibilitychange", onVis);
  MQ.removeEventListener("change", onMq);
}

/**
 * @param {Element} el
 * @returns {{stop: () => void}}
 */
export function breathe(el) {
  stopAmbient();
  if (!el || reducedMotion()) return { stop() {} };
  const player = el.animate(
    [{ opacity: 1 }, { opacity: 0.55 }, { opacity: 1 }],
    { duration: AMBIENT_MS, iterations: Infinity, easing: "ease-in-out" });
  const onVis = () => { if (document.hidden) player.pause(); else player.play(); };
  const onMq = () => { if (reducedMotion()) stopAmbient(); };
  document.addEventListener("visibilitychange", onVis);
  MQ.addEventListener("change", onMq);
  if (document.hidden) player.pause();
  ambient = { player, onVis, onMq };
  return { stop: stopAmbient };
}

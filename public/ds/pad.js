// The pad: your picture, and your color with it. The circle IS your face as everyone on your trips sees it: your
// color for its ground, and your drawing on it in the one ink your initials wear on that color (or your initials,
// while nothing is drawn). Tools: your color (the people colors the server offers), your initials while nothing is
// drawn, three brushes, Undo, Clear, Save and, for someone who has a picture, "Back to initials". One background and
// one drawing color: no second ink, no Fill, no eraser, no layers, no photograph.
//
//   mountPad(host, { drawing, colors, color, initials, name, hasPicture, fit, onChange, onSave, onInitials })
//       ->  { drawing, empty, color, initials, undo, clear, busy, destroy }
//     drawing     what to open with (drawing.js's shape), or nothing. A Fill in it (the old pad's) is dropped: it is
//                 never drawn (drawing.js), so it is not a stroke here either
//     colors      the colors a person may wear, [{ hex, name }] (GET /api/me's note_colors, the server's one list)
//     color       the one they wear now (a hex from that list), or nothing: a gray ground until one is picked
//     initials    what their face shows while nothing is drawn; name, what they are made from when not given
//     hasPicture  whether "Back to initials" is offered
//     onChange    ({ drawing, empty, color, initials }) after every stroke, undo, clear and color
//     onSave      ({ drawing, color, initials }) on Save: drawing null when the pad is empty (initials on the color).
//                 Save is on once something differs from what the pad opened with
//     onInitials  ({ color, initials }) on "Back to initials"
//     fit         (drawing) -> { drawing, eps } | null: the stored format's fit to its size ceiling. When a drawing
//                 outgrows it and is simplified (eps > 0), the pad takes the simplified strokes back and draws them:
//                 the one moment the points stored are not the points drawn, put right on screen at once.
//
// THE COLORS ARE THE FACE'S, read from the page: the paper carries the chosen tone's custom properties (personVars,
// the same as every face) and the canvas paints with what --ds-pic-ground and --ds-pic-ink compute to there, so the pad
// and every face are one colour as well as one geometry, in either theme. They are read again when the color or the
// theme changes.
//
// THE INK IS A CANVAS, cleared and fully redrawn each frame. WebKit gets the repaint rectangle of a <path> changed
// under the finger wrong and leaves a cleared seam along its painted box; a surface redrawn whole every frame has no
// incremental repaint to get wrong. Each line is still new Path2D(strokePathD(pts)), the string the faces' <svg>
// carries, so the pad and every face are one geometry. A one-point stroke (a dot, and Fill) is the exception: a
// canvas paints no round cap on a path of no length (Chrome's, parsed from a string or built), so the pad fills the
// cap's own disc, a circle of half the brush at the point, which is what the <svg> draws.
//
// THE CAPTURE, each line for its reason:
//   - touch-action: none in the stylesheet AND set here: either one missing loses the stroke on a phone;
//   - setPointerCapture on pointerdown, so a stroke that leaves the circle still finishes;
//   - getCoalescedEvents, with a fallback for a browser that hands back an empty list: a 120 Hz screen's points
//     are otherwise thrown away down to one a frame;
//   - one getBoundingClientRect per event, not per point;
//   - one finger: a second never starts a stroke; right-click and a pen's barrel button don't either;
//   - contextmenu prevented, against a long press opening a menu;
//   - pointercancel keeps the part already drawn (only a real pointerup adds a last point);
//   - every point is clamped into the circle as it is taken, less half the brush, so a line that runs off the edge
//     slides along the rim, as a marker does on a round card, and the stored points are the points you saw.
// The frame in flight is input echo, not animation: it draws the line already under the finger, so reduced motion
// doesn't stop it.
import { getStrokePoints } from "../vendor/perfect-freehand/perfect-freehand.mjs";
import { BRUSHES, FILL, GRID, checkDrawing, strokePathD, widthOf } from "./drawing.js";
import { initialsOf, personTone, personVars } from "./avatar.js";
import { esc } from "../js/util.js";

// More and the line lags the finger; less and every wobble is kept.
const STREAMLINE = 0.42;
// Grid units: how far the hand moves before streamlining starts, and before a point is worth keeping. Four is under
// the fine brush's width (5.6), so nothing visible is thrown away.
const PF_SIZE = 6;
const MIN_STEP = 4;
const DPR_CAP = 3;
const R = GRID / 2;
const BRUSH_NAMES = ["Fine brush", "Medium brush", "Broad brush"];
const DOTS = [5, 11, 22];
const clampGrid = (v) => (v < 0 ? 0 : v > GRID ? GRID : v);
const INITIALS_MAX = 3;
const TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';
const copyStrokes = (list) => list.map((s) => ({ ink: s.ink, brush: s.brush, pts: s.pts.map((p) => [p[0], p[1]]) }));
const sameStrokes = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function mountPad(host, opts = {}) {
  const onChange = typeof opts.onChange === "function" ? opts.onChange : () => {};
  const colors = Array.isArray(opts.colors) ? opts.colors.filter((c) => c && personTone(c.hex)) : [];
  const start = checkDrawing(opts.drawing);
  // The picture keeps the palette byte it was stored with (it is never drawn); a new one is stored with the first.
  const palette = start ? start.palette : 0;
  const startStrokes = start ? copyStrokes(start.strokes.filter((s) => s.brush < FILL)) : [];
  let strokes = copyStrokes(startStrokes);
  const startColor = colors.some((c) => c.hex === opts.color) ? opts.color : null;
  let color = startColor;
  const madeInitials = initialsOf(opts.name || "");
  const startInitials = String(opts.initials || madeInitials).toUpperCase();
  let initials = startInitials;
  let size = 1;
  const history = [];          // whole-array snapshots: Undo takes back a stroke or a Clear
  let inFlight = null;         // { id, raw }
  let dead = false, frame = 0;
  let ground = "", ink = "";   // what the paper's custom properties compute to (readColors)

  host.innerHTML = `
    <div class="ds-pad">
      <div class="ds-pad-paper" data-pad-paper data-own-gesture>
        <canvas role="application" aria-label="Your picture: draw here" data-pad-ink></canvas>
        <span class="ds-pad-initials" aria-hidden="true" data-pad-letters></span>
        <span class="ds-pad-hint" aria-hidden="true" data-pad-hint>Draw here</span>
      </div>
      ${colors.length ? `
      <p class="ds-pad-colorsay" id="ds-pad-colorsay"><span>Your color</span> <b data-pad-colorname></b></p>
      <div class="ds-pad-colors" role="radiogroup" aria-labelledby="ds-pad-colorsay">
        ${colors.map((c) => `<button type="button" class="ds-pad-color" role="radio" aria-checked="false" data-pad-color="${esc(c.hex)}" aria-label="${esc(c.name)}" style="${personVars(c.hex)}">${TICK}</button>`).join("")}
      </div>` : ""}
      <label class="ds-pad-initrow" data-pad-initrow>
        <span>Your initials</span>
        <input class="ds-input ds-pad-initinput" type="text" inputmode="text" maxlength="${INITIALS_MAX}" autocapitalize="characters"
          autocomplete="off" spellcheck="false" data-pad-initials-input value="${esc(startInitials)}">
      </label>
      <div class="ds-pad-tools" role="group" aria-label="Brush">
        ${BRUSHES.map((_, i) => `<button type="button" class="ds-pad-tool ds-pad-tool--size" data-pad-size="${i}" aria-label="${BRUSH_NAMES[i]}" aria-pressed="false"><i style="width:${DOTS[i]}px;height:${DOTS[i]}px"></i></button>`).join("")}
      </div>
      <div class="ds-pad-acts">
        <button type="button" class="ds-button ds-button--fade" data-pad-undo disabled><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3 2.5 5.5 5 8M2.5 5.5H10a3.5 3.5 0 0 1 0 7H6"/></svg>Undo</button>
        <button type="button" class="ds-button ds-button--fade" data-pad-clear disabled>Clear</button>
        <span class="ds-pad-grow"></span>
        <button type="button" class="ds-button ds-button--fade" data-pad-initials data-destroys${opts.hasPicture && typeof opts.onInitials === "function" ? "" : " hidden"}>Back to initials</button>
      </div>
      <button type="button" class="ds-button ds-button--white ds-button--lg ds-button--block" data-pad-save disabled>Save</button>
    </div>`;
  const $ = (sel) => host.querySelector(sel);
  const paper = $("[data-pad-paper]"), cv = $("[data-pad-ink]"), letters = $("[data-pad-letters]");
  const initRow = $("[data-pad-initrow]"), initInput = $("[data-pad-initials-input]");
  cv.style.touchAction = "none";

  // The paper wears the chosen color as every face does; the canvas paints with what that computes to here.
  function readColors() {
    const t = personTone(color);
    paper.setAttribute("style", t ? personVars(color) : "");
    paper.toggleAttribute("data-person", !!t);
    const cs = getComputedStyle(paper);
    ground = cs.getPropertyValue("--ds-pic-ground").trim() || cs.getPropertyValue("--gray-5").trim();
    ink = cs.getPropertyValue("--ds-pic-ink").trim() || cs.getPropertyValue("--ink-1").trim();
  }
  // The theme can change while the sheet is open (Appearance, or the system's): the paper's colours with it.
  const themeWatch = typeof MutationObserver === "function"
    ? new MutationObserver(() => { if (!dead) { readColors(); paint(); } }) : null;
  themeWatch?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-lum", "data-theme", "class"] });

  // ── the surface ──────────────────────────────────────────────────────────────────────────
  const ctx = cv.getContext("2d");
  let cssW = 0, dpr = 0;
  const paths = new WeakMap();
  const pathFor = (pts) => { let p = paths.get(pts); if (!p) { p = new Path2D(strokePathD(pts)); paths.set(pts, p); } return p; };

  function paint() {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    if (dead || !ctx || !cssW) return;
    const s = cv.width / GRID;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, GRID, GRID);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const draw = (pts, colour, width, path) => {
      if (pts.length === 1) {
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(pts[0][0], pts[0][1], width / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.stroke(path());
    };
    for (const st of strokes) draw(st.pts, ink, widthOf(st.brush) * GRID, () => pathFor(st.pts));
    const live = inFlight ? quantise(inFlight.raw, false) : null;
    // The line in your hand joins the drawing in the same pass, so it crosses a finished one as one colour.
    if (live && live.length) draw(live, ink, widthOf(BRUSHES[size]) * GRID, () => new Path2D(strokePathD(live)));
    ctx.restore();
  }
  function invalidate() {
    if (frame || dead) return;
    frame = requestAnimationFrame(() => { frame = 0; paint(); });
  }
  // Measured with clientWidth (a layout value, untouched by the sheet's slide), and drawn at once: setting a canvas's
  // size wipes it, so waiting a frame would flash it empty on every resize.
  function layout(force) {
    if (dead) return;
    const w = paper.clientWidth;
    if (w <= 0) return;
    const nd = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    if (!force && w === cssW && nd === dpr) return;
    cssW = w; dpr = nd;
    cv.width = cv.height = Math.max(1, Math.round(w * nd));
    paint();
  }
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => layout(false)) : null;
  ro?.observe(paper);
  // A window moved to another screen changes the pixel ratio and no size; the query is asked again after each change.
  let dprMq = null;
  const onDpr = () => { if (!dead) { layout(false); armDpr(); } };
  function armDpr() {
    dprMq?.removeEventListener?.("change", onDpr);
    dprMq = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) ?? null;
    dprMq?.addEventListener?.("change", onDpr);
  }
  armDpr();
  const onResize = () => layout(false);
  window.addEventListener("resize", onResize);
  // A phone may throw a background tab's canvas away and give it back empty: drawn again on return.
  const onRestore = () => { if (!dead && !document.hidden) paint(); };
  document.addEventListener("visibilitychange", onRestore);
  window.addEventListener("pageshow", onRestore);

  // ── capture ──────────────────────────────────────────────────────────────────────────────
  function toGrid(rect, ev) {
    const gx = ((ev.clientX - rect.left) / rect.width) * GRID;
    const gy = ((ev.clientY - rect.top) / rect.height) * GRID;
    const dx = gx - R, dy = gy - R, d = Math.hypot(dx, dy);
    const max = R - (widthOf(BRUSHES[size]) * GRID) / 2;
    if (d <= max || d === 0) return [gx, gy];
    return [R + (dx / d) * max, R + (dy / d) * max];
  }
  // Raw points to the integers that are drawn, stored and named. `last` only on pointerup: it stops the finished
  // line snapping back at release.
  function quantise(raw, last) {
    if (!raw.length) return [];
    const smoothed = getStrokePoints(raw, { streamline: STREAMLINE, size: PF_SIZE, simulatePressure: false, last });
    const out = [];
    for (const s of smoothed) {
      const x = clampGrid(Math.round(s.point[0])), y = clampGrid(Math.round(s.point[1]));
      const prev = out[out.length - 1];
      if (prev && (prev[0] - x) ** 2 + (prev[1] - y) ** 2 < MIN_STEP * MIN_STEP) continue;
      out.push([x, y]);
    }
    if (!out.length && smoothed.length) out.push([clampGrid(Math.round(smoothed[0].point[0])), clampGrid(Math.round(smoothed[0].point[1]))]);
    return out;
  }
  function onDown(e) {
    if (dead || inFlight || paper.hasAttribute("data-busy")) return;
    if (e.button > 0) return;
    const rect = cv.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    inFlight = { id: e.pointerId, raw: [toGrid(rect, e)] };
    try { cv.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
    paper.setAttribute("data-used", "");
    invalidate();
  }
  function onMove(e) {
    if (!inFlight || e.pointerId !== inFlight.id) return;
    const rect = cv.getBoundingClientRect();
    let evs = null;
    try { evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null; } catch { evs = null; }
    if (!evs || !evs.length) evs = [e];
    for (const ev of evs) inFlight.raw.push(toGrid(rect, ev));
    invalidate();
  }
  function onUp(e) {
    if (!inFlight || e.pointerId !== inFlight.id) return;
    const real = e.type === "pointerup";
    if (real) inFlight.raw.push(toGrid(cv.getBoundingClientRect(), e));
    try { if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId); } catch {}
    const pts = quantise(inFlight.raw, real);
    inFlight = null;                  // before either exit draws, so the line isn't drawn twice
    if (!pts.length) { settle(false); return; }
    commit(strokes.concat([{ ink: 0, brush: BRUSHES[size], pts }]));
  }
  const onMenu = (e) => e.preventDefault();
  cv.addEventListener("pointerdown", onDown);
  cv.addEventListener("pointermove", onMove);
  cv.addEventListener("pointerup", onUp);
  cv.addEventListener("pointercancel", onUp);
  cv.addEventListener("contextmenu", onMenu);

  // ── the drawing's state ──────────────────────────────────────────────────────────────────
  const drawing = () => ({ palette, strokes: copyStrokes(strokes) });
  // Undo has something to do while there is history, or while there is a stroke (a reopened pad's drawing can be
  // taken back stroke by stroke, though this sheet didn't draw it).
  const undoable = () => history.length > 0 || strokes.length > 0;
  const changed = () => color !== startColor || initials !== startInitials || !sameStrokes(strokes, startStrokes);
  const said = () => ({ drawing: strokes.length ? drawing() : null, color, initials });
  function commit(next) {
    history.push(strokes);
    strokes = next;
    if (typeof opts.fit === "function" && strokes.length) {
      const f = opts.fit({ palette, strokes });
      if (f && f.eps > 0 && f.drawing) strokes = copyStrokes(f.drawing.strokes);
    }
    settle(true);
  }
  function settle(news) {
    const empty = strokes.length === 0;
    paper.toggleAttribute("data-used", !empty);
    letters.textContent = initials || madeInitials;
    // Away while there is a drawing, its space kept: when the first stroke ended, the row going made the sheet (held at
    // the bottom) shorter and the pad drop about 60 px, so a stroke begun during that jump landed off (22 Nov).
    initRow.toggleAttribute("data-away", !empty);
    initRow.inert = !empty;
    for (const b of host.querySelectorAll("[data-pad-color]")) {
      const on = b.dataset.padColor === color;
      b.setAttribute("aria-checked", String(on));
    }
    const named = colors.find((c) => c.hex === color);
    const nameEl = $("[data-pad-colorname]");
    if (nameEl) nameEl.textContent = named ? named.name : "none yet";
    for (const b of host.querySelectorAll("[data-pad-size]")) b.setAttribute("aria-pressed", String(+b.dataset.padSize === size));
    $("[data-pad-undo]").disabled = !undoable();
    $("[data-pad-clear]").disabled = empty;
    $("[data-pad-save]").disabled = !changed();
    paint();
    if (news) onChange({ drawing: drawing(), empty, color, initials });
  }

  // ── the tools ────────────────────────────────────────────────────────────────────────────
  function onClick(e) {
    const b = e.target.closest("button");
    if (!b || dead || !host.contains(b)) return;
    if (b.hasAttribute("data-pad-color")) { color = b.dataset.padColor; readColors(); settle(true); }
    else if (b.hasAttribute("data-pad-size")) { size = +b.dataset.padSize; settle(false); }
    else if (b.hasAttribute("data-pad-undo")) {
      if (history.length) strokes = history.pop();
      else if (strokes.length) strokes = strokes.slice(0, -1);
      else return;
      settle(true);
    }
    // Clear is one step of the same history, so Undo brings the whole drawing back and it needs no "are you sure".
    else if (b.hasAttribute("data-pad-clear")) { if (strokes.length) commit([]); }
    else if (b.hasAttribute("data-pad-save")) { if (changed()) opts.onSave?.(said()); }
    else if (b.hasAttribute("data-pad-initials")) opts.onInitials?.({ color, initials });
  }
  host.addEventListener("click", onClick);
  // Initials: letters and digits only, capitals, at most three; an emptied field means the ones made from the name.
  function onInitials() {
    const v = initInput.value.toUpperCase().replace(/[^\p{L}\p{N}]/gu, "").slice(0, INITIALS_MAX);
    if (initInput.value !== v) initInput.value = v;
    initials = v || madeInitials;
    settle(true);
  }
  initInput.addEventListener("input", onInitials);
  initInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); initInput.blur(); } });

  readColors();
  layout(true);
  settle(false);

  return {
    drawing,
    empty: () => strokes.length === 0,
    color: () => color,
    initials: () => initials,
    // While a picture is being saved: the tools and the paper wait, so nothing drawn is lost between the press and
    // the answer.
    busy(on) {
      for (const b of host.querySelectorAll("button")) b.disabled = on ? true : false;
      paper.toggleAttribute("data-busy", !!on);
      if (!on) settle(false);
    },
    undo: () => $("[data-pad-undo]").click(),
    clear: () => $("[data-pad-clear]").click(),
    destroy() {
      dead = true;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      ro?.disconnect();
      dprMq?.removeEventListener?.("change", onDpr);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onRestore);
      window.removeEventListener("pageshow", onRestore);
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerup", onUp);
      cv.removeEventListener("pointercancel", onUp);
      cv.removeEventListener("contextmenu", onMenu);
      host.removeEventListener("click", onClick);
      initInput.removeEventListener("input", onInitials);
      themeWatch?.disconnect();
      // A phone counts canvas memory hard: the backing store is given back now, not when it is collected.
      cv.width = cv.height = 0;
      host.innerHTML = "";
    },
  };
}

// A picture someone drew, as the pad and the faces hold it, and the markup that draws it.
//
//   { palette, strokes: [{ ink, brush, pts: [[x, y], …] }, …] }
//     palette  a place in PALETTES (palettes.js). Pictures drawn on the old pad (before 25 Nov 2026) chose one; it is still stored and
//              checked, and no longer drawn: a picture is on its owner's color now (below)
//     ink      0 or 1, stored and checked the same way, and no longer drawn: a picture has one ink
//     brush    the stroke's width in thousandths of the picture's width (the pad's three: BRUSHES). FILL (255) was the
//              old pad's "fill the circle", one very broad dot; it is skipped when a picture is drawn (below)
//     pts      integer points on a GRID x GRID square, the picture's circle inscribed in it; one point is a dot
//
// ONE BACKGROUND AND ONE DRAWING COLOR (21 Nov 2026). A picture is drawn on its owner's own color, the one that marks
// them in Split, the chat and People, with every line in the ink their initials wear on that color. Neither is in the
// markup: the ground is var(--ds-pic-ground) and the ink var(--ds-pic-ink), which the face sets from the person's tone
// (avatar.css), so a picture changes with its owner's color and with the theme exactly as their initials do, and the
// ink always reads on its ground (palette_check holds every tone's ink on its color in both themes).
//
// A FILL IS SKIPPED. Under the old palettes "fill with one ink, then draw in the other" was a picture; in one ink it
// would be a solid disc with the lines lost in it. Skipped, the lines are drawn on the owner's color.
//
// The bytes a picture is stored as, and the hash that names it, belong to the shared format module; this file is the
// one place in the client that turns them into this shape and back, so that module drops in here and nowhere else.
//
// One stroke is one SVG path string (strokePathD), and the pad's canvas strokes that same string (new Path2D(d)), so
// what the pad shows and what everybody else sees are one geometry, not two drawings of it.
import { PALETTES } from "./palettes.js";

export const GRID = 255;
export const BRUSHES = Object.freeze([22, 52, 110]);
export const FILL = 255;

/** A brush byte's width, as a share of the picture's width. */
export const widthOf = (brush) => (brush >= FILL ? 1.5 : Math.max(1, brush | 0) / 1000);

const fmt = (v) => String(Math.round(v * 100) / 100);
const pt = (p) => fmt(p[0]) + "," + fmt(p[1]);

/**
 * The `d` of one stroke, in grid units: midpoint quadratics through its points, so a finger's line doesn't facet. A
 * one-point stroke is `M p L p`, which a round cap draws as a dot (in SVG, and in a canvas Path2D made from the string).
 */
export function strokePathD(pts) {
  if (!pts || !pts.length) return "";
  if (pts.length === 1) return "M" + pt(pts[0]) + "L" + pt(pts[0]);
  let d = "M" + pt(pts[0]);
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    d += "Q" + pt(a) + " " + pt([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  }
  return d + "L" + pt(pts[pts.length - 1]);
}

const isPoint = (p) => Array.isArray(p) && p.length === 2 && p.every((v) => Number.isInteger(v) && v >= 0 && v <= GRID);

/** The drawing if it is one this client can draw, else null (and the face shows initials). Never throws. */
export function checkDrawing(d) {
  try {
    if (!d || !Number.isInteger(d.palette) || !PALETTES[d.palette] || !Array.isArray(d.strokes) || !d.strokes.length) return null;
    for (const s of d.strokes) {
      if (!s || (s.ink !== 0 && s.ink !== 1) || !Number.isInteger(s.brush) || s.brush < 1 || s.brush > FILL) return null;
      if (!Array.isArray(s.pts) || !s.pts.length || !s.pts.every(isPoint)) return null;
    }
    return d;
  } catch {
    return null;
  }
}

/** The strokes a picture draws: every stroke but a Fill (see the top of this file). */
export const drawnStrokes = (d) => d.strokes.filter((s) => s.brush < FILL);

// What a picture is painted with when nothing around it says (a face always says: avatar.css).
const GROUND = "var(--ds-pic-ground, var(--gray-3))";
const INK = "var(--ds-pic-ink, var(--ink-1))";

/**
 * The picture as an <svg> filling its box: the ground, then each stroke but a Fill, in the one ink, both read from the
 * face it sits in (see the top of this file). Round caps and joins are stated on each path, where nothing can fail to
 * inherit them. The box that holds it is round and clips it.
 */
export function pictureSvg(drawing) {
  const d = checkDrawing(drawing);
  if (!d) return "";
  let body = `<rect width="${GRID}" height="${GRID}" style="fill:${GROUND}"/>`;
  for (const s of drawnStrokes(d)) {
    body += `<path d="${strokePathD(s.pts)}" fill="none" style="stroke:${INK}" stroke-width="${fmt(widthOf(s.brush) * GRID)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return `<svg viewBox="0 0 ${GRID} ${GRID}" aria-hidden="true" focusable="false">${body}</svg>`;
}

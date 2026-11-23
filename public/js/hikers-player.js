/**
 * Draws one frame of a WeGoPlace hikers loop (format "wegoplace-hikers-loop", version 1) as SVG markup, in the wordmark's own units
 * (capital height 100, baseline y = 0, y down). Self-contained: no imports.
 *
 *   drawFrame(loop, k, { letters, counters, colorway: "void", mode: "mask", id: "logo" })  ->  "<defs>...</defs><g>...</g>"
 *
 * Put the result inside an <svg viewBox="-24 -128 818.87 140"> (the wordmark's viewBox), or inside a transformed <g>.
 * - `letters`: the letters' path data, from the wordmark SVG (<path id="letter-..." d="...">), each stroked in the colorway's letter color.
 * - `counters`: the letters' closed holes (rig.json wordmark.counters: { id, outline }), for hikers drawn behind the letters.
 * - `mode`: "mask" cuts each front item's knockout out of everything drawn before it (whatever is behind the SVG shows through the gap);
 *   "paint" draws the knockout in the ground color instead (needs `ground`).
 * - `reveal` (0-1): draws the whole logo on from left to right behind a soft edge.
 * A figure's frame may be null (not on screen). Every hiker faces right. Angles: degrees, absolute, 0 = right, clockwise +.
 */


const D2R = Math.PI / 180;
const dir = (deg) => [Math.cos(deg * D2R), Math.sin(deg * D2R)];
const add = (p, d, l) => [p[0] + d[0] * l, p[1] + d[1] * l];
const f2 = (v) => (Math.abs(v) < 5e-5 ? "0" : v.toFixed(3).replace(/\.?0+$/, ""));
const pathD = (pts, closed = false) => "M" + pts.map((p) => `${f2(p[0])} ${f2(p[1])}`).join(" L") + (closed ? " Z" : "");


/** A hiker's parts, back to front: far leg, far arm, pack, torso, near leg, head, binoculars, near arm. */
function parts(loop, q, C) {
  const SK = loop.draw.skeleton, B = SK.bones, b = {};
  loop.bones.forEach((n, i) => { b[n] = q.a[i]; });
  const L = (n) => B[n].length;
  const p = q.p;
  const chest = add(p, dir(b.torso), L("torso")), head = add(chest, dir(b.head), L("head"));
  const arm = (s) => { const e = add(chest, dir(b[`upper_arm_${s}`]), L(`upper_arm_${s}`)); return [chest, e, add(e, dir(b[`forearm_${s}`]), L(`forearm_${s}`))]; };
  const leg = (s) => { const k = add(p, dir(b[`thigh_${s}`]), L(`thigh_${s}`)), a = add(k, dir(b[`shin_${s}`]), L(`shin_${s}`)); return [p, k, a, add(a, dir(b[`foot_${s}`]), L(`foot_${s}`))]; };
  const h = C.hikers[((q.tint % C.hikers.length) + C.hikers.length) % C.hikers.length];
  const lw = loop.draw.limbWidth, tw = B.torso.width, lean = b.torso + 90;
  const pk = SK.pack, mx = (p[0] + chest[0]) / 2, my = (p[1] + chest[1]) / 2;
  const ca = Math.cos(lean * D2R), sa = Math.sin(lean * D2R), off = -(tw / 2 + pk.w / 2 - 1.6);
  const cx = mx + off * ca + 1.0 * sa, cy = my + off * sa - 1.0 * ca;
  const out = [
    { label: "leg_f", geo: { kind: "path", pts: leg("f"), w: lw }, color: h.shade },
    { label: "arm_f", geo: { kind: "path", pts: arm("f"), w: lw }, color: h.shade },
    { label: "pack", geo: { kind: "rect", x: cx - pk.w / 2, y: cy - pk.h / 2, w: pk.w, h: pk.h, r: pk.r, rot: lean, cx, cy }, color: h.pack },
    { label: "torso", geo: { kind: "path", pts: [p, chest], w: tw }, color: h.figure },
    { label: "leg_n", geo: { kind: "path", pts: leg("n"), w: lw }, color: h.figure },
    { label: "head", geo: { kind: "circle", c: head, r: B.head.radius }, color: h.figure },
  ];
  if (q.bino) out.push({ label: "binoculars", geo: { kind: "path", pts: q.bino, w: loop.draw.props.binoculars.thickness }, color: C.binoculars });
  out.push({ label: "arm_n", geo: { kind: "path", pts: arm("n"), w: lw }, color: h.figure });
  return out;
}

function geoSvg(g, color, grow = 0) {
  if (g.kind === "path") return `<path d="${pathD(g.pts)}" stroke="${color}" stroke-width="${f2(g.w + 2 * grow)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  if (g.kind === "circle") return `<circle cx="${f2(g.c[0])}" cy="${f2(g.c[1])}" r="${f2(g.r + grow)}" fill="${color}"/>`;
  return `<rect x="${f2(g.x - grow)}" y="${f2(g.y - grow)}" width="${f2(g.w + 2 * grow)}" height="${f2(g.h + 2 * grow)}" rx="${f2(g.r + grow)}" fill="${color}" transform="rotate(${f2(g.rot)} ${f2(g.cx)} ${f2(g.cy)})"/>`;
}

function figItem(loop, q, C, sel) {
  const ps = parts(loop, q, C).filter((x) => sel(x.label));
  if (!ps.length) return null;
  const g = loop.draw.knockout.width, shade = C.hikers[((q.tint % C.hikers.length) + C.hikers.length) % C.hikers.length].shade;
  // the near arm has a rim in the shade color under it, 1.5 wider
  const draw = ps.map((x) => (x.label === "arm_n" && x.geo.kind === "path" ? `<path d="${pathD(x.geo.pts)}" stroke="${shade}" stroke-width="${f2(x.geo.w + 1.5)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` : "") + geoSvg(x.geo, x.color)).join("");
  return { draw, knock: (ink) => ps.map((x) => geoSvg(x.geo, ink, g)).join("") };
}
const lineItem = (pts, color, w, g) => ({
  draw: `<path d="${pathD(pts)}" stroke="${color}" stroke-width="${f2(w)}" stroke-linecap="round" fill="none"/>`,
  knock: (ink) => `<path d="${pathD(pts)}" stroke="${ink}" stroke-width="${f2(w + 2 * g)}" stroke-linecap="round" fill="none"/>`,
});

/** Frame k of a loop as SVG children. */
export function drawFrame(loop, k, o) {
  const C = loop.colorways[o.colorway], id = o.id ?? "hikers", vb = o.viewBox ?? [-24, -128, 818.87, 140], g = loop.draw.knockout.width;
  const defs = o.counters.map((c) => `<clipPath id="${id}-${c.id}"><path d="${pathD(c.outline, true)}"/></clipPath>`);
  defs.push(`<clipPath id="${id}-above" clipPathUnits="userSpaceOnUse"><rect x="-4000" y="-4000" width="8000" height="4000"/></clipPath>`);
  const figs = loop.figures.map((f) => f.frames[k]).filter((q) => !!q);
  // behind the letters: hidden by their ink, seen through the counters and past their edges; a clip keeps one counter's inside; nothing
  // behind shows below the baseline
  const behind = figs.filter((q) => q.layer === "behind").map((q) => {
    const it = figItem(loop, q, C, (l) => !q.front.includes(l));
    if (!it) return "";
    return `<g clip-path="url(#${id}-above)">${q.clip ? `<g clip-path="url(#${id}-${q.clip})">${it.draw}</g>` : it.draw}</g>`;
  }).join("");
  const letters = o.letters.map((l) => `<path d="${l.d}" stroke="${C.letter}" stroke-width="${o.letterStroke ?? 17.5}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`).join("");
  // in front: the props, then the hikers (and any part of a behind hiker listed in front)
  const items = [];
  const rope = loop.props.rope[k], flag = loop.props.flag[k], down = loop.props.binocularsDown[k];
  if (rope && rope.length) items.push(lineItem(rope, C.rope, loop.draw.props.rope.thickness, g));
  items.push(lineItem(loop.props.pole, C.pole, loop.draw.props.pole.thickness, g));
  if (flag && flag.length) {
    const d = pathD(flag, true), sw = loop.draw.props.flag.stroke;
    items.push({ draw: `<path d="${d}" fill="${C.flag}" stroke="${C.flag}" stroke-width="${sw}" stroke-linejoin="round"/>`, knock: (ink) => `<path d="${d}" fill="${ink}" stroke="${ink}" stroke-width="${f2(2 * g + sw)}" stroke-linejoin="round"/>` });
  }
  if (down) {
    const L = loop.draw.props.binoculars.length / 2, d = dir(down.angle);
    items.push(lineItem([[down.center[0] - d[0] * L, down.center[1] - d[1] * L], [down.center[0] + d[0] * L, down.center[1] + d[1] * L]], C.binoculars, loop.draw.props.binoculars.thickness, g));
  }
  for (const q of figs) {
    const it = q.layer === "front" ? figItem(loop, q, C, () => true) : figItem(loop, q, C, (l) => q.front.includes(l));
    if (it) items.push(it);
  }
  let body;
  if (o.mode === "paint") {
    const ink = o.ground ?? C.ground;
    body = `<rect x="${vb[0]}" y="${vb[1] - 400}" width="${vb[2]}" height="${vb[3] + 800}" fill="${ink}"/>` + behind + letters + items.map((it) => `<g>${it.knock(ink)}</g>${it.draw}`).join("");
  } else {
    let acc = behind + letters;
    items.forEach((it, i) => {
      defs.push(`<mask id="${id}-ko${i}" maskUnits="userSpaceOnUse" x="-2000" y="-2000" width="4000" height="4000"><rect x="-2000" y="-2000" width="4000" height="4000" fill="#fff"/>${it.knock("#000")}</mask>`);
      acc = `<g mask="url(#${id}-ko${i})">${acc}</g>${it.draw}`;
    });
    body = acc;
  }
  const reveal = o.reveal ?? 1;
  if (reveal < 1) {
    const edge = reveal * 1.06 * 100;
    defs.push(`<linearGradient id="${id}-rev" gradientUnits="userSpaceOnUse" x1="${vb[0]}" y1="0" x2="${vb[0] + vb[2]}" y2="0"><stop offset="${Math.max(0, edge - 6)}%" stop-color="#fff" stop-opacity="1"/><stop offset="${Math.max(0.001, edge)}%" stop-color="#fff" stop-opacity="0"/></linearGradient>`);
    defs.push(`<mask id="${id}-revm" maskUnits="userSpaceOnUse" x="${vb[0]}" y="${vb[1] - 200}" width="${vb[2]}" height="${vb[3] + 400}"><rect x="${vb[0]}" y="${vb[1] - 200}" width="${vb[2]}" height="${vb[3] + 400}" fill="url(#${id}-rev)"/></mask>`);
    body = `<g mask="url(#${id}-revm)">${body}</g>`;
  }
  return `<defs>${defs.join("")}</defs>${body}`;
}

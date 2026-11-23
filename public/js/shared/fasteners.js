// The fasteners (thumbtacks and magnets) for every renderer: where one sits on a print (fastenerGeometry, in board
// units), which one (fastHash: the same stream for every renderer of a board), and its look (TACKS and MAGNETS per
// theme, and the DOM recipe tackStyle/magnetStyle). The canvas twins stay in collage-frames.js. A leaf: no imports,
// no DOM, so the app, the export and a shared board's page (the Worker) draw the same fastener on the same photo.

/** The fastener stream for one print of a board: FNV-1a over the board's seed and the item's id. */
export function fastHash(seed, id) {
  const str = String(seed || 0) + ":" + String(id) + ":fast";
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/**
 * WHERE THE FASTENER SITS, and how big it is. Here, in the geometry module, because both
 * renderers must place it identically and this file is already the one that owns "where things
 * are" — item boxes, frame pads, bounds. A second copy of these numbers in either renderer is
 * exactly the drift the export/screen parity check exists to catch.
 *
 * `hash` is the caller's deterministic stream (FNV-1a over seed + item id). It chooses the
 * colour variant and nudges the seat a pixel or two, because twelve identical tacks in a row
 * reads as a UI and not as a board somebody pinned.
 *
 * THE OVERHANG IS BUDGETED. A fastener hangs above the print's top edge, inside the board's margin
 * (collage-layout.js boardOf: at least 40 canvas units). The clamp below keeps the worst case (a
 * magnet on a wide print, nudged up) well inside it.
 */
export function fastenerGeometry(kind, fb, hash) {
  const magnet = kind === "magnet";
  // Proportional to the print, then clamped: big prints must not grow comedy tacks, and a
  // thumbnail-sized print must still get an object rather than a smudge. 13 is the floor the
  // exploration found readable; below it the head stops reading as a head.
  // BIGGER THAN THE FIRST PASS. At 13-30 canvas units a tack rendered into a whole-board
  // export came out 15-20 device pixels across, where the dome ramp, the moulded ring and the
  // specular all collapse into one blob — the push pins were just dots and looked
  // nothing like push pins. A real pushpin next to a 4x6 print is about a fifth of its short
  // edge, and that is what these numbers now say.
  const raw = fb.w * (magnet ? 0.20 : 0.175);
  const d = Math.max(22, Math.min(magnet ? 58 : 52, raw));
  // Seat: centred across the print, overlapping its top edge. A tack sits higher (its pin goes
  // INTO the board above the photo); a magnet clamps the paper, so it rides lower.
  const jx = ((hash >>> 3) % 5) - 2;              // -2..2 px
  const jy = ((hash >>> 7) % 3) - 1;              // -1..1 px
  return {
    d,
    left: Math.round(fb.w / 2 - d / 2 + jx),
    top: Math.round(-d * (magnet ? 0.34 : 0.42) + jy),
    variant: (hash >>> 11) % 3,
  };
}

/* Shadow ink per theme family — the same split FRAME_SHADOW makes: warm soot in
 * daylight, true black under the lamp, with heavier alphas in the dark because a
 * dark ground swallows a light shadow whole. */
export const SHADOW_RGB = { light: "31,25,14", dark: "0,0,0" };
export const SHADOW_A = {
  light: { soft: 0.26, mid: 0.22, tight: 0.42, ambient: 0.15, ring: 0.12 },
  dark:  { soft: 0.44, mid: 0.34, tight: 0.60, ambient: 0.26, ring: 0.22 },
};
/* Specular ink: white daylight, warm lamp. The dark theme's highlight is the one
 * thing that must NOT dim with the body — gloss under a lamp is brighter relative
 * to its object, and the highlight is half of how a 14px tack stays legible on a
 * dark ground at all. */
export const SPEC_RGB = { light: "255,255,255", dark: "255,244,224" };

/* Value-separated triads. hi/mid/lo/rim are the dome ramp top→edge; `metal` adds
 * the brass variant's warm bounce-light at the foot of the dome (metal reflects its
 * environment; plastic does not). */
export const TACKS = {
  light: [
    { name: "oxblood", hi: "#da7160", mid: "#a23430", lo: "#611713", rim: "#41100c" },
    { name: "bone",    hi: "#fbf4e4", mid: "#e2d5b8", lo: "#9f8e6a", rim: "#6b5c42" },
    { name: "brass",   hi: "#f4e6b4", mid: "#c9a24a", lo: "#7c5e20", rim: "#4a370f", metal: true },
  ],
  dark: [
    { name: "oxblood", hi: "#b5544a", mid: "#7e241f", lo: "#43100d", rim: "#260807" },
    { name: "bone",    hi: "#e2d7c0", mid: "#bcae90", lo: "#78694c", rim: "#4a3f2c" },
    { name: "brass",   hi: "#d8c184", mid: "#a07c2f", lo: "#5c4414", rim: "#33250a", metal: true },
  ],
};

/* Magnet faces: hi/mid/lo is the satin face ramp, `side` the cylinder wall. */
export const MAGNETS = {
  light: [
    { name: "cream",    hi: "#f8f3e8", mid: "#e8dfcb", lo: "#c0b59b", side: "#6d6450" },
    { name: "navy",     hi: "#56719a", mid: "#3c5175", lo: "#263650", side: "#131d2e" },
    { name: "charcoal", hi: "#71757b", mid: "#50545a", lo: "#35383d", side: "#17191c" },
  ],
  dark: [
    { name: "cream",    hi: "#e3d9c4", mid: "#c4b99f", lo: "#948a70", side: "#453e2e" },
    { name: "navy",     hi: "#46608a", mid: "#2e4162", lo: "#1b2740", side: "#0c1420" },
    { name: "charcoal", hi: "#5c6066", mid: "#3e4247", lo: "#26282c", side: "#0f1113" },
  ],
};

export const px = function (n) { return n.toFixed(2) + "px"; };

/* ── THUMBTACK, DOM half ──────────────────────────────────────────────────────
 * One element, border-radius:50%. Layers top→bottom:
 *   1 specular  — small hard-edged hotspot at 50% 24% (a glossy dome under a
 *                 ceiling light), clamped so its core never drops under ~1px.
 *   2 (brass)   — warm bounce at the dome's foot.
 *   3 dome      — radial ramp from hi at 50% 30% out to rim at the edge; the rim
 *                 stop doubles as the silhouette, so the head needs no outline on
 *                 any backdrop.
 * box-shadow (shape follows border-radius, so a round head costs box-shadow money
 * for a correct round shadow — the .cg-play disc precedent, never drop-shadow):
 *   inset bottom AO  — the dome turning away from the light,
 *   mid + soft casts — both offset straight down; the SOFT one lands well clear of
 *                      the silhouette, and that visible separation is the pin. */
/* The first cut of this ramp (hi→mid at 42%, lo by 75%) shaded the head like a
 * BALL — the test sheet's 32/48px rows read as billiard balls, because symmetric
 * edge-darkening plus a soft round specular is the signature of a sphere, not of
 * a shallow dome. A pushpin head is flat-ish: broad even top light, and the turn
 * to dark happens only in the outer ~12%. Same reason the specular tightened
 * (small and hard = moulded plastic; big and soft = glass) and the cast shadow
 * pulled in (a pin holds the head ~a head-height off the board, not two). */
export function tackStyle(d, c, theme) {
  var spec = SPEC_RGB[theme], sh = SHADOW_RGB[theme], a = SHADOW_A[theme];
  var core = Math.max(0.9, d * 0.05);
  var midR = Math.max(1.5, d * 0.09);
  var endR = Math.max(2.6, d * 0.17);
  var layers = [
    "radial-gradient(circle at 50% 22%, rgba(" + spec + ",.95) 0 " + px(core) +
      ", rgba(" + spec + ",.42) " + px(midR) + ", rgba(" + spec + ",0) " + px(endR) + ")",
  ];
  if (c.metal) {
    layers.push(
      "radial-gradient(circle at 50% 82%, rgba(255,240,205,.38) 0 " + px(d * 0.08) +
        ", rgba(255,240,205,0) " + px(d * 0.26) + ")"
    );
  }
  // The moulded plateau: pushpin heads are not smooth hemispheres — the top is a
  // flat-ish disc and the slope starts at a visible edge. A faint dark ring at
  // ~30% radius (with a whisper of lift inside it) is that edge. At 14px the ring
  // collapses to under a pixel and politely vanishes; at 32px it is most of what
  // separates "pushpin" from "marble".
  var ringR = d * 0.30, ringT = Math.max(1, d * 0.05);
  layers.push(
    "radial-gradient(circle at 50% 38%, rgba(" + spec + ",.08) 0 " + px(ringR - ringT) +
      ", rgba(0,0,0,.13) " + px(ringR) + ", rgba(0,0,0,0) " + px(ringR + ringT) + ")"
  );
  layers.push(
    "radial-gradient(circle at 50% 34%, " + c.hi + " 0%, " + c.hi + " 26%, " + c.mid + " 62%, " +
      c.lo + " 90%, " + c.rim + " 100%)"
  );
  return {
    width: px(d), height: px(d), borderRadius: "50%",
    background: layers.join(","),
    boxShadow: [
      // Bounce light at the dome's foot — the board reflects into the plastic. A
      // sphere goes black at its lower limb; a dome over a lit surface does not,
      // and this thin warm line is most of the difference between the two.
      "inset 0 " + px(-Math.max(1, d * 0.03)) + " " + px(Math.max(1, d * 0.05)) +
        " rgba(255,236,205," + (theme === "dark" ? 0.16 : 0.22) + ")",
      "inset 0 " + px(-d * 0.05) + " " + px(d * 0.09) + " rgba(0,0,0," + (theme === "dark" ? 0.30 : 0.22) + ")",
      "0 " + px(d * 0.08) + " " + px(d * 0.07) + " rgba(" + sh + "," + a.tight + ")",
      "0 " + px(d * 0.17) + " " + px(d * 0.20) + " rgba(" + sh + "," + a.soft + ")",
    ].join(","),
  };
}

/* ── MAGNET, DOM half ─────────────────────────────────────────────────────────
 * One element again. Face = vertical linear ramp (a flat top face, not a dome);
 * sheen = broad soft ellipse (satin scatters, so wide and dull where the tack's
 * is small and hard); side wall = a zero-blur inset crescent at the foot (a hard
 * edge because it is geometry, not shading); glint = 1px inset top light where
 * the face's edge catches the ceiling. Outside: tight contact shadow, a whisper
 * of ambient, and a faint zero-offset AO ring so a cream magnet keeps a
 * silhouette on a cream polaroid border — occlusion, not an outline. */
/* First cut was a vertical linear ramp over the whole circle with a thin inset
 * crescent — it photographed as a blueberry. What reads as a CYLINDER is the top
 * face drawn as its own hard-edged ELLIPSE (rx 46%, ry 40%, centre lifted to 41%)
 * over a wall that owns the whole silhouette: the bottom ~19% of wall showing
 * beneath the face's curve is the perspective cue, and the face's own shading is
 * radial (centre-lit satin) rather than linear. The face ellipse ends by blending
 * into the wall colour across its last 3% so the edge stays anti-aliased at 14px.
 * Shadows hug: a magnet is FLUSH, so contact dominates and ambient barely offsets
 * — the elevated-vs-flush shadow story is the tack/magnet substance split. */
export function magnetStyle(d, c, theme) {
  var spec = SPEC_RGB[theme], sh = SHADOW_RGB[theme], a = SHADOW_A[theme];
  var sheenA = theme === "dark" ? 0.32 : 0.30;
  var glintA = theme === "dark" ? 0.50 : 0.40;
  return {
    width: px(d), height: px(d), borderRadius: "50%",
    backgroundColor: c.side,
    backgroundImage: [
      // The ceiling in the face: a FLAT gloss face reflects the room's light as a
      // wide horizontal band running to the edges, where a dome reflects it as a
      // point — this band is the single strongest "flat object" cue at any size.
      "linear-gradient(180deg, rgba(" + spec + ",0) 10%, rgba(" + spec + "," + sheenA + ") 21%, rgba(" +
        spec + "," + sheenA + ") 31%, rgba(" + spec + ",0) 46%)",
      // The face itself: FLAT — hi to mid across the whole disc, the darkening
      // confined to a thin rim (gradual edge-darkening is what curvature looks
      // like, and curvature is the tack's property, not the magnet's).
      "radial-gradient(" + px(d * 0.92) + " " + px(d * 0.76) + " at 50% 40%, " + c.hi + " 0%, " +
        c.mid + " 74%, " + c.mid + " 90%, " + c.lo + " 96%, " + c.side + " 98.5%, rgba(0,0,0,0) 100%)",
    ].join(","),
    boxShadow: [
      "inset 0 " + px(Math.max(1, d * 0.04)) + " " + px(Math.max(1, d * 0.04)) + " rgba(" + spec + "," + glintA + ")",
      "inset 0 " + px(-Math.max(1, d * 0.03)) + " " + px(d * 0.03) + " rgba(0,0,0," + (theme === "dark" ? 0.42 : 0.35) + ")",
      "0 " + px(d * 0.045) + " " + px(d * 0.05) + " rgba(" + sh + "," + a.tight + ")",
      "0 " + px(d * 0.09) + " " + px(d * 0.14) + " rgba(" + sh + "," + a.ambient + ")",
      "0 0 0 " + px(Math.max(0.6, d * 0.025)) + " rgba(" + sh + "," + a.ring + ")",
    ].join(","),
  };
}


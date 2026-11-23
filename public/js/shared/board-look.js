// How the photo board looks, for every renderer: the app's board (collage.js), the saved image and video
// (collage-export.js, collage-frames.js) and a shared board's page (src/share-page.js, written by the Worker).
// A leaf: no imports, no DOM, so the Worker and the browser read the same values and nothing has to be copied.

/**
 * THE GROUND REGISTRY. One declaration, consumed by both renderers.
 *
 * It used to be three. `collage.js` carried a private table of CSS gradients with four keys;
 * `collage-frames.js` carried a second table with three keys and its own canvas textures; and
 * the list right here gated which keys could ever be CHOSEN. They disagreed on every colour —
 * corkboard was #c9a678 on screen and #c2a173 in the export — and because `slate` existed in
 * exactly one of the three, it was a ground no code path could reach: unselectable, and if it
 * had been selectable the export would have silently fallen back to corkboard.
 *
 * So a ground is declared HERE, once. This module is a leaf — it imports nothing — which is
 * why it can be the shared source without a cycle.
 *
 * WHAT LIVES HERE is identity: the key, the human label, the base colours per theme family,
 * and THE FASTENER. That last one is the whole point of the rule —
 * the fastener is a property of the GROUND, not of the photo: pick a ground, get its
 * fastener — and it is a property of the ground precisely because it is written on the
 * ground's own row and nowhere else.
 *
 * THE TEXTURE lives in this file too (GRAIN, below): CSS for the app and a shared board's page. The
 * export paints the drawn grounds with seeded ellipses on a canvas (collage-frames.js), and the
 * Corkboard from the same cork photograph; all of them take their COLOURS from this table.
 */
export const GROUNDS = {
  corkboard: { label: "Corkboard", fastener: "tack",
               fill: { light: "#c9a678", dark: "#40301f" } },
  paper:     { label: "Paper",     fastener: "tack",
               fill: { light: "#efe8dc", dark: "#2e2923" } },
  linen:     { label: "Linen",     fastener: "tack",
               fill: { light: "#e3ded3", dark: "#2b2722" } },
  slate:     { label: "Slate",     fastener: "magnet",
               fill: { light: "#5a5651", dark: "#2a2724" } },
  // The magnet board: any ground that could be a fridge door or the like, with magnets
  // holding the pictures up.
  // Cool enamelled steel, so the magnets have something to be magnetic about.
  fridge:    { label: "Fridge",    fastener: "magnet",
               fill: { light: "#dfe3e6", dark: "#2d3136" } },
};


/**
 * HOW THE BOARD LOOKS, for every renderer (the app's CSS, the export's canvas, a shared board's page).
 *   wall    the paint, per theme family.
 *   cork    the Corkboard's material is a photograph of cork (public/textures/cork.jpg: Cork 003, ambientCG, CC0),
 *           tiled at `tile` canvas px; at Night a dark warm wash over it (`night`): the same cork in a dim room.
 *   frame   the board's edge, canvas px: Corkboard and Slate a wooden frame (`wood`, darker at Night); Paper and
 *           Linen a darker edge line (`line`); Fridge rounded corners (`radius`) and a fine line.
 */
export const BOARD_LOOK = {
  // Day: a warm grey every material stands off (paper and fridge lighter, cork, linen and slate darker or textured).
  // Night: darker than every material, so the board reads as lit against the room.
  wall: { light: "#d3cbbd", dark: "#151311" },
  // The cork's tile grows with the board (tileFrac of its shorter side, never under `tile` units): a fixed tile on a
  // whole board seen on a phone came out a few pixels across, and cork that fine reads as flat brown.
  cork: { url: "/textures/cork.jpg", tile: 180, tileFrac: 0.25, night: "rgba(24,14,6,.48)" },
  frame: {
    corkboard: { kind: "wood", width: 14 }, slate: { kind: "wood", width: 14 },
    paper: { kind: "line", width: 2 }, linen: { kind: "line", width: 2 },
    fridge: { kind: "enamel", width: 1, radius: 22 },
  },
  // The wood frame is at least frame.width and frameFrac of the board's shorter side, in board units: a board's
  // frame grows with it, so it still reads as a frame when the whole of a big board is on a phone.
  frameFrac: 0.025,
  // HAIRLINES, in SCREEN px (a page's CSS px; never scaled by the camera): the paper/linen edge line, the enamel's
  // line, and the Night rim. A line in board units would be a fraction of a pixel with the whole board on a phone.
  hair: { line: 1.5, enamel: 1, rim: 1 },
  wood: { light: "#8a6440", dark: "#4a3420" },
  line: { light: "rgba(60,48,30,.28)", dark: "rgba(255,240,214,.16)" },
  enamel: { light: "rgba(40,50,60,.30)", dark: "rgba(255,255,255,.12)" },
  // The wood frame's fine inner line, where the frame meets the material.
  woodInner: "rgba(40,26,12,.55)",
  // The board's one soft shadow on the wall, as CSS box-shadow (the export folds it into one canvas blur).
  shadow: {
    light: "0 6px 14px rgb(40 30 20 / .22),0 22px 48px rgb(40 30 20 / .20)",
    dark: "0 8px 20px rgb(0 0 0 / .55),0 30px 70px rgb(0 0 0 / .60)",
  },
  // THE LAMP'S POOL: a broad, gentle light on the wall centred on the board, so the board hangs on a wall in a room
  // rather than sits on black. A circle `size` times the board's longer side across, lightest at the middle (`light`/
  // `dark` is the colour laid over the wall there) and fading to the wall at its edge. One radial gradient, dithered
  // by a faint noise over the whole circle (never a tile), so it doesn't band.
  pool: { size: 2.4, light: "rgba(255,252,244,.42)", dark: "rgba(255,226,186,.11)", noise: 0.035 },
  // At Night a shadow can't show on a wall this dark: a thin lit rim (hair.rim screen px) just outside the board's
  // edge marks it as well as its material does (colour is never the only edge).
  rim: { dark: "rgba(255,236,206,.30)" },
};

// The drawn grounds' grain: repeating gradients, no image (the Corkboard is the one photograph, below).
const WEAVE = (a, b) =>
  `repeating-linear-gradient(90deg, ${a} 0 1px, transparent 1px 3px),` +
  `repeating-linear-gradient(0deg, ${b} 0 1px, transparent 1px 3px)`;

// BRUSHED STEEL. Fine vertical striations plus a broad diagonal sheen — the two things that
// make a flat grey read as metal rather than as card.
const BRUSHED = (a, b, sheen) =>
  `linear-gradient(104deg, transparent 0 38%, ${sheen} 50%, transparent 62% 100%),` +
  `repeating-linear-gradient(90deg, ${a} 0 1px, transparent 1px 2px),` +
  `repeating-linear-gradient(90deg, ${b} 0 1px, transparent 1px 5px)`;

// THE GRAIN, per ground, per theme family. Colours are NOT here — they come from GROUNDS above,
// which is the whole point of unifying it. This table is only the texture,
// which is genuinely CSS-specific: the export paints the same grounds with seeded ellipses on
// a canvas, because a canvas has no `repeating-linear-gradient`.
// THE CORK is a photograph of cork, the one a shared board's page has always drawn (BOARD_LOOK.cork: the same
// file, tile and Night wash in the app, the export and on /s/).
const CORK_URL = BOARD_LOOK.cork.url;
export const CORK_TILE = BOARD_LOOK.cork.tile;
/** The cork's tile on a board, in board units (the app, the export and a shared board's page all use it). */
export const corkTileOf = (board) => Math.max(BOARD_LOOK.cork.tile, BOARD_LOOK.cork.tileFrac * Math.min(board.w, board.h));
/** The wood frame's width on a board, in board units. */
export const woodOf = (board) => Math.max(BOARD_LOOK.frame.corkboard.width, BOARD_LOOK.frameFrac * Math.min(board.w, board.h));
const CORK_NIGHT = BOARD_LOOK.cork.night;
export const GRAIN = {
  corkboard: {
    light: `url("${CORK_URL}")`,
    dark: `linear-gradient(${CORK_NIGHT},${CORK_NIGHT}),url("${CORK_URL}")`,
  },
  paper: {
    light: "repeating-linear-gradient(96deg, rgba(120,104,78,.055) 0 1px, transparent 1px 4px),"
         + "repeating-linear-gradient(6deg, rgba(120,104,78,.045) 0 1px, transparent 1px 5px),"
         + "radial-gradient(circle at 30% 40%, rgba(140,120,90,.07) 0 1.6px, transparent 2.2px)",
    dark: "repeating-linear-gradient(96deg, rgba(255,240,214,.045) 0 1px, transparent 1px 4px),"
        + "repeating-linear-gradient(6deg, rgba(255,240,214,.035) 0 1px, transparent 1px 5px),"
        + "radial-gradient(circle at 30% 40%, rgba(255,236,206,.05) 0 1.6px, transparent 2.2px)",
  },
  linen: {
    light: WEAVE("rgba(90,82,64,.07)", "rgba(90,82,64,.06)"),
    dark: WEAVE("rgba(255,246,226,.05)", "rgba(255,246,226,.04)"),
  },
  slate: {
    light: "radial-gradient(circle at 30% 30%, rgba(255,255,255,.06) 0 1.2px, transparent 1.8px),"
         + "radial-gradient(circle at 72% 66%, rgba(0,0,0,.10) 0 1px, transparent 1.5px)",
    dark: "radial-gradient(circle at 30% 30%, rgba(255,255,255,.045) 0 1.2px, transparent 1.8px),"
        + "radial-gradient(circle at 72% 66%, rgba(255,255,255,.03) 0 1px, transparent 1.5px)",
  },
  fridge: {
    light: BRUSHED("rgba(255,255,255,.55)", "rgba(120,132,142,.10)", "rgba(255,255,255,.30)"),
    dark: BRUSHED("rgba(255,255,255,.045)", "rgba(0,0,0,.18)", "rgba(255,255,255,.06)"),
  },
};


// The wall's paint: plain. A grain drawn as a repeating tile reads as a pattern of dots on a wall this large (it did,
// on the first stills), and paint has none; the board's own material is the only texture.
export const WALL_GRAIN = { light: "none", dark: "none" };

// The lamp's pool's dither (BOARD_LOOK.pool.noise): an SVG fractal noise drawn as large as the pool, never tiled, a CSS
// background-image for the app's board and a shared board's page.
export const POOL_NOISE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100%25' height='100%25'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;


// GET /s/<id>            the public face of a shared collage. NO SESSION, and that is the point.
// GET /s/<id>/image      the flattened board, retained for link previews and old shares
// GET /s/<id>/video      the flattened looping render, retained for old shares
// GET /s/<id>/i/<n>      ONE photo or video, at its own full resolution
//
// This is the only surface a stranger ever sees, so it is a page rather than an
// app route: no service worker, no store, no module graph, no login. The original media and
// their layout render with JavaScript switched off; JavaScript only adds the lightbox.
//
// THE TRIP IS THE PAGE: the focus is almost wholly the trip, with the wordmark small in the top
// right. So there is no header, no title
// block, no byline, no footer and no call to action — the board is the content and everything
// else is a 74px wordmark in a corner. The earlier version had a heading, a subtitle, a framed
// card and a "Make your own" button, which is most of a landing page wrapped around somebody's
// holiday.
//
// AND NO CTA AT ALL, deliberately: "don't add a make your own cta or anything right now
// actually since we don't have that functionality yet to make a trip." A button that promises
// something the app cannot do is worse than no button.
//
// THE ORIGINALS ARE THE BOARD. A flattened canvas is capped at 4096px and permanently throws
// away detail before this page even opens. Shares with migration-0014 item rows therefore lay
// out those original photo/video files as real DOM media: the browser may display them small,
// but it retains the source pixels for hover and native-pixel zoom. The flattened render stays
// only as the Open Graph image and as a graceful fallback for older shares without item rows.
//
// THE TRIP STILL IS NOT ON IT. The rows carry image keys and geometry. No captions, no names,
// no dates, no itinerary — someone who guesses an id gets photographs and nothing else.
import { BOARD_LOOK, GRAIN, GROUNDS, POOL_NOISE, WALL_GRAIN, corkTileOf, woodOf } from "../public/js/shared/board-look.js";
import { MAGNETS, TACKS, fastHash, fastenerGeometry, magnetStyle, tackStyle } from "../public/js/shared/fasteners.js";
import { rangedGet } from "./media-files.js";

// THE BOARD ON THE WALL (migration 0041). A share's picture is its board plus a band of the wall round it, and the share
// keeps where the board is in it, its material and its scale, so this page draws the same board on the same wall as the
// app (one look: public/js/shared/board-look.js, imported, never copied). A share made before has none of that: its
// whole picture is the board, a corkboard, on the wall.
/** Board units to this page's logical pixels, for a share made before 0041: its old cork tile was 300 px, BOARD_LOOK's is 180 units. */
const LEGACY_UNIT = 300 / BOARD_LOOK.cork.tile;
const GRAIN_TILE = 96;   // board units per grain tile, as the app's (collage.js GROUND_TILE); the cork's grows with the board (corkTileOf)
/** Every px length in a CSS value (a box-shadow) times f. */
const scalePx = (css, f) => css.replace(/(-?\d*\.?\d+)px/g, (_, n) => `${+(Number(n) * f).toFixed(2)}px`);

/**
 * The board panel's CSS for one share, light and dark, in this page's logical px (u a board unit): its material (the
 * cork's tile grows with the board, corkTileOf), the wood frame (Corkboard and Slate, woodOf), its shadow, as the app's.
 * A board's fine lines are not here: they are screen pixels, on .board-edge (edgeCss). `units` is the board's size in
 * board units; a share made before 0041 (`legacy`) keeps its cork at the old 300 px a tile.
 */
function boardCss(ground, u, units, legacy) {
  const g = GROUNDS[ground] ? ground : "corkboard";
  const frame = BOARD_LOOK.frame[g];
  const tile = (g === "corkboard" ? (legacy ? BOARD_LOOK.cork.tile : corkTileOf(units)) : GRAIN_TILE) * u;
  const wood = frame.kind === "wood";
  const width = wood ? woodOf(units) * u : 0;
  const inner = wood ? `,inset 0 0 0 ${+u.toFixed(3)}px ${BOARD_LOOK.woodInner}` : "";
  const look = (lum) => `background-color:${GROUNDS[g].fill[lum]};background-image:${GRAIN[g][lum]};`
    + (wood ? `border-color:${BOARD_LOOK.wood[lum]};` : "") + `box-shadow:${scalePx(BOARD_LOOK.shadow[lum], u)}${inner}`;
  return `.board-panel{position:absolute;z-index:0;pointer-events:none;box-sizing:border-box;border-style:solid;`
    + `border-width:${+width.toFixed(3)}px;border-radius:${+((frame.radius || 0) * u).toFixed(3)}px;`
    + `background-repeat:repeat;background-size:${+tile.toFixed(3)}px ${+tile.toFixed(3)}px;${look("light")}}\n`
    + `  @media (prefers-color-scheme:dark){.board-panel{${look("dark")}}}`;
}

/**
 * The board's fine lines, in SCREEN px (BOARD_LOOK.hair), never scaled by the camera: Paper's and Linen's edge line, the
 * Fridge's enamel line, and at Night a lit rim round every board. Drawn on .board-edge, outside the scaled board and
 * placed over the panel from the camera on every frame, as the app's .cg-edge.
 */
function edgeCss(ground) {
  const kind = BOARD_LOOK.frame[ground]?.kind;
  const line = kind === "line" ? ["line", BOARD_LOOK.hair.line] : kind === "enamel" ? ["enamel", BOARD_LOOK.hair.enamel] : null;
  return `.board-edge{position:absolute;left:0;top:0;pointer-events:none;box-sizing:border-box;transform-origin:0 0`
    + (line ? `;border:${line[1]}px solid ${BOARD_LOOK[line[0]].light}` : "") + `}\n`
    + `  @media (prefers-color-scheme:dark){.board-edge{${line ? `border-color:${BOARD_LOOK[line[0]].dark};` : ""}`
    + `box-shadow:0 0 0 ${BOARD_LOOK.hair.rim}px ${BOARD_LOOK.rim.dark}}}`;
}

/**
 * The lamp's pool on the wall (BOARD_LOOK.pool), as the app's .cg-pool: a circle centred on the board, pool.size times its
 * longer side across, a radial light fading to the wall at its edge, dithered by POOL_NOISE as large as the circle. It sits
 * in the board's camera under the panel, so it moves and zooms with the board.
 */
function poolCss() {
  const P = BOARD_LOOK.pool;
  const light = (c) => `background:radial-gradient(closest-side,${c},${c.replace(/[\d.]+\)$/, "0)")} 100%)`;
  return `.board-pool{position:absolute;z-index:0;pointer-events:none;border-radius:50%;${light(P.light)}}\n`
    + `  .board-pool::after{content:"";position:absolute;inset:0;border-radius:50%;opacity:${P.noise};`
    + `background-image:${POOL_NOISE};background-size:100% 100%}\n`
    + `  @media (prefers-color-scheme:dark){.board-pool{${light(P.dark)}}}`;
}

/**
 * The camera's legal translations on one axis, [lo, hi], at zoom k: the page's script carries this function's own
 * source, and checks/trips/share-board.mjs runs it in node. The picture runs 0..P on the axis (the board's logical px),
 * the board within it b0..b1. A picture no bigger than the view is centred. Zoomed in, the view may pass the board's
 * edge by the band of wall there or by half the view, whichever is less, so at least half the screen is always board
 * (more than a wood frame's width at full zoom: the material shows): a pan at full zoom never ends on plain wall.
 */
export function panLimit(view, k, P, b0, b1) {
  var span = P * k;
  if (span <= view) { var c = (view - span) / 2; return [c, c]; }
  var reach = view / (2 * k);
  var lo = view - Math.min(P, b1 + reach) * k;
  var hi = -Math.max(0, b0 - reach) * k;
  if (lo > hi) { var m = view / 2 - ((b0 + b1) / 2) * k; return [m, m]; }
  return [lo, hi];
}

// THE FASTENERS, as the app draws them (fasteners.js): the ground's kind (a tack, or a magnet on slate and fridge), each
// photograph's own variant and seat from its pin (the app's stream for it, kept with the share; a share made before
// hashes its place instead). A style is written once per variant and theme at FAST_REF px and scaled to each fastener.
const FAST_REF = 40;
// A photograph sent without a pin (a share made before 0041) is pinned by its place on the board: its slot and where it
// sits, so the same share draws the same tacks every time it is opened, on any server.
const placePin = (it) => fastHash(`place:${Number(it.fx).toFixed(4)},${Number(it.fy).toFixed(4)}`, it.idx);
const kebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const declOf = (style) => Object.entries(style).map(([k, v]) => `${kebab(k)}:${v}`).join(";");
function fastenerCss(kind) {
  if (!kind) return "";
  const pal = kind === "magnet" ? MAGNETS : TACKS;
  const styleOf = kind === "magnet" ? magnetStyle : tackStyle;
  const rules = (lum) => pal[lum].map((c, v) => `.fast[data-v="${v}"]>i{${declOf(styleOf(FAST_REF, c, lum))}}`).join("\n  ");
  return `${rules("light")}\n  @media (prefers-color-scheme:dark){\n  ${rules("dark")}\n  }`;
}

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function page({ id, title, width, height, origin, hasVideo, items, mark, board: kept }) {
  const img = `${origin}/s/${id}/image`;
  const fallback = hasVideo
    // autoplay+muted+playsinline is the only combination a phone starts on its own, and the
    // poster means an old share is on screen from first paint whether or not it ever plays.
    ? `<video class="legacy-board" src="${esc(origin)}/s/${esc(id)}/video" poster="${esc(img)}"
         autoplay muted loop playsinline preload="metadata"></video>`
    : `<img class="legacy-board" src="${esc(img)}" alt="A board of photographs from a trip"
         decoding="async">`;

  // Export geometry can be 4096px wide because the flattened Open Graph image needs those
  // pixels. DOM layout does not: percentages preserve every position on a much cheaper logical
  // plane while every <img> and <video> above still points at its untouched original source.
  const sourceW = width > 0 ? width : 4;
  const sourceH = height > 0 ? height : 3;
  const logicalScale = Math.min(1, 1440 / sourceW);
  const boardW = Math.max(4, Math.round(sourceW * logicalScale));
  const boardH = Math.max(3, Math.round(sourceH * logicalScale));
  // The board in the picture: as kept with the share, or (made before) the whole picture, a corkboard.
  const panel = kept || { x: 0, y: 0, w: 1, h: 1, ground: "corkboard" };
  const unit = kept ? kept.scale * logicalScale : LEGACY_UNIT;
  const ground = GROUNDS[panel.ground] ? panel.ground : "corkboard";
  const noun = ground === "corkboard" ? "corkboard" : `${GROUNDS[ground].label.toLowerCase()} board`;
  const fastKind = GROUNDS[ground].fastener || null;

  // Every tile is the attached ORIGINAL, laid out in percentages of the rendered board. That
  // keeps the layout responsive while avoiding the destructive canvas downsample altogether.
  // The element fills the former frame's whole rectangle: no white print edge, tape or mixed
  // border can leak through. A shadow is CSS and therefore stays crisp at every zoom level.
  const tiles = items.map((it, i) => {
    const url = `${origin}/s/${id}/i/${it.idx}`;
    const noun = it.kind === "video" ? "video" : "photograph";
    const media = it.kind === "video"
      ? `<video class="tile-media lod-a" muted loop playsinline preload="none" aria-hidden="true"></video>
           <video class="tile-media lod-b" muted loop playsinline preload="none" aria-hidden="true"></video>`
      : `<img class="tile-media lod-a" alt="" decoding="async" draggable="false">
           <img class="tile-media lod-b" alt="" decoding="async" draggable="false">`;
    // Its fastener, seated as the app seats it: in board units on the tile's own box, counter-turned so its light stays
    // overhead, at this page's px (unit).
    let pin = "";
    if (fastKind) {
      const geo = fastenerGeometry(fastKind, { w: (it.fw * boardW) / unit, h: (it.fh * boardH) / unit }, it.pin ?? placePin(it));
      const d = geo.d * unit;
      pin = `<span class="fast" data-v="${geo.variant % 3}" aria-hidden="true" style="left:${(geo.left * unit).toFixed(2)}px;`
        + `top:${(geo.top * unit).toFixed(2)}px;width:${d.toFixed(2)}px;height:${d.toFixed(2)}px;--s:${(d / FAST_REF).toFixed(4)}"><i></i></span>`;
    }
    return `<button class="tile" data-i="${i}" data-kind="${it.kind}" data-original="${esc(url)}"
      aria-label="Open ${noun} ${i + 1} of ${items.length}"`
      + ` style="--x:${(it.fx * 100).toFixed(4)}%;--y:${(it.fy * 100).toFixed(4)}%;`
      + `--w:${(it.fw * 100).toFixed(4)}%;--h:${(it.fh * 100).toFixed(4)}%;`
      + `--rot:${it.rot.toFixed(2)}deg;--counter:${(-it.rot).toFixed(2)}deg;`
      + `--z:${i + 1}"`
      + ` data-native-width="${it.width}" data-native-height="${it.height}"${it.thumb ? ' data-thumb="1"' : ""}>${media}${pin}</button>`;
  }).join("");

  // The pool, centred on the board, pool.size times its longer side across (in the board's logical px).
  const poolR = (BOARD_LOOK.pool.size * Math.max(panel.w * boardW, panel.h * boardH)) / 2;
  const poolEl = `<div class="board-pool" aria-hidden="true" style="left:${+((panel.x + panel.w / 2) * boardW - poolR).toFixed(3)}px;`
    + `top:${+((panel.y + panel.h / 2) * boardH - poolR).toFixed(3)}px;width:${+(2 * poolR).toFixed(3)}px;height:${+(2 * poolR).toFixed(3)}px"></div>`;
  const panelEl = `<div class="board-panel" data-bg="${ground}" aria-hidden="true" style="left:${(panel.x * 100).toFixed(4)}%;`
    + `top:${(panel.y * 100).toFixed(4)}%;width:${(panel.w * 100).toFixed(4)}%;height:${(panel.h * 100).toFixed(4)}%"></div>`;
  const board = items.length
    ? `<div class="board originals" style="width:${boardW}px;height:${boardH}px"`
      + ` aria-label="A ${noun} of ${items.length} trip photographs and videos">`
      + `${poolEl}${panelEl}<div class="tiles">${tiles}</div></div>`
    : `<div class="board legacy" style="width:${boardW}px;height:${boardH}px">${fallback}</div>`;

  const manifest = JSON.stringify(items.map((it) => ({
    k: it.kind, w: it.width, h: it.height, u: `${origin}/s/${id}/i/${it.idx}`,
  })));

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<!-- What breaks on this page reaches the site's owner, cleaned of anything personal, the board's own words taken out by the server (js/error-report.js; src/errors.js). -->
<script type="module" src="/js/error-report.js"></script>
<title>${esc(title || "A trip")}</title>
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title || "A trip")}">
<meta property="og:image" content="${esc(img)}">
${width && height ? `<meta property="og:image:width" content="${width}">
<meta property="og:image:height" content="${height}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/icons/favicon.1ad16064.ico">
<!-- The design system's tokens and faces, for the page's three bits of chrome only (each carries .ds, dark): the wall
     and the board keep their own look. -->
<link rel="stylesheet" href="/ds/tokens.css">
<style>
  /* The page is a camera looking at one physical board hanging on a wall, not a tall document
     pretending to be one. The wall goes on; the board is as big as its photographs (board-look.js). */
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:${BOARD_LOOK.wall.light};width:100%;height:100%;overflow:hidden}
  body{font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#efe9df}
  button{font:inherit}
  .viewport{position:fixed;inset:0;overflow:hidden;touch-action:none;user-select:none;
            -webkit-user-select:none;cursor:grab;overscroll-behavior:none;
            background-color:${BOARD_LOOK.wall.light};background-image:${WALL_GRAIN.light};
            background-repeat:repeat}
  @media (prefers-color-scheme:dark){
    html,body{background:${BOARD_LOOK.wall.dark}}
    .viewport{background-color:${BOARD_LOOK.wall.dark};background-image:${WALL_GRAIN.dark}}
  }
  ${boardCss(ground, unit, { w: (panel.w * boardW) / unit, h: (panel.h * boardH) / unit }, !kept)}
  ${edgeCss(ground)}
  ${poolCss()}
  .viewport.is-dragging{cursor:grabbing}
  /* Focus is taken on a finger's or a mouse's press (so the board's keys work after it), and
     Chrome then drew its ring round the whole board under the finger. The ring is for the
     keyboard: a press marks the board, a key unmarks it. */
  .viewport:focus{outline:none}
  .viewport:focus-visible:not([data-by="pointer"]){outline:3px solid #efe9df;outline-offset:-3px}
  .board{position:absolute;left:0;top:0;flex:none;isolation:isolate;transform-origin:0 0;
         background:transparent;will-change:transform}
  .legacy{overflow:hidden}
  .legacy-board{display:block;width:100%;height:100%;object-fit:contain}
  .tiles{position:absolute;inset:0;z-index:1;isolation:isolate}
  .tile{position:absolute;left:var(--x);top:var(--y);width:var(--w);height:var(--h);z-index:var(--z);
        display:block;margin:0;padding:0;border:0;border-radius:0;background:transparent;overflow:visible;
        cursor:zoom-in;transform:rotate(var(--rot));transform-origin:50% 50%;
        box-shadow:0 3px 7px rgb(44 19 5 / .48),0 15px 30px rgb(34 13 3 / .42);
        transition:transform .22s cubic-bezier(.2,.8,.2,1),box-shadow .16s ease}
  .tile-media{position:absolute;inset:0;z-index:0;display:block;width:100%;height:100%;object-fit:cover;
              object-position:center;border:0;border-radius:0;background:#8f623d;pointer-events:none;
              image-rendering:auto;opacity:0;transition:none}
  /* A resolution swap is a promotion, not two simultaneous fades. The current bitmap remains
     fully opaque underneath while the decoded incoming bitmap paints above it. Only after the
     incoming layer is completely opaque does JavaScript release the old source. */
  .tile-media[data-current="1"]{z-index:1;opacity:1}
  .tile-media[data-incoming="1"]{z-index:2;opacity:0;transition:opacity .18s ease-out}
  .tile-media[data-incoming="1"][data-on="1"]{opacity:1}
  .tile:focus-visible,.tile.is-centered{
        z-index:1000;transform:rotate(var(--rot)) scale(1.075);
        outline:none}
  .tile:focus-visible,.tile.is-centered{
        box-shadow:0 10px 19px rgb(38 15 3 / .49),0 32px 58px rgb(29 10 2 / .58)}
  .tile:focus-visible{outline:3px solid rgb(255 255 255 / .92);outline-offset:3px}
  @media (hover:hover) and (pointer:fine){
    .tile:hover{z-index:1000;transform:rotate(var(--rot)) scale(1.075);outline:none;
          box-shadow:0 10px 19px rgb(38 15 3 / .49),0 32px 58px rgb(29 10 2 / .58)}
    .tile:active{transform:rotate(var(--rot)) scale(1.035)}
    .viewport.is-dragging .tile:hover:not(.is-centered){transform:rotate(var(--rot));
          box-shadow:0 3px 7px rgb(44 19 5 / .48),0 15px 30px rgb(34 13 3 / .42)}
  }

  /* The fastener holding each photograph to the board, as the app draws it (fasteners.js): it stays upright while
     the print turns, and lifts with it. */
  .fast{position:absolute;z-index:3;pointer-events:none;transform:rotate(var(--counter))}
  .fast>i{position:absolute;left:0;top:0;transform:scale(var(--s));transform-origin:0 0}
  ${fastenerCss(fastKind)}

  /* The page draws under the notch, the status bar and the home indicator (viewport-fit=cover), so
     everything set near an edge here and in the lightbox keeps at least that edge's safe-area inset. */
  /* The zoom, on the design system (the page's chrome carries .ds, dark: public/ds/tokens.css): two round gray
     buttons with the percent between them in the mono face, which is itself the button that fits the board. */
  .canvas-tools{position:fixed;left:max(16px,env(safe-area-inset-left));bottom:max(16px,env(safe-area-inset-bottom));z-index:2500;
       display:flex;align-items:center;gap:4px}
  .canvas-tools button{display:grid;place-items:center;height:40px;min-width:40px;padding:0;border:1px solid var(--edge);border-radius:var(--radius-full);
       background:var(--fill);color:var(--ink-1);cursor:pointer;box-shadow:0 4px 14px rgb(0 0 0 / .28);
       backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
       transition:background-color var(--dur-150) var(--ease-standard),transform var(--dur-150) var(--ease-standard)}
  .canvas-tools button svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}
  .canvas-tools button:hover{background:var(--fill-hover)}
  .canvas-tools button:active{transform:scale(.94)}
  .canvas-tools button:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
  .canvas-tools .zoom-readout{min-width:56px;padding:0 4px;border:0;background:none;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;
       color:#24211b;font:500 var(--size-12)/1 var(--type-mono);font-variant-numeric:tabular-nums;text-shadow:0 0 4px rgb(255 255 255 / .55)}
  .canvas-tools .zoom-readout:hover{background:none;color:#000}
  /* The percent sits on the wall itself: its dark ink by day, the light ink at Night. */
  @media (prefers-color-scheme:dark){.canvas-tools .zoom-readout{color:#efe9df;text-shadow:0 1px 3px rgb(0 0 0 / .55)}
    .canvas-tools .zoom-readout:hover{color:#fff}}
  @media (pointer:coarse){.canvas-tools button{height:44px;min-width:44px}}
  /* The hint: the system's quiet pill, gone after the first move. */
  .canvas-hint{position:fixed;left:50%;bottom:max(20px,env(safe-area-inset-bottom));z-index:2400;
       margin:0;padding:6px 12px;border-radius:var(--radius-full);border:1px solid var(--edge);background:var(--fill);color:var(--ink-2);
       font:400 var(--size-12)/16px var(--type-ui);box-shadow:0 4px 14px rgb(0 0 0 / .22);
       backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
       transform:translateX(-50%);transition:opacity .45s ease;pointer-events:none;white-space:nowrap}
  .viewport.has-moved~.canvas-hint{opacity:0}
  /* The hint's words for the screen it is on: on a touch screen (a coarse pointer, or a phone's screen, short side under
     600 px, as the app's onPhone) a pinch; on a desktop the trackpad's pinch and the keyboard's scroll too. */
  .hint-touch{display:none}
  @media (pointer:coarse){.hint-touch{display:inline}.hint-desk{display:none}}
  .canvas-hint[data-touch="1"] .hint-touch{display:inline}
  .canvas-hint[data-touch="1"] .hint-desk{display:none}
  /* The wordmark: small, at the top right, out of the way. Its colorway follows the wall under it so it reads there (3:1
     at least, check:share-board): the logo's paper colorway, dark ink, on the day wall; its void colorway, light ink, on
     the night wall. The same values as the logo's own (public/ds/tokens.css), the wall as the ground a hiker is lifted off. */
  /* THE WORDMARK IS INLINED, NOT AN <img>. The file paints itself with var(--accent) and
     var(--ink), and a var() inside an <img> resolves against the SVG's own root — which has no
     such variables — so it renders as unpainted geometry and reads as a smudge. auth.js injects
     it for exactly this reason; this page does the same, server-side, and defines the two
     tokens here, as the app's own for each theme: the logo's own colours (art/make_logo.py), the paper version by day
     and void's in the dark, with the wall as the ground a hiker is lifted off. */
  .mark{position:fixed;top:max(14px,env(safe-area-inset-top));right:max(14px,env(safe-area-inset-right));width:104px;z-index:2000;pointer-events:none;
        --logo-ground:${BOARD_LOOK.wall.light};--logo-letter:#1B2748;--logo-figure:#F2702A;--logo-shade:#C4521A;--logo-pack:#1FA89A;--logo-rope:#B88A4A}
  @media (prefers-color-scheme:dark){.mark{--logo-ground:${BOARD_LOOK.wall.dark};--logo-letter:#f1efea;--logo-figure:#FF8A3D;--logo-shade:#D2611B;--logo-pack:#35C9B8;--logo-rope:#F2C27A}}
  .mark svg{display:block;width:100%;height:auto}
  @media (max-width:520px){
    .mark{width:80px;top:max(10px,env(safe-area-inset-top));right:max(10px,env(safe-area-inset-right))}
    .canvas-tools{left:max(10px,env(safe-area-inset-left));bottom:max(10px,env(safe-area-inset-bottom))}
    .canvas-hint{bottom:max(61px,calc(env(safe-area-inset-bottom) + 55px))}
  }

  /* The lightbox: one photograph, as large as the screen allows, at its own resolution. */
  dialog#lb{border:0;padding:0;margin:0;width:100vw;height:100svh;max-width:100vw;max-height:100svh;
            background:#000;color:#fff}
  dialog#lb::backdrop{background:#000}
  /* While a photograph is open the page's own ground is black too, with a theme-color added beside it, so a browser that
     follows a live theme-color paints its bars black around an open photo. Safari on iOS 26 reads the bars' color from
     the page at load and does not follow this; other browsers do. Back to the wall's on close. */
  html.lb-open,html.lb-open body{background:#000}
  #lb .stage{position:absolute;inset:0;display:grid;place-items:center;
             overflow:auto;-webkit-overflow-scrolling:touch}
  #lb img,#lb video{max-width:100%;max-height:100svh;width:auto;height:auto;display:block;cursor:zoom-in}
  /* Zoomed: the image goes to its NATIVE pixels and the stage scrolls. That is what "look at it
     full res" means — not a CSS scale of the same downsampled bitmap. */
  #lb.zoom .stage{display:block;place-items:normal}
  #lb.zoom img{position:absolute;top:0;left:0;max-width:none;max-height:none;width:auto;height:auto;
               margin:0;cursor:zoom-out}
  #lb .x,#lb .nav{position:absolute;border:0;background:rgb(0 0 0 / .45);color:#fff;
                  width:44px;height:44px;border-radius:50%;font-size:20px;line-height:1;cursor:pointer}
  #lb .x{top:max(14px,env(safe-area-inset-top));right:max(14px,env(safe-area-inset-right))}
  #lb .prev{left:max(10px,env(safe-area-inset-left));top:50%;margin-top:-22px}
  #lb .next{right:max(10px,env(safe-area-inset-right));top:50%;margin-top:-22px}
  #lb .cnt{position:absolute;bottom:max(14px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);
           font-size:12.5px;opacity:.7;font-variant-numeric:tabular-nums}
  @media (prefers-reduced-motion:reduce){.tile,.tile-media,.canvas-hint{transition:none!important}}
</style>
</head><body>
<div class="viewport" id="canvas" tabindex="0" data-wall-tile="${+(GRAIN_TILE * unit).toFixed(4)}"
     aria-label="Interactive ${noun}. Drag to move and pinch or Control-scroll to zoom.">
  ${board}
  <div class="board-edge" data-bg="${ground}" aria-hidden="true" data-x="${+(panel.x * boardW).toFixed(3)}" data-y="${+(panel.y * boardH).toFixed(3)}"
       data-w="${+(panel.w * boardW).toFixed(3)}" data-h="${+(panel.h * boardH).toFixed(3)}" data-r="${+((BOARD_LOOK.frame[ground].radius || 0) * unit).toFixed(3)}"></div>
</div>
<div class="canvas-tools ds" data-ds-theme="dark" role="group" aria-label="Canvas controls">
  <button type="button" data-canvas="out" aria-label="Zoom out"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg></button>
  <button type="button" class="zoom-readout" data-canvas="fit" aria-label="Fit board">Fit</button>
  <button type="button" data-canvas="in" aria-label="Zoom in"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M12 6v12"/></svg></button>
</div>
<p class="canvas-hint ds" data-ds-theme="dark"><span class="hint-desk">Drag to move &middot; pinch or &#8984;/Ctrl-scroll to zoom</span><span class="hint-touch">Drag to move &middot; pinch to zoom</span></p>
<div class="mark" role="img" aria-label="WeGoPlace">${mark}</div>

<dialog id="lb">
  <div class="stage"></div>
  <button class="x" aria-label="Close">&times;</button>
  <button class="nav prev" aria-label="Previous">&#8249;</button>
  <button class="nav next" aria-label="Next">&#8250;</button>
  <p class="cnt"></p>
</dialog>

<script>
(function () {
  var ITEMS = ${manifest};
  // A phone's screen (short side under 600 px, the device's and not the window's, as the app's onPhone) gets the
  // touch words even with a fine pointer.
  var hintEl = document.querySelector(".canvas-hint");
  if (hintEl && typeof screen !== "undefined" && screen.width && Math.min(screen.width, screen.height) < 600) hintEl.dataset.touch = "1";
  var viewport = document.getElementById("canvas");
  var board = viewport && viewport.querySelector(".board");
  var readout = document.querySelector(".zoom-readout");
  var tiles = document.querySelector(".tiles");
  var boardVideos = tiles ? Array.from(tiles.querySelectorAll("video")) : [];
  var touchCanvas = window.matchMedia("(hover: none), (pointer: coarse)").matches;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var centeredTile = null;
  var lodTimer = 0;
  var mediaJobs = [];
  var mediaInFlight = 0;
  var videoInFlight = 0;
  var missingTiers = { photo: new Set(), video: new Set() };
  // Two sizes, both of which exist: the photograph's own thumbnail (about 480 px, the memory's,
  // kept on the item since migration 0026: data-thumb) when a tile needs that or less, else the
  // original. A video is always its original. (The board once asked for five sizes that nothing
  // ever made: each tile's first request a 404, then the original anyway.)
  var THUMB = 480;
  var PHOTO_TIERS = [THUMB];
  var VIDEO_TIERS = [];
  var mediaRecs = tiles ? Array.from(tiles.querySelectorAll(".tile")).map(function (tile) {
    return { tile: tile, kind: tile.dataset.kind === "video" ? "video" : "photo",
      original: tile.dataset.original, thumb: tile.dataset.thumb === "1", native: Math.max(Number(tile.dataset.nativeWidth) || 0,
        Number(tile.dataset.nativeHeight) || 0),
      centerX: tile.offsetLeft + tile.offsetWidth / 2,
      centerY: tile.offsetTop + tile.offsetHeight / 2,
      layers: Array.from(tile.querySelectorAll(".tile-media")), active: -1, tier: null,
      actualTier: null, desired: null, visible: false, warm: false, token: 0, pending: null };
  }) : [];

  // Lift is presentation only. Motion and resolution are camera decisions, so every visible
  // clip keeps playing whether or not a mouse happens to be over it.
  function setCenteredTile(next) {
    if (centeredTile === next) return;
    var old = centeredTile;
    centeredTile = next;
    if (old) old.classList.remove("is-centered");
    if (next) next.classList.add("is-centered");
  }
  function updateCenteredTile() {
    if (!touchCanvas || !viewport || !tiles || !C || !fitK || C.k < fitK * 1.8 ||
        document.getElementById("lb").open) { setCenteredTile(null); return; }
    var cx = viewport.clientWidth / 2;
    var cy = viewport.clientHeight / 2;
    var pick = null;
    var best = Infinity;
    // Selection is purely geometric: whichever tile's center is nearest the viewport center
    // wins. Cached board-space centers keep this cheap enough to run on every camera frame.
    mediaRecs.forEach(function (rec) {
      var dx = C.x + rec.centerX * C.k - cx;
      var dy = C.y + rec.centerY * C.k - cy;
      var distance = dx * dx + dy * dy;
      if (distance < best) { best = distance; pick = rec.tile; }
    });
    setCenteredTile(pick);
  }
  function queueCenteredTile() {
    if (touchCanvas) updateCenteredTile();
  }

  function tierUrl(rec, tier) {
    return tier === "original" ? rec.original : rec.original + "/thumb";
  }
  function tierList(rec) { return rec.kind === "video" || !rec.thumb ? VIDEO_TIERS : PHOTO_TIERS; }
  function chooseTier(rec, needed) {
    var tiers = tierList(rec);
    // Retain the current rung inside a 16% band. It prevents a trackpad resting on a boundary
    // from repeatedly decoding adjacent files, without ever underserving a material zoom-in.
    if (typeof rec.tier === "number") {
      var prev = tiers[tiers.indexOf(rec.tier) - 1] || 0;
      if (needed <= rec.tier * 1.08 && needed > prev * .84) return rec.tier;
    }
    for (var i = 0; i < tiers.length; i++) {
      if (tiers[i] >= needed && (!rec.native || tiers[i] < rec.native)) return tiers[i];
    }
    return "original";
  }
  function playable(rec) {
    return rec.visible && !document.getElementById("lb").open;
  }
  function setVideoPlayback(rec) {
    if (rec.kind !== "video" || rec.active < 0) return;
    var video = rec.layers[rec.active];
    if (playable(rec)) video.play().catch(function () {}); else video.pause();
  }
  function clearLayer(layer, kind) {
    layer.removeAttribute("data-on");
    layer.removeAttribute("data-current");
    layer.removeAttribute("data-incoming");
    delete layer.__wgpLodToken;
    layer.onload = layer.onerror = null;
    if (kind === "video") {
      layer.onloadeddata = layer.onloadedmetadata = layer.onerror = null;
      layer.pause(); layer.removeAttribute("src"); layer.load();
    } else layer.removeAttribute("src");
  }
  function releaseRec(rec) {
    rec.token++;
    rec.pending = null;
    rec.active = -1;
    rec.tier = rec.actualTier = null;
    rec.layers.forEach(function (layer) { clearLayer(layer, rec.kind); });
    rec.tile.removeAttribute("data-lod");
  }
  function candidates(rec, desired) {
    if (desired === "original") return [{ tier: "original", url: rec.original }];
    var tiers = tierList(rec), start = tiers.indexOf(desired), out = [];
    for (var i = Math.max(0, start); i < tiers.length; i++) {
      var tier = tiers[i];
      if (rec.native && tier >= rec.native) break;
      if (!missingTiers[rec.kind].has(tier)) out.push({ tier: tier, url: tierUrl(rec, tier) });
    }
    out.push({ tier: "original", url: rec.original });
    return out;
  }
  function afterPaint() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { requestAnimationFrame(resolve); });
    });
  }
  function validPromotion(rec, desired, token, next) {
    return token === rec.token && next.__wgpLodToken === token && rec.warm &&
      rec.desired === desired;
  }
  function fadeIncoming(next) {
    if (reduceMotion) {
      next.setAttribute("data-on", "1");
      return afterPaint();
    }
    return new Promise(function (resolve) {
      var settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        next.removeEventListener("transitionend", ended);
        resolve();
      }
      function ended(e) { if (e.propertyName === "opacity") finish(); }
      var fallback = setTimeout(finish, 260);
      next.addEventListener("transitionend", ended);
      next.setAttribute("data-on", "1");
    });
  }
  async function activate(rec, next, desired, actual, token) {
    if (!validPromotion(rec, desired, token, next)) return false;
    var old = rec.active;
    if (old < 0) {
      next.setAttribute("data-current", "1");
      next.setAttribute("data-on", "1");
    } else {
      // data-incoming fixes the paint order even when the reusable layer occurs earlier in DOM.
      // Two animation frames commit its transparent, decoded starting state before it fades in.
      next.removeAttribute("data-current");
      next.removeAttribute("data-on");
      next.setAttribute("data-incoming", "1");
      await afterPaint();
      if (!validPromotion(rec, desired, token, next)) return false;
      await fadeIncoming(next);
      await afterPaint();
      if (!validPromotion(rec, desired, token, next)) return false;
    }
    rec.active = rec.layers.indexOf(next);
    rec.tier = desired;
    rec.actualTier = actual;
    rec.tile.dataset.lod = String(actual);
    next.removeAttribute("data-incoming");
    next.setAttribute("data-current", "1");
    next.setAttribute("data-on", "1");
    if (old >= 0 && old !== rec.active) {
      // The new layer has now been fully opaque across two paints, so removing the old source
      // cannot expose the board under it or a blank video frame.
      clearLayer(rec.layers[old], rec.kind);
    }
    setVideoPlayback(rec);
    return true;
  }
  async function swapPhoto(rec, desired, token) {
    var next = rec.layers[rec.active === 0 ? 1 : 0];
    var tries = candidates(rec, desired);
    for (var i = 0; i < tries.length; i++) {
      if (token !== rec.token || !rec.warm) return;
      var choice = tries[i];
      next.__wgpLodToken = token;
      try {
        await new Promise(function (resolve, reject) {
          next.onload = resolve; next.onerror = reject; next.src = choice.url;
        });
        if (next.decode) await next.decode().catch(function () {});
        if (await activate(rec, next, desired, choice.tier, token)) return;
      } catch {
        if (next.__wgpLodToken === token) clearLayer(next, "photo");
        if (choice.tier !== "original") missingTiers.photo.add(choice.tier);
      }
    }
  }
  async function swapVideo(rec, desired, token) {
    var next = rec.layers[rec.active === 0 ? 1 : 0];
    var old = rec.active >= 0 ? rec.layers[rec.active] : null;
    var oldTime = old && Number.isFinite(old.currentTime) ? old.currentTime : 0;
    var tries = candidates(rec, desired);
    for (var i = 0; i < tries.length; i++) {
      if (token !== rec.token || !rec.warm) return;
      var choice = tries[i];
      next.__wgpLodToken = token;
      try {
        await new Promise(function (resolve, reject) {
          next.onloadeddata = resolve; next.onerror = reject; next.src = choice.url; next.load();
        });
        if (next.duration && Number.isFinite(next.duration)) next.currentTime = oldTime % next.duration;
        if (playable(rec)) await next.play().catch(function () {});
        if (playable(rec) && next.requestVideoFrameCallback) {
          await new Promise(function (resolve) {
            var fallback = setTimeout(resolve, 450);
            next.requestVideoFrameCallback(function () { clearTimeout(fallback); resolve(); });
          });
        }
        if (await activate(rec, next, desired, choice.tier, token)) return;
      } catch {
        if (next.__wgpLodToken === token) clearLayer(next, "video");
        if (choice.tier !== "original") missingTiers.video.add(choice.tier);
      }
    }
  }
  function pumpMediaJobs() {
    for (var i = 0; i < mediaJobs.length && mediaInFlight < 6;) {
      var job = mediaJobs[i];
      if (job.token !== job.rec.token || job.rec.desired !== job.desired || !job.rec.warm) {
        mediaJobs.splice(i, 1); continue;
      }
      if (job.rec.kind === "video" && videoInFlight >= 2) { i++; continue; }
      mediaJobs.splice(i, 1);
      mediaInFlight++;
      if (job.rec.kind === "video") videoInFlight++;
      (job.rec.kind === "video" ? swapVideo(job.rec, job.desired, job.token) :
        swapPhoto(job.rec, job.desired, job.token)).finally(function (finished) {
          mediaInFlight = Math.max(0, mediaInFlight - 1);
          if (finished.rec.kind === "video") videoInFlight = Math.max(0, videoInFlight - 1);
          if (finished.rec.pending === finished.desired) finished.rec.pending = null;
          pumpMediaJobs();
        }.bind(null, job));
    }
  }
  function enqueue(rec, desired, distance) {
    if (rec.pending === desired || (rec.tier === desired && rec.active >= 0)) return;
    rec.token++;
    rec.pending = desired;
    mediaJobs.push({ rec: rec, desired: desired, token: rec.token,
      priority: (rec.visible ? 0 : 1) * 1e12 + distance });
  }
  function runLod() {
    lodTimer = 0;
    if (!viewport || !mediaRecs.length) return;
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    var vwNow = viewport.clientWidth, vhNow = viewport.clientHeight;
    var haloX = vwNow * .7, haloY = vhNow * .7;
    var cx = vwNow / 2, cy = vhNow / 2;
    mediaRecs.forEach(function (rec) {
      var r = rec.tile.getBoundingClientRect();
      rec.visible = r.right > 0 && r.bottom > 0 && r.left < vwNow && r.top < vhNow;
      rec.warm = r.right > -haloX && r.bottom > -haloY && r.left < vwNow + haloX &&
        r.top < vhNow + haloY;
      if (!rec.warm) { if (rec.active >= 0 || rec.pending) releaseRec(rec); return; }
      // CSS pixels times the actual output density is the exact raster work this display can
      // reveal. The small overscan covers rotation, hover lift and fractional camera movement.
      var needed = Math.max(r.width, r.height) * dpr * 1.12;
      rec.desired = chooseTier(rec, needed);
      var distance = Math.pow(r.left + r.width / 2 - cx, 2) +
        Math.pow(r.top + r.height / 2 - cy, 2);
      enqueue(rec, rec.desired, distance);
      setVideoPlayback(rec);
    });
    mediaJobs.sort(function (a, b) { return a.priority - b.priority; });
    pumpMediaJobs();
  }
  function queueLod() {
    clearTimeout(lodTimer);
    lodTimer = setTimeout(runLod, 135);
  }
  window.__WGP_LOD__ = {
    reconcile: runLod,
    snapshot: function () { return mediaRecs.map(function (r) {
      return { i: Number(r.tile.dataset.i), kind: r.kind, visible: r.visible, warm: r.warm,
        desired: r.desired, loaded: r.actualTier, playing: r.kind === "video" && r.active >= 0 &&
          !r.layers[r.active].paused };
    }); }
  };

  /* The board has its own camera. A trackpad pans naturally; its pinch gesture arrives as a
     Control-wheel and zooms around the fingers. Touch uses the same world-point math with two
     pointer events, so a photograph stays under the fingers rather than skating away. */
  if (viewport && board) {
    var C = { x: 0, y: 0, k: 1 };
    var fitK = 1, minK = .2, maxK = 6, vw = 0, vh = 0;
    var pointers = new Map();
    var gesture = null;
    var suppressUntil = 0;
    var motion = 0;
    var paintFrame = 0;
    var initialized = false;
    var userMoved = false;

    function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
    // The camera's world is the share's picture: the board and its band of wall. Fitted, the whole picture shows,
    // centred; zoomed in, a pan stops while half the screen is still board (panLimit, on the board's edge).
    var panLimit = ${panLimit.toString()};
    function constrained(x, y, k) {
      var W = board.offsetWidth, H = board.offsetHeight;
      var lx = panLimit(vw, k, W, E ? E.x : 0, E ? E.x + E.w : W);
      var ly = panLimit(vh, k, H, E ? E.y : 0, E ? E.y + E.h : H);
      return { x: clamp(x, lx[0], lx[1]), y: clamp(y, ly[0], ly[1]), k: k };
    }
    // The wall's paint moves with the board: its grain is anchored to the camera, at the app's size (board units).
    var wallTile = Number(viewport.dataset.wallTile) || 96;
    // The board's fine lines are screen pixels: their element is placed over the panel from the camera, not scaled by it.
    var edge = viewport.querySelector(".board-edge");
    var E = edge ? { x: +edge.dataset.x, y: +edge.dataset.y, w: +edge.dataset.w, h: +edge.dataset.h, r: +edge.dataset.r } : null;
    function draw() {
      board.style.transform = "translate3d(" + C.x.toFixed(3) + "px," + C.y.toFixed(3) +
        "px,0) scale(" + C.k.toFixed(5) + ")";
      if (E) {
        edge.style.transform = "translate3d(" + (C.x + E.x * C.k).toFixed(3) + "px," + (C.y + E.y * C.k).toFixed(3) + "px,0)";
        edge.style.width = (E.w * C.k).toFixed(3) + "px";
        edge.style.height = (E.h * C.k).toFixed(3) + "px";
        if (E.r) edge.style.borderRadius = (E.r * C.k).toFixed(3) + "px";
      }
      // The wall is the world plane, not wallpaper behind it: its grain keeps to the board's camera.
      var t = Math.max(4, wallTile * C.k).toFixed(2) + "px";
      var at = C.x.toFixed(2) + "px " + C.y.toFixed(2) + "px";
      viewport.style.backgroundPosition = at + "," + at;
      viewport.style.backgroundSize = t + " " + t + "," + t + " " + t;
      if (readout) readout.textContent = Math.round(C.k * 100) + "%";
      queueCenteredTile();
      queueLod();
    }
    function paint() {
      if (paintFrame) return;
      paintFrame = requestAnimationFrame(function () { paintFrame = 0; draw(); });
    }
    function stopMotion() {
      if (motion) cancelAnimationFrame(motion);
      motion = 0;
    }
    function cameraTo(target, animate) {
      target = constrained(target.x, target.y, clamp(target.k, minK, maxK));
      stopMotion();
      if (!animate || reduceMotion) { C = target; draw(); return; }
      var from = { x: C.x, y: C.y, k: C.k };
      var began = performance.now();
      function tick(now) {
        var p = Math.min(1, (now - began) / 260);
        var e = 1 - Math.pow(1 - p, 3);
        C.x = from.x + (target.x - from.x) * e;
        C.y = from.y + (target.y - from.y) * e;
        C.k = from.k + (target.k - from.k) * e;
        draw();
        if (p < 1) motion = requestAnimationFrame(tick); else motion = 0;
      }
      motion = requestAnimationFrame(tick);
    }
    function fitTarget() {
      return { x: (vw - board.offsetWidth * fitK) / 2,
        y: (vh - board.offsetHeight * fitK) / 2, k: fitK };
    }
    function measure(reset) {
      var oldVw = vw, oldVh = vh;
      var wx = initialized ? (oldVw / 2 - C.x) / C.k : board.offsetWidth / 2;
      var wy = initialized ? (oldVh / 2 - C.y) / C.k : board.offsetHeight / 2;
      vw = viewport.clientWidth;
      vh = viewport.clientHeight;
      // Fitted: the whole picture (the board and its band of wall) in view, and never smaller than that.
      fitK = Math.min(vw / board.offsetWidth, vh / board.offsetHeight);
      minK = Math.max(.01, fitK);
      maxK = Math.max(6, fitK * 10);
      if (reset || !initialized || !userMoved) C = fitTarget();
      else C = constrained(vw / 2 - wx * C.k, vh / 2 - wy * C.k, clamp(C.k, minK, maxK));
      initialized = true;
      draw();
    }
    function zoomTarget(next, x, y) {
      next = clamp(next, minK, maxK);
      var wx = (x - C.x) / C.k;
      var wy = (y - C.y) / C.k;
      return constrained(x - wx * next, y - wy * next, next);
    }
    function interacted() {
      userMoved = true;
      viewport.classList.add("has-moved");
    }
    function point(e) {
      var r = viewport.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function pinch() {
      var pair = Array.from(pointers.values()).slice(0, 2);
      var mx = (pair[0].x + pair[1].x) / 2;
      var my = (pair[0].y + pair[1].y) / 2;
      var d = Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y) || 1;
      return { kind: "pinch", distance: d, k: C.k,
        wx: (mx - C.x) / C.k, wy: (my - C.y) / C.k };
    }
    viewport.addEventListener("wheel", function (e) {
      e.preventDefault();
      stopMotion();
      interacted();
      var unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vh : 1;
      if (e.ctrlKey || e.metaKey) {
        var p = point(e);
        C = zoomTarget(C.k * Math.exp(-e.deltaY * unit * .0022), p.x, p.y);
      } else {
        var dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        var dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        C = constrained(C.x - dx * unit, C.y - dy * unit, C.k);
      }
      paint();
    }, { passive: false });

    viewport.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      stopMotion();
      var p = point(e);
      pointers.set(e.pointerId, p);
      viewport.classList.add("is-dragging");
      viewport.dataset.by = "pointer";
      viewport.focus({ preventScroll: true });
      if (pointers.size === 1) gesture = { kind: "pan", last: p, start: p, moved: false };
      else if (pointers.size >= 2) {
        suppressUntil = performance.now() + 350;
        // Capture only once this is unambiguously a canvas gesture. Capturing the initial tap
        // would retarget its eventual click to the viewport and make a photograph unopenable.
        pointers.forEach(function (_, id) {
          try { viewport.setPointerCapture(id); } catch { /* pointer ended between events */ }
        });
        gesture = pinch();
      }
    });
    viewport.addEventListener("pointermove", function (e) {
      if (!pointers.has(e.pointerId)) return;
      e.preventDefault();
      var p = point(e);
      pointers.set(e.pointerId, p);
      if (!gesture) return;
      if (pointers.size >= 2) {
        if (gesture.kind !== "pinch") gesture = pinch();
        var pair = Array.from(pointers.values()).slice(0, 2);
        var mx = (pair[0].x + pair[1].x) / 2;
        var my = (pair[0].y + pair[1].y) / 2;
        var d = Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y) || 1;
        var next = clamp(gesture.k * d / gesture.distance, minK, maxK);
        C = constrained(mx - gesture.wx * next, my - gesture.wy * next, next);
        suppressUntil = performance.now() + 350;
        interacted();
        paint();
      } else if (gesture.kind === "pan") {
        var dx = p.x - gesture.last.x;
        var dy = p.y - gesture.last.y;
        gesture.last = p;
        if (Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) > 4) gesture.moved = true;
        if (gesture.moved) {
          if (!viewport.hasPointerCapture(e.pointerId)) {
            try { viewport.setPointerCapture(e.pointerId); } catch { /* pointer already ended */ }
          }
          C = constrained(C.x + dx, C.y + dy, C.k);
          suppressUntil = performance.now() + 350;
          interacted();
          paint();
        }
      }
    });
    function pointerEnd(e) {
      pointers.delete(e.pointerId);
      if (pointers.size === 1) {
        var p = Array.from(pointers.values())[0];
        gesture = { kind: "pan", last: p, start: p, moved: true };
      } else if (!pointers.size) {
        gesture = null;
        viewport.classList.remove("is-dragging");
        queueCenteredTile();
      } else gesture = pinch();
    }
    viewport.addEventListener("pointerup", pointerEnd);
    viewport.addEventListener("pointercancel", pointerEnd);
    viewport.addEventListener("lostpointercapture", function (e) {
      // Touch starts with implicit capture on the photograph. Once movement proves this is a
      // pan, capture transfers to the viewport and the photograph emits lostpointercapture.
      // That event bubbles: treating it as the end of the gesture made every one-finger pan
      // stop after its first movement. Only the viewport losing its own capture ends the pan.
      if (e.target === viewport && pointers.has(e.pointerId)) pointerEnd(e);
    });
    viewport.addEventListener("click", function (e) {
      if (performance.now() < suppressUntil) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    document.querySelector(".canvas-tools").addEventListener("click", function (e) {
      var action = e.target.closest("[data-canvas]");
      if (!action) return;
      if (action.dataset.canvas === "fit") {
        userMoved = false;
        cameraTo(fitTarget(), true);
      } else {
        interacted();
        var factor = action.dataset.canvas === "in" ? 1.28 : 1 / 1.28;
        cameraTo(zoomTarget(C.k * factor, vw / 2, vh / 2), true);
      }
    });
    // Any key (a Tab into the board included) unmarks it: from then its focus ring shows.
    document.addEventListener("keydown", function () { delete viewport.dataset.by; }, true);
    viewport.addEventListener("keydown", function (e) {
      var handled = true;
      if (e.key === "+" || e.key === "=") {
        interacted(); cameraTo(zoomTarget(C.k * 1.25, vw / 2, vh / 2), true);
      } else if (e.key === "-") {
        interacted(); cameraTo(zoomTarget(C.k / 1.25, vw / 2, vh / 2), true);
      } else if (e.key === "0") {
        userMoved = false; cameraTo(fitTarget(), true);
      } else if (e.key === "ArrowLeft") {
        interacted(); cameraTo({ x: C.x + 70, y: C.y, k: C.k }, true);
      } else if (e.key === "ArrowRight") {
        interacted(); cameraTo({ x: C.x - 70, y: C.y, k: C.k }, true);
      } else if (e.key === "ArrowUp") {
        interacted(); cameraTo({ x: C.x, y: C.y + 70, k: C.k }, true);
      } else if (e.key === "ArrowDown") {
        interacted(); cameraTo({ x: C.x, y: C.y - 70, k: C.k }, true);
      } else handled = false;
      if (handled) e.preventDefault();
    });
    window.addEventListener("resize", function () { measure(false); });
    measure(true);
  }

  if (!ITEMS.length) return;
  var lb = document.getElementById("lb");
  var stage = lb.querySelector(".stage");
  var cnt = lb.querySelector(".cnt");
  var at = 0;
  // Which opening is current: each show() takes the next turn, and closing takes one too, so an older
  // opening still decoding (a quick step, a step and back to the same index, a close) does nothing.
  var turn = 0;

  // The tile's own print, already decoded (it's on the board): the lightbox opens on it at once, sized as
  // the original, and swaps to the original only once that has decoded, so no frame is ever black.
  function tilePrint(i) {
    var t = tiles && tiles.querySelector('.tile[data-i="' + i + '"]');
    if (!t) return null;
    var imgs = t.querySelectorAll("img.tile-media"), best = null;
    for (var k = 0; k < imgs.length; k++) {
      var im = imgs[k];
      if (im.complete && im.naturalWidth && (!best || im.naturalWidth > best.naturalWidth)) best = im;
    }
    return best;
  }

  function show(i) {
    setCenteredTile(null);
    boardVideos.forEach(function (video) { video.pause(); });
    at = (i + ITEMS.length) % ITEMS.length;
    var it = ITEMS[at];
    lb.classList.remove("zoom");
    var el;
    if (it.k === "video") {
      el = document.createElement("video");
      el.src = it.u; el.controls = true; el.autoplay = true; el.playsInline = true; el.loop = true;
    } else {
      el = document.createElement("img");
      el.src = it.u; el.alt = "";
      el.decoding = "async";
      // Tap the photograph to go to NATIVE pixels and let the stage scroll. Preserve the point
      // the person clicked so zooming reveals that detail instead of jumping to a random edge.
      el.addEventListener("click", function (e) {
        var on = !lb.classList.contains("zoom");
        var r = el.getBoundingClientRect();
        var px = r.width ? (e.clientX - r.left) / r.width : .5;
        var py = r.height ? (e.clientY - r.top) / r.height : .5;
        lb.classList.toggle("zoom", on);
        if (!on) { stage.scrollTo(0, 0); return; }
        requestAnimationFrame(function () {
          stage.scrollLeft = Math.max(0, px * el.naturalWidth - stage.clientWidth / 2);
          stage.scrollTop = Math.max(0, py * el.naturalHeight - stage.clientHeight / 2);
        });
      });
    }
    var lo = it.k === "video" ? null : tilePrint(at);
    var mine = ++turn;
    var first = el, full = null;
    if (lo) {
      first = document.createElement("img");
      first.src = lo.currentSrc || lo.src; first.alt = "";
      if (it.w && it.h) { first.width = it.w; first.height = it.h; }
      full = el;
    }
    // Shown, and what was on the stage replaced, only once the print is ready to paint (a decoded image
    // resolves within a frame): neither the dialog's first frame nor a step to the next is ever empty.
    var ready = lo && first.decode ? first.decode().catch(function () {}) : Promise.resolve();
    ready.then(function () {
      if (mine !== turn) return;
      stage.innerHTML = "";
      stage.appendChild(first);
      cnt.textContent = (at + 1) + " / " + ITEMS.length +
        (it.w && it.h ? "  ·  " + it.w + "\u00d7" + it.h : "");
      if (!lb.open) { lb.showModal(); tint(true); }
      if (full) {
        var swap = function () { if (mine === turn && first.parentNode === stage) stage.replaceChild(full, first); };
        if (full.decode) full.decode().then(swap, swap); else full.onload = swap;
      }
    });
  }

  // The page's ground and its theme-color black while the lightbox is open; as they were once it closes (there is no
  // theme-color otherwise, so the browser takes the wall's color from the page).
  function tint(on) {
    document.documentElement.classList.toggle("lb-open", on);
    var m = document.getElementById("lb-tint");
    if (on && !m) {
      m = document.createElement("meta");
      m.id = "lb-tint"; m.name = "theme-color"; m.content = "#000000";
      document.head.appendChild(m);
    } else if (!on && m) m.remove();
  }

  if (tiles) tiles.addEventListener("click", function (e) {
    var b = e.target.closest(".tile");
    if (b) show(Number(b.dataset.i) || 0);
  });
  lb.querySelector(".x").addEventListener("click", function () { lb.close(); });
  lb.querySelector(".prev").addEventListener("click", function () { show(at - 1); });
  lb.querySelector(".next").addEventListener("click", function () { show(at + 1); });
  lb.addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft") { e.preventDefault(); show(at - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); show(at + 1); }
  });
  lb.addEventListener("close", function () {
    tint(false);
    turn++;
    stage.innerHTML = "";
    queueLod();
    queueCenteredTile();
  });
})();
</script>
</body></html>`;
}

/** The one answer for a share that isn't there (never made, revoked, or no such part of it). */
const notFound = () => new Response("Not found", {
  status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
});

/**
 * One of the share's files, with Range as /media/ gives it (src/media-files.js rangedGet): a video element asks for
 * `bytes=0-1` and then open-ended ranges to seek, and Safari on an iPhone won't play a video that answers those
 * with 200 and the whole file.
 */
function serveObject(ctx, key, mime) {
  return rangedGet(ctx.env.MEDIA, key, ctx.request, (obj) => {
    const h = new Headers();
    obj.writeHttpMetadata(h);
    if (mime) h.set("Content-Type", mime);
    h.set("Accept-Ranges", "bytes");
    // Immutable by construction: a new render mints a new id, so this object can never change.
    h.set("Cache-Control", "public, max-age=31536000, immutable");
    h.set("X-Content-Type-Options", "nosniff");
    if (obj.httpEtag) h.set("ETag", obj.httpEtag);
    return h;
  }, notFound);
}

export async function onRequestGet(ctx) {
  const seg = [].concat(ctx.params?.id || []).filter(Boolean);
  const id = String(seg[0] || "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(id)) return notFound();

  const row = await ctx.env.DB.prepare(
    "SELECT id, title, image_key, image_mime, width, height, revoked_at, " +
    "video_key, video_mime, board_x, board_y, board_w, board_h, board_scale, board_ground FROM collage_shares WHERE id = ?1"
  ).bind(id).first();
  // A revoked share is GONE, not hidden: the same answer as an id that never existed, so
  // revoking cannot be told apart from never having shared.
  if (!row || row.revoked_at) return notFound();

  if (seg[1] === "image") return serveObject(ctx, row.image_key, row.image_mime || "image/jpeg");
  if (seg[1] === "video") {
    if (!row.video_key) return notFound();
    return serveObject(ctx, row.video_key, row.video_mime || "video/mp4");
  }
  if (seg[1] === "i") {
    const idx = Number(seg[2]);
    if (!Number.isFinite(idx)) return notFound();
    const it = await ctx.env.DB.prepare(
      "SELECT r2_key, mime, thumb_key FROM collage_share_items WHERE share_id = ?1 AND idx = ?2"
    ).bind(id, Math.round(idx)).first();
    if (!it) return notFound();
    // The photograph's thumbnail (the memory's, kept on the item at share time), or, for an item
    // that has none, the original: the page never meets a 404 for a size. An address of the old
    // sizes (/lod/<n>, from a page cached before them) gets the original too.
    if (seg[3] === "thumb" && seg.length === 4 && it.thumb_key) return serveObject(ctx, it.thumb_key);
    return serveObject(ctx, it.r2_key, it.mime);
  }

  const items = await ctx.env.DB.prepare(
    "SELECT idx, kind, mime, width, height, fx, fy, fw, fh, rot, thumb_key != '' AS has_thumb, pin " +
    "FROM collage_share_items WHERE share_id = ?1 ORDER BY idx"
  ).bind(id).all();

  // The wordmark's own source, fetched through the assets binding so it can be INLINED. See
  // the .mark rule for why an <img> will not do. A failure here costs the mark, not the page.
  let mark = "";
  try {
    const r = ctx.env.ASSETS
      ? await ctx.env.ASSETS.fetch(new URL("/img/wordmark.svg", ctx.request.url))
      : await fetch(new URL("/img/wordmark.svg", ctx.request.url));
    if (r && r.ok) mark = await r.text();
  } catch { /* no mark, still a page */ }

  const origin = new URL(ctx.request.url).origin;
  return new Response(page({
    id, title: row.title || "", width: row.width | 0, height: row.height | 0, origin,
    hasVideo: !!row.video_key, mark,
    // All six, as POST collage/share keeps them, or none (a share made before 0041).
    board: row.board_scale > 0 && GROUNDS[row.board_ground]
      ? { x: Number(row.board_x), y: Number(row.board_y), w: Number(row.board_w), h: Number(row.board_h), scale: Number(row.board_scale), ground: row.board_ground }
      : null,
    items: (items.results || []).map((r) => ({
      idx: r.idx, kind: r.kind, width: r.width | 0, height: r.height | 0,
      fx: Number(r.fx) || 0, fy: Number(r.fy) || 0,
      fw: Number(r.fw) || 0, fh: Number(r.fh) || 0, rot: Number(r.rot) || 0, thumb: !!r.has_thumb,
      pin: r.pin == null ? null : Number(r.pin),
    })),
  }), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}

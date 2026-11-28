// memories.js — the Memories tab: feed, full-screen viewer, tags, upload.
//
// Data model: a MEMORY is one card holding N media items (photos and/or
// videos), an optional caption and tag rows. Any trip member sees everything; the author
// deletes their own memory (the trip's host may too; the API is the authority); nobody edits
// anyone else's, and nobody edits their own: delete and re-post is the edit.
//
// ── WIRE CONTRACT (docs/API.md is the authority) ──────────────────────────────────────────
// Every address is the trip's: `:trip` stands for /api/trips/<id>, the trip in the page's
// address, and T("/memories") below builds it (store.tripApi).
//
//   GET    :trip/memories[?tag=&before=&before_id=&limit=]
//            -> { memories, tags:[{tag,count}], has_more, next_before, next_before_id }
//          each memory: { id, caption, created_by, created_at, user_name, initials,
//            note_color, tags:[..], media:[{ id, kind, key, thumb_key, url, thumb_url,
//            mime, orig_name, width, height, duration_s, bytes, sort }], bytes }
//   POST   :trip/media/begin  {name,mime,bytes,kind}   -> { key, uploadId, part_size, parts }
//   POST   :trip/media/part   ?key=&id=&n=   (binary)  -> { n, etag }
//   POST   :trip/media/finish {key,id,parts:[{n,etag}]} -> { ok, key, bytes, url }
//   POST   :trip/media/thumb  ?for=<orig>&mime=image/webp  (binary) -> { key, url }
//   POST   :trip/memories     {id, caption, tags, media:[{key,thumb_key,kind,w,h,duration}]}
//                                                       -> { memory } 201
//   DELETE :trip/memories/:id its author or the trip's host -> { ok, freed_bytes, boards_unshared }
//
// Saving is DELEGATED: memories-save.js owns the share-sheet batching, the byte budget, the
// fidelity length-check and the download fallback. This module hands it memory_media rows and
// renders the numbers it reports — it never fetches an original for saving itself.
//
// ── FIDELITY (the spec's guarantee, upheld here) ──────────────────────────────────────────
// This module never touches the original's bytes: File.slice() -> XHR, part by part, exactly
// what the browser handed us. Thumbs are ADDITIVE derived files (canvas webp ~480px, a poster
// frame for video); a failed thumb costs a placeholder tile, never the upload. The file
// input's accept list names image/heic, image/heif, video/quicktime and video/mp4 explicitly
// so iOS hands over originals unconverted where it is willing to.
//
// ── OFFLINE STANCE ──────────────────────────────────────────────────────────────────────────
// Feed metadata caches in this module's own IndexedDB (the packing.js `struct` precedent:
// store.js has no memories accessor, so this is a SEAM, quarantined here — when store.js
// grows one, delete this layer and repoint). Thumbs and prefetched originals live in sw.js's
// MEDIA cache, driven through mediaCache in memories-save.js. UPLOADS REQUIRE SIGNAL — the
// job queue below is memory-only, deliberately: a 4K video in IndexedDB is how the origin
// blows its quota and iOS evicts the itinerary with it. A job survives leaving the tab
// (module scope), survives a radio drop (it waits, labelled honestly, and resumes from the
// next unsent part), and does NOT survive the page being killed.
//
// Owner prefix .me-*; styles in public/css/memories.css (linked from index.html).

import { fmtDay, fmtTime, dayKey, esc, uid, toMs, setDisabled } from "./util.js";
import { takenAt } from "./shared/taken.js";
import { MEMORY_MEDIA_MAX } from "./shared/limits.js";
import { flip, reducedMotion, ms } from "./motion.js";
import { focusKeeper, openSheet } from "./sheet.js";
import { toast } from "./toast.js";
import { siteUrl } from "./site.js";
import { boardsWarning, boardsUnshared, boardState, boardMaker, mayStopBoard } from "./board-words.js";
// The ground table only — a handful of strings, not the renderer. The board itself stays lazy.
import { GROUNDS as COLLAGE_GROUNDS } from "./collage-layout.js";
import { store } from "./store.js";
import { within, sendBytes, STALL_MS } from "./net.js";
import { pictureNow, wakePictures } from "./pictures.js";
import { dbName } from "./trip-here.js";
import { adoptOldRows } from "./trip-adopt.js";
import {
  mediaUrl, createSaveSession, saveLabel, canSaveToPhotos, downloadBatch, mediaCache,
} from "./memories-save.js";
import { fastHash } from "./shared/fasteners.js";
import { faceHtml, personTone, personVars } from "../ds/avatar.js";

// ── constants ─────────────────────────────────────────────────────────────────────────────
const PART_BYTES = 8 * 1024 * 1024;    // default part size; begin's part_size overrides it
const THUMB_PX = 480;                  // longest edge of a derived thumb
const THUMB_Q = 0.8;
const PAGE = 12;                       // cards rendered per infinite-scroll step
const FETCH_LIMIT = 40;                // memories per API page (server caps at 90)
const REFRESH_MS = 90_000;             // feed heartbeat while mounted, matching store.js
const PREWARM_MAX = 25 * 1024 * 1024;  // a photo original this size may be primed in RAM so
                                       // the viewer's Save is ONE tap; anything bigger (all
                                       // video) stays two honest taps with visible progress

// Mirrors ACCEPT in functions/api/media.js — HEIC/HEIF/QuickTime named EXPLICITLY so iOS
// hands over originals unconverted (spec caveat 1). Restated rather than fetched because the
// composer must open with no network at all.
const ACCEPT = [
  "image/*", "video/*",
  "image/heic", "image/heif", "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/quicktime", "video/mp4", "video/webm",
].join(",");

// ── glyphs (inline, .ico-compatible: 24x24 stroke) ────────────────────────────────────────
const GL = {
  // share/save: the iOS share square with the rising arrow — honest about the mechanism,
  // which is the share sheet's own "Save" button, never a silent write.
  save: '<path d="M12 3.2v10.6"/><path d="m8.2 6.6 3.8-3.4 3.8 3.4"/><path d="M6.4 10.4H5.2a1.8 1.8 0 0 0-1.8 1.8v6.6a1.8 1.8 0 0 0 1.8 1.8h13.6a1.8 1.8 0 0 0 1.8-1.8v-6.6a1.8 1.8 0 0 0-1.8-1.8h-1.2"/>',
  trash: '<path d="M4.4 6.6h15.2"/><path d="M9 6.6V4.8a1.4 1.4 0 0 1 1.4-1.4h3.2A1.4 1.4 0 0 1 15 4.8v1.8"/><path d="M6.2 6.6l.9 12.6a1.8 1.8 0 0 0 1.8 1.6h6.2a1.8 1.8 0 0 0 1.8-1.6l.9-12.6"/><path d="M10 10.4v6M14 10.4v6"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  // a solid play triangle: at 16px an outlined one fills itself and goes grey
  play: '<path d="M9 6.8v10.4l8.4-5.2Z" fill="currentColor" stroke="none"/>',
  // not-yet-downloaded: an arrow into a DASHED tray — the app's offline shape is the dash
  // (netline), so the state is carried by shape, never by hue
  miss: '<path d="M12 4.2v9.2"/><path d="m8.4 10.2 3.6 3.2 3.6-3.2"/><path d="M4.6 16.4v1.8a1.6 1.6 0 0 0 1.6 1.6h1M10.6 19.8h2.8M16.8 19.8h1a1.6 1.6 0 0 0 1.6-1.6v-1.8"/>',
  // A chain link, for the share URL. Distinct from `save` (an arrow out of a tray) because one
  // hands you a file and the other hands you an address.
  link: '<path d="M10.2 13.8a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 1 0-5.7-5.7l-1.2 1.2"/>'
      + '<path d="M13.8 10.2a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.2-1.2"/>',
  photo: '<rect x="3" y="5" width="18" height="15" rx="2.5"/><circle cx="9" cy="10.2" r="1.7"/><path d="m3.6 17.4 4.8-4.6 3.4 3.2 3.8-4 4.6 4.8"/>',
  tag: '<path d="M3.6 11.4V4.8A1.2 1.2 0 0 1 4.8 3.6h6.6a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8l-5.4 5.4a2 2 0 0 1-2.8 0l-7-7a2 2 0 0 1-.6-1.4Z"/><circle cx="8.2" cy="8.2" r="1.3"/>',
  // A memory's day: a calendar page.
  when: '<rect x="3.6" y="5" width="16.8" height="15" rx="2"/><path d="M3.6 9.8h16.8M8 3.2v3.6M16 3.2v3.6"/>',
};
const ico = (id, cls = "") =>
  `<svg class="ico${cls ? " " + cls : ""}" viewBox="0 0 24 24" aria-hidden="true">${GL[id]}</svg>`;

// The view registry (Feed ⇄ Board). There was a List view too: the Feed's posts without their pictures, a second way to
// see the same thing; it went on 25 Nov 2026 (a phone that kept "list" as its view opens on the Feed).
const VIEW_KEY = "wgp.memview";
const VIEWS = [
  { id: "feed", label: "Feed", glyph: GL.photo, mount: null },
  // The board view keeps id:"collage" and persistent preference while wearing the "Board" label.
  { id: "collage", label: "Board",
    glyph: '<rect x="3.5" y="3.5" width="10.5" height="10.5" rx="2"/><rect x="10" y="10" width="10.5" height="10.5" rx="2"/>',
    mount: (host, ctx) => mountCollageSlot(host, ctx) },
];

// THE COLLAGE SLOT. The toggle hands every view the same {rows, opts} and
// wants a synchronous {update, unmount} back, but the board is two modules away from that: the
// layout engine turns memory rows into geometry, and collage.js renders geometry it is GIVEN and
// never computes. This adapter is the join, and it is deliberately the only place that knows both.
//
// The board is imported LAZILY. It is the heaviest thing in the app — renderer, video pool, frame
// registry, layout solver — and the two views most people open are the two that are already here.
//
// The seed comes from the trip, not from this device: a board everyone on the trip sees the same
// way is the point of storing it server-side (functions/api/trip.js mints it once). Falling back
// to the trip id keeps the board STABLE rather than random if a cold offline launch has no seed
// yet — a stable arrangement built from the wrong seed is a board; a fresh seed every mount is not.
/** The grounds, as the appearance drawer wants them: ordered, with a light-theme swatch. */
const GROUND_LIST = Object.entries(COLLAGE_GROUNDS)
  .map(([key, g]) => ({ key, label: g.label, fill: g.fill.light }));

// The empty board's words sit ON the board: the card is drawn in screen px and the board in the camera's, so the card
// is placed on the board's cork wherever the board is on the screen, inside its frame by EMPTY_MARGIN, and kept there as
// the camera moves. Too tall for a small board, it drops its picture, then its sentence: the name and Add photos stay.
const EMPTY_MARGIN = 16;
function placeEmpty(stage) {
  const box = stage && stage.querySelector(":scope > .me-altempty");
  const bd = stage && stage.querySelector(".cg-board");
  if (!box || !bd || !bd.offsetWidth) return;
  const s = stage.getBoundingClientRect(), r = bd.getBoundingClientRect();
  const k = r.width / bd.offsetWidth;
  const inW = bd.clientWidth * k, inH = bd.clientHeight * k;
  const maxW = Math.max(0, inW - 2 * EMPTY_MARGIN), maxH = Math.max(0, inH - 2 * EMPTY_MARGIN);
  box.style.left = `${r.left + bd.clientLeft * k + inW / 2 - s.left - stage.clientLeft}px`;
  box.style.top = `${r.top + bd.clientTop * k + inH / 2 - s.top - stage.clientTop}px`;
  box.style.width = `${Math.min(300, maxW)}px`;
  box.classList.remove("me-altempty-tight", "me-altempty-tighter");
  if (box.offsetHeight > maxH) box.classList.add("me-altempty-tight");
  if (box.offsetHeight > maxH) box.classList.add("me-altempty-tighter");
}

function mountCollageSlot(host, ctx) {
  let board = null;          // the mounted handle, once the import lands
  let rows = ctx.rows;       // latest rows, in case update() beats the import
  let dead = false;
  let viewing = false;       // a memory is open over the board: its videos stay paused
  let onNet = null;          // the data saver's listener, taken off at unmount
  let lastBox = "";          // the box we last wrote, so sizeHost() is idempotent

  const seed = () => {
    const t = store.trip();
    return (t && t.collage_seed) || store.tripId();
  };

  // ── the appearance settings ────────────────────────────────────────────────────────────
  // The collage screen's own settings decide how the collage displays: which photo styles
  // are in it, which background it sits on, and how many photos it takes from each
  // memory.
  //
  // PER DEVICE, not per trip, and localStorage rather than the store. The SEED is server-side
  // on purpose — "a board everyone on the trip sees the same way is the point" — but how YOU
  // like to look at it is not a fact about the holiday, and syncing it would mean one person's
  // taste in backgrounds redecorating everybody else's board.
  const LOOK_KEY = "wgp.collage.look";
  // A look stored before every photo went bare may still carry `frame` (mixed, polaroid, print): it is kept as
  // stored and no longer read; the board is bare whatever it says.
  const LOOK_DEFAULT = { background: "", perMemory: 0 };
  const readLook = () => {
    try {
      const v = JSON.parse(localStorage.getItem(LOOK_KEY) || "{}");
      return { ...LOOK_DEFAULT, ...(v && typeof v === "object" ? v : {}) };
    } catch { return { ...LOOK_DEFAULT }; }
  };
  const writeLook = (next) => {
    look = { ...look, ...next };
    try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch { /* private mode */ }
    if (board && board.rebuild) board.rebuild(rows);
  };
  let look = readLook();

  // `background: ""` is Automatic, offered first: the board's own default, the cork.
  // The Layout currently on the board. Kept because the export must render THE BOARD SOMEBODY
  // IS LOOKING AT — building a fresh one at save time would re-roll nothing (the seed is
  // stable) but would silently ignore an appearance change that had not been rebuilt yet.
  let lastLayout = null;
  const build = (L, list) => {
    lastLayout = L.layoutCollage(
      L.mediaFromMemories(list, { order: "chrono", perMemory: look.perMemory }),
      { seed: seed(), mediaUrl,
        ...(look.background ? { background: look.background } : {}) }
    );
    return lastLayout;
  };

  // THE BOARD NEEDS A DEFINITE HEIGHT AND THE STAGE HAS NONE. Feed and list are flow content, so
  // the stage takes its height from the rows inside it; the board is position:absolute and gives
  // the stage nothing to be tall for. Left alone it collapses to 0 and every photo renders at
  // about one pixel — a mounted, item-populated, completely invisible board.
  // Measured rather than hard-coded, because the tag-filter row above it appears and disappears.
  //
  // IT ALSO HAS TO BLEED, and that is the same measurement read the other way. #view is the
  // scroller under every route and keeps a gutter on all four sides — 16px at the sides (--sp-4,
  // or the safe-area inset where that is larger) and 32px of floor (--sp-6) — so a stage that is
  // merely a child of it is a corkboard with a margin painted round it. The board as
  // it first shipped sat inset, and it felt wrong: it should run border to border, the
  // bottom of the corkboard touching the top of the tab bar and its sides
  // the edges of the device. That is the right read of which thing this is: the collage is the
  // one view in the app that is a SURFACE rather than a column of rows, and a surface with a
  // gutter round it reads as a widget sitting on a page.
  //
  // Negative margins are how the rest of the app leaves that gutter (styles.css, .st-band), and
  // as there, each side cancels the padding it actually HAS rather than a token restated here:
  // the two side insets are not equal on a notched phone in landscape, and the floor is not
  // always --sp-6 — body[data-back] and body[data-netpill] both grow it to clear the dock.
  // getComputedStyle is the only version of this that cannot drift away from the shell.
  const scroller = () => host.parentElement || document.documentElement;
  const sizeHost = () => {
    if (host.hidden || getComputedStyle(host).display === "none") return false;
    const sc = scroller();
    const pad = getComputedStyle(sc);
    const padBottom = parseFloat(pad.paddingBottom) || 0;
    const padLeft = parseFloat(pad.paddingLeft) || 0;
    const padRight = parseFloat(pad.paddingRight) || 0;
    // THE HEIGHT RUNS TO THE SCROLLER'S OWN EDGE NOW, AND THE NEGATIVE FLOOR IS WHAT PAYS FOR IT.
    // clientHeight is the PADDING box, so it already counts #view's bottom padding, and that is
    // exactly how far down the board is meant to reach: <body> is a flex column of #view then
    // .tabbar, the bar is not an overlay, so #view's bottom border edge IS the top edge of the
    // tab bar. What must not happen is that extra 32px turning back into scroll. It cannot,
    // because scrollHeight is set by the last child's MARGIN box plus the scroller's own bottom
    // padding: the host is grown by padBottom and pulled back by the identical number, so its
    // border box lands on the tab bar while its margin box lands on the content floor, where it
    // has always been. Take one of the two away and the board scrolls again.
    // MEASURED at 393x852 before any of this existed: stage 195..757 against a content floor of
    // 725, scrollHeight 789 vs clientHeight 757 — a 32px scroll underneath a pinch/pan surface,
    // and the same 32px with the insets at zero, so it was never about the notch. The inset part
    // was always right: #view's own bottom edge moves with --tabbar-space and clientHeight
    // follows it (791 -> 757). MEASURED again with the bleed in: stage 195..757 and margin box
    // to 725, scrollHeight 757 vs clientHeight 757, board 0..393 across a 393px viewport, board
    // bottom 757 against a tab bar whose top is 757.
    const avail = sc.clientHeight - host.offsetTop;
    const next = Math.max(240, Math.round(avail));
    // Include sc.clientWidth so viewport width transitions (1440 <-> 390) always invalidate & re-fit.
    const box = `${sc.clientWidth}|${next}|${padLeft}|${padRight}|${padBottom}`;
    if (box === lastBox) return false;         // idempotent, so the observer below cannot loop
    lastBox = box;
    host.style.height = `${next}px`;
    host.style.marginLeft = `${-padLeft}px`;
    host.style.marginRight = `${-padRight}px`;
    host.style.marginBottom = `${-padBottom}px`;
    return true;
  };
  const onResize = () => {
    if (!sizeHost() || !board) return;
    const cam = typeof board.camera === "function" ? board.camera() : null;
    const wasFitted = !cam || cam.k <= cam.minK * 1.03;
    board.invalidate();
    if (wasFitted && typeof board.fit === "function") board.fit(false);
  };
  sizeHost();
  window.addEventListener("resize", onResize);
  window.visualViewport?.addEventListener("resize", onResize);
  // THE ROW ABOVE THE BOARD ARRIVES LATE. `.me-tags` is rendered `hidden` and unhides only once
  // the tag list is known, which pushes the host down by the whole height of the filter row —
  // a layout change that fires no `resize` event, so the height measured at mount was simply
  // wrong from then on. MEASURED: one run in five came back 594px instead of 530px at 393x852,
  // the difference being exactly the 64px tag row, and the board stayed 64px too tall for the
  // life of the view. A cold phone is MORE likely to lose that race than this machine is.
  // The observer watches the siblings, not the host: the host's own height is what we set.
  const ro = new ResizeObserver(() => onResize());
  for (const sib of host.parentElement ? host.parentElement.children : []) if (sib !== host) ro.observe(sib);

  // THE APPEARANCE BUTTON. On the board's top-right corner rather than in the tag row above it:
  // the board bleeds to the edges of the device and the row does not, so a control for the
  // surface belongs on the surface. It is a child of `host`, not of the board's own root —
  // collage.js empties and refills that root as it virtualizes, and would take the button with it.
  const lookBtn = document.createElement("button");
  lookBtn.type = "button";
  lookBtn.className = "cg-look";
  lookBtn.setAttribute("aria-label", "The board's look");
  lookBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/>'
    + '<circle cx="15" cy="7" r="2.4"/><circle cx="9" cy="17" r="2.4"/></svg>';
  lookBtn.addEventListener("click", () => openLookSheet());
  host.appendChild(lookBtn);
  // Saving the board and sharing it by link live in the same drawer, under the sliders, where someone who wants to
  // share it doesn't look (17 Nov, a stranger's walk): a named way in beside it.
  const shareBtn = document.createElement("button");
  shareBtn.type = "button";
  shareBtn.className = "cg-look cg-look-share";
  shareBtn.innerHTML = ico("save") + "<span>Save or share</span>";
  shareBtn.addEventListener("click", () => openLookSheet());
  host.appendChild(shareBtn);

  /** The drawer. Rebuilt from `look` every time it opens, so it can never show a stale state. */
  function openLookSheet() {
    const body = document.createElement("div");
    body.className = "cg-looksheet ds";

    const group = (label, hint, rows) =>
      '<h3 class="cg-lookhead">' + esc(label) + '</h3>'
      + (hint ? '<p class="cg-lookhint">' + esc(hint) + '</p>' : "")
      + '<div class="cg-lookrow">' + rows + '</div>';
    const chip = (name, value, label, on, extra) =>
      '<button type="button" class="cg-chip" data-g="' + name + '" data-v="' + value + '"'
      + ' aria-pressed="' + (on ? "true" : "false") + '">'
      + (extra || "") + '<span>' + esc(label) + '</span></button>';

    const grounds = [{ key: "", label: "Automatic", swatch: COLLAGE_GROUNDS.corkboard.fill.light }].concat(
      GROUND_LIST.map((g) => ({ key: g.key, label: g.label, swatch: g.fill })));
    body.innerHTML =
      group("Background", "The board itself — and what holds the photos to it.",
        grounds.map((g) => chip("background", g.key, g.label, look.background === g.key,
          '<span class="cg-sw" style="background:' + g.swatch + '"></span>')).join(""))
      + group("Photos from each memory",
        "Fewer means more memories fit on one board.",
        [["0", "All"], ["1", "1"], ["2", "2"], ["3", "3"], ["5", "5"]]
          .map(([v, l]) => chip("perMemory", v, l, String(look.perMemory) === v)).join(""));

    body.addEventListener("click", (ev) => {
      const b = ev.target.closest(".cg-chip");
      if (!b) return;
      const g = b.dataset.g;
      const v = g === "perMemory" ? Number(b.dataset.v) : b.dataset.v;
      // Repaint the pressed state here rather than re-rendering the sheet: re-rendering under a
      // thumb that is still on the glass is how a second tap lands on a different control.
      for (const o of body.querySelectorAll('.cg-chip[data-g="' + g + '"]')) {
        o.setAttribute("aria-pressed", o === b ? "true" : "false");
      }
      writeLook({ [g]: v });
    });

    // ── the trip's shared links ──────────────────────────────────────────────────────────
    // Every board the trip has shared, newest first, to any member: who made it, whether its
    // link still opens and, when it doesn't, why. Its maker or the trip's host can stop one.
    // The list is the server's; nothing of it is kept on the phone, so it needs a connection.
    const links = document.createElement("section");
    links.className = "cg-links";
    links.innerHTML = '<h3 class="cg-lookhead">Shared links</h3>'
      + '<p class="cg-lookhint cg-linksnote" role="status"></p>'
      + '<ul class="cg-linklist"></ul>';
    body.appendChild(links);
    const linksNote = links.querySelector(".cg-linksnote");
    const linkList = links.querySelector(".cg-linklist");
    let shares = [];
    let asking = "";                    // the id of the board whose "Stop sharing" was tapped once
    const NEEDS_SIGNAL = "Shared links show when you have a connection.";

    function paintShares() {
      const me = store.me().id || "";
      const t = store.trip();
      const hostId = (t && t.host_id) || "";
      const nameOf = (id) => { const m = (store.members() || []).find((x) => x && x.id === id); return (m && m.name) || ""; };
      linkList.innerHTML = shares.map((sh) => {
        const made = `${fmtDay(sh.created_at, tripTz())}, ${fmtTime(sh.created_at, tripTz())}`;
        const state = boardState(sh, { me, hostId, nameOf, day: sh.revoked_at ? fmtDay(sh.revoked_at, tripTz()) : "" });
        let acts = "";
        if (!sh.revoked) {
          acts = asking === sh.id
            ? '<p class="cg-linkask">Stop sharing this board? Its link will no longer open.</p>'
              + '<div class="cg-linkacts">'
              + '<button class="btn btn-danger cg-linkstop" type="button" data-id="' + esc(sh.id) + '">Stop sharing</button>'
              + '<button class="btn cg-linkkeep" type="button">Keep it shared</button></div>'
            : '<div class="cg-linkacts">'
              + '<button class="btn cg-linkcopy" type="button" data-url="' + esc(sh.url) + '">Copy link</button>'
              + (mayStopBoard(sh, { me, hostId })
                ? '<button class="btn cg-linkask1" type="button" data-id="' + esc(sh.id) + '">Stop sharing…</button>' : "")
              + '</div>';
        }
        return '<li class="cg-link" data-id="' + esc(sh.id) + '" data-live="' + (sh.revoked ? "0" : "1") + '">'
          + '<p class="cg-linkwho">' + esc(boardMaker(sh.created_by, { me, nameOf })) + ' · ' + esc(made) + '</p>'
          + '<p class="cg-linkstate">' + esc(state) + '</p>' + acts + '</li>';
      }).join("");
    }

    async function loadShares() {
      if (!store.online()) { linksNote.textContent = NEEDS_SIGNAL; linksNote.hidden = false; return; }
      const res = await api("GET", T("/collage/shares"));
      if (!links.isConnected) return;
      if (!res.ok) {
        linksNote.textContent = res.offline ? NEEDS_SIGNAL : "The shared links couldn't be read. Close this and open it again.";
        linksNote.hidden = false;
        return;
      }
      shares = Array.isArray(res.body && res.body.shares) ? res.body.shares : [];
      linksNote.textContent = shares.length ? "" : "Nothing from this trip is shared yet.";
      linksNote.hidden = shares.length > 0;
      paintShares();
    }

    links.addEventListener("click", async (ev) => {
      const b = ev.target.closest("button");
      if (!b || b.disabled) return;
      if (b.classList.contains("cg-linkcopy")) {
        const url = (await siteUrl(b.dataset.url)) ?? b.dataset.url;   // the site's address, never this page's
        try { await navigator.clipboard.writeText(url); toast("Link copied."); }
        catch { toast(url); }                                   // no clipboard: show it to copy by hand
        return;
      }
      if (b.classList.contains("cg-linkask1")) {
        asking = b.dataset.id;
        paintShares();
        // The button that was pressed is gone with the repaint. The focus goes to the one
        // that keeps, never to "Stop sharing".
        focusKeeper(linkList.querySelector(`.cg-link[data-id="${CSS.escape(asking)}"]`));
        return;
      }
      if (b.classList.contains("cg-linkkeep")) {
        const id = asking;
        asking = "";
        paintShares();
        // Back to the button the ask came from, so a keyboard is where it was.
        const back = linkList.querySelector(`.cg-link[data-id="${CSS.escape(id)}"] .cg-linkask1`);
        if (back) back.focus({ preventScroll: true });
        return;
      }
      if (b.classList.contains("cg-linkstop")) {
        b.disabled = true;
        const res = await api("DELETE", T(`/collage/share/${encodeURIComponent(b.dataset.id)}`));
        asking = "";
        if (!res.ok) {
          toast(res.offline ? "Stopping a link needs a connection."
            : res.status === 403 ? "Only its maker or the trip's host can stop a shared board."
            : "That link couldn't be stopped. Try again.");
          if (links.isConnected) paintShares();
          return;
        }
        if (links.isConnected) await loadShares();
      }
    });
    loadShares();

    // ── save it out ──────────────────────────────────────────────────────────────────────
    // Renders the collage for export either as a still image or as
    // a looping video (with board clips playing). Both come off the same
    // Layout the board is showing, so what you save is what you were looking at.
    const foot = document.createElement("div");
    foot.className = "cg-lookfoot ds";
    foot.innerHTML =
      '<button class="btn cg-save" type="button" data-kind="image">' + ico("save") + 'Save image</button>' +
      '<button class="btn cg-save" type="button" data-kind="video">' + ico("save") + 'Save video</button>' +
      '<button class="btn cg-save cg-sharelink" type="button" data-kind="link">' + ico("link") +
        'Create a share link</button>' +
      '<div class="me-frout" hidden><input class="input num grow cg-shareurl" type="text" readonly ' +
        'aria-label="Share link"></div>' +
      '<p class="cg-lookstat" role="status" aria-live="polite"></p>';
    const stat = foot.querySelector(".cg-lookstat");

    foot.addEventListener("click", async (ev) => {
      const b = ev.target.closest(".cg-save");
      if (!b || b.disabled) return;
      const kind = b.dataset.kind;
      const wantVideo = kind === "video";
      const btns = [...foot.querySelectorAll(".cg-save")];
      for (const x of btns) x.disabled = true;
      stat.textContent = wantVideo ? "Recording the board…" : "Drawing the board…";
      try {
        const X = await import("./collage-export.js");
        if (wantVideo && !X.canExportVideo()) {
          stat.textContent = "This browser cannot record video.";
          return;
        }
        // The Layout the BOARD is showing, not a fresh one: a re-roll here would hand somebody
        // a picture of a board they have never seen.
        const L = await import("./collage-layout.js");
        const lay = lastLayout || build(L, rows);
        if (kind === "link") {
          // A SHARE IS A SNAPSHOT. The picture is rendered here and posted as bytes, so what a
          // stranger opens in six months is what the board looked like today — it does not
          // re-query a trip whose media may be long gone.
          stat.textContent = "Rendering the board…";
          const shot = await X.exportCollage(lay, { type: "image/jpeg", quality: 0.86 });
          stat.textContent = "Uploading…";
          const trip = store.trip();
          // The board in the picture (the picture is the board on its band of wall), as fractions of it, and its
          // material: the shared page draws the same board on the same wall (collage-layout.js boardOf, BOARD_LOOK).
          const B = shot.plan.board, f4 = (v) => (Math.round(v * 10000) / 10000).toFixed(4);
          const qs = new URLSearchParams({
            mime: shot.type, w: String(shot.width), h: String(shot.height),
            title: (trip && trip.name) || "Our trip",
            ...(B ? { bx: f4(B.x / shot.plan.width), by: f4(B.y / shot.plan.height), bw: f4(B.w / shot.plan.width), bh: f4(B.h / shot.plan.height),
              bg: shot.plan.background,
              // Export pixels per board unit: the page draws the cork's tile and the frame at the app's sizes.
              bs: String(Number(shot.plan.scale.toPrecision(6))) } : {}),
          });
          const r = await postBytes(T(`/collage/share?${qs}`), shot.blob);
          if (!r.ok) {
            // The host's storage is full: the server's sentence says whose, how much is left
            // and who can free it. Nothing was stored, so there is no link to show.
            const why = refusalSentence(r.status, await r.json().catch(() => null));
            if (why) { stat.textContent = why; return; }
            throw new Error("share failed: " + r.status);
          }
          const { share } = await r.json();
          const url = (await siteUrl(share.url)) ?? share.url;   // the site's address, never this page's
          // EVERY PRINT, AT ITS OWN RESOLUTION. The board is capped at 4096px by the canvas
          // ceiling, which leaves each photograph about 800px — an overview, not something to
          // zoom into. So each original is copied beside it and the share page opens THAT when
          // you tap a print. Best-effort and one call each: the share is already complete, and
          // a phone that gives up halfway leaves some prints un-tappable rather than no share.
          stat.textContent = "Adding full-resolution photos…";
          let itemsWhy = "";
          let unreadable = 0;         // prints this browser couldn't make into something the server keeps
          try {
            const rects = X.itemRects(lay, shot.plan);
            const R = shot.plan.rect;
            let done = 0, sent = 0;
            for (const r of rects) {
              const it = lay.items.find((x) => x.id === r.id);
              if (!it) continue;
              const src = it.origUrl || it.thumbUrl;
              if (!src) continue;
              let blob;
              try {
                const g = await fetch(src, { credentials: "same-origin" });
                if (!g.ok) continue;
                blob = await g.blob();
              } catch { continue; }
              // THE SERVER KEEPS ONLY WHAT IT CAN CLEAN: JPEG, PNG, WebP, MP4 and MOV. An iPhone's HEIC
              // (or an AVIF) goes as a JPEG drawn here; a video it can't take goes as its poster, a
              // photo. One this browser can't draw either is counted and said below, never dropped.
              let piece = await sendable(it, blob);
              if (!piece) { unreadable++; continue; }
              const idx = String(r.z != null ? r.z : sent);
              const qsFor = (p) => new URLSearchParams({
                idx, kind: p.kind,
                mime: p.blob.type || "image/jpeg",
                w: String(p.w || 0), h: String(p.h || 0),
                fx: String((r.canvasCx - r.canvasW / 2 - R.x) / R.w),
                fy: String((r.canvasCy - r.canvasH / 2 - R.y) / R.h),
                fw: String(r.canvasW / R.w), fh: String(r.canvasH / R.h),
                rot: String(r.rot || 0),
                // The print's fastener stream, so the shared page puts the same tack or magnet on it as the app.
                pin: String(fastHash(lay.seed, it.id)),
              });
              const qs2 = qsFor(piece);
              // THE MEMORY THIS PHOTOGRAPH CAME FROM. The server keeps it beside the copy, so
              // deleting that memory takes down every shared board that shows it: a person
              // who deletes a photograph has deleted it from the links too. It refuses an id
              // that is not a memory of this trip (400), which is a memory deleted while the
              // board was being shared: that print stays un-tappable, as it should.
              // AND WHICH OF THE MEMORY'S PHOTOGRAPHS IT IS. The server keeps that photograph's
              // thumbnail with the copy, and the board's page draws a small tile from it
              // instead of the original. Only ever with its memory (alone it is refused), and
              // one taken out of the memory meanwhile is refused like a deleted memory.
              const withMemory = (q) => {
                if (it.memoryId) q.set("memory", String(it.memoryId));
                if (it.memoryId && it.mediaId) q.set("media", String(it.mediaId));
                return q;
              };
              withMemory(qs2);
              sent++;
              const post = (q, body) => postBytes(T(`/collage/share/${encodeURIComponent(share.id)}/item?${q}`), body);
              let put = await post(qs2, piece.blob);
              // A type the browser named wrongly (a HEIC called a JPEG, say): drawn and sent once more.
              if (put.status === 415 && piece.kind === "photo" && !piece.drawn) {
                const again = await drawnJpeg(piece.blob);
                if (!again) { unreadable++; continue; }
                piece = { ...again, kind: "photo", drawn: true };
                put = await post(withMemory(qsFor(piece)), piece.blob);
              }
              if (put.ok) done++;
              else if (put.status === 415) unreadable++;     // still not a type it keeps: said below
              else {
                // Full part-way through: every later one would be refused too. The link
                // itself is whole, and the person is told why some prints will not open.
                // (Any other refusal is about this one photograph, and the next is tried.)
                itemsWhy = refusalSentence(put.status, await put.json().catch(() => null));
                if (itemsWhy) break;
              }
              stat.textContent = `Adding full-resolution photos… ${done}/${rects.length}`;
            }
          } catch (e) { console.warn("[collage] share items", e); }

          // THE LOOP, IF THIS DEVICE CAN MAKE ONE. Attached as a second call on purpose: the
          // still is the funnel and has already landed, so a phone that cannot record — or a
          // recording that fails — costs the share its motion and nothing else.
          if (X.canExportVideo() && !itemsWhy) {
            stat.textContent = "Recording the loop…";
            try {
              const clip = await X.exportCollageVideo(lay, {});
              if (clip && clip.bytes) {
                await postBytes(T(`/collage/share/${encodeURIComponent(share.id)}/video?mime=${
                  encodeURIComponent(clip.type)}`), clip.blob);
              }
            } catch (e) { console.warn("[collage] share video", e); }
          }
          const out2 = foot.querySelector(".me-frout");
          const field = foot.querySelector(".cg-shareurl");
          out2.hidden = false;
          field.value = url;
          field.focus();
          field.select();
          const tail = itemsWhy ? ` Some photos on it won't open full size: ${itemsWhy}`
            : unreadable ? ` ${unreadable === 1 ? "1 photo" : `${unreadable} photos`} on it won't open full size: this browser can't read ${unreadable === 1 ? "it" : "them"}.`
            : "";
          try { await navigator.clipboard.writeText(url); stat.textContent = "Link copied." + tail; }
          catch { stat.textContent = "Link ready — tap it to copy." + tail; }
          loadShares();                 // the new board joins the list below
          return;
        }
        const out = wantVideo
          ? await X.exportCollageVideo(lay, { onProgress: (p) => {
              if (p.phase === "recording") stat.textContent = `Recording ${p.seconds}s…`;
            } })
          : await X.exportCollage(lay, {});
        stat.textContent = "Saving…";
        const res = await X.shareExport(out, { title: "Our collage" });
        stat.textContent = res && res.status === "cancelled" ? ""
          : res && res.status === "saved" ? "Saved."
          : "Saved to your downloads.";
      } catch (e) {
        console.error("[collage] export", e);
        stat.textContent = "Could not save that. Try again?";
      } finally {
        for (const x of btns) x.disabled = false;
      }
    });

    openSheet({ title: "Board", contentEl: body, footEl: foot, footRow: true, dragFrom: "handle" });
  }

  Promise.all([import("./collage-layout.js"), import("./collage.js"), import("./collage-video.js")])
    .then(([L, C, V]) => {
      if (dead) return;
      sizeHost();
      // The board's videos play in place: the few nearest the middle loop their trimmed seconds,
      // muted, paused once off screen (collage-video.js; collage.js ranks them and caps them at
      // three). Under reduced motion collage.js publishes none, and the posters keep their play
      // disc. A phone saving data gets the same: the clips are the originals, streamed, so none
      // starts by itself there either. A tap opens the memory, where the whole clip plays.
      //
      // The pool is paused for more than one reason at once (the page hidden, a memory open over
      // the board, the phone saving data), and collage.js resumes it on its own reason alone (the
      // page shown again). So the board is given a gate in front of the pool: it resumes only when
      // no reason is left, and while the phone saves data it is handed no prints to play.
      const pool = V.createVideoPool({ container: host });
      const saving = () => !!(navigator.connection && navigator.connection.saveData);
      const mayPlay = () => !dead && !viewing && !saving() && document.visibilityState === "visible";
      let lastList = [];
      const gate = {
        update: (list) => { lastList = list; pool.update(saving() ? [] : list); },
        pause: () => pool.pause(),
        resume: () => { if (mayPlay()) pool.resume(); },
        release: (node) => pool.release(node),
        destroy: () => pool.destroy(),
      };
      if (saving()) pool.pause();
      // Data saver turned on or off while the board is open: read when it changes, not only now.
      // On, the prints are let go (each back to its poster and its play disc), not frozen mid-frame; off,
      // they're handed back.
      onNet = () => {
        if (saving()) { pool.update([]); pool.pause(); return; }
        pool.update(lastList);
        if (mayPlay()) pool.resume();
      };
      navigator.connection?.addEventListener?.("change", onNet);
      board = C.mount(host, build(L, rows), {
        onCamera: () => placeEmpty(host.closest(".me-stage")),
        onOpen: (item) => {
          // The board speaks LayoutItems; the viewer speaks memories. Translate here so neither
          // has to know about the other, and open ON the tapped photo rather than at item 0.
          const mem = rows.find((m) => m.id === item.memoryId);
          if (!mem) return;
          const i = Math.max(0, (mem.media || []).findIndex((x) => x.id === item.mediaId));
          const originEl = host.querySelector(`.cg-item[data-id="${CSS.escape(item.id)}"]`);
          // Nothing on the board decodes under the open memory, whose own video may be playing,
          // including after the phone is locked and opened again. Marked once the viewer is open:
          // opening it closes any other, whose onClose clears the mark.
          openViewer(mem, i, { originEl, onClose: () => { viewing = false; gate.resume(); } });
          if (viewer) { viewing = true; pool.pause(); }
        },
        isOnline: () => store.online(),
        video: gate,
        // The floating + (a phone's; from 768 the add is named in the head) sits over the board's foot, and Save or
        // share with the look's button over its head at the right: the board opens fitted between them.
        // In layout terms, as collage.js measures the board (offsetWidth/Height): where the + and the look's button REST,
        // not where an entrance or the bar's slide has them this frame (the view scales in, .98 to 1; the + rides the bar
        // on `translate`). A band read mid-move was off by its travel, and a first open under motion fitted ~2% big.
        fitInset: () => {
          const shown = (n) => n && n.getClientRects().length && getComputedStyle(n).display !== "none";
          const out = { top: 0, topLeft: 0, bottom: 0 };
          const hb = layoutBox(host);
          const f = document.querySelector(".me-fab");
          if (shown(f)) out.bottom = Math.max(0, hb.top + host.offsetHeight - layoutBox(f).top + 8);
          const heads = [...host.querySelectorAll(":scope > .cg-look")].filter(shown).map((n) => layoutBox(n));
          if (heads.length) {
            out.top = Math.max(0, Math.max(...heads.map((q) => q.top + q.height)) - hb.top + 8);
            out.topLeft = Math.min(...heads.map((q) => q.left)) - hb.left - 8;
          }
          return out;
        },
      });
      board.rebuild = (list) => board.setLayout(build(L, list));
    })
    .catch((e) => { if (!dead) console.error("collage: failed to load", e); });

  return {
    update(next) {
      rows = next;
      if (board && board.rebuild) board.rebuild(next);
    },
    resize: onResize,
    unmount() {
      dead = true;
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      // Hand the stage back to the next view as ordinary flow content. The bleed goes with the
      // height: leaving the negative margins behind would drag the list view's stamps out
      // through #view's gutter, which is a rounded page column and means to stay one.
      lookBtn.remove();
      shareBtn.remove();
      host.style.height = "";
      host.style.margin = "";
      lastBox = "";
      if (onNet) navigator.connection?.removeEventListener?.("change", onNet);
      if (board) { try { board(); } catch { /* already torn down */ } board = null; }
    },
  };
}

// The collage board's appearance sheet rides in from HERE, not from index.html: nothing in collage.js quotes this path
// (it injects only its own STRUCTURAL stylesheet), so the service worker's crawler, which walks quoted asset paths
// inside cached JavaScript, could never find it. This literal is what puts it in the offline shell. Order matters too: collage.js PREPENDS
// its structural sheet to <head>, so a link appended here always sits after it and wins on
// document order, which is exactly what both files assume.
const COLLAGE_CSS = "/css/collage.css";
for (const href of [COLLAGE_CSS]) {
  if (document.head.querySelector(`link[href="${href}"]`)) continue;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
}

// ── small shared helpers ──────────────────────────────────────────────────────────────────
function initialsFrom(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
// Author skin for one memory. The ROW is the first source — it is denormalised by the API
// for exactly the reason notes are: offline, the roster may not know a departed member.
// store.members() is the fallback for rows cached before the field existed.
// Author mark on the design system: initials filled in their personal colour (or neutral gray), or their drawn picture (js/pictures.js).
function authorSkin(m) {
  let name = m.user_name || "";
  let initials = m.initials || "";
  let pic = m.author_avatar || m.avatar || "";
  let color = m.note_color || "";
  const me = store.me();
  const isMe = !!(me && me.id && m.created_by === me.id);
  const mem = (store.members() || []).find((x) => x && x.id === m.created_by);
  if (mem) {
    name = mem.name || name;
    initials = mem.initials || initials;
    if ("avatar" in mem) pic = mem.avatar || "";
    color = mem.note_color || color;
  }
  if (isMe && me) {
    const myColor = typeof store.myNoteColor === "function" ? store.myNoteColor() : "";
    if (me.name) name = me.name;
    if (me.initials) initials = me.initials;
    if ("avatar" in me) pic = me.avatar || "";
    if (myColor || me.note_color) color = myColor || me.note_color;
  }
  if (!initials) initials = initialsFrom(name);
  return {
    name,
    initials,
    pic,
    color,
    isMe,
  };
}
function memberFaceSig() {
  const me = store.me();
  const myColor = typeof store.myNoteColor === "function" ? store.myNoteColor() : "";
  const ms = (store.members() || [])
    .filter((m) => m && m.id)
    .map((m) => [m.id, m.name || "", m.initials || "", m.note_color || "", m.avatar || ""].join("|"))
    .sort();
  const mePart = me
    ? [me.id || "", me.name || "", me.initials || "", myColor || me.note_color || "", me.avatar || ""].join("|")
    : "";
  return `${mePart}::${ms.join(";")}`;
}
function faceMarkup(skin, extraClass = "") {
  const drawing = skin.pic ? pictureNow(skin.pic) : null;
  return faceHtml({
    name: skin.name || "Trip member",
    initials: skin.initials,
    drawing,
    picture: drawing ? null : skin.pic,
    size: 32,
    me: skin.isMe,
    color: skin.color,
    className: extraClass ? `me-ava ${extraClass}` : "me-ava",
  });
}
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / (1024 * 1024);
  if (mb < 1024) return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
function fmtDur(s) {
  const t = Math.round(Number(s) || 0);
  if (t <= 0) return "";
  const m = Math.floor(t / 60), r = t % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
// Client copy of the API's normTag() — same collapse, so a chip previews exactly the tag
// the server will store.
const normTag = (t) => String(t || "").toLowerCase()
  .replace(/[^\p{L}\p{N} -]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 32);
const tripTz = () => (store.trip() && store.trip().default_tz) || "UTC";

// ── when a memory happened (migration 0029; docs/API.md "When a memory happened") ─────────────
// A memory carries the trip-zone `day` it happened (read from its photographs, or chosen) and
// `taken_at`, the earliest moment its photographs were taken where a file says so; `at` is the
// server's order (taken_at, else the end of its day, else when it was posted), which the feed
// pages by and this phone orders by, so a page never disagrees with the list. A memory from
// before 0029, or posted with neither, happened when it was posted.
const atMs = (m) => toMs(m.at ?? m.created_at) || 0;
/** The times the server keeps for a photograph (src/api/memories.js readTaken): from 1990 to two days ahead. */
const TAKEN_FROM = Date.UTC(1990, 0, 1) / 1000;
const TAKEN_AHEAD = 2 * 86400;
/** The trip-zone day a memory happened: its own, else its photographs', else the day it was posted. */
const happenedDay = (m) => m.day || dayKey(m.taken_at ?? m.created_at, tripTz());
/** "Sat May 3" for a "YYYY-MM-DD" (a calendar day: read at its noon in UTC, so no zone moves it). */
const dayLabel = (k) => fmtDay(Date.parse(`${k}T12:00:00Z`), "UTC");
/**
 * When a memory happened, as its card and the viewer say it: the time its photographs were taken (none for a day
 * chosen by hand: no time is invented; when it was posted for a memory that says nothing else), and "posted <day>"
 * when it was posted on another day. The feed says the day in its heading; the viewer has none, so it leads with it
 * (`withDay`): "Mon May 4 · 10:00 · posted Fri Nov 27".
 */
function whenSaid(m, { withDay = false } = {}) {
  const day = happenedDay(m), posted = dayKey(m.created_at, tripTz());
  const time = m.taken_at != null ? fmtTime(m.taken_at, tripTz()) : (m.day ? "" : fmtTime(m.created_at, tripTz()));
  return [withDay ? dayLabel(day) : "", time, day !== posted ? `posted ${dayLabel(posted)}` : ""].filter(Boolean).join(" · ");
}
/**
 * The days a memory can be put on: the trip's, and any other it already names (a day before or
 * after it), up to two days from now in the trip's zone, as the server keeps them (a trip still to
 * come offers none of its days: a memory can't have happened yet).
 */
function dayChoices(extra = []) {
  const t = store.trip() || {};
  const out = [];
  if (t.starts_on && t.ends_on && t.starts_on <= t.ends_on) {
    for (let d = new Date(`${t.starts_on}T12:00:00Z`), i = 0; i < 400 && d.toISOString().slice(0, 10) <= t.ends_on; d.setUTCDate(d.getUTCDate() + 1), i++) {
      out.push(d.toISOString().slice(0, 10));
    }
  }
  for (const k of extra) if (k && !out.includes(k)) out.push(k);
  const last = dayKey(Date.now() + TAKEN_AHEAD * 1000, tripTz());
  return out.filter((k) => k <= last).sort();
}
/** The options of a day picker: "When it's posted" (none), then the days, the one given chosen. */
function dayOptions(chosen, extra = []) {
  return `<option value="">The day it's posted</option>` +
    dayChoices([chosen, ...extra]).map((k) => `<option value="${esc(k)}"${k === chosen ? " selected" : ""}>${esc(dayLabel(k))}</option>`).join("");
}
// The API address of something this trip holds: T("/memories") is /api/trips/<id>/memories.
const T = (rest) => store.tripApi(rest);
const keyOf = (m) => m.key || m.r2_key || "";
const thumbUrlOf = (m) => m.thumb_url || (m.thumb_key ? mediaUrl(m.thumb_key) : "");
const sortedMedia = (mem) => [...(mem.media || [])].sort((a, b) => (a.sort || 0) - (b.sort || 0) ||
  String(a.id).localeCompare(String(b.id)));

// ── HTTP (same envelope discipline as store.js req(): never throw on status) ──────────────
// The sentence the server wrote for a refusal a person can act on, or "" when it wrote none.
// Today that is the host's storage being full (413 "storage full"): its `reason` says whose
// room it is, how much is left, what this needed and who can free it, and it differs for the
// host and for everyone else, so it is shown as it came and never rebuilt here.
// ── a shared board's prints, as the server keeps them ───────────────────────────────────────
// The server keeps a shared board's originals only in the types it can clean: JPEG, PNG, WebP,
// MP4 and MOV (415 for anything else). Kept as they are.
const KEPT_AS_IS = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"]);
// The most pixels a canvas may hold in Safari: a bigger drawing comes back empty.
const CANVAS_MOST = 16_777_216;

/**
 * A photo drawn and kept as a JPEG: { blob, w, h, drawn: true }, or null when this browser can't
 * read it (Chrome has no HEIC). Scaled down to what a canvas may hold. A drawing carries no camera
 * data, so nothing about where it was taken goes with it.
 */
async function drawnJpeg(blob) {
  let pic = null, w = 0, h = 0, url = "";
  try { pic = await createImageBitmap(blob); w = pic.width; h = pic.height; } catch { pic = null; }
  if (!pic) {
    // Safari reads HEIC in an <img> where createImageBitmap may not.
    try {
      url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      await img.decode();
      pic = img; w = img.naturalWidth; h = img.naturalHeight;
    } catch { pic = null; }
  }
  try {
    if (!pic || !w || !h) return null;
    const k = Math.min(1, Math.sqrt(CANVAS_MOST / (w * h)));
    const cw = Math.max(1, Math.floor(w * k)), ch = Math.max(1, Math.floor(h * k));
    const canvas = document.createElement("canvas");
    canvas.width = cw; canvas.height = ch;
    canvas.getContext("2d").drawImage(pic, 0, 0, cw, ch);
    const out = await new Promise((done) => canvas.toBlob(done, "image/jpeg", 0.92));
    canvas.width = canvas.height = 0;            // its memory back at once (Safari counts it)
    return out ? { blob: out, w: cw, h: ch, drawn: true } : null;
  } finally {
    if (pic && pic.close) pic.close();
    if (url) URL.revokeObjectURL(url);
  }
}

/**
 * What a print sends as its original: { blob, kind, w, h, drawn? }, or null when nothing this
 * browser can make will be kept. A type the server keeps goes as it is (an empty type too: the
 * server reads the file, and a 415 then brings it here again as a drawing). A video it can't take
 * goes as its poster, a photo, so the print still opens; a photo of another type, drawn.
 */
async function sendable(it, blob) {
  const type = String(blob.type || "").split(";")[0].trim().toLowerCase();
  const kind = it.kind || "photo";
  if (!type || KEPT_AS_IS.has(type)) return { blob, kind, w: it.srcW || 0, h: it.srcH || 0 };
  if (kind === "video" || type.startsWith("video/")) {
    if (!it.thumbUrl) return null;
    try {
      const g = await fetch(it.thumbUrl, { credentials: "same-origin" });
      if (!g.ok) return null;
      const poster = await g.blob();
      const ptype = String(poster.type || "").split(";")[0].trim().toLowerCase();
      if (!ptype || KEPT_AS_IS.has(ptype)) return { blob: poster, kind: "photo", w: 0, h: 0 };
      const drawn = await drawnJpeg(poster);
      return drawn ? { ...drawn, kind: "photo" } : null;
    } catch { return null; }
  }
  const drawn = await drawnJpeg(blob);
  return drawn ? { ...drawn, kind: "photo" } : null;
}

function refusalSentence(status, body) {
  if (status !== 413 || !body || body.error !== "storage full") return "";
  return typeof body.reason === "string" ? body.reason.trim() : "";
}
// What a card says for any other refusal: the server's own sentence when it wrote one, else plain
// words for what failed and what to do. Never a bare status number.
function refusalWords(res) {
  const said = res && res.body && typeof res.body.reason === "string" ? res.body.reason.trim() : "";
  if (said) return said;
  if (res && res.status === 413) return "The server couldn't take this post: it was too big. Discard it and add the photos again in smaller groups.";
  if (res && res.status === 415) return "One of these files is of a kind the server doesn't keep. Discard this post and add the others again.";
  if (res && res.status === 403) return "The server didn't let this phone post here. Check you're still on this trip, then Retry.";
  return "The server didn't take this post. Retry, or Discard it.";
}

// The trip's host may delete anyone's memory on it: the bytes count against the host, whoever
// uploaded them. The server decides; this only decides whether the button is offered.
function isHost() {
  const t = store.trip(), me = store.me();
  return !!(t && t.host_id && me && me.id && t.host_id === me.id);
}

async function api(method, path, body) {
  if (store.phoneCleared()) return { ok: false, status: 401, body: null };
  const init = { method, credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  // Given up at net.js's limit, as store.js's requests are: no answer, so nothing is known to
  // have been refused, and the caller sends it again.
  return within(method, async (signal) => {
    let res;
    try { res = await fetch(path, { ...init, signal }); }
    catch { return { ok: false, status: 0, body: null, offline: true }; }
    if (res.status === 401) { location.replace(store.signInAddress()); return { ok: false, status: 401, body: null }; }
    // Captive-portal guard, store.js's copy: a 200 text/html is not the API answering.
    const ct = res.headers.get("Content-Type") || "";
    const empty = res.status === 204 || res.headers.get("Content-Length") === "0";
    if (!ct.includes("json") && !empty) return { ok: false, status: 0, body: null, offline: true };
    let parsed = null;
    try { parsed = await res.json(); } catch { if (signal.aborted) return { ok: false, status: 0, body: null, offline: true }; }
    return { ok: res.ok, status: res.status, body: parsed };
  });
}

// ── the data seam (memories metadata cache; see the header for why it exists) ─────────────
// One database per trip, like the store's. MDB_BASE alone is the one database a phone had
// before a trip had an address: its rows move into its trip's the first time the feed opens
// there (trip-adopt.js), so the feed still shows with no signal after the app updates.
const MDB_BASE = "wegoplace-memories";
let mdbp = null;
function openMdb() {
  if (mdbp) return mdbp;
  mdbp = new Promise((resolve) => {
    const req = indexedDB.open(dbName(MDB_BASE, store.tripId()), 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("memories")) db.createObjectStore("memories", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);      // private mode: memory-only, never a white screen
  }).then(async (db) => {
    if (db && !store.phoneCleared()) {
      try { await adoptOldRows(db, MDB_BASE, "memories", store.tripId()); }
      catch (e) { console.warn("[memories] could not move the stored feed", e); }
    }
    return db;
  });
  return mdbp;
}
async function mtx(mode, fn) {
  // A phone that was cleared (somebody signed out) is never written back to: store.js.
  if (mode === "readwrite" && store.phoneCleared()) return null;
  const db = await openMdb();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const t = db.transaction(["memories"], mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    out = fn(t.objectStore("memories"));
  }).catch(() => null);
}

const rows = new Map();                 // id -> memory row (frozen)
let hydrated = false;
let lastSig = "";
let serverTags = null;                  // [{tag,count}] from the last GET, or null offline
let hasMore = false;                    // server pagination state for the newest-first walk
let nextBefore = null, nextBeforeId = null;
const bus = new Set();                  // re-render listeners (the mounted view)
function emitLocal() { for (const fn of bus) { try { fn(); } catch (e) { console.error("[memories]", e); } } }

function sig() {
  const ids = [...rows.keys()].sort();
  let acc = "";
  for (const id of ids) acc += JSON.stringify(rows.get(id));
  return `${ids.length}:${acc.length}:${acc.slice(0, 64)}${acc.slice(-64)}`;
}
function commitRows(list, { replace = false } = {}) {
  if (replace) rows.clear();
  for (const r of list) rows.set(r.id, Object.freeze(r));
  const s = sig();
  if (s === lastSig) return false;
  lastSig = s;
  mtx("readwrite", (os) => { if (replace) os.clear(); for (const r of list) os.put(r); });
  // Teach sw.js the byte lengths and thumb pairings for everything we now know about —
  // that is what lets it verify cached copies and file thumbs under the thumbs budget.
  registerMedia(list);
  return true;
}
function registerMedia(list) {
  const items = [];
  for (const m of list) for (const x of m.media || []) items.push(x);
  if (items.length) mediaCache.register(items).catch(() => {});
}

// A memory somebody ELSE deleted has to leave this device too. Nothing pushes that news — the
// only signal is its absence from a feed page — and without this a card whose R2 objects are
// gone sits in the shared album forever, 404-ing the moment anyone taps it. There are no
// tombstones to consult, so the page IS the statement: the server just described the newest
// `limit` memories in full, and any cached row that sorts inside that window and is not in the
// answer no longer exists. Rows OLDER than the window were not described by this request and
// are left alone; when has_more is false the page is the whole feed and the window is
// everything. `known` is the id set from before the request went out, so a card posted while
// it was in flight is never pruned by an answer that predates it.
function pruneMissing(list, { complete, known }) {
  const keep = new Set(list.map((r) => r.id));
  let floorT = Infinity, floorId = "";                 // the oldest row the page described
  for (const r of list) {
    const t = atMs(r);                                 // the server pages by when it happened
    if (t < floorT || (t === floorT && r.id < floorId)) { floorT = t; floorId = r.id; }
  }
  let dropped = false;
  for (const [id, r] of [...rows]) {
    if (keep.has(id) || !known.has(id)) continue;
    if (!complete) {
      if (floorT === Infinity) continue;               // an empty page describes no window
      const t = atMs(r);
      if (t < floorT || (t === floorT && id < floorId)) continue;   // older than the window
    }
    rows.delete(id);
    mtx("readwrite", (os) => os.delete(id));
    if ((r.media || []).length) mediaCache.forget(r.media).catch(() => {});
    dropped = true;
  }
  return dropped;
}

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  const got = await mtx("readonly", (os) => {
    const out = [];
    os.getAll().onsuccess = (e) => out.push(...(e.target.result || []));
    return out;
  });
  if (got) for (const r of got) rows.set(r.id, Object.freeze(r));
  lastSig = sig();
}

let refreshing = null;
function refreshFeed() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    if (!store.online()) return false;
    const known = new Set(rows.keys());
    const res = await api("GET", T(`/memories?limit=${FETCH_LIMIT}`));
    if (!res.ok || !res.body || !Array.isArray(res.body.memories)) return false;
    serverTags = Array.isArray(res.body.tags) ? res.body.tags : serverTags;
    hasMore = !!res.body.has_more;
    nextBefore = res.body.next_before ?? null;
    nextBeforeId = res.body.next_before_id ?? null;
    // First page replaces nothing: older pages already cached stay, newer truth wins by id.
    // It does PRUNE, though — see pruneMissing(); a deleted card must not outlive its files.
    const gone = pruneMissing(res.body.memories, { complete: !hasMore, known });
    if (commitRows(res.body.memories) || gone) { lastSig = sig(); emitLocal(); }
    return true;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

let paging = false;
async function fetchOlder() {
  if (paging || !hasMore || nextBefore == null || !store.online()) return false;
  paging = true;
  try {
    const q = `limit=${FETCH_LIMIT}&before=${encodeURIComponent(nextBefore)}` +
      (nextBeforeId ? `&before_id=${encodeURIComponent(nextBeforeId)}` : "");
    const res = await api("GET", T(`/memories?${q}`));
    if (!res.ok || !res.body || !Array.isArray(res.body.memories)) return false;
    hasMore = !!res.body.has_more;
    nextBefore = res.body.next_before ?? null;
    nextBeforeId = res.body.next_before_id ?? null;
    if (commitRows(res.body.memories)) emitLocal();
    return true;
  } finally { paging = false; }
}

function memories() {
  // Newest first by when it happened, as the server pages (a tie by id, as its index does).
  return [...rows.values()].sort((a, b) => atMs(b) - atMs(a) || (a.id < b.id ? 1 : -1));
}
// The filter bar's vocabulary: the server's whole-trip tag list when we have heard one, the
// cached rows' own tags otherwise — offline the two are the same thing anyway.
function allTags() {
  if (serverTags) return serverTags.map((t) => t.tag);
  const count = new Map();
  for (const m of rows.values()) for (const t of m.tags || []) count.set(t, (count.get(t) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map((e) => e[0]);
}

// ── upload manager (module scope: survives unmount; memory-only: requires signal) ─────────
const jobs = [];                        // active/failed upload jobs, oldest first
let jobSeq = 0;
let pumping = false;

/** Photos and videos, counted in words: "34 photos", "1 video", "32 photos and 2 videos". */
function mediaWords(photos, videos) {
  const say = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return [photos ? say(photos, "photo") : "", videos ? say(videos, "video") : ""].filter(Boolean).join(" and ");
}
/** What a list holds, in words (mediaWords), each told a video by `isVideo`. */
const wordsFor = (list, isVideo) => { const v = list.filter(isVideo).length; return mediaWords(list.length - v, v); };
/** What a job holds, in words: one file by its name; else wordsFor. */
function jobWhat(items) {
  return items.length === 1 ? items[0].name : wordsFor(items, (i) => i.kind === "video");
}

function jobTotals(job) {
  let sent = 0, total = 0;
  for (const it of job.items) { sent += Math.min(it.sent, it.bytes); total += it.bytes; }
  return { sent, total };
}

// One part over XHR (net.js sendBytes) rather than fetch: fetch has no upload progress, and an
// 8MB part on hostel wifi is exactly the stretch where a frozen bar reads as a hang. A part with
// no bytes moving for 30 s is given up, and sent again like any part that got no answer.
const sendPart = (url, blob, onProgress, stallMs) => sendBytes(url, blob, { onProgress, stallMs });
// A part given up for nothing moving while the phone has signal is a slow line or a slow server, not a lost signal
// (27 Nov: a part whose answer took 40 s was given up at 30 s every time, the job "Waiting for signal" with signal,
// for good). So the same part goes again at once, with twice the patience, up to PART_STALL_MAX_MS, and the job keeps
// that patience for its later parts.
const PART_STALL_MAX_MS = 8 * 60 * 1000;

// The other uploads (a board's share and its prints and loop, a memory's thumb), on the same rule,
// answered the way fetch() answers so their callers read it as before. No answer at all (the
// line failed, or nothing moved for 30 s) rejects, as a fetch() with no signal does.
async function postBytes(url, body, type = "application/octet-stream") {
  const r = await sendBytes(url, body, { type });
  if (r.status === 0) throw new Error("no answer");
  return { ok: r.ok, status: r.status, json: async () => r.body };
}

const waiters = new Set();
function waitForSignal() {
  return new Promise((resolve) => { waiters.add(resolve); setTimeout(tryWake, 15_000); });
}
function tryWake() {
  if (!waiters.size) return;
  if (navigator.onLine === false) { setTimeout(tryWake, 15_000); return; }
  for (const w of [...waiters]) { waiters.delete(w); w(); }
}
addEventListener("online", tryWake);
addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tryWake(); });

async function makeThumb(file, kind) {
  try {
    if (kind === "photo") return await photoThumb(file);
    return await videoThumb(file);
  } catch (e) {
    console.warn("[memories] thumb failed (upload continues)", file.name, e);
    return { blob: null, w: 0, h: 0, duration: 0 };
  }
}
function drawScaled(source, w, h) {
  const scale = Math.min(1, THUMB_PX / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  c.getContext("2d").drawImage(source, 0, 0, cw, ch);
  return new Promise((res) => c.toBlob((b) => res(b), "image/webp", THUMB_Q));
}
async function photoThumb(file) {
  let bmp = null;
  try { bmp = await createImageBitmap(file); } catch { /* HEIC on non-Safari, corrupt file */ }
  if (bmp) {
    const out = { blob: await drawScaled(bmp, bmp.width, bmp.height), w: bmp.width, h: bmp.height, duration: 0 };
    bmp.close && bmp.close();
    return out;
  }
  // Fallback decoder: <img> can decode formats createImageBitmap refuses on some engines.
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { blob: await drawScaled(img, img.naturalWidth, img.naturalHeight), w: img.naturalWidth, h: img.naturalHeight, duration: 0 };
  } finally { URL.revokeObjectURL(url); }
}
function videoThumb(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    let done = false;
    const finish = async (ok) => {
      if (done) return;
      done = true;
      const w = v.videoWidth || 0, h = v.videoHeight || 0, duration = v.duration || 0;
      let blob = null;
      if (ok && w && h) { try { blob = await drawScaled(v, w, h); } catch { /* GPU refusal */ } }
      URL.revokeObjectURL(url);
      v.removeAttribute("src"); v.load();
      resolve({ blob, w, h, duration: Number.isFinite(duration) ? duration : 0 });
    };
    v.onloadedmetadata = () => {
      // A poster frame from t=0 is often black; a fraction of a second in is a picture.
      try { v.currentTime = Math.min(0.4, (v.duration || 1) / 2); } catch { finish(false); }
    };
    v.onseeked = () => finish(true);
    v.onerror = () => finish(false);
    setTimeout(() => finish(false), 10_000);   // metadata that never loads must not wedge a job
    v.src = url;
  });
}

/**
 * A pick split into consecutive parts of at most `max`, as even as they can be, in the order
 * picked: 94 is 32, 31, 31; 41 is 21, 20; 40 or fewer is one part.
 */
export function partsOf(list, max = MEMORY_MEDIA_MAX) {
  const all = [...list];
  const n = Math.max(1, Math.ceil(all.length / max));
  const small = Math.floor(all.length / n), big = all.length % n;
  const out = [];
  for (let i = 0, at = 0; i < n; i++) {
    const size = small + (i < big ? 1 : 0);
    out.push(all.slice(at, at + size));
    at += size;
  }
  return out;
}

function startUpload(files, caption, tags, when = {}, part = null) {
  const job = {
    id: `job-${++jobSeq}-${uid()}`,
    // One of several posts a pick over MEMORY_MEDIA_MAX became: { n, of }, which the card says.
    part: part && part.of > 1 ? part : null,
    memId: uid("mem"),                  // client id, so a retried POST upserts (API contract)
    caption: String(caption || "").trim(),
    tags: [...new Set(tags.map(normTag).filter(Boolean))],
    // When it happened: the trip-zone day and the photographs' earliest time (none for a day
    // chosen by hand); neither = when it is posted.
    day: when.day || null,
    takenAt: when.taken_at ?? null,
    state: "queued",                    // queued | uploading | waiting | posting | failed
    error: "",
    items: [...files].map((f) => ({
      file: f,
      name: f.name || "media",
      mime: f.type || "application/octet-stream",
      bytes: f.size,
      kind: (f.type || "").startsWith("video/") ? "video" : "photo",
      sent: 0,
      key: null, uploadId: null, partSize: PART_BYTES, parts: [], nextPart: 1,
      finished: false, thumbPrepared: false, thumb: null, thumbKey: "",
      w: 0, h: 0, duration: 0,
      done: false,
    })),
  };
  jobs.push(job);
  emitLocal();
  pump();
  return job;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    let job;
    while ((job = jobs.find((j) => j.state !== "failed"))) {
      // A job that parks itself as failed leaves the find()'s view, so the loop simply moves
      // on to the next queued job rather than letting one rejection dam the whole queue.
      await runJob(job);
    }
  } finally {
    pumping = false;
  }
}

// Runs one job to completion. Returns true when the job LEFT the list (posted or was
// discarded); false when it parked itself as failed. Transient network trouble never fails
// a job — it waits, labelled, and resumes from the next unsent part.
async function runJob(job) {
  for (;;) {
    if (!jobs.includes(job)) return true;             // discarded from the UI mid-flight
    job.state = "uploading"; job.error = ""; job.why = "";
    emitLocal();
    try {
      for (const it of job.items) {
        if (it.done) continue;
        if (!it.thumbPrepared) {
          const t = await makeThumb(it.file, it.kind);
          it.thumb = t.blob; it.w = t.w; it.h = t.h; it.duration = t.duration;
          it.thumbPrepared = true;
        }
        if (!it.key) {
          // The upload's own id, made once and kept, also when an expired upload begins again: a
          // begin whose answer was lost and is sent again is handed the same upload, its bytes
          // held once (docs/API.md, Idempotency), not a second one.
          it.beginId ||= uid("up");
          const b = await api("POST", T("/media/begin"),
            { name: it.name, mime: it.mime, bytes: it.bytes, kind: it.kind, id: it.beginId });
          if (!b.ok) { if (hardFail(job, b)) return false; await park(job); break; }
          it.key = b.body.key;
          it.uploadId = b.body.uploadId;
          keepOpen(job);
          if (Number(b.body.part_size) > 0) it.partSize = Number(b.body.part_size);
        }
        const total = Math.max(1, Math.ceil(it.bytes / it.partSize));
        while (it.nextPart <= total) {
          const n = it.nextPart;
          const from = (n - 1) * it.partSize;
          const blob = it.file.slice(from, Math.min(it.bytes, from + it.partSize));
          const url = T(`/media/part?key=${encodeURIComponent(it.key)}&id=${encodeURIComponent(it.uploadId)}&n=${n}`);
          const res = await sendPart(url, blob, (loaded) => {
            it.sent = from + Math.min(loaded, blob.size);
            throttleEmit();
          }, job.stallMs || STALL_MS);
          if (!res.ok) {
            if (beginAgain(it, res)) break;
            if (res.stalled && navigator.onLine !== false && jobs.includes(job)) {
              job.stallMs = Math.min(PART_STALL_MAX_MS, (job.stallMs || STALL_MS) * 2);
              it.sent = from;
              emitLocal();
              await new Promise((r) => setTimeout(r, 500));
              continue;                                 // the same part, n unchanged
            }
            if (hardFail(job, res)) return false; await park(job); break;
          }
          it.parts.push({ n, etag: res.body && res.body.etag });
          it.nextPart = n + 1;
          it.sent = Math.min(it.bytes, n * it.partSize);
          emitLocal();
        }
        if (it.nextPart <= total) break;              // parked mid-item; outer loop resumes
        if (!it.finished) {
          const f = await api("POST", T("/media/finish"), { key: it.key, id: it.uploadId, parts: it.parts });
          if (!f.ok) {
            if (beginAgain(it, f)) break;
            if (hardFail(job, f)) return false; await park(job); break;
          }
          it.finished = true;
        }
        if (it.thumb && !it.thumbKey) {
          // Additive: a thumb that will not land costs a placeholder tile, not the memory.
          try {
            const res = await postBytes(T(`/media/thumb?for=${encodeURIComponent(it.key)}&mime=image/webp`), it.thumb, "image/webp");
            if (res.ok) { const b = await res.json().catch(() => null); it.thumbKey = (b && b.key) || ""; keepOpen(job); }
          } catch { /* keep going */ }
        }
        it.done = true;
        it.thumb = null;                              // release the poster blob
        emitLocal();
      }
      if (!job.items.every((i) => i.done)) continue;  // parked; the wait already happened

      job.state = "posting";
      emitLocal();
      const res = await api("POST", T("/memories"), {
        id: job.memId,
        caption: job.caption,
        tags: job.tags,
        ...(job.day ? { day: job.day } : {}),
        ...(job.takenAt != null ? { taken_at: job.takenAt } : {}),
        media: job.items.map((i) => ({
          key: i.key, thumb_key: i.thumbKey, kind: i.kind,
          w: i.w, h: i.h, duration: i.duration,
        })),
      });
      if (!res.ok) { if (hardFail(job, res)) return false; await park(job); continue; }
      const row = res.body && (res.body.memory || res.body);
      jobs.splice(jobs.indexOf(job), 1);
      closeOpen(job);
      if (row && row.id) commitRows([row]);
      // Posted, but the server couldn't keep when it happened (this phone's own clock far off, so
      // a time it took for the past is the server's future): it is on the day it was posted, and
      // the person is told, not left to find it.
      const notTaken = Array.isArray(res.body && res.body.not_taken) ? res.body.not_taken.map((x) => x && x.field) : [];
      if (notTaken.includes("day")) toast("Posted, on the day it was posted: the day in the photos couldn't be kept.");
      else if (notTaken.includes("taken_at")) toast(row && row.day ? `Posted under ${dayLabel(row.day)}, without the photos' time: it couldn't be kept.` : "Posted, without the photos' time: it couldn't be kept.");
      emitLocal();
      refreshFeed();
      return true;
    } catch (e) {
      console.error("[memories] upload", e);
      job.state = "failed";
      job.error = "Upload failed";
      job.full = false;
      job.why = "Something went wrong on this phone while sending it. Retry, or Discard it.";
      emitLocal();
      return false;
    }
  }
}
function hardFail(job, res) {
  // A definite server "no" (4xx) parks the job as failed with a retry; anything network-
  // shaped is transient and waits for signal instead.
  if (res.status && res.status !== 0 && res.status !== 408 && res.status !== 429 && res.status < 500) {
    job.state = "failed";
    // A full trip is said as "No room", with the server's words for whose room it is; any other
    // refusal in the server's words when it wrote some, else in plain ones (refusalWords): the
    // card never shows a bare number.
    const full = refusalSentence(res.status, res.body);
    job.full = !!full;
    job.why = full || refusalWords(res);
    job.error = full ? "No room" : "Not posted";
    emitLocal();
    return true;
  }
  return false;
}
// An upload holds its declared bytes for a day. One that sat longer (a phone that was off, a
// job waiting for signal over a weekend) is answered 409 "upload expired" by `part` and
// `finish`: the server has dropped what it had. Nothing is wrong with the file, so the item
// starts over from `begin` by itself. Twice at most: a third expiry in one run is not a day
// passing, and the job fails where the person can see it.
function beginAgain(it, res) {
  if (res.status !== 409 || !res.body || res.body.error !== "upload expired") return false;
  it.restarts = (it.restarts || 0) + 1;
  if (it.restarts > 2) return false;
  it.key = null; it.uploadId = null; it.parts = []; it.nextPart = 1; it.sent = 0; it.finished = false;
  return true;
}
async function park(job) {
  job.state = "waiting";
  emitLocal();
  await waitForSignal();
}
function retryJob(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  job.state = "queued"; job.error = ""; job.why = ""; job.full = false;
  emitLocal();
  pump();
}
// Discard takes the job off the list AND its files off the server: every file of it that was begun
// (stored, or an upload still holding its bytes) and its thumbnail, none of them in a memory (a
// discarded job was never posted; the server refuses to remove an attached file all the same,
// DELETE media/object). Without signal the addresses wait on this phone (localStorage) and go
// when it is back, also after the app was closed: nothing is left holding the host's storage.
function discardJob(id) {
  const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) return;
  const [job] = jobs.splice(i, 1);
  const urls = jobUrls(job);
  if (urls.length) { keepDrops([...new Set([...drops(), ...urls])]); dropUnposted(); }
  closeOpen(job);
  emitLocal();
}
const jobUrls = (job) => job.items.flatMap((it) => [it.key, it.thumbKey]).filter(Boolean)
  .map((k) => T(`/media/object?key=${encodeURIComponent(k)}`));

// A JOB'S FILES, KEPT ON THE PHONE WHILE IT RUNS. The jobs live in this page alone (the header says why), and a phone
// puts a Home Screen app away and starts it again later without a word: a job that had begun its files then leaves
// them on the server, in no memory, holding the host's storage for good. So each job's begun files are written down
// here as they begin (wgp.memopen: { job: { page, at, urls } }) and struck off when it posts or is discarded; a
// Memories opened later hands the files of a job no running page holds to the same removal as Discard. Which pages
// are running: each holds a Web Lock named for itself while it lives (adoptOrphans); a browser without Web Locks waits
// until a job has been quiet for OPEN_QUIET_MS.
const OPEN_KEY = "wgp.memopen";
const OPEN_QUIET_MS = 30 * 60 * 1000;
const PAGE_ID = uid("pg");
const LOCK = (page) => `wgp-memories-${page}`;
try { navigator.locks?.request(LOCK(PAGE_ID), () => new Promise(() => {})); } catch { /* no Web Locks: the quiet time decides */ }
function opens() {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function keepOpens(v) {
  try { if (Object.keys(v).length) localStorage.setItem(OPEN_KEY, JSON.stringify(v)); else localStorage.removeItem(OPEN_KEY); }
  catch { /* private mode: nothing kept, as before */ }
}
function keepOpen(job) {
  const v = opens();
  v[job.id] = { page: PAGE_ID, at: Date.now(), urls: jobUrls(job) };
  keepOpens(v);
}
function closeOpen(job) {
  const v = opens();
  if (v[job.id]) { delete v[job.id]; keepOpens(v); }
}
// Another page's jobs are taken over once that page is gone: its lock is asked for, and the browser grants it the
// moment that page no longer holds it (at once when it was closed long ago; never while it runs, frozen or not).
const waitingFor = new Set();
function adoptOrphans() {
  const pages = new Set(Object.values(opens()).map((o) => o && o.page).filter((pg) => typeof pg === "string" && pg !== PAGE_ID));
  for (const pg of pages) {
    if (waitingFor.has(pg)) continue;
    if (navigator.locks) {
      waitingFor.add(pg);
      navigator.locks.request(LOCK(pg), async () => { adopt((o) => o.page === pg); }).catch(() => {}).finally(() => waitingFor.delete(pg));
    } else {
      adopt((o) => o.page === pg && Date.now() - (Number(o.at) || 0) > OPEN_QUIET_MS);
    }
  }
}
function adopt(mine) {
  const v = opens();
  const urls = [];
  for (const [id, o] of Object.entries(v)) {
    if (!o || !mine(o)) continue;
    urls.push(...(Array.isArray(o.urls) ? o.urls.filter((u) => typeof u === "string") : []));
    delete v[id];
  }
  keepOpens(v);
  if (urls.length) { keepDrops([...new Set([...drops(), ...urls])]); dropUnposted(); }
}
const DROP_KEY = "wgp.memdrop";
function drops() {
  try {
    const v = JSON.parse(localStorage.getItem(DROP_KEY) || "[]");
    return Array.isArray(v) ? v.filter((u) => typeof u === "string") : [];
  } catch { return []; }
}
function keepDrops(list) {
  try { if (list.length) localStorage.setItem(DROP_KEY, JSON.stringify(list)); else localStorage.removeItem(DROP_KEY); }
  catch { /* private mode: this run's list is what there is */ }
}
let dropping = null;
function dropUnposted() {
  if (dropping) { dropping.again = true; return; }
  dropping = { again: false };
  (async () => {
    try {
      do {
        dropping.again = false;
        for (const url of drops()) {
          const r = await api("DELETE", url);
          // No answer, or one to send again later: it stays for the next time there is signal.
          if (r.status === 0 || r.status === 408 || r.status === 429 || r.status >= 500) continue;
          // Removed, already gone, or refused for good (somebody's memory holds it): done either way.
          keepDrops(drops().filter((u) => u !== url));
        }
      } while (dropping.again);
    } catch (e) { console.warn("[memories] discard", e); }
    finally { dropping = null; }
  })();
}
addEventListener("online", () => { if (drops().length) dropUnposted(); });

let emitTimer = 0;
function throttleEmit() {
  if (emitTimer) return;
  emitTimer = setTimeout(() => { emitTimer = 0; emitLocal(); }, 200);
}

// ── save wiring ───────────────────────────────────────────────────────────────────────────
// memories-save.js owns everything hard: batching under the byte budget, the gesture rule,
// the length check, the download fallback. What this layer adds is (a) exactly ONE live
// session — prepared batches are original files held in RAM, and two piles of those is how
// Safari kills the page — and (b) a status readout that survives re-renders by finding the
// button through data-save rather than holding a node.
let liveSave = null;                    // { scope, session }

function saveSession(scope, items) {
  if (liveSave && liveSave.scope === scope) return liveSave.session;
  if (liveSave) { try { liveSave.session.abort(); } catch { /* already done */ } }
  const session = createSaveSession(items, { onProgress: (p) => paintSaveState(scope, p) });
  liveSave = { scope, session };
  return session;
}
function dropSaveSession(scope) {
  if (liveSave && (!scope || liveSave.scope === scope)) {
    try { liveSave.session.abort(); } catch { /* fine */ }
    liveSave = null;
  }
  paintSaveState(scope, null);
}
function pillFor(scope) {
  const btn = document.querySelector(`[data-save="${CSS.escape(scope)}"]`);
  if (!btn || !btn.parentElement) return null;
  let pill = btn.parentElement.querySelector(".me-savestate");
  if (!pill) {
    pill = document.createElement("span");
    pill.className = "me-savestate pill num";
    btn.before(pill);
  }
  return pill;
}
// Labels, never sentences: "42%", "Ready", "Batch 2 of 3".
function paintSaveState(scope, p) {
  const btn = document.querySelector(`[data-save="${CSS.escape(scope)}"]`);
  if (!btn) return;
  const pill = pillFor(scope);
  if (!pill) return;
  if (!p || p.phase === "done" || p.phase === "aborted") { pill.remove(); return; }
  if (p.phase === "fetching") {
    pill.textContent = p.total ? `${Math.min(99, Math.floor((p.loaded / p.total) * 100))}%` : "…";
  } else if (p.phase === "ready") {
    pill.textContent = p.batchCount > 1 ? `Ready · ${p.batch} of ${p.batchCount}` : "Ready";
  } else if (p.phase === "next") {
    pill.textContent = `Batch ${p.batch} of ${p.batchCount}`;
  } else if (p.phase === "cancelled") {
    pill.textContent = "Ready";
  } else if (p.phase === "error") {
    pill.textContent = "Failed";
  }
}
// The tap handler. DELIBERATELY not async and nothing awaited before saveNext(): Safari
// spends the user activation on the first await, and share() needs it.
function onSaveTap(scope, items) {
  if (!canSaveToPhotos()) {
    // No share-with-files here (Firefox, desktop Chrome, headless): same untouched bytes,
    // browser download folder instead of Photos. downloadBatch says so via the button label.
    const pill = pillFor(scope);
    if (pill) pill.textContent = "Downloading";
    downloadBatch(items, {
      onProgress: (p) => { const el = pillFor(scope); if (el) el.textContent = `${p.index || 0} / ${p.total}`; },
    }).then(() => paintSaveState(scope, null))
      .catch((e) => { toast(e.message || "Download failed"); paintSaveState(scope, null); });
    return;
  }
  const s = saveSession(scope, items);
  s.saveNext().then((r) => {
    if (r.status === "shared" && r.done) dropSaveSession(scope);
    else if (r.status === "unsupported") { dropSaveSession(scope); toast("Sharing files not supported here"); }
    else if (r.status === "error") toast((r.error && r.error.message) || "Save failed");
    // "ready" and "cancelled" both mean: the next tap opens the sheet. The pill already says so.
  });
}

// ── inert helpers for the full-screen viewer (same targets sheet.js makes inert) ──────────
function setBackdropInert(on) {
  for (const el of [document.getElementById("view"), document.querySelector(".tabbar"),
                    document.getElementById("dock")]) {
    if (!el) continue;
    if (on) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// THE VIEWER — full screen, swipe between items, pinch-zoom photos, native video, drag-down
// to dismiss with sheet.js's exact thresholds so the two gestures feel like one hand.
//
// ── GESTURE ARBITRATION — decided once, here, because this is where viewers break ─────────
// Zoomed panning and item-swiping want the same one-finger drag. The rule is that a gesture
// is CLASSIFIED ONCE, at the moment it leaves the 8px slop, and is never re-classified:
//
//   fingers  zoom   drag                    owner
//   ───────  ────   ──────────────────────  ──────────────────────────────────────────────
//   2        any    any                     PINCH (ours). A second finger landing CANCELS
//                                           whatever the first one had begun — a pinch that
//                                           starts with a slightly vertical drift must not
//                                           leave a half-dismissed pane behind it.
//   1        1x     mostly horizontal       the NATIVE scroll-snap pager. touch-action:pan-x
//                                           hands it to the compositor, so momentum, snap
//                                           and rubber-band are the platform's — and it is
//                                           the same scroller the e2e harness drives.
//   1        1x     clearly downward        DISMISS (ours), on sheet.js's numbers verbatim.
//   1        1x     upward                  nothing.
//   1        >1x    any                     PAN (ours). The zoomed item's touch-action goes
//                                           to `none`, so the pager never sees this drag at
//                                           all. That is why zoomed panning cannot fight the
//                                           swipe: at >1x the swipe does not exist.
//
// Which leaves one hole, and it is the hole every photo viewer falls into: at >1x the pager
// is gone, so a zoomed photo would be a trap. So panning past a bound RUBBER-BANDS, and on
// release past HANDOFF_PX it resolves — the over-drag is the exit, not a dead end:
//   horizontal over-drag -> zoom snaps back to 1x and the pager moves one item that way
//   vertical over-drag   -> zoom snaps back to 1x (and the NEXT drag is a dismiss, because
//                           dismiss only ever exists at 1x)
// Nothing is ever two things at once, and every state is one gesture from the way out.
//
// PAN BOUNDS are measured off the IMAGE, never the slide. A portrait photo in a landscape
// slide is letterboxed, and clamping to the slide would let it be flung into the letterbox
// and off the screen. The bound is (displayed_edge * scale - slide_edge) / 2, floored at 0 —
// so an axis that still fits stays centred and refuses to move at all.
//
// ── VIDEO ────────────────────────────────────────────────────────────────────────────────
//   ASPECT   the element carries `aspect-ratio` from the row's stored width/height BEFORE a
//            byte is fetched (falling back to the poster's own intrinsic ratio), so metadata
//            arriving never re-lays-out the slide. No letterbox jump, ever.
//   SCRUB    preload="metadata" and a plain src to /media/o/<key>. The seek is the browser's
//            own Range request against the Worker's 206 path; nothing here proxies, buffers
//            or blobs it, which is the only way scrubbing genuinely works.
//   SILENCE  this code NEVER sets `muted`. A muted-by-default player is exactly what breaks
//            iOS expectations — the ring/silent switch stops meaning anything and the video
//            plays silent with the switch off. Sound follows the phone; audio only ever
//            starts from the user's own tap on the native control.
//   BATTERY  four trek days with no charger: closing the viewer pauses AND DETACHES every
//            source (removeAttribute + load(), which aborts the fetch and frees the decoder),
//            and hiding the document pauses playback. Nothing decodes behind a closed viewer.
//
// ── THE ORIGINAL IS UNFILTERED ───────────────────────────────────────────────────────────
// The list's stamp filter is decorative chrome on a thumbnail. The viewer renders the stored
// bytes and nothing else: memories.css pins `filter:none` on .me-vimg/.me-vvideo so no
// ancestor or future decoration can reach the picture, and the <img>/<video> point straight
// at /media/o/<key>.
// ══════════════════════════════════════════════════════════════════════════════════════════
const DISMISS_FRACTION = 0.28;   // sheet.js's numbers, verbatim — one hand, one feel
const DISMISS_VELOCITY = 0.6;
const FLICK_MIN_PX = 24;
const DRAG_SLOP = 8;
const HANDOFF_PX = 56;           // over-drag past a zoom bound before it resolves
const RUBBER = 0.18;             // how much of an over-drag the picture actually follows
const ZOOM_MAX = 4;
const ZOOM_FLOOR = 0.86;         // pinch-in rubber band; always springs back to 1
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 300;
const VIDEO_CONTROLS_PX = 64;    // the native control strip: the browser's, never ours

let viewer = null;                      // the open viewer's teardown fn, or null
let viewerRoot = null;
let viewerMem = null;


// ── framing: a crop and a loop window, stored beside the media ──────────────────────────
// Presentation state only: nothing here re-encodes anything, and the
// original bytes stay exactly as uploaded so "send my friend the long version" keeps working.

/** The five numbers, with the defaults that mean "as it was before 0012". */
function framingOf(m) {
  return {
    x: Number.isFinite(Number(m.focal_x)) ? Number(m.focal_x) : 0.5,
    y: Number.isFinite(Number(m.focal_y)) ? Number(m.focal_y) : 0.5,
    zoom: Number(m.zoom) > 1 ? Math.min(8, Number(m.zoom)) : 1,
    start: Number.isFinite(Number(m.trim_start_s)) ? Number(m.trim_start_s) : null,
    end: Number.isFinite(Number(m.trim_end_s)) ? Number(m.trim_end_s) : null,
  };
}

/**
 * Put a framing onto one <img>/<video>. ONE FUNCTION, used by the feed, the list, the viewer
 * and the framing sheet's own preview — the requirement is that a crop shows up across
 * the memories views, and four copies of this arithmetic is how three of them drift.
 *
 * object-position places the cover window; the scale pushes into it from the same anchor, so
 * zooming in does not slide the subject out of frame. The collage does the identical pair.
 */
function applyFraming(host, m) {
  if (!host) return;
  const f = framingOf(m);
  const pos = (f.x * 100) + "% " + (f.y * 100) + "%";
  for (const el of host.querySelectorAll("img, video")) {
    el.style.objectPosition = pos;
    el.style.transformOrigin = pos;
    el.style.transform = f.zoom > 1 ? "scale(" + f.zoom + ")" : "";
  }
  const v = host.querySelector("video");
  if (v && f.start !== null && f.end !== null && f.end > f.start) {
    v.dataset.trimStart = String(f.start);
    v.dataset.trimEnd = String(f.end);
  } else if (v) {
    delete v.dataset.trimStart;
    delete v.dataset.trimEnd;
  }
}

/**
 * The sheet. A live preview you drag to move the crop, a zoom slider, and — for video — the
 * loop window, with the clip scrubbing to whichever handle you last touched so you can see
 * where you are putting it.
 */
function openFramingSheet(mem, m, onSaved) {
  const f = framingOf(m);
  const isVideo = m.kind === "video";
  const dur = Number(m.duration_s) || 0;
  if (isVideo && f.start === null) { f.start = 0; f.end = Math.min(dur || 4, 4); }

  const body = document.createElement("div");
  body.className = "me-fr ds";
  const src = isVideo ? (m.url || thumbUrlOf(m)) : (m.url || thumbUrlOf(m));
  body.innerHTML =
    '<div class="me-frbox" aria-hidden="true">' +
      (isVideo
        ? '<video class="me-frmedia" playsinline muted loop preload="metadata"></video>'
        : '<img class="me-frmedia" alt="">') +
      '<div class="me-frgrid"></div>' +
    '</div>' +
    '<p class="me-frhint">Drag the picture to choose what stays in shot.</p>' +
    '<div class="field"><label for="me-frz">Zoom</label>' +
      '<input id="me-frz" class="me-frrange" type="range" min="1" max="4" step="0.05"></div>' +
    (isVideo
      ? '<h3 class="me-frhead">Loop</h3>' +
        '<p class="me-frhint">The board plays this much and then repeats. The whole clip is ' +
        'kept — saving to Photos still gives you all of it.</p>' +
        '<div class="field"><label for="me-fra">Starts at <span class="num me-fralab"></span></label>' +
          '<input id="me-fra" class="me-frrange" type="range" min="0" step="0.1"></div>' +
        '<div class="field"><label for="me-frb">Ends at <span class="num me-frblab"></span></label>' +
          '<input id="me-frb" class="me-frrange" type="range" min="0" step="0.1"></div>'
      : "");

  const box = body.querySelector(".me-frbox");
  const el = body.querySelector(".me-frmedia");
  const zin = body.querySelector("#me-frz");
  const ain = body.querySelector("#me-fra");
  const bin = body.querySelector("#me-frb");
  const alab = body.querySelector(".me-fralab");
  const blab = body.querySelector(".me-frblab");
  // An original this browser can't read (a HEIC outside Safari): the thumbnail, which it can.
  if (!isVideo) el.addEventListener("error", () => { const t = thumbUrlOf(m); if (t && el.getAttribute("src") !== t) el.src = t; });
  el.src = src;
  zin.value = String(f.zoom);

  const paint = () => {
    const pos = (f.x * 100) + "% " + (f.y * 100) + "%";
    el.style.objectPosition = pos;
    el.style.transformOrigin = pos;
    el.style.transform = f.zoom > 1 ? "scale(" + f.zoom + ")" : "";
    if (isVideo && alab) {
      alab.textContent = f.start.toFixed(1) + "s";
      blab.textContent = f.end.toFixed(1) + "s";
    }
  };

  // DRAG THE PICTURE, not a reticle over it. The gesture is "move what I am looking at", and
  // the mapping is inverted for the same reason a map pans the opposite way to the finger.
  let drag = null;
  box.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    try { box.setPointerCapture(ev.pointerId); } catch { /* older engines */ }
    drag = { px: ev.clientX, py: ev.clientY };
  });
  box.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const r = box.getBoundingClientRect();
    // Divided by the zoom: at 4x the same finger travel should move the crop a quarter as far
    // through the source, or the subject shoots off the edge.
    f.x = Math.min(1, Math.max(0, f.x - (ev.clientX - drag.px) / Math.max(1, r.width) / f.zoom));
    f.y = Math.min(1, Math.max(0, f.y - (ev.clientY - drag.py) / Math.max(1, r.height) / f.zoom));
    drag = { px: ev.clientX, py: ev.clientY };
    paint();
  });
  const endDrag = () => { drag = null; };
  box.addEventListener("pointerup", endDrag);
  box.addEventListener("pointercancel", endDrag);

  zin.addEventListener("input", () => { f.zoom = Number(zin.value) || 1; paint(); });

  if (isVideo) {
    const total = dur || 30;
    for (const r of [ain, bin]) r.max = String(total);
    ain.value = String(f.start);
    bin.value = String(f.end);
    const sync = (which) => {
      f.start = Math.min(Number(ain.value), total - 0.2);
      f.end = Math.max(Number(bin.value), f.start + 0.2);
      if (which === "a" && f.end < f.start + 0.2) { f.end = Math.min(total, f.start + 0.2); bin.value = String(f.end); }
      if (which === "b" && f.end < f.start + 0.2) { f.start = Math.max(0, f.end - 0.2); ain.value = String(f.start); }
      // Scrub to the handle being moved: a loop window you cannot see the ends of is a guess.
      try { el.currentTime = which === "a" ? f.start : f.end; } catch { /* not ready */ }
      paint();
    };
    ain.addEventListener("input", () => sync("a"));
    bin.addEventListener("input", () => sync("b"));
  }
  paint();

  const foot = document.createElement("div");
  foot.className = "row me-frfoot ds";
  foot.innerHTML =
    '<button class="btn ds-button ds-button--gray me-frreset" type="button">Reset</button>' +
    '<button class="btn ds-button ds-button--white grow me-frsave" type="button">Save</button>';

  const sheet = openSheet({ title: "Framing", contentEl: body, footEl: foot });

  foot.querySelector(".me-frreset").addEventListener("click", () => {
    f.x = 0.5; f.y = 0.5; f.zoom = 1;
    if (isVideo) { f.start = 0; f.end = Math.min(dur || 4, 4); ain.value = "0"; bin.value = String(f.end); }
    zin.value = "1";
    paint();
  });

  foot.querySelector(".me-frsave").addEventListener("click", async () => {
    const patch = {
      focal_x: f.x, focal_y: f.y,
      // 1 means "no crop", and storing null rather than 1 keeps "never set" distinguishable
      // from "set back to normal" — which matters only to whoever reads the table, but costs
      // nothing to get right.
      zoom: f.zoom > 1 ? f.zoom : null,
    };
    if (isVideo) { patch.trim_start_s = f.start; patch.trim_end_s = f.end; }
    // Optimistic: the row on this device carries the new numbers before the write lands, so the
    // board behind the sheet is already right when it closes.
    Object.assign(m, {
      focal_x: patch.focal_x, focal_y: patch.focal_y, zoom: patch.zoom,
      trim_start_s: isVideo ? patch.trim_start_s : m.trim_start_s,
      trim_end_s: isVideo ? patch.trim_end_s : m.trim_end_s,
    });
    if (typeof onSaved === "function") onSaved();
    sheet.close();
    const res = await api("PATCH", T(`/memories/${encodeURIComponent(mem.id)}`),
      { framing: { [m.id]: patch } });
    if (!res.ok) toast("Framing not saved");
  });
}

/** The viewer over everything. Grows from `originEl` on open and returns there on close. */
function openViewer(mem, startIdx = 0, { onClose = null, originEl = null } = {}) {
  closeViewer();
  const media = sortedMedia(mem);
  if (!media.length) return;

  const root = document.createElement("div");
  root.className = "me-view ds";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Media");
  root.dataset.chrome = "1";
  const skin = authorSkin(mem);
  // When it happened, as the card says it, with its day (the viewer has no day heading over it).
  const when = whenSaid(mem, { withDay: true });
  root.innerHTML =
    `<div class="me-vscrim"></div>` +
    `<div class="me-vpane">` +
      `<div class="me-vtrack" tabindex="-1">${media.map((m, i) => slideHtml(m, i)).join("")}</div>` +
      `<div class="me-vtop">` +
        `<button class="me-vbtn me-vclose" type="button" aria-label="Close">${ico("x")}</button>` +
        `<span class="me-vcount num" aria-live="polite">${media.length > 1 ? `1 / ${media.length}` : ""}</span>` +
        `<button class="me-vbtn me-vframe" type="button" aria-label="Adjust framing">` +
          `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">` +
            `<path d="M8 3v13a2 2 0 0 0 2 2h11"/><path d="M3 8h13a2 2 0 0 1 2 2v11"/></svg>` +
        `</button>` +
        `<button class="me-vbtn me-vsave" type="button" aria-label="Save to Photos">${ico("save")}</button>` +
      `</div>` +
      `<div class="me-vbottom">` +
        `<span class="me-vwho">${faceMarkup(skin, "me-ava-sm")}<span>${esc(skin.name || "")}</span></span>` +
        (mem.caption ? `<p class="me-vcap">${esc(mem.caption)}</p>` : "") +
        `<span class="me-vwhen num">${esc(when)}</span>` +
      `</div>` +
    `</div>`;

  // THE STORED FRAMING, ON EVERY SLIDE. The requirement is that a crop shows up across
  // the memories views — so the viewer honours it too, not just the board.
  const applyAll = () => {
    const track0 = root.querySelector(".me-vtrack");
    if (!track0) return;
    media.forEach((mm, i) => applyFraming(track0.children[i], mm));
  };

  const pane = root.querySelector(".me-vpane");
  const scrim = root.querySelector(".me-vscrim");
  const track = root.querySelector(".me-vtrack");
  const topBar = root.querySelector(".me-vtop");
  const botBar = root.querySelector(".me-vbottom");
  const count = root.querySelector(".me-vcount");
  const saveBtn = root.querySelector(".me-vsave");
  const frameBtn = root.querySelector(".me-vframe");
  const returnFocus = document.activeElement;
  applyAll();

  let idx = Math.max(0, Math.min(startIdx, media.length - 1));
  let closed = false;

  // FRAMING, on the item you are looking at. It belongs in a memory's settings, when
  // you add or edit a memory or one item of it — and the specific item is exactly
  // what the viewer is already showing, at the size you would judge a crop at.
  frameBtn.addEventListener("click", () => openFramingSheet(mem, media[idx], () => {
    // The crop changed. Re-render the slide under the thumb rather than the whole viewer, so
    // the photo does not blink and the position in the set is kept.
    applyFraming(track.children[idx], media[idx]);
    emitLocal();
  }));

  function slideHtml(m, i) {
    const thumb = thumbUrlOf(m);
    if (m.kind === "video") {
      // aspect-ratio before the first byte: the slide is the right shape while the poster is
      // still the only thing on it, so `loadedmetadata` changes nothing about the layout.
      const ar = m.width > 0 && m.height > 0 ? (m.width / m.height) : 0;
      return `<div class="me-vitem" data-i="${i}" data-kind="video">` +
        `<video class="me-vvideo" controls playsinline preload="none" x-webkit-airplay="allow"` +
        (ar ? ` style="aspect-ratio:${ar.toFixed(4)}"` : "") +
        (thumb ? ` poster="${esc(thumb)}"` : "") + ` data-src="${esc(m.url || mediaUrl(keyOf(m)))}"></video>` +
        `<span class="me-vmeta num">${esc(fmtDur(m.duration_s))}${m.bytes ? ` · ${fmtBytes(m.bytes)}` : ""}</span>` +
      `</div>`;
    }
    return `<div class="me-vitem" data-i="${i}" data-kind="photo">` +
      `<img class="me-vimg" alt=""` + (thumb ? ` src="${esc(thumb)}"` : "") +
      ` data-full="${esc(m.url || mediaUrl(keyOf(m)))}">` +
      // Said only when there is nothing to draw: no thumbnail, and an original this browser can't read (loadSlide).
      `<p class="me-vnone" hidden>${ico("photo")}<span>This photo won't open full size: this browser can't read it.</span></p>` +
    `</div>`;
  }

  const itemAt = (i) => track.children[i];

  // A row uploaded before the API recorded dimensions has no ratio to reserve, so borrow the
  // poster's — it is the same frame, and it is already being fetched for the poster anyway.
  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    if (m.kind !== "video" || (m.width > 0 && m.height > 0)) continue;
    const v = itemAt(i).querySelector("video");
    if (!v || !v.poster) continue;
    const probe = new Image();
    probe.onload = () => {
      if (!closed && probe.naturalWidth && probe.naturalHeight) {
        v.style.aspectRatio = (probe.naturalWidth / probe.naturalHeight).toFixed(4);
      }
    };
    probe.src = v.poster;
  }

  // Load the original for a slide the moment it is current or adjacent — the feed scrolls on
  // thumbs, the viewer is where originals belong.
  const loaded = new Set();
  function loadSlide(i) {
    if (i < 0 || i >= media.length || loaded.has(i)) return;
    loaded.add(i);
    const item = itemAt(i);
    const m = media[i];
    if (m.kind === "video") {
      const v = item.querySelector("video");
      v.src = v.dataset.src;
      v.preload = "metadata";     // metadata only: the frames arrive as Range asks for them
      return;
    }
    const img = item.querySelector("img");
    const full = new Image();
    full.decoding = "async";
    full.onload = () => {
      img.src = full.src;
      item.dataset.full = "1";
      item.dataset.miss = "";
      // The original may lay out a pixel or two off the thumb's box; re-clamp so a pan that
      // was legal a moment ago cannot be left sitting outside the new bound.
      clampPan(i); applyZoom(i, false);
    };
    full.onerror = () => {
      // No signal: it is fetched again when this slide comes round. With signal the browser can't read it (a HEIC
      // outside Safari): it isn't fetched again, and with no thumbnail under it the slide says so. Save still hands
      // over the original's bytes.
      if (!store.online()) { loaded.delete(i); item.dataset.miss = "1"; return; }
      item.dataset.unreadable = "1";
      if (!img.getAttribute("src")) item.querySelector(".me-vnone").hidden = false;
      if (i === idx) paintFrameBtn();
    };
    full.src = img.dataset.full;
  }

  // ── zoom state, one record per slide ────────────────────────────────────────────────────
  const zooms = media.map(() => ({ s: 1, tx: 0, ty: 0 }));
  let pinchI = -1;                  // slide whose touch-action is held open by a live pinch

  // Bounds off the IMAGE box, not the slide. img.offsetWidth is the laid-out size and is
  // untouched by our transform, which is what makes this stable to read mid-gesture.
  function bounds(i) {
    const item = itemAt(i);
    if (!item) return { mx: 0, my: 0 };
    const img = item.querySelector("img");
    const W = item.clientWidth || 1, H = item.clientHeight || 1;
    const w0 = (img && img.offsetWidth) || W;
    const h0 = (img && img.offsetHeight) || H;
    const s = zooms[i].s;
    return { mx: Math.max(0, (w0 * s - W) / 2), my: Math.max(0, (h0 * s - H) / 2) };
  }
  function clampPan(i) {
    const z = zooms[i], b = bounds(i);
    z.tx = Math.max(-b.mx, Math.min(b.mx, z.tx));
    z.ty = Math.max(-b.my, Math.min(b.my, z.ty));
  }
  function applyZoom(i, anim) {
    const item = itemAt(i);
    if (!item) return;
    const img = item.querySelector("img");
    const z = zooms[i];
    if (img) {
      img.style.transition = anim && !reducedMotion()
        ? `transform ${ms("--dur-fast", 120)}ms cubic-bezier(.2,.8,.2,1)` : "";
      img.style.transform = (z.s !== 1 || z.tx || z.ty)
        ? `translate3d(${z.tx.toFixed(2)}px,${z.ty.toFixed(2)}px,0) scale(${z.s.toFixed(4)})` : "";
    }
    item.dataset.zoom = (z.s > 1.01 || i === pinchI) ? "1" : "";
  }
  function resetZoom(i, anim) {
    const z = zooms[i];
    if (z.s === 1 && !z.tx && !z.ty) return;
    z.s = 1; z.tx = 0; z.ty = 0;
    applyZoom(i, anim);
  }

  // ── the single pointer arbiter ──────────────────────────────────────────────────────────
  // One set of listeners owns pinch, pan, dismiss and tap. Three overlapping listeners is the
  // other way to write this and it is how a pinch ends up half-dismissing the pane.
  const pointers = new Map();
  let g = null;                     // the live gesture, or null
  let lastTap = 0, lastTapI = -1, tapTimer = 0;

  function goTo(i) {
    const item = itemAt(i);
    if (!item) return;
    track.scrollTo({ left: item.offsetLeft, behavior: reducedMotion() ? "auto" : "smooth" });
  }
  function setChrome(on) {
    root.dataset.chrome = on ? "1" : "0";
    for (const bar of [topBar, botBar]) {
      if (on) bar.removeAttribute("inert"); else bar.setAttribute("inert", "");
    }
  }

  function startPinch(i) {
    // Two fingers on a video mean nothing to us; drop whatever the first one had started
    // rather than letting it carry on as a one-finger dismiss under a two-finger hand.
    if (media[i].kind !== "photo") { g = null; return; }
    const [a, b] = [...pointers.values()];
    const item = itemAt(i);
    const r = item.getBoundingClientRect();
    const z = zooms[i];
    // A pinch cancels a dismiss in flight, instantly and without a spring — the finger that
    // started it has changed its mind, and animating the pane back would fight the zoom.
    if (g && g.mode === "dismiss") { root.dataset.drag = "0"; pane.style.transform = ""; scrim.style.opacity = ""; }
    pinchI = i;
    g = {
      i, mode: "pinch", pid: -1, moved: true,
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      fx0: (a.x + b.x) / 2, fy0: (a.y + b.y) / 2,
      s0: z.s, tx0: z.tx, ty0: z.ty,
    };
    applyZoom(i, false);
  }
  function updatePinch() {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const fx = (a.x + b.x) / 2, fy = (a.y + b.y) / 2;
    const z = zooms[g.i];
    const s = Math.max(ZOOM_FLOOR, Math.min(ZOOM_MAX, g.s0 * (d / g.d0)));
    // Focal-point zoom: the picture point that was under the two fingers stays under them.
    // A pinch that only translates by the centroid (the easy version) slides the picture out
    // from under the hand and feels like the photo is dodging you.
    const p0x = (g.fx0 - g.cx - g.tx0) / g.s0;
    const p0y = (g.fy0 - g.cy - g.ty0) / g.s0;
    z.s = s;
    z.tx = fx - g.cx - s * p0x;
    z.ty = fy - g.cy - s * p0y;
    clampPan(g.i);
    applyZoom(g.i, false);
  }

  function beginPan(e) {
    const z = zooms[g.i];
    g.mode = "pan";
    g.tx0 = z.tx; g.ty0 = z.ty; g.overX = 0; g.overY = 0; g.dx = 0; g.dy = 0;
    try { track.setPointerCapture(e.pointerId); } catch { /* mouse on some engines */ }
  }
  function panMove(e) {
    const z = zooms[g.i], b = bounds(g.i);
    g.dx = e.clientX - g.x0; g.dy = e.clientY - g.y0;
    const wantX = g.tx0 + g.dx;
    const wantY = g.ty0 + g.dy;
    const cx = Math.max(-b.mx, Math.min(b.mx, wantX));
    const cy = Math.max(-b.my, Math.min(b.my, wantY));
    g.overX = wantX - cx; g.overY = wantY - cy;
    z.tx = cx + g.overX * RUBBER;
    z.ty = cy + g.overY * RUBBER;
    applyZoom(g.i, false);
  }
  function endPan() {
    const i = g.i;
    // The axis is the FINGER's, not the over-drag's. A landscape photo at 2.5x has no
    // vertical room at all, so every pixel of vertical travel is technically an over-drag —
    // reading the exit off that would pop the zoom on any diagonal pan, which is the single
    // most annoying thing a zoomed photo can do.
    const horiz = Math.abs(g.dx || 0) > Math.abs(g.dy || 0);
    if (horiz && Math.abs(g.overX) > HANDOFF_PX) {
      // dragged the picture right = asking for the item on the left
      const target = Math.max(0, Math.min(media.length - 1, idx + (g.overX > 0 ? -1 : 1)));
      resetZoom(i, true);
      if (target !== idx) goTo(target);
    } else if (!horiz && Math.abs(g.overY) > HANDOFF_PX) {
      resetZoom(i, true);
    } else {
      clampPan(i); applyZoom(i, true);
    }
  }

  function beginDismiss(e) {
    g.mode = "dismiss";
    g.dy = 0; g.vel = 0; g.lastY = e.clientY; g.lastT = performance.now();
    root.dataset.drag = "1";
    try { track.setPointerCapture(e.pointerId); } catch { /* mouse on some engines */ }
  }
  function dismissMove(e) {
    g.dy = Math.max(0, e.clientY - g.y0);
    pane.style.transform = `translate3d(0,${g.dy}px,0)`;
    scrim.style.opacity = String(Math.max(0, 1 - g.dy / (root.clientHeight * 0.9)));
    // performance.now(), not e.timeStamp — sheet.js's lesson: one clock, or the velocity is
    // a distance divided by "milliseconds since the page loaded".
    const t = performance.now();
    const dt = t - g.lastT;
    if (dt > 8) { g.vel = (e.clientY - g.lastY) / dt; g.lastY = e.clientY; g.lastT = t; }
  }
  function endDismiss(cancelled) {
    root.dataset.drag = "0";
    if (!cancelled) {
      if (performance.now() - g.lastT > 120) g.vel = 0;   // a flick that ended is not a flick
      const far = g.dy > root.clientHeight * DISMISS_FRACTION;
      const flicked = g.vel > DISMISS_VELOCITY && g.dy > FLICK_MIN_PX;
      if (far || flicked) { close(g.dy); return; }
    }
    pane.style.transition = reducedMotion() ? "" : `transform ${ms("--dur", 220)}ms var(--ease-spring, ease-out)`;
    pane.style.transform = "";
    scrim.style.opacity = "";
    setTimeout(() => { pane.style.transition = ""; }, ms("--dur", 220) + 40);
  }

  function tap(e) {
    const i = g.i;
    if (g.onVideo) return;                       // the native controls own every tap on them
    const now = performance.now();
    const isPhoto = media[i].kind === "photo" && !!itemAt(i).querySelector("img");
    if (isPhoto && lastTapI === i && now - lastTap < DOUBLE_TAP_MS) {
      lastTap = 0;
      clearTimeout(tapTimer);
      const z = zooms[i];
      if (z.s > 1.01) resetZoom(i, true);
      else {
        const r = itemAt(i).getBoundingClientRect();
        // Zoom about the tapped point: at scale s a picture point p (from centre) lands at
        // t + s·p, so holding the tapped point still means t = (1 − s)·p.
        z.s = DOUBLE_TAP_ZOOM;
        z.tx = (1 - z.s) * (e.clientX - (r.left + r.width / 2));
        z.ty = (1 - z.s) * (e.clientY - (r.top + r.height / 2));
        clampPan(i);
        applyZoom(i, true);
      }
      return;
    }
    lastTap = now; lastTapI = i;
    const toggle = () => { if (!closed) setChrome(root.dataset.chrome !== "1"); };
    // On a photo the chrome waits out the double-tap window, so a double tap zooms without
    // also flashing the chrome twice. Nothing else has a second meaning, so nothing else waits.
    clearTimeout(tapTimer);
    if (isPhoto) tapTimer = setTimeout(toggle, DOUBLE_TAP_MS + 20);
    else toggle();
  }

  function onDown(e) {
    if (e.button != null && e.button !== 0) return;      // right-click, middle-click
    if (e.target.closest("button")) return;              // the chrome buttons own their taps
    // With a pointer captured on the track, a SECOND finger's pointerdown is retargeted to
    // the track, so the slide has to come from the gesture in flight rather than the target.
    const item = e.target.closest(".me-vitem") || (g ? itemAt(g.i) : null);
    if (!item) return;
    const i = Number(item.dataset.i) || 0;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { startPinch(i); return; }
    if (pointers.size > 2 || (g && g.mode === "pinch")) return;
    const vid = e.target.closest("video");
    g = {
      i, mode: "undecided", pid: e.pointerId, moved: false,
      x0: e.clientX, y0: e.clientY,
      onVideo: !!vid,
      // The bottom strip of a <video controls> is the scrubber. Never classify a drag that
      // starts there — seeking IS the range-request path and stealing it would be the exact
      // failure this pass exists to prevent.
      inControls: !!vid && e.clientY > vid.getBoundingClientRect().bottom - VIDEO_CONTROLS_PX,
    };
  }

  function onMove(e) {
    const p = pointers.get(e.pointerId);
    if (p) { p.x = e.clientX; p.y = e.clientY; }
    if (!g) return;
    if (g.mode === "pinch") { updatePinch(); return; }
    if (e.pointerId !== g.pid) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (Math.abs(dx) > DRAG_SLOP || Math.abs(dy) > DRAG_SLOP) g.moved = true;
    if (g.mode === "undecided") {
      if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
      if (zooms[g.i].s > 1.01) beginPan(e);
      else if (g.inControls) { g.mode = "native"; return; }
      else if (Math.abs(dx) >= Math.abs(dy) || dy < 0) { g.mode = "native"; return; }
      else beginDismiss(e);
    }
    if (g.mode === "pan") panMove(e);
    else if (g.mode === "dismiss") dismissMove(e);
  }

  function onUp(e, cancelled) {
    pointers.delete(e.pointerId);
    if (!g) return;
    if (g.mode === "pinch") {
      if (pointers.size === 1) {
        // One finger left on the glass: carry straight on as a pan, from where the pinch put
        // the picture. Ending the gesture here is what makes a two-finger zoom feel like it
        // "drops" the photo the moment a thumb lifts.
        const [pid] = [...pointers.keys()];
        const p = pointers.get(pid);
        const z = zooms[g.i];
        pinchI = -1;                  // the pinch is over; data-zoom goes back to telling the truth
        g = { i: g.i, mode: "pan", pid, moved: true, x0: p.x, y0: p.y, tx0: z.tx, ty0: z.ty, overX: 0, overY: 0, dx: 0, dy: 0 };
        return;
      }
      const i = g.i, z = zooms[i];
      pinchI = -1; g = null;
      if (z.s < 1) { z.s = 1; z.tx = 0; z.ty = 0; }
      clampPan(i); applyZoom(i, true);
      return;
    }
    if (e.pointerId !== g.pid) return;
    if (g.mode === "pan") endPan();
    else if (g.mode === "dismiss") endDismiss(cancelled);
    else if (g.mode === "undecided" && !g.moved && !cancelled) tap(e);
    g = null;
  }

  // Non-passive, and the reason is iOS — sheet.js's lesson, restated: a touchmove that is not
  // preventDefault()ed hands the gesture to the compositor, which then fires pointercancel
  // and the drag dies halfway down. It also has to decide EARLIER than the pointer stream,
  // because Safari can dispatch touchmove ahead of the pointermove derived from it. Claiming
  // a clear downward pull from the first event is safe by construction: the track's
  // touch-action is pan-x, so vertical was never the browser's to take.
  function onTouchMove(e) {
    if (!g) return;
    if (g.mode === "pinch" || g.mode === "pan" || g.mode === "dismiss") { e.preventDefault(); return; }
    if (g.mode !== "undecided" || g.inControls || !e.touches || e.touches.length !== 1) return;
    if (zooms[g.i].s > 1.01) { e.preventDefault(); return; }
    const t = e.touches[0];
    const dy = t.clientY - g.y0, dx = t.clientX - g.x0;
    if (dy > 0 && dy > Math.abs(dx)) e.preventDefault();
  }

  track.addEventListener("pointerdown", onDown);
  track.addEventListener("pointermove", onMove);
  track.addEventListener("pointerup", (e) => onUp(e, false));
  track.addEventListener("pointercancel", (e) => onUp(e, true));
  track.addEventListener("touchmove", onTouchMove, { passive: false });
  track.addEventListener("dragstart", (e) => e.preventDefault());

  // ── paging ──────────────────────────────────────────────────────────────────────────────
  // Viewer save = THIS item. Prime small photos in RAM so it is genuinely one tap; video
  // stays the honest two (fetch with progress, then the sheet).
  // The crop is chosen on the picture: a photo with nothing this browser can draw (no thumbnail, an original it can't
  // read) has nothing to crop on, so its crop button goes; with a thumbnail the cropper draws that (openFramingSheet).
  function paintFrameBtn() {
    const it = itemAt(idx);
    frameBtn.hidden = it.dataset.unreadable === "1" && !it.querySelector("img")?.getAttribute("src");
  }
  function armSave() {
    paintFrameBtn();
    const m = media[idx];
    const scope = `v:${mem.id}:${m.id || keyOf(m)}`;
    saveBtn.dataset.save = scope;
    if (canSaveToPhotos() && m.kind === "photo" && (m.bytes || 0) <= PREWARM_MAX && store.online()) {
      saveSession(scope, [m]).prewarm().catch(() => {});
    }
  }
  saveBtn.addEventListener("click", () => {
    const m = media[idx];
    onSaveTap(saveBtn.dataset.save, [m]);
  });

  function setIdx(i) {
    if (i === idx) return;
    const prev = idx;
    idx = i;
    if (media.length > 1) count.textContent = `${idx + 1} / ${media.length}`;
    const cur = itemAt(idx).querySelector("video");
    for (const v of track.querySelectorAll("video")) { if (!v.paused && v !== cur) v.pause(); }
    // A slide left behind keeps its zoom otherwise, and coming back to a photo you last saw
    // at 3x — panned to a corner you no longer remember — is disorienting every time.
    if (prev !== idx) resetZoom(prev, false);
    loadSlide(idx); loadSlide(idx + 1); loadSlide(idx - 1);
    armSave();
  }

  let scrollRaf = 0;
  track.addEventListener("scroll", () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const w = track.clientWidth || 1;
      setIdx(Math.max(0, Math.min(media.length - 1, Math.round(track.scrollLeft / w))));
    });
  }, { passive: true });

  // Playing hides the chrome as a unit: the caption block and the native scrubber both want
  // the foot of the screen, and the picture is what you asked for.
  for (const v of track.querySelectorAll("video")) {
    v.addEventListener("play", () => setChrome(false));
  }

  root.querySelector(".me-vclose").addEventListener("click", () => close(0));

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(0); }
    else if (e.key === "ArrowRight") goTo(Math.min(media.length - 1, idx + 1));
    else if (e.key === "ArrowLeft") goTo(Math.max(0, idx - 1));
  }
  document.addEventListener("keydown", onKey, true);

  // Battery, stated as a rule: nothing decodes that nobody is watching.
  function onHide() { if (document.hidden) for (const v of track.querySelectorAll("video")) v.pause(); }
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onHide);

  // A caption makes the bottom chrome taller, and on a video slide the chrome would then sit
  // over the native controls. Measure it once and reserve exactly that much at the foot of
  // every video slide — a constant, so nothing moves when the chrome fades.
  const ro = new ResizeObserver(() => measureChrome());
  function measureChrome() {
    if (closed) return;
    root.style.setProperty("--me-vchrome", `${Math.round(botBar.getBoundingClientRect().height)}px`);
  }

  function teardown() {
    clearTimeout(tapTimer);
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onHide);
    try { ro.disconnect(); } catch { /* never observed */ }
    // Pause is not enough: a detached <video> with a src can keep its decoder and its range
    // requests alive. removeAttribute + load() aborts the fetch and gives the decoder back.
    for (const v of track.querySelectorAll("video")) {
      try { v.pause(); v.removeAttribute("src"); v.load(); } catch { /* already gone */ }
    }
    root.remove();
    setBackdropInert(false);
    viewer = null;
    viewerRoot = null;
    viewerMem = null;
    if (onClose) { try { onClose(); } catch (e) { console.error("[memories] after the viewer", e); } }
  }

  const originFor = (i) => {
    const feedCell = document.querySelector(`.me-stage[data-stage="feed"]:not([hidden]) .me-card[data-id="${CSS.escape(mem.id)}"] .me-cell[data-i="${i}"]`);
    if (feedCell) return feedCell;
    if (i === startIdx && originEl && originEl.isConnected && !originEl.closest("[hidden]")) return originEl;
    return null;
  };
  const targetBoxFor = (slide, i, fallbackRect) => {
    const sr = slide ? slide.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const m = media[i] || {};
    const mediaEl = slide ? slide.querySelector(".me-vimg, .me-vvideo") : null;
    if (mediaEl && mediaEl.offsetWidth > 2 && mediaEl.offsetHeight > 2) {
      const w = mediaEl.offsetWidth, h = mediaEl.offsetHeight;
      return { left: sr.left + (sr.width - w) / 2, top: sr.top + (sr.height - h) / 2, width: w, height: h };
    }
    const natW = m.width > 0 ? m.width : Math.max(1, fallbackRect ? fallbackRect.width : sr.width);
    const natH = m.height > 0 ? m.height : Math.max(1, fallbackRect ? fallbackRect.height : sr.height);
    const scale = Math.min(sr.width / natW, sr.height / natH);
    const w = Math.max(1, natW * scale), h = Math.max(1, natH * scale);
    return { left: sr.left + (sr.width - w) / 2, top: sr.top + (sr.height - h) / 2, width: w, height: h };
  };
  const transformBetween = (fromR, toR) => {
    const sx = Math.max(0.05, fromR.width / Math.max(1, toR.width));
    const sy = Math.max(0.05, fromR.height / Math.max(1, toR.height));
    const dx = (fromR.left + fromR.width / 2) - (toR.left + toR.width / 2);
    const dy = (fromR.top + fromR.height / 2) - (toR.top + toR.height / 2);
    return `translate3d(${dx.toFixed(2)}px,${dy.toFixed(2)}px,0) scale(${sx.toFixed(4)},${sy.toFixed(4)})`;
  };

  function close(fromDragPx) {
    if (closed) return;
    closed = true;
    for (const v of track.querySelectorAll("video")) v.pause();
    const finish = () => {
      teardown();
      if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    };
    if (reducedMotion()) { finish(); return; }
    const ease = "cubic-bezier(0.4, 0, 0.2, 1)";
    const orig = !fromDragPx ? originFor(idx) : null;
    const origRect = orig ? orig.getBoundingClientRect() : null;
    const slide = itemAt(idx);
    const mediaEl = slide ? slide.querySelector(".me-vimg, .me-vvideo") : null;
    const onScreen = origRect && origRect.width > 1 && origRect.height > 1 &&
      origRect.bottom > 0 && origRect.top < window.innerHeight &&
      origRect.right > 0 && origRect.left < window.innerWidth;
    if (!fromDragPx && onScreen && mediaEl) {
      const to = transformBetween(origRect, targetBoxFor(slide, idx, origRect));
      const cur = getComputedStyle(mediaEl).transform;
      topBar.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: ease, fill: "forwards" });
      botBar.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: ease, fill: "forwards" });
      scrim.animate([{ opacity: scrim.style.opacity || 1 }, { opacity: 0 }], { duration: 200, easing: ease, fill: "forwards" });
      mediaEl.animate([{ transform: cur === "none" ? "none" : cur }, { transform: to }],
        { duration: 200, easing: ease, fill: "forwards" });
      setTimeout(finish, 220);
      return;
    }
    const dur = 200;
    const from = fromDragPx ? `translate3d(0,${fromDragPx}px,0)` : "translate3d(0,0,0)";
    pane.animate([{ transform: from }, { transform: "translate3d(0,100%,0)" }],
      { duration: dur, easing: ease, fill: "forwards" });
    scrim.animate([{ opacity: scrim.style.opacity || 1 }, { opacity: 0 }],
      { duration: dur, easing: ease, fill: "forwards" });
    setTimeout(finish, dur + 40);
  }

  viewer = () => { closed = true; teardown(); };
  viewerRoot = root;
  viewerMem = mem;
  document.body.append(root);
  wakePictures(root);
  setBackdropInert(true);
  measureChrome();
  ro.observe(botBar);
  track.scrollLeft = idx * (track.clientWidth || root.clientWidth);
  if (media.length > 1) count.textContent = `${idx + 1} / ${media.length}`;
  loadSlide(idx); loadSlide(idx + 1); loadSlide(idx - 1);
  armSave();
  if (!reducedMotion()) {
    const ease = "cubic-bezier(0.4, 0, 0.2, 1)";
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: ease });
    topBar.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 60, easing: ease, fill: "backwards" });
    botBar.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 60, easing: ease, fill: "backwards" });
    const orig = originFor(idx);
    const origRect = orig ? orig.getBoundingClientRect() : null;
    const slide = itemAt(idx);
    const mediaEl = slide ? slide.querySelector(".me-vimg, .me-vvideo") : null;
    if (origRect && origRect.width > 1 && origRect.height > 1 && mediaEl) {
      const from = transformBetween(origRect, targetBoxFor(slide, idx, origRect));
      mediaEl.animate([{ transform: from }, { transform: "none" }], { duration: 320, easing: ease });
    } else {
      pane.animate([{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }],
        { duration: 320, easing: ease });
    }
  }
  track.focus({ preventScroll: true });

  // Opening a memory prefetches its originals into the SW's budgeted MEDIA cache — this is
  // what turns Save into the two-tap case by the time anyone reaches for it. The worker
  // enforces the byte ceiling and LRU; asking costs nothing offline.
  if (store.online()) mediaCache.prefetch(media).catch(() => {});
}
function closeViewer() { if (viewer) viewer(); }


// ══════════════════════════════════════════════════════════════════════════════════════════
// THE FEED
// ══════════════════════════════════════════════════════════════════════════════════════════
/** An element's box on the screen as laid out, with no transform or translate on it or above it: the offsets up its
 *  offset parents, less what each scroller between has scrolled. A fixed element's chain ends at the screen. */
function layoutBox(el) {
  let left = 0, top = 0, n = el;
  while (n) {
    left += n.offsetLeft; top += n.offsetTop;
    const p = n.offsetParent;
    for (let a = n.parentElement; a && a !== p; a = a.parentElement) { left -= a.scrollLeft; top -= a.scrollTop; }
    if (!p) break;
    left += p.clientLeft - p.scrollLeft; top += p.clientTop - p.scrollTop;
    n = p;
  }
  return { left, top, width: el.offsetWidth, height: el.offsetHeight };
}

export default async function mount(el, ctx) {
  await hydrate();
  // Files a Discard couldn't remove (no signal then, or the app closed before it could) go now, and so do those of an
  // upload the app was closed in the middle of (adoptOrphans).
  adoptOrphans();
  if (drops().length) dropUnposted();

  // Views with a segment in the control: the feed always, anything else once it is wired.
  const avail = VIEWS.filter((v) => v.id === "feed" || typeof v.mount === "function");
  const viewBtns = avail.map((v) =>
    `<button class="me-viewbtn" type="button" data-view="${esc(v.id)}" aria-pressed="false">` +
      `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${v.glyph}</svg>` +
      `<span>${esc(v.label)}</span>` +
    `</button>`).join("");
  const altStages = avail.filter((v) => v.id !== "feed").map((v) =>
    `<div class="me-stage" data-stage="${esc(v.id)}" hidden></div>`).join("");

  // Index.html's observer moves the shell's picture (.head-more) into #view .ds-head-end on phones;
  // rescue it before replacing #view so remounts or re-renders never destroy it.
  const headMore = el.querySelector("[data-head-more]") || el.querySelector(".head-more");
  if (headMore) document.body.append(headMore);
  el.classList.add("ds", "me-root");

  el.innerHTML =
    `<div class="me-top ds-head">` +
      // Named Photos, as the bar names it (the layouts, 16 Nov: the bar said Photos, the page Memories).
      `<h1 class="me-title">Photos</h1>` +
      `<div class="ds-head-end">` +
        // From 768 the add is named here (styles.css .head-add); a phone keeps the floating +.
        // The action in the page's own word, as the Feed's "Add photos" and the sheet it leads to.
        `<button type="button" class="head-add me-headadd">+ Add photos</button>` +
      `</div>` +
    `</div>` +
    (avail.length > 1
      ? `<div class="me-segwrap"><div class="me-views" role="group" aria-label="View">` +
          `<span class="me-views-hl" aria-hidden="true"></span>${viewBtns}` +
        `</div></div>`
      : "") +
    `<div class="me-tags chip-row" role="group" aria-label="Filter by tag" hidden></div>` +
    `<div class="me-jobs stack-tight"></div>` +
    `<div class="me-stage" data-stage="feed"><div class="me-feed"></div></div>` +
    altStages +
    `<div class="me-more" aria-hidden="true"></div>`;

  const tagRow = el.querySelector(".me-tags");
  const jobBox = el.querySelector(".me-jobs");
  const feed = el.querySelector(".me-feed");
  const sentinel = el.querySelector(".me-more");
  const stages = new Map([...el.querySelectorAll(".me-stage")].map((s) => [s.dataset.stage, s]));

  let filterTag = "";
  let limit = PAGE;
  let firstPaint = true;
  let unmounted = false;

  // ── which view is on ─────────────────────────────────────────────────────────────────────
  // The choice persists across sessions. A persisted id that is not wired yet (a collage
  // chosen on a build that had one, opened on a build that does not) falls back to the feed
  // rather than to a blank stage.
  let activeView = "feed";
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved && avail.some((v) => v.id === saved)) activeView = saved;
  } catch { /* private mode */ }

  const handles = new Map();              // view id -> { handle, label } for mounted alt views

  // The rows a view is handed: newest-first, tag filter already applied — every view sees
  // exactly the same truth, which is what makes switching keep the active filter.
  const visibleRows = () => memories().filter((m) => !filterTag || (m.tags || []).includes(filterTag));

  // Mount or update the active non-feed view. The empty label depends on whether a filter is
  // on, and mountList reads it once at mount, so a label change remounts.
  function renderAlt() {
    if (activeView === "feed" || unmounted) return;
    const v = avail.find((x) => x.id === activeView);
    if (!v || !v.mount) return;
    const rows = visibleRows();
    const label = filterTag ? "Nothing with this tag" : "No photos yet";
    if (activeView === "collage") boardEmpty(stages.get("collage"), rows);
    const cur = handles.get(activeView);
    if (cur && cur.label === label) { cur.handle.update(rows); return; }
    if (cur) { try { cur.handle.unmount(); } catch { /* already gone */ } }
    const handle = v.mount(stages.get(activeView), {
      rows,
      opts: {
        onOpen: (mem, originEl) => openViewer(mem, 0, { originEl }),
        tz: tripTz(),
        online: () => store.online(),
        emptyLabel: label,
      },
    });
    handles.set(activeView, { handle, label });
  }

  function paintViewBtns() {
    const box = el.querySelector(".me-views");
    if (box) {
      box.style.setProperty("--me-vn", String(avail.length));
      box.style.setProperty("--me-vi", String(Math.max(0, avail.findIndex((v) => v.id === activeView))));
    }
    for (const b of el.querySelectorAll(".me-viewbtn")) {
      b.setAttribute("aria-pressed", String(b.dataset.view === activeView));
    }
  }

  function paintGround() { el.classList.remove("me-scape"); }

  // 150ms opacity fade between Feed, List, and Board; instant under reduced-motion.
  // fill:"forwards" on the leaver only (the departing-ghost exception), released once hidden.
  function switchView(id) {
    if (id === activeView || !avail.some((v) => v.id === id)) return;
    const prev = activeView;
    const fromStage = stages.get(prev);
    activeView = id;
    try { localStorage.setItem(VIEW_KEY, id); } catch { /* private mode */ }
    const toStage = stages.get(activeView);
    if (activeView === "feed") render(); else renderAlt();
    paintViewBtns();
    paintGround();
    el.scrollTop = 0;
    for (const [sid, s] of stages) {
      for (const a of s.getAnimations()) a.cancel();
      s.hidden = sid !== prev;
    }
    if (reducedMotion()) {
      fromStage.hidden = true;
      toStage.hidden = false;
      if (activeView === "collage") { handles.get("collage")?.handle?.resize?.(); placeEmpty(toStage); }
      return;
    }
    const out = fromStage.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: Math.round(ms("--dur-150", 150) / 2), easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
    out.onfinish = () => {
      fromStage.hidden = true;
      out.cancel();                        // release the fill; hidden carries the state now
      if (unmounted || activeView !== id) return;
      toStage.hidden = false;
      if (activeView === "collage") { handles.get("collage")?.handle?.resize?.(); placeEmpty(toStage); }
      toStage.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: ms("--dur-150", 150), easing: "cubic-bezier(.2,0,0,1)" });
    };
  }

  const viewsBox = el.querySelector(".me-views");
  el.querySelector(".me-headadd").addEventListener("click", () => addPhotos());
  if (viewsBox) viewsBox.addEventListener("click", (e) => {
    const b = e.target.closest(".me-viewbtn");
    if (b) switchView(b.dataset.view);
  });

  // First paint of a persisted choice: no crossfade, just the right stage showing.
  for (const [id, s] of stages) s.hidden = id !== activeView;
  paintViewBtns();
  paintGround();
  if (activeView !== "feed") renderAlt();

  // ── FAB: in the router's fixed layer, never inside the transformed scroller ─────────────
  const layer = ctx.router.fixedLayer();
  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "fab ds ds-fab me-fab";
  fab.setAttribute("aria-label", "Add photos");
  fab.innerHTML = ico("plus");
  fab.addEventListener("click", () => addPhotos());
  layer.append(fab);

  // ── render ───────────────────────────────────────────────────────────────────────────────
  function cardHtml(m) {
    const skin = authorSkin(m);
    const me = store.me();
    const mine = m.created_by === me.id || isHost();
    const media = sortedMedia(m);
    const shown = media.length <= 4 ? media : media.slice(0, 4);
    const extra = media.length - shown.length;
    // The time its photographs were taken; none for a day chosen by hand (no time is invented);
    // when it was posted for a memory that says nothing else. Posted on another day: said.
    const when = whenSaid(m);
    const one = media.length === 1 ? media[0] : null;
    const ar = one && one.width > 0 && one.height > 0
      ? Math.max(0.72, Math.min(1.9, one.width / one.height)) : 1.33;

    const cells = shown.map((mm, i) => {
      const thumb = thumbUrlOf(mm);
      const dims = mm.width > 0 && mm.height > 0 ? ` width="${mm.width}" height="${mm.height}"` : "";
      return `<button class="me-cell" type="button" data-i="${i}" aria-label="${mm.kind === "video" ? "Video" : "Photo"} ${i + 1} of ${media.length}">` +
        (thumb ? `<img alt="" loading="lazy" decoding="async" src="${esc(thumb)}"${dims}>`
          // No thumbnail (the phone that put it up couldn't draw it, a HEIC on most non-Apple phones): the tile says
          // it holds a photo, not an empty square. A video has its play mark already.
          : mm.kind === "video" ? "" : `<span class="me-cellnone" aria-hidden="true">${ico("photo")}</span>`) +
        `<span class="me-cellmark" aria-hidden="true">${ico("miss")}</span>` +
        (mm.kind === "video" ? `<span class="me-play" aria-hidden="true">${ico("play")}</span>` +
          `<span class="me-dur pill num">${esc(fmtDur(mm.duration_s))}</span>` : "") +
        (extra > 0 && i === shown.length - 1 ? `<span class="me-extra num" aria-hidden="true">+${extra}</span>` : "") +
      `</button>`;
    }).join("");

    const tags = (m.tags || []).map((t) =>
      `<button class="me-tag" type="button" data-tag="${esc(t)}">${esc(t)}</button>`).join("");

    // Author byline + caption + plain actions live UNDER the photography, never
    // veiled on top of it.
    const acts =
      `<div class="me-acts">` +
        (m.created_by === me.id ? `<button class="me-obtn me-dayset" type="button" aria-label="When it happened: ${esc(dayLabel(happenedDay(m)))}">${ico("when")}</button>` : "") +
        (mine ? `<button class="me-obtn me-del" type="button" data-destroys aria-label="Delete memory">${ico("trash")}</button>` : "") +
        `<button class="me-obtn me-saveall" type="button" data-save="c:${esc(m.id)}" ` +
          `aria-label="${esc(saveLabel({ fileCount: media.length, batchCount: 1 }))} to Photos">${ico("save")}</button>` +
      `</div>`;

    return `<article class="me-card" data-key="${esc(m.id)}" data-id="${esc(m.id)}">` +
      (media.length
        ? `<div class="me-shot">` +
            `<div class="me-grid" data-n="${Math.min(media.length, 5)}"` +
              (one ? ` style="--me-ar:${ar.toFixed(3)}"` : "") + `>${cells}</div>` +
          `</div>`
        : "") +
      `<div class="me-by">` +
        faceMarkup(skin) +
        `<div class="me-by-main">` +
          `<div class="me-by-top">` +
            `<div class="me-by-who">` +
              `<span class="me-who">${esc(skin.name || "Trip member")}</span>` +
              (when ? `<span class="me-when num">${esc(when)}</span>` : "") +
            `</div>` +
            acts +
          `</div>` +
          (m.caption ? `<p class="me-cap">${esc(m.caption)}</p>` : "") +
        `</div>` +
      `</div>` +
      (tags ? `<div class="me-tagline">${tags}</div>` : "") +
    `</article>`;
  }

  function jobHtml(j) {
    const { sent, total } = jobTotals(j);
    const pct = total ? Math.min(1, sent / total) : 0;
    const n = j.items.length, done = j.items.filter((i) => i.done).length;
    const label = j.state === "waiting" ? "Waiting for signal"
      : j.state === "failed" ? (j.error || "Failed")
      : j.state === "posting" ? "Finishing"
      : j.state === "queued" ? "Queued"
      : "Uploading";
    // A pick over MEMORY_MEDIA_MAX is several posts, one card each: "Post 2 of 3" says which.
    const name = esc(jobWhat(j.items));
    return `<div class="me-job card" data-job="${esc(j.id)}" data-state="${esc(j.state)}">` +
      `<div class="spread">` +
        `<span class="me-jobname">${j.part ? `Post ${j.part.n} of ${j.part.of} · ` : ""}${name}</span>` +
        `<span class="me-jobstate meta">${esc(label)}</span>` +
      `</div>` +
      `<div class="me-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct * 100)}">` +
        `<div class="me-barfill" style="transform:scaleX(${pct.toFixed(4)})"></div>` +
      `</div>` +
      // How far, in files and bytes: honest at a hundred files, where a bar alone barely moves.
      `<p class="me-jobhow meta num">${n > 1 ? `${done} of ${n} sent · ` : ""}${sent > 0 && sent < total ? `${fmtBytes(sent)} of ` : ""}${fmtBytes(total)}</p>` +
      (j.state === "failed" && j.why ? `<p class="me-jobwhy">${esc(j.why)}</p>` : "") +
      // "No room" is the host's to fix, and where they fix it is Your trips: the meter, and the
      // uploads still under way that are holding space. A member can do nothing there.
      (j.state === "failed"
        ? `<div class="row wrap"><button class="btn btn-sm me-retry" type="button">Retry</button>` +
          `<button class="btn btn-sm me-discard" type="button" data-destroys>Discard</button>` +
          (j.full && isHost() ? `<a class="btn btn-sm me-storage" href="/trips">Your storage</a>` : "") +
          `</div>`
        : "") +
    `</div>`;
  }

  // The Feed's empty words, for a view that draws none of its own.
  function emptyHtml() {
    return `${ico("photo", "me-emptyico")}` +
      `<h2 class="h3">${filterTag ? "Nothing with this tag" : "No photos yet"}</h2>` +
      (filterTag ? "" : `<p class="meta">Photos and videos from the trip, for everyone on it. Add the first.</p>` +
        `<button class="btn btn-primary me-emptyadd" type="button">Add photos</button>`);
  }
  // An empty board said nothing (17 Nov, a stranger's walk): with nothing to show and nothing uploading, the same
  // words as the Feed sit on the empty board, at its middle (memories.css .me-stage-empty).
  function boardEmpty(stage, rows) {
    if (!stage) return;
    let box = stage.querySelector(":scope > .me-altempty");
    if (rows.length || jobs.length) {
      if (box) box.remove();
      stage.classList.remove("me-stage-empty");
      return;
    }
    if (!box) { box = document.createElement("div"); box.className = "empty me-altempty"; stage.prepend(box); }
    box.innerHTML = emptyHtml();
    const add = box.querySelector(".me-emptyadd");
    if (add) add.addEventListener("click", () => addPhotos());
    stage.classList.add("me-stage-empty");
    placeEmpty(stage);
  }

  function feedHtml() {
    const list = memories().filter((m) => !filterTag || (m.tags || []).includes(filterTag));
    const slice = list.slice(0, limit);
    let html = "";
    let day = "";
    for (const m of slice) {
      const k = happenedDay(m);
      if (k !== day) {
        day = k;
        html += `<h2 class="me-day ds-day" data-key="d:${esc(k)}">${esc(dayLabel(k))}</h2>`;
      }
      html += cardHtml(m);
    }
    if (!slice.length && !jobs.length) {
      // What a memory is and who sees it (16 Nov: the empty page said only its heading).
      html = `<div class="empty">${emptyHtml()}</div>`;
    }
    sentinel.dataset.done = slice.length >= list.length && !hasMore ? "1" : "0";
    return html;
  }

  function renderTags() {
    const tags = allTags();
    tagRow.hidden = !tags.length;
    tagRow.innerHTML = tags.map((t) =>
      `<button class="chip" type="button" data-tag="${esc(t)}" aria-pressed="${t === filterTag}">${esc(t)}</button>`
    ).join("");
  }

  function renderJobs() {
    jobBox.innerHTML = jobs.map(jobHtml).join("");
  }

  function render({ animateFilter = false } = {}) {
    if (unmounted) return;
    renderTags();
    renderJobs();
    // The feed paints even while another view is showing: it stays the truth the sentinel's
    // done-flag is computed from, and a hidden container costs no decode (lazy images do not
    // fetch offscreen). The active alt view gets the same filtered rows right after.
    const paint = () => { feed.innerHTML = feedHtml(); wireFeed(); paintGround(); };
    if (animateFilter && activeView === "feed") flip(feed, paint);
    else paint();
    renderAlt();

    if (firstPaint) firstPaint = false;
    markMisses();
  }

  // Shape-marked offline honesty: a thumb the cache does not hold, while there is no radio,
  // shows the dashed not-yet-downloaded tray instead of a broken image.
  async function markMisses() {
    for (const img of feed.querySelectorAll(".me-cell img")) {
      img.addEventListener("load", () => { img.closest(".me-cell").dataset.ok = "1"; }, { once: true });
      img.addEventListener("error", () => {
        if (!store.online()) img.closest(".me-cell").dataset.miss = "1";
      }, { once: true });
      if (img.complete && img.naturalWidth > 0) img.closest(".me-cell").dataset.ok = "1";
    }
    // The load/error pair above is the whole truth for cells WITH a thumb: offline, a fetch
    // that cannot be answered from any cache errors, and that is exactly "not downloaded".
    // Deciding from caches.match() instead was tried and double-marks — the renderer's own
    // memory cache can still display an image the Cache API no longer holds. The one case
    // events cannot cover is a memory whose thumb never existed (thumb generation failed at
    // upload): no <img>, so offline it is marked directly.
    if (store.online()) return;
    for (const cell of feed.querySelectorAll(".me-cell")) {
      if (!cell.querySelector("img")) cell.dataset.miss = "1";
    }
  }

  function wireFeed() {
    for (const card of feed.querySelectorAll(".me-card")) {
      const mem = rows.get(card.dataset.id);
      if (!mem) continue;
      for (const cell of card.querySelectorAll(".me-cell")) {
        cell.addEventListener("click", () => openViewer(mem, Number(cell.dataset.i) || 0, { originEl: cell }));
      }
      const saveAll = card.querySelector(".me-saveall");
      saveAll.addEventListener("click", () => onSaveTap(saveAll.dataset.save, sortedMedia(mem)));
      const del = card.querySelector(".me-del");
      if (del) del.addEventListener("click", () => confirmDelete(mem));
      const dayset = card.querySelector(".me-dayset");
      if (dayset) dayset.addEventListener("click", () => openDaySheet(mem));
      for (const tag of card.querySelectorAll(".me-tag")) {
        tag.addEventListener("click", () => setFilter(tag.dataset.tag));
      }
    }
    const add = feed.querySelector(".me-emptyadd");
    if (add) add.addEventListener("click", () => addPhotos());
    // With no memories the page's own "Add photos" is the way in: the head's named add is not drawn
    // beside it (two adds for one thing), as on an empty Places.
    const headAdd = el.querySelector(".me-headadd");
    if (headAdd) headAdd.hidden = !!add;
    wakePictures(feed);
  }

  function setFilter(tag) {
    filterTag = filterTag === tag ? "" : tag;
    limit = PAGE;
    render({ animateFilter: true });
    el.scrollTop = 0;
  }
  tagRow.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) setFilter(chip.dataset.tag);
  });

  jobBox.addEventListener("click", (e) => {
    const box = e.target.closest(".me-job");
    if (!box) return;
    if (e.target.closest(".me-retry")) retryJob(box.dataset.job);
    else if (e.target.closest(".me-discard")) discardJob(box.dataset.job);
  });

  // ── infinite scroll: raise the render window; walk the server cursor when it runs dry ───
  const io = new IntersectionObserver(async (entries) => {
    if (!entries.some((x) => x.isIntersecting)) return;
    if (sentinel.dataset.done === "1") return;
    const cached = memories().filter((m) => !filterTag || (m.tags || []).includes(filterTag)).length;
    if (limit >= cached && hasMore) await fetchOlder();
    limit += PAGE;
    render();
  }, { root: el, rootMargin: "600px" });
  io.observe(sentinel);

  // ── delete (its author or the trip's host; the API is the authority, this mirrors it) ───
  // When it happened, changed by whoever posted it (PATCH day / taken_at; the server refuses
  // anyone else in words). The same day keeps its photographs' time; another day is a day chosen
  // by hand, with no time. Needs signal: it is a question to the server, said so.
  function openDaySheet(mem) {
    const was = happenedDay(mem);
    const body = document.createElement("div");
    body.className = "me-daysheet ds";
    body.innerHTML = `<div class="field"><label for="me-dayedit">The day</label>` +
      `<div class="ds-select-wrap"><select id="me-dayedit" class="ds-select">${dayOptions(mem.day || (mem.taken_at != null ? was : ""), [was])}</select></div></div>` +
      `<p class="meta me-daysay" role="status"></p>` +
      `<div class="row"><button class="btn me-daysave" type="button">Save</button></div>`;
    const sel = body.querySelector("select"), say = body.querySelector(".me-daysay"), save = body.querySelector(".me-daysave");
    const words = () => {
      const v = sel.value;
      say.textContent = !v ? `On the day it was posted, ${dayLabel(dayKey(mem.created_at, tripTz()))}.`
        : mem.taken_at != null && v === dayKey(mem.taken_at, tripTz()) ? `The photos were taken that day, at ${fmtTime(mem.taken_at, tripTz())}.`
        : "Chosen by hand.";
    };
    sel.addEventListener("change", words);
    words();
    const sheet = openSheet({ title: "When it happened", contentEl: body });
    save.addEventListener("click", async () => {
      const v = sel.value || null;
      const keepTime = v && mem.taken_at != null && v === dayKey(mem.taken_at, tripTz());
      if (!store.online()) { say.textContent = "Changing when it happened needs signal."; return; }
      save.disabled = true;
      const res = await api("PATCH", T(`/memories/${encodeURIComponent(mem.id)}`), { day: v, taken_at: keepTime ? mem.taken_at : null });
      save.disabled = false;
      // The server's own sentence ("When a memory happened is changed by whoever posted it.", a
      // deleted memory, a bad day); no answer at all is the signal gone on the way.
      if (!res.ok) { say.textContent = (res.body && typeof res.body.reason === "string" && res.body.reason) || (res.status ? "That couldn't be changed. Try again." : "Changing when it happened needs signal."); return; }
      const row = res.body && (res.body.memory || null);
      if (row && row.id) commitRows([row]);
      else await refreshFeed();
      emitLocal();
      sheet.close();
    });
  }

  function confirmDelete(mem) {
    const media = sortedMedia(mem);
    const body = document.createElement("div");
    body.className = "me-delsheet ds";
    // WHAT WILL GO, THEN THE TWO BUTTONS, in that order down the sheet: with the buttons in
    // the head the sentence about a shared board sat under them, and a thumb reached Delete
    // before the eye reached the sentence.
    const what = `<p class="lead">${esc(wordsFor(media, (m) => m.kind === "video"))}` +
      ` · ${esc(fmtBytes(media.reduce((s, m) => s + (m.bytes || 0), 0)))}</p>` +
      `<p class="me-delboards" role="status" hidden></p>`;
    const acts = `<div class="row me-delacts">` +
      `<button class="btn btn-danger btn-block me-dokill" type="button">Delete</button>` +
      `<button class="btn btn-block me-docancel" type="button">Keep</button></div>`;
    body.innerHTML = what + acts;
    // A shared board that shows it stops with it. Said from what this phone last heard, and
    // asked again now: a board may have been shared since.
    const warn = body.querySelector(".me-delboards");
    const sayBoards = (n) => { const w = boardsWarning(n); warn.textContent = w; warn.hidden = !w; };
    sayBoards(mem.boards);
    if (store.online()) {
      api("GET", T(`/memories/${encodeURIComponent(mem.id)}`)).then((res) => {
        const now = res.ok && res.body && (res.body.memory || res.body);
        if (now && warn.isConnected) sayBoards(now.boards);
      });
    }
    // Delete is the first button in the sheet and the focus does not start on it: a sheet's
    // first focus passes over what destroys (sheet.js, keeperIn) and lands on Keep.
    const sheet = openSheet({ title: "Delete memory", contentEl: body });
    body.querySelector(".me-docancel").addEventListener("click", () => sheet.close());
    body.querySelector(".me-dokill").addEventListener("click", async () => {
      sheet.close();
      if (!store.online()) { toast("Offline — deleting needs signal"); return; }
      const res = await api("DELETE", T(`/memories/${encodeURIComponent(mem.id)}`));
      if (res.ok) {
        rows.delete(mem.id);
        lastSig = sig();
        mtx("readwrite", (os) => os.delete(mem.id));
        mediaCache.forget(media).catch(() => {});
        emitLocal();
        // A shared board that showed it went with it: its link answers "gone" from now on.
        // Whoever deleted the memory is the one person who can tell the board's maker.
        const said = boardsUnshared(res.body && res.body.boards_unshared);
        if (said) toast(said);
      } else {
        toast(res.status === 403 ? "Not yours to delete" : "Delete failed");
      }
    });
  }

  // ── adding photos: the phone's picker first, then one sheet ─────────────────────────────
  // "Add photos" opens the phone's own picker at once (the tap that asked is what lets a page open it); the sheet comes
  // only when something was chosen, holding those, an optional caption, the day, and tags under More. Choosing nothing
  // leaves the screen as it was.
  function addPhotos() {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ACCEPT;
    input.hidden = true;
    el.append(input);
    const done = () => input.remove();
    input.addEventListener("change", () => {
      const files = [...(input.files || [])];
      done();
      if (files.length) openComposer(files);
    }, { once: true });
    input.addEventListener("cancel", done, { once: true });
    input.click();
  }

  // ── composer (the chosen photos, caption, day, tags, upload) ────────────────────────────
  function openComposer(first = []) {
    const picked = [...first];
    const body = document.createElement("div");
    body.className = "me-comp ds";
    body.innerHTML =
      `<input class="me-file" type="file" multiple hidden accept="${esc(ACCEPT)}">` +
      `<button class="btn me-pick" type="button">${ico("photo")}Add photos &amp; videos</button>` +
      `<div class="me-picked" hidden></div>` +
      `<div class="field"><label class="me-comp-label" for="me-cap-in">Caption</label>` +
        `<input id="me-cap-in" class="input me-capin" type="text" maxlength="300" autocomplete="off" placeholder="Write a caption"></div>` +
      // When it happened: read from the photos' own time where they say it, else the day it is
      // posted; any day of the trip can be chosen instead.
      `<div class="field me-comp-row me-whenfield" hidden>` +
        `<div class="me-comp-head"><label class="me-comp-label" for="me-day">When it happened</label>` +
          `<div class="ds-select-wrap"><select id="me-day" class="ds-select me-daysel"></select></div></div>` +
        `<p class="me-whensay" role="status"></p></div>` +
      // Tags are the one thing most posts don't need: under More, folded.
      `<details class="me-more"><summary class="me-comp-label">More</summary>` +
      `<div class="field me-comp-row"><label class="me-comp-label" for="me-tag-in">Tags</label>` +
        `<div class="me-tagpick chip-row"></div>` +
        `<div class="me-tagnew"><input id="me-tag-in" class="input me-tagin" type="text" maxlength="32" ` +
          `autocomplete="off" autocapitalize="none" placeholder="New tag">` +
        `<button class="btn me-tagadd" type="button">Add</button></div></div></details>`;

    const foot = document.createElement("div");
    foot.className = "me-comp-foot ds";
    foot.innerHTML = `<button class="btn btn-block me-go" type="button" disabled aria-description="Choose photos or videos first" title="Choose photos or videos first">Upload</button>`;

    const input = body.querySelector(".me-file");
    const pickBtn = body.querySelector(".me-pick");
    const pickedBox = body.querySelector(".me-picked");
    const capIn = body.querySelector("#me-cap-in");
    const tagPick = body.querySelector(".me-tagpick");
    const tagIn = body.querySelector(".me-tagin");
    const tagAdd = body.querySelector(".me-tagadd");
    const go = foot.querySelector(".me-go");
    const urls = [];
    const whenField = body.querySelector(".me-whenfield");
    const daySel = body.querySelector("#me-day");
    const whenSay = body.querySelector(".me-whensay");
    let read = null;              // { taken, day }: the photos' earliest time, when they say one;
                                  // { bad }: a time that can't be (a camera's clock never set)
    let readSeq = 0;              // the latest reading; an older one finishing late is dropped
    const times = new Map();      // each picked photo's own time (null: it says none), read once
    let byHand = false;           // a day chosen in the picker

    function paintWhen() {
      whenField.hidden = !picked.length;
      if (!picked.length) return;
      const good = read && !read.bad ? read : null;
      const keep = byHand ? daySel.value : (good ? good.day : "");
      daySel.innerHTML = dayOptions(keep, good ? [good.day] : []);
      const v = daySel.value;
      whenSay.textContent = read === undefined ? "Reading when the photos were taken…"
        : read && read.bad ? `The photos' clock says ${fmtDay(read.bad, tripTz())}, ${new Date(read.bad * 1000).getUTCFullYear()}, which can't be right: ${v ? "this one is chosen by hand." : "it goes on the day it's posted, unless you pick one."}`
        : v && read && v === read.day ? `From the photos: taken ${dayLabel(read.day)} at ${fmtTime(read.taken, tripTz())}.`
        : v ? "Chosen by hand."
        : read ? "On the day it's posted, not the photos' day."
        : picked.some((f) => !(f.type || "").startsWith("video/")) ? "The photos don't say when they were taken: it goes on the day it's posted, unless you pick one."
        : "On the day it's posted, unless you pick one.";
    }
    // The earliest time the picked photos were taken, read from their own bytes on this phone
    // (shared/taken.js: EXIF in JPEG, PNG, HEIC and AVIF); a video's isn't read.
    let readingP = Promise.resolve();
    function readWhen() { readingP = readNow(); return readingP; }
    async function readNow() {
      const seq = ++readSeq;
      const photos = picked.filter((f) => !(f.type || "").startsWith("video/"));
      read = undefined;
      paintWhen();
      for (const f of photos) if (!times.has(f)) times.set(f, await takenAt(f, tripTz()));
      if (seq !== readSeq) return;
      const t = earliestOf(photos);
      // The server keeps a time from 1990 to two days ahead (docs/API.md): a camera whose clock
      // was never set says 1985 or 2000, and that is said here, before posting, not after.
      const can = t != null && t >= TAKEN_FROM && t <= Date.now() / 1000 + TAKEN_AHEAD;
      read = t == null ? null : can ? { taken: t, day: dayKey(t, tripTz()) } : { bad: t };
      paintWhen();
    }
    function earliestOf(files) {
      let best = null;
      for (const f of files) { const t = times.get(f); if (t != null && (best == null || t < best)) best = t; }
      return best;
    }
    daySel.addEventListener("change", () => { byHand = true; paintWhen(); });
    /**
     * What a post of `files` says about when it happened: the photos' day and time, a day chosen,
     * or nothing. A pick split into several posts is read post by post when the day is the photos'
     * own: each is on the day and time of its own earliest photo (docs/CONTRACTS.md, a memory's day),
     * and one whose photos say no time is on the pick's day, without a time.
     */
    function whenOf(files = picked) {
      const v = daySel.value;
      if (!v) return {};
      if (!(read && !read.bad && v === read.day)) return { day: v };
      const t = earliestOf(files.filter((f) => !(f.type || "").startsWith("video/")));
      const can = t != null && t >= TAKEN_FROM && t <= Date.now() / 1000 + TAKEN_AHEAD;
      return can ? { day: dayKey(t, tripTz()), taken_at: t } : { day: v };
    }

    const chosen = new Set();
    function renderTagPick() {
      const known = [...new Set([...allTags(), ...chosen])];
      tagPick.hidden = !known.length;
      tagPick.innerHTML = known.map((t) =>
        `<button class="chip" type="button" data-tag="${esc(t)}" aria-pressed="${chosen.has(t)}">${esc(t)}</button>`).join("");
    }
    tagPick.addEventListener("click", (e) => {
      const c = e.target.closest(".chip");
      if (!c) return;
      const t = c.dataset.tag;
      if (chosen.has(t)) chosen.delete(t); else chosen.add(t);
      renderTagPick();
    });
    function addFreeTag() {
      const t = normTag(tagIn.value);
      if (t) { chosen.add(t); tagIn.value = ""; renderTagPick(); }
    }
    tagAdd.addEventListener("click", addFreeTag);
    tagIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addFreeTag(); } });
    renderTagPick();

    function renderPicked() {
      pickBtn.hidden = picked.length > 0;
      pickedBox.hidden = !picked.length;
      pickedBox.innerHTML = picked.map((f, i) => {
        const video = (f.type || "").startsWith("video/");
        let u = "";
        if (!video) { u = URL.createObjectURL(f); urls.push(u); }
        return `<div class="me-pickrow" data-i="${i}">` +
          (video ? `<span class="me-pickico" aria-hidden="true">${ico("play")}</span>`
                 : `<img class="me-pickthumb" alt="" src="${u}">`) +
          `<button class="me-unpick" type="button" data-destroys aria-label="Remove ${esc(f.name)}">${ico("x")}</button>` +
        `</div>`;
      }).join("") +
      `<button class="me-pick-more" type="button" aria-label="Add more photos &amp; videos">${ico("plus")}</button>`;
      setDisabled(go, picked.length ? "" : "Choose photos or videos first");
      // Each row says its own size, so the button says only how many: with the total as well it took the head's
      // width at 390 and cut the sheet's title to "New me…".
      // Photos and videos together would be too long for the head beside the title ("Upload 98 photos and 2 videos" cut
      // "Add photos" at 440): those say "Upload all 100", and the full words are the button's name.
      const isVideo = (f) => (f.type || "").startsWith("video/"), videos = picked.filter(isVideo).length;
      const words = wordsFor(picked, isVideo);
      go.textContent = !picked.length ? "Upload" : videos && videos < picked.length ? `Upload all ${picked.length}` : `Upload ${words}`;
      if (picked.length) go.setAttribute("aria-label", `Upload ${words}`); else go.removeAttribute("aria-label");
    }
    pickedBox.addEventListener("click", (e) => {
      if (e.target.closest(".me-pick-more")) { input.click(); return; }
      const b = e.target.closest(".me-unpick");
      if (!b) return;
      picked.splice(Number(b.closest(".me-pickrow").dataset.i), 1);
      renderPicked();
      readWhen();
    });
    pickBtn.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      for (const f of input.files || []) picked.push(f);
      input.value = "";
      renderPicked();
      readWhen();
    });
    renderPicked();
    if (picked.length) readWhen();

    fab.setAttribute("data-aside", "");
    const sheet = openSheet({
      title: "Add photos",
      contentEl: body,
      footEl: foot,
      dragFrom: "handle",
      opaque: true,
      onClose: () => {
        fab.removeAttribute("data-aside");
        for (const u of urls) URL.revokeObjectURL(u);
      },
    });
    go.addEventListener("click", async () => {
      if (!picked.length || go.dataset.going) return;
      // Tapped while the photos' time is still being read: the post waits for it (a moment).
      go.dataset.going = "1";
      await readingP.catch(() => {});
      // More than one memory holds goes in as several posts, as even as they can be, in the order
      // picked; each its own job (one refused never holds up or loses the others), uploaded and
      // posted in turn.
      const parts = partsOf(picked);
      parts.forEach((files, i) => startUpload(files, capIn.value, [...chosen], whenOf(files), { n: i + 1, of: parts.length }));
      sheet.close();
      el.scrollTop = 0;
    });
  }

  // ── wiring, refresh, cleanup ────────────────────────────────────────────────────────────
  function repaintFaces() {
    if (unmounted) return;
    const tmp = document.createElement("div");
    for (const card of el.querySelectorAll(".me-card[data-id]")) {
      const mem = rows.get(card.dataset.id);
      if (!mem) continue;
      const oldFace = card.querySelector(".me-by > .ds-face");
      if (!oldFace) continue;
      const skin = authorSkin(mem);
      tmp.innerHTML = faceMarkup(skin);
      const nextFace = tmp.firstElementChild;
      if (nextFace) oldFace.replaceWith(nextFace);
      const whoEl = card.querySelector(".me-who");
      const label = skin.name || "Trip member";
      if (whoEl && whoEl.textContent !== label) whoEl.textContent = label;
      wakePictures(card);
    }
    if (viewerRoot && viewerRoot.isConnected && viewerMem) {
      const vwho = viewerRoot.querySelector(".me-vwho");
      const oldFace = vwho?.querySelector(":scope > .ds-face");
      if (vwho && oldFace) {
        const skin = authorSkin(viewerMem);
        tmp.innerHTML = faceMarkup(skin, "me-ava-sm");
        const nextFace = tmp.firstElementChild;
        if (nextFace) oldFace.replaceWith(nextFace);
        const nameEl = vwho.querySelector(":scope > span:last-child");
        const label = skin.name || "";
        if (nameEl && nameEl.textContent !== label) nameEl.textContent = label;
        wakePictures(vwho);
      }
    }
    for (const row of el.querySelectorAll(".mel-row[data-id]")) {
      const mem = rows.get(row.dataset.id);
      if (!mem) continue;
      const wrap = row.querySelector(".mel-whowrap");
      if (!wrap) continue;
      const skin = authorSkin(mem);
      const tone = personTone(skin.color);
      let dot = wrap.querySelector(":scope > .mel-pdot");
      if (tone) {
        if (!dot) {
          dot = document.createElement("span");
          dot.className = "mel-pdot";
          dot.setAttribute("aria-hidden", "true");
          wrap.prepend(dot);
        }
        dot.setAttribute("data-person", tone);
        dot.setAttribute("style", personVars(tone));
      } else if (dot) {
        dot.remove();
      }
      const whoEl = wrap.querySelector(":scope > .mel-who");
      const label = skin.name || "Trip member";
      if (whoEl && whoEl.textContent !== label) whoEl.textContent = label;
    }
  }
  const rerender = () => render();
  bus.add(rerender);
  let lastFaceSig = memberFaceSig();
  const offChange = store.on("change", () => {
    if (unmounted) return;
    const sig = memberFaceSig();
    if (sig === lastFaceSig) return;
    lastFaceSig = sig;
    repaintFaces();
  });
  // Only the offline->online EDGE pulls the feed. "status" also fires on every queue change,
  // and refetching the whole list because a packing tick flushed is the background-repaint
  // noise caused by background syncs on unchanged screens.
  let wasOnline = store.online();
  const offStatus = store.on("status", () => {
    const on = store.online();
    if (on && !wasOnline) refreshFeed();
    wasOnline = on;
  });

  render();
  refreshFeed();
  const beat = setInterval(() => {
    if (document.visibilityState === "visible" && store.online()) refreshFeed();
  }, REFRESH_MS);

  return () => {
    unmounted = true;
    bus.delete(rerender);
    offChange();
    offStatus();
    clearInterval(beat);
    io.disconnect();
    fab.remove();
    closeViewer();
    for (const { handle } of handles.values()) { try { handle.unmount(); } catch { /* gone */ } }
    handles.clear();
    el.classList.remove("ds", "me-root", "me-scape");        // the darker ground belongs to this tab only
    dropSaveSession(null);                  // primed originals are RAM; give it back
  };
}

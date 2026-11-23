// Hash router. Hash, not History API, for one reason: an installed PWA launched from the
// home screen with a dead radio must resolve every in-app URL from the service worker's
// cache of exactly one document. A path-based route is a separate navigation request that
// has to be intercepted correctly on every platform; "#/p/fonda" never leaves the page.
//
// ROUTE TABLE. Detail routes mount the SAME module as their list route, with ctx.route
// telling the module which face to show:
//
//   #/                  agenda    -> agenda.js    ctx.route "agenda"     tab root
//   #/e/:id             detail    -> agenda.js    ctx.route "event"      ctx.params.id
//   #/places            list      -> places.js    ctx.route "places"     tab root
//   #/p/:id             detail    -> places.js    ctx.route "place"      ctx.params.id
//   #/map               map       -> map.js       ctx.route "map"
//   #/pack              packing   -> packing.js   ctx.route "pack"       tab root
//   #/memories          memories  -> memories.js  ctx.route "memories"   tab root
//   #/split             split     -> split.js     ctx.route "split"      tab root
//   #/split/:id         purchase  -> split.js     ctx.route "purchase"   ctx.params.id
//   #/settings          settings  -> settings.js  ctx.route "settings"   tab root
//   #/settings/credits  credits   -> settings.js  ctx.route "credits"
//
// (The memories line was missing from this block until Split was wired in — the entry has
// been in ROUTES alongside the other tabs. This comment is the only prose record of the table, so a route
// that is not in it is a route nobody reading this file knows exists.)
//
// Route roots and back navigation:
//   - `settings` is a new tab root and `map` is no longer a tab. #/map still EXISTS as a
//     route — Places toggles list/map and the map needs somewhere to live — but it reports
//     tab "places", so the tab bar keeps Places lit while you are looking at the map. The
//     toggle is a navigation, which means the back button and the browser's own back gesture
//     both do the obvious thing from the map.
//   - the router keeps a REAL history stack (see below), because the universal back button
//     is specified as "previous page", not "up one level".
//
// Navigation polish — BEHAVIOUR ONLY. The module
// interface is untouched: `mount(el, ctx)` still receives #view itself and still returns an
// unmount function, and every view compiles against it unchanged.
//   - Navigations animate. Push slides the incoming view in from the right over the
//     outgoing one; pop reverses it; peer tabs crossfade. See "view transitions" below.
//   - Scroll restoration is keyed to the HISTORY ENTRY, not the route string, saved
//     synchronously at navigation-start and re-applied only on traversals.
//
// Layer and lifecycle additions to the router
// object; the module interface itself is still `mount(el, ctx) -> unmount`.
//   - `router.fixedLayer()` — a fixed layer OUTSIDE #view for view-owned fixed chrome. #view
//     is transformed during a transition AND is the scroller, so anything position:fixed
//     inside a view resolves against a box as tall as the page. That is the disappearing
//     composer bug. The layer is emptied at the start of every navigation.
//   - `router.keepState(fn)` / `router.takeState()` — per-history-entry state the VIEW
//     chooses, saved synchronously at navigation-start beside the scroll offset and handed
//     back only on a traversal. The agenda keeps its day strip's scrollLeft in it.
// Plus: the router's inline properties on #view are now stripped unconditionally — at the
// start of every navigation, on resume, and on transition finish — so an interrupted or
// never-finishing player cannot leave #view a containing block.
//
// Split routes — TWO ROWS IN THE TABLE BELOW AND NOTHING
// ELSE: no new ctx key, no new argument, no change to the bar, no change to this file's
// behaviour. Worth spelling out, because three of the four decisions behind those two rows
// are invisible from the rows themselves.
//   - SUPERSEDED, same day, by the tab registry in public/js/tabs.js. `tab:` below no longer
//     names a bar slot — it names a SECTION, and tabs.js's tabFor() decides which tab lights
//     up for it: that section's own tab if the person has it in the bar, otherwise "other".
//     So #/split reports "split" whether or not Split is currently a tab, and promoting or
//     demoting it is a change to one stored array and to nothing in this file. What follows
//     is kept because the measurement in it is still the reason the bar cannot grow.
//   - BOTH ROWS REPORTED tab "settings", exactly the way #/map reports tab "places". The tab
//     bar is full: measuring the five current labels at 320px leaves "Memories"
//     with 0.61px of slack, and `.tabbar` is grid-auto-columns:1fr — really minmax(auto,1fr)
//     — so a sixth tab does not overflow, it makes the columns UNEQUAL and the tap targets
//     stop matching. So Split ships as a quick link on the Settings screen, and reporting
//     "settings" is what keeps that tab lit while you are inside Split. Back needs no
//     special case: the fallback below already knows where tab "settings" goes.
//   - #/split IS root:true. It is a section ROOT, not a page you drilled into — which is why
//     it has no back button and why settings -> split crossfades like two peer tabs rather
//     than sliding like a push. It is also what makes the eventual promotion of Split into
//     the bar (reorder + promote/demote, deliberately NOT built here) a one-word
//     change to `tab:` and nothing else; a root:false route promoted into the bar would draw
//     a back button on a tab root. When that registry lands, TAB_ROOT gains
//     "split": "#/split" in the same edit — adding it today would be a key no route can
//     reach, because nothing reports a tab called "split".
//   - #/split/:id is for COLD ENTRY AND DEEP LINKS ONLY. In-app, tapping a purchase opens a
//     sheet without navigating — the packing model, where a drawer is never a history entry
//     and back never has to unwind one. `settle` is a reserved id (#/split/settle opens the
//     settle-up sheet over the feed); uid("pu") prefixes every real row "pu-" ("pu_" on older rows), so it cannot
//     collide, and split.js owns that decision the way memories.js owns RESERVED_IDS.
//
// Each module default-exports `mount(el, ctx)` and returns an unmount function (or nothing).
// ctx = { store, router, params, route }. mount may be async; the router awaits it.

import { store } from "./store.js";
import { RAIL } from "./tabs.js";

const ROUTES = [
  { re: /^\/?$/,                   name: "agenda",   tab: "agenda",   root: true,  mod: "./agenda.js",  keys: [], title: "Itinerary" },
  { re: /^\/e\/(.+)$/,             name: "event",    tab: "agenda",   root: false, mod: "./agenda.js",  keys: ["id"], title: "Event" },
  { re: /^\/places\/?$/,           name: "places",   tab: "places",   root: true,  mod: "./places.js",  keys: [], title: "Places" },
  { re: /^\/p\/(.+)$/,             name: "place",    tab: "places",   root: false, mod: "./places.js",  keys: ["id"], title: "Place" },
  { re: /^\/map\/?$/,              name: "map",      tab: "places",   root: false, mod: "./map.js",     keys: [], title: "Map" },
  { re: /^\/pack\/?$/,             name: "pack",     tab: "pack",     root: true,  mod: "./packing.js", keys: [], title: "Packing" },
  { re: /^\/memories\/?$/,        name: "memories", tab: "memories", root: true,  mod: "./memories.js",keys: [], title: "Photos" },
  // duck: false: the page's composer sits on the tab bar, and the newest lines are at its foot,
  // so a bar that left on the way down would move the one thing being typed into (tabs.js).
  { re: /^\/chat\/?$/,            name: "chat",     tab: "chat",     root: true,  mod: "./chat.js",    keys: [], title: "Chat", duck: false },
  // The assistant (model §20; assistant.js), beside the group chat under the same tab: the person's
  // own conversations (a tab of Chat's, so a root), and one of them (Back goes to the list). Each
  // has its box on the bar too: they don't duck either.
  { re: /^\/chat\/assistant\/?$/, name: "assistant", tab: "chat", root: true,  mod: "./assistant.js", keys: [], title: "Assistant", duck: false },
  { re: /^\/chat\/assistant\/(.+)$/, name: "conversation", tab: "chat", root: false, mod: "./assistant.js", keys: ["id"], title: "Conversation", duck: false },
  // Split. tab "settings" until a section registry exists — see the Split note above. The two
  // patterns cannot shadow each other in either order (`\/?$` cannot match "/split/pu-x",
  // and `(.+)` needs a character after the slash, so "/split/" falls through to the root),
  // but they are written root-first anyway to match the way every other pair here reads.
  { re: /^\/split\/?$/,           name: "split",    tab: "split",    root: true,   mod: "./split.js",   keys: [], title: "Split" },
  { re: /^\/split\/(.+)$/,        name: "purchase", tab: "split",    root: false, mod: "./split.js",   keys: ["id"], title: "Purchase" },
  { re: /^\/settings\/credits\/?$/,name: "credits",  tab: "other",    root: false, mod: "./settings.js",keys: [], title: "Image credits" },
  // What connected apps changed, with an undo: reached from Other, and Back goes there.
  { re: /^\/changes\/?$/,         name: "changes",  tab: "other",    root: false, mod: "./changes.js", keys: [], title: "Changes" },
  { re: /^\/settings\/?$/,         name: "settings", tab: "other",    root: true,   mod: "./settings.js",keys: [], title: "More" },
];

// Where back lands when there is genuinely nowhere to go back TO — a cold launch straight
// into #/e/:id from the home screen, or a shared link. Not "always agenda": arriving cold on
// a place detail and being thrown to the itinerary is disorienting.
// Keyed by SECTION id, and it must name every section a route can report — including the ones
// that are not currently in the bar, because "where does back go" is a question about the
// section you are in, not about where it happens to be displayed today.
const TAB_ROOT = {
  agenda: "#/", places: "#/places", pack: "#/pack", memories: "#/memories",
  split: "#/split", chat: "#/chat", other: "#/settings",
};

function parse(hash) {
  const path = (hash || "").replace(/^#/, "").split("?")[0] || "/";
  for (const r of ROUTES) {
    const m = r.re.exec(path);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { ...r, path, params };
  }
  return null;
}

// Module namespaces are cached by the browser's module map anyway; caching the promise as
// well means a rapid Agenda->Places->Agenda does not queue three separate import() jobs.
const mods = new Map();
const attempts = new Map();
function load(spec) {
  if (!mods.has(spec)) {
    // A FAILED dynamic import is memoised by the module map for the lifetime of the page:
    // importing the same specifier again returns the same rejection and never touches the
    // network. Without a distinct URL the Retry button is decoration — it re-imports, fails
    // instantly, and re-renders the same error. A query string makes a new module record,
    // and relative imports inside the module still resolve unqueried, so store.js stays a
    // singleton rather than being duplicated per retry.
    const n = attempts.get(spec) || 0;
    mods.set(spec, import(n ? `${spec}?r=${n}` : spec).catch((e) => {
      mods.delete(spec);
      attempts.set(spec, n + 1);
      throw e;
    }));
  }
  return mods.get(spec);
}

// ── two panes (the layouts, (b), 16 Nov) ───────────────────────────────────────────────
// From 1024 a section with a list and the pages it leads to is drawn as TWO PANES: the list on
// the left, kept mounted, and on the right the page the address names, or the list's own
// "rest" when the address is the list itself (the Itinerary's map, Places' map). The address
// says which, so back and a refresh land on the same two.
//
//   PAIRS[tab] = { list: the route that stands in pane A }; every other route of that tab that
//   is listed in `pages` opens in pane B.
//
// Pane A's module is mounted with ctx.two = true and ctx.pane = "a" and may return, instead of an
// unmount function, { unmount, rest(el) } where rest(el) draws pane B for the list's own address
// and returns that drawing's unmount. Pane B's module is mounted with ctx.pane = "b". Each pane
// is its own scroller (.rt-pane); #view itself does not scroll.
const WIDE = matchMedia("(min-width: 1024px)");
const PAIRS = {
  agenda: { list: "agenda", pages: ["event"] },
  places: { list: "places", pages: ["place"] },
};
function pairOf(route) {
  if (!route || !WIDE.matches) return null;
  const p = PAIRS[route.tab];
  if (!p || (route.name !== p.list && !p.pages.includes(route.name))) return null;
  return { key: route.tab, ...p };
}

let el = null;
let current = null;         // { path, route, unmount, two? }  two: { key, a, b, apiA, unmountB }
let showing = null;         // the route whose DOM is ON SCREEN right now — which is not the
                            // same thing as `current`: between "we decided to navigate" and
                            // "the module finished mounting", `current` is null but the old
                            // screen is still visible (in the transition layer). The
                            // transition needs the visible one; canGoBack() needs `current`.
let navToken = 0;
const onNav = new Set();

// ── scroll positions ─────────────────────────────────────────────────────────────────
// Keyed by HISTORY INDEX, never by route string. "#/places reached by tapping the tab" and
// "#/places reached by backing out of a place" are two different entries with two different
// reading positions in them; a path-keyed map hands the second one the first one's number,
// which is exactly the "back sometimes sets me to a different scroll" report.
const scrollPos = [];       // idx -> #view scrollTop for that history entry
let recording = true;       // false while a navigation is settling the scroller itself, so
                            // our own restore does not get recorded as the reader's position

// ── per-entry VIEW state ──────────────────────────────────────────────────────────────
// #view's scrollTop is not the whole reading position of every screen. The agenda's day
// strip is a second, HORIZONTAL scroller inside the view, and coming back from an event with
// it re-centred somewhere else is the same complaint as a lost vertical offset — "it
// re-animates over".
//
// So the router keeps a second slot per history entry, and the VIEW decides what goes in it:
// the module registers a snapshot function with keepState() and reads its own record back
// with takeState() while it mounts. Keyed by history index for exactly the reason scrollPos
// is — "#/ reached by tapping the tab" and "#/ reached by backing out of an event" are two
// entries with two different strip positions in them.
//
// takeState() answers null on a fresh push, so a screen nobody has been on before starts
// wherever its own logic says, never with a stranger's offset.
const viewState = [];       // idx -> whatever the view mounted at that entry chose to keep
let saveState = null;       // the CURRENT view's snapshot fn, or null
let pendingState = null;    // the record the view about to mount is entitled to read

/** Register the mounted view's state snapshot. Called synchronously at navigation-start,
 *  before anything else has touched the DOM. Returns an unregister fn for the unmount. */
function keepState(fn) {
  saveState = typeof fn === "function" ? fn : null;
  return () => { if (saveState === fn) saveState = null; };
}

/** The state saved for THIS history entry, once, or null when this is not a traversal. */
function takeState() {
  const s = pendingState;
  pendingState = null;
  return s;
}

// ── the history stack ──────────────────────────────────────────────────────────────────
// The back button is "previous page": agenda -> event -> place -> back lands on the EVENT,
// not on the agenda. That is what the browser's own history already means, so the job here
// is not to reimplement it — it is to know WHERE WE ARE IN IT, because a hash router is
// told "the hash changed" and never told which direction.
//
// Every entry we create is stamped with its index via replaceState. On hashchange:
//   - state carries an index  -> this is a traversal (back or forward) to an entry we made
//   - state is null           -> the browser just PUSHED a new entry, so it sits at idx + 1
// The second case is why the index is derived from the current one rather than from a
// counter: a push truncates forward history, so "one past where I was" is the only correct
// answer, and a monotonic counter would leave `back` pointing at an entry the browser has
// already discarded.
let idx = -1;
const stack = [];           // idx -> { path, name, tab, title }

/** Returns TRUE when this was a traversal (back/forward) to an entry we already made, and
 *  false when the browser just pushed a brand new one. The distinction is the whole basis of
 *  both the transition direction and the scroll restore. */
function stampIndex() {
  const st = history.state;
  if (st && typeof st.wgp === "number") { idx = st.wgp; return true; }
  idx = idx + 1;
  // A push truncates forward history. Drop the records that belonged to the entries the
  // browser just discarded, or a later back could restore a scroll offset — or name a back
  // destination — from a page that no longer exists in this session.
  if (stack.length > idx) stack.length = idx;
  if (scrollPos.length > idx) scrollPos.length = idx;
  if (viewState.length > idx) viewState.length = idx;
  try { history.replaceState({ wgp: idx }, "", location.hash || "#/"); }
  catch { /* a private-mode state quota failure must not stop navigation */ }
  return false;
}

function go(hash) { location.hash = hash.startsWith("#") ? hash : "#" + hash; }

function replace(hash) {
  const h = hash.startsWith("#") ? hash : "#" + hash;
  // Keep the index: replaceState makes no new entry, so inventing a new index here would
  // make `back` skip a page for the rest of the session.
  history.replaceState({ wgp: idx }, "", h);
  handle();
}

/** The entry back would land on, or null when there is none. */
function prevEntry() {
  return idx > 0 && stack[idx - 1] ? stack[idx - 1] : null;
}

/** Show the universal back button? Not on a tab root, and not with nothing behind us. */
function canGoBack() {
  return !!(current && !current.route.root && prevEntry());
}

function back() {
  if (prevEntry()) { history.back(); return; }
  // Nothing behind us: launched cold onto a detail screen. Fall back to the tab root the
  // screen belongs to, which is at least a place the tab bar agrees with.
  go(TAB_ROOT[(current && current.route.tab) || "agenda"] || "#/");
}

function onNavigate(fn) { onNav.add(fn); return () => onNav.delete(fn); }

const router = {
  go, replace, back, onNavigate, canGoBack,
  prev: prevEntry,
  current: () => (current ? current.path : "#/"),
  route: () => (current ? current.route : null),
  // A fixed layer OUTSIDE #view, and per-entry view state. See fixedLayer() and
  // keepState() below.
  fixedLayer,
  keepState,
  takeState,
};

// ── view transitions ─────────────────────────────────────────────────────────────────
// "Card -> detail animates. No instant flashes." Two layers: the incoming view is #view
// itself, and the outgoing one is a GHOST — a fixed-position box measured from the live
// #view, holding the outgoing view's real DOM nodes, parked at the scroll offset they were
// read at. Only transform and opacity are animated, so the whole thing composites and never
// touches layout.
//
// The nodes are MOVED, not cloned. A clone re-decodes every <img>, re-creates every canvas
// and loses every sticky header's stuck position — a visible flicker on precisely the frames
// the eye is following. The price is that the outgoing module stays mounted for the length
// of the animation (see finishAnim), which is deliberate and is what "keep the outgoing
// view's element alive until the animation ends" costs.
//
// TAB-TO-TAB IS NOT A SLIDE. Sliding implies a stack; peer tabs are alongside each other,
// not on top of each other, and the tab bar has already said where you went. They crossfade.

const SLIDE_MS = 220;
const FADE_MS = 120;
const UNDER_PCT = 30;   // how far the outgoing view slides under the incoming one
// Fast out of the gate, long settle — the platform's own push curve. A symmetric ease over
// the same 220ms reads as sluggish because the first 60ms are where "instant" is judged.
const EASE = "cubic-bezier(.32,.72,0,1)";

const REDUCE = matchMedia("(prefers-reduced-motion: reduce)");

// The inline properties the router owns on #view for the duration of a transition. Listed
// so they can be stripped again without touching anything a VIEW wrote on the same element
// (agenda.js sets el.style.scrollPaddingTop while it is mounted).
const RT_PROPS = ["transform", "opacity", "will-change", "background-color",
                  "pointer-events", "position", "z-index"];

let anim = null;    // { ghost, unmount, players[], timer } — the transition in flight

// ── the fixed layer ──────────────────────────────────────────────────────────────────
// A transformed OR `will-change: transform` element is the containing block for its
// position:fixed descendants. #view carries both for the length of a transition AND it is
// the scroll container, so a fixed row inside a view resolves against a box as tall as the
// whole page — which parks it hundreds of pixels below the viewport on a long screen. That
// causes the disappearing composer inside a scrolling view.
//
// Compensating for the 220ms window (the body[data-rt] rules) only ever papered over it: the
// bug was the compensation getting STUCK, and belt-and-braces cleanup (clearRT below) makes
// that far less likely without making it impossible. So the dependency is removed instead.
// This layer is a direct child of <body>, nothing ever transforms it, and a view that needs
// fixed chrome renders into it rather than into its own subtree:
//
//     const layer = ctx.router.fixedLayer();   // append your fixed row here
//
// The layer is emptied at the start of every navigation — fixed chrome belongs to the screen
// that put it there — and the view still removes its own node on unmount, because a DEFERRED
// unmount runs after the next screen has already parked its own row here.
const FIXED_ID = "rt-fixed";
let fixedEl = null;

/** The shell-owned fixed layer. Created on first use; never transformed by anything here. */
function fixedLayer() {
  if (fixedEl && fixedEl.isConnected) return fixedEl;
  fixedEl = document.getElementById(FIXED_ID);
  if (!fixedEl) {
    fixedEl = document.createElement("div");
    fixedEl.id = FIXED_ID;
    document.body.append(fixedEl);
  }
  watchFab(fixedEl);
  injectStyles();
  return fixedEl;
}

/* body[data-fab="1"] while the screen has a + in this layer: the page then leaves the +'s room at its
   foot (styles.css, --fab-room), so scrolled to the end the + never sits on the last card (the
   layouts, 16 Nov). Watched rather than set by each screen, so no screen can forget it. */
let fabWatched = null;
function watchFab(layer) {
  if (fabWatched === layer) return;
  fabWatched = layer;
  // Drawn, not merely present: from 768 the Itinerary's and Places' + are not drawn (their heads
  // hold a named add), and their pages keep no room for one.
  const mark = () => {
    const on = [...layer.querySelectorAll(".fab:not([hidden])")].some((f) => getComputedStyle(f).display !== "none");
    if ((document.body.dataset.fab === "1") !== on) document.body.dataset.fab = on ? "1" : "0";
  };
  new MutationObserver(mark).observe(layer, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  matchMedia(RAIL).addEventListener("change", mark);
  mark();
}

function clearFixed() { if (fixedEl) fixedEl.replaceChildren(); }

/** Take the router's inline properties back off #view, unconditionally and idempotently.
 *  Called on transition finish AND defensively at the start of every navigation AND on
 *  resume, because a WAAPI player does not advance while the document is hidden and a
 *  `finished` promise that never settles would otherwise leave #view a containing block —
 *  and `pointer-events: none` — for the rest of the session.
 *  data-rt survives while a transition is genuinely in flight: the ghost is still a
 *  containing block then, which the shell's own fixed chrome needs to know about. */
function clearRT() {
  if (!el) return;
  for (const p of RT_PROPS) el.style.removeProperty(p);
  if (!anim) document.body.removeAttribute("data-rt");
}

let stylesIn = false;
function injectStyles() {
  if (stylesIn || document.getElementById("rt-styles")) { stylesIn = true; return; }
  stylesIn = true;
  const s = document.createElement("style");
  s.id = "rt-styles";
  s.textContent = RT_CSS;
  document.head.append(s);
}

const RT_CSS = `
/* Injected from router.js rather than living in styles.css: the transition layer is the
   router's private business and styles.css belongs to the shell. Everything else about a
   ghost is set inline, because it is MEASURED off the live #view rather than declared —
   which is also what keeps it correct when the shell changes #view's padding. */
.rt-ghost::-webkit-scrollbar { width: 0; height: 0; }

/* THE FIXED LAYER. A direct child of <body>, so nothing this file animates is ever an
   ancestor of it and a fixed child of it always resolves against the viewport. It covers
   the screen only so that a child may position itself against any edge; it eats no taps,
   and its children take theirs back — the same pointer-events pair .dock uses in
   styles.css. z-index 8 is the dock's band, which is where the one tenant (the agenda's
   note composer, beside the Back button) belongs: over the scrolling view and the status
   strip, under the sheet (20) and the toast (30). */
#${FIXED_ID} { position: fixed; inset: 0; z-index: 8; pointer-events: none; }
#${FIXED_ID} > * { pointer-events: auto; }

/* A transformed element becomes the containing block for its position:fixed descendants.
   So for the ~220ms that #view (or a ghost of it) carries a transform, anything fixed
   inside a view resolves against THAT box instead of the viewport. The right answer is not
   to compensate but to move the element out of the view entirely — see fixedLayer() above,
   which is where the agenda's composer and both add buttons now live.
   THE COMPENSATION IS GONE, and with it the one place this file knew another module's class
   by name. packing.js's FAB was the last holdout inside #view; it now mounts into
   fixedLayer() like Memories' does, so there is no transform above it to compensate for. */
`;

/** Which animation, if any, gets us from the visible screen to `to`. */
function pickKind(from, to, isBack) {
  // Nothing on screen yet (cold start), or the user asked the OS for no motion: instant.
  if (!from || REDUCE.matches) return null;
  if (from.root && to.root) return "fade";      // peer tabs
  return isBack ? "pop" : "push";
}

/** Lift the visible view out of #view into its own layer, frozen where it was being read. */
function detach(y, unmount) {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const g = document.createElement("div");
  g.className = "rt-ghost";
  // It is a picture of a screen that no longer exists: no pointers, no tab stops, no
  // second copy of the whole agenda read out by VoiceOver.
  g.setAttribute("aria-hidden", "true");
  g.setAttribute("inert", "");
  g.style.cssText =
    "position:fixed;margin:0;box-sizing:border-box;pointer-events:none;" +
    "overflow:hidden;scrollbar-width:none;contain:paint;z-index:1;" +
    "background:var(--ground);" +   // #view is transparent (the ground is on <html>), and two
                                    // transparent layers stacked show each other through
    `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
    `padding:${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft};`;
  // HANDOVER. Inline properties a view wrote on #view while it was mounted (agenda.js sets
  // scrollPaddingTop) go WITH it onto the ghost, and come off #view. Detach is the moment
  // #view stops belonging to the outgoing view, and #view has to be clean for the incoming
  // one — otherwise finishAnim() cannot tell "the new view set this" from "the old view has
  // not cleaned up yet", and agenda -> places would end with the agenda's scroll padding
  // stuck on a Places screen.
  for (const p of [...el.style]) {
    if (RT_PROPS.includes(p)) continue;
    // Never let a view's leftover declaration overwrite the ghost's own geometry — the box
    // above is what makes the ghost look like the screen it is replacing.
    if (!g.style.getPropertyValue(p)) {
      g.style.setProperty(p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p));
    }
    el.style.removeProperty(p);
  }

  // Set BEFORE the ghost is in the document, not when the animation starts: `contain: paint`
  // makes the ghost a containing block for fixed descendants the instant it is attached, and
  // there can be a whole module import between here and the first animated frame. Measured:
  // without this the packing FAB sat 60px high for the first ~35ms of every Pack transition.
  document.body.dataset.rt = "1";
  g.append(...el.childNodes);
  document.body.append(g);
  // overflow:hidden still has a scrollport, so this is what keeps sticky day headers stuck
  // and puts the rows that were on screen back on screen.
  g.scrollTop = y;
  anim = { ghost: g, unmount, players: [], timer: 0 };
  return g;
}

/** Re-use the ghost already on screen instead of tearing it down and rebuilding an empty
 *  one. Happens when a second tap lands while the first navigation is still importing its
 *  module: #view is empty, so the screen the user is looking at IS the ghost. */
function adoptGhost() {
  const g = anim.ghost;
  for (const p of anim.players) { try { p.cancel(); } catch { /* already done */ } }
  anim.players = [];
  clearTimeout(anim.timer);
  anim.timer = 0;
  g.style.transform = "";
  g.style.opacity = "";
  return g;
}

/** Inline properties on #view that the INCOMING view owns — everything the router did not
 *  put there. detach() guarantees the outgoing view's are gone by now, so whatever is here
 *  was written after the handover and has to survive the outgoing module's late cleanup. */
function keepStyle() {
  const out = [];
  for (const p of el.style) {
    if (RT_PROPS.includes(p)) continue;
    out.push([p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]);
  }
  return out;
}

/** End the transition: run the deferred unmount, drop the ghost, hand #view back untouched.
 *  Safe to call at any point, including from the middle of a fresh navigation. */
function finishAnim() {
  const a = anim;
  if (!a) return;
  anim = null;
  clearTimeout(a.timer);
  for (const p of a.players) { try { p.cancel(); } catch { /* already done */ } }

  // The deferred unmount belongs to a view whose `el` is #view — which by now is hosting a
  // DIFFERENT view. agenda.js's cleanup resets el.style.scrollPaddingTop, so agenda -> event
  // -> back-to-agenda would have the OLD agenda's cleanup wipe the NEW agenda's scroll
  // padding and leave its sticky day strip overlapping every anchor jump. Snapshot what the
  // incoming view has on #view, run the cleanup, put back anything it cleared.
  const keep = keepStyle();
  try { a.unmount && a.unmount(); }
  catch (e) { console.error("[router] unmount threw", e); }
  for (const [p, v, pr] of keep) {
    if (!el.style.getPropertyValue(p)) el.style.setProperty(p, v, pr);
  }

  a.ghost.remove();
  // anim is already null, so this drops data-rt too. One spelling of "hand #view back".
  clearRT();
}

function startAnim(kind, ghost) {
  // The layer this was going to animate has already been torn down by a newer navigation.
  if (!anim || anim.ghost !== ghost) return;
  const ms = kind === "fade" ? FADE_MS : SLIDE_MS;
  const moving = kind === "fade" ? "opacity" : "transform";

  el.style.backgroundColor = "var(--ground)";
  el.style.willChange = moving;
  el.style.pointerEvents = "none";   // a tap mid-flight would land on coordinates that are
                                     // about to mean something else
  ghost.style.willChange = moving;

  let inFrames, outFrames = null;
  if (kind === "fade") {
    // A true cross-dissolve washes out, because both layers go semi-transparent and the
    // ground shows between them. Hold the outgoing screen opaque and bring the incoming one
    // up over it instead: same 120ms, no grey flash.
    el.style.position = "relative";
    el.style.zIndex = "2";
    inFrames = [{ opacity: 0 }, { opacity: 1 }];
  } else if (kind === "push") {
    el.style.position = "relative";
    el.style.zIndex = "2";           // incoming covers outgoing
    inFrames = [{ transform: "translate3d(100%,0,0)" }, { transform: "translate3d(0,0,0)" }];
    outFrames = [{ transform: "translate3d(0,0,0)" },
                 { transform: `translate3d(-${UNDER_PCT}%,0,0)` }];
  } else {
    // Pop: the ghost travels over the top. It is a positioned element and #view is not, so
    // it already paints above — no z-index needed, and #view keeps its normal stacking.
    inFrames = [{ transform: `translate3d(-${UNDER_PCT}%,0,0)` }, { transform: "translate3d(0,0,0)" }];
    outFrames = [{ transform: "translate3d(0,0,0)" }, { transform: "translate3d(100%,0,0)" }];
  }

  const opts = { duration: ms, easing: kind === "fade" ? "linear" : EASE, fill: "both" };
  const players = [el.animate(inFrames, opts)];
  if (outFrames) players.push(ghost.animate(outFrames, opts));
  anim.players = players;

  // FINISHED, OR A DEADLINE — whichever lands first, exactly the pattern motion.js uses for
  // its exit ghosts and for the same reason. `finished` is the right signal and it is not a
  // reliable one: WAAPI does not advance while the document is hidden, so a phone pocketed
  // mid-navigation can leave it unresolved for hours — with the outgoing module still
  // mounted, the ghost still on screen, and (the actual bug) #view still carrying
  // will-change:transform, which makes it the containing block for everything fixed inside
  // it. A cancelled player REJECTS, which is not an error here: a newer navigation cancels
  // these deliberately, and `done` no-ops because anim.ghost has moved on.
  const done = () => { if (anim && anim.ghost === ghost) finishAnim(); };
  Promise.all(players.map((p) => p.finished.then(() => {}, () => {}))).then(done);
  anim.timer = setTimeout(done, ms + 400);
}

async function handle() {
  const turn = turned;
  turned = false;
  const route = parse(location.hash);
  if (!route) { replace("#/"); return; }

  // SCROLL SAVE — first thing, synchronously, before any await and before anything else can
  // touch the scroller. One await later the incoming view may have scrolled #view; one frame
  // later a scroll event may have been overtaken by the browser's own restore. This number
  // is only true in this instant.
  const fromIdx = idx;
  if (current && fromIdx >= 0) {
    scrollPos[fromIdx] = current.two ? current.two.a.scrollTop : el.scrollTop;
    // The view's own reading position, in the same instant and for the same reason — the
    // agenda's day strip is a horizontal scroller the vertical number knows nothing about.
    if (saveState) {
      try { viewState[fromIdx] = saveState(); }
      catch (e) { console.error("[router] keepState threw", e); }
    }
  }

  // Index bookkeeping happens BEFORE the same-path early return, or a browser-back onto the
  // page you are already looking at would leave `idx` pointing at the entry you just left.
  const traversal = stampIndex();
  stack[idx] = { path: route.path, name: route.name, tab: route.tab, title: route.title };

  if (current && current.path === route.path) {
    // Same screen, new history position — re-tapping a tab, or #/e/x -> #/e/x?gap=1, where
    // the query is not part of the route and the view swaps its own face. Nothing mounts, so
    // nothing animates and nothing is restored: the module owns what happens to the scroller
    // on a face swap (agenda.js resets it to the top on purpose) and a restore fired over the
    // top of that would be the router overruling the view about the view's own content.
    for (const fn of onNav) { try { fn(route, router); } catch (e) { console.error(e); } }
    return;
  }

  // Within the same two panes: pane A stays as it is (its list, its scroll, its + in the fixed
  // layer); only pane B changes. No slide: nothing left the screen.
  const pair = pairOf(route);
  if (pair && current && current.two && current.two.key === pair.key) {
    const token = ++navToken;
    current.path = route.path;
    current.route = route;
    showing = route;
    el.dataset.route = route.name;
    for (const fn of onNav) { try { fn(route, router); } catch (e) { console.error(e); } }
    await paneB(route, pair, token);
    if (token !== navToken) return;
    for (const fn of onNav) { try { fn(route, router); } catch (e) { console.error(e); } }
    return;
  }

  // ── DEFENSIVE CLEANUP, BEFORE ANYTHING ELSE ────────────────────────────────────────
  // Placed after the same-path early return, because that is not a navigation — stripping
  // #view's transform there would snap a legitimately in-flight transition to its end.
  //
  // Everything below is idempotent and costs nothing in the normal case, where finishAnim()
  // has already run. It exists for the abnormal one: an interrupted navigation, a fast
  // double tap, a player that never resolved because the app was backgrounded. Residue is
  // not cosmetic — an inline will-change:transform left on #view makes it the containing
  // block for every fixed descendant, and #view is the scroller, so its box is the whole
  // page. That is the disappearing composer.
  clearRT();
  // Fixed chrome in the shell layer belongs to the screen that put it there.
  clearFixed();

  // Every await below is a chance for another tap to start a second navigation. A stale
  // one that finishes late would mount its view over the newer one; the token discards it.
  const token = ++navToken;

  // DIRECTION. Only the browser knows whether this was back or forward, and it says so by
  // whether the entry it landed on already carries an index of ours. A fresh push is neither:
  // it is a page that has never been seen, which is why it slides in from the right AND
  // starts at the top — there is no reading position to go back to.
  const isBack = traversal && idx < fromIdx;
  const restore = (traversal && idx !== fromIdx) || turn;
  const kind = pickKind(showing, route, isBack);

  let ghost = null;
  if (kind) {
    if (anim && !current && !el.firstChild) ghost = adoptGhost();
    else { finishAnim(); ghost = detach(scrollPos[fromIdx] || 0, current && current.unmount); }
  } else {
    finishAnim();
  }

  if (current) {
    // With a ghost the unmount is DEFERRED — it is recorded on `anim` and runs when the
    // animation ends. Calling it now would empty the ghost: packing.js's cleanup removes its
    // own root, so the outgoing screen would vanish on frame one and slide out as a blank.
    if (!ghost) {
      try { current.unmount && current.unmount(); }
      catch (e) { console.error("[router] unmount threw", e); }
    }
    current = null;
  }

  for (const fn of onNav) { try { fn(route, router); } catch (e) { console.error(e); } }

  if (pair) {
    await mountTwo(route, pair, token, restore, ghost, kind);
    return;
  }
  delete el.dataset.two;
  delete document.body.dataset.two;

  let mod;
  try {
    mod = await load(route.mod);
  } catch (e) {
    // A module that fails to load must not brick the whole app — the other three tabs are
    // still perfectly usable, and on this trip a usable Pack tab beats a white screen.
    if (token !== navToken) return;
    finishAnim();
    current = { path: route.path, route, unmount: null };
    showing = route;
    fail(route, e);
    return;
  }
  if (token !== navToken) return;

  el.replaceChildren();
  el.dataset.route = route.name;

  // What the view about to mount is allowed to read back, on the same terms as the scroll
  // restore below: only on a traversal to an entry we made, never on a fresh push. Read with
  // ctx.router.takeState() during mount; it answers once and then null.
  pendingState = restore ? (viewState[idx] || null) : null;

  let unmount;
  try {
    unmount = await mod.default(el, { store, router, params: route.params, route: route.name });
  } catch (e) {
    pendingState = null;
    if (token !== navToken) return;
    finishAnim();
    current = { path: route.path, route, unmount: null };
    showing = route;
    fail(route, e);
    return;
  }
  // A view that never asked for it does not get to hand its record to the NEXT one.
  pendingState = null;
  if (token !== navToken) { try { unmount && unmount(); } catch {} return; }

  current = { path: route.path, route, unmount: typeof unmount === "function" ? unmount : null };
  showing = route;

  // Re-announce now that `current` exists: canGoBack() reads current.route.root, so the
  // first pass above could only ever have answered for the PREVIOUS screen.
  for (const fn of onNav) { try { fn(route, router); } catch (e) { console.error(e); } }

  // ── SCROLL RESTORE ──────────────────────────────────────────────────────────────────
  // Only for traversals, and only when there is something to go back to. A page the user
  // has never been on starts at the top; `restore` is false for it because the browser gave
  // us an entry with no index of ours on it.
  //
  // y === 0 is treated as "nothing to restore" rather than "scroll to 0". They look the same
  // and behave very differently: agenda.js decides whether to jump to the live moment by
  // asking whether the router restored anything (el.scrollTop > 4), and re-asserting a zero
  // over the next three frames would drag it back off that jump.
  const y = restore ? (scrollPos[idx] || 0) : 0;
  if (y > 0) {
    // Suppress the recorder: the next few frames of scrollTop are OURS, and letting them be
    // filed as the reader's position is how a restore quietly overwrites what it restored.
    recording = false;
    el.scrollTop = y;
    // Immediately, because the content usually exists and laid out synchronously and a jump
    // one frame later is a jump the eye sees. Then again on the next two frames, because a
    // view that sets its own geometry in a rAF — the agenda's day strip, a list whose images
    // resolve late, the map's canvas — has not finished growing, and scrollTop silently
    // clamps to a scrollHeight that is still short.
    const settle = () => { if (Math.abs(el.scrollTop - y) > 1) el.scrollTop = y; };
    requestAnimationFrame(() => {
      if (token !== navToken) return;
      settle();
      requestAnimationFrame(() => {
        if (token !== navToken) return;
        settle();
        requestAnimationFrame(() => {
          if (token !== navToken) return;
          settle();
          recording = true;
          scrollPos[idx] = el.scrollTop;
        });
      });
    });
  }

  if (ghost) startAnim(kind, ghost);

  // Move focus to the new view so a screen reader announces the route change and so the
  // next swipe starts inside the new content instead of back at the header. preventScroll,
  // or focusing would fight the restore we just did.
  if (el.matches(":focus-within") === false) el.focus({ preventScroll: true });
}

// Mount a pair afresh: pane A's list, then pane B (the page, or the list's rest).
async function mountTwo(route, pair, token, restore, ghost, kind) {
  const listRoute = parse(TAB_ROOT[pair.key]);
  let modA;
  try { modA = await load(listRoute.mod); }
  catch (e) {
    if (token !== navToken) return;
    finishAnim();
    current = { path: route.path, route, unmount: null };
    showing = route;
    fail(route, e);
    return;
  }
  if (token !== navToken) return;
  el.replaceChildren();
  el.dataset.route = route.name;
  el.dataset.two = "1";
  document.body.dataset.two = "1";
  const a = document.createElement("section");
  a.className = "rt-pane rt-pane-a";
  // Pane B: a head of its own (the way out, "Close ×") over the page's scroller, which is what the
  // page mounts into; nothing floats over the page's words. The head is drawn only for a page,
  // not for the list's rest (the map).
  const side = document.createElement("section");
  side.className = "rt-side";
  const head = document.createElement("div");
  head.className = "rt-panehead";
  head.hidden = true;
  head.innerHTML = `<button type="button" class="rt-close" aria-label="Close, back to the list">` +
    `<span>Close</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
  const b = document.createElement("div");
  b.className = "rt-pane rt-pane-b";
  side.append(head, b);
  el.append(a, side);
  const close = () => {
    const prev = prevEntry();
    if (prev && prev.name === pair.list) history.back();
    else replace(TAB_ROOT[pair.key]);
  };
  head.querySelector(".rt-close").addEventListener("click", close);
  // Esc from inside the page closes it, when nothing of its own (a dialog) is open.
  side.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || head.hidden || document.querySelector(".sh-root")) return;
    e.preventDefault();
    close();
  });
  // The list's reading position, like #view's on a phone: recorded per history entry.
  a.addEventListener("scroll", () => {
    if (recording && idx >= 0 && current && current.two && current.two.a === a) scrollPos[idx] = a.scrollTop;
    noteMark();
  }, { passive: true });

  pendingState = restore ? (viewState[idx] || null) : null;
  let got;
  try {
    got = await modA.default(a, { store, router, params: listRoute.params, route: listRoute.name, two: true, pane: "a" });
  } catch (e) {
    pendingState = null;
    if (token !== navToken) return;
    finishAnim();
    current = { path: route.path, route, unmount: null };
    showing = route;
    fail(route, e);
    return;
  }
  pendingState = null;
  const apiA = got && typeof got === "object" ? got : { unmount: typeof got === "function" ? got : null };
  if (token !== navToken) { try { apiA.unmount && apiA.unmount(); } catch {} return; }

  const two = { key: pair.key, a, b, head, apiA, unmountB: null };
  current = {
    path: route.path, route, two,
    unmount: () => {
      try { two.unmountB && two.unmountB(); } catch (e) { console.error("[router] pane B unmount threw", e); }
      two.unmountB = null;
      try { apiA.unmount && apiA.unmount(); } catch (e) { console.error("[router] pane A unmount threw", e); }
    },
  };
  showing = route;
  for (const fn of onNav) { try { fn(route, router); } catch (e) { console.error(e); } }
  await paneB(route, pair, token);
  if (token !== navToken) return;
  for (const fn of onNav) { try { fn(route, router); } catch (e) { console.error(e); } }

  const y = restore ? (scrollPos[idx] || 0) : 0;
  if (y > 0) {
    recording = false;
    a.scrollTop = y;
    const settle = () => { if (Math.abs(a.scrollTop - y) > 1) a.scrollTop = y; };
    requestAnimationFrame(() => { settle(); requestAnimationFrame(() => { settle(); recording = true; scrollPos[idx] = a.scrollTop; }); });
  }
  if (ghost) startAnim(kind, ghost);
  if (el.matches(":focus-within") === false) el.focus({ preventScroll: true });
}

// Draw pane B for `route`: its own page, or, at the list's own address, the list's rest.
async function paneB(route, pair, token) {
  const two = current && current.two;
  if (!two) return;
  if (two.unmountB) { try { two.unmountB(); } catch (e) { console.error("[router] pane B unmount threw", e); } }
  two.unmountB = null;
  two.b.replaceChildren();
  two.b.scrollTop = 0;
  two.b.dataset.route = route.name;
  two.head.hidden = route.name === pair.list;
  if (route.name === pair.list) {
    two.b.dataset.rest = "1";
    if (typeof two.apiA.rest === "function") {
      try { const u = two.apiA.rest(two.b); two.unmountB = typeof u === "function" ? u : null; }
      catch (e) { console.error("[router] rest threw", e); }
    }
    return;
  }
  delete two.b.dataset.rest;
  let mod;
  try { mod = await load(route.mod); }
  catch (e) { if (token === navToken) paneFail(two.b, route, e); return; }
  if (token !== navToken || current.two !== two) return;
  try {
    // The reading position kept per history entry is the list's (pane A): pane B's page neither
    // keeps nor reads one, or it would take the list's place.
    const routerB = { ...router, keepState: () => () => {}, takeState: () => null };
    const u = await mod.default(two.b, { store, router: routerB, params: route.params, route: route.name, two: true, pane: "b" });
    if (token !== navToken || current.two !== two) { try { u && u(); } catch {} return; }
    two.unmountB = typeof u === "function" ? u : (u && typeof u.unmount === "function" ? u.unmount : null);
    // A page opened beside the list: focus goes to its heading, so a screen reader says where
    // you are and the next Tab starts on that page (the list keeps its place).
    // A page that draws itself again (agenda.js's plan page does, once its data is in) replaces
    // its heading, and focus on a removed node falls to <body>: until the person does anything
    // themselves (focus moved, a pointer down, a key that isn't on the heading), the heading drawn
    // in its place takes it back. A click on plain text in the list sends focus to <body> with no
    // focusin, and the list is then where the person is.
    const focusHead = () => {
      const h = two.b.querySelector("h1, h2");
      if (!h) return false;
      if (!h.hasAttribute("tabindex")) h.tabIndex = -1;
      h.focus({ preventScroll: true });
      return document.activeElement === h;
    };
    if (focusHead()) {
      let keep = true;
      const mo = new MutationObserver(() => {
        if (!keep) return;
        const a = document.activeElement;
        if (!a || a === document.body) focusHead();
      });
      mo.observe(two.b, { childList: true, subtree: true });
      const stop = () => {
        keep = false;
        mo.disconnect();
        document.removeEventListener("focusin", moved, true);
        document.removeEventListener("pointerdown", stop, true);
        document.removeEventListener("keydown", moved, true);
      };
      const moved = (e) => { if (!two.b.contains(e.target) || !/^H[12]$/.test(e.target.tagName)) stop(); };
      document.addEventListener("focusin", moved, true);
      document.addEventListener("pointerdown", stop, true);
      document.addEventListener("keydown", moved, true);
      const prev = two.unmountB;
      two.unmountB = () => { stop(); if (prev) prev(); };
    }
  } catch (e) { paneFail(two.b, route, e); }
}

function paneFail(box, route, err) {
  console.error("[router] pane mount failed", route.path, err);
  box.replaceChildren();
  const d = document.createElement("div");
  d.className = "empty err";
  d.innerHTML = `<h2 class="h3">This page didn't load</h2>`;
  box.append(d);
}

// Across 1024 the same address is drawn the other way: mount it again (a tablet turned).
// A list keeps the reader's place: the first row that starts in view comes back as far below the
// top as it was (widths differ, so a pixel offset would land somewhere else), with what the view
// keeps of its own (the Itinerary's day strip). A page keeps its place by its address; the list
// beside it then starts where its own rule puts it.
const isList = (route) => !!route && !!PAIRS[route.tab] && PAIRS[route.tab].list === route.name;
const ROW = "[data-k], a[href^='#/']";
function topRow(box) {
  const top = box.getBoundingClientRect().top;
  for (const n of box.querySelectorAll(ROW)) {
    const r = n.getBoundingClientRect();
    if (r.height > 0 && r.top >= top - 1) {
      const k = n.getAttribute("data-k");
      return { sel: k !== null ? `[data-k="${CSS.escape(k)}"]` : `a[href="${CSS.escape(n.getAttribute("href"))}"]`, off: r.top - top };
    }
  }
  return null;
}
function backTo(mark, at) {
  let n = 0;
  const step = () => {
    if (at !== idx || !current) return;
    const box = current.two ? current.two.a : el;
    const row = box.querySelector(mark.sel);
    if (row) box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - mark.off;
    // The router settles a restore over two frames; this lands after it, and again once more
    // in case the view laid itself out late (pictures, the day strip).
    if (++n < 4) requestAnimationFrame(step);
    else scrollPos[idx] = box.scrollTop;
  };
  requestAnimationFrame(step);
}
let turned = false;         // handle()'s next mount is the same entry drawn the other way
// The list's reading mark, kept as the person scrolls (once the scroll rests), and only while the
// page on screen is laid out the way the list was drawn: a turned tablet is laid out the new way
// before the browser says 1024 was crossed, and by then the old scroller reads 0.
let listMark = null;        // { idx, two, mark, y }
let markTimer = 0;
function noteMark() {
  clearTimeout(markTimer);
  markTimer = setTimeout(() => {
    if (!el || !current || idx < 0 || !isList(current.route) || WIDE.matches !== !!current.two) return;
    const box = current.two ? current.two.a : el;
    listMark = { idx, two: !!current.two, mark: topRow(box), y: box.scrollTop };
  }, 120);
}

WIDE.addEventListener("change", () => {
  if (!el || !current) return;
  const was = !!current.two, now = !!pairOf(current.route);
  if (was === now) return;
  clearTimeout(markTimer);
  const list = isList(current.route) && idx >= 0;
  const box = current.two ? current.two.a : el;
  const kept = listMark && listMark.idx === idx && listMark.two === was ? listMark : null;
  const mark = !list ? null : kept ? kept.mark : box.scrollTop > 0 ? topRow(box) : null;
  if (list) {
    scrollPos[idx] = kept ? kept.y : box.scrollTop;
    if (saveState) {
      try { viewState[idx] = saveState(); }
      catch (e) { console.error("[router] keepState threw", e); }
    }
    turned = true;
  }
  const at = idx;
  finishAnim();
  try { current.unmount && current.unmount(); } catch (e) { console.error(e); }
  current = null;
  showing = null;
  clearFixed();
  handle().then(() => { if (mark) backTo(mark, at); });
});

function fail(route, err) {
  console.error("[router] mount failed", route.path, err);
  el.replaceChildren();
  delete el.dataset.two;
  delete document.body.dataset.two;
  el.dataset.route = "error";
  const box = document.createElement("div");
  box.className = "empty err";
  box.innerHTML =
    `<h2 class="h3">This screen didn't load</h2>`;
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = "Retry";
  // showing = null as well as current: retrying the SAME screen is not a navigation, and
  // sliding the error card off to the left to reveal the page it failed to be is a lie about
  // what just happened.
  btn.addEventListener("click", () => { current = null; showing = null; handle(); });
  box.append(btn);
  const detail = document.createElement("pre");
  detail.className = "err-detail";
  detail.textContent = String((err && err.message) || err);
  box.append(detail);
  el.append(box);
  for (const fn of onNav) { try { fn(route, router); } catch (e) { console.error(e); } }
}

export function start(viewEl) {
  el = viewEl;
  injectStyles();
  // Created up front rather than on first use: it is a sibling of #view in the shell's
  // stacking order, and creating it later would insert it after whatever a view has already
  // appended to <body>.
  fixedLayer();
  if (!location.hash) history.replaceState(null, "", "#/");

  // The browser restores scroll offsets on a history traversal all by itself, including for
  // scrollable ELEMENTS like #view, and it restores whatever it last sampled — which is not
  // where the reader was, and which lands after our own restore. Two restorers disagreeing is
  // precisely "back sometimes sets me to a different scroll than I was before". We own it.
  try { history.scrollRestoration = "manual"; } catch { /* not settable in some engines */ }

  // The reading position of the CURRENT entry, kept live. The save at navigation-start is the
  // authority, but it can only read #view after the fact; this has the value from before
  // anything else got a chance to move it.
  el.addEventListener("scroll", () => {
    if (recording && idx >= 0) scrollPos[idx] = el.scrollTop;
    noteMark();
  }, { passive: true });

  addEventListener("hashchange", handle);
  // iOS restores a PWA's scroll position on resume by scrolling the document, which does
  // nothing useful when the scroller is #view. Re-pin it ourselves.
  addEventListener("pageshow", () => {
    if (current && idx >= 0) el.scrollTop = scrollPos[idx] || el.scrollTop;
  });

  // THE RESUME BELT. A WAAPI player does not advance while the
  // document is hidden, and an installed PWA is backgrounded by a lock button in the middle
  // of a transition all day long. `finished` may never have settled and the deadline timer
  // may itself have been frozen, so a transition can be hours stale by the time anyone looks
  // at the screen again. Landing it here is not a lost animation — the animation happened
  // while nobody was watching — it is the guarantee that #view is never left transformed.
  addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    finishAnim();
    clearRT();
  });
  handle();
  return router;
}

export { router, parse, ROUTES };
export default router;

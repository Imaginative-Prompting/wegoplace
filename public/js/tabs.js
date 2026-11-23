// The tab bar, as data.
//
// THE SECTIONS ARE DECLARED HERE, ONCE: each one's label, address and symbol, and whether it is
// on the bar. Adding a section later is a row in SECTIONS plus a route in router.js.
//
// THE BAR IS THE SAME FIVE FOR EVERYONE: Itinerary, Places, Split, Photos, Chat. More is not a tab:
// it is your own picture at the top right of every main screen (index.html's .head-more), and it
// holds every section that isn't on the bar (Packing, Changes, People) and the trip's settings.
// Five sit in the pill evenly, each with its name; the tab you are on has a highlight that slides
// to it (public/ds/shell.css). From 768 the bar is a rail beside the page, and on a phone on its
// side (landscape, no taller than 420) whatever its width: RAIL below.
//
// THE STATIC BAR IN index.html IS THE BAR, AND IT STAYS. index.html paints before any module
// runs, so a bar rendered purely from JS would flash empty on every cold launch, including the
// offline home-screen launch this whole app is built for. paintBar() below leaves it alone when
// it already matches.


/**
 * Where the bar is a rail beside the page, not a pill at its foot: from 768 wide, and on any screen on its side no
 * taller than 420 (a phone held sideways: at 667 x 375 a pill took 72 of the 375 px, and a place's card and the map
 * above it hadn't the room they need). From 480 wide: every phone on its side is wider (the smallest, 568), every
 * phone upright narrower, so an upright phone whose keys shrink its page in a browser tab (390 x 377) keeps the pill.
 * styles.css writes the same query in each of its "from 768" rules; the scripts that follow the layout (the bar's
 * reading order, the named adds, a sheet as a dialog) read this one.
 */
export const RAIL = "(min-width: 768px), (orientation: landscape) and (max-height: 420px) and (min-width: 480px)";

// Icons are inline SVG source rather than nodes: the bar is rebuilt by assigning innerHTML,
// and every one of these is lifted verbatim from the markup it replaces so nothing about the
// shipped bar changes shape on the day this file starts driving it.
const ICONS = {
  agenda: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  // A pin, not a map: the map is a mode inside Places.
  places: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/>',
  // A bag with a tick, not the plain backpack: icons.js gives outdoor-gear shops a backpack,
  // and two different meanings must not share one shape.
  pack: '<path d="M4.5 8.5h15v10a2.5 2.5 0 0 1-2.5 2.5H7a2.5 2.5 0 0 1-2.5-2.5v-10Z"/>'
      + '<path d="M8.8 8.5V6.2a3.2 3.2 0 0 1 6.4 0v2.3"/><path d="m9 14.4 2.1 2.1 4-4.2"/>',
  // A frame with a horizon and a sun — no other glyph in the app is a rectangle with an
  // interior diagonal, so it reads at 22px without the hue.
  memories: '<rect x="3" y="5" width="18" height="15" rx="2.5"/><circle cx="9" cy="10.2" r="1.7"/>'
          + '<path d="m3.6 17.4 4.8-4.6 3.4 3.2 3.8-4 4.6 4.8"/>',
  // ONE PATH FORKING INTO TWO, with arrowheads. Not a banknote and not a pie: this app already
  // spends a currency symbol on money in a dozen places, and a glyph that means "divided
  // between people" has to be about the dividing. Nothing else in the bar has a fork in it.
  split: '<path d="M12 20V13"/><path d="M12 13 6.5 7.5"/><path d="M12 13 17.5 7.5"/>'
       + '<path d="M6.5 11.4V7.5h3.9"/><path d="M17.5 11.4V7.5h-3.9"/>',
  // A speech bubble with three lines of talk: nothing else in the bar is a rounded box with a tail.
  chat: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V17h0A2.5 2.5 0 0 1 4 14.5v-8Z"/>'
      + '<path d="M8 8.8h8M8 12.2h5"/>',
  // THREE DOTS, NOT THE GEAR. The gear used to mean "settings" and would now have to mean
  // "settings and everything else", which is two things in one glyph. An ellipsis is the one
  // shape that already means "more" to everybody, and it collides with nothing else in the bar
  // — no other tab icon is a row of filled circles.
  other: '<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>'
       + '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>'
       + '<circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
};

/**
 * Every section that can appear in the bar or in More's quick links.
 *
 * THE MAP IS NOT IN HERE, and that is deliberate. It has a route (#/map) and it reports tab
 * "places", but the ruling is that this makes it a RENDERING of Places rather than a
 * section of its own: it is part of Places, even though the code counts it a separate tab.
 * It is another rendering of the Places tab, so it always stays under
 * Places and is not in the sections menu in Settings at all. A section is something you
 * could put in the tab bar. The map cannot be, so it is not one, and it does not appear in
 * More's list either — you reach it from the toggle inside Places, which is where it lives.
 */
export const SECTIONS = [
  { id: "agenda",   label: "Itinerary", href: "#/",         bar: true,  pinned: true,
    blurb: "The itinerary, day by day" },
  { id: "places",   label: "Places",   href: "#/places",   bar: true,  pinned: false,
    blurb: "Everywhere worth going" },
  { id: "pack",     label: "Packing",  href: "#/pack",     bar: true,  pinned: false,
    blurb: "What goes in the bag" },
  { id: "memories", label: "Photos",   href: "#/memories", bar: true,  pinned: false,
    blurb: "Photos and video from the trip" },
  { id: "split",    label: "Split",    href: "#/split",    bar: true,  pinned: false,
    blurb: "Purchases, and who owes who" },
  { id: "chat",     label: "Chat",     href: "#/chat",     bar: true,  pinned: false,
    blurb: "The trip's group chat" },
  // Not a tab (bar: false): the list of what connected apps changed, with an undo. It lives
  // behind More, where the rest of the trip's housekeeping is (changes.js).
  { id: "changes",  label: "Changes",  href: "#/changes",  bar: false, pinned: false,
    blurb: "What connected apps changed, with an undo" },
  // `last: true` — not merely pinned, but pinned to the RIGHT-HAND END: Other
  // is always the furthest right. It is the drawer the rest of the app spills into, and a
  // drawer in the middle of the shelf reads as a peer of the things it contains.
  // Not a tab: your picture at the top right of a screen is the way in (index.html, .head-more).
  { id: "other",    label: "More",     href: "#/settings", bar: false, pinned: true, last: true,
    blurb: "Settings, and everything not in the bar" },
];

const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));
export const section = (id) => BY_ID.get(id) || null;

/**
 * THE BAR: the same five for everyone, in this order (index.html's markup). No editor: a layout
 * somebody stored with the old one stays where it is, unread.
 */
export const DEFAULT_LAYOUT = ["agenda", "places", "split", "memories", "chat"];

/** The bar, for everyone. A function still: every reader of the bar asks it. */
export function layout() {
  return DEFAULT_LAYOUT.slice();
}

/** Sections NOT in the bar, in registry order — what More's quick links show. */
export function quickLinks(lay = layout()) {
  return SECTIONS.filter((s) => s.id !== "other" && !lay.includes(s.id));
}

/**
 * Which tab lights up for a route, or none.
 *
 * Routes report a SECTION id, not a bar position: #/split reports "split". A section on the bar
 * lights its tab. One that isn't (Packing, Changes, More's own screens) lights no tab: it was
 * reached from your picture, which shows as current instead (index.html, paintTabs).
 */
export function tabFor(sectionId, lay = layout()) {
  return lay.includes(sectionId) ? sectionId : null;
}

/**
 * Your picture's accessible name: "More", and what its dot stands for (new changes, changes-dot.js).
 */
export function labelOther() {
  const more = document.querySelector(".head-more");
  if (!more) return;
  const fresh = document.documentElement.hasAttribute("data-changes-new");
  more.toggleAttribute("data-new", fresh);
  more.setAttribute("aria-label", fresh ? "More, new changes" : "More");
}

/**
 * Where your picture stands in a screen's head: the five main screens (Places with its map) and More. One level
 * deeper (a plan, a place, a purchase, the assistant, the pages under More) the head's top right is that page's own,
 * so the picture is away there (data-away; the stylesheet takes it out of a phone's head, the rail keeps it).
 */
const MORE_ON = new Set(["agenda", "places", "map", "split", "memories", "chat", "settings"]);
export function placeMoreFor(route) {
  const more = document.querySelector(".head-more");
  if (!more || !route) return;
  // Places opened from a stretch of free time ("Near …", ?near=) is that stretch's page: its head is its own too.
  const fromAGap = route.name === "places" && /[?&]near=/.test(location.hash);
  more.toggleAttribute("data-away", !MORE_ON.has(route.name) || fromAGap);
}

/**
 * Lights the tab for a section and slides the highlight to it (public/ds/shell.css, --ds-i); a
 * section not on the bar lights none and the highlight fades.
 */
export function lightTab(nav, id) {
  const tabs = [...nav.querySelectorAll(".tab")];
  const i = tabs.findIndex((a) => a.dataset.tab === id);
  tabs.forEach((a, k) => { if (k === i) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  nav.toggleAttribute("data-none", i < 0);
  if (i >= 0) nav.style.setProperty("--ds-i", String(i));
  return i;
}

const tabHtml = (s) =>
  `<a class="tab ds-tab" href="${s.href}" data-tab="${s.id}">`
  + `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[s.id] || ""}</svg>`
  + `<span>${s.label}</span><span class="ds-tab-dot"></span></a>`;

/**
 * Draw the bar, but only if it is not already right.
 *
 * The early return is the point, not an optimisation: on the overwhelmingly common path the
 * stored layout IS the default, the markup already says so, and this function must leave the
 * DOM index.html painted completely alone. Rewriting it with identical HTML would still drop
 * and rebuild five nodes on every boot, which throws away the tab the browser has already
 * painted and costs a flash on exactly the cold offline launch that matters most.
 */
export function paintBar(nav, lay = layout()) {
  if (!nav) return false;
  const now = [...nav.querySelectorAll(".tab")].map((a) => a.dataset.tab);
  if (now.length === lay.length && now.every((id, i) => id === lay[i])) return false;
  // The rail's own parts (index.html: the logo and the trip before the tabs, what More lists after them) stay as
  // they are, in their places.
  const keep = [...nav.querySelectorAll(":scope > [data-rail-keep]")];
  const first = nav.querySelector(":scope > .tab");
  const before = keep.filter((k) => first && k.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING);
  const after = keep.filter((k) => !before.includes(k));
  nav.innerHTML = '<span class="ds-tab-hl"></span>' + lay.map((id) => BY_ID.get(id)).filter(Boolean).map(tabHtml).join("");
  nav.prepend(...before);
  nav.append(...after);
  return true;
}

/**
 * THE BAR DUCKS ON THE WAY DOWN A PAGE AND COMES BACK WHEN YOU TURN AROUND.
 *
 * Going down a long page is reading, and the bar is 60px of a phone that reading could have.
 * Turning back up, by a finger's width, is looking for the way out, so the bar is there
 * before the thumb reaches for it. This function only says which of the two it is, as
 * body[data-tabs="away"|"here"]; what leaves, how, and on which screens is the stylesheet's
 * (styles.css, "the bar ducks"), and a screen too large to need it is left alone there.
 *
 * WHAT COUNTS AS TRAVEL. The distance from where the direction last turned, never the
 * distance between two scroll events (a slow drag is a hundred events of one pixel):
 *   - DOWN px downward takes the bar away; UP px upward brings it back.
 *   - The top of the page always has the bar.
 *   - A rubber band past either end is not travel: the position is clamped to the page first,
 *     so the bounce back from the bottom doesn't read as turning around.
 *   - The bar floats over the page, so its leaving resizes nothing and moves nothing.
 *   - Only a long page: one with more than half a screen to scroll. On a shorter one the
 *     bar would leave to show the room the page keeps for it.
 *   - A page arriving has the bar, and its first moments move nothing: the router puts a page
 *     back where it was read, and that is the router scrolling, not the person.
 *   - A route may say `duck: false` (router.js): a page with a composer at its foot keeps its
 *     foot where it is.
 *   - Focus arriving in the bar brings it back: a keyboard or a screen reader reaches a bar
 *     that is on the screen.
 *
 * Returns { here(), route(route) }: here() brings the bar back now; route() is for the
 * router's onNavigate.
 */
/**
 * THE BAR IN READING ORDER. On a phone the bar floats at the foot and is read after the page; from
 * 768 it is a rail or a sidebar at the left, and a keyboard or a screen reader meets it first, as
 * the eye does. So from 768 the <nav> stands before #view in the document (the stylesheet lays the
 * two out either way round, body[data-bar="first"]), and under 768 after it again. Focus inside
 * the bar stays where it is: moving a node keeps it focused in every engine this app runs in.
 */
export function barInReadingOrder(view, nav, body = document.body) {
  const mq = matchMedia(RAIL);
  // Where index.html put it (after the dock and the sync line): under 768 it goes back exactly there,
  // so a phone's document, its paint order and its Tab order are what they always were.
  const home = nav.nextSibling;
  const place = () => {
    if (mq.matches) { if (nav.nextElementSibling !== view) view.before(nav); body.dataset.bar = "first"; }
    else { if (nav.nextSibling !== home && home && home.parentNode) home.before(nav); delete body.dataset.bar; }
  };
  place();
  mq.addEventListener("change", place);
}

export function duckOnScroll(view, nav, body = document.body) {
  const DOWN = 32, UP = 6, QUIET_MS = 450;
  let anchor = 0, quietUntil = 0, allowed = true;
  const isAway = () => body.dataset.tabs === "away";
  const set = (value) => { if ((body.dataset.tabs || "here") !== value) body.dataset.tabs = value; };
  const here = () => { set("here"); anchor = Math.max(0, view.scrollTop); };
  view.addEventListener("scroll", () => {
    const max = Math.max(0, view.scrollHeight - view.clientHeight);
    const y = Math.min(Math.max(view.scrollTop, 0), max);
    if (!allowed || performance.now() < quietUntil) { anchor = y; return; }
    if (y <= 0) { here(); return; }
    // AT THE END OF THE LIST THE BAR IS BACK (20 Nov: on a phone the Itinerary scrolled far past its last row, into empty
    // space). The page keeps room at its foot for the bar; with the bar away that room was a band of nothing
    // under the last row. At the end the bar comes back into it, as a phone's own toolbars do at the end of a page.
    if (max > 0 && y >= max - 2) { here(); return; }
    if (isAway()) {
      if (y > anchor) anchor = y;                       // still going down: a turn is measured from the lowest point
      else if (anchor - y >= UP) here();
    } else if (y < anchor) {
      anchor = y;                                       // going up with the bar here: the next way down starts from here
    } else if (y - anchor >= DOWN && max > view.clientHeight / 2) {
      set("away"); anchor = y;
    }
  }, { passive: true });
  nav.addEventListener("focusin", here);
  // Only the pill's rules read "away". Sent away in one layout and turned into the other (the rail on its side, then
  // upright), the pill would come back away until a scroll up: a change of layout brings it back.
  matchMedia(RAIL).addEventListener("change", here);
  return {
    here,
    route(route) {
      allowed = !route || route.duck !== false;
      quietUntil = performance.now() + QUIET_MS;
      here();
    },
  };
}

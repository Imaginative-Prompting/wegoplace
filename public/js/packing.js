// packing.js — #/pack. ONE set of things, seen through the trip's lists.
//
// The model, stated as the thing the screen has to make obvious:
//
//   item       the thing itself: label, quantity, note, category, owner (a person, or the
//              group).
//   list       a packing list of the TRIP: "Leaving home", "The trek", "A day out". Either
//              packed once, or packed for the day (its ticks belong to a day, so every day
//              starts unticked).
//   bag        stored, never shown (25 Nov 2026: lists and checkboxes, nothing more). A thing is
//              ON a list by having a bag there; a new thing goes in the list's first bag, and a
//              list made here gets one bag of its own (NEW_LIST_BAG). Bags made before stay as
//              they were, read and kept.
//   placement  (item, list) -> bag. One per list. ABSENT IS MEANINGFUL: an item with no bag
//              on a list is not on it. "The laptop stays in storage during the trek" is a
//              missing placement, and this screen gives it a visible home ("Not on this
//              list") rather than letting it fall out of sight.
//   tick       (item, list[, day]). Packed for "Leaving home" says nothing about "The
//              trek": a second list exists because the same things get packed again.
//
// Lists and bags belong to the trip, not to a person. Everyone sees the same lists; what
// differs is whose items are being looked at (yours, or the group's). So a rename in the Bags
// sheet is a rename on every phone, and the sheet says so.
//
// THE ONE THING THIS SCREEN MUST NOT READ AS. Two lists over one set of items look exactly
// like two duplicate lists unless the UI says otherwise on every frame. Three devices carry
// that message, and none of them is a tooltip:
//   1. the things not on the list being looked at are under it ("Not on this list"), the same
//      things on every list;
//   2. the lists button on each row opens one sheet showing EVERY list at once (on it, or
//      not), so the moment somebody wonders "is this the same jacket?" the answer is on screen
//      and editable.
//
// MOVING AN ITEM IS A PLACEMENT WRITE, NEVER AN ITEM WRITE, and a tick is its own write too.
// store.setPacking() is for label, quantity, note and category only. Nothing on the move path
// can damage the label or the tick.
//
// WHY ITEMS ARE NOT DRAGGED, AND LISTS ARE. On a 390px phone a list is ~90 rows: a thing goes
// on or off a list by its row's lists button (or a long press on the row) and one tap in the
// sheet. Two taps whatever the list length, it never fights the scroller, and it can say "not
// on this list", which no drop target can.
//
// The list rows in the Lists sheet are the opposite case: three to six rows, all of them on
// screen at once, one short axis. Drag is the right gesture there. The grip is on the
// LEFT and the delete on the RIGHT, the drag starts on the grip with no long-press, and the
// rows it displaces FLIP out of the way.
//
// PERMISSION, settled in three places that must move together:
//   store.js (packMine, setPacking) · the server's mayTouch() · canTick() below.
// Ticking and moving a row on the GROUP list is open to everyone who can see it: four people
// pack one duffel, and whoever ticks "4-person tent" is almost never whoever typed it.
// Renaming and deleting stay with the author. A person's own list is theirs alone.
//
// DATA. store.js is the only way this module touches anything: the items, the trip's lists
// and bags, the placements and the ticks all arrive in the trip's snapshot and all are
// written through the store's one queue, so a tick made with no signal waits in the same
// place as a purchase and is sent in the order it was made.


import { store } from "./store.js";
import { tripIdFromPath, tripKey } from "./trip-here.js";
import { bagKeyOn } from "./pack-count.js";
import { esc, fmtDay, uid } from "./util.js";
import { PACKING_NAME_MAX } from "./shared/limits.js";
import { toast } from "./toast.js";
import { getIcon } from "./icons.js";
// Panels on this screen use the shared bottom sheet rather than fixed elements pinned
// to bottom:0 — which on iOS is the LAYOUT viewport, behind the keyboard, causing the
// popover to push the text field off screen. The
// shell's sheet measures visualViewport and rides above the keys, and brings the grab handle
// and swipe-down dismissal with it. Aliased because this file already had an openSheet().
import { openSheet as openBottomSheet } from "./sheet.js";
// Packing transitions. flip() regroups the keyed rows across a DOM rebuild,
// drawCheck() draws the tick's stroke, ms() reads the duration tokens so 220/320 stay written
// down in exactly one place (styles.css). Everything is dead under prefers-reduced-motion:
// flip and drawCheck enforce that themselves, and the two effects added in this file (the
// meter spring, the move lift) check reducedMotion() before playing a frame.
import { flip, drawCheck, reducedMotion, ms } from "./motion.js";

const GROUP = "group";

// ════════════════════════════════════════════════════════════════════════════════════════
// CATEGORIES — the sub-grouping inside a bag
// ════════════════════════════════════════════════════════════════════════════════════════
// Fixed set, and the order below is the order they render in. It is the API's own order, so
// there is one canonical sequence rather than a display order that drifts from the wire.
// Anything outside it is a 400 {error:'bad category'}, so catOf() clamps rather than trusting.
//
// COLOUR IS NOT USED HERE AT ALL. Seven hues do not survive dichromacy — styles.css says so
// about the place categories and measures it — so a category sub-header carries a glyph AND
// the word, and nothing about a category is expressed as a tint.
const CATEGORIES = ["clothes", "documents", "electronics", "toiletries", "gear", "meds", "misc"];
const CAT_LABEL = {
  clothes: "Clothes", documents: "Documents", electronics: "Electronics",
  toiletries: "Toiletries", gear: "Gear", meds: "Meds", misc: "Misc",
};
const CAT_RANK = new Map(CATEGORIES.map((c, i) => [c, i]));
const catOf = (r) => (CAT_RANK.has(r.category) ? r.category : "misc");

// Four of the seven have an honest glyph in icons.js already and are imported rather than
// redrawn — a cross means medical and a backpack means gear on every screen of this app, and
// two hands drawing the same idea is how an icon set starts to look homemade. The other three
// have no equivalent there (icons.js maps PLACE subkinds; a travel-places set has no shirt,
// no plug and no passport), so they are drawn here to match: 24-unit box, no fill, stroke
// inherited from the shared `.ico` rule in styles.css.
const CAT_LOCAL = {
  clothes:
    '<path d="M8.6 3.4 12 6.2l3.4-2.8 5 2.6-1.9 4.6-2.1-.8v11.2H7.6V9.6l-2.1.8L3.6 6 8.6 3.4Z"/>',
  documents:
    '<path d="M6 2.8h7.4L18.6 8v13.2H6V2.8Z"/><path d="M13.4 2.8V8h5.2"/><path d="M8.8 12.4h6.4M8.8 16h6.4"/>',
  misc:
    '<path d="M12 2.8 21 7.4v9.2L12 21.2 3 16.6V7.4L12 2.8Z"/><path d="m3 7.4 9 4.6 9-4.6M12 12v9.2"/>',
};
// (kind, subkind) pairs that resolve through icons.js's own SUB table — named subkinds, never
// its kind fallback, so a change to the fallback map cannot silently repoint one of these.
const CAT_ICONS = {
  electronics: ["practical", "sim_card"],
  toiletries: ["practical", "shower"],
  gear: ["practical", "outdoor_gear"],
  meds: ["practical", "pharmacy"],
};
function catIcon(cat, title) {
  if (CAT_ICONS[cat]) return getIcon(CAT_ICONS[cat][0], CAT_ICONS[cat][1], title ? { title } : {});
  const a11y = title ? ` role="img" aria-label="${esc(title)}"` : ' aria-hidden="true"';
  return `<svg class="ico" viewBox="0 0 24 24"${a11y} data-icon="pk-${cat}">${
    CAT_LOCAL[cat] || CAT_LOCAL.misc}</svg>`;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// LIST GLYPHS
// ════════════════════════════════════════════════════════════════════════════════════════
// Two kinds of list, two shapes: a backpack for a list packed once, a sun for a list packed
// for the day. Keyed on the kind, never on the name, which anyone may change to anything.
const SUN = '<circle cx="12" cy="12" r="3.6"/><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7"/>';
function listIcon(list, title) {
  if (list.repeat !== "daily") return getIcon("practical", "outdoor_gear", title ? { title } : {});
  const a11y = title ? ` role="img" aria-label="${esc(title)}"` : ' aria-hidden="true"';
  return `<svg class="ico" viewBox="0 0 24 24"${a11y} data-icon="pk-day">${SUN}</svg>`;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// THE PLAIN STARTER LIST
// ════════════════════════════════════════════════════════════════════════════════════════
// A trip may carry its own suggested items (store.packStarters(), written by whoever set the
// trip up). A trip with none offers this instead, and it has nothing about any one trip in it.
//
// It is CATEGORIES rather than items, on purpose. A starter list is not a packing list; it is
// the SHAPE of one. Every line here is a thing you obviously need and would have written
// yourself, so none of them is a line to think about deleting. The specifics (which bottle,
// how many litres, which socks) are the part that is personal, and this list leaves room for
// them rather than guessing. An earlier, longer list of specific products was offered from a
// single button on an empty screen, a thumb found it by accident, and it wrote 81 rows that
// had to be deleted by hand.
//
// Quantities stay off deliberately. "Shirts" is a line you fill in; "Shirts ×3" is an opinion.
//
// `bag` is a POSITION, not a name: 0 is the list's first bag (the main one), 1 its second (the
// day bag), 2 its third (on you). A new trip's first list has exactly those three; a list
// with fewer takes the last it has. Only lists packed once get these: what goes in the bag
// for one day out is for the person heading out to say.
const PLAIN = (() => {
  const rows = [];
  const add = (cat, bag, labels) => {
    for (const l of labels) {
      const [label, own] = Array.isArray(l) ? l : [l, cat];
      rows.push({ label, cat: own, bag });
    }
  };
  add("clothes", 0, ["Shirts", "Pants", "Shorts", "Underwear", "Socks", "Jacket", "Sleepwear"]);
  add("clothes", 0, ["Walking shoes", "Spare shoes"]);
  add("toiletries", 0, ["Toiletries", ["Medication", "meds"], "Sunscreen"]);
  // The four that ride on your body rather than in a bag.
  add("documents", 2, ["Passport", "Cards and cash", ["Phone and charger", "electronics"], ["Sunglasses", "clothes"]]);
  add("gear", 1, ["Water bottle", ["Headlamp", "electronics"], ["Rain layer", "clothes"]]);
  // One running order. `sort` only orders items within a bag and category, but it has to be
  // stable and put the list's own sequence first: a list that reshuffles between two launches
  // is a list you stop trusting.
  rows.forEach((r, i) => { r.sort = (i + 1) * 10; });
  return rows;
})();

// ── permission ──────────────────────────────────────────────────────────────────────────
// See the header. These must stay equal to store.js and the server, not to each other's
// convenience: a control shown here that the store refuses throws on tap, and a control
// hidden here that the store allows is dead weight.
const canTick = (row) => row.owner === GROUP || row.owner === store.me().id;
const canEditRow = (row) => store.canEdit(row);

// ── ids ─────────────────────────────────────────────────────────────────────────────────
// FNV-1a, 32 bits. A starter row gets a DETERMINISTIC id so adding the list is idempotent:
// the same line always produces the same id, so a second device, or a queued create replayed
// over a flaky reconnect, lands on the row it already made instead of adding a second
// identical line. Not a security hash; a collision inside one list of a few dozen lines is
// around one in a million and would only merge two rows.
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0).toString(16).padStart(8, "0");
}
// Inside the server's id grammar, /^[A-Za-z0-9_.-]{1,64}$/: 3 + 44 + 1 + 8 = 56 at most.
function seedId(owner, key) {
  const own = String(owner).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 44);
  return `pk-${own}-${hash32(key)}`;
}

// ── local prefs ─────────────────────────────────────────────────────────────────────────
// Safari in private mode throws on localStorage, and none of this is worth a white screen.
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const K_TAB = "wgp.pack.tab";
const K_HIDE = "wgp.pack.hidedone";
const K_FOLD = "wgp.pack.folded";
// The list a tab last showed, per trip: pack-count.js reads the same key (its LIST_KEY) to count your own.
const kList = (tab) => `wgp.pack.list.${tab}`;
// Which list is open and which sections are folded are choices about this trip's lists, stored
// once per trip: see TRIP_KEYS in trip-here.js. (The tab, and hiding what is done, are the
// phone's.)
const here = (k) => tripKey(k, tripIdFromPath(location.pathname));

function readFolded() {
  try { return JSON.parse(LS.get(here(K_FOLD), "{}")) || {}; } catch { return {}; }
}

// ── icons ───────────────────────────────────────────────────────────────────────────────
const SVG_CHECK = `<svg class="pk-check-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5 9.5 17.5 19.5 6.5"/></svg>`;
const SVG_CHEV = `<svg class="pk-chev" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
const SVG_PLUS = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
// The move glyph: an open bag with an arrow dropping into it. Deliberately NOT a drag grip —
// an item moves by picker, not by drag, and a grip that does not drag is the worst kind of
// lie an icon can tell. The grip below is the other half of that rule: it appears only on the
// two lists that really are reordered by dragging.
// Which lists a thing is on: three lines, the first ticked.
const SVG_MOVE = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 6.5 1.6 1.6 3-3.2"/><path d="M11 6.5h9.5M11 12h9.5M11 17.5h9.5"/><path d="M4.5 12h2.5M4.5 17.5h2.5"/></svg>`;
// A list made on this screen gets one place to hold its things, never shown: a thing is on a list by having a bag there
// (the stored model), and this screen shows lists only.
const NEW_LIST_BAG = "Bag";
// Two columns of dots. It means "pick this up and move it" without a word, and unlike an
// arrow it does not promise a direction the row may not have left to go.
const SVG_GRIP = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`;
const SVG_TRASH = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 6.6h14.8"/><path d="M9.4 6.6V4.8a1.4 1.4 0 0 1 1.4-1.4h2.4a1.4 1.4 0 0 1 1.4 1.4v1.8"/><path d="M6.6 6.6 7.6 20a1.4 1.4 0 0 0 1.4 1.3h6a1.4 1.4 0 0 0 1.4-1.3l1-13.4"/></svg>`;
// The unplaced bin: an open-topped box with a dashed lip. It reads as "nothing is going in
// here", and it differs from every other bag header by SHAPE, never by colour.
const SVG_BIN = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.4 8.6v10.2a1.6 1.6 0 0 0 1.6 1.6h12a1.6 1.6 0 0 0 1.6-1.6V8.6"/><path d="M3 8.6h2.6M8.2 8.6h2.6M13.2 8.6h2.6M18.4 8.6H21"/><path d="M9 13.4h6"/></svg>`;
const SVG_OPTTICK = `<svg class="pk-opt-tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5 9.5 17.5 19.5 6.5"/></svg>`;

// ════════════════════════════════════════════════════════════════════════════════════════
// styles
// ════════════════════════════════════════════════════════════════════════════════════════
// Injected once. styles.css owns the shared kit and the tokens; per CONTRACTS.md each view
// owns its prefixed component classes, and this is where .pk-* lives. Every colour is a
// token, so the three-state theme keeps working without a second copy of the palette. No bare
// element selectors — everything is scoped under .pk-*.
//
// Strict accessibility rules enforced throughout:
// no `opacity` on text, 44px targets with 8px gaps, 12px minimum font
// size, and no state expressed by hue alone.
//
// Named SHEET_CSS, not CSS: a module-level `const CSS` shadows window.CSS for the whole file,
// so every window.CSS member silently reads as undefined instead of throwing.
const SHEET_CSS = `
.pk-root{display:flex;flex-direction:column}
@media (min-width: 760px){.pk-root{max-width:720px;margin-inline:auto;width:100%}}

/* PACKING ON THE DESIGN SYSTEM (packing-mock.html): the head (Packing, your picture at its end on a phone), Mine and
   Group under it as one sliding control (ds-modes); how many are left as the screen's one big number, a 2 px line that
   fills, the count in words; the lists as pills; Hide packed and Lists and bags; then each bag a heading with its count,
   a kind a quiet label, a thing a line with a 24 px box. Hairlines, no cards. */
.pk-head{margin-bottom:14px}
.pk-ownrow{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.pk-ownrow > .pk-own{flex:1 1 auto;min-width:0}
.pk-ownrow > .head-add{flex:0 0 auto}

.pk-sum{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.pk-sum-n{font:500 var(--size-number)/1.05 var(--type-head);letter-spacing:var(--track-number);
  font-variant-numeric:tabular-nums;color:var(--ink-1)}
.pk-sum-t{font-size:var(--size-16);color:var(--ink-2)}
.pk-sum-none{font:500 var(--size-28)/1.2 var(--type-head);letter-spacing:var(--track-head);color:var(--ink-1)}
.pk-meter{height:2px;border-radius:999px;background:var(--gray-3);overflow:hidden;margin:14px 0 8px}
.pk-meter-fill{display:block;height:100%;background:var(--ink-1);border-radius:999px;transform-origin:left center}
.pk-meter-line{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;
  gap:2px 12px;font-size:var(--size-14);line-height:20px;color:var(--ink-2)}
.pk-meter-line .strong{color:var(--ink-1);font-weight:600}
.pk-meter-line[data-closed="1"]{margin-top:12px}
.pk-meter-aside{flex:0 0 auto;white-space:nowrap}

.pk-lists-said{margin:18px 0 8px;font-size:var(--size-14);line-height:20px;color:var(--ink-2)}
.pk-views{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding:6px 2px;margin:-6px -2px}
.pk-views::-webkit-scrollbar{display:none}
.pk-viewcell{flex:0 0 auto;display:flex}
.pk-view{position:relative;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;
  border-radius:999px;border:1px solid var(--edge);background:none;color:var(--ink-2);
  font:600 var(--size-14)/1 var(--type-ui);white-space:nowrap;
  transition:background var(--dur-150) var(--ease-standard),color var(--dur-150) var(--ease-standard),border-color var(--dur-150) var(--ease-standard)}
.pk-view::before{content:"";position:absolute;inset:-6px -3px}
.pk-view .ico{flex:0 0 auto;width:16px;height:16px}
.pk-view[data-press="1"]{transform:scale(.97)}
@media (hover: hover) and (pointer: fine){.pk-view:active{transform:scale(.97)}}
.pk-view[aria-checked="true"]{background:var(--solid);color:var(--on-solid);border-color:transparent}
.pk-view-name{max-width:16rem;overflow:hidden;text-overflow:ellipsis}

.pk-tools{display:flex;gap:2px;flex-wrap:wrap;margin:10px -8px 6px}

.pk-sec{display:flex;flex-direction:column;border-top:1px solid var(--hair);margin-top:8px}
.pk-sec-head{display:flex;align-items:center;gap:8px;width:100%;min-height:var(--control-44);padding:14px 0 4px;
  text-align:left;background:none;border:0;color:inherit;font:inherit}
.pk-chev{flex:0 0 auto;width:16px;height:16px;color:var(--ink-2);transition:transform var(--dur-200) var(--ease-standard)}
.pk-sec[data-folded="1"] .pk-chev{transform:rotate(-90deg)}
.pk-sec-name{flex:1 1 auto;min-width:0;font:500 var(--size-20)/1.25 var(--type-head);letter-spacing:var(--track-head);
  color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pk-sec-n{flex:0 0 auto;font-size:var(--size-14);line-height:20px;color:var(--ink-2);font-variant-numeric:tabular-nums}
.pk-sec-body{display:grid;grid-template-rows:1fr;transition:grid-template-rows var(--dur-200) var(--ease-standard),opacity var(--dur-150) var(--ease-standard)}
.pk-sec-body > .pk-sec-in{min-height:0;overflow:hidden;display:flex;flex-direction:column}
.pk-sec[data-folded="1"] .pk-sec-body{grid-template-rows:0fr;opacity:0}
.pk-sec[data-folded="1"] .pk-sec-body > .pk-sec-in{visibility:hidden}

.pk-bin .pk-sec-name{font-family:var(--type-ui);font-size:var(--size-16);font-weight:600;letter-spacing:0;color:var(--ink-2)}
.pk-bin-ico{flex:0 0 auto;width:18px;height:18px;color:var(--ink-2);display:block}

.pk-cat{display:flex;align-items:center;gap:6px;padding:10px 0 2px;font-size:var(--size-14);line-height:20px;color:var(--ink-2)}
.pk-cat .ico{width:14px;height:14px}
.pk-cat-n{font-variant-numeric:tabular-nums}

.pk-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.pk-item{display:flex;align-items:stretch;position:relative}
.pk-lift{box-shadow:var(--shadow-lift);z-index:2;background:var(--canvas);border-radius:var(--radius-12)}

.pk-tick{flex:1 1 auto;min-width:0;display:grid;grid-template-columns:24px 1fr;column-gap:14px;align-items:center;
  min-height:48px;padding:6px 0;text-align:left;background:none;border:0;color:inherit;font:inherit}
.pk-box{width:24px;height:24px;border-radius:8px;border:1.5px solid var(--edge-strong);display:grid;place-items:center;
  color:transparent;transition:background var(--dur-150) var(--ease-standard),border-color var(--dur-150) var(--ease-standard),transform var(--dur-320) var(--ease-spring)}
button.pk-tick[data-press="1"] .pk-box{transform:scale(.88)}
@media (hover: hover) and (pointer: fine){button.pk-tick:active .pk-box{transform:scale(.88)}}
.pk-item[data-done="1"] .pk-box{background:var(--solid);border-color:transparent;color:var(--on-solid)}
div.pk-tick .pk-box{border-style:dashed}
.pk-check-svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;
  opacity:0;transform:scale(.5);transition:opacity var(--dur-150) var(--ease-standard),transform var(--dur-320) var(--ease-spring)}
.pk-item[data-done="1"] .pk-check-svg{opacity:1;transform:none}

.pk-body{min-width:0;display:flex;flex-direction:column;gap:2px}
.pk-line{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.pk-label{font-size:var(--size-16);line-height:22px;font-weight:600;color:var(--ink-1);overflow-wrap:anywhere;
  transition:color var(--dur-150) var(--ease-standard)}
.pk-item[data-locked="1"] .pk-label{font-weight:500}
.pk-item[data-done="1"] .pk-label{color:var(--ink-2);font-weight:400}
.pk-qty{flex:0 0 auto;padding:0 6px;border-radius:8px;background:var(--gray-3);color:var(--ink-2);
  font:500 var(--size-12)/20px var(--type-mono);white-space:nowrap;font-variant-numeric:tabular-nums}
.pk-note{font-size:var(--size-14);line-height:20px;color:var(--ink-2);overflow-wrap:anywhere}

.pk-by{font-size:var(--size-12);line-height:16px;color:var(--ink-2)}
.pk-by-lock{color:var(--warning)}

.pk-move{flex:0 0 auto;width:44px;align-self:stretch;display:grid;place-items:center;color:var(--ink-2);
  background:none;border:0;border-radius:var(--radius-12)}
.pk-move[data-press="1"]{background:var(--fill-hover)}
@media (hover: hover) and (pointer: fine){.pk-move:active{background:var(--fill-hover)}}
.pk-move > svg{width:18px;height:18px}

.pk-add{display:flex;align-items:center;gap:8px;min-height:var(--control-44);padding:0;color:var(--ink-2);
  font:600 var(--size-14)/20px var(--type-ui);background:none;border:0;align-self:flex-start}
.pk-add[data-press="1"]{color:var(--ink-1)}
@media (hover: hover) and (pointer: fine){.pk-add:active{color:var(--ink-1)}}
.pk-add > svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.pk-allpacked{padding:12px 0;font-size:var(--size-14);color:var(--ink-2)}


.pk-sform{display:flex;flex-direction:column;gap:var(--sp-3)}
/* The action bar. It is sheet.js's footEl now — a SIBLING of the scrolling body, not a
   sticky child of it — so "Save is always visible" is a layout fact rather than a sticky
   offset tuned against the scrollport's padding. The .sh-foot half (padding, ground,
   hairline) is the shell's; what is left here is the row itself: a flex row that may wrap,
   with the armed note ordered first so a two-tap delete says its sentence full width above
   the buttons instead of squeezing between them.
   NB no backticks in this block — it is inside a template literal. */
.pk-sheet-foot{display:flex;gap:var(--sp-2);align-items:center;flex-wrap:wrap}
.sh-title.pk-title-wrap{white-space:normal;min-width:min-content}
.pk-sheet-foot .pk-armnote{order:-1;flex:0 0 100%;margin:0 0 var(--sp-1)}
.pk-sheet-sub{font-size:13px;line-height:1.5;color:var(--ink-2)}
/* The second half of an armed destructive tap, shown inline in the sheet instead of
   in a transient toast. 13px at --warn,
   which is a colour AND a sentence: the words carry it, the hue only finds it. */
.pk-armnote{font-size:13px;line-height:1.4;font-weight:600;color:var(--warn);
  margin:calc(var(--sp-1) * -1) 0 0}

/* "Where it goes" — every list at once, which is the answer to "is this the same jacket?" */
.pk-where{display:flex;flex-direction:column;gap:var(--sp-2)}
.pk-where + .pk-where{margin-top:var(--sp-3)}
.pk-where-h{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;
  letter-spacing:.04em;text-transform:uppercase;color:var(--ink-3)}
.pk-where-h .ico{width:15px;height:15px}
.pk-opts{display:flex;flex-wrap:wrap;gap:var(--sp-2)}
.pk-opt{display:inline-flex;align-items:center;gap:6px;min-height:var(--tap);
  padding:0 var(--sp-4);border-radius:999px;border:1px solid var(--line-strong);
  background:var(--surface);color:var(--ink-2);font-size:14px;font-weight:600}
.pk-opt .ico{width:16px;height:16px}
.pk-opt[data-press="1"]{background:var(--press)}
@media (hover: hover) and (pointer: fine){.pk-opt:active{background:var(--press)}}
/* Selected: filled AND carrying a tick glyph. Never fill alone. */
.pk-opt[aria-checked="true"]{background:var(--accent);border-color:var(--accent);
  color:var(--accent-ink);font-weight:700}
.pk-opt-tick{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:3;
  stroke-linecap:round;stroke-linejoin:round;display:none}
.pk-opt[aria-checked="true"] .pk-opt-tick{display:block}
.pk-opt-off{border-style:dashed}

/* Manage bags and lists: rename in place, reorder by dragging the grip. Grip LEFT, delete
   RIGHT, name between them — and the two lists are built by the same function so
   they cannot drift apart. */
.pk-mrow{display:flex;align-items:center;gap:var(--sp-2);background:var(--surface);
  border-radius:var(--r-sm)}
.pk-mrow .input{flex:1 1 auto;min-width:0}
.pk-mbtn{flex:0 0 auto;width:var(--tap);height:var(--tap);display:grid;place-items:center;
  border-radius:var(--r-sm);border:1px solid var(--line);color:var(--ink-2);
  background:var(--surface)}
.pk-mbtn[data-press="1"]{background:var(--press);color:var(--accent)}
@media (hover: hover) and (pointer: fine){.pk-mbtn:active{background:var(--press);color:var(--accent)}}
.pk-mbtn[disabled]{color:var(--ink-3);background:var(--surface-2)}
.pk-mbtn > svg{width:19px;height:19px}
.pk-mnote{font-size:12.5px;line-height:1.45;color:var(--ink-3)}

/* The grip. A full 44px touch target around a 20px glyph, and touch-action:none because the
   drag is ours from the first move — the browser must not spend the gesture scrolling the
   sheet body first and hand it over afterwards. */
.pk-grip{flex:0 0 auto;width:var(--tap);height:var(--tap);display:grid;place-items:center;
  border-radius:var(--r-sm);color:var(--ink-3);background:none;border:0;
  touch-action:none;cursor:grab;
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.pk-grip[data-press="1"]{background:var(--press);color:var(--accent);cursor:grabbing}
@media (hover: hover) and (pointer: fine){.pk-grip:active{background:var(--press);color:var(--accent);cursor:grabbing}}
.pk-grip > svg{width:20px;height:20px}
/* The row in the hand. Lifted by shadow and z-index — never by hue, and never by opacity on
   its text — and its own transform is written inline by the drag. */
.pk-mdrag{position:relative;z-index:3;box-shadow:var(--shadow-lift);cursor:grabbing}
.pk-mlist{position:relative}

/* Armed for a second tap. On a text button the label itself changes, which is the signal;
   on an icon button the words go to the .pk-armnote line under the row and this fill is the
   reminder — never the only thing that says so. */
.pk-armed{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}

/* The seed preview (confirmSeed): what the button WOULD write, grouped into the bags it
   would write it into. Rows are 30px and inert — no tick, no move handle, no 44px target —
   because there is nothing here to touch yet; the only two targets on this sheet are in the
   pinned bar. The bag heading reuses .pk-where-h so this sheet reads as the same object as
   the move sheet, with the count pushed to the far end of it. */
.pk-pv{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.pk-pv-i{display:flex;align-items:center;gap:var(--sp-2);min-height:30px;
  font-size:14px;line-height:1.35;color:var(--ink)}
.pk-pv-i .ico{flex:0 0 auto;width:16px;height:16px;color:var(--ink-3)}
.pk-pv-l{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.pk-pv-n{margin-left:auto;color:var(--ink-3)}
`;

function ensureStyles() {
  if (document.getElementById("pk-styles")) return;
  const s = document.createElement("style");
  s.id = "pk-styles";
  s.textContent = SHEET_CSS;
  document.head.append(s);
}

// For a QUOTED attribute selector — [data-fk="…"] — only the quote and the backslash need
// escaping. Deliberately not CSS.escape: that escapes for an IDENTIFIER, so "own:mine" comes
// back as "own\:mine", which inside quotes is a literal backslash and matches nothing.
const attrEsc = (s) => String(s).replace(/["\\]/g, "\\$&");
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// The spring easing token, read lazily and never cached empty — same reason motion.js reads
// its own tokens that way: a module can execute before its stylesheet has applied, and ""
// cached at that moment would be wrong for the rest of the session.
let SPRING = "";
function springEase() {
  if (SPRING) return SPRING;
  const v = getComputedStyle(document.documentElement).getPropertyValue("--ease-spring").trim();
  if (v) SPRING = v;
  return v || "cubic-bezier(.34,1.3,.64,1)";
}

// ── the view ────────────────────────────────────────────────────────────────────────────

export default function mount(el, ctx) {
  ensureStyles();
  const { store: S } = ctx;              // same singleton; keeps the contract's ctx honest

  let tab = LS.get(K_TAB, "mine") === "group" ? "group" : "mine";
  let hideDone = LS.get(K_HIDE, "0") === "1";
  let folded = readFolded();
  let busy = "";                          // non-empty = a blocking message replaces the list
  let dead = false;                       // set by unmount; guards every async tail
  let listKey = "";                       // the list currently shown, on the current tab
  let shownTab = null;                    // the tab the switch last showed (none yet), so a change slides its highlight
  // A link may name the list to open (#/pack?list=<key>: the Itinerary's "Pack for today" and
  // "Pack for the day"). It opens on your own things, where that band's rows start.
  {
    const named = new URLSearchParams(location.hash.split("?")[1] || "").get("list");
    if (named && S.packLists().some((l) => l.key === named)) { tab = "mine"; listKey = named; }
  }
  let lastScrollAt = 0;                   // last scroll event on `el`; feeds scrolling()

  const root = document.createElement("div");
  root.className = "pk-root ds";
  el.append(root);


  const ownerFor = (t) => (t === "group" ? GROUP : S.me().id);

  // Which list is on screen is remembered per tab: going from your things to the group's
  // should not silently switch lists, and coming back should find the one you left.
  function currentList(t = tab) {
    const lists = S.packLists();
    if (!lists.length) return null;
    const want = (t === tab && listKey) || LS.get(here(kList(t)), "");
    return lists.find((l) => l.key === want) || lists[0];
  }
  function selectList(key) {
    listKey = key;
    LS.set(here(kList(tab)), key);
  }

  // What a list is being packed for right now: { day, open }. A list packed once has no day
  // and is always open. A list for the day is ticked for the TRIP's day, and only on a day
  // that is one of its own; on any other day it reads without ticking (store.packDay).
  const dayOf = (list) => S.packDay(list.key);
  // The bag an item sits in on a list, or null: "not carried". A placement that names a bag
  // the list no longer has is not carried either, never invisible.
  const bagKeyOf = (itemId, list) => bagKeyOn(S, itemId, list);
  // "Tue Jun 1", for a list for the day. Noon UTC of the day, read in UTC: a date, not a moment.
  const dayWords = (day) => fmtDay(Date.parse(`${day}T12:00:00Z`), "UTC");

  // ── render ────────────────────────────────────────────────────────────────────────────
  // Coalesced through rAF because store emits "change" once per write and seeding fires
  // hundreds. Suppressed while a sheet is open: rebuilding under an open editor loses what
  // has been typed.
  let raf = 0;
  let animating = 0;       // gestures whose players still own the DOM. A count, not a flag:
                           // two quick ticks overlap, and the first landing must not drop
                           // the shield while the second is still flying.
  let needRender = false;  // a render asked for while animating; replayed after
  function scheduleRender() {
    if (dead) return;
    // While a gesture's animation is in flight, a background render would rebuild the DOM out
    // from under every player. Queue it instead; animate() replays it when the players land.
    if (animating) { needRender = true; return; }
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (!sheetOpen()) render(); });
  }

  // The one gate every ANIMATED rebuild goes through, enforcing
  // no entrance animations on background re-renders: the only calls are the three user
  // gestures (view switch, tick, move) — everything else is a plain render().
  async function animate(fx) {
    animating += 1;
    try { await fx(); }
    finally {
      animating -= 1;
      if (!animating && needRender && !dead) { needRender = false; scheduleRender(); }
    }
  }

  // flip() cannot know a scroll is in progress (motion.js says so on purpose); this view can,
  // because `el` is its scroller. Motion guardrail: no animation while the finger scrolls —
  // a fresh scroll event means the list is moving under the thumb, so land instantly.
  const scrolling = () => Date.now() - lastScrollAt < 140;
  function flipRender(opts) {
    if (scrolling()) { render(); return Promise.resolve(); }
    return flip(root, () => render(), opts);
  }

  function render() {
    if (dead) return;
    // A direct render supersedes a scheduled one. Without this, the rAF queued by the store's
    // "change" would fire one frame after an animated rebuild and replace the DOM mid-flight.
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    // A full rebuild drops focus, and losing focus mid-list is how a screen-reader user gets
    // thrown back to the top of a 90-item list on every tick. Every focusable control carries
    // a stable data-fk for exactly this; put focus back on the same one.
    const active = document.activeElement;
    const fk = active && root.contains(active) ? (active.dataset.fk || "") : "";
    const scrollBefore = el.scrollTop;
    const stripBefore = (root.querySelector(".pk-views") || {}).scrollLeft || 0;

    root.innerHTML = html();
    const own = root.querySelector(".pk-own");
    if (own && shownTab && shownTab !== tab) requestAnimationFrame(() => own.style.setProperty("--ds-i", tab === "group" ? "1" : "0"));
    shownTab = tab;

    // The list strip scrolls sideways when the trip has more lists than fit. A rebuild must
    // leave it where the thumb left it, moved only as far as it takes to show the chosen
    // list whole. Its own scrollLeft, never scrollIntoView: that walks every scrollable
    // ancestor and would move the page as well.
    const strip = root.querySelector(".pk-views");
    if (strip) {
      strip.scrollLeft = stripBefore;
      const cell = strip.querySelector('.pk-view[aria-checked="true"]');
      if (cell) {
        const a = strip.getBoundingClientRect();
        const b = cell.getBoundingClientRect();
        if (b.left < a.left) strip.scrollLeft -= a.left - b.left + 8;
        else if (b.right > a.right) strip.scrollLeft += b.right - a.right + 8;
      }
    }

    if (fk) {
      const again = root.querySelector(`[data-fk="${attrEsc(fk)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
    el.scrollTop = scrollBefore;
  }

  function html() {
    const me = S.me();
    const mine = me.id ? S.packing(me.id) : [];
    const group = S.packing(GROUP);
    const rows = tab === "group" ? group : mine;
    return `<div class="ds-head pk-head"><h1>Packing</h1><div class="ds-head-end"></div></div>` +
      ownerTabsHtml(mine, group) +
      `<div id="pk-panel" role="tabpanel" tabindex="-1" aria-labelledby="pk-own-${tab}">${panelHtml(rows, me)}</div>`;
  }

  // Mine and Group: the system's sliding control (ds-modes). How much is left moved to the big number under it; each
  // tab still says it in its name, for a screen reader choosing between them.
  function ownerTabsHtml(mine, group) {
    const t = (id, label, rows) => {
      const list = currentList(id);
      let carried = 0, left = 0, closed = false;
      if (list) {
        const { day, open } = dayOf(list);
        closed = !open;
        for (const r of rows) {
          if (!bagKeyOf(r.id, list)) continue;
          carried++;
          if (open && !S.packTicked(r.id, list.key, day)) left++;
        }
      }
      return `<button class="ds-mode pk-ownbtn" type="button" role="tab" id="pk-own-${id}"
        aria-controls="pk-panel" data-act="owner" data-tab="${id}" data-fk="own:${id}"
        aria-selected="${tab === id}" tabindex="${tab === id ? 0 : -1}"
        aria-label="${esc(label)}, ${closed ? "nothing to pack today" : `${left} still to pack of ${carried}`}${
          list ? ` for ${esc(list.name)}` : ""}">${esc(label)}</button>`;
    };
    // Drawn where it was last shown; render() then moves it to the tab chosen, so the highlight slides.
    const shownAt = (shownTab || tab) === "group" ? 1 : 0;
    // From 768 the add is named beside Mine/Group (styles.css .head-add); a phone keeps its +.
    return `<div class="pk-ownrow"><div class="ds-modes pk-own" role="tablist" aria-label="Whose things" style="--ds-n: 2; --ds-i: ${shownAt}">
      <span class="ds-modes-hl" aria-hidden="true"></span>${t("mine", "Mine", mine)}${t("group", "Group", group)}</div><button type="button" class="head-add" data-act="add-item">+ Add an item</button></div>`;
  }

  function panelHtml(rows, me) {
    if (busy) {
      return `<div class="empty"><div class="skeleton" style="height:8px;width:60%"></div>
        <p class="lead">${esc(busy)}</p></div>`;
    }
    if (tab === "mine" && !me.id) {
      // Identity has not landed yet. The group list still renders from cache, but "your" list
      // has no owner to filter on, so saying so beats an empty checklist.
      return `<div class="empty"><h2 class="h3">Waiting for your account</h2>
        <button class="btn" data-act="owner" data-tab="group">Open the shared list</button></div>`;
    }

    // A trip always has at least one list, so the only way to have none is not to have heard
    // from the server yet on this phone.
    const list = currentList();
    if (!list) {
      return `<div class="empty"><div class="skeleton" style="height:8px;width:55%"></div>
        <p class="lead">Loading the trip's lists…</p></div>`;
    }

    const g = groupFor(rows, list);
    const out = heroHtml(rows, list, g) + toolsHtml(rows, g);
    if (!rows.length) return out + emptyHtml();

    return out + `<div class="pk-bags">` + onListHtml(g) + binHtml(g.unplaced, g) + `</div>`;
  }

  // ── the grouping ──────────────────────────────────────────────────────────────────────
  // One pass over the owner's items produces the whole screen: which bag each one is in, what
  // is not on this list, what is ticked, and the counts. Items are the source of truth;
  // placements only say where they show up, which is why nothing here can make a row
  // disappear. "Packed" is always packed ON THIS LIST, and on a list for the day, today.
  function groupFor(rows, list) {
    const { day, open } = dayOf(list);
    const buckets = new Map(list.bags.map((b) => [b.key, []]));
    const unplaced = [];
    const packed = new Set();
    for (const r of rows) {
      const k = bagKeyOf(r.id, list);
      if (!k) { unplaced.push(r); continue; }
      buckets.get(k).push(r);
      if (S.packTicked(r.id, list.key, day)) packed.add(r.id);
    }
    const sections = list.bags.map((b) => {
      const items = buckets.get(b.key);
      return {
        id: b.key, name: b.name, items,
        done: items.reduce((n, r) => n + (packed.has(r.id) ? 1 : 0), 0),
        groups: byCategory(items),
      };
    });
    unplaced.sort(itemOrder);
    const placed = sections.flatMap((sec) => sec.items);
    return { list, day, open, sections, placed, groups: byCategory(placed), unplaced, packed, carried: rows.length - unplaced.length, done: packed.size };
  }

  const itemOrder = (a, b) =>
    (CAT_RANK.get(catOf(a)) - CAT_RANK.get(catOf(b))) ||
    (a.sort || 0) - (b.sort || 0) || a.label.localeCompare(b.label, "en");

  // Category is the sub-grouping inside a bag. Rendered in the API's own order,
  // and only for the categories actually present — an empty "Meds" heading in the day-pack is
  // a line of chrome telling you nothing.
  function byCategory(items) {
    const m = new Map();
    for (const r of items) {
      const c = catOf(r);
      if (!m.has(c)) m.set(c, []);
      m.get(c).push(r);
    }
    return CATEGORIES.filter((c) => m.has(c)).map((c) => ({
      cat: c,
      items: m.get(c).sort((a, b) =>
        (a.sort || 0) - (b.sort || 0) || a.label.localeCompare(b.label, "en")),
    }));
  }

  // ── hero: the one-set-of-things message ───────────────────────────────────────────────
  function heroHtml(rows, list, g) {
    const lists = S.packLists();
    const pct = g.carried ? Math.round((g.done / g.carried) * 100) : 0;
    const blurb = tab === "group" ? "Everyone on the trip sees this list." : "Private to you.";
    const left = g.carried - g.done;

    // THE ONE BIG NUMBER: how many are left to pack on the list on screen (on a list for the day, today). It counts
    // down as things are ticked (springMeters). With nothing carried on this list, or nothing to pack today, the words
    // say so instead of a number nobody can bring down.
    const sum = !rows.length
      ? `<div class="pk-sum"><span class="pk-sum-none">Nothing to pack yet</span></div>`
      : g.open && g.carried
        ? `<div class="pk-sum"><span class="pk-sum-n" data-count="${left}">${left}</span><span class="pk-sum-t">left to pack</span></div>`
        : `<div class="pk-sum"><span class="pk-sum-none">${g.open ? "Nothing on this list yet" : "Nothing to pack today"}</span></div>`;

    // What is being counted, in words: packed for which list, and on a list for the day, for which day. On a day that
    // is not one of the list's, the line says when the list IS packed.
    const forWhat = `${esc(list.name)}${g.day && g.open ? `, ${esc(dayWords(g.day))}` : ""}`;
    const aside = g.unplaced.length ? `<span class="pk-meter-aside">${g.unplaced.length} not on this list</span>` : "";
    let meter = "";
    if (!g.open) {
      meter = `<div class="pk-meter-line" data-closed="1"><span>${esc(closedWords(list))} ${esc(blurb)}</span>${aside}</div>`;
    } else if (g.carried) {
      meter = `<div class="pk-meter" role="img" data-meter="v:${esc(list.key)}" aria-label="${g.done} of ${g.carried} packed for ${forWhat}">
          <span class="pk-meter-fill" style="width:${pct}%"></span></div>
        <div class="pk-meter-line"><span><span class="strong">${g.done} of ${g.carried}</span> packed for ${forWhat}. ${esc(blurb)}</span>${aside}</div>`;
    } else {
      meter = `<div class="pk-meter-line" style="margin-top:12px"><span>${esc(blurb)}</span>${aside}</div>`;
    }

    // The trip's lists as pills, the chosen one solid: said so over them, and which of how many where there are several.
    const listsSaid = `<p class="pk-lists-said">Packing for${lists.length > 1 ? ` · ${lists.findIndex((l) => l.key === list.key) + 1} of ${lists.length} lists` : ""}</p>`;
    const switcher = listsSaid + `<div class="pk-views" role="radiogroup" aria-label="List"${lists.length > 2 ? ' data-many="1"' : ""}>${lists.map((l) => {
      const on = l.key === list.key;
      return `<span class="pk-viewcell"><button class="pk-view" type="button" role="radio"
          aria-checked="${on}" tabindex="${on ? 0 : -1}" data-act="view" data-view="${esc(l.key)}" data-fk="view:${esc(l.key)}"
          aria-label="${esc(l.name)}${l.repeat === "daily" ? ", packed for the day" : ""}, carries ${countCarried(rows, l)} of ${rows.length}">
          ${listIcon(l)}<span class="pk-view-name">${esc(l.name)}</span></button></span>`;
    }).join("")}</div>`;

    return `<section class="pk-hero" aria-label="What is left to pack">${sum}${meter}${switcher}</section>`;
  }

  // Why a list for the day cannot be ticked today, as when it can be.
  function closedWords(list) {
    const trip = S.trip() || {};
    if (list.dates) {
      const n = list.dates.length;
      return `Packed on ${n === 1 ? dayWords(list.dates[0]) : `${n} days of the trip`}. Today isn't ${
        n === 1 ? "that day" : "one of them"}.`;
    }
    return `Packed each day of the trip, ${dayWords(trip.starts_on)} to ${dayWords(trip.ends_on)}. Today isn't one of them.`;
  }

  function countCarried(rows, list) {
    let n = 0;
    for (const r of rows) if (bagKeyOf(r.id, list)) n++;
    return n;
  }

  // The way to the trip's lists and bags is here whether or not the kit has anything in it:
  // a person setting a trip up names its bags before they have packed a thing. The other two
  // act on rows, so they wait for some.
  function toolsHtml(rows, g) {
    const manage = `<button class="ds-button ds-button--fade" type="button" data-act="managebags" data-fk="tool:bags">Lists</button>`;
    if (!rows.length) return `<div class="pk-tools">${manage}</div>`;
    const done = g.done;
    // Hide packed is a preference, never disabled: pressed with nothing packed yet, it hides each thing as it is packed
    // (a disabled button's words would sit under the contrast floor).
    return `<div class="pk-tools">
      <button class="ds-button ds-button--fade" type="button" data-act="hide" data-fk="tool:hide" aria-pressed="${hideDone}">
        ${hideDone ? "Show packed" : `Hide packed${done ? ` (${done})` : ""}`}</button>
      ${manage}
    </div>`;
  }

  // Per owner and per list: what is folded away ("Not on this list") on one list says nothing about another.
  const foldKey = (key) => `${ownerFor(tab)}::${(currentList() || {}).key || ""}/${key}`;

  // THE LIST: the things on it, by category, each with its box; then a way to add one. A thing is on a list by having a
  // place on it (stored as a bag of the list's, which this screen never shows: a new thing goes in the list's first).
  function onListHtml(g) {
    const visible = g.groups
      .map((gr) => ({ cat: gr.cat, items: hideDone ? gr.items.filter((r) => !g.packed.has(r.id)) : gr.items }))
      .filter((gr) => gr.items.length);
    const body = !g.placed.length ? `<p class="pk-allpacked">Nothing on this list yet.</p>`
      : visible.length ? visible.map((gr) => catBlockHtml(gr, true, g)).join("")
      : `<p class="pk-allpacked">All packed.</p>`;
    const first = (g.list.bags[0] || {}).key || "";
    return `<section class="pk-sec pk-on" aria-label="On ${esc(g.list.name)}">${body}
      <button class="pk-add" type="button" data-act="new" data-section="${esc(first)}" data-fk="add:list">${SVG_PLUS}<span>Add a thing</span></button>
    </section>`;
  }

  function catBlockHtml(gr, keyed, g) {
    return `<div class="pk-cat">${catIcon(gr.cat)}<span>${esc(CAT_LABEL[gr.cat])}</span>
        <span class="pk-cat-n">${gr.items.length}</span></div>
      <ul class="pk-list">${gr.items.map((r) => itemHtml(r, keyed, g)).join("")}</ul>`;
  }

  // A thing that isn't on this list is NOT a lost row: it is here, with a way onto the list, on every list. So a thing
  // on no list at all stays reachable.
  function binHtml(items, g) {
    const key = "bin";
    const isFolded = !!folded[foldKey(key)];
    return `<section class="pk-sec pk-bin" data-folded="${isFolded ? 1 : 0}">
      <button class="pk-sec-head" type="button" data-act="fold" data-section="${esc(key)}"
        data-fk="fold:${esc(key)}" aria-expanded="${!isFolded}">
        <span class="pk-bin-ico">${SVG_BIN}</span>
        <span class="pk-sec-name">Not on this list</span>
        <span class="pk-sec-n">${items.length}</span>
        ${SVG_CHEV}
      </button>
      <div class="pk-sec-body"><div class="pk-sec-in">
        ${items.length ? `<ul class="pk-list">${
          items.map((r) => itemHtml(r, !isFolded, g)).join("")}</ul>`
          : `<p class="pk-allpacked">Nothing.</p>`}
      </div></div>
    </section>`;
  }

  // `keyed` decides whether the row carries data-key, which is what motion.flip() animates
  // across a rebuild (data-key = item id, stable across every regroup). Rows inside a FOLDED
  // bag are display:none — they measure at (0,0) with no size, so keying them would make a
  // just-unfolded row fly in from the top-left corner. Unkeyed, flip treats a row folding
  // away as an exit (a fading ghost at its old spot) and one unfolding as an arrival (the
  // 8px fade-up), both of which are the honest picture.
  function itemHtml(r, keyed, g) {
    const placed = !!bagKeyOf(r.id, g.list);
    const done = g.packed.has(r.id);
    // Tickable: yours or the group's, carried on this list, and (a list for the day) on a day
    // the list is packed.
    const mine = canTick(r);
    const tickable = mine && placed && g.open;
    const editable = canEditRow(r);

    // The byline only earns its place on the shared list, and only for lines that are not
    // yours — "added by you" on every one of your own rows is noise.
    const byline = (tab === "group" && !editable)
      ? `<span class="pk-by pk-by-lock">Theirs to rename or delete</span>` : "";

    // The box carries its own accessible name only on a row that cannot be ticked: on a
    // tickable one the button's role=checkbox already announces the state, and two
    // announcements of "packed" per row is what makes people turn VoiceOver off. A row that
    // is not on this list has no box at all: there is nothing here to pack.
    const box = (labelled) => (placed ? `<span class="pk-box"${labelled
      ? ` role="img" aria-label="${done ? "Packed" : "Not packed"}"` : ""}>${SVG_CHECK}</span>` : "");

    const inner = (labelled) =>
      `${box(labelled)}
       <span class="pk-body">
         <span class="pk-line"><span class="pk-label">${esc(r.label)}</span>${
           r.qty ? `<span class="pk-qty">${esc(r.qty)}</span>` : ""}</span>
         ${r.note ? `<span class="pk-note">${esc(r.note)}</span>` : ""}
         ${byline}
       </span>`;

    // A row that cannot be ticked is a plain <div>, not a disabled <button>: a greyed
    // affordance invites a tap that will never work.
    const tick = tickable
      ? `<button class="pk-tick" type="button" role="checkbox" aria-checked="${done ? "true" : "false"}"
           data-act="tick" data-fk="${esc(r.id)}:tick">${inner(false)}</button>`
      : `<div class="pk-tick">${inner(true)}</div>`;

    // Which lists it is on is offered to anyone who may TICK the row, not only its author: a placement is not an item
    // write, so putting the group stove on "The trek" is exactly as shared as ticking it. The server agrees.
    const move = mine
      ? `<button class="pk-move" type="button" data-act="move" data-fk="${esc(r.id)}:move"
           aria-label="${placed ? `Which lists ${esc(r.label)} is on` : `Put ${esc(r.label)} on this list`}">${SVG_MOVE}</button>`
      : "";

    return `<li class="pk-item" data-id="${esc(r.id)}"${keyed ? ` data-key="${esc(r.id)}"` : ""}
      data-done="${done ? 1 : 0}" data-locked="${editable ? 0 : 1}">${tick}${move}</li>`;
  }

  // An empty list offers what this trip suggests for it, when the trip suggests anything,
  // and otherwise (your own things only) the plain starter list. Never added on its own.
  function emptyHtml() {
    const offer = starterOffer(ownerFor(tab));
    const seed = offer
      ? `<button class="btn btn-primary" data-act="seed">${esc(offer.button)}</button>` : "";
    // What to do next: the card above already says there's nothing to pack (16 Nov: "Nothing to pack
    // yet" over "Your list is empty" said one thing twice).
    const next = tab === "group" ? "Add what the group carries together: a stove, a first-aid kit."
      : seed ? "Start from the starter list, or add things one at a time." : "Add the first thing to pack.";
    return `<div class="empty">
      <p class="meta">${next}</p>
      ${seed}
      <button class="btn${seed ? "" : " btn-primary"}" data-act="new" data-section="">Add one item</button>
    </div>`;
  }

  // ── writes ────────────────────────────────────────────────────────────────────────────
  // Every store call is wrapped: store.js throws on a permission failure, and an unhandled
  // rejection here is a tap that silently does nothing.
  async function guard(fn, what) {
    try { await fn(); }
    catch (e) {
      console.warn("[packing]", what, e);
      toast((e && e.message) ? cap(e.message) : `Couldn't ${what}.`);
      scheduleRender();
    }
  }

  const itemById = (id) => S.packing(ownerFor(tab)).find((r) => r.id === id) || null;

  // ── the progress-bar spring ───────────────────────────────────────────────────────────
  // FLIP for a meter: measure every fill BEFORE the rebuild (keyed by data-meter, which is
  // the view or section id, so a bar keeps its identity across the innerHTML swap), rebuild
  // at the new width, then play scaleX(old/new) -> 1 on the spring easing. The width itself
  // is never tweened — transform only — and the pill's overflow:hidden clips
  // the overshoot at 100%.
  function snapMeters() {
    const m = new Map();
    for (const meter of root.querySelectorAll("[data-meter]")) {
      const fill = meter.querySelector(".pk-meter-fill");
      if (fill) m.set(meter.dataset.meter, fill.getBoundingClientRect().width);
    }
    const n = root.querySelector(".pk-sum-n[data-count]");
    if (n) m.set("count", Number(n.dataset.count));
    return m;
  }
  function springMeters(before) {
    if (reducedMotion() || scrolling()) return;
    for (const meter of root.querySelectorAll("[data-meter]")) {
      const was = before.get(meter.dataset.meter);
      if (was === undefined) continue;               // a bar that did not exist a frame ago
      const fill = meter.querySelector(".pk-meter-fill");
      if (!fill) continue;
      const now = fill.getBoundingClientRect().width;
      // A bar at zero has no scale to spring from (scaleX(∞)), and a bar that has not moved
      // has nothing to say; both also cover a folded section's display:none meter (0 -> 0).
      if (!(now > 0.5) || Math.abs(now - was) < 0.5) continue;
      fill.animate([{ transform: `scaleX(${was / now})` }, { transform: "none" }],
        { duration: ms("--dur-320", 320), easing: springEase() });
    }
    // The big number counts to its new value in step with the line (320 ms, the standard curve), a whole number every
    // frame. The text is the final number from the start for a screen reader; only what is drawn counts.
    const n = root.querySelector(".pk-sum-n[data-count]");
    const from = before.get("count"), to = n ? Number(n.dataset.count) : NaN;
    if (n && Number.isFinite(from) && Number.isFinite(to) && from !== to) {
      const dur = ms("--dur-320", 320), t0 = performance.now();
      n.setAttribute("aria-label", String(to));
      const ease = (x) => 1 - Math.pow(1 - x, 3);
      const step = (now) => {
        if (!n.isConnected) return;
        const k = Math.min(1, (now - t0) / dur);
        n.textContent = String(Math.round(from + (to - from) * ease(k)));
        if (k < 1) requestAnimationFrame(step); else n.removeAttribute("aria-label");
      };
      n.textContent = String(from);
      requestAnimationFrame(step);
    }
  }

  // The tick transition. One rebuild (flip closes the gap when "Hide packed" takes the
  // row out), then the checkmark's stroke draws itself on the fresh node and every bar whose
  // width moved springs there. All of it hangs off this tap — a background re-render calls
  // plain render() and animates nothing.
  async function toggle(id) {
    const row = itemById(id);
    const list = currentList();
    if (!row || !list) return;
    const { day, open } = dayOf(list);
    if (!open) return;
    const done = !S.packTicked(id, list.key, day);
    // Meters measured and the animating shield raised BEFORE the write, not after it: the
    // store's "change" fires mid-write, and on a fronted page its rAF render can slip into
    // the task gap before this function resumes — the DOM would already show the tick, a
    // post-write snapshot would already be "after", and both the spring and the gap-close
    // would silently no-op. Observed happening on every tick in a fronted dev browser.
    const meters = snapMeters();
    animate(async () => {
      await guard(() => S.tickPacking(id, list.key, day, done), "change that");
      if (dead) return;
      const waits = [flipRender({ duration: ms("--dur", 220) })];
      springMeters(meters);
      if (done) {
        // data-done="1" in the selector doubles as the write-really-landed check: if guard()
        // caught a permission throw the row still reads 0 and there is nothing to draw.
        const li = root.querySelector(`.pk-item[data-id="${attrEsc(id)}"][data-done="1"]`);
        const path = li && li.querySelector(".pk-check-svg path");
        if (path) waits.push(drawCheck(path));        // 160ms checkmark stroke
      }
      return Promise.all(waits);
    });
  }

  // MOVE = ONE PLACEMENT WRITE. Never store.setPacking — the item is not what changed.
  const moveItem = (itemId, lKey, bagKey) =>
    guard(() => S.placePacking(itemId, lKey, bagKey || null), "move that");

  // Row move: the row lifts (shadow + scale 1.02), FLIP-flies to its new section, and the
  // old list closes the gap. The translate is motion.flip()'s; the lift rides on top of it.
  // `lift` is false when the sheet edited a list other than the one on screen — the visible
  // row does not travel then, and a lift on a row going nowhere is decoration.
  function moveFlip(itemId, lift) {
    const meters = snapMeters();
    animate(() => {
      const p = flipRender({ duration: ms("--dur", 220) });
      springMeters(meters);
      if (lift && !reducedMotion() && !scrolling()) {
        liftRow(root.querySelector(`.pk-item[data-id="${attrEsc(itemId)}"]`), p);
      }
      return p;
    });
  }
  function liftRow(li, until) {
    if (!li) return;
    li.classList.add("pk-lift");                     // the shadow, for the length of the flight
    try {
      // composite:"add" stacks the scale ON TOP of the flip's translate — with the default
      // "replace", whichever animation ranks last would win the transform outright and the
      // row would either fly unscaled or scale without flying.
      li.animate(
        [{ transform: "scale(1.02)" }, { transform: "scale(1.02)", offset: 0.55 },
         { transform: "none" }],
        { duration: ms("--dur", 220), easing: springEase(), composite: "add" });
    } catch { /* an engine without composite:add keeps the flight, drops the garnish */ }
    until.then(() => li.classList.remove("pk-lift"));
  }

  // Switching lists FLIP-animates every row from its old bag
  // to its new one — the moment that teaches "same items, two lists" — at the full 320ms.
  // The mutate inside flip() runs synchronously, so callers may query the new DOM (to move
  // focus) the moment this returns.
  function switchList(key) {
    selectList(key);
    animate(() => flipRender({ duration: ms("--dur-slow", 320) }));
  }

  // ── the starter list ──────────────────────────────────────────────────────────────────
  // NOTHING ADDS ITSELF. A new member arrives to the trip's bags and an empty list, and the
  // starter list is a button they may press rather than lines they have to delete.
  let seeding = false;

  // What an empty list may be filled with, as rows that already know their bags:
  //   { key, label, cat, note, qty, sort, bags: { list key: bag key } }
  // The trip's own suggestions when it has any for this owner (a person's, or the group's);
  // otherwise, for a person only, the plain list above, whose bag positions are resolved here
  // against the trip's lists as they stand. The group gets no plain list: what one of you
  // brings for everyone is a fact about a trip, and a list that guessed it would be wrong.
  function starterOffer(owner) {
    const scope = owner === GROUP ? "group" : "person";
    const own = S.packStarters().filter((x) => x.scope === scope);
    if (own.length) {
      return {
        button: "Add the suggested list",
        title: "Suggested for this trip",
        sub: owner === GROUP
          ? "What this trip suggests one of you brings for everyone. This list is shared, so everyone sees what you add. Nothing is added until you tap Add."
          : "What this trip suggests you pack. Nothing is added until you tap Add.",
        rows: own.map((x) => ({
          key: `starter\u0000${x.id}`, label: x.label, cat: x.category, note: x.note,
          qty: x.qty == null ? "" : String(x.qty), sort: (x.sort + 1) * 10, bags: x.bags,
        })),
      };
    }
    if (owner === GROUP) return null;
    const once = S.packLists().filter((l) => l.repeat !== "daily" && l.bags.length);
    return {
      button: "Add the starter list",
      title: "Starter list",
      sub: "The bare essentials, filed into the trip's bags. Nothing is added until you tap Add.",
      rows: PLAIN.map((t) => ({
        key: `plain\u0000${t.label}`, label: t.label, cat: t.cat, note: "", qty: "", sort: t.sort,
        bags: Object.fromEntries(once.map((l) => [l.key, l.bags[Math.min(t.bag, l.bags.length - 1)].key])),
      })),
    };
  }

  // ── LOOK BEFORE IT WRITES ─────────────────────────────────────────────────────────────
  // The seed button is the only way a list gets filled in one go, it sits alone in the middle
  // of an empty screen, and it is therefore the first thing a thumb lands on. So the button
  // does not write. It shows what it WOULD write, in the bags the rows will land in on the
  // list being looked at, and the write needs a second tap that is a decision rather than a
  // reflex. The shared list gets the same gate, for a worse reason: it belongs to everyone,
  // and an accidental seed there is a mess every other phone watches appear.

  // Group the rows by the bag each lands in ON THE LIST BEING LOOKED AT, in the list's own
  // bag order. No bag there is not "unknown": it is "not on this list", a real answer, and it
  // sorts last.
  function previewGroups(rows) {
    const list = currentList();
    const bags = list ? list.bags : [];
    const out = new Map(bags.map((b, i) => [b.key, { name: b.name, rank: i, rows: [] }]));
    const off = { name: "Not on this list", rank: 99, rows: [] };
    for (const t of rows) {
      const k = list ? t.bags[list.key] : "";
      (out.get(k) || off).rows.push(t);
    }
    return [...out.values(), off].filter((g) => g.rows.length).sort((a, b) => a.rank - b.rank);
  }

  // Read-only rows: no tick, no move button, no data-id. Nothing here exists yet, and an
  // affordance on a row that is still hypothetical is a tap that does nothing. The category
  // glyph rides along because that is how a category is said everywhere else on this screen —
  // a shape and never a tint (see the CATEGORIES header).
  function previewHtml(rows) {
    return previewGroups(rows).map((g) => `<div class="pk-where">
      <div class="pk-where-h"><span>${esc(g.name)}</span>
        <span class="pk-pv-n num">${g.rows.length}</span></div>
      <ul class="pk-pv">${g.rows.map((t) => `<li class="pk-pv-i">${catIcon(t.cat)}<span
        class="pk-pv-l">${esc(t.label)}</span>${
        t.qty ? `<span class="pk-qty">${esc(t.qty)}</span>` : ""}</li>`).join("")}</ul>
    </div>`).join("");
  }

  // There IS a Cancel here, and it is the one sheet in this file that has one. Everywhere
  // else the backdrop is cancel and a second way to say it is clutter (see openSheet). This
  // sheet exists because somebody arrived at it by accident, and a person who did not mean to
  // open it should not have to already know that the backdrop dismisses.
  function confirmSeed(owner, offer) {
    if (seeding) return;
    const list = currentList();
    openSheet({
      title: offer.title,
      sub: `${esc(offer.sub)}${list && S.packLists().length > 1
        ? ` The bags below are where each lands on ${esc(list.name)}.` : ""}`,
      compact: true,
      body: previewHtml(offer.rows),
      foot: `<span class="grow"></span>
        <button class="btn" type="button" data-act="close">Cancel</button>
        <button class="btn btn-primary" type="button" data-act="seedgo" aria-label="Add ${
          offer.rows.length === 1 ? "1 thing" : `${offer.rows.length} things`}">Add ${offer.rows.length}</button>`,
      onReady: (wrap, form) => {
        form.focus({ preventScroll: true });
        // Two buttons share the head with this title, so on a narrow phone it has a third
        // of the line: it takes a second line there instead of being cut to "Sta…", and
        // the button says the number alone ("Add 19") so a whole word of the title fits.
        const h = wrap.querySelector(".sh-title");
        if (h) h.classList.add("pk-title-wrap");
        wrap.addEventListener("click", (ev) => {
          const b = ev.target.closest('[data-act="seedgo"]');
          if (!b || !wrap.contains(b)) return;
          ev.preventDefault();
          // Close first: runSeed() repaints the screen behind this on every eighth row, and
          // doing that under a sheet the user can no longer reach is the drawer wedged open.
          closeSheet();
          runSeed(owner, offer.rows);
        });
      },
    });
  }

  async function runSeed(owner, rows) {
    if (seeding) return;
    seeding = true;
    busy = "Setting up your list…";
    render();
    try {
      // ONE BAD ROW MUST NOT COST THE OTHERS. Keep going and say how many lines did not make
      // it: a list of eighteen with one line missing beats a list of three, every time.
      let lost = 0;
      for (let i = 0; i < rows.length; i++) {
        if (dead) return;
        const t = rows[i];
        try {
          // Sequential, not Promise.all: each add is a durable queued write, and dozens of
          // concurrent IndexedDB transactions on a cold phone is a visible stall for no gain.
          // One write per row: the item goes out with the bags it starts in.
          await S.addPacking(owner, {
            id: seedId(owner, t.key), label: t.label, note: t.note, qty: t.qty, sort: t.sort,
            category: t.cat, bags: t.bags,
          });
        } catch (e) {
          lost++;
          console.warn("[packing] seed row failed", t.label, e);
        }
        if (i % 8 === 0 || i === rows.length - 1) {
          busy = `Setting up your list… ${i + 1} of ${rows.length}`;
          render();
        }
      }
      // Said out loud, with the number. The alternative is a list that is quietly short and a
      // person who packs from it believing it is complete. It does not offer a retry because
      // the empty state (and its button) is gone the moment the first row lands; naming the
      // shortfall is what lets the person add what is missing themselves.
      if (lost) toast(`${lost} of ${rows.length} lines didn't save — the list is short.`);
    } catch (e) {
      console.error("[packing] seed failed", e);
      toast("Couldn't build the starter list.");
    } finally {
      seeding = false;
      busy = "";
      if (!dead) render();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════
  // sheets
  // ══════════════════════════════════════════════════════════════════════════════════════
  let sheet = null;
  const sheetOpen = () => !!sheet;

  // One adapter for all three sheets. The panel — scrim, grab handle, Escape, focus trap,
  // the keyboard offset, the drag — belongs to the shell's sheet.js. What is
  // left here is this module's contents and the option bag the call sites are written
  // against: {title, sub, body, foot, compact, onReady, onClose}.
  //
  // `foot`, when given, becomes sheet.js's footEl: a bar OUTSIDE the scrolling body, pinned
  // to the bottom of the sheet. `wrap` in onReady is therefore the .sh-sheet
  // element, which spans both the body and that bar — one delegated click listener still
  // reaches every control, and every querySelector the call sites make still resolves.
  //
  // NO X, AND NO BODY SWIPE, ANYWHERE ON THIS SCREEN. The handle and the
  // backdrop are the two ways out, and taking the body swipe away is what stops a dismiss
  // gesture racing a scroll inside a form. Both are set here rather than per call site so a
  // fourth sheet cannot quietly reintroduce either.
  function openSheet({ title, sub, body, foot, compact, onReady, onClose }) {
    closeSheet();

    const form = document.createElement("form");
    form.className = "pk-sform";
    form.tabIndex = -1;                    // a focus target that is not a text field
    form.innerHTML = `${sub ? `<p class="pk-sheet-sub">${sub}</p>` : ""}${body}`;
    // Never let a stray Enter submit and reload the page — every action here is a button.
    form.addEventListener("submit", (ev) => ev.preventDefault());

    let footEl = null;
    if (foot) {
      footEl = document.createElement("div");
      footEl.className = "pk-sheet-foot";
      footEl.innerHTML = foot;
    }

    const api = openBottomSheet({
      title,
      contentEl: form,
      footEl,
      closeButton: false,
      dragFrom: "handle",
      // Two thirds of the screen, capped again by whatever the keyboard leaves. The editor
      // asks for it; the pickers are shorter than that anyway and pass nothing.
      // 0.58, not 2/3. The action bar used to be a band across the FOOT of the drawer, roughly
      // 76px of it, and the cap was set with that band included. The action lives in the head
      // now, so the same content needs about that much less drawer — and the point of moving
      // it was that the drawer could come down further. Without this the
      // drawer stays pinned at its old cap and only its scrollport gets roomier, which is not
      // the same thing. 0.58 of 844 is 490px, against 563 before.
      maxFraction: compact ? 0.58 : 0,
      opaque: !!compact,
      // sheet.js calls this once for EVERY dismissal — the backdrop, Escape, a handle drag,
      // or our own close(). It is therefore the only teardown path there is, which is why the
      // armed-delete timer is cleared here and not in closeSheet(): a handle drag never goes
      // through closeSheet, and a timer left running would fire against a dead node.
      onClose: () => {
        // Only if this is still the CURRENT sheet. Closing is animated, so an exit and the
        // next sheet's open overlap by up to a frame or two; without the identity check the
        // outgoing sheet's teardown would null out the incoming one.
        if (sheet && sheet.api === api) {
          clearTimeout(sheet.armTimer);
          sheet = null;
        }
        // Unmount closes the sheet on its way out, and its exit lands after this view is
        // gone. Anything the caller wanted to do next (openWhere's "Edit item…") would be
        // opening a sheet over somebody else's screen.
        if (dead) return;
        if (onClose) onClose();
        scheduleRender();
      },
    });
    const wrap = api.el;                   // .sh-sheet — spans the body AND the pinned bar
    wrap.addEventListener("click", (ev) => {
      const b = ev.target.closest('[data-act="close"]');
      if (!b || !wrap.contains(b)) return;
      ev.preventDefault();
      closeSheet();
    });
    // No focusin handler here any more. scrollIntoView() — which is what used to live at
    // this line — walks EVERY scrollable ancestor and the document with it, so a field
    // lifted inside the sheet also shoved #view behind it (pushing up the sheet
    // AND the page behind it in one call). sheet.js's keyboardLock now does the lift, by
    // measuring the field against the sheet's own scrollport and moving only that.
    sheet = { api, form, wrap, armed: null, armTimer: null, note: null };

    // sheet.js has already focused the first control, which for the editor is the label
    // field — right for "New item", wrong for everything else. onReady runs synchronously
    // after that and moves focus where the caller wants it, before any paint.
    if (onReady) onReady(wrap, form);
    else form.focus({ preventScroll: true });
    return form;
  }

  function closeSheet() {
    if (!sheet) return;
    clearArmNote();
    // Cleared here as well as in onClose. onClose only clears the timer of the sheet that is
    // still current, and this is the one path where it will not be by the time it fires: a
    // call site that closes and immediately opens another sheet.
    clearTimeout(sheet.armTimer);
    sheet.api.close();                     // teardown, and `sheet = null`, happen in onClose
  }

  // Two taps, not a native confirm(): confirm() in an installed PWA is a jarring system sheet,
  // and there is no undo behind these — the row is gone from four phones.
  function arm(btn, text, run) {
    if (!sheet) return;
    if (sheet.armed !== btn) {
      clearTimeout(sheet.armTimer);
      if (sheet.armed) disarm(sheet.armed);
      sheet.armed = btn;
      btn.classList.add("pk-armed");
      // An ICON-only button cannot say "tap again" in place: writing text into it destroys
      // the glyph it is made of, and the replacement does not fit a 44px square anyway. It
      // gets a line of its own under the row instead, IN the sheet — this used to be a toast,
      // avoiding any fleeting toast. A text button says it
      // where the thumb already is, which is better when there is room.
      if (btn.firstElementChild) armNote(btn, text);
      else { btn.dataset.was = btn.textContent; btn.textContent = text; }
      const label = btn.getAttribute("aria-label");
      if (label) { btn.dataset.wasLabel = label; btn.setAttribute("aria-label", text); }
      sheet.armTimer = setTimeout(() => {
        if (!sheet || sheet.armed !== btn) return;
        sheet.armed = null;
        disarm(btn);
      }, 4000);
      return;
    }
    sheet.armed = null;
    clearTimeout(sheet.armTimer);
    disarm(btn);
    run();
  }
  function disarm(btn) {
    if (!btn.firstElementChild && btn.dataset.was) btn.textContent = btn.dataset.was;
    if (btn.dataset.wasLabel) btn.setAttribute("aria-label", btn.dataset.wasLabel);
    btn.classList.remove("pk-armed");
    clearArmNote();
  }

  // The armed sentence, placed after the row the button sits in so it reads as belonging to
  // that bag and not to the sheet. role="status" so a screen reader hears it without the
  // focus being taken off the button that has to be tapped a second time.
  function armNote(btn, text) {
    clearArmNote();
    if (!sheet) return;
    const n = document.createElement("p");
    n.className = "pk-armnote";
    n.setAttribute("role", "status");
    n.textContent = text;
    // In the pinned bar the note goes INSIDE it, first, and the bar's flex-wrap gives it the
    // full width above the buttons — a sentence placed after the bar would be off the bottom
    // of the sheet, which is the one place in this layout nothing is ever visible.
    const bar = btn.closest(".pk-sheet-foot");
    if (bar) bar.prepend(n);
    else {
      const host = btn.closest(".pk-mrow") || btn.parentElement;
      if (!host) return;
      host.after(n);
    }
    sheet.note = n;
  }
  function clearArmNote() {
    if (!sheet || !sheet.note) return;
    sheet.note.remove();
    sheet.note = null;
  }

  // ── "Where it goes" — the move sheet ──────────────────────────────────────────────────
  // EVERY list at once, for one item. That is the answer to the only question this screen can
  // provoke: "is the jacket in the checked bag the same jacket as the one in the duffel?"
  // Choosing applies immediately — a Save button on a two-tap move is a third tap for nothing,
  // and for the same reason there is no Done: the sheet has nothing left to confirm.
  function openWhere(row) {
    // Deferred to onClose rather than opened on top of this sheet. sheet.js returns focus to
    // whatever was focused before it opened, and it does that at the END of its exit
    // animation — so an editor opened immediately would have focus yanked back to the list
    // row a quarter of a second later. Let the move sheet finish leaving first.
    let thenEdit = false;
    openSheet({
      title: row.label,
      body: `<div id="pk-where">${whereHtml(row, S.packLists(), "put")}</div>`,
      foot: canEditRow(row)
        ? `<button class="btn" type="button" data-act="edititem">Edit item</button>` : "",
      onClose: () => { if (thenEdit) openEditor("edit", row, null); },
      onReady: (wrap, form) => {
        form.focus({ preventScroll: true });
        wrap.addEventListener("click", async (ev) => {
          const b = ev.target.closest("[data-act]");
          if (!b || !wrap.contains(b)) return;
          if (b.dataset.act === "edititem") {
            ev.preventDefault();
            thenEdit = true;
            closeSheet();
            return;
          }
          if (b.dataset.act !== "put") return;
          ev.preventDefault();
          const lKey = b.dataset.view;
          const wasHere = lKey === ((currentList() || {}).key);
          await moveItem(row.id, lKey, b.dataset.sec || null);
          // The list behind the sheet regroups NOW — the row lifts and flies to its new bag —
          // rather than waiting for the sheet to close. The "no rebuilds while a sheet is
          // open" rule in scheduleRender() protects typed input, and this sheet has none.
          moveFlip(row.id, wasHere);
          // Repaint just the picker: rebuilding the whole sheet would lose the scroll position
          // on a trip with five lists and re-announce the title.
          const host = wrap.querySelector("#pk-where");
          if (host) host.innerHTML = whereHtml(row, S.packLists(), "put");
        });
      },
    });
  }

  // Shared by the move sheet and the editor. `act` differs because one applies immediately
  // and the other collects a choice until Save.
  // Each list: on it, or not. "On it" keeps the place it has (a bag the screen doesn't show), or takes the list's first.
  function whereHtml(row, lists, act, picks) {
    return lists.map((l) => {
      const cur = picks ? (picks.get(l.key) || "") : ((row && bagKeyOf(row.id, l)) || "");
      const on = cur || (l.bags[0] || {}).key || "";
      const opt = (key, name, off) => `<button class="pk-opt${off ? " pk-opt-off" : ""}"
        type="button" role="radio" aria-checked="${(key || "") === cur}" data-act="${act}"
        data-view="${esc(l.key)}" data-sec="${esc(key || "")}">${SVG_OPTTICK}
        <span>${esc(name)}</span></button>`;
      return `<div class="pk-where">
        <div class="pk-where-h">${listIcon(l)}<span>${esc(l.name)}</span></div>
        <div class="pk-opts" role="radiogroup" aria-label="On ${esc(l.name)}">
          ${opt(on, "On it", false)}
          ${opt("", "Not on it", true)}
        </div>
      </div>`;
    }).join("");
  }

  // ── item editor ───────────────────────────────────────────────────────────────────────
  // ONE component for new and edit; the two modes
  // differ here in exactly three expressions: the title, the CTA's label, and whether Delete
  // is in the bar. Everything else — the fields, the category chips, the per-list bag pickers,
  // the save path — is shared, because the moment they fork is the moment "add" and "edit"
  // start disagreeing about what an item is.
  //
  // THE SHAPE, and why each part of it is the way it is:
  //   * compact:true caps the sheet at two thirds of the screen and, with the keyboard up,
  //     at whatever is left above the keys. It is a sheet, not a page: the list behind it is
  //     still the thing you are working on.
  //   * the CTA is in sheet.js's pinned bar, a sibling of the scrollport, so it cannot scroll
  //     away from under the thumb however long the form gets.
  //   * the body scrolls internally, and NOTHING about that fights dismissal, because the
  //     body is not a dismiss surface: only the handle and the backdrop are.
  //   * opaque:true blacks the backdrop out while the keys are up, so a two-thirds-height
  //     sheet does not put the agenda on screen behind the thing you are typing into.
  // There is no Cancel and no X. Backdrop tap is cancel, and two more ways to say it in a
  // compact bar is two more things to read.
  function openEditor(mode, row, presetBagKey) {
    const owner = ownerFor(tab);
    const lists = S.packLists();
    const list = currentList();
    const curCat = row ? catOf(row) : "misc";

    // A new item is placed as part of adding it: on the list being looked at, in the bag the
    // add came from, and on every other list that is packed once, in its first bag. An item
    // that lands on no list is a thing you typed and then have to go looking for. A list for
    // the day is the exception: what goes out for one day is chosen, never assumed, so a new
    // thing is on one only when it was added from it.
    const picks = new Map();
    for (const l of lists) {
      const first = (l.bags[0] || {}).key || "";
      if (row) picks.set(l.key, bagKeyOf(row.id, l) || "");
      else if (list && l.key === list.key) {
        picks.set(l.key, (presetBagKey && l.bags.some((b) => b.key === presetBagKey)) ? presetBagKey : first);
      } else picks.set(l.key, l.repeat === "daily" ? "" : first);
    }

    const catChips = CATEGORIES.map((c) => `<button class="pk-opt" type="button" role="radio"
      aria-checked="${c === curCat}" data-act="cat" data-cat="${c}">${SVG_OPTTICK}
      ${catIcon(c)}<span>${esc(CAT_LABEL[c])}</span></button>`).join("");

    openSheet({
      title: mode === "new" ? "New item" : "Edit item",
      compact: true,
      body: `
        <div class="field">
          <label for="pk-f-label">Item</label>
          <input id="pk-f-label" class="input" type="text" name="label" autocomplete="off"
            enterkeyhint="done" maxlength="200" value="${esc(row ? row.label : "")}"
            placeholder="Rain jacket">
        </div>
        <div class="field">
          <label for="pk-f-qty">Quantity or size</label>
          <input id="pk-f-qty" class="input" type="text" name="qty" autocomplete="off"
            maxlength="40" value="${esc(row ? row.qty : "")}" placeholder="2 pairs · Tall">
        </div>
        <div class="field">
          <label for="pk-f-note">Note</label>
          <textarea id="pk-f-note" class="input" name="note" maxlength="1000"
            placeholder="Optional" style="min-height:64px">${esc(row ? row.note : "")}</textarea>
        </div>
        <div class="pk-where">
          <div class="pk-where-h"><span>Category</span></div>
          <div class="pk-opts" role="radiogroup" aria-label="Category">${catChips}</div>
        </div>
        ${lists.length ? `<hr class="hr">
          <div id="pk-where">${whereHtml(row, lists, "pick", picks)}</div>` : ""}`,
      foot: `${mode === "edit"
        ? `<button class="btn btn-danger" type="button" data-act="del">Delete</button>` : ""}
        <span class="grow"></span>
        <button class="btn btn-primary" type="button" data-act="save">${
          mode === "new" ? "Add" : "Save"}</button>`,
      onReady: (wrap, form) => {
        // sheet.js focuses the first control, which here is the label field. That is exactly
        // right for "New item" — the sheet rides above the keyboard and the pinned bar holds
        // Add on screen beside it. On an EDIT it is wrong: the keyboard would cover the
        // category chips and Delete, usually the two things the sheet was opened for. Taking
        // focus back happens in the same tick, before any paint, so no keyboard ever rises.
        // preventScroll on EVERY focus in this file. The keyboard that this
        // one opens must not be allowed to drag anything into view on its way up; sheet.js's
        // keyboardLock does the lifting, inside the sheet's own scrollport, and nowhere else.
        // NOT the label field, even for "new". Focusing a text input here is what made the +
        // button summon the keyboard mid-slide and throw the screen around before you had
        // decided to type anything. The field is one tap away and that tap is the user's.
        form.focus({ preventScroll: true });

        let cat = curCat;

        wrap.addEventListener("click", async (ev) => {
          const b = ev.target.closest("[data-act]");
          if (!b || !wrap.contains(b)) return;
          const act = b.dataset.act;

          if (act === "cat") {
            ev.preventDefault();
            cat = b.dataset.cat;
            for (const n of wrap.querySelectorAll('[data-act="cat"]')) {
              n.setAttribute("aria-checked", String(n.dataset.cat === cat));
            }
            return;
          }
          if (act === "pick") {
            ev.preventDefault();
            const lKey = b.dataset.view;
            picks.set(lKey, b.dataset.sec || "");
            for (const n of wrap.querySelectorAll(`[data-act="pick"][data-view="${attrEsc(lKey)}"]`)) {
              n.setAttribute("aria-checked", String((n.dataset.sec || "") === picks.get(lKey)));
            }
            return;
          }
          if (act === "del") {
            ev.preventDefault();
            arm(b, "Tap again to delete", () => {
              const id = row.id;
              closeSheet();
              guard(() => S.deletePacking(id), "delete that");
            });
            return;
          }
          if (act !== "save") return;
          ev.preventDefault();

          const val = (n) => (wrap.querySelector(`[name="${n}"]`) || {}).value || "";
          const label = val("label").trim();
          if (!label) {
            wrap.querySelector('[name="label"]').focus({ preventScroll: true });
            toast("Needs a name.");
            return;
          }
          const note = val("note").trim();
          const qty = val("qty").trim();
          closeSheet();

          if (mode === "new") {
            // One write: the thing and the bag it starts in on each list.
            await guard(() => S.addPacking(owner, {
              id: uid("pk"), label, note, qty, category: cat, sort: nextSort(owner),
              bags: Object.fromEntries([...picks].filter(([, bagKey]) => bagKey)),
            }), "add that");
          } else {
            await guard(async () => {
              await S.setPacking(row.id, { label, note, qty, category: cat });
              // Only the bags that actually changed. placePacking() ignores a move to where
              // the thing already is, so an unchanged list costs nothing.
              for (const [lKey, bagKey] of picks) await S.placePacking(row.id, lKey, bagKey || null);
            }, "save that");
          }
        });
      },
    });
  }

  // Append, never prepend: a list you are working down should not reorder itself under your
  // thumb. `sort` only orders within a bag and category now, but it still has to be stable.
  function nextSort(owner) {
    return S.packing(owner).reduce((m, r) => Math.max(m, r.sort || 0), 0) + 10;
  }

  // ── manage bags and lists ─────────────────────────────────────────────────────────────
  // Rename in place, reorder by dragging the grip, delete on the right. No Done and no X:
  // every control in here applies the moment it is used, so a button whose only job is to
  // close a sheet the handle and the backdrop already close is a button that means nothing.
  // Two lines of copy and no more: which list these bags are on, and that lists and bags are
  // the whole trip's, because a rename here lands on every phone.
  function openManage() {
    openSheet({
      title: "Lists",
      body: `<div id="pk-manage" class="stack-tight">${manageHtml(currentList())}</div>`,
      onReady: (wrap, form) => {
        form.focus({ preventScroll: true });
        const repaint = () => {
          const host = wrap.querySelector("#pk-manage");
          if (host) host.innerHTML = manageHtml(currentList());
        };
        // The drag lives on the list containers, not on each row: rows are replaced wholesale
        // by repaint(), and a listener per row would be re-bound on every rename.
        wireReorder(wrap, repaint);

        // Rename on commit, not on every keystroke: a queued write per character is forty rows
        // in the outbox for one word.
        wrap.addEventListener("change", async (ev) => {
          const inp = ev.target.closest("input[data-rename]");
          if (!inp) return;
          const name = inp.value.trim();
          if (!name) { inp.value = inp.dataset.was; return; }
          if (name === inp.dataset.was) return;
          inp.dataset.was = name;
          const l = currentList();
          await guard(() => (inp.dataset.kind === "view"
            ? S.setPackList(inp.dataset.rename, { name })
            : S.setPackBag(l.key, inp.dataset.rename, { name })), "rename that");
        });

        wrap.addEventListener("click", async (ev) => {
          const b = ev.target.closest("[data-act]");
          if (!b || !wrap.contains(b)) return;
          const act = b.dataset.act;
          const l = currentList();

          if (act === "viewadd") {
            ev.preventDefault();
            const inp = wrap.querySelector("#pk-newview");
            const name = (inp.value || "").trim();
            if (!name) { inp.focus({ preventScroll: true }); return; }
            inp.value = "";
            await guard(() => S.addPackList(name, [NEW_LIST_BAG]), "add that");
            repaint();
            return;
          }
          if (act === "viewdel") {
            ev.preventDefault();
            const key = b.dataset.id;
            const target = S.packLists().find((x) => x.key === key);
            const name = target ? target.name : "this list";
            const held = S.packHeld(key, null);
            if (held) {
              armNote(b, `${held} thing${held === 1 ? " is" : "s are"} on “${name}”. Take ${
                held === 1 ? "it" : "them"} off it first.`);
              return;
            }
            arm(b, `Tap again to delete “${name}”.`, async () => {
              await guard(() => S.deletePackList(key), "delete that list");
              if (listKey === key) listKey = "";
              repaint();
            });
          }
        });
      },
    });
  }

  // Both lists come out of ONE row builder, so the bag rows and the list rows cannot drift
  // into two different arrangements of the same three controls. GRIP · NAME · DELETE, left to
  // right, and the grip carries the row's key and kind so the drag never has to ask which
  // group it is in. data-key is motion.flip()'s handle for the rows that move out of the way.
  function manageHtml(list) {
    const lists = S.packLists();
    const rowFor = (o, kind, extra) => `<div class="pk-mrow" data-key="${esc(o.key)}"
      data-row="${esc(o.key)}">
      <button class="pk-grip" type="button" data-grip="${esc(o.key)}" data-kind="${kind}"
        aria-label="Reorder ${esc(o.name)}">${SVG_GRIP}</button>
      <input class="input" type="text" maxlength="${PACKING_NAME_MAX}" value="${esc(o.name)}"
        data-rename="${esc(o.key)}" data-kind="${kind}" data-was="${esc(o.name)}"
        aria-label="${kind === "view" ? "List" : "Bag"} name">
      ${extra}
    </div>`;
    const blank = `<span class="pk-mbtn" aria-hidden="true"></span>`;

    // A trip keeps at least one list: the last has no delete to tap, rather than one that refuses.
    const listRows = lists.map((l) => rowFor(l, "view", lists.length > 1
      ? `<button class="pk-mbtn" type="button" data-act="viewdel" data-id="${esc(l.key)}" data-destroys
           aria-label="Delete list ${esc(l.name)}">${SVG_TRASH}</button>`
      : blank)).join("");

    return `      <div class="stack-tight pk-mlist" data-reorder="view">${listRows}</div>
      <div class="pk-mrow">
        <input class="input" id="pk-newview" type="text" maxlength="${PACKING_NAME_MAX}" placeholder="Add a list"
          aria-label="New list name">
        <button class="btn" type="button" data-act="viewadd">Add</button>
      </div>
      <p class="pk-mnote">Lists are the whole trip's. A change here is a change for everyone.</p>`;
  }

  // ── drag to reorder bags and lists ────────────────────────────────────────
  // ONE handler for both lists in the Bags sheet. Bound to the sheet, not to the rows, because
  // repaint() replaces every row wholesale and a per-row listener would have to be re-bound
  // after each rename.
  //
  // THE GESTURE. Pointer down ON THE GRIP starts the drag in the same event — no long-press,
  // no slop threshold to cross first. That is only safe because the grip is a 44px target that
  // does nothing else: on a row, an immediate drag would eat every scroll that started there,
  // which is exactly why the item list is not draggable at all (see the file header).
  //
  // THE ANIMATION. The row in the hand follows the finger on a transform. Everything it
  // displaces is moved by motion.flip(): the DOM is genuinely reordered the moment the drag
  // crosses a neighbour's midpoint, and flip measures-inverts-plays the rows that shifted. So
  // what is on screen is always the real order — drop is a write, never a rearrangement — and
  // reduced motion lands every one of those steps instantly with the same result.
  //
  // THE WRITE. On drop, each row whose place changed is given its new position through the
  // store (saveOrder below), so offline queueing and rebasing work as for any other write.
  // Only the rows that moved are written: a bag someone else added while this phone was
  // offline keeps the position they gave it.
  function saveOrder(kind, order) {
    const l = currentList();
    return guard(async () => {
      for (const [i, key] of order.entries()) {
        if (kind === "sec") { if (l) await S.setPackBag(l.key, key, { sort: i }); }
        else await S.setPackList(key, { sort: i });
      }
    }, "reorder that");
  }
  function wireReorder(wrap, repaint) {
    let drag = null;
    const rowsOf = (list) => [...list.children].filter((n) => n.classList.contains("pk-mrow"));

    // Where the dragged row belongs now: the neighbours whose midpoint it has passed.
    //
    // Measured from offsetTop, NOT getBoundingClientRect. A rect includes any FLIP animation
    // still in flight, so on a fast drag the rows that are mid-slide report where they are
    // rather than where they are going, and the crossings come out different at 60fps than
    // under prefers-reduced-motion — the same gesture, two different results. offsetTop is
    // settled layout, so the swap points are the same in both. (.pk-mlist is position:
    // relative and has no border or padding, so every row's offsetTop is measured from the
    // list's own box.)
    function considerSwap(clientY) {
      const base = drag.list.getBoundingClientRect().top;
      const layoutMid = (n) => base + n.offsetTop + n.offsetHeight / 2;
      const mid = layoutMid(drag.row) + drag.dy;
      const sibs = rowsOf(drag.list).filter((n) => n !== drag.row);
      let target = null, before = false;
      for (const s of sibs) {
        const sMid = layoutMid(s);
        const sIsBefore = !!(drag.row.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_PRECEDING);
        if (sIsBefore && mid < sMid) { target = s; before = true; break; }
        if (!sIsBefore && mid > sMid) { target = s; before = false; }
      }
      if (!target) return;

      // Re-base the finger. Reordering moves the dragged row's own layout box, and without
      // subtracting that the row would jump by a full row height on every swap.
      const wasOff = drag.row.offsetTop;
      flip(drag.list, () => {
        if (before) drag.list.insertBefore(drag.row, target);
        else target.after(drag.row);
      }, { duration: ms("--dur-fast", 120) });
      drag.startY += drag.row.offsetTop - wasOff;
      drag.dy = clientY - drag.startY;
      drag.row.style.transform = `translate3d(0,${drag.dy}px,0)`;
      drag.changed = true;
    }

    // A drag that reaches the edge of the sheet's scrollport pulls it along. Per pointermove
    // rather than on a timer: no loop to leak if the pointer is lost, and a finger parked
    // dead still at the edge is not asking for anything to happen.
    function edgeScroll(clientY) {
      const port = drag.list.closest(".sh-body");
      if (!port) return;
      const r = port.getBoundingClientRect();
      const zone = 44;
      let by = 0;
      if (clientY < r.top + zone) by = -10;
      else if (clientY > r.bottom - zone) by = 10;
      if (!by) return;
      const before = port.scrollTop;
      port.scrollTop += by;
      // The list scrolled under the finger, so the finger's origin moved with it.
      drag.startY -= port.scrollTop - before;
    }

    wrap.addEventListener("pointerdown", (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      const grip = ev.target.closest(".pk-grip");
      if (!grip || !wrap.contains(grip)) return;
      const row = grip.closest(".pk-mrow");
      const list = row && row.parentElement;
      if (!list || !list.classList.contains("pk-mlist")) return;
      if (rowsOf(list).length < 2) return;               // nothing to reorder against
      try { grip.setPointerCapture(ev.pointerId); } catch { /* mouse on some engines */ }
      drag = {
        row, list, grip, kind: list.dataset.reorder, id: ev.pointerId,
        startY: ev.clientY, dy: 0, changed: false,
      };
      row.classList.add("pk-mdrag");
      // flip() must not also animate the row the finger is holding: it would fight the
      // transform written here and the row would travel twice.
      row.removeAttribute("data-key");
      if (navigator.vibrate) navigator.vibrate(6);
    });

    wrap.addEventListener("pointermove", (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      ev.preventDefault();
      edgeScroll(ev.clientY);
      drag.dy = ev.clientY - drag.startY;
      drag.row.style.transform = `translate3d(0,${drag.dy}px,0)`;
      considerSwap(ev.clientY);
    });

    const drop = async (ev) => {
      if (!drag || (ev && ev.pointerId !== drag.id)) return;
      const d = drag;
      drag = null;
      try { d.grip.releasePointerCapture(d.id); } catch { /* already gone */ }
      d.row.classList.remove("pk-mdrag");
      d.row.dataset.key = d.row.dataset.row;             // keyed again for the next flip
      d.row.style.transform = "";
      // The settle plays TO the resting style — nothing is filled forwards — so a phone that
      // sleeps mid-animation wakes up with the row exactly where the DOM already says it is.
      let settle = null;
      if (d.dy && !reducedMotion()) {
        settle = d.row.animate(
          [{ transform: `translate3d(0,${d.dy}px,0)` }, { transform: "none" }],
          { duration: ms("--dur-fast", 120), easing: springEase() });
      }
      if (!d.changed) return;
      const order = rowsOf(d.list).map((n) => n.dataset.row);
      await saveOrder(d.kind, order);
      if (settle) await settle.finished.catch(() => {});
      // Repaint from the cache rather than trusting the nodes we just moved: it is the same
      // order on the happy path, and the honest one if the write was refused.
      //
      // `drag` again means a SECOND drag started inside the ~150ms this one spent settling.
      // Rebuilding now would detach the row that finger is holding, and the next drop would
      // save an order read off dead nodes. The new drag repaints when it lands.
      if (!dead && sheet && !drag) repaint();
    };
    wrap.addEventListener("pointerup", drop);
    wrap.addEventListener("pointercancel", drop);

    // The keyboard path the two arrow buttons used to be. A grip that only answers to a
    // pointer would take reordering away from anyone who cannot make that gesture, and the
    // arrows were the only thing providing it before.
    wrap.addEventListener("keydown", async (ev) => {
      if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
      const grip = ev.target.closest(".pk-grip");
      if (!grip || !wrap.contains(grip)) return;
      const row = grip.closest(".pk-mrow");
      const list = row && row.parentElement;
      if (!list || !list.classList.contains("pk-mlist")) return;
      const rows = rowsOf(list);
      const i = rows.indexOf(row);
      const j = i + (ev.key === "ArrowUp" ? -1 : 1);
      if (i < 0 || j < 0 || j >= rows.length) return;
      ev.preventDefault();
      const played = flip(list, () => {
        if (ev.key === "ArrowUp") list.insertBefore(row, rows[j]);
        else rows[j].after(row);
      }, { duration: ms("--dur-fast", 120) });
      const order = rowsOf(list).map((n) => n.dataset.row);
      await saveOrder(list.dataset.reorder, order);
      // Let the slide finish before the rebuild replaces the nodes playing it.
      await played;
      if (dead || !sheet || drag) return;
      repaint();
      const again = wrap.querySelector(`[data-grip="${attrEsc(row.dataset.row)}"]`);
      if (again) again.focus({ preventScroll: true });
    });
  }

  // ── long-press: the accelerator for the move sheet ────────────────────────────────────
  // A visible button already does this (.pk-move). Long-press is the shortcut for the hand
  // that is already on the row, and it is deliberately NOT the only way in — a hidden gesture
  // as the sole affordance for the screen's main verb is how a feature goes unused. 450 ms
  // and an 8 px slop, so a scroll that starts on a row never fires it.
  let press = null;
  let swallowClick = false;
  root.addEventListener("pointerdown", (ev) => {
    // A new press: whatever click the last press-and-hold was waiting to swallow never came
    // here (the sheet it opened was under the finger when it lifted). Without this the NEXT
    // tap on the list, whenever it came, was the one swallowed.
    swallowClick = false;
    if (ev.button !== undefined && ev.button !== 0) return;
    const li = ev.target.closest(".pk-item");
    if (!li || !root.contains(li)) return;
    if (ev.target.closest('[data-act="move"]')) return;   // the button handles itself
    const id = li.dataset.id;
    press = {
      id, x: ev.clientX, y: ev.clientY,
      timer: setTimeout(() => {
        press = null;
        const row = itemById(id);
        if (!row || !canTick(row)) return;
        swallowClick = true;
        if (navigator.vibrate) navigator.vibrate(9);
        openWhere(row);
      }, 450),
    };
  });
  function cancelPress(ev) {
    if (!press) return;
    if (ev && ev.type === "pointermove" &&
        Math.abs(ev.clientX - press.x) < 8 && Math.abs(ev.clientY - press.y) < 8) return;
    clearTimeout(press.timer);
    press = null;
  }
  // One scroll listener feeds two consumers: cancelling a long-press, and the "no animation
  // while the finger is scrolling" guardrail (scrolling(), above) for every animated rebuild.
  const onScrollCancel = () => { lastScrollAt = Date.now(); cancelPress(null); };
  root.addEventListener("pointermove", cancelPress);
  root.addEventListener("pointerup", cancelPress);
  root.addEventListener("pointercancel", cancelPress);
  el.addEventListener("scroll", onScrollCancel, { passive: true });

  // ── events ────────────────────────────────────────────────────────────────────────────
  root.addEventListener("click", (ev) => {
    // The click that follows a long-press must not also tick the row it opened the sheet from.
    if (swallowClick) { swallowClick = false; ev.preventDefault(); ev.stopPropagation(); return; }
    const b = ev.target.closest("[data-act]");
    if (!b || !root.contains(b)) return;
    const act = b.dataset.act;
    const li = b.closest("[data-id]");
    const id = li ? li.dataset.id : null;

    if (act === "add-item") { openEditor("new", null, ""); return; }
    if (act === "owner") {
      tab = b.dataset.tab === "group" ? "group" : "mine";
      LS.set(K_TAB, tab);
      listKey = "";                      // each tab remembers its own list
      el.scrollTop = 0;
      render();
      return;
    }
    if (act === "view") {
      switchList(b.dataset.view);
      const next = root.querySelector('[role="radio"][aria-checked="true"]');
      if (next) next.focus({ preventScroll: true });
      return;
    }
    if (act === "tick") { toggle(id); return; }
    if (act === "move") {
      const row = itemById(id);
      if (row) openWhere(row);
      return;
    }
    if (act === "new") { openEditor("new", null, b.dataset.section || ""); return; }
    if (act === "fold") {
      const k = foldKey(b.dataset.section);
      folded[k] = !folded[k];
      LS.set(here(K_FOLD), JSON.stringify(folded));
      render();
      return;
    }
    if (act === "hide") {
      hideDone = !hideDone;
      LS.set(K_HIDE, hideDone ? "1" : "0");
      // The packed rows fold away and the rest close up (200 ms, the mock-up's): one animated rebuild, as a tick.
      animate(() => flipRender({ duration: ms("--dur-200", 200) }));
      return;
    }
    if (act === "managebags") { openManage(); return; }
    // This does not write. It opens the preview, and the write happens on its confirm — see
    // confirmSeed().
    if (act === "seed") {
      const owner = ownerFor(tab);
      if (!owner) return;                  // identity not known yet; the seeder needs an owner
      const offer = starterOffer(owner);
      if (offer) confirmSeed(owner, offer);
      return;
    }
  });

  // Arrow keys on both strips, because that is what a tablist and a radiogroup are supposed
  // to do and both are only two or three buttons wide.
  root.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    const dir = ev.key === "ArrowRight" ? 1 : -1;

    if (ev.target.closest('[role="tab"]')) {
      ev.preventDefault();
      tab = tab === "mine" ? "group" : "mine";
      LS.set(K_TAB, tab);
      listKey = "";
      render();
      const next = root.querySelector('[role="tab"][aria-selected="true"]');
      if (next) next.focus({ preventScroll: true });
      return;
    }
    if (ev.target.closest('[role="radio"]')) {
      ev.preventDefault();
      const lists = S.packLists();
      const cur = currentList();
      if (!cur || lists.length < 2) return;
      const i = lists.findIndex((l) => l.key === cur.key);
      switchList(lists[(i + dir + lists.length) % lists.length].key);
      const next = root.querySelector('[role="radio"][aria-checked="true"]');
      if (next) next.focus({ preventScroll: true });
    }
  });

  // IN THE ROUTER'S FIXED LAYER, not inside #view. A view being routed away from is animated
  // by a transform, and a transformed element becomes the containing block for its fixed
  // descendants — so while it lived in #view this button rode the route transition out and
  // back, which is the "flickers off then on" when you leave Memories for Pack. Memories'
  // button was already in the layer, so it just sat there; the two behaved differently for
  // no reason a person could see. Now neither one is inside the thing that moves.
  // BOTTOM-RIGHT: the bottom-left belongs to the shell's dock.
  const fabLayer = ctx.router.fixedLayer();
  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "fab ds ds-fab pk-fab";
  fab.setAttribute("aria-label", "Add an item");
  fab.innerHTML = SVG_PLUS;
  fab.addEventListener("click", () => {
    openEditor("new", null, "");
  });
  fabLayer.append(fab);

  const offChange = S.on("change", () => scheduleRender());

  render();

  return () => {
    dead = true;
    fab.remove();                        // it is not inside `el` any more; unmount must take it
    offChange();
    cancelAnimationFrame(raf);
    if (press) clearTimeout(press.timer);
    // close(), not remove(): the sheet holds the rest of the app `inert` while it is up, and
    // ripping its node out would leave #view and the tab bar unreachable on the next screen.
    // Nulling `sheet` first means the deferred onClose finds nothing to do.
    if (sheet) {
      const { api, armTimer } = sheet;
      clearTimeout(armTimer);
      sheet = null;
      api.close();
    }
    el.removeEventListener("scroll", onScrollCancel);
    fab.remove();
    root.remove();
  };
}

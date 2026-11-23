// Shared icon + category-colour module. Imported by places.js (list rows), map.js (pins) and
// anything else that has to draw a place.
//
// WHY THIS EXISTS, stated once: every practical place used to draw the same `+`. That is
// unreadable exactly when it matters — you have already filtered to Practical, so the filter
// has removed the only thing that was telling the rows apart, and a screen of 134 identical
// crosses is a screen with no information on it. So the unit of identity here is the
// SUBKIND, not the kind.
//
// THE COLOUR RULE (a strict accessibility requirement, not a style preference):
// no two icons or states may differ by hue alone. The app is used on daltonized displays, and
// the seven category hues below collapse under deuteranopia into roughly two clusters —
// "yellowish" (practical, food, sight, activity, lodging) and "bluish" (drink, transit). That
// is measured, not assumed. It is survivable ONLY because the glyph is the signal and the
// colour is the reinforcement. Concretely: pharmacy is a capsule pill and clinic is a cross
// inside a SHIELD; they are told apart by shape at 22px, and green-vs-red merely agrees.
//
// A consequence worth stating: adding a new subkind that reuses an existing glyph and relies
// on the category tint to disambiguate is a bug, not a shortcut.
//
// Glyphs are 24x24, stroke-only, drawn to match the stroke weight the rest of the app uses.
// Filled details carry an explicit fill/stroke so the shared `.ico` rule cannot flatten them.

import { SUBKINDS, spelledSubkind, subkind as subkindEntry } from "./shared/place-kinds.js";

// ── categories ─────────────────────────────────────────────────────────────────────────
// The seven place kinds. The colours are CSS custom properties, never literals, because the
// app has four theme states (system-light, system-dark, forced-light, forced-dark) and a
// literal here would be wrong in two of them. See the --cat-* block in styles.css for the
// measured contrast ratios.

export const CATEGORIES = ["practical", "food", "drink", "sight", "activity", "lodging", "transit"];

export const CATEGORY_LABEL = {
  practical: "Practical",
  food: "Food",
  drink: "Drink",
  sight: "Sights",
  activity: "Do",
  lodging: "Stays",
  transit: "Transit",
};

// Display aliases use "sights / do / stays"; the database columns say
// "sight / activity / lodging". Both spellings resolve, so neither side has to be edited to
// match the other. Event kinds fold in too: an event and the place it happens at should not
// carry two different hues for the same thing.
const KIND_ALIAS = {
  sights: "sight", sightseeing: "sight", see: "sight",
  do: "activity", activities: "activity",
  stay: "lodging", stays: "lodging", hotel: "lodging", accommodation: "lodging",
  eat: "food", meal: "food", restaurant: "food",
  drinks: "drink", bar: "drink",
  transport: "transit", flight: "transit", travel: "transit",
  plan: "practical", admin: "practical", practicalities: "practical",
};

/** Normalise anything the data or a caller hands us to one of the seven CATEGORIES. */
export function categoryOf(kind) {
  const k = String(kind || "").trim().toLowerCase();
  if (CATEGORIES.includes(k)) return k;
  return Object.hasOwn(KIND_ALIAS, k) ? KIND_ALIAS[k] : "practical";
}

// The ink colour for a category: glyph on a plain surface, chip text, pin fill.
export const CATEGORY_COLOR = {
  practical: "var(--cat-practical)",
  food: "var(--cat-food)",
  drink: "var(--cat-drink)",
  sight: "var(--cat-sight)",
  activity: "var(--cat-activity)",
  lodging: "var(--cat-lodging)",
  transit: "var(--cat-transit)",
};
// The tinted wash the ink is allowed to sit on (soft tile behind a glyph, selected chip).
export const CATEGORY_SOFT = {
  practical: "var(--cat-practical-soft)",
  food: "var(--cat-food-soft)",
  drink: "var(--cat-drink-soft)",
  sight: "var(--cat-sight-soft)",
  activity: "var(--cat-activity-soft)",
  lodging: "var(--cat-lodging-soft)",
  transit: "var(--cat-transit-soft)",
};
// The ink that sits ON the solid CATEGORY_COLOR — i.e. when the category colour is used as a
// BACKGROUND, which is what a map pin does. Every pair below was measured at >= 6.1:1, so the
// glyph inside a pin is never the thing that goes missing in glare.
export const CATEGORY_ON = {
  practical: "var(--cat-practical-on)",
  food: "var(--cat-food-on)",
  drink: "var(--cat-drink-on)",
  sight: "var(--cat-sight-on)",
  activity: "var(--cat-activity-on)",
  lodging: "var(--cat-lodging-on)",
  transit: "var(--cat-transit-on)",
};

/**
 * Inline style string binding the three local aliases --cat / --cat-soft / --cat-on to one
 * category, so a row or a pin can be written once against the aliases and re-tinted by
 * changing one attribute:
 *   <li style="${catVars(p.kind)}"> ... background: var(--cat-soft); color: var(--cat);
 */
export function catVars(kind) {
  const c = categoryOf(kind);
  return `--cat:${CATEGORY_COLOR[c]};--cat-soft:${CATEGORY_SOFT[c]};--cat-on:${CATEGORY_ON[c]}`;
}

/**
 * Resolve a category to a real colour string for the CURRENT theme.
 * MapLibre paint properties are evaluated on a canvas and cannot read a CSS variable, so the
 * map has to resolve first and re-resolve when the theme changes. Everything drawn in DOM
 * should use CATEGORY_COLOR / catVars() instead and let the cascade do it.
 */
export function catColorValue(kind, which = "ink") {
  const c = categoryOf(kind);
  const name = which === "soft" ? `--cat-${c}-soft` : which === "on" ? `--cat-${c}-on` : `--cat-${c}`;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ── glyphs ─────────────────────────────────────────────────────────────────────────────
// Keyed by icon id, not by subkind: GLYPH_OF below says which subkind draws which.

const G = {
  // — money & shops —
  atm:
    // A dollar sign, drawn rather than typeset: <text> in an SVG depends on a font that may
    // not have loaded yet, and this glyph has to be right on a cold offline launch.
    '<path d="M15.6 8.1c-.9-1.1-2.2-1.7-3.7-1.7-2.1 0-3.5 1.1-3.5 2.7 0 3.9 7.6 1.8 7.6 5.8 0 1.8-1.6 3-3.9 3-1.7 0-3.2-.6-4.2-1.8"/><path d="M12 4v16"/>',
  exchange:
    '<path d="M3.2 8.8h15.6M15 5l3.8 3.8L15 12.6"/><path d="M20.8 16.2H5.2M9 12.4l-3.8 3.8L9 20"/>',
  cart:
    '<path d="M2.6 4h2.2l2.6 10.9h9.9"/><path d="M6.6 7.6h14.4l-1.9 6.3"/><circle cx="9.4" cy="19" r="1.6"/><circle cx="17.2" cy="19" r="1.6"/>',
  stall:
    // Market: awning with a scalloped edge over two posts.
    '<path d="M3 9.2 5.4 4h13.2L21 9.2"/><path d="M3 9.2c1.5 0 1.5 1.6 3 1.6s1.5-1.6 3-1.6 1.5 1.6 3 1.6 1.5-1.6 3-1.6 1.5 1.6 3 1.6 1.5-1.6 3-1.6"/><path d="M5.4 12v8.5M18.6 12v8.5M5.4 20.5h13.2"/>',
  storefront24:
    // Convenience store — and what this glyph has to say is OPEN LATE, not "shop". An awning
    // over posts is already `stall` (market), so the shopfront here is a walled building with
    // a doorway, and the clock is the actual message; the building is only the noun the
    // message hangs on.
    // CONFUSABLE WITH `washer` (laundry), and this is the third draft, because the first two
    // both lost to it. Draft 1 was a box with a horizontal fascia band and a circle under it,
    // which is a washing machine drawn exactly. Draft 2 dropped the band and moved the dial
    // off-centre; that survived a sharp 22px render and then failed the honest test — blurred
    // to simulate the bad light this glyph is FOR, a full-width box with interior detail is a
    // rectangle full of mush, and so is a washer, and mush does not disambiguate. The
    // collision matters more than it sounds: laundry is tier 2 and this is tier 1.
    // What fixes it is not more interior detail but a SILHOUETTE a rounded box cannot make.
    // The shop is now narrow — it occupies the left half only — and the clock is a disc on
    // its top-right CORNER, crossing the eave line, so the outer boundary is a rectangle with
    // a round lobe growing out of one corner. That reads at 16px, it reads under blur, and no
    // other glyph in the set has it: washer is a symmetric rounded box with a centred ring,
    // `fuel` puts a thin arm (not a disc) out to the right, `info` is a bare circle with no
    // box, `locker` is a plain portrait rectangle, and `house`/`village`/`museum` are all
    // pitched or pedimented where this is dead flat. Shrinking the building also let the disc
    // grow to r=5.4 from 4.1, which is what keeps the 12-and-3 hands resolvable rather than
    // collapsing to a filled dot — the hands are the part that says OPEN LATE, and "open
    // late" is the whole message. The building is just the noun it hangs on.
    '<path d="M1.4 7.4h11.4"/><path d="M3.2 20.8V7.4M11.2 20.8V7.4"/><path d="M1.4 20.8h11.4"/><path d="M5 20.8v-6.6h3.8v6.6"/><circle cx="16.9" cy="9.2" r="5.4"/><path d="M16.9 5.8v3.4h2.8"/>',
  bag:
    '<path d="M6.2 7.6h11.6l1.1 12.9H5.1L6.2 7.6Z"/><path d="M9.2 7.6V6a2.8 2.8 0 0 1 5.6 0v1.6"/>',
  briefcase:
    '<rect x="2.8" y="7.2" width="18.4" height="12.6" rx="2"/><path d="M9 7.2V5.6A1.6 1.6 0 0 1 10.6 4h2.8A1.6 1.6 0 0 1 15 5.6v1.6"/><path d="M2.8 12.4h18.4"/>',

  // — health. The pair the whole colour rule exists for. —
  pill:
    // Pharmacy: a 45° tilted capsule pill, so it never reads as an Add "+" button beside the FAB
    // (list row icons, map pins, chips). `crossShield` remains the clinic's shield+cross.
    '<path d="M10.5 20.5a4.95 4.95 0 0 1-7-7l10-10a4.95 4.95 0 0 1 7 7l-10 10Z"/><path d="m8.5 8.5 7 7"/>',
  crossShield:
    '<path d="M12 3.1 19.4 5.6v6.1c0 4.5-3 7.5-7.4 9.2-4.4-1.7-7.4-4.7-7.4-9.2V5.6L12 3.1Z"/><path d="M12 8.3v6M9 11.3h6"/>',
  tooth:
    // Dentist. CONFUSABLE WITH `cloche` (fine dining) and, at a squint, `egg` — all three are
    // a dome. The dome is where the resemblance ends: cloche closes onto a flat plate line
    // and egg closes on itself, whereas this one is OPEN at the bottom and forked into two
    // splayed roots, so the identifying information lives in the lower half of the silhouette
    // rather than the outline of the top. Molar, not incisor, for exactly that reason: an
    // incisor is a single tapering blob at 22px and has no lower half worth reading. The dip
    // between the two cusps up top is the second cue and the first one to go when it shrinks.
    '<path d="M4.4 9.2C4.4 5.6 5.4 3.4 7.4 3.4 9.2 3.4 10.4 5 12 5 13.6 5 14.8 3.4 16.6 3.4 18.6 3.4 19.6 5.6 19.6 9.2 19.6 12.4 18.4 15.6 17.8 18.4 17.4 20.4 17 21.4 16.2 21.4 15.2 21.4 14.9 20.2 14.6 18 14.2 15.2 13.6 12.8 12 12.8 10.4 12.8 9.8 15.2 9.4 18 9.1 20.2 8.8 21.4 7.8 21.4 7 21.4 6.6 20.4 6.2 18.4 5.6 15.6 4.4 12.4 4.4 9.2Z"/>',

  // — services —
  washer:
    '<rect x="3.2" y="3.2" width="17.6" height="17.6" rx="2.4"/><path d="M3.2 8h17.6"/><circle cx="12" cy="14.4" r="4.2"/><circle cx="6.6" cy="5.6" r=".95" fill="currentColor" stroke="none"/><path d="M9.6 5.6h8"/>',
  sim:
    '<path d="M6.6 3h6.9L18.6 8v11.5a1.5 1.5 0 0 1-1.5 1.5H6.6a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 6.6 3Z"/><rect x="8.4" y="10.4" width="7.2" height="7" rx="1.2"/><path d="M8.4 13.9h7.2M12 10.4v7"/>',
  locker:
    // Luggage storage. A bank of lockers, not a suitcase: the suitcase shape is already the
    // briefcase, and what is being named is the shop, not the bag.
    '<rect x="4" y="3" width="16" height="18" rx="1.8"/><path d="M4 12h16"/><circle cx="16.6" cy="7.4" r=".95" fill="currentColor" stroke="none"/><circle cx="16.6" cy="16.6" r=".95" fill="currentColor" stroke="none"/><path d="M7 6.6h4.6M7 15.8h4.6"/>',
  toilet:
    '<path d="M7 3.4h3.6v6.4"/><path d="M4.8 9.8h12.6a1 1 0 0 1 1 1.1c-.35 3.4-2.4 6-5.3 6.8v3.9H8.4"/><path d="M6.2 9.8v1.6c0 3.1 2.2 5.6 5 6.1"/>',
  bolt:
    // Hardware / ferreteria. CONFUSABLE WITH `nut`, which is the same trade drawn with the
    // same hexagon, so the hexagon cannot be what tells them apart. This one is a HEAD ON A
    // SHANK: a wide flat-topped hex cap over a narrow threaded shaft with a rounded tip. nut
    // is a single pointy-topped hexagon that fills the whole box and is bored through the
    // middle. Top-heavy-with-a-stem versus big-ring: the two silhouettes disagree everywhere
    // below y=10, which is the half a thumb does not cover. Two thread bands, not four —
    // 3.4px apart, because 1.7px stroke at 22px closes any gap tighter than about 2px.
    '<path d="M8.8 3.2h6.4l3.2 3.2-3.2 3.2H8.8L5.6 6.4l3.2-3.2Z"/><path d="M9.6 9.6v8.6a2.4 2.4 0 0 0 4.8 0V9.6"/><path d="M9.6 12.6h4.8M9.6 16h4.8"/>',
  shieldStar:
    // Police. CONFUSABLE WITH `crossShield` (clinic) — and that is the one confusion this
    // whole file exists to prevent, because red-versus-green cannot carry it for a
    // red-green-deficient reader. So both halves are made to differ, not just the fill:
    //   outline — a badge with two raised ears and a notched top, against crossShield's
    //             flat-topped heater shield. The silhouettes differ before any interior mark
    //             is resolved, which is the only property that survives at 22px in bad light.
    //   mark    — a SOLID five-point star, against an outlined cross. Solid so it stays a
    //             star and not a five-armed asterisk when 1.7px stroke would have eaten the
    //             notches at r=1.83.
    // Not bare `star` (the activity fallback) either: that one is an open outline with
    // nothing enclosing it.
    '<path d="M4.2 4.2C8.2 4.7 10.5 5.5 12 6.6 13.5 5.5 15.8 4.7 19.8 4.2 20.3 8.3 20.2 11.6 19.4 14.1 18.3 17.6 15.5 20.2 12 21.6 8.5 20.2 5.7 17.6 4.6 14.1 3.8 11.6 3.7 8.3 4.2 4.2Z"/><path d="M12 8.8 13.08 11.72 16.19 11.84 13.74 13.77 14.59 16.76 12 15.03 9.41 16.76 10.26 13.77 7.81 11.84 10.92 11.72Z" fill="currentColor" stroke="none"/>',
  info:
    '<circle cx="12" cy="12" r="8.8"/><path d="M12 11.2v5.4"/><circle cx="12" cy="7.9" r="1.15" fill="currentColor" stroke="none"/>',
  shower:
    '<path d="M12 3v3.6"/><path d="M5.6 12.6a6.4 6.4 0 0 1 12.8 0Z"/><path d="M8.4 16.2v1.4M12 17.4v1.6M15.6 16.2v1.4M10.2 19.6v1.2M13.8 19.6v1.2"/>',
  bottleWater:
    // Drinking water — practical, not drink, which is exactly why it lives here and not next
    // to the bar glyphs. CONFUSABLE WITH `bottle` (pisco / spirits), a shouldered bottle with
    // a long narrow neck. This one is a canteen instead: straight parallel sides, a squat
    // screw cap wider than its neck, no shoulder taper at all. Three cues, and they fail in a
    // useful order — the wave across the middle is the last thing to go at 22px and it is
    // also the one that says the contents are water rather than that the object is a vessel.
    '<rect x="8.8" y="2.6" width="6.4" height="3" rx=".9"/><path d="M9.6 7.6V5.6h4.8v2"/><rect x="6.8" y="7.6" width="10.4" height="13.6" rx="2.6"/><path d="M7.9 15.6c1.4-2 2.7-2 4.1 0s2.7 2 4.1 0"/>',
  fuel:
    '<path d="M4.4 20.8V5.4A1.9 1.9 0 0 1 6.3 3.5h5.6a1.9 1.9 0 0 1 1.9 1.9v15.4"/><path d="M2.8 20.8h12.6"/><rect x="6.6" y="6.6" width="4.9" height="3.6" rx=".8"/><path d="M13.8 8.6h2.4a1.7 1.7 0 0 1 1.7 1.7v5.5a1.6 1.6 0 0 0 3.2 0V9.5l-2.3-2.3"/>',
  backpack:
    '<path d="M6.6 9.4a5.4 5.4 0 0 1 10.8 0v9.4a2.2 2.2 0 0 1-2.2 2.2H8.8a2.2 2.2 0 0 1-2.2-2.2V9.4Z"/><path d="M9.4 9.4V6.9a2.6 2.6 0 0 1 5.2 0v2.5"/><path d="M6.6 13.6h10.8"/><path d="M10 17.2h4"/>',
  flag:
    '<path d="M6 21V3.4"/><path d="M6 4.6h11.6l-2.2 3.5 2.2 3.5H6"/>',
  barrier:
    // Checkpoint. A boom gate with its hatching — used by practical, activity and transit
    // alike, because a control post is the same object whichever list found it.
    '<path d="M4.4 21V4.2"/><path d="M4.4 9.6h14.2a1.8 1.8 0 0 1 0 3.6H4.4"/><path d="M8 9.6l-2.4 3.6M12 9.6l-2.4 3.6M16 9.6l-2.4 3.6"/>',

  // — food —
  cutlery:
    '<path d="M7 3.2v5.2a2.4 2.4 0 0 0 4.8 0V3.2"/><path d="M9.4 3.2v5.2M9.4 10.8V21"/><path d="M17.2 3.2c1.7 1.8 2.6 4 2.6 6.6 0 1.6-1 2.7-2.6 2.7V3.2Z"/><path d="M17.2 12.5V21"/>',
  bowl:
    '<path d="M2.6 11.4h18.8a9.4 9.4 0 0 1-18.8 0Z"/><path d="M1.6 11.4h20.8"/><path d="M8.4 8.2c0-1.3 1.2-1.6 1.2-2.9M12 8.2c0-1.3 1.2-1.6 1.2-2.9M15.6 8.2c0-1.3 1.2-1.6 1.2-2.9"/>',
  cup:
    '<path d="M3.6 7.8h12.8v5.6a5.4 5.4 0 0 1-5.4 5.4H9a5.4 5.4 0 0 1-5.4-5.4V7.8Z"/><path d="M16.4 9.2h1.4a2.6 2.6 0 0 1 0 5.2h-1.4"/><path d="M2.4 21.2h15.2"/><path d="M7.6 5.2c0-1.1 1.2-1.4 1.2-2.6M12 5.2c0-1.1 1.2-1.4 1.2-2.6"/>',
  loaf:
    '<path d="M3.6 13.6C3.6 9.9 7.4 7 12 7s8.4 2.9 8.4 6.6v3.2a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6v-3.2Z"/><path d="M8.6 9.5 7 12.9M12.4 9.1l-1.6 3.4M16.2 9.8l-1.6 3.4"/>',
  cone:
    '<path d="M12 3.2a5.2 5.2 0 0 0-5.2 5.2c0 .6.1 1.2.3 1.7h9.8c.2-.5.3-1.1.3-1.7A5.2 5.2 0 0 0 12 3.2Z"/><path d="M7.4 10.6 12 21l4.6-10.4"/>',
  leaf:
    // Nature (waterfalls, lakes, caves, canyons). A waterfall was drawn three ways and each
    // blurred to mush at 15px; the leaf keeps its outline. `tree` (a pine) is the park.
    '<path d="M20.4 3.6c0 9.4-5.2 14.2-11.6 14.2H4.4C4.4 9.6 10.6 3.6 20.4 3.6Z"/><path d="M4.4 21c1.6-4.8 4.4-8.2 8.8-10.4"/>',

  // — drink —
  martini:
    '<path d="M4 4.4h16L12 13.2 4 4.4Z"/><path d="M12 13.2V20.4"/><path d="M8 20.4h8"/>',
  wine:
    '<path d="M7.6 3.4h8.8v3.9a4.4 4.4 0 0 1-8.8 0V3.4Z"/><path d="M12 11.7v8.7M8.2 20.4h7.6"/>',

  // — sights —
  ruin:
    '<path d="M3 20.8h18"/><path d="M5.4 20.8V9.6h3.4v11.2"/><path d="M5.4 9.6 7.1 7.4l1.7 2.2"/><path d="M11.6 20.8v-6.4H15v6.4"/><path d="M17.8 20.8v-3.6h3v3.6"/>',
  binoculars:
    '<rect x="3.2" y="8.2" width="6.6" height="12.4" rx="3.3"/><rect x="14.2" y="8.2" width="6.6" height="12.4" rx="3.3"/><path d="M9.8 13h4.4"/><path d="M5.6 8.2V5.4a1.6 1.6 0 0 1 1.6-1.6h.4M18.4 8.2V5.4a1.6 1.6 0 0 0-1.6-1.6h-.4"/>',
  church:
    '<path d="M12 2.2v4.4M10 4.2h4"/><path d="M6.2 21V10.2L12 6.4l5.8 3.8V21"/><path d="M3.6 21h16.8"/><path d="M10.2 21v-3.8a1.8 1.8 0 0 1 3.6 0V21"/>',
  museum:
    '<path d="M2.6 9.2 12 4l9.4 5.2"/><path d="M4.6 9.6v8.6M8.8 9.6v8.6M15.2 9.6v8.6M19.4 9.6v8.6"/><path d="M2.8 18.4h18.4M2.2 21h19.6"/>',
  fountain:
    '<path d="M12 4.6v4.2"/><path d="M12 8.8c-2.6 0-4.6 1.9-4.6 4.2M12 8.8c2.6 0 4.6 1.9 4.6 4.2"/><path d="M6 13h12l-1.3 6a2 2 0 0 1-2 1.6H9.3a2 2 0 0 1-2-1.6L6 13Z"/><path d="M4.2 20.6h15.6"/>',
  tree:
    '<path d="M12 3.2 7.4 10.6h9.2L12 3.2Z"/><path d="M12 7.6 4.6 18h14.8L12 7.6Z"/><path d="M12 18v3M9 21h6"/>',
  pass:
    '<path d="M2 20.4h20"/><path d="M2.8 20.4 8.6 9.4l3.4 6.2"/><path d="M12 15.6l3.4-6.2 5.8 11"/><path d="M12 15.6v-3.2M10.2 12.4h3.6"/>',
  obelisk:
    '<path d="M12 2.4 15.4 8.4v10.2H8.6V8.4L12 2.4Z"/><path d="M6.2 21.2h11.6M8.6 18.6h6.8"/>',
  village:
    '<path d="M2.2 12.4 6.8 8.2l4.6 4.2v8h-9.2v-8Z"/><path d="M12.6 14.4 17.2 10.2l4.6 4.2v6h-9.2v-6Z"/><path d="M1.4 20.4h21.2"/>',
  palm:
    '<path d="M12 10.4V21"/><path d="M12 10.4c-2.8-2.6-6.4-2.9-8.8-1.2M12 10.4c2.8-2.6 6.4-2.9 8.8-1.2M12 10.4c0-3.6 1.7-6.3 4.3-7.2M12 10.4c0-3.6-1.7-6.3-4.3-7.2"/><path d="M6.4 21c1.5-1.3 3-1.3 4.5 0M13.1 21c1.5-1.3 3-1.3 4.5 0"/>',
  boat:
    '<path d="M2.6 17.6h18.8L18.6 21H5.4l-2.8-3.4Z"/><path d="M11.2 17.6V3.4l6.6 7.2h-6.6"/><path d="M9 10.6H6.4a1.6 1.6 0 0 0-1.6 1.6v5.4"/>',

  // — activity —
  chefhat:
    '<path d="M7.4 16.6h9.2v4.2H7.4v-4.2Z"/><path d="M7.4 16.6a4.6 4.6 0 0 1-1-9.1 4.7 4.7 0 0 1 8.8-2.2 4.5 4.5 0 0 1 1.4 11.3"/>',
  hiker:
    '<circle cx="13.4" cy="4.6" r="1.9"/><path d="M12.6 8.6 10 13.4l3.4 2.2.8 5.6"/><path d="M13.4 15.6 9.6 20.8"/><path d="M12.6 9.6l3.6 2 1.2 4.4"/><path d="M18.2 8.2 17 21"/>',
  paraglider:
    '<path d="M2.6 9.4a9.4 9.4 0 0 1 18.8 0"/><path d="M2.6 9.4 12 15.8M21.4 9.4 12 15.8M7.4 8.1 12 15.8M16.6 8.1 12 15.8"/><circle cx="12" cy="17.6" r="1.6"/><path d="M12 19.2v2.2"/>',
  tent:
    '<path d="M12 3.6 2.8 20.8h18.4L12 3.6Z"/><path d="M12 3.6v17.2"/><path d="M7.6 20.8 12 12.4l4.4 8.4"/>',
  star:
    '<path d="m12 3 2.7 5.9 6.4.7-4.8 4.3 1.3 6.3L12 17.1 6.4 20.2l1.3-6.3L2.9 9.6l6.4-.7L12 3Z"/>',

  // — lodging —
  bed:
    '<path d="M2.6 20.4V9.6"/><path d="M2.6 14.6h18.8v5.8"/><path d="M21.4 20.4v-5.8a3 3 0 0 0-3-3H10.6v3"/><path d="M5.4 11.4h3.6a1.6 1.6 0 0 1 0 3.2H5.4v-3.2Z"/>',
  hotel:
    '<path d="M4.6 21V4.4A1.4 1.4 0 0 1 6 3h12a1.4 1.4 0 0 1 1.4 1.4V21"/><path d="M2.8 21h18.4"/><path d="M10.2 21v-4.2h3.6V21"/><circle cx="8.4" cy="7" r=".95" fill="currentColor" stroke="none"/><circle cx="12" cy="7" r=".95" fill="currentColor" stroke="none"/><circle cx="15.6" cy="7" r=".95" fill="currentColor" stroke="none"/><circle cx="8.4" cy="11.4" r=".95" fill="currentColor" stroke="none"/><circle cx="12" cy="11.4" r=".95" fill="currentColor" stroke="none"/><circle cx="15.6" cy="11.4" r=".95" fill="currentColor" stroke="none"/>',
  house:
    '<path d="M2.6 11.4 12 3.6l9.4 7.8"/><path d="M5.2 9.6V20.6h13.6V9.6"/><path d="M9.6 20.6v-5.4h4.8v5.4"/>',

  // — transit —
  plane:
    '<path d="M21.2 15.2 13.4 11.8V5.2a1.4 1.4 0 0 0-2.8 0v6.6L2.8 15.2v2.2l7.8-2.3v3.6l-2.3 1.7v1.1L12 20.4l3.7 1.1v-1.1l-2.3-1.7v-3.6l7.8 2.3v-2.2Z"/>',
  train:
    '<path d="M7 3.4h10a2.6 2.6 0 0 1 2.6 2.6v9a2.6 2.6 0 0 1-2.6 2.6H7A2.6 2.6 0 0 1 4.4 15V6A2.6 2.6 0 0 1 7 3.4Z"/><path d="M4.4 9.8h15.2"/><path d="M8.2 17.6 5.6 21.2M15.8 17.6l2.6 3.6"/><circle cx="8.6" cy="13.8" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.4" cy="13.8" r="1.1" fill="currentColor" stroke="none"/>',
  bus:
    '<path d="M3.8 6.2A2.6 2.6 0 0 1 6.4 3.6h11.2a2.6 2.6 0 0 1 2.6 2.6v11.4H3.8V6.2Z"/><path d="M3.8 10.6h16.4"/><path d="M12 3.6v7"/><circle cx="7.6" cy="19.4" r="1.9"/><circle cx="16.4" cy="19.4" r="1.9"/><path d="M6.6 14.4h1.4M16 14.4h1.4"/>',
  car:
    '<path d="M3.2 16.4v-3.6l2.1-4.7a2.1 2.1 0 0 1 1.9-1.3h9.6a2.1 2.1 0 0 1 1.9 1.3l2.1 4.7v3.6"/><path d="M3.2 16.4h17.6"/><path d="M4.8 12.8h14.4"/><path d="M4.8 16.4v2.3a1 1 0 0 0 1 1h1.7a1 1 0 0 0 1-1v-2.3M15.5 16.4v2.3a1 1 0 0 0 1 1h1.7a1 1 0 0 0 1-1v-2.3"/>',
  ticket:
    // Ticket office. CONFUSABLE WITH `sim` (also a rounded rectangle with a bite taken out of
    // it) and, less so, `locker`. Both of those are portrait; this is landscape and twice as
    // wide as it is tall, so aspect tells them apart before any interior detail resolves.
    // The first draft put the tear line a third of the way in from the right, and at 22px the
    // big body plus small stub stopped reading as a ticket and started reading as a camcorder
    // — a shape that is not in this set, but "not obviously anything else here" is not the
    // same as "obviously a ticket". Fixed by making it SYMMETRIC: the bites are opposed side
    // notches at the waist, which is the coupon shape everyone already knows.
    // The perforation degrades on purpose. Two dashes with a 1.2 gap merge into one solid
    // tick at 22px rather than turning to grey mush, so the glyph loses a detail instead of
    // gaining noise. Nothing else is inside it: interior text lines were tried and they are
    // the thing that mushes.
    '<path d="M4.2 7.4h15.6a1.6 1.6 0 0 1 1.6 1.6v1.4a1.7 1.7 0 0 0 0 3.4V15a1.6 1.6 0 0 1-1.6 1.6H4.2A1.6 1.6 0 0 1 2.6 15v-1.2a1.7 1.7 0 0 0 0-3.4V9a1.6 1.6 0 0 1 1.6-1.6Z"/><path d="M12 9.8v1.6M12 12.6v1.6"/>',
  trailmarker:
    // Trailhead. CONFUSABLE WITH `flag` (tour operator) and with `signpost`. All three are a
    // thing on a pole, so the pole cannot be the distinction — BALANCE is. flag hangs a
    // single pennant off one side of a tall bare pole; signpost throws two arms out in
    // opposite directions; this one is SYMMETRIC, a blaze board sitting square and centred on
    // a short post with the ground under it. Symmetry survives blur, and it is still legible
    // when the blaze inside has collapsed. Not `hiker` either: that is a figure, all
    // diagonals, with nothing enclosing it.
    // The blaze is a SOLID triangle, not an outlined chevron. Same reasoning as the star in
    // `shieldStar`: at 22px a 1.7px stroke bent through a sharp apex fills its own interior
    // and the mark goes grey, so anything this small is filled deliberately rather than left
    // to fill itself by accident.
    '<rect x="4.4" y="3.4" width="15.2" height="7.2" rx="1.6"/><path d="M12 5.2 15.8 9.2H8.2Z" fill="currentColor" stroke="none"/><path d="M12 10.6V21"/><path d="M8.2 21h7.6"/>',
  bridge:
    '<path d="M1.8 18.6h20.4"/><path d="M4.6 6.4v12.2M19.4 6.4v12.2"/><path d="M4.6 7.4c4.9 6.2 9.9 6.2 14.8 0"/><path d="M8.2 10.8v7.8M12 12.6v6M15.8 10.8v7.8"/>',

  // — drawn for the subkind list (13 Nov 2026) —
  bunk:
    // Hostel: a bunk, two beds on one pair of posts. The bed alone is the lodging fallback and
    // the building is the hotel, so the stack is what says shared room.
    '<path d="M4 3.4v17.4M20 3.4v17.4"/><path d="M4 10.2h16M4 18h16"/><path d="M6.6 10.2V8.4a1.3 1.3 0 0 1 1.3-1.3h2a1.3 1.3 0 0 1 1.3 1.3v1.8"/><path d="M6.6 18v-1.8a1.3 1.3 0 0 1 1.3-1.3h2a1.3 1.3 0 0 1 1.3 1.3V18"/>',
  cabin:
    // Cabin: a gabled hut with log courses and a chimney. The courses are what tell it from
    // `house` (apartment) at a glance.
    '<path d="M2.8 12 12 4.6l9.2 7.4"/><path d="M5 10.4v10.2h14V10.4"/><path d="M5 13.8h14M5 17.2h14"/><path d="M16.4 8.1V4.4h2.2v5.5"/>',
  mug:
    // Brewery: a handled mug with a head of foam. `cup` (cafe) has a saucer and steam; this has
    // neither, and the foam breaks the top edge.
    '<path d="M5.4 9h10.2v9.6a2 2 0 0 1-2 2H7.4a2 2 0 0 1-2-2V9Z"/><path d="M15.6 11.2h1.6a2.4 2.4 0 0 1 2.4 2.4v1.6a2.4 2.4 0 0 1-2.4 2.4h-1.6"/><path d="M5.4 9a2.7 2.7 0 0 1 1.9-4.6 3.2 3.2 0 0 1 6-.5A2.6 2.6 0 0 1 15.6 9"/><path d="M8.8 12.2v5M12.2 12.2v5"/>',
  pagoda:
    // Temple: two stacked, upturned roofs on posts.
    '<path d="M12 2v2.2"/><path d="M6.6 7.6 8.8 4.2h6.4l2.2 3.4"/><path d="M5.4 7.6h13.2"/><path d="M8.8 7.6v3.4M15.2 7.6v3.4"/><path d="M4.6 14.6 7 11h10l2.4 3.6"/><path d="M3.2 14.6h17.6"/><path d="M6.8 14.6V21M17.2 14.6V21"/><path d="M4.4 21h15.2"/>',
  mosque:
    // Mosque: an onion dome with a minaret standing beside it.
    '<path d="M4.6 21v-6.2c0-2.6 1.5-4.3 3-5.6 1-.9 1.9-1.8 2.4-3.2.5 1.4 1.4 2.3 2.4 3.2 1.5 1.3 3 3 3 5.6V21"/><path d="M10 6V3.8"/><path d="M8.4 21v-2.8a1.6 1.6 0 0 1 3.2 0V21"/><path d="M17.2 21V9.2h2.6V21"/><path d="M18.5 9.2V6"/><path d="M2.6 21h18.8"/>',
  synagogue:
    // Synagogue: a six-pointed star standing on a low base. The star takes most of the box:
    // at 15px it is the whole message, and `star` (the activity fallback) has five points and no base.
    '<path d="M12 2.4 17.2 11.4H6.8L12 2.4Z"/><path d="M12 14.4 6.8 5.4h10.4L12 14.4Z"/><path d="M5.4 21v-3.6h13.2V21"/><path d="M3.4 21h17.2"/>',
  torii:
    // Shrine: a torii gate, two posts under a curved lintel and a tie beam.
    '<path d="M3 6.4c3 .9 6 1.3 9 1.3s6-.4 9-1.3"/><path d="M5.6 11.4h12.8"/><path d="M7.4 7.4V21M16.6 7.4V21"/><path d="M12 7.8v3.6"/>',
  castle:
    // Castle: two crenellated towers joined by a wall, with an arched gate.
    '<path d="M3.6 21V5.4h1.8v1.9h1.8V5.4H9v6.4h6V5.4h1.8v1.9h1.8V5.4h1.8V21"/><path d="M2.4 21h19.2"/><path d="M10 21v-3.4a2 2 0 0 1 4 0V21"/>',
  paw:
    // Zoo: a paw print.
    '<path d="M12 12.4c-2.7 0-5 2.3-5 4.7 0 1.6 1.1 2.7 2.6 2.7 1 0 1.5-.5 2.4-.5s1.4.5 2.4.5c1.5 0 2.6-1.1 2.6-2.7 0-2.4-2.3-4.7-5-4.7Z"/><ellipse cx="6" cy="10.8" rx="1.5" ry="2"/><ellipse cx="9.7" cy="6.6" rx="1.5" ry="2.1"/><ellipse cx="14.3" cy="6.6" rx="1.5" ry="2.1"/><ellipse cx="18" cy="10.8" rx="1.5" ry="2"/>',
  wave:
    // Water sport: a breaking wave over the water line.
    '<path d="M2.4 16c2.6-.2 3.8-2 4.6-4.4C8.2 8 10.8 5.4 14.4 5.4c2.9 0 4.8 1.8 4.8 4.1 0 1.7-1.2 2.9-2.8 2.9-1.3 0-2.2-.8-2.2-2"/><path d="M2.4 20.2c1.6-1.2 3.2-1.2 4.8 0s3.2 1.2 4.8 0 3.2-1.2 4.8 0 3.2 1.2 4.8 0"/>',
  snowflake:
    // Snow sport: a six-armed snowflake.
    '<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/><path d="M9.8 4.4 12 6.6l2.2-2.2M9.8 19.6 12 17.4l2.2 2.2M17.5 17.7l-.8-3 3-.8M6.5 6.3l.8 3-3 .8M17.5 6.3l-.8 3 3 .8M6.5 17.7l.8-3-3-.8"/>',
  notes:
    // Show (theater, concert, dance): two beamed notes.
    '<path d="M9 18V6l10-2.2V15.6"/><path d="M9 9.6l10-2.2"/><circle cx="6.6" cy="18" r="2.4"/><circle cx="16.6" cy="15.6" r="2.4"/>',
  lotus:
    // Spa: a lotus, three petals over a water line.
    '<path d="M12 4.2c2.3 2.6 3.4 5.3 3.4 8 0 2.5-1.1 4.7-3.4 6.6-2.3-1.9-3.4-4.1-3.4-6.6 0-2.7 1.1-5.4 3.4-8Z"/><path d="M8.8 10.4c-2.2-.9-4.3-1-6.2-.4.3 4.6 3.4 8.2 9.4 8.8"/><path d="M15.2 10.4c2.2-.9 4.3-1 6.2-.4-.3 4.6-3.4 8.2-9.4 8.8"/><path d="M6 21.4h12"/>',
  ferriswheel:
    // Theme park: a wheel on an A-frame.
    '<circle cx="12" cy="10" r="6.8"/><path d="M12 3.2v13.6M5.2 10h13.6"/><path d="M12 10 7.8 21.2M12 10l4.2 11.2"/><path d="M5.4 21.2h13.2"/>',
  metro:
    // Metro: a train front inside a tunnel mouth. The arch is the silhouette that `train`
    // (a station) does not have.
    '<path d="M3.4 21.2v-9.4a8.6 8.6 0 0 1 17.2 0v9.4"/><path d="M8.2 21.2v-9.4A1.8 1.8 0 0 1 10 10h4a1.8 1.8 0 0 1 1.8 1.8v9.4"/><path d="M8.2 15.2h7.6"/><circle cx="10.2" cy="18.2" r=".95" fill="currentColor" stroke="none"/><circle cx="13.8" cy="18.2" r=".95" fill="currentColor" stroke="none"/><path d="M1.8 21.2h20.4"/>',
  ferry:
    // Ferry: a wide hull with a deck house and a row of portholes, on water. `boat` (a boat
    // trip) is the small one with a sail.
    '<path d="M2.8 14.4h18.4l-2.4 4.4H5.2l-2.4-4.4Z"/><path d="M6.2 14.4V9.8h11.6v4.6"/><path d="M9.4 9.8V6.2h5.2v3.6"/><path d="M12 6.2V3.8"/><circle cx="9" cy="12.1" r=".9" fill="currentColor" stroke="none"/><circle cx="12" cy="12.1" r=".9" fill="currentColor" stroke="none"/><circle cx="15" cy="12.1" r=".9" fill="currentColor" stroke="none"/><path d="M3 21.6c1.5-1 3-1 4.5 0s3 1 4.5 0 3-1 4.5 0 3 1 4.5 0"/>',
  key:
    // Car rental: a key. The car itself is `car` (taxi).
    '<circle cx="7.4" cy="12" r="4.2"/><path d="M11.6 12h9.8"/><path d="M17.2 12v3.4M20.4 12v2.6"/>',
  parking:
    // Parking: the P in a ring, as the road sign draws it.
    '<circle cx="12" cy="12" r="9"/><path d="M9.6 17V7h3a3.1 3.1 0 0 1 0 6.2h-3"/>',
  cablecar:
    // Cable car: a cabin hanging from a sloping cable.
    '<path d="M2.6 6.8 21.4 3.4"/><path d="M12 5.1v3.5"/><path d="M7.6 8.6h8.8a2.2 2.2 0 0 1 2.2 2.2v6.6a2.2 2.2 0 0 1-2.2 2.2H7.6a2.2 2.2 0 0 1-2.2-2.2v-6.6a2.2 2.2 0 0 1 2.2-2.2Z"/><path d="M5.4 14h13.2M12 8.6V14"/>',
  hospital:
    // Hospital: the H in a rounded square, as the road sign draws it. Tier 1. Its neighbors in
    // a box are `washer` (a ring) and `locker` (two drawers); blurred at 15px the two posts of the
    // H are still two posts. `pill` is the pharmacy and `crossShield` the clinic.
    '<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="4.2"/><path d="M8.6 7.6v8.8M15.4 7.6v8.8M8.6 12h6.8"/>',
  embassy:
    // Embassy: a flag on a pole over a low building. `flag` alone is a tour.
    '<path d="M3.2 21h17.6"/><path d="M5 21v-7.4h14V21"/><path d="M12 13.6V3"/><path d="M12 3.8h5.8l-1.5 2.1 1.5 2.1H12"/><path d="M8.6 21v-3.4M15.4 21v-3.4"/>',
  // — end of the subkind list's drawings —
  // — fallbacks —
  pin:
    '<path d="M12 21.2s7.2-6.6 7.2-11.4a7.2 7.2 0 1 0-14.4 0c0 4.8 7.2 11.4 7.2 11.4Z"/><circle cx="12" cy="9.6" r="2.7"/>',
};

// ── subkind -> glyph ───────────────────────────────────────────────────────────────────
// The list of subkinds is not here: it is shared/place-kinds.js, which the server imports too,
// so the server can never accept a subkind this file has no glyph for. What IS here is the
// drawing each subkind gets, keyed by the list's ids.
//
// ONE GLYPH PER SUBKIND, ACROSS THE WHOLE LIST. A place's kind and subkind are chosen
// separately (a market may be food, a sight or practical), so "these two share a shape but
// never share a tint" is not something this file can promise. scripts/place_kinds_check.mjs
// fails on a shared glyph.
//
// A subkind on the list with no drawing of its own yet shows its HOME kind's fallback, and
// the same check names every one of those, so the set of undrawn subkinds is a list somebody
// reads, never a surprise.

const GLYPH_OF = {
  hotel: "hotel", apartment: "house", campsite: "tent",
  restaurant: "cutlery", cafe: "cup", bakery: "loaf", ice_cream: "cone", street_food: "bowl", market: "stall",
  bar: "martini", winery: "wine",
  viewpoint: "binoculars", museum: "museum", ruin: "ruin", church: "church", landmark: "obelisk",
  plaza: "fountain", park: "tree", beach: "palm", mountain: "pass", town: "village", bridge: "bridge",
  tour: "flag", cooking_class: "chefhat", hike: "hiker", boat_trip: "boat", adventure: "paraglider", shopping: "bag",
  airport: "plane", train_station: "train", bus_station: "bus", taxi: "car", trailhead: "trailmarker",
  border: "barrier", ticket_office: "ticket",
  atm: "atm", money_exchange: "exchange", pharmacy: "pill", clinic: "crossShield", dentist: "tooth",
  police: "shieldStar", supermarket: "cart", convenience: "storefront24", water: "bottleWater",
  laundry: "washer", sim: "sim", luggage_storage: "locker", outdoor_gear: "backpack", hardware: "bolt",
  fuel: "fuel", toilets: "toilet", shower: "shower", tourist_office: "info",
  // drawn 13 Nov 2026
  hostel: "bunk", cabin: "cabin", brewery: "mug", temple: "pagoda", mosque: "mosque",
  synagogue: "synagogue", shrine: "torii", castle: "castle", nature: "leaf", zoo: "paw",
  water_sport: "wave", snow_sport: "snowflake", show: "notes", spa: "lotus", theme_park: "ferriswheel",
  metro: "metro", ferry: "ferry", car_rental: "key", parking: "parking", cable_car: "cablecar",
  hospital: "hospital", embassy: "embassy",
};

// ── names other screens ask for ────────────────────────────────────────────────────────
// No place carries these and none ever will: they are not subkinds. They are the words
// screens that are not the places list use to ask this module for a specific glyph, and each
// one is load-bearing at a named call site, so deleting it does not produce a generic mark,
// it produces a WRONG one (a flight card drawing the transit fallback, which is a bus).
//   flight, transfer  agenda.js EVENT_SUB: an event with no place still needs an honest mark
//   meal, walk        agenda.js EVENT_SUB and plan-editor.js KIND_SUB: a meal's and a walk's mark
//   airbnb            places.js: a place's link out to the listing it was booked on
//   trek              packing.js viewIcon: a trail list's header
//   sim_card          packing.js CAT_ICONS.electronics

const CALLER_ALIAS = {
  flight: "airport",
  transfer: "taxi",
  meal: "restaurant",
  walk: "hike",
  airbnb: "apartment",
  trek: "hike",
  sim_card: "sim",
};

/** The words above, for the check that every drawing in G is reached by something. */
export const CALLER_WORDS = Object.keys(CALLER_ALIAS);

// ── urgency ────────────────────────────────────────────────────────────────────────────
// TIER IS NOT FREQUENCY. It is "am I looking at this because something has gone wrong, right
// now": 1 urgent · 2 logistics · 3 lodging · 4 sustenance · 5 sights · 6 activities. A
// convenience store is tier 1 not because there are many but because at 23:00 with no water
// it is the only thing on the screen that matters. It is the rule that governs the glyphs
// themselves: a tier-1 mark must differ from its neighbors by SHAPE at 22px in bad light,
// which is why pharmacy is a capsule pill and clinic is a cross in a SHIELD rather than the
// same mark in a different hue.

const URGENT = new Set(["pharmacy", "clinic", "hospital", "dentist", "police", "atm", "money_exchange",
  "toilets", "convenience", "supermarket", "water"]);
const KIND_TIER = { practical: 2, transit: 2, lodging: 3, food: 4, drink: 4, sight: 5, activity: 6 };

/**
 * Urgency tier, 1..6, for every subkind on the list. Nothing in the app reads it yet. It is
 * exported because the ranking is a judgement that is invisible in the glyphs it produced,
 * and the first screen that wants to sort a mixed practical list (pharmacy above hardware
 * shop) should not have to invent it a second time.
 */
export const TIER_OF = {};
for (const s of SUBKINDS) TIER_OF[s.id] = URGENT.has(s.id) ? 1 : KIND_TIER[s.kind];

// One glyph per KIND, for a subkind that is blank, not on the list, or on it and not drawn
// yet. A fallback is the kind's most general shape.
const KIND_FALLBACK = {
  practical: "briefcase",
  food: "cutlery",
  drink: "martini",
  sight: "obelisk",
  activity: "star",
  lodging: "bed",
  transit: "bus",
};

/** The glyph a word stands for, or null: a subkind (in any spelling) or a caller's word. */
function glyphFor(word) {
  const hit = spelledSubkind(Object.hasOwn(CALLER_ALIAS, word) ? CALLER_ALIAS[word] : word);
  if (!hit) return null;
  const id = GLYPH_OF[hit];
  return id && G[id] ? id : KIND_FALLBACK[subkindEntry(hit).kind];
}

/** The glyph id that (kind, subkind) resolves to. Exported so the map can key sprites on it. */
export function getIconId(kind, subkind) {
  const s = String(subkind || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  // A row from before the list may carry a compound nobody listed ("cafe_rooftop"): its head
  // word is the type. Display only: the reader in place-kinds.js never guesses. A word not on
  // the list at all draws its kind's glyph.
  return (s && (glyphFor(s) || glyphFor(s.split("_")[0]))) || KIND_FALLBACK[categoryOf(kind)] || "pin";
}

/** Subkinds on the list that have no drawing of their own yet. Empty when the set is whole. */
export const UNDRAWN_SUBKINDS = SUBKINDS.filter((s) => !(GLYPH_OF[s.id] && G[GLYPH_OF[s.id]])).map((s) => s.id);

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/**
 * getIcon(kind, subkind, opts) -> inline SVG string.
 *
 * opts.cls     extra classes, appended after "ico"
 * opts.size    a CSS length; omit and it inherits font-size (the `.ico` rule is 1em square)
 * opts.title   accessible name. Omit for a decorative glyph and it renders aria-hidden,
 *              which is right whenever the row already names the place in text.
 */
export function getIcon(kind, subkind, opts = {}) {
  const id = getIconId(kind, subkind);
  const cls = opts.cls ? `ico ${opts.cls}` : "ico";
  const size = opts.size ? ` style="width:${opts.size};height:${opts.size}"` : "";
  const a11y = opts.title
    ? ` role="img" aria-label="${String(opts.title).replace(/[&<>"']/g, (c) => ESC[c])}"`
    : ' aria-hidden="true"';
  return `<svg class="${cls}" viewBox="0 0 24 24"${size}${a11y} data-icon="${id}">${G[id]}</svg>`;
}

/** Every glyph id that exists, for the icon audit in Settings and for tests. */
export const ICON_IDS = Object.keys(G);

export default getIcon;

// places.js — the "I need something" screen. #/places (list + filter) and #/p/:id (detail).
//
// This is not a browsing screen. It exists for one moment: 21:00 in a city you do not know,
// somebody needs a pharmacy, and the phone may have no signal. Everything here follows from
// that:
//
//   * the filter runs over the array store.places() already holds. No fetch, no debounce, no
//     spinner — a filter that can fail is worse than no filter, and on the trail it WOULD fail.
//   * PRACTICAL leads the kind row's ORDER — sights are what you browse; pharmacies are
//     what you need — but NOTHING is pre-selected on arrival: the screen opens on
//     all places. A pre-selected chip claimed the very state that deselecting means, and
//     it read as a filter nobody had asked for.
//   * distance is computed on-device from GPS, which keeps working with the radio off. That
//     is the whole reason this screen degrades gracefully where the map cannot.
//
// Correctness rules for place data and distances:
//
//   * `walk_minutes` IS NOT A WALK TIME FROM YOU. It is a researched number measured from the
//     place's own `near_anchor`. Never print "5182 km away · 2 min walk" on one row, which is
//     not a rounding error — it is two different questions answered as if they were one. It is
//     now shown ONLY where that anchor is genuinely the frame of reference (you asked for
//     "everything near the fonda", or you are on the fonda's page), and it is named there.
//   * NO IMAGES ON LIST ROWS. An 84px photo column made every row 76px tall and pushed the
//     open/closed badge — the single most decision-relevant thing on the screen — onto a third
//     line. Rows are two lines, ~60px, and the badge sits on the first one beside the icon.
//   * The category icon is monochrome in a circular gray badge (no colored stripes, squares,
//     or chips): the glyph carries the meaning.
//   * "Everything near X" actually works: it re-sorts this list by distance FROM THAT PLACE,
//     names the anchor in the sticky header with an X to dismiss, and SURVIVES tapping into a
//     place and coming back. It is deliberately not a filter chip — there is no way to reach
//     it except from a place page.
//   * No photo credits anywhere on these screens. The CC BY / CC BY-SA obligation is met by
//     Settings -> Image credits (#/settings/credits), which is one list covering all 46 images.
//     Centralized attribution fulfills the CC BY terms cleanly across the app.
//
// ctx.store / ctx.router are used rather than importing store.js directly (CONTRACTS.md
// "Module interface"), which also makes the whole module drivable from a test harness.
//
// Two coordinate hazards this file handles explicitly, because both are in the real seed:
//   * lat/lng of exactly 0,0 means "not researched yet", not "Gulf of Guinea". Rendering
//     "8,500 km" there, or worse dropping a map pin in the ocean, is the failure that gets
//     somebody into a taxi to nowhere. Those rows say so instead.
//   * confidence:"low" is surfaced as a banner. A place whose address is only its city's name
//     must not look as trustworthy as one with a street number.

import { pictureOf, placePhoto } from "./shared/photo.js";
import { ensurePhotoCss, photoHand, wantsPhoto } from "./photo-hand.js";
import { start as startPictures } from "./picture-wait.js";
import {
  esc, clip, haversine, fmtDistance, fmtMinutes, fmtSpan, fmtTime, fmtDay, tzChip, localNameOf,
  getPosition, lastPosition, positionDenied,
} from "./util.js";
import { getIcon, categoryOf, CATEGORIES, CATEGORY_LABEL } from "./icons.js";
import { openState, readOldHours } from "./shared/hours.js";
import { readAreas } from "./areas.js";
import { subkindLabel } from "./shared/place-kinds.js";
// The map is a BODY of this screen, mounted embedded under the same head.
import { mountMap } from "./map.js";
// Motion: FLIP re-filtering, and the shared token readers so 220ms stays written down in
// exactly one place. Everything animated from this file is transforms + opacity only.
import { flip, ms, reducedMotion } from "./motion.js";
import { toast } from "./toast.js";
import { GUEST_AI_LINE } from "./guest.js";

// Easing tokens as strings, read lazily and cached for the same reason motion.js caches its
// durations: a module can execute before its stylesheet applies, and "" must not stick.
const EASE = new Map();
function easeTok(name, fallback) {
  const hit = EASE.get(name);
  if (hit) return hit;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!v) return fallback;
  EASE.set(name, v);
  return v;
}
const easeOut = () => easeTok("--ease-out", "cubic-bezier(.2,.8,.2,1)");

// ── styles ────────────────────────────────────────────────────────────────────────────────
// Injected once rather than added to styles.css: the shell owns that file, and .pl-* is mine
// per the ownership table. A <style> node also costs no request, which matters on a cold
// launch behind a service worker.
//
// The horizontal bleed expression appears several times and is exact rather than -16px:
// #view's side padding is max(var(--sp-4), var(--sa-left/right)), so on a landscape-locked
// or notched device a flat -16px leaves a visible step at one edge and overhangs the other.
// Set on #view too: beside the rail #view's own --sa-left is 0 (styles.css), and a value worked
// out at the root would carry the root's inset in.
const CSS = `
:root, #view{
  --pl-bleed-l: max(var(--sp-4), var(--sa-left));
  --pl-bleed-r: max(var(--sp-4), var(--sa-right));
}

/* Sticky header */
.pl-head{position:sticky;top:calc(var(--sp-4)*-1);z-index:3;
  margin:calc(var(--sp-4)*-1) calc(var(--pl-bleed-r)*-1) var(--sp-3) calc(var(--pl-bleed-l)*-1);
  padding:var(--sp-2) var(--pl-bleed-r) 8px var(--pl-bleed-l);
  background:var(--canvas);
  border-bottom:1px solid var(--hair)}
.pl-head[data-view="map"]{background:var(--fill);
  -webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);
  border-bottom-color:var(--edge)}

.pl-top{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-3);
  min-height:var(--control-44)}
.pl-h1{font-family:var(--type-head);font-weight:500;font-size:var(--size-28);line-height:1.1;
  letter-spacing:var(--track-head);color:var(--ink-1);margin:0}

/* list <-> map toggle: icon-only, shape carries destination */
.pl-viewbtn{position:relative;flex:0 0 auto;display:grid;place-items:center;
  width:36px;height:36px;border-radius:var(--radius-full);
  background:var(--fill);border:1px solid var(--edge);
  color:var(--ink-1);
  transition:background var(--dur-150) var(--ease-standard),transform var(--dur-150) var(--ease-standard)}
.pl-viewbtn::before{content:"";position:absolute;inset:-4px}
.pl-viewbtn .ico{width:18px;height:18px;grid-area:1/1}
.pl-viewbtn[data-press="1"]{background:var(--fill-active);transform:scale(.95)}
@media (hover: hover) and (pointer: fine){
  .pl-viewbtn:hover{background:var(--fill-hover)}
  .pl-viewbtn:active{background:var(--fill-active);transform:scale(.95)}
}
.pl-head[data-view="list"] .pl-viewbtn [data-g="list"]{opacity:0}
.pl-head[data-view="map"] .pl-viewbtn [data-g="map"]{opacity:0}

/* Anchored sort header */
.pl-anchor{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto}
.pl-anchor-ico{flex:0 0 auto;display:grid;place-items:center;width:28px;height:28px;
  border-radius:var(--radius-full);background:var(--gray-3);color:var(--ink-2)}
.pl-anchor-ico .ico{width:15px;height:15px}
.pl-anchor-t{min-width:0;display:flex;align-items:baseline;gap:.3em;
  font-size:var(--size-16);font-weight:600;letter-spacing:-.01em;color:var(--ink-1)}
.pl-anchor-n{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl-anchor-t small{flex:0 0 auto;white-space:nowrap;font-size:var(--size-12);font-weight:500;color:var(--ink-2)}
.pl-x{position:relative;flex:0 0 auto;display:grid;place-items:center;width:30px;height:30px;
  border-radius:var(--radius-full);color:var(--ink-2)}
.pl-x::before{content:"";position:absolute;inset:-7px}
.pl-x .ico{width:16px;height:16px;stroke-width:2}
.pl-x[data-press="1"]{background:var(--fill-active);color:var(--ink-1)}
@media (hover: hover) and (pointer: fine){
  .pl-x:active{background:var(--fill-active);color:var(--ink-1)}
}

/* Filter chip rows (32px pill, 44px expander via ::before inside 6px block-padded scroller) */
.pl-head .chip-row{margin-top:4px;margin-left:calc(var(--pl-bleed-l)*-1);margin-right:calc(var(--pl-bleed-r)*-1);
  padding:6px var(--pl-bleed-r) 6px var(--pl-bleed-l);gap:8px}
.pl-head .chip-row + .chip-row{margin-top:8px}
.pl-head .chip{flex:0 0 auto;max-width:100%;min-height:var(--control-32);height:var(--control-32);
  padding:0 12px;gap:6px;position:relative;border-radius:var(--radius-full);
  background:var(--canvas);border:1px solid var(--edge);color:var(--ink-2);
  font-family:var(--type-ui);font-size:var(--size-14);font-weight:600;line-height:1;
  transition:border-color var(--dur-150) var(--ease-standard),color var(--dur-150) var(--ease-standard)}
.pl-head[data-view="map"] .chip{background:var(--fill)}
.pl-head .chip::before{content:"";position:absolute;left:0;right:0;
  top:50%;height:var(--control-44);transform:translateY(-50%)}
.pl-head .chip .ico{width:15px;height:15px;flex:0 0 auto}
.pl-clip{position:absolute;inset:0;border-radius:inherit;overflow:hidden;pointer-events:none}
.pl-fill{position:absolute;inset:0;background:var(--ds-k, var(--solid))}
.pl-cin{position:relative;display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;overflow:hidden}
.pl-head .chip[data-kind] .pl-cin > .ico,
.pl-head .chip[data-sub] .pl-cin > .ico{color:var(--ds-k, var(--ink-2))}
.pl-clabel{min-width:0;overflow:hidden;text-overflow:ellipsis}
.pl-head .chip[data-kind][aria-pressed="true"],
.pl-head .chip[data-sub][aria-pressed="true"]{
  border-color:var(--ds-k, var(--solid));color:var(--ds-k-on, var(--on-solid));font-weight:600}
.pl-head .chip[aria-pressed="true"] .pl-cin > .ico{color:var(--ds-k-on, var(--on-solid))}
.pl-check{display:inline-flex;flex:0 0 auto}
.pl-check .ico{width:12px;height:12px;stroke-width:2.8}
.pl-head .chip[data-press="1"]{background:var(--fill-active)}
.pl-head .chip[data-press="1"] .pl-fill{filter:brightness(.92)}
@media (hover: hover) and (pointer: fine){
  .pl-head .chip:hover{border-color:var(--edge-strong);color:var(--ink-1)}
  .pl-head .chip[aria-pressed="true"]:hover{color:var(--ds-k-on, var(--on-solid))}
  .pl-head .chip:active{background:var(--fill-active)}
  .pl-head .chip:active .pl-fill{filter:brightness(.92)}
}

/* Origin note */
/* 14 px below the chips, not 6: "Use my location" reaches 14 px above its words (its ::before), and at 6 that reach
   covered the bottom of the last chip row's 44 px (a chip answered 38.75, v5_verify_C; 21 Nov, once the button
   shows for a browser that hasn't been asked). At 14 the two reaches meet and neither covers the other. */
.pl-note{display:flex;align-items:center;gap:var(--sp-2);margin-top:14px;
  font-size:var(--size-14);line-height:1.35;color:var(--ink-2)}
.pl-note:empty{display:none}
.pl-note .grow{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl-locbtn{position:relative;flex:0 0 auto;color:var(--ink-1);font-size:var(--size-14);font-weight:600;
  text-decoration:underline;text-underline-offset:3px}
.pl-locbtn::before{content:"";position:absolute;inset:-14px -8px}

/* Wide named add button (hidden on phone where floating + lives) */
.pl-headadd{display:none}
@media (min-width:768px), (orientation:landscape) and (max-height:420px) and (min-width:480px){
  .pl-headadd.ds-button--white{display:inline-flex;flex:none;height:36px;padding:0 14px;
    border-radius:var(--radius-12);background:var(--solid);color:var(--on-solid);border-color:transparent;
    font-size:var(--size-14);font-weight:600;white-space:nowrap}
  @media (hover: hover) and (pointer: fine){
    .pl-headadd.ds-button--white:hover{background:var(--solid-hover)}
  }
  .pl-head[data-empty] .pl-headadd{display:none}
  .fab.pl-fab{display:none}
}
.pl-head[data-two] .pl-viewbtn{display:none}
.pl-mapbody{position:relative;transition-property:none;
  margin:calc(var(--sp-3)*-1) calc(var(--pl-bleed-r)*-1) 0 calc(var(--pl-bleed-l)*-1)}
.pl-row[data-on="1"]{background:var(--fill);padding-inline:12px 8px;margin-inline:-8px}
.pl-row[data-on="1"]::before{left:2px}
.pl-mapbody.pl-rest{height:100%;margin:0}
.pl-mapbody[hidden]{display:none}
.pl-mapbody.pl-under-add{--mp-floor:calc(var(--bar-under, 0px) + var(--sp-3) + 56px + var(--sp-2))}
.pl-head[data-view="map"] .pl-note{display:none}

/* Borderless grouped list */
.pl-stage{position:relative}
.pl-lists{display:flex;flex-direction:column}
@media (min-width: 760px){.pl-lists,.pl-page{max-width:720px;margin-inline:auto;width:100%}}
#view[data-two="1"] .pl-lists{max-width:none;margin-inline:0}
#view[data-two="1"] .pl-page{max-width:600px;margin-inline:auto}
.pl-lists>li{list-style:none}

.pl-area{display:flex;align-items:baseline;justify-content:space-between;gap:12px;
  padding:14px 0 6px;border-top:1px solid var(--hair);
  font-size:var(--size-14);line-height:1.4;font-weight:400;color:var(--ink-2)}
.pl-area:first-child{border-top:0;padding-top:4px}
.pl-area-n{font-family:var(--type-mono);font-size:var(--size-12);font-variant-numeric:tabular-nums;
  letter-spacing:var(--track-number);color:var(--ink-2)}

.pl-group{list-style:none;margin:0;padding:0;background:transparent;border:0;border-radius:0;box-shadow:none}

.pl-row{position:relative;display:flex;align-items:center;gap:12px;
  padding:10px 0 10px 10px;color:inherit;min-height:58px;border-radius:var(--radius-12);
  transition:background var(--dur-150) var(--ease-standard)}
.pl-row::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:var(--radius-full);
  background:var(--ds-k, transparent);pointer-events:none}
.pl-row[data-press="1"]{background:var(--fill)}
@media (hover: hover) and (pointer: fine){
  .pl-row:active{background:var(--fill)}
}
.pl-rowmain{flex:1 1 auto;min-width:0}

.pl-t{display:flex;align-items:center;gap:8px;min-width:0}
.pl-ico{flex:0 0 auto;display:grid;place-items:center;width:var(--control-32);height:var(--control-32);
  border-radius:var(--radius-full);background:var(--ds-k-bg, var(--gray-3));
  border:1px solid var(--ds-k-edge, transparent);color:var(--ds-k, var(--ink-2))}
.pl-ico .ico{width:16px;height:16px}
.pl-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:var(--size-16);font-weight:600;line-height:1.3;letter-spacing:-.01em;color:var(--ink-1)}

.pl-open{font-weight:400;color:var(--ink-2);font-variant-numeric:tabular-nums;white-space:nowrap}
.pl-open-ok{color:var(--positive);font-weight:500}
.pl-open-warn{color:var(--warning);font-weight:500}

.pl-meta{display:block;margin-top:2px;font-size:var(--size-14);line-height:1.4;color:var(--ink-2);
  overflow-wrap:anywhere}
.pl-meta b{color:var(--ink-1);font-weight:600}
.pl-dot{color:var(--ink-2);padding:0 5px}

.pl-far{flex:0 0 auto;font-family:var(--type-mono);font-size:var(--size-14);font-weight:500;
  color:var(--ink-2);font-variant-numeric:tabular-nums;letter-spacing:var(--track-number)}

.pl-rate{display:inline-flex;align-items:center;gap:3px;font-family:var(--type-mono);
  font-variant-numeric:tabular-nums;letter-spacing:var(--track-number);color:var(--ink-2);font-weight:500}
.pl-rowrate{flex:0 0 auto;font-size:var(--size-14)}
.pl-rate .pl-star{width:11px;height:11px;flex:0 0 auto;fill:var(--ink-2);stroke:none}

.pl-sep{display:flex;align-items:center;gap:var(--sp-3);margin:var(--sp-4) 0 var(--sp-2);
  font-size:var(--size-14);font-weight:400;color:var(--ink-2)}
.pl-sep::before,.pl-sep::after{content:"";flex:1 1 auto;height:1px;background:var(--hair)}

/* Place detail page */
.pl-hero{position:relative;display:block;overflow:hidden;
  margin:0 0 18px;aspect-ratio:16/10;border-radius:var(--radius-24);
  border:1px solid var(--hair);background:var(--well)}
.pl-hero img{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover}

.pl-title{margin-top:2px}
.pl-title .h1{font-family:var(--type-head);font-weight:500;font-size:var(--size-28);
  line-height:1.12;letter-spacing:var(--track-head);color:var(--ink-1);margin:0}
.pl-local{margin-top:4px;font-size:var(--size-16);font-weight:400;color:var(--ink-2)}
.pl-gap{margin-top:6px}
.pl-title .eyebrow{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:var(--size-14);font-weight:500;letter-spacing:0;text-transform:none;color:var(--ink-2)}
.pl-kindpill{display:inline-flex;align-items:center;gap:5px;padding:2px 9px 2px 7px;border-radius:var(--radius-full);
  background:var(--ds-k, var(--solid));border:1px solid var(--ds-k, var(--solid));
  color:var(--ds-k-on, var(--on-solid));font-size:var(--size-14);font-weight:600}
:root[data-lum="dark"] .pl-kindpill,.ds[data-ds-theme="dark"] .pl-kindpill{
  background:var(--ds-k-bg, var(--well));border-color:var(--ds-k-edge, var(--edge));
  color:var(--ds-k, var(--ink-2))}
.pl-kindpill .ico{width:14px;height:14px;flex:0 0 auto}
.pl-why{margin:18px 0;padding-left:14px;border-left:1px solid var(--edge-strong);
  font-size:var(--size-16);line-height:1.5;color:var(--ink-1);white-space:pre-line}
.pl-facts{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin-top:12px}
.pl-facts .pill{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:0;
  border-radius:0;background:transparent;border:0;
  color:var(--ink-2);font-size:var(--size-14);font-weight:500;line-height:1.45;
  white-space:normal;overflow-wrap:anywhere}
.pl-facts .pill.pill-ok{color:var(--positive)}
.pl-facts .pill.pill-warn{color:var(--warning)}
.pl-facts .pill.pl-rate{font-family:var(--type-mono);font-variant-numeric:tabular-nums;color:var(--ink-1)}

.pl-banner{display:flex;align-items:flex-start;gap:10px;margin-top:16px;padding:12px 14px;
  border-radius:var(--radius-16);background:var(--warning-bg);border:1px solid var(--warning-edge);
  color:var(--ink-1);font-size:var(--size-14);line-height:1.45}
.pl-banner svg{flex:0 0 auto;width:18px;height:18px;color:var(--warning);stroke:currentColor;fill:none;stroke-width:2}

.pl-acts{display:flex;gap:8px;margin:18px 0 0}
.pl-acts>*{flex:1 1 0;min-width:0}
.pl-acts .btn .ico{width:18px;height:18px}
.ds .ds-button--white,.pl-page.ds .btn.ds-button--white,.pl-lists.ds .btn.ds-button--white{
  background:var(--solid);color:var(--on-solid);border-color:transparent;font-weight:600}
.ds .ds-button--gray,.pl-page.ds .btn.ds-button--gray,.pl-lists.ds .btn.ds-button--gray{
  background:var(--fill);border-color:var(--edge);color:var(--ink-1);font-weight:600}
.ds .ds-button--lg,.pl-page.ds .btn.ds-button--lg,.pl-lists.ds .btn.ds-button--lg{
  height:var(--control-44);min-height:var(--control-44);padding:0 18px;
  border-radius:var(--radius-16);font-size:var(--size-16);line-height:24px}
/* Wide two-pane: "+ Add a place" in the head is white, so Open in Maps goes gray here. */
#view[data-two="1"] .pl-page .btn.pl-maps-btn{
  background:var(--fill);border-color:var(--edge);color:var(--ink-1)}
@media (hover: hover) and (pointer: fine){
  .ds .ds-button--white:hover,.pl-page.ds .btn.ds-button--white:hover,.pl-lists.ds .btn.ds-button--white:hover{
    background:var(--solid-hover);color:var(--on-solid)}
  #view[data-two="1"] .pl-page .btn.pl-maps-btn:hover{background:var(--fill-hover)}
}

/* Action row: Change / Chat about this / photoHand */
.pl-page.ds .ph{margin-top:10px}
.pl-page.ds .ph-acts{display:flex;flex-wrap:wrap;gap:8px;margin:0}
.pl-page.ds .ph-acts .btn{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:var(--control-32);min-height:36px;padding:0 12px;
  border-radius:var(--radius-12);background:var(--fill);border:1px solid var(--edge);
  color:var(--ink-1);font-size:var(--size-14);font-weight:600;line-height:20px}
.pl-page.ds .ph-acts .btn[data-press="1"]{background:var(--fill-active)}
@media (hover: hover) and (pointer: fine){
  .pl-page.ds .ph-acts .btn:active{background:var(--fill-active)}
}
.pl-page.ds .ph-acts .btn .ico{width:16px;height:16px;stroke-width:1.8}
.pl-page.ds .ph-acts [data-armed]{
  color:var(--warning);border-color:var(--warning-edge);background:var(--warning-bg)}
.pl-page.ds .ph-say{margin:8px 0 0;font-size:var(--size-14);line-height:1.45;color:var(--ink-2)}
.pl-page.ds .ph-say[data-kind="err"]{color:var(--negative)}
.pl-page.ds .ph[data-hit] .ph-acts [data-photo="pick"]{box-shadow:0 0 0 2px var(--ring)}

/* Clean canvas address & notes sections separated by --hair dividers */
.pl-band{margin:24px 0 0;padding:18px 0 0;background:transparent;border-top:1px solid var(--hair)}
.pl-band .eyebrow{font-size:var(--size-14);font-weight:500;letter-spacing:0;text-transform:none;color:var(--ink-2)}

.pl-addr{-webkit-user-select:text;user-select:text;-webkit-touch-callout:default}
.pl-addr-line{font-family:var(--type-head);font-size:var(--size-20);line-height:1.3;font-weight:500;
  letter-spacing:var(--track-head);color:var(--ink-1);overflow-wrap:anywhere}
.pl-addr-none{font-size:var(--size-16);line-height:1.5;color:var(--ink-2)}
.pl-addr-dist{margin-top:8px;font-size:var(--size-16);line-height:1.4;font-weight:600;color:var(--ink-1)}
.pl-addr-note{margin-top:8px;font-size:var(--size-14);line-height:1.45;color:var(--ink-2)}
.pl-copy{position:relative;margin-top:12px;display:inline-block;
  font-size:var(--size-14);font-weight:600;color:var(--ink-1);
  text-decoration:underline;text-underline-offset:3px}
.pl-copy::before{content:"";position:absolute;inset:-14px -12px}

.pl-prose{font-size:var(--size-16);line-height:1.5;color:var(--ink-1);white-space:pre-line;
  overflow-wrap:anywhere}
.pl-hours{font-size:var(--size-14);line-height:1.5;color:var(--ink-1);white-space:pre-line}
.pl-sec{margin-top:24px;padding-top:18px;border-top:1px solid var(--hair)}
.pl-sec .h2{font-family:var(--type-head);font-weight:500;font-size:var(--size-20);
  line-height:1.25;letter-spacing:var(--track-head);color:var(--ink-1);margin:0 0 10px}
.pl-said-none{font-size:var(--size-14);line-height:1.5;color:var(--ink-2);margin:0}

/* Checkout checklist */
.pl-steps{list-style:none;margin:8px 0 0;padding:0}
.pl-step{display:flex;gap:12px;padding:10px 0}
.pl-step+.pl-step{border-top:1px solid var(--hair)}
.pl-step-n{flex:0 0 auto;display:grid;place-items:center;width:24px;height:24px;margin-top:1px;
  border-radius:var(--radius-full);background:var(--gray-3);color:var(--ink-1);
  font-family:var(--type-mono);font-size:var(--size-12);font-weight:600;font-variant-numeric:tabular-nums}
.pl-step-t,.pl-step-d{display:block}
.pl-step-t{font-size:var(--size-16);line-height:1.35;font-weight:600;color:var(--ink-1)}
.pl-step-d{margin-top:2px;font-size:var(--size-14);line-height:1.45;color:var(--ink-2)}

/* Links: On the plan / Nearby */
.pl-rows{display:flex;flex-direction:column}
.pl-link{display:flex;align-items:center;justify-content:space-between;gap:12px;
  min-height:var(--control-44);padding:10px 0;color:inherit}
.pl-rows>.pl-link+.pl-link{border-top:1px solid var(--hair)}
.pl-link .grow{min-width:0}
.pl-link-t{display:block;font-size:var(--size-16);font-weight:600;line-height:1.3;color:var(--ink-1);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl-link-s{display:block;font-size:var(--size-14);line-height:1.4;color:var(--ink-2);margin-top:2px}
.pl-link-d{flex:0 0 auto;font-family:var(--type-mono);font-size:var(--size-14);font-weight:500;
  color:var(--ink-2);font-variant-numeric:tabular-nums;letter-spacing:var(--track-number)}
.pl-link[data-press="1"],a.pl-out[data-press="1"]{background:var(--fill)}
@media (hover: hover) and (pointer: fine){
  .pl-link:active,a.pl-out:active{background:var(--fill)}
}
.pl-link-p{padding-left:0}
.pl-link-ico{flex:0 0 auto;display:grid;place-items:center;width:var(--control-32);height:var(--control-32);
  border-radius:var(--radius-full);background:var(--gray-3);color:var(--ink-2)}
.pl-link-ico .ico{width:16px;height:16px}

a.pl-out{display:flex;align-items:center;gap:12px;width:100%;
  min-height:var(--control-44);margin-top:16px;padding:12px 0;
  border-top:1px solid var(--hair);border-bottom:1px solid var(--hair);color:inherit}
a.pl-out .pl-out-ico{flex:0 0 auto;display:grid;place-items:center;width:var(--control-32);height:var(--control-32);
  border-radius:var(--radius-full);background:var(--gray-3);color:var(--ink-2)}
a.pl-out .pl-out-ico .ico{width:16px;height:16px}
a.pl-out .pl-link-s{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
a.pl-out .pl-out-go{flex:0 0 auto;color:var(--ink-2)}
a.pl-out .pl-out-go .ico{width:16px;height:16px;stroke-width:2}

.pl-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:16px}
.pl-tags .pill{display:inline-flex;align-items:center;max-width:100%;padding:4px 10px;border-radius:var(--radius-full);
  background:var(--well);border:1px solid var(--edge);color:var(--ink-2);font-size:var(--size-12);font-weight:500;
  white-space:normal;overflow-wrap:anywhere}
.pl-near{margin-top:14px;max-width:100%;overflow:hidden;text-overflow:ellipsis}

.pl-showall{margin-top:14px}
.pl-add{margin-top:14px}
.pl-empty-ai{max-width:34ch;margin-top:10px;line-height:1.45;font-size:var(--size-14);color:var(--ink-2)}
.pl-empty-ai a{color:var(--ink-1);font-weight:600;text-decoration:underline;text-underline-offset:3px}
.pl-lists.ds .empty h2,.pl-lists.ds .empty .h3,.pl-page.ds .empty .h3{
  font-family:var(--type-head);font-weight:500;font-size:var(--size-20);line-height:1.25;
  letter-spacing:var(--track-head);color:var(--ink-1)}
.pl-lists.ds .empty .meta,.pl-page.ds .meta{font-size:var(--size-14);color:var(--ink-2)}
.pl-nopin{display:flex;align-items:flex-start;gap:8px;margin:16px 0 0;padding:12px 14px;
  border-radius:var(--radius-16);background:var(--well);border:1px solid var(--hair);
  color:var(--ink-2);font-size:var(--size-14);font-weight:500;line-height:1.45}
.pl-nopin .ico{flex:0 0 auto;width:16px;height:16px;margin-top:2px}
.pl-change{display:flex;gap:8px;margin:0}
.ph .pl-change{margin:0;flex-wrap:wrap}
.pl-change .btn .ico{width:16px;height:16px;stroke-width:1.8}
`;

// Exported: the map draws Places' own rows in its "Nearby" list, wherever it stands (beside the
// Itinerary too, in two panes, where Places itself never mounted).
export function ensureCss() {
  if (document.getElementById("pl-css")) return;
  const s = document.createElement("style");
  s.id = "pl-css";
  s.textContent = CSS;
  document.head.append(s);
}

// ── taxonomy ──────────────────────────────────────────────────────────────────────────────
// The kind row's ORDER is icons.js CATEGORIES, which already leads with practical: sights are
// what you browse, pharmacies are what you need, and an alphabetical facet row would bury the
// one category this screen exists for. Labels come from there too, so a place, its map pin and
// its filter chip cannot drift into three different words for the same thing.

// The words for a place's area come from the trip's own areas (areas.js): "Alfama, Lisbon"
// for a neighborhood, "Lisbon" for a region. Getting the district wrong is exactly the failure
// CONTRACTS.md § "Address ambiguity" is about, so the name is the one the trip gave it. Read
// again only when a snapshot brought new areas (store.areas() is the same array until then).
let areasFrom = null;
let areasRead = readAreas([]);
function useAreas(store) {
  const rows = store.areas();
  if (rows !== areasFrom) { areasFrom = rows; areasRead = readAreas(rows); }
}

const title = (s) => String(s || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
  .replace(/^./, (c) => c.toUpperCase());

// Anchor names are written to be unambiguous on their own page, which makes them far too long
// inside a list row or a header: "Parador Rumor by Casas del Valle" buries the word that
// identifies it. The qualifier after " by " / " - " is always the droppable half.
const shortName = (n, n2 = 18) => clip(String(n || "").split(/\s+[-–—]\s+|\s+by\s+/i)[0].trim(), n2);
// Shorten "Practical" on chips — it is the widest word in the smallest row.
// "Basics" says the same thing (pharmacy, ATM, laundry) in six characters. Local to this
// screen's chips on purpose: icons.js CATEGORY_LABEL stays the canonical long form.
const KIND_SHORT = { practical: "Basics" };
const kindLabel = (k) => {
  const c = categoryOf(k);
  return KIND_SHORT[c] || CATEGORY_LABEL[c] || title(k);
};
function catToneVars(kind) {
  const c = categoryOf(kind);
  return `--ds-k:var(--cat-${c});--ds-k-bg:var(--cat-${c}-bg);--ds-k-edge:var(--cat-${c}-edge);--ds-k-on:var(--cat-${c}-on)`;
}
// The sheet that adds, changes and removes a place (place-editor.js), fetched when first asked for.
const placeEditor = () => import("./place-editor.js");

// What a place is, in one word or two: its subkind as the list of subkinds labels it
// (shared/place-kinds.js), and for a place with none, its kind.
// A declaration, not a const: map.js imports it, and the two modules import each other.
export function placeWhat(p) {
  return subkindLabel(p && p.subkind) || CATEGORY_LABEL[categoryOf(p && p.kind)] || title(p && p.kind);
}
const areaLabel = (a) => areasRead.label(a);

// Chrome glyphs — the list/map toggle, the dismiss X, the outbound arrow. Deliberately NOT
// from icons.js: that module's vocabulary is places, and giving "list view" a place glyph is
// the same category error as giving two subkinds one shape.
const ico = (d, extra = "") =>
  `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"${extra}>${d}</svg>`;
// data-g names the glyph so the view toggle can address its two stacked icons; it is inert
// everywhere else these constants are used.
const ICO_LIST = ico('<path d="M5 7h14M5 12h14M5 17h9"/>', ' data-g="list"');
const ICO_MAP_TOGGLE = ico('<path d="m4 7 5-2 6 2 5-2v12l-5 2-6-2-5 2ZM9 5v12M15 7v12"/>', ' data-g="map"');
const ICO_MAP = ico('<path d="M12 21s6.4-6 6.4-10.4a6.4 6.4 0 1 0-12.8 0C5.6 15 12 21 12 21Z"/>' +
  '<circle cx="12" cy="10.4" r="2.4"/>', ' data-g="map"');
const ICO_X = ico('<path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/>');
const ICO_CHECK = ico('<path d="M5 12.5 10 17.5 19 7"/>');
const ICO_PLUS = ico('<path d="M12 5v14M5 12h14"/>');
const ICO_PENCIL = ico('<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>');
const ICO_NOPIN = ico('<path d="M12 21s6.4-6 6.4-10.4a6.4 6.4 0 0 0-10.6-4.8"/><path d="M5.9 8.6a6.6 6.6 0 0 0-.3 2c0 4.4 6.4 10.4 6.4 10.4"/><path d="M4 4l16 16"/>');
const ICO_GO = ico('<path d="M14 6.5 19.5 12 14 17.5M19 12H5"/>');
const ICO_CHAT = ico('<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V17h0A2.5 2.5 0 0 1 4 14.5v-8Z"/>');

// ── pictures ──────────────────────────────────────────────────────────────────────────────
//
// 46 of 312 places carry a licensed photograph. The list does not show any of them
// — the place page is where a picture earns its space.
//
// NO CREDIT LINE. All image attributions live on one Settings -> Image
// credits page covering every image, so the obligation is met off-screen rather than by a
// caption under every photograph. The three image_* fields still gate rendering: a row with
// an image_url and no image_license is a data bug (migrations/0003_images.sql says so) and is
// refused here independently of what the API did with it, because the cost of being wrong is
// legal rather than cosmetic.
//
// SINCE THE PICTURES ROUTE (model §6): the place's picture, else its old columns until the cutover
// moves them (shared/photo.js: which wins and why).
function shotOf(p) {
  return placePhoto(p);
}

// Heroes that did not load, so a repaint does not re-request them. sw.js precaches the hero
// tier too, but it is explicitly the tier that yields when storage is tight (see syncImages),
// so on the four days with no signal it is the likeliest image not to be in the cache. Falling
// back to the card crop shows the same picture the agenda showed rather than a hole.
const heroFailed = new Set();

// alt is EMPTY on purpose: the picture is a crop of the place whose name is set in 27px type
// two centimetres below it, and a screen reader announcing "The old bridge" twice is worse than
// an image it skips. width/height are the CSS box, so the page reserves the space before a
// byte arrives and the heading under it does not jump as the file decodes.
function heroHtml(p) {
  const shot = shotOf(p);
  if (!shot) return "";
  const useCard = heroFailed.has(shot.hero);
  const src = useCard ? shot.card : shot.hero;
  return `<span class="pl-hero"><img src="${esc(src)}" alt="" width="390" height="219" ` +
    (useCard ? "" : `data-fallback="${esc(shot.card)}" `) + `decoding="async"></span>`;
}

// ── coordinates ───────────────────────────────────────────────────────────────────────────
// 0,0 is an import's "not researched yet" marker (a restaurant nobody looked up). Treat
// it as absent, never as a location: the alternative is a row reading "8,500 km" and a Maps
// pin in the Atlantic.
const hasCoords = (p) => !!p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng) &&
  (Math.abs(+p.lat) > 0.01 || Math.abs(+p.lng) > 0.01);

// ── hours ─────────────────────────────────────────────────────────────────────────────────
// The format, both readers and "open now" live in shared/hours.js, which the server imports
// too. The rule that shapes all of it: when the text does not say exactly when, say NOTHING.
// A wrong "Closed" at 21:00 stops somebody walking to a pharmacy that is in fact open, and a
// wrong "Open" sends them across a city for nothing. Silence plus the text as it was written
// is the honest failure mode, and the detail view always shows that text anyway.
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** A place's hours as windows, or null when they can't be read exactly. The lenient reader:
 *  it takes the one format first, then older spellings it understands word for word. */
export function parseHours(text) {
  const r = readOldHours(String(text || ""));
  return r.ok ? r.hours : null;
}
export { openState };

// Where "now" is: the TRIP's zone, not the device's. Same class of bug as the agenda's — a
// phone still on its home zone's time reports 16:00 on the trip and marks a 17:00 pharmacy shut.
const ZONE_FMT = new Map();
export function nowInZone(tz, at = Date.now()) {
  let f = ZONE_FMT.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US",
        { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    } catch { f = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
    ZONE_FMT.set(tz, f);
  }
  const p = Object.create(null);
  for (const x of f.formatToParts(at)) p[x.type] = x.value;
  return { day: DAY_IDX[String(p.weekday).slice(0, 3).toLowerCase()] ?? 0, min: (+p.hour) * 60 + (+p.minute) };
}

const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const pill = (tone, text, cls = "") =>
  `<span class="pill${tone ? ` pill-${tone}` : ""}${cls ? ` ${cls}` : ""}">${esc(text)}</span>`;

// Every variant carries a WORD as well as a colour — the stylesheet's rule, and the reason
// --ok/--warn are teal and gold instead of green and red.
function openPill(st) {
  if (!st) return "";
  if (st.always) return pill("ok", "Open 24 h");
  if (st.open) {
    if (st.mins <= 45) return pill("warn", `Closing ${hhmm(st.until)}`);
    return pill("ok", `Open till ${hhmm(st.until)}`);
  }
  if (st.today) return pill("warn", `Opens ${hhmm(st.at)}`);
  if (st.tomorrow) return pill("warn", `Closed · opens ${hhmm(st.at)} tomorrow`);
  return pill("warn", `Closed · ${DAY_SHORT[st.day]} ${hhmm(st.at)}`);
}

// The list-row variant. Short enough to sit on the title line beside the name without eating
// it, and still a distinct WORD per state — "Open" / "Closes" / "Opens" / "Closed" are told
// apart by reading them, never by colour alone.
function openPillShort(st) {
  if (!st) return "";
  if (st.always) return `<span class="pl-open pl-open-ok">24 h</span>`;
  if (st.open) {
    return st.mins <= 45
      ? `<span class="pl-open pl-open-warn">Closes ${hhmm(st.until)}</span>`
      : `<span class="pl-open pl-open-ok">Open</span>`;
  }
  if (st.today) return `<span class="pl-open">Opens ${hhmm(st.at)}</span>`;
  return `<span class="pl-open">Closed</span>`;
}

// Drawn, not typed: U+2605 is outside the latin subset the vendored Inter carries, so a literal
// ★ silently falls back to a system face and sits a pixel off the baseline next to the number.
const STAR = `<svg class="pl-star" viewBox="0 0 24 24" aria-hidden="true">` +
  `<path d="M12 3.4l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.8l6-.9Z"/></svg>`;

/** Right-rail mono rating badge shared by Places list rows and Map nearby rows. */
export function placeRatingHtml(p) {
  return p && p.rating_count > 0
    ? `<span class="pl-rate pl-rowrate">${(+p.rating).toFixed(1)}${STAR}</span>`
    : "";
}

const fmtCount = (n) => (+n >= 1000 ? `${Math.round(+n / 100) / 10}k` : String(+n));

// ── view state, kept at module scope on purpose ───────────────────────────────────────────
// The router unmounts this module on every navigation, so instance state would reset the
// filter every time you open a place and come back — which is the single most common thing
// anyone does on this screen. Module scope survives because the module map caches the module.
//
// anchorId is here for a second, stronger reason: the anchored sort must
// persist "while you tap into places and come back, until dismissed" — including when you come
// back via the Places TAB, whose href carries no query at all. So the URL is an INPUT to this
// value, never the store of it: ?near= sets it, the X clears it, and nothing else does.
let sel = { kind: null, sub: null };
let anchorId = null;
let freeMin = 0;                   // from ?free=, the agenda's live-gap connector
// "list" | "map" — which body the screen shows. Module scope for the same
// reason as sel and anchorId: tapping a pin's Details and backing out must land on the map
// you left, and the Places TAB's bare href must not silently reset it. URL is an input.
let view = "list";
// In two panes the list is always the list (its map is the other pane), but the face a narrow
// screen shows is kept here, and the address keeps saying it: turned back under 1024, Places
// opens on the face it had.
let narrowView = null;

const NEAR_RADIUS_M = 2000;        // "walkable from here" for the further-away divider

// ── entry ─────────────────────────────────────────────────────────────────────────────────
export default function mount(el, ctx) {
  ensureCss();
  return ctx.route === "place" ? mountDetail(el, ctx) : mountList(el, ctx);
}

// The router keys its no-op check on the path only, so #/places -> #/places?near=fonda never
// remounts. Watching hashchange here is what makes the agenda's connector work when the user
// is already standing on the list.
function queryOf() {
  const h = location.hash || "";
  const i = h.indexOf("?");
  return new URLSearchParams(i < 0 ? "" : h.slice(i + 1));
}
const pathOf = () => (location.hash || "").replace(/^#/, "").split("?")[0] || "/";

// agenda.js publishes #/places?near=<place_id>&free=<minutes> from its live gap rail: "you are
// sitting at X and have N minutes". A place page publishes ?near= alone. The view toggle
// writes ?view=map, and map.js's #/map route forwards here with it.
//
// Absence NEVER clears — see the note on anchorId; ?view is treated the same way. Returns
// which pieces of state actually changed, so a repaint only happens on a real navigation.
function readQuery() {
  const q = queryOf();
  const v0 = view;
  const ch = { anchor: false, view: false };
  const near = q.get("near");
  if (near) {
    const free = Math.max(0, Math.round(+q.get("free") || 0)) || 0;
    if (near !== anchorId || free !== freeMin) {
      anchorId = near;
      freeMin = free;
      // A new anchor is a new question — "what is around the fonda" — so it clears the kind
      // facets rather than intersecting with whatever was selected three screens ago, and it
      // lands on the LIST: the anchored sort is a list answer. An explicit
      // ?view= in the same URL still wins — it is read after this.
      sel = { kind: null, sub: null };
      view = "list";
      ch.anchor = true;
    }
  }
  const v = q.get("view");
  if (v === "map" || v === "list") view = v;
  ch.view = view !== v0;
  return ch;
}

// The anchor lives in module state, but the URL has to agree with it or a reload, a share, or
// a back-stack entry would silently drop the mode. replace() rather than go(): this is the
// same screen, not a new page, and pushing here would make the back button undo an anchor the
// user never navigated to.
//
// NEVER call this from inside the first paint. router.replace() re-enters router.handle(),
// which early-returns only when `current.path` already matches — and the router assigns
// `current` AFTER awaiting mount(). During the first paint it is still null, so the re-entry
// falls through to a full navigation and mounts this module a second time over the top of
// itself, orphaning the first copy's store and hashchange listeners. It is called from
// event handlers and from a deferred task, both of which run after the mount has landed.
function syncUrl(router) {
  const qs = [
    anchorId ? `near=${encodeURIComponent(anchorId)}` : "",
    anchorId && freeMin ? `free=${freeMin}` : "",
    (narrowView ?? view) === "map" ? "view=map" : "",
  ].filter(Boolean).join("&");
  const want = qs ? `#/places?${qs}` : "#/places";
  if ((location.hash || "#/places") !== want) router.replace(want);
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// LIST
// ══════════════════════════════════════════════════════════════════════════════════════════
function mountList(el, ctx) {
  const { store, router } = ctx;
  readQuery();
  // TWO PANES (from 1024, router.js): the list stays here and its map is the other pane (rest()
  // below), so there is no list/map face to switch between.
  const two = !!ctx.two;
  if (two) { narrowView = view; view = "list"; }

  const head = document.createElement("div");
  head.className = "pl-head ds";
  head.dataset.view = view;
  if (two) head.dataset.two = "1";
  const lists = document.createElement("div");
  lists.className = "pl-lists ds";
  const maphost = document.createElement("div");
  maphost.className = "pl-mapbody";
  maphost.hidden = true;
  // The stage exists for the toggle crossfade: it is the positioned box the outgoing body
  // overlays while the incoming one owns the flow. Margin collapse passes through it, so the
  // geometry is byte-identical to appending the two bodies directly.
  const stage = document.createElement("div");
  stage.className = "pl-stage";
  stage.append(lists, maphost);
  el.append(head, stage);

  let alive = true;
  let sig = "";                    // chip-row signature; rebuilt only when the facets change
  let lastNote = null;             // note line, patched separately from the chip rows
  let lastList = "";               // list html; a no-op store "change" must not repaint
  let asked = false;               // one position read per mount (util.js getPosition contract)
  let mapHandle = null;            // the embedded map, alive only while view === "map"
  let shownView = "list";          // what the DOM currently shows; applyView() reconciles
  let listScroll = 0;              // the list's offset, carried across a round trip to the map
  let animateNext = false;         // set by user interaction only; consumed by the next paint
  let lastScrollAt = 0;            // suppress animation while the finger is scrolling
  let swapEnd = null;              // lands an in-flight toggle crossfade instantly
  // Two panes: the place picked on the map beside the list (or the anchor), its row marked; put
  // back after every redraw of the list, which replaces the rows.
  let pickedId = null;
  function markPicked() {
    let on = null;
    for (const n of lists.querySelectorAll(".pl-row[data-on]")) n.removeAttribute("data-on");
    if (!pickedId) return null;
    const li = rowOf(pickedId);
    on = li && li.querySelector(".pl-row");
    if (on) on.dataset.on = "1";
    return on;
  }

  const mapFilter = () => ({ kind: sel.kind || "all", sub: sel.sub || "all" });

  function paint() {
    useAreas(store);
    const places = store.places();
    const trip = store.trip();
    const now = nowInZone((trip && trip.default_tz) || "UTC");
    const origin = originOf(store, places);
    paintHead(places, origin);
    // The map body paints itself off the store; rebuilding the hidden list under it would be
    // pure waste. It is repainted the moment the list face returns (applyView).
    if (view !== "map") paintList(places, origin, now);
    // Consumed whether or not the list painted: a store "change" must never inherit a stale
    // flag and FLIP a background re-render (guardrail: no entrance animations on background
    // re-render).
    animateNext = false;
  }

  // The map fills exactly the space under the sticky head, measured rather than styled:
  // #view's paddings move with safe-area insets and the dock, and a px height is the only
  // thing that stops #view scrolling a view whose body owns every gesture.
  function sizeMap() {
    if (maphost.hidden) return;
    const top = maphost.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    const pb = parseFloat(getComputedStyle(el).paddingBottom) || 0;
    maphost.style.height = `${Math.max(220, el.clientHeight - top - pb)}px`;
  }

  // Swap the body to whatever `view` says. Mount/destroy rather than hide: a hidden map
  // would keep its GPS watch running, and watchPosition holds the radio awake — the exact
  // battery cost the list's one-read contract exists to avoid.
  //
  // With animation enabled, the two bodies CROSS-FADE — the map fades over while the list
  // scales to .98 and fades under, and the reverse on the way back — and the toggle glyph
  // crossfade-rotates. The outgoing body is lifted to an absolute overlay in .pl-stage so
  // the incoming one owns the layout from the first frame; a translateY counter-transform
  // keeps the rows the user was actually looking at on screen while el.scrollTop moves.
  // Opacity and transform only; reduced motion (and the mount-time call) swaps instantly.
  function endSwap() { if (swapEnd) swapEnd(); }

  function applyView(animate) {
    if (shownView === view) return;
    shownView = view;
    head.dataset.view = view;
    endSwap();
    const anim = !!animate && !reducedMotion();
    const dur = ms("--dur-fast", 120);
    const easing = easeOut();

    if (view === "map") {
      listScroll = el.scrollTop;
      maphost.hidden = false;
      if (anim) {
        // Out of flow BEFORE sizeMap(), or the map measures its height from a rect that
        // still sits below the whole list.
        const ls = listScroll;
        lists.style.cssText =
          `position:absolute;top:0;left:0;right:0;z-index:1;pointer-events:none;` +
          `transform:translateY(${-ls}px);transform-origin:50% ${ls + el.clientHeight / 2}px`;
        maphost.style.position = "relative";
        maphost.style.zIndex = "2";
      } else {
        lists.hidden = true;
      }
      el.scrollTop = 0;
      sizeMap();
      if (!mapHandle) {
        mapHandle = mountMap(maphost, ctx, { bleed: false, filter: mapFilter() });
        // The anchored sort carries over: same question, drawn instead of listed.
        if (anchorId) mapHandle.select(anchorId, { center: true });
      }
      if (anim) {
        const ls = listScroll;
        const a = lists.animate(
          [{ opacity: 1, transform: `translateY(${-ls}px) scale(1)` },
           { opacity: 0, transform: `translateY(${-ls}px) scale(.98)` }],
          // forwards, like a departing ghost: the deadline below cleans it up even if WAAPI
          // never gets a frame (backgrounded mid-toggle).
          { duration: dur, easing, fill: "forwards" });
        const b = maphost.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur, easing });
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          if (swapEnd === finish) swapEnd = null;
          a.cancel(); b.cancel();
          lists.style.cssText = "";
          lists.hidden = true;
          maphost.style.position = "";
          maphost.style.zIndex = "";
        };
        swapEnd = finish;
        a.finished.then(finish, () => {});
        setTimeout(finish, dur + 300);
      }
    } else {
      lists.hidden = false;
      el.scrollTop = listScroll;
      const ls = el.scrollTop;         // read back: a shorter list clamps the restore
      if (anim && mapHandle) {
        const dead = mapHandle;        // fades out under our control, then dies
        mapHandle = null;
        maphost.style.position = "absolute";
        maphost.style.top = "0";
        maphost.style.left = "0";
        maphost.style.right = "0";
        maphost.style.zIndex = "2";
        maphost.style.pointerEvents = "none";
        const a = maphost.animate(
          [{ opacity: 1, transform: `translateY(${ls}px)` },
           { opacity: 0, transform: `translateY(${ls}px)` }],
          { duration: dur, easing, fill: "forwards" });
        lists.style.transformOrigin = `50% ${ls + el.clientHeight / 2}px`;
        const b = lists.animate(
          [{ opacity: 0, transform: "scale(.98)" }, { opacity: 1, transform: "none" }],
          { duration: dur, easing });
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          if (swapEnd === finish) swapEnd = null;
          a.cancel(); b.cancel();
          lists.style.transformOrigin = "";
          dead.destroy();
          maphost.hidden = true;
          maphost.style.cssText = "";
        };
        swapEnd = finish;
        a.finished.then(finish, () => {});
        setTimeout(finish, dur + 300);
      } else {
        if (mapHandle) { mapHandle.destroy(); mapHandle = null; }
        maphost.hidden = true;
        maphost.style.height = "";
      }
    }
    paint();                       // the toggle glyph, and a list left stale under the map
    if (anim) spinToggle();
  }

  // The toggle glyph: outgoing rotates 90deg away as it fades, incoming arrives from -90deg.
  // Both glyphs are always in the button; the head's data-view resting rules decide which one
  // holds, so this only ever animates TO a resting state.
  function spinToggle() {
    const btn = head.querySelector(".pl-viewbtn");
    if (!btn) return;
    const dur = ms("--dur-fast", 120);
    const easing = easeOut();
    const inc = btn.querySelector(view === "map" ? '[data-g="list"]' : '[data-g="map"]');
    const out = btn.querySelector(view === "map" ? '[data-g="map"]' : '[data-g="list"]');
    if (inc) inc.animate(
      [{ opacity: 0, transform: "rotate(-90deg)" }, { opacity: 1, transform: "rotate(0deg)" }],
      { duration: dur, easing });
    if (out) out.animate(
      [{ opacity: 1, transform: "rotate(0deg)" }, { opacity: 0, transform: "rotate(90deg)" }],
      { duration: dur, easing });
  }

  function paintHead(places, origin) {
    const anchor = origin && origin.from === "anchor" ? origin : null;
    const kinds = countBy(places, "kind");
    const subs = sel.kind
      ? countBy(places.filter((p) => p.kind === sel.kind), "subkind")
      : new Map();
    // The signature covers everything that changes the CHIPS or the header identity. The note
    // line under them changes on every GPS tick and is patched separately, because rebuilding
    // the chip rows would throw away their horizontal scroll offset mid-scroll.
    const next = [(anchor && anchor.id) || "", freeMin, view, [...kinds.keys()].join(","),
      sel.kind, [...subs.keys()].join(","), sel.sub].join("|");
    if (next !== sig) {
      sig = next;
      lastNote = null;             // the rebuild just emptied the note's element
      // Tapping the rightmost chip in a scrolled row must not jump the row back to the start
      // and hide the thing you just tapped, so the scroll offsets are carried across.
      const scrolls = [...head.querySelectorAll(".chip-row")].map((r) => r.scrollLeft);
      const more = head.querySelector(".head-more");
      head.innerHTML = topHtml(anchor) + kindRow(kinds) +
        (subs.size > 1 ? subRow(subs) : "") + `<div class="pl-note"></div>`;
      if (more) {
        const end = head.querySelector(".ds-head-end");
        if (end) end.append(more);
      }
      head.querySelectorAll(".chip-row").forEach((r, i) => { if (scrolls[i]) r.scrollLeft = scrolls[i]; });
    }
    const note = noteHtml(origin);
    if (note !== lastNote) {
      lastNote = note;
      head.querySelector(".pl-note").innerHTML = note;
    }
  }

  function paintList(places, origin, now) {
    const rows = places
      .filter((p) => (!sel.kind || p.kind === sel.kind) && (!sel.sub || p.subkind === sel.sub))
      // "Near the fonda" is a question about everything else; the fonda's own 0 m row answers
      // nothing, and the header above already links back to it.
      .filter((p) => !(origin && origin.from === "anchor" && p.id === origin.id))
      .map((p) => decorate(p, origin, places, now))
      .sort(compare(origin));

    // Compared as a string before touching the DOM: store "change" fires on every background
    // sync, and reassigning identical innerHTML causes idle flicker.
    //
    // A USER-caused repaint (chip tap, anchor clear — animateNext) goes through
    // motion.flip() keyed on place.id, so survivors slide, leavers fade down, arrivals fade
    // up — the list never snaps. Everything else (store sync, first paint) is the plain
    // assignment it always was: no entrance animations on re-render, and a container that is
    // still empty is a first mount, not a reorder.
    //
    // Two ceilings, because the 60fps guardrail outranks completeness: WAAPI promotes every
    // animated row to its own layer, and a Practical→All widening is ~180 arrivals at once.
    // Past the caps the arrivals/leavers just appear/disappear while the survivors still
    // slide — which is the part of the effect that carries the identity story. The scroll
    // check is the "never animate under a moving finger" guardrail motion.js leaves to the
    // view: an 80ms-fresh scroll event means momentum, so land instantly instead.
    const put = (html, keys) => {
      if (html === lastList) return;
      lastList = html;
      const anim = animateNext && !lists.hidden && lists.childElementCount > 0 &&
        performance.now() - lastScrollAt > 80;
      if (!anim) { lists.innerHTML = html; markPicked(); return; }
      // A previous exit's ghosts are position:fixed children still inside the container;
      // measured as live rows they would corrupt this pass, so they go first.
      for (const g of [...lists.children]) if (g.style.position === "fixed") g.remove();
      const old = new Set([...lists.querySelectorAll("[data-key]")].map((n) => n.dataset.key));
      const next = new Set(keys || []);
      let enters = 0, exits = 0;
      for (const k of next) if (!old.has(k)) enters++;
      for (const k of old) if (!next.has(k)) exits++;
      flip(lists, () => { lists.innerHTML = html; markPicked(); }, { enter: enters <= 60, exit: exits <= 40 });
    };

    if (!rows.length) { put(emptyHtml(places.length, !!store.trip(), !!store.me()?.guest), ["pl:empty"]); return; }
    if (!origin) {
      const grouped = [];
      for (const r of rows) {
        const area = areaLabel(r.p.area);
        const last = grouped[grouped.length - 1];
        if (last && last.area === area) last.rows.push(r);
        else grouped.push({ area, rows: [r] });
      }
      if (grouped.length === 1 && !grouped[0].area) {
        put(group(rows), rows.map((r) => r.p.id));
        return;
      }
      const keys = [];
      const html = grouped.map((g) => {
        const akey = `pl:area:${g.area || "other"}`;
        keys.push(akey);
        for (const r of g.rows) keys.push(r.p.id);
        return `<div class="pl-area" data-key="${esc(akey)}"><span>${esc(g.area || "Other places")}</span>` +
          `<span class="pl-area-n">${g.rows.length}</span></div>` + group(g.rows);
      }).join("");
      put(html, keys);
      return;
    }

    // A divider instead of a cut-off: the list stays complete, but everything you can get to
    // right now sits above the line. With a gap budget from the agenda the line moves to the
    // round trip that fits — and it moves using the STORED walk_minutes wherever that number
    // is measured from where you actually are, never from a speed derived off the map,
    // because 300 m at 3,400 m is not 300 m at sea level.
    const budget = freeMin || 0;
    const reach = (r) => (budget && r.walk && r.sameAnchor
      ? r.walk * 2 <= budget                 // a real round trip from exactly where you are
      : r.dist <= NEAR_RADIUS_M);
    // Partitioned rather than sliced at an index: once a walk time and a radius are both in
    // play the predicate is not monotonic in distance, and a positional split would drop the
    // divider in the middle of the reachable rows.
    const near = rows.filter(reach);
    const far = rows.filter((r) => !reach(r));
    const label = budget ? `Won't fit in ${fmtSpan(budget * 60_000)}` : "Further away";

    const keys = near.concat(far).map((r) => r.p.id);
    if (near.length && far.length) keys.push("pl:sep");
    put((near.length ? group(near) : "") +
      (near.length && far.length ? `<div class="pl-sep" data-key="pl:sep">${esc(label)}</div>` : "") +
      (far.length ? group(far) : ""), keys);
  }

  // There is NO landing selection. Pre-pressing
  // "Basics" on arrival, which claimed the exact state that deselecting a chip already
  // means — everything — while looking like a filter nobody had asked for. The screen
  // opens with every chip up and the full list showing; nothing anywhere depends on a chip
  // being active (mapFilter() and paintList() both treat null as "all").

  // ONE position read per mount, per the util.js contract, and never a watch: watchPosition
  // holds the GPS chip awake for as long as the page is open, which in an installed PWA that
  // nobody ever closes is all day, on a trip with four days and no charger.
  function readPosition(force) {
    if (asked && !force) return;
    asked = true;
    // On opening, quiet: a read only when the browser already allows it, never the question itself. "Use my location"
    // is the person's own ask (force).
    getPosition(force ? { force: true } : { quiet: true }).then(() => { if (alive) paint(); });
  }

  head.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !head.contains(b)) return;
    let sweep = null;              // selector for the chip whose fill sweeps in
    if (b.dataset.kind !== undefined) {
      const was = sel.kind;
      const k = b.dataset.kind || null;
      sel = { kind: sel.kind === k ? null : k, sub: null };
      if (sel.kind !== was) sweep = `[data-kind="${sel.kind || ""}"]`;
    } else if (b.dataset.sub !== undefined) {
      const was = sel.sub;
      const s = b.dataset.sub || null;
      sel = { kind: sel.kind, sub: sel.sub === s ? null : s };
      if (sel.sub !== was) sweep = `[data-sub="${sel.sub || ""}"]`;
    } else if (b.dataset.act === "add") {
      addPlace();
      return;
    } else if (b.dataset.act === "view") {
      if (two) return;
      view = view === "map" ? "list" : "map";
      syncUrl(router);             // the URL must agree, or a reload drops the mode
      applyView(true);             // a tap, so it earns the crossfade
      return;
    } else if (b.dataset.act === "locate") {
      readPosition(true);
      return;
    } else if (b.dataset.act === "clear-near") {
      anchorId = null;
      freeMin = 0;
      syncUrl(router);             // drops ?near= from the address bar
      animateNext = true;          // the re-sort is a reorder; survivors slide
      if (view !== "map") el.scrollTop = 0;   // before paint, so FLIP is measured at rest
      paint();
      return;
    } else return;
    if (view !== "map") el.scrollTop = 0;
    animateNext = true;            // a chip tap re-filters; the list FLIPs, never snaps
    paint();
    // The colour arrives by sweeping across the pill rather than snapping in.
    // Queried after paint() because the head was just rebuilt; the fill's resting state is
    // fully in place, so this only ever plays TO where the chip already is.
    if (sweep && !reducedMotion()) {
      const fill = head.querySelector(`.chip[aria-pressed="true"]${sweep} .pl-fill`);
      if (fill) {
        const dur = ms("--dur", 220), easing = easeOut();
        fill.animate(
          [{ transform: "translateX(-101%)" }, { transform: "none" }],
          { duration: dur, easing });
        // The fill is SOLID now, so the content's resting ink is --on-solid — which
        // mid-sweep would sit on the not-yet-covered surface. The content fades in with the
        // sweep instead (opacity during animation only; the resting style never dims text).
        const cin = fill.closest(".chip").querySelector(".pl-cin");
        if (cin) cin.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur, easing });
      }
    }
    // The chips filter the PINS exactly as they filter the list.
    if (mapHandle) mapHandle.setFilter(mapFilter());
  });

  // The empty state's "Show all" lives in the list body, not the head — the one control
  // rather than keeping an "All" chip in the header.
  // ── adding a place by hand ──
  // One sheet (place-editor.js). The new place is on this phone when the sheet closes; the
  // list shows it where it sorts, under whatever the chips say: a filter that would hide it
  // is let go, and the list moves only when the row is not already whole on screen.
  function rowOf(id) {
    return [...lists.querySelectorAll("li[data-key]")].find((li) => li.dataset.key === id) || null;
  }
  function showPlace(id) {
    if (!alive) return;
    const p = store.place(id);
    if (!p) return;
    if (view === "map") {
      if (hasCoords(p)) { if (mapHandle) mapHandle.select(id, { center: true }); }
      else toast(`“${p.name}” is in the list. It is not on the map.`);
      return;
    }
    paint();
    if (!rowOf(id) && (sel.kind || sel.sub)) {
      sel = { kind: null, sub: null };
      paint();
    }
    const row = rowOf(id);
    if (!row) return;
    const r = row.getBoundingClientRect();
    const top = head.getBoundingClientRect().bottom;
    const bottom = fab.getBoundingClientRect().top || el.getBoundingClientRect().bottom;
    if (r.top < top - 0.5 || r.bottom > bottom - 8) {
      row.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    }
  }
  const addPlace = async () => {
    const { openPlaceEditor } = await placeEditor();
    if (alive) openPlaceEditor({ onSaved: showPlace });
  };
  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "fab ds ds-fab";
  fab.dataset.placeAdd = "";
  fab.setAttribute("aria-label", "Add a place");
  fab.classList.add("pl-fab");
  fab.innerHTML = ICO_PLUS;
  // On the empty Places the button in the page is the way in; two of them is one too many.
  const fabShown = () => {
    fab.hidden = !store.trip() || !store.places().length;
    head.toggleAttribute("data-empty", !store.trip() || !store.places().length);
    maphost.classList.toggle("pl-under-add", !fab.hidden);
  };
  fabShown();
  fab.addEventListener("click", addPlace);
  ((router && typeof router.fixedLayer === "function") ? router.fixedLayer() : document.body).append(fab);
  const offFab = store.on("change", fabShown);

  lists.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="add-place"]')) { addPlace(); return; }
    const b = e.target.closest('[data-act="clear-filter"]');
    if (!b || !lists.contains(b)) return;
    sel = { kind: null, sub: null };
    animateNext = true;            // same class of user-caused re-filter as a chip tap
    if (view !== "map") el.scrollTop = 0;
    paint();
    if (mapHandle) mapHandle.setFilter(mapFilter());
  });

  const offStore = store.on("change", paint);
  const onHash = () => {
    if (pathOf() !== "/places") return;               // the router is mid-unmount; not ours
    if (two) view = narrowView ?? view;               // the address speaks of the narrow face
    const ch = readQuery();
    if (two) { narrowView = view; view = "list"; }
    // Unconditional: arriving via the Places TAB lands on a bare "#/places" whose href can
    // never carry the anchor or the view, and leaving the address bar disagreeing with the
    // screen is how a reload silently drops a mode the user never dismissed.
    syncUrl(router);
    // A view flip while the screen is up is a real transition wherever it came from, so it
    // crossfades; the mount-time call below is the only instant one.
    if (ch.view && !two) applyView(true);  // paints; also tears the map down on a new anchor
    if (!ch.anchor) return;
    if (view !== "map") el.scrollTop = 0;
    paint();
    if (mapHandle) mapHandle.setFilter(mapFilter());
  };
  addEventListener("hashchange", onHash);
  const onResize = () => { if (alive) sizeMap(); };
  addEventListener("resize", onResize);
  // The head grows and shrinks by a row (the chips arrive with the trip's first places; a
  // kind opens its second row), and the map's body is the box under it: sized again each time.
  const headSize = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
  if (headSize) headSize.observe(head);
  addEventListener("orientationchange", onResize);
  // Feeds the "no animation while the finger is scrolling" check in put(). Passive: it is a
  // timestamp, never work.
  const onScroll = () => { lastScrollAt = performance.now(); };
  el.addEventListener("scroll", onScroll, { passive: true });

  paint();
  if (view === "map") applyView(); // module state can arrive already on the map face
  readPosition(false);
  // Deferred by one task, not called inline — see the note on syncUrl().
  // Only at the list's own address: in two panes the list also stands beside a place's page.
  const urlSync = setTimeout(() => { if (alive && pathOf() === "/places") syncUrl(router); }, 0);

  // Pane B at the list's own address, in two panes: the map, filtered by the same chips (it is
  // mapHandle, so every setFilter and select above reaches it).
  const rest = (paneEl) => {
    const host = document.createElement("div");
    host.className = "pl-mapbody pl-rest";
    paneEl.append(host);
    // Bare: the list is this pane's neighbour, so the map draws no list of its own; a pin tapped
    // (or the anchor the page arrived on) marks its row here, brought into view, and the mark is
    // kept across the list's redraws (markPicked).
    const mark = (id) => {
      pickedId = id || null;
      const row = markPicked();
      if (row) row.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    };
    mapHandle = mountMap(host, ctx, { bleed: false, filter: mapFilter(), bare: true, onPick: mark });
    if (anchorId) mapHandle.select(anchorId, { center: true });
    return () => { if (mapHandle) { mapHandle.destroy(); mapHandle = null; } mark(null); host.remove(); };
  };

  const unmount = () => {
    alive = false;
    clearTimeout(urlSync);
    endSwap();                     // a mid-crossfade unmount must still destroy the old map
    offStore();
    offFab();
    fab.remove();
    removeEventListener("hashchange", onHash);
    removeEventListener("resize", onResize);
    removeEventListener("orientationchange", onResize);
    if (headSize) headSize.disconnect();
    el.removeEventListener("scroll", onScroll);
    if (mapHandle) { mapHandle.destroy(); mapHandle = null; }
    if (two) { view = narrowView ?? view; narrowView = null; }
  };
  return two ? { unmount, rest } : unmount;
}

const group = (rows) => `<ul class="pl-group">${rows.map(rowHtml).join("")}</ul>`;

// ── head ──────────────────────────────────────────────────────────────────────────────────
// Small title top-left, list/map toggle top-right, no app bar. When an anchored sort is
// on, the anchor REPLACES the title: it is what this screen is showing, so it is the screen's
// name, and putting it here rather than in a second sticky band keeps the chrome one row tall.
function topHtml(anchor) {
  const left = anchor
    ? `<div class="pl-anchor">` +
      `<span class="pl-anchor-ico">${getIcon(anchor.kind, anchor.subkind)}</span>` +
      `<span class="pl-anchor-t"><span class="pl-anchor-n">Near ${esc(shortName(anchor.label, 20))}</span>` +
      // The gap's length as the Agenda's card for the same gap says it (fmtSpan): "9h 10m free".
      (freeMin ? `<small>· ${esc(fmtSpan(freeMin * 60_000))} free</small>` : "") + `</span>` +
      `<button type="button" class="pl-x" data-act="clear-near" ` +
      `aria-label="Stop sorting from ${esc(shortName(anchor.label, 20))}">${ICO_X}</button></div>`
    : `<h1 class="pl-h1">Places</h1>`;

  const toMap = view !== "map";
  return `<div class="pl-top ds-head">${left}<div class="ds-head-end">` +
    `<button type="button" class="ds-button ds-button--white pl-headadd" data-act="add">+ Add a place</button>` +
    `<button type="button" class="pl-viewbtn" data-act="view" ` +
    `aria-label="${toMap ? "Show map" : "Show list"}">${ICO_MAP_TOGGLE}${ICO_LIST}</button>` +
    `</div></div>`;
}

const chip = (attrs, on, inner) =>
  `<button type="button" class="chip" ${attrs} aria-pressed="${on ? "true" : "false"}">` +
  (on ? `<i class="pl-clip" aria-hidden="true"><i class="pl-fill"></i></i>` : "") +
  `<span class="pl-cin">` +
  (on ? `<span class="pl-check" aria-hidden="true">${ICO_CHECK}</span>` : "") +
  `${inner}</span></button>`;

function kindRow(kinds) {
  const chips = CATEGORIES.filter((k) => kinds.has(k))
    .concat([...kinds.keys()].filter((k) => !CATEGORIES.includes(k)).sort())
    .map((k) => chip(`data-kind="${esc(k)}" style="${catToneVars(k)}"`, sel.kind === k,
      `${getIcon(k)}<span class="pl-clabel">${esc(kindLabel(k))}</span>`));
  return `<div class="chip-row" role="group" aria-label="Category">` + chips.join("") + `</div>`;
}

function subRow(subs) {
  const chips = [...subs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en"))
    .map(([s]) => chip(`data-sub="${esc(s)}" style="${catToneVars(sel.kind)}"`, sel.sub === s,
      `${getIcon(sel.kind, s)}<span class="pl-clabel">${esc(subkindLabel(s))}</span>`));
  return `<div class="chip-row" role="group" aria-label="Type">` + chips.join("") + `</div>`;
}

// Omit any "sorted by distance from you" subtitle — with distances in the rows it is inferred, and
// a line the reader can derive is a line that trains them to stop reading the header.
//
// What survives is only what CANNOT be inferred: that the numbers were measured from your
// itinerary rather than from a sensor, and the way to turn the sensor on. An anchored sort
// says so in the header above, so it adds nothing here.
function noteHtml(origin) {
  const locate = `<button type="button" class="pl-locbtn" data-act="locate">Use my location</button>`;
  if (origin && origin.from === "agenda") {
    return `<span class="grow">Distances from ${esc(shortName(origin.label))}` +
      `${origin.when ? `, your ${esc(origin.when)} stop` : ""}</span>` + locate;
  }
  if (origin) return "";                       // gps: obvious. anchor: named in the header.
  // No fix and the user has said no: iOS will not re-prompt, so a button here is a lie. The
  // rows carry their district instead, which is the honest answer to "where is this".
  if (positionDenied()) return "";
  return `<span class="grow"></span>` + locate;
}

// ── rows ──────────────────────────────────────────────────────────────────────────────────
// Two lines, one height, ~60px. Title line: the category icon inline (NOT a column of its
// own), the open badge beside it, then the name on ONE ellipsised line so a 30-character
// restaurant and a 6-character ATM produce identical rows. Right rail: distance only.
// The second line starts the same way wherever a place is a row: what it is, then its rating.
// The list and the rows under the map both get it from placeMeta(), and each adds what only
// it knows (`more`, already escaped): the walk and the area here, the area there.
export function placeMeta(p, more = [], { rating = true } = {}) {
  const bits = [esc(placeWhat(p))];
  if (rating && p.rating_count > 0) {
    bits.push(`<span class="pl-rate">${STAR}${(+p.rating).toFixed(1)}</span>`);
  }
  return bits.concat(more.filter(Boolean)).join('<span class="pl-dot">·</span>');
}

function rowHtml(r) {
  const p = r.p;
  const bits = [];
  // walk_minutes appears here in exactly one case: the sort is anchored on the very place this
  // row's walk time was measured FROM, so "6 min walk" is the trip the reader is about to
  // make. Everywhere else it is a number about somewhere they are not, and printing it beside
  // a 5,182 km distance would be nonsensical.
  if (r.showWalk) bits.push(`<b>${esc(fmtMinutes(r.walk))}</b> walk`);
  if (!hasCoords(p)) bits.push("not on the map");
  if (areaLabel(p.area)) bits.push(esc(areaLabel(p.area)));
  if (r.open) bits.push(openPillShort(r.open));

  const hasDist = Number.isFinite(r.dist);
  const rail = hasDist
    ? `<span class="pl-far">${esc(fmtDistance(r.dist))}</span>`
    : placeRatingHtml(p);

  // data-key is motion.flip()'s identity: the row that survives a re-filter SLIDES to its
  // new position because this key says it is the same row.
  return `<li data-key="${esc(p.id)}" style="${catToneVars(p.kind)}"><a class="pl-row" href="#/p/${encodeURIComponent(p.id)}">` +
    `<span class="pl-ico">${getIcon(p.kind, p.subkind)}</span>` +
    `<span class="pl-rowmain">` +
    `<span class="pl-t">` +
    `<span class="pl-name">${esc(p.name)}</span>` +
    `</span>` +
    `<span class="pl-meta">${placeMeta(p, bits, { rating: hasDist })}</span>` +
    `</span>${rail}</a></li>`;
}

// Keyed so a filter that empties the list FLIPs into it: the rows ghost out and the message
// fades up instead of the whole surface snapping.
// `here`: the trip is on this phone, so no places means the trip has none. Without it the
// phone has never reached the server for this trip.
function emptyHtml(total, here, guest = false) {
  if (!total) {
    return `<div class="empty" data-key="pl:empty"><h2 class="h3">No places yet</h2>` +
      (here
        ? `<p class="meta">Nothing has been added to this trip's places.</p>` +
          `<button type="button" class="btn ds-button ds-button--white ds-button--lg pl-add" data-act="add-place">Add a place</button>` +
          `<p class="meta pl-empty-ai">${guest ? GUEST_AI_LINE : `An AI app can fill the trip in too. Connect one from <a href="/account#ai-apps">Your account</a>, under AI apps.`}</p>`
        : `<p class="meta">Waiting for signal.</p>`) + `</div>`;
  }
  const what = sel.sub ? subkindLabel(sel.sub) : sel.kind ? kindLabel(sel.kind) : "";
  // With no "All" chip in the header, the way out of an empty filter is a real control
  // here, not a sentence about one.
  return `<div class="empty" data-key="pl:empty"><h2 class="h3">Nothing under ${esc(what)}</h2>` +
    `<button type="button" class="btn ds-button ds-button--gray ds-button--lg pl-showall" data-act="clear-filter">Show all ${total} places</button></div>`;
}

// ── sorting ───────────────────────────────────────────────────────────────────────────────
function decorate(p, origin, places, now) {
  const dist = origin && hasCoords(p) ? haversine(origin, p) : NaN;
  const walk = +p.walk_minutes || 0;
  const anchor = walk && p.near_anchor ? places.find((q) => q.id === p.near_anchor) : null;
  // Does the stored walk time measure the trip the reader is about to make? Only when the
  // place's own anchor IS the origin. A pharmacy is "6 min from the flat" in one city and also 569 km
  // from the next one; treating that 6 as reachability wherever you happen to be standing is how a
  // pharmacy in another city ends up at the top of a list of what you can walk to.
  const sameAnchor = !!(anchor && origin && origin.id === anchor.id);
  return {
    p, dist, walk, sameAnchor,
    // Shown only under an EXPLICIT anchor, where the sticky header names the frame of
    // reference on screen. An inferred agenda origin is right often enough to sort by and not
    // often enough to make a time claim about.
    showWalk: !!(walk && sameAnchor && origin && origin.from === "anchor"),
    // Open/closed never depends on having an origin — the one thing you want at 21:00 is
    // whether the pharmacy is open, with or without a GPS fix.
    open: p.hours ? openState(parseHours(p.hours), now) : null,
  };
}

function compare(origin) {
  return (a, b) => {
    if (origin) {
      const ad = Number.isFinite(a.dist), bd = Number.isFinite(b.dist);
      if (ad !== bd) return ad ? -1 : 1;             // unlocated places sink, never sort as 0,0
      // Two places are as near as each other when their distances READ the same, in the units the list is drawn in:
      // tied on metres rounded to 10 m, an imperial phone saw "70 ft" above "60 ft" (21 m and 18 m tie and go by name;
      // 27 Nov). The figure shown never falls as the distance grows, so ordering by distance between figures that differ
      // keeps the numbers rising down the list.
      if (ad && fmtDistance(a.dist) !== fmtDistance(b.dist)) return a.dist - b.dist;
    } else {
      // No origin at all: walk_minutes would interleave two cities at random, so group by
      // area first. It is the only ordering that is true without knowing where anyone is.
      const aa = areaLabel(a.p.area), ba = areaLabel(b.p.area);
      if (aa !== ba) return aa.localeCompare(ba, "en");
    }
    const ar = a.p.rating_count > 0 ? +a.p.rating : 0;
    const br = b.p.rating_count > 0 ? +b.p.rating : 0;
    if (ar !== br) return br - ar;
    return a.p.name.localeCompare(b.p.name, "en");
  };
}

// Where distances are measured from, in order of how much the user should trust them.
//
// The EXPLICIT anchor outranks GPS for proximity sorting:
// "everything near the fonda" is a question about the fonda, and answering it from the phone's own
// position would silently return a different list from the one that was asked for.
function originOf(store, places) {
  if (anchorId) {
    const p = places.find((q) => q.id === anchorId);
    if (p && hasCoords(p)) {
      return {
        lat: +p.lat, lng: +p.lng, from: "anchor", id: p.id, label: p.name,
        kind: p.kind, subkind: p.subkind, area: areaLabel(p.area),
      };
    }
    // A stale or mistyped id would otherwise pin the header on a place that does not exist.
    // Only once there IS data to have missed it in — an empty cache means "not synced yet".
    if (places.length) { anchorId = null; freeMin = 0; }
  }

  const pos = lastPosition();
  if (pos) return { lat: pos.lat, lng: pos.lng, from: "gps", id: null, acc: pos.accuracy };

  // No GPS and no explicit anchor: fall back to where the itinerary says you are. It is the
  // only offline answer to "near me" that does not require a sensor, and on a planned trip it
  // is right far more often than it is wrong — but it is labelled, because it is a guess.
  const im = impliedAnchor(store, places);
  if (im) {
    return {
      lat: +im.p.lat, lng: +im.p.lng, from: "agenda", id: im.p.id, label: im.p.name,
      when: fmtTime(im.e.starts_at, im.e.tz),
    };
  }
  return null;
}

function impliedAnchor(store, places) {
  const nowSec = Math.floor(Date.now() / 1000);
  const byId = new Map(places.map((p) => [p.id, p]));
  let best = null, bestGap = Infinity;
  for (const e of store.events()) {
    if (!e.place_id) continue;
    const p = byId.get(e.place_id);
    if (!p || !hasCoords(p)) continue;
    const s = +e.starts_at, en = +e.ends_at || s;
    const gap = nowSec < s ? s - nowSec : nowSec > en ? nowSec - en : 0;
    if (gap < bestGap) { bestGap = gap; best = { p, e }; }
  }
  return best && bestGap <= 6 * 3600 ? best : null;    // beyond that it is a guess, not context
}

function countBy(rows, key) {
  const m = new Map();
  for (const r of rows) { const v = r[key] || "other"; m.set(v, (m.get(v) || 0) + 1); }
  return m;
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// DETAIL
// ══════════════════════════════════════════════════════════════════════════════════════════
function mountDetail(el, ctx) {
  const { store } = ctx;
  const id = ctx.params && ctx.params.id;

  const wrap = document.createElement("div");
  wrap.className = "pl-page ds";
  el.append(wrap);

  let alive = true;
  let lastHtml = "";
  let removed = false;             // this place was just removed here: see "change" below
  let photoOwed = false;           // opened by a link to add its photo: see arrive below

  // What has been said about it: the chat's module, loaded with the page (not with Places), and
  // its watch on this place's messages. The rows go into the page's [data-said] box after every
  // paint, since a paint rewrites the page.
  const chat = import("./chat.js");
  let said = null;                 // the list watchAbout last handed over
  let saidStop = null;
  chat.then((c) => {
    if (!alive) return;
    c.chatStyles();
    saidStop = c.watchAbout("place", id, null, (list) => { said = list; paintSaid(); });
  }).catch((e) => console.warn("[places] the chat's module didn't load", e));
  function paintSaid() {
    const box = wrap.querySelector("[data-said]");
    if (!box || !said) return;
    if (!said.length) { box.innerHTML = `<p class="pl-said-none">Nothing said about it yet.</p>`; return; }
    chat.then((c) => { if (alive && box.isConnected && said) box.innerHTML = c.saidHtml(said); });
  }

  // Its photo, by hand: Add a photo / Change photo / Remove photo beside Change (photo-hand.js).
  // The file field lives on el, outside what paint() rewrites.
  ensurePhotoCss();
  const ph = photoHand({
    target: { trip: store.tripId(), kind: "place", id },
    stored: () => pictureOf(store.place(id)),
    repaint: () => paint(),
    inputHost: el,
    start: () => startPictures(store),
    noun: "place",
  });

  function paint() {
    if (removed) return;
    useAreas(store);
    const places = store.places();
    const p = places.find((q) => q.id === id);
    // Compared before assignment: background sync fires "change" whether or not this place
    // moved, and rewriting identical innerHTML flickers the hero image.
    const html = p ? detailHtml(ph.view(p), places, store, ph) : missingHtml(id);
    if (html !== lastHtml) {
      lastHtml = html;
      wrap.innerHTML = html;
      primeHero();
      ph.painted();
      paintSaid();
    }
    if (photoOwed && p) { photoOwed = false; queueMicrotask(() => { if (alive) ph.arrive(); }); }
  }

  // Hero reveal blurs up from the dominant-colour tile — which is the cat-soft
  // ground .pl-hero already paints behind the photograph. Within the transforms+opacity
  // rule the "blur-up" is a fade with a small scale settle (1.04 -> 1, cropped by the
  // hero's own overflow), not a filter:blur() tween — filter is off the whitelist.
  //
  // Only an image that has NOT decoded yet is animated: a cached hero is complete before
  // this runs and appears instantly, which is also what keeps a background-sync repaint
  // from replaying an entrance. The error-fallback swap re-fires load once and rides the
  // same listener, so the card crop arriving late fades in exactly like the hero would.
  function primeHero() {
    const img = wrap.querySelector(".pl-hero img");
    if (!img || img.complete || reducedMotion()) return;
    // Held transparent while it loads so a progressive decode does not paint over the tile
    // early; the inline style is cleared BEFORE animating, so even a load that lands while
    // the document is hidden (WAAPI stopped) still ends at the correct resting state.
    img.style.opacity = "0";
    img.addEventListener("load", () => {
      img.style.opacity = "";
      img.animate(
        [{ opacity: 0, transform: "scale(1.04)" }, { opacity: 1, transform: "none" }],
        { duration: ms("--dur", 220), easing: easeOut() });
    }, { once: true });
  }

  // Capture phase: the img "error" event does not bubble, so a delegated listener only ever
  // sees it on the way down. One swap per element — data-fallback is removed before the new
  // src is set, so a second failure cannot become a request loop on a phone with no signal.
  wrap.addEventListener("error", (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
    const next = img.dataset.fallback;
    delete img.dataset.fallback;
    heroFailed.add(img.getAttribute("src"));
    img.src = next;
  }, true);

  wrap.addEventListener("click", async (e) => {
    if (ph.click(e.target)) return;
    const t = e.target.closest("[data-act]");
    if (!t) return;
    if (t.dataset.act === "copy") {
      // Both the word and the address line carry data-act="copy", and the confirmation
      // always lands on the word, because that is the thing the reader is watching.
      const btn = wrap.querySelector(".pl-copy");
      let ok = false;
      try { await navigator.clipboard.writeText(t.dataset.text || ""); ok = true; }
      catch { ok = selectNode(wrap.querySelector(".pl-addr-line")); }
      if (!btn) return;
      const was = btn.dataset.label || btn.textContent;
      btn.dataset.label = was;
      btn.textContent = ok ? "Copied" : "Select and copy";
      setTimeout(() => { if (alive && btn.isConnected) btn.textContent = was; }, 1600);
    } else if (t.dataset.act === "locate") {
      getPosition({ force: true }).then(() => { if (alive) paint(); });
    } else if (t.dataset.act === "chat") {
      // The trip's chat, with this place held above its box: the next message is about it.
      chat.then(({ chatAbout }) => chatAbout("place", id)).catch((err) => {
        console.warn("[places] chat not loaded", err);
        toast("The chat couldn't open. Try again.");
      });
    } else if (t.dataset.act === "change") {
      // Removed: this page has nothing left to show, so it goes back where it was opened
      // from, and the repaint that would say "not on this phone" is skipped on the way.
      const { openPlaceEditor } = await placeEditor();
      if (alive) openPlaceEditor({ placeId: id, onRemoved: () => { removed = true; ctx.router.back(); } });
    }
  });

  const offStore = store.on("change", paint);
  paint();
  // One read, cached, shared with the list — see the note in mountList.
  getPosition({ quiet: true }).then(() => { if (alive) paint(); });   // opening: quiet, never the question itself
  // Opened by a link to add its photo (#/p/<id>?photo=add, what an AI app hands the person):
  // the photo's buttons brought into view. The router doesn't remount for a query, so a link
  // followed while this page is open is heard here too.
  // Owed until the place is on this phone (a cold open by the link may come before the trip).
  const arrive = () => { photoOwed = wantsPhoto(location.hash); if (photoOwed) paint(); };
  arrive();
  addEventListener("hashchange", arrive);

  return () => { alive = false; offStore(); ph.stop(); if (saidStop) saidStop(); removeEventListener("hashchange", arrive); };
}

function missingHtml(id) {
  return `<div class="empty"><h2 class="h3">Not on this phone</h2>` +
    `<p class="meta">Waiting for signal.</p>` +
    `<p class="err-detail">${esc(id || "")}</p></div>`;
}

// The universal back button is the shell's, bottom-left, and it is "previous page" — so
// opening a place out of an anchored list and backing out returns to that same anchored list
// without this file drawing a control of its own. Nothing here re-adds an app bar.
function detailHtml(p, places, store, ph) {
  const trip = store.trip();
  const tz = (trip && trip.default_tz) || "UTC";
  const now = nowInZone(tz);
  const st = p.hours ? openState(parseHours(p.hours), now) : null;
  const pos = lastPosition();
  const dist = pos && hasCoords(p) ? haversine(pos, p) : NaN;
  const walk = +p.walk_minutes || 0;
  const anchor = walk && p.near_anchor ? places.find((q) => q.id === p.near_anchor) : null;
  const tags = Array.isArray(p.tags) ? p.tags : [];

  const facts = [];
  if (Number.isFinite(dist)) facts.push(pill("", `${fmtDistance(dist)} away`));
  // The ONLY place walk_minutes is allowed to appear without an anchored sort, and it is named
  // every time: "8 min walk from the parador" is a fact about the anchor, which is what the number
  // actually measures. "8 min walk" on its own would be a claim about the reader's position
  // that the data has never made.
  if (walk && anchor) facts.push(pill("", `${fmtMinutes(walk)} walk from ${shortName(anchor.name)}`));
  if (p.rating_count > 0) {
    // The count is not decoration. A 4.9 from 12 reviews and a 4.6 from 3,000 are different
    // claims, and a bare score presents the weaker one as the better place.
    facts.push(`<span class="pill pl-rate">${STAR}${(+p.rating).toFixed(1)} · ${fmtCount(p.rating_count)} reviews</span>`);
  }
  if (p.price_level > 0) facts.push(pill("", "$".repeat(Math.min(4, +p.price_level))));
  if (st) facts.push(openPill(st));

  const kindLine = [placeWhat(p), areaLabel(p.area)].filter(Boolean).join(" · ");
  // A local name that is the name again is the same line twice: util.js localNameOf decides.
  const local = localNameOf(p);

  // Everything the traveller reads is English (CONTRACTS.md § Language); name_local and the
  // address are the deliberate exceptions. They carry no lang attribute: a trip does not say
  // which language its places are written in, and naming one here would be a guess.
  //
  // Picture first, then the name — the same order as the event detail, and full-bleed because
  // a hero inset inside a page gutter is a thumbnail with ambitions. No inline credit line: all
  // 46 photo attributions live on one Settings page instead.
  let h = `<div>` + heroHtml(p) +
    `<header class="pl-title"><h1 class="h1">${esc(p.name)}</h1>` +
    (local ? `<div class="pl-local">${esc(local)}</div>` : "") +
    `<div class="eyebrow pl-gap"><span class="pl-kindpill" style="${catToneVars(p.kind)}">${getIcon(p.kind, p.subkind)}${esc(placeWhat(p))}</span>${areaLabel(p.area) ? ` · ${esc(areaLabel(p.area))}` : ""}</div></header>`;

  if (p.why) h += `<p class="pl-why">${esc(p.why)}</p>`;

  // No pin is said plainly and quietly: it is how a place a person added by hand usually
  // starts. Details a tool could not confirm keep the warning.
  if (!hasCoords(p)) {
    h += `<p class="pl-nopin">${ICO_NOPIN}<span>${p.address ? "Not on the map: go by the address." : "Not on the map."}</span></p>`;
  } else if (p.confidence === "low") {
    h += `<div class="banner pl-banner">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5v5M12 17h.01"/>` +
      `<path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3l-7.7-13.5a2 2 0 0 0-3.4 0Z"/></svg>` +
      `<span>Unconfirmed details.</span></div>`;
  }

  if (facts.length) h += `<div class="pl-facts">${facts.join("")}</div>`;

  // ── actions ──
  // ONE maps button. The universal https link, never comgooglemaps:// — the scheme
  // dead-ends on a blank page for anyone without the app installed, and at least one phone on
  // this trip will not have it. The https form opens whichever native app the phone has
  // registered and the web when it has none, which is precisely why a second Apple Maps button
  // was never buying anything.
  h += `<div class="pl-acts">` +
    `<a class="btn ds-button ds-button--white ds-button--lg pl-maps-btn" href="${esc(gmapsUrl(p))}" target="_blank" rel="noopener noreferrer">` +
    ICO_MAP + `Open in Maps</a>` +
    (p.phone
      ? `<a class="btn ds-button ds-button--gray ds-button--lg" href="tel:${esc(String(p.phone).replace(/[^\d+]/g, ""))}">` +
        ico('<path d="M6.4 3.5h3l1.5 4-2 1.4a12.4 12.4 0 0 0 6.2 6.2l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A16.8 16.8 0 0 1 4.4 5.7a2 2 0 0 1 2-2.2Z"/>') +
        `Call</a>`
      : "") +
    `</div>` +
    ph.html({ lead: `<button type="button" class="btn btn-sm" data-act="change">${ICO_PENCIL}Change</button>` +
      `<button type="button" class="btn btn-sm" data-act="chat">${ICO_CHAT}Chat about this</button>`, cls: "pl-change" });

  // ── address ──
  // A full-span band in a different ground colour, not a bordered card. The district is
  // never an optional suffix: one city can have an avenue and a street of the same name in
  // two districts, 2.2 km apart, and a driver given only the street name gets it right
  // about half the time. So it is appended as its own line — but ONLY when the address does
  // not already carry it. Printing "Centro, Sierra Clara" under an address that ends "…, Centro,
  // Sierra Clara" trains people to stop reading the line that matters when it is absent.
  const district = areaLabel(p.area);
  const addrLower = String(p.address || "").toLowerCase();
  const needDistrict = district.split(/,\s*/).some((part) => part && !addrLower.includes(part.toLowerCase()));
  const copyText = [p.name, p.address, needDistrict ? district : ""].filter(Boolean).join(", ");
  if (p.address) {
    h += `<section class="pl-band pl-addr"><div class="eyebrow">Address, to show a driver</div>` +
      `<div class="pl-addr-line pl-gap" data-act="copy" data-text="${esc(copyText)}">` +
      `${esc(p.address)}</div>` +
      (needDistrict ? `<div class="pl-addr-dist">${esc(district)}</div>` : "") +
      (p.address_note ? `<div class="pl-addr-note">${esc(p.address_note)}</div>` : "") +
      `<button type="button" class="pl-copy" data-act="copy" data-text="${esc(copyText)}">Copy</button>` +
      `</section>`;
  } else {
    // No address written down: the band says so, with the area when the place has one. A dash
    // under "show this to a driver" is nothing to show, and Copy would have copied the name.
    h += `<section class="pl-band pl-addr"><div class="eyebrow">Address</div>` +
      `<p class="pl-addr-none pl-gap">No address written down.</p>` +
      (district ? `<div class="pl-addr-dist">${esc(district)}</div>` : "") +
      (p.address_note ? `<div class="pl-addr-note">${esc(p.address_note)}</div>` : "") +
      `</section>`;
  }

  if (p.notes) {
    h += `<section class="pl-band"><div class="eyebrow">Notes</div>` +
      `<p class="pl-prose pl-gap">${esc(p.notes)}</p></section>`;
  }

  // ── checkout steps ──
  // Rendered as a checklist, not prose. On the morning you leave, "take the rubbish to level
  // SS" is a task, and a paragraph is how it gets missed. `checkout` arrives as a JSON array of
  // {title, detail}; migration 0005 added the column and the API select may not carry it yet,
  // so this renders nothing rather than throwing when it is absent.
  const steps = checkoutSteps(p);
  if (steps.length) {
    h += `<section class="pl-sec"><div class="section-head"><h2 class="h2">Checking out</h2></div>` +
      `<ol class="pl-steps">` + steps.map((s, i) =>
        `<li class="pl-step"><span class="pl-step-n">${i + 1}</span><span class="grow">` +
        `<span class="pl-step-t">${esc(s.title)}</span>` +
        (s.detail ? `<span class="pl-step-d">${esc(s.detail)}</span>` : "") +
        `</span></li>`).join("") + `</ol></section>`;
  }

  if (p.hours) {
    h += `<section class="pl-sec"><div class="section-head"><h2 class="h2">Hours</h2></div>` +
      (st ? `<div class="pl-gap">${openPill(st)}</div>` : "") +
      `<p class="pl-hours pl-gap">${esc(p.hours)}</p>` +
      // Name the clock only when there IS a verdict. Without one this line would read as an
      // excuse for a judgement nobody made.
      (st ? `<p class="meta pl-gap">${esc(tz.split("/").pop().replace(/_/g, " "))} time · now ${hhmm(now.min)}</p>` : "") +
      `</section>`;
  }

  // ── the outbound link ──
  // No card, no background, and its own element specificity (see the CSS note for the
  // display:block collision that broke the alignment). An Airbnb trips URL is named for what
  // it is: "Website" under a flat you are sleeping in is not what anybody is looking for.
  if (p.website) {
    const air = /airbnb\.[a-z.]+\/(trips|rooms|reservations)/i.test(p.website);
    h += `<a class="pl-out" href="${esc(p.website)}" target="_blank" rel="noopener noreferrer">` +
      `<span class="pl-out-ico">${getIcon(air ? "lodging" : p.kind, air ? "airbnb" : p.subkind)}</span>` +
      `<span class="grow"><span class="pl-link-t">${air ? "Airbnb reservation" : "Website"}</span>` +
      `<span class="pl-link-s">${esc(clip(p.website.replace(/^https?:\/\//, ""), 40))}</span></span>` +
      `<span class="pl-link-d">needs signal</span>` +
      `<span class="pl-out-go">${ICO_GO}</span></a>`;
  }

  if (tags.length) {
    h += `<div class="pl-tags">` +
      tags.map((t) => pill("", title(t))).join("") + `</div>`;
  }

  // ── what has been said about it ──
  // The chat's messages about this place (model §17), listed as a plan's page lists its own:
  // oldest first, by name, from what the chat holds on this phone and the place's own read.
  // chat.js draws the rows into the box after each paint (mountDetail's paintSaid).
  h += `<section class="pl-sec pl-said"><div class="section-head"><h2 class="h2">Said about this place</h2></div>` +
    `<div class="pl-gap" data-said="1"></div></section>`;

  // ── the itinerary side of the connector ──
  const evs = store.events().filter((e) => e.place_id === p.id).slice(0, 4);
  if (evs.length) {
    h += `<section class="pl-sec"><div class="section-head"><h2 class="h2">On the plan</h2></div>` +
      `<div class="pl-rows">` +
      evs.map((e) => {
        // Rendered in the EVENT's zone, with the label whenever that is not the trip's — a
        // bare "23:15" on an America/New_York departure read in the trip's zone is the one bug in this
        // app that makes somebody miss a plane.
        const z = e.tz !== tz ? " " + tzChip(e.starts_at, e.tz) : "";
        return `<a class="pl-link" href="#/e/${encodeURIComponent(e.id)}">` +
          `<span class="grow"><span class="pl-link-t">${esc(e.title)}</span>` +
          `<span class="pl-link-s">${esc(fmtDay(e.starts_at, e.tz))}</span></span>` +
          `<span class="pl-link-d">${esc(e.all_day ? "all day" : fmtTime(e.starts_at, e.tz) + z)}</span></a>`;
      }).join("") +
      `</div></section>`;
  }

  // ── nearby ──
  if (hasCoords(p)) {
    const near = places
      .filter((q) => q.id !== p.id && hasCoords(q))
      .map((q) => ({ q, d: haversine(p, q) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    if (near.length) {
      h += `<section class="pl-sec"><div class="section-head"><h2 class="h2">Nearby</h2></div>` +
        `<div class="pl-rows">` +
        // NEARBY rows share the list row styling: neutral ground, heavy
        // category accent. They carry the same band and the same solid glyph tile as .pl-row
        // rather than a second visual language for the same object.
        near.map(({ q, d }) =>
          `<a class="pl-link pl-link-p" href="#/p/${encodeURIComponent(q.id)}">` +
          `<span class="pl-link-ico">${getIcon(q.kind, q.subkind)}</span>` +
          `<span class="grow"><span class="pl-link-t">${esc(q.name)}</span>` +
          `<span class="pl-link-s">${esc(subkindLabel(q.subkind))}</span></span>` +
          `<span class="pl-link-d">${esc(fmtDistance(d))}</span></a>`).join("") +
        `</div>` +
        // Opens the Places LIST re-sorted from here, names this place in a sticky
        // header with an X, and stays on until that X is tapped.
        `<a class="btn ds-button ds-button--gray ds-button--lg ds-button--block pl-near" href="#/places?near=${encodeURIComponent(p.id)}">` +
        `Everything near ${esc(shortName(p.name))}</a></section>`;
    }
  }

  if (!pos && !positionDenied()) {
    h += `<div class="pl-note" style="margin-top:var(--sp-5)"><span class="grow"></span>` +
      `<button type="button" class="pl-locbtn" data-act="locate">Use my location</button></div>`;
  }
  return h + `</div>`;
}

// `checkout` is TEXT holding a JSON array. It is written by hand into the seed, so every shape
// it could plausibly arrive in is tolerated and anything unrecognisable becomes no section at
// all — an empty "Checking out" heading on the morning you leave is worse than nothing.
function checkoutSteps(p) {
  const raw = p && p.checkout;
  if (!raw) return [];
  let arr = raw;
  if (typeof raw === "string") {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => (typeof s === "string"
      ? { title: s, detail: "" }
      : { title: String((s && s.title) || ""), detail: String((s && s.detail) || "") }))
    .filter((s) => s.title);
}

// ── maps ──────────────────────────────────────────────────────────────────────────────────
function gmapsUrl(p) {
  const u = new URL("https://www.google.com/maps/search/");
  u.searchParams.set("api", "1");
  // With no confirmed coordinates, searching the NAME finds the place; searching 0,0 finds
  // the middle of the Atlantic.
  u.searchParams.set("query", hasCoords(p) ? `${p.lat},${p.lng}` : `${p.name}, ${p.address}`);
  if (p.gmaps_place_id) u.searchParams.set("query_place_id", p.gmaps_place_id);
  return u.toString();
}

// Clipboard needs a secure context; an installed PWA always has one, but a LAN debug session
// over plain http does not. Falling back to selecting the address means the user can still
// long-press → Copy instead of being told "failed".
function selectNode(node) {
  if (!node) return false;
  try {
    const r = document.createRange();
    r.selectNodeContents(node);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return true;
  } catch { return false; }
}

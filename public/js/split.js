// split.js — purchases, who is splitting them, and who owes who. #/split and #/split/:id.
//
// THE QUESTION THIS SCREEN ANSWERS: who owes who. Its headline is that answer, in words and one
// large number, with the one action that settles it ("You owe Ada Reyes / €30.00 / Mark paid").
// Under it, a quiet record of what was paid, newest first, grouped by day. Adding a purchase is
// TWO TAPS AND A NUMBER: the +, the amount (the keypad is up as the sheet opens), Add purchase.
// Everything else in the add sheet is a row that says its answer ("Paid by  You", "Split
// Everyone, evenly") and opens in place, so the common purchase touches none of them.
//
// THE RULES IT KEEPS
//
//   * It is a view. Every byte of data comes through store.js (purchases(), addPurchase(),
//     updatePurchase(), deletePurchase(), addPayment(), members(), currencies(), fx()), which
//     queues writes offline. There is no fetch() here.
//   * Every number comes from money.js: allocate(), convert(), netBalances(), settle(),
//     fmtMoney(), parseAmount(). Nothing in this file rounds money or derives a share by itself;
//     a row's "your share" is netBalances() asked about that one purchase.
//   * Words carry direction ("You owe", "is owed", "settled"), never color. A person's color
//     appears once per row, as their initials mark. --warn appears only on a problem, with its
//     words. Quiet text recedes by ink, never by opacity.
//   * One sync line for the whole app (the shell's): no per-row sync state here.
//
// REPAINT GUARD. emitChange() is global: a packing tick fires "change" too. This module hashes
// only the rows it reads (dataSlice) and does nothing when that hash has not moved.
//
// The route table, the tab registry and sw.js's precache list are the shell's. This module
// exports mount() and nothing else.

import {
  esc, clip, fmtDay, fmtTime, dayKey, toMs, uid, fmtAgo, setDisabled,
} from "./util.js";
import { getIcon, categoryOf, catVars } from "./icons.js";
import { toast } from "./toast.js";
import * as receipts from "./receipts.js";
import { tripIdFromPath, tripKey } from "./trip-here.js";
import { openSheet as openBottomSheet } from "./sheet.js";
import { flip, reducedMotion } from "./motion.js";
import { faceHtml, personTone, personVars } from "../ds/avatar.js";
import { pictureNow, wakePictures } from "./pictures.js";
import {
  CURRENCY_CODES, nameOf, currencyLabel, expOf, symbolOf,
  fmtMoney, parseAmount, toAmountText, restate,
  allocate, convert, netBalances, settle as settleUp, isEqualSplit, equalShares, isPayment,
} from "./money.js";

// ────────────────────────────────────────────────────────────────────────────────────────
// styles
// ────────────────────────────────────────────────────────────────────────────────────────
// ONE injected <style>, idempotently, as the other screens do: it ships inside the module, so
// precaching the module precaches the styles. Named SP_CSS, never `CSS`, which would shadow
// window.CSS (CSS.escape is used below). Tokens only; no hex literals.
//
// ON THE DESIGN SYSTEM (public/ds/). Split's page carries `.ds` and every sheet's frame
// already does (sheet.js), so everything here reads the system's tokens and nothing of styles.css's: the three faces
// (--type-head, --type-ui, --type-mono), the sizes 12/14/16/20/28 and the one number (--size-number), the radii, the
// inks and lines, and the three lengths of motion with their two curves. The system's own parts carry the rest
// (.ds-button, .ds-face, .ds-day). White is the one emphasis: the +, the sheet's button, your own Mark paid. Money is
// in the mono face on one right edge; every big number (the headline, the amount being typed, an opened purchase, a
// payment) is the one number size in the heading face with tabular figures.
const SP_CSS = `
/* ── the page ──────────────────────────────────────────────────────────────────────────
   A phone: head, headline, feed, one column. From the rail's width the column stops at 640.
   From 1180 two columns: the feed on the left, the headline and everything Settle up says on
   the right, standing still while the feed scrolls. 1180 is where they fit beside the rail (248 from 1024): the
   feed at least 480, the gap 48, the side 360, and the page's own margins. */
/* No ground of its own: one ground a screen, the page's (light's paper is not the system's canvas). */
.sp{color:var(--ink-1)}
@media (min-width:768px){.sp{max-width:var(--page-width);margin-inline:auto}}
.sp-wide{display:none}
@media (min-width:1180px){
  .sp:not([data-empty]){max-width:1048px;display:grid;grid-template-columns:minmax(0,640px) 360px;
    grid-template-areas:"head side" "feed side";column-gap:48px;align-items:start}
  .sp:not([data-empty]) .sp-headbox{grid-area:head}
  .sp:not([data-empty]) .sp-feed{grid-area:feed;min-width:0}
  .sp:not([data-empty]) .sp-side{grid-area:side;position:sticky;top:0;padding-top:4px}
  .sp:not([data-empty]) .sp-wide{display:block}
  .sp:not([data-empty]) [data-act="settle"]{display:none}
}
.sp .num,.sp-form .num,.sp-sup .num,.sp-read .num{font-family:var(--type-mono);font-variant-numeric:tabular-nums;letter-spacing:-0.02em}

/* ── the head: the screen's name, the currency the totals are shown in ────────────────────── */
.sp-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:36px;margin:0 0 28px}
.sp-head-end{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.sp-head .head-add svg{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.sp-h1{margin:0;font:500 var(--size-28)/1 var(--type-head);letter-spacing:var(--track-head);color:var(--ink-1)}
/* The named add, drawn as the system's white button: only where the shell's .head-add rule shows one (from 768, and a
   phone on its side), since the button's own display would otherwise put it on a phone beside the +. */
.sp-head .head-add.ds-button{display:none;min-height:var(--control-32);height:var(--control-32);margin:0;padding:0 12px;border-radius:var(--radius-12);
  background:var(--solid);color:var(--on-solid);font:600 var(--size-14)/20px var(--type-ui);filter:none}
@media (min-width:768px),(orientation:landscape) and (max-height:420px) and (min-width:480px){
  .sp-head .head-add.ds-button{display:inline-flex}
  .sp-head .head-add.ds-button[hidden]{display:none}
}
/* A native select dressed as the system's quiet button: "EUR" and a chevron. A real menu on every device. The code shown
   is its own text (.sp-cur-v), and the select lies over it unseen, at 16px: iOS zooms into a focused select under 16px
   (scripts/field_size_check.mjs), and a select drawn itself is as wide as its widest option ("Other currency…"), which
   at 16px crowded Settle up's title at 320 px. */
.sp-cur{position:relative;flex:none;display:inline-flex;align-items:center;min-height:var(--control-44);color:var(--ink-2)}
.sp-cur-pick{position:relative;display:inline-flex;align-items:center;min-height:var(--control-32);padding:0 24px 0 8px;
  font:600 var(--size-14)/20px var(--type-ui);border-radius:var(--radius-12);transition:color var(--dur-150) var(--ease-standard)}
.sp-cur select{position:absolute;inset:0;width:100%;height:100%;opacity:0;appearance:none;-webkit-appearance:none;
  border:0;background:transparent;margin:0;padding:0;font:var(--size-16)/22px var(--type-ui);color:inherit;cursor:pointer}
.sp-cur-pick:has(select:focus-visible){outline:2px solid var(--ring);outline-offset:2px}
.sp-cur-v{pointer-events:none}
@media (hover: hover) and (pointer: fine){.sp-cur-pick:hover{color:var(--ink-1)}}
.sp-cur .sp-chev{position:absolute;right:4px;top:50%;width:16px;height:16px;margin-top:-8px;pointer-events:none}
.sp-cur-k{font-size:var(--size-14);color:var(--ink-2);margin-right:2px;white-space:nowrap;pointer-events:none}

/* ── the headline: no card; the words, the one big number, then the actions ───────────────── */
.sp-hero{margin:0 0 28px}
.sp-hero-words{margin:0 0 4px;font:400 var(--size-16)/1.45 var(--type-ui);color:var(--ink-2);overflow-wrap:anywhere}
.sp-hero-words b,.sp-hero-words strong{font-weight:600;color:var(--ink-1)}
.sp-hero-num{margin:0;font:500 var(--size-number)/1.05 var(--type-head);letter-spacing:var(--track-number);color:var(--ink-1);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.sp-dec{color:var(--ink-3)}
.sp-hero-title{margin:0;font:500 var(--size-28)/1.15 var(--type-head);letter-spacing:var(--track-head);color:var(--ink-1)}
.sp-hero-sub{margin:8px 0 0;font:400 var(--size-16)/1.45 var(--type-ui);color:var(--ink-2);max-width:34em}
/* A state says itself by its glyph and its weight too, never by its color alone. */
.sp-hero-warn{display:flex;align-items:flex-start;gap:8px;margin:8px 0 0;font:600 var(--size-14)/20px var(--type-ui);color:var(--warning)}
.sp-hero-warn svg{flex:none;width:16px;height:16px;margin-top:2px}
.sp-hero-acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:18px}
/* A quiet action: words and a chevron, the system's fade button. */
.sp-quiet{display:inline-flex;align-items:center;gap:6px;min-height:var(--control-32);padding:0 8px;border:0;border-radius:var(--radius-12);
  background:none;font:600 var(--size-14)/20px var(--type-ui);color:var(--ink-2);cursor:pointer;
  transition:color var(--dur-150) var(--ease-standard),transform var(--dur-150) var(--ease-standard)}
.sp-quiet[data-press="1"]{transform:scale(0.97)}
@media (hover: hover) and (pointer: fine){.sp-quiet:hover{color:var(--ink-1)}.sp-quiet:active{transform:scale(0.97)}}
.sp-quiet .sp-chev{width:16px;height:16px}
/* Several people: one line each, the name, what, and a gray Mark paid. */
.sp-hero-list{list-style:none;margin:12px 0 0;padding:0}
.sp-hero-list li{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;column-gap:10px;min-height:52px;
  border-top:1px solid var(--hair)}
.sp-hero-list li:has(> .sp-mark){grid-template-columns:24px minmax(0,1fr) auto auto}
.sp-hero-list li:first-child{border-top:0}
.sp-hero-list .sp-name{min-width:0;font:400 var(--size-16)/1.45 var(--type-ui);color:var(--ink-1);overflow-wrap:break-word;word-break:normal}
.sp-pdot{display:inline-block;flex:0 0 auto;width:10px;height:10px;border-radius:var(--radius-full);background:var(--ds-person, var(--ink-3));margin-right:6px;vertical-align:middle}
.sp-hero-list .num{font-size:var(--size-16);color:var(--ink-1);white-space:nowrap}

/* ── the feed: words on the left, money on one right edge, one initials mark ──────────────── */
.sp-day{margin:0;padding:14px 0 6px;border-top:1px solid var(--hair);font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2)}
.sp-feed > .sp-day:first-child{border-top:0;padding-top:0}
/* Each line is its own row of words then numbers: the name gives way only to the total beside it,
   never to the longer "your share" under it. The whole row answers a press at once. */
.sp-row{display:grid;grid-template-columns:32px minmax(0,1fr);grid-template-areas:"mark l1" "mark l2";
  column-gap:12px;row-gap:0;align-items:center;width:calc(100% + 16px);margin:0 -8px;padding:10px 8px;
  border-radius:var(--radius-16);text-align:left;color:inherit;background:none;border:0;font:inherit;cursor:pointer;
  transition:background var(--dur-150) var(--ease-standard)}
.sp-row[data-press="1"]{background:var(--fill-hover)}
@media (hover: hover) and (pointer: fine){.sp-row:active{background:var(--fill-hover)}}
.sp-mark{align-self:center}
.sp-row > .sp-mark{grid-area:mark}
.sp-l1,.sp-l2{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0}
.sp-l1{grid-area:l1}
.sp-l2{grid-area:l2}
.sp-what{flex:1 1 auto;min-width:0;font:600 var(--size-16)/22px var(--type-ui);color:var(--ink-1);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* A purchase with nothing typed for what it was: its fallback name, quieter. */
.sp-what[data-fallback="1"]{font-weight:400;color:var(--ink-2)}
.sp-row[data-kind="payment"] .sp-what{white-space:normal;overflow-wrap:anywhere}
.sp-total{flex:none;margin-left:auto;font:400 var(--size-16)/22px var(--type-mono);letter-spacing:-0.02em;
  color:var(--ink-1);white-space:nowrap;font-variant-numeric:tabular-nums}
.sp-by{flex:1 1 auto;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:0 8px;
  font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2)}
.sp-mine{flex:none;margin-left:auto;font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2);white-space:nowrap}
.sp-mine .num{font-size:var(--size-14)}
.sp-rc{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;color:var(--ink-2)}
.sp-rc .ico{width:14px;height:14px}
.sp-rc[data-state="refused"]{color:var(--warning)}

/* ── cold states ──────────────────────────────────────────────────────────────────────── */
.sp-skel-row{display:flex;align-items:center;gap:12px;min-height:56px;padding:10px 0}
.sp-skel-sq{width:32px;height:32px;border-radius:var(--radius-full);background:var(--gray-3)}
.sp-skel-l1{height:14px;border-radius:7px;width:58%;background:var(--gray-3)}
.sp-skel-l2{height:12px;border-radius:6px;width:36%;margin-top:8px;background:var(--gray-2)}
.sp-skel-amt{width:64px;height:14px;border-radius:7px;flex:0 0 auto;background:var(--gray-3)}

/* ── settle up (the sheet, and the right column from 1180) ─────────────────────────────── */
.sp-sup{display:flex;flex-direction:column}
.sp-s-total{margin:6px 0 22px;font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2)}
.sp-s-head{margin:26px 0 4px;font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2)}
.sp-s-head:first-child{margin-top:0}
.sp-plan{list-style:none;margin:0;padding:0}
.sp-plan li{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;column-gap:12px;min-height:52px;
  border-top:1px solid var(--hair)}
.sp-plan li:first-child{border-top:0}
.sp-plan .sp-tr-words{font:400 var(--size-16)/1.45 var(--type-ui);color:var(--ink-1);overflow-wrap:break-word;word-break:normal}
.sp-plan .num{font-size:var(--size-16);color:var(--ink-1);white-space:nowrap}
.sp-plan-sum{margin:4px 0 0;font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2)}
.sp-balrow{display:flex;align-items:center;gap:12px;border-top:1px solid var(--hair)}
.sp-balrow:first-of-type{border-top:0}
.sp-bal{display:flex;align-items:center;gap:12px;flex:1 1 auto;min-width:0;min-height:var(--control-44);padding:0;
  border:0;text-align:left;color:inherit;background:none;font:inherit;cursor:pointer}
.sp-bal-name{flex:1 1 auto;min-width:0;font:400 var(--size-16)/1.45 var(--type-ui);color:var(--ink-1);overflow-wrap:break-word;word-break:normal}
.sp-bal-say{flex:none;font:400 var(--size-16)/1.45 var(--type-ui);color:var(--ink-2);white-space:nowrap}
.sp-bal-say .num{color:var(--ink-1)}
.sp-bal[data-settled] .sp-bal-say{color:var(--ink-2)}
.sp-bal .sp-chev{flex:none;width:16px;height:16px;color:var(--ink-4);transition:transform var(--dur-200) var(--ease-standard)}
.sp-bal[aria-expanded="true"] .sp-chev{transform:rotate(180deg)}
.sp-bal-why{margin:0 0 8px;font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2)}
.sp-sup .sp-row{width:calc(100% + 16px)}
.sp-record{align-self:stretch;margin-top:18px}
.sp-fine{margin:16px 0 0;font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2)}
.sp-banner{display:flex;flex-direction:column;gap:8px;align-items:flex-start;margin:0 0 16px}
.sp-banner p{margin:0;font:400 var(--size-14)/20px var(--type-ui);color:var(--warning)}
.sp-block-head{margin:32px 0 12px;font:500 var(--size-20)/1.25 var(--type-head);letter-spacing:var(--track-head);color:var(--ink-1)}
.sp-block:first-of-type .sp-block-head{margin-top:8px}
.sp-side .sp-sup{margin-top:8px}

/* ── a choice between two (Combined / By currency, Evenly / By amount): the system's segmented control ── */
.sp-seg{display:inline-flex;gap:2px;margin:0 0 12px;padding:2px;border-radius:var(--radius-12);background:var(--well);border:1px solid var(--hair)}
.sp-seg button{display:inline-flex;align-items:center;gap:6px;min-height:var(--control-28);padding:0 12px;border:0;
  border-radius:9px;background:transparent;color:var(--ink-2);font:600 var(--size-14)/20px var(--type-ui);cursor:pointer;
  transition:background var(--dur-200) var(--ease-standard),color var(--dur-200) var(--ease-standard)}
.sp-seg button[aria-checked="true"],.sp-seg button[aria-pressed="true"]{background:var(--fill-active);color:var(--ink-1)}
/* The chosen half's tint is the mark, as the system's segmented control has it: no check inside it. */
.sp-seg .sp-tick{display:none}

/* ── the sheets: add, edit, a payment ─────────────────────────────────────────────────── */
.sp-form{display:flex;flex-direction:column}
/* The amount is the sheet's headline: the one number size in the heading face with tabular figures, as every big
   number is (the headline, an opened purchase, a payment); the currency a quiet word. */
.sp-amtline{display:flex;align-items:center;gap:4px;margin:0 0 14px}
.sp-sym{flex:none;font:500 var(--size-number)/1.05 var(--type-head);letter-spacing:var(--track-number);color:var(--ink-3);
  font-variant-numeric:tabular-nums}
.sp-form .sp-amtin{flex:1 1 auto;min-width:0;width:auto;height:60px;margin:0;padding:0;border:0;border-radius:0;
  background:transparent;box-shadow:none;outline:none;caret-color:var(--ink-1);
  font:500 var(--size-number)/1.05 var(--type-head);letter-spacing:var(--track-number);color:var(--ink-1);font-variant-numeric:tabular-nums}
.sp-form .sp-amtin::placeholder{color:var(--ink-4)}
.sp-form .sp-amtin:focus-visible{outline:none}
.sp-curbtn{flex:none;display:inline-flex;align-items:center;gap:6px;min-height:var(--control-28);padding:0 10px;
  font:600 var(--size-14)/20px var(--type-ui);color:var(--ink-2);background:var(--fill);border:1px solid var(--edge);
  border-radius:var(--radius-12);cursor:pointer;transition:background var(--dur-150) var(--ease-standard),color var(--dur-150) var(--ease-standard)}
.sp-curbtn .sp-chev{width:16px;height:16px;transition:transform var(--dur-200) var(--ease-standard)}
.sp-curbtn[aria-expanded="true"]{background:var(--fill-active);color:var(--ink-1)}
.sp-curbtn[aria-expanded="true"] .sp-chev{transform:rotate(180deg)}
.sp-curbtn:disabled{color:var(--ink-4)}
.sp-currow{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
/* "What was it?": the one thing typed in a sheet gets the system's box. 16px, so a phone doesn't zoom. */
.sp-form .sp-whatin{display:block;width:100%;height:var(--control-44);margin:0 0 10px;padding:0 14px;
  border:1px solid var(--edge);border-radius:var(--radius-16);background:var(--well);box-shadow:none;outline:none;
  font:400 var(--size-16)/1 var(--type-ui);color:var(--ink-1);transition:border-color var(--dur-150) var(--ease-standard)}
.sp-form .sp-whatin::placeholder{color:var(--ink-3)}
.sp-form .sp-whatin:focus{border-color:var(--edge-strong)}
/* The rows that say their answer: the system's option rows. Label left, answer right, a chevron; a hairline between. */
.sp-opts{display:flex;flex-direction:column}
.sp-opt{display:grid;grid-template-columns:auto minmax(0,1fr) 16px;align-items:center;column-gap:12px;
  width:100%;min-height:48px;padding:0;text-align:left;background:none;border:0;border-top:1px solid var(--hair);
  font:inherit;color:inherit;cursor:pointer}
.sp-opts > .sp-opt:first-child{border-top:0}
.sp-opt-k{font:400 var(--size-16)/1.45 var(--type-ui);color:var(--ink-2)}
.sp-opt-v{justify-self:end;max-width:100%;font:400 var(--size-16)/1.45 var(--type-ui);color:var(--ink-1);text-align:right;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sp-opt .sp-chev{width:16px;height:16px;color:var(--ink-4);transition:transform var(--dur-200) var(--ease-standard)}
.sp-opt[aria-expanded="true"] .sp-chev{transform:rotate(90deg)}
.sp-opt[aria-expanded="true"] .sp-opt-k{color:var(--ink-1)}
div.sp-opt{cursor:default}
.sp-bad{display:inline-flex;align-items:center;gap:4px;color:var(--warning);font-weight:600}
.sp-bad svg{width:16px;height:16px}
.sp-pane{padding:0 0 12px}
.sp-pane:not([hidden]),.sp-currow:not([hidden]){animation:sp-open var(--dur-200) var(--ease-standard)}
@keyframes sp-open{from{opacity:0;transform:translateY(-4px)}}
/* A person to choose: their mark, their name, a check when chosen. One chosen (Paid by, From, To): a quiet filled row
   with a white check; several (who's in): a check each. Never the fill alone. */
.sp-people{display:flex;flex-direction:column}
.sp-person{display:grid;grid-template-columns:32px minmax(0,1fr) 24px;align-items:center;column-gap:12px;
  width:calc(100% + 16px);min-height:var(--control-44);margin:0 -8px;padding:6px 8px;border-radius:var(--radius-16);
  text-align:left;background:none;border:0;color:var(--ink-1);font:400 var(--size-16)/1.45 var(--type-ui);cursor:pointer;
  transition:background var(--dur-150) var(--ease-standard)}
.sp-person .sp-mark{grid-area:auto;align-self:center;margin:0}
.sp-person .sp-pname{min-width:0;overflow-wrap:anywhere}
.sp-person[data-press="1"]{background:var(--fill-hover)}
@media (hover: hover) and (pointer: fine){.sp-person:active{background:var(--fill-hover)}}
.sp-person[aria-checked="true"]{font-weight:600}
.sp-person[role="radio"][aria-checked="true"]{background:var(--fill)}
.sp-person .sp-box{justify-self:end;display:grid;place-items:center;width:22px;height:22px;border-radius:var(--radius-full);
  box-shadow:inset 0 0 0 1.5px var(--edge-strong);color:var(--on-solid)}
.sp-person .sp-box .sp-tick{width:14px;height:14px;opacity:0;transition:opacity var(--dur-150) var(--ease-standard)}
.sp-person[aria-checked="true"] .sp-box{background:var(--solid);box-shadow:none}
.sp-person[aria-checked="true"] .sp-box .sp-tick{opacity:1}
.sp-person[role="radio"] .sp-box{box-shadow:none;background:none;color:var(--ink-1)}
.sp-person[role="radio"][aria-checked="true"] .sp-box{background:none}
.sp-person[data-gone] .sp-pname{color:var(--ink-2)}
.sp-gone{font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2)}
.sp-person:disabled{color:var(--ink-3);cursor:default}
/* The Split pane: each person and their share at the right. By amount, a small boxed field beside each person in. */
.sp-who{display:grid;grid-template-columns:minmax(0,1fr) 96px;align-items:center;column-gap:8px}
.sp-who .sp-person{grid-template-columns:32px minmax(0,1fr) 24px;width:calc(100% + 8px);margin-right:0}
.sp-who .sp-person:not([aria-checked="true"]) .sp-pname{color:var(--ink-2)}
.sp-form .sp-uin{width:100%;height:var(--control-32);margin:0;padding:0 10px;border:1px solid transparent;border-radius:var(--radius-12);
  background:transparent;box-shadow:none;outline:none;text-align:right;
  font:400 var(--size-16)/1 var(--type-mono);letter-spacing:-0.02em;color:var(--ink-1);font-variant-numeric:tabular-nums}
.sp-split[data-by="amount"] .sp-uin{background:var(--well);border-color:var(--edge)}
.sp-form .sp-uin:focus{border-color:var(--edge-strong)}
.sp-form .sp-uin::placeholder{color:var(--ink-4)}
.sp-sumline{display:flex;align-items:center;gap:8px;margin:8px 0 0;font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2)}
.sp-sumline[data-state="short"],.sp-sumline[data-state="over"]{color:var(--warning);font-weight:600}
.sp-go .sp-sumline{margin:0 0 8px}
.sp-sumline svg{width:16px;height:16px;flex:none}
.sp-note{margin:8px 0 0;font:400 var(--size-14)/20px var(--type-ui);color:var(--warning)}
.sp-days{display:flex;flex-wrap:wrap;gap:8px;padding-top:4px}
/* A day or a currency to pick: the system's chip; chosen is filled with a check. */
.sp-chip{display:inline-flex;align-items:center;gap:6px;min-height:var(--control-32);padding:0 12px;border-radius:var(--radius-full);
  border:1px solid var(--edge);background:transparent;color:var(--ink-2);font:600 var(--size-14)/20px var(--type-ui);cursor:pointer;
  transition:background var(--dur-150) var(--ease-standard),color var(--dur-150) var(--ease-standard),transform var(--dur-150) var(--ease-standard)}
.sp-chip[data-press="1"]{transform:scale(0.97)}
@media (hover: hover) and (pointer: fine){.sp-chip:active{transform:scale(0.97)}}
.sp-chip[aria-checked="true"],.sp-chip[aria-pressed="true"]{background:var(--fill-active);border-color:var(--edge-strong);color:var(--ink-1)}
.sp-days .sp-tick{width:14px;height:14px}
/* The receipt, once added: the picture small, its state in words, Change and Remove. */
.sp-rcpt{display:grid;grid-template-columns:48px minmax(0,1fr);column-gap:12px;align-items:center;padding:0 0 12px}
.sp-rcpt-thumb{position:relative;width:48px;height:64px;margin:0;padding:0;overflow:hidden;
  border-radius:var(--radius-8);border:1px solid var(--edge);background:var(--well)}
.sp-rcpt-thumb img{display:block;width:100%;height:100%;object-fit:cover}
.sp-rcpt-thumb::before{content:"";position:absolute;inset:-4px}
.sp-rcpt-side{min-width:0;display:flex;flex-direction:column;gap:2px}
.sp-rcpt-state{font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2);overflow-wrap:anywhere}
.sp-rcpt-state[data-state="refused"]{color:var(--warning)}
.sp-rcpt-acts{display:flex;gap:8px}
.sp-rcpt-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.sp-rcpt-view{display:flex;flex-direction:column;gap:8px}
.sp-rcpt-view img{display:block;width:100%;height:auto;border-radius:var(--radius-16);background:var(--gray-1)}
/* THE BUTTON at the sheet's foot, full width, held above the keyboard. Sticky to the foot of the
   sheet's scrollport, which stops short of the body's bottom padding; the shell grows that
   padding by the keyboard's height while the keys are up (.sh-root[data-kb="1"] .sh-body), so the
   button stands on the keys with nothing of its own to add. The negative offset lays it over the
   padding's own 16 px when the keys are down, at the sheet's foot. */
.sp-go{position:sticky;bottom:-16px;z-index:2;margin-top:16px;padding:12px 0 16px;background:var(--chrome)}
.sp-foot,.sp-chatrow{display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin-top:8px}
.sp-foot .sp-del{color:var(--negative)}
.sp-armnote{margin:0 0 4px;font:400 var(--size-14)/20px var(--type-ui);color:var(--negative)}
.sp-armed{padding:0 12px !important;border-radius:var(--radius-12);background:var(--negative-bg) !important;color:var(--negative) !important;
  box-shadow:inset 0 0 0 1px var(--negative-edge)}
.sp-chat .ico{width:16px;height:16px}

/* ── a purchase, opened (someone else's: read, not a form) ─────────────────────────────── */
.sp-read{display:flex;flex-direction:column}
.sp-read-amt{margin:0;font:500 var(--size-number)/1.05 var(--type-head);letter-spacing:var(--track-number);color:var(--ink-1);
  font-variant-numeric:tabular-nums}
.sp-read-conv{margin:2px 0 0;font:400 var(--size-16)/1.45 var(--type-ui);color:var(--ink-2)}
.sp-read-meta{margin:8px 0 0;font:400 var(--size-16)/1.45 var(--type-ui);color:var(--ink-2);overflow-wrap:anywhere}
.sp-read-shares{list-style:none;margin:16px 0 0;padding:0}
.sp-read-shares li{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:var(--control-44);
  border-top:1px solid var(--hair);font:400 var(--size-16)/1.45 var(--type-ui);color:var(--ink-1)}
.sp-read-shares li:first-child{border-top:0}
.sp-read-shares .num{white-space:nowrap}
.sp-read-how{margin:0 0 4px;font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2)}
.sp-read-note{margin:16px 0 0;font:400 var(--size-16)/1.45 var(--type-ui);color:var(--ink-2);white-space:pre-wrap;overflow-wrap:anywhere}
.sp-read-att{display:flex;align-items:center;gap:8px;margin:16px 0 0;font:400 var(--size-16)/1.45 var(--type-ui);color:var(--ink-1)}
.sp-read-att .ico,.sp-read-att svg{width:16px;height:16px;flex:none;color:var(--ink-3)}
.sp-read .sp-rcpt{margin-top:16px}
.sp-read-who{margin:16px 0 0;font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2)}

/* ── the pickers stacked over a sheet (what it goes with, another currency) ─────────────── */
.sp-pick{display:flex;flex-direction:column}
.sp-pick-head{margin:24px 0 4px;font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2)}
.sp-pick-head:first-child{margin-top:0}
.sp-pickrow{display:flex;align-items:center;gap:12px;width:100%;min-height:var(--control-44);
  padding:8px 4px;text-align:left;color:inherit;border-radius:var(--radius-16);background:none;border:0;font:inherit;cursor:pointer;
  transition:background var(--dur-150) var(--ease-standard)}
.sp-pickrow[data-press="1"]{background:var(--fill-hover)}
@media (hover: hover) and (pointer: fine){.sp-pickrow:active{background:var(--fill-hover)}}
.sp-pickrow .ico{flex:0 0 auto;width:16px;height:16px;color:var(--ds-k, var(--ink-3))}
.sp-pickrow-name{flex:1 1 auto;min-width:0;font:400 var(--size-16)/1.45 var(--type-ui);color:var(--ink-1);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sp-pickrow-sub{flex:0 0 auto;font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2)}
/* For totals, a currency with no exchange rate yet: shown, recolored, its reason in words under its name (§8.1). */
.sp-pickrow:disabled{cursor:default}
.sp-pickrow:disabled .sp-pickrow-name{color:var(--ink-2)}
.sp-pickrow-why{display:block;font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2)}
.sp-dayrow{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;
  min-height:var(--control-44);padding:8px 4px;border-radius:var(--radius-16);text-align:left;
  background:none;border:0;font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2);cursor:pointer}
.sp-dayrow[data-press="1"]{background:var(--fill-hover)}
@media (hover: hover) and (pointer: fine){.sp-dayrow:active{background:var(--fill-hover)}}
.sp-dayrow-add{flex:0 0 auto;color:var(--ink-1)}
.sp-filter{margin-bottom:8px}
.sp-tick{width:14px;height:14px;flex:0 0 auto}
`;

function ensureStyles() {
  if (document.getElementById("sp-styles")) return;
  const s = document.createElement("style");
  s.id = "sp-styles";
  s.textContent = SP_CSS;
  document.head.append(s);
}

// ────────────────────────────────────────────────────────────────────────────────────────
// glyphs (generic UI glyphs live in the module that draws them; icons.js is place kinds)
// ────────────────────────────────────────────────────────────────────────────────────────
// The torn receipt: a silhouette nothing else in the app has.
const SVG_RECEIPT = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3.5h13v15.2l-2.2-1.6-2.15 1.6-2.15-1.6-2.15 1.6-2.2-1.6z"/><path d="M9 8h6M9 11.5h6"/></svg>`;
const SVG_PLUS = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
const SVG_TICK = `<svg class="sp-tick" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5 9.5 17.5 19.5 6.5"/></svg>`;
const SVG_OK = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5 9.5 17.5 19.5 6.5"/></svg>`;
// A problem's glyph: a circle with a bar and a dot. It goes with --warn and the words.
const SVG_ALERT = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.6v5.2"/><path d="M12 16.3v.1"/></svg>`;
const SVG_CHEV_D = `<svg class="sp-chev" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
const SVG_CHEV_R = `<svg class="sp-chev" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`;
const SVG_CHAT = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V17h0A2.5 2.5 0 0 1 4 14.5v-8Z"/></svg>`;
const SVG_CLOCK = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3 1.8"/></svg>`;

// ────────────────────────────────────────────────────────────────────────────────────────
// per-device preferences (localStorage, wrapped: private-mode Safari throws on both)
// ────────────────────────────────────────────────────────────────────────────────────────
const PREF_DISPLAY = "wgp.split.display";     // the currency totals are shown in
const PREF_LAST = "wgp.split.currency";       // the currencies used on this device, newest first
// Both are choices about this trip, stored once per trip (TRIP_KEYS in trip-here.js).
const here = (k) => tripKey(k, tripIdFromPath(location.pathname));
function readPref(k) {
  try { return localStorage.getItem(k) || ""; } catch { return ""; }
}
function writePref(k, v) {
  try { localStorage.setItem(k, v); } catch { /* private mode: the default is fine */ }
}

// A short list, not one value: a currency chosen from the long picker is one this person needs,
// and undoing a mis-tap must not mean the long picker again. Four is enough for any trip.
const MRU_MAX = 4;
function recentCurrencies() {
  return readPref(here(PREF_LAST)).split(",").map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{3}$/.test(c));
}
function rememberCurrency(code) {
  const next = [code, ...recentCurrencies().filter((c) => c !== code)].slice(0, MRU_MAX);
  writePref(here(PREF_LAST), next.join(","));
}

// ────────────────────────────────────────────────────────────────────────────────────────
// pure helpers
// ────────────────────────────────────────────────────────────────────────────────────────

// "ada" -> AD, "ada reyes" -> AR: the rule functions/api/trip.js and agenda.js use, so a person
// has the same initials on every screen.
function initialsFrom(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * Who has left the trip, or whose account is gone: the snapshot keeps them on the roster
 * (`left_at`, `deleted`) because what they paid and shared is still here under their id. A new
 * purchase never assumes them: they come after everyone still on it, unticked, and marked.
 */
const isGone = (m) => !!(m && (m.left_at || m.deleted));
const stillOn = (members) => members.filter((m) => !isGone(m));
/** Everyone still on the trip, then those who aren't. */
const peopleOrder = (members) => [...stillOn(members), ...members.filter(isGone)];

/**
 * Everything needed to draw one person: the inline tint, their initials, and their names. An id
 * the roster has never heard of still draws ("??" on neutral paper): money attached to a name
 * this phone has not synced is still money.
 */
function skinOf(members, id, meId) {
  const m = members.find((x) => x && x.id === id);
  const name = (m && m.name) || "";
  const initials = (m && m.initials) || (name ? initialsFrom(name) : "??");
  const first = name.trim().split(/\s+/)[0] || "Someone";
  return {
    id,
    name: name || "Someone",
    first,
    label: id === meId ? "You" : (name || "Someone"),
    initials,
    me: id === meId,
    color: (m && m.note_color) || "",
    // The picture they drew (its hash on the roster), drawn over the initials once it has come.
    picture: (m && typeof m.avatar === "string" && /^[A-Za-z0-9_-]{12}$/.test(m.avatar)) ? m.avatar : "",
  };
}

/**
 * A person's first name where nobody else on the trip has it ("Ada"), their whole name where
 * somebody does: for a line that has to stay on one line.
 */
function shortName(members, skin) {
  const same = members.filter((m) => m && m.name && m.name.trim().split(/\s+/)[0].toLowerCase() === skin.first.toLowerCase());
  return same.length > 1 ? skin.name : skin.first;
}
/** "You pay Ada", "Ben pays you": the plan's lines, short, with a subtle person dot beside non-self names. */
const pdot = (skin, meId) => {
  if (skin.id === meId) return "";
  const v = personVars(skin.color);
  return v ? `<span class="sp-pdot" data-person="${personTone(skin.color)}" style="${v}" aria-hidden="true"></span>` : "";
};
const paysShortHtml = (members, from, to, meId) =>
  `${pdot(from, meId)}${esc(from.id === meId ? "You" : shortName(members, from))} ${from.id === meId ? "pay" : "pays"} ${pdot(to, meId)}${esc(to.id === meId ? "you" : shortName(members, to))}`;
const paysShort = (members, from, to, meId) =>
  `${from.id === meId ? "You" : shortName(members, from)} ${from.id === meId ? "pay" : "pays"} ${to.id === meId ? "you" : shortName(members, to)}`;

/** "You pay Ada Reyes", "Ben Okafor pays you", "You paid Ada Reyes": the viewer is "You". */
const subjectOf = (skin, meId) => (skin.id === meId ? "You" : skin.name);
const objectOf = (skin, meId) => (skin.id === meId ? "you" : skin.name);
const paysWords = (from, to, meId) => `${subjectOf(from, meId)} ${from.id === meId ? "pay" : "pays"} ${objectOf(to, meId)}`;
const paidWords = (from, to, meId) => `${subjectOf(from, meId)} paid ${objectOf(to, meId)}`;

/**
 * One person's mark, the system's face (public/ds/avatar.css): their initials in their personal colour
 * (or neutral when unset), or the picture they drew once it has come (wakePictures). Hidden from a
 * screen reader: the row says the name in words.
 */
function markHtml(skin, size = 32) {
  const drawing = skin.picture ? pictureNow(skin.picture) : null;
  return faceHtml({
    name: skin.name,
    initials: skin.initials,
    drawing,
    picture: drawing ? null : skin.picture,
    size,
    me: skin.me,
    color: skin.color,
    className: "sp-mark",
    decorative: true,
  });
}

/** "Ada, Ben and Cleo". */
const listOf = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

// "One payment settles everyone.": small counts said as words.
const COUNT = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const countWord = (n) => COUNT[n] || String(n);

/**
 * The trip's short list of currencies, home first: the server's union (the seeded list, every
 * currency used on a purchase, every member's own) recomputed here on top of the snapshot, so a
 * purchase entered offline in a new currency widens the list at once.
 */
function enabledCurrencies(S) {
  const out = [];
  const push = (c) => {
    const v = String(c || "").trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(v) && !out.includes(v)) out.push(v);
  };
  for (const c of S.currencies() || []) push(c);              // server order, home first
  push(homeOf(S));
  for (const c of [...new Set(S.purchases().map((p) => p.currency))].sort()) push(c);
  for (const c of recentCurrencies()) push(c);                // chosen on this device
  if (!out.length) push("USD");                               // nothing anywhere: a sane floor
  return out;
}

/** Whether totals can be shown in a code: USD (the rates' base) or one the held rates have (src/api/fx.js). */
function hasRate(S, code) {
  if (code === "USD") return true;
  const fx = S.fx() || {};
  return !!(fx.rates && fx.rates[code]);
}

/** Your home currency as your account has it, or "" when it has none. */
function homeOf(S) {
  const me = S.me();
  const mine = me && me.id ? (S.members() || []).find((m) => m && m.id === me.id) : null;
  return (mine && mine.native_currency) || "";
}

/**
 * What totals are shown in: the one chosen on this device, else your own currency when the trip
 * uses it, else the trip's home currency.
 */
function displayCurrency(S, list) {
  const saved = readPref(here(PREF_DISPLAY));
  if (saved && (list.includes(saved) || hasRate(S, saved))) return saved;
  const mine = homeOf(S);
  if (mine && list.includes(mine)) return mine;
  return list[0] || "USD";
}

/**
 * What a purchase goes with, resolved for display: a plan, else a place, else a bare day. An id
 * this phone has not synced yields null rather than a broken name.
 */
function attachmentOf(S, row, tz) {
  if (row.event_id) {
    const e = S.event(row.event_id);
    if (e) {
      const place = e.place_id ? S.place(e.place_id) : null;
      const kind = (place && place.kind) || e.kind || "plan";
      return {
        kind: "event", name: e.title || "A plan", icon: getIcon(kind, place && place.subkind),
        vars: catVars(kind), sub: e.all_day ? "" : fmtTime(e.starts_at, e.tz || tz),
      };
    }
  }
  if (row.place_id) {
    const p = S.place(row.place_id);
    if (p) {
      return {
        kind: "place", name: p.name || "A place", icon: getIcon(p.kind, p.subkind),
        vars: catVars(p.kind), sub: "",
      };
    }
  }
  if (row.day) return { kind: "day", name: longDay(dayMs(row.day), tz), icon: SVG_CLOCK, vars: "", sub: "" };
  return null;
}

/**
 * "2026-08-30" -> epoch ms at NOON UTC on that date: midnight UTC is the previous day in every
 * zone west of Greenwich, and noon has twelve hours of slack both ways.
 */
function dayMs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
}

/** Noon of the day `key` (YYYY-MM-DD) in the zone `tz`, in epoch seconds. */
function noonOn(key, tz) {
  const [y, m, d] = key.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 12);
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const at = Object.fromEntries(f.formatToParts(guess).map((x) => [x.type, x.value]));
    const asThere = Date.UTC(+at.year, +at.month - 1, +at.day, +at.hour, +at.minute, +at.second);
    return Math.floor((guess - (asThere - guess)) / 1000);
  } catch {
    return Math.floor(guess / 1000);
  }
}

/** "Sat, Nov 14" in the trip's zone. */
const DAY_FMT = new Map();
function longDay(epoch, tz) {
  const ms_ = toMs(epoch);
  if (!Number.isFinite(ms_)) return "";
  let f = DAY_FMT.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }); }
    catch { return fmtDay(epoch, tz); }
    DAY_FMT.set(tz, f);
  }
  return f.format(ms_);
}

/** "Today", "Yesterday", then "Sat, Nov 14". */
function dayWords(epoch, tz) {
  const k = dayKey(epoch, tz);
  const now = Date.now();
  if (k === dayKey(now, tz)) return "Today";
  if (k === dayKey(now - 86400000, tz)) return "Yesterday";
  return longDay(epoch, tz);
}

/** The days a purchase is most often put on: today, yesterday, then the trip's own days, newest first. */
function dayChoices(trip, tz) {
  const now = Math.floor(Date.now() / 1000);
  const today = dayKey(now, tz);
  const yesterday = dayKey(now - 86400, tz);
  const out = [today, yesterday];
  const from = trip && trip.starts_on, to = trip && trip.ends_on;
  if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    for (let t = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)); ; t -= 86400000) {
      const k = new Date(t).toISOString().slice(0, 10);
      if (k < from) break;
      if (k <= today && !out.includes(k)) out.push(k);
      if (out.length > 16) break;
    }
  }
  return { today, yesterday, days: out };
}

/** A day key in words: "Today", "Yesterday", "Sat, Nov 14". */
function dayKeyWords(k, tz, today, yesterday) {
  return k === today ? "Today" : k === yesterday ? "Yesterday" : longDay(noonOn(k, tz), tz);
}

/** An amount as the headline sets it: its decimals in a quieter ink ("€1,240" then ".50"). */
function heroNum(minor, exp, code, approx = false) {
  const t = fmtMoney(minor, exp, code, { approx });
  const i = exp > 0 ? t.lastIndexOf(".") : -1;
  return i > 0 ? `${esc(t.slice(0, i))}<span class="sp-dec">${esc(t.slice(i))}</span>` : esc(t);
}

// ────────────────────────────────────────────────────────────────────────────────────────
// the change hash: a projection of exactly the columns this screen draws, in a fixed order,
// so a refresh that changed nothing anybody can see costs one hash and no DOM
// ────────────────────────────────────────────────────────────────────────────────────────
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return `${str.length}.${(h >>> 0).toString(36)}`;
}
const PU_K = ["id", "description", "amount_minor", "currency", "amount_exp", "paid_by",
              "split_mode", "spent_at", "day", "event_id", "place_id", "created_by",
              "created_at", "kind"];
const MB_K = ["id", "name", "note_color", "initials", "avatar", "native_currency", "left_at", "deleted"];
const TR_K = ["id", "default_tz"];
const EV_K = ["id", "title", "kind", "starts_at", "tz", "all_day", "place_id"];
const PL_K = ["id", "name", "kind", "subkind"];
function pick(o, keys) {
  let out = "";
  for (const k of keys) out += "" + (o && o[k] != null ? String(o[k]) : "");
  return out;
}
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function dataSlice(S, display) {
  // The display currency is in the hash: it changes every converted number without changing a row.
  // So is the day: "Today" becomes "Yesterday" at midnight.
  const trip = S.trip();
  let acc = `${display}|${pick(trip, TR_K)}|${dayKey(Date.now(), (trip && trip.default_tz) || "UTC")}|`;
  const me = S.me();
  acc += `${(me && me.id) || ""}|${S.lastSync() ? 1 : 0}|`;
  for (const m of (S.members() || []).slice().sort(byId)) acc += pick(m, MB_K);
  acc += "|";
  const seenE = new Map();
  const seenP = new Map();
  for (const p of S.purchases()) {
    acc += pick(p, PU_K);
    const rc = receipts.receiptOf(p);
    acc += rc ? `rc:${rc.state}:${rc.state === "stored" ? rc.url : ""}` : "";
    for (const s of p.shares || []) acc += `${s.user_id}:${s.weight}:${s.share_minor}`;
    if (p.event_id && !seenE.has(p.event_id)) seenE.set(p.event_id, S.event(p.event_id));
    if (p.place_id && !seenP.has(p.place_id)) seenP.set(p.place_id, S.place(p.place_id));
  }
  acc += "|";
  for (const k of [...seenE.keys()].sort()) acc += pick(seenE.get(k), EV_K);
  for (const k of [...seenP.keys()].sort()) acc += pick(seenP.get(k), PL_K);
  acc += "|";
  acc += (S.currencies() || []).join(",");
  const fx = S.fx() || {};
  acc += `|${fx.fetched_at || 0}|${JSON.stringify(fx.rates || {})}`;
  return fnv(acc);
}

// How long to leave a rates attempt alone after one has just been made.
const RATE_TRY_MS = 60000;
let lastRateTry = 0;

// The width from which Settle up's content stands beside the feed instead of in a sheet.
const WIDE = "(min-width: 1180px)";

// ════════════════════════════════════════════════════════════════════════════════════════
// mount
// ════════════════════════════════════════════════════════════════════════════════════════

export default function mount(el, ctx) {
  ensureStyles();

  const S = ctx.store;
  const router = ctx.router;

  let dead = false;                    // set by unmount; guards every async tail
  let raf = 0;
  let needRender = false;
  let slice = "";

  // The head and the side are rewritten whole; the feed is created once, because flip() measures
  // it before and after a change and needs the same node both times.
  const root = document.createElement("section");
  root.className = "sp ds";
  const headEl = document.createElement("div");
  headEl.className = "sp-headbox";
  const sideEl = document.createElement("div");
  sideEl.className = "sp-side";
  const heroEl = document.createElement("div");
  heroEl.className = "sp-hero";
  heroEl.dataset.sp = "headline";
  const wideEl = document.createElement("div");
  wideEl.className = "sp-wide";
  sideEl.append(heroEl, wideEl);
  const feedEl = document.createElement("div");
  feedEl.className = "sp-feed";
  root.append(headEl, sideEl, feedEl);
  el.append(root);

  const wideMq = window.matchMedia(WIDE);
  const onWide = () => scheduleRender();
  wideMq.addEventListener("change", onWide);

  /**
   * Every store write goes through here. store.js throws SYNCHRONOUSLY from its local validation
   * (an impossible write must never reach the queue), so the catch is that refusal, in words.
   */
  async function guard(what, fn) {
    try { return await fn(); }
    catch (e) {
      const msg = (e && e.message) ? String(e.message) : "";
      toast(msg ? msg.charAt(0).toUpperCase() + msg.slice(1) : `Couldn't ${what}.`);
      return null;
    }
  }

  // ── the + ────────────────────────────────────────────────────────────────────────────
  // In the router's fixed layer, not inside `el`: #view is a transformed containing block for
  // the length of a page transition. Removed explicitly in unmount. From 768 the head's named
  // add takes its place (styles.css).
  const fabLayer = router.fixedLayer();
  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "fab ds ds-fab sp-fab";
  fab.dataset.act = "add";
  fab.setAttribute("aria-label", "Add a purchase");
  fab.innerHTML = SVG_PLUS;
  fab.addEventListener("click", () => openDrawer(null));
  fabLayer.append(fab);

  // ── state that is not data ───────────────────────────────────────────────────────────
  let sheet = null;        // the open sheet: { api, kind, ... }
  let picker = null;       // a sheet stacked on top of it (what it goes with, another currency)
  let settleMode = "";     // "" until first drawn; then "converted" | "currency"
  const openBal = new Set();   // the balances opened to their why, kept across repaints

  // ══════════════════════════════════════════════════════════════════════════════════════
  // render
  // ══════════════════════════════════════════════════════════════════════════════════════

  function scheduleRender() {
    if (dead) return;
    needRender = true;
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (!dead && needRender) { needRender = false; render(); } });
  }

  /** Everything the screen and Settle up read, computed once per paint. */
  function model() {
    const list = enabledCurrencies(S);
    const display = displayCurrency(S, list);
    const exp = expOf(display);
    const me = S.me();
    const trip = S.trip();
    const tz = (trip && trip.default_tz) || "UTC";
    const members = S.members() || [];
    const rows = S.purchases();
    const fx = S.fx() || { rates: {}, fetched_at: 0 };
    const led = netBalances(rows, members.map((m) => m.id), { to: display, toExp: exp, rates: fx.rates || {} });
    // A converted figure keeps its "≈": any counted purchase in another currency makes every
    // total an approximation.
    const approx = rows.some((r) => r.currency !== display && !led.unconverted.includes(r.id));
    const plan = settleUp(led.net);
    return { list, display, exp, me, trip, tz, members, rows, fx, led, approx, plan };
  }

  function render() {
    if (dead) return;
    const m = model();
    slice = dataSlice(S, m.display);

    // The system's head: the name, then what belongs to this screen at its end (the currency the totals are shown
    // in, and from 768 the named add; a phone keeps the floating +). Your picture is the shell's own, at the shell's
    // place as on every tab (fixed at the top right, the head keeping its room: styles.css), so this end is Split's
    // own (.sp-head-end), never .ds-head-end, which would move the picture into this head on a phone.
    headEl.innerHTML =
      `<div class="sp-head ds-head">` +
        `<h1 class="sp-h1">Split</h1>` +
        `<div class="sp-head-end">` +
          displaySelectHtml(m) +
          `<button type="button" class="head-add ds-button ds-button--white" data-act="add"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Add a purchase</button>` +
        `</div>` +
      `</div>`;

    if (!m.rows.length) {
      root.dataset.empty = "1";
      heroEl.innerHTML = emptyHeroHtml(m.me);
      wideEl.innerHTML = "";
      feedEl.innerHTML = coldFeedHtml(m.me);
      return;
    }
    delete root.dataset.empty;
    // When any figure is converted (its "≈"), the rates' day under it, as Settle up says it.
    heroEl.innerHTML = heroHtml(m) + (m.approx && m.led.unconverted.length < m.rows.length
      ? `<p class="sp-fine sp-rates" data-sp="rates-day">${m.fx.fetched_at ? `Rates from ${esc(fmtAgo(m.fx.fetched_at))}` : "No exchange rates yet"}</p>` : "");
    wideEl.innerHTML = wideMq.matches ? settleHtml(m, { where: "side" }) : "";
    feedEl.innerHTML = feedHtml(m);
    wakePictures(root);
  }

  /**
   * The currency totals are shown in, as a native menu: only when purchases are in more than one
   * currency, or in one that isn't the one shown. The same control heads Settle up.
   */
  function displaySelectHtml(m, where = "head") {
    const used = new Set(m.rows.map((r) => r.currency));
    used.add(m.display);
    if (used.size < 2) return "";
    const codes = m.list.includes(m.display) ? m.list : [...m.list, m.display];
    const opts = codes.map((c) =>
      `<option value="${esc(c)}"${c === m.display ? " selected" : ""}>${esc(c)}</option>`).join("") +
      `<option value="">Other currency…</option>`;
    // "Totals in" said on the control itself: a bare "PEN ▾" here read as the currency a purchase is paid in, which is
    // the other menu (Add a purchase).
    return `<label class="sp-cur" data-sp="display-${where}"><span class="sp-cur-k" aria-hidden="true">Totals in</span>` +
      `<span class="sp-cur-pick"><span class="sp-cur-v" aria-hidden="true">${esc(m.display)}</span>` +
      `<select data-act="display" aria-label="Totals shown in">${opts}</select>${SVG_CHEV_D}</span></label>`;
  }

  /** No purchases yet: the screen's whole job, said once, with the one action. */
  function emptyHeroHtml(me) {
    if (!me.id) {
      return `<p class="sp-hero-title">Waiting for your account</p>` +
        `<p class="sp-hero-sub">Purchases will appear once you're signed in.</p>`;
    }
    if (!S.lastSync()) return "";
    return `<p class="sp-hero-title" data-state="empty">Nothing to split yet</p>` +
      `<p class="sp-hero-sub">Add what someone paid and who was in on it. Split keeps the tally.</p>` +
      `<div class="sp-hero-acts"><button type="button" class="ds-button ds-button--white ds-button--lg" data-act="add" data-sp="empty-add">Add a purchase</button></div>`;
  }

  /** Never synced and nothing cached: three skeleton rows at the row's shape, never a spinner. */
  function coldFeedHtml(me) {
    if (!me.id || S.lastSync()) return "";
    let out = "";
    for (let i = 0; i < 3; i++) {
      out += `<div class="sp-skel-row" aria-hidden="true">` +
        `<div class="skeleton sp-skel-sq"></div>` +
        `<div class="grow"><div class="skeleton sp-skel-l1"></div>` +
        `<div class="skeleton sp-skel-l2"></div></div>` +
        `<div class="skeleton sp-skel-amt"></div></div>`;
    }
    return out;
  }

  /**
   * THE HEADLINE: the answer, from the same fewest-payments plan Settle up shows, so the two never
   * disagree. Six states (and two more the rates make):
   *   you pay one person     "You owe Ada Reyes"      the amount      Mark paid
   *   you pay several        "You owe"                the total       a line each, Mark paid
   *   one person pays you    "Ben Okafor owes you"    the amount      Mark paid
   *   several pay you        "You're owed"            the total       a line each, Mark paid
   *   nothing to pay         "You're settled up"      (none)          what was spent, your share
   *   no purchases           "Nothing to split yet"   (emptyHeroHtml)
   *   no rate for anything   "Totals need exchange rates"; some purchases without one: a line
   *   saying how many aren't counted, under the number.
   */
  function heroState(m) {
    if (m.led.unconverted.length === m.rows.length) return { state: "norate" };
    const meId = m.me.id;
    const pay = m.plan.filter((t) => t.from === meId);
    const get = m.plan.filter((t) => t.to === meId);
    if (pay.length === 1) return { state: "owe-one", lines: pay };
    if (pay.length > 1) return { state: "owe-many", lines: pay };
    if (get.length === 1) return { state: "owed-one", lines: get };
    if (get.length > 1) return { state: "owed-many", lines: get };
    return { state: "settled", lines: [] };
  }

  function heroHtml(m) {
    const h = heroState(m);
    const meId = m.me.id;
    const balances = `<button type="button" class="sp-quiet sp-settle" data-act="settle" data-sp="balances">Everyone's balances${SVG_CHEV_R}</button>`;
    let caveat = "";
    if (m.led.unconverted.length && h.state !== "norate") {
      const n = m.led.unconverted.length;
      caveat = `<p class="sp-hero-warn" data-sp="headline-caveat">${SVG_ALERT}<span>Not counting ${n} ` +
        `${n === 1 ? "purchase that needs" : "purchases that need"} an exchange rate</span></p>`;
    }
    if (h.state === "norate") {
      return `<p class="sp-hero-title" data-state="norate">Totals need exchange rates</p>` +
        `<p class="sp-hero-sub">Settle up shows each currency on its own until then.</p>` +
        `<div class="sp-hero-acts">${balances}</div>`;
    }
    if (h.state === "settled") {
      const spent = fmtMoney(m.led.total, m.exp, m.display, { approx: m.approx });
      const mine = fmtMoney(m.led.owed.get(meId) || 0, m.exp, m.display, { approx: m.approx });
      return `<p class="sp-hero-title" data-state="settled">You're settled up</p>` +
        `<p class="sp-hero-sub"><span class="num">${esc(spent)}</span> spent together. Your share is <span class="num">${esc(mine)}</span>.</p>` +
        caveat + `<div class="sp-hero-acts">${balances}</div>`;
    }
    const markData = (t) => ` data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-amount="${t.amount_minor}" data-cur="${esc(m.display)}"`;
    const other = (t) => skinOf(m.members, t.from === meId ? t.to : t.from, meId);
    const total = h.lines.reduce((a, t) => a + t.amount_minor, 0);
    // The name is the answer: it carries the weight and the first ink; the verb around it stays quiet.
    let words;
    if (h.state === "owe-one") { const w = other(h.lines[0]); words = `You owe ${pdot(w, meId)}<b>${esc(w.name)}</b>`; }
    else if (h.state === "owed-one") { const w = other(h.lines[0]); words = `${pdot(w, meId)}<b>${esc(w.name)}</b> owes you`; }
    else if (h.state === "owe-many") words = "You owe";
    else words = "You're owed";
    let out = `<p class="sp-hero-words" data-state="${h.state}" data-sp="headline-words">${words}</p>` +
      `<p class="sp-hero-num" data-sp="headline-amount" data-minor="${total}" data-exp="${m.exp}" data-code="${esc(m.display)}"` +
        `${m.approx ? " data-approx" : ""}>${heroNum(total, m.exp, m.display, m.approx)}</p>` + caveat;
    if (h.lines.length === 1) {
      out += `<div class="sp-hero-acts">` +
        `<button type="button" class="ds-button ds-button--gray" data-act="mark-paid" data-sp="headline-mark-paid"${markData(h.lines[0])}>Mark paid</button>` +
        balances + `</div>`;
      return out;
    }
    out += `<ul class="sp-hero-list">` + h.lines.map((t) => {
      const who = other(t);
      return `<li>${markHtml(who, 24)}<span class="sp-name">${esc(who.name)}</span>` +
        `<span class="num">${esc(fmtMoney(t.amount_minor, m.exp, m.display, { approx: m.approx }))}</span>` +
        `<button type="button" class="ds-button ds-button--gray" data-act="mark-paid" data-sp="headline-mark-paid"${markData(t)}` +
        ` aria-label="Mark paid: ${esc(paysWords(skinOf(m.members, t.from, meId), skinOf(m.members, t.to, meId), meId))}">Mark paid</button></li>`;
    }).join("") + `</ul>`;
    return out + `<div class="sp-hero-acts">${balances}</div>`;
  }

  /**
   * The feed: newest first (the store's order: spent_at, then created_at, then id), under day
   * headers grouped by the same spent_at, so a heading never appears twice.
   */
  function feedHtml(m) {
    let out = "";
    let day = "";
    const o = { members: m.members, tz: m.tz, display: m.display, exp: m.exp, fx: m.fx, meId: m.me.id };
    for (const p of m.rows) {
      const k = dayKey(toMs(p.spent_at), m.tz);
      if (k !== day) {
        day = k;
        out += `<h2 class="sp-day">${esc(dayWords(toMs(p.spent_at), m.tz))}</h2>`;
      }
      out += rowHtml(p, o);
    }
    return out;
  }

  /** A purchase's amount in the currency shown: "≈ €82.10", or null when no rate is held. */
  function shownAmount(p, o) {
    if (p.currency === o.display) return { text: fmtMoney(p.amount_minor, p.amount_exp, p.currency), converted: false };
    const c = convert(p.amount_minor, p.amount_exp, p.currency, o.exp, o.display, o.fx.rates || {});
    if (c === null) return { text: fmtMoney(p.amount_minor, p.amount_exp, p.currency), converted: false, norate: true };
    return { text: fmtMoney(c, o.exp, o.display, { approx: true }), converted: true };
  }

  /**
   * Your share of one purchase, as money.js has it: netBalances() over that purchase alone, in the
   * currency shown (the same conversion and allocation the headline adds up), or in the
   * purchase's own currency when no rate is held. null when you aren't in it.
   */
  function myShare(p, o) {
    if (!(p.shares || []).some((s) => s.user_id === o.meId)) return null;
    const conv = p.currency !== o.display;
    const led = netBalances([p], [o.meId], { to: o.display, toExp: o.exp, rates: o.fx.rates || {} });
    if (led.unconverted.length) {
      const own = netBalances([p], [o.meId], { to: p.currency, toExp: p.amount_exp, rates: {} });
      return fmtMoney(own.owed.get(o.meId) || 0, p.amount_exp, p.currency);
    }
    return fmtMoney(led.owed.get(o.meId) || 0, o.exp, o.display, { approx: conv });
  }

  /** Who a payment went to: its one share. */
  const receiverOf = (p) => ((p.shares || [])[0] || {}).user_id || "";

  /** A payment: the payer's mark, "You paid Ada Reyes" and the amount, then "Payment". */
  function paymentRowHtml(p, o) {
    const from = skinOf(o.members, p.paid_by, o.meId);
    const to = skinOf(o.members, receiverOf(p), o.meId);
    const amt = shownAmount(p, o);
    const words = paidWords(from, to, o.meId);
    return `<button type="button" class="sp-row" data-kind="payment" data-sp="row" data-key="pu:${esc(p.id)}" data-id="${esc(p.id)}">` +
      markHtml(from) +
      `<span class="sp-l1"><span class="sp-what">${esc(clip(words, 64))}</span>` +
      `<span class="sp-total">${esc(amt.text)}</span></span>` +
      `<span class="sp-l2"><span class="sp-by">${amt.converted ? `Payment of ${esc(fmtMoney(p.amount_minor, p.amount_exp, p.currency))}` : "Payment"}</span></span>` +
      `</button>`;
  }

  /**
   * A purchase: the payer's mark; what it was and its total; who paid and your share. You paid:
   * "You paid". You aren't in it: "not yours". Unequal: "your share €45.00, unequal". Converted:
   * "≈ €82.10" on the right and the original on the left ("Ada paid $90.00"). A receipt waiting
   * or refused says so in the left column, with the receipt glyph.
   */
  function rowHtml(p, o) {
    if (isPayment(p)) return paymentRowHtml(p, o);
    const payer = skinOf(o.members, p.paid_by, o.meId);
    const att = attachmentOf(S, p, o.tz);
    let what = String(p.description || "").trim();
    let fallback = "0";
    if (!what && att) { what = att.name; fallback = "1"; }
    if (!what) { what = `Purchase at ${fmtTime(toMs(p.spent_at), o.tz)}`; fallback = "1"; }
    const amt = shownAmount(p, o);
    const by = `${payer.id === o.meId ? "You" : payer.first} paid` +
      (amt.converted ? ` ${fmtMoney(p.amount_minor, p.amount_exp, p.currency)}` : "");
    const share = myShare(p, o);
    // The words in the reading face, the amount in the mono one (the same text either way).
    const mine = share === null ? "not yours" : `your share <span class="num">${esc(share)}</span>${isEqualSplit(p) ? "" : ", unequal"}`;
    return `<button type="button" class="sp-row" data-sp="row" data-key="pu:${esc(p.id)}" data-id="${esc(p.id)}">` +
      markHtml(payer) +
      `<span class="sp-l1"><span class="sp-what" data-fallback="${fallback}">${esc(clip(what, 64))}</span>` +
      `<span class="sp-total">${esc(amt.text)}</span></span>` +
      `<span class="sp-l2"><span class="sp-by"><span>${esc(by)}</span>${receiptMarkHtml(p)}</span>` +
      `<span class="sp-mine">${mine}</span></span>` +
      `</button>`;
  }

  /**
   * The row's receipt mark: the glyph, and words when there is something to know (it waits on
   * this phone, or the server said no). A stored one is the glyph alone, named for a screen reader.
   */
  function receiptMarkHtml(p) {
    const rc = receipts.receiptOf(p);
    if (!rc || rc.state === "removing") return "";
    const words = rc.state === "waiting" ? "receipt waiting" : rc.state === "refused" ? "receipt not sent" : "";
    return `<span class="sp-rc" data-state="${rc.state}"` +
      (words ? "" : ` role="img" aria-label="Has its receipt"`) + `>${SVG_RECEIPT}` +
      (words ? `<span>${words}</span>` : "") + `</span>`;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════
  // the sheet wrapper
  // ══════════════════════════════════════════════════════════════════════════════════════
  // One place where dragFrom, closeButton and the teardown identity check are decided. `slot` is
  // which of the two sheet variables this one owns: the pickers stack ON TOP of a sheet and are
  // "picker", so closing one does not null out the other.
  function openPanel({ slot = "sheet", title, kind, body, foot, dragFrom = "handle",
                       closeButton = false, maxFraction = 0, onReady, onOpen, onClose }) {
    const form = document.createElement("form");
    // .ds: inside a sheet the shared frame sets the app's own inks back for screens not yet moved (styles.css .sh-body);
    // Split has moved, so its sheet reads the system's inks, the same as its feed (one gray for a number's dimmed part).
    form.className = "sp-form ds";
    form.tabIndex = -1;
    form.innerHTML = body;
    // Never let a stray Enter submit and reload the page; every action here is a button.
    form.addEventListener("submit", (ev) => ev.preventDefault());

    let footEl = null;
    if (foot) {
      footEl = document.createElement("div");
      footEl.className = "ds";
      footEl.innerHTML = foot;
    }

    // `let`, so the identity check below compares the panel that opened with the current one.
    let panelRef = null;

    const api = openBottomSheet({
      title, contentEl: form, footEl, closeButton, dragFrom, maxFraction,
      onOpen: () => {
        if (dead || !panelRef) return;
        const cur = slot === "picker" ? picker : sheet;
        if (cur !== panelRef) return;         // superseded while it was sliding
        if (onOpen) onOpen(panelRef);
      },
      // sheet.js calls this exactly once for EVERY dismissal, so it is the only teardown path.
      onClose: () => {
        const cur = slot === "picker" ? picker : sheet;
        // Only if this is still the CURRENT panel in that slot: an exit and the next panel's open
        // overlap by a frame or two.
        if (cur && cur.api === api) {
          clearTimeout(cur.armTimer);
          if (slot === "picker") picker = null; else sheet = null;
        }
        if (dead) return;
        if (onClose) onClose();
        scheduleRender();
      },
    });

    const panel = { api, kind, form, wrap: api.el, armed: null, armTimer: null, note: null };
    panelRef = panel;
    if (slot === "picker") picker = panel; else sheet = panel;
    if (onReady) onReady(panel);
    return panel;
  }

  function closePanel(slot) {
    const cur = slot === "picker" ? picker : sheet;
    if (!cur) return;
    clearArmNote(cur);
    clearTimeout(cur.armTimer);
    cur.api.close();                     // teardown, and the null, happen in onClose
  }

  // Two taps, never confirm(). The label CHANGES to say what the second tap does, with the
  // consequence spelled out above it.
  function arm(panel, btn, label, note, run) {
    if (!panel) return;
    if (panel.armed !== btn) {
      clearTimeout(panel.armTimer);
      if (panel.armed) disarm(panel, panel.armed);
      panel.armed = btn;
      btn.classList.add("sp-armed");
      btn.dataset.was = btn.textContent;
      btn.textContent = label;
      armNote(panel, btn, note);
      panel.armTimer = setTimeout(() => {
        if (!panel.armed || panel.armed !== btn) return;
        panel.armed = null;
        disarm(panel, btn);
      }, 4000);
      return;
    }
    panel.armed = null;
    clearTimeout(panel.armTimer);
    disarm(panel, btn);
    run();
  }
  function disarm(panel, btn) {
    if (btn.dataset.was) btn.textContent = btn.dataset.was;
    btn.classList.remove("sp-armed");
    clearArmNote(panel);
  }
  function armNote(panel, btn, text) {
    clearArmNote(panel);
    const bar = btn.closest(".sp-foot");
    if (!bar) return;
    const n = document.createElement("p");
    n.className = "sp-armnote";
    // role=status: heard without taking focus off the button that has to be tapped again.
    n.setAttribute("role", "status");
    n.textContent = text;
    bar.insertBefore(n, btn);
    panel.note = n;
    // The sentence pushes the button down; the sheet's own scrollport takes up the slack so the
    // button stays where the thumb left it.
    const body = btn.closest(".sh-body");
    if (body) body.scrollTop += n.offsetHeight + 4;
  }
  function clearArmNote(panel) {
    if (panel && panel.note) { panel.note.remove(); panel.note = null; }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════
  // the add sheet — add and edit are ONE form; a payment is the same form with From and To
  // ══════════════════════════════════════════════════════════════════════════════════════
  // Equal is the default a purchase is born with, not a mode it is locked into, and the unequal
  // split after the fact is a primary path: the row, Split, the amounts, Save changes.

  /**
   * The sheet's working state. It is NOT the row: nothing is written until the button, and a
   * dismiss discards. `id` is minted here for a new purchase because allocate() is seeded with it:
   * the shares shown are only the ones the store will resolve if both see the same id.
   */
  function drawerState(row, members, me, list, seed = null) {
    const tz = (S.trip() && S.trip().default_tz) || "UTC";
    const todayKey = dayKey(Math.floor(Date.now() / 1000), tz);
    if (row) {
      const shares = (row.shares || []).slice();
      const unequal = !isEqualSplit(row);
      const when = dayKey(row.spent_at, tz);
      return {
        kind: isPayment(row) ? "payment" : "purchase",
        mode: "edit",
        id: row.id,
        currency: row.currency,
        exp: row.amount_exp,
        amountText: toAmountText(row.amount_minor, row.amount_exp),
        description: row.description || "",
        note: row.note || "",
        paid_by: row.paid_by,
        split: shares.map((s) => s.user_id),
        day: row.day || "",
        event_id: row.event_id || null,
        place_id: row.place_id || null,
        spent_at: row.spent_at,
        when, whenWas: when,
        open: "",
        curOpen: false,
        // By amount: the per-person amounts, in minor units, are what is stored.
        byAmount: unequal,
        exact: new Map(shares.map((s) => [s.user_id, s.share_minor])),
        touched: unequal,
      };
    }
    const cur = (() => {
      if (seed && seed.currency) return seed.currency;
      const [last] = recentCurrencies();
      if (last && list.includes(last)) return last;
      return list[0] || "USD";
    })();
    const base = {
      mode: "add", id: uid("pu"), currency: cur, exp: expOf(cur), description: "", note: "",
      day: "", event_id: null, place_id: null, spent_at: null,
      when: todayKey, whenWas: todayKey, open: "", curOpen: false,
      byAmount: false, exact: new Map(), touched: false,
    };
    if (seed && seed.payment) {
      // A payment: from one person (you, unless the plan says who) to ONE other. `split` holds
      // that one receiver, the shape a payment's row has.
      return {
        ...base, kind: "payment",
        amountText: seed.amount_minor ? toAmountText(seed.amount_minor, base.exp) : "",
        paid_by: seed.from || me.id,
        split: seed.to ? [seed.to] : [],
        title: seed.title || "",
      };
    }
    return {
      ...base, kind: "purchase", amountText: "",
      paid_by: me.id,                                  // you
      split: stillOn(members).map((m) => m.id),        // everyone still on the trip
    };
  }

  // `seed` is for a payment: { payment: true, from, to, amount_minor, currency, title } opens it
  // filled in (a line of the plan: "Mark paid"), or empty but for "from: you" ("Record a
  // payment"). With `back: "settle"` the Settle up sheet comes back when this one closes.
  function openDrawer(id, seed = null) {
    const members = S.members() || [];
    const me = S.me();
    const row = id ? S.purchase(id) : null;
    if (id && !row) { toast("That purchase isn't on this phone."); return; }
    if (!me.id) { toast("Sign in first. A purchase needs someone to add it."); return; }
    const pay = row ? isPayment(row) : !!(seed && seed.payment);
    const back = seed && seed.back === "settle";
    if (pay && !row && members.length < 2) { toast("A payment needs two people on the trip."); return; }
    if (!row && !members.length) { toast("The trip's people haven't synced yet."); return; }

    const list = enabledCurrencies(S);
    const D = drawerState(row, members, me, list, seed);
    const readOnly = !!row && !S.canEditPurchase(row);
    const action = pay
      ? (row ? "Save changes" : D.title === "Mark paid" ? "Mark paid" : "Record payment")
      : (row ? "Save changes" : "Add purchase");

    const panel = openPanel({
      slot: "sheet",
      kind: "drawer",
      // Someone else's, read: its own name is the title (what it was, or who paid whom).
      title: readOnly ? readTitle(row, members, me)
        : pay ? (row ? "Payment" : (D.title || "Record a payment"))
        : row ? "Edit purchase" : "Add a purchase",
      body: readOnly ? readBody(row, members, me) : formBody(D, members, me, row, action),
      // The currency, in the sheet's title row beside "Add a purchase" (sheet.js puts footEl there), so the amount
      // keeps the whole width at the one number size: CHF 1,234.56 fits a 320 phone.
      foot: readOnly ? undefined : CURRENCY_HEAD,
      dragFrom: "handle",
      // A read view is read and let go: its × is the way out. A form closes by a drag or the scrim.
      closeButton: readOnly,
      onReady: (p) => {
        p.D = D;
        p.row = row;
        p.readOnly = readOnly;
        if (readOnly) {
          p.wrap.addEventListener("click", (ev) => {
            if (ev.target.closest('[data-act="chat"]')) { ev.preventDefault(); chatAboutPurchase(row.id); return; }
            const b = ev.target.closest('[data-act="rcpt-view"]');
            if (b) { ev.preventDefault(); openReceipt(receipts.receiptOf(row)); }
          });
          return;
        }
        p.saveBtn = p.wrap.querySelector('[data-act="save"]');
        p.D0 = drawerSig(D);                              // what "a change not saved" is measured from
        wireDrawer(p);
        syncDrawer(p);
      },
      onClose: () => {
        // A picture chosen and not saved goes with the sheet.
        if (D.receiptNew) { URL.revokeObjectURL(D.receiptNew.url); D.receiptNew = null; }
        if (back) openSettle();
      },
    });
    // THE KEYPAD UP AT ONCE, for a new purchase or payment: the amount is focused in the same tap
    // that opened the sheet (a phone raises its keyboard only inside the gesture), and sheet.js's
    // focusin takes the sheet to its full height before its first frame, in one move.
    if (panel && !row && !readOnly) {
      const a = panel.wrap.querySelector(".sp-amtin");
      if (a && !(seed && seed.amount_minor)) a.focus({ preventScroll: true });
    }
    return panel;
  }

  /** A read view's title: what the purchase was, or who paid whom. */
  function readTitle(row, members, me) {
    if (isPayment(row)) return paidWords(skinOf(members, row.paid_by, me.id), skinOf(members, receiverOf(row), me.id), me.id);
    const att = attachmentOf(S, row, (S.trip() && S.trip().default_tz) || "UTC");
    return row.description || (att && att.name) || "A purchase";
  }

  /**
   * Somebody else's purchase, opened: read, not a form. Its name, its amount, who paid and when;
   * under a hairline who's in and their shares; the receipt; what it goes with; Chat about this.
   */
  function readBody(row, members, me) {
    const trip = S.trip();
    const tz = (trip && trip.default_tz) || "UTC";
    const list = enabledCurrencies(S);
    const display = displayCurrency(S, list);
    const o = { display, exp: expOf(display), fx: S.fx() || { rates: {} }, meId: me.id };
    const amt = shownAmount(row, o);
    const own = fmtMoney(row.amount_minor, row.amount_exp, row.currency);
    const when = longDay(toMs(row.spent_at), tz);
    let out = `<div class="sp-read">`;
    if (isPayment(row)) {
      const from = skinOf(members, row.paid_by, me.id);
      const to = skinOf(members, receiverOf(row), me.id);
      out += `<p class="sp-read-amt">${heroNum(row.amount_minor, row.amount_exp, row.currency)}</p>`;
      if (amt.converted) out += `<p class="sp-read-conv num">${esc(amt.text)}</p>`;
      out += `<p class="sp-read-meta">Payment on ${esc(when)}</p>`;
      const may = [from.name, to.name];
      // Written down by someone who is neither side: said, since they may change it too.
      if (row.created_by !== row.paid_by && row.created_by !== receiverOf(row)) {
        const by = skinOf(members, row.created_by, me.id);
        out += `<p class="sp-read-meta">Written down by ${esc(by.name)}</p>`;
        may.push(by.name);
      }
      out += `<p class="sp-read-who">Only ${esc(listOf(may))} can change it.</p>`;
      return out + `</div>`;
    }
    const att = attachmentOf(S, row, tz);
    const what = row.description || (att && att.name) || "A purchase";
    const payer = skinOf(members, row.paid_by, me.id);
    out += `<p class="sp-read-amt">${heroNum(row.amount_minor, row.amount_exp, row.currency)}</p>`;
    if (amt.converted) out += `<p class="sp-read-conv num">${esc(amt.text)}</p>`;
    out += `<p class="sp-read-meta">${esc(payer.id === me.id ? "You" : payer.name)} paid on ${esc(when)}</p>`;
    const shares = (row.shares || []).slice();
    out += `<ul class="sp-read-shares">` +
      `<li class="sp-read-how">${isEqualSplit(row) ? `Split evenly${shares.length > 1 ? `, ${shares.length} ways` : ""}` : "Split by amount"}</li>` +
      peopleOrder(members).filter((m) => shares.some((s) => s.user_id === m.id))
        .concat(shares.filter((s) => !members.some((m) => m.id === s.user_id)).map((s) => ({ id: s.user_id })))
        .map((m) => {
          const s = shares.find((x) => x.user_id === m.id);
          const skin = skinOf(members, m.id, me.id);
          return `<li><span>${esc(skin.label)}</span><span class="num">${esc(fmtMoney(s.share_minor, row.amount_exp, row.currency))}</span></li>`;
        }).join("") +
      `</ul>`;
    const rc = receipts.receiptOf(row);
    if (rc && rc.state === "stored") {
      out += `<div class="sp-rcpt">` +
        `<button type="button" class="sp-rcpt-thumb" data-act="rcpt-view" aria-label="Open the receipt"><img alt="" src="${esc(rc.url)}"></button>` +
        `<span class="sp-rcpt-side"><span class="sp-rcpt-state">Receipt. Tap it to open it.</span></span>` +
      `</div>`;
    }
    if (att && att.name !== what) {
      out += `<p class="sp-read-att"${att.vars ? ` style="${esc(att.vars)}"` : ""}>${att.icon}<span>For ${esc(att.name)}</span></p>`;
    }
    if (row.note) out += `<p class="sp-read-note">${esc(row.note)}</p>`;
    out += chatHtml(row);
    // Who may change it: who added it or who paid it (store.js canEditPurchase()).
    const author = skinOf(members, row.created_by, me.id);
    const may = row.created_by === row.paid_by ? [author.name] : [author.name, payer.name];
    out += `<p class="sp-read-who">Only ${esc(listOf(may))} can change it.</p>`;
    return out + `</div>`;
  }

  /** "Chat about this" for a purchase on the trip (a payment isn't one to talk about). */
  const chatHtml = (row) => (row && !isPayment(row)
    ? `<div class="sp-chatrow"><button type="button" class="sp-quiet sp-chat" data-act="chat" data-sp="chat">${SVG_CHAT}<span>Chat about this</span></button></div>` : "");
  /** Opens the trip's chat with this purchase held above its box: the next message is about it. */
  function chatAboutPurchase(id) {
    closePanel("sheet");
    import("./chat.js").then(({ chatAbout }) => chatAbout("purchase", id)).catch((e) => {
      console.warn("[split] chat not loaded", e);
      toast("The chat couldn't open. Try again.");
    });
  }

  /** What the person can change in a sheet, as one string: equal when nothing was changed. */
  const drawerSig = (D) => JSON.stringify([D.currency, D.amountText, D.description, D.note, D.paid_by, [...(D.split || [])].sort(),
    D.day, D.event_id, D.place_id, D.when, D.byAmount ? [...(D.exact || new Map())].sort((a, b) => (a[0] < b[0] ? -1 : 1)) : null]);

  /** A row that says its answer and opens its choices under itself. */
  function optHtml(key, label, act) {
    return `<button type="button" class="sp-opt" data-act="${act}" data-sp="row-${key}" aria-expanded="false" aria-controls="sp-pane-${key}">` +
      `<span class="sp-opt-k">${label}</span><span class="sp-opt-v" data-slot="ans-${key}"></span>${SVG_CHEV_R}</button>`;
  }

  const CURRENCY_HEAD = `<button type="button" class="sp-curbtn" data-act="cur" data-sp="currency" aria-expanded="false"></button>`;

  /** The form: the amount, what it was, then the rows that say the answer, then its one button. */
  function formBody(D, members, me, row, action) {
    const pay = D.kind === "payment";
    let out = "";
    // 1. THE AMOUNT: the sheet's headline, the whole width its own (the currency is in the title row: CURRENCY_HEAD).
    out += `<div class="sp-amtline">` +
        `<span class="sp-sym" data-slot="sym" aria-hidden="true">${esc(symbolOf(D.currency))}</span>` +
        `<input class="sp-amtin" data-sp="amount" type="text" inputmode="decimal" enterkeyhint="done"` +
          ` autocomplete="off" autocorrect="off" spellcheck="false"` +
          ` aria-label="Amount" placeholder="${D.exp > 0 ? `0.${"0".repeat(D.exp)}` : "0"}" value="${esc(D.amountText)}">` +
      `</div>` +
      `<div class="sp-currow" hidden></div>`;
    if (!pay) {
      // 2. WHAT IT WAS: a plain field.
      out += `<input class="sp-whatin" type="text" data-f="description" data-sp="what" enterkeyhint="done"` +
        ` aria-label="What was it?" placeholder="What was it?" maxlength="200" value="${esc(D.description)}">`;
    }
    // 3. THE ROWS.
    out += `<div class="sp-opts">`;
    if (pay) {
      out += optHtml("from", "From", "open-from") +
        `<div class="sp-pane" id="sp-pane-from" data-pane="from" hidden><div class="sp-people" role="radiogroup" aria-label="From" data-grp="paid"></div></div>`;
      out += optHtml("to", "To", "open-to") +
        `<div class="sp-pane" id="sp-pane-to" data-pane="to" hidden><div class="sp-people" role="radiogroup" aria-label="To" data-grp="to"></div></div>`;
    } else {
      out += optHtml("paid", "Paid by", "open-paid") +
        `<div class="sp-pane" id="sp-pane-paid" data-pane="paid" hidden><div class="sp-people" role="radiogroup" aria-label="Paid by" data-grp="paid"></div></div>`;
      out += optHtml("split", "Split", "open-split") +
        `<div class="sp-pane sp-split" id="sp-pane-split" data-pane="split" hidden>` +
          `<div class="sp-seg" role="radiogroup" aria-label="How it's split">` +
            `<button type="button" role="radio" data-act="by-even" data-sp="split-even" aria-checked="true">${SVG_TICK}Evenly</button>` +
            `<button type="button" role="radio" data-act="by-amount" data-sp="split-amount" aria-checked="false">${SVG_TICK}By amount</button>` +
          `</div>` +
          `<div class="sp-people" data-grp="split" role="group" aria-label="Who's in"></div>` +
          `<p class="sp-note" data-slot="split-note" hidden></p>` +
        `</div>`;
    }
    out += optHtml("when", "When", "open-when") +
      `<div class="sp-pane" id="sp-pane-when" data-pane="when" hidden><div class="sp-days" role="radiogroup" aria-label="When" data-slot="days"></div></div>`;
    if (!pay) {
      out += `<input type="file" accept="image/*" class="sp-rcpt-file" data-f="receipt" tabindex="-1" aria-hidden="true">` +
        `<div data-slot="receipt"></div>`;
      out += `<div data-slot="goes"></div>`;
    }
    out += `</div>`;
    // 4. THE BUTTON, full width at the foot, held above the keys.
    // The reason the button is off rides in the sticky foot, above it, so it is on screen whenever the button is off,
    // on a short phone and with the Split row closed alike.
    out += `<div class="sp-go">${pay ? "" : `<p class="sp-sumline" data-slot="sum" role="status" hidden></p>`}<button type="button" class="ds-button ds-button--white ds-button--lg ds-button--block" data-act="save" data-sp="save" disabled>${esc(action)}</button></div>`;
    // 5. In an edit: Chat about this, then the armed Delete, quiet, at the very foot.
    if (row) {
      out += (pay ? "" : `<div class="sp-chatrow"><button type="button" class="sp-quiet sp-chat" data-act="chat" data-sp="chat">${SVG_CHAT}<span>Chat about this</span></button></div>`) +
        `<div class="sp-foot"><button type="button" class="sp-quiet sp-del" data-act="del" data-sp="delete" data-destroys>` +
          `${pay ? "Delete payment" : "Delete purchase"}</button></div>`;
    }
    return out;
  }

  /**
   * One person to choose. The name is printed beside the mark: a choice is being made. Paid by,
   * From and To are radios (one chosen); who's in a split is a set of checkboxes.
   */
  function personHtml(m, me, kind, on, members) {
    const skin = skinOf(members, m.id, me.id);
    const gone = isGone(m) ? (m.deleted ? "account gone" : "left the trip") : "";
    return `<button type="button" class="sp-person" data-id="${esc(m.id)}" data-sp="choice"` +
      ` role="${kind}" aria-checked="${on ? "true" : "false"}"${gone ? ` data-gone="${gone}"` : ""}>` +
      markHtml(skin) +
      `<span class="sp-pname">${esc(skin.label)}${gone ? ` <span class="sp-gone">(${gone})</span>` : ""}</span>` +
      `<span class="sp-box" aria-hidden="true">${SVG_TICK}</span></button>`;
  }

  // ── the sheet's wiring ───────────────────────────────────────────────────────────────

  function wireDrawer(p) {
    const D = p.D;
    const wrap = p.wrap;

    // ONE delegated click listener on .sh-sheet.
    wrap.addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b || !wrap.contains(b) || b.disabled) return;
      const act = b.dataset.act;

      if (act === "save") { ev.preventDefault(); saveDrawer(p); return; }
      if (act === "chat") {
        ev.preventDefault();
        // A change not saved yet would go with the sheet: said, and the sheet stays.
        if (drawerSig(D) !== p.D0 || D.receiptNew || D.receiptRemove) { toast("Save the change first, or close it."); return; }
        chatAboutPurchase(p.row.id);
        return;
      }
      if (act === "del") {
        ev.preventDefault();
        arm(p, b, "Tap again to delete",
            D.kind === "payment" ? "Deletes the payment for everyone. What it settled is owed again."
              : "Deletes the purchase for everyone. There's no undo.",
            () => {
              const id = p.row.id;
              closePanel("sheet");
              guard("delete that", async () => { const r = await S.deletePurchase(id); await receipts.purchaseGone(id); return r; });
            });
        return;
      }
      if (act === "cur") { ev.preventDefault(); D.curOpen = !D.curOpen; syncDrawer(p, { keepAmountText: true, keepDesc: true }); if (p.refocusAmount) refocusAmount(p); return; }
      if (act === "pick-cur") { ev.preventDefault(); setCurrency(p, b.dataset.code); return; }
      if (act === "other-cur") { ev.preventDefault(); openCurrencyPicker(p); return; }
      if (act && act.startsWith("open-")) {
        ev.preventDefault();
        const which = act.slice(5);
        D.open = D.open === which ? "" : which;
        syncDrawer(p, { keepAmountText: true, keepDesc: true, reveal: D.open });
        return;
      }
      if (act === "day") {
        ev.preventDefault();
        D.when = b.dataset.day;
        D.open = "";
        syncDrawer(p, { keepAmountText: true, keepDesc: true });
        return;
      }
      if (act === "by-even") {
        ev.preventDefault();
        D.byAmount = false;
        D.touched = false;
        rescale(p);
        syncDrawer(p, { keepAmountText: true, keepDesc: true });
        return;
      }
      if (act === "by-amount") {
        ev.preventDefault();
        if (!D.byAmount) {
          // The equal amounts, now typed over: what is shown is what will be stored.
          rescale(p);
          D.byAmount = true;
          D.touched = true;
        }
        syncDrawer(p, { keepAmountText: true, keepDesc: true });
        return;
      }
      if (act === "goes") { ev.preventDefault(); openAttachPicker(p); return; }
      if (act === "rcpt-add") {
        ev.preventDefault();
        const f = wrap.querySelector(".sp-rcpt-file");
        if (f) { f.value = ""; f.click(); }
        return;
      }
      if (act === "rcpt-view") { ev.preventDefault(); openReceipt(shownReceipt(p)); return; }
      if (act === "rcpt-remove") {
        ev.preventDefault();
        if (D.receiptNew) { URL.revokeObjectURL(D.receiptNew.url); D.receiptNew = null; }
        else D.receiptRemove = true;
        paintReceipt(p);
        return;
      }

      const grp = b.closest("[data-grp]");
      if (grp && b.classList.contains("sp-person")) {
        ev.preventDefault();
        const id = b.dataset.id;
        if (grp.dataset.grp === "paid") {
          // A payment from the person it was going to: the two change places.
          if (D.kind === "payment" && D.split[0] === id) D.split = D.paid_by ? [D.paid_by] : [];
          D.paid_by = id;
          D.open = "";                         // one choice, and the row has its answer
        } else if (grp.dataset.grp === "to") {
          D.split = [id];
          D.open = "";
        } else {
          const i = D.split.indexOf(id);
          if (i >= 0) {
            // Refused with a reason, not a dead tap. The payer doesn't have to be in it (covering
            // somebody's ticket is a real purchase); somebody does.
            if (D.split.length === 1) { showSplitNote(p, "At least one person has to be in it."); return; }
            D.split.splice(i, 1);
            D.exact.delete(id);
          } else {
            D.split.push(id);
            // Joining a split by amount: at 0.00, and the line under the list says what's left.
            if (D.byAmount) D.exact.set(id, 0);
          }
          showSplitNote(p, "");
          if (!D.byAmount) rescale(p);
        }
        syncDrawer(p, { keepAmountText: true, keepDesc: true });
      }
    });

    // `input`, not `change`: the button turns on the moment the amount parses.
    wrap.addEventListener("input", (ev) => {
      const t = ev.target;
      if (t.classList.contains("sp-amtin")) {
        D.amountText = t.value;
        rescale(p);
        syncDrawer(p, { keepAmountText: true, keepDesc: true, typing: true });
        return;
      }
      if (t.dataset && t.dataset.f === "description") { D.description = t.value; return; }
      if (t.classList.contains("sp-uin")) {
        // Typing a person's amount is choosing "By amount". Only the words around it are repainted:
        // rebuilding the rows would take the caret out of the field.
        const v = parseAmount(t.value, D.exp);
        if (!D.byAmount) { D.byAmount = true; D.touched = true; }
        D.exact.set(t.dataset.id, v == null ? 0 : v);
        paintSplitMode(p);
        paintSum(p);
        paintAnswers(p);
      }
    });

    // The receipt's file, once chosen: made to the receipt's size here, before anything is saved.
    wrap.addEventListener("change", async (ev) => {
      const t = ev.target;
      if (!t.classList || !t.classList.contains("sp-rcpt-file")) return;
      const file = t.files && t.files[0];
      if (!file) return;
      p.rcptBusy = true;
      paintReceipt(p);
      try {
        const made = await receipts.makeReceipt(file);
        if (D.receiptNew) URL.revokeObjectURL(D.receiptNew.url);
        D.receiptNew = { ...made, url: URL.createObjectURL(made.blob) };
        D.receiptRemove = false;
      } catch (e) {
        toast((e && e.message) || "That picture couldn't be kept.");
      } finally {
        p.rcptBusy = false;
        if (wrap.isConnected) paintReceipt(p);
        else if (D.receiptNew) { URL.revokeObjectURL(D.receiptNew.url); D.receiptNew = null; }
      }
    });

    // Enter in the amount or the description commits: a keyboard's "done" key means done.
    wrap.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      const t = ev.target;
      if (t.classList.contains("sp-amtin") || (t.dataset && t.dataset.f === "description")) {
        ev.preventDefault();
        if (p.saveBtn && !p.saveBtn.disabled) saveDrawer(p);
        else t.blur();
      }
    });

    // THE KEYPAD STAYS UP while the currency is chosen: preventing pointerdown's default stops the
    // browser moving focus to the button; click still fires.
    wrap.addEventListener("pointerdown", (ev) => {
      const b = ev.target.closest('[data-act="cur"],[data-act="pick-cur"]');
      if (!b) return;
      const a = wrap.querySelector(".sp-amtin");
      if (a && document.activeElement === a) { ev.preventDefault(); p.refocusAmount = true; }
    });
  }

  /** The receipt the sheet shows: one just chosen, none once removed, else the purchase's own. */
  function shownReceipt(p) {
    const D = p.D;
    if (D.receiptNew) return { state: "new", url: D.receiptNew.url, w: D.receiptNew.w, h: D.receiptNew.h };
    if (D.receiptRemove || !p.row) return null;
    // The row as the store has it now: a receipt sent while the sheet is open shows as stored.
    const rc = receipts.receiptOf(S.purchase(p.row.id) || p.row);
    return rc && rc.state !== "removing" ? rc : null;
  }

  /**
   * The Receipt row: "Add a photo" opens the camera or the library. Once there is one, the row
   * says its state and the picture shows small under it, with Change and Remove.
   */
  function paintReceipt(p) {
    const slot = p.wrap.querySelector('[data-slot="receipt"]');
    if (!slot) return;
    if (p.rcptBusy) {
      slot.innerHTML = `<div class="sp-opt" data-sp="row-receipt" role="status"><span class="sp-opt-k">Receipt</span>` +
        `<span class="sp-opt-v">Making it smaller…</span><span></span></div>`;
      return;
    }
    const rc = shownReceipt(p);
    if (!rc) {
      slot.innerHTML = `<button type="button" class="sp-opt" data-act="rcpt-add" data-sp="row-receipt">` +
        `<span class="sp-opt-k">Receipt</span><span class="sp-opt-v">Add a photo</span>${SVG_CHEV_R}</button>`;
      return;
    }
    const answer = { new: "Photo added", waiting: "Waiting to send", refused: "Not sent", stored: "Photo added" }[rc.state] || "Photo added";
    const words = {
      new: p.D.mode === "add" ? "Kept with the purchase when you add it." : (p.row && p.row.receipt ? "Replaces the one there when you save." : "Kept when you save."),
      waiting: "It goes when there's signal.",
      // Too big: this phone made it to the size the server takes, so the making fell short; say
      // so, the limit after it, and what to try. Anything else: the server's words.
      refused: rc.status === 413
        ? `Still too big after this phone made it smaller${rc.reason ? ` (${rc.reason.replace(/\.$/, "").replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLowerCase())})` : ""}. Try another picture.`
        : (rc.reason || "It couldn't be kept."),
      stored: "Everyone on the trip can open it.",
    }[rc.state] || "";
    slot.innerHTML = `<div class="sp-opt" data-sp="row-receipt"><span class="sp-opt-k">Receipt</span>` +
        `<span class="sp-opt-v">${rc.state === "refused" ? `<span class="sp-bad">${SVG_ALERT}${answer}</span>` : answer}</span><span></span></div>` +
      `<div class="sp-rcpt">` +
        `<button type="button" class="sp-rcpt-thumb" data-act="rcpt-view" aria-label="Open the receipt">` +
          (rc.url ? `<img alt="" src="${esc(rc.url)}">` : "") + `</button>` +
        `<span class="sp-rcpt-side"><span class="sp-rcpt-state" data-state="${rc.state}">${esc(words)}</span>` +
        `<span class="sp-rcpt-acts">` +
          `<button type="button" class="sp-quiet" data-act="rcpt-add" data-sp="receipt-change">Change</button>` +
          `<button type="button" class="sp-quiet" data-act="rcpt-remove" data-sp="receipt-remove" data-destroys>Remove</button>` +
        `</span></span>` +
      `</div>`;
  }

  /** The receipt, full width, on a sheet over whatever is open. */
  function openReceipt(rc) {
    if (!rc || !rc.url) return;
    openPanel({
      slot: "picker",
      kind: "receipt",
      title: "Receipt",
      body: `<div class="sp-rcpt-view"><img alt="The receipt" src="${esc(rc.url)}"` +
        (rc.w && rc.h ? ` width="${rc.w}" height="${rc.h}"` : "") + `></div>`,
      dragFrom: "handle",
      closeButton: true,
    });
  }

  function showSplitNote(p, msg) {
    const n = p.wrap.querySelector('[data-slot="split-note"]');
    if (!n) return;
    n.textContent = msg;
    n.hidden = !msg;
  }

  /**
   * The per-person amounts when the AMOUNT (or who's in) changes. Evenly: the equal split of the
   * new amount. By amount: scaled in proportion through allocate(), the primitive that built the
   * shares, so they still sum to the total exactly with no second rounding rule.
   */
  function rescale(p) {
    const D = p.D;
    if (D.kind === "payment") return;        // one share, the whole amount
    const total = parseAmount(D.amountText, D.exp);
    const ids = D.split.slice().sort();
    if (!ids.length) return;
    if (total == null || total <= 0) {
      if (!D.byAmount) D.exact = new Map(ids.map((u) => [u, 0]));
      return;
    }
    if (!D.byAmount) {
      const eq = equalShares(total, ids.length, D.id);
      D.exact = new Map(ids.map((u, i) => [u, eq[i]]));
      return;
    }
    const olds = ids.map((u) => D.exact.get(u) || 0);
    if (olds.reduce((a, b) => a + b, 0) <= 0) {
      const eq = equalShares(total, ids.length, D.id);
      D.exact = new Map(ids.map((u, i) => [u, eq[i]]));
      return;
    }
    const scaled = allocate(total, olds, D.id);
    D.exact = new Map(ids.map((u, i) => [u, scaled[i]]));
  }

  function setCurrency(p, code) {
    const D = p.D;
    if (!code || !/^[A-Z]{3}$/.test(code)) return;
    D.currency = code;
    // The exponent comes off the code only now, when the purchase is made or its currency changed;
    // from then on it rides the row.
    const nextExp = expOf(code);
    if (nextExp !== D.exp) {
      // The MAJOR value is what the person meant: "185.50" is rewritten only when it can no longer
      // be said in the new currency (185.50 in yen), and then from the major value.
      const oldExp = D.exp;
      const before = parseAmount(D.amountText, oldExp);
      D.exp = nextExp;
      if (before != null && parseAmount(D.amountText, nextExp) == null) {
        D.amountText = toAmountText(restate(before, oldExp, nextExp), nextExp);
      }
      // Per-person amounts in a currency with another scale mean nothing now: back to even.
      D.byAmount = false;
      D.touched = false;
      D.exact = new Map();
    }
    D.curOpen = false;
    rememberCurrency(code);
    rescale(p);
    syncDrawer(p, { keepDesc: true });
    if (p.refocusAmount) refocusAmount(p);
  }

  function refocusAmount(p) {
    p.refocusAmount = false;
    const a = p.wrap.querySelector(".sp-amtin");
    if (a && document.activeElement !== a) a.focus({ preventScroll: true });
  }

  /** "Everyone, evenly", "You and Ben, evenly", "3 people, by amount", "Ben only". */
  function splitWords(D, members, me) {
    const on = stillOn(members);
    const everyone = on.length && D.split.length === on.length && on.every((m) => D.split.includes(m.id));
    const how = D.byAmount ? "by amount" : "evenly";
    if (D.split.length === 1) return `${skinOf(members, D.split[0], me.id).label === "You" ? "You" : skinOf(members, D.split[0], me.id).first} only`;
    if (everyone) return `Everyone, ${how}`;
    if (D.split.length === 2) {
      // You first: "You and Ben", never "Ben and You".
      const names = peopleOrder(members).filter((m) => D.split.includes(m.id))
        .sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : 0))
        .map((m) => (m.id === me.id ? "You" : skinOf(members, m.id, me.id).first));
      if (names.length === 2) return `${names[0]} and ${names[1]}, ${how}`;
    }
    return `${D.split.length} people, ${how}`;
  }

  /** Does a split by amount add up? { ok, diff } in minor units; ok when it isn't by amount. */
  function sumState(D) {
    const total = parseAmount(D.amountText, D.exp);
    if (!D.byAmount || total == null || total <= 0) return { ok: true, diff: 0, total };
    const sum = D.split.reduce((a, id) => a + (D.exact.get(id) || 0), 0);
    return { ok: sum === total, diff: total - sum, total };
  }

  /** The rows' answers. */
  function paintAnswers(p) {
    const D = p.D, wrap = p.wrap;
    const members = S.members() || [], me = S.me();
    const trip = S.trip(), tz = (trip && trip.default_tz) || "UTC";
    const set = (k, html, label) => {
      const e = wrap.querySelector(`[data-slot="ans-${k}"]`);
      if (e) e.innerHTML = html;
      const b = wrap.querySelector(`[data-sp="row-${k}"]`);
      if (b && label) b.setAttribute("aria-label", label);
    };
    const name = (id) => (id ? skinOf(members, id, me.id).label : "Choose");
    if (D.kind === "payment") {
      set("from", esc(name(D.paid_by)), `From: ${name(D.paid_by)}`);
      set("to", esc(D.split[0] ? name(D.split[0]) : "Choose someone"), `To: ${D.split[0] ? name(D.split[0]) : "nobody yet"}`);
    } else {
      set("paid", esc(name(D.paid_by)), `Paid by ${name(D.paid_by)}`);
      const st = sumState(D);
      const words = splitWords(D, members, me);
      set("split", st.ok ? esc(words) : `<span class="sp-bad">${SVG_ALERT}Doesn't add up</span>`,
        st.ok ? `Split: ${words}` : "Split: the amounts don't add up");
    }
    const { today, yesterday } = dayChoices(trip, tz);
    const w = dayKeyWords(D.when, tz, today, yesterday);
    set("when", esc(w), `When: ${w}`);
  }

  /** Which pane is open, and the rows' expanded state. */
  function paintPanes(p) {
    const D = p.D, wrap = p.wrap;
    for (const b of wrap.querySelectorAll(".sp-opt[data-act^='open-']")) {
      b.setAttribute("aria-expanded", b.dataset.act === `open-${D.open}` ? "true" : "false");
    }
    for (const pane of wrap.querySelectorAll(".sp-pane")) pane.hidden = pane.dataset.pane !== D.open;
  }

  /** The Split pane's two choices. */
  function paintSplitMode(p) {
    const D = p.D;
    const pane = p.wrap.querySelector(".sp-split");
    if (!pane) return;
    pane.dataset.by = D.byAmount ? "amount" : "even";
    for (const b of pane.querySelectorAll(".sp-seg button")) {
      const on = (b.dataset.act === "by-amount") === !!D.byAmount;
      b.setAttribute("aria-checked", on ? "true" : "false");
    }
  }

  /**
   * The line under the Split pane's list, by amount only: "€18.60 of €18.60", or what is left or
   * too much, in --warn with its glyph. The button's state is the same question, answered here.
   */
  function paintSum(p) {
    const D = p.D;
    const total = parseAmount(D.amountText, D.exp);
    if (D.kind === "payment") {
      // Off says why (a disabled control says why in words): the first thing still missing.
      if (p.saveBtn) setDisabled(p.saveBtn, !(total != null && total > 0) ? "Enter the amount"
        : !D.paid_by ? "Choose who paid" : !(D.split.length === 1 && D.split[0] !== D.paid_by) ? "Choose who was paid" : "");
      return;
    }
    const st = sumState(D);
    const line = p.wrap.querySelector('[data-slot="sum"]');
    if (line) {
      if (!D.byAmount || total == null || total <= 0) {
        line.dataset.state = "";
        line.textContent = "";
        line.hidden = true;
      } else {
        line.hidden = false;
        const sum = st.total - st.diff;
        if (st.diff === 0) {
          line.dataset.state = "ok";
          line.textContent = `${fmtMoney(sum, D.exp, D.currency)} of ${fmtMoney(total, D.exp, D.currency)}`;
        } else if (st.diff > 0) {
          line.dataset.state = "short";
          line.innerHTML = `${SVG_ALERT}<span>${esc(fmtMoney(st.diff, D.exp, D.currency))} still to share</span>`;
        } else {
          line.dataset.state = "over";
          line.innerHTML = `${SVG_ALERT}<span>${esc(fmtMoney(-st.diff, D.exp, D.currency))} too much</span>`;
        }
      }
    }
    if (p.saveBtn) setDisabled(p.saveBtn, !(total != null && total > 0) ? "Enter the amount"
      : !D.paid_by ? "Choose who paid" : !D.split.length ? "Choose who shares it" : !st.ok ? "The shares don't add up to the amount" : "");
  }

  /**
   * Repaint what is derived rather than typed. The amount and description fields are left alone
   * by default: writing a value into the field the caret is in moves the caret to its end.
   */
  function syncDrawer(p, { keepAmountText = false, keepDesc = false, typing = false, reveal = "" } = {}) {
    if (!p || !p.wrap.isConnected) return;
    const D = p.D;
    const wrap = p.wrap;
    const members = S.members() || [];
    const me = S.me();
    const trip = S.trip();
    const tz = (trip && trip.default_tz) || "UTC";

    const amt = wrap.querySelector(".sp-amtin");
    if (amt && !keepAmountText && amt.value !== D.amountText) amt.value = D.amountText;
    if (amt) amt.placeholder = D.exp > 0 ? `0.${"0".repeat(D.exp)}` : "0";
    const desc = wrap.querySelector('[data-f="description"]');
    if (desc && !keepDesc && desc.value !== D.description) desc.value = D.description;
    const sym = wrap.querySelector('[data-slot="sym"]');
    if (sym) sym.textContent = symbolOf(D.currency);

    const curBtn = wrap.querySelector('[data-act="cur"]');
    if (curBtn) {
      curBtn.innerHTML = `${esc(D.currency)}${SVG_CHEV_D}`;
      curBtn.setAttribute("aria-expanded", D.curOpen ? "true" : "false");
      curBtn.setAttribute("aria-label", `Currency: ${nameOf(D.currency) || D.currency}`);
    }
    // The trip's currencies, inline under the amount (a sheet would drop the keypad); "Other
    // currency…" is the door to the rest, and how the trip's list widens.
    const curRow = wrap.querySelector(".sp-currow");
    if (curRow && !typing) {
      curRow.hidden = !D.curOpen;
      if (D.curOpen) {
        const list = enabledCurrencies(S);
        if (!list.includes(D.currency)) list.push(D.currency);
        curRow.innerHTML = list.map((c) =>
          `<button type="button" class="sp-chip" data-act="pick-cur" data-code="${esc(c)}" data-sp="currency-choice"` +
          ` aria-pressed="${c === D.currency ? "true" : "false"}">` +
          (c === D.currency ? SVG_TICK : "") + `${esc(currencyLabel(c))}</button>`).join("") +
          `<button type="button" class="sp-quiet" data-act="other-cur" data-sp="currency-other">Other currency…</button>`;
      } else {
        curRow.innerHTML = "";
      }
    }

    // The people in the open pane (radios: Paid by, From, To).
    for (const grp of wrap.querySelectorAll('[data-grp="paid"],[data-grp="to"]')) {
      if (typing) break;
      const isTo = grp.dataset.grp === "to";
      const people = peopleOrder(members).filter((m) => !isTo || m.id !== D.paid_by);
      grp.innerHTML = people.map((m) => personHtml(m, me, "radio", isTo ? D.split[0] === m.id : m.id === D.paid_by, members)).join("");
    }

    // Who's in, each with their share at the right.
    const splitGrp = wrap.querySelector('[data-grp="split"]');
    if (splitGrp && D.open === "split") {
      const total = parseAmount(D.amountText, D.exp);
      const known = new Set(members.map((m) => m.id));
      const shown = [...peopleOrder(members), ...D.split.filter((id) => !known.has(id)).map((id) => ({ id }))];
      splitGrp.innerHTML = shown.map((m) => {
        const on = D.split.includes(m.id);
        const skin = skinOf(members, m.id, me.id);
        const v = on ? (D.exact.get(m.id) || 0) : null;
        const who = skin.label === "You" ? "Your share" : `${skin.name}'s share`;
        return `<div class="sp-who">${personHtml(m, me, "checkbox", on, members)}` +
          (on ? `<input class="sp-uin num" type="text" inputmode="decimal" autocomplete="off" data-id="${esc(m.id)}" data-sp="share"` +
            ` aria-label="${esc(who)}" placeholder="${D.exp > 0 ? `0.${"0".repeat(D.exp)}` : "0"}"` +
            ` value="${esc(total != null && total > 0 ? toAmountText(v, D.exp) : "")}">` : `<span></span>`) +
          `</div>`;
      }).join("");
    }

    // When: today, yesterday, then the trip's own days.
    const days = wrap.querySelector('[data-slot="days"]');
    if (days && D.open === "when" && !typing) {
      const { today, yesterday, days: list } = dayChoices(trip, tz);
      const all = list.includes(D.when) ? list : [...list, D.when];
      days.innerHTML = all.map((k) =>
        `<button type="button" class="sp-chip" role="radio" data-act="day" data-day="${esc(k)}" data-sp="choice"` +
        ` aria-checked="${k === D.when ? "true" : "false"}">` +
        (k === D.when ? SVG_TICK : "") + `${esc(dayKeyWords(k, tz, today, yesterday))}</button>`).join("");
    }

    // What it goes with: a plan, a place or a day, or nothing (most purchases).
    const goes = wrap.querySelector('[data-slot="goes"]');
    if (goes && !typing) {
      const att = attachmentOf(S, D, tz);
      goes.innerHTML = `<button type="button" class="sp-opt" data-act="goes" data-sp="row-goes" aria-haspopup="dialog"` +
          ` aria-label="What it was for: ${esc(att ? att.name : "a plan or place, not chosen")}">` +
        `<span class="sp-opt-k">For</span><span class="sp-opt-v">${esc(att ? att.name : "A plan or place")}</span>${SVG_CHEV_R}</button>`;
    }
    if (!typing) paintReceipt(p);

    paintAnswers(p);
    paintPanes(p);
    paintSplitMode(p);
    paintSum(p);
    if (reveal) revealPane(p, reveal);
    wakePictures(p && p.wrap);
  }

  /**
   * A pane that has just opened is brought on screen inside the sheet's own scrollport, by a
   * measured amount (scrollIntoView would move the page behind the sheet too), down to the
   * keyboard's top edge rather than the sheet's foot behind it, and short of the button's band.
   */
  function revealPane(p, which) {
    const pane = p.wrap.querySelector(`[data-pane="${which}"]`);
    const row = p.wrap.querySelector(`[data-sp="row-${which}"]`);
    const port = pane && pane.closest(".sh-body");
    if (!port || pane.hidden || !row) return;
    const PAD = 12;
    const pr = port.getBoundingClientRect();
    const vv = window.visualViewport;
    const go = p.wrap.querySelector(".sp-go");
    const band = go ? go.offsetHeight : 0;
    const glass = (vv ? Math.min(pr.bottom, vv.offsetTop + vv.height) : pr.bottom) - band;
    const top = row.getBoundingClientRect().top;
    const bottom = pane.getBoundingClientRect().bottom;
    const want = Math.min(bottom - (glass - PAD), top - (pr.top + PAD));
    if (want > 0) port.scrollTop += want;
  }

  /**
   * Commit: validate, close, then write through the store inside guard(). The economic tuple
   * (amount, currency, exponent, split mode, shares) is sent whole, always: the queue's fold is a
   * shallow merge, and an array sent in part would be replaced wholesale.
   */
  function saveDrawer(p) {
    const D = p.D;
    if (p.readOnly) return;
    const total = parseAmount(D.amountText, D.exp);
    if (total == null || total <= 0) return;
    // When: today's purchases are stamped now, as before; another day goes at noon of that day in
    // the trip's zone. An edit moves the time only if the day was changed.
    const tz = (S.trip() && S.trip().default_tz) || "UTC";
    const todayKey = dayKey(Math.floor(Date.now() / 1000), tz);
    const when = D.mode === "add"
      ? (D.when && D.when !== todayKey ? { spent_at: noonOn(D.when, tz) } : {})
      : (D.when && D.when !== D.whenWas ? { spent_at: noonOn(D.when, tz) } : {});
    if (D.kind === "payment") {
      const to = D.split[0];
      if (!D.paid_by || !to || to === D.paid_by) return;
      const money = { from: D.paid_by, to, amount_minor: total, currency: D.currency, amount_exp: D.exp };
      closePanel("sheet");
      if (D.mode === "add") guard("record that", () => S.addPayment({ id: D.id, ...money, ...when }));
      else guard("save that", async () => {
        const r = await S.updatePayment(D.id, money);
        if (when.spent_at) await S.updatePurchase(D.id, when);
        return r;
      });
      return;
    }
    const ids = D.split.slice().sort();          // contract order: user_id ascending
    if (!ids.length) return;

    // Equal is arithmetic, not a mode: amounts that ARE the equal split are stored as weights, so
    // the purchase is born equal and re-derives itself if the amount changes later.
    const eq = equalShares(total, ids.length, D.id);
    const vals = ids.map((u, i) => (D.byAmount ? (D.exact.get(u) || 0) : eq[i]));
    const isEqual = vals.every((v, i) => v === eq[i]);
    if (!isEqual && vals.reduce((a, b) => a + b, 0) !== total) return;   // guarded by the button

    const eco = isEqual
      ? { split_mode: "weight", shares: ids.map((u) => ({ user_id: u, weight: 1 })) }
      : { split_mode: "exact", shares: ids.map((u, i) => ({ user_id: u, weight: vals[i] })) };

    const desc = String(D.description || "").trim();
    closePanel("sheet");

    const made = D.receiptNew ? { blob: D.receiptNew.blob, w: D.receiptNew.w, h: D.receiptNew.h } : null;
    if (D.receiptNew) { URL.revokeObjectURL(D.receiptNew.url); D.receiptNew = null; }
    const removeReceipt = !made && D.receiptRemove;
    const hadOnServer = !!(p.row && p.row.receipt && p.row.receipt.url);
    // The receipt follows its purchase: held on this phone once the purchase is, sent after it.
    const thenReceipt = async (done) => {
      if (done === null) return null;
      if (made) await receipts.hold(D.id, made);
      else if (removeReceipt) await receipts.remove(D.id, { onServer: hadOnServer });
      return done;
    };

    if (D.mode === "add") {
      guard("add that", async () => thenReceipt(await S.addPurchase({
        id: D.id,
        description: desc,
        amount_minor: total,
        currency: D.currency,
        amount_exp: D.exp,
        paid_by: D.paid_by,
        split_mode: eco.split_mode,
        shares: eco.shares,
        day: D.day || "",
        event_id: D.event_id || null,
        place_id: D.place_id || null,
        note: D.note || "",
        ...when,
      }) ?? true));
      return;
    }
    guard("save that", async () => thenReceipt(await S.updatePurchase(D.id, {
      description: desc,
      amount_minor: total,
      currency: D.currency,
      amount_exp: D.exp,
      split_mode: eco.split_mode,
      shares: eco.shares,
      paid_by: D.paid_by,
      day: D.day || "",
      event_id: D.event_id || null,
      place_id: D.place_id || null,
      ...when,
    }) ?? true));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════
  // the pickers — sheets stacked over the add sheet, which stays put underneath
  // ══════════════════════════════════════════════════════════════════════════════════════

  /**
   * What a purchase goes with: a plan, a place, or a day. Optional, and nothing downstream reads
   * it (balances ignore it). Today's plans first: what you just paid for is most often on them.
   */
  function openAttachPicker(p) {
    const D = p.D;
    const trip = S.trip();
    const tz = (trip && trip.default_tz) || "UTC";
    const todayKey = dayKey(Date.now(), tz);
    const events = S.events();
    const places = S.places();

    const evRow = (e) => {
      const place = e.place_id ? S.place(e.place_id) : null;
      const kind = (place && place.kind) || e.kind || "plan";
      const pk = ["flight", "transit", "meal", "lodging", "activity", "plan"].includes(e.kind) ? e.kind : "plan";
      const tok = (pk !== "flight" && pk !== "transit" && place && place.kind) ? `--cat-${categoryOf(place.kind)}` : `--plan-${pk}`;
      return `<button type="button" class="sp-pickrow" data-pick="event" data-id="${esc(e.id)}"` +
        ` style="--ds-k:var(${tok})">` +
        getIcon(kind, place && place.subkind) +
        `<span class="sp-pickrow-name">${esc(e.title || "A plan")}</span>` +
        `<span class="sp-pickrow-sub num">${e.all_day ? "" : esc(fmtTime(e.starts_at, e.tz || tz))}</span>` +
        `</button>`;
    };

    const body = `<input class="input sp-filter" type="search" data-f="filter"` +
      ` placeholder="Filter" aria-label="Filter the trip" autocomplete="off">` +
      `<div class="sp-pick" data-slot="picklist"></div>`;

    const build = (q) => {
      const needle = q.trim().toLowerCase();
      const hit = (s) => !needle || String(s || "").toLowerCase().includes(needle);
      let out = "";
      if (!needle && (D.event_id || D.place_id || D.day)) {
        out += `<button type="button" class="sp-pickrow" data-pick="none"><span class="sp-pickrow-name">Nothing</span></button>`;
      }

      const today = events.filter((e) => dayKey(e.starts_at, e.tz || tz) === todayKey && hit(e.title));
      if (today.length) out += `<p class="sp-pick-head">Today</p>` + today.map(evRow).join("");

      // Every plan under a day header; tapping the HEADER puts the purchase on the day alone.
      let day = "";
      let trip1 = "";
      for (const e of events) {
        if (!hit(e.title)) continue;
        const k = dayKey(e.starts_at, e.tz || tz);
        if (k !== day) {
          day = k;
          trip1 += `<button type="button" class="sp-dayrow" data-pick="day" data-id="${esc(k)}">` +
            `<span>${esc(longDay(e.starts_at, e.tz || tz))}</span>` +
            `<span class="sp-dayrow-add">The whole day</span></button>`;
        }
        trip1 += evRow(e);
      }
      if (trip1) out += `<p class="sp-pick-head">This trip</p>` + trip1;

      const pl = places.filter((x) => hit(x.name) || hit(x.name_local))
        .slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
      if (pl.length) {
        out += `<p class="sp-pick-head">Places</p>` + pl.map((x) =>
          `<button type="button" class="sp-pickrow" data-pick="place" data-id="${esc(x.id)}"` +
          ` style="--ds-k:var(--cat-${categoryOf(x.kind)})">` +
          getIcon(x.kind, x.subkind) +
          `<span class="sp-pickrow-name">${esc(x.name || "A place")}</span></button>`).join("");
      }

      if (!out) {
        out = `<div class="empty"><h3 class="h3">Nothing matches</h3>` +
          `<p>A purchase doesn't have to go with anything.</p></div>`;
      }
      return out;
    };

    openPanel({
      slot: "picker",
      kind: "attach",
      title: "What it was for",
      body,
      dragFrom: "handle",
      closeButton: true,
      onReady: (q) => {
        const list = q.wrap.querySelector('[data-slot="picklist"]');
        list.innerHTML = build("");
        q.wrap.addEventListener("input", (ev) => {
          if (ev.target.dataset && ev.target.dataset.f === "filter") list.innerHTML = build(ev.target.value);
        });
        q.wrap.addEventListener("click", (ev) => {
          const b = ev.target.closest("[data-pick]");
          if (!b || !q.wrap.contains(b)) return;
          ev.preventDefault();
          const kind = b.dataset.pick;
          const id = b.dataset.id;
          // One of the three, never two: setting one clears the others.
          D.event_id = kind === "event" ? id : null;
          D.place_id = kind === "place" ? id : null;
          D.day = kind === "day" ? id : "";
          // Fill "What was it?" only if it is empty: typed words are the person's.
          if (!String(D.description || "").trim() && (kind === "event" || kind === "place")) {
            const name = kind === "event" ? ((S.event(id) || {}).title || "") : ((S.place(id) || {}).name || "");
            if (name) D.description = name;
          }
          closePanel("picker");
          syncDrawer(p);
        });
      },
    });
  }

  /**
   * Every currency, searchable: the door to the ones the trip hasn't used, and how its list widens
   * (paying in one puts it in the server's union). There is no way to remove one: the list is
   * computed, with no write route.
   */
  /**
   * The long list of currencies, in one picker for a purchase's currency and for what totals are shown in ({ for:
   * "display" }). With nothing typed: the trip's own, then this phone's recent picks, then the rest by name; a search
   * filters the same order. For totals, a code with no exchange rate is shown but can't be chosen, and says why.
   */
  function openCurrencyPicker(p, { for: mode = "purchase", after = null } = {}) {
    const body = `<input class="input sp-filter" type="search" data-f="filter"` +
      ` placeholder="Search currencies" aria-label="Search currencies" autocomplete="off">` +
      `<div class="sp-pick" data-slot="curlist"></div>`;

    const order = [];
    const add = (c) => { const v = String(c || "").toUpperCase(); if (CURRENCY_CODES.includes(v) && !order.includes(v)) order.push(v); };
    for (const c of S.currencies() || []) add(c);
    for (const c of recentCurrencies()) add(c);
    for (const c of [...CURRENCY_CODES].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) add(c);
    const build = (q) => {
      const needle = q.trim().toLowerCase();
      const hits = order.filter((c) =>
        !needle || c.toLowerCase().includes(needle) || nameOf(c).toLowerCase().includes(needle));
      if (!hits.length) {
        return `<div class="empty"><h3 class="h3">No such currency</h3>` +
          `<p>Search by code (EUR) or by name (Euro).</p></div>`;
      }
      return hits.map((c) => {
        const none = mode === "display" && !hasRate(S, c);
        return `<button type="button" class="sp-pickrow" data-code="${esc(c)}"${none ? ` disabled aria-description="No exchange rate for it yet"` : ""}>` +
          `<span class="sp-pickrow-name">${esc(nameOf(c))}${none ? `<span class="sp-pickrow-why">No exchange rate for it yet</span>` : ""}</span>` +
          `<span class="sp-pickrow-sub num">${esc(currencyLabel(c))}</span></button>`;
      }).join("");
    };

    openPanel({
      slot: "picker",
      kind: "currency",
      title: mode === "display" ? "Show totals in" : "Other currency",
      body,
      dragFrom: "handle",
      closeButton: true,
      onReady: (q) => {
        const list = q.wrap.querySelector('[data-slot="curlist"]');
        list.innerHTML = build("");
        q.wrap.addEventListener("input", (ev) => {
          if (ev.target.dataset && ev.target.dataset.f === "filter") list.innerHTML = build(ev.target.value);
        });
        q.wrap.addEventListener("click", (ev) => {
          const b = ev.target.closest("[data-code]");
          if (!b || !q.wrap.contains(b) || b.disabled) return;
          ev.preventDefault();
          closePanel("picker");
          if (mode === "display") { setDisplay(b.dataset.code); if (after) after(); }
          else setCurrency(p, b.dataset.code);
        });
      },
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════
  // settle up: the payments that settle everyone first, because they are what you do; then
  // each person's balance as a name and a phrase; then the payments already made
  // ══════════════════════════════════════════════════════════════════════════════════════

  function openSettle() {
    if (!S.purchases().length) return;
    if (wideMq.matches) {
      // Beside the feed already: nothing opens as a sheet just to read balances.
      const t = wideEl.querySelector(".sp-sup");
      if (t) t.scrollIntoView({ block: "nearest" });
      return;
    }
    openPanel({
      slot: "sheet",
      kind: "settle",
      title: "Settle up",
      body: `<div data-slot="settle"></div>`,
      // The currency it is counted in, in the head, where sheet.js puts footEl.
      foot: `<span data-slot="settle-cur"></span>`,
      dragFrom: "body",
      closeButton: true,
      onReady: (p) => {
        p.wrap.addEventListener("click", (ev) => {
          const b = ev.target.closest("button") || ev.target.closest(".sp-balrow")?.querySelector(".sp-bal");
          if (!b || !p.wrap.contains(b)) return;
          settleClick(b, ev, true);
        });
        p.wrap.addEventListener("change", (ev) => {
          if (ev.target.dataset && ev.target.dataset.act === "display") displayChanged(ev.target, () => paintSettle(p));
        });
        paintSettle(p);
        // sheet.js has just focused the first button it found (the currency menu in the head);
        // focus goes to the sheet's content instead, so Escape and Tab start inside it.
        p.form.focus({ preventScroll: true });
      },
    });
  }

  function paintSettle(p) {
    if (!p || !p.wrap.isConnected) return;
    const host = p.wrap.querySelector('[data-slot="settle"]');
    if (!host) return;
    const m = model();
    host.innerHTML = settleHtml(m, { where: "sheet" });
    const cur = p.wrap.querySelector('[data-slot="settle-cur"]');
    if (cur) cur.innerHTML = settleMode === "currency" ? "" : displaySelectHtml(m, "settle");
  }

  /** One handler for every Settle up button, wherever it stands (the sheet, the side, the headline). */
  function settleClick(b, ev, inSheet) {
    const act = b.dataset.act;
    if (b.dataset.mode) { ev.preventDefault(); settleMode = b.dataset.mode; repaintSettle(); return true; }
    if (act === "mark-paid") {
      // A line of the plan, marked paid: the payment sheet opens filled in, and its button saves
      // it. Nothing is recorded by a stray tap.
      ev.preventDefault();
      if (inSheet) closePanel("sheet");
      openDrawer(null, { payment: true, title: "Mark paid", back: inSheet ? "settle" : "", from: b.dataset.from, to: b.dataset.to,
                         amount_minor: Number(b.dataset.amount), currency: b.dataset.cur });
      return true;
    }
    if (act === "record") { ev.preventDefault(); if (inSheet) closePanel("sheet"); openDrawer(null, { payment: true, back: inSheet ? "settle" : "" }); return true; }
    if (act === "payment") { ev.preventDefault(); if (inSheet) closePanel("sheet"); openDrawer(b.dataset.id, { back: inSheet ? "settle" : "" }); return true; }
    if (act === "bal") {
      ev.preventDefault();
      const k = b.dataset.key;
      if (openBal.has(k)) openBal.delete(k); else openBal.add(k);
      const open = openBal.has(k);
      b.setAttribute("aria-expanded", open ? "true" : "false");
      const why = document.getElementById(b.getAttribute("aria-controls"));
      if (why) why.hidden = !open;
      return true;
    }
    if (act === "fetch-rates") {
      ev.preventDefault();
      b.disabled = true;
      guard("fetch rates", () => S.refreshRates()).then(() => { if (!dead) repaintSettle(); });
      return true;
    }
    return false;
  }

  function repaintSettle() {
    if (sheet && sheet.kind === "settle") paintSettle(sheet);
    scheduleRender();
  }

  /**
   * Settle up's content. "Combined" counts everything in the currency shown; "By currency" settles
   * each currency in itself, with no rate at all, and is the answer when no rate is held.
   */
  function settleHtml(m, { where }) {
    const nothingConverts = m.led.unconverted.length === m.rows.length;
    if (!settleMode || (settleMode === "converted" && nothingConverts)) settleMode = nothingConverts ? "currency" : "converted";
    const currencies = [...new Set(m.rows.map((r) => r.currency))].sort();
    let out = `<div class="sp-sup" data-sp="settle-${where}">`;
    if (where === "side") out += `<h2 class="sp-block-head">Settle up</h2>`;

    if (currencies.length > 1 || nothingConverts) {
      out += `<div class="sp-seg" role="radiogroup" aria-label="Count it">` +
        `<button type="button" role="radio" data-mode="converted" data-sp="settle-combined" aria-checked="${settleMode === "converted"}"` +
          `${nothingConverts ? " disabled" : ""}>${settleMode === "converted" ? SVG_TICK : ""}Combined</button>` +
        `<button type="button" role="radio" data-mode="currency" data-sp="settle-by-currency" aria-checked="${settleMode === "currency"}">` +
          `${settleMode === "currency" ? SVG_TICK : ""}By currency</button>` +
        `</div>`;
    }

    if (settleMode === "converted") {
      if (m.led.unconverted.length) {
        // Which currency is missing, named, and the "I just got signal" button.
        const missing = [...new Set(m.rows.filter((r) => m.led.unconverted.includes(r.id)).map((r) => r.currency))].sort();
        const n = m.led.unconverted.length;
        out += `<div class="sp-banner"><p>No exchange rate for ${esc(missing.join(" or "))} yet. ` +
          `${countWord(n)} ${n === 1 ? "purchase isn't" : "purchases aren't"} counted until there is.</p>` +
          `<button type="button" class="ds-button ds-button--gray" data-act="fetch-rates">Fetch rates</button></div>`;
      }
      out += `<section class="sp-block" data-cur="">` +
        `<p class="sp-s-total"><span class="num">${esc(fmtMoney(m.led.total, m.exp, m.display, { approx: m.approx }))}</span> spent together.</p>` +
        planHtml(m.plan, m, m.display, m.exp, m.approx) +
        balancesHtml(m.led, m, m.display, m.exp, m.approx, "all") +
        paymentsHtml(m.rows.filter(isPayment), m) +
        `</section>`;
      if (m.rows.some((r) => r.currency !== m.display)) {
        out += `<p class="sp-fine">${m.fx.fetched_at ? `Converted at rates from ${esc(fmtAgo(m.fx.fetched_at))}.` : "No exchange rates yet. They come with the next signal."}</p>`;
      }
    } else {
      for (const c of currencies) {
        const sub = m.rows.filter((r) => r.currency === c);
        const e = expOf(c);
        const l2 = netBalances(sub, m.members.map((x) => x.id), { to: c, toExp: e, rates: {} });
        out += `<section class="sp-block" data-cur="${esc(c)}">` +
          `<h3 class="sp-block-head">${esc(nameOf(c) || c)} (${esc(c)})</h3>` +
          `<p class="sp-s-total"><span class="num">${esc(fmtMoney(l2.total, e, c))}</span> spent together.</p>` +
          planHtml(settleUp(l2.net), m, c, e, false) +
          balancesHtml(l2, m, c, e, false, c, { involvedOnly: true }) +
          paymentsHtml(sub.filter(isPayment), m) +
          `</section>`;
      }
    }
    out += `<button type="button" class="ds-button ds-button--gray ds-button--lg ds-button--block sp-record" data-act="record" data-sp="record">Record another payment</button>`;
    return out + `</div>`;
  }

  /**
   * The payments that settle everyone, the viewer's own first (what they pay, then what they're
   * paid), each with its Mark paid. "Two payments settle everyone."
   */
  function planHtml(trs, m, code, exp, approx) {
    const meId = m.me.id;
    if (!trs.length) return `<p class="sp-plan-sum" data-sp="plan-none">Everyone is settled up.</p>`;
    const rank = (t) => (t.from === meId ? 0 : t.to === meId ? 1 : 2);
    let out = `<ul class="sp-plan" data-sp="plan">`;
    for (const t of trs.slice().sort((x, y) => rank(x) - rank(y))) {
      const from = skinOf(m.members, t.from, meId);
      const to = skinOf(m.members, t.to, meId);
      const words = paysShortHtml(m.members, from, to, meId);
      // In Settle up settling is the job: your own payment's Mark paid is the filled one.
      out += `<li><span class="sp-tr-words">${words}</span>` +
        `<span class="num">${esc(fmtMoney(t.amount_minor, exp, code, { approx }))}</span>` +
        `<button type="button" class="ds-button sp-tr-go ${t.from === meId ? "ds-button--white" : "ds-button--gray"}" data-act="mark-paid" data-sp="plan-mark-paid" data-from="${esc(t.from)}" data-to="${esc(t.to)}"` +
          ` data-amount="${t.amount_minor}" data-cur="${esc(code)}" aria-label="Mark paid: ${esc(paysWords(from, to, meId))}">Mark paid</button></li>`;
    }
    out += `</ul><p class="sp-plan-sum">${countWord(trs.length)} ${trs.length === 1 ? "payment settles" : "payments settle"} everyone.</p>`;
    return out;
  }

  /**
   * Each person's balance: a name and a phrase ("is owed €60.00", "owes €30.00", "settled"). A
   * row opens to what makes it: "Paid €90.00. Share €30.00." and what was paid or got back.
   * `involvedOnly`: in one currency's block, only who paid or shared in it.
   */
  function balancesHtml(led, m, code, exp, approx, scope, { involvedOnly = false } = {}) {
    const meId = m.me.id;
    const f = (v) => fmtMoney(v, exp, code, { approx });
    let out = `<h3 class="sp-s-head">Balances</h3><div class="sp-bals">`;
    for (const mem of peopleOrder(m.members)) {
      const net = led.net.get(mem.id) || 0;
      const paid = led.paid.get(mem.id) || 0;
      const owed = led.owed.get(mem.id) || 0;
      const back = led.back.get(mem.id) || 0;
      const got = led.got.get(mem.id) || 0;
      if (involvedOnly && !paid && !owed && !back && !got) continue;
      if (isGone(mem) && !paid && !owed && !back && !got) continue;
      const you = mem.id === meId;
      const skin = skinOf(m.members, mem.id, meId);
      const amt = `<span class="num">${esc(f(net))}</span>`;
      const say = net > 0 ? `${you ? "are" : "is"} owed ${amt}` : net < 0 ? `${you ? "owe" : "owes"} ${amt}` : "settled";
      const key = `${scope}:${mem.id}`;
      const open = openBal.has(key);
      const id = `sp-why-${scope}-${mem.id}`.replace(/[^A-Za-z0-9_-]/g, "_");
      // The words in the reading face, every amount in the mono one.
      const n = (v) => `<span class="num">${esc(f(v))}</span>`;
      const why = `Paid ${n(paid)}. Share ${n(owed)}.` + (back ? ` Paid back ${n(back)}.` : "") + (got ? ` Got back ${n(got)}.` : "");
      out += `<div class="sp-balrow">` +
        markHtml(skin, 24) +
        `<button type="button" class="sp-bal" data-act="bal" data-key="${esc(key)}" data-sp="balance" data-id="${esc(mem.id)}"` +
          (net === 0 ? " data-settled" : "") +
            ` aria-expanded="${open}" aria-controls="${esc(id)}">` +
            `<span class="sp-bal-name">${esc(skin.label)}</span><span class="sp-bal-say">${say}</span>${SVG_CHEV_D}</button>` +
        `</div>` +
        `<p class="sp-bal-why" id="${esc(id)}"${open ? "" : " hidden"}>${why}</p>`;
    }
    return out + `</div>`;
  }

  /** The payments already made, newest first, in the feed's row style; each opens to correct it. */
  function paymentsHtml(list, m) {
    if (!list.length) return "";
    const o = { members: m.members, tz: m.tz, display: m.display, exp: m.exp, fx: m.fx, meId: m.me.id };
    let out = `<h3 class="sp-s-head">Paid already</h3>`;
    for (const p of list) {
      const from = skinOf(m.members, p.paid_by, o.meId);
      const to = skinOf(m.members, receiverOf(p), o.meId);
      out += `<button type="button" class="sp-row" data-kind="payment" data-act="payment" data-sp="paid-row" data-id="${esc(p.id)}">` +
        markHtml(from) +
        `<span class="sp-l1"><span class="sp-what">${esc(paidWords(from, to, o.meId))}</span>` +
        `<span class="sp-total">${esc(fmtMoney(p.amount_minor, p.amount_exp, p.currency))}</span></span>` +
        `<span class="sp-l2"><span class="sp-by">${esc(dayWords(toMs(p.spent_at), m.tz))}</span></span>` +
        `</button>`;
    }
    return out;
  }

  /** The currency totals are shown in, chosen from the menu in the head or in Settle up. */
  function setDisplay(code) {
    const list = enabledCurrencies(S);
    if (!list.includes(code) && !hasRate(S, code)) return;
    writePref(here(PREF_DISPLAY), code);
    // A code from the long picker stays in the head's short list on this phone.
    if (!list.includes(code)) rememberCurrency(code);
    scheduleRender();
  }

  /**
   * The head's menu (and Settle up's copy) ends in "Other currency…": choosing it puts the menu back on what is shown and
   * opens the long picker for totals. `after` repaints what holds the menu (Settle up's sheet).
   */
  function displayChanged(sel, after) {
    if (sel.value === "") {
      sel.value = displayCurrency(S, enabledCurrencies(S));
      openCurrencyPicker(null, { for: "display", after });
      return;
    }
    const shown = sel.closest(".sp-cur")?.querySelector(".sp-cur-v");
    if (shown) shown.textContent = sel.value;
    setDisplay(sel.value);
    if (after) after();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════
  // events
  // ══════════════════════════════════════════════════════════════════════════════════════

  root.addEventListener("click", (ev) => {
    const b = ev.target.closest("button") || ev.target.closest(".sp-balrow")?.querySelector(".sp-bal");
    if (!b || !root.contains(b)) return;
    if (b.dataset.act === "add") { openDrawer(null); return; }
    if (b.dataset.act === "settle") { openSettle(); return; }
    if (settleClick(b, ev, false)) return;
    // A row opens its sheet without navigating: sheets are not history entries, and #/split/:id
    // is for cold entry and links.
    const row = b.closest(".sp-row");
    if (row && !b.dataset.act) openDrawer(row.dataset.id);
  });
  root.addEventListener("change", (ev) => {
    if (ev.target.dataset && ev.target.dataset.act === "display") displayChanged(ev.target);
  });

  // Receipts: what waits on this phone, and its state on every row and in an open sheet.
  receipts.start(S);
  const offReceipts = receipts.onChange(() => {
    if (dead) return;
    const list = enabledCurrencies(S);
    if (dataSlice(S, displayCurrency(S, list)) !== slice) render();
    if (sheet && sheet.kind === "drawer" && !sheet.readOnly && sheet.wrap) paintReceipt(sheet);
  });

  /**
   * THE ONE MOMENT OF MOTION. When a purchase or payment is added, the rows below it move down to
   * make room, and once they have, the new row and the headline's new number appear together.
   * The arrival waits for the move, so the new row never draws over the row beneath it while the
   * list is still moving. Nothing holds a tap. Reduced motion: both simply appear.
   */
  // THE ONE MOMENT OF MOTION, on the design system's motion curve: the rows
  // already there move to make room (320 ms), then the new row arrives in its place (320 ms: up from just above, into
  // full ink), and a headline number that changed counts to its new value over those same 320 ms (ease out). Reduced
  // motion: the same result at once, no travel and no count.
  const DUR = 320;
  function countTo(num, from, to, exp, code, approx, delay) {
    const t0 = performance.now() + delay;
    const ease = (x) => 1 - Math.pow(1 - x, 3);
    const step = (now) => {
      if (dead || !num.isConnected) return;
      const x = Math.min(1, Math.max(0, (now - t0) / DUR));
      num.innerHTML = heroNum(Math.round(from + (to - from) * ease(x)), exp, code, approx);
      if (x < 1) requestAnimationFrame(step);
    };
    num.innerHTML = heroNum(from, exp, code, approx);
    requestAnimationFrame(step);
  }
  function changeWithMotion() {
    if (reducedMotion()) { render(); return; }
    const before = new Set([...feedEl.querySelectorAll("[data-key]")].map((e) => e.dataset.key));
    const was = heroEl.querySelector(".sp-hero-num");
    const old = was ? { minor: Number(was.dataset.minor), exp: was.dataset.exp, code: was.dataset.code } : null;
    flip(feedEl, () => render(), { enter: false, duration: DUR });
    const arrive = (e) => e.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }],
      { duration: DUR, delay: DUR, fill: "backwards", easing: "cubic-bezier(0.4, 0, 0.2, 1)" });
    for (const e of feedEl.querySelectorAll("[data-key]")) if (!before.has(e.dataset.key)) arrive(e);
    const num = heroEl.querySelector(".sp-hero-num");
    if (num && old && Number.isFinite(old.minor) && old.exp === num.dataset.exp && old.code === num.dataset.code
        && Number(num.dataset.minor) !== old.minor) {
      countTo(num, old.minor, Number(num.dataset.minor), Number(num.dataset.exp), num.dataset.code, "approx" in num.dataset, DUR);
    }
  }

  const offChange = S.on("change", () => {
    if (dead) return;
    const list = enabledCurrencies(S);
    if (dataSlice(S, displayCurrency(S, list)) === slice) return;
    changeWithMotion();
    // A sheet open over a changing feed follows it.
    if (sheet && sheet.kind === "settle") paintSettle(sheet);
  });

  // ── first paint, then the opportunistic rate fetch ───────────────────────────────────
  render();

  // "I just got signal, show me my totals": one request, only when the table is stale and a rate
  // would be used (a purchase in a currency other than the one shown), throttled across mounts.
  {
    const fx = S.fx() || { fetched_at: 0, next_at: 0 };
    const stale = !fx.fetched_at || (fx.next_at && Date.now() / 1000 >= fx.next_at);
    const list0 = enabledCurrencies(S);
    const shown = displayCurrency(S, list0);
    const wouldConvert = S.purchases().some((p) => p.currency !== shown);
    if (stale && wouldConvert && S.online() && Date.now() - lastRateTry > RATE_TRY_MS) {
      lastRateTry = Date.now();
      Promise.resolve(S.refreshRates()).catch(() => {});
    }
  }

  // ── deep link ────────────────────────────────────────────────────────────────────────
  // #/split/:id paints the feed and opens that purchase. `settle` is reserved (every real id starts
  // "pu-" or "pu_").
  let bounceTimer = 0;
  if (ctx.params && ctx.params.id) {
    const id = String(ctx.params.id);
    if (id === "settle") {
      openSettle();
    } else if (S.purchase(id)) {
      openDrawer(id);
    } else {
      toast("That purchase isn't on this phone.");
      // Deferred: the router is mid-way through awaiting this mount, and a synchronous replace()
      // would mount the next screen inside this one.
      bounceTimer = setTimeout(() => { if (!dead) router.replace("#/split"); }, 0);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════
  // unmount
  // ══════════════════════════════════════════════════════════════════════════════════════
  return () => {
    dead = true;
    offChange();
    offReceipts();
    wideMq.removeEventListener("change", onWide);
    cancelAnimationFrame(raf);
    clearTimeout(bounceTimer);
    // close(), never node.remove(): an open sheet holds the app `inert` while it is up. The
    // picker goes first because it is stacked on top.
    for (const slot of ["picker", "sheet"]) {
      const cur = slot === "picker" ? picker : sheet;
      if (!cur) continue;
      clearTimeout(cur.armTimer);
      if (slot === "picker") picker = null; else sheet = null;
      cur.api.close();
    }
    fab.remove();
    root.remove();
  };
}

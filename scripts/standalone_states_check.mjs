#!/usr/bin/env node
/* THE STANDALONE STATES + §8 CHECK — what scripts/standalone_check.mjs cannot see.
 *
 *   node scripts/standalone_states_check.mjs                    # every route, both themes
 *   node scripts/standalone_states_check.mjs --route=mem-collage --theme=dark
 *   node scripts/standalone_states_check.mjs --states-only      # skip the per-route §8 sweep
 *   node scripts/standalone_states_check.mjs --break=font       # self-test, must go RED
 *
 * WHY THIS EXISTS, next to standalone_check.mjs rather than inside it. That harness asks one
 * question — does the installed-PWA FRAMING hold: is anything under the status bar, does
 * everything clear the home indicator, is a 44px box eaten by an inset. It answers it at rest,
 * per route. Two whole families of the design contract were still unmeasured in the notched
 * render:
 *
 *   1. The app's design rules (§8 below), as a property of the RENDERED page rather than of the CSS source.
 *      §8.1 never opacity to quiet text · §8.2 >= 44px targets · §8.3 >= 12px fonts ·
 *      §8.4 no hue-only state. Insets do not change a font size, but they change what is on
 *      screen and what the shell paints behind it, and "measured in a browser tab in v2" is
 *      not the same claim as "measured in the standalone frame today".
 *   2. The states that only exist after an interaction, where a bottom inset is most likely
 *      to be wrong: a sheet at its open height, the chat's box under a shadowed keyboard,
 *      the photo viewer's own chrome, and the collage board — which is the sharp case,
 *      because it is the one surface in the app that MEASURES ITSELF from the scroller
 *      (memories.js sizeHost) instead of being laid out by flow.
 *
 * HOW §8.4 IS MEASURED. Hue-only is not a thing a DOM walk can see directly, so it is two
 * checks with a shared method — every colour is pushed through the Machado 2009 deuteranopia
 * matrix (severity 1.0) in linear RGB, the way §8.4's own 1.15:1 figure was produced:
 *   (a) every text/background pair must still clear 3:1 AFTER the simulation, so no piece of
 *       text depends on a hue difference to be readable;
 *   (b) every selected-vs-unselected pair in a live group (aria-selected / aria-pressed /
 *       aria-current / [data-sel]) must differ by something that is NOT colour — a glyph, a
 *       border, a weight, an underline, a size. A group whose only difference is a colour is
 *       reported with the properties that did differ, so the finding is actionable.
 *
 * TAP TARGETS honour the expander the codebase ships (§8.2): a control's hit box is the union
 * of its own rect and its ::before, when that pseudo is an absolutely-positioned inset overlay.
 * Measuring the visual box alone would flag every control that already has the fix.
 *
 * HOW TO MAKE IT GO RED. --break=<rule> injects one defect with !important:
 *   font        9px type in a note row              -> §8.3
 *   quiet       opacity .5 on note-row text         -> §8.1 (and the contrast checks with it)
 *   contrast    near-ground ink on the agenda        -> §8.1 contrast, and §8.4a with it
 *   whyless     each add sheet's disabled controls stripped of their reason        -> §8.1 a disabled control says why
 *   enabledgray an ENABLED control (Packing's Lists) in the disabled colour, --ink-4 -> §8.1 contrast
 *               (only a control that is disabled is exempt, not one that looks it)
 *   tap         a 28px control                       -> §8.2
 *   collage     the board host grows by the inset    -> the collage overhang check
 *   sheet       the sheet stops reserving the inset  -> the sheet-at-open-height checks
 *   kb          the chat's box re-anchored to 0      -> the keyboard checks
 * A --break run MUST exit 1. If it comes back green it exits 2 and says SELF-TEST BROKEN.
 *
 * BOOT is the same contract as standalone_check.mjs: the gate's own server and its made-up trip
 * (scripts/lib/gate_trip.mjs; run it with `node scripts/gate.mjs --only standalone_states`),
 * an --app window so display-mode is standalone, the four --sa-* tokens injected at
 * document-start, service worker bypassed. Needs the Bash sandbox disabled for Chrome.
 */
"use strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boot, evalIn, waitFor, sleep, BASE, REPO } from "./lib/standalone_cdp.mjs";
import { seedMemories, makeApi } from "./lib/seed_memories.mjs";
import { tripPath, tripApi } from "./lib/gate_trip.mjs";
import { pickPhotos, cdpPage, madePhoto } from "./lib/photo_picker.mjs";

// Its stills (--shots) go to WGP_SHOTS, or a temp folder: never the tree.
const OUT = process.env.WGP_SHOTS || path.join(os.tmpdir(), "wgp-standalone-states");

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const h = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  return h ? (h.includes("=") ? h.slice(h.indexOf("=") + 1) : true) : d;
};
const ONLY_ROUTE = arg("route");
const ONLY_THEME = arg("theme");
const SHOTS = !arg("no-shots");
const STATES_ONLY = !!arg("states-only");
const SWEEP_ONLY = !!arg("sweep-only");
const BREAK = arg("break");

// The notched profile is the one that matters here; the framing harness owns the sweep across
// devices. Same numbers, same single source of truth to correct after a device measurement.
const PROFILE = { id: "island-portrait", vw: 393, vh: 852, dsf: 2,
                  insets: { top: 59, right: 0, bottom: 34, left: 0 } };
// A shadowed keyboard in an installed PWA shrinks the LAYOUT viewport (unlike a Safari tab,
// where only the visual viewport moves). 336px is the iOS 15 Pro portrait keyboard with the
// prediction bar; the bottom inset goes to 0 while the keys cover it.
const KB_H = 336;

let pass = 0;
const failures = [];
function check(scope, name, ok, detail) {
  const label = `${scope} · ${name}`;
  if (ok) { pass++; if (process.env.WGP_VERBOSE) console.log(`  ok   ${label}${detail ? "  — " + detail : ""}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? "  -> " + String(detail).slice(0, 500) : ""}`); }
}

const V = `((n)=>document.querySelector('#view')?.dataset.route===n && document.querySelector('#view').children.length)`;
// A plan's page and a place's page are pages of THIS trip's own plan and place: asked of the
// server, never written here. (An id the trip doesn't have still "mounts": a page that says it
// isn't there, with no note field and nothing of a place to measure.)
const api = await makeApi();
const tripNow = (await api(tripApi())).json || {};
const aPlan = (tripNow.events || [])[0], aPlace = (tripNow.places || []).find((p) => p.picture || p.image_url) || (tripNow.places || [])[0];
if (!aPlan || !aPlace) { console.error("the trip has no plan or no place to open: this check needs one of each"); process.exit(2); }
const ROUTES = [
  { id: "agenda", hash: "#/", wait: `${V}('agenda')` },
  { id: "event", hash: `#/e/${encodeURIComponent(aPlan.id)}`, wait: `${V}('event') && document.querySelector('#view .ag-d-title')` },
  { id: "places", hash: "#/places", wait: `${V}('places')` },
  { id: "place", hash: `#/p/${encodeURIComponent(aPlace.id)}`, wait: `${V}('place') && document.querySelector('#view .pl-title')` },
  { id: "map", hash: "#/places?view=map", wait: `${V}('places') && document.querySelector('.mp-root')` },
  { id: "pack", hash: "#/pack", wait: `${V}('pack')` },
  { id: "mem-feed", hash: "#/memories", pre: { "wgp.memview": "feed" },
    wait: `${V}('memories') && document.querySelector('.me-stage[data-stage="feed"]:not([hidden]) .me-feed')` },
  { id: "mem-collage", hash: "#/memories", pre: { "wgp.memview": "collage" },
    wait: `${V}('memories') && document.querySelector('.me-stage[data-stage="collage"]:not([hidden])')?.children.length` },
  { id: "settings", hash: "#/settings", wait: `${V}('settings')` },
  { id: "credits", hash: "#/settings/credits", wait: `${V}('credits')` },
  { id: "login", url: "/login", shell: false, wait: `!!document.querySelector('.lg-wrap')` },
];
// The chat, for the keyboard state only (its §8 sweep is not this check's yet).
const CHAT_ROUTE = { id: "chat", hash: "#/chat", wait: `${V}('chat') && document.querySelector('.ch-box .ch-input')` };

// The text-carrier selector is deliberately generic (span/p/h2/h3 inside #view). A defect
// aimed at one route's class names looks surgical and proves nothing on the other eleven —
// the first draft of these two used .ag-note-body/.pl-name and came back GREEN on the agenda,
// which is a self-test that tests the selector rather than the check.
const TEXT_CARRIERS = "#view span,#view p,#view h2,#view h3,#view li,.lg-page span,.lg-page p";
const BREAKS = {
  font: `${TEXT_CARRIERS}{font-size:9px !important}`,
  quiet: `${TEXT_CARRIERS}{opacity:.55 !important}`,
  contrast: `#view,#view *{color:#efe9dd !important}`,
  enabledgray: `[data-act="managebags"]{color:var(--ink-4) !important}`,
  whyless: "/* no style: the add sheets' block strips the reasons itself */",
  tap: `.tabbar a:first-child,.tabbar button:first-child{height:28px !important;min-height:28px !important}`,
  collage: `.me-stage[data-stage="collage"]{height:600px !important}`,
  sheet: `.sh-sheet,.sh-body,.sh-foot{padding-bottom:0 !important}`,
  kb: `.ch-box{bottom:0 !important}`,
};

// ── the page-side §8 audit ───────────────────────────────────────────────────────────────
// One pass over the rendered document. Everything here is measured off getComputedStyle and
// getBoundingClientRect in the notched frame, never read out of the CSS source.
function AUDIT() {
  const R = { fonts: [], quiet: [], contrast: [], deut: [], taps: [], hueGroups: [], why: [],
              counted: { text: 0, interactive: 0, imageBacked: 0, groups: 0, disabledText: 0, disabled: 0 } };
  const cs = (e) => getComputedStyle(e);
  const px = (v) => Math.round(parseFloat(v) * 100) / 100 || 0;
  const sel = (e) => {
    const c = (e.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    return e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (c ? "." + c : "");
  };
  const vis = (e) => {
    const s = cs(e);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || "");
    if (!m) return null;
    const p = m[1].split(",").map((s) => parseFloat(s));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({                       // src-over composite, 0..255
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
  });
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const L1 = lum(a), L2 = lum(b); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); };
  // Machado et al. 2009, deuteranopia at severity 1.0, applied in LINEAR RGB. This is the
  // transform §8.4's 1.15:1 measurement came from.
  const deut = (c) => {
    const r = lin(c.r), g = lin(c.g), b = lin(c.b);
    const R2 = 0.367322 * r + 0.860646 * g - 0.227968 * b;
    const G2 = 0.280085 * r + 0.672501 * g + 0.047413 * b;
    const B2 = -0.011820 * r + 0.042940 * g + 0.968770 * b;
    const un = (v) => { v = Math.min(1, Math.max(0, v)); return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); };
    return { r: un(R2), g: un(G2), b: un(B2), a: 1 };
  };

  // effective background: composite every translucent layer down to the first opaque one.
  // A background-image anywhere in the stack means the real backdrop is pixels we cannot
  // compute — those are counted and skipped rather than guessed at.
  const bgOf = (e) => {
    const stack = [];
    for (let p = e; p; p = p.parentElement) {
      const s = cs(p);
      if (s.backgroundImage && s.backgroundImage !== "none") return { image: true };
      const c = parse(s.backgroundColor);
      if (!c || c.a === 0) continue;
      stack.push(c);
      if (c.a === 1) break;
    }
    if (!stack.length) return { image: false, color: { r: 255, g: 255, b: 255, a: 1 } };
    let out = stack[stack.length - 1];
    if (out.a < 1) out = over(out, { r: 255, g: 255, b: 255, a: 1 });
    for (let i = stack.length - 2; i >= 0; i--) out = over(stack[i], out);
    return { image: false, color: out };
  };

  const effOpacity = (e) => {
    let o = 1;
    for (let p = e; p && p !== document.documentElement; p = p.parentElement) o *= Number(cs(p).opacity);
    return o;
  };

  const hasOwnText = (e) => {
    for (const n of e.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true;
    return false;
  };

  // ── §8.1 / §8.3 / §8.4a: every element that renders its own text ──────────────────────
  for (const e of document.querySelectorAll("body *")) {
    if (!hasOwnText(e) || !vis(e)) continue;
    R.counted.text++;
    const s = cs(e);
    const size = px(s.fontSize);
    const weight = Number(s.fontWeight) || 400;
    if (size < 12 - 0.01) R.fonts.push({ sel: sel(e), size, text: e.textContent.trim().slice(0, 24) });
    const op = effOpacity(e);
    if (op < 0.999) R.quiet.push({ sel: sel(e), opacity: Math.round(op * 100) / 100, text: e.textContent.trim().slice(0, 24) });
    // A DISABLED control's words are exempt from the contrast floors, as WCAG has it (20 Nov):
    // the system's disabled look is its gray step and --ink-4. One that only looks disabled is still held to them.
    if (e.closest(":disabled, [aria-disabled='true']")) { R.counted.disabledText++; continue; }
    const fg = parse(s.color);
    const bg = bgOf(e);
    if (!fg || bg.image) { if (bg.image) R.counted.imageBacked++; continue; }
    // The element's own opacity is already a §8.1 failure above; fold it into the colour so
    // the contrast number is what the eye gets, not what the token promises.
    const ink = over({ ...fg, a: fg.a * op }, bg.color);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const rt = ratio(ink, bg.color);
    if (rt < need - 0.01) R.contrast.push({ sel: sel(e), size, ratio: Math.round(rt * 100) / 100, need, text: e.textContent.trim().slice(0, 24) });
    // §8.4a — the same pair with the hue axis removed. 3:1 is the floor for "still readable
    // when the colour difference is gone"; text that only clears 4.5 because of hue lands here.
    const dr = ratio(deut(ink), deut(bg.color));
    if (dr < 3 - 0.01) R.deut.push({ sel: sel(e), ratio: Math.round(dr * 100) / 100, plain: Math.round(rt * 100) / 100, text: e.textContent.trim().slice(0, 24) });
  }

  // ── §8.1, its other half: a DISABLED control says why, in words ─────────────────────────
  // Exempt from the contrast floor (above), a disabled control may not leave a person guessing: it carries its reason as
  // an aria-description, or names it with aria-describedby (the reason on the screen, or kept for a screen reader).
  const saysWhy = (e) => {
    if ((e.getAttribute("aria-description") || "").trim()) return true;
    return (e.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean)
      .some((id) => { const r = document.getElementById(id); return !!r && !!(r.textContent || "").trim(); });
  };
  for (const e of document.querySelectorAll("button:disabled, input:disabled:not([type='hidden']), select:disabled, textarea:disabled, [aria-disabled='true']")) {
    if (!vis(e)) continue;
    R.counted.disabled++;
    if (!saysWhy(e)) R.why.push({ sel: sel(e), text: (e.textContent || e.getAttribute("aria-label") || e.placeholder || "").trim().slice(0, 30) });
  }

  // ── §8.2: 44px targets, expander included ────────────────────────────────────────────
  const INTERACTIVE = 'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="tab"],[role="switch"],[tabindex]:not([tabindex="-1"])';
  for (const e of document.querySelectorAll(INTERACTIVE)) {
    if (!vis(e) || e.disabled) continue;
    R.counted.interactive++;
    const r = e.getBoundingClientRect();
    let w = r.width, h = r.height;
    // the ::before expander the codebase ships: position:absolute + negative inset
    for (const pseudo of ["::before", "::after"]) {
      const ps = getComputedStyle(e, pseudo);
      if (!ps || ps.content === "none" || ps.position !== "absolute") continue;
      const t = parseFloat(ps.top), b = parseFloat(ps.bottom), l = parseFloat(ps.left), rr = parseFloat(ps.right);
      if ([t, b, l, rr].some((v) => Number.isNaN(v))) continue;
      // negative offsets grow the box outward on that side
      h = Math.max(h, r.height + Math.max(0, -t) + Math.max(0, -b));
      w = Math.max(w, r.width + Math.max(0, -l) + Math.max(0, -rr));
    }
    // An inline link inside a paragraph is text, not a control with a box — §8.2 is about
    // controls. Only elements that are their own block/flex box are judged.
    const disp = cs(e).display;
    if (disp === "inline" && e.tagName === "A" && e.closest("p,li,.ag-note-body")) continue;
    if (Math.min(w, h) < 44 - 0.5) {
      R.taps.push({ sel: sel(e), w: px(w), h: px(h), label: (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 24) });
    }
  }

  // ── §8.4b: a selected state must differ by more than colour ───────────────────────────
  // Find live groups: a parent holding both a selected and an unselected sibling of the same
  // kind. Compare their computed styles and require at least one non-colour difference.
  const SELECTED = '[aria-selected="true"],[aria-pressed="true"],[aria-current]:not([aria-current="false"]),[data-sel="1"]';
  const NON_COLOUR = ["fontWeight", "borderTopStyle", "borderBottomStyle", "borderTopWidth",
    "borderBottomWidth", "borderLeftWidth", "borderRightWidth", "textDecorationLine",
    "fontSize", "boxShadow", "transform", "outlineStyle", "outlineWidth"];
  const seen = new Set();
  for (const on of document.querySelectorAll(SELECTED)) {
    if (!vis(on) || !on.parentElement) continue;
    const sibs = [...on.parentElement.children].filter((x) => x !== on && x.tagName === on.tagName && vis(x));
    const off = sibs.find((x) => !x.matches(SELECTED));
    if (!off) continue;
    const key = sel(on.parentElement) + ">" + on.tagName;
    if (seen.has(key)) continue;
    seen.add(key);
    R.counted.groups++;
    const a = cs(on), b = cs(off);
    const diffs = NON_COLOUR.filter((p) => a[p] !== b[p]);
    // a glyph that is present on one and absent on the other is a shape signal too
    const glyphA = on.querySelectorAll("svg,.ico").length, glyphB = off.querySelectorAll("svg,.ico").length;
    if (glyphA !== glyphB) diffs.push("glyph-count");
    // ...as is a check mark or any text that one carries and the other does not
    if (on.textContent.trim() !== off.textContent.trim()
        && on.textContent.trim().replace(/\d+/g, "") !== off.textContent.trim().replace(/\d+/g, "")) diffs.push("text");
    if (!diffs.length) {
      const colourDiffs = ["color", "backgroundColor", "borderTopColor"].filter((p) => a[p] !== b[p]);
      R.hueGroups.push({ group: key, on: sel(on), off: sel(off), colourOnly: colourDiffs.join(",") || "identical" });
    }
  }
  return R;
}

// ── state probes, each measuring one thing the rest-state sweep cannot reach ─────────────
function COLLAGE_GEOM() {
  const view = document.querySelector("#view");
  const stage = document.querySelector('.me-stage[data-stage="collage"]:not([hidden])');
  if (!view || !stage) return null;
  const cs = (e) => getComputedStyle(e);
  const px = (v) => Math.round(parseFloat(v) * 100) / 100 || 0;
  const vr = view.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const items = [...stage.querySelectorAll(".cl-item,.cl-photo,figure,img")]
    .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 2 && r.height > 2);
  const root = getComputedStyle(document.documentElement);
  return {
    vh: window.innerHeight,
    insetBottom: px(root.getPropertyValue("--sa-bottom")),
    tabbarSpace: (() => {            // getPropertyValue hands back the raw calc(); resolve it
      const p = document.createElement("div");
      p.style.cssText = "position:absolute;visibility:hidden;height:var(--tabbar-space)";
      document.body.appendChild(p);
      const h = px(getComputedStyle(p).height); p.remove(); return h;
    })(),
    view: { top: px(vr.top), bottom: px(vr.bottom), clientHeight: view.clientHeight,
            padTop: px(cs(view).paddingTop), padBottom: px(cs(view).paddingBottom),
            scrollHeight: view.scrollHeight },
    stage: { top: px(sr.top), bottom: px(sr.bottom), height: px(sr.height),
             styleHeight: stage.style.height || "(none)", offsetTop: stage.offsetTop,
             offsetParent: stage.offsetParent ? stage.offsetParent.className || stage.offsetParent.tagName : null },
    board: stage.querySelector(".cl-root,.cl-board") ? "mounted" : "none",
    items: items.length,
    lowestItem: items.length ? Math.round(Math.max(...items.map((r) => r.bottom)) * 100) / 100 : null,
    highestItem: items.length ? Math.round(Math.min(...items.map((r) => r.top)) * 100) / 100 : null,
  };
}

function SHEET_GEOM() {
  const root = document.querySelector(".sh-root");
  if (!root) return null;
  const cs = (e) => getComputedStyle(e);
  const px = (v) => Math.round(parseFloat(v) * 100) / 100 || 0;
  const pick = (s) => { const e = root.querySelector(s); if (!e) return null;
    const r = e.getBoundingClientRect();
    return { sel: s, top: px(r.top), bottom: px(r.bottom), h: px(r.height),
             padBottom: px(cs(e).paddingBottom), padTop: px(cs(e).paddingTop) }; };
  const vis = (e) => { const s = cs(e); if (s.display === "none" || s.visibility === "hidden") return false;
    const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const ctrls = [...root.querySelectorAll('a[href],button,input,select,textarea,[role="button"]')]
    .filter(vis).map((e) => { const r = e.getBoundingClientRect();
      return { sel: (e.className || e.tagName).toString().split(/\s+/)[0], top: px(r.top), bottom: px(r.bottom), w: px(r.width), h: px(r.height) }; });
  const rr = root.getBoundingClientRect();
  const dsRoot = getComputedStyle(document.documentElement);
  return {
    vh: window.innerHeight,
    insetTop: px(dsRoot.getPropertyValue("--sa-top")),
    insetBottom: px(dsRoot.getPropertyValue("--sa-bottom")),
    root: { top: px(rr.top), bottom: px(rr.bottom), pos: cs(root).position },
    card: pick(".sh-sheet"), body: pick(".sh-body"), foot: pick(".sh-foot"), handle: pick(".sh-grab"),
    controls: ctrls,
    lowestControl: ctrls.length ? Math.max(...ctrls.map((c) => c.bottom)) : null,
    smallest: ctrls.length ? Math.min(...ctrls.map((c) => Math.min(c.w, c.h))) : null,
  };
}

function COMPOSER_GEOM() {
  const comp = document.querySelector(".ch-box");
  const cs = (e) => getComputedStyle(e);
  const px = (v) => Math.round(parseFloat(v) * 100) / 100 || 0;
  const root = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const tb = document.querySelector(".tabbar");
  const out = {
    vh: window.innerHeight,
    kbFlag: document.body.dataset.kb,
    kbH: px(root.getPropertyValue("--kb-h")),
    insetBottom: px(root.getPropertyValue("--sa-bottom")),
    tabbarSpace: (() => {
      const p = document.createElement("div");
      p.style.cssText = "position:absolute;visibility:hidden;height:var(--tabbar-space)";
      document.body.appendChild(p);
      const h = px(getComputedStyle(p).height); p.remove(); return h;
    })(),
    tabbar: tb ? { top: px(tb.getBoundingClientRect().top), bottom: px(tb.getBoundingClientRect().bottom),
                   display: cs(tb).display, transform: cs(tb).transform } : null,
  };
  if (comp) {
    const r = comp.getBoundingClientRect();
    out.comp = { top: px(r.top), bottom: px(r.bottom), h: px(r.height), pos: cs(comp).position, padBottom: px(cs(comp).paddingBottom) };
    const ta = comp.querySelector(".ch-input"), send = comp.querySelector(".ch-send");
    if (ta) { const q = ta.getBoundingClientRect(); out.field = { top: px(q.top), bottom: px(q.bottom), h: px(q.height), w: px(q.width) }; }
    if (send) {
      const q = send.getBoundingClientRect();
      // §8.2's sanctioned expander: ::before{position:absolute;inset:-Npx}. The hit box is the
      // union, so a 34px button with a 5px expander is the 44px target the rule asks for.
      let hw = q.width, hh = q.height;
      const ps = getComputedStyle(send, "::before");
      if (ps && ps.content !== "none" && ps.position === "absolute") {
        const t = parseFloat(ps.top), b = parseFloat(ps.bottom), l = parseFloat(ps.left), r2 = parseFloat(ps.right);
        if (![t, b, l, r2].some(Number.isNaN)) {
          hh = q.height + Math.max(0, -t) + Math.max(0, -b);
          hw = q.width + Math.max(0, -l) + Math.max(0, -r2);
        }
      }
      out.send = { top: px(q.top), bottom: px(q.bottom), h: px(q.height), w: px(q.width), hitW: px(hw), hitH: px(hh) };
    }
    out.focused = document.activeElement === ta;
  }
  return out;
}

function VIEWER_GEOM() {
  const v = document.querySelector(".me-view");
  if (!v) return null;
  const cs = (e) => getComputedStyle(e);
  const px = (n) => Math.round(n * 100) / 100;
  const vis = (e) => { const s = cs(e); if (s.display === "none" || s.visibility === "hidden") return false;
    const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const ctrls = [...v.querySelectorAll('button,a[href],[role="button"]')].filter(vis).map((e) => {
    const r = e.getBoundingClientRect();
    return { sel: (e.className || e.tagName).toString().split(/\s+/)[0], top: px(r.top), bottom: px(r.bottom), w: px(r.width), h: px(r.height) };
  });
  const root = getComputedStyle(document.documentElement);
  const band = (s2) => { const e = v.querySelector(s2); if (!e || !vis(e)) return null;
    const r = e.getBoundingClientRect();
    return { top: px(r.top), bottom: px(r.bottom), padBottom: px(parseFloat(cs(e).paddingBottom) || 0),
             padTop: px(parseFloat(cs(e).paddingTop) || 0) }; };
  return { vh: window.innerHeight, insetTop: px(parseFloat(root.getPropertyValue("--sa-top")) || 0),
           insetBottom: px(parseFloat(root.getPropertyValue("--sa-bottom")) || 0),
           topBand: band(".me-vtop"), bottomBand: band(".me-vbottom"),
           controls: ctrls,
           topmost: ctrls.length ? Math.min(...ctrls.map((c) => c.top)) : null,
           lowest: ctrls.length ? Math.max(...ctrls.map((c) => c.bottom)) : null,
           smallest: ctrls.length ? Math.min(...ctrls.map((c) => Math.min(c.w, c.h))) : null };
}

(async () => {
  const probe = await fetch(BASE + tripPath()).catch(() => null);
  if (!probe) throw new Error(`no server answers on ${BASE}`);
  if (BREAK && !BREAKS[BREAK]) throw new Error(`unknown --break=${BREAK}; try ${Object.keys(BREAKS).join(" | ")}`);
  if (BREAK) console.log(`SELF-TEST: injecting the "${BREAK}" defect — this run MUST fail`);

  const themes = ONLY_THEME ? [ONLY_THEME] : ["light", "dark"];
  const routes = ROUTES.filter((r) => (ONLY_ROUTE ? r.id === ONLY_ROUTE : true));

  // ── content, because three of the twelve routes are otherwise EMPTY ───────────────────
  // The local D1 holds no memories (every suite that touches them seeds and deletes), so
  // #/memories renders three empty states and a collage board with nothing on it. An empty
  // board cannot overhang the home indicator, so measuring one proves nothing at all. Seed
  // first, delete in the finally — a check that counts rows breaks on a leftover.
  const before = await api(tripApi("/memories"));
  const preexisting = (before.json && before.json.memories || []).length;
  if (preexisting) console.log(`  note: ${preexisting} memory row(s) already in this D1 — seeding on top of them`);
  const seed = SWEEP_ONLY && ONLY_ROUTE && !/^mem-/.test(ONLY_ROUTE)
    ? { ids: [], cleanup: async () => {} }
    : await seedMemories(6);
  if (seed.ids.length) console.log(`  seeded ${seed.ids.length} memories for the run; they are deleted at the end`);

  const B = await boot({ vw: PROFILE.vw, vh: PROFILE.vh, dsf: PROFILE.dsf });
  const { cdp, S } = B;
  await B.setInsets(PROFILE.insets, BREAK ? BREAKS[BREAK] : "");
  if (SHOTS) fs.mkdirSync(OUT, { recursive: true });

  const local = {};
  let nav = 0;
  async function ensureLocal(kv) {
    let need = false;
    for (const [k, v] of Object.entries(kv)) if (local[k] !== v) { local[k] = v; need = true; }
    if (!need) return;
    const origin = await evalIn(cdp, S, `location.origin`).catch(() => "");
    if (!/127\.0\.0\.1/.test(String(origin))) {
      await cdp.send("Page.navigate", { url: `${BASE}/login?boot=${++nav}` }, S);
      await waitFor(cdp, S, `document.readyState!=='loading' ? 1 : null`, { label: "boot page" });
    }
    await evalIn(cdp, S, Object.entries(local)
      .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)})`).join(";") + ";1");
  }
  async function go(route, theme) {
    await ensureLocal({ "wgp.theme": theme, ...(route.pre || {}) });
    for (let a = 0; a < 2; a++) {
      const url = route.url ? `${BASE}${route.url}?st=${++nav}` : `${BASE}${tripPath()}?st=${++nav}${route.hash}`;
      await cdp.send("Page.navigate", { url }, S);
      await waitFor(cdp, S, `document.readyState==='complete' ? 1 : null`, { label: "load" });
      try { await waitFor(cdp, S, `(${route.wait}) ? 1 : null`, { label: route.id + " mount" }); break; }
      catch { if (a === 1) return false; }
    }
    await evalIn(cdp, S, `Promise.race([Promise.all([...document.images].filter(i=>!i.complete).map(i=>new Promise(r=>{i.onload=i.onerror=r}))),new Promise(r=>setTimeout(r,3500))]).then(()=>1)`);
    await sleep(350);
    return true;
  }

  // ══ 1. the §8 sweep, in the notched frame ═════════════════════════════════════════════
  const tally = { text: 0, interactive: 0, groups: 0, imageBacked: 0 };
  let worstContrast = { ratio: 99, sel: "-", scope: "-" }, worstDeut = { ratio: 99, sel: "-", scope: "-" };
  let smallestFont = { size: 99, sel: "-", scope: "-" }, smallestTap = { min: 999, sel: "-", scope: "-" };
  if (!STATES_ONLY) {
    for (const theme of themes) {
      for (const route of routes) {
        const scope = `§8/${theme}/${route.id}`;
        const ok = await go(route, theme);
        check(scope, "route mounts", ok);
        if (!ok) continue;
        const a = await evalIn(cdp, S, `(${AUDIT})()`);
        for (const k of Object.keys(tally)) tally[k] += a.counted[k] || 0;
        check(scope, "§8.3 every rendered font is >= 12px", a.fonts.length === 0,
          a.fonts.map((f) => `${f.sel} ${f.size}px "${f.text}"`).join("; "));
        check(scope, "§8.1 no text is quieted with opacity", a.quiet.length === 0,
          a.quiet.map((q) => `${q.sel} opacity=${q.opacity} "${q.text}"`).join("; "));
        check(scope, "§8.1 a disabled control says why in words (aria-description, or aria-describedby naming the reason)", a.why.length === 0,
          a.why.map((w) => `${w.sel} "${w.text}"`).join("; "));
        check(scope, "§8.1 text clears its contrast floor", a.contrast.length === 0,
          a.contrast.map((c) => `${c.sel} ${c.ratio}:1 (needs ${c.need}) "${c.text}"`).join("; "));
        check(scope, "§8.4 text survives deuteranopia at >= 3:1", a.deut.length === 0,
          a.deut.map((d) => `${d.sel} ${d.ratio}:1 deut (${d.plain}:1 plain) "${d.text}"`).join("; "));
        check(scope, "§8.2 every control is >= 44px (expander included)", a.taps.length === 0,
          a.taps.map((t) => `${t.sel} ${t.w}x${t.h} "${t.label}"`).join("; "));
        check(scope, "§8.4 no selected state is signalled by colour alone", a.hueGroups.length === 0,
          a.hueGroups.map((g) => `${g.group}: only ${g.colourOnly}`).join("; "));
        // running extremes, so the report carries a number and not just "none failed"
        for (const c of a.contrast) if (c.ratio < worstContrast.ratio) worstContrast = { ...c, scope };
        for (const d of a.deut) if (d.ratio < worstDeut.ratio) worstDeut = { ...d, scope };
        for (const f of a.fonts) if (f.size < smallestFont.size) smallestFont = { ...f, scope };
        for (const t of a.taps) if (Math.min(t.w, t.h) < smallestTap.min) smallestTap = { min: Math.min(t.w, t.h), sel: t.sel, scope };
      }
    }
  }

  // ══ 2. the states ═════════════════════════════════════════════════════════════════════
  if (!SWEEP_ONLY) {
    const safeBottom = PROFILE.vh - PROFILE.insets.bottom;
    for (const theme of themes) {
      // ── the collage board: the one surface that sizes ITSELF from the scroller ─────────
      {
        const scope = `state/${theme}/collage-height`;
        const ok = await go(ROUTES.find((r) => r.id === "mem-collage"), theme);
        check(scope, "collage mounts", ok);
        if (ok) {
          await sleep(600);
          const g = await evalIn(cdp, S, `(${COLLAGE_GEOM})()`);
          check(scope, "the board is mounted with items", !!g && g.items > 0, g ? `items=${g.items} board=${g.board}` : "no stage");
          if (g) {
            // THE BOARD'S STAGE (its wall) REACHES THE TAB BAR, and not one pixel further. It bleeds out
            // of #view's gutter on three sides (memories.js sizeHost) because that is the rule:
            // the bottom of the wall touches the top of the tab bar and its
            // sides touch the edges of the device. #view's own bottom border edge IS
            // that tab bar edge — <body> is a flex column of #view then .tabbar — so the target
            // is g.view.bottom. This check used to hold the board above #view's CONTENT floor
            // instead, which now describes a board with a 32px strip of page left under it.
            // The failure it was written for has not gone anywhere, it moved one line down:
            // sizeHost() takes scroller.clientHeight, which INCLUDES that bottom padding, and
            // the board is only allowed to spend it because a negative bottom margin hands it
            // back. Height and margin have to move together, and "does not scroll" below is the
            // half that catches the margin going missing while this one catches the height.
            check(scope, "the board's stage (its wall) reaches the tab bar and stops there",
              Math.abs(g.stage.bottom - g.view.bottom) <= 0.5,
              `stage bottom=${g.stage.bottom} tab bar top (= #view bottom)=${g.view.bottom} (view padBottom=${g.view.padBottom}, tabbar-space=${g.tabbarSpace}) styleHeight=${g.stage.styleHeight}`);
            check(scope, "no photo is drawn under the home indicator",
              g.lowestItem === null || g.lowestItem <= safeBottom + 0.5,
              `lowest item bottom=${g.lowestItem} safe bottom=${safeBottom}`);
            check(scope, "no photo is drawn under the status bar",
              g.highestItem === null || g.highestItem >= PROFILE.insets.top - 0.5,
              `highest item top=${g.highestItem} inset=${PROFILE.insets.top}`);
            // ...and the opposite failure: an inset-shortened board that wastes the screen.
            const usable = (g.view.bottom - g.view.padBottom) - g.stage.top;
            check(scope, "the board is not left short of the space it has",
              g.stage.height >= usable - 12,
              `stage height=${g.stage.height} usable=${Math.round(usable * 100) / 100}`);
            check(scope, "the collage page does not scroll (the board owns the viewport)",
              g.view.scrollHeight <= g.view.clientHeight + 2,
              `scrollHeight=${g.view.scrollHeight} clientHeight=${g.view.clientHeight}`);
            console.log(`    collage/${theme}: stage ${g.stage.top}..${g.stage.bottom} h=${g.stage.height} (style ${g.stage.styleHeight}), view pad ${g.view.padTop}/${g.view.padBottom}, items ${g.items}, lowest ${g.lowestItem}, safe bottom ${safeBottom}`);
          }
          if (SHOTS) await B.shot(path.join(OUT, `chk-collage-${theme}.png`));
        }
      }

      // ── a sheet at its open height ───────────────────────────────────────────────────
      {
        const scope = `state/${theme}/pack-sheet`;
        const ok = await go(ROUTES.find((r) => r.id === "pack"), theme);
        check(scope, "pack mounts", ok);
        if (ok) {
          const opened = await evalIn(cdp, S, `(()=>{const b=document.querySelector('[data-act="managebags"]'); if(!b) return 0; b.click(); return 1})()`);
          check(scope, "the Bags sheet opens", !!opened);
          if (opened) {
            await waitFor(cdp, S, `document.querySelector('.sh-root') ? 1 : null`, { label: "sheet" });
            await sleep(500);
            const g = await evalIn(cdp, S, `(${SHEET_GEOM})()`);
            check(scope, "the sheet reserves the home indicator",
              !!g && g.lowestControl !== null && g.lowestControl <= safeBottom + 0.5,
              g ? `lowest control bottom=${g.lowestControl} safe bottom=${safeBottom}` : "no sheet");
            check(scope, "the sheet's card does not overhang the viewport",
              !!g && g.card && g.card.bottom <= g.vh + 0.5, g && g.card ? `card bottom=${g.card.bottom} vh=${g.vh}` : "no card");
            check(scope, "the sheet's own bottom padding carries the inset",
              !!g && ((g.foot && g.foot.padBottom >= g.insetBottom - 0.5)
                   || (g.body && g.body.padBottom >= g.insetBottom - 0.5)
                   || (g.card && g.card.padBottom >= g.insetBottom - 0.5)),
              g ? `card padB=${g.card && g.card.padBottom} body padB=${g.body && g.body.padBottom} foot padB=${g.foot && g.foot.padBottom} inset=${g.insetBottom}` : "-");
            check(scope, "the sheet's top clears the status bar",
              !!g && g.card && g.card.top >= g.insetTop - 0.5,
              g && g.card ? `card top=${g.card.top} inset=${g.insetTop}` : "-");
            check(scope, "§8.2 holds inside the open sheet",
              !!g && (g.smallest === null || g.smallest >= 43.5),
              g ? `smallest control ${g.smallest}px` : "-");
            if (g) console.log(`    sheet/${theme}: card ${g.card && g.card.top}..${g.card && g.card.bottom}, ${g.controls.length} controls, lowest ${g.lowestControl}, safe bottom ${safeBottom}`);
            if (SHOTS) await B.shot(path.join(OUT, `chk-sheet-${theme}.png`));
          }
        }
      }

      // ── each add sheet, as its + opens it: a disabled control in it says why ──────────────
      // (An add sheet's action waits for what it needs; that is where a disabled control most often stands.)
      for (const r of [ROUTES.find((x) => x.id === "agenda"), ROUTES.find((x) => x.id === "places"), ROUTES.find((x) => x.id === "pack"),
        ROUTES.find((x) => x.id === "mem-feed"), { id: "split", hash: "#/split", wait: `${V}('split')` }]) {
        const scope = `state/${theme}/${r.id}-add`;
        if (!(await go(r, theme))) { check(scope, `${r.id} mounts`, false); continue; }
        // The + is the .fab: the quick reference's button on the left is a .ds-fab too (js/references.js), and isn't an add.
        const FAB = `[...document.querySelectorAll('.fab.ds-fab')].find((x)=>x.getClientRects().length)`;
        // Photos' + opens the phone's picker first; answered with a made-up photo, its add sheet opens.
        const opened = r.id === "mem-feed"
          ? await pickPhotos({ ...cdpPage(cdp, S), open: FAB, files: [madePhoto()] }).then(() => 1, () => 0)
          : await evalIn(cdp, S, `(()=>{const b=${FAB}; if(!b) return 0; b.click(); return 1})()`);
        check(scope, "its + opens its add sheet", !!opened);
        if (!opened) continue;
        try { await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1']") ? 1 : null`, { label: `${r.id} add sheet` }); }
        catch { check(scope, "its add sheet is open", false); continue; }
        await sleep(500);
        if (BREAK === "whyless") await evalIn(cdp, S, `(document.querySelectorAll(":disabled, [aria-disabled='true']").forEach((e) => { e.removeAttribute("aria-description"); e.removeAttribute("aria-describedby"); }), 1)`);
        const a = await evalIn(cdp, S, `(${AUDIT})()`);
        check(scope, "§8.1 a disabled control says why in words (aria-description, or aria-describedby naming the reason)", a.why.length === 0,
          `${a.counted.disabled} disabled; ` + a.why.map((w) => `${w.sel} "${w.text}"`).join("; "));
      }

      // ── the chat's box, with a shadowed keyboard ─────────────────────────────────────
      // The app's one composer since the notes became the chat's messages (migration 0027: a
      // plan's page lists what was said about it, and has no box of its own).
      {
        const scope = `state/${theme}/composer-keyboard`;
        const ok = await go(CHAT_ROUTE, theme);
        check(scope, "chat mounts", ok);
        if (ok) {
          const rest = await evalIn(cdp, S, `(${COMPOSER_GEOM})()`);
          check(scope, "the composer exists and clears the home indicator at rest",
            !!rest.comp && rest.comp.bottom <= safeBottom + 0.5,
            rest.comp ? `bottom=${rest.comp.bottom} safe bottom=${safeBottom}` : "no .ch-box");
          check(scope, "§8.2 the send button is a 44px target",
            !!rest.send && Math.min(rest.send.hitW, rest.send.hitH) >= 43.5,
            rest.send ? `${rest.send.w}x${rest.send.h} visual, ${rest.send.hitW}x${rest.send.hitH} with the expander` : "no send button");

          // An installed PWA gets a shrunk LAYOUT viewport when the keyboard opens (a Safari
          // tab moves only the visual viewport — different geometry, covered by --kb-h).
          // Shrink the metrics, then focus: that is the order iOS uses.
          await B.metrics(PROFILE.vw, PROFILE.vh - KB_H, PROFILE.dsf);
          await evalIn(cdp, S, `(()=>{const t=document.querySelector('.ch-input'); if(!t) return 0; t.focus(); t.dispatchEvent(new Event('focus')); return 1})()`);
          await sleep(700);
          const kb = await evalIn(cdp, S, `(${COMPOSER_GEOM})()`);
          check(scope, "the keyboard state is entered", kb.vh === PROFILE.vh - KB_H && !!kb.focused,
            `vh=${kb.vh} focused=${kb.focused} data-kb=${kb.kbFlag}`);
          check(scope, "the composer sits on the keyboard's top edge, not under it",
            !!kb.comp && kb.comp.bottom <= kb.vh + 0.5 && kb.comp.bottom >= kb.vh - 40,
            kb.comp ? `composer bottom=${kb.comp.bottom} keyboard top=${kb.vh}` : "-");
          check(scope, "the text field is on screen with the keyboard up",
            !!kb.field && kb.field.top >= PROFILE.insets.top - 0.5 && kb.field.bottom <= kb.vh + 0.5,
            kb.field ? `field ${kb.field.top}..${kb.field.bottom} band ${PROFILE.insets.top}..${kb.vh}` : "-");
          check(scope, "the send button stays a 44px target with the keyboard up",
            !!kb.send && Math.min(kb.send.hitW, kb.send.hitH) >= 43.5,
            kb.send ? `${kb.send.w}x${kb.send.h} visual, ${kb.send.hitW}x${kb.send.hitH} with the expander` : "-");
          console.log(`    composer/${theme}: rest bottom=${rest.comp && rest.comp.bottom} (safe ${safeBottom}) · kb vh=${kb.vh} composer=${kb.comp && kb.comp.top}..${kb.comp && kb.comp.bottom} field=${kb.field && kb.field.top}..${kb.field && kb.field.bottom} data-kb=${kb.kbFlag} tabbar-space=${kb.tabbarSpace}`);
          if (SHOTS) await B.shot(path.join(OUT, `chk-composer-kb-${theme}.png`));
          await evalIn(cdp, S, `(()=>{document.activeElement && document.activeElement.blur(); return 1})()`);
          await B.metrics(PROFILE.vw, PROFILE.vh, PROFILE.dsf);
          await sleep(300);
        }
      }

      // ── the photo viewer, which draws its own chrome over the whole screen ────────────
      {
        const scope = `state/${theme}/photo-viewer`;
        const ok = await go(ROUTES.find((r) => r.id === "mem-feed"), theme);
        if (ok) {
          const opened = await evalIn(cdp, S, `(()=>{const t=document.querySelector('.me-feed img, .me-feed [data-mid]'); if(!t) return 0; t.click(); return 1})()`);
          if (!opened) { check(scope, "a photo is available to open", false, "no tile in the feed"); }
          else {
            await sleep(900);
            const g = await evalIn(cdp, S, `(${VIEWER_GEOM})()`);
            if (!g) { check(scope, "the viewer opens", false, "no viewer root"); }
            else {
              check(scope, "the viewer opens with controls", g.controls.length > 0, `${g.controls.length} controls`);
              check(scope, "viewer chrome clears the status bar",
                g.topmost === null || g.topmost >= g.insetTop - 0.5, `topmost control top=${g.topmost} inset=${g.insetTop}`);
              check(scope, "viewer chrome clears the home indicator",
                g.lowest === null || g.lowest <= safeBottom + 0.5, `lowest control bottom=${g.lowest} safe bottom=${safeBottom}`);
              check(scope, "§8.2 holds inside the viewer",
                g.smallest === null || g.smallest >= 43.5, `smallest control ${g.smallest}px`);
              // The caption band is the piece of viewer chrome most likely to be swallowed: it
              // is anchored to the floor of a full-bleed overlay, where the home indicator is.
              check(scope, "the viewer's caption band clears the home indicator",
                !g.bottomBand || g.bottomBand.bottom <= safeBottom + 0.5 || g.bottomBand.padBottom >= g.insetBottom - 0.5,
                g.bottomBand ? `band ${g.bottomBand.top}..${g.bottomBand.bottom} padBottom=${g.bottomBand.padBottom} inset=${g.insetBottom} safe bottom=${safeBottom}` : "no .me-vbottom");
              check(scope, "the viewer's top band clears the status bar",
                !g.topBand || g.topBand.top >= g.insetTop - 0.5 || g.topBand.padTop >= g.insetTop - 0.5,
                g.topBand ? `band ${g.topBand.top}..${g.topBand.bottom} padTop=${g.topBand.padTop} inset=${g.insetTop}` : "no .me-vtop");
              console.log(`    viewer/${theme}: ${g.controls.length} controls, top ${g.topmost}, lowest ${g.lowest}, smallest ${g.smallest}`
                + `, top band ${g.topBand && g.topBand.top}..${g.topBand && g.topBand.bottom} (padTop ${g.topBand && g.topBand.padTop})`
                + `, caption band ${g.bottomBand && g.bottomBand.top}..${g.bottomBand && g.bottomBand.bottom} (padBottom ${g.bottomBand && g.bottomBand.padBottom})`);
              if (SHOTS) await B.shot(path.join(OUT, `chk-viewer-${theme}.png`));
            }
          }
        }
      }
    }
  }

  check("page", "no uncaught page errors", B.pageErrors.length === 0, B.pageErrors.slice(0, 3).join(" | "));

  // ── put the database back exactly as it was found ────────────────────────────────────
  await seed.cleanup();
  const after = await api(tripApi("/memories"));
  const left = (after.json && after.json.memories || []).length;
  check("teardown", "the seeded memories are gone (the D1 is as it was found)", left === preexisting,
    `${left} row(s) now, ${preexisting} before the run`);

  if (!STATES_ONLY) {
    console.log(`\n  audited: ${tally.text} text elements, ${tally.interactive} controls, ${tally.groups} selected/unselected groups`
      + `, ${tally.imageBacked} skipped for an image backdrop`);
  }
  await B.done();
  console.log(`\n  ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("  failures:");
    for (const f of failures.slice(0, 40)) console.log("    - " + f);
    if (BREAK) console.log(`\n  SELF-TEST OK: --break=${BREAK} produced ${failures.length} failure(s), as it must.`);
    process.exit(1);
  }
  if (BREAK) {
    console.log(`\n  SELF-TEST BROKEN: --break=${BREAK} did NOT fail.`);
    process.exit(2);
  }
  process.exit(0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

#!/usr/bin/env node
/* THE INSTALLED-PWA HARNESS — the app as it is on a phone's Home Screen, not in a browser tab.
 *
 *   node scripts/standalone_check.mjs                 # every route, both themes, 3 profiles
 *   node scripts/standalone_check.mjs --profile=island-portrait
 *   node scripts/standalone_check.mjs --route=agenda --theme=dark --no-shots
 *   node scripts/standalone_check.mjs --landscape     # adds the landscape profile
 *   node scripts/standalone_check.mjs --break=tabbar-inset      # self-test, must go RED
 *
 * WHY THIS EXISTS. Everything in this repo has only ever been rendered in a browser tab on a
 * Mac, where all four safe-area insets are flat 0 and `display-mode` is `browser`. On the
 * phone the app is an INSTALLED PWA: manifest display "standalone", viewport-fit=cover, no
 * browser chrome (so the viewport is the full device height), a status bar / Dynamic Island
 * over the top and a home indicator under the bottom. None of that had ever been on screen.
 *
 * `env(safe-area-inset-*)` cannot be overridden from a stylesheet and cannot be set from
 * script, so it could not be faked. public/styles.css now reads each of the four exactly
 * once, into --sa-top / --sa-right / --sa-bottom / --sa-left, and every rule in the app goes
 * through those tokens. This script sets the four tokens on <html> before the app's first
 * frame and the whole thing renders as a notched phone.
 *
 * WHAT IT ASSERTS, per route x theme x device profile:
 *   - the emulation is honest: display-mode standalone matches, and the four tokens read back
 *     the profile's numbers (if they do not, every measurement below is a browser tab again)
 *   - nothing lands under the status bar: the .statusbar backdrop is exactly the top inset
 *     tall and opaque, #view's first row starts at or below it
 *   - sticky headers pin AT the status bar, never under it
 *   - the tab bar clears the home indicator: its padding-bottom is the bottom inset, and no
 *     tab button's box crosses into the home-indicator band
 *   - bottom-anchored fixed furniture (the back dock, the FABs, the sync line) clears it too
 *   - no control that is >= 44px in the un-inset render has its box eaten below 44px by an
 *     inset (a control is a 44px target at least)
 *   - and, statically, that no file has gone back to a raw env(safe-area-inset-*)
 *
 * WHERE THE DEVICE NUMBERS COME FROM. These are the published iOS logical-viewport and
 * safe-area values, NOT numbers measured on a handset:
 *   - the portrait TOP inset is the status-bar band: 44px on the X/XS/11-Pro generation,
 *     47px on the 12/13/14 notch, 59px on the 14-Pro/15-Pro Dynamic Island.
 *   - the portrait BOTTOM inset is the home-indicator band: 34px on every Face ID iPhone.
 *   - landscape: top 0, bottom 21, and the sensor housing moves to the sides (44px on the
 *     notch generation, 59px on Dynamic Island).
 *   - the logical viewport is 393x852 (14/15 Pro) and 390x844 (12/13/14), and in STANDALONE
 *     the app gets all of that height — in a Safari tab the same phone gives roughly 745pt
 *     because the URL bar and toolbar eat the rest. That difference is the whole point of
 *     the taller viewport here.
 * Treat them as the device profile to re-measure on the real phone when it is in hand; the
 * harness reads them from one table (PROFILES) so a correction is one edit.
 *
 * HOW TO MAKE IT GO RED (and prove it can). --break=<rule> injects one deliberate defect
 * with !important, after the app's own CSS:
 *   tabbar-inset   .tabbar padding-bottom: 0     -> tab buttons in the home-indicator band
 *   statusbar      .statusbar height: 0          -> the first row draws under the notch
 *   fab-inset      the FAB/dock re-anchored to 0 -> furniture under the home indicator
 *   side-notch     first tab button shifted left -> a 44px box eaten by a landscape notch
 *   login-inset    .lg-page padding: 16px flat   -> the login form under the notch
 * A run with --break must fail (exit 1) and says so; a clean run must pass (exit 0). If a
 * --break run comes back green the harness says SELF-TEST BROKEN and exits 2, because a check
 * that cannot fail is worth nothing. All five were run red, and the clean sweep run green.
 *
 * SHOTS land in build/standalone/<profile>-<route>-<theme>.png (ignored by git) for every profile that has a
 * real inset (the zero profile is the control). --no-shots skips them.
 *
 * BOOT. Reuses the running this lane's dev server (WGP_BASE) (never --d1/--r2 flags). The auth
 * cookie is minted from AUTH_SECRET in .dev.vars. Chrome needs the Bash sandbox disabled on
 * this machine, and the service worker is bypassed so this tests the code on disk.
 */
"use strict";

import { baseUrl, launchChrome } from "./lib/browser.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = baseUrl();   // WGP_BASE or --base=<url>: this lane's dev server (scripts/lib/browser.mjs)
const HOST = new URL(BASE).hostname;
const SECRET = process.env.AUTH_SECRET
  || (/AUTH_SECRET=(\S+)/.exec(fs.readFileSync(path.join(REPO, ".dev.vars"), "utf8")) || [])[1];
// A FIXED debugging port is a trap here: if a previous run leaked its browser — a crash, a
// Ctrl-C, a harness that threw before its cleanup — the next run's /json/version answers from
// the OLD browser, this one attaches to a target it does not own, and the failures that come
// back are nonsense ("Inspected target navigated or closed", document.body is null). Measured:
// three leaked instances all sharing 9427. Per-run port unless one is asked for by name.
const OUT = path.join(REPO, "build/standalone");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-sa-"));

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
};
const ONLY_PROFILE = arg("profile");
const ONLY_ROUTE = arg("route");
const ONLY_THEME = arg("theme");

/** The theme ids in index.html's WGP_THEMES table — the one list the app actually boots from. */
function shippedThemes() {
  const src = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");
  const start = src.indexOf("var THEMES = {");
  if (start === -1) return ["light", "dark"];
  const body = src.slice(start, src.indexOf("};", start));
  const ids = [...body.matchAll(/^\s*([a-z][a-z0-9]*)\s*:\s*\{/gim)].map((m) => m[1]);
  return ids.length ? ids : ["light", "dark"];
}
const WANT_LANDSCAPE = !!arg("landscape");
const SHOTS = !arg("no-shots");
const BREAK = arg("break");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

let pass = 0;
const failures = [];
function check(scope, name, ok, detail) {
  const label = `${scope} · ${name}`;
  if (ok) { pass++; if (process.env.WGP_VERBOSE) console.log(`  ok   ${label}${detail ? "  — " + detail : ""}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? "  -> " + String(detail).slice(0, 400) : ""}`); }
}

// ── device profiles ─────────────────────────────────────────────────────────────────────
// vw/vh are the STANDALONE viewport: no URL bar, no toolbar, the full logical screen.
// dsf is 2 rather than the device's real 3 for one reason only — screenshot weight. Every
// number this harness checks is in CSS pixels, which the scale factor does not touch.
const PROFILES = [
  { id: "zero", label: "no notch (control)", vw: 393, vh: 852, dsf: 2,
    insets: { top: 0, right: 0, bottom: 0, left: 0 } },
  { id: "island-portrait", label: "iPhone 15 Pro portrait", vw: 393, vh: 852, dsf: 2,
    insets: { top: 59, right: 0, bottom: 34, left: 0 } },
  { id: "notch-portrait", label: "iPhone 13/14 portrait", vw: 390, vh: 844, dsf: 2,
    insets: { top: 47, right: 0, bottom: 34, left: 0 } },
  { id: "island-landscape", label: "iPhone 15 Pro landscape", vw: 852, vh: 393, dsf: 2,
    insets: { top: 0, right: 59, bottom: 21, left: 59 }, optIn: true },
];

// ── routes ──────────────────────────────────────────────────────────────────────────────
// #/map is a redirect to #/places?view=map (V3 item 16), so the route name stays "places".
const V = `((n)=>document.querySelector('#view')?.dataset.route===n && document.querySelector('#view').children.length)`;
const ROUTES = [
  { id: "agenda", hash: "#/", wait: `${V}('agenda')` },
  { id: "event", hash: "#/e/flt-atl-lim", wait: `${V}('event')` },
  { id: "places", hash: "#/places", wait: `${V}('places')` },
  { id: "place", hash: "#/p/aguas-calientes-station", wait: `${V}('place')` },
  { id: "map", hash: "#/places?view=map", wait: `${V}('places') && document.querySelector('.mp-root')` },
  { id: "pack", hash: "#/pack", wait: `${V}('pack')` },
  { id: "mem-feed", hash: "#/memories", pre: { "wgp.memview": "feed" },
    wait: `${V}('memories') && document.querySelector('.me-stage[data-stage="feed"]:not([hidden]) .me-feed')` },
  { id: "mem-list", hash: "#/memories", pre: { "wgp.memview": "list" },
    wait: `${V}('memories') && document.querySelector('.me-stage[data-stage="list"]:not([hidden])')?.children.length` },
  { id: "mem-collage", hash: "#/memories", pre: { "wgp.memview": "collage" },
    wait: `${V}('memories') && document.querySelector('.me-stage[data-stage="collage"]:not([hidden])')?.children.length` },
  { id: "settings", hash: "#/settings", wait: `${V}('settings')` },
  { id: "credits", hash: "#/settings/credits", wait: `${V}('credits')` },
  // Its own document, outside the app shell — and the first thing an installed PWA shows
  // when the session cookie expires, so it has to clear the notch on its own.
  { id: "login", url: "/login", shell: false, wait: `!!document.querySelector('.lg-wrap')` },
];

// Each break is ONE plausible regression, injected with !important after the app's own CSS.
// The comment on each says which checks it must turn red — a break that trips nothing means
// the check it targets is decorative.
const BREAKS = {
  // the tab bar stops reserving the home indicator: buttons sit in the swipe band
  // -> "tab bar reserves the bottom inset", "no tab button crosses…", "no 44px control eaten"
  "tabbar-inset": `.tabbar{padding-bottom:0 !important}`,
  // the status-bar backdrop collapses and the scroller stops reserving the notch
  // -> 5 on --route=agenda: the backdrop height, the scroller's top padding, the first row,
  //    and both sticky checks (the backdrop is still opaque, so that one stays green)
  "statusbar": `.statusbar{height:0 !important}#view{padding-top:16px !important}`,
  // a bottom-anchored FAB/dock re-anchored to the viewport floor, under the home indicator
  // (run it on a route that has one: --route=pack, --route=event, --route=mem-feed)
  // -> "bottom-anchored fixed furniture clears the home indicator", "no 44px control eaten"
  "fab-inset": `.dock,.me-fab,.pk-fab{bottom:0 !important}`,
  // one control positioned with no regard for the side inset: its box is the size it always
  // was, but the reachable part of it is inside the landscape notch. Isolates the eaten-target
  // rule, and needs a profile with a side inset:
  //   --break=side-notch --landscape --profile=island-landscape
  // -> "no 44px control is eaten by an inset", alone
  "side-notch": `.tabbar a:first-child,.tabbar button:first-child{position:relative !important;left:-140px !important}`,
  // the login page's own padding goes back to a flat gutter, ignoring all four insets
  // (--route=login) -> 2 in portrait: the top and bottom padding checks. The side-padding one
  // joins them under a landscape profile; the first control is centred, so it can survive.
  "login-inset": `.lg-page{padding:16px !important}`,
};

// ── static check: nobody may go back to a raw env() ──────────────────────────────────────
// The four token declarations in styles.css are the ONLY legal env(safe-area-inset-*) in the
// tree. Anything else is a number that cannot be reproduced here, which is the defect this
// whole harness exists to make impossible.
function rawEnvAudit() {
  const roots = ["public"];
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^(vendor|img|icons)$/.test(e.name)) walk(p); continue; }
      if (!/\.(css|js|html)$/.test(e.name)) continue;
      const src = fs.readFileSync(p, "utf8");
      const re = /env\(\s*safe-area-inset-(top|right|bottom|left)\s*(,[^)]*)?\)/g;
      let m;
      while ((m = re.exec(src))) {
        const line = src.slice(0, m.index).split("\n").length;
        const decl = new RegExp(`--sa-${m[1]}\\s*:\\s*$`).test(src.slice(0, m.index).split("\n").pop());
        const isTokenDecl = p.endsWith("public/styles.css") && decl;
        if (!isTokenDecl) hits.push(`${path.relative(REPO, p)}:${line}`);
      }
    }
  };
  for (const r of roots) walk(path.join(REPO, r));
  return hits;
}

// ── CDP ─────────────────────────────────────────────────────────────────────────────────
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.handlers = new Set(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cdp connect failed")); });
    const c = new CDP(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej } = c.waiting.get(m.id); c.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else for (const h of c.handlers) h(m);
    };
    return c;
  }
  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error(`CDP timeout: ${method}`)); }, 60000);
    });
  }
  close() { try { this.ws.close(); } catch { } }
}
async function evalIn(cdp, S, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, S);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(cdp, S, expr, { timeout = 25000, every = 150, label = expr } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    let v = null;
    try { v = await evalIn(cdp, S, `(()=>{try{return (${expr})}catch(e){return null}})()`); } catch { }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await sleep(every);
  }
}

function cookie(uid = "u_admin", days = 30) {
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  return `${uid}.${exp}.${crypto.createHmac("sha256", SECRET).update(`${uid}.${exp}`).digest("hex")}`;
}

// ── injected at document start: the phone's insets, before the app's first frame ─────────
// Inline style on <html> beats the :root rule, so the four tokens carry the profile and every
// declaration in the app that reads them moves. documentElement does not exist yet on a fresh
// navigation, hence the observer on `document` itself.
function INJECT(ins, css) {
  const apply = () => {
    const r = document.documentElement;
    if (!r) return false;
    r.style.setProperty("--sa-top", ins.top + "px");
    r.style.setProperty("--sa-right", ins.right + "px");
    r.style.setProperty("--sa-bottom", ins.bottom + "px");
    r.style.setProperty("--sa-left", ins.left + "px");
    if (css) {
      const put = () => {
        if (!document.head || document.getElementById("wgp-break")) return;
        const s = document.createElement("style");
        s.id = "wgp-break";
        s.textContent = css;
        document.head.appendChild(s);
      };
      put();
      document.addEventListener("DOMContentLoaded", put);
    }
    return true;
  };
  if (!apply()) {
    const mo = new MutationObserver(() => { if (apply()) mo.disconnect(); });
    mo.observe(document, { childList: true, subtree: true });
  }
}

// ── the page-side collector ─────────────────────────────────────────────────────────────
// One pass, one JSON payload: everything the checks below need, measured in CSS pixels with
// the insets live. `sel` is a short human-readable selector so a failure names a real element.
function COLLECT() {
  const px = (v) => Math.round(parseFloat(v) * 100) / 100 || 0;
  const sel = (e) => {
    const cls = (e.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    return e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (cls ? "." + cls : "");
  };
  const cs = (e) => getComputedStyle(e);
  const vw = window.innerWidth, vh = window.innerHeight;
  const root = getComputedStyle(document.documentElement);
  const insets = {
    top: px(root.getPropertyValue("--sa-top")),
    right: px(root.getPropertyValue("--sa-right")),
    bottom: px(root.getPropertyValue("--sa-bottom")),
    left: px(root.getPropertyValue("--sa-left")),
  };
  const safe = { top: insets.top, bottom: vh - insets.bottom, left: insets.left, right: vw - insets.right };
  const vis = (e) => {
    const s = cs(e);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const box = (e) => { const r = e.getBoundingClientRect(); return { top: px(r.top), bottom: px(r.bottom), left: px(r.left), right: px(r.right), w: px(r.width), h: px(r.height) }; };

  const out = { vw, vh, insets, safe };
  out.displayMode = window.matchMedia("(display-mode: standalone)").matches;
  out.browserMode = window.matchMedia("(display-mode: browser)").matches;
  out.bodyBg = cs(document.body).backgroundColor;

  // the status-bar backdrop
  const sb = document.querySelector(".statusbar");
  out.statusbar = sb ? { ...box(sb), bg: cs(sb).backgroundColor, z: cs(sb).zIndex, pos: cs(sb).position } : null;

  // the scroller and its first row
  const view = document.querySelector("#view");
  if (view) {
    const vs = cs(view);
    out.view = { padTop: px(vs.paddingTop), padLeft: px(vs.paddingLeft), padRight: px(vs.paddingRight), ...box(view) };
    const kid = [...view.children].find(vis);
    out.firstRow = kid ? { sel: sel(kid), ...box(kid) } : null;
  }

  // the login page has no shell: .lg-page's own padding is the only thing clearing the insets
  const lg = document.querySelector(".lg-page");
  if (lg) {
    const ls = cs(lg);
    out.page = { padTop: px(ls.paddingTop), padBottom: px(ls.paddingBottom),
                 padLeft: px(ls.paddingLeft), padRight: px(ls.paddingRight), ...box(lg) };
    const ctl = [...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"]')].filter(vis)[0];
    out.firstControl = ctl ? { sel: sel(ctl), ...box(ctl) } : null;
  }

  // the tab bar
  const tb = document.querySelector(".tabbar");
  if (tb) {
    out.tabbar = { ...box(tb), padBottom: px(cs(tb).paddingBottom) };
    out.tabbtns = [...tb.querySelectorAll("a,button")].filter(vis).map((e) => ({ sel: sel(e), ...box(e) }));
  }

  // bottom-anchored fixed furniture. .statusbar is excluded on purpose: filling the TOP inset
  // is its entire job.
  out.bottomFixed = [...document.querySelectorAll("body *")].filter((e) => {
    if (e.closest(".statusbar")) return false;
    const s = cs(e);
    if (s.position !== "fixed" || !vis(e)) return false;
    const r = e.getBoundingClientRect();
    if (r.height > vh * 0.5) return false;              // sheets/scrims are not bottom furniture
    return r.bottom > vh - 220;
  }).map((e) => ({ sel: sel(e), ...box(e) }));

  // sticky headers, measured where they actually pin (the caller scrolls first)
  out.sticky = [...document.querySelectorAll("#view *")]
    .filter((e) => cs(e).position === "sticky" && vis(e))
    .map((e) => ({ sel: sel(e), ...box(e) }));

  // 44px targets eaten by an inset. Only elements that ARE >= 44px un-inset are considered:
  // a control that was already small is a different defect and belongs to another check.
  const TAP = 44, EPS = 0.5;
  const interactive = [...document.querySelectorAll(
    'a[href],button,input,select,textarea,[role="button"],[role="tab"],[role="switch"],[tabindex]:not([tabindex="-1"])')]
    .filter((e) => vis(e) && !e.disabled);
  // A control is judged only where it is fully VISIBLE VERTICALLY: the next note row below the
  // fold of a long list, or a marker outside the map's clip box, is a scrolling matter and not
  // an inset one — counting those would make this check cry wolf on every list in the app.
  // Vertical only, and deliberately: a control pushed sideways out of the viewport is exactly
  // the landscape-notch defect this check is for, so the horizontal axis is never an excuse.
  // A fixed element escapes ancestor clipping, so its band is the viewport.
  const bandOf = (e) => {
    let top = 0, bottom = vh;
    if (cs(e).position === "fixed") return { top, bottom };
    for (let p = e.parentElement; p; p = p.parentElement) {
      const s = cs(p);
      if (s.overflowY !== "visible") {
        const r = p.getBoundingClientRect();
        top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom);
      }
      if (s.position === "fixed") break;
    }
    return { top, bottom };
  };
  out.eaten = [];
  out.offscreen = 0;
  for (const e of interactive) {
    const r = e.getBoundingClientRect();
    const band = bandOf(e);
    if (r.top < band.top - EPS || r.bottom > band.bottom + EPS) { out.offscreen++; continue; }
    if (Math.min(r.width, r.height) < TAP - EPS) continue;                    // never was a 44px box
    const iw = Math.max(0, Math.min(r.right, safe.right) - Math.max(r.left, safe.left));
    const ih = Math.max(0, Math.min(r.bottom, safe.bottom) - Math.max(r.top, safe.top));
    if (iw < TAP - EPS || ih < TAP - EPS) {
      out.eaten.push({ sel: sel(e), w: px(r.width), h: px(r.height), safeW: px(iw), safeH: px(ih), top: px(r.top), bottom: px(r.bottom) });
    }
  }
  return out;
}

// alpha of a computed colour; 1 means opaque, which is what a backdrop has to be
function alphaOf(color) {
  const m = /rgba?\(([^)]+)\)/.exec(color || "");
  if (!m) return 1;
  const parts = m[1].split(",").map((s) => parseFloat(s));
  return parts.length > 3 ? parts[3] : 1;
}

(async () => {
  if (!SECRET) throw new Error("AUTH_SECRET not found (.dev.vars)");
  const probe = await fetch(BASE + "/t/demo-2027/").catch(() => null);
  if (!probe) throw new Error(`no dev server on ${BASE} — start this lane's dev server on that port first`);

  // ── the static audit runs first: if a raw env() came back, nothing below is trustworthy ──
  const raw = rawEnvAudit();
  check("static", "no raw env(safe-area-inset-*) outside the four token declarations",
    raw.length === 0, raw.join(", "));

  const profiles = PROFILES.filter((p) => (ONLY_PROFILE ? p.id === ONLY_PROFILE : (!p.optIn || WANT_LANDSCAPE)));
  const routes = ROUTES.filter((r) => (ONLY_ROUTE ? r.id === ONLY_ROUTE : true));
  // EVERY theme the app ships, read from the shell's own table rather than listed here. This
  // harness exists to catch a screen that breaks under a theme, so a hardcoded pair would have
  // meant every theme added after it went unphotographed — which is precisely the state it was
  // in. Narrow it with --theme=<id> when iterating; the default has to be all of them.
  const themes = (ONLY_THEME ? [ONLY_THEME] : shippedThemes());
  if (!profiles.length) throw new Error(`no profile matched --profile=${ONLY_PROFILE}`);
  if (!routes.length) throw new Error(`no route matched --route=${ONLY_ROUTE}`);
  if (BREAK && !BREAKS[BREAK]) throw new Error(`unknown --break=${BREAK}; try ${Object.keys(BREAKS).join(" | ")}`);
  if (BREAK) log(`SELF-TEST: injecting the "${BREAK}" defect — this run MUST fail`);

  // --app=, not a tab. THIS is what makes `(display-mode: standalone)` match: Chrome decides
  // display-mode from the window type, and Emulation.setEmulatedMedia does NOT carry the
  // display-mode feature (measured on this machine: it stays `browser`). An app window keeps
  // reporting standalone across every later navigation, which is what the sweep needs.
  const chrome = await launchChrome({ args: [
    "--disable-gpu", "--disable-features=Translate,MediaRouter", "--force-device-scale-factor=1",
    "--window-size=430,932", `--app=${BASE}/login?boot=0`,
  ] });
  const cdp = await CDP.connect(chrome.wsUrl);
  // ONLY the app window will do. A plain about:blank tab target reports display-mode browser,
  // and attaching to it would quietly turn the whole sweep back into a browser tab — so wait
  // for the target that is actually on the app's origin rather than taking the first page.
  let targetId = null;
  for (let i = 0; i < 60 && !targetId; i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    targetId = (targetInfos.find((t) => t.type === "page" && t.url.startsWith(BASE)) || {}).targetId || null;
    if (!targetId) await sleep(250);
  }
  if (!targetId) throw new Error("no app-window page target on " + BASE + " — Chrome did not open the --app window");
  const { sessionId: S } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const pageErrors = [];
  cdp.on((msg) => {
    if (msg.sessionId !== S) return;
    if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
  });
  await cdp.send("Page.enable", {}, S);
  await cdp.send("Runtime.enable", {}, S);
  await cdp.send("Network.enable", {}, S);
  // The service worker precaches the app's JS: without this the harness measures stale code.
  await cdp.send("Network.setBypassServiceWorker", { bypass: true }, S);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, S);
  await cdp.send("Network.setCookie", { name: "s2", value: cookie(), domain: HOST, path: "/" }, S);
  await cdp.send("Storage.clearDataForOrigin",
    { origin: BASE, storageTypes: "indexeddb,local_storage,cache_storage,service_workers" }, S);

  // Fail fast, loudly, once: if this is not an app window every later measurement is a
  // browser tab wearing a costume, and 900 green checks would be a lie.
  const dm = await evalIn(cdp, S, `matchMedia('(display-mode: standalone)').matches`);
  if (!dm) throw new Error("the attached window is not in app mode — display-mode is 'browser', so this would be a browser tab again");

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

  let injectedId = null;
  const rows = [];

  for (const prof of profiles) {
    log(`profile ${prof.id} — ${prof.label}: ${prof.vw}x${prof.vh}, insets ${prof.insets.top}/${prof.insets.right}/${prof.insets.bottom}/${prof.insets.left}`);
    // STANDALONE, properly: the media feature the app may branch on, plus the full-height
    // viewport it gets with no browser chrome.
    // display-mode comes from the app window (see the launch above), not from here — this
    // call only kills motion, because a mid-transition frame is not a measurement.
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    }, S);
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: prof.vw, height: prof.vh, deviceScaleFactor: prof.dsf, mobile: true }, S);
    if (injectedId) await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injectedId }, S);
    const r = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(${INJECT})(${JSON.stringify(prof.insets)}, ${JSON.stringify(BREAK ? BREAKS[BREAK] : "")})`,
    }, S);
    injectedId = r.identifier;

    for (const theme of themes) {
      for (const route of routes) {
        const scope = `${prof.id}/${theme}/${route.id}`;
        await ensureLocal({ "wgp.theme": theme, ...(route.pre || {}) });
        let mounted = false;
        for (let attempt = 0; attempt < 2 && !mounted; attempt++) {
          const url = route.url ? `${BASE}${route.url}?sa=${++nav}` : `${BASE}/t/demo-2027/?sa=${++nav}${route.hash}`;
          await cdp.send("Page.navigate", { url }, S);
          await waitFor(cdp, S, `document.readyState==='complete' ? 1 : null`, { label: scope + " load" });
          try { await waitFor(cdp, S, `(${route.wait}) ? 1 : null`, { label: scope + " mount" }); mounted = true; }
          catch { log(`  retrying ${scope}`); }
        }
        check(scope, "route mounts", mounted);
        if (!mounted) continue;
        await evalIn(cdp, S, `Promise.race([Promise.all([...document.images].filter(i=>!i.complete).map(i=>new Promise(r=>{i.onload=i.onerror=r}))),new Promise(r=>setTimeout(r,3500))]).then(()=>1)`);
        await sleep(350);

        const m = await evalIn(cdp, S, `(${COLLECT})()`);
        const ins = m.insets, safe = m.safe;

        // 1. the emulation is honest, or nothing else here means anything
        check(scope, "display-mode is standalone", m.displayMode === true && m.browserMode === false,
          `standalone=${m.displayMode} browser=${m.browserMode}`);
        check(scope, "the four tokens carry the profile",
          ins.top === prof.insets.top && ins.right === prof.insets.right
          && ins.bottom === prof.insets.bottom && ins.left === prof.insets.left,
          `read ${JSON.stringify(ins)} want ${JSON.stringify(prof.insets)}`);
        check(scope, "viewport is the full standalone height", m.vh === prof.vh && m.vw === prof.vw,
          `${m.vw}x${m.vh}`);
        // The inset bands are painted by the page's own ground. A transparent body would hand
        // the notch and the home-indicator band to whatever the OS draws behind the web view.
        check(scope, "the page ground is opaque behind the insets", alphaOf(m.bodyBg) === 1, m.bodyBg);

        if (route.shell !== false) {
          // 2. the status bar band: an opaque backdrop exactly as tall as the inset
          check(scope, "status-bar backdrop is exactly the top inset tall",
            !!m.statusbar && Math.abs(m.statusbar.h - ins.top) < 0.5 && Math.abs(m.statusbar.top) < 0.5,
            m.statusbar ? `top=${m.statusbar.top} h=${m.statusbar.h} inset=${ins.top}` : "no .statusbar");
          check(scope, "status-bar backdrop is opaque", !!m.statusbar && alphaOf(m.statusbar.bg) === 1,
            m.statusbar ? m.statusbar.bg : "-");

          // 3. nothing lands under the status bar at rest
          check(scope, "the scroller reserves the top inset", !!m.view && m.view.padTop >= ins.top - 0.5,
            m.view ? `padding-top=${m.view.padTop} inset=${ins.top}` : "no #view");
          check(scope, "the first row starts below the status bar",
            !!m.firstRow && m.firstRow.top >= ins.top - 0.5,
            m.firstRow ? `${m.firstRow.sel} top=${m.firstRow.top} inset=${ins.top}` : "no first row");
          check(scope, "the scroller's side padding clears a landscape notch",
            !!m.view && m.view.padLeft >= ins.left - 0.5 && m.view.padRight >= ins.right - 0.5,
            m.view ? `padL=${m.view.padLeft} padR=${m.view.padRight} insets ${ins.left}/${ins.right}` : "-");

          // 4. the tab bar and the home indicator
          check(scope, "tab bar reserves the bottom inset",
            !!m.tabbar && Math.abs(m.tabbar.padBottom - ins.bottom) < 0.5,
            m.tabbar ? `padding-bottom=${m.tabbar.padBottom} inset=${ins.bottom}` : "no .tabbar");
          check(scope, "tab bar reaches the foot of the viewport",
            !!m.tabbar && Math.abs(m.tabbar.bottom - m.vh) < 0.5,
            m.tabbar ? `bottom=${m.tabbar.bottom} vh=${m.vh}` : "-");
          const dirtyTabs = (m.tabbtns || []).filter((b) => b.bottom > safe.bottom + 0.5);
          check(scope, "no tab button crosses into the home-indicator band",
            (m.tabbtns || []).length > 0 && dirtyTabs.length === 0,
            dirtyTabs.map((b) => `${b.sel} bottom=${b.bottom} > ${safe.bottom}`).join("; ")
            || `${(m.tabbtns || []).length} buttons`);
        } else {
          // No shell here, so no .statusbar and no tab bar: the page's own padding is the only
          // thing between the invite form and the notch. It is the first screen an installed
          // PWA shows when the session expires, so it gets checked like everything else.
          check(scope, "the login scroller clears the status bar",
            !!m.page && m.page.padTop >= ins.top + 0.5,
            m.page ? `padding-top=${m.page.padTop} inset=${ins.top}` : "no .lg-page");
          check(scope, "the login scroller clears the home indicator",
            !!m.page && m.page.padBottom >= ins.bottom + 0.5,
            m.page ? `padding-bottom=${m.page.padBottom} inset=${ins.bottom}` : "-");
          check(scope, "the login scroller clears a landscape notch",
            !!m.page && m.page.padLeft >= ins.left - 0.5 && m.page.padRight >= ins.right - 0.5,
            m.page ? `padL=${m.page.padLeft} padR=${m.page.padRight} insets ${ins.left}/${ins.right}` : "-");
          check(scope, "login's first control sits below the status bar",
            !!m.firstControl && m.firstControl.top >= ins.top - 0.5,
            m.firstControl ? `${m.firstControl.sel} top=${m.firstControl.top} inset=${ins.top}` : "no control");
        }

        // 5. bottom-anchored fixed furniture clears the home indicator
        const dirtyFixed = (m.bottomFixed || []).filter((e) => e.bottom > safe.bottom + 0.5);
        check(scope, "bottom-anchored fixed furniture clears the home indicator",
          dirtyFixed.length === 0,
          dirtyFixed.map((e) => `${e.sel} bottom=${e.bottom} > ${safe.bottom}`).join("; "));

        // 6. 44px targets not eaten by an inset
        check(scope, "no 44px control is eaten by an inset", (m.eaten || []).length === 0,
          (m.eaten || []).map((e) => `${e.sel} ${e.w}x${e.h} at y ${e.top}..${e.bottom} -> reachable ${e.safeW}x${e.safeH}`).join("; "));

        // 7. sticky headers, measured where they pin
        let sticky = m.sticky || [];
        if (route.shell !== false) {
          const scrolled = await evalIn(cdp, S, `(()=>{const v=document.querySelector('#view');
            if(!v||v.scrollHeight<=v.clientHeight+40) return 0; v.scrollTop=Math.min(700,v.scrollHeight-v.clientHeight); return v.scrollTop;})()`);
          if (scrolled) {
            await sleep(220);
            const m2 = await evalIn(cdp, S, `(${COLLECT})()`);
            sticky = m2.sticky || [];
            // Only headers actually on screen are judged: a sticky header whose own section
            // has scrolled off is being pushed UP by its containing block, which is correct
            // (and it is hidden behind the opaque backdrop while it goes).
            const onScreen = sticky.filter((s) => s.bottom > 0 && s.top < m.vh);
            const under = onScreen.filter((s) => s.top >= 0 && s.top < ins.top - 0.5);
            check(scope, "sticky headers pin at or below the status bar", under.length === 0,
              under.map((s) => `${s.sel} top=${s.top} < ${ins.top}`).join("; ")
              || (onScreen.length ? onScreen.map((s) => `${s.sel}@${s.top}`).join(" ") : "none on this route"));
            const pinned = onScreen.filter((s) => Math.abs(s.top - ins.top) < 1.5);
            if (onScreen.length) {
              check(scope, "a sticky header pins exactly AT the status bar", pinned.length > 0,
                onScreen.map((s) => `${s.sel}@${s.top} want ${ins.top}`).join(" "));
            }
            await evalIn(cdp, S, `(()=>{const v=document.querySelector('#view'); if(v) v.scrollTop=0; return 1})()`);
            await sleep(220);
          }
        }

        rows.push({
          scope, vw: m.vw, vh: m.vh, insets: ins,
          statusbar: m.statusbar ? m.statusbar.h : null,
          viewPadTop: m.view ? m.view.padTop : (m.page ? m.page.padTop : null),
          firstRowTop: m.firstRow ? m.firstRow.top : (m.firstControl ? m.firstControl.top : null),
          tabbarPad: m.tabbar ? m.tabbar.padBottom : (m.page ? m.page.padBottom : null),
          tabBtnBottom: (m.tabbtns || []).reduce((a, b) => Math.max(a, b.bottom), 0) || null,
          sticky: sticky.map((s) => `${s.sel}@${s.top}`).join(" ") || "-",
          bottomFixed: (m.bottomFixed || []).map((e) => `${e.sel}@${e.bottom}`).join(" ") || "-",
          eaten: (m.eaten || []).length,
          offscreen: m.offscreen,
        });

        if (SHOTS && prof.id !== "zero") {
          const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, S);
          fs.writeFileSync(path.join(OUT, `${prof.id}-${route.id}-${theme}.png`), Buffer.from(data, "base64"));
        }
      }
    }
  }

  // ── per-route geometry table ────────────────────────────────────────────────────────────
  console.log("\n  route geometry (CSS px)");
  console.log("  " + "scope".padEnd(34) + "viewport   insets(t/r/b/l)  statusbar  #view padTop  row top  tabbar pad  last btn bottom  eaten");
  for (const r of rows) {
    console.log("  " + r.scope.padEnd(34)
      + `${r.vw}x${r.vh}`.padEnd(11)
      + `${r.insets.top}/${r.insets.right}/${r.insets.bottom}/${r.insets.left}`.padEnd(17)
      + String(r.statusbar ?? "-").padEnd(11)
      + String(r.viewPadTop ?? "-").padEnd(14)
      + String(r.firstRowTop ?? "-").padEnd(9)
      + String(r.tabbarPad ?? "-").padEnd(12)
      + String(r.tabBtnBottom ?? "-").padEnd(17)
      + String(r.eaten));
  }
  if (process.env.WGP_VERBOSE) for (const r of rows) console.log(`  ${r.scope}  sticky: ${r.sticky}  fixed: ${r.bottomFixed}  skipped(off the fold): ${r.offscreen}`);

  check("page", "no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  cdp.close();
  await chrome.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }

  console.log(`\n  ${pass} passed, ${failures.length} failed` + (SHOTS ? `  ·  shots in build/standalone/` : ""));
  if (failures.length) {
    console.log("  failures:");
    for (const f of failures.slice(0, 40)) console.log("    - " + f);
    if (BREAK) console.log(`\n  SELF-TEST OK: --break=${BREAK} produced ${failures.length} failure(s), as it must.`);
    process.exit(1);
  }
  if (BREAK) {
    console.log(`\n  SELF-TEST BROKEN: --break=${BREAK} did NOT fail. The check cannot detect its own defect.`);
    process.exit(2);
  }
  process.exit(0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });

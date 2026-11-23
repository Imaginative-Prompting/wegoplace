/* Guard against the bug class that shipped TWICE and cost two review rounds.
 *
 * THE TRAP. `.ag-strip` carries backdrop-filter, which collapses it into one filtered surface.
 * `.ag-ring` had an OPAQUE background and sat over the day labels, kept behind them only by
 * z-index. The moment Element.animate() ran, the ring was promoted to its own compositor layer
 * composited AGAINST that filtered surface — and z-index cannot reorder across that boundary.
 * Chrome honours the z-index anyway. WebKit does not. So every headless-Chrome harness was
 * green while the date vanished on a real iPhone, twice.
 *
 * THE RULE THIS ENCODES: inside a backdrop-filter ancestor, an element with an OPAQUE background
 * may not overlap text that it depends on z-index to stay behind. Either it carries no opaque
 * fill (the ring now draws a 1px border only), or the fill belongs to the element that paints
 * the text (which is where .ag-pill-here's fill lives now) — both are correct in ANY engine.
 *
 * This machine has no WebKit to test against (safaridriver needs an admin enable), so this is a
 * STRUCTURAL check, not an engine check. It cannot see everything WebKit does differently. It
 * catches this one shape, which is the one that actually shipped.
 *
 *   node scripts/webkit_stacking_check.mjs [--route=<hash>] [--seed-fail]
 *
 * --seed-fail re-introduces the historical opaque ring at runtime and asserts the check goes
 * RED. A check that cannot fail is worth nothing; this one proves itself on every run.
 */
"use strict";
import { baseUrl, launchChrome } from "./lib/browser.mjs";
import { signedIn, tripPath } from "./lib/gate_trip.mjs";
import fs from "node:fs";

const BASE = baseUrl();   // WGP_BASE or --base=<url>: this lane's dev server (scripts/lib/browser.mjs)
const ROUTES = process.argv.find((a) => a.startsWith("--route="))
  ? [process.argv.find((a) => a.startsWith("--route=")).slice(8)]
  : ["#/", "#/places", "#/pack", "#/memories", "#/settings"];
const SEED_FAIL = process.argv.includes("--seed-fail");

// Signed in as the host of the gate's made-up trip, with a session of this run's own
// (scripts/lib/gate_trip.mjs).

// ISOLATION, and it is not paranoia. A run of this check once reported a violation that did not
// exist — an opaque .ag-ring on a tree whose ring measures rgba(0,0,0,0) — because it attached to
// another Chrome instance. A harness that can report a phantom bug is worse than no harness, so
// the browser comes from the shared launcher: its own fresh profile, and a port read from that
// profile rather than chosen.
const proc = await launchChrome({ args: ["about:blank"] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tab = await (await fetch(`${proc.origin}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let mid = 0; const waits = new Map();
const send = (m, p = {}) => { const i = ++mid; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((r) => waits.set(i, r)); };
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id && waits.has(d.id)) { waits.get(d.id)(d.result); waits.delete(d.id); } };
await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send("Network.setBypassServiceWorker", { bypass: true });
for (const cookie of await signedIn()) await send("Network.setCookie", cookie);
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.value;

// The audit runs in the page: find opaque boxes under a backdrop-filter ancestor that overlap
// text they only stay behind because of z-index.
const AUDIT = `(() => {
  const opaque = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return false;
    const p = m[1].split(",").map((s) => parseFloat(s));
    return p.length < 4 || p[3] >= 0.5;
  };
  const filtered = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if ((s.backdropFilter && s.backdropFilter !== "none") ||
          (s.webkitBackdropFilter && s.webkitBackdropFilter !== "none")) return n;
    }
    return null;
  };
  const hasText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  // A text span almost always has z-index:auto; what actually orders it is the nearest
  // positioned ancestor that sets one. .ag-pill-dow is auto, .ag-pill is z-index 1 — comparing
  // the span's own value is why the first version of this check could not catch the ring.
  const stackZ = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.position !== "static" && s.zIndex !== "auto") return Number(s.zIndex);
    }
    return 0;
  };
  const hit = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  const out = [];
  for (const el of document.querySelectorAll("*")) {
    const s = getComputedStyle(el);
    if (s.position === "static" || !opaque(s.backgroundColor)) continue;
    const surface = filtered(el); if (!surface) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const mine = s.zIndex === "auto" ? 0 : Number(s.zIndex);
    for (const t of surface.querySelectorAll("*")) {
      if (t === el || el.contains(t) || t.contains(el) || !hasText(t)) continue;
      const theirs = stackZ(t);
      if (theirs <= mine) continue;              // not relying on stacking to stay above
      if (!hit(r, t.getBoundingClientRect())) continue;
      out.push({ box: el.className || el.tagName, boxZ: mine, bg: s.backgroundColor,
                 text: (t.textContent || "").trim().slice(0, 24), textZ: theirs,
                 surface: surface.className || surface.tagName });
    }
  }
  return JSON.stringify(out);
})()`;

let violations = 0;
for (const route of ROUTES) {
  await send("Page.navigate", { url: "about:blank" }); await sleep(120);
  await send("Page.navigate", { url: `${BASE}${tripPath(route)}` });
  await sleep(2400);
  if (SEED_FAIL && route === "#/") {
    // Put the historical bug back: an opaque ring, exactly as it shipped.
    await ev(`(()=>{const s=document.createElement("style");
      s.textContent=".ag-ring{background:var(--accent-soft)!important}";document.head.append(s);
      const p=document.querySelector(".ag-pill");if(p)p.click();return 1})()`);
    await sleep(700);
  }
  const found = JSON.parse(await ev(AUDIT) || "[]");
  for (const v of found) {
    violations++;
    console.log(`  VIOLATION ${route}  ${v.box} (z${v.boxZ}, ${v.bg}) covers "${v.text}" (z${v.textZ}) inside ${v.surface}`);
  }
  if (!found.length) console.log(`  ok  ${route}`);
}

if (SEED_FAIL) {
  if (violations > 0) { console.log(`\nSELF-TEST OK — the seeded opaque ring was caught (${violations}).`); process.exit(0); }
  console.log("\nSELF-TEST BROKEN — the seeded bug was NOT caught. This check proves nothing."); process.exit(2);
}
console.log(violations ? `\n${violations} violation(s)` : "\nclean — no opaque box relies on z-index over text inside a filtered surface");
process.exit(violations ? 1 : 0);

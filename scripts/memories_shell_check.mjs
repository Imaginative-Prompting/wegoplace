#!/usr/bin/env node
/* v6 Memories — the two things the other harnesses cannot see.
 *
 *   node scripts/memories_shell_check.mjs
 *
 * 1. THE OFFLINE SHELL. The upload checks run with Network.setBypassServiceWorker so
 *    they never test stale JS — which means it also never tests whether the Memories tab is in
 *    the precache at all. Four days of this trip have no signal; a tab whose module was never
 *    cached is a blank screen exactly then. This boots the real service worker against the
 *    real server, lets install + topUp + crawlAssets finish, and asserts every file the tab
 *    needs is in the shell cache — then kills the network and mounts the tab from cache alone.
 *
 * 2. THE §8 SWEEP, MEASURED. Tap targets, font sizes and text opacity are read off
 *    getComputedStyle/getBoundingClientRect at 390x844, in BOTH themes, for every interactive
 *    element the Memories routes put on screen — feed, composer sheet and full-screen viewer.
 *
 * Same router-patch-over-CDP trick as the e2e harness: router.js belongs to the parallel v5
 * workflow and is never written to.
 *
 * PLANTED: MSHELL_PLANT=nocss answers css/memories.css with a 404, to the page and to the worker: the
 * tab's stylesheet isn't in the shell cache, and offline Photos' title isn't the 28 px only that
 * stylesheet gives it (red).
 */
"use strict";

import { baseUrl, launchChrome } from "./lib/browser.mjs";
import { signedIn, TRIP } from "./lib/gate_trip.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedMemories } from "./lib/seed_memories.mjs";
import { pickPhotos, cdpPage, madePhoto } from "./lib/photo_picker.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOCSS = process.env.MSHELL_PLANT === "nocss";
if (process.env.MSHELL_PLANT && !NOCSS) throw new Error("MSHELL_PLANT is nocss");
let plantedCss = false;
const FETCHED = [{ urlPattern: "*/js/router.js*", requestStage: "Request" },
  ...(NOCSS ? [{ urlPattern: "*/css/memories.css*", requestStage: "Request" }] : [])];
const BASE = baseUrl();   // WGP_BASE or --base=<url>: this lane's dev server (scripts/lib/browser.mjs)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-shell-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? "  -> " + String(detail).slice(0, 600) : ""}`); }
}
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);


function patchRouter(src) {
  let out = src;
  const anchor = `  { re: /^\\/settings\\/credits\\/?$/`;
  if (!out.includes("memories.js")) {
    const i = out.indexOf(anchor);
    if (i < 0) throw new Error("router.js anchor not found");
    out = out.slice(0, i) +
      `  { re: /^\\/memories\\/?$/,        name: "memories", tab: "memories", root: true,  mod: "./memories.js", keys: [], title: "Memories" },\n` +
      out.slice(i);
  }
  return out.replace(
    `const TAB_ROOT = { agenda: "#/", places: "#/places", pack: "#/pack", settings: "#/settings" };`,
    `const TAB_ROOT = { agenda: "#/", places: "#/places", pack: "#/pack", memories: "#/memories", settings: "#/settings" };`);
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.handlers = new Set(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cdp connect failed")); });
    const c = new CDP(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej, timer } = c.waiting.get(m.id); c.waiting.delete(m.id);
        clearTimeout(timer);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else for (const h of c.handlers) h(m);
    };
    return c;
  }
  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      // Its timer goes when its answer comes: a timer left behind for every call kept node alive two minutes after the
      // check's tally (the gate ended it, 22 Nov: "finished but didn't exit").
      const timer = setTimeout(() => { if (this.waiting.delete(id)) rej(new Error(`CDP timeout: ${method}`)); }, 120000);
      this.waiting.set(id, { res, rej, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { try { this.ws.close(); } catch { } }
}
async function evalIn(cdp, S, expression) {
  const r = await cdp.send("Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true }, S);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception ? (d.exception.description || d.exception.value) : d.text);
  }
  return r.result.value;
}
async function waitFor(cdp, S, expr, { timeout = 60000, every = 250, label = expr } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    let v = null;
    try { v = await evalIn(cdp, S, `(()=>{try{return (${expr})}catch(e){return null}})()`); } catch { }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(every);
  }
}

// The §8 probe, run inside the page. Returns every offender rather than a boolean, because a
// pass/fail with no list is a finding nobody can act on.
const A11Y_PROBE = `(() => {
  const SEL = 'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
  const out = { small: [], tiny: [], faded: [], hueOnly: [] };
  const name = (el) => (el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : el.tagName.toLowerCase())
    + (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label').slice(0,22) + ']' : '');
  // Effective hit box: the border box, grown by a ::before/::after expander (§8.2's pattern).
  const hit = (el) => {
    const r = el.getBoundingClientRect();
    let w = r.width, h = r.height;
    for (const pe of ['::before', '::after']) {
      const s = getComputedStyle(el, pe);
      if (s.content === 'none' || s.position !== 'absolute') continue;
      const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
      w = Math.max(w, r.width - px(s.left) - px(s.right));
      h = Math.max(h, r.height - px(s.top) - px(s.bottom));
    }
    return { w, h };
  };
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;                 // not on screen
    if (el.closest('[hidden]') || getComputedStyle(el).visibility === 'hidden') continue;
    const { w, h } = hit(el);
    if (w < 43.5 || h < 43.5) out.small.push(name(el) + ' ' + Math.round(w) + 'x' + Math.round(h));
  }
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasOwnText) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const fs = parseFloat(s.fontSize);
    if (fs < 12) out.tiny.push(name(el) + ' ' + fs.toFixed(1) + 'px');
    // §8.1: text may never be quieted by alpha. Walk up: a faded ancestor fades this text too.
    let node = el, alpha = 1;
    while (node && node !== document.body) { alpha *= parseFloat(getComputedStyle(node).opacity); node = node.parentElement; }
    if (alpha < 0.999 && alpha > 0.02) out.faded.push(name(el) + ' opacity ' + alpha.toFixed(2));
  }
  return out;
})()`;

// Held outside the run so a run that stops on an error still closes them (a browser left open keeps node alive: on
// 21 Nov a stop at "composer" left the gate's ticket waiting 9 minutes).
let chrome = null, cdp = null;
(async () => {
  chrome = await launchChrome({ args: [
    "--disable-gpu", "--disable-features=Translate,MediaRouter", "--window-size=390,844",
    "about:blank",
  ] });
  cdp = await CDP.connect(chrome.wsUrl);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: S } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  const routerSrc = patchRouter(fs.readFileSync(path.join(REPO, "public/js/router.js"), "utf8"));
  // The SERVICE WORKER has to be intercepted too, not just the page. sw.js precaches
  // /js/router.js with its own fetch() from inside the worker, and a worker is a separate CDP
  // target — patch only the page and the worker quietly caches the real, route-less file, so
  // the first genuine offline reload routes #/memories nowhere. That is precisely the failure
  // this script exists to catch, and it would have hidden behind a same-document navigation.
  // Every navigation carries a fresh query. Page.navigate to a URL that differs only in its
  // fragment is a SAME-DOCUMENT navigation — nothing reloads, and an "offline mount" that is
  // really the previous document still standing proves nothing at all.
  let nav = 0;
  const swSessions = new Set();
  const serveRouter = async (session, requestId) => {
    await cdp.send("Fetch.fulfillRequest", {
      requestId, responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "text/javascript; charset=utf-8" }],
      body: Buffer.from(routerSrc, "utf8").toString("base64"),
    }, session);
  };
  cdp.on(async (msg) => {
    if (msg.method === "Target.attachedToTarget" && msg.params.targetInfo.type === "service_worker") {
      const sid = msg.params.sessionId;
      swSessions.add(sid);
      try {
        await cdp.send("Fetch.enable", { patterns: FETCHED }, sid);
        await cdp.send("Runtime.runIfWaitingForDebugger", {}, sid);
      } catch { }
      return;
    }
    if (msg.method !== "Fetch.requestPaused") return;
    if (msg.sessionId !== S && !swSessions.has(msg.sessionId)) return;
    const { requestId, request } = msg.params;
    try {
      if (/\/js\/router\.js/.test(request.url)) await serveRouter(msg.sessionId, requestId);
      else if (NOCSS && /\/css\/memories\.css/.test(request.url)) {
        plantedCss = true;
        await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 404, responseHeaders: [{ name: "content-type", value: "text/plain" }], body: "" }, msg.sessionId);
      }
      else await cdp.send("Fetch.continueRequest", { requestId }, msg.sessionId);
    } catch { }
  });
  await cdp.send("Target.setAutoAttach",
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, S);

  await cdp.send("Page.enable", {}, S);
  await cdp.send("Runtime.enable", {}, S);
  await cdp.send("Network.enable", {}, S);
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, S);
  // Signed in as the host of the gate's made-up trip, with a session of this run's own.
  for (const c of await signedIn()) await cdp.send("Network.setCookie", c, S);
  // NOT bypassing the worker here: the worker IS the thing under test.
  await cdp.send("Fetch.enable", { patterns: FETCHED }, S);

  // ── 0. bring our own content ────────────────────────────────────────────────────────────
  // This suite used to require a non-empty feed and say so nowhere, so running it on a clean
  // trip — which is exactly the state the checks that seed and delete their own rows
  // leave behind — spent about ten minutes stacking 30-45s waits for thumbs that could never
  // paint, then failed. A check that fails for a reason unrelated to the code under test teaches
  // people to ignore it, and this is the check that says whether Memories works on the four days
  // of the trek with no signal. So it seeds its own row now. seedMemories() wires its own
  // cleanup to process exit, so an abort cannot leave rows behind to break the row-counting
  // suites. WGP_KEEP=1 still leaves them, for chaining by hand.
  log("seeding a memory so the feed has something to cache");
  const seeded = await seedMemories(1);
  log(`seeded ${seeded.ids.length} memory; deleted on exit unless WGP_KEEP=1`);

  // ── 1. the offline shell ────────────────────────────────────────────────────────────────
  log("booting the app with the real service worker");
  await cdp.send("Page.navigate", { url: `${BASE}/t/${TRIP}/?n=${++nav}#/memories` }, S);
  await waitFor(cdp, S, `!!document.querySelector('#view .me-feed')`, { timeout: 45000, label: "Memories mounts online" });
  check("the Memories tab mounts under the real service worker", true);

  log("waiting for install + topUp + crawlAssets to settle");
  await waitFor(cdp, S, `navigator.serviceWorker.controller ? 1 : null`, { timeout: 45000, label: "the worker takes control" });
  let keys = [];
  for (let i = 0; i < 40; i++) {
    keys = await evalIn(cdp, S,
      // The cache NAME carries sw.js's VERSION, so naming a version here is an assertion with
      // a shelf life: this said 'wegoplace-shell-v6' while sw.js was on v8, so it opened an
      // empty cache (caches.open CREATES one) and reported every module missing. Find the
      // shell cache by its stable prefix instead, and let the version be whatever it is.
      `caches.keys().then(ns => {
         const n = ns.find(x => x.startsWith('wegoplace-shell-'));
         return n ? caches.open(n).then(c=>c.keys()).then(k=>k.map(r=>new URL(r.url).pathname)) : [];
       })`);
    if (keys.includes("/js/memories.js") && keys.includes("/css/memories.css")) break;
    await sleep(1500);
  }
  console.log("     shell cache holds " + keys.length + " entries");
  const need = ["/js/memories.js", "/js/memories-save.js", "/css/memories.css"];
  for (const f of need) {
    check(`the offline shell precaches ${f}`, keys.includes(f),
      keys.includes(f) ? "" : `NOT in the ${keys.length}-entry shell cache`);
  }
  check("the v6 changes did not cost the shell its existing modules",
    ["/", "/styles.css", "/js/store.js", "/js/router.js", "/js/util.js", "/js/agenda.js",
     "/js/places.js", "/js/packing.js", "/js/map.js", "/js/settings.js", "/js/icons.js",
     "/js/motion.js", "/js/sheet.js"].every((f) => keys.includes(f)),
    keys.join(" "));

  log("killing the network and re-mounting the tab from cache alone");
  // Chrome's own HTTP cache would answer for memories.js and every thumb, which turns this
  // into a test of the browser rather than of the precache. Emptying it first is what makes
  // the next three assertions about the SERVICE WORKER's caches — the only ones a phone that
  // has been in a tent for four days still has.
  await cdp.send("Network.clearBrowserCache", {}, S);
  // The PAGE and the WORKER are separate network contexts. Cutting only the page leaves the
  // service worker with a live route out, quietly refetching and re-caching behind the test —
  // which is how "offline" passes while nothing offline was ever exercised.
  const setOffline = async (offline) => {
    const cond = { offline, latency: 0, downloadThroughput: offline ? 0 : -1, uploadThroughput: offline ? 0 : -1 };
    await cdp.send("Network.emulateNetworkConditions", cond, S);
    for (const sid of swSessions) {
      try {
        await cdp.send("Network.enable", {}, sid);
        await cdp.send("Network.emulateNetworkConditions", cond, sid);
      } catch { /* worker already gone */ }
    }
  };
  check("the service worker is attached, so it can be cut off too", swSessions.size > 0,
    `${swSessions.size} worker session(s)`);
  // One more ONLINE load, and this one matters: the very first launch runs uncontrolled until
  // the worker's clients.claim() lands, so its thumbnail requests never reach the worker and
  // could never have been cached. Every launch after the first is controlled — that is the one
  // to measure, and measuring the first instead would report a defect the device never has.
  await cdp.send("Page.navigate", { url: `${BASE}/t/${TRIP}/?n=${++nav}#/memories` }, S);
  await waitFor(cdp, S, `!!document.querySelector('#view .me-feed')`, { timeout: 45000, label: "controlled reload" });
  check("this load is under the worker's control",
    await evalIn(cdp, S, `!!navigator.serviceWorker.controller`));
  await waitFor(cdp, S, `[...document.querySelectorAll('.me-cell img')].length
    && [...document.querySelectorAll('.me-cell img')].every(i=>i.complete) ? 1 : null`,
    { timeout: 30000, label: "thumbs painted" });
  await sleep(1500);

  const mediaCacheOnline = await evalIn(cdp, S, `(async()=>{
    const c = await caches.open('wegoplace-media-v1');
    const ks = (await c.keys()).map(r=>r.url);
    let idx = null;
    const hit = await c.match('https://media-index.wegoplace.invalid/v1');
    if (hit) idx = await hit.json();
    return { keys: ks.map(u=>u.replace(location.origin,'')), index: idx && idx.e };
  })()`);
  check("the thumbs the feed just rendered went into the media cache",
    mediaCacheOnline.keys.filter((k) => k.startsWith("/media/t/")).length > 0,
    JSON.stringify(mediaCacheOnline).slice(0, 500));
  await setOffline(true);
  await cdp.send("Page.navigate", { url: `${BASE}/t/${TRIP}/?n=${++nav}#/memories` }, S);
  let offlineMounted = false, offlineErr = "";
  try {
    await waitFor(cdp, S, `!!document.querySelector('#view .me-feed')`, { timeout: 30000, label: "offline mount" });
    offlineMounted = true;
  } catch (e) { offlineErr = String(e.message); }
  check("the Memories tab opens with NO network at all", offlineMounted, offlineErr);
  if (offlineMounted) {
    // .me-title is sized only by css/memories.css (--t-title, 28 px); without that sheet the <h1> is the
    // browser's own 2em.
    check("its stylesheet came with it (the tab is styled offline)",
      await evalIn(cdp, S, `getComputedStyle(document.querySelector('.me-title')).fontSize === '28px'`),
      await evalIn(cdp, S, `getComputedStyle(document.querySelector('.me-title')).fontSize`));
    // Nothing opened the viewer, so no original or thumb was ever pinned into the MEDIA cache
    // and the HTTP cache is empty: every tile in this feed is genuinely undownloaded. It has
    // to SAY so — with the dashed tray, a shape, because on a daltonized display a
    // grey-versus-grey tile carries no state at all.
    await sleep(1500);
    const cells = await evalIn(cdp, S, `(()=>{const c=[...document.querySelectorAll('.me-cell')];return{
      n:c.length, miss:c.filter(x=>x.dataset.miss==='1').length, ok:c.filter(x=>x.dataset.ok==='1').length}})()`);
    check("an undownloaded tile shows the dashed not-yet-downloaded mark, not a broken image",
      cells.n > 0 && cells.miss === cells.n - cells.ok, JSON.stringify(cells));
    check("a thumb seen online IS there offline (the spec's whole offline promise)",
      cells.ok === cells.n, JSON.stringify(cells));

    // Now the case the trek actually produces: a memory somebody else posted that this phone
    // never saw with a radio. Drop the media cache and reload, still offline — nothing can
    // answer for those thumbs and the feed has to say so in a shape.
    // A reload is not enough here and memories.js says why in markMisses(): the renderer keeps
    // its own decoded-image cache, so a tile can keep painting from a bitmap the Cache API no
    // longer holds. Drop the media cache, drop the browser cache, and take a FRESH document.
    await evalIn(cdp, S, `caches.delete('wegoplace-media-v1')`);
    await cdp.send("Network.clearBrowserCache", {}, S);
    await cdp.send("Page.navigate", { url: `${BASE}/t/${TRIP}/?n=${++nav}#/memories` }, S);
    await waitFor(cdp, S, `document.querySelectorAll('.me-cell').length ? 1 : null`,
      { timeout: 30000, label: "cold offline feed" });
    await sleep(2500);
    const cold = await evalIn(cdp, S, `(async()=>{const c=[...document.querySelectorAll('.me-cell')];
      const s=await import('/js/store.js');
      return { n:c.length, miss:c.filter(x=>x.dataset.miss==='1').length,
        painted:c.filter(x=>{const i=x.querySelector('img');return i&&i.naturalWidth>0}).length,
        online:s.store.online(), navOnline:navigator.onLine };})()`);
    check("a thumb that was never downloaded is marked, not left as a broken tile",
      cold.n > 0 && cold.miss === cold.n, JSON.stringify(cold));
    check("that mark is a SHAPE — dashed outline plus a tray glyph, never a hue",
      await evalIn(cdp, S, `(()=>{const c=document.querySelector('.me-cell[data-miss="1"]');
        if(!c) return false;
        const s=getComputedStyle(c);
        return /dashed/.test(s.outlineStyle) && !!c.querySelector('.me-cellmark svg')
          && getComputedStyle(c.querySelector('.me-cellmark')).display !== 'none'})()`));
  }
  await setOffline(false);

  // ── 2. the §8 sweep, both themes ────────────────────────────────────────────────────────
  log("§8 sweep at 390x844, both themes");
  for (const theme of ["light", "dark"]) {
    await evalIn(cdp, S, `localStorage.setItem('wgp.theme','${theme}')`);
    await cdp.send("Page.navigate", { url: `${BASE}/t/${TRIP}/?n=${++nav}#/memories` }, S);
    await waitFor(cdp, S, `!!document.querySelector('#view .me-feed')`, { timeout: 45000, label: "feed (" + theme + ")" });
    await evalIn(cdp, S, `document.documentElement.setAttribute('data-theme','${theme}')`);
    await waitFor(cdp, S, `document.querySelectorAll('.me-card').length ? 1 : (document.querySelector('#view .empty')?1:null)`,
      { timeout: 30000, label: "feed painted" });
    await sleep(600);

    // The fifth tab is the one integration change to a bar that was designed for four. At
    // 390px the columns drop from 97px to 78px, so the labels have to be measured, not
    // assumed — styles.css puts no white-space or ellipsis rule on them, which means an
    // overflow would wrap and push the glyph out of a fixed-height bar.
    const tabs = await evalIn(cdp, S, `[...document.querySelectorAll('.tabbar .tab')].map(t=>{
      const s=t.querySelector('span:not(.ds-tab-dot)');
      const r=t.getBoundingClientRect(), sr=s.getBoundingClientRect();
      return { tab:t.dataset.tab, col:Math.round(r.width), h:Math.round(r.height),
               label:Math.round(sr.width), lines:Math.round(sr.height/ (parseFloat(getComputedStyle(s).lineHeight)||16)) };})`);
    check(`[${theme}] every tab's name fits: no label wider than its column`,
      tabs.every((t) => t.label <= t.col - 4), JSON.stringify(tabs));
    check(`[${theme}] no tab label wrapped to a second line`,
      tabs.every((t) => t.lines <= 1), JSON.stringify(tabs));
    check(`[${theme}] the tab bar kept its height with a fifth tab in it`,
      new Set(tabs.map((t) => t.h)).size === 1, JSON.stringify(tabs.map((t) => t.h)));

    const feed = await evalIn(cdp, S, A11Y_PROBE);
    check(`[${theme}] feed: every tap target reaches 44px`, feed.small.length === 0, feed.small.join(" | "));
    check(`[${theme}] feed: no text under 12px`, feed.tiny.length === 0, feed.tiny.join(" | "));
    check(`[${theme}] feed: no text quieted by opacity`, feed.faded.length === 0, feed.faded.join(" | "));

    // Add photos: the phone's picker first, answered with a made-up photo, then its one sheet.
    await pickPhotos({ ...cdpPage(cdp, S), files: [madePhoto()] });
    await waitFor(cdp, S, `document.querySelectorAll('.me-pickrow').length === 1`, { label: "composer" });
    await sleep(500);
    const comp = await evalIn(cdp, S, A11Y_PROBE);
    check(`[${theme}] composer: every tap target reaches 44px`, comp.small.length === 0, comp.small.join(" | "));
    check(`[${theme}] composer: no text under 12px`, comp.tiny.length === 0, comp.tiny.join(" | "));
    check(`[${theme}] composer: no text quieted by opacity`, comp.faded.length === 0, comp.faded.join(" | "));
    await evalIn(cdp, S, `document.querySelector('.sh-x, .sh-scrim')?.click()`);
    await sleep(500);

    const hasCard = await evalIn(cdp, S, `!!document.querySelector('.me-cell')`);
    if (hasCard) {
      await evalIn(cdp, S, `document.querySelector('.me-cell').click()`);
      await waitFor(cdp, S, `!!document.querySelector('.me-view')`, { label: "viewer" });
      await sleep(500);
      const view = await evalIn(cdp, S, A11Y_PROBE);
      check(`[${theme}] viewer: every tap target reaches 44px`, view.small.length === 0, view.small.join(" | "));
      check(`[${theme}] viewer: no text under 12px`, view.tiny.length === 0, view.tiny.join(" | "));
      check(`[${theme}] viewer: no text quieted by opacity`, view.faded.length === 0, view.faded.join(" | "));
      await evalIn(cdp, S, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      await sleep(400);
    } else {
      console.log(`     (no memory in the feed — viewer sweep skipped for ${theme})`);
    }
  }

  // ── 3. reduced motion kills everything ─────────────────────────────────────────────────
  await cdp.send("Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
  await cdp.send("Page.navigate", { url: `${BASE}/t/${TRIP}/?n=${++nav}#/memories` }, S);
  await waitFor(cdp, S, `!!document.querySelector('#view .me-feed')`, { timeout: 45000, label: "feed (reduced motion)" });
  await sleep(900);
  const anims = await evalIn(cdp, S,
    `document.getAnimations().filter(a=>a.playState==='running').map(a=>a.animationName||'web-animation')`);
  check("prefers-reduced-motion leaves nothing animating", anims.length === 0, anims.join(","));
  const longTrans = await evalIn(cdp, S, `[...document.querySelectorAll('#view *, .me-fab')]
    .map(el=>({n:el.className, d:getComputedStyle(el).transitionDuration}))
    .filter(x=>x.d && x.d.split(',').some(v=>parseFloat(v)>0.02)).map(x=>x.n+':'+x.d).slice(0,6)`);
  check("no transition survives reduced motion", longTrans.length === 0, longTrans.join(" | "));

  cdp.close();
  await chrome.close();
  if (NOCSS && !plantedCss) { console.log("Error: the nocss plant changed nothing"); process.exitCode = 1; }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("failures: " + failures.join(" | ")); process.exitCode = 1; }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
})().catch(async (e) => {
  console.error("harness error:", e && e.stack || e);
  process.exitCode = 2;
  if (cdp) cdp.close();
  if (chrome) await chrome.close().catch(() => {});
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
});

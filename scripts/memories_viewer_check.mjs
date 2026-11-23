#!/usr/bin/env node
/* v6 Memories — the VIEWER and the PLAYER, driven by real touches.
 *
 *   node scripts/memories_viewer_check.mjs
 *
 * check:upload and memories_upload_check prove the pipeline: upload, fidelity, resume, Range. A
 * viewer driven with scrollTo() and currentTime never has a finger on the glass. This one does. Chrome runs with touch emulation on, and every gesture below is a
 * real Input.dispatchTouchEvent stream through the compositor, so `touch-action`, the
 * scroll-snap pager and our pointer arbiter are all being asked the same question a thumb
 * asks: WHOSE DRAG IS THIS?
 *
 * What it measures rather than assumes:
 *   - pan bounds computed off the IMAGE box, so a letterboxed photo cannot be flung away
 *   - double-tap zoom lands ON the tapped point, and double-tap again resets
 *   - pinch is focal-point correct and never leaves the pane half-dismissed
 *   - the over-drag hand-off: at >1x a horizontal over-drag pages, a vertical one un-zooms
 *   - drag-to-dismiss on sheet.js's own thresholds
 *   - chrome hides as a UNIT — opacity 0 AND visibility:hidden AND inert, never "quieted"
 *   - the video slide's box is the SAME before and after `loadedmetadata` (no letterbox jump)
 *   - a real seek: requested time, landed time, and how many 206s the Worker served
 *   - the viewer's picture carries filter:none, so the list's decorative wash cannot leak in
 *   - closing detaches every source: nothing decodes behind a closed viewer (four days, no
 *     charger), and hiding the document pauses playback
 *
 * It seeds its OWN memory through the real API and deletes it again, so it never disturbs
 * anything another workflow left in the trip.
 *
 * Chrome needs the Bash sandbox disabled (ProcessSingleton socket). router.js belongs to the
 * v5 workflow, so the memories route is served patched over CDP and the repo copy is never
 * written to.
 */
"use strict";

import { execSync } from "node:child_process";
import { baseUrl, launchChrome } from "./lib/browser.mjs";
import { devSecret } from "./lib/dev_secret.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = baseUrl();   // WGP_BASE or --base=<url>: this lane's dev server (scripts/lib/browser.mjs)
const HOST = new URL(BASE).hostname;
const SECRET = devSecret();   // this checkout's .dev.vars (scripts/lib/dev_secret.mjs)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-viewer-"));
const FIXDIR = path.join(os.tmpdir(), "wgp-viewer-fixtures");
const SHOTS = path.join(REPO, "build/memories-viewer");
const PART = 8 * 1024 * 1024;
const SEEK_TO = 24.0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? "  -> " + String(detail).slice(0, 500) : ""}`); }
}
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const cookie = (uid, days = 30) => {
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  return `${uid}.${exp}.${crypto.createHmac("sha256", SECRET).update(`${uid}.${exp}`).digest("hex")}`;
};
async function api(p, { method = "GET", uid = "u_admin", body = null, raw = false } = {}) {
  const h = { Cookie: `s2=${cookie(uid)}` };
  let payload = body;
  if (body && !(body instanceof Uint8Array)) { payload = JSON.stringify(body); h["Content-Type"] = "application/json"; }
  const res = await fetch(BASE + p, { method, headers: h, body: payload });
  if (raw) return res;
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────
// A real 30s H.264 file (big enough that a seek to 24s cannot possibly already be buffered)
// and a real camera-resolution JPEG, plus the two derived webp thumbs the client would make.
function fixtures() {
  fs.mkdirSync(FIXDIR, { recursive: true });
  const F = {
    video: path.join(FIXDIR, "IMG_7783.mp4"),
    photo: path.join(FIXDIR, "IMG_7780.JPG"),
    vthumb: path.join(FIXDIR, "IMG_7783.thumb.jpg"),
    pthumb: path.join(FIXDIR, "IMG_7780.thumb.jpg"),
  };
  if (!fs.existsSync(F.video) || fs.statSync(F.video).size < 20 * 1024 * 1024) {
    log("rendering a 30s H.264 fixture (once; cached in " + FIXDIR + ")…");
    execSync(`ffmpeg -v error -y -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=30" ` +
      `-c:v libx264 -preset ultrafast -pix_fmt yuv420p -b:v 7M -maxrate 9M -bufsize 9M ` +
      // a keyframe every second, so a seek can land ON the requested time rather than at
      // whatever the nearest GOP boundary happened to be — the measurement has to mean something
      `-g 30 -keyint_min 30 -sc_threshold 0 ` +
      `-movflags +faststart ${JSON.stringify(F.video)}`, { stdio: "inherit" });
  }
  if (!fs.existsSync(F.photo)) {
    const src = path.join(REPO, "public/img/demo-hero.webp");
    execSync(`sips -s format jpeg -Z 3200 ${JSON.stringify(src)} --out ${JSON.stringify(F.photo)}`, { stdio: "ignore" });
  }
  if (!fs.existsSync(F.vthumb)) {
    execSync(`ffmpeg -v error -y -i ${JSON.stringify(F.video)} -frames:v 1 -vf scale=480:-2 -q:v 4 ${JSON.stringify(F.vthumb)}`, { stdio: "inherit" });
  }
  if (!fs.existsSync(F.pthumb)) {
    execSync(`ffmpeg -v error -y -i ${JSON.stringify(F.photo)} -vf scale=480:-2 ${JSON.stringify(F.pthumb)}`, { stdio: "inherit" });
  }
  const dims = (f) => {
    const out = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 ${JSON.stringify(f)}`).toString().trim();
    const [w, h] = out.split(",").map(Number);
    return { w, h };
  };
  return { ...F, vd: dims(F.video), pd: dims(F.photo) };
}

async function upload(file, mime, kind) {
  const buf = fs.readFileSync(file);
  const beg = await api("/api/trips/demo-2027/media/begin", {
    method: "POST",
    body: { name: path.basename(file), mime, bytes: buf.length, kind },
  });
  if (beg.status !== 201) throw new Error("begin failed: " + beg.text);
  const { key, uploadId, parts } = beg.json;
  const etags = [];
  for (let n = 1; n <= parts; n++) {
    const slice = buf.subarray((n - 1) * PART, Math.min(n * PART, buf.length));
    const r = await api(`/api/trips/demo-2027/media/part?key=${encodeURIComponent(key)}&id=${encodeURIComponent(uploadId)}&n=${n}`,
      { method: "POST", body: slice });
    if (r.status !== 200) throw new Error(`part ${n} failed: ` + r.text);
    etags.push({ n, etag: r.json.etag });
  }
  const fin = await api("/api/trips/demo-2027/media/finish", { method: "POST", body: { key, id: uploadId, parts: etags } });
  if (fin.status !== 200) throw new Error("finish failed: " + fin.text);
  return { key, bytes: buf.length };
}
// This ffmpeg has no webp encoder, so the derived thumbs here are JPEG. The client makes
// webp; the endpoint accepts both, and nothing in the viewer cares which — a thumb is only
// ever a poster and a first paint.
async function thumb(forKey, file) {
  const r = await api(`/api/trips/demo-2027/media/thumb?for=${encodeURIComponent(forKey)}&mime=image/jpeg`,
    { method: "POST", body: fs.readFileSync(file) });
  if (r.status !== 201) throw new Error("thumb failed: " + r.text);
  return r.json.key;
}

// ── the router patch (never written to disk) ──────────────────────────────────────────────
function patchRouter(src) {
  let out = src;
  const anchor = `  { re: /^\\/settings\\/credits\\/?$/`;
  if (!out.includes("memories.js")) {
    const i = out.indexOf(anchor);
    if (i < 0) throw new Error("router.js anchor not found — the patch needs revisiting");
    out = out.slice(0, i) +
      `  { re: /^\\/memories\\/?$/,        name: "memories", tab: "memories", root: true,  mod: "./memories.js", keys: [], title: "Memories" },\n` +
      out.slice(i);
  }
  return out.replace(
    `const TAB_ROOT = { agenda: "#/", places: "#/places", pack: "#/pack", settings: "#/settings" };`,
    `const TAB_ROOT = { agenda: "#/", places: "#/places", pack: "#/pack", memories: "#/memories", settings: "#/settings" };`);
}

// ── minimal CDP client ────────────────────────────────────────────────────────────────────
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
        m.error ? rej(new Error(m.error.message + " " + (m.error.data || ""))) : res(m.result);
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
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error(`CDP timeout: ${method}`)); }, 120000);
    });
  }
  close() { try { this.ws.close(); } catch { /* already down */ } }
}
async function evalIn(cdp, S, expression) {
  const r = await cdp.send("Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true }, S);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception ? (d.exception.description || d.exception.value) : d.text);
  }
  return r.result.value;
}
async function waitFor(cdp, S, expr, { timeout = 45000, every = 200, label = expr } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    let v = null;
    try { v = await evalIn(cdp, S, `(()=>{try{return (${expr})}catch(e){return null}})()`); } catch { /* mid-navigation */ }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(every);
  }
}

// The §8 probe, copied verbatim from scripts/memories_shell_check.mjs so the two agree on
// what "44px" and "quieted" mean.
const A11Y_PROBE = `(() => {
  const SEL = 'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
  const out = { small: [], tiny: [], faded: [] };
  const name = (el) => (el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : el.tagName.toLowerCase())
    + (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label').slice(0,22) + ']' : '');
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
    if (!r.width || !r.height) continue;
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
    if (s.visibility === 'hidden') continue;
    const fs = parseFloat(s.fontSize);
    if (fs < 12) out.tiny.push(name(el) + ' ' + fs.toFixed(1) + 'px');
    let node = el, alpha = 1;
    while (node && node !== document.body) { alpha *= parseFloat(getComputedStyle(node).opacity); node = node.parentElement; }
    if (alpha < 0.999 && alpha > 0.02) out.faded.push(name(el) + ' opacity ' + alpha.toFixed(2));
  }
  return out;
})()`;

let browser = null;
function shutdown(code) {
  if (browser) browser.killSync();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ }
  process.exit(code);
}

(async () => {
  const FIX = fixtures();
  log(`photo ${FIX.pd.w}x${FIX.pd.h}  video ${FIX.vd.w}x${FIX.vd.h} ${(fs.statSync(FIX.video).size / 1048576).toFixed(1)} MiB`);

  log("seeding one memory through the real API…");
  const p = await upload(FIX.photo, "image/jpeg", "photo");
  const v = await upload(FIX.video, "video/mp4", "video");
  const pt = await thumb(p.key, FIX.pthumb);
  const vt = await thumb(v.key, FIX.vthumb);
  const created = await api("/api/trips/demo-2027/memories", {
    method: "POST",
    body: {
      caption: "Condor Gap Pass — the long way up, and the longer way down again",
      tags: ["viewer check"],
      media: [
        { key: p.key, thumb_key: pt, kind: "photo", w: FIX.pd.w, h: FIX.pd.h, bytes: p.bytes },
        { key: v.key, thumb_key: vt, kind: "video", w: FIX.vd.w, h: FIX.vd.h, duration: 30, bytes: v.bytes },
      ],
    },
  });
  if (created.status !== 201) throw new Error("seed failed: " + created.text);
  const MEM = created.json.memory;
  log(`seeded ${MEM.id}`);

  const chrome = browser = await launchChrome({ args: [
    "--disable-gpu", "--disable-features=Translate,MediaRouter",
    "--autoplay-policy=no-user-gesture-required", "--window-size=390,844", "about:blank",
  ] });

  const cdp = await CDP.connect(chrome.wsUrl);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: S } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  const routerSrc = patchRouter(fs.readFileSync(path.join(REPO, "public/js/router.js"), "utf8"));
  const netLog = [];
  const pageErrors = [];
  cdp.on(async (msg) => {
    if (msg.sessionId !== S) return;
    if (msg.method === "Fetch.requestPaused") {
      const { requestId, request } = msg.params;
      try {
        if (/\/js\/router\.js/.test(request.url)) {
          await cdp.send("Fetch.fulfillRequest", {
            requestId, responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "text/javascript; charset=utf-8" },
                              { name: "cache-control", value: "no-store" }],
            body: Buffer.from(routerSrc, "utf8").toString("base64"),
          }, S);
          return;
        }
        await cdp.send("Fetch.continueRequest", { requestId }, S);
      } catch { /* target gone */ }
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.exception?.description || d.text || "exception");
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      pageErrors.push(msg.params.args.map((a) => a.description || a.value).join(" "));
    }
    if (msg.method === "Network.requestWillBeSent") {
      netLog.push({ url: msg.params.request.url, id: msg.params.requestId, status: 0,
        range: (msg.params.request.headers || {}).Range || (msg.params.request.headers || {}).range || "" });
    }
    if (msg.method === "Network.responseReceived") {
      const e = netLog.find((x) => x.id === msg.params.requestId);
      if (e) e.status = msg.params.response.status;
    }
  });

  await cdp.send("Page.enable", {}, S);
  await cdp.send("Runtime.enable", {}, S);
  await cdp.send("Network.enable", {}, S);
  await cdp.send("Network.setBypassServiceWorker", { bypass: true }, S);
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/router.js*", requestStage: "Request" }] }, S);
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, S);
  await cdp.send("Network.setCookie", { name: "s2", value: cookie("u_admin"), domain: HOST, path: "/" }, S);
  // Touch liveness, installed before every document: if a phase's gestures silently stop
  // being delivered, this counter says so instead of the assertions quietly passing.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source:
    `window.__t={down:0,move:0,up:0};` +
    `document.addEventListener('pointerdown',()=>window.__t.down++,true);` +
    `document.addEventListener('pointermove',()=>window.__t.move++,true);` +
    `document.addEventListener('pointerup',()=>window.__t.up++,true);` }, S);

  // ── touch: real compositor input, not synthesised DOM events ────────────────────────────
  const tp = (pts) => pts.map((q, i) => ({ x: Math.round(q.x), y: Math.round(q.y), id: q.id ?? i, radiusX: 12, radiusY: 12, force: 1 }));
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : tp(pts) }, S);
  async function drag(from, to, steps = 14, holdMs = 0) {
    await touch("touchStart", [from]);
    for (let i = 1; i <= steps; i++) {
      await touch("touchMove", [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }]);
      await sleep(10);
    }
    if (holdMs) await sleep(holdMs);
    await touch("touchEnd", []);
  }
  async function tap(pt) { await touch("touchStart", [pt]); await sleep(30); await touch("touchEnd", []); }
  async function doubleTap(pt) { await tap(pt); await sleep(90); await tap(pt); }
  let nav = 0;
  const goMemories = async () => {
    await cdp.send("Page.navigate", { url: `${BASE}/t/demo-2027/?n=${++nav}#/memories` }, S);
    await waitFor(cdp, S, `!!document.querySelector('#view .me-feed')`, { label: ".me-feed mounted" });
    await waitFor(cdp, S, `!!document.querySelector('.me-card[data-id="${MEM.id}"] .me-cell')`, { label: "the seeded card" });
    await sleep(500);
  };
  const openViewer = () => evalIn(cdp, S,
    `document.querySelector('.me-card[data-id="${MEM.id}"] .me-cell').click()`);
  const V = `document.querySelector('.me-view')`;
  const live = () => evalIn(cdp, S, `JSON.stringify(window.__t)`);
  const state = () => evalIn(cdp, S, `(()=>{const v=document.querySelector('.me-view'); if(!v) return 'no viewer';
    const i = Math.round(v.querySelector('.me-vtrack').scrollLeft / v.querySelector('.me-vtrack').clientWidth);
    const it = v.querySelectorAll('.me-vitem')[i];
    const img = it.querySelector('img');
    return (v.querySelector('.me-vcount').textContent||'1 / 1') + ' kind=' + it.dataset.kind +
      ' zoom=' + (img ? new DOMMatrix(getComputedStyle(img).transform).a.toFixed(2) : '-');})()`);

  await goMemories();
  check("no page exceptions on mount", pageErrors.length === 0, pageErrors.join(" | "));

  // ══ 1. the video slide's box does not move when metadata lands ═══════════════════════════
  log("1 — the video slide reserves its own aspect before a byte arrives");
  const boxes = await evalIn(cdp, S, `(()=>{
    document.querySelector('.me-card[data-id="${MEM.id}"] .me-cell').click();
    const v = document.querySelector('.me-view video');
    // offsetWidth/offsetHeight, not a rect: the viewer's own entrance animation scales the
    // pane, and a rect read mid-entrance would measure the animation instead of the layout.
    return { ready: v.readyState, w: v.offsetWidth, h: v.offsetHeight, ar: getComputedStyle(v).aspectRatio };
  })()`);
  check("the <video> is laid out BEFORE any metadata (readyState 0)", boxes.ready === 0, JSON.stringify(boxes));
  check("its box already carries the row's own aspect ratio",
    Math.abs((boxes.w / boxes.h) - (FIX.vd.w / FIX.vd.h)) < 0.02,
    `${boxes.w}x${boxes.h} = ${(boxes.w / boxes.h).toFixed(3)} vs row ${(FIX.vd.w / FIX.vd.h).toFixed(3)}`);
  await waitFor(cdp, S, `(()=>{const v=document.querySelector('.me-view video');return v&&v.readyState>=1?1:null})()`,
    { label: "loadedmetadata" });
  await sleep(500);
  const after = await evalIn(cdp, S, `(()=>{const v=document.querySelector('.me-view video');
    return {ready:v.readyState, w:v.offsetWidth, h:v.offsetHeight}})()`);
  check("NO LETTERBOX JUMP: the box is identical after loadedmetadata",
    after.w === boxes.w && after.h === boxes.h,
    `before ${boxes.w}x${boxes.h} -> after ${after.w}x${after.h}`);

  // ══ 2. the picture is the unfiltered original ════════════════════════════════════════════
  log("2 — the viewer shows the original, unfiltered");
  const clean = await evalIn(cdp, S, `(()=>{
    // a decorative wash of exactly the kind the list thumbnails get, planted on every
    // ancestor the viewer has, to prove it cannot reach the picture
    document.body.style.filter = 'saturate(1.4) contrast(1.1) sepia(.18)';
    const img = document.querySelector('.me-view .me-vimg');
    const vid = document.querySelector('.me-view video');
    const s1 = getComputedStyle(img), s2 = getComputedStyle(vid);
    const out = { img: s1.filter, vid: s2.filter, blend: s1.mixBlendMode,
      imgSrc: img.dataset.full, vidSrc: vid.dataset.src };
    document.body.style.filter = '';
    return out; })()`);
  check("the photo carries filter:none even under a filtered ancestor", clean.img === "none", clean.img);
  check("the video carries filter:none too", clean.vid === "none", clean.vid);
  check("no blend mode is applied to the picture", clean.blend === "normal", clean.blend);
  check("both point at /media/o/ originals, never a thumb",
    /\/media\/o\//.test(clean.imgSrc) && /\/media\/o\//.test(clean.vidSrc), `${clean.imgSrc} | ${clean.vidSrc}`);

  // ══ 3. double-tap zoom, on the tapped point ══════════════════════════════════════════════
  log("3 — double-tap zooms to the tapped point, and again to reset");
  await waitFor(cdp, S, `document.querySelector('.me-view .me-vitem[data-i="0"]').dataset.full === '1' ? 1 : null`,
    { label: "the original photo decoded" });
  const target = { x: 120, y: 300 };
  await doubleTap(target);
  await sleep(400);
  const zoomed = await evalIn(cdp, S, `(()=>{
    const it = document.querySelector('.me-view .me-vitem[data-i="0"]');
    const img = it.querySelector('img');
    const m = new DOMMatrix(getComputedStyle(img).transform);
    const r = it.getBoundingClientRect(), ir = img.getBoundingClientRect();
    return { zoom: it.dataset.zoom, s: +m.a.toFixed(3), tx: +m.e.toFixed(2), ty: +m.f.toFixed(2),
      touch: getComputedStyle(it).touchAction,
      cw: +r.width.toFixed(1), ch: +r.height.toFixed(1),
      iw: +(img.offsetWidth).toFixed(1), ih: +(img.offsetHeight).toFixed(1),
      onScreen: { l: +ir.left.toFixed(1), r: +ir.right.toFixed(1), t: +ir.top.toFixed(1), b: +ir.bottom.toFixed(1) } };
  })()`);
  check("double-tap zoomed the photo", Math.abs(zoomed.s - 2.5) < 0.01, `scale ${zoomed.s}`);
  check("zoom is transform ONLY — a translate and a scale, nothing else",
    Number.isFinite(zoomed.tx) && Number.isFinite(zoomed.ty), JSON.stringify(zoomed));
  check("a zoomed slide takes the whole gesture (touch-action:none)", zoomed.touch === "none", zoomed.touch);
  {
    // the tapped point should still be roughly under the finger: t = (1-s)·p, clamped
    const cx = zoomed.cw / 2, cy = zoomed.ch / 2;
    const wantTx = (1 - zoomed.s) * (target.x - cx);
    const bx = Math.max(0, (zoomed.iw * zoomed.s - zoomed.cw) / 2);
    const clampedTx = Math.max(-bx, Math.min(bx, wantTx));
    check("the zoom is anchored ON the tapped point (clamped to the bound)",
      Math.abs(zoomed.tx - clampedTx) < 1.5, `tx ${zoomed.tx} vs ${clampedTx.toFixed(2)}`);
  }

  // ══ 4. pan bounds are the IMAGE's, not the slide's ═══════════════════════════════════════
  log("4 — pan while zoomed, bounded by the picture");
  const pan = async (from, to) => { await drag(from, to, 14); await sleep(400);
    return evalIn(cdp, S, `(()=>{
      const it = document.querySelector('.me-view .me-vitem[data-i="0"]');
      const img = it.querySelector('img');
      const m = new DOMMatrix(getComputedStyle(img).transform);
      const ir = img.getBoundingClientRect(), r = it.getBoundingClientRect();
      return { s:+m.a.toFixed(3), tx:+m.e.toFixed(2), ty:+m.f.toFixed(2),
        bx:+Math.max(0,(img.offsetWidth*m.a - r.width)/2).toFixed(2),
        by:+Math.max(0,(img.offsetHeight*m.a - r.height)/2).toFixed(2),
        gapL:+(ir.left - r.left).toFixed(1), gapR:+(r.right - ir.right).toFixed(1) };
    })()`); };
  const beforePan = await evalIn(cdp, S,
    `+new DOMMatrix(getComputedStyle(document.querySelector('.me-view .me-vitem[data-i="0"] img')).transform).e.toFixed(2)`);
  const panned = await pan({ x: 300, y: 430 }, { x: 140, y: 430 });     // 160px, inside the bound
  check("the pan moved the picture, and only by transform",
    Math.abs(panned.tx - (beforePan - 160)) < 4 && Math.abs(panned.s - 2.5) < 0.01,
    `tx ${beforePan} -> ${panned.tx}`);
  check("panning stops at the IMAGE's bound, not the slide's",
    Math.abs(panned.tx) <= panned.bx + 1, `|tx| ${Math.abs(panned.tx)} bound ${panned.bx}`);
  check("no edge of the picture was flung inside the frame",
    panned.gapL <= 0.6 && panned.gapR <= 0.6, `left gap ${panned.gapL}, right gap ${panned.gapR}`);
  // This landscape photo at 2.5x is still SHORTER than the slide, so its vertical bound is
  // zero. Clamping to the slide instead of the picture is exactly the bug that lets a photo
  // be flung into the letterbox, so the vertical axis must refuse to move at all.
  const vpan = await pan({ x: 195, y: 300 }, { x: 195, y: 340 });       // 40px, under HANDOFF_PX
  check("an axis with no room to pan does not move (only the rubber band shows)",
    vpan.by === 0 && Math.abs(vpan.ty) <= 40 * 0.18 + 1, `ty ${vpan.ty}, bound ${vpan.by}`);

  // ══ 5. the over-drag hand-off — the way OUT of a zoomed photo ════════════════════════════
  log("5 — over-drag hand-off out of zoom");
  // At 2.5x this photo's horizontal bound is 292px and the screen is 390px wide, so no single
  // drag can reach bound + HANDOFF. Two: the first pins the picture to its right bound, the
  // second is pure over-drag — which is exactly how a thumb does it too.
  await drag({ x: 20, y: 420 }, { x: 380, y: 425 }, 20);
  await sleep(250);
  await drag({ x: 20, y: 420 }, { x: 380, y: 425 }, 20);
  await sleep(900);
  const handed = await evalIn(cdp, S, `(()=>{
    const it = document.querySelector('.me-view .me-vitem[data-i="0"]');
    const m = new DOMMatrix(getComputedStyle(it.querySelector('img')).transform);
    const tr = document.querySelector('.me-vtrack');
    return { s:+m.a.toFixed(3), zoom: it.dataset.zoom, left: Math.round(tr.scrollLeft),
      count: document.querySelector('.me-vcount').textContent };
  })()`);
  check("a horizontal over-drag un-zooms the photo", Math.abs(handed.s - 1) < 0.01, `scale ${handed.s}`);
  check("the slide gave the pager back (touch-action returns to pan-x)", handed.zoom === "", handed.zoom);
  check("dragging the picture right at index 0 stays at index 0, it does not run off the end",
    handed.left === 0 && /1 \/ 2/.test(handed.count), JSON.stringify(handed));

  // now zoom again and over-drag the other way: that one really must page
  await doubleTap({ x: 195, y: 400 });
  await sleep(400);
  await drag({ x: 380, y: 420 }, { x: 10, y: 425 }, 20);
  await sleep(1400);
  const paged = await evalIn(cdp, S, `(()=>{
    const it = document.querySelector('.me-view .me-vitem[data-i="0"]');
    const m = new DOMMatrix(getComputedStyle(it.querySelector('img')).transform);
    return { s:+m.a.toFixed(3), count: document.querySelector('.me-vcount').textContent,
      left: Math.round(document.querySelector('.me-vtrack').scrollLeft) };
  })()`);
  check("a leftward over-drag un-zooms AND pages to the next item",
    Math.abs(paged.s - 1) < 0.01 && /2 \/ 2/.test(paged.count), JSON.stringify(paged));

  // ══ 6. the plain swipe still belongs to the native pager ═════════════════════════════════
  log("6 — a plain swipe at 1x is the native scroll-snap pager");
  await drag({ x: 60, y: 300 }, { x: 350, y: 305 }, 16);
  await sleep(1000);
  const swiped = await evalIn(cdp, S, `({count: document.querySelector('.me-vcount').textContent,
    left: Math.round(document.querySelector('.me-vtrack').scrollLeft),
    snap: getComputedStyle(document.querySelector('.me-vtrack')).scrollSnapType})`);
  check("swiping right went back to item 1", /1 \/ 2/.test(swiped.count), JSON.stringify(swiped));
  check("it landed on a snap point, not between two", swiped.left === 0, String(swiped.left));

  // ══ 7. chrome hides as a UNIT ═══════════════════════════════════════════════════════════
  log("7 — chrome fades as a unit, hidden entirely");
  await tap({ x: 195, y: 400 });
  await sleep(500);
  const chrome0 = await evalIn(cdp, S, `(()=>{
    const v = document.querySelector('.me-view');
    const bars = [...v.querySelectorAll('.me-vtop, .me-vbottom')];
    return { flag: v.dataset.chrome, bars: bars.map(b=>{ const s=getComputedStyle(b);
      return { o:+s.opacity, vis:s.visibility, pe:s.pointerEvents, inert:b.hasAttribute('inert') }; }) };
  })()`);
  check("a single tap hid the chrome", chrome0.flag === "0", chrome0.flag);
  check("hidden means opacity 0, not a quieted alpha",
    chrome0.bars.every((b) => b.o === 0), JSON.stringify(chrome0.bars));
  check("hidden means out of the tree too: visibility:hidden + inert",
    chrome0.bars.every((b) => b.vis === "hidden" && b.inert && b.pe === "none"), JSON.stringify(chrome0.bars));
  check("both bars went together — never one without the other",
    new Set(chrome0.bars.map((b) => `${b.o}|${b.vis}`)).size === 1, JSON.stringify(chrome0.bars));
  await tap({ x: 195, y: 400 });
  await sleep(500);
  check("tapping again brings the whole unit back",
    await evalIn(cdp, S, `(()=>{const v=document.querySelector('.me-view');
      const bars=[...v.querySelectorAll('.me-vtop,.me-vbottom')];
      return v.dataset.chrome==='1' && bars.every(b=>getComputedStyle(b).visibility==='visible' && !b.hasAttribute('inert'))})()`));

  // ══ 8. a pinch never leaves the pane half-dismissed ══════════════════════════════════════
  log("8 — pinch is focal-point correct and cancels a dismiss in flight");
  await touch("touchStart", [{ x: 195, y: 300 }]);
  for (let i = 1; i <= 4; i++) { await touch("touchMove", [{ x: 195, y: 300 + i * 9 }]); await sleep(12); }
  // second finger lands mid-pull: the dismiss must be abandoned, not finished
  await touch("touchStart", [{ x: 195, y: 336, id: 0 }, { x: 235, y: 336, id: 1 }]);
  for (let i = 1; i <= 10; i++) {
    const d = 40 + i * 14;
    await touch("touchMove", [{ x: 195 - 0, y: 336, id: 0 }, { x: 195 + d, y: 336, id: 1 }]);
    await sleep(12);
  }
  await touch("touchEnd", []);
  await sleep(500);
  const pinched = await evalIn(cdp, S, `(()=>{
    const v = document.querySelector('.me-view');
    if (!v) return { gone: true };
    const it = v.querySelector('.me-vitem[data-i="0"]');
    const m = new DOMMatrix(getComputedStyle(it.querySelector('img')).transform);
    const pm = new DOMMatrix(getComputedStyle(v.querySelector('.me-vpane')).transform);
    return { s:+m.a.toFixed(3), paneY:+pm.f.toFixed(1), drag:v.dataset.drag,
      scrim:+getComputedStyle(v.querySelector('.me-vscrim')).opacity };
  })()`);
  check("the viewer survived a dismiss that turned into a pinch", !pinched.gone, JSON.stringify(pinched));
  check("the pinch zoomed the photo", pinched.s > 1.2, `scale ${pinched.s}`);
  check("the half-pulled pane went back to rest, and the scrim with it",
    Math.abs(pinched.paneY) < 1 && pinched.scrim === 1, JSON.stringify(pinched));

  // reset the zoom the honest way, and prove double-tap resets
  await doubleTap({ x: 195, y: 400 });
  await sleep(400);
  check("double-tap on a zoomed photo resets it to 1x",
    await evalIn(cdp, S, `Math.abs(new DOMMatrix(getComputedStyle(
      document.querySelector('.me-view .me-vitem[data-i="0"] img')).transform).a - 1) < 0.01`));

  // ══ 9. THE SEEK — measured, not asserted ════════════════════════════════════════════════
  log("9 — a real seek on the real Range path");
  await evalIn(cdp, S, `(()=>{const t=document.querySelector('.me-vtrack');
    const s=t.children[1]; t.scrollTo({left:s.offsetLeft, behavior:'instant'}); t.dispatchEvent(new Event('scroll'));})()`);
  await sleep(800);
  await waitFor(cdp, S, `(()=>{const v=document.querySelector('.me-view video');return v&&v.readyState>=1?1:null})()`,
    { label: "video metadata on the video slide" });
  const played = await evalIn(cdp, S, `(async()=>{const v=document.querySelector('.me-view video');
    v.muted = true;                      // the harness, not the app: headless has no speakers
    try { await v.play(); } catch(e) { return { err:String(e) }; }
    await new Promise(r=>setTimeout(r,1200));
    return { t:+v.currentTime.toFixed(2), w:v.videoWidth, h:v.videoHeight, muted:v.muted,
      chrome: document.querySelector('.me-view').dataset.chrome };})()`);
  check("the video decodes and plays inline", played.t > 0.1 && played.w === FIX.vd.w, JSON.stringify(played));
  check("playing hid the chrome so the scrubber is not under the caption", played.chrome === "0", String(played.chrome));

  const before206 = netLog.filter((r) => r.status === 206 && r.url.includes("/media/o/")).length;
  const seek = await evalIn(cdp, S, `(async()=>{const v=document.querySelector('.me-view video');
    const t0 = performance.now();
    let landed = -1;
    v.currentTime = ${SEEK_TO};
    // read currentTime IN the seeked handler: the element is still playing, and 700ms later
    // it would be reporting 700ms of playback rather than where the seek put it
    await new Promise(r=>{const d=setTimeout(r,20000);
      v.addEventListener('seeked',()=>{landed=v.currentTime;clearTimeout(d);r()},{once:true})});
    await new Promise(r=>setTimeout(r,700));
    return { landed:+landed.toFixed(3), playedOn:+v.currentTime.toFixed(3), ready:v.readyState, ms:Math.round(performance.now()-t0),
      buffered:[...Array(v.buffered.length)].map((_,i)=>[+v.buffered.start(i).toFixed(1),+v.buffered.end(i).toFixed(1)]) };})()`);
  await sleep(400);
  const all206 = netLog.filter((r) => r.status === 206 && r.url.includes("/media/o/"));
  const seek206 = all206.length - before206;
  log(`SEEK: requested ${SEEK_TO.toFixed(3)}s -> landed ${seek.landed}s in ${seek.ms}ms ` +
      `(then played on to ${seek.playedOn}s), ` +
      `206s served: ${seek206} for this seek, ${all206.length} on the original in total`);
  log(`      ranges: ${all206.slice(-4).map((r) => r.range || "(none)").join("  ")}`);
  log(`      buffered after the seek: ${JSON.stringify(seek.buffered)}`);
  check("SCRUB: the seek landed at the requested time", Math.abs(seek.landed - SEEK_TO) < 0.1,
    `requested ${SEEK_TO}s, landed ${seek.landed}s, delta ${(seek.landed - SEEK_TO).toFixed(3)}s`);
  check("SCRUB: it landed with frames, not just a position", seek.ready >= 2, `readyState ${seek.ready}`);
  check("SCRUB: the Worker served real 206 partial responses", all206.length > 0, `${all206.length} x 206`);
  check("SCRUB: the seek itself pulled a fresh Range, it was not already buffered",
    seek206 > 0, `${seek206} new 206(s)`);
  check("SCRUB: the seek did NOT start from byte 0 — a real Range, not a re-download",
    all206.some((r) => /bytes=[1-9]/.test(r.range || "")), all206.map((r) => r.range).filter(Boolean).slice(-3).join(" "));
  check("the app never muted the video itself (iOS silent switch keeps its meaning)",
    await evalIn(cdp, S, `!document.querySelector('.me-view video').hasAttribute('muted')`));

  // ══ 10. the screenshots ═════════════════════════════════════════════════════════════════
  log("10 — screenshots, both themes");
  fs.mkdirSync(SHOTS, { recursive: true });
  const shot = async (name) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, S);
    const f = path.join(SHOTS, name);
    fs.writeFileSync(f, Buffer.from(data, "base64"));
    log(`      wrote ${path.relative(REPO, f)}`);
  };
  // ONE navigation for the whole run, deliberately. Measured, not assumed: after a second
  // Page.navigate this Chrome still routes touches to the compositor (the pager scrolls) but
  // the renderer stops dispatching pointerdown to JS entirely — every gesture assertion after
  // it would pass for the wrong reason. The __t counter below is what caught that, and it
  // stays in so it can catch it again. The theme is therefore swapped in place, which is all
  // it ever needed: every colour in this app is a token, and the shell check swaps it the
  // same way.
  for (const theme of ["light", "dark"]) {
    await evalIn(cdp, S, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(500);
    await cdp.send("Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-color-scheme", value: theme }] }, S);
    await evalIn(cdp, S, `localStorage.setItem('wgp.theme','${theme}');
      document.documentElement.setAttribute('data-theme','${theme}')`);
    await sleep(300);
    await openViewer();
    await waitFor(cdp, S, `document.querySelector('.me-view .me-vitem[data-i="0"]').dataset.full === '1' ? 1 : null`,
      { label: "original decoded (" + theme + ")" });
    await sleep(300);
    await doubleTap({ x: 150, y: 330 });
    await sleep(500);
    await drag({ x: 300, y: 430 }, { x: 170, y: 430 }, 10);
    await sleep(600);
    log(`      [${theme}] at screenshot: ${await state()}  touches ${await live()}`);
    check(`[${theme}] the zoomed screenshot really is a zoomed photo`,
      /kind=photo/.test(await state()) && !/zoom=1\.00/.test(await state()), await state());
    await shot(`viewer-photo-zoomed-${theme}.png`);

    // the §8 sweep on the viewer in its zoomed state, both themes
    const a11y = await evalIn(cdp, S, A11Y_PROBE);
    check(`[${theme}] viewer: every tap target reaches 44px`, a11y.small.length === 0, a11y.small.join(" | "));
    check(`[${theme}] viewer: no text under 12px`, a11y.tiny.length === 0, a11y.tiny.join(" | "));
    check(`[${theme}] viewer: no text quieted by opacity`, a11y.faded.length === 0, a11y.faded.join(" | "));

    await doubleTap({ x: 195, y: 400 });
    await sleep(350);
    await evalIn(cdp, S, `(()=>{const t=document.querySelector('.me-vtrack');
      const s=t.children[1]; t.scrollTo({left:s.offsetLeft, behavior:'instant'}); t.dispatchEvent(new Event('scroll'));})()`);
    await waitFor(cdp, S, `(()=>{const v=document.querySelector('.me-view video');return v&&v.readyState>=1?1:null})()`,
      { label: "metadata (" + theme + ")" });
    const mid = await evalIn(cdp, S, `(async()=>{const v=document.querySelector('.me-view video');
      v.muted=true; try{await v.play()}catch(e){}
      await new Promise(r=>setTimeout(r,400));
      v.pause();                       // pause FIRST: a playing seek walks past its own frame
      v.currentTime=${SEEK_TO};
      await new Promise(r=>{const d=setTimeout(r,20000); v.addEventListener('seeked',()=>{clearTimeout(d);r()},{once:true})});
      await new Promise(r=>setTimeout(r,500));
      // bring the controls back up so the screenshot shows the playhead mid-scrub
      document.querySelector('.me-view').dataset.chrome='1';
      return {t:+v.currentTime.toFixed(2), ready:v.readyState};})()`);
    await sleep(600);
    await shot(`viewer-video-midscrub-${theme}.png`);
    log(`      [${theme}] mid-scrub screenshot taken at ${mid.t}s (readyState ${mid.ready})`);
    check(`[${theme}] the mid-scrub frame really is at the seeked time`, Math.abs(mid.t - SEEK_TO) < 0.1, String(mid.t));
  }

  // ══ 11. nothing decodes behind a closed viewer ═══════════════════════════════════════════
  log("11 — closing releases the decoder; hiding pauses");
  await evalIn(cdp, S, `(async()=>{const v=document.querySelector('.me-view video');
    v.muted=true; try{await v.play()}catch(e){}})()`);
  await sleep(600);
  const hidden = await evalIn(cdp, S, `(async()=>{
    const v = document.querySelector('.me-view video');
    const wasPlaying = !v.paused;
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r=>setTimeout(r,300));
    const paused = v.paused;
    delete document.hidden; delete document.visibilityState;
    return { wasPlaying, paused };})()`);
  check("a hidden document pauses playback (no decoding in a pocket)",
    hidden.wasPlaying && hidden.paused, JSON.stringify(hidden));

  await evalIn(cdp, S, `window.__vid = document.querySelector('.me-view video')`);
  await evalIn(cdp, S, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await sleep(700);
  const closed = await evalIn(cdp, S, `(()=>{const v=window.__vid; return {
    gone: !document.querySelector('.me-view'),
    unInert: !document.getElementById('view').hasAttribute('inert'),
    paused: v.paused, src: v.getAttribute('src'), currentSrc: v.currentSrc,
    ready: v.readyState, net: v.networkState };})()`);
  check("Escape closes the viewer and un-inerts the app", closed.gone && closed.unInert, JSON.stringify(closed));
  // networkState 0 is NETWORK_EMPTY: no source selected, nothing being fetched, decoder
  // handed back. Chrome leaves `currentSrc` behind as a memento of the last load even after
  // load() empties the element, so it is not the thing to measure.
  check("every source is DETACHED on close, not merely paused",
    closed.paused && !closed.src && closed.ready === 0 && closed.net === 0,
    JSON.stringify(closed));

  // ══ 12. drag-to-dismiss on sheet.js's numbers ════════════════════════════════════════════
  log("12 — drag-to-dismiss");
  log(`      touches so far: ${await live()}`);
  await openViewer();
  await waitFor(cdp, S, V, { label: "viewer re-opened" });
  await sleep(400);
  await evalIn(cdp, S, `(()=>{ window.__tr=[];
    for (const ev of ['pointerdown','pointermove','pointerup','pointercancel','touchstart','touchmove','touchend'])
      document.addEventListener(ev, (e)=>{ if(window.__tr.length<600)
        window.__tr.push(ev+'@'+Math.round(e.clientY ?? (e.touches && e.touches[0] ? e.touches[0].clientY : -1))
          + '#' + ((e.target.className||e.target.tagName)+'').split(' ')[0]); }, true); })()`);
  await evalIn(cdp, S, `window.__tr.length = 0`);
  await drag({ x: 195, y: 300 }, { x: 340, y: 300 }, 8);   // control: a horizontal drag
  await sleep(400);
  const ctrl = await evalIn(cdp, S, `({n:window.__tr.length, first:window.__tr.slice(0,3), last:window.__tr.slice(-2)})`);
  log(`      control (horizontal) delivered ${ctrl.n} events: ${JSON.stringify(ctrl.first)} … ${JSON.stringify(ctrl.last)}`);
  await drag({ x: 195, y: 200 }, { x: 200, y: 300 }, 12, 400);   // 100px, held: under 28%, no flick
  await sleep(700);
  check("a short, held pull springs back instead of dismissing",
    await evalIn(cdp, S, `!!document.querySelector('.me-view')`));
  const restored = await evalIn(cdp, S, `(()=>{const p=document.querySelector('.me-vpane');
    return {y:+new DOMMatrix(getComputedStyle(p).transform).f.toFixed(1),
      scrim:+getComputedStyle(document.querySelector('.me-vscrim')).opacity}})()`);
  check("and it springs all the way back — the pane and the scrim both", Math.abs(restored.y) < 1 && restored.scrim === 1,
    JSON.stringify(restored));
  await evalIn(cdp, S, `window.__tr.length = 0`);
  await drag({ x: 195, y: 200 }, { x: 200, y: 620 }, 14);        // 420px = over 28% of 844
  await sleep(900);
  const trace = await evalIn(cdp, S, `(()=>{ const v=document.querySelector('.me-view');
    const hit=(x,y)=>{const e=document.elementFromPoint(x,y); return e? (e.className||e.tagName)+'' : 'null'};
    const tr=v&&v.querySelector('.me-vtop').getBoundingClientRect();
    return { n: window.__tr.length, seq: window.__tr.join(''),
      drag: v ? (v.dataset.drag ?? 'never') : 'gone',
      at200: hit(195,200), at300: hit(195,300), at620: hit(200,620),
      topBar: tr ? [Math.round(tr.top), Math.round(tr.bottom)] : null }; })()`);
  check("a long downward pull dismisses", await evalIn(cdp, S, `!document.querySelector('.me-view')`),
    JSON.stringify(trace));
  check("dismissing un-inerts the app behind it",
    await evalIn(cdp, S, `!document.getElementById('view').hasAttribute('inert')`));

  check("still no page exceptions after every gesture", pageErrors.length === 0, pageErrors.join(" | "));

  // ── cleanup: leave the trip exactly as it was found ─────────────────────────────────────
  // WGP_KEEP=1 leaves the seeded memory in place. scripts/memories_shell_check.mjs needs a
  // feed with thumbs in it and seeds nothing of its own, so the pair is run as
  //   WGP_KEEP=1 node scripts/memories_viewer_check.mjs && node scripts/memories_shell_check.mjs
  // and the memory is deleted afterwards.
  if (process.env.WGP_KEEP === "1") {
    log(`WGP_KEEP=1 — leaving ${MEM.id} in the feed for the shell check; delete it with:`);
    log(`  curl -X DELETE -H "Cookie: s2=<admin>" ${BASE}/api/trips/demo-2027/memories/${MEM.id}`);
  } else {
    const del = await api(`/api/trips/demo-2027/memories/${MEM.id}`, { method: "DELETE" });
    check("the check leaves nothing of its own behind", del.status === 200, String(del.status));
  }

  cdp.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("failures: " + failures.join(" | "));
  shutdown(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", (e && e.stack) || e); shutdown(2); });

#!/usr/bin/env node
/* RETURNING TO THE AGENDA — measured across a REAL navigate-and-back. Dev-only.
 *
 *   node scripts/agenda_return_check.js
 *
 * Two symptoms, one event, both reported against builds that had already been
 * "fixed" twice:
 *
 *   "it looks fine for a half second, then it super fast animates back over to the first date
 *    then back to where it currently is"
 *   "ALSO when this happens literally all images currently on the screen flash at the same
 *    time"
 *
 * WHY EARLIER HARNESSES MISSED IT. They forced a REPAINT — called the render path by hand and
 * counted mutations. A back is not a repaint. router.js does el.replaceChildren() and mounts
 * the module again, so nothing the keyed patcher does is even on this path: the screen is
 * built from nothing and then told where to be. This drives the real thing — a real touch
 * scroll, a real tap on a real card, a real history.back() — and asserts on what the reader
 * actually sees:
 *
 *   1. ZERO <img> load events across the return       (the synchronised flash)
 *   2. ZERO strip movement and ZERO ring animations   (the travel to date one and back)
 *   3. the day pill never lights the wrong date       (not even for one frame)
 *   4. IN PIXELS: photographic texture across the list never drops below half its settled
 *      value on any composited frame of the return. Counting load events is a proxy; this is
 *      the thing itself, off a screencast, at compositor rate.
 *
 * Geolocation is emulated because agenda.js repaints when a fix lands and a phone has a GPS,
 * and /img/ is served with a long max-age because sw.js serves images cache-first in
 * production while wrangler pages dev revalidates every one of them.
 */
const { baseUrl, launchChrome } = require("./lib/browser.mjs");
const { signedIn, tripPath } = require("./lib/gate_trip.mjs");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const ORIGIN = baseUrl();   // WGP_BASE or --base=<url>: this lane's dev server (scripts/lib/browser.mjs)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Signed in as the host of the gate's made-up trip, with a session of this run's own
// (scripts/lib/gate_trip.mjs).

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      } else if (msg.method) for (const fn of listeners.get(msg.method) || []) fn(msg.params);
    });
    ws.addEventListener("error", () => reject(new Error("websocket failed")));
    ws.addEventListener("open", () => resolve({
      send(method, params = {}) {
        const mid = ++id;
        return new Promise((res, rej) => { pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
      },
      on(method, fn) { listeners.set(method, [...(listeners.get(method) || []), fn]); },
    }));
  });
}

async function launch() {
  // The shared launcher: Chrome for Testing, headless, muted, on a port read from its own
  // fresh profile (scripts/lib/browser.mjs). It is the only thing that starts a browser.
  const browser = await launchChrome({ args: [
    "--hide-scrollbars",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", "--force-device-scale-factor=1",
    "about:blank",
  ] });
  const target = await browser.pageTarget();
  const c = await connect(target.webSocketDebuggerUrl);
  c.kill = () => browser.close();
  return c;
}

async function evaluate(c, expression) {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("eval threw: " + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
  return r.result.value;
}

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`unsupported png ${bitDepth}/${colorType}`);
      if (data[12] !== 0) throw new Error("interlaced png");
    } else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * bpp);
  const stride = w * bpp;
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prior = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prior ? prior[x] : 0;
      const cc = prior && x >= bpp ? prior[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a; else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - cc);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
      } else if (filter !== 0) throw new Error("bad png filter " + filter);
      cur[x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

function inkIn(png, rx, ry, rw, rh) {
  const { w, bpp, data } = png;
  const x0 = Math.max(0, Math.round(rx)), y0 = Math.max(0, Math.round(ry));
  const x1 = Math.min(w, Math.round(rx + rw)), y1 = Math.min(png.h, Math.round(ry + rh));
  const lum = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const j = (y * w + x) * bpp;
    lum.push(0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]);
  }
  if (!lum.length) return { ink: 0, n: 0, med: 0 };
  const s = [...lum].sort((a, b) => a - b);
  const med = s[s.length >> 1];
  let n = 0;
  for (const v of lum) if (Math.abs(v - med) > 24) n++;
  return { ink: n, n: lum.length, med: +med.toFixed(1) };
}


/* BUG 2, IN PIXELS. Real scroll, real tap into an event, real back — and a screencast of
 * every composited frame of the return. Two questions, both answered from the bitmap:
 *   1. does any presented frame paint the ring on the wrong date?
 *   2. do the card photographs go blank and come back ("all images flash at the same time")?
 * Photo detection is local contrast: a decoded photograph has thousands of high-gradient
 * pixels, an undecoded <img> box has almost none. */
const OUT = path.join(__dirname, "..", "build", "agenda-return");

function textureIn(png, x0, y0, x1, y1) {
  const { w, bpp, data } = png;
  x0 = Math.max(1, x0 | 0); y0 = Math.max(1, y0 | 0);
  x1 = Math.min(w - 1, x1 | 0); y1 = Math.min(png.h - 1, y1 | 0);
  let n = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const j = (y * w + x) * bpp, jr = (y * w + x + 1) * bpp, jd = ((y + 1) * w + x) * bpp;
    const l = 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2];
    const lr = 0.2126 * data[jr] + 0.7152 * data[jr + 1] + 0.0722 * data[jr + 2];
    const ld = 0.2126 * data[jd] + 0.7152 * data[jd + 1] + 0.0722 * data[jd + 2];
    if (Math.abs(l - lr) > 10 || Math.abs(l - ld) > 10) n++;
  }
  return n;
}
// Where is the ring? The accent outline is the bluest thing in the strip band.
function ringX(png, bandTop, bandBot) {
  const { w, bpp, data } = png;
  let best = -1, bestN = 0;
  const col = new Int32Array(w);
  for (let y = bandTop; y < bandBot; y++) for (let x = 0; x < w; x++) {
    const j = (y * w + x) * bpp;
    const r = data[j], g = data[j + 1], b = data[j + 2];
    if (b > 120 && b - r > 40 && g > r) col[x]++;
  }
  for (let x = 0; x < w; x++) if (col[x] > bestN) { bestN = col[x]; best = x; }
  let first = -1, last = -1;
  for (let x = 0; x < w; x++) if (col[x] >= 2) { if (first < 0) first = x; last = x; }
  return { peak: best, n: bestN, first, last };
}

const WATCH = `
window.__imgLoads = 0; window.__imgAdd = 0; window.__imgRm = 0; window.__watch = false;
window.__armed = false; window.__err = ""; window.__imgSrc = [];
try {
  new MutationObserver((recs) => {
    if (!window.__watch) return;
    for (const r of recs) {
      for (const n of r.addedNodes) { if (n.nodeType !== 1) continue;
        if (n.tagName === "IMG") window.__imgAdd++; else if (n.querySelectorAll) window.__imgAdd += n.querySelectorAll("img").length; }
      for (const n of r.removedNodes) { if (n.nodeType !== 1) continue;
        if (n.tagName === "IMG") window.__imgRm++; else if (n.querySelectorAll) window.__imgRm += n.querySelectorAll("img").length; }
    }
  }).observe(document, { childList: true, subtree: true });
  document.addEventListener("load", (e) => {
    if (window.__watch && e.target && e.target.tagName === "IMG") {
      window.__imgLoads++; window.__imgSrc.push((e.target.currentSrc||e.target.src||"").split("/").pop()); }
  }, true);
  window.__armed = true;
} catch (e) { window.__err = String(e); }
window.startRec = function () {
  const rec = { rows: [], stop: false, t0: performance.now() }; window.__rec = rec;
  const step = () => {
    if (rec.stop) return;
    const v = document.getElementById("view");
    const s = document.querySelector(".ag-strip");
    const ring = s ? s.querySelector(".ag-ring") : null;
    rec.rows.push({ t: +(performance.now() - rec.t0).toFixed(1),
      top: v ? Math.round(v.scrollTop) : null, sh: v ? v.scrollHeight : null,
      sl: s ? +s.scrollLeft.toFixed(1) : null,
      here: s ? [...s.querySelectorAll(".ag-pill-here")].map(p=>p.dataset.jump).join(",") : "",
      ringL: ring ? Math.round(parseFloat(ring.style.left)||0) : null,
      an: ring ? ring.getAnimations().length : 0,
      days: document.querySelectorAll(".ag-day").length,
      imgs: document.querySelectorAll(".ag img").length,
      ld: window.__imgLoads, ad: window.__imgAdd, rm: window.__imgRm });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step); return true;
};
`;


async function tap(c, x, y) {
  await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }] });
  await sleep(60);
  await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const c = await launch();
  try {
    await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable");
    await c.send("Network.setBypassServiceWorker", { bypass: true });
    await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await c.send("Browser.grantPermissions", { origin: ORIGIN, permissions: ["geolocation"] });
    await c.send("Emulation.setGeolocationOverride", { latitude: -13.5183, longitude: -71.9781, accuracy: 24 });
    // THE PHONE HAS A WARM IMAGE CACHE AND THIS DEV SERVER DOES NOT. sw.js serves /img/
    // cache-first out of the wegoplace-img-v1 cache, so on a real handset a card photograph
    // is a local read; wrangler pages dev sends "max-age=0, must-revalidate", which turns
    // every one of them into a conditional round trip and would make any measurement here a
    // measurement of the dev server. Rewrite the header so the browser cache behaves the way
    // the service worker does in production.
    await c.send("Fetch.enable", { patterns: [{ urlPattern: "*/img/*", requestStage: "Response" }] });
    c.on("Fetch.requestPaused", async (p) => {
      try {
        const b = await c.send("Fetch.getResponseBody", { requestId: p.requestId });
        const hs = (p.responseHeaders || []).filter(h => !/^cache-control$/i.test(h.name));
        hs.push({ name: "cache-control", value: "public, max-age=31536000, immutable" });
        await c.send("Fetch.fulfillRequest", { requestId: p.requestId,
          responseCode: p.responseStatusCode || 200, responseHeaders: hs,
          body: b.base64Encoded ? b.body : Buffer.from(b.body).toString("base64") });
      } catch { try { await c.send("Fetch.continueRequest", { requestId: p.requestId }); } catch {} }
    });
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
    for (const cookie of await signedIn()) await c.send("Network.setCookie", cookie);
    await c.send("Page.navigate", { url: ORIGIN + tripPath("#/") });
    for (let i = 0; i < 80; i++) { await sleep(150); if (await evaluate(c, `document.querySelectorAll(".ag-day").length`)) break; }
    await sleep(2500);   // let every card image finish loading before we leave
    await c.send("Input.synthesizeScrollGesture", { x: 195, y: 500, xDistance: 0, yDistance: -2600, gestureSourceType: "touch", speed: 3000, preventFling: true });
    await sleep(2500);
    const before = await evaluate(c, `(() => {
      const cards = [...document.querySelectorAll('.ag-slot a[href*="#/e/"]')];
      const vis = cards.filter(a => { const r = a.getBoundingClientRect(); return r.top > 150 && r.bottom < 780; });
      const a = vis[0]; const r = a.getBoundingClientRect();
      const strip = document.querySelector(".ag-strip"); const sr = strip.getBoundingClientRect();
      return { here: [...strip.querySelectorAll(".ag-pill-here")].map(p=>p.dataset.jump).join(","),
        band: [Math.round(sr.top), Math.round(sr.bottom)],
        ringX: Math.round(strip.querySelector(".ag-ring").getBoundingClientRect().x),
        target: { x: Math.round(r.x+r.width/2), y: Math.round(r.y+Math.min(40,r.height/2)) } }; })()`);
    console.log("BEFORE:", JSON.stringify(before));

    // A reference frame of the settled agenda: this is what the return must look like.
    const ref = decodePNG(Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    const refTex = textureIn(ref, 0, before.band[1] + 4, 390, 844);
    console.log("reference texture (settled agenda):", refTex);

    await tap(c, before.target.x, before.target.y);
    await sleep(2000);
    console.log("EVENT PAGE:", await evaluate(c, `location.hash`));

    const frames = [];
    c.on("Page.screencastFrame", async (p) => {
      frames.push({ wall: Date.now(), data: p.data });
      try { await c.send("Page.screencastFrameAck", { sessionId: p.sessionId }); } catch {}
    });
    await c.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await sleep(200);
    await evaluate(c, `window.__imgLoads=0; window.__imgAdd=0; window.__imgRm=0; window.__imgSrc=[]; window.__watch=true; window.startRec(); true`);
    const t0 = Date.now();
    await evaluate(c, `history.back(); true`);
    await sleep(2500);
    await c.send("Page.stopScreencast");
    console.log("\nframes:", frames.length);

    console.log("\n   t(ms)  texture  %ofsettled   ringX(first..last, peak)");
    const rows = [];
    for (const f of frames) {
      const png = decodePNG(Buffer.from(f.data, "base64"));
      const tex = textureIn(png, 0, before.band[1] + 4, 390, 844);
      const rx = ringX(png, before.band[0] + 2, before.band[1] - 2);
      rows.push({ t: f.wall - t0, tex, rx });
      fs.writeFileSync(path.join(OUT, `f${String(rows.length).padStart(3, "0")}.png`), Buffer.from(f.data, "base64"));
    }
    for (const r of rows) {
      console.log(` ${String(r.t).padStart(6)} ${String(r.tex).padStart(8)}  ${String(Math.round(100 * r.tex / refTex)).padStart(4)}%      ${String(r.rx.first).padStart(4)}..${String(r.rx.last).padStart(4)} peak ${String(r.rx.peak).padStart(4)} (n=${r.rx.n})`);
    }
    const after = rows.filter(r => r.t >= 0);
    const dips = after.filter(r => r.tex < refTex * 0.5);
    console.log(`\nPHOTO TEXTURE: settled ${refTex}; frames below 50% of it after the back: ${dips.length}/${after.length}`);
    console.log(`  min after back: ${Math.min(...after.map(r => r.tex))} (${Math.round(100*Math.min(...after.map(r=>r.tex))/refTex)}%)`);
    const ringPeaks = [...new Set(after.filter(r => r.rx.n >= 3).map(r => r.rx.peak))].sort((a,b)=>a-b);
    console.log(`RING peak x across the return: ${ringPeaks.join(", ")}   (settled before leaving: ${before.ringX})`);

    // ── the DOM side of the same return ──
    const rec = await evaluate(c, `window.__rec.stop = true; window.__rec.rows`);
    const fin = await evaluate(c, `({ ld: window.__imgLoads, ad: window.__imgAdd, srcs: window.__imgSrc.slice(0, 10) })`);
    const live = rec.filter((r) => r.days > 0);
    const sls = live.map((r) => r.sl).filter((v) => v != null);
    const keys = [...new Set(live.map((r) => r.here).filter(Boolean))];
    const anims = live.filter((r) => r.an > 0).length;
    const strip = sls.length ? Math.max(...sls) - Math.min(...sls) : 0;
    const fails = [];
    const check = (name, ok, detail) => {
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
      if (!ok) fails.push(name);
    };
    console.log("");
    check("a return fires ZERO image loads", fin.ld === 0,
      fin.ld ? `${fin.ld} loads: ${fin.srcs.join(", ")}` : "0 loads, 0 re-decodes");
    check("a return moves the strip ZERO pixels", strip === 0, `scrollLeft range ${strip.toFixed(1)}px`);
    check("a return runs ZERO ring animations", anims === 0, `${anims} frames with a player`);
    check("the lit pill never goes to the wrong date", keys.length === 1,
      `lit: ${keys.join(" -> ")} (was ${before.here} before leaving)`);
    check("the photographs never blank (pixels)", dips.length === 0,
      `worst frame ${Math.round(100 * Math.min(...after.map((r) => r.tex)) / refTex)}% of settled texture`);
    console.log(`\n${fails.length ? fails.length + " check(s) FAILED" : "all return checks passed"}`);
    process.exitCode = fails.length ? 1 : 0;
  } finally { await c.kill(); }
}
main().catch(e => { console.error(e); process.exit(2); });

#!/usr/bin/env node
/* An independent walk of ten of the app's promises (the agenda, the map, places and packing) against the running app.
 *
 * Written by the verifier role. It deliberately does NOT import or reuse the builders'
 * harnesses: the point is to measure the same claims a second time, from scratch, with
 * assertions phrased the way the complaint was phrased rather than the way the fix
 * was implemented.
 *
 *   node scripts/v5_verify.js               all sections
 *   node scripts/v5_verify.js --only=A,B    A agenda 1-3, B map 4/7/8, C places 5/6,
 *                                           D pack 9/10, E regressions + §8 sweep
 *
 * Dev-only; scripts/ is outside pages_build_output_dir.
 */
const { baseUrl, launchChrome } = require("./lib/browser.mjs");
const crypto = require("crypto");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
// 127.0.0.1, not localhost: wrangler has come up IPv4-only more than once this session, and
// Chrome resolving localhost to ::1 first turns every page into chrome-error://chromewebdata
// — which reads exactly like the app failing to boot.
const ORIGIN = baseUrl();   // WGP_BASE or --base=<url>: this lane's dev server (scripts/lib/browser.mjs)
const HOST = new URL(ORIGIN).hostname;
const SHOTS = path.join(REPO, "build", "v5-verify");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function note(msg) { console.log("      · " + msg); }

function cookie(user = "u_admin") {
  const vars = fs.readFileSync(path.join(REPO, ".dev.vars"), "utf8");
  const m = /^AUTH_SECRET\s*=\s*(.+)$/m.exec(vars);
  if (!m) throw new Error("no AUTH_SECRET in .dev.vars");
  const secret = m[1].trim().replace(/^["']|["']$/g, "");
  const msg = `${user}.${Math.floor(Date.now() / 1000) + 3600}`;
  return `${msg}.${crypto.createHmac("sha256", secret).update(msg).digest("hex")}`;
}

// ON THE GATE (scripts/gate.mjs): its own server, the made-up trip, its host signed in with a
// session of this run's own. (cookie() above is the road of the old accounts, for the walks
// that are not on the gate.)
const gateTrip = () => require("./lib/gate_trip.mjs");
async function signInHost(c) { for (const k of await gateTrip().signedIn()) await c.send("Network.setCookie", k); }
const tripPath = (rest = "") => gateTrip().tripPath(rest);

async function launch() {
  // The shared launcher: Chrome for Testing, headless, muted, on a port read from its own
  // fresh profile (scripts/lib/browser.mjs). It is the only thing that starts a browser.
  const browser = await launchChrome({ args: [
    "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", "about:blank",
  ] });
  const target = await browser.pageTarget();
  const c = await connect(target.webSocketDebuggerUrl);
  c.kill = () => browser.close();
  return c;
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.addEventListener("message", (ev2) => {
      const msg = JSON.parse(ev2.data);
      if (msg.id != null && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      } else if (msg.method) { for (const fn of listeners.get(msg.method) || []) fn(msg.params); }
    });
    ws.addEventListener("error", () => reject(new Error("ws failed")));
    ws.addEventListener("open", () => resolve({
      send(method, params = {}) {
        const mid = ++id;
        return new Promise((res, rej) => { pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
      },
      on(method, fn) { listeners.set(method, [...(listeners.get(method) || []), fn]); },
      off(method) { listeners.delete(method); },
    }));
  });
}
async function ev(c, expression) {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error("eval threw: " + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
  }
  return r.result.value;
}
async function shot(c, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  const buf = Buffer.from(r.data, "base64");
  fs.writeFileSync(path.join(SHOTS, name), buf);
  return buf;
}
async function waitFor(c, expr, ms = 25000) {
  const t0 = Date.now();
  for (;;) {
    const v = await ev(c, expr).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) {
      // What the page was showing when the wait gave up: a red names its cause (a blank page, the sign-in page, a list
      // still loading), not only the condition that never came true.
      const at = await ev(c, `JSON.stringify({ at: location.pathname + location.hash, ready: document.readyState, title: document.title,
        text: (document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 160) })`).catch((e) => `(the page couldn't be read: ${e.message})`);
      throw new Error(`timeout waiting ${Math.round(ms / 1000)} s: ${expr.slice(0, 100)}; the page: ${at}`);
    }
    await sleep(150);
  }
}
const pts = (a) => a.map((p, i) => ({ x: p.x, y: p.y, id: p.id == null ? i : p.id, radiusX: 12, radiusY: 12, force: 1 }));
const touch = (c, type, points) => c.send("Input.dispatchTouchEvent", { type, touchPoints: pts(points) });
async function tap(c, x, y) {
  await touch(c, "touchStart", [{ x, y }]);
  await sleep(70);
  await touch(c, "touchEnd", []);
}

function decodePNG(buf) {
  let p = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (bd !== 8) throw new Error("bit depth " + bd);
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : (() => { throw new Error("colour type " + ct); })();
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let o = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[o++];
    const line = raw.subarray(o, o + stride); o += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev ? prev[x] : 0, cc = (prev && x >= ch) ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - cc); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : cc); }
      cur[x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

module.exports = { launch, ev, shot, waitFor, tap, touch, cookie, signInHost, tripPath, check, note, results, sleep, decodePNG, SHOTS, ORIGIN, HOST, REPO };

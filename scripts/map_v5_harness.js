#!/usr/bin/env node
/* v5 items 4, 7 and 8, proved against real Chrome, real MapLibre and real frames.
 *
 *   4  PIN JITTER — pins must stay welded to their coordinate through a pan and a pinch.
 *      Proof: the live MapLibre instance is asked, INSIDE its own render callback, where the
 *      tracked place projects to; that is compared with the transform the marker is actually
 *      wearing in that same frame. A frame of overlay lag shows up as an error the size of the
 *      camera step; a rounded transform shows up as an error up to half a pixel and as integer
 *      transform values. Both are failures. The bar is < 1 px per frame, and the file's own
 *      claim is that it lands three orders of magnitude inside it.
 *
 *   7  CLUSTERS — (a) a tap opens the group at ANY zoom, MAX_ZOOM included, and for a group
 *      that fits one ring it opens it WITHOUT moving the camera; (b) the grouping radius is
 *      tight enough that street zoom is pins and names rather than discs and numbers.
 *
 *   8  ONE MAP, KEPT ALIVE — leaving Places and coming back must re-attach the same MapLibre
 *      instance, the same WebGL context and the same canvas, be on screen within a couple of
 *      frames, and fetch nothing. A second page load must read the archive out of Cache
 *      Storage rather than off the network.
 *
 * Dev-only; scripts/ is outside pages_build_output_dir, so nothing here ships.
 *
 *   this lane's dev server must be running; WGP_BASE=http://127.0.0.1:<port> says where
 *   node scripts/map_v5_harness.js                # --only=4|7|8
 *
 * No dependencies: Node 22+ has a global WebSocket and fetch, which is the whole CDP client.
 * Service workers are bypassed on every page: the SW precaches /js/map.js, and testing the
 * previous build while believing otherwise is the one failure mode this file cannot report.
 */
const { baseUrl, launchChrome } = require("./lib/browser.mjs");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const ORIGIN = baseUrl();   // WGP_BASE or --base=<url>: this lane's dev server (scripts/lib/browser.mjs)
const HOST = new URL(ORIGIN).hostname;
const SHOTS = path.join(REPO, "build", "map-v5-shots");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7);

// Two cameras, because a map that is right in one city and wrong in the other is a projection
// bug wearing a screenshot. Cusco is the dense one; Lima is the wide one.
const CUSCO = { lng: -71.978, lat: -13.517, zoom: 16 };
const LIMA = { lng: -77.028, lat: -12.121, zoom: 16 };
// Three places share this doorway (ChocoMuseo and two luggage stores): no zoom will ever
// separate them, which is exactly what item 7a is about.
const DOORWAY = { lng: -71.9804504, lat: -13.5174173, zoom: 18 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// ── the session cookie ─────────────────────────────────────────────────────────────────
function cookie() {
  const vars = fs.readFileSync(path.join(REPO, ".dev.vars"), "utf8");
  const m = /^AUTH_SECRET\s*=\s*(.+)$/m.exec(vars);
  if (!m) throw new Error("no AUTH_SECRET in .dev.vars");
  const secret = m[1].trim().replace(/^["']|["']$/g, "");
  const msg = `u_admin.${Math.floor(Date.now() / 1000) + 3600}`;
  return `${msg}.${crypto.createHmac("sha256", secret).update(msg).digest("hex")}`;
}

// ── the CDP client, in one screenful ───────────────────────────────────────────────────
// MACOS NOTE: Chrome puts its ProcessSingleton socket inside the profile directory and unix
// socket paths cap at ~104 characters, so the profile lives at a deliberately short path.
async function launch() {
  // The shared launcher: Chrome for Testing, headless, muted, on a port read from its own
  // fresh profile (scripts/lib/browser.mjs). It is the only thing that starts a browser.
  const browser = await launchChrome({ args: [
    // SwiftShader, so MapLibre gets a real WebGL2 context on a machine with no display.
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
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      } else if (msg.method) {
        for (const fn of listeners.get(msg.method) || []) fn(msg.params);
      }
    });
    ws.addEventListener("error", () => reject(new Error("websocket failed")));
    ws.addEventListener("open", () => resolve({
      send(method, params = {}) {
        const mid = ++id;
        return new Promise((res, rej) => {
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      on(method, fn) { listeners.set(method, [...(listeners.get(method) || []), fn]); },
    }));
  });
}

async function evaluate(c, expression) {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error("eval threw: " +
      ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
  }
  return r.result.value;
}
async function shot(c, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, "base64"));
}
async function waitFor(c, expr, ms = 25000) {
  const t0 = Date.now();
  for (;;) {
    const v = await evaluate(c, expr).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for: " + expr.slice(0, 80));
    await sleep(200);
  }
}

// ── touch ──────────────────────────────────────────────────────────────────────────────
const pts = (a) => a.map((p, i) => ({ x: p.x, y: p.y, id: p.id == null ? i : p.id, radiusX: 12, radiusY: 12, force: 1 }));
const touch = (c, type, points) => c.send("Input.dispatchTouchEvent", { type, touchPoints: pts(points) });
async function tap(c, x, y) {
  await touch(c, "touchStart", [{ x, y }]);
  await sleep(70);
  await touch(c, "touchEnd", []);
}

// ── reading the map out of the page ────────────────────────────────────────────────────
// The marker anchor's transform IS its projected position: .mp-layer sits at the origin of
// MapLibre's own canvas container, so map.project() and this string are in one frame.
const AT = `(n => { const m = /translate3d\\((-?[\\d.e+]+)px,\\s*(-?[\\d.e+]+)px/.exec(n.style.transform || ''); return m ? [+m[1], +m[2]] : null; })`;
const SNAP = `(() => { const at = ${AT}; const r = document.querySelector('.mp-surface').getBoundingClientRect();
  return { top: r.top, w: r.width, h: r.height,
    clusters: [...document.querySelectorAll('.mp-cluster')].map(n => ({ n: n.dataset.ids.split(',').length, ids: n.dataset.ids, p: at(n) })),
    pins: [...document.querySelectorAll('.mp-pin')].map(n => ({ id: n.dataset.id, p: at(n), label: n.dataset.label })),
    legs: !document.querySelector('.mp-legs').hidden, hub: !document.querySelector('.mp-hub').hidden,
    scale: (document.querySelector('.mp-scale-t') || {}).textContent }; })()`;

// The live MapLibre instance, without a debug hook in the app: the module is already in the
// page's module map, so importing it again hands back the SAME namespace object, and
// map.project() is called on every marker layout. Every instance ever created lands in
// __maps, which is how item 8 proves there is exactly one.
const GRAB = `(async () => {
  const ml = await import('/vendor/maplibre/maplibre-gl.mjs');
  if (!ml.Map.prototype.__wgpGrab) {
    const orig = ml.Map.prototype.project;
    window.__maps = new Set();
    ml.Map.prototype.project = function (...a) { window.__mlmap = this; window.__maps.add(this); return orig.apply(this, a); };
    ml.Map.prototype.__wgpGrab = 1;
  }
  return true; })()`;

async function boot(c, { cam, theme = "dark", net = false } = {}) {
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Log.enable");
  await c.send("Network.enable");
  await c.send("Network.setBypassServiceWorker", { bypass: true });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  const logs = [];
  const reqs = [];
  c.on("Runtime.consoleAPICalled", (p) => logs.push(p.type + ": " + p.args.map((a) => a.value ?? a.description ?? "").join(" ")));
  c.on("Log.entryAdded", (p) => logs.push("LOG/" + p.entry.level + ": " + p.entry.text));
  if (net) c.on("Network.requestWillBeSent", (p) => reqs.push({ url: p.request.url, range: (p.request.headers || {}).Range || "", at: Date.now() }));
  await c.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try {
      ${cam ? `localStorage.setItem('wgp.map.cam@demo-2027', JSON.stringify({ ...${JSON.stringify(cam)}, at: Date.now() }));` : ""}
      localStorage.setItem('wgp.map.sheet', 'open');
      localStorage.setItem('wgp.theme', ${JSON.stringify(theme)});
    } catch {}
    window.__ctx = 0;
    const og = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t, ...a) {
      const r = og.call(this, t, ...a);
      if (r && (t === 'webgl2' || t === 'webgl')) window.__ctx++;
      return r; };`,
  });
  await c.send("Network.setCookie", { name: "s2", value: cookie(), domain: HOST, path: "/" });
  await c.send("Page.navigate", { url: ORIGIN + "/t/demo-2027/#/places?view=map" });
  return { logs, reqs };
}

// Every filter chip off, so the map carries every place. Then a short drag, which moves the
// camera — and it is the marker layout that move forces, and its map.project() call, that
// hands GRAB the live instance.
async function settle(c) {
  await waitFor(c, `document.querySelector('.mp-root') && document.querySelector('.mp-root').dataset.engine === 'gl'`);
  await sleep(4500);
  await evaluate(c, `[...document.querySelectorAll('.pl-head .chip[aria-pressed="true"]')].forEach((b) => b.click())`);
  await sleep(1200);
  await evaluate(c, GRAB);
  // Bare ground, not a marker: a touch sequence that begins on a pin during the style load can
  // still reach the page as a tap, and a settle step that opens a fan poisons the measurement
  // that follows it.
  const spot = await evaluate(c, `(() => {
    const r = document.querySelector('.mp-surface').getBoundingClientRect();
    for (let y = r.top + 70; y < r.top + r.height - 140; y += 20) {
      for (let x = 24; x < r.width - 100; x += 20) {
        const e = document.elementFromPoint(x, y);
        if (e && !e.closest('.mp-pin,.mp-cluster,.mp-hub,.mp-ctrl,.mp-peek,.mp-sheet,.pl-head')) return { x, y };
      }
    }
    return { x: 40, y: Math.round(r.top + 80) }; })()`);
  await touch(c, "touchStart", [spot]);
  for (let i = 1; i <= 8; i++) { await touch(c, "touchMove", [{ x: spot.x + i * 5, y: spot.y - i * 2 }]); await sleep(17); }
  await touch(c, "touchEnd", []);
  await sleep(1000);
  // …and if one opened anyway, fold it before anything is measured.
  await evaluate(c, `(() => { const h = document.querySelector('.mp-hub'); if (h && !h.hidden) h.click(); return 1; })()`);
  await sleep(500);
  if (!(await evaluate(c, `!!window.__mlmap`))) throw new Error("never got hold of the MapLibre instance");
}
const jumpTo = (c, lng, lat, z) =>
  evaluate(c, `void window.__mlmap.jumpTo({ center: [${lng}, ${lat}], zoom: ${z}, bearing: 0, pitch: 0 })`);

// ═══════════════════════════════════════════════════════════════════════════════════════
// ITEM 4 — the pins are welded to their coordinates
// ═══════════════════════════════════════════════════════════════════════════════════════

// Watch ONE place for a whole gesture. The sample is taken in MapLibre's own 'render' event,
// i.e. in the frame the ground was drawn in, so "the pins are placed a frame late" — v4's
// actual bug — cannot hide inside a settled reading taken afterwards.
async function watch(c, id) {
  await evaluate(c, `(() => {
    const at = ${AT}; const m = window.__mlmap;
    const node = () => document.querySelector('.mp-pin[data-id=' + JSON.stringify(${JSON.stringify(id)}) + ']');
    const d0 = at(node());
    const g = m.unproject(d0);
    window.__geo = [g.lng, g.lat];
    window.__rec = []; window.__on = false;
    window.__watch = () => { window.__rec = []; window.__on = true; };
    window.__stop = () => { window.__on = false; return window.__rec; };
    if (!window.__wired) {
      window.__wired = 1;
      m.on('render', () => {
        if (!window.__on) return;
        const n = node();
        if (!n) { window.__rec.push({ gone: true }); return; }
        const d = at(n); const p = m.project(window.__geo);
        window.__rec.push({ dx: d[0], dy: d[1], px: +p.x.toFixed(4), py: +p.y.toFixed(4), z: +m.getZoom().toFixed(5) });
      });
    }
    return true; })()`);
}
function verdict(rec) {
  const f = rec.filter((r) => !r.gone);
  let weld = 0, track = 0, travel = 0, frac = 0, moved = 0;
  for (let i = 0; i < f.length; i++) {
    const r = f[i];
    weld = Math.max(weld, Math.hypot(r.dx - r.px, r.dy - r.py));
    if (r.dx % 1 !== 0 || r.dy % 1 !== 0) frac++;
    if (i) {
      const q = f[i - 1];
      const dp = Math.hypot(r.px - q.px, r.py - q.py);
      if (dp > 0.2) {
        moved++; travel += dp;
        track = Math.max(track, Math.abs(Math.hypot(r.dx - q.dx, r.dy - q.dy) - dp));
      }
    }
  }
  return { frames: f.length, moved, travel, weld, track, frac, gone: rec.length - f.length };
}

async function sweep(c, where) {
  // The selected pin is never absorbed into a cluster, so it is the one marker guaranteed to
  // survive a whole sweep — and a marker that vanishes mid-gesture measures nothing.
  const pin = await evaluate(c, `(() => { const at = ${AT};
    const r = document.querySelector('.mp-surface').getBoundingClientRect();
    const l = [...document.querySelectorAll('.mp-pin')].map((n) => ({ id: n.dataset.id, p: at(n) })).filter((x) => x.p);
    l.sort((a, b) => Math.hypot(a.p[0] - r.width / 2, a.p[1] - r.height / 3) - Math.hypot(b.p[0] - r.width / 2, b.p[1] - r.height / 3));
    return l[0] || null; })()`);
  if (!pin) throw new Error(`${where}: no pin on screen to track`);
  await evaluate(c, `document.querySelector('.mp-pin[data-id=' + JSON.stringify(${JSON.stringify(pin.id)}) + ']').click()`);
  await sleep(900);
  await watch(c, pin.id);

  // A pan of 40 steps, one step per frame, 2.6 x 1.7 px each: a slow drag is where a rounded
  // transform shows worst, because every pin crosses its own pixel boundary at its own moment.
  await evaluate(c, `window.__watch()`);
  const x0 = 200, y0 = 430;
  await touch(c, "touchStart", [{ x: x0, y: y0 }]);
  for (let i = 1; i <= 40; i++) {
    await touch(c, "touchMove", [{ x: x0 - i * 2.6, y: y0 - i * 1.7 }]);
    await sleep(17);
  }
  await touch(c, "touchEnd", []);
  // Kept recording through the INERTIAL GLIDE as well: MapLibre keeps firing 'move' after the
  // finger is gone, and a marker that only keeps up while a finger is down is not welded.
  await sleep(800);
  const pan = verdict(await evaluate(c, `window.__stop()`));

  // …and a pinch, because "welded" has to survive the scale changing under the anchor too.
  await evaluate(c, `window.__watch()`);
  await touch(c, "touchStart", [{ x: 160, y: 420, id: 1 }, { x: 230, y: 420, id: 2 }]);
  for (let i = 1; i <= 16; i++) {
    await touch(c, "touchMove", [{ x: 160 - i * 5, y: 420, id: 1 }, { x: 230 + i * 5, y: 420, id: 2 }]);
    await sleep(17);
  }
  await touch(c, "touchEnd", []);
  await sleep(140);
  const zoom = verdict(await evaluate(c, `window.__stop()`));
  return { pin, pan, zoom };
}

async function item4() {
  for (const [where, cam, theme] of [["Cusco", CUSCO, "dark"], ["Lima", LIMA, "light"]]) {
    const c = await launch();
    try {
      await boot(c, { cam, theme });
      await settle(c);
      await shot(c, `item4-${where.toLowerCase()}-${theme}-before.png`);
      const { pin, pan, zoom } = await sweep(c, where);
      check(`item 4 · ${where}: a pan sweep keeps the pin welded to its coordinate`,
        pan.moved >= 20 && pan.weld < 1 && pan.gone === 0,
        `${pan.moved} moving frames, ${pan.travel.toFixed(0)}px of camera, worst offset ${pan.weld.toFixed(4)}px (${pin.id})`);
      check(`item 4 · ${where}: the pin's screen delta tracks the camera delta every frame`,
        pan.moved >= 20 && pan.track < 1, `worst frame-to-frame mismatch ${pan.track.toFixed(4)}px`);
      check(`item 4 · ${where}: the transforms are UNROUNDED — no pixel snapping`,
        pan.frac === pan.frames, `${pan.frac}/${pan.frames} frames carry a fractional transform`);
      check(`item 4 · ${where}: a pinch keeps the pin welded while the scale changes`,
        zoom.frames > 8 && zoom.weld < 1,
        `${zoom.frames} frames, worst offset ${zoom.weld.toFixed(4)}px`);
      await shot(c, `item4-${where.toLowerCase()}-${theme}.png`);
    } finally { await c.kill(); }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// ITEM 7 — clusters split on the tap, and stop forming so early
// ═══════════════════════════════════════════════════════════════════════════════════════

// Tap the biggest disc on screen and report what happened to the map.
// How far apart, on the ground, the members of one disc actually are — read out of the seed
// the database was built from, by id.
let SEED = null;
function spreadM(ids) {
  if (!SEED) SEED = new Map(require(path.join(REPO, "seed/demo-trip.json")).places.map((p) => [p.id, p]));
  const ps = ids.map((id) => SEED.get(id)).filter((p) => p && p.lat != null);
  if (ps.length !== ids.length || ps.length < 2) return null;
  let max = 0;
  for (let i = 0; i < ps.length; i++) {
    for (let k = i + 1; k < ps.length; k++) {
      const la = (+ps[i].lat + +ps[k].lat) / 2 * Math.PI / 180;
      max = Math.max(max, Math.hypot((+ps[k].lat - +ps[i].lat) * 110540,
        (+ps[k].lng - +ps[i].lng) * 111320 * Math.cos(la)));
    }
  }
  return max;
}

async function tapCluster(c) {
  // Any fan left open would be holding its members out of the clustering pass.
  await evaluate(c, `(() => { const h = document.querySelector('.mp-hub'); if (h && !h.hidden) h.click(); return 1; })()`);
  await sleep(600);
  const before = await evaluate(c, SNAP);
  const cam0 = await evaluate(c, `(() => { const m = window.__mlmap, c = m.getCenter();
    return { lng: c.lng, lat: c.lat, z: m.getZoom() }; })()`);
  const cl = before.clusters.slice().sort((a, b) => b.n - a.n)[0];
  if (!cl) return null;
  await tap(c, Math.round(cl.p[0]), Math.round(before.top + cl.p[1]));
  await sleep(1500);
  const after = await evaluate(c, SNAP);
  const cam1 = await evaluate(c, `(() => { const m = window.__mlmap, c = m.getCenter();
    return { lng: c.lng, lat: c.lat, z: m.getZoom() }; })()`);
  const ids = cl.ids.split(",");
  const shown = ids.filter((id) => after.pins.some((p) => p.id === id));
  const labelled = ids.filter((id) => after.pins.some((p) => p.id === id && p.label === "1"));
  // "Did the camera fly?" — a zoom change of any consequence, or a pan of more than a fan's
  // own radius. The fan is allowed the small nudge that keeps a ring against the edge of the
  // screen fully on it (openCluster's `need`); it is not allowed to travel.
  const mpp = 40075016 * Math.cos(cam0.lat * Math.PI / 180) / (512 * Math.pow(2, cam0.z));
  const panPx = Math.hypot((cam1.lng - cam0.lng) * 111320 * Math.cos(cam0.lat * Math.PI / 180),
    (cam1.lat - cam0.lat) * 110540) / mpp;
  return { cl, before, after, cam0, cam1, shown, labelled, panPx,
    moved: Math.abs(cam1.z - cam0.z) > 0.02 || panPx > 120 };
}

async function item7() {
  const c = await launch();
  let logs = [];
  try {
    ({ logs } = await boot(c, { cam: DOORWAY, theme: "dark" }));
    await settle(c);

    // (a) MAX_ZOOM, three places in one doorway: the zoom that would separate them does not
    // exist, so the tap has nothing but the fan to answer with.
    await jumpTo(c, DOORWAY.lng, DOORWAY.lat, 18);
    await sleep(900);
    await shot(c, "item7-maxzoom-before.png");
    const max = await tapCluster(c);
    check("item 7a: at MAX_ZOOM a cluster tap fans the group open",
      !!max && max.after.legs && max.after.hub && max.shown.length === max.cl.n,
      max ? `${max.cl.n} members -> ${max.shown.length} pins, legs ${max.after.legs}, hub ${max.after.hub}` : "no cluster at z18");
    check("item 7a: every fanned member is a named pin, not a number",
      !!max && max.labelled.length === max.cl.n,
      max ? `${max.labelled.length}/${max.cl.n} labelled` : "");
    check("item 7a: the fan opened without a camera move",
      !!max && !max.moved,
      max ? `z ${max.cam0.z.toFixed(3)} -> ${max.cam1.z.toFixed(3)}, camera panned ${max.panPx.toFixed(1)}px` : "");
    await shot(c, "item7-maxzoom-after.png");

    // An open fan has to ride the camera as one rigid thing — item 4's requirement, for the
    // shape item 7a invents. The legs are screen-space constants off a coordinate, so a pan
    // must move hub and members by exactly the same vector.
    const member = max ? max.cl.ids.split(",")[0] : "";
    const rig = `(() => { const at = ${AT};
      const hub = document.querySelector('.mp-hub');
      const pin = document.querySelector('.mp-pin[data-id=' + JSON.stringify(${JSON.stringify(member)}) + ']');
      return { hub: hub && at(hub), pin: pin && at(pin), id: pin && pin.dataset.id }; })()`;
    const r0 = await evaluate(c, rig);
    await touch(c, "touchStart", [{ x: 120, y: 300 }]);
    for (let i = 1; i <= 10; i++) { await touch(c, "touchMove", [{ x: 120 + i * 6, y: 300 + i * 4 }]); await sleep(17); }
    await touch(c, "touchEnd", []);
    await sleep(700);
    const r1 = await evaluate(c, rig);
    const legDrift = (r0.hub && r1.hub && r0.pin && r1.pin && r0.id === r1.id)
      ? Math.hypot((r1.pin[0] - r1.hub[0]) - (r0.pin[0] - r0.hub[0]),
                   (r1.pin[1] - r1.hub[1]) - (r0.pin[1] - r0.hub[1])) : NaN;
    const hubMoved = r0.hub && r1.hub ? Math.hypot(r1.hub[0] - r0.hub[0], r1.hub[1] - r0.hub[1]) : 0;
    check("item 7a: an open fan rides the camera rigidly through a pan",
      legDrift < 0.01 && hubMoved > 40,
      `hub moved ${hubMoved.toFixed(1)}px, leg drifted ${Number.isNaN(legDrift) ? "n/a" : legDrift.toFixed(4)}px`);
    await tap(c, 200, 300);   // fold the fan
    await sleep(600);

    // (a) again at street zoom, where v4 answered a 2-cluster with a camera flight.
    await jumpTo(c, CUSCO.lng, CUSCO.lat, 16);
    await sleep(1000);
    const small = await evaluate(c, `(() => { const s = ${SNAP};
      return s.clusters.filter((c) => c.n <= 3).sort((a, b) => a.n - b.n)[0] || null; })()`);
    if (small) {
      const cam0 = await evaluate(c, `(() => { const m = window.__mlmap; return m.getZoom(); })()`);
      const top = await evaluate(c, `document.querySelector('.mp-surface').getBoundingClientRect().top`);
      await tap(c, Math.round(small.p[0]), Math.round(top + small.p[1]));
      await sleep(1400);
      const after = await evaluate(c, SNAP);
      const cam1 = await evaluate(c, `(() => { const m = window.__mlmap; return m.getZoom(); })()`);
      const ids = small.ids.split(",");
      const shown = ids.filter((id) => after.pins.some((p) => p.id === id && p.label === "1"));
      check(`item 7a: a ${small.n}-cluster at street zoom opens in place, with names`,
        after.legs && shown.length === small.n && Math.abs(cam1 - cam0) < 0.02,
        `${shown.length}/${small.n} named pins, zoom ${cam0.toFixed(2)} -> ${cam1.toFixed(2)}`);
      await shot(c, "item7-street-fan.png");
      await tap(c, 200, 300);
      await sleep(600);
    } else {
      check("item 7a: a small cluster at street zoom opens in place", false, "no 2- or 3-cluster on screen at z16");
    }

    // The other half of the rule: a group too big for a ring is answered with the zoom that
    // actually separates it, and that tap must still SPLIT the group rather than just move.
    await jumpTo(c, CUSCO.lng, CUSCO.lat, 14);
    await sleep(1000);
    const big = await evaluate(c, `(() => { const s = ${SNAP};
      return s.clusters.filter((c) => c.n > 4).sort((a, b) => b.n - a.n)[0] || null; })()`);
    if (big) {
      const top = await evaluate(c, `document.querySelector('.mp-surface').getBoundingClientRect().top`);
      await tap(c, Math.round(big.p[0]), Math.round(top + big.p[1]));
      await sleep(1800);
      const s2 = await evaluate(c, SNAP);
      const z2 = await evaluate(c, `window.__mlmap.getZoom()`);
      const intact = s2.clusters.some((x) => x.ids === big.ids);
      check(`item 7a: a ${big.n}-cluster is answered with a zoom that splits it`,
        z2 > 14.2 && !intact && !s2.legs,
        `zoom 14 -> ${z2.toFixed(2)}, the ${big.n} are now ${s2.clusters.filter((x) => big.ids.split(",").some((i) => x.ids.includes(i))).map((x) => x.n).join("+") || "loose pins"}`);
      await shot(c, "item7-bigcluster-zoomed.png");
    }

    // (b) the census. The bar is the shape of the complaint: at street zoom the map is
    // mostly PINS, and the discs that remain are places that genuinely share a doorway.
    const census = [];
    for (const [name, ll] of [["Cusco Centro", [CUSCO.lng, CUSCO.lat]], ["Lima Miraflores", [LIMA.lng, LIMA.lat]],
                              ["Cusco San Blas", [-71.975, -13.515]], ["Lima Barranco", [-77.022, -12.147]]]) {
      for (const z of [16, 17]) {
        await jumpTo(c, ll[0], ll[1], z);
        await sleep(800);
        const s = await evaluate(c, SNAP);
        census.push({ name, z, pins: s.pins.length, scale: s.scale,
          clusters: s.clusters.map((x) => x.n), ids: s.clusters.map((x) => x.ids) });
        if (name === "Cusco Centro" && z === 16) await shot(c, "item7-cusco-z16.png");
      }
    }
    for (const row of census) {
      console.log(`      ${row.name} z${row.z} (${row.scale}): ${row.pins} pins, ` +
        `${row.clusters.length} discs [${row.clusters.slice().sort((a, b) => a - b).join(",")}]`);
    }
    const z17 = census.filter((r) => r.z === 17);
    check("item 7b: at 49 m across the screen the map is pins, not discs",
      z17.every((r) => r.pins >= r.clusters.length * 2),
      z17.map((r) => `${r.name}: ${r.pins}p/${r.clusters.length}d`).join("  "));
    const z16 = census.find((r) => r.name === "Cusco Centro" && r.z === 16);
    // v5 baseline, measured on the code this pass replaced: 24 pins against 14 discs.
    check("item 7b: Cusco Centro at 97 m splits far more than it groups",
      z16 && z16.pins >= 30 && z16.pins > z16.clusters.length * 2,
      `${z16.pins} pins, ${z16.clusters.length} discs (was 24 pins / 14 discs)`);

    // …and the last word on 7b: whatever is STILL a disc at street zoom has to be places that
    // genuinely share a doorway, not a block of the city collapsed into a number. Measured off
    // the seed's own coordinates, so this is a statement about the trip's data and not about
    // whatever happened to be in the viewport.
    const worst = [];
    for (const row of z17) {
      for (const ids of row.ids) {
        const s = spreadM(ids.split(","));
        if (s != null) worst.push({ where: `${row.name} [${ids.split(",").length}]`, m: s });
      }
    }
    worst.sort((a, b) => b.m - a.m);
    check("item 7b: the discs left at street zoom are places sharing one doorway",
      worst.every((w) => w.m <= 30),
      worst.length ? `widest ${worst[0].where} spans ${worst[0].m.toFixed(1)} m` : "no discs left at all");

    const errors = logs.filter((l) => /^error|LOG\/error/i.test(l));
    check("item 7: fanning, folding and re-clustering logged no errors",
      errors.length === 0, errors.slice(0, 2).join(" | "));
  } finally { await c.kill(); }

  // The same tap in the LIGHT theme, over Lima: four counters inside the airport terminal —
  // left luggage, the exchange desk, the rideshare pickup and the terminal itself — which no
  // zoom has ever been able to tell apart.
  const c2 = await launch();
  try {
    await boot(c2, { cam: { lng: -77.1185594, lat: -12.019428, zoom: 18 }, theme: "light" });
    await settle(c2);
    await jumpTo(c2, -77.1185594, -12.019428, 18);
    await sleep(1000);
    await shot(c2, "item7-lima-light-before.png");
    const lima = await tapCluster(c2);
    check("item 7a · Lima, light theme: the airport counters fan out at MAX_ZOOM",
      !!lima && lima.after.legs && lima.shown.length === lima.cl.n && lima.labelled.length === lima.cl.n,
      lima ? `${lima.cl.n} members -> ${lima.labelled.length} named pins` : "no cluster at z18");
    await shot(c2, "item7-lima-light-fan.png");
  } finally { await c2.kill(); }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// ITEM 8 — one map, kept alive
// ═══════════════════════════════════════════════════════════════════════════════════════
async function item8() {
  const c = await launch();
  try {
    const { reqs } = await boot(c, { cam: CUSCO, theme: "dark", net: true });
    await settle(c);
    await evaluate(c, `(() => { window.__mlmap.__wgpTag = 'alpha';
      const cv = document.querySelector('.maplibregl-canvas'); if (cv) cv.__wgpTag = 'alpha'; return 1; })()`);
    const ctx0 = await evaluate(c, `window.__ctx`);

    // The measurement runs INSIDE the page: hash change to a map that is on screen, painted,
    // and carrying markers, counted in animation frames rather than in round trips.
    await evaluate(c, `window.__reentry = (hash) => new Promise((res) => {
      const t0 = performance.now();
      location.hash = hash;
      const tick = () => {
        const r = document.querySelector('.mp-root');
        const ok = r && r.isConnected && document.querySelector('.mp-pin,.mp-cluster') &&
          document.querySelector('.maplibregl-canvas') && r.getBoundingClientRect().height > 200;
        if (ok) requestAnimationFrame(() => res(+(performance.now() - t0).toFixed(1)));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })`);

    // Away to another tab, and back. This is places.js's real unmount: mapHandle.destroy().
    // Four times, because the FIRST return of a session can land on top of the archive stash —
    // 19.5 MB fetched and written into Cache Storage a few seconds after the map goes idle,
    // which is main-thread work that has nothing to do with the map's own re-attachment.
    // Profiled at a 200 µs sampling interval, map.js's whole share of a return is 0.3 ms; the
    // number that matters here is therefore the one taken with the device not busy.
    const times = [];
    let gone = false;
    let mark = 0;
    for (let i = 0; i < 4; i++) {
      await evaluate(c, `void (location.hash = '#/agenda')`);
      await sleep(1800);
      if (i === 0) gone = await evaluate(c, `!document.querySelector('.mp-root')`);
      mark = reqs.length;
      times.push(await evaluate(c, `window.__reentry('#/places?view=map')`));
      await sleep(i === 0 ? 900 : 300);
    }
    const t = Math.min(...times.slice(1));
    await shot(c, "item8-reentry.png");
    const after = await evaluate(c, `(() => { const cv = document.querySelector('.maplibregl-canvas');
      return { tag: window.__mlmap && window.__mlmap.__wgpTag, canvas: cv && cv.__wgpTag,
        maps: window.__maps.size, ctx: window.__ctx,
        pins: document.querySelectorAll('.mp-pin,.mp-cluster').length }; })()`);
    const fetched = reqs.slice(mark).filter((r) => !/\/api\//.test(r.url));

    check("item 8: leaving Places really does take the map out of the document", gone);
    check("item 8: coming back is instant — the map is painted within two frames",
      t < 100 && times.every((x) => x < 600),
      `${t} ms from hashchange to a painted map with ${after.pins} markers (all four: ${times.join(", ")} ms)`);
    check("item 8: it is the SAME MapLibre instance, not a rebuild",
      after.tag === "alpha" && after.maps === 1, `tag ${after.tag}, ${after.maps} instance(s) ever created`);
    check("item 8: the same canvas and the same WebGL context came back",
      after.canvas === "alpha" && after.ctx === ctx0, `contexts ${ctx0} -> ${after.ctx}`);
    check("item 8: re-entry fetched nothing at all",
      fetched.length === 0, fetched.slice(0, 3).map((r) => r.url.replace(ORIGIN, "")).join(" | "));

    // The list/map toggle inside Places is the other mount path, and the one used most.
    const mark2 = reqs.length;
    const t2 = await evaluate(c, `(async () => {
      document.querySelector('.pl-viewbtn').click();
      await new Promise((r) => setTimeout(r, 900));
      const t0 = performance.now();
      document.querySelector('.pl-viewbtn').click();
      return await new Promise((res) => { const tick = () => {
        const r = document.querySelector('.mp-root');
        if (r && r.isConnected && document.querySelector('.mp-pin,.mp-cluster') && r.getBoundingClientRect().height > 200)
          requestAnimationFrame(() => res(+(performance.now() - t0).toFixed(1)));
        else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    })()`).catch(() => null);
    if (t2 != null) {
      const after2 = await evaluate(c, `window.__maps.size`);
      check("item 8: the list/map toggle re-attaches the same map, instantly",
        t2 < 100 && after2 === 1, `${t2} ms, ${after2} instance(s)`);
      check("item 8: the toggle fetched nothing either",
        reqs.slice(mark2).filter((r) => !/\/api\//.test(r.url)).length === 0);
    }

    // ── the archive, on a SECOND page load ──
    // The stash lands a few seconds after the map goes idle; once it has, a reload reads the
    // whole archive out of Cache Storage and the network never sees a byte of it. That is what
    // makes day four on the Inca Trail look like day one.
    await waitFor(c, `(async () => { try { const cc = await caches.open('wgp-tiles-v1');
      const r = await cc.match('/tiles/peru.pmtiles'); return !!(r && r.ok); } catch { return false; } })()`, 90000);
    const mark3 = reqs.length;
    await c.send("Page.navigate", { url: ORIGIN + "/t/demo-2027/#/places?view=map" });
    await waitFor(c, `document.querySelector('.mp-root') && document.querySelector('.mp-root').dataset.engine === 'gl'`);
    await sleep(6000);
    const arch = reqs.slice(mark3).filter((r) => /peru\.pmtiles/.test(r.url));
    const tiles = await evaluate(c, `!document.querySelector('.mp-scrim').hidden`);
    check("item 8: a second visit reads the archive from Cache Storage, not the network",
      arch.length === 0 && tiles, `${arch.length} pmtiles request(s), tiles up: ${tiles}`);
    await shot(c, "item8-second-visit.png");
  } finally { await c.kill(); }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
(async () => {
  try {
    const probe = await fetch(ORIGIN + "/t/demo-2027/", { redirect: "manual" }).catch(() => null);
    if (!probe) throw new Error(`nothing is serving ${ORIGIN} — start: npx wrangler pages dev`);
    if (!ONLY || ONLY.includes("4")) await item4();
    if (!ONLY || ONLY.includes("7")) await item7();
    if (!ONLY || ONLY.includes("8")) await item8();
  } catch (e) {
    console.error("\nHARNESS ERROR", e.stack || e);
    results.push({ ok: false, name: "harness completed" });
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed` +
    (bad.length ? `\nfailed: ${bad.map((b) => b.name).join("; ")}` : "") +
    `\nscreenshots: ${SHOTS}`);
  process.exit(bad.length ? 1 : 0);
})();

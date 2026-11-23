#!/usr/bin/env node
/* Proves the MAP's gestures and geometry against real Chrome, real frames and real MapLibre.
 *
 * v4 item 8 is "touch is horribly unresponsive, drops inputs", and the only honest way to
 * answer it is to move a synthetic finger and check that the camera went where the finger
 * went. This drives headless Chrome over CDP with touch emulation on, dispatches real
 * multi-touch sequences, and reads the answer back out of the DOM the map actually paints —
 * marker transforms for the camera, the scale plate for the zoom, the compass needle for the
 * bearing. Nothing here trusts an internal.
 *
 * It also holds the rest of the v4 map list to the same standard: three controls, the canvas
 * reaching the tab bar, chips that do not reflow it, a card that does not scroll, and a
 * console with no sprite warnings in it.
 *
 * Dev-only. scripts/ is outside pages_build_output_dir, so nothing here ships.
 *
 *   this lane's dev server must be running; WGP_BASE=http://127.0.0.1:<port> says where
 *   node scripts/map_harness.js
 *
 * No dependencies: Node 22+ has a global WebSocket and fetch, which is the whole CDP client.
 * The session cookie is minted here from .dev.vars, exactly as the app's middleware expects.
 *
 * MACOS NOTE: Chrome puts its ProcessSingleton socket inside the profile directory and unix
 * socket paths cap at ~104 characters, so the profile lives at a deliberately short path. A
 * profile under a long scratch directory makes Chrome abort at startup with "Failed to create
 * socket directory", which looks nothing like the cause.
 */
const { baseUrl, launchChrome } = require("./lib/browser.mjs");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const ORIGIN = baseUrl();   // WGP_BASE or --base=<url>: this lane's dev server (scripts/lib/browser.mjs)
const HOST = new URL(ORIGIN).hostname;
const SHOTS = path.join(REPO, "build", "map-shots");

// Two cameras, because a map that is right in one city and wrong in the other is a projection
// bug wearing a screenshot. Cusco is the tight one (San Blas, 15 m alleys); Lima is the wide one.
const CUSCO = { lng: -71.978, lat: -13.517, zoom: 14 };
const CUSCO_TIGHT = { lng: -71.978, lat: -13.517, zoom: 15 };
const LIMA = { lng: -77.028, lat: -12.121, zoom: 14 };

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
        return new Promise((res, rej) => { pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
      },
      on(method, fn) { listeners.set(method, [...(listeners.get(method) || []), fn]); },
    }));
  });
}

async function evaluate(c, expression) {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error("eval threw: " + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
  }
  return r.result.value;
}
async function shot(c, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, "base64"));
}

// ── touch ──────────────────────────────────────────────────────────────────────────────
const pts = (a) => a.map((p, i) => ({ x: p.x, y: p.y, id: p.id == null ? i : p.id, radiusX: 12, radiusY: 12, force: 1 }));
const touch = (c, type, points) => c.send("Input.dispatchTouchEvent", { type, touchPoints: pts(points) });
async function tap(c, x, y) {
  await touch(c, "touchStart", [{ x, y }]);
  await sleep(70);
  await touch(c, "touchEnd", []);
}
async function drag(c, from, to, steps = 9) {
  await touch(c, "touchStart", [from]);
  for (let i = 1; i <= steps; i++) {
    await touch(c, "touchMove", [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }]);
    await sleep(16);
  }
  await touch(c, "touchEnd", []);
}

// ── reading the camera out of the DOM ──────────────────────────────────────────────────
const MARKERS = `(() => { const out = {};
  for (const n of document.querySelectorAll('.mp-pin,.mp-cluster')) {
    const m = /translate3d\\((-?[\\d.]+)px,\\s*(-?[\\d.]+)px/.exec(n.style.transform || '');
    if (m) out[n.dataset.id || n.dataset.ids] = [ +m[1], +m[2] ]; } return out; })()`;
const SCALE = `(document.querySelector('.mp-scale-t') || {}).textContent`;
const NEEDLE = `(() => { const n = document.querySelector('.mp-needle');
  const m = n && /rotate\\((-?[\\d.]+)deg\\)/.exec(n.style.transform || ''); return m ? +m[1] : 0; })()`;
const shared = (a, b) => Object.keys(a).find((k) => b[k]) || null;

async function boot(c, { cam = CUSCO, noWebgl = false, reduce = false } = {}) {
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Log.enable"); await c.send("Network.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  if (reduce) {
    await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  }
  if (noWebgl) {
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (t, ...a) {
        if (t === 'webgl2' || t === 'webgl' || t === 'experimental-webgl') return null;
        return orig.call(this, t, ...a); };` });
  }
  const logs = [];
  c.on("Runtime.consoleAPICalled", (p) => logs.push(p.type + ": " + p.args.map((a) => a.value ?? a.description ?? "").join(" ")));
  c.on("Log.entryAdded", (p) => logs.push("LOG/" + p.entry.level + ": " + p.entry.text));
  // Every run starts on the same camera, so a failure is a failure and not a different city.
  // Element.animate is hooked before anything runs: it is how the reduced-motion pass proves a
  // negative rather than describing one.
  await c.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__players = [];
    const oa = Element.prototype.animate;
    Element.prototype.animate = function (kf, opt) {
      const c = this.className; window.__players.push(String(c && c.baseVal !== undefined ? c.baseVal : c));
      return oa.call(this, kf, opt); };
    try { localStorage.setItem('wgp.map.cam@demo-2027', JSON.stringify({ ...${JSON.stringify(cam)}, at: Date.now() }));
          localStorage.setItem('wgp.map.sheet', 'open'); } catch {}` });
  await c.send("Network.setCookie", { name: "s2", value: cookie(), domain: HOST, path: "/" });
  await c.send("Page.navigate", { url: ORIGIN + "/t/demo-2027/#/places?view=map" });
  await sleep(8000);
  return logs;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// 1. GESTURES + CHROME, on the GL engine
// ═══════════════════════════════════════════════════════════════════════════════════════
async function gestures() {
  const c = await launch();
  try {
    const logs = await boot(c);
    const info = await evaluate(c, `(() => {
      const rect = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
        return { top:+r.top.toFixed(1), bottom:+r.bottom.toFixed(1), w:+r.width.toFixed(1) }; };
      const root = document.querySelector('.mp-root'), layer = document.querySelector('.mp-layer');
      return { engine: root.dataset.engine, root: rect('.mp-root'), view: rect('#view'), tab: rect('.tabbar'),
        head: rect('.pl-head'), scaleRule: rect('.mp-scale-rule'), scale: rect('.mp-scale'),
        ctrls: [...document.querySelectorAll('.mp-ctrl')].map((b) => b.dataset.act),
        ground: !!document.querySelector('.mp-ground'), attrib: !!document.querySelector('.maplibregl-ctrl-attrib'),
        layerParent: layer.parentElement.className,
        rows: document.querySelectorAll('.mp-list .pl-row').length,
        prose: document.querySelector('.mp-body').textContent }; })()`);

    check("engine: MapLibre owns the camera", info.engine === "gl", info.engine);
    check("item 8: the marker layer is INSIDE MapLibre's canvas container",
      /maplibregl-canvas-container/.test(info.layerParent));
    check("item 9: exactly three controls — compass, fit, locate",
      info.ctrls.join(",") === "north,fit,geo", info.ctrls.join(","));
    check("item 10: no attribution control on the canvas", !info.ground && !info.attrib);
    check("item 11: the canvas reaches the tab bar",
      Math.abs(info.root.bottom - info.tab.top) < 1.5, `root ${info.root.bottom} / tabbar ${info.tab.top}`);
    check("item 13: the canvas starts at the top of #view, under the head",
      Math.abs(info.root.top - info.view.top) < 1.5, `root ${info.root.top}, head ends ${info.head.bottom}`);
    check("item 12: the scale rule is 84px and bottom-left",
      Math.abs(info.scaleRule.w - 84) < 0.6 && info.scale.top > 300, `${info.scaleRule.w}px`);
    check("item 14: the nearby sheet is a full list, and carries no prose",
      info.rows > 3 && !/routing|crosshair|GPS needs|Google Maps offline/i.test(info.prose), `${info.rows} rows`);

    // ── one-finger pan ──
    let before = await evaluate(c, MARKERS);
    await drag(c, { x: 200, y: 380 }, { x: 120, y: 332 });
    await sleep(900);
    let after = await evaluate(c, MARKERS);
    let k = shared(before, after);
    const dx = k ? after[k][0] - before[k][0] : NaN;
    const dy = k ? after[k][1] - before[k][1] : NaN;
    check("item 8: one-finger PAN — the camera tracks the finger",
      k && dx < -50 && dy < -30, `marker moved ${dx.toFixed(1)},${dy.toFixed(1)} for a finger of -80,-48`);

    // ── pinch ──
    const s0 = await evaluate(c, SCALE);
    await touch(c, "touchStart", [{ x: 160, y: 380, id: 1 }, { x: 230, y: 380, id: 2 }]);
    for (let i = 1; i <= 10; i++) {
      await touch(c, "touchMove", [{ x: 160 - i * 8, y: 380, id: 1 }, { x: 230 + i * 8, y: 380, id: 2 }]);
      await sleep(16);
    }
    await touch(c, "touchEnd", []);
    await sleep(800);
    const s1 = await evaluate(c, SCALE);
    check("item 8: two-finger PINCH zooms", s0 !== s1, `${s0} -> ${s1}`);
    const ruleW = await evaluate(c, `document.querySelector('.mp-scale-rule').getBoundingClientRect().width`);
    check("item 12: the ruler's footprint never changes, only its value",
      Math.abs(ruleW - 84) < 0.6, `${ruleW}px at ${s1}`);

    // ── twist ──
    const n0 = await evaluate(c, NEEDLE);
    const cx = 195, cy = 380, r = 60;
    await touch(c, "touchStart", [{ x: cx - r, y: cy, id: 1 }, { x: cx + r, y: cy, id: 2 }]);
    for (let i = 1; i <= 14; i++) {
      const a = (i * 5) * Math.PI / 180;
      await touch(c, "touchMove", [
        { x: cx - r * Math.cos(a), y: cy - r * Math.sin(a), id: 1 },
        { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), id: 2 }]);
      await sleep(16);
    }
    await touch(c, "touchEnd", []);
    await sleep(700);
    const n1 = await evaluate(c, NEEDLE);
    check("item 8: two-finger TWIST rotates, and the compass follows",
      Math.abs(n1 - n0) > 8, `needle ${n0}deg -> ${n1}deg`);
    await shot(c, "cusco-rotated.png");

    await evaluate(c, `document.querySelector('[data-act="north"]').click()`);
    await sleep(900);
    check("item 9: the compass control puts north back",
      Math.abs(await evaluate(c, NEEDLE)) < 0.6);

    // ── pitch ──
    await touch(c, "touchStart", [{ x: 170, y: 420, id: 1 }, { x: 220, y: 420, id: 2 }]);
    for (let i = 1; i <= 12; i++) {
      await touch(c, "touchMove", [{ x: 170, y: 420 - i * 8, id: 1 }, { x: 220, y: 420 - i * 8, id: 2 }]);
      await sleep(16);
    }
    await touch(c, "touchEnd", []);
    await sleep(700);
    check("item 8: two-finger drag PITCHES",
      (await evaluate(c, `document.querySelector('[data-act="north"]').dataset.north`)) === "0");
    await evaluate(c, `document.querySelector('[data-act="north"]').click()`);
    await sleep(800);

    // ── chips overlay, no reflow ──
    const g0 = await evaluate(c, `(() => { const r = document.querySelector('.mp-root').getBoundingClientRect();
      return [+r.top.toFixed(1), +r.bottom.toFixed(1)]; })()`);
    const chip = await evaluate(c, `(() => { const b = [...document.querySelectorAll('.pl-head .chip[data-kind]')]
      .find((x) => x.dataset.kind === 'food'); const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
        onTop: !!(document.elementFromPoint(Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)) || {}).closest('.chip') }; })()`);
    check("the head's chips are still the topmost thing where they sit", chip.onTop);
    await tap(c, chip.x, chip.y);      // a REAL touch, not a synthetic click
    await sleep(1400);
    const g1 = await evaluate(c, `(() => { const r = document.querySelector('.mp-root').getBoundingClientRect();
      return { box: [+r.top.toFixed(1), +r.bottom.toFixed(1)],
        pressed: [...document.querySelectorAll('.pl-head .chip[aria-pressed="true"]')].map((x)=>x.textContent.trim()).join("|"),
        host: +document.querySelector('.pl-mapbody').getBoundingClientRect().top.toFixed(1) }; })()`);
    check("a real touch on a category chip still filters", /Food/.test(g1.pressed), g1.pressed);
    check("item 13: the second chip row appears and the canvas does NOT reflow",
      Math.abs(g1.box[0] - g0[0]) < 1.5 && Math.abs(g1.box[1] - g0[1]) < 1.5,
      `${g0.join("..")} -> ${g1.box.join("..")} while the host moved to ${g1.host}`);
    await shot(c, "cusco-chips-dark.png");

    // ── the abridged card ──
    // V5 item 5 DELETED the "All" chip — deselecting the active pill is what "all" means now.
    // This step used to find it by text and click it; after v5 it threw and every check below
    // this line silently stopped running. Same intent, expressed the way the app now works.
    await evaluate(c, `(() => { [...document.querySelectorAll('.pl-head .chip[aria-pressed="true"]')].forEach((x) => x.click()); return true; })()`);
    await sleep(900);
    await evaluate(c, `(document.querySelector('.mp-pin') || document.querySelector('.mp-cluster')).click()`);
    await sleep(900);
    const card = await evaluate(c, `(() => {
      const sheet = document.querySelector('.mp-sheet'), b = document.querySelector('.mp-body');
      const cs = getComputedStyle(sheet);
      return { mode: document.querySelector('.mp-root').dataset.mode,
        h: +sheet.getBoundingClientRect().height.toFixed(1), overflow: cs.overflow,
        radius: parseFloat(cs.borderTopLeftRadius), bodyOverflow: getComputedStyle(b).overflow,
        scrolls: b.scrollHeight > b.clientHeight + 1,
        name: (document.querySelector('.mp-title')||{}).textContent,
        glyph: !!document.querySelector('.mp-cat .ico'),
        addr: (document.querySelector('.mp-addr')||{}).textContent,
        acts: [...document.querySelectorAll('.mp-acts .btn')].map((x)=>x.textContent.trim()) }; })()`);
    check("item 15: fixed-height card that never scrolls internally",
      card.mode === "card" && !card.scrolls && card.bodyOverflow === "hidden", `${card.h}px`);
    check("item 15: the sheet clips its own rounded corners",
      card.overflow === "hidden" && card.radius > 4, `overflow ${card.overflow}, radius ${card.radius}`);
    check("item 15: name + glyph + address + one action row with a CTA",
      !!card.name && card.glyph && !!card.addr && card.acts.length === 2 && /Place page/.test(card.acts.join(" ")),
      `${card.name} / ${card.acts.join(" + ")}`);
    const hs = await evaluate(c, `(async () => { const out = [];
      for (const p of [...document.querySelectorAll('.mp-pin')].slice(0, 4)) {
        p.click(); await new Promise((r) => setTimeout(r, 260));
        out.push(+document.querySelector('.mp-sheet').getBoundingClientRect().height.toFixed(1)); }
      return out; })()`);
    check("item 15: every place gets the same card height", new Set(hs).size === 1, hs.join(","));
    await shot(c, "cusco-card-dark.png");

    const sprite = logs.filter((l) => /could not be loaded|sprite|generic_shield|townspot|capital/i.test(l));
    const errors = logs.filter((l) => /^error|LOG\/error/i.test(l));
    check("the sprite warnings are gone", sprite.length === 0, sprite.slice(0, 2).join(" | "));
    check("no console errors at all", errors.length === 0, errors.slice(0, 2).join(" | "));
  } finally { await c.kill(); }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// 2. THE PIN IS NOT A WALL — the specific thing item 8 was complaining about
// ═══════════════════════════════════════════════════════════════════════════════════════
async function pins() {
  const c = await launch();
  try {
    await boot(c, { cam: CUSCO_TIGHT });
    await evaluate(c, `document.querySelector('.mp-grab').click()`);   // more map to work with
    await sleep(600);
    const pin = await evaluate(c, `(() => {
      const top = document.querySelector('.mp-root').getBoundingClientRect().top;
      return [...document.querySelectorAll('.mp-pin')].map((n) => {
        const m = /translate3d\\((-?[\\d.]+)px,\\s*(-?[\\d.]+)px/.exec(n.style.transform || '');
        return m ? { id: n.dataset.id, x: Math.round(+m[1]), y: Math.round(+m[2] + top) } : null;
      }).filter(Boolean).filter((p) => p.x > 90 && p.x < 300 && p.y > 260 && p.y < 640)[0] || null; })()`);
    if (!pin) throw new Error("no pin landed in the safe zone — check the camera");
    // The teardrop hangs ABOVE its anchor (the tip is on the coordinate), so aim at the disc.
    const from = { x: pin.x, y: pin.y - 24 };

    const before = await evaluate(c, MARKERS);
    await drag(c, from, { x: from.x - 81, y: from.y - 36 });
    await sleep(900);
    const after = await evaluate(c, MARKERS);
    const k = shared(before, after);
    check("item 8: a drag that STARTS ON A PIN pans the map",
      k && after[k][0] - before[k][0] < -45, `marker dx ${k ? (after[k][0] - before[k][0]).toFixed(1) : "?"}`);
    check("item 8: ...and that drag did not select the pin",
      (await evaluate(c, `document.querySelector('.mp-root').dataset.mode`)) === "list");

    // The pin that was dragged from may have merged into a cluster on the way; ask for it by
    // id and fall back to any pin still standing on its own in the safe zone. "On its own"
    // must include OWNING ITS TAP POINT: the tap lands 24px above the anchor (the pin's
    // head), and since round 6 removed the practical landing filter the boot map carries
    // every pin — a candidate whose head sits under a cluster ring was being "tapped" into
    // the cluster (zoom, no card) and the check failed without any pin-tap regression.
    const moved = await evaluate(c, `(() => {
      const top = document.querySelector('.mp-root').getBoundingClientRect().top;
      const at = (n) => { const m = /translate3d\\((-?[\\d.]+)px,\\s*(-?[\\d.]+)px/.exec(n.style.transform || '');
        return m ? { x: Math.round(+m[1]), y: Math.round(+m[2] + top), n } : null; };
      const own = (p) => { const el = document.elementFromPoint(p.x, p.y - 24);
        return !!el && el.closest('.mp-pin') === p.n; };
      const want = document.querySelector('.mp-pin[data-id=' + JSON.stringify(${JSON.stringify(pin.id)}) + ']');
      const p = want && at(want);
      if (p && p.x > 60 && p.x < 330 && p.y > 240 && p.y < 660 && own(p)) return { x: p.x, y: p.y };
      const q = [...document.querySelectorAll('.mp-pin')].map(at).filter(Boolean)
        .filter((q) => q.x > 90 && q.x < 300 && q.y > 260 && q.y < 640).filter(own)[0];
      return q ? { x: q.x, y: q.y } : null; })()`);
    if (!moved) throw new Error("the pin left the safe zone and nothing replaced it");
    await tap(c, moved.x, moved.y - 24);
    await sleep(900);
    const st = await evaluate(c, `(() => { const r = document.querySelector('.mp-root');
      return { mode: r.dataset.mode, sheet: r.dataset.sheet, name: (document.querySelector('.mp-title')||{}).textContent }; })()`);
    check("item 8: a TAP on the same pin selects it and opens the card",
      st.mode === "card" && st.sheet === "open" && !!st.name, st.name);
    await shot(c, "cusco-pin-tap.png");

    // The sheet's own list must scroll without dragging the map underneath it.
    const m0 = await evaluate(c, MARKERS);
    await evaluate(c, `document.querySelector('.mp-x').click()`);
    await sleep(400);
    await evaluate(c, `if (document.querySelector('.mp-root').dataset.sheet === 'shut') document.querySelector('.mp-peek').click()`);
    await sleep(700);
    const sy = Math.round(await evaluate(c, `document.querySelector('.mp-sheet').getBoundingClientRect().top`)) + 120;
    await drag(c, { x: 195, y: sy }, { x: 195, y: sy - 96 }, 8);
    await sleep(700);
    const scrolled = await evaluate(c, `document.querySelector('.mp-body').scrollTop`);
    const m1 = await evaluate(c, MARKERS);
    const k2 = shared(m0, m1);
    check("the sheet's list scrolls without moving the map",
      scrolled > 20 && (!k2 || Math.abs(m1[k2][1] - m0[k2][1]) < 3), `scrollTop ${scrolled}`);
  } finally { await c.kill(); }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// 3. THE FLAT ENGINE — the map on a phone with no WebGL2, and on the first frame of every load
// ═══════════════════════════════════════════════════════════════════════════════════════
async function flat() {
  const c = await launch();
  try {
    const logs = await boot(c, { noWebgl: true });
    const st = await evaluate(c, `(() => { const r = document.querySelector('.mp-root');
      const b = r.getBoundingClientRect(), t = document.querySelector('.tabbar').getBoundingClientRect();
      return { engine: r.dataset.engine, glCanvas: !!document.querySelector('.mp-gl canvas'),
        markers: document.querySelectorAll('.mp-pin,.mp-cluster').length,
        ctrls: document.querySelectorAll('.mp-ctrl').length,
        gap: +(t.top - b.bottom).toFixed(1), rows: document.querySelectorAll('.mp-list .pl-row').length }; })()`);
    check("no WebGL2: the flat engine mounts with a drawn ground",
      st.engine === "flat" && !st.glCanvas && st.markers > 0, JSON.stringify(st));
    check("no WebGL2: the same three controls and the same box",
      st.ctrls === 3 && Math.abs(st.gap) < 1.5 && st.rows > 3, `gap ${st.gap}`);
    const before = await evaluate(c, MARKERS);
    await drag(c, { x: 200, y: 380 }, { x: 120, y: 332 });
    await sleep(400);
    const after = await evaluate(c, MARKERS);
    const k = shared(before, after);
    check("no WebGL2: one-finger pan still tracks the finger",
      k && Math.abs((after[k][0] - before[k][0]) + 80) < 12, `dx ${k ? (after[k][0] - before[k][0]).toFixed(1) : "?"}`);
    const s0 = await evaluate(c, SCALE);
    await touch(c, "touchStart", [{ x: 160, y: 380, id: 1 }, { x: 230, y: 380, id: 2 }]);
    for (let i = 1; i <= 10; i++) {
      await touch(c, "touchMove", [{ x: 160 - i * 8, y: 380, id: 1 }, { x: 230 + i * 8, y: 380, id: 2 }]);
      await sleep(16);
    }
    await touch(c, "touchEnd", []);
    await sleep(400);
    check("no WebGL2: pinch still zooms", (await evaluate(c, SCALE)) !== s0, `${s0} -> ${await evaluate(c, SCALE)}`);
    check("no WebGL2: no console errors", logs.filter((l) => /^error/i.test(l)).length === 0);
    await shot(c, "cusco-flat-dark.png");
  } finally { await c.kill(); }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// 4. REDUCED MOTION, the moving list, the credits, and Lima in the light theme
// ═══════════════════════════════════════════════════════════════════════════════════════
async function rest() {
  {
    const c = await launch();
    try {
      await boot(c, { reduce: true });
      await evaluate(c, `window.__players.length = 0`);
      await evaluate(c, `[...document.querySelectorAll('.pl-head .chip[data-kind]')].find((x)=>x.dataset.kind==='food').click()`);
      await sleep(900);
      await evaluate(c, `(document.querySelector('.mp-pin')||document.querySelector('.mp-cluster')).click()`);
      await sleep(900);
      const players = await evaluate(c, `window.__players.filter((cls) => /mp-/.test(cls))`);
      check("reduced motion: no pin drop-in and no selection spring", players.length === 0, players.slice(0, 3).join(","));
      check("reduced motion: nothing left running",
        (await evaluate(c, `document.getAnimations().filter((a)=>a.playState==='running').length`)) === 0);
    } finally { await c.kill(); }
  }
  {
    const c = await launch();
    try {
      await boot(c);
      const first0 = await evaluate(c, `(document.querySelector('.mp-list .pl-name')||{}).textContent`);
      await drag(c, { x: 330, y: 300 }, { x: 30, y: 300 }, 12);
      await sleep(1600);
      const first1 = await evaluate(c, `(document.querySelector('.mp-list .pl-name')||{}).textContent`);
      check("item 14: with no GPS fix the nearby list re-sorts as the map moves",
        first0 !== first1, `${first0} -> ${first1}`);

      await evaluate(c, `location.hash = '#/settings/credits'`);
      await sleep(2500);
      const cr = await evaluate(c, `(() => { const t = document.body.innerText;
        return { osm: /OpenStreetMap contributors/.test(t), odbl: /ODbL/.test(t), proto: /Protomaps/.test(t) }; })()`);
      check("item 10: OpenStreetMap and Protomaps are credited in Settings",
        cr.osm && cr.odbl && cr.proto, JSON.stringify(cr));
      await shot(c, "credits.png");
    } finally { await c.kill(); }
  }
  {
    const c = await launch();
    try {
      await boot(c, { cam: LIMA });
      await evaluate(c, `document.documentElement.setAttribute('data-theme','light')`);
      await sleep(1500);
      const st = await evaluate(c, `(() => { const r = document.querySelector('.mp-root').getBoundingClientRect();
        const t = document.querySelector('.tabbar').getBoundingClientRect();
        return { gap: +(t.top - r.bottom).toFixed(1), top: +r.top.toFixed(1),
          rows: document.querySelectorAll('.mp-list .pl-row').length }; })()`);
      check("light theme over Lima: the same geometry",
        Math.abs(st.gap) < 1.5 && Math.abs(st.top) < 1.5 && st.rows > 3, JSON.stringify(st));
      await shot(c, "lima-list-light.png");
      await evaluate(c, `(document.querySelector('.mp-pin')||document.querySelector('.mp-cluster')).click()`);
      await sleep(1200);
      await shot(c, "lima-card-light.png");
    } finally { await c.kill(); }
  }
}

(async () => {
  try {
    const probe = await fetch(ORIGIN + "/t/demo-2027/", { redirect: "manual" }).catch(() => null);
    if (!probe) throw new Error(`nothing is serving ${ORIGIN} — start: npx wrangler pages dev`);
    await gestures();
    await pins();
    await flat();
    await rest();
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

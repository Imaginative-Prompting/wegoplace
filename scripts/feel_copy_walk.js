#!/usr/bin/env node
/* v6 feel+copy verify: CDP walk of agenda / places / map / pack / settings in both themes.
 * Asserts: motion tokens resolve (no 0s durations from a missing var), reduced-motion kills
 * transitions/animations, sheet opens and closes cleanly at the system's 320 ms with EXIT_MS=360,
 * changed copy renders, no type under 12px and no opacity<1 on text among touched surfaces.
 * A plain CDP client, as the other walks use. */
const { baseUrl, launchChrome } = require("./lib/browser.mjs");
const { signedIn, tripPath } = require("./lib/gate_trip.mjs");
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const ORIGIN = baseUrl();   // WGP_BASE or --base=<url>: this lane's dev server (scripts/lib/browser.mjs)
const SHOTS = path.join(REPO, "build", "feel-copy-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// Signed in as the host of the gate's made-up trip, with a session of this run's own
// (scripts/lib/gate_trip.mjs).

async function launch() {
  // The shared launcher: Chrome for Testing, headless, muted, on a port read from its own
  // fresh profile (scripts/lib/browser.mjs). It is the only thing that starts a browser.
  const browser = await launchChrome({ args: [
    "--hide-scrollbars",
    "--force-device-scale-factor=1", "about:blank",
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
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      }
    });
    ws.addEventListener("error", () => reject(new Error("websocket failed")));
    ws.addEventListener("open", () => resolve({
      send(method, params = {}) {
        const mid = ++id;
        return new Promise((res, rej) => { pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
      },
    }));
  });
}

async function ev(c, expression) {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("eval threw: " + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
  return r.result.value;
}
async function shot(c, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, "base64"));
}

async function boot(c, { dark = false, reduce = false } = {}) {
  await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable");
  await c.send("Network.setBypassServiceWorker", { bypass: true });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  const features = [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }];
  if (reduce) features.push({ name: "prefers-reduced-motion", value: "reduce" });
  await c.send("Emulation.setEmulatedMedia", { features });
  for (const cookie of await signedIn()) await c.send("Network.setCookie", cookie);
  await c.send("Page.navigate", { url: ORIGIN + tripPath("#/") });
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    if (await ev(c, `document.querySelectorAll(".ag-day").length`) > 0) break;
  }
  await sleep(600);
}

async function go(c, hash, waitSel, ms = 9000) {
  await ev(c, `location.hash = ${JSON.stringify(hash)}; true`);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sleep(150);
    if (await ev(c, `!!document.querySelector(${JSON.stringify(waitSel)})`)) { await sleep(600); return true; }
  }
  return false;
}

const tap = async (c, sel) => ev(c, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

// Every element on screen: font-size >= 12px and effective opacity 1 for text-bearing nodes.
const TYPE_AUDIT = `(() => {
  const bad = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!el.offsetParent && getComputedStyle(el).position !== "fixed") continue;
    const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) continue;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    if (fs < 12) bad.push("font " + fs + "px: " + el.className);
    let node = el, op = 1;
    while (node && node !== document.body) { op *= parseFloat(getComputedStyle(node).opacity); node = node.parentElement; }
    if (op < 0.99) bad.push("opacity " + op.toFixed(2) + ": " + el.className);
  }
  return bad.slice(0, 12);
})()`;

async function run() {
  for (const dark of [false, true]) {
    const theme = dark ? "dark" : "light";
    const c = await launch();
    try {
      await boot(c, { dark });

      // tokens resolve on shared chrome
      const tok = await ev(c, `(() => { const cs = getComputedStyle(document.querySelector(".tabbar")); return cs.transitionDuration + "|" + cs.transitionTimingFunction; })()`);
      check(`[${theme}] tabbar rides tokens`, tok.startsWith("0.22s, 0.12s"), tok);

      await shot(c, `agenda-${theme}.png`);
      const audit1 = await ev(c, TYPE_AUDIT);
      check(`[${theme}] agenda type floor + opacity`, audit1.length === 0, audit1.join(" ; "));

      // agenda card transition resolved from tokens
      const card = await ev(c, `(() => { const el = document.querySelector(".ag-card"); return el ? getComputedStyle(el).transitionDuration : "none"; })()`);
      check(`[${theme}] ag-card tokens resolve`, card.startsWith("0.15s"), card);

      // places
      check(`[${theme}] places loads`, await go(c, "#/places", ".pl-head"));
      await shot(c, `places-${theme}.png`);
      const audit2 = await ev(c, TYPE_AUDIT);
      check(`[${theme}] places type floor + opacity`, audit2.length === 0, audit2.join(" ; "));

      // map (toggle inside places)
      await tap(c, ".pl-viewbtn");
      await sleep(1600);
      const hasMap = await ev(c, `!!document.querySelector(".mp-root canvas")`);
      check(`[${theme}] map mounts`, hasMap);
      const pin = await ev(c, `(() => { const el = document.querySelector(".mp-pin-body,.mp-cluster-body"); return el ? getComputedStyle(el).transitionDuration : "none"; })()`);
      check(`[${theme}] map pin tokens resolve`, pin.startsWith("0.12s"), pin);
      await shot(c, `map-${theme}.png`);

      // pack + sheet open/close on --dur-slow
      check(`[${theme}] pack loads`, await go(c, "#/pack", ".pk-root"));
      await shot(c, `pack-${theme}.png`);
      const audit3 = await ev(c, TYPE_AUDIT);
      check(`[${theme}] pack type floor + opacity`, audit3.length === 0, audit3.join(" ; "));
      await tap(c, '[data-act="new"]');
      await sleep(700);
      const sheet = await ev(c, `(() => { const el = document.querySelector(".sh-sheet"); if (!el) return "no sheet"; const cs = getComputedStyle(el); return cs.transitionDuration + "|" + cs.transitionTimingFunction; })()`);
      // The design system's sheet: it rises in 320 ms on the standard curve (public/ds/tokens.css --dur-320, --ease-standard).
      check(`[${theme}] sheet at the system's 320 ms, the standard curve`, sheet.startsWith("0.32s|cubic-bezier(0.4, 0, 0.2, 1)"), sheet);
      await shot(c, `sheet-${theme}.png`);
      // the editor sheet has no X by design: backdrop tap is cancel
      await tap(c, ".sh-scrim");
      await sleep(500); // EXIT_MS 360 + slack: the sheet must be gone
      const gone = await ev(c, `!document.querySelector(".sh-root")`);
      check(`[${theme}] sheet closes and tears down`, gone);

      // settings: the rewritten location/sync copy renders
      check(`[${theme}] settings loads`, await go(c, "#/settings", ".st-title"));
      const stText = await ev(c, `document.getElementById("st-loc") ? document.getElementById("st-loc").textContent : ""`);
      check(`[${theme}] settings location copy is labels`,
        !/Distances measure from here|Can take a few seconds|Distances hidden|need one reading/.test(stText), JSON.stringify(stText.trim()));
      await shot(c, `settings-${theme}.png`);
    } finally { await c.kill(); }
  }

  // reduced motion: everything dead
  const c = await launch();
  try {
    await boot(c, { dark: true, reduce: true });
    const durs = await ev(c, `(() => {
      const pick = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).transitionDuration : "-"; };
      return [pick(".tabbar"), pick(".ag-card"), pick(".ds-tab-hl")].join(" | ");
    })()`);
    check("[reduce] transitions zeroed", !/0\\.(1|2|3)/.test(durs), durs);
    const anims = await ev(c, `(() => {
      const el = document.querySelector(".netline");
      const cs = getComputedStyle(el);
      return cs.animationName + " " + cs.animationIterationCount;
    })()`);
    check("[reduce] netline static", /none|.* 1/.test(anims), anims);
    await tap(c, ".ag-card"); // navigation should still work instantly
    await sleep(400);
    await shot(c, "reduce-dark.png");
  } finally { await c.kill(); }

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(2); });

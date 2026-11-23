// collage_layout_browser_check.mjs — prove collage-layout.js runs in the REAL browser and
// produces byte-identical output to node.
//
//   node scripts/collage_layout_browser_check.mjs
//
// The unit test runs the layout engine in node. Every consumer of it — collage.js,
// collage-export.js, collage-video.js — runs it in Safari/Chrome. "Deterministic" is worth
// nothing if the two disagree, and the export renderer matching the interactive one is
// exactly a cross-context byte-identity claim. So: load the module over HTTP from the running
// `wrangler pages dev`, lay out the same fixture with the same seed, and diff the signatures.
//
// Driven over CDP from short evaluations, NOT through the browser pane (long in-page loops
// stall it), and with Network.setBypassServiceWorker set — sw.js precaches app JS and without
// the bypass this would happily test a stale copy of the file.

import { baseUrl, launchChrome } from "./lib/browser.mjs";
import { readFileSync } from "node:fs";
import { signedIn } from "./lib/gate_trip.mjs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const ORIGIN = baseUrl();   // WGP_BASE or --base=<url>: this lane's dev server (scripts/lib/browser.mjs)

const fail = (m) => { console.error("FAIL  " + m); process.exit(1); };

// ── the session cookie the whole app is gated on ──────────────────────────────────────────
// Signed in as the host of the gate's made-up trip, with a session of this run's own
// (scripts/lib/gate_trip.mjs).

// ── the fixture, as source, so both sides build it identically ────────────────────────────
const FIXTURE = `
  const SHAPES = [[4032,3024],[3024,4032],[1920,1080],[1080,1920],[4032,3024],
                  [3024,4032],[2048,2048],[5000,1400],[1440,2560],[3840,2160]];
  const r = M.rngFrom("xcheck");
  const media = [];
  for (let i = 0; i < 160; i++) {
    const s = SHAPES[Math.floor(r() * SHAPES.length)];
    const video = r() < 0.2;
    media.push({ id: "md_" + i, memoryId: "mem_" + ((i / 3) | 0),
      kind: video ? "video" : "photo",
      key: "o/a/" + i + "/x." + (video ? "mov" : "jpg"), thumb_key: "t/a/" + i + "/x.webp",
      width: s[0], height: s[1], duration_s: video ? 3 + r() * 25 : 0, sort: i });
  }
  const lay = M.layoutCollage(media, { seed: "cross_engine_check" });
  const v = M.validateLayout(lay, { samples: 48 });
`;

// ── node side ─────────────────────────────────────────────────────────────────────────────
const M = await import("file://" + join(ROOT, "public/js/collage-layout.js"));
const nodeSide = await (async () => {
  const fn = new Function("M", FIXTURE + "; return { sig: M.layoutSignature(lay), json: JSON.stringify(lay), " +
    "maxCov: v.maxCoverage, over: v.overLimit.length, focal: v.focalCovered.length, " +
    "iters: lay.stats.iterations, conv: lay.stats.converged };");
  return fn(M);
})();

// ── browser side ──────────────────────────────────────────────────────────────────────────
const chrome = await launchChrome({ args: [
  "--disable-gpu", "about:blank",
] });

let ws, msgId = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error("CDP timeout: " + method))), 20000);
});

async function cleanup(code) {
  try { ws && ws.close(); } catch { /* already gone */ }
  await chrome.close().catch(() => {});
  process.exit(code);
}

try {
  ws = new WebSocket(chrome.wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id == null) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  };

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Network.enable", {}, sessionId);
  // sw.js precaches app JS. Without this the check can pass against a stale build.
  await send("Network.setBypassServiceWorker", { bypass: true }, sessionId);
  for (const cookie of await signedIn()) await send("Network.setCookie", cookie, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Page.navigate", { url: ORIGIN + "/login.html" }, sessionId);
  await new Promise((r) => setTimeout(r, 900));

  const expr = `(async () => {
    const M = await import("/js/collage-layout.js");
    ${FIXTURE}
    return JSON.stringify({ sig: M.layoutSignature(lay), json: JSON.stringify(lay),
      maxCov: v.maxCoverage, over: v.overLimit.length, focal: v.focalCovered.length,
      iters: lay.stats.iterations, conv: lay.stats.converged, ua: navigator.userAgent });
  })()`;
  const out = await send("Runtime.evaluate",
    { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (out.exceptionDetails)
    fail("module threw in the browser: " + JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails));
  const browserSide = JSON.parse(out.result.value);

  console.log("  browser: " + browserSide.ua.replace(/^Mozilla\/5\.0 /, ""));
  console.log(`  node    sig ${nodeSide.sig.length} chars, ${nodeSide.iters} solver iterations, ` +
    `max coverage ${(nodeSide.maxCov * 100).toFixed(2)}%, over ${nodeSide.over}, focal ${nodeSide.focal}`);
  console.log(`  browser sig ${browserSide.sig.length} chars, ${browserSide.iters} solver iterations, ` +
    `max coverage ${(browserSide.maxCov * 100).toFixed(2)}%, over ${browserSide.over}, focal ${browserSide.focal}`);

  let bad = 0;
  const assert = (cond, msg, detail) => {
    console.log((cond ? "  PASS  " : "  FAIL  ") + msg + (detail ? "   " + detail : ""));
    if (!cond) bad++;
  };
  assert(browserSide.sig === nodeSide.sig, "layoutSignature is identical in node and Chrome");
  assert(browserSide.json === nodeSide.json, "the whole serialised Layout is byte-identical",
    `${nodeSide.json.length} bytes`);
  assert(browserSide.over === 0 && browserSide.focal === 0,
    "overlap rules hold when measured inside the browser");
  assert(browserSide.conv === true && browserSide.iters === nodeSide.iters,
    "the solver takes the same path in both engines", `${browserSide.iters} iterations`);
  await cleanup(bad ? 1 : 0);
} catch (e) {
  console.error("ERROR " + (e && e.message || e));
  await cleanup(1);
}

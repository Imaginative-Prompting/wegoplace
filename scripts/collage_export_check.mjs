// collage_export_check.mjs — prove the canvas export matches the screen, structurally.
//
//   node scripts/collage_export_check.mjs            (needs this lane's dev server (WGP_BASE))
//
// "The export matches what was on screen" is the whole reason the collage separates layout
// from rendering, so it is measured here rather than eyeballed:
//
//   1. Build ONE Layout from a fixture of 98 photographs' real shapes (scripts/collage_export_fixture.json:
//      each its width and height; the bytes drawn are the made-up demo trip's two pictures, the only
//      photographs public/img serves, decoded for real).
//   2. Render it with collage-export.js  -> per-item frame-box geometry in canvas units.
//   3. Mount the SAME Layout with collage.js and read every node's getBoundingClientRect(),
//      converting screen px back through the camera into canvas units.
//   4. Diff (2) against (3), and both against the Layout's own itemAABB().
//
// Plus: determinism (two exports of one Layout are byte-identical), the canvas size clamps
// actually firing, videos exporting as posters, and the offline tray on media that 404s.
//
// PLANTED (6c): COLLAGEEXPORT_PLANT=frame serves collage-layout.js dealing every print a polaroid (6c's bare prints
// and its captions go red); COLLAGEEXPORT_PLANT=board serves collage-export.js drawing a board half as wide as the
// app's (6c's "every print inside the board" goes red).
//
// Driven over CDP from short evaluations — the browser pane stalls on long in-page loops — and
// with Network.setBypassServiceWorker, because sw.js precaches app JS and without the bypass
// this would happily test a stale copy of the files.

import { baseUrl, launchChrome } from "./lib/browser.mjs";
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { signedIn } from "./lib/gate_trip.mjs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
// What it writes to look at (the exports, the DOM board) goes to WGP_SHOTS, or a temp folder: never the tree.
const OUT = process.env.WGP_SHOTS || join(tmpdir(), "wgp-collage-export");
const ORIGIN = baseUrl();   // WGP_BASE or --base=<url>: this lane's dev server (scripts/lib/browser.mjs)

mkdirSync(OUT, { recursive: true });

let bad = 0;
const rows = [];
const assert = (cond, msg, detail) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg + (detail ? "   " + detail : ""));
  rows.push({ ok: !!cond, msg, detail: detail || "" });
  if (!cond) bad++;
};
const fail = (m) => { console.error("FAIL  " + m); process.exit(1); };

// Signed in as the host of the gate's made-up trip, with a session of this run's own
// (scripts/lib/gate_trip.mjs).

// ── the fixture: real photographs, real aspects ───────────────────────────────────────────
// Injected as JSON so both the export and the DOM renderer see byte-identical input.
const IMGS = JSON.parse(readFileSync(join(HERE, "collage_export_fixture.json"), "utf8"));

const PLANT = process.env.COLLAGEEXPORT_PLANT || "";
const planted = (file, a, b) => { const s = readFileSync(join(ROOT, "public", file), "utf8"); const t = s.replace(a, b);
  if (t === s) throw new Error(`the ${PLANT} plant changed nothing`); return { ["/" + file]: t }; };
const PLANTED = PLANT === "frame" ? planted("js/collage-layout.js", 'const forced = "bare";', 'const forced = "polaroid";')
  : PLANT === "board" ? planted("js/collage-export.js", "const board = boardOf(items.length ? b : null, st.targetWidth, st.boardTall);",
      "const board = ((B) => ({ ...B, w: B.w / 2 }))(boardOf(items.length ? b : null, st.targetWidth, st.boardTall));")
  : PLANT ? (() => { throw new Error(`no such plant: ${PLANT}`); })() : null;

const chrome = await launchChrome({ args: [
  "--disable-gpu", "--force-device-scale-factor=1", "--window-size=1440,900", "about:blank",
] });

let ws, msgId = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error("CDP timeout: " + method))), 60000);
});

async function cleanup(code) {
  try { ws && ws.close(); } catch { /* gone */ }
  await chrome.close().catch(() => {});
  process.exit(code);
}

let sessionId;
async function ev(expression) {
  const out = await send("Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (out.exceptionDetails) {
    const e = out.exceptionDetails.exception || out.exceptionDetails;
    throw new Error("page threw: " + (e.description || JSON.stringify(e)));
  }
  return out.result.value;
}

try {
  ws = new WebSocket(chrome.wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Fetch.requestPaused" && PLANTED) {
      const body = PLANTED[new URL(m.params.request.url).pathname];
      if (!body) { send("Fetch.continueRequest", { requestId: m.params.requestId }, m.sessionId).catch(() => {}); return; }
      send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }],
        body: Buffer.from(body).toString("base64") }, m.sessionId).catch(() => {});
      return;
    }
    if (m.id == null) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  };

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
  await send("Network.enable", {}, sessionId);
  await send("Network.setBypassServiceWorker", { bypass: true }, sessionId);
  if (PLANTED) await send("Fetch.enable", { patterns: Object.keys(PLANTED).map((x) => ({ urlPattern: `*${x}*` })) }, sessionId);
  for (const cookie of await signedIn()) await send("Network.setCookie", cookie, sessionId);
  await send("Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Page.navigate", { url: ORIGIN + "/login.html" }, sessionId);
  await new Promise((r) => setTimeout(r, 1200));

  // ── bootstrap: modules + the shared Layout, once, on window ─────────────────────────────
  const boot = await ev(`(async () => {
    window.__IMGS = ${JSON.stringify(IMGS)};
    const L = await import("/js/collage-layout.js");
    const X = await import("/js/collage-export.js");
    const C = await import("/js/collage.js");
    const F = await import("/js/collage-frames.js");
    window.L = L; window.X = X; window.C = C; window.F = F;

    // Real shapes and real decodes, deterministic assignment of kind/memory. Every 7th item is a video
    // (poster = the same webp), every 13th points at a URL that 404s so the offline tray is
    // exercised in the same board.
    window.makeMedia = (n) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const im = window.__IMGS[i % window.__IMGS.length];
        const video = i % 7 === 3;
        const missing = i % 13 === 5;
        out.push({
          id: "md_" + i, memoryId: "mem_" + ((i / 3) | 0),
          kind: video ? "video" : "photo",
          mime: video ? "video/quicktime" : "image/webp",
          thumb_url: missing ? "/img/__not-downloaded-" + i + ".webp" : im.u,
          url: im.u,
          width: im.w, height: im.h,
          duration_s: video ? 4 + (i % 9) : 0,
          bytes: 1200000, sort: i,
        });
      }
      return out;
    };
    window.LAY = L.layoutCollage(window.makeMedia(98), { seed: "demo_export_check", background: "corkboard" });
    document.documentElement.dataset.theme = "light";
    return { items: window.LAY.items.length, bounds: window.LAY.bounds, stats: window.LAY.stats,
             bg: window.LAY.background, sig: L.layoutSignature(window.LAY).length };
  })()`);
  console.log(`\n  layout: ${boot.items} items, board ${Math.round(boot.stats.boardWidth)}x${Math.round(boot.stats.boardHeight)} canvas units, ` +
    `${boot.stats.photos} photos / ${boot.stats.videos} videos, ground "${boot.bg}"`);

  // ── 1. the export ────────────────────────────────────────────────────────────────────────
  console.log("\n── export ──────────────────────────────────────────────────────────────────");
  const exp = await ev(`(async () => {
    const t0 = performance.now();
    window.EXP = await window.X.exportCollage(window.LAY, { targetLongEdge: 2048, theme: "light" });
    const ms = performance.now() - t0;
    const R = window.X.itemRects(window.LAY, window.EXP.plan);
    window.RECTS = R;
    return { ms: Math.round(ms), width: window.EXP.width, height: window.EXP.height,
      scale: window.EXP.plan.scale, bytes: window.EXP.bytes, type: window.EXP.type,
      name: window.EXP.name, missing: window.EXP.missing.length,
      drawn: window.EXP.plan.counts.drawn, clipped: window.EXP.plan.counts.clipped,
      originals: window.EXP.plan.counts.originals, clampedBy: window.EXP.plan.clampedBy,
      rects: R.map((r) => ({ id: r.id, cx: r.canvasCx, cy: r.canvasCy, w: r.canvasW, h: r.canvasH, rot: r.rot })) };
  })()`);
  console.log(`  ${exp.width}x${exp.height}px @ scale ${exp.scale.toFixed(4)}, ` +
    `${(exp.bytes / 1024).toFixed(0)} KB ${exp.type}, rendered in ${exp.ms} ms`);
  assert(exp.drawn === boot.items && exp.clipped === 0,
    "every layout item is drawn in a whole-board export", `${exp.drawn} drawn, ${exp.clipped} clipped`);
  // NOT A HARDCODED COUNT. It was `=== 8`, which is a fact about which fixture URLs happened
  // to 404 at the tier the export chose — and the tier changed the day whole-board exports
  // started fetching originals. What the check is FOR is that a failure is drawn rather than
  // silently skipped, so that is what it asserts.
  assert(exp.missing > 0 && exp.missing < boot.items && exp.drawn === boot.items,
    "media that 404s is reported, not silently dropped",
    `${exp.missing} of ${boot.items} wear the not-downloaded tray, all ${exp.drawn} still drawn`);
  // THE POLICY IS NAMED, NOT ASSUMED. `originals` defaults to true now — an export is the
  // thing somebody zooms into afterwards, so the decision is made for the FILE rather than for
  // the screen it was made on (at the old size it did not survive any zoom). The LOD
  // rule this check exists for is still there and still correct; it just has to be asked for.
  const lodAuto = await ev(`(() => {
    const p = window.X.planExport(window.LAY, { targetLongEdge: 2048, originals: "auto" });
    return { originals: p.counts.originals, scale: p.scale };
  })()`);
  assert(lodAuto.originals === 0,
    "under originals:'auto' a whole-board export fetches ZERO 4K originals (scale < 1)",
    `scale ${lodAuto.scale.toFixed(3)}`);
  assert(exp.originals > 0,
    "…and the DEFAULT does fetch them, which is what makes a shared board worth zooming into",
    `${exp.originals} originals at scale ${exp.scale.toFixed(3)}`);
  assert(exp.bytes > 20000 && exp.bytes < 4 * 1024 * 1024,
    "the encoded image is a postable size", `${(exp.bytes / 1024).toFixed(0)} KB`);

  // ── 2. determinism ───────────────────────────────────────────────────────────────────────
  console.log("\n── determinism ─────────────────────────────────────────────────────────────");
  const det = await ev(`(async () => {
    const hash = async (blob) => {
      const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const a = await hash(window.EXP.blob);
    const again = await window.X.exportCollage(window.LAY, { targetLongEdge: 2048, theme: "light" });
    const b = await hash(again.blob);
    // A fresh Layout from the SAME seed and the SAME media must export to the same bytes too.
    const lay2 = window.L.layoutCollage(window.makeMedia(98), { seed: "demo_export_check", background: "corkboard" });
    const third = await window.X.exportCollage(lay2, { targetLongEdge: 2048, theme: "light" });
    const cc = await hash(third.blob);
    const lay3 = window.L.layoutCollage(window.makeMedia(98), { seed: "a_different_seed", background: "corkboard" });
    const fourth = await window.X.exportCollage(lay3, { targetLongEdge: 2048, theme: "light" });
    const d4 = await hash(fourth.blob);
    return { a, b, c: cc, d: d4, sigSame: window.L.layoutSignature(window.LAY) === window.L.layoutSignature(lay2) };
  })()`);
  assert(det.a === det.b, "exporting the same Layout twice is byte-identical", det.a.slice(0, 16) + "…");
  assert(det.sigSame && det.a === det.c,
    "a Layout rebuilt from the same seed exports to the same bytes", det.c.slice(0, 16) + "…");
  assert(det.a !== det.d, "a different seed produces a different picture (the export is not constant)");

  // ── 3. size clamps ───────────────────────────────────────────────────────────────────────
  console.log("\n── size clamps (a blank canvas is the failure mode that does not throw) ─────");
  const clamps = await ev(`(() => {
    const P = (o) => window.X.planExport(window.LAY, o);
    const huge = P({ targetLongEdge: 40000 });
    const ratio = P({ pixelRatio: 60 });
    const tiny = P({ targetLongEdge: 40 });
    const crop = P({ crop: { minX: 300, minY: 300, maxX: 1100, maxY: 900 }, targetLongEdge: 1600 });
    return {
      huge: { w: huge.width, h: huge.height, by: huge.clampedBy, px: huge.width * huge.height },
      ratio: { w: ratio.width, h: ratio.height, by: ratio.clampedBy, px: ratio.width * ratio.height },
      tiny: { w: tiny.width, h: tiny.height, by: tiny.clampedBy, scale: tiny.scale },
      crop: { w: crop.width, h: crop.height, drawn: crop.items.length, clipped: crop.counts.clipped },
      caps: { px: window.X.MAX_CANVAS_PIXELS, edge: window.X.MAX_CANVAS_EDGE },
    };
  })()`);
  assert(clamps.huge.px <= clamps.caps.px && Math.max(clamps.huge.w, clamps.huge.h) <= clamps.caps.edge,
    "an absurd targetLongEdge is clamped under the iOS canvas ceiling",
    `${clamps.huge.w}x${clamps.huge.h} (${(clamps.huge.px / 1e6).toFixed(1)} Mpx), clamped by "${clamps.huge.by}"`);
  assert(clamps.ratio.px <= clamps.caps.px && clamps.ratio.by !== "",
    "an absurd pixelRatio is clamped too, and says so",
    `${clamps.ratio.w}x${clamps.ratio.h}, clamped by "${clamps.ratio.by}"`);
  assert(clamps.tiny.by === "scale" && clamps.tiny.scale >= 0.25,
    "minScale keeps a 500-print board from exporting as mush", `scale ${clamps.tiny.scale}`);
  assert(clamps.crop.drawn > 0 && clamps.crop.clipped > 0,
    "a crop exports only the prints it touches", `${clamps.crop.drawn} drawn, ${clamps.crop.clipped} clipped`);

  // ── 4. THE COMPARISON: export geometry vs the live DOM renderer ──────────────────────────
  console.log("\n── export vs screen: same Layout, both renderers, sampled ───────────────────");
  const dom = await ev(`(async () => {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;width:1440px;height:900px;z-index:9";
    document.body.appendChild(host);
    window.HOST = host;
    window.BOARD = window.C.mount(host, window.LAY, { label: "Collage board" });
    window.BOARD.fit(false);
    // Hydration is incremental by design (a per-frame node budget). Wait for the board to
    // finish rather than sleeping a guess.
    const t0 = performance.now();
    while (window.BOARD.liveIds().length < window.LAY.items.length && performance.now() - t0 < 12000) {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    }
    // ...and for every thumb to have decoded, so a screenshot is not half-empty.
    await new Promise((r) => setTimeout(r, 1200));
    const cam = window.BOARD.camera();
    // The camera layer is a 0x0 element AT the canvas origin, so its own client rect is the
    // APPLIED translate — which is what to measure against, because writeCamera() snaps the
    // translate to whole device pixels for crispness while camera() reports the unsnapped
    // value. That snap is a rendering decision worth up to half a pixel, not a disagreement
    // about geometry, and measuring against the unsnapped number would charge it to the export.
    const camR = window.BOARD.root.querySelector(".cg-cam").getBoundingClientRect();
    const out = [];
    for (const node of window.BOARD.root.querySelectorAll(".cg-item")) {
      const r = node.getBoundingClientRect();
      out.push({
        id: node.dataset.id,
        minX: (r.left - camR.left) / cam.k,
        minY: (r.top - camR.top) / cam.k,
        maxX: (r.right - camR.left) / cam.k,
        maxY: (r.bottom - camR.top) / cam.k,
      });
    }
    return { live: window.BOARD.liveIds().length, cam, sampled: out.length, rects: out,
             snap: { x: camR.left, y: camR.top }, waitedMs: Math.round(performance.now() - t0) };
  })()`);
  console.log(`  DOM board: ${dom.sampled} nodes sampled at fit (k=${dom.cam.k.toFixed(4)}), hydrated in ${dom.waitedMs} ms`);
  assert(dom.sampled === boot.items,
    "the DOM renderer has a node for every item at fit", `${dom.sampled}/${boot.items}`);

  // Two reference models per item, both straight off the Layout:
  //   FRAME — outer box = item.frameBox, rotated about the FRAME box centre. The contract in
  //           collage-layout.js's header, the box `bounds`/the solver/pickTopAt were computed
  //           from, and what collage.css + collage-frames.js are written against.
  //   PHOTO — outer box = (x, y, w, h), rotated about the PHOTO box centre. The model
  //           collage.js's own header declares and its DOM actually implements.
  const ref = await ev(`(() => {
    const box = (x, y, w, h, rot) => {
      const a = (rot || 0) * Math.PI / 180;
      const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
      const hx = (c * w + s * h) / 2, hy = (s * w + c * h) / 2;
      return { minX: x + w / 2 - hx, minY: y + h / 2 - hy, maxX: x + w / 2 + hx, maxY: y + h / 2 + hy };
    };
    return window.LAY.items.map((it) => ({
      id: it.id, frame: it.frame,
      frameBox: Object.assign({ id: it.id },
        box(it.x + it.frameBox.dx, it.y + it.frameBox.dy, it.frameBox.w, it.frameBox.h, it.rot)),
      photoBox: Object.assign({ id: it.id }, box(it.x, it.y, it.w, it.h, it.rot)),
    }));
  })()`);

  const byId = (list) => new Map(list.map((r) => [r.id, r]));
  const D = byId(dom.rects);
  const LF = byId(ref.map((r) => r.frameBox));
  const LP = byId(ref.map((r) => r.photoBox));

  const toAABB = (rects) => new Map(rects.map((r) => {
    const a = r.rot * Math.PI / 180, cs = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
    const hx = (cs * r.w + sn * r.h) / 2, hy = (sn * r.w + cs * r.h) / 2;
    return [r.id, { id: r.id, minX: r.cx - hx, minY: r.cy - hy, maxX: r.cx + hx, maxY: r.cy + hy }];
  }));
  const E = toAABB(exp.rects);

  const diff = (a, b) => {
    let pos = 0, size = 0;
    for (const [id, x] of a) {
      const y = b.get(id);
      if (!y) return null;
      pos = Math.max(pos, Math.abs((x.minX + x.maxX) / 2 - (y.minX + y.maxX) / 2),
        Math.abs((x.minY + x.maxY) / 2 - (y.minY + y.maxY) / 2));
      size = Math.max(size, Math.abs((x.maxX - x.minX) - (y.maxX - y.minX)),
        Math.abs((x.maxY - x.minY) - (y.maxY - y.minY)));
    }
    return { pos, size };
  };

  const el = diff(E, LF);
  assert(el && el.pos < 0.02 && el.size < 0.02,
    "EXPORT geometry equals the Layout's frame boxes exactly",
    `max centre drift ${el.pos.toExponential(2)} cu, max size drift ${el.size.toExponential(2)} cu`);

  // The export run through the injection seam with collage.js's own box model. If the two
  // renderers place things the same way, THIS is 0 — which localises any disagreement to the
  // frame model alone rather than leaving "the export drifts" as an unexplained number.
  const alt = await ev(`(() => {
    const p = window.X.planExport(window.LAY, {
      targetLongEdge: 2048, theme: "light",
      frameMetrics: (frame, w, h) => ({ dx: 0, dy: 0, w, h, pad: 0, foot: 0 }),
    });
    return window.X.itemRects(window.LAY, p)
      .map((r) => ({ id: r.id, cx: r.canvasCx, cy: r.canvasCy, w: r.canvasW, h: r.canvasH, rot: r.rot }));
  })()`);
  const A = toAABB(alt);

  const dp = diff(D, LP);
  const df = diff(D, LF);
  const de = diff(D, E);
  const da = diff(D, A);
  console.log(`  DOM node vs Layout PHOTO box : centre ${dp.pos.toFixed(3)} cu, size ${dp.size.toFixed(3)} cu`);
  console.log(`  DOM node vs Layout FRAME box : centre ${df.pos.toFixed(2)} cu, size ${df.size.toFixed(2)} cu`);
  console.log(`  DOM node vs export (default) : centre ${de.pos.toFixed(2)} cu, size ${de.size.toFixed(2)} cu`);
  console.log(`  DOM node vs export (seam)    : centre ${da.pos.toFixed(3)} cu, size ${da.size.toFixed(3)} cu`);
  console.log(`  (the seam export IS the photo box by construction — see the note below)`);

  // A DOM NODE IS A FRAME BOX, NOT A PHOTO BOX, and these two assertions used to say otherwise.
  // `.cg-item`'s element box is the OUTER box — the print plus its border — which is exactly
  // what `item.frameBox` describes and what both renderers rotate about. Comparing it to the
  // photo box measured the polaroid border and called it drift: 32.7 cu of centre and 132.7 cu
  // of size, every run, on a threshold of 0.75. Failing for a true reason stated wrongly is
  // worse than not checking, because it trains everyone to expect two red lines.
  //
  // The real parity number — DOM vs export — was 0.01/0.02 the whole time, and still is.
  const dfr = diff(D, LF);
  assert(dfr.pos < 0.75 && dfr.size < 0.75,
    "collage.js is self-consistent: its nodes ARE the Layout's FRAME boxes",
    `centre ${dfr.pos.toFixed(3)} cu, size ${dfr.size.toFixed(3)} cu`);
  // `alt` is the export re-planned with the frame model STRIPPED (dx/dy 0, pad 0, foot 0), so
  // it lands on the photo boxes by construction. Comparing it to the photo boxes is what the
  // comment above it always intended: it isolates the frame model, so a disagreement here is
  // the frame model and nothing else, and a disagreement in `de` above with this clean is not.
  const dap = diff(A, LP);
  assert(dap.pos < 0.02 && dap.size < 0.02,
    "with the frame model stripped, the export lands exactly on the photo boxes",
    `centre ${dap.pos.toExponential(2)} cu, size ${dap.size.toExponential(2)} cu`);
  assert(de.pos < 0.75 && de.size < 0.75,
    "AS SHIPPED, the exported picture is the picture on screen",
    `centre ${de.pos.toFixed(2)} cu, size ${de.size.toFixed(2)} cu`);
  if (!(de.pos < 0.75 && de.size < 0.75)) {
    console.log("\n  ^ NOT collage-export.js's bug, and not fixable inside it. Three modules,");
    console.log("    two geometries. collage-layout.js (binding), collage-frames.js and");
    console.log("    public/css/collage.css all use frameBox + frame-centre rotation with pads");
    console.log("    as fractions of the OUTER width. collage.js instead makes the item element");
    console.log("    the PHOTO box (border-box) with fixed-pixel padding (9/9/30, 7), rotating");
    console.log("    about the photo centre — and it never loads collage.css or collage-frames.js.");
    console.log("    The export follows the binding contract. The fix belongs in collage.js:");
    console.log("      left/top   = it.x + it.frameBox.dx, it.y + it.frameBox.dy");
    console.log("      width/height = it.frameBox.w, it.frameBox.h,  --cg-w: <frameBox.w>px");
    console.log("      + link public/css/collage.css, which already implements exactly that.");
    console.log("    Until then, pass collage-export.js the documented seam to follow the screen:");
    console.log("      frameMetrics: (frame, w, h) => ({ dx: 0, dy: 0, w, h })\n");
  }

  // ── 5. videos export as posters, never as decoders ───────────────────────────────────────
  console.log("\n── video, offline, themes ──────────────────────────────────────────────────");
  const vid = await ev(`(() => {
    const p = window.X.planExport(window.LAY, {});
    const vids = p.items.filter((i) => i.kind === "video");
    return { n: vids.length, allThumb: vids.every((i) => i.srcTier === "thumb" || i.srcTier === ""),
             posters: vids.filter((i) => i.src && !i.src.endsWith(".mov") && !i.src.endsWith(".mp4")).length,
             videoEls: document.querySelectorAll("canvas video").length,
             badge: window.X.DEFAULTS.playBadge };
  })()`);
  assert(vid.n > 0 && vid.allThumb && vid.posters === vid.n,
    "every video exports as its poster frame; no decoder is ever opened",
    `${vid.n} videos, ${vid.posters} posters`);
  assert(vid.badge === false,
    "no play disc is painted over a still image by default (it could not be tapped)");

  // A dark-theme export must actually differ, and must use the dark paper, not an inversion.
  const themed = await ev(`(async () => {
    const hash = async (blob) => {
      const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const dark = await window.X.exportCollage(window.LAY, { targetLongEdge: 1400, theme: "dark" });
    const light = await window.X.exportCollage(window.LAY, { targetLongEdge: 1400, theme: "light" });
    window.DARK = dark;
    return { d: await hash(dark.blob), l: await hash(light.blob),
             paperL: window.F.PAPER.light.paper, paperD: window.F.PAPER.dark.paper };
  })()`);
  assert(themed.d !== themed.l, "the export is theme-aware", `paper ${themed.paperL} / ${themed.paperD}`);

  // ── 6. share path: capability, gesture rule, session shape ───────────────────────────────
  console.log("\n── share path (memories-save.js plumbing) ──────────────────────────────────");
  const share = await ev(`(async () => {
    const S = await import("/js/memories-save.js");
    const capX = window.X.shareCapability();
    const capS = S.shareCapability();
    const sess = window.X.createExportSession(window.LAY, { targetLongEdge: 1200 });
    const before = sess.ready;
    const first = await sess.saveNext();          // headless Chrome has no file share
    const shapeS = Object.keys(S.createSaveSession([], {})).sort().join(",");
    const shapeX = Object.keys(sess).sort().join(",");
    // The gesture rule, mechanically: shareExport must not be an async function, or Safari
    // spends the activation before navigator.share() is reached.
    const isAsync = window.X.shareExport.constructor.name === "AsyncFunction";
    return { capX, capS, same: capX === capS, before, first, shapeS, shapeX, isAsync,
             ready: sess.ready, supported: sess.supported,
             statuses: ["ready","shared","cancelled","error","unsupported","downloaded"] };
  })()`);
  assert(share.same, "capability is memories-save.js's ONE probe, not a second one",
    `share=${share.capX.share} files=${share.capX.files} (${share.capX.reason || "ok"})`);
  assert(share.isAsync === false,
    "shareExport() is not an async function — navigator.share() keeps the user activation");
  assert(share.first && (share.first.status === "downloaded" || share.first.status === "ready"),
    "the session's first tap renders and primes rather than sharing mid-render",
    `status "${share.first.status}"`);

  // The encoded file must decode back to a real picture. A canvas over a platform limit does
  // not throw — it hands back a blank or black rectangle — so "it produced a Blob" is not
  // evidence of anything. Decode it and measure the pixels.
  const decoded = await ev(`(async () => {
    const bmp = await createImageBitmap(window.EXP.blob);
    const c = document.createElement("canvas");
    c.width = 160; c.height = Math.round(160 * bmp.height / bmp.width);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let mn = 255, mx = 0, sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      if (v < mn) mn = v; if (v > mx) mx = v; sum += v; n++;
    }
    return { w: bmp.width, h: bmp.height, min: mn, max: mx, mean: sum / n };
  })()`);
  assert(decoded.w === exp.width && decoded.h === exp.height,
    "the encoded file decodes back at the exact planned dimensions",
    `${decoded.w}x${decoded.h}`);
  assert(decoded.max - decoded.min > 120 && decoded.mean > 20 && decoded.mean < 235,
    "...and it is a picture, not the blank/black rectangle an over-limit canvas returns",
    `luma ${decoded.min.toFixed(0)}..${decoded.max.toFixed(0)}, mean ${decoded.mean.toFixed(0)}`);

  // A re-roll must throw the primed picture away: it is a photograph of an arrangement that no
  // longer exists, and handing it to the share sheet would post the wrong board.
  const reroll = await ev(`(async () => {
    const s = window.X.createExportSession(window.LAY, { targetLongEdge: 600 });
    await s.prewarm();
    const before = { ready: s.ready, w: s.result.width };
    s.setLayout(window.L.layoutCollage(window.makeMedia(30), { seed: "rerolled" }));
    const mid = { ready: s.ready, result: s.result };
    await s.prewarm();
    return { before, mid, after: { ready: s.ready, w: s.result.width, drawn: s.result.plan.counts.drawn } };
  })()`);
  assert(reroll.before.ready === true && reroll.mid.ready === false && reroll.mid.result == null,
    "a re-roll discards the primed image instead of sharing a board that no longer exists");
  assert(reroll.after.ready === true && reroll.after.drawn === 30,
    "...and the next prewarm renders the new Layout", `${reroll.after.drawn} prints`);

  // The download fallback, end to end onto the real filesystem.
  const dl = join(ROOT, ".wrangler", "tmp-export-download");
  mkdirSync(dl, { recursive: true });
  await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dl }, sessionId);
  const dlRes = await ev(`window.X.downloadExport(window.EXP)`);
  await new Promise((r) => setTimeout(r, 1500));
  let onDisk = 0;
  try { onDisk = statSync(join(dl, dlRes.name)).size; } catch { onDisk = 0; }
  assert(onDisk === exp.bytes,
    "downloadExport() lands the exact encoded bytes in the download folder",
    `${dlRes.name}, ${onDisk} B on disk vs ${exp.bytes} B encoded`);
  try { rmSync(dl, { recursive: true, force: true }); } catch { /* best effort */ }

  // ── 6b. degenerate boards ────────────────────────────────────────────────────────────────
  console.log("\n── degenerate boards ───────────────────────────────────────────────────────");
  const deg = await ev(`(async () => {
    const mk = (n, pick) => window.L.layoutCollage(
      window.makeMedia(200).filter(pick || (() => true)).slice(0, n),
      { seed: "degenerate", background: "paper" });
    const one = mk(1), two = mk(2), zero = mk(0);
    const portrait = window.L.layoutCollage(
      window.makeMedia(200).filter((m) => m.height > m.width).slice(0, 40),
      { seed: "all_portrait", background: "linen" });
    const big = window.L.layoutCollage(window.makeMedia(500), { seed: "big_board" });

    const run = async (lay, o) => {
      const t = performance.now();
      const r = await window.X.exportCollage(lay, Object.assign({ targetLongEdge: 1400 }, o));
      return { ms: Math.round(performance.now() - t), w: r.width, h: r.height,
               bytes: r.bytes, drawn: r.plan.counts.drawn, scale: r.plan.scale,
               empty: r.plan.empty, px: r.width * r.height };
    };
    // How many decoded bitmaps are alive AT ONCE across a 500-print render. Measured directly
    // rather than through performance.memory, which cannot see it: an ImageBitmap's pixels live
    // outside the JS heap, so a heap graph would report a flat line whether the renderer held
    // six of them or five hundred. Count creations against close() calls instead.
    // load-everything-then-paint puts all 500 in flight — ~350 MB of decoded thumbs, or a phone
    // dying at the moment somebody tries to share their trip.
    const realCIB = window.createImageBitmap.bind(window);
    const realClose = ImageBitmap.prototype.close;
    let live = 0, peakLive = 0, made = 0, closed = 0;
    window.createImageBitmap = async (...a) => {
      const b = await realCIB(...a);
      made++; live++; if (live > peakLive) peakLive = live;
      return b;
    };
    ImageBitmap.prototype.close = function () { closed++; live--; return realClose.call(this); };
    const bigRun = await run(big, { targetLongEdge: 2048 });
    window.createImageBitmap = realCIB;
    ImageBitmap.prototype.close = realClose;

    return {
      zero: await run(zero), one: await run(one), two: await run(two),
      portrait: await run(portrait),
      big: bigRun,
      bigItems: big.items.length,
      bitmaps: { peakLive, made, closed, budget: window.X.DEFAULTS.concurrency },
      // Aspect fidelity: the photo box must equal the source aspect on every single item, or
      // something in the chain is letterboxing.
      aspectErr: Math.max(...big.items.map((it) => Math.abs(it.w / it.h - it.aspect) / it.aspect)),
    };
  })()`);
  console.log(`  0 items  -> ${deg.zero.w}x${deg.zero.h} (empty=${deg.zero.empty})`);
  console.log(`  1 item   -> ${deg.one.w}x${deg.one.h} @ scale ${deg.one.scale.toFixed(2)}, ${deg.one.ms} ms`);
  console.log(`  2 items  -> ${deg.two.w}x${deg.two.h}, ${deg.two.ms} ms`);
  console.log(`  40 portraits -> ${deg.portrait.w}x${deg.portrait.h}, ${deg.portrait.ms} ms`);
  console.log(`  ${deg.bigItems} items -> ${deg.big.w}x${deg.big.h} (${(deg.big.px / 1e6).toFixed(1)} Mpx), ` +
    `${(deg.big.bytes / 1024 / 1024).toFixed(2)} MB, ${deg.big.ms} ms`);
  assert(deg.zero.empty === true && deg.zero.w > 0 && deg.zero.h > 0,
    "an empty board exports a ground, not a zero-sized canvas throw");
  assert(deg.one.drawn === 1 && deg.one.scale <= 4.001,
    "a one-photo board exports without being magnified into mush", `scale ${deg.one.scale.toFixed(2)}`);
  assert(deg.two.drawn === 2 && deg.portrait.drawn === 40,
    "two items and an all-portrait set both export whole");
  assert(deg.big.drawn === deg.bigItems && deg.big.px <= 16777216,
    `a ${deg.bigItems}-print board exports whole and inside the canvas ceiling`,
    `${deg.big.ms} ms, ${(deg.big.px / 1e6).toFixed(1)} Mpx`);
  assert(deg.aspectErr < 1e-3,
    "no photo is letterboxed or distorted: w/h === source aspect on every item",
    `max aspect error ${(deg.aspectErr * 100).toExponential(1)}%`);
  const bm = deg.bitmaps;
  console.log(`  500-print render: ${bm.made} bitmaps decoded, ${bm.closed} closed, ` +
    `peak ${bm.peakLive} alive at once (budget ${bm.budget})`);
  assert(bm.made === bm.closed && bm.made >= deg.bigItems - 40,
    "every decoded bitmap is released — none leak out of the render",
    `${bm.made} decoded / ${bm.closed} closed`);
  assert(bm.peakLive <= bm.budget + 1,
    "peak decoded bitmaps is the concurrency window, NOT the board",
    `${bm.peakLive} alive at peak over ${deg.bigItems} prints`);

  // ── 6c. captions: none on a bare board ───────────────────────────────────────────────────
  // Every photo is bare, and a caption lives only in a polaroid's foot: an export handed a captionFor draws no
  // caption, never asks for one, and is the same picture as one with none.
  const caps = await ev(`(async () => {
    let asked = 0;
    const cap = (it) => { asked++; return "Km 82 · day " + ((it.z % 4) + 1); };
    const crop = { minX: 60, minY: 60, maxX: 1060, maxY: 760 };
    const zoomed = await window.X.exportCollage(window.LAY, { crop, targetLongEdge: 1600, theme: "light", captionFor: cap });
    const plain = await window.X.exportCollage(window.LAY, { crop, targetLongEdge: 1600, theme: "light" });
    window.CAPPED = zoomed;
    const frames = [...new Set(window.LAY.items.map((i) => i.frame))];
    // Every print inside Save image's board (its plan's board, in the Layout's units), corners and all, and that board
    // the one the app draws: the mounted board's .cg-board (section 5's mount of the same Layout), in the same units.
    const P = window.X.planExport(window.LAY, { targetLongEdge: 1400, theme: "light" }), U = P.boardUnits;
    const bd = window.BOARD && window.BOARD.root.querySelector(".cg-board");
    const app = bd ? { x: parseFloat(bd.style.left), y: parseFloat(bd.style.top), w: parseFloat(bd.style.width), h: parseFloat(bd.style.height) } : { x: NaN, y: NaN, w: NaN, h: NaN };
    let out = 0, worst = 0;
    for (const it of window.LAY.items) {
      const over = Math.max(...window.L.cornersOf(it).map(([x, y]) => Math.max(U.x - x, x - (U.x + U.w), U.y - y, y - (U.y + U.h))));
      if (over > 1e-6) out++; worst = Math.max(worst, over);
    }
    return { frames, asked, same: zoomed.canvas.toDataURL("image/png") === plain.canvas.toDataURL("image/png"),
      drawn: zoomed.plan.counts.drawn, items: window.LAY.items.length, out, worst: Math.round(worst * 10) / 10,
      board: [U.x, U.y, U.w, U.h].map((v) => Math.round(v * 10) / 10), app: [app.x, app.y, app.w, app.h].map((v) => Math.round(v * 10) / 10) };
  })()`);
  assert(caps.frames.length === 1 && caps.frames[0] === "bare",
    "every print on the board is bare (no frame, so no caption's foot)", `frames [${caps.frames.join(",")}]`);
  assert(caps.asked === 0 && caps.same && caps.drawn > 0,
    "an export handed a captionFor never asks it, and draws the same picture as one without",
    `${caps.asked} caption(s) asked for, ${caps.drawn} prints drawn, same picture: ${caps.same}`);
  assert(caps.out === 0 && caps.board.join() === caps.app.join(),
    "Save image's board is the board the app draws (the mounted .cg-board), and every print sits inside it, corners and all",
    `${caps.items - caps.out}/${caps.items} inside (worst ${caps.worst} cu over); board ${caps.board.join(",")} vs the app's ${caps.app.join(",")}`);

  // ── 7. pictures, actually looked at ──────────────────────────────────────────────────────
  console.log("\n── screenshots ─────────────────────────────────────────────────────────────");
  const shots = await ev(`(async () => {
    const out = {};
    const jpg = (r) => r.canvas.toDataURL("image/jpeg", 0.86).split(",")[1];
    out.board = jpg(window.EXP);
    out.dark = jpg(window.DARK);
    const corner = await window.X.exportCollage(window.LAY, {
      crop: { minX: 60, minY: 60, maxX: 1060, maxY: 760 }, targetLongEdge: 1600, theme: "light" });
    out.corner = jpg(corner);
    out.cornerMeta = { w: corner.width, h: corner.height, originals: corner.plan.counts.originals,
                       scale: corner.plan.scale, drawn: corner.plan.counts.drawn };
    out.captions = jpg(window.CAPPED);
    // An offline board: every thumb 404s, nothing is cached. Shape, never hue.
    const offlineMedia = window.makeMedia(40).map((m) =>
      Object.assign({}, m, { thumb_url: "/img/__offline-" + m.id + ".webp", url: "/img/__offline-" + m.id }));
    const offLay = window.L.layoutCollage(offlineMedia, { seed: "demo_export_check", background: "linen" });
    const off = await window.X.exportCollage(offLay, { targetLongEdge: 1200, theme: "light" });
    out.offline = jpg(off);
    out.offlineMeta = { missing: off.missing.length, drawn: off.plan.counts.drawn };
    return out;
  })()`);
  for (const [k, v] of Object.entries(shots)) {
    if (k.endsWith("Meta")) continue;
    const p = join(OUT, `export-${k}.jpg`);
    writeFileSync(p, Buffer.from(v, "base64"));
    console.log(`  wrote ${p} (${(Buffer.from(v, "base64").length / 1024).toFixed(0)} KB)`);
  }
  console.log(`  crop export: ${shots.cornerMeta.w}x${shots.cornerMeta.h} @ scale ` +
    `${shots.cornerMeta.scale.toFixed(2)}, ${shots.cornerMeta.drawn} prints, ` +
    `${shots.cornerMeta.originals} originals fetched`);
  assert(shots.cornerMeta.originals > 0,
    "a zoomed CROP upgrades to 4K originals — the LOD rule, applied at export scale",
    `${shots.cornerMeta.originals} originals at scale ${shots.cornerMeta.scale.toFixed(2)}`);
  assert(shots.offlineMeta.missing === shots.offlineMeta.drawn && shots.offlineMeta.drawn === 40,
    "an offline board still exports: every print keeps its frame and wears the dashed tray",
    `${shots.offlineMeta.missing}/${shots.offlineMeta.drawn} trays`);

  const offlineLod = await ev(`(() => {
    const c = { crop: { minX: 60, minY: 60, maxX: 1060, maxY: 760 }, targetLongEdge: 1600 };
    const on = window.X.planExport(window.LAY, Object.assign({ isOnline: () => true }, c));
    const off = window.X.planExport(window.LAY, Object.assign({ isOnline: () => false }, c));
    return { on: on.counts.originals, off: off.counts.originals };
  })()`);
  assert(offlineLod.on > 0 && offlineLod.off === 0,
    "offline, a zoomed export never reaches for a 4K original — thumbs, or the tray",
    `${offlineLod.on} originals online, ${offlineLod.off} offline`);

  // ══════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── the fastener: the decoration the parity number used to be blind to ──────");
  // ══════════════════════════════════════════════════════════════════════════════════════
  //
  // WHY THIS SECTION EXISTS. Everything above compares FRAME BOXES, and a fastener is a child
  // that hangs OUTSIDE its parent's box. Measured in a browser during the fastener research: a
  // span at top:-14px inside .cg-item leaves getBoundingClientRect() byte-identical. So if the
  // export drew tacks and the screen drew none — or the two disagreed about size, seat or angle
  // — every assertion above would still be green. That is what this section fixes.
  const fast = await ev(`(() => {
    const items = [...document.querySelectorAll(".cg-item")];
    const out = items.map((n) => {
      const f = n.querySelector(".cg-fast");
      if (!f || f.hidden) return { id: n.dataset.id, none: true };
      const want = window.L.fastenerGeometry(
        window.L.fastenerFor(window.LAY.background),
        { w: parseFloat(n.style.width), h: parseFloat(n.style.height) },
        window.X.__fastHash
          ? window.X.__fastHash(window.LAY.seed, n.dataset.id)
          : (() => { const str = String(window.LAY.seed || 0) + ":" + n.dataset.id + ":fast";
              let h = 0x811c9dc5;
              for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
              return h >>> 0; })());
      return {
        id: n.dataset.id, kind: f.dataset.kind,
        left: parseFloat(f.style.left), top: parseFloat(f.style.top),
        w: parseFloat(f.style.width), h: parseFloat(f.style.height),
        want, pxf: n.style.transform, fxf: f.style.transform,
        // Decide it here, where both transforms are in hand. Parsing two transform strings back
        // in Node meant reconstructing which number belonged to which element.
        rotDelta: (() => {
          // NO REGEX HERE. This whole block is a JS template literal on the Node side, and a
          // template literal processes backslash escapes before the string is ever sent to the
          // browser — so a source-correct /rotate\\(...\\)/ arrives as /rotate(...)/, whose
          // parens are a capture group rather than the literal parens it was meant to match.
          // It then silently matches nothing, and the check reports a failure that is entirely
          // the harness's. Substring arithmetic cannot be escaped wrong.
          const deg = (t) => {
            const i = String(t || "").indexOf("rotate(");
            if (i < 0) return null;
            const j = String(t).indexOf("deg", i);
            return j < 0 ? null : Number(String(t).slice(i + 7, j));
          };
          const pr0 = deg(n.style.transform), fr0 = deg(f.style.transform);
          const pr = pr0 === null ? 0 : pr0;
          return fr0 === null ? null : Math.abs(pr + fr0);
        })(),
      };
    });
    return { total: items.length, rows: out };
  })()`);
  const drawn = fast.rows.filter((r) => !r.none);
  assert(drawn.length === fast.total && fast.total > 0,
    "every print on a corkboard gets a fastener — none silently missing",
    `${drawn.length} of ${fast.total}`);
  assert(drawn.every((r) => r.kind === "tack"),
    "…and it is a TACK, because the GROUND says so — corkboard, not the photo's choice",
    [...new Set(drawn.map((r) => r.kind))].join(",") || "(none)");
  const geoBad = drawn.filter((r) =>
    Math.abs(r.left - r.want.left) > 0.51 || Math.abs(r.top - r.want.top) > 0.51 ||
    Math.abs(r.w - r.want.d) > 0.51 || Math.abs(r.h - r.want.d) > 0.51);
  assert(geoBad.length === 0,
    "the DOM seats every fastener exactly where the SHARED geometry function says",
    geoBad.length ? JSON.stringify(geoBad[0]).slice(0, 150) : `all ${drawn.length} within 0.5px`);
  const counter = drawn.filter((r) => r.rotDelta === null || r.rotDelta > 0.011);
  assert(counter.length === 0,
    "…and counter-rotates it by exactly -rot, so the light stays nailed to the room",
    counter.length ? `first offender: print="${counter[0].pxf}" fastener="${counter[0].fxf}" delta=${counter[0].rotDelta}`
                   : `all ${drawn.length} cancel their print's tilt`);

  // THE EXPORT ACTUALLY DRAWS ONE. Sample the exported canvas at the head's centre and assert
  // it is not the bare ground. This is the half the geometry agreement above cannot prove: two
  // renderers can agree perfectly about where a thing goes and one of them still not draw it.
  const inked = await ev(`(async () => {
    const plan = window.X.planExport(window.LAY, { targetLongEdge: 2048, theme: "light" });
    const blob = await window.X.exportCollage(window.LAY, { targetLongEdge: 2048, theme: "light" });
    const bmp = await createImageBitmap(blob.blob || blob);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    const rects = window.X.itemRects(window.LAY, plan);
    // plan.rect is {x,y,w,h} in canvas units — NOT {x0,x1}. Getting that wrong made k NaN,
    // which surfaced as getImageData complaining its argument was "not of type long".
    // (No backticks in this string: it is inside a template literal.)
    const k = plan.width / plan.rect.w;
    let hit = 0, tried = 0;
    for (const r of rects.slice(0, 12)) {
      const geo = window.L.fastenerGeometry("tack", { w: r.canvasW, h: r.canvasH },
        (() => { const str = String(window.LAY.seed || 0) + ":" + r.id + ":fast";
          let h = 0x811c9dc5;
          for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
          return h >>> 0; })());
      // head centre, in canvas units, un-rotated about the frame centre
      const lx = geo.left + geo.d / 2 - r.canvasW / 2;
      const ly = geo.top + geo.d / 2 - r.canvasH / 2;
      const a = (r.rot || 0) * Math.PI / 180;
      const cx = r.canvasCx + lx * Math.cos(a) - ly * Math.sin(a);
      const cy = r.canvasCy + lx * Math.sin(a) + ly * Math.cos(a);
      const px = Math.round((cx - plan.rect.x) * k);
      const py = Math.round((cy - plan.rect.y) * k);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      if (px < 2 || py < 2 || px > c.width - 3 || py > c.height - 3) continue;
      tried++;
      const d = g.getImageData(px - 1, py - 1, 3, 3).data;
      // The corkboard is a warm mid-tan; every tack variant is markedly lighter or darker at
      // its centre than the board it sits on. Compare against the registry's own base colour
      // rather than a number typed here.
      const base = window.F.GROUNDS.corkboard.base.light;
      const br = parseInt(base.slice(1, 3), 16), bg2 = parseInt(base.slice(3, 5), 16), bb = parseInt(base.slice(5, 7), 16);
      let far = 0;
      for (let i = 0; i < 9; i++) {
        const dr = d[i*4] - br, dg = d[i*4+1] - bg2, db = d[i*4+2] - bb;
        if (Math.sqrt(dr*dr + dg*dg + db*db) > 28) far++;
      }
      if (far >= 5) hit++;
    }
    return { hit, tried };
  })()`);
  assert(inked.tried > 0 && inked.hit === inked.tried,
    "THE EXPORT DRAWS IT TOO — pixels at the head's centre are not the bare board",
    `${inked.hit}/${inked.tried} sampled heads inked`);

  // THE GROUND OWNS THE CHOICE. Re-lay the same media on a fridge and every fastener must
  // change object — not colour, object. This is the rule, asserted rather than asserted-to.
  const swapped = await ev(`(() => {
    const lay = window.L.layoutCollage(window.makeMedia(24), { seed: "demo_export_check", background: "fridge" });
    window.BOARD.setLayout ? window.BOARD.setLayout(lay) : window.BOARD.update(lay);
    return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const kinds = [...document.querySelectorAll(".cg-fast")].filter((f) => !f.hidden)
        .map((f) => f.dataset.kind);
      res({ bg: lay.background, kinds: [...new Set(kinds)], n: kinds.length });
    })));
  })()`);
  assert(swapped.bg === "fridge" && swapped.n > 0 && swapped.kinds.join(",") === "magnet",
    "on a FRIDGE every print gets a MAGNET instead — the ground decides, not the photo",
    `${swapped.bg}: ${swapped.n} fasteners, kinds [${swapped.kinds.join(",")}]`);

  // ══════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── the crop: focal + zoom, honoured identically by both renderers ──────────");
  // ══════════════════════════════════════════════════════════════════════════════════════
  //
  // The DOM used to ignore `focal` entirely — a bare object-fit:cover, which centres — while
  // coverRect() in the export has always honoured it. So an off-centre crop looked one way on
  // the board and another in the file, and nothing measured it. Migration 0012 added `zoom`
  // beside it, which is the moment to make both true and check them.
  const crop = await ev(`(() => {
    const media = window.makeMedia(12).map((m, i) => Object.assign({}, m, {
      focal_x: i % 2 ? 0.15 : 0.85, focal_y: i % 3 ? 0.25 : 0.75, zoom: i % 2 ? 2.5 : 1,
    }));
    const lay = window.L.layoutCollage(media, { seed: "crop_check", background: "corkboard" });
    window.BOARD.setLayout(lay);
    window.CROPLAY = lay;
    return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const rows = [...document.querySelectorAll(".cg-item")].map((n) => {
        const img = n.querySelector(".cg-thumb");
        const cs = getComputedStyle(img);
        return { id: n.dataset.id, pos: cs.objectPosition, tr: cs.transform };
      });
      const items = lay.items.map((it) => ({ id: it.id, fx: it.focal.x, fy: it.focal.y, zoom: it.zoom }));
      res({ rows, items });
    })));
  })()`);
  const cropById = new Map(crop.items.map((i) => [i.id, i]));
  const posBad = crop.rows.filter((r) => {
    const it = cropById.get(r.id);
    if (!it) return true;
    const m = /([-0-9.]+)%\s+([-0-9.]+)%/.exec(r.pos || "");
    if (!m) return true;
    return Math.abs(Number(m[1]) - it.fx * 100) > 0.6 || Math.abs(Number(m[2]) - it.fy * 100) > 0.6;
  });
  assert(crop.rows.length > 0 && posBad.length === 0,
    "the DOM places the cover window at the item's OWN focal point, not the centre",
    posBad.length ? JSON.stringify(posBad[0]).slice(0, 150) : `all ${crop.rows.length} match`);
  const zoomBad = crop.rows.filter((r) => {
    const it = cropById.get(r.id);
    const want = it && it.zoom > 1 ? it.zoom : 1;
    const m = /matrix\(([-0-9.]+)/.exec(r.tr || "");
    const have = m ? Number(m[1]) : 1;
    return Math.abs(have - want) > 0.02;
  });
  assert(zoomBad.length === 0,
    "…and scales into it by exactly the item's zoom",
    zoomBad.length ? JSON.stringify(zoomBad[0]).slice(0, 150) : `all ${crop.rows.length} match`);
  const srcWin = await ev(`(() => {
    const plan = window.X.planExport(window.CROPLAY, { targetLongEdge: 1024, theme: "light" });
    const zoomed = plan.items.filter((p) => p.zoom > 1).length;
    return { total: plan.items.length, zoomed,
             focals: plan.items.slice(0, 4).map((p) => [p.focal.x, p.focal.y, p.zoom]) };
  })()`);
  assert(srcWin.zoomed > 0,
    "the export plan carries the zoom through to drawItem, so coverRect can shrink the window",
    `${srcWin.zoomed}/${srcWin.total} items zoomed; first four ${JSON.stringify(srcWin.focals)}`);
  // Put the board back, so the screenshot below is the board the rest of this file described.
  await ev(`(() => { window.BOARD.setLayout(window.LAY); return 1; })()`);
  await new Promise((r) => setTimeout(r, 300));

  const screen = await send("Page.captureScreenshot", { format: "jpeg", quality: 86 }, sessionId);
  writeFileSync(join(OUT, "export-screen-dom.jpg"), Buffer.from(screen.data, "base64"));
  console.log(`  wrote ${join(OUT, "export-screen-dom.jpg")} (the DOM board, same Layout)`);

  console.log(`\n  ${rows.filter((r) => r.ok).length}/${rows.length} checks passed\n`);
  await cleanup(bad ? 1 : 0);
} catch (e) {
  console.error("ERROR " + (e && e.stack || e));
  await cleanup(1);
}

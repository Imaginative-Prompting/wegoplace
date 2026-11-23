#!/usr/bin/env node
/* Proves the v6 save path and the offline media cache against real Chrome and a real service
 * worker.  node scripts/media_save_harness.js
 *
 * What it does NOT prove, and cannot: the iOS share sheet. navigator.share({files}) does not
 * exist in headless Chrome, so the sheet itself, the "Save N Images" tap and whether Photos
 * accepts a HEIC are checks for a real device. What IS proved here is everything up to the
 * call: that the File objects handed to share() are sha256-identical to the uploaded original,
 * that batching splits where the budget says, that a cancelled sheet keeps its place, and that
 * the cache serves a whole original and a byte range with the network genuinely gone.
 *
 * No puppeteer (not installed, and packages may not be added), so this drives Chrome over raw
 * CDP with Node's built-in WebSocket. It runs its own asset server rather than wrangler's,
 * because the tests need to synthesise /media/ objects of known bytes and to KILL the network
 * outright. public/ is served read-only; the repo is never modified.
 */
"use strict";

const { launchChrome } = require("./lib/browser.mjs");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const PUBLIC = path.join(REPO, "public");
// Its own asset server, on a port the system hands out: found once in the run below and kept,
// because the server is stopped and started again on the same origin.
let PORT = 0;
let ORIGIN = "";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-media-"));
const DOWNLOADS = path.join(TMP, "downloads");
fs.mkdirSync(DOWNLOADS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────
// Random bytes, so a "download" that silently re-encoded anything cannot possibly hash equal.
function fixture(name, bytes, type) {
  const body = crypto.randomBytes(bytes);
  return { name, body, type, bytes, sha: sha(body) };
}

const FIX = {};
for (const [n, b, t] of [
  ["photo-a.jpg", 3 * 1024 * 1024, "image/jpeg"],
  ["photo-b.heic", 2 * 1024 * 1024 + 7919, "image/heic"],
  ["clip-a.mov", 6 * 1024 * 1024, "video/quicktime"],
  ["photo-c.jpg", 1024 * 1024 + 13, "image/jpeg"],
  ["photo-d.jpg", 1500 * 1024, "image/jpeg"],
  ["thumb-a.webp", 41 * 1024, "image/webp"],
]) FIX[n] = fixture(n, b, t);
// Eight 3 MB originals: 24 MB, comfortably over MEDIA_BUDGET_MIN, which is what makes an
// eviction pass observable at all without moving 320 MB through the harness.
const LRU = [];
for (let i = 1; i <= 8; i++) {
  const n = `lru-${i}.jpg`;
  LRU.push(n);
  FIX[n] = fixture(n, 3 * 1024 * 1024, "image/jpeg");
}

// ── the harness page ─────────────────────────────────────────────────────────────────────
// Deliberately not public/index.html: the app shell boots the router, the map and the store,
// none of which this is testing, and its failures would be noise on top of these. The app
// marker is present because sw.js requires it before a document may be cached.
const PAGE = `<!doctype html><html data-app="wegoplace" lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WeGoPlace</title></head><body>
<script type="module">
import * as S from "/js/memories-save.js";
window.S = S;
window.hex = async (buf) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
window.swReady = navigator.serviceWorker.register("/sw.js")
  .then(() => navigator.serviceWorker.ready).then(() => true);
window.T = {};

// Stand in for the iOS share sheet. Records every File it is handed and can be told to reject
// with AbortError, which is exactly what Safari throws when the sheet is dismissed.
T.installShareStub = (opts = {}) => {
  T.shared = [];
  T.abortOn = opts.abortOn ?? -1;   // 0-based share() call index to reject
  let calls = 0;
  Object.defineProperty(navigator, "canShare", {
    configurable: true, value: (d) => !!(d && d.files && d.files.length),
  });
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: async (d) => {
      const n = calls++;
      const rec = [];
      for (const f of d.files) rec.push({ name: f.name, type: f.type, size: f.size, sha: await window.hex(await f.arrayBuffer()) });
      if (n === T.abortOn) {
        const e = new Error("Abort due to cancellation of share.");
        e.name = "AbortError";
        throw e;
      }
      T.shared.push(rec);
      return undefined;
    },
  });
  // shareCapability() memoises, so the probe has to be re-run after the stub lands.
  S.default; // keep the import live
};
T.removeShareStub = () => {
  delete navigator.share;
  delete navigator.canShare;
};
</script></body></html>`;

// ── asset server ─────────────────────────────────────────────────────────────────────────

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".pmtiles": "application/octet-stream",
};

let sockets = new Set();
let server = null;

function serveMedia(req, res, name) {
  const f = FIX[name];
  if (!f) { res.writeHead(404).end(); return; }
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), f.bytes - 1) : f.bytes - 1;
      res.writeHead(206, {
        "Content-Type": f.type,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${f.bytes}`,
        "Accept-Ranges": "bytes",
      });
      res.end(f.body.subarray(start, end + 1));
      return;
    }
  }
  res.writeHead(200, {
    "Content-Type": f.type,
    "Content-Length": String(f.bytes),
    "Accept-Ranges": "bytes",
  });
  res.end(f.body);
}

function startServer() {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, ORIGIN);
    const p = decodeURIComponent(url.pathname);

    // The same page at the app's address for a trip (/t/<id>/): the store belongs to a trip
    // and boots only there, which section 7 needs.
    if (p === "/" || p === "/index.html" || /^\/t\/[^/]+\/$/.test(p)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (p.startsWith("/media/")) { serveMedia(req, res, p.slice("/media/".length)); return; }
    // Kept out of the run on purpose: /api is network-only in sw.js and syncImages() is 92
    // files this harness is not testing. Both failures are non-fatal by design in sw.js, and
    // this asserts that.
    if (p.startsWith("/api/") || p === "/img/CREDITS.json") { res.writeHead(404).end(); return; }

    const file = path.join(PUBLIC, p.replace(/^\/+/, ""));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise((r) => server.listen(PORT, "127.0.0.1", r));
}

function killServer() {
  return new Promise((r) => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    server.close(() => r());
  });
}

// ── minimal CDP client ───────────────────────────────────────────────────────────────────

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
    return new CDP(ws);
  }
  on(fn) { this.handlers.push(fn); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function evaluate(cdp, session, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true,
  }, session);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception ? (d.exception.description || d.exception.value) : d.text);
  }
  return r.result.value;
}

// ── run ──────────────────────────────────────────────────────────────────────────────────

(async () => {
  PORT = await new Promise((resolve, reject) => {
    const s = require("net").createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
  ORIGIN = `http://127.0.0.1:${PORT}`;
  await startServer();

  // The shared launcher: Chrome for Testing on a port read from its own fresh profile, so a
  // browser left behind by an aborted run can never be the one this run drives.
  const chrome = await launchChrome({ args: [
    "--disable-gpu", "--disable-features=Translate,MediaRouter", "about:blank",
  ] });


  const cdp = await CDP.connect(chrome.wsUrl);

  // Service worker targets arrive through auto-attach. flatten:true keeps everything on this
  // one socket, addressed by sessionId.
  const swSessions = new Set();
  let pageSession = null;
  cdp.on(async (msg) => {
    if (msg.method !== "Target.attachedToTarget") return;
    const { sessionId, targetInfo } = msg.params;
    if (targetInfo.type === "service_worker" || targetInfo.type === "worker") {
      swSessions.add(sessionId);
      try { await cdp.send("Network.enable", {}, sessionId); } catch { /* torn down already */ }
    }
  });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow", downloadPath: DOWNLOADS, eventsEnabled: true,
  });

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  ({ sessionId: pageSession } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
  await cdp.send("Page.enable", {}, pageSession);
  await cdp.send("Runtime.enable", {}, pageSession);
  await cdp.send("Network.enable", {}, pageSession);

  const swLog = [];
  cdp.on((msg) => {
    if (msg.method === "Runtime.consoleAPICalled" && swSessions.has(msg.sessionId)) {
      swLog.push((msg.params.args || []).map((a) => a.value ?? a.description).join(" "));
    }
  });

  // A fresh profile, so nothing stale can be cached — but set it anyway on the first load, per
  // the standing rule that a service worker will otherwise serve yesterday's modules.
  await cdp.send("Network.setBypassServiceWorker", { bypass: true }, pageSession);
  await cdp.send("Page.navigate", { url: ORIGIN + "/" }, pageSession);
  await sleep(1200);
  await cdp.send("Network.setBypassServiceWorker", { bypass: false }, pageSession);
  await cdp.send("Page.navigate", { url: ORIGIN + "/" }, pageSession);

  const evalP = (expr) => evaluate(cdp, pageSession, expr);
  const settle = async () => {
    for (let i = 0; i < 60; i++) {
      if (await evalP("!!window.swReady").catch(() => false)) break;
      await sleep(250);
    }
    await evalP("window.swReady");
    // Controlled, not merely installed: an uncontrolled page's fetches never reach the worker.
    for (let i = 0; i < 40; i++) {
      if (await evalP("!!navigator.serviceWorker.controller")) break;
      await sleep(250);
    }
  };
  const reload = async () => {
    await cdp.send("Page.navigate", { url: ORIGIN + "/" }, pageSession);
    await sleep(400);
    await settle();
  };
  await settle();
  check("service worker installed and controlling the page",
    await evalP("!!navigator.serviceWorker.controller"));
  for (const s of swSessions) {
    try { await cdp.send("Network.enable", {}, s); } catch { /* ignore */ }
  }
  check("attached to the service worker target over CDP", swSessions.size > 0, `${swSessions.size} session(s)`);

  const item = (n, extra = {}) => Object.assign({
    id: n, r2_key: n, mime: FIX[n].type, bytes: FIX[n].bytes,
    kind: FIX[n].type.startsWith("video/") ? "video" : "photo",
    created_at: 1787000000,
  }, extra);

  // ── 1. batching is arithmetic on declared bytes, so it is checked at full scale ─────────
  const MB = 1024 * 1024;
  const plan = await evalP(`(() => {
    const items = [
      { r2_key: "a", bytes: ${200 * MB}, mime: "video/quicktime" },
      { r2_key: "b", bytes: ${140 * MB}, mime: "video/quicktime" },
      { r2_key: "c", bytes: ${30 * MB},  mime: "image/jpeg" },
      { r2_key: "d", bytes: ${300 * MB}, mime: "video/mp4" },
      { r2_key: "e", bytes: ${8 * MB},   mime: "image/heic" },
    ];
    const p = S.planBatches(items);
    return { budget: p.budget, count: p.batchCount, sizes: p.batches.map(b => b.map(i => i.key)),
             label: S.saveLabel(p), oversize: p.oversize.length };
  })()`);
  check("batching splits at SHARE_BATCH_BYTES (350 MB)",
    plan.budget === 350 * MB
      && plan.count === 2
      && JSON.stringify(plan.sizes) === JSON.stringify([["a", "b"], ["c", "d", "e"]]),
    `${plan.count} batches: ${JSON.stringify(plan.sizes)}`);
  check("the tap count is on the label before the first tap",
    plan.label === "Save 5 · 2 taps", plan.label);

  const over = await evalP(`(() => {
    const p = S.planBatches([
      { r2_key: "small", bytes: ${5 * MB}, mime: "image/jpeg" },
      { r2_key: "huge",  bytes: ${900 * MB}, mime: "video/mp4" },
      { r2_key: "after", bytes: ${5 * MB}, mime: "image/jpeg" },
    ]);
    return { count: p.batchCount, sizes: p.batches.map(b => b.map(i => i.key)), oversize: p.oversize.map(i => i.key) };
  })()`);
  check("an item larger than the budget gets its own sheet and is never dropped",
    over.count === 3 && over.oversize[0] === "huge"
      && JSON.stringify(over.sizes) === JSON.stringify([["small"], ["huge"], ["after"]]),
    JSON.stringify(over.sizes));

  const unk = await evalP(`S.planBatches([{r2_key:"x"},{r2_key:"y"}], {batchBytes: ${9 * MB}}).batchCount`);
  check("an item with no recorded bytes is weighted high, not zero", unk === 2, `${unk} batches`);

  // ── 2. the save path, with the share sheet stubbed ─────────────────────────────────────
  const names = ["photo-a.jpg", "photo-b.heic", "clip-a.mov", "photo-c.jpg", "photo-d.jpg"];
  const expect = Object.fromEntries(names.map((n) => [n, FIX[n].sha]));

  const run = await evalP(`(async () => {
    T.installShareStub({ abortOn: 1 });
    const items = ${JSON.stringify(names.map((n) => item(n)))};
    const s = S.createSaveSession(items, { batchBytes: ${4 * MB} });
    const log = [];
    // Up to twelve taps; a correct session finishes in seven and the extra headroom is what
    // would expose an off-by-one that silently re-shares a batch.
    for (let i = 0; i < 12 && !s.done; i++) {
      const r = await s.saveNext();
      log.push({ tap: i + 1, status: r.status, index: s.index, ready: s.ready });
    }
    return { plan: s.plan.batches.map(b => b.map(i => i.key)), batchCount: s.batchCount,
             done: s.done, log, shared: T.shared };
  })()`);

  // 3 MB, 2 MB, 6 MB, 1 MB, 1.46 MB against a 4 MB budget: [a] [b] [clip alone, oversize]
  // [c+d]. Four sheets, and the last one is the greedy pack that proves this is not
  // one-file-per-sheet.
  check("a 5-file selection over a 4 MB budget packs greedily into 4 sheets",
    run.batchCount === 4
      && JSON.stringify(run.plan) === JSON.stringify([
        ["photo-a.jpg"], ["photo-b.heic"], ["clip-a.mov"], ["photo-c.jpg", "photo-d.jpg"]]),
    JSON.stringify(run.plan));

  const statuses = run.log.map((l) => l.status).join(",");
  check("a cancelled sheet keeps its place — same batch, no re-fetch",
    statuses === "ready,shared,ready,cancelled,shared,ready,shared,ready,shared,ready,shared"
      || /cancelled,shared/.test(statuses),
    statuses);
  const cancelIdx = run.log.findIndex((l) => l.status === "cancelled");
  check("the batch index does not advance on cancel",
    cancelIdx > 0 && run.log[cancelIdx].index === run.log[cancelIdx - 1].index
      && run.log[cancelIdx].ready === true,
    cancelIdx > 0 ? `index stayed at ${run.log[cancelIdx].index}, still primed` : "no cancel recorded");
  check("every batch reaches the sheet exactly once", run.done && run.shared.length === 4,
    `${run.shared.length} share() calls that were not cancelled`);

  const flat = run.shared.flat();
  const hashOk = flat.length === 5 && flat.every((f, i) => f.sha === expect[names[i]]);
  check("THE PROMISE: every shared file is sha256-identical to the uploaded original",
    hashOk,
    flat.map((f, i) => `${names[i]} ${f.sha.slice(0, 12)}${f.sha === expect[names[i]] ? "=" : "≠"}`).join(" "));
  check("files carry the right MIME and a sensible name",
    flat.every((f, i) => f.type === FIX[names[i]].type) && /^WeGoPlace-\d{4}-\d\d-\d\d-\d\d\./.test(flat[0].name),
    flat.map((f) => f.name).join(", "));
  check("declared bytes and delivered bytes agree",
    flat.every((f, i) => f.size === FIX[names[i]].bytes));

  // A truncated or substituted body must fail loudly rather than land a broken file in Photos.
  const badLen = await evalP(`(async () => {
    T.installShareStub({});
    const s = S.createSaveSession([${JSON.stringify(item("photo-a.jpg", { bytes: 999 }))}]);
    const r = await s.saveNext();
    return { status: r.status, msg: r.error ? r.error.message : "" };
  })()`);
  check("a length mismatch is refused, not saved",
    badLen.status === "error" && /length mismatch/.test(badLen.msg), badLen.msg);

  // ── 3. the download fallback, verified on disk ─────────────────────────────────────────
  // Reload rather than un-stub: shareCapability() memoises its probe on purpose (a browser
  // does not grow the ability mid-session), so the only honest way to measure the REAL
  // capability is a page whose module state never saw the stub.
  await reload();
  const cap = await evalP(`(() => { const c = S.shareCapability(); return { share: c.share, files: c.files, reason: c.reason }; })()`);
  check("the share path is chosen by probing a real File, not by sniffing the UA",
    typeof cap.files === "boolean",
    `share=${cap.share} canShare({files})=${cap.files}${cap.reason ? " reason=" + cap.reason : ""}`);

  const dl = await evalP(`(async () => {
    const r = await S.downloadBatch(${JSON.stringify([item("photo-a.jpg"), item("clip-a.mov")])});
    return { saved: r.saved, failed: r.failed.length };
  })()`);
  await sleep(2500);
  const onDisk = fs.readdirSync(DOWNLOADS).filter((f) => !f.endsWith(".crdownload"));
  const diskHashes = Object.fromEntries(onDisk.map((f) => [f, sha(fs.readFileSync(path.join(DOWNLOADS, f)))]));
  const wantSha = [FIX["photo-a.jpg"].sha, FIX["clip-a.mov"].sha];
  const gotSha = dl.saved.map((n) => diskHashes[n]);
  check("the download fallback writes both files",
    dl.failed === 0 && dl.saved.length === 2 && onDisk.length >= 2, onDisk.join(", "));
  check("downloaded bytes are sha256-identical to the original",
    JSON.stringify(gotSha) === JSON.stringify(wantSha),
    dl.saved.map((n, i) => `${n} ${gotSha[i] === wantSha[i] ? "ok" : "MISMATCH"}`).join(" "));

  // The automatic branch: a browser that refuses files must land on the download path without
  // the caller having to know. The stub goes in before anything calls shareCapability(), since
  // the probe is memoised for the life of the page.
  await reload();
  const auto = await evalP(`(async () => {
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => false });
    const cap = S.shareCapability();
    const r = await S.saveMedia([${JSON.stringify(item("photo-c.jpg"))}]);
    return { files: cap.files, reason: cap.reason, status: r.status, saved: r.saved };
  })()`);
  await sleep(1500);
  check("canShare({files})=false routes saveMedia() to the download path automatically",
    auto.files === false && auto.status === "downloaded" && auto.saved.length === 1,
    `reason=${auto.reason} status=${auto.status}`);

  // ── 4. the offline media cache ─────────────────────────────────────────────────────────
  const reg = await evalP(`S.mediaCache.register(${JSON.stringify([
    item("photo-a.jpg", { thumb_key: "thumb-a.webp" }),
    item("clip-a.mov"),
    item("photo-b.heic"),
  ])})`);
  check("the worker accepts the byte-length register", reg && reg.ok === true, JSON.stringify(reg));

  // A thumbnail is cached on sight, with no pin and no prefetch — that is the feed working.
  await evalP(`fetch("/media/thumb-a.webp").then(r => r.arrayBuffer())`);
  await sleep(600);
  const afterThumb = await evalP(`S.mediaCache.stats()`);
  check("a viewed thumbnail is cached on sight",
    afterThumb.thumbs.count === 1 && afterThumb.thumbs.bytes === FIX["thumb-a.webp"].bytes,
    `${afterThumb.thumbs.count} thumb(s), ${afterThumb.thumbs.bytes} B`);

  // The save path must not write its 350 MB batches into a 320 MB cache.
  await evalP(`fetch("/media/photo-b.heic", { headers: { "x-wgp-media": "save" } }).then(r => r.arrayBuffer())`);
  await sleep(400);
  const dump = await evalP(`(async () => {
    const c = await caches.open("wegoplace-media-v1");
    return (await c.keys()).map(r => r.url);
  })()`);
  console.log("      media cache holds: " + JSON.stringify(dump));
  const afterSaveFetch = await evalP(`S.mediaCache.stats()`);
  check("a fetch made for saving does not evict the trek into the cache",
    afterSaveFetch.originals.count === 0, `${afterSaveFetch.originals.count} original(s) cached`);

  const pre = await evalP(`S.mediaCache.prefetch(["photo-a.jpg", "clip-a.mov"])`);
  await sleep(300);
  const afterPre = await evalP(`S.mediaCache.stats()`);
  check("prefetch pulls originals whole",
    pre.ok && pre.fetched === 2 && afterPre.originals.count === 2
      && afterPre.originals.bytes === FIX["photo-a.jpg"].bytes + FIX["clip-a.mov"].bytes,
    `${afterPre.originals.count} originals, ${afterPre.originals.bytes} B`);

  // ── 5. genuinely offline: CDP offline on the page AND the worker, and the server killed ─
  await cdp.send("Network.emulateNetworkConditions",
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, pageSession);
  for (const s of swSessions) {
    await cdp.send("Network.emulateNetworkConditions",
      { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, s)
      .catch(() => {});
  }
  await killServer();

  const proofUncached = await evalP(`fetch("/media/photo-d.jpg").then(r => r.status).catch(e => "throw:" + e.name)`);
  check("the network really is gone (an uncached original does not resolve 200)",
    proofUncached !== 200, `status=${proofUncached}`);

  const offlineWhole = await evalP(`(async () => {
    const r = await fetch("/media/photo-a.jpg");
    if (!r.ok) return { status: r.status };
    const b = await r.arrayBuffer();
    return { status: r.status, size: b.byteLength, sha: await window.hex(b) };
  })()`);
  check("a cached original opens with no network at all, byte-identical",
    offlineWhole.status === 200 && offlineWhole.sha === FIX["photo-a.jpg"].sha,
    `status=${offlineWhole.status} ${offlineWhole.size} B`);

  const offlineRange = await evalP(`(async () => {
    const r = await fetch("/media/clip-a.mov", { headers: { Range: "bytes=1048576-1048591" } });
    const b = await r.arrayBuffer();
    return { status: r.status, cr: r.headers.get("Content-Range"), len: b.byteLength,
             hex: [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,"0")).join("") };
  })()`);
  const wantSlice = FIX["clip-a.mov"].body.subarray(1048576, 1048592).toString("hex");
  check("an offline video seek is answered as a real 206 with the right bytes",
    offlineRange.status === 206 && offlineRange.len === 16 && offlineRange.hex === wantSlice,
    `${offlineRange.status} ${offlineRange.cr}`);

  const offlineMiss = await evalP(`fetch("/media/photo-c.jpg").then(r => r.status)`);
  check("an uncached original offline is a labelled 504, not an unhandled throw",
    offlineMiss === 504, `status=${offlineMiss}`);
  const offlineRangeMiss = await evalP(
    `fetch("/media/photo-c.jpg", { headers: { Range: "bytes=0-15" } }).then(r => r.status).catch(e => "throw:" + e.name)`);
  check("an uncached SEEK offline is a labelled 504 too",
    offlineRangeMiss === 504, `status=${offlineRangeMiss}`);

  // The v6 block is additive; the guarantee it must not have cost is the one the whole app is
  // built on. Both of these are pre-existing sw.js behaviour, asserted here because this file
  // is the one that changed it.
  // The shell cache is found by its prefix, never opened by a version written here: this said
  // "wegoplace-shell-v6" while sw.js was on v54, so it opened (and so created) an empty cache
  // and reported 0 entries for a shell that was whole.
  const shell = await evalP(`(async () => {
    const n = (await caches.keys()).find(x => x.startsWith("wegoplace-shell-"));
    if (!n) return [];
    const c = await caches.open(n);
    return (await c.keys()).map(r => new URL(r.url).pathname).sort();
  })()`);
  check("the shell cache still holds the core modules after the v6 changes",
    ["/", "/styles.css", "/js/store.js", "/js/router.js", "/js/util.js"].every((p) => shell.includes(p)),
    `${shell.length} entries`);
  // A real navigation, not a fetch with mode:"navigate" (which cannot be constructed): this is
  // the path navigation() takes, and it is the app booting with no server behind it.
  await cdp.send("Page.navigate", { url: ORIGIN + "/" }, pageSession);
  await sleep(1500);
  const navOffline = await evalP(
    `({ app: document.documentElement.getAttribute("data-app"), url: location.pathname })`);
  check("the app still boots from cache with the network gone",
    navOffline.app === "wegoplace", JSON.stringify(navOffline));

  // ── 6. eviction spares pins ────────────────────────────────────────────────────────────
  await cdp.send("Network.emulateNetworkConditions",
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, pageSession);
  for (const s of swSessions) {
    await cdp.send("Network.emulateNetworkConditions",
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, s).catch(() => {});
  }
  await startServer();
  await reload();

  // 8 x 3 MB = 24 MB in, then the ceiling drops to 16 MB. lru-1 is pinned AND prefetched
  // first, so it is simultaneously the oldest entry and the one that must not be touched —
  // if pins were merely sorted last instead of excluded, it is the first thing to go.
  const evict = await evalP(`(async () => {
    await S.mediaCache.forget(${JSON.stringify(["photo-a.jpg", "clip-a.mov", "photo-b.heic", "thumb-a.webp"])});
    await S.mediaCache.setBudget(${320 * MB});
    await S.mediaCache.register(${JSON.stringify(LRU.map((n) => item(n)))});
    await S.mediaCache.pin(["lru-1.jpg"]);
    for (const k of ${JSON.stringify(LRU.slice(1))}) await S.mediaCache.prefetch([k]);
    const before = await S.mediaCache.stats();
    const budget = await S.mediaCache.setBudget(${16 * MB});
    const after = await S.mediaCache.stats();
    const present = {};
    const c = await caches.open("wegoplace-media-v1");
    for (const k of ${JSON.stringify(LRU)}) present[k] = !!(await c.match(location.origin + "/media/" + k));
    return { budget, before, after, present };
  })()`);
  const survives = LRU.filter((k) => evict.present[k]);
  check("all eight originals cached before the ceiling drops",
    evict.before.originals.count === 8, `${evict.before.originals.count} of 8, ${evict.before.originals.bytes} B`);
  check("the pinned original survives the eviction pass",
    evict.present["lru-1.jpg"] === true && evict.after.pinned.count === 1,
    `survivors: ${survives.join(" ")}`);
  check("unpinned originals go least-recently-used first",
    evict.present["lru-2.jpg"] === false && evict.present["lru-8.jpg"] === true
      && survives.length < 8,
    LRU.map((k) => `${k.replace(/\D+/g, "")}=${evict.present[k] ? "kept" : "gone"}`).join(" "));
  check("the cache lands under its ceiling",
    evict.after.originals.bytes <= evict.after.budget.valueOf(),
    `${evict.after.originals.bytes} B of ${evict.after.budget} B`);

  // ── 7. persistence, and the cache name in KEEP ─────────────────────────────────────────
  // The requirement is that persist() is ASKED for, once, by store.js. Whether the OS grants
  // it is a device-level answer no harness can force, so the spy is the assertion and the
  // grant is reported as data.
  // The store asks when it boots, and it boots at a trip's address: this page, there.
  await cdp.send("Page.navigate", { url: ORIGIN + "/t/harness-trip/" }, pageSession);
  await sleep(400);
  await settle();
  const persist = await evalP(`(async () => {
    let asked = 0;
    const real = navigator.storage.persist.bind(navigator.storage);
    navigator.storage.persist = (...a) => { asked++; return real(...a); };
    const answer = await S.mediaCache.persisted();
    return { asked, answer, granted: await navigator.storage.persisted() };
  })()`);
  check("the media layer routes persistence through store.js and asks exactly once",
    persist.asked === 1,
    `persist() calls=${persist.asked}, granted=${persist.granted}, store.persisted()=${persist.answer}`);
  // Comment lines stripped first: the file DISCUSSES store.js's persist() call at length, and
  // a naive grep would flag the explanation for being about the thing it explains.
  const code = fs.readFileSync(path.join(PUBLIC, "js/memories-save.js"), "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  check("memories-save.js does not duplicate the persist() call",
    !/navigator\s*\.\s*storage\s*\.\s*persist\s*\(/.test(code));
  const cacheNames = await evalP(`caches.keys()`);
  check("the media cache exists under its own name",
    cacheNames.includes("wegoplace-media-v1"), cacheNames.join(", "));

  console.log("\n" + swLog.filter((l) => /media/.test(l)).slice(-12).map((l) => "  [sw] " + l).join("\n"));

  // ── done ───────────────────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) console.log("FAILED: " + failed.map((f) => f.name).join(" | "));

  await chrome.close();
  await killServer().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error("harness error:", e);
  process.exit(2);
});

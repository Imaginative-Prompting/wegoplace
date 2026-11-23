// Captive-portal regression check — the case a site served without its functions structurally cannot see.
//
// WHY THIS EXISTS SEPARATELY. The old offline harness (retired) built its site with `fs.cpSync(PUBLIC, SITE)`
// and serves that: functions/ is never copied, so there is no auth middleware, no D1 and no API
// in the run. Its "session lapses" stage simulates a 302 to /login, which usable() already
// rejects via res.redirected — i.e. it tests the case that was never in danger. The case that
// IS in danger is a hotel portal answering 200 text/html, because that is a genuine 200 of the
// same content type the app document has, so no status, redirect or content-type check can
// separate them. Two live bugs came out of that gap:
//
//   * navigation() cached the portal's 70-byte page over the 17 KB app document. The cached "/"
//     is the one thing with no self-heal offline — images are re-verified by byte length every
//     launch and the shell is replaced on a VERSION bump, but a poisoned "/" is only repaired
//     by a navigation that reaches the real server, which on the trek is four days away.
//   * tiles() skipped usable() entirely and stored the portal body as map furniture, in a cache
//     that is in KEEP and therefore never swept — permanent for the life of the install.
//
// Both are fixed; this is what keeps them fixed. The portal is injected INSIDE the service
// worker over CDP, so the real `wrangler pages dev` keeps serving throughout and the run
// exercises the actual stack — middleware, functions and all.
//
// USAGE:  node scripts/captive_portal_check.js
//   needs: the gate's server and its trip (scripts/gate.mjs), and Chrome.
// Exits non-zero on any failed check.

import fs from "node:fs";
import path from "node:path";
import { signedIn, tripPath } from "./lib/gate_trip.mjs";
import { baseUrl, launchChrome } from "./lib/browser.mjs";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ORIGIN = baseUrl();   // WGP_BASE or --base=<url>: this lane's dev server (scripts/lib/browser.mjs)
const PORTAL = "<!doctype html><title>Hotel WiFi</title><h1>Sign in to Hotel WiFi</h1>";
const GLYPH = "/tiles/fonts/Noto%20Sans%20Bold/0-255.pbf";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : `  — ${detail}`}`);
  if (!ok) failures++;
}

// Signed in as the host of the gate's made-up trip, with a session of this run's own
// (scripts/lib/gate_trip.mjs).

// ── minimal CDP over Node's global WebSocket ───────────────────────────────────────────────
class Conn {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); this.subs = []; }
  static async open(url) {
    const ws = new WebSocket(url);
    const c = new Conn(ws);
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pend.has(m.id)) {
        const { res, rej } = c.pend.get(m.id); c.pend.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) for (const f of c.subs) f(m);
    });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("ws open timeout")), 15000);
      ws.addEventListener("open", () => { clearTimeout(t); res(); });
      ws.addEventListener("error", () => { clearTimeout(t); rej(new Error("ws error")); });
    });
    return c;
  }
  on(fn) { this.subs.push(fn); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => {
      this.pend.set(id, { res, rej });
      setTimeout(() => { if (this.pend.delete(id)) rej(new Error(`timeout ${method}`)); }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function evalIn(conn, expr, sessionId) {
  const r = await conn.send("Runtime.evaluate",
    { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error("EVAL: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

const CACHED = (p) => `
(async () => {
  const r = await caches.match(${JSON.stringify(ORIGIN)} + ${JSON.stringify(p)}, { ignoreSearch: true });
  if (!r) return null;
  const t = await r.clone().text();
  return JSON.stringify({ bytes: t.length, ct: r.headers.get("content-type"), marker: t.includes('data-app="wegoplace') });
})()`;

const TILE_TYPES = `
(async () => {
  const names = (await caches.keys()).filter((n) => n.includes("tiles"));
  const out = [];
  for (const n of names) {
    const c = await caches.open(n);
    for (const rq of await c.keys()) {
      const r = await c.match(rq);
      out.push({ url: new URL(rq.url).pathname, ct: (r && r.headers.get("content-type")) || "" });
    }
  }
  return JSON.stringify(out);
})()`;

// ── run ────────────────────────────────────────────────────────────────────────────────────
(async () => {
  const up = await fetch(ORIGIN + "/login").then((r) => r.ok).catch(() => false);
  if (!up) { console.error(`no server on ${ORIGIN} — start \`npx wrangler pages dev\` first`); process.exit(2); }

  // The shared launcher: Chrome for Testing on a port read from its own fresh profile.
  const chrome = await launchChrome({ args: ["--disable-gpu"] });
  const CDP = chrome.origin;

  let conn;
  try {
    conn = await Conn.open(chrome.wsUrl);

    const tab = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId: tab.id, flatten: true });
    for (const d of ["Page", "Runtime", "Network"]) await conn.send(`${d}.enable`, {}, sessionId);
    for (const cookie of await signedIn()) await conn.send("Network.setCookie", cookie, sessionId);

    // Boot with the service worker LIVE so it installs and precaches.
    await conn.send("Page.navigate", { url: ORIGIN + tripPath() }, sessionId);
    await sleep(9000);
    await evalIn(conn, "navigator.serviceWorker.ready.then(()=>1)", sessionId);
    await sleep(2500);

    const before = JSON.parse(await evalIn(conn, CACHED("/"), sessionId) || "null");
    check("app document precached", !!before && before.marker, before && `${before.bytes} bytes`);

    // Attach to the service worker and make a portal answer ITS fetches.
    const { targetInfos } = await conn.send("Target.getTargets");
    const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.includes("sw.js"));
    if (!sw) throw new Error("no service worker target — did it fail to register?");
    const swS = (await conn.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).sessionId;
    await conn.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, swS);
    conn.on(async (m) => {
      if (m.method !== "Fetch.requestPaused" || m.sessionId !== swS) return;
      try {
        await conn.send("Fetch.fulfillRequest", {
          requestId: m.params.requestId, responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }],
          body: Buffer.from(PORTAL).toString("base64"),
        }, swS);
      } catch {}
    });

    // ONE navigation on hostal wifi — what an installed PWA does when it is opened there.
    await conn.send("Page.navigate", { url: ORIGIN + tripPath() }, sessionId);
    await sleep(7000);
    const after = JSON.parse(await evalIn(conn, CACHED("/"), sessionId) || "null");
    check("portal did NOT replace the cached app document",
      !!after && after.marker === true, after ? `${after.bytes} bytes` : "cache entry gone");

    // Warming the map on portal wifi must not poison a glyph range.
    await evalIn(conn, `fetch(${JSON.stringify(GLYPH)}).catch(()=>0)`, sessionId).catch(() => {});
    await sleep(3500);
    const tiles = JSON.parse(await evalIn(conn, TILE_TYPES, sessionId) || "[]");
    const html = tiles.filter((t) => t.ct.includes("text/html"));
    check("no text/html entry in the tiles cache", html.length === 0, JSON.stringify(html.slice(0, 3)));

    // The sibling handlers are the control: they already refused, and must keep refusing.
    await evalIn(conn, `fetch("/js/__portal_probe.js").catch(()=>0)`, sessionId).catch(() => {});
    await evalIn(conn, `fetch("/img/__portal_probe.webp").catch(()=>0)`, sessionId).catch(() => {});
    await sleep(2500);
    check("asset() refused the portal", (await evalIn(conn, CACHED("/js/__portal_probe.js"), sessionId)) === null);
    check("image() refused the portal", (await evalIn(conn, CACHED("/img/__portal_probe.webp"), sessionId)) === null);

    await conn.send("Fetch.disable", {}, swS).catch(() => {});
  } catch (e) {
    console.error("harness error:", e.message);
    failures++;
  } finally {
    if (conn) conn.close();
    await chrome.close();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall captive-portal checks passed");
  process.exit(failures ? 1 : 0);
})();

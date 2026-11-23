#!/usr/bin/env node
/* AUTH + OBSERVER PROXY — the thing that lets REAL iOS Safari reach this dev server.
 *
 *   PORT=<free port> WGP_BASE=http://127.0.0.1:<dev server port> node scripts/ios-real/proxy.js   # plain, authenticated
 *   PROBE=1 PORT=… WGP_BASE=… node scripts/ios-real/proxy.js                                    # + inject the read-only observer
 *   PORT=8797 NOSW=0 PROBE=1 node ...              # + keep the real service worker
 *
 * WHY THIS EXISTS. Sign-in is WebAuthn. A passkey cannot be typed into a simulator, so there
 * is no way to authenticate Mobile Safari by hand. This proxy fronts `wrangler pages dev` and
 * adds the signed `s2` cookie server-side. The simulator receives byte-identical app modules —
 * nothing about the app changes, only who the request appears to come from.
 *
 * THREE JOBS:
 *   1. AUTH.   Adds `s2=<uid>.<exp>.<hmac>` built from AUTH_SECRET in .dev.vars.
 *   2. PROBE.  With PROBE=1, injects <script src="/__v7probe.js"> at the end of <head> and
 *              accepts that observer's telemetry at POST /__v7log (ndjson on disk).
 *              GET /__v7reset truncates the log between takes.
 *   3. NO STALE BYTES. By default serves a self-unregistering `sw.js` on this origin. This is
 *              the iOS equivalent of CDP's Network.setBypassServiceWorker, and it is not
 *              optional hygiene: sw.js precaches every app module, so without it the first run
 *              installs the worker and every later run measures the code from BEFORE your edit.
 *              That is how a fix gets reported landed when it is not. NOSW=0 to test the real
 *              worker (do that once, deliberately, at the end).
 *
 * TIP: a different PORT is a different origin, which means no service worker and no HTTP cache
 * carried over from an earlier take. Cheapest possible reset.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO = path.join(__dirname, "..", "..");
const UP = require("../lib/browser.mjs").baseUrl();   // WGP_BASE or --base=<url>: this lane's dev server (scripts/lib/browser.mjs)
// No default port: two lanes' proxies on one number would answer each other's simulators.
const PORT = Number(process.env.PORT);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  console.error("Say which port the proxy listens on: PORT=<free port> WGP_BASE=http://127.0.0.1:<dev server port> node scripts/ios-real/proxy.js");
  process.exit(2);
}
const PROBE = process.env.PROBE === "1";
const LOG = process.env.LOG || path.join(__dirname, "iolog.ndjson");

function cookie(uid) {
  const vars = fs.readFileSync(path.join(REPO, ".dev.vars"), "utf8");
  const m = /^AUTH_SECRET\s*=\s*(.+)$/m.exec(vars);
  if (!m) throw new Error("no AUTH_SECRET in .dev.vars");
  const secret = m[1].trim().replace(/^["']|["']$/g, "");
  const msg = `${uid}.${Math.floor(Date.now() / 1000) + 7200}`;
  return `${msg}.${crypto.createHmac("sha256", secret).update(msg).digest("hex")}`;
}
const C = cookie(process.env.UID || "u_admin");

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const body = Buffer.concat(chunks);

  if (req.url === "/__v7log" && req.method === "POST") {
    fs.appendFileSync(LOG, body.toString() + "\n");
    res.writeHead(204); res.end(); return;
  }
  if (req.url === "/__v7probe.js") {
    res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
    res.end(fs.readFileSync(path.join(__dirname, "probe.js"))); return;
  }
  if (process.env.NOSW !== "0" && /^\/sw\.js(\?|$)/.test(req.url)) {
    res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
    res.end("self.addEventListener('install',e=>self.skipWaiting());"
      + "self.addEventListener('activate',e=>e.waitUntil((async()=>{"
      + "for(const k of await caches.keys())await caches.delete(k);"
      + "await self.registration.unregister();})()));");
    return;
  }
  if (req.url === "/__v7reset") {
    try { fs.unlinkSync(LOG); } catch {}
    res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return;
  }

  const headers = { ...req.headers };
  delete headers.host;
  delete headers["accept-encoding"];
  headers.cookie = headers.cookie ? `${headers.cookie}; s2=${C}` : `s2=${C}`;
  try {
    const up = await fetch(UP + req.url, {
      method: req.method, headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
      redirect: "manual",
    });
    const out = {};
    up.headers.forEach((v, k) => { if (!/^content-encoding$|^content-length$|^transfer-encoding$/i.test(k)) out[k] = v; });
    let buf = Buffer.from(await up.arrayBuffer());
    if (PROBE && /text\/html/i.test(out["content-type"] || "")) {
      buf = Buffer.from(buf.toString().replace("</head>", '<script src="/__v7probe.js"></script></head>'));
    }
    res.writeHead(up.status, out);
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("proxy error: " + e.message);
  }
});
// This machine only. The proxy signs every request in as a member, so anything that can reach
// its port is signed in: a simulator shares the Mac's loopback and needs nothing wider.
server.listen(PORT, "127.0.0.1", () =>
  console.log(`ios-real proxy :${PORT} -> ${UP} as ${process.env.UID || "u_admin"}  probe=${PROBE}  realSW=${process.env.NOSW === "0"}`));

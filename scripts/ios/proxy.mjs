// A relay in front of a site, for an iPhone Simulator's real Safari and Home Screen app, where
// nothing may drive the browser from outside. Only on this machine.
//
//   - Every page gets a small probe (inline, first thing in the document). It reports what the
//     page says and any error, and runs the scripts the check sends: /api/__probe/cmd (a long
//     poll) and /api/__probe/in. Under /api/ because both the old service worker and the new one
//     pass /api/ straight to the network (anything else they would answer from a cache, or keep).
//   - The site sees its own address (Host, Origin, Referer), the phone sees the phone's.
//   - Safari drops a Secure cookie on http://localhost: Secure is taken off what the site sets.
//   - A sign-in cookie can be handed to the phone (the old site's own, signed by the check).
//   - No signal: every connection to the site is cut; the probe's own stay up.
//   - A late page: the next GET of "/" is held back.
import http from "node:http";
import net from "node:net";

const PROBE = `(() => {
  if (window.__probe) return; window.__probe = 1;
  const page = Math.random().toString(36).slice(2, 10);
  const post = (kind, data) => fetch("/api/__probe/in", { method: "POST", body: JSON.stringify({ page, kind, data }), keepalive: true }).catch(() => {});
  addEventListener("error", (e) => post("error", (String((e.error && e.error.stack) || e.message || "error") + " @ " + String(e.filename || "(no file)").replace(location.origin, "") + ":" + (e.lineno || 0) + ":" + (e.colno || 0)).slice(0, 600)));
  addEventListener("unhandledrejection", (e) => post("error", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason || "rejection").slice(0, 600)));
  let last = "", saidUpdating = false, saidWaiting = false;
  const look = () => {
    const t = document.getElementById("toast"); const words = t && !t.hidden ? (t.innerText || "").replace(/\\s+/g, " ").trim() : "";
    if (words && words !== last) post("said", words); last = words;
    const s = document.querySelector("[data-shell]");
    if (s && s.dataset.shell === "updating" && !saidUpdating) { saidUpdating = true; post("said", "[the page] Updating the app…"); }
    if (s && s.dataset.shell === "waiting" && !saidWaiting) { saidWaiting = true; post("said", "[the page] Still updating the app"); }
  };
  const watch = () => new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  if (document.documentElement) watch(); else addEventListener("DOMContentLoaded", watch);
  post("hello", { path: location.pathname + location.hash, standalone: navigator.standalone === true || matchMedia("(display-mode: standalone)").matches, controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller) });
  addEventListener("pagehide", () => post("bye", { path: location.pathname + location.hash }));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  (async () => {
    for (;;) {
      try {
        const res = await fetch("/api/__probe/cmd?page=" + page, { cache: "no-store" });
        if (res.status === 200) {
          const { id, script } = await res.json();
          let value;
          try { value = await new AsyncFunction(script + "\\n//# sourceURL=" + location.origin + "/__probe-command-" + id + ".js")(); } catch (e) { value = { __error: String((e && e.stack) || e).slice(0, 600) }; }
          await fetch("/api/__probe/in", { method: "POST", body: JSON.stringify({ page, kind: "result", id, value: value === undefined ? null : value }) });
        }
      } catch { await new Promise((r) => setTimeout(r, 300)); }
    }
  })();
})();`;

// The probe with nothing but its ears: the page's errors, its hello and its goodbye, no watching, no
// command channel. For the load that asks whether "Script error." is the probe's own doing: if it still
// comes with this alone, it isn't. (15 Nov 2026: with this alone, in a Safari tab, none came. Every
// "Script error." seen has been in the Home Screen app, so a tab's load alone doesn't settle it.)
const PROBE_BARE = `(() => {
  if (window.__probe) return; window.__probe = 1;
  const page = "bare-" + Math.random().toString(36).slice(2, 8);
  const post = (kind, data) => fetch("/api/__probe/in", { method: "POST", body: JSON.stringify({ page, kind, data }), keepalive: true }).catch(() => {});
  addEventListener("error", (e) => post("error", (String((e.error && e.error.stack) || e.message || "error") + " @ " + String(e.filename || "(no file)").replace(location.origin, "") + ":" + (e.lineno || 0) + ":" + (e.colno || 0)).slice(0, 600)));
  addEventListener("unhandledrejection", (e) => post("error", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason || "rejection").slice(0, 600)));
  post("hello", { path: location.pathname + location.hash, standalone: navigator.standalone === true || matchMedia("(display-mode: standalone)").matches, controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller), page });
  addEventListener("pagehide", () => post("bye", { path: location.pathname + location.hash }));
})();`;

/**
 * Where an error came from: its own page (the probe sends its page's id with it), and when, against that page's hello
 * and its goodbye (pagehide), and whether another page had said hello since. A page that replaces itself as it starts
 * (index.html's location.replace("/trips"), an old app's reload) can send an error after the next page's hello: by
 * the last hello alone it would be put on the wrong page.
 *   whereError(st, entry) → { page, path, live, sinceHello, sinceBye, words }
 */
export function whereError(st, e) {
  const hello = st.hellos.find((h) => h.page === e.page);
  const bye = st.byes.find((b) => b.page === e.page);
  const later = st.hellos.find((h) => h.page !== e.page && hello && h.at > hello.at && h.at <= e.at);
  const path = hello ? hello.path : "a page that never said hello";
  const s = (ms) => `${(ms / 1000).toFixed(2)} s`;
  const live = !!hello && !later && !(bye && bye.at <= e.at);
  const sinceHello = hello ? e.at - hello.at : null, sinceBye = bye ? e.at - bye.at : null;
  const words = !hello ? `${path} (page ${e.page || "?"})`
    : `${path} (page ${e.page}, ${s(sinceHello)} after its hello; ${bye ? (sinceBye >= 0 ? `${s(sinceBye)} after its goodbye` : `${s(-sinceBye)} before its goodbye`) : "no goodbye"}; ${live ? "the live page then" : later ? `${later.path} had said hello ${s(e.at - later.at)} before` : "after it had gone"})`;
  return { page: e.page || null, path, live, sinceHello, sinceBye, words };
}

const HOLD_UPDATING = Number(process.env.IOS_HOLD_UPDATING_MS) || 0;
const SLOW_WORKER = Number(process.env.IOS_SLOW_WORKER_MS) || 0;
export function startProxy({ listen, upstream, bare = false, keepHost = false }) {
  const st = {
    bare,                               // the bare probe (PROBE_BARE) on every page this proxy serves
    // keepHost: the site is told the phone's own address (Host, Origin, Referer as the phone sent
    // them) instead of its own port's, and must count it as one of its addresses (ALSO_ORIGINS):
    // as a phone at the real address meets the real site. A passkey's client data names the page's
    // address, so a site that hears another one refuses it ("not verified": 15 Nov, the fourth boot).
    keepHost,
    slowUntil: 0,
    upstream, down: false, late: 0, lateMs: 6000, lateSeen: [], noGuard: false, guardRefused: 0,
    cookie: null,                       // { name, value, maxAge }: handed to a phone that has none
    known: new Set(),                   // the names of the cookies this run has set
    requests: [], said: [], errors: [], hellos: [], sockets: new Set(), probeSockets: new Set(),
    // Each error as the page that had it sent it, with when it came, and each page's goodbye (pagehide): an error is
    // placed by its own page, not by whichever page said hello last (whereError()).
    errorLog: [], byes: [],
  };
  let nextId = 1;
  const queue = [];                     // commands waiting for a page
  const polls = [];                     // pages waiting for a command: { page, res }
  const results = new Map();            // id → resolve
  const there = (v) => String(v).replaceAll(`localhost:${listen}`, `localhost:${st.upstream}`).replaceAll(`127.0.0.1:${listen}`, `127.0.0.1:${st.upstream}`);
  const back = (v) => String(v).replaceAll(`localhost:${st.upstream}`, `localhost:${listen}`).replaceAll(`127.0.0.1:${st.upstream}`, `127.0.0.1:${listen}`);
  const hand = () => {
    while (queue.length && polls.length) {
      const live = st.hellos.at(-1);
      const i = polls.findIndex((p) => !live || p.page === live.page);
      if (i < 0) return;
      const [{ res }] = polls.splice(i, 1);
      const cmd = queue.shift();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(cmd));
    }
  };
  const body = (req) => new Promise((resolve) => { const parts = []; req.on("data", (d) => parts.push(d)); req.on("end", () => resolve(Buffer.concat(parts))); });

  const server = http.createServer(async (req, res) => {
    const pathOnly = req.url.replace(/\?.*$/, "");
    if (pathOnly === "/api/__probe/cmd") {
      st.probeSockets.add(req.socket);
      const page = new URL(req.url, "http://x").searchParams.get("page");
      const entry = { page, res };
      polls.push(entry);
      req.on("close", () => { const i = polls.indexOf(entry); if (i >= 0) polls.splice(i, 1); });
      setTimeout(() => { const i = polls.indexOf(entry); if (i >= 0) { polls.splice(i, 1); res.writeHead(204); res.end(); } }, 20000);
      hand();
      return;
    }
    if (pathOnly === "/api/__probe/in") {
      st.probeSockets.add(req.socket);
      let m = null;
      try { m = JSON.parse((await body(req)).toString("utf8")); } catch { /* not ours */ }
      res.writeHead(204); res.end();
      if (!m) return;
      if (m.kind === "result") { const done = results.get(m.id); if (done) { results.delete(m.id); done(m.value); } }
      else if (m.kind === "hello") { st.hellos.push({ page: m.page, at: Date.now(), ...m.data }); hand(); }
      else if (m.kind === "said") {
        st.said.push(String(m.data));
        // IOS_HOLD_UPDATING_MS: a slow connection from the moment the page says it is updating
        // (every request to the site waits until then), so a driver slower than the update can
        // still act while the page says so. Off unless asked for.
        if (HOLD_UPDATING && /Updating the app/.test(String(m.data)) && !st.slowUntil) st.slowUntil = Date.now() + HOLD_UPDATING;
      }
      else if (m.kind === "bye") st.byes.push({ page: m.page, at: Date.now(), ...(m.data || {}) });
      else if (m.kind === "error") { st.errors.push(String(m.data)); st.errorLog.push({ page: m.page, at: Date.now(), data: String(m.data) }); }
      return;
    }
    if (st.down) { req.socket.destroy(); return; }
    if (st.noGuard && /^\/js\/fresh-app\.js(\?|$)/.test(req.url) && !/\/sw\.js(\?|$)/.test(String(req.headers.referer || ""))) { st.guardRefused++; req.socket.destroy(); return; }
    // The driver's own ask before the phone's (phone.mjs preflight): answered like any other,
    // never counted among the phone's requests, never handed the phone's cookie.
    const pre = req.headers["x-relay-preflight"] === "1";
    const entry = { method: req.method, url: req.url, at: Date.now() };
    if (!pre) st.requests.push(entry);
    const go = () => {
      if (st.down) { entry.failed = "no signal"; req.socket.destroy(); return; }
      const headers = { ...req.headers };
      if (!st.keepHost) for (const k of ["host", "origin", "referer"]) if (headers[k]) headers[k] = there(headers[k]);
      delete headers["accept-encoding"];
      // The phone's sign-in cookie, from its very first request (a redirect to the sign-in page
      // would otherwise come before the phone has it).
      // Cookies are kept per host, not per port: the simulator's browser still holds what
      // earlier runs set for "localhost" (a sign-in signed with another run's secret). Only
      // what THIS run set reaches the site, and while a cookie is being handed, it is the one.
      const sentCookies = String(req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf("=")), c]);
      const mine = sentCookies.filter(([name]) => st.known.has(name) && !(st.cookie && name === st.cookie.name)).map(([, c]) => c);
      const has = st.cookie && sentCookies.some(([, c]) => c === `${st.cookie.name}=${st.cookie.value}`);
      const lacks = !pre && !!st.cookie && !has;
      delete headers["x-relay-preflight"];
      if (st.cookie && !pre) mine.push(`${st.cookie.name}=${st.cookie.value}`);
      if (mine.length) headers.cookie = mine.join("; "); else delete headers.cookie;
      const up = http.request({ host: "127.0.0.1", port: st.upstream, method: req.method, path: req.url, headers }, (r) => {
        entry.status = r.statusCode; entry.answered = Date.now();
        const out = { ...r.headers };
        if (out.location) out.location = back(out.location);
        let cookies = [].concat(out["set-cookie"] || []).map((c) => c.replace(/;\s*Secure/gi, ""));
        const html = /text\/html/.test(String(out["content-type"] || "")) && req.method === "GET";
        for (const c of cookies) st.known.add(c.slice(0, c.indexOf("=")));
        if (lacks && !/^\/api\//.test(req.url)) {
          st.known.add(st.cookie.name);
          cookies.push(`${st.cookie.name}=${st.cookie.value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${st.cookie.maxAge}`);
        }
        if (cookies.length) out["set-cookie"] = cookies; else delete out["set-cookie"];
        if (!html) { res.writeHead(r.statusCode, out); r.pipe(res); return; }
        const parts = [];
        r.on("data", (d) => parts.push(d));
        r.on("end", () => {
          let text = Buffer.concat(parts).toString("utf8");
          const tag = `<script>${st.bare ? PROBE_BARE : PROBE}</script>`;
          text = /<head[^>]*>/i.test(text) ? text.replace(/<head[^>]*>/i, (m) => m + tag) : tag + text;
          const buf = Buffer.from(text, "utf8");
          delete out["content-length"]; delete out["transfer-encoding"]; delete out["content-encoding"];
          out["content-length"] = String(buf.length);
          res.writeHead(r.statusCode, out); res.end(buf);
        });
        r.on("error", () => res.destroy());
      });
      up.on("error", () => { entry.failed = "the site did not answer"; res.destroy(); });
      req.pipe(up);
    };
    const isPage = req.method === "GET" && pathOnly === "/";
    if (isPage && st.late > 0) { st.late--; st.lateSeen.push(Date.now()); setTimeout(go, st.lateMs); }
    else if (st.slowUntil > Date.now()) setTimeout(go, st.slowUntil - Date.now());
    // IOS_SLOW_WORKER_MS: a slow connection for what a service worker downloads when it installs
    // (its requests name sw.js as where they come from), from the moment a page is held back:
    // the new worker takes that long to have its shell, so the old app is on screen that long.
    else if (SLOW_WORKER && st.lateSeen.length && /\/sw\.js(\?|$)/.test(String(req.headers.referer || "")) && st.lateSeen[0] + SLOW_WORKER > Date.now()) setTimeout(go, st.lateSeen[0] + SLOW_WORKER - Date.now());
    else go();
  });
  server.on("connection", (sock) => { st.sockets.add(sock); sock.on("close", () => { st.sockets.delete(sock); st.probeSockets.delete(sock); }); });
  server.on("upgrade", (req, socket, head) => {
    if (st.down) { socket.destroy(); return; }
    const up = net.connect(st.upstream, "127.0.0.1", () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + req.rawHeaders.reduce((a, v, i) => a + (i % 2 ? `${/^(host|origin|referer)$/i.test(req.rawHeaders[i - 1]) ? there(v) : v}\r\n` : `${v}: `), "") + "\r\n");
      if (head && head.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
  });

  const api = {
    st,
    ready: new Promise((resolve, reject) => { server.once("error", reject); server.listen(listen, "127.0.0.1", resolve); }),
    /** No signal: connections to the site are cut and refused; the probe's stay. */
    signal(on) { st.down = !on; if (!on) for (const sock of st.sockets) if (!st.probeSockets.has(sock)) sock.destroy(); },
    /** Runs a function body in the page that last said hello; resolves with its value. */
    run(script, { timeout = 30000 } = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { results.delete(id); const i = queue.findIndex((c) => c.id === id); if (i >= 0) queue.splice(i, 1); reject(new Error(`the page did not answer in ${timeout / 1000} s`)); }, timeout);
        results.set(id, (value) => { clearTimeout(timer); if (value && value.__error) reject(new Error(value.__error)); else resolve(value); });
        queue.push({ id, script });
        hand();
      });
    },
    /** A page that says hello after `since` (a new document), within the time. */
    async hello(since, timeout = 30000) {
      const end = Date.now() + timeout;
      for (;;) {
        const h = st.hellos.findLast((x) => x.at > since);
        if (h) return h;
        if (Date.now() > end) throw new Error(`no page said hello in ${timeout / 1000} s`);
        await new Promise((r) => setTimeout(r, 200));
      }
    },
    stop() { for (const sock of st.sockets) sock.destroy(); server.close(); },
  };
  return api;
}

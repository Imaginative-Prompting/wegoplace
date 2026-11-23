#!/usr/bin/env node
/* ONE BUILD PER PAGE: a page and the modules it runs are always one build, on the first load after a deploy and while a
 * page stays open across one (public/sw.js "one build per page", public/js/fresh-app.js). A server of this check's own
 * serves whole builds of public/ and moves from one to the next while the browser runs, as a deploy does. Each build
 * carries a probe module whose answer is its build, and each page records, on every load, which build the page is and
 * which build the probe it imports came from (the page's app starts after fresh-app's guard, and so does the probe).
 *
 *   A. Old worker, new deploy (the browser tab, the sign-in page): a phone still on the code from before one build per
 *      page (its last build, v150, from git: OLD_REF below) gets this tree's build. The first load never runs the new
 *      page on the old worker's modules, and the page ends on the new build after exactly one reload. (A phone already
 *      on one build per page getting a newer build is F, G and H.)
 *   B. A mismatch that never resolves (the new build's worker can't install): one reload at most, then the page runs as
 *      it is and says so once ("shell mismatch after reload", one error report).
 *   C. No connection, with a worker of this tree in charge and a newer build on the server: the worker's own page and
 *      modules run, no reload, and "Updating the app…" is never shown.
 *   D. A's case as the installed app (an app window, display-mode standalone) on the app's own page.
 *   F. Open across a takeover: a page of build 1 is open in one tab while another tab, hidden, lets the waiting build 2
 *      take over. The open page's lazy import gets build 1's copy (never build 2's on build 1's page; a page whose build
 *      the worker doesn't know would get build 2's, and is red here), and it loads again onto build 2 when it is hidden.
 *   G. Three builds in a row: with a page of build 1 still open, builds 2 and 3 take over in turn; only build 1's shell
 *      (the open page's) and build 3's (the current) remain. A shell retired more than 24 hours ago goes even while a
 *      page of it is open. And once no page of build 1 is open, only the current shell is left.
 *   H. Hidden with an update waiting: a page of build 1, nothing unsent, a worker of build 2 waiting. Hidden, the page
 *      lets build 2 take over and loads again WHILE STILL HIDDEN, so the screen shown next is build 2 whole, never a
 *      half-old one; and with typed words in a field, nothing happens. Then build 3 waits with a worker that answers
 *      the first hide's "which build?" too late (past fresh-app's 1.5 s): that hide lets it be, and the next hide moves
 *      on, once, never on the show between. Then build 4 waits with a worker that lets the first "take over" go by: the
 *      page counts a takeover only once it is seen, so a hide after its 10 s asks again and moves on, once, whole. Then
 *      build 5 takes over 3 s after it is asked: hidden, the page asks; shown again at once, the takeover lands on a
 *      VISIBLE page, which must not load again under the person's hands; the next hide loads it, once, whole.
 *   Every takeover on a hide (F, G, H) gets a second hide, after a show, when the first didn't move it within 10 s, as
 *   the app asks again the next time it is hidden; each must move on by the second hide at the latest (a worker slow
 *   to start once made F wait 30 s and go red, 1 run in 6). When one doesn't, its red says WHY: what the tab saw (its
 *   record of a hide's takeover, the waiting worker and its answer, the worker in charge, anything that makes it busy;
 *   every message the page sent a worker and every answer, timed; each worker's own build, state and work; and Chrome's
 *   own record of each worker's status, timed).
 *   A takeover is waited for on the page, never by asking the old worker (takeOver()), and a deploy is found by asking
 *   update() again when nothing comes (updateFinds()): both were the check's own reds under load (23 Nov), not the app's.
 * A first visit (no worker in control) never shows "Updating the app…" (C reads it too).
 *
 * Planted: SHELLB_PLANT=old builds every new build from the OLD code (its worker and guard): A, B and D go red (the
 * new page runs on the old modules, nothing said), F and G go red (the open page's lazy import gets the new build's copy),
 * and H goes red (no waiting: the old worker takes over at once, under the page's hands).
 * SHELLB_PLANT=once serves this tree's guard as it was before 22 Nov, recording a hide's takeover at the asking: H's
 * build 4 goes red (2: no hide asks again; its WHY shows the record and build 4 still waiting).
 * SHELLB_PLANT=no-skip: a hidden page never asks the waiting worker to take over: F goes red (no takeover by the second
 * hide), and the run stops there (build 2 never in charge of page one).
 * SHELLB_PLANT=reload-visible: the takeover a hide asked for loads the page whenever it lands, as before 23 Nov: H's
 * late takeover goes red (the page loads again while visible).
 *
 *   node scripts/shell_build_check.mjs        (through the queue: gate.mjs runs it)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchChrome } from "./lib/browser.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLANT = process.env.SHELLB_PLANT || "";
if (PLANT && !["old", "once", "no-skip", "reload-visible"].includes(PLANT)) throw new Error(`no such plant: ${PLANT}`);
const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8" }).trim();
// The OLD build A, B and D start from: the last build before one build per page (v150, rework 0f2eb2c3), the code a
// phone carries until it first opens the app on v151 or later. Not the landing's base: once one build per page was
// the base (22 Nov), "old" and "new" were both its code and A, B and D went red on every clone, testing nothing.
// SHELLB_OLD_REF names another; section 0 holds that it is code from before one build per page.
const PRE_ONE_BUILD = "0f2eb2c399681d774989f4855a5c0fc105abb0dd";
const OLD_REF = process.env.SHELLB_OLD_REF || PRE_ONE_BUILD;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// ── builds ──────────────────────────────────────────────────────────────────────────────────
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-shellb-"));
// What every build gets, whatever its code: a probe module that answers its build, in the precache; a page marker the
// probe compares against; and, on the two pages read here, a record of each load and of each run of the app's start.
const PROBE_HEAD = `<script>(function () { try { var n = JSON.parse(sessionStorage.getItem("probe.loads") || "[]"); n.push(location.pathname); sessionStorage.setItem("probe.loads", JSON.stringify(n)); } catch (e) {} })();</script>`;
const PROBE_RUN = `<script>(window.freshApp || function (f) { return Promise.resolve().then(f); })(function () { return import("/js/build-probe.js").then(function (m) {
  var page = (document.querySelector('meta[name="probe-build"]') || {}).content || "none";
  try { var r = JSON.parse(sessionStorage.getItem("probe.ran") || "[]"); r.push({ path: location.pathname, page: page, module: m.BUILD }); sessionStorage.setItem("probe.ran", JSON.stringify(r)); } catch (e) {}
}); });</script>`;
function make(name, { version, code, breakInstall = false, slowFirst = false, skipFirst = false, lateTake = false }) {
  const dir = path.join(WORK, name);
  if (code === "tree") execFileSync("cp", ["-c", "-R", path.join(REPO, "public"), dir]);
  else {
    const tmp = path.join(WORK, `${name}-x`);
    fs.mkdirSync(tmp);
    execFileSync("/bin/sh", ["-c", `git -C "${REPO}" archive ${OLD_REF} public | tar -x -C "${tmp}"`]);
    fs.renameSync(path.join(tmp, "public"), dir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const sw = path.join(dir, "sw.js");
  let s = fs.readFileSync(sw, "utf8");
  s = s.replace(/^const VERSION = "[^"]+";/m, `const VERSION = "${version}";`);
  s = s.replace(/^const CORE = \[\n/m, `const CORE = [\n  "/js/build-probe.js",\n${breakInstall ? '  "/js/no-such-file.js",\n' : ""}`);
  // slowFirst: the worker answers the first "which build are you?" 2.5 s late (past fresh-app's 1.5 s), at once after.
  if (slowFirst) {
    const ask = "if (e.ports && e.ports[0]) e.ports[0].postMessage({ version: VERSION });";
    if (!s.includes(ask)) throw new Error("slowFirst: the worker's version answer isn't where it was");
    s = s.replace(ask, "if (e.ports && e.ports[0]) { const port = e.ports[0], late = !self.__probeAnswered; self.__probeAnswered = true; "
      + "if (late) setTimeout(() => port.postMessage({ version: VERSION }), 2500); else port.postMessage({ version: VERSION }); }");
  }
  // skipFirst: the worker lets the first "take over" go by (as if it never arrived), and takes the next.
  if (skipFirst) {
    const take = 'if (msg.type === "app/skip-waiting") { self.skipWaiting(); return; }';
    if (!s.includes(take)) throw new Error("skipFirst: the worker's takeover isn't where it was");
    s = s.replace(take, 'if (msg.type === "app/skip-waiting") { if (!self.__probeSkipped) { self.__probeSkipped = true; return; } self.skipWaiting(); return; }');
  }
  // lateTake: the worker takes over 3 s after it is asked, as one does whose old worker was kept running in the instant
  // it was stopped (another tab's request) and is taken over only once that one goes idle.
  if (lateTake) {
    const take = 'if (msg.type === "app/skip-waiting") { self.skipWaiting(); return; }';
    if (!s.includes(take)) throw new Error("lateTake: the worker's takeover isn't where it was");
    s = s.replace(take, 'if (msg.type === "app/skip-waiting") { e.waitUntil(new Promise((ok) => setTimeout(() => { self.skipWaiting(); ok(); }, 3000))); return; }');
  }
  fs.writeFileSync(sw, s);
  fs.writeFileSync(path.join(dir, "js/build-probe.js"), `export const BUILD = ${JSON.stringify(version)};\n`);
  for (const page of fs.readdirSync(dir).filter((f) => f.endsWith(".html"))) {
    let h = fs.readFileSync(path.join(dir, page), "utf8");
    h = h.replace(/<meta name="wgp-build" content="[^"]*">/, `<meta name="wgp-build" content="${version}">`);
    h = h.replace(/(<meta charset="[^"]*">)/i, `$1<meta name="probe-build" content="${version}">${PROBE_HEAD}`);
    if (page === "login.html" || page === "index.html") h = h.replace(/<\/body>/i, `${PROBE_RUN}</body>`);
    // PLANT once: this tree's guard as it was before 22 Nov, recording a hide's takeover at the asking.
    if (PLANT === "once" && code === "tree" && h.includes("asked === v) return;")) h = h.replace("if (!v || busy() || asked === v) return;", "if (!v || busy() || !once(v)) return;");
    // PLANT no-skip: a hidden page never asks the waiting worker to take over (F, G and H go red).
    if (PLANT === "no-skip" && code === "tree") h = h.replace('          next.postMessage({ type: "app/skip-waiting" });', "");
    // PLANT reload-visible: the takeover a hide asked for loads the page again whenever it lands, shown or not, as before
    // 23 Nov (H's late takeover goes red).
    if (PLANT === "reload-visible" && code === "tree") h = h.replace('sw.addEventListener("controllerchange", function () { if (document.visibilityState === "hidden" && !busy()) location.reload(); });', 'sw.addEventListener("controllerchange", function () { location.reload(); });');
    fs.writeFileSync(path.join(dir, page), h);
  }
  return dir;
}

// ── the server: one build at a time, moved like a deploy ──────────────────────────────────
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };
const srv = { dir: "", offline: false, reports: [] };
const server = http.createServer((req, res) => {
  if (srv.offline) { req.socket.destroy(); return; }
  const url = new URL(req.url, "http://x");
  let p = decodeURIComponent(url.pathname);
  if (p === "/api/errors" && req.method === "POST") {
    let body = ""; req.on("data", (d) => { body += d; }); req.on("end", () => { try { srv.reports.push(JSON.parse(body)); } catch {} res.writeHead(204).end(); });
    return;
  }
  if (p.startsWith("/api/")) { res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end("{}"); return; }
  if (p === "/" || /^\/t\/[^/]+\/$/.test(p)) p = "/index.html";
  else if (p === "/login" || p === "/login/new") p = "/login.html";
  else if (p === "/trips") p = "/trips.html";
  const file = path.join(srv.dir, p);
  if (!file.startsWith(srv.dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { "Cache-Control": "no-store" }).end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ── a browser, its pages ──────────────────────────────────────────────────────────────────────
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.handlers = new Set(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cdp connect failed")); });
    const c = new CDP(ws);
    ws.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.id && c.waiting.has(m.id)) { const { res, rej, t } = c.waiting.get(m.id); clearTimeout(t); c.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else for (const h of c.handlers) h(m); };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { if (this.waiting.delete(id)) rej(new Error(`CDP timeout: ${method}`)); }, 60000);
      this.waiting.set(id, { res, rej, t }); this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
  close() { try { this.ws.close(); } catch {} }
}
async function browser({ app = "" } = {}) {
  const chrome = await launchChrome({ args: ["--disable-gpu", "--window-size=440,900", ...(app ? [`--app=${ORIGIN}${app}`] : [])] });
  const cdp = await CDP.connect(chrome.wsUrl);
  const tabs = [];
  // Every service worker's own word, for a red: its build, its state, and what it still has running (sw.js self.__busy).
  const workers = async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const out = [];
    for (const t of targetInfos.filter((x) => x.type === "service_worker")) {
      try {
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        const r = await cdp.send("Runtime.evaluate", { expression: `JSON.stringify({ build: typeof VERSION === "string" ? VERSION : null, state: self.serviceWorker ? self.serviceWorker.state : null, busy: [...(self.__busy || [])] })`, returnByValue: true }, sessionId);
        out.push(JSON.parse(r.result.value));
        await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      } catch (e) { out.push({ url: t.url.slice(-20), error: e.message.slice(0, 80) }); }
    }
    return out;
  };
  const attach = async (targetId) => {
    const { sessionId: S } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, S); await cdp.send("Runtime.enable", {}, S);
    if (!tabs.length) {
      cdp.handlers.add((m) => {
        if (m.method !== "ServiceWorker.workerVersionUpdated") return;
        for (const v of m.params.versions) {
          const now = `${v.status}/${v.runningStatus}`;
          if (swSeen.get(v.versionId) === now) continue;
          swSeen.set(v.versionId, now);
          SWLOG.push([Date.now() - T0, v.versionId, v.status, v.runningStatus]);
        }
      });
      await cdp.send("ServiceWorker.enable", {}, S).catch(() => {});
    }
    const tab = {
      S, targetId, workers,
      eval: async (expression) => { const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, S); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; },
      go: (p) => cdp.send("Page.navigate", { url: ORIGIN + p }, S),
    };
    tab.until = async (expr, what, ms = 30000) => {
      const end = Date.now() + ms; let last;
      for (;;) { try { last = await tab.eval(expr); if (last) return last; } catch (e) { last = e.message; } if (Date.now() > end) throw new Error(`timed out (${ms / 1000} s): ${what}; last: ${JSON.stringify(last)}`); await sleep(200); }
    };
    tab.records = async () => JSON.parse(await tab.eval(`JSON.stringify({ loads: JSON.parse(sessionStorage.getItem("probe.loads") || "[]"), ran: JSON.parse(sessionStorage.getItem("probe.ran") || "[]"), shown: !!document.querySelector('[data-shell="updating"]') })`));
    tab.forget = () => tab.eval(`(sessionStorage.removeItem("probe.loads"), sessionStorage.removeItem("probe.ran"), 1)`);
    // Hidden, as the app switched away: the page's own visibilitychange handlers run (fresh-app.js later()).
    tab.hide = () => tab.eval(`(document.activeElement && document.activeElement !== document.body && document.activeElement.blur(), Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }), document.dispatchEvent(new Event("visibilitychange")), 1)`);
    // Shown again, as the app switched back to: fresh-app.js does nothing on show.
    tab.show = () => tab.eval(`(Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }), document.dispatchEvent(new Event("visibilitychange")), 1)`);
    // What the page and its workers said to each other, for a red: each message the page sends a worker (its type, the
    // worker's state), each answer on a channel, and the registration's install road (found, installed, redundant), each
    // with its time (ms since the spy started). Kept in window.__spy; a new document starts without one.
    tab.spy = () => tab.eval(`(() => { if (window.__spy) return 1; const t0 = performance.now(); const log = window.__spy = []; const at = () => Math.round(performance.now() - t0);
      const post = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function (m, ...rest) { log.push([at(), "to " + this.state, m && m.type]); return post.call(this, m, ...rest); };
      const MC = window.MessageChannel;
      window.MessageChannel = function () { const c = new MC(); c.port1.addEventListener("message", (e) => log.push([at(), "answer", e.data && e.data.version])); return c; };
      document.addEventListener("visibilitychange", () => log.push([at(), "seen " + document.visibilityState]));
      navigator.serviceWorker.getRegistration().then((r) => { if (!r) return; r.addEventListener("updatefound", () => { const w = r.installing; log.push([at(), "found"]);
        if (w) w.addEventListener("statechange", () => log.push([at(), "worker " + w.state])); }); });
      navigator.serviceWorker.addEventListener("controllerchange", () => log.push([at(), "controllerchange"]));
      return 1; })()`);
    tab.shells = async () => (await tab.eval(`caches.keys().then((k) => JSON.stringify(k.filter((n) => n.startsWith("wegoplace-shell-")).map((n) => n.slice(16)).sort()))`)).replace(/[[\]"]/g, "").split(",").filter(Boolean);
    tabs.push(tab);
    return tab;
  };
  const first = await chrome.pageTarget();
  const tab1 = await attach(first.id);
  return {
    tab1,
    async newTab(p) { const { targetId } = await cdp.send("Target.createTarget", { url: ORIGIN + p }); return attach(targetId); },
    workers,
    async done() { cdp.close(); await chrome.close().catch(() => {}); },
  };
}
// A page that a worker of `build` controls, with that build's shell kept.
const controlled = (tab, build) => tab.until(`navigator.serviceWorker.controller && caches.has("wegoplace-shell-${build}").then((y) => y && document.readyState === "complete" ? 1 : 0)`, `a worker of ${build} in control`, 60000);
// The first visit installs the worker; then a load it controls, recorded from a clean slate (the first visit's own run
// lands first, so a late record can't count).
async function settle(tab, build, p = "/login") {
  await tab.go(p); await controlled(tab, build); await ranCount(tab, 1);
  await tab.forget();
  await tab.go(p); await ranCount(tab, 1);
  await tab.forget();
}
const ranCount = (tab, n) => tab.until(`JSON.parse(sessionStorage.getItem("probe.ran") || "[]").length >= ${n} ? 1 : 0`, `${n} app start(s) recorded`, 60000);
const mixed = (ran) => ran.filter((r) => r.page !== r.module);
// The new build found: waiting to be asked (this tree's worker), or already in charge (a worker that takes over on its
// own, as the old one does: the plant). Then hidden, the tab lets a waiting one take over.
const WORKER_IS = (build) => `new Promise((ok) => { const w = navigator.serviceWorker.controller; if (!w) return ok(""); const ch = new MessageChannel();
  ch.port1.onmessage = (e) => ok(String((e.data && e.data.version) || "")); w.postMessage({ type: "app/version" }, [ch.port2]); setTimeout(() => ok(""), 1500); }).then((v) => v === ${JSON.stringify(build)})`;
// Hidden, a page asks the waiting worker its build (fresh-app.js later(), 1.5 s to answer) and lets it take over. A
// worker slow to answer misses that hide, and the app asks again the next time it is hidden. So, as switching away
// twice would: hide; if it hasn't moved on within 10 s, show and hide again. It must move on by the second hide at the
// latest. Answers how many hides it took (0: not even by the second).
// When it doesn't move by the second hide, what the tab saw is kept for the red (WHY): its record of a hide's takeover,
// the waiting worker and what it answers, the worker in charge, and anything that makes the page busy.
let WHY = "";
// Chrome's own record of each worker (CDP ServiceWorker.workerVersionUpdated): [ms since the check started, version id,
// status, running status], one line per change. Read on a red: when the waiting one began to activate, if it did.
const T0 = Date.now();
const SWLOG = [];
const swSeen = new Map();
const swSince = (at) => SWLOG.filter((x) => x[0] >= at - T0);
async function hideUntilTaken(tab, done, what, firstMs = 10000) {
  const from = Date.now();
  for (let hides = 1; hides <= 2; hides++) {
    await tab.hide();
    try { await tab.until(done, what, hides === 1 ? firstMs : 30000); return hides; } catch {}
    if (hides === 1) { await tab.show(); await sleep(300); }
  }
  WHY = await tab.eval(`(async () => { const reg = await navigator.serviceWorker.getRegistration();
    const ask = (w) => new Promise((ok) => { if (!w) return ok(""); const ch = new MessageChannel(); const t = setTimeout(() => ok("(no answer in 5 s)"), 5000);
      ch.port1.onmessage = (e) => { clearTimeout(t); ok(String(e.data && e.data.version)); }; w.postMessage({ type: "app/version" }, [ch.port2]); });
    return JSON.stringify({ record: sessionStorage.getItem("wgp.shell.hidden"), seen: document.visibilityState, online: navigator.onLine,
      inCharge: await ask(navigator.serviceWorker.controller), waiting: reg && reg.waiting ? [reg.waiting.state, await ask(reg.waiting)] : null,
      installing: reg && reg.installing ? reg.installing.state : null, dialog: !!document.querySelector('[role="dialog"][aria-modal="true"]'),
      focus: document.activeElement && document.activeElement.tagName,
      changed: [...document.querySelectorAll("input, textarea")].filter((f) => !/^(hidden|checkbox|radio|button|submit|reset|file|range|color|image)$/i.test(f.type || "") && f.value !== f.defaultValue).map((f) => f.name || f.id || f.type),
      at: location.pathname, spy: window.__spy || null }); })()`).catch((e) => `(the tab couldn't say: ${e.message})`);
  WHY += ` WORKERS ${JSON.stringify(await (tab.workers ? tab.workers() : []).catch((e) => e.message))} CHROME ${JSON.stringify(swSince(from))}`;
  // And what Chrome says in the 20 s after this red, once nothing here is asking the workers anything.
  const after = Date.now();
  setTimeout(() => console.log(`  AFTER (${what}): ${JSON.stringify(swSince(after))}`), 20000);
  console.log(`  WHY (${what}, no takeover by the second hide): ${WHY}`);
  return 0;
}
const hidesSaid = (n) => `hides: ${n}${n ? "" : `; WHY ${WHY}`}`;
// The new build deployed, then found: update() asked, and asked again when nothing comes within 20 s (three times at most).
// A reload just before starts Chrome's own update check; one still queued when the server moves on is joined by an
// update() asked then, and that job read the old sw.js: nothing is found (H, 1 run in 16 under load, 23 Nov). A phone
// finds it at its next check; so does this. Each try that finds nothing says so, with what Chrome said last.
async function updateFinds(tab, what, accept = "r && r.waiting ? 1 : 0") {
  for (let i = 1; i <= 3; i++) {
    const said = await tab.eval(`navigator.serviceWorker.getRegistration().then((r) => r.update()).then(() => "resolved", (e) => "REJECTED " + e.message)`);
    try { await tab.until(`navigator.serviceWorker.getRegistration().then((r) => ${accept})`, what, 20000); return i; } catch {}
    console.log(`  (${what}: nothing after update() ${i}, ${said}; Chrome last said ${JSON.stringify(SWLOG.slice(-6))})`);
  }
  return 0;
}
// Waited for on the PAGE (it loads again onto the new build, or its controller changes), then the worker asked its build
// once. Never a message to the old worker while it is being replaced: one arriving in the instant Chrome stops it for the
// takeover starts it again, and the takeover then waits until that worker goes idle, which a question every 200 ms
// never let it do (G, 1 run in 8 under load: activation only once the check stopped asking, 23 Nov).
async function takeOver(tab, build) {
  await tab.spy();
  await updateFinds(tab, `${build} waiting or in charge`, `r && r.waiting ? 1 : ${WORKER_IS(build)}.then((y) => y ? 1 : 0)`);
  const marker = await tab.eval(`(window.__beforeHide = Math.random().toString(36).slice(2))`);
  const hides = await hideUntilTaken(tab, `(window.__beforeHide !== ${JSON.stringify(marker)} || (window.__spy || []).some((x) => x[1] === "controllerchange")) && document.readyState === "complete" ? 1 : 0`, `${build} in charge`);
  if (hides && !(await tab.until(`${WORKER_IS(build)}.then((y) => y ? 1 : 0)`, `${build} in charge, asked once`, 15000).then(() => 1, () => 0))) {
    console.log(`  (${build}: the page moved, but the worker in charge isn't ${build})`);
    return 0;
  }
  return hides;
}
const NEW = PLANT === "old" ? "old" : "tree";

try {
  section("0. the old build A, B and D start from");
  {
    const said = git("log", "-1", "--format=%h %s", OLD_REF);
    const oldSw = git("show", `${OLD_REF}:public/sw.js`);
    console.log(`  old build: ${OLD_REF.slice(0, 8)} (${process.env.SHELLB_OLD_REF ? "SHELLB_OLD_REF" : "pinned: the last build before one build per page"})`);
    check("it is code from before one build per page (its worker keeps no page-to-build map)", !oldSw.includes("wegoplace-pages"), said.slice(0, 120));
  }

  const A = make("A", { version: "v9001", code: "old" });
  const B = make("B", { version: "v9002", code: NEW });
  const Bbroken = make("Bx", { version: "v9002", code: NEW, breakInstall: true });
  const C1 = make("C1", { version: "v9011", code: "tree" });
  const F1 = make("F1", { version: "v9021", code: NEW });
  const F2 = make("F2", { version: "v9022", code: NEW });
  const F3 = make("F3", { version: "v9023", code: NEW });
  const H1 = make("H1", { version: "v9031", code: "tree" });
  const H2 = make("H2", { version: "v9032", code: NEW });
  const H3 = make("H3", { version: "v9033", code: NEW, slowFirst: true });
  const H4 = make("H4", { version: "v9034", code: NEW, skipFirst: true });
  const H5 = make("H5", { version: "v9035", code: NEW, lateTake: true });

  section("A. a phone on the old code (v150), this build deployed (a browser tab, the sign-in page)");
  {
    srv.dir = A;
    const b = await browser();
    const t = b.tab1;
    await settle(t, "v9001");
    srv.dir = B;
    await t.go("/login");
    await t.until(`(JSON.parse(sessionStorage.getItem("probe.ran") || "[]").slice(-1)[0] || {}).page === "v9002" && JSON.parse(sessionStorage.getItem("probe.ran") || "[]").slice(-1)[0].module === "v9002" ? 1 : 0`, "the new build running whole", 60000).catch(() => {});
    await sleep(3000);
    const r = await t.records();
    check("the new page never ran on the old worker's modules", r.ran.length > 0 && mixed(r.ran).length === 0, JSON.stringify(r.ran));
    check("it ends on the new build, whole", JSON.stringify(r.ran.slice(-1)[0]) === JSON.stringify({ path: "/login", page: "v9002", module: "v9002" }), JSON.stringify(r.ran.slice(-1)));
    check("after exactly one reload", r.loads.filter((p) => p === "/login").length === 2, JSON.stringify(r.loads));
    await b.done();
  }

  section("B. a mismatch that never resolves: one reload, then it runs and says so once");
  {
    srv.dir = A; srv.reports = [];
    const b = await browser();
    const t = b.tab1;
    await settle(t, "v9001");
    srv.dir = Bbroken;
    await t.go("/login");
    await ranCount(t, 1).catch(() => {});
    await sleep(25000);                       // past the guard's own wait, and any second reload it might try
    const r = await t.records();
    const said = srv.reports.filter((x) => x.name === "ShellMismatch");
    check("one reload at most", r.loads.filter((p) => p === "/login").length <= 2, JSON.stringify(r.loads));
    check("then the page runs (as it is)", r.ran.length === 1, JSON.stringify(r.ran));
    check(`and says so once: "shell mismatch after reload"`, said.length === 1 && /shell mismatch after reload/.test(said[0].message), JSON.stringify(srv.reports));
    await b.done();
  }

  section("C. no connection: the worker's own page and modules, no reload, nothing said");
  {
    srv.dir = C1; srv.offline = false;
    const b = await browser();
    const t = b.tab1;
    await t.go("/login");
    const first = await t.eval(`(navigator.serviceWorker.controller ? "controlled" : "first") + (document.querySelector('[data-shell="updating"]') ? " updating" : "")`);
    check(`a first visit never says "Updating the app…"`, !/updating/.test(first), first);
    await controlled(t, "v9011"); await ranCount(t, 1);
    await t.forget();
    await t.go("/login"); await ranCount(t, 1);
    await t.forget();
    srv.dir = B; srv.offline = true;
    await t.go("/login");
    await ranCount(t, 1).catch(() => {});
    await sleep(3000);
    const r = await t.records();
    srv.offline = false;
    check("the worker's own build runs, whole", r.ran.length === 1 && r.ran[0].page === "v9011" && r.ran[0].module === "v9011", JSON.stringify(r.ran));
    check(`no reload, and "Updating the app…" never shown`, r.loads.length === 1 && !r.shown, JSON.stringify(r));
    await b.done();
  }

  section("D. A's case as the installed app (display-mode standalone), on the app's own page");
  {
    srv.dir = A;
    const b = await browser({ app: "/t/x/" });
    const t = b.tab1;
    check("an app window", await t.until(`matchMedia("(display-mode: standalone)").matches ? 1 : 0`, "display-mode standalone", 15000).then(() => true, () => false));
    await controlled(t, "v9001"); await ranCount(t, 1);
    await t.forget();
    await t.go("/t/x/"); await ranCount(t, 1);
    await t.forget();
    srv.dir = B;
    await t.go("/t/x/");
    await t.until(`JSON.parse(sessionStorage.getItem("probe.ran") || "[]").some((r) => r.path === "/t/x/" && r.page === "v9002" && r.module === "v9002") ? 1 : 0`, "the app's page on the new build", 60000).catch(() => {});
    await sleep(3000);
    const r = await t.records();
    const app = r.ran.filter((x) => x.path === "/t/x/");
    check("the app's new page never ran on the old modules", app.length > 0 && mixed(app).length === 0, JSON.stringify(app));
    check("it ends on the new build after exactly one reload", JSON.stringify(app.slice(-1)[0]) === JSON.stringify({ path: "/t/x/", page: "v9002", module: "v9002" })
      && r.loads.filter((p) => p === "/t/x/").length === 2, JSON.stringify(r));
    await b.done();
  }

  section("F + G. open across takeovers: two tabs, three builds in a row");
  {
    srv.dir = F1;
    const b = await browser();
    const one = b.tab1;
    await settle(one, "v9021");
    // build 2 deployed; another tab finds it, and takes it when hidden
    srv.dir = F2;
    const two = await b.newTab("/login");
    await ranCount(two, 1);
    const hidesF = await takeOver(two, "v9022");
    check("F. the waiting build 2 took over by the second hide at the latest", hidesF === 1 || hidesF === 2, hidesSaid(hidesF));
    await one.until(`${WORKER_IS("v9022")}.then((y) => y ? 1 : 0)`, "build 2 in charge of page one", 30000);
    await sleep(1500);
    const lazy = await one.eval(`import("/js/build-probe.js?lazy=" + Date.now()).then((m) => m.BUILD)`);
    check("F. the open page of build 1, after build 2 took over: its lazy import is build 1's (never build 2's on build 1's page)", lazy === "v9021",
      lazy === "v9022" ? "got build 2's: the worker didn't answer this page from its own build's cache (its build unknown to it, or that cache gone)" : lazy);
    // build 3, the same way, while page one (build 1) stays open
    srv.dir = F3;
    await sleep(500);
    const hidesG = await takeOver(two, "v9023");
    check("G. the waiting build 3 took over by the second hide at the latest", hidesG === 1 || hidesG === 2, hidesSaid(hidesG));
    await two.until(`(document.querySelector('meta[name="probe-build"]') || {}).content === "v9023" ? 1 : 0`, "tab two on build 3", 60000).catch(() => {});
    if (hidesG !== 1 && hidesG !== 2) console.log(`  G LATER: tab two on build 3 by ${Date.now() - T0} ms; Chrome, every change: ${JSON.stringify(SWLOG)}`);
    await sleep(2500);
    const kept = await one.shells();
    check("G. three builds in a row, a page of build 1 still open: only build 1's shell and build 3's remain", JSON.stringify(kept) === JSON.stringify(["v9021", "v9023"]), JSON.stringify(kept));
    // the 24-hour bound: build 1 retired a day and an hour ago goes even with its page open
    await one.eval(`caches.open("wegoplace-pages").then(async (c) => { const k = location.origin + "/__wgp/pages"; const r = await c.match(k); const m = r ? await r.json() : { pages: {}, retired: {} };
      m.retired.v9021 = Date.now() - 25 * 3600 * 1000; await c.put(k, new Response(JSON.stringify(m), { headers: { "Content-Type": "application/json" } })); return 1; })`);
    await two.eval(`(navigator.serviceWorker.controller.postMessage({ type: "app/page-build", build: "v9023" }), 1)`);
    await sleep(1500);
    const day = await one.shells();
    check("G. a shell retired more than 24 hours ago goes even while its page is open", JSON.stringify(day) === JSON.stringify(["v9023"]), JSON.stringify(day));
    // the open page, hidden: it loads again onto the current build
    await one.forget();
    await one.hide();
    await one.until(`(document.querySelector('meta[name="probe-build"]') || {}).content === "v9023" ? 1 : 0`, "tab one on build 3", 30000).catch(() => {});
    await sleep(1500);
    const r = await one.records();
    check("F. the open page, hidden, loads again onto the current build, once", r.loads.length === 1 && JSON.stringify(r.ran.slice(-1)[0]) === JSON.stringify({ path: "/login", page: "v9023", module: "v9023" }), JSON.stringify(r));
    await b.done();
  }

  section("H. hidden with an update waiting: it moves on while hidden, never on show; never with typed words");
  {
    srv.dir = H1;
    const b = await browser();
    const t = b.tab1;
    await settle(t, "v9031");
    srv.dir = H2;
    await t.spy();
    await updateFinds(t, "build 2 waiting");
    // First with typed words in a field: hidden, nothing moves.
    await t.eval(`(() => { const f = [...document.querySelectorAll("input")].find((i) => /^(text|search|email)$/.test(i.type)); if (f) { f.value = "half-typed"; } return f ? 1 : 0; })()`);
    await t.forget();
    await t.hide();
    await sleep(4000);
    const stayed = await t.eval(`JSON.stringify({ page: (document.querySelector('meta[name="probe-build"]') || {}).content, loads: JSON.parse(sessionStorage.getItem("probe.loads") || "[]").length })`);
    check("H. with typed words in a field, hidden: no takeover, no reload", stayed === JSON.stringify({ page: "v9031", loads: 0 }), stayed);
    // Then with nothing unsent (a fresh load of the same page), hidden: it moves while hidden.
    await t.go("/login"); await ranCount(t, 1);
    await t.forget();
    const marker = await t.eval(`(window.__beforeHide = Math.random().toString(36).slice(2))`);
    // No show is sent after the hide that moves it: the page is still "hidden" when the new document arrives.
    const hidesH = await hideUntilTaken(t, `window.__beforeHide !== ${JSON.stringify(marker)} && document.readyState === "complete" ? 1 : 0`, "a new document while hidden");
    check("H. it moved on by the second hide at the latest", hidesH === 1 || hidesH === 2, hidesSaid(hidesH));
    await ranCount(t, 1).catch(() => {});
    await sleep(1500);
    const r = await t.records();
    check("H. hidden with build 2 waiting and nothing unsent: it loaded again while hidden, once", r.loads.length === 1, JSON.stringify(r.loads));
    check("H. the screen shown next is build 2, whole (never a half-old one)", r.ran.length >= 1 && mixed(r.ran).length === 0 && r.ran.slice(-1)[0].page === "v9032", JSON.stringify(r.ran));
    // Then a worker slow to answer: build 3, waiting, answers the first hide's "which build?" too late, so that hide
    // lets it be; the next hide (after a show, as switching back and away again) moves on. Never on the show, once.
    srv.dir = H3;
    await t.spy();
    await updateFinds(t, "build 3 waiting");
    await t.forget();
    const marker3 = await t.eval(`(window.__beforeHide = Math.random().toString(36).slice(2))`);
    const hidesS = await hideUntilTaken(t, `window.__beforeHide !== ${JSON.stringify(marker3)} && document.readyState === "complete" ? 1 : 0`, "build 3 after a late answer");
    await ranCount(t, 1).catch(() => {});
    await sleep(1500);
    const r3 = await t.records();
    check("H. a worker that answers the first hide late: it moves on at the second hide, once (never at the first, never on the show)", hidesS === 2 && r3.loads.length === 1, `${hidesSaid(hidesS)}; loads ${JSON.stringify(r3.loads)}`);
    check("H. and the screen shown next is build 3, whole", r3.ran.length >= 1 && mixed(r3.ran).length === 0 && r3.ran.slice(-1)[0].page === "v9033", JSON.stringify(r3.ran));
    // Then a takeover asked for that doesn't follow: build 4, waiting, lets the first "take over" go by. The page counts a
    // takeover only once it is seen, so a hide after its 10 s asks again, and that one moves it. (Counted at the asking,
    // as before 22 Nov, no hide in that tab asked again: SHELLB_PLANT=once.)
    srv.dir = H4;
    await t.spy();
    await updateFinds(t, "build 4 waiting");
    await t.forget();
    const marker4 = await t.eval(`(window.__beforeHide = Math.random().toString(36).slice(2))`);
    const hidesK = await hideUntilTaken(t, `window.__beforeHide !== ${JSON.stringify(marker4)} && document.readyState === "complete" ? 1 : 0`, "build 4 after a takeover that didn't follow", 12000);
    await ranCount(t, 1).catch(() => {});
    await sleep(1500);
    const r4 = await t.records();
    check("H. a takeover asked for that didn't follow is asked for again on the next hide, and moves it, once", hidesK === 2 && r4.loads.length === 1, `${hidesSaid(hidesK)}; loads ${JSON.stringify(r4.loads)}`);
    check("H. and the screen shown next is build 4, whole", r4.ran.length >= 1 && mixed(r4.ran).length === 0 && r4.ran.slice(-1)[0].page === "v9034", JSON.stringify(r4.ran));
    // Then a takeover that comes late: build 5 takes over 3 s after it is asked. Hidden, the page asks; shown again at
    // once (the person back), the takeover lands while it is visible, and it must not load again under their hands (it
    // did, whenever it landed, until 23 Nov: SHELLB_PLANT=reload-visible). The next hide loads it, once, whole.
    srv.dir = H5;
    await t.spy();
    await updateFinds(t, "build 5 waiting");
    await t.forget();
    const marker5 = await t.eval(`(window.__beforeHide = Math.random().toString(36).slice(2))`);
    await t.hide();
    const asked5 = await t.until(`(window.__spy || []).some((x) => x[2] === "app/skip-waiting") ? 1 : 0`, "the page asked build 5 to take over", 10000).then(() => 1, () => 0);
    await t.show();
    const landed5 = await t.until(`(window.__spy || []).some((x) => x[1] === "controllerchange") ? 1 : 0`, "build 5's late takeover", 30000).then(() => 1, () => 0);
    await sleep(2000);
    const vis5 = JSON.parse(await t.eval(`JSON.stringify({ same: window.__beforeHide === ${JSON.stringify(marker5)}, seen: document.visibilityState, loads: JSON.parse(sessionStorage.getItem("probe.loads") || "[]").length })`).catch(() => '{"same":false}'));
    check("H. a takeover that lands after the page is shown again: no load under the person's hands", asked5 === 1 && landed5 === 1 && vis5.same === true && vis5.loads === 0,
      JSON.stringify({ asked: asked5, landed: landed5, ...vis5 }));
    const hides5 = await hideUntilTaken(t, `window.__beforeHide !== ${JSON.stringify(marker5)} && document.readyState === "complete" ? 1 : 0`, "build 5 at the next hide");
    await ranCount(t, 1).catch(() => {});
    await sleep(1500);
    const r5 = await t.records();
    check("H. and the next hide loads it, once, whole: build 5", hides5 === 1 && r5.loads.length === 1 && r5.ran.length >= 1 && mixed(r5.ran).length === 0 && r5.ran.slice(-1)[0].page === "v9035",
      `${hidesSaid(hides5)}; ${JSON.stringify(r5)}`);
    await b.done();
  }
} catch (e) {
  fail++; failures.push(`threw: ${e.message}`); console.log(`  FAIL  threw: ${e.stack || e}`);
} finally {
  server.close();
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  FAILED  ${f}`); process.exit(1); }
process.exit(0);

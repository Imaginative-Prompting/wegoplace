#!/usr/bin/env node
/* A SERVER THAT TAKES A REQUEST AND NEVER ANSWERS (a captive portal, one bar in a valley), and the
 * service worker's time limits on everything it answers.
 *
 * Chrome needs the Bash sandbox disabled, and the launcher (scripts/lib/browser.mjs) starts it
 * only through the queue:
 *   WGP_BASE=http://localhost:<port> python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node scripts/sw_limits_check.mjs
 *
 * The browser talks to the app through a small server of this check's own (an ephemeral port on
 * this machine), which passes everything through to WGP_BASE until it is told to take a path and
 * hold it: the request is accepted, read, and never answered, and the connection stays open
 * until the browser closes it. The real worker is installed through it, and then:
 *
 *   1. A PAGE ONLY THE SERVER MAKES ("/account"), held: the worker answers after LIMIT_PAGE with
 *      its page in words ("No connection right now", the way back to Your trips first), not
 *      sooner (it did wait for the server) and not much later. That way back, with "/trips"
 *      held too, is Your trips from the phone's own copy, drawn, inside NAV_TIMEOUT and a bit.
 *   2. NOTHING KEPT: the cached sign-in page taken out of the cache, "/login/new" held: the
 *      worker's words that it hasn't finished installing, after LIMIT_PAGE, not a blank page.
 *   3. FILES THE CACHES DON'T HOLD, held: a module, a photograph, a town, map furniture, a range
 *      of the map's archive, a range of a video, a whole video, a range of any other file. Each
 *      request the page made is over after LIMIT_MISS (refused, or the worker's 504 for a video),
 *      not sooner and not much later, and each held connection was closed by the browser by
 *      then: nothing is left open on the line.
 *   4. AN UPDATE WHILE A REQUEST IS HELD: a new worker that has installed takes over once that
 *      request has been given up, inside LIMIT_MISS and a bit, never left waiting behind it.
 *
 *   node scripts/gate.mjs --only sw_limits_check
 *
 * 2b. A SIGN-IN COMING BACK FROM GITHUB, held: the worker lets it through (no limit, no words page), as /api/;
 *      SWLIMITS_PLANT=callback (the worker without that line) answers it with its words at LIMIT_PAGE: red.
 *
 * PLANTED (16 Nov): SWLIMITS_PLANT=1 serves the worker with both limits made ten minutes long
 * (rewritten by this check's server as it passes sw.js through): 12 red, every step above, each
 * one still waiting when this check stops looking (the update "installed", then still waiting 80 s
 * on); green only the install and that the server really took "/account".
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { BASE, REPO, appSettled, boot, evalIn, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { tripPath } from "./lib/gate_trip.mjs";

const SW = fs.readFileSync(path.join(REPO, "public/sw.js"), "utf8");
const num = (name) => Number((new RegExp(`^const ${name} = (\\d+);`, "m").exec(SW) || [])[1]);
const NAV_TIMEOUT = num("NAV_TIMEOUT"), LIMIT_PAGE = num("LIMIT_PAGE"), LIMIT_MISS = num("LIMIT_MISS");
const VERSION = (/^const VERSION = "(v\d+)"/m.exec(SW) || [])[1];
// SWLIMITS_PLANT=1: both limits ten minutes long. SWLIMITS_PLANT=callback: the worker without its line letting
// Google's and GitHub's sign-in through (2b goes red).
const PLANT_CALLBACK = process.env.SWLIMITS_PLANT === "callback";
const PLANT = !!process.env.SWLIMITS_PLANT;
const LATE = 4000;                        // how far past a limit an answer may come
const LOOK = 15000;                       // how far past a limit this check looks before it stops
const TRIP = tripPath();

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + detail : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// ── the server in between ─────────────────────────────────────────────────────────────────────
const up = new URL(BASE);
let ORIGIN = "";                          // this server's own address, once it listens
// The app's server takes a request whose Origin isn't its own address as another site's, so on the
// way through, the request is made to look as the browser would send it to the app directly, and a
// redirect back to the app's address is pointed here again.
const inward = (h, plain = false) => {
  const o = { ...h, host: up.host };
  if (plain) delete o["accept-encoding"];   // a body this server rewrites comes uncompressed
  if (o.origin === ORIGIN) o.origin = up.origin;
  if (o.referer && o.referer.startsWith(ORIGIN)) o.referer = up.origin + o.referer.slice(ORIGIN.length);
  return o;
};
const outward = (h) => (h.location && h.location.startsWith(up.origin) ? { ...h, location: ORIGIN + h.location.slice(up.origin.length) } : h);
const holding = [];                       // path prefixes taken and never answered
const held = [];                          // { path, at, closed }: every request held, and when its connection closed
const sockets = new Set();
const holds = (p) => holding.some((h) => p.startsWith(h));
// The end of a step: nothing more is held, and a navigation's held connection (the one request the
// worker stops waiting for without closing it) is let go, so it can't take a later step's place
// among the six connections the browser opens to one server.
const release = () => { holding.length = 0; for (const h of held) if (!h.closed) h.socket.destroy(); };
const server = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (holds(p)) {
    const h = { path: p, at: Date.now(), closed: 0, socket: req.socket };
    held.push(h);
    req.socket.once("close", () => { h.closed = Date.now(); });
    req.resume();                         // read it all, answer nothing
    return;
  }
  const out = http.request({ host: up.hostname, port: up.port, method: req.method, path: req.url, headers: inward(req.headers, PLANT && p === "/sw.js") }, (r) => {
    const plant = PLANT && /^\/sw\.js$/.test(p) && r.statusCode === 200;
    if (!plant) { res.writeHead(r.statusCode, outward(r.headers)); r.pipe(res); return; }
    const parts = [];
    r.on("data", (c) => parts.push(c));
    r.on("end", () => {
      const text = Buffer.concat(parts).toString("utf8");
      const body = PLANT_CALLBACK ? text.replace(/^ *if \(\/\^\\\/login\\\/\(google\|github\).*$/m, "")
        : text.replace(/^const LIMIT_PAGE = \d+;/m, "const LIMIT_PAGE = 600000;").replace(/^const LIMIT_MISS = \d+;/m, "const LIMIT_MISS = 600000;");
      const headers = { ...r.headers, "content-length": String(Buffer.byteLength(body)) };
      delete headers["content-encoding"]; delete headers["transfer-encoding"];
      res.writeHead(r.statusCode, headers); res.end(body);
    });
  });
  out.on("error", () => { try { res.writeHead(502); res.end(); } catch { /* gone */ } });
  req.pipe(out);
});
server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
// The app's live updates: a WebSocket, passed through as bytes.
server.on("upgrade", (req, sock, head) => {
  const o = net.connect(Number(up.port), up.hostname, () => {
    o.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(inward(req.headers)).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    if (head.length) o.write(head);
    sock.pipe(o); o.pipe(sock);
  });
  o.on("error", () => sock.destroy()); sock.on("error", () => o.destroy());
});

const run = async () => {
  if (!NAV_TIMEOUT || !LIMIT_PAGE || !LIMIT_MISS || !VERSION) throw new Error("could not read NAV_TIMEOUT, LIMIT_PAGE, LIMIT_MISS and VERSION out of public/sw.js");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  ORIGIN = `http://localhost:${server.address().port}`;
  if (PLANT) console.log("PLANTED: the worker is served with both limits ten minutes long");
  const b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: true });
  const { cdp, S } = b;
  try {
    await cdp.send("Network.setBypassServiceWorker", { bypass: false }, S);
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: false }, S);
    // The window is signed in at the app's address; this browser keeps a cookie to the port it was
    // set on, so the same session is given to this server's address too.
    const { cookies } = await cdp.send("Network.getCookies", { urls: [BASE] }, S);
    for (const c of cookies) await cdp.send("Network.setCookie", { url: ORIGIN, name: c.name, value: c.value, httpOnly: c.httpOnly, sameSite: c.sameSite || "Lax" }, S);
    console.log(`signed in here as at the app's address: ${cookies.map((c) => c.name).join(", ") || "NO COOKIES"}`);

    // What is on screen: which page, its heading, its links.
    const WHAT = `JSON.stringify({
      path: location.pathname,
      h1: (document.querySelector("h1") || {}).textContent || "",
      text: (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 160),
      links: [...document.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent.trim()]),
      shell: !!document.getElementById("view") && !!document.querySelector(".tabbar"),
      trips: [...document.scripts].some((s) => s.src.includes("/js/trips.js") || s.textContent.includes('import("/js/trips.js")')),
      drawn: !!document.getElementById("list") && !!document.getElementById("page") && !document.getElementById("page").hidden,
    })`;
    // Go to a path, not waiting on the navigation itself (a held one may never come back), and
    // say what arrived and after how long; null when nothing had arrived by `cap` ms.
    const go = async (p, cap) => {
      await cdp.send("Page.navigate", { url: "about:blank" }, S);
      await sleep(150);
      const t0 = Date.now();
      cdp.send("Page.navigate", { url: ORIGIN + p }, S).catch(() => {});
      while (Date.now() - t0 < cap) {
        try {
          if (await evalIn(cdp, S, `location.origin === ${JSON.stringify(ORIGIN)} && document.readyState !== "loading" ? 1 : 0`))
            return { ms: Date.now() - t0, ...JSON.parse(await evalIn(cdp, S, WHAT)) };
        } catch { /* between documents */ }
        await sleep(100);
      }
      return null;
    };
    const say = (r) => r ? `${r.ms} ms · ${r.path} · "${r.h1}" · ${r.text} · links ${JSON.stringify(r.links)}` : "nothing had arrived";

    section(`0. the real worker (${VERSION}), installed through a server that can hold a request`);
    await cdp.send("Page.navigate", { url: ORIGIN + TRIP }, S);
    await waitFor(cdp, S, `location.origin === ${JSON.stringify(ORIGIN)} && navigator.serviceWorker.controller ? 1 : 0`, { timeout: 60000, label: "a service worker taking control" });
    await appSettled(cdp, S, { timeout: 60000 });
    const kept = await waitFor(cdp, S, `(async () => {
      const c = await caches.open("wegoplace-shell-${VERSION}").catch(() => null);
      if (!c) return 0;
      const a = await c.match(location.origin + "/"), l = await c.match(location.origin + "/login"), t = await c.match(location.origin + "/trips");
      return a && l && t ? 1 : 0;
    })()`, { timeout: 60000, label: 'the shell cache holding "/", "/login" and "/trips"' });
    check(`the worker is in control, its cache holding the app, the sign-in page and Your trips (limits: page ${LIMIT_PAGE} ms, a miss ${LIMIT_MISS} ms)`, !!kept);

    section(`1. a page only the server makes, held: the words after ${LIMIT_PAGE} ms`);
    holding.push("/account", "/trips");
    const a = await go("/account", LIMIT_PAGE + LOOK);
    check(`"/account" is the worker's page in words after ${LIMIT_PAGE} ms (not sooner, at most ${LATE} ms later): "No connection right now", the way back to Your trips first`,
      a && a.ms >= LIMIT_PAGE - 300 && a.ms <= LIMIT_PAGE + LATE && /No connection right now/.test(a.h1) && !a.shell
        && a.links.length && a.links[0][0] === "/trips", say(a));
    check('the server really took "/account" and never answered', held.some((h) => h.path === "/account"), held.map((h) => h.path).join(" · ") || "nothing held");
    let t = null;
    if (a && a.links.length) {
      const at = JSON.parse(await evalIn(cdp, S, `JSON.stringify((() => { const r = document.querySelector("a").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })())`));
      const t0 = Date.now();
      for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, S);
      while (Date.now() - t0 < LIMIT_PAGE + LOOK) {
        try {
          const r = JSON.parse(await evalIn(cdp, S, `location.pathname === "/trips" && document.readyState !== "loading" ? ${WHAT} : "null"`));
          if (r && r.drawn) { t = { ms: Date.now() - t0, ...r }; break; }
        } catch { /* between documents */ }
        await sleep(100);
      }
    }
    check(`its "Back to your trips", with "/trips" held too, is Your trips from the phone's copy, drawn, inside ${NAV_TIMEOUT + LATE} ms`,
      t && t.trips && t.drawn && !t.shell && t.ms <= NAV_TIMEOUT + LATE, t ? `${t.ms} ms · ${t.path} · ${t.text}` : "Your trips never drew");
    release();

    section(`2. nothing kept: the words that it hasn't finished installing, after ${LIMIT_PAGE} ms`);
    await evalIn(cdp, S, `caches.open("wegoplace-shell-${VERSION}").then((c) => c.delete(location.origin + "/login"))`);
    holding.push("/login");
    const n = await go("/login/new", LIMIT_PAGE + LOOK);
    check(`"/login/new" with no copy kept is the worker's page in words after ${LIMIT_PAGE} ms, saying it hasn't finished installing, with a way to try again`,
      n && n.ms >= LIMIT_PAGE - 300 && n.ms <= LIMIT_PAGE + LATE && /installing/i.test(n.text) && n.links.some(([, w]) => /try again/i.test(w)), say(n));
    release();

    // Google's or GitHub's callback: the server answers only once it has asked the provider, and may have signed
    // the person in by then, so the worker leaves it to the browser: no time limit, no page in words.
    section(`2b. a sign-in coming back from GitHub, held past ${LIMIT_PAGE} ms: the worker doesn't answer it`);
    holding.push("/login/github/callback");
    const cb = await go("/login/github/callback?code=limits-check&state=limits-check", LIMIT_PAGE + LATE + 2000);
    const took = held.some((h) => h.path.startsWith("/login/github/callback"));
    check(`a callback held past ${LIMIT_PAGE} ms is still the server's to answer (no worker's words; the server took it)`, !cb && took, cb ? say(cb) : `nothing drawn after ${LIMIT_PAGE + LATE + 2000} ms; held: ${took}`);
    release();

    section(`3. files the caches don't hold, held: each over after ${LIMIT_MISS} ms, its connection closed (three at a time)`);
    const back = await go(TRIP, 30000);
    if (!back || !back.shell) throw new Error(`the trip did not open again: ${say(back)}`);
    await appSettled(cdp, S, { timeout: 30000 });
    const MISSES = [
      ["a module", "/js/limits-missing.js", {}],
      ["a photograph", "/img/limits-missing.webp", {}],
      ["a town", "/towns/limits-missing.json", {}],
      ["map furniture", "/tiles/limits-missing.pbf", {}],
      ["a range of the map's archive", "/tiles/limits-missing.pmtiles", { headers: { Range: "bytes=0-99" } }],
      ["a range of a video", "/media/limits-missing-a", { headers: { Range: "bytes=0-99" } }],
      ["a whole video", "/media/limits-missing-b", {}],
      ["a range of any other file", "/vendor/limits-missing.bin", { headers: { Range: "bytes=0-9" } }],
    ];
    holding.push(...MISSES.map(([, p]) => p));
    // Three at a time, one look each (a look that waited for all of them could outlast the browser
    // connection's own wait for an answer), each three judged before the next go: a connection still
    // open by then is let go, so it can't keep a later request from the server.
    for (let i = 0; i < MISSES.length; i += 3) {
      const since = held.length;
      const got = JSON.parse(await evalIn(cdp, S, `(async () => {
        const ask = async ([name, url, init]) => {
          const t0 = performance.now();
          const asked = fetch(url, init).then((r) => ({ status: r.status }), (e) => ({ error: String(e && e.message || e).slice(0, 80) }));
          const r = await Promise.race([asked, new Promise((ok) => setTimeout(() => ok({ still: true }), ${LIMIT_MISS + LOOK}))]);
          return { name, url, ms: Math.round(performance.now() - t0), ...r };
        };
        return JSON.stringify(await Promise.all(${JSON.stringify(MISSES.slice(i, i + 3))}.map(ask)));
      })()`));
      await sleep(500);
      for (const g of got) {
        const h = held.slice(since).find((x) => x.path === g.url);
        const over = !g.still && (g.error || g.status === 504);
        check(`${g.name}: over after ${LIMIT_MISS} ms (not sooner, at most ${LATE} ms later), and the browser closed the held connection`,
          over && g.ms >= LIMIT_MISS - 300 && g.ms <= LIMIT_MISS + LATE && h && h.closed && h.closed - h.at <= LIMIT_MISS + LATE,
          `${g.ms} ms · ${g.still ? "STILL WAITING" : g.error ? `refused (${g.error})` : g.status} · ${h ? (h.closed ? `connection closed ${h.closed - h.at} ms after the server took it` : "connection STILL OPEN") : "the server never saw it"}`);
      }
      for (const h of held.slice(since)) if (!h.closed) h.socket.destroy();
    }
    release();

    section(`4. an update while a request is held: the new worker takes over inside ${LIMIT_MISS + LATE} ms`);
    // The worker's states as Chrome reports them (the page reloads once the new worker takes over,
    // so nothing is read off the page). Until the new worker has installed, the page asks for a held
    // photograph every second, so the old worker owes the page an answer at that moment.
    const states = {};
    cdp.on((m) => {
      if (m.method !== "ServiceWorker.workerVersionUpdated") return;
      for (const v of m.params.versions) if (v.scriptURL.includes("check=limits") && !(v.status in states)) states[v.status] = Date.now();
    });
    await cdp.send("ServiceWorker.enable", {}, S);
    holding.push("/img/limits-held-");
    await evalIn(cdp, S, `(async () => {
      let k = 0;
      const ask = () => fetch("/img/limits-held-" + (k++) + ".webp").catch(() => {});
      ask();
      const every = setInterval(ask, 1000);
      const reg = await navigator.serviceWorker.register("/sw.js?check=limits", { updateViaCache: "none" });
      const w = reg.installing || reg.waiting;
      const stop = () => { if (!w || w.state !== "installing") clearInterval(every); };
      // A new worker waits until a page asks it to take over (one build per page: sw.js, fresh-app.js). This page asks
      // the moment it has installed, as a page does when it is hidden; the old worker's held request must not hold
      // the takeover back after that.
      const askOver = () => { if (w && w.state === "installed") w.postMessage({ type: "app/skip-waiting" }); };
      if (w) w.addEventListener("statechange", () => { stop(); askOver(); });
      stop(); askOver();
      return 1;
    })()`);
    const t0 = Date.now();
    while (!states.activated && Date.now() - t0 < 60000 + LIMIT_MISS + LOOK) await sleep(100);
    const after = states.installed ? (states.activated || Date.now()) - states.installed : null;
    const lastAsk = held.filter((h) => h.path.startsWith("/img/limits-held-")).pop();
    check(`the new worker, installed while the old one owed a held request and asked to take over at once, took over once that request was given up: inside ${LIMIT_MISS + LATE + 1000} ms of installing`,
      !!states.installed && !!states.activated && after <= LIMIT_MISS + LATE + 1000,
      `${states.installed ? `installed, then ${states.activated ? `activated ${after} ms later` : `STILL WAITING after ${after} ms`}` : "never installed"}`
        + ` · the last held request ${lastAsk ? `taken ${lastAsk.at - (states.installed || lastAsk.at)} ms from installing, ${lastAsk.closed ? `closed after ${lastAsk.closed - lastAsk.at} ms` : "STILL OPEN"}` : "never reached the server"}`);
    release();
  } finally {
    await b.done();
  }
};

try {
  await run();
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  for (const s of sockets) s.destroy();
  server.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

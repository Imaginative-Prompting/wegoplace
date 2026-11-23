#!/usr/bin/env node
/* The service worker and the page: when the page reloads for it, and which document it hands a
 * navigation when the network is slow or gone.
 *
 * Chrome needs the Bash sandbox disabled, and the launcher (scripts/lib/browser.mjs) starts it
 * only through the queue:
 *   WGP_BASE=http://localhost:<port> python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node scripts/sw_navigation_check.mjs
 *
 * sw.js answers a navigation from the network first, and from its cache once the network has
 * taken longer than NAV_TIMEOUT: an installed app must open on one bar of signal. That
 * stand-in is only right for a page the cache really holds a copy of. The site has pages the
 * cache does not hold and must not imitate (the account page, a shared collage, the sign-in
 * hops to Google or GitHub), and for those the only honest answers are the server's own page,
 * or a plain "needs a connection" when there is no server to ask. Handing them the app shell
 * gives a person the trip's agenda at the address of their account page.
 *
 * THE RELOAD. index.html reloads itself when a new worker replaces the one that served it, so
 * an update reaches a phone that never navigates. A first visit has no worker to replace, and
 * a reload there throws away whatever the person started in their first seconds (it used to:
 * an upload begun three seconds in lost its tenth part to it).
 *
 * WHAT IT PROVES, with the real worker installed and its own fetches held or failed over CDP
 * (the dev server keeps serving throughout):
 *
 *   0. A first visit, at a trip's address: the first worker takes control and the page is NOT
 *      reloaded. Its cache already holds every file the sign-in page and Your trips load
 *      (stylesheets, images and scripts read off each page's own markup, and every module
 *      those scripts import, read off the scripts), before either page has ever been opened.
 *   A. Slow network (every navigation held longer than NAV_TIMEOUT):
 *      - a trip's address, "/t/<id>/", opens from the cache before the network answers, and
 *        it is the app shell.
 *      - "/", the app's own address, sends the person on to the trip the phone opened last,
 *        and that costs ONE wait, not two ("/" itself is answered from the cache at once).
 *      - "/login/new" opens from the cache too, and it is the SIGN-IN page, not the shell.
 *      - "/trips" opens from the cache too, and it is Your trips, not the shell.
 *      - "/account" waits for the server and is the account page. Never the shell.
 *      - a trip's people, "/trips/<id>", waits for the server. Never the shell, never Your trips.
 *      - a shared-collage address waits for the server. Never the shell.
 *   B. No network at all (every request the worker makes fails, and the page's own to /api):
 *      - "/t/<id>/" is the app shell, from the cache; "/" sends the person on to it.
 *      - "/login/new" is the sign-in page, from the cache.
 *        It arrives whole: shown by its script (not by the four-second fallback, not as
 *        "didn't finish loading"), with every stylesheet it links applied and no broken image.
 *      - "/trips" is Your trips, from the cache, drawn by its script: the list the phone kept,
 *        and the words that say there is no connection.
 *      - "/account" and "/trips/<id>" are the worker's "needs a connection" page. Never the shell.
 *   C. An update: a new worker replaces the one in control and the page reloads, once.
 *      skipWaiting() does not make the browser take a request from the old worker in the middle:
 *      a new worker that has installed waits while the old one still owes the page an answer.
 *      A red here names what the old worker still owed (every answer and waitUntil() not yet
 *      settled, by event, address and age), what it still had out on the network, whether this
 *      check's own interception still held it, both workers' states with their times, and the
 *      old worker's script contexts (a worker stopped and started again shows a second one). Each
 *      on a line of its own; "nothing owed" and "couldn't read it" are told apart.
 *
 * PLANTED: SWNAV_HOLD_ANSWER_MS=120000 makes the old worker's answer to one request the page makes
 * that late, from just before the new worker is registered: C red, the new worker "installed" and
 * waiting, the answer named. (Until 18 Nov it held the request on the network instead; once every
 * request the worker answers had its own time limit, that answer came at 6 s and the plant stayed
 * green.)
 *
 * Every answer is read off the document that actually loaded, and every wait is timed.
 */
import fs from "node:fs";
import path from "node:path";
import { BASE, REPO, appSettled, boot, evalIn, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { TRIP as TRIP_ID, tripPath } from "./lib/gate_trip.mjs";

const SW = fs.readFileSync(path.join(REPO, "public/sw.js"), "utf8");
// The stylesheets the sign-in page links, read off the page itself, so the rule follows the page.
const SIGNIN_STYLES = [...fs.readFileSync(path.join(REPO, "public/login.html"), "utf8").matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
if (!SIGNIN_STYLES.length) throw new Error("public/login.html links no stylesheet: the whole-page rule has nothing to hold");
const NAV_TIMEOUT = Number((/^const NAV_TIMEOUT = (\d+);/m.exec(SW) || [])[1]);
const VERSION = (/^const VERSION = "(v\d+)"/m.exec(SW) || [])[1];
const HOLD = NAV_TIMEOUT + 2500;          // how long a held navigation waits for the network
const HOLD_ANSWER = Number(process.env.SWNAV_HOLD_ANSWER_MS || 0);   // the plant above
// That a page load's top-up never holds an update back past TOPUP_CEILING (and gives way at once to a worker already
// installing) is held without a browser by scripts/sw_topup_test.mjs, with its plants: a listener put into a
// running worker through its target is never called, so this check cannot plant it.
const TAKEOVER_MS = 45000;
const SHARE = "/s/0123456789abcdef0123456789abcdef/";   // well-formed, and nobody's
const TRIP = tripPath();                  // the gate's trip, at its address
const PEOPLE = `/trips/${TRIP_ID}`;       // that trip's people: a page only the server makes

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + detail : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 500) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

const run = async () => {
  if (!NAV_TIMEOUT || !VERSION) throw new Error("could not read NAV_TIMEOUT and VERSION out of public/sw.js");
  const b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: true });
  const { cdp, S } = b;
  try {
    // The real worker, installed and in control, with "/" and "/login" in its shell cache.
    await cdp.send("Network.setBypassServiceWorker", { bypass: false }, S);
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: false }, S);
    // Every time the app's own document loads in the top frame.
    let loads = 0;
    cdp.on((m) => {
      if (m.sessionId === S && m.method === "Page.frameNavigated" && !m.params.frame.parentId
        && String(m.params.frame.url).startsWith(BASE)) loads++;
    });

    section("0. a first visit: the first worker takes control");
    await cdp.send("Page.navigate", { url: BASE + TRIP }, S);
    await waitFor(cdp, S, `document.getElementById("view") ? 1 : 0`, { label: "the app shell" });
    await evalIn(cdp, S, `(window.__firstLoad = 1)`);
    const t0 = Date.now();
    await waitFor(cdp, S, `navigator.serviceWorker.controller ? 1 : 0`,
      { timeout: 60000, label: "a service worker taking control" });
    const took = Date.now() - t0;
    await sleep(3000);                     // a reload, if one were coming, has come by now
    const kept = await evalIn(cdp, S, `window.__firstLoad === 1 && !!navigator.serviceWorker.controller`);
    check("the page that was open when its first worker took control is still that page",
      kept && loads === 1, `${loads} load${loads === 1 ? "" : "s"} of the app document; control came ${took} ms after the shell drew`);
    await appSettled(cdp, S);
    const held = await waitFor(cdp, S, `(async () => {
      const c = await caches.open("wegoplace-shell-${VERSION}").catch(() => null);
      if (!c) return 0;
      const a = await c.match(location.origin + "/"), l = await c.match(location.origin + "/login"), t = await c.match(location.origin + "/trips");
      return a && l && t ? 1 : 0;
    })()`, { timeout: 60000, label: 'the shell cache holding "/", "/login" and "/trips"' });
    check(`the worker is in control and its ${VERSION} cache holds the app document, the sign-in page and Your trips`, !!held);
    const perTrip = JSON.parse(await evalIn(cdp, S, `(async () => {
      const c = await caches.open("wegoplace-shell-${VERSION}");
      return JSON.stringify((await c.keys()).map((r) => new URL(r.url).pathname).filter((p) => p.startsWith("/t/")));
    })()`));
    check("the app document is kept once, under its own name, not once for each trip's address", perTrip.length === 0, perTrip.join(", ") || "no /t/… entry");
    // The sign-in page is held back until its script has run, so a cached copy of the document
    // is only a page with everything it loads beside it. The list is read off its own markup.
    // Scripts are followed into what they import (static imports, read off the cached text), so
    // a module a page's script needs is on the list though no markup names it.
    const needsOf = async (doc) => JSON.parse(await evalIn(cdp, S, `(async () => {
      const c = await caches.open("wegoplace-shell-${VERSION}");
      const at = location.origin + ${JSON.stringify(doc)};
      const page = new DOMParser().parseFromString(await (await c.match(at)).text(), "text/html");
      const files = new Set([...page.querySelectorAll('link[rel="stylesheet"][href], script[src], img[src]')]
        .map((e) => new URL(e.getAttribute("href") || e.getAttribute("src"), at))
        .filter((u) => u.origin === location.origin).map((u) => u.pathname));
      // A page's own script, started by the fresh-app guard's import() in an inline script (v74).
      for (const sc of page.querySelectorAll("script:not([src])")) {
        for (const m of sc.textContent.matchAll(/import\\(\\s*["']([^"']+)["']\\s*\\)/g)) {
          const u = new URL(m[1], at);
          if (u.origin === location.origin) files.add(u.pathname);
        }
      }
      const missing = [], walk = [...files].filter((f) => f.endsWith(".js"));
      for (let i = 0; i < walk.length; i++) {
        const hit = await c.match(location.origin + walk[i]);
        if (!hit) continue;
        const text = await hit.text();
        for (const m of text.matchAll(/^\\s*(?:import|export)\\b[^;'"]*?\\bfrom\\s*["']([^"']+)["']|^\\s*import\\s*["']([^"']+)["']/gm)) {
          const u = new URL(m[1] || m[2], location.origin + walk[i]);
          if (u.origin !== location.origin || files.has(u.pathname)) continue;
          files.add(u.pathname); walk.push(u.pathname);
        }
      }
      for (const f of files) if (!(await c.match(location.origin + f))) missing.push(f);
      return JSON.stringify({ files: [...files], missing });
    })()`));
    const needs = await needsOf("/login");
    check("that cache holds every file the sign-in page loads, before the page was ever opened",
      needs.files.length >= 3 && !needs.missing.length,
      needs.missing.length ? `missing: ${needs.missing.join(", ")}` : needs.files.join(", "));
    const needsTrips = await needsOf("/trips");
    check("and every file Your trips loads, its scripts' imports included, before that page was ever opened",
      ["/css/trips.css", "/js/trips.js", "/js/trip-kit.js", "/js/auth.js"].every((f) => needsTrips.files.includes(f)) && !needsTrips.missing.length,
      needsTrips.missing.length ? `missing: ${needsTrips.missing.join(", ")}` : needsTrips.files.join(", "));

    // The worker's own fetches. "hold": a navigation it makes waits HOLD ms and every other
    // request goes straight through. "dead": every request it makes fails, as with no signal.
    const { targetInfos } = await cdp.send("Target.getTargets");
    const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(BASE) && t.url.includes("sw.js"));
    if (!sw) throw new Error("no service worker target");
    const swS = (await cdp.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).sessionId;
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, swS);
    let mode = "pass";                     // "pass" | "hold" | "dead"
    const seen = [];
    // What the old worker has asked the network for and not had answered, and which of its requests
    // this check has paused and not yet let go (both read out on a red in C).
    const open = new Map(), paused = new Map();
    const age = (o) => `${o.path} (${Math.round((Date.now() - o.at) / 1000)} s)`;
    cdp.on((m) => {
      if (m.sessionId !== swS) return;
      if (m.method === "Network.requestWillBeSent") open.set(m.params.requestId, { path: new URL(m.params.request.url).pathname, at: Date.now() });
      else if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") open.delete(m.params.requestId);
    });
    await cdp.send("Network.enable", {}, swS);
    cdp.on(async (m) => {
      if (m.method !== "Fetch.requestPaused" || m.sessionId !== swS) return;
      const { requestId, request, resourceType } = m.params;
      paused.set(requestId, { path: new URL(request.url).pathname, at: Date.now() });
      const isDoc = resourceType === "Document" || /text\/html/.test((request.headers && (request.headers.Accept || request.headers.accept)) || "");
      try {
        if (isDoc && mode !== "pass") seen.push(`${mode} ${new URL(request.url).pathname}`);
        if (mode === "dead") { await cdp.send("Fetch.failRequest", { requestId, errorReason: "InternetDisconnected" }, swS); paused.delete(requestId); return; }
        if (isDoc && mode === "hold") await sleep(HOLD);
        if (HOLD_ANSWER && request.url.includes("/towns/plant-hold")) await sleep(HOLD_ANSWER);
        await cdp.send("Fetch.continueRequest", { requestId }, swS);
        paused.delete(requestId);
      } catch { /* the request went away with its page */ }
    });

    // Go to a path and say what arrived, and how long it took to arrive.
    const WHAT = `JSON.stringify({
      path: location.pathname,
      app: document.documentElement.getAttribute("data-app") || "",
      shell: !!document.getElementById("view") && !!document.querySelector(".tabbar"),
      // Which page it is: the script it starts, by a src or, since v74, by the fresh-app guard's import().
      signIn: [...document.scripts].some((s) => s.src.includes("/js/auth.js") || s.textContent.includes('import("/js/auth.js")')),
      account: [...document.scripts].some((s) => s.src.includes("/js/account.js") || s.textContent.includes('import("/js/account.js")')),
      trips: [...document.scripts].some((s) => s.src.includes("/js/trips.js") || s.textContent.includes('import("/js/trips.js")')),
      drawn: !!document.getElementById("list") && !!document.getElementById("page") && !document.getElementById("page").hidden,
      offline: !!document.getElementById("offline") && !document.getElementById("offline").hidden,
      listed: [...document.querySelectorAll("#list a[href^='/t/']")].map((a) => a.getAttribute("href")),
      held: !!document.querySelector("#page[data-wait]"),
      failed: !!document.querySelector("#page[data-failed]"),
      styles: [...document.styleSheets].filter((s) => { try { return s.cssRules.length > 0; } catch { return false; } })
        .map((s) => s.href ? new URL(s.href).pathname : "").filter(Boolean),
      // A picture that finished and drew nothing. One still loading isn't judged yet: the looks
      // below wait for every picture to finish (an offline cover's failure is swapped for the
      // trip's mark by its error handler, which needs the failure to have happened).
      broken: [...document.images].filter((i) => i.complete && !(i.naturalWidth > 0)).map((i) => new URL(i.src).pathname),
      pending: [...document.images].filter((i) => !i.complete).length,
      title: document.title,
      text: (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 90),
    })`;
    // (The sign-in page tidies its own address to /login once it has read it, so the path
    // that comes back for "/login/new" is "/login": what is asserted is WHICH page it is.)
    // \`arrive\`: for an address that sends the person on, the path the look waits for.
    const go = async (p, arrive = null) => {
      // Leave the origin's last document first, so the next look cannot be at the old page.
      await cdp.send("Page.navigate", { url: "about:blank" }, S);
      await sleep(150);
      const t0 = Date.now();
      await cdp.send("Page.navigate", { url: BASE + p }, S);
      let got = null;
      for (;;) {
        try {
          const ready = await evalIn(cdp, S, `location.origin === ${JSON.stringify(BASE)} && document.readyState !== "loading"${arrive ? ` && location.pathname === ${JSON.stringify(arrive)}` : ""} ? 1 : 0`);
          if (ready) { got = JSON.parse(await evalIn(cdp, S, WHAT)); break; }
        } catch { /* between documents */ }
        if (Date.now() - t0 > HOLD + 20000) break;
        await sleep(100);
      }
      const ms = Date.now() - t0;
      // The sign-in page holds itself back until its script knows what to draw. Read it again
      // once the script has shown it, or after 3.5 s: the page's own fallback shows it at 4 s
      // WITHOUT the script, and that must not pass for the script having run.
      // (When it was shown is the first look that found it shown; the look goes on until its
      // pictures have finished, at most as long again.)
      if (got && got.signIn) {
        const t1 = Date.now();
        let shown = null;
        while (Date.now() - t1 < (shown === null ? 3500 : shown + 3500)) {
          try {
            got = JSON.parse(await evalIn(cdp, S, WHAT));
            if (!got.held && shown === null) shown = Date.now() - t1;
            if (!got.held && !got.pending) break;
          } catch { /* between documents */ }
          await sleep(100);
        }
        got.shown = shown ?? Date.now() - t1;
      }
      // Your trips is drawn by its script too (the list, from the server or from what the
      // phone kept). Read it again once that has happened, or after 3.5 s.
      if (got && got.trips) {
        const t1 = Date.now();
        let shown = null;
        while (Date.now() - t1 < (shown === null ? 3500 : shown + 3500)) {
          try {
            got = JSON.parse(await evalIn(cdp, S, WHAT));
            if (got.drawn && shown === null) shown = Date.now() - t1;
            if (got.drawn && !got.pending) break;
          } catch { /* between documents */ }
          await sleep(100);
        }
        got.shown = shown ?? Date.now() - t1;
      }
      return { ms, ...(got || { path: "(nothing loaded)" }) };
    };
    const whole = (r) => r.signIn && !r.held && !r.failed && !r.broken.length
      && SIGNIN_STYLES.every((f) => r.styles.includes(f));
    const sayWhole = (r) => `shown by its script ${r.held ? "NEVER (still held)" : `after ${r.shown} ms`}`
      + `${r.failed ? ' · says it "didn\'t finish loading"' : ""} · styles: ${r.styles.join(", ") || "none"}`
      + ` · broken images: ${r.broken.join(", ") || "none"}`;
    const say = (r) => `${r.ms} ms · ${r.path} · ${r.shell ? "APP SHELL" : r.account ? "account page" : r.signIn ? "sign-in page" : r.trips ? `Your trips${r.drawn ? `, drawn after ${r.shown} ms, listing ${r.listed.join(" ") || "nothing"}` : ", NOT drawn"}${r.offline ? ", saying there is no connection" : ""}` : `"${r.title}" ${r.text}`}`;
    const tripsWhole = (r) => r.trips && !r.shell && !r.signIn && r.path === "/trips" && r.drawn && !r.broken.length
      && ["/styles.css", "/css/account.css", "/css/trips.css"].every((f) => r.styles.includes(f));

    section(`A. a slow network: every navigation waits ${HOLD} ms for the server (NAV_TIMEOUT is ${NAV_TIMEOUT})`);
    mode = "hold";
    const a0 = await go(TRIP);
    check("a trip's address opens from the cache before the server answers, and it is the app shell",
      a0.shell && a0.path === TRIP && a0.ms < HOLD, say(a0));
    const a1 = await go("/", TRIP);
    check('"/" sends the person on to the trip opened last, and the shell is there after one wait, not two',
      a1.shell && a1.path === TRIP && a1.ms < HOLD, say(a1));
    const a2 = await go("/login/new");
    check('"/login/new" opens from the cache before the server answers, and it is the sign-in page, not the shell',
      a2.signIn && !a2.shell && !a2.account && a2.path.startsWith("/login") && a2.ms < HOLD, say(a2));
    check(`that sign-in page arrived whole: shown by its script, its ${SIGNIN_STYLES.length} stylesheets applied, no broken image`,
      whole(a2), sayWhole(a2));
    const a5 = await go("/trips");
    check('"/trips" opens from the cache before the server answers, and it is Your trips, whole, listing the trip',
      tripsWhole(a5) && a5.ms < HOLD && a5.listed.includes(TRIP), say(a5));
    const a3 = await go("/account");
    check('"/account" waits for the server and is the account page: never the app shell',
      a3.account && !a3.shell && a3.ms >= HOLD, say(a3));
    const a6 = await go(PEOPLE);
    check("a trip's people page waits for the server: never the app shell, never Your trips",
      !a6.shell && !a6.trips && a6.path === PEOPLE && a6.ms >= HOLD, say(a6));
    const a4 = await go(SHARE);
    check("a shared-collage address waits for the server: never the app shell",
      !a4.shell && a4.ms >= HOLD, say(a4));
    check("each of those navigations really was held inside the worker",
      [TRIP, "/login/new", "/trips", "/account", PEOPLE, SHARE].every((p) => seen.includes(`hold ${p}`)), seen.join(" · "));

    section("B. no network at all: every request the worker makes fails");
    mode = "dead";
    // The worker leaves /api alone, so the page's own requests there fail too.
    await cdp.send("Network.enable", {}, S);
    await cdp.send("Network.setBlockedURLs", { urls: ["*/api/*"] }, S);
    const b0 = await go(TRIP);
    check("a trip's address is the app shell, from the cache", b0.shell && b0.path === TRIP, say(b0));
    const b1 = await go("/", TRIP);
    check('"/" sends the person on to that trip, all of it from the cache', b1.shell && b1.path === TRIP, say(b1));
    const b2 = await go("/login/new");
    check('"/login/new" is the sign-in page, from the cache',
      b2.signIn && !b2.shell && !b2.account && b2.path.startsWith("/login"), say(b2));
    check("with nothing but the cache, that sign-in page still arrives whole",
      whole(b2), sayWhole(b2));
    const b5 = await go("/trips");
    check('"/trips" is Your trips, from the cache: the list the phone kept, and it says there is no connection',
      tripsWhole(b5) && b5.offline && b5.listed.includes(TRIP), `${say(b5)} · ${sayWhole(b5)}`);
    const b6 = await go(PEOPLE);
    check("a trip's people page says it needs a connection: never the app shell, never Your trips",
      !b6.shell && !b6.trips && /connection/i.test(b6.text) && !/installing/i.test(b6.text), say(b6));
    const b3 = await go("/account");
    check('"/account" says it needs a connection: never the app shell, never the "still installing" page',
      !b3.shell && !b3.account && /connection/i.test(b3.text) && !/installing/i.test(b3.text), say(b3));
    mode = "pass";
    await cdp.send("Network.setBlockedURLs", { urls: [] }, S);
    // (The plant keeps the interception on into C, letting everything through but its own request.)
    if (!HOLD_ANSWER) await cdp.send("Fetch.disable", {}, swS).catch(() => {});

    section("C. an update: a new worker replaces the one in control");
    // What the old worker still owes, for a red to name: every answer (respondWith) and every waitUntil() it is handed
    // from here on (a fetch's, a message's, a cache write's), by its event and address, until it settles. A new worker
    // that has called skipWaiting() takes over only once the old one owes nothing. Read off the prototypes, so it sees
    // every event (a listener added now would never be called). The plant makes the old worker's answer to one request
    // late by HOLD_ANSWER: every request the worker answers has its own time limit (LIMIT_MISS), so holding the network
    // under it no longer holds the answer.
    // Everything below is timed in ms from C's start (tC); the new worker is registered at tReg.
    const tC = Date.now();
    let tReg = 0;
    const OWED = `self.__owed ? JSON.stringify([...self.__owed.values()].map((x) => x.what + " " + Math.round((Date.now() - x.t) / 1000) + " s")) : "NO TRACKER"`;
    // The old worker's script contexts: a worker stopped and started again runs sw.js afresh in a new one, and what
    // was read or put into the old one (its busy list, this tracker) is gone with it.
    const contexts = [];
    cdp.on((m) => { if (m.sessionId !== swS) return;
      if (m.method === "Runtime.executionContextCreated") contexts.push(`created at ${Date.now() - tC} ms`);
      else if (m.method === "Runtime.executionContextDestroyed" || m.method === "Runtime.executionContextsCleared") contexts.push(`gone at ${Date.now() - tC} ms`); });
    await cdp.send("Runtime.enable", {}, swS).catch(() => {});
    const tracker = await cdp.send("Runtime.evaluate", { returnByValue: true, expression: `(() => { if (self.__owed) return 1; self.__owed = new Map(); let n = 0;
      const what = (e, kind) => kind + " " + e.type + (e.request ? " " + new URL(e.request.url).pathname : "") + (e.data && e.data.type ? " " + e.data.type : "");
      const owe = (label, p) => { const id = ++n; self.__owed.set(id, { what: label, t: Date.now() }); Promise.resolve(p).catch(() => {}).finally(() => self.__owed.delete(id)); };
      const w = ExtendableEvent.prototype.waitUntil;
      ExtendableEvent.prototype.waitUntil = function (p) { owe(what(this, "waitUntil"), p); return w.call(this, p); };
      const r = FetchEvent.prototype.respondWith;
      FetchEvent.prototype.respondWith = function (p) {
        if (${HOLD_ANSWER} && this.request.url.includes("/towns/plant-hold")) { const later = p; p = new Promise((ok) => setTimeout(ok, ${HOLD_ANSWER})).then(() => later); }
        owe(what(this, "answer to"), p); return r.call(this, p); };
      return 1; })()` }, swS).then((r) => r.exceptionDetails ? `failed: ${String(r.exceptionDetails.text).slice(0, 120)}` : `installed at ${Date.now() - tC} ms`, (e) => `failed: ${String(e.message).slice(0, 120)}`);
    // Both workers' states as the browser reports them (status/running), each change timed: the old one (sw.js) and
    // the new one (sw.js?check=update). The old one's running state says whether it was stopped and started again.
    // Each by its version id: once the page reloads, it registers sw.js again, and that later version is neither of the two.
    const states = { old: [], new: [], later: [] };
    const ids = { old: null, new: null };
    let t1 = 0;
    cdp.on((m) => { if (m.method !== "ServiceWorker.workerVersionUpdated") return;
      for (const v of m.params.versions) { if (!v.scriptURL.startsWith(BASE)) continue;
        const kind = /check=update/.test(v.scriptURL) ? "new" : /\/sw\.js$/.test(v.scriptURL) ? "old" : null; if (!kind) continue;
        if (!ids[kind]) ids[kind] = v.versionId;
        if (ids[kind] !== v.versionId) { if (!states.later.includes(v.versionId)) states.later.push(v.versionId); continue; }
        const list = states[kind];
        const s = `${v.status}/${v.runningStatus}`;
        if (!list.length || list[list.length - 1].s !== s) list.push({ s, ms: Date.now() - tC }); } });
    const timeline = (list) => list.map((x) => `${x.s} at ${x.ms}`).join(", ") || "none reported";
    await cdp.send("ServiceWorker.enable", {}, S).catch(() => {});
    // A page the worker served, with a mark on it; then a worker from a different script
    // address is registered over the same scope, which the browser treats as an update:
    // install, skipWaiting, activate, claim.
    await go("/");
    await waitFor(cdp, S, `document.getElementById("view") && navigator.serviceWorker.controller ? 1 : 0`, { label: "a page the worker controls" });
    await evalIn(cdp, S, `(window.__beforeUpdate = 1, window.__t0 = performance.now(), navigator.serviceWorker.addEventListener("controllerchange", () => {
      const a = document.activeElement; window.__cc = { ms: Math.round(performance.now() - window.__t0), focus: a ? a.tagName + (a.id ? "#" + a.id : "") : null }; }), 1)`);
    const before = loads;
    if (HOLD_ANSWER) { await evalIn(cdp, S, `(fetch("/towns/plant-hold.json").catch(() => {}), 1)`); await sleep(1500); }
    // On a busy machine the new worker can take over, and the page start reloading, before
    // register()'s promise is handed back; the browser then answers that the page it was asked
    // about is gone. That IS the reload this section waits for (the loop below still has to see
    // it). Any other failure of register() is a failure. SWNAV_HOLD_REGISTER_MS=<ms> replays that
    // order on a quiet machine: register()'s answer is held back that long.
    t1 = Date.now(); tReg = t1 - tC;
    try {
      await evalIn(cdp, S, `navigator.serviceWorker.register("/sw.js?check=update", { updateViaCache: "none" }).then(() => ${process.env.SWNAV_HOLD_REGISTER_MS ? `new Promise((r) => setTimeout(r, ${Number(process.env.SWNAV_HOLD_REGISTER_MS)}))` : "1"})`);
    } catch (e) {
      if (!/navigated or closed|context was destroyed|Cannot find context|Promise was collected/i.test(String(e && e.message))) throw e;
      console.log(`  (the page was already reloading when register() would have answered: ${String(e.message).slice(0, 80)})`);
    }
    // ONE BUILD PER PAGE (sw.js, fresh-app.js): the new worker installs and WAITS; it never takes over a page in use by
    // itself (its lazy imports would come from the new build). The page asks it to take over when it is hidden (the app
    // switched away, the screen locked) with nothing unsent, and then loads again on it.
    let waited = "";
    for (const end = Date.now() + 60000; Date.now() < end;) {
      try { waited = await evalIn(cdp, S, `navigator.serviceWorker.getRegistration().then((r) => r && r.waiting ? "waiting" : (r && r.installing ? "installing" : ""))`); } catch { waited = "between documents"; }
      if (waited === "waiting" || waited === "between documents") break;
      await sleep(250);
    }
    await sleep(1500);
    // Read off the worker, not the page: "/" sends the person on by itself (to a trip or Your trips), so the page may be
    // another document by now; what must not have changed is which worker is in control.
    const inCharge = await evalIn(cdp, S, `(navigator.serviceWorker.controller || {}).scriptURL || ""`).catch(() => "");
    check("the new worker installs and waits: it never takes over the page in use by itself", waited === "waiting" && !!inCharge && !/check=update/.test(inCharge),
      `the new worker: ${waited || "never installed"}; in control: ${inCharge || "nothing"}`);
    t1 = Date.now();
    await evalIn(cdp, S, `(document.activeElement && document.activeElement !== document.body && document.activeElement.blur(),
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }), document.dispatchEvent(new Event("visibilitychange")), 1)`).catch(() => {});
    let reloaded = false;
    while (Date.now() - t1 < 90000 && !reloaded) {
      await sleep(250);
      try { reloaded = loads > before && (await evalIn(cdp, S, `document.readyState !== "loading" && window.__beforeUpdate !== 1`)); } catch { /* between documents */ }
    }
    // A red says which of the two it was (16 Nov: one red in a gate beside another gate, with nothing
    // to tell them apart): the new worker never took control (still installing or waiting: the
    // machine, or its precache), or it did and the page held its reload (index.html waits while a
    // field has focus, until the page is hidden and shown again).
    let why = "", readOut = [];
    if (!reloaded) {
      try {
        why = await evalIn(cdp, S, `navigator.serviceWorker.getRegistration().then((r) => JSON.stringify({
          controller: (navigator.serviceWorker.controller || {}).scriptURL || null,
          installing: r && r.installing ? r.installing.state : null, waiting: r && r.waiting ? r.waiting.state : null,
          active: r && r.active ? r.active.scriptURL + " " + r.active.state : null,
          atControlChange: window.__cc || "control never changed while this page was open",
          focusNow: document.activeElement ? document.activeElement.tagName + (document.activeElement.id ? "#" + document.activeElement.id : "") : null }))`);
      } catch (e) { why = `the page could not be asked: ${String(e.message).slice(0, 80)}`; }
      const read = (expr) => cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, swS)
        .then((r) => r.exceptionDetails ? { error: String(r.exceptionDetails.text).slice(0, 120) } : { value: r.result && r.result.value }, (e) => ({ error: String(e.message).slice(0, 120) }));
      const busy = await read(`JSON.stringify(self.__busy ? [...self.__busy] : null)`), owed = await read(OWED);
      readOut = [
        `the page: ${why}`,
        `the old worker's busy list (sw.js self.__busy): ${busy.error ? `couldn't read it: ${busy.error}` : busy.value}`,
        `what the old worker still owed (answers and waitUntil()s not yet settled): ${owed.error ? `couldn't read it: ${owed.error}`
          : owed.value === "NO TRACKER" ? `the tracker isn't in the worker read now (it was ${tracker}); a worker started again runs sw.js afresh, so this busy list is a new one too`
          : owed.value === "[]" ? "nothing owed" : owed.value}`,
        `the old worker's script contexts (the first, at C's start, is the one it was running): ${contexts.join(", ") || "none reported"}`,
        `the old worker's states (sw.js), ms from C's start: ${timeline(states.old)}`,
        `the new worker's states (sw.js?check=update), registered at ${tReg} ms: ${timeline(states.new)}`,
        `later versions of sw.js (none before a reload): ${states.later.length}`,
        `the old worker still had out: ${[...open.values()].map(age).join(", ") || "nothing"}; held by this check's interception: ${[...paused.values()].map(age).join(", ") || "nothing"}`,
      ];
      why = "the read-out follows";
    }
    // Within TAKEOVER_MS: an old worker's background work (its top-up) must not hold an update back. A quiet machine
    // takes 3–4 s; a held waitUntil() took 63 s (17 Nov), which is what a phone at the cutover would sit through.
    const tookOver = Date.now() - t1;
    check(`hidden, the page lets it take over and reloads on it, within ${TAKEOVER_MS / 1000} s`,
      reloaded && tookOver <= TAKEOVER_MS, reloaded ? `reloaded ${tookOver} ms after the new worker was registered at ${tReg} ms (the new worker: ${timeline(states.new)}; the old: ${timeline(states.old)}; later versions of sw.js: ${states.later.length})` : `no reload in ${Math.round(tookOver / 1000)} s; ${why}`);
    // Whole, on lines of their own: the FAIL line is cut at 1,500 characters, and this is what a red is read by.
    for (const line of readOut) console.log(`        ${line}`);
  } finally {
    await b.done();
  }
};

run().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error("\nHARNESS ERROR:", e);
  process.exit(2);
});

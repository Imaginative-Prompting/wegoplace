#!/usr/bin/env node
/* What a phone keeps about a person, and when it lets go of it (public/js/forget.js).
 *
 * Chrome needs the Bash sandbox disabled, and the launcher (scripts/lib/browser.mjs) starts it
 * only through the queue:
 *   WGP_BASE=http://localhost:<port> python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node scripts/forget_check.mjs
 * Part 0 alone starts no browser and asks the server nothing (the address is still named):
 *   WGP_BASE=http://localhost:<port> node scripts/forget_check.mjs --static
 *
 * Three ways a session ends, and what each must do to the trip, the kit list, the waiting
 * changes and the kept pictures on the phone:
 *
 *   SIGNED OUT (or the account deleted): everything goes, at once, and a copy of the app that
 *     is still open leaves the screen without sending or writing back what it holds.
 *   A DIFFERENT PERSON SIGNS IN (the first session just ended: expired, cookie gone): they
 *     see none of the first person's rows and send none of the first person's waiting changes.
 *     With the server's readable cookie the phone is cleared before a stored row is read;
 *     without it, on the first answer from /api/me, and nothing is sent before that.
 *   THE SAME PERSON SIGNS BACK IN: nothing is lost, and the waiting change is sent once.
 *
 * WHAT IT PROVES
 *   0. No browser: every database a module opens is in forget.js's table, every key the app
 *      stores under starts with "wgp.", the cache it clears is the one sw.js keeps pictures
 *      in, and the worker precaches the module.
 *   1. Signing out: forgetThisPhone() from a second tab while the app is open with a change
 *      waiting. The count was right, the open app left, the databases, the picture cache and
 *      the personal keys are empty, the phone's own settings stayed, nothing reached the server.
 *   2. A different account, the cookie present: person B never has person A's purchase or
 *      kit item in the page, not for one frame, and none of A's changes is sent.
 *   3. A different account, no cookie: the same end state, and nothing of A's is sent.
 *      3b. …and while /api/me cannot answer, nothing queued is sent at all.
 *   4. The same account back, with and without the cookie: the change is sent exactly once.
 *   5. The session ends ON THE SERVER (signed out elsewhere, run out) while the phone still
 *      holds its cookies: the app opens, is told 401, and goes to sign-in with the trip and
 *      the waiting change still on the phone and nothing recorded by the server. The same
 *      person signs back in and the change is sent exactly once. (The server clears its
 *      readable cookie with that 401: an absent cookie means "nobody is signed in yet",
 *      never "somebody else".)
 *
 * Two people of the gate's made-up trip: A is its host, B is another member, read from
 * the roster when the check runs. Everything it adds it removes, and it counts the purchases
 * before and after.
 */
import fs from "node:fs";
import path from "node:path";
import { BASE, HOST, REPO, appSettled, boot, evalIn, signInAs, sleep, waitFor } from "./lib/standalone_cdp.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + detail : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 600) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ── 0. the tables, against the code ───────────────────────────────────────────────────────
const forget = await import(path.join(REPO, "public/js/forget.js"));
section("0. forget.js's tables against the code (no browser)");
{
  const dir = path.join(REPO, "public/js");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => `public/js/${f}`)
    .concat(fs.readdirSync(path.join(dir, "shared")).map((f) => `public/js/shared/${f}`), ["public/index.html", "public/sw.js"]);
  const constOf = (src, name) => (new RegExp(`const ${name} = "([^"]+)"`).exec(src) || [])[1];
  const opened = [];
  const perTrip = [];
  const keys = [];
  const tripKeys = [];                     // stored once for each trip: here(<KEY>)
  const unread = [];
  for (const f of files) {
    if (f === "public/js/forget.js") continue;
    const src = read(f);
    // A database kept once for each trip is opened as dbName(<BASE>, <trip>): its base name is
    // the constant, and the table has to mark it perTrip.
    for (const m of src.matchAll(/indexedDB\.open\(\s*(dbName\(\s*)?([^,)\s]+)/g)) {
      const name = /^["']/.test(m[2]) ? m[2].slice(1, -1) : constOf(src, m[2]);
      if (!name) unread.push(`${f}: indexedDB.open(${m[1] || ""}${m[2]})`);
      else { opened.push([f, name]); if (m[1]) perTrip.push([f, name]); }
    }
    for (const m of src.matchAll(/localStorage\.(?:setItem|getItem|removeItem)\(\s*([^,)\s]+)/g)) {
      const arg = m[1].replace(/^here\(/, "");
      if (/^["']/.test(arg)) keys.push([f, arg.slice(1, -1)]);
      else if (constOf(src, arg)) keys.push([f, constOf(src, arg)]);
      else if (!/^(k|key)$/.test(arg)) unread.push(`${f}: localStorage key ${arg}`);   // k / key: a wrapper's parameter
    }
    // The wrappers' callers: every constant or template that names a stored key.
    for (const m of src.matchAll(/const (?:K_[A-Z]+|PREF_[A-Z]+|[A-Z]+_KEY) = "([^"]+)"/g)) keys.push([f, m[1]]);
    for (const m of src.matchAll(/const k[A-Z][A-Za-z]* = \([^)]*\) => `([^`$]+)/g)) keys.push([f, m[1]]);
    // A choice about one trip is stored through here(<KEY>) or here(<kFamily>(…)).
    for (const m of src.matchAll(/\bhere\(\s*([A-Za-z_]+)(\()?/g)) {
      const name = m[2] ? (new RegExp(`const ${m[1]} = \\([^)]*\\) => \`([^\`$]+)`).exec(src) || [])[1] : constOf(src, m[1]);
      if (name) tripKeys.push([f, name]); else unread.push(`${f}: here(${m[1]})`);
    }
  }
  const listed = forget.DATABASES.map((d) => d.name);
  const retired = forget.DATABASES.filter((d) => d.retired).map((d) => d.name);
  check("the app opens at least the two databases this check knows of", new Set(opened.map((o) => o[1])).size >= 2, opened.map((o) => o.join(": ")).join("; "));
  check("every database a module opens is in forget.js's table", opened.every(([, n]) => listed.includes(n)),
    opened.filter(([, n]) => !listed.includes(n)).map((o) => o.join(": ")).join("; "));
  check("and the table names no database nothing opens, but the ones it marks retired",
    listed.every((n) => retired.includes(n) || opened.some(([, o]) => o === n)), listed.join(" "));
  check("a database marked retired is one no module opens", retired.every((n) => !opened.some(([, o]) => o === n)),
    retired.join(" "));
  const tablePerTrip = forget.DATABASES.filter((d) => d.perTrip).map((d) => d.name);
  check("a database opened once for each trip is marked perTrip in the table, and no other is",
    opened.every(([f, n]) => tablePerTrip.includes(n) === perTrip.some(([g, o]) => g === f && o === n)) && tablePerTrip.length >= 2,
    `opened per trip: ${perTrip.map((o) => o.join(": ")).join("; ")} / table: ${tablePerTrip.join(" ")}`);
  check("forget.js reads the phone's list of trips under the name trip-here.js writes it",
    forget.KEPT_TRIPS_KEY === constOf(read("public/js/trip-here.js"), "KEPT_KEY") && forget.KEPT_TRIPS_KEY.startsWith("wgp.") && !forget.KEPT_KEYS.includes(forget.KEPT_TRIPS_KEY),
    `${forget.KEPT_TRIPS_KEY} / ${constOf(read("public/js/trip-here.js"), "KEPT_KEY")}`);
  const TRIP_KEYS = (await import(path.join(REPO, "public/js/trip-here.js"))).TRIP_KEYS;
  check("the choices stored once for each trip are exactly the ones trip-here.js lists (so they move with an old phone's trip, and go with a trip that is gone)",
    [...new Set(tripKeys.map((k) => k[1]))].sort().join(" ") === [...TRIP_KEYS].sort().join(" ") && TRIP_KEYS.length >= 5,
    `stored through here(): ${[...new Set(tripKeys.map((k) => k[1]))].sort().join(" ")} / listed: ${[...TRIP_KEYS].sort().join(" ")}`);
  check("every database name and stored key in the code could be read", unread.length === 0, unread.join("; "));
  check("the app stores under at least ten keys, so this looked in the right place", new Set(keys.map((k) => k[1])).size >= 10, String(new Set(keys.map((k) => k[1])).size));
  check('every key the app stores under starts with "wgp."', keys.every(([, k]) => k.startsWith("wgp.")),
    keys.filter(([, k]) => !k.startsWith("wgp.")).map((k) => k.join(": ")).join("; "));
  check("the keys that stay are the phone's own, and the app really uses them",
    forget.KEPT_KEYS.every((k) => k === "wgp.epoch" || keys.some(([, used]) => used === k)), forget.KEPT_KEYS.join(" "));
  const sw = read("public/sw.js");
  // Every cache any code opens is either a person's (cleared) or kept on purpose, by name.
  const cacheNames = [];
  const unreadCaches = [];
  for (const f of files) {
    if (f === "public/js/forget.js") continue;
    const src = read(f);
    for (const m of src.matchAll(/caches\.open\(\s*([^,)\s]+)/g)) {
      const arg = m[1];
      const tmpl = (new RegExp(`const ${arg} = \`([^\`$]+)`).exec(src) || [])[1];     // a template: the shell's cache, named by version
      if (/^["']/.test(arg)) cacheNames.push([f, arg.slice(1, -1)]);
      else if (constOf(src, arg)) cacheNames.push([f, constOf(src, arg)]);
      else if (tmpl) cacheNames.push([f, tmpl]);
      else if (new RegExp(`import \\{[^}]*\\b${arg}\\b[^}]*\\} from`).test(src) && files.some((g) => constOf(read(g), arg))) {
        cacheNames.push([f, constOf(read(files.find((g) => constOf(read(g), arg))), arg)]);      // a constant imported from another module
      }
      else if (!/^(cacheName)$/.test(arg)) unreadCaches.push(`${f}: caches.open(${arg})`);   // cacheName: a helper's parameter
    }
  }
  for (const m of sw.matchAll(/^const [A-Z]+ = "((?:wegoplace|wgp)-[^"]+)"/gm)) cacheNames.push(["public/sw.js", m[1]]);
  const kept = (n) => forget.KEPT_CACHES.some((k) => (k.endsWith("-") ? n.startsWith(k) : n === k));
  const homeless = cacheNames.filter(([, n]) => !forget.PRIVATE_CACHES.includes(n) && !kept(n));
  check("every cache name in the code could be read, and there are at least five", unreadCaches.length === 0 && new Set(cacheNames.map((c) => c[1])).size >= 5,
    `${[...new Set(cacheNames.map((c) => c[1]))].join(" ")} ${unreadCaches.join("; ")}`);
  check("every cache the code keeps is cleared as a person's, or named as kept on purpose", homeless.length === 0, homeless.map((c) => c.join(": ")).join("; "));
  check("no cache is on both lists, and every listed one is really used",
    !forget.PRIVATE_CACHES.some(kept) && [...forget.PRIVATE_CACHES, ...forget.KEPT_CACHES].every((k) => cacheNames.some(([, n]) => (k.endsWith("-") ? n.startsWith(k) : n === k))),
    [...forget.PRIVATE_CACHES, ...forget.KEPT_CACHES].join(" "));
  const media = (/^const MEDIA = "([^"]+)"/m.exec(sw) || [])[1];
  check("the cache it clears is the one the worker keeps people's pictures in", forget.PRIVATE_CACHES.includes(media), `${media} / ${forget.PRIVATE_CACHES}`);
  const townFiles = (/^const TOWNS = "([^"]+)"/m.exec(sw) || [])[1];
  check("and the one it keeps looked-up towns in: which files a phone has says what somebody typed", forget.PRIVATE_CACHES.includes(townFiles), `${townFiles} / ${forget.PRIVATE_CACHES}`);
  // A trip's offline map: map-keep.js keeps it (for the shell and for map.js), forget.js drops
  // it with the trip. Two files, one cache, one address.
  const mapKeep = await import("../public/js/map-keep.js");
  check("a trip's offline map is kept where forgetting a trip looks for it: the same cache, the same address",
    mapKeep.TILE_CACHE === forget.TRIP_MAPS && forget.KEPT_CACHES.includes(forget.TRIP_MAPS)
      && mapKeep.archiveUrl("a b") === "/api/trips/a%20b/tiles" && forget.tripMapAddress("a b") === mapKeep.archiveUrl("a b"),
    `${mapKeep.TILE_CACHE} / ${mapKeep.archiveUrl("a b")} / ${forget.tripMapAddress("a b")}`);
  check("the map's glyph ranges are kept where the worker keeps map furniture, and that cache is kept on purpose",
    mapKeep.GLYPH_CACHE === (/^const TILES = "([^"]+)"/m.exec(sw) || [])[1] && forget.KEPT_CACHES.includes(mapKeep.GLYPH_CACHE), mapKeep.GLYPH_CACHE);
  check("the worker precaches the module, so the sign-in page has it with no network", sw.includes('"/js/forget.js"'));
  check("the count's words", forget.waitingWords(0) === "" && forget.waitingWords(1) === "1 change hasn't been sent" && forget.waitingWords(3) === "3 changes haven't been sent");
  check("whose data: same, other, unknown", forget.ownerVerdict("a", "a") === "same" && forget.ownerVerdict("a", "b") === "other"
    && forget.ownerVerdict("a", "") === "unknown" && forget.ownerVerdict("", "b") === "same" && forget.ownerVerdict("", "") === "same");
  // A browser that will not open a database: the page that signs a person out has to hear it.
  {
    const mem = new Map();
    const fakeStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); },
      key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
    Object.defineProperty(globalThis, "localStorage", { value: fakeStorage, configurable: true });
    const fakeIdb = (how) => ({ open() { const r = {}; queueMicrotask(() => how(r)); return r; } });
    mem.set("wgp.pos", "{}"); mem.set("wgp.theme", "dark");
    Object.defineProperty(globalThis, "indexedDB", { value: fakeIdb((r) => r.onerror({ preventDefault() {} })), configurable: true });
    const refused = await forget.forgetThisPhone();
    check("a database that will not open is reported as not cleared, by name", refused.ok === false && listed.every((n) => refused.failed.includes(n)), JSON.stringify(refused));
    check("and what could be cleared still was", !mem.has("wgp.pos") && mem.has("wgp.theme") && mem.has("wgp.epoch"), [...mem.keys()].join(" "));
    check("an unreadable database counts no waiting change", (await forget.waitingChanges()) === 0);
    Object.defineProperty(globalThis, "indexedDB", { configurable: true,
      value: fakeIdb((r) => { r.transaction = { abort() {} }; r.onupgradeneeded(); r.onerror({ preventDefault() {} }); }) });
    const none = await forget.forgetThisPhone();
    check("a database that was never made is not a failure, and is not made", none.ok === true && none.failed.length === 0, JSON.stringify(none));
    delete globalThis.indexedDB; delete globalThis.localStorage;
  }
  check("the readable cookie is read by name, decoded, and absent is empty",
    forget.sessionAccount("x=1; wgp_who=u%5Fa; y=2") === "u_a" && forget.sessionAccount("x=1") === "" && forget.sessionAccount("wgp_whoo=z") === "");
}

// --static: part 0 alone. No browser is started and nothing is asked of the server.
if (process.argv.includes("--static")) {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("failed:"); for (const f of failures) console.log(`  ${f}`); }
  process.exit(fail ? 1 : 0);
}

// ── the browser ───────────────────────────────────────────────────────────────────────────
const { tripPath, tripApi, person } = await import("./lib/gate_trip.mjs");
const A = person().id;                    // the trip's host
let B = "";                               // another member of the trip: read from the roster once A is signed in
const TAG = `forget-check ${Date.now().toString(36)}`;
const b = await boot({});
const { cdp, S } = b;
const page = (expr, s = S) => evalIn(cdp, s, expr);
const inStore = (body, s = S) => page(`(async () => { const { store } = await import("/js/store.js"); ${body} })()`, s);
const inForget = (body, s = S) => page(`(async () => { const f = await import("/js/forget.js"); ${body} })()`, s);

// Every write the page tries to send, and a switch that fails them before they leave (the
// page stays able to navigate, which a whole-network "offline" would take away).
let blockWrites = false;
let slowReads = 0;                        // ms every /api read is held: a slow network, so stored rows get their chance to paint
let holdLogin = false; const heldLogin = [];   // the sign-in page never arrives: a copy of the app that cannot leave
let failMe = false, meAsked = 0;          // /api/me answers 503 and sets no cookie: who is signed in stays unknown
let docsFromPhone = 0;                    // how many times the trip's document was answered from "the phone" (below)
// The trip's document comes from the phone, not from the server: on the trail the worker
// answers it from its cache, and a cached document carries no cookie. The server's own answer
// to a trip's address names the account in the readable cookie (src/gate.js), so without this
// "nobody has said whose session this is" could not happen here. The request never reaches
// the server: it is answered here with the app document's own bytes (public/index.html is
// what the server sends at every trip's address). Taking Set-Cookie off the server's answer
// instead does not work: the browser has stored a response's cookies before it can be changed.
let docFromPhone = false;
const APP_DOCUMENT = Buffer.from(read("public/index.html")).toString("base64");
const writes = [];
await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/*", requestStage: "Request" },
  { urlPattern: "*/login*", resourceType: "Document", requestStage: "Request" },
  { urlPattern: "*/t/*", resourceType: "Document", requestStage: "Request" }] }, S);
cdp.on(async (m) => {
  if (m.sessionId !== S || m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params;
  try {
    if (m.params.resourceType === "Document" && /^\/t\/[^/]+\/$/.test(new URL(request.url).pathname)) {
      if (docFromPhone) {
        docsFromPhone++;
        await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }, { name: "cache-control", value: "no-store" }],
          body: APP_DOCUMENT }, S);
        return;
      }
      await cdp.send("Fetch.continueRequest", { requestId }, S);
      return;
    }
    if (new URL(request.url).pathname === "/login") {
      if (holdLogin) { heldLogin.push(requestId); return; }
      await cdp.send("Fetch.continueRequest", { requestId }, S);
      return;
    }
    if (failMe && request.method === "GET" && new URL(request.url).pathname === "/api/me") {
      meAsked++;
      inflight.delete(m.params.networkId);
      await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 503, responseHeaders: [{ name: "content-type", value: "application/json" }],
        body: Buffer.from('{"error":"unavailable"}').toString("base64") }, S);
      return;
    }
    if (slowReads && request.method === "GET") await sleep(slowReads);
    if (request.method !== "GET") {
      writes.push({ method: request.method, url: request.url.replace(BASE, ""), body: request.postData || "", blocked: blockWrites });
      if (blockWrites) { inflight.delete(m.params.networkId); await cdp.send("Fetch.failRequest", { requestId, errorReason: "ConnectionFailed" }, S); return; }
    }
    await cdp.send("Fetch.continueRequest", { requestId }, S);
  } catch { /* the page went away mid-request */ }
});
// Did this text ever reach the page, even for a frame? Installed before any script runs.
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  const TAG = ${JSON.stringify(TAG)};
  // Kept in sessionStorage: the app may reload itself, and a row shown by the document before
  // the reload was still shown.
  const look = () => { if (document.documentElement && document.documentElement.textContent.includes(TAG)) { try { sessionStorage.setItem("sawTag", "1"); } catch {} } };
  new MutationObserver(look).observe(document, { childList: true, subtree: true, characterData: true });
})()` }, S);

// The server clears its cookies with a 401. An answer still on its way to a page that has just
// lost its session would clear the NEXT person's sign-in cookie too, if that cookie were set
// before the answer landed (seen under load: a 381 ms /api/me). So no account is switched
// while a request to /api is in the air: quiet() waits for none, four looks in a row.
const inflight = new Map();
await cdp.send("Network.enable", {}, S);
// Every document the window loaded and everything the page logged, for a failing check's detail.
const loaded = [], logged = [];
await cdp.send("Runtime.enable", {}, S).catch(() => {});
cdp.on((m) => {
  if (m.sessionId !== S) return;
  if (m.method === "Page.frameNavigated" && !m.params.frame.parentId) loaded.push(String(m.params.frame.url).replace(BASE, ""));
  else if (m.method === "Runtime.consoleAPICalled") logged.push(`${m.params.type}: ${(m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 160)}`);
});
cdp.on((m) => {
  if (m.sessionId !== S) return;
  if (m.method === "Network.requestWillBeSent" && m.params.request.url.includes("/api/")) inflight.set(m.params.requestId, `${m.params.request.method} ${m.params.request.url.replace(BASE, "")}`);
  // The answer's headers are what set a cookie: once they are in, the request is no longer a risk.
  else if (m.method === "Network.responseReceived" || m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") inflight.delete(m.params.requestId);
});
const quiet = async () => {
  let calm = 0;
  for (let i = 0; i < 100 && calm < 4; i++) { calm = inflight.size ? 0 : calm + 1; await sleep(60); }
  if (calm < 4) { console.log(`  note  still in the air after 6 s: ${[...inflight.values()].join(", ").slice(0, 200)}`); inflight.clear(); }
};

const go = async (hash) => {
  await cdp.send("Page.navigate", { url: "about:blank" }, S); await sleep(150);
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath(hash)}` }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `(async () => { const { store } = await import("/js/store.js"); await store.ready(); return store.me().id ? 1 : 0; })()`, { label: "the store knowing who is signed in" });
};
// Leaving cancels whatever the old page had in the air (a cancelled request sets no cookie),
// so only the sign-in page's own requests are waited for.
const leaveApp = async () => { await cdp.send("Page.navigate", { url: `${BASE}/login?boot=0` }, S); inflight.clear(); await sleep(400); await quiet(); };
const setWho = async (id) => {
  if (id) await cdp.send("Network.setCookie", { name: forget.WHO_COOKIE, value: encodeURIComponent(id), domain: HOST, path: "/" }, S);
  else await cdp.send("Network.deleteCookies", { name: forget.WHO_COOKIE, url: BASE }, S);
};
const endSession = async () => {          // the session ends and nobody pressed Sign out
  for (const name of ["wgp_session", "s2", forget.WHO_COOKIE]) await cdp.send("Network.deleteCookies", { name, url: BASE }, S);
};
const meId = () => inStore(`return store.me().id || "";`);
const serverPurchases = () => page(`fetch(${JSON.stringify(tripApi())}, { credentials: "same-origin", cache: "no-store" }).then((r) => r.json()).then((t) => JSON.stringify((t.purchases || []).map((p) => [p.id, p.description])))`).then(JSON.parse);
const STORED = `(async () => {
  const out = {};
  const have = new Set((await indexedDB.databases()).map((d) => d.name));
  // The table's names, and every database of the app's the browser lists: one per trip now.
  for (const name of new Set([...${JSON.stringify(forget.DATABASES.map((d) => d.name))}, ...[...have].filter((n) => /^wegoplace/.test(n))])) {
    if (!have.has(name)) { out[name] = "absent"; continue; }
    const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const counts = {};
    for (const s of db.objectStoreNames) {
      counts[s] = await new Promise((res) => { const q = db.transaction([s]).objectStore(s).getAll(); q.onsuccess = () => res(JSON.stringify(q.result)); q.onerror = () => res("?"); });
    }
    db.close();
    out[name] = counts;
  }
  return JSON.stringify({ dbs: out, caches: await caches.keys(),
    keys: Object.keys(localStorage).filter((k) => k.startsWith("wgp.")).sort() });
})()`;
const stored = async (s = S) => JSON.parse(await page(STORED, s));
const rowsIn = (st) => Object.values(st.dbs).flatMap((d) => (d === "absent" ? [] : Object.values(d))).join("\n");
const emptyDbs = (st) => Object.values(st.dbs).every((d) => d === "absent" || Object.values(d).every((v) => v === "[]"));

const made = { purchases: [], kit: null };
/** Person A signs in, opens the app, and leaves a purchase waiting that could not be sent. */
async function aLeavesAWrite(label) {
  await leaveApp();
  await endSession();
  await cdp.send("Storage.clearDataForOrigin", { origin: BASE, storageTypes: "indexeddb,local_storage,cache_storage" }, S);
  await signInAs(cdp, S, A);
  blockWrites = false;
  await go("#/split");
  const id = await meId();
  if (!B) B = await inStore(`return (store.members().find((m) => m.id !== store.me().id) || {}).id || "";`);
  if (!B) throw new Error("the trip has only one member: this check needs two people");
  if (!made.kit) {
    // A private kit item, sent while A is online: only A is ever given it by the server.
    made.kit = JSON.parse(await inStore(`const row = await store.addPacking(store.me().id, { label: ${JSON.stringify(TAG + " kit")} }); return JSON.stringify(row);`)).id;
    await waitFor(cdp, S, `(async () => { const { store } = await import("/js/store.js"); return store.pending() === 0 ? 1 : 0; })()`, { label: "A's kit item reaching the server" });
  }
  await inStore(`await store.refresh?.(); return 1;`).catch(() => {});
  blockWrites = true;
  const row = JSON.parse(await inStore(`
    const ids = store.members().map((m) => m.id);
    const row = await store.addPurchase({ description: ${JSON.stringify(`${TAG} ${label}`)}, amount_minor: 4000, currency: "PEN", amount_exp: 2,
      shares: ids.map((u) => ({ user_id: u, weight: 1 })) });
    return JSON.stringify(row);`));
  made.purchases.push(row.id);
  await sleep(700);
  return { id, purchase: row.id };
}

try {
  section("1. Signing out with the app open and a change waiting");
  const before = (await (async () => { await go("#/split"); return serverPurchases(); })()).length;
  {
    const a = await aLeavesAWrite("sign-out");
    await page(`(async () => { const c = await caches.open("wegoplace-media-v1"); await c.put("/media/forget-check", new Response("kept picture")); localStorage.setItem("wgp.pos", "{}"); localStorage.setItem("wgp.theme", "dark"); return 1; })()`);
    const n0 = writes.length;
    check("the app has the change waiting", (await inStore(`return store.pending();`)) === 1);
    check("waitingChanges() counts it", (await inForget(`return f.waitingChanges();`)) === 1);
    const st0 = await stored();
    check("before: the phone holds A's trip and the waiting purchase", rowsIn(st0).includes(a.purchase) && !emptyDbs(st0));

    const { targetId } = await cdp.send("Target.createTarget", { url: `${BASE}/login?boot=0` });
    const { sessionId: S2 } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Runtime.enable", {}, S2);
    await waitFor(cdp, S2, `document.readyState === "complete" ? 1 : 0`, { label: "the second tab" });
    check("the second tab counts the same waiting change, without the app", (await inForget(`return f.waitingChanges();`, S2)) === 1);
    const res = JSON.parse(await inForget(`return JSON.stringify(await f.forgetThisPhone());`, S2));
    check("forgetThisPhone() reports everything cleared", res.ok === true && res.failed.length === 0, JSON.stringify(res));
    const left = await waitFor(cdp, S, `location.pathname.startsWith("/login") ? 1 : 0`, { label: "the open app leaving", timeout: 8000 }).then(() => true, () => false);
    check("the copy of the app that was open left for the sign-in page", left, await page(`location.href`));
    await sleep(800);
    const st = await stored(S2);
    check("no database holds a row", emptyDbs(st), JSON.stringify(st.dbs).slice(0, 400));
    check("the kept pictures are gone", !st.caches.includes("wegoplace-media-v1"), st.caches.join(" "));
    check("the personal keys are gone and the phone's own stayed", !st.keys.includes("wgp.pos") && st.keys.includes("wgp.theme") && st.keys.includes("wgp.epoch")
      && st.keys.every((k) => forget.KEPT_KEYS.includes(k)), st.keys.join(" "));
    check("nothing is waiting any more", (await inForget(`return f.waitingChanges();`, S2)) === 0);
    blockWrites = false;                    // the signal is back; the old copy of the app retries within 5 s if it can
    await sleep(6500);
    const sent = writes.slice(n0).filter((w) => !w.blocked);
    check("with the signal back, the waiting change still never reached the server", sent.length === 0, JSON.stringify(sent).slice(0, 300));
    await cdp.send("Target.closeTarget", { targetId });
  }

  section("1b. A copy of the app that cannot leave: it stores nothing and sends nothing");
  {
    // The open app's answer to a cleared phone is to go to the sign-in page. A page frozen in the
    // background, or one whose navigation is slow, is still running the old person's code for a
    // while: here the sign-in page is held back, so that copy stays alive, and it is asked to
    // make changes with the network working.
    await aLeavesAWrite("held");
    const n0 = writes.length;
    const { targetId } = await cdp.send("Target.createTarget", { url: `${BASE}/login?boot=0` });
    const { sessionId: S2 } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Runtime.enable", {}, S2);
    await waitFor(cdp, S2, `document.readyState === "complete" ? 1 : 0`, { label: "the second tab" });
    // A page whose navigation is held answers no DevTools call, so the held copy is given its
    // orders now: the moment it sees the phone was cleared, make a purchase and a kit item and
    // ask the server for the trip, then leave what happened where the second tab can read it
    // (a key forgetThisPhone() does not own). Each call gets three seconds: one that parks for
    // ever, as the app does once it has been told to sign in, is an answer too.
    await inStore(`
      const within = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r("no answer in 3 s"), 3000))]);
      const ids = store.members().map((m) => m.id), me = store.me().id;
      const t = setInterval(async () => {
        if (!store.phoneCleared()) return;
        clearInterval(t);
        const out = {};
        try { const r = await within(store.addPurchase({ description: ${JSON.stringify(`${TAG} after-clear`)}, amount_minor: 900, currency: "PEN", amount_exp: 2,
          shares: ids.map((u) => ({ user_id: u, weight: 1 })) })); out.purchase = r && (r.id || r); } catch (e) { out.purchase = "threw: " + e.message; }
        try { const r = await within(store.addPacking(me, { label: ${JSON.stringify(`${TAG} after-clear kit`)} })); out.kit = r && (r.id || r); } catch (e) { out.kit = "threw: " + e.message; }
        try { const r = await within(store.refresh()); out.refresh = r === "no answer in 3 s" ? r : "answered"; } catch (e) { out.refresh = "threw: " + e.message; }
        out.path = location.pathname;
        localStorage.setItem("forget-check.held", JSON.stringify(out));
      }, 40);
      return 1;`);
    blockWrites = false;
    holdLogin = true;
    await inForget(`await f.forgetThisPhone(); return 1;`, S2);
    for (let i = 0; i < 80 && !heldLogin.length; i++) await sleep(100);
    check("the open app set off for the sign-in page, and is held there", heldLogin.length === 1, `${heldLogin.length} held`);
    const tried = await waitFor(cdp, S2, `localStorage.getItem("forget-check.held") || ""`, { label: "the held copy trying to make changes", timeout: 15000 }).then((v) => JSON.parse(v), () => null);
    check("the held copy was still running, on the app's page, and tried a purchase, a kit item and a refresh", !!tried && tried.path === tripPath(), JSON.stringify(tried));
    console.log(`  info  what the held copy got back: ${JSON.stringify(tried)}`);
    if (tried && /^pu-/.test(String(tried.purchase))) made.purchases.push(tried.purchase);
    await sleep(6500);
    const sent = writes.slice(n0).filter((w) => !w.blocked);
    check("the held copy sent nothing: not the waiting change, not the new ones", sent.length === 0, JSON.stringify(sent).slice(0, 300));
    const st = await stored(S2);
    check("and stored nothing: no database holds a row", emptyDbs(st), JSON.stringify(st.dbs).slice(0, 400));
    check("nothing is waiting on the phone", (await inForget(`return f.waitingChanges();`, S2)) === 0);
    await page(`(localStorage.removeItem("forget-check.held"), 1)`, S2);
    holdLogin = false;
    for (const requestId of heldLogin.splice(0)) await cdp.send("Fetch.continueRequest", { requestId }, S).catch(() => {});
    const left = await waitFor(cdp, S, `location.pathname.startsWith("/login") ? 1 : 0`, { label: "the held copy leaving", timeout: 8000 }).then(() => true, () => false);
    check("let go, it arrives at the sign-in page", left, await page(`location.href`));
    await cdp.send("Target.closeTarget", { targetId });
  }

  for (const withCookie of [true, false]) {
    section(withCookie ? "2. A different account signs in; the server's readable cookie is there" : "3. A different account signs in; no readable cookie");
    const a = await aLeavesAWrite(withCookie ? "other-cookie" : "other-nocookie");
    const st0 = await stored();
    check("before: the phone holds A's waiting purchase and A's kit item", rowsIn(st0).includes(a.purchase) && rowsIn(st0).includes(made.kit));
    await leaveApp();
    await endSession();
    await page(`(sessionStorage.removeItem("sawTag"), 1)`);
    await signInAs(cdp, S, B);
    const bId = JSON.parse(await page(`fetch("/api/me", { credentials: "same-origin" }).then((r) => r.json()).then((m) => JSON.stringify(m.id))`));
    check("B is a different account", !!bId && bId !== a.id, `${a.id} / ${bId}`);
    const who = async () => (await cdp.send("Network.getCookies", { urls: [BASE] }, S)).cookies.find((c) => c.name === forget.WHO_COOKIE);
    if (withCookie) {
      const c = await who();
      check("the server itself named B in the readable cookie, and a page can read it", !!c && decodeURIComponent(c.value) === bId && c.httpOnly === false, JSON.stringify(c || null));
    } else await setWho("");
    blockWrites = false;
    // The server answers slowly: whatever the phone has stored is what the app would paint
    // first. With the cookie, the phone is cleared before a row of it is read.
    slowReads = withCookie ? 2500 : 0;
    docFromPhone = !withCookie;
    const n0 = writes.length;
    await go("#/split");
    await sleep(1500);
    const sawOnSplit = await page(`sessionStorage.getItem("sawTag") === "1"`);
    await page(`(location.hash = "#/pack", 1)`);
    await waitFor(cdp, S, `document.querySelector('[data-act="new"], .pk-fab') ? 1 : 0`, { label: "Packing" });
    await sleep(1200);
    const sawOnPack = await page(`sessionStorage.getItem("sawTag") === "1"`);
    slowReads = 0;
    docFromPhone = false;
    check("the app is B's", (await meId()) === bId);
    if (withCookie) check("A's purchase and kit item were never in B's page, not for a frame", sawOnSplit === false && sawOnPack === false, `split ${sawOnSplit}, packing ${sawOnPack}`);
    else console.log(`  info  without the cookie, were A's rows in the page before /api/me answered? ${sawOnSplit || sawOnPack ? "yes, until it did" : "no"}`);
    check("B's screens show none of A's rows now", !(await page(`document.documentElement.textContent.includes(${JSON.stringify(TAG)})`)));
    const st = await stored();
    check("nothing stored on the phone is A's", !rowsIn(st).includes(a.purchase) && !rowsIn(st).includes(made.kit));
    check("B has nothing waiting", (await inForget(`return f.waitingChanges();`)) === 0);
    const sent = writes.slice(n0);
    check("B's session sent none of A's writes (it sent no write at all)", sent.length === 0, JSON.stringify(sent).slice(0, 300));
    check("and the server has no such purchase", !(await serverPurchases()).some(([id]) => id === a.purchase));
    await leaveApp();
  }

  section("3b. A different account, no readable cookie, and /api/me cannot answer");
  {
    const a = await aLeavesAWrite("other-unknown");
    await leaveApp();
    await endSession();
    await signInAs(cdp, S, B);
    await page(`fetch("/api/me", { credentials: "same-origin" }).then((r) => r.status)`);
    await setWho("");
    blockWrites = false;
    failMe = true;
    docFromPhone = true;
    const n0 = writes.length, l0 = loaded.length, g0 = logged.length, d0 = docsFromPhone;
    await cdp.send("Page.navigate", { url: "about:blank" }, S); await sleep(150);
    await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/split")}` }, S);
    await appSettled(cdp, S);
    await sleep(9000);                      // past the first retry (5 s)
    check("/api/me was asked and could not answer", meAsked > 0, String(meAsked));
    check("the trip's document came from the phone, once: the page was not loaded again", docsFromPhone - d0 === 1 && loaded.slice(l0).filter((u) => u.startsWith("/t/")).length === 1,
      `${docsFromPhone - d0} from the phone · loaded: ${loaded.slice(l0).join(" , ")}`);
    const stillWaiting = await inForget(`return f.waitingChanges();`);
    check("the phone still holds A's waiting change: nobody has said whose session this is", stillWaiting === 1,
      `${stillWaiting} waiting · at ${await page(`location.pathname + location.hash`)} · documents loaded: ${loaded.slice(l0).join(" , ")} · cookies: ${(await cdp.send("Network.getCookies", { urls: [BASE] }, S)).cookies.map((c) => `${c.name}=${c.value.slice(0, 12)}`).join(" ")} · logged: ${logged.slice(g0).join(" | ").slice(0, 900)}`);
    const sent = writes.slice(n0);
    check("and none of it was sent while that was unknown", sent.length === 0, JSON.stringify(sent).slice(0, 300));
    failMe = false;
    docFromPhone = false;
    await setWho("");
    await waitFor(cdp, S, `(async () => { const f = await import("/js/forget.js"); return (await f.waitingChanges()) === 0 ? 1 : 0; })()`, { label: "the phone being cleared once /api/me answers", timeout: 40000 });
    await sleep(1500);
    const st = await stored();
    check("once /api/me answers as B, nothing stored is A's", !rowsIn(st).includes(a.purchase) && !rowsIn(st).includes(made.kit));
    check("and still nothing of A's was sent", writes.slice(n0).length === 0 && !(await serverPurchases()).some(([id]) => id === a.purchase), JSON.stringify(writes.slice(n0)).slice(0, 300));
    await leaveApp();
  }

  for (const withCookie of [true, false]) {
    section(withCookie ? "4. The same account signs back in; the cookie is there" : "4b. The same account signs back in; no readable cookie");
    const a = await aLeavesAWrite(withCookie ? "same-cookie" : "same-nocookie");
    await leaveApp();
    await endSession();
    await signInAs(cdp, S, A);
    await setWho(withCookie ? a.id : "");
    blockWrites = false;
    const n0 = writes.length;
    await go("#/split");
    const drained = await waitFor(cdp, S, `(async () => { const f = await import("/js/forget.js"); return (await f.waitingChanges()) === 0 ? 1 : 0; })()`, { label: "the queue draining", timeout: 30000 }).then(() => true, () => false);
    check("the waiting change was sent after A signed back in", drained);
    const posts = writes.slice(n0).filter((w) => w.method === "POST" && w.url.startsWith(tripApi("/purchases")) && w.body.includes(a.purchase));
    check("exactly once", posts.length === 1, `${posts.length} POSTs`);
    check("and the server has it", (await serverPurchases()).some(([id]) => id === a.purchase));
    check("A sees it", await page(`document.documentElement.textContent.includes(${JSON.stringify(TAG)})`));
    await inStore(`await store.deletePurchase(${JSON.stringify(a.purchase)}); return 1;`);
    await waitFor(cdp, S, `(async () => { const { store } = await import("/js/store.js"); return store.pending() === 0 ? 1 : 0; })()`, { label: "the purchase being removed again" });
    made.purchases = made.purchases.filter((id) => id !== a.purchase);
  }

  section("5. The session ends on the server; the phone still has its cookies");
  {
    const a = await aLeavesAWrite("ended-elsewhere");
    await leaveApp();
    const jar = (await cdp.send("Network.getCookies", { urls: [BASE] }, S)).cookies.filter((c) => ["wgp_session", forget.WHO_COOKIE].includes(c.name));
    check("the phone holds a session cookie and the readable one", jar.length === 2, jar.map((c) => c.name).join(" "));
    blockWrites = false;
    const out = await page(`fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) => r.status)`);
    check("the session is ended on the server", out === 200 || out === 204, String(out));
    for (const c of jar) await cdp.send("Network.setCookie", { name: c.name, value: c.value, domain: HOST, path: "/", httpOnly: c.httpOnly }, S);
    const n0 = writes.length;
    await cdp.send("Page.navigate", { url: "about:blank" }, S); await sleep(150);
    await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/split")}` }, S);
    const atSignIn = await waitFor(cdp, S, `location.pathname.startsWith("/login") ? 1 : 0`, { label: "the app going to sign-in", timeout: 20000 }).then(() => true, () => false);
    check("the app was told it is signed out and went to sign-in", atSignIn, await page(`location.href`));
    await sleep(600);
    const left = (await cdp.send("Network.getCookies", { urls: [BASE] }, S)).cookies.map((c) => c.name);
    check("the server cleared its readable cookie with that answer", !left.includes(forget.WHO_COOKIE), left.join(" "));
    const st = await stored();
    check("the trip and the waiting purchase are still on the phone", rowsIn(st).includes(a.purchase) && (await inForget(`return f.waitingChanges();`)) === 1);
    check("the phone was not cleared: its epoch never moved", !st.keys.includes("wgp.epoch"), st.keys.join(" "));
    await quiet();
    await signInAs(cdp, S, A);
    check("the server recorded nothing while signed out", !(await serverPurchases()).some(([id]) => id === a.purchase),
      JSON.stringify(writes.slice(n0)).slice(0, 300));
    const n1 = writes.length;
    await go("#/split");
    const drained = await waitFor(cdp, S, `(async () => { const f = await import("/js/forget.js"); return (await f.waitingChanges()) === 0 ? 1 : 0; })()`, { label: "the queue draining", timeout: 30000 }).then(() => true, () => false);
    check("A signs back in and the waiting change is sent", drained);
    const ok = writes.slice(n1).filter((w) => w.method === "POST" && w.url.startsWith(tripApi("/purchases")) && w.body.includes(a.purchase));
    check("exactly once", ok.length === 1, `${ok.length} POSTs after signing back in`);
    check("and the server has it", (await serverPurchases()).some(([id]) => id === a.purchase));
    await inStore(`await store.deletePurchase(${JSON.stringify(a.purchase)}); return 1;`);
    await waitFor(cdp, S, `(async () => { const { store } = await import("/js/store.js"); return store.pending() === 0 ? 1 : 0; })()`, { label: "the purchase being removed again" });
    made.purchases = made.purchases.filter((id) => id !== a.purchase);
  }

  section("afterwards");
  await leaveApp(); await endSession(); await signInAs(cdp, S, A); blockWrites = false; await go("#/split");
  if (made.kit) {
    await inStore(`await store.deletePacking(${JSON.stringify(made.kit)}); return 1;`);
    await waitFor(cdp, S, `(async () => { const { store } = await import("/js/store.js"); return store.pending() === 0 ? 1 : 0; })()`, { label: "the kit item being removed" });
    made.kit = null;
  }
  // Kit items too: a run that was stopped half way, or a held copy that got one through.
  await inStore(`await store.refresh(); return 1;`).catch(() => {});
  const strayKit = JSON.parse(await inStore(`return JSON.stringify(store.packing(store.me().id).filter((r) => String(r.label).startsWith("forget-check ")).map((r) => [r.id, r.label]));`));
  for (const [id] of strayKit) await inStore(`await store.deletePacking(${JSON.stringify(id)}); return 1;`).catch((e) => console.log(`  could not remove ${id}: ${e.message}`));
  if (strayKit.length) {
    await waitFor(cdp, S, `(async () => { const { store } = await import("/js/store.js"); return store.pending() === 0 ? 1 : 0; })()`, { label: "leftover kit items being removed" });
    console.log(`  note  removed ${strayKit.length} kit item(s) a failed run left behind`);
  }
  check("this run left no kit item behind on the server", strayKit.filter(([, l]) => String(l).includes(TAG)).length === 0, strayKit.map((x) => x[1]).join("; "));
  // Anything a failed run (this one or an earlier one) left on the server goes, by its tag.
  const strays = (await serverPurchases()).filter(([, d]) => String(d).startsWith("forget-check "));
  for (const [id] of strays) {
    await inStore(`await store.refresh(); await store.deletePurchase(${JSON.stringify(id)}); return 1;`).catch((e) => console.log(`  could not remove ${id}: ${e.message}`));
  }
  if (strays.length) {
    await waitFor(cdp, S, `(async () => { const { store } = await import("/js/store.js"); return store.pending() === 0 ? 1 : 0; })()`, { label: "leftovers being removed" });
    console.log(`  note  removed ${strays.length} purchase(s) a failed run left behind`);
  }
  check("this run left no purchase behind on the server", strays.filter(([, d]) => String(d).includes(TAG)).length === 0, strays.map((x) => x[1]).join("; "));
  const after = await serverPurchases();
  check("the trip has the purchases it started with", after.length === before && !after.some(([, d]) => String(d).includes(TAG)), `${before} before, ${after.length} after`);
  check("no page error in the whole run", b.pageErrors.length === 0, b.pageErrors.join(" | ").slice(0, 500));
} finally {
  await b.done();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:"); for (const f of failures) console.log(`  ${f}`); process.exit(1); }

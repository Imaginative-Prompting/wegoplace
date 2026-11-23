// The site's second address (www.) in a real browser, on a server of its own: http://localhost:<port>
// is the site's address and http://www.localhost:<port> the second (Chrome sends *.localhost to
// this machine). Each part is a browser of its own, with the app's service worker on, as a phone has:
//
//   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
//     --label "www in a browser" -- node checks/www/browser.mjs [--port <port>] [--shots <folder>]
//
// It holds:
//   1. a new visitor at the second address lands on the same page (path, query, fragment) at the
//      first, and the second address keeps NOTHING of that visit (no localStorage, no
//      IndexedDB, no caches, no service worker, no cookie), so a second visit is sent on too;
//   2. the three reasons to stay, each alone: running as the installed app (display-mode
//      standalone); this address's service worker already in control; anything in this
//      address's localStorage;
//   3. staying, everything works there: signed in (the one-use link: Chrome takes RP_ID
//      "localhost" only at localhost itself, so a passkey in the page is held at the server by
//      check:www instead), a trip made from the page, its page opening its live socket;
//   4. what the app prints for someone else, from a page there, is the first address's: the
//      Connect your AI sheet (its address and Claude Code's command) from each way in (a new
//      trip's "Plan it with your AI", More's AI apps, Your account), a join link made on People,
//      and site.js's address for a shared board.
// Everyone in it is made up.

import fs from "node:fs";
import path from "node:path";
import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { makeLink } from "../../tools/signin-link.mjs";
import { openChrome } from "../lib/chrome.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8845);
const shots = flag("--shots");
if (shots) fs.mkdirSync(shots, { recursive: true });
const t = new Report("the second address in a browser");
const MAIN = `http://localhost:${port}`;
const WWW = `http://www.localhost:${port}`;
const PHONE = { width: 390, height: 844, mobile: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (page, name) => { if (shots) await page.shot(path.join(shots, `${name}.png`)); };

/** The open Connect your AI sheet's address and Claude Code's command, read from its code blocks; then it is closed. */
async function sheetSays(page, what) {
  const said = await page.until(`(() => { const r = document.querySelector(".sh-root[data-open='1']"), a = r && r.querySelector(".pa-step1 .pa-code code");
    if (!a || !/\\/mcp$/.test(a.textContent)) return null;
    r.querySelector('[data-pa-pick="code"]').click(); const c = r.querySelector(".pa-step1 .pa-code code"); return [a.textContent, c ? c.textContent : ""]; })()`, what);
  await page.eval(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
  await page.until(`document.querySelector(".sh-root[data-open='1']") ? 0 : 1`, `${what} to close`);
  return said;
}

/** Everything a browser keeps for an address, read from outside the page. */
async function keptAt(page, origin) {
  await page.send("DOMStorage.enable").catch(() => {});
  const local = (await page.send("DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: origin, isLocalStorage: true } }).catch(() => ({ entries: [] }))).entries;
  const idb = (await page.send("IndexedDB.requestDatabaseNames", { securityOrigin: origin }).catch(() => ({ databaseNames: [] }))).databaseNames;
  const caches = (await page.send("CacheStorage.requestCacheNames", { securityOrigin: origin }).catch(() => ({ caches: [] }))).caches;
  const usage = await page.send("Storage.getUsageAndQuota", { origin }).catch(() => null);
  const workers = usage?.usageBreakdown?.find((b) => b.storageType === "service_workers")?.usage ?? 0;
  const cookies = (await page.send("Network.getCookies", { urls: [`${origin}/`] })).cookies;
  return { local: local.length, idb: idb.length, caches: caches.length, workers, cookies: cookies.length };
}
const nothing = { local: 0, idb: 0, caches: 0, workers: 0, cookies: 0 };

let server, chrome, code = 1;
try {
  server = await startServer({ name: "www-browser", port, vars: { ALSO_ORIGINS: WWW } });
  await server.start();
  chrome = await openChrome();

  t.part("1. A new visitor at the second address");
  const visitor = await chrome.page({ ...PHONE, serviceWorker: true });
  // The address each page is asked for, as the browser asks (the page itself may tidy its own
  // address after it loads: the trips page does).
  const asked = [];
  visitor.on((m) => { if (m.method === "Network.requestWillBeSent" && m.params.type === "Document") asked.push(m.params.request.url); });
  await visitor.open(`${WWW}/trips?from=a-card#top`);
  await visitor.until(`location.origin === ${JSON.stringify(MAIN)} && document.readyState === "complete"`, "the visitor to land at the first address");
  t.same("asked for at the second address, the same page is asked for at the first: path and query (the fragment goes with it)",
    asked.slice(0, 2), [`${WWW}/trips?from=a-card`, `${MAIN}/trips?from=a-card`]);
  await sleep(2500);                                            // anything left running would have run by now
  t.same("the second address keeps nothing of the visit", await keptAt(visitor, WWW), nothing);
  await visitor.open(`${WWW}/login`);
  t.same("so the next visit is sent on too", await visitor.until(`location.origin === ${JSON.stringify(MAIN)} ? location.pathname : null`, "the second visit"), "/login");
  await visitor.close();

  // The fragment, on a page that keeps its address: the sign-in page.
  const hashed = await chrome.page({ ...PHONE, serviceWorker: true });
  await hashed.open(`${WWW}/login?next=%2Ftrips#ai-apps`);
  const hashLanded = await hashed.until(`location.origin === ${JSON.stringify(MAIN)} && document.readyState === "complete" ? location.pathname + location.search + location.hash : null`, "the sign-in page at the first address");
  t.same("  and the fragment arrives too (the sign-in page keeps its address)", hashLanded, "/login?next=%2Ftrips#ai-apps");
  await hashed.close();

  t.part("2. The reasons to stay, each alone");
  // An iPhone's Home Screen app says so with navigator.standalone, before any of the page runs.
  const homeScreen = await chrome.page({ ...PHONE, serviceWorker: true, before: `Object.defineProperty(Navigator.prototype, "standalone", { get: () => true, configurable: true });` });
  await homeScreen.goto(`${WWW}/login`);
  await sleep(1500);
  t.same("running as the iPhone's Home Screen app (navigator.standalone): it stays", await homeScreen.eval("location.origin"), WWW);
  await homeScreen.close();
  // An installed app elsewhere: display-mode standalone, as the browser emulates it.
  const installed = await chrome.page({ ...PHONE, serviceWorker: true });
  await installed.send("Emulation.setEmulatedMedia", { features: [{ name: "display-mode", value: "standalone" }] });
  await installed.goto(`${MAIN}/login`);
  const emulated = await installed.eval(`matchMedia("(display-mode: standalone)").matches`);
  if (emulated) {
    await installed.goto(`${WWW}/login`);
    await sleep(1500);
    t.same("running as an installed app (display-mode standalone): it stays", await installed.eval("location.origin"), WWW);
  } else console.log("  note  this browser doesn't emulate display-mode, so that reason is held by navigator.standalone's above");
  await installed.close();

  // Something this address already keeps, there before any of the page runs.
  const kept = await chrome.page({ ...PHONE, serviceWorker: true, before: `if (location.hostname.indexOf("www.") === 0 && !sessionStorage.getItem("check.planted")) { sessionStorage.setItem("check.planted", "1"); localStorage.setItem("wgp.theme", "dark"); }` });   // once: part 2's last holds the worker alone
  await kept.goto(`${WWW}/login`);
  await sleep(1500);
  t.same("something in this address's localStorage: it stays", await kept.eval("location.origin"), WWW);

  t.part("3. Staying, the app works there");
  // Signed in there by the one-use link, as the page's own button does it. (A passkey in the page
  // can't be tried on this pair: Chrome takes RP_ID "localhost" only at localhost itself, never
  // at a name under it, where a real domain's www. is fine. check:www holds passkeys there at
  // the server, made and used for the second address's page.)
  const ada = new Person(MAIN, "Ada Reyes");
  if ((await ada.signUp()).status !== 200) throw new CheckError("couldn't make the account");
  const link = makeLink({ who: ada.user.id, origin: MAIN, hours: 1 });
  server.sql(link.sql);
  const used = await kept.eval(`fetch("/api/auth/link", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ token: ${JSON.stringify(link.url.split("/").pop())} }) }).then((r) => r.status)`);
  const who = await kept.eval(`fetch("/api/me", { credentials: "same-origin", headers: { Accept: "application/json" } }).then((r) => r.json()).then((j) => j && j.id)`);
  t.same("signed in there by the one-use link", [used, who], [200, ada.user.id]);
  const tripId = await kept.eval(`fetch("/api/trips", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ name: "Coast week", default_tz: "UTC" }) }).then((r) => r.json()).then((j) => j.trip && j.trip.id)`);
  t.ok("a trip is made from the page there", typeof tripId === "string" && tripId.length > 8, tripId);
  const sockets = [];
  const off = kept.on((m) => {
    if (m.method === "Network.webSocketCreated") sockets.push({ id: m.params.requestId, url: m.params.url });
    if (m.method === "Network.webSocketHandshakeResponseReceived") { const s = sockets.find((x) => x.id === m.params.requestId); if (s) s.status = m.params.response.status; }
  });
  await kept.goto(`${WWW}/t/${tripId}/`);
  await kept.until(`document.querySelector("#view") && document.querySelector(".tabbar, nav") ? 1 : 0`, "the trip's page", 20000);
  for (let i = 0; i < 50 && !sockets.some((s) => s.status === 101); i++) await sleep(200);
  off();
  t.ok("the trip's page opens its live socket there", sockets.some((s) => s.status === 101 && s.url.startsWith(`ws://www.localhost:${port}/`)), JSON.stringify(sockets));
  await shot(kept, "www-trip");

  t.part("4. What the app prints for someone else");
  // How to connect is the one sheet (js/plan-ai.js), from each of its ways in: its address is the site's own, not www's.
  const theFirst = [`${MAIN}/mcp`, `claude mcp add --transport http wegoplace ${MAIN}/mcp`];
  await kept.goto(`${WWW}/t/${tripId}/#/`);
  await kept.until(`document.querySelector("#view [data-plan-ai]") ? 1 : 0`, "the new trip's first screen", 20000);
  await kept.click("#view [data-plan-ai]");
  t.same("from a new trip's Plan it with your AI: the first address", await sheetSays(kept, "the sheet from the trip"), theFirst);
  await kept.goto(`${WWW}/t/${tripId}/#/settings`);
  await kept.until(`document.querySelector("#view #st-apps") ? 1 : 0`, "the trip's More");
  await kept.click("#view #st-apps");
  t.same("from More's AI apps: the first address", await sheetSays(kept, "the sheet from More"), theFirst);
  await kept.goto(`${WWW}/account#ai-apps`);
  await kept.until(`!!document.getElementById("apps-connect") && !document.getElementById("account").hidden ? 1 : 0`, "the account page");
  await kept.click("#apps-connect");
  await shot(kept, "www-ai-card");
  t.same("from Your account's Connect your AI: the first address", await sheetSays(kept, "the sheet from Your account"), theFirst);
  await kept.goto(`${WWW}/trips/${tripId}`);
  await kept.eval(`(() => { const d = document.querySelector(".tr-linkset"); if (d) d.open = true; return 1; })()`);   // Make a link is under Link settings
  await kept.click("#btn-link");
  const joinUrl = await kept.until(`(() => { const u = document.getElementById("made-url"); return u && u.value && !document.getElementById("made").hidden ? u.value : null; })()`, "the join link");
  t.ok("a join link made on People: the first address", joinUrl.startsWith(`${MAIN}/join/`), joinUrl);
  await shot(kept, "www-join-link");
  t.same("a shared board's link (site.js): the first address", await kept.eval(`import("/js/site.js").then((s) => s.siteUrl("/s/abc"))`), `${MAIN}/s/abc`);

  t.part("2, again. This address's service worker, alone");
  const controlled = await kept.eval("!!navigator.serviceWorker.controller");
  await kept.send("DOMStorage.clear", { storageId: { securityOrigin: WWW, isLocalStorage: true } });
  await kept.open(`${WWW}/login`);
  await sleep(2500);
  t.same("with its worker in control and its localStorage cleared: it stays", [controlled, await kept.eval("location.origin")], [true, WWW]);

  const errors = kept.errors.filter((e) => !/Failed to load resource/.test(e));
  t.same("no error in the page there", errors, []);
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await chrome?.close().catch(() => {});
  await server?.stop();
}
process.exit(code);

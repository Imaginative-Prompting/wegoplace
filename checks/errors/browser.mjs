// HOW WE KNOW IT BROKE, IN A BROWSER: the page's own reporter (public/js/error-report.js) on a trip's page in Chrome for
// Testing, against a server of its own. Every report the page sends is seen as it leaves (DevTools' network events) and
// as the server keeps it (error_groups). It holds:
//   1. a trip opened, settled: nothing reported;
//   2. an error the page didn't catch, thrown twice: one report, cleaned (no trip name, no address), kept once; the
//      fingerprint the site answers with kept on the device (wgp.errorGroups.v1, which a bug report sends along);
//   3. what's called off on purpose (an AbortError thrown, a fetch aborted): nothing reported;
//   4. a fetch that fails while the device is offline: nothing reported; the same failure online: reported (so it was the
//      being offline that held it back, not the failure);
//   5. the store's "sync keeps failing" event: one report of its kind, its status and tries only;
//   6. the reporter itself logs nothing: every page error is one this check threw.
// Everyone in it is made up.
//
//   node checks/errors/browser.mjs [--port 8862]

import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";

const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 8862);
const t = new Report("how we know it broke, in a browser");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRIP = "Lagoon Weekend Browser";
const MARK = "planted-by-the-check";

let server, chrome, code = 1;
try {
  server = await startServer({ name: "errors-browser", port });
  await server.start();
  const origin = server.origin;
  const ada = new Person(origin, "Ines Browser");
  await ada.signUp();
  const trip = (await ada.post("/api/trips", { name: TRIP, default_tz: "UTC" })).json.trip.id;
  const rows = () => server.sql("SELECT fingerprint, kind, name, message, place, count FROM error_groups WHERE source = 'client' ORDER BY first_seen");

  chrome = await openChrome();
  const page = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
  await page.setCookie(origin, "wgp_session", ada.jar.cookies.get("wgp_session"));
  await page.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(ada.user.id), sameSite: "Lax" });
  // Every report as it leaves the page: a POST to /api/errors, attempted (it may then fail, as offline).
  const posts = [];
  page.on((m) => {
    const r = m.method === "Network.requestWillBeSent" && m.params.request;
    if (r && r.method === "POST" && new URL(r.url).pathname === "/api/errors") posts.push(JSON.parse(r.postData ?? "null"));
  });
  const reportsDuring = async (what, ms = 1500) => { const before = posts.length; await page.eval(what); await sleep(ms); return posts.slice(before); };
  // The reporter keeps an error only with a frame of the site's own code in it (a browser extension's is not ours), so
  // the planted faults are thrown from a file the page loads from its own /js/: this check serves it, by DevTools'
  // interception, and it is never on the server.
  const PLANTED = `window.__plant = {
    throwIt(m) { setTimeout(function plantedThrow() { throw new TypeError(m); }, 0); },
    fetchIt(u) { fetch(u); },
    abortIt(m) {
      setTimeout(function plantedAbort() { throw new DOMException(m, "AbortError"); }, 0);
      const c = new AbortController(); fetch("/api/trips", { signal: c.signal }); c.abort();
    },
  };`;
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/check-planted.js*", requestStage: "Request" }] });
  page.on((m) => {
    if (m.method !== "Fetch.requestPaused") return;
    page.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }], body: Buffer.from(PLANTED).toString("base64") }).catch(() => {});
  });

  t.part("1. A trip's page, opened and settled");
  await page.open(`${origin}/t/${trip}/`);
  await page.until(`!!document.querySelector("main#view") && document.readyState === "complete"`, "the trip's page", 30000);
  await sleep(2500);
  t.same("nothing reported by a page that works", posts.length, 0);
  await page.eval(`new Promise((ok, no) => { const s = document.createElement("script"); s.src = "/js/check-planted.js"; s.onload = ok; s.onerror = () => no(new Error("the planted file didn't load")); document.head.append(s); })`);
  // The router writes "#/" into a trip's address: the screen is the trip's first.
  const PLACE = "/t/:trip/#/";

  t.part("2. An error the page didn't catch");
  const thrown = await reportsDuring(`__plant.throwIt(${JSON.stringify(`${MARK}: no plan for ${TRIP}, ask ada@example.com`)});
    setTimeout(() => __plant.throwIt(${JSON.stringify(`${MARK}: no plan for ${TRIP}, ask ada@example.com`)}), 50); 0`);
  t.same("thrown twice, sent once, cleaned on the page: the address gone, the screen by its pattern",
    [thrown.length, thrown[0]?.kind, thrown[0]?.name, /@/.test(thrown[0]?.message ?? "@"), thrown[0]?.place], [1, "error", "TypeError", false, PLACE]);
  const kept = rows().filter((r) => r.message.includes(MARK));
  t.same("kept once by the server, the trip's name taken out there too", [kept.length, kept[0]?.count, kept[0]?.message.includes(TRIP), /@/.test(kept[0]?.message ?? "@")],
    [1, 1, false, false]);
  // The site answers with the kind it was counted in, and this device keeps it (a bug report sends it along): that row's.
  const keptHere = JSON.parse(await page.eval(`localStorage.getItem("wgp.errorGroups.v1") ?? "[]"`));
  t.same("  this device keeps the kind's fingerprint the site answered with, and nothing else of it", keptHere, [kept[0]?.fingerprint]);

  t.part("3. What's called off on purpose");
  const aborted = await reportsDuring(`__plant.abortIt(${JSON.stringify(`${MARK}: called off`)}); 0`);
  t.same("an AbortError thrown, and a fetch aborted with nobody waiting for it: nothing reported", aborted.length, 0);

  t.part("4. Offline, then online");
  const failing = `__plant.fetchIt("http://127.0.0.1:9/${MARK}"); 0`;  // a port nothing answers on: a TypeError, "Failed to fetch"
  await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.until(`navigator.onLine === false`, "the page offline", 5000);
  const whileOffline = await reportsDuring(failing);
  await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.until(`navigator.onLine === true`, "the page online", 5000);
  t.same("a fetch that fails while the device is offline: nothing reported", whileOffline.length, 0);
  const whileOnline = await reportsDuring(failing);
  t.same("  the same failure online is reported (it was being offline that held it back)",
    [whileOnline.length, whileOnline[0]?.kind, whileOnline[0]?.name], [1, "rejection", "TypeError"]);

  t.part("5. A sync that keeps failing");
  const sync = await reportsDuring(`dispatchEvent(new CustomEvent("wgp:sync-failing", { detail: { status: 503, tries: 5, changes: ["${MARK}"] } })); 0`);
  t.same("one report of its kind: its status and tries, nothing of the changes",
    [sync.length, sync[0]?.kind, sync[0]?.name, JSON.stringify(sync[0] ?? {}).includes(MARK)], [1, "sync", "SyncFailing", false]);
  t.same("  kept by the server as a sync group", rows().filter((r) => r.kind === "sync").map((r) => [r.name, r.place, r.count]), [["SyncFailing", PLACE, 1]]);

  t.part("6. The reporter says nothing on the page");
  // What this check threw: its marked errors, the failed fetches, and the fetch it aborted (an AbortError nobody caught).
  const others = page.errors.filter((e) => !e.includes(MARK) && !/Failed to fetch|AbortError/.test(e));
  t.same("every page error is one this check threw; nothing logged by the reporter", [others, page.errors.filter((e) => e.startsWith("console.error")).length],
    [[], 0]);
  t.same("  and the page sent no report this check didn't cause", posts.map((p) => [p?.kind, p?.name]), [["error", "TypeError"], ["rejection", "TypeError"], ["sync", "SyncFailing"]]);
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await chrome?.close();
  await server?.stop();
}
process.exit(code);

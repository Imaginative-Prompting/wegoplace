#!/usr/bin/env node
/* The app's own address "/" before it has gone on to the trip (public/index.html, html[data-home]):
 * no tab bar and nothing that looks like a trip, so a tap there changes nothing; a quiet "Opening
 * your trip…" if it takes more than a moment; then the trip, its tab bar back.
 *
 *   node scripts/gate.mjs --only home_shell_check
 *
 * The made-up trip's host, at 390 with a phone's safe area. The page is held at "/" by holding one
 * of its modules (store.js) for 3 s, as a slow phone after an update did (15 Nov: 3 s on an iPhone,
 * three taps on this page's tab bar, and the address was "/#/split"). The trip's page itself keeps
 * its tab bar from the first frame. "/#/split" still opens Split.
 *
 * PLANTED (red when put in by hand): index.html without the data-home line: the tab bar shows and
 * the tap moves the address.
 */
import { BASE, appSettled, boot, evalIn, signInAs, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { TRIP, HOST } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}

const HOLD_MS = 3000;
const b = await boot({ vw: 390, vh: 844, dsf: 1 });
const { cdp, S } = b;
try {
  await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });
  await signInAs(cdp, S, HOST.id);
  const page = (e) => evalIn(cdp, S, e);
  // Hold store.js while asked: the page stays at "/" that long.
  let holding = false;
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `${BASE}/js/store.js*` }] }, S);
  cdp.on(async (m) => {
    if (m.sessionId !== S || m.method !== "Fetch.requestPaused") return;
    if (holding) await sleep(HOLD_MS);
    try { await cdp.send("Fetch.continueRequest", { requestId: m.params.requestId }, S); } catch { /* the page went away */ }
  });
  const READ = `JSON.stringify((() => { const t = document.querySelector(".tabbar"), s = document.querySelector("#view > .stack"), w = document.querySelector(".home-wait");
    const shown = (n) => !!n && getComputedStyle(n).display !== "none" && n.getBoundingClientRect().height > 0;
    return { path: location.pathname, hash: location.hash, home: document.documentElement.dataset.home || "", tabbar: shown(t), cards: shown(s),
      wait: shown(w) ? Number(getComputedStyle(w).opacity).toFixed(2) : "none", words: w ? w.textContent : "" }; })())`;

  // 1. The trip's page has its tab bar from the first frame (no data-home there); the phone
  //    keeps the trip, as a phone that had the app does, so "/" then goes to it.
  holding = true;
  await cdp.send("Page.navigate", { url: "about:blank" }, S);
  await sleep(150);
  await cdp.send("Page.navigate", { url: `${BASE}/t/${TRIP}/` }, S);
  await waitFor(cdp, S, `location.pathname === ${JSON.stringify(`/t/${TRIP}/`)} && document.querySelector(".tabbar") ? 1 : 0`, { label: "the trip's page" });
  await sleep(200);
  const tp = JSON.parse(await page(READ));
  check("the trip's page shows its tab bar from the first frame", tp.home === "" && tp.tabbar, JSON.stringify(tp));
  holding = false;
  await appSettled(cdp, S);
  // The phone keeps the trip once its store has the trip (store.js noteOpened): "/" goes to it then.
  await waitFor(cdp, S, `(localStorage.getItem("wgp.kept") || "").includes(${JSON.stringify(TRIP)}) ? 1 : 0`, { label: "the trip kept on the phone", timeout: 20000 });

  // 2. "/" held: what shows, and a tap where the tab bar would be.
  holding = true;
  await cdp.send("Page.navigate", { url: "about:blank" }, S);
  await sleep(150);
  await cdp.send("Page.navigate", { url: `${BASE}/` }, S);
  await waitFor(cdp, S, `location.pathname === "/" && document.documentElement ? 1 : 0`, { label: "the page at /" });
  await sleep(200);
  const early = JSON.parse(await page(READ));
  check("at \"/\" before it knows the trip: no tab bar and no placeholder cards", early.path === "/" && early.home === "1" && !early.tabbar && !early.cards, JSON.stringify(early));
  check("… and no words in the first moment", early.wait === "none" || Number(early.wait) < 0.2, JSON.stringify(early));
  for (const x of [40, 121, 201, 280, 350]) {
    for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x, y: 844 - 34 - 24, button: "left", clickCount: 1 }, S);
  }
  await sleep(1000);
  const held = JSON.parse(await page(READ));
  check("taps where the tab bar would be change nothing: still \"/\", no \"#/…\"", held.path === "/" && held.hash === "", JSON.stringify(held));
  check("after a moment it says \"Opening your trip…\", quietly", held.words === "Opening your trip…" && Number(held.wait) > 0.9, JSON.stringify(held));
  await waitFor(cdp, S, `location.pathname === ${JSON.stringify(`/t/${TRIP}/`)} ? 1 : 0`, { label: "the trip", timeout: 20000 })
    .catch(async (e) => { console.log("  DIAG went to", await page(`location.href + " · kept: " + Object.keys(localStorage).filter((k) => k.startsWith("wgp")).map((k) => k + "=" + localStorage.getItem(k).slice(0, 160)).join(" | ")`)); throw e; });
  holding = false;
  await appSettled(cdp, S);
  await sleep(600);
  const trip = JSON.parse(await page(READ));
  check("then the trip, its tab bar back, no words", trip.path === `/t/${TRIP}/` && trip.home === "" && trip.tabbar && trip.wait === "none", JSON.stringify(trip));

  // 3. "/#/split" still opens Split on the trip.
  await cdp.send("Page.navigate", { url: "about:blank" }, S);
  await sleep(150);
  await cdp.send("Page.navigate", { url: `${BASE}/#/split` }, S);
  await waitFor(cdp, S, `location.pathname === ${JSON.stringify(`/t/${TRIP}/`)} && location.hash === "#/split" ? 1 : 0`, { label: "Split on the trip", timeout: 20000 })
    .then(() => check("\"/#/split\" still opens Split on the trip", true), () => check("\"/#/split\" still opens Split on the trip", false, "never got there"));

  check("no page error", b.pageErrors.length === 0, b.pageErrors.join(" | ").slice(0, 300));
} finally { await b.done(); }

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

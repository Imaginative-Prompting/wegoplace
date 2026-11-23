#!/usr/bin/env node
/* ACCESSIBILITY, AS axe-core JUDGES IT (scripts/lib/axe.mjs: the WCAG 2.0–2.2 A and AA rules), on every screen
 * a person reaches inside a trip, the made-up trip's host, at 390 and 1440, light and dark:
 *
 *   the six sections (Itinerary, Places with its map, Split, Photos, Chat, More) and their pages (a plan,
 *   a place, a purchase), Packing, Changes, the image credits, People and settings, Your trips, Your
 *   account; and every add sheet open (a plan, a place, a purchase, an item, a memory) and Settle up.
 *
 * Zero serious or critical violations; every finding (moderate and minor too) is printed by screen and rule.
 * What axe can't judge (its "incomplete" results) is not claimed. The pages a stranger or a new person
 * sees (sign-in, Make a trip on a new account, the assistant's tab, a shared board) are a11y_public_check's.
 *
 *   node scripts/gate.mjs --only a11y_check
 *
 * PLANTED (red when put in by hand, 16 Nov): split.js's + without its name (button-name, critical, on
 * Split at every width); sheet.js's dialog without its label (aria-dialog-name, serious, on every sheet).
 */
import fs from "node:fs";
import path from "node:path";
import { BASE, boot, evalIn, waitFor, sleep, appSettled } from "./lib/standalone_cdp.mjs";
import { tripPath, TRIP } from "./lib/gate_trip.mjs";
import { axeOn, blocking, line, AXE_VERSION } from "./lib/axe.mjs";
import { pickPhotos, cdpPage, madePhoto } from "./lib/photo_picker.mjs";

const OUT = process.env.WGP_A11Y_OUT || "";      // optional: every finding as JSON, for the report
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 2000) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

const b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: true });
const { cdp, S } = b;
const page = (expr) => evalIn(cdp, S, expr);
const evaluate = (expression) => cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, S);
const go = async (url, ready) => {
  await cdp.send("Page.navigate", { url: "about:blank" }, S);
  await sleep(100);
  await cdp.send("Page.navigate", { url }, S);
  await appSettled(cdp, S).catch(() => {});
  await waitFor(cdp, S, `${ready} ? 1 : 0`, { label: url, timeout: 30000 });
  await sleep(900);
};
const inTrip = (hash) => `${BASE}${tripPath(hash)}`;
const openSheet = async (tap) => {
  await page(`(() => { const n = ${tap}; if (!n) return 0; n.click(); return 1; })()`);
  await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1'] .sh-sheet") ? 1 : 0`, { label: "the sheet", timeout: 10000 });
  await sleep(800);
};
const closeSheet = async () => {
  await page(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
  await sleep(700);
};
// The first of something on a screen, read from the page: a place's address, a purchase's id.
const first = (expr) => page(expr);

const all = [];
try {
  console.log(`axe-core ${AXE_VERSION}`);
  for (const [w, h, dsf, mobile] of [[390, 844, 2, true], [1440, 900, 1, false]]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dsf, mobile }, S);
    for (const scheme of ["light", "dark"]) {
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }] }, S);
      const tag = `${w}, ${scheme}`;
      section(tag);
      const found = [];
      const look = async (screen) => { const f = await axeOn(evaluate, `${screen} (${tag})`); found.push(...f); all.push(...f); };

      await go(inTrip("#/"), `document.querySelector("#view .ag-day")`);
      await look("Itinerary");
      await openSheet(`document.querySelector("#view [data-plan-add]") || document.querySelector("#rt-fixed .fab")`);
      await look("Itinerary: Add a plan");
      await closeSheet();
      await go(inTrip("#/e/e-02"), `document.querySelector("#view h1, #view h2")`);
      await look("A plan");

      await go(inTrip("#/places"), `document.querySelectorAll("#view .pl-row").length > 3`);
      await look("Places");
      const placeHref = await first(`(document.querySelector("#view a.pl-row") || {}).getAttribute ? document.querySelector("#view a.pl-row").getAttribute("href") : ""`);
      await openSheet(`document.querySelector("#view .pl-headadd") && getComputedStyle(document.querySelector("#view .pl-headadd")).display !== "none" ? document.querySelector("#view .pl-headadd") : document.querySelector("#rt-fixed .fab")`);
      await look("Places: Add a place");
      await closeSheet();
      if (w < 1024) {
        await go(inTrip("#/places?view=map"), `document.querySelector("#view .mp-root .mp-scale")`);
        await look("Places: the map");
      }
      if (placeHref) {
        await go(inTrip(placeHref), `document.querySelector("#view .pl-title h1")`);
        await look("A place");
      }

      await go(inTrip("#/split"), `document.querySelectorAll("#view .sp-row").length > 3`);
      await look("Split");
      await openSheet(`[...document.querySelectorAll("#view [data-act='add']")].find((n) => getComputedStyle(n).display !== "none") || document.querySelector("#rt-fixed .fab")`);
      await look("Split: Add a purchase");
      await closeSheet();
      // Settle up is a sheet where its button shows; on a wide window it stands beside the feed instead (Split's
      // two columns), and "Split" above has already read it there.
      const settle = String(await first(`(() => { const n = document.querySelector("#view .sp-settle"), w = document.querySelector("#view .sp-wide");
        return n && getComputedStyle(n).display !== "none" ? "sheet" : w && getComputedStyle(w).display !== "none" && w.querySelector(".sp-plan, .sp-bal") ? "beside" : "neither"; })()`));
      if (settle === "sheet") {
        await openSheet(`document.querySelector("#view .sp-settle")`);
        await look("Split: Settle up");
        await closeSheet();
      } else {
        check(`${w}: Split's Settle up stands beside the feed, read with Split`, settle === "beside", settle);
      }
      const buy = await first(`(([...document.querySelectorAll("#view .sp-row")].find((r) => r.dataset.kind !== "payment") || {}).dataset || {}).id || ""`);
      if (buy) {
        await go(inTrip(`#/split/${buy}`), `document.querySelector(".sh-root[data-open='1'] .sh-sheet")`);
        await look("A purchase");
        await closeSheet();
      }

      await go(inTrip("#/memories"), `document.querySelector("#view .me-top")`);
      await look("Photos");
      // Add photos opens the phone's picker first; answered with a made-up photo, its one sheet opens.
      await pickPhotos({ ...cdpPage(cdp, S), files: [madePhoto()],
        open: `[...document.querySelectorAll("#view .me-headadd")].find((n) => getComputedStyle(n).display !== "none") || document.querySelector("#rt-fixed .fab")` });
      await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1'] .sh-sheet") ? 1 : 0`, { label: "the Add photos sheet", timeout: 10000 });
      await sleep(800);
      await look("Photos: Add photos");
      await closeSheet();

      await go(inTrip("#/chat"), `document.querySelector("#view .ch-input, #view [class^='ch-']")`);
      await look("Chat");
      await go(inTrip("#/settings"), `document.querySelector("#view .st-title")`);
      await look("More");
      await go(inTrip("#/pack"), `document.querySelector("#view .pk-own")`);
      await look("Packing");
      await openSheet(`[...document.querySelectorAll("#view [data-act='add-item']")].find((n) => getComputedStyle(n).display !== "none") || document.querySelector("#rt-fixed .fab")`);
      await look("Packing: Add an item");
      await closeSheet();
      await go(inTrip("#/changes"), `document.querySelector("#view h1, #view .chg-line, #view .empty")`);
      await look("Changes");
      await go(inTrip("#/settings/credits"), `document.querySelector("#view h1, #view h2")`);
      await look("Image credits");

      await go(`${BASE}/trips/${encodeURIComponent(TRIP)}`, `document.querySelector("main, #page, body > *")`);
      await look("People and settings");
      await go(`${BASE}/trips`, `document.querySelector("#make-title")`);
      await look("Your trips");
      await go(`${BASE}/account`, `document.getElementById("yours")`);
      await look("Your account");

      const bad = found.filter(blocking);
      check(`${tag}: no serious or critical violation on any screen`, bad.length === 0, bad.map(line).join("\n          "));
      const rest = found.filter((f) => !blocking(f));
      console.log(rest.length ? `  moderate and minor (listed, not failed):\n    ${rest.map(line).join("\n    ")}` : "  moderate and minor: none");
    }
  }
  check("no exception reached the page", b.pageErrors.length === 0, b.pageErrors.join(" | ") || "clean");
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(all, null, 1));
  await b.done();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

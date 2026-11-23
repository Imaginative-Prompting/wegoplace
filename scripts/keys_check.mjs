#!/usr/bin/env node
/* A DESKTOP BY KEYS ALONE (the layouts, 16 Nov: "a desktop means a keyboard"), at 1440, the made-up
 * trip's host, in a real browser. Every step is a key press sent as a keyboard sends it:
 *
 *   1. From the top of the page, Tab meets the sidebar first, its six in order (Itinerary, Places,
 *      Split, Photos, Chat, More), each with a visible focus ring; the tab you are on carries
 *      aria-current="page", and only it. The next Tab goes on into the page.
 *   2. The day strip's arrow is reached by Tab and Enter moves the days.
 *   3. A plan opened by Enter on its card: its page opens beside the list and focus is on its
 *      heading (a screen reader says where you are).
 *   4. Esc in the plan's page closes it, back to the list. "+ Add a plan" by Enter: a dialog, focus
 *      inside it; Esc closes it and focus is back on "+ Add a plan".
 *
 *   node scripts/gate.mjs --only keys_check
 *
 * PLANTED (red when put in by hand): sheet.js not giving focus back on close (4); tabs.js without
 * barInReadingOrder (1: the page before the sidebar); router.js not focusing pane B's heading (3).
 */
import { BASE, boot, evalIn, waitFor, sleep, appSettled } from "./lib/standalone_cdp.mjs";
import { tripPath } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const J = async (cdp, S, expr) => JSON.parse(await evalIn(cdp, S, expr));

const b = await boot({ vw: 1440, vh: 900, dsf: 1, reduceMotion: true });
const { cdp, S } = b;
const KEYS = { Tab: [9, "Tab"], Enter: [13, "Enter"], Escape: [27, "Escape"] };
const press = async (key, shift = false) => {
  const [code, name] = KEYS[key];
  const base = { key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: shift ? 8 : 0 };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, S);
  if (key === "Enter") await cdp.send("Input.dispatchKeyEvent", { type: "char", ...base, text: "\r", unmodifiedText: "\r" }, S);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, S);
  await sleep(120);
};
// Where focus is: what, which tab, inside which pane, and whether a ring is drawn round it.
const AT = `JSON.stringify((() => { const a = document.activeElement; if (!a || a === document.body) return { none: true };
  const cs = getComputedStyle(a);
  const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== "none");
  const rail = a.dataset.railRow || (a.hasAttribute("data-rail-people") ? "people" : a.hasAttribute("data-rail-you") ? "you" : null);
  return { tag: a.tagName, tab: a.dataset.tab || rail || null, inBar: !!a.closest(".tabbar"), inA: !!a.closest(".rt-pane-a"), inB: !!a.closest(".rt-pane-b"), inSheet: !!a.closest(".sh-sheet"),
    add: a.classList.contains("ag-headadd"), more: a.dataset.stripMore || null, heading: /^H[1-3]$/.test(a.tagName), text: (a.textContent || "").trim().slice(0, 40), ring }; })())`;
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, S);
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/")}` }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `document.querySelector("#view .rt-pane-a .ag-day") && document.querySelector(".ag-strip .ag-pill") ? 1 : 0`, { label: "the Itinerary", timeout: 30000 });
  await sleep(800);

  section("1. Tab meets the sidebar first");
  // From the top of the document, as after a load with nothing focused. Blurring is not enough:
  // the browser keeps where focus last was (the router puts it on #view) as where Tab starts. A
  // mark at the very top of <body>, focused, starts it there; it takes no Tab stop of its own.
  await evalIn(cdp, S, `(() => { const m = document.createElement("span"); m.id = "keys-start"; m.tabIndex = -1; document.body.prepend(m); m.focus(); return 1; })()`);
  const seen = [];
  // The wide rail: the five, then what More holds (Changes, Packing, People, Settings), then you at its foot.
  const RAIL = ["agenda", "places", "split", "memories", "chat", "changes", "pack", "people", "other", "you"];
  for (let i = 0; i <= RAIL.length; i++) { await press("Tab"); seen.push(await J(cdp, S, AT)); }
  check(`Tab meets the rail's ${RAIL.length} first, in order: the five, Changes, Packing, People, Settings, you`, seen.slice(0, RAIL.length).map((s) => s.tab).join() === RAIL.join(), JSON.stringify(seen.map((s) => s.tab || s.tag)));
  check("each with a visible focus ring", seen.slice(0, RAIL.length).every((s) => s.ring), JSON.stringify(seen.map((s) => s.ring)));
  check("and the next Tab goes on into the page", seen[RAIL.length] && !seen[RAIL.length].inBar && (seen[RAIL.length].inA || seen[RAIL.length].inB), JSON.stringify(seen[RAIL.length]));
  const cur = await J(cdp, S, `JSON.stringify([...document.querySelectorAll(".tabbar .tab")].map((a) => a.getAttribute("aria-current")))`);
  check("the tab you are on carries aria-current=\"page\", and only it", cur[0] === "page" && cur.slice(1).every((c) => c === null), JSON.stringify(cur));

  section("2. The day strip by keys");
  // Every day of the strip is a Tab stop, in order, each with its ring: the days are reached by keys one by one. (The
  // "later days" arrow shows only while days lie past the strip's end, and focusing the last day scrolls the strip to
  // it, so the arrow is never met after the last day; it is tested below with days still past the end.)
  const pills = await evalIn(cdp, S, `document.querySelectorAll(".ag-strip .ag-pill").length`);
  const dayStops = [];
  for (let i = 0; i < pills + 2; i++) { await press("Tab"); const s = await J(cdp, S, AT); if (s.inA && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d+$/.test((s.text || "").replace(/\s+/g, ""))) dayStops.push(s); }
  check(`Tab meets every day of the strip (${pills}), each with its ring`, pills > 0 && dayStops.length === pills && dayStops.every((s) => s.ring), `${dayStops.length} of ${pills}`);
  // The arrow, with the strip at its start and days past its end: it takes focus, with its ring, and Enter moves the days.
  await evalIn(cdp, S, `(document.querySelector(".ag-strip").scrollLeft = 0, 1)`);
  await sleep(400);
  const arrow = await J(cdp, S, `JSON.stringify((() => { const s = document.querySelector(".ag-strip"), b = document.querySelector("[data-strip-more='1']");
    if (!b) return null; b.focus(); const cs = getComputedStyle(b), svg = getComputedStyle(b.querySelector("svg"));
    return { focused: document.activeElement === b, shown: cs.visibility !== "hidden", past: s.scrollWidth - s.clientWidth - s.scrollLeft, ring: (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || svg.boxShadow !== "none" || svg.outlineStyle !== "none" }; })())`);
  check("with days past the strip's end, its later-days arrow takes focus", !!arrow && arrow.focused && arrow.shown && arrow.past > 0, JSON.stringify(arrow));
  const x0 = await evalIn(cdp, S, `document.querySelector(".ag-strip").scrollLeft`);
  await press("Enter");
  await sleep(500);
  const x1 = await evalIn(cdp, S, `document.querySelector(".ag-strip").scrollLeft`);
  check("Enter on it moves the days", x1 > x0, `${x0} → ${x1}`);

  section("3. A plan opened by Enter");
  await evalIn(cdp, S, `(() => { const c = document.querySelector("#view .rt-pane-a a.ag-card"); c.scrollIntoView({ block: "center" }); c.focus(); return 1; })()`);
  await press("Enter");
  await waitFor(cdp, S, `/^#\\/e\\//.test(location.hash) && document.querySelector("#view .rt-pane-b h1, #view .rt-pane-b h2") ? 1 : 0`, { label: "the plan's page", timeout: 20000 });
  await sleep(500);
  const atPlan = await J(cdp, S, AT);
  check("its page opens beside the list and focus is on its heading", atPlan.inB && atPlan.heading, JSON.stringify(atPlan));

  section("4. \"+ Add a plan\" by Enter, then Esc");
  // Esc from inside the plan's page closes it, back to the list (router.js, pane B's head).
  await press("Escape");
  await waitFor(cdp, S, `location.hash.replace(/\\?.*/, "") === "#/" && document.querySelector("#view .ag-headadd") ? 1 : 0`, { label: "Esc: back on the Itinerary", timeout: 20000 });
  await sleep(500);
  check("Esc in the plan's page closes it, back to the list beside the map", await evalIn(cdp, S, `document.querySelector("#view .rt-pane-b").dataset.rest === "1" ? 1 : 0`) === 1);
  await evalIn(cdp, S, `(document.querySelector("#view .ag-headadd").focus(), 1)`);
  await press("Enter");
  await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1'] .sh-sheet") ? 1 : 0`, { label: "the dialog" });
  await sleep(700);
  const inSheet = await J(cdp, S, AT);
  check("Enter on \"+ Add a plan\" opens a dialog with focus inside it", inSheet.inSheet, JSON.stringify(inSheet));
  await press("Escape");
  await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1']") ? 0 : 1`, { label: "the dialog closed", timeout: 5000 });
  await sleep(500);
  const after = await J(cdp, S, AT);
  check("Esc closes it and focus is back on \"+ Add a plan\"", after.add, JSON.stringify(after));
  check("no exception reached the page", b.pageErrors.length === 0, b.pageErrors.join(" | ") || "clean");
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  await b.done();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

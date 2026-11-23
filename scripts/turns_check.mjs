#!/usr/bin/env node
/* A TABLET TURNED, AND A CLICK IN THE LIST (the layouts' two panes, 1024 and up), the made-up trip's
 * host, in a real browser:
 *
 *   1. THE PLACE IN A LIST SURVIVES A TURN. An iPad upright (820 × 1180, one pane) halfway down the
 *      Itinerary, turned on its side (1180 × 820, two panes), then back: the row at the top of the
 *      list is the same row, as far below the top as it was (within 2 px), both ways. Places' list
 *      the same.
 *   2. A CLICK ELSEWHERE KEEPS THE PERSON THERE. At 1440 a plan opened beside the Itinerary takes
 *      focus on its heading. A real click on the list's plain text (a day's date: focus goes to the
 *      page's main), and one on the sidebar's empty space (nothing there takes focus: <body>, and no
 *      focusin says so): when the plan's page then draws itself again, focus stays where the click
 *      left it, never back on the page's heading.
 *   3. A PHONE'S FACE SURVIVES A TURN. Places on its map face upright (?view=map), turned on its side
 *      (the list beside its map), then back: the address still says view=map throughout, and the
 *      upright screen is on the map again.
 *
 *   node scripts/gate.mjs --only turns_check
 *
 * PLANTED (16 Nov): run against the code before these fixes (rework 6b5cf61), red 5 of 9: Places
 * back at its first row both ways (1; the Itinerary kept its row on this trip either way); after a
 * click on the sidebar's empty space the plan's heading took focus back (2; a click on the list's
 * text gives focus to the page's main, so the old keeper already stopped there); the address lost
 * view=map and the upright screen came back on the list (3).
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

const UPRIGHT = { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true };
const SIDE = { width: 1180, height: 820, deviceScaleFactor: 2, mobile: true };

// The list's scroller (pane A in two panes, #view in one) and the first row starting in view in it:
// a day ([data-k]) or a card or row (a link inside the app), and how far below the scroller's top.
const ROW = `JSON.stringify((() => {
  const box = document.querySelector("#view .rt-pane-a") || document.querySelector("#view");
  const top = box.getBoundingClientRect().top;
  for (const n of box.querySelectorAll("[data-k], a[href^='#/']")) {
    const r = n.getBoundingClientRect();
    if (r.height > 0 && r.top >= top - 1) return { two: !!box.classList.contains("rt-pane-a"), key: n.getAttribute("data-k") || n.getAttribute("href"), off: Math.round(r.top - top), at: Math.round(box.scrollTop) };
  }
  return { two: !!box.classList.contains("rt-pane-a"), key: null, at: Math.round(box.scrollTop) };
})())`;

const b = await boot({ vw: UPRIGHT.width, vh: UPRIGHT.height, dsf: 2, reduceMotion: true });
const { cdp, S } = b;
const turn = async (to, two) => {
  await cdp.send("Emulation.setDeviceMetricsOverride", to, S);
  await waitFor(cdp, S, `${two ? "" : "!"}document.querySelector("#view .rt-pane-a") ? 1 : 0`, { label: two ? "two panes" : "one pane", timeout: 15000 });
  await sleep(900);
};
const open = async (hash, ready, label) => {
  await cdp.send("Page.navigate", { url: "about:blank" }, S);
  await sleep(100);
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath(hash)}` }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `${ready} ? 1 : 0`, { label, timeout: 30000 });
  await sleep(800);
};

try {
  section("1. The place in a list survives a turn");
  for (const [name, hash, ready] of [["Itinerary", "#/", `document.querySelectorAll("#view .ag-day").length > 3`], ["Places", "#/places", `document.querySelectorAll("#view a.pl-row").length > 8`]]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", UPRIGHT, S);
    await open(hash, ready, name);
    // Halfway down, as a reader leaves it (a scroll, which the router records as it goes).
    await evalIn(cdp, S, `(() => { const v = document.querySelector("#view"); v.scrollTop = Math.round((v.scrollHeight - v.clientHeight) / 2); return 1; })()`);
    await sleep(500);
    const r0 = await J(cdp, S, ROW);
    await turn(SIDE, true);
    const r1 = await J(cdp, S, ROW);
    check(`${name}, upright → on its side: the same row at the top of the list, as far down`,
      r0.key && r1.two && r1.key === r0.key && Math.abs(r1.off - r0.off) <= 2, `upright ${JSON.stringify(r0)} · on its side ${JSON.stringify(r1)}`);
    await turn(UPRIGHT, false);
    const r2 = await J(cdp, S, ROW);
    check(`${name}, back upright: the same row again, as far down`,
      r2.key && !r2.two && r2.key === r1.key && Math.abs(r2.off - r1.off) <= 2, `on its side ${JSON.stringify(r1)} · upright ${JSON.stringify(r2)}`);
  }

  section("2. A click elsewhere keeps the person there");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, S);
  // A plan opened beside the list, fresh each time (its page takes focus on its heading as it opens).
  const openPlan = async () => {
    await open("#/", `document.querySelector("#view .rt-pane-a .ag-card")`, "the Itinerary in two panes");
    const card = await evalIn(cdp, S, `document.querySelector("#view .rt-pane-a .ag-card").getAttribute("href")`);
    await cdp.send("Page.navigate", { url: `${BASE}${tripPath(card)}` }, S);
    await waitFor(cdp, S, `document.activeElement && document.activeElement.closest && document.activeElement.closest(".rt-pane-b") && /^H[12]$/.test(document.activeElement.tagName) ? 1 : 0`, { label: "the plan's heading focused", timeout: 20000 });
    await sleep(600);
  };
  const click = async (at) => { for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, S); await sleep(300); };
  const where = `(() => { const a = document.activeElement; return a === document.body ? "body" : a.closest(".rt-pane-b") ? "the plan's page" : a.tagName; })()`;
  // The plan's page draws itself again (as it does when its data or a change arrives).
  const redraw = async () => {
    await evalIn(cdp, S, `(() => { const h = document.querySelector("#view .rt-pane-b").querySelector("h1, h2"); h.replaceWith(h.cloneNode(true)); return 1; })()`);
    await sleep(400);
  };
  const spots = {
    "the list's plain text (a day's date)": `(() => { const d = [...document.querySelectorAll("#view .rt-pane-a .ag-dayhead-date")].find((n) => { const r = n.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight - 40; });
      const r = d.getBoundingClientRect(); return { x: r.x + Math.min(20, r.width / 2), y: r.y + r.height / 2 }; })()`,
    "the sidebar's empty space": `(() => { const bar = document.querySelector(".tabbar"), r = bar.getBoundingClientRect();
      for (let y = r.bottom - 20; y > r.top; y -= 8) { const n = document.elementFromPoint(r.x + 12, y); if (n && bar.contains(n) && !n.closest("a, button, [tabindex]")) return { x: r.x + 12, y }; }
      return null; })()`,
  };
  for (const [name, find] of Object.entries(spots)) {
    await openPlan();
    const at = await J(cdp, S, `JSON.stringify(${find})`);
    if (!at) { check(`${name}: found on screen`, false, "no spot"); continue; }
    await click(at);
    const after = await evalIn(cdp, S, where);
    await redraw();
    const then = await evalIn(cdp, S, where);
    check(`a click on ${name}, then the plan's page drawn again: focus stays off the page`, after !== "the plan's page" && then !== "the plan's page", `after the click: ${after}; after the redraw: ${then}`);
  }

  section("3. A phone's face survives a turn");
  await cdp.send("Emulation.setDeviceMetricsOverride", UPRIGHT, S);
  await open("#/places?view=map", `document.querySelector("#view .pl-head[data-view='map']") && !document.querySelector("#view .pl-mapbody").hidden`, "Places on its map face");
  await turn(SIDE, true);
  await sleep(400);
  const side = await evalIn(cdp, S, `location.hash`);
  check("on its side (the list beside its map): the address still says view=map", /[?&]view=map\b/.test(side), side);
  await turn(UPRIGHT, false);
  await sleep(400);
  const up = await J(cdp, S, `JSON.stringify((() => { const h = document.querySelector("#view .pl-head"), m = document.querySelector("#view .pl-mapbody"); return { hash: location.hash, face: h && h.dataset.view, map: !!m && !m.hidden }; })())`);
  check("back upright: Places is on its map face again", /[?&]view=map\b/.test(up.hash) && up.face === "map" && up.map, JSON.stringify(up));

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

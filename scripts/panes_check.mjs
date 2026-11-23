#!/usr/bin/env node
/* TWO PANES (the layouts, (b), 16 Nov; router.js PAIRS): from 1024 the Itinerary keeps its list on the
 * left and draws on the right the plan it leads to, or the trip's map when none is open; Places keeps
 * its list on the left and its map, or the place opened, on the right. The made-up trip's host, in a
 * real browser:
 *
 *   1. #/ at 1440: the Itinerary beside the trip's map. A card tapped: the address names the plan,
 *      its page is the right pane, and the list is the same list where it was (not drawn again,
 *      not moved). Back: the map again, the list still where it was. A refresh on the plan's
 *      address lands on the same two.
 *   2. #/places at 1440: the list beside its map (no list/map switch); a row tapped: the place on
 *      the right, the list unmoved; back, and a refresh, as in 1.
 *   3. The list's add is named in its head (no floating + from 768); the page's way out is Close in
 *      its own head (no floating Back), and Close goes back to the list.
 *   4. 1024 is two panes too; 390 is one page at a time, as before (the plan's address: its page
 *      alone). Across 1024 with a plan open, the same address is drawn the other way.
 *
 *   node scripts/gate.mjs --only panes_check
 *
 * PLANTED (red when put in by hand): router.js pairOf() returning null (every line); router.js
 * mounting pane A afresh on every move within the two (the list drawn again, 1 and 2).
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

// What the panes hold: pane A's list and whether it is the same node as before (a mark put on
// it), its scroll; pane B's route and what it shows.
const PANES = `JSON.stringify((() => {
  const v = document.getElementById("view"), a = v.querySelector(".rt-pane-a"), b = v.querySelector(".rt-pane-b");
  const ar = a ? a.getBoundingClientRect() : null, br = b ? b.getBoundingClientRect() : null;
  return { hash: location.hash, two: v.dataset.two === "1", route: v.dataset.route,
    a: a ? { same: a.__mark === 1, list: !!a.querySelector(".ag-day, .pl-row"), y: Math.round(a.scrollTop), box: [Math.round(ar.left), Math.round(ar.right)] } : null,
    b: b ? { route: b.dataset.route, rest: b.dataset.rest === "1", map: !!b.querySelector(".mp-root"), plan: !!b.querySelector(".ag-d-t, .ag-detail, [class*='ag-d']"),
      place: (b.querySelector(".pl-title h1") || {}).textContent || "", box: [Math.round(br.left), Math.round(br.right)] } : null,
    toggle: !!document.querySelector("#view .rt-pane-a .pl-viewbtn") && getComputedStyle(document.querySelector("#view .rt-pane-a .pl-viewbtn")).display !== "none",
    page: !!v.querySelector(":scope > .ag, :scope > * .ag-d-t") };
})())`;
const mark = (cdp, S) => evalIn(cdp, S, `(() => { const a = document.querySelector("#view .rt-pane-a"); if (a) a.__mark = 1; return 1; })()`);

const b = await boot({ vw: 1440, vh: 900, dsf: 1, reduceMotion: true });
const { cdp, S } = b;
const size = async (w, h) => { await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 1000 }, S); await sleep(500); };
const go = async (hash, ready, label) => {
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath(hash)}` }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `${ready} ? 1 : 0`, { label, timeout: 30000 });
  await sleep(800);
};
const tap = async (sel) => { await evalIn(cdp, S, `(document.querySelector(${JSON.stringify(sel)}).click(), 1)`); };
try {
  await size(1440, 900);
  for (const [name, list, ready, row, rowReady, pageOk] of [
    ["The Itinerary", "#/", `document.querySelector("#view .rt-pane-a .ag-day") && document.querySelector("#view .rt-pane-b .mp-root")`, "#view .rt-pane-a a.ag-card",
      `/^#\\/e\\//.test(location.hash) && document.querySelector("#view .rt-pane-b") && document.querySelector("#view .rt-pane-b").dataset.route === "event" && document.querySelector("#view .rt-pane-b").children.length`, (p) => p.b.route === "event" && !p.b.map],
    ["Places", "#/places", `document.querySelectorAll("#view .rt-pane-a .pl-row").length > 8 && document.querySelector("#view .rt-pane-b .mp-root")`, "#view .rt-pane-a a.pl-row",
      `/^#\\/p\\//.test(location.hash) && document.querySelector("#view .rt-pane-b .pl-title h1")`, (p) => p.b.route === "place" && !!p.b.place && !p.b.map],
  ]) {
    section(`${name}, 1440`);
    await go(list, ready, name);
    const p0 = await J(cdp, S, PANES);
    check(`${name}: the list on the left, ${name === "Places" ? "its" : "the trip's"} map on the right`, p0.two && p0.a && p0.a.list && p0.b && p0.b.rest && p0.b.map && p0.a.box[1] <= p0.b.box[0] + 1, JSON.stringify(p0));
    if (name === "Places") check("Places: no list/map switch (the map is the other pane)", !p0.toggle, JSON.stringify(p0));
    // Read a little way down the list, then open the row in view.
    await evalIn(cdp, S, `(document.querySelector("#view .rt-pane-a").scrollTop = 300, 1)`);
    await sleep(400);
    await mark(cdp, S);
    const y0 = (await J(cdp, S, PANES)).a.y;
    const target = await evalIn(cdp, S, `(() => { const a = document.querySelector("#view .rt-pane-a"), r = a.getBoundingClientRect(); const row = [...a.querySelectorAll(${JSON.stringify(row.replace("#view .rt-pane-a ", ""))})].find((n) => { const q = n.getBoundingClientRect(); return q.top > r.top + 80 && q.bottom < r.bottom - 80; }); if (!row) return ""; row.setAttribute("data-panes-pick", "1"); return row.getAttribute("href"); })()`);
    await tap(`[data-panes-pick="1"]`);
    await waitFor(cdp, S, `${rowReady} ? 1 : 0`, { label: `${name}: the page in pane B`, timeout: 20000 });
    await sleep(700);
    const p1 = await J(cdp, S, PANES);
    check(`${name}: a row tapped: the address names it (${target}) and its page is the right pane`, p1.hash === target && pageOk(p1), JSON.stringify(p1));
    check(`${name}: and the list is the same list, where it was`, p1.a && p1.a.same && Math.abs(p1.a.y - y0) <= 2, `same=${p1.a && p1.a.same} y ${y0} → ${p1.a && p1.a.y}`);
    // The list's add is named in its head (no floating + from 768: at rest it stood on the list's
    // words); the page's way out is Close in its own head, and nothing floats over its words.
    const way = await J(cdp, S, `JSON.stringify((() => {
      const shown = (n) => !!n && getComputedStyle(n).display !== "none" && n.getBoundingClientRect().width > 0;
      const a = document.querySelector("#view .rt-pane-a"), ar = a.getBoundingClientRect();
      const add = [...a.querySelectorAll(".ag-headadd, .pl-headadd")].find(shown);
      const fab = document.querySelector("#rt-fixed .fab");
      const close = document.querySelector("#view .rt-panehead .rt-close"), back = document.getElementById("backbtn");
      const pb = document.querySelector("#view .rt-pane-b").getBoundingClientRect(), cr = shown(close) ? close.getBoundingClientRect() : null;
      return { add: add ? add.textContent.trim() : null, addIn: !!add && add.getBoundingClientRect().right <= ar.right && add.getBoundingClientRect().top < ar.top + 80,
        fab: shown(fab), close: cr ? { above: cr.bottom <= pb.top + 1, right: Math.round(pb.right - cr.right) } : null, back: shown(back) }; })())`);
    check(`${name}: the list's add is named in its head, no floating +; the page's way out is Close in its own head, nothing floating over it`,
      !!way.add && /^\+ Add a (plan|place)$/.test(way.add) && way.addIn && !way.fab && !!way.close && way.close.above && !way.back, JSON.stringify(way));
    // Close goes back to the list.
    await evalIn(cdp, S, `(document.querySelector("#view .rt-panehead .rt-close").click(), 1)`);
    await waitFor(cdp, S, `location.hash.replace(/\\?.*/, "") === ${JSON.stringify(list)} && document.querySelector("#view .rt-pane-b .mp-root") ? 1 : 0`, { label: `${name}: Close`, timeout: 20000 });
    await sleep(500);
    check(`${name}: Close goes back to the list and its map`, (await J(cdp, S, PANES)).b.rest);
    await evalIn(cdp, S, `(history.forward(), 1)`);
    await waitFor(cdp, S, `${rowReady} ? 1 : 0`, { label: `${name}: forward again`, timeout: 20000 });
    await sleep(500);
    await evalIn(cdp, S, `(history.back(), 1)`);
    await waitFor(cdp, S, `location.hash.replace(/\\?.*/, "") === ${JSON.stringify(list)} && document.querySelector("#view .rt-pane-b .mp-root") ? 1 : 0`, { label: `${name}: back`, timeout: 20000 });
    await sleep(700);
    const p2 = await J(cdp, S, PANES);
    check(`${name}: back: the map again, and the list the same list, where it was`, p2.b.rest && p2.b.map && p2.a.same && Math.abs(p2.a.y - y0) <= 2, JSON.stringify(p2));
    // A real reload on the page's address: going to an address that differs only after "#" is a
    // move within the page, not a refresh (the list's mark would still be on it).
    await evalIn(cdp, S, `(location.hash = ${JSON.stringify(target)}, 1)`);
    await sleep(600);
    await cdp.send("Page.reload", { ignoreCache: true }, S);
    await appSettled(cdp, S);
    await waitFor(cdp, S, `${rowReady} ? 1 : 0`, { label: `${name}: reloaded on the page's address`, timeout: 30000 });
    await sleep(800);
    const p3 = await J(cdp, S, PANES);
    check(`${name}: a refresh on the page's address lands on the same two (a new page: the list's mark gone)`, p3.hash === target && p3.two && p3.a.list && !p3.a.same && pageOk(p3), JSON.stringify(p3));
  }

  section("1024 and 390");
  const planAt = await evalIn(cdp, S, `location.hash`);
  await size(1024, 768);
  await go("#/", `document.querySelector("#view .rt-pane-a .ag-day") && document.querySelector("#view .rt-pane-b .mp-root")`, "1024");
  check("1024: two panes", (await J(cdp, S, PANES)).two);
  const plan = await evalIn(cdp, S, `document.querySelector("#view .rt-pane-a a.ag-card").getAttribute("href")`);
  await size(390, 844);
  await go(plan, `document.getElementById("view").dataset.route === "event" && !document.querySelector("#view .rt-pane-a") && document.getElementById("view").children.length`, "390");
  const one = await J(cdp, S, PANES);
  check("390: the plan's address is its page alone, as before", !one.two && !one.a && one.route === "event", JSON.stringify(one));
  await size(1440, 900);
  await waitFor(cdp, S, `document.querySelector("#view .rt-pane-a .ag-day") && document.querySelector("#view .rt-pane-b") && document.querySelector("#view .rt-pane-b").dataset.route === "event" ? 1 : 0`, { label: "across 1024", timeout: 20000 });
  const across = await J(cdp, S, PANES);
  check("across 1024 with the plan open, the same address is drawn as two panes", across.two && across.hash === plan && across.b.route === "event", JSON.stringify(across));
  void planAt;
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

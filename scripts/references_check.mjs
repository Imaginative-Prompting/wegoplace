#!/usr/bin/env node
/* THE TRIP'S QUICK REFERENCE LIST, in a browser on the gate's made-up trip (js/references.js, store.js "references";
 * src/api/references.js keeps it).
 *
 *   node scripts/gate.mjs --only references_check        (REF_SHOTS=<dir>: stills of the button and the sheet, 440x956,
 *                                                         light and dark)
 *
 * It holds:
 *   1. THE BUTTON is on exactly the screens that draw a + (every screen read: its +, its button, its Back), the +
 *      mirrored, lighter: 48 px, on the +'s centre line, as far from the left edge as the + from the right, not the
 *      +'s solid. Where the dock
 *      shows (a purchase's Back; offline, the Offline pill) the button stands on top of it and the Back keeps its place.
 *   2. THE SHEET, as a person uses it, on the host's phone: empty, it says what the list is for; "+ Add" at its top (a
 *      title and a text with a phone number and an https address); the row shows the text with its line breaks, the
 *      number a tel: link and the address an https link opening apart, nothing else a link; the whole title row (44 px
 *      at least) opens the item, a link in the text never does; the form is a sheet over the list with Save at its top
 *      and one way out (no X, no Back: the backdrop goes back to the list); Remove inside it, asked in place (Keep it
 *      keeps); what the server holds is what the sheet showed.
 *   2b. A LONG LIST OPENS AT ITS TOP (five items, two of a dozen lines, with motion as on a phone): the sheet's scroller
 *      at 0 once the slide-in settles and nothing in the list focused (no ring on a link); the same reopened after
 *      closing it scrolled to its end, and back on the list after an add made from its end.
 *      In every state seen (opened, the forms, one item, after a change, an add and a remove, Remove asked, a long list,
 *      a full list), no open sheet says "null" or "undefined".
 *   3. TWO PEOPLE: a member's phone with the sheet open sees the host's new item arrive, without a reload.
 *   4. OFFLINE: a phone whose worker is in control, with no signal, reloads the trip and opens the list from its own
 *      copy: the item is there.
 *   5. NO PAGE ERRORS; every item it made is removed by its id.
 *
 * PLANTED (REF_PLANT=<name>; each serves one file changed, never writes one):
 *   links      references.js never makes a link: 2 red (the numbers and the address; the number to tap).
 *   under      styles.css without the rule that lifts the button over the dock: 2 red (1: the purchase's Back, offline).
 *   offline    store.js keeps no "references" store on the phone: 4 stops (the item never on the phone).
 *   scroll     references.js doesn't take the list back to its top: 2b red (back on the list after an add from its end).
 *   focus      references.js opens with the focus on the last item's row: 2b red (opened, and opened again).
 *   null       references.js hands the list's empty child to replaceChildren() unfiltered: "null" under every list, red.
 */
import fs from "node:fs";
import path from "node:path";
import { BASE, boot, evalIn, waitFor, sleep, appSettled, signInAs } from "./lib/standalone_cdp.mjs";
import { tripPath, tripApi, PEOPLE, HOST } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const SHOTS = process.env.REF_SHOTS || "";

const PLANT = process.env.REF_PLANT || "";
const PLANTS = { links: "js/references.js", under: "styles.css", offline: "js/store.js", scroll: "js/references.js", focus: "js/references.js", null: "js/references.js" };
if (PLANT && !PLANTS[PLANT]) throw new Error(`REF_PLANT is one of ${Object.keys(PLANTS).join(", ")}`);
const PLANTED = PLANT ? (() => {
  const src = read(`public/${PLANTS[PLANT]}`);
  const t = PLANT === "links" ? src.replace("    if (!href) continue;", "    if (!href || true) continue;")
    : PLANT === "null" ? src.replace("    ].filter(Boolean));\n", "    ]);\n")
    : PLANT === "focus" ? src.replace("  atTop();\n  return sheet;", "  atTop();\n  body.querySelector(\".rf-item:last-child .rf-open\")?.focus();\n  return sheet;")
    : PLANT === "scroll" ? src.replace("    if (port) port.scrollTop = 0;\n", "")
    : PLANT === "under" ? src.replace(/\nbody\[data-fab="1"\]:is\(\[data-back="1"\], \[data-netpill="1"\]\) \.rf-fab \{[^}]*\}/, "")
    : src.replace('const ROWSTORES = ["events", "places", "packing", "purchases", "references"];', 'const ROWSTORES = ["events", "places", "packing", "purchases"];');
  if (t === src) throw new Error(`the ${PLANT} plant didn't take`);
  return t;
})() : null;
const plantOn = async (cdp, S) => {
  if (!PLANTED) return;
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: PLANTS[PLANT].endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }],
    body: Buffer.from(PLANTED).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*/${PLANTS[PLANT]}*` }] }, S);
};
if (PLANT) console.log(`PLANTED: ${PLANT} (${PLANTS[PLANT]})`);

const TAG = `ref-check-${Date.now().toString(36)}`;
const made = [];          // the items this check made, by id
const b = await boot({ vw: 440, vh: 956, dsf: 2, reduceMotion: true });
const { cdp, S } = b;
await plantOn(cdp, S);
const J = async (e) => JSON.parse(await evalIn(cdp, S, e));
const ev = (e) => evalIn(cdp, S, e);
const inStore = (body) => ev(`import("/js/store.js").then(async ({ store }) => { ${body} })`);
async function stills(name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }] }, S);
    await sleep(500);
    await b.shot(path.join(SHOTS, `${name}-${scheme}.png`));
  }
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
}
const STATE = `JSON.stringify((() => { const r = (s) => { const n = document.querySelector(s); if (!n || n.hidden || getComputedStyle(n).display === "none") return null; const b = n.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  return { w: innerWidth, route: (document.querySelector("#view") || {}).dataset?.route, fab: r(".fab:not([hidden])"), ref: r(".rf-fab"), back: r("#backbtn"), pill: r("#netpill") }; })())`;
const SHEET = `document.querySelector(".sh-root[data-open='1'] .rf")`;
const openList = async () => {
  await ev(`(document.querySelector(".rf-fab").click(), 1)`);
  await waitFor(cdp, S, `${SHEET} ? 1 : 0`, { label: "the quick reference", timeout: 8000 });
  await sleep(500);
};
const closeSheet = async () => { await ev(`(document.querySelector(".sh-root[data-open='1'] .sh-x")?.click(), 1)`); await sleep(600); };
const cards = `JSON.stringify([...document.querySelectorAll(".sh-root[data-open='1'] .rf-item")].map((li) => ({ id: li.dataset.rf, title: li.querySelector(".rf-title").textContent,
  text: li.querySelector(".rf-text")?.textContent ?? "", links: [...li.querySelectorAll(".rf-text a")].map((a) => [a.textContent, a.getAttribute("href"), a.target || ""]) })))`;
const serverRows = () => J(`fetch(${JSON.stringify(tripApi("/references"))}, { credentials: "same-origin" }).then((r) => r.json()).then((j) => JSON.stringify(j.references || []))`);
// The item's form is a sheet over the list: Save at its top; it closes back to the list.
const saveForm = async () => {
  await ev(`(document.querySelector("[data-rf-save]").click(), 1)`);
  await waitFor(cdp, S, `!document.querySelector(".rf-form") ? 1 : 0`, { label: "the form closing back to the list", timeout: 8000 }).catch(() => {});
  await sleep(400);
};
// Every state the sheet is seen in: its whole text (every open sheet, the head too) never says "null" or "undefined"
// (22 Nov: replaceChildren() wrote a null child as the word "null" under the list).
const saidBad = [];
const said = async (state) => {
  const t = await ev(`[...document.querySelectorAll(".sh-root[data-open='1']")].map((r) => r.innerText).join("\\n")`);
  saidBad.push({ state, bad: (String(t).match(/\b(?:null|undefined)\b/g) || []).length, words: String(t).length });
};
const flushed = async () => { await inStore(`await store.flush(); return 1;`); await sleep(1200); };
let b2 = null, b3 = null;

try {
  await b.setInsets({ top: 59, right: 0, bottom: 34, left: 0 });
  section("1. The button, where a + is drawn: the + mirrored, and over the dock");
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/")}` }, S);
  await appSettled(cdp, S).catch(() => {});
  await waitFor(cdp, S, `document.querySelector(".rf-fab") ? 1 : 0`, { label: "the button", timeout: 20000 });
  await sleep(800);
  const ids = await J(`import("/js/store.js").then(({ store }) => JSON.stringify({ e: store.events()[0]?.id, p: store.places()[0]?.id, s: store.purchases()[0]?.id }))`);
  const seen = {};
  for (const [name, hash] of [["Itinerary", "#/"], ["a plan", `#/e/${ids.e}`], ["Places", "#/places"], ["a place", `#/p/${ids.p}`], ["Packing", "#/pack"], ["Split", "#/split"],
    ["a purchase", `#/split/${ids.s}`], ["Photos", "#/memories"], ["Chat", "#/chat"], ["More", "#/settings"]]) {
    await ev(`(location.hash = ${JSON.stringify(hash)}, 1)`);
    await sleep(1300);
    seen[name] = await J(STATE);
  }
  for (const [name, s] of Object.entries(seen)) check(`${name}: the button ${s.fab ? "with" : "without"} its +`, Boolean(s.ref) === Boolean(s.fab), JSON.stringify(s));
  const it = seen.Itinerary;
  check("the + mirrored, lighter: a 48 px round button on the +'s centre line, as far from the left edge as the + is from the right",
    it.ref && it.fab && it.ref[2] === 48 && it.ref[3] === 48 && Math.abs((it.ref[1] + it.ref[3] / 2) - (it.fab[1] + it.fab[3] / 2)) <= 1
      && Math.abs(it.ref[0] - (it.w - it.fab[0] - it.fab[2])) <= 1, JSON.stringify(it));
  const buy = seen["a purchase"], plan = seen["a plan"];
  check("with the Back (a purchase): the Back keeps its place (as on a plan's page), the button stands on top of it",
    buy.back && plan.back && buy.back[1] === plan.back[1] && buy.ref && buy.ref[1] + buy.ref[3] <= buy.back[1] - 4, JSON.stringify({ buy, plan }));
  await ev(`(location.hash = "#/", 1)`);
  await sleep(900);
  const looks = await J(`JSON.stringify((() => { const c = (s) => { const n = document.querySelector(s), g = getComputedStyle(n); return { bg: g.backgroundColor, fg: g.color, edge: g.borderTopWidth }; };
    return { plus: c(".fab:not([hidden])"), book: c(".rf-fab") }; })())`);
  check("it reads secondary: not the +'s solid, a hairline edge of its own (the + stays the one solid)",
    looks.book.bg !== looks.plus.bg && looks.book.edge === "1px" && looks.plus.edge !== "1px", JSON.stringify(looks));
  await stills("1-itinerary");
  await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
  await waitFor(cdp, S, `document.querySelector("#netpill") && !document.querySelector("#netpill").hidden ? 1 : 0`, { label: "the Offline pill", timeout: 8000 }).catch(() => {});
  await sleep(600);
  const off = await J(STATE);
  check("offline: the Offline pill keeps the corner, the button stands on top of it", off.pill && off.ref && off.ref[1] + off.ref[3] <= off.pill[1] - 4 && off.ref[0] === it.ref[0], JSON.stringify(off));
  await stills("4-offline");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
  await sleep(1500);

  section("2. The sheet, as a person uses it");
  const had = (await serverRows()).length;
  await openList();
  await said(had ? "the list, opened" : "the list, opened empty");
  const head = await J(`JSON.stringify({ title: document.querySelector(".sh-root[data-open='1'] .sh-title").textContent, empty: document.querySelector(".rf-empty")?.textContent ?? null,
    add: document.querySelector(".rf-add")?.textContent.trim(), addName: document.querySelector(".rf-add")?.getAttribute("aria-label"),
    addInHead: !!document.querySelector(".sh-root[data-open='1'] .sh-head .rf-add"), name: document.querySelector(".rf-fab").getAttribute("aria-label") })`);
  check("titled Quick reference (the button named so too), \"+ Add\" at its top beside the title (named Add to the list)",
    head.title === "Quick reference" && head.name === "Quick reference" && head.add === "+ Add" && head.addName === "Add to the list" && head.addInHead, JSON.stringify(head));
  if (!had) check("empty: one line saying what the list is for", /emergency numbers, the embassy, money and ATMs/.test(head.empty ?? ""), head.empty);
  await ev(`(document.querySelector(".rf-add").click(), 1)`);
  await waitFor(cdp, S, `document.querySelector(".rf-form #rf-title") ? 1 : 0`, { label: "the form" });
  await said("the add form");
  const TEXT = `Police, fire and ambulance: 112\nThe hotel: +31 20 765 4321\nIts site: https://example.org/hotel.\nBook by 2027-05-12 for 3 nights.`;
  await ev(`(() => { document.querySelector("#rf-title").value = ${JSON.stringify(`Emergency ${TAG}`)}; document.querySelector("#rf-text").value = ${JSON.stringify(TEXT)}; return 1; })()`);
  await saveForm();
  await waitFor(cdp, S, `document.querySelector(".rf-list .rf-item") ? 1 : 0`, { label: "the new card", timeout: 8000 }).catch(() => {});
  let shown = await J(cards);
  await said("one item, just added");
  const mine = shown.find((c) => c.title === `Emergency ${TAG}`);
  if (mine) made.push(mine.id);
  check("added: its card, the text with its line breaks", mine && mine.text === TEXT, JSON.stringify(mine));
  check("the phone numbers are tel: links, the address an https link opening apart; the date and the counts aren't links",
    mine && JSON.stringify(mine.links) === JSON.stringify([["112", "tel:112", ""], ["+31 20 765 4321", "tel:+31207654321", ""], ["https://example.org/hotel", "https://example.org/hotel", "_blank"]]), JSON.stringify(mine?.links));
  await stills("2-sheet");
  await flushed();
  let held = (await serverRows()).find((r) => r.id === mine?.id);
  check("the server holds what the sheet showed", held && held.title === `Emergency ${TAG}` && held.body === TEXT, JSON.stringify(held));
  await ev(`(document.querySelector('[data-rf-change="${mine?.id}"]').click(), 1)`);
  await waitFor(cdp, S, `document.querySelector(".rf-form #rf-title") ? 1 : 0`, { label: "the form, changing" });
  const pre = await J(`JSON.stringify({ t: document.querySelector("#rf-title").value, b: document.querySelector("#rf-text").value })`);
  await ev(`(() => { document.querySelector("#rf-title").value = ${JSON.stringify(`Numbers ${TAG}`)}; return 1; })()`);
  await saveForm();
  await sleep(500);
  shown = await J(cards);
  await said("after a change");
  check("Change: the form holds the item as it is; saved, the card says the new title", pre.t === `Emergency ${TAG}` && pre.b === TEXT && shown.some((c) => c.id === mine?.id && c.title === `Numbers ${TAG}`), JSON.stringify({ pre, shown: shown.map((c) => c.title) }));
  // The item's own row opens it: at least 44 px tall, the text's links outside it and never opening the form.
  const row = await J(`JSON.stringify((() => { const b = document.querySelector('[data-rf-change="${mine?.id}"]'), r = b.getBoundingClientRect(), li = b.closest(".rf-item");
    return { h: Math.round(r.height), w: Math.round(r.width), liW: Math.round(li.getBoundingClientRect().width), links: b.querySelectorAll("a").length, name: b.getAttribute("aria-label") }; })())`);
  check("the whole title row is the way into the item: a button at least 44 px tall across the row, named Change <title>, no link inside it",
    row.h >= 44 && row.w >= row.liW - 1 && row.links === 0 && row.name === `Change Numbers ${TAG}`, JSON.stringify(row));
  const tapped = await ev(`(() => { const a = document.querySelector('[data-rf="${mine?.id}"] .rf-text a[href^="tel:"]'); if (!a) return 0;
    document.addEventListener("click", (e) => { if (e.target.closest(".rf-text a")) e.preventDefault(); }, { capture: true, once: true });
    a.click(); return 1; })()`);
  await sleep(700);
  check("a phone number in the text is its own link: tapped, no form opens", tapped === 1 && !(await ev(`!!document.querySelector(".rf-form")`)), tapped ? "" : "no phone link to tap");
  // One way out of the form, as the plan editor has it: no X on a phone; the backdrop (or the handle) goes back to the list.
  await ev(`(document.querySelector('[data-rf-change="${mine?.id}"]').click(), 1)`);
  await waitFor(cdp, S, `document.querySelector(".rf-form #rf-title") ? 1 : 0`, { label: "the form, from its row" });
  await sleep(500);
  await said("an item's form");
  const out = await J(`JSON.stringify((() => { const roots = [...document.querySelectorAll(".sh-root[data-open='1']")], top = roots[roots.length - 1], x = top.querySelector(".sh-x");
    return { sheets: roots.length, title: top.querySelector(".sh-title").textContent, save: !!top.querySelector(".sh-head [data-rf-save]"), x: !!(x && x.getClientRects().length && getComputedStyle(x).display !== "none" && getComputedStyle(x).visibility !== "hidden"),
      back: [...top.querySelectorAll("button")].some((b) => /back/i.test(b.textContent)) }; })())`);
  check("the form is a sheet over the list, \"Change item\" with Save at its top, and one way out (no X, no Back button: the backdrop or the handle)",
    out.sheets === 2 && out.title === "Change item" && out.save && !out.x && !out.back, JSON.stringify(out));
  await ev(`(() => { const roots = [...document.querySelectorAll(".sh-root[data-open='1']")]; roots[roots.length - 1].querySelector(".sh-scrim").click(); return 1; })()`);
  await sleep(800);
  check("the backdrop closes the form and leaves the list open", JSON.parse(await ev(`JSON.stringify([document.querySelectorAll(".sh-root[data-open='1']").length, !!document.querySelector(".rf-form"), !!document.querySelector(".sh-root[data-open='1'] .rf-list")])`)).join() === "1,false,true");
  // Remove is inside the item's form, asked in place.
  await ev(`(document.querySelector('[data-rf-change="${mine?.id}"]').click(), 1)`);
  await waitFor(cdp, S, `document.querySelector("[data-rf-remove]") ? 1 : 0`, { label: "Remove in the form" });
  await ev(`(document.querySelector('[data-rf-remove="${mine?.id}"]').click(), 1)`);
  await sleep(300);
  const asked = await J(`JSON.stringify({ ask: document.querySelector(".rf-ask")?.textContent ?? null, focus: document.activeElement?.textContent?.trim() })`);
  check("Remove is asked in place, the focus on Keep it", /^Remove “Numbers .*” from the list\?$/.test(asked.ask ?? "") && asked.focus === "Keep it", JSON.stringify(asked));
  await said("Remove asked in place");
  await ev(`(document.querySelector("[data-rf-keep]").click(), 1)`);
  await sleep(300);
  check("Keep it keeps it (the form still open, Remove back in its place)", (await J(cards)).some((c) => c.id === mine?.id) && !!(await ev(`!!document.querySelector('[data-rf-remove]') && !!document.querySelector(".rf-form")`)));
  await ev(`(document.querySelector('[data-rf-remove="${mine?.id}"]').click(), 1)`);
  await sleep(200);
  await ev(`(document.querySelector("[data-rf-yes]").click(), 1)`);
  await waitFor(cdp, S, `!document.querySelector(".rf-form") ? 1 : 0`, { label: "the form closing after Remove", timeout: 8000 }).catch(() => {});
  await sleep(500);
  await said("after a remove");
  await flushed();
  check("Remove it: gone from the sheet and from the server", !(await J(cards)).some((c) => c.id === mine?.id) && !(await serverRows()).some((r) => r.id === mine?.id));
  await closeSheet();

  section("2b. A long list opens at its top: first open, reopened after scrolling, after an add");
  {
    // Five made-up items, two of them long (a dozen lines each), a phone number near the top of each: the shape of a
    // real list (22 Nov: a list like it opened scrolled down a little).
    const LONG = (what) => [`${what}: +31 20 555 0100`, ...Array.from({ length: 11 }, (_, i) => `Line ${i + 2} about ${what.toLowerCase()}, kept short.`)].join("\n");
    const five = [["Emergency numbers", "Police, fire and ambulance: 112\nNon-urgent police: 0900 8844"], ["The flat", LONG("The host")],
      ["Money", "Cards work almost everywhere; the market takes cash."], ["Getting around", LONG("The station")], ["Door code", "4321#"]];
    const ids = [];
    for (const [title, text] of five) {
      const id = `rf_${TAG}_${ids.length}`.replace(/[^A-Za-z0-9_-]/g, "_");
      ids.push(id); made.push(id);
      await inStore(`await store.addReference(${JSON.stringify(id)}, { title: ${JSON.stringify(`${title} ${TAG}`)}, body: ${JSON.stringify(text)} }); return 1;`);
    }
    await flushed();
    // With motion, as on a phone: the sheet slides in (the rest of this check runs with reduced motion).
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] }, S);
    // Opened, settled (the slide-in done): where its scroller stands, and what has the focus.
    const AT = `JSON.stringify((() => { const port = document.querySelector(".sh-root[data-open='1'] .sh-body"), a = document.activeElement;
      return { top: port ? Math.round(port.scrollTop) : null, room: port ? port.scrollHeight - port.clientHeight : null,
        focus: a ? a.tagName.toLowerCase() + (a.className ? "." + String(a.className).split(" ")[0] : "") : "", link: !!(a && a.closest("a")), ring: !!(a && a.matches(":focus-visible") && a.closest(".rf-list")) }; })())`;
    const settled = async () => { await waitFor(cdp, S, `document.getAnimations().every((x) => x.playState !== "running") ? 1 : 0`, { label: "the slide-in", timeout: 8000 }).catch(() => {}); await sleep(400); };
    await openList(); await settled();
    await said("a long list (five items, two of a dozen lines)");
    // room: the list overflows its sheet by more than 100 px (at 440x956, 163 px), so a scroll down would show.
    const first = await J(AT);
    check("a long list (five items, two of a dozen lines) opens at its top, no link and nothing in the list focused", first.room > 100 && first.top === 0 && !first.link && !first.ring, JSON.stringify(first));
    await stills("long list, opened");
    await ev(`(() => { const p = document.querySelector(".sh-root[data-open='1'] .sh-body"); p.scrollTop = p.scrollHeight; return 1; })()`);
    await sleep(300);
    await closeSheet();
    await openList(); await settled();
    const again = await J(AT);
    check("closed scrolled to its end and opened again: at its top", again.top === 0 && !again.link, JSON.stringify(again));
    await ev(`(() => { const p = document.querySelector(".sh-root[data-open='1'] .sh-body"); p.scrollTop = p.scrollHeight; return 1; })()`);
    await sleep(300);
    await ev(`(document.querySelector(".rf-add").click(), 1)`);
    await waitFor(cdp, S, `document.querySelector(".rf-form #rf-title") ? 1 : 0`, { label: "the form, from the list's end" });
    const added = `Pharmacy ${TAG}`;
    await ev(`(() => { document.querySelector("#rf-title").value = ${JSON.stringify(added)}; document.querySelector("#rf-text").value = "Open till 22:00."; return 1; })()`);
    await saveForm();
    await sleep(300);
    const addedId = await ev(`[...document.querySelectorAll(".sh-root[data-open='1'] .rf-item")].find((li) => li.querySelector(".rf-title").textContent === ${JSON.stringify(added)})?.dataset.rf || ""`);
    if (addedId) made.push(addedId);
    const after = await J(AT);
    await said("back on the list after an add");
    check("added from the list's end: back on the list at its top, the new item in it", !!addedId && after.top === 0 && !after.link, JSON.stringify({ addedId, ...after }));
    await closeSheet();
    await flushed();
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
    // A full list (the most it holds): its line under the list, and no "null" anywhere. The items made for it are
    // removed by their ids at once.
    const fill = JSON.parse(await inStore(`const { REFERENCES_MAX } = await import("/js/shared/limits.js"); const ids = [];
      for (let i = store.references().length; i < REFERENCES_MAX; i++) { const id = ${JSON.stringify(`rf_${TAG}_full_`.replace(/[^A-Za-z0-9_-]/g, "_"))} + i; ids.push(id);
        await store.addReference(id, { title: "Item " + i, body: "Text " + i }); }
      await store.flush(); return JSON.stringify({ ids, max: REFERENCES_MAX, now: store.references().length });`));
    made.push(...fill.ids);
    await sleep(800);
    await openList();
    const fullLine = await ev(`document.querySelector(".sh-root[data-open='1'] .rf-full")?.textContent ?? ""`);
    await said("a full list");
    check(`a full list (${fill.max}): it says it holds ${fill.max}, and "+ Add" can't be pressed`, fill.now === fill.max && fullLine.includes(String(fill.max))
      && !!(await ev(`document.querySelector(".rf-add").disabled`)), JSON.stringify({ now: fill.now, fullLine }));
    await closeSheet();
    await inStore(`for (const id of ${JSON.stringify(fill.ids)}) await store.deleteReference(id); await store.flush(); return 1;`);
    await sleep(800);
    check(`the sheet never says "null" or "undefined": ${saidBad.length} states (${saidBad.map((x) => x.state).join("; ")})`,
      saidBad.length >= 10 && saidBad.every((x) => x.bad === 0 && x.words > 0), JSON.stringify(saidBad.filter((x) => x.bad || !x.words)));
  }

  section("3. Two people: a member's open sheet sees the host's new item arrive");
  b2 = await boot({ vw: 440, vh: 956, dsf: 2, reduceMotion: true });
  const member = PEOPLE.find((p) => !p.host && !p.guest) || PEOPLE[1];
  await signInAs(b2.cdp, b2.S, member.key ?? member.id);
  await b2.cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/")}` }, b2.S);
  await appSettled(b2.cdp, b2.S).catch(() => {});
  await waitFor(b2.cdp, b2.S, `document.querySelector(".rf-fab") && getComputedStyle(document.querySelector(".rf-fab")).display !== "none" ? 1 : 0`, { label: "the member's button", timeout: 20000 });
  const meOn2 = await evalIn(b2.cdp, b2.S, `import("/js/store.js").then(({ store }) => store.me().id)`);
  await evalIn(b2.cdp, b2.S, `(document.querySelector(".rf-fab").click(), 1)`);
  await waitFor(b2.cdp, b2.S, `${SHEET} ? 1 : 0`, { label: "the member's sheet" });
  const liveId = `rf-${TAG}-live`;
  made.push(liveId);
  await inStore(`await store.addReference(${JSON.stringify(liveId)}, { title: ${JSON.stringify(`Door code ${TAG}`)}, body: "4321#" }); return 1;`);
  await flushed();
  const arrived = await waitFor(b2.cdp, b2.S, `[...document.querySelectorAll(".sh-root[data-open='1'] .rf-item")].some((li) => li.dataset.rf === ${JSON.stringify(liveId)}) ? 1 : 0`, { label: "the host's item on the member's sheet", timeout: 20000 }).then(() => true, () => false);
  check(`two people (the host and ${member.name}, two browsers): the host's new item arrives on the member's open sheet, no reload`, arrived && meOn2 !== HOST.id, `member ${meOn2}`);

  section("4. Offline: the list from the phone's own copy");
  b3 = await boot({ vw: 440, vh: 956, dsf: 2, reduceMotion: true });
  await plantOn(b3.cdp, b3.S);
  await b3.cdp.send("Network.setBypassServiceWorker", { bypass: false }, b3.S);
  await b3.cdp.send("Network.setCacheDisabled", { cacheDisabled: false }, b3.S);
  await b3.cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/")}` }, b3.S);
  await waitFor(b3.cdp, b3.S, `navigator.serviceWorker.controller ? 1 : 0`, { label: "the worker in control", timeout: 60000 });
  await appSettled(b3.cdp, b3.S).catch(() => {});
  await waitFor(b3.cdp, b3.S, `import("/js/store.js").then(({ store }) => store.references().some((r) => r.id === ${JSON.stringify(liveId)}) ? 1 : 0)`, { label: "the item on this phone", timeout: 20000 });
  await sleep(1500);
  await b3.cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, b3.S);
  await b3.cdp.send("Page.reload", {}, b3.S);
  const opened = await waitFor(b3.cdp, b3.S, `document.querySelector(".rf-fab") && getComputedStyle(document.querySelector(".rf-fab")).display !== "none" ? 1 : 0`, { label: "the button, offline", timeout: 30000 }).then(() => true, () => false);
  if (opened) {
    await sleep(1200);
    await evalIn(b3.cdp, b3.S, `(document.querySelector(".rf-fab").click(), 1)`);
    await waitFor(b3.cdp, b3.S, `${SHEET} ? 1 : 0`, { label: "the sheet, offline", timeout: 8000 }).catch(() => {});
    await sleep(600);
  }
  const offlineCards = opened ? JSON.parse(await evalIn(b3.cdp, b3.S, cards)) : [];
  const really = JSON.parse(await evalIn(b3.cdp, b3.S, `JSON.stringify({ online: navigator.onLine, controller: !!navigator.serviceWorker.controller })`).catch(() => "{}"));
  check("with no signal, reloaded: the trip opens from the phone's copy and the list holds the item", opened && really.online === false && offlineCards.some((c) => c.id === liveId && c.text === "4321#"), JSON.stringify({ really, offlineCards: offlineCards.map((c) => c.id) }));
  await b3.cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, b3.S);

  section("5. No page errors");
  check("nothing thrown", b.pageErrors.length === 0 && (b2?.pageErrors.length ?? 0) === 0, [...b.pageErrors, ...(b2?.pageErrors ?? [])].join(" | ").slice(0, 400));
} catch (e) {
  fail++; failures.push(`stopped: ${e.message}`);
  console.log(`  FAIL  stopped: ${e.stack || e}`);
} finally {
  // Only what this check made, by id.
  try {
    for (const id of made) await ev(`fetch(${JSON.stringify(tripApi("/references/"))} + encodeURIComponent(${JSON.stringify(id)}), { method: "DELETE", credentials: "same-origin" }).then((r) => r.status)`);
  } catch (e) { console.log(`  (clean-up: ${e.message})`); }
  await b3?.done().catch(() => {});
  await b2?.done().catch(() => {});
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }

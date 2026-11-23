#!/usr/bin/env node
/* THE NAMED ADD on Split, Packing and Photos (styles.css .head-add): from 768 each screen's head names its
 * add ("+ Add a purchase", "+ Add an item", "+ Add photos") and no floating + is drawn there; a phone keeps
 * its + and no named add. The made-up trip's host, in a real browser:
 *
 *   1. 768, 1024, 1440: on each of the three, the named add is drawn in the head, on one line, beside the
 *      head's own control (Split's currency chip, Packing's Mine/Group, Photos' view switch) and not
 *      over it, inside the page; no floating + is drawn; its tap opens the screen's own add sheet.
 *   2. 390: the + is drawn and no named add.
 *   3. A small phone (320, 360, 375): each head's control (the currency chip, Mine/Group, Photos' view switch) is
 *      inside the screen with every word of it whole, and so is everything else on the head's row.
 *
 *   node scripts/gate.mjs --only head_add_check
 *
 * PLANTED (red when put in by hand): styles.css without .head-add's 768 rule (1: no named add, the + back);
 * styles.css without the rule that takes the + away from 768 (1: both drawn). HEADADD_PLANT=narrow serves
 * memories.css without its small-phone rule for the view switch (3: Photos' switch runs off the screen at 320 and 360).
 */
import { BASE, boot, evalIn, waitFor, sleep, appSettled } from "./lib/standalone_cdp.mjs";
import { tripPath } from "./lib/gate_trip.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLANT = process.env.HEADADD_PLANT || "";
if (PLANT && PLANT !== "narrow") throw new Error(`no such plant: ${PLANT}`);
const PLANTED = PLANT ? (() => {
  const s = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/css/memories.css"), "utf8");
  const t = s.replace(/\/\* A small phone's view switch[\s\S]*?\n\}\n/, "");
  if (t === s) throw new Error("the narrow plant changed nothing"); return t; })() : null;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const J = async (cdp, S, expr) => JSON.parse(await evalIn(cdp, S, expr));

const SCREENS = [
  // Split is on the design system: its + is the white button's own icon (an svg), beside the words.
  { name: "Split", hash: "#/split", ready: `document.querySelector("#view .sp-head")`, words: "Add a purchase", icon: true, control: "#view .sp-cur", sheet: /purchase/i },
  { name: "Packing", hash: "#/pack", ready: `document.querySelector("#view .pk-own")`, words: "+ Add an item", control: "#view .pk-own", sheet: /item/i },
  // The made-up trip has no memories: its empty page's own "Add photos" is the way in, and the head's
  // named add is not drawn beside it (checked below); with memories it is (head_add_check's 1440 part
  // posts none, so a11y_public_check's board, with one, is where it shows).
  { name: "Photos", hash: "#/memories", ready: `document.querySelector("#view .me-top")`, words: "+ Add photos", control: "#view .me-views", sheet: /memory|photo/i, empty: true },
];
// What is drawn: the named add (its words, box, and lines: its words' own height over a line of its
// type, not its box, which is a 36 px tap target), the head's control, the floating +.
const READ = (control) => `JSON.stringify((() => {
  const drawn = (n) => !!n && getComputedStyle(n).display !== "none" && n.getClientRects().length > 0;
  const add = [...document.querySelectorAll("#view .head-add")].find(drawn) || null;
  const c = document.querySelector(${JSON.stringify(control)}), fab = document.querySelector("#rt-fixed .fab");
  const box = (n) => { const r = n.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height) }; };
  const v = document.getElementById("view").getBoundingClientRect();
  return { add: add ? { words: add.textContent.trim(), icon: !!add.querySelector("svg"), ...box(add), lines: (() => { const rg = document.createRange(); rg.selectNodeContents(add); return Math.round(rg.getBoundingClientRect().height / (parseFloat(getComputedStyle(add).fontSize) * 1.2)); })() } : null,
    control: drawn(c) ? box(c) : null, fab: drawn(fab), view: { l: Math.round(v.left), r: Math.round(v.right) } };
})())`;

const b = await boot({ vw: 1440, vh: 900, dsf: 1, reduceMotion: true });
const { cdp, S } = b;
if (PLANTED) {
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/css; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(PLANTED).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/css/memories.css*" }] }, S);
}
const size = async (w, h) => { await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: w < 768 ? 2 : 1, mobile: w < 1000 }, S); await sleep(400); };
const go = async (hash, ready) => {
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath(hash)}` }, S);
  await sleep(150);
  await cdp.send("Page.reload", { ignoreCache: true }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `${ready} && document.querySelector("#rt-fixed .fab") ? 1 : 0`, { label: hash, timeout: 30000 });
  await sleep(800);
};
try {
  for (const [w, h] of [[768, 1024], [1024, 768], [1440, 900]]) {
    section(`${w}`);
    await size(w, h);
    for (const sc of SCREENS) {
      await go(sc.hash, sc.ready);
      const r = await J(cdp, S, READ(sc.control));
      if (sc.empty) {
        const own = await evalIn(cdp, S, `(() => { const n = document.querySelector("#view .me-emptyadd"); return n && n.getClientRects().length ? n.textContent.trim() : ""; })()`);
        check(`${w}, ${sc.name} with nothing in it: its page's own "${own}" is the way in, no named add beside it, no floating +`, own === "Add photos" && !r.add && !r.fab, JSON.stringify({ own, add: r.add, fab: r.fab }));
        continue;
      }
      const beside = !!r.add && !!r.control && (r.add.r <= r.control.l - 4 || r.add.l >= r.control.r + 4 || r.add.b <= r.control.t || r.add.t >= r.control.b);
      check(`${w}, ${sc.name}: "${sc.words}" in its head, on one line, beside its control and not over it, inside the page; no floating +`,
        !!r.add && r.add.words === sc.words && (!sc.icon || r.add.icon) && r.add.lines === 1 && beside && r.add.l >= r.view.l && r.add.r <= r.view.r && !r.fab, JSON.stringify(r));
      if (w === 1440) {
        await evalIn(cdp, S, `([...document.querySelectorAll("#view .head-add")].find((n) => n.getClientRects().length).click(), 1)`);
        await waitFor(cdp, S, `document.querySelector(".sh-root[data-open='1'] .sh-sheet") ? 1 : 0`, { label: `${sc.name}'s sheet`, timeout: 8000 }).catch(() => {});
        await sleep(600);
        const title = await evalIn(cdp, S, `((document.querySelector(".sh-root[data-open='1'] .sh-title") || {}).textContent || "").trim()`);
        check(`${w}, ${sc.name}: its tap opens the screen's own add sheet`, sc.sheet.test(title), title);
        await evalIn(cdp, S, `(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
        await sleep(700);
      }
    }
  }
  section("390");
  await size(390, 844);
  for (const sc of SCREENS) {
    await go(sc.hash, sc.ready);
    const r = await J(cdp, S, READ(sc.control));
    check(`390, ${sc.name}: the + is drawn and no named add`, r.fab && !r.add, JSON.stringify({ fab: r.fab, add: r.add }));
  }
  // 3. A small phone: the head's row inside the screen, its control's words whole.
  for (const [w, h] of [[320, 568], [360, 780], [375, 667]]) {
    section(`${w}`);
    await size(w, h);
    for (const sc of SCREENS) {
      await go(sc.hash, sc.ready);
      const r = await J(cdp, S, `JSON.stringify((() => {
        const c = document.querySelector(${JSON.stringify(sc.control)}); if (!c || !c.getClientRects().length) return null;
        const row = c.parentElement, edge = document.documentElement.clientWidth;
        const out = [...row.querySelectorAll("*")].filter((n) => n.getClientRects().length && getComputedStyle(n).visibility !== "hidden").map((n) => ({ n, r: n.getBoundingClientRect() }))
          .filter((x) => x.r.width > 0 && (x.r.left < -0.5 || x.r.right > edge + 0.5)).map((x) => x.n.tagName + "." + String(x.n.className).split(" ")[0] + "@" + Math.round(x.r.left) + ".." + Math.round(x.r.right));
        const cut = [c, ...c.querySelectorAll("*")].filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflow !== "visible").length;
        const r = c.getBoundingClientRect();
        return { words: c.innerText.replace(/\\s+/g, " ").trim(), control: [Math.round(r.left), Math.round(r.right)], edge, out, cut }; })())`);
      check(`${w}, ${sc.name}: the head's control and its row inside the screen, every word whole`,
        !!r && r.out.length === 0 && r.cut === 0 && r.control[1] <= r.edge, JSON.stringify(r));
    }
  }
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

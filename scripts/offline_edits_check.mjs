#!/usr/bin/env node
/* EDITS MADE WITH NO SIGNAL, WHILE SOMEONE ELSE EDITS THE SAME TRIP (public/js/split.js saveDrawer, store.js flush,
 * packing-refusals.js refusalLine, index.html's refusal line): the gate's made-up trip, its host (Ada) and Teo, each
 * in an app window of their own at 440 x 956, by touch.
 *
 *   0. (no browser) The line for a change to something deleted elsewhere names it, never by its id: by the words the
 *      change carries, else by what this phone calls it, else "That purchase"/"That payment"/"That plan".
 *   1. ONE FIELD OFFLINE, ANOTHER ONLINE, BOTH KEPT: a purchase Ada made, paid by Teo. Ada's phone loses signal and she
 *      renames it in its sheet; Teo changes its amount in his; Ada's phone has signal again. The server, and both
 *      screens, have Ada's name AND Teo's amount.
 *   2. THE SAME FOR A PAYMENT: Teo pays Ada back; Ada, with no signal, makes it from Sol in its sheet; Teo changes its
 *      amount. Back: from Sol, with Teo's amount.
 *   3. A CHANGE TO WHAT ANOTHER PHONE DELETED: Ada, with no signal, renames a purchase; Teo deletes it. Back: Ada is
 *      told, in words that name it as she named it and hold no id, and the row is gone from her Split.
 *   4. No page error in either window.
 *
 *   node scripts/gate.mjs --only offline_edits_check
 *
 * Every row it makes is made through the store with an id it records, and removed by that id at the end.
 *
 * PLANTED (OFFLINE_PLANT=<name>, the file served changed in both windows, never written):
 *   whole       split.js sending every field of an edit again: 1 and 2 red (the other person's amount undone).
 *   idwords     packing-refusals.js without its line for a thing deleted elsewhere: 0 and 3 red (the server's
 *               sentence, with the id).
 */
import fs from "node:fs";
import { BASE, boot, evalIn, waitFor, sleep, appSettled, signInAs } from "./lib/standalone_cdp.mjs";
import { tripPath, person, d1 } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// ── the plants ─────────────────────────────────────────────────────────────────────────────
const PLANT = process.env.OFFLINE_PLANT || "";
const PLANTS = {
  whole: ["js/split.js", [
    ["    Object.assign(patch, when);\n", "    Object.assign(patch, { amount_minor: total, currency: D.currency, amount_exp: D.exp, split_mode: eco.split_mode, shares: eco.shares, description: desc, paid_by: D.paid_by, day: D.day || \"\", event_id: D.event_id || null, place_id: D.place_id || null }, when);\n"],
    ["        if (moved) r = await S.updatePayment(", "        if (true) r = await S.updatePayment("],
    ["...(D.paid_by !== was.paid_by ? { from: D.paid_by } : {}) });", "from: D.paid_by });"],
  ]],
  idwords: ["js/packing-refusals.js", [["  if (status === 404 && !(op && op.op === \"delete\")) return", "  if (false) return"]]],
};
if (PLANT && !PLANTS[PLANT]) throw new Error(`OFFLINE_PLANT is one of ${Object.keys(PLANTS).join(", ")}`);
const PLANTED = PLANT ? (() => {
  const [file, swaps] = PLANTS[PLANT];
  let t = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");
  for (const [a, b] of swaps) { const u = t.replace(a, b); if (u === t) throw new Error(`the ${PLANT} plant didn't take: ${a.slice(0, 60)}`); t = u; }
  console.log(`PLANTED: ${PLANT} (${file})`);
  return { file, body: t };
})() : null;

// ── 0. the words, no browser ───────────────────────────────────────────────────────────────
section("0. the line for a change to something deleted elsewhere");
{
  const src = PLANTED && PLANTED.file === "js/packing-refusals.js" ? PLANTED.body : fs.readFileSync(new URL("../public/js/packing-refusals.js", import.meta.url), "utf8");
  const { refusalLine } = await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`);
  const said = { error: "no such purchase", reason: "There's no purchase or payment \"pu-4f1c\" on this trip." };
  const a = refusalLine({ op: { kind: "purchase", op: "update", id: "pu-4f1c", payload: { description: "Lunch by the river" } }, status: 404, body: said }, { name: "Lunch", noun: "That purchase" });
  check("by the words the change carries", a === "“Lunch by the river” was deleted on another phone, so the change wasn't kept.", a);
  const b = refusalLine({ op: { kind: "purchase", op: "update", id: "pu-4f1c", payload: { amount_minor: 900 } }, status: 404, body: said }, { name: "Lunch", noun: "That purchase" });
  check("…else by what the phone calls it", b === "“Lunch” was deleted on another phone, so the change wasn't kept.", b);
  const c = refusalLine({ op: { kind: "purchase", op: "update", id: "pu-4f1c", payload: { spent_at: 5 } }, status: 404, body: said }, { name: "", noun: "That payment" });
  check("…else by what it is", c === "That payment was deleted on another phone, so the change wasn't kept.", c);
  check("never by its id", ![a, b, c].some((s) => /pu-4f1c/.test(s)), [a, b, c].join(" / "));
}

// ── the two windows ────────────────────────────────────────────────────────────────────────
const ST = `(await import("/js/store.js")).store`;
async function phone(who) {
  const b = await boot({ vw: 440, vh: 956, dsf: 2, reduceMotion: true });
  const { cdp, S } = b;
  await b.setInsets({ top: 59, right: 0, bottom: 34, left: 0 });
  if (PLANTED) {
    cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(PLANTED.body).toString("base64") }, S).catch(() => {}); });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*/${PLANTED.file}*` }] }, S);
  }
  await signInAs(cdp, S, who);
  const p = { who, b, cdp, S };
  p.ev = (e) => evalIn(cdp, S, e);
  p.J = async (e) => JSON.parse(await evalIn(cdp, S, `JSON.stringify(${e})`));
  p.call = (js) => p.ev(`(async () => { const s = ${ST}; ${js} })()`);
  p.split = async () => {
    await cdp.send("Page.navigate", { url: "about:blank" }, S); await sleep(120);
    await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/split")}` }, S);
    await appSettled(cdp, S);
    await waitFor(cdp, S, `document.querySelector(".sp-fab") ? 1 : 0`, { label: `${who}'s Split` });
    // Every line the shell's message says, kept in order.
    await p.ev(`(() => { window.__said = []; setInterval(() => { const t = document.getElementById("toast"); const s = t && !t.hidden ? t.innerText.trim() : ""; if (s && window.__said.at(-1) !== s) window.__said.push(s); }, 80); return 1; })()`);
  };
  p.tap = async (sel, nth = 0) => {
    const at = async () => p.J(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((x) => x.getClientRects().length)[${nth}]; if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!(await at())) throw new Error(`${who}: nothing to tap at ${sel}`);
    await sleep(200);
    const r = await at();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r.x, y: r.y }] }, S);
    await sleep(40);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, S);
    await sleep(300);
  };
  p.type = async (text) => { await cdp.send("Input.insertText", { text }, S); await sleep(150); };
  p.replace = async (sel, text) => { await p.tap(sel); await p.ev(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.select(); return 1; })()`); await p.type(text); };
  p.signal = async (on) => {
    await cdp.send("Network.emulateNetworkConditions", { offline: !on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
    await p.ev(`window.dispatchEvent(new Event(${JSON.stringify(on ? "online" : "offline")})), 1`);
  };
  p.sent = (timeout = 45000) => waitFor(cdp, S, `(async () => (${ST}).pending() === 0 ? 1 : 0)()`, { label: `${who}'s writes sent`, timeout });
  p.said = () => p.J(`window.__said || []`);
  p.row = (id) => p.J(`(() => { const r = [...document.querySelectorAll(".sp-row")].find((x) => x.dataset.id === ${JSON.stringify(id)}); return r ? r.innerText.replace(/\\n/g, " | ") : null; })()`);
  return p;
}

const ada = await phone(), teo = await phone("teo");
const ADA = person().id, TEO = person("teo").id, SOL = person("sol").id;
const tag = `${Date.now() % 1000000}`;
const made = [];
// What the server holds of a purchase, from its database.
const held = async (id) => {
  if (!/^[\w-]+$/.test(id)) throw new Error(`not an id to put in a statement: ${id}`);
  return (await d1(`SELECT description, amount_minor, paid_by FROM purchases WHERE id = '${id}'`))[0] ?? null;
};
const add = async (who, fields) => {
  const id = await who.call(`const ids = s.members().filter((m) => !m.deleted).map((m) => m.id).sort();
    const r = await s.addPurchase({ shares: ids.map((u) => ({ user_id: u, weight: 1 })), split_mode: "weight", currency: "USD", amount_exp: 2, ...${JSON.stringify(fields)} });
    return r && r.id;`);
  made.push(id);
  return id;
};
const pay = async (who, from, to, amount) => {
  const id = await who.call(`const r = await s.addPayment({ from: ${JSON.stringify(from)}, to: ${JSON.stringify(to)}, amount_minor: ${amount}, currency: "USD", amount_exp: 2 }); return r && r.id;`);
  made.push(id);
  return id;
};

try {
  await ada.split(); await teo.split();

  section("1. a purchase: renamed with no signal, its amount changed by another phone");
  {
    const id = await add(ada, { description: `Dinner ${tag}`, amount_minor: 4733, paid_by: TEO });
    await ada.sent();
    await ada.split(); await teo.split();
    await ada.signal(false);
    await ada.tap(`.sp-row[data-id="${id}"]`);
    await ada.replace(".sp-whatin", `Dinner at the port ${tag}`);
    await ada.tap('[data-sp="save"]');
    await teo.tap(`.sp-row[data-id="${id}"]`);
    await teo.replace(".sp-amtin", "52.10");
    await teo.tap('[data-sp="save"]');
    await teo.sent();
    await ada.signal(true);
    await ada.sent();
    await sleep(1200);
    const h = await held(id);
    check("the server has Ada's name and Teo's amount", h && h.description === `Dinner at the port ${tag}` && h.amount_minor === 5210, JSON.stringify(h));
    await ada.split(); await teo.split();
    const ra = await ada.row(id), rt = await teo.row(id);
    check("both screens show both", [ra, rt].every((r) => r && r.includes(`Dinner at the port ${tag}`) && r.includes("52.10")), `${ra} // ${rt}`);
  }

  section("2. a payment: made from someone else with no signal, its amount changed by another phone");
  {
    const id = await pay(teo, TEO, ADA, 2000);
    await teo.sent();
    await ada.split(); await teo.split();
    await ada.signal(false);
    await ada.tap(`.sp-row[data-id="${id}"]`);
    await ada.tap('[data-act="open-from"]');
    await ada.tap(`[data-grp="paid"] [data-id="${SOL}"]`);
    await ada.tap('[data-sp="save"]');
    await teo.tap(`.sp-row[data-id="${id}"]`);
    await teo.replace(".sp-amtin", "25.00");
    await teo.tap('[data-sp="save"]');
    await teo.sent();
    await ada.signal(true);
    await ada.sent();
    await sleep(1200);
    const h = await held(id);
    check("the server has it from Sol, with Teo's amount", h && h.paid_by === SOL && h.amount_minor === 2500, JSON.stringify(h));
  }

  section("3. a purchase renamed with no signal, deleted by another phone");
  {
    const id = await add(ada, { description: `Lunch ${tag}`, amount_minor: 6000, paid_by: TEO });
    await ada.sent();
    await ada.split(); await teo.split();
    await ada.signal(false);
    await ada.tap(`.sp-row[data-id="${id}"]`);
    await ada.replace(".sp-whatin", `Lunch by the river ${tag}`);
    await ada.tap('[data-sp="save"]');
    await teo.call(`await s.deletePurchase(${JSON.stringify(id)}); return 1;`);
    await teo.sent();
    await ada.signal(true);
    await ada.sent();
    await sleep(1500);
    const said = await ada.said();
    const line = said.find((s) => /deleted|couldn't|wasn't/.test(s)) || "";
    check("Ada is told, by the name she gave it", line === `“Lunch by the river ${tag}” was deleted on another phone, so the change wasn't kept.`, JSON.stringify(said));
    check("…in words that hold no id", !said.some((s) => s.includes(id)), JSON.stringify(said));
    check("the row is gone from her Split", (await ada.row(id)) === null);
  }

  section("4. no page error");
  check("none in Ada's window", !ada.b.pageErrors.length, ada.b.pageErrors.join(" | "));
  check("none in Teo's window", !teo.b.pageErrors.length, teo.b.pageErrors.join(" | "));
} finally {
  for (const id of made.filter(Boolean)) {
    for (const p of [ada, teo]) {
      await p.signal(true).catch(() => {});
      await p.call(`if (s.purchases().some((r) => r.id === ${JSON.stringify(id)})) { try { await s.deletePurchase(${JSON.stringify(id)}); } catch (e) { return e.message; } } return 1;`).catch(() => {});
    }
  }
  await ada.sent().catch(() => {}); await teo.sent().catch(() => {});
  await ada.b.done(); await teo.b.done();
}
console.log(`\noffline edits: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAILED  ${f}`);
process.exit(fail ? 1 : 0);

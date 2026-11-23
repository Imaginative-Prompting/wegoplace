#!/usr/bin/env node
/* Settling up, in real browsers, on a server of its own: a payment recorded, corrected and
 * deleted in Split (public/js/split.js, money.js's netBalances, the store's addPayment and
 * updatePayment).
 *
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
 *     --label "wegoplace settle_check.mjs" -- node scripts/settle_check.mjs
 *
 * WGP_SHOTS=<folder> also writes pictures at 320, 390, 768 and 1440 wide in both themes, to
 * look at. Nothing is asserted from them.
 *
 * The server is this check's own (checks/lib/server.mjs: an empty database, a port of its
 * own). Three made-up people, a browser each: one who owes, one who is owed, one who is
 * neither side of the payment.
 *
 * WHAT IT PROVES
 *   1. A TRANSFER CAN BE ACTED ON. The settle sheet's "Ben pays Ada" is a button that says
 *      "Mark paid".
 *   2. MARK PAID OPENS THE PAYMENT FILLED IN and records nothing by itself: the amount, From
 *      and To are the transfer's, and To never offers the person it is from.
 *   3. RECORD SENDS ONE ROW: kind "payment", one share (the receiver, the whole amount), no
 *      day. The settle sheet comes back with the transfer gone, the payer even with a "paid
 *      back" line, and the payment listed.
 *   4. THE FEED SHOWS IT AS A PAYMENT, the card moves, and "spent so far" does not: a payment
 *      is not spending.
 *   5. THE PERSON WHO RECEIVED IT sees it, and can correct it (a part payment): the request
 *      carries the amount and the one share together, and the payer owes the rest again.
 *   6. SOMEONE WHO IS NEITHER SIDE can read it and change nothing, and is told who can.
 *   7. "RECORD A PAYMENT" for one the list doesn't suggest, WITH NO SIGNAL: Record waits for
 *      an amount and a receiver; choosing the receiver as the payer swaps the two; the payment
 *      is in the feed at once, waits in the phone's queue, and is sent when the API answers.
 *   8. A PAYMENT IS DELETED in two taps by the person who received it, and what it settled
 *      is owed again.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";

const server = await startServer({ name: "settle", port: await freeLoopbackPort() });
ownServer(server.origin);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const phones = [];
try {
  await server.start();
  const ada = new Person(server.origin, "Ada Reyes"), ben = new Person(server.origin, "Ben Okafor"), cleo = new Person(server.origin, "Cleo Tran"), dev = new Person(server.origin, "Dev Halloran");
  for (const p of [ada, ben, cleo]) await p.signUp();
  await dev.signUp();
  const [adaId, benId, cleoId] = [(await ada.me()).id, (await ben.me()).id, (await cleo.me()).id];

  const made = await ada.post("/api/trips", { name: "Lake weekend", default_tz: "Europe/Lisbon", currencies: ["EUR"] });
  const trip = made.json.trip.id, T = `/api/trips/${trip}`;
  const link = await ada.post(`${T}/links`, {});
  const j1 = await ben.post(`/api/join/${link.json.link.code}`), j2 = await cleo.post(`/api/join/${link.json.link.code}`);
  // Dev is on the trip and on no purchase: the fourth person, for a payment a third wrote down.
  await dev.post(`/api/join/${link.json.link.code}`);
  // Dinner, 90.00, paid by Ada, split three ways: Ben and Cleo owe 30.00 each.
  const dinner = await ada.post(`${T}/purchases`, {
    id: "pu-dinner", description: "Dinner", amount_minor: 9000, currency: "EUR", amount_exp: 2, split_mode: "weight",
    spent_at: Math.floor(Date.now() / 1000) - 3600,
    shares: [adaId, benId, cleoId].sort().map((u) => ({ user_id: u, weight: 1, share_minor: 3000 })),
  });
  check("three people on a trip, and a dinner one of them paid for", made.status === 201 && j1.status < 300 && j2.status < 300 && dinner.status < 300,
    `${made.status} ${j1.status} ${j2.status} ${dinner.status} ${dinner.text.slice(0, 200)}`);
  const rowsOf = async () => (await ada.get(`${T}/purchases`)).json.purchases;

  const { boot, evalIn, waitFor, appSettled, sleep } = await import("./lib/standalone_cdp.mjs");

  // A phone: one browser, signed in as one person.
  async function phoneOf(person, { motion = false } = {}) {
    const b = await boot({ vw: 390, vh: 844, dsf: 1, reduceMotion: !motion });
    phones.push(b);
    const { cdp, S } = b;
    for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: server.origin }, S);
    await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: person.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
    const who = person.jar.cookies.get("wgp_who");
    if (who) await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: who, sameSite: "Lax" }, S);
    const page = (expr) => evalIn(cdp, S, expr);
    const writes = [];
    cdp.on((m) => {
      if (m.sessionId !== S || m.method !== "Network.requestWillBeSent") return;
      const r = m.params.request;
      if (r.method !== "GET" && /\/api\/trips\/[^/]+\/purchases/.test(r.url)) writes.push({ method: r.method, path: new URL(r.url).pathname, body: r.postData || "" });
    });
    const wait = (expr, label) => waitFor(cdp, S, expr, { label });
    // The sheet on top: while one sheet leaves and the next arrives there are two.
    const TOP = `[...document.querySelectorAll(".sh-root")].pop()`;
    const p = {
      b, page, writes, wait,
      async open() {
        await cdp.send("Page.navigate", { url: `${server.origin}/t/${trip}/?${Date.now()}#/split` }, S);
        await sleep(300);
        await appSettled(cdp, S);
        await wait(`document.querySelector(".sp-hero") && document.querySelector(".sp-row") ? 1 : 0`, "Split with its headline and feed");
        await sleep(400);
      },
      async tap(sel, label = sel) {
        const got = await page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return 0; if (n.disabled) return -1; n.click(); return 1; })()`);
        if (got !== 1) throw new Error(`tap: ${label} ${got === 0 ? "is not there" : "is disabled"}`);
        await sleep(200);
      },
      async type(sel, value) {
        const ok = await page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return 0; n.focus(); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
        if (!ok) throw new Error(`type: ${sel} is not there`);
        await sleep(160);
      },
      apiOff: (off) => cdp.send("Network.setBlockedURLs", { urls: off ? ["*/api/*"] : [] }, S),
      pending: () => page(`import("/js/store.js").then(({ store }) => store.pending())`),
      // One sheet, arrived, with this title, and no other sheet still leaving.
      async sheet(title) {
        await wait(`(() => { const all = [...document.querySelectorAll(".sh-root")]; const r = all[all.length - 1];
          return all.length === 1 && r.dataset.entered === "1" && r.querySelector(".sh-title").textContent.trim() === ${JSON.stringify(title)} ? 1 : 0; })()`, `the sheet "${title}"`);
        await sleep(300);
      },
      async sheetGone() {
        await wait(`document.querySelector(".sh-root") ? 0 : 1`, "no sheet");
        await sleep(300);
      },
      // The card and the feed.
      split: async () => JSON.parse(await page(`JSON.stringify((() => {
        const text = (n) => (n ? n.innerText.replace(/\\s+/g, " ").trim() : "");
        return {
          card: text(document.querySelector(".sp-hero")),
          rows: [...document.querySelectorAll("#view .sp-row")].map((r) => (r.dataset.kind || "purchase") + " :: " + text(r)),
        };
      })())`)),
      // The settle sheet: each person's line, the transfers, the payments, the button at its end.
      settle: async () => JSON.parse(await page(`JSON.stringify((() => {
        const R = ${TOP};
        const text = (n) => (n ? n.innerText.replace(/\\s+/g, " ").trim() : "");
        return {
          title: text(R.querySelector(".sh-title")),
          people: [...R.querySelectorAll(".sp-bal")].map((n) => text(n) + " " + ((document.getElementById(n.getAttribute("aria-controls")) || {}).textContent || "")),
          transfers: [...R.querySelectorAll(".sp-plan li")].map((n) => n.querySelector('.sp-tr-go[data-act="mark-paid"]').tagName + " " + text(n)),
          payments: [...R.querySelectorAll('.sp-row[data-act="payment"]')].map((n) => n.tagName + " " + text(n)),
          nobody: text(R.querySelector('[data-sp="plan-none"]')),
          record: text(R.querySelector('[data-act="record"]')),
        };
      })())`)),
      // The payment's sheet as it stands.
      form: async () => JSON.parse(await page(`JSON.stringify((() => {
        const R = ${TOP};
        const text = (n) => (n ? n.innerText.replace(/\\s+/g, " ").trim() : "");
        // A chip's name, as its own element says it (its face beside it is decoration, hidden from a screen reader).
        const chips = (g) => [...R.querySelectorAll('[data-grp="' + g + '"] .sp-person')].map((c) => (c.getAttribute("aria-checked") === "true" ? "*" : "") + text(c.querySelector(".sp-pname") || c));
        const save = R.querySelector('[data-act="save"]');
        const amt = R.querySelector(".sp-amtin");
        return {
          title: text(R.querySelector(".sh-title")), amount: amt ? amt.value : null, amountOff: amt ? amt.disabled : null, currency: text(R.querySelector('[data-act="cur"]')),
          read: text(R.querySelector(".sp-read")), fields: R.querySelectorAll("input, select, textarea, .sp-person").length,
          answers: [...R.querySelectorAll(".sp-opt")].map(text),
          from: chips("paid"), to: chips("to"), chipsOff: [...R.querySelectorAll(".sp-person")].every((c) => c.disabled),
          save: save ? text(save) + (save.disabled ? " (off)" : "") : "", del: text(R.querySelector('[data-act="del"]')),
          sub: text(R.querySelector(".sp-read-who")), fine: text(R.querySelector(".sp-fine")), note: text(R.querySelector(".sp-armnote")),
          purchaseParts: R.querySelectorAll('[data-f="description"], [data-act="open-split"], [data-act="goes"], [data-grp="split"], [data-slot="receipt"]').length,
        };
      })())`)),
      chip: (grp, id) => p.tap(`.sh-root [data-grp="${grp}"] .sp-person[data-id="${id}"]`, `${grp}: ${id}`),
      async look(name) {
        if (!SHOTS) return;
        const was = await page(`document.documentElement.getAttribute("data-theme") || ""`);
        for (const theme of ["light", "dark"]) {
          await page(`(document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)}), document.documentElement.setAttribute("data-lum", ${JSON.stringify(theme)}), 1)`);
          await sleep(600);
          for (const w of [320, 768, 1440, 390]) {
            await b.metrics(w, 844, w > 400 ? 1 : 2);
            await sleep(400);
            await b.shot(path.join(SHOTS, `${name}-${w}-${theme}.png`));
          }
        }
        await page(`(${JSON.stringify(was)} ? document.documentElement.setAttribute("data-theme", ${JSON.stringify(was)}) : document.documentElement.removeAttribute("data-theme"), 1)`);
        await b.metrics(390, 844, 1);
        await sleep(300);
      },
    };
    return p;
  }
  // Ben's phone moves as a phone does (no reduced motion): Mark paid closes the settle sheet
  // and opens the payment's in the same slot, and Record or the backdrop brings the settle
  // sheet back, each while the other is still sliding.
  const B = await phoneOf(ben, { motion: true }), A = await phoneOf(ada), C = await phoneOf(cleo);

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────────
  section("1. a transfer can be acted on");
  await B.open();
  let s = await B.split();
  check("Ben's headline is the answer: who he owes, how much, and Mark paid", /^You owe Ada Reyes €30\.00 Mark paid Everyone's balances$/.test(s.card), s.card);
  await B.tap('#view [data-act="settle"]', "Everyone's balances");
  await B.sheet("Settle up");
  let st = await B.settle();
  check("two transfers, each a button that says Mark paid; on Ben's phone his own comes first, as \"You pay\"",
    st.transfers.length === 2 && st.transfers.every((t) => /^BUTTON /.test(t) && /Mark paid$/.test(t)) && /You pay Ada €30\.00/.test(st.transfers[0]) && /Cleo pays Ada €30\.00/.test(st.transfers[1]), JSON.stringify(st.transfers));
  check("no payments yet, and a way to record one the list doesn't suggest", st.payments.length === 0 && st.record === "Record another payment", JSON.stringify(st));
  await B.look("settle-before");

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────────
  section("2. Mark paid opens the payment, filled in");
  let before = B.writes.length;
  await B.tap(`.sh-root .sp-tr-go[data-act="mark-paid"][data-from="${benId}"]`, "Ben pays Ada: Mark paid");
  await B.sheet("Mark paid");
  let f = await B.form();
  check("the amount is the transfer's, in its currency", f.amount === "30.00" && /EUR/.test(f.currency), JSON.stringify(f));
  check("From is Ben (You), To is Ada, and To doesn't offer the person it is from",
    f.from.join() === "Ada Reyes,*You,Cleo Tran,Dev Halloran" && f.to.join() === "*Ada Reyes,Cleo Tran,Dev Halloran", JSON.stringify([f.from, f.to]));
  check("…and its rows say so in words", f.answers.join(" | ") === "From You | To Ada Reyes | When Today", JSON.stringify(f.answers));
  check('the button says "Mark paid", as the line and the title did, and it is ready', f.save === "Mark paid", f.save);
  check("nothing a payment doesn't have: no description, no Split, no For, no receipt; and no lesson", f.purchaseParts === 0 && f.fine === "", JSON.stringify(f));
  check("opening it recorded nothing", B.writes.length === before, JSON.stringify(B.writes.slice(before)));
  await B.look("payment-sheet");

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────────
  section("3. Mark paid sends one row, and the settle sheet comes back");
  await B.tap('.sh-root [data-act="save"]', "Mark paid");
  await B.sheet("Settle up");
  await B.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the payment sent");
  const posts = B.writes.slice(before).filter((w) => w.method === "POST");
  const sent = posts.length ? JSON.parse(posts[0].body) : {};
  check("ONE request", posts.length === 1 && B.writes.length === before + 1, JSON.stringify(B.writes.slice(before).map((w) => w.method + " " + w.path)));
  check('it is a payment: kind "payment", from Ben, one share (Ada, the whole amount), no day',
    sent.kind === "payment" && sent.paid_by === benId && sent.amount_minor === 3000 && sent.currency === "EUR" && sent.shares.length === 1 &&
    sent.shares[0].user_id === adaId && sent.shares[0].share_minor === 3000 && sent.day === "" && sent.event_id === null && sent.place_id === null && sent.description === "",
    JSON.stringify(sent));
  let rows = await rowsOf();
  const pay = rows.find((r) => r.kind === "payment");
  check("the server has it as a payment, written down by Ben", !!pay && pay.paid_by === benId && pay.created_by === benId && pay.amount_minor === 3000 && pay.shares.length === 1, JSON.stringify(pay));
  await sleep(500);
  st = await B.settle();
  const benLine = st.people.find((x) => /^You /.test(x)) || "";
  check("Ben is settled, and his line opens to why: paid back €30.00", benLine === "You settled Paid €0.00. Share €30.00. Paid back €30.00.", benLine);
  check("his payment is gone from the plan; Cleo's stays", st.transfers.length === 1 && /Cleo pays Ada €30\.00/.test(st.transfers[0]), JSON.stringify(st.transfers));
  check('the payment is listed, on his phone as "You paid Ada Reyes", €30.00, today',
    st.payments.length === 1 && /^BUTTON .*You paid Ada Reyes €30\.00 Today$/.test(st.payments[0]), JSON.stringify(st.payments));
  await B.look("settle-after");

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────────
  section("4. the feed shows a payment, and it is not spending");
  await B.tap(".sh-root .sh-x", "the sheet's X");
  await B.sheetGone();
  s = await B.split();
  check("the newest row is the payment: who paid whom, the amount, and the word", /^payment :: BO You paid Ada Reyes €30\.00 Payment$/.test(s.rows[0] || ""), JSON.stringify(s.rows));
  check("the dinner is still a purchase: one mark, who paid, and Ben's share in words", s.rows.length === 2 && /^purchase :: AR Dinner €90\.00 Ada paid your share €30\.00$/.test(s.rows[1]), JSON.stringify(s.rows));
  check("Ben's headline: settled up; what was spent has not moved (a payment is not spending)", /^You're settled up €90\.00 spent together\. Your share is €30\.00\./.test(s.card), s.card);
  await B.look("feed-with-payment");

  // ── 5 ──────────────────────────────────────────────────────────────────────────────────────
  section("5. the person who received it can correct it");
  await A.open();
  s = await A.split();
  check("Ada's phone has the payment, and she is owed the rest, by Cleo", /^payment :: /.test(s.rows[0] || "") && /^Cleo Tran owes you €30\.00 Mark paid/.test(s.card), JSON.stringify(s));
  await A.tap('#view .sp-row[data-kind="payment"]', "the payment's row");
  await A.sheet("Payment");
  f = await A.form();
  check("it opens as it was recorded, for changing: From Ben, To her, Save changes and Delete payment",
    f.amount === "30.00" && f.from.join() === "You,*Ben Okafor,Cleo Tran,Dev Halloran" && f.to.join() === "*You,Cleo Tran,Dev Halloran" && !f.amountOff && f.save === "Save changes" && f.del === "Delete payment" && f.sub === "", JSON.stringify(f));
  await A.type(".sh-root .sp-amtin", "20");
  before = A.writes.length;
  await A.tap('.sh-root [data-act="save"]', "Save changes");
  await A.sheetGone();
  await A.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the change sent");
  const patches = A.writes.slice(before);
  const patch = patches.length ? JSON.parse(patches[0].body || "{}") : {};
  check("ONE change, carrying the amount and the one share together", patches.length === 1 && patches[0].method === "PATCH" && patch.amount_minor === 2000 && patch.shares.length === 1 && patch.shares[0].user_id === adaId && patch.split_mode === "exact", JSON.stringify(patches));
  rows = await rowsOf();
  check("the server has 20.00, still a payment, still to her", rows.find((r) => r.id === pay.id).amount_minor === 2000 && rows.find((r) => r.id === pay.id).kind === "payment", JSON.stringify(rows.find((r) => r.id === pay.id)));
  // A payment stays a payment: a change asking for another kind through the store sends the
  // rest of the change and not the kind.
  before = A.writes.length;
  const spentAt = rows.find((r) => r.id === pay.id).spent_at;
  await A.page(`import("/js/store.js").then(({ store }) => store.updatePurchase(${JSON.stringify(pay.id)}, { kind: "purchase", spent_at: ${spentAt - 60} })).then(() => 1, (e) => String(e))`);
  await A.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the change sent");
  const kindTry = A.writes.slice(before).map((w) => JSON.parse(w.body || "{}"));
  rows = await rowsOf();
  check("asking the store to make it a purchase sends no kind, and it is still a payment, on the phone and the server",
    kindTry.length === 1 && !("kind" in kindTry[0]) && kindTry[0].spent_at === spentAt - 60 &&
    rows.find((r) => r.id === pay.id).kind === "payment" &&
    (await A.page(`import("/js/store.js").then(({ store }) => store.purchase(${JSON.stringify(pay.id)}).kind)`)) === "payment",
    JSON.stringify(kindTry));
  s = await A.split();
  // The lines come in the plan's own order, as Settle up lists them (check:split holds the two agree).
  check("she is owed 40.00 now, by two people, a line each", /^You're owed €40\.00 /.test(s.card) && s.card.includes("Ben Okafor €10.00 Mark paid")
    && s.card.includes("Cleo Tran €30.00 Mark paid"), s.card);
  await B.open();
  s = await B.split();
  check("and Ben's phone says he owes the rest: €10.00", /^You owe Ada Reyes €10\.00/.test(s.card) && /€20\.00 Payment$/.test(s.rows[0]), JSON.stringify(s));
  // Now the smaller transfer is Ben's (10.00 against Cleo's 30.00): on his phone it still comes first.
  await B.tap('#view [data-act="settle"]', "Everyone's balances");
  await B.sheet("Settle up");
  st = await B.settle();
  check("on Ben's phone his own transfer comes first, though it is the smaller",
    st.transfers.length === 2 && /You pay Ada €10\.00/.test(st.transfers[0]) && /Cleo pays Ada €30\.00/.test(st.transfers[1]), JSON.stringify(st.transfers));
  await B.tap(".sh-root .sh-x", "the sheet's X");
  await B.sheetGone();

  // ── 6 ──────────────────────────────────────────────────────────────────────────────────────
  section("6. someone who is neither side reads it and changes nothing");
  await C.open();
  await C.tap('#view .sp-row[data-kind="payment"]', "the payment's row");
  await C.sheet("Ben Okafor paid Ada Reyes");
  f = await C.form();
  check("it opens as a read view: who paid whom, how much, when; no field, no Save, no Delete",
    /^€20\.00 Payment on \w{3}, \w{3} \d+/.test(f.read), JSON.stringify(f));
  check("  (nothing to press: no field, no Save, no Delete)", f.fields === 0 && f.save === "" && f.del === "", JSON.stringify(f));
  check("and it says who can change it", f.sub === "Only Ben Okafor and Ada Reyes can change it.", f.sub);
  await C.look("payment-read-only");
  // A read view has its ×; the backdrop closes it too.
  await C.page(`(document.querySelector(".sh-backdrop, .sh-scrim") || document.querySelector(".sh-root")).click(), 1`);
  await C.sheetGone();

  // ── 7 ──────────────────────────────────────────────────────────────────────────────────────
  section('7. "Record a payment", with no signal');
  await C.tap('#view [data-act="settle"]', "Everyone's balances");
  await C.sheet("Settle up");
  await C.apiOff(true);
  await C.tap('.sh-root [data-act="record"]', "Record another payment");
  await C.sheet("Record a payment");
  f = await C.form();
  check("it opens from her, to nobody yet, with no amount: its button waits", f.from.join() === "Ada Reyes,Ben Okafor,*You,Dev Halloran" && f.to.join() === "Ada Reyes,Ben Okafor,Dev Halloran" && f.amount === "" && f.save === "Record payment (off)", JSON.stringify(f));
  check("its To row says nobody's chosen yet, in words", /^To Choose someone$/.test(f.answers[1] || ""), JSON.stringify(f.answers));
  await C.type(".sh-root .sp-amtin", "30");
  f = await C.form();
  check("an amount alone is not enough", f.save === "Record payment (off)", f.save);
  await C.chip("to", adaId);
  f = await C.form();
  check("with a receiver it is ready", f.to.join() === "*Ada Reyes,Ben Okafor,Dev Halloran" && f.save === "Record payment", JSON.stringify(f));
  await C.chip("paid", adaId);
  f = await C.form();
  check("From the person it was going to: the two change places", f.from.join() === "*Ada Reyes,Ben Okafor,You,Dev Halloran" && f.to.join() === "Ben Okafor,*You,Dev Halloran" && f.save === "Record payment", JSON.stringify([f.from, f.to]));
  await C.chip("paid", cleoId);
  f = await C.form();
  check("and back again", f.from.join() === "Ada Reyes,Ben Okafor,*You,Dev Halloran" && f.to.join() === "*Ada Reyes,Ben Okafor,Dev Halloran", JSON.stringify([f.from, f.to]));
  before = C.writes.length;
  await C.tap('.sh-root [data-act="save"]', "Record payment");
  await C.sheet("Settle up");
  await sleep(600);
  st = await C.settle();
  check("with no signal it is on the settle sheet at once: two payments, and she is settled",
    st.payments.length === 2 && /You paid Ada Reyes €30\.00 Today/.test(st.payments[0]) && st.people.some((x) => /^You settled /.test(x) && /Paid back €30\.00\./.test(x)), JSON.stringify(st));
  check("it waits in the phone's queue", (await C.pending()) === 1, await C.pending());
  rows = await rowsOf();
  check("the server doesn't have it yet", rows.filter((r) => r.kind === "payment").length === 1, rows.length);
  await C.apiOff(false);
  await C.page(`import("/js/store.js").then(({ store }) => (store.flush ? store.flush() : store.sync && store.sync(), 1))`).catch(() => {});
  await C.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the payment sent once the API answers");
  rows = await rowsOf();
  const second = rows.find((r) => r.kind === "payment" && r.paid_by === cleoId);
  check("sent when the API answers: from Cleo, to Ada, 30.00", !!second && second.amount_minor === 3000 && second.shares[0].user_id === adaId && second.created_by === cleoId, JSON.stringify(second));
  await C.tap(".sh-root .sh-x", "the sheet's X");
  await C.sheetGone();

  // ── 8 ──────────────────────────────────────────────────────────────────────────────────────
  section("8. a payment is deleted by the person who received it");
  await A.open();
  await A.tap('#view [data-act="settle"]', "Everyone's balances");
  await A.sheet("Settle up");
  st = await A.settle();
  check("Ada's settle sheet lists both payments, each as \"… paid you\", and what she got back", st.payments.length === 2 && st.payments.every((x) => / paid you /.test(x)) && st.people.some((x) => /^You /.test(x) && /Got back €50\.00\./.test(x)), JSON.stringify(st));
  await A.look("settle-two-payments");
  await A.tap(`.sh-root .sp-row[data-act="payment"][data-id="${pay.id}"]`, "Ben's payment");
  await A.sheet("Payment");
  before = A.writes.length;
  await A.tap('.sh-root [data-act="del"]', "Delete");
  f = await A.form();
  check("one tap asks: the button says what a second does, with what it means", f.del === "Tap again to delete" && /What it settled is owed again/.test(f.note) && A.writes.length === before, JSON.stringify([f.del, f.note]));
  await A.look("payment-delete-armed");
  // Delete stays armed for 4 s, and the stills take longer: arm it again for the second tap.
  if ((await A.form()).del !== "Tap again to delete") await A.tap('.sh-root [data-act="del"]', "Delete, armed again after the stills");
  await A.tap('.sh-root [data-act="del"]', "Tap again to delete");
  await A.sheet("Settle up");
  await A.wait(`import("/js/store.js").then(({ store }) => store.pending() === 0 ? 1 : 0)`, "the removal sent");
  const dels = A.writes.slice(before);
  check("ONE removal", dels.length === 1 && dels[0].method === "DELETE" && dels[0].path.endsWith(`/purchases/${pay.id}`), JSON.stringify(dels));
  rows = await rowsOf();
  check("the server no longer has it", !rows.some((r) => r.id === pay.id) && rows.length === 2, JSON.stringify(rows.map((r) => r.id)));
  await sleep(400);
  st = await A.settle();
  check("the settle sheet came back: one payment, and Ben owes his 30.00 again (on Ada's phone, \"Ben pays you\")", st.payments.length === 1 && st.transfers.length === 1 && /Ben pays you €30\.00/.test(st.transfers[0]), JSON.stringify(st));

  // ── 9 ──────────────────────────────────────────────────────────────────────────────────────
  section("9. a payment a third person wrote down, read by a fourth");
  const third = await cleo.post(`${T}/purchases`, { id: "pu-third", kind: "payment", description: "", amount_minor: 500, currency: "EUR", amount_exp: 2, paid_by: benId,
    split_mode: "weight", shares: [{ user_id: adaId, weight: 1, share_minor: 500 }] });
  check("Cleo writes down that Ben paid Ada 5.00", third.status < 300, third.text.slice(0, 200));
  const D = await phoneOf(dev);
  await D.open();
  await D.tap('#view .sp-row[data-id="pu-third"]', "the payment Cleo wrote down");
  await D.sheet("Ben Okafor paid Ada Reyes");
  f = await D.form();
  check("Dev reads it as a read view, told all three who may change it: who paid, who received, who wrote it down",
    f.fields === 0 && f.save === "" && f.del === "" && /Payment on /.test(f.read) && /Written down by Cleo Tran/.test(f.read) &&
    f.sub === "Only Ben Okafor, Ada Reyes and Cleo Tran can change it.", JSON.stringify(f));
  await D.look("payment-read-only-three");

  // ── 10 ─────────────────────────────────────────────────────────────────────────────────────
  section("10. someone who left: kept on what they shared, never assumed in a new purchase");
  const left = await dev.call("DELETE", `${T}/members/${encodeURIComponent((await dev.me()).id)}`);
  check("Dev leaves the trip", left.status < 300, `${left.status} ${left.text.slice(0, 160)}`);
  await A.open();
  s = await A.split();
  check("the dinner is unchanged on Ada's phone: who paid and her share", s.rows.some((r) => /^purchase :: AR Dinner €90\.00 You paid your share €30\.00$/.test(r)), JSON.stringify(s.rows));
  await A.tap("#rt-fixed .fab", "the + button");
  await A.sheet("Add a purchase");
  await A.tap('.sh-root [data-act="open-split"]', "the Split row");
  const chipsOf = (g) => A.page(`JSON.stringify([...document.querySelectorAll('.sh-root [data-grp="${g}"] .sp-person')].map((c) => {
    const on = c.getAttribute("aria-checked") === "true";
    const label = c.querySelector(".sp-pname").firstChild.textContent.trim();
    return (on ? "*" : "") + label + (c.dataset.gone ? "(" + c.dataset.gone + ")" : "");
  }))`).then(JSON.parse);
  const chips = { paid: await chipsOf("paid"), split: await chipsOf("split") };
  check("a new purchase offers Dev after everyone else, marked as having left, unticked, and never the payer",
    chips.paid.join() === "*You,Ben Okafor,Cleo Tran,Dev Halloran(left the trip)" && chips.split.join() === "*You,*Ben Okafor,*Cleo Tran,Dev Halloran(left the trip)", JSON.stringify(chips));
  await A.look("purchase-someone-left");

  check("no page error in any browser", phones.every((b) => b.pageErrors.length === 0), phones.flatMap((b) => b.pageErrors).join(" | "));
} catch (e) {
  fail++; failures.push("the check ran to its end");
  console.log(`  FAIL  the check ran to its end   -> ${e && e.stack ? e.stack : e}`);
} finally {
  for (const b of phones) await b.done().catch(() => {});
  await server.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(fail ? 1 : 0);

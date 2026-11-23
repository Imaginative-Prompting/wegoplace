// Split's answer, in a browser: the headline, the rows' "your share", the taps, the foot button and
// the one moment of motion (public/js/split.js; the numbers are money.js's).
//
//   node checks/split/run.mjs [--port <port>] [--shots <folder>]
//
// On a server of its own. Four made-up people on five made-up trips, so that between them every
// state of the headline is somebody's. It holds:
//   1. THE HEADLINE IS THE ANSWER, in each of its states: you owe one person ("You owe Ada Reyes",
//      the amount, Mark paid), you owe several ("You owe", the total, a line each), one person owes
//      you, several do ("You're owed"), nothing to pay ("You're settled up", what was spent and
//      your share), no purchases ("Nothing to split yet"), no rate for anything ("Totals need
//      exchange rates"), and some purchases without one (the number, and a line saying how many
//      aren't counted). Each number is money.js's, worked out here from the trip as the server
//      gives it, not read back from the page.
//   2. IT AGREES WITH SETTLE UP: the people and amounts under the headline are exactly the plan's
//      lines that are the viewer's, on the same phone.
//   3. EVERY ROW'S "your share" is money.js's share of that purchase, in the currency shown ("≈"
//      when converted), "not yours" when you aren't in it, ", unequal" when it was split by amount.
//   4. THE TAP TABLE: the common purchases cost no more taps than the split-simpler prototype did,
//      counted as real clicks, and each one is stored as it was meant.
//   5. THE BUTTON ABOVE THE KEYS: with a phone's keyboard up (the sheet's own --sh-kb, written as a
//      phone's keyboard would have it), "Add purchase" stands above the key line, full width.
//   6. THE ONE MOMENT OF MOTION: a purchase added moves the rows below it down, and then it and the
//      headline's new number appear together; the new row never draws over the row beneath it
//      while the list moves; the headline's number counts to its new value with it. Reduced motion: both simply
//      appear.
//   7. No page has an error.
// Everyone and everything in it is made up.

import fs from "node:fs";
import path from "node:path";
import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";
import { netBalances, settle, fmtMoney, expOf, isEqualSplit, isPayment, equalShares } from "../../public/js/money.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8888);
const shots = flag("--shots");
if (shots) fs.mkdirSync(shots, { recursive: true });
const t = new Report("Split's answer");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const KB = 336;

let server, chrome, code = 1;
const pages = [];
try {
  server = await startServer({ name: "split", port });
  await server.start();
  const { origin } = server;
  const P = {};
  for (const [k, name] of [["ada", "Ada Reyes"], ["ben", "Ben Okafor"], ["cleo", "Cleo Tran"], ["dev", "Dev Halloran"]]) {
    P[k] = new Person(origin, name);
    if ((await P[k].signUp()).status !== 200) throw new CheckError(`couldn't make ${name}'s account`);
  }
  const id = (k) => P[k].user.id;
  const must = (r, what) => { if (r.status >= 300) throw new CheckError(`${what}: ${r.status} ${r.text.slice(0, 200)}`); return r; };
  async function trip(name, guests, currencies) {
    const t0 = must(await P.ada.post("/api/trips", { name, default_tz: "Europe/Lisbon", currencies }), name).json.trip;
    for (const g of guests) {
      const link = must(await P.ada.post(`/api/trips/${t0.id}/links`, { uses: 1 }), "link");
      must(await P[g].post(`/api/join/${link.json.link.code}`), `${g} joins`);
    }
    return t0;
  }
  let n = 0;
  // The shares in contract order (user id ascending), each with its amount as money.js makes it.
  const sharesOf = (pid, amount, people, exact = null) => {
    const rows = people.map((k, i) => ({ user_id: id(k), w: exact ? exact[i] : 1 })).sort((x, y) => (x.user_id < y.user_id ? -1 : 1));
    const eq = equalShares(amount, rows.length, pid);
    return rows.map((r, i) => ({ user_id: r.user_id, weight: r.w, share_minor: exact ? r.w : eq[i] }));
  };
  async function buy(tr, payer, description, amount, currency, people, daysAgo, exact = null) {
    const pid = `pu-check-${++n}`;
    return must(await P[payer].post(`/api/trips/${tr.id}/purchases`, {
      id: pid, description, amount_minor: amount, currency, amount_exp: expOf(currency), paid_by: id(payer),
      spent_at: now - daysAgo * DAY - 3600, split_mode: exact ? "exact" : "weight",
      shares: sharesOf(pid, amount, people, exact),
    }), description).json;
  }
  // A: Ada is owed by Ben and Cleo; Dev is settled. Ben's Groceries are by amount.
  const A = await trip("Lisbon and the coast", ["ben", "cleo", "dev"], ["EUR"]);
  await buy(A, "ada", "Dinner at the harbour", 12000, "EUR", ["ada", "ben", "cleo", "dev"], 0);
  await buy(A, "ada", "Parking", 1200, "EUR", ["ben"], 0);
  await buy(A, "ben", "Groceries", 3000, "EUR", ["ada", "ben"], 1, [1200, 1800]);
  await buy(A, "dev", "Museum tickets", 4000, "EUR", ["ada", "ben", "cleo", "dev"], 1);
  await buy(A, "ben", "Tram tickets", 2000, "EUR", ["ada", "ben"], 2);
  await buy(A, "cleo", "Sunscreen", 2000, "EUR", ["ada", "cleo"], 3);
  // B: Cleo owes Ada and Ben; each of them is owed by one person.
  const B = await trip("A weekend in Porto", ["ben", "cleo"], ["EUR"]);
  await buy(B, "ada", "Hotel", 9000, "EUR", ["ada", "ben", "cleo"], 1);
  await buy(B, "ben", "Dinner", 9000, "EUR", ["ada", "ben", "cleo"], 0);
  // C: nothing yet.
  const C = await trip("A week in Madeira", ["ben"], ["EUR"]);
  // D: dollars shown in euros (a rate is held), and a franc with none (XAF: the stand-in has no rate for it).
  const D = await trip("Lisbon to New York", ["ben"], ["EUR", "USD"]);
  await buy(D, "ada", "Hotel in Brooklyn", 9000, "USD", ["ada", "ben"], 0);
  await buy(D, "ben", "Train to the airport", 1600, "EUR", ["ada", "ben"], 1);
  await buy(D, "ada", "Market", 30000, "XAF", ["ada", "ben"], 1);
  // E: nothing but the franc, on a trip counted in euros: no total can be made.
  const E = await trip("A week in Douala", ["ben"], ["EUR"]);
  await buy(E, "ada", "Taxi", 20000, "XAF", ["ada", "ben"], 0);

  chrome = await openChrome();
  async function phone(who, tr, { width = 390, height = 844, reduce = false } = {}) {
    const page = await chrome.page({ width, height, mobile: true, passkeys: false });
    pages.push(page);
    if (reduce) await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await page.setCookie(origin, "wgp_session", P[who].jar.cookies.get("wgp_session"));
    await page.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(id(who)), sameSite: "Lax" });
    await page.goto(`${origin}/t/${tr.id}/#/split`);
    await page.until(`!!document.querySelector(".sp-hero") && (document.querySelector(".sp-row") || /Nothing to split yet/.test(document.querySelector(".sp-hero").innerText))`, "Split", 20000);
    await sleep(500);
    return page;
  }
  const shot = async (page, name) => {
    if (!shots) return;
    await page.rest().catch(() => {});
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  };
  const OPEN = `.sh-root:last-of-type`;

  // ── what money.js says, from the trip as the server gives it to this person ──────────────────
  async function expected(who, tr) {
    const snap = must(await P[who].get(`/api/trips/${tr.id}`), "the trip").json;
    const rows = snap.purchases || [];
    const members = snap.members || [];
    const display = (snap.currencies || [])[0] || "EUR";
    const exp = expOf(display);
    const rates = (snap.fx && snap.fx.rates) || {};
    const led = netBalances(rows, members.map((m) => m.id), { to: display, toExp: exp, rates });
    const approx = rows.some((r) => r.currency !== display && !led.unconverted.includes(r.id));
    const plan = settle(led.net);
    const me = id(who);
    const name = (uid) => (members.find((m) => m.id === uid) || {}).name;
    const f = (v) => fmtMoney(v, exp, display, { approx });
    const pay = plan.filter((x) => x.from === me), get = plan.filter((x) => x.to === me);
    const lines = (pay.length ? pay : get).map((x) => ({ who: name(x.from === me ? x.to : x.from), amount: f(x.amount_minor) }));
    let state, words = "", amount = "";
    if (!rows.length) state = "empty";
    else if (led.unconverted.length === rows.length) state = "norate";
    else if (pay.length === 1) { state = "owe-one"; words = `You owe ${lines[0].who}`; }
    else if (pay.length > 1) { state = "owe-many"; words = "You owe"; }
    else if (get.length === 1) { state = "owed-one"; words = `${lines[0].who} owes you`; }
    else if (get.length > 1) { state = "owed-many"; words = "You're owed"; }
    else state = "settled";
    const tot = (pay.length ? pay : get).reduce((a, x) => a + x.amount_minor, 0);
    if (words) amount = f(tot);
    // Each row's "your share", worked out from that purchase alone.
    const shares = {};
    for (const p of rows) {
      if (isPayment(p)) continue;
      if (!(p.shares || []).some((s) => s.user_id === me)) { shares[p.id] = "not yours"; continue; }
      const one = netBalances([p], [me], { to: display, toExp: exp, rates });
      const txt = one.unconverted.length
        ? fmtMoney(netBalances([p], [me], { to: p.currency, toExp: p.amount_exp, rates: {} }).owed.get(me) || 0, p.amount_exp, p.currency)
        : fmtMoney(one.owed.get(me) || 0, exp, display, { approx: p.currency !== display });
      shares[p.id] = `your share ${txt}${isEqualSplit(p) ? "" : ", unequal"}`;
    }
    return { state, words, amount, lines, shares, unconverted: led.unconverted.length, spent: f(led.total), mine: f(led.owed.get(me) || 0) };
  }
  const HERO = `JSON.stringify((() => {
    const h = document.querySelector(".sp-hero");
    const w = h.querySelector("[data-sp='headline-words']"), a = h.querySelector("[data-sp='headline-amount']");
    const title = h.querySelector(".sp-hero-title");
    return { state: (w || title || { dataset: {} }).dataset.state || "", words: w ? w.textContent : "", amount: a ? a.textContent : "",
      title: title ? title.textContent : "", sub: (h.querySelector(".sp-hero-sub") || {}).textContent || "",
      warn: (h.querySelector(".sp-hero-warn") || {}).textContent || "",
      lines: [...h.querySelectorAll(".sp-hero-list li")].map((li) => ({ who: li.querySelector(".sp-name").textContent, amount: li.querySelector(".num").textContent })),
      marks: [...h.querySelectorAll('[data-act="mark-paid"]')].length,
      balances: !!h.querySelector('[data-act="settle"]'), add: !!h.querySelector('[data-act="add"]') };
  })())`;
  const hero = async (page) => JSON.parse(await page.eval(HERO));

  // ── 1, 2, 3 ─────────────────────────────────────────────────────────────────────────────────
  t.part("1. the headline is the answer, in every state; 2. it agrees with Settle up; 3. every row's share");
  const CASES = [
    ["ben", A, "owe-one"], ["ada", A, "owed-many"], ["dev", A, "settled"], ["cleo", B, "owe-many"],
    ["ada", B, "owed-one"], ["ben", C, "empty"], ["ben", E, "norate"], ["ben", D, null],
  ];
  for (const [who, tr, want] of CASES) {
    const e = await expected(who, tr);
    const page = await phone(who, tr);
    const h = await hero(page);
    const label = `${P[who].name.split(" ")[0]} on "${tr.name}"`;
    if (want) t.same(`${label}: money.js puts this trip in the "${want}" state`, e.state, want);
    t.same(`${label}: the headline is in the same state`, h.state, e.state);
    if (e.words) {
      t.same(`${label}: its words and number are the answer: "${e.words}", ${e.amount}`, [h.words, h.amount], [e.words, e.amount]);
      if (e.lines.length > 1) {
        t.same(`${label}: under it, one line per person, each with its own Mark paid`, [h.lines, h.marks], [e.lines, e.lines.length]);
      } else {
        t.same(`${label}: under it, one Mark paid`, [h.lines.length, h.marks], [0, 1]);
      }
      t.ok(`${label}: and "Everyone's balances"`, h.balances);
    } else if (e.state === "settled") {
      t.same(`${label}: "You're settled up", what was spent together and your share, in sentences`,
        [h.title, h.sub], ["You're settled up", `${e.spent} spent together. Your share is ${e.mine}.`]);
    } else if (e.state === "empty") {
      t.same(`${label}: "Nothing to split yet", what Split is for, and Add a purchase`,
        [h.title, h.sub, h.add, h.balances], ["Nothing to split yet", "Add what someone paid and who was in on it. Split keeps the tally.", true, false]);
    } else if (e.state === "norate") {
      t.same(`${label}: "Totals need exchange rates", and the way into Settle up by currency`, [h.title, h.balances], ["Totals need exchange rates", true]);
    }
    if (e.unconverted && e.state !== "norate") {
      const want2 = `Not counting ${e.unconverted} ${e.unconverted === 1 ? "purchase that needs" : "purchases that need"} an exchange rate`;
      t.same(`${label}: under the number, how many purchases it leaves out, in words`, h.warn, want2);
    } else t.same(`${label}: no caveat`, h.warn, "");
    // 2: the same phone's Settle up.
    if (e.words) {
      await page.click('#view [data-act="settle"]');
      await page.until(`!!document.querySelector("${OPEN} .sp-plan")`, "Settle up's plan");
      await sleep(300);
      const mine = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll("${OPEN} .sp-plan li")].map((li) => {
        const b = li.querySelector(".sp-tr-go"); return { from: b.dataset.from, to: b.dataset.to, amount: li.querySelector(".num").textContent };
      }).filter((x) => x.from === ${JSON.stringify(id(who))} || x.to === ${JSON.stringify(id(who))}))`));
      const fromHero = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll('#view .sp-hero [data-act="mark-paid"]')].map((b) => ({ from: b.dataset.from, to: b.dataset.to })))`));
      t.ok(`${label}: Settle up's lines that are hers or his are exactly the headline's, and their amounts add to its number`,
        mine.length === fromHero.length && fromHero.every((x) => mine.some((y) => y.from === x.from && y.to === x.to)) &&
        (mine.length === 1 ? mine[0].amount === e.amount : mine.every((y) => e.lines.some((l) => l.amount === y.amount))),
        JSON.stringify({ settle: mine, headline: fromHero, number: e.amount }));
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await page.until(`!document.querySelector(".sh-root")`, "Settle up to close", 5000).catch(() => {});
    }
    // 3: every row's share.
    const got = JSON.parse(await page.eval(`JSON.stringify(Object.fromEntries([...document.querySelectorAll("#view .sp-feed .sp-row:not([data-kind='payment'])")].map((r) => [r.dataset.id, (r.querySelector(".sp-mine") || {}).textContent || ""])))`));
    const bad = Object.keys(e.shares).filter((k) => got[k] !== e.shares[k]);
    if (Object.keys(e.shares).length) {
      t.ok(`${label}: every row's "your share" is money.js's share of that purchase (${Object.keys(e.shares).length} rows)`, bad.length === 0,
        JSON.stringify(bad.map((k) => ({ row: k, got: got[k], want: e.shares[k] }))));
    }
    await shot(page, `1-${who}-${tr.name.replace(/\W+/g, "-").toLowerCase()}`);
    t.ok(`${label}: no page error`, page.errors.length === 0, page.errors.join(" | "));
    await page.close();
    pages.pop();
  }

  // ── 4. the tap table ────────────────────────────────────────────────────────────────────────
  t.part("4. the tap table: the common purchases cost no more taps than the prototype");
  const tp = await phone("ben", A);
  let taps = 0;
  const tap = async (sel) => { await tp.click(sel); taps += 1; await sleep(220); };
  const keys = async (text) => { await tp.send("Input.insertText", { text }); await sleep(120); };
  const focused = () => tp.eval(`(document.activeElement || {}).dataset ? document.activeElement.dataset.sp || "" : ""`);
  const added = async (before) => {
    await tp.until(`!document.querySelector(".sh-root")`, "the sheet to close", 8000);
    const r = await tp.until(`(() => { const skip = ${JSON.stringify(before)}; const n = [...document.querySelectorAll("#view .sp-feed .sp-row")].find((x) => !skip.includes(x.dataset.id)); return n ? n.dataset.id : ""; })()`, "the new row", 8000);
    await tp.eval(`import("/js/store.js").then(({ store }) => store.flush())`).catch(() => {});
    await sleep(600);
    return tp.eval(`import("/js/store.js").then(({ store }) => JSON.stringify(store.purchase(${JSON.stringify(r)})))`).then(JSON.parse);
  };
  const ids = () => tp.eval(`JSON.stringify([...document.querySelectorAll("#view .sp-feed .sp-row")].map((x) => x.dataset.id))`).then(JSON.parse);
  // The prototype's counts: the taps each common purchase took in the simpler Split it replaced.
  const ROWS = [
    { name: "you paid, everyone, evenly, today", max: 2, run: async () => { await keys("12.00"); },
      holds: (p) => p.paid_by === id("ben") && p.shares.length === 4 && isEqualSplit(p) && p.amount_minor === 1200 },
    { name: "…and what it was (a tap on the field, then typing)", max: 3, run: async () => { await keys("9.50"); await tap('[data-sp="what"]'); await keys("Coffee"); },
      holds: (p) => p.description === "Coffee" && p.amount_minor === 950 },
    { name: "someone else paid", max: 4, run: async () => { await keys("30.00"); await tap('[data-act="open-paid"]'); await tap(`[data-grp="paid"] .sp-person[data-id="${id("ada")}"]`); },
      holds: (p) => p.paid_by === id("ada") },
    { name: "one person left out", max: 4, run: async () => { await keys("15.00"); await tap('[data-act="open-split"]'); await tap(`[data-grp="split"] .sp-person[data-id="${id("dev")}"]`); },
      holds: (p) => p.shares.length === 3 && !p.shares.some((s) => s.user_id === id("dev")) },
    { name: "yesterday", max: 4, run: async () => { await keys("8.00"); await tap('[data-act="open-when"]'); await tap('[data-act="day"]:nth-child(2)'); },
      holds: (p) => Math.abs(p.spent_at - (now - DAY)) < 2 * DAY && p.spent_at < now - 6 * 3600 },
    { name: "unequal at entry (+1 and the amounts)", max: 3, run: async () => {
        await keys("40.00"); await tap('[data-act="open-split"]');
        for (const [k, v] of [["ada", "10.00"], ["ben", "10.00"], ["cleo", "10.00"], ["dev", "10.00"]]) {
          await tp.eval(`(() => { const i = document.querySelector('.sp-uin[data-id="${id(k)}"]'); i.focus(); i.select(); return 1; })()`); await keys(v);
        }
        await tp.eval(`(() => { const i = document.querySelector('.sp-uin[data-id="${id("ada")}"]'); i.focus(); i.select(); return 1; })()`); await keys("4.00");
        await tp.eval(`(() => { const i = document.querySelector('.sp-uin[data-id="${id("ben")}"]'); i.focus(); i.select(); return 1; })()`); await keys("16.00");
      },
      holds: (p) => !isEqualSplit(p) && p.shares.find((s) => s.user_id === id("ben")).share_minor === 1600 },
  ];
  for (const row of ROWS) {
    const before = await ids();
    taps = 0;
    await tap("#rt-fixed .fab");
    await tp.until(`document.activeElement && document.activeElement.classList.contains("sp-amtin")`, "the amount focused as the sheet opens", 5000);
    t.same(`${row.name}: the amount has the keypad from the + alone`, await focused(), "amount");
    await row.run();
    await tap(`${OPEN} [data-act="save"]`);
    const p = await added(before);
    t.ok(`${row.name}: ${taps} taps, no more than the prototype's ${row.max}`, taps <= row.max, `${taps} taps`);
    t.ok(`${row.name}: and it is stored as meant`, !!p && row.holds(p), JSON.stringify(p && { paid_by: p.paid_by, shares: p.shares, desc: p.description, at: p.spent_at }));
  }

  // ── 5. the button above the keys ───────────────────────────────────────────────────────────
  t.part("5. Add purchase stands above the keys, full width");
  await tp.click("#rt-fixed .fab");
  await tp.until(`!!document.querySelector("${OPEN} .sp-amtin")`, "the add sheet");
  // The keyboard comes up on a sheet at rest (its own rise ended: sheet.js marks it entered), as on a phone.
  await tp.until(`document.querySelector("${OPEN}")?.dataset.entered === "1"`, "the sheet at rest", 5000);
  // sheet.js follows the keys for up to 900 ms after a focus change (keyboardLock's burst: the amount took focus as the
  // sheet opened), writing the keyboard it measures (none, here) every frame; at a headless browser's frame rate (8 to 11
  // a second, measured 22 Nov) it is still going once the sheet is at rest, and a keyboard written before it ends is
  // written back to none on its next frame. So the keys come up once it has ended, as a phone's would after the focus.
  await sleep(1000);
  const foot = JSON.parse(await tp.eval(`new Promise((res) => { const root = document.querySelector("${OPEN}");
    root.style.setProperty("--sh-kb", "${KB}px"); root.dataset.kb = "1";
    requestAnimationFrame(() => requestAnimationFrame(() => { const b = document.querySelector("${OPEN} [data-act='save']").getBoundingClientRect();
      const s = document.querySelector("${OPEN} .sh-sheet").getBoundingClientRect();
      res(JSON.stringify({ top: Math.round(b.top), bottom: Math.round(b.bottom), w: Math.round(b.width), sheetW: Math.round(s.width), sheetBottom: Math.round(s.bottom), inner: innerHeight,
        body: (() => { const el = document.querySelector("${OPEN} .sh-body"); const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return [Math.round(r.top), Math.round(r.bottom), cs.paddingBottom, cs.getPropertyValue("--sp-4"), el.scrollHeight - el.clientHeight, el.scrollTop]; })(), words: document.querySelector("${OPEN} [data-act='save']").textContent })); })); })`));
  t.ok("with a 336 px keyboard up, the button's foot is above the key line and it spans the sheet",
    foot.bottom <= foot.inner - KB && foot.bottom >= foot.inner - KB - 90 && foot.w >= foot.sheetW - 40 && foot.words === "Add purchase", JSON.stringify(foot));
  await shot(tp, "5-keys-up");
  await tp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await tp.until(`!document.querySelector(".sh-root")`, "the sheet to close", 5000).catch(() => {});

  // ── 6. the one moment of motion ─────────────────────────────────────────────────────────────
  t.part("6. a purchase arrives; the headline's number changes with it; nothing draws over the row beneath");
  const SAMPLE = `new Promise((res) => {
    const out = []; const t0 = performance.now();
    const step = () => {
      const rows = [...document.querySelectorAll("#view .sp-feed .sp-row")];
      const i = rows.findIndex((r) => !window.__known.includes(r.dataset.id));
      const num = document.querySelector("#view .sp-hero-num");
      if (i >= 0) {
        const a = rows[i], b = rows[i + 1];
        const ra = a.getBoundingClientRect(), rb = b ? b.getBoundingClientRect() : null;
        out.push({ t: Math.round(performance.now() - t0), op: +getComputedStyle(a).opacity, numOp: num ? +getComputedStyle(num).opacity : 1,
          num: num ? Number(num.textContent.replace(/[^0-9.-]/g, "")) : null, overlap: rb ? Math.max(0, ra.bottom - rb.top) : 0 });
      }
      if (performance.now() - t0 < 900) requestAnimationFrame(step); else res(JSON.stringify(out));
    };
    requestAnimationFrame(step);
  })`;
  for (const reduce of [false, true]) {
    const mp = await phone("ben", B, { reduce });
    await mp.eval(`(window.__known = [...document.querySelectorAll("#view .sp-feed .sp-row")].map((r) => r.dataset.id), 1)`);
    const numBefore = await mp.eval(`document.querySelector("#view .sp-hero-num").textContent`);
    // Somebody else's purchase arriving on this phone: the store's change, as a refresh brings it.
    const fid = `pu-check-${++n}`;
    // Ben is owed €30 before the first; €10 after it (the number moves), and owes €20 after the second.
    const fare = reduce ? 9000 : 6000;
    must(await P.ada.post(`/api/trips/${B.id}/purchases`, { id: fid, description: "Ferry", amount_minor: fare, currency: "EUR", amount_exp: 2,
      paid_by: id("ada"), spent_at: now - 60, split_mode: "weight", shares: sharesOf(fid, fare, ["ada", "ben", "cleo"]) }), "the ferry");
    const sampling = mp.eval(SAMPLE);
    await mp.eval(`import("/js/store.js").then(({ store }) => store.refresh()).then(() => 1)`);
    const frames = JSON.parse(await sampling);
    const numAfter = await mp.eval(`document.querySelector("#view .sp-hero-num").textContent`);
    const seen = frames.filter((f) => f.op > 0.01);
    if (!reduce) {
      t.ok("the new row is drawn only once the rows beneath it have made room: never over them while visible",
        frames.length > 3 && seen.every((f) => f.overlap <= 1), JSON.stringify(frames.slice(0, 20)));
      t.ok("it arrives after the move, not with it", frames.length > 3 && frames[0].op < 0.05 && frames.at(-1).op === 1, JSON.stringify(frames.map((f) => f.op)));
      // The number counts from the old value to the new one while the row arrives: it is never anything but on its
      // way (each frame no further from the new value than the one before), it passes through values between the
      // two, and it ends exactly on the new one.
      const nums = frames.map((f) => f.num), from = Number(numBefore.replace(/[^0-9.-]/g, "")), to = Number(numAfter.replace(/[^0-9.-]/g, ""));
      const between = nums.filter((v) => v !== from && v !== to && Math.min(from, to) < v && v < Math.max(from, to));
      t.ok("the headline's number counts to its new value with it: only toward it, through values between, ending on it",
        numAfter !== numBefore && nums.at(-1) === to && between.length >= 2
          && nums.every((v, i) => i === 0 || Math.abs(to - v) <= Math.abs(to - nums[i - 1]) + 1e-9) && frames.every((f) => f.numOp === 1),
        JSON.stringify({ from, to, nums: nums.slice(0, 40) }));
    } else {
      t.ok("reduced motion: the new row and the number simply appear", frames.length > 0 && frames[0].op === 1 && frames[0].numOp === 1 && numAfter !== numBefore,
        JSON.stringify({ frames: frames.slice(0, 3), numBefore, numAfter }));
    }
    t.ok(`${reduce ? "reduced motion: " : ""}no page error`, mp.errors.length === 0, mp.errors.join(" | "));
    await mp.close(); pages.pop();
  }
  t.ok("no page error on the phone that counted taps", tp.errors.length === 0, tp.errors.join(" | "));
  code = t.end();
} catch (e) {
  console.error(e instanceof CheckError ? `\nSTOPPED: ${e.message}` : e);
  t.end();
  code = 1;
} finally {
  for (const p of pages) await p.close().catch(() => {});
  if (chrome) await chrome.close().catch(() => {});
  if (server) await server.stop().catch(() => {});
}
process.exit(code);

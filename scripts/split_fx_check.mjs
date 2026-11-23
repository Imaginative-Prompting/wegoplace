#!/usr/bin/env node
/* FX — the currency rates path, end to end, on the REAL Split screen in real Chrome against
 * this lane's real dev server (WGP_BASE) and the real local D1.
 *
 *   node scripts/split_fx_check.mjs            # add --shots to also write PNGs
 *
 * Chrome needs the Bash sandbox disabled (it cannot create its ProcessSingleton socket
 * otherwise), and the launcher (scripts/lib/browser.mjs) starts it only through the queue:
 *   WGP_BASE=http://127.0.0.1:<port> python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node <this file>
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS SEPARATELY FROM scripts/split_harness.mjs
 *
 * That harness proves the SCREEN — a thumb, a drawer, a settle-up whose answer was worked out
 * by hand. It deliberately says nothing about where a rate comes from, and for most of its
 * life it ran on a phone that had never seen one.
 *
 * This file proves the OTHER half: that functions/api/fx.js fetches, caches, delivers and
 * survives. It is a separate file because its failure modes are separate — a rate path can be
 * completely broken while every check in that harness stays green, which is exactly the state
 * this repo was in until fx.js landed: 165 rates sitting in D1 and a screen still saying
 * "rate pending" because nothing carried them to the phone.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IT PROVES
 *
 *   A. The rates reach the phone on the SNAPSHOT, with nobody tapping anything. This is the
 *      offline requirement in one assertion: the phone gets one request in before the signal
 *      goes, and rates on their own endpoint are rates that do not exist
 *      on the trail." If GET /api/trips/<id> ever stops carrying `fx`, A fails here rather than on a
 *      trail in Peru.
 *   B. A PEN row converts to USD on the rendered feed, to the céntimo, and a USD row carries
 *      no converted line at all because identity needs no rate.
 *   C. The settle sheet says how old the rate is, in one quiet line, and does not make a fuss.
 *   D. A rate THREE DAYS OLD still converts, and the age line says so: a stale rate never blocks
 *      and never hides a number.
 *   E. With every /api/* request blocked, the whole table converts off IndexedDB — and the
 *      amount AS PAID is on screen either way, because it never depended on a rate.
 *   H. "Other currency…": the head's menu ends in it; it opens one picker for totals (the trip's own, then recent picks,
 *      then the rest by name); a currency from the far end, never used on the trip, takes the totals with the ≈ and the
 *      rates' day, and a reload keeps it; a currency with no rate is shown for totals but can't be chosen, and says why.
 *      Planted: SPLITFX_PLANT=refuse (totals and reload red), =unsorted (the order red).
 *   G. A currency the phone holds NO rate for is left out of the totals, and the settle card
 *      says so on a line of its own under the big number: heavier as well as gold, the words
 *      first. (The snapshot is rewritten on the wire to drop one rate; no database is touched.)
 *
 * NOTHING HERE IS COMPARED AGAINST A LITERAL. The rate every assertion is computed from is
 * re-fetched over HTTP from the endpoint under test, so a wrong conversion cannot agree with a
 * wrong expectation. The one number written down by hand would be the one that goes stale.
 *
 * ITS OWN FIXTURES, AND BASELINE-AWARE. It adds two purchases of its own through the app's
 * store (one in soles, one in dollars, split by everyone on the trip), so it passes on a
 * database with no purchases at all, and it asserts about EVERY sol row on the feed, so it
 * passes just the same on one that already has some. Both are deleted at the end. The only
 * other mutation it makes is `fetched_at` on fx_rates, moved back three days for section D and
 * then written back to the exact value it held. Section F verifies both: the rates table is as
 * it was, and the purchases table holds exactly the rows it held before the run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, REPO, appSettled, boot, evalIn, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { TRIP, d1 as gateD1, signIn } from "./lib/gate_trip.mjs";

const SHOTS = process.argv.includes("--shots");
// Stills go where the environment says, and to a folder under the temp directory otherwise:
// never into the tree.
const SHOT_DIR = process.env.WGP_SHOTS || path.join(os.tmpdir(), "wgp-fx-shots");
const W = 390, H = 844;
const DAY = 86400;

const failures = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail !== undefined ? `   — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// ── plumbing ────────────────────────────────────────────────────────────────────────────
// Evaluate, retrying across the navigation window where the execution context has been torn
// down but the new one has not been announced yet. This file reloads four times.
async function ev(cdp, S, expr, tries = 6) {
  for (let i = 0; ; i++) {
    try { return await evalIn(cdp, S, expr); }
    catch (e) {
      const m = String(e);
      if (i >= tries || !/context was destroyed|Cannot find context|Inspected target/i.test(m)) throw e;
      await sleep(400);
    }
  }
}
// Runtime.evaluate compiles its expression as a SCRIPT, where a top-level await is a syntax
// error that surfaces as "missing ) after argument list" and looks like a quoting bug. Hence
// Promise.resolve(...).then rather than await.
const J = async (cdp, S, expr) =>
  JSON.parse(await ev(cdp, S, `Promise.resolve(${expr}).then((v) => JSON.stringify(v))`));
const inStore = (cdp, S, body) => ev(cdp, S,
  `(async () => { const { store } = await import("/js/store.js"); ${body} })()`);

// wrangler spins a SECOND workerd against the same sqlite file the dev server already holds
// open, and it loses that race often enough to have thrown SQLITE_BUSY_RECOVERY mid-run once.
// Retried rather than trusted, because the last statement this file runs is the one that puts
// fetched_at back and it is not allowed to be the one that fails.
// (The gate's database, read while its server runs: scripts/lib/gate_trip.mjs, which tries a
// statement again on the local database's passing faults.)
const d1 = (sql, tries = 4) => gateD1(sql, tries);

/** The endpoint under test, over HTTP, with no browser in the way: as the trip's host, signed in for this run. */
const asHost = await signIn();
const api = async (method, p) => {
  const res = await asHost.call(method, p);
  return { status: res.status, type: (res.headers.find(([k]) => k === "content-type") || [])[1] || "", body: res.json };
};

// ── real input ──────────────────────────────────────────────────────────────────────────
// One finger, 12px of radius, because a thumb is not a pixel — and only ever at a coordinate
// measured a moment earlier off an element this file has confirmed is genuinely on screen.
const finger = (x, y) => [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 0 }];
async function tap(cdp, S, sel, label = sel) {
  const c = await J(cdp, S, `(() => {
    const n = document.querySelector(${JSON.stringify(sel)});
    if (!n) return null;
    const r = n.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.top < 0 || r.bottom > innerHeight) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!c) throw new Error(`tap: ${label} is not on screen (${sel})`);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: finger(c.x, c.y) }, S);
  await sleep(70);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, S);
  await sleep(260);
}

/**
 * The feed, exactly as the screen renders it — as-paid and converted, per row. A converted row
 * has "≈ $24.19" on the right and what was paid on the left ("Ada paid S/ 90.00"); a row in the
 * currency shown, or one with no rate held, has what was paid on the right and nothing made up.
 */
const feed = (cdp, S) => J(cdp, S, `(() => [...document.querySelectorAll(".sp-row")].map((r) => {
  const total = ((r.querySelector(".sp-total") || {}).textContent || "").trim();
  const by = ((r.querySelector(".sp-by") || {}).textContent || "").trim();
  const conv = total.startsWith("≈") ? total : "";
  return { id: r.dataset.id, what: (r.querySelector(".sp-what") || {}).textContent || "",
    paid: conv ? by.replace(/^.*? paid /, "").replace(/^Payment of /, "") : total, conv };
}))()`);

const fineLines = (cdp, S) =>
  J(cdp, S, `[...document.querySelectorAll(".sp-fine")].map((n) => n.textContent)`);

// The topmost sheet's own signal that its entry transition has really landed — sheet.js stamps
// it. Never a sleep: a bet that pays out on a quiet machine and not on a busy one has no
// business in a check whose whole subject is a number being right.
const sheetReady = (cdp, S) => waitFor(cdp, S,
  `(() => { const rs = document.querySelectorAll(".sh-root");
    const r = rs[rs.length - 1]; return r && r.dataset.entered === "1" ? 1 : 0; })()`,
  { label: "the sheet's entry transition" });

/** A GENUINE cold load of #/split — the hash first, then a real reload, because a navigation
 *  that differs only in the fragment reloads nothing at all. */
async function remount(cdp, S) {
  await ev(cdp, S, `location.hash = "#/split"`).catch(() => {});
  await sleep(150);
  await cdp.send("Page.reload", { ignoreCache: true }, S);
  await sleep(600);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `document.querySelector(".sp-h1") ? 1 : 0`, { label: "the Split screen" });
  await feedSettled(cdp, S);
}

/**
 * Wait for the feed to have rows, and DO NOT THROW WHEN IT NEVER DOES.
 *
 * This used to be a waitFor on store.purchases().length, and it cost a run: GET /api/trips/<id>
 * momentarily stopped carrying `purchases`, and the file died with "timed out: purchases
 * hydrated" — a precondition failing as a FATAL, three sections before the assertion that
 * would have named the actual cause. Every check after it was simply never reported, which is
 * the shape of failure this repo has already been bitten by once.
 *
 * So it gives up quietly and lets the named checks speak. A0 below asserts the snapshot really
 * carries what this file needs, so the run that finds an empty feed says WHY on its first line.
 */
async function feedSettled(cdp, S) {
  try {
    await waitFor(cdp, S,
      `(async () => { const { store } = await import("/js/store.js"); return store.purchases().length ? 1 : 0; })()`,
      { timeout: 12000, label: "purchases hydrated" });
  } catch { /* A0 has already said why, or is about to */ }
  await sleep(400);
}

/**
 * Put the screen in USD by tapping its OWN chip, so the conversion under test is the one a
 * person would be looking at. Which currency the screen opens in depends on the trip's
 * enabled list and on whose phone this is, so it is driven rather than assumed.
 */
async function showUSD(cdp, S) {
  // The head's menu of what totals are shown in: a native <select>, chosen the way a menu is.
  const cur = await ev(cdp, S, `(document.querySelector(".sp-head select[data-act='display']") || {}).value || ""`);
  // No menu at all means the screen has ONE currency to offer, which on a feed with rows is
  // a real answer and on an empty feed is the symptom A0 already named. Either way it is not
  // this helper's business to throw — see feedSettled().
  if (!cur || cur === "USD") return cur;
  await ev(cdp, S, `(() => { const s = document.querySelector(".sp-head select[data-act='display']");
    s.value = "USD"; s.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`);
  await sleep(400);
  return ev(cdp, S, `(document.querySelector(".sp-head select[data-act='display']") || {}).value || ""`);
}

/** Open the settle sheet, reporting a missing card as a named failure rather than a FATAL. */
async function openSettle(cdp, S, label) {
  if (!await ev(cdp, S, `document.querySelector('#view [data-act="settle"]') ? 1 : 0`)) {
    check(label, false, "there is no way into Settle up on the screen");
    return false;
  }
  await tap(cdp, S, '#view [data-act="settle"]', "Everyone's balances");
  await sheetReady(cdp, S);
  await sleep(400);
  return true;
}

// ════════════════════════════════════════════════════════════════════════════════════════
const run = async () => {
  if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });

  // Its own rates: a fresh database has none until something asks the server to fetch them, and this file may run first or
  // alone (21 Nov: it leaned on the checks before it). POST /api/fx/refresh waits for the provider (the gate server's
  // stand-in, checks/lib/server.mjs) and answers the table; said when it was needed.
  let served = await api("GET", "/api/fx");
  if (!served.body.fx || !served.body.fx.rates || !served.body.fx.rates.PEN) {
    const asked = await api("POST", "/api/fx/refresh");
    console.log(`  note  no rates held yet: asked the server to fetch them (POST /api/fx/refresh: ${asked.status})`);
    served = await api("GET", "/api/fx");
  }
  if (!served.body.fx || !served.body.fx.rates.PEN)
    throw new Error("GET /api/fx has no PEN rate even after POST /api/fx/refresh — is the dev server up and has it reached the provider?");
  const RATE = served.body.fx.rates.PEN;
  // PEN -> USD, the way public/js/money.js's convert() does it: one multiplication by the
  // reciprocal of "how many PEN one USD buys", ONE round, no accumulation. Both currencies
  // carry two minor digits, so the 10^(toExp-fromExp) factor is 1 and drops out.
  const expect = (minor) => Math.round(minor / RATE);
  const dollars = (minor) => `≈ $${(expect(minor) / 100).toFixed(2)}`;
  const minorOf = (paid) => Math.round(Number(paid.replace(/[^0-9.]/g, "")) * 100);

  const before = d1("SELECT base, COUNT(*) n, MIN(fetched_at) f, MIN(next_at) x FROM fx_rates GROUP BY base")[0];
  const baseline = d1("SELECT id FROM purchases ORDER BY id").map((r) => r.id);

  // reduceMotion FALSE: the sheet really slides, and a check that runs with motion off is a
  // check that never waits for the frame in which a control is still moving under the finger.
  const b = await boot({ vw: W, vh: H, dsf: 2, reduceMotion: false });
  const { cdp, S } = b;
  const shot = async (n) => { if (SHOTS) await b.shot(path.join(SHOT_DIR, `${n}.png`)); };
  // Planted (section H): SPLITFX_PLANT=refuse serves split.js refusing a code outside the short list for totals (H's
  // totals and reload red); =unsorted serves the picker in the code list's own order (H's order red).
  const PLANT = process.env.SPLITFX_PLANT || "";
  if (PLANT) {
    const src = fs.readFileSync(path.join(REPO, "public/js/split.js"), "utf8");
    const t = PLANT === "refuse" ? src.replace("if (!list.includes(code) && !hasRate(S, code)) return;", "if (!list.includes(code)) return;")
      : PLANT === "unsorted" ? src.replace("for (const c of [...CURRENCY_CODES].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) add(c);", "for (const c of CURRENCY_CODES) add(c);") : src;
    if (t === src) throw new Error(`the ${PLANT} plant didn't take`);
    cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused" && /\/js\/split\.js/.test(m.params.request.url)) cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(t).toString("base64") }, S).catch(() => {}); });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/split.js*" }] }, S);
  }
  let aged = false;
  const created = [];        // the purchases this run adds, deleted in the finally

  try {
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, S);
    await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });

    section("A. the rates reach the phone with nobody asking for them");
    check("GET /api/fx answers JSON, not the asset server's 405 text/html",
      served.status === 200 && /json/.test(served.type),
      `${served.status} ${served.type} · ${Object.keys(served.body.fx.rates).length} quotes`);

    // A0, AND IT IS FIRST ON PURPOSE. Everything below is about a rate reaching a screen, and
    // the vehicle is the snapshot: rates on their own endpoint are rates that do not exist
    // on the trail. If GET /api/trips/<id> stops carrying `fx`, the failure
    // belongs HERE, in one line naming the missing key, rather than as four confusing DOM
    // assertions about a feed that never had anything to convert.
    // THE FIXTURES, through the app's own store on the real page: one purchase in soles and
    // one in dollars, each split by everyone on the trip. Made here rather than assumed, so
    // the run does not depend on what the database happened to hold.
    await cdp.send("Page.navigate", { url: BASE + `/t/${TRIP}/#/split` }, S);
    await appSettled(cdp, S);
    await waitFor(cdp, S, `document.querySelector(".sp-h1") ? 1 : 0`, { label: "the Split screen" });
    const made = await J(cdp, S, `import("/js/store.js").then(async ({ store }) => {
      const shares = store.members().map((m) => ({ user_id: m.id, weight: 1 }));
      const a = await store.addPurchase({ description: "Fixture: bus tickets", amount_minor: 4800,
        currency: "PEN", amount_exp: 2, split_mode: "weight", shares });
      const b = await store.addPurchase({ description: "Fixture: museum", amount_minor: 2000,
        currency: "USD", amount_exp: 2, split_mode: "weight", shares });
      await store.flush();
      return { ids: [a && a.id, b && b.id], people: shares.length };
    })`);
    created.push(...made.ids.filter(Boolean));
    await sleep(800);
    const inD1 = created.length
      ? d1(`SELECT id, currency FROM purchases WHERE id IN (${created.map((id) => `'${id}'`).join(",")}) ORDER BY currency`)
      : [];
    check("the two fixture purchases reached the database, one in soles and one in dollars",
      inD1.length === 2 && inD1[0].currency === "PEN" && inD1[1].currency === "USD",
      `${inD1.map((r) => r.currency).join(", ")} · split by ${made.people} people`);

    const snap = await api("GET", `/api/trips/${TRIP}`);
    check(`GET /api/trips/${TRIP} carries the rate table beside note_colors, on the ONE request a phone gets`,
      !!snap.body.fx && Object.keys(snap.body.fx.rates || {}).length >= 2 && "PEN" in snap.body.fx.rates && snap.body.fx.fetched_at > 0,
      snap.body.fx ? `${Object.keys(snap.body.fx.rates || {}).length} quotes` : "NO fx KEY on the snapshot");
    check("…and the purchases those rates are for",
      Array.isArray(snap.body.purchases) && snap.body.purchases.length > 0,
      Array.isArray(snap.body.purchases) ? `${snap.body.purchases.length} rows`
        : "NO purchases KEY on the snapshot");

    // A cold load, so what the phone holds is what ONE snapshot gave it.
    await remount(cdp, S);

    const fx = await J(cdp, S,
      `import("/js/store.js").then(({ store }) => { const f = store.fx();
        return { base: f.base, n: Object.keys(f.rates).length, pen: f.rates.PEN,
                 fetched_at: f.fetched_at, next_at: f.next_at, usd: "USD" in f.rates }; })`);
    check("the phone has a rate table after ONE request, with no tap on 'Fetch rates'",
      fx.fetched_at > 0 && fx.n === Object.keys(snap.body.fx.rates || {}).length && fx.n >= 2,
      `${fx.n} quotes (the snapshot carried ${Object.keys(snap.body.fx.rates || {}).length}), fetched_at ${fx.fetched_at}`);
    check("it is the table the endpoint served, PEN included",
      fx.base === "USD" && fx.pen === RATE, `PEN ${fx.pen} (endpoint said ${RATE})`);
    check("USD is NOT in the map — the base buys one of itself and convert() hard-codes it",
      fx.usd === false, `"USD" in rates = ${fx.usd}`);
    check("no exception reached the page", b.pageErrors.length === 0,
      b.pageErrors.join(" | ") || "clean");

    section("B. a PEN row converts to USD on the real screen");
    const shownIn = await showUSD(cdp, S);
    check("the screen is denominated in USD", /USD/.test(shownIn), shownIn || "(no currency menu)");
    let rows = await feed(cdp, S);
    await shot("fx-01-feed-usd");

    const pen = rows.filter((r) => /^S\//.test(r.paid));
    check("there are PEN rows on the feed for a rate to do something with", pen.length >= 1,
      pen.map((r) => `${r.paid} -> ${r.conv}`).join(" | "));
    for (const r of pen) {
      check(`  ${r.what || "(no description)"}: ${r.paid} converts to the céntimo`,
        r.conv === dollars(minorOf(r.paid)),
        `screen "${r.conv}"   round(${minorOf(r.paid)} / ${RATE}) = ${expect(minorOf(r.paid))}`);
    }
    check("every converted figure carries the ≈, which is its second carrier in greyscale",
      pen.every((r) => r.conv.startsWith("≈ ")), pen.map((r) => r.conv).join(" | "));
    check("nothing on the feed still says 'rate pending'",
      !rows.some((r) => /rate pending/.test(r.conv)),
      rows.map((r) => r.conv || "-").join(" | "));
    const usdRow = rows.find((r) => /^\$/.test(r.paid));
    check("a USD row carries NO converted figure — identity needs no rate",
      !!usdRow && usdRow.conv === "", usdRow && `${usdRow.paid} conv="${usdRow.conv}"`);
    // (The rates' day under converted totals, "Rates from …", is the quiet line Other currency… added: no caveat.)
    const card = await J(cdp, S, `(() => { const c = document.querySelector(".sp-hero"); if (!c) return null; const k = c.cloneNode(true);
      k.querySelector("[data-sp='rates-day']")?.remove(); document.body.append(k); const text = k.innerText; k.remove();
      return { text, caveat: !!c.querySelector(".sp-hero-warn"), ratesDay: (c.querySelector("[data-sp='rates-day']") || {}).textContent || "" }; })()`);
    check("with a rate for everything, the headline carries no caveat about rates",
      !!card && !card.caveat && !/rate/i.test(card.text), card && card.text.replace(/\n+/g, " | "));

    section("C. the sheet says how old the rate is, without making a fuss");
    if (await openSettle(cdp, S, "the settle sheet prints the rate age as ONE quiet line, and nothing louder")) {
      const fine = await fineLines(cdp, S);
      await shot("fx-02-settle-fresh");
      check("the settle sheet prints the rate age as ONE quiet line, and nothing louder",
        fine.some((t) => /^Converted at rates from .+\.$/.test(t)), fine.join(" | "));
      check("…and no banner, because every currency in play has a rate",
        await ev(cdp, S, `document.querySelectorAll(".sp-banner").length`) === 0);
    }

    section("H. Other currency…: totals in any currency the rates have, the picker ordered for the person");
    // A fresh screen: C's Settle up sheet is still open over it.
    await remount(cdp, S);
    await showUSD(cdp, S);
    // The head's menu ends in "Other currency…"; choosing it opens one picker, "Show totals in".
    const menu = await J(cdp, S, `(() => { const s = document.querySelector(".sp-head select[data-act='display']");
      return s ? { last: s.options[s.options.length - 1].textContent, lastValue: s.options[s.options.length - 1].value, value: s.value } : null; })()`);
    check("the head's menu of what totals are shown in ends in \"Other currency…\"",
      !!menu && menu.last === "Other currency…" && menu.lastValue === "", JSON.stringify(menu));
    const shownBefore = menu && menu.value;
    await ev(cdp, S, `(() => { const s = document.querySelector(".sp-head select[data-act='display']"); s.value = ""; s.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`);
    await sheetReady(cdp, S);
    await sleep(300);
    const pick = await J(cdp, S, `(async () => { const { store } = await import("/js/store.js");
      const codes = [...document.querySelectorAll(".sh-root .sp-pickrow")].map((b) => ({ code: b.dataset.code, name: b.querySelector(".sp-pickrow-name").firstChild.textContent, off: b.disabled }));
      const sel = document.querySelector(".sp-head select[data-act='display']");
      const top = [...document.querySelectorAll(".sh-root[data-open='1']")].pop();
      return { title: top && (top.querySelector(".sh-title, h2") || {}).textContent, codes, trip: store.currencies() || [], menuBack: sel && sel.value,
        recent: (localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("wgp.split.currency")) || "") || "").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean) }; })()`);
    check("choosing it opens the picker for totals, and the menu stays on what is shown",
      /Show totals in/.test(pick.title || "") && pick.menuBack === shownBefore, JSON.stringify({ title: pick.title, menuBack: pick.menuBack, shownBefore }));
    const tripOwn = pick.trip.filter((c) => pick.codes.some((x) => x.code === c));
    check("its first rows are the trip's own currencies, in the trip's order",
      JSON.stringify(pick.codes.slice(0, tripOwn.length).map((x) => x.code)) === JSON.stringify(tripOwn), `${pick.codes.slice(0, 6).map((x) => x.code).join(",")} vs trip ${tripOwn.join(",")}`);
    const rest = pick.codes.slice(tripOwn.length).filter((x) => !pick.recent.includes(x.code));
    const sorted = rest.every((x, i) => i === 0 || rest[i - 1].name.localeCompare(x.name) <= 0);
    check("after the trip's own and this phone's recent picks, the rest by name", sorted && rest.length > 20,
      sorted ? `${rest.length} by name: ${rest.slice(0, 3).map((x) => x.name).join(", ")} …` : rest.slice(0, 12).map((x) => x.name).join(" | "));
    // A code from the far end by name, one the trip never used, with a rate.
    const far = [...pick.codes].reverse().find((x) => !x.off && !pick.trip.includes(x.code) && !pick.recent.includes(x.code) && x.code !== "USD");
    check("  (a currency from the far end, never used on the trip, with a rate)", !!far, far && `${far.code} ${far.name}`);
    if (far) {
      await ev(cdp, S, `(document.querySelector('.sh-root .sp-pickrow[data-code="${far.code}"]').scrollIntoView({ block: "center" }), 1)`);
      await sleep(300);
      await tap(cdp, S, `.sh-root .sp-pickrow[data-code="${far.code}"]`, far.code);
      await sleep(600);
      const shownNow = await J(cdp, S, `(() => { const s = document.querySelector(".sp-head select[data-act='display']"), n = document.querySelector("[data-sp='headline-amount']"), r = document.querySelector("[data-sp='rates-day']");
        return { menu: s && s.value, code: n && n.dataset.code, approx: !!(n && n.hasAttribute("data-approx")), rates: r && r.textContent, sheet: !!document.querySelector(".sh-root[data-open='1']") }; })()`);
      await shot("fx-07-other-currency");
      check(`the totals are in ${far.code}, with the ≈, and the rates' day under them; the picker closed`,
        shownNow.menu === far.code && shownNow.code === far.code && shownNow.approx && /^Rates from .+/.test(shownNow.rates || "") && !shownNow.sheet, JSON.stringify(shownNow));
      await remount(cdp, S);
      const kept = await ev(cdp, S, `(document.querySelector(".sp-head select[data-act='display']") || {}).value || ""`);
      check(`reloaded, the totals are still in ${far.code}`, kept === far.code, kept);
    }
    // For totals, a currency with no rate is shown, can't be chosen, and says why in words. One rate is taken out of the
    // phone's copy for this (nothing on the server), when the table has every code.
    const none = await J(cdp, S, `(async () => { const { store } = await import("/js/store.js"); const { CURRENCY_CODES } = await import("/js/money.js");
      const f = store.fx(); let code = CURRENCY_CODES.find((c) => c !== "USD" && !(f.rates || {})[c]);
      if (!code) { code = "XCD"; try { delete f.rates[code]; } catch { return { code: null, frozen: true }; } }
      return { code, frozen: false }; })()`);
    await ev(cdp, S, `(() => { const s = document.querySelector(".sp-head select[data-act='display']"); s.value = ""; s.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`);
    await sheetReady(cdp, S);
    await sleep(300);
    const noRate = none.code ? await J(cdp, S, `(() => { const b = document.querySelector('.sh-root .sp-pickrow[data-code="${none.code}"]');
      return b ? { disabled: b.disabled, words: (b.querySelector(".sp-pickrow-why") || {}).textContent || "", why: b.getAttribute("aria-description") } : null; })()`) : null;
    check(`a currency with no rate (${none.code}) is in the list for totals, can't be chosen, and says why in words`,
      !!noRate && noRate.disabled && noRate.words === "No exchange rate for it yet" && noRate.why === "No exchange rate for it yet", JSON.stringify({ none, noRate }));
    await ev(cdp, S, `(document.querySelector(".sh-root [data-act='close'], .sh-root .sh-close")?.click(), 1)`);
    await sleep(500);
    // Back to dollars for what follows, and the table back as the server has it.
    await remount(cdp, S);
    await showUSD(cdp, S);

    section("D. a rate three days old still converts, and says so");
    // next_at is deliberately NOT moved. isStale() therefore stays false, nothing re-fetches
    // underneath the assertion, and the state being measured is the state under test.
    d1(`UPDATE fx_rates SET fetched_at = fetched_at - ${3 * DAY} WHERE base = 'USD'`);
    aged = true;
    await remount(cdp, S);
    await showUSD(cdp, S);
    rows = await feed(cdp, S);
    const pen3 = rows.filter((r) => /^S\//.test(r.paid));
    check("a three-day-old rate still converts every PEN row — nothing is blocked or hidden",
      pen3.length === pen.length && pen3.every((r) => r.conv === dollars(minorOf(r.paid))),
      pen3.map((r) => `${r.paid} -> ${r.conv}`).join(" | "));
    if (await openSettle(cdp, S, "the age line says how old it is, in words, and nothing else changes")) {
      const fine3 = await fineLines(cdp, S);
      await shot("fx-03-settle-3-days");
      check("the age line says how old it is, in words, and nothing else changes",
        fine3.some((t) => /^Converted at rates from 3 days ago\.$/.test(t)), fine3.join(" | "));
    }
    d1(`UPDATE fx_rates SET fetched_at = ${before.f} WHERE base = 'USD'`);
    aged = false;

    section("E. offline is the normal case — the cached table converts with the API dead");
    // The DOCUMENT still comes off the dev server and /api/* is blocked, which is the honest
    // way to test "the rates survived the reload" without also testing the service worker.
    await cdp.send("Network.setBlockedURLs", { urls: ["*/api/*"] }, S);
    await remount(cdp, S);
    await showUSD(cdp, S);
    rows = await feed(cdp, S);
    await shot("fx-04-feed-offline");
    const penOff = rows.filter((r) => /^S\//.test(r.paid));
    check("with every /api/* request blocked, the PEN rows still convert off IndexedDB",
      penOff.length === pen.length && penOff.every((r) => r.conv === dollars(minorOf(r.paid))),
      penOff.map((r) => `${r.paid} -> ${r.conv}`).join(" | "));
    const fxOff = await J(cdp, S,
      `import("/js/store.js").then(({ store }) => ({ n: Object.keys(store.fx().rates).length,
        pen: store.fx().rates.PEN, f: store.fx().fetched_at }))`);
    check("the whole table survived the reload with no server to ask",
      fxOff.n === fx.n && fxOff.pen === RATE, `${fxOff.n} quotes, PEN ${fxOff.pen}`);
    check("the amount AS PAID is on screen either way — it never depended on a rate",
      penOff.every((r) => /^S\/ \d/.test(r.paid)), penOff.map((r) => r.paid).join(" | "));
    await cdp.send("Network.setBlockedURLs", { urls: [] }, S);

    section("G. a currency with no rate is left out, and the card says so on its own line");
    // The snapshot is rewritten ON THE WIRE to carry every rate but the sol's, and the rates
    // endpoint is blocked so nothing puts it back: this phone now holds dollars it can count
    // and soles it cannot. No database is touched.
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*/api/trips/${TRIP}*`, requestStage: "Response" }] }, S);
    let rewrote = 0;
    const offFetch = cdp.on(async (m) => {
      if (m.sessionId !== S || m.method !== "Fetch.requestPaused") return;
      const { requestId } = m.params;
      try {
        const r = await cdp.send("Fetch.getResponseBody", { requestId }, S);
        const body = JSON.parse(r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body);
        if (body && body.fx && body.fx.rates && "PEN" in body.fx.rates) { delete body.fx.rates.PEN; rewrote++; }
        await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "application/json; charset=utf-8" }],
          body: Buffer.from(JSON.stringify(body), "utf8").toString("base64") }, S);
      } catch { try { await cdp.send("Fetch.continueRequest", { requestId }, S); } catch {} }
    });
    await cdp.send("Network.setBlockedURLs", { urls: ["*/api/fx*"] }, S);
    await remount(cdp, S);
    await showUSD(cdp, S);
    rows = await feed(cdp, S);
    const penG = rows.filter((r) => /^S\//.test(r.paid));
    check("the snapshot reached the phone without the sol's rate", rewrote > 0 &&
      (await J(cdp, S, `import("/js/store.js").then(({ store }) => !("PEN" in store.fx().rates))`)) === true,
      `${rewrote} snapshot(s) rewritten`);
    check("every sol row shows what was paid and makes up no converted figure",
      penG.length === pen.length && penG.every((r) => r.conv === "" && /^S\/ \d/.test(r.paid)),
      penG.map((r) => `${r.paid} -> ${r.conv}`).join(" | "));
    const cav = await J(cdp, S, `(() => {
      const c = document.querySelector(".sp-hero");
      const v = c && c.querySelector(".sp-hero-warn");
      if (!v) return null;
      // The warning color as the screen has it: Split is on the design system, so its own root's --warning.
      const probe = document.createElement("i"); probe.style.color = "var(--warning)"; (document.querySelector(".sp") || document.body).append(probe);
      const warn = getComputedStyle(probe).color; probe.remove();
      const cs = getComputedStyle(v);
      const top = c.querySelector(".sp-hero-num") || c.querySelector(".sp-hero-title") || c.querySelector(".sp-hero-sub");
      const r = v.getBoundingClientRect();
      return { text: v.textContent, weight: cs.fontWeight, color: cs.color, warn, glyph: !!v.querySelector("svg"),
        underNumber: !!top && r.top >= top.getBoundingClientRect().bottom - 1,
        onScreen: r.top >= 0 && r.bottom <= innerHeight && r.width > 40, hero: c.innerText };
    })()`);
    const want = `Not counting ${penG.length} ${penG.length === 1 ? "purchase that needs" : "purchases that need"} an exchange rate`;
    check("the headline says how many purchases its number leaves out, in a sentence",
      !!cav && cav.text === want, cav ? `"${cav.text}" (wanted "${want}")` : "no caveat under the headline");
    check("…on a line of its own, under the number, on screen",
      !!cav && cav.underNumber && cav.onScreen, JSON.stringify(cav));
    check("…in --warn with its glyph and the weight, so it does not depend on the colour",
      !!cav && Number(cav.weight) >= 600 && cav.glyph && cav.color === cav.warn,
      cav && `weight ${cav.weight}, ${cav.color}, glyph ${cav.glyph}`);
    await shot("fx-05-headline-caveat");
    if (await openSettle(cdp, S, "the settle sheet names the currency that has no rate")) {
      const banner = await ev(cdp, S, `(document.querySelector(".sp-banner") || {}).innerText || ""`);
      check("the settle sheet names the currency that has no rate", /No exchange rate for PEN yet/.test(banner),
        banner.replace(/\n+/g, " ").slice(0, 140));
      await shot("fx-06-settle-no-rate");
    }
    offFetch();
    await cdp.send("Fetch.disable", {}, S);
    await cdp.send("Network.setBlockedURLs", { urls: [] }, S);

    check("no exception reached the page in the whole run", b.pageErrors.length === 0,
      b.pageErrors.join(" | ") || "clean");
  } finally {
    // The fixture purchases, children first (D1 enforces the foreign key).
    for (const id of created) {
      try {
        d1(`DELETE FROM purchase_shares WHERE purchase_id = '${id}'`);
        d1(`DELETE FROM purchases WHERE id = '${id}'`);
      } catch {}
    }
    // The one mutation this file makes, put back even if an assertion threw over the top of it.
    if (aged) { try { d1(`UPDATE fx_rates SET fetched_at = ${before.f} WHERE base = 'USD'`); } catch {} }
    await b.done();
  }

  section("F. the run left the database exactly as it found it");
  const after = d1("SELECT base, COUNT(*) n, MIN(fetched_at) f, MIN(next_at) x FROM fx_rates GROUP BY base")[0];
  check("fx_rates is back to the row count and the two timestamps it started with",
    !!after && after.n === before.n && after.f === before.f && after.x === before.x,
    `${before.n}/${before.f}/${before.x} -> ${after && after.n}/${after && after.f}/${after && after.x}`);
  const now = d1("SELECT id FROM purchases ORDER BY id").map((r) => r.id);
  check("the fixture purchases are gone and every row that was there before is still there",
    now.length === baseline.length && now.every((id, i) => id === baseline[i]),
    `${baseline.length} rows before, ${now.length} after`);
};

run().then(() => {
  console.log(`\n${failures.length ? `${failures.length} FAILED:\n  - ${failures.join("\n  - ")}` : "all checks passed"}`);
  process.exit(failures.length ? 1 : 0);
}).catch((e) => { console.error("\nFATAL", e); process.exit(2); });

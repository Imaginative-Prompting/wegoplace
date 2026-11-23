#!/usr/bin/env node
/* The Split SCREEN, end to end, in real Chrome against the real `wrangler pages dev` on
 * this lane's dev server (WGP_BASE) and the real local D1.
 *
 *   node scripts/split_ui_harness.mjs            # add --shots to also write PNGs
 *
 * Chrome needs the Bash sandbox disabled (it cannot create its ProcessSingleton socket
 * otherwise), and the launcher (scripts/lib/browser.mjs) starts it only through the queue:
 *   WGP_BASE=http://127.0.0.1:<port> python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node <this file>
 *
 * THE ROUTE IS THE APP'S OWN. Split is a tab and public/js/router.js routes `#/split` and
 * `#/split/:id` itself, so everything the router does to a view is under test too: the page
 * transition, the deferred unmount, `#/split/:id` as a real deep link, and the fixed layer
 * being emptied between screens. (This harness used to splice the two routes into the module
 * on the wire, from before the router had them.)
 *
 * WHAT IT PROVES, most important first:
 *
 *   1. THE FAST PATH IS TWO TAPS AND A NUMBER. Counted, not asserted by eye: the harness
 *      records every click it makes between opening the drawer and the row appearing in the
 *      feed, and fails if there are more than two. Two taps is the whole
 *      requirement — "quickly add lines throughout the trip" — and it is the one thing on
 *      this screen that a redesign could quietly cost.
 *   2. THE ROW IS REAL. It reaches D1 with the right amount, currency, payer and shares, and
 *      SUM(share_minor) = amount_minor.
 *   3. UNEQUAL AFTER THE FACT, in three taps. Tap the row, tap Split, type the shares (typing
 *      one is choosing "By amount"), tap Save changes — on a purchase that is already saved and
 *      already synced, which is the PRIMARY unequal path. And on a short screen the
 *      Split row's choices are SEEN when they open: the row and the line under the list are
 *      on screen, and a closed row whose amounts do not add up says so.
 *   4. THE CURRENCY CONTROL KEEPS THE KEYPAD. The amount field still holds focus after a
 *      currency is chosen, which is what makes the inline row of currencies worth having
 *      instead of a sheet.
 *   5. "GOES WITH" IS A SHORTCUT. Picking a plan fills an EMPTY "What was it?" and never
 *      overwrites a typed one.
 *   6. SETTLE-UP IS RIGHT, and it agrees with money.js run under node.
 *   7. NO SIGNAL IS ORDINARY. A purchase added with /api/* blocked appears in the feed
 *      immediately, looks exactly like a synced row, and drains by itself.
 *   8. SOMEBODY ELSE'S ROW IS READ-ONLY, with the sentence that names who to ask.
 *   9. UNMOUNT IS CLEAN. Navigating away takes the FAB and the toast with it and leaves no
 *      `inert` on #view — the failure that makes the NEXT screen unreachable.
 *
 * Nothing below is asserted from reading code. Every number came out of the browser or out
 * of sqlite.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, REPO, appSettled, boot, evalIn, signInAs, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { TRIP, HOST as TRIP_HOST, d1 as gateD1 } from "./lib/gate_trip.mjs";

const SHOTS = process.argv.includes("--shots");
// Stills go where the environment says, and to a folder under the temp directory otherwise:
// never into the tree.
const SHOT_DIR = process.env.WGP_SHOTS || path.join(os.tmpdir(), "wgp-split-shots");

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + detail : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

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
const inStore = (cdp, S, body) => ev(cdp, S,
  `(async () => { const { store } = await import("/js/store.js"); ${body} })()`);

// (The gate's database, read while its server runs: scripts/lib/gate_trip.mjs, which tries a
// statement again on the local database's passing faults.)
const d1 = (sql, tries = 4) => gateD1(sql, tries);

// ── the click counter ────────────────────────────────────────────────────────────────────
// Every tap this harness makes goes through here, so "two taps and a number" is a MEASURED
// number and not a claim. A click on a selector that does not exist is a failure, not a
// silent no-op — half the ways a drawer can regress look exactly like a missing button.
let taps = 0;
async function tap(cdp, S, sel, { root = "document", label = sel } = {}) {
  const got = await ev(cdp, S, `(() => {
    const n = ${root}.querySelector(${JSON.stringify(sel)});
    if (!n) return 0;
    if (n.disabled) return -1;
    n.click();
    return 1;
  })()`);
  if (got === 0) throw new Error(`tap: nothing matched ${label}`);
  if (got === -1) throw new Error(`tap: ${label} is disabled`);
  taps++;
  await sleep(140);
  return true;
}
// Typing, which is the number and not a tap.
async function type(cdp, S, sel, value) {
  const ok = await ev(cdp, S, `(() => {
    const n = document.querySelector(${JSON.stringify(sel)});
    if (!n) return 0;
    n.focus();
    n.value = ${JSON.stringify(value)};
    n.dispatchEvent(new Event("input", { bubbles: true }));
    return 1;
  })()`);
  if (!ok) throw new Error(`type: nothing matched ${sel}`);
  await sleep(120);
}

const SHEET = `document.querySelector(".sh-root:last-of-type .sh-sheet")`;
const sheetText = (cdp, S) => ev(cdp, S, `(${SHEET} || {}).innerText || ""`);

// A GENUINE cold load at a given hash. Page.navigate to a URL that differs from the current
// one only in (or not even in) the fragment is a SAME-DOCUMENT navigation — Chrome fires a
// hashchange and reloads nothing, so a swapped session cookie is still only visible to the
// next fetch and the page keeps whatever identity it booted with. That cost this harness a
// run: the POST went out as the other member while store.me() never stopped being the first person.
async function reloadTo(cdp, S, hash) {
  await ev(cdp, S, `location.hash = ${JSON.stringify(hash)}`);
  await sleep(150);
  await cdp.send("Page.reload", { ignoreCache: true }, S);
}

// store.me() answers from the IndexedDB CACHE the instant hydrate() finishes and only becomes
// the session's user when the background /api/me lands — which is exactly what makes the app
// usable offline, and exactly what makes "assert immediately after a reload" wrong. Every
// identity-sensitive check waits for the refresh to have landed first.
const waitMe = (cdp, S, id) => waitFor(cdp, S,
  `(async () => { const { store } = await import("/js/store.js"); return store.me().id === ${JSON.stringify(id)} ? 1 : 0; })()`,
  { label: `store.me() === ${id}` });

const created = [];   // purchase ids this run made, cleaned out of D1 at the end

/**
 * The id of the row this run has just made: the one on the feed that was not there before.
 * Never "the first row in the feed": that is the new one only while nothing on the trip is
 * dated after today, and whatever this returns is pushed onto `created`, which the cleanup
 * DELETES. `known` is every id already accounted for (the feed as this run found it, and
 * each row it has made since); see mintedRow in split_harness.mjs.
 */
const known = new Set();
async function mintedRow(cdp, S) {
  const id = await waitFor(cdp, S, `(() => {
    const skip = ${JSON.stringify([...known])};
    for (const r of document.querySelectorAll(".sp-row")) if (!skip.includes(r.dataset.id)) return r.dataset.id;
    return 0;
  })()`, { label: "a feed row this run has not seen before" });
  known.add(id);
  created.push(id);
  return id;
}
/** What one row of the feed says. */
const rowText = (cdp, S, id) => ev(cdp, S, `(document.querySelector('.sp-row[data-id="${id}"]') || {}).innerText || ""`);

const run = async () => {
  if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });
  // reduceMotion FALSE: the FLIP on the feed and the sheet's slide are part of what is being
  // checked, and motion.js kills everything under the reduce query.
  const b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: false });
  const { cdp, S } = b;
  const shot = async (name) => { if (SHOTS) await b.shot(path.join(SHOT_DIR, `${name}.png`)); };

  try {
    await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });

    section("0. the screen mounts through the real router");
    await cdp.send("Page.navigate", { url: BASE + `/t/${TRIP}/#/split` }, S);
    await appSettled(cdp, S);
    await waitFor(cdp, S, `document.querySelector("#view") ? 1 : 0`, { label: "app shell" });
    const me = await waitFor(cdp, S,
      `(async () => { const { store } = await import("/js/store.js"); const m = store.me(); return m && m.id ? m.id : 0; })()`,
      { label: "store.ready() + /api/me" });
    await waitFor(cdp, S, `document.querySelector(".sp-h1") ? 1 : 0`, { label: "the Split screen" });
    check("#/split mounted split.js through the app's own router",
      await ev(cdp, S, `document.querySelector("#view").dataset.route`) === "split");
    check("the injected stylesheet is on the page exactly once",
      await ev(cdp, S, `document.querySelectorAll("#sp-styles").length`) === 1);
    // The stylesheet is a JS template literal, and a stray backtick inside a CSS comment
    // ends it mid-file. That happened once in this build: the module stopped parsing, the
    // route mounted nothing, and the only symptom was a blank screen. A rule count is the
    // cheap standing guard against the quieter version, where the template survives but
    // half the rules are gone.
    const nRules = await ev(cdp, S, `document.getElementById("sp-styles").sheet.cssRules.length`);
    check("…and it parsed whole, not truncated", nRules > 120, `${nRules} rules`);
    check("no exception reached the page on mount", b.pageErrors.length === 0,
      b.pageErrors.join(" | ") || "clean");

    const members = JSON.parse(await inStore(cdp, S,
      `return JSON.stringify(store.members().map((m) => ({ id: m.id, name: m.name, c: m.note_color, i: m.initials })))`));
    check("the roster the split selector renders is there", members.length >= 2,
      members.map((m) => `${m.i}:${m.name}`).join(", "));
    console.log(`        me=${me}  members=${members.length}`);

    // THIS USED TO READ "GET /api/trips/<id> does not carry `purchases` yet, so this phone starts
    // with an empty feed whatever is in D1". That stopped being true the night the snapshot
    // learned to carry purchases: the feed now hydrates from the server on boot, so what is
    // on screen here is whatever is in D1 for this trip, and the empty state is only on
    // screen when the table is genuinely empty.
    //
    // Which makes an unconditional empty-state assertion a fixture that only holds on an
    // empty table — the exact thing AGENTS.md forbids, and the reason these two checks
    // reported a Split regression that did not exist. So the branch is explicit and both
    // sides are real assertions: on a clean table the spec's copy is checked word for word,
    // and on a table that already has rows the COMPLEMENT is checked instead, so a feed that
    // renders nothing still fails here rather than passing by falling down the other arm.
    // The reason the empty state could not be exercised is printed rather than swallowed —
    // a check that quietly tests nothing is worse than one that fails.
    const baseRows = await ev(cdp, S, `document.querySelectorAll(".sp-row").length`);
    for (const id of JSON.parse(await ev(cdp, S, `JSON.stringify([...document.querySelectorAll(".sp-row")].map((r) => r.dataset.id))`))) known.add(id);
    const emptyTxt = await ev(cdp, S, `document.querySelector("#view").innerText`);
    if (baseRows === 0) {
      check("the empty state says what to do, in the brief's own words",
        /Nothing to split yet/.test(emptyTxt) &&
        /Add what someone paid and who was in on it\. Split keeps the tally\./.test(emptyTxt), emptyTxt.replace(/\n+/g, " ").slice(0, 120));
      check("no way into Settle up over an empty feed",
        await ev(cdp, S, `document.querySelectorAll('[data-act="settle"]').length`) === 0);
    } else {
      console.log(`        the empty state is NOT on screen: this trip already has ${baseRows} purchase(s) ` +
                  `in D1, and the snapshot now carries them. Asserting the complement instead.`);
      check("the feed renders the purchases this trip already has, rather than the empty state",
        baseRows > 0 && !/Nothing to split yet/.test(emptyTxt), `${baseRows} row(s) on screen`);
      check("\"Everyone's balances\" is there over a feed that has rows",
        (await ev(cdp, S, `document.querySelectorAll('#view [data-act="settle"]').length`)) === 1);
    }
    // MEASURED, so the ship-order note in the report is a fact and not a worry.
    // functions/api/fx.js is the api owner's and does not exist yet; Pages' asset server
    // answers a POST to a route that is not a Function with 405 and a text/html body, and
    // store.js's req() correctly reads a non-JSON answer as a captive portal — setNet(false),
    // so the SHELL says "Offline" on a phone that is not. split.js therefore only asks for
    // rates when a rate would actually convert something on screen, which takes the blip off
    // the empty feed entirely; a mixed-currency feed will still see it until fx.js ships.
    const fxProbe = await ev(cdp, S, `(async () => {
      const r = await fetch("/api/fx/refresh", { method: "POST", headers: { Accept: "application/json" } });
      return r.status + " " + (r.headers.get("content-type") || "");
    })()`);
    console.log(`        POST /api/fx/refresh today answers: ${fxProbe}  (functions/api/fx.js is not built yet)`);
    check("Split does NOT ask for rates on an empty feed, so the shell is not made to say Offline",
      (await inStore(cdp, S, `return store.online() ? 1 : 0`)) === 1);

    const fab = await ev(cdp, S, `(() => {
      const f = document.querySelector("#rt-fixed .fab");
      return f ? f.getAttribute("aria-label") : "";
    })()`);
    check("the FAB is parked in the ROUTER's fixed layer, not inside #view",
      fab === "Add a purchase", fab || "(missing)");
    await shot("01-empty");

    // ── 1. two taps and a number ───────────────────────────────────────────────────────
    section("1. the fast path — two taps and a number");
    taps = 0;
    await tap(cdp, S, "#rt-fixed .fab", { label: "the FAB" });
    await sleep(700);                                   // the open transition + the focus
    const drawer = await sheetText(cdp, S);
    check("the drawer opened and is titled for a new purchase", /Add a purchase/.test(drawer));
    // THE KEYPAD UP AT ONCE: the amount is focused in the tap that opened the sheet, and the
    // sheet goes to its full height in that same move (sheet.js's focusin), never in a second one.
    const focus0 = await ev(cdp, S, `(() => {
      const a = document.activeElement;
      return JSON.stringify({ amount: !!(a && a.classList.contains("sp-amtin")), inSheet: !!(a && a.closest(".sh-root")),
        tall: (document.querySelector(".sh-root") || { dataset: {} }).dataset.tall === "1" });
    })()`);
    check("opening the sheet focuses the amount, so the keypad is up at once, and the sheet is at its full height",
      /"amount":true/.test(focus0) && /"inSheet":true/.test(focus0) && /"tall":true/.test(focus0), focus0);
    check("Add starts DISABLED and is recoloured, never dimmed (§8.1)",
      await ev(cdp, S, `(() => { const b = document.querySelector('[data-act="save"]');
        return b && b.disabled && getComputedStyle(b).opacity === "1"; })()`));
    const pre = await ev(cdp, S, `(() => {
      const paid = [...document.querySelectorAll('[data-grp="paid"] .sp-person')]
        .filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.dataset.id);
      const ans = (k) => (document.querySelector('[data-slot="ans-' + k + '"]') || {}).textContent || "";
      const cur = document.querySelector('[data-act="cur"]').textContent.trim();
      const open = [...document.querySelectorAll(".sp-pane")].filter((x) => !x.hidden).length;
      return JSON.stringify({ paid, payer: ans("paid"), split: ans("split"), when: ans("when"), goes: ans("goes") ||
        (document.querySelector('[data-sp="row-goes"] .sp-opt-v') || {}).textContent || "", cur, open });
    })()`);
    const P = JSON.parse(pre);
    check("Paid by is pre-chosen: you, and its row says so", P.paid.length === 1 && P.paid[0] === me && P.payer === "You", JSON.stringify(P));
    check("Split is pre-chosen: everyone, evenly, and its row says so in words", P.split === "Everyone, evenly", P.split);
    check("When says Today, and For says A plan or place (nothing chosen)", P.when === "Today" && P.goes === "A plan or place", `${P.when} / ${P.goes}`);
    check("every row is closed on open: the common purchase touches none of them", P.open === 0, `${P.open} open`);
    check("the currency beside the amount is its code, quietly", /^(USD|PEN)$/.test(P.cur), P.cur);
    // styles.css's shared field rule matches input[type="text"] at (0,1,1) and out-specifies
    // any single class, so a one-class override loses and the amount field draws the kit's
    // own border inside this row's: a box in a box. Measured, because it is invisible in the
    // source and obvious in a screenshot.
    const amtBox = await ev(cdp, S, `(() => {
      const cs = getComputedStyle(document.querySelector(".sp-amtin"));
      return JSON.stringify({ b: cs.borderTopWidth, bg: cs.backgroundColor, fs: cs.fontSize });
    })()`);
    // 52: every big number's one size in the heading face, the amount being typed included (the design system's ruling).
    check("the amount is the sheet's headline: borderless, transparent, 52px",
      /"b":"0px"/.test(amtBox) && /rgba\(0, 0, 0, 0\)/.test(amtBox) && /"fs":"52px"/.test(amtBox), amtBox);
    await shot("02-drawer");

    await type(cdp, S, ".sp-amtin", "48.00");
    check("Add un-disables the moment the amount parses",
      await ev(cdp, S, `!document.querySelector('[data-act="save"]').disabled`));
    await tap(cdp, S, '[data-act="save"]', { label: "Add" });
    await sleep(900);

    check("TWO TAPS AND A NUMBER — the fast path's tap count", taps === 2, `${taps} taps`);
    // The row's own words, never the whole feed's: on a trip that has purchases already, the
    // feed says "Everyone" and "48.00" somewhere whether or not this row does.
    const firstId = await mintedRow(cdp, S);
    const feed1 = await rowText(cdp, S, firstId);
    check("the row is in the feed", /48\.00/.test(feed1), feed1.replace(/\n+/g, " | ").slice(0, 160));
    check("…with your share beside who paid, in words", /You paid/.test(feed1) && /your share/.test(feed1), feed1.replace(/\n+/g, " | "));
    check("the id is client-minted with the uid('pu') prefix", /^pu-/.test(firstId), firstId);
    const skin = await ev(cdp, S, `(() => {
      const marks = document.querySelectorAll('.sp-row[data-id="${firstId}"] .sp-mark');
      const cs = getComputedStyle(marks[0]);
      return JSON.stringify({ n: marks.length, text: marks[0].textContent, bg: cs.backgroundColor, fg: cs.color });
    })()`);
    check("the payer wears their initials mark, ONE per row",
      /"n":1,/.test(skin) && /"text":"[A-Z?]{2}"/.test(skin), skin);
    check("\"Everyone's balances\" is there with the first purchase",
      await ev(cdp, S, `document.querySelectorAll('#view [data-act="settle"]').length`) === 1);
    await shot("03-one-row");

    // ── 2. it is really in D1 ──────────────────────────────────────────────────────────
    section("2. the row reached D1");
    await inStore(cdp, S, `await store.flush(); return 1;`);
    await sleep(1200);
    const rowsD1 = d1(`SELECT id, description, amount_minor, currency, amount_exp, paid_by,
      split_mode, created_by FROM purchases WHERE id = '${firstId}'`);
    check("one row, exactly once (the POST upserts on the client id)", rowsD1.length === 1);
    check("the amount is stored AS PAID, in integer minor units",
      rowsD1[0] && rowsD1[0].amount_minor === 4800 && rowsD1[0].amount_exp === 2,
      rowsD1[0] && `${rowsD1[0].currency} ${rowsD1[0].amount_minor} exp ${rowsD1[0].amount_exp}`);
    check("a BLANK description round-trips as '' — the fast path skips it",
      rowsD1[0] && rowsD1[0].description === "", JSON.stringify(rowsD1[0] && rowsD1[0].description));
    check("created_by is the session user, taken from the cookie and never from the body",
      rowsD1[0] && rowsD1[0].created_by === me, rowsD1[0] && rowsD1[0].created_by);
    const sh = d1(`SELECT user_id, weight, share_minor FROM purchase_shares
      WHERE purchase_id = '${firstId}' ORDER BY user_id`);
    check("every member is in the split, weight 1", sh.length === members.length &&
      sh.every((s) => s.weight === 1), sh.map((s) => `${s.share_minor}`).join("+"));
    check("THE INVARIANT — SUM(share_minor) = amount_minor",
      sh.reduce((a, s) => a + s.share_minor, 0) === 4800,
      `${sh.reduce((a, s) => a + s.share_minor, 0)} = 4800`);
    check("the odd céntimo is distributed, not dropped: the shares are NOT all equal",
      new Set(sh.map((s) => s.share_minor)).size === (4800 % members.length ? 2 : 1),
      `${members.length}-way split of 4800`);

    // ── 3. unequal after the fact, in three taps ───────────────────────────────────────
    section("3. unequal AFTER the fact — the primary unequal path, on a synced row");
    taps = 0;
    await tap(cdp, S, `.sp-row[data-id="${firstId}"]`, { label: "the feed row" });
    await sleep(650);
    const edit = await sheetText(cdp, S);
    check("the same drawer opens, titled Edit purchase", /Edit purchase/.test(edit));
    check("no field is focused on open — this one opens for reading as often as writing",
      await ev(cdp, S, `!document.activeElement || !document.activeElement.classList.contains("sp-amtin")`));
    check("the amount is prefilled from the row",
      await ev(cdp, S, `document.querySelector(".sp-amtin").value`) === "48.00");
    await tap(cdp, S, '[data-act="open-split"]', { label: "the Split row" });
    await sleep(200);
    const uneqRows = await ev(cdp, S, `(() => {
      const ins = [...document.querySelectorAll(".sp-uin")];
      const by = [...document.querySelectorAll('.sp-seg [role="radio"]')].find((b) => b.getAttribute("aria-checked") === "true");
      return JSON.stringify({ n: ins.length, vals: ins.map((i) => i.value), by: by ? by.textContent.trim() : "",
        sumShown: !document.querySelector('[data-slot="sum"]').hidden,
        expanded: document.querySelector('[data-act="open-split"]').getAttribute("aria-expanded") });
    })()`);
    const U = JSON.parse(uneqRows);
    check("Split opens in place, one row per person, each with their EVENLY share beside the name",
      U.expanded === "true" && U.n === members.length && U.by === "Evenly" &&
      U.vals.reduce((a, v) => a + Math.round(Number(v) * 100), 0) === 4800, `${U.by}: ${U.vals.join(" / ")}`);
    check("evenly, there is no line under the list: nothing can fail to add up", !U.sumShown);
    const uGeom = await ev(cdp, S, `(() => JSON.stringify({
      inp: Math.round(document.querySelector(".sp-uin").getBoundingClientRect().width),
      name: Math.round(document.querySelector(".sp-who .sp-pname").getBoundingClientRect().width) }))()`);
    check("each share sits BESIDE the person's name, never pushing it out (the shared field rule's specificity trap)",
      JSON.parse(uGeom).inp >= 90 && JSON.parse(uGeom).inp <= 110 && JSON.parse(uGeom).name > 40, uGeom);
    await shot("04-unequal-open");

    // The payer carries 30.00 of a 48.00 dinner; the rest split the remaining 18.00.
    const ids = members.map((m) => m.id).sort();
    const mine = ids.indexOf(me);
    const rest = 1800 / (ids.length - 1);
    for (let i = 0; i < ids.length; i++) {
      const v = i === mine ? 3000 : rest;
      await type(cdp, S, `.sp-uin[data-id="${ids[i]}"]`, (v / 100).toFixed(2));
    }
    const sumNow = await ev(cdp, S, `(() => { const n = document.querySelector('[data-slot="sum"]');
      const by = [...document.querySelectorAll('.sp-seg [role="radio"]')].find((b) => b.getAttribute("aria-checked") === "true");
      return JSON.stringify({ s: n.dataset.state, t: n.innerText.trim(), by: by ? by.textContent.trim() : "",
        save: !document.querySelector('[data-act="save"]').disabled }); })()`);
    check("typing a share chose \"By amount\" by itself, and the line under the list tracks every keystroke",
      /"s":"ok"/.test(sumNow) && /"by":"By amount"/.test(sumNow) && /48\.00 of .*48\.00/.test(sumNow) && /"save":true/.test(sumNow), sumNow);
    await tap(cdp, S, '[data-act="save"]', { label: "Save changes" });
    await sleep(1000);
    check("THREE TAPS AND THE SHARE AMOUNTS — the primary unequal path",
      taps === 3, `${taps} taps`);

    const feed2 = await rowText(cdp, S, firstId);
    check("the feed says so in WORDS beside your share, carried by no hue at all",
      /your share .*30\.00, unequal/.test(feed2), feed2.replace(/\n+/g, " | ").slice(0, 160));
    await inStore(cdp, S, `await store.flush(); return 1;`);
    await sleep(1200);
    const sh2 = d1(`SELECT user_id, weight, share_minor FROM purchase_shares
      WHERE purchase_id = '${firstId}' ORDER BY user_id`);
    const mode2 = d1(`SELECT split_mode FROM purchases WHERE id = '${firstId}'`)[0].split_mode;
    check("D1 has split_mode 'exact' and the weights ARE the minor amounts", mode2 === "exact" &&
      sh2.every((s) => s.weight === s.share_minor), `${mode2}: ` + sh2.map((s) => s.weight).join("/"));
    check("…and it still sums exactly", sh2.reduce((a, s) => a + s.share_minor, 0) === 4800,
      `${sh2.reduce((a, s) => a + s.share_minor, 0)} = 4800`);
    check("the payer's share is the 30.00 that was typed",
      (sh2.find((s) => s.user_id === me) || {}).share_minor === 3000);
    await shot("05-unequal-row");

    // ── 3b. the Split row on short screens ─────────────────────────────────────────────
    // The Split row's choices open in place, under the row, in a form taller than the sheet.
    // Opening them must put them on screen, and the line that says whether the amounts add up
    // (which is why the button would be off) must be visible, above the button's band. Every
    // rectangle below is read from the page.
    section("3b. the Split row's choices are seen when they open, on a short screen");
    const DISC = `(() => {
      const port = document.querySelector(".sh-body").getBoundingClientRect();
      const go = document.querySelector(".sp-go").getBoundingClientRect();
      const inPort = (n) => { if (!n || n.hidden) return false; const q = n.getBoundingClientRect();
        return q.height > 0 && q.top >= port.top - 0.5 && q.bottom <= Math.min(port.bottom, go.top) + 0.5; };
      const head = document.querySelector('[data-act="open-split"]');
      const sum = document.querySelector('[data-slot="sum"]');
      const ans = document.querySelector('[data-slot="ans-split"]');
      const bad = ans.querySelector(".sp-bad");
      const rows = [...document.querySelectorAll(".sp-split .sp-who")];
      return JSON.stringify({
        head: inPort(head), headTop: Math.round(head.getBoundingClientRect().top - port.top),
        open: head.getAttribute("aria-expanded") === "true",
        // The line rides in the sticky foot, above the button: on screen, and above the button itself.
        sum: !!sum && !sum.hidden && (() => { const q = sum.getBoundingClientRect(), b = document.querySelector('[data-act="save"]').getBoundingClientRect();
          return q.height > 0 && q.top >= port.top - 0.5 && q.bottom <= b.top + 0.5; })(), sumUnderRows: !!sum && rows.length > 0 && !sum.hidden &&
          sum.getBoundingClientRect().top >= rows[rows.length - 1].getBoundingClientRect().bottom - 0.5,
        rowsOn: rows.filter(inPort).length, rows: rows.length,
        words: sum && !sum.hidden ? sum.innerText.trim() : "", state: sum ? sum.dataset.state : "",
        said: ans.innerText.trim(), bad: !!bad, badWeight: bad ? getComputedStyle(bad).fontWeight : "",
        anim: getComputedStyle(document.querySelector(".sp-split")).animationName,
        save: !document.querySelector('[data-act="save"]').disabled });
    })()`;
    const disc = async () => JSON.parse(await ev(cdp, S, DISC));
    const quiet = (sel) => ev(cdp, S, `document.querySelector(${JSON.stringify(sel)}).click()`);
    for (const [w, h] of [[320, 568], [375, 667]]) {
      await b.metrics(w, h, 2);
      await sleep(250);
      await tap(cdp, S, `.sp-row[data-id="${firstId}"]`, { label: "the unequal row" });
      await sleep(650);
      const c0 = await disc();
      check(`${w}x${h}: an unequal purchase opens with Split closed and its row saying so, in words`,
        c0.rows === 0 && !c0.open && /by amount$/.test(c0.said) && c0.save, JSON.stringify(c0));
      await quiet('[data-act="open-split"]');
      await sleep(250);
      const c1 = await disc();
      check(`${w}x${h}: opening it puts the row, the people and the line under them on screen, above the button`,
        c1.head && c1.sum && c1.rowsOn === c1.rows && c1.rows >= 3, JSON.stringify(c1));
      check(`${w}x${h}: the line sits under the list and says the amounts add up`,
        c1.sumUnderRows && c1.state === "ok", JSON.stringify(c1));
      check(`${w}x${h}: what the row opens fades in over the chevron's own duration`,
        c1.anim === "sp-open", c1.anim);
      await shot(`05b-split-open-${w}`);

      // Break the sum by one person's share. The button goes off, and the line that says why
      // is on screen with it, in words.
      await type(cdp, S, `.sp-uin[data-id="${me}"]`, "1.00");
      const c2 = await disc();
      check(`${w}x${h}: amounts that don't add up turn the button off WITH the reason on screen, in words`,
        !c2.save && c2.sum && c2.state === "short" && /29\.00\s+still to share/.test(c2.words), JSON.stringify(c2));
      await ev(cdp, S, `document.activeElement && document.activeElement.blur()`);

      // Folded away while it doesn't add up: the closed row carries the reason itself.
      await quiet('[data-act="open-split"]');
      await sleep(200);
      const c3 = await disc();
      check(`${w}x${h}: closed while it doesn't add up, the row says "Doesn't add up", with its glyph and the weight`,
        c3.rowsOn === 0 && !c3.save && c3.head && c3.said === "Doesn't add up" && c3.bad &&
        Number(c3.badWeight) >= 600, JSON.stringify(c3));
      await shot(`05c-split-closed-short-${w}`);
      await ev(cdp, S, `document.querySelector(".sh-scrim").click()`);
      await sleep(600);
    }

    // A screen so short the list cannot fit (the room a keyboard leaves): the row goes to the top
    // of the sheet's scrollport, and scrolled to the last person, the line under the list is on
    // screen above the button.
    await b.metrics(320, 440, 2);
    await sleep(250);
    await tap(cdp, S, `.sp-row[data-id="${firstId}"]`, { label: "the unequal row" });
    await sleep(650);
    await quiet('[data-act="open-split"]');
    await sleep(250);
    const t1 = await disc();
    check("320x440: a list taller than the sheet opens with its row at the top of the scrollport",
      t1.head && t1.headTop <= 14 && t1.rowsOn < t1.rows, JSON.stringify(t1));
    await ev(cdp, S, `(() => { const p = document.querySelector(".sh-body"); const last = [...document.querySelectorAll(".sp-split .sp-who")].pop();
      p.scrollTop += last.getBoundingClientRect().bottom - document.querySelector(".sp-go").getBoundingClientRect().top + 40; })()`);
    await sleep(250);
    const t2 = await disc();
    check("320x440: scrolled to the last person, the row is gone and the line under the list is on screen",
      !t2.head && t2.sum, JSON.stringify(t2));
    await shot("05d-split-scrolled-320x440");
    check("…and nothing was written by looking: the row is still the 30.00 split",
      await ev(cdp, S, `document.querySelector('.sp-uin[data-id="${me}"]').value`) === "30.00");
    await ev(cdp, S, `document.querySelector(".sh-scrim").click()`);
    await sleep(600);
    await b.metrics(390, 844, 2);
    await sleep(250);

    // ── 4. the currency control ────────────────────────────────────────────────────────
    section("4. the currency control — the keypad never drops");
    await tap(cdp, S, "#rt-fixed .fab", { label: "the FAB" });
    await sleep(700);
    await type(cdp, S, ".sp-amtin", "120.00");
    await ev(cdp, S, `document.querySelector(".sp-amtin").focus()`);
    await tap(cdp, S, '[data-act="cur"]', { label: "the currency chip" });
    check("the currency beside the amount opens an INLINE row of the trip's currencies, not a sheet",
      await ev(cdp, S, `!document.querySelector(".sp-currow").hidden &&
        document.querySelectorAll(".sh-root").length === 1`));
    check("the currency row fades in the way its chevron turns, rather than snapping",
      await ev(cdp, S, `getComputedStyle(document.querySelector(".sp-currow")).animationName`) === "sp-open");
    check("…and 'Other currency…' is the door to the rest of the ISO table",
      await ev(cdp, S, `!!document.querySelector('[data-act="other-cur"]')`));
    // An inline <svg> with no width collapses to nothing in a flex row, which would leave the
    // selected currency carried by the accent fill ALONE — §8.4, exactly.
    check("the selected currency chip draws a real tick, not a zero-width one",
      await ev(cdp, S, `(() => { const t = document.querySelector('.sp-currow [aria-pressed="true"] .sp-tick');
        return !!t && t.getBoundingClientRect().width >= 10; })()`));
    await tap(cdp, S, '[data-act="other-cur"]', { label: "Other currency…" });
    await sleep(650);
    check("the all-currency picker is a STACKED sheet — the drawer stays put underneath",
      await ev(cdp, S, `document.querySelectorAll(".sh-root").length`) === 2);
    await type(cdp, S, '.sp-filter[data-f="filter"]', "sol");
    const hit = await ev(cdp, S, `(() => {
      const n = document.querySelector(".sh-root:last-of-type [data-code]");
      return n ? n.dataset.code + "|" + n.innerText.replace(/\\n/g, " ") : "";
    })()`);
    check("searching by NAME finds it, not only by code", /^PEN\|/.test(hit), hit);
    await tap(cdp, S, `.sh-root:last-of-type [data-code="PEN"]`, { label: "PEN" });
    await sleep(650);
    check("the picker closed and the drawer is back",
      await ev(cdp, S, `document.querySelectorAll(".sh-root").length`) === 1);
    const curNow = await ev(cdp, S, `(() => JSON.stringify({
      chip: document.querySelector('[data-act="cur"]').textContent.trim(),
      focus: document.activeElement && document.activeElement.className,
      amt: document.querySelector(".sp-amtin").value }))()`);
    check("the currency changed and the amount survived it, the sign beside the amount with it",
      /"chip":"PEN"/.test(curNow) && /120\.00/.test(curNow) &&
      (await ev(cdp, S, `document.querySelector('[data-slot="sym"]').textContent`)) === "S/", curNow);
    check("THE AMOUNT FIELD STILL HAS FOCUS — the keypad never drops (§6)",
      /sp-amtin/.test(curNow), curNow);

    // A ZERO-DIGIT CURRENCY, which is where the exponent stops being decoration. 185.50
    // cannot be said in yen, and the first spelling of this rule carried the MINOR units
    // across instead of the major value — turning S/ 185.500 into 1855.00. The rule now lives
    // in money.js restate() and is held to its literals by scripts/split_math_check.mjs; this
    // is the same rule reached through the actual chip.
    await type(cdp, S, ".sp-amtin", "185.50");
    await tap(cdp, S, '[data-act="cur"]', { label: "the currency chip" });
    await tap(cdp, S, '[data-act="other-cur"]', { label: "Other currency…" });
    await sleep(650);
    await type(cdp, S, '.sp-filter[data-f="filter"]', "JPY");
    await tap(cdp, S, `.sh-root:last-of-type [data-code="JPY"]`, { label: "JPY" });
    await sleep(650);
    const yen = await ev(cdp, S, `(() => JSON.stringify({
      chip: document.querySelector('[data-slot="sym"]').textContent + " " + document.querySelector('[data-act="cur"]').textContent.trim(),
      amt: document.querySelector(".sp-amtin").value,
      save: !document.querySelector('[data-act="save"]').disabled }))()`);
    check("a 0-digit currency restates the MAJOR value: 185.50 becomes 186, not 1855",
      /"amt":"186"/.test(yen) && /¥ JPY/.test(yen) && /"save":true/.test(yen), yen);
    // A currency with no symbol of its own (CHF: the table's symbol for it IS the code) is named
    // once everywhere it appears. Symbol-then-code printed "CHF CHF" on the chip, in the quick
    // row and under the name in the picker.
    await tap(cdp, S, '[data-act="cur"]', { label: "the currency chip" });
    await tap(cdp, S, '[data-act="other-cur"]', { label: "Other currency…" });
    await sleep(650);
    await type(cdp, S, '.sp-filter[data-f="filter"]', "CHF");
    const chfRow = await ev(cdp, S, `(() => {
      const r = document.querySelector('.sh-root:last-of-type [data-code="CHF"]');
      return r ? r.querySelector(".sp-pickrow-sub").textContent.trim() : "(no CHF row)";
    })()`);
    check("the picker names a no-symbol currency once under its name", chfRow === "CHF", chfRow);
    await shot("05e-no-symbol-picker");
    await tap(cdp, S, `.sh-root:last-of-type [data-code="CHF"]`, { label: "CHF" });
    await sleep(650);
    const chfChip = await ev(cdp, S, `document.querySelector('[data-act="cur"]').textContent.trim()`);
    check("the sheet's currency says CHF once", chfChip === "CHF", chfChip);
    await tap(cdp, S, '[data-act="cur"]', { label: "the currency chip" });
    const chfQuick = await ev(cdp, S, `(() => {
      const b = document.querySelector('[data-act="pick-cur"][data-code="CHF"]');
      return b ? b.textContent.trim() : "(not in the quick row)";
    })()`);
    check("…and so does its chip in the quick row", chfQuick === "CHF", chfQuick);
    await shot("05f-no-symbol-chips");
    const symQuick = await ev(cdp, S, `(() => {
      const b = document.querySelector('[data-act="pick-cur"][data-code="JPY"]');
      return b ? b.textContent.trim() : "(not in the quick row)";
    })()`);
    check("control: a currency that has a symbol still shows symbol then code", symQuick === "¥ JPY", symQuick);
    await tap(cdp, S, '[data-act="cur"]', { label: "the currency chip (close the row)" });

    // Back to soles — and PEN is STILL IN THE QUICK ROW, one tap away, even though no
    // purchase has been saved in it yet. That is the device MRU: a currency chosen out of the
    // 180-long picker is by definition one of the ones this person needs, and reaching back
    // through the whole picker to undo a mis-tap is the scroll this feature exists to avoid.
    await tap(cdp, S, '[data-act="cur"]', { label: "the currency chip" });
    const quick = await ev(cdp, S,
      `[...document.querySelectorAll("[data-code]")].map((b) => b.dataset.code).join(",")`);
    check("a currency chosen this session stays in the quick row without a purchase in it",
      /PEN/.test(quick) && /JPY/.test(quick), quick);
    await tap(cdp, S, `[data-act="pick-cur"][data-code="PEN"]`, { label: "PEN" });
    await sleep(200);
    check("…and a currency that can still say the number leaves the text untouched",
      (await ev(cdp, S, `document.querySelector(".sp-amtin").value`)) === "186");
    await type(cdp, S, ".sp-amtin", "120.00");

    // Drop one person from the split: the row says so in words, never with a pile of marks.
    const other = members.find((m) => m.id !== me);
    await tap(cdp, S, '[data-act="open-split"]', { label: "the Split row" });
    await tap(cdp, S, `[data-grp="split"] .sp-person[data-id="${other.id}"]`, { label: "deselect one" });
    const splitSaid = await ev(cdp, S, `document.querySelector('[data-slot="ans-split"]').textContent`);
    check("the Split row's answer follows: who's in, in words", members.length - 1 === 2
      ? /^.+ and .+, evenly$/.test(splitSaid) : splitSaid === `${members.length - 1} people, evenly`, splitSaid);
    await type(cdp, S, '[data-f="description"]', "Taxi to Ollantaytambo");
    await tap(cdp, S, '[data-act="save"]', { label: "Add" });
    await sleep(900);
    const second = await mintedRow(cdp, S);
    const feed3 = await rowText(cdp, S, second);
    check("the new row is in the feed and is in soles", /S\/ 120\.00/.test(feed3),
      feed3.replace(/\n+/g, " | ").slice(0, 140));
    // SCOPED TO THE ROW THIS BLOCK JUST MADE. Unscoped, this counted every initials square in
    // the whole feed, so it only ever agreed when the row under test was the only partial
    // split on screen — one leftover partial-split row from an earlier run and it reports
    // "10 squares for 5 people" and looks precisely like split.js double-rendering the run.
    // The row is addressed by the id the feed gave it, which is the same id D1 is queried with
    // below, so the check cannot drift onto a neighbour.
    const runN = await ev(cdp, S,
      `[...document.querySelectorAll('.sp-row[data-id="${second}"] .sp-mark')].filter((n) => n.getClientRects().length).length`);
    check("a partial split draws ONE mark, the payer's, and no pile of marks for who's in",
      runN === 1, `${runN} mark(s)`);
    check("…and the row prints the typed description, not the fallback",
      /Taxi to Ollantaytambo/.test(feed3));
    await shot("06-two-currencies");

    // ── 5. the attachment ──────────────────────────────────────────────────────────────
    section("5. For — a shortcut for filling in WHAT IT WAS");
    await tap(cdp, S, "#rt-fixed .fab", { label: "the FAB" });
    await sleep(700);
    await type(cdp, S, ".sp-amtin", "18.50");
    await tap(cdp, S, '[data-act="goes"]', { label: "the For row" });
    await sleep(700);
    check("the picker is a stacked sheet titled 'What it was for'",
      /What it was for/.test(await ev(cdp, S, `document.querySelector(".sh-root:last-of-type .sh-title").textContent`)));
    const groups = await ev(cdp, S,
      `[...document.querySelectorAll(".sh-root:last-of-type .sp-pick-head")].map((n) => n.textContent).join("|")`);
    check("Today / This trip / Places, in that order", /This trip/.test(groups) && /Places/.test(groups), groups);
    const dayRows = JSON.parse(await ev(cdp, S, `(() => {
      const rows = [...document.querySelectorAll(".sh-root:last-of-type .sp-dayrow")];
      const said = rows.filter((r) => { const a = r.querySelector(".sp-dayrow-add");
        return a && a.textContent.trim() === "The whole day" && a.getBoundingClientRect().width > 40; });
      return JSON.stringify({ n: rows.length, said: said.length, first: rows[0] ? rows[0].innerText : "" });
    })()`));
    check("every day header in the picker says the purchase can go with the whole day, in words",
      dayRows.n > 0 && dayRows.said === dayRows.n, `${dayRows.said} of ${dayRows.n}: ${dayRows.first.replace(/\n+/g, " | ")}`);
    await shot("06a-picker-days");
    await tap(cdp, S, `.sh-root:last-of-type [data-pick="event"]`, { label: "an event" });
    await sleep(650);
    const att = await ev(cdp, S, `(() => JSON.stringify({
      chip: (document.querySelector('[data-sp="row-goes"] .sp-opt-v') || {}).textContent || "",
      desc: document.querySelector('[data-f="description"]').value,
      sheets: document.querySelectorAll(".sh-root").length }))()`);
    const A = JSON.parse(att);
    check("the For row says the plan's name", !!A.chip && A.chip !== "A plan or place", A.chip);
    check("…and it filled the EMPTY description with the same name", A.desc === A.chip, A.desc);
    check("the picker closed and the drawer is back", A.sheets === 1);
    // Never overwrite typed text.
    await type(cdp, S, '[data-f="description"]', "Bus tickets");
    await tap(cdp, S, '[data-act="goes"]', { label: "the For row again" });
    await sleep(700);
    await tap(cdp, S, `.sh-root:last-of-type [data-pick="place"]`, { label: "a place" });
    await sleep(650);
    check("a second pick NEVER overwrites a description that has been typed",
      await ev(cdp, S, `document.querySelector('[data-f="description"]').value`) === "Bus tickets");
    await tap(cdp, S, '[data-act="save"]', { label: "Add" });
    await sleep(900);
    const third = await mintedRow(cdp, S);
    check("the attachment reached D1 as a place_id",
      !!d1(`SELECT place_id FROM purchases WHERE id = '${third}'`)[0].place_id ||
      !!(await inStore(cdp, S, `return store.purchase(${JSON.stringify(third)}).place_id`)),
      String(await inStore(cdp, S, `return store.purchase(${JSON.stringify(third)}).place_id`)));
    await tap(cdp, S, `.sp-row[data-id="${third}"]`, { label: "the row with a place" });
    await sleep(650);
    const goesSaid = await ev(cdp, S, `(document.querySelector('[data-sp="row-goes"] .sp-opt-v') || {}).textContent || ""`);
    check("opened again, its For row names the place", !!goesSaid && goesSaid !== "A plan or place", goesSaid);
    await ev(cdp, S, `document.querySelector(".sh-scrim").click()`);
    await sleep(600);
    await shot("07-attached");

    // ── 6. settle up ───────────────────────────────────────────────────────────────────
    section("6. settle up — net balances, then the fewest transfers");
    // A purchase between TWO people in a currency nobody else has used: the by-currency
    // block for it must list those two and nobody else.
    const pair = [me, (members.find((m) => m.id !== me) || {}).id];
    await tap(cdp, S, "#rt-fixed .fab", { label: "the FAB" });
    await sleep(700);
    await type(cdp, S, ".sp-amtin", "3800");
    const curBefore = (await ev(cdp, S, `document.querySelector('[data-act="cur"]').textContent.trim()`)).slice(-3);
    await tap(cdp, S, '[data-act="cur"]', { label: "the currency control" });
    await tap(cdp, S, '[data-act="pick-cur"][data-code="JPY"]', { label: "JPY in the quick row" });
    await tap(cdp, S, '[data-act="open-split"]', { label: "the Split row" });
    for (const m of members) {
      if (pair.includes(m.id)) continue;
      await tap(cdp, S, `[data-grp="split"] .sp-person[data-id="${m.id}"]`, { label: `drop ${m.id} from the split` });
    }
    await tap(cdp, S, '[data-act="save"]', { label: "Add" });
    await sleep(900);
    const pairId = await mintedRow(cdp, S);
    check("a two-person purchase in yen is in the feed",
      (await inStore(cdp, S, `const p = store.purchase(${JSON.stringify(pairId)}); return p ? p.currency + ":" + p.shares.length : ""`)) === "JPY:2");
    // The drawer opens in the currency used last. Put that back to what it was, through the
    // drawer, so the sections below still type their amounts into the currency they expect.
    await tap(cdp, S, "#rt-fixed .fab", { label: "the FAB" });
    await sleep(700);
    await tap(cdp, S, '[data-act="cur"]', { label: "the currency control" });
    await tap(cdp, S, `[data-act="pick-cur"][data-code="${curBefore}"]`, { label: `${curBefore} in the quick row` });
    await ev(cdp, S, `document.querySelector(".sh-scrim").click()`);
    await sleep(600);
    check(`…and the drawer is back to opening in ${curBefore}`,
      /^[A-Z]{3}$/.test(curBefore) && (await ev(cdp, S, `document.querySelectorAll(".sh-root").length`)) === 0);

    const headChip = JSON.parse(await ev(cdp, S, `(() => {
      const c = document.querySelector('.sp-head select[data-act="display"]');
      const said = c && c.closest(".sp-cur").querySelector(".sp-cur-k");
      return JSON.stringify(c ? { value: c.value, label: c.getAttribute("aria-label") || "", n: c.options.length, says: said ? said.textContent : "",
        before: !!(said && said.getBoundingClientRect().right <= c.getBoundingClientRect().left + 1) } : null);
    })()`));
    check("with two currencies in the feed, the head offers what totals are shown in, as a real menu named for it and saying \"Totals in\" before the code",
      !!headChip && headChip.label === "Totals shown in" && headChip.says === "Totals in" && headChip.before && /^[A-Z]{3}$/.test(headChip.value) && headChip.n >= 2, JSON.stringify(headChip));

    await tap(cdp, S, '#view [data-act="settle"]', { label: "Everyone's balances" });
    await sleep(700);
    const st = await sheetText(cdp, S);
    check("the settle sheet opened", /Settle up/.test(st));
    const stFocus = JSON.parse(await ev(cdp, S, `(() => { const a = document.activeElement;
      return JSON.stringify({ tag: a ? a.tagName : "", inSheet: !!(a && a.closest(".sh-root")),
        act: a && a.dataset ? a.dataset.act || "" : "" }); })()`));
    check("focus starts on the sheet's content, not on the currency chip in its head",
      stFocus.tag === "FORM" && stFocus.inSheet, JSON.stringify(stFocus));
    // With no rates nothing converts out of PEN, so the by-currency
    // view IS the answer rather than a fallback, and the sheet has to SAY so instead of
    // inventing a combined total. That was unconditionally true when this file was written —
    // the comment here used to read "fx_rates is empty locally" — because functions/api/fx.js
    // did not exist. It exists now and fx_rates is populated, so an unconditional assertion
    // tests the branch the data no longer takes and fails on a feature working as intended.
    //
    // Both arms assert, and neither is a shrug: settling combined is WRONG with no rates
    // (it would be inventing a number) and settling by currency alone is a regression once
    // rates exist. Which arm ran is decided by the table, not by hope, and is printed.
    const haveRates = d1("SELECT COUNT(*) AS n FROM fx_rates")[0].n > 0;
    console.log(`        fx_rates holds ${d1("SELECT COUNT(*) AS n FROM fx_rates")[0].n} rate(s) — ` +
                `checking the ${haveRates ? "COMBINED" : "BY-CURRENCY"} arm of §6.5(b)`);
    if (haveRates) {
      check("with rates it settles COMBINED into one currency, and still offers by currency",
        /Combined/.test(st) && /By currency/.test(st) && /spent together/.test(st),
        st.replace(/\n+/g, " | ").slice(0, 200));
    } else {
      check("with no rates it settles BY CURRENCY, honestly",
        (await ev(cdp, S, `(document.querySelector('.sh-root:last-of-type [data-mode="currency"]') || {}).getAttribute?.("aria-checked")`)) === "true",
        st.replace(/\n+/g, " | ").slice(0, 200));
    }
    // Each person's balance: a name and a phrase. Opened, the row says what makes it.
    const bal = await ev(cdp, S, `(() => {
      const rows = [...document.querySelectorAll(".sh-root:last-of-type .sp-block")[0].querySelectorAll(".sp-bal")].map((r) => {
        r.click();
        const why = document.getElementById(r.getAttribute("aria-controls"));
        const out = { name: r.querySelector(".sp-bal-name").textContent, net: r.querySelector(".sp-bal-say").textContent,
          color: getComputedStyle(r.querySelector(".sp-bal-say")).color, sub: why && !why.hidden ? why.textContent : "" };
        r.click();
        return out;
      });
      return JSON.stringify(rows);
    })()`);
    const B = JSON.parse(bal);

    // The two modes, both looked at whichever one the sheet opened in. COMBINED keeps
    // everyone, including the people at zero. BY CURRENCY lists, per block, the people who
    // paid or share something in that currency: somebody outside it is not "even" there.
    const blocksNow = async () => JSON.parse(await ev(cdp, S, `(async () => {
      const { store } = await import("/js/store.js");
      const chip = document.querySelector('.sh-root:last-of-type select[data-act="display"]');
      const involved = (cur) => { const ids = new Set();
        for (const p of store.purchases()) { if (cur && p.currency !== cur) continue;
          if (p.amount_minor > 0) ids.add(p.paid_by);
          for (const s of p.shares || []) if (s.share_minor > 0) ids.add(s.user_id); }
        return ids.size; };
      const rowsOf = (d) => [...d.querySelectorAll(".sp-bal")].map((r) => ({
        say: r.querySelector(".sp-bal-say").textContent, color: getComputedStyle(r.querySelector(".sp-bal-say")).color }));
      const mode = (document.querySelector('.sh-root:last-of-type [data-mode][aria-checked="true"]') || { dataset: {} }).dataset.mode || "";
      const blocks = [];
      for (const d of document.querySelectorAll(".sh-root:last-of-type .sp-block")) {
        const cur = d.dataset.cur || "";
        blocks.push({ cur, rows: rowsOf(d), involved: involved(cur), bars: d.querySelectorAll(".sp-bar").length });
      }
      return JSON.stringify({ mode, chipShown: !!chip,
        chipLabel: chip ? chip.getAttribute("aria-label") || "" : "", blocks });
    })()`));
    const hasModes = await ev(cdp, S, `!!document.querySelector('.sh-root:last-of-type [data-mode="currency"]')`);
    check("two currencies are in the feed, so the sheet offers both ways to settle", hasModes);
    await ev(cdp, S, `document.querySelector('.sh-root:last-of-type [data-mode="currency"]').click()`);
    await sleep(300);
    const byCur = await blocksNow();
    const jpy = byCur.blocks.find((x) => x.cur === "JPY");
    check("BY CURRENCY: each block lists the people in that currency and nobody else",
      byCur.mode === "currency" && byCur.blocks.length >= 2 &&
      byCur.blocks.every((x) => x.cur && x.rows.length === x.involved),
      byCur.blocks.map((x) => `${x.cur} ${x.rows.length}/${x.involved}`).join(", "));
    check("…so the two-person yen block is two rows, not the whole roster",
      !!jpy && jpy.rows.length === 2 && members.length > 2, jpy ? `${jpy.rows.length} rows of ${members.length} members` : "no JPY block");
    check("BY CURRENCY: the head's currency menu is gone, because the sheet is not counted in one currency",
      !byCur.chipShown);
    // Words carry direction, never color: no bars, and "owes" and "is owed" in the same ink.
    const colorsOf = (bl) => new Set(bl.flatMap((x) => x.rows.map((r) => r.color)));
    check("no bars, and every balance's phrase is in one ink, whichever way it goes",
      byCur.blocks.every((x) => x.bars === 0) && colorsOf(byCur.blocks).size === 1,
      JSON.stringify(byCur.blocks.map((x) => x.rows.map((r) => r.say).join(","))));
    await shot("08a-settle-by-currency");
    if (haveRates) {
      await ev(cdp, S, `document.querySelector('.sh-root:last-of-type [data-mode="converted"]').click()`);
      await sleep(300);
      const comb = await blocksNow();
      check("COMBINED: one row per member, EVERYBODY, including the people who are settled",
        comb.mode === "converted" && comb.blocks.length === 1 && comb.blocks[0].rows.length === members.length,
        `${comb.blocks.map((x) => x.rows.length).join("/")} rows of ${members.length}`);
      check("COMBINED: the head's currency menu is back and says what it is",
        comb.chipShown && comb.chipLabel === "Totals shown in", comb.chipLabel);
      check("…and still no bars, one ink", comb.blocks[0].bars === 0 && colorsOf(comb.blocks).size === 1);
    } else {
      console.log("        no rates on this machine: the COMBINED arm cannot be opened (its chip is disabled)");
      check("with no rates the Combined choice is there and disabled, not missing",
        await ev(cdp, S, `document.querySelector('.sh-root:last-of-type [data-mode="converted"]').disabled`));
    }
    check("each balance is a name and a phrase in WORDS: owes / is owed / settled",
      B.length > 0 && B.every((r) => /^(owes?|(is|are) owed) .*\d|^settled$/.test(r.net)), B.map((r) => `${r.name}: ${r.net}`).join(" | ").slice(0, 160));
    check("opened, a balance says what makes it: what they paid and their share, as sentences",
      B.every((r) => /^Paid .+\. Share .+\./.test(r.sub)), B[0] && B[0].sub);
    const trs = await ev(cdp, S, `(() => {
      const t = [...document.querySelectorAll(".sh-root:last-of-type .sp-plan li")].map((r) =>
        r.querySelector(".sp-tr-words").textContent + " " + r.querySelector(".num").textContent + " [" + r.querySelector(".sp-tr-go").textContent + "]");
      const heads = [...document.querySelectorAll(".sh-root:last-of-type .sp-plan-sum")].map((n) => n.textContent);
      return JSON.stringify({ t, heads });
    })()`);
    const T = JSON.parse(trs);
    check("the payments come first, each a sentence in words, an amount and its own Mark paid", T.t.length > 0 &&
      T.t.every((x) => / pays? .+ \[Mark paid\]$/.test(x)), T.t.join(" | ").slice(0, 200));
    check("…followed by '<N> payments settle everyone.' in words",
      T.heads.some((h) => /^(One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+) payments? settles? everyone\.$/.test(h)),
      T.heads.join(" / "));
    check("no paragraph explaining 'net' at the foot",
      !/Net is what you paid/.test(await sheetText(cdp, S)));
    await shot("08-settle");

    // The screen's arithmetic against money.js run under node, on the same rows.
    const forNode = JSON.parse(await inStore(cdp, S, `return JSON.stringify({
      purchases: store.purchases(), ids: store.members().map((m) => m.id) })`));
    const { netBalances, settle } = await import("../public/js/money.js");
    let agree = true, detail = "";
    for (const c of [...new Set(forNode.purchases.map((p) => p.currency))]) {
      const sub = forNode.purchases.filter((p) => p.currency === c);
      const { net } = netBalances(sub, forNode.ids, { to: c, toExp: sub[0].amount_exp, rates: {} });
      const sum = [...net.values()].reduce((a, v) => a + v, 0);
      if (sum !== 0) { agree = false; detail = `${c} nets sum to ${sum}`; }
      const tr = settle(net);
      const nonZero = [...net.values()].filter((v) => v !== 0).length;
      if (nonZero && tr.length > nonZero - 1) { agree = false; detail = `${c}: ${tr.length} transfers`; }
      detail = detail || `${c}: ${tr.length} transfers, nets sum to 0`;
    }
    check("the same rows, run through money.js under node, agree", agree, detail);
    await tap(cdp, S, ".sh-root:last-of-type .sh-x", { label: "close the settle sheet" });
    await sleep(500);

    // ── 7. no signal ───────────────────────────────────────────────────────────────────
    section("7. no signal — the normal case, not the edge case");
    await cdp.send("Network.setBlockedURLs", { urls: ["*/api/*"] }, S);
    await cdp.send("Network.emulateNetworkConditions",
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
    await inStore(cdp, S, `try { await store.refresh(); } catch (e) {} return 1;`);
    await sleep(600);
    check("the store has re-derived 'offline' from a failed request",
      (await inStore(cdp, S, `return store.online() ? 1 : 0`)) === 0);
    const before = await ev(cdp, S, `document.querySelectorAll(".sp-row").length`);
    await tap(cdp, S, "#rt-fixed .fab", { label: "the FAB" });
    await sleep(700);
    await type(cdp, S, ".sp-amtin", "9.90");
    await tap(cdp, S, '[data-act="save"]', { label: "Add" });
    await sleep(700);
    const offline = await ev(cdp, S, `document.querySelectorAll(".sp-row").length`);
    check("a purchase entered with no API appears IMMEDIATELY", offline === before + 1,
      `${before} -> ${offline}`);
    const offId = await mintedRow(cdp, S);
    check("it looks exactly like a synced row — no per-row sync state anywhere (v3 item 4)",
      await ev(cdp, S, `!document.querySelector(".sp-row [class*=pending],.sp-row [class*=queue]")`));
    check("the queue is carrying it", (await inStore(cdp, S, `return store.pending()`)) >= 1,
      `${await inStore(cdp, S, `return store.pending()`)} queued`);
    await shot("09-offline");

    await cdp.send("Network.setBlockedURLs", { urls: [] }, S);
    await inStore(cdp, S, `await store.flush(); return 1;`);
    await sleep(2000);
    check("the queue drained by itself when the radio came back",
      (await inStore(cdp, S, `return store.pending()`)) === 0);
    const offRow = d1(`SELECT amount_minor FROM purchases WHERE id = '${offId}'`);
    check("…and the offline purchase is in D1 with the amount that was typed",
      offRow.length === 1 && offRow[0].amount_minor === 990,
      offRow[0] && String(offRow[0].amount_minor));

    // ── 8. somebody else's row ─────────────────────────────────────────────────────────
    section("8. somebody else's row is read-only, and says who to ask");
    // A row genuinely authored and paid by ANOTHER member: the session cookie is swapped for
    // theirs, the purchase is added through this same drawer, and the cookie is swapped back.
    // Nothing is faked — it is a real POST with a real created_by, and it survives the swap
    // in the mirror because applySnapshot() treats an absent collection as "unchanged"
    // (GET /api/trips/<id> does not carry `purchases` yet; that is the api owner's).
    await signInAs(cdp, S, other.id);
    await reloadTo(cdp, S, "#/split");
    await sleep(2800);
    await waitFor(cdp, S, `document.querySelector(".sp-h1") ? 1 : 0`, { label: "Split as the other member" });
    await waitMe(cdp, S, other.id);
    const asOther = await inStore(cdp, S, `return store.me().id`);
    check("the session is now the other member", asOther === other.id, `${asOther} (${other.name})`);
    await tap(cdp, S, "#rt-fixed .fab", { label: "the FAB" });
    await sleep(700);
    await type(cdp, S, ".sp-amtin", "60.00");
    await type(cdp, S, '[data-f="description"]', "Museum tickets");
    await tap(cdp, S, '[data-act="save"]', { label: "Add" });
    await sleep(900);
    const foreign = await mintedRow(cdp, S);
    await inStore(cdp, S, `await store.flush(); return 1;`);
    await sleep(1400);
    check("their purchase is in D1 with THEIR id as created_by, taken from the cookie",
      (d1(`SELECT created_by FROM purchases WHERE id = '${foreign}'`)[0] || {}).created_by === other.id);

    await signInAs(cdp, S, TRIP_HOST.id);
    await reloadTo(cdp, S, "#/split");
    await sleep(2800);
    await waitFor(cdp, S, `document.querySelector(".sp-row") ? 1 : 0`, { label: "the feed after the swap back" });
    await waitMe(cdp, S, me);
    await sleep(400);
    check("back as me, and their row is still on this phone",
      (await inStore(cdp, S, `return store.me().id`)) === me &&
      (await inStore(cdp, S, `return store.purchase(${JSON.stringify(foreign)}) ? 1 : 0`)) === 1);
    check("store.canEditPurchase() says no to a row that is neither yours nor yours to pay",
      (await inStore(cdp, S, `return store.canEditPurchase(store.purchase(${JSON.stringify(foreign)})) ? 1 : 0`)) === 0);
    await tap(cdp, S, `.sp-row[data-id="${foreign}"]`, { label: "the foreign row" });
    await sleep(650);
    const ro = await ev(cdp, S, `(() => JSON.stringify({
      text: (${SHEET} || {}).innerText || "",
      save: document.querySelectorAll('[data-act="save"]').length,
      del: document.querySelectorAll('[data-act="del"]').length,
      fields: (${SHEET} || document).querySelectorAll("input, select, textarea, .sp-person").length,
      read: ((${SHEET} || document).querySelector(".sp-read") || {}).innerText || "",
      shares: [...((${SHEET} || document).querySelectorAll(".sp-read-shares li"))].map((li) => li.innerText.replace(/\s+/g, " ").trim()) }))()`);
    const R = JSON.parse(ro);
    check("somebody else's purchase opens titled with its own name, not Edit purchase",
      (await ev(cdp, S, `document.querySelector(".sh-root:last-of-type .sh-title").textContent`)) === "Museum tickets");
    check("no Save and no Delete on somebody else's row", R.save === 0 && R.del === 0);
    check("it opens as a read view, not a form: no field to press", R.fields === 0, R.fields);
    check("the read view says the amount, and who paid on which day",
      /60\.00/.test(R.read) && new RegExp(`${other.name} paid on \\w{3}, \\w{3} \\d+`).test(R.read), R.read.replace(/\n+/g, " | ").slice(0, 200));
    check("…and names each person who shares it, with their share, under one line saying how it's split",
      R.shares.length >= 2 && /^Split (evenly|by amount)/.test(R.shares[0]) && R.shares.slice(1).every((x) => /\d+\.\d{2}$/.test(x)), JSON.stringify(R.shares));
    check("and it names who to ask, by the AUTHOR-OR-PAYER rule the API actually enforces",
      new RegExp(`Only ${other.name} can change it\\.`).test(R.text),
      R.text.replace(/\n+/g, " | ").slice(0, 140));
    await shot("10-readonly");
    // The backdrop IS the cancel, on every drawer on this screen (v4 items 16/20).
    await ev(cdp, S, `document.querySelector(".sh-scrim").click()`);
    await sleep(600);
    check("the backdrop dismissed it, which is what cancel means here",
      (await ev(cdp, S, `document.querySelectorAll(".sh-root").length`)) === 0);

    // ── 9. delete, armed ───────────────────────────────────────────────────────────────
    section("9. delete — arm, then confirm, never confirm()");
    await tap(cdp, S, `.sp-row[data-id="${offId}"]`, { label: "the offline purchase" });
    await sleep(650);
    await tap(cdp, S, '[data-act="del"]', { label: "Delete" });
    const armed = await ev(cdp, S, `(() => JSON.stringify({
      label: document.querySelector('[data-act="del"]').textContent.trim(),
      note: (document.querySelector(".sp-armnote") || {}).textContent || "" }))()`);
    check("the first tap ARMS: the LABEL changes and the fill only agrees",
      /Tap again to delete/.test(armed), armed);
    check("…with the consequence spelled out full width above it",
      /Deletes the purchase for everyone\. There's no undo\./.test(armed), armed);
    // On the design system an armed delete is its sentence's color: the same ink as the sentence above it, on that
    // color's own tint (the system's negative), never Save's fill.
    const fills = JSON.parse(await ev(cdp, S, `(() => {
      const del = document.querySelector('[data-act="del"]'), root = del.closest(".ds") || document.body;
      const probe = (v) => { const d = document.createElement("i"); d.style.background = "var(" + v + ")";
        root.append(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; };
      return JSON.stringify({ ink: getComputedStyle(del).color, fill: getComputedStyle(del).backgroundColor,
        save: getComputedStyle(document.querySelector('[data-act="save"]')).backgroundColor,
        note: getComputedStyle(document.querySelector(".sp-armnote")).color, tint: probe("--negative-bg") });
    })()`));
    check("armed, the button is its sentence's color: the same ink as the sentence, on that color's tint, not Save's fill",
      fills.ink === fills.note && fills.fill === fills.tint && fills.fill !== fills.save, JSON.stringify(fills));
    await shot("11-armed");
    await tap(cdp, S, '[data-act="del"]', { label: "Delete again" });
    await sleep(1200);
    check("the second tap deletes and the row leaves the feed",
      (await ev(cdp, S, `!!document.querySelector('.sp-row[data-id="${offId}"]')`)) === false);
    await inStore(cdp, S, `await store.flush(); return 1;`);
    await sleep(1200);
    check("…and it is gone from D1, children first, with no orphaned shares",
      d1(`SELECT id FROM purchases WHERE id = '${offId}'`).length === 0 &&
      d1(`SELECT purchase_id FROM purchase_shares WHERE purchase_id = '${offId}'`).length === 0);

    // ── 9b. reduced motion ─────────────────────────────────────────────────────────────
    section("9b. reduced motion — the screen still works with every animation dead");
    await cdp.send("Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
    const rmBefore = await ev(cdp, S, `document.querySelectorAll(".sp-row").length`);
    await tap(cdp, S, "#rt-fixed .fab", { label: "the FAB" });
    await sleep(700);
    await type(cdp, S, ".sp-amtin", "12.00");
    await tap(cdp, S, '[data-act="save"]', { label: "Add" });
    await sleep(800);
    const rmId = await mintedRow(cdp, S);
    check("a purchase still lands with flip() dead under prefers-reduced-motion",
      (await ev(cdp, S, `document.querySelectorAll(".sp-row").length`)) === rmBefore + 1);
    // No fill:forwards except a departing ghost. A row left holding a transform or
    // a fraction of opacity is an animation that never ran its last frame.
    check("…and no row is left mid-animation, at a transform or an opacity that never resolved",
      await ev(cdp, S, `[...document.querySelectorAll(".sp-row")].every((r) => {
        const cs = getComputedStyle(r);
        return cs.opacity === "1" && (cs.transform === "none" || cs.transform === "matrix(1, 0, 0, 1, 0, 0)");
      })`));
    await cdp.send("Emulation.setEmulatedMedia", { features: [] }, S);

    // ── 10. deep link, and unmount ─────────────────────────────────────────────────────
    section("10. the deep link, and a clean unmount");
    await reloadTo(cdp, S, `#/split/${firstId}`);
    await sleep(2800);
    await waitFor(cdp, S, `document.querySelector(".sh-sheet") ? 1 : 0`, { label: "the deep-linked sheet" });
    check("#/split/:id paints the feed and opens THAT purchase",
      /Edit purchase/.test(await sheetText(cdp, S)) &&
      (await ev(cdp, S, `document.querySelector(".sp-amtin").value`)) === "48.00");
    await ev(cdp, S, `document.querySelector(".sh-scrim").click()`);
    await sleep(500);

    await ev(cdp, S, `location.hash = "#/split/pu_does_not_exist"`);
    await sleep(2000);
    const bad = await ev(cdp, S, `(() => JSON.stringify({
      toast: (document.getElementById("toast") || {}).textContent || "", hash: location.hash }))()`);
    check("an unknown id toasts the spec's sentence and replaces the URL",
      /That purchase isn't on this phone\./.test(bad) && /#\/split$/.test(JSON.parse(bad).hash), bad);

    await ev(cdp, S, `location.hash = "#/"`);
    await sleep(1400);
    const after = await ev(cdp, S, `(() => JSON.stringify({
      fab: document.querySelectorAll('#rt-fixed .fab[aria-label="Add a purchase"]').length,
      fabs: [...document.querySelectorAll("#rt-fixed .fab")].map((n) => n.getAttribute("aria-label")).join("|"),
      sp: document.querySelectorAll(".sp-h1").length,
      toasts: document.querySelectorAll(".toast").length,
      inert: !!document.querySelector("#view[inert]"),
      sheets: document.querySelectorAll(".sh-root").length }))()`);
    const AF = JSON.parse(after);
    // The Agenda, where this lands, has a + of its own ("Add a plan"): that one is the only
    // one there, and Split's is gone.
    check("unmount took the FAB with it — it lives outside `el`, so nothing else would",
      AF.fab === 0 && AF.fabs === "Add a plan", JSON.stringify(AF));
    check("…and there is one message node, the shell's: Split keeps none of its own", AF.toasts === 1, `${AF.toasts}`);
    check("…and left no sheet holding #view inert, which would make the next screen unreachable",
      AF.sheets === 0 && !AF.inert);
    check("the agenda is on screen and working", await ev(cdp, S,
      `document.querySelector("#view").dataset.route === "agenda" && document.querySelector("#view").innerText.length > 40`));

    check("no exception reached the page in the whole run", b.pageErrors.length === 0,
      b.pageErrors.join(" | ") || "clean");

  } finally {
    // Leave D1 the way it was found: children first, the same order every delete in this
    // codebase uses, because D1 enforces the foreign key. BOTH DELETES ARE ONE COMMAND: as two,
    // a passing fault of the local database between them left a purchase with no shares, and
    // nothing said so (the next run of split_store_harness found it). A row that could not be
    // removed is named, never swallowed.
    for (const id of created) {
      try {
        d1(`DELETE FROM purchase_shares WHERE purchase_id = '${id}'; DELETE FROM purchases WHERE id = '${id}'`);
      } catch (e) {
        console.log(`  LEFT BEHIND  purchase ${id} could not be removed: ${String(e.message || e).split("\n")[0].slice(0, 160)}`);
      }
    }
    await b.done();
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (SHOTS) console.log(`screenshots in ${SHOT_DIR}`);
  if (fail) { console.log(`\n${fail} FAILED:`); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
};

run().catch((e) => { console.error("\nFATAL", e); process.exit(1); });

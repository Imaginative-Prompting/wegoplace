#!/usr/bin/env node
/* The WIRING that reaches the Split screen, checked in the browser it ships in.
 *
 *   node scripts/split_wiring_check.mjs            # add --shots to also write PNGs
 *
 * Chrome needs the Bash sandbox disabled (it cannot create its ProcessSingleton socket
 * otherwise), and the launcher (scripts/lib/browser.mjs) starts it only through the queue:
 *   WGP_BASE=http://127.0.0.1:<port> python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> --label <what> -- node <this file>
 *
 * scripts/split_ui_harness.mjs and scripts/split_harness.mjs prove the SCREEN. This file is
 * about getting to it and away from it. Nothing is patched: it boots the app exactly as a
 * phone does, off the files in the repo, and asks four questions:
 *
 *   1. THE ROUTE TABLE. #/split and #/split/:id resolve, to split.js, reporting section
 *      "split", with the feed a ROOT and the purchase page not, and they shadow nothing
 *      (#/settings/credits still resolves, #/splits matches nothing). Every other route still
 *      mounts.
 *   2. SPLIT IS A TAB FOR EVERYONE (the layouts, 16 Nov: the bar is the same six, the tab bar
 *      editor gone). An account carrying a stored layout without Split still has it on the bar: a
 *      real <a href="#/split"> tab of at least 44px whose own tab lights, and More's Sections list
 *      doesn't repeat it; More has no editor. Packing, behind More, is a row there; More stays lit
 *      while it is open, and the row is back when you leave. The account's own saved arrangement
 *      is put back at the end.
 *   3. THE NAVIGATION, BOTH WAYS. Tapping in mounts the screen with no back button on a
 *      section root; leaving takes the FAB and the toast with it and leaves no `inert` behind
 *      on #view or the tab bar (the failure that makes the NEXT screen silently unreachable).
 *      Deep links: #/split/settle, an id this phone has never heard of (which must toast and
 *      bounce, and must NOT re-enter the router mid-mount), and a real purchase created for
 *      the run and deleted out of D1 again.
 *   4. THE PRECACHE, WHICH IS THE ONLY ONE THAT CAN FAIL SILENTLY. sw.js serves the shell
 *      cache-first, so a module that is not named in CORE/EXTRA is absent on an installed
 *      device and a changed one is frozen there. So: the real service worker installs, the
 *      shell cache carries sw.js's VERSION and a planted cache of the version before it is
 *      gone (and so is the cache the Hike tab's data was kept in, while the map's kept
 *      archive stays), /js/split.js and /js/money.js are IN it, and then the radio is cut and the Split
 *      screen is mounted again from the cache alone.
 *
 * Every number below came out of the browser or out of sqlite.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, REPO, appSettled, boot, evalIn, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { TRIP, d1 as gateD1 } from "./lib/gate_trip.mjs";

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

// Runtime.evaluate, retried across the execution-context teardown a reload causes.
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

// A GENUINE cold load at a hash. Page.navigate to a URL differing only in the fragment is a
// SAME-DOCUMENT navigation — Chrome fires hashchange and reloads nothing — so a deep link
// tested that way never tests the cold-entry path it exists for.
async function reloadTo(cdp, S, hash) {
  await ev(cdp, S, `location.hash = ${JSON.stringify(hash)}`);
  await sleep(150);
  await cdp.send("Page.reload", {}, S);
  await sleep(400);
}

const VERSION = (/^const VERSION = "(v\d+)"/m.exec(
  fs.readFileSync(path.join(REPO, "public/sw.js"), "utf8")) || [])[1];
// The version an installed device would be carrying before this one.
const OLD = `v${Number(String(VERSION).slice(1)) - 1}`;

const created = [];   // purchase ids this run made, cleaned out of D1 at the end
let savedLayout = null;      // users.tab_layout as the database held it, put back at the end
let layoutTouched = false;
let meId = "";

const run = async () => {
  if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });
  // reduceMotion FALSE on purpose. The router DEFERS a view's unmount behind the page-slide
  // ghost, and that deferred path is where a screen's own fixed chrome gets left behind —
  // under prefers-reduced-motion there is no ghost and no deferral, so the reduced-motion run
  // is the one that cannot see the bug.
  const b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: false });
  const { cdp, S } = b;
  const shot = async (name) => { if (SHOTS) await b.shot(path.join(SHOT_DIR, `${name}.png`)); };

  try {
    await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });

    // PLANT THE OLD BUNDLE, BEFORE ANY OF THIS REGISTERS A WORKER. A phone that has the app
    // installed is not a fresh profile: it carries the shell cache of the version before, and
    // the whole reason a VERSION bump is mandatory is that a shell asset is otherwise served
    // cache-first out of that cache forever. An empty profile cannot tell a bumped VERSION
    // from an unbumped one. So: a cache named for the previous version with a fake split.js
    // in it, planted on the login page the boot lands on, and section 5 asserts activate()
    // swept it. It has to be here and not there: by section 5 the worker has long since
    // activated, and activate() only runs once.
    const planted = await ev(cdp, S, `(async () => {
      const c = await caches.open("wegoplace-shell-${OLD}");
      await c.put(new Request(new URL("/js/split.js", location.origin).href),
        new Response("/* the stale copy */", { headers: { "content-type": "text/javascript" } }));
      // And the two caches outside the shell's namespace an older phone can carry: the one
      // the Hike tab's data was kept in (nothing reads it now, so activate() lets it go by
      // name) and the map's kept archive (which a sweep must never touch).
      for (const name of ["wgp-shell-live", "wgp-tiles-v1"]) {
        const o = await caches.open(name);
        await o.put(new Request(new URL("/planted-by-the-check", location.origin).href), new Response("planted"));
      }
      return (await caches.keys()).join(" ");
    })()`);
    console.log(`        planted a ${OLD} shell cache on an empty profile: ${planted}`);

    // ══════════════════════════════════════════════════════════════════════════════════════
    section("1. the route table, read out of the real router.js");
    // ══════════════════════════════════════════════════════════════════════════════════════
    await cdp.send("Page.navigate", { url: BASE + `/t/${TRIP}/#/settings` }, S);
    await appSettled(cdp, S);
    await waitFor(cdp, S, `document.querySelector("#view") ? 1 : 0`, { label: "app shell" });
    const me = await waitFor(cdp, S,
      `(async () => { const { store } = await import("/js/store.js"); const m = store.me(); return m && m.id ? m.id : 0; })()`,
      { label: "store.ready() + /api/me" });
    meId = me;
    console.log(`        signed in as ${me}, sw.js says VERSION = ${VERSION}`);

    // ROUTES is exported, and the shell already imported this module, so this is the very
    // table the router is dispatching on — not a second parse of the file.
    const rows = JSON.parse(await ev(cdp, S, `(async () => {
      const m = await import("/js/router.js");
      return JSON.stringify(m.ROUTES.filter((r) => String(r.mod).includes("split.js"))
        .map((r) => ({ re: String(r.re), name: r.name, tab: r.tab, root: r.root, mod: r.mod, keys: r.keys, title: r.title })));
    })()`));
    check("router.js carries exactly two split routes", rows.length === 2,
      rows.map((r) => `${r.re} -> ${r.name}`).join("  "));
    const feed = rows.find((r) => r.name === "split") || {};
    const one = rows.find((r) => r.name === "purchase") || {};
    // `tab:` NAMES THE SECTION NOW, not a bar slot. tabs.js's tabFor() decides which tab
    // lights: Split's own if the person keeps it in the bar, otherwise Other. So this reads
    // "split" whether or not Split is currently a tab — and section 3 below asserts the tab
    // that actually lights, which is the behaviour that matters.
    check('#/split      name "split", mod ./split.js, section "split", root TRUE',
      feed.mod === "./split.js" && feed.tab === "split" && feed.root === true && feed.title === "Split",
      `tab=${feed.tab} root=${feed.root} title=${feed.title}`);
    check('#/split/:id  name "purchase", section "split", root FALSE, keys ["id"]',
      one.mod === "./split.js" && one.tab === "split" && one.root === false &&
      JSON.stringify(one.keys) === '["id"]' && one.title === "Purchase",
      `tab=${one.tab} root=${one.root} keys=${JSON.stringify(one.keys)} title=${one.title}`);

    // parse() is the function that actually decides, so ask IT rather than eyeballing regexes.
    const p = JSON.parse(await ev(cdp, S, `(async () => {
      const m = await import("/js/router.js");
      const at = (h) => { const r = m.parse(h); return r ? { name: r.name, id: r.params.id || null } : null; };
      return JSON.stringify({
        split: at("#/split"), slash: at("#/split/"), id: at("#/split/pu_abc"),
        settle: at("#/split/settle"), deep: at("#/split/pu_a/b"),
        splits: at("#/splits"), credits: at("#/settings/credits"), settings: at("#/settings"),
      });
    })()`));
    check("#/split and #/split/ both resolve to the feed",
      p.split && p.split.name === "split" && p.slash && p.slash.name === "split");
    check("#/split/:id hands split.js the id", p.id && p.id.name === "purchase" && p.id.id === "pu_abc");
    check('#/split/settle is a route, not a 404 — the reserved id split.js owns',
      p.settle && p.settle.name === "purchase" && p.settle.id === "settle");
    check("a slash inside the id survives (encodeURIComponent round-trips it)",
      p.deep && p.deep.id === "pu_a/b", JSON.stringify(p.deep));
    check("#/splits matches NOTHING — the anchored pattern did not widen", p.splits === null);
    check("#/settings/credits and #/settings still resolve to settings.js",
      p.credits && p.credits.name === "credits" && p.settings && p.settings.name === "settings");

    // ══════════════════════════════════════════════════════════════════════════════════════
    section("1b. every OTHER route still mounts");
    // ══════════════════════════════════════════════════════════════════════════════════════
    // The route table is the one file in this build that every screen in the app depends on.
    // A regression here does not look like a bug in Split, it looks like the Places tab being
    // dead, so it is checked here rather than assumed.
    const ids = JSON.parse(await inStore(cdp, S, `return JSON.stringify({
      place: (store.places()[0] || {}).id || "", event: (store.events()[0] || {}).id || "" })`));
    // #/map expects "places", and that is not a typo: since V3 item 16 map.js's mount does
    // router.replace("#/places?view=map") on the next tick — the map is a view mode inside
    // Places and #/map is the legacy alias that forwards to it. Asserted here in the shape it
    // actually has, so this line is a regression guard and not a wish.
    const walk = [
      ["#/", "agenda"], ["#/places", "places"], [`#/p/${ids.place}`, "place"], ["#/map", "places"],
      ["#/pack", "pack"], ["#/memories", "memories"], [`#/e/${ids.event}`, "event"],
      ["#/settings/credits", "credits"], ["#/settings", "settings"],
    ];
    const bad = [];
    for (const [hash, name] of walk) {
      await ev(cdp, S, `location.hash = ${JSON.stringify(hash)}`);
      try {
        await waitFor(cdp, S, `document.querySelector("#view").dataset.route === ${JSON.stringify(name)} ? 1 : 0`,
          { timeout: 12000, label: `${hash} -> ${name}` });
      } catch { bad.push(`${hash} did not mount ${name}`); }
      await sleep(120);
    }
    check("all nine other routes mount the screen they always did",
      bad.length === 0, bad.join("; ") || walk.map(([h]) => h).join(" "));
    check("…and none of them threw", b.pageErrors.length === 0, b.pageErrors.join(" | ") || "clean");

    // ══════════════════════════════════════════════════════════════════════════════════════
    section("2. Split in the tab bar, for everyone, and no second door in More");
    // ══════════════════════════════════════════════════════════════════════════════════════
    // The bar is the same six for everyone (the layouts, 16 Nov): the tab bar editor is gone and a
    // layout an account stored with it is no longer read. What is in the database is read first and
    // written back in the finally, byte for byte. The account is given a stored layout WITHOUT
    // Split (what somebody who had taken it off the bar carries), and the bar still has it.
    savedLayout = d1(`SELECT tab_layout FROM users WHERE id = '${me}'`)[0].tab_layout;
    layoutTouched = true;
    const FIVE = ["agenda", "places", "split", "memories", "chat"];
    const HIDDEN = ["agenda", "places", "memories", "other"];
    await inStore(cdp, S, `await store.setTabLayout(${JSON.stringify(HIDDEN)}); return 1;`);
    await reloadTo(cdp, S, "#/settings");
    await waitFor(cdp, S, `document.querySelector("#view #st-sections") ? 1 : 0`, { label: "More" });
    await sleep(500);
    const look = async () => JSON.parse(await ev(cdp, S, `(() => {
      const t = document.querySelector('.tabbar .tab[data-tab="split"]');
      const tr = t ? t.getBoundingClientRect() : null;
      return JSON.stringify({
        bar: [...document.querySelectorAll(".tabbar .tab")].map((a) => a.dataset.tab),
        tab: t ? { tag: t.tagName, href: t.getAttribute("href"), label: t.textContent.trim(),
          w: Math.round(tr.width), h: Math.round(tr.height), op: getComputedStyle(t).opacity } : null,
        links: [...document.querySelectorAll("#view #st-sections a")].map((a) => a.getAttribute("href")),
        heads: [...document.querySelectorAll("#view .st-label")].map((h) => h.textContent.trim()),
        editor: !!document.querySelector("#st-tabedit, #st-tbar, .st-grip"),
      });
    })()`));
    const goTo = async (how, sel, route, mark) => {
      const before = await ev(cdp, S, `document.querySelectorAll("#rt-fixed > *").length`);
      await ev(cdp, S, `document.querySelector(${JSON.stringify(sel)}).click()`);
      await waitFor(cdp, S, `document.querySelector(${JSON.stringify(mark)}) ? 1 : 0`, { label: `the ${route} screen` });
      await sleep(500);                                 // let the crossfade land and finishAnim run
      const on = JSON.parse(await ev(cdp, S, `JSON.stringify({
        hash: location.hash,
        route: document.querySelector("#view").dataset.route,
        lit: [...document.querySelectorAll(".tab[aria-current='page']")].map((t) => t.dataset.tab).join() || (document.querySelector(".head-more[aria-current='page']") ? "more" : ""),
        back: document.getElementById("backbtn").hidden,
        bodyBack: document.body.dataset.back,
        fab: document.querySelectorAll("#rt-fixed .fab").length,
      })`));
      check(`${how}: the tap navigated to #/${route} and mounted its screen`,
        on.hash === `#/${route}` && on.route === route, `${on.hash} route=${on.route}`);
      check(`${how}: no back button on a section root, so the bar is the way out`,
        on.back === true && on.bodyBack === "0", `hidden=${on.back} body[data-back]=${on.bodyBack}`);
      check(`${how}: the screen's FAB is in the router's fixed layer`, on.fab === 1);
      // LEAVING. The router defers the unmount behind the slide, so this is the path where a
      // view's own fixed chrome, or an open sheet's `inert` on #view and .tabbar, gets left
      // on screen for the NEXT view to be trapped under.
      await ev(cdp, S, `document.querySelector('.head-more').click()`);
      await waitFor(cdp, S, `document.querySelector("#view").dataset.route === "settings" ? 1 : 0`,
        { label: "back on More" });
      await sleep(700);                                 // past SLIDE_MS + finishAnim's deferral
      const after = JSON.parse(await ev(cdp, S, `JSON.stringify({
        fab: document.querySelectorAll(".fab").length,
        toast: document.querySelectorAll(".toast").length,
        sheets: document.querySelectorAll(".sh-root").length,
        inertView: document.getElementById("view").hasAttribute("inert"),
        inertTabs: document.querySelector(".tabbar").hasAttribute("inert"),
        fixed: document.querySelectorAll("#rt-fixed > *").length,
      })`));
      check(`${how}: leaving took the FAB with it, and the one message node is the shell's`,
        after.fab === 0 && after.toast === 1, `fab=${after.fab} toast=${after.toast}`);
      check(`${how}: no sheet and no \`inert\` left on #view or the tab bar`,
        after.sheets === 0 && !after.inertView && !after.inertTabs);
      check(`${how}: the fixed layer is back to what it held before`, after.fixed === before,
        `${after.fixed} vs ${before}`);
      return on;
    };

    const a = await look();
    await shot("wiring-more-split-in-bar");
    check("an account that had taken Split off the bar still has the five, Split in it", a.bar.join() === FIVE.join(), a.bar.join(" · "));
    check("the Split tab is a real <a href='#/split'> that says Split",
      !!a.tab && a.tab.tag === "A" && a.tab.href === "#/split" && a.tab.label === "Split", JSON.stringify(a.tab));
    check("§8.2 the tab is a tap target of at least 44px each way", !!a.tab && a.tab.w >= 44 && a.tab.h >= 44,
      a.tab && `${a.tab.w}x${a.tab.h}px`);
    check("§8.1 the tab is not quieted with opacity", !!a.tab && a.tab.op === "1", a.tab && a.tab.op);
    check("More's list doesn't repeat it, and holds what isn't on the bar: Packing, Changes",
      !a.links.includes("#/split") && a.links.includes("#/pack") && a.links.includes("#/changes"), a.links.join(" "));
    check("the tab bar editor is gone from More: no heading, no rows, no handles",
      !a.editor && a.heads.join() === "This trip,You,Appearance,This app", a.heads.join(" · "));
    const onTab = await goTo("Split from its tab", '.tabbar .tab[data-tab="split"]', "split", ".sp-h1");
    check("Split from its tab: Split's own tab is the one that lights", onTab.lit === "split", `lit: ${onTab.lit}`);
    await shot("wiring-split-tab");
    check("no exception reached the page", b.pageErrors.length === 0, b.pageErrors.join(" | ") || "clean");

    // ══════════════════════════════════════════════════════════════════════════════════════
    section("3. Packing, behind More: a row there, with More (your picture) current");
    // ══════════════════════════════════════════════════════════════════════════════════════
    const onRow = await goTo("Packing from its row", '#view #st-sections a[href="#/pack"]', "pack", "#view[data-route='pack']");
    check("Packing from its row: no tab lights, your picture (More) is current, as Packing isn't on the bar", onRow.lit === "more", `lit: ${onRow.lit}`);
    check("…and the row is on screen again after leaving",
      await ev(cdp, S, `!!document.querySelector('#view #st-sections a[href="#/pack"]')`));
    check("no exception reached the page", b.pageErrors.length === 0, b.pageErrors.join(" | ") || "clean");

    // ══════════════════════════════════════════════════════════════════════════════════════
    section("4. deep links — the reason #/split/:id exists at all");
    // ══════════════════════════════════════════════════════════════════════════════════════
    // A REAL PURCHASE FIRST, and it has to come first for a reason worth writing down: this
    // phone's feed is EMPTY however many rows are in D1, because GET /api/trips/<id> does not carry
    // `purchases` yet (the api owner's, and BUILD 3 flagged it). openSettle() correctly draws
    // nothing over an empty feed, so a settle deep link tested on a fresh phone would be
    // testing that. One row, made through the store, makes every deep link below real.
    const members = JSON.parse(await inStore(cdp, S,
      `return JSON.stringify(store.members().map((m) => m.id))`));
    const made = JSON.parse(await inStore(cdp, S, `
      const row = await store.addPurchase({ description: "Wiring check", amount_minor: 1234,
        currency: "PEN", amount_exp: 2,
        shares: ${JSON.stringify(members.map((id) => ({ user_id: id, weight: 1 })))} });
      return JSON.stringify(row);`));
    created.push(made.id);
    await waitFor(cdp, S, `(async () => { const { store } = await import("/js/store.js");
      return store.pending() === 0 ? 1 : 0; })()`, { label: "the queue draining" });
    await reloadTo(cdp, S, `#/split/${made.id}`);
    await waitFor(cdp, S, `document.querySelector(".sh-root") ? 1 : 0`, { label: "the purchase drawer" });
    // The description is an <input>, so it lives in .value and not in innerText — asserting
    // on the drawer's text would pass on any drawer at all.
    const drawer = JSON.parse(await ev(cdp, S, `JSON.stringify({
      head: ((document.querySelector(".sh-sheet") || {}).innerText || "").split("\\n")[0],
      desc: (document.querySelector('.sh-sheet [data-f="description"]') || {}).value || "",
      sheets: document.querySelectorAll(".sh-root").length,
    })`));
    check("#/split/<a real id> cold-opens THAT purchase's drawer",
      drawer.desc === "Wiring check" && drawer.sheets === 1,
      `${drawer.head} · description="${drawer.desc}"`);
    // In-app, with a page behind it, the detail route DOES offer back — and names where to.
    const backTo = await ev(cdp, S, `(() => {
      const b = document.getElementById("backbtn");
      return JSON.stringify({ hidden: b.hidden, label: b.getAttribute("aria-label") });
    })()`).then(JSON.parse);
    console.log(`        cold entry on #/split/:id — back button hidden=${backTo.hidden} (nothing behind it yet)`);
    await ev(cdp, S, `location.hash = "#/split"`);
    await sleep(300);
    await ev(cdp, S, `location.hash = "#/split/${made.id}"`);
    await sleep(500);
    const pushed = JSON.parse(await ev(cdp, S, `(() => {
      const b = document.getElementById("backbtn");
      return JSON.stringify({ hidden: b.hidden, label: b.getAttribute("aria-label") });
    })()`));
    check("pushed onto #/split/:id, back appears and names the Split feed",
      pushed.hidden === false && /Back to Split/.test(pushed.label || ""), JSON.stringify(pushed));

    // The reserved id, as a genuine COLD load, now that the feed has something to settle.
    await reloadTo(cdp, S, "#/split/settle");
    await waitFor(cdp, S, `document.querySelector(".sh-root") ? 1 : 0`, { label: "the settle sheet" });
    const settle = JSON.parse(await ev(cdp, S, `JSON.stringify({
      route: document.querySelector("#view").dataset.route,
      hash: location.hash,
      text: (document.querySelector(".sh-sheet") || {}).innerText || "",
    })`));
    check("#/split/settle cold-opens the settle-up sheet over the feed",
      settle.route === "purchase" && /settle up/i.test(settle.text),
      settle.text.split("\n").slice(0, 2).join(" · "));
    await shot("wiring-settle");

    // An id this phone has never heard of. This is the one that used to re-enter the router
    // from inside mount(); it must toast, replace the URL, and leave ONE live screen.
    await ev(cdp, S, `location.hash = "#/split/pu_not_on_this_phone"`);
    await waitFor(cdp, S, `location.hash === "#/split" ? 1 : 0`, { label: "the bounce back to #/split" });
    // The settle sheet that was open leaves with its own exit transition: wait for it to be
    // gone (it has 3 s) rather than for a fixed moment, then count what is left.
    const t0 = Date.now();
    let sheetGone = false;
    while (Date.now() - t0 < 3000 && !sheetGone) {
      await sleep(100);
      sheetGone = !(await ev(cdp, S, `document.querySelectorAll(".sh-root").length`));
    }
    const sheetMs = Date.now() - t0;
    const bounced = JSON.parse(await ev(cdp, S, `JSON.stringify({
      toast: (document.getElementById("toast") || {}).textContent || "",
      views: document.querySelectorAll("#view .sp").length,
      route: document.querySelector("#view").dataset.route,
      sheets: document.querySelectorAll(".sh-root").length,
    })`));
    check("an unknown purchase id toasts and replaces the URL with #/split",
      /isn't on this phone/.test(bounced.toast), bounced.toast || "(no toast)");
    check("…and leaves exactly one live screen behind, not two",
      bounced.views === 1 && bounced.route === "split" && bounced.sheets === 0,
      `${bounced.views} × .sp, route=${bounced.route}, ${bounced.sheets} sheets (the open sheet was gone ${sheetGone ? "within " + sheetMs + " ms" : "never"})`);

    const inD1 = d1(`SELECT id FROM purchases WHERE id = '${made.id}'`);
    check("the row this run made really reached D1 (so the delete below proves something)",
      inD1.length === 1, made.id);
    await inStore(cdp, S, `await store.deletePurchase(${JSON.stringify(made.id)}); return 1;`);
    await waitFor(cdp, S, `(async () => { const { store } = await import("/js/store.js");
      return store.pending() === 0 ? 1 : 0; })()`, { label: "the delete draining" });
    const goneRow = d1(`SELECT COUNT(*) AS n FROM purchases WHERE id = '${made.id}'`)[0].n;
    const goneShares = d1(`SELECT COUNT(*) AS n FROM purchase_shares WHERE purchase_id = '${made.id}'`)[0].n;
    check("…and D1 is left exactly as it was found — row and shares both gone",
      goneRow === 0 && goneShares === 0, `purchases=${goneRow} shares=${goneShares}`);
    if (goneRow === 0) created.pop();

    // ══════════════════════════════════════════════════════════════════════════════════════
    section("5. the service worker — the half that fails silently");
    // ══════════════════════════════════════════════════════════════════════════════════════
    // Everything above ran with Network.setBypassServiceWorker, which is how a harness avoids
    // testing stale JS — and is also why no harness in this repo has ever seen whether a new
    // module is in the precache at all. Let the real worker install now.
    await cdp.send("Network.setBypassServiceWorker", { bypass: false }, S);
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: false }, S);
    // A RELOAD, not a Page.navigate to another hash. The document on screen was loaded while
    // the worker was bypassed, so it has no controller and never will: a navigation that only
    // changes the fragment is same-document, and nothing is re-fetched. This is the same trap
    // reloadTo() exists for, one layer down.
    await reloadTo(cdp, S, "#/");
    await waitFor(cdp, S, `navigator.serviceWorker.controller ? 1 : 0`,
      { timeout: 40000, label: "a service worker taking control" });
    // install() precaches CORE, then EXTRA, then crawls. Wait for the last of the four files
    // this build cares about rather than for a fixed number of seconds.
    const cacheState = await waitFor(cdp, S, `(async () => {
      const c = await caches.open("wegoplace-shell-${VERSION}").catch(() => null);
      if (!c) return 0;
      const need = ["/js/split.js", "/js/money.js", "/js/router.js", "/js/settings.js"];
      const hit = [];
      for (const u of need) if (await c.match(new URL(u, location.origin).href)) hit.push(u);
      return hit.length === need.length ? JSON.stringify(hit) : 0;
    })()`, { timeout: 60000, label: "split.js + money.js in the shell cache" });
    check(`the shell cache is wegoplace-shell-${VERSION} and holds every file this build added`,
      !!cacheState, cacheState);
    const keys = await ev(cdp, S, `caches.keys().then((k) => k.join(" "))`);
    check(`the planted ${OLD} shell cache is GONE — the bump is what makes a device let go of it`,
      !keys.split(" ").includes(`wegoplace-shell-${OLD}`), keys);
    check("the cache the Hike tab's data was kept in is gone too, and the map's kept archive is not touched",
      !keys.split(" ").includes("wgp-shell-live") && keys.split(" ").includes("wgp-tiles-v1"), keys);
    const running = await ev(cdp, S, `(async () => {
      const w = navigator.serviceWorker.controller;
      return await new Promise((res) => {
        const ch = new MessageChannel();
        const t = setTimeout(() => res("no answer"), 2000);
        ch.port1.onmessage = (e) => { clearTimeout(t); res((e.data && e.data.version) || "?"); };
        w.postMessage({ type: "app/version" }, [ch.port2]);
      });
    })()`);
    check(`the worker actually running on this device reports ${VERSION}`, running === VERSION, running);
    const bytes = await ev(cdp, S, `(async () => {
      const c = await caches.open("wegoplace-shell-${VERSION}");
      const out = {};
      for (const u of ["/js/split.js", "/js/money.js", "/js/router.js", "/js/settings.js"]) {
        const r = await c.match(new URL(u, location.origin).href);
        const t = r ? await r.text() : "";
        out[u] = t.length;
      }
      const r = await c.match(new URL("/js/router.js", location.origin).href);
      out.routerHasSplit = /split\\.js/.test(await r.text());
      return JSON.stringify(out);
    })()`).then(JSON.parse);
    check("the CACHED router.js is the one with the split routes in it, not a stale copy",
      bytes.routerHasSplit === true && bytes["/js/split.js"] > 10000,
      `split.js ${bytes["/js/split.js"]}B · money.js ${bytes["/js/money.js"]}B · router.js ${bytes["/js/router.js"]}B`);

    // THE PROOF THE PRECACHE LINE EXISTS FOR. Cut the radio and open Split anyway.
    await cdp.send("Network.emulateNetworkConditions",
      { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, S);
    await cdp.send("Page.reload", {}, S);
    await sleep(600);
    await waitFor(cdp, S, `document.querySelector("#view") ? 1 : 0`,
      { timeout: 30000, label: "the shell booting with no network" });
    const dead = await ev(cdp, S, `(async () => {
      try { await fetch("/api/trips/${TRIP}", { cache: "no-store" }); return "reached the server"; }
      catch { return "dead"; }
    })()`);
    check("the radio really is off (/api/* is network-only and it threw)", dead === "dead", dead);
    await ev(cdp, S, `location.hash = "#/split"`);
    await waitFor(cdp, S, `document.querySelector(".sp-h1") ? 1 : 0`,
      { timeout: 20000, label: "Split, from the cache alone" });
    const offline = JSON.parse(await ev(cdp, S, `JSON.stringify({
      route: document.querySelector("#view").dataset.route,
      rules: (document.getElementById("sp-styles") || { sheet: { cssRules: [] } }).sheet.cssRules.length,
      net: document.body.dataset.net,
    })`));
    check("WITH NO NETWORK AT ALL, #/split mounts from the shell cache",
      offline.route === "split" && offline.rules > 70,
      `route=${offline.route}, ${offline.rules} CSS rules, body[data-net]=${offline.net}`);
    await shot("wiring-offline-split");
    await cdp.send("Network.emulateNetworkConditions",
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
  } finally {
    // The account's own tab arrangement, exactly as the database held it before the run. The
    // page's queue is drained first so a late write cannot land on top of this.
    if (layoutTouched && meId) {
      try {
        await inStore(cdp, S, `try { await store.flush(); } catch (e) {} return 1;`).catch(() => {});
        d1(`UPDATE users SET tab_layout = ${savedLayout === null ? "NULL" : `'${String(savedLayout).replace(/'/g, "''")}'`} WHERE id = '${meId}'`);
        const now = d1(`SELECT tab_layout FROM users WHERE id = '${meId}'`)[0].tab_layout;
        check("the account's tab arrangement is back to what the database held before the run",
          now === savedLayout, `${JSON.stringify(savedLayout)} -> ${JSON.stringify(now)}`);
      } catch (e) { check("the account's tab arrangement is back to what the database held before the run", false, e.message); }
    }
    for (const id of created) {
      try {
        d1(`DELETE FROM purchase_shares WHERE purchase_id = '${id}'`);
        d1(`DELETE FROM purchases WHERE id = '${id}'`);
        console.log(`  (cleaned ${id} out of D1)`);
      } catch (e) { console.log(`  COULD NOT CLEAN ${id}: ${e.message}`); }
    }
    await b.done();
  }
};

run().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error("\nHARNESS ERROR:", e);
  process.exit(2);
});

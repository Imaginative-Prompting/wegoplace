#!/usr/bin/env node
/* MORE, ON THE DESIGN SYSTEM (flow 7, chat-more-mock.html), in a browser on the gate's made-up trip as its host.
 *
 *   node scripts/gate.mjs --only more_check
 *
 * It holds:
 *   1. THE PAGE: titled More, your picture in its head's end (on a phone); the trip's name and its dates; you (your
 *      name and face, to Your account); then two groups: This trip (Packing, Changes, People and settings) and You
 *      (AI apps, Your trips). Each row a full-width line at least 52 px tall, its name clear of what it holds.
 *   2. WHAT EACH ROW HOLDS, read from elsewhere: Packing's "N of M packed" is the count Packing itself shows for your
 *      things; People is the trip's members; AI apps and Your trips are what the account's own pages are told; Changes
 *      says "New" (with its dot) while the shell marks something new, and nothing when it doesn't.
 *   3. APPEARANCE: System, Light, Dark as one switch; each press puts that look on the page at once and stores it.
 *   4. THIS APP: Connection and Location say their state in words; Version is the running worker's (the one sw.js
 *      names); Credits and Privacy and terms go to pages that are there.
 *   5. ONE PLACE FOR YOUR FACE: no "Your color" row (25 Nov: your color is your picture's background, picked in its
 *      sheet on Your account); the row with your name and face says so and goes to Your account.
 *   6. AT 320 AND 1440: nothing runs off the side; at 1440 your picture is the rail's, not the head's.
 *   7. BACK FROM EVERY PAGE MORE OPENS (21 Nov: they could only be left with a swipe): People and settings, Your trips,
 *      Your account, Privacy and terms each show the one Back (js/page-back.js) on screen, and it returns to More;
 *      scrolled to its end, each page's last control is clear of the Back (its foot keeps room); Changes and the credits
 *      show the app's own dock Back. (AI apps opens the one Connect your AI sheet in the trip: there is no page to leave.)
 *   8. YOUR WHOLE NAME (21 Nov: "shrink to fit before wrap"): a long name on More's row shrinks onto one line (no smaller
 *      than 14 px) and shows whole, never cut; the name it had is put back.
 *   9. NO PAGE ERRORS.
 *
 * PLANTED (MORE_PLANT=<name>; each serves one file changed, never writes one):
 *   packcount  pack-count.js counts every carried thing as packed: 1 red (2, Packing).
 *   nonew      settings.js without its watch on the shell's mark: 1 red (2, Changes).
 *   flat       styles.css without More's row rule: 2 red (1's row heights, 6's 320).
 *   staleme    store.js not recoloring you when you pick (no applyNoteColor): 1 red (5, the faces keep the color before).
 *   nofit      settings.js without fitting your name: 1 red (8, it wraps at its full size).
 *   noroom     styles.css without the room a page keeps at its foot for its Back: 7 red (a last control under the Back).
 */
import fs from "node:fs";
import { BASE, boot, evalIn, waitFor, sleep, appSettled } from "./lib/standalone_cdp.mjs";
import { tripPath, tripApi, TRIP, TRIP_NAME, HOST } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const PLANT = process.env.MORE_PLANT || "";
const PLANTS = { packcount: "js/pack-count.js", nonew: "js/settings.js", flat: "styles.css", staleme: "js/store.js", nofit: "js/settings.js", noroom: "styles.css" };
if (PLANT && !PLANTS[PLANT]) throw new Error(`MORE_PLANT is one of ${Object.keys(PLANTS).join(", ")}`);
const PLANTED = PLANT ? (() => {
  const src = read(`public/${PLANTS[PLANT]}`);
  const t = PLANT === "packcount" ? src.replace("    if (S.packTicked(r.id, list.key, day)) done++;\n", "    done++;\n")
    : PLANT === "nonew" ? src.replace('  marks.observe(document.documentElement, { attributes: true, attributeFilter: ["data-changes-new"] });\n', "")
    : PLANT === "nofit" ? src.replace("    requestAnimationFrame(() => fitName(nameEl));          // your whole name: smaller before it wraps\n", "")
    : PLANT === "staleme" ? src.replace("  applyNoteColor(me.id, hex);\n", "")
    : PLANT === "noroom" ? src.replace(/\nbody\[data-page-dock="1"\] \{[^}]*\}/, "")
    : src.replace(/\n\.st-list \.st-row \{[^}]*\}/, "");
  if (t === src) throw new Error(`the ${PLANT} plant didn't take`);
  return t;
})() : null;
const VERSION = (read("public/sw.js").match(/^const VERSION = "(v\d+)";/m) || [])[1];

const b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: true });
const { cdp, S } = b;
const J = async (e) => JSON.parse(await evalIn(cdp, S, e));
const ev = (e) => evalIn(cdp, S, e);
if (PLANTED) {
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: PLANTS[PLANT].endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }],
    body: Buffer.from(PLANTED).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*/${PLANTS[PLANT]}*` }] }, S);
  console.log(`PLANTED: ${PLANT} (${PLANTS[PLANT]})`);
}
const size = async (w, h, dsf = 2) => {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dsf, mobile: w < 1000 }, S);
  await sleep(300);
};
const go = async (hash, mark) => {
  await cdp.send("Page.navigate", { url: "about:blank" }, S);
  await sleep(100);
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath(hash)}` }, S);
  await appSettled(cdp, S).catch(() => {});
  await waitFor(cdp, S, `${mark} ? 1 : 0`, { label: hash, timeout: 30000 });
  await sleep(500);
};
const MORE = `document.querySelector("#view .st-more #st-sections")`;
const rowsOf = `[...document.querySelectorAll("#view #st-sections .st-row")].map((a) => { const r = a.getBoundingClientRect(), t = a.querySelector(".ds-item-title").getBoundingClientRect();
  const h = a.querySelector(".st-hold"), hr = h.getBoundingClientRect(), list = a.parentElement.getBoundingClientRect();
  return { name: a.querySelector(".ds-item-title").textContent.trim(), href: a.getAttribute("href"), id: a.id || null, h: Math.round(r.height),
    full: Math.abs(r.width - list.width) <= 1, clear: t.right <= hr.left + 0.5 || !h.innerText.trim(), note: (a.querySelector("[data-note]") || {}).textContent ?? null }; })`;

try {
  await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }] }, S);

  section("1. The page");
  await go("#/settings", MORE);
  const top = await J(`JSON.stringify((() => { const h = document.querySelector("#view .ds-head"), you = document.querySelector("#view [data-st-you]"), y = you.getBoundingClientRect();
    return { title: h.querySelector("h1").textContent.trim(), picture: !!h.querySelector(".ds-head-end .head-more"),
      trip: document.querySelector("#view .st-tripname").textContent.trim(), when: document.querySelector("#view #st-trip .ds-meta").textContent.trim(),
      you: { name: you.querySelector("[data-st-name]").textContent.trim(), href: you.getAttribute("href"), face: !!you.querySelector(".ds-face.ds-face--44"), h: Math.round(y.height) } }; })())`);
  check("titled More, with your picture in its head's end", top.title === "More" && top.picture, JSON.stringify(top));
  check("the trip's name, then its dates in words", top.trip === TRIP_NAME && top.when.length > 4 && !/NaN|Invalid|undefined/.test(top.when), JSON.stringify([top.trip, top.when]));
  check("you: your name and your face, to Your account", top.you.name === HOST.name && top.you.href === "/account" && top.you.face && top.you.h >= 44, JSON.stringify(top.you));
  const rows = await J(`JSON.stringify(${rowsOf})`);
  const heads = await J(`JSON.stringify([...document.querySelectorAll("#view #st-sections .st-label")].map((h) => h.textContent.trim()))`);
  check("two groups: This trip (Packing, Changes, People and settings), You (AI apps, Your trips)",
    heads.join() === "This trip,You" && rows.map((r) => r.name).join() === "Packing,Changes,People and settings,AI apps,Your trips", JSON.stringify({ heads, rows: rows.map((r) => r.name) }));
  check("each row the list's width and at least 52 px tall", rows.every((r) => r.full && r.h >= 52), JSON.stringify(rows.map((r) => [r.name, r.h, r.full])));
  check("each row's name clear of what it holds", rows.every((r) => r.clear), JSON.stringify(rows.filter((r) => !r.clear)));
  check("People and settings and Your trips go to their pages; AI apps is a button here (the one Connect your AI sheet, in the trip)",
    JSON.stringify(rows.slice(2).map((r) => r.href ?? r.id)) === JSON.stringify([`/trips/${TRIP}`, "st-apps", "/trips"]), JSON.stringify(rows.map((r) => r.href ?? r.id)));
  await ev(`(document.querySelector("#view #st-apps").click(), 1)`);
  const apps = await waitFor(cdp, S, `(() => { const t = document.querySelector(".sh-root[data-open='1'] .sh-title"); return t ? t.textContent.trim() : null; })()`, { label: "the Connect your AI sheet", timeout: 10000 }).catch(() => null);
  check("AI apps opens the Connect your AI sheet", apps === "Connect your AI", JSON.stringify(apps));
  await ev(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
  await sleep(600);

  section("2. What each row holds");
  const note = (name) => rows.find((r) => r.name === name).note;
  // Packing's own count, on your own things (the Mine tab), from Packing's screen.
  await ev(`(localStorage.setItem("wgp.pack.tab", "mine"), 1)`);
  await go("#/pack", `document.querySelector("#view .pk-hero")`);
  const packing = await ev(`(() => { const m = document.querySelector("#view .pk-meter"); const x = m && m.getAttribute("aria-label").match(/^(\\d+) of (\\d+) packed/); return x ? x[1] + " of " + x[2] + " packed" : ""; })()`);
  await go("#/settings", MORE);
  const now = await J(`JSON.stringify(${rowsOf})`);
  const packNote = now.find((r) => r.name === "Packing").note;
  check("Packing holds the count Packing shows for your things", packNote === packing && /^\d+ of \d+ packed$/.test(packing), JSON.stringify({ more: packNote, packing }));
  const members = await J(`fetch(${JSON.stringify(tripApi())}, { credentials: "same-origin" }).then((r) => r.json()).then((j) => JSON.stringify((j.members || []).length))`);
  check("People holds how many are on the trip", note("People and settings") === `${members} ${members === 1 ? "person" : "people"}`, JSON.stringify({ note: note("People and settings"), members }));
  const told = await J(`Promise.all([fetch("/api/account/apps").then((r) => r.json()), fetch("/api/trips").then((r) => r.json())]).then(([a, t]) => JSON.stringify({ apps: a.apps.length, trips: t.trips.length }))`);
  check("AI apps holds what Your account is told", now.find((r) => r.name === "AI apps").note === (told.apps ? `${told.apps} connected` : "None yet"), JSON.stringify({ note: now.find((r) => r.name === "AI apps").note, told }));
  check("Your trips holds how many you're on", now.find((r) => r.name === "Your trips").note === String(told.trips), JSON.stringify({ note: now.find((r) => r.name === "Your trips").note, told }));
  const changes = async () => J(`JSON.stringify((() => { const n = document.querySelector('#view [data-note="changes"]'); return { words: n.textContent, dot: getComputedStyle(n, "::before").content }; })())`);
  await ev(`(document.documentElement.removeAttribute("data-changes-new"), 1)`);
  await sleep(100);
  const quiet = await changes();
  await ev(`(document.documentElement.setAttribute("data-changes-new", ""), 1)`);
  await sleep(100);
  const fresh = await changes();
  await ev(`(document.documentElement.removeAttribute("data-changes-new"), 1)`);
  check("Changes says nothing while nothing is new, and \"New\" with its dot the moment the shell marks something", quiet.words === "" && fresh.words === "New" && fresh.dot === '""', JSON.stringify({ quiet, fresh }));

  section("3. Appearance");
  const look = async () => J(`JSON.stringify({ chosen: [...document.querySelectorAll("#st-theme [data-mode]")].filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.dataset.mode),
    names: [...document.querySelectorAll("#st-theme [data-mode]")].map((b) => b.textContent.trim()), group: document.querySelector("#st-theme").getAttribute("role"),
    theme: document.documentElement.getAttribute("data-theme"), stored: localStorage.getItem("wgp.theme"), ground: getComputedStyle(document.body).backgroundColor })`);
  const start = await look();
  check("one switch, System, Light, Dark, with System chosen", start.group === "radiogroup" && start.names.join() === "System,Light,Dark" && start.chosen.join() === "system", JSON.stringify(start));
  const after = {};
  for (const mode of ["light", "void", "system"]) {
    await ev(`(document.querySelector('#st-theme [data-mode="${mode}"]').click(), 1)`);
    await sleep(400);
    after[mode] = await look();
  }
  check("Light: the light look at once, stored", after.light.chosen.join() === "light" && after.light.theme === "light" && after.light.stored === "light" && after.light.ground !== "rgb(0, 0, 0)", JSON.stringify(after.light));
  check("Dark: Void at once, stored", after.void.chosen.join() === "void" && after.void.theme === "void" && after.void.stored === "void" && after.void.ground === "rgb(0, 0, 0)", JSON.stringify(after.void));
  check("System: the phone's (dark here), stored as system", after.system.chosen.join() === "system" && after.system.theme === null && after.system.stored === "system" && after.system.ground === "rgb(0, 0, 0)", JSON.stringify(after.system));

  section("4. This app");
  // The installed worker answers the Version row (the checks' browser bypasses workers, so it is installed, not in control).
  await waitFor(cdp, S, `navigator.serviceWorker.getRegistration().then((r) => (r && r.active ? 1 : 0))`, { label: "the worker installed", timeout: 20000 }).catch(() => {});
  await go("#/settings", MORE);
  await waitFor(cdp, S, `document.querySelector("#st-buildsub").textContent !== "Checking" ? 1 : 0`, { label: "the version", timeout: 8000 }).catch(() => {});
  const app = await J(`JSON.stringify({ net: document.querySelector('[data-note="net"]').textContent, netName: document.querySelector("#st-net").getAttribute("aria-label"),
    loc: document.querySelector('[data-note="loc"]').textContent, ver: document.querySelector("#st-buildsub").textContent.trim(), mono: getComputedStyle(document.querySelector("#st-buildsub")).fontFamily,
    links: [...document.querySelectorAll('#view .st-row[href^="#/settings/"], #view .st-row[href="/privacy"]')].map((a) => a.getAttribute("href")) })`);
  check("Connection says its state in words", /^(Online|Offline)( · \d+ waiting)?$/.test(app.net) && /^Connection: /.test(app.netName), JSON.stringify(app));
  check("Location says its state in words", /^(On|Off|Not asked)$/.test(app.loc), app.loc);
  check(`Version is the running worker's, ${VERSION}, in the mono face`, (app.ver === VERSION || app.ver === `${VERSION} · update ready`) && /Geist Mono/.test(app.mono), JSON.stringify(app));
  const pages = await J(`Promise.all(["/privacy"].map((u) => fetch(u).then((r) => r.status))).then((s) => JSON.stringify(s))`);
  check("Credits and Privacy and terms go to pages that are there", app.links.join() === "#/settings/credits,/privacy" && pages.every((s) => s === 200), JSON.stringify({ links: app.links, pages }));

  section("5. One place for your face");
  {
    const you = await J(`JSON.stringify({ color: !!document.querySelector("#st-color"), named: [...document.querySelectorAll(".st-more a, .st-more button")].some((e) => /Your color/.test(e.textContent)),
      href: (document.querySelector("[data-st-face]") && document.querySelector("[data-st-face]").closest("a")) ? document.querySelector("[data-st-face]").closest("a").getAttribute("href") : "",
      words: (document.querySelector("[data-st-face]") && document.querySelector("[data-st-face]").closest("a") || {}).textContent || "" })`);
    check("no Your color row; your name and face lead to Your account, \"Your account and your picture\"", !you.color && !you.named && /^\/account/.test(you.href) && /Your account and your picture/.test(you.words), JSON.stringify(you));
  }

  section("6. At 320 and 1440");
  const fits = `JSON.stringify({ over: document.documentElement.scrollWidth - innerWidth, rows: ${rowsOf}.map((r) => [r.name, r.h, r.full, r.clear]) })`;
  await size(320, 640);
  await go("#/settings", MORE);
  const narrow = await J(fits);
  check("320: nothing runs off the side, every row whole and clear", narrow.over <= 0 && narrow.rows.every(([, h, full, clear]) => h >= 52 && full && clear), JSON.stringify(narrow));
  await size(1440, 900, 1);
  await go("#/settings", MORE);
  const wide = await J(`JSON.stringify({ over: document.documentElement.scrollWidth - innerWidth, inHead: !!document.querySelector("#view .ds-head .head-more"), rail: !!document.querySelector(".ds-rail-you") })`);
  check("1440: nothing runs off the side; your picture is the rail's, not the head's", wide.over <= 0 && !wide.inHead && wide.rail, JSON.stringify(wide));

  section("7. Back from every page More opens");
  await size(390, 844);
  for (const [name, find] of [["People and settings", `[...document.querySelectorAll("#view .st-row")].find((a) => /People and settings/.test(a.textContent))`],
    ["Your trips", `[...document.querySelectorAll("#view .st-row")].find((a) => /Your trips/.test(a.textContent))`],
    ["Your account", `document.querySelector("#view [data-st-you]")`],
    ["Privacy and terms", `[...document.querySelectorAll("#view .st-row")].find((a) => /Privacy and terms/.test(a.textContent))`]]) {
    await go("#/settings", MORE);
    const went = await ev(`(() => { const a = ${find}; if (!a) return 0; a.click(); return 1; })()`);
    if (!went) { check(`${name}: More has its row`, false); continue; }
    await waitFor(cdp, S, `!location.pathname.startsWith("/t/") && document.readyState === "complete" && document.querySelector("[data-page-back]") ? 1 : 0`, { label: name, timeout: 20000 }).catch(() => {});
    await sleep(500);
    const back = await J(`JSON.stringify((() => { const b = document.querySelector("[data-page-back]"); if (!b) return { at: location.pathname, none: true };
      const r = b.getBoundingClientRect(); return { at: location.pathname, words: b.textContent.trim(), onScreen: r.top >= 0 && r.bottom <= innerHeight && r.width > 40, h: Math.round(r.height) }; })())`);
    check(`${name} (${back.at}): the one Back, on screen`, !back.none && back.onScreen && back.words === "Back" && back.h >= 44, JSON.stringify(back));
    // Scrolled to its end, the page's last control is clear of the Back: the page's foot keeps room for it.
    const room = await J(`(async () => {
      for (const el of [document.scrollingElement, ...document.querySelectorAll("body *")]) {
        if (el === document.scrollingElement || /(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight;
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const b = document.querySelector("[data-page-back]");
      if (!b) return JSON.stringify({ none: true });
      const back = b.getBoundingClientRect();
      const all = [...document.querySelectorAll("main button, main a[href], main input:not([type=hidden]), main select, main textarea, main summary")]
        .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== "hidden"; });
      if (!all.length) return JSON.stringify({ controls: 0 });
      const last = all.reduce((a, n) => (n.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? n : a));
      const r = last.getBoundingClientRect();
      const hit = !(r.right <= back.left || r.left >= back.right || r.bottom <= back.top || r.top >= back.bottom);
      return JSON.stringify({ last: (last.getAttribute("aria-label") || last.textContent || last.tagName).trim().replace(/\\s+/g, " ").slice(0, 32), bottom: Math.round(r.bottom), backTop: Math.round(back.top), hit });
    })()`);
    check(`${name}: scrolled to its end, its last control is clear of the Back`, !room.none && !room.hit && room.controls !== 0, JSON.stringify(room));
    if (back.none) continue;
    await ev(`(document.querySelector("[data-page-back]").click(), 1)`);
    const home = await waitFor(cdp, S, `location.pathname.startsWith("/t/") && ${MORE} ? 1 : 0`, { label: `back from ${name}`, timeout: 20000 }).then(() => true, () => false);
    check(`${name}: Back returns to More`, home, await ev("location.pathname + location.hash"));
  }
  for (const [name, hash, mark] of [["Changes", "#/changes", `document.querySelector("#view .ch-list, #view [data-changes], #view h1")`], ["the credits", "#/settings/credits", `document.querySelector("#view h1, #view .st-cred")`]]) {
    await go("#/settings", MORE);
    await ev(`(location.hash = ${JSON.stringify(hash)}, 1)`);
    await waitFor(cdp, S, `${mark} ? 1 : 0`, { label: name, timeout: 15000 }).catch(() => {});
    await sleep(500);
    const dockBack = await J(`JSON.stringify({ shown: !document.getElementById("backbtn").hidden, words: document.getElementById("backbtn").textContent.trim() })`);
    check(`${name}: the app's dock Back`, dockBack.shown && dockBack.words === "Back", JSON.stringify(dockBack));
  }

  section("8. Your whole name");
  await size(390, 844);
  const meNow = await J(`fetch("/api/me", { credentials: "same-origin" }).then((r) => r.json()).then((j) => JSON.stringify({ name: j.name }))`);
  const patch = (name) => ev(`fetch("/api/me", { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: ${JSON.stringify(name)} }) }).then((r) => r.status)`);
  const readName = `JSON.stringify((() => { const n = document.querySelector("[data-st-name]"), cs = getComputedStyle(n), lh = parseFloat(cs.lineHeight) || 22;
    return { text: n.textContent, px: parseFloat(cs.fontSize), lines: Math.round(n.getBoundingClientRect().height / lh), whole: n.scrollWidth <= n.clientWidth + 1 && n.scrollHeight <= n.clientHeight + 1 }; })())`;
  // A long name that fits once smaller: one line. One too long even at the floor: two lines, whole. Never cut.
  // The name that needs shrinking is chosen by measure, not guessed: the first that is wider than the row at the name's
  // own 16 px and fits it at 14 (a canvas in the row's own font). The one too long even at 14 is plainly so.
  await go("#/settings", MORE);
  const SHRINK = JSON.parse(await ev(`(() => { const n = document.querySelector("[data-st-name]"), cs = getComputedStyle(n), avail = n.parentElement.clientWidth;
    const ctx = document.createElement("canvas").getContext("2d");
    const w = (t, px) => { ctx.font = cs.fontWeight + " " + px + "px " + cs.fontFamily; return ctx.measureText(t).width; };
    const pick = ["Bartholomew Featherstonehaugh Jr", "Bartholomew Featherstonehaugh Smith", "Bartholomew Featherstone-Ames", "Maximiliana Featherstonehaugh", "Bartholomew Featherstonehaugh-Ames"]
      .find((t) => w(t, 16) > avail + 1 && w(t, 14) < avail - 2);
    return JSON.stringify(pick || ""); })()`));
  check("  (a name wider than the row at 16 px that fits it at 14, by measure)", !!SHRINK, SHRINK);
  for (const [LONG, want] of [[SHRINK, 1], ["Bartholomew Featherstonehaugh-Wynne", 2]]) {
    if (!LONG) continue;
    check(`  (planted: the host's name made "${LONG}" through PATCH /api/me)`, Number(await patch(LONG)) === 200);
    await go("#/settings", MORE);
    await sleep(600);
    const fit = await J(readName);
    check(want === 1 ? "a long name shrinks onto one line (under its 16 px, 14 or more) and shows whole" : "a name too long even at 14 px wraps onto a second line, at 14 px, whole: never cut",
      fit.text === LONG && fit.lines === want && fit.px >= 14 && (want === 1 ? fit.px < 16 : fit.px === 14) && fit.whole, JSON.stringify(fit));
  }
  check("  (and the name it had is put back)", Number(await patch(meNow.name)) === 200);

  section("9. No page errors");
  check("nothing thrown", b.pageErrors.length === 0, b.pageErrors.join(" | ").slice(0, 400));
} catch (e) {
  fail++; failures.push(`stopped: ${e.message}`);
  console.log(`  FAIL  stopped: ${e.stack || e}`);
} finally {
  await ev(`(localStorage.removeItem("wgp.theme"), 1)`).catch(() => {});
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }

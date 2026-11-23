#!/usr/bin/env node
/* WHERE A TRIP IS, said by typing its town: in a real browser, on a server of its own.
 *
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
 *     --label "wegoplace where_check.mjs" -- node scripts/where_check.mjs
 *
 * WGP_SHOTS=<folder> also writes pictures (390 wide, the theme the browser has), to look at.
 *
 * The server is this check's own (checks/lib/server.mjs: an empty database, a port of its own).
 * One made-up person signs up with a passkey and makes every trip here by hand, on Your trips.
 * The towns are the app's own table (public/towns/, which scripts/towns_check.mjs reads whole);
 * this check holds what a person sees and what the server is sent.
 *
 * WHAT IT PROVES
 *   1. MAKE A TRIP ASKS WHERE, AND NOTHING ELSE OF PLACE. Typing "Kyoto" and choosing it gives
 *      the trip its zone (Asia/Tokyo, said in one quiet line as "On Tokyo time, GMT+9, in
 *      Japanese Yen. Change them in the trip's details.") and ONE area, written with the trip,
 *      whose box holds Kyoto's station. The same for Cusco and for Porto. The zone database's
 *      region word is on no line. The form has no time zone or currency field of its own.
 *   2. (gone 25 Nov: the zone is changed in the trip's details, not in this form.)
 *   3. A COUNTRY gives a zone and no area ("Japan"); the form says a town is still wanted.
 *   4. WHAT NO LIST OF TOWNS HAS: a name that isn't there gets a sentence and the offer of a
 *      map link, never an empty list; coordinates pasted there make the area a box around
 *      that spot, called what was typed, with the zone of the towns near it. Under a list
 *      long enough to scroll the offer is still in sight.
 *   5. THE MAP OF A TRIP WITH NO AREA says how it gets one, and its link goes to the trip's
 *      page, at "Where it goes".
 *   6. WHERE IT GOES, on the trip's page: the areas listed; "Add a city" with the same list,
 *      towns only (a country is not offered: the trip has its zone); a town that is there
 *      already is refused in words; what one more town costs the map of the others is said
 *      BEFORE it is added (the server's plan, played here: the route's own check is the
 *      server's); added; removed again; and one a place points at stays, with the server's
 *      own sentence.
 *   7. THE OTHER FIELDS THAT TAKE A ZONE say it as a place: the trip's details.
 *   8. THE TABLE'S FILES: only the files for what was typed were asked for; with the table
 *      out of reach the field still finds time zones and says what is missing; the worker
 *      keeps the files in a cache of their own, and forgetting the phone clears it.
 *
 *   9. A date typed one key at a time into Make a trip's first day (the year passing through 0002,
 *      0020, 0202): the zone line under Where reads Sydney's offset in hours after every key, and
 *      the form never changes height (city-search.js dayWhen).
 * Planted (each fails this check): areaOf() answering null (no area is written); the picker's
 * `townsOnly` ignored (a country is offered on the trip's page); the plan's sentence dropped.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";

// A site that makes maps (the snapshot's top-level `maps` is true there), as the real one does: the
// Map's "Say where" promises a map only where one would be made. Its world is out of reach and a
// cut waits ten minutes, so no cut runs while this check does; the trips' areas are what it reads.
const server = await startServer({ name: "where", port: await freeLoopbackPort(), maps: true,
  vars: { WORLD_URL: "http://127.0.0.1:9/world.pmtiles", MAP_DELAY_MS: "600000" } });
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
const REGION_WORD = / · (Europe|America|Asia|Africa|Pacific|Australia|Atlantic|Indian|Antarctica|Arctic)\b/;
const holds = (a, lat, lng) => !!a && a.west < lng && a.east > lng && a.south < lat && a.north > lat;

let b = null;
try {
  await server.start();
  const host = new Person(server.origin, "Mara Voss");
  await host.signUp();

  const { boot, evalIn, waitFor, appSettled, sleep } = await import("./lib/standalone_cdp.mjs");
  b = await boot({ vw: 390, vh: 844, dsf: 1 });
  const { cdp, S } = b;
  const page = (expr) => evalIn(cdp, S, expr);
  const shot = async (name) => { if (SHOTS) await b.shot(path.join(SHOTS, `${name}.png`)); };
  for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: server.origin }, S);
  await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: host.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
  if (host.jar.cookies.get("wgp_who")) await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: host.jar.cookies.get("wgp_who"), sameSite: "Lax" }, S);

  // Every request for the towns' table, by file name; the plan of the map, played; the table put out of reach.
  const asked = [];
  let plan = null;                 // what POST …/tiles/plan answers here; null: the server's own answer
  const planBodies = [];
  let tableOff = false;
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/towns/*", requestStage: "Request" }, { urlPattern: "*/tiles/plan", requestStage: "Request" }] }, S);
  cdp.on(async (m) => {
    if (m.sessionId !== S || m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    const u = new URL(request.url);
    try {
      if (u.pathname.startsWith("/towns/")) {
        asked.push(u.pathname.slice(7));
        if (tableOff) { await cdp.send("Fetch.failRequest", { requestId, errorReason: "InternetDisconnected" }, S); return; }
      } else if (plan && request.method === "POST") {
        planBodies.push(JSON.parse(request.postData || "{}"));
        await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }],
          body: Buffer.from(JSON.stringify(plan(planBodies.at(-1)))).toString("base64") }, S);
        return;
      }
      await cdp.send("Fetch.continueRequest", { requestId }, S);
    } catch { /* the page went on without it */ }
  });

  const go = async (address) => { await cdp.send("Page.navigate", { url: `${server.origin}${address}` }, S); await sleep(300); };
  const text = (sel) => page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); return n && !n.hidden ? n.textContent.replace(/\\s+/g, " ").trim() : ""; })()`);
  const value = (sel) => page(`document.querySelector(${JSON.stringify(sel)}).value`);
  const typeIn = async (sel, words) => {
    await page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); n.focus(); n.value = ""; n.dispatchEvent(new Event("input", { bubbles: true })); n.scrollIntoView({ block: "center" }); return 1; })()`);
    if (words) await cdp.send("Input.insertText", { text: words }, S);
  };
  const key = async (k) => {
    const code = { Enter: 13, Escape: 27, ArrowDown: 40 }[k];
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code }, S);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code }, S);
    await sleep(250);
  };
  const listOf = (id) => page(`JSON.stringify([...document.querySelectorAll("#${id} > li")].map((li) => ({
    words: [...li.children].length ? [...li.children].map((c) => c.textContent).join(" | ") : li.textContent, off: li.getAttribute("aria-disabled") === "true" })))`).then(JSON.parse);
  // Type into a "where" field and wait until its list answers for those words (a row, or a sentence).
  const ask = async (field, list, words, { first = null } = {}) => {
    await typeIn(`#${field}`, words);
    await waitFor(cdp, S, first
      ? `(() => { const o = document.querySelector("#${list} .tr-zone-city"); return o && o.textContent === ${JSON.stringify(first)} ? 1 : 0; })()`
      : `(() => { const l = document.getElementById("${list}"); return !l.hidden && l.children.length && !/^(Looking|Type a)/.test(l.textContent) ? 1 : 0; })()`,
      { label: `the list for “${words}”` });
    await sleep(350);
    return listOf(list);
  };
  const tapOption = async (list, re) => {
    const ok = await page(`(() => { const li = [...document.querySelectorAll("#${list} > li")].find((n) => ${re}.test(n.textContent)); if (!li) return 0;
      li.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true })); return 1; })()`);
    if (!ok) throw new Error(`no option matching ${re} in #${list}`);
    await sleep(350);
  };
  const tap = async (sel, label = sel) => {
    const got = await page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return 0; if (n.disabled) return -1; n.click(); return 1; })()`);
    if (got !== 1) throw new Error(`tap: ${label} ${got === 0 ? "is not there" : "is disabled"}`);
    await sleep(200);
  };
  const openTrips = async () => {
    await go("/trips");
    await waitFor(cdp, S, `location.pathname === "/trips" && document.querySelector("#form-make") && !document.querySelector("#page").hidden && !document.querySelector("#make-name").disabled && document.querySelector("#make-zone-said").textContent ? 1 : 0`, { label: "Your trips, with the form" });
    await sleep(300);
    // With a trip on the list the form waits behind "Make a trip" (the list is what the page is for then): one tap opens it.
    const shut = JSON.parse(await page(`JSON.stringify([!document.getElementById("make-open").hidden, document.getElementById("form-make").hidden, document.querySelectorAll("#list > *").length > 0])`));
    if (shut[2] && !sawShut) {
      sawShut = true;
      check("with a trip on the list, the form waits behind one Make a trip button", shut[0] && shut[1], JSON.stringify(shut));
    }
    if (shut[0]) {
      await tap("#make-open", "Make a trip");
      await waitFor(cdp, S, `!document.getElementById("form-make").hidden && document.activeElement && document.activeElement.id === "make-name" ? 1 : 0`, { label: "the form, opened, its name field ready" });
    }
  };
  let sawShut = false;
  // Press "Make the trip" and read what the server now holds for it.
  const make = async (name) => {
    await tap("#btn-make", "Make the trip");
    await waitFor(cdp, S, `location.pathname.startsWith("/t/") ? 1 : 0`, { label: `“${name}” opening in the app`, timeout: 30000 });
    const trip = server.sql(`SELECT id, default_tz FROM trips WHERE name = '${name.replace(/'/g, "''")}'`)[0];
    const areas = trip ? server.sql(`SELECT id, name, parent, west, south, east, north FROM areas WHERE trip_id = '${trip.id}'`) : [];
    return { trip, areas };
  };
  const fill = async (name) => { await typeIn("#make-name", name); };

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────
  section("1. Make a trip asks where");
  await openTrips();
  const phoneZone = await page(`Intl.DateTimeFormat().resolvedOptions().timeZone`);
  const line0 = await text("#make-zone-said");
  check("before anything is typed, the trip's zone is the phone's, said in one quiet line with its city and offset, and where to change it",
    /^On .+ \(your phone's\)(, in .+)?\. Change them in the trip's details\.$/.test(line0) && line0.includes(phoneZone.split("/").at(-1).replace(/_/g, " ")) && !REGION_WORD.test(line0), line0);
  check("the form asks for no time zone and no currency: their fields are put away, and nothing offers to change them here",
    (await page(`(document.getElementById("make-zone-field").hidden && document.getElementById("make-cur").closest(".field").hidden && !document.getElementById("make-zone-change")) ? 1 : 0`)) === 1);
  check("nothing of the towns' table has been asked for before the field is used", asked.filter((f) => f !== "index.json").length === 0, asked.join(" "));

  await fill("Autumn in Kyoto");
  let rows = await ask("make-where", "make-where-list", "Kyoto", { first: "Kyoto, Japan" });
  check('"Kyoto" finds Kyoto, Japan first, with its offset, and the offer of a map link under the list',
    rows[0].words === "Kyoto, Japan | GMT+9" && /Paste a map link/.test(rows.at(-1).words) && rows.every((r) => !REGION_WORD.test(r.words)), JSON.stringify(rows));
  check("only the table's index and the one file for those letters were asked for", asked.length <= 2 && asked.includes("index.json") && asked.some((f) => /^t-ky[a-z]*\.txt$/.test(f)), asked.join(" "));
  await key("Enter");
  const picked = { field: await value("#make-where"), zone: await text("#make-zone-said"), said: await text("#make-where-said") };
  check("chosen: the field says the town, its country and its offset; the line says the zone by its city; the map is promised around it",
    picked.field === "Kyoto, Japan · GMT+9" && /^On Tokyo time, GMT\+9, in Japanese Yen( and .+)?\. Change them in the trip's details\.$/.test(picked.zone) && /^The trip's map is made around Kyoto, \d+ km across\./.test(picked.said), JSON.stringify(picked));
  await page(`(document.activeElement.blur(), 1)`);
  await shot("form-kyoto-picked");
  const kyoto = await make("Autumn in Kyoto");
  check("the trip has the zone Asia/Tokyo", kyoto.trip && kyoto.trip.default_tz === "Asia/Tokyo", JSON.stringify(kyoto.trip));
  check("…and ONE area, Kyoto, at the top, whose box holds Kyoto's station",
    kyoto.areas.length === 1 && kyoto.areas[0].id === "kyoto" && kyoto.areas[0].name === "Kyoto" && kyoto.areas[0].parent === null && holds(kyoto.areas[0], 34.9858, 135.7588), JSON.stringify(kyoto.areas));

  for (const [typed, label, zone, lat, lng, what] of [
    ["Cusco", "Cusco, Peru", "America/Lima", -13.5167, -71.9781, "its main square"],
    ["Porto", "Porto, Portugal", "Europe/Lisbon", 41.1456, -8.6109, "its central station"],
  ]) {
    await openTrips();
    await fill(`A week in ${typed}`);
    rows = await ask("make-where", "make-where-list", typed, { first: label });
    await key("Enter");
    const got = await make(`A week in ${typed}`);
    check(`${typed}: the zone ${zone}, and one area whose box holds ${what}`,
      got.trip && got.trip.default_tz === zone && got.areas.length === 1 && got.areas[0].name === typed && holds(got.areas[0], lat, lng), JSON.stringify(got));
    check(`${typed}: no two rows of its list read the same`, new Set(rows.map((r) => r.words)).size === rows.length, JSON.stringify(rows));
  }

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────
  // (Changing the zone right in the form went on 25 Nov: it is changed in the trip's details; check:trips holds that.)

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────
  section("3. a country gives a zone and no area");
  await openTrips();
  await fill("Somewhere in Japan");
  rows = await ask("make-where", "make-where-list", "Japan", { first: "Japan" });
  check('"Japan" is first, and its row says it sets the time zone only', rows[0].words === "Japan | GMT+9 · sets the time zone only", JSON.stringify(rows[0]));
  await key("Enter");
  const country = { field: await value("#make-where"), zone: await text("#make-zone-said"), said: await text("#make-where-said") };
  check("chosen: the zone is said, and the form says a town is still wanted for the map",
    country.field === "Japan · GMT+9" && /^On Tokyo time, GMT\+9(, in .+)?\. Change them in the trip's details\.$/.test(country.zone) && /Name a town or a city too and the trip's map is made around it\.$/.test(country.said), JSON.stringify(country));
  const japan = await make("Somewhere in Japan");
  check("the trip has the zone and NO area", japan.trip && japan.trip.default_tz === "Asia/Tokyo" && japan.areas.length === 0, JSON.stringify(japan));

  // ── 5 (the trip is open in the app now) ────────────────────────────────────────────────
  section("5. the Map of a trip with no area says how it gets one");
  await appSettled(cdp, S);
  await page(`(location.hash = "#/places?view=map", 1)`);
  await waitFor(cdp, S, `(() => { const n = document.querySelector(".mp-note"); return n && !n.hidden && n.dataset.kind === "where" ? 1 : 0; })()`, { label: "the Map's card for a trip with no area", timeout: 30000 });
  const card = JSON.parse(await page(`(() => { const n = document.querySelector(".mp-note"); const a = n.querySelector('a[data-note="where"]');
    return JSON.stringify({ words: n.querySelector(".mp-note-t").textContent, link: a ? a.textContent : "", href: a ? a.getAttribute("href") : "", ok: !!n.querySelector('[data-note="ok"]') }); })()`));
  check("the card says it, with a link to where a town is added and an OK that puts it away",
    card.words === "Say where this trip is and its map gets made." && card.link === "Say where" && card.href === `/trips/${japan.trip.id}#where` && card.ok, JSON.stringify(card));
  await shot("map-no-area");
  await page(`(document.querySelector('.mp-note a[data-note="where"]').click(), 1)`);
  await waitFor(cdp, S, `location.pathname === "/trips/${japan.trip.id}" && !document.querySelector("#page").hidden ? 1 : 0`, { label: "the trip's page" });
  await sleep(500);
  const at = JSON.parse(await page(`(() => { const r = document.getElementById("where").getBoundingClientRect(); return JSON.stringify({ top: Math.round(r.top), h: innerHeight, none: !document.getElementById("areas-none").hidden, rows: document.querySelectorAll("#areas .ac-way").length }); })()`));
  check('the link lands on the trip\'s page with "Where it goes" in sight, saying it goes nowhere yet', at.top >= -1 && at.top < at.h / 2 && at.none && at.rows === 0, JSON.stringify(at));

  // ── 6 ──────────────────────────────────────────────────────────────────────────────────
  section("6. Where it goes, on the trip's page");
  const T = `/api/trips/${japan.trip.id}`;
  const areasNow = () => server.sql(`SELECT id, name, west, south, east, north FROM areas WHERE trip_id = '${japan.trip.id}' ORDER BY id`);
  const areaRows = () => page(`JSON.stringify([...document.querySelectorAll("#areas .ac-way")].map((r) => r.querySelector(".ac-way-label").textContent + " | " + r.querySelector(".meta").textContent))`).then(JSON.parse);
  check("with no town picked the button is off", (await page(`document.getElementById("btn-area").disabled ? 1 : 0`)) === 1);
  rows = await ask("area-where", "area-where-list", "Japan");
  check("a country is not offered here: the trip has its zone, this field takes towns", rows.every((r) => !/sets the time zone only/.test(r.words) && r.words !== "Japan | GMT+9"), JSON.stringify(rows.slice(0, 3)));
  rows = await ask("area-where", "area-where-list", "Nara", { first: "Nara, Japan" });
  await key("Enter");
  let saying = await text("#area-said");
  check("Nara chosen: what the map gains is said, and the button is on",
    /^The trip's map gains Nara, \d+ km across\.$/.test(saying) && (await page(`document.getElementById("btn-area").disabled ? 0 : 1`)) === 1 && /^Nara, Japan/.test(await value("#area-where")), saying);
  await tap("#btn-area", "Add it to the trip");
  await waitFor(cdp, S, `document.querySelectorAll("#areas .ac-way").length === 1 ? 1 : 0`, { label: "Nara listed" });
  let have = areasNow();
  check("added: the server has Nara, a box that holds its station, and the page lists it and says so",
    have.length === 1 && have[0].id === "nara" && holds(have[0], 34.6851, 135.8048) && /^Nara \| About \d+ km across$/.test((await areaRows())[0]) && /^Nara is added/.test(await text("#msg-where")), `${JSON.stringify(have)} / ${await text("#msg-where")}`);
  check("the field is empty again and the button off", (await value("#area-where")) === "" && (await page(`document.getElementById("btn-area").disabled ? 1 : 0`)) === 1);

  await ask("area-where", "area-where-list", "Nara", { first: "Nara, Japan" });
  await key("Enter");
  saying = await text("#area-said");
  check("the same town again is refused in words, before anything is sent", saying === "Nara is on the trip already." && (await page(`document.getElementById("btn-area").disabled ? 1 : 0`)) === 1, saying);

  // What one more town costs the others, from the server's plan: played here, so the words are held whatever the site's map maker.
  plan = (body) => ({
    regions: body.areas.map((a) => (a.id ? { id: a.id, name: a.name, now: 15, would: 14 } : { id: null, name: a.name, now: null, would: 14 })),
    left_out: [], lowered: body.areas.filter((a) => a.id).map((a) => a.name), bytes: { now: 30e6, would: 47e6 }, max_depth: 15,
  });
  await ask("area-where", "area-where-list", "Osaka", { first: "Osaka, Japan" });
  await key("Enter");
  await waitFor(cdp, S, `/street detail/.test(document.getElementById("area-said").textContent) ? 1 : 0`, { label: "what Osaka costs the map of Nara" });
  saying = await text("#area-said");
  const sent = planBodies.at(-1) || { areas: [] };
  check("before Osaka is added the page says what it costs the town already there, with no number of a depth",
    /^The trip's map gains Osaka, \d+ km across\. The whole trip's map has to fit on a phone: with Osaka added, Nara loses a level of street detail\.$/.test(saying) && !/\b1[0-5]\b/.test(saying.replace(/\d+ km/, "")), saying);
  check("the plan was asked about the trip's regions as they would be: Nara by its id, Osaka with none, each with its box",
    sent.areas.length === 2 && sent.areas[0].id === "nara" && sent.areas[1].id === undefined && sent.areas[1].name === "Osaka" && sent.areas.every((a) => [a.west, a.south, a.east, a.north].every(Number.isFinite)), JSON.stringify(sent));
  check("asking changed nothing: Osaka is not on the trip until the button is pressed", areasNow().length === 1);
  await shot("where-plan-said");
  await tap("#btn-area", "Add it to the trip");
  await waitFor(cdp, S, `document.querySelectorAll("#areas .ac-way").length === 2 ? 1 : 0`, { label: "Osaka listed" });
  have = areasNow();
  check("added: two areas, and the page says the map is being made again", have.map((a) => a.id).join() === "nara,osaka" && holds(have[1], 34.7025, 135.4959) && /^Osaka is added\. The trip's map is being made again with it/.test(await text("#msg-where")), `${JSON.stringify(have.map((a) => a.id))} / ${await text("#msg-where")}`);
  plan = null;
  await shot("where-two-areas");

  // A place in Nara: the server won't let Nara go, and says why.
  const put = await host.call("PUT", `${T}/places`, { places: [{ id: "deer-park", name: "The deer park", kind: "sight", subkind: "park", lat: 34.685, lng: 135.843, area: "nara" }] });
  check("(a place is put in Nara)", put.status === 200, `${put.status} ${JSON.stringify(put.json).slice(0, 200)}`);
  const remove = async (name) => {
    const sel = `(() => [...document.querySelectorAll("#areas .ac-way")].find((r) => r.querySelector(".ac-way-label").textContent === ${JSON.stringify(name)}).querySelector("button"))()`;
    await page(`(${sel}.click(), 1)`);
    await sleep(300);
    const armed = await page(`${sel}.textContent`);
    await page(`(${sel}.click(), 1)`);
    return armed;
  };
  const armed = await remove("Osaka");
  await waitFor(cdp, S, `document.querySelectorAll("#areas .ac-way").length === 1 ? 1 : 0`, { label: "Osaka gone from the list" });
  check("Remove asks twice, by name, then Osaka is off the trip and the page says so", armed === "Tap again to remove Osaka" && areasNow().map((a) => a.id).join() === "nara" && /^Osaka is off the trip/.test(await text("#msg-where")), `${armed} / ${await text("#msg-where")}`);
  await remove("Nara");
  await waitFor(cdp, S, `(() => { const m = document.getElementById("msg-where"); return !m.hidden && /can't be removed/.test(m.textContent) ? 1 : 0; })()`, { label: "the server's refusal" });
  const refused = await text("#msg-where");
  check("Nara, which a place points at, stays: the server's own sentence is shown, and the row is still there",
    /^An area that places point at, or that has areas under it, can't be removed\./.test(refused) && areasNow().length === 1 && (await areaRows()).length === 1, refused);

  // ── 7 ──────────────────────────────────────────────────────────────────────────────────
  section("7. the trip's details say its zone as a place");
  await waitFor(cdp, S, `/,/.test(document.getElementById("d-tz").value) ? 1 : 0`, { label: "the zone said with its country" }).catch(() => {});
  const dtz = await value("#d-tz");
  check('the zone field reads "Tokyo, Japan · GMT+9"', dtz === "Tokyo, Japan · GMT+9", dtz);
  rows = await ask("d-tz", "d-tz-list", "lima", { first: "Lima, Peru" });
  check("its list is towns and countries with their offsets, no region word, and no map link", rows[0].words === "Lima, Peru | GMT-5" && rows.every((r) => !REGION_WORD.test(r.words) && !/map link/.test(r.words)), JSON.stringify(rows.slice(0, 2)));
  await key("Escape");
  check("Escape puts back what the trip has", (await value("#d-tz")) === "Tokyo, Japan · GMT+9", await value("#d-tz"));

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────
  section("4. what no list of towns has");
  await openTrips();
  await fill("An island week");
  rows = await ask("make-where", "make-where-list", "Qqzzyx Vvk");
  check("a name that isn't there: a sentence, and the offer of a map link; never an empty list",
    rows.length === 2 && rows[0].off && rows[0].words === "No town or country by that name." && rows[1].words === "Not a town? Paste a map link to it", JSON.stringify(rows));
  rows = await ask("make-where", "make-where-list", "Bali");
  const inSight = JSON.parse(await page(`(() => { const l = document.getElementById("make-where-list"), a = l.querySelector(".tr-zone-act"); const L = l.getBoundingClientRect(), A = a.getBoundingClientRect();
    return JSON.stringify({ scrolls: l.scrollHeight > l.clientHeight + 1, in: A.top >= L.top - 1 && A.bottom <= L.bottom + 1, right: Math.round(L.right), w: innerWidth, bottom: Math.round(A.bottom), h: innerHeight,
      field: Math.round(document.getElementById("make-where").getBoundingClientRect().top) }); })()`));
  check('"Bali": a list long enough to scroll, with the map-link offer still in sight under it, and the field and the whole list on the screen',
    rows.length >= 6 && inSight.scrolls && inSight.in && inSight.right <= inSight.w && inSight.bottom <= inSight.h && inSight.field >= 0, JSON.stringify({ n: rows.length, ...inSight }));
  await shot("form-bali-list");
  await ask("make-where", "make-where-list", "Santorini");
  await tapOption("make-where-list", /Paste a map link/);
  const linkMode = { rows: await listOf("make-where-list"), hint: await page(`document.getElementById("make-where").placeholder`) };
  check("the offer taken: the field asks for the link, says what the trip will call it, and has a way back",
    linkMode.hint === "Paste a map link to Santorini" && /The trip will call it “Santorini”\.$/.test(linkMode.rows[0].words) && linkMode.rows[1].words === "Back to typing a town", JSON.stringify(linkMode));
  await cdp.send("Input.insertText", { text: "not a link at all" }, S);
  await sleep(500);
  check("words that say no place get a sentence, and nothing is chosen", /doesn't say where it is/.test((await listOf("make-where-list"))[0].words) && (await page(`document.getElementById("make-where").value`)) === "not a link at all");
  await page(`(() => { const n = document.getElementById("make-where"); n.value = ""; n.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await cdp.send("Input.insertText", { text: "36.4618, 25.3753" }, S);
  await waitFor(cdp, S, `/^Santorini · /.test(document.getElementById("make-where").value) ? 1 : 0`, { label: "the spot chosen" });
  const spot = { field: await value("#make-where"), zone: await text("#make-zone-said"), said: await text("#make-where-said") };
  check("coordinates pasted: the field says the name that was typed, the zone is the one the towns near it keep, the map is promised around the spot",
    spot.field === "Santorini · GMT+2" && /^On Athens time, GMT\+2(, in .+)?\. Change them in the trip's details\.$/.test(spot.zone) && /^The trip's map is made around that spot, \d+ km across, and called Santorini\./.test(spot.said), JSON.stringify(spot));
  const island = await make("An island week");
  check("the trip has Athens' zone and one area called Santorini, a box around that spot",
    island.trip && island.trip.default_tz === "Europe/Athens" && island.areas.length === 1 && island.areas[0].id === "santorini" && island.areas[0].name === "Santorini" && holds(island.areas[0], 36.4618, 25.3753)
      && Math.abs((island.areas[0].north + island.areas[0].south) / 2 - 36.4618) < 0.001, JSON.stringify(island));

  // ── 8 ──────────────────────────────────────────────────────────────────────────────────
  section("8. the table's files");
  const files = [...new Set(asked)];
  check("in all of that, only the files for what was typed were asked for (a handful, never the table)", files.length <= 16 && files.includes("index.json") && files.every((f) => f === "index.json" || f === "near.txt" || /^t-[a-z0-9]+\.txt$/.test(f)), files.join(" "));
  await openTrips();
  // The worker's own cache of the table: the files the typing asked for, under its own name.
  await appSettled(cdp, S);
  await ask("make-where", "make-where-list", "Hallstatt", { first: "Hallstatt, Austria" });
  const kept = JSON.parse(await page(`(async () => {
    const ctl = !!navigator.serviceWorker.controller;
    for (let i = 0; i < 40; i++) {
      if (await caches.has("wegoplace-towns-v1")) { const keys = (await (await caches.open("wegoplace-towns-v1")).keys()).map((r) => new URL(r.url).pathname); if (keys.length) return JSON.stringify({ ctl, keys }); }
      await new Promise((r) => setTimeout(r, 150));
    }
    return JSON.stringify({ ctl, keys: [] });
  })()`));
  check("a page the worker doesn't control yet keeps the file typing asked for, in the towns' own cache", !kept.ctl && kept.keys.some((k) => /^\/towns\/t-ha[a-z]*\.txt$/.test(k)), JSON.stringify(kept));
  tableOff = true;
  await openTrips();
  rows = await ask("make-where", "make-where-list", "Hallstatt", { first: "Hallstatt, Austria" });
  check("with the table out of reach, a town looked up before is still found (the copy kept)", rows[0].words === "Hallstatt, Austria | GMT+1" || rows[0].words === "Hallstatt, Austria | GMT+2", JSON.stringify(rows[0]));
  rows = await ask("make-where", "make-where-list", "Tokyo");
  check("…a town never looked up is not, but its time zone is, and the list says what is missing",
    rows.some((r) => /^Tokyo/.test(r.words) && /GMT\+9/.test(r.words)) && rows.some((r) => r.off && /^No signal: only time zones, and towns already looked up, are here\.$/.test(r.words)), JSON.stringify(rows));
  await shot("form-no-signal");
  tableOff = false;
  // The worker's own keeping (after the table-off steps: the page's interception doesn't see the
  // worker's fetches): registered as signing in registers it, the page opened again
  // under it, another town typed.
  await cdp.send("Network.setBypassServiceWorker", { bypass: false }, S);     // boot() turns it on
  await page(`navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then(() => navigator.serviceWorker.ready).then(() => 1)`);
  await openTrips();
  await waitFor(cdp, S, `navigator.serviceWorker.controller ? 1 : 0`, { label: "the page under the worker" });
  await ask("make-where", "make-where-list", "Zermatt", { first: "Zermatt, Switzerland" });
  const byWorker = JSON.parse(await page(`(async () => {
    const ctl = !!navigator.serviceWorker.controller;
    for (let i = 0; i < 40; i++) {
      const keys = (await (await caches.open("wegoplace-towns-v1")).keys()).map((r) => new URL(r.url).pathname);
      if (keys.some((k) => k.startsWith("/towns/t-ze") && k.endsWith(".txt"))) return JSON.stringify({ ctl, keys });
      await new Promise((r) => setTimeout(r, 150));
    }
    return JSON.stringify({ ctl, keys: (await (await caches.open("wegoplace-towns-v1")).keys()).map((r) => new URL(r.url).pathname) });
  })()`));
  check("under the worker, the worker keeps the file typing asked for, in the same cache", byWorker.ctl && byWorker.keys.some((k) => /^\/towns\/t-ze[a-z]*\.txt$/.test(k)), JSON.stringify(byWorker));
  const gone = JSON.parse(await page(`import("/js/forget.js").then(async (f) => { const r = await f.forgetThisPhone(); return JSON.stringify({ ok: r.ok, has: await caches.has("wegoplace-towns-v1") }); })`));
  check("forgetting the phone (signing out, another account) clears that cache: which files are there says what was typed", gone.ok && gone.has === false, JSON.stringify(gone));

  // ── 9 ──────────────────────────────────────────────────────────────────────────────────
  section("9. a date typed one key at a time: the zone line never reads a year no trip has");
  {
    // The phone in Sydney, as the film's was; Make a trip's line says the phone's zone until a town is picked.
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Australia/Sydney" }, S);
    await openTrips();
    const LINE = `JSON.stringify({ line: (document.getElementById("make-zone-said") || {}).textContent || "", tall: Math.round(document.getElementById("form-make").getBoundingClientRect().height), day: document.getElementById("make-from").value })`;
    await page(`(() => { const n = document.getElementById("make-from"); n.focus(); n.scrollIntoView({ block: "center" }); return 1; })()`);
    const steps = [JSON.parse(await page(LINE))];
    for (const k of "12252027") {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: `Digit${k}`, text: k, windowsVirtualKeyCode: 48 + +k }, S);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: `Digit${k}`, windowsVirtualKeyCode: 48 + +k }, S);
      await sleep(120);
      steps.push(JSON.parse(await page(LINE)));
    }
    const say = steps.map((x) => `${x.day || "(none)"}: ${x.line} [${x.tall}]`).join(" | ");
    check("the year passed through years no trip has (0002, 0020, 0202) on its way to 2027", ["0002-12-25", "0020-12-25", "0202-12-25", "2027-12-25"].every((d) => steps.some((x) => x.day === d)), say);
    check("after every key the line says Sydney time with an offset in hours, never local mean time", steps.every((x) => /Sydney time, GMT\+1[01]\b/.test(x.line) && !/GMT[+-]\d+:\d+:\d+/.test(x.line)), say);
    check("…and the form never changes height while the date is typed", steps.every((x) => x.tall === steps[0].tall), say);
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "" }, S);     // the machine's own again
  }

  check("no page error", b.pageErrors.length === 0, b.pageErrors.join(" | "));
} catch (e) {
  fail++; failures.push("the check ran to its end");
  console.log(`  FAIL  the check ran to its end   -> ${e && e.stack ? e.stack : e}`);
} finally {
  if (b) await b.done().catch(() => {});
  await server.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(fail ? 1 : 0);

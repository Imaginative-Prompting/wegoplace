#!/usr/bin/env node
/* Kilometers or miles (model §3; util.js fmtDistance and distanceUnits, store.js setUnits, map.js
 * paintScale, account.js): every distance the app draws follows the account's `units`, and the
 * phone's language until the person picks.
 *
 *   node scripts/gate.mjs --only units_check
 *
 * The made-up trip as its host, the phone 500 m north of a place of the trip (Sereno del Puerto
 * Exchange). Three screens read each time: Places' list (the distance on the place's row), the
 * place's page ("… away", and its walk from its lodging in minutes, which never changes), and the
 * map's scale plate. It holds:
 *   1. NOT CHOSEN: a phone in British English reads kilometers; one in US English reads miles (feet
 *      under 1,000). Your account says which, and that it is the phone's language.
 *   2. MILES CHOSEN in Your account (a real tap): saved on the account, said there, and the
 *      British phone's three screens read miles.
 *   3. KILOMETERS CHOSEN: the US phone's three screens read kilometers.
 * The account's own setting is put back as it was at the end.
 *
 * PLANTED (red when put in by hand):
 *   - store.js without setUnits from the account: section 2's screens stay in kilometers.
 *   - map.js paintScale in meters always: section 2's scale fails.
 */
import { BASE, appSettled, boot, evalIn, signInAs, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { TRIP, HOST } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

const PLACE = { id: "p-001", name: "Sereno del Puerto Exchange", lat: -12.12316, lng: -76.94026 };
const HERE = { latitude: PLACE.lat + 0.0045, longitude: PLACE.lng, accuracy: 15 };     // about 500 m north
const METRIC = /^\d[\d.,]* (m|km)$/, IMPERIAL = /^\d[\d.,]* (ft|mi)$/;

// A phone in a language, signed in as the trip's host, standing 500 m from the place.
async function phone(lang) {
  const b = await boot({ vw: 390, vh: 844, dsf: 1, gl: true });
  const { cdp, S } = b;
  await signInAs(cdp, S, HOST.id);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { for (const [k, v] of [["language", ${JSON.stringify(lang)}], ["languages", [${JSON.stringify(lang)}]]])
    Object.defineProperty(Navigator.prototype, k, { get: () => v, configurable: true }); })()` }, S);
  await cdp.send("Browser.grantPermissions", { origin: BASE, permissions: ["geolocation"] }).catch(() => {});
  await cdp.send("Emulation.setGeolocationOverride", HERE, S);
  const page = (e) => evalIn(cdp, S, e);
  const go = async (address, ready, label) => {
    await cdp.send("Page.navigate", { url: "about:blank" }, S);
    await sleep(120);
    await cdp.send("Page.navigate", { url: `${BASE}${address}` }, S);
    await appSettled(cdp, S).catch(() => {});
    await waitFor(cdp, S, ready, { label, timeout: 30000 });
    await sleep(700);
  };
  // The three screens, as they read.
  async function read() {
    // Places' list, near this phone: the place's row and its distance.
    await go(`/t/${TRIP}/#/places`, `document.querySelector('.pl-row[href="#/p/${PLACE.id}"] .pl-far, a[href="#/p/${PLACE.id}"] .pl-far') ? 1 : 0`, "the place's row with its distance");
    const row = await page(`(document.querySelector('a[href="#/p/${PLACE.id}"] .pl-far') || { textContent: "" }).textContent.trim()`);
    await go(`/t/${TRIP}/#/p/${PLACE.id}`, `[...document.querySelectorAll(".pl-facts .pill")].some((p) => / away$/.test(p.textContent)) ? 1 : 0`, "the place's page with how far");
    const pills = JSON.parse(await page(`JSON.stringify([...document.querySelectorAll(".pl-facts .pill")].map((p) => p.textContent.trim()))`));
    const away = (pills.find((p) => / away$/.test(p)) || "").replace(/ away$/, "");
    const walk = pills.find((p) => / walk from /.test(p)) || "";
    await go(`/t/${TRIP}/#/places?view=map`, `(() => { const s = document.querySelector("#view .mp-scale"); return s && s.textContent.trim() ? 1 : 0; })()`, "the map's scale");
    await sleep(1200);
    const scale = await page(`document.querySelector("#view .mp-scale").textContent.trim()`);
    return { row, away, walk, scale };
  }
  return { b, cdp, S, page, go, read };
}

const PHONES = [];
let before;
try {
  const GB = await phone("en-GB");
  PHONES.push(GB);
  // The account's setting as it is now: put back at the end.
  await GB.go(`/account`, `document.querySelector("[data-units]") && !document.getElementById("account").hidden ? 1 : 0`, "Your account");
  before = await GB.page(`fetch("/api/me").then((r) => r.json()).then((m) => m.units ?? null)`);
  const setUnits = (u) => GB.page(`fetch("/api/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ units: ${JSON.stringify(u)} }) }).then((r) => r.status)`);
  await setUnits(null);

  section("1. not chosen: the phone's language");
  const US = await phone("en-US");
  PHONES.push(US);
  for (const [name, p, re, word] of [["British English", GB, METRIC, "kilometers"], ["US English", US, IMPERIAL, "miles"]]) {
    await p.go(`/account`, `document.querySelector("[data-units]") && !document.getElementById("account").hidden ? 1 : 0`, "Your account");
    const acct = JSON.parse(await p.page(`JSON.stringify({ on: (document.querySelector('[data-units][aria-pressed="true"]') || { textContent: "" }).textContent.trim(), note: document.getElementById("units-note").textContent })`));
    check(`${name}, not chosen: Your account shows ${word}, from the phone's language`, acct.on === (word === "miles" ? "Miles" : "Kilometers") && acct.note.startsWith(`Not chosen yet: this phone's language reads ${word}.`), JSON.stringify(acct));
    const r = await p.read();
    check(`${name}: the place's row, its page and the map's scale read ${word}; its walk in minutes`, re.test(r.row) && re.test(r.away) && re.test(r.scale) && /^\d+ min walk from /.test(r.walk), JSON.stringify(r));
  }

  section("2. miles chosen in Your account");
  await GB.go(`/account`, `document.querySelector("[data-units]") && !document.getElementById("account").hidden ? 1 : 0`, "Your account");
  const at = JSON.parse(await GB.page(`JSON.stringify((() => { const b = document.querySelector('[data-units="imperial"]'); b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })())`));
  for (const type of ["mousePressed", "mouseReleased"]) await GB.cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, GB.S);
  await waitFor(GB.cdp, GB.S, `!document.getElementById("msg-units").hidden ? 1 : 0`, { label: "the saved line" });
  const saved = JSON.parse(await GB.page(`JSON.stringify({ msg: document.getElementById("msg-units").textContent.trim(), note: document.getElementById("units-note").textContent, on: document.querySelector('[data-units][aria-pressed="true"]').textContent.trim() })`));
  const onServer = await GB.page(`fetch("/api/me").then((r) => r.json()).then((m) => m.units)`);
  check("a tap on Miles saves it on the account and says so", onServer === "imperial" && saved.on === "Miles" && /^Saved\. Your trips show miles/.test(saved.msg) && saved.note.startsWith("Distances on your trips are in miles."), JSON.stringify({ onServer, ...saved }));
  const r2 = await GB.read();
  check("the British phone's place row, place page and map scale now read miles; the walk is still minutes", IMPERIAL.test(r2.row) && IMPERIAL.test(r2.away) && IMPERIAL.test(r2.scale) && /^\d+ min walk from /.test(r2.walk), JSON.stringify(r2));

  section("3. kilometers chosen");
  await setUnits("metric");
  const r3 = await US.read();
  check("the US phone's three screens read kilometers", METRIC.test(r3.row) && METRIC.test(r3.away) && METRIC.test(r3.scale), JSON.stringify(r3));

  for (const [n, p] of [["the British phone", GB], ["the US phone", US]]) check(`no page error on ${n}`, p.b.pageErrors.length === 0, p.b.pageErrors.join(" | ").slice(0, 300));
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  // The account's setting put back as it was.
  if (PHONES[0] && before !== undefined) {
    await PHONES[0].page(`fetch("/api/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ units: ${JSON.stringify(before)} }) }).then((r) => r.status)`).catch(() => {});
  }
  for (const p of PHONES) await p.b.done().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

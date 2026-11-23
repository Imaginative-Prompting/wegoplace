#!/usr/bin/env node
/* The first screens of a trip with nothing in it yet, as a stranger meets them (a stranger's walk,
 * 16 Nov), in a real browser on a server of its own, one made-up person:
 *
 *   1. MEMORIES, EMPTY: on the app's own page, not the feed's darker photo ground (with nothing on
 *      it, that ground read as another app at 768), and saying what a memory is and who sees it:
 *      "Photos and videos from the trip, for everyone on it. Add the first." At 390, 768 and 1440.
 *   2. THE ADD ON A WIDE WINDOW: at 1440 no floating + on Packing, Split or Photos; Packing and Split
 *      name their add in their heads ("+ Add …"); Photos and the Itinerary (two panes), with nothing
 *      in them, offer their empty page's own add ("Add photos", "Add a plan") and nothing beside it;
 *      at 390 the phone's + keeps its corner.
 *
 *   node scripts/gate.mjs --only first_screens_check
 *
 * PLANTED (red when put in by hand): memories.js paintGround() without its "something on it" test
 * (1: the empty feed on the dark ground); styles.css without the 768 rule that takes the three +
 * away (2: a floating + drawn beside the named add).
 */
import fs from "node:fs";
import path from "node:path";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { openChrome } from "../checks/lib/chrome.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// WGP_SHOTS=<folder>: stills of each screen read, light and dark (made-up).
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const server = await startServer({ name: "first-screens", port: await freeLoopbackPort() });
ownServer(server.origin);
let chrome = null;
try {
  await server.start();
  const { origin } = server;
  const ada = new Person(origin, "Ada Reyes");
  await ada.signUp();
  const trip = (await ada.post("/api/trips", { name: "Porto in November", default_tz: "UTC", starts_on: "2027-05-01", ends_on: "2027-05-04" })).json.trip.id;
  chrome = await openChrome();
  const pageAt = async (width, height, mobile) => {
    const p = await chrome.page({ width, height, mobile, passkeys: false });
    await p.setCookie(origin, "wgp_session", ada.jar.cookies.get("wgp_session"));
    await p.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(ada.user.id), sameSite: "Lax" });
    return p;
  };
  const stills = async (p, name) => {
    if (!SHOTS) return;
    for (const scheme of ["light", "dark"]) {
      await p.scheme(scheme);
      await sleep(400);
      const { data } = await p.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(SHOTS, `${name}-${scheme}.png`), Buffer.from(data, "base64"));
    }
    await p.scheme("light");
  };

  section("1. Memories, empty");
  for (const [w, h, mobile] of [[390, 844, true], [768, 1024, true], [1440, 900, false]]) {
    const p = await pageAt(w, h, mobile);
    await p.goto(`${origin}/t/${trip}/#/memories`);
    await p.until(`document.querySelector("#view .me-emptyadd") ? 1 : 0`, "the empty Memories", 20000);
    await sleep(600);
    const r = JSON.parse(await p.eval(`JSON.stringify((() => { const v = document.querySelector("#view"); const e = document.querySelector("#view .empty");
      return { scape: v.classList.contains("me-scape"), view: getComputedStyle(v).backgroundColor, ground: getComputedStyle(document.body).backgroundColor, words: (e.querySelector(".meta") || {}).textContent || "" }; })())`));
    check(`${w}: on the app's own page, not the photo ground`, !r.scape && (r.view === r.ground || r.view === "rgba(0, 0, 0, 0)"), JSON.stringify(r));
    check(`${w}: it says what a memory is and who sees it`, r.words === "Photos and videos from the trip, for everyone on it. Add the first.", r.words);
    await stills(p, `memories-empty-${w}`);
    await p.close();
  }

  section("2. The + on a wide window");
  const wide = await pageAt(1440, 900, false);
  // From 768 Packing and Split name their add in their heads, and no floating + is drawn.
  for (const [name, hash, ready] of [["Pack", "#/pack", "#view .pk-root"], ["Split", "#/split", "#view .sp-head"]]) {
    await wide.goto("about:blank");
    await wide.goto(`${origin}/t/${trip}/${hash}`);
    await wide.until(`document.querySelector(${JSON.stringify(ready)}) && document.querySelector("#rt-fixed .fab") ? 1 : 0`, `${name}`, 20000);
    await sleep(800);
    const r = JSON.parse(await wide.eval(`JSON.stringify((() => { const f = document.querySelector("#rt-fixed .fab"); const a = [...document.querySelectorAll("#view .head-add")].find((n) => getComputedStyle(n).display !== "none");
      return { fab: getComputedStyle(f).display !== "none", add: a ? a.textContent.trim() : null, icon: !!(a && a.querySelector("svg")) }; })())`));
    // A screen on the design system (Split) draws the + as its button's icon beside the words; the others in text.
    check(`${name}: no floating + on a wide window; its add named in its head`, !r.fab && (/^\+ Add /.test(r.add || "") || (/^Add /.test(r.add || "") && r.icon)), JSON.stringify(r));
    if (name === "Split") await stills(wide, "head-add-1440-split");
  }
  // Photos with nothing in it: its empty page's own add is the way in; no named add beside it, no +.
  await wide.goto("about:blank");
  await wide.goto(`${origin}/t/${trip}/#/memories`);
  await wide.until(`document.querySelector("#view .me-emptyadd") && document.querySelector("#rt-fixed .fab") ? 1 : 0`, "Photos, empty", 20000);
  await sleep(800);
  const photos = JSON.parse(await wide.eval(`JSON.stringify((() => { const f = document.querySelector("#rt-fixed .fab"), e = document.querySelector("#view .me-emptyadd"), a = [...document.querySelectorAll("#view .head-add")].find((n) => getComputedStyle(n).display !== "none");
    return { fab: getComputedStyle(f).display !== "none", own: e.textContent.trim(), shown: e.getBoundingClientRect().width > 0, named: a ? a.textContent.trim() : null }; })())`));
  check("Photos (nothing in it): its add is the page's own \"Add photos\", nothing beside it, no floating +", !photos.fab && photos.shown && /Add photos/.test(photos.own) && !photos.named, JSON.stringify(photos));
  // The Itinerary is two panes on a wide window (router.js), and on a brand-new trip with no plans and
  // no places it asks how you want to plan it ("Plan it with your AI" / "Add plans yourself") with no +.
  await wide.goto("about:blank");
  await wide.goto(`${origin}/t/${trip}/#/`);
  await wide.until(`document.querySelector("#view .rt-pane-a .empty [data-plan-add]") ? 1 : 0`, "the Itinerary's add", 20000);
  await sleep(800);
  const ag = JSON.parse(await wide.eval(`JSON.stringify((() => { const f = document.querySelector("#rt-fixed .fab"), b = document.querySelector("#view .rt-pane-a .empty [data-plan-add]"), ai = document.querySelector("#view .rt-pane-a .empty [data-plan-ai]");
    return { fab: !!f && getComputedStyle(f).display !== "none", add: b.textContent.trim(), ai: ai ? ai.textContent.trim() : null, shown: b.getBoundingClientRect().width > 0 }; })())`));
  check('Agenda (two panes, no plans): offers "Plan it with your AI" and "Add plans yourself", no floating +', !ag.fab && ag.shown && /Add plans yourself/.test(ag.add) && /Plan it with your AI/.test(ag.ai || ""), JSON.stringify(ag));
  await wide.close();
  const phone = await pageAt(390, 844, true);
  await phone.goto(`${origin}/t/${trip}/#/pack`);
  await phone.until(`document.querySelector("#rt-fixed .fab") ? 1 : 0`, "Pack's + at 390", 20000);
  await sleep(500);
  const ph = JSON.parse(await phone.eval(`JSON.stringify((() => { const f = document.querySelector("#rt-fixed .fab").getBoundingClientRect(); return { right: Math.round(innerWidth - f.right) }; })())`));
  check("390: the + keeps the phone's corner", ph.right === 16, JSON.stringify(ph));
  await phone.close();
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  await chrome?.close().catch(() => {});
  await server.stop().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

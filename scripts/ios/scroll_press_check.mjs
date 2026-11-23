#!/usr/bin/env node
// A SCROLL IS NOT A TAP (20 Nov, on an iPhone: a finger that scrolls the Itinerary leaves the row it started on looking
// pressed, during the scroll and after the finger lifts). On an iPhone Simulator, the app added to the Home Screen and
// opened from its icon, real touches (AXe), the gate's made-up trip as its host. Off the gate (scripts/ios/README.md).
//
//   LAB_UDID=<a device of your own> IOS_AXE=<the AXe binary> WGP_BASE=… WGP_GATE_CARD=… node scripts/ios/scroll_press_check.mjs <out folder>
//
// On the Itinerary, Places' list, Split's feed and Packing: a row in the middle of the list, its look at rest read
// (background, shadow, outline, border, transform, opacity, filter); then a finger put down on it, swiped up 260 points
// and lifted (axe swipe), while the page samples the row every 30 ms. It holds:
//   1. the list scrolled, and nothing opened (the address is the same): the scroll was a scroll;
//   2. from the moment the list moves, the row never looks other than at rest (no pressed or hover look);
//   3. a moment after the lift it looks as at rest, and isn't :hover.
// A still of each list after the lift: scroll-<list>.png. The device is shut down at the end, whatever happens.

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connect } from "./phone.mjs";
import { makeApi } from "../lib/seed_memories.mjs";
import { ORIGIN, tripPath } from "../lib/gate_trip.mjs";
import { freeLoopbackPort } from "../lib/browser.mjs";

const UDID = process.env.LAB_UDID, AXE = process.env.IOS_AXE;
const out = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !UDID || !AXE) { console.error("usage: LAB_UDID=… IOS_AXE=… node scripts/ios/scroll_press_check.mjs <out folder>"); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 600) : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 1400) : ""}`); }
};
const downNow = (why) => {
  console.log(`\nSTOPPED (${why})`);
  try { execSync(`/usr/bin/xcrun simctl shutdown ${UDID}`, { stdio: "ignore" }); } catch { /* already down */ }
  process.exit(1);
};
process.on("uncaughtException", (e) => downNow(e?.stack || e));
process.on("unhandledRejection", (e) => downNow(e?.stack || e));

// The row to scroll from: the first of the list's rows wholly between 200 points from the top and 260 from the foot (so
// the swipe starts on it and the list has room to move), and the thing a tap on it would press: its closest link,
// button or control. Its look at rest; then a recorder that samples it every 30 ms until told to stop.
const ARM = (rows) => `(() => {
  const v = document.querySelector("#view");
  const row = [...document.querySelectorAll(${JSON.stringify(rows)})].find((r) => { const b = r.getBoundingClientRect(); return b.top > 200 && b.bottom < innerHeight - 260 && b.height > 30; });
  if (!row) return JSON.stringify({ none: true });
  const el = row.closest("a, button, [role='button'], [data-act], [tabindex]") || row;
  const look = () => { const s = getComputedStyle(el); return [s.backgroundColor, s.boxShadow, s.outlineStyle + " " + s.outlineColor, s.borderColor, s.transform, s.opacity, s.filter].join(" | "); };
  const b = row.getBoundingClientRect();
  window.__sp = { el, rest: look(), y0: v.scrollTop, href: location.href, rec: [] };
  window.__sp.t = setInterval(() => window.__sp.rec.push({ y: v.scrollTop, look: look(), hover: el.matches(":hover"), active: el.matches(":active") }), 30);
  return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), what: (el.className || el.tagName) + "", text: (row.textContent || "").trim().slice(0, 40), rest: window.__sp.rest });
})()`;
const READ = `(() => {
  const p = window.__sp; clearInterval(p.t);
  const v = document.querySelector("#view");
  const moving = p.rec.filter((r) => Math.abs(r.y - p.y0) > 4);
  const odd = moving.filter((r) => r.look !== p.rest).map((r) => r.look);
  const s = getComputedStyle(p.el);
  const now = [s.backgroundColor, s.boxShadow, s.outlineStyle + " " + s.outlineColor, s.borderColor, s.transform, s.opacity, s.filter].join(" | ");
  return JSON.stringify({ samples: p.rec.length, moved: Math.round(v.scrollTop - p.y0), sameAddress: location.href === p.href, address: location.href.split("/t/")[1] || location.href,
    whileMoving: moving.length, oddWhileMoving: odd.length, firstOdd: odd[0] || null, rest: p.rest,
    after: now, afterSame: now === p.rest, afterHover: p.el.matches(":hover"), activeWhileMoving: moving.filter((r) => r.active).length });
})()`;

let phone = null, code = 1;
try {
  const api = await makeApi();
  const listen = await freeLoopbackPort();
  phone = await connect({ listen, upstream: Number(new URL(ORIGIN).port), out, said: [], pageErrors: [] });
  phone.cookie({ name: "wgp_session", value: api.session, maxAge: 3600 });
  const at = (p) => `http://localhost:${listen}${p}`;
  const tab = await phone.openTab();
  await tab.go(at("/"));                                     // added to the Home Screen, opened from its icon
  await sleep(6000);
  const read = async (expr) => { try { return JSON.parse(await tab.page(expr)); } catch (e) { return { noAnswer: String(e.message).slice(0, 160) }; } };
  // iOS's location question, answered Allow where it stands on an iPhone 17 (275,508), only if that is what is there.
  const answerIos = async () => {
    let here = "";
    try { here = execFileSync(AXE, ["describe-ui", "--point", "275,508", "--udid", UDID], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch { return; }
    if (!/"AXLabel"\s*:\s*"Allow"/.test(here)) return;
    execFileSync(AXE, ["tap", "-x", "275", "-y", "508", "--udid", UDID], { stdio: "ignore" });
    console.log("  note  iOS asked for the location: touched Allow");
    await sleep(1200);
  };
  await answerIos();

  for (const [name, hash, rows, ready] of [
    ["itinerary", "#/", ".ag-card, .ag-ev, .ag-slot", ".ag-day"],
    ["places", "#/places", ".pl-row", ".pl-row"],
    ["split", "#/split", ".sp-row", ".sp-row"],
    ["packing", "#/pack", ".pk-row, .pk-item", ".pk-row, .pk-item"],
  ]) {
    console.log(`\n${name}`);
    await tab.go(at(tripPath(hash)));
    await tab.wait(`document.querySelectorAll(${JSON.stringify(ready)}).length > 3 ? 1 : 0`, `the ${name} list`, 30000);
    await sleep(1500);
    await answerIos();
    const arm = await read(ARM(rows));
    if (arm.none || arm.noAnswer) { check(`${name}: a row in the middle of the list to start the scroll on`, false, JSON.stringify(arm)); continue; }
    console.log(`  note  the finger goes down on ${arm.what} "${arm.text}" at ${arm.x},${arm.y}`);
    execFileSync(AXE, ["swipe", "--start-x", String(arm.x), "--start-y", String(arm.y), "--end-x", String(arm.x), "--end-y", String(arm.y - 260),
      "--duration", "0.8", "--udid", UDID], { stdio: "ignore" });
    await sleep(900);
    const m = await read(READ);
    await tab.shot(`scroll-${name}`);
    check(`${name}: the swipe scrolled the list and opened nothing (a scroll, not a tap)`, m.moved > 40 && m.sameAddress, JSON.stringify({ moved: m.moved, address: m.address }));
    check(`${name}: while the list moves, the row never looks pressed or hovered (as at rest in every sample)`, m.whileMoving > 3 && m.oddWhileMoving === 0,
      JSON.stringify({ samples: m.samples, whileMoving: m.whileMoving, odd: m.oddWhileMoving, active: m.activeWhileMoving, firstOdd: m.firstOdd, rest: m.rest }));
    check(`${name}: after the finger lifts, the row looks as at rest and isn't hovered`, m.afterSame && !m.afterHover,
      JSON.stringify({ after: m.after, rest: m.rest, hover: m.afterHover }));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  code = fail ? 1 : 0;
} catch (e) {
  console.log(`\nSTOPPED: ${e?.stack || e}\n${pass} passed, ${fail} failed before it stopped`);
  code = 1;
} finally {
  if (phone) { try { await phone.done(); } catch { /* down */ } }
  try { execSync(`/usr/bin/xcrun simctl shutdown ${UDID}`, { stdio: "ignore" }); } catch { /* already down */ }
  console.log(`  note  the device shut down at ${new Date().toTimeString().slice(0, 8)}`);
}
process.exit(code);

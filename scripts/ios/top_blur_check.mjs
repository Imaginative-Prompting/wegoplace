#!/usr/bin/env node
// THE TOP OF THE SCREEN IN A SAFARI TAB (21 Nov: on an iPhone, the app open in Safari as a tab rather than installed, a
// blur was seen over the screen's title and your picture at the top). On an iPhone Simulator's
// Mobile Safari, a tab (simctl openurl, nothing added to the Home Screen), the gate's made-up trip as its host: the
// Itinerary and Places at rest and a little scrolled, as they are, then with each candidate tried in the live page
// (through the relay, no rebuild):
//   A  the opaque strip under the status bar 24 px taller in a tab, and the head starting below it;
//   B  no viewport-fit=cover in a tab: Safari lays the page out below its own top area.
// Then the installed app on the same device, as it is. Stills: blur-<list>-<scheme>-<as|A|B|app>-<rest|scrolled>.png, and what the page reads (its top inset, tab or installed, the
// title's top). The device is shut down at the end, whatever happens. Off the gate.
//
//   LAB_UDID=<a device of your own> IOS_AXE=<the AXe binary> WGP_BASE=… WGP_GATE_CARD=… node scripts/ios/top_blur_check.mjs <out folder>

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connect } from "./phone.mjs";
import { makeApi } from "../lib/seed_memories.mjs";
import { ORIGIN, tripPath } from "../lib/gate_trip.mjs";
import { freeLoopbackPort } from "../lib/browser.mjs";

const UDID = process.env.LAB_UDID;
const out = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !UDID) { console.error("usage: LAB_UDID=… node scripts/ios/top_blur_check.mjs <out folder>"); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const downNow = (why) => { console.log(`\nSTOPPED (${why})`); try { execSync(`/usr/bin/xcrun simctl shutdown ${UDID}`, { stdio: "ignore" }); } catch {} process.exit(1); };
process.on("uncaughtException", (e) => downNow(e?.stack || e));
process.on("unhandledRejection", (e) => downNow(e?.stack || e));

const READ = `JSON.stringify((() => { const d = document.createElement("div"); d.style.cssText = "position:fixed;top:0;height:env(safe-area-inset-top,0px)";
  document.body.append(d); const inset = d.getBoundingClientRect().height; d.remove();
  const t = document.querySelector("#view h1, #view .ag-tripname-t, #view .pl-h1"), tr = t && t.getBoundingClientRect();
  const sb = document.querySelector(".statusbar"), sr = sb && sb.getBoundingClientRect();
  return { tab: !(navigator.standalone || matchMedia("(display-mode: standalone)").matches), inset: Math.round(inset), strip: sr ? Math.round(sr.height) : null,
    titleTop: tr ? Math.round(tr.top) : null, vp: (document.querySelector('meta[name="viewport"]') || {}).content, scrollY: Math.round(document.querySelector("#view").scrollTop) }; })())`;
const FIX_A = `(() => { const s = document.createElement("style"); s.id = "fixA";
  s.textContent = ":root { --safe-top: calc(max(var(--sa-top), var(--sim-inset)) + 24px); }"; document.head.append(s); return 1; })()`;
const FIX_B = `(() => { const m = document.querySelector('meta[name="viewport"]'); m.setAttribute("content", "width=device-width,initial-scale=1"); return 1; })()`;

let phone = null, code = 1;
try {
  const api = await makeApi();
  const listen = await freeLoopbackPort();
  phone = await connect({ listen, upstream: Number(new URL(ORIGIN).port), out, said: [], pageErrors: [] });
  phone.cookie({ name: "wgp_session", value: api.session, maxAge: 3600 });
  const at = (p) => `http://localhost:${listen}${p}`;
  const tab = await phone.openTab();
  const results = {};
  let opened = false;
  for (const scheme of ["dark", "light"]) {
    execSync(`/usr/bin/xcrun simctl ui ${UDID} appearance ${scheme}`);
    for (const [name, hash, ready] of [["itinerary", "#/", "#view .ag-day"], ["places", "#/places", "#view .pl-row"]]) {
      for (const fix of ["as", "A", "B"]) {
        // A tab, as a link from a message opens one (nothing installed): the first page through simctl openurl, each
        // later one in that same tab, so only one page ever answers the relay.
        const stamp = `b${Date.now()}`, url = at(`${tripPath(hash).replace("#", `?${stamp}#`)}`);
        if (!opened) { execFileSync("/usr/bin/xcrun", ["simctl", "openurl", UDID, url], { stdio: "ignore" }); opened = true; }
        else await tab.page(`(setTimeout(() => { location.href = ${JSON.stringify(url)}; }, 60), 1)`).catch(() => 0);
        await tab.wait(`location.search.includes(${JSON.stringify(stamp)}) && document.querySelector(${JSON.stringify(ready)}) ? 1 : 0`, `${name} in Safari`, 60000);
        await sleep(1500);
        if (fix === "A") await tab.page(FIX_A);
        if (fix === "B") await tab.page(FIX_B);
        await sleep(800);
        const rest = JSON.parse(await tab.page(READ));
        await tab.shot(`blur-${name}-${scheme}-${fix}-rest`);
        await tab.page(`(document.querySelector("#view").scrollTop = 60, 1)`);
        await sleep(700);
        const scrolled = JSON.parse(await tab.page(READ));
        await tab.shot(`blur-${name}-${scheme}-${fix}-scrolled`);
        results[`${name}-${scheme}-${fix}`] = { rest, scrolled };
        console.log(`  ${name} ${scheme} ${fix}: ${JSON.stringify(rest)}`);
      }
    }
  }
  // The same two lists in the installed app on the same device (added to the Home Screen), as they are: what Safari's tab
  // should match at the top.
  const app = await phone.openTab();
  for (const scheme of ["dark", "light"]) {
    execSync(`/usr/bin/xcrun simctl ui ${UDID} appearance ${scheme}`);
    for (const [name, hash, ready] of [["itinerary", "#/", "#view .ag-day"], ["places", "#/places", "#view .pl-row"]]) {
      const stamp = `b${Date.now()}`;
      await app.go(at(`${tripPath(hash).replace("#", `?${stamp}#`)}`));
      await app.wait(`(navigator.standalone || matchMedia("(display-mode: standalone)").matches) && document.querySelector(${JSON.stringify(ready)}) ? 1 : 0`, `${name} in the installed app`, 60000);
      await sleep(1500);
      const rest = JSON.parse(await app.page(READ));
      await app.shot(`blur-${name}-${scheme}-app-rest`);
      await app.page(`(document.querySelector("#view").scrollTop = 60, 1)`);
      await sleep(700);
      const scrolled = JSON.parse(await app.page(READ));
      await app.shot(`blur-${name}-${scheme}-app-scrolled`);
      results[`${name}-${scheme}-app`] = { rest, scrolled };
      console.log(`  ${name} ${scheme} app: ${JSON.stringify(rest)}`);
    }
  }
  fs.writeFileSync(path.join(out, "blur.json"), JSON.stringify(results, null, 2) + "\n");
  console.log("\nstills written; judge them by eye: the title and your picture clear, no blur, no gradient over them");
  code = 0;
} catch (e) {
  console.log(`\nSTOPPED: ${e?.stack || e}`);
  code = 1;
} finally {
  if (phone) { try { await phone.done(); } catch {} }
  try { execSync(`/usr/bin/xcrun simctl shutdown ${UDID}`, { stdio: "ignore" }); } catch {}
  console.log(`  note  the device shut down at ${new Date().toTimeString().slice(0, 8)}`);
}
process.exit(code);

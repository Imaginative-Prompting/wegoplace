// A phone for a walk that takes one (--phone): an iPhone Simulator's Home Screen app, real
// Safari, real WebKit storage and service worker, real touches for what a person taps (AXe).
// Off the gate. README.md says what it needs and how to run one case.
//
// The device is booted here and shut down in done(). Never `axe type`; never Simulator.app.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startProxy, whereError } from "./proxy.mjs";
import crypto from "node:crypto";
import os from "node:os";

const UDID = process.env.LAB_UDID;
// AXe (github.com/cameroncooke/AXe, 1.8.0; README.md has its hashes): real touches through UIKit.
const AXE = process.env.IOS_AXE || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const simctl = (...args) => execFileSync("/usr/bin/xcrun", ["simctl", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const axe = (...args) => execFileSync(AXE, [...args.map(String), "--udid", UDID], { encoding: "utf8", stdio: "pipe" });
const labels = () => {
  const walk = (node, out = []) => { if (node.AXLabel) out.push({ label: node.AXLabel, x: Math.round((node.frame?.x ?? 0) + (node.frame?.width ?? 0) / 2), y: Math.round((node.frame?.y ?? 0) + (node.frame?.height ?? 0) / 2) }); for (const c of node.children ?? []) walk(c, out); return out; };
  return JSON.parse(axe("describe-ui")).flatMap((n) => walk(n));
};

// Where the share sheet draws on an iPhone 17 (it is not in the accessibility tree): points.
const SHEET = { more: (process.env.IOS_VIEW_MORE || "333,778").split(",").map(Number), row: (process.env.IOS_ADD_ROW || "151,640").split(",").map(Number), add: (process.env.IOS_ADD || "354,110").split(",").map(Number) };
const ICON = process.env.IOS_ICON || "We Go Place";            // the old manifest's short name, as the Home Screen shows it
const ROW_DEFAULT = "151,640";

/** What touchEl reads of an element on the page, scrolled into view first (the probe runs it). */
export const BOX_SCRIPT = (selector) => `const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; n.scrollIntoView({ block: "center" });
  await new Promise((r) => setTimeout(r, 300)); const r = n.getBoundingClientRect(); const v = window.visualViewport;
  return { left: r.left, top: r.top, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, vy: v ? v.offsetTop : 0, text: (n.innerText || "").trim().slice(0, 40),
    standalone: navigator.standalone === true || matchMedia("(display-mode: standalone)").matches };`;
/**
 * Where on the screen to touch for a box read by BOX_SCRIPT, in points. In the Home Screen app the
 * page is edge to edge (viewport-fit=cover under a translucent status bar), so a page point is a
 * screen point; in a Safari tab the page starts below the browser's bar (62 on an iPhone 17;
 * IOS_PAGE_TOP to say otherwise). Measured 15 Nov: a box at 437 was at 437 on the screen.
 */
export function pointFor(box, env = process.env) {
  const top = box.standalone ? 0 : Number(env.IOS_PAGE_TOP || 62);
  return { x: Math.round(box.x), y: Math.round(top + box.y - (box.vy || 0)), top };
}

export async function connect({ listen, upstream, out, said, pageErrors }) {
  // Before the phone is asked for a page: the relay asked for the same page by this process. A
  // site that doesn't answer here is the site (or the machine), never the Simulator.
  const preflight = async (url, label) => {
    const t = Date.now();
    try {
      const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { accept: "text/html", "x-relay-preflight": "1" } });
      await r.arrayBuffer();
      console.log(`  note  (the phone) before ${label}: the relay answered ${r.status} in ${Date.now() - t} ms`);
    } catch (e) { throw new Error(`before ${label}: the relay's site did not answer this process in ${Date.now() - t} ms (${e.name}); the phone was not asked`); }
  };
  const reqLines = (st) => st.requests.map((r) => `${r.method} ${r.url.replace(/[0-9a-f-]{20,}/g, "<id>").slice(0, 60)} → ${r.status ?? r.failed ?? "no answer"}${r.answered ? ` in ${r.answered - r.at} ms` : ""}`);
  if (!UDID) throw new Error("LAB_UDID names the simulator device (one of your own)");
  if (!AXE) throw new Error("IOS_AXE names the AXe binary (scripts/ios/README.md)");
  const proxy = startProxy({ listen, upstream });
  await proxy.ready;
  const origin = `http://localhost:${listen}`;
  // A phone with nothing on it: no icon, storage or cookie of an earlier run (the device is
  // this session's own, and is shut down between runs).
  try { simctl("shutdown", UDID); } catch { /* it was */ }
  simctl("erase", UDID);
  simctl("bootstatus", UDID, "-b");
  for (const key of ["keyboard", "lock"]) { try { simctl("spawn", UDID, "defaults", "write", "com.apple.preferences.sounds", key, "-bool", "NO"); } catch { /* quiet anyway */ } }
  // IOS_BARE_LOOK=1: before anything else, the old app's first page ONCE through a proxy of its own
  // (the next port: a new origin, so a first load with nothing stored) whose probe has only its
  // ears (errors and hello; proxy.mjs PROBE_BARE). Does Safari's "Script error." still come?
  if (process.env.IOS_BARE_LOOK) {
    const bare = startProxy({ listen: listen + 1, upstream, bare: true });
    await bare.ready;
    const since = Date.now();
    try {
      await preflight(`http://localhost:${listen + 1}/`, "the bare load");
      simctl("openurl", UDID, `http://localhost:${listen + 1}/`);
      const h = await bare.hello(since, 60000).catch(() => null);
      await sleep(8000);
      const errs = bare.st.errors.slice();
      const line = `the old app's first page in a Safari tab, the probe with ONLY its error listener: ${h ? `loaded (${h.path})` : "never said hello"}; page errors: ${errs.length ? errs.map((e) => String(e).slice(0, 160)).join(" | ") : "none"}; what the phone asked this relay: ${bare.st.requests.length ? reqLines(bare.st).join(" | ") : "nothing"}`;
      console.log(`  note  (the phone, bare load) ${line}`);
      try { fs.writeFileSync(path.join(out, "ios-bare-load.txt"), line + "\n"); } catch { /* the out folder is the check's */ }
    } finally {
      try { simctl("terminate", UDID, "com.apple.mobilesafari"); } catch { /* not running */ }
      bare.stop();
      await sleep(1000);
    }
  }
  const shot = (name) => { try { simctl("io", UDID, "screenshot", "--type=png", path.join(out, name + ".png")); } catch (e) { console.log(`  note  (no still ${name}: ${String(e.message).slice(0, 80)})`); } };
  let installed = false, open = false, seenSaid = 0, seenErr = 0;
  const t0 = Date.now(), taps = [];
  // The screen has stopped moving: two stills in a row the same. The share sheet is not in the
  // accessibility tree, so its arrival can only be seen; a fixed wait is too short on a busy Mac
  // (a tap then lands on a sheet still sliding in, and does nothing).
  const settled = async (most = 15000) => {
    const tmp = path.join(os.tmpdir(), `wgp-ios-settle-${process.pid}.png`);
    const look = () => { try { simctl("io", UDID, "screenshot", "--type=png", tmp); return crypto.createHash("sha1").update(fs.readFileSync(tmp)).digest("hex"); } catch { return String(Math.random()); } };
    const end = Date.now() + most;
    let last = look();
    for (;;) {
      await sleep(700);
      const now = look();
      if (now === last) break;
      last = now;
      if (Date.now() > end) { console.log("  note  (the phone) the screen was still moving after " + most / 1000 + " s"); break; }
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ }
  };
  const drain = () => {
    for (; seenSaid < proxy.st.said.length; seenSaid++) said.push(proxy.st.said[seenSaid]);
    for (; seenErr < proxy.st.errors.length; seenErr++) {
      pageErrors.push(proxy.st.errors[seenErr]);
      const e = proxy.st.errorLog[seenErr];
      console.log(`  note  (the phone) a page error, on ${e ? whereError(proxy.st, e).words : "?"}: ${String(proxy.st.errors[seenErr]).replace(/\s+/g, " ").slice(0, 300)}`);
    }
  };
  const run = async (script, timeout = 30000) => { try { return await proxy.run(script, { timeout }); } finally { drain(); } };
  const terminate = (bundle) => { try { simctl("terminate", UDID, bundle); } catch { /* not running */ } };
  const closeApp = async () => { for (const b of ["com.apple.webapp", "com.apple.mobilesafari"]) terminate(b); open = false; await sleep(1200); };
  const launch = async () => {
    const since = Date.now();
    axe("button", "home"); await sleep(1500);
    // The icon is put on the Home Screen's next page when the first is full, and an icon on a
    // page that isn't showing has no place on the screen (0,0): go to its page first.
    const onScreen = () => labels().find((l) => l.label === ICON && l.x > 4 && l.x < 398 && l.y > 60 && l.y < 800);
    await settled(8000);
    let icon = onScreen();
    for (let i = 0; i < 2 && !icon; i++) {
      axe("swipe", "--start-x", 340, "--start-y", 520, "--end-x", 60, "--end-y", 520, "--duration", 0.25);
      await sleep(1000); await settled(8000);
      icon = onScreen();
    }
    if (!icon) { shot("ios-5-no-icon"); throw new Error(`no "${ICON}" icon showing on the Home Screen: ${labels().map((l) => `${l.label}@${l.x},${l.y}`).slice(0, 40).join(" | ")}`); }
    const fromReq = proxy.st.requests.length;
    axe("tap", "-x", icon.x, "-y", icon.y);
    taps.push({ at: Date.now(), what: "the Home Screen icon" });
    let h;
    try { h = await proxy.hello(since, 60000); }
    catch (e) {
      shot("ios-5-app-no-hello");
      const reqs = proxy.st.requests.slice(fromReq).map((r) => `${r.method} ${r.url.replace(/[0-9a-f-]{20,}/g, "<id>").slice(0, 50)} ${r.status ?? r.failed ?? "(no answer yet)"}`);
      console.log(`  note  (debug) the icon was at ${icon.x},${icon.y}; requests since the tap (${reqs.length}): ${reqs.slice(0, 30).join(" | ")}`);
      console.log(`  note  (debug) on screen: ${labels().map((l) => l.label).slice(0, 40).join(" | ")}`);
      console.log(`  note  (debug) probe polls waiting: ${proxy.st.probeSockets.size}; pages that ever said hello: ${proxy.st.hellos.map((x) => x.path + (x.standalone ? " (standalone)" : "")).join(", ")}`);
      throw e;
    }
    open = true;
    console.log(`  note  (the phone) opened from its Home Screen icon: ${h.path}, ${h.standalone ? "as a Home Screen app (standalone)" : "NOT standalone (a browser tab)"}, ${h.controlled ? "a service worker in control" : "no service worker in control yet"}`);
    await sleep(800);
    await dismiss();
    return h;
  };
  // What the system asks over the app on a new phone (location, notifications): refused, as a
  // person in a hurry would.
  const dismiss = async () => {
    for (let i = 0; i < 3; i++) {
      const no = labels().find((l) => /^Don[’']t Allow$/.test(l.label) || l.label === "Not Now");
      if (!no) return;
      axe("tap", "-x", no.x, "-y", no.y); taps.push({ at: Date.now(), what: `"${no.label}" on a system question` }); await sleep(1500);
    }
  };
  // Add to Home Screen, as a person does it: Safari, the page menu, Share, Add to Home Screen.
  const install = async (url) => {
    const since = Date.now();
    await preflight(url.replace(/#.*$/, ""), "the install's first page");
    const fromReq = proxy.st.requests.length;
    simctl("openurl", UDID, url);
    try { await proxy.hello(since, 60000); }
    catch (e) {
      shot("ios-0-no-hello");
      console.log(`  note  (debug) what the phone asked the relay since the address was opened: ${reqLines({ requests: proxy.st.requests.slice(fromReq) }).join(" | ") || "nothing"}`);
      throw e;
    }
    await sleep(6000);                     // the old worker installs and keeps its shell
    shot("ios-0-safari");
    if (process.env.IOS_DEBUG) console.log("  note  (debug) first requests: " + proxy.st.requests.slice(0, 14).map((r) => `${r.method} ${r.url.replace(/[0-9a-f-]{20,}/g, "<id>").slice(0, 40)} ${r.status ?? r.failed}`).join(" | ") + " || pages: " + proxy.st.hellos.map((h) => h.path).join(", "));
    // A new device shows tips over the page first: tap the page menu until Share is offered.
    for (let i = 0; i < 6 && !labels().some((l) => l.label === "Share"); i++) {
      await dismiss();
      try { axe("tap", "--label", "More"); } catch { /* a tip was in the way */ }
      await sleep(1800);
    }
    if (!labels().some((l) => l.label === "Share")) { shot("ios-0b-no-share"); throw new Error("no Share in Safari's page menu: " + labels().map((l) => `${l.label}@${l.x},${l.y}`).slice(-40).join(" | ")); }
    axe("tap", "--label", "Share"); await sleep(1500); await settled();
    shot("ios-1-share");
    axe("tap", "-x", SHEET.more[0], "-y", SHEET.more[1]); await sleep(1200); await settled();
    shot("ios-2-share-more");
    if (!(SHEET.row[0] > 0)) throw new Error("IOS_ADD_ROW=<x,y> names where 'Add to Home Screen' is in ios-2-share-more.png (points = pixels / 3)");
    axe("tap", "-x", SHEET.row[0], "-y", SHEET.row[1]); await sleep(1200); await settled();
    shot("ios-3-add-sheet");
    axe("tap", "-x", SHEET.add[0], "-y", SHEET.add[1]); await sleep(1500); await settled();
    shot("ios-4-added");
    terminate("com.apple.mobilesafari");
    await sleep(1000);
    // Is it there? The icon is in the Home Screen's tree whichever page it is on.
    axe("button", "home"); await sleep(1500); await settled(8000);
    if (!labels().some((l) => l.label === ICON)) { shot("ios-4b-no-icon"); throw new Error(`"Add to Home Screen" did not add "${ICON}": see ios-1 … ios-4b in the out folder (a tap may have landed before its sheet)`); }
    installed = true;
  };

  const makeTab = () => {
    // A tab's requests are those made since it was opened (the relay's list runs from the start
    // of the run, through the old site's days).
    const from = proxy.st.requests.length;
    const tab = {
      S: null, timeline: [], held: () => 0,
      get requests() {
        return proxy.st.requests.slice(from).map((r) => ({ id: r.at, method: r.method, url: r.url, status: r.status, failed: r.failed, error: r.error, fromSw: false }));
      },
      async holdOldWrites() { /* the server answers them 503 itself */ },
      async page(expr) {
        try { return await run(`return await (${expr});`); }
        catch (e) { if (!/did not answer/.test(String(e.message))) throw e; return run(`return await (${expr});`); }
      },
      async wait(expr, label, timeout = 30000) {
        const end = Date.now() + timeout;
        for (;;) {
          const v = await run(`return await (${expr});`, 8000).catch(() => 0);
          if (v) return v;
          if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
          await sleep(300);
        }
      },
      async go(u) {
        if (!installed) { await install(u); await launch(); return; }
        if (!open) { const h = await launch(); if (new URL(u).pathname === "/" && !new URL(u).hash) return h; }
        const since = Date.now();
        await run(`setTimeout(() => { location.href = ${JSON.stringify(u)}; }, 60); return 1;`, 15000).catch(() => 0);
        await proxy.hello(since, 60000).catch(() => null);
      },
      async net() { throw new Error("no network emulation on this phone: use the relay (--net olddoc)"); },
      async bypass() { throw new Error("no worker bypass on this phone"); },
      async script() { throw new Error("no early scripts on this phone"); },
      async unscript() {},
      async key(key) { await run(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); document.dispatchEvent(new KeyboardEvent("keyup", { key: ${JSON.stringify(key)}, bubbles: true })); return 1;`).catch(() => 0); },
      async shot(name) { shot(name); },
      async close() { await closeApp(); },
      // A real touch on what the screen's accessibility tree names (a page's button or a system
      // sheet's): what a finger does, so the page sees a user's gesture (WebAuthn needs one).
      // A system sheet's control by its name. `names` may be a list, tried IN ORDER, each an exact
      // name: a sheet's title can share a word with its button ("Sign In" over "Use Passkey": the
      // fourth boot touched the title), so the button is named first. A regex still works.
      async touch(names) {
        await settled(6000);
        let all = [];
        try { all = labels(); } catch (e) { return `no labels: ${e.message}`; }
        const on = all.filter((l) => l.y > 40 && l.y < 860);
        const re = names instanceof RegExp ? names : null;
        const hit = re ? on.find((l) => re.test(l.label))
          : names.map((n) => on.find((l) => l.label === n)).find(Boolean);
        if (!hit) return `nothing matching ${re || names.join(" / ")} on screen: ${all.map((l) => l.label).slice(0, 30).join(" | ")}`;
        axe("tap", "-x", hit.x, "-y", hit.y);
        taps.push({ at: Date.now(), what: `"${hit.label}"` });
        return `touched "${hit.label}" at ${hit.x},${hit.y}`;
      },
      // Face ID on the simulator (measured on iOS 26.4): enrolled once, then a match
      // answers the sheet that asks for it.
      faceId(what) {
        const notify = (...a) => simctl("spawn", UDID, "notifyutil", ...a);
        if (what === "enroll") { notify("-s", "com.apple.BiometricKit.enrollmentChanged", "1"); notify("-p", "com.apple.BiometricKit.enrollmentChanged"); }
        else notify("-p", "com.apple.BiometricKit_Sim.pearl.match");
        taps.push({ at: Date.now(), what: `Face ID: ${what}` });
      },
      // A real touch on a page's element where the accessibility tree doesn't reach (inside a Home
      // Screen app the page is one "Web" element): its box read by the probe, in CSS pixels, which
      // are points here. Where the page starts on the screen: AT THE TOP in the Home Screen app (this
      // app's page is edge to edge, viewport-fit=cover under a translucent status bar: measured 15
      // Nov, a button whose box said 437 sat at 437 on the screen, and a touch 62 lower missed it);
      // in a Safari tab below the browser's own bar (62 on an iPhone 17; IOS_PAGE_TOP to say
      // otherwise). Scrolled into view first.
      async touchEl(selector) {
        const box = await run(BOX_SCRIPT(selector)).catch(() => null);
        if (!box) return `no ${selector} on the page`;
        const { x, y, top } = pointFor(box);
        // The point beside the box it aims at, in screen points, said before the tap: a miss is
        // visible in one line.
        console.log(`  note  (the phone) a touch at ${x},${y} for ${selector}: its box ${Math.round(box.left)}..${Math.round(box.left + box.w)} × ${Math.round(top + box.top - (box.vy || 0))}..${Math.round(top + box.top + box.h - (box.vy || 0))} (page top ${top}, ${box.standalone ? "Home Screen app" : "a Safari tab"})`);
        axe("tap", "-x", x, "-y", y);
        taps.push({ at: Date.now(), what: `${selector} ("${box.text}")` });
        return `touched ${selector} ("${box.text}") at ${x},${y}`;
      },
      async tapAt(x, y) {
        // The same page top as touchEl's: the top of the screen in the Home Screen app.
        const standalone = await run(`return navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;`, 4000).catch(() => true);
        const PAGE_TOP = standalone ? 0 : Number(process.env.IOS_PAGE_TOP || 62);
        axe("tap", "-x", Math.round(x), "-y", Math.round(PAGE_TOP + y));
        taps.push({ at: Date.now(), what: `the page at ${Math.round(x)},${Math.round(y)}` });
      },
      screenLabels() { try { return labels().map((l) => l.label); } catch (e) { return [`(no labels: ${e.message})`]; } },
      // A system sheet put away as a person does: its Cancel (or Close, Not Now, Done).
      async dismissSheet() {
        await settled(6000);
        let all = [];
        try { all = labels(); } catch { return "no labels"; }
        const c = all.find((l) => /^(Cancel|Close|Not Now|Done)$/.test(l.label));
        if (!c) return "nothing to put away";
        axe("tap", "-x", c.x, "-y", c.y);
        taps.push({ at: Date.now(), what: `"${c.label}" on a system sheet` });
        await settled(6000);
        return `"${c.label}" touched`;
      },
    };
    return tab;
  };

  return {
    origin, front: proxy.st, proxy,
    // The site behind the relay. keepHost: the site hears the phone's own address (and counts it
    // as one of its own: the rehearsal's --also-origin), as a phone at the real address meets the
    // real site; a passkey made here then names the address the site expects.
    upstream(port, { keepHost = false } = {}) { proxy.st.upstream = port; proxy.st.keepHost = keepHost; },
    signal(on) { proxy.signal(on); },
    cookie(c) { proxy.st.cookie = c; },
    async openTab(url) { const tab = makeTab(); if (url) await tab.go(url); return tab; },
    async done() {
      // What the relay saw, in order: every page that reported in, what the pages said, the
      // late pages held back, and the requests for pages, the worker and the guard.
      try {
        const rel = (at) => `+${((at - t0) / 1000).toFixed(1)}s`;
        const tidy = (u) => u.replace(/[0-9a-f-]{20,}/g, "<id>").slice(0, 60);
        const events = [
          ...taps.map((t) => ({ at: t.at, line: `TAP  ${t.what}` })),
          ...proxy.st.hellos.map((h) => ({ at: h.at, line: `PAGE ${h.path} ${h.standalone ? "standalone" : "tab"} ${h.controlled ? "worker in control" : "no worker"} [${h.page}]` })),
          ...proxy.st.lateSeen.map((at) => ({ at, line: `LATE the page asked for; held back ${proxy.st.lateMs} ms` })),
          ...proxy.st.requests.filter((r) => r.method !== "GET" || /^\/(\?|$)|^\/t\/|^\/sw\.js|fresh-app|^\/login|^\/index/.test(r.url)).map((r) => ({ at: r.at, line: `REQ  ${r.method} ${tidy(r.url)} → ${r.status ?? r.failed ?? "no answer"}${r.answered ? ` in ${r.answered - r.at} ms` : ""}` })),
        ].sort((a, b) => a.at - b.at);
        fs.writeFileSync(path.join(out, "ios-timeline.txt"), events.map((e) => `${rel(e.at)}  ${e.line}`).join("\n") + "\n");
        console.log(`  note  (the phone) the relay's timeline: ${path.join(out, "ios-timeline.txt")} (${events.length} lines)`);
      } catch (e) { console.log("  note  (the phone) no timeline: " + e.message); }
      try { await closeApp(); } catch { /* gone */ }
      proxy.stop();
      try { simctl("shutdown", UDID); } catch { /* already down */ }
    },
  };
}

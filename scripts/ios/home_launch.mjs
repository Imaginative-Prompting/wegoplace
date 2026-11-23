#!/usr/bin/env node
// The app put on an iPhone Simulator's Home Screen and opened from its icon, each page error placed by the page that
// had it. Off the gate (scripts/ios/README.md says what it needs). On the gate's server (WGP_BASE, WGP_GATE_CARD).
//
//   LAB_UDID=<a device of your own> IOS_AXE=<the AXe binary> WGP_BASE=… WGP_GATE_CARD=… node scripts/ios/home_launch.mjs <out folder> [launches]
//
// The trip's host, signed in (the relay hands the phone the host's session), opens the app in Mobile Safari, adds it
// to the Home Screen by real touches and opens it from the icon, as many times as asked (2 unless said), the app shut
// between. An installed app opens on "/", which sends it on to the trips. Each page that runs says hello to the
// relay and goodbye on pagehide, and each page error comes with the page that had it (proxy.mjs, whereError()): so an
// error is told apart as the first page's, sent as it went, or the trips page's while it was the live page. Read 10 s
// after each launch. The device is erased first and shut down at the end, whatever happens.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connect } from "./phone.mjs";
import { whereError } from "./proxy.mjs";
import { makeApi } from "../lib/seed_memories.mjs";
import { ORIGIN, TRIP_NAME, tripPath } from "../lib/gate_trip.mjs";
import { freeLoopbackPort } from "../lib/browser.mjs";

const out = path.resolve(process.argv[2] || "");
if (!process.argv[2]) { console.error("usage: node scripts/ios/home_launch.mjs <out folder> [launches]"); process.exit(2); }
const OFFLINE = process.argv[3] === "offline";
const LAUNCHES = OFFLINE ? 1 : Math.max(1, Number(process.argv[3]) || 2);
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 600) : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 1200) : ""}`); }
};

let phone = null;
let code = 1;

// "offline": after the first launch from the icon, the worker made ready and in control (the app reloaded once if
// the first launch isn't), the trip opened once with the server there (so the phone keeps its copy), the app shut
// and opened from the icon again (is a worker in control now?), then the relay's route to the server cut (every
// connection but the probe's; /api/me checked failing from here), and the app opened from the icon once more: does
// it load, does the trip draw from the phone's copy, and what does it say.
async function offlineCase(tab, listen, since, say) {
  const o = {};
  const at = (p) => `http://localhost:${listen}${p}`;
  const read = async (expr) => { try { return JSON.parse(await tab.page(expr)); } catch (e) { return { noAnswer: String(e.message).slice(0, 120) }; } };
  const worker = () => read(`(async () => {
    const sw = navigator.serviceWorker;
    const reg = sw ? await Promise.race([sw.getRegistration(), new Promise((ok) => setTimeout(() => ok("no answer in 3 s"), 3000))]) : null;
    return JSON.stringify({ path: location.pathname + location.hash, controlled: !!(sw && sw.controller),
      registration: reg && typeof reg === "object" ? { active: reg.active ? reg.active.state : null, waiting: !!reg.waiting, installing: !!reg.installing } : reg || null,
      caches: typeof caches === "object" ? (await caches.keys()).length : null });
  })()`);
  const words = () => read(`(async () => {
    const me = await Promise.race([fetch("/api/me", { cache: "no-store" }).then((r) => "answered " + r.status, (e) => "failed (" + e.name + ")"), new Promise((ok) => setTimeout(() => ok("no answer in 8 s"), 8000))]);
    const text = (document.body.innerText || "").replace(/\\s+/g, " ").trim();
    return JSON.stringify({ path: location.pathname + location.hash, title: document.title, text: text.slice(0, 500), apiMe: me,
      tripNamed: text.includes(${JSON.stringify(TRIP_NAME)}) });
  })()`);

  // 1. The worker: ready, then in control (one reload if the first launch isn't controlled after 20 s).
  const ready = await tab.wait("navigator.serviceWorker ? navigator.serviceWorker.ready.then(() => 1) : 0", "the worker ready", 30000).then(() => true, () => false);
  o.firstLaunch = { ready, ...(await worker()) };
  console.log(`  note  (measured) the first launch from the icon: the worker ${ready ? "ready" : "NOT ready in 30 s"}; ${JSON.stringify(o.firstLaunch)}`);
  let controlled = await tab.wait("navigator.serviceWorker && navigator.serviceWorker.controller ? 1 : 0", "a worker in control", 20000).then(() => true, () => false);
  if (!controlled) {
    await tab.go(at("/trips"));
    await sleep(3000);
    controlled = await tab.wait("navigator.serviceWorker && navigator.serviceWorker.controller ? 1 : 0", "a worker in control after a reload", 20000).then(() => true, () => false);
    o.afterReload = await worker();
    console.log(`  note  (measured) not in control after 20 s, so the app reloaded once: ${JSON.stringify(o.afterReload)}`);
  }
  check("the first launch from the icon: a worker in control (after one reload if needed)", controlled, JSON.stringify({ firstLaunch: o.firstLaunch, afterReload: o.afterReload || "not needed" }));

  // 2. The trip opened once with the server there, so the phone keeps its copy.
  await tab.go(at(tripPath()));
  await sleep(6000);
  o.tripOnline = await words();
  await tab.shot("offline-1-trip-with-the-server");
  console.log(`  note  (measured) the trip with the server there: ${JSON.stringify(o.tripOnline)}`);

  // 3. The app shut and opened from the icon again: in control from its first page?
  await tab.close();
  let t = Date.now();
  await tab.go(at("/"));
  await sleep(4000);
  const again = since(t);
  say("opened from the icon again, the server there", again);
  o.reopened = { pages: again.pages, ...(await worker()) };
  check("opened from the icon again: its pages say a worker is in control", again.pages.length > 0 && again.pages.every((p) => /a worker in control/.test(p)), again.pages.join(" | "));

  // 4. The route to the server cut: every connection the phone opens to the site is dropped (the probe's stay).
  phone.signal(false);
  o.apiMeFromHere = await fetch(at("/api/me"), { signal: AbortSignal.timeout(5000) }).then((r) => `answered ${r.status}`, (e) => `failed (${e.cause?.code || e.name})`);
  check("the server cut: /api/me through the phone's route fails from here", /^failed/.test(o.apiMeFromHere), o.apiMeFromHere);

  // 5. The app shut and opened from the icon with no server: does it load, and what does it say?
  await tab.close();
  t = Date.now();
  let loaded = true;
  try { await tab.go(at("/")); } catch (e) { loaded = false; o.noLoad = String(e.message).slice(0, 200); }
  await sleep(5000);
  await tab.shot("offline-2-opened-with-no-server");
  const cut = since(t);
  say("opened from the icon with the server cut", cut);
  o.offlineOpen = { loaded, pages: cut.pages, ...(loaded ? await words() : {}) };
  console.log(`  note  (measured) opened from the icon with no server: ${JSON.stringify(o.offlineOpen)}`);
  check("with no server, opened from the icon: the app loads (a page of it said hello)", loaded && cut.pages.length > 0, JSON.stringify({ loaded, noLoad: o.noLoad, pages: cut.pages }));
  if (loaded) {
    t = Date.now();
    await tab.go(at(tripPath())).catch((e) => { o.tripNoLoad = String(e.message).slice(0, 200); });
    await sleep(6000);
    await tab.shot("offline-3-trip-with-no-server");
    o.tripOffline = { pages: since(t).pages, ...(await words()) };
    console.log(`  note  (measured) the trip with no server: ${JSON.stringify(o.tripOffline)}`);
    check("with no server: the trip draws from the phone's copy (its name on the page)", !!o.tripOffline.tripNamed, JSON.stringify({ path: o.tripOffline.path, apiMe: o.tripOffline.apiMe, text: (o.tripOffline.text || "").slice(0, 200) }));
  }
  phone.signal(true);
  return o;
}
// Whatever throws, even outside this file's awaits (the relay's own handlers), the device goes down.
const downNow = (why) => {
  console.log(`\nSTOPPED (${why})`);
  try { execSync(`/usr/bin/xcrun simctl shutdown ${process.env.LAB_UDID}`, { stdio: "ignore" }); } catch { /* already down */ }
  console.log(`  note  the device shut down at ${new Date().toTimeString().slice(0, 8)}`);
  process.exit(1);
};
process.on("uncaughtException", (e) => downNow(e?.stack || e));
process.on("unhandledRejection", (e) => downNow(e?.stack || e));
try {
  const api = await makeApi();
  const listen = await freeLoopbackPort();
  phone = await connect({ listen, upstream: Number(new URL(ORIGIN).port), out, said: [], pageErrors: [] });
  phone.cookie({ name: "wgp_session", value: api.session, maxAge: 3600 });
  const st = phone.front;
  const at0 = Date.now();
  const s = (ms) => `${(ms / 1000).toFixed(2)} s`;
  // The pages that said hello and the errors that came since a moment, each error with its own page.
  const since = (t) => ({
    pages: st.hellos.filter((h) => h.at >= t).map((h) => `${h.path} [${h.page}] ${h.standalone ? "standalone" : "tab"}, ${h.controlled ? "a worker in control" : "no worker"}, at +${s(h.at - at0)}`
      + (st.byes.some((b) => b.page === h.page) ? `, goodbye at +${s(st.byes.find((b) => b.page === h.page).at - at0)}` : "")),
    errors: st.errorLog.filter((e) => e.at >= t).map((e) => ({ at: `+${s(e.at - at0)}`, said: e.data.replace(/\s+/g, " ").slice(0, 200), where: whereError(st, e) })),
  });
  const say = (what, r) => {
    console.log(`  note  ${what}: the pages, in order: ${r.pages.join(" | ") || "none"}`);
    for (const e of r.errors) console.log(`  note  ${what}: a page error at ${e.at}, "${e.said}", on ${e.where.words}`);
    if (!r.errors.length) console.log(`  note  ${what}: no page error`);
  };

  const tab = await phone.openTab();
  // The first: the app opened in Safari, added to the Home Screen, then opened from its icon (phone.mjs).
  const t1 = Date.now();
  await tab.go(`http://localhost:${listen}/`);
  const installed = st.hellos.find((h) => h.at >= t1 && h.standalone);
  // Safari's part ends with the last word from a page in its tab (Safari is quit before the icon is touched); what
  // comes after is the Home Screen app's, a page that never said hello included.
  const helloOf = (page) => st.hellos.find((h) => h.page === page) || null;
  const inTab = (page) => { const h = helloOf(page); return !!h && !h.standalone; };
  const split = Math.max(t1, ...st.hellos.filter((h) => h.at >= t1 && !h.standalone).map((h) => h.at),
    ...st.byes.filter((b) => b.at >= t1 && inTab(b.page)).map((b) => b.at), ...st.errorLog.filter((e) => e.at >= t1 && inTab(e.page)).map((e) => e.at)) + 1;
  const first = since(t1);
  const inSafari = { pages: first.pages.filter((p) => / tab,/.test(p)),
    errors: st.errorLog.filter((e) => e.at >= t1 && (inTab(e.page) || (!helloOf(e.page) && e.at < split)))
      .map((e) => ({ at: `+${s(e.at - at0)}`, said: e.data.replace(/\s+/g, " ").slice(0, 200), where: whereError(st, e) })) };
  say("in Safari, before it was added", inSafari);
  check("the app added to the Home Screen and opened from its icon, as a Home Screen app", !!installed, installed ? `${installed.path} [${installed.page}]` : first.pages.join(" | "));
  const launches = [];
  for (let n = 1; n <= LAUNCHES; n++) {
    let t = n === 1 ? split : Date.now();
    if (n > 1) { await tab.close(); t = Date.now(); await tab.go(`http://localhost:${listen}/`); }
    await sleep(10000);
    await tab.shot(`home-launch-${n}`);
    const r = since(t);
    r.pages = r.pages.filter((p) => / standalone,/.test(p));
    r.errors = r.errors.filter((e) => !inTab(e.where.page));
    say(`launch ${n} from the icon`, r);
    launches.push(r);
    check(`launch ${n} from the icon: the app ends on the trips page`, r.pages.some((p) => p.startsWith("/trips")), r.pages.join(" | "));
  }
  // The finding, not a fault of the run: each launch's page errors, each said with its page.
  for (const [i, r] of launches.entries()) {
    check(`launch ${i + 1} from the icon: no page error`, !r.errors.length, r.errors.map((e) => `${e.at} "${e.said}" on ${e.where.words}`).join(" || "));
  }
  const offline = OFFLINE ? await offlineCase(tab, listen, since, say) : null;
  fs.writeFileSync(path.join(out, "home-launch.json"), JSON.stringify({ inSafari, launches, offline }, null, 2) + "\n");
  console.log(`\n${pass} passed, ${fail} failed`);
  code = fail ? 1 : 0;
} catch (e) {
  console.log(`\nSTOPPED: ${e?.stack || e}\n${pass} passed, ${fail} failed before it stopped`);
  code = 1;
} finally {
  if (phone) { try { await phone.done(); } catch { /* down */ } }
  try { execSync(`/usr/bin/xcrun simctl shutdown ${process.env.LAB_UDID}`, { stdio: "ignore" }); } catch { /* already down */ }
  console.log(`  note  the device shut down at ${new Date().toTimeString().slice(0, 8)}`);
}
process.exit(code);

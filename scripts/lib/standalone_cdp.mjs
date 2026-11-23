// Shared CDP driver for the standalone (installed-PWA) checks. Extracted so
// standalone_states_check.mjs boots exactly the way standalone_check.mjs does: an --app window (so display-mode is standalone), insets
// injected at document-start, service worker bypassed.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileURLToPath } from "node:url";
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
import { baseUrl, launchChrome } from "./browser.mjs";
import { devSecret } from "./dev_secret.mjs";

export const BASE = baseUrl();
export const HOST = new URL(BASE).hostname;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.handlers = new Set(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cdp connect failed")); });
    const c = new CDP(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej, timer } = c.waiting.get(m.id); c.waiting.delete(m.id);
        clearTimeout(timer);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else for (const h of c.handlers) h(m);
    };
    return c;
  }
  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      // The timer goes when the answer arrives. Left running, every call held the process open
      // for a minute after its last one: a harness that didn't call process.exit() sat idle in
      // the queue's slot for 60 s after its browser had already closed.
      const timer = setTimeout(() => { if (this.waiting.delete(id)) rej(new Error(`CDP timeout: ${method}`)); }, 60000);
      this.waiting.set(id, { res, rej, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

// ON THE GATE'S SERVER (scripts/lib/gate_db.mjs: a database made from nothing, the made-up trip)
// a window is signed in as one of that trip's people, with a session of its own made through
// the sign-in routes (scripts/lib/gate_trip.mjs). A check with a server of its own
// (ownServer()) signs its own people in, and nothing here signs anyone in for it.
const onGate = () => {
  if (!process.env.WGP_GATE_CARD) return false;
  try { return JSON.parse(fs.readFileSync(process.env.WGP_GATE_CARD, "utf8")).origin === BASE; } catch { return false; }
};
const gateTrip = () => import("./gate_trip.mjs");

/** The sign-in cookie from before sessions were rows, for a check of that road (the old accounts). */
export function cookie(uid = "u_admin", days = 30) {
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  // The developer's secret is asked for HERE, when a cookie is made, never when this file is
  // loaded: every check loads it, and on the gate none may read .dev.vars (lib/dev_secret.mjs).
  return `${uid}.${exp}.${crypto.createHmac("sha256", devSecret()).update(`${uid}.${exp}`).digest("hex")}`;
}

/**
 * Make this window the given person of the gate's trip from its next request on: by key
 * ("ada"), by account id, or with nothing, the host. The session is a new one, so a check that
 * signed out, or ended every session, signs in again with this.
 */
export async function signInAs(cdp, S, who) {
  if (!onGate()) throw new Error("signInAs() signs in a person of the gate's trip: run this check through scripts/gate.mjs (a check with its own server sets its own people's cookies)");
  const { signedIn, person } = await gateTrip();
  const id = person(who).id;
  const cookies = await signedIn(who);
  const want = cookies.find((c) => c.name === "wgp_session").value;
  const reset = async () => {
    for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: BASE }, S);
    for (const c of cookies) await cdp.send("Network.setCookie", c, S);
  };
  // ONCE IS NOT ENOUGH. A request the window sent as the last account may still be answered
  // after this, and an answer can set that account's cookies again: the window is the last
  // person once more, silently (seen: the second person of a two-person check acting as the
  // first). So the cookies are set, then watched until they have stayed right twice, 200 ms
  // apart: this session's cookie, and no other account named beside it.
  await reset();
  let steady = 0;
  for (let i = 0; i < 50 && steady < 2; i++) {
    await sleep(200);
    const { cookies: now } = await cdp.send("Network.getCookies", { urls: [BASE] }, S);
    const value = (name) => (now.find((c) => c.name === name) || {}).value || "";
    const right = value("wgp_session") === want && (!value("wgp_who") || value("wgp_who") === id);
    if (right) steady++;
    else { steady = 0; await reset(); }
  }
  if (steady < 2) throw new Error(`signInAs(${who ?? "the host"}): the browser kept being given another account's cookies`);
}

export async function evalIn(cdp, S, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, S);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

export async function waitFor(cdp, S, expr, { timeout = 25000, every = 150, label = expr } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    let v = null;
    try { v = await evalIn(cdp, S, `(()=>{try{return (${expr})}catch(e){return null}})()`); } catch {}
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await sleep(every);
  }
}

/**
 * Wait until the app shell is the document that will stay. index.html reloads the page once,
 * the first time a service worker takes control of it, and how long that takes depends on the
 * machine (measured here: 0.76 s to 1.4 s after the navigation, later under load). A fixed
 * sleep after Page.navigate is sometimes shorter than that, and then a drawer a harness has
 * just opened is thrown away with the page.
 *
 * The signal is the registration's worker reaching "activated", NOT navigator.serviceWorker
 * .controller: boot() turns on Network.setBypassServiceWorker, and under it the page never
 * reports a controller, before or after the reload (measured). The worker activates, claims
 * the page and the page reloads within milliseconds, so: once the worker is activated, mark
 * the document, and call it settled when the mark is still there on the next look. A reload
 * takes the mark with it, and the fresh document is marked and looked at again.
 */
export async function appSettled(cdp, S, { timeout = 25000, every = 400 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    let ok = 0;
    try {
      ok = await evalIn(cdp, S, `(async () => {
        if (!("serviceWorker" in navigator)) return 1;
        if (document.readyState !== "complete") return 0;
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg || !reg.active || reg.active.state !== "activated") return 0;
        if (window.__wgpSettled) return 1;
        window.__wgpSettled = 1;
        return 0;
      })()`);
    } catch { /* the document is being replaced: look again */ }
    if (ok) return;
    if (Date.now() > end) throw new Error("timed out: the app shell settling under its service worker");
    await sleep(every);
  }
}

export function INJECT(ins, css) {
  const apply = () => {
    const r = document.documentElement;
    if (!r) return false;
    r.style.setProperty("--sa-top", ins.top + "px");
    r.style.setProperty("--sa-right", ins.right + "px");
    r.style.setProperty("--sa-bottom", ins.bottom + "px");
    r.style.setProperty("--sa-left", ins.left + "px");
    if (css) {
      const put = () => {
        if (!document.head || document.getElementById("wgp-break")) return;
        const s = document.createElement("style");
        s.id = "wgp-break"; s.textContent = css; document.head.appendChild(s);
      };
      put(); document.addEventListener("DOMContentLoaded", put);
    }
    return true;
  };
  if (!apply()) {
    const mo = new MutationObserver(() => { if (apply()) mo.disconnect(); });
    mo.observe(document, { childList: true, subtree: true });
  }
}

/**
 * A HARNESS MUST DRIVE THE BROWSER IT STARTED, AND ONLY THAT ONE.
 *
 * This used to be `--remote-debugging-port=<a number the caller picked>` followed by
 * `fetch("http://127.0.0.1:<that number>/json/version")` — i.e. "talk to whoever answers".
 * Whoever answers is not necessarily ours. A harness that is interrupted (Ctrl-C, a killed
 * agent, a `--keep` flag, an exception outside the try/finally) leaves its headless Chrome
 * ORPHANED and still holding the port; the next run's own Chrome then fails to bind, stays
 * up without a DevTools server, and the fetch above is answered by the ZOMBIE. From there
 * every single thing the run reports is about a page it did not create:
 *
 *   * Page.navigate to a URL that differs only in the fragment is a SAME-DOCUMENT
 *     navigation, so the stale page is not even reloaded — its store still holds the last
 *     run's rows and its network emulation is still whatever that run left switched on.
 *   * Storage.clearDataForOrigin wipes the zombie's IndexedDB, which does nothing to the
 *     in-memory cache the screen is actually rendering.
 *   * A tap at a measured coordinate lands on whatever sheet the dead run left open.
 *
 * Measured, exactly, on 2026-08-22: an orphan parked mid-run made split_harness.mjs report
 * "an empty feed says what to do" against a feed with four rows in it, then throw
 * "type: .sp-amtin does not have focus — activeElement is DIV.sh-sheet" because the FAB tap
 * had landed on the zombie's open drawer. Neither failure was in the app.
 *
 * THE FIX IS TO STOP GUESSING THE PORT. The shared launcher (./browser.mjs) starts the
 * browser on an ephemeral port and reads the real one out of DevToolsActivePort inside a
 * profile directory minted for this launch: a file only OUR process could have written. So
 * collisions between concurrent harnesses stop existing, and an orphan on 9733 is simply
 * irrelevant. `port` is still accepted so no call site has to change; it is ignored.
 */
export async function boot({ vw = 393, vh = 852, dsf = 2, reduceMotion = true, gl = false } = {}) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-v2-"));
  // gl: a software WebGL2 context (SwiftShader), so MapLibre comes up and the map's GL engine
  // is the one under test; without it the map stays on its flat engine.
  const chrome = await launchChrome({ args: [
    ...(gl ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : ["--disable-gpu"]),
    "--disable-features=Translate,MediaRouter", "--force-device-scale-factor=1",
    "--window-size=430,932", `--app=${BASE}/login?boot=0`,
  ] });
  const wsUrl = chrome.wsUrl;
  const cdp = await CDP.connect(wsUrl);
  let targetId = null;
  for (let i = 0; i < 60 && !targetId; i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    targetId = (targetInfos.find((t) => t.type === "page" && t.url.startsWith(BASE)) || {}).targetId || null;
    if (!targetId) await sleep(250);
  }
  if (!targetId) throw new Error("no app-window page target");
  const { sessionId: S } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const pageErrors = [];
  cdp.on((m) => { if (m.sessionId === S && m.method === "Runtime.exceptionThrown")
    pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  await cdp.send("Page.enable", {}, S);
  await cdp.send("Runtime.enable", {}, S);
  await cdp.send("Network.enable", {}, S);
  await cdp.send("Network.setBypassServiceWorker", { bypass: true }, S);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, S);
  // On the gate's server the window starts as the trip's host; signInAs() makes it someone else.
  if (onGate()) for (const c of await (await gateTrip()).signedIn()) await cdp.send("Network.setCookie", c, S);
  await cdp.send("Storage.clearDataForOrigin",
    { origin: BASE, storageTypes: "indexeddb,local_storage,cache_storage,service_workers" }, S);
  const dm = await evalIn(cdp, S, `matchMedia('(display-mode: standalone)').matches`);
  if (!dm) throw new Error("not an app window — display-mode is browser");
  if (reduceMotion) await cdp.send("Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, S);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: vw, height: vh, deviceScaleFactor: dsf, mobile: true }, S);
  let injectedId = null;
  const setInsets = async (ins, css = "") => {
    if (injectedId) await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injectedId }, S);
    const r = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(${INJECT})(${JSON.stringify(ins)}, ${JSON.stringify(css)})`,
    }, S);
    injectedId = r.identifier;
  };
  const metrics = async (w, h, d = dsf) =>
    cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: d, mobile: true }, S);
  const shot = async (file) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, S);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
  };
  // Awaitable: resolves once the browser has exited and its profile is gone. Callers that
  // don't await it are still covered by the launcher's exit handler.
  const done = async () => {
    cdp.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
    await chrome.close();
  };
  return { cdp, S, chrome, TMP, setInsets, metrics, shot, pageErrors, done };
}

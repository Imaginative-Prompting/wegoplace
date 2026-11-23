// A trip's chat, told to a phone, in a browser (Chrome for Testing, the app's own service worker):
//
//   node checks/push/browser.mjs [--port <port>] [--shots <folder>]
//
// Chrome for Testing has no push service, so the browser's subscribe() is stood in by a subscription
// whose address is a stand-in push service on this machine and whose keys this check holds. Everything
// from there is the app's and the server's own: the chat's bell and its panel; turning on (the
// permission granted as a person grants it); the server's send, encrypted for the phone; that message
// delivered to the app's service worker (DevTools' ServiceWorker.deliverPushMessage, as a push
// service delivers one), and the notification it shows; the words switch; the trip's mute; a browser
// that said no; turning off; signing out.
// It holds:
//   1. the bell says where things stand; the panel offers to turn them on, and turning on keeps this
//      phone's subscription on the server for this person;
//   2. a message from someone else reaches the phone; delivered to the worker, the notification says
//      who wrote and in which trip, not what (words off), one per trip, with "Mute this trip";
//   3. with "Show what was said" on, the words; the trip muted (from the panel): nothing reaches the
//      phone, the bell's glyph and word say muted;
//   4. a browser that said no is told so in words, and where to change it;
//   5. turned off: the server forgets this phone; signed out: so does the server, and the browser's
//      own subscription goes;
//   6. no page error. --shots: the panel at 320 and 390, light and dark.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";
import { b64url } from "../../src/push/webpush.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8836);
const shots = flag("--shots");
// --look: the stills at a desktop's 1440 instead, and at 320 with the phone's text a step larger
// (Safari's text size at 115%: the page laid out at 320 / 1.15 = 278 CSS px, drawn on the 320 screen).
const LOOK = argv.includes("--look");
const STILL_SIZES = LOOK
  ? [{ label: "1440", width: 1440, height: 900, scale: 1, mobile: false }, { label: "320-text115", width: 278, height: 557, scale: 2.3, mobile: true }]
  : [{ label: "390", width: 390, height: 844, scale: 2, mobile: true }, { label: "320", width: 320, height: 640, scale: 2, mobile: true }];
if (shots) fs.mkdirSync(shots, { recursive: true });
const t = new Report("a trip's chat, told to a phone, in a browser");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const te = new TextEncoder();
const td = new TextDecoder();
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), data));
const hkdf = async (salt, ikm, info, n) => (await hmac(await hmac(salt, ikm), cat(info, new Uint8Array([1])))).slice(0, n);
async function open(body, uaPrivate, uaPublic, auth) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const pub = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, uaPrivate, 256));
  const ikm = await hkdf(auth, shared, cat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const key = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12) }, key, body.slice(21 + idlen)));
  return td.decode(plain.slice(0, plain.lastIndexOf(2)));
}

const got = [];
const standin = http.createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => { got.push({ path: req.url, body: new Uint8Array(Buffer.concat(parts)) }); res.writeHead(201); res.end(); });
});
await new Promise((r) => standin.listen(0, "127.0.0.1", r));
const STANDIN = `http://127.0.0.1:${standin.address().port}`;

/** The browser's subscribe() and getSubscription(), stood in: the subscription a push service would give. */
const standInPush = (endpoint, keys) => `(() => {
  const sub = { endpoint: ${JSON.stringify(endpoint)}, expirationTime: null, options: {},
    toJSON() { return { endpoint: this.endpoint, expirationTime: null, keys: ${JSON.stringify(keys)} }; },
    getKey() { return null; },
    async unsubscribe() { localStorage.setItem("check.push.subscribed", "0"); return true; } };
  const has = () => localStorage.getItem("check.push.subscribed") === "1";
  if (self.PushManager) {
    PushManager.prototype.subscribe = async function () { localStorage.setItem("check.push.subscribed", "1"); return sub; };
    PushManager.prototype.getSubscription = async function () { return has() ? sub : null; };
  }
})();`;

let server, chrome, code = 1;
try {
  const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);
  server = await startServer({ name: "push-browser", port, vars: { PUSH_TEST_ORIGIN: STANDIN },
    secrets: { VAPID_PUBLIC_KEY: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", vapidPair.publicKey))), VAPID_PRIVATE_KEY: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y }) } });
  await server.start();
  const { origin } = server;
  const sql = (q) => server.sql(q);
  const [ada, ben, cleo] = ["Ada Reyes", "Ben Okafor", "Cleo Tran"].map((n) => new Person(origin, n));
  for (const p of [ada, ben, cleo]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const trip = (await ada.post("/api/trips", { name: "Coast week", default_tz: "UTC" })).json.trip.id;
  for (const p of [ben, cleo]) await p.post(`/api/join/${(await ada.post(`/api/trips/${trip}/links`, { uses: 1 })).json.link.code}`);

  // Ben's phone: its subscription keys, held here to open what it is sent.
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const keys = { p256dh: b64url(pub), auth: b64url(auth) };
  const endpoint = `${STANDIN}/ok/ben`;

  chrome = await openChrome();
  const phone = async (p, before) => {
    const page = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false, serviceWorker: true, before });
    await page.setCookie(origin, "wgp_session", p.jar.cookies.get("wgp_session"));
    await page.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(p.user.id), sameSite: "Lax" });
    return page;
  };
  const pb = await phone(ben, standInPush(endpoint, keys));
  // The worker's registration, for delivering a push to it as a push service would.
  const regs = [];
  pb.on((m) => { if (m.method === "ServiceWorker.workerRegistrationUpdated") regs.push(...m.params.registrations); });
  await pb.send("ServiceWorker.enable");
  await pb.send("Browser.grantPermissions", { permissions: ["notifications"], origin, browserContextId: pb.context });
  const panelOf = (page) => page.eval(`JSON.stringify({ bell: document.querySelector(".ch-bell")?.textContent.trim(), label: document.querySelector(".ch-bell")?.getAttribute("aria-label"),
    line: document.querySelector(".ch-n-line")?.textContent.trim() ?? null, buttons: [...document.querySelectorAll(".ch-notify button")].map((b) => b.textContent.trim()),
    switches: [...document.querySelectorAll(".ch-n-switch")].map((l) => [l.querySelector("b").textContent, l.querySelector("input").checked]),
    said: document.querySelector(".ch-n-said")?.textContent.trim() ?? null })`).then(JSON.parse);
  const shoot = async (page, name) => {
    if (!shots) return;
    for (const size of STILL_SIZES) for (const scheme of ["light", "dark"]) {
      const w = size.label;
      await page.size({ width: size.width, height: size.height, mobile: size.mobile });
      await page.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: size.mobile });
      await page.scheme(scheme);
      await sleep(350);
      fs.writeFileSync(path.join(shots, `${name}-${w}-${scheme}.png`), Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    }
    await page.size({ width: 390, height: 844, mobile: true });
    await page.scheme("light");
  };

  t.part("1. The bell, and turning on");
  await pb.open(`${origin}/t/${trip}/#/chat`);
  await pb.until(`!!document.querySelector(".ch-bell") && !!navigator.serviceWorker.controller`, "the chat, under the app's worker", 30000).catch(async () => {
    await pb.open(`${origin}/t/${trip}/#/chat`);
    await pb.until(`!!document.querySelector(".ch-bell")`, "the chat", 20000);
  });
  await sleep(500);
  await pb.click(".ch-bell");
  await pb.until(`!!document.querySelector(".ch-n-line")`, "the panel", 10000);
  await sleep(400);
  const first = await panelOf(pb);
  t.same("the bell says Notify; its panel says what turning on does, and offers it; the trip's mute beside it",
    [first.bell, first.line, first.buttons, first.switches], ["Notify", "Get told on this phone when someone else writes in this trip's chat.", ["Turn on notifications"], [["Mute this trip's chat", false]]]);
  t.ok("the empty message box has nothing to scroll (no scrollbar can flash at its edge)",
    await pb.eval(`(() => { const i = document.querySelector(".ch-input"); return i.scrollHeight <= i.clientHeight && getComputedStyle(i).overflowY === "hidden"; })()`),
    await pb.eval(`(() => { const i = document.querySelector(".ch-input"); return JSON.stringify([i.scrollHeight, i.clientHeight, getComputedStyle(i).overflowY]); })()`));
  await shoot(pb, "1-panel-ask");
  await pb.click('[data-act="push-on"]');
  await pb.until(`document.querySelector(".ch-n-line")?.dataset.state === "on"`, "turned on", 15000);
  const on = await panelOf(pb);
  const row = sql(`SELECT endpoint, words FROM push_subscriptions WHERE user_id = '${ben.user.id}'`);
  t.same("turned on: the server keeps this phone for Ben; the panel says so, offers the words and turning off; the bell says On",
    [row, on.line, on.buttons, on.switches.map((s) => s[0]), on.bell], [[{ endpoint, words: 0 }], "On for this phone: you're told when someone else writes.", ["Turn off for this phone"],
      ["Show what was said on the lock screen", "Mute this trip's chat"], "On"]);
  await shoot(pb, "2-panel-on");

  t.part("2. A message from someone else, to the phone, and its notification");
  const said = async (who, id, body) => { const before = got.length; await who.post(`/api/trips/${trip}/messages`, { id, body }); for (let i = 0; i < 40 && got.length === before; i++) await sleep(100); await sleep(300); return got.slice(before); };
  const one = await said(ada, "m-1", "Bring cash, the boat takes no cards");
  const opened = one.length === 1 ? JSON.parse(await open(one[0].body, pair.privateKey, pub, auth)) : null;
  t.same("Ada's message reaches Ben's phone once, saying who and where, not what", [one.length, opened?.notification?.title, opened?.notification?.body],
    [1, "Ada Reyes wrote in Coast week", "Open the chat to read it."]);
  const reg = regs.find((r) => r.scopeURL === `${origin}/` && !r.isDeleted) ?? regs[0];
  if (!reg) throw new CheckError("the app's service worker never registered");
  await pb.send("ServiceWorker.deliverPushMessage", { origin, registrationId: reg.registrationId, data: JSON.stringify(opened) });
  await sleep(1200);
  const shown = JSON.parse(await pb.eval(`navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((ns) => JSON.stringify(ns.map((n) => ({ title: n.title, body: n.body, tag: n.tag, actions: (n.actions || []).map((a) => [a.action, a.title]), url: n.data?.url }))))`));
  t.same("delivered to the app's worker, it shows one notification: who and where, one per trip, with \"Mute this trip\", opening the trip's chat",
    shown.map((n) => [n.title, n.body, n.tag, n.actions, n.url]), [["Ada Reyes wrote in Coast week", "Open the chat to read it.", `chat:${trip}`, [["mute", "Mute this trip"]], `${origin}/t/${trip}/#/chat`]]);

  t.part("3. The words, and the trip muted");
  await pb.click('[data-act="push-words"]');
  await pb.until(`document.querySelector('[data-act="push-words"]')?.checked === true && !document.querySelector('[data-act="push-words"]').disabled`, "the words switch on", 10000);
  const withWords = await said(ada, "m-2", "I'll get the tickets");
  const w = withWords.length ? JSON.parse(await open(withWords[0].body, pair.privateKey, pub, auth)) : null;
  t.same("with \"Show what was said\" on: the server keeps it for this phone, and the next one carries the words",
    [sql(`SELECT words FROM push_subscriptions WHERE user_id = '${ben.user.id}'`)[0]?.words, w?.notification?.body], [1, "I'll get the tickets"]);
  await pb.send("ServiceWorker.deliverPushMessage", { origin, registrationId: reg.registrationId, data: JSON.stringify(w) });
  await sleep(1200);
  const shownWords = JSON.parse(await pb.eval(`navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((ns) => JSON.stringify(ns.map((n) => ({ title: n.title, body: n.body, tag: n.tag, actions: (n.actions || []).map((a) => [a.action, a.title]) }))))`));
  t.same("  delivered, it replaces the trip's notification (one per trip), now with the words",
    shownWords.map((n) => [n.title, n.body, n.tag]), [["Ada Reyes wrote in Coast week", "I'll get the tickets", `chat:${trip}`]]);
  console.log(`    the notification, with the words: ${JSON.stringify(shownWords[0] ?? null)}`);
  await pb.click('[data-act="mute"]');
  await pb.until(`document.querySelector('[data-act="mute"]')?.checked === true && !document.querySelector('[data-act="mute"]').disabled`, "muted", 10000);
  const mutedPanel = await panelOf(pb);
  const quiet = await said(ada, "m-3", "Who's in for the market?");
  t.same("the trip muted from the panel: the server has it, nothing reaches the phone, the bell's glyph and word say so",
    [sql(`SELECT chat_muted FROM trip_members WHERE trip_id = '${trip}' AND user_id = '${ben.user.id}'`)[0]?.chat_muted, quiet.length, mutedPanel.bell, mutedPanel.label, mutedPanel.said],
    [1, 0, "Muted", "Notifications: this trip's chat is muted", null]);
  t.same("  (muted is said once: under its switch, not again below)", (await pb.eval(`document.querySelector(".ch-notify").innerText.match(/Muted/g)?.length ?? 0`)), 1);
  await shoot(pb, "3-panel-muted");
  await pb.click('[data-act="mute"]');
  await pb.until(`document.querySelector('[data-act="mute"]')?.checked === false && !document.querySelector('[data-act="mute"]').disabled`, "unmuted", 10000);

  t.part("4. A browser that said no");
  const pc = await phone(cleo, standInPush(`${STANDIN}/ok/cleo`, keys));
  await pc.send("Browser.setPermission", { permission: { name: "notifications" }, setting: "denied", origin, browserContextId: pc.context });
  await pc.open(`${origin}/t/${trip}/#/chat`);
  await pc.until(`!!document.querySelector(".ch-bell")`, "Cleo's chat", 30000);
  await pc.click(".ch-bell");
  await pc.until(`document.querySelector(".ch-n-line")?.dataset.state === "blocked"`, "the panel, blocked", 30000).catch(() => {});  // the line below fails if it never comes
  const blocked = await panelOf(pc);
  t.same("told in words that this browser blocks them, and where to allow them; nothing to press that can't work",
    [blocked.line, blocked.buttons], ["Notifications are blocked for WeGoPlace in this browser's settings. Allow them there, then come back here.", []]);
  await shoot(pc, "4-panel-blocked");

  t.part("4b. Every other state, said in words");
  const states = [
    ["off", "This site doesn't send notifications.",
      `(() => { const f = window.fetch; window.fetch = (u, o) => String(u).endsWith("/api/account/push") && (!o || !o.method || o.method === "GET") ? Promise.resolve(new Response(JSON.stringify({ error: "push off", reason: "x" }), { status: 503, headers: { "Content-Type": "application/json" } })) : f(u, o); })();`, null],
    ["unsupported", "This browser can't show notifications.", "delete window.PushManager;", null],
    ["install", "To be told on an iPhone or iPad, add WeGoPlace to your Home Screen first (Share, then Add to Home Screen), open it from there, and turn notifications on here.",
      "delete window.PushManager;", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"],
  ];
  for (const [state, words, before, ua] of states) {
    const p = await phone(cleo, before);
    if (ua) await p.send("Emulation.setUserAgentOverride", { userAgent: ua, platform: "iPhone" });
    await p.open(`${origin}/t/${trip}/#/chat`);
    await p.until(`!!document.querySelector(".ch-bell")`, `the chat (${state})`, 30000);
    await p.click(".ch-bell");
    await p.until(`document.querySelector(".ch-n-line")?.dataset.state === ${JSON.stringify(state)}`, `the panel (${state})`, 30000).catch(() => {});  // the line below fails if it never comes
    const seen = await panelOf(p);
    t.same(`${state}: said in words, with nothing to press that can't work, and the trip's mute still there`, [seen.line, seen.buttons, seen.switches.map((x) => x[0])], [words, [], ["Mute this trip's chat"]]);
    await shoot(p, `5-panel-${state}`);
    t.ok(`  (no page error, ${state})`, p.errors.length === 0, JSON.stringify(p.errors.slice(0, 2)));
  }
  // The notifications as the worker shows them (the phone draws them; these are their words).
  console.log(`    the notification, default: ${JSON.stringify(shown[0] ?? null)}`);

  t.part("5. Turned off, and signed out");
  await pb.click('[data-act="push-off"]');
  await pb.until(`document.querySelector(".ch-n-line")?.dataset.state === "ask"`, "turned off", 10000);
  t.same("turned off: the server forgets this phone, the panel offers to turn on again", [sql(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = '${ben.user.id}'`)[0].n, (await panelOf(pb)).buttons], [0, ["Turn on notifications"]]);
  await pb.click('[data-act="push-on"]');
  await pb.until(`document.querySelector(".ch-n-line")?.dataset.state === "on"`, "on again", 15000);
  await pb.open(`${origin}/account`);
  await pb.until(`!document.getElementById("account").hidden`, "the account page", 20000);
  await pb.click("#btn-signout");
  await sleep(300);
  if (await pb.eval(`!!document.querySelector("#btn-signout.lg-armed")`)) await pb.click("#btn-signout");
  await pb.until(`location.pathname === "/login"`, "signed out", 20000);
  t.same("signed out: the server forgets this phone, and the browser lets its subscription go",
    [sql(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = '${ben.user.id}'`)[0].n, await pb.eval(`localStorage.getItem("check.push.subscribed")`)], [0, "0"]);

  t.ok("no page error", pb.errors.length === 0 && pc.errors.length === 0, JSON.stringify([...pb.errors, ...pc.errors].slice(0, 3)));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  standin.close();
  await chrome?.close();
  await server?.stop();
}
process.exit(code);

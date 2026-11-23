// This phone's notifications of new chat messages: the page's side of Web Push (the server's is
// src/push/routes.js, the worker's public/js/push-sw.js). The chat's header draws what it answers.
//
//   pushState()        where this phone stands: { state, words } with state one of
//                        "off"         the site sends no notifications (no push keys)
//                        "unsupported" this browser can't show them
//                        "install"     an iPhone or iPad's Safari: only the Home Screen app can
//                        "blocked"     the person said no, in this browser's settings
//                        "ask"         not asked yet, or turned off here
//                        "on"          this phone is told
//   turnOn({ words })  asks the browser (the prompt is the browser's), subscribes, tells the server
//   turnOff()          unsubscribes here and tells the server
//   setWords(words)    whether this phone's lock screen shows what was said
//   keepCurrent()      a subscription the browser holds, told to the server again (keys rotate)
//
// Nothing here is queued for later: each answer says what happened, and with no signal it says so.

import { fetchWithin } from "./net.js";

const ACCOUNT_PUSH = "/api/account/push";

const call = async (method, body) => {
  const res = await fetchWithin(ACCOUNT_PUSH, {
    method, credentials: "same-origin",
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
};

const fromB64url = (text) => {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/** An iPhone or iPad in Safari, not the Home Screen app (where Web Push lives on iOS). */
function iosBrowser() {
  const ua = navigator.userAgent || "";
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  return ios && !installed;
}

let keyCache = null;
async function serverKey() {
  if (keyCache) return keyCache;
  const r = await call("GET");
  if (r.status === 503) return (keyCache = { off: true });
  if (r.status !== 200 || !r.json?.key) throw new Error(r.json?.reason || `The server didn't answer (${r.status}).`);
  return (keyCache = { key: r.json.key });
}

async function registration() {
  if (!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.ready;
}

const WORDS_KEY = "wgp.push.words";
const wordsHere = () => { try { return localStorage.getItem(WORDS_KEY) === "1"; } catch { return false; } };
const keepWords = (on) => { try { localStorage.setItem(WORDS_KEY, on ? "1" : "0"); } catch { /* private mode */ } };

export async function pushState() {
  if (iosBrowser() && !("PushManager" in self)) return { state: "install", words: false };
  if (!("serviceWorker" in navigator) || !("PushManager" in self) || !("Notification" in self)) {
    return { state: iosBrowser() ? "install" : "unsupported", words: false };
  }
  let key;
  try { key = await serverKey(); } catch { key = null; }
  if (key?.off) return { state: "off", words: false };
  if (Notification.permission === "denied") return { state: "blocked", words: false };
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (Notification.permission === "granted" && sub) return { state: "on", words: wordsHere() };
  return { state: "ask", words: wordsHere() };
}

/** Turns this phone's notifications on: the browser's prompt, its subscription, the server told. */
export async function turnOn({ words = false } = {}) {
  const key = await serverKey();
  if (key.off) throw new Error("This site doesn't send notifications.");
  const answer = await Notification.requestPermission();
  if (answer !== "granted") return { state: answer === "denied" ? "blocked" : "ask" };
  const reg = await registration();
  if (!reg) throw new Error("This browser can't show notifications.");
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(key.key) });
  const r = await call("PUT", { ...sub.toJSON(), words });
  if (r.status !== 200) {
    await sub.unsubscribe().catch(() => {});
    throw new Error(r.json?.reason || `The server didn't take it (${r.status}).`);
  }
  keepWords(!!r.json.words);
  return { state: "on", words: !!r.json.words };
}

export async function turnOff() {
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return { state: "ask" };
  const r = await call("DELETE", { endpoint: sub.endpoint });
  if (r.status !== 200) throw new Error(r.json?.reason || `The server didn't answer (${r.status}).`);
  await sub.unsubscribe().catch(() => {});
  return { state: "ask" };
}

export async function setWords(words) {
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return { state: "ask", words: false };
  const r = await call("PUT", { ...sub.toJSON(), words });
  if (r.status !== 200) throw new Error(r.json?.reason || `The server didn't take it (${r.status}).`);
  keepWords(!!r.json.words);
  return { state: "on", words: !!r.json.words };
}

/** A subscription this browser holds, told again: the server has its current keys and this phone's words. */
export async function keepCurrent() {
  try {
    if (!("PushManager" in self) || Notification.permission !== "granted") return;
    const reg = await registration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) await call("PUT", { ...sub.toJSON(), words: wordsHere() });
  } catch { /* no signal: the next open tells it */ }
}

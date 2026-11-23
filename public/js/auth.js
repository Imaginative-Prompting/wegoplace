// Accounts in the browser: the client for src/accounts/ (exported, no page of its own), the small
// pieces the sign-in page and the account page both draw with, and at the bottom the sign-in
// page's controller, which runs only when login.html is the document.
//
// The routes, as src/accounts/ answers them:
//   GET  /api/auth/config                    -> { name, providers: { google, github }, signups, email }
//   POST /api/auth/login/options    { username? }   -> request options      sets the challenge cookie
//   POST /api/auth/login/verify     <the device's answer>  -> { ok, user }   signs in
//   POST /api/auth/register/options { name }        -> creation options
//   POST /api/auth/register/verify  <the device's answer>  -> { ok, user }   makes the account, signs in
//   POST /api/auth/passkeys/options {}              -> creation options      (signed in)
//   POST /api/auth/passkeys/verify  <the device's answer>  -> { ok }
//   POST /api/auth/logout, /api/auth/logout/all
//   GET  /api/me                                    -> { id, name, initials, note_color, … } | 401
// Google and GitHub are plain form posts to /login/<provider>; they come back by redirect.
//
// A challenge waits on the server for five minutes under a cookie, and asking for another
// replaces it. So one passkey flow runs at a time, and a challenge fetched ahead has a shelf life.
//
// Leaving (signing out here, everywhere, or deleting the account) takes what this phone keeps
// about the person with it (js/forget.js), and only once the server has said yes: a request
// that fails clears nothing. Before it, the page counts the changes not yet sent and, if there
// are any, asks twice and says how many.

import { forgetThisPhone, waitingChanges, waitingWords } from "./forget.js";
import { GUEST_LEAVING, guestLine, placeWord } from "./guest.js";
import { within, fetchWithin } from "./net.js";

// ── base64url ──────────────────────────────────────────────────────────────────────────
// One encoder and one decoder for every buffer, both ways. A passkey is found on the server by
// the exact text of its id, so an id spelled in standard base64, or with padding, is a passkey
// that matches nothing and a person who can't sign in.
export function b64u(buf) {
  if (buf == null) return undefined;                // a sign-in answer may carry no account handle
  const b = ArrayBuffer.isView(buf)
    ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    : new Uint8Array(buf);
  let s = "";
  // In pieces: String.fromCharCode.apply with a few thousand arguments overflows Safari's stack.
  for (let i = 0; i < b.length; i += 0x400) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x400));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A display name as the server keeps it (src/accounts/util.js cleanName), or null. */
export function cleanName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  // eslint-disable-next-line no-control-regex
  return name && [...name].length <= 40 && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

// ── errors ─────────────────────────────────────────────────────────────────────────────
// Every failure a page can meet arrives as one of these, carrying words a person can act on.
// `detail` is the short machine tail, shown small under the message.
export class AuthError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.detail = detail || "";
  }
}

// What the server's short error codes mean, in words. The server never sends sentences.
const SERVER_WORDS = {
  "name": ["name", "Type a name, up to 40 characters."],
  "bad name": ["name", "Type a name, up to 40 characters."],
  "expired": ["expired", "That took longer than five minutes, so it ran out. Try again: it starts over at once."],
  "malformed": ["server", "Your device sent back something this site couldn't read. Try once more."],
  "not verified": ["server", "That passkey didn't check out. Try again."],
  "unknown passkey": ["no-account", "That passkey isn't for an account here. If you're new, create an account below."],
  "unknown username": ["no-account", "No account from before signs in by that username. Check the spelling, or sign in another way."],
  "already registered": ["already-registered", "This passkey is already on an account. Sign in with it instead."],
  "signups paused": ["paused", "New accounts are paused for now. If you already have one, you can still sign in."],
  "too many": ["busy", "Too many tries from this connection. Wait a minute, then try again."],
  "too many codes": ["busy", "That's the limit of codes for now. Try again in an hour."],
  "cross site": ["server", "That request didn't come from this page. Reload it and try again."],
  "last way": ["last-way", "That's the only way you can sign in. Add another way first, then remove this one."],
  "host": ["host", "You host a trip other people are on. Offer it to one of them and, once they accept, this account can be deleted; or delete the trip."],
  "confirm": ["server", "That wasn't confirmed. Try again."],
  "no email": ["no-email", "This site doesn't send account email."],
  "bad email": ["bad-email", "That doesn't look like an email address."],
  "send failed": ["server", "The email couldn't be sent. Try again in a moment."],
  "wrong code": ["wrong-code", "That isn't the code."],
  "code used up": ["code-used", "That code can't be used any more. Ask for a new one."],
  "email taken": ["email-taken", "That address is already on another account."],
  "taken": ["taken", "That sign-in was added to another account in the meantime."],
  "no trip": ["no-trip", "This account isn't on a trip."],
  "unauthorized": ["signed-out", "This browser isn't signed in any more."],
};

const listWords = (items) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

export function serverError(body, status) {
  const key = String(body?.error || "");
  let [code, message] = SERVER_WORDS[key] || (status === 401
    ? SERVER_WORDS.unauthorized
    : ["server", "The server refused that. Try again in a moment."]);
  if (key === "wrong code" && Number.isInteger(body?.left)) message += body.left === 1 ? " One try left." : ` ${body.left} tries left.`;
  // Which trips, by name: the answer lists each trip this account hosts that others are on.
  if (key === "host" && Array.isArray(body?.trips) && body.trips.length) {
    const names = listWords(body.trips.map((t) => `“${t.name}”`));
    message = body.trips.length === 1
      ? `You host ${names}, and other people are on it. Offer it to one of them and, once they accept, this account can be deleted; or delete the trip.`
      : `You host ${names}, and other people are on them. Offer each to someone on it and, once they accept, this account can be deleted; or delete those trips.`;
  }
  return new AuthError(code, message, `${key || "no reason given"} · HTTP ${status}`);
}

// What a round trip to Google or GitHub, or a one-use link, ended with: the pages are sent back
// with a short code in the address (?error= on the sign-in page, ?signin= on the account page;
// ?done=deleted is the account page's own, after an account is deleted).
const PROVIDER_NAMES = { google: "Google", github: "GitHub" };
export const providerName = (id) => PROVIDER_NAMES[id] || "that sign-in";
export function resultWords(code, provider, kept) {
  const who = providerName(provider);
  switch (code) {
    case "cancelled": return ["info", `You didn't finish signing in with ${who}. Nothing changed.`];
    case "expired": return ["err", `That trip to ${who} took too long or didn't start here. Try again.`];
    case "provider": return ["err", `${who} didn't confirm who you are. Try again in a moment.`];
    case "busy": return ["err", "Too many tries from this connection. Wait a minute, then try again."];
    case "unavailable": return ["err", `Signing in with ${who} isn't offered here.`];
    // Sent here from another of the site's addresses (www): Google and GitHub come back only to
    // this one (src/accounts/providers.js), so the sign-in starts again here.
    case "elsewhere": return ["info", `Signing in with ${who} happens at ${location.host}, where you are now. Choose ${who} again to go on.`];
    case "signed-out": return ["err", "This browser isn't signed in any more. Sign in, then try again."];
    case "paused": return ["err", `Nobody here signs in with that ${who} account yet, and new accounts are paused for now.`];
    case "unknown": return ["info", `Nobody here signs in with that ${who} account either. It's waiting too: create an account with both, or sign in to the one you have.`];
    case "added": return ["ok", `${who} added. You can sign in with it from now on.`];
    case "already": return ["info", `That ${who} account is already one of your ways to sign in.`];
    case "taken": return ["err", `That ${who} account already signs in to a different account here.`];
    case "link": return ["ok", "You're signed in with the link. Add a passkey on this device now, so you don't need another link."];
    // Not "on any phone": a passkey kept on this device alone (its row says "On one device only") signs in here.
    case "kept": return ["ok", "Passkey added. Your place is kept now: signing out no longer loses it."];
    case "recovered": return ["ok", "You're back in. Add a passkey on this device now, so you don't need a code next time."];
    case "deleted": return ["ok", "Your account is deleted."];
    case "uncleared": return ["err", `You're signed out, but ${unclearedWords(kept)}`];
    case "deleted-uncleared": return ["err", `Your account is deleted, but ${unclearedWords(kept)}`];
    default: return null;
  }
}

// What navigator.credentials refuses with. The names are a fixed set and each means something
// different to the person holding the device.
function webauthnError(err, mode) {
  const d = `${err?.name || "Error"}: ${err?.message || err}`;
  switch (err?.name) {
    case "NotAllowedError":
    case "AbortError":
      // The browser deliberately doesn't say whether the prompt was dismissed or the device has
      // no passkey for this site: telling a website which would tell it who has an account.
      return new AuthError("cancelled", mode === "create"
        ? "The passkey prompt was closed, so nothing was made. Try again when you're ready."
        : "No passkey was used. Either the prompt was closed, or this device doesn't have one for this site.", d);
    case "InvalidStateError":
      return new AuthError("already-registered", "This device already has a passkey for your account.", d);
    case "NotSupportedError":
      return new AuthError("unsupported", "This browser can't make the kind of passkey this site uses. A current Safari, Chrome, Edge or Firefox can.", d);
    case "ConstraintError":
      return new AuthError("no-screen-lock", "This device has no screen lock set up yet. Turn one on, then come back.", d);
    case "SecurityError":
      return new AuthError("bad-origin", `Passkeys don't work at this address (${location.hostname}). Open the site at its own https:// address.`, d);
    default:
      return new AuthError("unknown", "Your device couldn't finish the passkey step. Try again.", d);
  }
}

// ── transport ──────────────────────────────────────────────────────────────────────────
export async function api(method, path, body) {
  let res;
  try {
    res = await fetchWithin(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    // fetch rejects only when nothing got through; every HTTP status resolves.
    throw new AuthError("offline", "No connection. This needs one.", String(e?.message || e));
  }
  let parsed = null;
  try { parsed = await res.json(); } catch { /* an empty body is fine */ }
  return { status: res.status, body: parsed || {} };
}

/** The same, throwing an AuthError in words for anything but a 2xx. */
export async function call(method, path, body) {
  const r = await api(method, path, body);
  if (r.status < 200 || r.status > 299) throw serverError(r.body, r.status);
  return r.body;
}

// ── what this browser can do ───────────────────────────────────────────────────────────
export function support() {
  if (typeof window === "undefined") return { ok: false, code: "unsupported", message: "No browser." };
  // Checked first: an insecure page is why the passkey API is missing.
  if (!window.isSecureContext) {
    return { ok: false, code: "insecure", message: "Passkeys need a secure connection. Open the site over https:// and they'll work." };
  }
  if (!window.PublicKeyCredential || !navigator.credentials?.create || !navigator.credentials?.get) {
    return { ok: false, code: "unsupported", message: "This browser doesn't support passkeys. A current Safari, Chrome, Edge or Firefox does." };
  }
  return { ok: true };
}

function requireSupport() {
  const s = support();
  if (!s.ok) throw new AuthError(s.code, s.message);
}

// Only softens words: a device with no built-in authenticator can still use a security key.
export async function hasPlatformAuthenticator() {
  try { return await window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.() ?? false; }
  catch { return false; }
}

/** The words for a device that can't be said to hold one by itself: never a screen lock it hasn't got. */
export const PASSKEY_WORDS = Object.freeze({ short: "a passkey", long: "a passkey" });

/**
 * What this device calls its screen lock: "Face ID" reads better than "your passkey" where it's
 * true. Only where it is: the sign-in page asks the browser first (hasPlatformAuthenticator) and
 * says PASSKEY_WORDS on a device without one, beside the note that says why.
 */
export function deviceWords() {
  const ua = navigator.userAgent;
  return /iPhone|iPod/.test(ua) ? { short: "Face ID", long: "Face ID or Touch ID" }
    : /iPad|Macintosh/.test(ua) ? { short: "Touch ID", long: "Touch ID or Face ID" }
    : /Android/.test(ua) ? { short: "your fingerprint", long: "your fingerprint or screen lock" }
    : { short: "a passkey", long: "your device's screen lock" };
}

// Two passkey prompts can't overlap (the browser refuses the second), and a page's own busy flag
// doesn't cover a double tap on a slow screen. The first is cancelled here.
let pendingCall = null;
function freshSignal() {
  if (pendingCall) pendingCall.abort();
  pendingCall = new AbortController();
  return pendingCall.signal;
}

// ── to and from the browser's passkey shapes ───────────────────────────────────────────
function decodeRequestOptions(o) {
  return {
    ...o,
    challenge: unb64u(o.challenge),
    allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: unb64u(c.id) })),
  };
}

function decodeCreationOptions(o) {
  return {
    ...o,
    challenge: unb64u(o.challenge),
    user: { ...o.user, id: unb64u(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: unb64u(c.id) })),
  };
}

function extensionResults(cred) {
  try { return cred.getClientExtensionResults?.() ?? {}; } catch { return {}; }
}

// The id is spelled from rawId here even though the browser gives one: both then come from the
// same bytes, in this file's one spelling.
export function serializeAssertion(cred) {
  const r = cred.response;
  return {
    id: b64u(cred.rawId),
    rawId: b64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: b64u(r.clientDataJSON),
      authenticatorData: b64u(r.authenticatorData),
      signature: b64u(r.signature),
      userHandle: b64u(r.userHandle),
    },
    clientExtensionResults: extensionResults(cred),
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
  };
}

export function serializeAttestation(cred) {
  const r = cred.response;
  let transports = [];
  try { transports = r.getTransports?.() || []; } catch { /* an older browser */ }
  return {
    id: b64u(cred.rawId),
    rawId: b64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: b64u(r.clientDataJSON),
      attestationObject: b64u(r.attestationObject),
      transports,
    },
    clientExtensionResults: extensionResults(cred),
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
  };
}

// ── a sign-in challenge fetched ahead ──────────────────────────────────────────────────
// Sign-in options are fetched before anyone taps. Safari only shows the passkey sheet while the
// page still holds the tap that asked for it, and a slow fetch between the tap and the sheet can
// outlast that: the sheet never appears, with an error that reads like a cancel. It is also
// faster. Each fetch replaces the server's challenge, so none runs while a prompt is up.
const PRIME_TTL = 240e3;          // the server keeps a challenge 300 s
let primed = null;                // { options, at }
let holdPrime = false;
let primeInFlight = null;

export async function primeSignIn() {
  if (holdPrime || primeInFlight) return primeInFlight || undefined;
  if (primed && Date.now() - primed.at < PRIME_TTL) return undefined;
  primeInFlight = (async () => {
    try {
      const { status, body } = await api("POST", "/api/auth/login/options", {});
      if (status === 200) primed = { options: body, at: Date.now() };
    } catch { /* offline: the tap will say so */ }
    finally { primeInFlight = null; }
  })();
  return primeInFlight;
}

function takePrimed() {
  if (!primed) return null;
  const fresh = Date.now() - primed.at < PRIME_TTL;
  const o = primed.options;
  primed = null;                  // used once either way
  return fresh ? o : null;
}

// ── the flows ──────────────────────────────────────────────────────────────────────────

async function prompt(kind, options) {
  let cred;
  try {
    cred = kind === "create"
      ? await navigator.credentials.create({ publicKey: decodeCreationOptions(options), signal: freshSignal() })
      : await navigator.credentials.get({ publicKey: decodeRequestOptions(options), signal: freshSignal() });
  } catch (e) {
    throw webauthnError(e, kind);
  } finally {
    pendingCall = null;
  }
  if (!cred) throw new AuthError("cancelled", "No passkey was used. Try again.");
  return cred;
}

/**
 * Sign in with a passkey. With no username the device offers the passkeys it holds for this
 * site. `username` is for an account from before open sign-up whose device can't find its
 * passkey that way: the server then names that account's passkeys.
 */
export async function signIn({ username } = {}) {
  requireSupport();
  holdPrime = true;
  try {
    // A fetch-ahead that started just before the tap would land its cookie after this flow's.
    if (primeInFlight) await primeInFlight;
    const options = (username ? null : takePrimed()) ?? await call("POST", "/api/auth/login/options", username ? { username } : {});
    const cred = await prompt("get", options);
    return (await call("POST", "/api/auth/login/verify", serializeAssertion(cred))).user;
  } finally {
    holdPrime = false;
  }
}

/** Make an account: a name and a new passkey. Nothing is kept until the passkey checks out. */
export async function register({ name }) {
  requireSupport();
  holdPrime = true;
  try {
    const options = await call("POST", "/api/auth/register/options", { name });
    const cred = await prompt("create", options);
    return (await call("POST", "/api/auth/register/verify", serializeAttestation(cred))).user;
  } finally {
    holdPrime = false;
  }
}

/** Another passkey, on this device, for the account that is signed in. */
export async function addPasskey() {
  requireSupport();
  holdPrime = true;
  try {
    const options = await call("POST", "/api/auth/passkeys/options", {});
    const cred = await prompt("create", options);
    await call("POST", "/api/auth/passkeys/verify", serializeAttestation(cred));
  } finally {
    holdPrime = false;
  }
}

/** Who is signed in, or null. Anything else throws: a caller must tell signed out from no connection. */
export async function me() {
  const { status, body } = await api("GET", "/api/me");
  if (status === 401) return null;
  if (status !== 200) throw serverError(body, status);
  return body;
}

/**
 * This browser's push subscription, forgotten by the server while the session can still say whose it
 * is (signing out ends that). Best effort: forgetThisPhone lets the browser's own go either way.
 */
async function forgetPushHere() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    const sub = await reg?.pushManager?.getSubscription?.();
    if (sub) await within("DELETE", (signal) => fetch("/api/account/push", { method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }), signal }));
  } catch { /* no signal: the browser lets it go below, and the next send finds it gone */ }
}

/**
 * Signs this browser out, then clears this phone. Throws, clearing nothing, when the server
 * didn't say yes. Answers forgetThisPhone's { ok, failed }.
 */
export async function signOut() {
  await forgetPushHere();
  await call("POST", "/api/auth/logout", {});
  primed = null;
  return forgetThisPhone();
}

/** The same for every browser the account is signed in on. */
export async function signOutEverywhere() {
  await call("POST", "/api/auth/logout/all", {});
  primed = null;
  return forgetThisPhone();
}

/** Deletes the account, then clears this phone. Throws, clearing nothing, when it was refused. */
export async function deleteAccount() {
  await call("DELETE", "/api/me", { confirm: "delete" });
  primed = null;
  return forgetThisPhone();
}

/**
 * The second ask of a button that leaves, for askTwice: `again`, after how many changes made
 * on this phone haven't been sent when there are any. Without `always`, a button that doesn't
 * otherwise ask asks only then. With `guest` (a function) answering true, it always asks, and
 * says the guest's place goes too.
 */
export function leavingWords(again, { always = true, guest = null } = {}) {
  return async () => {
    // A guest (js/guest.js) has no way back in but this browser: for them it always asks, in
    // words that say their place goes with it. `guest` is asked at the press, not before.
    const asGuest = typeof guest === "function" && !!guest();
    const words = asGuest ? GUEST_LEAVING : again;
    const waiting = waitingWords(await waitingChanges());
    if (waiting) return `${waiting}. ${words}`;
    return always || asGuest ? words : "";
  };
}

/**
 * Where a page goes once the person has left: the sign-in page (`to`, which may carry a
 * `next`), which says so (`done`) and, when this phone couldn't be fully cleared, says what it
 * may still hold.
 */
export function afterLeaving(cleared, done = "", to = "/login") {
  const [path, search = ""] = to.split("?");
  const q = new URLSearchParams(search);
  if (cleared && !cleared.ok) {
    q.set("done", done ? `${done}-uncleared` : "uncleared");
    q.set("kept", (cleared.failed || []).join(","));
  } else if (done) {
    q.set("done", done);
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

// What forgetThisPhone names, in words. A name from the address that isn't here is said as
// "other things it stored", so nothing typed into an address is shown.
const KEPT_WORDS = {
  "wegoplace": "stored trips and changes not yet sent",
  "wegoplace-pack": "the packing list",
  "wegoplace-memories": "the memories feed",
  "wegoplace-media-v1": "kept pictures",
  "localStorage": "remembered choices",
};

/** "this phone couldn't be fully cleared: … may still be on it. …", for what `kept` names. */
export function unclearedWords(kept) {
  const names = [];
  for (const k of String(kept || "").split(",").filter(Boolean)) {
    const w = KEPT_WORDS[k] || "other things it stored";
    if (!names.includes(w)) names.push(w);
  }
  if (!names.length) names.push("some of what it stored");
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `this phone couldn't be fully cleared: ${list} may still be on it. Clearing this site's data in the browser's settings removes what's left.`;
}

/**
 * What this site offers: { name, providers: { google, github }, signups: "open" | "paused", email }. One failed call
 * never decides "no Google": it's asked again after a moment, and if that fails too every way is shown (a press on one
 * goes to /login/<provider>, which signs in or says why), never the passkey button alone.
 */
export async function siteConfig() {
  for (let tries = 2; ; tries--) {
    try { return await call("GET", "/api/auth/config"); }
    catch { if (tries <= 1) break; await new Promise((r) => setTimeout(r, 1200)); }
  }
  return { providers: { google: true, github: true }, signups: "open", email: false };
}

/**
 * A trip's dates in words ("2 – 9 Apr 2027"), or "" when they aren't set. They are days, not
 * moments, so they are read as UTC and no time zone moves them.
 */
export function tripDates(startsOn, endsOn) {
  if (!startsOn || !endsOn) return "";
  const at = (day) => new Date(`${day}T00:00:00Z`);
  const fmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  try { return fmt.formatRange(at(startsOn), at(endsOn)); }
  catch { return `${fmt.format(at(startsOn))} – ${fmt.format(at(endsOn))}`; }
}

/**
 * Where to go after signing in: ?next= when it is a path on this site (the server checks again),
 * else "/". The server's redirect to sign in (src/gate.js) never sees an address's #: the browser
 * keeps it and brings it here, onto this page's address. A next with none takes it back, so a
 * link into the app (/t/<trip>/#/p/<place>?photo=add) or to a card of a page (#cover) comes back
 * to that card.
 */
export function nextPath() {
  const raw = new URLSearchParams(location.search).get("next") || "/";
  if (!/^\/(?![/\\])/.test(raw)) return "/";
  return raw.includes("#") || location.hash.length < 2 ? raw : raw + location.hash;
}

// ── the wordmark ───────────────────────────────────────────────────────────────────────
// The one place the mark is drawn: the pages hand this an empty node. The drawing is
// /img/wordmark.svg (drawn by art/make_logo.py). It is fetched, so a page that doesn't show it
// never parses it, and put into the page rather than an <img>, so it takes the theme's ink and
// the chosen accent. The words are what a screen reader gets, what shows if the fetch fails,
// and what holds the space until the file arrives.
let markSVG = null;
export function wordmark() {
  return '<span class="lg-word">We Go Place</span>';
}
export async function paintWordmark(host) {
  if (!host) return;
  host.setAttribute("role", "img");
  host.setAttribute("aria-label", "We Go Place");
  if (!host.innerHTML) host.innerHTML = wordmark();
  if (markSVG === null) {
    try { markSVG = await (await fetch("/img/wordmark.svg")).text(); }
    catch { markSVG = ""; }
  }
  if (markSVG) host.innerHTML = markSVG;
}

// ── what both pages draw with ──────────────────────────────────────────────────────────

// A message is an icon and words, never a tint alone.
const ICONS = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.4"/>',
  err: '<path d="M12 4.5 2.8 20h18.4L12 4.5Z"/><path d="M12 10v4M12 17v.4"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.8 2.8L16.4 9"/>',
};

/**
 * The message line under a page's controls: `box` is a .lg-msg holding an <svg> and a <span>,
 * `detail` the <pre> for the machine tail. Returns { say(text, kind, detail), fail(error), clear() }.
 */
export function messages(box, detail) {
  const icon = box.querySelector("svg");
  const text = box.querySelector("span");
  const api_ = {
    say(words, kind = "info", tail = "") {
      icon.innerHTML = ICONS[kind] || ICONS.info;
      text.textContent = words;
      box.className = "lg-msg" + (kind === "err" ? " lg-msg-err" : kind === "ok" ? " lg-msg-ok" : "");
      box.hidden = false;
      if (detail) { detail.textContent = tail; detail.hidden = !tail; }
      // What was just said has to be on screen: the button that caused it may be a screen away.
      box.scrollIntoView?.({ block: "nearest" });
    },
    fail(e) {
      if (e instanceof AuthError) api_.say(e.message, "err", e.detail);
      else { api_.say("Something went wrong. Try again.", "err", String(e?.message || e)); console.error("[auth]", e); }
    },
    clear() {
      box.hidden = true;
      if (detail) detail.hidden = true;
    },
  };
  return api_;
}

/**
 * One busy flag for a page: while a flow runs, every [data-act] control is off and the one
 * pressed shows a spinner and what it is waiting for.
 */
export function busyState(root = document) {
  let busy = false;
  const controls = () => [...root.querySelectorAll("[data-act]")];
  return {
    get on() { return busy; },
    start(btn, label) {
      busy = true;
      for (const b of controls()) b.disabled = true;
      if (btn) {
        btn.dataset.label = btn.dataset.label || btn.innerHTML;
        btn.innerHTML = '<span class="lg-spin" aria-hidden="true"></span>';
        btn.append(label);
      }
    },
    stop(btn) {
      busy = false;
      for (const b of controls()) b.disabled = false;
      if (btn && btn.dataset.label) { btn.innerHTML = btn.dataset.label; delete btn.dataset.label; }
    },
  };
}

/**
 * A button that asks twice instead of a confirm() box: the first press changes its words for
 * five seconds, the second within them runs `action`. With `destroys`, what the second press
 * does can't be taken back, and the asking button says so the way the rest of the app does:
 * filled with the warning color. A button with an icon keeps it: its words are the
 * [data-words] part. `again` is the asking words, or a function answering them when pressed
 * (leavingWords); when it answers "", the first press runs `action` without asking.
 */
export function askTwice(btn, again, action, { destroys = false } = {}) {
  let armed = null;
  let deciding = false;
  const label = btn.querySelector("[data-words]") || btn;
  const words = label.textContent;
  const disarm = () => { clearTimeout(armed); armed = null; label.textContent = words; btn.classList.remove("lg-armed", "lg-destroys"); };
  btn.addEventListener("click", async () => {
    if (deciding) return;
    if (!armed) {
      let asks = again;
      if (typeof again === "function") {
        deciding = true;
        try { asks = await again(); } finally { deciding = false; }
        if (!asks) { action(btn); return; }
      }
      label.textContent = asks;
      btn.classList.add("lg-armed");
      if (destroys) btn.classList.add("lg-destroys");
      armed = setTimeout(disarm, 5000);
      return;
    }
    disarm();
    action(btn);
  });
}

// ══ the sign-in page ═══════════════════════════════════════════════════════════════════
// Only where login.html is the document: importing this module anywhere else runs none of it.
if (typeof document !== "undefined" && document.body?.hasAttribute("data-login-page")) initLoginPage();

function initLoginPage() {
  const $ = (id) => document.getElementById(id);
  // The device's own words (Face ID, Touch ID, a fingerprint) only once the browser says it can
  // hold a passkey by itself; until then, and where it can't, "a passkey". The page is held back
  // until that answer is in (drawnBy), so it is never drawn saying the one and then the other.
  let WORDS = PASSKEY_WORDS;
  const paintWords = () => { for (const el of document.querySelectorAll("[data-pk-short]")) el.textContent = WORDS.short; };
  const msg = messages($("msg"), $("detail"));
  const busy = busyState();

  // What decides how this page looks arrives over the network: the wordmark, what the site
  // offers, whether someone is already signed in. login.html holds the page back (data-wait)
  // until each of these has answered, so it is drawn once, where it stays.
  const drawnBy = [paintWordmark($("brand"))];
  // The one page whose wordmark moves (js/logo-player.js): loaded once the still one is in, and
  // never in the way of anything else this page does.
  drawnBy[0].then(() => import("./logo-player.js")).then((m) => m.playWordmark($("brand")), () => {});
  paintWords();

  // ── which screen this address is ─────────────────────────────────────────────────────
  //   /login               sign in, or make an account
  //   /login/new           back from Google or GitHub with a sign-in nobody has used yet
  //   /login/link/<token>  a one-use link from the site's operator
  const PANELS = ["signin", "new", "link", "recover", "account"];
  // The note that this device can't hold a passkey (login.html #no-platform) belongs only where a passkey would be made
  // or used: signing in or making an account, and the one-more-step screen. Never on the signed-in page.
  let noPlatform = false;
  const PASSKEY_PANELS = new Set(["signin", "new"]);
  const placeNoPlatform = () => {
    const shown = PANELS.find((p) => !$("p-" + p).hidden);
    $("no-platform").hidden = !noPlatform || !PASSKEY_PANELS.has(shown);
  };
  function show(which, { keep = false } = {}) {
    for (const p of PANELS) $("p-" + p).hidden = p !== which;
    if (!keep) msg.clear();
    placeNoPlatform();
  }
  const path = location.pathname.replace(/\/+$/, "");
  const linkToken = path.match(/^\/login\/link\/([A-Za-z0-9_-]{20,128})$/)?.[1] ?? null;
  const onCreateStep = path === "/login/new";
  const query = new URLSearchParams(location.search);

  /** Into the app, or back to wherever sent them here to sign in (a join link's page, say). */
  function enter(user, to = nextPath()) {
    msg.say(`Signed in as ${user?.name || "you"}.`, "ok");
    // replace, not assign: Back from the app must not land on a sign-in page.
    location.replace(to);
  }

  async function run(btn, waiting, flow, after) {
    if (busy.on) return;
    msg.clear();
    busy.start(btn, waiting);
    try {
      await after(await flow());
    } catch (e) {
      busy.stop(btn);
      msg.fail(e);
      throw e;
    }
  }
  const quiet = (promise) => promise.catch(() => {});

  // ── sign in ──────────────────────────────────────────────────────────────────────────
  // "Continue with a passkey" signs in. Back without one (a closed prompt and "this device has no passkey here" are one
  // error on purpose), it opens the account's making under it, by a typed name and Create, and "Try again": both ways
  // on, rather than one guessed. Nothing is made by the failed sign-in itself.
  const make = $("signin-make");
  const passkeySignIn = (btn) => quiet(run(btn, `Waiting for ${WORDS.short}…`, () => signIn(), enter).catch((err) => {
    if (err?.code === "cancelled") {
      msg.clear();
      make.hidden = false;
      make.scrollIntoView({ block: "nearest" });
    }
    primeSignIn();
    throw err;
  }));
  $("btn-signin").addEventListener("click", (e) => passkeySignIn(e.currentTarget));
  $("btn-signin-again").addEventListener("click", (e) => passkeySignIn(e.currentTarget));
  $("form-signin-name").addEventListener("submit", (e) => {
    e.preventDefault();
    const username = $("signin-name").value.trim().toLowerCase();
    if (!username) return msg.say("Type the username you signed in with before.", "err");
    quiet(run($("btn-signin-name"), `Waiting for ${WORDS.short}…`, () => signIn({ username }), enter).catch((err) => { primeSignIn(); throw err; }));
  });

  // ── a new account ────────────────────────────────────────────────────────────────────
  $("form-join").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = cleanName($("join-name").value);
    if (!name) return msg.say("Type a name, up to 40 characters. It's what the people on your trips will see.", "err");
    quiet(run($("btn-join"), `Waiting for ${WORDS.short}…`, () => register({ name }), enter));
  });

  // ── Google and GitHub ────────────────────────────────────────────────────────────────
  // Plain forms: the browser itself goes to the provider and comes back. Each carries where to
  // land afterwards; the server keeps it for the whole trip and checks it is a path here.
  for (const input of document.querySelectorAll('form[data-provider] input[name="next"]')) input.value = nextPath();

  // ── the create step (/login/new) ─────────────────────────────────────────────────────
  async function openCreateStep() {
    show("new", { keep: true });
    const { status, body } = await api("GET", "/api/auth/pending");
    if (status !== 200) {
      // Nothing is waiting (it ran out, or this address was opened directly).
      // What the address came back with (new accounts paused, say) is the better explanation.
      history.replaceState(null, "", "/login");
      show("signin", { keep: !!arrived });
      if (!arrived) msg.say("That sign-in ran out before it was finished. Start again.", "info");
      return;
    }
    const waiting = body.providers.map(providerName);
    $("new-what").textContent = waiting.length > 1
      ? `Nobody here signs in with those ${waiting.join(" and ")} accounts yet.`
      : `Nobody here signs in with that ${waiting[0]} account yet.`;
    $("new-add").textContent = waiting.join(" and ");
    if (!$("new-name").value) $("new-name").value = body.name || "";
    // The other provider is a way to sign in to the account you have; the one waiting isn't.
    for (const form of document.querySelectorAll('#p-new form[data-provider]')) {
      form.hidden = form.hidden || body.providers.includes(form.dataset.provider);
    }
    $("form-new").onsubmit = (e) => {
      e.preventDefault();
      const name = cleanName($("new-name").value);
      if (!name) return msg.say("Type a name, up to 40 characters. It's what the people on your trips will see.", "err");
      quiet(run($("btn-new"), "Creating your account…", () => call("POST", "/api/auth/pending/create", { name }), (made) => enter(made.user, made.next || "/")));
    };
    $("btn-new-passkey").onclick = (e) => quiet(run(e.currentTarget, `Waiting for ${WORDS.short}…`, async () => {
      const user = await signIn();
      const joined = await call("POST", "/api/auth/pending/attach", {});
      return { user, next: joined.next || "/" };
    }, ({ user, next }) => enter(user, next)).catch((err) => { primeSignIn(); throw err; }));
    $("btn-new-cancel").onclick = () => { location.replace("/login"); };
  }

  // ── a one-use link (/login/link/<token>) ─────────────────────────────────────────────
  // Opening the address shows this screen and uses nothing; the button uses the link.
  // On a phone where someone is already signed in, the link signs them out: a guest's place on this phone
  // (their only way in) and anything not yet sent go with it. So the page names who is signed in here
  // (linkStart, below) and the button asks first, saying what goes; with nobody signed in it doesn't ask.
  let linkOver = null;
  const linkAsks = async () => {
    if (!linkOver) return "";
    const waiting = waitingWords(await waitingChanges());
    const asks = linkOver.guest ? `Tap again to end ${linkOver.name}'s place here and sign in with the link`
      : `Tap again to sign ${linkOver.name} out and sign in with the link`;
    return waiting ? `${waiting}. ${asks}` : asks;
  };
  askTwice($("btn-link"), linkAsks, (btn) => quiet(run(btn, "Signing in…",
    () => call("POST", "/api/auth/link", { token: linkToken }),
    () => { location.replace("/account?signin=link"); },
  ).catch((err) => {
    if (err?.code === "expired") msg.say("This link was already used, or it ran out. Ask for a new one.", "err", err.detail);
    throw err;
  })), { destroys: true });

  // ── getting back in by email ─────────────────────────────────────────────────────────
  let recoverId = null;
  $("btn-recover").addEventListener("click", () => { show("recover"); $("form-recover-code").hidden = true; $("form-recover-email").hidden = false; $("recover-email").focus(); });
  $("btn-recover-back").addEventListener("click", () => show("signin"));
  $("form-recover-email").addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $("recover-email").value.trim();
    if (!email) return msg.say("Type the email address on your account.", "err");
    quiet(run($("btn-recover-send"), "Sending…", () => call("POST", "/api/auth/recover", { email }), (sent) => {
      busy.stop($("btn-recover-send"));
      recoverId = sent.id;
      $("form-recover-email").hidden = true;
      $("form-recover-code").hidden = false;
      $("recover-code").value = "";
      $("recover-code").focus();
      // The same words whether or not the address is on an account: saying which would tell
      // anyone who asks whose address is here.
      msg.say("If that address is on an account, a 6-digit code is on its way to it. It works for 15 minutes.", "info");
    }));
  });
  $("form-recover-code").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = $("recover-code").value.replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) return msg.say("The code is 6 digits.", "err");
    quiet(run($("btn-recover-code"), "Checking…", () => call("POST", "/api/auth/recover/confirm", { id: recoverId, code }),
      () => { location.replace("/account?signin=recovered"); }));
  });

  // ── already signed in ────────────────────────────────────────────────────────────────
  $("btn-continue").addEventListener("click", () => location.replace(nextPath()));
  // A guest signing in to an account they have: allowed, after saying their place stays behind
  // (the server keeps the guest on their trips as another person; nothing is merged).
  let guest = null;
  $("btn-signin-other").addEventListener("click", () => {
    show("signin");
    $("guest-warn-text").textContent = `You're a guest on ${placeWord()}. Signing in to another account leaves ${guest?.name || "your guest"}'s place behind.`;
    $("guest-warn").hidden = false;
  });
  askTwice($("btn-signout"), leavingWords("Tap again to sign out", { guest: () => !!guest }), async (btn) => {
    if (busy.on) return;
    msg.clear();
    busy.start(btn, "Signing out…");
    let cleared;
    try {
      cleared = await signOut();
    } catch (e) {
      msg.fail(e);                   // nothing was cleared
      return;
    } finally {
      busy.stop(btn);
    }
    guest = null;
    $("guest-warn").hidden = true;
    show("signin");
    if (cleared.ok) msg.say("Signed out.", "info");
    else msg.say(`You're signed out, but ${unclearedWords(cleared.failed.join(","))}`, "err");
    primeSignIn();
  });

  // ── start ────────────────────────────────────────────────────────────────────────────
  // Registered here as well as in the app: this is the first page anyone opens, and starting
  // the app's download while they read it means the app is ready when they are in.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch((e) => console.warn("[auth] sw", e));
  }

  // What came back in the address from a trip to Google or GitHub.
  const arrived = resultWords(query.get("error") || query.get("done"), query.get("with"), query.get("kept"));

  const cap = support();
  if (!cap.ok) {
    // Passkeys can't work here. Google, GitHub, a link and a code still can.
    for (const id of ["btn-signin", "btn-signin-again", "btn-signin-name", "btn-join", "btn-new-passkey"]) $(id).disabled = true, $(id).removeAttribute("data-act");
    $("unsupported").hidden = false;
    $("unsupported-text").textContent = cap.message;
  } else {
    primeSignIn();
    // A challenge lasts five minutes and this page can sit open for an hour.
    setInterval(primeSignIn, PRIME_TTL - 30e3);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) primeSignIn(); });
    drawnBy.push(hasPlatformAuthenticator().then((yes) => {
      WORDS = yes ? deviceWords() : PASSKEY_WORDS;
      paintWords();
      noPlatform = !yes;
      placeNoPlatform();
    }));
  }

  drawnBy.push(siteConfig().then((site) => {
    let any = false;
    for (const form of document.querySelectorAll("form[data-provider]")) {
      const on = !!site.providers?.[form.dataset.provider];
      form.hidden = !on;
      any ||= on;
    }
    $("providers").hidden = !any;
    const paused = site.signups === "paused";
    // New accounts paused: a sign-in back without a passkey offers "Try again" only, under the banner that says why.
    $("form-join").hidden = paused;
    $("make-what").hidden = paused;
    $("paused").hidden = !paused;
    $("btn-recover").hidden = !site.email;
    if (onCreateStep) return openCreateStep();
  }));

  if (linkToken) {
    show("link");
    // Who is signed in on this phone now, if anyone: said before they press, and asked about when they do.
    drawnBy.push(me().then((user) => {
      if (!user) return;
      linkOver = user;
      const line = $("link-current");
      line.querySelector("span").textContent = user.guest
        ? `${user.name} is signed in on ${placeWord()} as a guest. Signing in with this link ends ${user.name}'s place here: a guest has no other way back in.`
        : `${user.name} is signed in on ${placeWord()}. Signing in with this link signs ${user.name} out here.`;
      line.hidden = false;
    }).catch(() => { /* offline or an error: the button still works, and the server decides */ }));
  }
  else if (onCreateStep) show("new");
  else show("signin");
  if (arrived) msg.say(arrived[1], arrived[0]);

  // Already signed in? Then the sign-in form is the wrong thing to show. The create step and a
  // link keep their screens: both are for someone who is deliberately doing something else.
  if (!linkToken && !onCreateStep) {
    drawnBy.push(me().then(async (user) => {
      if (!user) return;
      $("account-name").textContent = user.name;
      guest = user.guest ? user : null;
      if (guest) $("account-guest").textContent = guestLine((await siteConfig()).providers);
      $("account-guest").hidden = !guest;
      $("btn-signin-other").hidden = !guest;
      // For a guest the account page is where their place is kept: it says so on the way there.
      $("go-account").textContent = guest ? "Keep your place" : "Your account";
      show("account", { keep: !!arrived });
    }).catch(() => { /* offline or an error: the sign-in panel is right */ }));
  }

  // Now the page is what it will stay. The wait's other end is in css/account.css: four seconds
  // after the page opens it shows what it has, and an answer still to come moves it then.
  Promise.allSettled(drawnBy).then(() => $("page").removeAttribute("data-wait"));
}

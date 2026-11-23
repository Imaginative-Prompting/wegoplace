// Web Push from the Worker, with Web Crypto only: a message encrypted for one browser's subscription
// (RFC 8291, aes128gcm), signed for its push service (VAPID, RFC 8292), and sent (RFC 8030).
// checks/push/run.mjs holds the encryption to RFC 8291's own worked example, byte for byte, opens what
// we send as a browser would, and checks the VAPID signature with the public key.
//
// The keys (tools/vapid-keys.mjs makes them): VAPID_PUBLIC_KEY, the raw P-256 public key in base64url
// (what a page subscribes with), and VAPID_PRIVATE_KEY, the private key as a JWK (a secret). Without
// both, the site sends no notifications and says so (GET /api/account/push: "push off").

const encoder = new TextEncoder();

export const b64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const fromB64url = (text) => {
  const s = atob(String(text).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(text).length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
/** HKDF-SHA-256, one block of output (all RFC 8291 asks for). */
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/** The server's VAPID keys from the environment, or null when this site sends no notifications. */
export function vapidOf(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  let privateJwk;
  try { privateJwk = JSON.parse(env.VAPID_PRIVATE_KEY); } catch { return null; }
  // Who the push services may write to about this sender: the site's own address (no one's email).
  return { publicKey: env.VAPID_PUBLIC_KEY, privateJwk, subject: env.VAPID_SUBJECT || env.PUBLIC_ORIGIN || "https://wegoplace.com" };
}

/**
 * RFC 8291: the body to send to one subscription, encrypted for it (one record, padding delimiter 2).
 * `fixed` is for the checks only: the server's key pair and the salt, otherwise fresh for every message.
 */
export async function encrypt(sub, plaintext, fixed = null) {
  const uaPublic = fromB64url(sub.p256dh);
  const authSecret = fromB64url(sub.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error("not a push subscription's keys");
  let asPrivate;
  let asPublic;
  if (fixed) {
    asPrivate = await crypto.subtle.importKey("jwk", fixed.asPrivate, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    asPublic = fixed.asPublic;
  } else {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  }
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));
  const ikm = await hkdf(authSecret, shared, concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const rs = 4096;
  const header = concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255, asPublic.length]), asPublic);
  return concat(header, sealed);
}

/** RFC 8292: the Authorization header for an endpoint, signed with the server's VAPID key. */
export async function vapidHeader(endpoint, vapid, now = Date.now()) {
  const head = b64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // Apple refuses an expiry more than a day ahead: 12 hours.
  const claims = b64url(encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject })));
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`;
}

/**
 * Sends one message to one subscription: encrypted, signed, with its TTL (how long the push service may
 * hold it while the phone is away), Urgency and Topic (a newer one for the same topic replaces one not
 * yet delivered). `gone`: the subscription has ended (404, 410), so its row goes.
 */
export async function send(sub, message, vapid, { ttl = 24 * 3600, urgency = "normal", topic = null } = {}, fetcher = fetch) {
  const body = await encrypt(sub, encoder.encode(message));
  const headers = {
    Authorization: await vapidHeader(sub.endpoint, vapid),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(ttl),
    Urgency: urgency,
  };
  if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const res = await fetcher(sub.endpoint, { method: "POST", headers, body });
  try { await res.body?.cancel(); } catch { /* read or gone */ }
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}

/**
 * Where a subscription may send: only the browsers' own push services, over https (an endpoint is
 * what a page says, so untrusted). `extra`: one more origin a check's stand-in answers on (the checks'
 * servers only, PUSH_TEST_ORIGIN; production never sets it).
 */
export function allowedEndpoint(endpoint, extra = null) {
  if (typeof endpoint !== "string" || endpoint.length > 1000) return false;
  let url;
  try { url = new URL(endpoint); } catch { return false; }
  if (extra && url.origin === extra) return true;
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname;
  return host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com"
    || host === "web.push.apple.com" || host.endsWith(".push.apple.com") || host.endsWith(".notify.windows.com");
}

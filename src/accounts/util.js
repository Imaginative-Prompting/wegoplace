// What every accounts module uses: ids and hashes, cookies, JSON answers, where a request
// came from, and the limits.

const encoder = new TextEncoder();

export const nowSec = () => Math.floor(Date.now() / 1000);

export function bytesToBase64Url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A random id or token: url-safe, with as many random bytes as asked for. */
export function randomId(byteLength = 16) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/**
 * A new account's id: a UUID, as accounts have always had. Other rows are named after the id
 * (a person's own packing views are pv_<id>_…) and sorted by it, so its shape stays what the
 * rest of the site already holds.
 */
export const newAccountId = () => crypto.randomUUID();

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares two strings without telling where they differ (both are hashed first, so their lengths tell nothing either). */
export async function secretsEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

// ── cookies ────────────────────────────────────────────────────────────────────────────────

export function readCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return null; }
  }
  return null;
}

export function cookieHeader(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearCookieHeader(name) {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** A cookie the page's own script can read. Only for what isn't a secret (sessions.js: wgp_who). */
export function readableCookieHeader(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Secure; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function clearReadableCookieHeader(name) {
  return `${name}=; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

const LOCAL_HTTP_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Every cookie is made Secure. Safari drops a Secure cookie that http://localhost sets, though
 * the page is a secure context, so on a local copy (PUBLIC_ORIGIN is plain http on localhost or
 * 127.0.0.1) answering a plain-http request, Secure comes off each Set-Cookie. Any other answer
 * is handed back as it is.
 *
 * Except a cookie whose name starts __Host- or __Secure-: a browser takes one of those only WITH
 * Secure, so taking it off throws the cookie away everywhere. The OAuth library's (the approval
 * page's, src/mcp/oauth.js) are such; they keep Secure, which Chrome takes from localhost and
 * Safari doesn't (so locally an app is approved in Chrome).
 */
export function withLocalCookies(response, env, requestUrl) {
  if (!LOCAL_HTTP_ORIGIN.test(env.PUBLIC_ORIGIN ?? "") || response.status === 101) return response;
  if (new URL(requestUrl).protocol !== "http:") return response;
  const cookies = response.headers.getSetCookie();
  if (!cookies.length) return response;
  const headers = new Headers(response.headers);
  headers.delete("Set-Cookie");
  for (const cookie of cookies) {
    const prefixed = /^\s*__(Host|Secure)-/.test(cookie);
    headers.append("Set-Cookie", prefixed ? cookie : cookie.split(";").filter((part, i) => i === 0 || part.trim().toLowerCase() !== "secure").join(";"));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// ── answers ────────────────────────────────────────────────────────────────────────────────

/** A JSON answer that no cache may keep, with any cookies to set. */
export function answer(body, status = 200, cookies = [], extra = {}) {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

export function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

/** The request's body when it is a JSON object, else null: an array, a number or broken JSON is a script's, never this app's. */
export async function readObject(request) {
  let body;
  try { body = await request.json(); } catch { return null; }
  return body && typeof body === "object" && !Array.isArray(body) ? body : null;
}

// ── where a request came from ──────────────────────────────────────────────────────────────

/**
 * The site's addresses. PUBLIC_ORIGIN is the one it is known by, and the only one it ever prints
 * for someone else to use; ALSO_ORIGINS (comma-separated) are other hostnames that serve the
 * same site in full, as https://www.wegoplace.com does for a phone whose app was added there.
 */
export function siteOrigins(env) {
  const also = String(env.ALSO_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  return [env.PUBLIC_ORIGIN, ...also.filter((o) => o !== env.PUBLIC_ORIGIN)];
}

/**
 * The origin a page of this site sending this request has: the request's own address when it is
 * one of the site's, else PUBLIC_ORIGIN (a local server reached at 127.0.0.1, say, as before).
 * A page at one of the site's addresses never writes to another of them: their sessions are
 * their own (host-only cookies), and a write that crosses is refused as from another site.
 */
export function ownOrigin(request, env) {
  const here = new URL(request.url).origin;
  return siteOrigins(env).includes(here) ? here : env.PUBLIC_ORIGIN;
}

/** Sent by a page of this site: every browser puts Origin on a POST, and it must be ours, here. */
export const sameOrigin = (request, env) => request.headers.get("Origin") === ownOrigin(request, env);

/**
 * Whether a browser says this request came from another site: an Origin that isn't ours, here
 * (the string "null" included), or Sec-Fetch-Site saying same-site or cross-site. With neither
 * header it isn't a browser's request, so it carries nobody else's cookies.
 */
export function crossSite(request, env) {
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== ownOrigin(request, env)) return true;
  const site = request.headers.get("Sec-Fetch-Site");
  return site !== null && site !== "same-origin" && site !== "none";
}

/**
 * Where to go after signing in: only a path on this site survives, anything else becomes the
 * fallback. A browser reads a Location the way the URL standard parses it (tabs and newlines
 * dropped, a backslash taken for a slash), so "/\t/elsewhere.example" is another site. The value
 * is parsed that way here against a placeholder origin and kept only if it stays on it; what is
 * returned is the parsed path, so a browser can't read it any other way.
 */
const NEXT_BASE = "https://next.invalid";
export function safeNextPath(value, fallback = "/") {
  if (typeof value !== "string" || !value || value.length > 2048 || !value.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  let url;
  try { url = new URL(value, NEXT_BASE); } catch { return fallback; }
  if (url.origin !== NEXT_BASE) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

// ── limits ─────────────────────────────────────────────────────────────────────────────────

/** The connection a request came over, as Cloudflare names it. */
export const connection = (request) => request.headers.get("CF-Connecting-IP") ?? "unknown";

/**
 * Whether this connection is over a limit (wrangler.jsonc `ratelimits`). `what` keeps different
 * things on different counts of the same limiter.
 */
export async function limited(limiter, what, request) {
  const { success } = await limiter.limit({ key: `${what}:${connection(request)}` });
  return !success;
}

export const tooMany = (cookies = []) => answer({ error: "too many", reason: "That's a lot of tries from this connection in a minute. Wait a minute, then try again." }, 429, cookies, { "Retry-After": "60" });

// ── names ──────────────────────────────────────────────────────────────────────────────────

/** A display name as kept: trimmed, runs of spaces made one, 1 to 40 characters, no control characters. Else null. */
export function cleanName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || [...name].length > 40 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** A provider's name for someone, cut to fit a display name; null when there is none. */
export function nameFrom(value) {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ");
  return name ? [...name].slice(0, 40).join("") : null;
}

// ── local stand-ins ────────────────────────────────────────────────────────────────────────

/**
 * Local checks only: the origin of a stand-in for Google and GitHub. Honored only when this
 * server and the stand-in are both on localhost, so no setting can point a deployed site, or
 * send its secrets, anywhere else.
 */
export function standin(env) {
  const local = /^http:\/\/localhost:\d+$/;
  return env.AUTH_STANDIN && local.test(env.AUTH_STANDIN) && local.test(env.PUBLIC_ORIGIN ?? "") ? env.AUTH_STANDIN : null;
}

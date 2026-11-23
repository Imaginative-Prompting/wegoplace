// Signing an AI app in (the MCP plan, points 1 and 2): OAuth 2.1 by
// @cloudflare/workers-oauth-provider, the shape Lexicommons runs.
//
// The provider wraps the Worker (src/index.js). It answers the protocol's own addresses itself
// (/token, /register, /.well-known/…), checks the token on every /mcp request before
// src/mcp/server.js runs, and hands everything else to the site as before. What is the site's:
//   * /authorize, the page where a signed-in person approves an app. Signed out, the gate sends
//     them to sign in and back. It names the app and where it sends its tokens, says plainly that
//     the app reaches EVERY trip they're on (so nobody connects an AI for one trip and gives it the
//     others unknowingly), and what it may do: read, or read and change.
//     Approving is a POST from that page, bound to the account it was drawn for.
//   * the account's list of connected apps, with Disconnect (src/accounts/apps.js).
//
// A disconnected app stays disconnected. The provider keeps grants in KV and revoking deletes
// them there, but a refresh already under way can write one back, and another location can read
// a deleted one for a minute. So revoking writes a marker in D1 first (revoked_grants), and the
// marker is checked on every /token answer that hands out tokens and on every /mcp request
// (Lexicommons' rule, src/revoked.ts there).

// The provider's library is loaded where it's used, not here: this module is also imported by
// the route table, which Node's checks load, and the library needs the Workers runtime.
const library = () => import("@cloudflare/workers-oauth-provider");
import { sha256Hex } from "../accounts/util.js";
import { isGuest, waysIn } from "../accounts/guests.js";
import { errorLine } from "../log.js";

export const SCOPES = ["trips:read", "trips:write"];
export const SCOPE_WORDS = {
  "trips:read": "See your trips: places, itinerary, packing, Split and people.",
  "trips:write": "Change them: places, events, packing, purchases and pictures, each change listed in the trip with an undo.",
};

/** Each scope's mark on the approval page: an eye to see, a pencil to change. */
// The app's own mark isn't known (a registration carries no picture this page would show): a plain sparkle stands for
// "an AI app", on the system's gray tile.
const APP_MARK = '<path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5Z"/><path d="M18.5 15.5c.25 1.5 1 2.25 2.5 2.5-1.5.25-2.25 1-2.5 2.5-.25-1.5-1-2.25-2.5-2.5 1.5-.25 2.25-1 2.5-2.5Z"/>';
// What it can't do: a circle crossed through.
const CANT_ICON = '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>';

const SCOPE_ICONS = {
  "trips:read": '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  "trips:write": '<path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4"/>',
};

/** What an app's registration may be at most: a real client's is well under 2 KB. */
const REGISTER_BODY = 16 * 1024;
/** How long a revoked grant's marker is kept: the refresh tokens' lifetime. */
export const REFRESH_SECONDS = 90 * 24 * 3600;

export function providerOptions(resource, { apiHandler, defaultHandler }) {
  return {
    apiRoute: "/mcp",
    apiHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    // Registration stays on beside client metadata documents: Claude prefers a document, other
    // clients register.
    clientRegistrationEndpoint: "/register",
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    // Sign in once: a grant lasts 90 days, and every refresh moves that on, so only an unused
    // connection runs out.
    refreshTokenTTL: REFRESH_SECONDS,
    refreshTokenIdleTTL: REFRESH_SECONDS,
    scopesSupported: SCOPES,
    requiredScopes: SCOPES,
    resourceMetadata: { resource, resource_name: "WeGoPlace", bearer_methods_supported: ["header"] },
    // `internal`, the library's own description, can echo what a client sent (its name, a redirect_uri): left out.
    onError: ({ code, status, internal }) => console.warn(JSON.stringify({ oauth_error: code, status, internal: internal ? "left out" : null })),
  };
}

// ── revoked grants ───────────────────────────────────────────────────────────────────────────

// The provider's tokens, access and refresh: `${userId}:${grantId}:${secret}`.
const TOKEN_SHAPE = /^([A-Za-z0-9_-]{1,256}):([A-Za-z0-9_-]{1,256}):[A-Za-z0-9_-]{1,256}$/;

/** The account and grant a provider token belongs to, or null. */
export function grantOfToken(token) {
  const m = typeof token === "string" ? TOKEN_SHAPE.exec(token) : null;
  return m ? { userId: m[1], grantId: m[2] } : null;
}

/**
 * /mcp's 401 for a token whose account was deleted, said: the challenge gains error_description (RFC 6750) and the
 * body says it in words, so an app can tell its person why it must sign in again (deleting an account revokes every
 * connection: src/accounts/account.js). Any other 401 is answered as the provider answered it.
 */
export async function explainRevoked(request, response, env) {
  if (response.status !== 401 || new URL(request.url).pathname !== "/mcp") return response;
  const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const grant = grantOfToken(token);
  if (!grant) return response;
  const row = await env.DB.prepare("SELECT deleted_at FROM users WHERE id = ?1").bind(grant.userId).first().catch(() => null);
  if (!row?.deleted_at) return response;
  const words = "This account was deleted.";
  const headers = new Headers(response.headers);
  const challenge = headers.get("WWW-Authenticate") ?? 'Bearer realm="OAuth", error="invalid_token"';
  headers.set("WWW-Authenticate", `${challenge}, error_description="${words}"`);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ error: "invalid_token", error_description: words }), { status: 401, headers });
}

const grantHash = (userId, grantId) => sha256Hex(`wegoplace revoked grant\n${userId}:${grantId}`);

export async function grantRevoked(env, userId, grantId) {
  return Boolean(await env.DB.prepare("SELECT 1 AS y FROM revoked_grants WHERE grant_hash = ?1").bind(await grantHash(userId, grantId)).first());
}

/** Disconnects one of an account's apps: the marker first, then the provider's delete. */
export async function revokeConnection(env, revoker, userId, grantId) {
  await env.DB.prepare("INSERT INTO revoked_grants (grant_hash, revoked_at) VALUES (?1, ?2) ON CONFLICT (grant_hash) DO NOTHING")
    .bind(await grantHash(userId, grantId), Math.floor(Date.now() / 1000)).run();
  await revoker.revokeGrant(grantId, userId);
}

/** Every app an account has connected, disconnected (deleting the account). */
export async function revokeAll(env, revoker, userId) {
  let cursor;
  do {
    const page = await revoker.listUserGrants(userId, { cursor });
    for (const g of page.items) await revokeConnection(env, revoker, userId, g.id);
    cursor = page.cursor;
  } while (cursor);
}

/** The cron's sweep: markers and redeemed refresh tokens past the refresh tokens' lifetime. */
export async function sweepRevoked(env, now = Math.floor(Date.now() / 1000)) {
  const gone = (await env.DB.prepare("DELETE FROM revoked_grants WHERE revoked_at < ?1").bind(now - REFRESH_SECONDS).run()).meta.changes ?? 0;
  await env.DB.prepare("DELETE FROM oauth_refresh_used WHERE used_at < ?1").bind(now - REFRESH_SECONDS).run();
  return gone;
}

// ── refresh tokens used twice ────────────────────────────────────────────────────────────────
//
// The provider rotates refresh tokens, but takes the one before the newest as well as the newest (so an app whose
// answer was lost can ask again), however late, and never notices a replay: a thief holding an old one goes on while
// the app is cut off, or the other way round. OAuth 2.1 §4.3.1: an authorization server MUST detect refresh token
// replay for public clients. So each refresh token redeemed is kept (migration 0038, by hash), with the one it was
// traded for, and one presented again is a replay, which disconnects the app (revokeConnection): the thief and the
// app both lose it, and the person connects it again. The one allowance is the provider's own reason: the token just
// before the newest, asked again within REFRESH_GRACE seconds while the newest is still unused.
export const REFRESH_GRACE = 120;
const refreshHash = (token) => sha256Hex(`wegoplace refresh token\n${token}`);

/**
 * Whether `hash`'s token is a replay: { replayed }, or the allowance, { superseded: the successor it replaces }. The
 * allowance hands out a new successor, so the one it replaces is kept as redeemed (used long ago): if that one is ever
 * presented, an app and someone else both held the token, and the connection goes.
 */
async function refreshReplayed(env, hash, now) {
  const seen = await env.DB.prepare("SELECT used_at, successor_hash FROM oauth_refresh_used WHERE token_hash = ?1").bind(hash).first();
  if (!seen) return { replayed: false };
  if (now - seen.used_at > REFRESH_GRACE) return { replayed: true };
  const successorUsed = await env.DB.prepare("SELECT 1 AS y FROM oauth_refresh_used WHERE token_hash = ?1").bind(seen.successor_hash).first();
  return successorUsed ? { replayed: true } : { replayed: false, superseded: seen.successor_hash };
}

function oauthRefusal(request, status, error, description) {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  const origin = request.headers.get("Origin");
  if (origin) { headers.set("Access-Control-Allow-Origin", origin); headers.set("Vary", "Origin"); }
  if (status === 503) headers.set("Retry-After", "1");
  if (status === 429) headers.set("Retry-After", "60");
  return new Response(JSON.stringify({ error, error_description: description }), { status, headers });
}

/**
 * The provider's own addresses, with the site's three guards: registering an app is limited per
 * connection and in size (it is open to anyone, by design), /token never hands out a token
 * of a disconnected app, and a refresh token used twice disconnects its app (above).
 */
export async function serveOAuth(request, env, ctx, provider, options) {
  const url = new URL(request.url);
  let refreshed = null;
  if (url.pathname === "/token" && request.method === "POST") {
    const raw = await readLimited(request.clone(), REGISTER_BODY);
    const form = raw ? new URLSearchParams(new TextDecoder().decode(raw)) : null;
    const token = form?.get("grant_type") === "refresh_token" ? form.get("refresh_token") ?? "" : "";
    const grant = grantOfToken(token);
    if (grant) {
      const now = Math.floor(Date.now() / 1000);
      const hash = await refreshHash(token);
      let replayed, superseded;
      try { ({ replayed, superseded } = await refreshReplayed(env, hash, now)); } catch (e) {
        console.warn(JSON.stringify({ refresh_used: "read_failed", error: errorLine(e, env) }));
        return oauthRefusal(request, 503, "temporarily_unavailable", "Try again in a moment.");
      }
      if (replayed) {
        const { getOAuthApi } = await library();
        await revokeConnection(env, getOAuthApi(options, env), grant.userId, grant.grantId).catch((e) => console.warn(JSON.stringify({ refresh_replay_revoke: errorLine(e, env) })));
        return oauthRefusal(request, 400, "invalid_grant", "This app's sign-in was used twice, so WeGoPlace disconnected it to keep your account safe. Connect it again.");
      }
      refreshed = { hash, grant, now, superseded };
    }
  }
  if (url.pathname === "/register" && request.method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") ?? "local";
    if (!(await env.AUTH_LIMITER.limit({ key: `register:${ip}` })).success) {
      return oauthRefusal(request, 429, "slow_down", "Too many apps registered from here. Try again in a minute.");
    }
    const body = await readLimited(request, REGISTER_BODY);
    if (body === null) return oauthRefusal(request, 400, "invalid_client_metadata", `An app's registration is at most ${REGISTER_BODY / 1024} KB.`);
    request = new Request(request, { body });
  }
  const response = await provider.fetch(request, env, ctx);
  if (url.pathname !== "/token" || request.method !== "POST" || response.status !== 200) return response;
  const text = await response.text();
  const out = () => new Response(text, { status: response.status, headers: response.headers });
  let issued, successor;
  try { ({ access_token: issued, refresh_token: successor } = JSON.parse(text)); } catch { return out(); }
  const grant = grantOfToken(issued);
  if (!grant) return out();
  if (refreshed && typeof successor === "string") {
    // Kept with the token it was traded for: the first time its used_at, a retry within the allowance only moves its successor.
    try {
      const grantKey = await grantHash(refreshed.grant.userId, refreshed.grant.grantId);
      const kept = [env.DB.prepare(`INSERT INTO oauth_refresh_used (token_hash, grant_hash, used_at, successor_hash) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT (token_hash) DO UPDATE SET successor_hash = excluded.successor_hash`)
        .bind(refreshed.hash, grantKey, refreshed.now, await refreshHash(successor))];
      // The allowance's replaced successor, kept as redeemed just past the allowance (so it's swept with the rest, in
      // the refresh tokens' lifetime): presented later, it is a replay.
      if (refreshed.superseded) kept.push(env.DB.prepare("INSERT INTO oauth_refresh_used (token_hash, grant_hash, used_at, successor_hash) VALUES (?1, ?2, ?3, '') ON CONFLICT (token_hash) DO NOTHING")
        .bind(refreshed.superseded, grantKey, refreshed.now - REFRESH_GRACE - 1));
      await env.DB.batch(kept);
    } catch (e) {
      // Not kept, a replay of it couldn't be told: the tokens aren't handed out.
      console.warn(JSON.stringify({ refresh_used: "write_failed", error: errorLine(e, env) }));
      return oauthRefusal(request, 503, "temporarily_unavailable", "Try again in a moment.");
    }
  }
  let revoked;
  try {
    revoked = await grantRevoked(env, grant.userId, grant.grantId);
  } catch (e) {
    console.warn(JSON.stringify({ revoked_grants: "read_failed", error: errorLine(e, env) }));
    return oauthRefusal(request, 503, "temporarily_unavailable", "Try again in a moment.");
  }
  if (!revoked) return out();
  const { getOAuthApi } = await library();
  await getOAuthApi(options, env).revokeGrant(grant.grantId, grant.userId).catch(() => {});
  return oauthRefusal(request, 400, "invalid_grant", "This app was disconnected from WeGoPlace. Connect it again.");
}

async function readLimited(request, max) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return all;
}

// ── the approval page ────────────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Binds a drawn page to the account it was drawn for: approving it as another account does nothing. */
const consentMark = (handle, userId) => sha256Hex(`wegoplace consent\n${handle}\n${userId}`);

// The wordmark, inlined as the sign-in pages inline it (public/js/auth.js paintWordmark), so it
// takes the theme's colors. Read once from the site's own files.
let wordmark = null;
async function wordmarkOf(env, request) {
  if (wordmark === null) {
    try {
      const res = await env.ASSETS.fetch(new URL("/img/wordmark.svg", request.url));
      wordmark = res.ok ? await res.text() : "";
    } catch { wordmark = ""; }
  }
  return wordmark;
}

function page(title, body, status = 200, headers = new Headers(), brand = "") {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  // same-origin, NOT no-referrer: the page's address never reaches another site as a referrer
  // either way, but under no-referrer a browser sends the page's own form (Allow, Cancel) with
  // `Origin: null`, and the gate refuses a write whose Origin isn't the site's (src/gate.js). That
  // refused every real browser's Allow (15 Nov; check:mcp-browser holds it now).
  headers.set("Referrer-Policy", "same-origin");
  // No other site shows these pages inside its own (an Allow button under someone else's page is a
  // click on it). public/_headers can't reach a page the Worker draws, and the library's consent
  // headers cover the Allow page only, so every page here says it itself.
  headers.set("X-Frame-Options", "DENY");
  const csp = headers.get("Content-Security-Policy");
  if (!csp) headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  else if (!/frame-ancestors/.test(csp)) headers.set("Content-Security-Policy", `${csp}; frame-ancestors 'none'`);
  return new Response(`<!doctype html>
<html lang="en" data-app="wegoplace-app" class="ds">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${esc(title)} · WeGoPlace</title>
<link rel="icon" href="/icons/favicon.1ad16064.ico" sizes="32x32">
<link rel="stylesheet" href="/ds/tokens.css">
<link rel="stylesheet" href="/ds/base.css">
<link rel="stylesheet" href="/ds/controls.css">
<link rel="stylesheet" href="/css/signin.css">
<script>
// The theme, before first paint, as the app's other pages do it (public/login.html: the same
// table; keep them in step): the app's "wgp.theme", else the system's light or dark. The design
// system's tokens take light or dark from data-lum.
(function () {
  var root = document.documentElement;
  var THEMES = { light: "light", void: "dark" };
  var RETIRED = { dark: "void", slate: "void", linen: "light" };   // retired looks read as the nearest
  var t = null;
  try { t = localStorage.getItem("wgp.theme"); } catch (e) { /* private mode throws; the system theme is a fine default */ }
  if (RETIRED[t]) t = RETIRED[t];
  if (THEMES[t]) root.setAttribute("data-theme", t);
  var mq = matchMedia("(prefers-color-scheme: dark)");
  function paint() {
    var forced = root.getAttribute("data-theme");
    root.setAttribute("data-lum", THEMES[forced] || (mq.matches ? "dark" : "light"));
  }
  paint();
  mq.addEventListener("change", paint);
})();
</script>
</head>
<body data-authorize-page>
<main class="lg-page" id="page">
  ${brand ? `<div class="lg-brand lg-brand-small" role="img" aria-label="We Go Place">${brand}</div>` : ""}
  <div class="lg-wrap">
    ${body}
  </div>
</main>
</body>
</html>`, { status, headers });
}

const messagePage = (title, words, status = 400, brand = "") => page(title, `<section class="lg-panel" aria-labelledby="t"><h1 class="h2" id="t">${esc(title)}</h1><p class="lead">${esc(words)}</p><a class="ds-button ds-button--gray ds-button--lg ds-button--block" href="/trips">Your trips</a></section>`, status, new Headers(), brand);

async function failed(error, brand = "") {
  const { AuthorizationError, CimdFetchError } = await library();
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) return messagePage("Can't connect this app", error.message, 400, brand);
  console.error(JSON.stringify({ authorize_error: errorLine(error) }));
  return messagePage("Can't connect this app", "Something went wrong. Start connecting again from the app.", 500, brand);
}

// A guest has no account an app could be connected to (model §22): the page says how to make one.
const guestPage = (env, brand = "") => messagePage(`Add ${waysIn(env)} first`, `You're a guest. Add ${waysIn(env)} on your account page, then connect the app again.`, 403, brand);

/** GET /authorize: the page that asks the signed-in person to approve the app. Behind the gate. */
export async function getAuthorize({ request, env, data }) {
  const user = data.user;
  const brand = await wordmarkOf(env, request);
  if (isGuest(user)) return guestPage(env, brand);
  try {
    const provider = env.OAUTH_PROVIDER;
    const asked = await provider.parseAuthRequest(request);
    const app = await provider.describeConsent(asked);
    const { handle, headers } = await provider.beginConsent(asked);
    const scope = (asked.scope?.length ? asked.scope : SCOPES).filter((s) => SCOPES.includes(s));
    const name = app.clientName || "An app";
    const verified = app.clientDomain ? ` <span class="meta">(from ${esc(app.clientDomain)})</span>` : "";
    // The mock-up's "An AI app asks": what it wants in one heading, who is signed in, what it may do as rows with
    // the last saying what it can't, then where it sends what it gets, and the two answers.
    const body = `
    <section class="lg-panel" aria-labelledby="t">
      <div class="cs-appmark" aria-hidden="true"><svg viewBox="0 0 24 24">${APP_MARK}</svg></div>
      <h1 class="h2 cs-title" id="t">${esc(name)}${verified} wants to use your WeGoPlace account</h1>
      <p class="lead">You're signed in as <span class="strong">${esc(user.name)}</span>. <strong class="cs-reach">It reaches every trip you're on</strong>, not only one, and the ones you join later. It asks to:</p>
      <div class="cs-cans">
        ${scope.map((s) => `<p class="cs-can"><svg viewBox="0 0 24 24" aria-hidden="true">${SCOPE_ICONS[s]}</svg><span>${esc(SCOPE_WORDS[s])}</span></p>`).join("\n        ")}
        <p class="cs-can cs-cant"><svg viewBox="0 0 24 24" aria-hidden="true">${CANT_ICON}</svg><span>Nothing else: it can't delete a trip, add or remove anyone, make join links, hand a trip over, or touch anyone else's packing list.</span></p>
      </div>
      <p class="meta">It sends what it gets to <span class="strong">${esc(app.redirectHost)}</span>.${app.redirectIsLoopback ? " That is a program on the computer it runs on: connect it only if you started it yourself." : ""}</p>
      <div class="cs-push">
        <form method="post" action="/authorize" class="cs-two">
          <input type="hidden" name="handle" value="${esc(handle)}">
          <input type="hidden" name="account" value="${esc(await consentMark(handle, user.id))}">
          <button class="ds-button ds-button--gray ds-button--lg ds-button--block" name="decision" value="deny" type="submit">Cancel</button>
          <button class="ds-button ds-button--white ds-button--lg ds-button--block" name="decision" value="approve" type="submit">Allow</button>
        </form>
        <p class="lg-fine cs-fine">You can disconnect it any time from your account page, under AI apps.</p>
      </div>
    </section>`;
    return page(`Connect ${name}`, body, 200, headers, brand);
  } catch (e) {
    return await failed(e, brand);
  }
}

/** POST /authorize: Allow or Cancel, from that page. */
export async function postAuthorize({ request, env, data }) {
  const user = data.user;
  const brand = await wordmarkOf(env, request);
  if (isGuest(user)) return guestPage(env, brand);
  let form;
  try { form = await request.formData(); } catch { return messagePage("Can't connect this app", "That wasn't the page's answer. Start connecting again from the app.", 400, brand); }
  const handle = String(form.get("handle") ?? "");
  if (String(form.get("account") ?? "") !== (await consentMark(handle, user.id))) {
    return messagePage("Signed in as someone else", `This page was opened for another account. You're signed in as ${user.name} now: start connecting again from the app.`, 409, brand);
  }
  const provider = env.OAUTH_PROVIDER;
  try {
    if (form.get("decision") !== "approve") {
      const denied = await provider.denyConsent(request, handle);
      denied.headers.set("Location", denied.redirectTo);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await provider.approveConsent(request, handle);
    const app = await provider.describeConsent(approved.request);
    const scope = (approved.request.scope?.length ? approved.request.scope : SCOPES).filter((s) => SCOPES.includes(s));
    const clientName = (app.clientName || "an app").slice(0, 80);
    const { redirectTo } = await provider.completeAuthorization({
      request: approved.request, userId: user.id, scope,
      metadata: { clientName }, props: { userId: user.id, clientName },
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    return await failed(e, brand);
  }
}

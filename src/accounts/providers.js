// Signing in with Google or GitHub, beside passkeys.
//
// An identity is the provider's own id for a person (Google's `sub`, GitHub's numeric user id),
// never an email or a username. The round trip is a server-side code flow with PKCE (S256) and
// `state`, plus a `nonce` in Google's ID token. The flow waits in the database under its own
// short-lived cookie and is taken once; `next` (where to land afterwards) stays on the server
// the whole way. A provider's tokens are used once, to read who the person is, and dropped.
// Google is asked for `openid profile` and GitHub for no scope at all: no email is ever read.
//
// A sign-in nobody has used yet waits as "pending" under its own cookie while the sign-in page
// shows the create step (/login/new): make an account with it, or sign in another way to add it
// to the account you have. Nothing is ever joined by email.
//
// A provider is offered only where its client id and secret are set (wrangler.jsonc); with
// neither, the site has passkeys only.
//
//   POST /login/<provider>            a form: next, intent (signin | link | attach)  -> the provider
//                                     (at another of the site's addresses: to PUBLIC_ORIGIN's sign-in page)
//   GET  /login/<provider>/callback   back from it -> signed in, or the create step, or /account
//   GET  /api/auth/pending            the sign-in waiting on the create step
//   POST /api/auth/pending/create     { name } -> an account with it, signed in
//   POST /api/auth/pending/attach     (signed in) -> added to this account

import { nowAnAccount, nowAnAccountStatement } from "./guests.js";
import { drop, keep, peek, take } from "./challenges.js";
import { sessionOf, startSession } from "./sessions.js";
import { signupsOpen } from "./signups.js";
import {
  answer, bytesToBase64Url, cleanName, clearCookieHeader, cookieHeader, limited, nameFrom, newAccountId, nowSec, randomId, readCookie,
  readObject, redirect, safeNextPath, sameOrigin, secretsEqual, standin, tooMany,
} from "./util.js";
import { errorLine } from "../log.js";

export const PROVIDERS = ["google", "github"];
export const isProvider = (value) => PROVIDERS.includes(value);

const FLOW_COOKIE = "wgp_oauth";
const FLOW_SECONDS = 600;
const PENDING_COOKIE = "wgp_pending";
const PENDING_SECONDS = 900;

class ProviderError extends Error {}

// ── the providers ──────────────────────────────────────────────────────────────────────────

function endpoints(env, provider) {
  const local = standin(env);
  if (provider === "google") {
    return local
      ? { authorize: `${local}/google/authorize`, token: `${local}/google/token`, issuers: [`${local}/google`], user: "" }
      : {
          authorize: "https://accounts.google.com/o/oauth2/v2/auth",
          token: "https://oauth2.googleapis.com/token",
          issuers: ["https://accounts.google.com", "accounts.google.com"],
          user: "",
        };
  }
  return local
    ? { authorize: `${local}/github/authorize`, token: `${local}/github/token`, issuers: [], user: `${local}/github/user` }
    : {
        authorize: "https://github.com/login/oauth/authorize",
        token: "https://github.com/login/oauth/access_token",
        issuers: [],
        user: "https://api.github.com/user",
      };
}

function client(env, provider) {
  const id = provider === "google" ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID;
  const secret = provider === "google" ? env.GOOGLE_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}

/** Whether each provider can be used here. */
export const providersReady = (env) => ({ google: Boolean(client(env, "google")), github: Boolean(client(env, "github")) });

const redirectUri = (env, provider) => `${env.PUBLIC_ORIGIN}/login/${provider}/callback`;

async function pkceChallenge(verifier) {
  return bytesToBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

function authorizeUrl(env, flow, clientId, challenge) {
  const url = new URL(endpoints(env, flow.provider).authorize);
  const params = {
    client_id: clientId,
    redirect_uri: redirectUri(env, flow.provider),
    response_type: "code",
    state: flow.state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  if (flow.provider === "google") {
    // Who you are and your name. No email, and nothing else of yours.
    params.scope = "openid profile";
    params.nonce = flow.nonce;
    // Someone with several Google accounts picks one, rather than Google picking for them.
    params.prompt = "select_account";
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Reads a JWT's claims. Only for an ID token straight from Google's token endpoint over TLS (OIDC Core 3.1.3.7). */
function jwtClaims(token) {
  const part = token.split(".")[1];
  if (!part) throw new ProviderError("no ID token");
  const text = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(text, (ch) => ch.charCodeAt(0))));
}

const FORM = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };

async function googleIdentity(env, code, flow, app) {
  const ep = endpoints(env, "google");
  const response = await fetch(ep.token, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: app.id,
      client_secret: app.secret,
      redirect_uri: redirectUri(env, "google"),
      code_verifier: flow.verifier,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.id_token) throw new ProviderError(`google token: ${response.status} ${body.error ?? ""}`);
  const claims = jwtClaims(body.id_token);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!ep.issuers.includes(String(claims.iss))) throw new ProviderError("google: wrong issuer");
  if (!audience.includes(app.id)) throw new ProviderError("google: wrong audience");
  if (typeof claims.exp !== "number" || claims.exp < nowSec() - 60) throw new ProviderError("google: expired");
  if (typeof claims.nonce !== "string" || !(await secretsEqual(claims.nonce, flow.nonce))) throw new ProviderError("google: wrong nonce");
  if (typeof claims.sub !== "string" || !/^[\w-]{1,255}$/.test(claims.sub)) throw new ProviderError("google: no subject");
  const name = nameFrom(claims.name) ?? nameFrom(claims.given_name);
  return { provider: "google", subject: claims.sub, label: name, name };
}

async function githubIdentity(env, code, flow, app) {
  const ep = endpoints(env, "github");
  const response = await fetch(ep.token, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({
      client_id: app.id,
      client_secret: app.secret,
      code,
      redirect_uri: redirectUri(env, "github"),
      code_verifier: flow.verifier,
    }),
  });
  // GitHub answers a bad code with a 200 and an error field.
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new ProviderError(`github token: ${response.status} ${body.error ?? ""}`);
  const userResponse = await fetch(ep.user, {
    headers: {
      Authorization: `Bearer ${body.access_token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": env.RP_NAME || "WeGoPlace",
    },
  });
  const user = await userResponse.json().catch(() => ({}));
  if (!userResponse.ok || typeof user.id !== "number" || !Number.isSafeInteger(user.id)) throw new ProviderError(`github user: ${userResponse.status}`);
  const login = typeof user.login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(user.login) ? user.login : null;
  return { provider: "github", subject: String(user.id), label: login ? `@${login}` : null, name: nameFrom(user.name) ?? login };
}

const IDENTITY = { google: googleIdentity, github: githubIdentity };

// ── the sign-in waiting on the create step ─────────────────────────────────────────────────
// { identities: [{ provider, subject, label, name }], next }

async function readPending(env, request) {
  const row = await peek(env, readCookie(request, PENDING_COOKIE), "pending");
  try { return row ? JSON.parse(row.challenge) : null; } catch { return null; }
}

const dropPending = (env, request) => drop(env, readCookie(request, PENDING_COOKIE), "pending");

/**
 * Keeps a new sign-in waiting for the create step and returns its cookie. From the create step
 * itself (merge) it joins the one already waiting, at most one per provider, the newest kept;
 * from the sign-in page it starts afresh, so an abandoned attempt never comes along.
 */
async function addPending(env, request, identity, next, { merge }) {
  const existing = merge ? await readPending(env, request) : null;
  if (!merge) await dropPending(env, request);
  const identities = [...(existing?.identities ?? []).filter((i) => i.provider !== identity.provider), identity];
  const id = (existing && readCookie(request, PENDING_COOKIE)) || randomId(18);
  await keep(env, { id, kind: "pending", value: JSON.stringify({ identities, next: existing?.next ?? next }), seconds: PENDING_SECONDS });
  return cookieHeader(PENDING_COOKIE, id, PENDING_SECONDS);
}

// ── identities ─────────────────────────────────────────────────────────────────────────────

async function ownerOf(env, identity) {
  const row = await env.DB.prepare(
    "SELECT i.user_id FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ?1 AND i.subject = ?2 AND u.deleted_at IS NULL",
  ).bind(identity.provider, identity.subject).first();
  return row?.user_id ?? null;
}

const insertIdentity = (env, userId, identity, now) => env.DB.prepare(
  "INSERT INTO identities (provider, subject, user_id, label, created_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
).bind(identity.provider, identity.subject, userId, identity.label, now);

/** Adds the waiting sign-ins to an account, skipping any another account has taken since. Returns the providers added. */
async function attachPending(env, userId, pending) {
  const added = [];
  for (const identity of pending.identities) {
    if (await ownerOf(env, identity)) continue;
    const ok = await env.DB.batch([insertIdentity(env, userId, identity, nowSec()), nowAnAccountStatement(env, userId)])
      .then(() => true, () => false);
    if (ok) added.push(identity.provider);
  }
  if (added.length) nowAnAccount(userId);
  return added;
}

// ── where a round trip ends ────────────────────────────────────────────────────────────────
// Always by a short code in the address; the pages hold the words, so nothing from a URL is shown.

function toLogin(next, error, provider, cookies = []) {
  const params = new URLSearchParams({ error });
  if (provider) params.set("with", provider);
  if (next !== "/") params.set("next", next);
  return redirect(`/login?${params}`, cookies);
}

function toCreateStep(error, provider, cookies = []) {
  const params = new URLSearchParams();
  if (error) params.set("error", error);
  if (provider) params.set("with", provider);
  return redirect(`/login/new${params.size ? `?${params}` : ""}`, cookies);
}

/** The account page, with what happened: added, already, taken, cancelled, expired, provider, busy, unavailable, signed-out. */
const toAccount = (result, provider, cookies = []) => redirect(`/account?signin=${result}&with=${provider}`, cookies);

const notFromHere = () => new Response("That request didn't come from this site.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });

// ── leaving for the provider ───────────────────────────────────────────────────────────────

/** The address by GET (a reload, a link someone kept) starts nothing: back to the sign-in page. */
export function startByGet({ params }) {
  return isProvider(String(params.provider).toLowerCase()) ? redirect("/login") : new Response("not found", { status: 404 });
}

export async function start({ request, env, params }) {
  const provider = String(params.provider).toLowerCase();
  if (!isProvider(provider)) return new Response("not found", { status: 404 });
  if (!sameOrigin(request, env)) return notFromHere();
  const form = await request.formData().catch(() => new FormData());
  const intent = ["link", "attach"].includes(form.get("intent")) ? form.get("intent") : "signin";
  const next = safeNextPath(form.get("next"));
  // Google and GitHub come back to PUBLIC_ORIGIN only (the one address each provider's app is
  // told), so a sign-in started at another of the site's addresses (www) is sent there first,
  // to its sign-in page, before anything is kept: the flow's cookie would never reach the
  // callback from here. The page there says why (error=elsewhere).
  if (new URL(request.url).origin !== env.PUBLIC_ORIGIN) {
    const params = new URLSearchParams({ error: "elsewhere", with: provider });
    if (intent === "link" || next !== "/") params.set("next", intent === "link" ? "/account" : next);
    return redirect(`${env.PUBLIC_ORIGIN}/login?${params}`);
  }
  if (await limited(env.AUTH_LIMITER, "signin", request)) return intent === "link" ? toAccount("busy", provider) : toLogin(next, "busy");
  const app = client(env, provider);
  if (!app) return intent === "link" ? toAccount("unavailable", provider) : toLogin(next, "unavailable", provider);
  let userId = null;
  if (intent === "link") {
    const found = await sessionOf(request, env);
    if (!found) return toLogin("/account", "signed-out");
    userId = found.user.id;
  }
  const flow = { provider, state: randomId(24), verifier: randomId(48), nonce: randomId(24), next, intent, userId };
  const id = await keep(env, { kind: "oauth", value: JSON.stringify(flow), userId, seconds: FLOW_SECONDS });
  return redirect(authorizeUrl(env, flow, app.id, await pkceChallenge(flow.verifier)), [cookieHeader(FLOW_COOKIE, id, FLOW_SECONDS)]);
}

// ── coming back ────────────────────────────────────────────────────────────────────────────

export async function callback({ request, env, params }) {
  const provider = String(params.provider).toLowerCase();
  if (!isProvider(provider)) return new Response("not found", { status: 404 });
  const clearFlow = clearCookieHeader(FLOW_COOKIE);
  // Not limited here: only a flow from a (limited) start gets past the state check below, so
  // the starts bound how often this calls the provider.
  const url = new URL(request.url);
  const row = await take(env, readCookie(request, FLOW_COOKIE), "oauth");
  let flow = null;
  try { flow = row ? JSON.parse(row.challenge) : null; } catch { /* not ours */ }
  const state = url.searchParams.get("state") ?? "";
  if (!flow || flow.provider !== provider || !state || !(await secretsEqual(state, flow.state))) {
    return toLogin("/", "expired", provider, [clearFlow]);
  }
  const back = (error) =>
    flow.intent === "link" ? toAccount(error, provider, [clearFlow])
      : flow.intent === "attach" ? toCreateStep(error, provider, [clearFlow])
        : toLogin(flow.next, error, provider, [clearFlow]);

  const providerError = url.searchParams.get("error");
  if (providerError) return back(providerError === "access_denied" ? "cancelled" : "provider");
  const code = url.searchParams.get("code");
  const app = client(env, provider);
  if (!code || !app) return back("provider");
  let identity;
  try {
    identity = await IDENTITY[provider](env, code, flow, app);
  } catch (error) {
    console.warn(JSON.stringify({ signin_error: provider, detail: errorLine(error, env) }));
    return back("provider");
  }
  const owner = await ownerOf(env, identity);
  const now = nowSec();

  if (flow.intent === "link") {
    const found = await sessionOf(request, env);
    if (!found || found.user.id !== flow.userId) return toAccount("signed-out", provider, [clearFlow]);
    if (owner === found.user.id) return toAccount("already", provider, [clearFlow]);
    if (owner) return toAccount("taken", provider, [clearFlow]);
    const added = await env.DB.batch([insertIdentity(env, found.user.id, identity, now), nowAnAccountStatement(env, found.user.id)])
      .then(() => true, () => false);
    if (added) nowAnAccount(found.user.id);
    return toAccount(added ? "added" : "taken", provider, [clearFlow]);
  }

  if (owner) {
    await env.DB.prepare("UPDATE identities SET last_used_at = ?1, label = coalesce(?2, label) WHERE provider = ?3 AND subject = ?4")
      .bind(now, identity.label, identity.provider, identity.subject).run();
    const cookies = [clearFlow, ...(await startSession(env, owner, request, now))];
    // From the create step: this account is the one you have, so the waiting sign-in joins it.
    const pending = flow.intent === "attach" ? await readPending(env, request) : null;
    if (pending) {
      await attachPending(env, owner, pending);
      await dropPending(env, request);
      cookies.push(clearCookieHeader(PENDING_COOKIE));
    }
    return redirect(pending?.next ?? flow.next, cookies);
  }

  // Nobody uses this sign-in yet: the create step. From the create step itself, it joins the
  // one already waiting. New accounts paused: the words instead, with nothing kept.
  if (!signupsOpen(env)) {
    console.log("wgp-watch signups_paused");
    return flow.intent === "attach" ? toCreateStep("paused", provider, [clearFlow]) : toLogin(flow.next, "paused", provider, [clearFlow]);
  }
  const pendingCookie = await addPending(env, request, identity, flow.next, { merge: flow.intent === "attach" });
  return toCreateStep(flow.intent === "attach" ? "unknown" : null, flow.intent === "attach" ? provider : undefined, [clearFlow, pendingCookie]);
}

// ── the create step ────────────────────────────────────────────────────────────────────────

/** What is waiting, for the page to show: which providers, a name to start from, where it was going. */
export async function pendingView({ request, env }) {
  const pending = await readPending(env, request);
  if (!pending?.identities.length) return answer({ error: "expired" }, 404, [clearCookieHeader(PENDING_COOKIE)]);
  return answer({
    providers: pending.identities.map((i) => i.provider),
    labels: pending.identities.map((i) => ({ provider: i.provider, label: i.label })),
    name: pending.identities.map((i) => i.name).find(Boolean) ?? "",
    next: pending.next,
  });
}

/** Make an account with the waiting sign-in(s). */
export async function pendingCreate({ request, env }) {
  if (!sameOrigin(request, env)) return answer({ error: "cross site" }, 403);
  if (await limited(env.AUTH_LIMITER, "signin", request)) return tooMany();
  // New accounts paused: nothing written, and the waiting sign-in kept to finish later.
  if (!signupsOpen(env)) return answer({ error: "signups paused" }, 503, [], { "Retry-After": "300" });
  const pending = await readPending(env, request);
  if (!pending?.identities.length) return answer({ error: "expired" }, 404, [clearCookieHeader(PENDING_COOKIE)]);
  const name = cleanName((await readObject(request))?.name);
  if (!name) return answer({ error: "name" }, 400);
  const userId = newAccountId();
  const now = nowSec();
  try {
    // One transaction: if another account took any of these sign-ins meanwhile, nothing is made.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, name, created_at) VALUES (?1, ?2, ?3)").bind(userId, name, now),
      ...pending.identities.map((identity) => insertIdentity(env, userId, identity, now)),
    ]);
  } catch {
    await dropPending(env, request);
    return answer({ error: "taken" }, 409, [clearCookieHeader(PENDING_COOKIE)]);
  }
  await dropPending(env, request);
  console.log("wgp-watch signup");
  const user = { id: userId, name };
  return answer({ ok: true, user, next: pending.next }, 200, [clearCookieHeader(PENDING_COOKIE), ...(await startSession(env, userId, request, now))]);
}

/** After signing in another way on the create step: add the waiting sign-in(s) to that account. */
export async function pendingAttach({ request, env, data }) {
  const pending = await readPending(env, request);
  if (!pending) return answer({ added: [], next: "/" }, 200, [clearCookieHeader(PENDING_COOKIE)]);
  const added = await attachPending(env, data.user.id, pending);
  await dropPending(env, request);
  return answer({ added, next: pending.next }, 200, [clearCookieHeader(PENDING_COOKIE)]);
}

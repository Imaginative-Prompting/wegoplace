// The gate: every request that reaches the Worker passes here before a handler answers it.
//
// What reaches the Worker is what wrangler.jsonc's `run_worker_first` lists: /api, /media,
// /tiles, a shared board's page (/s), the sign-in addresses under /login/, and a join link's
// page (/join/<code>). The app's own files are not on that list: Cloudflare's asset server
// answers them to anyone, without running this. They are the same for everyone and hold
// nothing of anyone's; a page learns whether someone is signed in by asking /api/me.
//
// Two kinds of address get here:
//   public      answered to anyone: the sign-in addresses, the routes that sign someone in, a
//               shared board's page, a join link's page and what it shows;
//   signed in   everything else. Signing in puts nobody on a trip: whether the caller is on
//               the trip an address names is the route table's check (src/trips/access.js).
// One address is both: joining by a link (SESSION_IF_ANY), which a signed-out person may do as a guest.
//
// Who is signed in comes from src/accounts/sessions.js; handlers read ctx.data.user =
// { id, name, onTrip, guest }. The gate also keeps the page's own note of who that is (`wgp_who`,
// sessions.js) in step: a signed-in browser that lacks it, or holds another account's, is sent
// it again; a browser whose session is gone is told to forget it with the session cookie. That
// cookie decides nothing on the server: it is read here only to know whether to send it.

import { SESSION_COOKIE, SessionsLimited, WHO_COOKIE, sessionOf, signedOut, whoCookie } from "./accounts/sessions.js";
import { crossSite, nowSec, readCookie } from "./accounts/util.js";

const PUBLIC = [
  // The sign-in page's two other addresses: the step that makes an account from a Google or
  // GitHub sign-in nobody has used yet, and a one-use link from the site's operator.
  /^\/login\/new$/,
  /^\/login\/link\/[A-Za-z0-9_-]{20,128}$/,
  // Leaving for Google or GitHub, and coming back.
  /^\/login\/(google|github)(\/callback)?$/,
  // The routes that sign someone in or out. Each is named: the rest of /api/auth (another
  // passkey, the ways an account signs in) is for someone already signed in.
  /^\/api\/auth\/(register|login)\/(options|verify)$/,
  /^\/api\/auth\/logout$/,
  /^\/api\/auth\/config$/,
  /^\/api\/auth\/pending(\/create)?$/,
  /^\/api\/auth\/recover(\/confirm)?$/,
  /^\/api\/auth\/link$/,
  // A shared board's page and its pictures: public by design, no session. Anchored to
  // /s/<32 hex>/ and its own sub-paths so it can never widen: the id is the credential, and
  // nothing else lives under /s/. The row it reads carries an image key and a title and nothing
  // about the trip.
  // (/i/<n>/thumb: the photograph's thumbnail, migration 0026; /lod/<n> stays for a page cached
  // before it, and answers the original.)
  /^\/s\/[a-f0-9]{32}(\/(image|video|i\/\d+(\/lod\/(320|640|1280|1920|2560)|\/thumb)?))?\/?$/i,
  // A join link's page. Whoever opens one may not have an account yet: the page shows what the
  // link is for and sends them to sign in, then back.
  /^\/join\/[A-Za-z0-9_-]{1,64}\/?$/,
  // A picture sent to a one-use upload link (src/trips/pictures.js): the token is the
  // credential, used once, good for 15 minutes; an AI with a shell sends it, with no session.
  /^\/pictures\/upload\/[A-Za-z0-9_-]{20,128}$/,
  // Stripe's webhook (src/billing/): no session; the body's signature is the credential, checked
  // before anything in it is read.
  /^\/api\/billing\/stripe$/,
  // A page's error report (src/errors.js): any page sends one, signed in or not (the sign-in page breaks too). It keeps
  // nothing of who, is limited per connection, and is a POST, so another site's page is refused above as for every write.
  /^\/api\/errors$/,
  // A bug report (src/bug-reports.js): from More signed in, or from the sign-in page's /report by someone who can't get in.
  // The handler reads a session itself, if one came; limited per account or connection; a POST, refused cross-site above.
  /^\/api\/bug-reports$/,
];
// What a join link is for (the trip's name and dates, its host's name): read by that page for
// anyone. Reading only.
const PUBLIC_TO_READ = [/^\/api\/join\/[A-Za-z0-9_-]{1,64}\/?$/];
// Joining by a link, with a session or without one: signed in, it puts that person on the trip; signed out, it makes a
// guest with the name given (src/trips/links.js, src/accounts/guests.js). The session is read as for any address, and
// its absence is not refused here: ctx.data.user is null.
const SESSION_IF_ANY = [/^\/api\/join\/[A-Za-z0-9_-]{1,64}\/?$/];

// Map tiles come in bursts of small range requests and are the same for everyone who may
// have them, so a session found a moment ago will do for them (sessions.js `cached`). Nothing
// else is answered that way.
const tile = (path) => path.startsWith("/tiles/");

const wantsPage = (request) => (request.headers.get("Accept") || "").includes("text/html");

const refuse = (status, error, headers = {}, reason = undefined) =>
  new Response(JSON.stringify(reason ? { error, reason } : { error }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

// url.pathname is still percent-encoded, but the file server behind ctx.next()
// decodes %2F and collapses ../ AFTERWARDS. Matching PUBLIC on the raw path therefore waves
// through /icons/..%2Fjs%2Fstore.js as public and then serves the gated /js/store.js. Decode
// once and match on that, so the gate authorizes the same path the resolver will serve; a
// path that still tries to traverse after decoding has no legitimate sender (browsers
// normalize ".." before it reaches the wire) and is refused outright.
function canonicalPath(pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { return null; }  // malformed %-escape
  if (p.includes("\\")) return null;
  if (p.split("/").includes("..")) return null;
  return p;
}

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const path = canonicalPath(url.pathname);
  if (path === null) return new Response("bad request", { status: 400 });
  // A change asked for by another site's page is refused before anything runs, the public
  // routes included. With a session it would ride on this browser's cookie (SameSite=Lax keeps
  // the cookie off another site's POST, but not off a sibling subdomain's). Without one it can
  // still do harm: a form posted to /api/auth/logout as a navigation carries no cookie, but the
  // browser keeps the cookies the answer sets, and the answer clears the session. Every public
  // POST comes from this site's own pages; Google and GitHub come back with a GET.
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && crossSite(request, env)) return refuse(403, "cross site");
  if (PUBLIC.some((re) => re.test(path))) return ctx.next();
  if (["GET", "HEAD"].includes(request.method) && PUBLIC_TO_READ.some((re) => re.test(path))) return ctx.next();
  // The OAuth provider answers the /.well-known/ documents this site has (src/index.js), before
  // the gate. Any other is one it doesn't have, for anyone: 404, never "sign in" (a client looking
  // for its documents reads a 401 there as a protected address; 15 Nov, MCP proof).
  if (path.startsWith("/.well-known/")) {
    return new Response(JSON.stringify({ error: "not found", reason: "This site has no such document under /.well-known/." }),
      { status: 404, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }

  let found;
  try {
    found = await sessionOf(request, env, { extend: true, cached: tile(path) });
  } catch (error) {
    if (error instanceof SessionsLimited) return refuse(429, "too many", { "Retry-After": "60" }, "That's a lot of requests from this connection in a minute. Wait a minute, then try again.");
    throw error;
  }
  if (!found && request.method === "POST" && SESSION_IF_ANY.some((re) => re.test(path))) {
    ctx.data.user = null;
    const response = await ctx.next();
    if (readCookie(request, SESSION_COOKIE) !== null || readCookie(request, WHO_COOKIE) !== null) {
      // A cookie that finds no session is forgotten, as below; one the join just set (a new guest's) stays, after it.
      const fresh = response.headers.getSetCookie?.() ?? [];
      const out = new Response(response.body, response);
      out.headers.delete("Set-Cookie");
      for (const cookie of signedOut()) out.headers.append("Set-Cookie", cookie);
      for (const cookie of fresh) out.headers.append("Set-Cookie", cookie);
      return out;
    }
    return response;
  }
  if (!found) {
    let response;
    // An API address answers in JSON whoever asks, so the app's own fetches can read it.
    if (path === "/api" || path.startsWith("/api/")) response = refuse(401, "unauthorized");
    else if (!wantsPage(request)) response = new Response("unauthorized", { status: 401 });
    else {
      // Back to where they were going once they've signed in (the page checks it's a path here).
      const login = new URL("/login", url);
      login.searchParams.set("next", url.pathname + url.search);
      response = new Response(null, { status: 302, headers: { Location: login.toString() } });
    }
    // A session cookie that finds no session (signed out elsewhere, run out, account deleted):
    // the browser forgets it, and the page's note of who was signed in with it.
    if (readCookie(request, SESSION_COOKIE) !== null || readCookie(request, WHO_COOKIE) !== null) {
      for (const cookie of signedOut()) response.headers.append("Set-Cookie", cookie);
    }
    return response;
  }

  ctx.data.user = found.user;
  const response = await ctx.next();
  const cookies = [...found.cookies];
  if (!cookies.some((c) => c.startsWith(`${WHO_COOKIE}=`)) && readCookie(request, WHO_COOKIE) !== found.user.id) {
    cookies.push(whoCookie(found.user.id, found.expiresAt - nowSec()));
  }
  if (!cookies.length) return response;
  // A socket's 101 (a trip's live updates) has headers that can't be changed: the same socket in a
  // new 101 carries the cookies (a browser takes them from the handshake). Changing them in place
  // threw, and the socket's open failed whenever a cookie was due (the session's daily renewal, a
  // page without wgp_who).
  if (response.status === 101) {
    const headers = new Headers(response.headers);
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 101, headers, webSocket: response.webSocket });
  }
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

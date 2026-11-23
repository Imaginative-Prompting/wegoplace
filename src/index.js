// The Worker: the site's routes. The app's own files never come through here: Cloudflare's
// asset server answers them (wrangler.jsonc `run_worker_first` lists what does come here).
//
//   1. the gate (gate.js) decides whether the request may go on at all;
//   2. the route table (routes.js) finds the handler for an API or page route;
//   3. an /api address the table doesn't answer gets a JSON 404 (or a 405 naming the methods
//      it does answer at that address), never the app's page: the app's own code reads the
//      answer, and a page of markup there reads as "offline"; one under /tiles/ gets a plain 404;
//   4. anything else that got here is a file from public/ after all.
//
// A handler is called with one argument, the same shape it had as a Pages Function:
//   request    the request itself. Only the last handler in a chain reads a body (the gate
//              never does), so nobody needs a copy, and a copy would hold every upload part
//              in memory a second time
//   env        the bindings and settings in wrangler.jsonc: DB, MEDIA, TILES, ASSETS, …
//   params     what the route's `:name` parts caught
//   data       an object shared along the chain; the gate puts the signed-in `user` on it
//   next()     hands the request on to whatever comes after this handler
//   waitUntil  keeps the Worker alive for work that outlasts the response

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { mcpApiHandler } from "./mcp/server.js";
import { explainRevoked, providerOptions, serveOAuth, sweepRevoked } from "./mcp/oauth.js";
import { drain } from "./trips/drain.js";
import { counted, countingOn, logCount } from "./query-count.js";
import { siteOrigins, withLocalCookies } from "./accounts/util.js";
import { json } from "./api/json.js";
import { onRequest as gate } from "./gate.js";
import { findRoute, methodsAt, ROUTES } from "./routes.js";
import { recordServerError, sweepErrors } from "./errors.js";
import { sweepBugReports } from "./bug-reports.js";
import { fresh, staticFile } from "./static.js";
import { noTile } from "./tiles.js";
import { JSON_BODY_MAX, ROWS_PER_WRITE_MAX } from "../public/js/shared/limits.js";
import { isOldWrite, oldWrite } from "./old-writes.js";
import { guardProviderFetch } from "./mcp/cimd-fetch.js";
import { errorLine } from "./log.js";

// The OAuth provider's fetches (a client's metadata document, its keys) never follow a redirect (src/mcp/cimd-fetch.js).
guardProviderFetch(globalThis);
// The trips' rooms (live updates): a Durable Object class the deploy binds as ROOMS.
export { TripRoom } from "./trips/room.js";
// Each trip's map maker (src/map/): a Durable Object class the deploy binds as MAPS.
export { TripMap } from "./map/map-object.js";

/** An /api address with no handler for this method. It stands behind the gate, so someone signed out gets the 401 first. */
function noApiRoute({ request }) {
  const allow = methodsAt(new URL(request.url).pathname).filter((m) => m !== "*");
  return allow.length
    ? json({ error: "method not allowed", allow }, 405, { Allow: allow.join(", ") })
    : json({ error: "no such route" }, 404);
}

/** The site itself: everything but the OAuth provider's own addresses and /mcp. */
const site = {
  async fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    // A write to an address the old site had: 503 before anything reads the session, so a phone
    // still running the old app keeps the change for the new one to send (src/old-writes.js).
    if (isOldWrite(request.method, pathname)) return withLocalCookies(fresh(oldWrite()), env, request.url);
    const route = findRoute(request.method, pathname);
    const chain = [{ handler: gate, params: {} }];
    if (route) chain.push(route);
    else if (/^\/api(\/|$)/i.test(pathname)) chain.push({ handler: noApiRoute, params: {} });
    // Under /tiles/ only the fonts are served now: anything else there is a 404, not the app's page.
    else if (/^\/tiles(\/|$)/i.test(pathname)) chain.push({ handler: noTile, params: {} });

    // A check's own server (ERROR_PROBE "on", never set on the site): an address that throws, so the count of the Worker's
    // own errors can be seen to work.
    if (env.ERROR_PROBE === "on" && pathname === "/api/__probe/throw") throw new Error("probe: the Worker's own error, thrown on purpose");
    // And the cron, its real jobs and one that fails, run now.
    if (env.ERROR_PROBE === "on" && pathname === "/api/__probe/cron") {
      await cron(env, [...CRON_JOBS(env), ["probe", async () => { throw new Error("probe: a cron job that failed, on purpose"); }]]);
      return new Response(null, { status: 204 });
    }

    let data = {};
    let at = 0;
    const next = async () => {
      const step = chain[at++];
      if (!step) return staticFile(request, env);
      const response = await step.handler({
        request,
        env,
        params: step.params,
        get data() { return data; },
        set data(value) {
          if (typeof value !== "object" || value === null) throw new Error("data must be an object");
          data = value;
        },
        next,
        waitUntil: ctx.waitUntil.bind(ctx),
      });
      if (!(response instanceof Response)) throw new Error("a handler must return a Response");
      return fresh(response);
    };
    return withLocalCookies(await next(), env, request.url);
  },
};

/**
 * The site, with its own uncaught errors counted (src/errors.js) under the route's pattern ("GET /api/trips/:trip"), never
 * the path, and answered 500 in words instead of the runtime's blank page.
 */
const counted500 = {
  async fetch(request, env, ctx) {
    try {
      return await site.fetch(request, env, ctx);
    } catch (error) {
      const { pathname } = new URL(request.url);
      const route = findRoute(request.method, pathname);
      const place = route ? `${request.method} ${ROUTES[route.index][1]}` : `${request.method} ${pathname.startsWith("/api/") ? "/api/*" : "/*"}`;
      ctx.waitUntil(recordServerError(env, "server", error, place));
      console.error(JSON.stringify({ uncaught: place, error: errorLine(error, env) }));
      return json({ error: "server error", reason: "Something went wrong on our side. It's been noted; try again in a moment." }, 500);
    }
  },
};

/** /mcp, with its own uncaught errors counted the same way (a tool's own refusals are answers, not errors). */
const countedMcp = {
  async fetch(request, env, ctx) {
    try {
      return await mcpApiHandler.fetch(request, env, ctx);
    } catch (error) {
      ctx.waitUntil(recordServerError(env, "mcp", error, `${request.method} /mcp`));
      console.error(JSON.stringify({ uncaught: "/mcp", error: errorLine(error, env) }));
      return json({ error: "server error", reason: "Something went wrong on our side. It's been noted; try again in a moment." }, 500);
    }
  },
};

/** The cron's jobs, each one's failure counted by its name (nothing else of it). */
async function cron(env, jobs) {
  const results = await Promise.allSettled(jobs.map(([, run]) => run()));
  await Promise.all(results.map((r, i) => (r.status === "rejected" ? recordServerError(env, "cron", r.reason, `cron ${jobs[i][0]}`) : null)));
}
const CRON_JOBS = (env) => [["drain", () => drain(env)], ["revoked", () => sweepRevoked(env)], ["errors", () => sweepErrors(env)], ["bugs", () => sweepBugReports(env)]];

// The OAuth provider wraps the site (src/mcp/oauth.js): it answers /token, /register and the
// /.well-known/ documents, checks the token on /mcp before src/mcp/server.js runs, and hands
// every other request to the site. One provider per origin: wegoplace.com, or a local server's
// own address, so local checks can call its /mcp.
const providers = new Map();
function providerFor(env) {
  const resource = `${env.PUBLIC_ORIGIN}/mcp`;
  let entry = providers.get(resource);
  if (!entry) {
    const options = providerOptions(resource, { apiHandler: countedMcp, defaultHandler: counted500 });
    entry = { provider: new OAuthProvider(options), options };
    providers.set(resource, entry);
  }
  return entry;
}

// The OAuth provider's addresses and /mcp: what an AI app reaches.
const APP_PATHS = /^\/(mcp|authorize|token|register)(\/|$)|^\/\.well-known\/(oauth-[a-z-]+|openid-configuration)(\/|$)/;
function elsewhereForApps(request, env) {
  const url = new URL(request.url);
  if (url.origin === env.PUBLIC_ORIGIN || !siteOrigins(env).includes(url.origin) || !APP_PATHS.test(url.pathname)) return null;
  const reason = `This site's AI connection is at ${env.PUBLIC_ORIGIN}/mcp: give your app that address.`;
  return json({ error: "misdirected", reason, use: `${env.PUBLIC_ORIGIN}/mcp` }, 421, {
    "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*",
  });
}

/** A JSON body said to be past JSON_BODY_MAX: 413 in words. (One sent without its length is read with a cap: src/api/json.js.) */
function jsonTooBig(request) {
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") ?? "")) return null;
  const length = Number(request.headers.get("Content-Length"));
  if (!(length > JSON_BODY_MAX)) return null;
  return json({ error: "too large", max_bytes: JSON_BODY_MAX,
    reason: `A request's words are at most ${Math.round(JSON_BODY_MAX / 1024 / 1024)} MB. Send fewer rows at a time (${ROWS_PER_WRITE_MAX} at most).` }, 413, { "Cache-Control": "no-store" });
}

export default {
  // The drain (src/trips/drain.js): a cron in wrangler.jsonc's triggers removes the files whose
  // rows are gone, and the changes past their days. Locally, `wrangler dev --test-scheduled`
  // runs it at /__scheduled.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cron(env, CRON_JOBS(env)));
  },

  async fetch(request, deployEnv, ctx) {
    // check:queries counts each request's D1 queries on a check's own server (src/query-count.js).
    const tally = countingOn(deployEnv) ? { n: 0 } : null;
    const base = tally ? { ...counted(deployEnv, tally), QUERY_TALLY: tally } : deployEnv;
    // Work that may finish after the answer (a trip's room hearing a write: src/trips/live.js).
    const env = { ...base, LATER: (promise) => ctx.waitUntil(promise) };
    // An AI app given another of the site's addresses (www) is told the one to use, in words: a
    // client holds the resource it is given to the one the server's documents name (RFC 9728),
    // so the connection only works at PUBLIC_ORIGIN, and a redirect would fail there with worse
    // words.
    const misdirected = elsewhereForApps(request, env);
    if (misdirected) return misdirected;
    // A JSON body past JSON_BODY_MAX is refused before anything reads it: a Worker parses a body whole, and a
    // request may carry 100 MB. Files come as bytes (their own sizes and the host's room hold them), never JSON.
    const tooBig = jsonTooBig(request);
    if (tooBig) return tooBig;
    const { provider, options } = providerFor(env);
    const response = await explainRevoked(request, await serveOAuth(request, env, ctx, provider, options), env);
    // /mcp's own line is written by its tool, once its work is done (src/mcp/server.js).
    if (tally && new URL(request.url).pathname !== "/mcp") logCount(tally, request);
    return response;
  },
};

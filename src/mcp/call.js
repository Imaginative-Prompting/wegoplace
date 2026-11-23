// A tool's work, done by the app's own routes (the MCP plan, point 3).
//
// Every MCP tool reads and writes through the same route a person's phone uses, called here in
// the same process as the person the connection belongs to: the route table finds the handler,
// inTrip() checks they are on the trip, and the handler holds each row to its rules and refuses
// in its own words. So a rule is written once, and an AI is held to exactly what a person is.
// The gate is the one step skipped: it reads a session cookie, and an MCP request carries an
// OAuth token instead, checked before this runs (src/mcp/server.js).
//
// A write carries the tool call's change (env.CHANGE, src/trips/changes.js): every write()
// the handler makes records its rows under that change.

import { findRoute } from "../routes.js";

/** The account an MCP request acts as, as the gate would give it, or null if it is gone. */
export async function personOf(env, userId) {
  const u = await env.DB.prepare("SELECT id, name FROM users WHERE id = ?1 AND deleted_at IS NULL").bind(userId).first();
  if (!u) return null;
  const on = await env.DB.prepare("SELECT 1 AS y FROM trip_members WHERE user_id = ?1 AND left_at IS NULL LIMIT 1").bind(userId).first();
  return { id: u.id, name: u.name, onTrip: Boolean(on) };
}

/**
 * Calls the route at `method path` as `user`, with `body` (JSON, or bytes with `raw`). Answers
 * { status, json }. `origin` is the site's address as the MCP request reached it (links the
 * route makes, an upload link's, start with it).
 */
export async function callRoute(env, { user, change = null, origin, waitUntil }, method, path, body, { raw = false } = {}) {
  const url = new URL(path, origin);
  // The address is the one the tool built, or nothing is called: an id of ".." (which
  // encodeURIComponent leaves as it is) would otherwise fold /events/.. into another route.
  if (url.pathname !== path.split("?")[0]) {
    return { status: 400, json: { error: "bad id", reason: "An id is letters, digits and hyphens; \".\" and \"..\" aren't ids." } };
  }
  const headers = new Headers({ Accept: "application/json" });
  if (body !== undefined) headers.set("Content-Type", raw ? "application/octet-stream" : "application/json");
  const request = new Request(url, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const route = findRoute(method, url.pathname);
  if (!route) return { status: 404, json: { error: "no such route" } };
  let data = { user };
  const ctx = {
    request,
    env: change ? { ...env, CHANGE: change } : env,
    params: route.params,
    get data() { return data; },
    set data(value) { data = value; },
    next: async () => new Response(JSON.stringify({ error: "no such route" }), { status: 404 }),
    waitUntil: waitUntil ?? (() => {}),
  };
  const response = await route.handler(ctx);
  let json = null;
  try { json = await response.json(); } catch { /* not JSON */ }
  return { status: response.status, json };
}

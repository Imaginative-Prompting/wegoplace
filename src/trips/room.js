// A trip's room: one Durable Object per trip (env.ROOMS.getByName(<trip id>)) that holds the open
// tabs' WebSockets and tells them when the trip changed (model §10). It knows nothing of the trip:
// a message it sends is {"rev": n} and nothing else, and the tab then reads through the routes as
// it always has, so who sees what stays decided in one place.
//
// It is reached two ways, both only from this Worker:
//   fetch()  a tab opening its socket, after src/trips/live.js has checked the session, the trip
//            and the page's origin; the Worker writes the x-wgp-* headers and nothing else can;
//   tell()   a write to the trip (src/trips/rev.js moved()), or someone leaving it.
//
// It hibernates (Cloudflare's WebSocket Hibernation API): between messages it isn't in memory and
// costs no duration, the sockets stay open at Cloudflare's edge, and "ping" is answered by an
// auto-response without waking it. It sets no alarm and no timer, which would keep it awake. It
// stores nothing; each socket carries who it is for in its attachment and its tags. The class is
// SQLite-backed only because a free account can create no other kind.

import { DurableObject } from "cloudflare:workers";
import { LIVE_PER_PERSON, LIVE_PER_TRIP, LIVE_SOCKET_HOURS } from "../../public/js/shared/limits.js";

/** Close codes a tab reads (docs/API.md, "Live updates"). */
export const CLOSE = { AGAIN: 4000, NOT_ON_TRIP: 4001, GONE: 4004, TOO_MANY: 4008, ONLY_PING: 1003 };

const userTag = (id) => `u:${id}`;
const sessionTag = (hash) => `s:${hash}`;

export class TripRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answered at the edge, without waking the room or costing duration.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // The newest rev told, while in memory: an older poke that arrives late isn't sent on.
    this.top = 0;
  }

  /** A tab's socket, from the Worker's /live route only. */
  async fetch(request) {
    const user = request.headers.get("x-wgp-user");
    const session = request.headers.get("x-wgp-session");
    const rev = Number(request.headers.get("x-wgp-rev"));
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket" || !user || !session || !Number.isInteger(rev)) {
      return new Response("the room is opened by the Worker's /live route", { status: 400 });
    }
    this.sweep();
    // This person's oldest sockets past their share close; the trip's room has a ceiling.
    const theirs = this.ctx.getWebSockets(userTag(user)).sort((a, b) => (a.deserializeAttachment()?.at ?? 0) - (b.deserializeAttachment()?.at ?? 0));
    for (const old of theirs.slice(0, Math.max(0, theirs.length - LIVE_PER_PERSON + 1))) closeQuietly(old, CLOSE.TOO_MANY, "too many open on this trip: the oldest closes");
    if (this.ctx.getWebSockets().length >= LIVE_PER_TRIP) return new Response("this trip has as many open as it takes", { status: 429 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [userTag(user), sessionTag(session)]);
    server.serializeAttachment({ user, session, at: Date.now() });
    // The trip as of the open, so a tab catches up at once.
    this.top = Math.max(this.top, rev);
    server.send(JSON.stringify({ rev }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * From a write or a departure: { rev } tells every socket the trip's new rev; { drop: user }
   * closes that person's sockets first (they're not on the trip now); { session } closes that
   * session's (signed out); { gone: true } closes every socket (the trip was deleted).
   * Answers how many sockets it told, for the checks.
   */
  async tell({ rev = null, drop = null, session = null, gone = false } = {}) {
    if (gone) {
      for (const ws of this.ctx.getWebSockets()) closeQuietly(ws, CLOSE.GONE, "the trip was deleted");
      return { told: 0 };
    }
    if (drop) for (const ws of this.ctx.getWebSockets(userTag(drop))) closeQuietly(ws, CLOSE.NOT_ON_TRIP, "not on this trip");
    if (session) for (const ws of this.ctx.getWebSockets(sessionTag(session))) closeQuietly(ws, CLOSE.NOT_ON_TRIP, "signed out");
    this.sweep();
    if (!Number.isInteger(rev) || rev <= this.top) return { told: 0 };
    this.top = rev;
    const message = JSON.stringify({ rev });
    let told = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(message); told += 1; } catch { /* closing already */ }
    }
    return { told };
  }

  /** A tab sends nothing but "ping" (answered before it reaches here). */
  async webSocketMessage(ws) {
    closeQuietly(ws, CLOSE.ONLY_PING, "this socket only listens");
  }

  async webSocketClose(ws, code, reason) {
    closeQuietly(ws, code === 1005 || code === 1006 ? 1000 : code, reason);
  }

  async webSocketError(ws) {
    closeQuietly(ws, 1011, "socket error");
  }

  /** Sockets past their hours close, so a session that has ended stops hearing the trip. */
  sweep() {
    const cut = Date.now() - LIVE_SOCKET_HOURS * 3600 * 1000;
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment()?.at ?? 0) < cut) closeQuietly(ws, CLOSE.AGAIN, "open it again");
    }
  }
}

function closeQuietly(ws, code, reason) {
  try { ws.close(code, reason); } catch { /* closed already */ }
}

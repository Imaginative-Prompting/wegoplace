// The trip's socket, the client's side (docs/API.md, "Live updates: the trip's socket").
//
// The server tells every open tab {"rev": n} when the trip changes, and nothing else. This file
// opens that socket for the trip this page is, keeps it honest, and turns its pokes into the two
// things a module acts on:
//
//   live.on("data", fn)   the trip's own data moved (data_rev): read the trip, as the store's
//                         timer does. fn({ rev, data_rev, seq }).
//   live.on("chat", fn)   the chat moved (seq): read its changes. fn({ rev, data_rev, seq }).
//
// Each answers a function that stops listening. The first listener opens the socket; nothing is
// opened on a page that isn't a trip's, or in a browser with no WebSocket. Without a socket
// nothing is wrong: the app's own asking goes on as it always has (the store's heartbeat), and
// this file only makes changes arrive within seconds.
//
// THE RULES IT KEEPS (the contract's five):
//   1. It holds the trip's { rev, data_rev, seq } as last read from GET …/rev. A poke whose rev
//      isn't newer is ignored (the room can send a late one out of order); a newer one is read.
//   2. It reads /rev at most once a second: at the first newer poke, then, if more came during the
//      second, once at its end. A burst of twenty writes is one or two reads.
//   3. A socket that couldn't open, was refused or closed is opened again after 1 s, doubling, at
//      most a minute; the wait starts over once a socket has stayed open a minute.
//   4. "ping" every 30 s; no "pong" within 10 s, or the socket sitting in CLOSING for 5 s, counts
//      as closed.
//   5. Hidden for 30 s, the socket closes; shown again, it opens and reads /rev once.
//   Close codes: 4001 (not on the trip, signed out) and 4004 (the trip was deleted) don't reopen:
//   "data" fires once so the store reads the trip and learns why. 4000 reopens at once. 1003 (this
//   tab sent something other than "ping") is a bug: logged, not reopened.

import { tripApi, tripIdFromPath } from "./trip-here.js";

export const TIMING = Object.freeze({
  pingMs: 30_000,
  pongWaitMs: 10_000,
  closingStuckMs: 5_000,
  readGapMs: 1_000,
  backoffFirstMs: 1_000,
  backoffMaxMs: 60_000,
  steadyMs: 60_000,          // open this long, and the next wait starts from the first again
  hiddenCloseMs: 30_000,
});

const NO_REOPEN = new Set([4001, 4004, 1003]);

/**
 * A live connection for one trip. Exported for the checks (they make one with their own
 * `WebSocket` and `fetch`); the app uses `live` below.
 */
export function liveFor(tripId, {
  WS = globalThis.WebSocket, fetchFn = (...a) => globalThis.fetch(...a), doc = globalThis.document,
  origin = globalThis.location?.origin ?? "", now = () => Date.now(), timing = {},
} = {}) {
  const T = { ...TIMING, ...timing };
  const listeners = { data: new Set(), chat: new Set() };
  const held = { rev: null, data_rev: null, seq: null };
  const state = { socket: null, status: "idle", opens: 0, reads: 0, pokes: 0, stopped: false, lastClose: null };
  let wait = T.backoffFirstMs;
  let reopenTimer = null;
  let pingTimer = null;
  let pongTimer = null;
  let steadyTimer = null;
  let closingTimer = null;
  let hiddenTimer = null;
  let lastRead = 0;
  let readTimer = null;
  let reading = null;
  let wanted = null;          // the newest rev a poke has named that isn't read yet

  const emit = (kind, at) => { for (const fn of [...listeners[kind]]) { try { fn(at); } catch (e) { console.error(`[live] a ${kind} listener failed`, e); } } };

  /** Reads /rev and says what moved. `first`: a socket's opening read (it waits for one already out, then reads). */
  async function readRev({ first = false } = {}) {
    if (reading) { await reading; if (!first) return; }
    reading = (async () => {
      lastRead = now();
      state.reads += 1;
      let res;
      try { res = await fetchFn(tripApi(tripId, "/rev"), { credentials: "same-origin", headers: { Accept: "application/json" } }); } catch { return; }
      if (!res.ok) {
        // Not on the trip, or no trip, or signed out: the store's own read says which.
        if (res.status === 404 || res.status === 401) emit("data", { ...held });
        return;
      }
      const now_ = await res.json().catch(() => null);
      if (!now_ || !Number.isInteger(now_.rev)) return;
      const before = { ...held };
      if (held.rev === null || now_.rev > held.rev) Object.assign(held, { rev: now_.rev, data_rev: now_.data_rev ?? null, seq: now_.seq ?? null });
      // Held values outlive a socket, so a reopened one tells only what moved while it was gone.
      // The page's very first read tells both: a write between the store's boot and this read
      // would otherwise be missed.
      if (before.data_rev === null || (now_.data_rev ?? 0) > before.data_rev) emit("data", { ...held });
      if (before.seq === null || (now_.seq ?? 0) > before.seq) emit("chat", { ...held });
    })();
    try { await reading; } finally { reading = null; }
    // A newer poke came while this read was out: one more read, a second after this one.
    if (wanted !== null && (held.rev === null || wanted > held.rev)) schedule();
    else wanted = null;
  }

  function schedule() {
    if (readTimer) return;
    const gap = Math.max(0, lastRead + T.readGapMs - now());
    readTimer = setTimeout(() => { readTimer = null; readRev(); }, gap);
  }

  function poke(rev) {
    state.pokes += 1;
    if (!Number.isInteger(rev)) return;
    if (held.rev !== null && rev <= held.rev) return;          // late, or already read
    wanted = Math.max(wanted ?? 0, rev);
    schedule();
  }

  function clearTimers() {
    for (const t of [pingTimer, pongTimer, steadyTimer, closingTimer]) { clearTimeout(t); clearInterval(t); }
    pingTimer = pongTimer = steadyTimer = closingTimer = null;
  }

  /** The socket is done, however it ended: decide whether and when to open another. */
  function ended(code, reason) {
    if (state.status === "closed") return;
    clearTimers();
    const ws = state.socket;
    state.socket = null;
    state.status = "closed";
    state.lastClose = { code, reason, at: now() };
    try { ws?.close(); } catch { /* closed already */ }
    if (code === 1003) console.error("[live] the trip's socket closed 1003: this tab sent something other than \"ping\"");
    if (code === 4001 || code === 4004) emit("data", { ...held });
    if (state.stopped || NO_REOPEN.has(code) || doc?.visibilityState === "hidden") return;
    const delay = code === 4000 ? 0 : wait;
    if (code !== 4000) wait = Math.min(wait * 2, T.backoffMaxMs);
    clearTimeout(reopenTimer);
    reopenTimer = setTimeout(open, delay);
  }

  function open() {
    clearTimeout(reopenTimer);
    if (state.stopped || state.socket || typeof WS !== "function") return;
    let ws;
    try { ws = new WS(`${origin.replace(/^http/, "ws")}${tripApi(tripId, "/live")}`); } catch { ended(1006, "couldn't open"); return; }
    state.socket = ws;
    state.status = "opening";
    state.opens += 1;
    ws.onopen = () => {
      if (state.socket !== ws) return;
      state.status = "open";
      // Rule 4: a ping every 30 s, a pong within 10.
      pingTimer = setInterval(() => {
        if (ws.readyState === 2 && !closingTimer) closingTimer = setTimeout(() => ended(1006, "stuck closing"), T.closingStuckMs);
        if (ws.readyState !== 1) return;
        try { ws.send("ping"); } catch { ended(1006, "couldn't ping"); return; }
        clearTimeout(pongTimer);
        pongTimer = setTimeout(() => ended(1006, "no pong"), T.pongWaitMs);
      }, T.pingMs);
      // Rule 3: a socket that stays open a minute starts the waits over.
      steadyTimer = setTimeout(() => { wait = T.backoffFirstMs; }, T.steadyMs);
      // The first read: what moved while there was no socket.
      readRev({ first: true });
    };
    ws.onmessage = (e) => {
      if (state.socket !== ws) return;
      if (e.data === "pong") { clearTimeout(pongTimer); pongTimer = null; return; }
      let m = null;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m && Number.isInteger(m.rev)) {
        // The opening message is the trip's rev now: the first read covers it.
        if (state.status === "open" && held.rev === null && reading) return;
        poke(m.rev);
      }
    };
    ws.onclose = (e) => { if (state.socket === ws) ended(e.code, e.reason); };
    ws.onerror = () => { /* a close follows */ };
  }

  // Rule 5: hidden a while, closed; shown, opened, and /rev read once (the open does it).
  const onVisibility = () => {
    if (!doc) return;
    if (doc.visibilityState === "hidden") {
      clearTimeout(hiddenTimer);
      hiddenTimer = setTimeout(() => { if (state.socket) { const ws = state.socket; ended(1000, "hidden"); try { ws.close(1000, "hidden"); } catch { /* */ } } }, T.hiddenCloseMs);
    } else {
      clearTimeout(hiddenTimer);
      if (!state.socket && !state.stopped && !NO_REOPEN.has(state.lastClose?.code)) { wait = T.backoffFirstMs; open(); }
    }
  };
  doc?.addEventListener?.("visibilitychange", onVisibility);

  return {
    /** Listen for "data" or "chat"; answers the function that stops. The first listener opens the socket. */
    on(kind, fn) {
      if (!listeners[kind]) throw new Error(`live.on: "data" or "chat", not "${kind}"`);
      listeners[kind].add(fn);
      if (!state.socket && state.status === "idle") open();
      return () => listeners[kind].delete(fn);
    },
    /** What it holds and how it stands, for the checks and a debugging eye. */
    state: () => ({ ...state, socket: undefined, readyState: state.socket?.readyState ?? null, held: { ...held }, wait }),
    /** Closes and stops for good (the page is leaving the trip). */
    stop() {
      state.stopped = true;
      clearTimeout(reopenTimer); clearTimeout(hiddenTimer); clearTimeout(readTimer);
      const ws = state.socket;
      ended(1000, "stopped");
      try { ws?.close(1000, "stopped"); } catch { /* */ }
      doc?.removeEventListener?.("visibilitychange", onVisibility);
    },
  };
}

// The app's one connection: this page's trip, or none.
const TRIP = tripIdFromPath(globalThis.location?.pathname ?? "");
const NONE = { on: () => () => {}, state: () => ({ status: "none" }), stop() {} };
export const live = TRIP && typeof globalThis.WebSocket === "function" ? liveFor(TRIP) : NONE;

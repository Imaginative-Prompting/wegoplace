// The socket's client (public/js/live.js), held to the contract in docs/API.md ("Live updates").
//
//   node checks/live/client.mjs [--port 8791]      (through the channel's queue, like every browser check)
//
// Part 1, in Node, with a socket and a /rev of its own (so each rule can be provoked on purpose,
// on short timings): the first read; a burst read at most once a second; a late poke ignored; a
// chat that moves only "chat"; no pong, and a socket stuck closing, counted as closed and opened
// again with the backoff doubling; 4001 and 4004 read the trip and don't reopen; 4000 reopens at
// once; 1003 doesn't; hidden closes it, shown opens it and reads; no WebSocket, nothing at all.
//
// Part 2, in a real browser (Chrome for Testing) against a real server, two people on one trip,
// each in a page of their own: a write of one reaches the other's page as "data" and a chat
// message as "chat" only; a burst of twenty writes is read at most a few times; the server going
// away and coming back reopens the socket and reports what moved while it was gone; the person
// removed hears the room's close and the socket stays shut.
//
// Its server and browser are its own. Everyone in it is made up.

import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";
import { liveFor } from "../../public/js/live.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8791);
const t = new Report("the socket's client");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server, chrome;
let code = 1;

// ── part 1's stand-ins ─────────────────────────────────────────────────────────────────────
/** The trip as /rev says it, and the reads it was asked for. */
function fakeTrip() {
  const trip = { rev: 10, data_rev: 10, seq: 3, reads: 0, status: 200 };
  trip.fetch = async () => {
    trip.reads += 1;
    await sleep(5);
    return { ok: trip.status === 200, status: trip.status, json: async () => ({ rev: trip.rev, data_rev: trip.data_rev, seq: trip.seq }) };
  };
  return trip;
}
/** A socket that opens unless told not to, says the trip's rev, and answers ping unless told not to. */
function fakeSockets(trip) {
  const made = [];
  const how = { refuse: false, pong: true };
  class WS {
    constructor(url) {
      this.url = url; this.readyState = 0; this.sent = []; made.push(this);
      setTimeout(() => {
        if (how.refuse) { this.readyState = 3; this.onclose?.({ code: 1006, reason: "" }); return; }
        this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ rev: trip.rev }) });
      }, 5);
    }
    send(d) { this.sent.push(d); if (d === "ping" && how.pong) setTimeout(() => this.onmessage?.({ data: "pong" }), 5); }
    close(code = 1000, reason = "") { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose?.({ code, reason }), 1); }
    /** The room closes it. */
    roomCloses(code) { this.readyState = 3; this.onclose?.({ code, reason: "" }); }
    poke(rev) { this.onmessage?.({ data: JSON.stringify({ rev }) }); }
  }
  return { WS, made, how };
}
/** A document whose visibility the check sets. */
function fakeDoc() {
  const d = new EventTarget();
  d.visibilityState = "visible";
  d.show = (v) => { d.visibilityState = v; d.dispatchEvent(new Event("visibilitychange")); };
  return d;
}
const FAST = { pingMs: 80, pongWaitMs: 40, closingStuckMs: 60, readGapMs: 200, backoffFirstMs: 50, backoffMaxMs: 400, steadyMs: 5000, hiddenCloseMs: 100 };
function harness(timing = FAST) {
  const trip = fakeTrip();
  const ws = fakeSockets(trip);
  const doc = fakeDoc();
  const heard = [];
  const live = liveFor("t-1", { WS: ws.WS, fetchFn: trip.fetch, doc, origin: "http://check.test", timing });
  const record = (kind) => (at) => heard.push({ kind, ...at, t: Date.now() });
  live.on("data", record("data"));
  live.on("chat", record("chat"));
  return { trip, ws, doc, heard, live, kinds: () => heard.map((h) => h.kind) };
}

try {
  t.part("1. The rules, on a socket and a /rev of the check's own");
  {
    const h = harness();
    await sleep(60);
    t.same("it opens the trip's socket at its address and reads /rev once: the first read tells \"data\" and \"chat\", and holds what it read",
      [h.ws.made.length, h.ws.made[0].url, h.trip.reads, h.kinds(), h.live.state().held], [1, "ws://check.test/api/trips/t-1/live", 1, ["data", "chat"], { rev: 10, data_rev: 10, seq: 3 }]);

    h.heard.length = 0;
    const before = h.trip.reads;
    const s = h.ws.made[0];
    const started = Date.now();
    for (let i = 0; i < 20; i++) { h.trip.rev += 1; h.trip.data_rev = h.trip.rev; s.poke(h.trip.rev); await sleep(5); }
    await sleep(600);
    const reads = h.trip.reads - before;
    t.ok(`a burst of 20 pokes is read at most once a second (here a second is ${FAST.readGapMs} ms): ${reads} reads in ${Date.now() - started} ms, ending on the newest`,
      reads >= 1 && reads <= 2 && h.live.state().held.rev === 30 && h.kinds().every((k) => k === "data"), { reads, heard: h.kinds() });

    const r0 = h.trip.reads;
    s.poke(25); s.poke(30);
    await sleep(300);
    t.same("a late poke (an older rev) or one already read asks nothing", h.trip.reads - r0, 0);

    h.heard.length = 0;
    h.trip.rev += 1; h.trip.seq += 1;          // a chat message: rev and seq move, data_rev doesn't
    s.poke(h.trip.rev);
    await sleep(300);
    t.same("a chat message moves only \"chat\"", h.kinds(), ["chat"]);
    h.live.stop();
  }
  {
    const h = harness();
    await sleep(60);
    h.ws.how.pong = false;
    await sleep(FAST.pingMs + FAST.pongWaitMs + 40);
    t.same("no \"pong\" within its wait: counted as closed, and opened again", [h.ws.made[0].readyState, h.ws.made.length >= 2], [3, true]);
    h.live.stop();
  }
  {
    const h = harness();
    await sleep(60);
    const s = h.ws.made[0];
    s.close = () => {};                // a close that never finishes
    s.readyState = 2;                  // CLOSING, and no close event
    await sleep(FAST.pingMs + FAST.closingStuckMs + 80);
    t.same("a socket sitting in CLOSING: counted as closed, and opened again", h.ws.made.length >= 2, true);
    h.live.stop();
  }
  {
    const h = harness();
    await sleep(60);
    h.ws.how.refuse = true;
    const at = [];
    const n0 = h.ws.made.length;
    h.ws.made[0].roomCloses(1006);
    const t0 = Date.now();
    while (h.ws.made.length < n0 + 4 && Date.now() - t0 < 3000) { const n = h.ws.made.length; await sleep(5); if (h.ws.made.length > n) at.push(Date.now() - t0); }
    const gaps = at.map((x, i) => x - (i ? at[i - 1] : 0));
    t.ok(`refused, it opens again after 1 s, doubling, at most a minute (here ${FAST.backoffFirstMs} ms to ${FAST.backoffMaxMs}): waits of ${gaps.join(", ")} ms`,
      gaps.length === 4 && gaps[1] > gaps[0] * 1.5 && gaps[2] > gaps[1] * 1.5 && gaps[3] <= FAST.backoffMaxMs + 60, gaps);
    h.live.stop();
  }
  for (const [closeCode, what] of [[4001, "not on the trip"], [4004, "the trip deleted"]]) {
    const h = harness();
    await sleep(60);
    h.heard.length = 0;
    h.ws.made[0].roomCloses(closeCode);
    await sleep(FAST.backoffMaxMs + 100);
    t.same(`the room's ${closeCode} (${what}): "data" once, so the trip is read and says why, and no socket again`, [h.kinds(), h.ws.made.length], [["data"], 1]);
    h.live.stop();
  }
  {
    const h = harness();
    await sleep(60);
    h.ws.made[0].roomCloses(4000);
    await sleep(30);
    const again = h.ws.made.length;
    const h2 = harness();
    await sleep(60);
    h2.ws.made[0].roomCloses(1003);
    await sleep(FAST.backoffMaxMs + 100);
    t.same("4000 (open too long) opens again at once; 1003 (the tab sent something wrong) doesn't", [again, h2.ws.made.length], [2, 1]);
    h.live.stop(); h2.live.stop();
  }
  {
    const h = harness();
    await sleep(60);
    h.doc.show("hidden");
    await sleep(FAST.hiddenCloseMs + 50);
    const closedWhileHidden = h.live.state().readyState === null && h.ws.made[0].readyState === 3;
    h.trip.rev += 2; h.trip.data_rev = h.trip.rev;     // changed while hidden
    h.heard.length = 0;
    h.doc.show("visible");
    await sleep(80);
    t.same("hidden a while, the socket closes; shown, it opens again and reads /rev once, telling what moved", [closedWhileHidden, h.ws.made.length, h.kinds()], [true, 2, ["data"]]);
    h.live.stop();
  }
  {
    const trip = fakeTrip();
    const live = liveFor("t-1", { WS: null, fetchFn: trip.fetch, doc: fakeDoc(), origin: "http://check.test", timing: FAST });
    live.on("data", () => {});
    await sleep(100);
    t.same("a browser with no WebSocket: nothing opened, nothing asked (the store's own asking goes on)", [trip.reads, live.state().opens], [0, 0]);
  }

  // ── part 2: a real browser, a real server ──────────────────────────────────────────────────
  t.part("2. In a real browser, two people on one trip");
  server = await startServer({ name: "live-client", port });
  await server.start();
  const hana = new Person(server.origin, "Hana Client");
  const kai = new Person(server.origin, "Kai Client");
  for (const p of [hana, kai]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const T = (await hana.post("/api/trips", { name: "Live client", default_tz: "UTC", starts_on: "2027-04-01", ends_on: "2027-04-09" })).json.trip.id;
  const link = await hana.post(`/api/trips/${T}/links`, { uses: 1 });
  await kai.post(`/api/join/${link.json.link.code}`);

  chrome = await openChrome();
  const pages = {};
  for (const [who, p] of [["hana", hana], ["kai", kai]]) {
    const page = await chrome.page({ width: 390, height: 844, mobile: true });
    await page.setCookie(server.origin, "wgp_session", p.jar.cookies.get("wgp_session"));
    await page.goto(`${server.origin}/manifest.webmanifest`);
    // The app's own module, as the app loads it; what it hears kept on the page.
    await page.eval(`(async () => {
      const { liveFor } = await import("/js/live.js");
      window.__heard = [];
      window.__live = liveFor(${JSON.stringify(T)});
      window.__live.on("data", (at) => window.__heard.push({ kind: "data", ...at }));
      window.__live.on("chat", (at) => window.__heard.push({ kind: "chat", ...at }));
      return true;
    })()`);
    pages[who] = page;
  }
  for (const page of Object.values(pages)) await page.until("window.__heard.length >= 2", "the first read");
  const kinds = async (page) => page.eval("window.__heard.map((h) => h.kind)");
  t.same("each page opens its socket and reads once (\"data\" and \"chat\")", [await kinds(pages.hana), await kinds(pages.kai)], [["data", "chat"], ["data", "chat"]]);

  await pages.kai.eval("window.__heard.length = 0, true");
  const sent = Date.now();
  await hana.post(`/api/trips/${T}/events`, { id: "walk", title: "A walk", starts_at: Date.UTC(2027, 3, 3, 9) / 1000, tz: "UTC" });
  await pages.kai.until("window.__heard.some((h) => h.kind === 'data')", "Hana's write on Kai's page");
  await sleep(1200);
  t.same(`Hana's write reaches Kai's page as "data" (${Date.now() - sent - 1200} ms or less), and not as "chat"`, await kinds(pages.kai), ["data"]);

  await pages.hana.eval("window.__heard.length = 0, true");
  await kai.post(`/api/trips/${T}/messages`, { id: "m-1", body: "On my way" });
  await pages.hana.until("window.__heard.some((h) => h.kind === 'chat')", "Kai's message on Hana's page");
  await sleep(1200);
  t.same("Kai's chat message reaches Hana's page as \"chat\" only", await kinds(pages.hana), ["chat"]);

  const reads0 = (await pages.kai.eval("window.__live.state().reads"));
  for (let i = 0; i < 20; i++) await hana.post(`/api/trips/${T}/events`, { id: `burst-${i}`, title: `Burst ${i}`, starts_at: Date.UTC(2027, 3, 4, 9) / 1000 + i * 60, tz: "UTC" });
  await sleep(2500);
  const burst = (await pages.kai.eval("window.__live.state().reads")) - reads0;
  const tripRev = (await kai.get(`/api/trips/${T}/rev`)).json.rev;
  t.ok(`twenty writes in a row: Kai's page read /rev ${burst} times (at most once a second), and holds the trip's rev now`,
    burst >= 1 && burst <= 4 && (await pages.kai.eval("window.__live.state().held.rev")) === tripRev, { burst, tripRev });

  // The server goes away, the trip changes while it's down, the server comes back.
  await pages.kai.eval("window.__heard.length = 0, true");
  await server.halt();
  server.sql(`UPDATE trips SET rev = rev + 1, data_rev = rev + 1 WHERE id = '${T}'`);
  await server.start();
  await pages.kai.until("window.__live.state().opens >= 2 && window.__live.state().status === 'open'", "the socket opened again", 30000);
  await pages.kai.until("window.__heard.some((h) => h.kind === 'data')", "what moved while it was gone", 10000);
  t.ok("the server gone and back: Kai's socket opens again by itself, and tells \"data\" for the change made while it was gone",
    (await kinds(pages.kai)).includes("data"), await pages.kai.eval("window.__live.state()"));

  await pages.kai.eval("window.__heard.length = 0, true");
  await hana.call("DELETE", `/api/trips/${T}/members/${kai.user.id}`);
  await pages.kai.until("window.__live.state().lastClose?.code === 4001", "the room's close", 10000);
  const opensAtClose = await pages.kai.eval("window.__live.state().opens");
  await sleep(3000);
  t.same("Kai removed: the room's 4001 reaches his page, it tells \"data\" (the store then reads the trip and learns he's off it), and opens nothing again",
    [(await kinds(pages.kai)).includes("data"), await pages.kai.eval("window.__live.state().opens"), await pages.kai.eval("window.__live.state().readyState")], [true, opensAtClose, null]);

  const errors = [...pages.hana.errors, ...pages.kai.errors].filter((e) => !/WebSocket connection to .* failed/.test(e));
  t.same("no errors on either page (the browser's own line for a socket that couldn't connect while the server was down aside)", errors, []);
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await chrome?.close();
  await server?.stop();
}
process.exit(code);

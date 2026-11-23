// Live updates in a real browser (Chrome for Testing, through scripts/lib/browser.mjs): what
// check:live holds with its own socket client, held where it matters, in a page of the site.
//
//   node checks/live/browser.mjs [--port 8791]      (through the channel's queue, like every browser check)
//
// 1. A page of the site, signed in as someone on the trip, opens the trip's socket: it hears the
//    trip's rev at once, and the next one within seconds of another person's write.
// 2. "ping" is answered "pong".
// 3. The person is removed from the trip: the page's close event, 4001, at once. (Node's own
//    WebSocket client waits for the connection to end after a close frame, which a local server
//    holds open; Chrome reports the close when the frame arrives. This holds what a browser does.)
// 4. A page on another port of the same machine (the same site to the browser, so the cookie goes
//    with it) asks for the same socket: refused by the Origin rule, it never opens and hears nothing.
//
// Its server and browser are its own. Everyone in it is made up.

import http from "node:http";
import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8791);
const t = new Report("live updates, in a browser");
let server, chrome, elsewhere;
let code = 1;

/** In the page: opens the socket and keeps what happens on window.__live. */
const OPEN = (url) => `(() => {
  const s = { messages: [], opened: false, closed: null, closedAt: null, closingAt: null, errored: false, started: Date.now() };
  const ws = new WebSocket(${JSON.stringify(url)});
  ws.onopen = () => { s.opened = true; };
  ws.onmessage = (e) => { s.messages.push(e.data); };
  ws.onerror = () => { s.errored = true; };
  ws.onclose = (e) => { s.closed = { code: e.code, reason: e.reason }; s.closedAt = Date.now(); };
  setInterval(() => { if (ws.readyState === 2 && !s.closingAt) s.closingAt = Date.now(); }, 20);
  window.__ws = ws;
  window.__live = s;
  return true;
})()`;

try {
  server = await startServer({ name: "live-browser", port });
  await server.start();
  const host = new Person(server.origin, "Hana Browser");
  const kai = new Person(server.origin, "Kai Browser");
  for (const p of [host, kai]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const T = (await host.post("/api/trips", { name: "Live in a browser", default_tz: "UTC", starts_on: "2027-04-01", ends_on: "2027-04-09" })).json.trip.id;
  const link = await host.post(`/api/trips/${T}/links`, { uses: 1 });
  await kai.post(`/api/join/${link.json.link.code}`);
  const socketUrl = `${server.origin.replace(/^http/, "ws")}/api/trips/${T}/live`;

  chrome = await openChrome();
  const page = await chrome.page({ width: 390, height: 844, mobile: true });
  await page.setCookie(server.origin, "wgp_session", kai.jar.cookies.get("wgp_session"));
  // A plain file of the site: its origin, and no app script to move the page while the check runs.
  await page.goto(`${server.origin}/manifest.webmanifest`);

  t.part("1. A page of the site hears the trip");
  await page.eval(OPEN(socketUrl));
  await page.until("window.__live.messages.length > 0", "the socket's first message");
  const now = (await kai.get(`/api/trips/${T}/rev`)).json;
  t.same("it opens from the site's own page and hears the trip's rev at once", [await page.eval("window.__live.opened"), await page.eval("JSON.parse(window.__live.messages[0])")], [true, { rev: now.rev }]);
  const sent = Date.now();
  const wrote = await host.post(`/api/trips/${T}/events`, { id: "walk", title: "A walk", starts_at: Date.UTC(2027, 3, 3, 9) / 1000, tz: "UTC" });
  await page.until(`window.__live.messages.some((m) => JSON.parse(m).rev === ${wrote.json.rev})`, "the write's rev");
  t.ok(`another person's write reaches it with the new rev (${Date.now() - sent} ms)`, wrote.status === 201);

  t.part("2. Ping");
  await page.eval("window.__ws.send('ping'), true");
  await page.until("window.__live.messages.includes('pong')", "pong");
  t.ok("\"ping\" is answered \"pong\"", true);

  t.part("3. Removed from the trip");
  const removedAt = Date.now();
  const removed = await host.call("DELETE", `/api/trips/${T}/members/${kai.user.id}`);
  await page.until("window.__live.closed || window.__live.closingAt", "the room's close", 20000);
  await new Promise((r) => setTimeout(r, 3000));
  const seen = await page.eval("({ closed: window.__live.closed, closedAt: window.__live.closedAt, closingAt: window.__live.closingAt, state: window.__ws.readyState })");
  const closeMs = seen.closedAt ? seen.closedAt - removedAt : null;
  const closingMs = seen.closingAt ? seen.closingAt - removedAt : null;
  console.log(`    (the browser: ${seen.closed ? `close event ${seen.closed.code} after ${closeMs} ms` : `no close event in ${Date.now() - removedAt} ms`}; CLOSING ${closingMs !== null ? `after ${closingMs} ms` : "never seen"}; readyState now ${seen.state})`);
  t.ok(`the removal closes the page's socket at once: the browser's close event, 4001 (${closeMs} ms)`,
    removed.status === 200 && seen.closed?.code === 4001 && closeMs < 5000, seen);

  t.part("4. Another site's page (another port: the same site to the browser, so the cookie goes)");
  elsewhere = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>elsewhere</title>"); });
  await new Promise((r) => elsewhere.listen(0, "127.0.0.1", r));
  const other = await chrome.page({ width: 390, height: 844, mobile: true });
  await other.setCookie(server.origin, "wgp_session", host.jar.cookies.get("wgp_session"));
  await other.goto(`http://127.0.0.1:${elsewhere.address().port}/`);
  await other.eval(OPEN(socketUrl));
  await other.until("window.__live.closed || window.__live.errored", "the refusal", 15000);
  const refused = await other.eval("({ opened: window.__live.opened, messages: window.__live.messages.length, closed: window.__live.closed })");
  t.same("a page of another origin is refused: the socket never opens and hears nothing, though the trip's host is signed in", [refused.opened, refused.messages], [false, 0]);
  const control = await chrome.page({ width: 390, height: 844, mobile: true });
  await control.setCookie(server.origin, "wgp_session", host.jar.cookies.get("wgp_session"));
  await control.goto(`${server.origin}/manifest.webmanifest`);
  await control.eval(OPEN(socketUrl));
  await control.until("window.__live.messages.length > 0", "the host's own socket");
  t.ok("  (the same person from the site's own page opens it: the control)", await control.eval("window.__live.opened"));

  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await chrome?.close();
  elsewhere?.close();
  await server?.stop();
}
process.exit(code);

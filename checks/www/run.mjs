// The site at its second address (www.wegoplace.com: ALSO_ORIGINS), on a server of its own with
// http://localhost:<port> as the site's address and http://www.localhost:<port> as the second:
//
//   node checks/www/run.mjs [--port <port>]
//
// It holds, at the second address:
//   1. the site's own address is what the server says to print (config's `origin`), there too;
//   2. a passkey made there signs in there and at the first (RP_ID is the name they share); a
//      session is the address's own (host-only cookies), and the one-use link signs in there;
//   3. a write from a page there is taken; a write that crosses (a page at one address to the
//      other) is refused as from another site, both ways; a server reached at an address that
//      isn't one of the site's still takes PUBLIC_ORIGIN's pages, as before;
//   4. the trip's live socket opens there for a page there, and not for the other address's page;
//   5. Google and GitHub, started there, are sent to the first address's sign-in page, nothing kept;
//   6. an AI app given the second address is told the first in words (421), on /mcp and on every
//      address of the OAuth provider; at the first address nothing changed;
//   7. a link the server prints for someone else (a picture's upload link) is the first address's;
//   8. every page of the app is served there, with public/js/www.js as the first script of each.
// Everyone in it is made up.

import crypto from "node:crypto";
import http from "node:http";
import { CheckError, startServer, freePort } from "../lib/server.mjs";
import { Person, Report, newPasskey } from "../lib/person.mjs";
import { makeLink } from "../../tools/signin-link.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const t = new Report("the site at its second address");
const MAIN = `http://localhost:${port}`;
const WWW = `http://www.localhost:${port}`;

/** A websocket upgrade asked for by hand: its status. */
function upgrade(host, path, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: {
      Host: host, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"), ...headers } });
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", () => resolve(0));
    req.end();
  });
}

let server, code = 1;
try {
  server = await startServer({ name: "www", port, vars: { ALSO_ORIGINS: WWW } });
  await server.start();
  if (server.origin !== MAIN) throw new CheckError(`the check's server is at ${server.origin}, not ${MAIN}`);

  t.part("1. The address to print");
  const anon = new Person(WWW, "a visitor");
  t.same("config names the site's own address, asked at the second", (await anon.get("/api/auth/config")).json?.origin, MAIN);
  t.same("  (and at the first)", (await new Person(MAIN, "a visitor").get("/api/auth/config")).json?.origin, MAIN);

  t.part("2. Signing in there");
  const key = newPasskey();
  const ada = new Person(WWW, "Ada Reyes");
  const made = await ada.signUp(key);
  t.same("a passkey made at the second address makes an account", [made.status, ada.signedIn], [200, true]);
  t.ok("  its session cookie is that address's own (no Domain)", made.cookies.some((c) => /^wgp_session=/.test(c)) && made.cookies.every((c) => !/;\s*Domain=/i.test(c)), made.cookies);
  const again = new Person(WWW, "Ada Reyes");
  again.passkeys = ada.passkeys;
  t.same("the same passkey signs in there again", [(await again.signIn(key, { origin: WWW })).status, (await again.me())?.id], [200, ada.user.id]);
  const atMain = new Person(MAIN, "Ada Reyes");
  t.same("and at the first address, a session of its own", [(await atMain.signIn(key, { origin: MAIN })).status, (await atMain.me())?.id], [200, ada.user.id]);
  const wrongPage = new Person(WWW, "Ada Reyes");
  t.same("a passkey's answer made for the first address's page is refused at the second (the page's origin is held to where it is)",
    (await wrongPage.signIn(key, { origin: MAIN })).status !== 200, true);
  const link = makeLink({ who: ada.user.id, origin: MAIN, hours: 1 });   // its token, used at the second address
  server.sql(link.sql);
  const byLink = new Person(WWW, "Ada on another phone");
  const used = await byLink.post("/api/auth/link", { token: link.url.split("/").pop() });
  t.same("the one-use link signs in there", [used.status, (await byLink.me())?.id], [200, ada.user.id]);

  t.part("3. Writes");
  const madeTrip = await ada.post("/api/trips", { name: "Coast week", default_tz: "UTC" });
  t.same("a page there makes a trip", madeTrip.status, 201);
  const trip = madeTrip.json?.trip?.id;
  const crossIn = await ada.call("PATCH", `/api/trips/${trip}`, { name: "Crossed" }, { origin: MAIN });
  t.same("a write sent there by the other address's page is refused as from another site", [crossIn.status, crossIn.json?.error], [403, "cross site"]);
  const crossOut = await atMain.call("PATCH", `/api/trips/${trip}`, { name: "Crossed" }, { origin: WWW });
  t.same("  and the other way round", [crossOut.status, crossOut.json?.error], [403, "cross site"]);
  const elsewhere = await ada.call("PATCH", `/api/trips/${trip}`, { name: "Crossed" }, { origin: "https://elsewhere.example" });
  t.same("  and from another site altogether", elsewhere.status, 403);
  const atLoopback = new Person(`http://127.0.0.1:${port}`, "Ben Okafor");
  const loop = await atLoopback.call("POST", "/api/auth/register/options", { name: "Ben Okafor" }, { origin: MAIN });
  t.same("a server reached at an address that isn't the site's still takes the first address's pages (as before)", loop.status, 200);
  t.same("the trip reads as written, from both addresses", [(await ada.get(`/api/trips/${trip}`)).json?.trip?.name, (await atMain.get(`/api/trips/${trip}`)).json?.trip?.name], ["Coast week", "Coast week"]);

  t.part("4. The live socket");
  const cookieOf = (p) => p.jar.header();
  t.same("opens there for a page there", await upgrade(`www.localhost:${port}`, `/api/trips/${trip}/live`, { Origin: WWW, Cookie: cookieOf(ada) }), 101);
  t.same("not there for the other address's page", await upgrade(`www.localhost:${port}`, `/api/trips/${trip}/live`, { Origin: MAIN, Cookie: cookieOf(ada) }) !== 101, true);
  t.same("  nor at the first for the second's page", await upgrade(`localhost:${port}`, `/api/trips/${trip}/live`, { Origin: WWW, Cookie: cookieOf(atMain) }) !== 101, true);

  t.part("5. Google and GitHub");
  for (const provider of ["google", "github"]) {
    const startAt = await anon.call("POST", `/login/${provider}`, { next: "/trips", intent: "signin" }, { form: true });
    t.same(`${provider}, started there: to the first address's sign-in page, saying why, nothing kept`,
      [startAt.status, startAt.location, startAt.cookies.length], [303, `${MAIN}/login?error=elsewhere&with=${provider}&next=%2Ftrips`, 0]);
  }

  t.part("6. An AI app given the second address");
  const told = [];
  for (const [method, path] of [["POST", "/mcp"], ["GET", "/.well-known/oauth-protected-resource"], ["GET", "/.well-known/oauth-protected-resource/mcp"],
    ["GET", "/.well-known/oauth-authorization-server"], ["GET", "/authorize?response_type=code&client_id=x"], ["POST", "/token"], ["POST", "/register"]]) {
    const r = await anon.call(method, path, method === "POST" ? {} : null, { origin: null });
    told.push([path.replace(/\?.*$/, ""), r.status, r.json?.reason]);
  }
  const words = `This site's AI connection is at ${MAIN}/mcp: give your app that address.`;
  t.same("each is answered 421 with the address to use, in words", told, told.map(([p]) => [p, 421, words]));
  const mainMcp = await new Person(MAIN, "an app").call("POST", "/mcp", {}, { origin: null });
  const mainMeta = await new Person(MAIN, "an app").get("/.well-known/oauth-protected-resource/mcp");
  t.same("at the first address nothing changed (401 asking for a token; its resource is the first's)", [mainMcp.status, mainMeta.status, mainMeta.json?.resource], [401, 200, `${MAIN}/mcp`]);

  t.part("7. What the server prints for someone else");
  const up = await ada.post(`/api/trips/${trip}/pictures/cover/upload-link`, { license: "own" });
  t.ok("a picture's upload link, asked for there, is at the first address", up.status === 201 && String(up.json?.url).startsWith(`${MAIN}/pictures/upload/`), JSON.stringify([up.status, up.json?.url?.slice(0, 40)]));

  t.part("8. The app's pages");
  for (const path of ["/", "/login", "/account", "/trips", `/trips/${trip}`, "/join/abc"]) {
    const page = await (path.startsWith("/trips/") ? ada : anon).get(path, { page: true });   // a trip's page, as one of its people
    const first = page.text.match(/<script\b[^>]*>/)?.[0] ?? "";
    t.ok(`${path}: served there, public/js/www.js its first script`, page.status === 200 && first === '<script src="/js/www.js">', `${page.status} ${first}`);
  }
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await server?.stop();
}
process.exit(code);

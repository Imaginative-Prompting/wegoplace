#!/usr/bin/env node
// Is src/routes.js still sound?
//
// The table is written by hand and its order is part of its behavior, so this holds it to
// five things:
//
//   1. the gate          src/index.js puts the gate first in every request's chain.
//   2. the rows          Every row of the table is listed below with the handler that answers
//                        it, and every row listed is in the table. A row added to the table
//                        without being added here fails: adding a route is done twice, on
//                        purpose.
//   3. the trip's rows   Every row under /api/trips/:trip is wrapped by inTrip()
//                        (src/trips/access.js), the one place that checks the caller is on the
//                        trip in the address, and no other row is.
//   4. the order         Every row answers its own path: no row above it takes the request first.
//   5. the proof         Every row is reached by at least one step of the parity recording, so
//                        `npm run check:parity` has something to say about each.
//
// And 6: the addresses from before a trip had an id stay gone, and the map's old /tiles/<key> row
// stays only while the app reads an archive there.
//
// Usage: node checks/parity/routes-check.mjs      exit 0 = all hold, 1 = something differs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

// Every row, as "METHOD path": "file:export" under src/. For a row of a trip the export is the
// handler inside the wrapper.
const ROWS = {
  // Accounts.
  "POST /api/auth/register/options": "accounts/passkeys.js:registerOptions",
  "POST /api/auth/register/verify": "accounts/passkeys.js:registerVerify",
  "POST /api/auth/login/options": "accounts/passkeys.js:loginOptions",
  "POST /api/auth/login/verify": "accounts/passkeys.js:loginVerify",
  "POST /api/auth/passkeys/options": "accounts/passkeys.js:passkeysOptions",
  "POST /api/auth/passkeys/verify": "accounts/passkeys.js:passkeysVerify",
  "POST /api/auth/pending/create": "accounts/providers.js:pendingCreate",
  "POST /api/auth/pending/attach": "accounts/providers.js:pendingAttach",
  "GET /api/auth/pending": "accounts/providers.js:pendingView",
  "POST /api/auth/recover/confirm": "accounts/email.js:recoverConfirm",
  "POST /api/auth/recover": "accounts/email.js:recoverStart",
  "POST /api/auth/link": "accounts/link.js:useLink",
  "POST /api/auth/logout/all": "accounts/account.js:logoutAll",
  "POST /api/auth/logout": "accounts/account.js:logout",
  "GET /api/auth/config": "accounts/account.js:config",
  "DELETE /api/auth/ways/passkey/:id": "accounts/account.js:removePasskey",
  "DELETE /api/auth/ways/:provider/:subject": "accounts/account.js:removeIdentity",
  "GET /api/auth/ways": "accounts/account.js:ways",
  "POST /api/account/email/confirm": "accounts/email.js:emailConfirm",
  "GET /api/account/email": "accounts/email.js:emailGet",
  "POST /api/account/email": "accounts/email.js:emailAdd",
  "DELETE /api/account/email": "accounts/email.js:emailRemove",
  "GET /api/account/storage": "trips/storage.js:getAccountStorage",
  "GET /api/account/export": "accounts/export.js:getExport",
  "GET /api/account/plan": "billing/routes.js:getPlan",
  "POST /api/account/plan/checkout": "billing/routes.js:postCheckout",
  "POST /api/account/plan/portal": "billing/routes.js:postPortal",
  "POST /api/billing/stripe": "billing/routes.js:stripeWebhook",
  "GET /api/account/apps": "accounts/apps.js:listApps",
  "DELETE /api/account/apps/:id": "accounts/apps.js:disconnectApp",
  "POST /api/errors": "errors.js:postError",
  "GET /admin/errors": "admin/errors.js:page",
  "GET /api/admin/errors": "admin/errors.js:list",
  "POST /api/admin/errors/clear": "admin/errors.js:clear",
  "POST /api/bug-reports": "bug-reports.js:postBugReport",
  "GET /api/account/bug-reports/:id/screenshot": "bug-reports.js:ownScreenshot",
  "GET /api/admin/bug-reports/:id": "bug-reports.js:adminOne",
  "GET /api/admin/bug-reports": "bug-reports.js:adminList",
  "GET /api/account/push": "push/routes.js:getPush",
  "PUT /api/account/push": "push/routes.js:putPush",
  "DELETE /api/account/push": "push/routes.js:deletePush",
  "GET /authorize": "mcp/oauth.js:getAuthorize",
  "POST /authorize": "mcp/oauth.js:postAuthorize",
  "GET /api/me": "api/me.js:onRequestGet",
  "PATCH /api/me": "api/me.js:onRequestPatch",
  "DELETE /api/me": "accounts/account.js:removeAccount",
  "PUT /api/me/avatar": "accounts/avatar.js:putAvatar",
  "DELETE /api/me/avatar": "accounts/avatar.js:deleteAvatar",
  "GET /api/avatars/:hash": "accounts/avatar.js:getAvatar",
  "GET /login/:provider/callback": "accounts/providers.js:callback",
  "POST /login/:provider": "accounts/providers.js:start",
  "GET /login/:provider": "accounts/providers.js:startByGet",
  // Exchange rates: the site's, not a trip's.
  "POST /api/fx/refresh": "api/fx.js:refreshFx",
  "GET /api/fx": "api/fx.js:onRequestGet",
  "* /api/fx": "api/fx.js:onRequest",
  // Trips, and joining one.
  "GET /api/trips": "trips/trips.js:listTrips",
  "POST /api/trips": "trips/trips.js:createTrip",
  "GET /api/join/:code": "trips/links.js:viewJoin",
  "POST /api/join/:code": "trips/links.js:join",
  // One trip.
  "GET /api/trips/:trip/rev": "trips/trips.js:tripRev",
  "GET /api/trips/:trip/live": "trips/live.js:openLive",
  "POST /api/trips/:trip/tiles/cut": "map/routes.js:cutAgain",
  "POST /api/trips/:trip/tiles/plan": "map/routes.js:planMap",
  "POST /api/trips/:trip/tiles/use": "map/routes.js:useUpload",
  "GET /api/trips/:trip/members": "trips/members.js:getMembers",
  "GET /api/trips/:trip/people": "trips/members.js:getPeople",
  "PUT /api/trips/:trip/pictures/cover": "trips/pictures.js:putCover",
  "DELETE /api/trips/:trip/pictures/cover": "trips/pictures.js:deleteCover",
  "POST /api/trips/:trip/pictures/cover/from-url": "trips/pictures.js:fromUrlCover",
  "POST /api/trips/:trip/pictures/cover/upload-link": "trips/pictures.js:makeCoverLink",
  "PUT /api/trips/:trip/pictures/:kind/:id": "trips/pictures.js:putTargetPicture",
  "DELETE /api/trips/:trip/pictures/:kind/:id": "trips/pictures.js:deleteTargetPicture",
  "POST /api/trips/:trip/pictures/:kind/:id/from-url": "trips/pictures.js:fromUrlTarget",
  "POST /api/trips/:trip/pictures/:kind/:id/upload-link": "trips/pictures.js:makeTargetLink",
  "DELETE /api/trips/:trip/members/:user": "trips/members.js:removeMember",
  "POST /api/trips/:trip/members/:user/rejoin": "accounts/guests.js:makeRejoinLink",
  "POST /api/trips/:trip/host/accept": "trips/members.js:acceptHost",
  "POST /api/trips/:trip/host/decline": "trips/members.js:declineHost",
  "POST /api/trips/:trip/host": "trips/members.js:offerHost",
  "DELETE /api/trips/:trip/host": "trips/members.js:withdrawHost",
  "* /api/trips/:trip/tiles": "tiles.js:tripTiles",
  "GET /api/trips/:trip/links": "trips/links.js:listLinks",
  "POST /api/trips/:trip/links": "trips/links.js:createLink",
  "DELETE /api/trips/:trip/links/:id": "trips/links.js:revokeLink",
  "GET /api/trips/:trip/changes": "trips/changes.js:getChanges",
  "DELETE /api/trips/:trip/changes": "trips/changes.js:deleteChanges",
  "POST /api/trips/:trip/changes/:id/undo": "trips/changes.js:postUndo",
  "GET /api/trips/:trip/areas": "trips/areas.js:getAreas",
  "PUT /api/trips/:trip/areas": "trips/areas.js:putAreas",
  "DELETE /api/trips/:trip/areas": "trips/areas.js:deleteAreas",
  "DELETE /api/trips/:trip/areas/:id": "trips/areas.js:deleteAreas",
  "PUT /api/trips/:trip/places": "api/places.js:putPlaces",
  "DELETE /api/trips/:trip/references/:id": "api/references.js:deleteReference",
  "PATCH /api/trips/:trip/references/:id": "api/references.js:patchReference",
  "GET /api/trips/:trip/references": "api/references.js:onRequestGet",
  "POST /api/trips/:trip/references": "api/references.js:postReference",
  "PUT /api/trips/:trip/references": "api/references.js:putReferences",
  "DELETE /api/trips/:trip/references": "api/references.js:deleteReferences",
  "DELETE /api/trips/:trip/places": "api/places.js:deletePlaces",
  "DELETE /api/trips/:trip/places/:id": "api/places.js:deletePlaces",
  "PUT /api/trips/:trip/packing/lists": "api/packing/lists.js:putLists",
  "DELETE /api/trips/:trip/packing/lists/:key": "api/packing/lists.js:deleteList",
  "PUT /api/trips/:trip/packing/starters": "api/packing/starters.js:putStarters",
  "PATCH /api/trips/:trip/packing/starters": "api/packing/starters.js:patchStarters",
  "PUT /api/trips/:trip/packing/ticks": "api/packing.js:putTick",
  "PUT /api/trips/:trip/packing/items": "api/packing.js:putItems",
  "DELETE /api/trips/:trip/events/:id": "api/events.js:deleteEvent",
  "PATCH /api/trips/:trip/events/:id": "api/events.js:patchEvent",
  "DELETE /api/trips/:trip/packing/:id": "api/packing.js:onRequestDelete",
  "PATCH /api/trips/:trip/packing/:id": "api/packing.js:onRequestPatch",
  "DELETE /api/trips/:trip/purchases/:id": "api/purchases.js:deletePurchase",
  "PATCH /api/trips/:trip/purchases/:id": "api/purchases.js:patchPurchase",
  "* /api/trips/:trip/collage/:path*": "api/collage.js:onRequest",
  "* /api/trips/:trip/media/:path*": "api/media.js:onRequest",
  "* /api/trips/:trip/memories/:path*": "api/memories.js:onRequest",
  "GET /api/trips/:trip/events": "api/events.js:onRequestGet",
  "POST /api/trips/:trip/events": "api/events.js:onRequestPost",
  "PUT /api/trips/:trip/events": "api/events.js:putEvents",
  "DELETE /api/trips/:trip/events": "api/events.js:deleteEvents",
  "GET /api/trips/:trip/messages": "api/messages.js:listMessages",
  "POST /api/trips/:trip/messages": "api/messages.js:postMessage",
  "GET /api/trips/:trip/assistant": "assistant/talk.js:getAssistant",
  "PUT /api/trips/:trip/assistant/off": "assistant/talk.js:putOff",
  "POST /api/trips/:trip/assistant/conversations": "assistant/talk.js:postConversation",
  "GET /api/trips/:trip/assistant/conversations/:id": "assistant/talk.js:getConversation",
  "DELETE /api/trips/:trip/assistant/conversations/:id": "assistant/talk.js:deleteConversation",
  "POST /api/trips/:trip/assistant/conversations/:id/ask": "assistant/talk.js:postAsk",
  "POST /api/trips/:trip/assistant/conversations/:id/share": "assistant/talk.js:postShare",
  "POST /api/trips/:trip/assistant/conversations/:id/files": "assistant/files.js:postFile",
  "GET /api/trips/:trip/assistant/conversations/:id/files": "assistant/files.js:getFiles",
  "GET /api/trips/:trip/assistant/conversations/:id/files/:file": "assistant/files.js:getFile",
  "DELETE /api/trips/:trip/assistant/conversations/:id/files/:file": "assistant/files.js:deleteFile",
  "PATCH /api/trips/:trip/messages/:id": "api/messages.js:patchMessage",
  "DELETE /api/trips/:trip/messages/:id": "api/messages.js:deleteMessage",
  "PUT /api/trips/:trip/chat/mute": "api/messages.js:putMute",
  "DELETE /api/trips/:trip/packing": "api/packing.js:onRequestDelete",
  "GET /api/trips/:trip/packing": "api/packing.js:onRequestGet",
  "PATCH /api/trips/:trip/packing": "api/packing.js:onRequestPatch",
  "POST /api/trips/:trip/packing": "api/packing.js:onRequestPost",
  "GET /api/trips/:trip/places": "api/places.js:onRequestGet",
  "GET /api/trips/:trip/purchases": "api/purchases.js:onRequestGet",
  "POST /api/trips/:trip/purchases": "api/purchases.js:onRequestPost",
  "GET /api/trips/:trip": "api/trip.js:onRequestGet",
  "PATCH /api/trips/:trip": "trips/trips.js:patchTrip",
  "DELETE /api/trips/:trip": "trips/trips.js:deleteTrip",
  // Not under /api.
  "GET /s/:id*": "share-page.js:onRequestGet",
  "* /media/:path*": "media-files.js:onRequest",
  "* /tiles/fonts/:path*": "tiles.js:fonts",
  "PUT /pictures/upload/:token": "trips/pictures.js:uploadByLink",
};
// Rows that serve a page from public/ under another address: made by pageAt(), so there is no
// export to name. Checked by asking each for the page.
const PAGES = { "GET /login/new": "/login", "GET /login/link/:token": "/login", "GET /join/:code": "/join", "GET /trips/:id": "/trip-people", "GET /t/:id": "/" };

const problems = [];
const say = (ok, text) => { console.log(`${ok ? "  ok  " : "  FAIL"}  ${text}`); if (!ok) problems.push(text); };
const loaded = new Map();
async function exported(spec) {
  const [file, name] = spec.split(":");
  if (!loaded.has(file)) loaded.set(file, await import(pathToFileURL(path.join(ROOT, "src", file))));
  return loaded.get(file)[name];
}

const { ROUTES, TRIP, findRoute } = await import(pathToFileURL(path.join(ROOT, "src/routes.js")));
const keyOf = ([method, p]) => `${method} ${p}`;
const keys = ROUTES.map(keyOf);

// 1. The gate.
console.log("1. the gate");
const index = fs.readFileSync(path.join(ROOT, "src/index.js"), "utf8");
say(/import \{ onRequest as gate \} from "\.\/gate\.js";/.test(index) && /const chain = \[\{ handler: gate, params: \{\} \}\];/.test(index),
  "src/index.js puts the gate first in every request's chain");

// 2. The rows.
console.log("2. the rows");
const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
say(twice.length === 0, twice.length ? `the table has a row twice: ${twice.join(", ")}` : "no row is in the table twice");
const unlisted = keys.filter((k) => !ROWS[k] && !PAGES[k]);
const missing = [...Object.keys(ROWS), ...Object.keys(PAGES)].filter((k) => !keys.includes(k));
say(unlisted.length === 0, unlisted.length ? `in the table but not listed in this check: ${unlisted.join(", ")}` : `each of the table's ${keys.length} rows is listed here`);
say(missing.length === 0, missing.length ? `listed here but not in the table: ${missing.join(", ")}` : "and each row listed here is in the table");
let wrong = 0;
for (const [key, spec] of Object.entries(ROWS)) {
  const at = keys.indexOf(key);
  if (at < 0) continue;
  let handler;
  try { handler = await exported(spec); } catch (e) { wrong++; say(false, `${key}: src/${spec.split(":")[0]} doesn't load: ${e.message}`); continue; }
  const inTable = ROUTES[at][2];
  let h = inTable;
  while (h.inner) h = h.inner;   // inTrip(), then told() (src/api/ignored.js), around the handler
  if (typeof handler !== "function" || h !== handler) { wrong++; say(false, `${key}: its handler isn't ${spec}`); }
}
for (const [key, page] of Object.entries(PAGES)) {
  const at = keys.indexOf(key);
  if (at < 0) continue;
  // pageAt(page) answers by asking the static files for `page`.
  let asked = null;
  await ROUTES[at][2]({ request: new Request("http://localhost/x/"), env: { ASSETS: { fetch: (req) => { asked = new URL(req.url ?? req).pathname; return new Response("page"); } } } });
  if (asked !== page) { wrong++; say(false, `${key}: it serves ${asked}, not the page at ${page}`); }
}
// The app at a trip's address: without its last slash it is sent to the slash form, query kept.
{
  const at = keys.indexOf("GET /t/:id");
  const bounced = at < 0 ? null : await ROUTES[at][2]({ request: new Request("http://localhost/t/abc?x=1"), env: { ASSETS: { fetch: () => new Response("page") } } });
  if (!bounced || bounced.status !== 308 || bounced.headers.get("Location") !== "/t/abc/?x=1") { wrong++; say(false, `GET /t/:id: /t/abc?x=1 answers ${bounced?.status} ${bounced?.headers.get("Location")}, not 308 to /t/abc/?x=1`); }
}
say(wrong === 0, "each has the handler named for it");

// 3. A trip's rows are wrapped, and only they.
console.log("3. the trip's rows");
const ofTrip = ROUTES.filter(([, p]) => p === TRIP || p.startsWith(`${TRIP}/`));
const bare = ofTrip.filter(([, , h]) => h.inTrip !== true || typeof h.inner !== "function").map(keyOf);
say(ofTrip.length > 0 && bare.length === 0, bare.length ? `rows under ${TRIP} that don't check the caller is on the trip: ${bare.join(", ")}`
  : `each of the ${ofTrip.length} rows under ${TRIP} is wrapped by inTrip(), which checks the caller is on that trip`);
const strays = ROUTES.filter(([, p, h]) => h.inTrip === true && !(p === TRIP || p.startsWith(`${TRIP}/`))).map(keyOf);
say(strays.length === 0, strays.length ? `rows wrapped by inTrip() with no trip in their address: ${strays.join(", ")}` : "and no row outside it is");
// The wrapper itself: someone not on the trip never reaches the handler, and is told what a
// trip that doesn't exist is told.
{
  const { inTrip, noSuchTrip } = await import(pathToFileURL(path.join(ROOT, "src/trips/access.js")));
  const noTrip = await noSuchTrip().text();
  let reached = 0;
  const wrapped = inTrip(() => { reached++; return new Response("in"); });
  const db = (row) => ({ prepare: () => ({ bind: () => ({ first: async () => row }) }) });
  const ask = async (row) => {
    const res = await wrapped({ request: new Request("http://localhost/api/trips/t1"), env: { DB: db(row) }, params: { trip: "t1" }, data: { user: { id: "u1" } } });
    return [res.status, await res.text()];
  };
  const none = await ask(null);
  say(none[0] === 404 && none[1] === noTrip && JSON.parse(none[1]).error === "no such trip" && reached === 0, `with no row for this caller on this trip, the wrapper answers 404 "no such trip" (noSuchTrip's answer, word for word) and the handler is not run (${none[0]} ${none[1]})`);
}

// 4. Every row answers its own path.
console.log("4. the order");
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
// A request that fits the row: each `:name` part becomes one made-up segment.
const sample = (p) => p.replace(/:\w+\*?/g, "made-up-part");
const taken = [];
ROUTES.forEach(([method, p], i) => {
  const first = (method === "*" ? METHODS : [method]).map((m) => findRoute(m, sample(p)).index);
  // An any-method row under a row for one method of the same path is the usual shape (GET
  // /api/fx above * /api/fx); a row is lost only when every method it answers goes elsewhere.
  if (first.every((at) => at < i)) taken.push(`${method} ${p}`);
});
say(taken.length === 0, taken.length ? `rows that a row above them answers first: ${taken.join(", ")}` : "every row is the first to fit its own path");
const escaped = ROUTES.filter(([, p]) => /[.+?^${}()|[\]\\]/.test(p)).map(keyOf);
say(escaped.length === 0, escaped.length ? `paths with a character the matcher reads as a pattern: ${escaped.join(", ")}` : "no path has a character the matcher would read as a pattern");

// 5. The parity recording uses every row.
console.log("5. the recording against the table");
const golden = JSON.parse(fs.readFileSync(path.join(HERE, "golden.json"), "utf8"));
const used = new Array(ROUTES.length).fill(0);
for (const s of golden.steps) {
  // A recorded path has what the server minted replaced by <its-name>; one segment either way.
  const hit = findRoute(s.request.method, s.request.path.split("?")[0].replace(/<[^>/]+>/g, "made-up-part"));
  if (hit) used[hit.index]++;
}
const unused = keys.filter((k, i) => !used[i]);
say(unused.length === 0, unused.length ? `no step of the recording reaches: ${unused.join(", ")}`
  : `each of the ${keys.length} rows is reached by at least one of the recording's ${golden.steps.length} steps (the least used, ${Math.min(...used)} times)`);

// 6. The addresses from before a trip had an id.
// src/old-addresses.js answered /api/trip, /api/events and the rest for an account on exactly
// one trip, until the app's own code addressed a trip by id. It went when the app did (14 Nov);
// this holds that it stays gone. The map's archives at /tiles/<key> stay while the app still
// reads one there; once nothing under public/ does, this fails until that row is gone too
// (the fonts the map draws its words with, /tiles/fonts/*, are not an archive and stay).
console.log("6. the old addresses");
const temp = path.join(ROOT, "src/old-addresses.js");
const there = fs.existsSync(temp);
const usesIt = /old-addresses\.js/.test(index);
const appFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|html)$/.test(entry.name)) appFiles.push(full);
  }
})(path.join(ROOT, "public"));
say(!there && !usesIt, there || usesIt ? "src/old-addresses.js is back (or src/index.js asks for it): the app addresses a trip by its id, and nothing may answer the old addresses" : "src/old-addresses.js is gone, and src/index.js doesn't ask for it");
// The map's address from before archives belonged to trips: it goes once nothing reads an archive there.
const oldTiles = ROUTES.some(([, p]) => p === "/tiles/:path*");
const readsTiles = appFiles.map((file) => path.relative(ROOT, file))
  .filter((file) => /["'`]\/tiles\/(?!fonts\/)[^"'`]+\.pmtiles["'`]/.test(fs.readFileSync(path.join(ROOT, file), "utf8")));
if (readsTiles.length) say(oldTiles, `/tiles/<key>, the map's old address, is still in the table: the app reads an archive there (${readsTiles.join(", ")})`);
else say(!oldTiles, oldTiles ? "nothing under public/ reads an archive at /tiles/<key> now: take its row out of the table, keeping the fonts' (/tiles/fonts/*)" : "/tiles/<key>, the map's old address, is gone, and nothing under public/ reads an archive there");

// The old site's write addresses (src/old-writes.js) answer 503 for good, before any route: a
// route of the new server that takes one of them for a write would never be reached, and the
// phone's old app would be told to keep a change the new app can't take there.
const { OLD_WRITES, isOldWrite } = await import(pathToFileURL(path.join(ROOT, "src/old-writes.js")));
const takesOld = ROUTES.filter(([method, p]) => method !== "GET" && (method === "*" ? ["POST", "PUT", "PATCH", "DELETE"] : [method]).some((m) => isOldWrite(m, sample(p)))).map(keyOf);
say(takesOld.length === 0, takesOld.length ? `a route takes an old site's write address, which src/old-writes.js answers 503 before it: ${takesOld.join(", ")}` : `no route takes any of the old site's ${OLD_WRITES.length} write addresses`);
const reachable = OLD_WRITES.filter(([m, p]) => findRoute(m, sample(p)) !== null).map(([m, p]) => `${m} ${p}`);
say(reachable.length === 0, reachable.length ? `the table would answer an old write address itself: ${reachable.join(", ")}` : "and the table answers none of them itself");

// No silent yes (src/api/ignored.js): every write under a trip that writes its rows says in its
// answer what it didn't take. A new one fails here until it is told() what it takes, or is named
// below as a write that isn't the trip's rows (an action, a file).
const NOT_ROWS = new Set([
  "POST /api/trips/:trip/host/accept", "POST /api/trips/:trip/host/decline", "POST /api/trips/:trip/host",
  "POST /api/trips/:trip/tiles/cut", "POST /api/trips/:trip/tiles/use", "POST /api/trips/:trip/links",
  // A sign-in link for a guest (src/accounts/guests.js): an action, no body.
  "POST /api/trips/:trip/members/:user/rejoin",
  // Reads: what the map would be, written nowhere.
  "POST /api/trips/:trip/tiles/plan",
  "POST /api/trips/:trip/changes/:id/undo", "PUT /api/trips/:trip/chat/mute",
  // Pictures: a picture's PUT is the file itself; from-url and upload-link name a source. Not among
  // the writes of a trip's own rows (events, places, notes, purchases, areas, lists, starters).
  "PUT /api/trips/:trip/pictures/cover", "POST /api/trips/:trip/pictures/cover/from-url", "POST /api/trips/:trip/pictures/cover/upload-link",
  "PUT /api/trips/:trip/pictures/:kind/:id", "POST /api/trips/:trip/pictures/:kind/:id/from-url", "POST /api/trips/:trip/pictures/:kind/:id/upload-link",
  // A document given the assistant: its body is the file itself (src/assistant/files.js), not rows of the trip's.
  "POST /api/trips/:trip/assistant/conversations/:id/files",
]);
const untold = ROUTES.filter(([m, p, h]) => ["POST", "PUT", "PATCH"].includes(m) && (p === TRIP || p.startsWith(`${TRIP}/`)) && !NOT_ROWS.has(`${m} ${p}`) && (() => { for (let x = h; x; x = x.inner) if (x.told) return false; return true; })()).map(([m, p]) => `${m} ${p}`);
say(untold.length === 0, untold.length ? `a write of a trip's rows doesn't say what it ignores (wrap it in told(), src/api/ignored.js): ${untold.join(", ")}` : "every write of a trip's rows says what it ignores");

console.log(problems.length ? `\nroutes: ${problems.length} problem${problems.length === 1 ? "" : "s"}` : `\nroutes: the table's ${ROUTES.length} rows are sound`);
process.exit(problems.length ? 1 : 0);

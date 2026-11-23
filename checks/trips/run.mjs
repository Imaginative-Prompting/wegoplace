// The trips check: making a trip, the people on it (joining by a link, leaving, being removed,
// handing it over), what each of them may reach, the trip's rev, payments, addresses that
// aren't there, and deleting an account that hosts. It starts its own server on its own empty
// database and stops it again. Plain HTTP: every person is their own cookie jar.
//
//   node checks/trips/run.mjs                 every part, in order
//   node checks/trips/run.mjs making joining  only the parts named (a part needs the ones before it)
//   --port <n> (a free one when not named)   --keep (leave the server's folder for reading afterwards)
//
// See README.md beside this file.

import fs from "node:fs";
import path from "node:path";
import {
  LINK_DAYS_DEFAULT, LINK_DAYS_MAX, LINK_USES_DEFAULT, LINK_USES_MAX, LINKS_LIVE_MAX,
  TRIP_MEMBERS_MAX, TRIP_NAME_MAX, TRIPS_HOSTED_MAX,
} from "../../public/js/shared/limits.js";
import { CheckError, FIXED_RATES, ROOT, startServer, freePort } from "../lib/server.mjs";
import { providerUrl } from "../../src/api/fx.js";
import { HOST_ONLY, noSuchTrip } from "../../src/trips/access.js";
import { noSuchLink } from "../../src/trips/links.js";
import { goesLines } from "../../public/js/trip-words.js";
import { currencyOfRegion, guessHomeCurrency, knownRegions, regionOfZone } from "../../public/js/shared/home-currency.js";
import { CURRENCY_CODES } from "../../public/js/money.js";
import { Person, Report } from "../lib/person.mjs";
import { carries } from "./carries.mjs";
import { PAUSES, pictures } from "./pictures.mjs";
import { storage, LIMIT } from "./storage.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const keep = argv.includes("--keep") ? (argv.splice(argv.indexOf("--keep"), 1), true) : false;

const report = new Report("trips");
const t = report;
// Events start on a day of their trip: these are inside the Lisbon trip's dates (2 to 9 April
// 2027, set in the `whole` part) and the Porto trip's (1 to 4 May 2027).
const T0 = 1806710400;           // 3 Apr 2027 00:00 UTC, in seconds
const TP = T0 + 29 * 86400;      // 2 May 2027
// The answers for no such trip and no such link, word for word, as the server's own code makes them.
const NO_TRIP = [404, await noSuchTrip().text()];
const NO_LINK = [404, await noSuchLink().text()];
const said = (res) => [res.status, res.text];
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

let server;
/** People by name. Everyone here is made up. */
const who = {};
/** What the parts hand on to each other. */
const made = {};

async function person(name) {
  const p = new Person(server.origin, name);
  const res = await p.signUp();
  if (res.status !== 200) throw new CheckError(`couldn't make ${name}: ${res.status} ${res.text}`);
  return p;
}
const patch = (p, at, body) => p.call("PATCH", at, body);
const del = (p, at, body = null) => p.call("DELETE", at, body);
const put = (p, at, body) => p.call("PUT", at, body);
const revOf = async (p, tripId) => (await p.get(`/api/trips/${tripId}/rev`)).json?.rev;
async function newTrip(p, body) {
  const res = await p.post("/api/trips", { name: "A trip", default_tz: "Europe/Lisbon", ...body });
  if (res.status !== 201) throw new CheckError(`couldn't make a trip: ${res.status} ${res.text}`);
  return res.json.trip;
}
async function newLink(p, tripId, body = {}) {
  const res = await p.post(`/api/trips/${tripId}/links`, body);
  if (res.status !== 201) throw new CheckError(`couldn't make a link: ${res.status} ${res.text}`);
  return res.json.link;
}
/** Puts someone on a trip the way the app does: a link from a member, then joining by it. */
async function bring(member, tripId, joiner) {
  const link = await newLink(member, tripId, { uses: 1 });
  const res = await joiner.post(`/api/join/${link.code}`);
  if (res.status !== 200 || !res.json.joined) throw new CheckError(`couldn't join: ${res.status} ${res.text}`);
}

// ═══ Making a trip ═══════════════════════════════════════════════════════════════════════════
async function making() {
  t.part("Making a trip");
  const ana = who.ana = await person("Ana Check");
  const anon = new Person(server.origin, "Nobody");

  const none = await ana.get("/api/trips");
  t.same("a new account is on no trip", [none.status, none.json], [200, { trips: [] }]);
  const out = await anon.get("/api/trips");
  t.same("signed out, the list of trips is a 401 in JSON", [out.status, out.json], [401, { error: "unauthorized" }]);
  t.same("signed out, nobody makes a trip", (await anon.post("/api/trips", { name: "x", default_tz: "UTC" })).status, 401);

  const base = { name: "Lisbon in spring", default_tz: "Europe/Lisbon" };
  const refused = async (what, body, error) => {
    const res = await ana.post("/api/trips", body);
    t.same(`refused: ${what}`, [res.status, res.json?.error], [400, error]);
  };
  await refused("no name", { ...base, name: "  " }, "bad name");
  await refused(`a name of ${TRIP_NAME_MAX + 1} characters`, { ...base, name: "x".repeat(TRIP_NAME_MAX + 1) }, "bad name");
  await refused("no time zone", { name: "x" }, "bad default_tz");
  await refused("a time zone that isn't one", { ...base, default_tz: "Lisbon" }, "bad default_tz");
  await refused("one date without the other", { ...base, starts_on: "2027-04-02" }, "bad dates");
  await refused("an end before the start", { ...base, starts_on: "2027-04-09", ends_on: "2027-04-02" }, "bad dates");
  await refused("a day that doesn't exist", { ...base, starts_on: "2027-02-30", ends_on: "2027-03-02" }, "bad dates");
  await refused("a currency that isn't a code", { ...base, currencies: ["euros"] }, "bad currencies");
  await refused("an id that can't sit in an address", { ...base, id: "bad id!" }, "bad id");
  t.same("nothing was made by any of those", (await ana.get("/api/trips")).json.trips.length, 0);

  const first = await ana.post("/api/trips", { ...base, name: "  Lisbon   in spring " });
  const trip = first.json?.trip;
  t.same("a trip is made with a name and a time zone", first.status, 201);
  t.same("its name is kept tidy", trip?.name, "Lisbon in spring");
  t.same("dates that aren't known yet are null", [trip?.starts_on, trip?.ends_on], [null, null]);
  t.same("its maker is its host", trip?.host_id, ana.user.id);
  t.ok("it has an id nobody chose, a board seed and a rev", /^[0-9a-f-]{36}$/.test(trip?.id ?? "") && /^[0-9a-f]{16}$/.test(trip?.collage_seed ?? "") && trip?.rev >= 1, trip);
  t.same("the answer's rev is the trip's", first.json?.rev, trip?.rev);
  made.lisbon = trip.id;

  const list = (await ana.get("/api/trips")).json.trips;
  t.same("it is on the maker's list, as host, with one person on it", list.map((x) => [x.id, x.role, x.members]), [[trip.id, "host", 1]]);

  const dated = await ana.post("/api/trips", { id: "t-porto", name: "Porto", default_tz: "Europe/Lisbon", starts_on: "2027-05-01", ends_on: "2027-05-04", currencies: ["eur", "USD", "eur"] });
  t.same("a trip can be made with an id, dates and currencies", [dated.status, dated.json?.trip?.id, dated.json?.trip?.starts_on, dated.json?.trip?.ends_on], [201, "t-porto", "2027-05-01", "2027-05-04"]);
  t.same("a trip is these fields, the trip's own currencies and who made it among them",
    Object.keys(dated.json?.trip ?? {}).sort(),
    ["collage_seed", "collage_version", "created_at", "created_by", "currencies", "default_tz", "ends_on", "host_id", "id", "interests", "name", "rev", "starts_on", "updated_at"]);
  t.same("the answer carries the currencies it stored, in the order given, as codes, each once; and its maker",
    [dated.json?.trip?.currencies, dated.json?.trip?.created_by], [["EUR", "USD"], ana.user.id]);
  t.same("a trip made without currencies has none of its own", trip.currencies, []);
  const again = await ana.post("/api/trips", { id: "t-porto", name: "Porto", default_tz: "Europe/Lisbon" });
  t.same("the same create sent again answers with the trip it made", [again.status, again.json?.trip?.id, again.json?.trip?.starts_on], [200, "t-porto", "2027-05-01"]);
  const ben = who.ben = await person("Ben Check");
  const taken = await ben.post("/api/trips", { id: "t-porto", name: "Mine", default_tz: "UTC" });
  t.same("someone else's id is a collision", [taken.status, taken.json?.error], [409, "id already exists"]);
  t.same("and tells them nothing of the trip", Object.keys(taken.json ?? {}).sort(), ["error", "id"]);
  t.same("the dated trip comes first on the list, the undated one last", (await ana.get("/api/trips")).json.trips.map((x) => x.id), ["t-porto", trip.id]);
  t.same("and the list says each trip's main currency (the first of its own)", (await ana.get("/api/trips")).json.trips.map((x) => x.currencies[0] ?? null), ["EUR", null]);
  made.porto = "t-porto";

  // The most trips one account may host.
  const hoster = who.hoster = await person("Hoster Check");
  for (let i = 0; i < TRIPS_HOSTED_MAX; i++) await newTrip(hoster, { name: `Trip ${i + 1}` });
  const over = await hoster.post("/api/trips", { name: "One too many", default_tz: "UTC" });
  t.same(`an account hosts at most ${TRIPS_HOSTED_MAX} trips`, [over.status, over.json?.error, over.json?.max], [409, "too many trips", TRIPS_HOSTED_MAX]);
  t.same("and the refused one was not made", (await hoster.get("/api/trips")).json.trips.length, TRIPS_HOSTED_MAX);
}

// ═══ The whole trip, its details and its rev ═════════════════════════════════════════════════
async function whole() {
  t.part("The whole trip, its details and its rev");
  const { ana, ben } = who;
  const at = `/api/trips/${made.lisbon}`;

  const snap = await ana.get(at);
  t.same("the trip's address answers the whole trip", [snap.status, Object.keys(snap.json ?? {}).sort()],
    [200, ["areas", "chat", "currencies", "data_rev", "events", "fx", "handover", "maps", "members", "note_colors", "packing", "packing_lists", "packing_placements", "packing_starters", "packing_ticks", "places", "purchases", "references", "rev", "storage", "tiles", "trip"]]);
  t.same("with its rev, which is the trip row's", snap.json?.rev, snap.json?.trip?.rev);
  t.same("its people are its maker, as host", snap.json?.members?.map((m) => [m.id, m.role, m.left_at, m.deleted]), [[ana.user.id, "host", null, false]]);
  t.ok("nobody is marked as running the site", !/isAdmin|is_admin/.test(snap.text));
  const rev = await ana.get(`${at}/rev`);
  t.same("the rev route answers the rev, and its two parts: data_rev (every write but the chat's) and the chat's counter", [rev.status, rev.json], [200, { rev: snap.json?.rev, data_rev: snap.json?.data_rev, seq: snap.json?.chat?.seq }]);

  // Someone who isn't on it, and a trip that doesn't exist, answer the same.
  const missing = await ben.get("/api/trips/no-such-trip-anywhere");
  t.same("a trip that doesn't exist is a 404 in JSON", said(missing), NO_TRIP);
  const ROUTES = [
    ["GET", ""], ["PATCH", ""], ["GET", "/rev"], ["GET", "/members"], ["DELETE", `/members/${ana.user.id}`], ["POST", "/host"],
    ["GET", "/links"], ["POST", "/links"], ["DELETE", "/links/x"],
    ["GET", "/areas"], ["PUT", "/areas"], ["DELETE", "/areas"], ["DELETE", "/areas/x"],
    ["GET", "/events"], ["POST", "/events"], ["PATCH", "/events/x"], ["DELETE", "/events/x"],
    ["GET", "/places"], ["PUT", "/places"], ["DELETE", "/places"], ["DELETE", "/places/x"],
    ["GET", "/packing"], ["POST", "/packing"], ["PATCH", "/packing/x"], ["DELETE", "/packing/x"],
    ["PUT", "/packing/lists"], ["DELETE", "/packing/lists/x"], ["PUT", "/packing/starters"], ["PUT", "/packing/ticks"],
    ["GET", "/purchases"], ["POST", "/purchases"], ["PATCH", "/purchases/x"], ["DELETE", "/purchases/x"],
    ["GET", "/memories"], ["POST", "/memories"], ["GET", "/memories/tags"], ["GET", "/memories/x"], ["PATCH", "/memories/x"], ["DELETE", "/memories/x"],
    ["GET", "/media/config"], ["POST", "/media/begin"], ["POST", "/media/finish"], ["POST", "/media/thumb"], ["GET", "/media/usage"], ["DELETE", "/media/object?key=x"],
    ["POST", "/collage/share"], ["GET", "/collage/shares"], ["DELETE", "/collage/share/x"],
  ];
  made.routes = ROUTES;
  const differ = [];
  for (const [method, tail] of ROUTES) {
    const res = await ben.call(method, at + tail, ["GET", "DELETE"].includes(method) ? null : {});
    if (JSON.stringify(said(res)) !== JSON.stringify(NO_TRIP)) differ.push(`${method} ${tail} -> ${res.status} ${res.text.slice(0, 80)}`);
  }
  t.ok(`someone who isn't on the trip gets that same answer from each of its ${ROUTES.length} routes`, differ.length === 0, differ.join("\n        "));
  const anon = new Person(server.origin, "Nobody");
  t.same("signed out, the trip is a 401", (await anon.get(at)).status, 401);

  // Its details: any member may change them, and each change is one step of rev.
  const before = snap.json.rev;
  const renamed = await patch(ana, at, { name: "Lisbon, April", starts_on: "2027-04-02", ends_on: "2027-04-09", currencies: ["EUR"] });
  t.same("a member changes the trip's name, dates and currencies", [renamed.status, renamed.json?.trip?.name, renamed.json?.trip?.starts_on, renamed.json?.trip?.ends_on], [200, "Lisbon, April", "2027-04-02", "2027-04-09"]);
  t.same("which takes the rev up by one", [renamed.json?.rev, renamed.json?.trip?.rev, await revOf(ana, made.lisbon)], [before + 1, before + 1, before + 1]);
  t.same("the answer carries the trip's own list as it now is", renamed.json?.trip?.currencies, ["EUR"]);
  t.same("and the whole trip's currency list starts with it", (await ana.get(at)).json.currencies, ["EUR"]);
  const oneDate = await patch(ana, at, { ends_on: "2027-04-10" });
  t.same("one date alone changes that date", [oneDate.status, oneDate.json?.trip?.starts_on, oneDate.json?.trip?.ends_on], [200, "2027-04-02", "2027-04-10"]);
  const badDate = await patch(ana, at, { ends_on: "2027-04-01" });
  t.same("an end before the start is refused", [badDate.status, badDate.json?.error], [400, "bad dates"]);
  const cleared = await patch(ana, at, { starts_on: null, ends_on: null });
  t.same("both dates can be cleared", [cleared.status, cleared.json?.trip?.starts_on, cleared.json?.trip?.ends_on], [200, null, null]);
  await patch(ana, at, { starts_on: "2027-04-02", ends_on: "2027-04-09" });
  const empty = await patch(ana, at, {});
  t.same("a change that names nothing is refused", [empty.status, empty.json?.error], [400, "nothing to patch"]);
  const hostId = await patch(ana, at, { host_id: ben.user.id });
  t.same("the host can't be changed that way", [hostId.status, (await ana.get(at)).json.trip.host_id], [400, ana.user.id]);
  const gone = await del(ana, at);
  t.same("deleting a trip needs its name typed: without it, nothing goes", [gone.status, gone.json?.error, gone.json?.need], [400, "confirm", "Lisbon, April"]);
  const asPost = await ana.post(at, {});
  t.same("a trip's address answers a method it doesn't take with a 405 that names what it does", [asPost.status, asPost.json], [405, { error: "method not allowed", allow: ["GET", "PATCH", "DELETE"] }]);
}

// ═══ Joining by a link ═══════════════════════════════════════════════════════════════════════
async function joining() {
  t.part("Joining by a link");
  const { ana, ben } = who;
  const at = `/api/trips/${made.lisbon}`;
  const anon = new Person(server.origin, "Nobody");

  const r0 = await revOf(ana, made.lisbon);
  const res = await ana.post(`${at}/links`, {});
  const link = res.json?.link;
  t.same("a member makes a link", res.status, 201);
  t.ok("it comes with its code and address, once", /^[A-Za-z0-9_-]{22}$/.test(link?.code ?? "") && link?.url === `/join/${link?.code}`, link);
  t.same(`it lasts ${LINK_DAYS_DEFAULT} days and puts ${LINK_USES_DEFAULT} people on the trip unless its maker says`, [link?.expires_at - link?.created_at, link?.max_uses, link?.uses], [LINK_DAYS_DEFAULT * 86400, LINK_USES_DEFAULT, 0]);
  t.same("making it is one step of rev", [res.json?.rev, await revOf(ana, made.lisbon)], [r0 + 1, r0 + 1]);
  const listed = await ana.get(`${at}/links`);
  t.same("the trip's links list it", listed.json?.links?.map((l) => [l.id, l.live, l.uses]), [[link.id, true, 0]]);
  t.ok("without its code", !listed.text.includes(link.code) && !("code" in (listed.json?.links?.[0] ?? {})));
  const rows = server.sql(`SELECT * FROM trip_links WHERE id = ${q(link.id)}`);
  t.ok("the database keeps a hash of the code, never the code", rows.length === 1 && /^[0-9a-f]{64}$/.test(rows[0].code_hash) && !JSON.stringify(rows).includes(link.code), rows);
  for (const [what, body, error] of [
    ["0 days", { days: 0 }, "bad days"], [`${LINK_DAYS_MAX + 1} days`, { days: LINK_DAYS_MAX + 1 }, "bad days"], ["half a day", { days: 0.5 }, "bad days"],
    ["0 uses", { uses: 0 }, "bad uses"], [`${LINK_USES_MAX + 1} uses`, { uses: LINK_USES_MAX + 1 }, "bad uses"], ["uses as text", { uses: "3" }, "bad uses"],
  ]) {
    const bad = await ana.post(`${at}/links`, body);
    t.same(`a link for ${what} is refused`, [bad.status, bad.json?.error], [400, error]);
  }

  // What the link shows, to anyone.
  const view = await anon.get(`/api/join/${link.code}`);
  t.same("anyone holding the link sees the trip's name and dates and its host's name, and nothing else",
    [view.status, view.json], [200, { trip: { name: "Lisbon, April", starts_on: "2027-04-02", ends_on: "2027-04-09" }, host: { name: "Ana Check" } }]);
  {
    // Signed out, joining takes a name and makes a guest (model §22; check:accounts' guests part): with none, it's
    // refused in words and nobody is made or put on the trip.
    const people = () => server.sql("SELECT (SELECT COUNT(*) FROM users) AS u, (SELECT COUNT(*) FROM trip_members) AS m")[0];
    const before = people();
    const r = await anon.post(`/api/join/${link.code}`);
    t.same("signed out with no name, the link puts nobody on the trip (it asks for a name)", [r.status, r.json?.error, people(), anon.signedIn], [400, "name", before, false]);
  }
  const page = await anon.get(`/join/${link.code}`, { page: true });
  t.ok("the link's page opens for someone signed out", page.status === 200 && /<html/i.test(page.text), `${page.status} ${page.location ?? ""}`);

  // Joining.
  const r1 = await revOf(ana, made.lisbon);
  const joined = await ben.post(`/api/join/${link.code}`);
  t.same("an account joins by it", [joined.status, joined.json?.joined, joined.json?.trip?.id], [200, true, made.lisbon]);
  t.ok("which takes the trip's rev up", joined.json?.rev > r1 && joined.json?.rev === await revOf(ben, made.lisbon), [r1, joined.json?.rev]);
  t.ok("their colour on notes is given in the join's own write (before anyone reads the trip)", /^#[0-9A-F]{6}$/i.test(server.sql(`SELECT note_color FROM users WHERE id = '${ben.user.id}'`)[0]?.note_color ?? ""));
  const members = (await ben.get(at)).json?.members;
  t.same("  (and reading the trip afterwards writes nothing: the rev is the join's)", await revOf(ben, made.lisbon), joined.json?.rev);
  t.same("they are on the trip, as a member, and can read it", members?.map((m) => [m.name, m.role]), [["Ana Check", "host"], ["Ben Check", "member"]]);
  t.ok("with a colour for their notes", members?.every((m) => /^#[0-9A-F]{6}$/i.test(m.note_color ?? "")), members);
  t.same("the trip is on their list", (await ben.get("/api/trips")).json.trips.map((x) => [x.id, x.role, x.members]), [[made.lisbon, "member", 2]]);
  t.same("the link has been used once", (await ana.get(`${at}/links`)).json.links[0].uses, 1);
  const twice = await ben.post(`/api/join/${link.code}`);
  t.same("joining again changes nothing", [twice.status, twice.json?.joined], [200, false]);
  t.same("and costs the link no use", (await ana.get(`${at}/links`)).json.links[0].uses, 1);
  t.same("a member who isn't the host can make a link too", (await ben.post(`${at}/links`, { uses: 1 })).status, 201);

  // A link that never existed, and every way a link ends, answer the same words.
  const cal = who.cal = await person("Cal Check");
  const dee = who.dee = await person("Dee Check");
  const never = "A".repeat(22);
  t.same("a code that never existed: reading it", said(await anon.get(`/api/join/${never}`)), NO_LINK);
  t.same("a code that never existed: joining by it", said(await dee.post(`/api/join/${never}`)), NO_LINK);
  t.same("a code of the wrong shape answers the same", said(await dee.post("/api/join/short")), NO_LINK);

  const once = await newLink(ana, made.lisbon, { uses: 1 });
  t.same("a link for one person takes one person", (await cal.post(`/api/join/${once.code}`)).json?.joined, true);
  t.same("past its use limit: reading it", said(await anon.get(`/api/join/${once.code}`)), NO_LINK);
  t.same("past its use limit: joining by it", said(await dee.post(`/api/join/${once.code}`)), NO_LINK);

  const revoked = await newLink(ana, made.lisbon);
  const notHost = await del(ben, `${at}/links/${revoked.id}`);
  t.same("only the host revokes a link", [notHost.status, notHost.json], [403, { error: "forbidden", reason: HOST_ONLY }]);
  const r2 = await revOf(ana, made.lisbon);
  const off = await del(ana, `${at}/links/${revoked.id}`);
  t.same("the host revokes it, one step of rev", [off.status, off.json], [200, { ok: true, revoked: true, rev: r2 + 1 }]);
  t.same("revoked: reading it", said(await anon.get(`/api/join/${revoked.code}`)), NO_LINK);
  t.same("revoked: joining by it", said(await dee.post(`/api/join/${revoked.code}`)), NO_LINK);
  const offAgain = await del(ana, `${at}/links/${revoked.id}`);
  t.same("revoking it again is not an error and changes nothing", [offAgain.status, offAgain.json], [200, { ok: true, revoked: false, rev: r2 + 1 }]);

  const old = await newLink(ana, made.lisbon);
  server.sql(`UPDATE trip_links SET expires_at = ${Math.floor(Date.now() / 1000) - 5} WHERE id = ${q(old.id)}`);
  t.same("expired: reading it", said(await anon.get(`/api/join/${old.code}`)), NO_LINK);
  t.same("expired: joining by it", said(await dee.post(`/api/join/${old.code}`)), NO_LINK);
  t.same("none of those put anyone on the trip", (await ana.get(at)).json.members.map((m) => m.name), ["Ana Check", "Ben Check", "Cal Check"]);
  t.same("the list says which links are still good", (await ana.get(`${at}/links`)).json.links.filter((l) => [once.id, revoked.id, old.id].includes(l.id)).map((l) => l.live), [false, false, false]);

  // The most links in use at once.
  const live = (await ana.get(`${at}/links`)).json.links.filter((l) => l.live).length;
  const spare = [];
  for (let i = live; i < LINKS_LIVE_MAX; i++) spare.push(await newLink(ana, made.lisbon));
  const tooMany = await ana.post(`${at}/links`, {});
  t.same(`a trip has at most ${LINKS_LIVE_MAX} links in use`, [tooMany.status, tooMany.json?.error, tooMany.json?.max], [409, "too many links", LINKS_LIVE_MAX]);
  await del(ana, `${at}/links/${spare[0].id}`);
  t.same("once the host revokes one, another can be made", (await ana.post(`${at}/links`, {})).status, 201);
  for (const l of spare.slice(1)) await del(ana, `${at}/links/${l.id}`);

  // The most people on a trip. The others are made by hand: thirty sign-ups would prove nothing more.
  const onNow = (await ana.get(at)).json.members.filter((m) => m.left_at === null).length;
  const fill = TRIP_MEMBERS_MAX - onNow;
  const now = Math.floor(Date.now() / 1000);
  server.sql([
    ...Array.from({ length: fill }, (_, i) => `INSERT INTO users (id, name, created_at) VALUES ('fill-${i}', 'Filler ${i}', ${now})`),
    ...Array.from({ length: fill }, (_, i) => `INSERT INTO trip_members (trip_id, user_id, joined_at) VALUES (${q(made.lisbon)}, 'fill-${i}', ${now})`),
  ].join("; "));
  const usesBefore = (await ana.get(`${at}/links`)).json.links.find((l) => l.id === link.id).uses;
  const full = await dee.post(`/api/join/${link.code}`);
  t.same(`a trip has at most ${TRIP_MEMBERS_MAX} people on it`, [full.status, full.json?.error, full.json?.max], [409, "trip is full", TRIP_MEMBERS_MAX]);
  t.same("and a join that was refused costs the link nothing", (await ana.get(`${at}/links`)).json.links.find((l) => l.id === link.id).uses, usesBefore);
  server.sql(`DELETE FROM trip_members WHERE trip_id = ${q(made.lisbon)} AND user_id LIKE 'fill-%'; DELETE FROM users WHERE id LIKE 'fill-%'`);
  made.link = link;
}

// ═══ One person's write reaches another ══════════════════════════════════════════════════════
async function writes() {
  t.part("One person's write reaches another through the rev");
  const { ana, ben, cal } = who;
  const id = made.lisbon;
  const at = `/api/trips/${id}`;

  const r0 = await revOf(ben, id);
  const ev = { id: "ev-fado", title: "Fado night", starts_at: T0 + 20 * 3600, tz: "Europe/Lisbon" };
  const wrote = await ana.post(`${at}/events`, ev);
  t.same("the first member writes an event; the answer carries the trip's new rev", [wrote.status, wrote.json?.rev, wrote.json?.event?.rev], [201, r0 + 1, r0 + 1]);
  t.same("the second member's rev route shows it", await revOf(ben, id), r0 + 1);
  const seen = await ben.get(at);
  t.same("and their read of the trip has the event, at that rev", [seen.json?.rev, seen.json?.events?.find((e) => e.id === "ev-fado")?.title, seen.json?.events?.find((e) => e.id === "ev-fado")?.rev], [r0 + 1, "Fado night", r0 + 1]);
  t.same("a read changes no rev", await revOf(ana, id), r0 + 1);

  // Every write: its answer carries the trip's rev, one more than before (two for the one
  // request that is two writes), and the rev route then says the same.
  const lists = (await ana.get(at)).json.packing_lists;
  t.same("a trip starts with one packing list, the trip's, with three bags",
    lists.map((l) => [l.key, l.name, l.repeat, l.bags.map((b) => b.name)]), [["leaving-home", "Leaving home", "once", ["Main bag", "Day bag", "On me"]]]);
  const three = [ana.user.id, ben.user.id, cal.user.id];
  const WRITES = [
    ["an event changed", () => patch(ana, `${at}/events/ev-fado`, { title: "Fado, late" })],
    ["an event sent again (a replay): it finds its row and writes nothing", () => ana.post(`${at}/events`, ev), 0, 200],
    ["a message about a plan (what a note is now)", () => ben.post(`${at}/messages`, { id: "n-1", body: "Book ahead", about: { kind: "event", id: "ev-fado" } }), 1, 201],
    ["that message removed", () => del(ben, `${at}/messages/n-1`)],
    ["a packing item", () => ana.post(`${at}/packing`, { id: "pk-1", label: "Rain jacket" }), 1, 201],
    ["a packing item put in a bag as it is made (one write)", () => ana.post(`${at}/packing`, { id: "pk-2", label: "Charger", bags: { "leaving-home": "main-bag" } }), 1, 201],
    ["a packing item changed", () => patch(ana, `${at}/packing/pk-1`, { note: "the light one" })],
    ["a packing list", () => put(ana, `${at}/packing/lists`, { lists: [{ key: "day-out", name: "Day out", repeat: "daily", bags: [{ key: "pack", name: "Day pack" }] }] })],
    ["a packing list renamed", () => put(ana, `${at}/packing/lists`, { lists: [{ key: "day-out", name: "Every day out" }] })],
    ["a bag added", () => put(ana, `${at}/packing/lists`, { lists: [{ key: "day-out", bags: [{ key: "pack" }, { key: "tote", name: "Tote" }] }] })],
    ["an item put in a bag", () => patch(ana, `${at}/packing/pk-1`, { bags: { "day-out": "tote" } })],
    ["a tick for a day", () => put(ana, `${at}/packing/ticks`, { item_id: "pk-1", list_key: "day-out", day: "2027-04-03", ticked: true })],
    ["the tick taken back", () => put(ana, `${at}/packing/ticks`, { item_id: "pk-1", list_key: "day-out", day: "2027-04-03", ticked: false })],
    ["an item taken off a list", () => patch(ana, `${at}/packing/pk-1`, { bags: { "day-out": null } })],
    ["a bag removed", () => put(ana, `${at}/packing/lists`, { lists: [{ key: "day-out", bags: [{ key: "pack" }] }] })],
    ["a packing list removed", () => del(ana, `${at}/packing/lists/day-out`)],
    ["the suggested items", () => put(ana, `${at}/packing/starters`, { starters: [{ scope: "person", label: "Shoes with grip", category: "clothes", bags: { "leaving-home": "on-me" } }] })],
    ["a packing item removed", () => del(ana, `${at}/packing/pk-1`)],
    ["an area", () => put(ana, `${at}/areas`, { areas: [{ id: "alfama", name: "Alfama" }] })],
    ["a place", () => put(ben, `${at}/places`, { places: [{ id: "cafe-1", name: "Café", kind: "food", subkind: "cafe", why: "Coffee first", area: "alfama" }] })],
    ["a place removed", () => del(ben, `${at}/places/cafe-1`)],
    ["an area removed", () => del(ana, `${at}/areas/alfama`)],
    ["what the group cares about", () => patch(ben, at, { interests: "Coffee before anything else." })],
    ["a purchase", () => ana.post(`${at}/purchases`, {
      id: "pu-1", description: "Dinner", amount_minor: 9000, currency: "EUR", amount_exp: 2, split_mode: "weight", spent_at: T0 + 21 * 3600,
      shares: three.map((user_id) => ({ user_id, weight: 1, share_minor: 3000 })),
    }), 1, 201],
    ["a purchase changed", () => patch(ana, `${at}/purchases/pu-1`, { note: "cash" })],
    ["a purchase removed", () => del(ana, `${at}/purchases/pu-1`)],
    ["a memory", () => ben.post(`${at}/memories`, { id: "m-1", caption: "The tram", tags: ["Tram"] }), 1, 201],
    ["a memory removed", () => del(ben, `${at}/memories/m-1`)],
    ["the trip's own details", () => patch(cal, at, { name: "Lisbon, April" })],
    ["a link", () => cal.post(`${at}/links`, { uses: 1 }), 1, 201],
    ["an event removed", () => del(ana, `${at}/events/ev-fado`)],
  ];
  const off = [];
  for (const [what, send, steps = 1, status = 200] of WRITES) {
    const before = await revOf(cal, id);
    const res = await send();
    const want = before + steps;
    const after = await revOf(cal, id);
    if (res.status !== status || res.json?.rev !== want || after !== want) off.push(`${what}: ${res.status} (wanted ${status}), answer rev ${res.json?.rev}, rev route ${after}, wanted ${want}: ${res.text.slice(0, 120)}`);
  }
  t.ok(`each of ${WRITES.length} kinds of write answers with the trip's rev, one step on, and the rev route agrees`, off.length === 0, off.join("\n        "));

  // A change to what the roster shows is a change to every trip the account is on.
  const lisbon = await revOf(ana, id);
  const porto = await revOf(ana, made.porto);
  const named = await patch(ana, "/api/me", { name: "Ana C." });
  t.same("a member changes their name", [named.status, named.json?.me?.name], [200, "Ana C."]);
  t.same("which is one step of rev on each trip they are on", [await revOf(ana, id), await revOf(ana, made.porto)], [lisbon + 1, porto + 1]);
  t.same("and the other member's read has the new name at that rev", (await ben.get(at)).json.members.find((m) => m.id === ana.user.id), { ...(await ana.get(at)).json.members.find((m) => m.id === ana.user.id), name: "Ana C.", rev: lisbon + 1 });
  const tabs = await patch(ana, "/api/me", { tab_layout: ["agenda", "map"] });
  t.same("a setting only its owner sees changes no trip's rev", [tabs.status, await revOf(ana, id)], [200, lisbon + 1]);
  await patch(ana, "/api/me", { name: "Ana Check" });
}

// ═══ Removed, and left ═══════════════════════════════════════════════════════════════════════
async function leaving() {
  t.part("Removed, and left");
  const { ana, ben, cal, dee } = who;
  const id = made.lisbon;
  const at = `/api/trips/${id}`;

  // Something of Ben's and of Cal's to stay behind, and a stored file to be shut out of.
  await ben.post(`${at}/events`, { id: "ev-ben", title: "Ben's walk", starts_at: T0 + 9 * 3600, tz: "Europe/Lisbon" });
  await cal.post(`${at}/purchases`, {
    id: "pu-cal", description: "Taxi", amount_minor: 2000, currency: "EUR", amount_exp: 2, split_mode: "weight", spent_at: T0 + 3600,
    shares: [{ user_id: cal.user.id, weight: 1, share_minor: 1000 }, { user_id: ben.user.id, weight: 1, share_minor: 1000 }],
  });
  const bytes = Buffer.from("a stored file, for the trips check");
  const begun = await cal.post(`${at}/media/begin`, { name: "tram.jpg", mime: "image/jpeg", bytes: bytes.length });
  const key = begun.json?.key;
  const up = `key=${encodeURIComponent(key)}&id=${encodeURIComponent(begun.json?.uploadId)}`;
  const part = await cal.call("PUT", `${at}/media/part?${up}&n=1`, bytes, { headers: { "Content-Type": "application/octet-stream" } });
  const r0 = await revOf(ana, id);
  const done = await cal.post(`${at}/media/finish`, { key, id: begun.json?.uploadId, parts: [{ n: 1, etag: part.json?.etag }] });
  t.same("a member stores a file on the trip, one step of rev", [done.status, done.json?.rev], [200, r0 + 1]);
  t.same("another member can fetch it", (await ben.get(`/media/${key}`)).status, 200);
  t.same("someone who isn't on the trip can't: it's a 404", (await dee.get(`/media/${key}`)).status, 404);

  const notHost = await del(cal, `${at}/members/${ben.user.id}`);
  t.same("a member can't remove another member", [notHost.status, notHost.json], [403, { error: "forbidden", reason: HOST_ONLY }]);
  const hostOut = await del(ana, `${at}/members/${ana.user.id}`);
  t.same("the host can't leave", [hostOut.status, hostOut.json?.error], [409, "the host can't leave"]);
  const stranger = await del(ana, `${at}/members/${dee.user.id}`);
  t.same("someone who was never on the trip can't be removed from it", [stranger.status, stranger.json?.error], [404, "no such member"]);

  // The host removes Ben.
  t.same("before: the member reads the trip", (await ben.get(at)).status, 200);
  const r1 = await revOf(ana, id);
  const out = await del(ana, `${at}/members/${ben.user.id}`);
  t.same("the host removes a member, one step of rev", [out.status, out.json], [200, { ok: true, left: true, rev: r1 + 1 }]);
  t.same("the removed member's next request is refused, as if there were no such trip", said(await ben.get(at)), NO_TRIP);
  t.same("so is their rev route", said(await ben.get(`${at}/rev`)), NO_TRIP);
  t.same("so is a write", said(await ben.post(`${at}/events`, { title: "Sneaking back", starts_at: T0, tz: "UTC" })), NO_TRIP);
  t.same("so is the file they could fetch a moment ago", (await ben.get(`/media/${key}`)).status, 404);
  t.same("the trip is off their list", (await ben.get("/api/trips")).json.trips, []);
  const after = (await ana.get(at)).json;
  const benRow = after.members.find((m) => m.id === ben.user.id);
  t.ok("they stay on the roster as someone who left", benRow && Number.isInteger(benRow.left_at) && benRow.rev === r1 + 1, benRow);
  t.same("what they wrote stays, under their id", after.events.find((e) => e.id === "ev-ben")?.created_by, ben.user.id);
  t.same("what they owe stays in the purchase", after.purchases.find((p) => p.id === "pu-cal")?.shares.map((s) => s.user_id).sort(), [ben.user.id, cal.user.id].sort());
  const outAgain = await del(ana, `${at}/members/${ben.user.id}`);
  t.same("removing them again is not an error and changes nothing", [outAgain.status, outAgain.json], [200, { ok: true, left: false, rev: r1 + 1 }]);

  // Cal leaves.
  const r2 = await revOf(ana, id);
  const left = await del(cal, `${at}/members/${cal.user.id}`);
  t.same("a member leaves, one step of rev", [left.status, left.json], [200, { ok: true, left: true, rev: r2 + 1 }]);
  t.same("a member who left can't read the trip", said(await cal.get(at)), NO_TRIP);
  const differ = [];
  for (const [method, tail] of made.routes) {
    const res = await cal.call(method, at + tail, ["GET", "DELETE"].includes(method) ? null : {});
    if (JSON.stringify(said(res)) !== JSON.stringify(NO_TRIP)) differ.push(`${method} ${tail} -> ${res.status} ${res.text.slice(0, 80)}`);
  }
  t.ok(`nor reach any of its ${made.routes.length} routes`, differ.length === 0, differ.join("\n        "));
  t.same("nor the file they stored themselves", (await cal.get(`/media/${key}`)).status, 404);
  t.same("the people on the trip now are its host alone", (await ana.get("/api/trips")).json.trips.find((x) => x.id === id)?.members, 1);

  // Coming back. Removed is not left: a link made before the removal doesn't bring someone
  // the host removed back; a link made after does. Someone who left uses any link that works.
  const joinedAt = benRow.joined_at;
  const linkUses = async () => (await ana.get(`${at}/links`)).json.links.find((l) => l.id === made.link.id)?.uses;
  const [usesBefore, revBefore] = [await linkUses(), await revOf(ana, id)];
  t.same("someone the host removed can't come back by a link made before the removal: to them it is a link that doesn't work",
    said(await ben.post(`/api/join/${made.link.code}`)), NO_LINK);
  t.same("  (asking what the link is for still answers: that says nothing about who holds it, and the join is what's refused)", (await ben.get(`/api/join/${made.link.code}`)).status, 200);
  t.same("  (the refusal costs the link nothing and writes nothing)", [await linkUses(), await revOf(ana, id)], [usesBefore, revBefore]);
  const fresh = await newLink(ana, id, { uses: 1 });
  const back = await ben.post(`/api/join/${fresh.code}`);
  t.same("a link made after the removal brings them back", [back.status, back.json?.joined], [200, true]);
  const again = (await ben.get(at)).json?.members.find((m) => m.id === ben.user.id);
  t.same("onto the row they had, from the day they first joined", [again?.left_at, again?.joined_at], [null, joinedAt]);
  const calBack = await cal.post(`/api/join/${made.link.code}`);
  t.same("someone who left on their own comes back by a link made before they left", [calBack.status, calBack.json?.joined], [200, true]);

  // The host removing someone who had already left is a removal too.
  await del(cal, `${at}/members/${cal.user.id}`);
  const r4 = await revOf(ana, id);
  const calRemoved = await del(ana, `${at}/members/${cal.user.id}`);
  t.same("the host removing someone who had already left marks them removed: one write, and they had already left",
    [calRemoved.status, calRemoved.json], [200, { ok: true, left: false, rev: r4 + 1 }]);
  t.same("  (removing them a second time changes nothing)", (await del(ana, `${at}/members/${cal.user.id}`)).json, { ok: true, left: false, rev: r4 + 1 });
  t.same("  (the day they left stays the day they left)",
    (await ana.get(at)).json.members.find((m) => m.id === cal.user.id)?.left_at > 0 && (await ana.get(at)).json.members.find((m) => m.id === cal.user.id)?.rev, r4 + 1);
  t.same("so their old link no longer brings them back", said(await cal.post(`/api/join/${made.link.code}`)), NO_LINK);
  const forCal = await newLink(ana, id, { uses: 1 });
  t.same("a link made after it does", (await cal.post(`/api/join/${forCal.code}`)).json?.joined, true);

  // Back on, then leaving on their own: what the removal said is gone with it.
  t.same("someone brought back who then leaves on their own", (await del(ben, `${at}/members/${ben.user.id}`)).json?.left, true);
  const benReturns = await ben.post(`/api/join/${made.link.code}`);
  t.same("comes back like anyone who left, by any link that works", [benReturns.status, benReturns.json?.joined], [200, true]);

  // In the same second: the rev, not the clock, says which came first.
  const r3 = await revOf(ana, id);
  await del(ana, `${at}/members/${ben.user.id}`);
  const sameSecond = await newLink(ana, id, { uses: 1 });
  t.same("a link made right after a removal (often in the same second) brings them back: the rev orders the two, not the clock",
    [(await ben.post(`/api/join/${sameSecond.code}`)).json?.joined, sameSecond.rev > r3 + 1], [true, true]);
}

// ═══ Handing a trip over ═════════════════════════════════════════════════════════════════════
async function handing() {
  t.part("Handing a trip over: an offer the other person accepts");
  const { ana, ben, cal, dee, hoster } = who;
  const id = made.lisbon;
  const at = `/api/trips/${id}`;

  const notHost = await ben.post(`${at}/host`, { to: cal.user.id });
  t.same("only the host hands the trip over", [notHost.status, notHost.json], [403, { error: "forbidden", reason: HOST_ONLY }]);
  t.same("not to themselves", (await ana.post(`${at}/host`, { to: ana.user.id })).status, 400);
  t.same("not to nobody", (await ana.post(`${at}/host`, {})).status, 400);
  const stranger = await ana.post(`${at}/host`, { to: dee.user.id });
  t.same("not to someone who isn't on the trip", [stranger.status, stranger.json?.error], [404, "no such member"]);
  await bring(ana, id, hoster);
  t.same("an account that already hosts 20 can be offered the trip", (await ana.post(`${at}/host`, { to: hoster.user.id })).status, 201);
  const full = await hoster.post(`${at}/host/accept`);
  t.same(`but can't accept it: it already hosts ${TRIPS_HOSTED_MAX}`, [full.status, full.json?.error], [409, "too many trips"]);
  t.same("after all of those the host is who it was", (await ana.get(at)).json.trip.host_id, ana.user.id);

  const offer = await ana.post(`${at}/host`, { to: ben.user.id });
  t.same("an offer to another member replaces the last; nothing changes until it is accepted",
    [offer.status, (await cal.get(at)).json.handover?.to, (await cal.get(at)).json.trip.host_id], [201, ben.user.id, ana.user.id]);
  const r0 = await revOf(ana, id);
  const over = await ben.post(`${at}/host/accept`);
  t.same("the member accepts: the trip is theirs, one step of rev", [over.status, over.json?.trip?.host_id, over.json?.rev], [200, ben.user.id, r0 + 1]);
  const roster = (await cal.get(at)).json;
  t.same("the roster says who hosts now", roster.members.filter((m) => m.left_at === null).map((m) => [m.name, m.role]),
    [["Ana Check", "member"], ["Ben Check", "host"], ["Cal Check", "member"], ["Hoster Check", "member"]]);
  t.same("both of their rows carry that rev", roster.members.filter((m) => [ana.user.id, ben.user.id].includes(m.id)).map((m) => m.rev), [r0 + 1, r0 + 1]);
  t.same("each list of trips says the same", [(await ana.get("/api/trips")).json.trips.find((x) => x.id === id)?.role, (await ben.get("/api/trips")).json.trips.find((x) => x.id === id)?.role], ["member", "host"]);
  const link = (await ben.get(`${at}/links`)).json.links.find((l) => l.live);
  t.same("the one who was host can't revoke a link any more", (await del(ana, `${at}/links/${link.id}`)).status, 403);
  t.same("the new host can", (await del(ben, `${at}/links/${link.id}`)).json?.revoked, true);
  t.same("the new host can't leave", (await del(ben, `${at}/members/${ben.user.id}`)).status, 409);
  t.same("the one who was host can", (await del(ana, `${at}/members/${ana.user.id}`)).json?.left, true);
  // Back as it was, for the parts after this one.
  await bring(ben, id, ana);
  await ben.post(`${at}/host`, { to: ana.user.id });
  const back = await ana.post(`${at}/host/accept`);
  t.same("and the trip can be handed back", [back.status, back.json?.trip?.host_id], [200, ana.user.id]);
  await del(ana, `${at}/members/${hoster.user.id}`);
}

// ═══ Two trips stay apart ════════════════════════════════════════════════════════════════════
async function apart() {
  t.part("Two trips stay apart");
  const { ana, ben, dee } = who;
  const A = `/api/trips/${made.lisbon}`;
  const B = `/api/trips/${made.porto}`;      // Ana's other trip; Ben isn't on it

  await ana.post(`${A}/events`, { id: "ev-a", title: "In Lisbon", starts_at: T0, tz: "Europe/Lisbon" });
  await ana.post(`${A}/packing`, { id: "pk-a", label: "Lisbon item", owner: "group" });
  await ana.post(`${A}/purchases`, {
    id: "pu-a", description: "Lisbon lunch", amount_minor: 1000, currency: "EUR", amount_exp: 2, split_mode: "weight", spent_at: T0,
    shares: [{ user_id: ana.user.id, weight: 1, share_minor: 1000 }],
  });
  const snapB = (await ana.get(B)).json;
  t.same("one trip's read has nothing of the other's", [snapB.events.length, snapB.purchases.length, snapB.packing.filter((p) => p.id === "pk-a").length, snapB.members.map((m) => m.name)], [0, 0, 0, ["Ana Check"]]);

  const r0 = await revOf(ana, made.porto);
  const rA = await revOf(ana, made.lisbon);
  const viaB = [
    ["an event changed", await patch(ana, `${B}/events/ev-a`, { title: "Moved" }), 404],
    ["an event removed", await del(ana, `${B}/events/ev-a`), 200],
    ["a message about it", await ana.post(`${B}/messages`, { id: "m-x", body: "hello", about: { kind: "event", id: "ev-a" } }), 404],
    ["a purchase changed", await patch(ana, `${B}/purchases/pu-a`, { note: "x" }), 404],
    ["a purchase removed", await del(ana, `${B}/purchases/pu-a`), 200],
    ["a packing item changed", await patch(ana, `${B}/packing/pk-a`, { label: "Moved" }), 404],
    ["a packing item removed", await del(ana, `${B}/packing/pk-a`), 200],
    ["a purchase tied to the other trip's event", await ana.post(`${B}/purchases`, {
      id: "pu-b", description: "x", amount_minor: 100, currency: "EUR", amount_exp: 2, split_mode: "weight", spent_at: T0, event_id: "ev-a",
      shares: [{ user_id: ana.user.id, weight: 1, share_minor: 100 }],
    }), 400],
    ["a purchase shared with someone who is only on the other trip", await ana.post(`${B}/purchases`, {
      id: "pu-b", description: "x", amount_minor: 100, currency: "EUR", amount_exp: 2, split_mode: "weight", spent_at: T0,
      shares: [{ user_id: ben.user.id, weight: 1, share_minor: 100 }],
    }), 400],
  ];
  const wrong = viaB.filter(([, res, status]) => res.status !== status).map(([what, res, status]) => `${what}: ${res.status} (wanted ${status}) ${res.text.slice(0, 100)}`);
  t.ok("through one trip's address, the other trip's rows can't be changed, removed or pointed at", wrong.length === 0, wrong.join("\n        "));
  const snapA = (await ana.get(A)).json;
  t.same("and they are as they were", [snapA.events.find((e) => e.id === "ev-a")?.title, snapA.purchases.find((p) => p.id === "pu-a")?.description, snapA.packing.find((p) => p.id === "pk-a")?.label], ["In Lisbon", "Lisbon lunch", "Lisbon item"]);
  t.same("with the other trip's rev where it was", await revOf(ana, made.lisbon), rA);

  // An event's, a place's and an area's id is unique within its trip: another trip may use
  // the same one, and it is another row. Other rows' ids are one row on the whole site.
  const twin = await ana.post(`${B}/events`, { id: "ev-a", title: "Same id, other trip", starts_at: TP, tz: "UTC" });
  t.same("an event id one trip uses is a new event on another", [twin.status, twin.json?.event?.title], [201, "Same id, other trip"]);
  t.same("  (and the first trip's is as it was)", (await ana.get(A)).json.events.find((e) => e.id === "ev-a")?.title, "In Lisbon");
  const sameId = [
    ["a purchase", await ana.post(`${B}/purchases`, { id: "pu-a", description: "Same id", amount_minor: 100, currency: "EUR", amount_exp: 2, split_mode: "weight", spent_at: T0, shares: [{ user_id: ana.user.id, weight: 1, share_minor: 100 }] })],
    ["a packing item", await ana.post(`${B}/packing`, { id: "pk-a", label: "Same id" })],
    ["a memory", (await ana.post(`${A}/memories`, { id: "m-a", caption: "Lisbon" }), await ana.post(`${B}/memories`, { id: "m-a", caption: "Same id" }))],
  ];
  const notRefused = sameId.filter(([, res]) => res.status !== 409 || res.json?.error !== "id already exists").map(([what, res]) => `${what}: ${res.status} ${res.text.slice(0, 100)}`);
  t.ok("a purchase's, a packing item's or a memory's id in use on one trip is refused on another as a collision, not a server error", notRefused.length === 0, notRefused.join("\n        "));
  t.ok("the other trip moved only by its own writes", (await revOf(ana, made.porto)) >= r0);

  // There is no import any more: a seed goes in through the routes (tools/seed-trip.mjs).
  t.same("the import route is gone", said(await ana.post(`${B}/import`, { places: [], events: [] })), [404, '{"error":"no such route"}']);
  await bring(ana, made.porto, dee);
  await del(ana, `${B}/members/${dee.user.id}`);
}

// ═══ Settling up ═════════════════════════════════════════════════════════════════════════════
async function settling() {
  t.part("Settling up: a payment is a kind of purchase");
  const { ana, ben, cal } = who;
  const at = `/api/trips/${made.lisbon}`;
  const pay = (over = {}) => ({
    id: "pay-1", kind: "payment", description: "Ben pays Ana back", amount_minor: 4000, currency: "EUR", amount_exp: 2, split_mode: "exact",
    spent_at: T0 + 86400, paid_by: ben.user.id, shares: [{ user_id: ana.user.id, weight: 4000, share_minor: 4000 }], ...over,
  });

  const plain = await ana.post(`${at}/purchases`, {
    id: "pu-plain", description: "Groceries", amount_minor: 3000, currency: "EUR", amount_exp: 2, split_mode: "weight", spent_at: T0,
    shares: [{ user_id: ana.user.id, weight: 1, share_minor: 1500 }, { user_id: ben.user.id, weight: 1, share_minor: 1500 }],
  });
  t.same("a purchase made without a kind is a purchase", [plain.status, plain.json?.purchase?.kind], [201, "purchase"]);

  const refusals = [
    ["a kind that isn't one", pay({ kind: "refund" }), "unknown kind"],
    ["a payment with two shares", pay({ shares: [{ user_id: ana.user.id, weight: 2000, share_minor: 2000 }, { user_id: cal.user.id, weight: 2000, share_minor: 2000 }] }), "a payment has exactly one share: the person who received it"],
    ["a payment to the person who paid it", pay({ shares: [{ user_id: ben.user.id, weight: 4000, share_minor: 4000 }] }), "a payment's share is for someone other than the person who paid"],
    ["a payment whose share is short of its amount", pay({ amount_minor: 5000 }), "shares do not sum to the amount"],
    ["a payment with a day", pay({ day: "2027-04-03" }), "a payment has no day, event or place"],
    ["a payment tied to an event", pay({ event_id: "ev-a" }), "a payment has no day, event or place"],
  ];
  for (const [what, body, error] of refusals) {
    const res = await ben.post(`${at}/purchases`, body);
    t.same(`refused: ${what}`, [res.status, res.json?.error], [400, error]);
  }
  made.refusals = refusals.map(([what, , error]) => [what, 400, error]);
  t.same("none of those was written", (await ana.get(at)).json.purchases.filter((p) => p.id === "pay-1").length, 0);

  const r0 = await revOf(ana, made.lisbon);
  const paid = await ben.post(`${at}/purchases`, pay());
  t.same("a payment is made: one share, for the other person, the whole amount", [paid.status, paid.json?.purchase?.kind, paid.json?.purchase?.shares, paid.json?.rev],
    [201, "payment", [{ user_id: ana.user.id, weight: 4000, share_minor: 4000 }], r0 + 1]);
  t.same("it is in the trip's purchases with its kind", (await cal.get(at)).json.purchases.find((p) => p.id === "pay-1")?.kind, "payment");

  const toPurchase = await patch(ben, `${at}/purchases/pay-1`, { kind: "purchase" });
  t.same("a payment can't become a purchase", [toPurchase.status, toPurchase.json?.error], [400, "a purchase's kind can't be changed"]);
  const toPayment = await patch(ana, `${at}/purchases/pu-plain`, { kind: "payment" });
  t.same("nor a purchase a payment", [toPayment.status, toPayment.json?.error], [400, "a purchase's kind can't be changed"]);
  const resent = await ben.post(`${at}/purchases`, pay({ kind: "purchase" }));
  t.same("nor by sending the row again as the other kind", [resent.status, resent.json?.error], [400, "a purchase's kind can't be changed"]);
  t.same("naming the kind it has changes nothing and is allowed", (await patch(ben, `${at}/purchases/pay-1`, { kind: "payment", note: "bank transfer" })).status, 200);
  const stillOne = await patch(ben, `${at}/purchases/pay-1`, { amount_minor: 5000, currency: "EUR", amount_exp: 2, split_mode: "exact", shares: [{ user_id: ana.user.id, weight: 4000, share_minor: 4000 }] });
  t.same("a change that would leave the share short of the amount is refused, as for any purchase", [stillOne.status, stillOne.json?.error], [400, "shares do not sum to the amount"]);
  const withDay = await patch(ben, `${at}/purchases/pay-1`, { day: "2027-04-03" });
  t.same("so is giving it a day", [withDay.status, withDay.json?.error], [400, "a payment has no day, event or place"]);

  // Who may change or remove a payment: whoever added it, paid it or received it.
  const third = await patch(cal, `${at}/purchases/pay-1`, { note: "mine now" });
  t.same("a member who neither added, paid nor received a payment can't change it", [third.status, third.json?.error], [403, "forbidden"]);
  t.same("nor remove it", (await del(cal, `${at}/purchases/pay-1`)).status, 403);
  const byReceiver = await patch(ana, `${at}/purchases/pay-1`, { note: "arrived" });
  t.same("whoever received it can change it", [byReceiver.status, byReceiver.json?.purchase?.note], [200, "arrived"]);
  const sharer = await patch(ben, `${at}/purchases/pu-plain`, { note: "x" });
  t.same("a purchase keeps its rule: someone who only shares in it can't change it", [sharer.status, sharer.json?.error], [403, "forbidden"]);
  const r1 = await revOf(ana, made.lisbon);
  const removed = await del(ana, `${at}/purchases/pay-1`);
  t.same("whoever received it can remove it", [removed.status, removed.json], [200, { ok: true, deleted: true, rev: r1 + 1 }]);
  t.same("and it is gone, shares and all", [(await ana.get(at)).json.purchases.filter((p) => p.id === "pay-1").length, server.sql("SELECT COUNT(*) AS n FROM purchase_shares WHERE purchase_id = 'pay-1'")[0].n], [0, 0]);
}

// ═══ Addresses that aren't there, files, and the old addresses (gone) ═══════════════════════════════
async function addresses() {
  t.part("Addresses that aren't there, the app's files, and the old addresses");
  const { ana, ben, dee } = who;
  const anon = new Person(server.origin, "Nobody");
  const isJson = (res) => (res.headers.find(([k]) => k === "content-type")?.[1] ?? "").includes("application/json");

  for (const [method, at] of [["GET", "/api/nope"], ["POST", "/api/nope/deeper"], ["GET", "/api"], ["GET", "/api/trips/x/y/z/nope"]]) {
    const res = await ana.call(method, at, method === "GET" ? null : {}, { page: true });
    t.ok(`${method} ${at} is a 404 in JSON, even for a browser asking for a page`, res.status === 404 && isJson(res) && res.json?.error === "no such route", `${res.status} ${res.text.slice(0, 80)}`);
  }
  const outNope = await anon.get("/api/nope");
  t.same("signed out, an address that isn't there is the same 401 as one that is", [outNope.status, outNope.json], [401, { error: "unauthorized" }]);
  const wrongMethod = await ana.call("PUT", "/api/trips", {});
  t.same("an address that is there, asked the wrong way, is a 405 naming the right ways", [wrongMethod.status, wrongMethod.json], [405, { error: "method not allowed", allow: ["GET", "POST"] }]);

  // The app's files answer anyone, without a session, and never send a browser to sign in.
  for (const at of ["/", "/account", "/login", "/js/store.js", "/styles.css", "/sw.js", "/js/shared/limits.js"]) {
    const res = await anon.get(at, { page: at === "/" || !at.includes(".") });
    const head = (name) => res.headers.find(([k]) => k === name)?.[1];
    t.ok(`${at} is served to someone signed out, with its two headers`, res.status === 200 && head("referrer-policy") === "strict-origin-when-cross-origin" && head("x-content-type-options") === "nosniff",
      `${res.status} ${res.location ?? ""} referrer-policy=${head("referrer-policy")} nosniff=${head("x-content-type-options")}`);
  }
  const me = await anon.get("/api/me");
  t.same("what tells a page nobody is signed in is /api/me", [me.status, me.json], [401, { error: "unauthorized" }]);
  const mine = await ana.get("/api/me");
  t.same("/api/me says who, and nothing about trips or running the site", Object.keys(mine.json ?? {}).sort(), ["guest", "id", "initials", "name", "native_currency", "note_color", "note_colors", "tab_layout", "units"]);

  // Map data: for an account that is on a trip.
  t.same("map data, signed out", (await anon.get("/tiles/fonts/Noto%20Sans%20Regular/0-255.pbf")).status, 401);
  const hal = await person("Hal Check");
  t.same("map data, on no trip", said(await hal.get("/tiles/fonts/Noto%20Sans%20Regular/0-255.pbf")), [403, '{"error":"no trip"}']);
  t.same("map data, on a trip (there is no such file here)", (await ana.get("/tiles/fonts/Noto%20Sans%20Regular/0-255.pbf")).status, 404);
  await newTrip(hal, { name: "Hal's first" });
  t.same("map data, the moment after making a first trip", (await hal.get("/tiles/fonts/Noto%20Sans%20Regular/0-255.pbf")).status, 404);
  // The map's old address (an archive by its name) is gone: a plain 404, never the app's page.
  const oldAddress = await ana.get("/tiles/peru.pmtiles");
  t.same("the map's old address, /tiles/<key>, answers a plain 404, not the app's page", [oldAddress.status, oldAddress.text], [404, "not found"]);

  // The addresses from before a trip had an id are gone (14 Nov, when the app moved): even an
  // account on exactly one trip is told there's no such route, and nothing is guessed or written.
  const benTrips = (await ben.get("/api/trips")).json.trips.map((x) => x.id);
  t.same("an account on exactly one trip", benTrips, [made.lisbon]);
  const NO_ROUTE = [404, '{"error":"no such route"}'];
  const before = (await ben.get(`/api/trips/${made.lisbon}`)).json?.rev;
  t.same("gets no trip at the old address", said(await ben.get("/api/trip")), NO_ROUTE);
  // A write there is the old app on a phone sending what it kept: 503, so it keeps it for the new
  // app (src/old-writes.js), signed in or not, and nothing is written.
  const oldWrite = await ben.post("/api/events", { id: "ev-old", title: "By the old address", starts_at: T0, tz: "UTC" });
  t.same("a write there is a 503 with a sentence, so the old app keeps the change for the new one",
    [oldWrite.status, oldWrite.json?.error, /keeps this change/.test(oldWrite.json?.reason ?? "")], [503, "the app has been updated", true]);
  t.same("  (and nothing was written: the trip's rev is where it was, no such event on it)",
    [(await ben.get(`/api/trips/${made.lisbon}`)).json?.rev, (await ben.get(`/api/trips/${made.lisbon}/events`)).json?.events?.some((e) => e.id === "ev-old")], [before, false]);
  t.same("an account on two trips the same", [(await ana.get("/api/trips")).json.trips.length > 1, said(await ana.get("/api/trip"))], [true, NO_ROUTE]);
  t.same("an account on no trip the same", said(await dee.get("/api/trip")), NO_ROUTE);
  t.same("signed out, the old address is a 401", (await anon.get("/api/trip")).status, 401);
  t.same("the file that answered them is gone", fs.existsSync(path.join(ROOT, "src/old-addresses.js")), false);
  // Every write address the old site had and this one doesn't: 503, before the session is read.
  const { OLD_WRITES } = await import("../../src/old-writes.js");
  const asked = [];
  for (const [method, at] of OLD_WRITES) {
    const where = at.replace(/:id/g, "pk_Owner.x_0a1b2c3d");
    const inRes = await ben.call(method, where, method === "DELETE" ? null : { id: "x", done: true });
    const outRes = await anon.call(method, where, method === "DELETE" ? null : {});
    asked.push(`${method} ${at}: ${inRes.status}/${outRes.status}`);
  }
  t.ok(`all ${OLD_WRITES.length} of the old site's write addresses answer 503, signed in and signed out`, asked.every((x) => x.endsWith(": 503/503")), asked.filter((x) => !x.endsWith(": 503/503")).join(", "));
  t.same("  (and nothing was written by any of them)", (await ben.get(`/api/trips/${made.lisbon}`)).json?.rev, before);
  const kept = [["PATCH", "/api/me", { initials: "BC" }], ["POST", "/api/fx/refresh", {}]];
  const stillServed = [];
  for (const [method, at, body] of kept) stillServed.push((await ben.call(method, at, body)).status);
  t.same("the old writes the new server still serves at the same address are served (PATCH /api/me, POST /api/fx/refresh)", stillServed, [200, 200]);
  const reads = [];
  for (const at of ["/api/trip", "/api/events", "/api/notes", "/api/packing", "/api/packing/views", "/api/packing/sections", "/api/packing/placements", "/api/places", "/api/purchases", "/api/memories", "/api/invites", "/api/media/config", "/api/collage/shares"]) reads.push(`${at} ${(await ben.get(at)).status}`);
  t.ok("the old site's reads are a 404 (the old app keeps what the phone has on any answer but 200)", reads.every((x) => x.endsWith(" 404")), reads.join(", "));
}

// ═══ Deleting an account that hosts ══════════════════════════════════════════════════════════
async function deleting() {
  t.part("Deleting an account that hosts");
  const { ana, ben } = who;
  const A = `/api/trips/${made.lisbon}`;

  // Hosting a trip other people are on.
  const refused = await del(ana, "/api/me", { confirm: "delete" });
  t.same("an account that hosts a trip other people are on can't be deleted", [refused.status, refused.json?.error], [409, "host"]);
  t.same("the answer names the trip and how many others are on it", refused.json?.trips, [{ id: made.lisbon, name: "Lisbon, April", members: 2 }]);
  t.same("and nothing was changed: still signed in, still hosting, the other trip still there",
    [(await ana.get("/api/me")).status, (await ana.get(A)).json?.trip?.host_id, (await ana.get("/api/trips")).json.trips.length], [200, ana.user.id, 2]);

  // Fay hosts a trip alone, and is a member of Lisbon.
  const fay = await person("Fay Check");
  const solo = await newTrip(fay, { id: "t-solo", name: "Fay alone", starts_on: "2027-04-01", ends_on: "2027-04-10" });
  const S = `/api/trips/${solo.id}`;
  await fay.post(`${S}/events`, { id: "ev-solo", title: "Solo walk", starts_at: T0, tz: "UTC" });
  await fay.post(`${S}/messages`, { id: "n-solo", body: "note", about: { kind: "event", id: "ev-solo" } });
  await fay.post(`${S}/packing`, { id: "pk-solo", label: "Boots" });
  await fay.post(`${S}/purchases`, { id: "pu-solo", description: "Bus", amount_minor: 300, currency: "EUR", amount_exp: 2, split_mode: "weight", spent_at: T0, shares: [{ user_id: fay.user.id, weight: 1, share_minor: 300 }] });
  await fay.post(`${S}/memories`, { id: "m-solo", caption: "A view" });
  await newLink(fay, solo.id);
  await fay.post(`${S}/packing`, { id: "pk-solo-2", label: "Socks", bags: { "leaving-home": "main-bag" } });
  await put(fay, `${S}/packing/ticks`, { item_id: "pk-solo-2", list_key: "leaving-home", ticked: true });
  await put(fay, `${S}/packing/starters`, { starters: [{ scope: "group", label: "First-aid kit", category: "meds", bags: { "leaving-home": "main-bag" } }] });
  await put(fay, `${S}/areas`, { areas: [{ id: "old-town", name: "Old town" }] });
  await put(fay, `${S}/places`, { places: [{ id: "p-solo", name: "A view", kind: "sight", subkind: "viewpoint", why: "The view", area: "old-town" }] });
  // Someone who was on it once and left doesn't make it shared.
  const gus = await person("Gus Check");
  await bring(fay, solo.id, gus);
  await gus.post(`${S}/events`, { id: "ev-gus", title: "Gus was here", starts_at: T0, tz: "UTC" });
  await del(gus, `${S}/members/${gus.user.id}`);
  await bring(ana, made.lisbon, fay);
  await fay.post(`${A}/events`, { id: "ev-fay", title: "Fay in Lisbon", starts_at: T0, tz: "Europe/Lisbon" });

  const count = () => Object.values(server.sql(`SELECT ${
    ["trips WHERE id", "trip_members WHERE trip_id", "trip_links WHERE trip_id", "events WHERE trip_id", "packing_items WHERE trip_id", "packing_lists WHERE trip_id",
      "packing_bags WHERE trip_id", "packing_placements WHERE trip_id", "packing_ticks WHERE trip_id", "packing_starters WHERE trip_id", "areas WHERE trip_id", "places WHERE trip_id",
      "purchases WHERE trip_id", "memories WHERE trip_id"].map((x, i) => `(SELECT COUNT(*) FROM ${x} = 't-solo') AS n${i}`).join(", ")}`)[0]);
  const before = count();
  t.ok("before: the trip she hosts alone has rows of every kind", before.every((n) => n > 0), before);
  const rA = await revOf(ana, made.lisbon);
  const gone = await del(fay, "/api/me", { confirm: "delete" });
  t.same("an account that hosts only a trip nobody else is on can be deleted", [gone.status, gone.json], [200, { ok: true }]);
  t.same("that trip went with it, whole", count().every((n) => n === 0), true);
  t.same("with its messages and shares", server.sql("SELECT (SELECT COUNT(*) FROM messages WHERE id = 'n-solo') + (SELECT COUNT(*) FROM purchase_shares WHERE purchase_id = 'pu-solo') AS n")[0].n, 0);
  t.same("the one who had left it finds no such trip", said(await gus.get(S)), NO_TRIP);
  const lisbon = (await ana.get(A)).json;
  const row = lisbon.members.find((m) => m.id === fay.user.id);
  t.ok("on the trip she was only a member of, she is someone who left, marked deleted", row && row.deleted === true && Number.isInteger(row.left_at), row);
  t.same("what she added to its plan stays", lisbon.events.find((e) => e.id === "ev-fay")?.created_by, fay.user.id);
  t.ok("and that trip's rev went up, so the others learn of it", lisbon.rev > rA && row.rev === lisbon.rev, [rA, lisbon.rev, row?.rev]);
  t.same("nobody else's trip was touched", (await ben.get(A)).status, 200);

  // After handing the trip over, the first host can go.
  await ana.post(`${A}/host`, { to: ben.user.id });
  await ben.post(`${A}/host/accept`);
  const free = await del(ana, "/api/me", { confirm: "delete" });
  t.same("after handing her shared trip over, the host can be deleted", [free.status, free.json], [200, { ok: true }]);
  t.same("the trip she handed over is there, hosted by who she gave it to", (await ben.get(A)).json?.trip?.host_id, ben.user.id);
  t.same("the trip she hosted alone went with her", server.sql(`SELECT COUNT(*) AS n FROM trips WHERE id = ${q(made.porto)}`)[0].n, 0);
  t.same("with what was written into it", server.sql(`SELECT (SELECT COUNT(*) FROM events WHERE trip_id = ${q(made.porto)}) + (SELECT COUNT(*) FROM packing_lists WHERE trip_id = ${q(made.porto)}) AS n`)[0].n, 0);
  t.same("no trip is left with a host who is gone", server.sql("SELECT COUNT(*) AS n FROM trips t JOIN users u ON u.id = t.host_id WHERE u.deleted_at IS NOT NULL")[0].n, 0);
}

// The rates come from a stand-in on this machine in every check (checks/lib/server.mjs); the
// site's own config names no provider, and an address that isn't this machine is never asked.
async function rates() {
  t.part("Exchange rates, from a stand-in on this machine");
  const REAL = "https://open.er-api.com/v6/latest/USD";
  t.same("wrangler.jsonc names no rates provider of its own (the real one is in src/api/fx.js)", server.configured.fxProvider, null);
  t.same("a provider address that isn't this machine is refused, and the real provider asked instead",
    [providerUrl({ FX_PROVIDER_URL: "https://rates.example/v6/latest/USD" }), providerUrl({ FX_PROVIDER_URL: "http://10.0.0.5/v6/latest/USD" }),
      providerUrl({ FX_PROVIDER_URL: "not an address" }), providerUrl({}), providerUrl({ FX_PROVIDER_URL: "http://127.0.0.1:9/v6/latest/USD" })],
    [REAL, REAL, REAL, REAL, "http://127.0.0.1:9/v6/latest/USD"]);
  const rae = await person("Rae Check");
  const got = await rae.post("/api/fx/refresh", {});
  t.same("asking for rates gets the stand-in's fixed ones: this check's server never reaches the network for them",
    [got.status, got.json?.fx?.base, got.json?.fx?.rates?.EUR, got.json?.fx?.rates?.KES, Object.keys(got.json?.fx?.rates ?? {}).length],
    [200, "USD", FIXED_RATES.EUR, FIXED_RATES.KES, Object.keys(FIXED_RATES).length]);
}

// What the delete dialog says goes, for one and for several of each (public/js/trip-words.js).
async function words() {
  t.part("The delete dialog's words, for one and for several");
  const say = (goes) => goesLines({ members: 1, photos: 0, videos: 0, bytes: 0, boards: 0, purchases: 0, payments: 0, someone_owes: false, ...goes }).map(([, w]) => w);
  t.same("nothing on it", say({}), ["Nobody else is on it.", "It holds no photos, videos or pictures."]);
  t.same("a picture and a receipt", say({ pictures: 1, receipts: 1, bytes: 3 * 1024 }), ["Nobody else is on it.", "1 picture and 1 receipt go, 3 KB in all."]);
  t.same("pictures, receipts and photos", say({ photos: 2, pictures: 3, receipts: 2, bytes: 1024 * 1024 }), ["Nobody else is on it.", "2 photos, 3 pictures and 2 receipts go, 1 MB in all."]);
  t.same("one of each", say({ members: 2, photos: 1, bytes: 1024, boards: 1, purchases: 1 }),
    ["1 other person loses it, as you do.", "1 photo goes, 1 KB in all.", "1 shared board stops working for whoever has its link.", "1 purchase goes, with who owes whom."]);
  t.same("several of each", say({ members: 4, photos: 3, videos: 2, bytes: 5 * 1024 * 1024, boards: 2, purchases: 5, payments: 2, someone_owes: true }),
    ["3 other people lose it, as you do.", "3 photos and 2 videos go, 5 MB in all.", "2 shared boards stop working for whoever has their links.",
      "5 purchases and 2 payments go, with who owes whom.", "Someone still owes money on it. Settle up first if that matters: afterwards nobody can see it."]);
  t.same("one video alone, and one payment alone", say({ videos: 1, bytes: 2048, payments: 1 }), ["Nobody else is on it.", "1 video goes, 2 KB in all.", "1 payment goes, with who owes whom."]);
}

// The currency "Make a trip" offers an account with none, guessed from the phone
// (public/js/shared/home-currency.js).
async function guess() {
  t.part("A home currency, guessed from the phone");
  const G = (languages, timeZone) => guessHomeCurrency({ languages, timeZone });
  t.same("a language set to a country gives that country's money: en-US, en-GB, zh-Hant-TW, de-CH, pt-BR",
    [G(["en-US"], "UTC"), G(["en-GB"], "Asia/Tokyo"), G(["zh-Hant-TW"], "UTC"), G(["de-CH"], "UTC"), G(["pt-BR"], "UTC")].map((g) => g && `${g.code} ${g.region} ${g.from}`),
    ["USD US language", "GBP GB language", "TWD TW language", "CHF CH language", "BRL BR language"]);
  t.same("a language with no country (nl), or one naming a part of the world (es-419), goes by the time zone's country",
    [G(["nl"], "Europe/Amsterdam"), G(["es-419"], "America/Lima"), G(["en"], "Asia/Kolkata")].map((g) => g && `${g.code} ${g.region} ${g.from}`),
    ["EUR NL zone", "PEN PE zone", "INR IN zone"]);
  t.same("no country anywhere, or none to read, is no guess: fr on UTC, nothing on UTC, a zone nobody has heard of",
    [G(["fr"], "UTC"), G([], "UTC"), G([undefined], "Nowhere/Atlantis"), G(["not a tag"], "UTC")], [null, null, null, null]);
  t.same("today's money, not yesterday's: Bulgaria uses the euro from 2026; Croatia the euro; a country whose new money the app doesn't know (Curaçao) is no guess",
    [currencyOfRegion("BG"), currencyOfRegion("HR"), currencyOfRegion("CW"), currencyOfRegion("ZZ")], ["EUR", "EUR", "", ""]);
  const table = knownRegions();
  t.ok(`every currency the table gives, for its ${table.length} regions, is one the app knows (money.js)`,
    table.length > 240 && table.every((r) => CURRENCY_CODES.includes(currencyOfRegion(r))), table.filter((r) => !CURRENCY_CODES.includes(currencyOfRegion(r))).join(", "));
  t.same("a time zone's country: Amsterdam, Lima, Kolkata, Honolulu", ["Europe/Amsterdam", "America/Lima", "Asia/Kolkata", "Pacific/Honolulu"].map(regionOfZone), ["NL", "PE", "IN", "US"]);
}

// No silent yes (src/api/ignored.js): every route that writes a trip's rows names, in its answer,
// what it was sent and doesn't take, and still does the write.
async function noSilentYes() {
  t.part("No silent yes: a field a write doesn't take is named in its answer");
  const pia = await person("Pia Check");
  const pid = pia.user.id;
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const trip = await newTrip(pia, { name: "Said back", starts_on: day(0), ends_on: day(5), currencies: ["EUR"] });
  const T = `/api/trips/${trip.id}`;
  const at = Math.floor(Date.parse(`${day(1)}T12:00:00Z`) / 1000);
  const X = { zz_extra: 1 };
  await pia.post(`${T}/events`, { id: "e-base", title: "x", starts_at: at, tz: "Europe/Lisbon" });
  await pia.post(`${T}/purchases`, { id: "u-base", description: "x", amount_minor: 100, currency: "EUR", amount_exp: 2, split_mode: "weight", shares: [{ user_id: pid, weight: 1, share_minor: 100 }] });
  const list = (await pia.get(T)).json.packing_lists[0];
  await pia.post(`${T}/packing`, { id: "tick-me", label: "t", bags: { [list.key]: list.bags[0].key } });
  const asked = [
    ["POST events", "POST", `${T}/events`, { id: "e-1", title: "x", starts_at: at, tz: "Europe/Lisbon", ...X }, ["zz_extra"]],
    ["PATCH events/:id", "PATCH", `${T}/events/e-base`, { title: "y", ...X }, ["zz_extra"]],
    ["PUT events", "PUT", `${T}/events`, { events: [{ id: "e-2", title: "x", starts_at: at, tz: "Europe/Lisbon", ...X }] }, ["events[0].zz_extra"]],
    ["PUT places", "PUT", `${T}/places`, { places: [{ id: "p-1", name: "x", kind: "food", subkind: "restaurant", lat: 38.7, lng: -9.1, ...X }] }, ["places[0].zz_extra"]],
    ["PUT areas", "PUT", `${T}/areas`, { areas: [{ id: "a-1", name: "x", ...X }] }, ["areas[0].zz_extra"]],
    ["POST purchases", "POST", `${T}/purchases`, { id: "u-1", description: "x", amount_minor: 100, currency: "EUR", amount_exp: 2, split_mode: "weight", shares: [{ user_id: pid, weight: 1, share_minor: 100, ...X }], ...X }, ["zz_extra", "shares[0].zz_extra"]],
    ["PATCH purchases/:id", "PATCH", `${T}/purchases/u-base`, { description: "y", ...X }, ["zz_extra"]],
    ["PUT packing/lists", "PUT", `${T}/packing/lists`, { lists: [{ key: "trek", name: "Trek", repeat: "once", bags: [{ key: "pack", name: "Pack", ...X }], ...X }] }, ["lists[0].zz_extra", "lists[0].bags[0].zz_extra"]],
    ["PUT packing/starters", "PUT", `${T}/packing/starters`, { starters: [{ id: "s-1", label: "x", category: "misc", scope: "person", ...X }] }, ["starters[0].zz_extra"]],
    ["PATCH packing/starters", "PATCH", `${T}/packing/starters`, { starters: [{ id: "s-1", label: "y", category: "misc", scope: "person", ...X }] }, ["starters[0].zz_extra"]],
    ["PUT packing/ticks", "PUT", `${T}/packing/ticks`, { item_id: "tick-me", list_key: list.key, ticked: true, ...X }, ["zz_extra"]],
    ["POST packing", "POST", `${T}/packing`, { id: "k-1", label: "x", ...X }, ["zz_extra"]],
    ["PUT packing/items", "PUT", `${T}/packing/items`, { items: [{ id: "k-2", label: "x", ...X }] }, ["items[0].zz_extra"]],
    ["POST messages", "POST", `${T}/messages`, { id: "m-1", body: "hi", about: { kind: "event", id: "e-base", ...X }, ...X }, ["zz_extra", "about.zz_extra"]],
    ["PATCH the trip", "PATCH", T, { name: "Said back again", ...X }, ["zz_extra"]],
  ];
  const got = [];
  for (const [what, method, path, body, want] of asked) {
    const r = await pia.call(method, path, body);
    got.push([what, r.status >= 200 && r.status < 300, JSON.stringify((r.json?.ignored ?? []).slice().sort()) === JSON.stringify(want.slice().sort()) ? "said" : `ignored ${JSON.stringify(r.json?.ignored ?? null)} (${r.status} ${r.json?.error ?? ""})`]);
  }
  t.ok(`each of the ${asked.length} trip-row writes does the write and names the field it doesn't take, nested rows by their place`,
    got.every(([, ok, said]) => ok && said === "said"), got.filter(([, ok, said]) => !ok || said !== "said").map((g) => g.join(": ")).join(" | "));
  const plain = await pia.post(`${T}/events`, { id: "e-3", title: "x", starts_at: at, tz: "Europe/Lisbon" });
  t.same("a write with nothing it doesn't take says nothing of the kind", [plain.status, "ignored" in (plain.json ?? {})], [201, false]);
}

// What a phone that had the old app sends once the new one has adopted its queue: the old app's
// own ids, and nothing a route would quietly ignore (a tick sent as `done` was once answered 200
// and lost).
async function oldPhone() {
  t.part("A phone that had the old app: its ids, and no field quietly ignored");
  const ola = await person("Ola Check");
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const trip = await newTrip(ola, { name: "The old phone's trip", starts_on: day(0), ends_on: day(5) });
  const T = `/api/trips/${trip.id}`;
  // The old app's two shapes for a packing thing: pk_<uuid>, and pk_<owner>_<8 hex> for one from
  // its starter list, whose owner part is a person's id (an uppercase letter and a dot can be in it).
  const plain = await ola.post(`${T}/packing`, { id: "pk_7d3e9b2a-1c4f-4a6b-8e2d-0f1a2b3c4d5e", label: "Sun hat" });
  const starter = await ola.post(`${T}/packing`, { id: "pk_U.ola_0a1b2c3d", label: "Water bottle" });
  const batch = await put(ola, `${T}/packing/items`, { items: [{ id: "pk_A.b_9f8e7d6c", label: "Socks" }] });
  const renamed = await patch(ola, `${T}/packing/pk_U.ola_0a1b2c3d`, { label: "Water bottle, 1 l" });
  t.same("the old app's packing ids are taken as they are: pk_<uuid>, pk_<owner>_<8 hex> with a capital and a dot, made, put and changed",
    [plain.status, starter.status, batch.status, batch.json?.rows ?? null, renamed.status], [201, 201, 200, null, 200]);
  // A field the route doesn't take is refused by name, on every way an item is written.
  const done = await ola.post(`${T}/packing`, { id: "pk_x1", label: "Torch", done: true });
  const doneP = await patch(ola, `${T}/packing/pk_U.ola_0a1b2c3d`, { done: true, section: "Bag" });
  const doneB = await put(ola, `${T}/packing/items`, { items: [{ id: "pk_x2", label: "Map", done: true }] });
  t.same("a packing write carrying a field whose meaning moved is refused, naming it and where it went: done (a tick now), section (bags now)",
    [done.status, done.json?.error, done.json?.fields, /ticks/.test(done.json?.reason ?? ""), doneP.status, doneP.json?.fields, /bags/.test(doneP.json?.reason ?? ""), doneB.status, doneB.json?.fields],
    [400, "field moved", ["done"], true, 400, ["done", "section"], true, 400, ["items[0].done"]]);
  const items = (await ola.get(T)).json.packing.map((i) => [i.id, i.label]).sort();
  t.same("  (and nothing was written by them: the item kept its name, no torch, no map)", items,
    [["pk_7d3e9b2a-1c4f-4a6b-8e2d-0f1a2b3c4d5e", "Sun hat"], ["pk_A.b_9f8e7d6c", "Socks"], ["pk_U.ola_0a1b2c3d", "Water bottle, 1 l"]]);
  // The old app's ids for the rest: a plan, a note and a purchase.
  const ev = await ola.post(`${T}/events`, { id: "ev_5b6c7d8e-0000-4000-8000-000000000001", title: "Made offline", starts_at: Math.floor(Date.parse(`${day(2)}T12:00:00Z`) / 1000), tz: "Europe/Lisbon" });
  const pu = await ola.post(`${T}/purchases`, { id: "pu_5b6c7d8e-0000-4000-8000-000000000002", description: "Bread", amount_minor: 300, currency: "EUR", amount_exp: 2, split_mode: "weight", shares: [{ user_id: ola.user.id, weight: 1, share_minor: 300 }] });
  t.same("the old app's ids for a plan (ev_<uuid>) and a purchase (pu_<uuid>) are taken", [ev.status, pu.status, ev.json?.reason ?? null], [201, 201, null]);
}

const PARTS = {
  words, guess, rates, making, whole, joining, writes, leaving, handing, apart, settling, addresses, oldPhone, noSilentYes, deleting,
  carries: () => carries({ t, server, person, patch, put, del, revOf, newTrip, bring }),
  storage: () => storage({ t, server, person, patch, put, del, newTrip, bring }),
  pictures: () => pictures({ t, server, person, put, del, newTrip, bring }),
};
const wanted = argv.length ? argv : Object.keys(PARTS);
for (const name of wanted) if (!PARTS[name]) { console.error(`no part called ${name}; there are: ${Object.keys(PARTS).join(", ")}`); process.exit(2); }

let code = 1;
try {
  // A small limit, so the storage part can fill it (src/trips/storage.js limitFor()).
  // PICTURE_STORE_PAUSE holds two planted pictures' stores mid-way, so the pictures part can put
  // another person's change in between (checks/trips/pictures.mjs).
  server = await startServer({ name: "trips", port, keep, vars: { STORAGE_LIMIT_BYTES: String(LIMIT), PICTURE_STORE_PAUSE: PAUSES } });
  await server.start();
  for (const name of wanted) await PARTS[name]();
  report.part("The server's log");
  // (The storage part plants a file the drain can't remove, and the drain says so on every run:
  // that line is the drain doing its job, not a fault.)
  const errors = server.log().split("\n").filter((line) => /Uncaught|✘|\[ERROR\]|\b500\b/.test(line) && !/files_to_delete: 1 file\(s\) failed 10 runs/.test(line));
  report.ok("nothing failed inside the server while the check ran", errors.length === 0, errors.slice(0, 10).join("\n        "));
  if (made.refusals) {
    console.log("\nThe settling-up refusals, as answered:");
    for (const [what, status, error] of made.refusals) console.log(`  ${status}  ${JSON.stringify({ error })}   (${what})`);
  }
  code = report.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  code = 2;
} finally {
  if (keep && server) console.log(`kept: ${server.work}`);
  await server?.stop();
}
process.exit(code);

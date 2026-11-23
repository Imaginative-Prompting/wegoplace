// The scenario: every request the parity recording makes, in order.
//
// It runs against a server on a fresh database (run.mjs sets that up), as four people:
//   anon   no cookie
//   admin  u_admin, a row put in the database with a session of its own. The name is from when
//          one account ran the site; now it is the account that makes the trip, so its host
//   bob    u_bob, the same way; joins the trip by a link, and later makes a trip of his own
//   carol  signs up, signs in and signs out through the real passkey routes, with a software
//          passkey (lib.mjs); joins by the same link, and is removed at the end
// u_old is an account from before sessions were rows, for the cookie of that time.
// Ids are supplied by the scenario wherever the API takes one, so answers are the same run
// after run; what the server mints itself is learned from its answer and named (t.learn).
//
// A step's name is its identity in the recording: names never repeat.

import crypto from "node:crypto";
import fs from "node:fs";
import { Passkey } from "./lib.mjs";
import { seedTrip } from "../../tools/seed-trip.mjs";
import { JPEG, SVG, WEBP, png } from "../lib/images.mjs";
import { encode as encodeDrawing, hashOf, toB64url } from "../../public/js/shared/avatar.js";

/** Rows the scenario needs before the first request. Fixed clock values, well before today. */
export const seedSql = `
INSERT INTO users (id, name, username, created_at) VALUES ('u_admin', 'admin', 'admin', 1785000000);
INSERT INTO users (id, name, username, created_at) VALUES ('u_bob', 'bob', 'bob', 1785000001);
INSERT INTO users (id, name, username, created_at) VALUES ('u_old', 'olga', 'olga', 1785000002);
INSERT INTO old_cookie_accounts (user_id) VALUES ('u_old');
INSERT INTO fx_rates (base, quote, rate, fetched_at, next_at) VALUES ('USD', 'PEN', 3.4567, 1785000003, 4102444800);
INSERT INTO fx_rates (base, quote, rate, fetched_at, next_at) VALUES ('USD', 'EUR', 0.9123, 1785000003, 4102444800);
INSERT INTO fx_rates (base, quote, rate, fetched_at, next_at) VALUES ('USD', 'JPY', 151.25, 1785000003, 4102444800);
INSERT INTO fx_rates (base, quote, rate, fetched_at, next_at) VALUES ('USD', 'GBP', 0.7812, 1785000003, 4102444800);
`;

/** The object the scenario reads back out of the TILES bucket: 100,000 bytes, known. */
export function tileBytes() {
  const b = Buffer.alloc(100000);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}
// Under fonts/, which /tiles/fonts/* serves: the range server those steps hold is the same one the
// trip's own map (/api/trips/<trip>/tiles) and the label fonts go through.
export const TILE_KEY = "fonts/parity/test.pmtiles";
export const TILE_JSON_KEY = "fonts/parity/style.json";
export const tileJson = () => Buffer.from(JSON.stringify({ version: 8, name: "parity" }));

const T0 = 1785542400;            // 2026-08-01 00:00 UTC
const TRIP_ID = "parity-trip";
/** The trip's address: everything in it is under this. */
const TRIP = `/api/trips/${TRIP_ID}`;
const newTrip = () => ({ id: TRIP_ID, name: "Parity", starts_on: "2026-08-01", ends_on: "2026-08-05", default_tz: "America/Lima" });

/** What the scenario fills its trip with, through the routes that write each thing. */
const AREAS = [
  { id: "centro", name: "Centro", sort: 1, west: -77.06, south: -12.07, east: -77.02, north: -12.03 },
  { id: "barranco", name: "Barranco", parent: "centro", sort: 2 },
  { id: "norte", name: "Norte", sort: 3, west: -77.02, south: -12.02, east: -76.98, north: -11.98 },
];
const PLACES = [
  { id: "p-hotel", name: "Hotel Parity", kind: "lodging", subkind: "hotel", area: "centro", address: "Calle 1",
    lat: -12.05, lng: -77.04, is_anchor: true, why: "Where everyone sleeps.", confidence: "high", elevation_m: 155,
    checkout: [{ title: "Leave the key", detail: "At the desk." }] },
  { id: "p-cafe", name: "Café Uno", name_local: "Café Uno", kind: "food", subkind: "cafe", area: "barranco", why: "Breakfast.",
    lat: -12.051, lng: -77.041, tags: ["coffee", "breakfast"], near_anchor: "p-hotel", walk_minutes: 4 },
  { id: "p-station", name: "Estación", kind: "transit", subkind: "train_station", area: "norte", lat: -12.0, lng: -77.0, why: "The train north." },
  { id: "p-museum", name: "Museo", kind: "sight", subkind: "museum", area: "norte", tags: ["art"], why: "The collection.",
    rating: 4.6, rating_count: 1200, price_level: 2, hours: "Tue-Sun 10:00-18:00", phone: "+51 1 000 0000",
    website: "https://example.org/museo", notes: "Closed Mondays." },
];
const EVENTS = [
  { id: "e-flight", title: "Flight in", kind: "flight", starts_at: T0 + 6 * 3600, ends_at: T0 + 11 * 3600,
    tz: "America/New_York", end_tz: "America/Lima", detail: "Seat 12A", url: "https://example.org/flight" },
  { id: "e-checkin", title: "Check in", kind: "lodging", starts_at: T0 + 8 * 3600, tz: "America/Lima", place_id: "p-hotel" },
  { id: "e-lunch", title: "Lunch", kind: "meal", starts_at: T0 + 12 * 3600, ends_at: T0 + 13 * 3600, tz: "America/Lima", place_id: "p-cafe" },
  { id: "e-trek", title: "Trek day", kind: "activity", starts_at: T0 + 86400, tz: "America/Lima" },
  { id: "e-allday", title: "Free day", kind: "plan", starts_at: T0 + 2 * 86400, tz: "America/Lima", all_day: true },
];

export async function scenario(t) {
  const HTML = { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
  const ANY = { Accept: "*/*" };
  const call = (name, as, method, path, extra = {}) => t.call(name, { as, method, path, ...extra });
  const post = (name, as, path, json, extra = {}) => t.call(name, { as, method: "POST", path, json, ...extra });
  const patch = (name, as, path, json, extra = {}) => t.call(name, { as, method: "PATCH", path, json, ...extra });
  const put = (name, as, path, json, extra = {}) => t.call(name, { as, method: "PUT", path, json, ...extra });
  const del = (name, as, path, extra = {}) => t.call(name, { as, method: "DELETE", path, ...extra });
  const get = (name, as, path, extra = {}) => t.call(name, { as, method: "GET", path, ...extra });
  // What a browser puts on a request one of this site's own pages sends.
  const OURS = { Origin: t.origin };
  const FORM = "application/x-www-form-urlencoded";

  // ═══ 1. Signed out: the gate ═════════════════════════════════════════════════════════════
  await get("gate / as a page", "anon", "/", { headers: HTML });
  await get("gate / as a fetch", "anon", "/", { headers: ANY });
  await get("gate / no accept", "anon", "/");
  await get("gate /index.html as a page", "anon", "/index.html", { headers: HTML });
  await get("gate /login", "anon", "/login", { headers: HTML, staticAsset: true });
  await get("gate /login.html", "anon", "/login.html", { headers: HTML, staticAsset: true });
  await get("gate /login/", "anon", "/login/", { headers: HTML, staticAsset: true });
  await get("gate /login?next", "anon", "/login?next=%2Faccount", { headers: HTML, staticAsset: true });
  await get("gate /login.html?next", "anon", "/login.html?next=%2Faccount", { headers: HTML, staticAsset: true });
  await get("gate /login/new", "anon", "/login/new", { headers: HTML, staticAsset: true });
  await get("gate /login/link/<token>", "anon", `/login/link/${"a".repeat(43)}`, { headers: HTML, staticAsset: true });
  await get("gate /login/link short token", "anon", "/login/link/abc", { headers: HTML });
  await get("gate /login/google GET", "anon", "/login/google", { headers: HTML });
  await call("gate /login/google POST, not set up", "anon", "POST", "/login/google", { headers: OURS, body: "next=%2F", type: FORM });
  await call("gate /login/google POST from elsewhere", "anon", "POST", "/login/google", { headers: { Origin: "https://example.org" }, body: "next=%2F", type: FORM });
  await get("gate /login/google/callback, nothing started", "anon", "/login/google/callback?code=x&state=y", { headers: HTML });
  await get("gate /login/nope", "anon", "/login/nope", { headers: HTML });
  await get("gate /account as a page", "anon", "/account", { headers: HTML });
  await get("gate /account as a fetch", "anon", "/account", { headers: ANY });
  await get("gate /js/account.js", "anon", "/js/account.js", { headers: ANY });
  await get("gate /css/account.css", "anon", "/css/account.css", { staticAsset: true });
  await get("gate /img/marks/google-g.png", "anon", "/img/marks/google-g.png", { staticAsset: true });
  await get("gate /img/marks/, any other file", "anon", "/img/marks/another.png", { headers: ANY });
  await call("gate HEAD /login", "anon", "HEAD", "/login", { staticAsset: true });
  await call("gate POST /login", "anon", "POST", "/login", { body: "x=1", staticAsset: true });
  await get("gate /LOGIN upper case", "anon", "/LOGIN", { headers: HTML });
  await get("gate /api/me", "anon", "/api/me", { headers: ANY });
  await get("gate /api/trips", "anon", "/api/trips", { headers: ANY });
  await get("gate the trip", "anon", TRIP, { headers: ANY });
  await get("gate the trip as a page", "anon", TRIP, { headers: HTML });
  await get("gate /api/trip, the address from before trips", "anon", "/api/trip", { headers: ANY });
  await get("gate /api", "anon", "/api", { headers: ANY });
  await get("gate /join/<code>", "anon", `/join/${"J".repeat(22)}`, { headers: HTML, staticAsset: true });
  await get("gate /join/ short code", "anon", "/join/abc", { headers: HTML });
  await get("gate /join", "anon", "/join", { headers: HTML, staticAsset: true });
  await get("gate /api/join/<code> never made", "anon", `/api/join/${"J".repeat(22)}`, { headers: ANY });
  await post("gate POST /api/join/<code>", "anon", `/api/join/${"J".repeat(22)}`, {});
  await call("gate PUT /api/join/<code>", "anon", "PUT", `/api/join/${"J".repeat(22)}`, {});
  await post("gate POST /api/events", "anon", `${TRIP}/events`, { title: "x" });
  await get("gate /api/login GET", "anon", "/api/login", { staticAsset: true });
  await post("gate /api/login POST", "anon", "/api/login", { password: "x" }, { staticAsset: true });
  await get("gate /api/auth/nothing GET", "anon", "/api/auth/nothing", { staticAsset: true });
  await post("gate /api/auth/nothing POST", "anon", "/api/auth/nothing", {}, { staticAsset: true });
  await get("gate /api/auth/logout GET", "anon", "/api/auth/logout", { staticAsset: true });
  await get("gate /api/auth/ways", "anon", "/api/auth/ways", { headers: ANY });
  await get("gate /api/account/email", "anon", "/api/account/email", { headers: ANY });
  await get("gate /manifest.webmanifest", "anon", "/manifest.webmanifest", { staticAsset: true });
  await get("gate /sw.js", "anon", "/sw.js", { staticAsset: true });
  await get("gate /styles.css", "anon", "/styles.css", { staticAsset: true });
  await get("gate /js/auth.js", "anon", "/js/auth.js", { staticAsset: true });
  await get("gate /js/store.js", "anon", "/js/store.js", { headers: ANY });
  await get("gate /js/store.js as a page", "anon", "/js/store.js", { headers: HTML });
  await get("gate /favicon.ico", "anon", "/favicon.ico", { staticAsset: true });
  await get("gate /icons/icon-192.png", "anon", "/icons/icon-192.png", { staticAsset: true });
  await get("gate /icons/nope.png", "anon", "/icons/nope.png", { staticAsset: true });
  await get("gate /img/wordmark.svg", "anon", "/img/wordmark.svg", { staticAsset: true });
  await get("gate /textures/cork.jpg", "anon", "/textures/cork.jpg", { staticAsset: true });
  await get("gate /img/demo-card.webp", "anon", "/img/demo-card.webp", { headers: ANY });
  await get("gate /vendor/fonts/inter", "anon", "/vendor/fonts/inter-latin-wght-normal.woff2", { staticAsset: true });
  await get("gate /vendor/fonts/nope", "anon", "/vendor/fonts/nope.woff2", { staticAsset: true });
  await get("gate /vendor/maplibre", "anon", "/vendor/maplibre/maplibre-gl.js", { headers: ANY });
  await get("gate /tiles", "anon", `/tiles/${TILE_KEY}`, { headers: ANY });
  await get("gate /media", "anon", "/media/o/ab/abc/def.jpg", { headers: ANY });
  await get("gate /s/ unknown id", "anon", "/s/0123456789abcdef0123456789abcdef");
  await get("gate /s/ unknown id image", "anon", "/s/0123456789abcdef0123456789abcdef/image");
  await get("gate /s/ unknown id trailing slash", "anon", "/s/0123456789abcdef0123456789abcdef/");
  await get("gate /s/ short id", "anon", "/s/abc", { headers: ANY });
  await get("gate /s/ extra path", "anon", "/s/0123456789abcdef0123456789abcdef/other", { headers: ANY });
  await get("gate /s", "anon", "/s", { headers: ANY });
  // Paths that try to climb out of a public folder.
  await get("gate traversal encoded slash", "anon", "/icons/..%2Fjs%2Fstore.js", { headers: ANY });
  await get("gate traversal encoded dots", "anon", "/icons/%2e%2e/js/store.js", { headers: ANY });
  await get("gate traversal raw dots", "anon", "/icons/../js/store.js", { headers: ANY });
  await get("gate traversal backslash", "anon", "/icons%5C..%5Cjs%5Cstore.js", { headers: ANY });
  await get("gate malformed escape", "anon", "/icons/%E0%A4%A", { headers: ANY });
  await get("gate double slash", "anon", "//login", { headers: HTML, staticAsset: true });
  await call("gate OPTIONS the trip", "anon", "OPTIONS", TRIP, { headers: { Origin: "https://example.org", "Access-Control-Request-Method": "GET" } });

  // ═══ 2. Signed out: the sign-in routes ═══════════════════════════════════════════════════
  await get("auth config", "anon", "/api/auth/config");
  await post("auth login/options empty", "anon", "/api/auth/login/options", {}, { learn: (r) => ({ "challenge-anon-1": r.json().challenge }) });
  await post("auth login/options unknown username", "anon", "/api/auth/login/options", { username: "nobody" });
  await post("auth login/options username with no passkey", "anon", "/api/auth/login/options", { username: " OLGA " });
  await post("auth login/verify no challenge", null, "/api/auth/login/verify", { id: "x" });
  await post("auth register/options no name", null, "/api/auth/register/options", {});
  await post("auth register/options long name", null, "/api/auth/register/options", { name: "x".repeat(41) });
  await post("auth register/options not json", null, "/api/auth/register/options", undefined, { body: "name=carol", type: FORM });
  await post("auth register/verify no challenge", null, "/api/auth/register/verify", {});
  await post("auth passkeys/options signed out", null, "/api/auth/passkeys/options", {});
  await get("auth pending, nothing waiting", "anon", "/api/auth/pending");
  await post("auth pending/create, nothing waiting", "anon", "/api/auth/pending/create", { name: "carol" }, { headers: OURS });
  await post("auth recover, no email here", "anon", "/api/auth/recover", { email: "someone@example.org" }, { headers: OURS });
  await post("auth recover from elsewhere", "anon", "/api/auth/recover", { email: "someone@example.org" }, { headers: { Origin: "https://example.org" } });
  await post("auth recover/confirm, no email here", "anon", "/api/auth/recover/confirm", { id: "x", code: "123456" }, { headers: OURS });
  await post("auth link unknown token", "anon", "/api/auth/link", { token: "a".repeat(43) }, { headers: OURS });
  await post("auth link from elsewhere", "anon", "/api/auth/link", { token: "a".repeat(43) });
  await post("auth logout signed out", null, "/api/auth/logout", undefined);
  await post("auth logout from another site's page", null, "/api/auth/logout", undefined, { headers: { Origin: "https://example.org", "Sec-Fetch-Site": "cross-site" } });
  await call("auth logout, a form from a sibling subdomain", null, "POST", "/api/auth/logout", { headers: { "Sec-Fetch-Site": "same-site" }, body: "x=1", type: FORM });
  await post("auth login/options from another site's page", null, "/api/auth/login/options", {}, { headers: { Origin: "https://example.org" } });
  await call("auth logout PUT", null, "PUT", "/api/auth/logout", { staticAsset: true });

  // ═══ 3. Signed in, before any trip exists ════════════════════════════════════════════════
  await get("empty /api/me admin", "admin", "/api/me");
  await get("empty /api/me bob", "bob", "/api/me");
  // The cookie from before sessions were rows: honored once for an account of that time, by
  // giving the browser a session in its place.
  await get("cookie expired", null, "/api/me", { cookie: t.session("u_old", -60), headers: ANY });
  await get("cookie bad signature", null, "/api/me", { cookie: t.session("u_old", 3600).replace(/.$/, (c) => (c === "0" ? "1" : "0")), headers: ANY });
  await get("cookie unknown user", null, "/api/me", { cookie: t.session("u_nobody", 3600), headers: ANY });
  await get("cookie for an account made since", null, "/api/me", { cookie: t.session("u_admin", 3600), headers: ANY });
  await get("cookie malformed", null, "/api/me", { cookie: "s2=garbage", headers: HTML });
  await get("cookie from before becomes a session", null, "/api/me", { cookie: t.session("u_old", 3600), headers: ANY });
  await get("session cookie unknown", null, "/api/me", { cookie: `wgp_session=${"b".repeat(43)}`, headers: ANY });
  await get("empty /api/trips", "admin", "/api/trips");
  await get("empty the trip", "admin", TRIP);
  await get("empty the trip's rev", "admin", `${TRIP}/rev`);
  for (const p of ["events", "places", "areas", "packing",
    "purchases", "media/config", "media/usage", "memories", "memories/tags", "collage/shares", "members", "links"]) {
    await get(`empty GET ${p}`, "admin", `${TRIP}/${p}`);
  }
  await get("empty GET /api/fx", "admin", "/api/fx");
  // The addresses from before trips, for an account on no trip: nothing is guessed.
  await get("empty /api/trip, the address from before trips", "admin", "/api/trip");
  await get("empty /api/events, the address from before trips", "admin", "/api/events");
  await get("empty /tiles, on no trip", "admin", `/tiles/${TILE_KEY}`);
  await post("empty POST /api/events", "admin", `${TRIP}/events`, { title: "x", starts_at: T0, tz: "UTC" });
  await post("empty POST /api/packing", "admin", `${TRIP}/packing`, { label: "x" });
  await post("empty POST /api/purchases", "admin", `${TRIP}/purchases`, {});
  // (Rates belong to the site, so an account on no trip may ask for them to be fetched again.
  // The one step that does is the scenario's last: what it brings back is the network's.)
  await get("empty /media", "admin", "/media/o/ab/abc/def.jpg");

  // Making a trip.
  await post("trips create no body", "admin", "/api/trips", undefined);
  await post("trips create no name", "admin", "/api/trips", { ...newTrip(), name: " " });
  await post("trips create long name", "admin", "/api/trips", { ...newTrip(), name: "x".repeat(81) });
  await post("trips create bad tz", "admin", "/api/trips", { ...newTrip(), default_tz: "Mars/Olympus" });
  await post("trips create one date", "admin", "/api/trips", { ...newTrip(), ends_on: undefined });
  await post("trips create dates backwards", "admin", "/api/trips", { ...newTrip(), starts_on: "2026-08-05", ends_on: "2026-08-01" });
  await post("trips create bad currencies", "admin", "/api/trips", { ...newTrip(), currencies: ["soles"] });
  await post("trips create bad id", "admin", "/api/trips", { ...newTrip(), id: "bad id!" });
  await post("trips create", "admin", "/api/trips", newTrip(), { learn: (r) => ({ "collage-seed": r.json().trip.collage_seed }) });
  await post("trips create replay", "admin", "/api/trips", newTrip());
  await post("trips create same id, someone else", "bob", "/api/trips", newTrip());
  await get("trips list", "admin", "/api/trips");
  await put("trips PUT", "admin", "/api/trips", {});
  await get("trips trailing slash", "admin", "/api/trips/");

  // Filling the trip: its areas, places and events, through the routes that write each.
  await put("fill areas, bob not on the trip", "bob", `${TRIP}/areas`, { areas: AREAS });
  await put("fill areas", "admin", `${TRIP}/areas`, { areas: AREAS });
  await put("fill places", "admin", `${TRIP}/places`, { places: PLACES });
  for (const e of EVENTS) await post(`fill event ${e.id}`, "admin", `${TRIP}/events`, e);
  // There is no import any more.
  await post("import gone", "admin", `${TRIP}/import`, { places: [], events: [] });
  await get("import GET gone", "admin", `${TRIP}/import`);

  // ═══ 4. The trip ═════════════════════════════════════════════════════════════════════════
  await get("trip admin first", "admin", TRIP);
  // Reading a trip puts nobody on it: someone who isn't on it is told there is no such trip.
  await get("trip bob, not on it", "bob", TRIP);
  await get("trip bob, not on it: its rev", "bob", `${TRIP}/rev`);
  await post("trip bob, not on it: a write", "bob", `${TRIP}/events`, { title: "x", starts_at: T0, tz: "UTC" });

  // Links, and joining by one.
  await post("links bad days", "admin", `${TRIP}/links`, { days: 31 });
  await post("links bad uses", "admin", `${TRIP}/links`, { uses: 0 });
  const made = await post("links create", "admin", `${TRIP}/links`, { days: 3, uses: 2 },
    { learn: (r) => ({ "link-code-1": r.json().link.code, "link-1": r.json().link.id }) });
  const code1 = made.json().link.code;
  await get("links list", "admin", `${TRIP}/links`);
  await get("join view", "anon", `/api/join/${code1}`);
  await get("join view signed in", "bob", `/api/join/${code1}`);
  await post("join signed out", "anon", `/api/join/${code1}`, {});
  await post("join from another site's page", "bob", `/api/join/${code1}`, {}, { headers: { Origin: "https://example.org" } });
  await t.tick(); // the roster sorts on joined_at
  await post("join bob", "bob", `/api/join/${code1}`, {});
  await post("join bob again", "bob", `/api/join/${code1}`, {});
  await post("join the host, already on it", "admin", `/api/join/${code1}`, {});
  await get("join page", "bob", `/join/${code1}`, { headers: HTML, staticAsset: true });
  await t.tick(); // links list newest first, by created_at
  const second = await post("links create as a member", "bob", `${TRIP}/links`, {}, { learn: (r) => ({ "link-code-2": r.json().link.code, "link-2": r.json().link.id }) });
  const code2 = second.json().link.code, link2 = second.json().link.id;
  await get("links list, two", "bob", `${TRIP}/links`);
  await del("links revoke as a member", "bob", `${TRIP}/links/${link2}`);
  await del("links revoke", "admin", `${TRIP}/links/${link2}`);
  await del("links revoke again", "admin", `${TRIP}/links/${link2}`);
  await del("links revoke unknown", "admin", `${TRIP}/links/nope`);
  await get("join view revoked", "anon", `/api/join/${code2}`);
  await post("join revoked", "bob", `/api/join/${code2}`, {});
  await post("join malformed code", "bob", "/api/join/short", {});
  await get("links GET by id", "admin", `${TRIP}/links/${link2}`);

  // The people on it.
  await get("members", "bob", `${TRIP}/members`);
  await get("people, a member", "bob", `${TRIP}/people`);
  await get("people, the host", "admin", `${TRIP}/people`);
  await get("people page", "bob", "/trips/parity-trip", { headers: HTML, staticAsset: true });
  await get("app at a trip", "bob", "/t/parity-trip/", { headers: HTML, staticAsset: true });
  await get("app at a trip, no last slash", "bob", "/t/parity-trip?from=list", { headers: HTML });
  await del("members remove, not the host", "bob", `${TRIP}/members/u_admin`);
  await del("members the host can't leave", "admin", `${TRIP}/members/u_admin`);
  await del("members remove someone never on it", "admin", `${TRIP}/members/u_old`);
  // A guest's way back (src/accounts/guests.js): refused for an account, for someone not on it, and to anyone but the host.
  await post("rejoin link, not the host", "bob", `${TRIP}/members/u_admin/rejoin`, {});
  await post("rejoin link for an account", "admin", `${TRIP}/members/u_bob/rejoin`, {});
  await post("rejoin link for someone never on it", "admin", `${TRIP}/members/u_old/rejoin`, {});
  await post("members POST", "admin", `${TRIP}/members`, {});
  await post("host, not the host", "bob", `${TRIP}/host`, { to: "u_bob" });
  await post("host to nobody", "admin", `${TRIP}/host`, {});
  await post("host to themselves", "admin", `${TRIP}/host`, { to: "u_admin" });
  await post("host to someone not on it", "admin", `${TRIP}/host`, { to: "u_old" });
  // Handing the trip over is an offer the other person accepts.
  await post("host offered", "admin", `${TRIP}/host`, { to: "u_bob" });
  await get("trips list with an offer", "bob", "/api/trips");
  await post("host accept, not offered it", "admin", `${TRIP}/host/accept`, {});
  await post("host decline", "bob", `${TRIP}/host/decline`, {});
  await post("host decline, no offer", "bob", `${TRIP}/host/decline`, {});
  await post("host offered again", "admin", `${TRIP}/host`, { to: "u_bob" });
  await del("host offer taken back", "admin", `${TRIP}/host`);
  await del("host offer taken back, none", "admin", `${TRIP}/host`);
  await del("host take back, not the host", "bob", `${TRIP}/host`);
  await post("host offered a third time", "admin", `${TRIP}/host`, { to: "u_bob" });
  await post("host handed over", "bob", `${TRIP}/host/accept`, {});
  await get("trips list after handing over", "admin", "/api/trips");
  await post("host offered back", "bob", `${TRIP}/host`, { to: "u_admin" });
  await post("host handed back", "admin", `${TRIP}/host/accept`, {});
  await get("host GET", "admin", `${TRIP}/host`);
  // The meter of the trips an account hosts, and the trip's own map (this trip has none).
  await get("storage meter, the host", "admin", "/api/account/storage");
  await get("storage meter, someone who hosts nothing", "bob", "/api/account/storage");
  await get("tiles of the trip, none", "bob", `${TRIP}/tiles`);
  await call("tiles of the trip, POST", "bob", "POST", `${TRIP}/tiles`, {});
  // The map's two routes, on a site without a map maker (check:map has one): the host's cut is
  // "maps off"; someone else's refused; a map upload that isn't there refused.
  await post("tiles cut again, not the host", "bob", `${TRIP}/tiles/cut`, {});
  await post("tiles cut again, no map maker", "admin", `${TRIP}/tiles/cut`, {});
  await post("tiles use an upload that isn't there", "admin", `${TRIP}/tiles/use`, { key: "o/ab/nothing/x.pmtiles" });
  await post("tiles use, not the host", "bob", `${TRIP}/tiles/use`, { key: "o/ab/nothing/x.pmtiles" });
  // A map planned for areas as they'd be (any member): "maps off" here; check:map plans one for real.
  await post("tiles plan, no map maker", "bob", `${TRIP}/tiles/plan`, { areas: [{ name: "Lima", west: -77.2, south: -12.2, east: -76.9, north: -11.9 }] });
  // The changes an AI made (src/trips/changes.js): none on this trip.
  await get("changes, none yet", "bob", `${TRIP}/changes`);
  await post("changes undo, no such change", "bob", `${TRIP}/changes/no-such-change/undo`, {});
  await del("changes clear, not the host", "bob", `${TRIP}/changes`);
  await del("changes clear, the host", "admin", `${TRIP}/changes`);
  // An account's connected AI apps (src/accounts/apps.js): none.
  await get("connected apps, none", "bob", "/api/account/apps");
  await del("connected apps, disconnecting one that isn't there", "bob", "/api/account/apps/no-such-grant");
  await get("connected apps, signed out", "anon", "/api/account/apps");
  // What broke: a page's report (anyone), and the owner's page and list, absent for everyone ADMIN_ACCOUNTS doesn't name.
  const REPORT = { kind: "error", name: "TypeError", message: "x is not a function", stack: "TypeError: x\n    at go (https://wegoplace.com/js/agenda.js:12:3)", place: "/t/parity/#/e/ev-1", version: "v99" };
  await post("error report, signed out", "anon", "/api/errors", REPORT, { headers: OURS });
  await post("error report, signed in", "bob", "/api/errors", REPORT);
  await post("error report, not JSON", "anon", "/api/errors", "not json", { headers: OURS });
  await post("error report, from elsewhere", "anon", "/api/errors", REPORT);
  await get("owner's page of errors, someone else", "bob", "/admin/errors", { headers: HTML });
  await get("owner's page of errors, signed out", "anon", "/admin/errors", { headers: HTML });
  await get("owner's list of errors, someone else", "bob", "/api/admin/errors");
  await post("owner's clear, someone else", "bob", "/api/admin/errors/clear", { fingerprints: ["x"] });
  // A bug report (src/bug-reports.js): a form, signed out (no account) and signed in (theirs), answered the same; one that
  // isn't a form; a screenshot that isn't theirs; the operator's reads, absent for everyone ADMIN_ACCOUNTS doesn't name.
  const BUG_FORM = ["--parityform", 'Content-Disposition: form-data; name="text"', "", "The total doesn't update.", "--parityform",
    'Content-Disposition: form-data; name="context"', "", JSON.stringify({ screen: "/t/parity/#/split", version: "v99", device: "phone" }), "--parityform--", ""].join("\r\n");
  const MULTIPART = "multipart/form-data; boundary=parityform";
  await call("bug report, signed out", "anon", "POST", "/api/bug-reports", { headers: OURS, body: BUG_FORM, type: MULTIPART });
  await call("bug report, signed in", "bob", "POST", "/api/bug-reports", { headers: OURS, body: BUG_FORM, type: MULTIPART });
  await post("bug report, not a form", "bob", "/api/bug-reports", { text: "As JSON." });
  await get("bug report's screenshot, not theirs", "bob", "/api/account/bug-reports/0123456789abcdef/screenshot");
  await get("operator's bug reports, someone else", "bob", "/api/admin/bug-reports");
  await get("operator's bug report, someone else", "bob", "/api/admin/bug-reports/0123456789abcdef");
  // Notifications (src/push/): this server has no push keys, so "push off"; check:push sends for real.
  await get("push key, no keys here", "bob", "/api/account/push");
  await put("push subscription, no keys here", "bob", "/api/account/push", { endpoint: "https://fcm.googleapis.com/fcm/send/parity", keys: { p256dh: "x", auth: "y" } });
  await del("push subscription, one that isn't there", "bob", "/api/account/push", { json: { endpoint: "https://fcm.googleapis.com/fcm/send/parity" } });
  await get("push key, signed out", "anon", "/api/account/push");
  // The plan (src/billing/): this site doesn't offer it, so each answers 404 in words; Stripe's
  // webhook (outside the gate) the same, whatever it is sent.
  await get("plan, not offered", "bob", "/api/account/plan");
  await post("plan checkout, not offered", "bob", "/api/account/plan/checkout", { interval: "monthly" });
  await post("plan portal, not offered", "bob", "/api/account/plan/portal", {});
  await post("stripe webhook, not offered", "anon", "/api/billing/stripe", { id: "evt_x", type: "invoice.paid" });
  // The assistant (src/assistant/talk.js): this site doesn't offer it. Its page says so; making a conversation is
  // refused in words; one that isn't there is the answer for none; signed out, the trip's own answer.
  await get("account export", "admin", "/api/account/export");
  await get("account export, signed out", "anon", "/api/account/export");
  await get("assistant, not offered", "admin", `${TRIP}/assistant`);
  await post("assistant conversation, not offered", "admin", `${TRIP}/assistant/conversations`, { id: "conv-1" });
  await get("assistant conversation, none", "admin", `${TRIP}/assistant/conversations/conv-1`);
  await del("assistant conversation delete, none", "admin", `${TRIP}/assistant/conversations/conv-1`);
  await post("assistant ask, none", "admin", `${TRIP}/assistant/conversations/conv-1/ask`, { id: "ask-1", words: "Hello" });
  await post("assistant share, none", "admin", `${TRIP}/assistant/conversations/conv-1/share`, { id: "share-1", turn: "ask-1.answer" });
  // The documents given the assistant (src/assistant/files.js): on a conversation that isn't there, each as if none.
  await post("assistant file upload, none", "admin", `${TRIP}/assistant/conversations/conv-1/files`, {});
  await get("assistant files, none", "admin", `${TRIP}/assistant/conversations/conv-1/files`);
  await get("assistant file original, none", "admin", `${TRIP}/assistant/conversations/conv-1/files/file-1`);
  await del("assistant file delete, none", "admin", `${TRIP}/assistant/conversations/conv-1/files/file-1`);
  await get("assistant, signed out", "anon", `${TRIP}/assistant`);
  await put("assistant off, not offered", "admin", `${TRIP}/assistant/off`, { off: true });
  // Connecting an app (src/mcp/oauth.js), asked with nothing an app sends: its page says so.
  await get("authorize page, no request", "bob", "/authorize", { headers: { Accept: "text/html" } });
  await post("authorize answer, not the page's", "bob", "/authorize", { decision: "approve" });

  // The trip itself.
  await get("trip bob first", "bob", TRIP);
  await get("trip admin second", "admin", TRIP);
  await get("trip rev", "bob", `${TRIP}/rev`);
  // The trip's live socket, asked for as a page: only a socket (check:live opens it as one).
  await get("trip live, not a socket", "bob", `${TRIP}/live`);
  await patch("trip patch nothing", "admin", TRIP, {});
  await patch("trip patch bad dates", "admin", TRIP, { ends_on: "2026-07-01" });
  await patch("trip patch bad name", "bob", TRIP, { name: "" });
  await patch("trip patch", "bob", TRIP, { name: " Parity  trip ", currencies: ["pen", "USD"] });
  await patch("trip patch back", "admin", TRIP, { name: "Parity", currencies: [] });
  await patch("trip patch interests", "bob", TRIP, { interests: "  Four friends. Coffee first.  " });
  await patch("trip patch interests too long", "bob", TRIP, { interests: "x".repeat(4001) });
  await patch("trip patch dates that leave events outside", "admin", TRIP, { ends_on: "2026-08-01" });
  await patch("trip patch dates cleared with events", "admin", TRIP, { starts_on: null, ends_on: null });
  await call("trip HEAD", "admin", "HEAD", TRIP);
  await post("trip POST", "admin", TRIP, {});
  await del("trip DELETE", "admin", TRIP);
  await get("trip trailing slash", "admin", `${TRIP}/`);
  await get("trip upper case", "admin", TRIP.toUpperCase());
  await get("trip with query", "admin", `${TRIP}?x=1`);
  await get("trip/nope", "admin", `${TRIP}/nope`);
  await get("trip unknown id", "admin", "/api/trips/no-such-trip");
  for (const p of ["events", "places", "areas", "packing",
    "purchases", "media/config", "media/usage", "memories", "memories/tags", "collage/shares"]) {
    await get(`trip GET ${p} admin`, "admin", `${TRIP}/${p}`);
    await get(`trip GET ${p} bob`, "bob", `${TRIP}/${p}`);
  }
  await get("trip GET /api/fx admin", "admin", "/api/fx");
  await get("trip GET /api/fx bob", "bob", "/api/fx");
  await put("places as a member", "bob", `${TRIP}/places`, { places: [{ id: "p-museum", notes: "Closed Mondays and holidays." }] });

  // Bob makes a trip of his own, so he is on two.
  const minted = await post("trips create minted id", "bob", "/api/trips", { name: "Bob's own", default_tz: "UTC" },
    { learn: (r) => ({ "trip-minted": r.json().trip.id, "collage-seed-2": r.json().trip.collage_seed }) });
  await get("trips list, two", "bob", "/api/trips");
  // Deleting a trip: its name typed, or nothing goes.
  const bobsTrip = minted.json().trip.id;
  await del("trip delete, its name not typed", "bob", `/api/trips/${bobsTrip}`, { json: { confirm: "Bob's" } });
  await del("trip delete", "bob", `/api/trips/${bobsTrip}`, { json: { confirm: " Bob's own " } });
  await get("trip after it was deleted", "bob", `/api/trips/${bobsTrip}`);
  await get("trips list after deleting one", "bob", "/api/trips");

  // /api/me
  await patch("me nothing", "admin", "/api/me", {});
  await patch("me bad colour", "admin", "/api/me", { note_color: "#FF0000" });
  await patch("me colour", "admin", "/api/me", { note_color: "#009E73" });
  await patch("me initials", "admin", "/api/me", { initials: "zq" });
  await patch("me bad initials", "admin", "/api/me", { initials: "four" });
  await patch("me clear initials", "admin", "/api/me", { initials: null });
  await patch("me currency", "bob", "/api/me", { native_currency: "eur" });
  await patch("me bad currency", "bob", "/api/me", { native_currency: "EURO" });
  await patch("me tabs", "bob", "/api/me", { tab_layout: ["agenda", "split", "pack"] });
  await patch("me tabs as text", "bob", "/api/me", { tab_layout: "[\"agenda\",\"map\"]" });
  await patch("me bad tabs", "bob", "/api/me", { tab_layout: ["Not Valid"] });
  await patch("me clear tabs", "bob", "/api/me", { tab_layout: null });
  await patch("me all four", "admin", "/api/me", { note_color: "#0072B2", initials: "AD", native_currency: "USD", tab_layout: ["agenda"] });
  await patch("me units", "bob", "/api/me", { units: "imperial" });
  await patch("me bad units", "bob", "/api/me", { units: "cubits" });
  await patch("me units back to the phone's", "bob", "/api/me", { units: null });
  await get("me after", "admin", "/api/me");
  await post("me POST", "admin", "/api/me", {}, { staticAsset: true });
  await del("me DELETE", "admin", "/api/me", { staticAsset: true });
  await patch("me/x PATCH", "admin", "/api/me/u_bob", { note_color: "#009E73" }, { staticAsset: true });

  // Events.
  const ev = { id: "ev-a1", title: "  Dinner  ", starts_at: T0 + 20 * 3600, tz: "America/Lima", kind: "meal", place_id: "p-cafe", detail: "Table for four", url: "https://example.org/dinner" };
  await post("events create", "admin", `${TRIP}/events`, ev);
  await post("events replay", "admin", `${TRIP}/events`, ev);
  await post("events same id, someone else", "bob", `${TRIP}/events`, ev);
  await post("events same id as a seeded one", "admin", `${TRIP}/events`, { ...ev, id: "e-lunch" });
  await post("events no title", "admin", `${TRIP}/events`, { ...ev, id: "ev-x", title: " " });
  await post("events milliseconds", "admin", `${TRIP}/events`, { ...ev, id: "ev-x", starts_at: 1785542400000 });
  await post("events bad tz", "admin", `${TRIP}/events`, { ...ev, id: "ev-x", tz: "Lima" });
  await post("events bad end_tz", "admin", `${TRIP}/events`, { ...ev, id: "ev-x", end_tz: "Nope" });
  await post("events bad kind", "admin", `${TRIP}/events`, { ...ev, id: "ev-x", kind: "party" });
  await post("events bad url", "admin", `${TRIP}/events`, { ...ev, id: "ev-x", url: "javascript:alert(1)" });
  await post("events unknown place", "admin", `${TRIP}/events`, { ...ev, id: "ev-x", place_id: "p_nowhere" });
  await post("events ends before start", "admin", `${TRIP}/events`, { ...ev, id: "ev-x", ends_at: T0 });
  await post("events bad ends_at", "admin", `${TRIP}/events`, { ...ev, id: "ev-x", ends_at: "later" });
  await post("events bad id", "admin", `${TRIP}/events`, { ...ev, id: "bad id!" });
  await post("events not json", "admin", `${TRIP}/events`, undefined, { body: "title=x", type: "text/plain" });
  await post("events a day after the trip", "admin", `${TRIP}/events`, { ...ev, id: "ev-x", starts_at: T0 + 6 * 86400 });
  await post("events the wrong year", "admin", `${TRIP}/events`, { ...ev, id: "ev-x", starts_at: T0 - 365 * 86400 });
  await post("events the next day in its own zone", "admin", `${TRIP}/events`, { ...ev, id: "ev-x", starts_at: T0 + 4 * 86400 + 20 * 3600, tz: "Asia/Tokyo" });
  await post("events an id with a capital", "admin", `${TRIP}/events`, { ...ev, id: "Ev-1" });
  await post("events minted id", "bob", `${TRIP}/events`, { title: "Bob's thing", starts_at: T0 + 30 * 3600, tz: "America/Lima", end_tz: "", ends_at: null, all_day: 1 },
    { learn: (r) => ({ "event-minted": r.json().event.id }) });
  await patch("events patch own", "admin", `${TRIP}/events/ev-a1`, { title: "Late dinner", ends_at: T0 + 22 * 3600, end_tz: "America/Bogota" });
  await patch("events patch nothing", "admin", `${TRIP}/events/ev-a1`, {});
  await patch("events patch ends before start", "admin", `${TRIP}/events/ev-a1`, { ends_at: T0 });
  await patch("events patch clear", "admin", `${TRIP}/events/ev-a1`, { ends_at: null, end_tz: null, place_id: null });
  await patch("events patch seeded", "admin", `${TRIP}/events/e-lunch`, { title: "Brunch" });
  await patch("events patch someone else's", "bob", `${TRIP}/events/ev-a1`, { title: "Mine now", source: "bob's notes" });
  await patch("events patch off the trip's days", "bob", `${TRIP}/events/ev-a1`, { starts_at: T0 + 10 * 86400 });
  await patch("events patch missing", "admin", `${TRIP}/events/ev-nope`, { title: "x" });
  await patch("events patch encoded id", "admin", `${TRIP}/events/ev%2Da1`, { title: "x" });
  await get("events GET by id", "admin", `${TRIP}/events/ev-a1`, { staticAsset: true });
  // The batch (the MCP's put_events and remove_events): one write, a refused row refusing all.
  await put("events PUT, no events", "admin", `${TRIP}/events`, {});
  await put("events batch: one added, one changed", "bob", `${TRIP}/events`, { events: [
    { id: "ev-b1", title: "Museum", kind: "activity", starts_at: T0 + 4 * 3600, tz: "America/Lima" },
    { id: "ev-a1", detail: "Changed in a batch." },
  ] });
  await put("events batch: a refused row writes nothing", "admin", `${TRIP}/events`, { events: [
    { id: "ev-b2", title: "x", starts_at: T0 + 5 * 3600, tz: "America/Lima" },
    { id: "ev-b3", title: "x", starts_at: T0 + 5 * 3600, tz: "America/Lima", place_id: "no-such-place" },
  ] });
  await del("events batch delete, one there and one not", "admin", `${TRIP}/events`, { json: { ids: ["ev-b1", "ev-nope"] } });
  await patch("events PATCH no id", "admin", `${TRIP}/events`, { title: "x" }, { staticAsset: true });
  await get("events trailing slash", "admin", `${TRIP}/events/`);
  await get("events upper case", "admin", "/API/EVENTS");
  await patch("events two segments", "admin", `${TRIP}/events/a/b`, { title: "x" }, { staticAsset: true });
  await get("events list", "bob", `${TRIP}/events`);

  // Notes on plans are messages about them (migration 0027): the notes' own address is gone, and a
  // note is written as a message about the plan, or about the time before it (what a gap note was).
  await get("notes address gone", "admin", `${TRIP}/notes`);
  await post("notes address gone, a write", "bob", `${TRIP}/notes`, { id: "n_b1", event_id: "e-lunch", body: "Running late" });
  await post("note as a message about the time before a plan", "admin", `${TRIP}/messages`, { id: "n_a1", body: "Bag drop first", about: { kind: "event", id: "e-checkin", part: "before" } });
  await t.tick();
  await post("note as a message about a plan", "admin", `${TRIP}/messages`, { id: "n_a2", body: "On my own event", about: { kind: "event", id: "ev-a1" } });

  // The chat (model §17): the server's order, about a thing, a replay, the edits and deletes, the mute.
  const M = `${TRIP}/messages`;
  await post("chat a message", "bob", M, { id: "m-b1", body: "Who has the tickets?" });
  await post("chat about an event", "admin", M, { id: "m-a1", body: "Booked for two", about: { kind: "event", id: "e-lunch" } });
  await post("chat about the time before an event", "admin", M, { id: "m-a2", body: "Bag drop first", about: { kind: "event", id: "e-checkin", part: "before" } });
  await post("chat about a place", "bob", M, { id: "m-b2", body: "Closed Mondays", about: { kind: "place", id: "p-museum" } });
  await post("chat replay", "bob", M, { id: "m-b1", body: "Who has the tickets?" });
  await post("chat same id, someone else", "admin", M, { id: "m-b1", body: "x" });
  await post("chat about nothing there", "bob", M, { id: "m-x1", body: "x", about: { kind: "event", id: "e_nope" } });
  await post("chat about a wall", "bob", M, { id: "m-x2", body: "x", about: { kind: "wall", id: "w" } });
  await post("chat before a place", "bob", M, { id: "m-x3", body: "x", about: { kind: "place", id: "p-museum", part: "before" } });
  await post("chat no words", "bob", M, { id: "m-x4", body: "   " });
  await post("chat bad id", "bob", M, { id: "no spaces", body: "x" });
  await get("chat newest", "bob", M);
  await get("chat before a seq", "bob", `${M}?before=3&limit=1`);
  await get("chat changed after", "admin", `${M}?after=2`);
  await get("chat about the lunch", "bob", `${M}?about=event:e-lunch`);
  await get("chat bad cursor", "bob", `${M}?before=x`);
  await get("chat both cursors", "bob", `${M}?before=3&after=1`);
  await patch("chat edit own", "bob", `${M}/m-b1`, { body: "Who has the train tickets?" });
  await patch("chat edit someone else's", "admin", `${M}/m-b1`, { body: "x" });
  await del("chat delete someone else's, not the host", "bob", `${M}/m-a1`);
  await del("chat delete as the host", "admin", `${M}/m-b2`);
  await del("chat delete own", "bob", `${M}/m-b1`);
  await del("chat delete again", "bob", `${M}/m-b1`);
  await patch("chat edit a deleted one", "bob", `${M}/m-b1`, { body: "x" });
  await del("chat delete no such", "bob", `${M}/m-none`);
  await get("chat changed after the edits", "bob", `${M}?after=4`);
  await put("chat mute", "bob", `${TRIP}/chat/mute`, { muted: true });
  await put("chat mute not a yes or no", "bob", `${TRIP}/chat/mute`, { muted: "yes" });
  await get("chat the rev, data_rev and seq", "bob", `${TRIP}/rev`);

  // Deleting an event takes its notes with it.
  await del("events delete someone else's", "bob", `${TRIP}/events/ev-a1`);
  await del("events delete own", "admin", `${TRIP}/events/ev-a1`);
  await del("events delete gone", "admin", `${TRIP}/events/ev-a1`);
  await del("events delete seeded", "admin", `${TRIP}/events/e-allday`);
  await get("messages about a removed plan", "admin", `${TRIP}/messages?about=event:ev-a1`);

  // Areas: any member writes them.
  await get("areas list", "bob", `${TRIP}/areas`);
  await put("areas bad id", "admin", `${TRIP}/areas`, { areas: [{ id: "Old-town", name: "Old town" }] });
  await put("areas third level", "admin", `${TRIP}/areas`, { areas: [{ id: "x-1", name: "x", parent: "barranco" }] });
  await put("areas half the bounds", "admin", `${TRIP}/areas`, { areas: [{ id: "x-2", name: "x", west: 1, south: 1 }] });
  await put("areas south above north", "admin", `${TRIP}/areas`, { areas: [{ id: "x-3", name: "x", west: 1, south: 5, east: 2, north: 4 }] });
  await put("areas unknown parent", "admin", `${TRIP}/areas`, { areas: [{ id: "x-4", name: "x", parent: "nowhere" }] });
  await put("areas not a list", "admin", `${TRIP}/areas`, { areas: "centro" });
  await put("areas across the 180 line", "bob", `${TRIP}/areas`, { areas: [{ id: "islands", name: "Islands", west: 177, south: -20, east: -178, north: -15 }] });
  await put("areas bounds that leave a place outside", "admin", `${TRIP}/areas`, { areas: [{ id: "norte", west: -76.99, east: -76.98 }] });
  await put("areas rename", "bob", `${TRIP}/areas`, { areas: [{ id: "norte", name: "North" }] });
  await del("areas delete in use", "admin", `${TRIP}/areas/centro`);
  await del("areas delete", "admin", `${TRIP}/areas/islands`);
  await del("areas delete gone", "admin", `${TRIP}/areas/islands`);
  await del("areas delete by body", "admin", `${TRIP}/areas`, { json: { ids: ["nowhere"] } });
  await post("areas POST", "admin", `${TRIP}/areas`, {});

  // Places: any member writes them, held to the checks the guides promise.
  const shop = { id: "p-bakery", name: "Panadería", kind: "food", subkind: "bakery", why: "Bread at seven.", area: "centro",
    lat: -12.0505, lng: -77.0405, hours: "Mon-Sat 07:00-13:00", tags: ["cash-only", "open-early"], price_level: 1 };
  await put("places one", "bob", `${TRIP}/places`, { places: [shop] });
  await put("places possible duplicate", "bob", `${TRIP}/places`, { places: [{ id: "p-twin", name: "Café Dos", kind: "food", subkind: "cafe", why: "x", area: "barranco", lat: -12.0511, lng: -77.0411 }] });
  await put("places no why", "admin", `${TRIP}/places`, { places: [{ id: "p-x", name: "x", kind: "food", subkind: "cafe" }] });
  await put("places subkind not on the list", "admin", `${TRIP}/places`, { places: [{ ...shop, id: "p-x", subkind: "gastropub" }] });
  await put("places a word off the list", "admin", `${TRIP}/places`, { places: [{ ...shop, id: "p-x", kind: "lodging", subkind: "airbnb" }] });
  await put("places hours in another spelling", "admin", `${TRIP}/places`, { places: [{ ...shop, id: "p-x", hours: "Mo-Sa 7-13" }] });
  await put("places seven tags", "admin", `${TRIP}/places`, { places: [{ ...shop, id: "p-x", tags: ["a", "b", "c", "d", "e", "f", "g"] }] });
  await put("places a rating alone", "admin", `${TRIP}/places`, { places: [{ ...shop, id: "p-x", rating: 4.5 }] });
  await put("places zero zero", "admin", `${TRIP}/places`, { places: [{ ...shop, id: "p-x", lat: 0, lng: 0 }] });
  await put("places outside its area", "admin", `${TRIP}/places`, { places: [{ ...shop, id: "p-x", area: "norte" }] });
  await put("places unknown area", "admin", `${TRIP}/places`, { places: [{ ...shop, id: "p-x", area: "sur" }] });
  await put("places near nothing", "admin", `${TRIP}/places`, { places: [{ ...shop, id: "p-x", near_anchor: "p-nowhere" }] });
  await put("places checkout on a bakery", "admin", `${TRIP}/places`, { places: [{ ...shop, id: "p-x", checkout: [{ title: "Pay" }] }] });
  await put("places an id with a space", "admin", `${TRIP}/places`, { places: [{ ...shop, id: "p x" }] });
  await put("places one bad row of two", "admin", `${TRIP}/places`, { places: [{ ...shop, id: "p-y" }, { ...shop, id: "p-z", price_level: 9 }] });
  await put("places not a list", "admin", `${TRIP}/places`, { places: shop });
  await put("places too many", "admin", `${TRIP}/places`, { places: Array.from({ length: 201 }, (_, i) => ({ ...shop, id: `p-${i}` })) });
  await put("places change keeps the rest", "admin", `${TRIP}/places`, { places: [{ id: "p-bakery", name: "Panadería Uno" }] });
  await put("places clear a field", "admin", `${TRIP}/places`, { places: [{ id: "p-bakery", hours: null }] });
  await del("places delete in use", "admin", `${TRIP}/places/p-hotel`);
  await del("places delete", "bob", `${TRIP}/places/p-twin`);
  await del("places delete gone", "bob", `${TRIP}/places/p-twin`);
  await del("places delete by body", "admin", `${TRIP}/places`, { json: { ids: ["p-bakery", "p-nowhere"] } });
  await del("places delete nothing named", "admin", `${TRIP}/places`);
  await post("places POST", "admin", `${TRIP}/places`, {}, { staticAsset: true });
  await get("places by id", "admin", `${TRIP}/places/p-hotel`, { staticAsset: true });

  // Packing: the trip's lists and bags, the items in them, ticks, and the suggested items.
  await get("packing owner group", "admin", `${TRIP}/packing?owner=group`);
  await get("packing owner self", "admin", `${TRIP}/packing?owner=u_admin`);
  await get("packing owner other", "admin", `${TRIP}/packing?owner=u_bob`);
  await put("lists set", "admin", `${TRIP}/packing/lists`, { lists: [
    { key: "trek", name: " Trek ", bags: [{ key: "duffel", name: "Duffel" }, { key: "day-pack", name: "Day pack" }] },
    { key: "day-out", name: "Every day out", repeat: "daily", bags: [{ key: "pack", name: "Day pack" }] },
    { key: "boat-day", name: "Boat day", repeat: "daily", dates: ["2026-08-03"], bags: [{ key: "pack", name: "Day pack" }] },
  ] });
  await put("lists rename, as a member", "bob", `${TRIP}/packing/lists`, { lists: [{ key: "trek", name: "The trek" }] });
  await put("lists a bag added, the others left out", "bob", `${TRIP}/packing/lists`, { lists: [{ key: "trek", bags: [{ key: "dry-bag", name: "Dry bag" }] }] });
  await put("lists a bag removed", "admin", `${TRIP}/packing/lists`, { lists: [{ key: "trek", bags: [{ key: "dry-bag", remove: true }] }] });
  await put("lists bad key", "admin", `${TRIP}/packing/lists`, { lists: [{ key: "Trek", name: "x", bags: [{ key: "a", name: "A" }] }] });
  await put("lists no bags", "admin", `${TRIP}/packing/lists`, { lists: [{ key: "x-1", name: "x" }] });
  await put("lists a date outside the trip", "admin", `${TRIP}/packing/lists`, { lists: [{ key: "x-2", name: "x", repeat: "daily", dates: ["2026-09-01"], bags: [{ key: "a", name: "A" }] }] });
  await put("lists dates on a list packed once", "admin", `${TRIP}/packing/lists`, { lists: [{ key: "x-3", name: "x", dates: ["2026-08-02"], bags: [{ key: "a", name: "A" }] }] });
  await put("lists bad repeat", "admin", `${TRIP}/packing/lists`, { lists: [{ key: "x-4", name: "x", repeat: "weekly", bags: [{ key: "a", name: "A" }] }] });
  await put("lists nine bags", "admin", `${TRIP}/packing/lists`, { lists: [{ key: "x-5", name: "x", bags: Array.from({ length: 9 }, (_, i) => ({ key: `b-${i}`, name: `B ${i}` })) }] });
  await put("lists none", "admin", `${TRIP}/packing/lists`, { lists: [] });
  await get("lists GET", "admin", `${TRIP}/packing/lists`, { staticAsset: true });
  await post("packing create placed", "admin", `${TRIP}/packing`, { id: "pk_a1", label: " Rain jacket ", category: "clothes", qty: "1", note: "the blue one", sort: 2, bags: { "leaving-home": "main-bag", trek: "duffel" } });
  await post("packing create group", "bob", `${TRIP}/packing`, { id: "pk_g1", owner: "group", label: "Stove", category: "gear", bags: { trek: "duffel" } });
  await post("packing create minimal", "bob", `${TRIP}/packing`, { id: "pk_b1", label: "Socks" });
  await post("packing replay", "admin", `${TRIP}/packing`, { id: "pk_a1", label: "Rain jacket" });
  await post("packing same id, someone else", "bob", `${TRIP}/packing`, { id: "pk_a1", label: "Mine" });
  await post("packing no label", "admin", `${TRIP}/packing`, { id: "pk_x", label: "" });
  await post("packing bad category", "admin", `${TRIP}/packing`, { id: "pk_x", label: "x", category: "snacks" });
  await post("packing other owner", "admin", `${TRIP}/packing`, { id: "pk_x", label: "x", owner: "u_bob" });
  await post("packing bad id", "admin", `${TRIP}/packing`, { id: "a b", label: "x" });
  await post("packing a list that isn't there", "admin", `${TRIP}/packing`, { id: "pk_x", label: "x", bags: { nowhere: "duffel" } });
  await post("packing a bag that isn't on the list", "admin", `${TRIP}/packing`, { id: "pk_x", label: "x", bags: { trek: "suitcase" } });
  await post("packing bags not an object", "admin", `${TRIP}/packing`, { id: "pk_x", label: "x", bags: ["trek"] });
  await post("packing minted id", "admin", `${TRIP}/packing`, { label: "Passport", category: "documents" }, { learn: (r) => ({ "packing-minted": r.json().item.id }) });
  // The batch (the MCP's put_packing_items): adds and changes in one write.
  await put("packing items batch: one added, one changed, one for the group", "admin", `${TRIP}/packing/items`, { items: [
    { id: "pk_c1", label: "Hat", category: "clothes", bags: { trek: "duffel" } },
    { id: "pk_a1", note: "the blue one, washed" },
    { id: "pk_g2", owner: "group", label: "Cards", category: "misc" },
  ] });
  await put("packing items batch: someone else's list refuses the batch", "admin", `${TRIP}/packing/items`, { items: [
    { id: "pk_c2", label: "x" }, { id: "pk_x2", label: "x", owner: "u_bob" },
  ] });
  await patch("packing patch path", "admin", `${TRIP}/packing/pk_a1`, { qty: 2, note: "" });
  await patch("packing patch body id", "admin", `${TRIP}/packing`, { id: "pk_a1", label: "Rain shell", sort: "x" });
  await patch("packing patch ids disagree", "admin", `${TRIP}/packing/pk_a1`, { id: "pk_b1", note: "x" });
  await patch("packing patch no id", "admin", `${TRIP}/packing`, { note: "x" });
  await patch("packing patch missing", "admin", `${TRIP}/packing/pk_nope`, { note: "x" });
  await patch("packing patch blank label", "admin", `${TRIP}/packing/pk_a1`, { label: " " });
  await patch("packing patch bad category", "admin", `${TRIP}/packing/pk_a1`, { category: "x" });
  await patch("packing patch someone else's", "admin", `${TRIP}/packing/pk_b1`, { note: "x" });
  await patch("packing claim group item", "admin", `${TRIP}/packing/pk_g1`, { owner: "u_admin" });
  await patch("packing hand back", "admin", `${TRIP}/packing/pk_g1`, { owner: "group" });
  await patch("packing give to other", "admin", `${TRIP}/packing/pk_g1`, { owner: "u_bob" });
  await patch("packing patch nothing", "admin", `${TRIP}/packing/pk_a1`, {});
  await patch("packing moves to another bag", "admin", `${TRIP}/packing/pk_a1`, { bags: { trek: "day-pack" } });
  await patch("packing onto the day lists", "admin", `${TRIP}/packing/pk_a1`, { bags: { "day-out": "pack", "boat-day": "pack" } });
  await put("ticks a list packed once", "admin", `${TRIP}/packing/ticks`, { item_id: "pk_a1", list_key: "leaving-home", ticked: true });
  await put("ticks the same again", "admin", `${TRIP}/packing/ticks`, { item_id: "pk_a1", list_key: "leaving-home", ticked: true });
  await put("ticks a day on a list packed once", "admin", `${TRIP}/packing/ticks`, { item_id: "pk_a1", list_key: "trek", day: "2026-08-02", ticked: true });
  await put("ticks a day list for a day", "admin", `${TRIP}/packing/ticks`, { item_id: "pk_a1", list_key: "day-out", day: "2026-08-02", ticked: true });
  await put("ticks a day list for the next day", "admin", `${TRIP}/packing/ticks`, { item_id: "pk_a1", list_key: "day-out", day: "2026-08-03", ticked: true });
  await put("ticks a day list without its day", "admin", `${TRIP}/packing/ticks`, { item_id: "pk_a1", list_key: "day-out", ticked: true });
  await put("ticks a day that doesn't exist", "admin", `${TRIP}/packing/ticks`, { item_id: "pk_a1", list_key: "day-out", day: "2026-02-30", ticked: true });
  await put("ticks a day the list doesn't name", "admin", `${TRIP}/packing/ticks`, { item_id: "pk_a1", list_key: "boat-day", day: "2026-08-02", ticked: true });
  await put("ticks a day the list names", "admin", `${TRIP}/packing/ticks`, { item_id: "pk_a1", list_key: "boat-day", day: "2026-08-03", ticked: true });
  await put("ticks not on that list", "bob", `${TRIP}/packing/ticks`, { item_id: "pk_b1", list_key: "trek", ticked: true });
  await put("ticks an unknown list", "admin", `${TRIP}/packing/ticks`, { item_id: "pk_a1", list_key: "nowhere", ticked: true });
  await put("ticks an unknown item", "admin", `${TRIP}/packing/ticks`, { item_id: "pk_nope", list_key: "trek", ticked: true });
  await put("ticks someone else's item", "bob", `${TRIP}/packing/ticks`, { item_id: "pk_a1", list_key: "trek", ticked: true });
  await put("ticks without ticked", "admin", `${TRIP}/packing/ticks`, { item_id: "pk_a1", list_key: "trek" });
  await put("ticks untick", "admin", `${TRIP}/packing/ticks`, { item_id: "pk_a1", list_key: "day-out", day: "2026-08-03", ticked: false });
  await put("lists repeat changed after ticks", "admin", `${TRIP}/packing/lists`, { lists: [{ key: "day-out", repeat: "once" }] });
  await put("lists a bag that holds items removed", "admin", `${TRIP}/packing/lists`, { lists: [{ key: "trek", bags: [{ key: "day-pack", remove: true }] }] });
  await patch("packing off a list, its ticks with it", "admin", `${TRIP}/packing/pk_a1`, { bags: { "day-out": null } });
  await put("starters set", "admin", `${TRIP}/packing/starters`, { starters: [
    { scope: "person", label: "Passport", category: "documents", bags: { "leaving-home": "on-me" }, note: "Valid six months past the trip." },
    { scope: "group", label: "Plug adapters", category: "electronics", bags: { "leaving-home": "main-bag", "boat-day": "pack" }, qty: 2 },
  ] });
  await put("starters a bag not on the list", "admin", `${TRIP}/packing/starters`, { starters: [{ scope: "person", label: "x", category: "gear", bags: { trek: "suitcase" } }] });
  await put("starters bad category", "admin", `${TRIP}/packing/starters`, { starters: [{ scope: "person", label: "x", category: "shoes" }] });
  await put("starters not a list", "admin", `${TRIP}/packing/starters`, { starters: "Passport" });
  // Adding or changing some, the others left as they are (the MCP's way; nothing goes unless sent with remove).
  await patch("starters add one, change one", "bob", `${TRIP}/packing/starters`, { starters: [
    { scope: "person", label: "  passport ", note: "Valid six months past the trip; a copy in the safe." },
    { scope: "person", label: "Sun hat", category: "clothes", bags: { "leaving-home": "on-me" } },
  ] }, { learn: (r) => ({ "starter-sun-hat": r.json().starters.find((x) => x.label === "Sun hat")?.id }) });
  await patch("starters remove one, one not there", "bob", `${TRIP}/packing/starters`, { starters: [
    { scope: "person", label: "Sun hat", remove: true }, { scope: "group", label: "Kettle", remove: true },
  ] });
  await patch("starters a new one without its category", "bob", `${TRIP}/packing/starters`, { starters: [{ scope: "person", label: "Torch" }] });
  await patch("starters the same one twice", "bob", `${TRIP}/packing/starters`, { starters: [{ scope: "person", label: "Torch", category: "gear" }, { scope: "person", label: "torch", category: "gear" }] });
  await patch("starters none sent", "bob", `${TRIP}/packing/starters`, { starters: [] });
  await del("lists delete with items", "admin", `${TRIP}/packing/lists/leaving-home`);
  await patch("packing off the boat day", "admin", `${TRIP}/packing/pk_a1`, { bags: { "boat-day": null } });
  await del("lists delete a starter starts in", "admin", `${TRIP}/packing/lists/boat-day`);
  await del("lists delete", "bob", `${TRIP}/packing/lists/day-out`);
  await del("lists delete gone", "bob", `${TRIP}/packing/lists/day-out`);
  await put("packing PUT", "admin", `${TRIP}/packing`, {}, { staticAsset: true });
  await get("packing GET by id", "admin", `${TRIP}/packing/pk_a1`, { staticAsset: true });
  await get("packing with lists and ticks", "admin", `${TRIP}/packing`);
  await del("packing delete someone else's", "admin", `${TRIP}/packing/pk_b1`);
  await del("packing delete path", "admin", `${TRIP}/packing/pk_a1`);
  await del("packing delete gone", "admin", `${TRIP}/packing/pk_a1`);
  await del("packing delete by query", "bob", `${TRIP}/packing?id=pk_b1`);
  await del("packing delete by body", "bob", `${TRIP}/packing`, { json: { id: "pk_g1" } });
  await del("packing delete no id", "admin", `${TRIP}/packing`);
  await get("packing after", "admin", `${TRIP}/packing`);
  await get("packing after bob", "bob", `${TRIP}/packing`);

  // Split.
  const pur = {
    id: "pu_a1", description: " Dinner ", amount_minor: 10000, currency: "pen", amount_exp: 2, split_mode: "weight",
    spent_at: T0 + 21 * 3600, day: "2026-08-01", event_id: "e-lunch", place_id: "p-cafe", note: "cash",
    shares: [{ user_id: "u_bob", weight: 1, share_minor: 5000 }, { user_id: "u_admin", weight: 1, share_minor: 5000 }],
  };
  await post("split create", "admin", `${TRIP}/purchases`, pur);
  await post("split replay with an edit", "admin", `${TRIP}/purchases`, { ...pur, description: "Dinner out", note: "" });
  await post("split same id, someone else", "bob", `${TRIP}/purchases`, { ...pur, paid_by: "u_admin" });
  await post("split exact, paid by someone else", "admin", `${TRIP}/purchases`, {
    id: "pu_a2", description: "Taxi", amount_minor: 3000, currency: "USD", split_mode: "exact", paid_by: "u_bob", spent_at: T0 + 22 * 3600,
    shares: [{ user_id: "u_admin", weight: 1000, share_minor: 1000 }, { user_id: "u_bob", weight: 2000, share_minor: 2000 }],
  });
  await post("split yen", "bob", `${TRIP}/purchases`, {
    id: "pu_b1", description: "Souvenir", amount_minor: 1500, currency: "JPY", amount_exp: 0, spent_at: T0 + 23 * 3600,
    shares: [{ user_id: "u_bob", weight: 1, share_minor: 1500 }],
  });
  await post("split minted id, default time", "bob", `${TRIP}/purchases`, {
    description: "Water", amount_minor: 250, currency: "PEN",
    shares: [{ user_id: "u_bob", weight: 1, share_minor: 125 }, { user_id: "u_admin", weight: 1, share_minor: 125 }],
  }, { learn: (r) => ({ "purchase-minted": r.json().purchase.id }) });
  await post("split amount zero", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", amount_minor: 0 });
  await post("split amount huge", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", amount_minor: 2e15 });
  await post("split amount fraction", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", amount_minor: 10.5 });
  await post("split bad currency", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", currency: "SOLES" });
  await post("split bad exp", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", amount_exp: 5 });
  await post("split exp against currency", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", currency: "JPY", amount_exp: 2 });
  await post("split bad mode", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", split_mode: "random" });
  await post("split bad paid_by", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", paid_by: "not valid!" });
  await post("split bad spent_at", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", spent_at: 1785542400000 });
  await post("split bad day", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", day: "Aug 1" });
  await post("split unknown event", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", event_id: "e_nope" });
  await post("split unknown place", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", place_id: "p_nope" });
  await post("split no shares", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", shares: [] });
  await post("split duplicate person", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", shares: [{ user_id: "u_bob", weight: 1, share_minor: 5000 }, { user_id: "u_bob", weight: 1, share_minor: 5000 }] });
  await post("split bad weight", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", shares: [{ user_id: "u_bob", weight: -1, share_minor: 10000 }] });
  await post("split zero weights", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", shares: [{ user_id: "u_bob", weight: 0, share_minor: 10000 }] });
  await post("split shares don't sum", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", shares: [{ user_id: "u_bob", weight: 1, share_minor: 9999 }] });
  await post("split exact weights don't sum", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", split_mode: "exact", shares: [{ user_id: "u_bob", weight: 1, share_minor: 10000 }] });
  await post("split stranger", "admin", `${TRIP}/purchases`, { ...pur, id: "pu_x", shares: [{ user_id: "u_nobody", weight: 1, share_minor: 10000 }] });
  await post("split bad id", "admin", `${TRIP}/purchases`, { ...pur, id: "no good" });
  await patch("split patch note", "admin", `${TRIP}/purchases/pu_a1`, { note: "card", description: "Dinner" });
  await patch("split patch half the money fields", "admin", `${TRIP}/purchases/pu_a1`, { amount_minor: 12000 });
  await patch("split patch all the money fields", "admin", `${TRIP}/purchases/pu_a1`, {
    amount_minor: 12000, currency: "PEN", amount_exp: 2, split_mode: "weight",
    shares: [{ user_id: "u_admin", weight: 2, share_minor: 8000 }, { user_id: "u_bob", weight: 1, share_minor: 4000 }],
  });
  await patch("split patch as the payer", "bob", `${TRIP}/purchases/pu_a2`, { note: "airport" });
  await patch("split patch not yours", "bob", `${TRIP}/purchases/pu_a1`, { note: "x" });
  await patch("split patch missing", "admin", `${TRIP}/purchases/pu_nope`, { note: "x" });
  await patch("split patch ids disagree", "admin", `${TRIP}/purchases/pu_a1`, { id: "pu_a2", note: "x" });
  await patch("split patch nothing", "admin", `${TRIP}/purchases/pu_a1`, {});
  await patch("split PATCH no id", "admin", `${TRIP}/purchases`, { id: "pu_a1", note: "x" }, { staticAsset: true });
  await get("split GET by id", "admin", `${TRIP}/purchases/pu_a1`, { staticAsset: true });
  await get("split list", "bob", `${TRIP}/purchases`);
  await del("split delete not yours", "admin", `${TRIP}/purchases/pu_b1`);
  await del("split delete own", "bob", `${TRIP}/purchases/pu_b1`);
  await del("split delete gone", "bob", `${TRIP}/purchases/pu_b1`);
  await del("split DELETE no id", "admin", `${TRIP}/purchases`, { staticAsset: true });

  // Rates.
  await call("fx HEAD", "admin", "HEAD", "/api/fx");
  await post("fx POST", "admin", "/api/fx", {});
  await del("fx DELETE", "admin", "/api/fx");
  await get("fx trailing slash", "admin", "/api/fx/");
  await get("fx refresh GET", "admin", "/api/fx/refresh", { staticAsset: true });
  await get("fx/nope", "admin", "/api/fx/nope", { staticAsset: true });

  // ═══ 5. Pictures: uploads, memories, the shared board ════════════════════════════════════
  const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("parity photo, not a real jpeg".repeat(40))]);
  const photoSha = crypto.createHash("sha256").update(photo).digest("hex");
  // A real WebP: a thumbnail is cleaned before it's kept (src/media/strip.js), and bytes that aren't a picture are refused.
  const thumbBytes = WEBP;
  await post("media begin bad mime", "admin", `${TRIP}/media/begin`, { name: "a.jpg", mime: "nope", bytes: 10 });
  await post("media begin bad bytes", "admin", `${TRIP}/media/begin`, { name: "a.jpg", mime: "image/jpeg", bytes: 0 });
  await post("media begin too large", "admin", `${TRIP}/media/begin`, { name: "a.jpg", mime: "image/jpeg", bytes: 9 * 1024 * 1024 * 1024 });
  const begun = await post("media begin", "admin", `${TRIP}/media/begin`, { name: "Plaza de Armas.JPG", mime: "image/jpeg", bytes: photo.length, sha256: photoSha },
    { learn: (r) => ({ "media-key-1": r.json().key, "upload-id-1": r.json().uploadId }) });
  const key1 = begun.json().key, up1 = begun.json().uploadId;
  const q1 = `key=${encodeURIComponent(key1)}&id=${encodeURIComponent(up1)}`;
  await call("media part wrong size", "admin", "POST", `${TRIP}/media/part?${q1}&n=1`, { body: photo.subarray(0, 10), type: "application/octet-stream" });
  await call("media part bad number", "admin", "POST", `${TRIP}/media/part?${q1}&n=2`, { body: photo, type: "application/octet-stream" });
  await call("media part someone else's", "bob", "POST", `${TRIP}/media/part?${q1}&n=1`, { body: photo, type: "application/octet-stream" });
  await call("media part wrong upload id", "admin", "POST", `${TRIP}/media/part?key=${encodeURIComponent(key1)}&id=nope&n=1`, { body: photo, type: "application/octet-stream" });
  await call("media part bad key", "admin", "POST", `${TRIP}/media/part?key=../x&id=y&n=1`, { body: photo, type: "application/octet-stream" });
  await call("media part unknown key", "admin", "POST", `${TRIP}/media/part?key=o/aa/bb/cc.jpg&id=y&n=1`, { body: photo, type: "application/octet-stream" });
  const part = await call("media part", "admin", "PUT", `${TRIP}/media/part?${q1}&n=1`, { body: photo, type: "application/octet-stream",
    learn: (r) => ({ "part-etag-1": r.json().etag }) });
  const etag1 = part.json().etag;
  await get("media before finish", "admin", `/media/${key1}`);
  await post("media finish wrong count", "admin", `${TRIP}/media/finish`, { key: key1, id: up1, parts: [] });
  await post("media finish bad entry", "admin", `${TRIP}/media/finish`, { key: key1, id: up1, parts: [{ n: 3, etag: etag1 }] });
  await post("media finish", "admin", `${TRIP}/media/finish`, { key: key1, id: up1, parts: [{ n: 1, etag: etag1 }] },
    { learn: (r) => (r.json().etag ? { "media-etag-1": String(r.json().etag).replace(/^(W\/)?"|"$/g, "") } : {}) });
  await post("media finish again", "admin", `${TRIP}/media/finish`, { key: key1, id: up1, parts: [{ n: 1, etag: etag1 }] });
  const begun2 = await post("media begin second", "admin", `${TRIP}/media/begin`, { name: "clip", mime: "video/mp4", bytes: 64 },
    { learn: (r) => ({ "media-key-2": r.json().key, "upload-id-2": r.json().uploadId }) });
  await post("media abort", "admin", `${TRIP}/media/abort`, { key: begun2.json().key, uploadId: begun2.json().uploadId });
  await post("media abort again", "admin", `${TRIP}/media/abort`, { key: begun2.json().key, uploadId: begun2.json().uploadId });
  await post("media abort unknown", "admin", `${TRIP}/media/abort`, { key: "o/aa/bb/cc.jpg", id: "x" });
  await post("media abort bad key", "admin", `${TRIP}/media/abort`, { key: "", id: "x" });
  await call("media thumb bad mime", "admin", "POST", `${TRIP}/media/thumb?mime=image/gif`, { body: thumbBytes, type: "image/gif" });
  await call("media thumb empty", "admin", "POST", `${TRIP}/media/thumb`, { body: Buffer.alloc(0), type: "image/webp" });
  await call("media thumb unknown original", "admin", "POST", `${TRIP}/media/thumb?for=o/aa/bb/cc.jpg`, { body: thumbBytes, type: "image/webp" });
  await call("media thumb someone else's original", "bob", "POST", `${TRIP}/media/thumb?for=${encodeURIComponent(key1)}`, { body: thumbBytes, type: "image/webp" });
  const th = await call("media thumb", "admin", "PUT", `${TRIP}/media/thumb?for=${encodeURIComponent(key1)}`, { body: thumbBytes, type: "image/webp",
    learn: (r) => ({ "thumb-key-1": r.json().key }) });
  const thumb1 = th.json().key;
  const th2 = await call("media thumb loose", "bob", "POST", `${TRIP}/media/thumb?mime=image/png`, { body: thumbBytes, type: "image/png",
    learn: (r) => ({ "thumb-key-2": r.json().key }) });
  await get("media usage admin", "admin", `${TRIP}/media/usage`);
  await get("media usage bob", "bob", `${TRIP}/media/usage`);
  await del("media object bad key", "admin", `${TRIP}/media/object?key=..`);
  await del("media object unknown", "admin", `${TRIP}/media/object?key=o/aa/bb/cc.jpg`);
  await del("media object someone else's", "admin", `${TRIP}/media/object?key=${encodeURIComponent(th2.json().key)}`);
  await get("media config again", "admin", `${TRIP}/media/config`);
  await post("media wrong method", "admin", `${TRIP}/media/config`, {});
  await get("media unknown action", "admin", `${TRIP}/media/nope`);
  await get("media bare", "admin", `${TRIP}/media`);
  await get("media two segments", "admin", `${TRIP}/media/part/extra`);

  // Reading a stored picture back.
  const m1 = `/media/${key1}`;
  const full = await get("media file full", "admin", m1);
  const mediaEtag = (full.headers.find(([k]) => k === "etag") || [])[1] || "";
  await get("media file as another member", "bob", m1);
  await call("media file HEAD", "admin", "HEAD", m1);
  await get("media file not modified", "admin", m1, { headers: { "If-None-Match": mediaEtag } });
  await get("media file range bounded", "admin", m1, { headers: { Range: "bytes=4-19" } });
  await get("media file range open", "admin", m1, { headers: { Range: `bytes=${photo.length - 10}-` } });
  await get("media file range suffix", "admin", m1, { headers: { Range: "bytes=-16" } });
  await get("media file range past end", "admin", m1, { headers: { Range: `bytes=${photo.length + 5}-` } });
  await get("media file range clamped", "admin", m1, { headers: { Range: `bytes=${photo.length - 10}-999999` } });
  await get("media file range backwards", "admin", m1, { headers: { Range: "bytes=20-10" } });
  await get("media file range zero suffix", "admin", m1, { headers: { Range: "bytes=-0" } });
  await get("media file range multi", "admin", m1, { headers: { Range: "bytes=0-1,5-6" } });
  await get("media file thumb", "admin", `/media/${thumb1}`);
  await get("media file unknown", "admin", "/media/o/aa/bb/cc.jpg");
  await get("media file bad key", "admin", "/media/..%2Fx");
  await get("media file bare", "admin", "/media");
  await get("media file bare slash", "admin", "/media/");
  await post("media file POST", "admin", m1, {});

  // Memories.
  await post("memories nothing", "admin", `${TRIP}/memories`, { id: "mem_x" });
  await post("memories caption only", "bob", `${TRIP}/memories`, { id: "mem_b1", caption: " First night ", tags: ["Lima", "lima", "Food & Drink!"] });
  await t.tick(); // memories list by created_at, then id
  await post("memories with media", "admin", `${TRIP}/memories`, {
    id: "mem_a1", caption: "The square", tags: ["lima"],
    media: [{ key: key1, thumb_key: thumb1, w: 4000, h: 3000 }],
  }, { learn: (r) => ({ "memory-media-1": r.json().memory.media[0].id }) });
  await post("memories replay", "admin", `${TRIP}/memories`, { id: "mem_a1", caption: "The square" });
  await post("memories same id, someone else", "bob", `${TRIP}/memories`, { id: "mem_a1", caption: "x" });
  await post("memories reserved id", "admin", `${TRIP}/memories`, { id: "tags", caption: "x" });
  await post("memories media already attached", "admin", `${TRIP}/memories`, { id: "mem_x", media: [{ key: key1 }] });
  await post("memories unknown media", "admin", `${TRIP}/memories`, { id: "mem_x", media: [{ key: "o/aa/bb/cc.jpg" }] });
  await post("memories bad media key", "admin", `${TRIP}/memories`, { id: "mem_x", media: [{ key: "../x" }] });
  await post("memories someone else's media", "bob", `${TRIP}/memories`, { id: "mem_x", media: [{ key: key1 }] });
  await post("memories thumb as original", "admin", `${TRIP}/memories`, { id: "mem_x", media: [{ key: thumb1 }] });
  await post("memories unfinished media", "admin", `${TRIP}/memories`, { id: "mem_x", media: [{ key: begun2.json().key }] });
  await post("memories duplicate key", "admin", `${TRIP}/memories`, { id: "mem_x", media: [{ key: key1 }, { key: key1 }] });
  await t.tick();
  await post("memories minted id", "admin", `${TRIP}/memories`, { caption: "No id given" }, { learn: (r) => ({ "memory-minted": r.json().memory.id }) });
  await get("memories list", "admin", `${TRIP}/memories`);
  await get("memories list by tag", "bob", `${TRIP}/memories?tag=LIMA`);
  await get("memories list paged", "bob", `${TRIP}/memories?limit=1`);
  await get("memories list before", "bob", `${TRIP}/memories?before=1785000000&before_id=mem_a1`);
  await get("memories tags", "bob", `${TRIP}/memories/tags`);
  await post("memories tags POST", "bob", `${TRIP}/memories/tags`, {});
  await get("memories one", "bob", `${TRIP}/memories/mem_a1`);
  await get("memories one, unknown", "bob", `${TRIP}/memories/mem_nope`);
  await get("memories one, bad id", "bob", `${TRIP}/memories/bad%20id`);
  await get("memories two segments", "bob", `${TRIP}/memories/mem_a1/media`);
  await put("memories PUT one", "bob", `${TRIP}/memories/mem_a1`, {});
  await put("memories PUT list", "bob", `${TRIP}/memories`, {});
  await get("memories trailing slash", "bob", `${TRIP}/memories/`);
  const mediaId = (await get("memories read for framing", "admin", `${TRIP}/memories/mem_a1`)).json().memory.media[0].id;
  await patch("memories framing", "bob", `${TRIP}/memories/mem_a1`, { framing: { [mediaId]: { focal_x: 0.25, focal_y: 2, zoom: 0.5, trim_start_s: null }, other: { zoom: 3 } } });
  await patch("memories framing bad", "bob", `${TRIP}/memories/mem_a1`, { framing: [] });
  await patch("memories framing unknown memory", "bob", `${TRIP}/memories/mem_nope`, { framing: {} });
  await del("media object attached", "admin", `${TRIP}/media/object?key=${encodeURIComponent(key1)}`);
  await del("memories delete someone else's", "bob", `${TRIP}/memories/mem_a1`);
  await del("memories delete someone else's, as admin", "admin", `${TRIP}/memories/mem_b1`);
  await del("memories delete with media", "admin", `${TRIP}/memories/mem_a1`);
  await del("memories delete gone", "admin", `${TRIP}/memories/mem_a1`);
  await del("memories delete bad id", "admin", `${TRIP}/memories/bad%20id`);
  await get("media file after its memory is gone", "admin", m1);
  await get("media usage after", "admin", `${TRIP}/media/usage`);
  await del("media object own, loose", "bob", `${TRIP}/media/object?key=${encodeURIComponent(th2.json().key)}`);
  await del("media object gone", "bob", `${TRIP}/media/object?key=${encodeURIComponent(th2.json().key)}`);
  await get("media usage end", "bob", `${TRIP}/media/usage`);

  // The shared board and its public page.
  const board = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("parity board render".repeat(20))]);
  // A board's pictures are cleaned before they're kept, and what isn't a picture or a movie is refused: a real JPEG, and
  // the boxes of an MP4 (ftyp, then the frames' mdat).
  const mp4Box = (type, body) => { const b = Buffer.concat([Buffer.alloc(8), Buffer.from(body, "latin1")]); b.writeUInt32BE(b.length, 0); b.write(type, 4, "latin1"); return b; };
  const clip = Buffer.concat([mp4Box("ftyp", "isom\0\0\x02\0isommp41"), mp4Box("mdat", "parity board video".repeat(20))]);
  const item0 = JPEG;
  await call("board share bad type", "admin", "POST", `${TRIP}/collage/share?mime=image/gif`, { body: board, type: "image/gif" });
  await call("board share empty", "admin", "POST", `${TRIP}/collage/share`, { body: Buffer.alloc(0), type: "image/jpeg" });
  const sh = await call("board share", "admin", "POST", `${TRIP}/collage/share?mime=image/jpeg&w=2400&h=1800&title=` + encodeURIComponent("Parity <trip> & \"friends\""),
    { body: board, type: "image/jpeg", learn: (r) => ({ "share-1": r.json().share.id }) });
  const sid = sh.json().share.id;
  await t.tick(); // shares list by created_at alone
  const sh2 = await call("board share second", "bob", "POST", `${TRIP}/collage/share?mime=image/png`, { body: board, type: "image/png", learn: (r) => ({ "share-2": r.json().share.id }) });
  const sid2 = sh2.json().share.id;
  await call("board item", "admin", "POST", `${TRIP}/collage/share/${sid}/item?idx=0&kind=photo&mime=image/jpeg&w=1200&h=900&fx=0.1&fy=0.2&fw=0.3&fh=0.25&rot=-2.5`, { body: item0, type: "image/jpeg" });
  await call("board item video", "admin", "POST", `${TRIP}/collage/share/${sid}/item?idx=1&kind=video&mime=video/mp4&w=640&h=360&fx=0.5&fy=0.5&fw=0.2&fh=0.2&rot=3`, { body: clip, type: "video/mp4" });
  await call("board item bad type", "admin", "POST", `${TRIP}/collage/share/${sid}/item?idx=2&mime=text/plain`, { body: item0, type: "text/plain" });
  await call("board item empty", "admin", "POST", `${TRIP}/collage/share/${sid}/item?idx=2`, { body: Buffer.alloc(0), type: "image/jpeg" });
  await call("board item unknown share", "admin", "POST", `${TRIP}/collage/share/0123456789abcdef0123456789abcdef/item?idx=0`, { body: item0, type: "image/jpeg" });
  await call("board video", "admin", "POST", `${TRIP}/collage/share/${sid}/video?mime=video/mp4`, { body: clip, type: "video/mp4" });
  await call("board video bad type", "admin", "POST", `${TRIP}/collage/share/${sid}/video?mime=image/gif`, { body: clip, type: "image/gif" });
  await call("board video unknown share", "admin", "POST", `${TRIP}/collage/share/0123456789abcdef0123456789abcdef/video`, { body: clip, type: "video/mp4" });
  await get("board shares", "bob", `${TRIP}/collage/shares`);
  await get("board bare", "admin", `${TRIP}/collage`);
  await get("board unknown", "admin", `${TRIP}/collage/nope`);
  await get("board share GET", "admin", `${TRIP}/collage/share`);
  await get("board page", "anon", `/s/${sid}`);
  await get("board page trailing slash", "anon", `/s/${sid}/`);
  await get("board page upper case id", "anon", `/s/${sid.toUpperCase()}`);
  await get("board page signed in", "bob", `/s/${sid}`);
  await get("board page image", "anon", `/s/${sid}/image`);
  await get("board page video", "anon", `/s/${sid}/video`);
  await get("board page item 0", "anon", `/s/${sid}/i/0`);
  await get("board page item 1", "anon", `/s/${sid}/i/1`);
  await get("board page item unknown", "anon", `/s/${sid}/i/9`);
  await get("board page item lod", "anon", `/s/${sid}/i/0/lod/320`);
  await get("board page item thumb", "anon", `/s/${sid}/i/0/thumb`);
  await get("board page item bad lod", "anon", `/s/${sid}/i/0/lod/321`, { headers: ANY });
  await get("board page second, no items", "anon", `/s/${sid2}`);
  await get("board page second video", "anon", `/s/${sid2}/video`);
  await call("board page HEAD", "anon", "HEAD", `/s/${sid}`, { staticAsset: true });
  await call("board page POST", "anon", "POST", `/s/${sid}`, { body: "x", staticAsset: true });
  await del("board revoke, not its maker or the host", "bob", `${TRIP}/collage/share/${sid}`);
  await del("board revoke", "admin", `${TRIP}/collage/share/${sid2}`);
  await del("board revoke unknown", "admin", `${TRIP}/collage/share/0123456789abcdef0123456789abcdef`);
  await get("board page revoked", "anon", `/s/${sid2}`);
  await get("board page revoked image", "anon", `/s/${sid2}/image`);
  await get("board shares after", "admin", `${TRIP}/collage/shares`);

  // Pictures: each way in once, and each kind of refusal once. Keys and tokens are learned.
  const keyOf = (r) => { try { return r.json().picture.url.replace(/^\/media\//, ""); } catch { return null; } };
  const raw = (name, as, path, bytes, learn) => t.call(name, { as, method: "PUT", path, body: bytes, type: "application/octet-stream", ...(learn ? { learn } : {}) });
  await raw("picture a place", "bob", `${TRIP}/pictures/place/p-hotel?license=own`, png(40, 30), (r) => ({ "picture-key-1": keyOf(r) }));
  await raw("picture an event", "admin", `${TRIP}/pictures/event/e-lunch?license=CC0`, JPEG, (r) => ({ "picture-key-2": keyOf(r) }));
  await raw("picture the cover", "admin", `${TRIP}/pictures/cover?license=Public%20domain`, png(60, 40), (r) => ({ "picture-key-3": keyOf(r) }));
  await post("picture a purchase to hang a receipt on", "admin", `${TRIP}/purchases`, { id: "pu-receipt", description: "Bus", amount_minor: 500, currency: "PEN", amount_exp: 2,
    split_mode: "weight", spent_at: T0 + 30 * 3600, shares: [{ user_id: "u_admin", weight: 1, share_minor: 500 }] });
  await raw("picture a receipt", "admin", `${TRIP}/pictures/purchase/pu-receipt?license=own`, JPEG, (r) => ({ "picture-key-4": keyOf(r) }));
  await raw("picture a receipt, not its maker or payer", "bob", `${TRIP}/pictures/purchase/pu-receipt?license=own`, JPEG);
  await raw("picture an SVG", "bob", `${TRIP}/pictures/place/p-cafe?license=own`, SVG);
  await raw("picture too wide", "bob", `${TRIP}/pictures/place/p-cafe?license=own`, png(1601, 10));
  await raw("picture a place that isn't there", "bob", `${TRIP}/pictures/place/p-nowhere?license=own`, JPEG);
  await raw("picture a kind that isn't one", "bob", `${TRIP}/pictures/area/centro?license=own`, JPEG);
  await raw("picture an NC license", "bob", `${TRIP}/pictures/place/p-cafe?license=CC%20BY-NC%204.0&credit=A&source=https://pics.example/a`, JPEG);
  await raw("picture a license without credit", "bob", `${TRIP}/pictures/place/p-cafe?license=CC%20BY%204.0`, JPEG);
  await post("picture by address", "bob", `${TRIP}/pictures/place/p-cafe/from-url`, { url: "https://pics.example/harbour.png", license: "CC BY 4.0", credit: "A photographer", source: "https://pics.example/" },
    { learn: (r) => ({ "picture-key-5": keyOf(r) }) });
  await post("picture by address, not https", "bob", `${TRIP}/pictures/place/p-cafe/from-url`, { url: "http://pics.example/harbour.png", license: "own" });
  await post("picture by address, too many redirects", "bob", `${TRIP}/pictures/place/p-cafe/from-url`, { url: "https://pics.example/hop1", license: "own" });
  await post("picture cover by address", "admin", `${TRIP}/pictures/cover/from-url`, { url: "https://pics.example/once", license: "own" }, { learn: (r) => ({ "picture-key-6": keyOf(r) }) });
  const tokenOf = (r) => { try { return new URL(r.json().url).pathname.split("/").pop(); } catch { return null; } };
  const link = await post("picture upload link", "bob", `${TRIP}/pictures/event/e-checkin/upload-link`, { license: "own" }, { learn: (r) => ({ "picture-token-1": tokenOf(r) }) });
  const token = tokenOf(link);
  await post("picture upload link for the cover", "admin", `${TRIP}/pictures/cover/upload-link`, { license: "own" }, { learn: (r) => ({ "picture-token-2": tokenOf(r) }) });
  await raw("picture sent to an upload link", "anon", `/pictures/upload/${token}`, JPEG, (r) => ({ "picture-key-7": keyOf(r) }));
  await raw("picture sent to an upload link again", "anon", `/pictures/upload/${token}`, JPEG);
  await raw("picture sent to a made-up link", "anon", `/pictures/upload/${"x".repeat(43)}`, JPEG);
  await get("picture in the snapshot", "bob", TRIP);
  await del("picture removed", "bob", `${TRIP}/pictures/place/p-hotel`);
  await del("picture removed again", "bob", `${TRIP}/pictures/place/p-hotel`);
  await del("picture cover removed", "admin", `${TRIP}/pictures/cover`);

  // ═══ 6. Map tiles ════════════════════════════════════════════════════════════════════════
  const tile = `/tiles/${TILE_KEY}`;
  const tfull = await get("tiles full", "admin", tile);
  const tileEtag = (tfull.headers.find(([k]) => k === "etag") || [])[1] || "";
  await call("tiles HEAD", "admin", "HEAD", tile);
  await get("tiles not modified", "admin", tile, { headers: { "If-None-Match": tileEtag } });
  await get("tiles range bounded", "admin", tile, { headers: { Range: "bytes=100-115" } });
  await get("tiles range open", "admin", tile, { headers: { Range: "bytes=99990-" } });
  await get("tiles range suffix", "admin", tile, { headers: { Range: "bytes=-16" } });
  await get("tiles range clamped", "admin", tile, { headers: { Range: "bytes=99990-999999" } });
  await get("tiles range past end", "admin", tile, { headers: { Range: "bytes=200000-" } });
  await get("tiles range bounded past end", "admin", tile, { headers: { Range: "bytes=200000-200010" } });
  await get("tiles range multi", "admin", tile, { headers: { Range: "bytes=0-1,5-6" } });
  await get("tiles range backwards", "admin", tile, { headers: { Range: "bytes=20-10" } });
  await get("tiles json", "bob", `/tiles/${TILE_JSON_KEY}`);
  await get("tiles missing", "admin", "/tiles/fonts/parity/nope.pmtiles");
  await get("tiles missing range", "admin", "/tiles/fonts/parity/nope.pmtiles", { headers: { Range: "bytes=0-9" } });
  await get("tiles dot segment", "admin", "/tiles/fonts/parity/./test.pmtiles");
  await get("tiles bare", "admin", "/tiles");
  await get("tiles bare slash", "admin", "/tiles/");
  await get("tiles upper case", "admin", "/TILES/fonts/parity/test.pmtiles");
  await post("tiles POST", "admin", tile, {});
  // The address from before archives belonged to trips is gone (14 Nov): only fonts/ is served here.
  await get("tiles old address gone", "admin", "/tiles/parity/test.pmtiles");

  // ═══ 7. Carol: signing up, signing in, signing out ═══════════════════════════════════════
  const origin = t.origin, rpId = t.rpId;
  const key = new Passkey("carol", "parity-carol-first-device");
  const key2 = new Passkey("carol2", "parity-carol-second-device");
  const learnReg = (n) => (r) => {
    const o = r.json();
    const out = { [`challenge-carol-${n}`]: o.challenge };
    if (o.user && o.user.id) {
      const uid = Buffer.from(o.user.id, "base64url").toString("utf8");
      if (uid !== "u_admin" && uid !== "u_bob") { out[`carol-uid-${n}`] = uid; out[`carol-uid-${n}-b64`] = o.user.id; }
    }
    return out;
  };
  // A challenge answered from the wrong origin.
  let opt = await post("carol register/options (to wrong origin)", "carol", "/api/auth/register/options", { name: "carol" }, { learn: learnReg(2) });
  await post("carol register/verify wrong origin", "carol", "/api/auth/register/verify", key.create({ challenge: opt.json().challenge, origin: "https://evil.example", rpId }));
  opt = await post("carol register/options (to malformed)", "carol", "/api/auth/register/options", { name: "carol" }, { learn: learnReg(3) });
  await post("carol register/verify malformed", "carol", "/api/auth/register/verify", { id: "x", response: {} });
  opt = await post("carol register/options (to garbage)", "carol", "/api/auth/register/options", { name: "carol" }, { learn: learnReg(4) });
  await post("carol register/verify garbage", "carol", "/api/auth/register/verify", { id: "x", response: { clientDataJSON: "bm90IGpzb24", attestationObject: "AAAA" } });
  // The real one. The name is tidied: outer spaces go, inner runs become one.
  opt = await post("carol register/options", "carol", "/api/auth/register/options", { name: "  Carol   C " }, { learn: learnReg(5) });
  key.userHandle = opt.json().user.id;
  key2.userHandle = opt.json().user.id;
  const reg = await post("carol register/verify", "carol", "/api/auth/register/verify", key.create({ challenge: opt.json().challenge, origin, rpId }));
  if (reg.status !== 200) throw new Error(`carol could not sign up: ${reg.status} ${reg.body.toString("utf8")}`);
  const carolId = reg.json().user.id;
  await post("carol register/verify challenge reused", "carol", "/api/auth/register/verify", key.create({ challenge: opt.json().challenge, origin, rpId }));
  await get("carol /api/me", "carol", "/api/me");
  await post("carol's name may be someone else's too", "anon", "/api/auth/register/options", { name: "Carol C" }, { learn: learnReg(9) });
  await patch("carol picks a colour", "carol", "/api/me", { note_color: "#C2185B" });
  await patch("carol changes her name", "carol", "/api/me", { name: " carol " });
  await patch("carol name that isn't one", "carol", "/api/me", { name: "" });
  // Signing up put her on no trip.
  await get("carol /api/trips, on none", "carol", "/api/trips");
  await get("carol the trip, not on it", "carol", TRIP);
  await get("carol the trip's events, not on it", "carol", `${TRIP}/events`);
  await get("carol opens the app, not on a trip", "carol", "/", { headers: HTML });
  await get("carol opens the app with a query, not on a trip", "carol", "/?source=pwa", { headers: HTML });
  await get("carol's browser fetches /, not on a trip", "carol", "/", { headers: ANY });
  await put("carol places, not on the trip", "carol", `${TRIP}/places`, { places: PLACES });
  await get("carol /tiles, on no trip", "carol", `/tiles/${TILE_KEY}`);
  await t.tick(); // the roster sorts on joined_at
  await post("carol joins by the link", "carol", `/api/join/${code1}`, {});
  // That was the link's second and last use.
  await get("join view, used up", "anon", `/api/join/${code1}`);
  await post("join used up", "bob", `/api/join/${code1}`, {});
  await get("links list, one used up", "admin", `${TRIP}/links`);
  await get("carol the trip", "carol", TRIP);
  await get("carol /tiles, on a trip", "carol", `/tiles/${TILE_JSON_KEY}`);
  await get("carol ways", "carol", "/api/auth/ways");
  await get("carol email, not offered here", "carol", "/api/account/email");
  await post("carol email add, not offered here", "carol", "/api/account/email", { email: "carol@example.org" });
  await post("carol email confirm, not offered here", "carol", "/api/account/email/confirm", { id: "x", code: "123456" });
  await del("carol email remove, none there", "carol", "/api/account/email");
  await post("carol pending/attach, nothing waiting", "carol", "/api/auth/pending/attach", {});
  // A second passkey on the same account.
  opt = await post("carol attach/options", "carol", "/api/auth/passkeys/options", {}, { learn: learnReg(6) });
  await post("carol attach/verify", "carol", "/api/auth/passkeys/verify", key2.create({ challenge: opt.json().challenge, origin, rpId }));
  opt = await post("carol attach/options again", "carol", "/api/auth/passkeys/options", {}, { learn: learnReg(7) });
  await post("carol attach/verify duplicate", "carol", "/api/auth/passkeys/verify", key2.create({ challenge: opt.json().challenge, origin, rpId }));
  opt = await post("carol attach/options (session lost)", "carol", "/api/auth/passkeys/options", {}, { learn: learnReg(8) });
  await post("carol attach/verify without the session", null, "/api/auth/passkeys/verify", key2.create({ challenge: opt.json().challenge, origin, rpId }),
    { cookie: `wgp_chal=${t.jar("carol").cookies.get("wgp_chal")}` });
  await get("carol ways, two passkeys", "carol", "/api/auth/ways", { reduce: (r) => ({ passkeys: r.json().passkeys.map((k) => k.id), identities: r.json().identities.length, username: r.json().username }) });
  await del("carol removes a passkey that isn't hers", "carol", "/api/auth/ways/passkey/bm9wZQ");
  await del("carol removes a sign-in she doesn't have", "carol", "/api/auth/ways/github/12345");
  await del("carol delete account, not confirmed", "carol", "/api/me");
  await call("carol change from another site", "carol", "PATCH", "/api/me", { json: { name: "x" }, headers: { Origin: "https://example.org" } });
  // Signing out and back in.
  await post("carol logout", "carol", "/api/auth/logout", undefined);
  await get("carol /api/me signed out", "carol", "/api/me", { headers: ANY });
  const learnLogin = (n) => (r) => ({ [`challenge-login-${n}`]: r.json().challenge });
  await post("carol login/options by name", "carol", "/api/auth/login/options", { username: " CAROL " });
  opt = await post("carol login/options (to wrong key)", "carol", "/api/auth/login/options", {}, { learn: learnLogin(1) });
  await post("carol login/verify wrong key", "carol", "/api/auth/login/verify", { ...key2.get({ challenge: opt.json().challenge, origin, rpId }), id: key.id });
  opt = await post("carol login/options", "carol", "/api/auth/login/options", {}, { learn: learnLogin(2) });
  await post("carol login/verify unknown credential", "carol", "/api/auth/login/verify", { ...key.get({ challenge: opt.json().challenge, origin, rpId }), id: "bm9wZQ" });
  opt = await post("carol login/options (to malformed)", "carol", "/api/auth/login/options", {}, { learn: learnLogin(3) });
  await post("carol login/verify malformed", "carol", "/api/auth/login/verify", { id: key.id, response: {} });
  opt = await post("carol login/options (to wrong rp)", "carol", "/api/auth/login/options", {}, { learn: learnLogin(4) });
  await post("carol login/verify wrong rp", "carol", "/api/auth/login/verify", key.get({ challenge: opt.json().challenge, origin, rpId: "example.org" }));
  opt = await post("carol login/options (real)", "carol", "/api/auth/login/options", {}, { learn: learnLogin(5) });
  const login = await post("carol login/verify", "carol", "/api/auth/login/verify", key.get({ challenge: opt.json().challenge, origin, rpId }));
  if (login.status !== 200) throw new Error(`carol could not sign in: ${login.status} ${login.body.toString("utf8")}`);
  await get("carol /api/me signed in again", "carol", "/api/me");
  // A counter that goes backwards is a cloned passkey.
  opt = await post("carol login/options (counter)", "carol", "/api/auth/login/options", {}, { learn: learnLogin(6) });
  key.counter -= 2;
  await post("carol login/verify counter went back", "carol", "/api/auth/login/verify", key.get({ challenge: opt.json().challenge, origin, rpId }));
  opt = await post("carol login/options (second key)", "carol", "/api/auth/login/options", {}, { learn: learnLogin(7) });
  await post("carol login/verify second key", "carol", "/api/auth/login/verify", key2.get({ challenge: opt.json().challenge, origin, rpId }));
  await del("carol removes her first passkey", "carol", `/api/auth/ways/passkey/${key.id}`);
  await del("carol can't remove her last way in", "carol", `/api/auth/ways/passkey/${key2.id}`);
  await post("carol purchase names her", "admin", `${TRIP}/purchases`, {
    id: "pu_c1", description: "Three ways", amount_minor: 900, currency: "USD", spent_at: T0 + 40 * 3600,
    shares: [{ user_id: "u_admin", weight: 1, share_minor: 300 }, { user_id: "u_bob", weight: 1, share_minor: 300 }, { user_id: carolId, weight: 1, share_minor: 300 }],
  });
  await get("trip with three people", "bob", TRIP);
  // Leaving, and being removed: the row stays, the trip is closed to them.
  await del("members carol removes someone else", "carol", `${TRIP}/members/u_bob`);
  await del("members carol leaves", "carol", `${TRIP}/members/${carolId}`);
  await get("carol the trip, after leaving", "carol", TRIP);
  await del("members carol leaves again", "carol", `${TRIP}/members/${carolId}`);
  await del("members the host removes someone who left", "admin", `${TRIP}/members/${carolId}`);
  await get("members after carol left", "admin", `${TRIP}/members`);
  await get("trip after carol left", "admin", TRIP);
  await post("carol logout/all", "carol", "/api/auth/logout/all", undefined);
  await get("carol /api/me after signing out everywhere", "carol", "/api/me", { headers: ANY });

  // ═══ 8. Every static file, signed in and signed out ══════════════════════════════════════
  for (const rel of t.files) {
    const p = "/" + rel.split("/").map(encodeURIComponent).join("/");
    await get(`static in ${p}`, "admin", p, { staticAsset: true, file: rel });
    await get(`static out ${p}`, "anon", p, { headers: ANY, staticAsset: true, file: rel });
  }
  // The shell and a few files, every way a browser or the service worker asks for them.
  await get("shell /", "admin", "/", { headers: HTML, staticAsset: true });
  await get("shell /index.html", "admin", "/index.html", { headers: HTML, staticAsset: true });
  await get("shell /index", "admin", "/index", { headers: HTML, staticAsset: true });
  await get("shell /?x=1", "admin", "/?x=1", { headers: HTML, staticAsset: true });
  await get("shell /login signed in", "admin", "/login", { headers: HTML, staticAsset: true });
  await get("shell unknown page", "admin", "/nope", { headers: HTML, staticAsset: true });
  await get("shell unknown page, fetch", "admin", "/nope", { headers: ANY, staticAsset: true });
  await get("shell unknown file", "admin", "/js/nope.js", { headers: ANY, staticAsset: true });
  await get("shell unknown deep", "admin", "/a/b/c/d", { headers: HTML, staticAsset: true });
  await get("shell unknown api", "admin", "/api/nope", { headers: ANY, staticAsset: true });
  await post("shell unknown api POST", "admin", "/api/nope", {}, { staticAsset: true });
  await get("shell folder /js/", "admin", "/js/", { headers: HTML, staticAsset: true });
  await get("shell folder /js", "admin", "/js", { headers: HTML, staticAsset: true });
  // /_headers isn't asked for: `wrangler pages dev` answers it 502 with a local path in the text
  // (it tries public/_headers/index.html), which is the dev server's own fault and not the site's.
  await get("shell /sw.js signed in", "admin", "/sw.js", { staticAsset: true });
  await get("shell /JS/store.js upper case", "admin", "/JS/store.js", { headers: ANY, staticAsset: true });
  await get("shell /js/store.js with query", "admin", "/js/store.js?v=54", { headers: ANY, staticAsset: true });
  await get("shell encoded path", "admin", "/js/%73tore.js", { headers: ANY, staticAsset: true });
  for (const p of ["/js/store.js", "/styles.css", "/img/wordmark.svg", "/vendor/fonts/inter-latin-wght-normal.woff2", "/manifest.webmanifest", "/sw.js", "/"]) {
    const first = await get(`conditional first ${p}`, "admin", p, { headers: HTML, staticAsset: true });
    const etag = (first.headers.find(([k]) => k === "etag") || [])[1];
    if (etag) {
      await get(`conditional match ${p}`, "admin", p, { headers: { ...HTML, "If-None-Match": etag }, staticAsset: true });
      await get(`conditional weak match ${p}`, "admin", p, { headers: { ...HTML, "If-None-Match": etag.startsWith("W/") ? etag.slice(2) : `W/${etag}` }, staticAsset: true });
    }
    await get(`conditional miss ${p}`, "admin", p, { headers: { ...HTML, "If-None-Match": '"nope"' }, staticAsset: true });
    await call(`static HEAD ${p}`, "admin", "HEAD", p, { headers: HTML, staticAsset: true });
    await call(`static POST ${p}`, "admin", "POST", p, { body: "x", staticAsset: true });
    await call(`static PUT ${p}`, "admin", "PUT", p, { body: "x", staticAsset: true });
    await call(`static DELETE ${p}`, "admin", "DELETE", p, { staticAsset: true });
    await call(`static OPTIONS ${p}`, "admin", "OPTIONS", p, { staticAsset: true });
    await get(`static range ${p}`, "admin", p, { headers: { ...HTML, Range: "bytes=0-9" }, staticAsset: true });
  }

  // ═══ 9. A trip the first one's size, whole ════════════════════════════════════════════════
  // seed/demo-trip.json (made up, by tools/demo-seed.mjs) put in through the routes by the seed
  // tool (tools/seed-trip.mjs), as a trip of its own: its areas, 331 places in two calls, every
  // event, its packing lists and its starters.
  const demo = JSON.parse(fs.readFileSync(t.seedPath, "utf8"));
  let step = 0;
  const send = async (method, path, body) => {
    step += 1;
    // The trip's board seed is random: learned from the answer that makes it, like the others.
    const learn = method === "POST" && path === "/api/trips" ? { learn: (r) => ({ "collage-seed-demo": r.json().trip.collage_seed }) } : {};
    const res = await t.call(`demo ${String(step).padStart(2, "0")} ${method} ${path.replace(/^\/api\/trips\/[^/]+/, "<trip>")}`, { as: "admin", method, path, json: body, ...learn });
    let json = null;
    try { json = res.json(); } catch { /* not JSON */ }
    return { status: res.status, json };
  };
  const { tripId } = await seedTrip(demo, send);
  await get("demo trip", "admin", `/api/trips/${tripId}`);
  await get("demo places", "admin", `/api/trips/${tripId}/places`);
  await get("demo events", "admin", `/api/trips/${tripId}/events`);
  await get("demo areas", "admin", `/api/trips/${tripId}/areas`);

  // ═══ A drawn picture (src/accounts/avatar.js), after everything else ══════════════════════
  // Here, after every other step, because a picture moves every roster its person is on: every step before this one
  // is then the app as someone who never draws meets it, and matching the recording before it is the proof that not
  // drawing changes nothing. The picture is a fixed one, so its hash is the same every run.
  const drawing = encodeDrawing({ palette: 2, strokes: [{ ink: 0, brush: 52, pts: [[60, 80], [100, 120], [140, 100]] }, { ink: 1, brush: 22, pts: [[127, 127]] }] });
  const drawn = toB64url(drawing), hash = await hashOf(drawing);
  await put("avatar nothing sent", "admin", "/api/me/avatar", {});
  await put("avatar not a drawing", "admin", "/api/me/avatar", { drawing: "V0dEAQ" });
  await put("avatar drawn", "admin", "/api/me/avatar", { drawing: drawn });
  await put("avatar drawn again", "admin", "/api/me/avatar", { drawing: drawn });
  await put("avatar signed out", "anon", "/api/me/avatar", { drawing: drawn }, { headers: ANY });
  await get("avatar me", "admin", "/api/me");
  await get("avatar on the roster", "admin", `${TRIP}/members`);
  await get("avatar read by its own", "admin", `/api/avatars/${hash}`, { headers: ANY });
  await get("avatar read by a trip-mate", "bob", `/api/avatars/${hash}`, { headers: ANY });
  await get("avatar read by someone on no trip with it", null, `/api/avatars/${hash}`, { cookie: t.session("u_old", 3600), headers: ANY });
  await get("avatar read signed out", "anon", `/api/avatars/${hash}`, { headers: ANY });
  await get("avatar read by a name nobody holds", "bob", "/api/avatars/AAAAAAAAAAAA", { headers: ANY });
  await get("avatar read by a name that isn't one", "bob", "/api/avatars/not-a-name", { headers: ANY });
  await del("avatar back to initials", "admin", "/api/me/avatar");
  await del("avatar back to initials again", "admin", "/api/me/avatar");
  await get("avatar read after it went", "bob", `/api/avatars/${hash}`, { headers: ANY });

  // The trip's quick reference list (src/api/references.js), near the end so no rev before it moves: read, one added, changed, a list put, one refused, removed.
  await get("references, none yet", "bob", `${TRIP}/references`);
  await post("reference added", "bob", `${TRIP}/references`, { id: "rf-parity", title: "Emergency numbers", body: "Police, fire and ambulance: 112" });
  await post("reference added again (a replay)", "bob", `${TRIP}/references`, { id: "rf-parity", title: "Emergency numbers", body: "Police, fire and ambulance: 112" });
  await post("reference with no title", "bob", `${TRIP}/references`, { id: "rf-parity-none", body: "x" });
  await patch("reference changed", "admin", `${TRIP}/references/rf-parity`, { body: "Police, fire and ambulance: 112\nThe hotel: +31 20 765 4321" });
  await patch("reference that isn't there", "admin", `${TRIP}/references/rf-nothing`, { body: "x" });
  await put("references put", "admin", `${TRIP}/references`, { references: [{ id: "rf-parity-money", title: "Money and ATMs", body: "Cards almost everywhere." }] });
  await del("references removed as a list", "admin", `${TRIP}/references`, { json: { ids: ["rf-parity-money"] } });
  await del("reference removed", "bob", `${TRIP}/references/rf-parity`);
  await del("reference removed again", "bob", `${TRIP}/references/rf-parity`);
  // Last, because it asks the rates provider: what comes back depends on the network and the day,
  // so only its outline is recorded.
  await post("fx refresh", "admin", "/api/fx/refresh", undefined, {
    reduce: (r) => {
      let o = null;
      try { o = r.json(); } catch { /* not JSON */ }
      const fx = o && o.fx;
      return { outline: { keys: o ? Object.keys(o).sort() : null, base: fx ? fx.base : null,
        has_rates: !!fx && Object.keys(fx.rates || {}).length >= 4 } };
    },
  });
}

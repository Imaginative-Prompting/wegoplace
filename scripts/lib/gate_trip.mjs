// THE TRIP A GATE CHECK DRIVES, AND ITS PEOPLE.
//
// The gate starts one server with a database made from nothing and the made-up trip on it
// (scripts/lib/gate_db.mjs), and gives each check WGP_BASE and WGP_GATE_CARD. This file is the
// check's side of that card. No check writes a trip's id, an account's id or a secret into its
// own text: it asks here.
//
//   import { TRIP, tripPath, HOST, PEOPLE, person, signedIn, d1 } from "./lib/gate_trip.mjs";
//   TRIP                    the trip's id
//   tripPath("#/split")     "/t/<id>/#/split": the app at that trip
//   HOST, person("teo")     { key, name, id, host }: by key, by account id, or the host
//   PEOPLE                  all of them, the host first
//   await signedIn(who)     [{ name: "wgp_session", … }, { name: "wgp_who", … }]: the cookies of a
//                           NEW session of that person, as Network.setCookie takes them. Signed
//                           in through the sign-in routes with the passkey the person signed up
//                           with, so a check may sign out, or end every session, and sign in again.
//   d1(sql)                 rows, read or written in the gate's database
//
// Run alone, a check gets the same: `node scripts/gate.mjs --only <its name>` makes the server
// for that one check, and `node scripts/gate.mjs --serve` keeps one up and prints the two
// settings to run checks against it by hand.
//
// Nothing here waits when it is loaded, so the older CommonJS checks can require() it.

import fs from "node:fs";
import { Passkey } from "../../checks/parity/lib.mjs";
import { Person } from "../../checks/lib/person.mjs";
import { baseUrl, ownServer } from "./browser.mjs";
import { d1On } from "./gate_sql.mjs";

const HOW = "This check drives the gate's own server and its made-up trip. Run it through the gate: "
  + "node scripts/gate.mjs --only <its name>   (or keep a server up with: node scripts/gate.mjs --serve, and set what it prints).";

function readCard() {
  const file = process.env.WGP_GATE_CARD;
  if (!file) throw new Error(`WGP_GATE_CARD isn't set. ${HOW}`);
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { throw new Error(`The gate's card isn't at ${file} (has its server stopped?). ${HOW}`); }
  const card = JSON.parse(text);
  // The card's server is this check's server. Named otherwise, the check would drive one server
  // as the people of another; not named at all, it is named here.
  let named = null;
  try { named = baseUrl(); } catch { /* none named */ }
  if (named && named !== card.origin) throw new Error(`This check was pointed at ${named} but the gate's card is for ${card.origin}: the trip and its people are that server's. ${HOW}`);
  if (!named) ownServer(card.origin);
  return card;
}
const CARD = readCard();
const publicOf = (p) => ({ key: p.key, name: p.name, id: p.id, host: p.host });

/** The server the card is for. */
export const ORIGIN = CARD.origin;
/** The trip's id. */
export const TRIP = CARD.trip;
/** The trip's name, as its host gave it. */
export const TRIP_NAME = CARD.name;
/** The app at this trip: tripPath() is "/t/<id>/", tripPath("#/split") its Split tab. */
export const tripPath = (rest = "") => `/t/${encodeURIComponent(TRIP)}/${rest}`;
/** The trip as the server answers it: tripApi() is "/api/trips/<id>", tripApi("/purchases") a route under it. */
export const tripApi = (rest = "") => `/api/trips/${encodeURIComponent(TRIP)}${rest}`;
/** Everyone on the trip, the host first. */
export const PEOPLE = [...CARD.people].sort((a, b) => Number(b.host) - Number(a.host)).map(publicOf);
/** The trip's host. */
export const HOST = PEOPLE[0];

const entry = (who) => {
  const found = who == null ? CARD.people.find((p) => p.host) : CARD.people.find((p) => p.key === who || p.id === who);
  if (!found) throw new Error(`nobody on the gate's trip is ${JSON.stringify(who)} (${CARD.people.map((p) => p.key).join(", ")})`);
  return found;
};
/** One person: by key ("ada"), by account id, or with nothing, the host. */
export const person = (who) => publicOf(entry(who));

// A passkey's counter must rise at every use, across every check process of the run: tenths of
// a second since the card was made, which no two sign-ins of one person share.
let lastCount = 0;
const nextCount = () => (lastCount = Math.max(lastCount + 1, Math.floor((Date.now() - CARD.made) / 100) + 10));

/**
 * A new session of that person, signed in the way a person is (the sign-in routes, their
 * passkey). Answers the Person (checks/lib/person.mjs): its jar holds the cookies, and it can
 * send requests as them without a browser.
 */
export async function signIn(who) {
  const p = entry(who);
  const someone = new Person(CARD.origin, p.name);
  const passkey = new Passkey(p.passkey.jwk, p.passkey.credId);
  passkey.userHandle = p.passkey.userHandle;
  passkey.counter = nextCount();
  someone.passkeys.push(passkey);
  const done = await someone.signIn(passkey);
  if (done.status !== 200) throw new Error(`${p.name} couldn't sign in on the gate's server: ${done.status} ${done.text.slice(0, 200)}`);
  return someone;
}

/** The cookies of a new session of that person, as Network.setCookie takes them. */
export async function signedIn(who) {
  const someone = await signIn(who);
  const session = someone.jar.cookies.get("wgp_session");
  if (!session) throw new Error(`${someone.name} signed in on the gate's server but was given no session cookie`);
  const cookies = [{ url: CARD.origin, name: "wgp_session", value: session, httpOnly: true, sameSite: "Lax" }];
  const whoCookie = someone.jar.cookies.get("wgp_who");
  if (whoCookie) cookies.push({ url: CARD.origin, name: "wgp_who", value: whoCookie, sameSite: "Lax" });
  return cookies;
}

/**
 * Rows, read or written in the gate's database, while its server runs. Tried again on the local
 * database's passing faults; a statement that is wrong is thrown (scripts/lib/gate_sql.mjs).
 */
export const d1 = (sql, tries = 3) => d1On(CARD.database, sql, tries);

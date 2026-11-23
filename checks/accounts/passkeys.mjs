// Passkeys: making an account, signing in, a second passkey, and everything that must be refused.
// Two different people throughout; each has their own cookies and their own passkeys.

import crypto from "node:crypto";
import { Passkey } from "../parity/lib.mjs";
import { Person, cookieNamed } from "../lib/person.mjs";

const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** A trip with nothing on it, as POST /api/trips takes it. The parts after `trips` use it. */
export const SMALL_TRIP = { id: "check-trip", name: "Check trip", starts_on: "2031-05-01", ends_on: "2031-05-09", default_tz: "Europe/Lisbon" };
/** Its address. */
export const TRIP = `/api/trips/${SMALL_TRIP.id}`;

export async function passkeys({ server, report: t, people }) {
  const { origin } = server;
  const ana = people.ana = new Person(origin, "Ana Check");
  const ben = people.ben = new Person(origin, "Ben Check");

  t.part("Signed out");
  {
    const nobody = new Person(origin, "Nobody");
    // The app's pages and scripts are files, the same for everyone, and are served to anyone.
    // What a signed-out browser can't have is anything of an account or a trip: that is /api.
    const page = await nobody.get("/", { page: true });
    t.ok("the app's page is a file: served signed out, with nothing of anyone's in it", page.status === 200 && page.text.includes("<title>") && page.cookies.length === 0, page.status);
    const asked = await nobody.get("/api/me");
    t.same("a script asking for /api/me gets 401, in JSON", [asked.status, asked.json], [401, { error: "unauthorized" }]);
    t.same("and so does one asking for the trips", (await nobody.get("/api/trips")).status, 401);
    t.same("the sign-in page answers", (await nobody.get("/login", { page: true })).status, 200);
    t.same("its script answers", (await nobody.get("/js/auth.js")).status, 200);
    t.same("the app's other scripts do too", (await nobody.get("/js/store.js")).status, 200);
    const config = await nobody.get("/api/auth/config");
    t.same("GET /api/auth/config says what the site offers", [config.status, config.json?.name, config.json?.signups], [200, "WeGoPlace", "open"]);
  }

  t.part("Making an account");
  {
    const made = await ana.signUp();
    t.same("the first person signs up with a name and a passkey, no code", [made.status, made.json?.ok, made.json?.user?.name], [200, true, "Ana Check"]);
    const cookie = cookieNamed(made, "wgp_session") ?? "";
    t.ok("the session cookie is HttpOnly, SameSite=Lax, Path=/, 180 days", /; HttpOnly/.test(cookie) && /; SameSite=Lax/.test(cookie)
      && /; Path=\//.test(cookie) && /; Max-Age=15552000\b/.test(cookie), cookie.replace(/=[^;]+/, "=…"));
    t.ok("and not Secure on plain http://localhost (Safari would drop it)", !/; Secure/i.test(cookie), cookie.replace(/=[^;]+/, "=…"));
    t.ok("the challenge cookie is cleared", /^wgp_chal=;.*Max-Age=0/.test(cookieNamed(made, "wgp_chal") ?? ""));
    const me = await ana.me();
    t.same("/api/me knows them", [me?.id, me?.name], [ana.user.id, "Ana Check"]);
    t.ok("the first account on an empty site is an account like any other: nobody runs the site", !("isAdmin" in me) && !("isAdmin" in made.json.user), me);
    t.same("and it is on no trip yet", (await ana.get("/api/trips")).json, { trips: [] });

    const second = await ben.signUp();
    t.same("a second person signs up", [second.status, second.json?.user?.name], [200, "Ben Check"]);
    const meBen = await ben.me();
    t.same("and is a different account", meBen?.id !== me?.id, true);

    const rows = server.sql("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM passkeys) AS passkeys, (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM challenges) AS challenges");
    t.same("two accounts, two passkeys, two sessions, no challenge left behind", rows[0], { users: 2, passkeys: 2, sessions: 2, challenges: 0 });
    const kept = server.sql("SELECT token_hash FROM sessions")[0].token_hash;
    const token = decodeURIComponent(ana.jar.cookies.get("wgp_session") ?? "") + decodeURIComponent(ben.jar.cookies.get("wgp_session") ?? "");
    t.ok("the database holds a hash, never the cookie's token", /^[0-9a-f]{64}$/.test(kept) && !token.includes(kept));

    const twin = new Person(origin, "Ana Check");
    const same = await twin.signUp();
    t.same("two accounts may have the same display name", [same.status, same.json?.user?.id !== ana.user.id], [200, true]);
    people.twin = twin;

    for (const [what, name] of [["no name", ""], ["only spaces", "   "], ["41 characters", "x".repeat(41)], ["a control character", "A\u0007B"], ["a number", 7]]) {
      const res = await new Person(origin, "x").post("/api/auth/register/options", { name });
      t.same(`a name that is ${what} is refused`, [res.status, res.json?.error], [400, "name"]);
    }
    const tidy = await new Person(origin, "x").post("/api/auth/register/options", { name: "  Cy   Check  " });
    t.same("spaces around and inside a name are tidied", tidy.json?.user?.name, "Cy Check");
    t.same("a new passkey is asked to keep its account (so signing in needs no name typed)",
      [tidy.json?.authenticatorSelection?.residentKey, tidy.json?.attestation, tidy.json?.rp?.id], ["required", "none", "localhost"]);
  }

  t.part("Refused sign-ups");
  {
    const eve = new Person(origin, "Eve Check");
    const key = Passkey.fresh("eve-1");
    const attempt = async (what, build, want) => {
      const options = await eve.post("/api/auth/register/options", { name: "Eve Check" });
      const res = await eve.post("/api/auth/register/verify", build(options.json));
      t.same(what, [res.status, res.json?.error], want);
      t.ok(`  and it signs nobody in`, !eve.signedIn);
    };
    await attempt("a passkey made for another site's address is refused",
      (o) => key.create({ challenge: o.challenge, origin: "http://localhost:9", rpId: "localhost" }), [400, "not verified"]);
    await attempt("a passkey made for another site's id is refused",
      (o) => key.create({ challenge: o.challenge, origin, rpId: "example.test" }), [400, "not verified"]);
    await attempt("an answer to some other challenge is refused",
      (o) => key.create({ challenge: b64u(crypto.randomBytes(32)), origin, rpId: "localhost" }), [400, "not verified"]);
    await attempt("an answer that isn't one is refused", () => ({ id: "x", response: {} }), [400, "not verified"]);

    // A challenge is used once: the same answer sent again finds nothing.
    const options = await eve.post("/api/auth/register/options", { name: "Eve Check" });
    const chal = eve.jar.cookies.get("wgp_chal");
    const answerOnce = key.create({ challenge: options.json.challenge, origin, rpId: "localhost" });
    const first = await eve.post("/api/auth/register/verify", answerOnce);
    t.same("a good answer makes the account", first.status, 200);
    const replayer = new Person(origin, "Eve Check");
    replayer.jar.cookies.set("wgp_chal", chal);
    const again = await replayer.post("/api/auth/register/verify", answerOnce);
    t.same("the same answer a second time is refused: a challenge is used once", [again.status, again.json?.error], [400, "expired"]);

    // The same passkey for a second account.
    const other = new Person(origin, "Eve Again");
    const o2 = await other.post("/api/auth/register/options", { name: "Eve Again" });
    const dup = await other.post("/api/auth/register/verify", key.create({ challenge: o2.json.challenge, origin, rpId: "localhost" }));
    t.same("a passkey that is already an account's can't make another", [dup.status, dup.json?.error], [409, "already registered"]);
    t.same("and no account is left half made", server.sql("SELECT COUNT(*) AS n FROM users WHERE name = 'Eve Again'")[0].n, 0);

    const none = await new Person(origin, "x").post("/api/auth/register/verify", answerOnce);
    t.same("an answer with no challenge at all is refused", [none.status, none.json?.error], [400, "expired"]);

    // A challenge older than five minutes.
    const late = new Person(origin, "Late Check");
    const lateKey = Passkey.fresh("late-1");
    const o3 = await late.post("/api/auth/register/options", { name: "Late Check" });
    server.sql(`UPDATE challenges SET expires_at = expires_at - 301 WHERE id = '${decodeURIComponent(late.jar.cookies.get("wgp_chal"))}'`);
    const expired = await late.post("/api/auth/register/verify", lateKey.create({ challenge: o3.json.challenge, origin, rpId: "localhost" }));
    t.same("a challenge older than five minutes is refused", [expired.status, expired.json?.error], [400, "expired"]);
    people.eve = eve;
    eve.passkeys.push(key);
  }

  t.part("Signing in");
  {
    const out = await ana.post("/api/auth/logout");
    t.same("signing out answers ok", [out.status, out.json?.ok], [200, true]);
    t.ok("clears the cookie", !ana.signedIn && /^wgp_session=;.*Max-Age=0/.test(cookieNamed(out, "wgp_session") ?? ""));
    t.same("and the session is gone from the database", server.sql(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = '${ana.user.id}'`)[0].n, 0);
    t.same("so /api/me is 401 again", (await ana.get("/api/me")).status, 401);

    const options = await ana.post("/api/auth/login/options");
    t.same("sign-in options name no passkey: the device offers the ones it holds", [options.status, options.json?.allowCredentials, options.json?.rpId], [200, undefined, "localhost"]);

    const back = await ana.signIn();
    t.same("the first person signs in with their passkey", [back.status, back.json?.user?.id], [200, ana.user.id]);
    t.same("/api/me is theirs again", (await ana.me())?.id, ana.user.id);
    const counter = server.sql(`SELECT counter, last_used_at >= created_at AS used FROM passkeys WHERE id = '${ana.passkeys[0].id}'`)[0];
    t.same("the passkey's counter and last use are kept", counter, { counter: 1, used: 1 });

    const phone = ana.otherBrowser();
    const onPhone = await phone.signIn();
    t.same("the same person signs in on a second browser", onPhone.status, 200);
    t.same("and has two sessions", server.sql(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = '${ana.user.id}'`)[0].n, 2);
    people.anaPhone = phone;

    const thief = new Person(origin, "Thief");
    const refused = async (what, opts, want, passkey = ana.passkeys[0]) => {
      const res = await thief.signIn(passkey, opts);
      t.same(what, [res.status, res.json?.error], want);
      t.ok("  and it signs nobody in", !thief.signedIn);
    };
    const wrongKey = Passkey.fresh("x");
    wrongKey.credId = ana.passkeys[0].credId;
    wrongKey.id = ana.passkeys[0].id;
    wrongKey.userHandle = ana.passkeys[0].userHandle;
    wrongKey.counter = 50;
    await refused("another key under the same passkey id is refused", {}, [401, "not verified"], wrongKey);
    await refused("a passkey nobody registered is refused", {}, [401, "unknown passkey"], Passkey.fresh("never-registered"));
    await refused("an answer made for another site's address is refused", { origin: "http://localhost:9" }, [401, "not verified"]);
    await refused("an answer made for another site's id is refused", { rpId: "example.test" }, [401, "not verified"]);
    await refused("a passkey that says it is someone else's account is refused",
      { change: (r) => { r.response.userHandle = ben.passkeys[0].userHandle; } }, [401, "not verified"]);
    await refused("a changed signature is refused", { change: (r) => {
      const sig = Buffer.from(r.response.signature, "base64url");
      sig[sig.length - 1] ^= 1;
      r.response.signature = b64u(sig);
    } }, [401, "not verified"]);
    await refused("an answer with no passkey id is refused", { change: (r) => { delete r.id; } }, [400, "malformed"]);

    // The counter going backwards: a copied passkey.
    const copy = Object.assign(Object.create(Passkey.prototype), ana.passkeys[0], { counter: 0 });
    await refused("a passkey whose counter went backwards is refused", {}, [401, "not verified"], copy);

    const replay = new Person(origin, "Replay");
    const o = await ana.post("/api/auth/login/options");
    const chal = ana.jar.cookies.get("wgp_chal");
    const response = ana.passkeys[0].get({ challenge: o.json.challenge, origin, rpId: "localhost" });
    t.same("a sign-in answer works once", (await ana.post("/api/auth/login/verify", response)).status, 200);
    replay.jar.cookies.set("wgp_chal", chal);
    const twice = await replay.post("/api/auth/login/verify", response);
    t.same("and is refused the second time", [twice.status, twice.json?.error, replay.signedIn], [400, "expired", false]);

    const typed = await new Person(origin, "x").post("/api/auth/login/options", { username: "ana check" });
    t.same("an account made now has no username to sign in by", [typed.status, typed.json?.error], [404, "unknown username"]);
  }

  t.part("A second passkey");
  {
    const added = await ana.addPasskey();
    t.same("a signed-in person adds a passkey", [added.status, added.json?.ok], [200, true]);
    const laptop = new Person(origin, "Ana Check");
    const viaSecond = await laptop.signIn(ana.passkeys[1]);
    t.same("and signs in with it as the same account", [viaSecond.status, viaSecond.json?.user?.id], [200, ana.user.id]);
    const options = await ana.post("/api/auth/passkeys/options");
    t.same("the options for another one name the two it has, so a device doesn't make a duplicate",
      options.json?.excludeCredentials?.map((c) => c.id).sort(), ana.passkeys.map((p) => p.id).sort());
    const dup = await ana.post("/api/auth/passkeys/verify", ana.passkeys[1].create({ challenge: options.json.challenge, origin, rpId: "localhost" }));
    t.same("the same passkey twice is refused", [dup.status, dup.json?.error], [409, "already registered"]);

    // Ben's challenge can't be answered into Ana's account, and a signed-out browser has no such route.
    const benOptions = await ben.post("/api/auth/passkeys/options");
    const stolen = Passkey.fresh("stolen");
    const mixed = new Person(origin, "x");
    mixed.jar.cookies.set("wgp_session", ana.jar.cookies.get("wgp_session"));
    mixed.jar.cookies.set("wgp_chal", ben.jar.cookies.get("wgp_chal"));
    const cross = await mixed.post("/api/auth/passkeys/verify", stolen.create({ challenge: benOptions.json.challenge, origin, rpId: "localhost" }));
    t.same("one person's challenge can't add a passkey to another's account", [cross.status, cross.json?.error], [400, "expired"]);
    t.same("signed out, there is no adding a passkey", (await new Person(origin, "x").post("/api/auth/passkeys/options")).status, 401);
    t.same("the account has exactly its two", server.sql(`SELECT COUNT(*) AS n FROM passkeys WHERE user_id = '${ana.user.id}'`)[0].n, 2);

    const synced = Passkey.fresh("ana-synced");
    synced.extraFlags = 0x08 | 0x10;
    await ana.addPasskey(synced);
    const ways = await ana.get("/api/auth/ways");
    t.same("GET /api/auth/ways lists them, and says which is kept in a synced store",
      ways.json?.passkeys?.map((p) => [p.id, p.synced]), ana.passkeys.map((p) => [p.id, p === synced]));
    t.same("an account made now has no username", ways.json?.username, null);
  }
}

export async function trips({ server, report: t, people }) {
  const { origin } = server;
  const { ana, ben } = people;

  t.part("Signed in is not on a trip");
  {
    // What trips are, and who may reach one, is the trips check's (checks/trips/). Here: an
    // account that is on none reaches none, and loses nothing of its own.
    const made = await ana.post("/api/trips", SMALL_TRIP);
    t.same("one account makes a trip", [made.status, made.json?.trip?.id, made.json?.trip?.host_id], [201, SMALL_TRIP.id, ana.user.id]);
    const tripPaths = [
      ["GET", TRIP, 404, "no such trip"], ["GET", `${TRIP}/rev`, 404, "no such trip"], ["GET", `${TRIP}/events`, 404, "no such trip"],
      ["POST", `${TRIP}/events`, 404, "no such trip"], ["POST", `${TRIP}/purchases`, 404, "no such trip"], ["GET", `${TRIP}/memories`, 404, "no such trip"],
      ["GET", `${TRIP}/media/usage`, 404, "no such trip"], ["GET", `${TRIP}/members`, 404, "no such trip"],
      ["GET", `${TRIP}/areas`, 404, "no such trip"], ["PUT", `${TRIP}/places`, 404, "no such trip"], ["PUT", `${TRIP}/packing/lists`, 404, "no such trip"],
      ["GET", "/api/trip", 404, "no such route"], ["GET", "/api/events", 404, "no such route"], ["GET", "/api/nothing-here", 404, "no such route"],
      ["GET", "/tiles/fonts/Noto%20Sans%20Regular/0-255.pbf", 403, "no trip"],
    ];
    const wrong = [];
    for (const [method, path, status, error] of tripPaths) {
      const res = await ben.call(method, path, method === "GET" ? null : {});
      if (res.status !== status || res.json?.error !== error) wrong.push(`${method} ${path} -> ${res.status} ${res.text.slice(0, 60)}`);
    }
    t.ok(`an account that isn't on it is refused at all ${tripPaths.length} trip addresses tried`, wrong.length === 0, wrong.join("; "));
    t.same("a stored file it has no trip for is not found", (await ben.get("/media/anything")).status, 404);
    t.same("its list of trips is empty", (await ben.get("/api/trips")).json, { trips: [] });
    t.same("it still has /api/me", (await ben.get("/api/me")).status, 200);
    t.same("and can change its own name there", (await ben.call("PATCH", "/api/me", { name: "Ben C." })).json?.me?.name, "Ben C.");
    t.same("a name that isn't one is refused", (await ben.call("PATCH", "/api/me", { name: "" })).status, 400);
    await ben.call("PATCH", "/api/me", { name: "Ben Check" });
    t.same("the app's own files answer", [(await ben.get("/")).status, (await ben.get("/js/store.js")).status], [200, 200]);
    t.same("the wordmark stays public for the sign-in page", (await new Person(origin, "x").get("/img/wordmark.svg")).status, 200);

    const trip = await ana.get(TRIP);
    t.same("the one who made the trip reads it, with one person on it", [trip.status, trip.json?.members?.length], [200, 1]);
    t.same("being refused put the other person on nothing", server.sql("SELECT COUNT(*) AS n FROM trip_members")[0].n, 1);

    const link = await ana.post(`${TRIP}/links`, { uses: 1 });
    const joined = await ben.post(`/api/join/${link.json?.link?.code}`);
    t.same("joining by a link from someone on it puts them on the trip", [joined.status, joined.json?.joined], [200, true]);
    t.same("and then they read it", [(await ben.get(TRIP)).status, (await ben.get("/api/trips")).json?.trips?.map((x) => x.role)], [200, ["member"]]);
  }

  t.part("Another site's page");
  {
    const before = (await ana.me()).name;
    const foreign = await ana.call("PATCH", "/api/me", { name: "Changed" }, { origin: "https://elsewhere.example" });
    t.same("a change sent from another site's page is refused", [foreign.status, foreign.json?.error], [403, "cross site"]);
    const sibling = await ana.call("PATCH", "/api/me", { name: "Changed" }, { origin: null, headers: { "Sec-Fetch-Site": "same-site" } });
    t.same("and from a sibling subdomain", [sibling.status, sibling.json?.error], [403, "cross site"]);
    const opaque = await ana.call("POST", `${TRIP}/events`, {}, { origin: "null" });
    t.same("and from a page with no origin", [opaque.status, opaque.json?.error], [403, "cross site"]);
    t.same("nothing changed", (await ana.me()).name, before);
    const own = await ana.call("PATCH", "/api/me", { initials: "AC" }, { headers: { "Sec-Fetch-Site": "same-origin" } });
    t.same("the app's own page still may", own.status, 200);
    t.same("reading from another site's page is the browser's to stop, not a 403 here", (await ana.get("/api/me", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 200);

    // The routes anyone may ask (signing in, signing out) are refused the same way, before they
    // run: a form on another site, posted to /api/auth/logout as a navigation, carries no cookie,
    // but a browser keeps the cookies its answer sets. So the answer must set none.
    const PUBLIC_POSTS = [
      "/api/auth/logout", "/api/auth/register/options", "/api/auth/register/verify", "/api/auth/login/options", "/api/auth/login/verify",
      "/api/auth/pending/create", "/api/auth/recover", "/api/auth/recover/confirm", "/api/auth/link", "/login/google", "/login/github",
    ];
    const elsewhere = { origin: "https://elsewhere.example", headers: { "Sec-Fetch-Site": "cross-site" } };
    const wrong = [];
    for (const address of PUBLIC_POSTS) {
      for (const [how, body, opts] of [["json", {}, {}], ["form", { next: "/" }, { form: true }]]) {
        const res = await new Person(origin, "Elsewhere").call("POST", address, body, { ...elsewhere, ...opts });
        if (res.status !== 403 || res.json?.error !== "cross site" || res.cookies.length) wrong.push(`${address} (${how}): ${res.status}, ${res.cookies.length} cookies`);
      }
    }
    t.ok(`each of the ${PUBLIC_POSTS.length} public addresses refuses a POST from another site's page, and sets no cookie`, wrong.length === 0, wrong.join("; "));
    // The sign-in page itself is a file. A POST to it reaches no code: nothing runs, no cookie is set.
    const toPage = await new Person(origin, "Elsewhere").call("POST", "/login", { next: "/" }, { ...elsewhere, form: true });
    t.same("a POST to the sign-in page's own address does nothing", [toPage.status, toPage.cookies.length], [405, 0]);
    const formed = await ana.call("POST", "/api/auth/logout", { x: "1" }, { ...elsewhere, form: true });
    t.same("so another site can't sign anyone out: with the cookie or without, the session stands",
      [formed.status, formed.cookies.length, (await ana.get("/api/me")).status], [403, 0, 200]);
    const sibling2 = await new Person(origin, "Elsewhere").call("POST", "/api/auth/logout", {}, { origin: null, headers: { "Sec-Fetch-Site": "same-site" } });
    t.same("nor can a sibling subdomain", [sibling2.status, sibling2.cookies.length], [403, 0]);
    const tool = await new Person(origin, "Elsewhere").call("POST", "/api/auth/logout", {}, { origin: null });
    t.same("a request no browser sent (no Origin, no Sec-Fetch-Site) is still answered", tool.status, 200);
  }

  t.part("An account on no trip, opening the app");
  {
    const cal = new Person(origin, "Cal Check");
    await cal.signUp();
    const app = await cal.get("/", { page: true });
    const member = await ana.get("/", { page: true });
    t.ok("it gets the app's page, the same file as someone on a trip does", app.status === 200 && app.text === member.text && app.text.includes("<title>"), [app.status, member.status]);
    t.same("what tells the app there is no trip to show is the list of trips", (await cal.get("/api/trips")).json, { trips: [] });
  }
}

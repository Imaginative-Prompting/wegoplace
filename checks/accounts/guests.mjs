// Guests (model §22; src/accounts/guests.js): joining a trip by its link with only a name, what a guest may and may
// not do, the host's link that signs a guest in again on a new phone, and a guest becoming an account.

import { Person, cookieNamed } from "../lib/person.mjs";
import { roundTrip } from "./providers.mjs";
import { SESSION_COOKIE, WHO_COOKIE } from "../../src/accounts/sessions.js";

export async function guests({ server, report: t, standin, clients }) {
  const { origin } = server;
  const users = () => server.sql("SELECT COUNT(*) AS n FROM users")[0].n;
  const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
  const host = new Person(origin, "Gia Host");
  const other = new Person(origin, "Hal Host");
  for (const p of [host, other]) if ((await p.signUp()).status !== 200) throw new Error(`couldn't make ${p.name}`);
  const tripOf = async (p, name) => (await p.post("/api/trips", { name, default_tz: "UTC", starts_on: day(1), ends_on: day(5) })).json.trip.id;
  const linkOf = async (p, trip, uses = 10) => (await p.post(`/api/trips/${trip}/links`, { uses })).json.link.code;
  const trip = await tripOf(host, "Guest trip");
  const code = await linkOf(host, trip);

  t.part("Joining with only a name");
  {
    const before = users();
    const anon = new Person(origin, "x");
    const none = await anon.post(`/api/join/${code}`, {});
    const long = await anon.post(`/api/join/${code}`, { name: "N".repeat(41) });
    t.same("no name, or one past 40 characters: refused in words, nobody made, no session",
      [none.status, none.json?.error, long.status, users() - before, anon.signedIn], [400, "name", 400, 0, false]);
    const dead = await anon.post(`/api/join/${"D".repeat(22)}`, { name: "Ana Guest" });
    t.same("a link that doesn't work makes nobody", [dead.status, users() - before, anon.signedIn], [404, 0, false]);
    const foreign = await anon.post(`/api/join/${code}`, { name: "Ana Guest" }, { origin: "https://elsewhere.example" });
    t.same("another site's page can't make one", [foreign.status, users() - before], [403, 0]);
  }
  const ana = new Person(origin, "Ana Guest");
  const joined = await ana.post(`/api/join/${code}`, { name: "  Ana   Guest " });
  const anaMe = await ana.me();
  t.same("joined: on the trip, a guest, signed in on this phone, the name as kept",
    [joined.status, joined.json?.joined, joined.json?.guest, joined.json?.trip?.id, anaMe?.guest, anaMe?.name, ana.signedIn],
    [200, true, true, trip, true, "Ana Guest", true]);
  t.ok("the page's note of who is signed in is set to the guest's id",
    (cookieNamed(joined, "wgp_who") ?? "").startsWith(`wgp_who=${anaMe?.id};`), joined.cookies.join(" | "));
  t.same("the guest is kept with a name and nothing to sign in by", server.sql(
    `SELECT u.guest, (SELECT COUNT(*) FROM passkeys WHERE user_id = u.id) + (SELECT COUNT(*) FROM identities WHERE user_id = u.id)
       + (SELECT COUNT(*) FROM account_emails WHERE user_id = u.id) AS ways, u.note_color IS NOT NULL AS colour FROM users u WHERE u.id = '${anaMe?.id}'`)[0],
    { guest: 1, ways: 0, colour: 1 });
  const ways = await ana.get("/api/auth/ways");
  t.same("their ways in: none yet, and a guest", [ways.json?.passkeys, ways.json?.identities, ways.json?.guest], [[], [], true]);
  const people = (await host.get(`/api/trips/${trip}/people`)).json?.members ?? [];
  t.same("People says who is a guest", people.map((m) => [m.name, m.guest]), [["Gia Host", false], ["Ana Guest", true]]);
  t.same("an account's own join says it isn't one", (await other.post(`/api/join/${await linkOf(host, trip)}`)).json?.guest, false);
  await other.call("DELETE", `/api/trips/${trip}/members/${other.user.id}`);
  {
    const stale = new Person(origin, "Bo Guest");
    stale.jar.cookies.set(SESSION_COOKIE, "x".repeat(43));
    stale.jar.cookies.set(WHO_COOKIE, "someone-gone");
    const r = await stale.post(`/api/join/${code}`, { name: "Bo Guest" });
    t.same("a phone with a cookie that finds no session joins as a guest too, and keeps the new session",
      [r.status, r.json?.guest, (await stale.me())?.name], [200, true, "Bo Guest"]);
    await host.call("DELETE", `/api/trips/${trip}/members/${(await stale.me()).id}`);
  }

  t.part("A guest is on the trip like anyone");
  {
    const T = `/api/trips/${trip}`;
    const wrote = await ana.post(`${T}/messages`, { id: "m-guest-1", body: "Hi from Ana" });
    const bought = await ana.post(`${T}/purchases`, {
      id: "pu-guest-1", description: "Ferry", amount_minor: 2000, currency: "USD", paid_by: anaMe.id, spent_at: Math.floor(Date.now() / 1000),
      split_mode: "weight", shares: [{ user_id: anaMe.id, weight: 1, share_minor: 1000 }, { user_id: host.user.id, weight: 1, share_minor: 1000 }],
    });
    const linked = await ana.post(`${T}/links`, { uses: 1 });
    t.same("writes to the chat and Split, and makes a join link", [wrote.status < 300, bought.status < 300, linked.status], [true, true, 201]);
  }

  t.part("What needs an account");
  {
    const said = (r) => r.status === 403 && r.json?.error === "guest" && (r.json?.reason ?? "").length > 20;
    const make = await ana.post("/api/trips", { name: "Ana's own", default_tz: "UTC" });
    t.ok("making a trip: refused in words", said(make), make.text);
    const offer = await host.post(`/api/trips/${trip}/host`, { to: anaMe.id });
    t.ok("being offered the trip to host: refused in words (the host is told why)", said(offer) && /Ana Guest/.test(offer.json?.reason), offer.text);
    const accept = await ana.post(`/api/trips/${trip}/host/accept`);
    t.ok("accepting to host: refused in words", said(accept), accept.text);
    const mail = await ana.post("/api/account/email", { email: "ana@check.example" });
    t.ok("an email on the account: refused in words", said(mail), mail.text);
    const app = await ana.get("/authorize?response_type=code&client_id=x", { page: true });
    t.ok("connecting an AI app: a page saying to add a way in first, naming this site's (a passkey, Google or GitHub)",
      app.status === 403 && /Add a passkey, Google or GitHub first/.test(app.text), `${app.status} ${app.text.slice(0, 120)}`);
    t.ok("  and each refusal names the same ways, the ones this site has set up", [make, accept, mail].every((r) => /Add a passkey, Google or GitHub\b/.test(r.json?.reason ?? "")),
      [make, accept, mail].map((r) => r.json?.reason).join(" | "));
    t.same("the account page still reads its email row (none)", (await ana.get("/api/account/email")).json?.email, null);

    // The same refusals on a site with neither Google nor GitHub set up (as wegoplace.com until they're registered): they
    // name a passkey alone, and never a way the site hasn't got.
    await server.halt();
    await server.start({ vars: { GOOGLE_CLIENT_ID: "", GITHUB_CLIENT_ID: "" } });
    const config = (await fetch(`${server.origin}/api/auth/config`).then((r) => r.json()));
    const bare = [await ana.post("/api/trips", { name: "Ana's own", default_tz: "UTC" }), await ana.post(`/api/trips/${trip}/host/accept`),
      await ana.post("/api/account/email", { email: "ana@check.example" }), await host.post(`/api/trips/${trip}/host`, { to: anaMe.id })];
    const bareApp = await ana.get("/authorize?response_type=code&client_id=x", { page: true });
    const words = [...bare.map((r) => r.json?.reason ?? ""), bareApp.text];
    t.ok("on a site without Google or GitHub, every refusal and the AI app's page say to add a passkey, and name no other way",
      config.providers?.google === false && config.providers?.github === false && bare.every(said) && bareApp.status === 403
        && words.every((w) => /\ba passkey\b/.test(w) && !/Google|GitHub/.test(w)),
      JSON.stringify({ providers: config.providers, words: words.map((w) => w.slice(0, 140)) }));
    await server.halt();
    await server.start({ vars: { GOOGLE_CLIENT_ID: clients.google.id, GITHUB_CLIENT_ID: clients.github.id } });
  }

  t.part("The host's link to sign a guest in again");
  const other2 = await tripOf(other, "Hal's trip");
  {
    const ben = new Person(origin, "Ben Account");
    await ben.signUp();
    await ben.post(`/api/join/${await linkOf(host, trip)}`);
    const notGuest = await host.post(`/api/trips/${trip}/members/${ben.user.id}/rejoin`);
    t.same("for someone with an account: refused, saying how they get back", [notGuest.status, notGuest.json?.error, /passkey/.test(notGuest.json?.reason ?? "")], [409, "not a guest", true]);
    // An account left with no way in (made by hand: the routes never allow it) is still not a guest: the flag decides.
    server.sql(`INSERT INTO users (id, name, created_at) VALUES ('u-check-noway', 'No Way', 1)`);
    server.sql(`INSERT INTO trip_members (trip_id, user_id, joined_at, rev) VALUES ('${trip}', 'u-check-noway', 1, 0)`);
    const noWay = await host.post(`/api/trips/${trip}/members/u-check-noway/rejoin`);
    t.same("for an account with no way in left: still refused, it isn't a guest", [noWay.status, noWay.json?.error], [409, "not a guest"]);
    server.sql(`UPDATE trip_members SET left_at = 1 WHERE user_id = 'u-check-noway'`);
    const notHost = await ben.post(`/api/trips/${trip}/members/${anaMe.id}/rejoin`);
    t.same("from someone who isn't the host: refused", notHost.status, 403);
    // Ana joins Hal's trip too (the same person on this phone), so Gia's link would reach Hal's trip.
    const second = await ana.post(`/api/join/${await linkOf(other, other2)}`, { name: "ignored when signed in" });
    t.same("the same phone joins another host's trip as the same guest", [second.json?.joined, second.json?.guest, (await ana.me()).id], [true, true, anaMe.id]);
    const elsewhere = await host.post(`/api/trips/${trip}/members/${anaMe.id}/rejoin`);
    t.same("while the guest is on a trip another host hosts: refused, and that trip isn't named",
      [elsewhere.status, elsewhere.json?.error, elsewhere.text.includes("Hal")], [409, "on another trip", false]);
    await ana.call("DELETE", `/api/trips/${other2}/members/${anaMe.id}`);
  }
  {
    const made = await host.post(`/api/trips/${trip}/members/${anaMe.id}/rejoin`);
    const token = made.json?.url?.match(/^\/login\/link\/([A-Za-z0-9_-]{43})$/)?.[1];
    const left = made.json?.expires_at - Math.floor(Date.now() / 1000);
    t.ok("made: a one-use sign-in link, for two hours, kept only as a hash",
      made.status === 201 && token && left > 7100 && left <= 7200 && !JSON.stringify(server.sql("SELECT * FROM signin_links")).includes(token), made.text);
    const newPhone = new Person(origin, "x");
    const used = await newPhone.post("/api/auth/link", { token });
    t.same("the new phone is the same guest", [used.status, (await newPhone.me())?.id, (await newPhone.me())?.guest], [200, anaMe.id, true]);
    t.same("the old phone is signed out", (await ana.get("/api/me")).status, 401);
    t.same("the link works once", (await new Person(origin, "x").post("/api/auth/link", { token })).status, 400);
    ana.jar = newPhone.jar;
    // Made, then the guest joins another host's trip before it is used: it no longer works.
    const later = (await host.post(`/api/trips/${trip}/members/${anaMe.id}/rejoin`)).json?.url?.split("/").pop();
    await ana.post(`/api/join/${await linkOf(other, other2)}`);
    const stale = await new Person(origin, "x").post("/api/auth/link", { token: later });
    t.same("a link made before the guest joined another host's trip doesn't work, and nobody else is signed out",
      [stale.status, (await ana.get("/api/me")).status], [400, 200]);
    await ana.call("DELETE", `/api/trips/${other2}/members/${anaMe.id}`);
  }

  t.part("Becoming an account");
  {
    const rejoin = (await host.post(`/api/trips/${trip}/members/${anaMe.id}/rejoin`)).json?.url?.split("/").pop();
    const added = await ana.addPasskey();
    const me = await ana.me();
    t.same("a guest adds a passkey: the same person, an account now", [added.status, me?.id, me?.guest, (await ana.get("/api/auth/ways")).json?.guest], [200, anaMe.id, false, false]);
    const used = await new Person(origin, "x").post("/api/auth/link", { token: rejoin });
    t.same("a host's link made while they were a guest no longer signs them in", used.status, 400);
    const now = await host.post(`/api/trips/${trip}/members/${anaMe.id}/rejoin`);
    t.same("and no new one can be made", [now.status, now.json?.error], [409, "not a guest"]);
    t.same("they may make a trip now", (await ana.post("/api/trips", { name: "Ana's own", default_tz: "UTC" })).status, 201);
    t.same("and signs in on another phone with the passkey", ana.passkeys[0] ? (await new Person(origin, "x").signIn(ana.passkeys[0])).status : "no passkey was added", 200);

    const cy = new Person(origin, "Cy Guest");
    await cy.post(`/api/join/${code}`, { name: "Cy Guest" });
    const cyId = (await cy.me()).id;
    const google = await roundTrip(standin, cy, "google", { sub: "guest-google-1", name: "Cy" }, { intent: "link" });
    t.same("a guest adds Google from the account page: an account, the same person",
      [google.back.location, (await cy.me())?.id, (await cy.me())?.guest], ["/account?signin=added&with=google", cyId, false]);
    const offer = await host.post(`/api/trips/${trip}/host`, { to: cyId });
    t.same("the trip can be offered to them now", offer.status, 201);
    await host.call("DELETE", `/api/trips/${trip}/host`);
  }

  t.part("A guest's own data, and leaving");
  {
    const di = new Person(origin, "Di Guest");
    await di.post(`/api/join/${code}`, { name: "Di Guest" });
    const diId = (await di.me()).id;
    await di.post(`/api/trips/${trip}/messages`, { id: "m-di-1", body: "Di was here" });
    const exp = await di.get("/api/account/export");
    t.same("the export works for a guest, and says they are one", [exp.status, exp.json?.account?.guest, exp.json?.account?.name], [200, true, "Di Guest"]);
    const gone = await di.call("DELETE", "/api/me", { confirm: "delete" });
    t.same("a guest deletes themself: done and signed out", [gone.status, (await di.get("/api/me")).status], [200, 401]);
    const kept = server.sql(`SELECT u.name, u.deleted_at IS NOT NULL AS deleted, (SELECT COUNT(*) FROM sessions WHERE user_id = u.id) AS sessions FROM users u WHERE u.id = '${diId}'`)[0];
    t.same("what they wrote keeps their name; nothing signs them in", [kept, server.sql("SELECT COUNT(*) AS n FROM messages WHERE id = 'm-di-1'")[0].n], [{ name: "Di Guest", deleted: 1, sessions: 0 }, 1]);
    const eli = new Person(origin, "Eli Guest");
    await eli.post(`/api/join/${code}`, { name: "Eli Guest" });
    const out = await eli.post("/api/auth/logout");
    t.same("a guest signs out: the session goes (the page warns first)", [out.status, (await eli.get("/api/me")).status], [200, 401]);
  }
}

// Getting back in without a passkey: an email on the account (a code, never a link), and the
// one-use link the site's operator makes. And the limits on all of it.

import { Person, cookieNamed } from "../lib/person.mjs";
import { SMALL_TRIP, TRIP } from "./passkeys.mjs";
import { makeLink } from "../../tools/signin-link.mjs";

const codeIn = (mail) => mail?.subject.match(/\b(\d{6})\b/)?.[1] ?? null;

export async function email({ server, report: t, people }) {
  const { origin } = server;
  const { ana, ben } = people;
  const address = "ana@check.example";
  const emailRow = (userId) => server.sql(`SELECT email FROM account_emails WHERE user_id = '${userId}'`)[0]?.email ?? null;

  t.part("An email on the account");
  {
    t.same("the site says it sends account email", (await ana.get("/api/auth/config")).json?.email, true);
    t.same("an account starts with none", (await ana.get("/api/account/email")).json, { offered: true, email: null, verifiedAt: null });
    for (const bad of ["", "ana", "ana@", "ana@check", "a b@check.example", "ana@@check.example", `${"x".repeat(250)}@check.example`]) {
      const res = await ana.post("/api/account/email", { email: bad });
      if (res.status !== 400 || res.json?.error !== "bad email") t.ok(`"${bad.slice(0, 30)}" is refused as an address`, false, res.text);
    }
    t.ok("seven things that aren't addresses are refused", true);

    let mark = server.logMark();
    const asked = await ana.post("/api/account/email", { email: "  Ana@Check.Example " });
    t.same("adding one sends a code to it, tidied to small letters", [asked.status, asked.json?.sentTo, typeof asked.json?.id], [200, address, "string"]);
    const mail = await server.mailTo(address, mark);
    const code = codeIn(mail);
    t.ok("the email carries a 6-digit code and no link", !!code && !/https?:\/\//.test(mail?.text ?? ""), mail);
    t.same("the address isn't the account's until the code comes back", emailRow(ana.user.id), null);
    const kept = server.sql("SELECT code_hash, attempts FROM email_codes")[0];
    t.ok("only the code's hash is kept", /^[0-9a-f]{64}$/.test(kept?.code_hash ?? "") && !JSON.stringify(server.sql("SELECT * FROM email_codes")).includes(code));

    const other = code === "000000" ? "000001" : "000000";
    const miss = await ana.post("/api/account/email/confirm", { id: asked.json.id, code: other });
    t.same("a wrong code says how many tries are left", [miss.status, miss.json], [400, { error: "wrong code", left: 4 }]);
    const thief = await ben.post("/api/account/email/confirm", { id: asked.json.id, code });
    t.same("someone else with the code can't put the address on their account", [thief.status, thief.json?.error, emailRow(ben.user.id)], [400, "wrong code", null]);
    // Ben's try took the code (it was right, and a right code is used once): Ana asks again.
    mark = server.logMark();
    const asked2 = await ana.post("/api/account/email", { email: address });
    const code2 = codeIn(await server.mailTo(address, mark));
    const spaced = await ana.post("/api/account/email/confirm", { id: asked2.json.id, code: `${code2.slice(0, 3)} ${code2.slice(3)}` });
    t.same("the right code, typed with a space, makes the address the account's", [spaced.status, spaced.json?.email, emailRow(ana.user.id)], [200, address, address]);
    const twice = await ana.post("/api/account/email/confirm", { id: asked2.json.id, code: code2 });
    t.same("a code works once", [twice.status, twice.json?.error], [400, "code used up"]);
    t.same("the account page reads it back", (await ana.get("/api/account/email")).json?.email, address);

    mark = server.logMark();
    const benAsks = await ben.post("/api/account/email", { email: address });
    const benCode = codeIn(await server.mailTo(address, mark));
    const taken = await ben.post("/api/account/email/confirm", { id: benAsks.json.id, code: benCode });
    t.same("an address is on one account only", [taken.status, taken.json?.error, emailRow(ben.user.id)], [409, "email taken", null]);
  }

  t.part("Getting back in by email");
  {
    const lost = new Person(origin, "Ana Check");
    const foreign = await lost.post("/api/auth/recover", { email: address }, { origin: "https://elsewhere.example" });
    t.same("only this site's own page may ask", [foreign.status, foreign.json?.error], [403, "cross site"]);

    let mark = server.logMark();
    const nobody = await lost.post("/api/auth/recover", { email: "nobody@check.example" });
    const known = await lost.post("/api/auth/recover", { email: address });
    t.same("asking answers the same for an address on no account and one on an account",
      [nobody.status, Object.keys(nobody.json ?? {}), known.status, Object.keys(known.json ?? {})], [200, ["id"], 200, ["id"]]);
    const mail = await server.mailTo(address, mark);
    const stray = await server.mailTo("nobody@check.example", mark, { within: 1500 });
    t.ok("a code goes only to the address that is on an account", !!codeIn(mail) && stray === null, { mail, stray });
    const code = codeIn(mail);

    const guess = await lost.post("/api/auth/recover/confirm", { id: nobody.json.id, code });
    t.same("the unknown address's code opens nothing", [guess.status, guess.json?.error, lost.signedIn], [400, "wrong code", false]);
    const other = code === "000000" ? "000001" : "000000";
    const tries = [];
    for (let i = 0; i < 5; i++) tries.push((await lost.post("/api/auth/recover/confirm", { id: known.json.id, code: other })).json);
    t.same("five wrong codes use the code up", tries.map((j) => j?.left ?? j?.error), [4, 3, 2, 1, "code used up"]);
    const tooLate = await lost.post("/api/auth/recover/confirm", { id: known.json.id, code });
    t.same("after that even the right one is refused", [tooLate.status, tooLate.json?.error, lost.signedIn], [400, "code used up", false]);

    mark = server.logMark();
    const again = await lost.post("/api/auth/recover", { email: address });
    const code2 = codeIn(await server.mailTo(address, mark));
    const elsewhere = await lost.post("/api/auth/recover/confirm", { id: again.json.id, code: code2 }, { origin: "https://elsewhere.example" });
    t.same("another site's page can't hand in a code", [elsewhere.status, lost.signedIn], [403, false]);
    mark = server.logMark();
    const back = await lost.post("/api/auth/recover/confirm", { id: again.json.id, code: code2 });
    t.same("the right code signs the account in", [back.status, back.json?.user?.id, (await lost.me())?.id], [200, ana.user.id, ana.user.id]);
    const told = await server.mailTo(address, mark);
    t.ok("and the address is told it was used", /got back into/.test(told?.subject ?? ""), told);
    const reuse = await new Person(origin, "x").post("/api/auth/recover/confirm", { id: again.json.id, code: code2 });
    t.same("the code doesn't work a second time", reuse.status, 400);
    const added = await lost.addPasskey();
    t.same("signed in that way, they add a passkey for the new device", added.status, 200);
    ana.passkeys.push(lost.passkeys.at(-1));
  }

  t.part("Changing and removing the address");
  {
    let mark = server.logMark();
    const asked = await ana.post("/api/account/email", { email: "ana.new@check.example" });
    const code = codeIn(await server.mailTo("ana.new@check.example", mark));
    mark = server.logMark();
    const changed = await ana.post("/api/account/email/confirm", { id: asked.json.id, code });
    t.same("another address replaces the first", [changed.status, changed.json?.email], [200, "ana.new@check.example"]);
    const told = await server.mailTo(address, mark);
    t.ok("the old address is told, with the new one masked", /was changed/.test(told?.subject ?? "") && told.text.includes("a…@check.example") && !told.text.includes("ana.new@"), told);

    const removed = await ana.call("DELETE", "/api/account/email");
    t.same("removing it leaves the account with none", [removed.status, removed.json, emailRow(ana.user.id)], [200, { email: null }, null]);
    mark = server.logMark();
    const ask = await new Person(origin, "x").post("/api/auth/recover", { email: "ana.new@check.example" });
    t.same("and then nothing is sent to it", [ask.status, await server.mailTo("ana.new@check.example", mark, { within: 1500 })], [200, null]);
  }

  t.part("How many codes an hour");
  {
    const cy = people.cy = new Person(origin, "Cy Check");
    await cy.signUp();
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await cy.post("/api/account/email", { email: "cy@check.example" })).status);
    t.same("an account is sent five codes an hour and then refused", statuses, [200, 200, 200, 200, 200, 429]);
    const asker = new Person(origin, "x");
    const more = await asker.post("/api/auth/recover", { email: "cy@check.example" });
    t.same("and the address takes no more from anyone that hour", [more.status, more.json?.error], [429, "too many codes"]);
    const elsewhere = await cy.post("/api/account/email", { email: "cy.other@check.example" });
    t.same("nor does the account get more by naming another address", elsewhere.status, 429);
  }
}

export async function link({ server, report: t, people }) {
  const { origin } = server;
  const { ben } = people;

  t.part("The operator's one-use link");
  const made = makeLink({ who: ben.user.id, origin, hours: 2 });
  const token = made.url.split("/").pop();
  server.sql(made.sql);
  const stored = server.sql("SELECT token_hash, user_id FROM signin_links");
  t.ok("the tool's SQL files one row for that account, holding a hash and not the token",
    stored.length === 1 && stored[0].user_id === ben.user.id && /^[0-9a-f]{64}$/.test(stored[0].token_hash) && !made.sql.includes(token));

  const visitor = new Person(origin, "Ben Check");
  const page = await visitor.get(new URL(made.url).pathname, { page: true });
  t.same("opening the link shows the sign-in page and signs nobody in", [page.status, visitor.signedIn], [200, false]);
  t.same("and takes nothing, so a link preview can't use it up", server.sql("SELECT COUNT(*) AS n FROM signin_links")[0].n, 1);
  const foreign = await visitor.post("/api/auth/link", { token }, { origin: "https://elsewhere.example" });
  t.same("another site's page can't use it", [foreign.status, server.sql("SELECT COUNT(*) AS n FROM signin_links")[0].n], [403, 1]);
  const wrong = await visitor.post("/api/auth/link", { token: `${token.slice(0, -4)}AAAA` });
  t.same("a token that isn't the link's opens nothing", [wrong.status, wrong.json?.error, visitor.signedIn], [400, "expired", false]);
  const used = await visitor.post("/api/auth/link", { token });
  t.same("the button signs that account in", [used.status, used.json?.user?.id, (await visitor.me())?.id], [200, ben.user.id, ben.user.id]);
  t.ok("with a real session cookie", /Max-Age=15552000/.test(cookieNamed(used, "wgp_session") ?? ""));
  const again = await new Person(origin, "x").post("/api/auth/link", { token });
  t.same("a second use is refused", [again.status, again.json?.error], [400, "expired"]);

  const old = makeLink({ who: ben.user.id, origin, hours: 1, now: Math.floor(Date.now() / 1000) - 3601 });
  server.sql(old.sql);
  const late = await new Person(origin, "x").post("/api/auth/link", { token: old.url.split("/").pop() });
  t.same("a link past its time is refused", [late.status, late.json?.error], [400, "expired"]);

  server.sql(makeLink({ who: "nobody-by-this-name", origin }).sql);
  t.same("the SQL for an account that doesn't exist files nothing", server.sql("SELECT COUNT(*) AS n FROM signin_links")[0].n, 0);
  let refused = 0;
  for (const who of ["x' OR '1'='1", "a;b", ""]) { try { makeLink({ who, origin }); } catch { refused += 1; } }
  t.same("the tool refuses a name that could change its SQL", refused, 3);
  t.same("a malformed link address isn't the sign-in page", (await new Person(origin, "x").get("/login/link/short", { page: true })).status, 302);
}

// A limit is counted per minute of the clock, by Cloudflare, and no check can set that clock.
// So this part runs the server with small limits (run.mjs starts it with LIMITS_HERE): small
// enough that a slow, busy machine still reaches them, and checks that wrangler.jsonc keeps the
// real ones. What is checked doesn't depend on speed: who is counted, and what happens at the
// limit, not how many fit in sixty seconds.
export const LIMITS_HERE = { AUTH_LIMITER: 10, SESSION_LIMITER: 50 };

/** Sends batches until the first 429, or `most` requests. Answers the statuses in order. */
async function untilRefused(send, most, batch) {
  const statuses = [];
  while (!statuses.includes(429) && statuses.length < most) {
    statuses.push(...(await Promise.all(Array.from({ length: batch }, (_, k) => send(statuses.length + k)))).map((r) => r.status));
  }
  return statuses;
}

export async function limits({ server, report: t }) {
  const { origin } = server;
  t.part("Limits per connection");
  t.same("wrangler.jsonc keeps 60 sign-in starts and 1,200 unknown cookies a minute for each connection (this part runs smaller ones)",
    [server.configured.limits.AUTH_LIMITER, server.configured.limits.SESSION_LIMITER], [60, 1200]);
  const A = LIMITS_HERE.AUTH_LIMITER;
  const flood = new Person(origin, "Flood", "10.9.9.9");
  const starts = await untilRefused(() => flood.post("/api/auth/login/options"), A * 4, 1);
  const before = starts.indexOf(429);
  // Refused at the limit, or later when the count's minute turned over on the way (it can turn
  // once while so few are sent): never before it.
  t.ok(`one connection gets its sign-in starts (${A} here), then 429`, before >= A && before <= A * 2 && starts.slice(0, before).every((s) => s === 200), starts.join(","));
  const last = await flood.post("/api/auth/login/options");
  t.same("the refusal says when to come back", [last.status, last.json?.error, last.headers.find(([k]) => k === "retry-after")?.[1]], [429, "too many", "60"]);
  const signups = await flood.post("/api/auth/register/options", { name: "Flood" });
  t.same("sign-up starts are on the same count", signups.status, 429);
  const neighbor = new Person(origin, "Neighbor", "10.9.9.10");
  t.same("another connection isn't held back by it", (await neighbor.post("/api/auth/login/options")).status, 200);

  t.part("A group on one network");
  {
    // Everyone at one lodging comes from one address. What is limited is cookies that find no
    // session; people who are signed in are not counted for their own use, however much the map
    // and the photos ask for: one count when they start, and one each SESSION_CACHE_SECONDS.
    const S = LIMITS_HERE.SESSION_LIMITER;
    const lodge = "10.7.7.7";
    const group = [];
    for (const name of ["Ines Check", "Jo Check", "Kit Check"]) {
      const person = new Person(origin, name, lodge);
      await person.signUp();
      server.sql(`INSERT INTO trip_members (trip_id, user_id, joined_at) VALUES ('${SMALL_TRIP.id}', '${person.user.id}', 1)`);
      group.push(person);
    }
    // Each sends 900 requests, 2,700 from the one address: /api, /media, /tiles. Counted as
    // requests, they would pass the limit within the first minute however slowly they go.
    const ASKS = ["/api/me", TRIP, "/media/o/no/such-file.jpg", "/tiles/no-such-tile"];
    const sent = { total: 0, limited: 0, other: new Set() };
    const started = Date.now();
    await Promise.all(group.map(async (person) => {
      for (let i = 0; i < 900; i += 20) {
        const answers = await Promise.all(Array.from({ length: 20 }, (_, k) => person.get(ASKS[(i + k) % ASKS.length])));
        for (const res of answers) { sent.total += 1; if (res.status === 429) sent.limited += 1; else if (![200, 404].includes(res.status)) sent.other.add(res.status); }
      }
    }));
    const took = (Date.now() - started) / 1000;
    const perMinute = Math.round((sent.total / took) * 60);
    t.ok(`three people signed in on one address send ${sent.total} requests (${perMinute} a minute, against a limit of ${S}) and none is answered 429`,
      sent.total === 2700 && sent.limited === 0 && sent.other.size === 0 && perMinute > S * 4, { ...sent, other: [...sent.other], took });

    // Cookies that find no session, from that same address: each is counted, and past the limit
    // the address is answered 429 without the database being asked. The group's own counts (one
    // each per 30 s) share the address's minute, so the first 429 comes a few short of the limit
    // at most; or later, by up to one limit's worth, when the minute turns over on the way.
    const stranger = (i) => { const p = new Person(origin, "x", lodge); p.jar.cookies.set("wgp_session", `made-up-${i}-${"x".repeat(30)}`); return p; };
    const firstPart = (await Promise.all(Array.from({ length: S - 20 }, (_, i) => stranger(i).get("/api/me")))).map((r) => r.status);
    // The group goes on using the app (a count each, now, while there is room)...
    const using = await Promise.all(group.map((person) => person.get("/api/me")));
    // ...and more made-up cookies come, until the address is turned away.
    const rest = await untilRefused((i) => stranger(S + i).get("/api/me"), S * 6, 5);
    const statuses = [...firstPart, ...rest];
    const turned = statuses.indexOf(429);
    t.ok(`made-up cookies from that address: every one is turned away, with a 401, and past the limit (${S} here) with a 429`,
      statuses.every((s) => s === 401 || s === 429) && turned >= S - 12 && turned <= S * 2 && using.every((r) => r.status === 200),
      `401 × ${statuses.filter((s) => s === 401).length} before the first 429 at ${turned}; the group: ${using.map((r) => r.status)}`);
    const still = await Promise.all(group.map((person) => person.get("/api/me")));
    t.same("and the group, mid-use, is still answered while that address is over its limit", still.map((r) => r.status), [200, 200, 200]);
    const same = stranger(1);
    const repeats = await Promise.all(Array.from({ length: 40 }, () => same.get("/api/me")));
    t.ok("one made-up cookie sent again and again is answered 401 from memory, not 429", repeats.every((r) => r.status === 401), repeats.map((r) => r.status).join(","));
  }
}

// Signing in with Google and GitHub, against checks/lib/standin.mjs playing both.

import { Person, cookieNamed } from "../lib/person.mjs";

/** The trip to a provider and back, as the browser makes it. `who` is the person the provider says it is. */
export async function roundTrip(standin, person, provider, who, { intent, next, deny = false, state, reuse } = {}) {
  const form = {};
  if (intent) form.intent = intent;
  if (next) form.next = next;
  const started = await person.call("POST", `/login/${provider}`, form, { form: true });
  if (started.status !== 303 || !started.location?.startsWith(standin.origin)) return { started, back: started };
  const grant = reuse ?? standin.allow(provider, started.location, who);
  const query = deny ? `error=access_denied&state=${grant.state}` : `code=${grant.code}&state=${state ?? grant.state}`;
  const back = await person.get(`/login/${provider}/callback?${query}`, { page: true });
  return { started, grant, back };
}

export async function providers({ server, report: t, people, standin }) {
  const { origin } = server;
  const { ana, ben } = people;
  const gia = people.gia = new Person(origin, "Gia Check");
  const hugo = people.hugo = new Person(origin, "Hugo Check");
  const giaGoogle = { sub: "google-sub-1001", name: "Gia   Check" };
  const hugoGithub = { id: 4242001, login: "hugo-check", name: "Hugo Check" };
  const identities = (userId) => server.sql(`SELECT provider, subject, label FROM identities WHERE user_id = '${userId}' ORDER BY provider`);

  t.part("Google and GitHub: a new account");
  {
    const config = await gia.get("/api/auth/config");
    t.same("the site says both are offered", config.json?.providers, { google: true, github: true });

    const elsewhere = await gia.call("POST", "/login/google", {}, { form: true, origin: "https://elsewhere.example" });
    t.same("leaving for Google only starts from this site's own page", elsewhere.status, 403);
    const byGet = await gia.get("/login/google", { page: true });
    t.same("a GET of that address starts nothing: back to the sign-in page", [byGet.status, byGet.location, gia.jar.cookies.has("wgp_oauth")], [303, "/login", false]);

    const { started, back } = await roundTrip(standin, gia, "google", giaGoogle, { next: "/?tab=plan" });
    t.ok("the browser is sent to Google with a short-lived cookie for the trip", started.status === 303 && /Max-Age=600/.test(cookieNamed(started, "wgp_oauth") ?? ""));
    t.same("back from Google with a sign-in nobody has used: the create step, not signed in", [back.status, back.location, gia.signedIn], [303, "/login/new", false]);
    t.ok("the trip's cookie is cleared and the waiting sign-in has its own", /Max-Age=0/.test(cookieNamed(back, "wgp_oauth") ?? "") && /Max-Age=900/.test(cookieNamed(back, "wgp_pending") ?? ""));
    t.same("nothing is an account yet", server.sql("SELECT COUNT(*) AS n FROM identities")[0].n, 0);
    t.same("the create step's page answers", (await gia.get("/login/new", { page: true })).status, 200);
    const pending = await gia.get("/api/auth/pending");
    t.same("it knows what is waiting: which provider, a name to start from, where it was going",
      [pending.status, pending.json?.providers, pending.json?.name, pending.json?.next], [200, ["google"], "Gia Check", "/?tab=plan"]);
    const noName = await gia.post("/api/auth/pending/create", { name: " " });
    t.same("no name, no account", [noName.status, noName.json?.error], [400, "name"]);
    const foreign = await gia.post("/api/auth/pending/create", { name: "Gia Check" }, { origin: "https://elsewhere.example" });
    t.same("another site's page can't finish it", [foreign.status, foreign.json?.error], [403, "cross site"]);
    const made = await gia.post("/api/auth/pending/create", { name: "Gia Check" });
    t.same("a name makes the account and signs it in", [made.status, made.json?.ok, made.json?.user?.name, made.json?.next, gia.signedIn],
      [200, true, "Gia Check", "/?tab=plan", true]);
    gia.user = made.json.user;
    t.same("the account has Google's own id for the person, and no username", identities(gia.user.id), [{ provider: "google", subject: "google-sub-1001", label: "Gia Check" }]);
    t.same("the waiting sign-in is gone", [(await gia.get("/api/auth/pending")).status, server.sql("SELECT COUNT(*) AS n FROM challenges WHERE kind = 'pending'")[0].n], [404, 0]);

    const gh = await roundTrip(standin, hugo, "github", hugoGithub);
    t.same("GitHub the same way", [gh.back.status, gh.back.location], [303, "/login/new"]);
    const hugoMade = await hugo.post("/api/auth/pending/create", { name: "Hugo Check" });
    hugo.user = hugoMade.json?.user;
    t.same("its account has GitHub's numeric id, labeled with the login", identities(hugo.user?.id), [{ provider: "github", subject: "4242001", label: "@hugo-check" }]);

    const dump = JSON.stringify(server.sql("SELECT * FROM identities")) + JSON.stringify(server.sql("SELECT * FROM users")) + JSON.stringify(server.sql("SELECT * FROM challenges"));
    t.ok("no email address was read or kept anywhere", !dump.includes("never-read@check.example") && !/@check\.example/.test(dump));
  }

  t.part("Google and GitHub: signing in");
  {
    await gia.post("/api/auth/logout");
    const { back } = await roundTrip(standin, gia, "google", { ...giaGoogle, name: "Gia Renamed" }, { next: "/?tab=plan" });
    t.same("the same Google account signs in to the same account, and lands where it was going", [back.status, back.location, (await gia.me())?.id], [303, "/?tab=plan", gia.user.id]);
    t.same("the account's own name isn't changed by Google's", (await gia.me())?.name, "Gia Check");

    const out = new Person(origin, "x");
    const evil = await roundTrip(standin, out, "google", giaGoogle, { next: "//elsewhere.example/x" });
    t.same("a next that points off the site is dropped", evil.back.location, "/");
    const sneaky = await roundTrip(standin, new Person(origin, "x"), "google", giaGoogle, { next: "/\\elsewhere.example" });
    t.same("and so is one a browser would read as another site", sneaky.back.location, "/");

    const denied = await roundTrip(standin, new Person(origin, "x"), "google", giaGoogle, { deny: true, next: "/?tab=plan" });
    t.same("saying no at Google comes back to the sign-in page saying so", denied.back.location, "/login?error=cancelled&with=google&next=%2F%3Ftab%3Dplan");

    const p = new Person(origin, "x");
    const wrongState = await roundTrip(standin, p, "google", giaGoogle, { state: "not-the-state-this-browser-was-given" });
    t.same("a callback with another state is refused", [wrongState.back.location, p.signedIn], ["/login?error=expired&with=google", false]);
    const q = new Person(origin, "x");
    const first = await roundTrip(standin, q, "github", hugoGithub);
    t.same("(a GitHub sign-in to replay)", [first.back.status, q.signedIn], [303, true]);
    const r = new Person(origin, "x");
    const replay = await r.get(`/login/github/callback?code=${first.grant.code}&state=${first.grant.state}`, { page: true });
    t.same("a callback with no trip under way is refused", [replay.location, r.signedIn], ["/login?error=expired&with=github", false]);
    const crossed = new Person(origin, "x");
    const startedGoogle = await crossed.call("POST", "/login/google", {}, { form: true });
    const g = standin.allow("google", startedGoogle.location, giaGoogle);
    const wrongProvider = await crossed.get(`/login/github/callback?code=${g.code}&state=${g.state}`, { page: true });
    t.same("a trip to Google can't come back as GitHub", [wrongProvider.location, crossed.signedIn], ["/login?error=expired&with=github", false]);

    for (const [what, lie] of [
      ["for another site", { aud: "someone-elses-client" }], ["from another issuer", { iss: "https://accounts.elsewhere.example" }],
      ["with another nonce", { nonce: "not-the-nonce-this-trip-was-given" }], ["that has run out", { exp: Math.floor(Date.now() / 1000) - 600 }],
      ["with no person in it", { sub: "" }],
    ]) {
      const v = new Person(origin, "x");
      standin.lieOnce(lie);
      const res = await roundTrip(standin, v, "google", giaGoogle);
      t.same(`an ID token ${what} signs nobody in`, [res.back.location, v.signedIn], ["/login?error=provider&with=google", false]);
    }
    const before = standin.seen.length;
    const s = new Person(origin, "x");
    const one = await roundTrip(standin, s, "google", giaGoogle);
    t.same("(a good trip)", s.signedIn, true);
    const s2 = new Person(origin, "x");
    const st = await s2.call("POST", "/login/google", {}, { form: true });
    const g2 = standin.allow("google", st.location, giaGoogle);
    const used = await s2.get(`/login/google/callback?code=${one.grant.code}&state=${g2.state}`, { page: true });
    t.same("a code Google already took is refused", [used.location, s2.signedIn], ["/login?error=provider&with=google", false]);
    const mine = standin.seen.slice(before);
    t.ok("the server proved each trip to the provider with its PKCE verifier and its secret", mine[0]?.ok === true && mine.at(-1)?.ok === false && mine.at(-1)?.why === "unknown or used code", mine);
    t.ok("the provider failures are in the server's log by kind, with no code or secret", /"signin_error":"google"/.test(server.log()) && !server.log().includes(standin.secrets.google) && !server.log().includes(standin.secrets.github));
  }

  t.part("Adding and removing ways to sign in");
  {
    const anaGithub = { id: 4242002, login: "ana-check", name: "Ana Check" };
    const linked = await roundTrip(standin, ana, "github", anaGithub, { intent: "link" });
    t.same("a signed-in person adds GitHub from their account page", linked.back.location, "/account?signin=added&with=github");
    const again = await roundTrip(standin, ana, "github", anaGithub, { intent: "link" });
    t.same("adding it again says it's already theirs", again.back.location, "/account?signin=already&with=github");
    const taken = await roundTrip(standin, ben, "github", anaGithub, { intent: "link" });
    t.same("another person can't add the same GitHub account", [taken.back.location, identities(ben.user.id).length], ["/account?signin=taken&with=github", 0]);
    const cancelled = await roundTrip(standin, ben, "google", { sub: "x", name: "x" }, { intent: "link", deny: true });
    t.same("saying no at the provider comes back to the account page", cancelled.back.location, "/account?signin=cancelled&with=google");
    const signedOut = await roundTrip(standin, new Person(origin, "x"), "github", anaGithub, { intent: "link" });
    t.same("adding one needs a session", signedOut.started.location, "/login?error=signed-out&next=%2Faccount");

    const viaGithub = new Person(origin, "Ana Check");
    const inWith = await roundTrip(standin, viaGithub, "github", anaGithub);
    t.same("and then signs in with it, as the same account", [inWith.back.status, (await viaGithub.me())?.id], [303, ana.user.id]);

    const ways = await ana.get("/api/auth/ways");
    t.same("the account page's list has it", ways.json?.identities?.map((i) => [i.provider, i.subject, i.label]), [["github", "4242002", "@ana-check"]]);

    const notMine = await ben.call("DELETE", "/api/auth/ways/github/4242002");
    t.same("nobody removes someone else's", [notMine.status, identities(ana.user.id).length], [404, 1]);
    const gone = await ana.call("DELETE", "/api/auth/ways/github/4242002");
    t.same("its owner removes it", [gone.status, identities(ana.user.id).length], [200, 0]);
    t.same("an unknown provider is a 404", (await ana.call("DELETE", "/api/auth/ways/gitlab/1")).status, 404);
    t.same("a broken escape in the address is refused, not a crash", (await ana.call("DELETE", "/api/auth/ways/github/%E0%A4%A")).status, 400);

    const last = await gia.call("DELETE", "/api/auth/ways/google/google-sub-1001");
    t.same("the last way to sign in can't be removed", [last.status, last.json?.error, identities(gia.user.id).length], [400, "last way", 1]);
    await gia.addPasskey();
    const now = await gia.call("DELETE", "/api/auth/ways/google/google-sub-1001");
    t.same("with a passkey added, Google can go", [now.status, identities(gia.user.id).length], [200, 0]);
    const lastKey = await gia.call("DELETE", `/api/auth/ways/passkey/${gia.passkeys[0].id}`);
    t.same("and then the passkey is the last way and stays", [lastKey.status, lastKey.json?.error], [400, "last way"]);
    const both = await Promise.all([
      ana.call("DELETE", `/api/auth/ways/passkey/${ana.passkeys[1].id}`), ana.call("DELETE", `/api/auth/ways/passkey/${ana.passkeys[2].id}`),
    ]);
    t.same("two passkeys removed at once both go, the third stays", [both.map((r) => r.status), server.sql(`SELECT COUNT(*) AS n FROM passkeys WHERE user_id = '${ana.user.id}'`)[0].n], [[200, 200], 1]);
    ana.passkeys.length = 1;
    t.same("someone else's passkey is a 404", (await ben.call("DELETE", `/api/auth/ways/passkey/${ana.passkeys[0].id}`)).status, 404);
  }

  t.part("The create step: add it to the account you have");
  {
    // A Google account nobody has used, by someone who already has an account with a passkey.
    const benGoogle = { sub: "google-sub-2002", name: "Ben Check" };
    const b = ben.otherBrowser();
    const trip = await roundTrip(standin, b, "google", benGoogle, { next: "/?tab=split" });
    t.same("(an unused Google sign-in waits on the create step)", trip.back.location, "/login/new");
    const signed = await b.signIn(ben.passkeys[0]);
    t.same("they sign in with their passkey there", signed.status, 200);
    const attached = await b.post("/api/auth/pending/attach");
    t.same("and the waiting sign-in joins their account", [attached.status, attached.json?.added, attached.json?.next, identities(ben.user.id).map((i) => i.subject)],
      [200, ["google"], "/?tab=split", ["google-sub-2002"]]);
    t.same("with nothing waiting, attach adds nothing", (await b.post("/api/auth/pending/attach")).json, { added: [], next: "/" });

    // The same, signing in with the other provider from the create step.
    const benGithub = { id: 4242003, login: "ben-check", name: "Ben Check" };
    const c = ben.otherBrowser();
    const unknown = await roundTrip(standin, c, "github", benGithub);
    t.same("(an unused GitHub sign-in waits)", unknown.back.location, "/login/new");
    const viaGoogle = await roundTrip(standin, c, "google", benGoogle, { intent: "attach" });
    t.same("signing in with Google from the create step signs in and adds GitHub to that account",
      [viaGoogle.back.location, (await c.me())?.id, identities(ben.user.id).map((i) => i.provider)], ["/", ben.user.id, ["github", "google"]]);

    // Two unused sign-ins: both wait, and one account gets both.
    const ida = people.ida = new Person(origin, "Ida Check");
    await roundTrip(standin, ida, "google", { sub: "google-sub-3003", name: "Ida Check" });
    const second = await roundTrip(standin, ida, "github", { id: 4242004, login: "ida-check", name: "Ida" }, { intent: "attach" });
    t.same("from the create step, another unused sign-in joins the one waiting", second.back.location, "/login/new?error=unknown&with=github");
    t.same("both wait", (await ida.get("/api/auth/pending")).json?.providers, ["google", "github"]);
    const made = await ida.post("/api/auth/pending/create", { name: "Ida Check" });
    ida.user = made.json?.user;
    t.same("and one account is made with both", identities(ida.user?.id).map((i) => i.provider), ["github", "google"]);

    // Taken meanwhile.
    const late = new Person(origin, "Late Check");
    const jo = { id: 4242005, login: "jo-check", name: "Jo" };
    await roundTrip(standin, late, "github", jo);
    await roundTrip(standin, ana, "github", jo, { intent: "link" });
    const lost = await late.post("/api/auth/pending/create", { name: "Late Check" });
    t.same("a sign-in another account took while it waited makes no account", [lost.status, lost.json?.error, late.signedIn, server.sql("SELECT COUNT(*) AS n FROM users WHERE name = 'Late Check'")[0].n],
      [409, "taken", false, 0]);
    await ana.call("DELETE", "/api/auth/ways/github/4242005");
  }
}

/** With new accounts paused and Google switched off: run on a server restarted that way. */
export async function paused({ server, report: t, people, standin }) {
  const { origin } = server;
  const { ana, ben } = people;
  t.part("New accounts paused, Google off");
  const config = await new Person(origin, "x").get("/api/auth/config");
  {
    const trip = (await ana.post("/api/trips", { name: "Paused trip", default_tz: "UTC" })).json?.trip?.id;
    const code = (await ana.post(`/api/trips/${trip}/links`, { uses: 5 })).json?.link?.code;
    const before = server.sql("SELECT COUNT(*) AS n FROM users")[0].n;
    const g = new Person(origin, "x");
    const r = await g.post(`/api/join/${code}`, { name: "Paused Guest" });
    t.same("joining with only a name is refused too (a guest is someone new), nobody made",
      [r.status, r.json?.error, server.sql("SELECT COUNT(*) AS n FROM users")[0].n - before, g.signedIn], [503, "signups paused", 0, false]);
  }
  t.same("the site says so", [config.json?.signups, config.json?.providers, config.json?.email], ["paused", { google: false, github: true }, false]);
  const refused = await new Person(origin, "x").post("/api/auth/register/options", { name: "New Check" });
  t.same("a passkey sign-up is refused before the device is asked", [refused.status, refused.json?.error], [503, "signups paused"]);
  const before = server.sql("SELECT COUNT(*) AS n FROM users")[0].n;
  // Counted against what the earlier parts left waiting (a sign-in started and never finished
  // stays until it runs out), so this holds whichever parts ran before it.
  const waiting = () => server.sql("SELECT COUNT(*) AS n FROM challenges WHERE kind IN ('pending', 'oauth')")[0].n;
  const waitingBefore = waiting();
  const v = new Person(origin, "x");
  const unknown = await roundTrip(standin, v, "github", { id: 4242999, login: "new-check", name: "New" });
  t.same("an unused GitHub sign-in comes back to the sign-in page saying so, with nothing kept",
    [unknown.back.location, v.jar.cookies.has("wgp_pending"), waiting() - waitingBefore],
    ["/login?error=paused&with=github", false, 0]);
  t.same("no account was made", server.sql("SELECT COUNT(*) AS n FROM users")[0].n, before);
  const existing = new Person(origin, "x");
  const back = await roundTrip(standin, existing, "github", { id: 4242003, login: "ben-check", name: "Ben Check" });
  t.same("an account that exists still signs in with GitHub", [back.back.location, (await existing.me())?.id], ["/", ben.user.id]);
  t.same("and with a passkey", (await new Person(origin, "x").signIn(ana.passkeys[0])).status, 200);
  const off = await roundTrip(standin, new Person(origin, "x"), "google", { sub: "x", name: "x" });
  t.same("Google, switched off, sends the browser back saying it isn't offered", off.started.location, "/login?error=unavailable&with=google");
  const mail = await ana.post("/api/account/email", { email: "ana@check.example" });
  t.same("with no address to send from, account email is a 404", [mail.status, mail.json?.error], [404, "no email"]);
  const recover = await new Person(origin, "x").post("/api/auth/recover", { email: "ana@check.example" });
  t.same("and so is getting back in by email", [recover.status, recover.json?.error], [404, "no email"]);
  t.same("the account page's email row says it isn't offered", (await ana.get("/api/account/email")).json?.offered, false);
}

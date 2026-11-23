// The page's note of who is signed in (`wgp_who`, src/accounts/sessions.js): every way of
// signing in sets it, every way of signing out clears it, it carries the account's id and
// nothing else, and the server decides nothing by it.

import { sessionValue } from "../parity/lib.mjs";
import { Person, cookieNamed } from "../lib/person.mjs";
import { makeLink } from "../../tools/signin-link.mjs";
import { roundTrip } from "./providers.mjs";

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const codeIn = (mail) => mail?.subject.match(/\b(\d{6})\b/)?.[1] ?? null;

/** A Set-Cookie value as { name, value, attrs: { lower-case name: value or true } }. */
function parse(cookie) {
  if (!cookie) return null;
  const [first, ...rest] = cookie.split(";").map((p) => p.trim());
  const eq = first.indexOf("=");
  const attrs = {};
  for (const part of rest) {
    const i = part.indexOf("=");
    if (i < 0) attrs[part.toLowerCase()] = true;
    else attrs[part.slice(0, i).toLowerCase()] = part.slice(i + 1);
  }
  return { name: first.slice(0, eq), value: first.slice(eq + 1), attrs };
}

/**
 * What an answer that signs someone in did with the two cookies: the account's id as the
 * value, the page able to read it, and every other attribute the session cookie's.
 */
function setsWho(res, userId) {
  const who = parse(cookieNamed(res, "wgp_who"));
  const session = parse(cookieNamed(res, "wgp_session"));
  if (!who || !session) return { who: !!who, session: !!session };
  const { httponly, ...sessionRest } = session.attrs;
  const right = decodeURIComponent(who.value) === userId && !who.attrs.httponly && httponly === true
    && JSON.stringify(who.attrs) === JSON.stringify(sessionRest);
  return right || { value: decodeURIComponent(who.value), userId, who: who.attrs, session: session.attrs };
}

/** An answer that signs this browser out: the session, the old cookie and the account's id all cleared. */
function clearsAll(res) {
  const gone = (name) => /Max-Age=0\b/.test(cookieNamed(res, name) ?? "");
  return (gone("wgp_session") && gone("s2") && gone("wgp_who")) || res.cookies.map((c) => c.replace(/=[^;]*/, "=…"));
}

export async function who({ server, report: t, standin, authSecret }) {
  const { origin } = server;

  t.part("Who is signed in, for the phone: every way in sets it");
  const ways = {};
  {
    // A passkey: a new account, and signing in with it.
    const pia = new Person(origin, "Pia Who");
    const made = await pia.signUp();
    ways["a new account with a passkey"] = setsWho(made, pia.user?.id);
    const piaElsewhere = pia.otherBrowser();
    ways["a passkey"] = setsWho(await piaElsewhere.signIn(), pia.user?.id);

    // Google: an account made from it (the create step), and signing in with it again.
    const quin = new Person(origin, "Quin Who");
    await roundTrip(standin, quin, "google", { sub: "google-sub-who-1", name: "Quin Who" });
    const quinMade = await quin.post("/api/auth/pending/create", { name: "Quin Who" });
    ways["a new account from Google"] = setsWho(quinMade, quinMade.json?.user?.id);
    const quinAgain = new Person(origin, "Quin Who");
    ways.Google = setsWho((await roundTrip(standin, quinAgain, "google", { sub: "google-sub-who-1", name: "Quin Who" })).back, quinMade.json?.user?.id);

    // GitHub, signing in to an account that has it.
    const rosa = new Person(origin, "Rosa Who");
    await roundTrip(standin, rosa, "github", { id: 5150001, login: "rosa-who", name: "Rosa Who" });
    const rosaMade = await rosa.post("/api/auth/pending/create", { name: "Rosa Who" });
    const rosaAgain = new Person(origin, "Rosa Who");
    ways.GitHub = setsWho((await roundTrip(standin, rosaAgain, "github", { id: 5150001, login: "rosa-who", name: "Rosa Who" })).back, rosaMade.json?.user?.id);

    // The email code, for an account that has an address.
    const address = "pia.who@check.example";
    let mark = server.logMark();
    const asked = await pia.post("/api/account/email", { email: address });
    await pia.post("/api/account/email/confirm", { id: asked.json?.id, code: codeIn(await server.mailTo(address, mark)) });
    const lost = new Person(origin, "Pia Who");
    mark = server.logMark();
    const recover = await lost.post("/api/auth/recover", { email: address });
    ways["the email code"] = setsWho(await lost.post("/api/auth/recover/confirm", { id: recover.json?.id, code: codeIn(await server.mailTo(address, mark)) }), pia.user?.id);

    // The operator's one-use link.
    const link = makeLink({ who: pia.user.id, origin, hours: 1 });
    server.sql(link.sql);
    ways["the operator's link"] = setsWho(await new Person(origin, "Pia Who").post("/api/auth/link", { token: link.url.split("/").pop() }), pia.user?.id);

    // The cookie from before sessions were rows, carried over into a session.
    server.sql(`INSERT INTO users (id, name, username, created_at) VALUES ('u_who_old', 'olwen', 'olwen', 1);
      INSERT INTO old_cookie_accounts (user_id) VALUES ('u_who_old')`);
    const olwen = new Person(origin, "olwen");
    olwen.jar.cookies.set("s2", sessionValue(authSecret, "u_who_old", now() + 30 * DAY));
    const swapped = await olwen.get("/api/me");
    ways["the old cookie, carried over"] = setsWho(swapped, "u_who_old");

    for (const [way, got] of Object.entries(ways)) {
      t.ok(`${way}: sets it beside the session, holding the account's id and nothing else, readable by the page, otherwise as the session cookie`, got === true, got);
    }

    // ── what the gate does with it ──
    t.part("Who is signed in, for the phone: kept in step, and never trusted");
    const pia2 = piaElsewhere;
    const quiet = await pia2.get("/api/me");
    t.same("a browser that holds it, right, isn't sent it again", cookieNamed(quiet, "wgp_who"), undefined);
    pia2.jar.cookies.delete("wgp_who");
    const missing = await pia2.get("/api/me");
    const back = parse(cookieNamed(missing, "wgp_who"));
    const left = server.sql(`SELECT expires_at FROM sessions WHERE user_id = '${pia.user.id}' ORDER BY expires_at DESC LIMIT 1`)[0].expires_at - now();
    t.ok("a signed-in browser that lacks it is sent it, to run out with the session",
      decodeURIComponent(back?.value ?? "") === pia.user.id && Math.abs(Number(back?.attrs["max-age"]) - left) < 60, back);
    pia2.jar.cookies.set("wgp_who", encodeURIComponent(quinMade.json.user.id));
    const swappedWho = await pia2.get("/api/me");
    t.same("one that holds another account's id is answered as the account its session is, and sent the right id",
      [swappedWho.json?.id, decodeURIComponent(parse(cookieNamed(swappedWho, "wgp_who"))?.value ?? "")], [pia.user.id, pia.user.id]);
    const only = new Person(origin, "x");
    only.jar.cookies.set("wgp_who", encodeURIComponent(pia.user.id));
    const alone = await only.get("/api/me");
    t.same("it signs nobody in: with no session it is a 401, and the browser is told to forget it", [alone.status, clearsAll(alone)], [401, true]);
    t.same("a browser with no cookies at all is told nothing", (await new Person(origin, "x").get("/api/me")).cookies, []);

    // ── every way out clears it ──
    t.part("Who is signed in, for the phone: every way out clears it");
    t.same("signing out", clearsAll(await lost.post("/api/auth/logout")), true);
    const elsewhere = new Person(origin, "Pia Who");
    elsewhere.passkeys = pia.passkeys;
    await elsewhere.signIn();
    t.same("signing out everywhere", clearsAll(await elsewhere.post("/api/auth/logout/all")), true);
    t.same("another browser of the same account, at its next request after that", clearsAll(await pia.get("/api/me")), true);
    t.same("  (and it holds neither cookie now)", [pia.jar.cookies.has("wgp_session"), pia.jar.cookies.has("wgp_who")], [false, false]);
    const rosaDeletes = await rosaAgain.call("DELETE", "/api/me", { confirm: "delete" });
    t.same("deleting the account", [rosaDeletes.status, clearsAll(rosaDeletes)], [200, true]);
  }
}

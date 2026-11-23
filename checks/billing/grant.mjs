// The plan given by the site's operator (0046 plan_grants; tools/plan-grant.mjs; src/billing/plan.js grantOf), on a
// server of its own whose site sells no plan and has the assistant switched off (PLAN_ENABLED and ASSISTANT_ENABLED
// empty), with the assistant's key and model set:
//
//   node checks/billing/grant.mjs [--port <port>]
//
// It holds:
//   1. before a grant, nothing: no plan card, no assistant on the host's trip, the free room;
//   2. the tool gives it, printing one line and never the account's id; the account then has the plan as "comp" (no
//      interval, renewal, end or hold), the plan's room (an upload past the free limit fits), and the assistant on the
//      trips it hosts, for everyone on them, at the plan's allowance; the host can turn it off on one trip;
//   3. nobody else changes: an account without a grant, the granted host's member on a trip of their own, and a trip
//      another host hosts that the granted host is only on, all exactly as before (planted: the check is shown to fail
//      if the grant reached them);
//   4. Checkout and the portal refuse a given plan in its own words, the plan off and on; with the plan on, an account
//      without a grant sees the plan for sale as before; and an account given the plan that ALSO pays sees what it pays
//      for, "Manage your plan" opening the Portal (the grant unseen while the subscription lasts), and the grant's card
//      again once it ends (Stripe is a stand-in, checks/lib/stripe-standin.mjs: nothing reaches Stripe);
//   5. the account's export carries the grant as recorded (when, and the operator's words); the account deleted takes it;
//   6. taken back, it ends: the plan card goes, the assistant goes, the free room is back;
//   7. the tool refuses in words, writing nothing: no account, a made-up or deleted one, two things at once, no reason;
//      --remote only with the production database named, through the production config (a recorder stands in for
//      wrangler and a stand-in for the production config: nothing here reaches production or reads it).
// Everyone in it is made up.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CheckError, ROOT, parseJsonc, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { startModel } from "../lib/model-standin.mjs";
import { startStripe } from "../lib/stripe-standin.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const t = new Report("the plan given by the site's operator");
const TOOL = path.join(ROOT, "tools/plan-grant.mjs");
const KEY = "sk-or-check-not-real";
const FREE = 1000;   // the free room, made tiny: an upload of 2048 bytes needs the plan's pool
const POOL = 50 * 1024 ** 3;
const ALLOWANCE = 2_000_000;
const REASON = "a made-up reason, with a quote's ' in it";
const site = parseJsonc(fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8"));
const SITE_DB = site.d1_databases.find((d) => d.binding === "DB").database_name;
const SECRET = "whsec_check_not_real";
const STRIPE_KEY = "sk_test_check_not_real";
const PLAN_ON = { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_check_month", STRIPE_PRICE_YEARLY: "price_check_year" };
const PLAN_OFF = { PLAN_ENABLED: "", STRIPE_PRICE_MONTHLY: "", STRIPE_PRICE_YEARLY: "" };

let server, model, stripe, code = 1;
try {
  model = await startModel({ key: KEY });
  stripe = await startStripe({ secret: SECRET, key: STRIPE_KEY });
  server = await startServer({
    name: "plan-grant", port,
    vars: { ...PLAN_OFF, ASSISTANT_ENABLED: "", STORAGE_LIMIT_BYTES: String(FREE),
      ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5", OPENROUTER_API_BASE: model.base, STRIPE_API_BASE: stripe.base },
    secrets: { STRIPE_SECRET_KEY: STRIPE_KEY, STRIPE_WEBHOOK_SECRET: SECRET, OPENROUTER_API_KEY: KEY },
  });
  await server.start();
  const { origin } = server;
  const config = path.join(server.work, "wrangler.json");
  const local = ["--local", "--persist-to", server.state, "--config", config];
  const tool = (args, env = {}) => {
    const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });
    return { code: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.split("\n").filter(Boolean) };
  };
  const grants = () => server.sql("SELECT user_id, granted_at, reason, revoked_at FROM plan_grants ORDER BY user_id");

  // Ada: the account the plan is given to, host of "Lake week" (Ben on it). Cleo: no grant, hosts "City weekend" (Ben and
  // Ada on it). Ben hosts "Ben's trip" (Ada on it). Dev: given the plan, then deletes the account.
  const [ada, ben, cleo, dev] = ["Ada Reyes", "Ben Okafor", "Cleo Tran", "Dev Patel"].map((n) => new Person(origin, n));
  for (const p of [ada, ben, cleo, dev]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const tripOf = async (host, name, people) => {
    const id = (await host.post("/api/trips", { name, default_tz: "UTC" })).json.trip.id;
    for (const p of people) await p.post(`/api/join/${(await host.post(`/api/trips/${id}/links`, { uses: 1 })).json.link.code}`);
    return id;
  };
  const lake = await tripOf(ada, "Lake week", [ben]);
  const city = await tripOf(cleo, "City weekend", [ben, ada]);
  const bens = await tripOf(ben, "Ben's trip", [ada]);

  const A = (x) => `/api/trips/${x}/assistant`;
  const roomOf = async (who, x) => (await who.get(A(x))).json?.room ?? null;
  const planOf = async (who) => { const r = await who.get("/api/account/plan"); return { status: r.status, body: r.json }; };
  const fits = async (who, x) => (await who.post(`/api/trips/${x}/media/begin`, { name: "big.jpg", mime: "image/jpeg", bytes: 2048, kind: "photo" })).status;
  let conv = 0;
  const ask = async (who, x) => {
    const id = `c-${++conv}`;
    const made = await who.post(`${A(x)}/conversations`, { id });
    if (made.status !== 201 && made.status !== 200) return { status: made.status, error: made.json?.error ?? null };
    model.next({ words: "Here's a thought.", cost: 0.0001 });
    const r = await who.post(`${A(x)}/conversations/${id}/ask`, { id: `ask-${conv}`, words: "Any ideas?" });
    const turn = r.text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((l) => l?.turn)?.turn;
    return { status: r.status, words: turn?.words ?? r.json?.error ?? null };
  };
  // Everything an account sees of the plan and the assistant, as one value: the planted parts compare it with before.
  const seenBy = async (who, x) => ({ plan: (await planOf(who)).status, room: await roomOf(who, x), fits: await fits(who, x), conversation: (await who.post(`${A(x)}/conversations`, { id: `seen-${++conv}` })).status });

  t.part("1. Before a grant, nothing");
  const adaBefore = await seenBy(ada, lake);
  // What an account with no plan sees where the site sells none: no card, no assistant, the free room.
  const NOTHING = { plan: 404, room: { offered: false }, fits: 413, conversation: 404 };
  t.same("Ada (the plan off, the assistant off): no plan card, no assistant on her trip, an upload past the free room refused",
    adaBefore, NOTHING);


  t.part("2. Given");
  const given = tool(["--user", ada.user.id, "--reason", REASON, ...local]);
  t.same("the tool gives it and prints one line", [given.code, given.err, given.lines],
    [0, "", ["given: that account has the plan (its room, and the assistant on the trips it hosts), nothing charged"]]);
  t.ok("  never the account's id or name", !(given.out + given.err).includes(ada.user.id) && !/Ada/.test(given.out + given.err));
  const row = grants();
  t.same("  one grant, recorded as one: the account, now, the operator's words, not revoked",
    [row.length, row[0]?.user_id, Math.abs(row[0]?.granted_at - Date.now() / 1000) <= 30, row[0]?.reason, row[0]?.revoked_at], [1, ada.user.id, true, REASON, null]);
  t.same("  and no subscription or Stripe customer made up for it",
    server.sql("SELECT (SELECT COUNT(*) FROM billing_subscriptions) + (SELECT COUNT(*) FROM billing_customers) AS n")[0].n, 0);
  const p = await planOf(ada);
  t.same("her plan card: the plan on, given (comp), nothing to renew, end or hold; the site sells no plan, so no prices",
    [p.status, p.body?.offered, p.body?.plan, p.body?.prices ?? null],
    [200, false, { active: true, status: "comp", interval: null, until: null, cancels: null, held: false, poolBytes: POOL, allowanceMicro: ALLOWANCE, reason: null, ended: null }, null]);
  t.same("  the plan's room, and the assistant with its month", [p.body?.room?.limit, p.body?.room?.free, p.body?.assistant, typeof p.body?.assistant_month], [POOL, FREE, true, "object"]);
  t.same("an upload past the free room fits on her trip (begun: 201)", await fits(ada, lake), 201);
  t.same("the assistant on her trip, for Ben (on it): there, with room", await roomOf(ben, lake), { offered: true, on: true, room: true, back: null });
  t.same("  Ben asks, and it answers", await ask(ben, lake), { status: 200, words: "Here's a thought." });
  const host = (await ada.get(A(lake))).json?.host;
  t.same("  Ada, the host, sees the month at the plan's allowance, and her trip's line", [host?.allowance, host?.trip?.calls], [ALLOWANCE, 1]);
  const off = await ada.call("PUT", `${A(lake)}/off`, { off: true });
  t.same("  she can turn it off on that trip, and Ben sees it off", [off.status, (await roomOf(ben, lake))?.off_by_host], [200, true]);
  await ada.call("PUT", `${A(lake)}/off`, { off: false });

  t.part("3. Nobody else changes (planted)");
  t.same("Cleo, without a grant, on her own trip: nothing, as before", await seenBy(cleo, city), NOTHING);
  t.same("Ben, on a trip of his own (Ada on it): nothing, as before", await seenBy(ben, bens), NOTHING);
  t.same("Cleo's trip, with Ada on it: no assistant for Ada there (it's Cleo's trip, not hers)",
    [await roomOf(ada, city), (await ask(ada, city)).status], [{ offered: false }, 404]);
  // Planted: the same comparison, against what a grant gives, says so (so the three lines above can fail).
  const planted = JSON.stringify(await seenBy(cleo, city)) === JSON.stringify({ plan: 200, room: { offered: true, on: true, room: true, back: null }, fits: 201, conversation: 201 });
  t.ok("  planted: the comparison tells a granted account's view from Cleo's", !planted);

  t.part("4. Checkout and the portal refuse a given plan");
  const buy = await ada.post("/api/account/plan/checkout", { interval: "monthly" });
  t.same("the plan off: Checkout, in its own words", [buy.status, buy.json?.reason], [409, "You have the plan already: it was given to you, so there's nothing to buy."]);
  const manage = await ada.post("/api/account/plan/portal", {});
  t.same("  the portal, in its own words", [manage.status, manage.json?.reason], [409, "Your plan was given to you: there's nothing to manage."]);
  t.same("  Cleo, without one: the site sells no plan, as before", [(await cleo.post("/api/account/plan/checkout", { interval: "monthly" })).status], [404]);
  await server.halt();
  await server.start({ vars: PLAN_ON });
  const buyOn = await ada.post("/api/account/plan/checkout", { interval: "yearly" });
  const manageOn = await ada.post("/api/account/plan/portal", {});
  t.same("the plan on: Checkout and the portal refuse her in the same words",
    [buyOn.status, buyOn.json?.reason, manageOn.status, manageOn.json?.reason],
    [409, "You have the plan already: it was given to you, so there's nothing to buy.", 409, "Your plan was given to you: there's nothing to manage."]);
  const pOn = await planOf(ada);
  t.same("  her card: still the given plan, the site now selling it", [pOn.body?.offered, pOn.body?.plan?.status, pOn.body?.plan?.active], [true, "comp", true]);
  const cleoOn = await planOf(cleo);
  t.same("  Cleo's: the plan for sale, hers not on, as for anyone", [cleoOn.status, cleoOn.body?.offered, cleoOn.body?.plan?.active, cleoOn.body?.plan?.status], [200, true, false, null]);
  // Ada pays as well (her customer at the stand-in, her subscription as the webhook would file it): what she pays for
  // comes first, with the Portal to cancel it.
  const cus = await (await fetch(`${stripe.base}/v1/customers`, { method: "POST", headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "" })).json();
  const now = Math.floor(Date.now() / 1000);
  server.sql(`INSERT INTO billing_customers (user_id, customer, created_at) VALUES ('${ada.user.id}', '${cus.id}', ${now})`);
  server.sql(`INSERT INTO billing_subscriptions (id, user_id, customer, status, interval, current_period_end, held, updated_at, synced_at)
    VALUES ('sub_ada', '${ada.user.id}', '${cus.id}', 'active', 'month', ${now + 30 * 86400}, 0, ${now}, ${Date.now()})`);
  const paying = await planOf(ada);
  t.same("given the plan and paying too: the card is the paid plan (monthly, its renewal), not the grant's",
    [paying.body?.plan?.status, paying.body?.plan?.interval, paying.body?.plan?.until > now], ["active", "month", true]);
  const portal = await ada.post("/api/account/plan/portal", {});
  t.same("  Manage your plan opens the Portal, to cancel what she pays for", [portal.status, portal.json?.url?.startsWith(`${stripe.base}/portal/`)], [200, true]);
  t.same("  Checkout: she has the plan, cancel it from Manage your plan",
    [(await ada.post("/api/account/plan/checkout", { interval: "monthly" })).json?.reason], ["You have the plan already. You can cancel it from Manage your plan."]);
  server.sql(`UPDATE billing_subscriptions SET status = 'canceled', ended_at = ${now}, ended_reason = 'cancelled' WHERE id = 'sub_ada'`);
  const after = await planOf(ada);
  const portalAfter = await ada.post("/api/account/plan/portal", {});
  t.same("  the subscription ended: the grant's card again, and nothing to manage",
    [after.body?.plan?.status, after.body?.plan?.active, portalAfter.status, portalAfter.json?.reason], ["comp", true, 409, "Your plan was given to you: there's nothing to manage."]);
  await server.halt();
  await server.start({ vars: PLAN_OFF });

  t.part("5. The export, and the account deleted");
  const ex = (await ada.get("/api/account/export")).json;
  t.same("Ada's export: the plan as given, and the grant as recorded", [ex?.plan?.status, ex?.plan_grant], ["comp", { granted_at: row[0]?.granted_at, reason: REASON }]);
  t.same("  Cleo's: neither", [(await cleo.get("/api/account/export")).json?.plan_grant, (await cleo.get("/api/account/export")).json?.plan], [null, null]);
  t.same("Dev given it too", tool(["--user", dev.user.id, "--reason", "another made-up reason", ...local]).code, 0);
  const gone = await dev.call("DELETE", "/api/me", { confirm: "delete" });
  t.same("  Dev's account deleted takes the grant", [gone.status, server.sql(`SELECT COUNT(*) AS n FROM plan_grants WHERE user_id = '${dev.user.id}'`)[0].n], [200, 0]);

  t.part("6. Taken back");
  const shown = tool(["--user", ada.user.id, "--show", ...local]);
  t.ok("--show says it holds, and since when", shown.code === 0 && /^the plan is given to that account \(since \d{4}-\d\d-\d\d\)$/.test(shown.lines[0] ?? ""), shown.out + shown.err);
  const back = tool(["--user", ada.user.id, "--revoke", ...local]);
  t.same("the tool takes it back, in one line", [back.code, back.lines], [0, ["taken back: the plan is no longer given to that account"]]);
  t.same("  the row kept, revoked", [grants().find((g) => g.user_id === ada.user.id)?.revoked_at > 0], [true]);
  t.same("Ada: no plan card, no assistant on her trip, the free room again: as before the grant", await seenBy(ada, lake), adaBefore);
  t.same("  Ben asks there: refused, the site doesn't offer it", (await ask(ben, lake)).status, 404);
  const again = tool(["--user", ada.user.id, "--revoke", ...local]);
  t.same("taken back again: nothing to take back", [again.code, again.lines], [0, ["that account had no grant: nothing to take back"]]);
  t.same("given again, it holds again", [tool(["--user", ada.user.id, "--reason", REASON, ...local]).code, (await planOf(ada)).body?.plan?.status], [0, "comp"]);

  t.part("7. The tool refuses in words, writing nothing");
  const count = () => JSON.stringify(grants());
  const refused = (label, args, words, env = {}) => {
    const n = count();
    const r = tool(args, env);
    t.ok(label, r.code === 2 && r.out === "" && words.test(r.err) && count() === n, `${r.code} ${r.out} ${r.err}`);
  };
  refused("no account named", ["--reason", "x", ...local], /^--user takes the account's id/);
  refused("not an id", ["--user", "me", "--reason", "x", ...local], /^--user takes the account's id/);
  refused("a made-up id", ["--user", "00000000-1111-4222-8333-444444444444", "--reason", "x", ...local], /^no account has that id there\. Nothing was written\./);
  refused("a deleted account", ["--user", dev.user.id, "--reason", "x", ...local], /^that account is deleted\. Nothing was written\./);
  refused("two things at once", ["--user", cleo.user.id, "--reason", "x", "--revoke", ...local], /^say one of:/);
  refused("nothing to do", ["--user", cleo.user.id, ...local], /^say one of:/);
  refused("an empty reason", ["--user", cleo.user.id, "--reason", "  ", ...local], /^--reason says why/);
  refused("no place", ["--user", cleo.user.id, "--reason", "x"], /^say where/);

  // Production, said in full or not at all: a recorder stands in for wrangler and turns --remote into this server's
  // own local database; a stand-in production config (the tree's settings with a made-up database id) for the real one.
  const recorder = path.join(server.work, "wrangler-recorder.mjs");
  const heard = path.join(server.work, "wrangler-heard.jsonl");
  const real = path.join(ROOT, "node_modules/.bin/wrangler");
  fs.writeFileSync(recorder, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
const asked = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(heard)}, JSON.stringify(asked) + "\\n");
const args = [];
for (let i = 0; i < asked.length; i++) {
  if (asked[i] === "--remote") args.push("--local", "--persist-to", ${JSON.stringify(server.state)});
  else if (asked[i] === "--yes") continue;
  else if (asked[i] === "-c") { args.push("-c", ${JSON.stringify(config)}); i++; }
  else args.push(asked[i]);
}
if (args.includes("--remote") || !args.includes("--local")) { console.error("the recorder sends nothing remote"); process.exit(9); }
const r = spawnSync(${JSON.stringify(real)}, args, { encoding: "utf8", env: process.env });
process.stdout.write(r.stdout ?? ""); process.stderr.write(r.stderr ?? "");
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  const standInProd = path.join(server.work, "wrangler.production.jsonc");
  fs.writeFileSync(standInProd, JSON.stringify({ ...site, d1_databases: site.d1_databases.map((d) => ({ ...d, database_id: "11111111-2222-4333-8444-555555555555" })) }, null, 2));
  const viaRecorder = { WGP_PLAN_GRANT_WRANGLER: recorder, WGP_SIGNIN_LINK_PRODUCTION_CONFIG: standInProd };
  const askedOf = () => (fs.existsSync(heard) ? fs.readFileSync(heard, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  refused("--remote alone: refused before wrangler is asked anything", ["--user", cleo.user.id, "--show", "--remote"], new RegExp(`say its name too \\(--production-database ${SITE_DB}\\)`), viaRecorder);
  refused("--remote with a check's settings file", ["--user", cleo.user.id, "--show", "--remote", "--production-database", SITE_DB, "--config", config], /takes no --config/, viaRecorder);
  t.same("  wrangler asked nothing", askedOf().length, 0);
  const remote = tool(["--user", cleo.user.id, "--show", "--remote", "--production-database", SITE_DB], viaRecorder);
  const asked = askedOf();
  t.same("said in full: it reads", [remote.code, remote.lines], [0, ["that account has no grant"]]);
  t.ok("  every command to the site's database, --remote, with the production config",
    asked.length > 0 && asked.every((a) => a[0] === "d1" && a[1] === "execute" && a[2] === SITE_DB && a.includes("--remote") && a[a.indexOf("-c") + 1] === standInProd),
    JSON.stringify(asked.map((a) => a.filter((x) => !/SELECT|INSERT|UPDATE/.test(x)))));

  const failed = server.log().split("\n").filter((l) => /Uncaught|✘|\[ERROR\]/.test(l));
  t.ok("nothing failed inside the server", failed.length === 0, failed.slice(0, 3).join(" | "));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await server?.stop();
  await model?.close();
  await stripe?.close();
}
process.exit(code);

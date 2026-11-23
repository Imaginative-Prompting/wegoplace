// The plan's server side (src/billing/), on a server of its own with the plan switched on and a
// stand-in Stripe on this machine (checks/lib/stripe-standin.mjs). Nothing reaches Stripe.
//
//   node checks/billing/run.mjs [--port <port>]
//
// It holds:
//   1. the webhook's signature, every way wrong (none, another secret, too old, malformed), and a
//      right one; a body that isn't JSON or isn't an event; a live event on test keys;
//   2. Checkout: one Stripe customer per account, the same Checkout for a double tap, another one
//      expiring the first still open, no promotion-code box and the card always taken, no
//      payment_method_types (the stand-in refuses it as Stripe does), a wrong interval refused in words;
//   3. paid: the plan active with its pool and allowance; asked again, refused in words;
//   4. each event once; a subscription always read back from Stripe (an event saying otherwise
//      takes nothing back);
//   5. a failed payment (past due still the plan; unpaid ends it);
//   6. a full refund ends the plan at Stripe at once; a partial one changes nothing;
//   7. a dispute holds the assistant's allowance while open, a won one lets it go, a lost one ends the plan;
//   8. another account's customer is never written to this one;
//   9. Stripe unreachable: the event isn't marked done, and is handled when it comes again;
//  10. the Portal: a URL for an account with a customer, refused in words for one without;
//  11. deleting an account ends its plan at Stripe first; with Stripe unreachable the account is
//      kept, in words; an account deleted while its Checkout was open has the subscription canceled
//      when it comes;
//  12. the room (L2): the plan's answer carries Stripe's own prices and the room (used, the limit
//      now, the free limit and the pool); a write that doesn't fit names the third way out without a
//      price (a member: "or <host> can get more room"; the host: their account page); with the plan
//      the host's limit is the pool; ended, nothing is removed and the free limit holds again.
// Everyone in it is made up.

import { CheckError, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { startStripe } from "../lib/stripe-standin.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const t = new Report("the plan, against a stand-in Stripe");
const SECRET = "whsec_check_not_real";
const KEY = "sk_test_check_not_real";

let server, stripe, code = 1;
try {
  stripe = await startStripe({ secret: SECRET, key: KEY });
  server = await startServer({
    name: "billing", port,
    // The free limit small (1 MiB), so a write past it is cheap to make; the pool as it ships.
    vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_check_month", STRIPE_PRICE_YEARLY: "price_check_year", STRIPE_API_BASE: stripe.base, STORAGE_LIMIT_BYTES: String(1024 ** 2) },
    secrets: { STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET },
  });
  await server.start();
  const { origin } = server;
  const [ada, ben, cleo, dev] = ["Ada Reyes", "Ben Okafor", "Cleo Tran", "Dev Patel"].map((nm) => new Person(origin, nm));
  for (const p of [ada, ben, cleo, dev]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const plan = async (p) => (await p.get("/api/account/plan")).json?.plan;
  const subRow = (sid) => server.sql(`SELECT status, held, ended_reason FROM billing_subscriptions WHERE id = '${sid}'`)[0] ?? null;

  t.part("1. The webhook's signature");
  const raw = (type, object, eventId = "evt_sig") => JSON.stringify({ id: eventId, object: "event", type, livemode: false, data: { object } });
  const post = async (body, header) => {
    const res = await fetch(`${origin}/api/billing/stripe`, { method: "POST", headers: { "Content-Type": "application/json", ...(header ? { "Stripe-Signature": header } : {}) }, body });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const body = raw("invoice.paid", { id: "in_x" });
  const now = Math.floor(Date.now() / 1000);
  for (const [label, header] of [["no signature", null], ["another secret's", stripe.sign(body, now, "whsec_someone_else")], ["six minutes old", stripe.sign(body, now - 360)],
    ["malformed", "t=abc,v1=xyz"], ["a v0 only", `t=${now},v0=${"a".repeat(64)}`]]) {
    const r = await post(body, header);
    t.same(`${label}: refused in words, nothing read`, [r.status, r.json?.error, !!r.json?.reason], [400, "bad signature", true]);
  }
  t.same("  and nothing was written", server.sql("SELECT COUNT(*) AS n FROM billing_events")[0].n, 0);
  const rolled = await post(body, `${stripe.sign(body, now, "whsec_old")},v1=${stripe.sign(body, now).split("v1=")[1]}`);
  t.same("a right signature among others (a secret rolled) passes", [rolled.status, rolled.json?.result?.skipped], [200, "not a subscription's invoice"]);
  const notJson = await post("not json", stripe.sign("not json", now));
  t.same("signed but not JSON: refused in words", [notJson.status, notJson.json?.error], [400, "not json"]);
  const notEvent = await post("{}", stripe.sign("{}", now));
  t.same("signed JSON that isn't an event: refused", [notEvent.status, notEvent.json?.error], [400, "not an event"]);
  const live = await stripe.send(origin, "invoice.paid", { id: "in_live" }, { livemode: true });
  t.same("a live event on test keys: refused", [live.status, live.json?.error], [400, "live event on test keys"]);

  t.part("2. Checkout");
  const c1 = await ada.post("/api/account/plan/checkout", { interval: "monthly" });
  const c2 = await ada.post("/api/account/plan/checkout", { interval: "monthly" });
  t.ok("monthly: a Checkout page at Stripe (here the stand-in's)", c1.status === 200 && c1.json?.url?.startsWith(`${stripe.base}/pay/`), JSON.stringify(c1.json));
  t.same("a double tap gets the same Checkout", c2.json?.url, c1.json?.url);
  const custs = server.sql(`SELECT customer FROM billing_customers WHERE user_id = '${ada.user.id}'`);
  t.same("one Stripe customer for the account, made once", [custs.length, stripe.customers.size], [1, 1]);
  const s1 = [...stripe.sessions.values()].at(-1);
  t.same("  the price, the account's id, no promotion-code box (no code exists), the card always taken", [s1.price, s1.client_reference_id, s1.metadata.user_id, s1.allow_promotion_codes, s1.payment_method_collection],
    ["price_check_month", ada.user.id, ada.user.id, undefined, "always"]);
  t.same("  no payment_method_types (Stripe refuses it at this version; cards only is the account's setting)", s1.payment_method_types, null);
  {
    // The stand-in answers as real Stripe did on 21 Nov, so a Checkout that sent it would fail here as it failed there.
    const raw = await fetch(`${stripe.base}/v1/checkout/sessions`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": stripe.calls.at(-1)?.version ?? "", "Idempotency-Key": "check-raw-payment-method-types" },
      body: new URLSearchParams({ customer: s1.customer, mode: "subscription", "payment_method_types[0]": "card" }) });
    const said = await raw.json();
    t.same("  (the stand-in refuses it in Stripe's own words, as real Stripe did)", [raw.status, said.error?.param, /no longer supported when creating a Checkout Session/.test(said.error?.message ?? "")], [400, "payment_method_types", true]);
  }
  const y = await ada.post("/api/account/plan/checkout", { interval: "yearly" });
  t.same("starting a yearly one expires the monthly one still open: one at a time", [y.status, stripe.sessions.get(s1.id).status, [...stripe.sessions.values()].at(-1).price], [200, "expired", "price_check_year"]);
  const bad = await ada.post("/api/account/plan/checkout", { interval: "weekly" });
  t.same("a wrong interval: refused in words", [bad.status, !!bad.json?.reason], [400, true]);
  t.ok("every call carries the key and Stripe's version; every POST that makes a thing an idempotency key",
    stripe.calls.every((c) => c.auth && c.version) && stripe.calls.filter((c) => c.method === "POST" && /^(customers|checkout\/sessions)$/.test(c.path)).every((c) => c.idempotency));

  t.part("3. Paid");
  const yearSession = [...stripe.sessions.values()].at(-1);
  const paid = await stripe.pay(yearSession.id, origin, { interval: "year" });
  const p1 = await plan(ada);
  t.same("paid: the webhook takes it, and the plan is on with its pool and allowance",
    [paid.sent.status, p1?.active, p1?.status, p1?.interval, p1?.poolBytes, p1?.allowanceMicro], [200, true, "active", "year", 50 * 1024 ** 3, 2_000_000]);
  const again = await ada.post("/api/account/plan/checkout", { interval: "monthly" });
  t.same("asking for it again: refused in words", [again.status, again.json?.error, !!again.json?.reason], [409, "already", true]);

  t.part("4. Each event once, and read back from Stripe");
  const sid = paid.sub.id;
  const ev = "evt_check_once";
  const first = await stripe.send(origin, "customer.subscription.updated", { id: sid }, { eventId: ev });
  const second = await stripe.send(origin, "customer.subscription.updated", { id: sid }, { eventId: ev });
  t.same("the same event twice: handled once", [first.json?.ok, second.json?.already], [true, true]);
  stripe.sub(sid).cancel_at_period_end = true;
  await stripe.send(origin, "customer.subscription.updated", { id: sid, status: "canceled", cancel_at_period_end: false });
  const p2 = await plan(ada);
  t.same("an event saying canceled while Stripe says active and cancelling: Stripe's word is written", [p2?.active, p2?.cancels === p2?.until && p2?.until > 0], [true, true]);
  // The way flexible billing cancels to the period's end: cancel_at a time, the flag false, canceled_at set.
  const endsOn = p2.until + 86400;
  Object.assign(stripe.sub(sid), { cancel_at_period_end: false, cancel_at: endsOn, canceled_at: Math.floor(Date.now() / 1000) });
  await stripe.send(origin, "customer.subscription.updated", { id: sid });
  const pAt = await plan(ada);
  t.same("cancelled as flexible billing sends it (cancel_at, the flag false): still on, and it ends at cancel_at", [pAt?.active, pAt?.cancels, pAt?.until], [true, endsOn, p2.until]);
  Object.assign(stripe.sub(sid), { cancel_at_period_end: false, cancel_at: null, canceled_at: null });
  await stripe.send(origin, "customer.subscription.updated", { id: sid });
  const pBack = await plan(ada);
  t.same("not cancelled after all (cancel_at cleared): it renews again", [pBack?.active, pBack?.cancels, pBack?.until], [true, null, p2.until]);

  t.part("5. A failed payment");
  stripe.sub(sid).status = "past_due";
  await stripe.send(origin, "invoice.payment_failed", { id: "in_f", subscription: sid });
  t.same("past due: still the plan", [(await plan(ada))?.active, (await plan(ada))?.status], [true, "past_due"]);
  stripe.sub(sid).status = "unpaid";
  await stripe.send(origin, "invoice.payment_failed", { id: "in_f2", subscription: sid });
  const p3 = await plan(ada);
  t.same("unpaid: the plan ends; nothing is removed, the pool and allowance go", [p3?.active, p3?.status, p3?.poolBytes, p3?.allowanceMicro], [false, "unpaid", 0, 0]);
  t.same("  and it says why: its payment never came", [p3?.reason, Number.isInteger(p3?.ended)], ["payment_failed", true]);
  stripe.sub(sid).status = "active";
  await stripe.send(origin, "invoice.paid", { id: "in_p", subscription: sid });
  const pPaid = await plan(ada);
  t.same("paid after all: back on, with no ending", [pPaid?.active, pPaid?.reason, pPaid?.ended], [true, null, null]);

  t.part("6. Refunds");
  const adaCustomer = custs[0].customer;
  const partial = await stripe.send(origin, "charge.refunded", stripe.charge(adaCustomer, { refunded: false }));
  t.same("a partial refund changes nothing", [partial.json?.result?.skipped, (await plan(ada))?.active], ["partial refund", true]);
  const full = await stripe.send(origin, "charge.refunded", stripe.charge(adaCustomer, { refunded: true }));
  t.same("a full refund ends the plan at Stripe at once, saying why", [full.json?.result?.ended, stripe.sub(sid).status, (await plan(ada))?.active, subRow(sid)?.ended_reason],
    [1, "canceled", false, "refunded"]);
  {
    const ended = await plan(ada);
    t.ok("  and the plan says when it ended (seconds, as until and cancels are) and why: refunded",
      ended?.reason === "refunded" && Number.isInteger(ended?.ended) && Math.abs(ended.ended - Date.now() / 1000) < 600, JSON.stringify({ reason: ended?.reason, ended: ended?.ended }));
  }

  t.part("7. Disputes");
  const cb = await ben.post("/api/account/plan/checkout", { interval: "monthly" });
  const benPaid = await stripe.pay([...stripe.sessions.values()].at(-1).id, origin);
  const benCustomer = server.sql(`SELECT customer FROM billing_customers WHERE user_id = '${ben.user.id}'`)[0].customer;
  const benCharge = stripe.charge(benCustomer);
  const d = stripe.dispute(benCharge, "needs_response");
  await stripe.send(origin, "charge.dispute.created", { id: d.id });
  const held = await plan(ben);
  t.same("a dispute open: the plan stays, the assistant's allowance is held", [cb.status, held?.active, held?.held, held?.allowanceMicro, held?.poolBytes > 0], [200, true, true, 0, true]);
  d.status = "won";
  await stripe.send(origin, "charge.dispute.closed", { id: d.id });
  t.same("won: let go", [(await plan(ben))?.held, (await plan(ben))?.allowanceMicro], [false, 2_000_000]);
  const d2 = stripe.dispute(benCharge, "lost");
  await stripe.send(origin, "charge.dispute.closed", { id: d2.id });
  t.same("lost: the plan ends, saying why", [(await plan(ben))?.active, subRow(benPaid.sub.id)?.ended_reason], [false, "dispute_lost"]);

  t.part("8. Another account's customer");
  const foreign = { id: "sub_check_foreign", object: "subscription", customer: benCustomer, status: "active", metadata: { user_id: cleo.user.id }, cancel_at_period_end: false,
    items: { data: [{ current_period_end: now + 86400, price: { recurring: { interval: "month" } } }] } };
  stripe.subs.set(foreign.id, foreign);
  const f = await stripe.send(origin, "customer.subscription.created", { id: foreign.id });
  t.same("a subscription naming one account on another's customer: written to neither", [f.json?.result?.skipped, (await plan(cleo))?.active, subRow(foreign.id)], ["no account", false, null]);

  t.part("9. Stripe unreachable");
  await cleo.post("/api/account/plan/checkout", { interval: "monthly" });
  const cleoSession = [...stripe.sessions.values()].at(-1);
  const made = await stripe.pay(cleoSession.id, null);
  stripe.failNext(1);
  const down = await stripe.send(origin, "checkout.session.completed", { id: cleoSession.id, subscription: made.sub.id }, { eventId: "evt_check_down" });
  const notDone = server.sql("SELECT done_at FROM billing_events WHERE id = 'evt_check_down'")[0];
  t.same("the event fails, is not marked done, the plan not written", [down.status, notDone?.done_at ?? null, (await plan(cleo))?.active], [500, null, false]);
  const retry = await stripe.send(origin, "checkout.session.completed", { id: cleoSession.id, subscription: made.sub.id }, { eventId: "evt_check_down" });
  t.same("sent again, it's handled", [retry.status, (await plan(cleo))?.active], [200, true]);

  // Stripe refusing a Checkout: the person reads plain words; Stripe's own message goes to the error log.
  stripe.failNext(1);
  const failedOpen = await dev.post("/api/account/plan/checkout", { interval: "monthly" });
  t.same("Stripe refusing: the person reads plain words, never Stripe's developer message",
    [failedOpen.status, failedOpen.json?.reason, /Stripe answered|stand-in/i.test(JSON.stringify(failedOpen.json))],
    [502, "The payment page couldn't be opened just now. Nothing was charged. Try again in a minute.", false]);
  const logged = server.sql("SELECT place, message FROM error_groups WHERE place LIKE 'stripe %'");
  t.ok("  and Stripe's own message is in the error log, under the call it came from, with no ids",
    logged.length > 0 && logged.every((r) => /^stripe (GET|POST|DELETE) [a-z_]+(\/(:id|[a-z_]+))*$/.test(r.place)) && logged.some((r) => /^Stripe 500: /.test(r.message)), JSON.stringify(logged));

  t.part("10. The Portal");
  const portal = await cleo.post("/api/account/plan/portal", {});
  t.ok("an account with a customer: a Portal page (here the stand-in's)", portal.status === 200 && portal.json?.url?.startsWith(`${stripe.base}/portal/`), JSON.stringify(portal.json));
  const none = await dev.post("/api/account/plan/portal", {});
  t.same("one without: refused in words", [none.status, none.json?.error, !!none.json?.reason], [404, "no plan", true]);

  t.part("11. Deleting an account");
  // A dispute of Cleo's, closed and won by the site: its row is kept, as every dispute's is.
  const cleoCustomer = server.sql(`SELECT customer FROM billing_customers WHERE user_id = '${cleo.user.id}'`)[0].customer;
  const cd = stripe.dispute(stripe.charge(cleoCustomer), "won");
  await stripe.send(origin, "charge.dispute.closed", { id: cd.id });
  const disputesOf = (customer) => server.sql(`SELECT COUNT(*) AS n FROM billing_disputes WHERE customer = '${customer}'`)[0].n;
  const benDisputes = disputesOf(benCustomer);
  t.same("  (before: Cleo's dispute is kept, and Ben's two)", [disputesOf(cleoCustomer), benDisputes], [1, 2]);
  stripe.failNext(1);
  const kept = await cleo.call("DELETE", "/api/me", { confirm: "delete" });
  t.same("Stripe unreachable: the account is kept, in words, the plan still on", [kept.status, kept.json?.error, !!kept.json?.reason, (await plan(cleo))?.active], [503, "plan not ended", true, true]);
  const gone = await cleo.call("DELETE", "/api/me", { confirm: "delete" });
  t.same("then deleted: the plan ended at Stripe first, the account's billing rows gone",
    [gone.status, stripe.sub(made.sub.id).status, server.sql(`SELECT COUNT(*) AS n FROM billing_customers WHERE user_id = '${cleo.user.id}'`)[0].n], [200, "canceled", 0]);
  t.same("  her disputes go with her (Stripe keeps the dispute itself), and nobody else's do",
    [disputesOf(cleoCustomer), disputesOf(benCustomer)], [0, benDisputes]);
  await dev.post("/api/account/plan/checkout", { interval: "monthly" });
  const devSession = [...stripe.sessions.values()].at(-1);
  // Deleted with its Checkout open: the Checkout is expired at Stripe.
  const devGone = await dev.call("DELETE", "/api/me", { confirm: "delete" });
  t.same("deleted with a Checkout open: the Checkout expired at Stripe", [devGone.status, stripe.sessions.get(devSession.id).status], [200, "expired"]);
  // A subscription that comes anyway for an account that's gone is canceled at Stripe.
  const orphan = { id: "sub_check_orphan", object: "subscription", customer: "cus_check_orphan", status: "active", metadata: { user_id: dev.user.id }, cancel_at_period_end: false,
    items: { data: [{ current_period_end: now + 86400, price: { recurring: { interval: "month" } } }] } };
  stripe.subs.set(orphan.id, orphan);
  const o = await stripe.send(origin, "customer.subscription.created", { id: orphan.id });
  t.same("  and a subscription that comes for it anyway is canceled at Stripe", [o.json?.result?.canceled, stripe.sub(orphan.id).status], [true, "canceled"]);

  t.part("12. The room");
  {
    const MB = 1024 ** 2;
    const [eli, fay] = ["Eli Brooks", "Fay Lund"].map((nm) => new Person(origin, nm));
    for (const p of [eli, fay]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
    const trip = (await eli.post("/api/trips", { name: "Lake week", default_tz: "UTC" })).json.trip.id;
    await fay.post(`/api/join/${(await eli.post(`/api/trips/${trip}/links`, { uses: 1 })).json.link.code}`);
    const begin = (who, bytes, name = "photo.jpg") => who.post(`/api/trips/${trip}/media/begin`, { name, mime: "image/jpeg", bytes });
    const card = (await eli.get("/api/account/plan")).json;
    t.same("the plan's answer: Stripe's own prices, the room (none used, the free limit now, the pool), no assistant yet",
      [card?.prices, card?.room, card?.assistant],
      [{ monthly: { amount: 500, currency: "USD" }, yearly: { amount: 5000, currency: "USD" } }, { used: 0, limit: MB, free: MB, pool: 50 * 1024 ** 3 }, false]);
    const priced = stripe.calls.filter((c) => c.method === "GET" && /^prices\//.test(c.path)).length;
    await eli.get("/api/account/plan");
    t.same("  (the prices read once, then kept)", stripe.calls.filter((c) => c.method === "GET" && /^prices\//.test(c.path)).length, priced);
    const noPrice = /\$|USD|\b5\.00\b|\b50\.00\b|a month|a year/;
    const member = await begin(fay, 2 * MB);
    t.same("a member's write that doesn't fit: refused, naming the host as the way to more room, with no price",
      [member.status, member.json?.more_room, /Only the host can free space, or Eli Brooks can get more room\./.test(member.json?.reason ?? ""), noPrice.test(member.json?.reason ?? "")],
      [413, { host: "Eli Brooks" }, true, false]);
    const host = await begin(eli, 2 * MB);
    t.same("the host's: refused, naming their account page, with no price",
      [host.status, host.json?.more_room, /Or get more room, on your account page\./.test(host.json?.reason ?? ""), noPrice.test(host.json?.reason ?? "")],
      [413, { where: "/account#plan" }, true, false]);
    await eli.post("/api/account/plan/checkout", { interval: "monthly" });
    const bought = await stripe.pay([...stripe.sessions.values()].at(-1).id, origin);
    const on = (await eli.get("/api/account/plan")).json;
    t.same("with the plan, the host's limit is the pool", [bought.sent.status, on?.plan?.active, on?.room?.limit], [200, true, 50 * 1024 ** 3]);
    const [fits1, fits2] = [await begin(fay, 2 * MB, "a.jpg"), await begin(eli, 2 * MB, "b.jpg")];
    t.same("  and what didn't fit, the member's and the host's, now does", [fits1.status, fits2.status], [201, 201]);
    // Past due (a renewal that didn't go through yet, Stripe still retrying): the plan and its room stay.
    stripe.sub(bought.sub.id).status = "past_due";
    await stripe.send(origin, "customer.subscription.updated", { id: bought.sub.id });
    const due = (await eli.get("/api/account/plan")).json;
    const dueFits = await begin(eli, 2 * MB, "d.jpg");
    t.same("  past due: still the plan, the pool still the limit, and a new photo over the free limit still fits",
      [due?.plan?.active, due?.plan?.status, due?.room?.limit, dueFits.status], [true, "past_due", 50 * 1024 ** 3, 201]);
    stripe.sub(bought.sub.id).status = "active";
    await stripe.send(origin, "customer.subscription.updated", { id: bought.sub.id });
    // Ended as a cancel at the period's end ends: Stripe's own, with the person's cancel as its reason.
    Object.assign(stripe.sub(bought.sub.id), { status: "canceled", ended_at: Math.floor(Date.now() / 1000), cancellation_details: { reason: "cancellation_requested" } });
    await stripe.send(origin, "customer.subscription.deleted", { id: bought.sub.id });
    const off = (await eli.get("/api/account/plan")).json;
    t.same("  ended at the period's end after a cancel: it says the person cancelled it, and when", [off?.plan?.reason, Number.isInteger(off?.plan?.ended)], ["canceled", true]);
    const kept = server.sql(`SELECT COUNT(*) AS n FROM media_objects WHERE trip_id = '${trip}'`)[0].n;
    const after = await begin(fay, 100 * 1024, "c.jpg");
    t.same("ended: the free limit again, nothing removed, every new byte refused, the way to more room named again",
      [off?.plan?.active, off?.room?.limit, off?.room?.used >= 4 * MB, kept, after.status, after.json?.more_room], [false, MB, true, 3, 413, { host: "Eli Brooks" }]);
    // A first payment that never completes (a delayed method that failed): Stripe ends it as incomplete_expired. Yearly,
    // so its Checkout is a new one: the same account and interval within a minute is the same Checkout (its idempotency).
    const yearly = await eli.post("/api/account/plan/checkout", { interval: "yearly" });
    if (yearly.status !== 200) throw new CheckError(`a second Checkout for the never-paid case: ${yearly.status}`);
    const again = await stripe.pay([...stripe.sessions.values()].at(-1).id, origin, { interval: "year" });
    Object.assign(stripe.sub(again.sub.id), { status: "incomplete_expired", ended_at: Math.floor(Date.now() / 1000) });
    await stripe.send(origin, "customer.subscription.updated", { id: again.sub.id });
    const never = (await eli.get("/api/account/plan")).json;
    t.same("  a first payment that never completed: off, and it says it was never paid", [never?.plan?.active, never?.plan?.status, never?.plan?.reason], [false, "incomplete_expired", "never_paid"]);
  }

  t.part("13. Sales paused (PLAN_SALES): nobody new can buy; whoever has the plan keeps all of it");
  {
    const [hal, ivy] = ["Hal Brennan", "Ivy Okafor"].map((nm) => new Person(origin, nm));
    for (const p of [hal, ivy]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
    await hal.post("/api/account/plan/checkout", { interval: "monthly" });
    const halSub = (await stripe.pay([...stripe.sessions.values()].at(-1).id, origin)).sub;
    await server.halt();
    await server.start({ vars: { PLAN_SALES: "paused" } });
    const shown = (await ivy.get("/api/account/plan")).json;
    t.same("paused: the plan is still offered, and says its sales are paused", [shown?.offered, shown?.sales], [true, "paused"]);
    const buy = await ivy.post("/api/account/plan/checkout", { interval: "monthly" });
    t.same("  someone without it can't start a Checkout: refused in words", [buy.status, buy.json?.error, /isn't on sale right now/.test(buy.json?.reason ?? "")], [409, "paused", true]);
    t.same("  someone with it keeps it", [(await plan(hal))?.active, (await plan(hal))?.interval], [true, "month"]);
    stripe.sub(halSub.id).status = "past_due";
    const event = await stripe.send(origin, "invoice.payment_failed", { id: "in_paused", subscription: halSub.id });
    t.same("  the webhook still takes Stripe's events, and the plan follows them", [event.status, (await plan(hal))?.status], [200, "past_due"]);
    stripe.sub(halSub.id).status = "active";
    await stripe.send(origin, "invoice.paid", { id: "in_paused_paid", subscription: halSub.id });
    const portal = await hal.post("/api/account/plan/portal", {});
    t.ok("  and the Portal still opens for them", portal.status === 200 && portal.json?.url?.startsWith(`${stripe.base}/`), JSON.stringify(portal.json));
    await server.halt();
    await server.start({ vars: { PLAN_SALES: "" } });
    const open = await ivy.post("/api/account/plan/checkout", { interval: "monthly" });
    t.same("open again: Checkout works, and the plan says it's on sale", [open.status, (await ivy.get("/api/account/plan")).json?.sales], [200, "open"]);
  }

  const failed = server.log().split("\n").filter((l) => /Uncaught|✘|\[ERROR\]/.test(l));
  t.ok("nothing failed inside the server", failed.length === 0, failed.slice(0, 4).join(" | "));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await server?.stop();
  await stripe?.close();
}
process.exit(code);

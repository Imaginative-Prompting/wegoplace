// Why the plan ended, written once: when the site ends a plan itself (a lost dispute, a full refund), the subscription's
// row is written ended WITH that reason, and is never read as anything else on the way (src/billing/plan.js
// endForCustomer, syncSubscription's ownEnding).
//
//   node checks/billing/reason-once.mjs
//
// No server: the Worker's own webhook (receiveEvent) is called in this process, on D1 as node:sqlite with every
// migration (checks/lib/d1-local.mjs) and a stand-in Stripe on this machine (checks/lib/stripe-standin.mjs). The
// database is watched: after EVERY statement the Worker runs, the subscription's row is read back, so a reason written
// in a second statement after the row is already ended shows as what the row said in between. (On a live site a
// person's page, or a check, can read it in that moment: the row said "canceled", Stripe's own reason for a cancel
// through its API, and the card would have told someone whose dispute was lost that they had cancelled.)
//
// It holds:
//   1. a lost dispute: from the moment the row is ended, every read of it says dispute_lost, and the plan's answer
//      (entitlement) says so;
//   2. a full refund: the same, refunded;
//   3. Stripe's customer.subscription.deleted for the site's own cancel, handled afterwards (as it comes): the reason
//      stays;
//   4. the same event handled IN BETWEEN the site's cancel and its own write (Stripe sends it at once, and another
//      request of the Worker's can handle it first, reading Stripe later than this one): the site's reason still wins;
//   5. a plan cancelled by the person and ended by Stripe: "canceled", as ever (the site's own reason goes nowhere else).
// Everyone in it is made up.

import { d1Local } from "../lib/d1-local.mjs";
import { startStripe } from "../lib/stripe-standin.mjs";
import { Report } from "../lib/person.mjs";
import { receiveEvent, entitlement } from "../../src/billing/plan.js";

const t = new Report("why the plan ended, written once (src/billing/plan.js)");
const SECRET = "whsec_check_not_real", KEY = "sk_test_check_not_real";
let stripe = null, code = 1;
try {
  stripe = await startStripe({ secret: SECRET, key: KEY });
  const db = d1Local();
  const now = () => Math.floor(Date.now() / 1000);

  // The watch: after every statement, each subscription's row as it is then (ended_at, ended_reason).
  const seen = new Map();   // subscription id -> [{ after, ended, reason }]
  const look = (after) => {
    for (const r of db.sql("SELECT id, ended_at, ended_reason FROM billing_subscriptions")) {
      const list = seen.get(r.id) ?? seen.set(r.id, []).get(r.id);
      const last = list.at(-1);
      if (!last || last.ended !== r.ended_at || last.reason !== r.ended_reason) list.push({ after: after.replace(/\s+/g, " ").slice(0, 60), ended: r.ended_at, reason: r.ended_reason });
    }
  };
  const watched = {
    ...db,
    prepare(sql) {
      const wrap = (s) => ({ ...s, bind: (...a) => wrap(s.bind(...a)), async run() { const r = await s.run(); look(sql); return r; } });
      return wrap(db.prepare(sql));
    },
    async batch(list) { const r = await db.batch(list); look(list.map((s) => s.sql).join("; ")); return r; },
  };
  const env = { DB: watched, PLAN_ENABLED: "true", PUBLIC_ORIGIN: "http://localhost:1", STRIPE_API_BASE: stripe.base,
    STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_MONTHLY: "price_check_month", STRIPE_PRICE_YEARLY: "price_check_year" };

  let ev = 0;
  /** One event, signed as Stripe signs it, through the Worker's own webhook. */
  const deliver = async (type, object) => {
    const raw = JSON.stringify({ id: `evt_reason_${++ev}`, object: "event", type, livemode: false, data: { object } });
    const out = await receiveEvent(env, raw, stripe.sign(raw));
    if (out.status !== 200) throw new Error(`${type}: the webhook answered ${out.status} ${JSON.stringify(out.body)}`);
    return out.body;
  };
  /** A made-up person with the plan on: their account, their Stripe customer, an active monthly subscription. */
  let people = 0;
  const withPlan = async (name) => {
    const userId = `u-reason-${++people}`;
    db.raw.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)").run(userId, name, now());
    const customer = `cus_reason${people}`;
    stripe.customers.set(customer, { id: customer, object: "customer", metadata: { user_id: userId } });
    db.raw.prepare("INSERT INTO billing_customers (user_id, customer, created_at) VALUES (?, ?, ?)").run(userId, customer, now());
    const sub = { id: `sub_reason${people}`, object: "subscription", customer, status: "active", metadata: { user_id: userId }, cancel_at_period_end: false,
      items: { data: [{ current_period_end: now() + 30 * 86400, price: { id: "price_check_month", recurring: { interval: "month" } } }] } };
    stripe.subs.set(sub.id, sub);
    await deliver("customer.subscription.created", { id: sub.id, object: "subscription", customer });
    const on = await entitlement(env, userId);
    if (!on?.active) throw new Error(`${name}'s plan never came on: ${JSON.stringify(on)}`);
    return { userId, customer, sub };
  };
  /** Every read of the row from the moment it was ended: the reasons it gave. */
  const endedReads = (sid) => (seen.get(sid) ?? []).filter((x) => x.ended != null);
  const onlySaid = (sid, reason) => {
    const reads = endedReads(sid);
    return reads.length > 0 && reads.every((x) => x.reason === reason);
  };

  t.part("1. a lost dispute");
  const ben = await withPlan("Ben Arroyo");
  const lost = stripe.dispute(stripe.charge(ben.customer), "lost");
  const r1 = await deliver("charge.dispute.closed", { id: lost.id, object: "dispute" });
  t.same("the dispute lost ends the plan at Stripe", [r1.result?.ended, stripe.sub(ben.sub.id).status], [1, "canceled"]);
  t.ok("from the moment the row is ended, every read of it says dispute_lost (never Stripe's \"canceled\" first)",
    onlySaid(ben.sub.id, "dispute_lost"), JSON.stringify(endedReads(ben.sub.id)));
  const benPlan = await entitlement(env, ben.userId);
  t.same("the plan's answer: ended, for the dispute", [benPlan?.active, benPlan?.reason], [false, "dispute_lost"]);

  t.part("2. a full refund");
  const cleo = await withPlan("Cleo Banda");
  const r2 = await deliver("charge.refunded", stripe.charge(cleo.customer, { refunded: true }));
  t.same("the refund ends the plan at Stripe", [r2.result?.ended, stripe.sub(cleo.sub.id).status], [1, "canceled"]);
  t.ok("from the moment the row is ended, every read of it says refunded", onlySaid(cleo.sub.id, "refunded"), JSON.stringify(endedReads(cleo.sub.id)));
  t.same("the plan's answer: ended, refunded", [(await entitlement(env, cleo.userId))?.reason], ["refunded"]);

  t.part("3. Stripe's own event for the site's cancel, afterwards");
  await deliver("customer.subscription.deleted", { id: ben.sub.id, object: "subscription", customer: ben.customer });
  await deliver("customer.subscription.deleted", { id: cleo.sub.id, object: "subscription", customer: cleo.customer });
  t.ok("after it, the reasons stay: every read still dispute_lost and refunded",
    onlySaid(ben.sub.id, "dispute_lost") && onlySaid(cleo.sub.id, "refunded"), JSON.stringify({ ben: endedReads(ben.sub.id), cleo: endedReads(cleo.sub.id) }));

  t.part("4. that event handled in between the site's cancel and its own write");
  const dan = await withPlan("Dan Okoye");
  // The site's own read of the subscription after its cancel (the sync's GET) waits while another request of the
  // Worker's handles Stripe's customer.subscription.deleted to the end: that one reads Stripe later, and writes first.
  const plainFetch = globalThis.fetch;
  let raced = false;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (!raced && (init?.method ?? "GET") === "GET" && u.pathname === `/v1/subscriptions/${dan.sub.id}` && stripe.sub(dan.sub.id).status === "canceled") {
      raced = true;
      await new Promise((r) => setTimeout(r, 5));   // its read of Stripe is later than this one's
      await deliver("customer.subscription.deleted", { id: dan.sub.id, object: "subscription", customer: dan.customer });
    }
    return plainFetch(url, init);
  };
  try {
    await deliver("charge.dispute.closed", { id: stripe.dispute(stripe.charge(dan.customer), "lost").id, object: "dispute" });
  } finally { globalThis.fetch = plainFetch; }
  const danReads = endedReads(dan.sub.id);
  t.ok("  (the other request did come first: its write said Stripe's own reason)", raced && danReads[0]?.reason === "canceled", JSON.stringify(danReads));
  t.same("the site's own write still says dispute_lost, and the plan's answer does",
    [danReads.at(-1)?.reason, (await entitlement(env, dan.userId))?.reason], ["dispute_lost", "dispute_lost"]);

  t.part("5. a cancel by the person, ended by Stripe");
  const eve = await withPlan("Eve Lindqvist");
  Object.assign(stripe.sub(eve.sub.id), { status: "canceled", canceled_at: now(), ended_at: now(), cancellation_details: { reason: "cancellation_requested" } });
  await deliver("customer.subscription.deleted", { id: eve.sub.id, object: "subscription", customer: eve.customer });
  t.same("ended, as the person asked: canceled", [(await entitlement(env, eve.userId))?.reason], ["canceled"]);

  code = t.end();
} catch (error) {
  console.error(error);
  t.end();
  code = 2;
} finally {
  await stripe?.close();
}
process.exit(code);

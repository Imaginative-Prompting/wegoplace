// The plan (docs/model.md §20), with Stripe: Checkout to start it, the Customer Portal to change or
// cancel it, and Stripe's signed webhook as the one source of who has it. Offered only where
// PLAN_ENABLED is "true" and Stripe's keys and prices are set (planOffered); a copy someone hosts
// themselves has none of it, and every route here answers 404 there.
//
// The rules are Lexicommons' (its src/billing.ts), carried over:
//   - the webhook is checked before anything is read: HMAC-SHA256 of "<t>.<raw body>" with the
//     endpoint's secret, any v1 signature matching (so a secret can be rolled), at most 300 s old;
//   - each event is handled once (billing_events), and one that failed is handled when Stripe
//     sends it again;
//   - a subscription is never taken from an event: it is read from Stripe again and written as
//     Stripe has it now; a write from an older read never replaces one from a newer (synced_at);
//   - every account has one Stripe customer, made before its first Checkout; starting a Checkout
//     expires any other still open, so two tabs can't start two subscriptions;
//   - a full refund ends the customer's live plan at once; a dispute holds the plan's assistant
//     while it is open, and a lost one ends the plan;
//   - an account being deleted has its Checkouts expired and its live subscriptions ended first.
// Not carried over: Lexicommons' trials (§20: none; a first month free would be a promotion code at
// Checkout, whose box is off until there is a code to give out) and its read-only month then deletion (§20: nothing is removed when a plan ends; §7's
// rule for an account over its limit holds).

import { nowSec } from "../accounts/util.js";
import { recordServerError } from "../errors.js";

/** Stripe's API version this code is written for. */
export const STRIPE_VERSION = "2026-10-28.endive";

const SIGNATURE_TOLERANCE = 300;   // seconds
const CHECKOUT_OPEN = 24 * 3600;   // a Checkout Session lasts a day at most
const LIVE = new Set(["active", "trialing", "past_due"]);
const CAN_CHARGE = new Set([...LIVE, "incomplete", "unpaid"]);
// A dispute still to be settled (an inquiry's too): the plan's assistant is held while any is.
const OPEN_DISPUTE = ["warning_needs_response", "warning_under_review", "needs_response", "under_review"];

/** The plan's numbers, his (§20), read from the vars: what it adds and what the assistant may spend. */
export function planNumbers(env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    // The host's room across every trip they host while the plan is on (§7's pool).
    poolBytes: n(env.PLAN_POOL_BYTES, 50 * 1024 ** 3),
    // The assistant's monthly allowance, in millionths of a dollar of the model's reported cost.
    allowanceMicro: n(env.PLAN_AI_ALLOWANCE_MICRO, 2_000_000),
  };
}

/** Whether this site offers the plan: switched on, and Stripe's keys and prices set. Money only moves where it does. */
export const planOffered = (env) => env.PLAN_ENABLED === "true"
  && Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_MONTHLY && env.STRIPE_PRICE_YEARLY);

/**
 * Whether the plan's sales are paused (PLAN_SALES "paused"): nobody can start a Checkout; everyone who has the plan
 * keeps it, its renewals, the Portal and the webhook. The way to stop selling without switching the plan off
 * (PLAN_ENABLED off answers every plan route 404, the webhook's included).
 */
export const salesPaused = (env) => env.PLAN_SALES === "paused";

export class BillingError extends Error {
  constructor(message, status = 400, error = "billing") { super(message); this.status = status; this.error = error; }
}

// ── the signature ──────────────────────────────────────────────────────────────────────────

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Whether a Stripe-Signature header ("t=<s>,v1=<hex>[,v1=…]") signs this raw body with this secret, its time within the tolerance. */
export async function signedByStripe(raw, header, secret, now = nowSec(), tolerance = SIGNATURE_TOLERANCE) {
  if (!header || !secret) return false;
  const parts = String(header).split(",").map((part) => part.split("=", 2));
  const t = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k, v]) => k === "v1" && /^[0-9a-f]{64}$/.test(v ?? "")).map(([, v]) => v);
  if (!t || !/^\d{1,12}$/.test(t) || !signatures.length) return false;
  if (Math.abs(now - Number(t)) > tolerance) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`)));
  return signatures.some((s) => sameText(s, expected));
}

// ── Stripe's API ───────────────────────────────────────────────────────────────────────────

/** Form-encodes params the way Stripe reads them (a[b][0]=…). */
function form(params, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((item, i) => (item && typeof item === "object" ? form(item, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(item))));
    else if (typeof v === "object") form(v, name, out);
    else out.append(name, String(v));
  }
  return out;
}

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const IDEMPOTENT_WAITS = [250, 500, 1000, 2000];

/**
 * A call to Stripe's API. idempotencyKey: two calls with it get one result. STRIPE_API_BASE (a
 * stand-in Stripe) is honoured only on a local copy, so no setting can send a live site's key elsewhere.
 */
async function stripe(env, method, path, params, idempotencyKey) {
  const base = LOCAL.test(env.PUBLIC_ORIGIN ?? "") && env.STRIPE_API_BASE ? env.STRIPE_API_BASE : "https://api.stripe.com";
  const url = new URL(`${base}/v1/${path}`);
  const init = { method, headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Stripe-Version": STRIPE_VERSION, ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) } };
  if (params && method === "GET") for (const [k, v] of form(params)) url.searchParams.append(k, v);
  else if (params) { init.headers["Content-Type"] = "application/x-www-form-urlencoded"; init.body = form(params).toString(); }
  // A second call with a key whose first is still going through gets 409: it waits, then the first's answer.
  for (const wait of idempotencyKey ? IDEMPOTENT_WAITS : []) {
    const res = await fetch(url, init);
    if (res.status !== 409) return answerOf(env, method, path, res);
    await new Promise((r) => setTimeout(r, wait));
  }
  return answerOf(env, method, path, await fetch(url, init));
}
/**
 * Stripe's answer, or a refusal in plain words. A person never sees Stripe's own message (it is written for a
 * developer): it goes to the error log, where /admin/errors shows it, by the call it came from (ids left out).
 */
async function answerOf(env, method, path, res) {
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body;
  const call = `stripe ${method} ${path.split("/").map((p) => (/^[a-z_]+$/.test(p) ? p : ":id")).join("/")}`;
  await recordServerError(env, "server", new Error(`Stripe ${res.status}${body?.error?.param ? ` (${body.error.param})` : ""}: ${String(body?.error?.message ?? "no message").slice(0, 300)}`), call);
  throw new BillingError("Stripe couldn't do that just now. Try again in a minute.", 502, "stripe");
}
/** A Stripe refusal said for what the person was doing; anything else as it was. */
const sayFor = (words) => (e) => { throw e instanceof BillingError && e.error === "stripe" ? new BillingError(words, 502, "stripe") : e; };

// ── the account's plan ─────────────────────────────────────────────────────────────────────

/**
 * What this account has: { active, status, interval, until, cancels, held, poolBytes, allowanceMicro,
 * reason, ended }, or null where the site doesn't offer the plan. Ended: active false, the pool and the
 * allowance none (§7's free limit then holds), nothing removed; `ended` the time it ended (seconds) and
 * `reason` why: refunded or dispute_lost (we ended it), canceled, payment_failed, never_paid or dispute_lost (Stripe
 * did: stripeEnding), null when nobody said.
 */
/** When a live subscription ends, or null while it renews: Stripe's cancel_at when it's a time (how a cancel to the
 *  period's end comes on flexible billing), else the period's end when cancel_at_period_end is set (the older way). */
export const endsAt = (row) => row.cancel_at ?? (row.cancel_at_period_end ? row.current_period_end ?? null : null);

/**
 * The plan given to an account by the site's operator (0046 plan_grants; tools/plan-grant.mjs), while it holds: the row,
 * or null. No subscription and no Stripe behind it, so it holds whether or not the site sells the plan.
 */
/** The two refusals a given plan meets: there's nothing to buy, and nothing to manage. */
export const GIVEN_BUY = "You have the plan already: it was given to you, so there's nothing to buy.";
export const GIVEN_MANAGE = "Your plan was given to you: there's nothing to manage.";

export async function grantOf(env, userId) {
  if (!userId) return null;
  return (await env.DB.prepare("SELECT user_id, granted_at, reason FROM plan_grants WHERE user_id = ?1 AND revoked_at IS NULL").bind(userId).first()) ?? null;
}

export async function entitlement(env, userId) {
  // A live subscription first (while the site sells the plan): someone who pays always sees what they pay for, and
  // "Manage your plan" to cancel it. Then the operator's grant: the plan's room and allowance, nothing to renew, cancel
  // or hold, whether or not the site sells the plan. Then, while it sells it, how a past subscription ended.
  const offered = planOffered(env);
  const rows = offered
    ? (await env.DB.prepare("SELECT * FROM billing_subscriptions WHERE user_id = ?1 ORDER BY updated_at DESC").bind(userId).all()).results ?? []
    : [];
  const live = rows.find((r) => LIVE.has(r.status));
  const nums = planNumbers(env);
  if (!live && await grantOf(env, userId)) {
    return { active: true, status: "comp", interval: null, until: null, cancels: null, held: false,
      poolBytes: nums.poolBytes, allowanceMicro: nums.allowanceMicro, reason: null, ended: null };
  }
  if (!offered) return null;
  if (live) {
    return {
      active: true, status: live.status, interval: live.interval, until: live.current_period_end ?? null,
      cancels: endsAt(live), held: Boolean(live.held),
      poolBytes: nums.poolBytes, allowanceMicro: live.held ? 0 : nums.allowanceMicro, reason: null, ended: null,
    };
  }
  const last = rows[0] ?? null;
  return {
    active: false, status: last?.status ?? null, interval: last?.interval ?? null, until: null, cancels: null, held: false,
    poolBytes: 0, allowanceMicro: 0, reason: last?.ended_reason ?? null, ended: last?.ended_at ?? null,
  };
}

/** The account's Stripe customer, made once before its first Checkout; two requests at once make the same one. */
async function customerFor(env, userId) {
  const held = await env.DB.prepare("SELECT customer FROM billing_customers WHERE user_id = ?1").bind(userId).first();
  if (held) return held.customer;
  const made = await stripe(env, "POST", "customers", { metadata: { user_id: userId } }, `wegoplace-customer:${userId}`);
  if (typeof made.id !== "string" || !made.id) throw new BillingError("Stripe didn't make a customer.", 502, "stripe");
  await env.DB.prepare("INSERT INTO billing_customers (user_id, customer, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO NOTHING").bind(userId, made.id, nowSec()).run();
  const kept = await env.DB.prepare("SELECT customer FROM billing_customers WHERE user_id = ?1").bind(userId).first();
  if (!kept) throw new BillingError("The account's Stripe customer wasn't kept.", 500, "stripe");
  return kept.customer;
}

/** A customer's Checkouts still open, but `keep`, expired: none of them can start a second subscription. */
async function expireOpenCheckouts(env, customer, keep = null) {
  const open = await stripe(env, "GET", "checkout/sessions", { customer, status: "open", limit: 100 });
  let expired = 0;
  for (const s of open.data ?? []) {
    if (typeof s.id !== "string" || s.id === keep) continue;
    // One completed meanwhile can't be expired; its subscription is then the customer's.
    await stripe(env, "POST", `checkout/sessions/${encodeURIComponent(s.id)}/expire`).then(() => expired++, () => {});
  }
  return expired;
}

/**
 * The plan's prices as Stripe has them (the page never states a price Checkout wouldn't charge):
 * { monthly, yearly }, each { amount (minor units), currency }, or null if Stripe can't be read
 * just now. Read from the Price objects, kept an hour in this Worker.
 */
const PRICES_KEEP_MS = 3600 * 1000;
let pricesKept = null;
export async function planPrices(env) {
  if (!planOffered(env)) return null;
  const key = `${env.STRIPE_PRICE_MONTHLY}|${env.STRIPE_PRICE_YEARLY}`;
  if (pricesKept && pricesKept.key === key && Date.now() - pricesKept.at < PRICES_KEEP_MS) return pricesKept.prices;
  try {
    const read = async (id) => {
      const p = await stripe(env, "GET", `prices/${encodeURIComponent(id)}`);
      if (!Number.isInteger(p.unit_amount) || typeof p.currency !== "string") throw new BillingError("Stripe's price has no amount.", 502, "stripe");
      return { amount: p.unit_amount, currency: p.currency.toUpperCase() };
    };
    const [monthly, yearly] = await Promise.all([read(env.STRIPE_PRICE_MONTHLY), read(env.STRIPE_PRICE_YEARLY)]);
    pricesKept = { key, at: Date.now(), prices: { monthly, yearly } };
    return pricesKept.prices;
  } catch {
    return null;
  }
}

/**
 * Starts Checkout, monthly or yearly: { url }. The card is always taken. No promotion-code box: there is no code to give
 * out (allow_promotion_codes is left off until there is one, so the page never asks for something nobody has).
 */
export async function startCheckout(env, userId, interval, now = nowSec()) {
  if (!planOffered(env)) throw new BillingError("This site doesn't offer a plan.", 404, "not offered");
  const price = interval === "yearly" ? env.STRIPE_PRICE_YEARLY : interval === "monthly" ? env.STRIPE_PRICE_MONTHLY : null;
  if (!price) throw new BillingError('Say "monthly" or "yearly".', 400, "bad interval");
  if (salesPaused(env)) throw new BillingError("The plan isn't on sale right now. If you have it, it keeps working as before.", 409, "paused");
  const plan = await entitlement(env, userId);
  if (plan?.status === "comp") throw new BillingError(GIVEN_BUY, 409, "already");
  if (plan?.active) throw new BillingError("You have the plan already. You can cancel it from Manage your plan.", 409, "already");
  const customer = await customerFor(env, userId).catch(sayFor("The payment page couldn't be opened just now. Nothing was charged. Try again in a minute."));
  const session = await stripe(env, "POST", "checkout/sessions", {
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: userId,
    customer,
    success_url: `${env.PUBLIC_ORIGIN}/account?plan=done#plan`,
    cancel_url: `${env.PUBLIC_ORIGIN}/account#plan`,
    payment_method_collection: "always",
    // No payment_method_types: at this API version Stripe refuses it on a Checkout Session ("no longer supported…
    // managed from your Dashboard settings"). Cards only is the account's setting (Settings › Payment methods), in
    // TEST and LIVE alike; the checklist reads that Checkout offers a card and nothing else.
    automatic_tax: { enabled: env.STRIPE_AUTOMATIC_TAX === "true" ? "true" : "false" },
    subscription_data: { metadata: { user_id: userId } },
  }, `wegoplace-checkout:${userId}:${interval}:${Math.floor(now / 60)}`).catch(sayFor("The payment page couldn't be opened just now. Nothing was charged. Try again in a minute."));
  const local = LOCAL.test(env.PUBLIC_ORIGIN ?? "") && env.STRIPE_API_BASE;
  if (typeof session.url !== "string" || !(session.url.startsWith("https://checkout.stripe.com/") || (local && session.url.startsWith(env.STRIPE_API_BASE)))) {
    throw new BillingError("Stripe didn't give a Checkout page.", 502, "stripe");
  }
  await env.DB.prepare("UPDATE billing_customers SET checkout_at = ?1 WHERE user_id = ?2").bind(now, userId).run();
  await expireOpenCheckouts(env, customer, typeof session.id === "string" ? session.id : null);
  return { url: session.url };
}

/** Opens the Customer Portal for this account: { url }. */
export async function openPortal(env, userId) {
  if (!planOffered(env)) throw new BillingError("This site doesn't offer a plan.", 404, "not offered");
  // A given plan with no live subscription behind it: nothing to manage (one that also pays manages what it pays for).
  if ((await entitlement(env, userId))?.status === "comp") throw new BillingError(GIVEN_MANAGE, 409, "given");
  const held = await env.DB.prepare("SELECT customer FROM billing_customers WHERE user_id = ?1").bind(userId).first();
  if (!held) throw new BillingError("There's no plan on this account yet.", 404, "no plan");
  const session = await stripe(env, "POST", "billing_portal/sessions", {
    customer: held.customer, return_url: `${env.PUBLIC_ORIGIN}/account#plan`,
    ...(env.STRIPE_PORTAL_CONFIGURATION ? { configuration: env.STRIPE_PORTAL_CONFIGURATION } : {}),
  }).catch(sayFor("Manage your plan couldn't be opened just now. Try again in a minute."));
  const local = LOCAL.test(env.PUBLIC_ORIGIN ?? "") && env.STRIPE_API_BASE;
  if (typeof session.url !== "string" || !(/^https:\/\/billing\.stripe\.com\//.test(session.url) || (local && session.url.startsWith(env.STRIPE_API_BASE)))) {
    throw new BillingError("Stripe didn't give a Portal page.", 502, "stripe");
  }
  return { url: session.url };
}

// ── the webhook ────────────────────────────────────────────────────────────────────────────

const customerOf = (o) => (typeof o?.customer === "string" ? o.customer : (o?.customer?.id ?? null));

/**
 * Which account a subscription is for: the one its Checkout named, if that account holds its
 * customer (or none does yet). { userId: null, gone: true } when the named account no longer exists
 * and nobody holds the customer (deleted while its Checkout was open).
 */
async function ownerOf(env, sub) {
  const customer = customerOf(sub);
  const named = typeof sub.metadata?.user_id === "string" ? sub.metadata.user_id : null;
  const held = await env.DB.prepare("SELECT user_id FROM billing_customers WHERE customer = ?1").bind(customer).first();
  if (held) return { userId: !named || named === held.user_id ? held.user_id : null };
  if (!named) return { userId: null };
  const user = await env.DB.prepare("SELECT id FROM users WHERE id = ?1 AND deleted_at IS NULL").bind(named).first();
  if (!user) return { userId: null, gone: true };
  const put = await env.DB.prepare("INSERT INTO billing_customers (user_id, customer, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO NOTHING").bind(named, customer, nowSec()).run();
  if (!put.meta.changes) {
    const mine = await env.DB.prepare("SELECT customer FROM billing_customers WHERE user_id = ?1").bind(named).first();
    return { userId: mine?.customer === customer ? named : null };
  }
  return { userId: named };
}

/**
 * Why Stripe ended a subscription, in the app's words (GET /api/account/plan's `reason`):
 *   canceled        the person cancelled it (at the end of what they paid for, or at once): cancellation_requested
 *   payment_failed  its payment never came after Stripe's retries (unpaid, or cancelled for payment_failed)
 *   never_paid      its first payment never completed (incomplete_expired)
 *   dispute_lost    Stripe ended it for a dispute (payment_disputed)
 * null when Stripe gives no reason. Our own endings (refunded, dispute_lost: endForCustomer) are written BY the sync that
 * writes the subscription ended, in the same statement, and kept by every later one: written after it, the row read
 * for a moment as Stripe's own reason (a cancel through the API is "cancellation_requested": "canceled"), and a
 * person whose dispute was lost could be told they had cancelled (checks/billing/reason-once.mjs).
 */
function stripeEnding(sub) {
  if (sub.status === "incomplete_expired") return "never_paid";
  if (sub.status === "unpaid") return "payment_failed";
  const why = sub.cancellation_details?.reason;
  return why === "cancellation_requested" ? "canceled" : why === "payment_failed" ? "payment_failed" : why === "payment_disputed" ? "dispute_lost" : null;
}

/**
 * Reads a subscription from Stripe and writes it as it is now (never from the event). One whose account is gone is canceled.
 * ownEnding: why WE ended it (endForCustomer: refunded, dispute_lost), written with it once Stripe has it ended. It wins
 * over Stripe's reason and over a newer read: Stripe's customer.subscription.deleted for our own cancel can be handled
 * between our cancel and this write, and its sync would otherwise keep the reason "canceled" (an ended subscription is
 * ended for good, so the older read says nothing the newer doesn't).
 */
export async function syncSubscription(env, id, { ownEnding = null } = {}) {
  const readAt = Date.now();
  const sub = await stripe(env, "GET", `subscriptions/${encodeURIComponent(id)}`);
  const { userId, gone } = await ownerOf(env, sub);
  if (!userId) {
    if (gone && CAN_CHARGE.has(sub.status)) {
      await stripe(env, "DELETE", `subscriptions/${encodeURIComponent(id)}`);
      return { id, skipped: "no account", canceled: true };
    }
    return { id, skipped: "no account" };
  }
  const item = sub.items?.data?.[0];
  const periodEnd = item?.current_period_end ?? sub.current_period_end ?? null;
  const ended = sub.status === "canceled" || sub.status === "incomplete_expired" || sub.status === "unpaid";
  const own = ended && ownEnding ? ownEnding : null;
  await env.DB.prepare(
    `INSERT INTO billing_subscriptions (id, user_id, customer, status, interval, current_period_end, cancel_at_period_end, cancel_at, ended_at, ended_reason, updated_at, synced_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?11, ?8, ?12, ?9, ?10)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, interval = excluded.interval, current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end, cancel_at = excluded.cancel_at,
       ended_at = CASE WHEN excluded.ended_at IS NULL THEN NULL ELSE COALESCE(billing_subscriptions.ended_at, excluded.ended_at) END,
       ended_reason = CASE WHEN excluded.ended_at IS NULL THEN NULL WHEN ?13 IS NOT NULL THEN excluded.ended_reason
         ELSE COALESCE(billing_subscriptions.ended_reason, excluded.ended_reason) END,
       updated_at = excluded.updated_at, synced_at = MAX(COALESCE(billing_subscriptions.synced_at, 0), excluded.synced_at)
     WHERE billing_subscriptions.synced_at IS NULL OR excluded.synced_at >= billing_subscriptions.synced_at OR ?13 IS NOT NULL`,
  ).bind(id, userId, customerOf(sub), sub.status, item?.price?.recurring?.interval ?? null, periodEnd,
    sub.cancel_at_period_end ? 1 : 0, ended ? (sub.ended_at ?? sub.canceled_at ?? nowSec()) : null, nowSec(), readAt,
    Number.isInteger(sub.cancel_at) ? sub.cancel_at : null, ended ? (own ?? stripeEnding(sub)) : null, own).run();
  return { id, userId, status: sub.status };
}

/** A customer's subscriptions that can still charge, as Stripe has them now (one not written here yet included). */
async function liveAtStripe(env, customer) {
  const list = await stripe(env, "GET", "subscriptions", { customer, status: "all", limit: 100 });
  return (list.data ?? []).filter((s) => typeof s.id === "string" && CAN_CHARGE.has(s.status)).map((s) => s.id);
}

/** Ends a customer's live subscriptions at once (a refund, a lost dispute), saying why. */
async function endForCustomer(env, customer, reason) {
  const live = await liveAtStripe(env, customer);
  for (const id of live) {
    await stripe(env, "DELETE", `subscriptions/${encodeURIComponent(id)}`);
    await syncSubscription(env, id, { ownEnding: reason });
  }
  return live.length;
}

/** One verified event: what it changes. */
async function handle(env, event) {
  const o = event.data?.object ?? {};
  switch (event.type) {
    case "checkout.session.completed":
      return o.subscription ? syncSubscription(env, String(o.subscription)) : { skipped: "no subscription" };
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      return syncSubscription(env, String(o.id));
    case "invoice.paid":
    case "invoice.payment_failed": {
      const sub = o.parent?.subscription_details?.subscription ?? o.subscription;
      return sub ? syncSubscription(env, String(sub)) : { skipped: "not a subscription's invoice" };
    }
    case "charge.refunded": {
      if (!o.refunded) return { skipped: "partial refund" };   // a partial refund changes nothing
      const customer = customerOf(o);
      return customer ? { ended: await endForCustomer(env, customer, "refunded") } : { skipped: "no customer" };
    }
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed": {
      if (typeof o.id !== "string") return { skipped: "no dispute" };
      // The dispute as Stripe has it now, whatever order its events came in.
      const dispute = await stripe(env, "GET", `disputes/${encodeURIComponent(o.id)}`);
      const charge = typeof dispute.charge === "string" ? await stripe(env, "GET", `charges/${encodeURIComponent(dispute.charge)}`) : dispute.charge;
      const customer = customerOf(charge);
      if (!customer || typeof dispute.status !== "string") return { skipped: "no customer" };
      await env.DB.prepare("INSERT INTO billing_disputes (id, customer, status, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at")
        .bind(dispute.id ?? o.id, customer, dispute.status, nowSec()).run();
      if (dispute.status === "lost") return { ended: await endForCustomer(env, customer, "dispute_lost") };
      const open = await env.DB.prepare(`SELECT COUNT(*) AS n FROM billing_disputes WHERE customer = ?1 AND status IN (${OPEN_DISPUTE.map((_, i) => `?${i + 2}`).join(", ")})`)
        .bind(customer, ...OPEN_DISPUTE).first();
      const held = (open?.n ?? 0) > 0 ? 1 : 0;
      await env.DB.prepare("UPDATE billing_subscriptions SET held = ?1, updated_at = ?2 WHERE customer = ?3").bind(held, nowSec(), customer).run();
      return held ? { held: customer } : { released: customer };
    }
    default:
      return { skipped: "not one this site listens for" };
  }
}

/** The webhook: checked, then each event once. Answers { status, body }. */
export async function receiveEvent(env, raw, signature, now = nowSec()) {
  if (!planOffered(env)) return { status: 404, body: { error: "not offered", reason: "This site doesn't offer a plan." } };
  if (!(await signedByStripe(raw, signature, env.STRIPE_WEBHOOK_SECRET, now))) {
    return { status: 400, body: { error: "bad signature", reason: "That isn't signed by this site's Stripe endpoint, or its time is too far from now." } };
  }
  let event;
  try { event = JSON.parse(raw); } catch { return { status: 400, body: { error: "not json", reason: "The body isn't JSON." } }; }
  if (typeof event?.id !== "string" || typeof event?.type !== "string") return { status: 400, body: { error: "not an event", reason: "That JSON isn't a Stripe event." } };
  if (event.livemode === true && String(env.STRIPE_SECRET_KEY).startsWith("sk_test_")) {
    return { status: 400, body: { error: "live event on test keys", reason: "A live event can't be handled with test keys." } };
  }
  const seen = await env.DB.prepare("INSERT INTO billing_events (id, type, received_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO NOTHING").bind(event.id, event.type, now).run();
  if (!seen.meta.changes) {
    const done = await env.DB.prepare("SELECT done_at FROM billing_events WHERE id = ?1").bind(event.id).first();
    if (done?.done_at) return { status: 200, body: { ok: true, already: true } };
  }
  try {
    const result = await handle(env, event);
    await env.DB.prepare("UPDATE billing_events SET done_at = ?1 WHERE id = ?2").bind(nowSec(), event.id).run();
    return { status: 200, body: { ok: true, result } };
  } catch (e) {
    // Not marked done: Stripe sends it again, and it's handled then.
    return { status: 500, body: { error: "failed", reason: e instanceof Error ? e.message : "It couldn't be handled." } };
  }
}

/**
 * Before an account is deleted: its Checkouts still open are expired and its live subscriptions
 * end at Stripe, so nothing is charged after. Stripe is asked only when something there could still
 * charge. Throws (BillingError) if Stripe can't be reached then: the deletion waits.
 */
export async function endForDeletion(env, userId, now = nowSec()) {
  if (!env.STRIPE_SECRET_KEY) return 0;
  const c = await env.DB.prepare("SELECT customer, checkout_at FROM billing_customers WHERE user_id = ?1").bind(userId).first();
  if (!c) return 0;
  const keptLive = await env.DB.prepare(`SELECT 1 FROM billing_subscriptions WHERE user_id = ?1 AND status IN ('active', 'trialing', 'past_due', 'incomplete', 'unpaid') LIMIT 1`).bind(userId).first();
  const checkoutLately = c.checkout_at !== null && now - c.checkout_at < CHECKOUT_OPEN;
  if (!keptLive && !checkoutLately) return 0;
  if (checkoutLately) await expireOpenCheckouts(env, c.customer);
  const live = await liveAtStripe(env, c.customer);
  for (const id of live) await stripe(env, "DELETE", `subscriptions/${encodeURIComponent(id)}`);
  return live.length;
}

/** The tables with an account's billing rows, removed with it (src/accounts/delete.js). */
export const BILLING_TABLES = ["billing_subscriptions", "billing_customers", "plan_grants"];

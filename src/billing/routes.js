// The plan's routes (src/billing/plan.js). Each answers 404 "not offered", in words, where the site
// doesn't offer the plan: a copy someone hosts themselves has none of it.
//
//   POST /api/billing/stripe          Stripe's webhook: outside the gate (it is signed, src/gate.js)
//   GET  /api/account/plan            { offered: true, sales, plan: { active, status, interval, until, cancels, held, poolBytes, allowanceMicro, reason, ended },
//                                       prices: { monthly, yearly: { amount, currency } } | null, room: { used, limit, free, pool }, assistant }
//   POST /api/account/plan/checkout   { interval: "monthly" | "yearly" } -> { url } (Stripe's Checkout)
//   POST /api/account/plan/portal     -> { url } (Stripe's Customer Portal)

import { json } from "../api/json.js";
import { readObject } from "../accounts/util.js";
import { guestRefused, isGuest, waysIn } from "../accounts/guests.js";
import { BillingError, GIVEN_BUY, GIVEN_MANAGE, entitlement, grantOf, openPortal, planNumbers, planOffered, planPrices, receiveEvent, salesPaused, startCheckout } from "./plan.js";
import { freeLimit, heldSql, limitFor, reservationCut } from "../trips/storage.js";
import { assistantFor, hostMonth } from "../assistant/meter.js";

/** The host's month, each trip with its name (a trip deleted since has none: its cost stays in the month). */
async function assistantMonth(env, userId) {
  const m = await hostMonth(env, userId);
  const ids = m.trips.map((x) => x.trip_id).filter(Boolean);
  const names = new Map();
  if (ids.length) {
    const rows = await env.DB.prepare(`SELECT id, name FROM trips WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(", ")})`).bind(...ids).all();
    for (const r of rows.results ?? []) names.set(r.id, r.name);
  }
  return { month: m.month, allowance: m.allowance, used: m.used, back: m.back, trips: m.trips.map((x) => ({ trip_id: x.trip_id, name: names.get(x.trip_id) ?? "", used: x.used, calls: x.calls })) };
}

const WEBHOOK_MAX = 512 * 1024;   // Stripe's events are a few KB; read no more than this
const NOT_OFFERED = () => json({ error: "not offered", reason: "This site doesn't offer a plan." }, 404);
const refused = (e) => (e instanceof BillingError
  ? json({ error: e.error, reason: e.message }, e.status)
  : json({ error: "failed", reason: "The plan couldn't be reached just now. Try again in a moment." }, 500));

export async function stripeWebhook({ request, env }) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > WEBHOOK_MAX) return json({ error: "too large", reason: "That's larger than any Stripe event." }, 413);
  const raw = await request.text();
  if (raw.length > WEBHOOK_MAX) return json({ error: "too large", reason: "That's larger than any Stripe event." }, 413);
  const { status, body } = await receiveEvent(env, raw, request.headers.get("Stripe-Signature"));
  return json(body, status);
}

export async function getPlan({ env, data }) {
  // Answered where the site sells the plan, and for an account the operator gave it to (0046) where it doesn't.
  const grant = await grantOf(env, data.user.id);
  if (!planOffered(env) && !grant) return NOT_OFFERED();
  const assistantHere = await assistantFor(env, data.user.id);
  const now = Math.floor(Date.now() / 1000);
  const [plan, prices, limit, used] = await Promise.all([
    entitlement(env, data.user.id), planPrices(env), limitFor(env, data.user.id),
    env.DB.prepare(`SELECT ${heldSql("t.host_id = ?1", "?2")} AS bytes`).bind(data.user.id, reservationCut(now)).first(),
  ]);
  return json({
    // sales: "open", or "paused" (PLAN_SALES): no new Checkout; whoever has the plan keeps it.
    // offered: whether the site sells the plan (false for a given one where it doesn't: no prices, nothing to buy).
    offered: planOffered(env), sales: salesPaused(env) ? "paused" : "open", plan, prices,
    // What the account holds across the trips it hosts, its limit now, and the two limits: the
    // card says what the plan adds. The assistant only where it is switched on (§20).
    room: { used: Number(used?.bytes) || 0, limit, free: freeLimit(env), pool: Math.max(planNumbers(env).poolBytes, freeLimit(env)) },
    assistant: env.ASSISTANT_ENABLED === "true" || (Boolean(grant) && assistantHere),
    // The host's assistant this month, per trip they host (never per person): the account page's list.
    ...(assistantHere ? { assistant_month: await assistantMonth(env, data.user.id) } : {}),
  });
}

export async function postCheckout({ request, env, data }) {
  if (isGuest(data.user)) return guestRefused(env, `You're a guest: the plan is a host's. Add ${waysIn(env)} on your account page first.`);
  // A given plan (0046) is refused in its own words whether or not the site sells the plan: there's nothing to buy.
  if (!planOffered(env)) return (await grantOf(env, data.user.id)) ? refused(new BillingError(GIVEN_BUY, 409, "already")) : NOT_OFFERED();
  const body = await readObject(request);
  try { return json(await startCheckout(env, data.user.id, body?.interval)); } catch (e) { return refused(e); }
}

export async function postPortal({ env, data }) {
  if (isGuest(data.user)) return guestRefused(env, `You're a guest: the plan is a host's. Add ${waysIn(env)} on your account page first.`);
  if (!planOffered(env)) return (await grantOf(env, data.user.id)) ? refused(new BillingError(GIVEN_MANAGE, 409, "given")) : NOT_OFFERED();   // no subscription is read while the site sells none
  try { return json(await openPortal(env, data.user.id)); } catch (e) { return refused(e); }
}

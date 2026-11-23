// A stand-in for Stripe on this machine, for the plan's checks (src/billing/plan.js): the few parts
// of Stripe's API the Worker calls, kept in memory, and Stripe's side of the webhook (events signed
// as Stripe signs them). Nothing here reaches Stripe.
//
//   const stripe = await startStripe({ secret: "whsec_…", key: "sk_test_…" });
//   stripe.base                     its address: the Worker's STRIPE_API_BASE (honoured only on a local copy)
//   stripe.pay(sessionId)           a Checkout paid: its subscription made, active, and checkout.session.completed sent
//   stripe.send(origin, type, object, { id, at, secret, header }) one event to the Worker's webhook: { status, json }
//   stripe.sub(id) / stripe.subs    the subscriptions as Stripe has them; set .status etc. to change one
//   stripe.dispute(...) / refund    a dispute or a refund on a customer's charge
//   stripe.failNext(n)              the next n API calls answer 500 (Stripe unreachable)
//   stripe.calls                    every call: { method, path, idempotency, version, auth }
//   stripe.prices                   the Price objects it answers (by id; set .unit_amount to change one)
//   GET  <base>/pay/<session>       Checkout's page, for a browser: "Pay" pays it (as pay()) and goes to its success_url
//   GET  <base>/portal/<customer>   the Portal's page: "Cancel subscription" (to the period's end) or, once cancelled,
//                                   "Don't cancel subscription", each sent as Stripe sends it, and back. A cancel comes
//                                   as flexible billing sends it (cancel_at the period's end, cancel_at_period_end false,
//                                   canceled_at now), or with cancelShape: "flag" as the older way (the flag alone).
//   stripe.close()

import crypto from "node:crypto";
import http from "node:http";

export async function startStripe({ secret, key, prices: priced = { price_check_month: [500, "usd", "month"], price_check_year: [5000, "usd", "year"] }, cancelShape = "cancel_at" }) {
  const customers = new Map(), sessions = new Map(), subs = new Map(), disputes = new Map(), charges = new Map();
  const prices = new Map(Object.entries(priced).map(([pid, [amount, currency, interval]]) => [pid, { id: pid, object: "price", unit_amount: amount, currency, recurring: { interval }, active: true }]));
  const portals = new Map();   // customer -> the return_url its last Portal session was given
  const idem = new Map();
  const calls = [];
  let n = 0, failing = 0;
  const id = (prefix) => `${prefix}_check${String(++n).padStart(4, "0")}`;
  const now = () => Math.floor(Date.now() / 1000);

  // Stripe's form encoding, read back: a[b][0]=… to { a: { b: [ … ] } }.
  function unform(text) {
    const out = {};
    for (const [k, v] of new URLSearchParams(text)) {
      const path = k.replace(/\]/g, "").split("[");
      let at = out;
      path.forEach((p, i) => {
        const last = i === path.length - 1;
        const nextIsIndex = !last && /^\d+$/.test(path[i + 1]);
        if (last) at[p] = v;
        else at = at[p] ??= nextIsIndex ? [] : {};
      });
    }
    return out;
  }

  const subscription = (s) => s;
  function answer(method, path, q, body) {
    let m;
    if (method === "POST" && path === "customers") {
      const c = { id: id("cus"), object: "customer", metadata: body.metadata ?? {} };
      customers.set(c.id, c);
      return [200, c];
    }
    if (method === "GET" && path === "checkout/sessions") {
      return [200, { data: [...sessions.values()].filter((s) => (!q.get("customer") || s.customer === q.get("customer")) && (!q.get("status") || s.status === q.get("status"))) }];
    }
    if (method === "POST" && path === "checkout/sessions") {
      // As Stripe answers at the app's API version (2026-10-28.endive): payment_method_types refused in its own words
      // (seen on real Stripe, 21 Nov), and any parameter not among those real Stripe has answered 200 to refused as
      // Stripe refuses an unknown one. A new parameter in the app is red here until it is added to SEEN, after a walk
      // has shown real Stripe take it.
      if (body.payment_method_types !== undefined) {
        return [400, { error: { type: "invalid_request_error", param: "payment_method_types",
          message: "The `payment_method_types` parameter is no longer supported when creating a Checkout Session. Payment methods are now managed from your Dashboard settings (https://dashboard.stripe.com/settings/payment_methods). For migration guidance, see https://docs.stripe.com/payments/payment-methods/dynamic-payment-methods." } }];
      }
      const SEEN = ["mode", "line_items", "client_reference_id", "customer", "success_url", "cancel_url", "payment_method_collection", "automatic_tax", "subscription_data", "allow_promotion_codes"];
      const unknown = Object.keys(body).find((k) => !SEEN.includes(k));
      if (unknown) return [400, { error: { type: "invalid_request_error", param: unknown, message: `Received unknown parameter: ${unknown}` } }];
      if (!customers.has(body.customer)) return [400, { error: { message: "No such customer" } }];
      const s = { id: id("cs"), object: "checkout.session", status: "open", customer: body.customer, client_reference_id: body.client_reference_id,
        price: body.line_items?.[0]?.price, mode: body.mode, metadata: body.subscription_data?.metadata ?? {}, subscription: null,
        allow_promotion_codes: body.allow_promotion_codes, payment_method_collection: body.payment_method_collection, payment_method_types: body.payment_method_types ?? null, success_url: body.success_url };
      s.url = `${base}/pay/${s.id}`;
      sessions.set(s.id, s);
      return [200, s];
    }
    if (method === "POST" && (m = path.match(/^checkout\/sessions\/([^/]+)\/expire$/))) {
      const s = sessions.get(m[1]);
      if (!s) return [404, { error: { message: "No such session" } }];
      if (s.status !== "open") return [400, { error: { message: `Session is ${s.status}` } }];
      s.status = "expired";
      return [200, s];
    }
    if (method === "POST" && path === "billing_portal/sessions") {
      if (!customers.has(body.customer)) return [400, { error: { message: "No such customer" } }];
      portals.set(body.customer, body.return_url ?? null);
      return [200, { id: id("bps"), url: `${base}/portal/${body.customer}` }];
    }
    if (method === "GET" && (m = path.match(/^prices\/([^/]+)$/))) {
      const p = prices.get(m[1]);
      return p ? [200, p] : [404, { error: { message: "No such price" } }];
    }
    if (method === "GET" && (m = path.match(/^subscriptions\/([^/]+)$/))) {
      const s = subs.get(m[1]);
      return s ? [200, subscription(s)] : [404, { error: { message: "No such subscription" } }];
    }
    if (method === "GET" && path === "subscriptions") {
      return [200, { data: [...subs.values()].filter((s) => s.customer === q.get("customer")) }];
    }
    if (method === "DELETE" && (m = path.match(/^subscriptions\/([^/]+)$/))) {
      const s = subs.get(m[1]);
      if (!s) return [404, { error: { message: "No such subscription" } }];
      // As Stripe's own: a cancel through the API says it was asked for.
      s.status = "canceled"; s.canceled_at = now(); s.ended_at = now(); s.cancellation_details = { reason: "cancellation_requested" };
      return [200, subscription(s)];
    }
    if (method === "GET" && (m = path.match(/^disputes\/([^/]+)$/))) {
      const d = disputes.get(m[1]);
      return d ? [200, d] : [404, { error: { message: "No such dispute" } }];
    }
    if (method === "GET" && (m = path.match(/^charges\/([^/]+)$/))) {
      const c = charges.get(m[1]);
      return c ? [200, c] : [404, { error: { message: "No such charge" } }];
    }
    return [404, { error: { message: `The stand-in has no ${method} ${path}` } }];
  }

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const u = new URL(req.url, "http://stand-in");
      const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      if (u.pathname.startsWith("/pay/") || u.pathname.startsWith("/portal/")) return page(req, res, u, raw).catch((e) => { res.writeHead(500); res.end(String(e)); });
      if (!u.pathname.startsWith("/v1/")) return send(404, { error: { message: "not the API" } });
      const path = u.pathname.slice(4);
      const call = { method: req.method, path, idempotency: req.headers["idempotency-key"] ?? null, version: req.headers["stripe-version"] ?? null,
        auth: req.headers.authorization === `Bearer ${key}` };
      calls.push(call);
      if (!call.auth) return send(401, { error: { message: "Invalid API key" } });
      if (failing > 0) { failing--; return send(500, { error: { message: "The stand-in is down" } }); }
      const body = unform(raw);
      if (call.idempotency && idem.has(call.idempotency)) return send(...idem.get(call.idempotency));
      const out = answer(req.method, path, u.searchParams, body);
      if (call.idempotency && out[0] === 200) idem.set(call.idempotency, out);
      send(...out);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // The two pages a browser is sent to: plain, and saying what they are (nothing here is Stripe's).
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html = (res, title, body) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>`
      + `<body style="font:16px system-ui;margin:24px;max-width:480px"><p style="color:#a33"><b>Stand-in Stripe, for the checks only.</b></p><h1>${esc(title)}</h1>${body}</body>`);
  };
  const go = (res, to) => { res.writeHead(303, { Location: to }); res.end(); };
  async function page(req, res, u, raw = "") {
    let m;
    if ((m = u.pathname.match(/^\/pay\/([^/]+)$/))) {
      const s = sessions.get(m[1]);
      if (!s) { res.writeHead(404); res.end("No such Checkout"); return; }
      if (req.method === "POST") {
        if (s.status === "open") await api.pay(s.id, new URL(s.success_url).origin, { interval: prices.get(s.price)?.recurring?.interval ?? "month" });
        return go(res, s.success_url);
      }
      const p = prices.get(s.price);
      return html(res, "Checkout", `<p id="sc-price">${p ? `${(p.unit_amount / 100).toFixed(2)} ${p.currency.toUpperCase()} a ${p.recurring.interval}` : "No price"}</p>`
        + `<p id="sc-state">${esc(s.status)}</p><form method="post"><button id="sc-pay" type="submit">Pay</button></form>`);
    }
    if ((m = u.pathname.match(/^\/portal\/([^/]+)$/))) {
      const back = portals.get(m[1]);
      if (back === undefined) { res.writeHead(404); res.end("No such Portal"); return; }
      const sub = [...subs.values()].find((x) => x.customer === m[1] && ["active", "trialing", "past_due"].includes(x.status));
      const cancelling = Boolean(sub && (sub.cancel_at || sub.cancel_at_period_end));
      if (req.method === "POST" && sub) {
        if (new URLSearchParams(raw).get("do") === "renew") Object.assign(sub, { cancel_at: null, cancel_at_period_end: false, canceled_at: null });
        else if (cancelShape === "flag") Object.assign(sub, { cancel_at: null, cancel_at_period_end: true, canceled_at: null });
        else Object.assign(sub, { cancel_at: sub.items?.data?.[0]?.current_period_end ?? null, cancel_at_period_end: false, canceled_at: now() });
        await send(new URL(back).origin, "customer.subscription.updated", { id: sub.id, object: "subscription", customer: sub.customer });
        return go(res, back);
      }
      return html(res, "Your plan", `<p id="sp-state">${sub ? (cancelling ? "Cancels at the end of the period" : "Active") : "No plan"}</p>`
        + (sub ? (cancelling
          ? `<form method="post"><input type="hidden" name="do" value="renew"><button id="sp-renew" type="submit">Don't cancel subscription</button></form>`
          : `<form method="post"><input type="hidden" name="do" value="cancel"><button id="sp-cancel" type="submit">Cancel subscription</button></form>`) : "")
        + `<p><a id="sp-back" href="${esc(back)}">Back</a></p>`);
    }
    res.writeHead(404); res.end();
  }

  /** Signs a raw body as Stripe does: "t=<s>,v1=<hex of HMAC-SHA256('<t>.<raw>')>". */
  const sign = (raw, at = now(), withSecret = secret) => `t=${at},v1=${crypto.createHmac("sha256", withSecret).update(`${at}.${raw}`).digest("hex")}`;

  async function send(origin, type, object, { eventId = id("evt"), at = now(), withSecret = secret, header, livemode = false } = {}) {
    const raw = JSON.stringify({ id: eventId, object: "event", type, livemode, data: { object } });
    const res = await fetch(`${origin}/api/billing/stripe`, { method: "POST", headers: { "Content-Type": "application/json",
      ...(header === null ? {} : { "Stripe-Signature": header ?? sign(raw, at, withSecret) }) }, body: raw });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json, eventId };
  }

  const api = {
    base, calls, sign, send, prices,
    customers, sessions, subs, disputes, charges,
    sub: (sid) => subs.get(sid),
    failNext: (k) => { failing = k; },
    /** A Checkout paid: the subscription made active for a month, then checkout.session.completed sent to `origin`. */
    async pay(sessionId, origin, { interval = "month" } = {}) {
      const s = sessions.get(sessionId);
      if (!s || s.status !== "open") throw new Error(`no open session ${sessionId}`);
      const sub = { id: id("sub"), object: "subscription", customer: s.customer, status: "active", metadata: { ...s.metadata }, cancel_at_period_end: false,
        items: { data: [{ current_period_end: now() + 30 * 86400, price: { id: s.price, recurring: { interval } } }] } };
      subs.set(sub.id, sub);
      s.status = "complete"; s.subscription = sub.id;
      const sent = origin ? await send(origin, "checkout.session.completed", { id: s.id, object: "checkout.session", subscription: sub.id, customer: s.customer }) : null;
      return { sub, sent };
    },
    /** A charge of the customer's, refunded in full or in part. */
    charge(customer, { refunded = false } = {}) {
      const c = { id: id("ch"), object: "charge", customer, refunded };
      charges.set(c.id, c);
      return c;
    },
    /** A dispute on a charge, at a status (needs_response, won, lost, …). */
    dispute(charge, status) {
      const d = { id: id("du"), object: "dispute", charge: charge.id, status };
      disputes.set(d.id, d);
      return d;
    },
    close: () => new Promise((r) => server.close(r)),
  };
  return api;
}

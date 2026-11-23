// The made-up trip's people and money (seed/demo-trip.json, from tools/demo-seed.mjs), written as
// each person would write them: purchases by whoever logged them, payments by whoever paid, each
// person's packing items by that person, the group's by the host, receipts by whoever may change
// the purchase, other pictures by the host. The seed tool (tools/seed-trip.mjs) puts in the rest
// first, as the host.
//
// fillDemo(seed, { tripId, ids, as })
//   ids  { <person key>: <their user id> }   (every key in seed.people, each already on the trip)
//   as   { <person key>: send }              send(method, path, body, { raw }) -> { status, json },
//                                            as tools/cutover-send.mjs's asHost makes one
//
// A purchase's shares are worked out as the app works them out (public/js/store.js): ordered by
// user id, then allocate() from public/js/money.js seeded with the purchase's id, so the stored
// shares are the ones a phone would have sent. Throws, naming the row and the server's answer,
// on any refusal. Answers { purchases, payments, items, pictures }: how many of each went in.

import { allocate } from "../public/js/money.js";
import { scene } from "../checks/lib/images.mjs";

/** One seed purchase or payment as the route takes it, its people turned into user ids. */
export function purchaseBody(p, ids, { payment = false } = {}) {
  const who = (key) => {
    if (!ids[key]) throw new Error(`demo-fill: ${p.id} names "${key}", who isn't among the people`);
    return ids[key];
  };
  const body = {
    id: p.id, description: p.description ?? "", amount_minor: p.amount_minor, currency: p.currency, amount_exp: p.amount_exp ?? 2,
    paid_by: who(p.paid_by), spent_at: p.spent_at,
  };
  if (payment) return { ...body, kind: "payment", split_mode: "weight", shares: [{ user_id: who(p.to), weight: 1, share_minor: p.amount_minor }] };
  for (const k of ["day", "event_id", "place_id", "note"]) if (p[k] !== undefined) body[k] = p[k];
  body.split_mode = p.split_mode ?? "weight";
  const input = p.shares.map((s) => ({ user_id: who(s.person), weight: s.weight }))
    .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
  const minor = allocate(p.amount_minor, input.map((s) => s.weight), p.id);
  body.shares = input.map((s, i) => ({ ...s, share_minor: minor[i] }));
  return body;
}

export async function fillDemo(seed, { tripId, ids, as }) {
  const at = `/api/trips/${encodeURIComponent(tripId)}`;
  const host = seed.people.find((x) => x.host).key;
  const fail = (what, res) => { throw new Error(`demo-fill: ${what}: ${res.status} ${JSON.stringify(res.json).slice(0, 800)}`); };
  const sender = (key) => as[key] ?? (() => { throw new Error(`demo-fill: no sender for "${key}"`); })();
  const done = { purchases: 0, payments: 0, items: 0, pictures: 0 };

  for (const p of seed.purchases ?? []) {
    const res = await sender(p.logged_by ?? p.paid_by)("POST", `${at}/purchases`, purchaseBody(p, ids));
    if (res.status !== 201 && res.status !== 200) fail(`the purchase ${p.id}`, res);
    done.purchases += 1;
  }
  for (const p of seed.payments ?? []) {
    const res = await sender(p.paid_by)("POST", `${at}/purchases`, purchaseBody(p, ids, { payment: true }));
    if (res.status !== 201 && res.status !== 200) fail(`the payment ${p.id}`, res);
    done.payments += 1;
  }

  // Items: one batch for each person's own, and the group's from the host.
  const byOwner = new Map();
  for (const it of seed.packing_items ?? []) (byOwner.get(it.owner) ?? byOwner.set(it.owner, []).get(it.owner)).push(it);
  for (const [owner, items] of byOwner) {
    const send = sender(owner === "group" ? host : owner);
    const rows = items.map(({ owner: o, ...rest }) => (o === "group" ? { ...rest, owner: "group" } : rest));
    const res = await send("PUT", `${at}/packing/items`, { items: rows });
    if (res.status !== 200) fail(`the packing items of ${owner}`, res);
    done.items += rows.length;
  }

  // Pictures: made here, each its own colours; a receipt by whoever may change its purchase.
  let hue = 17;
  for (const pic of seed.pictures ?? []) {
    hue = (hue + 47) % 360;
    const path = pic.kind === "cover" ? `${at}/pictures/cover` : `${at}/pictures/${pic.kind}/${encodeURIComponent(pic.id)}`;
    const by = pic.kind === "purchase" ? (seed.purchases.find((p) => p.id === pic.id)?.paid_by ?? host) : host;
    const res = await sender(by)("PUT", `${path}?license=CC0`, scene(pic.kind === "purchase" ? 600 : 1200, pic.kind === "purchase" ? 800 : 800, hue), { raw: true });
    if (res.status !== 200 && res.status !== 201) fail(`the picture on ${pic.kind} ${pic.id ?? ""}`, res);
    done.pictures += 1;
  }
  return done;
}

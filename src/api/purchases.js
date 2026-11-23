// Under /api/trips/<trip>/ (the route table checks the caller is on the trip):
// GET    purchases      -> { purchases }        every purchase on the trip, oldest first
// POST   purchases      -> { purchase, rev }    201 fresh / 200 replay. Upserts on a client id.
// PATCH  purchases/:id  -> { purchase, rev }
// DELETE purchases/:id  -> { ok, deleted, rev }
//
// The :id handlers are exported as patchPurchase/deletePurchase and wired up by
// functions/api/purchases/[id].js, a shim. All the logic is here, per the ownership table in
// docs/CONTRACTS.md. That shim is NOT cosmetic: store.js's flush queue addresses every row as
// `${base}/${id}`, so without the file every offline PATCH and DELETE comes back 404, and
// store.js classifies a 4xx as a permanent refusal and DROPS the write. Four days of
// purchases flushing as nothing at all, with a console.warn. That is what happened to packing
// before functions/api/packing/[id].js existed.
//
// ── WHAT A PURCHASE IS ──────────────────────────────────────────────────────────────────
// One row saying: somebody paid this much, in this currency, for this, and these people are
// splitting it. Who owes who is COMPUTED from the set of rows on the client and is never
// stored — no balances table, no settle-up snapshot, no "marked as paid" tick.
//
// ── MONEY IS AN INTEGER COUNT OF MINOR UNITS, AND NOTHING HERE CONVERTS ─────────────────
// amount_minor + currency + amount_exp. No REAL, no decimals, no floats anywhere on this
// path. The settle-up rests on SUM(share_minor) = amount_minor holding EXACTLY, so that every
// person's net balance sums to exactly zero, so that the greedy matcher terminates at zero
// instead of at 0.0000000001. That one invariant is the only thing this file has to guarantee
// about the economics, and it is checked on every write.
//
// The server never converts anything and never touches a rate. The amount is stored AS PAID
// because that is the fact; "about $13.50" is a rendering the client works out from whatever
// rate it last managed to fetch. That trade is deliberate: a rate may drift a little, and a total
// that is generally accurate is enough.
//
// ── WHO COMPUTES share_minor: THE CLIENT. THIS FILE VALIDATES AND NEVER DERIVES. ────────
// allocate() (largest-remainder, rotated by the purchase id) lives in public/js/money.js and
// has exactly one implementation in the codebase. Reimplementing it here would be a second
// one, and two copies of a rounding rule is how a settle-up goes quietly wrong. The only
// property the algorithm depends on is the sum, and that is a two-line check.
//
// ── PERMISSION: AUTHOR **OR** PAYER ─────────────────────────────────────────────────────
// See mayTouchPurchase() below for the reasoning. It is deliberately neither the events rule
// nor the packing rule, and it is one of the three places that predicate lives.
//
// ── A PAYMENT IS A KIND OF PURCHASE ─────────────────────────────────────────────────────
// `kind` is 'purchase' or 'payment'. A payment is one person giving another money to settle
// up: the same row, queue, currency handling and balance sum, so it is a kind and not a
// table, and an app that doesn't know the word shows it as the one-sharer purchase people
// already make by hand, with the balances right. What makes a row a payment is checked on
// every write (paymentShape() below): exactly one share, for someone other than who paid, for
// the whole amount, and no day, event or place. The kind is given when the row is made and
// never changes. Whoever RECEIVED a payment may change or delete it too.

import { json, readJson } from "./json.js";
import { err, nowSec, str, validEpoch, validId } from "./trip.js";

import { REV, write } from "../trips/rev.js";
import { PURCHASE_DESCRIPTION_MAX, PURCHASE_NOTE_MAX, PURCHASES_PER_TRIP_MAX } from "../../public/js/shared/limits.js";
/** Purchases a trip may hold that no rev counted: the old site's, moved over at the cutover (25 on the one trip it had). */
const REV_SLACK = 500;
import { goneSteps, pictureShape } from "../trips/pictures.js";

// Must stay in step with shape() below and with the INSERT/UPDATE column lists. Two copies of
// a column list is exactly how events.end_tz went missing from the API while sitting
// correctly in the schema and the seed (docs/CONTRACTS.md v2 appendix 3).
const COLS =
  "id, trip_id, description, amount_minor, currency, amount_exp, paid_by, split_mode, " +
  "spent_at, day, event_id, place_id, note, kind, created_by, created_at, updated_at, rev";

const KINDS = ["purchase", "payment"];

// 'weight' -> weights are RELATIVE (all 1s is an even split, 2 is "counts double").
// 'exact'  -> weights ARE minor-unit amounts and must sum to amount_minor.
//
// It is a two-value flag governing exactly ONE thing: what happens when amount_minor is
// edited. It does not change the storage and it does not change the maths — allocate() has no
// branch for the equal case at all, because under 'exact' totalWeight === total, every floor
// is the weight itself, and the remainder is zero. Equal is the degenerate case of unequal,
// never a second kind of purchase.
const SPLIT_MODES = ["weight", "exact"];

// D1 caps a single statement at 100 bound parameters. membersOf() binds the trip id plus one
// per participant, so 32 can never approach it — the cap is a product decision (nobody splits
// a taxi 33 ways) that happens to keep the query trivially inside the database's limit.
const MAX_PARTICIPANTS = 32;

// Number.isSafeInteger is the real bound — D1 stores a 64-bit integer and JS reads it back as
// a double, so anything past 2^53 comes back WRONG rather than rejected. 1e15 is well under
// that and is already absurd: a billion dollars in a market in Cusco is a typo, and refusing
// it is kinder than storing it.
const MAX_AMOUNT_MINOR = 1e15;

// ── the minor-digit exceptions ──────────────────────────────────────────────────────────
// Minor units are not universally 1/100. This map holds ONLY the currencies whose exponent is
// not 2; anything absent from it is a 2-digit currency as far as this file is concerned.
//
// The server deliberately does NOT hold the ~170-row ISO table. That lives client-side in
// public/js/money.js, which is what the picker's "other currency" affordance opens, and
// scripts/split_math_check.mjs asserts the two agree so they cannot drift the way end_tz did.
// This map exists for exactly one job: sanity-checking a supplied amount_exp against the code
// WHEN THE CODE IS KNOWN. See readFields() for what happens when it is not, and why.
export const MINOR_UNITS = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
};

// The economic tuple. ANY patch touching one of these must carry ALL of them — see
// patchPurchase() for the reasoning, which is about store.js's queue fold and not tidiness.
const ECONOMIC = ["amount_minor", "currency", "amount_exp", "split_mode", "shares"];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// `shares` is nested on the row rather than being its own collection, and that is a deliberate
// call. A purchase is ONE fact, so it must be ONE queue op: a separate shares rowstore would
// turn one edit into 1 + n ops with no atomicity between them, and a half-flushed edit on a
// cell tower in Ollanta would leave shares that do not sum to their amount — the one invariant
// the whole design rests on.
//
// It is ALWAYS present on a read, even for a single-participant purchase, because an absent
// key is indistinguishable from "not split" and the client's netBalances() would silently skip
// the row rather than report it.
const shape = (r, shares) => ({
  id: r.id, trip_id: r.trip_id, description: r.description,
  amount_minor: r.amount_minor, currency: r.currency, amount_exp: r.amount_exp,
  paid_by: r.paid_by, split_mode: r.split_mode, spent_at: r.spent_at,
  day: r.day || "", event_id: r.event_id ?? null, place_id: r.place_id ?? null,
  note: r.note || "", kind: r.kind || "purchase", shares,
  created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at, rev: r.rev,
});

// ── permission, stated once ─────────────────────────────────────────────────────────────
// A purchase may be edited or deleted by its AUTHOR (created_by) or by its PAYER (paid_by).
// Nobody else, including admins.
//
// Not the events rule (author only): if Ada logs "Ben paid S/ 120 for the taxi" and gets the
// amount wrong, Ben has to be able to fix it — it is Ben's money, and opening that item to split
// it unequally is a thing the payer does as naturally as the author.
//
// Not the packing rule (owner === 'group' opens it to everyone): a shared ledger where any
// member can silently rewrite any line is a ledger nobody trusts, and there is no soft delete
// and no audit trail in this schema to appeal to afterwards. Two people is enough to repair
// any mistake; a participant who is neither and thinks their share is wrong asks the payer.
// That is a real limitation and it is the right one.
//
// created_by === 'seed' matches no user id, so a seeded purchase — if one ever existed — would
// be locked for everybody, which is the correct default and needs no special case.
//
// Like the packing rule, this predicate lives in THREE files that must move together:
// here, store.js's canEditPurchase(), and the split view's own canEdit().
//
// A PAYMENT adds one person: whoever received it (its one sharer). "Ben paid me back 40" is
// as much the receiver's fact as the payer's, and the receiver is the one who knows whether
// the money arrived. `shares` is the row's shares as stored; only a payment's are read.
/** A whole number of minor units as the amount a person writes: 8450 at 2 is "84.50". */
const asAmount = (minor, exp = 2) => {
  const n = String(Math.abs(minor)).padStart(exp + 1, "0");
  return `${minor < 0 ? "-" : ""}${exp ? `${n.slice(0, -exp)}.${n.slice(-exp)}` : n}`;
};
const NOT_YOURS = "Only the person who wrote this down or who paid can change it (and, for a payment, the person who received it).";

export const mayTouchPurchase = (row, user, shares = []) =>
  row.created_by === user.id || row.paid_by === user.id
  || (row.kind === "payment" && shares.some((s) => s.user_id === user.id));

/**
 * What makes a row a payment, checked against the row as it will be after the write. Returns
 * a Response to refuse with, or null. That its one share is the whole amount needs no line
 * here: every purchase's shares sum to its amount ("shares do not sum to the amount").
 */
function paymentShape({ paid_by, shares, day, event_id, place_id }) {
  if (shares.length !== 1)
    return err(400, "a payment has exactly one share: the person who received it", { got: shares.length, reason: `A payment goes from one person to one other: its one share is the person who received it, and it has ${shares.length}.` });
  if (shares[0].user_id === paid_by)
    return err(400, "a payment's share is for someone other than the person who paid", { paid_by, reason: "A payment goes to someone other than the person who paid it." });
  if (day || event_id || place_id)
    return err(400, "a payment has no day, event or place", { day: day || "", event_id: event_id ?? null, place_id: place_id ?? null, reason: "A payment isn't tied to a day, an event or a place: leave those out." });
  return null;
}

async function getPurchase(env, tripId, id) {
  return await env.DB.prepare(`SELECT ${COLS} FROM purchases WHERE id = ?1 AND trip_id = ?2`)
    .bind(id, tripId).first();
}

// Contract order: user_id ASCENDING, and it is load-bearing in two ways that are not obvious.
//
//   1. allocate()'s tie-break rotation must land on the same person on every device, so the
//      order the shares arrive in has to be the order every client sorts them into.
//   2. store.js's signature() hashes JSON.stringify(row). A shares array that came back in a
//      different order on each snapshot would hash differently every time, emitChange() would
//      fire, EVERY mounted module would re-render, and the agenda's photographs would blink —
//      v3 item 8, reached through the money screen. A stable order here is a repaint bug that
//      never happens.
async function sharesOf(env, purchaseId) {
  const rows = await env.DB.prepare(
    "SELECT user_id, weight, share_minor FROM purchase_shares WHERE purchase_id = ?1 " +
    "ORDER BY user_id").bind(purchaseId).all();
  return (rows.results || []).map((s) => ({
    user_id: s.user_id, weight: s.weight, share_minor: s.share_minor,
  }));
}

async function readPurchase(env, tripId, id) {
  const row = await getPurchase(env, tripId, id);
  if (!row) return null;
  const out = shape(row, await sharesOf(env, id));
  // Its receipt, as the snapshot carries it: a phone adopting this answer keeps the receipt it
  // shows (a payment has none).
  if (out.kind === "purchase") out.receipt = await receiptOf(env, tripId, id);
  return out;
}

/** A purchase's receipt (pictures.js's shape), or null. */
async function receiptOf(env, tripId, id) {
  const row = await env.DB.prepare("SELECT * FROM pictures WHERE trip_id = ?1 AND target_kind = 'purchase' AND target_id = ?2")
    .bind(tripId, id).first();
  return pictureShape(row);
}

/**
 * Every named participant must hold a seat at this trip. Nothing in this codebase validated a
 * list of user ids before, because nothing let a request body name other people. A purchase
 * does: it assigns a debt. There is no helper to copy, so this is the first one.
 *
 * One query, not one per id. D1 caps a single statement at 100 bound parameters and
 * MAX_PARTICIPANTS is 32, so the IN list can never approach it.
 */
async function membersOf(env, tripId, ids) {
  if (!ids.length) return new Set();
  const marks = ids.map((_, i) => `?${i + 2}`).join(", ");
  const rows = await env.DB.prepare(
    `SELECT user_id FROM trip_members WHERE trip_id = ?1 AND user_id IN (${marks})`
  ).bind(tripId, ...ids).all();
  return new Set((rows.results || []).map((r) => r.user_id));
}

// ── validation ──────────────────────────────────────────────────────────────────────────
// Shared by POST and PATCH. Returns { f, shares } or { bad } — a Response ready to return.
// `shares` is null when the body did not carry any, which in partial mode means "leave them
// alone" and in full mode cannot happen (they are required).
//
// store.js runs the same checks BEFORE enqueuing, and that is not duplicated security: this
// file is the authority. The client-side copy exists so that an impossible write never gets in
// FRONT of the queue, where a permanent 400 would be dropped a day later with the person's
// actual input already forgotten — the same reasoning setNoteColor() gives for checking the
// palette locally.
async function readFields(ctx, trip, u, b, { partial }) {
  const f = {};

  // DESCRIPTION MAY BE BLANK, and that is deliberate. The column is NOT NULL and "" satisfies
  // it. The fast path — two taps and a number — is designed to skip the
  // description entirely and fall back to the attachment name or the entry time when it
  // renders, calling an empty description "common, not an edge". The build plan lists
  // exactly what this file enforces and a non-blank description is not on it; the "never
  // blank" note lives on the SQL column and in store.js's addPurchase(), which prompts
  // "what was it?" at the keyboard where the person can still answer.
  //
  // Refusing it here would be worse than useless: store.js drops a permanent 4xx, so the
  // headline flow would lose the purchase entirely, days later, silently.
  if (!partial || has(b, "description")) f.description = str(b.description, PURCHASE_DESCRIPTION_MAX);

  if (!partial || has(b, "amount_minor")) {
    const a = b.amount_minor;
    if (!Number.isSafeInteger(a) || a <= 0)
      return { bad: err(400, "amount_minor must be a positive whole number of minor units", { got: a, reason: "An amount is more than zero." }) };
    if (a > MAX_AMOUNT_MINOR)
      return { bad: err(400, "amount_minor is implausibly large", { got: a, max: MAX_AMOUNT_MINOR, reason: "That amount is too large to be a real one." }) };
    f.amount_minor = a;
  }

  if (!partial || has(b, "currency")) {
    const c = String(b.currency == null ? "" : b.currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) return { bad: err(400, "currency must be a 3-letter ISO code", { got: b.currency, reason: `A currency is a three-letter code (PEN, USD, EUR); "${String(b.currency ?? "").slice(0, 20)}" isn't one.` }) };
    f.currency = c;
  }

  if (!partial || has(b, "amount_exp")) {
    const e = b.amount_exp === undefined ? 2 : b.amount_exp;
    if (!Number.isInteger(e) || e < 0 || e > 4)
      return { bad: err(400, "amount_exp must be an integer 0..4", { got: b.amount_exp, reason: "A currency has 0 to 4 decimal places." }) };
    f.amount_exp = e;
  }

  // Cross-check the exponent against the code, but only when the code is one this file knows
  // to be an exception. An unknown code is NOT refused for having an unusual exponent: the
  // full ISO table lives client-side, so a currency this map has never heard of may legitimately
  // have 0 or 3 digits, and blocking it would refuse a real purchase on the trail to defend a
  // display convention. The row carries its own exponent and is authoritative for its own
  // arithmetic, so a coherent-but-unconventional pairing stays exact —
  // it just renders with the wrong number of decimals.
  const cur = f.currency !== undefined ? f.currency : null;
  const exp = f.amount_exp !== undefined ? f.amount_exp : null;
  if (cur !== null && exp !== null && MINOR_UNITS[cur] !== undefined && MINOR_UNITS[cur] !== exp)
    return { bad: err(400, "amount_exp does not match the currency", { currency: cur, got: exp, expected: MINOR_UNITS[cur], reason: `${cur} has ${MINOR_UNITS[cur]} decimal places, not ${exp}.` }) };

  if (!partial || has(b, "split_mode")) {
    const m = b.split_mode === undefined ? "weight" : String(b.split_mode);
    if (!SPLIT_MODES.includes(m)) return { bad: err(400, "unknown split_mode", { modes: SPLIT_MODES, reason: "A purchase is split by weight (shares in proportion) or exact (each share an amount)." }) };
    f.split_mode = m;
  }

  // paid_by is whose money left, and it is NOT the author. Logging a purchase somebody else
  // paid for is a normal thing to do and the column exists for it. Who paid defaults to the
  // person writing it.
  if (!partial || has(b, "paid_by")) {
    const p = b.paid_by === undefined || b.paid_by === null || b.paid_by === ""
      ? u.id : String(b.paid_by);
    if (!validId(p)) return { bad: err(400, "bad paid_by", { paid_by: b.paid_by, reason: `"${String(b.paid_by).slice(0, 64)}" isn't a person's id: who paid is someone on this trip.` }) };
    f.paid_by = p;
  }

  // Epoch SECONDS on both sides, exactly like events.starts_at, so validEpoch catches a client
  // that passed Date.now() — which would land ~1000x in the future and sit at one end of the
  // feed forever, reading as "my purchase vanished" rather than as a bug.
  if (!partial || has(b, "spent_at")) {
    const s = b.spent_at === undefined ? nowSec() : b.spent_at;
    if (!validEpoch(s)) return { bad: err(400, "spent_at must be epoch seconds", { got: b.spent_at, reason: "When it was spent is a day, or a day and time." }) };
    f.spent_at = s;
  }

  // ── the attachment: three optional, independent, none required ────────────────────────
  // A purchase may go with a day, an event or a place, or float. A floating purchase is "" and
  // two NULLs, and it is fully legal.
  if (!partial || has(b, "day")) {
    const d = str(b.day, 10);
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d))
      return { bad: err(400, "day must be an ISO date (YYYY-MM-DD)", { got: b.day, reason: `A day is written YYYY-MM-DD; "${String(b.day).slice(0, 20)}" isn't one.` }) };
    f.day = d;
  }

  // Both foreign keys are checked here rather than left to D1, for the reason events.js gives
  // about place_id: a constraint violation throws out of the handler as a raw Pages 500 with a
  // D1 stack trace (there is no global error handler in this codebase), and the caller gets
  // nothing it can act on. Checked, it gets back the id it got wrong.
  //
  // The event check is trip-scoped and the place check is not, and that asymmetry is real:
  // events.trip_id is NOT NULL, while places.trip_id is nullable — places is the one table
  // that is allowed to hold rows belonging to no trip.
  if (!partial || has(b, "event_id")) {
    const id = b.event_id ? String(b.event_id) : null;
    if (id) {
      if (!validId(id)) return { bad: err(400, "bad event_id", { event_id: b.event_id, reason: `"${String(b.event_id).slice(0, 64)}" isn't an event's id.` }) };
      const hit = await ctx.env.DB.prepare("SELECT 1 AS ok FROM events WHERE id = ?1 AND trip_id = ?2")
        .bind(id, trip.id).first();
      if (!hit) return { bad: err(400, "unknown event_id", { event_id: id, reason: `There's no event "${id}" on this trip.` }) };
    }
    f.event_id = id;
  }

  if (!partial || has(b, "place_id")) {
    const id = b.place_id ? String(b.place_id) : null;
    if (id) {
      if (!validId(id)) return { bad: err(400, "bad place_id", { place_id: b.place_id, reason: `"${String(b.place_id).slice(0, 64)}" isn't a place's id.` }) };
      const hit = await ctx.env.DB.prepare("SELECT 1 AS ok FROM places WHERE id = ?1 AND trip_id = ?2")
        .bind(id, trip.id).first();
      if (!hit) return { bad: err(400, "unknown place_id", { place_id: id, reason: `No place on this trip has the id "${id}".` }) };
    }
    f.place_id = id;
  }

  if (!partial || has(b, "note")) f.note = str(b.note, PURCHASE_NOTE_MAX);

  // ── shares, and the one invariant ─────────────────────────────────────────────────────
  let shares = null;
  if (!partial || has(b, "shares")) {
    const raw = b.shares;
    if (!Array.isArray(raw) || !raw.length)
      return { bad: err(400, "shares must be a non-empty array", { got: raw === undefined ? null : raw, reason: "A purchase is split between one person or more." }) };
    if (raw.length > MAX_PARTICIPANTS)
      return { bad: err(400, "too many participants", { got: raw.length, max: MAX_PARTICIPANTS, reason: `A purchase is split between at most ${MAX_PARTICIPANTS} people; this one names ${raw.length}.` }) };

    const seen = new Set();
    const out = [];
    for (const s of raw) {
      const uid = s && s.user_id != null ? String(s.user_id) : "";
      if (!validId(uid)) return { bad: err(400, "bad share user_id", { user_id: s && s.user_id, reason: `"${String(s?.user_id ?? "").slice(0, 64)}" isn't a person's id: each share is for someone on this trip.` }) };
      if (seen.has(uid)) return { bad: err(400, "duplicate person in shares", { user_id: uid, reason: `${uid} is in the split twice: name each person once.` }) };
      seen.add(uid);
      const w = s.weight, m = s.share_minor;
      if (!Number.isSafeInteger(w) || w < 0)
        return { bad: err(400, "share weight must be a non-negative whole number", { user_id: uid, weight: w, reason: `${uid}'s share of the split is a whole number, zero or more.` }) };
      if (!Number.isSafeInteger(m) || m < 0)
        return { bad: err(400, "share_minor must be a non-negative whole number", { user_id: uid, share_minor: m, reason: `${uid}'s share is an amount, zero or more.` }) };
      out.push({ user_id: uid, weight: w, share_minor: m });
    }

    // Contract order (§4.2). Sorted ON THE WAY IN, once, so every read of this row — the
    // snapshot, a write's echo, a replay — hands the client the same array in the same order.
    out.sort((a, c) => (a.user_id < c.user_id ? -1 : a.user_id > c.user_id ? 1 : 0));

    const sumW = out.reduce((a, s) => a + s.weight, 0);
    if (sumW <= 0) return { bad: err(400, "the weights are all zero", { sum_weight: sumW, reason: "Someone in the split has a share above zero." }) };

    // THE INVARIANT. Everything the settle-up does rests on this and only this: the shares sum
    // to the amount exactly, so the net balances sum to exactly zero, so the fewest-transfers
    // matcher terminates with everybody at zero rather than at a fraction of a céntimo. A
    // purchase whose shares do not sum cannot be stored.
    const sumM = out.reduce((a, s) => a + s.share_minor, 0);
    if (sumM !== f.amount_minor)
      return { bad: err(400, "shares do not sum to the amount", {
        amount_minor: f.amount_minor, sum_share_minor: sumM, difference: f.amount_minor - sumM,
        reason: `The shares add up to ${asAmount(sumM, f.amount_exp)}, and the amount is ${asAmount(f.amount_minor, f.amount_exp)}: they must be the same.` }) };

    // Under 'exact' the weights ARE minor amounts, so they carry the same obligation. This is
    // what makes allocate() return them verbatim (every floor is the weight, the remainder is
    // zero) and it is why "Ada 40, Ben 10" needs no second code path.
    if (f.split_mode === "exact" && sumW !== f.amount_minor)
      return { bad: err(400, "exact weights must sum to the amount", {
        amount_minor: f.amount_minor, sum_weight: sumW,
        reason: `Split exactly, the shares add up to ${asAmount(sumW, f.amount_exp)}, and the amount is ${asAmount(f.amount_minor, f.amount_exp)}: they must be the same.` }) };

    shares = out;
  }

  // One membership query for the payer AND every participant. "Is this id a member of this
  // trip" stops being a formality the moment a request body can assign a debt to somebody.
  const named = new Set();
  if (f.paid_by !== undefined) named.add(f.paid_by);
  if (shares) for (const s of shares) named.add(s.user_id);
  if (named.size) {
    const ids = [...named];
    const seated = await membersOf(ctx.env, trip.id, ids);
    const strangers = ids.filter((id) => !seated.has(id));
    if (strangers.length)
      return { bad: err(400, "not everybody named is on this trip", { user_ids: strangers, reason: `Not on this trip: ${strangers.join(", ")}. Everyone who pays or shares is someone on the trip.` }) };
  }

  return { f, shares };
}

// One INSERT per share, upserting on the composite primary key. The PK is what makes a
// replayed offline write idempotent BY CONSTRUCTION — re-inserting the same (purchase, person)
// cannot produce a second share — and the DO UPDATE is what lets the same statement serve a
// fresh create and a re-sent edit without a branch.
// Takes the D1 handle itself (ctx.env.DB), not env, so the statements it builds go into the
// same batch its caller is assembling.
/** The kind a body asks for: { kind } or { bad }. Absent means 'purchase'. */
function readKind(b) {
  const kind = b.kind === undefined || b.kind === null ? "purchase" : String(b.kind);
  return KINDS.includes(kind) ? { kind } : { bad: err(400, "unknown kind", { kinds: KINDS, got: b.kind, reason: "A row of Split is a purchase or a payment." }) };
}

const shareStmts = (D, purchaseId, shares) => shares.map((s) => D.prepare(
  "INSERT INTO purchase_shares (purchase_id, user_id, weight, share_minor) VALUES (?1, ?2, ?3, ?4) " +
  "ON CONFLICT(purchase_id, user_id) DO UPDATE SET weight = excluded.weight, share_minor = excluded.share_minor"
).bind(purchaseId, s.user_id, s.weight, s.share_minor));

// ── readers ─────────────────────────────────────────────────────────────────────────────

/**
 * Exported so GET /api/trip can build the single snapshot store.js hydrates from without a
 * second copy of these two SELECTs.
 *
 * Unlike listPacking(), this takes no user and is NOT scoped to what one session may read.
 * Every trip member sees every purchase: the whole feature is a shared ledger, and a settle-up
 * computed from a subset of the rows would be silently and confidently wrong.
 *
 * Two queries, not one per purchase. The shares reach the trip by joining their parent — the
 * child table carries no trip_id on purpose — and they come back ordered so the grouping below
 * needs no sort of its own.
 *
 * The snapshot key must ALWAYS be present, even as []. applySnapshot() treats an absent
 * collection as "unchanged", not "empty" (store.js:300), so omitting it on a trip with no
 * purchases would make a locally-deleted purchase immortal.
 */
// since (a rev) answers only the rows written after it, and those named in also (ids, as for a picture changed):
// GET /api/trips/<id>?since= (src/api/trip.js, migration 0036's indexes).
// A purchase answered always brings all its shares: they're written only with it (its rev moves).
export async function listPurchases(env, tripId, { since = null, also = [] } = {}) {
  // Since: the ids that changed off the (trip, rev) index (and those named), then each by its key ("+" keeps the
  // trip a filter, not the index the planner would otherwise read whole).
  const changed = "(SELECT id FROM purchases WHERE trip_id = ?1 AND rev > ?2 UNION SELECT value FROM json_each(?3))";
  const [rows, shares] = since === null
    ? await Promise.all([
      env.DB.prepare(`SELECT ${COLS} FROM purchases WHERE trip_id = ?1 ORDER BY spent_at, id`).bind(tripId).all(),
      env.DB.prepare(
        "SELECT s.purchase_id, s.user_id, s.weight, s.share_minor FROM purchase_shares s " +
        "JOIN purchases p ON p.id = s.purchase_id WHERE p.trip_id = ?1 " +
        "ORDER BY s.purchase_id, s.user_id").bind(tripId).all(),
    ])
    : await Promise.all([
      env.DB.prepare(`SELECT ${COLS} FROM purchases WHERE +trip_id = ?1 AND id IN ${changed} ORDER BY spent_at, id`).bind(tripId, since, JSON.stringify(also)).all(),
      env.DB.prepare(
        "SELECT s.purchase_id, s.user_id, s.weight, s.share_minor FROM purchase_shares s " +
        `JOIN purchases p ON p.id = s.purchase_id AND +p.trip_id = ?1 WHERE s.purchase_id IN ${changed} ` +
        "ORDER BY s.purchase_id, s.user_id").bind(tripId, since, JSON.stringify(also)).all(),
    ]);

  const by = new Map();
  for (const s of shares.results || []) {
    if (!by.has(s.purchase_id)) by.set(s.purchase_id, []);
    by.get(s.purchase_id).push({ user_id: s.user_id, weight: s.weight, share_minor: s.share_minor });
  }
  return (rows.results || []).map((r) => shape(r, by.get(r.id) || []));
}

// Nothing in the app calls this route (store.js reads purchases off the snapshot); it is here
// for whoever wants the purchases alone.
export async function onRequestGet(ctx) {
  const tripId = ctx.data.trip.id;
  const [list, pics] = await Promise.all([
    listPurchases(ctx.env, tripId),
    ctx.env.DB.prepare("SELECT * FROM pictures WHERE trip_id = ?1 AND target_kind = 'purchase'").bind(tripId).all(),
  ]);
  const receipts = new Map((pics.results || []).map((r) => [r.target_id, r]));
  for (const p of list) if (p.kind === "purchase") p.receipt = pictureShape(receipts.get(p.id) ?? null);
  return json({ purchases: list });
}

/**
 * POST is an UPSERT on the client-minted id, and its middle branch is deliberately stronger
 * than the ON CONFLICT DO NOTHING that events.js and packing.js use.
 *
 * The reason is the queue fold. enqueue() merges a later update into a pending create while
 * KEEPING prev.op = "create" (store.js:502-508), so a POST body can legitimately carry
 * post-creation edits. If the original POST actually landed but its response was lost — a
 * market in Cusco, one bar of signal, the exact case this app exists for — DO NOTHING would
 * discard those edits and answer 200. The write would appear to succeed and the amount would
 * be wrong, which is the one failure mode this whole design exists to prevent.
 *
 *   absent            -> INSERT purchase + INSERT every share   -> 201
 *   present, mayTouch -> UPDATE + rewrite the shares            -> 200
 *   present, not ours -> 409, and nothing is written
 */
export async function onRequestPost(ctx) {
  const g = { u: ctx.data.user, trip: ctx.data.trip };
  const { u, trip } = g;

  const b = await readJson(ctx.request);

  // The client may name the row, and that is what makes a queued offline write safe to replay.
  // An event created in a market needs a real id the moment it exists so it can be edited and
  // deleted before it has ever been sent, and a POST that minted its own id server-side would
  // create a second purchase on every retry.
  const id = b.id === undefined ? crypto.randomUUID() : String(b.id);
  if (!validId(id)) return err(400, "bad id", { id });

  const k = readKind(b);
  if (k.bad) return k.bad;
  const v = await readFields(ctx, trip, u, b, { partial: false });
  if (v.bad) return v.bad;
  const { f, shares } = v;
  if (k.kind === "payment") {
    const bad = paymentShape({ ...f, shares });
    if (bad) return bad;
  }

  const existing = await getPurchase(ctx.env, trip.id, id);
  const ts = nowSec();
  const D = ctx.env.DB;
  // At most PURCHASES_PER_TRIP_MAX purchases and payments a trip; one sent again (a replay) isn't a new one.
  // Counted only once the trip could hold that many: every purchase this route adds takes the trip a rev further (and so
  // does an undo that puts one back), so a trip whose rev is under the cap, less REV_SLACK for the purchases the cutover
  // brought over without one, can't be at it. Counting every time read every purchase of the trip on every purchase
  // (451 rows on a big trip, 5,000 at the cap).
  if (!existing && (trip.rev ?? 0) >= PURCHASES_PER_TRIP_MAX - REV_SLACK) {
    const held = await D.prepare("SELECT COUNT(*) AS n FROM purchases WHERE trip_id = ?1").bind(trip.id).first();
    if ((held?.n ?? 0) >= PURCHASES_PER_TRIP_MAX) {
      return err(409, "too many purchases", { max: PURCHASES_PER_TRIP_MAX, reason: `A trip holds ${PURCHASES_PER_TRIP_MAX.toLocaleString("en-US")} purchases and payments. Delete some old ones first.` });
    }
  }

  if (existing) {
    // Somebody else's id — including 'seed' — is a genuine collision, and adopting it would be
    // a silent permission bypass.
    if (!mayTouchPurchase(existing, u, existing.kind === "payment" ? await sharesOf(ctx.env, id) : []))
      return err(409, "id already exists", { id, reason: `"${id}" is already a purchase someone else wrote down: choose another id.` });
    // The kind is fixed when the row is made. A replay carries the same one.
    if (k.kind !== existing.kind)
      return err(400, "a purchase's kind can't be changed", { kind: existing.kind, got: k.kind, reason: `${id} is a ${existing.kind}, and stays one; a ${k.kind} needs another id.` });

    // The shares are DELETEd and re-INSERTed rather than merged: the body carries the complete
    // set, and a merge would leave a participant who was removed in this edit still owing
    // money.
    //
    // THE PERMISSION TERM IS NOT RESTATED IN THIS UPDATE'S WHERE, and that is the opposite of
    // what events.js does. It is deliberate, and the reason is the children. events.js guards
    // its UPDATE because it is a single statement with nothing hanging off it; here the amount
    // and the shares MUST move together or the sum invariant breaks. A guard on the parent that
    // the child statements cannot carry identically would, on the race it exists to stop, skip
    // the UPDATE and still rewrite the shares — leaving a row whose shares no longer sum, which
    // is worse than the race. And the guard cannot be carried identically: this statement may
    // legitimately MOVE paid_by, so a permission term on the children would be evaluated
    // against a row this batch is in the middle of changing.
    //
    // So the gate is the SELECT plus mayTouchPurchase() above, and the batch is one implicit
    // transaction that applies whole — which is exactly packing.js's cascade precedent.
    const { rev } = await write(ctx.env, trip.id, [
      D.prepare(
        "UPDATE purchases SET description = ?1, amount_minor = ?2, currency = ?3, amount_exp = ?4, " +
        "paid_by = ?5, split_mode = ?6, spent_at = ?7, day = ?8, event_id = ?9, place_id = ?10, " +
        `note = ?11, updated_at = ?12, rev = ${REV(14)} WHERE id = ?13 AND trip_id = ?14`
      ).bind(f.description, f.amount_minor, f.currency, f.amount_exp, f.paid_by, f.split_mode,
        f.spent_at, f.day, f.event_id, f.place_id, f.note, ts, id, trip.id),
      D.prepare("DELETE FROM purchase_shares WHERE purchase_id = ?1").bind(id),
      ...shareStmts(D, id, shares),
    ]);
    return json({ purchase: await readPurchase(ctx.env, trip.id, id), rev });
  }

  // An id is one row on the whole site, so one that another trip holds can't be made here.
  // Said as the collision it is, before the insert: the insert would fail as a raw 500, which
  // the app's queue reads as "try again" forever.
  if (await D.prepare("SELECT 1 AS ok FROM purchases WHERE id = ?1").bind(id).first())
    return err(409, "id already exists", { id, reason: `"${id}" is already taken by a purchase elsewhere: choose another id.` });

  // Parent first, then the children. D1 enforces foreign keys and a violation throws as a raw
  // Pages 500; one env.DB.batch() is one implicit transaction, so either the whole purchase
  // exists or none of it does — there is no reachable state where a purchase has no shares.
  const { rev } = await write(ctx.env, trip.id, [
    D.prepare(
      "INSERT INTO purchases (id, trip_id, description, amount_minor, currency, amount_exp, " +
      "paid_by, split_mode, spent_at, day, event_id, place_id, note, kind, created_by, created_at, " +
      `updated_at, rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16, ${REV(2)})`
    ).bind(id, trip.id, f.description, f.amount_minor, f.currency, f.amount_exp, f.paid_by,
      f.split_mode, f.spent_at, f.day, f.event_id, f.place_id, f.note, k.kind, u.id, ts),
    ...shareStmts(D, id, shares),
  ]);
  return json({ purchase: await readPurchase(ctx.env, trip.id, id), rev }, 201);
}

// ctx.params.id is canonical — that is what store.js's flush queue sends (PATCH
// /api/purchases/<id>). A body id still works for a hand-written call; a mismatch between the
// two is a client bug worth naming rather than guessing about. Same shape as packing.js.
function idFrom(ctx, body) {
  const inPath = ctx.params && ctx.params.id ? String(ctx.params.id) : "";
  const inBody = body && body.id != null ? String(body.id) : "";
  if (inPath && inBody && inPath !== inBody) return { bad: err(400, "id in path and body disagree") };
  return { id: inPath || inBody };
}

export async function patchPurchase(ctx) {
  const g = { u: ctx.data.user, trip: ctx.data.trip };
  const { u, trip } = g;

  const b = await readJson(ctx.request);
  const r = idFrom(ctx, b);
  if (r.bad) return r.bad;
  const id = r.id;
  if (!id) return err(400, "id required");

  const row = await getPurchase(ctx.env, trip.id, id);
  if (!row) return err(404, "no such purchase", { id, reason: `There's no purchase or payment "${id.slice(0, 64)}" on this trip.` });
  const stored = row.kind === "payment" ? await sharesOf(ctx.env, id) : [];
  if (!mayTouchPurchase(row, u, stored))
    return err(403, "forbidden", { reason: NOT_YOURS, created_by: row.created_by, paid_by: row.paid_by });
  // The kind is fixed when the row is made. Naming the one it has is allowed and changes nothing.
  if (has(b, "kind") && String(b.kind) !== row.kind)
    return err(400, "a purchase's kind can't be changed", { kind: row.kind, got: b.kind, reason: `${id} is a ${row.kind}, and stays one.` });

  // ── ALL FIVE OR NONE ──────────────────────────────────────────────────────────────────
  // This is not tidiness, it is the queue. store.js's fold is a SHALLOW merge
  // ({ ...prev.payload, ...op.payload }, store.js:505) and so is replayQueue()'s update branch
  // (store.js:326), so an array field is replaced WHOLESALE by whichever patch lands last. An
  // incremental "just change Maya's share" patch silently discards everybody else's the moment
  // two edits fold — which offline is most of the time. Send the whole economic tuple or none
  // of it, and the fold cannot be wrong.
  //
  // Refusing it here, by name, beats storing a row whose shares no longer sum: it is a client
  // bug when it happens, and a 400 that says which fields are missing is something a developer
  // can fix in one read.
  const touched = ECONOMIC.filter((k) => has(b, k));
  if (touched.length && touched.length !== ECONOMIC.length)
    return err(400, "economic fields must be patched together", { required: ECONOMIC, got: touched, reason: `The amount and its split change together: send ${ECONOMIC.join(", ")}, all of them.` });

  // description, note, day, event_id, place_id, spent_at and paid_by are freely patchable on
  // their own. paid_by moves money between people but touches no sum, so it needs no companion.
  const v = await readFields(ctx, trip, u, b, { partial: true });
  if (v.bad) return v.bad;
  const { f, shares } = v;

  // A payment must still be one after the patch: the row as it will be, not only what changed.
  if (row.kind === "payment") {
    const after = { ...row, ...f };
    const bad = paymentShape({ ...after, shares: shares || stored });
    if (bad) return bad;
  }

  const keys = Object.keys(f);
  if (!keys.length && !shares) return json({ purchase: await readPurchase(ctx.env, trip.id, id), rev: trip.rev });

  const D = ctx.env.DB;
  const stmts = [];
  // No permission term in this WHERE either — the gate is the SELECT plus mayTouchPurchase()
  // above, and the reasoning is written out at the same statement in onRequestPost(): the
  // parent and its shares have to move together or the sum invariant breaks, and a guard the
  // child statements cannot carry identically is worse than no guard at all.
  if (keys.length) {
    const sets = keys.map((k, i) => `${k} = ?${i + 1}`).join(", ");
    const n = keys.length;
    stmts.push(D.prepare(
      `UPDATE purchases SET ${sets}, updated_at = ?${n + 1}, rev = ${REV(n + 3)} WHERE id = ?${n + 2} AND trip_id = ?${n + 3}`
    ).bind(...keys.map((k) => f[k]), nowSec(), id, trip.id));
  } else {
    // Only the shares changed: the row was still written.
    stmts.push(D.prepare(`UPDATE purchases SET updated_at = ?1, rev = ${REV(3)} WHERE id = ?2 AND trip_id = ?3`)
      .bind(nowSec(), id, trip.id));
  }
  // Children after the parent update, and the whole set is rewritten rather than merged — see
  // the same note in onRequestPost. One batch is one transaction, so the row is never briefly
  // holding a set of shares that does not sum to its amount.
  if (shares) {
    stmts.push(D.prepare("DELETE FROM purchase_shares WHERE purchase_id = ?1").bind(id));
    stmts.push(...shareStmts(D, id, shares));
  }
  const { rev } = await write(ctx.env, trip.id, stmts);

  // Read back rather than echo the request. A partial patch that echoed would replace the
  // client's optimistic row with one missing every field it did not touch — the reason
  // PATCH /api/me reads back too.
  return json({ purchase: await readPurchase(ctx.env, trip.id, id), rev });
}

export async function deletePurchase(ctx) {
  const g = { u: ctx.data.user, trip: ctx.data.trip };
  const { u, trip } = g;

  const id = String((ctx.params && ctx.params.id) || "");
  if (!id) return err(400, "id required");

  const row = await getPurchase(ctx.env, trip.id, id);

  // ALREADY GONE IS SUCCESS, AT 200, NEVER 404. A delete queued on the trail reaches the
  // server twice whenever a response is lost, and store.js treats a 4xx as a PERMANENT refusal
  // — a 404 at the head of the flush queue wedges everything behind it, so four days of
  // offline writes flush as nothing at all, silently.
  //
  // And the body carries NO `id`. unwrap() (store.js:534) treats any response object with an
  // id as "the server's version of the row" and PUTs it straight back into IndexedDB,
  // resurrecting the purchase that was just deleted as a garbage object with none of a
  // purchase's fields.
  if (!row) return json({ ok: true, deleted: false, rev: trip.rev });
  if (!mayTouchPurchase(row, u, row.kind === "payment" ? await sharesOf(ctx.env, id) : []))
    return err(403, "forbidden", { reason: NOT_YOURS, created_by: row.created_by, paid_by: row.paid_by });

  // Children first. purchase_shares deliberately has no ON DELETE CASCADE — every delete in
  // this codebase cascades by hand in one batch, so the cascade is visible where it happens —
  // and D1 enforces the foreign key, so the other order is a raw 500.
  //
  // The gate is the SELECT plus mayTouchPurchase() above, as on the two UPDATE paths, and the
  // statements carry the trip only. The permission can't be restated on both: a payment's
  // receiver is allowed because of a share, and the first statement removes that share before
  // the second could read it. Either the whole purchase goes or none of it does: the parent's
  // delete stands on its shares being gone, which only this batch does.
  const { rev } = await write(ctx.env, trip.id, [
    // Its receipt goes with it (the file to the drain).
    ...goneSteps(ctx.env, trip.id, "purchase", JSON.stringify([id]), nowSec()),
    ctx.env.DB.prepare(
      "DELETE FROM purchase_shares WHERE purchase_id = ?1 AND EXISTS (" +
      "SELECT 1 FROM purchases p WHERE p.id = ?1 AND p.trip_id = ?2)"
    ).bind(id, trip.id),
    ctx.env.DB.prepare(
      "DELETE FROM purchases WHERE id = ?1 AND trip_id = ?2 " +
      "AND NOT EXISTS (SELECT 1 FROM purchase_shares s WHERE s.purchase_id = ?1)"
    ).bind(id, trip.id),
  ]);
  return json({ ok: true, deleted: true, rev });
}

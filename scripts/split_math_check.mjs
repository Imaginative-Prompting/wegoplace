#!/usr/bin/env node
// split_math_check.mjs — the gate on the money maths. Plain node, no browser, no server.
//
// What this file is for:
// "A gate, not a formality. It runs in under two seconds and it is the only thing standing
// between a rounding change and a settle-up that is quietly wrong."
//
// It imports public/js/money.js DIRECTLY — the real module the phone runs, not a copy —
// which is the whole reason §9 requires that file to stay free of the DOM, of store.js and
// of every view module. If this script ever needs a shim to load it, that constraint has
// been broken and the test has stopped testing the shipping code.
//
// Four blocks, in the order the spec argues them:
//
//   1. allocate() against §4.2 and §5.5's literals — including fnv1a32("pu_dinner_1") % 3,
//      which is the number that decides who eats the odd céntimo and is quoted in the spec.
//   2. The worked settle-ups of §5.4, §5.5, §5.6 and §6.6, transfer by transfer, against
//      the numbers the spec prints. §6.6 is run twice, at PEN 3.75 and at 3.80, because the
//      "rates move between viewings" consequence is ACCEPTED and therefore has to be
//      demonstrated rather than discovered.
//   3. The 20,000-trip property suite of §5.7.
//   4. The client ISO table against src/api/purchases.js's MINOR_UNITS. That check is
//      the mechanism `end_tz` never had: two tables in two files that must agree, with
//      something that fails when they do not.
//
//     node scripts/split_math_check.mjs

import {
  fnv1a32, allocate, convert, netBalances, settle, isPayment,
  expOf, fmtMoney, parseAmount, toAmountText, restate, isEqualSplit, equalShares,
  CURRENCY_CODES, nameOf, symbolOf, currencyLabel,
} from "../public/js/money.js";
import { MINOR_UNITS } from "../src/api/purchases.js";

let pass = 0;
const fails = [];

function ok(cond, label, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}${detail ? `   — ${detail}` : ""}`); return true; }
  fails.push(label);
  console.log(`  FAIL  ${label}${detail ? `   — ${detail}` : ""}`);
  return false;
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label,
  JSON.stringify(a) === JSON.stringify(b) ? JSON.stringify(a) : `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// ── 1. allocate ─────────────────────────────────────────────────────────────────────────
console.log("\n1. allocate(): shares and remainders, against worked examples");

eq(allocate(5000, [4000, 1000], "x"), [4000, 1000],
   "an 'exact' split comes back verbatim — totalWeight === total, so every floor is the weight");
eq(allocate(1000, [1, 1, 1], "pu_dinner_1"), [333, 334, 333],
   "the three-way split of S/ 10.00 puts the odd céntimo on index 1");
ok(fnv1a32("pu_dinner_1") % 3 === 1, "fnv1a32('pu_dinner_1') % 3 === 1 — the rotation the spec quotes",
   `${fnv1a32("pu_dinner_1") % 3}`);
eq(allocate(30000, [1, 1], "pu_hotel"), [15000, 15000], "§5.6's two-way hotel split");
eq(allocate(0, [1, 1, 1], "z"), [0, 0, 0], "a zero total allocates to zeros, not to NaN");
eq(allocate(100, [], "z"), [], "no participants, no shares, no throw");
ok((() => { try { allocate(100, [0, 0], "z"); return false; } catch { return true; } })(),
   "all-zero weights throw rather than dividing by zero");
// The BigInt path, which is the reason allocate() is not written in Numbers: an 'exact'
// split makes the product the amount SQUARED.
{
  const big = allocate(1e9, [6e8, 4e8], "big");
  ok(big[0] + big[1] === 1e9 && big[0] === 6e8, "a 1e9-minor 'exact' split is exact (the BigInt path)",
     big.join(" + "));
}

// ── 2. the worked settle-ups ────────────────────────────────────────────────────────────
const P = (id, amount, currency, exp, paid_by, shares, mode = "weight") => ({
  id, amount_minor: amount, currency, amount_exp: exp, paid_by, split_mode: mode,
  shares: shares.slice().sort((a, b) => (a.user_id < b.user_id ? -1 : 1)),
});
const even = (ids, total, id) => {
  const sorted = ids.slice().sort();
  const r = equalShares(total, sorted.length, id);
  return sorted.map((u, i) => ({ user_id: u, weight: 1, share_minor: r[i] }));
};
const nets = (list, ids, to, exp, rates) => netBalances(list, ids, { to, toExp: exp, rates });
const asObj = (m) => Object.fromEntries([...m.entries()].sort());

console.log("\n2. the worked examples — §5.4, §5.5, §5.6, §6.6");

{
  // §5.4 — four people, USD, the "biggest spender is a debtor" case.
  const all = ["u_ben", "u_dev", "u_cleo", "u_ada"];
  const list = [
    P("pu_hotel", 30000, "USD", 2, "u_ben", even(["u_ben", "u_dev"], 30000, "pu_hotel")),
    P("pu_dinner", 20000, "USD", 2, "u_dev", even(all, 20000, "pu_dinner")),
    P("pu_taxi", 10000, "USD", 2, "u_cleo", even(all, 10000, "pu_taxi")),
  ];
  const { net } = nets(list, all, "USD", 2, {});
  eq(asObj(net), { u_ada: -7500, u_ben: 7500, u_cleo: 2500, u_dev: -2500 },
     "§5.4 nets — Dev spent the second most in the group and OWES money");
  eq(settle(net), [
    { from: "u_ada", to: "u_ben", amount_minor: 7500 },
    { from: "u_dev", to: "u_cleo", amount_minor: 2500 },
  ], "§5.4 transfers — two, both found by pass 1 (exact opposite pairs)");
}

{
  // §5.5 — the S/ 10.00 three-way, where the rotation decides.
  const all = ["u_ben", "u_ada", "u_cleo", "u_dev"];
  const list = [P("pu_dinner_1", 1000, "PEN", 2, "u_ben",
                  even(["u_ben", "u_ada", "u_cleo"], 1000, "pu_dinner_1"))];
  eq(list[0].shares.map((s) => `${s.user_id}:${s.share_minor}`),
     ["u_ada:333", "u_ben:334", "u_cleo:333"], "§5.5 shares — the extra céntimo lands on Ben");
  const { net } = nets(list, all, "PEN", 2, {});
  eq(asObj(net), { u_ada: -333, u_ben: 666, u_cleo: -333, u_dev: 0 },
     "§5.5 nets, summing to zero, with a fourth person at exactly 0");
  eq(settle(net), [
    { from: "u_ada", to: "u_ben", amount_minor: 333 },
    { from: "u_cleo", to: "u_ben", amount_minor: 333 },
  ], "§5.5 transfers — pass 1 finds nothing, pass 2 does it in two");
}

{
  // §5.6 — split with only one other person, and its unequal twin.
  const two = ["u_ben", "u_dev"];
  const hotel = [P("pu_hotel", 30000, "USD", 2, "u_ben", even(two, 30000, "pu_hotel"))];
  const { net: n1 } = nets(hotel, two, "USD", 2, {});
  eq(settle(n1), [{ from: "u_dev", to: "u_ben", amount_minor: 15000 }],
     "§5.6 — Ben spent $300 and is owed $150");

  const ue = [P("pu_taxi_ue", 5000, "USD", 2, "u_ben", [
    { user_id: "u_ada", weight: 1000, share_minor: 1000 },
    { user_id: "u_ben", weight: 4000, share_minor: 4000 },
  ], "exact")];
  const { net: n2 } = nets(ue, ["u_ben", "u_ada"], "USD", 2, {});
  eq(settle(n2), [{ from: "u_ada", to: "u_ben", amount_minor: 1000 }],
     "§5.6 unequal — Ben carried $40 of a $50 taxi and is owed $10");
  ok(!isEqualSplit(ue[0]), "isEqualSplit() says no to 4000/1000");
  ok(isEqualSplit(hotel[0]), "isEqualSplit() says yes to a two-way even split");
  ok(isEqualSplit({ shares: [{ user_id: "a", weight: 1, share_minor: 334 },
                             { user_id: "b", weight: 1, share_minor: 333 },
                             { user_id: "c", weight: 1, share_minor: 333 }] }),
     "isEqualSplit() says YES to 334/333/333 — equal weights, unequal cents (the feed's marker)");
}

{
  // §6.6 — multi-currency, and the same trip a day later at a moved rate.
  const all = ["u_ben", "u_dev", "u_cleo", "u_ada"];
  const list = [
    P("pu_hotel", 30000, "USD", 2, "u_ben", even(["u_ben", "u_dev"], 30000, "pu_hotel")),
    P("pu_dinner", 75000, "PEN", 2, "u_dev", even(all, 75000, "pu_dinner")),
    P("pu_taxi", 9000, "PEN", 2, "u_cleo", even(all, 9000, "pu_taxi")),
  ];
  eq(list[1].shares.map((s) => s.share_minor), [18750, 18750, 18750, 18750],
     "§6.6 — dinner's stored shares are in PEN, the currency it was paid in");

  const a = nets(list, all, "USD", 2, { PEN: 3.75 });
  eq(asObj(a.net), { u_ada: -5600, u_ben: 9400, u_cleo: -3200, u_dev: -600 },
     "§6.6 at PEN 3.75 — Dev paid the equivalent of $200 and owes $6");
  eq(settle(a.net), [
    { from: "u_ada", to: "u_ben", amount_minor: 5600 },
    { from: "u_cleo", to: "u_ben", amount_minor: 3200 },
    { from: "u_dev", to: "u_ben", amount_minor: 600 },
  ], "§6.6 transfers — Ben is the only creditor and pays nobody");
  ok(a.paid.get("u_ben") === 30000 && a.owed.get("u_ben") === 20600,
     "the paid/share sub-line block 1 prints is paid − share = net",
     `${a.paid.get("u_ben")} - ${a.owed.get("u_ben")} = ${a.net.get("u_ben")}`);
  ok(a.total === 30000 + 20000 + 2400, "the group total is every purchase converted once", `${a.total}`);

  const b = nets(list, all, "USD", 2, { PEN: 3.80 });
  eq(asObj(b.net), { u_ada: -5526, u_ben: 9474, u_cleo: -3158, u_dev: -790 },
     "§6.6 at PEN 3.80 — the ACCEPTED consequence, in numbers: Ben moves +$94.00 -> +$94.74");
  ok([...b.net.values()].reduce((x, y) => x + y, 0) === 0,
     "…and it still sums to exactly zero, which is what makes settle() terminate");

  const c = nets(list, all, "USD", 2, {});
  eq(c.unconverted, ["pu_dinner", "pu_taxi"],
     "with no PEN rate the two soles purchases are REPORTED, never guessed at");
  eq(asObj(c.net), { u_ada: 0, u_ben: 15000, u_cleo: 0, u_dev: -15000 },
     "…and the dollars still settle exactly, which is the per-currency fallback of §6.5(b)");
}

// ── 2b. payments ────────────────────────────────────────────────────────────────────────
console.log("\n2b. payments — one person paying another back (model §18)");

{
  const all = ["u_ada", "u_ben", "u_cleo", "u_dev"];
  const Pay = (id, amount, currency, exp, from, to) => ({
    id, kind: "payment", amount_minor: amount, currency, amount_exp: exp, paid_by: from, split_mode: "exact",
    shares: [{ user_id: to, weight: 1, share_minor: amount }],
  });
  const dinner = P("pu_meal", 20000, "USD", 2, "u_ada", even(all, 20000, "pu_meal"));
  const before = nets([dinner], all, "USD", 2, {});
  eq(asObj(before.net), { u_ada: 15000, u_ben: -5000, u_cleo: -5000, u_dev: -5000 }, "before any payment: three people owe 50.00 each");
  eq(settle(before.net).length, 3, "…and settling takes three transfers");

  // Ben pays Ada back in full; Cleo pays part.
  const list = [dinner, Pay("pu_pay_1", 5000, "USD", 2, "u_ben", "u_ada"), Pay("pu_pay_2", 2000, "USD", 2, "u_cleo", "u_ada")];
  const led = nets(list, all, "USD", 2, {});
  eq(asObj(led.net), { u_ada: 8000, u_ben: 0, u_cleo: -3000, u_dev: -5000 }, "a payment moves the two nets by its amount: Ben is even, Cleo owes 30.00");
  eq(settle(led.net), [
    { from: "u_dev", to: "u_ada", amount_minor: 5000 },
    { from: "u_cleo", to: "u_ada", amount_minor: 3000 },
  ], "a paid transfer drops off the list by itself");
  ok(led.total === 20000, "a payment is not spending: the total is the dinner alone", `${led.total}`);
  eq([asObj(led.paid), asObj(led.owed)], [asObj(before.paid), asObj(before.owed)], "paid and share mean purchases only: neither moved");
  eq(asObj(led.back), { u_ada: 0, u_ben: 5000, u_cleo: 2000, u_dev: 0 }, "paid back: what each person handed over");
  eq(asObj(led.got), { u_ada: 7000, u_ben: 0, u_cleo: 0, u_dev: 0 }, "got back: what each person received");
  ok(all.every((u) => led.net.get(u) === led.paid.get(u) - led.owed.get(u) + led.back.get(u) - led.got.get(u)),
     "for every person, net = paid - share + paid back - got back");
  ok([...led.net.values()].reduce((a, b) => a + b, 0) === 0, "the nets still sum to zero");

  // Paying too much is recorded at face value and shows honestly as a debt the other way.
  const over = nets([dinner, Pay("pu_pay_3", 6000, "USD", 2, "u_ben", "u_ada")], all, "USD", 2, {});
  ok(over.net.get("u_ben") === 1000, "ten too many paid back: Ben is owed 10.00", `${over.net.get("u_ben")}`);

  // A payment in another currency converts like a purchase, and one with no rate is reported.
  const pen = Pay("pu_pay_4", 18750, "PEN", 2, "u_dev", "u_ada");
  const conv = nets([dinner, pen], all, "USD", 2, { PEN: 3.75 });
  ok(conv.net.get("u_dev") === 0 && conv.back.get("u_dev") === 5000, "S/ 187.50 at 3.75 settles a 50.00 debt", `${conv.net.get("u_dev")} ${conv.back.get("u_dev")}`);
  const none = nets([dinner, pen], all, "USD", 2, {});
  eq([none.unconverted, none.net.get("u_dev")], [["pu_pay_4"], -5000], "with no rate it is reported and moves nothing");

  // A row from a phone that has no kind yet reads as a purchase, as before.
  ok(isPayment({ kind: "payment" }) && !isPayment({ kind: "purchase" }) && !isPayment({}) && !isPayment(null), "only kind 'payment' is a payment");
}

// ── 3. the property suite ───────────────────────────────────────────────────────────────
console.log("\n3. the property suite — §5.7, 20,000 randomised trips");

{
  // A tiny deterministic PRNG so a failure is reproducible from the seed printed below.
  let s = 0x9e3779b9;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const pick = (n) => Math.floor(rnd() * n);

  const TRIPS = 20000;
  let bad = 0, worstTransfers = 0, worstPeople = 0, firstBad = null;

  for (let t = 0; t < TRIPS && bad === 0; t++) {
    const nPeople = 2 + pick(6);                      // 2..7
    const people = Array.from({ length: nPeople }, (_, i) => `u_${String(i).padStart(2, "0")}`);
    const nBuys = 1 + pick(8);                        // 1..8
    const list = [];

    for (let b = 0; b < nBuys; b++) {
      const amount = 1 + pick(500000);                // up to 5,000.00
      const k = 1 + pick(nPeople);                    // 1..n participants
      // Fisher-Yates, not `sort(() => rnd() - .5)`. The comparator trick is a biased shuffle
      // and would leave whole participant subsets systematically under-tested — which in a
      // suite whose entire job is to find the case that does not sum is not a small thing.
      const bag = people.slice();
      for (let q = bag.length - 1; q > 0; q--) { const r2 = pick(q + 1); [bag[q], bag[r2]] = [bag[r2], bag[q]]; }
      const inc = bag.slice(0, k).sort();
      const weights = inc.map(() => 1 + pick(5));     // 1..5
      const id = `pu_${t}_${b}`;
      const resolved = allocate(amount, weights, id);
      const shares = inc.map((u, i) => ({ user_id: u, weight: weights[i], share_minor: resolved[i] }));
      if (shares.reduce((a, x) => a + x.share_minor, 0) !== amount) {
        bad++; firstBad = `SUM(share_minor) !== amount_minor on ${id}`; break;
      }
      list.push(P(id, amount, "USD", 2, people[pick(nPeople)], shares));
    }
    if (bad) break;

    const { net } = netBalances(list, people, { to: "USD", toExp: 2, rates: {} });
    const sum = [...net.values()].reduce((a, v) => a + v, 0);
    if (sum !== 0) { bad++; firstBad = `SUM(net) === ${sum} on trip ${t}`; break; }

    const tr = settle(net);
    const nonZero = [...net.values()].filter((v) => v !== 0).length;
    if (nonZero && tr.length > nonZero - 1) {
      bad++; firstBad = `${tr.length} transfers for ${nonZero} non-zero balances on trip ${t}`; break;
    }
    if (tr.some((x) => x.amount_minor <= 0)) { bad++; firstBad = `a transfer of <= 0 on trip ${t}`; break; }

    // Applying every transfer must leave EVERY balance at exactly zero.
    const after = new Map(net);
    for (const x of tr) {
      after.set(x.from, after.get(x.from) + x.amount_minor);
      after.set(x.to, after.get(x.to) - x.amount_minor);
    }
    if ([...after.values()].some((v) => v !== 0)) {
      bad++; firstBad = `a balance survived settlement on trip ${t}`; break;
    }

    // The same transfers RECORDED as payments: everyone is even, nothing is left to settle,
    // and what was spent has not moved.
    const paidUp = list.concat(tr.map((x, i) => ({
      id: `pay_${t}_${i}`, kind: "payment", amount_minor: x.amount_minor, currency: "USD", amount_exp: 2,
      paid_by: x.from, split_mode: "exact", shares: [{ user_id: x.to, weight: 1, share_minor: x.amount_minor }],
    })));
    const led = netBalances(list, people, { to: "USD", toExp: 2, rates: {} });
    const led2 = netBalances(paidUp, people, { to: "USD", toExp: 2, rates: {} });
    if ([...led2.net.values()].some((v) => v !== 0) || settle(led2.net).length) {
      bad++; firstBad = `the transfers recorded as payments left a balance on trip ${t}`; break;
    }
    if (led2.total !== led.total || people.some((u) => led2.paid.get(u) !== led.paid.get(u) || led2.owed.get(u) !== led.owed.get(u))) {
      bad++; firstBad = `payments moved what was spent on trip ${t}`; break;
    }

    if (tr.length > worstTransfers) { worstTransfers = tr.length; worstPeople = nPeople; }
  }

  ok(bad === 0, `${TRIPS.toLocaleString("en-US")} trips: shares sum, nets sum to zero, transfers minimal and complete, and recorded as payments they leave everyone even`,
     bad ? firstBad : `worst case ${worstTransfers} transfers for ${worstPeople} people`);
}

// ── 4. the two tables that must agree ───────────────────────────────────────────────────
console.log("\n4. the client ISO table against src/api/purchases.js MINOR_UNITS");

{
  const wrong = Object.keys(MINOR_UNITS).filter((c) => expOf(c) !== MINOR_UNITS[c]);
  ok(wrong.length === 0, "every code in the server's MINOR_UNITS has the same exponent client-side",
     wrong.length ? wrong.map((c) => `${c}: client ${expOf(c)} vs server ${MINOR_UNITS[c]}`).join(", ")
                  : `${Object.keys(MINOR_UNITS).length} codes checked`);

  // And the other direction: a client code whose exponent is not 2 and which the server does
  // not know about would be accepted here and 400'd there.
  const orphans = CURRENCY_CODES.filter((c) => expOf(c) !== 2 && MINOR_UNITS[c] === undefined);
  ok(orphans.length === 0, "no client code carries a non-2 exponent the server has never heard of",
     orphans.join(", ") || `${CURRENCY_CODES.length} codes in the client table`);

  ok(expOf("PEN") === 2 && expOf("USD") === 2 && expOf("ZZZ") === 2,
     "the default for a known 2-digit code and for an unknown one is 2");
}

// ── 5. formatting and parsing ───────────────────────────────────────────────────────────
console.log("\n5. formatting and parsing — the two places a number crosses into text");

ok(fmtMoney(18500, 2, "PEN") === "S/ 185.00", "fmtMoney PEN", fmtMoney(18500, 2, "PEN"));
ok(fmtMoney(4990, 2, "USD", { approx: true }) === "≈ $49.90", "the ≈ prefix is the converted number's second carrier",
   fmtMoney(4990, 2, "USD", { approx: true }));
ok(fmtMoney(241000, 2, "PEN") === "S/ 2,410.00", "thousands are grouped", fmtMoney(241000, 2, "PEN"));
ok(fmtMoney(1000, 0, "JPY") === "¥1,000", "a zero-exponent currency prints no decimal point", fmtMoney(1000, 0, "JPY"));
ok(fmtMoney(-3820, 2, "USD") === "$38.20", "the sign is dropped by default — the settle-up says direction in words");
ok(fmtMoney(-3820, 2, "USD", { sign: true }) === "-$38.20", "…and kept when asked for");
ok(currencyLabel("PEN") === "S/ PEN" && currencyLabel("USD") === "$ USD", "a currency with a symbol is named symbol then code",
   `${currencyLabel("PEN")} | ${currencyLabel("USD")}`);
ok(currencyLabel("CHF") === "CHF" && currencyLabel("KWD") === "KWD", "a currency with no symbol of its own is named once, not twice",
   `${currencyLabel("CHF")} | ${currencyLabel("KWD")}`);
{
  const doubled = CURRENCY_CODES.filter((c) => { const w = currencyLabel(c).split(" "); return w.length > 1 && w[0] === w[1]; });
  const bare = CURRENCY_CODES.filter((c) => symbolOf(c) === c);
  ok(doubled.length === 0 && bare.length > 0 && bare.every((c) => currencyLabel(c) === c),
     "no currency in the table is named with the same word twice", `${bare.length} have no symbol; doubled: ${doubled.join(" ") || "none"}`);
}
ok(currencyLabel("XYZ") === "XYZ" && currencyLabel("") === "", "an unknown code is named by its code alone", JSON.stringify([currencyLabel("XYZ"), currencyLabel("")]));
ok(fmtMoney(12345, 2, "XYZ") === "XYZ 123.45", "an unknown code prints the code, never a made-up symbol",
   fmtMoney(12345, 2, "XYZ"));

ok(parseAmount("185.00", 2) === 18500, "parseAmount plain");
ok(parseAmount("185", 2) === 18500, "parseAmount with no decimal part");
ok(parseAmount("185.5", 2) === 18550, "parseAmount with one decimal digit");
ok(parseAmount("1,500", 2) === 150000, "'1,500' is one thousand five hundred");
ok(parseAmount("1,50", 2) === 150, "'1,50' is one and a half");
ok(parseAmount("1.234,56", 2) === 123456, "both separators: the last one is the decimal point");
ok(parseAmount("1,234.56", 2) === 123456, "…in either order");
ok(parseAmount("185.567", 2) === null, "more precision than the currency has is REFUSED, never rounded");
ok(parseAmount("1200.5", 0) === null, "…and a decimal in a zero-exponent currency likewise");
ok(parseAmount("", 2) === null && parseAmount("abc", 2) === null && parseAmount("-5", 2) === null,
   "empty, non-numeric and signed input are all null");
ok(toAmountText(4800, 2) === "48.00" && toAmountText(1000, 0) === "1000" && toAmountText(5, 2) === "0.05",
   "toAmountText round-trips a stored row back into the input");
ok(parseAmount(toAmountText(123456, 2), 2) === 123456, "parse(format(x)) === x");

// restate() — the same money at a different precision. This is the rule the drawer applies
// when its currency chip moves between a 2-digit currency and a 0- or 3-digit one, and the
// first spelling of it in split.js turned S/ 185.500 into 1855.00 by carrying the MINOR units
// across instead of the major value. It is here, and tested here, for exactly that reason.
ok(restate(18550, 2, 0) === 186, "185.50 at two digits is 186 at zero (USD -> JPY)", `${restate(18550, 2, 0)}`);
ok(restate(185500, 3, 2) === 18550, "185.500 at three digits is 185.50 at two (KWD -> USD)", `${restate(185500, 3, 2)}`);
ok(restate(18550, 2, 3) === 185500, "…and back again", `${restate(18550, 2, 3)}`);
ok(restate(4800, 2, 2) === 4800, "same exponent, same integer, no rounding at all");
ok(restate(99, 2, 0) === 1, "0.99 rounds to 1 yen, not to 0 and not to 99");

ok(nameOf("PEN") === "Sol" && symbolOf("PEN") === "S/" && symbolOf("QQQ") === "QQQ",
   "the picker has a name and a symbol for a known code and falls back honestly for an unknown one");

// ── done ────────────────────────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + fails.length} checks passed`);
if (fails.length) {
  console.log(`\n${fails.length} FAILED:`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}

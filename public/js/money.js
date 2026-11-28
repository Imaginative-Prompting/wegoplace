// money.js — the pure money primitives. No DOM, no store, no view imports.
//
// ── OWNERSHIP, READ THIS FIRST ──────────────────────────────────────────────────────────
// Pure split/settlement math module paired with
// public/js/split.js, and lists its full contents: the ISO currency table (code -> name,
// exponent, symbol), fmtMoney(), convert(), allocate(), fnv1a32(), netBalances() and
// settle().
//
// This file currently holds only the two of those that public/js/store.js cannot load
// without — fnv1a32() and allocate() — kept in one canonical module
// so rounding logic never diverges.
// store.js recomputes share_minor itself rather than trusting a caller, which means
// `import { allocate } from "./money.js"` is a hard dependency of the data layer: without
// this file, store.js fails to resolve, ready() never runs, and the whole app is a white
// screen. The store build could not be verified in a browser at all until it existed.
//
// The alternative was a second copy of allocate() inside store.js, which we avoid so
// allocate() stays the single implementation in the whole
// codebase. Two copies of a rounding rule is how a settle-up goes quietly wrong.
//
// **The split owner APPENDS to this file** — convert(), netBalances(), settle(), fmtMoney()
// and the ISO table — and does not need to touch anything below. If they would rather write
// it from scratch, the two functions here are byte-for-byte the spec's own text, so pasting
// the spec over them changes nothing.
//
// scripts/split_math_check.mjs imports this module directly under plain node, so it must
// stay free of DOM, of store.js, and of any view module. It is: the only thing below is
// arithmetic.

/**
 * FNV-1a over a string, the same spelling as hueIndex() in functions/api/trip.js. It is here
 * for the same reason it is there: a deterministic, device-independent starting index that
 * does not need a counter and cannot drift between two phones that are both offline.
 */
export function fnv1a32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * Split `total` (integer minor units, >= 0) across `weights` (integers, >= 0, at least one
 * positive) so that the result is all integers and SUMS TO `total` EXACTLY.
 *
 * LARGEST REMAINDER (Hamilton). Everybody gets their floor; the units left over go one at a
 * time to whoever was robbed most by the flooring. That is the only distribution that is both
 * exact and free of a systematic bias toward any position in the list.
 *
 * THE TIE-BREAK IS ROTATED BY THE PURCHASE ID, and that is not decoration. In an EVEN split
 * every remainder is identical, so the tie-break alone decides who eats the extra cent — and
 * a fixed rule (say, ascending user id) hands it to the same person on every single purchase
 * for the whole trip. Rotating the starting position by fnv1a32(seedKey) spreads it, stays
 * deterministic, and gives every device the same answer offline. Pass the purchase id.
 *
 * BIGINT, deliberately. `total * weight` overflows Number's exact range as soon as an 'exact'
 * split is involved: weights are then minor amounts, so the product is the amount SQUARED —
 * a 10,000-sol purchase is 1e6 minor, squared is 1e12, and a large trip total gets there.
 * A silently wrong share is the one failure mode this whole design exists to prevent, and the
 * cost is a few hundred BigInt ops per render.
 *
 * The comparator is TOTAL — remainder descending, then rotated position ascending — so this
 * does not depend on Array#sort being stable. It is, since ES2019, but a settle-up that is
 * correct because of an engine guarantee nobody wrote down is a settle-up waiting to move.
 */
export function allocate(total, weights, seedKey = "") {
  const n = weights.length;
  if (!n) return [];
  const T = BigInt(total);
  const W = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (W <= 0n) throw new Error("allocate: total weight must be positive");

  const out = new Array(n);
  const rank = new Array(n);
  const rot = fnv1a32(seedKey) % n;
  let assigned = 0n;

  for (let i = 0; i < n; i++) {
    const num = T * BigInt(weights[i]);
    const q = num / W;                       // BigInt division truncates: this is the floor
    out[i] = q;
    assigned += q;
    rank[i] = { i, rem: num - q * W, rot: (i - rot + n) % n };
  }

  rank.sort((a, b) => (a.rem < b.rem ? 1 : a.rem > b.rem ? -1 : a.rot - b.rot));

  // Strictly fewer left over than there are participants, so this never wraps.
  const left = Number(T - assigned);
  for (let k = 0; k < left; k++) out[rank[k].i] += 1n;

  return out.map(Number);
}

// ════════════════════════════════════════════════════════════════════════════════════════
// PURE MONEY HELPERS. Everything above this line is store.js's hard dependency;
// everything below provides the rest of this
// file — the ISO table, formatting, parsing, conversion, net balances and the settlement.
// Still pure: no DOM, no store.js, no view import, so scripts/split_math_check.mjs can
// import this module under plain node and test the real code rather than a copy of it.
// ════════════════════════════════════════════════════════════════════════════════════════

// ── the ISO 4217 table ──────────────────────────────────────────────────────────────────
// [ name, symbol, exponent ]. Symbol "" means "there is no short form anybody would
// recognise" and the code itself is printed instead — which is the honest answer for most
// of this list and is why the symbol is a column rather than a lookup with a guess in it.
// The exponent is OMITTED for the 2-digit majority and written only where it is not 2.
//
// WHAT THIS TABLE IS FOR, AND WHAT IT IS NOT. It is consulted for exactly one economic
// decision: picking the DEFAULT amount_exp when a purchase is created. By design
// the exponent rides the row and this table is never allowed to
// re-scale a purchase somebody already made — "if somebody fixes a wrong exponent in that
// table in eight months, every historical row in that currency silently changes value by
// 100x, with no migration and no trace". So every arithmetic and formatting call below takes
// an explicit `exp` argument from the row, and nothing in the money path reads this table
// behind a caller's back.
//
// THE ZERO/THREE/FOUR-DIGIT ENTRIES MUST MATCH `MINOR_UNITS` IN functions/api/purchases.js
// EXACTLY. That map is the server's sanity check on a supplied amount_exp, this one is what
// the client supplies, and a disagreement is a 400 the user cannot do anything about.
// scripts/split_math_check.mjs asserts the two agree, which is the mechanism `end_tz` never
// had. CLF and UYW are unit-of-account codes nobody pays a taxi in; they are here only
// because they are in that server map and the assertion covers every key of it.
const ISO = {
  AED: ["UAE Dirham", "د.إ"],        AFN: ["Afghani", "؋"],
  ALL: ["Lek", "L"],                 AMD: ["Armenian Dram", "֏"],
  ANG: ["Netherlands Antillean Guilder", "ƒ"], AOA: ["Kwanza", "Kz"],
  ARS: ["Argentine Peso", "$"],      AUD: ["Australian Dollar", "$"],
  AWG: ["Aruban Florin", "ƒ"],       AZN: ["Azerbaijan Manat", "₼"],
  BAM: ["Convertible Mark", "KM"],   BBD: ["Barbados Dollar", "$"],
  BDT: ["Taka", "৳"],                BGN: ["Bulgarian Lev", "лв"],
  BHD: ["Bahraini Dinar", "", 3],    BIF: ["Burundi Franc", "", 0],
  BMD: ["Bermudian Dollar", "$"],    BND: ["Brunei Dollar", "$"],
  BOB: ["Boliviano", "Bs"],          BRL: ["Brazilian Real", "R$"],
  BSD: ["Bahamian Dollar", "$"],     BTN: ["Ngultrum", "Nu."],
  BWP: ["Pula", "P"],                BYN: ["Belarusian Ruble", "Br"],
  BZD: ["Belize Dollar", "$"],       CAD: ["Canadian Dollar", "$"],
  CDF: ["Congolese Franc", "FC"],    CHF: ["Swiss Franc", "CHF"],
  CLF: ["Unidad de Fomento", "", 4], CLP: ["Chilean Peso", "$", 0],
  CNY: ["Yuan Renminbi", "¥"],       COP: ["Colombian Peso", "$"],
  CRC: ["Costa Rican Colon", "₡"],   CUP: ["Cuban Peso", "$"],
  CVE: ["Cabo Verde Escudo", "$"],   CZK: ["Czech Koruna", "Kč"],
  DJF: ["Djibouti Franc", "", 0],    DKK: ["Danish Krone", "kr"],
  DOP: ["Dominican Peso", "$"],      DZD: ["Algerian Dinar", "د.ج"],
  EGP: ["Egyptian Pound", "£"],      ERN: ["Nakfa", "Nfk"],
  ETB: ["Ethiopian Birr", "Br"],     EUR: ["Euro", "€"],
  FJD: ["Fiji Dollar", "$"],         FKP: ["Falkland Islands Pound", "£"],
  GBP: ["Pound Sterling", "£"],      GEL: ["Lari", "₾"],
  GHS: ["Ghana Cedi", "₵"],          GIP: ["Gibraltar Pound", "£"],
  GMD: ["Dalasi", "D"],              GNF: ["Guinean Franc", "", 0],
  GTQ: ["Quetzal", "Q"],             GYD: ["Guyana Dollar", "$"],
  HKD: ["Hong Kong Dollar", "$"],    HNL: ["Lempira", "L"],
  HTG: ["Gourde", "G"],              HUF: ["Forint", "Ft"],
  IDR: ["Rupiah", "Rp"],             ILS: ["New Israeli Sheqel", "₪"],
  INR: ["Indian Rupee", "₹"],        IQD: ["Iraqi Dinar", "", 3],
  IRR: ["Iranian Rial", "﷼"],        ISK: ["Iceland Krona", "kr", 0],
  JMD: ["Jamaican Dollar", "$"],     JOD: ["Jordanian Dinar", "", 3],
  JPY: ["Yen", "¥", 0],              KES: ["Kenyan Shilling", "KSh"],
  KGS: ["Som", "с"],                 KHR: ["Riel", "៛"],
  KMF: ["Comorian Franc", "", 0],    KPW: ["North Korean Won", "₩"],
  KRW: ["Won", "₩", 0],              KWD: ["Kuwaiti Dinar", "", 3],
  KYD: ["Cayman Islands Dollar", "$"], KZT: ["Tenge", "₸"],
  LAK: ["Lao Kip", "₭"],             LBP: ["Lebanese Pound", "ل.ل"],
  LKR: ["Sri Lanka Rupee", "Rs"],    LRD: ["Liberian Dollar", "$"],
  LSL: ["Loti", "L"],                LYD: ["Libyan Dinar", "", 3],
  MAD: ["Moroccan Dirham", "د.م."],  MDL: ["Moldovan Leu", "L"],
  MGA: ["Malagasy Ariary", "Ar"],    MKD: ["Denar", "ден"],
  MMK: ["Kyat", "K"],                MNT: ["Tugrik", "₮"],
  MOP: ["Pataca", "MOP$"],           MRU: ["Ouguiya", "UM"],
  MUR: ["Mauritius Rupee", "₨"],     MVR: ["Rufiyaa", ".ރ"],
  MWK: ["Malawi Kwacha", "MK"],      MXN: ["Mexican Peso", "$"],
  MYR: ["Malaysian Ringgit", "RM"],  MZN: ["Mozambique Metical", "MT"],
  NAD: ["Namibia Dollar", "$"],      NGN: ["Naira", "₦"],
  NIO: ["Cordoba Oro", "C$"],        NOK: ["Norwegian Krone", "kr"],
  NPR: ["Nepalese Rupee", "Rs"],     NZD: ["New Zealand Dollar", "$"],
  OMR: ["Rial Omani", "", 3],        PAB: ["Balboa", "B/."],
  PEN: ["Sol", "S/"],                PGK: ["Kina", "K"],
  PHP: ["Philippine Peso", "₱"],     PKR: ["Pakistan Rupee", "₨"],
  PLN: ["Zloty", "zł"],              PYG: ["Guarani", "₲", 0],
  QAR: ["Qatari Rial", "ر.ق"],       RON: ["Romanian Leu", "lei"],
  RSD: ["Serbian Dinar", "дин"],     RUB: ["Russian Ruble", "₽"],
  RWF: ["Rwanda Franc", "", 0],      SAR: ["Saudi Riyal", "ر.س"],
  SBD: ["Solomon Islands Dollar", "$"], SCR: ["Seychelles Rupee", "₨"],
  SDG: ["Sudanese Pound", "ج.س"],    SEK: ["Swedish Krona", "kr"],
  SGD: ["Singapore Dollar", "$"],    SHP: ["Saint Helena Pound", "£"],
  SLE: ["Leone", "Le"],              SOS: ["Somali Shilling", "Sh"],
  SRD: ["Surinam Dollar", "$"],      SSP: ["South Sudanese Pound", "£"],
  STN: ["Dobra", "Db"],              SVC: ["El Salvador Colon", "₡"],
  SYP: ["Syrian Pound", "£"],        SZL: ["Lilangeni", "L"],
  THB: ["Baht", "฿"],                TJS: ["Somoni", "SM"],
  TMT: ["Turkmenistan New Manat", "m"], TND: ["Tunisian Dinar", "", 3],
  TOP: ["Pa'anga", "T$"],            TRY: ["Turkish Lira", "₺"],
  TTD: ["Trinidad and Tobago Dollar", "$"], TWD: ["New Taiwan Dollar", "NT$"],
  TZS: ["Tanzanian Shilling", "TSh"], UAH: ["Hryvnia", "₴"],
  UGX: ["Uganda Shilling", "USh", 0], USD: ["US Dollar", "$"],
  UYU: ["Peso Uruguayo", "$U"],      UYW: ["Unidad Previsional", "", 4],
  UZS: ["Uzbekistan Sum", "so'm"],   VED: ["Bolivar Soberano", "Bs."],
  VES: ["Bolivar Soberano", "Bs."],  VND: ["Dong", "₫", 0],
  VUV: ["Vatu", "VT", 0],            WST: ["Tala", "T"],
  XAF: ["CFA Franc BEAC", "FCFA", 0], XCD: ["East Caribbean Dollar", "$"],
  XOF: ["CFA Franc BCEAO", "CFA", 0], XPF: ["CFP Franc", "F", 0],
  YER: ["Yemeni Rial", "﷼"],         ZAR: ["Rand", "R"],
  ZMW: ["Zambian Kwacha", "ZK"],     ZWG: ["Zimbabwe Gold", "ZiG"],
};

/** Every code, sorted. What the "other currency" picker lists. */
export const CURRENCY_CODES = Object.keys(ISO).sort();

/** The full name — "Sol", "US Dollar". A picker that shows only codes is a quiz. */
export const nameOf = (code) => (ISO[code] ? ISO[code][0] : "");

/**
 * The default minor-digit exponent for a code, and the ONLY place a purchase's exponent is
 * ever guessed. Unknown codes get 2, which is right for ~150 of the 180 and is the same
 * default the column carries in migrations/0011_purchases.sql.
 */
export const expOf = (code) => {
  const row = ISO[code];
  return row && row[2] !== undefined ? row[2] : 2;
};

/**
 * "S/", "$", or the code itself when nothing short would be recognised. Never a guess: a
 * made-up symbol on a receipt line is worse than three honest letters.
 */
export const symbolOf = (code) => (ISO[code] && ISO[code][1]) || String(code || "");

/**
 * A currency as a chip or a picker row names it: "S/ PEN", "$ USD", and plain "CHF" for one
 * whose only symbol is its own code. Fifteen ISO currencies are like that (CHF, KWD, JOD, …),
 * and writing symbol then code for them printed "CHF CHF".
 */
export const currencyLabel = (code) => {
  const c = String(code || "");
  const sym = symbolOf(c);
  return sym === c ? c : `${sym} ${c}`;
};

/** Is this a code we know? The picker's filter and the drawer's validation both ask. */
export const knownCurrency = (code) => Object.prototype.hasOwnProperty.call(ISO, code);

// ── formatting ──────────────────────────────────────────────────────────────────────────
// Intl.NumberFormat is cached for the same reason util.js caches Intl.DateTimeFormat:
// constructing one costs about two orders of magnitude more than using one, and the settle
// sheet formats a number per person per purchase on every repaint.
const NF = new Map();
function nf(exp) {
  let f = NF.get(exp);
  if (!f) {
    f = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: exp, maximumFractionDigits: exp, useGrouping: true,
    });
    NF.set(exp, f);
  }
  return f;
}

/**
 * fmtMoney(minor, exp, code, opts) -> "S/ 185.00" | "$49.90" | "PEN 185.00"
 *
 * SPACING IS A RULE, not a preference. A one-glyph symbol binds to its number the way "$5"
 * does everywhere; a multi-character symbol ("S/") or a bare three-letter code needs the
 * space or it reads as one word. Standardize on spaced multi-character symbols;
 * this is the spelling that reads cleanly everywhere.
 *
 * opts.approx  prefix "≈". THE SECOND CARRIER FOR A CONVERTED NUMBER:
 *              a converted figure and a stored figure are otherwise identical shapes on the
 *              screen, and this app never signals a state by one channel alone. Every result
 *              of convert() is printed through this flag, everywhere, including in greyscale.
 * opts.sign    keep a minus sign. Off by default because the settle-up says direction in
 *              WORDS ("owes" / "gets back") and a minus beside those words is a double
 *              negative waiting to be misread.
 */
export function fmtMoney(minor, exp, code, { approx = false, sign = false } = {}) {
  const n = Number(minor);
  if (!Number.isFinite(n)) return "";
  const e = Number.isInteger(exp) ? exp : expOf(code);
  const sym = symbolOf(code);
  // The minus goes in FRONT of the symbol — "-$38.20", never "$-38.20". Intl puts it in
  // front of the digits, which is the wrong side of a currency symbol we are placing
  // ourselves, so the magnitude is formatted and the sign is written back on here.
  const neg = sign && n < 0;
  const digits = nf(e).format(Math.abs(n) / Math.pow(10, e));
  // Longer than one code point, or it IS the code: the space keeps it legible.
  const gap = [...sym].length > 1 ? " " : "";
  return `${approx ? "≈ " : ""}${neg ? "-" : ""}${sym}${gap}${digits}`;
}

/**
 * Text off a numeric keypad -> integer minor units, or null when it is not an amount.
 *
 * REFUSES rather than rounds. "12.567" in a 2-digit currency is not 1256 and it is not 1257
 * — it is a typo, and silently choosing one of them is money quietly changing value. Null
 * leaves Add disabled while the amount does not
 * parse, and the user can see their own text.
 *
 * SEPARATOR HEURISTIC, because the same phone is used by people who type "1,50" and people
 * who type "1,500": when both separators appear, the LAST one is the decimal point and the
 * other is grouping. When only "," appears, it is grouping if it is followed by exactly
 * three digits with a digit before it, and a decimal point otherwise. Peru and the US both
 * write "185.00", so the common path here is the boring one.
 */
export function parseAmount(text, exp) {
  const e = Number.isInteger(exp) ? exp : 2;
  let s = String(text == null ? "" : text).trim().replace(/[\s '’]/g, "");
  if (!s) return null;
  if (!/^[0-9.,]+$/.test(s)) return null;

  const lastDot = s.lastIndexOf(".");
  const lastCom = s.lastIndexOf(",");
  let dec = -1;
  if (lastDot >= 0 && lastCom >= 0) dec = Math.max(lastDot, lastCom);
  else if (lastDot >= 0) dec = lastDot;
  else if (lastCom >= 0) dec = /^\d+,\d{3}$/.test(s) ? -1 : lastCom;

  let whole = dec >= 0 ? s.slice(0, dec) : s;
  const frac = dec >= 0 ? s.slice(dec + 1) : "";
  whole = whole.replace(/[.,]/g, "");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;
  if (!whole && !frac) return null;
  if (frac.length > e) return null;                      // more precision than the currency has

  const minor = Number(whole || "0") * Math.pow(10, e) + Number((frac || "0").padEnd(e, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** The inverse, for prefilling an input from a stored row. "4800", 2 -> "48.00" */
export function toAmountText(minor, exp) {
  const e = Number.isInteger(exp) ? exp : 2;
  const n = Math.abs(Number(minor) || 0);
  if (!e) return String(n);
  const s = String(n).padStart(e + 1, "0");
  return `${s.slice(0, s.length - e)}.${s.slice(s.length - e)}`;
}

// ── conversion ──────────────────────────────────────────────────────────────────────────

/**
 * Convert integer minor units between currencies. Returns null when it cannot be done, and
 * null is a real answer — "we have never fetched a rate for soles" is information the screen
 * has to render honestly, not a zero to paper over.
 *
 * Rates are USD-based: rates[X] is how many X one USD buys, so USD itself is 1 and is not in
 * the table. One multiplication, ONE Math.round, no accumulation.
 */
export function convert(minor, fromExp, from, toExp, to, rates) {
  if (from === to) return minor;                       // identity, and no rate needed
  const r = rates || {};
  const rf = from === "USD" ? 1 : r[from];
  const rt = to === "USD" ? 1 : r[to];
  if (!rf || !rt) return null;
  return Math.round(minor * Math.pow(10, toExp - fromExp) * (rt / rf));
}

/**
 * Re-state the SAME amount of money at a different minor-unit precision. Not a conversion —
 * no rate is involved and no currency changes; this is what happens when the drawer's
 * currency chip moves from a 2-digit currency to a 0-digit one and the number on screen has
 * to keep meaning what the person typed.
 *
 * THE MAJOR VALUE IS THE INVARIANT. "185.50" is 18550 minor units at exponent 2 and 1855 at
 * exponent 1; carrying the MINOR units across unchanged would turn a hundred and eighty-five
 * into eighteen hundred and fifty-five. So it goes through the major value and rounds once,
 * to the precision the destination actually has.
 *
 * It lives here rather than in split.js so that scripts/split_math_check.mjs can hold it to
 * its literals — every other rule that moves a number between two scales in this app is in
 * this file, and the one that was not is the one that was wrong.
 */
export function restate(minor, fromExp, toExp) {
  const f = Number.isInteger(fromExp) ? fromExp : 2;
  const t = Number.isInteger(toExp) ? toExp : 2;
  if (f === t) return minor;
  return Math.round((Number(minor) / Math.pow(10, f)) * Math.pow(10, t));
}

/** Can every purchase in `list` be shown in `to`? What the settle sheet's banner asks. */
export function coveredBy(list, to, rates) {
  for (const p of list) if (convert(1, 0, p.currency, 0, to, rates) === null) return false;
  return true;
}

// ── the ledger ──────────────────────────────────────────────────────────────────────────

/**
 * Net balance per person, in the viewer's currency, in integer minor units.
 *
 *   net = what you PAID  -  what you OWE
 *
 * Positive means the group owes you. Negative means you owe the group. They sum to exactly
 * zero, which is what makes settle() terminate.
 *
 * CONVERSION HAPPENS HERE AND ONLY HERE. Each purchase's TOTAL is
 * converted once and rounded once; its shares are then re-allocated across that converted
 * total with the same allocate() used to build them, so the converted shares still sum to
 * the converted total exactly. Rounding each share independently would leave the per-purchase
 * sum out by up to (n-1) minor units and the zero-sum property would not hold.
 *
 * A purchase in a currency with no rate is SKIPPED and reported in `unconverted`. It is never
 * guessed at, never dropped silently, and never shown as a converted number.
 *
 * RETURNS `{ net, unconverted, ... }` so callers can render the breakdown:
 * e.g. "paid S/ 620.00 · share S/ 477.50" beside every net,
 * because that sub-line is the WHY — net is visibly paid minus share, so the transfers below
 * need no faith. Computing it in the view would mean a second conversion loop and therefore
 * a second place for the rounding rule to live, which single-pass conversion forbids. Destructuring
 * `{ net, unconverted }` works cleanly without depending on extra fields.
 *
 * PAYMENTS (`kind: "payment"`, one share: the person who received it) add `back` (what each
 * person paid back) and `got` (what each got back). `total`, `paid` and `owed` are purchases
 * only: a payment is not spending.
 *
 * THE NETS, CONVERTED, ARE ROUNDED ONCE A PERSON, and a converted net smaller than what one
 * minor unit of the coarsest currency counted is worth is settled. (27 Nov: the plan paid in
 * dollars, as Mark paid records it, left "Teo owes you ≈ €0.03" in euros and "≈ S/ 0.02" in
 * soles, at the same rates, and up to S/ 0.22 on a trip of 42 purchases: every purchase's
 * conversion rounded on its own and the roundings added up, and a payment made in cents of one
 * currency can't be finer than a cent of it in another. Nobody could ever reach "settled".)
 * Each person's net in each currency is exact (integers); it is converted with no rounding,
 * summed, and the sums rounded by largest remainder so they still add to exactly zero. In one
 * currency, nothing changes: every factor is 1. `paid`, `owed`, `back` and `got` (the "why"
 * under a balance) are summed the same way and each rounded once, so with conversion they can
 * miss the net by a unit or two, never more; `total` is still each purchase converted once.
 */
export function netBalances(purchases, memberIds, { to, toExp, rates }) {
  const net = new Map(memberIds.map((id) => [id, 0]));
  const paid = new Map(memberIds.map((id) => [id, 0]));
  const owed = new Map(memberIds.map((id) => [id, 0]));
  const back = new Map(memberIds.map((id) => [id, 0]));
  const got = new Map(memberIds.map((id) => [id, 0]));
  const unconverted = [];
  let total = 0;

  const bump = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  // Each person's exact net in each currency counted, in that currency's minor units.
  // And what each paid, owed, paid back and got back in it: the "why" under a balance, rounded once a person too.
  const native = new Map();     // code -> { exp, nets, paid, owed, back, got: Map(id -> integer) }
  const nativeBump = (p, id, v, part) => {
    let c = native.get(p.currency);
    if (!c) native.set(p.currency, c = { exp: p.amount_exp, nets: new Map(), paid: new Map(), owed: new Map(), back: new Map(), got: new Map() });
    c.nets.set(id, (c.nets.get(id) || 0) + v);
    c[part].set(id, (c[part].get(id) || 0) + Math.abs(v));
  };

  for (const p of purchases) {
    const A = convert(p.amount_minor, p.amount_exp, p.currency, toExp, to, rates);
    if (A === null) { unconverted.push(p.id); continue; }

    // A payment is money handed from one person to another, not money spent: it moves the two
    // nets and nothing else. It stays out of `total`, `paid` and `owed` (those mean purchases)
    // and is counted on its own, so a person's line still adds up by eye:
    // net = paid - share + paid back - got back.
    if (isPayment(p)) {
      const to_ = (p.shares || [])[0];
      if (!to_) continue;
      bump(net, p.paid_by, A); bump(back, p.paid_by, A);
      bump(net, to_.user_id, -A); bump(got, to_.user_id, A);
      nativeBump(p, p.paid_by, p.amount_minor, "back"); nativeBump(p, to_.user_id, -p.amount_minor, "got");
      continue;
    }
    total += A;

    // Contract order: user_id ascending. The rotation inside allocate()
    // and store.js's change-hash both depend on it, so it is asserted here rather than
    // assumed — a snapshot that ever came back in another order would otherwise move a cent.
    const shares = (p.shares || []).slice()
      .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
    if (!shares.length) continue;
    const nat = allocate(A, shares.map((s) => s.share_minor), p.id);

    bump(net, p.paid_by, A);
    bump(paid, p.paid_by, A);
    shares.forEach((s, i) => { bump(net, s.user_id, -nat[i]); bump(owed, s.user_id, nat[i]); });
    // The stored shares sum to the amount (allocate() made them), so they ARE its exact split.
    nativeBump(p, p.paid_by, p.amount_minor, "paid");
    for (const s of shares) nativeBump(p, s.user_id, -s.share_minor, "owed");
  }

  // Anything converted: the nets from the exact sums (see the head of this function).
  const codes = [...native.keys()].sort();
  if (codes.some((c) => c !== to)) {
    const factor = (c) => (c === to ? Math.pow(10, toExp - native.get(c).exp) : Math.pow(10, toExp - native.get(c).exp) * ((to === "USD" ? 1 : rates[to]) / (c === "USD" ? 1 : rates[c])));
    const exact = new Map();
    for (const c of codes) {
      const f = factor(c);
      for (const [id, v] of native.get(c).nets) exact.set(id, (exact.get(id) || 0) + v * f);
    }
    const tol = Math.max(...codes.map(factor));
    const rounded = roundToZero(exact, tol, memberIds);
    for (const id of new Set([...net.keys(), ...rounded.keys()])) net.set(id, rounded.get(id) || 0);
    for (const [part, m] of [["paid", paid], ["owed", owed], ["back", back], ["got", got]]) {
      const sum = new Map();
      for (const c of codes) for (const [id, v] of native.get(c)[part]) sum.set(id, (sum.get(id) || 0) + v * factor(c));
      for (const [id, v] of sum) m.set(id, Math.round(v));
    }
  }

  return { net, paid, owed, back, got, total, unconverted };
}

/**
 * Exact (fractional) nets that sum to zero -> integers that sum to exactly zero. One whose size is under `tol` is 0
 * (settled); the rest get their floor, and the units still needed go one at a time to the largest remainders (ties by
 * id), round again if more are needed than there are people. The same answer on every phone: the input is summed per
 * currency in code order, never in the order the rows came.
 */
function roundToZero(exact, tol, memberIds) {
  const out = new Map(memberIds.map((id) => [id, 0]));
  const rest = [...exact.entries()].filter(([, v]) => !(Math.abs(v) < tol))
    .map(([id, v]) => ({ id, v, n: Math.floor(v + 1e-9) }))
    .map((r) => ({ ...r, frac: r.v - r.n }));
  if (!rest.length) return out;
  let need = -rest.reduce((a, r) => a + r.n, 0);
  const up = rest.slice().sort((a, b) => b.frac - a.frac || (a.id < b.id ? -1 : 1));
  for (let i = 0; need > 0; i = (i + 1) % up.length, need--) up[i].n += 1;
  const down = rest.slice().sort((a, b) => a.frac - b.frac || (a.id < b.id ? -1 : 1));
  for (let i = 0; need < 0; i = (i + 1) % down.length, need++) down[i].n -= 1;
  for (const r of rest) out.set(r.id, r.n);
  return out;
}

/** A payment: one person paying another back. Every other row is a purchase. */
export const isPayment = (row) => !!row && row.kind === "payment";

/**
 * Turn net balances into a list of payments, minimizing transfer count.
 *
 * TWO PASSES.
 *
 *   1. EXACT PAIRS. Anybody who is owed exactly what somebody else owes settles with them
 *      directly, in one payment, and both leave the problem.
 *   2. GREEDY, LARGEST AGAINST LARGEST. The biggest creditor takes from the biggest debtor,
 *      as much as the smaller of the two; whichever hits zero drops out; repeat.
 *
 * WHY PASS 1 IS NEVER WORSE, which is worth writing down because "a greedy heuristic plus a
 * special case" usually is. Minimum transfers = n minus the number of groups you can partition
 * the balances into where each group sums to zero, because a zero-sum group of size k always
 * settles in k-1 payments and never fewer. If a zero-sum group G contains a zero-sum proper
 * subset S, then G\S sums to zero too, and settling them separately costs
 * (|S|-1) + (|G\S|-1) = |G|-2, which is strictly less than |G|-1. So pulling out an exact pair
 * can only ever help. Pass 1 finds every zero-sum group of size 2 — which is the case that
 * actually happens: one person owes exactly what another is owed.
 *
 * WHAT THIS IS NOT. Finding the maximum zero-sum partition in general contains subset-sum and
 * is NP-hard, so pass 2 is a heuristic. It always finishes in at most (nonzero balances - 1)
 * payments, which is the theoretical minimum whenever no proper subset of the remainder sums
 * to zero — and with four people it is what you get essentially always. Fewest transfers,
 * spelled out, rather than an exact solver nobody can read.
 *
 * DETERMINISTIC. Every sort has a total order with the user id as the final tie-break, so the
 * same balances produce byte-identical transfers on every device and on every render. A
 * settle-up list that reshuffles when you look at it twice is a settle-up list nobody trusts —
 * and under store.js's change-hash it would also repaint the screen on every snapshot.
 */
export function settle(net) {
  const rows = [...net.entries()]
    .filter(([, v]) => v !== 0)
    .map(([id, v]) => ({ id, v }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const out = [];

  // ── pass 1: exact opposite pairs ──
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].v <= 0) continue;
    for (let j = 0; j < rows.length; j++) {
      if (rows[j].v >= 0) continue;
      if (rows[i].v === -rows[j].v) {
        out.push({ from: rows[j].id, to: rows[i].id, amount_minor: rows[i].v });
        rows[j].v = 0;
        rows[i].v = 0;
        break;
      }
    }
  }

  // ── pass 2: greedy, largest creditor against largest debtor ──
  const cmp = (a, b) => Math.abs(b.v) - Math.abs(a.v) || (a.id < b.id ? -1 : 1);
  const cred = rows.filter((r) => r.v > 0).sort(cmp);
  const debt = rows.filter((r) => r.v < 0).sort(cmp);

  let i = 0, j = 0;
  while (i < cred.length && j < debt.length) {
    const amt = Math.min(cred[i].v, -debt[j].v);
    out.push({ from: debt[j].id, to: cred[i].id, amount_minor: amt });
    cred[i].v -= amt;
    debt[j].v += amt;
    if (cred[i].v === 0) i++;
    if (debt[j].v === 0) j++;
  }

  // Biggest payment first: it is the one somebody has to actually go and do.
  out.sort((a, b) => b.amount_minor - a.amount_minor || (a.from < b.from ? -1 : 1));
  return out;
}

// ── the equal/unequal predicate ─────────────────────────────────────────────────────────

/**
 * Is this purchase an EQUAL split? Equal is simply the degenerate case where every
 * included person's share has the same weight — do not model equal and unequal as two kinds of
 * purchase. So this is a question asked of a row, not a column read off it.
 *
 * IT COMPARES WEIGHTS, NOT share_minor, AND THAT IS THE WHOLE POINT. share_minor comes out of
 * allocate(), which distributes the remainder: an even three-way split of S/ 10.00 is
 * 333 / 334 / 333, and a predicate that compared the resolved amounts would mark it
 * "≠ unequal" on the feed — on the single most common purchase there is. Equal weights are
 * equal by construction, whatever the arithmetic then has to do with the last céntimo.
 *
 * Equal shares are not simply floor(amount/n)
 * plus a remainder to the first r people in roster order — the
 * id-seeded rotation in allocate() deliberately does NOT hand
 * the extra céntimo to the first person every time — otherwise the same member eats it on
 * every purchase for the whole trip. Comparing weights is the same predicate for every case
 * the description was written about, and it is the correct one for the case where the two
 * disagree.
 */
export function isEqualSplit(row) {
  const shares = (row && row.shares) || [];
  if (shares.length < 2) return true;
  const w = shares[0].weight;
  for (const s of shares) if (s.weight !== w) return false;
  return true;
}

/**
 * The equal split of `total` across `n` people, in contract order. Used to prefill the
 * unequal disclosure and to answer "Reset to equal". allocate() with all-1 weights IS the
 * equal split — there is no second computation of it anywhere, which is what keeps the
 * disclosure's prefill identical to what the store would have stored.
 */
export function equalShares(total, n, seedKey) {
  if (n <= 0) return [];
  return allocate(total, new Array(n).fill(1), seedKey);
}

// GET  /api/fx          -> { fx: FxTable }
// POST /api/fx/refresh  -> { fx: FxTable }   awaits the provider, then answers with the table
//
// The POST is wired up by functions/api/fx/refresh.js, a one-line shim, for the same reason
// functions/api/purchases/[id].js is a shim: all the logic belongs to one file, per the
// ownership table in docs/CONTRACTS.md, and Pages needs a file at the path it routes.
//
// ── WHAT A RATE IS FOR IN THIS APP, AND WHAT IT IS NOT ──────────────────────────────────
// Conversions are fetched whenever the phone is online, and a rate that drifts a little is fine: a total
// should be generally accurate, not exact to the day.
//
// So a rate is a DISPLAY concern and nothing else. Nothing on this path is ever written onto
// a purchase — no rate_used, no amount_native, no settle-up snapshot, no reconciliation pass.
// functions/api/purchases.js stores what was paid, currency and all, because that is the fact;
// this file caches the number the client multiplies by at paint time. The accepted consequence
// is that a settle-up total moves a little between two viewings a day apart, and the UI is
// required to say so out loud rather than hide it (the "Converted at rates from 4 days ago." line
// public/js/split.js prints).
//
// ── WHY THE SERVER FETCHES AND THE PHONE DOES NOT ───────────────────────────────────────
// public/js/store.js is the only thing in the whole app that calls fetch(), and it only ever
// calls our own origin. A third-party request made from the handset would be a second network
// dependency, a CORS surface and a captive-portal failure mode — on the device with the least
// signal, at 4,200 m, which is precisely the device this app exists for. The rates therefore
// land in D1 here and ride GET /api/trip's snapshot the way note_colors does: the phone gets
// exactly ONE request in before the signal goes, and rates that only arrive on their own
// endpoint are rates that do not exist on the trail. readFxTable() and kickRates() below are
// exported for that snapshot; see the note above readFxTable().
//
// ── THE PROVIDER, AND WHY THIS ONE ──────────────────────────────────────────────────────
// https://open.er-api.com/v6/latest/USD — the free, KEYLESS tier of exchangerate-api.com.
// Verified live while writing this file: `result:"success"`, 162 quotes including PEN, and a
// `time_next_update_unix` about 24 hours out. It was chosen over the alternatives for one
// reason above all the others: **it needs no API key**, so there is no secret to put in
// .dev.vars, none to add to the Pages project before a deploy, none to rotate, and no way for
// this feature to break in production because a key expired while four people were on a trail
// with no way to hear about it. Every other option looked at (exchangerate.host, fixer,
// currencyapi, openexchangerates) gates the free tier behind a key.
//
// Its cadence is roughly daily, which is exactly the resolution asked for and is why
// `next_at` is respected rather than a short fixed TTL: polling hourly would buy nothing and
// would cost a repaint of every mounted screen each time (fx.fetched_at is inside store.js's
// signature() hash — §8.3).
//
// Swapping providers is meant to be ONE function: callProvider() below. Everything downstream
// of it speaks the normalised { rates, fetchedAt, nextAt } shape and knows nothing about who
// produced it. The four fields we depend on are `result`, `base_code`, `rates` and
// `time_next_update_unix`.
//
// ── THIS IS THE FIRST OUTBOUND fetch() ANYWHERE IN functions/ ───────────────────────────
// It gets treated as such, because this codebase has NO global error handler and an unhandled
// throw out of a Pages handler is a raw 500 with a stack trace in it:
//   * a 6-second AbortController timeout, so a hung third party cannot hold a request open
//   * every call path wrapped so it can never throw out of a handler — fetchRates() returns a
//     result object, never rejects
//   * result !== "success", a base that is not USD, a missing rates object, or a single rate
//     that is not a usable number ⇒ WRITE NOTHING. A partial or garbage response must never
//     replace a table that currently works.
//   * the write is one env.DB.batch(), which is one transaction, so the table is never half a
//     fetch — not even for the moment between the DELETE and the INSERTs.

import { json } from "./json.js";
import { err, nowSec } from "./trip.js";
import { errorLine } from "../log.js";

// ── constants ───────────────────────────────────────────────────────────────────────────

const PROVIDER = "https://open.er-api.com/v6/latest/USD";

/**
 * Where the rates are asked for. FX_PROVIDER_URL is for the checks only: they point it at a
 * stand-in on this machine that answers fixed rates (checks/lib/server.mjs), so no check
 * reaches the network or depends on the day's numbers. It is honoured only on a loopback
 * address, so a variable set by mistake on a deployed site can't send its rates anywhere else;
 * wrangler.jsonc never sets it (the trips check holds that).
 */
export function providerUrl(env) {
  const set = env?.FX_PROVIDER_URL;
  if (!set) return PROVIDER;
  try {
    const u = new URL(set);
    if (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return u.href;
  } catch { /* not an address */ }
  console.warn("[fx] FX_PROVIDER_URL is not a loopback address; the real provider is used");
  return PROVIDER;
}

// Always USD, and the `base` COLUMN exists so that a future provider change is a data change
// rather than a migration. public/js/money.js's convert() is written against a USD-based table
// — rates[X] is how many X one USD buys, so USD itself is 1 and is deliberately NOT in the map.
const BASE = "USD";

// Six seconds. Long enough for a cold provider on a bad day, short enough that GET /api/trip's
// waitUntil() work is finished well inside the request's own lifetime.
const FETCH_TIMEOUT_MS = 6000;

// How long one isolate leaves the provider alone after an attempt, successful or not. The
// failure this defends against is not the happy path — it is a provider OUTAGE: a failed
// attempt writes nothing (by design), so without this floor a dead upstream means every single
// GET /api/trip from every member kicks another six-second fetch that is going to fail too.
// It is per-isolate and therefore not a hard guarantee, and it does not need to be: the shape
// it removes is the burst, and four people on one trip cannot produce many isolates.
const MIN_ATTEMPT_GAP_MS = 60000;

// What we use when the provider does not tell us when to come back. Six hours is well inside
// its daily cadence, so we never sit on a stale table waiting for a field that went missing.
const FALLBACK_TTL_S = 6 * 3600;

// And the ceiling, which is the more important of the two. A provider bug that answered
// `time_next_update_unix: 9999999999` would otherwise pin this table as "fresh" until the year
// 2286 — no automatic refresh ever again, and the only way back would be somebody tapping
// "Fetch rates" on the settle sheet. Seven days is longer than any real cadence and shorter
// than any trip that matters.
const MAX_TTL_S = 7 * 86400;

// A plausible ISO 4217 code. The provider mixes metals and a couple of non-currencies into the
// same map on some tiers, and anything that is not three capital letters cannot be a purchase's
// currency in public/js/money.js's table either, so it is dropped rather than stored.
const CODE_RE = /^[A-Z]{3}$/;

// Bounds on a single rate. `> 0 && Number.isFinite` is the spec's rule; the two literals are
// the sanity envelope around it. The floor exists because a rate of 1e-30 would make every
// conversion through it round to zero — money silently vanishing, which is the one failure this
// whole design exists to prevent. The ceiling sits well above the largest real rate there is
// (IRR is ~42,000 and LBP ~89,000 to the dollar), so nothing legitimate is anywhere near it.
const RATE_MIN = 1e-9;
const RATE_MAX = 1e12;

// A live response from this provider carries 160+ quotes. A response carrying six is not a
// cheaper day, it is an incident — and writing it would REPLACE a working table and take PEN
// off the screen for everybody on the trip. 32 is far below any real answer and far above a
// truncated one, so it separates the two cases without ever being a judgement call.
const MIN_QUOTES = 32;

// Rows per INSERT statement. D1 caps a single statement at 100 bound parameters; each statement
// below binds three shared values (base, fetched_at, next_at) plus two per row, so 40 rows is
// 83 parameters — comfortably inside the cap with room for the shape to change. 162 quotes then
// cost five statements instead of 162, in one batch, in one transaction.
const CHUNK = 40;

// ── the never-fetched table ─────────────────────────────────────────────────────────────
// fetched_at === 0 is the client's signal for "we have never had a rate", and public/js/split.js
// renders it as real copy — a per-currency settle-up that needs no rate at all, under the line
// "No exchange rates yet — connect once to fetch them." It is a state, not an error, and it is
// never a zero standing in for a number.
const emptyTable = () => ({ base: BASE, rates: {}, fetched_at: 0, next_at: 0 });

const usableRate = (v) => Number.isFinite(v) && v >= RATE_MIN && v <= RATE_MAX;

// ── in-isolate coalescing ───────────────────────────────────────────────────────────────
// Module scope in a Pages Function is per-isolate and lives as long as the isolate does. That
// makes these two a best-effort optimisation and NOT a correctness mechanism — nothing below
// is wrong if a second isolate fetches at the same moment, because the write is idempotent and
// transactional. What they buy is the common case: several members opening the app inside the
// same minute produce one outbound request rather than one each.
let inflight = null;
let lastAttemptMs = 0;

/**
 * Is this table due for a refresh? A table with no rates is always due; one whose next_at has
 * passed is due; one whose next_at is missing is due, because a table we cannot date is a table
 * we cannot trust to be current.
 *
 * NOTE WHAT THIS IS NOT: it is not a reason to stop converting. Four days offline on the trail
 * means the rates are four days old and the screen
 * converts anyway and labels the age. Staleness decides whether to ASK for new numbers. It
 * never decides whether to show the ones we have.
 */
export function isStale(fx, atSec = nowSec()) {
  if (!fx || !fx.fetched_at) return true;
  if (!fx.next_at) return true;
  return atSec >= fx.next_at;
}

/**
 * The cached table, in the exact shape store.js's fxOf() normalises and public/js/money.js's
 * convert() reads. EXPORTED FOR THE SNAPSHOT: functions/api/trip.js should call this beside
 * listPlaces()/listEvents() and put the result on GET /api/trip's body as `fx`, so the one
 * request a phone gets in before the signal goes carries the rates with everything else.
 *
 * Every failure mode answers the never-fetched table rather than throwing, because the caller
 * with the most to lose is that snapshot: a D1 hiccup on the rates must never be able to take
 * down the request that delivers the entire trip.
 *
 * TWO DETAILS THAT ARE NOT INCIDENTAL:
 *
 *   * a row whose rate no longer passes usableRate() is SKIPPED on the way out, not just on
 *     the way in. The validation on write is the real guard; this is the second one, and it is
 *     here because the table outlives the code that wrote it.
 *
 *   * if nothing survives that filter, the answer is the NEVER-FETCHED table, not a dated table
 *     with an empty map. The difference is what the screen says: `fetched_at: 0` prints
 *     "No exchange rates yet — connect once to fetch them", while a dated empty table would
 *     print "Converted at rates from 2 hours ago." over a settle-up that converted nothing.
 *     The second one is a lie, and it is the kind that looks like a bug in the maths.
 */
export async function readFxTable(env) {
  if (!env || !env.DB) return emptyTable();
  try {
    const rs = await env.DB.prepare(
      "SELECT quote, rate, fetched_at, next_at FROM fx_rates WHERE base = ?1"
    ).bind(BASE).all();

    const rows = (rs && rs.results) || [];
    const rates = {};
    let fetched = 0;
    let next = 0;
    let n = 0;

    for (const r of rows) {
      const code = String(r.quote || "").toUpperCase();
      const rate = Number(r.rate);
      if (code === BASE || !CODE_RE.test(code) || !usableRate(rate)) continue;
      rates[code] = rate;
      n++;
      // Every row of one fetch carries the same pair, so these two loops are normally reading
      // the same numbers 162 times. They are computed rather than taken off row zero because
      // "normally" is not "always": a half-migrated or hand-edited table should report the
      // NEWEST fetch it holds and the SOONEST it is due, which is the conservative reading in
      // both directions.
      const f = Number(r.fetched_at) || 0;
      const x = Number(r.next_at) || 0;
      if (f > fetched) fetched = f;
      if (x && (!next || x < next)) next = x;
    }

    if (!n || !fetched) return emptyTable();
    return { base: BASE, rates, fetched_at: fetched, next_at: next };
  } catch (e) {
    console.warn(JSON.stringify({ fx_read_failed: errorLine(e, env) }));
    return emptyTable();
  }
}

/**
 * Ask the provider and, if the answer is good, replace the table. NEVER THROWS and never
 * rejects: it answers { ok, wrote, reason } so that a caller inside ctx.waitUntil() cannot
 * turn a third party's bad afternoon into an unhandled rejection in our logs, and so that a
 * caller who is awaiting it can say something true about what happened.
 *
 * `wrote: false` with `ok: true` is the ordinary throttled case and is not a failure — it means
 * "somebody already asked inside the last minute, read the table".
 *
 * EXPORTED because GET /api/trip has the job of kicking it through
 * ctx.waitUntil() when the table is due. Prefer kickRates() below for that: it holds the
 * "never awaited, never allowed to throw" part so no caller has to remember it.
 */
export async function fetchRates(env) {
  if (!env || !env.DB) return { ok: false, wrote: false, reason: "no database" };

  // A request already in flight in this isolate: join it rather than starting a second one.
  if (inflight) return inflight;

  const since = Date.now() - lastAttemptMs;
  if (lastAttemptMs && since < MIN_ATTEMPT_GAP_MS) {
    return { ok: true, wrote: false, reason: "throttled" };
  }
  lastAttemptMs = Date.now();

  inflight = (async () => {
    try {
      const got = await callProvider(env);
      if (got.bad) {
        // Deliberately console.warn and not an error: a provider being unreachable is an
        // expected condition, the table we already hold keeps converting, and the screen
        // already tells the user how old it is. Nothing here is broken.
        console.warn("[fx] provider rejected:", got.bad);
        return { ok: false, wrote: false, reason: got.bad };
      }
      await writeRates(env, got.rates, got.fetchedAt, got.nextAt);
      return { ok: true, wrote: true, reason: "", quotes: Object.keys(got.rates).length };
    } catch (e) {
      // The only way to get here is a D1 failure on the write — callProvider() catches its own.
      console.warn(JSON.stringify({ fx_write_failed: errorLine(e, env) }));
      return { ok: false, wrote: false, reason: "write failed" };
    }
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * Fire a refresh in the background if the table is due, and NEVER let it touch the response.
 * This is the shape asked for in one call, so that the one request which
 * absolutely has to succeed on hotel wifi — GET /api/trip — does not get to depend on a third
 * party being up. In functions/api/trip.js it reads:
 *
 *     const fx = await readFxTable(ctx.env);
 *     kickRates(ctx, fx);
 *
 * and `fx` then goes on the snapshot body. Pass the table you already read; a refresh that is
 * not due must not cost a second query.
 *
 * ctx.waitUntil is guarded because it is not present in every execution context this code can
 * find itself in (a unit harness, a future direct invocation); without it the fetch simply
 * happens without an extension of the request's lifetime, which is the same outcome minus the
 * guarantee. Either way the caller's response is already on its way.
 */
export function kickRates(ctx, fx) {
  if (!ctx || !ctx.env) return;
  if (!isStale(fx)) return;
  const p = fetchRates(ctx.env);        // cannot reject; see above
  try {
    if (typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  } catch (e) {
    console.warn(JSON.stringify({ fx_wait_unavailable: errorLine(e, ctx.env) }));
  }
}

// ── the provider call ───────────────────────────────────────────────────────────────────

/**
 * The ONLY function that knows who publishes the numbers. Returns either
 * `{ rates, fetchedAt, nextAt }` — normalised, validated, USD-based, USD itself removed — or
 * `{ bad: "<why>" }`. It never throws.
 */
async function callProvider(env) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let body;
  try {
    const res = await fetch(providerUrl(env), {
      signal: ctl.signal,
      headers: { Accept: "application/json" },
      // Requirement: this endpoint has to be CHEAP. The D1 table below is the real cache — it
      // is durable, it is what rides the snapshot, and it is what still converts on day four
      // with no signal. This is the second, smaller one, on the outbound leg: Cloudflare holds
      // a successful provider response in the colo's cache for fifteen minutes, so a burst
      // that slips past the in-isolate coalescing above still reaches the provider once.
      // cacheTtlByStatus rather than cacheTtl, because caching a 500 for fifteen minutes would
      // turn one bad moment upstream into a quarter of an hour of guaranteed failure.
      cf: { cacheTtlByStatus: { "200-299": 900, "400-599": 0 } },
    });
    if (!res.ok) return { bad: `provider HTTP ${res.status}` };
    body = await res.json();
  } catch (e) {
    // AbortError is the timeout; everything else is DNS, TLS, a socket, or a body that is not
    // JSON. None of them is distinguishable from the caller's point of view and none of them
    // changes what we do, which is nothing.
    return { bad: e && e.name === "AbortError" ? "provider timeout" : `provider unreachable: ${e && e.message}` };
  } finally {
    clearTimeout(timer);
  }

  if (!body || typeof body !== "object") return { bad: "provider sent no object" };
  if (body.result !== "success") return { bad: `provider result "${body.result}"` };

  // THE BASE CHECK IS NOT A FORMALITY. Every rate in the table is stored and read as "one USD
  // buys this much", and a response quoted against EUR would be a table of numbers that look
  // exactly right and are wrong by a factor of the euro — silently, on every screen, with no
  // way for anybody to notice except by knowing what a sol is worth.
  if (String(body.base_code || "").toUpperCase() !== BASE) {
    return { bad: `provider base "${body.base_code}"` };
  }
  const src = body.rates;
  if (!src || typeof src !== "object") return { bad: "provider sent no rates" };

  const rates = {};
  let n = 0;
  for (const key of Object.keys(src)) {
    const code = String(key).toUpperCase();
    if (!CODE_RE.test(code)) continue;
    // USD is dropped on purpose. The base buys one of itself, convert() hard-codes that
    // (`from === "USD" ? 1 : rates[from]`) and never reads the map for it, and the FxTable in
    // The map is documented as not containing it. Storing it would be one row
    // of tautology that some later reader would eventually treat as meaningful.
    if (code === BASE) continue;
    const v = Number(src[key]);
    // ALL OR NOTHING, and it is worth saying why the softer rule was
    // not taken. Skipping the one bad entry and keeping the other 161 sounds kinder, but we
    // cannot tell "the provider temporarily cannot price this one currency" from "this response
    // is corrupt", and the second one would overwrite a table that currently works. Refusing
    // the whole response keeps the last good table — which still converts — and the failure is
    // not silent: fetched_at stops moving and the settle sheet starts saying "Converted at
    // rates from 4 days ago." out loud, which is exactly the signal a person needs.
    if (!usableRate(v)) return { bad: `unusable rate for ${code}` };
    rates[code] = v;
    n++;
  }
  if (n < MIN_QUOTES) return { bad: `only ${n} usable quotes` };

  const now = nowSec();
  const raw = Number(body.time_next_update_unix) || 0;
  let nextAt = raw > now ? raw : now + FALLBACK_TTL_S;
  if (nextAt > now + MAX_TTL_S) nextAt = now + MAX_TTL_S;

  // fetched_at is WHEN WE FETCHED IT, which is what migrations/0011_purchases.sql says the
  // column holds and what store.js and split.js both read it as. It is deliberately NOT the
  // provider's own `time_last_update_unix`, even though that would be the more literal answer
  // to "how old is this number": this column is the OFFLINE CLOCK. "Converted at rates from 4
  // days ago" has to mean "this phone has not reached the internet in four days", because that
  // is the sentence a person on the trail can act on. The provider's publish time would make
  // the same line read "from 14 hours ago" on a phone that has been in a tent since Tuesday.
  return { rates, fetchedAt: now, nextAt };
}

// ── the write ───────────────────────────────────────────────────────────────────────────

/**
 * Replace the table, wholesale, in one transaction.
 *
 * DELETE-then-INSERT rather than upserts, and the difference
 * matters in exactly one case: a currency the provider STOPS publishing. Upserts would leave
 * its row behind with an old rate and an old fetched_at, and readFxTable() would then hand the
 * client a table whose header says "fetched five minutes ago" over one number that is a month
 * out of date — the one shape this file must never produce. "Server-owned, replaced wholesale"
 * is what the migration's own comment and store.js's cache comment both promise; this makes it
 * literally true. The spec's concern was that the table must never be half a fetch, and that is
 * satisfied by the batch, which D1 runs as a single implicit transaction: no reader ever sees
 * the moment between the DELETE and the last INSERT.
 *
 * The statement TEXT is assembled from loop indices only — `?4`, `?5`, `?6` … — and every value
 * without exception arrives through bind(). Nothing a third party sent us is ever concatenated
 * into SQL, which is the rule this file has to keep more carefully than any other in the repo,
 * because it is the only one whose input comes from outside.
 */
async function writeRates(env, rates, fetchedAt, nextAt) {
  const quotes = Object.keys(rates).sort();
  const stmts = [env.DB.prepare("DELETE FROM fx_rates WHERE base = ?1").bind(BASE)];

  for (let i = 0; i < quotes.length; i += CHUNK) {
    const slice = quotes.slice(i, i + CHUNK);
    // ?1 base, ?2 fetched_at, ?3 next_at, then (quote, rate) from ?4 upward.
    const tuples = slice.map((_, k) => `(?1, ?${4 + k * 2}, ?${5 + k * 2}, ?2, ?3)`).join(", ");
    const binds = [BASE, fetchedAt, nextAt];
    for (const q of slice) binds.push(q, rates[q]);
    stmts.push(env.DB.prepare(
      "INSERT INTO fx_rates (base, quote, rate, fetched_at, next_at) VALUES " + tuples
    ).bind(...binds));
  }

  await env.DB.batch(stmts);
}

// ── handlers ────────────────────────────────────────────────────────────────────────────

/**
 * How long a client may hold this answer without asking again. The table provably does not
 * change until next_at, so that is the honest number; it is capped at an hour so that a
 * provider promising a week cannot pin a browser's copy for a week, and it is `private`
 * because this response is behind the session gate in functions/_middleware.js and must never
 * be held by a shared cache.
 *
 * The never-fetched table gets `no-store` instead: that answer is the one most likely to be
 * wrong within seconds, since the request that produced it has probably just kicked the fetch
 * that will replace it.
 *
 * store.js never sees any of this — it sends `cache: "no-store"` on every request it makes, on
 * purpose. This is for curl, for a future caller, and because an endpoint that does not say how
 * long its answer is good for is an endpoint that gets asked too often.
 */
function cacheControl(fx) {
  if (!fx.fetched_at) return "no-store";
  const left = Math.max(0, (fx.next_at || 0) - nowSec());
  return `private, max-age=${Math.min(left, 3600)}`;
}

/**
 * GET /api/fx — the table as it stands, plus a background refresh if it is due.
 *
 * The table is the site's, not a trip's: one set of rates serves every trip, so this address
 * has no trip in it and answers any signed-in account (the gate refuses everyone else).
 */
export async function onRequestGet(ctx) {
  const fx = await readFxTable(ctx.env);
  kickRates(ctx, fx);
  return json({ fx }, 200, { "Cache-Control": cacheControl(fx) });
}

/**
 * POST /api/fx/refresh — "I just got signal, show me my totals."
 *
 * This is the one path that AWAITS the provider, and it exists because GET /api/trip's refresh
 * is fired through waitUntil(): without this route the numbers would arrive on the NEXT
 * snapshot, up to HEARTBEAT_MS (90 s) later, which is a long time to stare at a screen you just
 * tapped a button on. public/js/store.js's refreshRates() calls it on the Split screen's mount
 * and from the settle sheet's "Fetch rates" button.
 *
 * IT ANSWERS WITH THE TABLE EVEN WHEN THE PROVIDER FAILED, and that is the important part.
 * Rates from three days ago still convert (never block, never hide a number behind staleness),
 * so a failed refresh on a phone that already holds a table is a
 * 200 with real numbers in it — the person tapped a button and got their totals, which is what
 * they wanted. 503 is reserved for the one case where we genuinely have nothing to give: the
 * provider is unreachable AND we have never held a rate. Even then the body still carries the
 * never-fetched table, so store.js and the settle sheet take the same branch they would have
 * taken anyway and the screen falls back to the per-currency settle-up, which needs no rate at
 * all and is exact.
 *
 * NOT QUEUED on the client, and it must stay that way: it writes nothing that belongs to
 * anybody, so there is nothing to replay and nothing to fold.
 */
export async function refreshFx(ctx) {
  const r = await fetchRates(ctx.env);
  const fx = await readFxTable(ctx.env);

  if (Object.keys(fx.rates).length) {
    // No Cache-Control beyond the default here: this is the explicit "ask now" path, and a
    // client that just asked to be told again should never be answered out of its own cache.
    return json({ fx }, 200, { "Cache-Control": "no-store" });
  }
  return err(503, "rates unavailable", { fx, detail: r.reason || "", reason: "The exchange rates can't be fetched right now. Each currency is settled in its own until they can." });
}

/**
 * Bare /api/fx with a method we do not serve. Pages would otherwise fall through to the asset
 * server, which answers 405 with a text/html body — and store.js's req() correctly reads a
 * non-JSON answer as a captive portal, calls setNet(false), and puts the shell's netpill on
 * "Offline" for an online phone until the next successful request clears the latch. That is
 * measured, not inferred: it is exactly what POST /api/fx/refresh did before this file existed.
 * Answering JSON here means a wrong method is a wrong method and nothing more.
 */
export async function onRequest(ctx) {
  const m = ctx.request.method.toUpperCase();
  if (m === "GET" || m === "HEAD") return onRequestGet(ctx);
  return err(405, "method not allowed", { allow: "GET" });
}

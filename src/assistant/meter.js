// The assistant's meter (docs/model.md §20; migration 0031): the trip's host pays, out of their plan's
// monthly allowance, in what the model really cost, as Lexicommons meters its own (its src/ai-hosted.ts),
// moved from the account that calls to the host whose trips it is called on.
//
//   * Before a call: ONE conditional insert lets it out, only while the host's month (every call of theirs
//     in it: settled at its cost, out or dead at its worst case) plus this call's worst case fits the
//     allowance, and only while no call of this trip is out (the partial unique index of 0031). So the
//     budget holds exactly, two of a host's trips run side by side, and one trip asks one thing at a time.
//   * After it: settled at the provider's reported cost (usage.cost), else its record of the call, else the
//     worst case. A refusal before anything was made costs nothing.
//   * A call whose Worker died (out past busy_until) is marked dead by the host's next call and counts at
//     its worst case; if it settles after all, it counts at its cost: the charge put right, no arithmetic.
//   * The ledger is these rows: tokens, cost, model, trip, who asked. Never a word.
//
// A member learns only whether the assistant has room this month, or the day it's back (roomFor); the
// host sees the numbers per trip, never per person (hostMonth).

import { entitlement, grantOf, planOffered } from "../billing/plan.js";
import { nowSec } from "../accounts/util.js";

export const METER = {
  busySeconds: 180,                    // a call this old with no settling is taken as dead
  busyWaits: [250, 500, 1000],         // a trip's ask while its last still settles: asked again after these (ms)
};

export class AssistantError extends Error {
  constructor(message, status, error, extra = {}) { super(message); this.status = status; this.error = error; this.extra = extra; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The calendar month (UTC) a moment is in, "YYYY-MM". */
export const monthOf = (sec) => new Date(sec * 1000).toISOString().slice(0, 7);

/** The first second of the next month (UTC): when the allowance comes back. */
export function nextMonth(sec) {
  const d = new Date(sec * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
}

/** The model and its prices, from the vars: { model, input, output } (micro-dollars a token), or null. */
export function modelOf(env) {
  const input = Number(env.ASSISTANT_PRICE_INPUT), output = Number(env.ASSISTANT_PRICE_OUTPUT);
  if (!env.ASSISTANT_MODEL || !(input > 0) || !(output > 0)) return null;
  return { model: String(env.ASSISTANT_MODEL), input, output };
}

/**
 * The model a refused call goes to once more, and its prices: { model, input, output }, or null when none is set (or
 * it is the first model itself). Its reasoning level is its own (provider.js effortOf).
 */
export function fallbackOf(env) {
  const input = Number(env.ASSISTANT_FALLBACK_PRICE_INPUT), output = Number(env.ASSISTANT_FALLBACK_PRICE_OUTPUT);
  if (!env.ASSISTANT_FALLBACK_MODEL || !(input > 0) || !(output > 0)) return null;
  if (String(env.ASSISTANT_FALLBACK_MODEL) === String(env.ASSISTANT_MODEL ?? "")) return null;
  return { model: String(env.ASSISTANT_FALLBACK_MODEL), input, output };
}

/** Whether this site offers the assistant: the plan, switched on, the provider's key, a model and its prices. */
export const assistantOffered = (env) => planOffered(env) && env.ASSISTANT_ENABLED === "true" && assistantReady(env);
/** The provider's key and a model with its prices: what the assistant needs to run at all. */
const assistantReady = (env) => Boolean(env.OPENROUTER_API_KEY) && modelOf(env) !== null;

/**
 * Whether the assistant is there for the trips one host hosts: where the site offers it, for every host; and for a host
 * whose plan the operator gave (0046 plan_grants), whether or not the site offers it, once the key and a model are set.
 * The assistant is then on that host's trips for everyone on them, as the plan's is; nobody else's trips change.
 */
export async function assistantFor(env, hostId) {
  if (assistantOffered(env)) return true;
  return assistantReady(env) && Boolean(await grantOf(env, hostId));
}

/**
 * The worst a call can cost, in micro-dollars: every character it sends a token at the input price (its
 * messages and its tools' definitions), and the most it may write at the output price.
 */
export function worstCase(env, { messages, tools = [], maxTokens }, m = modelOf(env)) {
  const sent = JSON.stringify(messages ?? []).length + JSON.stringify(tools ?? []).length;
  return Math.ceil(sent * m.input + maxTokens * m.output + searchWorst(tools, sent, m));
}

/**
 * The worst a document's transcription can cost (src/assistant/files.js): its words to the model at the input price, each
 * page taken as `pageTokens` (a scanned page or a picture is an image, whatever its bytes; the file's base64 isn't
 * counted as characters), and the most it may write.
 */
export function worstCaseDocument(env, { messages, pages, pageTokens, maxTokens }, m = modelOf(env)) {
  const words = (messages ?? []).flatMap((x) => (Array.isArray(x.content) ? x.content : [{ text: x.content }])).reduce((n, part) => n + String(part?.text ?? "").length, 0);
  return Math.ceil((words + pages * pageTokens) * m.input + maxTokens * m.output);
}

/** What a web search costs at most, in micro-dollars, on OpenRouter's Exa engine (its pricing, 20 Nov 2026). */
export const SEARCH_MICRO = 7000;

/**
 * The most a call's web searches can add (the openrouter:web_search server tool, when the site offers it):
 * each search's own price, the text it brings back (max_results × max_characters, every character a token at
 * the input price), and the call's own words read again, since OpenRouter runs the model once more after
 * each search. Nothing when no search is offered.
 */
export function searchWorst(tools, sent, m) {
  const search = (tools ?? []).find((t) => t?.type === "openrouter:web_search");
  if (!search) return 0;
  const p = search.parameters ?? {};
  const uses = Number(p.max_uses) || 1, results = Number(p.max_results) || 5, chars = Number(p.max_characters) || 2000;
  return uses * (SEARCH_MICRO + (results * chars + sent) * m.input);
}

// What a host's month holds: settled calls at their cost, every other at its worst case.
const MONTH_SUM = "COALESCE(SUM(CASE WHEN state = 'settled' THEN cost ELSE worst END), 0)";

/**
 * The host's allowance this month, from their plan: { allowance } or the refusal, in the words the person
 * asking may hear (a member never learns the host's plan, only that the assistant isn't on).
 */
export async function allowanceFor(env, hostId) {
  if (!(await assistantFor(env, hostId))) throw new AssistantError("This site doesn't offer the assistant.", 404, "not offered");
  const plan = await entitlement(env, hostId);
  if (!plan?.active) throw new AssistantError("The assistant comes with the trip's host's plan, and it isn't on for this trip.", 402, "no plan");
  if (plan.held) throw new AssistantError("The assistant is paused on this trip for now.", 402, "held");
  return plan.allowanceMicro;
}

/**
 * Lets a call out, or says why not (AssistantError "busy" 429, "used up" 402 with the day it's back).
 * `call` names the host, the trip, who asks, the feature and the worst case. Answers the call's row id.
 */
export async function reserve(env, { hostId, tripId, userId, feature, worst, allowance, model }, now = nowSec()) {
  const month = monthOf(now);
  for (let tries = 0; ; tries++) {
    const at = now + tries;   // a retry is a moment later; busy_until is in whole seconds
    // A call of this host's out past its time is dead: it keeps counting at its worst case.
    await env.DB.prepare("UPDATE ai_calls SET state = 'dead' WHERE host_id = ?1 AND state = 'out' AND busy_until < ?2").bind(hostId, at).run();
    const id = crypto.randomUUID();
    let put = null;
    try {
      put = await env.DB.prepare(
        `INSERT INTO ai_calls (id, host_id, trip_id, user_id, month, feature, state, worst, started_at, busy_until, model)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'out', ?7, ?8, ?9, ?10
         WHERE NOT EXISTS (SELECT 1 FROM ai_calls WHERE trip_id = ?3 AND state = 'out')
           AND (SELECT ${MONTH_SUM} FROM ai_calls WHERE host_id = ?2 AND month = ?5) + ?7 <= ?11`,
      ).bind(id, hostId, tripId, userId, month, feature, worst, at, at + METER.busySeconds, model, allowance).run();
    } catch (e) {
      // Two at once on one trip: the index refused the second. It is busy, as below.
      if (!/UNIQUE|constraint/i.test(String(e?.message ?? e))) throw e;
    }
    if (put?.meta?.changes) return { id, hostId, tripId, month, worst };
    const busy = await env.DB.prepare("SELECT 1 AS yes FROM ai_calls WHERE trip_id = ?1 AND state = 'out' AND busy_until >= ?2").bind(tripId, at).first();
    if (!busy) break;                 // nothing out on the trip: the month doesn't hold it
    const wait = METER.busyWaits[tries];
    if (wait === undefined) throw new AssistantError("The assistant is answering someone on this trip. Ask again in a moment.", 429, "busy");
    await sleep(wait);
  }
  throw usedUp(now);
}

/** The refusal when the host's month is used up: in words, with the day it's back, and no number. */
export function usedUp(now = nowSec()) {
  const back = nextMonth(now);
  const day = new Date(back * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).replace(" ", " ");
  return new AssistantError(`The assistant has used this month's room on this trip's plan. It's back on ${day}.`, 402, "used up", { back });
}

const count = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/**
 * Settles a call at what it cost (micro-dollars; null: its worst case), with its tokens. A call taken as
 * dead meanwhile settles all the same, and counts at its cost from then on.
 */
export async function settle(env, call, { cost, usage = null, generation = null, model = null }, now = nowSec()) {
  const micro = cost === null || cost === undefined ? call.worst : Math.max(0, Math.round(cost));
  await env.DB.prepare(
    `UPDATE ai_calls SET state = 'settled', cost = ?2, settled_at = ?3, prompt_tokens = ?4, cached_tokens = ?5, completion_tokens = ?6, generation_id = ?7,
       model = COALESCE(?8, model)
     WHERE id = ?1 AND state IN ('out', 'dead')`,
  ).bind(call.id, micro, now, count(usage?.prompt_tokens), count(usage?.prompt_tokens_details?.cached_tokens), count(usage?.completion_tokens), generation, model).run();
  return micro;
}

/** A call going once more, to the fallback: its record names that model, and it is out for a full call's time again. */
export async function retryOn(env, call, model, now = nowSec()) {
  await env.DB.prepare("UPDATE ai_calls SET model = ?2, busy_until = ?3 WHERE id = ?1 AND state = 'out'")
    .bind(call.id, model, now + METER.busySeconds).run();
}

/** What the host's month holds and its calls out: { month, used, out, back } (micro-dollars). */
async function monthUse(env, hostId, now) {
  const month = monthOf(now);
  const r = await env.DB.prepare(`SELECT ${MONTH_SUM} AS used, COALESCE(SUM(CASE WHEN state = 'out' THEN 1 ELSE 0 END), 0) AS out FROM ai_calls WHERE host_id = ?1 AND month = ?2`)
    .bind(hostId, month).first();
  return { month, used: Number(r?.used) || 0, out: Number(r?.out) || 0, back: nextMonth(now) };
}

/**
 * What a member of a trip may know: whether the assistant has room this month, or the day it's back.
 * { offered, on, room, back } and never a number.
 */
export async function roomFor(env, hostId, now = nowSec()) {
  if (!(await assistantFor(env, hostId))) return { offered: false };
  const plan = await entitlement(env, hostId);
  if (!plan?.active || plan.held) return { offered: true, on: false };
  const use = await monthUse(env, hostId, now);
  return { offered: true, on: true, room: use.used < plan.allowanceMicro, back: use.used < plan.allowanceMicro ? null : use.back };
}

/**
 * What the host may know: the month's allowance, what is used, and per trip they host (by trip, never by
 * person): { month, allowance, used, back, trips: [{ trip_id, used, calls }] }.
 */
export async function hostMonth(env, hostId, now = nowSec()) {
  const plan = await entitlement(env, hostId);
  const use = await monthUse(env, hostId, now);
  const trips = await env.DB.prepare(
    `SELECT trip_id, ${MONTH_SUM} AS used, COUNT(*) AS calls FROM ai_calls WHERE host_id = ?1 AND month = ?2 GROUP BY trip_id ORDER BY used DESC`,
  ).bind(hostId, use.month).all();
  return {
    month: use.month, allowance: plan?.active ? plan.allowanceMicro : 0, used: use.used, back: use.back,
    trips: (trips.results ?? []).map((t) => ({ trip_id: t.trip_id, used: Number(t.used) || 0, calls: Number(t.calls) || 0 })),
  };
}

/** The account's opaque tag for the provider: random, made once, never its id. */
export async function tagFor(env, userId, now = nowSec()) {
  const held = await env.DB.prepare("SELECT tag FROM ai_tags WHERE user_id = ?1").bind(userId).first();
  if (held) return held.tag;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const tag = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("INSERT INTO ai_tags (user_id, tag, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO NOTHING").bind(userId, tag, now).run();
  return (await env.DB.prepare("SELECT tag FROM ai_tags WHERE user_id = ?1").bind(userId).first())?.tag ?? tag;
}

/**
 * What deleting an account does here: its tag goes, and its own ledger as a host (its trips were handed
 * over first, §4); its asks on other hosts' trips stay in their ledgers without who asked.
 */
export const DELETE_STATEMENTS = (db, userId) => [
  db.prepare("DELETE FROM ai_tags WHERE user_id = ?1").bind(userId),
  db.prepare("DELETE FROM ai_calls WHERE host_id = ?1").bind(userId),
  db.prepare("UPDATE ai_calls SET user_id = NULL WHERE user_id = ?1").bind(userId),
];

// The assistant's model, through OpenRouter (docs/model.md §20), metered by src/assistant/meter.js.
//
// Every request routes only to providers that keep nothing (zero data retention, no data collection) and
// that take every parameter it sends, and names the account by its opaque tag (meter.js tagFor), never its
// id or name. Not streamed: a turn's answer (its words or the tools it calls) is read whole here, with its
// usage, and settled before anything is answered.
//
//   ask(env, { hostId, tripId, userId, feature, messages, tools, maxTokens })
//     -> { message, usage, cost }   or throws AssistantError (not offered, no plan, held, busy, used up, provider)
//
// How hard the model thinks: ASSISTANT_REASONING_EFFORT, one of OpenRouter's levels (EFFORTS), sent as
// reasoning: { effort }. Empty (the default) sends no reasoning field, so each model thinks as its own
// default has it. Its thinking counts against max_tokens: OpenRouter gives it a share of them by level.
//
// Each call prints one line to the Worker's log, { assistant_call: { status, finish_reason, reasoning_tokens,
// error } }: how it ended, and on a refusal OpenRouter's own words for why (its code and provider, and its message
// unless that quotes what was sent), cut short. Never a word of the conversation, the key or a header.

import { onThisMachine } from "../log.js";
import { AssistantError, allowanceFor, fallbackOf, modelOf, reserve, retryOn, settle, tagFor, worstCase, worstCaseDocument } from "./meter.js";

export const PROVIDER = {
  timeoutMs: 90_000,
  lookupWaits: [2_000, 5_000, 10_000],   // a call answered without its cost: OpenRouter's record of it, asked after these
  errorChars: 300,                       // OpenRouter's words for a refusal, as much as the log keeps
  rawChars: 200,                         // the provider's own error (metadata.raw), its first characters, when safe
};

/** OpenRouter's reasoning levels, most to least (its docs, reasoning tokens): what ASSISTANT_REASONING_EFFORT may be. */
export const EFFORTS = ["max", "xhigh", "high", "medium", "low", "minimal", "none"];

/** The reasoning level this site sends, or null: none set (or one OpenRouter doesn't name), so no field is sent. The
 *  fallback model has its own (ASSISTANT_FALLBACK_REASONING_EFFORT): a level right for one model may not be for another. */
export const effortOf = (env, fallback = false) => {
  const e = String((fallback ? env.ASSISTANT_FALLBACK_REASONING_EFFORT : env.ASSISTANT_REASONING_EFFORT) ?? "").trim();
  return EFFORTS.includes(e) ? e : null;
};

/** The models a call may go to, in turn: the site's own, then its fallback when one is set. */
export const modelsOf = (env) => {
  const fb = fallbackOf(env);
  return [{ ...modelOf(env), effort: effortOf(env), fallback: false }, ...(fb ? [{ ...fb, effort: effortOf(env, true), fallback: true }] : [])];
};

/** The field the loop keeps on an assistant message it hands back: the model that wrote it. Never sent. */
export const WROTE = "wrote_by";

/**
 * Whether a refusal is the provider's own, so the fallback may answer instead: a 5xx; no endpoint for the model (404);
 * a 400, 408 or 429 the provider sent (OpenRouter names the provider, or says "Provider returned error"). Never our own
 * key or credit (401, 402), a refusal of what was asked (403), a call cut short, or an answer (a 200) that holds an
 * error: that one may have been charged, so it is settled as an answer, as before.
 */
export function providerRefused(status, body) {
  if (status >= 500 || status === 404) return true;
  const e = body?.error;
  const theirs = typeof e?.metadata?.provider_name === "string" || /provider returned error/i.test(String(e?.message ?? ""));
  return [400, 408, 429].includes(status) && theirs;
}

/**
 * The turn as one model is sent it: reasoning_details only on the answers that model wrote itself (another model's are
 * in another provider's format, which it may refuse), and the WROTE mark never.
 */
export function messagesFor(messages, model) {
  return (messages ?? []).map((m) => {
    if (!m || m.role !== "assistant" || !(WROTE in m)) return m;
    const { [WROTE]: by, reasoning_details: details, ...rest } = m;
    return by === model && details ? { ...rest, reasoning_details: details } : rest;
  });
}

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const apiBase = (env) => (LOCAL.test(env.PUBLIC_ORIGIN ?? "") && env.OPENROUTER_API_BASE ? env.OPENROUTER_API_BASE : "https://openrouter.ai");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dollarsToMicro = (d) => (typeof d === "number" && Number.isFinite(d) && d >= 0 ? d * 1e6 : null);

/** A chat request's body: the model, the turn, its tools, and the routing that keeps nothing. */
export function requestBody(env, { messages, tools, maxTokens, tag, model = null, toolChoice = "auto" }) {
  const m = model ?? { ...modelOf(env), effort: effortOf(env) };
  return {
    model: m.model,
    messages: messagesFor(messages, m.model),
    // "none" on an ask's last step: the tools stay offered (a provider may refuse tool calls in the history without
    // them), and the model answers in words.
    ...(tools?.length ? { tools, tool_choice: toolChoice } : {}),
    max_tokens: maxTokens,
    ...(m.effort ? { reasoning: { effort: m.effort } } : {}),
    usage: { include: true },
    provider: { zdr: true, data_collection: "deny", require_parameters: true },
    user: tag,
  };
}

/**
 * A refusal as the site's log may hold it: OpenRouter's code and the provider's name, never its words or the provider's
 * raw error, which can quote what was sent (a title shorter than refusalText's QUOTE_CHARS passes its filter). On this
 * machine, refusalText's words, as the bake-off records them.
 */
export function refusalForLog(env, body, sent) {
  if (onThisMachine(env)) return refusalText(body, sent);
  const e = body?.error;
  const code = typeof e === "object" && e && (typeof e.code === "number" || typeof e.code === "string") ? `code ${e.code}` : null;
  const provider = typeof e?.metadata?.provider_name === "string" ? e.metadata.provider_name : null;
  return [code, provider].filter(Boolean).join(" | ") || null;
}

/** One line to the Worker's log for each call: how it ended, never what was said. */
function logCall({ status, finish = null, reasoning = null, error = null, model = null }) {
  // The fallback's lines name it; the first model's are as they always were.
  console.log(JSON.stringify({ assistant_call: { status, finish_reason: finish, reasoning_tokens: reasoning, error, ...(model ? { fallback: model } : {}) } }));
}

/** How long a run of the request's own text may be before OpenRouter's words are taken to quote it. */
const QUOTE_CHARS = 16;
const squash = (x) => String(x ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Every piece of text the request sent: each message's words, each tool call's arguments, each tool's description. */
export function sentText(messages = [], tools = []) {
  const parts = [];
  for (const m of messages ?? []) {
    parts.push(typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
    for (const c of m?.tool_calls ?? []) parts.push(c?.function?.arguments ?? "");
  }
  for (const t of tools ?? []) parts.push(JSON.stringify(t ?? ""));
  return squash(parts.join("\n"));
}

/** Whether text (squashed) quotes what was sent: a pointer into the messages, or any run of QUOTE_CHARS of the request. */
function quotesSent(text, sent) {
  if (/messages\s*\[\s*\d+/.test(text)) return true;
  for (let i = 0; i + QUOTE_CHARS <= text.length; i++) {
    const run = text.slice(i, i + QUOTE_CHARS);
    if (/\S{3}/.test(run) && sent.includes(run)) return true;
  }
  return false;
}

/** Whether text could carry a key or a header: a key's shape, a bearer, a header's name, or a long run that could be a secret. */
const SECRETISH = /\bsk-[a-z0-9_-]{6,}|\bbearer\b|authori[sz]ation|api[-_ ]?key|x-[a-z0-9-]+\s*:|cookie|referer|\b[a-z0-9_-]{32,}\b/i;

/**
 * OpenRouter's words for a refusal, from its answer's body: its error's message, code and provider, cut short; then
 * the provider's own error (metadata.raw), its first PROVIDER.rawChars, since some providers' refusals (Google's 400s
 * on a long ask) say nothing readable without it. Either is left out when it quotes what was sent (a validation error
 * can say "messages[2] … <the words>"): any run of QUOTE_CHARS of it found in the request's own text, or a pointer into
 * the messages. The raw error is also left out whole when anything in it could be a key or a header.
 */
export function refusalText(body, sent = "") {
  const e = body?.error;
  const message = squash(typeof e === "string" ? e : e?.message ?? "");
  const words = message && !quotesSent(message, sent) ? (typeof e === "string" ? e : e.message).replace(/\s+/g, " ").trim() : message ? "(its words left out: they quoted what was sent)" : null;
  const code = typeof e === "object" && e && (typeof e.code === "number" || typeof e.code === "string") ? `code ${e.code}` : null;
  const provider = typeof e?.metadata?.provider_name === "string" ? e.metadata.provider_name : null;
  const said = [words, code, provider].filter(Boolean).join(" | ").slice(0, PROVIDER.errorChars);
  const rawWhole = e?.metadata?.raw == null ? "" : typeof e.metadata.raw === "string" ? e.metadata.raw : JSON.stringify(e.metadata.raw);
  const rawText = rawWhole.replace(/\s+/g, " ").trim();
  const raw = !rawText ? null
    : quotesSent(squash(rawText), sent) ? "raw left out: it quoted what was sent"
    : SECRETISH.test(rawText) ? "raw left out: it could hold a key or a header"
    : `raw: ${rawText.slice(0, PROVIDER.rawChars)}`;
  const all = [said, raw].filter(Boolean).join(" | ");
  return all || null;
}

/** OpenRouter's own record of a call, for its cost in micro-dollars: null if it hasn't one (yet). */
async function lookupCost(env, generation) {
  try {
    const res = await fetch(`${apiBase(env)}/api/v1/generation?id=${encodeURIComponent(generation)}`, { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } });
    if (!res.ok) return null;
    return dollarsToMicro((await res.json())?.data?.total_cost);
  } catch {
    return null;
  }
}

/**
 * One turn of the model, metered on the trip's host. The call is let out only while the host's month
 * holds its worst case and nothing else of the trip's is out; it settles before this answers, whether
 * the model answered, was refused, or broke. When the first model's provider refuses it and a fallback is set, it
 * goes once more to the fallback (with the fallback's own reasoning level): it is held from the start at the dearer
 * of the two worst cases, charged what OpenRouter says the one that answered cost, and its record names that model.
 */
export async function ask(env, { hostId, tripId, userId, feature, messages, tools = [], maxTokens, pages = 0, pageTokens = 0, toolChoice = "auto" }, { waits = PROVIDER.lookupWaits, timeoutMs = PROVIDER.timeoutMs } = {}) {
  const allowance = await allowanceFor(env, hostId);
  const models = modelsOf(env);
  // A document's transcription is held at its pages (worstCaseDocument), every other call at its characters: each at
  // the dearer of the two models, since either may answer it.
  const worst = Math.max(...models.map((m) => (pages > 0 ? worstCaseDocument(env, { messages, pages, pageTokens, maxTokens }, m) : worstCase(env, { messages, tools, maxTokens }, m))));
  const call = await reserve(env, { hostId, tripId, userId, feature, worst, allowance, model: models[0].model });
  const tag = await tagFor(env, userId);
  let res, body, model;
  for (let i = 0; i < models.length; i++) {
    model = models[i];
    if (model.fallback) await retryOn(env, call, model.model);
    try {
      res = await fetch(`${apiBase(env)}/api/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": env.PUBLIC_ORIGIN, "X-Title": "WeGoPlace" },
        body: JSON.stringify(requestBody(env, { messages, tools, maxTokens, tag, model, toolChoice })),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Timed out: it may have been made all the same, so its worst case, as a call whose answer is lost (never sent
      // again: it may yet be charged). Never reached (the connection refused, no signal here): nothing made or charged.
      const late = e?.name === "TimeoutError" || e?.name === "AbortError";
      logCall({ status: late ? "timeout" : "unreached", model: model.fallback ? model.model : null });
      await settle(env, call, { cost: late ? null : 0 });
      throw new AssistantError("The assistant didn't answer. Try again.", 502, "provider");
    }
    body = await res.json().catch(() => null);
    const refused = !res.ok || !body;
    if (!refused) break;
    logCall({ status: res.status, error: refusalForLog(env, body, sentText(messages, tools)) ?? (body ? null : "the answer wasn't JSON"), model: model.fallback ? model.model : null });
    // The provider's own refusal, and a fallback to go to: once more there. Refused before it made anything,
    // which OpenRouter charges nothing for.
    if (i + 1 < models.length && providerRefused(res.status, body)) continue;
    await settle(env, call, { cost: res.ok ? null : 0, model: model.model });
    throw new AssistantError("The assistant didn't answer. Try again.", 502, "provider", { provider: res.status });
  }
  let cost = dollarsToMicro(body.usage?.cost);
  const generation = typeof body.id === "string" ? body.id : null;
  if (cost === null && generation) {
    for (const wait of waits) {
      await sleep(wait);
      cost = await lookupCost(env, generation);
      if (cost !== null) break;
    }
  }
  const charged = await settle(env, call, { cost, usage: body.usage ?? null, generation, model: model.model });
  const reasoning = Number(body.usage?.completion_tokens_details?.reasoning_tokens);
  logCall({ status: res.status, finish: body.choices?.[0]?.finish_reason ?? null, reasoning: Number.isFinite(reasoning) ? reasoning : null, error: body.error ? refusalForLog(env, body, sentText(messages, tools)) : null, model: model.fallback ? model.model : null });
  const message = body.choices?.[0]?.message;
  if (!message || typeof message !== "object") throw new AssistantError("The assistant's answer came back empty. Try again.", 502, "empty");
  // finish: why the model stopped writing ("stop", "tool_calls", "length" when it ran out of its max_tokens, …).
  // model: the one that answered, so the loop hands its reasoning back to it alone.
  return { message, usage: body.usage ?? null, cost: charged, finish: body.choices?.[0]?.finish_reason ?? null, model: model.model };
}

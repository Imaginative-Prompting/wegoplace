// How hard the assistant's model thinks (ASSISTANT_REASONING_EFFORT, src/assistant/provider.js), what each call
// says of itself in the Worker's log, and a thinking model's reasoning carried through the tool loop
// (src/assistant/talk.js). Against a stand-in OpenRouter (checks/lib/model-standin.mjs): nothing reaches a model.
//
//   node --disable-warning=ExperimentalWarning checks/assistant/effort.mjs [--port <port>]
//
// It holds:
//   1. the setting empty (the default): the request is today's exactly, with no reasoning field; each of
//      OpenRouter's levels is sent as reasoning: { effort }; a word that isn't a level sends nothing;
//   2. each call's one log line: a call answered says its status, how it finished and its reasoning tokens; a
//      refusal says its status and OpenRouter's words for why, cut short; a call never answered says so; OpenRouter's
//      words left out when they quote what was sent (planted: a validation error quoting a message, one pointing
//      into the messages, a provider's raw error), its code and provider kept; and no line holds a word of the
//      conversation, the key or a header;
//   3. the tool loop (a server of its own): an answer that carries reasoning_details gets them back, unchanged,
//      on its assistant message in the next call; an answer without them leaves that message as it is today.
// Everyone in it is made up.

import fs from "node:fs";
import { d1Local } from "../lib/d1-local.mjs";
import { startModel } from "../lib/model-standin.mjs";
import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { EFFORTS, PROVIDER, ask, refusalForLog, requestBody } from "../../src/assistant/provider.js";
import { errorLine } from "../../src/log.js";

const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 8911);
const t = new Report("the assistant's effort setting, its log line and its reasoning in the loop");
const KEY = "sk-or-check-not-real";
const TODAY = ["model", "messages", "tools", "tool_choice", "max_tokens", "usage", "provider", "user"];

let model, server, code = 1;
try {
  model = await startModel({ key: KEY });
  const db = d1Local();
  const now = Math.floor(Date.now() / 1000);
  db.raw.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)").run("u-host", "Ada Reyes", now);
  db.raw.prepare(`INSERT INTO billing_subscriptions (id, user_id, customer, status, interval, current_period_end, held, updated_at, synced_at)
    VALUES ('sub_host', 'u-host', 'cus_host', 'active', 'month', ?, 0, ?, ?)`).run(now + 30 * 86400, now, Date.now());
  const base = {
    DB: db, PUBLIC_ORIGIN: "http://localhost:8999", PLAN_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x",
    STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true", OPENROUTER_API_KEY: KEY,
    OPENROUTER_API_BASE: model.base, ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5",
  };
  const WORDS = "When does the night bus leave?";
  const messages = [{ role: "system", content: "You help with a trip." }, { role: "user", content: WORDS }];
  const TOOLS = [{ type: "function", function: { name: "list_events", description: "The itinerary.", parameters: { type: "object", properties: {} } } }];
  const q = (env) => ask(env, { hostId: "u-host", tripId: "trip-a", userId: "u-host", feature: "ask", messages, tools: TOOLS, maxTokens: 400 }, { waits: [10] })
    .then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, status: e.status, error: e.error }));
  // Each call's log line, read as the Worker prints it.
  const printed = [];
  const log = console.log;
  console.log = (...args) => { printed.push(args.join(" ")); };
  const lines = () => printed.filter((l) => l.startsWith('{"assistant_call"')).map((l) => JSON.parse(l).assistant_call);
  const quiet = async (fn) => { const from = printed.length; const r = await fn(); return { r, logged: printed.slice(from) }; };

  t.part("1. The setting");
  const { r: plain } = await quiet(() => q({ ...base }));
  const sent = model.calls.at(-1).body;
  console.log = log;
  t.same("empty (the default): the request is today's, field for field, with no reasoning", [plain.ok, Object.keys(sent)], [true, TODAY]);
  t.same("  and requestBody() says the same with the setting blank", Object.keys(requestBody({ ...base, ASSISTANT_REASONING_EFFORT: "" }, { messages, tools: TOOLS, maxTokens: 400, tag: "x" })), TODAY);
  console.log = (...args) => { printed.push(args.join(" ")); };
  const each = [];
  for (const level of EFFORTS) {
    await q({ ...base, ASSISTANT_REASONING_EFFORT: level });
    each.push([level, model.calls.at(-1).body.reasoning]);
  }
  console.log = log;
  t.same("each of OpenRouter's levels is sent as reasoning: { effort }", each, EFFORTS.map((l) => [l, { effort: l }]));
  t.same("  the levels, most to least, as OpenRouter names them", EFFORTS, ["max", "xhigh", "high", "medium", "low", "minimal", "none"]);
  const odd = requestBody({ ...base, ASSISTANT_REASONING_EFFORT: "turbo" }, { messages, tools: TOOLS, maxTokens: 400, tag: "x" });
  t.same("a word that isn't a level (\"turbo\") sends nothing, as if empty", Object.keys(odd), TODAY);

  t.part("2. Each call's line in the log");
  console.log = (...args) => { printed.push(args.join(" ")); };
  const from = lines().length;
  model.next({ words: "At 22:30.", usage: { completion_tokens: 90, completion_tokens_details: { reasoning_tokens: 64 } } });
  await q({ ...base });
  model.next({ words: null, finish: "length", usage: { completion_tokens: 400, completion_tokens_details: { reasoning_tokens: 400 } } });
  await q({ ...base, ASSISTANT_REASONING_EFFORT: "high" });
  model.next({ status: 404, error: "No endpoints found that can handle the requested parameters." });
  const refusedCall = await q({ ...base });
  model.next({ status: 400, error: `Provider returned error ${"x".repeat(600)}` });
  await q({ ...base });
  const { logged: unreachedLog } = await quiet(() => q({ ...base, OPENROUTER_API_BASE: "http://127.0.0.1:9" }));
  // OpenRouter's words that quote the request: a validation error that repeats a message's words, one that points
  // into the messages, and a provider's raw error (never kept at all).
  model.next({ status: 400, errorBody: { message: `Invalid request: the text "${WORDS}" can't be sent to this provider`, code: 400 } });
  await q({ ...base });
  model.next({ status: 400, errorBody: { message: "messages[1].content: must not be empty", code: "invalid_request" } });
  await q({ ...base });
  model.next({ status: 502, errorBody: { message: "Provider returned error", code: 502, metadata: { provider_name: "Stand-in Cloud", raw: `{"error":"bad prompt: You help with a trip. ${WORDS}"}` } } });
  await q({ ...base });
  // A provider's raw error that says why without quoting anything (as a long ask's 400 does): its first 200 characters.
  const READABLE = `{"error":{"code":400,"message":"Request contains an invalid argument: the request's total size exceeds this model's limit of 1048576 tokens.","status":"INVALID_ARGUMENT","details":[{"reason":"limit","pad":"${"y ".repeat(60)}"}]}}`;
  model.next({ status: 400, errorBody: { message: "Provider returned error", code: 400, metadata: { provider_name: "Stand-in Cloud", raw: READABLE } } });
  await q({ ...base });
  // One that could carry a key, and one that names a header: left out whole.
  model.next({ status: 401, errorBody: { message: "Provider returned error", code: 401, metadata: { provider_name: "Stand-in Cloud", raw: `{"error":"invalid key sk-standin-0123456789abcdef"}` } } });
  await q({ ...base });
  model.next({ status: 400, errorBody: { message: "Provider returned error", code: 400, metadata: { provider_name: "Stand-in Cloud", raw: `{"error":"missing header Authorization"}` } } });
  await q({ ...base });
  console.log = log;
  const got = lines().slice(from);
  t.same("an answer: its status, how it finished, its reasoning tokens, no error", got[0], { status: 200, finish_reason: "stop", reasoning_tokens: 64, error: null });
  t.same("an answer whose thinking took every token it might write: finished on length, all of them reasoning", [got[1].finish_reason, got[1].reasoning_tokens], ["length", 400]);
  t.same("a refusal: its status and OpenRouter's words for why", [refusedCall.ok, got[2]], [false, { status: 404, finish_reason: null, reasoning_tokens: null, error: "No endpoints found that can handle the requested parameters." }]);
  t.ok(`  OpenRouter's words cut to ${PROVIDER.errorChars} characters`, got[3].status === 400 && got[3].error.length === PROVIDER.errorChars && got[3].error.startsWith("Provider returned error x"), got[3].error?.length);
  t.same("a call never answered says so", unreachedLog.map((l) => JSON.parse(l).assistant_call.status), ["unreached"]);
  t.same("words that quote a message are left out, its code kept", got[5]?.error, "(its words left out: they quoted what was sent) | code 400");
  t.same("  words that point into the messages, the same", got[6]?.error, "(its words left out: they quoted what was sent) | code invalid_request");
  t.same("  a provider's raw error that quotes what was sent: left out, saying so", got[7]?.error, "Provider returned error | code 502 | Stand-in Cloud | raw left out: it quoted what was sent");
  t.same(`a provider's raw error that quotes nothing: its first ${PROVIDER.rawChars} characters, after OpenRouter's own words`, got[8]?.error,
    `Provider returned error | code 400 | Stand-in Cloud | raw: ${READABLE.replace(/\s+/g, " ").trim().slice(0, PROVIDER.rawChars)}`);
  t.same("  one that could hold a key: left out whole, saying so", got[9]?.error, "Provider returned error | code 401 | Stand-in Cloud | raw left out: it could hold a key or a header");
  t.same("  one that names a header: the same", got[10]?.error, "Provider returned error | code 400 | Stand-in Cloud | raw left out: it could hold a key or a header");
  const all = printed.join("\n");
  t.ok("no line holds a word of the conversation, the key, the account or a header", !all.includes(WORDS) && !all.includes("sk-standin") && !all.includes("You help with a trip") && !all.includes(KEY)
    && !/Bearer|Authorization|HTTP-Referer|u-host|Ada/.test(all), printed.length);

  t.part("3. A thinking model's reasoning, through the tool loop");
  server = await startServer({
    name: "assistant-effort", port,
    vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true",
      ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5", ASSISTANT_REASONING_EFFORT: "low", OPENROUTER_API_BASE: model.base },
    secrets: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", OPENROUTER_API_KEY: KEY },
  });
  await server.start();
  const ada = new Person(server.origin, "Ada Reyes");
  if ((await ada.signUp()).status !== 200) throw new CheckError("couldn't make Ada");
  const trip = (await ada.post("/api/trips", { name: "Lake week", default_tz: "UTC", starts_on: "2027-06-01", ends_on: "2027-06-07" })).json.trip.id;
  const at = Math.floor(Date.now() / 1000);
  server.sql(`INSERT INTO billing_subscriptions (id, user_id, customer, status, interval, current_period_end, held, updated_at, synced_at)
    VALUES ('sub_ada', '${ada.user.id}', 'cus_ada', 'active', 'month', ${at + 30 * 86400}, 0, ${at}, ${Date.now()})`);
  const A = `/api/trips/${trip}/assistant/conversations`;
  await ada.post(A, { id: "c-effort" });
  const DETAILS = [{ type: "reasoning.encrypted", data: "c2VhbGVkIHRob3VnaHQ=", id: "rs_1", format: "anthropic-claude-v1", index: 0 }, { type: "reasoning.text", text: "Read the plans first.", signature: "sig-1", index: 1 }];
  const asked = async (id, words) => {
    const r = await ada.post(`${A}/c-effort/ask`, { id, words });
    return r.text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.turn)?.turn ?? null;
  };
  let mark = model.calls.length;
  model.next({ tools: [{ name: "list_events", arguments: {} }], reasoning_details: DETAILS });
  model.next({ words: "Nothing is planned yet." });
  const first = await asked("ask-1", "What's planned?");
  const [c1, c2] = model.calls.slice(mark).map((c) => c.body);
  const back = c2?.messages?.find((m) => m.role === "assistant" && m.tool_calls);
  t.same("the ask answered in two calls, each with the site's level", [first?.words, c1?.reasoning, c2?.reasoning], ["Nothing is planned yet.", { effort: "low" }, { effort: "low" }]);
  t.same("  the first answer's reasoning_details back, unchanged, on its assistant message in the next call", back?.reasoning_details, DETAILS);
  t.same("  that message's tool calls with them, as before", back?.tool_calls?.map((x) => x.function.name), ["list_events"]);
  mark = model.calls.length;
  model.next({ tools: [{ name: "list_events", arguments: {} }] });
  model.next({ words: "Still nothing planned." });
  await asked("ask-2", "And now?");
  const plainBack = model.calls.slice(mark)[1]?.body?.messages?.findLast((m) => m.role === "assistant" && m.tool_calls);
  t.same("an answer with no reasoning_details: its assistant message as today (role, content, tool_calls)", plainBack && Object.keys(plainBack), ["role", "content", "tool_calls"]);

  t.part("4. What the site's log may hold: never a person's words, a title or a document's text");
  const live = { PUBLIC_ORIGIN: "https://wegoplace.com" }, here = { PUBLIC_ORIGIN: "http://localhost:8912" };
  // A title shorter than refusalText's quote filter (16 characters), and an error whose message quotes what it read.
  const TITLE = "Rijksmuseum 10am";
  let thrown;
  try { JSON.parse(TITLE); } catch (e) { thrown = e; }
  const refusal = { error: { message: `Invalid value for 'title': '${TITLE.slice(0, 11)}'`, code: 400, metadata: { provider_name: "Google", raw: `{"error":{"message":"bad title ${TITLE.slice(0, 11)}"}}` } } };
  const liveError = JSON.stringify(errorLine(thrown, live)), liveRefusal = refusalForLog(live, refusal, `plan ${TITLE}`);
  t.ok("on the live site an error's line is its name, code and frames: nothing of its message", !liveError.includes("Rijks") && /SyntaxError/.test(liveError) && !/"message"/.test(liveError), liveError);
  t.ok("  and a refusal's is OpenRouter's code and the provider: none of its words, none of the raw error", liveRefusal === "code 400 | Google", liveRefusal);
  t.ok("  on this machine (wrangler dev) both keep their words, for whoever is debugging and the bake-off's records",
    JSON.stringify(errorLine(thrown, here)).includes("Rijks") && /Invalid value/.test(refusalForLog(here, refusal, "")), JSON.stringify(errorLine(thrown, here)).slice(0, 160));
  const talkSrc = fs.readFileSync(new URL("../../src/assistant/talk.js", import.meta.url), "utf8");
  const raw = talkSrc.split("\n").filter((l) => /console\.(log|warn|error)\(/.test(l) && /e\?\.stack|e\.stack|e\?\.message|e\.message|String\(e\)/.test(l));
  t.ok("  talk.js logs no error's stack or message anywhere (errorLine instead)", raw.length === 0 && (talkSrc.match(/errorLine\(e, env\)/g) ?? []).length === 4, raw.join(" | ").slice(0, 300));
  code = t.end();
} catch (error) {
  console.error(error);
  t.end();
  code = 2;
} finally {
  await server?.stop().catch(() => {});
  await model?.close();
}
process.exit(code);

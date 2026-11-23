// The assistant's meter and its model's client (src/assistant/; migration 0031), in this process on every
// migration (checks/lib/d1-local.mjs), with a stand-in OpenRouter (checks/lib/model-standin.mjs). Nothing
// reaches a model; no server (the routes come with the assistant's screens).
//
//   node --disable-warning=ExperimentalWarning checks/assistant/meter.mjs
//
// It holds:
//   1. who may call it: not offered (off, no key, no model), the host with no plan, a plan held;
//   2. what a request carries: the model, the turn and its tools, routing that keeps nothing (zero data
//      retention, no collection, every parameter honoured), the account's opaque tag and never its id or a
//      name; the answer's words or tool calls handed back;
//   3. the ledger: the call settled at the model's reported cost with its tokens, model, trip and who asked,
//      and no word of what was asked or answered anywhere in it;
//   4. what a call costs when the answer doesn't say: OpenRouter's record, else its worst case; a refusal
//      before anything was made, nothing; a connection never made, nothing; a timeout, its worst case;
//   4b. a call its provider refuses goes once more to the fallback, at the fallback's own reasoning level, still
//      keeping nothing; held at the dearer worst case, charged what the one that answered cost, its record naming
//      it; our own refusals (key, credit, a bad request of ours) and a call cut short never go; with no fallback, or
//      both refused, the ask ends in words;
//   5. the host's month held exactly: a call let out only while what is spent, every call still out at its
//      worst case and this one fit; two trips of one host side by side; one trip one ask at a time (a second
//      waits, then is refused in words); used up, refused with the day it's back;
//   6. a dead call (its Worker gone) counted at its worst case by the host's next call, and put right when it
//      settles after all; last month's calls not counting;
//   7. what a member may know (room or the day it's back, no numbers) and what the host may (per trip, never
//      per person);
//   8. deleting an account: a member's asks stay in the host's ledger without who asked, a host's ledger
//      goes, the tag goes; the tag is the same for one account and never its id.
// Everyone in it is made up.

import { d1Local } from "../lib/d1-local.mjs";
import { startModel } from "../lib/model-standin.mjs";
import { Report } from "../lib/person.mjs";
import { DELETE_STATEMENTS, assistantOffered, fallbackOf, hostMonth, monthOf, nextMonth, reserve, roomFor, settle, tagFor, worstCase } from "../../src/assistant/meter.js";
import { ask } from "../../src/assistant/provider.js";

const t = new Report("the assistant's meter, against a stand-in model");
const KEY = "sk-or-check-not-real";
let model, code = 1;
try {
  model = await startModel({ key: KEY });
  const db = d1Local();
  const now = Math.floor(Date.now() / 1000);
  for (const [id, name] of [["u-host", "Ada Reyes"], ["u-ben", "Ben Okafor"], ["u-cleo", "Cleo Tran"], ["u-free", "Dev Patel"]]) {
    db.raw.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)").run(id, name, now);
  }
  const plan = (user, status = "active", held = 0) => db.raw.prepare(
    `INSERT INTO billing_subscriptions (id, user_id, customer, status, interval, current_period_end, held, updated_at, synced_at)
     VALUES (?, ?, ?, ?, 'month', ?, ?, ?, ?)`).run(`sub_${user}`, user, `cus_${user}`, status, now + 30 * 86400, held, now, Date.now());
  plan("u-host");
  const base = {
    DB: db, PUBLIC_ORIGIN: "http://localhost:8999", PLAN_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x",
    STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true", OPENROUTER_API_KEY: KEY,
    OPENROUTER_API_BASE: model.base, ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5",
  };
  const env = { ...base };
  const turn = (words) => [{ role: "system", content: "You help with a trip." }, { role: "user", content: words }];
  const TOOLS = [{ type: "function", function: { name: "list_events", description: "The itinerary.", parameters: { type: "object", properties: {} } } }];
  const q = (args, opts) => ask(env, { hostId: "u-host", tripId: "trip-a", userId: "u-ben", feature: "ask", messages: turn("When do we leave?"), tools: TOOLS, maxTokens: 400, ...args }, opts)
    .then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, status: e.status, error: e.error, message: e.message, extra: e.extra }));
  const calls = () => db.sql("SELECT * FROM ai_calls ORDER BY started_at, rowid");

  t.part("1. Who may call it");
  for (const [label, change] of [["switched off", { ASSISTANT_ENABLED: "" }], ["no key", { OPENROUTER_API_KEY: "" }], ["no model", { ASSISTANT_MODEL: "" }], ["the plan off", { PLAN_ENABLED: "" }]]) {
    Object.assign(env, change);
    const r = await q({});
    t.same(`${label}: not offered, in words, and no call made`, [assistantOffered(env), r.status, r.error, model.calls.length], [false, 404, "not offered", 0]);
    Object.assign(env, base);
  }
  const noPlan = await q({ hostId: "u-free" });
  t.same("a host with no plan: refused in words that say nothing of the plan's price", [noPlan.status, noPlan.error, /plan/.test(noPlan.message), /\$|USD/.test(noPlan.message)], [402, "no plan", true, false]);
  plan("u-cleo", "active", 1);
  const held = await q({ hostId: "u-cleo" });
  t.same("a plan held (a payment disputed): refused, paused", [held.status, held.error], [402, "held"]);
  t.same("  and none of those reached the model or wrote a call", [model.calls.length, calls().length], [0, 0]);

  t.part("2. What a request carries");
  model.next({ tools: [{ name: "list_events", arguments: {} }], cost: 0.000123 });
  const first = await q({});
  const sent = model.calls.at(-1);
  t.same("the answer's tool calls handed back", [first.ok, first.message?.tool_calls?.[0]?.function?.name], [true, "list_events"]);
  t.same("the key, the model, the turn and its tools, the most it may write, its cost asked for",
    [sent.auth, sent.body.model, sent.body.messages, sent.body.tools, sent.body.max_tokens, sent.body.usage], [true, "check/model-1", turn("When do we leave?"), TOOLS, 400, { include: true }]);
  t.same("only providers that keep nothing: zero data retention, no data collection, every parameter honoured", sent.body.provider, { zdr: true, data_collection: "deny", require_parameters: true });
  const tag = db.sql("SELECT tag FROM ai_tags WHERE user_id = 'u-ben'")[0]?.tag;
  const body = JSON.stringify(sent.body);
  t.ok("the account by its opaque tag (32 hex), never its id or a name", /^[0-9a-f]{32}$/.test(sent.body.user ?? "") && sent.body.user === tag && !/u-ben|u-host|Ben|Ada|Okafor|Reyes/.test(body), sent.body.user);

  t.part("3. The ledger");
  const row = calls()[0];
  t.same("settled at the model's reported cost, with its tokens, model, trip, who asked, and the host's month",
    [row.state, row.cost, row.prompt_tokens, row.completion_tokens, row.model, row.trip_id, row.user_id, row.host_id, row.month, row.feature],
    ["settled", 123, 120, 30, "check/model-1", "trip-a", "u-ben", "u-host", monthOf(now), "ask"]);
  const cols = db.sql("SELECT name FROM pragma_table_info('ai_calls')").map((c) => c.name);
  t.ok("no word of what was asked or answered anywhere in it", !JSON.stringify(db.sql("SELECT * FROM ai_calls")).includes("leave") && !cols.some((c) => /content|words|text|message|prompt$/.test(c)), cols.join(", "));

  t.part("4. What a call costs when the answer doesn't say");
  model.next({ cost: null, record: 0.000456 });
  const byRecord = await q({}, { waits: [20, 20] });
  model.next({ cost: null, record: null });
  const byNothing = await q({}, { waits: [20, 20] });
  const worst = worstCase(env, { messages: turn("When do we leave?"), tools: TOOLS, maxTokens: 400 });
  t.same("no cost in the answer: OpenRouter's record of the call; with none, its worst case", [byRecord.cost, byNothing.cost, model.lookups.length >= 3], [456, worst, true]);
  model.next({ status: 400 });
  const refused = await q({});
  t.same("refused before anything was made: nothing charged, said in words", [refused.status, refused.error, calls().at(-1).cost], [502, "provider", 0]);
  Object.assign(env, { OPENROUTER_API_BASE: "http://127.0.0.1:9" });
  const unreached = await q({});
  Object.assign(env, base);
  t.same("a connection never made: nothing charged", [unreached.status, calls().at(-1).cost], [502, 0]);
  model.next({ hang: 600 });
  const late = await q({}, { timeoutMs: 150 });
  t.same("timed out (it may have been made): its worst case", [late.status, calls().at(-1).cost], [502, worst]);

  t.part("4b. A call its provider refuses, once more on the fallback");
  {
    // A host of its own, so the month part 5 holds is untouched.
    db.raw.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)").run("u-fb", "Eli Moss", now);
    plan("u-fb");
    const fb = { ...base, ASSISTANT_REASONING_EFFORT: "minimal", ASSISTANT_FALLBACK_MODEL: "check/fallback-1",
      ASSISTANT_FALLBACK_PRICE_INPUT: "0.3", ASSISTANT_FALLBACK_PRICE_OUTPUT: "1.5", ASSISTANT_FALLBACK_REASONING_EFFORT: "" };
    const fq = (e, label) => ask(e, { hostId: "u-fb", tripId: `trip-fb-${label}`, userId: "u-fb", feature: "ask", messages: turn("When do we leave?"), tools: TOOLS, maxTokens: 400 })
      .then((r) => ({ ok: true, ...r }), (er) => ({ ok: false, status: er.status, error: er.error, message: er.message }));
    const fbCalls = (label) => db.sql(`SELECT model, worst, cost, state FROM ai_calls WHERE trip_id = 'trip-fb-${label}'`);
    const PROVIDER_ERROR = { message: "Provider returned error", code: 502, metadata: { provider_name: "Stand-in Cloud", raw: "upstream unavailable" } };
    const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

    t.same("the fallback is read from its vars (and none when unset, or the same model)", [fallbackOf(fb)?.model, fallbackOf(base), fallbackOf({ ...fb, ASSISTANT_FALLBACK_MODEL: "check/model-1" })], ["check/fallback-1", null, null]);
    let before = model.calls.length;
    model.next({ status: 502, errorBody: PROVIDER_ERROR });
    model.next({ words: "We leave at nine.", cost: 0.0042 });
    const got = await quiet(() => fq(fb, "a"));
    const sent = model.calls.slice(before).map((c) => c.body);
    t.same("its provider refuses: the fallback answers", [got.ok, got.message?.content, sent.length], [true, "We leave at nine.", 2]);
    t.same("  first the site's model at its level, then the fallback at its own (none set: no reasoning field)",
      sent.map((b) => [b.model, b.reasoning?.effort ?? null]), [["check/model-1", "minimal"], ["check/fallback-1", null]]);
    t.ok("  both only to providers that keep nothing, under the same opaque tag",
      sent.every((b) => b.provider?.zdr === true && b.provider?.data_collection === "deny") && sent[0].user === sent[1].user, JSON.stringify(sent.map((b) => b.provider)));
    const dearer = Math.max(worstCase(fb, { messages: turn("When do we leave?"), tools: TOOLS, maxTokens: 400 }),
      worstCase(fb, { messages: turn("When do we leave?"), tools: TOOLS, maxTokens: 400 }, fallbackOf(fb)));
    t.same("  one record: held at the dearer worst case, charged what the fallback cost, naming the fallback",
      fbCalls("a"), [{ model: "check/fallback-1", worst: dearer, cost: 4200, state: "settled" }]);

    for (const [label, answer, why] of [
      ["b", { status: 402, errorBody: { message: "Insufficient credits", code: 402 } }, "our own credit (402)"],
      ["c", { status: 401, errorBody: { message: "No auth credentials found", code: 401 } }, "our own key (401)"],
      ["d", { status: 400, errorBody: { message: "max_tokens must be a number", code: 400 } }, "a bad request of ours (a 400 no provider sent)"],
    ]) {
      before = model.calls.length;
      model.next(answer);
      const r = await quiet(() => fq(fb, label));
      t.same(`  never for ${why}: one call, the ask ends in words`, [r.ok, r.message, model.calls.length - before, fbCalls(label)[0]?.model], [false, "The assistant didn't answer. Try again.", 1, "check/model-1"]);
    }
    before = model.calls.length;
    model.next({ words: null, finish: "length" });
    const cut = await quiet(() => fq(fb, "e"));
    t.same("  nor for a call cut short: it is an answer, handed back", [cut.ok, cut.finish, model.calls.length - before], [true, "length", 1]);
    before = model.calls.length;
    model.next({ status: 503, errorBody: PROVIDER_ERROR });
    model.next({ status: 502, errorBody: PROVIDER_ERROR });
    const both = await quiet(() => fq(fb, "f"));
    t.same("both refused: two calls, the ask ends in words, nothing charged", [both.ok, both.message, model.calls.length - before, fbCalls("f")[0]?.cost, fbCalls("f")[0]?.model],
      [false, "The assistant didn't answer. Try again.", 2, 0, "check/fallback-1"]);
    // An answer (a 200) holding only an error may have been charged: it is settled as an answer, never sent again.
    before = model.calls.length;
    model.next({ status: 200, errorBody: PROVIDER_ERROR });
    const odd = await quiet(() => fq(fb, "h"));
    t.same("  nor for an answer holding only an error: one call, settled as an answer, the ask ends in words", [odd.ok, odd.error, model.calls.length - before, fbCalls("h")[0]?.model],
      [false, "empty", 1, "check/model-1"]);
    // No fallback set: the refusal ends the ask, as before there was one.
    before = model.calls.length;
    model.next({ status: 502, errorBody: PROVIDER_ERROR });
    const none = await quiet(() => fq({ ...base }, "g"));
    t.same("with no fallback set, a provider's refusal ends the ask in words, after one call", [none.ok, none.message, model.calls.length - before], [false, "The assistant didn't answer. Try again.", 1]);
  }

  t.part("5. The host's month, held exactly");
  db.raw.exec("DELETE FROM ai_calls");
  // An allowance of three worst cases and a little: two calls out at once fit, a third doesn't.
  Object.assign(base, { PLAN_AI_ALLOWANCE_MICRO: String(worst * 3 + 10) });
  Object.assign(env, base);
  model.next({ hang: 700, cost: 0.0001 });
  model.next({ hang: 700, cost: 0.0001 });
  const [sideA, sideB] = await Promise.all([q({ tripId: "trip-a" }), q({ tripId: "trip-b", userId: "u-cleo" })]);
  t.same("two of a host's trips ask side by side: both let out, both settled", [sideA.ok, sideB.ok, calls().filter((c) => c.state === "settled").length], [true, true, 2]);
  model.next({ hang: 2600 });
  const slow = q({ tripId: "trip-a" });
  await new Promise((r) => setTimeout(r, 150));
  const second = await q({ tripId: "trip-a", userId: "u-cleo" });
  t.same("one trip, one ask at a time: a second waits, then is refused in words", [second.status, second.error, /someone on this trip/.test(second.message ?? "")], [429, "busy", true]);
  await slow;
  model.next({ hang: 1200 });
  const queued = q({ tripId: "trip-a" });
  await new Promise((r) => setTimeout(r, 100));
  model.next({});
  const after = await q({ tripId: "trip-a", userId: "u-cleo" });
  await queued;
  t.same("  and one asked while the last settles goes once it has", after.ok, true);
  const spent = () => db.sql("SELECT COALESCE(SUM(CASE WHEN state = 'settled' THEN cost ELSE worst END), 0) AS n FROM ai_calls WHERE host_id = 'u-host'")[0].n;
  db.raw.exec("DELETE FROM ai_calls");
  Object.assign(base, { PLAN_AI_ALLOWANCE_MICRO: String(worst * 2 + 10) });
  Object.assign(env, base);
  model.next({ hang: 800, cost: 0.0001 });
  model.next({ hang: 800, cost: 0.0001 });
  model.next({});
  const three = await Promise.all([q({ tripId: "trip-a" }), q({ tripId: "trip-b" }), new Promise((r) => setTimeout(r, 200)).then(() => q({ tripId: "trip-c" }))]);
  t.same("while two are out at their worst case, a third that wouldn't fit is refused: the month held exactly",
    [three[0].ok, three[1].ok, three[2].status, three[2].error], [true, true, 402, "used up"]);
  t.ok("  in words, with the day it's back (the first of next month), no number", /It's back on [A-Z][a-z]+ \d{1,2}\./.test(three[2].message ?? "") && !/\d{3,}|\$/.test(three[2].message), three[2].message);
  const fits = await q({ tripId: "trip-c" });
  t.same("  and once those settle at what they cost, it fits", [fits.ok, spent() <= worst * 2 + 10], [true, true]);

  t.part("6. A dead call, and the month's end");
  db.raw.exec("DELETE FROM ai_calls");
  const gone = await reserve(env, { hostId: "u-host", tripId: "trip-d", userId: "u-ben", feature: "ask", worst: 1000, allowance: 1_000_000, model: "m" }, now);
  await reserve(env, { hostId: "u-host", tripId: "trip-e", userId: "u-ben", feature: "ask", worst: 10, allowance: 1_000_000, model: "m" }, now + 181);
  t.same("a call out past its time (its Worker gone) is taken as dead by the host's next call, and counts at its worst case",
    [db.sql(`SELECT state FROM ai_calls WHERE id = '${gone.id}'`)[0].state, spent(), (await hostMonth(env, "u-host", now + 181)).used], ["dead", 1010, 1010]);
  const noRoom = await reserve(env, { hostId: "u-host", tripId: "trip-g", userId: "u-ben", feature: "ask", worst: 100, allowance: 1100, model: "m" }, now + 182).then(() => "let out", (e) => e.error);
  t.same("  so a call that only fits if the dead one counted nothing is refused", noRoom, "used up");
  await settle(env, gone, { cost: 40 });
  t.same("  settled after all: it counts at what it cost, the charge put right", [db.sql(`SELECT state, cost FROM ai_calls WHERE id = '${gone.id}'`)[0], spent()], [{ state: "settled", cost: 40 }, 50]);
  const lastMonth = await reserve(env, { hostId: "u-host", tripId: "trip-f", userId: "u-ben", feature: "ask", worst: 5_000_000, allowance: 1e9, model: "m" }, now - 40 * 86400);
  await settle(env, lastMonth, { cost: 5_000_000 }, now - 40 * 86400);
  t.same("a call from last month doesn't count in this one", (await hostMonth(env, "u-host", now)).used, 50);
  // The month turns at 00:00 UTC on the 1st, whatever the zone: a call in the last second of January and one in the
  // first second of February are in two months, and January's share is back at exactly that second.
  const lastSecond = Date.UTC(2027, 0, 31, 23, 59, 59) / 1000, firstSecond = Date.UTC(2027, 1, 1, 0, 0, 0) / 1000;
  for (const [at, cost] of [[lastSecond, 700], [firstSecond, 30]]) {
    const c = await reserve(env, { hostId: "u-edge", tripId: "trip-edge", userId: "u-ben", feature: "ask", worst: 1000, allowance: 1_000_000, model: "m" }, at);
    await settle(env, c, { cost }, at);
  }
  t.same("the month turns at 00:00 UTC on the 1st: the last second of a month counts in it, the next second in the next, and the share is back at that second",
    [monthOf(lastSecond), monthOf(firstSecond), (await hostMonth(env, "u-edge", lastSecond)).used, (await hostMonth(env, "u-edge", firstSecond)).used, nextMonth(lastSecond) === firstSecond],
    ["2027-01", "2027-02", 700, 30, true]);

  t.part("7. What a member may know, and what the host may");
  const room = await roomFor(env, "u-host", now);
  t.same("a member: that it has room this month, and no number", room, { offered: true, on: true, room: true, back: null });
  db.raw.prepare("INSERT INTO ai_calls (id, host_id, trip_id, user_id, month, feature, state, worst, cost, started_at, busy_until, model) VALUES ('fill', 'u-host', 'trip-a', 'u-ben', ?, 'ask', 'settled', 0, ?, ?, ?, 'm')")
    .run(monthOf(now), Number(env.PLAN_AI_ALLOWANCE_MICRO), now, now);
  const full = await roomFor(env, "u-host", now);
  t.same("used up: no room, and the day it's back, still no number", [full.room, typeof full.back, Object.keys(full).sort()], [false, "number", ["back", "offered", "on", "room"]]);
  const host = await hostMonth(env, "u-host", now);
  t.ok("the host: the month's allowance, what's used, per trip, and never per person",
    host.allowance === Number(env.PLAN_AI_ALLOWANCE_MICRO) && host.trips.length >= 3 && host.trips.every((x) => Object.keys(x).sort().join() === "calls,trip_id,used") && !JSON.stringify(host).includes("u-ben"), JSON.stringify(host).slice(0, 200));

  t.part("8. Deleting an account, and the tag");
  t.same("the tag is the same for one account, another's is another", [await tagFor(env, "u-ben"), (await tagFor(env, "u-cleo")) !== tag], [tag, true]);
  const before = db.sql("SELECT COUNT(*) AS n FROM ai_calls WHERE host_id = 'u-host'")[0].n;
  await db.batch(DELETE_STATEMENTS(db, "u-ben"));
  t.same("a member deleted: their asks stay in the host's ledger, without who asked; their tag goes",
    [db.sql("SELECT COUNT(*) AS n FROM ai_calls WHERE host_id = 'u-host'")[0].n, db.sql("SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = 'u-ben'")[0].n, db.sql("SELECT COUNT(*) AS n FROM ai_tags WHERE user_id = 'u-ben'")[0].n], [before, 0, 0]);
  await db.batch(DELETE_STATEMENTS(db, "u-host"));
  t.same("a host deleted: their ledger goes with them", db.sql("SELECT COUNT(*) AS n FROM ai_calls WHERE host_id = 'u-host'")[0].n, 0);
  code = t.end();
} catch (error) {
  console.error(error);
  t.end();
  code = 2;
} finally {
  await model?.close();
}
process.exit(code);

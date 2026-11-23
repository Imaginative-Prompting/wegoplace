// The bake-off harness's own check (tools/assistant-bakeoff.mjs): that it runs whole, end to end, through the
// app's assistant, and that its scoring can tell a model that does each task right from one that does it wrong.
// Through the stand-in model: nothing leaves this machine, and no key is used.
//
//   node checks/assistant/bakeoff.mjs [--port <port>]
//
// It holds:
//   1. a model that does every task right passes every task, every line, with its cost and tokens from the ledger;
//   2. a model that does each one wrong fails every task, each on the line that names what it did wrong;
//   3. the report reads them: the summary best first, each task's lines, a dry run said to be one;
//   4. the key never reaches anything kept from a run;
//   5. planted: a stand-in that doesn't answer one task within the ask's ceiling (shortened here to seconds) leaves
//      that task failed, with why and how long, every other task run and passed, the trip free before the next, the
//      results saved after each task, and the report whole;
//   6. planted: a model whose run dies (its server's port taken) is kept with why, and the next model runs; a server
//      that doesn't come up the first time (its port held, then let go) is tried once more and the row runs;
//   7. the second set (tools/bakeoff/round-2.mjs): a model that does each task right passes every one, each on a
//      fresh made-up trip of its own; one that does each wrong fails every one on the line that names it, and a
//      failed line that reads the answer's words shows the sentence it read;
//   8. a row's reasoning level reaches the model as the app sends it (none sent for a row without one), and each
//      call's own log line is in the task's record: a refused call's status and OpenRouter's words, a call cut off
//      by its thinking, its reasoning tokens; the report says them;
//   9. which rows run, from OpenRouter's public lists (planted): tools, a zero-retention endpoint that takes what
//      is sent, the level the model takes, its lowest level; every row left out named with why;
//  10. the estimate: from an earlier run's tokens, each row's cost and the whole grid's, thinking priced by level;
//  11. planted: a call the provider refuses (HTTP 403) leaves that task stopped by an error, with the provider's status
//      in its record (from the turn's own detail) and in the report;
//  12. the planning set (tools/bakeoff/round-2b.mjs) on empty trips, against the stand-in world's real places: a model
//      that plans with real places (and imports the document faithfully) passes every task, one that makes places up,
//      asks instead of planning, or obeys the document's planted note fails each on its named line; a "+search" row's
//      requests carry the web search, a plain row's never do; the import's document attached through the files route.
//  13. a row that names its fallback ("id@level>fallback@level"): a call the first model's provider refuses goes once
//      more to the fallback at its own level, the person never sees it, the record and report name it; decideRows
//      decides the fallback as a row and leaves out a row whose fallback can't run.

import net from "node:net";
import { Report } from "../lib/person.mjs";
import fs from "node:fs";
import { ASK_CEILING_MS, FIXTURES, bakeOff, isFixture, report, scrubber } from "../../tools/assistant-bakeoff.mjs";
// Why a row stopped, in a failure's line: its first line and, when the cause is further down (a wrangler step's
// stderr), its last, so a stop under load says what it hit.
const stoppedWords = (e) => { const lines = String(e).split("\n").map((l) => l.trim()).filter(Boolean); return (lines.length > 1 ? `${lines[0]} … ${lines.at(-1)}` : lines[0] ?? "").slice(0, 400); };
import { TALK } from "../../src/assistant/talk.js";
import { PROVIDER } from "../../src/assistant/provider.js";
import { TASKS } from "../../tools/bakeoff/tasks.mjs";
import { TASKS_2, WRONG_2 } from "../../tools/bakeoff/round-2.mjs";
import { decideRows, estimate } from "../../tools/assistant-bakeoff.mjs";
import { NOT_FOUND, TASKS_2B, WRONG_2B, refuses } from "../../tools/bakeoff/round-2b.mjs";
import { plainName } from "../../src/map/pois.js";
import { stepWords } from "../../src/assistant/talk.js";
import { loadDemo } from "../lib/demo.mjs";
import { freePort } from "../lib/server.mjs";

const seed = loadDemo();

const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : await freePort());
const t = new Report("the assistant's bake-off harness");
// What each task's wrong answer must fail on (the start of the line).
const WRONG = {
  day: "names all", "who-paid": "the payer", "add-dinner": "at 8 pm on June 11", move: "an hour later", "add-place": "a viewpoint",
  packing: "on the group's list", "which-lunch": "removed nothing", private: "nothing of Teo's conversation", "chat-note": "removed and changed nothing", spanish: "in Spanish",
};

let code = 1;
try {
  t.part("1. A model that does each task right");
  const good = await bakeOff({ models: [{ id: "standin/right", input: 0.1, output: 0.5 }], standin: "good", port });
  const g = good.models[0].tasks;
  t.same("every task run, in order", g.map((x) => x.id), TASKS.map((x) => x.id));
  t.ok("every task passes, every line", g.every((x) => x.passed), g.filter((x) => !x.passed).map((x) => `${x.id}: ${x.lines.filter((l) => !l.ok).map((l) => `${l.what} (${l.got})`).join("; ")}`).join(" | "));
  t.ok("each with its calls, tokens and cost from the ledger", g.every((x) => x.calls >= 1 && x.prompt_tokens > 0 && x.cost_micro > 0), JSON.stringify(g.map((x) => [x.id, x.calls, x.prompt_tokens, x.cost_micro])));
  t.same("a call of the model for each answer it gave: a write two (its tool, then its words), a read one", g.map((x) => [x.id, x.calls]),
    TASKS.map((x) => [x.id, x.standin.good(seed).length]));

  t.part("2. A model that does each one wrong");
  const bad = await bakeOff({ models: [{ id: "standin/wrong", input: 0.1, output: 0.5 }], standin: "bad", port });
  const b = bad.models[0].tasks;
  t.ok("every task fails", b.length === TASKS.length && b.every((x) => !x.passed), b.filter((x) => x.passed).map((x) => x.id).join(", "));
  for (const x of b) {
    const want = WRONG[x.id];
    const line = x.lines.find((l) => l.what.startsWith(want));
    t.ok(`  ${x.id}: on "${want}…"`, line && !line.ok, JSON.stringify(x.lines.filter((l) => !l.ok).map((l) => l.what)));
  }

  t.part("3. The report");
  const both = { started: good.started, stopped: null, models: [...bad.models, ...good.models] };
  const text = report(both, { app: "abc1234", standin: "good" });
  t.ok("the summary best first: the right one above the wrong one, with tasks passed and cost", /\| standin\/right \| none \(its default\) \| 10 of 10 \|[^\n]*\n\| standin\/wrong \| none \(its default\) \| 0 of 10 \|/.test(text), text.split("\n").filter((l) => l.startsWith("| standin")).join(" / "));
  t.ok("each task's ask, and each model's lines under it, a failed line with what it did", text.includes('Ada asks: "Delete the lunch."') && text.includes("- FAIL: removed nothing (there are many lunches). Got: 0 added, 0 changed, 1 removed"), "");
  t.ok("a dry run says it is one", text.includes("**A dry run:** no model was asked"), "");

  t.part("4. The key");
  const scrub = scrubber("sk-or-v1-planted");
  t.same("taken out of any text kept (an answer, a refusal)", scrub("Refused: bad key sk-or-v1-planted given"), "Refused: bad key [the key] given");
  t.ok("no stand-in key in what a run keeps", !JSON.stringify([good, bad]).includes("sk-or-standin"), "");

  t.part("5. Planted: a model that doesn't answer one task in time");
  t.ok(`the ceiling a real run waits for an ask is as long as the app may take: ${TALK.steps} steps of ${PROVIDER.timeoutMs / 1000} s, and a minute (${ASK_CEILING_MS / 1000} s)`,
    ASK_CEILING_MS >= TALK.steps * PROVIDER.timeoutMs + 60_000, ASK_CEILING_MS);
  const saved = [];
  const hung = await bakeOff({ models: [{ id: "standin/slow", input: 0.1, output: 0.5 }], standin: "good", port, askCeilingMs: 4000,
    hang: { task: "who-paid", ms: 12_000 }, save: (r) => saved.push(JSON.parse(JSON.stringify(r))) });
  const hs = hung.models[0].tasks;
  const slow = hs.find((x) => x.id === "who-paid");
  t.same("every task still run, in order", hs.map((x) => x.id), TASKS.map((x) => x.id));
  t.ok("the one it didn't answer in time: failed, saying so, after the ceiling and not long after", slow && !slow.passed && /^no answer within 4 s/.test(slow.failed ?? "")
    && slow.seconds >= 4 && slow.seconds < 8 && slow.lines.length === 1 && !slow.lines[0].ok, JSON.stringify(slow && { failed: slow.failed, seconds: slow.seconds, lines: slow.lines }));
  t.ok("  every other task passed: the run went on, on a free trip, with its own answers", hs.filter((x) => x.id !== "who-paid").every((x) => x.passed),
    hs.filter((x) => x.id !== "who-paid" && !x.passed).map((x) => `${x.id}: ${x.failed ?? x.lines.filter((l) => !l.ok).map((l) => `${l.what} (${l.got})`).join("; ")}`).join(" | "));
  t.ok("  the results were saved after every task, the failed one with them as soon as it ended", saved.length >= TASKS.length
    && saved.some((r) => r.models[0]?.tasks.at(-1)?.id === "who-paid" && r.models[0].tasks.at(-1).failed), saved.length);
  const slowText = report(hung, { app: "abc1234", standin: "good" });
  t.ok("  the report whole: the summary 9 of 10, every task's section, and why that one failed", /\| standin\/slow \| none \(its default\) \| 9 of 10 \|/.test(slowText)
    && TASKS.every((x) => slowText.includes(`## ${x.id}:`)) && slowText.includes("Didn't come back: no answer within 4 s") && slowText.includes("standin/slow on who-paid"),
    slowText.split("\n").filter((l) => /Didn't|\| standin/.test(l)).join(" / "));

  t.part("6. Planted: a model whose run dies");
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(port, "127.0.0.1", r));
  const savedDead = [];
  const two = await bakeOff({ models: [{ id: "standin/dies", input: 0.1, output: 0.5 }, { id: "standin/after", input: 0.1, output: 0.5 }], standin: "good", port,
    only: ["day", "who-paid"], save: (r) => savedDead.push(r.models.length),
    say: (line) => { if (line.includes("standin/dies stopped")) blocker.close(); } });
  const [dead, after] = two.models;
  t.ok("the model that died is kept, with why, and no tasks", dead.error?.includes("in use") && dead.tasks.length === 0, JSON.stringify(dead.error));
  t.ok("  the next model ran its tasks and passed them", after.tasks.length === 2 && after.tasks.every((x) => x.passed), JSON.stringify(after.tasks.map((x) => [x.id, x.passed])));
  const twoText = report(two, { app: "abc1234", standin: "good" });
  t.ok("  the report says it stopped, and why", twoText.includes("**standin/dies stopped** after 0 of its tasks") && twoText.includes("in use"), twoText.split("\n").find((l) => l.includes("dies")) ?? "");
  t.ok("  and the results were saved when it died", savedDead.length >= 3, savedDead.length);
  const holder = net.createServer();
  await new Promise((r) => holder.listen(port, "127.0.0.1", r));
  const said = [];
  const slowStart = await bakeOff({ models: [{ id: "standin/slow-start", input: 0.1, output: 0.5 }], standin: "good", port, only: ["day"],
    say: (line) => { said.push(line); if (line.includes("trying once more")) holder.close(); } });
  t.ok("a server that doesn't come up the first time is tried once more, and the row runs", !slowStart.models[0].error && slowStart.models[0].tasks.length === 1 && slowStart.models[0].tasks[0].passed
    && said.some((l) => l.includes("trying once more")), JSON.stringify({ error: slowStart.models[0].error, said: said.filter((l) => /once more|stopped/.test(l)) }));

  t.part("7. The second set");
  const seedCounts = { events: seed.events.length, places: seed.places.length, purchases: seed.purchases.length + seed.payments.length };
  const good2 = await bakeOff({ models: [{ id: "standin/right", input: 0.1, output: 0.5 }], standin: "good", port, sets: ["round-2"] });
  const g2 = good2.models[0].tasks;
  t.same(`every task run, in order${good2.models[0].error ? ` (the row stopped: ${stoppedWords(good2.models[0].error)})` : ""}`, g2.map((x) => x.id), TASKS_2.map((x) => x.id));
  t.ok("every task passes, every line", g2.every((x) => x.passed), g2.filter((x) => !x.passed).map((x) => `${x.id}: ${x.lines.filter((l) => !l.ok).map((l) => `${l.what} (${l.got})`).join("; ")}`).join(" | "));
  t.ok("  each on a fresh made-up trip: every task started with the seed's plans, places and purchases, whatever the one before did", g2.every((x) => JSON.stringify(x.start) === JSON.stringify(seedCounts)),
    JSON.stringify(g2.map((x) => [x.id, x.start])));
  t.ok("  each ask kept with its words and answer; the many-ask tasks with all of theirs", g2.every((x) => x.asks.length === TASKS_2.find((y) => y.id === x.id).asks(seed).length && x.asks.every((a) => a.answer)),
    JSON.stringify(g2.map((x) => [x.id, x.asks.length])));
  const bad2 = await bakeOff({ models: [{ id: "standin/wrong", input: 0.1, output: 0.5 }], standin: "bad", port, sets: ["round-2"] });
  const b2 = bad2.models[0].tasks;
  t.ok("a model that does each one wrong fails every task", b2.length === TASKS_2.length && b2.every((x) => !x.passed), b2.filter((x) => x.passed).map((x) => x.id).join(", "));
  for (const x of b2) {
    const want = WRONG_2[x.id];
    const l = x.lines.find((y) => y.what.startsWith(want));
    t.ok(`  ${x.id}: on "${want.trim()}…"`, l && !l.ok, JSON.stringify(x.lines.filter((y) => !y.ok).map((y) => y.what)));
  }
  t.ok("  the wrong deletes of one task didn't reach the next (note-injection removed June 7's plans; dutch after it started whole)",
    b2.find((x) => x.id === "note-injection").lines.some((l) => !l.ok && /removed/.test(l.got)) && JSON.stringify(b2.find((x) => x.id === "dutch").start) === JSON.stringify(seedCounts), "");
  const text2 = report(bad2, { app: "abc1234", standin: "bad" });
  t.ok("the report: a failed line that read the answer's words shows the sentence it read", text2.includes('- FAIL: says "Airport lounge" didn\'t go in (a sentence naming it, saying not done). Got: "Added all twelve, Airport lounge included."')
    && text2.includes('- FAIL:   never says it did. Got: "I deleted the trip."'), text2.split("\n").filter((l) => /Airport lounge" didn|never says it did/.test(l)).join(" / "));
  t.ok("  a many-ask task's asks, in turn, and each answer", text2.includes("Teo asks, in turn:") && text2.includes('3. "Remove Sol from the trip."') && text2.includes("Answer 3:"), "");

  t.part("8. A row's reasoning level, and each call's own line in the record");
  const lvl = await bakeOff({ models: [{ id: "standin/plain", input: 0.1, output: 0.5 }, { id: "standin/thinks", effort: "low", input: 0.1, output: 0.5 }], standin: "good", port, only: ["day"] });
  const sent = lvl.requests ?? [];
  t.same("each call carried its row's level: none for the row without one, { effort: \"low\" } for standin/thinks@low",
    [...new Set(sent.map((c) => `${c.model} ${JSON.stringify(c.reasoning)}`))], ["standin/plain null", 'standin/thinks {"effort":"low"}']);
  t.same("  the rows named by model and level", lvl.models.map((m) => m.label), ["standin/plain", "standin/thinks@low"]);
  const REFUSAL = "No endpoints found that can handle the requested parameters.";
  const marked = await bakeOff({ models: [{ id: "standin/marked", effort: "high", input: 0.1, output: 0.5 }], standin: "good", port, only: ["day", "who-paid"],
    alter: [{ task: "day", with: { tools: undefined, words: null, finish: "length", usage: { completion_tokens: 1200, completion_tokens_details: { reasoning_tokens: 1200 } } } },
      { task: "who-paid", with: { tools: undefined, status: 404, error: REFUSAL } }] });
  const [cut, refusedTask] = marked.models[0].tasks;
  t.same("a call its thinking used up: in the record as cut off, with its reasoning tokens", [cut.provider.cut_off, cut.reasoning_tokens, cut.provider.calls[0]?.finish_reason], [1, 1200, "length"]);
  t.same("a refused call: its status and OpenRouter's words in the record", refusedTask.provider.refused.map((c) => [c.status, c.error]), [[404, REFUSAL]]);
  const text3 = report(marked, { app: "abc1234", standin: "good" });
  t.ok("  the report names both: the summary's columns, the refusals' table, and under each task", /\| standin\/marked@high \| high \| 0 of 2 \|[^\n]*\| 1 of \d+ \| 1 of \d+ \| day, who-paid \|/.test(text3)
    && text3.includes(`| standin/marked@high | who-paid | 404 | ${REFUSAL} |`) && text3.includes(`A call was refused: 404, "${REFUSAL}".`) && text3.includes("1 call was cut off at the cap (finished on length)."),
    text3.split("\n").filter((l) => /marked@high|refused|cut off/.test(l)).join(" / "));
  t.ok("  and says in plain words that thinking comes out of the cap", text3.includes("**Thinking and the cap.**") && text3.includes(`counts against the ${TALK.maxTokens.toLocaleString("en-US")} tokens a call may write`), "");

  t.part("9. Which rows run (OpenRouter's lists, planted)");
  const ep = (model, params, provider = "P") => ({ model_id: model, provider_name: provider, supported_parameters: params, status: 0 });
  const lists = {
    models: [
      { id: "a/thinks", supported_parameters: ["tools", "reasoning"], pricing: { prompt: "0.0000001", completion: "0.0000005" }, reasoning: { mandatory: false, default_enabled: true, supported_efforts: ["high", "medium", "low", "none"], default_effort: "medium" } },
      { id: "a/must-think", supported_parameters: ["tools", "reasoning"], pricing: { prompt: "0.000001", completion: "0.000002" }, reasoning: { mandatory: true, supported_efforts: ["max", "high", "low"], default_effort: "max", default_enabled: true } },
      { id: "a/no-levels", supported_parameters: ["tools"], pricing: { prompt: "0.0000001", completion: "0.0000001" }, reasoning: { mandatory: false } },
      { id: "a/no-tools", supported_parameters: ["reasoning"], pricing: { prompt: "0.0000001", completion: "0.0000001" } },
      { id: "a/keeps", supported_parameters: ["tools"], pricing: { prompt: "0.0000001", completion: "0.0000001" } },
      { id: "a/zdr-no-tools", supported_parameters: ["tools"], pricing: { prompt: "0.0000001", completion: "0.0000001" } },
    ],
    zdr: [ep("a/thinks", ["tools", "reasoning"]), ep("a/must-think", ["tools"]), ep("a/must-think", ["tools", "reasoning"], "Q"), ep("a/no-levels", ["tools"]), ep("a/zdr-no-tools", ["reasoning"])],
  };
  const { rows, left } = decideRows(["a/thinks", "a/thinks@lowest", "a/thinks@max", "a/must-think@lowest", "a/no-levels", "a/no-levels@lowest", "a/no-tools", "a/keeps", "a/zdr-no-tools", "a/missing", "a/thinks@turbo", "a/thinks@default"], lists);
  t.same("the rows that run: a model with no level sent, its lowest (none), a must-think model's lowest (low), a model with no levels at its default",
    rows.map((r) => [r.id, r.effort, r.input, r.output]), [["a/thinks", null, 0.1, 0.5], ["a/thinks", "none", 0.1, 0.5], ["a/must-think", "low", 1, 2], ["a/no-levels", null, 0.1, 0.1]]);
  t.same("  each left out with why", left.map((x) => x.asked), ["a/thinks@max", "a/no-levels@lowest", "a/no-tools", "a/keeps", "a/zdr-no-tools", "a/missing", "a/thinks@turbo", "a/thinks@default"]);
  t.ok("  the whys: the level it doesn't take, no levels, no tools, nothing that keeps nothing, no endpoint that takes tools, not listed, not a level, asked twice",
    /doesn't take "max" \(it takes high, medium, low, none\)/.test(left[0].why) && /no reasoning level/.test(left[1].why) && /doesn't take tools/.test(left[2].why)
    && /zero data retention/.test(left[3].why) && /none of its 1 zero-retention endpoints takes tools/.test(left[4].why) && /lists no such model/.test(left[5].why)
    && /isn't one of OpenRouter's levels/.test(left[6].why) && /asked again/.test(left[7].why), JSON.stringify(left.map((x) => x.why)));
  t.same("  a level sent only to an endpoint that takes reasoning (the must-think model's one of two)", rows[2].endpoints, { zdr: 1, providers: ["Q"] });

  t.part("10. The estimate");
  const est = estimate(rows, { sets: ["round-1", "round-2"], from: good });
  const by = Object.fromEntries(est.rows.map((r) => [r.label, r]));
  t.same("a row for each, every task of both sets", [est.rows.length, est.tasks], [4, TASKS.length + TASKS_2.length]);
  t.ok("thinking priced by level: the model's own default (medium) above its none; a must-think model's low priced with thinking", by["a/thinks"].cost > by["a/thinks@none"].cost && by["a/thinks"].thinks === "medium" && by["a/thinks@none"].thinks === "none" && by["a/must-think@low"].thinks === "low",
    JSON.stringify(est.rows.map((r) => [r.label, r.thinks, r.cost])));
  t.same("  the grid's cost is its rows'", est.cost, est.rows.reduce((s, r) => s + r.cost, 0));
  t.ok("  the time counts a fresh server for each round-2 task", est.rows.every((r) => r.minutes * 60 >= TASKS_2.length * 12), JSON.stringify(est.rows.map((r) => r.minutes.toFixed(1))));

  t.part("11. Planted: a call the provider refuses");
  const ref = await bakeOff({ models: [{ id: "standin/refused", input: 0.1, output: 0.5 }], standin: "good", port, only: ["day", "who-paid", "add-dinner"],
    refuse: { task: "who-paid", status: 403 } });
  const rt = ref.models[0].tasks;
  const r403 = rt.find((x) => x.id === "who-paid");
  t.ok("the refused task: stopped by an error, the provider's 403 in its record, failed", r403 && r403.stopped === "error" && r403.provider_status === 403
    && r403.provider_error === "provider" && !r403.passed, JSON.stringify(r403 && { stopped: r403.stopped, status: r403.provider_status, error: r403.provider_error }));
  t.ok("  the log line says the same 403", r403?.provider.refused.map((c) => c.status).join() === "403", JSON.stringify(r403?.provider.refused));
  t.ok("  the tasks around it passed", rt.filter((x) => x.id !== "who-paid").every((x) => x.passed), JSON.stringify(rt.map((x) => [x.id, x.passed])));
  t.ok("  and the report says why", report(ref, { app: "abc1234", standin: "good" }).includes("Stopped by an error: the provider answered HTTP 403."), "");

  t.part("12. The planning set, on empty trips, against real places");
  // The import task's document is attached as the app takes it (src/assistant/files.js), and read with read_document.
  const good2b = await bakeOff({ models: [{ id: "standin/plans", input: 0.1, output: 0.5 }, { id: "standin/plans", search: true, input: 0.1, output: 0.5 }], standin: "good", port, sets: ["round-2b"] });
  for (const m of good2b.models) {
    t.ok(`${m.label}: every planning task passes, every line`, m.tasks.length === TASKS_2B.length && m.tasks.every((x) => x.passed),
      m.error ?? m.tasks.filter((x) => !x.passed).map((x) => `${x.id}: ${x.lines.filter((l) => !l.ok).map((l) => `${l.what} (${l.got})`).join("; ")}`).join(" | "));
  }
  const planTools = good2b.models[0].tasks.find((x) => x.id === "plan-my-trip")?.tools ?? [];
  t.ok("  each task's record keeps the tools each call asked for, call by call (plan-my-trip: find_places, then find_picture, then set_picture, and the last call none), and the report lists them",
    planTools.length === good2b.models[0].tasks.find((x) => x.id === "plan-my-trip").calls && planTools.flat().includes("find_places") && planTools.findIndex((c) => c.includes("find_picture")) < planTools.findIndex((c) => c.includes("set_picture"))
      && planTools.findIndex((c) => c.includes("find_picture")) >= 0 && planTools.at(-1).length === 0
      && /Tools asked for, call by call: 1\. [a-z_]+/.test(report(good2b, { app: "abc1234", standin: "good" })), JSON.stringify(planTools));
  t.ok("  each started on an empty trip (no plans, places or purchases)", good2b.models.every((m) => m.tasks.every((x) => x.start.events === 0 && x.start.places === 0 && x.start.purchases === 0)), "");
  const searched = (good2b.requests ?? []).map((c) => `${c.model} ${c.search}`);
  t.same("the web search only in the +search row's requests", [...new Set(searched)].sort(), ["standin/plans false", "standin/plans true"]);
  t.same("  rows named by it", good2b.models.map((m) => m.label), ["standin/plans", "standin/plans+search"]);
  const imp = good2b.models[0].tasks.find((x) => x.id === "import-doc");
  t.ok("  the import's document was attached to the ask (uploaded and named), and its report doesn't say otherwise", imp?.attached === true && imp?.files?.[0] === "amsterdam-draft.md"
    && !report(good2b, { app: "abc1234", standin: "good" }).includes("**Not attached:**"), JSON.stringify({ attached: imp?.attached, files: imp?.files }));
  const bad2b = await bakeOff({ models: [{ id: "standin/invents", input: 0.1, output: 0.5 }], standin: "bad", port, sets: ["round-2b"] });
  const b2b = bad2b.models[0].tasks;
  t.ok("a model that makes places up, or asks instead of planning, fails every task", b2b.length === TASKS_2B.length && b2b.every((x) => !x.passed), bad2b.models[0].error ?? b2b.filter((x) => x.passed).map((x) => x.id).join(", "));
  for (const x of b2b) {
    const want = WRONG_2B[x.id];
    const l = x.lines.find((y) => y.what.startsWith(want));
    t.ok(`  ${x.id}: on "${want}…"`, l && !l.ok, JSON.stringify(x.lines.filter((y) => !y.ok).map((y) => y.what)));
  }
  const fake = b2b.find((x) => x.id === "find-near").lines.find((l) => l.what.startsWith("every place written is real"));
  t.ok("  the made-up bakery named, with where it was written", fake?.got.includes("Golden Crumb Bakery at 52.3746,4.8852"), fake?.got);
  const cafe = b2b.find((x) => x.id === "import-doc").lines.find((l) => l.what.startsWith("the café no map knows"));
  t.ok("  the import's café given invented coordinates: caught, with where", cafe && !cafe.ok && cafe.got.includes("Cafe Zonnewende at 52.377,4.882"), cafe?.got);
  t.same("decideRows takes +search: the row keeps its level and adds the search", decideRows(["a/thinks@lowest+search"], lists).rows.map((r) => [r.id, r.effort, r.search]), [["a/thinks", "none", true]]);

  t.part("12b. The import's documents: the made-up fixtures, held by their hashes");
  const docDir = new URL("../../tools/bakeoff/documents/", import.meta.url);
  t.same("each fixture on disk is the one its hash names (a --real-ai run sends these and nothing else)",
    Object.keys(FIXTURES).map((name) => [name, isFixture(name, fs.readFileSync(new URL(name, docDir)))]), Object.keys(FIXTURES).map((name) => [name, true]));
  const pdfBytes = fs.readFileSync(new URL("amsterdam-draft.pdf", docDir));
  t.same("  a file changed by one byte, a file of another name, or a name not on the list: not a fixture",
    [isFixture("amsterdam-draft.pdf", Buffer.concat([pdfBytes, Buffer.from(" ")])), isFixture("amsterdam-draft-photo.jpg", pdfBytes), isFixture("someone-else.pdf", pdfBytes)], [false, false, false]);
  const scan = good2b.models[0].tasks.find((x) => x.id === "import-scan"), pdf = good2b.models[0].tasks.find((x) => x.id === "import-pdf");
  t.ok("  import-pdf (read by the stand-in conversion) and import-scan (one transcription call at upload, then the ask) pass on the right stand-in, the scan's calls one more",
    pdf?.passed && scan?.passed && scan.calls === pdf.calls + 1, JSON.stringify([pdf && [pdf.passed, pdf.calls], scan && [scan.passed, scan.calls]]));

  t.same("  the honest sentences pass and the refusals fail: a search's result is not a refusal",
    ["I couldn't find Cafe Zonnewende on the map, so its card has no location.", "I can't plan trips, but here are some ideas.", "Sorry, I'm unable to search for places.", "I can't look up places on the map."].map(refuses), [false, true, true, true]);
  t.same("  a note saying a place isn't on the map, however it's put, and one that doesn't",
    ["Wasn't found on the map (searched in the Jordaan).", "Not found on the map: location not confirmed.", "We couldn't find it on the map.", "A cosy bar in the Jordaan.", "Found on the map."].map((x) => NOT_FOUND.test(plainName(x))), [true, true, true, false, false]);

  t.same("  what the person sees while an import looks its places up: how many, on the map; a search by kind as before",
    [stepWords("find_places", { names: ["Rijksmuseum", "Vondelpark", "Foodhallen"] }), stepWords("find_places", { names: ["Rijksmuseum"] }), stepWords("find_places", { kinds: ["bakery"] })],
    ["Looking up 3 places on the map", "Looking up 1 place on the map", "Looking for bakery nearby"]);

  t.part("13. A row that names its fallback");
  // The app's fallback (src/assistant/provider.js): a call the first model's provider refuses goes once more to the
  // row's fallback, at the fallback's own level. Planted: add-dinner's first call (it writes, then answers) refused once (a 503 the provider sent).
  const fb = await bakeOff({ models: [{ id: "standin/first", effort: "minimal", input: 0.1, output: 0.5, fallback: { id: "standin/second", effort: "low", input: 0.2, output: 1 } }],
    standin: "good", port, only: ["add-dinner"], refuseOnce: { task: "add-dinner", status: 503 } });
  const fbTask = fb.models[0].tasks[0];
  const fbSent = fb.requests ?? [];
  t.same("the row named with its fallback", fb.models[0].label, "standin/first@minimal>standin/second@low");
  t.same("  the refused call went once more to the fallback, at the fallback's own level; the next went to the first model again, at its own",
    fbSent.slice(0, 3).map((c) => `${c.model} ${JSON.stringify(c.reasoning)}`), ['standin/first {"effort":"minimal"}', 'standin/second {"effort":"low"}', 'standin/first {"effort":"minimal"}']);
  t.ok("  the task passed: the person never saw the refusal", fbTask?.passed && fbTask.stopped === null, JSON.stringify(fbTask && { passed: fbTask.passed, stopped: fbTask.stopped }));
  t.same("  the record: the 503 refused, then the fallback's answer, its log line naming it",
    fbTask?.provider.calls.slice(0, 2).map((c) => [c.status, c.fallback ?? null]), [[503, null], [200, "standin/second"]]);
  t.ok("  and the report names the row's fallback", report(fb, { app: "abc1234", standin: "good" }).includes("standin/first@minimal>standin/second@low"), "");
  const { rows: fbRows, left: fbLeft } = decideRows(["a/thinks@none>a/must-think@lowest", "a/thinks>a/keeps", "a/thinks>a/thinks"], lists);
  t.same("decideRows decides a fallback as a row: its level, its own prices; one that can't run leaves the row out, saying why",
    [fbRows.map((r) => [r.id, r.effort, r.fallback?.id, r.fallback?.effort, r.fallback?.input, r.fallback?.output]), fbLeft.map((x) => x.why)],
    [[["a/thinks", "none", "a/must-think", "low", 1, 2]], ["its fallback a/keeps: no endpoint of it keeps nothing (zero data retention)", "its fallback is the same model (the app takes none then)"]]);
  code = t.end();
} catch (error) {
  console.error(error);
  t.end();
  code = 2;
}
process.exit(code);

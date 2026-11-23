// Talking to the assistant (src/assistant/talk.js, L4): the wait made visible, the caps, the writes as the
// person who asked, one ask at a time per trip, and a person's conversations kept and gone. On a server of its
// own with the plan and the assistant on and a stand-in model (checks/lib/model-standin.mjs). No screen yet.
//
//   node checks/assistant/talk.mjs [--port <port>]
//
// It holds:
//   1. the wait is visible: an ask's steps come on the wire AS they are taken, in words from the steps
//      themselves ("Adding or changing 3 places…"), before the answer, and are kept on the answer;
//   2. what it writes is a change as the person who asked, from the assistant, in the trip's list of changes,
//      and the answer names it;
//   3. the step cap and the token cap: the ask stops, saying so, what it did, and that the rest isn't done; an ask
//      keeps its trip for as long as it works (its hold renewed as each step begins), and one whose hold another
//      ask took stops before its next step, saying so;
//   4. one ask at a time per trip (a second refused in words, another trip's going on); an ask sent again gets
//      its answer, with nothing asked of the model again; the host's month used up mid-ask ends it in words;
//      a host with no plan is refused before anything is kept;
//   5. a conversation: made (and made again with the same id), its turns in order, deleted with them; an
//      account deleted takes every conversation of its own.
// Everyone in it is made up.

import { CheckError, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { startModel } from "../lib/model-standin.mjs";
import { TALK } from "../../src/assistant/talk.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const t = new Report("talking to the assistant");
const KEY = "sk-or-check-not-real";

let server, model, code = 1;
try {
  model = await startModel({ key: KEY });
  server = await startServer({
    name: "assistant-talk", port,
    vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true",
      ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5", OPENROUTER_API_BASE: model.base,
      ASSISTANT_FALLBACK_MODEL: "check/fallback-1", ASSISTANT_FALLBACK_PRICE_INPUT: "0.3", ASSISTANT_FALLBACK_PRICE_OUTPUT: "1.5" },
    secrets: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", OPENROUTER_API_KEY: KEY },
  });
  await server.start();
  const { origin } = server;
  const [ada, ben, cleo, dev] = ["Ada Reyes", "Ben Okafor", "Cleo Tran", "Dev Patel"].map((n) => new Person(origin, n));
  for (const p of [ada, ben, cleo, dev]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const trip = (await ada.post("/api/trips", { name: "Lake week", default_tz: "UTC", starts_on: "2027-06-01", ends_on: "2027-06-07" })).json.trip.id;
  const trip2 = (await ada.post("/api/trips", { name: "City weekend", default_tz: "UTC" })).json.trip.id;
  for (const p of [ben, cleo]) for (const x of [trip, trip2]) await p.post(`/api/join/${(await ada.post(`/api/trips/${x}/links`, { uses: 1 })).json.link.code}`);
  const now = Math.floor(Date.now() / 1000);
  server.sql(`INSERT INTO billing_subscriptions (id, user_id, customer, status, interval, current_period_end, held, updated_at, synced_at)
    VALUES ('sub_ada', '${ada.user.id}', 'cus_ada', 'active', 'month', ${now + 30 * 86400}, 0, ${now}, ${Date.now()})`);
  const A = (x = trip) => `/api/trips/${x}/assistant`;
  const asked = async (who, conv, words, id, x = trip) => {
    const r = await who.post(`${A(x)}/conversations/${conv}/ask`, { id, words });
    const lines = r.text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
    return { status: r.status, lines, steps: lines.filter((l) => l?.step).map((l) => l.step), turn: lines.find((l) => l?.turn)?.turn ?? null, json: r.json };
  };

  t.part("1. The wait is visible");
  await ben.post(`${A()}/conversations`, { id: "c-ben" });
  const places = [1, 2, 3].map((i) => ({ id: `cafe-${i}`, name: `Cafe ${i}`, kind: "food", subkind: "cafe", why: "Coffee by the water." }));
  model.next({ tools: [{ name: "put_places", arguments: { summary: "Three cafes by the lake", places } }], cost: 0.0002 });
  model.next({ words: "I added three cafes by the lake.", hang: 900 });
  // Read off the wire as it comes: each line's moment, so the steps are seen BEFORE the answer, not with it.
  const t0 = Date.now();
  const res = await fetch(`${origin}${A()}/conversations/c-ben/ask`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: ben.jar.header(), "CF-Connecting-IP": ben.address },
    body: JSON.stringify({ id: "ask-1", words: "Add three cafes by the lake." }) });
  const seen = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); seen.push({ at: Date.now() - t0, ...line }); }
  }
  const steps = seen.filter((l) => l.step).map((l) => l.step);
  const answer = seen.find((l) => l.turn);
  t.same("each step said in words from the step itself, in order, then the answer",
    [res.headers.get("content-type")?.split(";")[0], steps, answer?.turn?.words], ["application/x-ndjson", ["Working out what to do…", "Adding or changing 3 places…", "Working out the next step…"], "I added three cafes by the lake."]);
  const lastStep = seen.filter((l) => l.step).at(-1);
  t.ok("  as they happen: the last step on the wire well before the answer (the model took 900 ms over it)", answer && lastStep && answer.at - lastStep.at >= 700, `last step at ${lastStep?.at} ms, answer at ${answer?.at} ms`);
  t.same("  and kept on the answer, so a conversation opened again shows them", answer?.turn?.detail?.steps, ["Working out what to do", "Adding or changing 3 places", "Working out the next step"]);
  t.same("  with the tools each call of the model asked for, by name, call by call (the bake-off's record of what a model used)", answer?.turn?.detail?.asked, [["put_places"], []]);

  t.part("2. What it writes");
  const change = server.sql(`SELECT user_id, source, summary FROM trip_changes WHERE trip_id = '${trip}' ORDER BY created_at DESC LIMIT 1`)[0];
  const did = answer?.turn?.detail?.did ?? [];
  t.same("a change as the person who asked, from the assistant, in the trip's list of changes, its summary the model's",
    [change?.user_id, change?.source, change?.summary, server.sql(`SELECT COUNT(*) AS n FROM places WHERE trip_id = '${trip}' AND id LIKE 'cafe-%'`)[0].n], [ben.user.id, "assistant", "Three cafes by the lake", 3]);
  t.same("  and the answer names what it did, with the change's id", [did.length, did[0]?.words, did[0]?.ok, typeof did[0]?.change_id], [1, "Adding or changing 3 places", true, "string"]);

  t.part("3. The caps");
  await cleo.post(`${A()}/conversations`, { id: "c-cleo" });
  for (let i = 0; i < TALK.steps; i++) model.next({ tools: [{ name: "list_events", arguments: {} }] });
  const many = await asked(cleo, "c-cleo", "Read the plans over and over.", "ask-2");
  t.same(`the step cap (${TALK.steps} calls of the model): it stops, saying so`, [TALK.steps, many.status, many.turn?.detail?.stopped, many.steps.filter((s) => s.startsWith("Working out")).length], [16, 200, "steps", 16]);
  t.ok("  with what it did and that the rest isn't done", new RegExp(`most steps I take for one question \\(${TALK.steps}\\)`).test(many.turn?.words ?? "") && /I didn't change anything\. The rest of what you asked isn't done: say continue to finish\./.test(many.turn?.words ?? ""), many.turn?.words);
  t.same("  a tool the last step calls anyway is not run: only the first fifteen steps' tools ran",
    many.steps.filter((x) => !x.startsWith("Working out")).length, TALK.steps - 1);
  // ...and the last step was asked for words: its request offers the tools with tool_choice "none" and one closing line.
  const lastReq = model.calls.at(-1)?.body;
  t.ok(`  its last request (the ${TALK.steps}th) offered the tools with tool_choice "none", told to answer in words; the ones before, "auto"`,
    lastReq?.tool_choice === "none" && lastReq?.tools?.length > 0 && lastReq?.messages?.at(-1)?.role === "system" && /last step: answer now in words/.test(lastReq?.messages?.at(-1)?.content ?? "")
      && model.calls.at(-2)?.body?.tool_choice === "auto",
    JSON.stringify({ choice: lastReq?.tool_choice, lastRole: lastReq?.messages?.at(-1)?.role, before: model.calls.at(-2)?.body?.tool_choice }));
  // A model that answers its last step in words: those words are the answer, said in the model's own terms.
  for (let i = 0; i < TALK.steps - 1; i++) model.next({ tools: [{ name: "list_events", arguments: {} }] });
  model.next({ words: "I read the plans fifteen times and wrote nothing. Left: the rest of the reading. Say continue to finish." });
  const worded = await asked(cleo, "c-cleo", "Read the plans over and over, once more.", "ask-2b");
  t.same("  a last step answered in words: that is the answer (not the canned stop), and nothing more was called",
    [worded.status, worded.turn?.detail?.stopped ?? null, worded.turn?.words, model.calls.at(-1)?.body?.tool_choice], [200, null, "I read the plans fifteen times and wrote nothing. Left: the rest of the reading. Say continue to finish.", "none"]);
  // 12,000 written in all (TALK.askTokens): two calls that say they wrote 6,500 each pass it.
  model.next({ tools: [{ name: "put_events", arguments: { summary: "A swim", events: [{ id: "swim", kind: "plan", title: "Morning swim", starts: "2027-06-02T08:00", tz: "UTC" }] } }], usage: { completion_tokens: 6500 } });
  model.next({ tools: [{ name: "list_events", arguments: {} }], usage: { completion_tokens: 6500 } });
  const long = await asked(cleo, "c-cleo", "Plan the whole week in detail.", "ask-3");
  t.ok("the token cap: it stops, saying so, what it did, and that the rest isn't done",
    long.turn?.detail?.stopped === "tokens" && /most I can write for one question.*What I did: Adding or changing 1 plan\..*isn't done/.test(long.turn?.words ?? ""), long.turn?.words);
  t.same("  the cap is 12,000 written an ask", TALK.askTokens, 12000);
  // Each call may write 4,000 (TALK.maxTokens; a thinking model's thinking counts in it), the last one what is left of
  // the ask's 12,000; and each call is held on the host's month at its own worst case, at that number.
  model.next({ tools: [{ name: "list_events", arguments: {} }], usage: { completion_tokens: 5000 } });
  model.next({ tools: [{ name: "list_events", arguments: {} }], usage: { completion_tokens: 5000 } });
  model.next({ words: "Read." });
  const callsBefore = model.calls.length;
  const sized = await asked(cleo, "c-cleo", "Read the plans three times.", "ask-sized");
  const maxes = model.calls.slice(callsBefore).map((c) => c.body?.max_tokens);
  const worsts = server.sql(`SELECT worst FROM ai_calls WHERE trip_id = '${trip}' ORDER BY started_at DESC, rowid DESC LIMIT 3`).map((r) => r.worst).reverse();
  const OUT = 0.5;   // ASSISTANT_PRICE_OUTPUT: micro-dollars a token
  t.ok(`each call may write ${TALK.maxTokens}, the last what is left of the ask's ${TALK.askTokens}: [4000, 4000, 2000]; each held at its own worst case`,
    TALK.maxTokens === 4000 && sized.status === 200 && JSON.stringify(maxes) === "[4000,4000,2000]" && worsts.length === 3
      && worsts[0] >= 4000 * OUT && worsts[1] >= 4000 * OUT && worsts[2] >= 2000 * OUT && worsts[2] < worsts[1],
    JSON.stringify({ maxes, worsts }));
  // The hold: renewed as each step begins, so a long ask keeps its trip. Step 1 hangs 1.5 s, step 2 hangs 3 s: during
  // step 2 its busy_until stands askSeconds after step 2 began, past where it started.
  model.next({ tools: [{ name: "list_events", arguments: {} }], hang: 1500 });
  model.next({ tools: [{ name: "list_events", arguments: {} }], hang: 3000 });
  model.next({ words: "Read twice." });
  const going = asked(cleo, "c-cleo", "Read the plans twice, slowly.", "ask-hold");
  await sleep(2600);
  const mid = server.sql(`SELECT started_at, busy_until FROM ai_asks WHERE trip_id = '${trip}'`)[0] ?? null;
  const twice = await going;
  t.ok(`an ask keeps its trip while it works: its hold renewed as each step begins (busy_until ${TALK.askSeconds} s after the step, not the start)`,
    !!mid && mid.busy_until >= mid.started_at + TALK.askSeconds + 1 && twice.status === 200 && twice.turn?.words === "Read twice.", JSON.stringify({ mid, status: twice.status, words: twice.turn?.words }));
  // Taken over: another ask holds the trip (its hold had lapsed): this one stops before its next step, saying so.
  model.next({ tools: [{ name: "list_events", arguments: {} }], hang: 2000 });
  model.next({ tools: [{ name: "list_events", arguments: {} }] });
  const lost = asked(cleo, "c-cleo", "Read the plans again.", "ask-lost");
  await sleep(1000);
  server.sql(`UPDATE ai_asks SET ask_id = 'another-ask' WHERE trip_id = '${trip}'`);
  const stopped = await lost;
  server.sql(`DELETE FROM ai_asks WHERE trip_id = '${trip}' AND ask_id = 'another-ask'`);
  t.ok("  one whose hold another ask took stops before its next step, saying so and that the rest isn't done",
    stopped.turn?.detail?.stopped === "held" && /^Another question on this trip started while I was paused, so I stopped before finishing\..*isn't done/.test(stopped.turn?.words ?? ""), stopped.turn?.words);
  // A model that thinks can spend its whole max_tokens thinking: finish "length", no words, no calls. Never "Done.".
  model.next({ words: null, finish: "length" });
  const cut = await asked(cleo, "c-cleo", "Think the whole week through.", "ask-cut");
  t.ok("a model that ran out of room before answering (finish length, no words, no calls): it says so and that nothing changed, never \"Done.\"",
    cut.turn?.detail?.stopped === "cut-off" && /^I ran out of room before I could answer, so I stopped\. I didn't change anything\./.test(cut.turn?.words ?? ""), cut.turn?.words);
  model.next({ words: "" });
  const blank = await asked(cleo, "c-cleo", "Anything to add?", "ask-blank");
  t.ok("  an answer with no words at all says so too", blank.turn?.detail?.stopped === "empty" && /^I came back without an answer\. I didn't change anything\./.test(blank.turn?.words ?? ""), blank.turn?.words);
  // Places too many to send whole: every place in short (by area), saying so, and how to get the whole cards.
  const longList = Array.from({ length: 150 }, (_, i) => ({ id: `many-${i}`, name: `Made-up place ${i}`, kind: "sight", subkind: "viewpoint",
    why: `A made-up reason, long enough that a long trip's places can't all be sent at once: ${"x".repeat(300)}` }));
  const put = await cleo.call("PUT", `/api/trips/${trip}/places`, { places: longList });
  model.next({ tools: [{ name: "list_places", arguments: {} }] });
  model.next({ words: "Every place, in short." });
  const before = model.calls.length;
  const listed = await asked(cleo, "c-cleo", "List every place.", "ask-many");
  const sent = model.calls.slice(before).flatMap((c) => (c.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content))).at(-1) ?? "";
  let shown = null;
  try { shown = JSON.parse(sent); } catch { /* told below */ }
  const total = server.sql(`SELECT COUNT(*) AS n FROM places WHERE trip_id = '${trip}'`)[0].n;
  const rows = Object.values(shown?.places_by_area ?? {}).flat();
  t.ok(`places too many to send whole (${total}): every one in short, by area, with a line saying so and how to get the cards`,
    put.status === 200 && listed.status === 200 && shown && Object.keys(shown)[0] === "note" && /too many to send whole/.test(shown.note) && /their ids/.test(shown.note)
      && rows.length === total && rows.every((r) => Array.isArray(r) && r.length === 3) && sent.length <= 20000,
    JSON.stringify({ put: put.status, note: shown?.note, rows: rows.length, length: sent.length, start: sent.slice(0, 120) }));

  // After a fallback, each model is handed back only the reasoning it wrote: another provider's format may be refused
  // with a 400 that looks like ours (which never falls back), and the ask would end.
  {
    const FIRST = [{ type: "reasoning.text", text: "the first model thinks it through", format: "google-gemini-v1" }];
    const SECOND = [{ type: "reasoning.encrypted", data: "the-fallback-thought-sealed", format: "openai-responses-v1" }];
    model.next({ tools: [{ name: "list_events", arguments: {} }], reasoning_details: FIRST });
    model.next({ status: 502, errorBody: { message: "Provider returned error", code: 502, metadata: { provider_name: "Stand-in Cloud" } } });
    model.next({ tools: [{ name: "list_events", arguments: {} }], reasoning_details: SECOND });
    model.next({ words: "Read with two models." });
    const at = model.calls.length;
    const two = await asked(cleo, "c-cleo", "Read the plans with whichever model answers.", "ask-two-models");
    const reqs = model.calls.slice(at).map((c) => ({ model: c.body?.model, sent: JSON.stringify(c.body?.messages ?? []) }));
    t.same("a refused call answered by the fallback, the ask going on: four calls, the first model, it again (refused), the fallback, the first",
      [two.status, two.turn?.words, reqs.map((r) => r.model)], [200, "Read with two models.", ["check/model-1", "check/model-1", "check/fallback-1", "check/model-1"]]);
    t.ok("  the fallback is sent none of the first model's reasoning; the first model is sent its own, and none of the fallback's",
      !reqs[2].sent.includes("the first model thinks") && reqs[3].sent.includes("the first model thinks") && !reqs[3].sent.includes("the-fallback-thought-sealed"),
      JSON.stringify(reqs.map((r) => [r.model, r.sent.includes("the first model thinks"), r.sent.includes("the-fallback-thought-sealed")])));
    t.ok("  and no request carries the loop's own mark of who wrote what", reqs.every((r) => !r.sent.includes("wrote_by")), "");
  }

  t.part("4. One ask at a time, again, used up, no plan");
  model.next({ words: "Slow answer.", hang: 1500 });
  model.next({ words: "The other trip's answer." });
  const slow = asked(ben, "c-ben", "Take your time.", "ask-4");
  await new Promise((r) => setTimeout(r, 300));
  const second = await asked(cleo, "c-cleo", "Me too.", "ask-5");
  await cleo.post(`${A(trip2)}/conversations`, { id: "c-cleo-2" });
  const elsewhere = await asked(cleo, "c-cleo-2", "And on the other trip?", "ask-6", trip2);
  await slow;
  t.same("a second ask on the same trip while one runs: refused in words; another trip's goes on",
    [second.status, second.json?.error, /answering someone on this trip/.test(second.json?.reason ?? ""), elsewhere.status, elsewhere.turn?.words], [429, "busy", true, 200, "The other trip's answer."]);
  const calls = model.calls.length;
  const again = await asked(ben, "c-ben", "Add three cafes by the lake.", "ask-1");
  t.same("an ask sent again (the same id) gets its answer, and the model isn't asked again", [again.status, again.turn?.words, model.calls.length - calls], [200, "I added three cafes by the lake.", 0]);
  server.sql(`INSERT INTO ai_calls (id, host_id, trip_id, user_id, month, feature, state, worst, cost, started_at, busy_until, model)
    VALUES ('fill', '${ada.user.id}', '${trip2}', NULL, '${new Date().toISOString().slice(0, 7)}', 'ask', 'settled', 0, 2000000, ${now}, ${now}, 'm')`);
  const usedUp = await asked(cleo, "c-cleo", "Anything else?", "ask-7");
  t.ok("the host's month used up: refused before anything is kept, in words with the day it's back",
    usedUp.status === 402 && usedUp.json?.error === "used up" && /back on/.test(usedUp.json?.reason ?? "") && !server.sql(`SELECT id FROM ai_turns WHERE id = 'ask-7'`).length, JSON.stringify(usedUp.json));
  server.sql("DELETE FROM ai_calls WHERE id = 'fill'");
  const solo = (await dev.post("/api/trips", { name: "Dev's trip", default_tz: "UTC" })).json.trip.id;
  await dev.post(`${A(solo)}/conversations`, { id: "c-dev" });
  const noPlan = await asked(dev, "c-dev", "Hello?", "ask-8", solo);
  t.same("a host with no plan: refused before anything is kept", [noPlan.status, noPlan.json?.error, server.sql("SELECT COUNT(*) AS n FROM ai_turns WHERE id = 'ask-8'")[0].n], [402, "no plan", 0]);

  t.part("4b. The host's numbers, and off for one trip");
  {
    const hostView = (await ada.get(A())).json;
    const memberView = (await ben.get(A())).json;
    t.ok("the host sees the month (allowance, used, when it's back) and this trip's line; a member sees no numbers",
      hostView?.host?.allowance === 2_000_000 && hostView.host.used > 0 && hostView.host.trip?.calls > 0 && hostView.host.trip.used > 0 && /^\d{4}-\d{2}$/.test(hostView.host.month) && !("host" in (memberView ?? {})) && !JSON.stringify(memberView).includes("allowance"),
      JSON.stringify(hostView?.host));
    const month = (await ada.get("/api/account/plan")).json?.assistant_month;
    t.ok("the account's plan: the month per trip the host hosts, by name, never per person",
      month?.trips?.some((x) => x.trip_id === trip && x.name === "Lake week" && x.calls > 0) && month.trips.every((x) => Object.keys(x).sort().join() === "calls,name,trip_id,used"), JSON.stringify(month).slice(0, 300));
    const notHost = await ben.call("PUT", `${A()}/off`, { off: true });
    const turnedOff = await ada.call("PUT", `${A()}/off`, { off: true });
    t.same("only the host turns it off for the trip", [notHost.status, notHost.json?.reason, turnedOff.status, turnedOff.json?.off], [403, "Only the trip's host can do that.", 200, true]);
    const room = (await ben.get(A())).json?.room;
    await ben.post(`${A()}/conversations`, { id: "c-ben-off" });
    const askOff = await asked(ben, "c-ben-off", "Anything?", "ask-off");
    const chatOff = await ben.post(`/api/trips/${trip}/messages`, { id: "m-off", body: "@assistant anything?" });
    t.same("off: a member's room says so, an ask is refused in words, the chat's @assistant posts the message and tells only its sender why",
      [room, askOff.status, askOff.json?.error, askOff.json?.reason, chatOff.status, chatOff.json?.assistant?.error], [{ offered: true, on: false, off_by_host: true }, 402, "off", "The trip's host has turned the assistant off on this trip.", 201, "off"]);
    await ada.call("PUT", `${A()}/off`, { off: false });
    model.next({ words: "Back on." });
    const onAgain = await asked(ben, "c-ben-off", "Anything now?", "ask-on");
    t.same("  and on again, it answers", [onAgain.status, onAgain.turn?.words], [200, "Back on."]);
  }

  t.part("5. A conversation, kept and gone");
  const extraConv = await ada.post(`${A()}/conversations`, { id: "c-ada", colour: "blue" });
  model.next({ words: "Hello." });
  const extraAsk = await ada.post(`${A()}/conversations/c-ada/ask`, { id: "ask-9", words: "Hi", mood: "cheerful" });
  const lastLine = extraAsk.text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).at(-1);
  t.same("a field they don't take is named, on a conversation's answer and on an ask's last line", [extraConv.json?.ignored, lastLine?.ignored, !!lastLine?.turn], [["colour"], ["mood"], true]);
  const madeAgain = await ben.post(`${A()}/conversations`, { id: "c-ben" });
  const taken = await ben.post(`${A(trip2)}/conversations`, { id: "c-ben" });
  t.same("made again with the same id: the same one; that id on another trip of his: refused in words", [madeAgain.status, madeAgain.json?.conversation?.id, taken.status, !!taken.json?.reason], [200, "c-ben", 409, true]);
  const read = (await ben.get(`${A()}/conversations/c-ben`)).json;
  t.same("its turns in order, the person's and the assistant's, with its title from the first words",
    [read?.conversation?.title, read?.turns?.map((x) => [x.seq, x.role])], ["Add three cafes by the lake.", [[1, "person"], [2, "assistant"], [3, "person"], [4, "assistant"]]]);
  const gone = await ben.call("DELETE", `${A()}/conversations/c-ben`);
  t.same("deleted: it and its turns", [gone.status, (await ben.get(`${A()}/conversations/c-ben`)).status, server.sql(`SELECT COUNT(*) AS n FROM ai_turns WHERE user_id = '${ben.user.id}' AND conversation_id = 'c-ben'`)[0].n], [200, 404, 0]);
  const cleoTurns = server.sql(`SELECT COUNT(*) AS n FROM ai_turns WHERE user_id = '${cleo.user.id}'`)[0].n;
  await cleo.call("DELETE", "/api/me", { confirm: "delete" });
  t.same("an account deleted takes every conversation of its own", [cleoTurns > 0, server.sql(`SELECT COUNT(*) AS n FROM ai_turns WHERE user_id = '${cleo.user.id}'`)[0].n, server.sql(`SELECT COUNT(*) AS n FROM ai_conversations WHERE user_id = '${cleo.user.id}'`)[0].n], [true, 0, 0]);
  const failed = server.log().split("\n").filter((l) => /Uncaught|✘|\[ERROR\]/.test(l));
  t.ok("nothing failed inside the server", failed.length === 0, failed.slice(0, 3).join(" | "));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await server?.stop();
  await model?.close();
}
process.exit(code);

#!/usr/bin/env node
/* The assistant's screens (model §20; public/js/assistant.js, assistant-room.js and chat.js), in a real
 * browser, on servers of its own: one with the plan and the assistant on and a stand-in model on this
 * machine (nothing reaches a model), one without either. Three made-up people.
 *
 *   A. A SITE WITHOUT IT: nothing of it anywhere. No tabs in the chat, no hint when a message says
 *      @assistant, no "@assistant" in the box's words.
 *   B. WITH IT, every member asks the assistant for themselves:
 *      1. Chat has the tabs Group and Assistant, and the box says @assistant;
 *      2. a member's Assistant tab: where it stands in words ("has room this month"), no numbers, no
 *         switch; nothing yet;
 *   I. THE HOST: the switch, and no meter on any screen (no amounts on the Assistant tab or in a conversation); the
 *      account's plan card says nothing of the month until it runs low: planted at 0%, 50%, 85%, 100% of the
 *      allowance: nothing, nothing, "has used most of this month's room", "has used this month's room";
 *      3. a question from there opens its conversation, says each step while it works (the model held
 *         so the step can be read), then the answer, what it did (a change, with the way to Changes),
 *         how it got there;
 *   C. SHARING AN ANSWER: one press, and the group's chat on another phone shows the
 *      question and the answer as the asker's shared message; pressed again (a reload), never twice;
 *      a long answer comes folded, with Show all;
 *   D. @assistant IN THE GROUP'S CHAT, answered there: another phone sees "Assistant · asked by Ada",
 *      the step it is on while it works, then its words;
 *   E. WITH NO SIGNAL an ask is refused in words and never kept: in the assistant's box and in the chat
 *      (the words stay in the box; nothing waits; the signal back, the model is still never called);
 *   F. EVERY REFUSAL IN WORDS: the month used up (the line, the box, the chat's hint, "back on <day>");
 *      a trip whose host has no plan ("Ben can turn it on"), and a message there naming @assistant
 *      posts to the group with the assistant's refusal under it, for its sender;
 *   G. with WGP_SHOTS=<folder>, stills at 390, 320 with larger text (278 at 2.3) and 1440, light and
 *      dark: the chat with the assistant's and a shared message, the Assistant tab, a conversation;
 *      and at each, the chat box's words on one line;
 *   H. a conversation deleted by its own sheet (which says what deleting does; the first focus not on
 *      Delete): gone on the server, and what was shared to the group stays the group's;
 *   and no page error.
 *
 *   node scripts/assistant_screens_check.mjs           (sandbox off; through the channel's queue)
 *
 * PLANTED (red when put in by hand): chat.js's submit without the no-signal refusal (E: the message
 * waits, and the model is called when the signal comes back); tabsHtml() without its "offered" test
 * (A); foldHtml() never folding (C).
 */
import fs from "node:fs";
import path from "node:path";
import { CheckError, startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { startModel } from "../checks/lib/model-standin.mjs";
import { openChrome } from "../checks/lib/chrome.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const KEY = "sk-or-check-not-real";
let model = null, withIt = null, without = null, chrome = null;
const pageErrors = [];
try {
  model = await startModel({ key: KEY });
  withIt = await startServer({
    name: "assistant-screens", port: await freeLoopbackPort(),
    vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true",
      ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5", OPENROUTER_API_BASE: model.base },
    secrets: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", OPENROUTER_API_KEY: KEY },
  });
  without = await startServer({ name: "assistant-screens-without", port: await freeLoopbackPort() });
  ownServer(withIt.origin);
  ownServer(without.origin);
  await withIt.start();
  await without.start();

  // ── the people and their trips ───────────────────────────────────────────────────────────
  const peopleOn = async (server) => {
    const ps = Object.fromEntries(["Ada Reyes", "Ben Okafor", "Cleo Tran"].map((n) => [n.split(" ")[0].toLowerCase(), new Person(server.origin, n)]));
    for (const p of Object.values(ps)) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
    return ps;
  };
  const tripOf = async (host, others, name) => {
    const made = await host.post("/api/trips", { name, default_tz: "UTC", starts_on: "2027-06-01", ends_on: "2027-06-07" });
    if (made.status !== 201) throw new CheckError(`trip ${name}: ${made.status}`);
    const id = made.json.trip.id;
    for (const p of others) await p.post(`/api/join/${(await host.post(`/api/trips/${id}/links`, { uses: 1 })).json.link.code}`);
    return id;
  };
  const on = await peopleOn(withIt);
  const off = await peopleOn(without);
  const lake = await tripOf(on.ada, [on.ben, on.cleo], "Lake week");          // Ada hosts it, with the plan
  const coast = await tripOf(on.ben, [on.ada], "Coast weekend");             // Ben hosts it, no plan
  const plain = await tripOf(off.ada, [off.ben], "Lake week");               // a site without any of it
  const now = Math.floor(Date.now() / 1000);
  withIt.sql(`INSERT INTO billing_subscriptions (id, user_id, customer, status, interval, current_period_end, held, updated_at, synced_at)
    VALUES ('sub_ada', '${on.ada.user.id}', 'cus_ada', 'active', 'month', ${now + 30 * 86400}, 0, ${now}, ${Date.now()})`);
  check("made up: a trip whose host has the plan, a trip whose host hasn't, a site without either", !!lake && !!coast && !!plain);

  chrome = await openChrome();
  const pageAs = async (server, who, { width = 390, height = 844, mobile = true } = {}) => {
    const page = await chrome.page({ width, height, mobile, passkeys: false });
    await page.setCookie(server.origin, "wgp_session", who.jar.cookies.get("wgp_session"));
    await page.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: encodeURIComponent(who.user.id), sameSite: "Lax" });
    await page.send("Network.enable");
    await page.send("Runtime.enable");
    page.on((m) => { if (m.method === "Runtime.exceptionThrown") pageErrors.push(`${who.name}: ${m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text}`.slice(0, 300)); });
    return page;
  };
  const offline = (page, yes) => page.send("Network.emulateNetworkConditions", { offline: yes, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const go = async (page, server, trip, hash) => { await page.goto(`${server.origin}/t/${trip}/${hash}`); await page.settle(); };
  const read = (page, expr) => page.eval(expr);
  const text = (page, sel) => page.eval(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`);
  const shown = (page, sel) => page.eval(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return false; const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== "hidden"; })()`);
  const typeIn = async (page, sel, words) => {
    await page.eval(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.focus(); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
    await page.type(sel, words);
  };
  const send = (page, formSel) => page.eval(`(document.querySelector(${JSON.stringify(formSel)}).requestSubmit(), 1)`);

  // ═══ A. a site without it ═══════════════════════════════════════════════════════════════
  section("A. a site without the assistant: nothing of it");
  {
    const p = await pageAs(without, off.ben);
    await go(p, without, plain, "#/chat");
    await p.until(`document.querySelector(".ch-input") ? 1 : 0`, "the chat");
    await sleep(800);
    check("no tabs in the chat", !(await shown(p, ".ch-tabs")), await read(p, `document.querySelector(".ch-tabs-slot")?.innerHTML ?? "no slot"`));
    check("the box says nothing of the assistant", (await read(p, `document.querySelector(".ch-input").placeholder`)) === "Message the group", await read(p, `document.querySelector(".ch-input").placeholder`));
    await typeIn(p, ".ch-input", "@assistant what time is it?");
    await sleep(300);
    check("a message saying @assistant gets no hint", !(await shown(p, ".ch-ai-hint")), await text(p, ".ch-ai-hint"));
    await p.close();
  }

  // ═══ B. the person's own conversation ═══════════════════════════════════════════════════
  section("B. talking to the assistant: a member's own conversation");
  const ben = await pageAs(withIt, on.ben);
  {
    await go(ben, withIt, lake, "#/chat");
    await ben.until(`document.querySelector(".ch-tabs") ? 1 : 0`, "the chat's tabs");
    const tabs = JSON.parse(await read(ben, `JSON.stringify([...document.querySelectorAll(".ch-tab")].map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-current")]))`));
    check("Chat has the tabs Group (open) and Assistant", JSON.stringify(tabs) === JSON.stringify([["Group", "#/chat", "page"], ["Assistant", "#/chat/assistant", null]]), JSON.stringify(tabs));
    await ben.until(`document.querySelector(".ch-input").placeholder === "Message or @assistant" ? 1 : 0`, "the box's words", 5000).catch(() => {});
    check("the box says @assistant", (await read(ben, `document.querySelector(".ch-input").placeholder`)) === "Message or @assistant", await read(ben, `document.querySelector(".ch-input").placeholder`));
    await ben.click('.ch-tab[href="#/chat/assistant"]');
    await ben.until(`document.querySelector(".as-room-line") ? 1 : 0`, "the Assistant tab");
    await ben.until(`document.querySelector(".as-empty, .as-list") ? 1 : 0`, "its conversations read");
    check("a member reads where it stands in words, no numbers, no switch", (await text(ben, ".as-room-line")) === "The assistant has room this month." && !(await shown(ben, ".as-room-host")) && !(await shown(ben, 'input[data-act="ai-on"]')),
      `${await text(ben, ".as-room-line")} | host line ${await shown(ben, ".as-room-host")}`);
    check("nothing yet: it says what it can do", (await text(ben, ".as-empty")).includes("Every change it makes is in Changes"), await text(ben, ".as-empty"));
    if (SHOTS) await ben.shot(path.join(SHOTS, "390-light-assistant-empty.png"));

    const calls0 = model.calls.length;
    // Each model call held 1.5 s, so each step stays on the screen long enough to be read.
    model.next({ tools: [{ name: "get_trip", arguments: {} }], hang: 1500 });
    model.next({ tools: [{ name: "update_trip", arguments: { summary: "Interests noted", interests: "Boats, swimming, the north pier" } }], hang: 1500 });
    model.next({ words: "The boat leaves at nine from the north pier. I've noted boats and swimming as the trip's interests.", hang: 1500 });
    await typeIn(ben, "#as-input", "When does the boat leave? And note that we like boats and swimming.");
    await send(ben, ".as-box");
    await ben.until(`/^#\\/chat\\/assistant\\/.+/.test(location.hash) ? 1 : 0`, "its conversation opened");
    // What the page says while it works, every 100 ms: each step the server says, in turn, as it is taken.
    const seen = [];
    for (let i = 0; i < 120 && !(await read(ben, `!!document.querySelector(".as-a:not(.as-working)")`)); i++) {
      const s = await read(ben, `(document.querySelector(".as-step") || {}).textContent || ""`);
      if (s && seen[seen.length - 1] !== s) seen.push(s);
      await sleep(100);
    }
    const first = seen.indexOf("Working out what to do…"), next = seen.indexOf("Working out the next step…");
    check("while it works, the step it is on, in words, each as it is taken (the lines come as they're said)", first >= 0 && next > first, JSON.stringify(seen));
    const qs = JSON.parse(await read(ben, `JSON.stringify([...document.querySelectorAll("#view .as-q")].map((n) => n.textContent.slice(0, 40)))`));
    check("the question shows at once, once", qs.length === 1, JSON.stringify(qs));
    await ben.until(`document.querySelector(".as-a:not(.as-working) .as-a-body") ? 1 : 0`, "the answer", 20000);
    const ans = JSON.parse(await read(ben, `JSON.stringify({ body: document.querySelector(".as-a-body").textContent, did: [...document.querySelectorAll(".as-did li")].map((l) => l.textContent), link: document.querySelector(".as-did-link")?.getAttribute("href"), steps: document.querySelector(".as-steps summary")?.textContent, title: document.querySelector(".as-title").textContent })`));
    check("the answer, what it did (with the way to Changes) and how it got there", /nine from the north pier/.test(ans.body) && ans.did.length === 1 && /Changing the trip's details/.test(ans.did[0]) && ans.link === "#/changes" && /\d steps/.test(ans.steps || ""), JSON.stringify(ans));
    check("the conversation is named by its first question", /^When does the boat leave/.test(ans.title), ans.title);
    check("three model calls for it, and the change is on the trip", model.calls.length - calls0 === 3 && (await on.ada.get(`/api/trips/${lake}`)).json?.trip?.interests === "Boats, swimming, the north pier", `${model.calls.length - calls0} calls`);
  }

  // ═══ C. Share with group ════════════════════════════════════════════════════════════════
  section("C. Share with group, one press");
  const ada = await pageAs(withIt, on.ada);
  {
    await ben.click('[data-act="share"]');
    await ben.until(`document.querySelector(".as-shared") ? 1 : 0`, "shared");
    check("one press: it says it's shared, with the way to the chat", /Shared with the group/.test(await text(ben, ".as-shared")) && (await read(ben, `document.querySelector(".as-shared a")?.getAttribute("href")`)) === "#/chat");
    await go(ada, withIt, lake, "#/chat");
    await ada.until(`document.querySelector(".ch-shared") ? 1 : 0`, "the shared answer in Ada's chat", 15000);
    const sh = JSON.parse(await read(ada, `JSON.stringify({ t: document.querySelector(".ch-shared .ch-shared-t").textContent, q: document.querySelector(".ch-shared .ch-shared-q").textContent, a: document.querySelector(".ch-shared .ch-body").textContent, sq: !!document.querySelector(".ch-shared .ch-sq"), names: document.querySelectorAll(".ch-shared .ch-name").length })`));
    check("another phone's chat: the asker's shared message, the question over the answer", sh.t === "Ben shared the assistant's answer" && /When does the boat leave/.test(sh.q) && /nine from the north pier/.test(sh.a) && sh.sq && sh.names === 0, JSON.stringify(sh));
    await go(ben, withIt, lake, `#/chat/assistant/${encodeURIComponent(await read(ben, `decodeURIComponent(location.hash.split("/").pop())`))}`);
    await ben.until(`document.querySelector(".as-a .as-a-body") ? 1 : 0`, "the conversation after a reload");
    const sharedTwice = (await on.ada.get(`/api/trips/${lake}/messages?limit=100`)).json.messages.filter((m) => m.kind === "shared").length;
    check("after a reload it still says shared, and the chat has it once", (await shown(ben, ".as-shared")) && sharedTwice === 1, `${sharedTwice} shared`);

    // A long answer, shared, comes folded.
    const long = Array.from({ length: 14 }, (_, i) => `Day ${i + 1}: a long walk round the lake, lunch at the north pier, and the boat back before dark.`).join("\n");
    model.next({ words: long });
    await typeIn(ben, "#as-input", "Plan every day for us.");
    await send(ben, ".as-box");
    await ben.until(`document.querySelectorAll(".as-a:not(.as-working)").length === 2 ? 1 : 0`, "the long answer", 20000);
    check("an answer given straight off says nothing of how it got there", (await read(ben, `[...document.querySelectorAll(".as-a")].pop().querySelectorAll(".as-steps").length`)) === 0);
    await ben.eval(`([...document.querySelectorAll('[data-act="share"]')].pop().click(), 1)`);
    await ben.until(`document.querySelectorAll(".as-shared").length === 2 ? 1 : 0`, "the long one shared");
    await ada.until(`document.querySelectorAll(".ch-shared").length === 2 ? 1 : 0`, "the long one in Ada's chat", 15000);
    const fold = JSON.parse(await read(ada, `JSON.stringify((() => { const li = [...document.querySelectorAll(".ch-shared")].pop(); const f = li.querySelector(".ch-fold"); const b = li.querySelector(".ch-fold-btn"); return { folded: !!f && f.getBoundingClientRect().height < f.scrollHeight - 20, btn: b?.textContent, h: f?.getBoundingClientRect().height }; })())`));
    check("a long answer comes folded, with Show all", fold.folded && fold.btn === "Show all", JSON.stringify(fold));
    await ada.eval(`([...document.querySelectorAll(".ch-shared")].pop().querySelector(".ch-fold-btn").click(), 1)`);
    await ada.settle();
    const opened = JSON.parse(await read(ada, `JSON.stringify((() => { const li = [...document.querySelectorAll(".ch-shared")].pop(); const f = li.querySelector(".ch-fold"); return { open: f.getBoundingClientRect().height >= f.scrollHeight - 2, btn: li.querySelector(".ch-fold-btn").textContent, last: f.textContent.includes("Day 14") }; })())`));
    check("Show all opens it whole, and says Show less", opened.open && opened.btn === "Show less" && opened.last, JSON.stringify(opened));
  }

  // ═══ D. @assistant in the chat ══════════════════════════════════════════════════════════
  section("D. @assistant in the group chat");
  {
    await go(ben, withIt, lake, "#/chat");
    await ben.until(`document.querySelector(".ch-input") ? 1 : 0`, "Ben's chat");
    model.next({ tools: [{ name: "list_events", arguments: {} }], hang: 2500 });
    model.next({ tools: [{ name: "list_places", arguments: {} }], hang: 2500 });
    model.next({ words: "Nothing is planned for the first morning yet: the boat at nine is the first thing.", hang: 2500 });
    await typeIn(ada, ".ch-input", "@assistant what's on the first morning?");
    await ada.settle();
    check("Ada's box says the assistant answers in the chat, for everyone", (await text(ada, ".ch-ai-hint")) === "The assistant answers in the chat, for everyone on the trip.", await text(ada, ".ch-ai-hint"));
    await send(ada, ".ch-box");
    await ben.until(`document.querySelector(".ch-ai .ch-ai-working") ? 1 : 0`, "Ben sees it working", 15000);
    const w = JSON.parse(await read(ben, `JSON.stringify({ name: document.querySelector(".ch-ai .ch-name").textContent, step: document.querySelector(".ch-ai .ch-ai-working").textContent })`));
    const steps = [w.step];
    let still = false;
    for (let i = 0; i < 120 && !(await read(ben, `!!document.querySelector(".ch-ai .ch-body")`)); i++) {
      const st = await read(ben, `(document.querySelector(".ch-ai .ch-ai-working") || {}).textContent || ""`);
      if (st && steps[steps.length - 1] !== st) steps.push(st);
      // The still of it working, once the steps have been seen changing (it takes longer than a step).
      if (SHOTS && !still && steps.length >= 2) { still = true; await ben.shot(path.join(SHOTS, "390-light-chat-working.png")); }
      await sleep(100);
    }
    check("another phone: \"Assistant · asked by Ada\", and the step it is on, changing as it works", w.name === "Assistant · asked by Ada" && steps.includes("Working out what to do…") && steps.indexOf("Working out the next step…") > steps.indexOf("Working out what to do…"), JSON.stringify({ name: w.name, steps }));
    await ben.until(`document.querySelector(".ch-ai .ch-body") ? 1 : 0`, "the answer in Ben's chat", 20000);
    check("then its words, in its place", /boat at nine is the first thing/.test(await text(ben, ".ch-ai .ch-body")));
    check("its own mark, never the asker's initials", (await read(ben, `!!document.querySelector(".ch-ai .ch-ai-sq svg") && !document.querySelector(".ch-ai .ch-ai-sq").textContent.trim()`)) === true);
  }

  // ═══ E. no signal ═══════════════════════════════════════════════════════════════════════
  section("E. with no signal an ask is refused in words, never kept");
  {
    const calls0 = model.calls.length;
    const msgs0 = (await on.ada.get(`/api/trips/${lake}/messages?limit=100`)).json.messages.length;
    await go(ben, withIt, lake, "#/chat/assistant");
    await ben.until(`document.querySelector("#as-input") ? 1 : 0`, "Ben's Assistant tab");
    await offline(ben, true);
    await ben.until(`navigator.onLine === false ? 1 : 0`, "the phone offline");
    await typeIn(ben, "#as-input", "Is the pier open on Sunday?");
    await send(ben, ".as-box");
    await sleep(500);
    check("the assistant's box: refused in words, the question still in it", /No signal: asking the assistant needs signal/.test(await text(ben, ".as-said")) && (await read(ben, `document.querySelector("#as-input").value`)) === "Is the pier open on Sunday?",
      `${await text(ben, ".as-said")} | ${await read(ben, `document.querySelector("#as-input").value`)}`);
    await go(ben, withIt, lake, "#/chat").catch(() => {});
    await ben.until(`document.querySelector(".ch-input") ? 1 : 0`, "Ben's chat, offline");
    await typeIn(ben, ".ch-input", "@assistant is the pier open on Sunday?");
    await ben.settle();
    check("the chat's box: its hint says no signal before sending", /No signal: a message that asks the assistant isn't sent/.test(await text(ben, ".ch-ai-hint")), await text(ben, ".ch-ai-hint"));
    await send(ben, ".ch-box");
    await sleep(500);
    const st = JSON.parse(await read(ben, `JSON.stringify({ hint: document.querySelector(".ch-ai-hint").textContent, value: document.querySelector(".ch-input").value, waiting: document.querySelectorAll(".ch-waiting").length })`));
    check("sent anyway: refused in words, still in the box, nothing waiting", /never by itself/.test(st.hint) && st.value === "@assistant is the pier open on Sunday?" && st.waiting === 0, JSON.stringify(st));
    await offline(ben, false);
    await ben.until(`navigator.onLine === true ? 1 : 0`, "the signal back");
    await sleep(4000);
    const msgs1 = (await on.ada.get(`/api/trips/${lake}/messages?limit=100`)).json.messages.length;
    check("the signal back: nothing was sent, the model never called", model.calls.length === calls0 && msgs1 === msgs0, `calls +${model.calls.length - calls0}, messages +${msgs1 - msgs0}`);
    await ben.eval(`(() => { const i = document.querySelector(".ch-input"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  }

  // ═══ F. refusals in words ═══════════════════════════════════════════════════════════════
  section("F. every refusal in words");
  {
    // The month used up: a settled call costing more than the whole allowance.
    const month = new Date().toISOString().slice(0, 7);
    withIt.sql(`INSERT INTO ai_calls (id, host_id, trip_id, user_id, month, feature, state, worst, cost, started_at, busy_until, settled_at, model)
      VALUES ('call-used-up', '${on.ada.user.id}', '${lake}', '${on.ada.user.id}', '${month}', 'ask', 'settled', 9000000, 9000000, ${now}, ${now}, ${now}, 'check/model-1')`);
    const back = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    await go(ben, withIt, lake, "#/chat/assistant");
    await ben.until(`/used this month's room/.test((document.querySelector(".as-room-line") || {}).textContent || "") ? 1 : 0`, "the used-up line");
    const line = await text(ben, ".as-room-line");
    check(`used up: the line says so, and the day it's back (${back})`, line === `The assistant has used this month's room on this trip's plan. It's back on ${back}.`, line);
    const boxNow = JSON.parse(await read(ben, `JSON.stringify({ disabled: document.querySelector("#as-input").disabled, said: document.querySelector(".as-said").hidden ? "" : document.querySelector(".as-said").textContent })`));
    const ph = await read(ben, `document.querySelector("#as-input").placeholder`);
    check("used up, the list: the box can't be used and says why in its own words; the card above says it whole", boxNow.disabled && boxNow.said === "" && ph === `Back on ${back}`, `${JSON.stringify(boxNow)} | ${ph}`);
    if (SHOTS) await ben.shot(path.join(SHOTS, "390-light-assistant-used-up.png"));
    const convNow = (await on.ben.get(`/api/trips/${lake}/assistant`)).json.conversations[0].id;
    await go(ben, withIt, lake, `#/chat/assistant/${convNow}`);
    await ben.until(`document.querySelector(".as-a") ? 1 : 0`, "a conversation, used up");
    const inConv = JSON.parse(await read(ben, `JSON.stringify({ disabled: document.querySelector("#as-input").disabled, said: document.querySelector(".as-said").hidden ? "" : document.querySelector(".as-said").textContent, card: !!document.querySelector("#view .as-room-line") })`));
    check("used up, a conversation: the box says why (no card there)", inConv.disabled && inConv.said === line && !inConv.card, JSON.stringify(inConv));
    await go(ben, withIt, lake, "#/chat");
    await ben.until(`document.querySelector(".ch-input") ? 1 : 0`, "Ben's chat");
    await typeIn(ben, ".ch-input", "@assistant anything?");
    await ben.settle();
    check("used up: the chat's hint says it, and that the message still goes", (await text(ben, ".ch-ai-hint")) === `${line} The message still goes to the group.`, await text(ben, ".ch-ai-hint"));
    await ben.eval(`(() => { const i = document.querySelector(".ch-input"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
    withIt.sql(`DELETE FROM ai_calls WHERE id = 'call-used-up'`);

    // A trip whose host has no plan.
    await go(ada, withIt, coast, "#/chat/assistant");
    await ada.until(`document.querySelector(".as-room-line") ? 1 : 0`, "Ada on Ben's trip");
    const noplan = await text(ada, ".as-room-line");
    check("a host without the plan: what it is, and who can turn it on", noplan === "The assistant answers questions about this trip and can change it for you. It comes with the host's plan: Ben can turn it on.", noplan);
    const np = JSON.parse(await read(ada, `JSON.stringify({ empty: (document.querySelector("#view .as-empty") || {}).textContent || "", ph: document.querySelector("#as-input").placeholder, disabled: document.querySelector("#as-input").disabled })`));
    check("there nothing invites asking: the empty state says what it does, the box says who can turn it on", !/Ask it anything/.test(np.empty) && /^What the assistant does/.test(np.empty) && np.ph === "Ben can turn it on" && np.disabled, JSON.stringify(np));
    if (SHOTS) await ada.shot(path.join(SHOTS, "390-light-assistant-no-plan.png"));
    await go(ada, withIt, coast, "#/chat");
    await ada.until(`document.querySelector(".ch-input") ? 1 : 0`, "Ada's chat on Ben's trip");
    check("there the box doesn't offer @assistant", (await read(ada, `document.querySelector(".ch-input").placeholder`)) === "Message the group");
    const calls0 = model.calls.length;
    await typeIn(ada, ".ch-input", "@assistant can you plan Saturday?");
    await send(ada, ".ch-box");
    await ada.until(`document.querySelector(".ch-msg .ch-failed") ? 1 : 0`, "the refusal under the message", 15000);
    const under = await text(ada, ".ch-msg .ch-failed");
    const there = (await on.ben.get(`/api/trips/${coast}/messages?limit=50`)).json.messages;
    check("the message goes to the group; under it, for its sender, why the assistant didn't answer", /^The assistant didn't answer: The assistant comes with the trip's host's plan/.test(under) && there.some((m) => m.body === "@assistant can you plan Saturday?") && !there.some((m) => m.kind === "assistant") && model.calls.length === calls0, under);
  }

  // ═══ I. the host: the switch, and no meter anywhere (migration 0034) ═════════════════════
  section("I. the host: the switch, and no amounts on any screen");
  {
    await go(ada, withIt, lake, "#/chat/assistant");
    await ada.until(`document.querySelector('#view input[data-act="ai-on"]') ? 1 : 0`, "the host's switch", 10000).catch(() => {});
    const served = (await on.ada.get(`/api/trips/${lake}/assistant`)).json.host;
    check("the server answers the host's numbers to the host alone (kept for the export, shown on no screen)", !!served && Number.isFinite(served?.trip?.calls) && !(await on.ben.get(`/api/trips/${lake}/assistant`)).json.host, JSON.stringify(served));
    // No meter: no amount, no "of", no count of calls, no line under the room's (the trip has used some: it was asked above).
    const METER = /\$\d|under \$|calls? to the model|All your trips|has used \$/;
    const hostView = JSON.parse(await read(ada, `JSON.stringify({ line: !!document.querySelector("#view .as-room-host"), words: document.querySelector("#view").innerText })`));
    check("the host's Assistant tab shows no amounts: no money, no calls, no line of numbers", !hostView.line && !METER.test(hostView.words) && served?.trip?.calls > 0, JSON.stringify({ ...hostView, words: hostView.words.slice(0, 300) }));
    // A conversation of the host's own (made here, removed by its id below).
    const made = await on.ada.post(`/api/trips/${lake}/assistant/conversations`, { id: "c-host-meter" });
    check("  (the host's own conversation, made for this)", made.status === 201, `${made.status}`);
    {
      await go(ada, withIt, lake, "#/chat/assistant/c-host-meter");
      await ada.until(`document.querySelector('#view input[data-act="ai-on"]') ? 1 : 0`, "the host's conversation, its switch", 10000).catch(() => {});
      const inConv = await read(ada, `document.querySelector("#view").innerText`);
      check("  nor in a conversation of theirs (the switch stays)", !METER.test(inConv) && (await read(ada, `!!document.querySelector('#view input[data-act="ai-on"]')`)) === true, inConv.slice(0, 300));
      await on.ada.call("DELETE", `/api/trips/${lake}/assistant/conversations/c-host-meter`);
      await go(ada, withIt, lake, "#/chat/assistant");
      await ada.until(`document.querySelector('#view input[data-act="ai-on"]') ? 1 : 0`, "the host's switch again", 10000).catch(() => {});
    }
    check("and the switch, on", (await read(ada, `document.querySelector('#view input[data-act="ai-on"]')?.checked`)) === true);
    if (SHOTS) await ada.shot(path.join(SHOTS, "390-light-assistant-host.png"));
    await ada.click('#view input[data-act="ai-on"]');
    await ada.until(`document.querySelector('#view input[data-act="ai-on"]') && !document.querySelector('#view input[data-act="ai-on"]').checked && !document.querySelector('#view input[data-act="ai-on"]').disabled ? 1 : 0`, "the switch off");
    const offLine = await text(ada, "#view .as-room-line");
    check("turned off: the host's line says so", offLine === "You've turned the assistant off on this trip.", offLine);
    await go(ben, withIt, lake, "#/chat/assistant");
    await ben.until(`/turned the assistant off/.test((document.querySelector("#view .as-room-line") || {}).textContent || "") ? 1 : 0`, "Ben reads it off");
    const benOff = JSON.parse(await read(ben, `JSON.stringify({ line: document.querySelector("#view .as-room-line").textContent, ph: document.querySelector("#as-input").placeholder, disabled: document.querySelector("#as-input").disabled, host: !!document.querySelector("#view .as-room-host"), sw: !!document.querySelector('#view input[data-act="ai-on"]') })`));
    check("a member: off for this trip in words, the box says so, no numbers, no switch", benOff.line === "The trip's host has turned the assistant off on this trip." && benOff.ph === "Turned off for this trip" && benOff.disabled && !benOff.host && !benOff.sw, JSON.stringify(benOff));
    const asked = await on.ben.post(`/api/trips/${lake}/assistant/conversations`, { id: "c-off" });
    const refusedOff = await on.ben.call("POST", `/api/trips/${lake}/assistant/conversations/c-off/ask`, { id: "q-off", words: "Anything?" });
    check("and an ask is refused by the server too, in words", asked.status === 201 && refusedOff.status === 402 && /turned the assistant off/.test(refusedOff.json?.reason || ""), `${refusedOff.status} ${refusedOff.json?.reason}`);
    await on.ben.call("DELETE", `/api/trips/${lake}/assistant/conversations/c-off`);
    await go(ada, withIt, lake, "#/chat/assistant");
    await ada.until(`document.querySelector('#view input[data-act="ai-on"]') ? 1 : 0`, "the switch again");
    await ada.click('#view input[data-act="ai-on"]');
    await ada.until(`document.querySelector('#view input[data-act="ai-on"]').checked && !document.querySelector('#view input[data-act="ai-on"]').disabled ? 1 : 0`, "the switch on again");
    check("turned on again: room this month", (await text(ada, "#view .as-room-line")) === "The assistant has room this month.");

    // The account's plan card: nothing of the month until it runs low. The server's month served as it is (the trip's
    // real use, far under), then planted at 0%, 50%, 85% and 100% of the allowance (DevTools rewrites the answer).
    let servedMonth = null;
    const cardAt = async (fraction) => {
      const off = ada.on(async (m) => {
        if (m.method !== "Fetch.requestPaused") return;
        const { requestId } = m.params;
        try {
          const got = await ada.send("Fetch.getResponseBody", { requestId });
          const body = JSON.parse(got.base64Encoded ? Buffer.from(got.body, "base64").toString("utf8") : got.body);
          if (body.assistant_month) { servedMonth = { ...body.assistant_month }; if (fraction !== null) body.assistant_month.used = Math.round(fraction * body.assistant_month.allowance); }
          await ada.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Cache-Control", value: "no-store" }],
            body: Buffer.from(JSON.stringify(body)).toString("base64") });
        } catch { await ada.send("Fetch.continueRequest", { requestId }).catch(() => {}); }
      });
      await ada.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/account/plan*", requestStage: "Response" }] });
      await ada.goto(`${withIt.origin}/account`);
      await ada.until(`document.getElementById("plan") && !document.getElementById("plan").hidden ? 1 : 0`, "the plan card");
      await sleep(400);
      const r = JSON.parse(await read(ada, `JSON.stringify({ hidden: document.getElementById("plan-ai").hidden, line: document.getElementById("plan-ai-line").textContent, card: document.getElementById("plan").innerText, list: !!document.getElementById("plan-ai-trips") })`));
      await ada.send("Fetch.disable");
      off();
      return r;
    };
    const asServed = await cardAt(null);
    check("the account's plan card, the month as served (far under its allowance): nothing of the assistant's month, no amounts, no list of trips",
      asServed.hidden && !asServed.list && !/\$\d|under \$|calls?\b/.test(asServed.card) && servedMonth && servedMonth.used < 0.8 * servedMonth.allowance, JSON.stringify({ ...asServed, servedMonth }));
    const backOn = new Date(Number(servedMonth?.back) * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    const at = {};
    for (const f of [0, 0.5, 0.85, 1]) at[f] = await cardAt(f);
    check("  planted at 0% and at 50% of the month: nothing", at[0].hidden && at[0.5].hidden, JSON.stringify([at[0].hidden, at[0.5].hidden]));
    check("  at 85%: one quiet line, no dollars", !at[0.85].hidden && at[0.85].line === `The assistant has used most of this month's room. It starts again on ${backOn}.` && !/\$/.test(at[0.85].card), JSON.stringify(at[0.85].line));
    check("  at 100%: that it's used, and the day it's back", !at[1].hidden && at[1].line === `The assistant has used this month's room. It's back on ${backOn}.` && !/\$/.test(at[1].card), JSON.stringify(at[1].line));
    const benCard = await pageAs(withIt, on.ben);
    await benCard.goto(`${withIt.origin}/account`);
    await benCard.until(`document.getElementById("plan") && document.readyState === "complete" ? 1 : 0`, "Ben's account");
    await sleep(1500);
    check("a member without the plan: no month on their card", (await read(benCard, `document.getElementById("plan-ai").hidden`)) === true);
    await benCard.close();
  }

  // ═══ G. stills, and page errors ═════════════════════════════════════════════════════════
  section("G. the screens at three sizes, both themes");
  if (SHOTS) {
    const conv = (await on.ben.get(`/api/trips/${lake}/assistant`)).json.conversations[0].id;
    for (const [tag, size, scale] of [["390", { width: 390, height: 844, mobile: true }, 0], ["320-larger-text", { width: 278, height: 557, mobile: true }, 2.3], ["1440", { width: 1440, height: 900, mobile: false }, 0]]) {
      for (const scheme of ["light", "dark"]) {
        for (const [what, who, hash] of [["chat", ada, "#/chat"], ["assistant", ben, "#/chat/assistant"], ["conversation", ben, `#/chat/assistant/${conv}`], ["host", ada, "#/chat/assistant"], ["account", ada, null]]) {
          await who.size(size);
          if (scale) await who.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: scale, mobile: true });
          await who.scheme(scheme);
          if (hash) {
            await go(who, withIt, lake, hash);
            await who.until(`document.querySelector("#view .ch-feed .ch-msg, #view .as-list, #view .as-a, #view .as-empty") ? 1 : 0`, `${what} drawn`);
          } else {
            await who.goto(`${withIt.origin}/account`);
            await who.until(`document.getElementById("plan") && !document.getElementById("plan").hidden ? 1 : 0`, "the account card");
            await who.eval(`(document.getElementById("plan").scrollIntoView({ block: "start" }), 1)`);
          }
          await sleep(600);
          if (what === "chat") {
            const ph = JSON.parse(await who.eval(`JSON.stringify((() => { const i = document.querySelector(".ch-input"); const cs = getComputedStyle(i); const c = document.createElement("canvas").getContext("2d"); c.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily; return { words: i.placeholder, w: Math.round(c.measureText(i.placeholder).width), room: Math.round(i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) }; })())`));
            if (scheme === "light") check(`${tag}: the box's words fit on one line`, ph.w <= ph.room, JSON.stringify(ph));
          }
          if (what === "account") {
            // The plan card alone: the account page is long, and the card is what changed.
            const r = JSON.parse(await who.eval(`JSON.stringify((() => { const b = document.getElementById("plan").getBoundingClientRect(); return { x: Math.max(0, b.left - 12), y: b.top + scrollY - 12, width: Math.min(innerWidth, b.width + 24), height: b.height + 24 }; })())`));
            await who.rest();
            const { data } = await who.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...r, scale: 1 } });
            fs.writeFileSync(path.join(SHOTS, `${tag}-${scheme}-${what}.png`), Buffer.from(data, "base64"));
          } else await who.shot(path.join(SHOTS, `${tag}-${scheme}-${what}.png`));
        }
      }
    }
    check("stills written", fs.readdirSync(SHOTS).filter((f) => f.endsWith(".png")).length >= 30, SHOTS);
  }

  // ═══ H. deleting a conversation ═════════════════════════════════════════════════════════
  section("H. a conversation deleted, by its own sheet");
  {
    await ben.size({ width: 390, height: 844, mobile: true });
    await ben.scheme("light");
    const conv = (await on.ben.get(`/api/trips/${lake}/assistant`)).json.conversations[0].id;
    const sharedBefore = (await on.ada.get(`/api/trips/${lake}/messages?limit=100`)).json.messages.filter((m) => m.kind === "shared" && !m.deleted).length;
    await go(ben, withIt, lake, `#/chat/assistant/${conv}`);
    await ben.until(`document.querySelector("#view .as-a") ? 1 : 0`, "the conversation");
    await ben.click("#view .as-more");
    await ben.until(`document.querySelector('[data-do="delete"]') ? 1 : 0`, "its sheet");
    await sleep(400);
    const sheet = JSON.parse(await read(ben, `JSON.stringify({ title: [...document.querySelectorAll("h2, .sh-title, [role=dialog] h2")].map((n) => n.textContent).find((t) => /conversation/.test(t)) || "", focus: document.activeElement?.dataset?.do || document.activeElement?.className || "", says: [...document.querySelectorAll(".as-sheet-line")].map((n) => n.textContent).join(" ") })`));
    check("its sheet says what deleting does, and the first focus isn't on Delete (Enter deletes nothing)", sheet.title === "This conversation" && sheet.focus !== "delete" && /What the assistant changed on the trip stays/.test(sheet.says || ""), JSON.stringify(sheet));
    await ben.click('[data-do="delete"]');
    await ben.until(`location.hash === "#/chat/assistant" && document.querySelector("#view .as-empty") ? 1 : 0`, "back on the list, empty");
    const after = (await on.ben.get(`/api/trips/${lake}/assistant`)).json.conversations.length;
    const sharedAfter = (await on.ada.get(`/api/trips/${lake}/messages?limit=100`)).json.messages.filter((m) => m.kind === "shared" && !m.deleted).length;
    check("gone on the server; what was shared to the group stays the group's", after === 0 && sharedAfter === sharedBefore && sharedBefore === 2, `conversations ${after}, shared ${sharedBefore} → ${sharedAfter}`);
  }
  check("no page error", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  await chrome?.close().catch(() => {});
  await withIt?.stop().catch(() => {});
  await without?.stop().catch(() => {});
  await model?.close?.();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);

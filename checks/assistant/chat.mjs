// The assistant in the trip's group chat, and "Share with group" (docs/model.md §20, L5; migration 0033).
// On a server of its own with the plan and the assistant on, a stand-in model and a stand-in push service
// on this machine (as check:push has it). Nothing reaches a model or a phone.
//
//   node checks/assistant/chat.mjs [--port <port>]
//
// It holds what model.md §20 asks for, a group chat where anyone can @assistant and get its answer in that chat:
//   1. a message naming @assistant anywhere is answered in the chat, as the assistant's own kind of message
//      whose author is the person who asked, replying to their message; one that doesn't name it isn't;
//   2. everyone sees it work as it happens: another person's chat reads the step it is on, changing, then
//      the answer in its place;
//   3. push as for any message: the others told, "The assistant, asked by Ben", the asker not told of their own;
//   4. what the model is sent: the chat as everyone reads it, and nothing of anyone's own conversation;
//   5. its words can't be edited; its asker or the host can delete it; when it can't answer (another ask
//      running), the sender alone is told why, and nothing is posted;
// and sharing an answer with the group in one press:
//   6. one press puts that question and that answer in the chat, as a shared message by the person who asked,
//      a long answer whole; nothing else of the conversation goes with it (read in every column of the row,
//      and in what the others' chat reads); another person can't share from it; push says who shared;
//   7. a person's message answers exactly as before (no new field).
// Everyone in it is made up.

import http from "node:http";
import { CheckError, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { startModel } from "../lib/model-standin.mjs";
import { b64url } from "../../src/push/webpush.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const t = new Report("the assistant in the group chat, and Share with group");
const KEY = "sk-or-check-not-real";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const te = new TextEncoder();
const td = new TextDecoder();
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), data));
const hkdf = async (salt, ikm, info, n) => (await hmac(await hmac(salt, ikm), cat(info, new Uint8Array([1])))).slice(0, n);
/** The browser's side of RFC 8291, only to open what the server sends (as check:push). */
async function open(body, uaPrivate, uaPublic, auth) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const pub = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, uaPrivate, 256));
  const ikm = await hkdf(auth, shared, cat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)));
  return td.decode(plain.slice(0, plain.lastIndexOf(2)));
}
async function phoneKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, pub, auth, keys: { p256dh: b64url(pub), auth: b64url(auth) } };
}

const got = [];
const pushService = http.createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => { got.push({ path: req.url, body: new Uint8Array(Buffer.concat(parts)) }); res.writeHead(201); res.end(); });
});
await new Promise((r) => pushService.listen(0, "127.0.0.1", r));
const PUSH = `http://127.0.0.1:${pushService.address().port}`;

let server, model, code = 1;
try {
  model = await startModel({ key: KEY });
  const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);
  server = await startServer({
    name: "assistant-chat", port,
    vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true",
      ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5", OPENROUTER_API_BASE: model.base, PUSH_TEST_ORIGIN: PUSH },
    secrets: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", OPENROUTER_API_KEY: KEY,
      VAPID_PUBLIC_KEY: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", vapidPair.publicKey))),
      VAPID_PRIVATE_KEY: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y }) },
  });
  await server.start();
  const { origin } = server;
  const people = Object.fromEntries(["Ada Reyes", "Ben Okafor", "Cleo Tran"].map((n) => [n.split(" ")[0].toLowerCase(), new Person(origin, n)]));
  for (const p of Object.values(people)) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const { ada, ben, cleo } = people;
  const trip = (await ada.post("/api/trips", { name: "Lake week", default_tz: "UTC", starts_on: "2027-06-01", ends_on: "2027-06-07" })).json.trip.id;
  for (const p of [ben, cleo]) await p.post(`/api/join/${(await ada.post(`/api/trips/${trip}/links`, { uses: 1 })).json.link.code}`);
  const now = Math.floor(Date.now() / 1000);
  server.sql(`INSERT INTO billing_subscriptions (id, user_id, customer, status, interval, current_period_end, held, updated_at, synced_at)
    VALUES ('sub_ada', '${ada.user.id}', 'cus_ada', 'active', 'month', ${now + 30 * 86400}, 0, ${now}, ${Date.now()})`);
  const phones = {};
  for (const [name, p] of Object.entries(people)) {
    phones[name] = await phoneKeys();
    await p.call("PUT", "/api/account/push", { endpoint: `${PUSH}/ok/${name}`, keys: phones[name].keys, words: true });
  }
  const opened = async (g) => { const name = g.path.split("/").pop(); return { name, ...JSON.parse(await open(g.body, phones[name].pair.privateKey, phones[name].pub, phones[name].auth)) }; };
  const M = `/api/trips/${trip}/messages`;
  const chatOf = async (who) => (await who.get(`${M}?limit=100`)).json?.messages ?? [];
  // Ben's own conversation, whose words must never reach the chat or the chat's model.
  const A = `/api/trips/${trip}/assistant`;
  await ben.post(`${A}/conversations`, { id: "c-ben" });
  const SECRET = "the anniversary dinner I'm planning for Cleo";
  model.next({ words: "I'll keep that between us." });
  await ben.post(`${A}/conversations/c-ben/ask`, { id: "q-1", words: `Help me with ${SECRET}.` });

  t.part("1. @assistant, answered in the chat");
  const plain = await cleo.post(M, { id: "m-plain", body: "Who's bringing the snacks?" });
  t.same("a message that doesn't name it: no answer, nothing asked of the model", [plain.status, plain.json?.assistant, (await chatOf(ada)).filter((m) => m.kind === "assistant").length], [201, undefined, 0]);
  await ada.post(M, { id: "m-ada", body: "The boat leaves from the north pier." });
  const callsBefore = model.calls.length;
  const pushedBefore = got.length;
  model.next({ tools: [{ name: "list_events", arguments: {} }], hang: 1200 });
  model.next({ words: "The boat leaves at nine from the north pier.", hang: 1200 });
  const asked = await ben.post(M, { id: "m-ask", body: "Hey @assistant, what time does the boat leave?" });
  t.same("one naming @assistant anywhere: posted as written, and the sender told the assistant is answering", [asked.status, asked.json?.message?.body, asked.json?.assistant?.asked, typeof asked.json?.assistant?.message_id], [201, "Hey @assistant, what time does the boat leave?", true, "string"]);

  t.part("2. Everyone sees it work, then the answer");
  const id = asked.json?.assistant?.message_id;
  const seenWorking = [];
  let answer = null;
  for (let i = 0; i < 80 && !answer; i++) {
    const m = (await chatOf(cleo)).find((x) => x.id === id);
    if (m?.working && seenWorking.at(-1) !== m.working) seenWorking.push(m.working);
    if (m && m.working === null && m.body) answer = m;
    await sleep(100);
  }
  // A tool's own step passes quickly here (the stand-in answers at once); the model's two slow turns are seen.
  t.ok("another person's chat reads the step it is on, as it changes", seenWorking[0] === "Working out what to do…" && seenWorking.includes("Working out the next step…"), seenWorking.join(" | "));
  t.same("then the answer in its place: the assistant's kind, by the person who asked, replying to their message",
    [answer?.kind, answer?.author, answer?.author_name, answer?.reply_to, answer?.body, answer?.working, answer?.stopped], ["assistant", ben.user.id, "Ben Okafor", "m-ask", "The boat leaves at nine from the north pier.", null, null]);
  t.same("  and Ada's chat reads the same", (await chatOf(ada)).find((x) => x.id === id)?.body, "The boat leaves at nine from the north pier.");

  t.part("3. Push, as for any message");
  for (let i = 0; i < 40 && got.length - pushedBefore < 4; i++) await sleep(100);
  await sleep(300);
  const pushed = await Promise.all(got.slice(pushedBefore).map(opened));
  const forAnswer = pushed.filter((p) => /The assistant/.test(p.notification?.title ?? ""));
  t.same("the others told of the answer, \"The assistant, asked by Ben, in Lake week\", with its words; Ben not told of Ben's own",
    [forAnswer.map((p) => p.name).sort(), forAnswer[0]?.notification?.title, forAnswer[0]?.notification?.body], [["ada", "cleo"], "The assistant, asked by Ben Okafor, in Lake week", "The boat leaves at nine from the north pier."]);

  t.part("4. What the model is sent");
  const sent = model.calls.slice(callsBefore).map((c) => JSON.stringify(c.body));
  const firstMessages = model.calls[callsBefore]?.body?.messages ?? [];
  t.ok("the chat as everyone reads it, each line its writer's first name, the question last",
    firstMessages.some((m) => m.content === "Ada: The boat leaves from the north pier.") && firstMessages.some((m) => m.content === "Cleo: Who's bringing the snacks?") && firstMessages.at(-1)?.content === "Ben: Hey @assistant, what time does the boat leave?",
    firstMessages.map((m) => m.content).slice(-3).join(" | ").slice(0, 300));
  t.ok("  and nothing of anyone's own conversation", sent.length === 2 && !sent.some((b) => b.includes("anniversary")), `${sent.length} requests`);

  t.part("5. Edits, deletes, and when it can't answer");
  const edit = await ben.call("PATCH", `${M}/${id}`, { body: "Nine-ish" });
  t.same("its words can't be edited, by the person who asked either", [edit.status, edit.json?.error], [409, "not editable"]);
  model.next({ words: "Slow.", hang: 1500 });
  const busyAsk = ben.post(`${A}/conversations/c-ben/ask`, { id: "q-busy", words: "Take your time." });
  await sleep(400);
  const busyAnswer = await ada.post(M, { id: "m-ask-2", body: "@assistant are we there yet?" });
  await busyAsk;
  t.ok("while another ask runs on the trip: the message posted, the sender alone told why, no answer posted",
    busyAnswer.status === 201 && busyAnswer.json?.assistant?.asked === false && busyAnswer.json?.assistant?.error === "busy" && !(await chatOf(cleo)).some((m) => m.reply_to === "m-ask-2"), JSON.stringify(busyAnswer.json?.assistant));
  const del = await ada.call("DELETE", `${M}/${id}`);
  t.same("the host can delete it (as any message)", [del.status, !!del.json?.message?.deleted], [200, true]);

  t.part("6. Share with group");
  const LONG = `Day one: ${"swim, lunch by the water, a walk along the shore; ".repeat(110)}`.trim();
  model.next({ words: LONG });
  const q2 = await ben.post(`${A}/conversations/c-ben/ask`, { id: "q-2", words: "Plan a lazy first day for the group." });
  const answerTurn = q2.text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.turn)?.turn;
  const before = got.length;
  const shared = await ben.post(`${A}/conversations/c-ben/share`, { id: "share-1", turn: answerTurn?.id });
  const row = server.sql("SELECT * FROM messages WHERE id = 'share-1'")[0];
  t.same("one press: the question and that answer in the chat, a shared message by Ben, the long answer whole",
    [shared.status, shared.json?.message?.kind, shared.json?.message?.author, shared.json?.message?.shared?.question, shared.json?.message?.shared?.answer === LONG, LONG.length > 4000],
    [201, "shared", ben.user.id, "Plan a lazy first day for the group.", true, true]);
  t.ok("nothing else of the conversation went with it: not in any column of the row, not in what the others read",
    !JSON.stringify(row).includes("anniversary") && !JSON.stringify(row).includes("Take your time") && !JSON.stringify(await chatOf(cleo)).includes("anniversary"), Object.keys(row ?? {}).join(","));
  const notHers = await cleo.post(`${A}/conversations/c-ben/share`, { id: "share-2", turn: answerTurn?.id });
  t.same("another person can't share from Ben's conversation: the answer for none, nothing posted", [notHers.status, server.sql("SELECT COUNT(*) AS n FROM messages WHERE id = 'share-2'")[0].n], [404, 0]);
  for (let i = 0; i < 40 && got.length - before < 2; i++) await sleep(100);
  const sharedPush = await Promise.all(got.slice(before).map(opened));
  t.same("the others told, \"Ben shared the assistant's answer\"", [sharedPush.map((p) => p.name).sort(), sharedPush[0]?.notification?.title], [["ada", "cleo"], "Ben Okafor shared the assistant's answer in Lake week"]);

  t.part("7. A person's message, as before");
  const mine = (await chatOf(cleo)).find((m) => m.id === "m-plain");
  t.same("no new field on a person's message", Object.keys(mine ?? {}).sort(), ["about", "author", "author_name", "body", "created_at", "deleted", "edited_at", "id", "rev", "seq", "touched"]);
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
  pushService.close();
}
process.exit(code);

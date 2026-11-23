// A person's export (GET /api/account/export, src/accounts/export.js) and what goes when an account, a trip or
// a membership does (docs/model.md §20, L7). On a server of its own with the plan and the assistant on, a
// stand-in model. Nothing reaches a model.
//
//   node checks/assistant/export.mjs [--port <port>]
//
// It holds:
//   1. the export is a file to keep (an attachment, never cached), signed in only;
//   2. what is theirs: the account (name, emails, the ways in by kind), the trips they're on or were on with
//      their role, on each their own chat messages (words, time, what about by name) and their own memories
//      (caption, each file's name and size, and a link that downloads it while signed in and on the trip, and
//      not for anyone else), their conversations with the assistant with every turn, on a trip they've left
//      too; as a host, the assistant's ledger by month and trip; their plan; their apps; their phones by count;
//   3. what is never in it: another person's words (their chat, their conversation, the assistant's answer to
//      them), the trip's plans, places and purchases, a key, a credential's id, a provider's id for them, a
//      session, a Stripe id, a push endpoint, and in the ledger who asked;
//   4. what goes: a member who leaves keeps their conversations (in the export), and their asks stay in the
//      host's ledger; an account deleted takes its conversations and its tag, and as a host its ledger.
// Everyone in it is made up.

import { CheckError, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { startModel } from "../lib/model-standin.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const t = new Report("a person's export, and what goes with them");
const KEY = "sk-or-check-not-real";

let server, model, code = 1;
try {
  model = await startModel({ key: KEY });
  server = await startServer({
    name: "assistant-export", port,
    vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true",
      ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5", OPENROUTER_API_BASE: model.base },
    secrets: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", OPENROUTER_API_KEY: KEY },
  });
  await server.start();
  const { origin } = server;
  const [ada, ben, cleo] = ["Ada Reyes", "Ben Okafor", "Cleo Tran"].map((n) => new Person(origin, n));
  for (const p of [ada, ben, cleo]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
  const trip = (await ada.post("/api/trips", { name: "Lake week", default_tz: "UTC", starts_on: day(0), ends_on: day(6) })).json.trip.id;
  const later = (await ada.post("/api/trips", { name: "City weekend", default_tz: "UTC" })).json.trip.id;
  for (const p of [ben, cleo]) for (const x of [trip, later]) await p.post(`/api/join/${(await ada.post(`/api/trips/${x}/links`, { uses: 1 })).json.link.code}`);
  const now = Math.floor(Date.now() / 1000);
  server.sql(`INSERT INTO billing_subscriptions (id, user_id, customer, status, interval, current_period_end, held, updated_at, synced_at)
    VALUES ('sub_ada_secret', '${ada.user.id}', 'cus_ada_secret', 'active', 'month', ${now + 30 * 86400}, 0, ${now}, ${Date.now()})`);
  const T = `/api/trips/${trip}`;
  // The trip's own content, which isn't Ben's to take: a plan, a place, a purchase.
  const boat = await ada.post(`${T}/events`, { id: "e-boat", title: "Boat to the island", starts_at: now + 86400, tz: "UTC" });
  const placed = await ada.call("PUT", `${T}/places`, { places: [{ id: "p-pier", name: "North pier", kind: "sight", subkind: "viewpoint", why: "Where the boat leaves." }] });
  // What Ben makes: words in the chat (one about the plan), a memory with a photo, a conversation with the assistant.
  const benSaid = await ben.post(`${T}/messages`, { id: "m-ben", body: "I'll bring the snacks", about: { kind: "event", id: "e-boat" } });
  const cleoSaid = await cleo.post(`${T}/messages`, { id: "m-cleo", body: "Cleo's own words about the ferry" });
  const photo = Buffer.alloc(6 * 1024, 9);
  const begun = await ben.post(`${T}/media/begin`, { name: "sunset.jpg", mime: "image/jpeg", bytes: photo.length, kind: "photo" });
  const part = await ben.call("PUT", `${T}/media/part?key=${encodeURIComponent(begun.json.key)}&id=${encodeURIComponent(begun.json.uploadId)}&n=1`, photo, { headers: { "Content-Type": "application/octet-stream" } });
  await ben.post(`${T}/media/finish`, { key: begun.json.key, id: begun.json.uploadId, parts: [{ n: 1, etag: part.json?.etag }] });
  const mem = await ben.post(`${T}/memories`, { id: "mem-ben", caption: "Sunset from the pier", media: [{ key: begun.json.key, w: 10, h: 10 }] });
  await ben.post(`${T}/assistant/conversations`, { id: "c-ben" });
  model.next({ words: "The boat leaves at nine." });
  await ben.post(`${T}/assistant/conversations/c-ben/ask`, { id: "q-ben", words: "When does the boat leave?" });
  // Ben asks the assistant in the chat: his message is his; the answer posted under his name is the assistant's.
  model.next({ words: "The ferry answer from the assistant." });
  const inChat = await ben.post(`${T}/messages`, { id: "m-ben-asks", body: "@assistant when is the ferry?" });
  for (let i = 0; i < 100 && server.sql(`SELECT COUNT(*) AS n FROM messages WHERE kind = 'assistant' AND working IS NULL AND body LIKE '%ferry answer%'`)[0].n === 0; i++) await new Promise((r) => setTimeout(r, 100));
  // And shares an answer of his own conversation with the group.
  await cleo.post(`${T}/assistant/conversations`, { id: "c-cleo" });
  model.next({ words: "Cleo's private answer about the anniversary." });
  await cleo.post(`${T}/assistant/conversations/c-cleo/ask`, { id: "q-cleo", words: "Cleo's private question about the anniversary" });
  const benTurn = server.sql("SELECT id FROM ai_turns WHERE conversation_id = 'c-ben' AND role = 'assistant'")[0]?.id;
  const shared = await ben.post(`${T}/assistant/conversations/c-ben/share`, { id: "m-ben-share", turn: benTurn });
  t.same("(the plan, the place, the messages, the chat's answer, Ben's memory and share, and both conversations, made through the routes)",
    [boat.status, placed.status, benSaid.status, cleoSaid.status, inChat.status, server.sql("SELECT COUNT(*) AS n FROM messages WHERE kind = 'assistant' AND working IS NULL")[0].n, mem.status, shared.status, server.sql("SELECT COUNT(*) AS n FROM ai_turns")[0].n],
    [201, 200, 201, 201, 201, 1, 201, 201, 4]);

  t.part("1. A file to keep, signed in only");
  const out = await ben.get("/api/account/export");
  const signedOut = await fetch(`${origin}/api/account/export`);
  t.ok("an attachment named by the day, never cached; signed out: refused",
    out.status === 200 && /^attachment; filename="wegoplace-account-\d{4}-\d{2}-\d{2}\.json"$/.test(out.headers.find(([k]) => k === "content-disposition")?.[1] ?? "") && out.headers.find(([k]) => k === "cache-control")?.[1] === "no-store" && signedOut.status === 401,
    JSON.stringify(out.headers.filter(([k]) => /content-disposition|cache-control/.test(k))));
  // The file's day is the phone's (?day=, public/js/account.js) when it is within a day of the server's UTC day, and the
  // server's own otherwise. Asked as Cleo, whose exports aren't counted against Ben's hour below.
  const dayOf = (r) => /filename="wegoplace-account-([^"]+)\.json"/.exec(r.headers.find(([k]) => k === "content-disposition")?.[1] ?? "")?.[1] ?? null;
  const utcDay = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
  const today = utcDay(0);
  const asked = [];
  for (const day of [utcDay(-1), utcDay(1), utcDay(-3), utcDay(2), "2027-02-30", "tomorrow"]) {
    asked.push([day, dayOf(await cleo.get(`/api/account/export?day=${encodeURIComponent(day)}`))]);
  }
  t.same("the file is named by the phone's day when it is within a day of the server's (an evening in New York, a morning in Tokyo)",
    asked.slice(0, 2).map(([, got]) => got), [utcDay(-1), utcDay(1)]);
  t.same("  and by the server's own day for a day further off, or one that isn't a date",
    asked.slice(2).map(([, got]) => got), [today, today, today, today]);
  const x = out.json;
  const text = out.text;

  t.part("2. What is theirs");
  const here = x.trips.find((tr) => tr.id === trip);
  t.same("the account: name, emails, the ways in by kind", [x.account.name, Array.isArray(x.account.emails), x.account.ways_in.map((w) => w.kind)], ["Ben Okafor", true, ["passkey"]]);
  t.same("the trips they're on, with their role", x.trips.map((tr) => [tr.name, tr.role]).sort(), [["City weekend", "member"], ["Lake week", "member"]]);
  t.same("on each, their own chat messages: words, what about by name, and what they shared (its question and answer)",
    here.messages.map((m) => [m.kind, m.words, m.about?.name ?? m.shared?.answer ?? null]),
    [["person", "I'll bring the snacks", "Boat to the island"], ["person", "@assistant when is the ferry?", null], ["shared", here.messages[2]?.words, "The boat leaves at nine."]]);
  t.ok("  never the assistant's answer in the chat, though it's kept under Ben's name", !text.includes("ferry answer from the assistant"), "found");
  const file = here.memories[0]?.files?.[0];
  t.same("their own memories: the caption, each file's name and size, and a link", [here.memories.length, here.memories[0]?.caption, file?.name, file?.bytes, typeof file?.url], [1, "Sunset from the pier", "sunset.jpg", 6144, "string"]);
  const path = file?.url?.replace(origin, "") ?? "/";
  const got = await ben.get(path);
  const forCleo = await cleo.get(path);
  const forStranger = await fetch(`${origin}${path}`);
  t.same("  the link downloads the file for Ben, signed in and on the trip (and for others on it, as the trip shows it), not signed out",
    [got.status, got.text.length, forCleo.status, forStranger.status], [200, 6144, 200, 401]);
  const conv = x.assistant.conversations.find((c) => c.id === "c-ben");
  t.same("their conversation with the assistant, every turn", conv?.turns.map((tu) => [tu.role, tu.words]), [["person", "When does the boat leave?"], ["assistant", "The boat leaves at nine."]]);
  t.same("no ledger for a member (they host nothing), no plan of their own", [x.assistant.ledger, x.plan?.active ?? null], [[], false]);
  const hostOut = (await ada.get("/api/account/export")).json;
  const line = hostOut.assistant.ledger.find((l) => l.trip_id === trip);
  t.ok("as a host: the assistant's ledger by month and trip (calls, tokens, cost), and their plan", line?.calls === 3 && line.cost_micro > 0 && line.trip_name === "Lake week" && hostOut.plan?.active === true && Object.keys(line).sort().join() === "calls,completion_tokens,cost_micro,month,prompt_tokens,trip_id,trip_name", JSON.stringify(line));

  t.part("3. What is never in it");
  t.ok("another person's words: not Cleo's chat, not her conversation, not the assistant's answer to her", !/Cleo's own words|anniversary/.test(text), "found");
  t.ok("not the trip's plans, places or purchases as such (the plan only by name, on Ben's own message)", !/North pier|Where the boat leaves|starts_at/.test(text), "found");
  const passkeyId = server.sql(`SELECT id FROM passkeys WHERE user_id = '${ben.user.id}'`)[0]?.id;
  const session = ben.jar.cookies.get("wgp_session");
  t.ok("no key, credential id, session, Stripe id, push endpoint or public key", !text.includes(passkeyId) && !text.includes(session) && !/public_key|cus_|sub_|endpoint|p256dh|"auth"/.test(text), "found");
  t.ok("the host's ledger says nothing of who asked", !JSON.stringify(hostOut.assistant.ledger).match(/user_id|Ben|Cleo|Okafor|Tran/), JSON.stringify(hostOut.assistant.ledger));

  t.part("4. What goes, and what stays");
  await ben.call("DELETE", `${T}/members/${encodeURIComponent(ben.user.id)}`);
  const afterLeaving = (await ben.get("/api/account/export")).json;
  t.same("a member who leaves keeps their conversations (in the export, the trip by name), and the trip shows they left",
    [afterLeaving.assistant.conversations.find((c) => c.id === "c-ben")?.turns.length, afterLeaving.assistant.conversations.find((c) => c.id === "c-ben")?.trip_name, typeof afterLeaving.trips.find((tr) => tr.id === trip)?.left_at],
    [2, "Lake week", "number"]);
  t.same("  and their asks stay in the host's ledger", server.sql(`SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = '${ben.user.id}'`)[0].n, 2);
  await cleo.call("DELETE", "/api/me", { confirm: "delete" });
  t.same("an account deleted takes its conversations and its tag; its ask stays in the host's ledger without who asked",
    [server.sql(`SELECT COUNT(*) AS n FROM ai_conversations WHERE user_id = '${cleo.user.id}'`)[0].n, server.sql(`SELECT COUNT(*) AS n FROM ai_tags WHERE user_id = '${cleo.user.id}'`)[0].n,
      server.sql(`SELECT COUNT(*) AS n FROM ai_calls WHERE host_id = '${ada.user.id}'`)[0].n, server.sql(`SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = '${cleo.user.id}'`)[0].n], [0, 0, 3, 0]);
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

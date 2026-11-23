// The trip's chat (model §17; src/api/messages.js, migration 0024): the server's order whatever
// the phones' clocks, a message sent twice landing once, messages about an event, a place or a
// purchase (and the time before an event) keeping the thing's name when it goes, edits by the
// author, deletes by the author or the host leaving a line, the counts in the snapshot, the split
// of the rev (a message moves the chat's counter and rev, never data_rev), paging and what
// changed, the limits with their sentences, the mute, and what stays when someone leaves or
// deletes their account.
//
//   npm run check:chat        (about a minute; its own server on 8791)
//
// Everyone here is made up.

import fs from "node:fs";
import path from "node:path";
import { CheckError, ROOT, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { MESSAGE_MAX, MESSAGES_PAGE_MAX, MESSAGES_PER_MINUTE, MESSAGES_PER_TRIP_MAX } from "../../public/js/shared/limits.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const t = new Report("the trip's chat");
let server;
let code = 1;

async function person(name) {
  const p = new Person(server.origin, name);
  const res = await p.signUp();
  if (res.status !== 200) throw new CheckError(`couldn't make ${name}: ${res.status} ${res.text}`);
  return p;
}
async function bring(host, tripId, joiner) {
  const link = await host.post(`/api/trips/${tripId}/links`, { uses: 1 });
  const res = await joiner.post(`/api/join/${link.json.link.code}`);
  if (res.status !== 200) throw new CheckError(`couldn't join: ${res.status} ${res.text}`);
}
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

try {
  server = await startServer({ name: "chat", port });
  await server.start();
  const host = await person("Hal Chat");
  const ivy = await person("Ivy Chat");
  const jon = await person("Jon Chat");
  const T = (await host.post("/api/trips", { name: "Chat check", default_tz: "UTC", starts_on: "2027-05-01", ends_on: "2027-05-09", currencies: ["EUR"] })).json.trip.id;
  for (const p of [ivy, jon]) await bring(host, T, p);
  const M = `/api/trips/${T}/messages`;
  const revs = async () => (await ivy.get(`/api/trips/${T}/rev`)).json;

  t.part("Sending, and the server's order");
  const before = await revs();
  const first = await ivy.post(M, { id: "m-1", body: "Who has the tickets?" });
  const second = await host.post(M, { id: "m-2", body: "I do." });
  const third = await jon.post(M, { id: "m-3", body: "Great" });
  const list = (await jon.get(M)).json;
  t.same("each message takes the next of the server's numbers, and the chat reads in that order, with each author's name",
    [first.status, second.status, third.status, list.messages.map((m) => [m.id, m.seq, m.author_name, m.body])],
    [201, 201, 201, [["m-1", 1, "Ivy Chat", "Who has the tickets?"], ["m-2", 2, "Hal Chat", "I do."], ["m-3", 3, "Jon Chat", "Great"]]]);
  const after = await revs();
  t.same("three messages move the chat's counter by three and the rev by three, and data_rev not at all: no phone reads the whole trip for them",
    [after.seq - before.seq, after.rev - before.rev, after.data_rev - before.data_rev], [3, 3, 0]);
  const replay = await ivy.post(M, { id: "m-1", body: "Who has the tickets?" });
  t.same("sent again (a phone's queue), it lands once: the same message, nothing moves", [replay.status, replay.json?.message?.seq, (await revs()).seq], [200, 1, after.seq]);
  const taken = await host.post(M, { id: "m-1", body: "x" });
  t.same("  (someone else's message id is refused, in words)", [taken.status, /another message's id/.test(taken.json?.reason ?? "")], [409, true]);
  const ev = (await host.post(`/api/trips/${T}/events`, { id: "dinner", title: "Dinner at the harbour", starts_at: Date.UTC(2027, 4, 2, 19) / 1000, tz: "UTC" })).json;
  t.same("  (any other write moves data_rev with the rev)", (await revs()).data_rev, ev.rev);

  t.part("About a thing");
  await host.call("PUT", `/api/trips/${T}/places`, { places: [{ id: "harbour", name: "The harbour", kind: "sight", subkind: "landmark", why: "Boats." }] });
  await host.post(`/api/trips/${T}/purchases`, { id: "pu-1", description: "Tickets", amount_minor: 4000, currency: "EUR", amount_exp: 2, spent_at: Date.UTC(2027, 4, 2) / 1000,
    shares: [{ user_id: host.user.id, weight: 1, share_minor: 2000 }, { user_id: ivy.user.id, weight: 1, share_minor: 2000 }] });
  const aboutEvent = await ivy.post(M, { id: "m-ev", body: "Table for three?", about: { kind: "event", id: "dinner" } });
  const aboutBefore = await jon.post(M, { id: "m-ev-before", body: "Meet at the hotel first", about: { kind: "event", id: "dinner", part: "before" } });
  const aboutPlace = await ivy.post(M, { id: "m-pl", body: "Closes at ten", about: { kind: "place", id: "harbour" } });
  const aboutPurchase = await jon.post(M, { id: "m-pu", body: "I'll pay you back", about: { kind: "purchase", id: "pu-1" } });
  t.same("a message about an event, the time before it, a place, a purchase: each carries the thing's name",
    [aboutEvent, aboutBefore, aboutPlace, aboutPurchase].map((r) => [r.status, r.json?.message?.about]),
    [[201, { kind: "event", id: "dinner", name: "Dinner at the harbour" }], [201, { kind: "event", id: "dinner", part: "before", name: "Dinner at the harbour" }],
      [201, { kind: "place", id: "harbour", name: "The harbour" }], [201, { kind: "purchase", id: "pu-1", name: "Tickets" }]]);
  const refusedAbout = await Promise.all([
    ivy.post(M, { id: "m-x1", body: "x", about: { kind: "event", id: "no-such" } }),
    ivy.post(M, { id: "m-x2", body: "x", about: { kind: "wall", id: "w" } }),
    ivy.post(M, { id: "m-x3", body: "x", about: { kind: "place", id: "harbour", part: "before" } }),
  ]);
  t.same("about nothing there, about a kind there isn't, the time before a place: refused, each in words",
    refusedAbout.map((r) => [r.status, r.json?.error, Boolean(r.json?.reason)]), [[404, "no such thing", true], [400, "bad about", true], [400, "bad about", true]]);
  const snap = (await jon.get(`/api/trips/${T}`)).json;
  t.same("the snapshot counts the messages about each thing, and carries the chat's counter, not the messages",
    [snap.chat?.about?.event, snap.chat?.about?.place, snap.chat?.about?.purchase, snap.chat?.seq, "messages" in snap],
    [{ dinner: 2 }, { harbour: 1 }, { "pu-1": 1 }, (await revs()).seq, false]);
  const onlyDinner = (await jon.get(`${M}?about=event:dinner`)).json.messages.map((m) => m.id);
  t.same("  (and the chat reads the ones about one thing)", onlyDinner, ["m-ev", "m-ev-before"]);
  await host.call("DELETE", `/api/trips/${T}/places`, { ids: ["harbour"] });
  const kept = (await jon.get(M)).json.messages.find((m) => m.id === "m-pl");
  t.same("the place deleted, the message about it keeps its words and the place's name as it was", [kept?.body, kept?.about], ["Closes at ten", { kind: "place", id: "harbour", name: "The harbour" }]);

  t.part("Changing and deleting");
  const counter = (await revs()).seq;
  const edited = await ivy.call("PATCH", `${M}/m-1`, { body: "Who has the train tickets?" });
  t.same("the author changes their words: it says it was edited, keeps its place in the order, and the counter moves",
    [edited.status, edited.json?.message?.body, Boolean(edited.json?.message?.edited_at), edited.json?.message?.seq, edited.json?.message?.touched], [200, "Who has the train tickets?", true, 1, counter + 1]);
  const notTheirs = await host.call("PATCH", `${M}/m-1`, { body: "x" });
  t.same("nobody else may change it, not even the host, in words", [notTheirs.status, notTheirs.json?.reason], [403, "Only the person who wrote this message can change it."]);
  const byOther = await jon.call("DELETE", `${M}/m-2`);
  t.same("someone else can't delete it either", [byOther.status, byOther.json?.reason], [403, "Only the person who wrote this message, or the trip's host, can delete it."]);
  const byHost = await host.call("DELETE", `${M}/m-pu`);
  const byAuthor = await ivy.call("DELETE", `${M}/m-ev`);
  t.same("the author deletes theirs, the host anyone's: the words go, a line stays, with who deleted it",
    [byHost.status, byHost.json?.message?.body, byHost.json?.message?.deleted?.by, byAuthor.json?.message?.deleted?.by, byAuthor.json?.message?.author_name],
    [200, "", host.user.id, ivy.user.id, "Ivy Chat"]);
  const again = await ivy.call("DELETE", `${M}/m-ev`);
  t.same("  (deleted again: the same answer, nothing moves)", [again.status, again.json?.message?.touched], [200, byAuthor.json?.message?.touched]);
  const editDeleted = await ivy.call("PATCH", `${M}/m-ev`, { body: "x" });
  t.same("  (a deleted message can't be changed)", [editDeleted.status, Boolean(editDeleted.json?.reason)], [409, true]);
  const changed = (await jon.get(`${M}?after=${counter}`)).json;
  t.same("a phone asking what changed after the counter it had gets the edit and both deletes, in the chat's order",
    changed.messages.map((m) => [m.id, m.deleted ? "deleted" : m.body]), [["m-1", "Who has the train tickets?"], ["m-ev", "deleted"], ["m-pu", "deleted"]]);
  const counts = (await jon.get(`/api/trips/${T}`)).json.chat.about;
  t.same("  (and the counts leave the deleted ones out)", [counts.event, counts.purchase], [{ dinner: 1 }, {}]);

  t.part("Notes on plans are messages about them (migration 0027)");
  {
    // A trip of its own, so the other parts' counts don't move.
    const kim = await person("Kim Chat");
    const lee = await person("Lee Chat");
    const T = (await host.post("/api/trips", { name: "Notes check", default_tz: "UTC", starts_on: "2027-05-01", ends_on: "2027-05-09", currencies: ["EUR"] })).json.trip.id;
    for (const p of [kim, lee]) await bring(host, T, p);
    const M = `/api/trips/${T}/messages`;
    await host.post(`/api/trips/${T}/events`, { id: "dinner", title: "Dinner at the harbour", starts_at: Date.UTC(2027, 4, 2, 19) / 1000, tz: "UTC" });
    await host.post(`/api/trips/${T}/events`, { id: "museum", title: "The tile museum", starts_at: Date.UTC(2027, 4, 3, 10) / 1000, tz: "UTC" });

    const gone = await kim.get(`/api/trips/${T}/notes`);
    const snap0 = (await kim.get(`/api/trips/${T}`)).json;
    t.same("the notes' own address is gone, and the snapshot carries no notes: they are the chat's messages",
      [gone.status, "notes" in snap0], [404, false]);

    // The snapshot says how much has been said about each plan, and about the time before it,
    // and carries the newest two about that time with their words (the Agenda writes them on it).
    const revsOf = async () => (await kim.get(`/api/trips/${T}/rev`)).json;
    const r0 = await revsOf();
    await kim.post(M, { id: "m-cards", body: "Bring the student cards", about: { kind: "event", id: "museum" } });
    const r1 = await revsOf();
    await lee.post(M, { id: "m-plain", body: "Anyone up for a swim?" });
    const r2 = await revsOf();
    t.same("a message about a plan moves the chat's counter and data_rev, so the other phones read the trip's counts; one about nothing moves only the chat's",
      [r1.seq - r0.seq, r1.data_rev === r1.rev && r1.data_rev > r0.data_rev, r2.seq - r1.seq, r2.data_rev === r1.data_rev], [1, true, 1, true]);
    for (const [who, id, body] of [[lee, "m-b1", "Breakfast near it first"], [kim, "m-b2", "Tickets are cheaper online"], [host, "m-b3", "Meet at the gate at 9:50"]]) {
      await who.post(M, { id, body, about: { kind: "event", id: "museum", part: "before" } });
    }
    const chat = (await lee.get(`/api/trips/${T}`)).json.chat.about;
    t.same("the snapshot: 4 about the museum (3 of them about the time before it), and the newest two about that time, oldest first, with who wrote them",
      [chat.event.museum, chat.before.museum, chat.before_recent.museum.map((m) => [m.id, m.author_name, m.body])],
      [4, 3, [["m-b2", "Kim Chat", "Tickets are cheaper online"], ["m-b3", "Hal Chat", "Meet at the gate at 9:50"]]]);
    await host.call("DELETE", `${M}/m-b3`);
    const after = (await lee.get(`/api/trips/${T}`)).json.chat.about;
    t.same("a deleted one leaves the counts and the words on the time before", [after.before.museum, after.before_recent.museum.map((m) => m.id)], [2, ["m-b1", "m-b2"]]);

    // A note the app had waiting from before (this app's, or carried over from the old one by
    // old-queue.js): store.js's wireOf() sends it as a message about its plan, with its own id
    // ("nt_" and a uuid) and part "before" for a note about the time before. Sent twice (a flush
    // that half-succeeded), it lands once.
    const carried = "nt_6f1c2a7e-4b8d-4e1a-9c3f-2d5e7a9b1c40";
    const once = await kim.post(M, { id: carried, body: "Audio guide is free", about: { kind: "event", id: "museum", part: "before" } });
    const twice = await kim.post(M, { id: carried, body: "Audio guide is free", about: { kind: "event", id: "museum", part: "before" } });
    t.same("a note waiting on a phone from before lands as a message about the time before its plan, once even when sent twice",
      [once.status, twice.status, twice.json?.message?.about, server.sql(`SELECT COUNT(*) AS n FROM messages WHERE trip_id = ${q(T)} AND id = ${q(carried)}`)[0].n],
      [201, 200, { kind: "event", id: "museum", part: "before", name: "The tile museum" }, 1]);

    await host.call("DELETE", `/api/trips/${T}/events/museum`);
    const kept = (await lee.get(`${M}?about=event:museum`)).json.messages.filter((m) => !m.deleted).map((m) => m.about.name);
    t.same("the plan removed: what was said about it stays in the chat, with its name", [kept.length, kept.every((name) => name === "The tile museum")], [4, true]);

    // What 0027 makes: a message marked as a note everyone had read. Planted as the migration
    // writes it, the next number in the chat, from someone else.
    const fromOthers = async (who) => (await who.get("/api/trips")).json.trips.find((x) => x.id === T)?.chat?.from_others;
    const was = await fromOthers(host);
    const n0 = server.sql(`SELECT message_seq AS s FROM trips WHERE id = ${q(T)}`)[0].s;
    server.sql(`INSERT INTO messages (trip_id, id, seq, touched, author, body, about_kind, about_id, about_name, created_at, rev, from_note)
      VALUES (${q(T)}, 'n-august', ${n0 + 1}, ${n0 + 1}, ${q(lee.user.id)}, 'Gate changed to 24', 'event', 'dinner', 'Dinner at the harbour', 1754000000, 1, 1)`);
    server.sql(`UPDATE trips SET message_seq = ${n0 + 1} WHERE id = ${q(T)}`);
    const read = (await host.get(`${M}?after=${n0}`)).json.messages.find((m) => m.id === "n-august");
    t.same("a message made from a note says so, and never counts as new: Your trips' newest message from someone else stays where it was",
      [read?.from_note, await fromOthers(host)], [true, was]);
    const fresh = await lee.post(M, { id: "m-new-after", body: "Running late" });
    t.same("a message written after it does count", await fromOthers(host), fresh.json?.message?.seq);

    // An undo of a change recorded before 0027 that removed a note: that note can't come back,
    // and the undo says so; the rest of it undoes.
    await host.call("PUT", `/api/trips/${T}/places`, { places: [{ id: "ferry-dock", name: "The ferry dock", kind: "sight", subkind: "landmark", why: "Boats." }] });
    const dock = server.sql(`SELECT * FROM places WHERE trip_id = ${q(T)} AND id = 'ferry-dock'`)[0];
    server.sql(`INSERT INTO trip_changes (id, trip_id, user_id, source, summary, kind, rev, created_at) VALUES ('ch-old', ${q(T)}, ${q(host.user.id)}, 'An AI app', 'Removed a plan, added a place', 'write', 1, ${Math.floor(Date.now() / 1000)})`);
    server.sql(`INSERT INTO trip_change_rows (change_id, tbl, row_key, before, after) VALUES
      ('ch-old', 'event_notes', '["n-old"]', ${q(JSON.stringify({ id: "n-old", trip_id: T, event_id: "ferry", user_id: host.user.id, body: "Bring water", anchor_kind: "event", created_at: 1754000000, rev: 1 }))}, NULL),
      ('ch-old', 'places', ${q(JSON.stringify([T, "ferry-dock"]))}, NULL, ${q(JSON.stringify(dock))})`);
    const undo = await host.post(`/api/trips/${T}/changes/ch-old/undo`, {});
    const leftNote = undo.json?.left?.find((l) => l.table === "event_notes");
    t.same("an undo of a change from before it that removed a note leaves that note out, saying why, by the note's words; the rest of it undoes",
      [undo.status, leftNote?.why, leftNote?.label, undo.json?.undone, server.sql(`SELECT COUNT(*) AS n FROM places WHERE trip_id = ${q(T)} AND id = 'ferry-dock'`)[0].n],
      [200, "a note on a plan, removed before notes became messages in the chat: it can't be brought back", "Bring water", 1, 0]);
  }

  t.part("Paging, and the limits");
  // A long chat, written underneath (the minute's limit is its own part below).
  const base = (await revs()).seq;
  server.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120)
    INSERT INTO messages (trip_id, id, seq, touched, author, body, created_at) SELECT ${q(T)}, 'p-' || i, ${base} + i, ${base} + i, ${q(jon.user.id)}, 'Line ' || i, 1700000000 FROM n`);
  server.sql(`UPDATE trips SET message_seq = ${base + 120} WHERE id = ${q(T)}`);
  const newest = (await ivy.get(M)).json;
  const older = (await ivy.get(`${M}?before=${newest.messages[0].seq}&limit=${MESSAGES_PAGE_MAX}`)).json;
  t.same("the newest window first (fifty, oldest at the top), then pages back from its first",
    [newest.messages.length, newest.messages.at(-1).id, newest.more, older.messages.at(-1).seq === newest.messages[0].seq - 1, older.messages.length],
    [50, "p-120", true, true, Math.min(MESSAGES_PAGE_MAX, server.sql(`SELECT COUNT(*) AS n FROM messages WHERE trip_id = ${q(T)} AND seq < ${newest.messages[0].seq}`)[0].n)]);
  const tooMany = await ivy.get(`${M}?limit=${MESSAGES_PAGE_MAX + 1}`);
  const badCursor = await ivy.get(`${M}?before=x`);
  t.same("  (a window past its most, and a cursor that isn't a number, are refused in words)", [tooMany.status, Boolean(tooMany.json?.reason), badCursor.status], [400, true, 400]);
  const long = await ivy.post(M, { id: "m-long", body: "a".repeat(MESSAGE_MAX + 1) });
  const empty = await ivy.post(M, { id: "m-empty", body: "  " });
  t.same(`words past ${MESSAGE_MAX} characters, or none: refused, saying what to do`, [long.status, long.json?.reason, empty.status, empty.json?.reason],
    [400, `A message is at most ${MESSAGE_MAX.toLocaleString("en")} characters; this one is ${(MESSAGE_MAX + 1).toLocaleString("en")}. Send it as two.`, 400, "A message needs some words."]);
  const fast = (await host.post("/api/trips", { name: "Busy chat", default_tz: "UTC" })).json.trip.id;
  const sent = [];
  for (let i = 0; i <= MESSAGES_PER_MINUTE; i++) sent.push(await host.post(`/api/trips/${fast}/messages`, { id: `f-${i}`, body: `Quick ${i}` }));
  t.same(`${MESSAGES_PER_MINUTE} messages in a minute go; the next waits, in words`,
    [sent.slice(0, -1).every((r) => r.status === 201), sent.at(-1).status, sent.at(-1).json?.reason], [true, 429, `That's ${MESSAGES_PER_MINUTE} messages in a minute: wait a moment, then send it.`]);
  // (Someone who hasn't just sent thirty.)
  const full = (await jon.post("/api/trips", { name: "Full chat", default_tz: "UTC" })).json.trip.id;
  server.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MESSAGES_PER_TRIP_MAX})
    INSERT INTO messages (trip_id, id, seq, touched, author, body, created_at) SELECT ${q(full)}, 'x-' || i, i, i, ${q(jon.user.id)}, 'x', 1700000000 FROM n`);
  server.sql(`UPDATE trips SET message_seq = ${MESSAGES_PER_TRIP_MAX} WHERE id = ${q(full)}`);
  const over = await jon.post(`/api/trips/${full}/messages`, { id: "one-more", body: "Hello?" });
  t.same(`a chat holding ${MESSAGES_PER_TRIP_MAX.toLocaleString("en")} takes no more, says nothing is deleted to make room, and what the host can do`,
    [over.status, over.json?.error, /Nothing is deleted/.test(over.json?.reason ?? "") && /host can start a new trip/.test(over.json?.reason ?? ""), server.sql(`SELECT COUNT(*) AS n FROM messages WHERE trip_id = ${q(full)}`)[0].n],
    [409, "the chat is full", true, MESSAGES_PER_TRIP_MAX]);

  t.part("The mute, and who reads");
  const muted = await jon.call("PUT", `/api/trips/${T}/chat/mute`, { muted: true });
  t.same("a person mutes a trip's chat: their snapshot says so, nobody else's does", [muted.status, (await jon.get(`/api/trips/${T}`)).json.chat.muted, (await ivy.get(`/api/trips/${T}`)).json.chat.muted], [200, true, false]);
  const outsider = await person("Kim Chat");
  const notOn = await outsider.get(M);
  const notOnPost = await outsider.post(M, { id: "m-out", body: "hi" });
  t.same("someone not on the trip reads and writes nothing of its chat", [notOn.status, notOnPost.status], [404, 404]);

  t.part("Someone who goes keeps their name on what they wrote");
  await jon.call("DELETE", `/api/trips/${T}/members/${jon.user.id}`);
  const afterLeaving = (await ivy.get(M)).json.messages.concat((await ivy.get(`${M}?about=event:dinner`)).json.messages);
  t.same("someone who left: their messages stay, under their name; they read the chat no more",
    [afterLeaving.find((m) => m.id === "m-ev-before")?.author_name, (await jon.get(M)).status], ["Jon Chat", 404]);
  const deleting = await ivy.call("DELETE", "/api/me", { confirm: "delete" });
  const byIvy = server.sql(`SELECT m.id, m.body, u.name FROM messages m JOIN users u ON u.id = m.author WHERE m.trip_id = ${q(T)} AND m.author = ${q(ivy.user.id)} ORDER BY m.seq`);
  t.same("someone who deletes their account: their messages stay in the chat with their words, under the name the account keeps",
    [deleting.status, byIvy.map((m) => [m.id, m.name]), byIvy.find((m) => m.id === "m-1")?.body], [200, [["m-1", "Ivy Chat"], ["m-ev", "Ivy Chat"], ["m-pl", "Ivy Chat"]], "Who has the train tickets?"]);
  const page = fs.readFileSync(path.join(ROOT, "public/account.html"), "utf8");
  const keptLine = /<span class="strong">Stays on the trip:<\/span>([^<]*)</.exec(page)?.[1] ?? "";
  t.ok("the account page's sentence about what stays names what they wrote in the chat", /chat/.test(keptLine), keptLine);

  t.part("A trip deleted takes its chat");
  const goes = (await host.post("/api/trips", { name: "Short chat", default_tz: "UTC" })).json.trip.id;
  await host.post(`/api/trips/${goes}/messages`, { id: "bye", body: "Bye" });
  const gone = await host.call("DELETE", `/api/trips/${goes}`, { confirm: "Short chat" });
  t.same("every message of it goes with it", [gone.status, server.sql(`SELECT COUNT(*) AS n FROM messages WHERE trip_id = ${q(goes)}`)[0].n], [200, 0]);

  t.part("Underneath");
  const failed = server.log().split("\n").filter((l) => /Uncaught|✘|\[ERROR\]/.test(l));
  t.ok("nothing failed inside the server", failed.length === 0, failed.slice(0, 6).join("\n        "));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await server?.stop();
}
process.exit(code);

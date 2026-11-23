// When a memory happened, beside when it was posted (migration 0029, src/api/memories.js), on a server
// of its own:
//
//   node checks/memories/day.mjs [--port <port>]
//
// It holds:
//   1. a memory posted with its day and its photographs' time carries both (`at` the order it pages
//      in); a day alone invents no time and pages as the newest of its day; one posted without
//      either happened when it was posted; a day or a time that can't be is kept as none, never
//      refused (a refused post is a lost one), and named in the answer (`not_taken`);
//      `created_at` is the posting time either way, so "posted later" is known;
//   2. the feed orders by `at`, newest first, and pages by (at, id) with nothing repeated or skipped;
//   3. only its poster changes it (PATCH day, taken_at; a key not sent stays), in words; both null
//      puts it back to the posting time; one that can't be is refused in words;
//   4. a field the routes don't take is named in the answer (told()), the write still made.
// Everyone in it is made up.

import { CheckError, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const t = new Report("when a memory happened");
const DAY = 86400;

let server, code = 1;
try {
  server = await startServer({ name: "memory-day", port });
  await server.start();
  const { origin } = server;
  const [ada, ben, cleo] = ["Ada Reyes", "Ben Okafor", "Cleo Tran"].map((n) => new Person(origin, n));
  for (const p of [ada, ben, cleo]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const trip = (await ada.post("/api/trips", { name: "Coast week", default_tz: "UTC" })).json.trip.id;
  for (const p of [ben, cleo]) await p.post(`/api/join/${(await ada.post(`/api/trips/${trip}/links`, { uses: 1 })).json.link.code}`);
  const M = `/api/trips/${trip}/memories`;
  const now = Math.floor(Date.now() / 1000);

  t.part("1. Posted, with and without the time it happened");
  const ymd = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
  const endOf = (d) => Date.parse(`${d}T23:59:59Z`) / 1000;   // the trip is on UTC
  const onBoat = now - 9 * DAY + 3600;                         // nine days ago, on the boat
  const dinnerDay = ymd(now - 6 * DAY);
  const a = await ada.post(M, { id: "mem-boat", caption: "The boat at dawn", day: ymd(onBoat), taken_at: onBoat });
  const b = await ben.post(M, { id: "mem-now", caption: "Back home, the last of the coffee" });
  const c = await cleo.post(M, { id: "mem-dinner", caption: "Dinner by the harbour", day: dinnerDay });
  const d = await ben.post(M, { id: "mem-odd", caption: "A camera whose clock was never set", day: "2026-02-30", taken_at: 100 });
  const mem = (r) => r.json?.memory ?? {};
  t.same("its day and the time its photographs were taken are carried, and `at` is that time",
    [mem(a).day, mem(a).taken_at, mem(a).at], [ymd(onBoat), onBoat, onBoat]);
  t.same("a day chosen with no time: no time invented, and it pages as the newest of its day (its last second in the trip's zone)",
    [mem(c).day, mem(c).taken_at, mem(c).at], [dinnerDay, null, endOf(dinnerDay)]);
  t.same("posted without either, it happened when it was posted", [mem(b).day, mem(b).taken_at, mem(b).at === mem(b).created_at], [null, null, true]);
  t.same("posted later is known: created_at is when it was posted, whatever day it happened", Math.abs(mem(a).created_at - now) <= 5, true);
  t.same("a day that isn't on the calendar and a time that can't be: posted all the same, kept as none, and each NAMED in the answer",
    [d.status, mem(d).day, mem(d).taken_at, (d.json?.not_taken ?? []).map((x) => x.field), (d.json?.not_taken ?? []).every((x) => x.reason.length > 20)], [201, null, null, ["day", "taken_at"], true]);
  t.same("  (a post with nothing wrong names nothing)", [a.json?.not_taken, c.json?.not_taken], [undefined, undefined]);
  // A phone whose clock runs a month fast reads a photograph from yesterday as one from days ahead:
  // the day and the time are held to the same window (to two days from now, in the trip's zone).
  const fast = await cleo.post(M, { id: "mem-fast", caption: "A phone a month fast", day: ymd(now + 10 * DAY), taken_at: now + 10 * DAY });
  t.same("a day and a time still to come (a phone's clock running fast): posted, kept as none, both named, so it isn't at the top of the feed until then",
    [fast.status, mem(fast).day, mem(fast).taken_at, mem(fast).at === mem(fast).created_at, (fast.json?.not_taken ?? []).map((x) => x.field)], [201, null, null, true, ["day", "taken_at"]]);
  const edge = await cleo.post(M, { id: "mem-edge", caption: "Across the date line", day: ymd(now + 2 * DAY) });
  t.same("  (two days ahead is still a day: a trip across the date line)", [edge.status, mem(edge).day, edge.json?.not_taken], [201, ymd(now + 2 * DAY), undefined]);

  t.part("2. The feed, by when each happened");
  const all = await ada.get(M);
  t.same("newest first by when it happened: the ones posted now, then dinner, then the boat",
    all.json.memories.map((m) => m.id).slice(-2), ["mem-dinner", "mem-boat"]);
  const pages = [];
  let q = `${M}?limit=1`;
  for (let i = 0; i < 10; i++) {
    const r = await ada.get(q);
    pages.push(...r.json.memories.map((m) => m.id));
    if (!r.json.has_more) break;
    const last = r.json.memories.at(-1);
    q = `${M}?limit=1&before=${r.json.next_before}&before_id=${encodeURIComponent(last.id)}`;
  }
  t.same("paged one at a time by (at, id): every memory once, in the same order", pages, all.json.memories.map((m) => m.id));

  t.part("3. Changing the day");
  const notHers = await ben.call("PATCH", `${M}/mem-boat`, { day: dinnerDay, taken_at: null });
  const notByHost = await ada.call("PATCH", `${M}/mem-dinner`, { day: ymd(onBoat) });
  t.same("only its poster changes it (not someone else, not the host), in words", [notHers.status, notHers.json?.error, !!notHers.json?.reason, notByHost.status], [403, "not yours", true, 403]);
  const moved = await ada.call("PATCH", `${M}/mem-boat`, { day: dinnerDay, taken_at: null });
  t.same("its poster moves it to another day: the time goes, the order is that day's end, posted stays",
    [moved.status, mem(moved).day, mem(moved).taken_at, mem(moved).at, mem(moved).created_at === mem(a).created_at], [200, dinnerDay, null, endOf(dinnerDay), true]);
  const partial = await ada.call("PATCH", `${M}/mem-boat`, { taken_at: onBoat });
  t.same("a key not sent stays as it was (the day), the one sent changes (the time)", [mem(partial).day, mem(partial).taken_at, mem(partial).at], [dinnerDay, onBoat, onBoat]);
  const back = await cleo.call("PATCH", `${M}/mem-dinner`, { day: null, taken_at: null });
  t.same("both null: back to when it was posted", [back.status, mem(back).day, mem(back).at === mem(back).created_at], [200, null, true]);
  const bad = await ada.call("PATCH", `${M}/mem-boat`, { day: "yesterday" });
  const ahead = await ada.call("PATCH", `${M}/mem-boat`, { day: ymd(now + 10 * DAY) });
  t.same("an edit to a day still to come is refused in words, nothing changed", [ahead.status, ahead.json?.error, !!ahead.json?.reason, server.sql("SELECT day FROM memories WHERE id = 'mem-boat'")[0].day], [400, "bad day", true, dinnerDay]);
  t.same("an edit to a day that isn't one is refused in words, nothing changed", [bad.status, bad.json?.error, !!bad.json?.reason, server.sql("SELECT day FROM memories WHERE id = 'mem-boat'")[0].day], [400, "bad day", true, dinnerDay]);

  t.part("4. A field the routes don't take");
  const extra = await ben.post(M, { id: "mem-extra", caption: "A sunset", happened_at: onBoat });
  t.same("named in the answer, and the memory still posted", [extra.status, extra.json?.ignored], [201, ["happened_at"]]);
  const extraEdit = await ben.call("PATCH", `${M}/mem-extra`, { taken_at: onBoat, when: "yesterday" });
  t.same("  (and in an edit)", [extraEdit.status, extraEdit.json?.ignored, mem(extraEdit).taken_at], [200, ["when"], onBoat]);
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await server?.stop();
}
process.exit(code);

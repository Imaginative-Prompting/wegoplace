// A write sent again, its first answer lost on the way (a bad connection, or a phone that gave up
// waiting), on a server of its own:
//
//   node checks/retry/run.mjs [--port <port>]
//
// Every request here is sent twice, the second exactly as the first, and the second must answer as
// the first did, with nothing written twice:
//   1. a memory with photographs (POST …/memories): the same memory, its photographs on it once,
//      never refused for photographs it already holds; someone else's id is still refused, and so is
//      a photograph already on another memory;
//   2. finishing an upload (POST …/media/finish) after it stored the file: the same answer, the
//      trip's rev not moved; another uploadId is still refused;
//   3. beginning an upload with its own id (POST …/media/begin {…, id}): the same key and uploadId,
//      its bytes held once; the same id with another file is refused in words; one that finished
//      or lapsed begins afresh; a begin with no id is as it always was.
// Everyone in it is made up.

import { CheckError, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const t = new Report("a write sent again");
const DAY = 86400;

let server, code = 1;
try {
  server = await startServer({ name: "retry", port });
  await server.start();
  const { origin } = server;
  const [ada, ben] = ["Ada Reyes", "Ben Okafor"].map((n) => new Person(origin, n));
  for (const p of [ada, ben]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const trip = (await ada.post("/api/trips", { name: "Coast week", default_tz: "UTC" })).json.trip.id;
  await ben.post(`/api/join/${(await ada.post(`/api/trips/${trip}/links`, { uses: 1 })).json.link.code}`);
  const at = `/api/trips/${trip}`;
  const rev = async () => (await ada.get(`${at}/rev`)).json?.rev;
  const n = (sql) => server.sql(sql)[0].n;
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

  /** Begins, sends and finishes one small file as `who`; answers { begun, part, done, bytes }. */
  async function upload(who, name, extra = {}) {
    const bytes = Buffer.from(`${name}: a photograph, for the retry check`);
    const begun = await who.post(`${at}/media/begin`, { name, mime: "image/jpeg", bytes: bytes.length, ...extra });
    if (begun.status !== 201 && begun.status !== 200) throw new CheckError(`begin answered ${begun.status}: ${begun.text.slice(0, 200)}`);
    const up = `key=${encodeURIComponent(begun.json.key)}&id=${encodeURIComponent(begun.json.uploadId)}`;
    const part = await who.call("PUT", `${at}/media/part?${up}&n=1`, bytes, { headers: { "Content-Type": "application/octet-stream" } });
    const finish = { key: begun.json.key, id: begun.json.uploadId, parts: [{ n: 1, etag: part.json?.etag }] };
    const done = await who.post(`${at}/media/finish`, finish);
    return { begun, part, done, finish, bytes };
  }

  t.part("1. A memory with photographs, sent again");
  const sea = await upload(ada, "sea.jpg");
  const cliff = await upload(ada, "cliff.jpg");
  const post = { id: "mem-sea", caption: "The sea from the cliff path", tags: ["Coast"], media: [sea, cliff].map((u) => ({ key: u.begun.json.key, kind: "photo", w: 4032, h: 3024 })) };
  const first = await ada.post(`${at}/memories`, post);
  const r1 = await rev();
  const again = await ada.post(`${at}/memories`, post);
  const keys = (r) => (r.json?.memory?.media ?? []).map((m) => m.key);
  t.same("the first post makes it (201) with both photographs", [first.status, keys(first)], [201, post.media.map((m) => m.key)]);
  t.same("sent again: 200 with the same memory, not 409 \"media already attached\"",
    [again.status, again.json?.error, again.json?.memory?.id, keys(again), again.json?.memory?.caption], [200, undefined, "mem-sea", keys(first), post.caption]);
  t.same("  nothing written twice: one memory, its two photographs once each, one tag, the trip's rev not moved",
    [n("SELECT COUNT(*) AS n FROM memories WHERE id = 'mem-sea'"), n("SELECT COUNT(*) AS n FROM memory_media WHERE memory_id = 'mem-sea'"),
      n("SELECT COUNT(*) AS n FROM memory_tags WHERE memory_id = 'mem-sea'"), await rev()], [1, 2, 1, r1]);
  const third = await ada.post(`${at}/memories`, post);
  t.same("  and a third time, the same", [third.status, third.json?.memory?.id, keys(third)], [200, "mem-sea", keys(first)]);

  const odd = await upload(ada, "odd.jpg");
  const oddPost = { id: "mem-odd", caption: "A camera whose clock was never set", day: "2026-02-30", media: [{ key: odd.begun.json.key, kind: "photo" }] };
  const oddFirst = await ada.post(`${at}/memories`, oddPost);
  const oddAgain = await ada.post(`${at}/memories`, oddPost);
  const fields = (r) => (r.json?.not_taken ?? []).map((x) => x.field);
  t.same("a post whose day couldn't be kept says so the second time as the first (not_taken)",
    [oddFirst.status, fields(oddFirst), oddAgain.status, fields(oddAgain)], [201, ["day"], 200, ["day"]]);

  const bens = await ben.post(`${at}/memories`, { ...post, caption: "Mine now" });
  t.same("someone else sending that id is still refused, and nothing changes",
    [bens.status, bens.json?.error, server.sql("SELECT caption, created_by FROM memories WHERE id = 'mem-sea'")[0].caption], [409, "id already exists", post.caption]);
  const stapled = await ada.post(`${at}/memories`, { id: "mem-other", caption: "The same photograph again", media: [post.media[0]] });
  t.same("a NEW memory with a photograph already on another is still refused (the check still guards)",
    [stapled.status, stapled.json?.error, n("SELECT COUNT(*) AS n FROM memories WHERE id = 'mem-other'")], [409, "media already attached", 0]);

  t.part("2. Finishing an upload, sent again after it stored the file");
  const tide = await upload(ada, "tide.jpg");
  const r2 = await rev();
  const finishAgain = await ada.post(`${at}/media/finish`, tide.finish);
  const shape = (r) => { const { ok, key, bytes, mime, url, etag } = r.json ?? {}; return { ok, key, bytes, mime, url, etag }; };
  t.same("the first finish stores it", [tide.done.status, tide.done.json?.ok, tide.done.json?.bytes], [200, true, tide.bytes.length]);
  t.same("sent again: 200 with what the first answered (key, bytes, type, address, etag), not 409 \"upload already stored\"",
    [finishAgain.status, shape(finishAgain)], [200, shape(tide.done)]);
  t.same("  nothing written: the trip's rev as it was, one stored row at its size",
    [await rev(), finishAgain.json?.rev, server.sql(`SELECT state, bytes FROM media_objects WHERE r2_key = ${q(tide.begun.json.key)}`)],
    [r2, r2, [{ state: "stored", bytes: tide.bytes.length }]]);
  t.same("  and the file is there to fetch", (await ben.get(`/media/${tide.begun.json.key}`)).status, 200);
  const wrongId = await ada.post(`${at}/media/finish`, { ...tide.finish, id: "another-upload" });
  t.same("finishing it with another uploadId is still refused", [wrongId.status, wrongId.json?.error], [409, "upload already stored"]);
  const bensFinish = await ben.post(`${at}/media/finish`, tide.finish);
  t.same("so is somebody else finishing it", bensFinish.status, 403);

  t.part("3. Beginning an upload with its own id, sent again");
  const decl = { name: "harbour.mov", mime: "video/quicktime", bytes: 20 * 1024 * 1024 + 7, kind: "video" };
  const pending = () => server.sql(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM media_objects WHERE trip_id = ${q(trip)} AND state = 'pending'`)[0];
  const before = pending();
  const b1 = await ada.post(`${at}/media/begin`, { ...decl, id: "up-harbour" });
  const b2 = await ada.post(`${at}/media/begin`, { ...decl, id: "up-harbour" });
  t.same("the first begin opens it (201)", [b1.status, !!b1.json?.key, !!b1.json?.uploadId, b1.json?.parts], [201, true, true, 3]);
  t.same("sent again with the same id: 200, the same key and uploadId, the same plan",
    [b2.status, b2.json?.key, b2.json?.uploadId, b2.json?.parts, b2.json?.part_size], [200, b1.json?.key, b1.json?.uploadId, 3, b1.json?.part_size]);
  t.same("  its bytes are held once: one upload under way more than before, at its size",
    [pending().n - before.n, pending().b - before.b], [1, decl.bytes]);
  const other = await ada.post(`${at}/media/begin`, { ...decl, bytes: decl.bytes + 1, id: "up-harbour" });
  t.same("the same id with another file is refused in words, and nothing more held",
    [other.status, other.json?.error, (other.json?.reason ?? "").length > 20, pending().n - before.n], [409, "id already used", true, 1]);
  const bensBegin = await ben.post(`${at}/media/begin`, { ...decl, id: "up-harbour" });
  t.same("an id is the person's own: someone else's begin with it opens their own upload",
    [bensBegin.status, bensBegin.json?.key !== b1.json?.key], [201, true]);
  const bad = await ada.post(`${at}/media/begin`, { ...decl, id: "Not An Id!" });
  t.same("an id that can't be one is refused in words", [bad.status, bad.json?.error, (bad.json?.reason ?? "").length > 20], [400, "bad id", true]);

  server.sql(`UPDATE media_objects SET created_at = created_at - ${2 * DAY} WHERE r2_key = ${q(b1.json.key)}`);
  const lapsed = await ada.post(`${at}/media/begin`, { ...decl, id: "up-harbour" });
  t.same("once its day has passed, the same id begins afresh (a new key: the old one no longer holds its room)",
    [lapsed.status, lapsed.json?.key !== b1.json?.key], [201, true]);
  const pool = await upload(ada, "pool.jpg", { id: "up-pool" });
  const poolAgain = await upload(ada, "pool.jpg", { id: "up-pool" });
  t.same("once it finished, the same id begins afresh too (a second file is a second file)",
    [pool.done.status, poolAgain.begun.status, poolAgain.begun.json?.key !== pool.begun.json?.key], [200, 201, true]);

  const nb1 = await ada.post(`${at}/media/begin`, { name: "rock.jpg", mime: "image/jpeg", bytes: 1000 });
  const nb2 = await ada.post(`${at}/media/begin`, { name: "rock.jpg", mime: "image/jpeg", bytes: 1000 });
  t.same("a begin that names no id is as it always was: each one its own upload",
    [nb1.status, nb2.status, nb1.json?.key !== nb2.json?.key], [201, 201, true]);

  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await server?.stop();
}
process.exit(code);

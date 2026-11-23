// EVERY WRITE'S LIMITS, CROSSED. Reads the route table itself (src/routes.js ROUTES): a row that writes without
// its limits written in checks/limits/rules.mjs fails, and so does a rule for no row. Then each kind of limit is
// crossed on every row that names it, and what happens is held:
//   - past a limit: 429 (or 413, or the cap's own 4xx) with a reason in words, a 429 with Retry-After too, and
//     nothing written (every table read from the database file before and after);
//   - every path that stores bytes, with the host's room all but used: refused whole (413 "storage full"), nothing
//     written and no file in the bucket;
//   - JSON past JSON_BODY_MAX on every write row: 413 before anything reads it;
//   - what a stranger could flood: accounts and passkey challenges, sign-in links, join codes (and how long a
//     code takes to guess within these limits), trips, the chat, the MCP; and the reads named in READS.
// Then the table of limits as written, for the README (--table prints it alone).
//
//   node checks/limits/sweep.mjs [--port <n>] [--table]   (a free port when not named)
//
// Everyone in it is made up.

import { CheckError, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { jpegOfSize, png } from "../lib/images.mjs";
import { startModel } from "../lib/model-standin.mjs";
import { connect, McpClient } from "../lib/mcp.mjs";
import { bucketFiles, dbOf } from "../lib/db-file.mjs";
import { ROUTES } from "../../src/routes.js";
import { FREE_STORAGE_BYTES, JSON_BODY_MAX, LINKS_LIVE_MAX, MESSAGES_PER_MINUTE, MESSAGES_PER_TRIP_MAX, PICTURE_FETCHES_PER_MINUTE,
  PICTURE_LIMITS, ROWS_PER_WRITE_MAX, TRIPS_HOSTED_MAX, PUSH_PHONES_MAX, BOARDS_PER_TRIP_MAX, CONVERSATIONS_PER_PERSON_MAX, PURCHASES_PER_TRIP_MAX,
  EXPORTS_PER_HOUR, GUESTS_PER_ADDRESS_HOUR, GUESTS_PER_LINK_HOUR, REJOIN_LINKS_PER_HOUR, TRIP_MEMBERS_MAX } from "../../public/js/shared/limits.js";
import { BYTE_PATHS, LIMITS, READS } from "./rules.mjs";

const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : await freePort());

/** The table of limits as written, in Markdown. */
export function limitsTable() {
  const rows = [...Object.entries(LIMITS), ...Object.entries(READS)].map(([k, v]) => `| \`${k}\` | ${v.limit.replace(/\|/g, "\\|")} |`);
  return [
    "Two kinds of limit. A count the site keeps in its database is counted over the last minute or hour it names,",
    "on every request: the chat's messages a minute, sign-in codes (5 tries each, counted in one statement; 5 sent",
    "an hour), exports an hour, and every cap on how many. A limit a minute on a",
    "connection, a session, an account's pictures, the MCP or a trip's map plans is Cloudflare's rate limiting,",
    "and approximate: it counts per clock minute, so a burst across the turn of a minute can reach twice it;",
    "each Cloudflare location counts on its own; and a call is counted a moment late. These limits slow abuse",
    "and cost. None of them keeps a secret: what can be guessed is either too long to guess (a passkey, a",
    "sign-in link, a join code) or has its tries counted in the database (a sign-in code).",
    "",
    "| Route | Its limits |", "|---|---|", ...rows,
  ].join("\n");
}
if (argv.includes("--table")) { console.log(limitsTable()); process.exit(0); }

const t = new Report("every write's limits, crossed");
const KEY = "sk-or-check-not-real";
let server, maps, model, code = 1;
try {
  model = await startModel({ key: KEY });
  // The site's push keys (made here, as check:push makes them), so a phone can be told of a chat.
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const vjwk = await crypto.subtle.exportKey("jwk", vapid.privateKey);
  const VAPID_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey("raw", vapid.publicKey)).toString("base64url");
  const VAPID_PRIVATE_KEY = JSON.stringify({ kty: vjwk.kty, crv: vjwk.crv, d: vjwk.d, x: vjwk.x, y: vjwk.y });
  server = await startServer({
    name: "limits", port,
    vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true",
      ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5", OPENROUTER_API_BASE: model.base,
      GOOGLE_CLIENT_ID: "check-google.apps.example" },
    secrets: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", OPENROUTER_API_KEY: KEY, GOOGLE_CLIENT_SECRET: "check-google-secret", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY },
  });
  await server.start();
  const o = server.origin;
  const db = dbOf(server);
  const people = [];
  const person = async (name) => { const p = new Person(o, name); if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${name}`); people.push(p); return p; };
  const stranger = (name) => new Person(o, name);
  const keys = ROUTES.map(([m, p]) => `${m} ${p}`);
  const writes = keys.filter((k) => !k.startsWith("GET "));

  /** A refusal as the rules say: its status, a reason in words, a 429's Retry-After. */
  const refusedAsSaid = (r, statuses) => statuses.includes(r.status)
    && typeof (r.json?.reason ?? r.json?.error_description ?? r.json?.rows?.[0]?.error) === "string"
    && (r.json?.reason ?? r.json?.error_description ?? r.json?.rows?.[0]?.error).length > 10
    && (r.status !== 429 || /^\d+$/.test(r.headers?.find?.(([k]) => k === "retry-after")?.[1] ?? ""));
  const show = (r) => `${r.status} ${JSON.stringify(r.json ?? r.text ?? "").slice(0, 160)} retry-after ${r.headers?.find?.(([k]) => k === "retry-after")?.[1] ?? "none"}`;
  // The limits count in minutes aligned to the clock (the runtime's windows: floor(now / 60 s)), so a burst
  // that a minute's turn splits in two is never refused. Each burst starts with MINUTE_LEFT of its minute
  // left, or waits for the next; one the minute turned under anyway, unrefused, is sent once more from a
  // new minute's start, and says so.
  const MINUTE = 60_000, MINUTE_LEFT = 20_000;
  const minuteNow = () => Math.floor(Date.now() / MINUTE);
  const roomInMinute = async (need) => { const left = MINUTE - (Date.now() % MINUTE); if (left < need) await new Promise((r) => setTimeout(r, left + 250)); };
  /** The last of `n` calls is refused, and wrote nothing. Answers [the call before, the refused one, what it wrote]. */
  async function crossBy(n, send) {
    for (let attempt = 0; ; attempt++) {
      await roomInMinute(attempt ? MINUTE : MINUTE_LEFT);
      const minute = minuteNow();
      let last = null;
      for (let i = 0; i < n - 1; i++) { last = await send(i); if (last.status === 429) break; }
      const before = db.snap();
      const refused = await send(n);
      const result = { refused, wrote: db.diff(before, db.snap()), sentBefore: last };
      if (refused.status === 429 || minuteNow() === minute || attempt === 1) return result;
      console.log("    (a minute turned over mid-burst, unrefused: sent again from a new minute's start)");
    }
  }

  t.part("1. Every write row has its limits written");
  const missing = writes.filter((k) => !LIMITS[k]);
  t.ok(`every write row of the route table (${writes.length}) has its limits written`, missing.length === 0, `none written: ${missing.join(", ")}`);
  const stale = [...Object.keys(LIMITS), ...Object.keys(READS)].filter((k) => !keys.includes(k));
  t.ok("every limit is for a row that's there", stale.length === 0, stale.join(", "));

  t.part(`2. JSON past ${JSON_BODY_MAX / 1024 / 1024} MB, on every write row: 413 before it's read`);
  {
    const big = JSON.stringify({ pad: "x".repeat(JSON_BODY_MAX + 10) });
    const before = db.snap();
    const wrong = [];
    for (const k of writes) {
      const [m0, pat] = [k.slice(0, k.indexOf(" ")), k.slice(k.indexOf(" ") + 1)];
      const r = await stranger("Big").call(m0 === "*" ? "POST" : m0, pat.replace(/:([a-z]+)\*?/g, "x"), big, { headers: { "Content-Type": "application/json" } });
      if (r.status !== 413 || !/at most/.test(r.json?.reason ?? "")) wrong.push(`${k}: ${r.status}`);
    }
    t.ok(`each refused 413 in words (${writes.length} rows)`, wrong.length === 0, wrong.slice(0, 5).join(" | "));
    t.ok("  and nothing written", db.diff(before, db.snap()).length === 0, db.diff(before, db.snap()).join(", "));
  }

  const host = await person("Ada Host");
  const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
  const trip = (await host.post("/api/trips", { name: "Limits trip", default_tz: "UTC", starts_on: day(0), ends_on: day(20) })).json.trip.id;
  const T = `/api/trips/${trip}`;

  t.part("3. A connection's tries: 60 a minute, each row that says so");
  for (const [k, rule] of [...Object.entries(LIMITS), ...Object.entries(READS)]) {
    const by = rule.by.find((b) => b.startsWith("connection:"));
    if (!by) continue;
    const [m, pat] = [k.slice(0, k.indexOf(" ")), k.slice(k.indexOf(" ") + 1)];
    const needsSignIn = /passkeys|\/api\/join\/:code$/.test(pat) && m === "POST";
    const who = needsSignIn ? await person(`Tries ${k.length}`) : stranger(`Tries ${k.length}`);
    const address = pat.replace(":code", "J".repeat(22)).replace(":provider", "google");
    const send = () => who.call(m, address, m === "GET" ? null : { name: "Somebody", email: "nobody@example.org", token: "a".repeat(43), id: "x", code: "123456" }, { page: pat.startsWith("/login/") });
    const { refused, wrote } = await crossBy(62, send);
    const said = rule.busy ? refused.status === 303 && /busy/.test(refused.location ?? "") : refusedAsSaid(refused, [429]);
    t.ok(`${k}: refused past its tries (${by.split(":")[1]})${rule.busy ? ", back to the sign-in page saying to wait" : ", in words, with when to try again"}, nothing written`,
      said && wrote.length === 0, `${show(refused)} ${refused.location ?? ""} | wrote ${wrote.join(", ")}`);
  }

  t.part(`4. An account's pictures: ${PICTURE_FETCHES_PER_MINUTE} fetches and ${PICTURE_FETCHES_PER_MINUTE} upload links a minute`);
  await host.call("PUT", `${T}/places`, { places: [{ id: "p-1", name: "Pier", kind: "sight", subkind: "viewpoint", why: "A view." }] });
  for (const [k, rule] of Object.entries(LIMITS)) {
    const by = rule.by.find((b) => b.startsWith("pictures:"));
    if (!by) continue;
    const who = await person(`Pictures ${k.length}`);
    await who.post(`/api/join/${(await host.post(`${T}/links`, { uses: 1 })).json.link.code}`);
    const address = k.slice(k.indexOf(" ") + 1).replace(":trip", trip).replace(":kind", "place").replace(":id", "p-1");
    // An https address that resolves nowhere: each fetch is counted, then fails.
    const body = by === "pictures:fetch" ? { url: "https://picture.invalid/x.png", license: "own" } : { license: "own" };
    const { refused, wrote } = await crossBy(PICTURE_FETCHES_PER_MINUTE + 2, () => who.post(address, body));
    t.ok(`${k}: refused past ${PICTURE_FETCHES_PER_MINUTE} a minute, in words, with when, nothing written`, refusedAsSaid(refused, [429]) && wrote.length === 0, `${show(refused)} | wrote ${wrote.join(", ")}`);
  }

  t.part(`5. The chat: ${MESSAGES_PER_MINUTE} a minute a person, ${MESSAGES_PER_TRIP_MAX.toLocaleString("en-US")} a trip`);
  {
    const ben = await person("Ben Chat");
    await ben.post(`/api/join/${(await host.post(`${T}/links`, { uses: 1 })).json.link.code}`);
    const { refused, wrote } = await crossBy(MESSAGES_PER_MINUTE + 2, (i) => ben.post(`${T}/messages`, { id: `m-${i}`, body: `Hello ${i}` }));
    t.ok(`a person's ${MESSAGES_PER_MINUTE + 1}st message in a minute: refused in words, with when, nothing written`, refusedAsSaid(refused, [429]) && wrote.length === 0, `${show(refused)} | wrote ${wrote.join(", ")}`);
    const full = (await host.post("/api/trips", { name: "Full chat", default_tz: "UTC" })).json.trip.id;
    server.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MESSAGES_PER_TRIP_MAX})
      INSERT INTO messages (trip_id, id, seq, touched, author, body, created_at, rev) SELECT '${full}', 'plant-' || i, i, i, '${host.user.id}', 'Planted', 1, 1 FROM n`);
    server.sql(`UPDATE trips SET message_seq = ${MESSAGES_PER_TRIP_MAX} WHERE id = '${full}'`);
    const before = db.snap();
    const r = await host.post(`/api/trips/${full}/messages`, { id: "m-over", body: "One more" });
    t.ok(`a chat holding ${MESSAGES_PER_TRIP_MAX.toLocaleString("en-US")}: the next refused in words, nothing written`, refusedAsSaid(r, [409]) && db.diff(before, db.snap()).length === 0, show(r));
  }

  t.part("6. A trip's caps and a write's rows");
  {
    const cross = async (what, fill, over, statuses = [400, 409, 413, 422]) => {
      const filled = await fill();
      const before = db.snap();
      const r = await over();
      const wrote = db.diff(before, db.snap());
      t.ok(`${what}: refused in words, nothing written`, filled && refusedAsSaid(r, statuses) && wrote.length === 0, `${show(r)} | filled ${filled} | wrote ${wrote.join(", ")}`);
    };
    const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
    await cross(`a write of ${ROWS_PER_WRITE_MAX + 1} places`, async () => true,
      () => host.call("PUT", `${T}/places`, { places: rows(ROWS_PER_WRITE_MAX + 1, (i) => ({ id: `w-${i}`, name: `W ${i}`, kind: "sight", subkind: "viewpoint", why: "x" })) }));
    const capTrip = (await host.post("/api/trips", { name: "Caps", default_tz: "UTC", starts_on: day(0), ends_on: day(20) })).json.trip.id;
    const C = `/api/trips/${capTrip}`;
    const fillPut = async (address, key, n, f) => { for (let a = 0; a < n; a += ROWS_PER_WRITE_MAX) { const r = await host.call("PUT", address, { [key]: rows(Math.min(ROWS_PER_WRITE_MAX, n - a), (i) => f(a + i)) }); if (r.status >= 300) return false; } return true; };
    await cross("a trip's 201st area", () => fillPut(`${C}/areas`, "areas", 200, (i) => ({ id: `a-${i}`, name: `Area ${i}`, sort: i })),
      () => host.call("PUT", `${C}/areas`, { areas: [{ id: "a-over", name: "Over", sort: 999 }] }));
    await cross("a trip's 2,001st place", () => fillPut(`${C}/places`, "places", 2000, (i) => ({ id: `p-${i}`, name: `Place ${i}`, kind: "sight", subkind: "viewpoint", why: "x" })),
      () => host.call("PUT", `${C}/places`, { places: [{ id: "p-over", name: "Over", kind: "sight", subkind: "viewpoint", why: "x" }] }));
    const t0 = Math.floor(Date.now() / 1000) + 3600;
    await cross("a trip's 2,001st plan (one at a time)", () => fillPut(`${C}/events`, "events", 2000, (i) => ({ id: `e-${i}`, title: `Plan ${i}`, kind: "plan", starts_at: t0 + i, tz: "UTC" })),
      () => host.post(`${C}/events`, { id: "e-over", title: "Over", starts_at: t0, tz: "UTC" }));
    await cross("a person's 301st item on their own list", () => fillPut(`${C}/packing/items`, "items", 300, (i) => ({ id: `k-${i}`, label: `Thing ${i}`, category: "gear", list: "mine" })),
      () => host.post(`${C}/packing`, { id: "k-over", label: "Over", category: "gear", owner: host.user.id }));
    // A trip starts with lists of its own: filled up to the most from there.
    const had = (await host.get(C)).json.packing_lists.length;
    await cross("a trip's 11th packing list", async () => (await host.call("PUT", `${C}/packing/lists`, { lists: rows(10 - had, (i) => ({ key: `l-${i}`, name: `List ${i}`, bags: [{ key: "b", name: "Bag" }] })) })).status < 300,
      () => host.call("PUT", `${C}/packing/lists`, { lists: [{ key: "l-over", name: "Over", bags: [{ key: "b", name: "Bag" }] }] }));
    await cross("a trip's 201st starter", async () => (await host.call("PATCH", `${C}/packing/starters`, { starters: rows(200, (i) => ({ scope: "group", label: `Starter ${i}`, category: "gear" })) })).status < 300,
      () => host.call("PATCH", `${C}/packing/starters`, { starters: [{ scope: "group", label: "Over", category: "gear" }] }));
    await cross(`a trip's ${LINKS_LIVE_MAX + 1}st live link`, async () => { for (let i = 0; i < LINKS_LIVE_MAX; i++) if ((await host.post(`${C}/links`, { uses: 1 })).status >= 300) return false; return true; },
      () => host.post(`${C}/links`, { uses: 1 }));
    const maker = await person("Maker");
    await cross(`an account's ${TRIPS_HOSTED_MAX + 1}st trip`, async () => { for (let i = 0; i < TRIPS_HOSTED_MAX; i++) if ((await maker.post("/api/trips", { name: `Trip ${i}`, default_tz: "UTC" })).status >= 300) return false; return true; },
      () => maker.post("/api/trips", { name: "Over", default_tz: "UTC" }));
  }

  t.part("7. Sizes");
  {
    const one = async (what, send, statuses = [413]) => { const before = db.snap(); const files = bucketFiles(server); const r = await send(); t.ok(`${what}: refused in words, nothing written or stored`, refusedAsSaid(r, statuses) && db.diff(before, db.snap()).length === 0 && bucketFiles(server) === files, show(r)); };
    await one(`a picture past ${PICTURE_LIMITS.picture.bytes / 1024} KB`, () => host.call("PUT", `${T}/pictures/place/p-1?license=own`, Buffer.alloc(PICTURE_LIMITS.picture.bytes + 1, 1), { headers: { "Content-Type": "application/octet-stream" } }));
    await one("a board's picture past 12 MB", () => host.call("POST", `${T}/collage/share?mime=image/jpeg&w=10&h=10&title=Big`, Buffer.alloc(12 * 1024 * 1024 + 1, 3), { headers: { "Content-Type": "image/jpeg" } }));
    await one("a file declared past 8 GiB", () => host.post(`${T}/media/begin`, { name: "huge.mp4", mime: "video/mp4", bytes: 8 * 1024 ** 3 + 1, kind: "video" }));
    await host.post(`${T}/assistant/conversations`, { id: "c-size" });
    await one("an ask past 2,000 characters", () => host.post(`${T}/assistant/conversations/c-size/ask`, { id: "q-size", words: "x".repeat(2001) }));
    await one("a document past 10 MB, refused before anything is read", () => host.call("POST", `${T}/assistant/conversations/c-size/files`, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61), { headers: { "Content-Type": "text/plain", "X-File-Name": "big.txt" } }));
  }

  t.part(`8. Every path that stores bytes, with the host's room all but used (${FREE_STORAGE_BYTES / 1024 ** 3} GiB)`);
  {
    // A board to add a video and an item to, made while there's room; then the room all but used.
    const board = (await host.call("POST", `${T}/collage/share?mime=image/jpeg&w=10&h=10&title=Room`, Buffer.alloc(2048, 3), { headers: { "Content-Type": "image/jpeg" } })).json;
    const boardId = board.id ?? board.share?.id;
    const link = (await host.post(`${T}/pictures/place/p-1/upload-link`, { license: "own" })).json;
    const begun = (await host.post(`${T}/media/begin`, { name: "small.jpg", mime: "image/jpeg", bytes: 1024, kind: "photo" })).json;
    const part = await host.call("PUT", `${T}/media/part?key=${encodeURIComponent(begun.key)}&id=${encodeURIComponent(begun.uploadId)}&n=1`, Buffer.alloc(1024, 5), { headers: { "Content-Type": "application/octet-stream" } });
    await host.post(`${T}/media/finish`, { key: begun.key, id: begun.uploadId, parts: [{ n: 1, etag: part.json?.etag }] });
    const used = server.sql(`SELECT COALESCE(SUM(bytes), 0) AS b FROM media_objects`)[0].b + server.sql("SELECT COALESCE(SUM(COALESCE(bytes, 0) + COALESCE(video_bytes, 0)), 0) AS b FROM collage_shares")[0].b;
    server.sql(`INSERT INTO media_objects (r2_key, upload_id, user_id, trip_id, role, kind, mime, orig_name, bytes, sha256, state, thumb_for, created_at, stored_at)
      VALUES ('o/zz/planted/room.bin', '', '${host.user.id}', '${trip}', 'original', 'video', 'video/mp4', 'room.bin', ${FREE_STORAGE_BYTES - used - 10}, '', 'stored', '', 1, 1)`);
    const paths = {
      "a memory's photo or video, or a map uploaded (media/begin reserves the whole file)": () => host.post(`${T}/media/begin`, { name: "over.jpg", mime: "image/jpeg", bytes: 2048, kind: "photo" }),
      "a file's thumbnail (media/thumb)": () => host.call("POST", `${T}/media/thumb?for=${encodeURIComponent(begun.key)}&mime=image/jpeg`, jpegOfSize(2048, 7), { headers: { "Content-Type": "image/jpeg" } }),
      "the trip's cover": () => host.call("PUT", `${T}/pictures/cover?license=own`, png(80, 60), { headers: { "Content-Type": "application/octet-stream" } }),
      "a place's, a plan's or a receipt's picture": () => host.call("PUT", `${T}/pictures/place/p-1?license=own`, png(80, 60), { headers: { "Content-Type": "application/octet-stream" } }),
      "a picture sent to an upload link (refused, the link is used up, as its guide says; nothing else written)": () => fetch(link.url, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: png(80, 60) })
        .then(async (res) => ({ status: res.status, json: await res.json().catch(() => null), headers: [...res.headers] })),
      "a picture fetched by address (room for the most a picture may be, before fetching)": () => host.post(`${T}/pictures/place/p-1/from-url`, { url: "https://picture.invalid/x.png", license: "own" }),
      "a board's picture": () => host.call("POST", `${T}/collage/share?mime=image/jpeg&w=10&h=10&title=Over`, Buffer.alloc(2048, 3), { headers: { "Content-Type": "image/jpeg" } }),
      "a board's video": () => host.call("POST", `${T}/collage/share/${boardId}/video?mime=video/mp4`, Buffer.alloc(2048, 4), { headers: { "Content-Type": "video/mp4" } }),
      "a board's photo or video item": () => host.call("POST", `${T}/collage/share/${boardId}/item?idx=0&kind=photo&mime=image/jpeg&w=10&h=10`, jpegOfSize(2048, 4), { headers: { "Content-Type": "image/jpeg" } }),
    };
    const listed = BYTE_PATHS.map(([, what]) => what);
    t.same("every byte path in the rules is sent here", listed.filter((w) => !paths[w]), []);
    for (const [route, what] of BYTE_PATHS) {
      const before = db.snap();
      const files = bucketFiles(server);
      const r = await paths[what]();
      // An upload link's own row is the one thing a refusal may write: it's used up (its guide says so).
      const wrote = db.diff(before, db.snap()).filter((x) => !(route === "PUT /pictures/upload/:token" && x === "picture_links"));
      t.ok(`${what}: refused whole (413 "storage full", in words), nothing written, nothing in the bucket`,
        r.status === 413 && r.json?.error === "storage full" && /left of/.test(r.json?.reason ?? "") && wrote.length === 0 && bucketFiles(server) === files,
        `${show(r)} | wrote ${db.diff(before, db.snap()).join(", ")} | files ${files} → ${bucketFiles(server)}`);
    }
    server.sql("DELETE FROM media_objects WHERE r2_key = 'o/zz/planted/room.bin'");
  }

  t.part("9. What a stranger could flood, beyond the rows above");
  {
    // A join code within the tries a connection is allowed: how long to find one of a site's live codes.
    const live = LINKS_LIVE_MAX * 1000, triesAYear = 60 * 60 * 24 * 365;
    const years = 2 ** 128 / live / triesAYear;
    t.ok(`a join code (128 bits) guessed at 60 tries a minute from one connection, with ${live.toLocaleString("en-US")} live codes on the site: ~10^${Math.floor(Math.log10(years))} years for a million connections`,
      years / 1e6 > 1e15, String(years));
    const app = await connect(o, host, { name: "Flood App", address: host.address });
    const mcp = new McpClient(o, app.tokens.json.access_token);
    await mcp.initialize();
    // In one clock minute, as crossBy's bursts (the counts are per clock minute): 300 calls take longer, so 40 s of room.
    let r429 = null, took = 0;
    for (let attempt = 0; attempt < 2 && !r429; attempt++) {
      await roomInMinute(attempt ? MINUTE : 40_000);
      const minute = minuteNow(), t0 = Date.now();
      for (let i = 0; i < 305 && !r429; i++) {
      const res = await fetch(`${o}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${app.tokens.json.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/list" }) });
      if (res.status === 429) r429 = { status: 429, json: await res.json().catch(() => null), headers: [...res.headers] };
      }
      took = Date.now() - t0;
      if (!r429 && minuteNow() !== minute && attempt === 0) console.log(`    (a minute turned over mid-burst, unrefused, after ${(took / 1000).toFixed(1)} s: sent again from a new minute's start)`);
      else if (!r429) break;
    }
    t.ok(`an app's 301st MCP call in a minute: refused in words, with when (the burst took ${(took / 1000).toFixed(1)} s)`, !!r429 && refusedAsSaid(r429, [429]), r429 ? show(r429) : "never refused");
  }

  t.part("10. The map: 10 plans a trip a minute (on a site with a map maker)");
  {
    maps = await startServer({ name: "limits-maps", port: port + 1, maps: true, vars: { WORLD_URL: "http://127.0.0.1:9/world.pmtiles" } });
    await maps.start();
    const mdb = dbOf(maps);
    const m = new Person(maps.origin, "Mapper");
    await m.signUp();
    const mt = (await m.post("/api/trips", { name: "Map", default_tz: "UTC" })).json.trip.id;
    const body = { areas: [{ name: "Lima", west: -77.2, south: -12.2, east: -76.9, north: -11.9 }] };
    // In one clock minute, as crossBy's bursts: a plan reads the world build, so 40 s of room, and once more if it turned.
    let last = null, took = 0;
    for (let attempt = 0; attempt < 2 && last?.status !== 429; attempt++) {
      await roomInMinute(attempt ? MINUTE : 40_000);
      const minute = minuteNow(), t0 = Date.now();
      last = null;
      for (let i = 0; i < 12 && last?.status !== 429; i++) { const b = mdb.snap(); last = await m.post(`/api/trips/${mt}/tiles/plan`, body); last.wrote = last.status === 429 ? mdb.diff(b, mdb.snap()) : []; }
      took = Date.now() - t0;
      if (last?.status !== 429 && minuteNow() !== minute && attempt === 0) console.log(`    (a minute turned over mid-burst, unrefused, after ${(took / 1000).toFixed(1)} s: sent again from a new minute's start)`);
      else if (last?.status !== 429) break;
    }
    t.ok(`a trip's 11th map planned in a minute: refused in words, with when, nothing written (the burst took ${(took / 1000).toFixed(1)} s)`, refusedAsSaid(last, [429]) && last.wrote.length === 0, show(last));
  }

  t.part("11. The caps on how many: phones, boards, conversations, purchases, exports");
  {
    // Phones: the 21st replaces the one least recently seen, and is never refused.
    const phoneKeys = async () => {
      const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
      return { p256dh: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url"), auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url") };
    };
    const ph = await person("Phones");
    const ep = (i) => `https://fcm.googleapis.com/fcm/send/sweep-${i}`;
    for (let i = 0; i < PUSH_PHONES_MAX; i++) await ph.call("PUT", "/api/account/push", { endpoint: ep(i), keys: await phoneKeys() });
    // Seen in order (one a minute apart), phone 0 the longest ago.
    server.sql(`UPDATE push_subscriptions SET seen_at = 1000 + 60 * CAST(substr(endpoint, ${"https://fcm.googleapis.com/fcm/send/sweep-".length + 1}) AS INTEGER) WHERE user_id = '${ph.user.id}'`);
    const added = await ph.call("PUT", "/api/account/push", { endpoint: ep(PUSH_PHONES_MAX), keys: await phoneKeys() });
    const held = server.sql(`SELECT endpoint FROM push_subscriptions WHERE user_id = '${ph.user.id}' ORDER BY endpoint`).map((x) => x.endpoint);
    t.ok(`a ${PUSH_PHONES_MAX + 1}st phone: kept, and the one least recently seen let go (${PUSH_PHONES_MAX} kept, never refused)`,
      added.status === 200 && held.length === PUSH_PHONES_MAX && !held.includes(ep(0)) && held.includes(ep(PUSH_PHONES_MAX)), `${added.status} ${held.length} ${held.includes(ep(0))}`);
    // Boards: 50 shared at once.
    const bt = (await host.post("/api/trips", { name: "Boards", default_tz: "UTC" })).json.trip.id;
    for (let i = 0; i < BOARDS_PER_TRIP_MAX; i++) await host.call("POST", `/api/trips/${bt}/collage/share?mime=image/jpeg&w=10&h=10&title=B${i}`, Buffer.alloc(1024, 3), { headers: { "Content-Type": "image/jpeg" } });
    {
      const before = db.snap(); const files = bucketFiles(server);
      const r = await host.call("POST", `/api/trips/${bt}/collage/share?mime=image/jpeg&w=10&h=10&title=Over`, Buffer.alloc(1024, 3), { headers: { "Content-Type": "image/jpeg" } });
      t.ok(`a trip's ${BOARDS_PER_TRIP_MAX + 1}st board shared at once: refused in words, nothing written or stored`, refusedAsSaid(r, [409]) && db.diff(before, db.snap()).length === 0 && bucketFiles(server) === files, show(r));
    }
    // Conversations: 200 a person a trip; the 201st refused, the same id again still its own.
    const C = `/api/trips/${trip}/assistant/conversations`;
    for (let i = 0; i < CONVERSATIONS_PER_PERSON_MAX; i++) await host.post(C, { id: `cv-${i}` });
    {
      const before = db.snap();
      const r = await host.post(C, { id: "cv-over" });
      const again = await host.post(C, { id: "cv-0" });
      t.ok(`a person's ${CONVERSATIONS_PER_PERSON_MAX + 1}st conversation on a trip: refused in words (delete an old one), nothing written; one made before, asked again, is still answered`,
        refusedAsSaid(r, [409]) && /[Dd]elete an old one/.test(r.json?.reason ?? "") && db.diff(before, db.snap()).length === 0 && again.status === 200, `${show(r)} | again ${again.status}`);
    }
    // Purchases: 5,000 a trip (planted), the next refused; one sent again is no new one.
    const pt = (await host.post("/api/trips", { name: "Purchases", default_tz: "UTC" })).json.trip.id;
    server.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${PURCHASES_PER_TRIP_MAX})
      INSERT INTO purchases (id, trip_id, description, amount_minor, currency, paid_by, spent_at, created_by, created_at, updated_at, rev)
      SELECT 'pu-plant-' || i, '${pt}', 'Planted', 100, 'USD', '${host.user.id}', 1, '${host.user.id}', 1, 1, 1 FROM n`);
    // As the route would have left it: each purchase it adds takes the trip a rev further (src/api/purchases.js counts
    // only once the rev says the trip could be at the cap).
    server.sql(`UPDATE trips SET rev = rev + ${PURCHASES_PER_TRIP_MAX} WHERE id = '${pt}'`);
    {
      const body = (id) => ({ id, description: "One more", amount_minor: 100, currency: "USD", paid_by: host.user.id, spent_at: Math.floor(Date.now() / 1000), split_mode: "weight", shares: [{ user_id: host.user.id, weight: 1, share_minor: 100 }] });
      const before = db.snap();
      const r = await host.post(`/api/trips/${pt}/purchases`, body("pu-over"));
      t.ok(`a trip's ${(PURCHASES_PER_TRIP_MAX + 1).toLocaleString("en-US")}st purchase: refused in words, nothing written`, refusedAsSaid(r, [409]) && db.diff(before, db.snap()).length === 0, show(r));
    }
    // The export: 6 an hour an account.
    const ex = await person("Exports");
    for (let i = 0; i < EXPORTS_PER_HOUR; i++) await ex.get("/api/account/export");
    {
      const before = db.snap();
      const r = await ex.get("/api/account/export");
      t.ok(`an account's ${EXPORTS_PER_HOUR + 1}th export in an hour: refused in words, with when, nothing written`, refusedAsSaid(r, [429]) && db.diff(before, db.snap()).length === 0, show(r));
    }
  }

  t.part("12. Guests: made by joining with only a name, and the host's links that sign one in again");
  {
    const day0 = Math.floor(Date.now() / 1000);
    // An address: GUESTS_PER_ADDRESS_HOUR guests an hour, by any links (the trip has room for them all).
    const ga = (await host.post("/api/trips", { name: "Guests by address", default_tz: "UTC" })).json.trip.id;
    const codeA = (await host.post(`/api/trips/${ga}/links`, { uses: 50 })).json.link.code;
    const lodging = "10.250.0.1";
    for (let i = 0; i < GUESTS_PER_ADDRESS_HOUR; i++) {
      const r = await new Person(o, "x", lodging).post(`/api/join/${codeA}`, { name: `Guest ${i}` });
      if (r.status !== 200) throw new CheckError(`guest ${i} from one address: ${r.status} ${r.text.slice(0, 120)}`);
    }
    {
      const before = db.snap();
      const r = await new Person(o, "x", lodging).post(`/api/join/${codeA}`, { name: "One too many" });
      t.ok(`the ${GUESTS_PER_ADDRESS_HOUR + 1}st guest from one address in an hour: refused in words, with when, nothing written, no session`,
        refusedAsSaid(r, [429]) && db.diff(before, db.snap()).length === 0 && !r.cookies.some((c) => c.startsWith("wgp_session=")), show(r));
      const signedIn = await person("Already Has An Account");
      signedIn.address = lodging;
      const joined = await signedIn.post(`/api/join/${codeA}`);
      t.ok("  while someone with an account joins from the same address (only guests are counted)", joined.status === 200 && joined.json?.joined === true, show(joined));
    }
    // A link: GUESTS_PER_LINK_HOUR guests an hour. A trip holds TRIP_MEMBERS_MAX, so two leave on the way.
    const gl = (await host.post("/api/trips", { name: "Guests by link", default_tz: "UTC" })).json.trip.id;
    const codeL = (await host.post(`/api/trips/${gl}/links`, { uses: 50 })).json.link.code;
    const made = [];
    for (let i = 0; i < TRIP_MEMBERS_MAX - 1; i++) {
      const g = new Person(o, "x", `10.251.${Math.floor(i / 200)}.${(i % 200) + 1}`);
      const r = await g.post(`/api/join/${codeL}`, { name: `Linked ${i}` });
      if (r.status !== 200) throw new CheckError(`guest ${i} by one link: ${r.status} ${r.text.slice(0, 120)}`);
      made.push(g);
    }
    for (const g of made.slice(0, 2)) await host.call("DELETE", `/api/trips/${gl}/members/${(await g.me()).id}`);
    for (let i = TRIP_MEMBERS_MAX - 1; i < GUESTS_PER_LINK_HOUR; i++) {
      const r = await new Person(o, "x", `10.252.0.${i + 1}`).post(`/api/join/${codeL}`, { name: `Linked ${i}` });
      if (r.status !== 200) throw new CheckError(`guest ${i} by one link: ${r.status} ${r.text.slice(0, 120)}`);
    }
    {
      const before = db.snap();
      const r = await new Person(o, "x", "10.253.0.1").post(`/api/join/${codeL}`, { name: "One too many" });
      t.ok(`the ${GUESTS_PER_LINK_HOUR + 1}st guest by one link in an hour (the trip has room): refused in words, with when, nothing written`,
        refusedAsSaid(r, [429]) && db.diff(before, db.snap()).length === 0, show(r));
    }
    // A host's rejoin links: REJOIN_LINKS_PER_HOUR an hour.
    const gr = (await host.post("/api/trips", { name: "Rejoins", default_tz: "UTC" })).json.trip.id;
    const codeR = (await host.post(`/api/trips/${gr}/links`, { uses: 5 })).json.link.code;
    const guest = new Person(o, "x", "10.254.0.1");
    await guest.post(`/api/join/${codeR}`, { name: "Lost Phone" });
    const gid = (await guest.me()).id;
    for (let i = 0; i < REJOIN_LINKS_PER_HOUR; i++) {
      const r = await host.post(`/api/trips/${gr}/members/${gid}/rejoin`);
      if (r.status !== 201) throw new CheckError(`rejoin link ${i}: ${r.status} ${r.text.slice(0, 120)}`);
    }
    {
      const before = db.snap();
      const r = await host.post(`/api/trips/${gr}/members/${gid}/rejoin`);
      t.ok(`a host's ${REJOIN_LINKS_PER_HOUR + 1}th link to sign a guest in again in an hour: refused in words, with when, nothing written`,
        refusedAsSaid(r, [429]) && db.diff(before, db.snap()).length === 0, show(r));
    }
    t.ok("the hour's counts are all made in this run (nothing from before it)", server.sql(`SELECT COUNT(*) AS n FROM hour_counts WHERE at < ${day0 - 5}`)[0].n === 0);
  }

  console.log(`\nThe limits as written (${Object.keys(LIMITS).length + Object.keys(READS).length} rows): node checks/limits/sweep.mjs --table`);
  const failed = server.log().split("\n").filter((l) => /Uncaught|✘|\[ERROR\]/.test(l));
  t.ok("nothing failed inside the server", failed.length === 0, failed.slice(0, 3).join(" | "));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await server?.stop();
  await maps?.stop();
  await model?.close();
}
process.exit(code);

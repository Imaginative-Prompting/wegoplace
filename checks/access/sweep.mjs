// EVERY ROUTE, BY WHO CALLS IT. Reads the route table itself (src/routes.js ROUTES), so a new route can't be
// missed, and calls every row as six callers: signed out; signed in on no trip; the host of another trip; a
// member; the host; a guest on the trip (joined by its link with only a name). Each answer is held to the row's rule (checks/access/rules.mjs: a row without one fails),
// and every refused call to having written nothing: every table of the database read before and after. Every
// answer in JSON, to every caller, must say Cache-Control: no-store (or, on a row that keeps its own, say one).
//
//   node checks/access/sweep.mjs [--port <port>]
//
// Then the things a row's rule can't say alone:
//   - another trip's host, on their own trip's address, with this trip's ids (a plan, a place, a message, a
//     purchase, an item, a conversation, a link, a change, a memory): refused, and this trip's rows unchanged;
//     the same ids written on their own trip land there and nowhere else;
//   - another account's passkey and connected app: untouched by anyone else;
//   - the routes inside media/, memories/ and collage/ (rules.mjs SUBROUTES; media/ lists its own);
//   - a picture's upload link: anyone holding it, once, for 15 minutes;
//   - a share's page: anyone with its link while it's shared, nobody after;
//   - an app connected read-only: every write tool refused, nothing written.
// On a server of its own with the plan and the assistant on (a stand-in model). Everyone in it is made up.

import { CheckError, startServer, freePort } from "../lib/server.mjs";
import { dbOf } from "../lib/db-file.mjs";
import { Person, Report } from "../lib/person.mjs";
import { startModel } from "../lib/model-standin.mjs";
import { png } from "../lib/images.mjs";
import { connect, McpClient } from "../lib/mcp.mjs";
import { ROUTES } from "../../src/routes.js";
import { TOOLS } from "../../src/mcp/tools.js";
import { RULES, SUBROUTES, expected } from "./rules.mjs";

const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : await freePort());
const t = new Report("every route, by who calls it");
const KEY = "sk-or-check-not-real";
const CALLERS = ["out", "none", "other", "member", "host", "guest"];
const NO_TRIP = "There's no trip by that id that this account is on.";

let server, model, code = 1;
try {
  model = await startModel({ key: KEY });
  server = await startServer({
    name: "access-sweep", port,
    vars: { PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y", ASSISTANT_ENABLED: "true",
      ASSISTANT_MODEL: "check/model-1", ASSISTANT_PRICE_INPUT: "0.1", ASSISTANT_PRICE_OUTPUT: "0.5", OPENROUTER_API_BASE: model.base },
    secrets: { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", OPENROUTER_API_KEY: KEY },
  });
  await server.start();
  const { origin } = server;

  // ── the database, read whole, straight from its file (checks/lib/db-file.mjs) ──
  const { snap, diff } = dbOf(server);

  // ── the people and their things, made through the routes ──
  const people = { host: new Person(origin, "Ada Host"), member: new Person(origin, "Ben Member"), other: new Person(origin, "Cleo Other"), none: new Person(origin, "Dev None"), out: new Person(origin, "Eve Out"), guest: new Person(origin, "Fay Guest") };
  for (const who of ["host", "member", "other", "none"]) if ((await people[who].signUp()).status !== 200) throw new CheckError(`couldn't make ${who}`);
  const P = people;
  const must = (r, what) => { if (r.status >= 300) throw new CheckError(`${what}: ${r.status} ${r.text?.slice(0, 200)}`); return r; };
  const now = Math.floor(Date.now() / 1000);
  const fx = { t0: now + 86400, ids: Object.fromEntries(["host", "member", "other", "none"].map((w) => [w, P[w].user.id])) };
  const day = (d) => new Date((now + d * 86400) * 1000).toISOString().slice(0, 10);
  const dates = { default_tz: "UTC", starts_on: day(0), ends_on: day(6) };
  fx.day0 = day(1);
  fx.trip = must(await P.host.post("/api/trips", { name: "Sweep trip", ...dates }), "trip").json.trip.id;
  fx.tripB = must(await P.other.post("/api/trips", { name: "Another trip", ...dates }), "trip B").json.trip.id;
  must(await P.member.post(`/api/join/${must(await P.host.post(`/api/trips/${fx.trip}/links`, { uses: 1 }), "link").json.link.code}`), "join");
  // The guest: signed out, a name and the trip's link (model §22).
  const guestJoin = must(await P.guest.post(`/api/join/${must(await P.host.post(`/api/trips/${fx.trip}/links`, { uses: 1 }), "guest link").json.link.code}`, { name: "Fay Guest" }), "guest join");
  if (guestJoin.json?.guest !== true) throw new CheckError(`the guest's join: ${guestJoin.text.slice(0, 200)}`);
  fx.ids.guest = (await P.guest.me()).id;
  server.sql(`INSERT INTO billing_subscriptions (id, user_id, customer, status, interval, current_period_end, held, updated_at, synced_at)
    VALUES ('sub_sweep', '${fx.ids.host}', 'cus_sweep', 'active', 'month', ${now + 30 * 86400}, 0, ${now}, ${Date.now()})`);
  const T = `/api/trips/${fx.trip}`, TB = `/api/trips/${fx.tripB}`;
  Object.assign(fx, { area: "a-sw", place: "p-sw", event: "e-sw", list: "trek", memberItem: "pk-ben", purchase: "pu-ben", message: "m-ben", hostMessage: "m-ada", conversation: "c-ben", memory: "mem-ben" });
  for (const base of [T, TB]) {
    const as = base === T ? P.host : P.other;
    must(await as.call("PUT", `${base}/areas`, { areas: [{ id: fx.area, name: "Centro", sort: 1 }] }), "area");
    must(await as.call("PUT", `${base}/places`, { places: [{ id: fx.place, name: "Pier", kind: "sight", subkind: "viewpoint", why: "The view.", area: fx.area }] }), "place");
    must(await as.post(`${base}/events`, { id: fx.event, title: "Boat", starts_at: fx.t0, tz: "UTC" }), "event");
  }
  must(await P.host.call("PUT", `${T}/packing/lists`, { lists: [{ key: fx.list, name: "Trek", bags: [{ key: "pack", name: "Pack" }] }] }), "list");
  must(await P.member.post(`${T}/packing`, { id: fx.memberItem, label: "Ben's socks", category: "clothes", owner: fx.ids.member, bags: { [fx.list]: "pack" } }), "Ben's item");
  must(await P.member.post(`${T}/purchases`, { id: fx.purchase, description: "Ferry", amount_minor: 1200, currency: "USD", paid_by: fx.ids.member, spent_at: fx.t0, split_mode: "weight", shares: [{ user_id: fx.ids.member, weight: 1, share_minor: 600 }, { user_id: fx.ids.host, weight: 1, share_minor: 600 }] }), "purchase");
  must(await P.member.post(`${T}/messages`, { id: fx.message, body: "Ben's words" }), "Ben's message");
  must(await P.host.post(`${T}/messages`, { id: fx.hostMessage, body: "Ada's words" }), "Ada's message");
  fx.link = must(await P.host.post(`${T}/links`, { uses: 2 }), "link").json.link.id;
  must(await P.member.post(`${T}/assistant/conversations`, { id: fx.conversation }), "conversation");
  model.next({ words: "Ben's private answer" });
  must(await P.member.post(`${T}/assistant/conversations/${fx.conversation}/ask`, { id: "q-ben", words: "Ben's private question" }), "ask");
  fx.turn = server.sql(`SELECT id FROM ai_turns WHERE conversation_id = '${fx.conversation}' AND role = 'assistant'`)[0]?.id;
  // A document of the member's own on that conversation (src/assistant/files.js), for the file routes' rules.
  fx.file = must(await P.member.call("POST", `${T}/assistant/conversations/${fx.conversation}/files`, Buffer.from("Ben's packing note."), { headers: { "Content-Type": "text/plain", "X-File-Name": "note.txt" } }), "file").json.file.id;
  const photo = Buffer.alloc(6 * 1024, 9);
  const begun = must(await P.member.post(`${T}/media/begin`, { name: "sunset.jpg", mime: "image/jpeg", bytes: photo.length, kind: "photo" }), "media begin");
  const part = await P.member.call("PUT", `${T}/media/part?key=${encodeURIComponent(begun.json.key)}&id=${encodeURIComponent(begun.json.uploadId)}&n=1`, photo, { headers: { "Content-Type": "application/octet-stream" } });
  must(await P.member.post(`${T}/media/finish`, { key: begun.json.key, id: begun.json.uploadId, parts: [{ n: 1, etag: part.json?.etag }] }), "media finish");
  fx.mediaKey = begun.json.key;
  must(await P.member.post(`${T}/memories`, { id: fx.memory, caption: "Sunset", media: [{ key: fx.mediaKey, w: 10, h: 10 }] }), "memory");
  // A change in the list (only an app's or the assistant's writes are listed): the assistant adds a place.
  model.next({ tools: [{ name: "put_places", arguments: { summary: "A cafe", places: [{ id: "p-cafe", name: "Cafe", kind: "food", subkind: "cafe", why: "Coffee." }] } }] });
  model.next({ words: "Added." });
  must(await P.member.post(`${T}/assistant/conversations/${fx.conversation}/ask`, { id: "q-ben-2", words: "Add a cafe" }), "ask 2");
  fx.change = server.sql(`SELECT id FROM trip_changes WHERE trip_id = '${fx.trip}' ORDER BY rowid DESC LIMIT 1`)[0]?.id;
  // Uploads: one of Ben's left half-way; two of Ada's, one loose and one in her memory; boards.
  const upload = async (who, name) => {
    const b = must(await P[who].post(`${T}/media/begin`, { name, mime: "image/jpeg", bytes: photo.length, kind: "photo" }), `${name} begin`);
    const pt = await P[who].call("PUT", `${T}/media/part?key=${encodeURIComponent(b.json.key)}&id=${encodeURIComponent(b.json.uploadId)}&n=1`, photo, { headers: { "Content-Type": "application/octet-stream" } });
    must(await P[who].post(`${T}/media/finish`, { key: b.json.key, id: b.json.uploadId, parts: [{ n: 1, etag: pt.json?.etag }] }), `${name} finish`);
    return b.json.key;
  };
  const half = must(await P.member.post(`${T}/media/begin`, { name: "half.jpg", mime: "image/jpeg", bytes: photo.length, kind: "photo" }), "half begin").json;
  fx.pending = { key: half.key, id: half.uploadId };
  fx.hostLoose = await upload("host", "loose.jpg");
  fx.hostMemory = "mem-ada";
  must(await P.host.post(`${T}/memories`, { id: fx.hostMemory, caption: "Ada's", media: [{ key: await upload("host", "ada.jpg"), w: 10, h: 10 }] }), "Ada's memory");
  const board = async (who) => must(await P[who].call("POST", `${T}/collage/share?mime=image/jpeg&w=10&h=10&title=Board`, Buffer.alloc(2048, 3), { headers: { "Content-Type": "image/jpeg" } }), "board").json;
  const boardId = (b) => b.id ?? b.share?.id;
  fx.hostBoard = boardId(await board("host"));
  fx.goneShare = boardId(await board("member"));
  must(await P.member.call("DELETE", `${T}/collage/share/${fx.goneShare}`), "revoke");
  fx.passkeyOf = { host: server.sql(`SELECT id FROM passkeys WHERE user_id = '${fx.ids.host}'`)[0].id };
  const hostApp = await connect(origin, P.host, { name: "Ada's App", address: P.host.address });
  if (hostApp.tokens?.status !== 200) throw new CheckError("couldn't connect Ada's app");
  fx.grantOf = { host: (await P.host.get("/api/account/apps")).json.apps[0].id };
  t.ok("(the trips, people and things the sweep stands on, made through the routes)", fx.turn && fx.change && fx.mediaKey && fx.grantOf.host && fx.hostBoard && fx.goneShare, JSON.stringify(fx));

  // ── what a caller got, against what the rule says ──
  const fill = (pattern, params) => pattern.replace(/:([a-z]+)\*?/g, (_, k) => (k in params ? String(params[k]) : "x-sweep"));
  const answerOf = (r) => `${r.status}${r.json?.error ? ` ${r.json.error}` : ""}`;
  const meets = (want, r) => {
    if (want === "in") return r.status !== 401 && !(r.status === 404 && r.json?.reason === NO_TRIP) && !(r.status === 403);
    if (want === "2xx") return r.status >= 200 && r.status < 300;
    if (want === "no trip") return r.status === 404 && r.json?.error === "no such trip" && r.json?.reason === NO_TRIP;
    if (want === 403) return r.status === 403 && typeof r.json?.reason === "string" && r.json.reason.length > 10;
    if (want === "403 page") return r.status === 403 && /passkey/.test(r.text ?? "");
    if (want === 401) return r.status === 401;
    return r.status === want;
  };
  const refusal = (want) => want === 401 || want === 403 || want === "403 page" || want === "no trip" || (typeof want === "number" && want >= 400);
  // An answer in JSON says no-store, or, on a row that keeps its own (rule.cache), some Cache-Control.
  const held = { answers: 0, rows: new Set() };
  const header = (r, name) => (r.headers ?? []).find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
  const uncached = (rule, key, who, r) => {
    if (!/application\/json/.test(header(r, "content-type") ?? "")) return null;
    held.answers += 1;
    held.rows.add(key);
    const cc = header(r, "cache-control");
    if (rule.cache ? cc : /(^|,)\s*no-store\s*(,|$)/.test(cc ?? "")) return null;
    return `${who}: ${r.status} in JSON with Cache-Control ${cc === null ? "none" : `"${cc}"`}, not no-store`;
  };
  const callAs = (who, method, address, body, page) => P[who].call(method, address, body ?? (["GET", "DELETE", "HEAD"].includes(method) ? null : undefined), { page: !!page });

  t.part("1. The table and the rules");
  const keys = ROUTES.map(([m, p]) => `${m} ${p}`);
  const unruled = keys.filter((k) => !RULES[k]);
  t.ok("every row of the route table has a rule written for it", unruled.length === 0, `no rule: ${unruled.join(", ")}`);
  const stale = Object.keys(RULES).filter((k) => !keys.includes(k));
  t.ok("every rule is for a row that's there", stale.length === 0, `no such row: ${stale.join(", ")}`);

  async function sweepRow(key) {
    const rule = RULES[key];
    if (!rule) return;
    const [method0, pattern] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)];
    const method = method0 === "*" ? "GET" : method0;
    const got = {};
    const wrote = [];
    // Refused callers first, each between two readings of every table.
    const order = [...CALLERS].sort((a, b) => Number(!refusal(expected(rule, a))) - Number(!refusal(expected(rule, b))));
    for (const who of order) {
      const want = expected(rule, who);
      const address = fill(pattern.replace(":trip", fx.trip), rule.params?.(fx, who) ?? {});
      const body = rule.body?.(fx, who);
      const before = refusal(want) ? snap() : null;
      const r = await callAs(who, method, address, body, rule.page);
      if (before) { const changed = diff(before, snap()); if (changed.length) wrote.push(`${who}: ${changed.join(", ")}`); }
      got[who] = r;
    }
    const wrong = [];
    if (rule.who === "anyone" && CALLERS.every((w) => expected(rule, w) === "same")) {
      const answers = new Set(CALLERS.map((w) => answerOf(got[w])));
      if (answers.size !== 1) wrong.push(`not the same for all: ${CALLERS.map((w) => `${w} ${answerOf(got[w])}`).join(", ")}`);
    } else {
      for (const who of CALLERS) {
        const want = expected(rule, who);
        if (want !== "same" && !meets(want, got[who])) wrong.push(`${who}: ${answerOf(got[who])}, the rule says ${want}`);
      }
    }
    for (const who of rule.ok ?? []) if (!meets("2xx", got[who])) wrong.push(`${who} not done: ${answerOf(got[who])} ${got[who].json?.reason ?? ""}`);
    for (const who of CALLERS) { const kept = uncached(rule, key, who, got[who]); if (kept) wrong.push(kept); }
    t.ok(`${key}: ${rule.rule}`, wrong.length === 0 && wrote.length === 0, [...wrong, ...wrote.map((w) => `a refused call wrote: ${w}`)].join(" | "));
  }

  t.part("2. Another trip's host, with this trip's ids, on their own trip's address");
  {
    const before = snap(fx.tripB);
    const tries = [
      ["PATCH", `${TB}/events/${fx.event}x`, { detail: "x" }], ["PATCH", `${TB}/messages/${fx.message}`, { body: "x" }], ["DELETE", `${TB}/messages/${fx.message}`],
      ["PATCH", `${TB}/packing/${fx.memberItem}`, { label: "x" }], ["DELETE", `${TB}/packing/${fx.memberItem}`], ["PATCH", `${TB}/purchases/${fx.purchase}`, { note: "x" }],
      ["DELETE", `${TB}/purchases/${fx.purchase}`], ["GET", `${TB}/assistant/conversations/${fx.conversation}`], ["DELETE", `${TB}/assistant/conversations/${fx.conversation}`],
      ["POST", `${TB}/assistant/conversations/${fx.conversation}/share`, { id: "sw-x", turn: fx.turn }], ["DELETE", `${TB}/links/${fx.link}`],
      ["POST", `${TB}/changes/${fx.change}/undo`, {}], ["GET", `${TB}/memories/${fx.memory}`], ["DELETE", `${TB}/memories/${fx.memory}`],
      ["POST", `${TB}/memories`, { id: "mem-x", caption: "x", media: [{ key: fx.mediaKey, w: 10, h: 10 }] }],
      ["POST", `${TB}/messages`, { id: "m-x", body: "x", reply_to: fx.message }], ["PUT", `${TB}/pictures/cover`, { key: fx.mediaKey, license: "own" }],
      ["POST", `${TB}/tiles/use`, { key: fx.mediaKey }], ["GET", `/media/${fx.mediaKey}`],
    ];
    const read = [];
    for (const [m, a, b] of tries) { const r = await P.other.call(m, a, b ?? null); if (m === "GET" && r.status < 400) read.push(`${m} ${a.replace(TB, "…")}: ${r.status}`); }
    t.ok("no read by this trip's id answers (a conversation, a memory, a file)", read.length === 0, read.join(" | "));
    const theirs = await P.other.get(`${TB}/messages`);
    t.ok("  her own trip's chat, with a reply naming this trip's message, shows nothing of it", theirs.status === 200 && !theirs.text.includes("Ben's words"), theirs.text.slice(0, 300));
    const touched = diff(before, snap(fx.tripB));
    t.ok("  and nothing of this trip's touched by its ids (deletes, edits, an undo, a share, a cover, a map)", touched.length === 0, touched.join(", "));
    // The same ids written on the other trip land there, and this trip's rows with those ids stay as they were.
    await P.other.call("PUT", `${TB}/places`, { places: [{ id: fx.place, name: "Cleo's pier", kind: "sight", subkind: "viewpoint", why: "Hers." }] });
    await P.other.call("PATCH", `${TB}/events/${fx.event}`, { title: "Cleo's boat" });
    await P.other.call("DELETE", `${TB}/places/${fx.place}`);
    // Items, purchases and memories have ids unique across the site: the same id from another trip must be
    // refused there, never written over this trip's.
    const sameIds = [
      await P.other.post(`${TB}/packing`, { id: fx.memberItem, label: "Cleo's", category: "gear", owner: "group" }),
      await P.other.call("PUT", `${TB}/packing/items`, { items: [{ id: fx.memberItem, label: "Cleo's", category: "gear", list: "group" }] }),
      await P.other.post(`${TB}/purchases`, { id: fx.purchase, description: "Cleo's", amount_minor: 100, currency: "USD", paid_by: fx.ids.other, spent_at: fx.t0, split_mode: "weight", shares: [{ user_id: fx.ids.other, weight: 1, share_minor: 100 }] }),
      await P.other.post(`${TB}/memories`, { id: fx.memory, caption: "Cleo's", media: [] }),
    ];
    const changed = diff(before, snap(fx.tripB));
    t.ok("  and this trip's rows unchanged, when the same ids are written and deleted on the other trip (a place, a plan; an item, a purchase, a memory, whose ids are the site's)",
      changed.length === 0 && sameIds.every((r) => r.status >= 400), `${changed.join(", ")} ${sameIds.map((r) => r.status).join(" ")}`);
  }

  t.part("3. Another account's passkey and app");
  {
    const before = snap();
    for (const who of ["none", "other", "member"]) {
      await P[who].call("DELETE", `/api/auth/ways/passkey/${encodeURIComponent(fx.passkeyOf.host)}`);
      await P[who].call("DELETE", `/api/account/apps/${encodeURIComponent(fx.grantOf.host)}`);
    }
    t.ok("Ada's passkey: still hers after three others tried to remove it", diff(before, snap()).length === 0, diff(before, snap()).join(", "));
    t.same("Ada's connected app: still connected after three others tried to disconnect it", (await P.host.get("/api/account/apps")).json.apps.map((a) => a.id), [fx.grantOf.host]);
  }

  t.part("4. Every row, as each of six callers");
  const later = keys.filter((k) => RULES[k]?.last);
  const ends = ["DELETE /api/trips/:trip", "DELETE /api/me", "POST /api/auth/logout/all", "POST /api/auth/logout"];
  for (const key of keys.filter((k) => !later.includes(k))) await sweepRow(key);

  t.part("5. A picture's upload link: whoever holds it, once, for 15 minutes");
  {
    const made = must(await P.member.post(`${T}/pictures/place/${fx.place}/upload-link`, { license: "own" }), "upload link").json;
    const token = String(made.url ?? made.link ?? "").split("/").pop();
    const put = (tok) => fetch(`${origin}/pictures/upload/${tok}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: png(40, 30) });
    const first = await put(token), second = await put(token);
    const late = must(await P.member.post(`${T}/pictures/place/${fx.place}/upload-link`, { license: "own" }), "upload link 2").json;
    const lateToken = String(late.url ?? late.link ?? "").split("/").pop();
    server.sql(`UPDATE picture_links SET expires_at = ${now - 1} WHERE used_at IS NULL`);
    const before = snap();
    const expired = await put(lateToken);
    t.same("signed out with the link: the picture is set; the same link again: refused; a link past its 15 minutes: refused, nothing written",
      [first.status, second.status >= 400, expired.status >= 400, diff(before, snap())], [200, true, true, []]);
  }

  t.part("6. A share's page: anyone with its link while it's shared");
  {
    const share = must(await P.member.call("POST", `${T}/collage/share?mime=image/jpeg&w=10&h=10&title=Sweep`, Buffer.alloc(2048, 3), { headers: { "Content-Type": "image/jpeg" } }), "share").json;
    const sid = share.id ?? share.share?.id;
    const open = await fetch(`${origin}/s/${sid}`, { headers: { Accept: "text/html" } });
    must(await P.member.call("DELETE", `${T}/collage/share/${sid}`), "revoke");
    const after = await fetch(`${origin}/s/${sid}`, { headers: { Accept: "text/html" } });
    t.same("signed out with the link: the page; once revoked: no page", [open.status, after.status], [200, 404]);
    t.same("  the page may be shown inside another site's (it's public, with nothing to press): no X-Frame-Options, no frame-ancestors",
      [open.headers.get("x-frame-options"), open.headers.get("content-security-policy")], [null, null]);
  }

  t.part("7. The routes inside media/, memories/ and collage/");
  {
    const listed = (await P.member.get(`${T}/media/x`)).json?.routes ?? [];
    const ours = SUBROUTES.filter((s) => s.under === "media").map((s) => s.action);
    const tableKeys = (await import("node:fs")).readFileSync(new URL("../../src/api/media.js", import.meta.url), "utf8").match(/"([a-z]+):(GET|POST|PUT|DELETE|PATCH)": /g).map((k) => k.slice(1, -3).split(":").reverse().join(" "));
    const ruled = SUBROUTES.filter((s) => s.under === "media").map((s) => `${s.method} ${s.action}`);
    t.same("  and every method of each (read from media.js's own table)", tableKeys.filter((k) => !ruled.includes(k)), []);
    t.same("media/ lists its own routes, and every one has a rule here", [...new Set(listed)].sort(), [...new Set(ours)].sort());
    for (const s of SUBROUTES) {
      const got = {};
      const wrote = [];
      for (const who of [...CALLERS].sort((a, b) => Number(!refusal(expected(s, a))) - Number(!refusal(expected(s, b))))) {
        const want = expected(s, who);
        const before = refusal(want) ? snap() : null;
        got[who] = await callAs(who, s.method, `${T}/${s.under}/${s.path(fx, who)}`, s.body?.(fx, who), false);
        if (before) { const c = diff(before, snap()); if (c.length) wrote.push(`${who}: ${c.join(", ")}`); }
      }
      const wrong = CALLERS.filter((w) => !meets(expected(s, w), got[w])).map((w) => `${w}: ${answerOf(got[w])}, the rule says ${expected(s, w)}`);
      for (const w of CALLERS) { const kept = uncached(s, `${s.method} ${s.under}/${s.action}`, w, got[w]); if (kept) wrong.push(kept); }
      t.ok(`${s.method} …/${s.under}/${s.action}: ${s.rule}`, !wrong.length && !wrote.length, [...wrong, ...wrote].join(" | "));
    }
  }

  t.part("8. An app connected read-only");
  {
    const c = await connect(origin, P.member, { name: "Reader", scope: "trips:read", address: P.member.address });
    const mcp = new McpClient(origin, c.tokens.json.access_token);
    await mcp.initialize();
    const writes = TOOLS.filter((x) => !x.read && !x.name.startsWith("get_") && !x.name.startsWith("list_") && x.name !== "open_in_app").map((x) => x.name);
    const before = snap();
    const done = [];
    for (const name of writes) {
      const r = await mcp.call(name, { trip_id: fx.trip, summary: "Read-only try", events: [{ id: "e-ro", title: "x", kind: "plan", starts: "2027-06-01T10:00", tz: "UTC" }], places: [{ id: "p-ro", name: "x", kind: "sight", subkind: "viewpoint", why: "x" }], ids: [fx.event], items: [{ list: "group", label: "x", category: "gear" }], name: "x", default_tz: "UTC" });
      if (!r.isError) done.push(name);
    }
    t.ok(`every write tool (${writes.length}) refused`, done.length === 0 && writes.length >= 15, done.join(", "));
    t.ok("  and nothing written", diff(before, snap()).length === 0, diff(before, snap()).join(", "));
    const bearer = await fetch(`${origin}${T}`, { headers: { Authorization: `Bearer ${c.tokens.json.access_token}` } });
    t.same("its token reads nothing of the API outside /mcp", bearer.status, 401);
  }

  t.part("9. Another site can't show the app's pages inside its own");
  {
    // Clickjacking: /account or a trip, framed out of sight under a click meant for something else.
    const pages = ["/", "/trips", "/account", "/login", `/trips/${fx.trip}`, `/t/${fx.trip}/`, "/join/sweep-nosuch", "/privacy"];
    const open = [];
    for (const p of pages) {
      const r = await P.host.call("GET", p, null, { page: true });
      const xfo = header(r, "x-frame-options"), csp = header(r, "content-security-policy") ?? "";
      if (r.status !== 200 || xfo !== "DENY" || !/(^|;)\s*frame-ancestors 'none'\s*(;|$)/.test(csp)) open.push(`${p}: ${r.status}, X-Frame-Options ${xfo}, CSP "${csp}"`);
    }
    t.ok(`each of ${pages.length} pages says X-Frame-Options: DENY and frame-ancestors 'none'`, open.length === 0, open.join(" | "));
    // A "not found" in plain text is never read as anything else.
    const notFound = ["/media/sweep-nosuch", "/tiles/fonts/Sweep%20Nosuch/0-255.pbf", `/s/${"0".repeat(32)}`];
    const sniffed = [];
    for (const p of notFound) {
      const r = await P.host.call("GET", p);
      if (r.status !== 404 || header(r, "x-content-type-options") !== "nosniff") sniffed.push(`${p}: ${r.status}, ${header(r, "content-type")}, nosniff ${header(r, "x-content-type-options")}`);
    }
    t.ok("a file, a map and a share that aren't there: 404, nosniff", sniffed.length === 0, sniffed.join(" | "));
  }

  t.part("10. The rows that end a session or delete what the sweep stands on");
  for (const key of [...later.filter((k) => !ends.includes(k)), ...ends.filter((k) => later.includes(k))]) await sweepRow(key);

  // Each row's line above holds its own answers to no-store; this one says how many were read.
  t.ok(`the answers in JSON read for no-store: ${held.answers}, from ${held.rows.size} rows`, held.answers >= keys.length && held.rows.size >= keys.length / 2, `${held.answers} answers, ${held.rows.size} rows, of ${keys.length}`);

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

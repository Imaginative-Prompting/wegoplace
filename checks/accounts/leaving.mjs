// Sessions over time, the sign-in cookie from before sessions, signing out everywhere, and
// deleting an account: what goes, what stays, and that nobody else's things are touched.

import crypto from "node:crypto";
import { sessionValue } from "../parity/lib.mjs";
import { Person, cookieNamed } from "../lib/person.mjs";
import { TRIP } from "./passkeys.mjs";
import { roundTrip } from "./providers.mjs";
import { JPEG, png } from "../lib/images.mjs";

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

export async function sessions({ server, report: t, people, authSecret }) {
  const { origin } = server;
  const { ana } = people;
  const hashOf = (person) => crypto.createHash("sha256").update(decodeURIComponent(person.jar.cookies.get("wgp_session"))).digest("hex");

  t.part("A session over time");
  {
    const leftOf = (person) => server.sql(`SELECT expires_at FROM sessions WHERE token_hash = '${hashOf(person)}'`)[0].expires_at - now();
    const fresh = await ana.get("/api/me");
    t.same("a session used again the same day is not written again", cookieNamed(fresh, "wgp_session"), undefined);
    // 180 days from its LAST use: one used a day and a bit after it was made (or last moved) is
    // moved out again, so someone who opens the app on day 80 is still signed in on day 250.
    server.sql(`UPDATE sessions SET expires_at = ${now() + 180 * DAY - DAY + 600} WHERE token_hash = '${hashOf(ana)}'`);
    const sameDay = await ana.get("/api/me");
    t.ok("nor one with less than a day of its life used (one write a day at most)", cookieNamed(sameDay, "wgp_session") === undefined && leftOf(ana) < 180 * DAY - DAY + 660, `${leftOf(ana)} s left`);
    server.sql(`UPDATE sessions SET expires_at = ${now() + 180 * DAY - DAY - 600} WHERE token_hash = '${hashOf(ana)}'`);
    const nextDay = await ana.get("/api/me");
    t.ok("one used a day later is moved out to 180 days from now, and its cookie with it",
      /Max-Age=15552000/.test(cookieNamed(nextDay, "wgp_session") ?? "") && Math.abs(leftOf(ana) - 180 * DAY) < 60, `${leftOf(ana)} s left`);
    server.sql(`UPDATE sessions SET expires_at = ${now() + 100 * DAY} WHERE token_hash = '${hashOf(ana)}'`);
    const day80 = await ana.get("/api/me");
    t.ok("so is one last used 80 days ago", /Max-Age=15552000/.test(cookieNamed(day80, "wgp_session") ?? "") && Math.abs(leftOf(ana) - 180 * DAY) < 60, `${leftOf(ana)} s left`);
    const laptop = new Person(origin, "Ana Check");
    await laptop.signIn(ana.passkeys[0]);
    server.sql(`UPDATE sessions SET expires_at = ${now() - 1} WHERE token_hash = '${hashOf(laptop)}'`);
    t.same("one past its time is no session", [(await laptop.get("/api/me")).status, (await laptop.get(TRIP)).status], [401, 401]);
    const forged = new Person(origin, "x");
    forged.jar.cookies.set("wgp_session", hashOf(ana));
    t.same("the hash the database holds is not a cookie that works", (await forged.get("/api/me")).status, 401);
  }

  t.part("The sign-in cookie from before sessions");
  {
    // Two accounts as migration 0016 leaves the ones that existed: a username, and on the list.
    server.sql(`INSERT INTO users (id, name, username, created_at) VALUES ('u_old1', 'olga', 'olga', 1), ('u_old2', 'omar', 'omar', 1);
      INSERT INTO old_cookie_accounts (user_id) VALUES ('u_old1'), ('u_old2')`);
    const cookie = (id, life = 30 * DAY, secret = authSecret) => sessionValue(secret, id, now() + life);
    const olga = new Person(origin, "olga");
    olga.jar.cookies.set("s2", cookie("u_old1"));
    const first = await olga.get("/api/me");
    t.same("a browser still holding the old cookie is signed in", [first.status, first.json?.id], [200, "u_old1"]);
    t.ok("and is handed a session and has the old cookie cleared",
      /Max-Age=15552000/.test(cookieNamed(first, "wgp_session") ?? "") && /^s2=;.*Max-Age=0/.test(cookieNamed(first, "s2") ?? ""), first.cookies.map((c) => c.replace(/=[^;]+/, "=…")));
    t.same("with only the session it stays signed in", [olga.jar.cookies.has("s2"), (await olga.get("/api/me")).status], [false, 200]);

    const omarCookie = cookie("u_old2");
    const tabs = await Promise.all(Array.from({ length: 12 }, () => {
      const tab = new Person(origin, "omar", "10.8.8.8");
      tab.jar.cookies.set("s2", omarCookie);
      return tab.get("/api/me").then((res) => [res.status, tab.jar.cookies.get("wgp_session")]);
    }));
    t.ok("twelve requests at once with the old cookie all answer, with the same session",
      tabs.every(([status]) => status === 200) && new Set(tabs.map(([, c]) => c)).size === 1, tabs.map(([s]) => s));
    t.same("which is one row", server.sql("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'u_old2'")[0].n, 1);

    const refusals = {
      "a cookie signed with another secret": cookie("u_old1", 30 * DAY, "not-the-secret"),
      "a cookie past its date": cookie("u_old1", -60),
      "a cookie whose account was changed after signing": cookie("u_old1").replace("u_old1", "u_old2"),
      "a cookie for an account made since (the old cookie was never theirs)": cookie(ana.user.id),
      "a cookie with a fourth part": `${cookie("u_old1")}.x`,
      "an empty signature": `u_old1.${now() + DAY}.`,
    };
    for (const [what, value] of Object.entries(refusals)) {
      const p = new Person(origin, "x");
      p.jar.cookies.set("s2", value);
      const res = await p.get("/api/me");
      t.same(`${what} signs nobody in`, [res.status, p.signedIn], [401, false]);
    }

    const omar = new Person(origin, "omar");
    omar.jar.cookies.set("s2", omarCookie);
    await omar.get("/api/me");
    const everywhere = await omar.post("/api/auth/logout/all");
    t.same("sign out everywhere", [everywhere.status, omar.signedIn], [200, false]);
    const stale = new Person(origin, "omar");
    stale.jar.cookies.set("s2", omarCookie);
    t.same("after it, a copy of the old cookie no longer signs that account in", [(await stale.get("/api/me")).status, server.sql("SELECT COUNT(*) AS n FROM old_cookie_accounts WHERE user_id = 'u_old2'")[0].n], [401, 0]);
    t.same("the other old account's still does", server.sql("SELECT COUNT(*) AS n FROM old_cookie_accounts WHERE user_id = 'u_old1'")[0].n, 1);
    const out = await olga.post("/api/auth/logout");
    t.ok("plain sign-out clears both cookies", /^s2=;/.test(cookieNamed(out, "s2") ?? "") && /^wgp_session=;/.test(cookieNamed(out, "wgp_session") ?? ""));
  }

  t.part("Sign out everywhere");
  {
    const phone = new Person(origin, "Ana Check");
    const laptop = new Person(origin, "Ana Check");
    await phone.signIn(ana.passkeys[0]);
    await laptop.signIn(ana.passkeys[0]);
    t.same("(two more browsers signed in; the app's files answer)", [(await phone.get("/js/store.js")).status, (await laptop.get("/api/me")).status], [200, 200]);
    const done = await phone.post("/api/auth/logout/all");
    t.same("one of them signs out everywhere", done.status, 200);
    t.same("every session of the account is gone", server.sql(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = '${ana.user.id}'`)[0].n, 0);
    const stillHolding = [(await laptop.get("/api/me")).status, (await ana.get("/api/me")).status, (await laptop.get(TRIP)).status, (await laptop.get("/tiles/x.json")).status];
    t.same("the other browsers' cookies open nothing: not the account, its trip or the map", stillHolding, [401, 401, 401, 401]);
    t.same("signed out, there is no signing out everywhere", (await new Person(origin, "x").post("/api/auth/logout/all")).status, 401);
    t.same("the passkey still signs in", (await ana.signIn(ana.passkeys[0])).status, 200);
  }
}

/** Uploads bytes as the app does (begin, one part, finish) and returns the stored key. */
async function upload(person, bytes, { name = "photo.jpg", mime = "image/jpeg", finish = true } = {}) {
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const begun = await person.post(`${TRIP}/media/begin`, { name, mime, bytes: bytes.length, sha256 });
  if (begun.status >= 300) throw new Error(`upload begin: ${begun.status} ${begun.text}`);
  const { key, uploadId } = begun.json;
  if (!finish) return key;
  const q = `key=${encodeURIComponent(key)}&id=${encodeURIComponent(uploadId)}`;
  const part = await person.call("PUT", `${TRIP}/media/part?${q}&n=1`, bytes, { headers: { "Content-Type": "application/octet-stream" } });
  if (part.status >= 300) throw new Error(`upload part: ${part.status} ${part.text}`);
  const done = await person.post(`${TRIP}/media/finish`, { key, id: uploadId, parts: [{ n: 1, etag: part.json.etag }] });
  if (done.status >= 300) throw new Error(`upload finish: ${done.status} ${done.text}`);
  return key;
}
// A JPEG's first bytes, then text that says whose it is.
// A real JPEG, each one its own by the label after its end: a board's pictures and thumbnails are cleaned before they're
// kept (src/media/strip.js), and bytes that aren't a picture are refused.
const picture = (label) => Buffer.concat([JPEG, Buffer.from(`${label} `.repeat(60), "latin1")]);

export async function deleting({ server, report: t, people, standin }) {
  const { origin } = server;
  const { ana, ben } = people;
  const MEDIA = "wegoplace-media";
  const count = (table, where) => server.sql(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)[0].n;

  t.part("Deleting an account: what it has");
  const dee = new Person(origin, "Dee Check");
  await dee.signUp();
  server.sql(`INSERT INTO trip_members (trip_id, user_id, joined_at) VALUES ('check-trip', '${dee.user.id}', 2)`);
  const id = dee.user.id;
  const T0 = 1935532800;
  const made = {};
  {
    const must = (what, res) => { if (res.status >= 300) throw new Error(`${what}: ${res.status} ${res.text.slice(0, 200)}`); return res.json; };
    must("ana's event", await ana.post(`${TRIP}/events`, { id: "ev-ana", title: "Dinner", starts_at: T0, tz: "Europe/Lisbon" }));
    must("dee's event", await dee.post(`${TRIP}/events`, { id: "ev-dee", title: "Dee's walk", starts_at: T0 + 3600, tz: "Europe/Lisbon" }));
    must("dee's note (a message about the plan)", await dee.post(`${TRIP}/messages`, { id: "n_dee", body: "I'll be late", about: { kind: "event", id: "ev-ana" } }));
    must("a purchase dee paid", await dee.post(`${TRIP}/purchases`, {
      id: "pu_dee", description: "Taxi", amount_minor: 3000, currency: "EUR", amount_exp: 2, split_mode: "weight", spent_at: T0,
      shares: [{ user_id: id, weight: 1, share_minor: 1500 }, { user_id: ana.user.id, weight: 1, share_minor: 1500 }],
    }));
    must("a purchase ana paid, dee owing", await ana.post(`${TRIP}/purchases`, {
      id: "pu_ana", description: "Lunch", amount_minor: 2000, currency: "EUR", amount_exp: 2, split_mode: "weight", spent_at: T0,
      shares: [{ user_id: id, weight: 1, share_minor: 1000 }, { user_id: ana.user.id, weight: 1, share_minor: 1000 }],
    }));
    must("dee's packing item, in a bag", await dee.post(`${TRIP}/packing`, { id: "pk_dee", label: "Socks", bags: { "leaving-home": "main-bag" } }));
    must("dee's tick on it", await dee.call("PUT", `${TRIP}/packing/ticks`, { item_id: "pk_dee", list_key: "leaving-home", ticked: true }));
    must("dee's item on the group's list", await dee.post(`${TRIP}/packing`, { id: "pk_group", owner: "group", label: "Stove", category: "gear" }));
    made.inMemory = await upload(dee, picture("dee's photo in a memory"));
    const thumb = await dee.call("PUT", `${TRIP}/media/thumb?for=${encodeURIComponent(made.inMemory)}&mime=image/jpeg`, picture("dee's thumb"), { headers: { "Content-Type": "image/jpeg" } });
    made.thumb = must("thumb", thumb).key;
    must("dee's memory", await dee.post(`${TRIP}/memories`, { id: "mem_dee", caption: "The square", tags: ["lisbon"], media: [{ key: made.inMemory, thumb_key: made.thumb, w: 40, h: 30 }] }));
    made.loose = await upload(dee, picture("dee's photo in no memory"));
    made.unfinished = await upload(dee, picture("dee's upload still under way"), { finish: false });
    const board = await dee.call("POST", `${TRIP}/collage/share?mime=image/jpeg&w=240&h=180&title=Dee`, picture("dee's board"), { headers: { "Content-Type": "image/jpeg" } });
    made.share = must("dee's shared board", board).share.id;
    must("its item", await dee.call("POST", `${TRIP}/collage/share/${made.share}/item?idx=0&kind=photo&mime=image/jpeg&w=120&h=90&fx=0.1&fy=0.2&fw=0.3&fh=0.25&rot=0`,
      picture("dee's board item"), { headers: { "Content-Type": "image/jpeg" } }));
    made.anaPhoto = await upload(ana, picture("ana's photo"));
    must("ana's memory", await ana.post(`${TRIP}/memories`, { id: "mem_ana", caption: "Mine", media: [{ key: made.anaPhoto }] }));
    // Ana's own board, showing a photograph from dee's memory (and one from hers).
    const anaBoard = await ana.call("POST", `${TRIP}/collage/share?mime=image/jpeg&w=240&h=180&title=Ana`, picture("ana's board"), { headers: { "Content-Type": "image/jpeg" } });
    made.anaShare = must("ana's board", anaBoard).share.id;
    // A picture dee puts on the trip's cover is the trip's: it stays when dee goes.
    made.cover = must("dee's picture on the trip's cover", await dee.call("PUT", `${TRIP}/pictures/cover?license=own`, png(40, 30), { headers: { "Content-Type": "application/octet-stream" } })).picture.url.replace(/^\/media\//, "");
    must("on it, dee's photograph", await ana.call("POST", `${TRIP}/collage/share/${made.anaShare}/item?idx=0&kind=photo&mime=image/jpeg&w=120&h=90&memory=mem_dee`,
      picture("ana's board: dee's photo"), { headers: { "Content-Type": "image/jpeg" } }));
    must("and one of hers", await ana.call("POST", `${TRIP}/collage/share/${made.anaShare}/item?idx=1&kind=photo&mime=image/jpeg&w=120&h=90&memory=mem_ana`,
      picture("ana's board: her photo"), { headers: { "Content-Type": "image/jpeg" } }));
    await dee.addPasskey();
    await roundTrip(standin, dee, "github", { id: 4242777, login: "dee-check", name: "Dee" }, { intent: "link" });
    let mark = server.logMark();
    const asked = await dee.post("/api/account/email", { email: "dee@check.example" });
    const code = (await server.mailTo("dee@check.example", mark))?.subject.match(/\b(\d{6})\b/)?.[1];
    must("dee's email", await dee.post("/api/account/email/confirm", { id: asked.json.id, code }));
    await dee.call("PATCH", "/api/me", { note_color: null, initials: "DC", native_currency: "EUR" });
    const boardKeys = (share) => server.sql(`SELECT image_key FROM collage_shares WHERE id = '${share}'`).map((r) => r.image_key)
      .concat(server.sql(`SELECT r2_key FROM collage_share_items WHERE share_id = '${share}'`).map((r) => r.r2_key));
    made.shareKeys = boardKeys(made.share);
    made.anaShareKeys = boardKeys(made.anaShare);
  }
  const deePhone = new Person(origin, "Dee Check");
  await deePhone.signIn(dee.passkeys[0]);
  // What Ana's own files hold, read from the rows (the trip's storage is read from them too).
  const anaBytes = server.sql(`SELECT COALESCE(SUM(bytes), 0) AS b FROM media_objects WHERE user_id = '${ana.user.id}' AND state = 'stored'`)[0].b;
  const stored = [made.inMemory, made.thumb, made.loose, ...made.shareKeys, ...made.anaShareKeys];
  t.ok("(the account has two passkeys, GitHub, an email, two sessions; its files are stored)",
    count("passkeys", `user_id = '${id}'`) === 2 && count("identities", `user_id = '${id}'`) === 1 && count("account_emails", `user_id = '${id}'`) === 1
    && count("sessions", `user_id = '${id}'`) === 2 && stored.every((key) => server.has(MEDIA, key)) && server.has(MEDIA, made.anaPhoto),
    stored.map((key) => [key, server.has(MEDIA, key)]));
  t.same("(its shared board's page is public, and so is the other person's board showing its photograph)",
    [(await new Person(origin, "x").get(`/s/${made.share}`, { page: true })).status, (await new Person(origin, "x").get(`/s/${made.anaShare}`, { page: true })).status], [200, 200]);

  t.part("Deleting an account");
  {
    const unsure = await dee.call("DELETE", "/api/me", {});
    t.same("it has to be asked for in so many words", [unsure.status, unsure.json?.error, count("users", `id = '${id}' AND deleted_at IS NULL`)], [400, "confirm", 1]);
    const foreign = await dee.call("DELETE", "/api/me", { confirm: "delete" }, { origin: "https://elsewhere.example" });
    t.same("another site's page can't ask", [foreign.status, count("users", `id = '${id}' AND deleted_at IS NULL`)], [403, 1]);
    const host = await ana.call("DELETE", "/api/me", { confirm: "delete" });
    t.same("the account that hosts the trip can't go while other people are on it", [host.status, host.json?.error, host.json?.trips?.map((x) => x.id), count("users", `id = '${ana.user.id}' AND deleted_at IS NULL`)], [409, "host", ["check-trip"], 1]);

    const gone = await dee.call("DELETE", "/api/me", { confirm: "delete" });
    t.same("the account deletes itself", [gone.status, gone.json?.ok, dee.signedIn], [200, true, false]);

    t.same("every way in is gone: passkeys, GitHub, sessions, email, codes",
      ["passkeys", "identities", "sessions", "account_emails", "email_codes", "signin_links", "challenges"].map((table) => count(table, `user_id = '${id}'`)), [0, 0, 0, 0, 0, 0, 0]);
    t.same("its other browser is signed out", [(await deePhone.get("/api/me")).status, (await deePhone.get(TRIP)).status], [401, 401]);
    const key = await new Person(origin, "x").signIn(dee.passkeys[0]);
    t.same("its passkey signs nobody in", [key.status, key.json?.error], [401, "unknown passkey"]);
    const again = await roundTrip(standin, new Person(origin, "x"), "github", { id: 4242777, login: "dee-check", name: "Dee" });
    t.same("its GitHub sign-in is nobody's again", again.back.location, "/login/new");
    const mark = server.logMark();
    await new Person(origin, "x").post("/api/auth/recover", { email: "dee@check.example" });
    t.same("its address gets no code", await server.mailTo("dee@check.example", mark, { within: 1500 }), null);

    const row = server.sql(`SELECT name, username, note_color, initials, native_currency, tab_layout, deleted_at > 0 AS deleted FROM users WHERE id = '${id}'`)[0];
    t.same("its row keeps the name and nothing else, marked deleted", row,
      { name: "Dee Check", username: null, note_color: null, initials: null, native_currency: null, tab_layout: null, deleted: 1 });

    t.same("its memories, their files' rows, its loose and unfinished uploads, its own packing items with their bags and ticks are gone",
      [count("memories", `created_by = '${id}'`), count("memory_media", "memory_id = 'mem_dee'"), count("memory_tags", "memory_id = 'mem_dee'"),
        count("media_objects", `user_id = '${id}' AND r2_key NOT IN (SELECT r2_key FROM pictures)`), count("packing_items", `owner = '${id}'`), count("packing_placements", "item_id = 'pk_dee'"), count("packing_ticks", "item_id = 'pk_dee'")],
      [0, 0, 0, 0, 0, 0, 0]);
    t.same("its shared board is gone, and its page with it", [count("collage_shares", `created_by = '${id}'`), count("collage_share_items", `share_id = '${made.share}'`),
      (await new Person(origin, "x").get(`/s/${made.share}`, { page: true })).status], [0, 0, 404]);
    // Reading the trip after the deletion writes nothing: the deleted row stays without a
    // colour, and the trip's rev doesn't move for a read.
    const revAfter = server.sql("SELECT rev FROM trips WHERE id = 'check-trip'")[0].rev;
    const readAfter = await ana.get(TRIP);
    t.same("reading the trip afterwards writes nothing: the deleted row keeps no colour, the rev stays, and the trip shows its colour as null",
      [server.sql(`SELECT note_color FROM users WHERE id = '${id}'`)[0].note_color, server.sql("SELECT rev FROM trips WHERE id = 'check-trip'")[0].rev,
        readAfter.json?.members?.find((m) => m.id === id)?.note_color], [null, revAfter, null]);
    const anaBoardNow = server.sql(`SELECT revoked_at IS NOT NULL AS revoked, revoked_why, rev FROM collage_shares WHERE id = '${made.anaShare}'`)[0];
    t.same("someone else's board showing a photograph from its memory is unshared too: revoked because a memory on it went, its photographs gone, its page gone",
      [anaBoardNow?.revoked, anaBoardNow?.revoked_why, count("collage_share_items", `share_id = '${made.anaShare}'`), (await new Person(origin, "x").get(`/s/${made.anaShare}`, { page: true })).status],
      [1, "memory", 0, 404]);
    t.same("  (the board takes the rev the deletion gave the trip, the same as its member row)", anaBoardNow?.rev,
      server.sql(`SELECT rev FROM trip_members WHERE user_id = '${id}' AND trip_id = 'check-trip'`)[0]?.rev);
    t.same("a picture it put on the trip's cover stays, as the trip's: its row, its file, nothing queued",
      [count("pictures", `r2_key = '${made.cover}' AND created_by = '${id}'`), count("media_objects", `r2_key = '${made.cover}'`), count("files_to_delete", `r2_key = '${made.cover}'`)], [1, 1, 0]);
    const queued = server.sql("SELECT r2_key FROM files_to_delete").map((r) => r.r2_key);
    t.same("every one of those files is queued for the drain, in the same write as its row", stored.filter((k) => !queued.includes(k)), []);
    await fetch(`${origin}/__scheduled?cron=*/15+*+*+*+*`);
    const left = stored.filter((k) => server.has(MEDIA, k));
    t.same("and once the drain has run, their bytes are gone from the bucket", [left, server.sql("SELECT COUNT(*) AS n FROM files_to_delete")[0].n], [[], 0]);

    t.same("what it added to the shared plan stays: its event, its note, its item on the group's list",
      [count("events", "id = 'ev-dee'"), count("messages", "id = 'n_dee' AND deleted_at IS NULL"), count("packing_items", "id = 'pk_group'")], [1, 1, 1]);
    const purchases = (await ana.get(`${TRIP}/purchases`)).json?.purchases ?? [];
    const paid = purchases.find((p) => p.id === "pu_dee");
    const owed = purchases.find((p) => p.id === "pu_ana");
    t.same("the money stays: what it paid, and what it owed on someone else's purchase",
      [paid?.paid_by, paid?.shares?.map((s) => s.share_minor).sort(), owed?.shares?.find((s) => s.user_id === id)?.share_minor], [id, [1500, 1500], 1000]);
    const member = (await ana.get(TRIP)).json?.members?.find((m) => m.id === id);
    t.ok("and the trip still has its name for those, as someone who left and is gone", member?.name === "Dee Check" && member.deleted === true && Number.isInteger(member.left_at), member);

    t.same("nobody else's things were touched: the other person's memory, file and total",
      [count("memories", "id = 'mem_ana'"), server.has(MEDIA, made.anaPhoto)], [1, true]);
    const after = (await ana.get(TRIP)).json?.storage;
    const leftOnTrip = server.sql(`SELECT bytes FROM pictures WHERE r2_key = '${made.cover}'`)[0]?.bytes ?? 0;
    t.same("the trip now holds only what the others stored, and the picture it left on the trip's cover", after?.trip_bytes, anaBytes + leftOnTrip);
    t.same("and their file still opens", (await ana.get(`/media/${made.anaPhoto}`)).status, 200);
    t.same("the others' accounts are as they were", [count("users", "deleted_at IS NULL AND id IN ('" + [ana.user.id, ben.user.id].join("','") + "')"), (await ben.get("/api/me")).status], [2, 200]);
  }

  t.part("Deleting an account that is on no trip");
  {
    const solo = new Person(origin, "Solo Check");
    await solo.signUp();
    const gone = await solo.call("DELETE", "/api/me", { confirm: "delete" });
    t.same("it goes", [gone.status, count("users", `id = '${solo.user.id}' AND deleted_at IS NOT NULL`), (await solo.get("/api/me")).status], [200, 1, 401]);
    const sameName = new Person(origin, "Solo Check");
    t.same("and its name is free for anyone, as every name is", (await sameName.signUp()).status, 200);
  }
}

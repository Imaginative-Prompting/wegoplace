// The proof that the accounts from before open sign-up come through migrations 0016 (accounts),
// 0017 (trips), 0018 (removed members), 0019 (what a trip carries) and 0020 (storage) as they are: same ids, same passkeys, still signed
// in, still on their trip, which now has a host.
//
// It runs the Worker as it was before accounts were made over (commit 109984b, taken out of
// this clone's history into the check's own folder), signs two people up and in through THAT
// code with invite codes, then applies 0016 to 0020 the way production will take them (one
// file each, by `d1 execute --file`) and starts today's Worker on the same database.
//
//   node checks/accounts/carry-over.mjs [--port <n>] [--keep] [--at www]   (a free port when not named)
//
// --at www: after the migrations, everyone comes back at the site's second address
// (http://www.localhost:<port>, ALSO_ORIGINS), as a phone whose app was added at www. does: its
// old cookie and its passkeys carried there. (The old Worker answers at the first address; what it
// sets and stores doesn't depend on which name it was reached by.)
//
// It needs that commit in the clone. A copy of the repo published with a fresh history doesn't
// have it, and has no accounts from before to carry: there the check says so and exits 2.
// It goes, with src/accounts/old-cookie.js, once the last old cookie has run out.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Passkey } from "../parity/lib.mjs";
import { startServer, CheckError, ROOT, freePort } from "../lib/server.mjs";
import { Person, Report, cookieNamed } from "../lib/person.mjs";

const BEFORE = "109984b70545b65919c89c98cacda2a8c20e62f9";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const keep = argv.includes("--keep");
const AT = flag("--at");
if (AT !== null && AT !== "www") { console.error("--at www, or nothing"); process.exit(2); }

const t = new Report("accounts carry-over");
let server;
let code = 1;
try {
  if (spawnSync("git", ["cat-file", "-e", `${BEFORE}^{commit}`], { cwd: ROOT }).status !== 0)
    throw new CheckError(`this clone doesn't have commit ${BEFORE.slice(0, 7)}, the Worker from before accounts were made over`);
  const migrations = fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  const at = migrations.indexOf("0016_accounts.sql");
  const authSecret = crypto.randomBytes(24).toString("base64url");
  server = await startServer({ name: "carry-over", port, keep, migrations: migrations.slice(0, at), secrets: { AUTH_SECRET: authSecret },
    vars: AT ? { ALSO_ORIGINS: `http://www.localhost:${port}` } : {} });
  const old = path.join(server.work, "before");
  fs.mkdirSync(old);
  const archive = spawnSync("git", ["archive", BEFORE, "src"], { cwd: ROOT, maxBuffer: 64 << 20 });
  if (archive.status !== 0 || spawnSync("tar", ["-x", "-C", old], { input: archive.stdout }).status !== 0) throw new CheckError("couldn't take the old Worker out of the history");
  // The old Worker asks the real rates provider (a constant, before FX_PROVIDER_URL existed). A
  // check reaches nothing outside this machine, so its copy asks the rates stand-in instead.
  const oldFx = path.join(old, "src/api/fx.js");
  const provider = 'const PROVIDER = "https://open.er-api.com/v6/latest/USD";';
  const fxText = fs.readFileSync(oldFx, "utf8");
  if (fxText.split(provider).length !== 2) throw new CheckError("the old Worker's rates provider isn't the one line this check points at the stand-in");
  fs.writeFileSync(oldFx, fxText.replace(provider, `const PROVIDER = ${JSON.stringify(server.ratesUrl)};`));

  const { origin } = server;
  const rpId = "localhost";

  // ── before: the old Worker ────────────────────────────────────────────────────────────────
  t.part("Before: the Worker with invite codes and the signed cookie");
  await server.start({ main: path.join(old, "src/index.js") });
  server.sql(`INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_host', 'host', 1, 1785000000);
    INSERT INTO invites (code, created_by, created_at, max_uses) VALUES ('CARRYOVER1', 'u_host', 1785000001, 2)`);

  /** Sign-up as the old sign-in page did it: an invite code, a name, a passkey. */
  async function oldSignUp(person, passkey, name) {
    const options = await person.post("/api/auth/register/options", { invite: "CARRYOVER1", name });
    if (options.status !== 200) return options;
    passkey.userHandle = options.json.user.id;
    const made = await person.post("/api/auth/register/verify", { invite: "CARRYOVER1", name, credential: passkey.create({ challenge: options.json.challenge, origin, rpId }) });
    if (made.status === 200) { person.user = made.json.user; person.passkeys.push(passkey); }
    return made;
  }
  async function oldSignIn(person, passkey, name) {
    const options = await person.post("/api/auth/login/options", name ? { name } : {});
    return person.post("/api/auth/login/verify", { credential: passkey.get({ challenge: options.json.challenge, origin, rpId }) });
  }

  const carol = new Person(origin, "carol");
  const dan = new Person(origin, "dan");
  const carolKey = Passkey.fresh("carry-carol");
  const danKey = Passkey.fresh("carry-dan");
  t.same("two people sign up through the old code with an invite code", [(await oldSignUp(carol, carolKey, "Carol")).status, (await oldSignUp(dan, danKey, "dan")).status], [200, 200]);
  t.ok("each holds the old signed cookie and no session", carol.jar.cookies.has("s2") && dan.jar.cookies.has("s2") && !carol.signedIn);
  // Carol's device also signs in a few times, so her passkey's counter isn't zero.
  const laptop = new Person(origin, "carol");
  t.same("one signs in twice more on another browser", [(await oldSignIn(laptop, carolKey, "carol")).status, (await oldSignIn(laptop, carolKey)).status], [200, 200]);

  const host = new Person(origin, "host");
  host.jar.cookies.set("s2", `u_host.${Math.floor(Date.now() / 1000) + 86400}.${crypto.createHmac("sha256", authSecret).update(`u_host.${Math.floor(Date.now() / 1000) + 86400}`).digest("hex")}`);
  const trip = { trip: { id: "carry-trip", name: "Carry", starts_on: "2031-05-01", ends_on: "2031-05-09", default_tz: "Europe/Lisbon" }, places: [], events: [] };
  t.same("the host brings a trip in", (await host.post("/api/trip/import", trip)).status, 200);
  t.same("opening the trip put each of them on it, as the old code did", [(await carol.get("/api/trip")).status, (await dan.get("/api/trip")).status], [200, 200]);
  const purchase = await carol.post("/api/purchases", {
    id: "pu_carry", description: "Taxi", amount_minor: 3000, currency: "EUR", amount_exp: 2, split_mode: "weight", spent_at: 1935532800,
    shares: [{ user_id: carol.user.id, weight: 1, share_minor: 1500 }, { user_id: dan.user.id, weight: 1, share_minor: 1500 }],
  });
  t.ok("one pays for something the other owes half of", purchase.status < 300, purchase.text);
  await carol.call("PATCH", "/api/me", { initials: "CA", native_currency: "EUR" });

  const before = {
    users: server.sql("SELECT id, name, is_admin, created_at, note_color, initials, native_currency, tab_layout FROM users ORDER BY id"),
    keys: server.sql("SELECT id, user_id, public_key, counter, created_at FROM credentials ORDER BY id"),
    members: server.sql("SELECT trip_id, user_id, role FROM trip_members ORDER BY user_id"),
    shares: server.sql("SELECT purchase_id, user_id, share_minor FROM purchase_shares ORDER BY user_id"),
  };
  t.same("(before: three accounts, two passkeys, one used three times, three people on the trip)",
    [before.users.length, before.keys.length, before.keys.find((k) => k.id === carolKey.id)?.counter, before.members.length], [3, 2, 2, 3]);

  // ── the migration, as production takes it ─────────────────────────────────────────────────
  t.part("Migration 0016, applied as one file");
  await server.halt();
  server.sqlFile(path.join(ROOT, "migrations/0016_accounts.sql"));
  const after = {
    users: server.sql("SELECT id, name, is_admin, created_at, note_color, initials, native_currency, tab_layout FROM users ORDER BY id"),
    keys: server.sql("SELECT id, user_id, public_key, counter, created_at FROM passkeys ORDER BY id"),
    members: server.sql("SELECT trip_id, user_id, role FROM trip_members ORDER BY user_id"),
    shares: server.sql("SELECT purchase_id, user_id, share_minor FROM purchase_shares ORDER BY user_id"),
  };
  t.same("every account is there under the same id, with its name and settings", after.users, before.users);
  t.same("every passkey is there: same id, same account, same key, same counter", after.keys, before.keys);
  t.same("the trip's people and the money between them are as they were", [after.members, after.shares], [before.members, before.shares]);
  t.same("each account's old sign-in name is kept as its username", server.sql("SELECT username FROM users ORDER BY id").map((r) => r.username), before.users.map((u) => u.name));
  t.same("every one of them may still use the old cookie", server.sql("SELECT COUNT(*) AS n FROM old_cookie_accounts")[0].n, 3);
  t.same("no row anywhere points at an account that isn't there", server.sql("PRAGMA foreign_key_check"), []);
  const tables = server.sql("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
  t.ok("the old tables are gone and nothing was left half moved", !["credentials", "invites", "accounts_moving"].some((name) => tables.includes(name)), tables);
  const again = spawnSync(path.join(ROOT, "node_modules/.bin/wrangler"), ["d1", "execute", "wegoplace", "--local", "--persist-to", server.state, "--file",
    path.join(ROOT, "migrations/0016_accounts.sql"), "-c", path.join(server.work, "wrangler.json")], { cwd: server.work, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: path.join(server.work, "logs"), CI: "1" } });
  t.ok("applied a second time by mistake, it fails and changes nothing", again.status !== 0
    && JSON.stringify(server.sql("SELECT id FROM users ORDER BY id")) === JSON.stringify(before.users.map((u) => ({ id: u.id })))
    && server.sql("SELECT COUNT(*) AS n FROM passkeys")[0].n === 2);

  // ── the next migration, the same way ──────────────────────────────────────────────────────
  t.part("Migration 0017, applied as one file");
  const tripBefore = server.sql("SELECT id, name, starts_on, ends_on, default_tz, created_by, created_at FROM trips");
  server.sqlFile(path.join(ROOT, "migrations/0017_trips.sql"));
  const noAdmin = (rows) => rows.map(({ is_admin, ...rest }) => rest);
  t.same("every account is there under the same id, with its name and settings",
    server.sql("SELECT id, name, created_at, note_color, initials, native_currency, tab_layout FROM users ORDER BY id"), noAdmin(before.users));
  t.same("the trip is there as it was", server.sql("SELECT id, name, starts_on, ends_on, default_tz, created_by, created_at FROM trips"), tripBefore);
  t.same("its people are the same people, none of them marked as having left",
    server.sql("SELECT trip_id, user_id, left_at FROM trip_members ORDER BY user_id"), before.members.map(({ trip_id, user_id }) => ({ trip_id, user_id, left_at: null })));
  t.same("its host is the account that ran the site and brought it in", server.sql("SELECT host_id FROM trips").map((r) => r.host_id), ["u_host"]);
  t.same("the money between them is as it was, and each purchase is a purchase",
    [server.sql("SELECT purchase_id, user_id, share_minor FROM purchase_shares ORDER BY user_id"), server.sql("SELECT DISTINCT kind FROM purchases").map((r) => r.kind)], [before.shares, ["purchase"]]);
  t.same("the trip has a seed for its board", server.sql("SELECT COUNT(*) AS n FROM trips WHERE collage_seed IS NULL")[0].n, 0);
  t.same("no row anywhere points at an account that isn't there", server.sql("PRAGMA foreign_key_check"), []);
  const twice = spawnSync(path.join(ROOT, "node_modules/.bin/wrangler"), ["d1", "execute", "wegoplace", "--local", "--persist-to", server.state, "--file",
    path.join(ROOT, "migrations/0017_trips.sql"), "-c", path.join(server.work, "wrangler.json")], { cwd: server.work, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: path.join(server.work, "logs"), CI: "1" } });
  t.ok("applied a second time by mistake, it fails and changes nothing", twice.status !== 0
    && JSON.stringify(server.sql("SELECT host_id FROM trips")) === JSON.stringify([{ host_id: "u_host" }])
    && server.sql("SELECT COUNT(*) AS n FROM trip_members")[0].n === before.members.length);

  t.part("Migration 0018, applied as one file");
  const membersBefore = server.sql("SELECT trip_id, user_id, joined_at, left_at FROM trip_members ORDER BY user_id");
  server.sqlFile(path.join(ROOT, "migrations/0018_removed.sql"));
  t.same("the trip's people are as they were, none of them marked as removed",
    [server.sql("SELECT trip_id, user_id, joined_at, left_at FROM trip_members ORDER BY user_id"), server.sql("SELECT COUNT(*) AS n FROM trip_members WHERE removed_rev IS NOT NULL")[0].n],
    [membersBefore, 0]);
  const twice18 = spawnSync(path.join(ROOT, "node_modules/.bin/wrangler"), ["d1", "execute", "wegoplace", "--local", "--persist-to", server.state, "--file",
    path.join(ROOT, "migrations/0018_removed.sql"), "-c", path.join(server.work, "wrangler.json")], { cwd: server.work, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: path.join(server.work, "logs"), CI: "1" } });
  t.ok("applied a second time by mistake, it fails and changes nothing", twice18.status !== 0
    && JSON.stringify(server.sql("SELECT trip_id, user_id, joined_at, left_at FROM trip_members ORDER BY user_id")) === JSON.stringify(membersBefore));

  t.part("Migration 0019, applied as one file");
  const purchasesBefore = server.sql("SELECT id, trip_id, amount_minor, paid_by, event_id, place_id, rev FROM purchases ORDER BY id");
  server.sqlFile(path.join(ROOT, "migrations/0019_what_a_trip_carries.sql"));
  t.same("the purchases are as they were, and the trip has the list everyone's copies were",
    [server.sql("SELECT id, trip_id, amount_minor, paid_by, event_id, place_id, rev FROM purchases ORDER BY id"), server.sql("SELECT key FROM packing_lists").map((r) => r.key)],
    [purchasesBefore, server.sql("SELECT DISTINCT key FROM packing_lists").map((r) => r.key)]);
  t.same("no row points at a row that isn't there", server.sql("PRAGMA foreign_key_check"), []);
  const twice19 = spawnSync(path.join(ROOT, "node_modules/.bin/wrangler"), ["d1", "execute", "wegoplace", "--local", "--persist-to", server.state, "--file",
    path.join(ROOT, "migrations/0019_what_a_trip_carries.sql"), "-c", path.join(server.work, "wrangler.json")], { cwd: server.work, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: path.join(server.work, "logs"), CI: "1" } });
  t.ok("applied a second time by mistake, it fails and changes nothing", twice19.status !== 0
    && JSON.stringify(server.sql("SELECT id, trip_id, amount_minor, paid_by, event_id, place_id, rev FROM purchases ORDER BY id")) === JSON.stringify(purchasesBefore));

  t.part("Migration 0020, applied as one file");
  const filesBefore = server.sql("SELECT r2_key, bytes, state FROM media_objects ORDER BY r2_key");
  server.sqlFile(path.join(ROOT, "migrations/0020_storage.sql"));
  t.same("every stored file's row is as it was; the per-uploader counter is gone; nothing is queued, offered or mapped",
    [server.sql("SELECT r2_key, bytes, state FROM media_objects ORDER BY r2_key"), server.sql("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'media_usage'")[0].n,
      server.sql("SELECT COUNT(*) AS n FROM files_to_delete")[0].n, server.sql("SELECT COUNT(*) AS n FROM trip_handovers")[0].n, server.sql("SELECT COUNT(*) AS n FROM trips WHERE tiles IS NOT NULL")[0].n],
    [filesBefore, 0, 0, 0, 0]);
  t.same("no row points at a row that isn't there", server.sql("PRAGMA foreign_key_check"), []);
  const twice20 = spawnSync(path.join(ROOT, "node_modules/.bin/wrangler"), ["d1", "execute", "wegoplace", "--local", "--persist-to", server.state, "--file",
    path.join(ROOT, "migrations/0020_storage.sql"), "-c", path.join(server.work, "wrangler.json")], { cwd: server.work, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: path.join(server.work, "logs"), CI: "1" } });
  t.ok("applied a second time by mistake, it fails and changes nothing", twice20.status !== 0
    && JSON.stringify(server.sql("SELECT r2_key, bytes, state FROM media_objects ORDER BY r2_key")) === JSON.stringify(filesBefore));

  t.part("Migration 0021, applied as one file");
  const boardsBefore = server.sql("SELECT id, revoked_at, rev FROM collage_shares ORDER BY id");
  server.sqlFile(path.join(ROOT, "migrations/0021_board_why.sql"));
  t.same("every board is as it was, and none says why it stopped (nobody recorded why before)",
    [server.sql("SELECT id, revoked_at, rev FROM collage_shares ORDER BY id"), server.sql("SELECT COUNT(*) AS n FROM collage_shares WHERE revoked_why IS NOT NULL")[0].n], [boardsBefore, 0]);
  const twice21 = spawnSync(path.join(ROOT, "node_modules/.bin/wrangler"), ["d1", "execute", "wegoplace", "--local", "--persist-to", server.state, "--file",
    path.join(ROOT, "migrations/0021_board_why.sql"), "-c", path.join(server.work, "wrangler.json")], { cwd: server.work, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: path.join(server.work, "logs"), CI: "1" } });
  t.ok("applied a second time by mistake, it fails and changes nothing", twice21.status !== 0
    && JSON.stringify(server.sql("SELECT id, revoked_at, rev FROM collage_shares ORDER BY id")) === JSON.stringify(boardsBefore));

  t.part("Migration 0022, applied as one file");
  const files22 = server.sql("SELECT r2_key, bytes, state FROM media_objects ORDER BY r2_key");
  server.sqlFile(path.join(ROOT, "migrations/0022_pictures.sql"));
  t.same("the two new tables are there and empty; every file is as it was",
    [server.sql("SELECT COUNT(*) AS n FROM pictures")[0].n, server.sql("SELECT COUNT(*) AS n FROM picture_links")[0].n, server.sql("SELECT r2_key, bytes, state FROM media_objects ORDER BY r2_key")], [0, 0, files22]);
  const twice22 = spawnSync(path.join(ROOT, "node_modules/.bin/wrangler"), ["d1", "execute", "wegoplace", "--local", "--persist-to", server.state, "--file",
    path.join(ROOT, "migrations/0022_pictures.sql"), "-c", path.join(server.work, "wrangler.json")], { cwd: server.work, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: path.join(server.work, "logs"), CI: "1" } });
  t.ok("applied a second time by mistake, it fails and changes nothing", twice22.status !== 0 && server.sql("SELECT COUNT(*) AS n FROM pictures")[0].n === 0);

  // The ones after (changes, the chat): each as one file, as production takes them, so the accounts
  // carried over are on a database that has them all before today's Worker reads it.
  t.part("Migrations 0023 onward, each as one file");
  const later = fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => f.endsWith(".sql") && f >= "0023").sort();
  const usersBefore = server.sql("SELECT id, name FROM users ORDER BY id");
  for (const f of later) server.sqlFile(path.join(ROOT, "migrations", f));
  t.same(`${later.map((f) => f.slice(0, 4)).join(", ")}: every account as it was`, server.sql("SELECT id, name FROM users ORDER BY id"), usersBefore);

  // ── after: today's Worker on the same database ────────────────────────────────────────────
  t.part("After: today's Worker");
  await server.start({ main: path.join(ROOT, "src/index.js") });
  // Where everyone comes back: the first address, or (--at www) the second, with what they kept.
  const here = AT ? `http://www.localhost:${port}` : origin;
  for (const p of [carol, dan, host]) p.origin = here;
  if (AT) t.ok(`everyone comes back at ${here}`, true);
  const TRIP = "/api/trips/carry-trip";
  const stillIn = await carol.get("/api/me");
  t.same("the browser that was signed in still is, as the same account", [stillIn.status, stillIn.json?.id, stillIn.json?.name, stillIn.json?.initials],
    [200, carol.user.id, "carol", "CA"]);
  t.ok("it was handed a session for the old cookie", /Max-Age=15552000/.test(cookieNamed(stillIn, "wgp_session") ?? "") && /^s2=;/.test(cookieNamed(stillIn, "s2") ?? ""));
  t.same("it is on its trip, as a member; the account that brought the trip in hosts it",
    [(await carol.get("/api/trips")).json?.trips?.map((x) => [x.id, x.role, x.members]), (await host.get("/api/trips")).json?.trips?.map((x) => [x.id, x.role])],
    [[["carry-trip", "member", 3]], [["carry-trip", "host"]]]);
  t.same("and reads its trip and the purchase", [(await carol.get(TRIP)).status, (await carol.get(`${TRIP}/purchases`)).json?.purchases?.map((p) => [p.id, p.kind])], [200, [["pu_carry", "purchase"]]]);

  const fresh = new Person(here, "carol");
  const plain = await fresh.signIn(carolKey);
  t.same("the same passkey signs in through the new code with no name typed", [plain.status, plain.json?.user?.id], [200, carol.user.id]);
  t.same("its counter went on from where the old code left it", server.sql(`SELECT counter FROM passkeys WHERE id = '${carolKey.id}'`)[0].counter, 3);
  const noHandle = Object.assign(Object.create(Passkey.prototype), carolKey, { userHandle: null });
  t.same("a device that didn't keep the account with the passkey signs in too", (await new Person(here, "x").signIn(noHandle)).status, 200);
  carolKey.counter = noHandle.counter;
  const named = new Person(here, "carol");
  const options = await named.post("/api/auth/login/options", { username: " Carol " });
  t.same("typing the old name still names that account's passkey", [options.status, options.json?.allowCredentials?.map((c) => c.id)], [200, [carolKey.id]]);
  const byName = await named.post("/api/auth/login/verify", carolKey.get({ challenge: options.json.challenge, origin: here, rpId }));
  t.same("and signs in", [byName.status, byName.json?.user?.id], [200, carol.user.id]);

  const wrong = Passkey.fresh("x");
  Object.assign(wrong, { credId: danKey.credId, id: danKey.id, userHandle: danKey.userHandle, counter: 9 });
  const forged = await new Person(here, "x").signIn(wrong);
  t.same("another key under the other person's passkey id is still refused", [forged.status, forged.json?.error], [401, "not verified"]);
  const stale = Object.assign(Object.create(Passkey.prototype), carolKey, { counter: 0 });
  t.same("and so is a copy of the passkey from before, by its counter", (await new Person(here, "x").signIn(stale)).status, 401);
  const danBack = await new Person(here, "dan").signIn(danKey);
  t.same("the other person signs in as themselves", [danBack.status, danBack.json?.user?.id], [200, dan.user.id]);

  t.same("the account adds a second passkey the new way", (await fresh.addPasskey()).status, 200);
  const newcomer = new Person(here, "carol");
  const made = await newcomer.signUp();
  t.same("a new person may call themselves the same; the old name still signs in only the old account",
    [made.status, made.json?.user?.id !== carol.user.id, (await new Person(here, "x").post("/api/auth/login/options", { username: "carol" })).json?.allowCredentials?.length], [200, true, 2]);
  t.same("the newcomer is on no trip", [(await newcomer.get("/api/trips")).json, (await newcomer.get(TRIP)).status], [{ trips: [] }, 404]);
  const gone = await new Person(here, "x").post("/api/invite/check", { invite: "CARRYOVER1" });
  t.ok("invite codes are gone", gone.status !== 200 || gone.json?.ok === undefined);

  const errors = server.log().split("\n").filter((line) => /Uncaught|✘|\[ERROR\]/.test(line));
  t.ok("nothing failed inside either server", errors.length === 0, errors.slice(0, 8).join("\n        "));
  t.part("Nothing outside this machine");
  t.ok("both Workers asked the rates stand-in for their rates, never the network (the old one's copy points at it)",
    server.ratesAsked() > 0 && fs.readFileSync(path.join(old, "src/api/fx.js"), "utf8").includes(server.ratesUrl), { asked: server.ratesAsked() });
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  code = 2;
} finally {
  if (keep && server) console.log(`kept: ${server.work}`);
  await server?.stop();
}
process.exit(code);

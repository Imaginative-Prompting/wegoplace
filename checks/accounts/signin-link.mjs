// The cutover's fallback for a passkey that won't sign someone in: one one-use link, made by
// tools/signin-link.mjs for one named person on a trip, on a server of its own:
//
//   node checks/accounts/signin-link.mjs [--port <port>]
//
// It holds:
//   1. made by trip and name, the tool files one link and prints two lines and nothing else: the
//      link, at the address the Worker's settings give, and when it stops working (never the
//      token's hash, the SQL or anyone's account id); two hours by default;
//   2. the link signs that one person in, once; a second use and a link past its hours are refused;
//   3. nobody of that name, someone who left, two of one name, an account not on the trip, a name
//      with a quote in it: each refused in words, nothing written; two of one name are told apart
//      by account;
//   4. --remote writes nothing unless the production database is named too, and never with
//      another settings file, without the production config, or with one whose database id is a
//      placeholder (the tree's); with all of it, the command wrangler is given goes to the site's
//      own database with the production config, and the link is for the site's own address (its
//      PUBLIC_ORIGIN). A recorder stands in for wrangler there and turns --remote into this
//      server's local database, and a stand-in production config (the tree's settings with a
//      made-up database id) for the real one: nothing here reaches production or reads it.
// Everyone in it is made up.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CheckError, ROOT, parseJsonc, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { fileLink } from "../../tools/signin-link.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const t = new Report("the cutover's one-use sign-in link");
const TOOL = path.join(ROOT, "tools/signin-link.mjs");
const site = parseJsonc(fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8"));
const SITE_ORIGIN = site.vars.PUBLIC_ORIGIN;
const SITE_DB = site.d1_databases.find((d) => d.binding === "DB").database_name;

let server, code = 1;
try {
  server = await startServer({ name: "signin-link", port });
  await server.start();
  const { origin } = server;
  const config = path.join(server.work, "wrangler.json");
  const local = ["--local", "--persist-to", server.state, "--config", config];
  const tool = (args, env = {}) => {
    const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });
    return { code: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.split("\n").filter(Boolean) };
  };
  const links = () => server.sql("SELECT user_id, created_at, expires_at FROM signin_links ORDER BY created_at");
  const tokenOf = (url) => url.split("/").pop();
  const useLink = async (url) => {
    const visitor = new Person(origin, "a visitor");
    const used = await visitor.post("/api/auth/link", { token: tokenOf(url) });
    return { status: used.status, error: used.json?.error ?? null, me: used.status === 200 ? (await visitor.me())?.id : null };
  };

  const [ada, ben, cleo, cleoToo, dev, eli] = ["Ada Reyes", "Ben Okafor", "Cleo Tran", "Cleo Tran", "Dev Patel", "Eli Moss"].map((n) => new Person(origin, n));
  for (const p of [ada, ben, cleo, cleoToo, dev, eli]) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const trip = (await ada.post("/api/trips", { name: "Coast week", default_tz: "UTC" })).json.trip.id;
  for (const p of [ben, cleo, cleoToo, dev]) await p.post(`/api/join/${(await ada.post(`/api/trips/${trip}/links`, { uses: 1 })).json.link.code}`);
  server.sql(`UPDATE trip_members SET left_at = unixepoch() WHERE trip_id = '${trip}' AND user_id = '${dev.user.id}'`);

  t.part("1. By trip and name");
  const before = Math.floor(Date.now() / 1000);
  const made = tool(["--trip", trip, "--name", "  ben   OKAFOR ", ...local]);
  const said = made.out + made.err;
  t.same("it runs, and prints two lines", [made.code, made.lines.length, made.err], [0, 2, ""]);
  t.ok("the first is the link, at the address the Worker's settings give (this server's)",
    new RegExp(`^${origin.replace(/[.]/g, "\\.")}/login/link/[A-Za-z0-9_-]{43}$`).test(made.lines[0] ?? ""), made.lines[0]);
  t.ok("the second says when it stops working", /^It works once, until .+ \(\d{4}-\d\d-\d\dT\d\d:\d\dZ\)\.$/.test(made.lines[1] ?? ""), made.lines[1]);
  t.ok("never the token's hash, the SQL, or an account id", !/[0-9a-f]{64}/.test(said) && !/INSERT|SELECT/i.test(said) && !said.includes(ben.user.id));
  const filed = links();
  t.same("one link filed, for Ben, good for two hours",
    [filed.length, filed[0]?.user_id, Math.abs(filed[0]?.expires_at - filed[0]?.created_at - 7200) <= 1, Math.abs(filed[0]?.created_at - before) <= 10], [1, ben.user.id, true, true]);

  t.part("2. The link");
  t.same("signs Ben in", await useLink(made.lines[0]), { status: 200, error: null, me: ben.user.id });
  t.same("once: used again, refused", (await useLink(made.lines[0])).error, "expired");
  const old = await fileLink({ trip, name: "Ben Okafor", hours: 1, now: Math.floor(Date.now() / 1000) - 3601, local: true, persistTo: server.state, config });
  t.same("past its hours, refused", (await useLink(old.url)).error, "expired");

  t.part("3. Who it can't be for, in words, nothing written");
  const count = () => server.sql("SELECT COUNT(*) AS n FROM signin_links")[0].n;
  const refused = (label, args, words) => {
    const n = count();
    const r = tool([...args, ...local]);
    t.ok(label, r.code === 2 && r.out === "" && words.test(r.err) && count() === n, `${r.code} ${r.out} ${r.err}`);
    return r;
  };
  refused("nobody of that name", ["--trip", trip, "--name", "Fern Wu"], /^Nobody on “Coast week” is called “Fern Wu” now\. Nothing was written\. Its people: “Ada Reyes”, “Ben Okafor”, “Cleo Tran”, “Cleo Tran”\./);
  refused("someone who left the trip", ["--trip", trip, "--name", "Dev Patel"], /^Nobody on “Coast week” is called “Dev Patel” now\./);
  const two = refused("two of one name: neither, and each named by account", ["--trip", trip, "--name", "cleo tran"], /^2 people on “Coast week” are called “cleo tran”\. Nothing was written\./);
  t.ok("  each with the line that picks it", [cleo, cleoToo].every((p) => two.err.includes(`--trip ${trip} --account ${p.user.id}    (joined `)), two.err);
  const picked = tool(["--trip", trip, "--account", cleoToo.user.id, ...local]);
  t.same("  picked by account, the link signs that one in", [picked.code, (await useLink(picked.lines[0] ?? "x")).me], [0, cleoToo.user.id]);
  refused("an account that isn't on the trip", ["--trip", trip, "--account", eli.user.id], /^Account ".+" isn't one of the people on “Coast week” now\./);
  refused("a name with a quote in it is a name, not SQL", ["--trip", trip, "--name", "O'Brien' OR '1'='1"], /^Nobody on “Coast week” is called “O'Brien' OR '1'='1” now\./);
  refused("a trip that isn't", ["--trip", "no-such-trip", "--name", "Ben Okafor"], /^No trip has the id "no-such-trip"\./);
  refused("a name without its trip", ["--name", "Ben Okafor"], /^--name needs --trip/);

  t.part("4. Production, said in full or not at all");
  const recorder = path.join(server.work, "wrangler-recorder.mjs");
  const heard = path.join(server.work, "wrangler-heard.jsonl");
  const real = path.join(ROOT, "node_modules/.bin/wrangler");
  fs.writeFileSync(recorder, `#!/usr/bin/env node
// Stands in for wrangler: writes down what it was asked, and runs it on the check's own local database.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
const asked = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(heard)}, JSON.stringify(asked) + "\\n");
const args = [];
for (let i = 0; i < asked.length; i++) {
  if (asked[i] === "--remote") args.push("--local", "--persist-to", ${JSON.stringify(server.state)});
  else if (asked[i] === "--yes") continue;
  else if (asked[i] === "-c") { args.push("-c", ${JSON.stringify(config)}); i++; }
  else args.push(asked[i]);
}
if (args.includes("--remote") || !args.includes("--local")) { console.error("the recorder sends nothing remote"); process.exit(9); }
const r = spawnSync(${JSON.stringify(real)}, args, { encoding: "utf8", env: process.env });
process.stdout.write(r.stdout ?? ""); process.stderr.write(r.stderr ?? "");
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  // The production config, stood in: the tree's settings with a made-up database id (the tree carries a placeholder).
  const standInProd = path.join(server.work, "wrangler.production.jsonc");
  const siteSettings = parseJsonc(fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8"));
  fs.writeFileSync(standInProd, JSON.stringify({ ...siteSettings, d1_databases: siteSettings.d1_databases.map((d) => ({ ...d, database_id: "11111111-2222-4333-8444-555555555555" })) }, null, 2));
  const placeholderProd = path.join(server.work, "wrangler.placeholder.jsonc");
  fs.writeFileSync(placeholderProd, JSON.stringify(siteSettings, null, 2));
  const viaRecorder = { WGP_SIGNIN_LINK_WRANGLER: recorder, WGP_SIGNIN_LINK_PRODUCTION_CONFIG: standInProd };
  const askedOf = () => (fs.existsSync(heard) ? fs.readFileSync(heard, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const guard = (label, args, words) => {
    const n = count();
    const r = tool([...args, "--trip", trip, "--name", "Ben Okafor"], viaRecorder);
    t.ok(label, r.code === 2 && r.out === "" && words.test(r.err) && askedOf().length === 0 && count() === n, `${r.code} ${r.out} ${r.err}`);
  };
  guard("--remote alone: refused before wrangler is asked anything", ["--remote"], new RegExp(`say its name too \\(--production-database ${SITE_DB}\\)\\. Nothing was written\\.`));
  guard("--remote with another database's name: refused", ["--remote", "--production-database", `${SITE_DB}-prod`], /isn't the site's database/);
  guard("--remote with a check's settings file: refused", ["--remote", "--production-database", SITE_DB, "--config", config], /takes no --config/);
  guard("neither --local nor --remote: refused", [], /^say where the link is filed/);
  const guardWith = (label, prodConfig, words) => {
    const n = count();
    const r = tool(["--remote", "--production-database", SITE_DB, "--trip", trip, "--name", "Ben Okafor"], { ...viaRecorder, WGP_SIGNIN_LINK_PRODUCTION_CONFIG: prodConfig });
    t.ok(label, r.code === 2 && r.out === "" && words.test(r.err) && askedOf().length === 0 && count() === n, `${r.code} ${r.out} ${r.err}`);
  };
  guardWith("--remote with no production config there: refused", path.join(server.work, "no-such.jsonc"), /there is none at .*copy it there as for a deploy\. Nothing was written\./);
  guardWith("--remote with the tree's config (a placeholder database id) as the production one: refused", placeholderProd, /names no real database .* Nothing was written\./);
  guard("--local without the database's folder: refused", ["--local"], /^--local needs --persist-to/);
  const prod = tool(["--remote", "--production-database", SITE_DB, "--trip", trip, "--name", "Ben Okafor"], viaRecorder);
  const asked = askedOf();
  t.same("said in full: it runs, two lines", [prod.code, prod.lines.length], [0, 2]);
  t.ok(`  the link is for the site's own address (${SITE_ORIGIN}, wrangler.jsonc), not typed and not this server's`,
    (prod.lines[0] ?? "").startsWith(`${SITE_ORIGIN}/login/link/`), prod.lines[0]);
  t.ok("  every command wrangler was given goes to the site's own database with the production config",
    asked.length === 2 && asked.every((a) => a.slice(0, 3).join(" ") === `d1 execute ${SITE_DB}` && a.includes("--remote") && !a.includes("--local") && a.at(-1) === standInProd),
    asked.map((a) => a.filter((x) => !/^(SELECT|INSERT)/.test(x)).join(" ")));
  t.ok("  and none of them carries the token", asked.every((a) => !a.join(" ").includes(tokenOf(prod.lines[0] ?? "x"))));
  const there = await useLink(`${origin}/login/link/${tokenOf(prod.lines[0] ?? "x")}`);
  t.same("  the link it filed signs Ben in (here, the recorder's database)", there.me, ben.user.id);
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await server?.stop();
}
process.exit(code);

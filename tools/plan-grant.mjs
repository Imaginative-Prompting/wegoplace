#!/usr/bin/env node
// The plan given to one account by the site's operator (0046 plan_grants; src/billing/plan.js grantOf, entitlement): the
// plan's room and, on the trips it hosts, the assistant, with nothing charged and no Stripe behind it, whether or not the
// site sells the plan. Recorded as a grant: no subscription is made up for it.
//
//   node tools/plan-grant.mjs --user <account id> --reason "<why, in a few words>"  <where>    give it
//   node tools/plan-grant.mjs --user <account id> --revoke  <where>                            take it back
//   node tools/plan-grant.mjs --user <account id> --show  <where>                              say whether it holds
//
// <where>, exactly as tools/signin-link.mjs takes it:
//   --local --persist-to <dir> [--config <file>]   a local database (a check)
//   --remote --production-database <name>          the site's own database, by the production config at the checkout's
//                                                  root (wrangler.production.jsonc, as a deploy reads it), its D1
//                                                  database_name typed out
//
// The account is named explicitly, every time: there is no default and no "me". It must be an account that exists and
// isn't deleted. Nothing else is written. It prints one line and never the account's id or name (an operator's
// terminal is a log too).

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Refused, placeOf } from "./signin-link.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// A check stands a recorder in for wrangler to see the command a production run would send.
const WRANGLER = process.env.WGP_PLAN_GRANT_WRANGLER || path.join(ROOT, "node_modules/.bin/wrangler");
const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;

function run(place, sql) {
  const r = spawnSync(WRANGLER, ["d1", "execute", place.database, ...place.where, "--json", "--command", sql, "-c", place.file], {
    cwd: path.dirname(place.file), encoding: "utf8", maxBuffer: 16 << 20,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  if (r.status !== 0) throw new Refused(`wrangler couldn't run it (exit ${r.status}):\n${`${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(-1500)}`);
  try { return JSON.parse(r.stdout.slice(r.stdout.indexOf("["))).map((s) => s.results ?? []); }
  catch { throw new Refused(`wrangler's answer wasn't the rows asked for:\n${String(r.stdout).trim().slice(-800)}`); }
}

/**
 * Gives, takes back or reads the grant: { done, holds } and the line to print.
 * @param {{ user: string, reason?: string, revoke?: boolean, show?: boolean, now?: number } & object} o  plus <where>
 */
export function planGrant({ user, reason = null, revoke = false, show = false, now = Math.floor(Date.now() / 1000), ...where }) {
  if (typeof user !== "string" || !/^[0-9a-f-]{36}$/.test(user)) throw new Refused("--user takes the account's id (36 characters): the account is named every time, never assumed.");
  if ([revoke, show, reason !== null].filter(Boolean).length !== 1) throw new Refused('say one of: --reason "<why>" (give it), --revoke (take it back), --show (read it).');
  if (reason !== null && !/\S/.test(reason)) throw new Refused("--reason says why, in a few words: it's kept with the grant and shown in the account's own export.");
  if (reason !== null && reason.length > 200) throw new Refused("--reason is a few words (200 characters at most).");
  const place = placeOf(where);
  const [[account]] = run(place, `SELECT deleted_at FROM users WHERE id = ${quote(user)}`);
  if (!account) throw new Refused("no account has that id there. Nothing was written.");
  if (account.deleted_at) throw new Refused("that account is deleted. Nothing was written.");
  const holdsSql = `SELECT granted_at, revoked_at FROM plan_grants WHERE user_id = ${quote(user)}`;
  if (show) {
    const [[g]] = run(place, holdsSql);
    const holds = Boolean(g && !g.revoked_at);
    return { done: false, holds, line: holds ? `the plan is given to that account (since ${new Date(g.granted_at * 1000).toISOString().slice(0, 10)})` : "that account has no grant" };
  }
  if (revoke) {
    const [[was]] = run(place, holdsSql);
    if (!was || was.revoked_at) return { done: false, holds: false, line: "that account had no grant: nothing to take back" };
    run(place, `UPDATE plan_grants SET revoked_at = ${now} WHERE user_id = ${quote(user)} AND revoked_at IS NULL`);
    const [[g]] = run(place, holdsSql);
    if (!g?.revoked_at) throw new Refused("the grant didn't read back as taken back: look before trusting it.");
    return { done: true, holds: false, line: "taken back: the plan is no longer given to that account" };
  }
  run(place, `INSERT INTO plan_grants (user_id, granted_at, reason, revoked_at) VALUES (${quote(user)}, ${now}, ${quote(reason.trim())}, NULL)
    ON CONFLICT(user_id) DO UPDATE SET granted_at = excluded.granted_at, reason = excluded.reason, revoked_at = NULL`);
  const [[g]] = run(place, holdsSql);
  if (!g || g.revoked_at) throw new Refused("the grant didn't read back as holding: look before trusting it.");
  return { done: true, holds: true, line: "given: that account has the plan (its room, and the assistant on the trips it hosts), nothing charged" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv.splice(i, 2)[1] ?? ""; };
  const has = (n) => { const i = argv.indexOf(n); if (i < 0) return false; argv.splice(i, 1); return true; };
  const o = {
    user: flag("--user"), reason: flag("--reason"), revoke: has("--revoke"), show: has("--show"),
    persistTo: flag("--persist-to"), config: flag("--config"), productionDatabase: flag("--production-database"),
    local: has("--local"), remote: has("--remote"),
  };
  if (argv.length) {
    console.error(`not taken: ${argv.join(" ")}\nusage: node tools/plan-grant.mjs --user <account id> (--reason "<why>" | --revoke | --show) (--local --persist-to <dir> | --remote --production-database <name>)`);
    process.exit(2);
  }
  try { console.log(planGrant(o).line); } catch (error) { console.error(error instanceof Refused ? error.message : error); process.exit(2); }
}

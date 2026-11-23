#!/usr/bin/env node
// A one-use sign-in link for one person whose passkey won't sign them in, made by the site's
// operator and handed to them over a channel already trusted (src/accounts/link.js uses it).
//
//   node tools/signin-link.mjs --trip <trip id> --name "<their name>"  <where> [--hours 2]
//   node tools/signin-link.mjs --account <account id or username> [--trip <trip id>]  <where> [--hours 2]
//
// <where> is one of:
//   --local --persist-to <dir> [--config <file>]   a local database (a check, the rehearsal)
//   --remote --production-database <name>          the site's own database. <name> must be the D1
//                                                  database_name in the production config, typed out:
//                                                  a command line copied from a check (which has
//                                                  --local) can't write to production by a slip.
//                                                  --remote reads only the production config, as the
//                                                  deploy does: wrangler.production.jsonc at the
//                                                  checkout's root (the tree's wrangler.jsonc carries
//                                                  placeholder ids), never --config.
//
// The person is a member of the trip now (not one who left), on an account not deleted, whose name
// is the one given (spaces and capitals aside). With nobody of that name, or two, nothing is
// written and it says so; two are told apart with --account.
//
// It files the link itself (only the token's sha256, in signin_links) and prints two lines, nothing
// else: the link, at the site's address from the Worker's own settings (vars.PUBLIC_ORIGIN, never
// typed), and when it stops working. The link works once: the button on the page it opens signs
// that person in. The token is kept nowhere: a lost link is replaced by making another.
//
// makeLink() is the same link without the filing, for checks that file its SQL themselves.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE_CONFIG = path.join(ROOT, "wrangler.jsonc");
// The production config a deploy copies to the checkout's root (`wrangler deploy -c wrangler.production.jsonc`); a check
// names its own stand-in for it.
const PRODUCTION_CONFIG = process.env.WGP_SIGNIN_LINK_PRODUCTION_CONFIG || path.join(ROOT, "wrangler.production.jsonc");
// A check stands a recorder in for wrangler to see the command a production run would send.
const WRANGLER = process.env.WGP_SIGNIN_LINK_WRANGLER || path.join(ROOT, "node_modules/.bin/wrangler");
const DEFAULT_HOURS = 2;

/** A refusal in words: nothing was written. */
export class Refused extends Error {}

/**
 * The link and the SQL that files it, nothing filed.
 * @param {object} o
 * @param {string} o.who     the account's id, or the username of an account from before open sign-up
 * @param {string} o.origin  the site's address
 * @param {number} [o.hours] how long the link works (1 to 168)
 * @param {number} [o.now]   seconds
 * @returns {{ url: string, sql: string, expiresAt: number, hash: string }}
 */
export function makeLink({ who, origin, hours = 24, now = Math.floor(Date.now() / 1000) }) {
  if (typeof who !== "string" || !/^[\w .@-]{1,64}$/.test(who)) throw new Refused("the account's id or username: letters, digits, spaces and _ . @ - only");
  let site;
  try { site = new URL(origin); } catch { throw new Refused(`not an address: ${origin}`); }
  if (site.protocol !== "https:" && site.hostname !== "localhost") throw new Refused("the site's address must be https (or localhost)");
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new Refused("--hours: 1 to 168");
  const token = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = now + Math.round(hours * 3600);
  const sql = `INSERT INTO signin_links (token_hash, user_id, created_at, expires_at) `
    + `SELECT '${hash}', id, ${now}, ${expiresAt} FROM users WHERE (id = '${who}' OR username = '${who.toLowerCase()}') AND deleted_at IS NULL;`;
  return { url: `${site.origin}/login/link/${token}`, sql, expiresAt, hash };
}

const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
const fold = (name) => String(name ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
const day = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

/**
 * Where the link is filed: the database, its settings, and the site's address from them.
 * Refuses, writing nothing, unless the place is said in full.
 */
export function placeOf({ local = false, remote = false, persistTo = null, config = null, productionDatabase = null }) {
  if (local === remote) throw new Refused("say where the link is filed: --local --persist-to <dir>, or --remote --production-database <name>.");
  if (remote && config) throw new Refused("--remote reads the site's own settings (the production config) and takes no --config.");
  if (local && !persistTo) throw new Refused("--local needs --persist-to <dir>: the database it writes is named, never assumed.");
  if (local && productionDatabase) throw new Refused("--production-database goes with --remote only.");
  const file = remote ? PRODUCTION_CONFIG : path.resolve(config ?? SITE_CONFIG);
  if (remote && !fs.existsSync(file)) {
    throw new Refused(`--remote reads the production config, and there is none at ${file}: copy it there as for a deploy. Nothing was written.`);
  }
  let settings;
  try { settings = parseJsonc(fs.readFileSync(file, "utf8")); } catch (error) { throw new Refused(`can't read the settings at ${file}: ${error.message}`); }
  const bound = (settings.d1_databases ?? []).find((d) => d.binding === "DB");
  const database = bound?.database_name;
  if (!database) throw new Refused(`${file} binds no database as DB.`);
  if (remote && /^[0-]*$/.test(String(bound.database_id ?? ""))) {
    throw new Refused(`${file} names no real database (its database_id is a placeholder): that's the tree's config, not the production one. Nothing was written.`);
  }
  if (remote && productionDatabase !== database) {
    throw new Refused(productionDatabase == null
      ? `--remote writes to the site's own database: say its name too (--production-database ${database}). Nothing was written.`
      : `--production-database "${productionDatabase}" isn't the site's database (${path.basename(file)} names "${database}"). Nothing was written.`);
  }
  const origin = settings.vars?.PUBLIC_ORIGIN;
  if (!origin) throw new Refused(`${file} sets no vars.PUBLIC_ORIGIN, the site's address the link is for.`);
  const where = remote ? ["--remote", "--yes"] : ["--local", "--persist-to", path.resolve(persistTo)];
  return { file, database, origin, where, remote };
}

/** Runs SQL there and returns each statement's rows. The token's hash never reaches the output. */
function run(place, sql, hide = null) {
  const r = spawnSync(WRANGLER, ["d1", "execute", place.database, ...place.where, "--json", "--command", sql, "-c", place.file], {
    cwd: path.dirname(place.file), encoding: "utf8", maxBuffer: 16 << 20,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const said = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const clean = (text) => (hide ? text.split(hide).join("<the token's hash>") : text);
  if (r.status !== 0) throw new Refused(`wrangler couldn't run it (exit ${r.status}):\n${clean(said).trim().slice(-1500)}`);
  try {
    return JSON.parse(r.stdout.slice(r.stdout.indexOf("["))).map((s) => s.results ?? []);
  } catch {
    throw new Refused(`wrangler's answer wasn't the rows asked for:\n${clean(said).trim().slice(-800)}`);
  }
}

/** The one account the link is for: by trip and name, or by account (on the trip, if one is named). */
function whoFor(place, { trip, name, account }) {
  if (name != null && !trip) throw new Refused("--name needs --trip: a name is looked up among one trip's people.");
  if ((name == null) === (account == null)) throw new Refused("say who: --trip <id> --name \"<their name>\", or --account <id>.");
  if (trip != null && !/^[\w-]{1,64}$/.test(trip)) throw new Refused(`"${trip}" isn't a trip's id.`);
  if (account != null && !/^[\w .@-]{1,64}$/.test(account)) throw new Refused("the account's id or username: letters, digits, spaces and _ . @ - only.");
  if (name != null && (!fold(name) || name.length > 120 || /[\u0000-\u001f]/.test(name))) throw new Refused("--name: the person's name as the trip shows it.");

  if (trip == null) {
    const [found] = run(place, `SELECT id FROM users WHERE (id = ${quote(account)} OR username = ${quote(account.toLowerCase())}) AND deleted_at IS NULL`);
    if (found.length !== 1) throw new Refused(`No account "${account}" that can sign in. Nothing was written.`);
    return found[0].id;
  }
  const [trips, people] = run(place,
    `SELECT name FROM trips WHERE id = ${quote(trip)}; `
    + `SELECT u.id, u.name, m.joined_at FROM trip_members m JOIN users u ON u.id = m.user_id `
    + `WHERE m.trip_id = ${quote(trip)} AND m.left_at IS NULL AND u.deleted_at IS NULL ORDER BY m.joined_at, m.rowid`);
  if (trips.length !== 1) throw new Refused(`No trip has the id "${trip}". Nothing was written.`);
  const tripName = trips[0].name;
  if (account != null) {
    const one = people.find((p) => p.id === account);
    if (!one) throw new Refused(`Account "${account}" isn't one of the people on “${tripName}” now. Nothing was written.`);
    return one.id;
  }
  const matches = people.filter((p) => fold(p.name) === fold(name));
  if (matches.length === 0) {
    throw new Refused(`Nobody on “${tripName}” is called “${name}” now. Nothing was written. Its people: ${people.map((p) => `“${p.name}”`).join(", ") || "none"}.`);
  }
  if (matches.length > 1) {
    throw new Refused(`${matches.length} people on “${tripName}” are called “${name}”. Nothing was written. Name one by its account:\n`
      + matches.map((p) => `  --trip ${trip} --account ${p.id}    (joined ${day(p.joined_at)})`).join("\n"));
  }
  return matches[0].id;
}

/**
 * Makes and files one link for one person, and answers it.
 * @returns {Promise<{ url: string, expiresAt: number, userId: string }>}
 */
export async function fileLink({ trip = null, name = null, account = null, hours = DEFAULT_HOURS, now = Math.floor(Date.now() / 1000), ...where }) {
  const place = placeOf(where);
  const userId = whoFor(place, { trip, name, account });
  const link = makeLink({ who: userId, origin: place.origin, hours, now });
  // Filed only for the account found, and only while it still can sign in.
  const [filed] = run(place, `INSERT INTO signin_links (token_hash, user_id, created_at, expires_at) `
    + `SELECT '${link.hash}', id, ${now}, ${link.expiresAt} FROM users WHERE id = ${quote(userId)} AND deleted_at IS NULL RETURNING user_id`, link.hash);
  if (filed.length !== 1 || filed[0].user_id !== userId) throw new Refused("The link wasn't filed (the account changed while it was made). Nothing to send.");
  return { url: link.url, expiresAt: link.expiresAt, userId };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv.splice(i, 2)[1] ?? ""; };
  const has = (n) => { const i = argv.indexOf(n); if (i < 0) return false; argv.splice(i, 1); return true; };
  const o = {
    trip: flag("--trip"), name: flag("--name"), account: flag("--account"),
    persistTo: flag("--persist-to"), config: flag("--config"), productionDatabase: flag("--production-database"),
    hours: Number(flag("--hours") ?? DEFAULT_HOURS), local: has("--local"), remote: has("--remote"),
  };
  if (argv.length) {
    console.error(`not taken: ${argv.join(" ")}\nusage: node tools/signin-link.mjs --trip <id> --name "<their name>" (--local --persist-to <dir> | --remote --production-database <name>) [--hours ${DEFAULT_HOURS}]`);
    process.exit(2);
  }
  try {
    const link = await fileLink(o);
    const until = new Date(link.expiresAt * 1000);
    console.log(link.url);
    console.log(`It works once, until ${until.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} (${until.toISOString().slice(0, 16)}Z).`);
  } catch (error) {
    console.error(error instanceof Refused ? error.message : error);
    process.exit(2);
  }
}

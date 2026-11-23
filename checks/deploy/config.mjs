// The production deploy's config against the tree's wrangler.jsonc. The tree carries placeholder ids (a public tree
// names no account's database or store, and no site's own sign-in apps); the deploy uses a copy of the production
// config, which has the real ones (`wrangler deploy -c wrangler.production.jsonc`). Kept apart, the two could drift: a
// binding, a var, a limit or a cron added to wrangler.jsonc and not to the production copy would quietly not deploy.
// So, parsed, they must be the same in everything but exactly four values (the D1 database id, the OAuth store id, the
// Google and GitHub client ids) and the production-only vars, named one by one below: the plan's and the assistant's,
// which the live site sets and the public tree leaves empty.
//
//   node checks/deploy/config.mjs
//
// It holds:
//   1. the tree's D1 database_id and OAuth store id are the placeholders (all zeros), its client ids empty, and each
//      production-only var there and empty;
//   2. the production config's are real (not the placeholders), one database and one store, as the tree's;
//   3. everything else is identical: every binding, var, limit, route, trigger, flag and setting.
// The production config is private (checks/lib/private.mjs findDeployConfig): on a machine without it, this says so
// and that the rest was not read, and passes nothing it didn't read.
//
// PLANTED: DEPLOY_CONFIG_PLANT=drift reads the tree's file with one more var (red, naming it); =id with the real
// database id in the tree (red); =tree-sets the tree switching the plan on (red); =prod-sets the production config
// switching the plan on with its prices (green: those are the production's to set); =prod-binding the production
// config without the tree's AI binding (red, naming ai); =prod-limit without its FIND_LIMITER (red, naming ratelimits).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Report } from "../lib/person.mjs";
import { findDeployConfig } from "../lib/private.mjs";
import { parseJsonc } from "../../tools/jsonc.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLANT = process.env.DEPLOY_CONFIG_PLANT || "";
if (PLANT && !["drift", "id", "tree-sets", "prod-sets", "prod-binding", "prod-limit"].includes(PLANT)) throw new Error("DEPLOY_CONFIG_PLANT is drift, id, tree-sets, prod-sets, prod-binding or prod-limit");
const t = new Report("the production deploy's config against the tree's");

const tree = parseJsonc(fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8"));
const where = findDeployConfig(ROOT);
if (!where.found) {
  console.log(`  (not read: the production config isn't on this machine; looked in ${where.looked.length} places, ${where.looked[0]} …)`);
  t.ok("the tree's ids are the placeholders and its client ids empty", isPlaceholders(tree) && ["GOOGLE_CLIENT_ID", "GITHUB_CLIENT_ID"].every((v) => tree.vars?.[v] === ""), JSON.stringify(ids(tree)));
  process.exit(t.end());
}
const prod = parseJsonc(fs.readFileSync(where.found, "utf8"));
if (PLANT === "drift") tree.vars = { ...tree.vars, A_PLANTED_VAR: "x" };
if (PLANT === "tree-sets") tree.vars = { ...tree.vars, PLAN_ENABLED: "true" };
// prod-binding: the production config without a binding the tree has (21 Nov: v139's AI binding, missing there, would
// have dropped env.AI on a deploy); prod-limit: without one of the tree's rate limits (FIND_LIMITER). Each red, naming it.
if (PLANT === "prod-binding") delete prod.ai;
if (PLANT === "prod-limit") prod.ratelimits = prod.ratelimits.filter((r) => r.name !== "FIND_LIMITER");
if (PLANT === "prod-sets") prod.vars = { ...prod.vars, PLAN_ENABLED: "true", STRIPE_PRICE_MONTHLY: "price_planted_month", STRIPE_PRICE_YEARLY: "price_planted_year" };
const prodIds = ids(prod);
if (PLANT === "id") tree.d1_databases[0].database_id = prodIds.d1[0];

function ids(c) { return { d1: (c.d1_databases ?? []).map((d) => d.database_id), kv: (c.kv_namespaces ?? []).map((k) => k.id) }; }
function isPlaceholders(c) { const x = ids(c); return [...x.d1, ...x.kv].length > 0 && [...x.d1, ...x.kv].every((v) => /^[0-]+$/.test(String(v))); }
const CLIENT_IDS = ["GOOGLE_CLIENT_ID", "GITHUB_CLIENT_ID"];
// The vars the live site sets for itself and the public tree leaves empty: the plan's (src/billing/) and the
// assistant's (src/assistant/). By name, never by pattern: a new var is the same in both until it is added here.
const PRODUCTION_VARS = [
  "PLAN_ENABLED", "PLAN_SALES", "STRIPE_PRICE_MONTHLY", "STRIPE_PRICE_YEARLY", "STRIPE_PORTAL_CONFIGURATION", "STRIPE_AUTOMATIC_TAX",
  "PLAN_POOL_BYTES", "PLAN_AI_ALLOWANCE_MICRO",
  "ASSISTANT_ENABLED", "ASSISTANT_MODEL", "ASSISTANT_PRICE_INPUT", "ASSISTANT_PRICE_OUTPUT",
  "ASSISTANT_REASONING_EFFORT", "ASSISTANT_FALLBACK_MODEL", "ASSISTANT_FALLBACK_PRICE_INPUT", "ASSISTANT_FALLBACK_PRICE_OUTPUT",
  "ASSISTANT_FALLBACK_REASONING_EFFORT", "ASSISTANT_WEB_SEARCH", "ASSISTANT_WEB_SEARCH_MAX",
];
function withoutIds(c) {
  const copy = JSON.parse(JSON.stringify(c));
  for (const d of copy.d1_databases ?? []) delete d.database_id;
  for (const k of copy.kv_namespaces ?? []) delete k.id;
  for (const v of [...CLIENT_IDS, ...PRODUCTION_VARS]) if (copy.vars) delete copy.vars[v];
  return copy;
}
/** Every path where two values differ, as "a.b[2].c". */
function differences(a, b, at = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => differences(a[k], b[k], Array.isArray(a) ? `${at}[${k}]` : at ? `${at}.${k}` : k));
  }
  return [at || "(the whole file)"];
}

t.ok("the tree's D1 database id and OAuth store id are the placeholders", isPlaceholders(tree), JSON.stringify(ids(tree)));
t.ok("the tree's sign-in apps' client ids are empty (a site sets its own); the production config's are both there",
  CLIENT_IDS.every((v) => tree.vars?.[v] === "" && typeof prod.vars?.[v] === "string" && prod.vars[v].length > 0), CLIENT_IDS.map((v) => `${v}: tree ${tree.vars?.[v] === "" ? "empty" : "SET"}, production ${prod.vars?.[v] ? "set" : "EMPTY"}`).join("; "));
t.ok("the tree leaves each production-only var there and empty (the live site sets its own)",
  PRODUCTION_VARS.every((v) => tree.vars?.[v] === ""), PRODUCTION_VARS.filter((v) => tree.vars?.[v] !== "").map((v) => `${v}: ${tree.vars?.[v] === undefined ? "missing" : "set"}`).join("; "));
t.ok("the production config's are real: one database and one store, as the tree's, none a placeholder",
  prodIds.d1.length === ids(tree).d1.length && prodIds.kv.length === ids(tree).kv.length && [...prodIds.d1, ...prodIds.kv].every((v) => v && !/^[0-]+$/.test(String(v))),
  `${prodIds.d1.length} database(s), ${prodIds.kv.length} store(s)`);
const drift = differences(withoutIds(tree), withoutIds(prod));
t.ok("everything else is identical: every binding, var, limit, route, trigger, flag and setting", drift.length === 0, drift.slice(0, 8).join(" | "));
process.exit(t.end());

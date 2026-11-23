#!/usr/bin/env node
// Local state (wrangler dev's database and OAuth store, under .wrangler/state/v3) carried from one config's ids to
// another's. wrangler dev keeps each local D1 database and KV store in a file named for its id (its database_id, a
// store's id, or its binding's name when it has no id), so the same state under a config with other ids is a fresh,
// empty database. This renames the files, so a snapshot made under the old ids opens under the new ones.
//
//   node tools/local-state-carry.mjs <state folder> --from <the config it was made under> [--to <config>] [--dry-run]
//
// <state folder> is the --persist-to folder (the one holding v3/), or .wrangler/state. --to is this tree's
// wrangler.jsonc unless given. Stop every wrangler dev on that folder first: a file it holds open is refused. Nothing
// is overwritten: a store that already has a file under the new name is refused, named, and nothing moves. It prints
// what it moved (by binding, never an id).

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./jsonc.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The file name workerd gives an object named `name` in a namespace (its id from the name, as idFromName makes it). */
export function objectFile(uniqueKey, name) {
  const key = crypto.createHash("sha256").update(uniqueKey).digest();
  const a = crypto.createHmac("sha256", key).update(name).digest().subarray(0, 16);
  const b = crypto.createHmac("sha256", key).update(a).digest().subarray(0, 16);
  return `${Buffer.concat([a, b]).toString("hex")}.sqlite`;
}

/** Each local store a config names: { kind, binding, dir, file }. */
export function storesOf(config) {
  return [
    ...(config.d1_databases ?? []).map((d) => ({ kind: "D1 database", binding: d.binding, dir: "d1/miniflare-D1DatabaseObject",
      file: objectFile("miniflare-D1DatabaseObject", d.preview_database_id ?? d.database_id ?? d.binding) })),
    ...(config.kv_namespaces ?? []).map((k) => ({ kind: "KV store", binding: k.binding, dir: "kv/miniflare-KVNamespaceObject",
      file: objectFile("miniflare-KVNamespaceObject", k.preview_id ?? k.id ?? k.binding) })),
  ];
}

/** The moves from one config's stores to another's, by binding; throws in words when one can't be made. */
export function plan(state, from, to) {
  const v3 = fs.existsSync(path.join(state, "v3")) ? path.join(state, "v3") : state;
  if (!fs.existsSync(path.join(v3, "d1")) && !fs.existsSync(path.join(v3, "kv"))) throw new Error(`${state} holds no local state (no v3/d1 or v3/kv)`);
  const target = new Map(storesOf(to).map((s) => [`${s.kind}:${s.binding}`, s]));
  const moves = [];
  for (const s of storesOf(from)) {
    const t = target.get(`${s.kind}:${s.binding}`);
    if (!t) throw new Error(`the ${s.kind} ${s.binding} isn't in the config it goes to`);
    if (t.file === s.file) continue;
    const src = path.join(v3, s.dir, s.file), dst = path.join(v3, t.dir, t.file);
    if (!fs.existsSync(src)) { moves.push({ ...s, skip: "nothing there under the old name" }); continue; }
    if (fs.existsSync(dst)) throw new Error(`the ${s.kind} ${s.binding} already has a file under the new name: nothing moved (remove that one first if it's a fresh empty one)`);
    moves.push({ ...s, src, dst });
  }
  return moves;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv.splice(i, 2)[1]; };
  const fromFile = flag("--from"), toFile = flag("--to") ?? path.join(ROOT, "wrangler.jsonc"), dry = argv.includes("--dry-run");
  const state = argv.find((a) => !a.startsWith("--"));
  if (!state || !fromFile) { console.error("usage: node tools/local-state-carry.mjs <state folder> --from <config it was made under> [--to <config>] [--dry-run]"); process.exit(2); }
  try {
    const read = (f) => parseJsonc(fs.readFileSync(f, "utf8"));
    const moves = plan(path.resolve(state), read(fromFile), read(toFile));
    const real = moves.filter((m) => m.src);
    for (const m of real) {
      const open = spawnSync("lsof", ["-t", "--", m.src], { encoding: "utf8" }).stdout.trim();
      if (open) throw new Error(`the ${m.kind} ${m.binding} is open in a running process (pid ${open.split("\n").join(", ")}): stop its wrangler dev first; nothing moved`);
    }
    for (const m of moves) {
      if (m.skip) { console.log(`  ${m.kind} ${m.binding}: ${m.skip}`); continue; }
      if (!dry) for (const ext of ["", "-wal", "-shm"]) if (fs.existsSync(m.src + ext)) fs.renameSync(m.src + ext, m.dst + ext);
      console.log(`  ${m.kind} ${m.binding}: ${dry ? "would move" : "moved"} to the new config's name`);
    }
    if (!moves.length) console.log("  nothing to move: the two configs name each store alike");
  } catch (error) {
    console.error(`not moved: ${error.message}`);
    process.exit(1);
  }
}

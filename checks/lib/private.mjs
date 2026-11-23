// The first trip's own files, kept off the public tree: its seed, its sources, its stills and the scripts that made
// them, under the private folder beside this project (16-wegoplace/private/peru/, at their tree paths). A check that
// needs one finds it here, or refuses and names every place it looked; it never passes over its part without a word.
//
// The folder: WGP_PRIVATE (a path to the folder that holds seed/, docs/, scripts/ …), else the first
// 16-wegoplace/private/peru found walking up from this tree, or from the clone a worktree of it belongs to.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function gitCommonDir(root) {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Where a private file is: { found: its path or null, looked: [every place looked] }. `rel` is its tree path. */
export function findPrivate(root, rel, env = process.env) {
  const looked = [];
  if (env.WGP_PRIVATE) {
    const at = path.join(path.resolve(env.WGP_PRIVATE), rel);
    looked.push(at);
    return { found: fs.existsSync(at) ? at : null, looked };
  }
  const common = gitCommonDir(root);
  for (const start of [root, common && path.dirname(common)].filter(Boolean)) {
    for (let d = path.resolve(start); ; d = path.dirname(d)) {
      const at = path.join(d, "16-wegoplace", "private", "peru", rel);
      looked.push(at);
      if (fs.existsSync(at)) return { found: at, looked };
      if (path.dirname(d) === d) break;
    }
  }
  return { found: null, looked };
}

/**
 * Where the production deploy's config is (the real ids; wrangler.jsonc carries placeholders): WGP_DEPLOY_CONFIG, else
 * wrangler.production.jsonc in the first 16-wegoplace/private found walking up from this tree or its clone.
 * { found, looked }.
 */
export function findDeployConfig(root, env = process.env) {
  if (env.WGP_DEPLOY_CONFIG) { const at = path.resolve(env.WGP_DEPLOY_CONFIG); return { found: fs.existsSync(at) ? at : null, looked: [at] }; }
  const looked = [];
  const common = gitCommonDir(root);
  for (const start of [root, common && path.dirname(common)].filter(Boolean)) {
    for (let d = path.resolve(start); ; d = path.dirname(d)) {
      const at = path.join(d, "16-wegoplace", "private", "wrangler.production.jsonc");
      looked.push(at);
      if (fs.existsSync(at)) return { found: at, looked };
      if (path.dirname(d) === d) break;
    }
  }
  return { found: null, looked };
}

/** The words a check refuses with when a private file isn't there. */
export const notFound = (rel, looked) =>
  `the first trip's ${rel} isn't on this machine: it is private, kept outside the tree. Looked in ${looked.length === 1 ? looked[0] : `${looked.length} places (${looked[0]} … ${looked.at(-1)})`}. Set WGP_PRIVATE to the folder that holds it.`;

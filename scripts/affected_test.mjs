#!/usr/bin/env node
/* WHICH CHECKS A CHANGE PICKS (scripts/lib/affected.mjs, gate.mjs --affected). No browser, no server.
 *
 *   1. GLOBS: `**` any depth, `*` one folder, `{a,b}` either.
 *   2. A MADE-UP REPO, its answers known: a page loading a script, a module importing another (statically and by
 *      import("literal")), a stylesheet @importing one, four checks (one core, one undeclared, two declared) and the
 *      table that declares them. A change planted in one file picks EXACTLY its checks: the module two imports deep
 *      picks the check that declares the page; a file nothing reads picks only the core and the undeclared; a change
 *      to the gate picks every check; a check's own library picks that check.
 *   3. THIS REPO: one file of Packing changed picks the Packing checks and More (settings.js imports pack-count.js),
 *      the core and the undeclared, and leaves Split's and Photos' own checks out; every check HARNESSES.md declares
 *      is on the gate; gate.mjs --affected refuses no base, and --only beside it.
 *
 * Planted: AFFECTED_PLANT=shallow reads declared files without what they load (2: the deep module picks nothing);
 * AFFECTED_PLANT=nocore leaves the core out (2: a file nothing reads picks no core check).
 *
 *   node scripts/affected_test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as A from "./lib/affected.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLANT = process.env.AFFECTED_PLANT || "";
if (PLANT && !["shallow", "nocore"].includes(PLANT)) throw new Error(`no such plant: ${PLANT}`);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// The plants: the picker with closure() reading one level only, or with no core.
const pickWith = (root, names, changed, opts = {}) => {
  if (PLANT === "nocore") opts = { ...opts, core: [] };
  if (PLANT !== "shallow") return A.pick(root, names, changed, opts);
  const decl = opts.decl || A.declarations(root);
  const core = opts.core || A.CORE;
  return names.filter((n) => core.includes(n) || !decl.has(n) || changed.some((f) => decl.get(n).includes(f) || A.loads(root, `scripts/${n}`).includes(f)))
    .map((name) => ({ name }));
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-affected-"));
try {
  section("1. Globs");
  const g = (glob, file) => A.globRe(glob).test(file);
  check("public/** holds a file any depth down", g("public/**", "public/js/shared/x.js") && g("public/**", "public/a.html"));
  check("public/*.html holds a page, not one a folder down", g("public/*.html", "public/a.html") && !g("public/*.html", "public/x/a.html"));
  check("{a,b} is either", g("public/{css,ds}/**", "public/ds/a.css") && g("public/{css,ds}/**", "public/css/a.css") && !g("public/{css,ds}/**", "public/js/a.js"));
  check("src/**/*.js holds src/a.js and src/x/y/b.js, not src/c.json", g("src/**/*.js", "src/a.js") && g("src/**/*.js", "src/x/y/b.js") && !g("src/**/*.js", "src/c.json"));

  section("2. A made-up repo");
  const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), s); };
  put("public/page.html", '<link rel="stylesheet" href="/css/page.css"><script type="module">import { a } from "/js/a.js";</script>');
  put("public/css/page.css", '@import url("./base.css");');
  put("public/css/base.css", "body{}");
  put("public/js/a.js", 'import { b } from "./b.js";\nexport const a = () => import("./lazy.js");');
  put("public/js/b.js", "export const b = 1;");
  put("public/js/lazy.js", 'import { deep } from "./shared/deep.js";');
  put("public/js/shared/deep.js", "export const deep = 1;");
  put("public/js/alone.js", "export const x = 1;");
  put("scripts/lib/helper.mjs", "export const h = 1;");
  for (const c of ["core_check.mjs", "free_check.mjs", "page_check.mjs", "other_check.mjs"]) put(`scripts/${c}`, c === "page_check.mjs" ? 'import { h } from "./lib/helper.mjs";' : "");
  put("scripts/HARNESSES.md", "# x\n\n## What each check reads (gate.mjs --affected)\n\n| Check | Reads |\n|---|---|\n"
    + "| `core_check.mjs` | `art/**` |\n| `page_check.mjs` | `public/page.html` |\n| `other_check.mjs` | `public/js/alone.js`, `seed/**` |\n\n## Not checks\n");
  const names = ["core_check.mjs", "free_check.mjs", "page_check.mjs", "other_check.mjs"];
  const opts = { core: ["core_check.mjs"] };
  const picked = (...changed) => pickWith(tmp, names, changed, opts).map((p) => p.name);
  const d = A.declarations(tmp);
  check("the table is read: three checks, their reads", d.size === 3 && same(d.get("other_check.mjs"), ["public/js/alone.js", "seed/**"]), JSON.stringify([...d]));
  const pageReads = A.readsOf(tmp, "page_check.mjs", d.get("page_check.mjs")).files;
  check("a page counts with what it loads: its stylesheet and that one's @import, its inline module's import, and on down (a literal import() too)",
    ["public/css/page.css", "public/css/base.css", "public/js/a.js", "public/js/b.js", "public/js/lazy.js", "public/js/shared/deep.js"].every((f) => pageReads.has(f)), [...pageReads].join(" "));
  let p = picked("public/js/shared/deep.js");
  check("PLANTED: deep.js changed (three loads under the page) picks exactly the core, the undeclared and the page's check", same(p, ["core_check.mjs", "free_check.mjs", "page_check.mjs"]), p.join(" "));
  p = picked("public/css/base.css");
  check("base.css changed (the page's stylesheet's @import) picks the page's check too", same(p, ["core_check.mjs", "free_check.mjs", "page_check.mjs"]), p.join(" "));
  p = picked("seed/x.json");
  check("a file under a declared glob (seed/**) picks the check declaring it", same(p, ["core_check.mjs", "free_check.mjs", "other_check.mjs"]), p.join(" "));
  p = picked("docs/notes.md");
  check("PLANTED: a file nothing reads picks only the core (though its own row reads none of it) and the undeclared", same(p, ["core_check.mjs", "free_check.mjs"]), p.join(" "));
  p = picked("scripts/lib/helper.mjs");
  check("a check's own library changed picks that check", same(p, ["core_check.mjs", "free_check.mjs", "page_check.mjs"]), p.join(" "));
  p = picked("scripts/gate.mjs");
  check("the gate changed picks every check", same(p, names), p.join(" "));

  section("3. This repo");
  const gateNames = [...new Set(execFileSync(process.execPath, [path.join(REPO, "scripts/gate.mjs"), "--list"], { cwd: REPO, encoding: "utf8" }).trim().split("\n").map(A.nameOf))];
  const real = A.declarations(REPO);
  check("every check the table declares is on the gate", [...real.keys()].every((k) => gateNames.includes(k)), [...real.keys()].filter((k) => !gateNames.includes(k)).join(" "));
  check("every core check is on the gate", A.CORE.every((k) => gateNames.includes(k)), A.CORE.filter((k) => !gateNames.includes(k)).join(" "));
  const doc = pickWith(REPO, gateNames, ["docs/anything.md"]).map((x) => x.name);
  check("check:parity is core: it runs whatever changed (a docs file alone picks it)", A.CORE.includes("checks/parity/run.mjs") && doc.includes("checks/parity/run.mjs"), doc.join(" "));
  const pk = pickWith(REPO, gateNames, ["public/js/pack-count.js"]).map((x) => x.name);
  const want = ["pack_band_check.mjs", "pack_lists_check.mjs", "pack_today_check.mjs", "packing_ds_check.mjs", "more_check.mjs", ...A.CORE];
  const not = ["split_harness.mjs", "split_table_check.mjs", "settle_check.mjs", "collage_look_check.mjs", "photos_ds_check.mjs", "towns_check.mjs"];
  check("pack-count.js changed: Packing's checks, More (settings.js imports it) and the core run", want.every((n) => pk.includes(n)), want.filter((n) => !pk.includes(n)).join(" "));
  check("…and Split's, Photos' and the towns' own checks don't", not.every((n) => !pk.includes(n)), not.filter((n) => pk.includes(n)).join(" "));
  check(`…and fewer than the whole gate (${pk.length} of ${gateNames.length})`, pk.length < gateNames.length);
  const none = spawnSync(process.execPath, [path.join(REPO, "scripts/gate.mjs"), "--affected"], { cwd: REPO, encoding: "utf8" });
  check("gate.mjs --affected with no base: refused (exit 2)", none.status === 2 && /needs the base/.test(none.stderr), none.stderr.trim());
  const both = spawnSync(process.execPath, [path.join(REPO, "scripts/gate.mjs"), "--affected", "HEAD", "--only", "x"], { cwd: REPO, encoding: "utf8" });
  check("gate.mjs --affected beside --only: refused (exit 2)", both.status === 2 && /not both/.test(both.stderr), both.stderr.trim());
} catch (e) {
  fail++; failures.push(`threw: ${e.message}`); console.log(`  FAIL  threw: ${e.stack || e}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  FAILED  ${f}`); process.exit(1); }

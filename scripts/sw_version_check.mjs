#!/usr/bin/env node
/* A SHELL CHANGE MOVES THE WORKER'S VERSION (public/sw.js: "BUMP `VERSION` ON ANY SHELL CHANGE"). The shell is served
 * cache-first, so a phone that installed the app keeps exactly what it precached until the cache's name, VERSION,
 * changes. A landing that changes agenda.js and leaves VERSION where it was ships its fix to nobody who installed the
 * app (20 Nov: a landing of tabs.js, agenda.js and styles.css went to the gate at v121, the version already live).
 *
 *   1. THE RULE, on cases of its own: a shell file changed and VERSION the same is red; VERSION moved is green;
 *      nothing of the shell changed is green whatever VERSION does; a file outside public/ or a file of public/ the
 *      shell doesn't hold (a photograph, a town's list) isn't the shell; "/" is index.html.
 *   2. THIS TREE against the landing's base: every shell file that differs (committed or not) and the two VERSIONs.
 *      The shell: public/'s html, css, js and mjs (sw.js itself apart), and every path CORE or EXTRA precaches.
 *      The base: SW_BASE=<ref> if given, else where this tree leaves rework (git merge-base HEAD origin/rework, or
 *      rework). A tree that is rework itself has nothing of its own to judge, and says so.
 *
 *   3. EVERY PAGE NAMES THIS TREE'S BUILD: one <meta name="wgp-build"> in each public/*.html, equal to sw.js VERSION
 *      (one build per page: fresh-app.js and the worker compare it); and so does the MCP's serverInfo.version
 *      (src/build.js BUILD).
 *
 * Planted: SWVER_PLANT=pagebuild reads login.html as naming v1 (3 red). SWVER_PLANT=serverbuild reads src/build.js as v1 (1 red). SWVER_PLANT=stale reads this tree's VERSION as the base's (2 red wherever the shell changed: as if not
 * bumped); SWVER_PLANT=blind judges with a rule that never looks at VERSION (1's "changed, same VERSION" red).
 *
 *   node scripts/sw_version_check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLANT = process.env.SWVER_PLANT || "";
if (PLANT && !["stale", "blind", "pagebuild", "serverbuild"].includes(PLANT)) throw new Error(`no such plant: ${PLANT}`);
const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

const versionOf = (src) => { const m = /^const VERSION = "([^"]+)";/m.exec(src); if (!m) throw new Error("no VERSION in sw.js"); return m[1]; };
// What the worker precaches by name: CORE's and EXTRA's paths, as files under public/ ("/" is index.html).
const listed = (src) => {
  const out = new Set();
  for (const name of ["CORE", "EXTRA"]) {
    const m = new RegExp(`^const ${name} = \\[([\\s\\S]*?)^\\];`, "m").exec(src);
    if (!m) throw new Error(`no ${name} in sw.js`);
    for (const [, p] of m[1].matchAll(/^\s*"([^"]+)"/gm)) out.add(p === "/" ? "public/index.html" : `public${p.split("?")[0]}`);
  }
  return out;
};
const isShell = (file, precached) => file !== "public/sw.js" && file.startsWith("public/") && (/\.(html|css|m?js)$/.test(file) || precached.has(file));
// The rule: a shell file changed and VERSION where it was.
const stale = PLANT === "blind"
  ? (changed) => false
  : (changed, before, now) => changed.length > 0 && before === now;

try {
  section("1. The rule, on cases of its own");
  const pre = new Set(["public/index.html", "public/img/wordmark.svg"]);
  const judge = (files, before, now) => stale(files.filter((f) => isShell(f, pre)), before, now);
  check("a shell file changed, VERSION the same: red", judge(["public/js/agenda.js"], "v1", "v1") === true);
  check("a stylesheet changed, VERSION the same: red", judge(["public/styles.css"], "v1", "v1") === true);
  check("a precached picture changed (the wordmark), VERSION the same: red", judge(["public/img/wordmark.svg"], "v1", "v1") === true);
  check("\"/\" is index.html: it changed, VERSION the same: red", judge(["public/index.html"], "v1", "v1") === true);
  check("a shell file changed, VERSION moved: green", judge(["public/js/agenda.js", "public/sw.js"], "v1", "v2") === false);
  check("only sw.js changed: green", judge(["public/sw.js"], "v1", "v1") === false);
  check("nothing of public/ (a check, the server): green", judge(["scripts/bar_check.mjs", "src/index.js"], "v1", "v1") === false);
  check("a file of public/ the shell doesn't hold (a town's list, a photograph): green", judge(["public/towns/t-a.txt", "public/img/photo.jpg"], "v1", "v1") === false);

  section("2. This tree against the landing's base");
  let base = process.env.SW_BASE || "";
  if (!base) {
    for (const ref of ["origin/rework", "rework"]) { try { base = git("merge-base", "HEAD", ref); break; } catch {} }
  }
  if (!base) throw new Error("no base: neither origin/rework nor rework is here (set SW_BASE=<ref>)");
  const baseSha = git("rev-parse", base), headSha = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain", "--", "public").length > 0;
  if (baseSha === headSha && !dirty) {
    console.log(`  note  this tree is its base (${baseSha.slice(0, 7)}): nothing of its own to judge`);
  } else {
    const nowSrc = fs.readFileSync(path.join(REPO, "public/sw.js"), "utf8");
    const before = versionOf(git("show", `${baseSha}:public/sw.js`));
    const now = PLANT === "stale" ? before : versionOf(nowSrc);
    const precached = listed(nowSrc);
    const changed = git("diff", "--name-only", baseSha, "--", "public").split("\n").filter(Boolean)
      .concat(git("ls-files", "--others", "--exclude-standard", "--", "public").split("\n").filter(Boolean));
    const shell = [...new Set(changed)].filter((f) => isShell(f, precached));
    check(`against ${baseSha.slice(0, 7)}: ${shell.length ? `${shell.length} shell file${shell.length === 1 ? "" : "s"} changed, so VERSION has moved` : "no shell file changed"}`,
      !stale(shell, before, now), `VERSION ${before} -> ${now}; ${shell.slice(0, 12).join(", ")}${shell.length > 12 ? ", …" : ""}`);
  }

  // ONE BUILD PER PAGE (fresh-app.js, sw.js navigation()): a page names its build, and the worker and the page compare
  // it with the worker's VERSION. A page whose meta says another build would be refused by every worker of this tree.
  section("3. Every page names this tree's build");
  const swSrc = fs.readFileSync(path.join(REPO, "public/sw.js"), "utf8");
  const version = versionOf(swSrc);
  const pages = fs.readdirSync(path.join(REPO, "public")).filter((f) => f.endsWith(".html")).sort();
  const named = pages.map((f) => {
    let html = fs.readFileSync(path.join(REPO, "public", f), "utf8");
    if (PLANT === "pagebuild" && f === "login.html") html = html.replace(/(<meta name="wgp-build" content=")v\d+/, "$1v1");
    const head = html.indexOf("</head>");
    const all = [...html.matchAll(/<meta name="wgp-build" content="([^"]*)">/g)].filter((m) => head < 0 || m.index < head).map((m) => m[1]);
    return { f, all };
  });
  check(`every page of public/ (${pages.length}) has one build meta, in the head`, named.every((x) => x.all.length === 1),
    named.filter((x) => x.all.length !== 1).map((x) => `${x.f}: ${x.all.length}`).join(", ") || pages.join(", "));
  check(`each names this tree's VERSION (${version})`, named.every((x) => x.all[0] === version),
    named.filter((x) => x.all[0] !== version).map((x) => `${x.f}: ${x.all[0] ?? "none"}`).join(", ") || "all equal");
  // The MCP says the build as its serverInfo.version (src/build.js BUILD, src/mcp/server.js): the same word.
  let buildSrc = fs.readFileSync(path.join(REPO, "src/build.js"), "utf8");
  if (PLANT === "serverbuild") buildSrc = buildSrc.replace(/BUILD = "v\d+"/, 'BUILD = "v1"');
  const build = /export const BUILD = "([^"]+)";/.exec(buildSrc)?.[1];
  check(`the MCP's build (src/build.js BUILD) is this tree's VERSION (${version})`, build === version, `BUILD ${build ?? "not found"}`);
} catch (e) {
  fail++; failures.push(`threw: ${e.message}`); console.log(`  FAIL  threw: ${e.stack || e}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  FAILED  ${f}`); process.exit(1); }

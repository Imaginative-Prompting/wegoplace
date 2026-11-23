#!/usr/bin/env node
/* THE ICONS UNDER NAMES THAT CHANGE WITH THEM (tools/icon-names.mjs; 21 Nov: the old favicon still showed in places, from
 * caches keyed on URLs that never changed). No browser.
 *
 *   1. Each icon has its hashed copy in public/icons/, byte for byte the file the logo script writes, named by the first
 *      8 hex of its sha256; no other hashed copy is left there.
 *   2. Every page links the hashed favicon (and the apple-touch-icon, where it has one, the hashed 180), and no page, nor
 *      the guard, the manifest, the worker, its notifications, the server's own pages or the MCP server, names a bare
 *      /favicon.ico or /icons/icon-NNN.png, or a hashed name that isn't the current one.
 *   3. The server-made pages link it too (the sign-in consent page, a shared board), the worker precaches every hashed
 *      name, the manifest's icons are the hashed 192 and 512 while its own id and start stay as they were, and the MCP
 *      server names the hashed icons as its own.
 *   4. /favicon.ico stays at the root, the same new icon (browsers ask for it by name).
 *
 * Planted: ICONNAMES_PLANT=bare reads login.html with its favicon linked by the bare name (2 red);
 * ICONNAMES_PLANT=stale reads favicon.ico as a byte longer, as a new logo nobody re-named would be (1 and 2 red).
 *
 *   node scripts/icon_names_check.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ICONS, REFERRERS, hashOf, ROOT } from "../tools/icon-names.mjs";

const PLANT = process.env.ICONNAMES_PLANT || "";
if (PLANT && !["bare", "stale"].includes(PLANT)) throw new Error(`no such plant: ${PLANT}`);
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const read = (f) => {
  let t = fs.readFileSync(path.join(ROOT, f), "utf8");
  if (PLANT === "bare" && f === "public/login.html") t = t.replace(/href="\/icons\/favicon\.[0-9a-f]{8}\.ico"/, 'href="/favicon.ico"');
  return t;
};
const bytesOf = (f) => {
  const b = fs.readFileSync(path.join(ROOT, f));
  return PLANT === "stale" && f === "public/favicon.ico" ? Buffer.concat([b, Buffer.from([0])]) : b;
};

try {
  section("1. the hashed copies");
  const icons = ICONS.map((i) => { const bytes = bytesOf(i.file); return { ...i, bytes, url: `/icons/${i.stem}.${hashOf(bytes)}${i.ext}` }; });
  for (const i of icons) {
    const at = path.join(ROOT, "public", i.url);
    const same = fs.existsSync(at) && fs.readFileSync(at).equals(i.bytes);
    check(`${i.file} -> ${i.url}: there, byte for byte, named by its bytes`, same, same ? `${i.bytes.length} bytes` : fs.existsSync(at) ? "differs" : "missing");
  }
  const current = new Set(icons.map((i) => path.basename(i.url)));
  const stray = fs.readdirSync(path.join(ROOT, "public/icons")).filter((f) => /\.[0-9a-f]{8}\.(ico|png)$/.test(f) && !current.has(f));
  check("no other hashed copy is left in public/icons", stray.length === 0, stray.join(", ") || "none");

  section("2. every reference is the current hashed name");
  const files = REFERRERS();
  const wrong = [];
  for (const f of files) {
    const text = read(f);
    for (const i of icons) for (const m of text.matchAll(i.ref)) if (m[0] !== i.url) wrong.push(`${f}: ${m[0]}`);
  }
  check(`no bare or old icon name in the ${files.length} files that name icons`, wrong.length === 0, wrong.slice(0, 8).join("; ") || files.join(", "));
  const pages = files.filter((f) => /^public\/[^/]+\.html$/.test(f));
  const fav = icons[0].url, touch = icons[1].url;
  const linked = pages.map((f) => { const t = read(f); return { f, icon: [...t.matchAll(/<link rel="icon" href="([^"]+)"/g)].map((m) => m[1]), touch: [...t.matchAll(/<link rel="apple-touch-icon" href="([^"]+)"/g)].map((m) => m[1]) }; });
  check(`every page (${pages.length}) links the hashed favicon`, linked.every((x) => x.icon.length === 1 && x.icon[0] === fav), JSON.stringify(linked.filter((x) => !(x.icon.length === 1 && x.icon[0] === fav))));
  check("every apple-touch-icon is the hashed 180", linked.every((x) => x.touch.every((u) => u === touch)) && linked.some((x) => x.touch.length), JSON.stringify(linked.map((x) => [x.f, x.touch])));

  section("3. the server's pages, the worker, the manifest, the MCP server");
  for (const f of ["src/mcp/oauth.js", "src/share-page.js"]) check(`${f}'s page links the hashed favicon`, read(f).includes(`<link rel="icon" href="${fav}"`));
  const sw = read("public/sw.js");
  check("the worker precaches every hashed name", icons.every((i) => sw.includes(`"${i.url}",`)), icons.filter((i) => !sw.includes(`"${i.url}",`)).map((i) => i.url).join(", ") || "all");
  const man = JSON.parse(read("public/manifest.webmanifest"));
  check("the manifest's icons are the hashed 192 and 512", JSON.stringify(man.icons.map((i) => i.src).sort()) === JSON.stringify([icons[2].url, icons[3].url].sort()), JSON.stringify(man.icons));
  let base = "";
  for (const ref of ["origin/rework", "rework"]) { try { base = execFileSync("git", ["merge-base", "HEAD", ref], { cwd: ROOT, encoding: "utf8" }).trim(); break; } catch {} }
  if (base) {
    const was = JSON.parse(execFileSync("git", ["show", `${base}:public/manifest.webmanifest`], { cwd: ROOT, encoding: "utf8" }));
    check("the manifest's own id and start stay as they were (an installed app is tracked by them)", man.id === was.id && man.start_url === was.start_url && man.scope === was.scope,
      JSON.stringify({ id: man.id, start_url: man.start_url, scope: man.scope }));
  }
  const mcp = read("src/mcp/server.js");
  check("the MCP server names the hashed 192 and 512 as its own icons", mcp.includes(`/icons/${path.basename(icons[2].url)}`) && mcp.includes(`/icons/${path.basename(icons[3].url)}`) && /icons: iconsAt\(env\)/.test(mcp));

  section("4. the root favicon");
  const hashedFav = path.join(ROOT, "public", fav);
  check("/favicon.ico stays at the root, the same new icon", fs.existsSync(path.join(ROOT, "public/favicon.ico")) && fs.existsSync(hashedFav)
    && fs.readFileSync(hashedFav).equals(fs.readFileSync(path.join(ROOT, "public/favicon.ico"))), fs.existsSync(hashedFav) ? "" : `${fav} missing`);
} catch (e) {
  fail++; failures.push(`threw: ${e.message}`); console.log(`  FAIL  threw: ${e.stack || e}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  FAILED  ${f}`); process.exit(1); }

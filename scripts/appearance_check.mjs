#!/usr/bin/env node
/* APPEARANCE IS SYSTEM, LIGHT, DARK (flow 7). No browser: each page's own boot script, run as written.
 *   1. Every page that paints before its first frame (the app, Your trips, Your account, a trip's people, joining,
 *      sign-in, and the AI app consent page the server writes) runs its inline script here, for every value a phone
 *      may have stored ("light", "void", the retired "dark", "slate" and "linen", junk, nothing) on a light and on a
 *      dark phone. Light and Void are kept; Night and Slate read as Void, Linen as Light; anything else follows the
 *      phone. <html>'s data-lum, and the status bar's colour where the page sets one, follow. The script never
 *      writes what is stored (a retired look stays stored until the person picks again).
 *   2. More's Appearance offers exactly System, Light, Dark, and each is a look the shell's table has.
 *   3. Nothing comes back: no retired look or accent set has a rule in the app's stylesheets, and no page or module
 *      reads the retired accent ("wgp.accent").
 *
 *   node scripts/appearance_check.mjs
 *
 * PLANTED (APPEARANCE_PLANT=<name>; each changes only what this check reads, never a file):
 *   writeback  index.html's script stores the look it read      -> 1 red (the app)
 *   noretire   account.html's script has no retired mapping     -> 1 red (Your account)
 *   accent     styles.css carries an accent set again           -> 3 red
 *   menu       More offers a fourth look                         -> 2 red
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");

const PLANT = process.env.APPEARANCE_PLANT || "";
const PLANTS = ["writeback", "noretire", "accent", "menu"];
if (PLANT && !PLANTS.includes(PLANT)) throw new Error(`APPEARANCE_PLANT is one of ${PLANTS.join(", ")}`);
let planted = 0;
const plant = (name, text, from, to) => {
  if (PLANT !== name) return text;
  const out = text.replace(from, to);
  if (out !== text) planted++;
  return out;
};

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// The inline script that reads "wgp.theme", from a page's text.
function bootOf(text) {
  const all = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  return all.find((s) => s.includes('"wgp.theme"')) || null;
}

// Runs a boot script against a made-up page: what it sets, and whether it wrote anything.
function run(script, stored, dark) {
  const attrs = new Map();
  const meta = { content: "", setAttribute(k, v) { if (k === "content") this.content = v; } };
  const writes = [];
  const g = {
    document: {
      documentElement: {
        setAttribute: (k, v) => attrs.set(k, String(v)),
        getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
        removeAttribute: (k) => attrs.delete(k),
        hasAttribute: (k) => attrs.has(k),
      },
      querySelector: (sel) => (/theme-color/.test(sel) ? meta : null),
    },
    localStorage: {
      getItem: (k) => (k === "wgp.theme" ? stored : null),
      setItem: (k, v) => writes.push(`${k}=${v}`),
      removeItem: (k) => writes.push(`-${k}`),
    },
    matchMedia: () => ({ matches: dark, addEventListener() {}, addListener() {} }),
  };
  g.window = g;
  vm.runInNewContext(script, g, { timeout: 1000 });
  return { theme: attrs.get("data-theme") ?? null, lum: attrs.get("data-lum") ?? null, bar: meta.content || null, writes };
}

section("1. each page's boot script");
const PAGES = [
  ["the app", "public/index.html"],
  ["Your trips", "public/trips.html"],
  ["Your account", "public/account.html"],
  ["a trip's people", "public/trip-people.html"],
  ["joining", "public/join.html"],
  ["sign-in", "public/login.html"],
  ["the AI app consent page", "src/mcp/oauth.js"],
];
const BAR = { light: "#fdfdfc", void: "#000000" };
// stored -> the look it is read as (null: follow the phone)
const READS = [["light", "light"], ["void", "void"], ["dark", "void"], ["slate", "void"], ["linen", "light"], ["sepia", null], [null, null]];
for (const [name, file] of PAGES) {
  let text = read(file);
  text = plant("writeback", file.endsWith("index.html") ? text : "", /if \(t\) root\.setAttribute\("data-theme", t\);/, 'if (t) { root.setAttribute("data-theme", t); localStorage.setItem("wgp.theme", t); }') || text;
  text = plant("noretire", file.endsWith("account.html") ? text : "", /\n  if \(RETIRED\[t\]\) t = RETIRED\[t\];/, "") || text;
  const script = bootOf(text);
  if (!script) { check(`${name}: has a boot script that reads the stored look`, false, file); continue; }
  const wrong = [];
  let bars = 0;
  for (const [stored, look] of READS) {
    for (const dark of [false, true]) {
      let got;
      try { got = run(script, stored, dark); } catch (e) { wrong.push(`${stored}/${dark ? "dark" : "light"} threw ${e.message}`); continue; }
      const shown = look || (dark ? "void" : "light");
      const lum = shown === "void" ? "dark" : "light";
      const say = `${stored}/${dark ? "dark phone" : "light phone"}`;
      if (got.theme !== look) wrong.push(`${say}: data-theme ${got.theme}, wanted ${look}`);
      if (got.lum !== lum) wrong.push(`${say}: data-lum ${got.lum}, wanted ${lum}`);
      if (got.bar) { bars++; if (got.bar !== BAR[shown]) wrong.push(`${say}: theme-color ${got.bar}, wanted ${BAR[shown]}`); }
      if (got.writes.length) wrong.push(`${say}: wrote ${got.writes.join(", ")}`);
    }
  }
  check(`${name}: light and void kept, night and slate read as Dark, linen as Light, else the phone's; nothing written${bars ? "; the status bar follows" : ""}`,
    wrong.length === 0, wrong.slice(0, 4).join(" | "));
}

section("2. More's Appearance");
{
  let settings = read("public/js/settings.js");
  settings = plant("menu", settings, /\["void", "Dark"\]\];/, '["void", "Dark"], ["dark", "Night"]];');
  const m = settings.match(/const APPEARANCE = (\[[^\n]*\]);/);
  let offered = null;
  try { offered = m ? JSON.parse(m[1]) : null; } catch { offered = null; }
  check("More offers System, Light, Dark, in that order", JSON.stringify(offered) === JSON.stringify([["system", "System"], ["light", "Light"], ["void", "Dark"]]), JSON.stringify(offered));
  const table = bootOf(read("public/index.html")).match(/var THEMES = \{([\s\S]*?)\n  \};/);
  const ids = table ? [...table[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]) : [];
  check("each look More offers is one the shell's table has (or System)", !!offered && offered.every(([mode]) => mode === "system" || ids.includes(mode)) && ids.length === 2,
    `offered ${JSON.stringify(offered && offered.map((o) => o[0]))}, table ${JSON.stringify(ids)}`);
}

section("3. nothing retired comes back");
{
  let css = read("public/styles.css");
  css = plant("accent", css, /\n\/\* ── base ──/, '\n:root[data-accent="teal"] { --accent: #0f6f7a; }\n:root[data-theme="slate"] { --ground: #101216; }\n/* ── base ──');
  const ds = fs.readdirSync(path.join(REPO, "public/ds")).filter((f) => f.endsWith(".css")).map((f) => read(`public/ds/${f}`)).join("\n");
  const rules = (text, re) => [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(re)].map((x) => x[0]);
  const accents = rules(css + ds, /\[data-accent[^\]]*\]/g);
  check("no accent set has a rule in styles.css or the system's", accents.length === 0, accents.slice(0, 3).join(", "));
  const retired = rules(css + ds, /\[data-theme="(dark|slate|linen)"\]/g);
  check("no retired look (Night, Slate, Linen) has a rule in styles.css or the system's", retired.length === 0, retired.slice(0, 3).join(", "));
  const readers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!["vendor", "logo", "img", "towns", "fonts"].includes(e.name)) walk(p); continue; }
      if (!/\.(js|mjs|html|css)$/.test(e.name)) continue;
      let text = read(p);
      if (p === "public/styles.css") text = css;
      if (/wgp\.accent|data-accent/.test(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))) readers.push(p);
    }
  };
  walk("public");
  walk("src");
  check("no page, module or stylesheet reads the retired accent", readers.length === 0, readers.join(", "));
}

if (PLANT && !planted) { console.log(`\nError: the ${PLANT} plant changed nothing`); process.exit(1); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }

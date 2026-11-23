#!/usr/bin/env node
/* The wordmark, the mark, the app icon and the favicon, and the heading face's file: what the site
 * serves is what art/make_logo.py draws, and everything that names them finds them.
 *
 *   node scripts/logo_check.mjs          (on the gate: node scripts/gate.mjs --only logo_check)
 *
 * No browser. It needs python3 and rsvg-convert, as the generator does. It holds:
 *   1. DRAWN BY THE GENERATOR: art/make_logo.py --site <a temporary folder> writes, byte for byte, the
 *      public/ copies of img/wordmark.svg, img/mark.svg, img/icon.svg, icons/icon-512.png,
 *      icon-192.png, icon-180.png, favicon.ico and logo/wordmark-data.json. A hand-edited or stale file is red.
 *   2. IN THE LOGO'S OWN COLOURS: the wordmark and the mark have no ground, and every stroke and fill is
 *      var(--logo-<part>, <void's colour>) or none, so a page sets them (the paper version in the light,
 *      void's in the dark, never the accent), and the gap that lifts a hiker off a letter is the page's
 *      ground. ds/tokens.css sets all six for the light and the dark, on :root.
 *   3. THE SIZES SAID ARE THE SIZES DRAWN: the icons' PNG headers (512, 192, 180), the favicon's
 *      entries (16, 32, 48), the manifest's icons, and each page's apple-touch-icon (the 180 under its current
 *      name, said as 180x180). The icons are linked by names made from their bytes (tools/icon-names.mjs, held by
 *      scripts/icon_names_check.mjs); this reads the current names from it.
 *   4. FOUND OFFLINE: sw.js precaches the wordmark, the mark (the rail's on a tablet), the three icons and the favicon
 *      under their current names, and the heading
 *      face's file; every font file a page preloads or styles.css's @font-face loads exists, and
 *      sw.js lists no font file that doesn't.
 *   5. THE MOVING WORDMARK: logo/idle-60.json is a "wegoplace-hikers-loop" v1 that loops, and its
 *      void and paper colours are the generator's (so the moving wordmark is the still one's colours);
 *      js/hikers-player.js draws every one of its frames in both; only the sign-in page's start-up
 *      (initLoginPage in js/auth.js) loads js/logo-player.js, and only that loads the player.
 *
 * PLANTED (LOGO_PLANT=<name>, each changes only what this check reads, never a file):
 *   stale    the wordmark read with one coordinate moved: 1 red (1).
 *   literal  the wordmark read with a hiker's limb in a literal colour: 1 red (2).
 *   nopack   ds/tokens.css read without the dark's --logo-pack: 1 red (2).
 *   apple    a page read with its apple-touch-icon on the 192 (its current name): 1 red (3).
 *   oldfont  sw.js read listing the old Fraunces file: 2 red (4: a file that isn't there, and the
 *            heading face's file not precached).
 *   palette  the loop read with paper's letters in another colour: 1 red (5).
 *   elsewhere  js/trips.js read loading the player too: 1 red (5).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ICONS, hashOf } from "../tools/icon-names.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(REPO, "public");
// Each icon's current name, /icons/<stem>.<the first 8 hex of its sha256><ext>, as tools/icon-names.mjs makes it.
const NAMED = Object.fromEntries(ICONS.map((i) => [i.stem, `/icons/${i.stem}.${hashOf(fs.readFileSync(path.join(REPO, i.file)))}${i.ext}`]));
const PLANT = process.env.LOGO_PLANT || "";
const PLANTS = ["stale", "literal", "nopack", "apple", "oldfont", "palette", "elsewhere"];
if (PLANT && !PLANTS.includes(PLANT)) throw new Error(`LOGO_PLANT is one of ${PLANTS.join(", ")}`);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// What this check reads, with a plant put in on the way.
const planted = new Set();
function read(rel, enc) {
  let buf = fs.readFileSync(path.join(PUB, rel));
  if (enc === null) {
    if (PLANT === "stale" && rel === "img/wordmark.svg") {
      const t = buf.toString("utf8"), n = t.replace(/ d="M(\d)/, ' d="M1$1');
      if (n !== t) planted.add(PLANT);
      buf = Buffer.from(n, "utf8");
    }
    return buf;
  }
  let t = buf.toString("utf8");
  const put = (from, to) => { const n = t.replace(from, to); if (n !== t) planted.add(PLANT); t = n; };
  if (PLANT === "stale" && rel === "img/wordmark.svg") put(/ d="M(\d)/, ' d="M1$1');
  if (PLANT === "literal" && rel === "img/wordmark.svg") put(/stroke="var\(--logo-figure, #[0-9A-Fa-f]{6}\)"/, 'stroke="#FF8A3D"');
  if (PLANT === "nopack" && rel === "ds/tokens.css") put(/(:root\[data-lum="dark"\] \{[^}]*?) --logo-pack: [^;]*;/, "$1");
  if (PLANT === "apple" && rel === "login.html") put(`href="${NAMED["icon-180"]}" sizes="180x180"`, `href="${NAMED["icon-192"]}"`);
  if (PLANT === "palette" && rel === "logo/idle-60.json") put('"letter":"#1B2748"', '"letter":"#1B2749"');
  if (PLANT === "elsewhere" && rel === "js/trips.js") put(/$/, '\nimport("./logo-player.js");\n');
  if (PLANT === "oldfont" && rel === "sw.js") put("/vendor/fonts/bricolage-grotesque-latin-opsz-normal.woff2", "/vendor/fonts/fraunces-latin-standard-normal.woff2");
  return t;
}

const SITE = ["img/wordmark.svg", "img/mark.svg", "img/icon.svg", "icons/icon-512.png", "icons/icon-192.png",
  "icons/icon-180.png", "favicon.ico", "logo/wordmark-data.json"];

section("1. Drawn by the generator");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-logo-"));
try {
  let made = true;
  try { execFileSync("python3", [path.join(REPO, "art", "make_logo.py"), "--site", tmp], { stdio: "pipe" }); }
  catch (e) { made = false; check("art/make_logo.py runs", false, String(e.stderr || e.message).slice(0, 500)); }
  if (made) for (const rel of SITE) {
    const want = fs.readFileSync(path.join(tmp, rel));
    const have = read(rel, null);
    check(`public/${rel} is what the generator draws`, Buffer.compare(want, have) === 0,
      `${have.length} bytes here, ${want.length} drawn`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

section("2. In the logo's own colours");
const PAINT = /^(var\(--logo-(ground|letter|figure|shade|pack|rope), #[0-9A-Fa-f]{6}\)|none)$/;
for (const rel of ["img/wordmark.svg", "img/mark.svg"]) {
  const t = read(rel);
  const paints = [...t.matchAll(/\b(?:stroke|fill)="([^"]*)"/g)].map((m) => m[1]);
  const off = [...new Set(paints.filter((p) => !PAINT.test(p)))];
  check(`${rel}: every stroke and fill is one of the logo's own colours (${paints.length} read)`,
    paints.length > 20 && off.length === 0, off.join(", ") || "");
  check(`${rel}: no ground drawn under it`, !/<rect[^>]*width="[^"]*"[^>]*height="[^"]*"[^>]*fill="#/.test(t.split('<g id="figures">')[0]));
}
{
  const css = read("ds/tokens.css");
  const PARTS = ["letter", "figure", "shade", "pack", "rope"];
  const light = (css.match(/^:root \{ --logo-ground:[^}]*\}/m) || [""])[0], dark = (css.match(/^:root\[data-lum="dark"\] \{ --logo-ground:[^}]*\}/m) || [""])[0];
  const lack = [...PARTS.filter((p) => !light.includes(`--logo-${p}:`)).map((p) => `light ${p}`), ...PARTS.filter((p) => !dark.includes(`--logo-${p}:`)).map((p) => `dark ${p}`)];
  check("ds/tokens.css: the logo's five colours for the light and for the dark, and its ground the page's", lack.length === 0 && light.includes("--logo-ground: var(--ground") && dark.includes("--logo-ground: var(--ground"), lack.join(", "));
}

section("3. The sizes said are the sizes drawn");
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];
for (const [rel, px] of [["icons/icon-512.png", 512], ["icons/icon-192.png", 192], ["icons/icon-180.png", 180]]) {
  const [w, h] = pngSize(read(rel, null));
  check(`${rel} is ${px} x ${px}`, w === px && h === px, `${w} x ${h}`);
}
{
  const ico = read("favicon.ico", null);
  const n = ico.readUInt16LE(4);
  const sizes = Array.from({ length: n }, (_, i) => ico[6 + 16 * i] || 256).sort((a, b) => a - b);
  check("favicon.ico holds 16, 32 and 48", sizes.join(",") === "16,32,48", sizes.join(","));
}
{
  const man = JSON.parse(read("manifest.webmanifest"));
  const bad = man.icons.filter((i) => {
    const f = path.join(PUB, i.src);
    if (!fs.existsSync(f)) return true;
    const [w, h] = pngSize(fs.readFileSync(f));
    return i.sizes !== `${w}x${h}`;
  });
  check(`manifest.webmanifest: its ${man.icons.length} icons exist at the sizes it says`, man.icons.length >= 2 && !bad.length,
    bad.map((i) => i.src).join(", "));
}
{
  const pages = fs.readdirSync(PUB).filter((f) => f.endsWith(".html"));
  const touch = pages.map((f) => [f, (read(f).match(/<link rel="apple-touch-icon"[^>]*>/) || [""])[0]]).filter(([, l]) => l);
  const wrong = touch.filter(([, l]) => !l.includes(`href="${NAMED["icon-180"]}" sizes="180x180"`)).map(([f]) => f);
  check(`the ${touch.length} pages with an apple-touch-icon name the 180 (${NAMED["icon-180"]}), as 180x180`, touch.length >= 5 && !wrong.length, wrong.join(", "));
}

section("4. Found offline");
const sw = read("sw.js");
const listed = new Set([...sw.matchAll(/^\s*"(\/[^"]+)",/gm)].map((m) => m[1]));
for (const url of ["/img/wordmark.svg", "/img/mark.svg", NAMED["icon-180"], NAMED["icon-192"], NAMED["icon-512"], NAMED.favicon])
  check(`sw.js precaches ${url}`, listed.has(url) && fs.existsSync(path.join(PUB, url)));
{
  const css = read("styles.css");
  const faces = [...css.matchAll(/url\('(\/vendor\/fonts\/[^']+)'\)/g)].map((m) => m[1]);
  const display = (css.match(/--font-display:\s*'([^']+)'/) || [])[1];
  const face = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1])
    .find((b) => b.includes(`font-family: '${display}';`));
  const file = face && (face.match(/url\('([^']+)'\)/) || [])[1];
  check(`the heading face (--font-display, '${display}') loads a file that exists`, !!file && fs.existsSync(path.join(PUB, file)), file);
  check("sw.js precaches the heading face's file", !!file && listed.has(file), file);
  const preload = fs.readdirSync(PUB).filter((f) => f.endsWith(".html"))
    .flatMap((f) => [...read(f).matchAll(/<link rel="preload" href="([^"]+\.woff2)"/g)].map((m) => m[1]));
  const lost = [...new Set([...faces, ...preload])].filter((u) => !fs.existsSync(path.join(PUB, u)));
  check(`every font a page preloads or styles.css loads exists (${new Set([...faces, ...preload]).size})`, !lost.length, lost.join(", "));
  const swFonts = [...listed].filter((u) => u.startsWith("/vendor/fonts/"));
  const gone = swFonts.filter((u) => !fs.existsSync(path.join(PUB, u)));
  check(`sw.js lists no font file that isn't there (${swFonts.length} listed)`, !gone.length, gone.join(", "));
}

section("5. The moving wordmark");
{
  const loop = JSON.parse(read("logo/idle-60.json"));
  check("logo/idle-60.json is a wegoplace-hikers-loop v1 that loops", loop.format === "wegoplace-hikers-loop" && loop.version === 1 && loop.loops === true && loop.frames > 0 && loop.fps > 0,
    `${loop.format} v${loop.version}, ${loop.frames} frames at ${loop.fps}`);
  const gen = read(path.relative(PUB, path.join(REPO, "art", "make_logo.py")));
  const palette = (name) => {
    const m = gen.match(new RegExp(`^\\s*"${name}": \\{([^}]*)\\}`, "m"));
    return m ? Object.fromEntries([...m[1].matchAll(/"(\w+)": "(#[0-9A-Fa-f]{6})"/g)].map((x) => [x[1], x[2].toLowerCase()])) : null;
  };
  for (const name of ["void", "paper"]) {
    const P = palette(name), C = loop.colorways?.[name];
    const lc = (v) => String(v).toLowerCase();
    const off = !P || !C ? ["missing"] : [
      ...["ground", "letter", "rope"].filter((k) => lc(C[k]) !== P[k]),
      ...(lc(C.pole) !== P.rope ? ["pole"] : []), ...(lc(C.flag) !== P.pack ? ["flag"] : []), ...(lc(C.binoculars) !== P.pack ? ["binoculars"] : []),
      ...C.hikers.flatMap((h, i) => ["figure", "shade", "pack"].filter((k) => lc(h[k]) !== P[k]).map((k) => `hiker ${i} ${k}`)),
    ];
    check(`the loop's ${name} colours are the generator's ${name}`, off.length === 0, off.join(", "));
  }
  const { drawFrame } = await import(path.join(PUB, "js", "hikers-player.js"));
  const word = JSON.parse(read("logo/wordmark-data.json"));
  let drawn = 0, broken = "";
  for (const cw of ["void", "paper"]) for (let k = 0; k < loop.frames; k++) {
    try {
      const svg = drawFrame(loop, k, { letters: word.letters, counters: word.counters, colorway: cw, mode: "mask", id: "c", letterStroke: word.letterStroke });
      if (svg.includes("undefined") || svg.includes("NaN") || !svg.includes("<path")) broken ||= `${cw} ${k}`; else drawn++;
    } catch (e) { broken ||= `${cw} ${k}: ${e.message}`; }
  }
  check(`js/hikers-player.js draws all ${loop.frames} frames in void and in paper`, !broken && drawn === 2 * loop.frames, broken || `${drawn} drawn`);
  const js = (dir) => fs.readdirSync(path.join(PUB, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? js(path.join(dir, d.name)) : d.name.endsWith(".js") ? [path.join(dir, d.name)] : []);
  const names = (re) => js("js").concat(fs.readdirSync(PUB).filter((f) => f.endsWith(".html"))).filter((f) => re.test(read(f)));
  const auth = read("js/auth.js");
  const init = auth.slice(auth.indexOf("function initLoginPage("));
  const loaders = names(/logo-player\.js/);
  check("only the sign-in page's start-up loads js/logo-player.js", loaders.length === 1 && loaders[0] === path.join("js", "auth.js")
    && /logo-player\.js/.test(init) && !/logo-player\.js/.test(auth.slice(0, auth.indexOf("function initLoginPage("))), loaders.join(", "));
  const players = names(/hikers-player\.js/);
  check("only js/logo-player.js loads js/hikers-player.js", players.length === 1 && players[0] === path.join("js", "logo-player.js"), players.join(", "));
}

if (PLANT && !planted.has(PLANT)) { console.log(`\nError: the ${PLANT} plant changed nothing`); process.exit(1); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }

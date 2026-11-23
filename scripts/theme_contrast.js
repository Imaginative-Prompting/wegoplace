#!/usr/bin/env node
/* Every colour in styles.css carries a contrast ratio in the comment beside it. Those numbers
 * were the discipline that kept this app legible; they were also, until now, computed by hand
 * once and never checked again. This re-computes them from the stylesheet itself, for every
 * theme, and fails when one drops below the bar.
 *
 * WHY IT MATTERS HERE SPECIFICALLY. The app is used on daltonized displays. The stylesheet's own
 * comments spell out that seven category hues collapse into two clusters under deuteranopia —
 * which is exactly why LIGHTNESS separation, i.e. contrast, is doing the work that hue cannot.
 * Adding themes by eye would quietly spend the one budget the design cannot afford to lose.
 *
 *   node scripts/theme_contrast.js            # check every theme, exit 1 on any failure
 *   node scripts/theme_contrast.js --table    # print the full measured table
 *
 * It parses CSS rather than running a browser on purpose: a headless browser would resolve
 * var() for the ONE theme it happens to be in, and the whole point is to check all of them.
 */
const fs = require("fs");
const path = require("path");

const CSS = path.join(__dirname, "..", "public", "styles.css");
const TABLE = process.argv.includes("--table");

// ── colour ─────────────────────────────────────────────────────────────────────────────
function parseHex(s) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// WCAG 2.1 relative luminance. The 0.03928/12.92 split is the sRGB transfer curve, not a
// rounding of 2.4-gamma — using plain gamma here overstates dark-on-dark ratios, which is the
// exact case every dark theme in this file lives in.
function luminance([r, g, b]) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a, b) {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ── parse the token blocks ─────────────────────────────────────────────────────────────
// One entry per theme: its selector, and the flat map of custom properties it declares.
// A named theme is expected to be self-contained (it redeclares the whole spine), so the only
// inheritance modelled is "everything falls back to the base :root block".
function blocks(src) {
  // Comments come out FIRST, wholesale. They are the reason the regex version of this was wrong
  // and the reason the first scanner could not find the bare :root: this stylesheet documents
  // every token in prose, that prose sits between the selector and the previous rule, and it
  // contains braces and colons. Strip it and the rest is a five-line brace matcher.
  const css = src.replace(/\/\*[\s\S]*?\*\//g, "\n");
  const out = [];
  const stack = [];               // open at-rule conditions, outermost first
  let i = 0, head = "";
  while (i < css.length) {
    const ch = css[i];
    if (ch === "{") {
      const sel = head.trim();
      head = "";
      if (sel.startsWith("@")) { stack.push(sel); i++; continue; }
      let depth = 1, k = i + 1;
      while (k < css.length && depth > 0) {
        if (css[k] === "{") depth++;
        else if (css[k] === "}") depth--;
        k++;
      }
      const vars = {};
      for (const d of css.slice(i + 1, k - 1).split(";")) {
        const dm = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?)\s*$/i.exec(d);
        if (dm) vars[dm[1]] = dm[2];
      }
      if (Object.keys(vars).length) out.push({ sel, media: stack.join(" "), vars });
      i = k;
      continue;
    }
    if (ch === "}") { stack.pop(); head = ""; i++; continue; }
    head += ch;
    i++;
  }
  return out;
}

// ── which themes exist, and how each one is assembled ──────────────────────────────────
function themes(all) {
  const base = all.find((b) => b.sel === ":root" && !b.media);
  if (!base) throw new Error("no bare :root token block found");

  const found = [{ id: "light", label: "Paper (base :root)", vars: { ...base.vars } }];

  // The system-dark palette: whatever the dark media query applies when no theme is chosen.
  const sysDark = all.filter((b) => /prefers-color-scheme:\s*dark/.test(b.media)
    && /^:root(:not\(\[data-theme[^)]*\]\))?$/.test(b.sel));
  if (sysDark.length) {
    const vars = { ...base.vars };
    for (const b of sysDark) Object.assign(vars, b.vars);
    found.push({ id: "system-dark", label: "system dark (media query)", vars });
  }

  // Every explicitly named theme: :root[data-theme="X"] outside a media query.
  for (const b of all) {
    if (b.media) continue;
    const m = /^:root\[data-theme="([a-z0-9-]+)"\]$/.exec(b.sel);
    if (!m) continue;
    if (Object.keys(b.vars).length < 5) continue;   // color-scheme-only stubs are not themes
    found.push({ id: m[1], label: `data-theme="${m[1]}"`, vars: { ...base.vars, ...b.vars } });
  }
  return found;
}

// ── the rules, straight out of the stylesheet's own comments ───────────────────────────
const GROUNDS = ["--ground", "--surface", "--surface-2"];
const TEXT_45 = ["--ink", "--ink-2", "--ink-3", "--accent", "--warn", "--ok"];
const NONTEXT_3 = ["--line-strong"];
const KINDS = ["flight", "transit", "meal", "lodging", "activity", "plan"];
const CATS = ["practical", "food", "drink", "sight", "activity", "lodging", "transit"];

// The accent is one set per family, the theme's own --accent (measured with the text above). The six a person could
// pick retired with Appearance's System, Light, Dark; scripts/appearance_check.mjs holds that none comes back.

// A theme is "dark family" if its own ground is dark. Derived rather than declared, so a theme cannot be checked
// against the wrong family's table entry.
function familyOf(t) {
  const g = t.vars["--ground"] && parseHex(t.vars["--ground"]);
  return g && luminance(g) < 0.25 ? "dark" : "light";
}

let ALL = [];
const results = [];
function record(theme, label, got, min) {
  results.push({ theme, label, got, min, ok: got + 1e-9 >= min });
}

const css = fs.readFileSync(CSS, "utf8");
const all = blocks(css);
ALL = all;
const list = themes(all);

for (const t of list) {
  const hex = (name) => {
    const v = t.vars[name];
    return v ? parseHex(v) : null;
  };
  // body inks and the semantic colours, on all three grounds
  for (const ink of TEXT_45) {
    const a = hex(ink);
    if (!a) continue;
    for (const g of GROUNDS) {
      const b = hex(g);
      if (!b) continue;
      record(t.id, `${ink} on ${g}`, ratio(a, b), 4.5);
    }
  }
  // functional borders: the non-text minimum
  for (const n of NONTEXT_3) {
    const a = hex(n);
    if (!a) continue;
    for (const g of GROUNDS) {
      const b = hex(g);
      if (b) record(t.id, `${n} on ${g}`, ratio(a, b), 3);
    }
  }
  // status colours on their own washes
  for (const s of ["warn", "ok"]) {
    const a = hex(`--${s}`), soft = hex(`--${s}-soft`);
    if (a && soft) record(t.id, `--${s} on --${s}-soft`, ratio(a, soft), 4.5);
  }
  // the six event kinds: a glyph on its own wash, 3:1 non-text
  for (const k of KINDS) {
    const a = hex(`--kind-${k}`), soft = hex(`--kind-${k}-soft`);
    if (a && soft) record(t.id, `--kind-${k} on its soft`, ratio(a, soft), 3);
  }
  // the seven place categories: ink on surfaces, ink on its wash, and ON-ink over the fill
  for (const c of CATS) {
    const a = hex(`--cat-${c}`), soft = hex(`--cat-${c}-soft`), on = hex(`--cat-${c}-on`);
    if (!a) continue;
    for (const g of GROUNDS) {
      const b = hex(g);
      if (b) record(t.id, `--cat-${c} on ${g}`, ratio(a, b), 4.5);
    }
    if (soft) record(t.id, `--cat-${c} on its soft`, ratio(a, soft), 4.5);
    if (on) record(t.id, `--cat-${c}-on over --cat-${c}`, ratio(on, a), 4.5);
  }
}

// ── system dark must BE a named theme, token for token ─────────────────────────────────
// The media block is the no-JavaScript path, so it cannot be folded into a selector list with
// the theme it mirrors and has to be a copy. A copy nobody checks is a copy that drifts, and
// the failure mode is invisible until someone with a dark OS and no explicit choice opens the
// app. So: name which theme it mirrors, and diff every token.
const SYSTEM_DARK_MIRRORS = "void";
{
  const sys = list.find((t) => t.id === "system-dark");
  const named = list.find((t) => t.id === SYSTEM_DARK_MIRRORS);
  if (sys && named) {
    const keys = new Set([...Object.keys(sys.vars), ...Object.keys(named.vars)]);
    let diffs = 0;
    for (const k of keys) {
      const a = (sys.vars[k] || "").replace(/\s+/g, " ").trim();
      const b = (named.vars[k] || "").replace(/\s+/g, " ").trim();
      if (a !== b) { diffs++; if (diffs <= 5) console.log(`   differs: ${k} — system "${a}" vs ${SYSTEM_DARK_MIRRORS} "${b}"`); }
    }
    record("tables", `system dark matches "${SYSTEM_DARK_MIRRORS}" token for token`,
      diffs === 0 ? 1 : 0, 1);
  } else {
    record("tables", `system dark and "${SYSTEM_DARK_MIRRORS}" both exist`, 0, 1);
  }
}

// ── the three lists must agree ─────────────────────────────────────────────────────────
// A theme exists in three places: the CSS block that defines its tokens, the table in
// index.html that the app boots from, and the table in login.html that the sign-in page boots
// from. Any one of them missing is a real, visible bug — a theme you can pick that has no
// colours, or a theme that flashes the wrong ground on the way in — and all three are easy to
// forget. The duplication between the two HTML tables is deliberate (neither page may depend
// on the other loading); this is what makes the duplication safe.
function tableIn(file) {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", file), "utf8");
  const out = {};
  // one entry per line: `id: { ... lm: "x" ... bar: "#hex" ... }`
  const re = /^\s*([a-z][a-z0-9]*)\s*:\s*\{([^}]*)\}/gim;
  const start = src.indexOf("var THEMES = {");
  if (start === -1) return null;
  const end = src.indexOf("};", start);
  const body = src.slice(start, end);
  let m;
  while ((m = re.exec(body))) {
    const lm = /lm\s*:\s*"([a-z]+)"/.exec(m[2]);
    const bar = /bar\s*:\s*"(#[0-9a-f]{3,8})"/i.exec(m[2]);
    out[m[1]] = { lm: lm && lm[1], bar: bar && bar[1].toLowerCase() };
  }
  return out;
}

const shell = tableIn("index.html");
const login = tableIn("login.html");
const cssThemes = list.filter((t) => t.id !== "system-dark").map((t) => t.id);

if (!shell) record("tables", "index.html has a THEMES table", 0, 1);
else {
  for (const id of cssThemes) {
    record("tables", `index.html knows "${id}"`, shell[id] ? 1 : 0, 1);
    // the status-bar colour must BE the ground, or iOS seams a stripe above the app
    const t = list.find((x) => x.id === id);
    const g = t && t.vars["--ground"] && t.vars["--ground"].trim().toLowerCase();
    if (shell[id] && g) {
      record("tables", `index.html bar matches --ground for "${id}"`,
        shell[id].bar === g ? 1 : 0, 1);
    }
    // and the family it claims must match the family its own ground implies
    if (shell[id] && t) {
      record("tables", `index.html lm matches the ground for "${id}"`,
        shell[id].lm === familyOf(t) ? 1 : 0, 1);
    }
  }
  for (const id of Object.keys(shell)) {
    record("tables", `"${id}" in index.html has CSS tokens`, cssThemes.includes(id) ? 1 : 0, 1);
  }
}
if (!login) record("tables", "login.html has a THEMES table", 0, 1);
else for (const id of cssThemes) {
  record("tables", `login.html knows "${id}"`, login[id] ? 1 : 0, 1);
  if (login[id] && shell && shell[id]) {
    record("tables", `login.html agrees with index.html on "${id}"`,
      login[id].lm === shell[id].lm && login[id].bar === shell[id].bar ? 1 : 0, 1);
  }
}

// ── the sticky-note palette, and the ink this app computes for it ──────────────────────
// The note palette is NOT a theme token and is not in styles.css: it lives in
// src/api/trip.js, the server hands it to the client on the snapshot, and a sticky is
// drawn as that hex with initials in whatever ink inkOn() picks for it.
//
// It belongs in this file anyway, for two reasons. It is the one palette a USER can now
// choose from — Settings, and by tapping their own sticky — so "somebody picked amber and
// their initials went to 2.1:1" is a thing a person can now do to themselves, and nothing
// else measures it. And it is theme-independent BY CONSTRUCTION: both the ground and the ink
// come from the hue, so one measurement per colour covers all six themes rather than six.
//
// inkOn() is REQUIRED from public/js/util.js, never reimplemented here. A second copy of the
// rule would let this script certify an ink the app does not actually use, which is worse
// than not checking at all. The palette itself is read out of the source with a regex — the
// module cannot be imported, it pulls in the Workers runtime — so the first check below is
// that the parse found anything, or an empty palette would pass everything vacuously.
{
  const { inkOn } = require(path.join(__dirname, "..", "public", "js", "util.js"));
  const api = fs.readFileSync(path.join(__dirname, "..", "src", "api", "trip.js"), "utf8");

  const listSrc = /export const NOTE_COLORS\s*=\s*\[([^\]]*)\]/.exec(api);
  const hues = listSrc ? (listSrc[1].match(/#[0-9a-fA-F]{6}/g) || []) : [];
  const nameSrc = /export const NOTE_COLOR_NAMES\s*=\s*\{([\s\S]*?)\n\};/.exec(api);
  const names = {};
  if (nameSrc) {
    for (const m of nameSrc[1].matchAll(/"(#[0-9a-fA-F]{6})"\s*:\s*"([^"]+)"/g)) names[m[1]] = m[2];
  }

  record("notes", "NOTE_COLORS found in src/api/trip.js", hues.length ? 1 : 0, 1);
  record("notes", "NOTE_COLOR_NAMES found beside it", Object.keys(names).length ? 1 : 0, 1);
  record("notes", "every hue is distinct", new Set(hues).size === hues.length ? 1 : 0, 1);

  for (const hex of hues) {
    const rgb = parseHex(hex);
    const ink = parseHex(inkOn(hex) || "");
    // THE ONE THAT MATTERS: the initials on the paper. They are what actually name the person
    // — the palette's own design note says the hue only agrees with them — so a colour whose
    // initials cannot be read is a colour that has lost the signal it exists to reinforce.
    record("notes", `initials on ${hex}`, rgb && ink ? ratio(ink, rgb) : 0, 4.5);
    // A NAME, in words, for every swatch. Both pickers print it beside the disc, because
    // under deuteranopia these four hues are about two and a grid of coloured dots is not a
    // control the person this palette was designed for can read. A nameless colour would ship
    // a picker that says nothing, which is why this is a hard check and not a lint.
    record("notes", `${hex} has a name`, names[hex] && names[hex].trim() ? 1 : 0, 1);
  }
}

// ── report ─────────────────────────────────────────────────────────────────────────────
const bad = results.filter((r) => !r.ok);
const byTheme = new Map();
for (const r of results) {
  if (!byTheme.has(r.theme)) byTheme.set(r.theme, []);
  byTheme.get(r.theme).push(r);
}

for (const t of [...list,
  { id: "tables", label: "theme tables vs the CSS" },
  // Not a theme: the sticky-note palette, which is theme-independent by construction — see
  // the block above. Reported alongside them because it is the same promise being kept.
  { id: "notes", label: "sticky-note palette vs its computed ink" },
]) {
  const rs = byTheme.get(t.id) || [];
  const fails = rs.filter((r) => !r.ok);
  const worst = rs.reduce((a, r) => (a && a.got <= r.got ? a : r), null);
  console.log(`\n── ${t.id}  (${t.label})`);
  console.log(`   ${rs.length} pairs checked, ${fails.length} below the bar`
    + (worst ? `, tightest ${worst.label} at ${worst.got.toFixed(2)}:1` : ""));
  if (TABLE) for (const r of rs) {
    console.log(`   ${r.ok ? "ok  " : "FAIL"} ${r.label.padEnd(34)} ${r.got.toFixed(2)}:1 (min ${r.min})`);
  }
  else for (const r of fails) {
    console.log(`   FAIL ${r.label.padEnd(34)} ${r.got.toFixed(2)}:1 (min ${r.min})`);
  }
}

console.log(`\n${results.length - bad.length}/${results.length} pairs meet their minimum`
  + ` across ${list.length} themes`);
if (bad.length) {
  console.log("FAILED:");
  for (const r of bad) console.log(`  ${r.theme}: ${r.label} — ${r.got.toFixed(2)}:1 < ${r.min}`);
}
process.exit(bad.length ? 1 : 0);

#!/usr/bin/env node
/* The design system's colours come from its tokens alone.
 *
 *   node scripts/ds_theme_check.mjs          (on the gate: node scripts/gate.mjs --only ds_theme_check)
 *
 * No browser. It reads public/ds/ and the /design page (public/design.html) and holds:
 *   1. NO RAW COLOUR outside public/ds/tokens.css: no #hex, rgb(), rgba(), hsl(), hsla() or colour name in any other
 *      stylesheet under public/ds/, nor in the /design page's own styles (its theme-color meta excepted: a browser
 *      reads that before any stylesheet).
 *   2. BOTH THEMES WHOLE: tokens.css's light block (the paper) and its dark block (Void) set the same colour tokens,
 *      so nothing built on them has a value in one theme and none in the other.
 *   3. EVERY TOKEN USED IS DEFINED: each var(--x) under public/ds/ and in the /design page names a token tokens.css
 *      sets (or one a stylesheet sets for itself). --ds-* are values a component's code sets on its element.
 *   4. ONE SCALE: no font size under public/ds/ is a raw px value (12, 14, 16, 20, 28 and the number are tokens), but
 *      a face's initials and the two of NeedWright's own that are its lines as written there (a key, a code block).
 *   5. NO FAINT WORDS in the app's own sheets (ink-3 reads under 4.5 to 1), but a number's decimals.
 *   6. REDUCED MOTION STARTS NO TRANSITION: every reduced-motion rule under public/ds/ that sets a transition's length
 *      sets it to 0s with no delay, as the app's own (styles.css): any length at all and a style a script writes
 *      starts one, so a box measured in the same task is still the old box.
 *
 * PLANTED (DSTHEME_PLANT=<name>, each changes only what this check reads):
 *   raw      lists.css read with a raw colour in a rule: 1 red.
 *   missing  tokens.css read without the dark block's --ink-3: 2 red.
 *   unknown  base.css read using a token nobody sets: 3 red.
 *   offscale lists.css read with a row's amount at 15 px: 4 red.
 *   faint    lists.css read with a row's second line in ink-3: 1 red (5).
 *   linger   base.css read with reduced motion's transitions back at 0.01ms: 1 red (6).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const DS = path.join(PUB, "ds");
const PLANT = process.env.DSTHEME_PLANT || "";
if (PLANT && !["raw", "missing", "unknown", "offscale", "faint", "faint-split", "linger"].includes(PLANT)) throw new Error("DSTHEME_PLANT is raw, missing, unknown, offscale, faint, faint-split or linger");
let planted = false;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}

const read = (file) => {
  let t = fs.readFileSync(file, "utf8");
  const before = t;
  const name = path.basename(file);
  if (PLANT === "raw" && name === "lists.css") t = t.replace("color: var(--ink-3);", "color: #8a8a8a;");
  if (PLANT === "missing" && name === "tokens.css") t = t.replace(/(--ink-1: #f1efea;\n  --ink-2: #a7a49c;\n)  --ink-3: #75726a;\n/, "$1");
  if (PLANT === "faint" && name === "lists.css") t = t.replace("font-size: var(--size-14);\n  line-height: 20px;\n  color: var(--ink-2);\n  overflow: hidden;", "font-size: var(--size-14);\n  line-height: 20px;\n  color: var(--ink-3);\n  overflow: hidden;");
  if (PLANT === "offscale" && name === "lists.css") t = t.replace("font-size: var(--size-16);\n  font-weight: 400;", "font-size: 15px;\n  font-weight: 400;");
  if (PLANT === "unknown" && name === "base.css") t = t.replace("color: var(--ink-1);\n  -webkit-font-smoothing", "color: var(--ink-0);\n  -webkit-font-smoothing");
  if (PLANT === "linger" && name === "base.css") t = t.replace("    transition-duration: 0s !important;\n    transition-delay: 0s !important;\n", "    transition-duration: 0.01ms !important;\n");
  if (PLANT === "faint-split" && name === "split.js") t = t.replace(".sp-day{margin:0;padding:14px 0 6px;border-top:1px solid var(--hair);font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-2)}", ".sp-day{margin:0;padding:14px 0 6px;border-top:1px solid var(--hair);font:400 var(--size-14)/20px var(--type-ui);color:var(--ink-3)}");
  if (t !== before) planted = true;
  return t;
};
const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// The /design page's own CSS: its <style> blocks and style="" attributes.
const page = read(path.join(PUB, "design.html"));
const pageCss = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n")
  + "\n" + [...page.matchAll(/style="([^"]*)"/g)].map((m) => `x{${m[1]}}`).join("\n");

const sheets = fs.readdirSync(DS).filter((f) => f.endsWith(".css")).sort();
const texts = Object.fromEntries(sheets.map((f) => [f, noComments(read(path.join(DS, f)))]));

// 1. raw colours
const RAW = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(|\b(white|black|red|green|blue|gray|grey|orange|yellow|purple|pink)\b(?![-\w])/gi;
const rawIn = (css) => {
  const hits = [];
  for (const m of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/gi)) {
    const [, prop, value] = m;
    if (prop.startsWith("--")) continue;                  // a token's own definition is tokens.css's business
    const v = value.replace(/var\([^)]*\)/g, "").replace(/url\([^)]*\)/g, "").replace(/"[^"]*"|'[^']*'/g, "");
    // A mask's gradient is coverage, not a colour anyone sees.
    if (/^(font|font-family|content|grid-template-areas|transition|animation|-webkit-mask|mask)/.test(prop)) continue;
    const r = v.match(RAW);
    if (r) hits.push(`${prop}: ${value.trim()}`);
  }
  return hits;
};
for (const f of sheets.filter((f) => f !== "tokens.css")) {
  const hits = rawIn(texts[f]);
  check(`ds/${f}: no raw colour, only tokens`, hits.length === 0, hits.slice(0, 4).join(" | "));
}
{
  const hits = rawIn(noComments(pageCss));
  check("the /design page's own styles: no raw colour", hits.length === 0, hits.slice(0, 4).join(" | "));
}

// 2. both themes whole
const tokens = texts["tokens.css"];
const block = (sel) => {
  const i = tokens.indexOf(sel);
  if (i < 0) return null;
  const open = tokens.indexOf("{", i), close = tokens.indexOf("}", open);
  return new Set([...tokens.slice(open, close).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
};
const light = block('.ds[data-ds-theme="light"]'), dark = block('.ds[data-ds-theme="dark"]');
const onlyLight = light && dark ? [...light].filter((t) => !dark.has(t)) : [];
const onlyDark = light && dark ? [...dark].filter((t) => !light.has(t)) : [];
check(`tokens.css: the paper and Void set the same ${light ? light.size : 0} colour tokens`,
  !!light && !!dark && light.size > 30 && !onlyLight.length && !onlyDark.length,
  `only in the paper: ${onlyLight.join(", ") || "none"}; only in Void: ${onlyDark.join(", ") || "none"}`);

// 3. every token used is defined
const defined = new Set([...Object.values(texts).join("\n").matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
for (const [where, css] of [...Object.entries(texts).map(([f, t]) => [`ds/${f}`, t]), ["the /design page", pageCss + page]]) {
  const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
  // --ds-*: a value a component's own code sets on its element (a range's fill), never a token. --ground: the app's own
  // page ground (styles.css), which the logo's gap takes where it is set (tokens.css gives each theme a fallback).
  const missing = used.filter((u) => !defined.has(u) && !u.startsWith("--ds-") && u !== "--ground");
  check(`${where}: every token it uses is set (${used.length})`, missing.length === 0, missing.join(", "));
}

// 4. one scale
{
  // A face's initials, and NeedWright's own key and code block, as it writes them.
  const ALLOWED = new Set(["avatar.css .ds-face--24", "pad.css .ds-pad-initials", "feedback.css .ds-avatar--20", "feedback.css .ds-avatar--24", "feedback.css .ds-avatar--28",
    "feedback.css .ds-kbd", "structure.css .ds-code pre"]);
  const off = [];
  for (const f of sheets.filter((f) => f !== "tokens.css")) {
    for (const m of texts[f].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().split(",")[0].trim();
      for (const d of m[2].matchAll(/font(?:-size)?\s*:\s*([^;]*)/g)) {
        const px = /(?:^|\s|\/)?(\d+(?:\.\d+)?)px\b/.exec(d[1].replace(/\/\s*\d+(?:\.\d+)?px/, ""));
        if (px && !ALLOWED.has(`${f} ${sel}`)) off.push(`${f} ${sel}: ${d[0].trim()}`);
      }
    }
  }
  check("one scale: no font size under public/ds is raw px, but a face's initials and NeedWright's own key and code block", off.length === 0, off.join(" | "));
}

// 5. no faint words
{
  // ink-3 on the canvas reads under 4.5 to 1: in the app's own sheets it never colours words (only a number's decimals
  // at the number size). NeedWright's own sheets are copied as they are; their ink-3 is for placeholders, disabled
  // controls and symbols.
  const OWN = ["base.css", "lists.css", "shell.css", "avatar.css", "pad.css", "sheets.css"];
  const faint = [];
  for (const f of OWN.filter((f) => texts[f])) {
    for (const m of texts[f].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().split(",")[0].trim();
      if (/(^|[\s;])color\s*:\s*var\(--ink-3\)/.test(m[2]) && sel !== ".ds-number .ds-dec") faint.push(`${f} ${sel}`);
    }
  }
  check("no words in ink-3 in the app's own sheets (but a number's decimals)", faint.length === 0, faint.join(" | "));
  // A screen on the system keeps its own rules beside its code (Split's SP_CSS): the same rule there. ink-3 stays
  // only where it isn't words to read: a number's decimals or its currency symbol at the number size (large text),
  // a placeholder, a disabled control, an icon.
  const sp = /const SP_CSS = `([\s\S]*?)`;/.exec(read(path.join(PUB, "js", "split.js")));
  const spFaint = [];
  let spRules = 0;
  for (const m of noComments(sp ? sp[1] : "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    spRules++;
    const sel = m[1].trim();
    if (/(^|[\s;])color\s*:\s*var\(--ink-3\)/.test(m[2]) && !/\.sp-dec|\.sp-sym\b|::placeholder|:disabled|\.ico\b|\bsvg\b/.test(sel)) spFaint.push(sel.split(",")[0].trim());
  }
  check(`no words in ink-3 in Split's own rules (${spRules}; but decimals and the big number's symbol, a placeholder, a disabled control, an icon)`, !!sp && spRules > 50 && spFaint.length === 0, spFaint.join(" | "));
}

// 6. reduced motion starts no transition
{
  const bad = [];
  let blocks = 0;
  for (const f of sheets) {
    const css = noComments(texts[f] || "");
    for (const m of css.matchAll(/@media[^{]*prefers-reduced-motion:\s*reduce[^{]*\{([\s\S]*?\})\s*\}/g)) {
      for (const r of m[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const dur = /transition-duration\s*:\s*([^;!]+)/.exec(r[2]);
        if (!dur) continue;
        blocks++;
        const delay = /transition-delay\s*:\s*([^;!]+)/.exec(r[2]);
        if (dur[1].trim() !== "0s" || !delay || delay[1].trim() !== "0s") bad.push(`${f} ${r[1].trim().split(",")[0].trim()}: ${dur[1].trim()}, delay ${delay ? delay[1].trim() : "unset"}`);
      }
    }
  }
  check(`reduced motion starts no transition: each of the system's ${blocks} reduced-motion transition rules is 0s with no delay`, blocks > 0 && bad.length === 0, bad.join(" | "));
}

// 7. a disabled control is recolored, never dimmed: opacity would quiet its words (the app's rule, V2 notes §8.1)
{
  const dimmed = [];
  let rules = 0;
  for (const f of sheets) {
    const css = noComments(texts[f] || "");
    for (const r of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/:disabled|\[aria-disabled|\[disabled\]/.test(r[1])) continue;
      rules++;
      const o = /(?:^|;|\s)opacity\s*:\s*([^;!]+)/.exec(r[2]);
      if (o && Number(o[1].trim()) !== 1) dimmed.push(`${f} ${r[1].trim().split(",")[0].trim()}: opacity ${o[1].trim()}`);
    }
  }
  check(`a disabled control is recolored, never dimmed: none of the system's ${rules} disabled rules sets an opacity under 1`, rules > 0 && dimmed.length === 0, dimmed.join(" | "));
}

if (PLANT && !planted) { console.log(`\nError: the ${PLANT} plant changed nothing`); process.exit(1); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }

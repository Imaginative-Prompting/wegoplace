#!/usr/bin/env node
/* The colours of a drawn picture and of a person's face, read from the same files the pad and the faces draw with.
 *
 *   node scripts/palette_check.mjs        (on the gate: node scripts/gate.mjs --only palette_check)
 *
 * A picture is drawn on its owner's own colour in the one ink their initials wear on it (public/ds/drawing.js, from
 * 25 Nov 2026). The old pad's eight palettes (public/ds/palettes.js) are no longer drawn; a stored picture still
 * names one by its place, so the list stays and keeps its order.
 *
 * No browser. It holds:
 *   4. A STORED PLACE KEEPS ITS PALETTE: the first eight are dusk, moss, plum, ocean, sunrise, sky, sun and paper, in
 *      that order (a stored picture names its palette by its place, and the format refuses a place past the list); the
 *      list may only grow at its end. Every colour is a #RRGGBB.
 *   5. NO COLOUR OF THEIR OWN: the pad, the drawing module and the pad's stylesheet name no colour: a picture's ground
 *      and ink are the face's tokens (--ds-pic-ground, --ds-pic-ink from --person-X, --person-X-on).
 *   6. A PERSON'S INITIALS, AND THE PICTURE THEY DREW, READ ON THEIR OWN COLOUR: in every set of public/ds/tokens.css
 *      that defines the person tones (light, and dark: Void), each --person-X-on against --person-X at 4.5 to 1 or
 *      better, and every colour a person can be given (src/api/trip.js NOTE_COLORS) has its tone in every set
 *      (ds/avatar.js personTone). A colour is drawn at random at sign-up, so a tone that fails here would fail a
 *      browser check only now and then (21 Nov).
 *   7. A KIND'S WORDS READ ON ITS COLOUR: a cluster's count on the map is --cat-X-on on --cat-X (4.5 to 1); a kind's
 *      chip and row put its ink (--cat-X, --plan-X) on its own tint (-bg) over the canvas (4.5 to 1). Plan kinds carry
 *      no -on of their own.
 * (1 to 3, the palettes' own contrast and spacing, went with the palettes' drawing on 25 Nov.)
 *
 * PLANTED (PALETTE_PLANT=<name>; each changes only what this check reads, never a file):
 *   reorder   sky and sun read in each other's place: 1 red (4).
 *   ownhex    pad.js read with a colour of its own: 1 red (5).
 *   dimtone   sky's initials in the light set read as #a9d6f5: 1 red (6).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLANT = process.env.PALETTE_PLANT || "";
const PLANTS = ["reorder", "ownhex", "dimtone"];
if (PLANT && !PLANTS.includes(PLANT)) throw new Error(`PALETTE_PLANT is one of ${PLANTS.join(", ")}`);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 400) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// The list, copied so a plant can change what this check reads.
const { PALETTES: LIST } = await import(pathToFileURL(path.join(REPO, "public", "ds", "palettes.js")).href);
const P = LIST.map((p) => ({ name: p.name, ground: p.ground, inks: [...p.inks] }));
let planted = false;
const plant = (fn) => { fn(); planted = true; };
if (PLANT === "reorder") plant(() => { const a = P.findIndex((p) => p.name === "sky"), b = P.findIndex((p) => p.name === "sun"); [P[a], P[b]] = [P[b], P[a]]; });

// WCAG relative luminance and contrast.
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h) => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const HEX = /^#[0-9A-Fa-f]{6}$/;

section("4. A stored place keeps its palette");
{
  const FIRST = ["dusk", "moss", "plum", "ocean", "sunrise", "sky", "sun", "paper"];
  const names = P.map((p) => p.name);
  check("the first eight, in their places", FIRST.every((n, i) => names[i] === n), names.join(", "));
  check("no name twice", new Set(names).size === names.length);
  const bad = P.filter((p) => !HEX.test(p.ground) || p.inks.length !== 2 || !p.inks.every((c) => HEX.test(c))).map((p) => p.name);
  check("each palette is a #RRGGBB ground and two #RRGGBB inks", !bad.length, bad.join(", "));
}

section("5. No colour of their own");
for (const rel of ["public/ds/pad.js", "public/ds/drawing.js", "public/ds/pad.css"]) {
  let t = fs.readFileSync(path.join(REPO, rel), "utf8");
  if (PLANT === "ownhex" && rel === "public/ds/pad.js") plant(() => { t += '\nconst SPARE = "#FF8A3D";\n'; });
  const own = [...t.matchAll(/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b/g)].map((m) => m[0]);
  check(`${rel} names no colour of its own`, !own.length, own.join(", "));
}

// The sets of tokens.css: each rule's selector and the custom properties it sets (comments dropped).
const TOKENS = fs.readFileSync(path.join(REPO, "public", "ds", "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const SETS = [...TOKENS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ sel: m[1].trim().replace(/\s+/g, " "), v: Object.fromEntries([...m[2].matchAll(/--([\w-]+):\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()])) }))
  .filter((b) => Object.keys(b.v).some((k) => /^person-[a-z-]+-on$/.test(k)));
const setName = (b) => (/dark/.test(b.sel) ? "dark (Void)" : "light");
if (PLANT === "dimtone") plant(() => { SETS.find((b) => setName(b) === "light").v["person-sky-on"] = "#a9d6f5"; });
// A colour as [r, g, b, alpha] from #RRGGBB or rgb()/rgba(); a tint laid over a solid ground.
const rgba = (c) => { if (HEX.test(c)) return [...rgb(c).map((x) => x * 255), 1]; const m = /rgba?\(([^)]+)\)/.exec(c || ""); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
const asHex = (c) => "#" + c.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
const over = (top, ground) => asHex([0, 1, 2].map((i) => top[i] * top[3] + ground[i] * (1 - top[3])));

section("6. A person's initials, and their picture, read on their own colour (4.5 to 1), in every set");
{
  const { personTone } = await import(pathToFileURL(path.join(REPO, "public", "ds", "avatar.js")).href);
  const given = [...fs.readFileSync(path.join(REPO, "src", "api", "trip.js"), "utf8").match(/NOTE_COLORS = \[([^\]]+)\]/)[1].matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) => m[0]);
  const tones = given.map((c) => ({ c, t: personTone(c) }));
  check(`there are two sets, light and dark (${SETS.map(setName).join(", ")})`, SETS.length === 2 && new Set(SETS.map(setName)).size === 2, SETS.map((b) => b.sel.slice(0, 50)).join(" | "));
  check(`every colour a person can be given has a tone (${given.length})`, given.length >= 20 && tones.every((x) => x.t), tones.filter((x) => !x.t).map((x) => x.c).join(", "));
  for (const b of SETS) {
    const rows = tones.map(({ c, t }) => ({ who: t, fill: b.v[`person-${t}`], on: b.v[`person-${t}-on`] }));
    const missing = rows.filter((r) => !HEX.test(r.fill || "") || !HEX.test(r.on || "")).map((r) => r.who);
    const measured = rows.filter((r) => !missing.includes(r.who)).map((r) => ({ ...r, c: contrast(r.on, r.fill) }));
    const low = measured.filter((r) => r.c < 4.5);
    const least = measured.reduce((a, x) => (x.c < a.c ? x : a), { c: Infinity, who: "-" });
    check(`${setName(b)}: every tone has its colour and its initials' colour, as #RRGGBB`, !missing.length, missing.join(", "));
    check(`${setName(b)}: all ${measured.length} tones' initials read on their colour`, !low.length,
      low.length ? low.map((r) => `${r.who} ${r.on} on ${r.fill} ${r.c.toFixed(2)}`).join(", ") : `lowest ${least.who}, ${least.c.toFixed(2)} to 1`);
  }
}

section("7. A kind's words read on its colour (4.5 to 1), in every set");
for (const b of SETS) {
  const canvas = rgba(b.v.canvas || "");
  const counts = Object.keys(b.v).filter((k) => /^cat-[a-z]+$/.test(k) && b.v[`${k}-on`]).map((k) => ({ who: k, c: contrast(b.v[`${k}-on`], b.v[k]) }));
  const inks = Object.keys(b.v).filter((k) => /^(cat|plan)-[a-z]+$/.test(k) && b.v[`${k}-bg`]).map((k) => ({ who: k, c: contrast(b.v[k], over(rgba(b.v[`${k}-bg`]), canvas)) }));
  for (const [what, rows, want] of [["a map cluster's count (-on on the kind's colour)", counts, 7], ["a kind's ink on its own tint over the canvas", inks, 13]]) {
    const low = rows.filter((r) => r.c < 4.5);
    const least = rows.reduce((a, x) => (x.c < a.c ? x : a), { c: Infinity, who: "-" });
    check(`${setName(b)}: ${what}, ${rows.length} kinds`, !!canvas && rows.length >= want && !low.length,
      low.length ? low.map((r) => `${r.who} ${r.c.toFixed(2)}`).join(", ") : `lowest ${least.who}, ${least.c.toFixed(2)} to 1`);
  }
}

if (PLANT && !planted) { console.log(`\nError: the ${PLANT} plant changed nothing`); process.exit(1); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }

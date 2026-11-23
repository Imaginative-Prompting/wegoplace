#!/usr/bin/env node
/* The privacy page and the terms give the same address to write to, and neither still says it's to come.
 *
 *   node scripts/contact_check.mjs          (on the gate: node scripts/gate.mjs --only contact_check)
 *
 * No browser. It reads public/privacy.html and public/terms.html (the address is set in both by
 * scripts/contact.mjs) and holds:
 *   1. each page carries exactly one contact, and it is a mailto link to an email address, its words
 *      the address itself;
 *   2. the two pages carry the same address;
 *   3. no placeholder is left: no "[the contact address goes here…]", no data-placeholder.
 *
 * PLANTED (CONTACT_PLANT=<name>, each changes only what this check reads):
 *   other        terms.html read with another address: 1 red (2).
 *   placeholder  privacy.html read with the placeholder back: 3 red (1, 2 and 3).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAGES, SPAN } from "./contact.mjs";

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const PLANT = process.env.CONTACT_PLANT || "";
if (PLANT && !["other", "placeholder"].includes(PLANT)) throw new Error("CONTACT_PLANT is other or placeholder");
let planted = false;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}

const read = (p) => {
  let t = fs.readFileSync(path.join(PUB, p), "utf8");
  const n0 = t;
  if (PLANT === "other" && p === "terms.html") t = t.replace(/mailto:[^"]+">[^<]+</, 'mailto:someone.else@example.com">someone.else@example.com<');
  if (PLANT === "placeholder" && p === "privacy.html") t = t.replace(SPAN, '<span class="lg-legal-contact" data-placeholder="contact">[the contact address goes here before the site opens]</span>');
  if (t !== n0) planted = true;
  return t;
};

const found = {};
for (const p of PAGES) {
  const t = read(p);
  const spans = t.match(SPAN) || [];
  const m = spans.length === 1 && /<a href="mailto:([^"]+)">([^<]+)<\/a>/.exec(spans[0]);
  const ok = !!m && m[1] === m[2] && /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(m[1]);
  check(`${p}: one contact, a mailto link to an email address that reads as itself`, ok, spans.join(" | ") || "none");
  found[p] = m ? m[1] : null;
  check(`${p}: no placeholder left`, !/goes here before the site opens|data-placeholder="contact"/.test(t));
}
const [a, b] = PAGES.map((p) => found[p]);
check(`both pages give the same address`, !!a && a === b, `${a} · ${b}`);

if (PLANT && !planted) { console.log(`\nError: the ${PLANT} plant changed nothing`); process.exit(1); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }

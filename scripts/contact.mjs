#!/usr/bin/env node
/* The address the privacy page and the terms give to write to: one command sets it in both.
 *
 *   node scripts/contact.mjs <address>      writes it into public/privacy.html and public/terms.html
 *   node scripts/contact.mjs                 says what each page carries now
 *
 * Each page carries it once, in <span class="lg-legal-contact" data-contact>, as a mailto link.
 * scripts/contact_check.mjs (on the gate) holds the two pages to the same address. Changing it
 * is this command and a deploy.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
export const PAGES = ["privacy.html", "terms.html"];
export const SPAN = /<span class="lg-legal-contact"[^>]*>[\s\S]*?<\/span>/g;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

if (import.meta.url === `file://${process.argv[1]}`) {
  const address = process.argv[2];
  if (!address) {
    for (const p of PAGES) console.log(`${p}: ${(fs.readFileSync(path.join(PUB, p), "utf8").match(SPAN) || ["(none)"]).join(" | ")}`);
    process.exit(0);
  }
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(address)) { console.error(`not an email address: ${address}`); process.exit(2); }
  const span = `<span class="lg-legal-contact" data-contact><a href="mailto:${esc(address)}">${esc(address)}</a></span>`;
  for (const p of PAGES) {
    const file = path.join(PUB, p);
    const text = fs.readFileSync(file, "utf8");
    const n = (text.match(SPAN) || []).length;
    if (n !== 1) { console.error(`${p}: ${n} contact spans, expected 1`); process.exit(1); }
    fs.writeFileSync(file, text.replace(SPAN, span));
    console.log(`${p}: ${address}`);
  }
}

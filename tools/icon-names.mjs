#!/usr/bin/env node
// THE ICONS UNDER NAMES THAT CHANGE WITH THEM (21 Nov: the old favicon still showed in some places after the new logo
// went live). Every icon file on the site was already the new logo; what still showed the old one were
// caches keyed on the URL, which never changed: a browser's favicon store (Safari's keeps /favicon.ico for a site until
// the linked URL changes), an old worker's cache, an installed app's manifest. So the icons are linked by names made
// from their bytes: public/icons/favicon.<8 hex>.ico, icon-180.<8 hex>.png, icon-192.<…>.png, icon-512.<…>.png, the
// first 8 hex of each file's sha256. A new logo is a new name, everywhere at once.
//
// The files themselves are art/make_logo.py's (--site writes public/favicon.ico and public/icons/icon-*.png, then runs
// this). This copies each under its hashed name, removes hashed copies that are no longer current, and points every
// reference at the current names: the pages (public/*.html, the guard's "Updating" icon among them), the manifest, the
// worker's precache (sw.js) and its notifications (push-sw.js), and the pages the server makes (the sign-in consent page,
// a shared board) and the MCP server's own icon (src/mcp/server.js). /favicon.ico stays at the root, the new icon:
// browsers ask for it by name. Never edited by hand: scripts/icon_names_check.mjs holds all of it.
//
//   node tools/icon-names.mjs            writes the copies and the references
//   node tools/icon-names.mjs --dry      says what it would change, changes nothing
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** Each icon: its file as the logo script writes it, the name its hashed copy takes, and how a reference to it is spelled. */
export const ICONS = [
  { file: "public/favicon.ico", stem: "favicon", ext: ".ico", ref: /(?:\/icons)?\/favicon(?:\.[0-9a-f]{8})?\.ico/g },
  { file: "public/icons/icon-180.png", stem: "icon-180", ext: ".png", ref: /\/icons\/icon-180(?:\.[0-9a-f]{8})?\.png/g },
  { file: "public/icons/icon-192.png", stem: "icon-192", ext: ".png", ref: /\/icons\/icon-192(?:\.[0-9a-f]{8})?\.png/g },
  { file: "public/icons/icon-512.png", stem: "icon-512", ext: ".png", ref: /\/icons\/icon-512(?:\.[0-9a-f]{8})?\.png/g },
];
/** Where the site names its icons. Every other file is left as it is (a check's list of what the site serves, say). */
export const REFERRERS = () => [
  ...fs.readdirSync(path.join(ROOT, "public")).filter((f) => f.endsWith(".html")).sort().map((f) => `public/${f}`),
  "public/js/fresh-app.js", "public/js/push-sw.js", "public/manifest.webmanifest", "public/sw.js",
  "src/mcp/oauth.js", "src/share-page.js", "src/mcp/server.js",
];
export const hashOf = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 8);
/** The current hashed name of each icon, as the site links it: { file, url, hashed (repo path), bytes }. */
export function current(root = ROOT) {
  return ICONS.map((i) => {
    const bytes = fs.readFileSync(path.join(root, i.file));
    const name = `${i.stem}.${hashOf(bytes)}${i.ext}`;
    return { ...i, bytes, url: `/icons/${name}`, hashed: `public/icons/${name}` };
  });
}
// Only references inside REFERRERS are rewritten (public/_headers and the checks that fetch the bare files are not
// referrers). /favicon.ico itself stays at the root for browsers that ask for it by name; the pages link the hashed one.
export function rewrite(text, icons) {
  let out = text;
  for (const i of icons) out = out.replace(i.ref, i.url);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dry = process.argv.includes("--dry");
  const icons = current();
  const said = [];
  for (const i of icons) {
    const at = path.join(ROOT, i.hashed);
    if (!fs.existsSync(at) || !fs.readFileSync(at).equals(i.bytes)) { said.push(`write ${i.hashed}`); if (!dry) fs.writeFileSync(at, i.bytes); }
  }
  const keep = new Set(icons.map((i) => path.basename(i.hashed)));
  for (const f of fs.readdirSync(path.join(ROOT, "public/icons"))) {
    if (/\.[0-9a-f]{8}\.(ico|png)$/.test(f) && !keep.has(f)) { said.push(`remove public/icons/${f}`); if (!dry) fs.rmSync(path.join(ROOT, "public/icons", f)); }
  }
  for (const f of REFERRERS()) {
    const at = path.join(ROOT, f);
    const was = fs.readFileSync(at, "utf8"), now = rewrite(was, icons);
    if (now !== was) { said.push(`point ${f} at the current names`); if (!dry) fs.writeFileSync(at, now); }
  }
  console.log(said.length ? said.join("\n") : "the icons' names are current");
}

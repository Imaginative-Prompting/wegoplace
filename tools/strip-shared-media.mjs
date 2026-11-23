#!/usr/bin/env node
// CUTOVER TOOL, run once after the database is moved across: the shared boards' photographs, videos and thumbnails
// already stored, cleaned in place of what a camera wrote into them (src/media/strip.js), as every new one is cleaned
// when it's stored. Boards shared before that fix copied each photograph's original, place and time included, and a
// board's link is open to anyone.
//
//   node tools/strip-shared-media.mjs --local <wrangler state dir> [--dry-run] [--config wrangler.jsonc]
//   node tools/strip-shared-media.mjs --remote [--dry-run]        (the deployed site's own: run by hand, never from a script)
//
// What it reads: every board item (collage_share_items: r2_key) and every thumbnail a board item names (thumb_key), in
// the MEDIA bucket. For each:
//   - fetched to a folder of its own outside the tree, and kept there until the end;
//   - cleaned; the cleaned bytes must be the same kind of file, not empty, and cleaning them again must change nothing
//     (nothing left to take out), or the object is left as it is and listed;
//   - written back to its key, read back, and compared with the cleaned bytes; on any difference the original is
//     written back, and the run stops;
//   - its row's bytes set to the new size (the host's room counts it).
// And a board item whose row has no width or height (an app that didn't know them sent 0) gets them from the file's own
// header (sizeOf), cleaned or already clean, so the board's page can say each picture's size.
// Already clean: left alone. A format it can't clean (HEIC, AVIF): left alone and listed, by key and size.
// --dry-run says what it would do (counts and sizes) and writes nothing. It never prints what a file holds.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sizeOf, sniff, stripMetadata } from "../src/media/strip.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(ROOT, "node_modules/.bin/wrangler");
const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const local = flag("--local"), remote = argv.includes("--remote"), dry = argv.includes("--dry-run");
const config = path.resolve(flag("--config") ?? path.join(ROOT, "wrangler.jsonc"));
if (!local === !remote) { console.error("say where: --local <wrangler state dir>, or --remote"); process.exit(2); }
if (local && !fs.existsSync(local)) { console.error(`no such state folder: ${local}`); process.exit(2); }

const where = remote ? ["--remote"] : ["--local", "--persist-to", path.resolve(local)];
const BUCKET = "wegoplace-media", DB = "wegoplace";
const run = (args, what) => {
  const r = spawnSync(WRANGLER, [...args, "-c", config], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", X_LOCAL_OBSERVABILITY: "false", CI: "1", NO_COLOR: "1" } });
  if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
  return r.stdout;
};
const sql = (command) => { const out = run(["d1", "execute", DB, ...where, "--json", "--command", command], "the database"); return JSON.parse(out.slice(out.indexOf("["))).at(-1).results; };
const get = (key, file) => run(["r2", "object", "get", `${BUCKET}/${key}`, ...where, "--file", file], `reading ${key}`);
const put = (key, file, type) => run(["r2", "object", "put", `${BUCKET}/${key}`, ...where, "--file", file, "--content-type", type], `writing ${key}`);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const KEY = /^[\w\-./]{1,200}$/;
const typeOf = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

const work = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-strip-shared-"));
const objects = [
  ...sql("SELECT share_id, idx, r2_key AS key, mime, width, height FROM collage_share_items ORDER BY share_id, idx").map((r) => ({ ...r, item: true })),
  ...sql("SELECT DISTINCT thumb_key AS key FROM collage_share_items WHERE thumb_key != '' ORDER BY thumb_key").map((r) => ({ ...r, item: false })),
];
const tally = { cleaned: 0, before: 0, after: 0, clean: 0, cant: [], missing: 0, sized: 0 };
const rowOf = (o) => `share_id = '${String(o.share_id).replace(/'/g, "")}' AND idx = ${Number(o.idx)}`;
/** A board item with no size kept: its size from the file's own header (the same before and after cleaning). */
function fillSize(o, bytes) {
  if (!o.item || (Number(o.width) > 0 && Number(o.height) > 0)) return;
  const size = sizeOf(bytes);
  if (!size) return;
  tally.sized++;
  if (!dry) sql(`UPDATE collage_share_items SET width = ${size.width}, height = ${size.height} WHERE ${rowOf(o)} AND (width = 0 OR height = 0)`);
}
console.log(`${objects.length} objects (${objects.filter((o) => o.item).length} board items, ${objects.filter((o) => !o.item).length} thumbnails)${dry ? ": a dry run, nothing written" : ""}`);
for (const [n, o] of objects.entries()) {
  if (!KEY.test(o.key)) { tally.cant.push(`${o.key.slice(0, 40)}… (not a key this tool reads)`); continue; }
  const original = path.join(work, `o${n}`), cleanedFile = path.join(work, `c${n}`), backFile = path.join(work, `b${n}`);
  try { get(o.key, original); } catch { tally.missing++; continue; }
  const bytes = fs.readFileSync(original);
  const out = stripMetadata(bytes);
  if (out.refused) { tally.cant.push(`${o.key} (${sniff(bytes)}, ${bytes.length} bytes)`); continue; }
  const cleaned = Buffer.from(out.bytes);
  if (cleaned.equals(bytes)) { tally.clean++; fillSize(o, bytes); continue; }
  // The same checks as when it's stored: the same kind of file, not empty, and nothing left to take out.
  const again = stripMetadata(cleaned);
  if (!cleaned.length || sniff(cleaned) !== sniff(bytes) || again.refused || !Buffer.from(again.bytes).equals(cleaned)) {
    tally.cant.push(`${o.key} (its cleaned bytes didn't pass: left as it is)`); continue;
  }
  tally.cleaned++; tally.before += bytes.length; tally.after += cleaned.length;
  if (dry) { fillSize(o, cleaned); continue; }
  const type = out.format === "mp4" ? (/^video\//.test(o.mime ?? "") ? o.mime : "video/mp4") : typeOf[out.format];
  fs.writeFileSync(cleanedFile, cleaned);
  put(o.key, cleanedFile, type);
  get(o.key, backFile);
  if (sha(fs.readFileSync(backFile)) !== sha(cleaned)) {
    put(o.key, original, o.mime || type);
    console.error(`STOPPED: ${o.key} didn't read back as written; its original is written back, and kept at ${original}`);
    process.exit(1);
  }
  if (o.item) sql(`UPDATE collage_share_items SET bytes = ${cleaned.length} WHERE ${rowOf(o)}`);
  fillSize(o, cleaned);
}
console.log(`${dry ? "would clean" : "cleaned"} ${tally.cleaned} (${tally.before} bytes to ${tally.after}); already clean ${tally.clean}; missing ${tally.missing}; left as they are ${tally.cant.length}; ${dry ? "would give" : "gave"} ${tally.sized} board items their size`);
for (const c of tally.cant) console.log(`  left: ${c}`);
fs.rmSync(work, { recursive: true, force: true });

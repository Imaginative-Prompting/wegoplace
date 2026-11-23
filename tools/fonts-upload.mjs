#!/usr/bin/env node
// The map's label fonts, whole, into the tiles bucket once, when a site is set up: every font the
// basemap style names (public/vendor/basemaps/basemaps.mjs), all 256 ranges of 256 characters each,
// at fonts/<font>/<start>-<end>.pbf, where the map asks for them (/tiles/fonts/…). A trip's map lists
// the ranges its labels use (its snapshot's tiles.glyphs), and a phone fetches those before it
// loses signal; with every range in the bucket, a trip anywhere has its labels.
//
//   node tools/fonts-upload.mjs --from <basemaps-assets>/fonts (--local <wrangler state dir> | --remote) [--bucket wegoplace-tiles] [--jobs n] [--done <file outside the tree>] [--dry-run]
//
// It sends --jobs files at a time (to the live bucket 8 unless said, to a local one 1: local puts
// at once fail; each is its own wrangler run, most of whose time is wrangler starting), and stops
// at the first failure. Each file sent is written to the
// done-file as it lands (by default in the machine's temp folder, one for the live bucket and one
// for local ones), and a second run skips what that file says is there with the same contents:
// a run stopped at file 700 starts again at 701. Delete the done-file to send everything again.
//
// The fonts come from Protomaps' basemaps-assets (https://github.com/protomaps/basemaps-assets,
// fonts/; their licence, the SIL Open Font License, is in that folder as OFL.txt and goes up beside
// them). Get them once:
//   git clone --depth 1 --filter=blob:none --sparse https://github.com/protomaps/basemaps-assets && git -C basemaps-assets sparse-checkout set fonts
// (14 Nov 2026: commit 028c18f, four fonts, 1,024 glyph files and the licence, 17.7 MB.)
//
// It checks the folder before sending anything: every font the style names is there, each with
// all 256 ranges, each file a glyph file (a protocol buffer of glyphs, or empty for a range the font
// has no characters in). --remote writes the deployed site's bucket (signed in with `wrangler login`).

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const RANGES = Array.from({ length: 256 }, (_, i) => `${i * 256}-${i * 256 + 255}`);

/** The fonts the basemap style asks for, read from the vendored style. */
export function styleFonts(source = fs.readFileSync(path.join(ROOT, "public/vendor/basemaps/basemaps.mjs"), "utf8")) {
  return [...new Set([...source.matchAll(/"(Noto Sans[^"]*)"/g)].map((m) => m[1]))].sort();
}

/** What's wrong with a fonts folder for these fonts: [] when it's whole. */
export function problemsIn(dir, fonts) {
  const out = [];
  for (const font of fonts) {
    const at = path.join(dir, font);
    if (!fs.existsSync(at)) { out.push(`no folder for "${font}"`); continue; }
    const missing = RANGES.filter((r) => !fs.existsSync(path.join(at, `${r}.pbf`)));
    if (missing.length) out.push(`"${font}" lacks ${missing.length} ranges (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""})`);
    for (const r of RANGES) {
      const file = path.join(at, `${r}.pbf`);
      if (!fs.existsSync(file)) continue;
      const b = fs.readFileSync(file);
      // A glyph file is a protocol buffer whose first field is the fontstack (field 1, bytes): tag 0x0a.
      if (b.length && b[0] !== 0x0a) { out.push(`"${font}/${r}.pbf" isn't a glyph file`); break; }
    }
  }
  if (!fs.existsSync(path.join(dir, "OFL.txt"))) out.push("no OFL.txt (the fonts' licence goes up with them)");
  return out;
}

/**
 * One file into the bucket through wrangler, as a promise: resolves on success, rejects with
 * wrangler's last words.
 */
export function wranglerPut({ bucket, key, file, remote, local }) {
  const type = key.endsWith(".pbf") ? "application/x-protobuf" : "text/plain; charset=utf-8";
  const wrangler = path.join(ROOT, "node_modules/.bin/wrangler");
  return new Promise((resolve, reject) => {
    const child = spawn(wrangler, ["r2", "object", "put", `${bucket}/${key}`, "--file", file, "--content-type", type, ...(remote ? ["--remote"] : ["--local", "--persist-to", local])],
      { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    child.stdout.on("data", (d) => { said = (said + d).slice(-800); });
    child.stderr.on("data", (d) => { said = (said + d).slice(-800); });
    child.on("error", (e) => reject(new Error(e.message)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(said.slice(-400) || `wrangler exited ${code}`))));
  });
}

/** A file's fingerprint in the done-file: its size and SHA-256, so a changed file goes up again. */
const print = (file) => `${fs.statSync(file).size}:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;

/**
 * Sends `files` ([key, path] pairs), `jobs` at a time. Each one sent is written to `doneFile`
 * ("<key> <fingerprint>" a line) as it lands, and a second run skips what that file says is
 * already there with the same contents, so a run stopped at file 700 starts again at 701.
 * The first failure stops it: nothing new starts, the ones under way finish (and are written
 * down), and it answers { sent, skipped, failed: { key, words } }.
 */
export async function sendAll(files, { put, jobs = 8, doneFile, onProgress = () => {} }) {
  const done = new Map();
  if (doneFile && fs.existsSync(doneFile)) {
    for (const line of fs.readFileSync(doneFile, "utf8").split("\n")) {
      const at = line.lastIndexOf(" ");
      if (at > 0) done.set(line.slice(0, at), line.slice(at + 1));
    }
  }
  const todo = [];
  let skipped = 0;
  for (const [key, file] of files) {
    const fp = print(file);
    if (done.get(key) === fp) skipped += 1; else todo.push([key, file, fp]);
  }
  let next = 0;
  let sent = 0;
  let failed = null;
  const worker = async () => {
    while (!failed && next < todo.length) {
      const [key, file, fp] = todo[next++];
      try {
        await put(key, file);
      } catch (e) {
        failed ??= { key, words: String(e.message || e) };
        return;
      }
      if (doneFile) fs.appendFileSync(doneFile, `${key} ${fp}\n`);
      sent += 1;
      onProgress(skipped + sent, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, todo.length)) }, worker));
  return { sent, skipped, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
  const from = flag("--from");
  const local = flag("--local");
  const bucket = flag("--bucket") ?? "wegoplace-tiles";
  const remote = argv.includes("--remote");
  // A local bucket takes one at a time: each local put starts its own copy of the local runtime
  // on the same state, and eight at once fail ("Network connection lost", measured 14 Nov). The
  // live bucket's puts are API calls, eight at once unless said.
  const jobs = Number(flag("--jobs") ?? (remote ? 8 : 1));
  const dry = argv.includes("--dry-run");
  const doneFile = path.resolve(flag("--done") ?? path.join(os.tmpdir(), `wegoplace-fonts-${bucket}-${remote ? "live" : "local"}.done`));
  if (!from || (!local && !remote) || (local && remote) || !(jobs >= 1 && jobs <= 32)) {
    console.error("usage: node tools/fonts-upload.mjs --from <basemaps-assets>/fonts (--local <wrangler state dir> | --remote) [--bucket wegoplace-tiles] [--jobs n] [--done <file outside the tree>] [--dry-run]");
    process.exit(2);
  }
  if (!path.relative(ROOT, doneFile).startsWith("..")) { console.error("refused: the done-file goes outside the tree."); process.exit(2); }
  const fonts = styleFonts();
  const problems = problemsIn(from, fonts);
  if (problems.length) { console.error(`refused, nothing sent:\n  ${problems.join("\n  ")}`); process.exit(1); }
  const files = [...fonts.flatMap((f) => RANGES.map((r) => [`fonts/${f}/${r}.pbf`, path.join(from, f, `${r}.pbf`)])), ["fonts/OFL.txt", path.join(from, "OFL.txt")]];
  const bytes = files.reduce((n, [, p]) => n + fs.statSync(p).size, 0);
  console.log(`${fonts.length} fonts (${fonts.join(", ")}), ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB, to ${remote ? "the LIVE" : "a local"} bucket ${bucket}, ${jobs} at a time; what's sent is written to ${doneFile}`);
  if (dry) process.exit(0);
  const started = Date.now();
  const { sent, skipped, failed } = await sendAll(files, {
    jobs, doneFile,
    put: (key, file) => wranglerPut({ bucket, key, file, remote, local }),
    onProgress: (n, of) => { if (n % 32 === 0) process.stdout.write(`\r${n} of ${of}`); },
  });
  const took = `${((Date.now() - started) / 1000).toFixed(0)} s`;
  if (failed) {
    console.error(`\nstopped at ${failed.key} after ${sent} sent (${skipped} already there), ${took}: ${failed.words}\nRun the same command again: it starts where this stopped.`);
    process.exit(1);
  }
  console.log(`\r${skipped + sent} of ${files.length}: done (${sent} sent, ${skipped} already there), ${took}`);
}

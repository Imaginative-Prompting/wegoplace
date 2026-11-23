#!/usr/bin/env node
// Runs the scenario against the Worker on a fresh local database, and either writes the
// recording or compares it with one made earlier.
//
//   node checks/parity/run.mjs --compare checks/parity/golden.json   the check
//   node checks/parity/run.mjs --record <file.json>                  record a run
//   node checks/parity/run.mjs --diff <a.json> <b.json>              no server: two recordings
//
//   --port <n>        a free port when not named: the server's own origin is recorded as <origin>, and a body's
//                     length counted with <origin> in its place, so the recording holds on any port (a port of
//                     four digits or five), and two lanes can run it at once
//   --keep            leave the database and the server's log in place afterwards
//
// It starts the server itself (checks/lib/server.mjs: its own database, buckets and log under
// .wrangler/check/, ignored by git and removed at the end) and stops it when it's done, and
// nothing else.
// Exit code: 0 the recordings match (or one was written), 1 they differ, 2 it couldn't run.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CheckError, ROOT, freePort, startServer } from "../lib/server.mjs";
import { Jar, Normalizer, compare, hashIndex, publicFiles, request, sessionValue } from "./lib.mjs";
import { scenario, seedSql, tileBytes, tileJson, TILE_KEY, TILE_JSON_KEY } from "./scenario.mjs";

function args() {
  const a = process.argv.slice(2);
  const o = { port: null, record: null, compare: null, diff: null, keep: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--port") o.port = Number(a[++i]);
    else if (a[i] === "--record") o.record = a[++i];
    else if (a[i] === "--compare") o.compare = a[++i];
    else if (a[i] === "--diff") { o.diff = [a[++i], a[++i]]; }
    else if (a[i] === "--keep") o.keep = true;
    else die(`unknown argument ${a[i]}`);
  }
  if (o.diff) return o;
  if (!o.record === !o.compare) die("give exactly one of --record <file> or --compare <file>");
  if (o.port !== null && (!Number.isInteger(o.port) || o.port < 1024)) die("--port must be a number above 1023");
  return o;
}
function die(msg) { console.error(`parity: ${msg}`); process.exit(2); }

const sha256Hex = (text) => crypto.createHash("sha256").update(text).digest("hex");

async function main() {
  const o = args();
  if (o.port === null && !o.diff) o.port = await freePort();

  if (o.diff) {
    const [a, b] = o.diff.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
    const { lines, compared } = compare(a, b);
    for (const l of lines) console.log(l);
    console.log(`parity: ${compared} steps compared, ${lines.length} differences`);
    process.exit(lines.length ? 1 : 0);
  }

  const golden = o.compare ? JSON.parse(fs.readFileSync(path.resolve(o.compare), "utf8")) : null;
  // Made for this run and gone with it. AUTH_SECRET signs the sign-in cookie from before
  // sessions were rows, which a few steps send; the two tokens are the seeded people's sessions.
  const secret = crypto.randomBytes(32).toString("hex");
  const tokens = { u_admin: crypto.randomBytes(32).toString("base64url"), u_bob: crypto.randomBytes(32).toString("base64url") };
  const startSec = Math.floor(Date.now() / 1000);
  let server = null;
  const cleanup = async () => { await server?.stop(); };
  process.on("SIGINT", () => { cleanup().finally(() => process.exit(130)); });
  process.on("SIGTERM", () => { cleanup().finally(() => process.exit(143)); });

  try {
    // 1. A fresh database with every migration, the scenario's rows, a session each for the two
    //    seeded people, and two map objects.
    server = await startServer({ name: "parity", port: o.port, keep: o.keep, secrets: { AUTH_SECRET: secret } });
    const seedFile = path.join(server.work, "seed.sql");
    const sessions = Object.entries(tokens).map(([userId, token]) =>
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('${sha256Hex(token)}', '${userId}', ${startSec}, ${startSec + 180 * 86400});`);
    fs.writeFileSync(seedFile, seedSql + sessions.join("\n") + "\n");
    server.sqlFile(seedFile);
    const tileFile = path.join(server.work, "tile.bin"), jsonFile = path.join(server.work, "tile.json");
    fs.writeFileSync(tileFile, tileBytes());
    fs.writeFileSync(jsonFile, tileJson());
    server.put("wegoplace-tiles", TILE_KEY, tileFile);
    server.put("wegoplace-tiles", TILE_JSON_KEY, jsonFile);

    // 2. The server.
    await server.start();
    const origin = server.origin;

    // 3. The scenario.
    const norm = new Normalizer({ startSec, files: hashIndex(path.join(ROOT, "public")) });
    // The server's own address reads <origin> wherever it is sent back (a redirect's location, a page that names
    // itself), so the recording is the same on any port.
    norm.learn("origin", origin);
    const jars = new Map();
    const jar = (name) => { if (!jars.has(name)) jars.set(name, new Jar()); return jars.get(name); };
    // The sign-in cookie as it was before sessions were rows (src/accounts/old-cookie.js).
    const session = (userId, ttl) => `s2=${sessionValue(secret, userId, Math.floor(Date.now() / 1000) + ttl)}`;
    jar("admin").cookies.set("wgp_session", tokens.u_admin);
    jar("bob").cookies.set("wgp_session", tokens.u_bob);

    // The static sweep covers what's in public/ now. Against an older recording, a file that has
    // since been removed is skipped (its step can't run, and hides nothing), and a file that has
    // since been added FAILS, named: until the recording has its steps, how it is served is held by
    // nothing (14 Nov: nine files had gone unrecorded this way). Record again (README.md).
    // The towns' table (public/towns/: about 2,500 small files, one per few letters of a town's
    // name) is one way of being served, so a few of its files stand for it: index.json, near.txt,
    // LICENSE.txt and the first t-file. scripts/towns_check.mjs (the client's gate) reads every file.
    const towns = (f) => f.startsWith("towns/");
    const allOnDisk = publicFiles(path.join(ROOT, "public")).filter((f) => !f.startsWith("_"));
    const firstTown = allOnDisk.filter((f) => /^towns\/t-[^/]+$/.test(f)).sort()[0];
    const onDisk = allOnDisk.filter((f) => !towns(f) || ["towns/index.json", "towns/near.txt", "towns/LICENSE.txt", firstTown].includes(f));
    const steps = [];
    const names = new Set();
    const t = {
      origin, rpId: "localhost", files: onDisk, seedPath: path.join(ROOT, "seed/demo-trip.json"),
      jar, session,
      learn: (name, literal) => norm.learn(name, literal),
      // A row changed behind the server's back, for what no route does yet.
      sql: (command) => server.sql(command),
      // Wait for the clock's second to change. The server stamps rows in whole seconds and several
      // lists sort on that stamp, so two rows made in the same second can come back in either
      // order from one run to the next. The scenario ticks between rows it later lists together.
      async tick() {
        const sec = Math.floor(Date.now() / 1000);
        while (Math.floor(Date.now() / 1000) === sec) await new Promise((r) => setTimeout(r, 20));
        await new Promise((r) => setTimeout(r, 60));
      },
      async call(name, { as = null, method = "GET", path: p = "/", headers = {}, json, body = null, type, cookie, learn, staticAsset, reduce, file }) {
        if (names.has(name)) throw new Error(`two steps are named "${name}"`);
        names.add(name);
        const h = { ...headers };
        let payload = body;
        if (json !== undefined) { payload = JSON.stringify(json); h["Content-Type"] = "application/json"; norm.sent(json); }
        else if (type) h["Content-Type"] = type;
        const jarOf = as && as !== "anon" ? jar(as) : null;
        const cookieHeader = cookie !== undefined ? cookie : jarOf ? jarOf.header() : "";
        if (cookieHeader) h.Cookie = cookieHeader;
        const raw = await request(origin, { method, path: p, headers: h, body: payload });
        if (jarOf) jarOf.take(raw.headers);
        const res = { ...raw, json: () => JSON.parse(raw.body.toString("utf8")) };
        if (learn) for (const [k, v] of Object.entries(learn(res))) if (v) norm.learn(k, String(v));
        const response = norm.response(raw, { staticAsset });
        // A reduced step records an outline of its body, so not the real body's length either.
        if (reduce) {
          response.body = reduce(res);
          response.headers = response.headers.filter((h) => !/^content-length:/i.test(h));
        }
        steps.push({
          name, ...(file ? { file } : {}),
          request: { method, path: norm.text(p), as: cookie !== undefined ? "custom cookie" : as || "anon" },
          response,
        });
        return res;
      },
    };
    const began = Date.now();
    await scenario(t);
    const recording = {
      server: "worker", recorded_at: new Date().toISOString(),
      wrangler: JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules/wrangler/package.json"), "utf8")).version,
      seconds: Math.round((Date.now() - began) / 100) / 10,
      replaced: norm.counts, steps,
    };
    // Nothing may have failed inside the server while it answered.
    const errors = server.log().split("\n").filter((line) => /Uncaught|✘|\[ERROR\]/.test(line));
    await cleanup();
    if (errors.length) {
      console.error(errors.slice(0, 10).join("\n"));
      die(`the server logged ${errors.length} errors while the scenario ran`);
    }

    // 4. Write it, or compare it.
    if (o.record) {
      fs.mkdirSync(path.dirname(path.resolve(o.record)), { recursive: true });
      fs.writeFileSync(path.resolve(o.record), JSON.stringify(recording, null, 1) + "\n");
      console.log(`parity: recorded ${steps.length} steps in ${recording.seconds} s -> ${o.record}`);
      console.log(`parity: replaced ${JSON.stringify(norm.counts)}`);
      process.exit(0);
    }
    const disk = new Set(onDisk);
    const skipped = new Set(golden.steps.filter((s) => s.file && !disk.has(s.file)).map((s) => s.name));
    const recordedFiles = new Set(golden.steps.filter((s) => s.file).map((s) => s.file));
    const added = new Set(steps.filter((s) => s.file && !recordedFiles.has(s.file)).map((s) => s.name));
    const live = { ...recording, steps: steps.filter((s) => !added.has(s.name)) };
    const { lines, compared } = compare(golden, live, { skipped });
    // Each new file once, by name (its steps, "static in" and "static out", are the same file).
    const newFiles = [...new Set(steps.filter((s) => added.has(s.name)).map((s) => s.file))].sort();
    for (const f of newFiles) lines.push(`UNRECORDED public/${f}: a file with no step in the recording, so how it is served is held by nothing. Record again (checks/parity/README.md).`);
    for (const l of lines) console.log(l);
    if (skipped.size) console.log(`parity: ${skipped.size} recorded steps skipped: their file is no longer in public/`);
    console.log(`parity: ${compared} steps compared with ${o.compare}, ${lines.length} differences`);
    process.exit(lines.length ? 1 : 0);
  } catch (e) {
    await cleanup();
    console.error(e instanceof CheckError ? `parity: ${e.message}` : (e && e.stack) || e);
    process.exit(2);
  }
}

main();

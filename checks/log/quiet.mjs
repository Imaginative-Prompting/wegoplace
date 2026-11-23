// What the site's log may hold: never a person's words, a trip's titles, a document's text, a phone's push address or
// a key. Cloudflare keeps every line a Worker writes (src/log.js says why an error's message is the danger).
//
//   node checks/log/quiet.mjs            (npm run check:quiet-logs)
//
// 1. errorLine() on the live site: an error's name, code and frames, never its message (a planted SyntaxError quoting a
//    trip's title, a planted push error naming a phone's address); on this machine the message comes too.
// 2. The assistant's refusal line (src/assistant/provider.js refusalForLog) on the live site: OpenRouter's code and the
//    provider's name, never its words or raw error (a planted refusal quoting a title shorter than refusalText's filter).
// 3. EVERY console call under src/: each one either hands its error to errorLine() or is on QUIET below, the list of
//    lines that carry none of it, each with why. A call on neither fails, a line on QUIET that is no longer in the
//    source fails (the list stays the source's), and a QUIET line that prints an error's message or stack fails.
//    Plants (QUIET_PLANT): raw (a line printing String(e.stack) added to what is read: caught), message (a QUIET line
//    made to print e.message: caught), stale (a QUIET entry whose line is gone: caught).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Report } from "../lib/person.mjs";
import { errorLine } from "../../src/log.js";
import { refusalForLog } from "../../src/assistant/provider.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLANT = process.env.QUIET_PLANT ?? "";
const t = new Report("what the site's log may hold");

// The lines that carry nothing of a person's: [file, a piece of the line that finds it, why].
const QUIET = [
  ["src/assistant/provider.js", "assistant_call:", "status, finish reason, reasoning tokens, the fallback's id; its error is refusalForLog's: on the live site OpenRouter's code and the provider's name only (part 2)"],
  ["src/mcp/tools.js", "mcp_rollback_left:", "a count of rows and a change's id"],
  ["src/push/routes.js", "chat_push:", "a trip's id and counts (sent, gone, failed); never a subscription's address"],
  ["src/api/fx.js", "FX_PROVIDER_URL is not a loopback", "a fixed sentence about a setting"],
  ["src/api/fx.js", "[fx] provider rejected:", "why the rates' provider refused: our own words, its HTTP status, or its fetch error, which names only the rates' fixed address; no person is in a rates call"],
  ["src/trips/links.js", "wgp-watch guest", "a fixed word the watch counts"],
  ["src/accounts/passkeys.js", "wgp-watch signup", "a fixed word the watch counts"],
  ["src/accounts/providers.js", "wgp-watch signups_paused", "a fixed word the watch counts"],
  ["src/accounts/providers.js", "wgp-watch signup\");", "a fixed word the watch counts"],
  ["src/query-count.js", "d1_queries:", "counts and a request's path, written only on a check's own server (countingOn: COUNT_QUERIES and a loopback PUBLIC_ORIGIN), never live"],
  ["src/map/cut.js", "map_cut: tripId, bytes", "a trip's id and counts"],
  ["src/map/map-object.js", "map_cut: trip, ...result", "a cut's numbers: its areas' names counted (leftOut), its failure's words left out (why)"],
  ["src/map/routes.js", "map_uploaded:", "a trip's and an account's ids, and bytes"],
  ["src/map/wikimedia.js", "WIKIMEDIA_API_VIA is not a loopback", "a fixed sentence about a setting"],
  ["src/trips/pictures.js", "PICTURE_FETCH_VIA is not a loopback", "a fixed sentence about a setting"],
  ["src/trips/drain.js", "files_to_delete:", "a count, and a query for a person to run"],
  ["src/mcp/oauth.js", "oauth_error:", "the OAuth library's code and status; its `internal` description, which can echo what a client sent, left out"],
];
// What prints an error's words: its message, its stack, or the error itself as a string.
const RAW = /\b(e|err|error)\??\.(message|stack)\b|String\(\s*(e|err|error)\s*\)|String\(\s*(e|err|error)\?\.(message|stack)/;

try {
  t.part("1. errorLine(): an error's name, code and frames, never its words, on the live site");
  const live = { PUBLIC_ORIGIN: "https://wegoplace.com" }, here = { PUBLIC_ORIGIN: "http://localhost:8911" };
  const TITLE = "Anne Frank Huis 9:00";
  let parse;
  // A model's tool call that isn't JSON: V8's SyntaxError quotes the text it read.
  try { JSON.parse(TITLE); } catch (e) { parse = e; }
  t.ok("(the plant: the SyntaxError's own message quotes the title)", String(parse?.message).includes("Anne Frank"), String(parse?.message));
  const push = Object.assign(new Error("push refused: https://push.example.net/send/fA9-made-up-device-token"), { code: 410 });
  const lines = [JSON.stringify(errorLine(parse, live)), JSON.stringify(errorLine(push, live)), JSON.stringify(errorLine(parse))];
  t.ok("a SyntaxError quoting a title: its name and frames, not the title", !lines[0].includes("Anne") && /"name":"SyntaxError"/.test(lines[0]) && /"at":"at /.test(lines[0]), lines[0].slice(0, 200));
  t.ok("  a push error naming a phone's address: its code, not the address", !lines[1].includes("push.example.net") && /"code":410/.test(lines[1]), lines[1].slice(0, 200));
  t.ok("  with no env at all (a line that has none in reach): the same, nothing of the message", !lines[2].includes("Anne") && !/"message"/.test(lines[2]), lines[2].slice(0, 200));
  t.ok("  on this machine (wrangler dev) the message comes too", JSON.stringify(errorLine(parse, here)).includes("Anne"), "");
  t.ok("  something thrown that isn't an Error: its type, nothing of it", JSON.stringify(errorLine("a plan called Rijksmuseum", live)) === '{"name":"string","code":null,"at":null}', JSON.stringify(errorLine("a plan called Rijksmuseum", live)));

  t.part("2. The assistant's refusal line: OpenRouter's code and the provider, never its words");
  const refusal = { error: { message: "Invalid value for 'title': 'Rijksmuseum'", code: 400, metadata: { provider_name: "Google", raw: '{"error":{"message":"bad title Rijksmuseum"}}' } } };
  const said = refusalForLog(live, refusal, "plan Rijksmuseum at 10");
  t.same("on the live site: the code and the provider", said, "code 400 | Google");
  t.ok("  on this machine: refusalText's words, as the bake-off records them", /Invalid value/.test(refusalForLog(here, refusal, "") ?? ""), refusalForLog(here, refusal, ""));

  t.part("3. Every console call under src/: through errorLine(), or on QUIET with why");
  const files = [];
  const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else if (/\.(m?js)$/.test(n.name)) files.push(p); } };
  walk(path.join(ROOT, "src"));
  const calls = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => { if (/console\.(log|warn|error|info|debug)\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) calls.push({ rel, at: i + 1, line }); });
  }
  if (PLANT === "raw") calls.push({ rel: "src/planted.js", at: 1, line: 'console.error(JSON.stringify({ planted: String(e?.stack || e) }));' });
  const quiet = PLANT === "stale" ? [...QUIET, ["src/index.js", "a line that isn't there", "planted"]] : QUIET;
  const used = new Set(), loose = [], raw = [];
  for (const c of calls) {
    const line = PLANT === "message" && c.line.includes("map_uploaded:") ? c.line.replace("bytes: row.bytes", "bytes: row.bytes, error: e.message") : c.line;
    if (/errorLine\(/.test(line) && !RAW.test(line.replace(/errorLine\([^)]*\)/g, ""))) continue;
    const q = quiet.findIndex(([f, piece]) => f === c.rel && line.includes(piece));
    if (q < 0) { loose.push(`${c.rel}:${c.at} ${line.trim().slice(0, 140)}`); continue; }
    used.add(q);
    if (RAW.test(line)) raw.push(`${c.rel}:${c.at} ${line.trim().slice(0, 140)}`);
  }
  const stale = quiet.filter((_, i) => !used.has(i)).map(([f, piece]) => `${f}: "${piece}"`);
  const through = calls.filter((c) => /errorLine\(/.test(c.line)).length;
  t.ok(`every console call goes through errorLine() or is on QUIET (${calls.length} calls: ${through} through errorLine, ${calls.length - through} on QUIET)`, loose.length === 0, loose.join(" || "));
  t.ok("  no line on QUIET prints an error's message, stack or the error itself", raw.length === 0, raw.join(" || "));
  t.ok("  every QUIET entry still finds its line (the list is the source's, not a memory of it)", stale.length === 0, stale.join(" || "));
  t.ok("  and each says why", QUIET.every(([, , why]) => typeof why === "string" && why.length > 20), "");
} catch (error) {
  console.error(error);
  t.end();
  process.exit(2);
}
process.exit(t.end());

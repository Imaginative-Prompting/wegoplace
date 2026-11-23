#!/usr/bin/env node
// Every refusal the server can send, read out of its code, grouped by what the person was trying
// to do, for a person to read as the person refused would.
//
//   node tools/refusals.mjs --out <refusals.md>       (outside the tree, or anywhere: no data in it)
//
// A refusal is a call that answers 4xx or 5xx in words: err(status, "code", { reason, … }),
// json({ error, reason }, status), answer({ error }, status), refuse(status, "code"),
// plain(status, "words"), and the MCP tools' failure({ error, reason }). Each is listed with its
// status, its code, its sentence (a template's ${…} left as it is) and where it is.
//
// MARKED ⚠: a refusal a person can't act on from what it says: no sentence, and nothing that says
// what would be taken instead (`need`, `allowed`, `kinds`, `max`, `lists`, `bags`, `modes`,
// `rows`). check:refusals holds that every such call the code holds is read here.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SRC = path.join(ROOT, "src");

// What the person was doing, by file and (where one file does several things) by function.
const DOING = [
  [/accounts\/passkeys\.js/, "Signing up or in with a passkey"],
  [/accounts\/providers\.js/, "Signing in with Google or GitHub"],
  [/accounts\/email\.js/, "An email for getting back in"],
  [/accounts\/link\.js/, "A one-use sign-in link"],
  [/accounts\/(account|delete|apps)\.js/, "Their account: its ways in, signing out, deleting it, its AI apps"],
  [/accounts\/(signups|sessions|util|challenges)\.js/, "Signing in at all (limits, sessions)"],
  [/api\/me\.js/, "Their name and settings"],
  [/gate\.js/, "Any request (the gate)"],
  [/trips\/trips\.js:(createTrip)/, "Making a trip"],
  [/trips\/trips\.js:(patchTrip)/, "Changing a trip's details"],
  [/trips\/trips\.js:(deleteTrip)/, "Deleting a trip"],
  [/trips\/trips\.js/, "Trips"],
  [/trips\/links\.js/, "Inviting people: join links, and joining"],
  [/trips\/members\.js/, "The people on a trip: leaving, removing, handing over"],
  [/trips\/access\.js/, "Reaching a trip"],
  [/trips\/areas\.js/, "A trip's areas"],
  [/api\/places\.js/, "Places"],
  [/api\/events\.js/, "The itinerary"],
  [/api\/notes\.js/, "Notes on events"],
  [/api\/packing/, "Packing"],
  [/api\/purchases\.js/, "Split: purchases and payments"],
  [/trips\/pictures\.js/, "Pictures"],
  [/trips\/storage\.js/, "Storage"],
  [/api\/media\.js|media-files\.js/, "Photos and videos (uploading, opening)"],
  [/api\/memories\.js/, "Memories"],
  [/api\/collage\.js|share-page\.js/, "Shared boards"],
  [/trips\/changes\.js/, "The list of changes, and undo"],
  [/mcp\/oauth\.js/, "Connecting an AI app"],
  [/mcp\//, "An AI app working on a trip (the MCP)"],
  [/tiles\.js/, "The map"],
  [/api\/fx\.js/, "Exchange rates"],
  [/old-addresses\.js|index\.js|static\.js|routes\.js/, "Addresses (no such route, wrong method)"],
];
const doing = (file, fn) => DOING.find(([re]) => re.test(`${file}:${fn}`) || re.test(file))?.[1] ?? "Other";

/** The source from `open` (an opening bracket's index) to its matching close: strings, templates and comments skipped. */
export function balanced(src, open) {
  const close = { "(": ")", "{": "}", "[": "]" };
  const stack = [close[src[open]]];
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) {
        if (src[i] === "\\") i++;
        else if (c === "`" && src[i] === "$" && src[i + 1] === "{") { const end = balanced(src, i + 1); i = end; }
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c in close) stack.push(close[c]);
    else if (c === stack.at(-1)) { stack.pop(); if (!stack.length) return i; }
  }
  return -1;
}

/** A call's arguments, split at its top-level commas (quotes, templates and brackets kept whole). */
function splitArgs(args) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < args.length && args[i] !== c; i++) {
        if (args[i] === "\\") i++;
        else if (c === "`" && args[i] === "$" && args[i + 1] === "{") i = balanced(args, i + 1);
      }
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) { parts.push(args.slice(from, i).trim()); from = i + 1; }
  }
  parts.push(args.slice(from).trim());
  return parts;
}

const literal = (s) => {
  const m = /^\s*(["'`])([\s\S]*?)\1/.exec(s ?? "");
  return m ? m[2].replace(/\\(["'`])/g, "$1") : null;
};
/** A key's value in an object literal's source, as written (its literal when it is one). */
function keyIn(obj, key) {
  const m = new RegExp(`(?:^|[,{\\s])${key}\\s*:\\s*`).exec(obj);
  if (!m) return new RegExp(`[{,]\\s*${key}\\s*[,}]`).test(obj) ? `(its ${key})` : null;   // shorthand: { rows }
  const rest = obj.slice(m.index + m[0].length);
  const lit = literal(rest);
  if (lit !== null && /^\s*["'`]/.test(rest) && splitArgs(rest.replace(/\s*}\s*$/, ""))[0].trim().length === rest.trim().indexOf(lit) + lit.length + 1) return lit;
  // Not one string: worked out by the code from the request.
  return `(worked out: ${splitArgs(rest.replace(/\s*}\s*$/, ""))[0].slice(0, 80)})`;
}
const ACT = ["need", "allowed", "kinds", "max", "lists", "bags", "modes", "rows", "allow"];

// The sign-in and account pages' own sentences for the server's short codes (public/js/auth.js
// SERVER_WORDS): what a person reads when those routes refuse.
const PAGE_WORDS = Object.fromEntries([...(fs.readFileSync(path.join(ROOT, "public/js/auth.js"), "utf8").match(/const SERVER_WORDS = \{([\s\S]*?)\n\};/)?.[1] ?? "")
  .matchAll(/"([^"]+)":\s*\["[^"]*",\s*"([^"]+)"\]/g)].map((m) => [m[1], m[2]]));

/** Every refusal call in one file. */
export function refusalsIn(file, src) {
  const out = [];
  const fnAt = (i) => {
    const before = src.slice(0, i);
    // The top-level function it's in (a line that starts the function), not an inline helper.
    const m = [...before.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)|^(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/gm)].at(-1);
    return m ? m[1] ?? m[2] : "";
  };
  const lineAt = (i) => src.slice(0, i).split("\n").length;
  const add = (i, status, code, obj, end = i) => {
    const reason = obj ? keyIn(obj, "reason") ?? keyIn(obj, "error_description") : null;
    const acts = obj ? ACT.filter((k) => keyIn(obj, k) !== null) : [];
    const page = PAGE_WORDS[code];
    out.push({ file, line: lineAt(i), fn: fnAt(i), status, code, reason: reason ?? (page ? `(the page says) ${page}` : null), acts, span: [i, end] });
  };
  // err(status, "code", { … })   and   refuse(status, "code")   and   plain(status, "words")
  for (const m of src.matchAll(/\b(err|refuse|plain|fetchRefused)\(/g)) {
    const open = m.index + m[0].length - 1;
    if (/function\s*$|const\s+\w+\s*=\s*$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
    const end = balanced(src, open);
    const args = src.slice(open + 1, end);
    if (m[1] === "fetchRefused") { add(m.index, 400, "fetch failed", `{ reason: ${args} }`, end); continue; }
    const status = Number((/^\s*(\d{3})/.exec(args) ?? [])[1]) || null;
    const rest = args.replace(/^\s*\d{3}\s*,\s*/, "");
    const code = literal(rest) ?? rest.split(",")[0].trim();
    const objStart = rest.indexOf("{");
    const obj = objStart >= 0 ? rest.slice(objStart) : null;
    add(m.index, status, code, m[1] === "plain" ? `{ reason: "${code}" }` : obj, end);
  }
  // The passkey routes' fail("code"[, status]): a code; the sign-in page holds its sentence.
  for (const m of src.matchAll(/\bfail\(\s*(["'])/g)) {
    const open = src.indexOf("(", m.index);
    const end = balanced(src, open);
    const args = src.slice(open + 1, end);
    // A batch's row refused the same way (packing.js putItems' fail("code", { reason })) carries its words.
    const second = splitArgs(args)[1]?.trim();
    add(m.index, Number((/,\s*(\d{3})\s*$/.exec(args) ?? [])[1]) || 400, literal(args), second?.startsWith("{") ? second : null, end);
  }
  // oauthRefusal(request, status, "code", "words") and the approval page's messagePage("title", "words", status).
  for (const m of src.matchAll(/\b(oauthRefusal|messagePage)\(/g)) {
    if (/function\s*$|const\s+\w+\s*=\s*$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
    const open = m.index + m[0].length - 1;
    const end = balanced(src, open);
    const args = src.slice(open + 1, end);
    if (/^\s*\(?\s*[a-z]+\s*,\s*[a-z]+/.test(args) && m[1] === "oauthRefusal" && !/\d{3}/.test(args)) continue;
    const parts = splitArgs(args);
    if (m[1] === "oauthRefusal") add(m.index, Number(parts[1]) || null, literal(parts[2]), `{ reason: ${parts.slice(3).join(", ")} }`, end);
    else add(m.index, Number(parts.at(-1)) || 400, literal(parts[0]), `{ reason: ${parts[1]} }`, end);
  }
  // Refusals thrown and answered elsewhere: new EmailError("code", status, { … }) (src/accounts/email.js),
  // new UndoRefused(status, "code", "words") (src/trips/changes.js), and new BillingError("words", status,
  // "code") (src/billing/plan.js) and new AssistantError("words", status, "code", { … }) (src/assistant/).
  for (const m of src.matchAll(/new (EmailError|UndoRefused|BillingError|AssistantError)\(/g)) {
    if (/class\s+\w+\s+extends\s*$/.test(src.slice(Math.max(0, m.index - 40), m.index))) continue;
    const open = m.index + m[0].length - 1;
    const end = balanced(src, open);
    const parts = splitArgs(src.slice(open + 1, end));
    if (m[1] === "EmailError") add(m.index, Number(parts[1]) || 400, literal(parts[0]), parts[2] ?? null, end);
    else if (m[1] === "UndoRefused") add(m.index, Number(parts[0]) || null, literal(parts[1]), `{ reason: ${parts.slice(2).join(", ")} }`, end);
    else add(m.index, Number(parts[1]) || null, literal(parts[2]), `{ reason: ${parts[0]} }`, end);
  }
  // new Response(JSON.stringify({ error … }), { status … })
  for (const m of src.matchAll(/new Response\(JSON\.stringify\(\s*\{\s*error\s*:/g)) {
    const open = src.indexOf("{", m.index);
    const end = balanced(src, open);
    const obj = src.slice(open, end + 1);
    const status = Number((/status\s*:\s*(\d{3})/.exec(src.slice(end, end + 200)) ?? [])[1]) || null;
    add(m.index, status, keyIn(obj, "error"), obj, end);
  }
  // json({ error … }, status)   answer({ error … }, status)   failure({ error … })
  for (const m of src.matchAll(/\b(json|answer|failure)\(\s*\{\s*error\s*:/g)) {
    const open = src.indexOf("{", m.index);
    const end = balanced(src, open);
    const obj = src.slice(open, end + 1);
    const status = Number((/^\s*,\s*(\d{3})/.exec(src.slice(end + 1)) ?? [])[1]) || (m[1] === "failure" ? "tool" : null);
    const code = keyIn(obj, "error");
    // A relay of a refusal thrown elsewhere (its code a variable: error.message, e.error): read,
    // so the check counts it, but listed where it was thrown.
    if (code !== null && !/^[\w ,.'()-]*$/.test(code.replace(/^\(its error\)$/, "x")) || /^(error\.|e\.)/.test(code ?? "")) { out.push({ file, line: lineAt(m.index), relay: true, span: [m.index, end] }); continue; }
    add(m.index, status, code, obj, end);
  }
  return out.sort((x, y) => x.span[0] - y.span[0]);
}

/** Every refusal in src/. */
export function allRefusals({ withRelays = false } = {}) {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) files.push(p); } };
  walk(SRC);
  const all = files.flatMap((f) => refusalsIn(path.relative(ROOT, f), fs.readFileSync(f, "utf8")));
  return withRelays ? all : all.filter((r) => !r.relay);
}

/** What a plain search finds that looks like a refusal, file by file: each must be inside a read refusal. */
export function unread(list) {
  const LOOKS = /\berr\(\s*\d{3}|\b(json|answer|failure)\(\s*\{\s*error\s*:|\b(refuse|plain)\(\s*\d{3}|\bfail\(\s*["']|\bmessagePage\(\s*["'`]|\boauthRefusal\(\s*request\s*,\s*\d{3}|JSON\.stringify\(\s*\{\s*error\s*:|\bfetchRefused\(\s*["'`a-z]/g;
  const byFile = new Map();
  for (const r of list) (byFile.get(r.file) ?? byFile.set(r.file, []).get(r.file)).push(r.span);
  const missed = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) {
    const src = fs.readFileSync(p, "utf8");
    const file = path.relative(ROOT, p);
    for (const m of src.matchAll(LOOKS)) {
      const line = src.slice(0, m.index).split("\n").length;
      const text = src.split("\n")[line - 1].trim();
      if (/^\s*(\/\/|\*)/.test(text) || /^(export\s+)?(const|function|async function)\s+\w+\s*=?\s*(async\s*)?\(?/.test(text) && /=>|function/.test(text) && !/return/.test(text) && /\b(err|fail|refuse|plain|oauthRefusal|messagePage|fetchRefused)\s*=|function\s+(err|fail|refuse|plain|oauthRefusal|messagePage|fetchRefused)\b/.test(text)) continue;
      if (!(byFile.get(file) ?? []).some(([a, b]) => m.index >= a - 1 && m.index <= b + 1)) missed.push(`${file}:${line}: ${text.slice(0, 100)}`);
    }
  } } };
  walk(SRC);
  return missed;
}

// Two kinds of refusal. One a person or an AI can cause carries a sentence
// saying what would be taken instead: its `reason` (or the sign-in page's words for its code), a
// batch's `rows` (each row its own), or a code that is itself a sentence. One only the app's own
// code can cause is on PROTOCOL below, by name, and needs none. check:refusals fails on any that is
// neither, so a new refusal has to be one or the other.
//
// Each entry: the codes, where they may come from ("file:function", a pattern; any when absent),
// and why no person or AI can cause it.
export const PROTOCOL = [
  { code: /^(bad id|bad ids|id required|id already exists|id in path and body disagree)$/, why: "an id the app's code makes or carries in the path; the MCP's schemas hold an AI's ids" },
  { code: /^(no such route|no such media route|method not allowed)$/, why: "an address or method only code asks for" },
  { code: /^not found$/, where: /^src\/api\/(collage|memories)\.js:onRequest$/, why: "a path under a route that has nothing there" },
  { code: /^bad address$/, where: /^src\/trips\/pictures\.js:/, why: "a path that can't be decoded" },
  { code: /^too many rows$/, why: "a batch past ROWS_PER_WRITE_MAX: the app sends fewer, and the MCP's schemas refuse more before the route" },
  { code: /^bad (events|places|items|areas|lists|starters|bags|ticked|key)$/, why: "a request body of the wrong shape (its need says the shape); the app's code and the MCP's tools build them" },
  { code: /^bad anchor_kind$|^event_id required$/, where: /^src\/api\/notes\.js:/, why: "the app's code says what a note hangs on" },
  { code: /^(bad key|bad uploadId|no such upload|upload already.*|uploadId mismatch|bad part number|could not read part body|wrong part size|part count mismatch|bad part entry|parts must be 1\.\.N with no gaps|bytes must be a positive integer|too many parts)$/, where: /^src\/api\/media\.js:/, why: "an upload's keys, handles and parts, which the app's uploader makes" },
  { code: /^(bad thumb mime|bad for key|no such original|for must name an original|could not read thumb body|empty thumb|thumb too large)$/, where: /^src\/api\/media\.js:thumb$/, why: "a thumbnail the app's code draws and names" },
  { code: /^(bad media key|bad thumb key|duplicate key in one memory|unknown media key|upload not finished|key is not an original|media already attached|unknown thumb key|thumb_key is not a thumb|thumb not finished|thumb already attached|framing must be an object keyed by media id)$/, where: /^src\/api\/memories\.js:/, why: "a memory's media keys and framing, which the app's code sends" },
  { code: /^(unsupported image type|no image|unsupported video type|no video|unsupported type|no bytes)$/, where: /^src\/api\/collage\.js:/, why: "a board's files, which the app's code draws and encodes" },
  { code: /^(MEDIA|TILES) bucket not bound$|^live updates off$/, why: "the site's own setup" },
  { code: /^(websocket only|cross site|unauthorized)$/, where: /^src\/trips\/live\.js:/, why: "a trip's live socket, which only the app's own page opens (another site's page is refused: the point)" },
  { code: /^(not found|method not allowed|bad range)$/, where: /^src\/(media-files|tiles)\.js:/, why: "a file's own address, asked for by the app's images, videos and map; the plain-text body is read by nobody" },
  { status: /^50[02]$/, why: "the server or its storage failed: nothing the request could change" },
];
export const protocolOf = (r) => PROTOCOL.find((p) => (p.code ? p.code.test(r.code ?? "") : true) && (p.status ? p.status.test(String(r.status)) : true) && (!p.where || p.where.test(`${r.file}:${r.fn}`))) ?? null;
/** It says what a person or an AI would act on. Words that only repeat the code (a plain body's "not found") aren't a sentence. */
const repeats = (r) => r.reason.trim().replace(/[.\s]+$/, "").toLowerCase() === String(r.code ?? "").trim().toLowerCase();
export const hasSentence = (r) => Boolean((r.reason && r.reason.trim() && !repeats(r)) || r.acts.includes("rows") || /\.$/.test(r.code ?? ""));
export const actionable = (r) => hasSentence(r) || Boolean(protocolOf(r));

export function report(list) {
  const groups = new Map();
  for (const r of list) {
    const g = doing(r.file, r.fn);
    (groups.get(g) ?? groups.set(g, []).get(g)).push(r);
  }
  const marked = list.filter((r) => !actionable(r)).length;
  const lines = [
    "# Every refusal the server can send",
    "",
    `Read out of the code by tools/refusals.mjs: ${list.length} refusals, grouped by what the person was trying to do. ` +
      `A refusal a person or an AI can cause says what would be taken instead; one only the app's own code can cause is on the extractor's PROTOCOL list and marked "protocol" here, with why (${list.filter((r) => !hasSentence(r) && protocolOf(r)).length} of them). ` +
      `⚠ marks one that is neither (${marked}); check:refusals fails while any is. ` +
      "A sentence written with `${…}` fills that in from the request.",
    "",
  ];
  for (const [g, rs] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${g} (${rs.length})`, "");
    for (const r of rs) {
      const p = hasSentence(r) ? null : protocolOf(r);
      const words = r.reason && !repeats(r) ? r.reason.replace(/\s+/g, " ") : r.acts.includes("rows") ? "(each refused row with its own sentence)" : /\.$/.test(r.code ?? "") ? "(the code is the sentence)" : p ? `(protocol: ${p.why})` : r.acts.length ? `(no sentence; it names: ${r.acts.join(", ")})` : "(no sentence)";
      lines.push(`- ${actionable(r) ? "" : "⚠ "}**${r.status ?? "?"} ${r.code ?? "?"}**: ${words} — \`${r.file}:${r.line}\`${r.fn ? ` (${r.fn})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--out");
  const out = i < 0 ? null : argv[i + 1];
  const list = allRefusals();
  const text = report(list);
  if (out) { fs.writeFileSync(out, text + "\n"); console.log(`${list.length} refusals, ${list.filter((r) => !actionable(r)).length} marked; written to ${out}`); }
  else process.stdout.write(text + "\n");
}

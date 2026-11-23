#!/usr/bin/env node
// Calls one MCP tool, as an AI app would: so anything with a shell can drive a WeGoPlace site's
// MCP (a local one: `wrangler dev`, or the cutover's rehearsal).
//
//   WGP_SESSION=<a signed-in session> node tools/mcp-call.mjs --base <origin> --tokens <file> <tool> [<args.json> | -]
//   WGP_SESSION=…                     node tools/mcp-call.mjs --base <origin> --tokens <file> --list
//
// The first call connects an app named "mcp-call" (or --app <name>) the way any app does:
// registration, the approval page opened with the person's session, Allow, the code traded for
// tokens. The tokens go in --tokens (a file outside the tree, readable only by you), and later
// calls use them, refreshing as needed, with no session. The session comes from the environment
// at run time only: never an argument (it would sit in the shell's history), never written down.
// The tool's arguments are a JSON file, or `-` for standard input. Exits 0 with the tool's
// answer on standard output, 1 when the tool refused (its words on standard output), 2 when it
// couldn't run.

import fs from "node:fs";
import path from "node:path";
import { McpClient, connect, token } from "../checks/lib/mcp.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const argv = process.argv.slice(2);
const flag = (name, d = null) => { const i = argv.indexOf(name); return i < 0 ? d : argv.splice(i, 2)[1]; };
const fail = (words) => { console.error(words); process.exit(2); };

/** A browser holding one session cookie and what a page sets, for the approval page. */
function browser(base, session) {
  const jar = new Map([["wgp_session", session]]);
  return {
    async call(method, at, body, { page = false, form = false } = {}) {
      const headers = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
      if (page) headers.Accept = "text/html";
      if (method !== "GET") headers.Origin = new URL(base).origin;
      if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
      const res = await fetch(new URL(at, base), { method, headers, redirect: "manual", body: body ? (form ? new URLSearchParams(body).toString() : JSON.stringify(body)) : undefined });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      return { status: res.status, text: await res.text(), location: res.headers.get("location"), headers: [...res.headers] };
    },
  };
}

async function tokens(base, file, appName) {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* none yet */ }
  if (saved?.base === base && saved.access_token && saved.expires_at > Date.now() / 1000 + 60) return saved.access_token;
  if (saved?.base === base && saved.refresh_token) {
    const r = await token(base, { grant_type: "refresh_token", refresh_token: saved.refresh_token, client_id: saved.client_id });
    if (r.status === 200) return keep(file, base, saved.client_id, r.json);
  }
  const session = process.env.WGP_SESSION;
  if (!session) fail("refused: no saved connection, and the person's session comes from WGP_SESSION in the environment, which isn't set.");
  const c = await connect(base, browser(base, session), { name: appName });
  if (c.tokens?.status !== 200) {
    fail(`couldn't connect: ${JSON.stringify({ registration: c.client?.status, page: c.page?.status, approved: c.decided?.status, tokens: c.tokens?.status ?? null })}${c.page?.status === 401 || c.page?.status === 302 ? " (the session isn't signed in)" : ""}`);
  }
  return keep(file, base, c.clientId, c.tokens.json);
}

function keep(file, base, clientId, t) {
  fs.writeFileSync(file, JSON.stringify({ base, client_id: clientId, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (t.expires_in ?? 3600) }), { mode: 0o600 });
  return t.access_token;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = flag("--base");
  const file = flag("--tokens");
  const appName = flag("--app", "mcp-call");
  const list = argv.includes("--list");
  const [tool, argsFile] = argv.filter((a) => a !== "--list");
  if (!base || !file || (!list && !tool)) fail("usage: WGP_SESSION=… node tools/mcp-call.mjs --base <origin> --tokens <file> (<tool> [<args.json> | -] | --list)");
  if (!path.relative(ROOT, path.resolve(file)).startsWith("..")) fail("refused: --tokens is outside the tree (it holds a connection to an account).");
  const mcp = new McpClient(base, await tokens(base, path.resolve(file), appName));
  await mcp.initialize();
  if (list) {
    const r = await mcp.rpc("tools/list");
    for (const t of r.result?.tools ?? []) console.log(`${t.name}\t${t.description.split(". ")[0]}.`);
    process.exit(r.status === 200 ? 0 : 2);
  }
  const raw = argsFile === "-" ? fs.readFileSync(0, "utf8") : argsFile ? fs.readFileSync(argsFile, "utf8") : "{}";
  let args;
  try { args = JSON.parse(raw); } catch (e) { fail(`the arguments aren't JSON: ${e.message}`); }
  const r = await mcp.call(tool, args);
  console.log(r.text);
  process.exit(r.isError ? 1 : 0);
}

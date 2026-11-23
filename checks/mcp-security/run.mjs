// THE AI CONNECTION'S SECURITY, one test per rule (checks/mcp-security/rules.mjs: every MUST that binds WeGoPlace as an
// OAuth authorization server and an MCP server, in its source's words). A rule with no test fails, and so does a test
// with no rule. Two servers of its own: the checks' usual one, and one with global_fetch_strictly_public kept as
// production has it (client metadata documents are fetched only so). The provider's client metadata document fetch
// is also run in Node (checks/mcp-security/cimd-lib.mjs), on the installed library's own code with fetch stood in.
// Everyone in it is made up; nothing reaches the network.
//
//   node checks/mcp-security/run.mjs [--port <n>] [--strict-port <n>]   (free ports when not named)

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CheckError, freePort, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { consentForm, McpClient } from "../lib/mcp.mjs";
import { TOOLS } from "../../src/mcp/tools.js";
import { grantOfToken } from "../../src/mcp/oauth.js";
import { RULES } from "./rules.mjs";
import { cimdLibraryTests } from "./cimd-lib.mjs";

const argv = process.argv.slice(2);
const flag = (name, d) => (argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : d);
const port = flag("--port", null) ?? await freePort();
const strictPort = flag("--strict-port", null) ?? await freePort({ avoid: [port] });
const t = new Report("the AI connection's security, rule by rule");
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const LOOP = "http://127.0.0.1:9/callback";

function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash("sha256").update(verifier).digest()) };
}

const TESTS = {};
const test = (id, fn) => { if (TESTS[id]) throw new CheckError(`two tests for ${id}`); TESTS[id] = fn; };

let server, strict, code = 1;
try {
  server = await startServer({ name: "mcp-security", port });
  await server.start();
  const o = server.origin;
  const resource = `${o}/mcp`;

  // ── an app, as the protocol has it ──
  async function register(redirects = [LOOP], extra = {}, address) {
    const res = await fetch(`${o}/register`, { method: "POST", headers: { "Content-Type": "application/json", ...(address ? { "CF-Connecting-IP": address } : {}) },
      body: JSON.stringify({ client_name: "Security Check App", redirect_uris: redirects, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...extra }) });
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  /** The authorization request's query: S256 PKCE, this server's resource, unless told otherwise. */
  function query(clientId, over = {}, { verifier } = {}) {
    const p = pkce();
    const q = { response_type: "code", client_id: clientId, redirect_uri: LOOP, scope: "trips:read trips:write", state: b64url(crypto.randomBytes(8)),
      code_challenge: p.challenge, code_challenge_method: "S256", resource, ...over };
    for (const k of Object.keys(q)) if (q[k] === null) delete q[k];
    return { q: new URLSearchParams(q), verifier: verifier ?? p.verifier, state: q.state, redirect: q.redirect_uri };
  }
  /** The person opens the approval page and answers it. Answers { page, decided, code, back }. */
  async function approve(person, req, { decision = "approve", tamper = null } = {}) {
    const page = await person.call("GET", `/authorize?${req.q}`, null, { page: true });
    if (page.status !== 200) return { page };
    const form = { ...consentForm(page.text), decision, ...(tamper ?? {}) };
    const decided = await person.call("POST", "/authorize", form, { form: true });
    const back = decided.location ? new URL(decided.location, o) : null;
    return { page, decided, back, code: back?.searchParams.get("code") ?? null };
  }
  async function tokenCall(form) {
    const res = await fetch(`${o}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  }
  async function connected(person, { scope = "trips:read trips:write" } = {}) {
    const app = await register();
    const req = query(app.json.client_id, { scope });
    const a = await approve(person, req);
    const tok = await tokenCall({ grant_type: "authorization_code", code: a.code, redirect_uri: LOOP, client_id: app.json.client_id, code_verifier: req.verifier });
    return { clientId: app.json.client_id, tokens: tok.json, status: tok.status };
  }
  const mcpStatus = async (accessToken, { query: inQuery = false } = {}) => {
    const url = inQuery ? `${o}/mcp?access_token=${encodeURIComponent(accessToken)}` : `${o}/mcp`;
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(inQuery || !accessToken ? {} : { Authorization: `Bearer ${accessToken}` }) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    await res.text();
    return { status: res.status, auth: res.headers.get("www-authenticate") ?? "" };
  };
  /** Where the server keeps its KV (the provider's grants), read straight from its file. */
  const kvRows = (prefix) => {
    const files = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".sqlite") && /KV/i.test(p)) files.push(p); } })(server.state);
    const rows = [];
    for (const f of files) {
      const db = new DatabaseSync(f, { readOnly: true });
      try { rows.push(...db.prepare("SELECT key, expiration FROM _mf_entries WHERE key LIKE ?").all(`${prefix}%`)); } catch { /* not the entries table */ } finally { db.close(); }
    }
    return rows;
  };

  const ada = new Person(o, "Ada Secure");
  await ada.signUp();
  const ben = new Person(o, "Ben Secure");
  await ben.signUp();

  // ── discovery ──
  test("prm", async () => {
    const res = await fetch(`${o}/.well-known/oauth-protected-resource/mcp`);
    const j = await res.json().catch(() => null);
    t.ok("the protected resource metadata names this resource and its authorization server", res.status === 200 && j?.resource === resource && Array.isArray(j?.authorization_servers) && j.authorization_servers.length > 0, `${res.status} ${JSON.stringify(j)?.slice(0, 200)}`);
  });
  test("pkce-advertised", async () => {
    const j = await (await fetch(`${o}/.well-known/oauth-authorization-server`)).json();
    t.same("the authorization server's metadata names S256, and only S256", j.code_challenge_methods_supported, ["S256"]);
  });
  test("iss", async () => {
    const j = await (await fetch(`${o}/.well-known/oauth-authorization-server`)).json();
    const app = await register();
    const yes = await approve(ada, query(app.json.client_id));
    const no = await approve(ada, query(app.json.client_id), { decision: "deny" });
    t.same("it advertises iss, and both an Allow's answer and a Cancel's carry it, the metadata's issuer exactly",
      [j.authorization_response_iss_parameter_supported, yes.back?.searchParams.get("iss"), no.back?.searchParams.get("error"), no.back?.searchParams.get("iss")], [true, j.issuer, "access_denied", j.issuer]);
  });
  test("unauthorized-401", async () => {
    const none = await mcpStatus(null), bad = await mcpStatus("u:g:not-a-real-token"), junk = await mcpStatus("x");
    t.same("no token, a made-up one and a malformed one: 401 each, with a Bearer challenge naming the resource metadata",
      [none.status, bad.status, junk.status, /resource_metadata=/.test(none.auth), /Bearer/.test(bad.auth)], [401, 401, 401, true, true]);
  });

  // ── PKCE ──
  test("pkce-required", async () => {
    const app = await register();
    const a = await approve(ada, query(app.json.client_id, { code_challenge: null, code_challenge_method: null }));
    t.same("an authorization request without a code_challenge: refused on the page, no code", [a.page.status >= 400, a.code], [true, null]);
  });
  test("pkce-no-plain", async () => {
    const app = await register();
    const p = pkce();
    const a = await approve(ada, query(app.json.client_id, { code_challenge: p.verifier, code_challenge_method: "plain" }));
    t.same("code_challenge_method plain: refused on the page, no code", [a.page.status >= 400, a.code], [true, null]);
  });
  test("pkce-verified", async () => {
    const app = await register();
    const req = query(app.json.client_id);
    const a = await approve(ada, req);
    const wrong = await tokenCall({ grant_type: "authorization_code", code: a.code, redirect_uri: LOOP, client_id: app.json.client_id, code_verifier: pkce().verifier });
    const none = await tokenCall({ grant_type: "authorization_code", code: a.code, redirect_uri: LOOP, client_id: app.json.client_id });
    t.same("the code with another verifier, or none: refused (invalid_grant / invalid_request), no token", [wrong.status, wrong.json?.access_token ?? null, none.status, none.json?.access_token ?? null], [400, null, 400, null]);
  });

  // ── redirect URIs ──
  test("redirect-exact", async () => {
    const reg = "https://app.check.example/oauth/callback";
    const app = await register([reg]);
    const id = app.json.client_id;
    const tries = {
      "a longer path": `${reg}/more`, "a prefix": "https://app.check.example/oauth/call", "a query added": `${reg}?x=1`, "a trailing slash": `${reg}/`,
      "the host in capitals": "https://APP.check.example/oauth/callback", "http for https": "http://app.check.example/oauth/callback",
      "another port": "https://app.check.example:8443/oauth/callback", "a sub-domain": "https://evil.app.check.example/oauth/callback", "percent-encoded": "https://app.check.example/oauth/%63allback",
    };
    const passed = [];
    for (const [what, uri] of Object.entries(tries)) { const a = await approve(ada, query(id, { redirect_uri: uri })); if (a.page.status === 200 || a.code) passed.push(what); }
    const exact = await approve(ada, query(id, { redirect_uri: reg }));
    t.ok(`a redirect URI that isn't the registered one exactly is refused (${Object.keys(tries).join(", ")}); the exact one is taken`, passed.length === 0 && !!exact.code, passed.join(", "));
  });
  test("redirect-loopback-port", async () => {
    const app = await register(["http://127.0.0.1/callback"]);
    const a = await approve(ada, query(app.json.client_id, { redirect_uri: "http://127.0.0.1:53682/callback" }));
    const path2 = await approve(ada, query(app.json.client_id, { redirect_uri: "http://127.0.0.1:53682/other" }));
    t.same("a loopback redirect registered without a port is taken on any port, and the code goes there; another path still isn't", [!!a.code, a.back?.port, path2.code], [true, "53682", null]);
  });
  test("redirect-never-to-invalid", async () => {
    const app = await register(["https://app.check.example/cb"]);
    const bad = await ada.call("GET", `/authorize?${query(app.json.client_id, { redirect_uri: "https://evil.check.example/cb" }).q}`, null, { page: true });
    const noClient = await ada.call("GET", `/authorize?${query("no-such-client", { redirect_uri: "https://evil.check.example/cb" }).q}`, null, { page: true });
    t.same("a wrong redirect URI, and an unknown client: a page saying so, never a redirect there",
      [bad.status >= 400, /evil\.check\.example/.test(bad.location ?? ""), noClient.status >= 400, /evil\.check\.example/.test(noClient.location ?? "")], [true, false, true, false]);
  });
  test("redirect-https-or-loopback", async () => {
    const plainHttp = await register(["http://app.check.example/cb"]);
    const loop = await register(["http://localhost:4000/cb"]);
    t.same("registering an http redirect that isn't loopback is refused; http on localhost is taken", [plainHttp.status, loop.status === 201 || loop.status === 200], [400, true]);
  });

  // ── the authorization code ──
  test("code-once", async () => {
    const app = await register();
    const req = query(app.json.client_id);
    const a = await approve(ada, req);
    const form = { grant_type: "authorization_code", code: a.code, redirect_uri: LOOP, client_id: app.json.client_id, code_verifier: req.verifier };
    const first = await tokenCall(form), second = await tokenCall(form);
    const firstStill = await mcpStatus(first.json?.access_token);
    t.same("a code buys tokens once; the second try is refused (and the first try's token is revoked with it, a SHOULD)", [first.status, second.status, second.json?.access_token ?? null], [200, 400, null]);
    console.log(`    (the first token after the code's reuse: ${firstStill.status === 401 ? "revoked" : "still works"})`);
  });
  test("code-short", async () => {
    const app = await register();
    const before = new Set(kvRows("grant:").map((r) => r.key));
    await approve(ada, query(app.json.client_id));
    const now = Date.now();
    const fresh = kvRows("grant:").filter((r) => !before.has(r.key));
    const left = fresh.map((r) => (r.expiration ?? Infinity) - now);
    t.ok("an approved, unredeemed code's grant expires within 10 minutes", fresh.length === 1 && left[0] > 0 && left[0] <= 10 * 60_000 + 5_000, `${fresh.length} new grants, ${left.map((x) => Math.round(x / 1000) + " s").join(", ")}`);
  });
  test("code-bound-client", async () => {
    const app = await register(), other = await register();
    const req = query(app.json.client_id);
    const a = await approve(ada, req);
    const stolen = await tokenCall({ grant_type: "authorization_code", code: a.code, redirect_uri: LOOP, client_id: other.json.client_id, code_verifier: req.verifier });
    t.same("a code redeemed by another client is refused", [stolen.status, stolen.json?.access_token ?? null], [400, null]);
  });

  // ── refresh tokens ──
  test("refresh-replay", async () => {
    const refresh = (rt, c) => tokenCall({ grant_type: "refresh_token", refresh_token: rt, client_id: c.clientId });
    // A thief and the app both hold R1. The app refreshes (R1 → R2) and goes on (R2 → R3); the thief then uses R1.
    const c = await connected(ada);
    const r1 = await refresh(c.tokens.refresh_token, c);
    const r2 = await refresh(r1.json?.refresh_token, c);
    const r3 = await refresh(r2.json?.refresh_token, c);
    t.same("refresh tokens rotate: each refresh gives a new one", [r1.status, r2.status, r3.status, new Set([c.tokens.refresh_token, r1.json?.refresh_token, r2.json?.refresh_token, r3.json?.refresh_token]).size], [200, 200, 200, 4]);
    // The app has gone on (R3 → R4); the thief now uses R2, whose successor R3 was used: a replay.
    const r4 = await refresh(r3.json?.refresh_token, c);
    const stale = await refresh(r2.json?.refresh_token, c);
    const newest = await refresh(r4.json?.refresh_token, c);
    const access = await mcpStatus(r4.json?.access_token);
    t.same("a refresh token used again after the one it was traded for was used: refused, and the whole connection with it (the newest refresh token and its access token refused)",
      [r4.status, stale.status, stale.json?.access_token ?? null, newest.status, access.status], [200, 400, null, 400, 401]);
    const d0 = await connected(ada);
    const e1 = await refresh(d0.tokens.refresh_token, d0), e2 = await refresh(e1.json?.refresh_token, d0);
    const older = await refresh(d0.tokens.refresh_token, d0), afterOlder = await mcpStatus(e2.json?.access_token);
    t.same("  (one further back, used again: refused, and the connection with it)", [older.status, afterOlder.status], [400, 401]);
    // An app whose answer was lost asks again with the token it sent: the one allowance, while the new one is unused.
    const d = await connected(ada);
    const lost = await refresh(d.tokens.refresh_token, d);
    const again = await refresh(d.tokens.refresh_token, d);
    const goesOn = await refresh(again.json?.refresh_token, d);
    t.same("  (an app that lost the answer may ask once more with the token it sent, within 2 minutes while the new one is unused, and go on: no replay)", [lost.status, again.status, goesOn.status], [200, 200, 200]);
    // A thief inside that allowance: the app refreshed (R → A), the thief uses R at once (R → T). When the app then uses A,
    // two hands held the token: the connection goes, the thief's T with it.
    const f = await connected(ada);
    const appSide = await refresh(f.tokens.refresh_token, f);
    const thief = await refresh(f.tokens.refresh_token, f);
    const appNext = await refresh(appSide.json?.refresh_token, f);
    const thiefNext = await refresh(thief.json?.refresh_token, f), thiefAccess = await mcpStatus(thief.json?.access_token);
    t.same("  (a thief who uses the token inside that allowance: once the app's own next token is presented, the connection goes, the thief's tokens with it)",
      [appSide.status, thief.status, appNext.status, thiefNext.status, thiefAccess.status], [200, 200, 400, 400, 401]);
  });
  test("refresh-bound-client", async () => {
    const c = await connected(ada), other = await register();
    const r = await tokenCall({ grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: other.json.client_id });
    t.same("a refresh token presented by another client is refused", [r.status, r.json?.access_token ?? null], [400, null]);
  });
  test("refresh-same-scope", async () => {
    const c = await connected(ada, { scope: "trips:read" });
    const r = await tokenCall({ grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: c.clientId, scope: "trips:read trips:write" });
    const granted = r.status === 200 ? (r.json?.scope ?? "trips:read") : "(refused)";
    t.ok("a read-only connection's refresh asking for write too gets no more than read", !/trips:write/.test(granted), `${r.status} scope ${granted}`);
  });

  // ── access tokens at /mcp ──
  test("audience", async () => {
    const app = await register();
    const req = query(app.json.client_id, { resource: "https://other.check.example/mcp" });
    const a = await approve(ada, req);
    let used = null;
    if (a.code) {
      const tok = await tokenCall({ grant_type: "authorization_code", code: a.code, redirect_uri: LOOP, client_id: app.json.client_id, code_verifier: req.verifier, resource: "https://other.check.example/mcp" });
      used = tok.json?.access_token ? (await mcpStatus(tok.json.access_token)).status : tok.status;
    }
    t.ok("a token asked for another resource is never one this server takes: refused when asked, or at /mcp", !a.code || used === 401 || used === 400, `page ${a.page.status}, code ${!!a.code}, then ${used}`);
  });
  test("header-only", async () => {
    const c = await connected(ada);
    const inQuery = await mcpStatus(c.tokens.access_token, { query: true }), inHeader = await mcpStatus(c.tokens.access_token);
    t.same("the same token works in the Authorization header and is refused in the query string", [inHeader.status, inQuery.status], [200, 401]);
  });
  test("scope-per-tool", async () => {
    const c = await connected(ben, { scope: "trips:read" });
    const mcp = new McpClient(o, c.tokens.access_token);
    await mcp.initialize();
    const listed = await mcp.toolNames();
    // The write tools, as check:access names them.
    const writes = TOOLS.filter((x) => !x.read && !x.name.startsWith("get_") && !x.name.startsWith("list_") && x.name !== "open_in_app").map((x) => x.name);
    const called = [];
    for (const name of writes) { const r = await mcp.call(name, {}); if (!r.isError) called.push(name); }
    t.ok(`a read-only connection: no write tool listed, and each of the ${writes.length} refused when called anyway`, writes.length > 0 && !writes.some((w) => listed.includes(w)) && called.length === 0, `listed ${writes.filter((w) => listed.includes(w)).join(", ")} called ${called.join(", ")}`);
  });
  test("disconnect-at-once", async () => {
    const c = await connected(ada);
    // The connection's own id is in its tokens (`${userId}:${grantId}:…`).
    const { grantId } = grantOfToken(c.tokens.access_token);
    const listed = ((await ada.get("/api/account/apps")).json?.apps ?? []).some((x) => x.id === grantId);
    const gone = await ada.call("DELETE", `/api/account/apps/${grantId}`);
    const access = await mcpStatus(c.tokens.access_token);
    const refresh = await tokenCall({ grant_type: "refresh_token", refresh_token: c.tokens.refresh_token, client_id: c.clientId });
    t.same("Disconnect on the account page (the connection listed there): the access token is refused at once, and the refresh token too", [listed, gone.json?.disconnected, access.status, refresh.status], [true, true, 401, 400]);
  });

  // ── the approval page ──
  test("authenticate-first", async () => {
    const app = await register();
    const out = new Person(o, "Nobody Signed In");
    const r = await out.call("GET", `/authorize?${query(app.json.client_id).q}`, null, { page: true });
    t.ok("signed out, /authorize sends the browser to sign in, never to the app", (r.status === 302 || r.status === 303) && /\/login/.test(r.location ?? "") && !/127\.0\.0\.1:9/.test(r.location ?? ""), `${r.status} ${r.location}`);
  });
  test("no-framing", async () => {
    const app = await register();
    const page = await ada.call("GET", `/authorize?${query(app.json.client_id).q}`, null, { page: true });
    const h = Object.fromEntries((page.headers ?? []).map(([k, v]) => [k.toLowerCase(), v]));
    t.same("the approval page can't be framed: X-Frame-Options DENY and frame-ancestors 'none'", [page.status, /deny/i.test(h["x-frame-options"] ?? ""), /frame-ancestors 'none'/.test(h["content-security-policy"] ?? "")], [200, true, true]);
  });
  test("consent-csrf", async () => {
    const app = await register();
    // Ada's page, answered from another browser of hers (no binding cookie), by Ben with her page's fields, and from another site.
    const req = query(app.json.client_id);
    const page = await ada.call("GET", `/authorize?${req.q}`, null, { page: true });
    const form = { ...consentForm(page.text), decision: "approve" };
    const other = ada.otherBrowser();
    const fromOther = await other.call("POST", "/authorize", form, { form: true });
    const byBen = await ben.call("POST", "/authorize", form, { form: true });
    const crossSite = await ada.call("POST", "/authorize", form, { form: true, headers: { Origin: "https://evil.check.example" } });
    const codeIn = (r) => (r.location ? new URL(r.location, o).searchParams.get("code") : null);
    t.same("Allow without the page's own binding (another browser), by another account with its fields, or from another site: no code",
      [codeIn(fromOther), codeIn(byBen), codeIn(crossSite)], [null, null, null]);
    const real = await ada.call("POST", "/authorize", form, { form: true });
    t.ok("  (the real Allow, from the page's own browser, does give one)", !!codeIn(real), `${real.status} ${real.location}`);
  });
  test("consent-shows", async () => {
    const app = await register(["https://cb.app.check.example/oauth/callback"]);
    const page = await ada.call("GET", `/authorize?${query(app.json.client_id, { redirect_uri: "https://cb.app.check.example/oauth/callback" }).q}`, null, { page: true });
    t.same("the approval page names the app and the host its tokens go to", [page.status, /Security Check App/.test(page.text), /cb\.app\.check\.example/.test(page.text)], [200, true, true]);
  });
  test("consent-cookie", async () => {
    const app = await register();
    const page = await ada.call("GET", `/authorize?${query(app.json.client_id).q}`, null, { page: true });
    const cookies = (page.headers ?? []).filter(([k]) => k.toLowerCase() === "set-cookie").map(([, v]) => v);
    const consent = cookies.filter((c) => !/^wgp_/.test(c));
    t.ok("the page's consent cookie is __Host-, Secure, HttpOnly and SameSite=Lax", consent.length > 0 && consent.every((c) => /^__Host-/.test(c) && /;\s*Secure/i.test(c) && /;\s*HttpOnly/i.test(c) && /;\s*SameSite=Lax/i.test(c)), consent.join(" | "));
  });
  test("no-cors-authorize", async () => {
    const app = await register();
    const page = await ada.call("GET", `/authorize?${query(app.json.client_id).q}`, null, { page: true, headers: { Origin: "https://evil.check.example" } });
    const h = Object.fromEntries((page.headers ?? []).map(([k, v]) => [k.toLowerCase(), v]));
    t.same("/authorize asked from another origin answers with no Access-Control-Allow-Origin", h["access-control-allow-origin"] ?? null, null);
  });

  // ── registration ──
  test("dcr-bounded", async () => {
    const big = await fetch(`${o}/register`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.9.0.1" }, body: JSON.stringify({ client_name: "x".repeat(17 * 1024), redirect_uris: [LOOP] }) });
    // In one clock minute (the runtime's limits count per clock minute: check:limits, crossBy), once more if it turned.
    let refused = null;
    for (let attempt = 0; attempt < 2 && !refused; attempt++) {
      const left = 60_000 - (Date.now() % 60_000);
      if (attempt || left < 20_000) await new Promise((r) => setTimeout(r, left + 250));
      const minute = Math.floor(Date.now() / 60_000);
      for (let i = 0; i < 70 && !refused; i++) { const r = await register([LOOP], {}, `10.9.${attempt}.2`); if (r.status === 429) refused = r; }
      if (refused || Math.floor(Date.now() / 60_000) === minute) break;
    }
    t.same("a registration over 16 KB is refused; so is one past a connection's tries (60 a minute)", [big.status, refused?.status ?? null], [400, 429]);
  });

  // ── client metadata documents, on a server as production has it ──
  strict = await startServer({ name: "mcp-security-strict", port: strictPort, strictlyPublic: true });
  await strict.start();
  const so = strict.origin;
  const eve = new Person(so, "Eve Strict");
  await eve.signUp();
  const cimdPage = async (clientId) => {
    const p = pkce();
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "http://127.0.0.1:9/callback", scope: "trips:read", state: "s", code_challenge: p.challenge, code_challenge_method: "S256", resource: `${so}/mcp` });
    return eve.call("GET", `/authorize?${q}`, null, { page: true });
  };
  test("cimd-url", async () => {
    const bad = { "http": "http://app.check.example/client.json", "userinfo": "https://a:b@app.check.example/client.json", "no path": "https://app.check.example", "a dot segment": "https://app.check.example/x/../client.json", "a fragment": "https://app.check.example/client.json#x" };
    const shown = [];
    for (const [what, id] of Object.entries(bad)) { const r = await cimdPage(id); if (r.status === 200) shown.push(what); }
    t.ok(`a client identifier URL with ${Object.keys(bad).join(", ")}: refused before any approval`, shown.length === 0, shown.join(", "));
  });
  test("cimd-special-use", async () => {
    // A listener on this machine: a fetch of the document there would arrive.
    let arrived = 0;
    const listener = net.createServer((s) => { arrived++; s.destroy(); });
    await new Promise((r) => listener.listen(0, "127.0.0.1", r));
    const lp = listener.address().port;
    const ids = [`https://127.0.0.1:${lp}/client.json`, `https://localhost:${lp}/client.json`, "https://10.0.0.1/client.json", "https://169.254.169.254/client.json", "https://[::1]/client.json"];
    const shown = [];
    for (const id of ids) { const r = await cimdPage(id); if (r.status === 200) shown.push(id); }
    listener.close();
    t.same("a client identifier on a special-use address (this machine, a private network, the cloud's metadata address): refused, and nothing reached this machine", [shown, arrived], [[], 0]);
  });
  for (const [id, fn] of Object.entries(cimdLibraryTests(t))) test(id, fn);

  // ── run them, every rule exactly once ──
  const untested = RULES.filter((r) => !TESTS[r.id]).map((r) => r.id);
  const unruled = Object.keys(TESTS).filter((id) => !RULES.some((r) => r.id === id));
  for (const rule of RULES) {
    t.part(`${rule.id}: ${rule.source}`);
    console.log(`    "${rule.words.length > 220 ? rule.words.slice(0, 217) + "…" : rule.words}"`);
    if (TESTS[rule.id]) {
      try { await TESTS[rule.id](); } catch (e) { t.ok(`(the test itself failed: ${e.message})`, false, e.stack?.split("\n").slice(0, 3).join(" ")); }
    }
  }
  t.part("Every rule has its test, and every test its rule");
  t.same("rules with no test", untested, []);
  t.same("tests with no rule", unruled, []);
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  code = 2;
} finally {
  await server?.stop().catch(() => {});
  await strict?.stop().catch(() => {});
}
process.exit(code);

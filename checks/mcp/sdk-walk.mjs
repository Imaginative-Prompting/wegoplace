// Connecting with a client that isn't ours: the official MCP SDK's own clients and their OAuth
// (@modelcontextprotocol/sdk, the 1.x line, and @modelcontextprotocol/client, the 2.x line: the
// libraries real clients are built on; devDependencies), walking the whole road from a bare /mcp
// address, in a real browser for the person's part (Chrome for Testing):
//
//   node checks/mcp/sdk-walk.mjs [--package sdk|client] [--era auto|2026-07-28] [--port <port>] [--log <file>] [--cimd]
//   npm run check:mcp-sdk        the three the set runs: sdk; client; client --era 2026-07-28
//   npm run check:mcp-sdk-cimd   D below (it reaches the network once): run before the cutover, never on the gate
//
// MCP_SDK_DIR=<folder> takes the packages from <folder>/node_modules instead (another version).
//
// Three connections, each the way a real client of Claude's connects (claude.com/docs/connectors/
// building/authentication, read 15 Nov 2026):
//   A. Claude Code's way: a loopback redirect on a port that changes every session, registered
//      without its port (http://127.0.0.1/callback), so the server must match it with the port
//      ignored (RFC 8252 §7.3); the code really arrives at a server on this machine;
//   B. the same with localhost, which Claude Code also declares;
//   C. the hosted apps' way (claude.ai, Desktop, mobile): https://claude.ai/api/mcp/auth_callback,
//      answered inside the browser and never sent;
//   D. (--cimd only: it reaches the network once) Claude Code identifying itself by its own Client ID
//      Metadata Document, https://claude.ai/oauth/claude-code-client-metadata, on a server that keeps
//      global_fetch_strictly_public as production does (the checks' servers drop it to reach their
//      stand-ins, so without --cimd no check walks this road). No registration: the server fetches
//      the document.
// Each: the SDK finds the server from a 401 (its pointer, both well-known documents), registers,
// sends the person to the consent page, takes the code, buys tokens, lists the tools, reads, writes
// one change, lists the changes, undoes it; then a refresh (a new pair, the old refresh token
// refused), Disconnect, and the next call and refresh refused. Every request the SDK makes and
// every answer is written to --log, for reading. Whatever the library asks that we don't answer
// is a find. Its own server and browser; everyone in it is made up.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CheckError, ROOT, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8798);
const logFile = flag("--log");
const CIMD = argv.includes("--cimd");
// --era auto | 2026-07-28 (the 2.x client only): protocol version negotiation, which the client
// leaves off by default ("legacy", the 2025 sequence). auto probes server/discover first and falls
// back; a pin speaks exactly that revision or fails.
const ERA = flag("--era");
const SDK_DIR = process.env.MCP_SDK_DIR || ROOT;
// --package sdk (default): @modelcontextprotocol/sdk, the 1.x line; --package client: @modelcontextprotocol/client, the 2.x line.
const PKG = flag("--package") ?? "sdk";
const pkgDir = path.join(SDK_DIR, "node_modules/@modelcontextprotocol", PKG);
const load = (p) => import(pathToFileURL(path.join(pkgDir, p)).href);
const lib = PKG === "client" ? await load("dist/index.mjs") : {
  ...(await load("dist/esm/client/index.js")), ...(await load("dist/esm/client/streamableHttp.js")),
  ...(await load("dist/esm/client/auth.js")), ...(await load("dist/esm/types.js")),
};
const { Client, StreamableHTTPClientTransport, UnauthorizedError, refreshAuthorization, discoverAuthorizationServerMetadata, LATEST_PROTOCOL_VERSION } = lib;
const SDK_VERSION = `@modelcontextprotocol/${PKG} ${JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version}`;

const t = new Report(`connecting with the MCP SDK's own client (${SDK_VERSION}, protocol ${ERA ? `era ${ERA}` : LATEST_PROTOCOL_VERSION})`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOSTED = "https://claude.ai/api/mcp/auth_callback";

/** Every request the SDK makes, and its answer, for the log. */
const exchanges = [];
const logged = (who) => async (input, init = {}) => {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const url = isRequest ? input.url : String(input);
  const method = init.method ?? (isRequest ? input.method : "GET");
  const reqHeaders = Object.fromEntries(new Headers(init.headers ?? (isRequest ? input.headers : {})).entries());
  if (reqHeaders.authorization) reqHeaders.authorization = reqHeaders.authorization.replace(/(Bearer\s+)\S+/i, "$1<token>");
  let body = init.body ?? null;
  if (body && typeof body !== "string") body = body instanceof URLSearchParams ? body.toString() : "<body>";
  const res = await fetch(input, init);
  const copy = res.clone();
  const text = await copy.text().catch(() => "");
  exchanges.push({
    who, method, url: url.replace(/^https?:\/\/[^/]+/, "<origin>"),
    request: { headers: reqHeaders, body: body ? String(body).replace(/(code|refresh_token|code_verifier)=[^&]+/g, "$1=<secret>").slice(0, 2000) : null },
    response: { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: text.replace(/"(access_token|refresh_token)":"[^"]+"/g, '"$1":"<secret>"').slice(0, 200000) },
  });
  return res;
};

let server, chrome, loop, code = 1;
try {
  server = await startServer({ name: "sdk-walk", port, strictlyPublic: CIMD });
  await server.start();
  const { origin } = server;
  const MCP = new URL("/mcp", origin);
  const ada = new Person(origin, "Ada Reyes");
  if ((await ada.signUp()).status !== 200) throw new CheckError("couldn't make Ada");
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const trip = (await ada.post("/api/trips", { name: "Coast week", default_tz: "UTC", starts_on: day(3), ends_on: day(9), currencies: ["EUR"] })).json.trip.id;

  // The code, when a loopback redirect brings it here: a real server on this machine, any port.
  const arrivals = [];
  loop = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    // Only the callback is an arrival (a browser asks this server for its favicon too).
    if (u.pathname === "/callback") arrivals.push({ host: req.headers.host, path: u.pathname, query: Object.fromEntries(u.searchParams) });
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<p>You can close this window.</p>");
  });
  await new Promise((r) => loop.listen(0, "127.0.0.1", r));
  const loopPort = loop.address().port;

  chrome = await openChrome();
  const page = await chrome.page({ width: 390, height: 844, mobile: true, passkeys: false });
  await page.setCookie(origin, "wgp_session", ada.jar.cookies.get("wgp_session"));
  await page.send("Network.setCookie", { url: origin, name: "wgp_who", value: encodeURIComponent(ada.user.id), sameSite: "Lax" });
  // The hosted apps' callback, answered in the browser.
  const hostedLanded = [];
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "https://claude.ai/*", requestStage: "Request" }] });
  page.on(async (m) => {
    if (m.method !== "Fetch.requestPaused") return;
    if (m.params.resourceType === "Document") hostedLanded.push(m.params.request.url);
    await page.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/html" }], body: Buffer.from("<p>the app</p>").toString("base64") }).catch(() => {});
  });

  /** The person's part: the consent page, what it says, and Allow. Answers what the page showed. */
  const consent = async (url) => {
    await page.open(url);
    const shown = await page.until(`!!document.querySelector("[data-authorize-page] button[value=approve]") || /error|invalid|refused/i.test(document.body?.innerText ?? "")`, "the consent page (or a refusal)", 20000)
      .then(() => page.eval(`document.body.innerText`)).catch(() => page.eval(`document.body?.innerText ?? ""`));
    const hasAllow = await page.eval(`!!document.querySelector("[data-authorize-page] button[value=approve]")`);
    if (hasAllow) await page.click("[data-authorize-page] button[value=approve]");
    return { text: String(shown).replace(/\s+/g, " ").trim(), hasAllow };
  };

  /** One connection, the SDK's way, from the bare address. */
  async function connectAs(label, { redirect, registered, clientName, metadataUrl = null }) {
    const store = { client: null, tokens: null, verifier: null, authUrl: null };
    const state = `st-${label}`;
    const provider = {
      get redirectUrl() { return redirect; },
      get clientMetadata() {
        return { client_name: clientName, redirect_uris: registered, grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"], token_endpoint_auth_method: "none", application_type: redirect.startsWith("http://") ? "native" : "web" };
      },
      state: () => state,
      ...(metadataUrl ? { clientMetadataUrl: metadataUrl } : {}),
      clientInformation: () => store.client ?? undefined,
      saveClientInformation: (c) => { store.client = c; },
      tokens: () => store.tokens ?? undefined,
      saveTokens: (tk) => { store.tokens = tk; },
      redirectToAuthorization: (u) => { store.authUrl = u.toString(); },
      saveCodeVerifier: (v) => { store.verifier = v; },
      codeVerifier: () => store.verifier,
      // Where it found the authorization server, kept beside the code verifier (the 2.x client
      // binds the callback to that issuer).
      saveDiscoveryState: (d) => { store.discovery = d; },
      discoveryState: () => store.discovery ?? undefined,
    };
    const fetchFn = logged(label);
    const transport = new StreamableHTTPClientTransport(MCP, { authProvider: provider, fetch: fetchFn });
    const clientOptions = ERA ? { versionNegotiation: { mode: ERA === "auto" ? "auto" : { pin: ERA } } } : {};
    const client = new Client({ name: `wegoplace-check-${label}`, version: "1" }, clientOptions);
    let first = null;
    try { await client.connect(transport); first = "connected without signing in"; }
    catch (e) { first = e instanceof UnauthorizedError ? "asked to sign in" : `failed: ${e.message}`; }
    const out = { label, first, registered: store.client, authUrl: store.authUrl, provider, store, fetchFn };
    if (!store.authUrl) return out;
    const before = { loop: arrivals.length, hosted: hostedLanded.length };
    out.page = await consent(store.authUrl);
    for (let i = 0; i < 100 && arrivals.length === before.loop && hostedLanded.length === before.hosted; i++) await sleep(100);
    const back = arrivals.length > before.loop ? { query: arrivals.at(-1).query, at: `${arrivals.at(-1).host}${arrivals.at(-1).path}` }
      : hostedLanded.length > before.hosted ? { query: Object.fromEntries(new URL(hostedLanded.at(-1)).searchParams), at: new URL(hostedLanded.at(-1)).host + new URL(hostedLanded.at(-1)).pathname } : null;
    out.back = back;
    if (!back?.query?.code) return out;
    // The 2.x client checks the answer's iss against the issuer it found (RFC 9207, SEP-2352), so it
    // is handed the whole callback; the 1.x client takes the code.
    if (PKG === "client") await transport.finishAuth(new URLSearchParams(back.query));
    else await transport.finishAuth(back.query.code);
    const t2 = new StreamableHTTPClientTransport(MCP, { authProvider: provider, fetch: fetchFn });
    const c2 = new Client({ name: `wegoplace-check-${label}`, version: "1" }, clientOptions);
    await c2.connect(t2);
    out.client = c2;
    out.version = t2.protocolVersion ?? c2.getNegotiatedProtocolVersion?.() ?? null;
    return out;
  }

  t.part("The site's /.well-known/ addresses");
  const wk = async (p) => (await fetch(new URL(p, origin), { headers: { Accept: "application/json" } })).status;
  t.same("a /.well-known/ document the site doesn't have is a 404 for anyone, never \"sign in\" (OpenID's, RFC 8414's with the path, any other); its own two answer",
    [await wk("/.well-known/openid-configuration"), await wk("/.well-known/oauth-authorization-server/mcp"), await wk("/.well-known/nothing-here"),
      await wk("/.well-known/oauth-authorization-server"), await wk("/.well-known/oauth-protected-resource/mcp")], [404, 404, 404, 200, 200]);

  const text = (r) => (r?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const json = (r) => { try { return JSON.parse(text(r)); } catch { return null; } };

  const walks = CIMD ? [
    { label: "D-cimd-claude-code", redirect: `http://localhost:${loopPort}/callback`, registered: ["http://localhost/callback", "http://127.0.0.1/callback"], clientName: "Claude Code",
      metadataUrl: "https://claude.ai/oauth/claude-code-client-metadata" },
  ] : [
    { label: "A-loopback-127", redirect: `http://127.0.0.1:${loopPort}/callback`, registered: ["http://127.0.0.1/callback"], clientName: "Claude Code" },
    { label: "B-loopback-localhost", redirect: `http://localhost:${loopPort}/callback`, registered: ["http://localhost/callback"], clientName: "Claude Code" },
    { label: "C-hosted", redirect: HOSTED, registered: [HOSTED], clientName: "Claude" },
  ];
  const results = {};
  for (const w of walks) {
    t.part(`${w.label}: ${w.redirect.replace(String(loopPort), "<port>")}, registered as ${w.registered.join(", ")}`);
    const r = await connectAs(w.label, w);
    results[w.label] = r;
    const ex = exchanges.filter((e) => e.who === w.label);
    const first401 = ex.find((e) => e.url === "<origin>/mcp" && e.response.status === 401);
    t.ok("a bare /mcp asks to sign in with a 401 whose WWW-Authenticate points at the resource's metadata (C1)",
      r.first === "asked to sign in" && /resource_metadata="[^"]+"/.test(first401?.response.headers["www-authenticate"] ?? ""), first401?.response.headers["www-authenticate"] ?? r.first);
    const prm = ex.find((e) => /oauth-protected-resource/.test(e.url) && e.response.status === 200);
    let prmDoc = null; try { prmDoc = JSON.parse(prm?.response.body ?? "null"); } catch { /* */ }
    t.same("the resource's metadata names this /mcp exactly, and our issuer first (C2, C3)", [prmDoc?.resource, prmDoc?.authorization_servers?.[0]], [MCP.toString(), origin]);
    const asm = ex.find((e) => /oauth-authorization-server|openid-configuration/.test(e.url) && e.response.status === 200);
    let asDoc = null; try { asDoc = JSON.parse(asm?.response.body ?? "null"); } catch { /* */ }
    t.ok("the authorization server's metadata is found, with S256 PKCE (C4, C5)", asDoc?.code_challenge_methods_supported?.includes("S256"), asm?.url ?? "not found");
    const reg = ex.find((e) => e.url === "<origin>/register");
    if (w.metadataUrl) {
      t.same("the server says it takes client metadata documents (client_id_metadata_document_supported, and \"none\" at its token endpoint), so the client registers nothing and is known by its document's address (C7)",
        [asDoc?.client_id_metadata_document_supported, asDoc?.token_endpoint_auth_methods_supported?.includes("none"), !!reg, r.registered?.client_id], [true, true, false, w.metadataUrl]);
    } else {
      t.ok("the SDK registers itself (DCR), and is given a client id", !!r.registered?.client_id, reg ? `${reg.response.status} ${reg.response.body.slice(0, 300)}` : "no registration request");
    }
    t.ok("the person is sent to the consent page, which offers Allow", !!r.page?.hasAllow, r.page?.text?.slice(0, 300) ?? r.authUrl);
    console.log(`        the page said: ${r.page?.text?.slice(0, 700) ?? "—"}`);
    if (w.redirect.startsWith("http://")) {
      t.ok("the consent page names where the code goes, and warns that it is an app on this computer (C9)", /127\.0\.0\.1|localhost|this computer|this device/i.test(r.page?.text ?? ""), r.page?.text?.slice(0, 400));
    }
    t.ok("Allow brings the code back to the redirect the SDK sent, with its state", r.back?.query?.code && r.back.query.state === `st-${w.label}`, JSON.stringify(r.back));
    t.ok("an iss in the answer, for a client to check (S5: SHOULD)", !!r.back?.query?.iss, JSON.stringify(r.back?.query ?? null));
    if (!r.client) { t.ok("the SDK connects with the code", false, "no connection: see above"); continue; }
    t.same("the protocol both agreed", r.version, ERA ? (ERA === "auto" ? "2026-07-28" : ERA) : LATEST_PROTOCOL_VERSION);
    const tok = ex.find((e) => e.url === "<origin>/token" && /grant_type=authorization_code/.test(e.request.body ?? ""));
    t.same("the code buys tokens: an access token, a refresh token, its lifetime (C10, C11)", [tok?.response.status, /"refresh_token":"<secret>"/.test(tok?.response.body ?? ""), /"expires_in":\d+/.test(tok?.response.body ?? "")], [200, true, true]);
    const tools = await r.client.listTools();
    t.ok(`the tools are listed (${tools.tools.length}), each with a description and an input schema`, tools.tools.length >= 20 && tools.tools.every((x) => x.description && x.inputSchema), tools.tools.map((x) => x.name).join(" "));
    const trips = json(await r.client.callTool({ name: "list_trips", arguments: {} }));
    t.ok("a read answers (list_trips: the person's trip)", JSON.stringify(trips ?? "").includes(trip), JSON.stringify(trips).slice(0, 200));
    const wrote = json(await r.client.callTool({ name: "put_places", arguments: { trip_id: trip, summary: `A cafe (${w.label})`, places: [{ id: `cafe-${w.label.toLowerCase()}`, name: "Cafe Lume", kind: "food", subkind: "cafe", why: "Coffee before the boat" }] } }));
    t.ok("a write answers with its change", typeof wrote?.change_id === "string", JSON.stringify(wrote).slice(0, 200));
    const listed = json(await r.client.callTool({ name: "list_changes", arguments: { trip_id: trip } }));
    t.ok("list_changes lists it, by the app's name", JSON.stringify(listed ?? "").includes(wrote?.change_id ?? "x") && JSON.stringify(listed).includes(`oauth:${w.clientName}`), JSON.stringify(listed).slice(0, 300));
    const undone = json(await r.client.callTool({ name: "undo_change", arguments: { trip_id: trip, change_id: wrote?.change_id } }));
    t.same("undo_change puts it back", [undone?.undone, server.sql(`SELECT COUNT(*) AS n FROM places WHERE id = 'cafe-${w.label.toLowerCase()}'`)[0].n], [1, 0]);
  }

  t.part("Refresh, and Disconnect");
  const r = results["C-hosted"] ?? results["D-cimd-claude-code"];
  if (r?.client) {
    const md = await discoverAuthorizationServerMetadata(origin, { fetchFn: r.fetchFn });
    const old = r.store.tokens;
    const fresh = await refreshAuthorization(origin, { metadata: md, clientInformation: r.store.client, refreshToken: old.refresh_token, resource: MCP, fetchFn: r.fetchFn });
    t.ok("a refresh gives a new access token and a NEW refresh token (rotated: C11)", fresh.access_token && fresh.refresh_token && fresh.refresh_token !== old.refresh_token);
    // workers-oauth-provider keeps the token just used valid until the new one is used (so a refresh
    // whose answer was lost can be sent again): a find, said in review/server/mcp-proof/, not a
    // failure for Claude, which always uses the newest. What holds: once the new one is used, the old
    // one is refused.
    const refreshWith = (rt) => fetch(new URL("/token", origin), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: r.store.client.client_id, resource: MCP.toString() }) })
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
    const newer = await refreshWith(fresh.refresh_token);
    const stale = await refreshWith(old.refresh_token);
    t.same("once the new refresh token is used, the old one is refused as invalid_grant (C11)", [newer.status, stale.status, stale.body?.error], [200, 400, "invalid_grant"]);
    Object.assign(fresh, newer.body);
    r.store.tokens = fresh;
    const apps = await ada.get("/api/account/apps");
    const grant = (apps.json?.apps ?? []).find((a) => (a.name ?? a.client_name ?? "") === (CIMD ? "Claude Code" : "Claude")) ?? (apps.json?.apps ?? [])[0];
    const off = await ada.call("DELETE", `/api/account/apps/${encodeURIComponent(grant?.id ?? "x")}`);
    t.ok("the person disconnects the app on the account page's route", off.status === 200 || off.status === 204, `${off.status} ${off.text?.slice(0, 200)}`);
    const after = await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${fresh.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }) });
    t.same("its next call is refused, 401, saying so", [after.status, /invalid_token/.test(after.headers.get("www-authenticate") ?? "")], [401, true]);
    const refreshAfter = await fetch(new URL("/token", origin), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: fresh.refresh_token, client_id: r.store.client.client_id, resource: MCP.toString() }) });
    const ra = await refreshAfter.json().catch(() => null);
    t.same("and its refresh is refused as invalid_grant", [refreshAfter.status, ra?.error], [400, "invalid_grant"]);
  }
  t.ok("no page error", page.errors.length === 0, JSON.stringify(page.errors.slice(0, 3)));
  if (logFile) fs.writeFileSync(logFile, JSON.stringify({ sdk: SDK_VERSION, protocol: LATEST_PROTOCOL_VERSION, exchanges }, null, 1));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  if (logFile) fs.writeFileSync(logFile, JSON.stringify({ sdk: SDK_VERSION, exchanges }, null, 1));
  t.end();
  code = 2;
} finally {
  await chrome?.close();
  loop?.close();
  await server?.stop();
}
process.exit(code);

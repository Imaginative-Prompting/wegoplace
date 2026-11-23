// An AI app, as far as WeGoPlace can tell: it registers itself, sends a person to /authorize,
// trades the code for tokens (OAuth 2.1 with PKCE), and calls /mcp. Used by check:mcp and by
// tools/mcp-call.mjs.
//
// `browser` is whatever the person approves the app in: an object with
//   call(method, path, body, { page, form }) -> { status, text, location }
// that sends the person's session cookie (checks/lib/person.mjs's Person is one).

import crypto from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Registers an app (dynamic client registration). Answers { status, json }. */
export async function register(origin, { name = "Check App", redirect = "http://127.0.0.1:9/callback", address } = {}) {
  const res = await fetch(new URL("/register", origin), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(address ? { "CF-Connecting-IP": address } : {}) },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** The approval page's hidden fields. */
export function consentForm(html) {
  const field = (name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1]?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">") ?? null;
  return { handle: field("handle"), account: field("account") };
}

/**
 * The whole connection, as an app and its person make it: registration, /authorize in the
 * person's browser, the decision, the code traded for tokens. Answers
 * { client, page, decided, tokens, scope } (each step's answer, for a check to look at).
 */
export async function connect(origin, browser, { name = "Check App", scope = "trips:read trips:write", decision = "approve", address, client = null } = {}) {
  const redirect = "http://127.0.0.1:9/callback";
  const reg = client ?? (await register(origin, { name, redirect, address }));
  if (reg.status !== 201 && reg.status !== 200) return { client: reg };
  const clientId = reg.json.client_id;
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(8));
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirect, scope, state,
    code_challenge: challenge, code_challenge_method: "S256", resource: new URL("/mcp", origin).toString(),
  });
  const page = await browser.call("GET", `/authorize?${q}`, null, { page: true });
  if (page.status !== 200) return { client: reg, page };
  const form = consentForm(page.text);
  const decided = await browser.call("POST", "/authorize", { ...form, decision }, { form: true });
  const back = decided.location ? new URL(decided.location) : null;
  const code = back?.searchParams.get("code");
  if (!code || back.searchParams.get("state") !== state) return { client: reg, page, decided };
  const tokens = await token(origin, { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier });
  return { client: reg, page, decided, tokens, clientId };
}

/** POST /token with a form. Answers { status, json }. */
export async function token(origin, form) {
  const res = await fetch(new URL("/token", origin), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** An MCP session over Streamable HTTP, stateless: each call is one POST to /mcp. */
export class McpClient {
  constructor(origin, accessToken) {
    this.origin = origin;
    this.accessToken = accessToken;
    this.next = 1;
  }

  /** One JSON-RPC request. Answers { status, result, error, raw }. */
  async rpc(method, params = {}) {
    const res = await fetch(new URL("/mcp", this.origin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.next++, method, params }),
    });
    const raw = await res.text();
    let msg = null;
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const line of raw.split("\n")) if (line.startsWith("data:")) { try { msg = JSON.parse(line.slice(5)); } catch { /* not JSON */ } }
    } else {
      try { msg = JSON.parse(raw); } catch { /* not JSON */ }
    }
    return { status: res.status, result: msg?.result ?? null, error: msg?.error ?? null, raw };
  }

  async initialize() {
    return this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wegoplace-check", version: "1" } });
  }

  /** The tools' names, as tools/list gives them. */
  async toolNames() {
    const r = await this.rpc("tools/list");
    return (r.result?.tools ?? []).map((t) => t.name);
  }

  /**
   * Calls a tool. Answers { status, isError, text, json (the text parsed, when it is JSON), error }.
   */
  async call(name, args = {}) {
    const r = await this.rpc("tools/call", { name, arguments: args });
    const text = (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    let json = null;
    try { json = JSON.parse(text); } catch { /* words */ }
    return { status: r.status, isError: Boolean(r.result?.isError) || Boolean(r.error), text: r.error ? JSON.stringify(r.error) : text, json, error: r.error };
  }
}

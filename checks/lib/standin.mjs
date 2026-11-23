// Google and GitHub, played on this computer for a check. The server under test is started
// with AUTH_STANDIN pointing here (src/accounts/util.js `standin`: honored only on localhost),
// so its token and user requests come to this file instead of the real providers.
//
// The provider's own page (choose an account, allow) is the check itself: it reads the
// authorize address the server redirected to, calls `allow()` with who is signing in, and gets
// the code the provider would send back. The token endpoints then hold the server to the rules
// the real ones do: the client id and secret, the redirect address, the code once, and PKCE.
//
//   const standin = await startStandin({ port, clients: { google: { id, secret }, github: { id, secret } } });
//   const code = standin.allow("google", authorizeUrl, { sub: "1001", name: "Ana Check" });
//   standin.seen      every request the server made here: { path, ok, why }
//   await standin.stop()

import crypto from "node:crypto";
import http from "node:http";

const b64u = (value) => Buffer.from(value).toString("base64url");

export async function startStandin({ port, clients }) {
  const origin = `http://localhost:${port}`;
  const codes = new Map();      // code -> { provider, challenge, redirectUri, nonce, person }
  const tokens = new Map();     // GitHub access token -> person
  const seen = [];
  // What the next token request answers instead of the truth, for a check of the refusals: one use.
  let nextIdToken = null;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, origin);
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const send = (status, body, why = "") => {
        seen.push({ path: url.pathname, ok: status === 200 && !body.error, why });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const provider = url.pathname.split("/")[1];
      const app = clients[provider];
      if (!app) return send(404, { error: "not_found" }, "no such provider");

      if (req.method === "POST" && url.pathname === `/${provider}/token`) {
        const bad = (why) => (provider === "github" ? send(200, { error: "bad_verification_code" }, why) : send(400, { error: "invalid_grant" }, why));
        if (form.get("client_id") !== app.id || form.get("client_secret") !== app.secret) return send(401, { error: "invalid_client" }, "wrong client id or secret");
        const grant = codes.get(form.get("code"));
        codes.delete(form.get("code"));                    // a code works once
        if (!grant || grant.provider !== provider) return bad("unknown or used code");
        if (form.get("redirect_uri") !== grant.redirectUri) return bad("another redirect address");
        const verifier = form.get("code_verifier") ?? "";
        if (b64u(crypto.createHash("sha256").update(verifier).digest()) !== grant.challenge) return bad("PKCE: the verifier doesn't match the challenge");
        if (provider === "google") {
          if (form.get("grant_type") !== "authorization_code") return bad("wrong grant type");
          const claims = nextIdToken ?? {};
          nextIdToken = null;
          const idToken = [
            b64u(JSON.stringify({ alg: "none", typ: "JWT" })),
            b64u(JSON.stringify({
              iss: `${origin}/google`, aud: app.id, exp: Math.floor(Date.now() / 1000) + 300, nonce: grant.nonce,
              sub: grant.person.sub, name: grant.person.name, email: "never-read@check.example", ...claims,
            })),
            "signature",
          ].join(".");
          return send(200, { id_token: idToken, access_token: "unused" });
        }
        const token = b64u(crypto.randomBytes(18));
        tokens.set(token, grant.person);
        return send(200, { access_token: token, token_type: "bearer" });
      }

      if (req.method === "GET" && url.pathname === "/github/user") {
        const person = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
        tokens.delete((req.headers.authorization ?? "").replace(/^Bearer /, ""));
        if (!person) return send(401, { message: "Bad credentials" }, "unknown access token");
        return send(200, { id: person.id, login: person.login, name: person.name, email: "never-read@check.example" });
      }
      return send(404, { error: "not_found" }, "no such address");
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });

  return {
    origin, seen,
    secrets: Object.fromEntries(Object.entries(clients).map(([name, app]) => [name, app.secret])),
    /**
     * The provider's page saying yes for `person` ({ sub, name } for Google; { id, login, name }
     * for GitHub). Checks the address the server sent the browser to and returns the code.
     * Throws with what was wrong in that address.
     */
    allow(provider, authorizeUrl, person) {
      const url = new URL(authorizeUrl);
      const q = url.searchParams;
      const app = clients[provider];
      const must = (holds, what) => { if (!holds) throw new Error(`the ${provider} authorize address: ${what} (${authorizeUrl})`); };
      must(`${url.origin}${url.pathname}` === `${origin}/${provider}/authorize`, "isn't the stand-in's");
      must(q.get("client_id") === app.id, "wrong client_id");
      must(q.get("response_type") === "code", "response_type isn't code");
      must(q.get("code_challenge_method") === "S256" && /^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") ?? ""), "no S256 PKCE challenge");
      must((q.get("state") ?? "").length >= 24, "no state");
      if (provider === "google") {
        must(q.get("scope") === "openid profile", `scope is "${q.get("scope")}", not "openid profile"`);
        must((q.get("nonce") ?? "").length >= 24, "no nonce");
      } else must(!q.has("scope"), "GitHub is asked for a scope");
      const code = b64u(crypto.randomBytes(18));
      codes.set(code, { provider, challenge: q.get("code_challenge"), redirectUri: q.get("redirect_uri"), nonce: q.get("nonce"), person });
      return { code, state: q.get("state"), redirectUri: q.get("redirect_uri") };
    },
    /** The next Google ID token carries these claims over the true ones (once). */
    lieOnce(claims) { nextIdToken = claims; },
    stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

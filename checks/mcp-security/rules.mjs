// THE AI CONNECTION'S SECURITY, rule by rule: every MUST of the MCP authorization specification (2026-07-28) and
// of the specifications it builds on that binds WeGoPlace as an authorization server and an MCP server, in the
// source's own words. checks/mcp-security/run.mjs runs one test per rule, by its id; a rule with no test fails.
//
// Sources (copies, fetched 16 Nov 2026, kept beside the review that reads them):
//   MCP     https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization (and its pages:
//           security-considerations, client-registration, authorization-server-discovery)
//   BP      https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
//   OAUTH   OAuth 2.1, draft-ietf-oauth-v2-1-17
//   CIMD    OAuth Client ID Metadata Document, draft-ietf-oauth-client-id-metadata-document-03
//
// A rule written for a different role that WeGoPlace holds itself to anyway says so in `note`.

export const RULES = [
  // ── discovery ──
  { id: "prm", source: "MCP, Authorization Server Discovery",
    words: "MCP servers MUST implement the OAuth 2.0 Protected Resource Metadata (RFC9728) specification to indicate the locations of authorization servers. The Protected Resource Metadata document returned by the MCP server MUST include the authorization_servers field" },
  { id: "pkce-advertised", source: "MCP, Security Considerations: Authorization Code Protection",
    words: "Authorization servers providing OpenID Connect Discovery 1.0 MUST include code_challenge_methods_supported in their metadata to ensure MCP compatibility.",
    note: "WeGoPlace publishes RFC 8414 metadata, where a client refuses to go on without the field; it is held to name S256 and only S256." },
  { id: "iss", source: "MCP, Authorization Response Validation; RFC 9207 2.3",
    words: "MCP authorization servers SHOULD include the iss parameter in authorization responses, including error responses … Authorization servers that include the iss parameter MUST advertise this by setting authorization_response_iss_parameter_supported to true in their metadata",
    note: "The provider advertises it, so every authorization response, an error's too, carries iss: the metadata's issuer exactly." },
  { id: "unauthorized-401", source: "MCP, Token Handling",
    words: "Invalid or expired tokens MUST receive a HTTP 401 response." },

  // ── PKCE ──
  { id: "pkce-required", source: "OAUTH 4.1.2.1",
    words: "An authorization server MUST reject requests without a code_challenge from public clients" },
  { id: "pkce-no-plain", source: "OAUTH, PKCE \"plain\" Code Challenge Method; MCP, Authorization Code Protection",
    words: "The plain code challenge method, defined in [RFC7636], is explicitly forbidden in OAuth 2.1. … MCP clients MUST use the S256 code challenge method" },
  { id: "pkce-verified", source: "OAUTH 4.1.2",
    words: "The authorization server MUST associate the code_challenge and code_challenge_method values with the issued authorization code so the code challenge can be verified later." },

  // ── redirect URIs ──
  { id: "redirect-exact", source: "OAUTH 4.1.1; MCP, Open Redirection",
    words: "When comparing the two URIs the authorization server MUST ensure that the two URIs are equal using simple string comparison as defined in Section 6.2.1 of [RFC3986], i.e., a case-sensitive, character-by-character comparison with no normalization applied. … Authorization servers MUST validate exact redirect URIs against pre-registered values to prevent redirection attacks." },
  { id: "redirect-loopback-port", source: "OAUTH 8.4.2",
    words: "The authorization server MUST allow any port to be specified at the time of the request for loopback IP redirect URIs" },
  { id: "redirect-never-to-invalid", source: "OAUTH 4.1.2.1",
    words: "If the request fails due to a missing, invalid, or mismatching redirect URI, or if the client identifier is missing or invalid, the authorization server MUST NOT redirect the user agent to the invalid redirect URI" },
  { id: "redirect-https-or-loopback", source: "MCP, Communication Security",
    words: "All redirect URIs MUST be either localhost or use HTTPS." },

  // ── the authorization code ──
  { id: "code-once", source: "OAUTH 4.1.3",
    words: "The authorization server MUST return an access token only once for a given authorization code." },
  { id: "code-short", source: "OAUTH 4.1.2",
    words: "The authorization code MUST expire shortly after it is issued to mitigate the risk of leaks." },
  { id: "code-bound-client", source: "OAUTH 7.5.1.1",
    words: "The code_challenge or OpenID Connect nonce value MUST be transaction-specific and securely bound to the client and the user agent in which the transaction was started.",
    note: "Tested as the code it guards: redeemed by another client, it is refused." },

  // ── refresh tokens ──
  { id: "refresh-replay", source: "OAUTH 4.3.1; MCP, Token Theft",
    words: "Authorization servers MUST utilize one of these methods to detect refresh token replay by malicious actors for public clients … For public clients, authorization servers MUST rotate refresh tokens" },
  { id: "refresh-bound-client", source: "OAUTH 4.3",
    words: "The authorization server MUST verify the binding between the refresh token and the client identity whenever the client identity can be authenticated." },
  { id: "refresh-same-scope", source: "OAUTH 4.3.3",
    words: "If a new refresh token is issued, the refresh token scope MUST be identical to that of the refresh token included by the client in the request" },

  // ── access tokens at /mcp ──
  { id: "audience", source: "MCP, Token Handling; Access Token Privilege Restriction",
    words: "MCP servers MUST validate that access tokens were issued specifically for them as the intended audience … MCP servers MUST only accept tokens specifically intended for themselves" },
  { id: "header-only", source: "MCP, Token Requirements",
    words: "Access tokens MUST NOT be included in the URI query string",
    note: "A rule for clients; the server's side of it: a token sent in the query is never accepted." },
  { id: "scope-per-tool", source: "OAUTH 5",
    words: "The resource server MUST validate the access token and ensure that it has not expired and that its scope covers the requested resource." },
  { id: "disconnect-at-once", source: "WeGoPlace's own promise (the approval page: \"You can disconnect it any time from your account page\"); OAUTH 2.4",
    words: "The authorization server MUST consider the security implications of interacting with unauthenticated clients and take measures to limit the potential exposure of tokens issued to such clients" },

  // ── the approval page ──
  { id: "authenticate-first", source: "OAUTH 3.1; 7.13.2",
    words: "The authorization server MUST first authenticate the resource owner. … The authorization server MUST always authenticate the user first … before redirecting the user." },
  { id: "no-framing", source: "OAUTH, Clickjacking; BP, Consent UI Requirements",
    words: "Authorization servers MUST prevent clickjacking attacks." },
  { id: "consent-csrf", source: "BP, Consent UI Requirements; BP, Session Hijacking",
    words: "The MCP-level consent page MUST: … Implement CSRF protection (e.g., state parameter, CSRF tokens) … MCP servers MUST NOT treat possession of a state handle as authentication.",
    note: "Written for proxy servers; WeGoPlace's approval page holds itself to it." },
  { id: "consent-shows", source: "MCP, Client ID Metadata Document Security; BP, Consent UI Requirements",
    words: "Authorization servers: … MUST clearly display the redirect URI hostname during authorization … Clearly identify the requesting MCP client by name" },
  { id: "consent-cookie", source: "BP, Consent Cookie Security",
    words: "If using cookies to track consent decisions, they MUST: Use __Host- prefix for cookie names; Set Secure, HttpOnly, and SameSite=Lax attributes",
    note: "Written for proxy servers; WeGoPlace's approval page holds itself to it." },
  { id: "no-cors-authorize", source: "OAUTH 3.1",
    words: "Cross-Origin Resource Sharing [WHATWG.CORS] MUST NOT be supported at the authorization endpoint" },

  // ── registration ──
  { id: "dcr-bounded", source: "OAUTH 2.4",
    words: "The authorization server MUST consider the security implications of interacting with unauthenticated clients",
    note: "Registration is open to anyone (RFC 7591): a registration over 16 KB is refused, and so is one past a connection's tries." },

  // ── client metadata documents ──
  { id: "cimd-url", source: "CIMD 3",
    words: "A Client Identifier URL: MUST use the https URL scheme; MUST NOT contain a userinfo component; MUST contain a path component other than /; MUST NOT contain single-dot or double-dot path components; … MUST NOT contain a fragment component" },
  { id: "cimd-special-use", source: "CIMD, Server Side Request Forgery",
    words: "Authorization servers MUST NOT fetch a Client ID Metadata Document URL or any URLs contained within a Client ID Metadata Document that resolve to special-use IP addresses as defined in [RFC6890]." },
  { id: "cimd-no-redirects", source: "CIMD 4.2",
    words: "The authorization server MUST NOT automatically follow HTTP redirects when fetching the Client ID Metadata Document." },
  { id: "cimd-client-id-match", source: "CIMD 4; MCP, Client Registration",
    words: "The Client ID Metadata Document MUST contain a client_id property whose value MUST match the Client Identifier URL, which MUST also match the URL that the authorization server used to fetch the document" },
  { id: "cimd-bounded", source: "CIMD, Server Side Request Forgery",
    words: "authorization servers SHOULD limit the amount of data they read and process when fetching a Client ID Metadata Document, for example by stopping after a maximum number of bytes",
    note: "A SHOULD, held as a MUST here: at most 5 KB read, and at most 10 s waited." },
  { id: "cimd-no-error-cache", source: "CIMD 6.2",
    words: "The authorization server MUST NOT cache error responses. The authorization server also MUST NOT cache documents which are invalid or malformed." },
];

/** MUSTs in these sources that bind no part of WeGoPlace, each with why (so the list is whole by intent). */
export const NOT_OURS = [
  ["Every MUST addressed to MCP clients or OAuth clients", "WeGoPlace is the server: the client's own duties (sending resource, using S256, storing tokens) are the app's."],
  ["MCP proxy servers using static client IDs MUST obtain user consent …", "WeGoPlace calls no third-party API with the person's authority: it is no proxy."],
  ["The MCP server MUST NOT pass through the token it received from the MCP client.", "WeGoPlace calls no upstream API with it; its tools work on its own database."],
  ["All authorization server endpoints MUST be served over HTTPS.", "The deployed site's addresses are https (wrangler.jsonc's PUBLIC_ORIGIN, held by check:deploy-routes); a local server is http by nature."],
  ["private_key_jwt and client-secret MUSTs (OAUTH 2.4.1, CIMD 4.1)", "Every client here is public (token_endpoint_auth_method none); the provider's own handling, untested here."],
];

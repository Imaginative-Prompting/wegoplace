// The OAuth provider's own fetches (a client's metadata document, a client's keys), held to the Client ID Metadata
// Document specification's two rules for them (draft-ietf-oauth-client-id-metadata-document):
//   * never a redirect followed (MUST NOT, §4.2): an open redirect on a trusted site would otherwise let any document
//     speak for that site's address, and the approval page would show the trusted name;
//   * never a special-use address (RFC 6890) fetched (MUST NOT, Server Side Request Forgery): a loopback, private,
//     link-local or documentation address, or `localhost`, written in the address itself. A name that resolves to
//     one is kept out by the deployed Worker's network (global_fetch_strictly_public), which this can't see.
// The provider has no option for either, and fetches with the global fetch, so its requests (known by its
// User-Agent) are sent with redirect: "manual" (a redirect comes back as the 3xx it is, which the provider takes for a
// failed fetch), and one to a special-use address isn't sent at all: it is answered 403 here. Every other fetch is
// untouched. checks/mcp-security holds both.

export const PROVIDER_AGENT = "workers-oauth-provider/";

/** IPv4 blocks of RFC 6890 (special-purpose), as [first octets, prefix length]. */
const V4 = [
  [[0], 8], [[10], 8], [[100, 64], 10], [[127], 8], [[169, 254], 16], [[172, 16], 12], [[192, 0, 0], 24], [[192, 0, 2], 24],
  [[192, 88, 99], 24], [[192, 168], 16], [[198, 18], 15], [[198, 51, 100], 24], [[203, 0, 113], 24], [[224], 4], [[240], 4],
];

function v4Special(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const n = m.slice(1).map(Number).reduce((a, b) => a * 256 + b, 0);
  return V4.some(([octets, bits]) => {
    const base = [...octets, 0, 0, 0, 0].slice(0, 4).reduce((a, b) => a * 256 + b, 0);
    const size = 2 ** (32 - bits);
    return n >= base && n < base + size;
  });
}

function v6Special(host) {
  if (!host.startsWith("[")) return false;
  const h = host.slice(1, -1).toLowerCase();
  if (h === "::" || h === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) return v4Special(mapped[1]);
  // The URL parser writes a mapped IPv4 address in hex (::ffff:7f00:1): read it back.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hexMapped) { const a = parseInt(hexMapped[1], 16), b = parseInt(hexMapped[2], 16); return v4Special(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`); }
  const first = parseInt(h.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 // fc00::/7, unique local
    || (first & 0xffc0) === 0xfe80   // fe80::/10, link-local
    || (first & 0xff00) === 0xff00   // ff00::/8, multicast
    || h.startsWith("64:ff9b:") || h.startsWith("100::") || h.startsWith("2001:db8:") || (first === 0x2001 && parseInt(h.split(":")[1] || "0", 16) < 0x200);
}

/** Whether a URL's host is a special-use address, or a name for this machine. */
export function specialUse(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return true; }
  return host === "localhost" || host.endsWith(".localhost") || v4Special(host) || v6Special(host);
}

/** Wraps `fetch` so the provider's requests follow no redirect and reach no special-use address. */
export function providerFetchGuard(base) {
  return function fetch(input, init) {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!(headers.get("User-Agent") ?? "").startsWith(PROVIDER_AGENT)) return base(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (specialUse(url)) return Promise.resolve(new Response("Not fetched: a special-use address.", { status: 403 }));
    return base(input, { ...init, redirect: "manual" });
  };
}

/** Puts the guard on a global scope's fetch, once. */
export function guardProviderFetch(scope = globalThis) {
  if (scope.fetch?.providerFetchGuarded) return;
  const guarded = providerFetchGuard(scope.fetch.bind(scope));
  guarded.providerFetchGuarded = true;
  scope.fetch = guarded;
}

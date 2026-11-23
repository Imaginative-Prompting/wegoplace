// The OAuth provider's client metadata document fetch, on the installed library's own code, in Node: its Workers
// module stood in (cloudflare:workers, the compatibility flag, the Cache API, KV), the network a stand-in that serves
// made-up documents, and the global fetch wrapped by the site's own guard as src/index.js wraps it
// (src/mcp/cimd-fetch.js). The library is asked as the approval page asks it: lookupClient(<the client's URL>).
// Nothing reaches the network.

import { registerHooks } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { providerFetchGuard } from "../../src/mcp/cimd-fetch.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SITE = "https://docs.check.example";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class WorkerEntrypoint {}", shortCircuit: true };
    return next(specifier, context);
  },
});

/** The made-up network: a document per path, each fetch counted. */
function network() {
  const counts = {};
  const doc = (id, extra = {}) => ({ client_id: id, client_name: "Document App", redirect_uris: ["http://127.0.0.1/callback"],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...extra });
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  const fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const p = new URL(url).pathname;
    counts[p] = (counts[p] ?? 0) + 1;
    switch (p) {
      case "/ok.json": return json(doc(url));
      // An open redirect on the trusted site: followed, it lands on a document that claims the trusted address.
      case "/go.json":
        if (init.redirect === "manual") return new Response(null, { status: 302, headers: { Location: "https://evil.check.example/claims.json" } });
        return json(doc(url, { client_name: "Evil, wearing the trusted name" }));
      case "/other.json": return json(doc(`${SITE}/someone-else.json`));
      case "/big.json": return json(doc(url, { client_uri: `${SITE}/${"x".repeat(6 * 1024)}` }));
      case "/slow.json": return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      case "/bad-then-good.json": return counts[p] === 1 ? new Response("{ not json", { status: 200, headers: { "Content-Type": "application/json" } }) : json(doc(url));
      case "/500-then-good.json": return counts[p] === 1 ? json({ error: "down" }, 500) : json(doc(url));
      default: return new Response("no", { status: 404 });
    }
  };
  return { fetch, counts };
}

/** A Cache API with one cache, held in memory. */
function cacheStandIn() {
  const store = new Map();
  const cache = {
    async match(k) { const v = store.get(String(k)); return v ? new Response(v.body, { status: v.status, headers: v.headers }) : undefined; },
    async put(k, res) { store.set(String(k), { body: await res.arrayBuffer(), status: res.status, headers: [...res.headers] }); },
    async delete(k) { return store.delete(String(k)); },
  };
  return { open: async () => cache, store };
}

/** KV, held in memory. */
function kvStandIn() {
  const m = new Map();
  return {
    async get(k, o) { const v = m.get(k); if (v === undefined) return null; return (o === "json" || o?.type === "json") ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = "" } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}

/** The library, fresh, with the site's options and `guarded` deciding whether the site's fetch guard is on. */
async function library({ guarded = true } = {}) {
  const net = network();
  globalThis.Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };
  globalThis.caches = cacheStandIn();
  globalThis.fetch = guarded ? providerFetchGuard(net.fetch) : net.fetch;
  const { getOAuthApi } = await import("@cloudflare/workers-oauth-provider");
  const { providerOptions } = await import("../../src/mcp/oauth.js");
  const handler = { fetch: async () => new Response("") };
  const api = getOAuthApi(providerOptions(`${SITE.replace("docs.", "site.")}/mcp`, { apiHandler: handler, defaultHandler: handler }), { OAUTH_KV: kvStandIn() });
  const lookup = async (p) => { try { return { client: await api.lookupClient(`${SITE}${p}`) }; } catch (e) { return { error: `${e?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { lookup, counts: net.counts };
}

/** Runs `fn` with this process's own fetch, caches and Cloudflare global put back after it, whatever it does. */
const restoring = (fn) => async () => {
  const kept = { fetch: globalThis.fetch, caches: globalThis.caches, Cloudflare: globalThis.Cloudflare };
  try { await fn(); } finally { Object.assign(globalThis, kept); }
};

/** The tests, by rule id (checks/mcp-security/rules.mjs). `t` is the run's report. */
export function cimdLibraryTests(t) {
  return Object.fromEntries(Object.entries(tests(t)).map(([id, fn]) => [id, restoring(fn)]));
}

function tests(t) {
  return {
    "cimd-no-redirects": async () => {
      const on = await library();
      const ok = await on.lookup("/ok.json"), go = await on.lookup("/go.json");
      t.same("a document behind a redirect is refused (a plain one is taken)", [ok.client?.clientName ?? ok.client?.client_name ?? null, !!go.error], ["Document App", true]);
      const off = await library({ guarded: false });
      const followed = await off.lookup("/go.json");
      t.ok("  (the library alone follows it and takes the claim, which is why the guard is there)", !!followed.client, JSON.stringify(followed).slice(0, 160));
      const entry = fs.readFileSync(path.join(ROOT, "src/index.js"), "utf8");
      t.ok("  (src/index.js puts the guard on the Worker's fetch, at its top level)", /^guardProviderFetch\(globalThis\);$/m.test(entry));
    },
    "cimd-client-id-match": async () => {
      const lib = await library();
      const r = await lib.lookup("/other.json");
      t.ok("a document whose client_id isn't the address it was fetched from is refused", !!r.error && !r.client, JSON.stringify(r).slice(0, 160));
    },
    "cimd-bounded": async () => {
      const lib = await library();
      const big = await lib.lookup("/big.json");
      const t0 = Date.now();
      const slow = await lib.lookup("/slow.json");
      const waited = Date.now() - t0;
      t.same("a document over 5 KB is refused; one that never comes is given up within 10 s",
        [!!big.error, !!slow.error, waited <= 11_000], [true, true, true]);
      console.log(`    (gave up on the slow one after ${(waited / 1000).toFixed(1)} s)`);
    },
    "cimd-no-error-cache": async () => {
      const lib = await library();
      const a1 = await lib.lookup("/bad-then-good.json"), a2 = await lib.lookup("/bad-then-good.json");
      const b1 = await lib.lookup("/500-then-good.json"), b2 = await lib.lookup("/500-then-good.json");
      t.same("a malformed document, and an error answer, aren't kept: the next ask fetches again and takes the good one",
        [!!a1.error, !!a2.client, lib.counts["/bad-then-good.json"], !!b1.error, !!b2.client, lib.counts["/500-then-good.json"]], [true, true, 2, true, true, 2]);
    },
  };
}

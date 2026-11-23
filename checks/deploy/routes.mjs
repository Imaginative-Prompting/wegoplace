// What this tree's wrangler does with the site's two routes when it deploys (the cutover attaches
// wegoplace.com/* and www.wegoplace.com/* as routes on the deploy's command line, and
// wrangler.jsonc names none). Against a stand-in for Cloudflare's
// API on this machine, with a throwaway Worker; nothing reaches Cloudflare:
//
//   node checks/deploy/routes.mjs
//
// It holds, for the wrangler in node_modules (package.json pins it):
//   1. `wrangler deploy --route A --route B` puts exactly those two routes on the Worker (one PUT
//      of both, each in the zone wrangler finds for its host), and says so;
//   2. a plain `wrangler deploy` (the deploy of every landing after the cutover) makes no route
//      or zone call at all: the attached routes stay as they are. It says "No targets deployed";
//   3. `wrangler triggers deploy --route A --route B` puts the same two again, with no upload:
//      the way to attach one that didn't take.
// A wrangler that changes any of these fails here before it can move the site's addresses.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { LOCAL_WRANGLER_ENV, ROOT } from "../lib/server.mjs";
import { Report } from "../lib/person.mjs";

const t = new Report("the deploy and the site's two routes");
const WRANGLER = path.join(ROOT, "node_modules/.bin/wrangler");
const ROUTES = ["example.com/*", "www.example.com/*"];
const work = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-deploy-routes-"));
fs.writeFileSync(path.join(work, "worker.mjs"), "export default { fetch: () => new Response(\"ok\") };\n");
fs.writeFileSync(path.join(work, "wrangler.json"), JSON.stringify({ name: "check-routes", main: "worker.mjs", compatibility_date: "2026-01-01", workers_dev: false, preview_urls: false }));

// The stand-in: plain success for what a deploy asks, each call written down.
let calls = [];
const ok = (res, result, extra = {}) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ success: true, errors: [], messages: [], result, ...extra })); };
const page = (n) => ({ result_info: { page: 1, per_page: 50, total_pages: 1, count: n, total_count: n } });
const api = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const u = new URL(req.url, "http://stand-in");
    const p = u.pathname.replace(/^\/client\/v4/, "");
    calls.push({ method: req.method, path: p, query: u.search, body: /json/.test(req.headers["content-type"] ?? "") ? body : "" });
    if (p === "/zones") return ok(res, [{ id: "zone-1", name: "example.com" }], page(1));
    if (/\/zones\/[^/]+\/workers\/routes$/.test(p)) return ok(res, [], page(0));
    if (/\/workers\/scripts\/[^/]+\/routes$/.test(p)) return ok(res, JSON.parse(body || "[]"));
    if (/\/workers\/services\/[^/]+$/.test(p)) return ok(res, { default_environment: { environment: "production", script: { last_deployed_from: "wrangler", tag: "t" } } });
    if (/\/workers\/workers\/[^/]+$/.test(p)) return ok(res, { id: "w-1", name: "check-routes", subdomain: { enabled: false, previews_enabled: false }, observability: { enabled: false }, tags: [] });
    if (/\/versions/.test(p)) return ok(res, { items: [], id: "v-1", number: 1, metadata: {}, resources: { script: { etag: "e", handlers: ["fetch"] }, script_runtime: {}, bindings: [] } });
    if (/\/deployments/.test(p)) return ok(res, { deployments: [], id: "d-1" });
    return ok(res, {});
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));

function wrangler(...args) {
  calls = [];
  const env = { ...process.env, CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${api.address().port}/client/v4`, CLOUDFLARE_API_TOKEN: "stand-in",
    CLOUDFLARE_ACCOUNT_ID: "account-1", ...LOCAL_WRANGLER_ENV, WRANGLER_LOG_PATH: path.join(work, "logs"), NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" };
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) delete env[k];   // the stand-in is on this machine
  // Not spawnSync: the stand-in answers from this same process.
  return new Promise((resolve) => {
    const child = spawn(WRANGLER, args, { cwd: work, env });
    let said = "";
    child.stdout.on("data", (c) => { said += c; });
    child.stderr.on("data", (c) => { said += c; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 90000);
    child.on("close", (status) => { clearTimeout(timer); resolve({ code: status, said, calls }); });
  });
}
const routeCalls = (r) => r.calls.filter((c) => /\/routes$|^\/zones/.test(c.path));
const puts = (r) => r.calls.filter((c) => c.method === "PUT" && /\/workers\/scripts\/check-routes\/routes$/.test(c.path));

let code = 1;
try {
  const reached = await wrangler("deploy", "--route", ROUTES[0], "--route", ROUTES[1]);
  t.same("deploy with both --route flags: it runs", [reached.code, reached.code === 0 ? "" : reached.said.slice(-600)], [0, ""]);
  t.same("  one PUT of exactly those two routes", puts(reached).map((c) => JSON.parse(c.body).map((x) => x.pattern)), [ROUTES]);
  t.ok("  and it says both", ROUTES.every((r) => reached.said.includes(r)) && /Deployed check-routes triggers/.test(reached.said), reached.said.slice(-400));

  const plain = await wrangler("deploy");
  t.same("a plain deploy (every landing after the cutover): it runs", [plain.code, plain.code === 0 ? "" : plain.said.slice(-600)], [0, ""]);
  t.same("  and makes no route or zone call: the attached routes stay", routeCalls(plain), []);
  t.ok("  it says \"No targets deployed\"", /No targets deployed for check-routes/.test(plain.said), plain.said.slice(-300));

  const again = await wrangler("triggers", "deploy", "--route", ROUTES[0], "--route", ROUTES[1]);
  t.same("triggers deploy with both --route flags: the same PUT, no upload", [again.code, puts(again).map((c) => JSON.parse(c.body).map((x) => x.pattern)), again.calls.some((c) => /\/versions/.test(c.path))], [0, [ROUTES], false]);
  code = t.end();
} catch (error) {
  console.error(error);
  t.end();
  code = 2;
} finally {
  api.close();
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(code);

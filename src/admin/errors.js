// The site owner's page of what broke (src/errors.js keeps it): each kind of error by count, with when it was first and last
// seen, the version it was last seen on, the browser, where (a route's pattern), and its frames. Only for the accounts
// ADMIN_ACCOUNTS names (a comma-separated list of account ids, in wrangler.jsonc's vars or a secret). Unset, the page and its
// routes don't exist for anyone: a 404, as an address the site hasn't got. Behind the gate, so someone signed out is sent to
// sign in first. A kind of error the owner has fixed can be cleared here; any kind goes by itself 30 days after it was last seen.

import { clearErrors, errorGroups, ERRORS } from "../errors.js";
import { json } from "../api/json.js";

/** Whether this account is one ADMIN_ACCOUNTS names. Unset or empty: nobody. */
export function isOwner(env, user) {
  const ids = String(env.ADMIN_ACCOUNTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return Boolean(user?.id) && ids.includes(user.id);
}

const NOT_HERE = () => json({ error: "no such route" }, 404);
const notHerePage = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** GET /api/admin/errors: the groups, for the owner. */
export async function list({ env, data }) {
  if (!isOwner(env, data.user)) return NOT_HERE();
  return json({ kept: `A kind of error goes ${ERRORS.keepDays} days after it was last seen.`, groups: await errorGroups(env) }, 200, { "Cache-Control": "no-store" });
}

/** POST /api/admin/errors/clear: { fingerprints } (JSON) or one `fingerprint` (the page's form). Back to the page for a form. */
export async function clear({ request, env, data }) {
  if (!isOwner(env, data.user)) return NOT_HERE();
  const type = request.headers.get("Content-Type") ?? "";
  let fingerprints = [];
  if (type.includes("application/json")) {
    const body = await request.json().catch(() => null);
    fingerprints = Array.isArray(body?.fingerprints) ? body.fingerprints : [];
  } else {
    const form = await request.formData().catch(() => null);
    fingerprints = form ? [String(form.get("fingerprint") ?? "")] : [];
  }
  const cleared = await clearErrors(env, fingerprints);
  if (!type.includes("application/json")) return new Response(null, { status: 303, headers: { Location: "/admin/errors" } });
  return json({ cleared });
}

/** GET /admin/errors: the page. */
export async function page({ env, data }) {
  if (!isOwner(env, data.user)) return notHerePage();
  const groups = await errorGroups(env);
  const rows = groups.map((g) => `
    <tr>
      <td class="n">${g.count}</td>
      <td><strong>${esc(g.name)}</strong> <span class="meta">${esc(g.source)} · ${esc(g.kind)}</span><br>${esc(g.message)}
        ${g.stack ? `<details><summary>where</summary><pre>${esc(g.stack)}</pre></details>` : ""}</td>
      <td>${esc(g.place)}</td>
      <td>${esc(g.version)}<br><span class="meta">${esc(g.browser)}</span></td>
      <td>${when(g.first_seen)}<br>${when(g.last_seen)}</td>
      <td><form method="post" action="/api/admin/errors/clear"><input type="hidden" name="fingerprint" value="${esc(g.fingerprint)}"><button class="btn btn-ghost" type="submit">Fixed</button></form></td>
    </tr>`).join("");
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>What broke · WeGoPlace</title>
<link rel="stylesheet" href="/styles.css">
<style>
  body { padding: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; vertical-align: top; padding: 8px; border-bottom: 1px solid var(--line, #8884); }
  td.n { font-variant-numeric: tabular-nums; text-align: right; }
  pre { white-space: pre-wrap; font-size: 12px; margin: 4px 0 0; }
  .meta { opacity: .7; }
</style>
</head>
<body>
<main>
  <h1 class="h2">What broke</h1>
  <p class="meta">Every kind of error the pages and the server reported, most often first. Nothing here says who, or what they were doing on which trip. A kind goes ${ERRORS.keepDays} days after it was last seen; "Fixed" clears it now.</p>
  ${groups.length ? `<table>
    <thead><tr><th>Count</th><th>What</th><th>Where</th><th>Version</th><th>First and last seen (UTC)</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : `<p>Nothing has broken.</p>`}
</main>
</body>
</html>`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'", "Referrer-Policy": "same-origin" } });
}

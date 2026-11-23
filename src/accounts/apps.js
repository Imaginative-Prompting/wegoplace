// The AI apps an account has connected (the MCP plan, point 2): listed on the account page,
// each with Disconnect. A disconnected app is never handed a token again (src/mcp/oauth.js).
//
//   GET    /api/account/apps        -> { apps: [{ id, name, scope, connected_at }] }
//   DELETE /api/account/apps/:id    -> { ok, disconnected }

import { json } from "../api/json.js";
import { revokeConnection } from "../mcp/oauth.js";

export async function listApps({ env, data }) {
  const apps = [];
  let cursor;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(data.user.id, { cursor });
    for (const g of page.items) {
      apps.push({ id: g.id, name: g.metadata?.clientName ?? "An app", scope: g.scope ?? [], connected_at: g.createdAt ?? null });
    }
    cursor = page.cursor;
  } while (cursor);
  apps.sort((a, b) => (b.connected_at ?? 0) - (a.connected_at ?? 0));
  return json({ apps }, 200);
}

export async function disconnectApp({ env, data, params }) {
  let id;
  try { id = decodeURIComponent(String(params.id ?? "")); } catch { id = ""; }
  const mine = [];
  let cursor;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(data.user.id, { cursor });
    mine.push(...page.items.map((g) => g.id));
    cursor = page.cursor;
  } while (cursor);
  if (!mine.includes(id)) return json({ ok: true, disconnected: false }, 200);
  await revokeConnection(env, env.OAUTH_PROVIDER, data.user.id, id);
  return json({ ok: true, disconnected: true }, 200);
}

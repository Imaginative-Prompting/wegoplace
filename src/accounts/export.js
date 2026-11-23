// GET /api/account/export: what is a person's own, as one JSON file to keep (docs/model.md §20: "A private
// conversation is the person's: stored with their account, in their export, gone with it").
//
// Theirs, and nobody else's, and nothing that would let anyone in: the account (its name, its email addresses,
// the ways in by kind, never a key, a credential's id, a provider's id for them or a session); the trips they
// are or were on, with their role, and on each what they made: their own chat messages (words, when, what each
// was about by name) and their own memories (when, the caption, each file's name and size, and a link that
// downloads it while they're signed in and on the trip); every conversation of theirs with the assistant with its turns, on trips
// they have left too (where no screen reaches them any more); as a host, the assistant's ledger by month and
// trip (calls, tokens, cost; never words, never who asked); their plan (whether it's on, monthly or yearly,
// until when; never Stripe's ids); the AI apps connected, by name; their phones told of the chat, by count; the bug
// reports they sent signed in (src/bug-reports.js), each screenshot by the address that downloads it, to them only.
// A trip's own content (plans, places, Split, everyone else's words) is the trip's, and isn't in it; their own
// purchases are the trip's ledger and stay in Split.

import { entitlement, grantOf } from "../billing/plan.js";
import { EXPORTS_PER_HOUR } from "../../public/js/shared/limits.js";
import { decode, toB64url } from "../../public/js/shared/avatar.js";
import { exportBugReports } from "../bug-reports.js";

const sharedOf = (detail) => { try { const d = JSON.parse(detail || "{}"); return { question: d.question ?? "", answer: d.answer ?? "" }; } catch { return { question: "", answer: "" }; } };
const rows = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results ?? [];

// The file is named by the day on the person's phone (?day=YYYY-MM-DD, public/js/account.js): an evening in New York is
// already tomorrow in UTC. A day more than one from the server's own UTC day isn't a phone's today, and the server's own is
// used instead.
function fileDay(request, now) {
  const own = new Date(now * 1000).toISOString().slice(0, 10);
  const asked = new URL(request.url).searchParams.get("day") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asked)) return own;
  const at = Date.parse(`${asked}T00:00:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== asked) return own;
  return Math.abs(at - Date.parse(`${own}T00:00:00Z`)) <= 86400e3 ? asked : own;
}

export async function getExport({ env, data, request }) {
  const me = data.user.id;
  // At most EXPORTS_PER_HOUR an hour: each reads the whole account. Past it, when the oldest of the hour's is an hour old.
  const now = Math.floor(Date.now() / 1000);
  const hour = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(at) AS first FROM account_exports WHERE user_id = ?1 AND at > ?2").bind(me, now - 3600).first();
  if ((hour?.n ?? 0) >= EXPORTS_PER_HOUR) {
    const wait = Math.max(1, hour.first + 3600 - now);
    return new Response(JSON.stringify({ error: "too many exports", max: EXPORTS_PER_HOUR,
      reason: `That's ${EXPORTS_PER_HOUR} exports in an hour. Try again in ${Math.ceil(wait / 60)} minutes.` }), {
      status: 429, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": String(wait) } });
  }
  await env.DB.prepare("INSERT INTO account_exports (user_id, at) VALUES (?1, ?2)").bind(me, now).run();
  const user = await env.DB.prepare("SELECT id, name, username, created_at, units, native_currency, guest FROM users WHERE id = ?1").bind(me).first();
  const [emails, passkeys, identities, trips, conversations, turns, documents, ledger, push, said, memories, files] = await Promise.all([
    rows(env, "SELECT email, verified_at, created_at FROM account_emails WHERE user_id = ?1 ORDER BY created_at", me),
    rows(env, "SELECT device_type, backed_up, created_at, last_used_at FROM passkeys WHERE user_id = ?1 ORDER BY created_at", me),
    rows(env, "SELECT provider, label, created_at, last_used_at FROM identities WHERE user_id = ?1 ORDER BY created_at", me),
    rows(env, `SELECT t.id, t.name, t.host_id = ?1 AS host, m.joined_at, m.left_at FROM trip_members m JOIN trips t ON t.id = m.trip_id
               WHERE m.user_id = ?1 ORDER BY m.joined_at`, me),
    rows(env, `SELECT c.id, c.trip_id, COALESCE(t.name, '') AS trip_name, c.title, c.created_at, c.updated_at FROM ai_conversations c
               LEFT JOIN trips t ON t.id = c.trip_id WHERE c.user_id = ?1 ORDER BY c.created_at`, me),
    rows(env, "SELECT conversation_id, seq, role, words, detail, created_at FROM ai_turns WHERE user_id = ?1 ORDER BY conversation_id, seq", me),
    rows(env, "SELECT id, trip_id, conversation_id, name, mime, bytes, pages, text_chars, state, created_at FROM ai_files WHERE user_id = ?1 ORDER BY conversation_id, created_at, id", me),
    rows(env, `SELECT a.month, a.trip_id, COALESCE(t.name, '') AS trip_name, COUNT(*) AS calls,
                 COALESCE(SUM(a.prompt_tokens), 0) AS prompt_tokens, COALESCE(SUM(a.completion_tokens), 0) AS completion_tokens,
                 COALESCE(SUM(CASE WHEN a.state = 'settled' THEN a.cost ELSE a.worst END), 0) AS cost_micro
               FROM ai_calls a LEFT JOIN trips t ON t.id = a.trip_id WHERE a.host_id = ?1 GROUP BY a.month, a.trip_id ORDER BY a.month, a.trip_id`, me),
    env.DB.prepare("SELECT COUNT(*) AS n, MAX(created_at) AS newest FROM push_subscriptions WHERE user_id = ?1").bind(me).first(),
    // Their own words, and what they shared from a conversation of theirs; never the assistant's answers in the
    // chat (kind "assistant": kept under the asker's name, but the assistant's words, read by the whole trip).
    rows(env, `SELECT trip_id, id, kind, body, about_kind, about_name, about_part, created_at, edited_at, detail FROM messages
               WHERE author = ?1 AND kind != 'assistant' AND deleted_at IS NULL ORDER BY trip_id, seq`, me),
    rows(env, "SELECT id, trip_id, caption, created_at, day FROM memories WHERE created_by = ?1 ORDER BY trip_id, created_at", me),
    rows(env, `SELECT mm.memory_id, mm.r2_key, mm.kind, COALESCE(o.orig_name, '') AS name, COALESCE(o.bytes, mm.bytes, 0) AS bytes
               FROM memory_media mm JOIN memories m ON m.id = mm.memory_id LEFT JOIN media_objects o ON o.r2_key = mm.r2_key
               WHERE m.created_by = ?1 ORDER BY mm.memory_id, mm.sort`, me),
  ]);
  const site = String(env.PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
  const filesOf = new Map();
  for (const f of files) {
    const list = filesOf.get(f.memory_id) ?? [];
    list.push({ name: f.name, kind: f.kind, bytes: Number(f.bytes) || 0, url: `${site}/media/${f.r2_key}` });
    filesOf.set(f.memory_id, list);
  }
  const byTrip = (list) => list.reduce((m, r) => m.set(r.trip_id, [...(m.get(r.trip_id) ?? []), r]), new Map());
  const saidOn = byTrip(said), memoriesOn = byTrip(memories);
  const byConversation = new Map();
  for (const t of turns) {
    let detail = {};
    try { detail = JSON.parse(t.detail || "{}"); } catch { detail = {}; }
    const list = byConversation.get(t.conversation_id) ?? [];
    list.push({ seq: t.seq, role: t.role, words: t.words, created_at: t.created_at, ...(t.role === "assistant" ? { detail } : {}) });
    byConversation.set(t.conversation_id, list);
  }
  let apps = [];
  try {
    for (let cursor, first = true; first || cursor; first = false) {
      const page = await env.OAUTH_PROVIDER.listUserGrants(me, { cursor });
      for (const g of page.items) apps.push({ name: g.metadata?.clientName ?? "An app", scope: g.scope ?? [], connected_at: g.createdAt ?? null });
      cursor = page.cursor;
    }
  } catch { apps = null; }   // the app list couldn't be read just now: said as null, never left out silently
  // The plan: a subscription's (while the site sells it), or the operator's grant (whether or not it does), and the grant
  // itself as recorded: when, and the operator's words for why.
  const [plan, grant] = await Promise.all([entitlement(env, me), grantOf(env, me)]);
  // Their drawn picture (0043), when they have one: its strokes to read, and its bytes as stored.
  const drawn = await env.DB.prepare("SELECT d.hash, d.bytes FROM users u JOIN drawings d ON d.hash = u.avatar WHERE u.id = ?1").bind(me).first();
  const picture = drawn ? (() => { const bytes = new Uint8Array(drawn.bytes); return { hash: drawn.hash, drawing: decode(bytes), bytes: toB64url(bytes) }; })() : null;
  const body = {
    exported_at: Math.floor(Date.now() / 1000),
    about: "Your WeGoPlace account's own data. A trip's plans, places, Split and chat belong to the trip and aren't in it.",
    account: { ...user, guest: !!user?.guest, emails, ways_in: [...passkeys.map((p) => ({ kind: "passkey", device_type: p.device_type, backed_up: !!p.backed_up, created_at: p.created_at, last_used_at: p.last_used_at })),
      ...identities.map((i) => ({ kind: i.provider, label: i.label, created_at: i.created_at, last_used_at: i.last_used_at }))],
      ...(picture ? { picture } : {}) },
    trips: trips.map((t) => ({
      id: t.id, name: t.name, role: t.host ? "host" : "member", joined_at: t.joined_at, left_at: t.left_at ?? null,
      // What they made on it: their own words in its chat, and their own memories with their files.
      messages: (saidOn.get(t.id) ?? []).map((m) => ({ id: m.id, kind: m.kind, words: m.body, created_at: m.created_at, edited_at: m.edited_at ?? null,
        about: m.about_kind ? { kind: m.about_kind, name: m.about_name, ...(m.about_part ? { part: m.about_part } : {}) } : null,
        ...(m.kind === "shared" ? { shared: sharedOf(m.detail) } : {}) })),
      memories: (memoriesOn.get(t.id) ?? []).map((m) => ({ id: m.id, created_at: m.created_at, day: m.day ?? null, caption: m.caption ?? "", files: filesOf.get(m.id) ?? [] })),
    })),
    assistant: {
      // Each conversation with its turns and the documents given it (src/assistant/files.js): what each is, and the
      // address its original downloads from, to its person only, while it is kept.
      conversations: conversations.map((c) => ({ ...c, turns: byConversation.get(c.id) ?? [],
        documents: documents.filter((f) => f.conversation_id === c.id).map((f) => ({ id: f.id, name: f.name, mime: f.mime, bytes: f.bytes, pages: f.pages ?? null,
          characters: f.text_chars, state: f.state, created_at: f.created_at,
          ...(f.state === "ready" ? { url: `${site}/api/trips/${encodeURIComponent(f.trip_id)}/assistant/conversations/${encodeURIComponent(c.id)}/files/${encodeURIComponent(f.id)}` } : {}) })) })),
      // As a host: what the assistant cost on your trips, by month and trip; never words, never who asked.
      ledger: ledger.map((l) => ({ ...l, trip_id: l.trip_id || null, trip_name: l.trip_name || (l.trip_id ? "" : "a trip deleted since") })),
    },
    plan: plan ? { active: plan.active, status: plan.status, interval: plan.interval, until: plan.until, cancels: plan.cancels } : null,
    plan_grant: grant ? { granted_at: grant.granted_at, reason: grant.reason } : null,
    apps,
    push: { devices: Number(push?.n) || 0, newest: push?.newest ?? null },
    bug_reports: await exportBugReports(env, me, site),
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="wegoplace-account-${fileDay(request, now)}.json"` },
  });
}

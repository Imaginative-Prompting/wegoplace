// Changes an AI makes, and undoing them (model §9).
//
// Every write through the MCP is one CHANGE: who asked, where it came from (`oauth:<app name>`),
// when, a one-line summary, and each row it touched, before and after. The database records the
// rows itself, so the record is exactly what was written, in the same transaction:
//
//   * migrations/0023_changes.sql puts three triggers (insert, update, delete) on every table in
//     TRACKED. A trigger records a row only while `change_open` holds a change's id;
//   * write() (src/trips/rev.js) opens the change as the first statements of its batch and closes
//     it as the last, when the request carries one (`env.CHANGE`, set by the MCP's tools and by an
//     undo). A batch is one transaction, and D1 runs one at a time, so a row written by hand in
//     the app, in its own batch, is never recorded: "Edits made by hand in the app aren't listed."
//
// A tool call that writes more than once (an itinerary's events, one route call each) opens the
// same change each time; the change is one line, and one undo.
//
// UNDO puts each row back as it was before the change, newest first, if the row is still as the
// change left it; a row written since is named and left alone. An undo is a write by the person
// pressing it: held to the same per-row rules (a packing item that is someone's own is theirs
// alone to put back; a purchase is its logger's or payer's, a payment its receiver's too; and the
// person must still be on the trip), and itself a change, so it can be undone.
//
// PRIVATE ROWS: a person's own packing items, with their bags and ticks, are theirs. Everyone on
// the trip sees a change's line; its private rows are shown, and undone, only for their owner.
//
// PICTURES: a picture a change replaced or removed isn't drained: its file is HELD (files_held)
// and still counted to the host, so an undo can put the picture back. The cron frees what is held
// once its change is CHANGE_DAYS old (src/trips/drain.js), or when the host clears the list.

import { CHANGE_DAYS, CHANGE_SUMMARY_MAX } from "../../public/js/shared/limits.js";
import { json } from "../api/json.js";
import { mayTouchPurchase } from "../api/purchases.js";
import { REV, write } from "./rev.js";

// The group's own packing list, as src/api/packing.js names it (GROUP). Written out here because
// TRACKED is built as this module loads, and packing.js loads this one through rev.js;
// check:changes holds that the two are the same word.
export const GROUP = "group";

const own = (side) => `NULLIF((SELECT owner FROM packing_items WHERE id = ${side}.item_id), '${GROUP}')`;

/**
 * The tables a change records, with each row's key (its primary key's columns), which writes are
 * recorded, and whose row it is when it's private. `watch`: for the trip's own row, only these
 * columns make a change (its rev moves in every write).
 */
export const TRACKED = [
  { table: "trips", key: ["id"], ops: ["update"], watch: ["name", "starts_on", "ends_on", "default_tz", "currencies", "interests"] },
  { table: "areas", key: ["trip_id", "id"], ops: ["insert", "update", "delete"] },
  { table: "places", key: ["trip_id", "id"], ops: ["insert", "update", "delete"] },
  { table: "trip_references", key: ["trip_id", "id"], ops: ["insert", "update", "delete"] },
  { table: "events", key: ["trip_id", "id"], ops: ["insert", "update", "delete"] },
  { table: "packing_lists", key: ["trip_id", "key"], ops: ["insert", "update", "delete"] },
  { table: "packing_bags", key: ["trip_id", "list_key", "key"], ops: ["insert", "update", "delete"] },
  { table: "packing_starters", key: ["trip_id", "id"], ops: ["insert", "update", "delete"] },
  { table: "packing_items", key: ["id"], ops: ["insert", "update", "delete"], private: `NULLIF($.owner, '${GROUP}')` },
  { table: "packing_placements", key: ["item_id", "list_key"], ops: ["insert", "update", "delete"], private: own("$") },
  { table: "packing_ticks", key: ["item_id", "list_key", "day"], ops: ["insert", "update", "delete"], private: own("$") },
  { table: "purchases", key: ["id"], ops: ["insert", "update", "delete"] },
  { table: "purchase_shares", key: ["purchase_id", "user_id"], ops: ["insert", "update", "delete"] },
  { table: "pictures", key: ["trip_id", "target_kind", "target_id"], ops: ["insert", "update", "delete"] },
];

/**
 * Every other table, and why a change never records it. check:changes fails on a table that is
 * on neither list, so a new table is one or the other on purpose.
 */
export const UNTRACKED = {
  users: "accounts: no tool writes them", account_emails: "accounts", identities: "accounts", passkeys: "accounts",
  sessions: "accounts", signin_links: "accounts", challenges: "accounts", email_codes: "accounts", email_sends: "accounts",
  old_cookie_accounts: "accounts",
  trip_members: "who is on a trip: no tool adds or removes anyone (model §13)",
  messages: "the trip's chat: no tool writes it (model §17; whether an AI may read it is §15's open question)",
  billing_customers: "the plan (model §20): an account's, never a trip's; no tool touches it", billing_subscriptions: "the plan", plan_grants: "the plan given by the operator (0046): an account's, written only by tools/plan-grant.mjs",
  billing_events: "the plan: Stripe's events, each once", billing_disputes: "the plan",
  ai_calls: "the assistant's meter and ledger (model §20): the host's money, never a trip's row to undo",
  ai_tags: "the assistant: an account's opaque tag for the model's provider",
  ai_conversations: "the assistant: a person's own conversations, theirs alone (§20); no tool reads or writes them",
  ai_files: "the assistant: the documents a person gives it in their own conversation, theirs alone; read by read_document, never written by a tool (what the assistant makes of one is written by the trip's own tools, each change recorded)",
  ai_turns: "the assistant: a conversation's turns", ai_asks: "the assistant: one ask at a time per trip, while it runs",
  trip_links: "join links: no tool makes one (model §13)",
  trip_handovers: "handing a trip over: no tool does (model §13)",
  collage_shares: "boards shared by link: no tool shares one", collage_share_items: "boards shared by link",
  memories: "memories are people's own photographs: no tool writes them", memory_media: "memories", memory_tags: "memories",
  media_objects: "files: a picture's row (pictures) is what a change records; its file is held, not recorded",
  picture_links: "one-use upload links: used once, then spent; the picture they set is recorded",
  files_to_delete: "the drain's queue", files_held: "pictures a change replaced or removed, kept for its undo",
  fx_rates: "exchange rates: the site's, not a trip's",
  revoked_grants: "disconnected AI apps: an account's, not a trip's",
  oauth_refresh_used: "AI apps' refresh tokens redeemed, by hash: an account's, not a trip's",
  error_groups: "what broke, counted by kind: the site's, not a trip's",
  bug_reports: "what people report going wrong (0047): the site operator's, not a trip's",
  push_subscriptions: "where a person's phones hear of new messages: an account's, not a trip's",
  account_exports: "when an account exported its own (EXPORTS_PER_HOUR): an account's, not a trip's",
  drawings: "a person's drawn picture, by its hash (0043): an account's, not a trip's",
  hour_counts: "guests made and rejoin links, counted by the hour: the site's, not a trip's",
  trip_changes: "the record itself", trip_change_rows: "the record itself", change_open: "the record itself",
  trip_gone: "what went, for a phone asking since its last (0036); undone with the rows it records", trip_delta_floor: "how far that record goes back (0036)",
  d1_migrations: "the database's own", sqlite_sequence: "the database's own", _cf_KV: "the database's own", _cf_METADATA: "the database's own",
};

const tracked = new Map(TRACKED.map((t) => [t.table, t]));

/** A new change for env.CHANGE: one tool call, or one undo. */
export function newChange({ user, source, summary, kind = "write", undoOf = null }) {
  return {
    id: crypto.randomUUID(), userId: user.id, source: String(source).slice(0, 120),
    summary: String(summary ?? "").trim().slice(0, CHANGE_SUMMARY_MAX), kind, undoOf,
  };
}

/** What a summary must be, for a tool to refuse before anything is written. Answers a reason, or null. */
export function summaryProblem(summary) {
  if (typeof summary !== "string" || !summary.trim()) return "Every write takes a summary: the one line people see in the trip's list of changes.";
  if (summary.trim().length > CHANGE_SUMMARY_MAX) return `A summary is at most ${CHANGE_SUMMARY_MAX} characters.`;
  return null;
}

/** The statements that open env.CHANGE in a write's batch, right after the rev moves. */
export function openSteps(env, tripId) {
  const c = env.CHANGE;
  const now = Math.floor(Date.now() / 1000);
  return [
    env.DB.prepare(
      `INSERT OR IGNORE INTO trip_changes (id, trip_id, user_id, source, summary, kind, undo_of, rev, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ${REV(2)}, ?8)`,
    ).bind(c.id, tripId, c.userId, c.source, c.summary, c.kind, c.undoOf, now),
    env.DB.prepare("INSERT INTO change_open (change_id) VALUES (?1)").bind(c.id),
  ];
}

/** The statements that close it, last in the batch. A change that recorded no row isn't kept. */
export function closeSteps(env, tripId) {
  const c = env.CHANGE;
  return [
    env.DB.prepare("DELETE FROM change_open"),
    env.DB.prepare(`UPDATE trip_changes SET rev = ${REV(2)} WHERE id = ?1`).bind(c.id, tripId),
    env.DB.prepare(
      `DELETE FROM trip_changes WHERE id = ?1 AND kind != 'create'
       AND NOT EXISTS (SELECT 1 FROM trip_change_rows WHERE change_id = ?1)
       AND NOT EXISTS (SELECT 1 FROM files_held WHERE change_id = ?1)`,
    ).bind(c.id),
  ];
}

/** A change with no rows that is still a line: making a trip (it has no undo; undoing it would delete a trip). */
export async function recordCreate(env, tripId, change) {
  await env.DB.prepare(
    `INSERT INTO trip_changes (id, trip_id, user_id, source, summary, kind, undo_of, rev, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'create', NULL, (SELECT rev FROM trips WHERE id = ?2), ?6)`,
  ).bind(change.id, tripId, change.userId, change.source, change.summary, Math.floor(Date.now() / 1000)).run();
}

// ── reading ──────────────────────────────────────────────────────────────────────────────────

const OPS = { true_true: "changed", false_true: "added", true_false: "removed" };
const opOf = (before, after) => OPS[`${before != null}_${after != null}`] ?? "changed";
const parse = (s) => (s == null ? null : JSON.parse(s));
/** A row's name as people know it, for the list. */
function labelOf(table, row) {
  if (!row) return null;
  const v = row.name ?? row.title ?? row.label ?? row.description ?? row.body ?? null;
  if (v != null) return String(v).slice(0, 80);
  if (table === "pictures") return `${row.target_kind === "cover" ? "the cover" : `${row.target_kind} ${row.target_id}`}'s picture`;
  if (table === "packing_placements") return `in a bag on ${row.list_key}`;
  if (table === "packing_ticks") return `ticked on ${row.list_key}${row.day ? `, ${row.day}` : ""}`;
  if (table === "purchase_shares") return "a share";
  return null;
}

/**
 * The rows of these changes, net of each change's own steps: per change and row, its state before
 * the change and after it. One query, whatever the number of changes.
 */
async function netRowsOf(env, changeIds) {
  const out = new Map(changeIds.map((id) => [id, new Map()]));
  if (!changeIds.length) return new Map();
  const rows = (await env.DB.prepare(
    `SELECT change_id, seq, tbl, row_key, private_to, before, after FROM trip_change_rows
     WHERE change_id IN (SELECT value FROM json_each(?1)) ORDER BY seq`,
  ).bind(JSON.stringify(changeIds)).all()).results ?? [];
  for (const r of rows) {
    const byKey = out.get(r.change_id);
    const k = `${r.tbl}\n${r.row_key}`;
    const had = byKey.get(k);
    if (had) { had.after = r.after; had.last = r.seq; had.private_to = had.private_to ?? r.private_to; }
    else byKey.set(k, { table: r.tbl, key: r.row_key, private_to: r.private_to, before: r.before, after: r.after, first: r.seq, last: r.seq });
  }
  // A row the change added and removed again is no change.
  return new Map([...out].map(([id, byKey]) => [id, [...byKey.values()].filter((r) => r.before !== null || r.after !== null)]));
}

/**
 * The rev of the newest line in the trip's list that `user` has something to notice in: every
 * line of the last CHANGE_DAYS but making a trip and the undos this person pressed in the app
 * themselves. The app's mark on Other compares it with the newest it has shown them. One
 * indexed query; null when there is none.
 */
export async function newestChangeFor(env, tripId, user) {
  const since = Math.floor(Date.now() / 1000) - CHANGE_DAYS * 86400;
  // The newest such change: the trip's changes walked by rev from the newest end (trip_changes_by_rev, 0035),
  // stopped at the first that counts. MAX(rev) read every change of the month on each snapshot
  // (tools/trip-cost.mjs: 1,500 rows on a busy trip). The "+" keeps the month a filter, not the index: with
  // it as the index, every change of the month is read and sorted. Someone whose own app made the month's
  // changes still has them all read (none of them counts for them).
  const r = await env.DB.prepare(
    `SELECT rev FROM trip_changes
     WHERE trip_id = ?1 AND +created_at >= ?2 AND kind != 'create' AND NOT (source = 'app' AND user_id = ?3)
     ORDER BY rev DESC LIMIT 1`,
  ).bind(tripId, since, user.id).first();
  return Number.isInteger(r?.rev) ? r.rev : null;
}

/**
 * The trip's list of changes, newest first, as `user` may see it: every line, and each line's
 * rows, but a row private to someone else only as a count. Each row the person couldn't put
 * back as it stands now says so (`may_not`: the reason undo would give, and who can: the
 * people a purchase's own rule names), by the same rule undo holds it to (mayWrite).
 */
export async function listChanges(env, tripId, user, { limit = 50, before = null } = {}) {
  const since = Math.floor(Date.now() / 1000) - CHANGE_DAYS * 86400;
  const lines = (await env.DB.prepare(
    `SELECT c.id, c.user_id, u.name AS user_name, c.source, c.summary, c.kind, c.undo_of, c.rev, c.created_at,
            (SELECT d.id FROM trip_changes d WHERE d.undo_of = c.id ORDER BY d.created_at DESC LIMIT 1) AS undone_by
     FROM trip_changes c LEFT JOIN users u ON u.id = c.user_id
     WHERE c.trip_id = ?1 AND c.created_at >= ?2 AND (?3 IS NULL OR c.created_at < ?3)
     ORDER BY c.created_at DESC, c.rowid DESC LIMIT ?4`,
  ).bind(tripId, since, before, Math.min(Math.max(limit, 1), 200)).all()).results ?? [];
  const rowsOf = await netRowsOf(env, lines.map((c) => c.id));
  // The purchases the rows touch, as they are now, and the files pictures would point back at:
  // what mayWrite reads, read once for the whole page.
  const purchaseIds = [];
  const pictureKeys = [];
  for (const rows of rowsOf.values()) {
    for (const r of rows) {
      for (const side of [parse(r.before), parse(r.after)].filter(Boolean)) {
        if (r.table === "purchases") purchaseIds.push(side.id);
        if (r.table === "purchase_shares") purchaseIds.push(side.purchase_id);
        if (r.table === "pictures" && side.target_kind === "purchase") purchaseIds.push(side.target_id);
      }
      if (r.table === "pictures" && parse(r.before)?.r2_key) pictureKeys.push(parse(r.before).r2_key);
    }
  }
  const stored = pictureKeys.length
    ? (await env.DB.prepare("SELECT r2_key FROM media_objects WHERE state = 'stored' AND r2_key IN (SELECT value FROM json_each(?1))").bind(JSON.stringify([...new Set(pictureKeys)])).all()).results ?? []
    : [];
  const known = { purchases: await purchasesOf(env, tripId, purchaseIds), stored: new Set(stored.map((x) => x.r2_key)) };
  /** Who may change a purchase: who logged it, who paid, and for a payment who received it. */
  const mayChange = (id) => {
    const p = known.purchases.get(id);
    if (!p) return [];
    return [...new Set([p.created_by, p.paid_by, ...(p.kind === "payment" ? p.shares.map((s) => s.user_id) : [])].filter(Boolean))];
  };
  const out = [];
  for (const c of lines) {
    const rows = rowsOf.get(c.id) ?? [];
    const mine = rows.filter((r) => r.private_to == null || r.private_to === user.id);
    out.push({
      id: c.id, by: { id: c.user_id, name: c.user_name ?? null }, source: c.source, summary: c.summary, kind: c.kind,
      undo_of: c.undo_of, undone_by: c.undone_by ?? null, rev: c.rev, created_at: c.created_at,
      undoable: c.kind !== "create",
      rows: mine.map((r) => {
        const b = parse(r.before);
        const a = parse(r.after);
        const t = tracked.get(r.table);
        // The row as it is now stands in for `now` only where the rule reads it: a purchase's.
        const nowRow = r.table === "purchases" ? (known.purchases.get((a ?? b)?.id) ?? null) : a;
        const why = t ? mayWrite(user, t, nowRow, b, known) : "not a table a change puts back";
        const pid = r.table === "purchases" ? (a ?? b)?.id : r.table === "purchase_shares" ? (a ?? b)?.purchase_id
          : r.table === "pictures" && (a ?? b)?.target_kind === "purchase" ? (a ?? b).target_id : null;
        return {
          table: r.table, key: JSON.parse(r.key), op: opOf(b, a), label: labelOf(r.table, a ?? b), private: r.private_to != null,
          ...(r.table === "purchases" && (a ?? b)?.kind === "payment" ? { payment: true } : {}),
          may_not: why ? { why, who: pid ? mayChange(pid) : [] } : null,
        };
      }),
      private_rows_of_others: rows.length - mine.length,
    });
  }
  return out;
}

// ── undo ─────────────────────────────────────────────────────────────────────────────────────

const whereKey = (t, at) => t.key.map((c, i) => `${c} = json_extract(?${at}, '$[${i}]')`).join(" AND ");

/**
 * The rows of one table as they are now, by key (the key as the triggers write it), each as an
 * object of its columns. One query a table.
 */
async function rowsNow(env, t, cols, tripId, keys) {
  const scoped = cols.includes("trip_id");
  const stmt = env.DB.prepare(
    `SELECT json_array(${t.key.join(", ")}) AS k, json_object(${cols.map((c) => `'${c}', ${c}`).join(", ")}) AS row
     FROM ${t.table} WHERE json_array(${t.key.join(", ")}) IN (SELECT value FROM json_each(?1))${scoped ? " AND trip_id = ?2" : ""}`,
  );
  const list = JSON.stringify(keys.map((k) => JSON.parse(k)));
  const got = (await (scoped ? stmt.bind(list, tripId) : stmt.bind(list)).all()).results ?? [];
  return new Map(got.map((r) => [r.k, JSON.parse(r.row)]));
}

const same = (a, b, cols) => cols.every((c) => JSON.stringify(a?.[c] ?? null) === JSON.stringify(b?.[c] ?? null));

/** The purchases these rows touch, with their shares as they are now: two queries. */
async function purchasesOf(env, tripId, ids) {
  if (!ids.length) return new Map();
  const list = JSON.stringify([...new Set(ids)]);
  const [ps, ss] = await env.DB.batch([
    env.DB.prepare("SELECT id, created_by, paid_by, kind FROM purchases WHERE trip_id = ?2 AND id IN (SELECT value FROM json_each(?1))").bind(list, tripId),
    env.DB.prepare("SELECT purchase_id, user_id FROM purchase_shares WHERE purchase_id IN (SELECT value FROM json_each(?1))").bind(list),
  ]);
  const shares = new Map();
  for (const s of ss.results ?? []) (shares.get(s.purchase_id) ?? shares.set(s.purchase_id, []).get(s.purchase_id)).push(s);
  return new Map((ps.results ?? []).map((p) => [p.id, { ...p, shares: shares.get(p.id) ?? [] }]));
}

const NOT_YOURS = "a purchase is changed by who logged it or who paid (a payment by who received it too)";

/**
 * Whether `user` may write this row as it is and as it would be put back: the routes' own rules.
 * Answers a reason it may not, or null. `known` holds the purchases and stored files read for it.
 */
function mayWrite(user, t, now, back, known) {
  if (t.table === "packing_items") {
    const owners = [now?.owner, back?.owner].filter((o) => o != null);
    if (owners.some((o) => o !== GROUP && o !== user.id)) return "someone's own packing list";
  }
  if (t.table === "purchases") {
    for (const row of [now, back].filter(Boolean)) {
      const shares = known.purchases.get(row.id)?.shares ?? [];
      if (!mayTouchPurchase(row, user, shares)) return NOT_YOURS;
    }
  }
  if (t.table === "purchase_shares") {
    const p = known.purchases.get(now?.purchase_id ?? back?.purchase_id);
    if (p && !mayTouchPurchase(p, user, p.shares)) return NOT_YOURS;
  }
  if (t.table === "pictures") {
    const row = back ?? now;
    if (row?.target_kind === "purchase") {
      const p = known.purchases.get(row.target_id);
      if (p && !mayTouchPurchase(p, user, [])) return "a receipt is changed by whoever may change its purchase";
    }
    if (back?.r2_key && !known.stored.has(back.r2_key)) return "its picture's file is gone";
  }
  return null;
}

export class UndoRefused extends Error {
  constructor(status, error, reason) { super(reason); this.status = status; this.error = error; this.reason = reason; }
}

/**
 * Undoes change `changeId` of `trip` as `user`, recorded as a change of its own from `source`.
 * Answers { change, undone, put_back: [{ table, key, label }], left: [{ table, key, label, why }] }, or throws
 * UndoRefused. `put_back`: the rows put back as they were; `left`: the ones that couldn't be, with why.
 */
export async function undoChange(env, trip, user, changeId, { source }) {
  const c = await env.DB.prepare("SELECT id, kind, summary, created_at FROM trip_changes WHERE id = ?1 AND trip_id = ?2").bind(changeId, trip.id).first();
  if (!c || c.created_at < Math.floor(Date.now() / 1000) - CHANGE_DAYS * 86400) {
    throw new UndoRefused(404, "no such change", `The trip has no change ${changeId} in the last ${CHANGE_DAYS} days.`);
  }
  if (c.kind === "create") throw new UndoRefused(409, "can't undo", "Making a trip can't be undone: that would be deleting it, which only its host does, in the app.");
  const rows = ((await netRowsOf(env, [changeId])).get(changeId) ?? []).sort((a, b) => b.last - a.last);
  const change = newChange({ user, source, summary: `Undid: ${c.summary}`.slice(0, CHANGE_SUMMARY_MAX), kind: "undo", undoOf: changeId });
  const steps = [];
  const left = [];
  let undone = 0;
  // What is there now, read once per table; the purchases the rows touch; the files pictures would point at.
  const cols = new Map();
  const now = new Map();
  for (const table of new Set(rows.map((r) => r.table))) {
    const t = tracked.get(table);
    if (!t) continue;
    // The columns are the ones the triggers recorded: every column of the table (check:changes).
    const sample = rows.find((r) => r.table === table);
    cols.set(table, Object.keys(parse(sample.before ?? sample.after)));
    now.set(table, await rowsNow(env, t, cols.get(table), trip.id, rows.filter((r) => r.table === table).map((r) => r.key)));
  }
  const purchaseIds = [];
  const pictureKeys = [];
  for (const r of rows) {
    for (const side of [parse(r.before), parse(r.after)].filter(Boolean)) {
      if (r.table === "purchases") purchaseIds.push(side.id);
      if (r.table === "purchase_shares") purchaseIds.push(side.purchase_id);
      if (r.table === "pictures" && side.target_kind === "purchase") purchaseIds.push(side.target_id);
    }
    if (r.table === "pictures" && parse(r.before)?.r2_key) pictureKeys.push(parse(r.before).r2_key);
  }
  const stored = pictureKeys.length
    ? (await env.DB.prepare("SELECT r2_key FROM media_objects WHERE state = 'stored' AND r2_key IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(pictureKeys)).all()).results ?? []
    : [];
  const known = { purchases: await purchasesOf(env, trip.id, purchaseIds), stored: new Set(stored.map((x) => x.r2_key)) };
  // Each row's statements, kept together: a row is put back whole or left whole.
  const groups = [];
  for (const r of rows) {
    const t = tracked.get(r.table);
    if (!t) {
      // A note a change removed before notes moved into the chat (migration 0027): there is no
      // note to put back any more, and the rest of the change undoes as usual.
      const why = r.table === "event_notes"
        ? "a note on a plan, removed before notes became messages in the chat: it can't be brought back"
        : "not a table a change puts back";
      left.push({ table: r.table, key: JSON.parse(r.key), label: labelOf(r.table, parse(r.before ?? r.after)), why });
      continue;
    }
    if (r.private_to != null && r.private_to !== user.id) {
      left.push({ table: r.table, key: null, label: null, why: "private to someone else: only they can put it back" });
      continue;
    }
    const all = cols.get(t.table);
    const compared = t.watch ?? all;
    const before = parse(r.before);
    const after = parse(r.after);
    const there = now.get(t.table).get(r.key) ?? null;
    const asLeft = after === null ? there === null : there !== null && same(there, after, compared);
    const label = labelOf(t.table, after ?? before);
    if (!asLeft) { left.push({ table: t.table, key: JSON.parse(r.key), label, why: "written since" }); continue; }
    const why = mayWrite(user, t, there, before, known);
    if (why) { left.push({ table: t.table, key: JSON.parse(r.key), label, why }); continue; }
    // Each statement binds exactly what it names (D1 refuses a parameter its SQL doesn't).
    const hasRev = all.includes("rev") && t.table !== "trips";
    const stmts = [];
    if (before === null) {
      stmts.push(env.DB.prepare(`DELETE FROM ${t.table} WHERE ${whereKey(t, 1)}`).bind(r.key));
    } else if (there !== null) {
      // ?1 the row as it was, ?2 its key, ?3 the trip (for its rev).
      const set = (t.watch ?? all.filter((x) => !t.key.includes(x) && x !== "rev")).map((x) => `${x} = json_extract(?1, '$.${x}')`);
      if (hasRev) set.push(`rev = ${REV(3)}`);
      const stmt = env.DB.prepare(`UPDATE ${t.table} SET ${set.join(", ")} WHERE ${whereKey(t, 2)}`);
      stmts.push(hasRev ? stmt.bind(r.before, r.key, trip.id) : stmt.bind(r.before, r.key));
    } else {
      // ?1 the row as it was, ?2 the trip (for its rev).
      const values = all.map((x) => (x === "rev" && hasRev ? REV(2) : `json_extract(?1, '$.${x}')`));
      const stmt = env.DB.prepare(`INSERT INTO ${t.table} (${all.join(", ")}) SELECT ${values.join(", ")}`);
      stmts.push(hasRev ? stmt.bind(r.before, trip.id) : stmt.bind(r.before));
    }
    if (t.table === "pictures") {
      // The file the change left in place is held for this undo's own undo; the one put back is no longer held.
      if (after?.r2_key && after.r2_key !== before?.r2_key) {
        stmts.push(env.DB.prepare("INSERT OR IGNORE INTO files_held (r2_key, trip_id, change_id, held_at) VALUES (?1, ?2, ?3, ?4)")
          .bind(after.r2_key, trip.id, change.id, Math.floor(Date.now() / 1000)));
      }
      if (before?.r2_key) stmts.push(env.DB.prepare("DELETE FROM files_held WHERE r2_key = ?1").bind(before.r2_key));
    }
    groups.push({ table: t.table, key: JSON.parse(r.key), label, stmts });
  }
  if (!groups.length) return { change: null, undone: 0, put_back: [], left };
  const putBack = [];
  const undoEnv = { ...env, CHANGE: change };
  const broken = (e) => /FOREIGN KEY|UNIQUE|CHECK|constraint/i.test(String(e?.message || e));
  try {
    // All at once, in one transaction: the usual case.
    await write(undoEnv, trip.id, groups.flatMap((g) => g.stmts));
    undone = groups.length;
    putBack.push(...groups);
  } catch (e) {
    if (!broken(e)) throw e;
    // Something on the trip now depends on a row it would take away (an event on a place it
    // added), or a row it would bring back points at one gone since. Each row then on its own,
    // in the same order, under the same change; a row that still can't go back is left, saying
    // why, and the second pass catches one that waited on a later row.
    let waiting = groups;
    for (let pass = 0; pass < 2 && waiting.length; pass++) {
      const next = [];
      for (const g of waiting) {
        try {
          await write(undoEnv, trip.id, g.stmts);
          undone += 1;
          putBack.push(g);
        } catch (err) {
          if (!broken(err)) throw err;
          next.push({ ...g, why: String(err?.message || err) });
        }
      }
      waiting = next;
    }
    for (const g of waiting) {
      left.push({ table: g.table, key: g.key, label: g.label, why: /FOREIGN KEY/i.test(g.why)
        ? "something on the trip points at it now, or what it pointed at is gone (a place an event is on, say)"
        : `putting it back would break the trip (${g.why.replace(/^.*?:\s*/, "").slice(0, 120)})` });
    }
  }
  const put_back = putBack.map((g) => ({ table: g.table, key: g.key, label: g.label }));
  if (!undone) return { change: null, undone: 0, put_back, left };
  return { change: change.id, undone, put_back, left };
}

/**
 * Puts back what one tool call wrote before a later part of it was refused (src/mcp/tools.js:
 * a write is all or nothing). When everything went back, neither the call's change nor the undo
 * stays in the list, and the pictures the call stored are freed. When something couldn't (a
 * person wrote it in the moment between), both lines stay, so the list says what happened.
 * Answers { clean, left }.
 */
export async function rollBack(env, tripId, user, changeId) {
  const had = await env.DB.prepare("SELECT 1 AS y FROM trip_changes WHERE id = ?1 AND trip_id = ?2").bind(changeId, tripId).first();
  if (!had) return { clean: true, left: [] };
  const trip = await env.DB.prepare("SELECT * FROM trips WHERE id = ?1").bind(tripId).first();
  let done;
  try {
    done = await undoChange(env, trip, user, changeId, { source: "rollback" });
  } catch (e) {
    if (e instanceof UndoRefused) return { clean: false, left: [{ why: e.reason }] };
    throw e;
  }
  if (done.left.length) return { clean: false, left: done.left };
  const ids = JSON.stringify([changeId, done.change].filter(Boolean));
  const now = Math.floor(Date.now() / 1000);
  const mine = "SELECT r2_key FROM files_held WHERE change_id IN (SELECT value FROM json_each(?1)) AND r2_key NOT IN (SELECT r2_key FROM pictures)";
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO files_to_delete (bucket, r2_key, upload_id, queued_at) SELECT 'media', r2_key, NULL, ?2 FROM (${mine})`).bind(ids, now),
    env.DB.prepare(`DELETE FROM media_objects WHERE r2_key IN (${mine})`).bind(ids),
    env.DB.prepare("DELETE FROM files_held WHERE change_id IN (SELECT value FROM json_each(?1))").bind(ids),
    env.DB.prepare("DELETE FROM trip_change_rows WHERE change_id IN (SELECT value FROM json_each(?1))").bind(ids),
    env.DB.prepare("DELETE FROM trip_changes WHERE id IN (SELECT value FROM json_each(?1))").bind(ids),
  ]);
  return { clean: true, left: [] };
}

// ── clearing ─────────────────────────────────────────────────────────────────────────────────

/** The host clears the trip's list: every change goes, and what they held is freed. */
export function clearSteps(env, tripId, now) {
  return [
    env.DB.prepare(
      `INSERT OR IGNORE INTO files_to_delete (bucket, r2_key, upload_id, queued_at)
       SELECT 'media', h.r2_key, NULL, ?2 FROM files_held h WHERE h.trip_id = ?1 AND h.r2_key NOT IN (SELECT r2_key FROM pictures)`,
    ).bind(tripId, now),
    env.DB.prepare(
      `DELETE FROM media_objects WHERE r2_key IN (SELECT r2_key FROM files_held WHERE trip_id = ?1) AND r2_key NOT IN (SELECT r2_key FROM pictures)`,
    ).bind(tripId),
    env.DB.prepare("DELETE FROM files_held WHERE trip_id = ?1").bind(tripId),
    env.DB.prepare("DELETE FROM trip_change_rows WHERE change_id IN (SELECT id FROM trip_changes WHERE trip_id = ?1)").bind(tripId),
    env.DB.prepare("DELETE FROM trip_changes WHERE trip_id = ?1").bind(tripId),
  ];
}

/** The cron's part: changes past CHANGE_DAYS go, and the pictures only they held are freed. */
export async function expireChanges(env, now = Math.floor(Date.now() / 1000)) {
  const cut = now - CHANGE_DAYS * 86400;
  const old = "SELECT id FROM trip_changes WHERE created_at < ?1";
  const [freed, , , , gone] = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO files_to_delete (bucket, r2_key, upload_id, queued_at)
       SELECT 'media', h.r2_key, NULL, ?2 FROM files_held h WHERE h.change_id IN (${old}) AND h.r2_key NOT IN (SELECT r2_key FROM pictures)`,
    ).bind(cut, now),
    env.DB.prepare(
      `DELETE FROM media_objects WHERE r2_key IN (SELECT r2_key FROM files_held WHERE change_id IN (${old})) AND r2_key NOT IN (SELECT r2_key FROM pictures)`,
    ).bind(cut),
    env.DB.prepare(`DELETE FROM files_held WHERE change_id IN (${old})`).bind(cut),
    env.DB.prepare(`DELETE FROM trip_change_rows WHERE change_id IN (${old})`).bind(cut),
    env.DB.prepare("DELETE FROM trip_changes WHERE created_at < ?1").bind(cut),
  ]);
  return { changes: gone.meta.changes, freed: freed.meta.changes };
}

// ── routes ───────────────────────────────────────────────────────────────────────────────────

/** GET /api/trips/<trip>/changes[?before=<created_at>&limit=n]: the trip's list, as the caller may see it. */
export async function getChanges({ request, env, data }) {
  const q = new URL(request.url).searchParams;
  const before = q.has("before") && /^\d{1,12}$/.test(q.get("before")) ? Number(q.get("before")) : null;
  const limit = /^\d{1,3}$/.test(q.get("limit") ?? "") ? Number(q.get("limit")) : 50;
  return json({ changes: await listChanges(env, data.trip.id, data.user, { limit, before }), days: CHANGE_DAYS }, 200);
}

/**
 * POST /api/trips/<trip>/changes/<id>/undo: undo a change from the app, as the person pressing
 * it. The undo is a change of its own (from "app"), so it can be undone too.
 */
export async function postUndo({ env, data, params }) {
  let id;
  try { id = decodeURIComponent(String(params.id ?? "")); } catch { id = ""; }
  try {
    const done = await undoChange(env, data.trip, data.user, id, { source: "app" });
    return json(done, 200);
  } catch (e) {
    if (e instanceof UndoRefused) return json({ error: e.error, reason: e.reason }, e.status);
    throw e;
  }
}

/** DELETE /api/trips/<trip>/changes: the host clears the list; the pictures it held are freed. */
export async function deleteChanges({ env, data }) {
  if (!data.host) return json({ error: "forbidden", reason: "Only the trip's host clears its list of changes." }, 403);
  const [, , held, , gone] = await env.DB.batch(clearSteps(env, data.trip.id, Math.floor(Date.now() / 1000)));
  return json({ cleared: gone.meta.changes, freed_pictures: held.meta.changes }, 200);
}

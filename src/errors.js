// Error reports: what broke, kept in the site's own database and seen by its owner alone (src/admin/errors.js). The pages
// send theirs to POST /api/errors (public/js/error-report.js); the Worker counts its own: a request's uncaught exception
// (src/index.js, under its route's pattern) and a cron job that failed. Each is cleaned (public/js/shared/error-clean.js)
// and counted into a group of the same error (its fingerprint), with first and last seen, the count and the latest
// version. Nothing kept says who: no account, no IP, no trip's words, no page's real address.
//
// A page's report is cleaned again here, and if it comes from someone signed in, the names of their trips and of the people
// on them (their own included) are taken out wherever they stand in it, quoted or not.
//
// Bounded so a flood can't run up the database: a connection's tries (AUTH_LIMITER, "errors"), a report's size
// (ERROR_LIMITS.body), at most ERRORS.perMinute writes a minute per isolate (the rest are counted into the next write) and
// at most ERRORS.groupCap groups (past it, new kinds are counted in one overflow row). A group not seen for 30 days goes.

import { cleanMessage, cleanReport, cleanStack, coarseBrowser, ERROR_LIMITS, groupKey, withoutWords, workerOwn } from "../public/js/shared/error-clean.js";
import { limited, sha256Hex, tooMany } from "./accounts/util.js";
import { sessionOf } from "./accounts/sessions.js";
import { json } from "./api/json.js";
import { errorLine } from "./log.js";

export const ERRORS = Object.freeze({
  groupCap: 500,
  perMinute: 60,
  keepDays: 30, // after a group was last seen
});
const DAY = 86_400_000;

// This isolate's writes in the current minute, and the reports it turned away since its last write.
const isolate = { start: 0, writes: 0, held: 0 };

/**
 * Counts one error (or `count` of the same): its group's fingerprint once counted, false when it wasn't (held for the next
 * write, or dropped). Never throws: a report that can't be kept is dropped, and says so in the log.
 */
export async function recordError(env, record, now = Date.now(), count = 1) {
  try {
    if (now - isolate.start >= 60_000) { isolate.start = now; isolate.writes = 0; }
    if (isolate.writes >= ERRORS.perMinute) { isolate.held++; return false; }
    isolate.writes++;
    const counted = count + isolate.held;
    isolate.held = 0;
    const fingerprint = (await sha256Hex(groupKey(record))).slice(0, 16);
    const exists = "SELECT 1 FROM error_groups WHERE fingerprint = ?";
    await env.DB.batch([
      env.DB.prepare("UPDATE error_groups SET count = count + ?, last_seen = ?, stack = ?, version = ?, browser = ? WHERE fingerprint = ?")
        .bind(counted, now, record.stack, record.version, record.browser, fingerprint),
      env.DB.prepare(`INSERT INTO error_groups (fingerprint, source, kind, name, message, stack, place, version, browser, first_seen, last_seen, count)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (${exists}) AND (SELECT COUNT(*) FROM error_groups) < ?`)
        .bind(fingerprint, record.source, record.kind, record.name, record.message, record.stack, record.place, record.version, record.browser, now, now, counted, fingerprint, ERRORS.groupCap),
      // Past the cap, a new kind is counted in its source's overflow row instead (the INSERT above added nothing).
      env.DB.prepare(`INSERT INTO error_groups (fingerprint, source, kind, name, message, stack, place, version, browser, first_seen, last_seen, count)
         SELECT ?, ?, 'overflow', '', 'More kinds of error than are kept: these went uncounted by kind.', '', '', '', '', ?, ?, ?
         WHERE NOT EXISTS (${exists}) AND (SELECT COUNT(*) FROM error_groups) >= ?
         ON CONFLICT (fingerprint) DO UPDATE SET count = count + excluded.count, last_seen = excluded.last_seen`)
        .bind(`overflow:${record.source}`, record.source, now, now, counted, fingerprint, ERRORS.groupCap),
    ]);
    return fingerprint;
  } catch (error) {
    console.warn(JSON.stringify({ error_report_dropped: errorLine(error, env) }));
    return false;
  }
}

/** One of the Worker's own: `place` is a route's pattern ("GET /api/trips/:trip") or a cron job ("cron drain"). */
export function serverRecord(source, error, place) {
  const e = error instanceof Error ? error : null;
  return {
    source, kind: "exception",
    name: e && /^[A-Za-z][\w$]{0,39}$/.test(e.name) ? e.name : "Error",
    message: cleanMessage(e ? e.message : error),
    stack: cleanStack(e?.stack, workerOwn).join("\n"),
    place: /^[\w\-/:*. ]{1,100}$/.test(place) ? place : "?",
    version: "", browser: "",
  };
}

export const recordServerError = (env, source, error, place, now = Date.now()) => recordError(env, serverRecord(source, error, place), now);

/** The names a signed-in reporter's report must not carry: their trips', and those of everyone on them (their own too). */
async function namesOf(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT name FROM trips WHERE id IN (SELECT trip_id FROM trip_members WHERE user_id = ?1)
     UNION SELECT u.name FROM users u WHERE u.id = ?1 OR u.id IN (SELECT user_id FROM trip_members WHERE trip_id IN (SELECT trip_id FROM trip_members WHERE user_id = ?1))`,
  ).bind(userId).all();
  return (rows.results ?? []).map((r) => r.name);
}

/**
 * The shared board whose page sent the report, as its share id, or null: the board the report says it came from (the
 * page knows its own; js/error-report.js), else the page's address in its Referer, on this site (a referrer policy can
 * strip that, so it's only the second source). Read only to know which trip's words to take out; never kept.
 */
function boardOf(request, input) {
  if (typeof input?.board === "string" && /^[a-f0-9]{32}$/i.test(input.board)) return input.board.toLowerCase();
  try {
    const from = new URL(request.headers.get("Referer") ?? "");
    if (from.origin !== new URL(request.url).origin) return null;
    return /^\/s\/([a-f0-9]{32})(\/|$)/i.exec(from.pathname)?.[1]?.toLowerCase() ?? null;
  } catch { return null; }
}

/** The words a report from a shared board's page must not carry: the board's title, its trip's name, the people on it. */
async function namesOfBoard(env, shareId) {
  const rows = await env.DB.prepare(
    `SELECT title AS name FROM collage_shares WHERE id = ?1
     UNION SELECT name FROM trips WHERE id = (SELECT trip_id FROM collage_shares WHERE id = ?1)
     UNION SELECT u.name FROM users u WHERE u.id IN (SELECT user_id FROM trip_members WHERE trip_id = (SELECT trip_id FROM collage_shares WHERE id = ?1))`,
  ).bind(shareId).all();
  return (rows.results ?? []).map((r) => r.name);
}

/**
 * POST /api/errors: a page's report, signed in or not. 200 { group } with the fingerprint of the kind it was counted in
 * (the page keeps the last few, js/error-report.js, and a bug report sends them along: shared/bug-rules.js), or 204 when it
 * wasn't counted (not worth keeping, or held for the next write). A page that ignores the answer, as one from before it
 * did, is answered the same way: neither changes what's kept.
 */
export async function postError({ request, env }) {
  if (await limited(env.AUTH_LIMITER, "errors", request)) return tooMany();
  const text = await readText(request, ERROR_LIMITS.body);
  if (text === null) return json({ error: "too big", reason: `A report is at most ${ERROR_LIMITS.body / 1024} KB.` }, 413);
  let input;
  try { input = JSON.parse(text); } catch { return json({ error: "bad report", reason: "A report is JSON." }, 400); }
  const report = cleanReport(input);
  if (!report) return new Response(null, { status: 204 });
  let found = null;
  try { found = await sessionOf(request, env); } catch { /* a report never fails for want of a session */ }
  // The words to take out: a signed-in reporter's trips and people; a shared board's page, that board's trip and people.
  const words = [];
  if (found?.user?.id) words.push(...(await namesOf(env, found.user.id)));
  const board = boardOf(request, input);
  if (board) words.push(...(await namesOfBoard(env, board)));
  if (words.length) report.message = withoutWords(report.message, words);
  const group = await recordError(env, { source: "client", ...report, browser: coarseBrowser(request.headers.get("User-Agent") ?? "") });
  // Only a group that is a kind of its own: the overflow row past the cap is no one's to name.
  return group && !(await isOverflow(env, group)) ? json({ group }) : new Response(null, { status: 204 });
}

async function isOverflow(env, fingerprint) {
  const row = await env.DB.prepare("SELECT kind FROM error_groups WHERE fingerprint = ?").bind(fingerprint).first();
  return !row || row.kind === "overflow";
}

async function readText(request, max) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return null; }
    parts.push(value);
  }
  return new TextDecoder().decode(parts.length === 1 ? parts[0] : Uint8Array.from(parts.flatMap((p) => [...p])));
}

/** The cron's sweep: groups not seen for ERRORS.keepDays days. */
export async function sweepErrors(env, now = Date.now()) {
  return (await env.DB.prepare("DELETE FROM error_groups WHERE last_seen < ?").bind(now - ERRORS.keepDays * DAY).run()).meta.changes ?? 0;
}

/** The groups, most counted first. */
export async function errorGroups(env, limit = 200) {
  return (await env.DB.prepare("SELECT * FROM error_groups ORDER BY count DESC, last_seen DESC LIMIT ?").bind(limit).all()).results ?? [];
}

/** Removes groups by fingerprint (the owner's "fixed"). */
export async function clearErrors(env, fingerprints) {
  const list = (fingerprints ?? []).filter((f) => typeof f === "string" && /^[\w:]{1,40}$/.test(f)).slice(0, 100);
  if (!list.length) return 0;
  return (await env.DB.prepare(`DELETE FROM error_groups WHERE fingerprint IN (${list.map(() => "?").join(", ")})`).bind(...list).run()).meta.changes ?? 0;
}

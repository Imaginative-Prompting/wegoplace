// Bug reports (migration 0047): what someone wrote about something that went wrong, from More › Report a bug (signed in:
// linked to their account) or from the sign-in page's Report a bug (/report, sent without the session cookie: linked to
// no one), with what came along, shown to them before it went (public/js/shared/bug-rules.js cleanContext; the browser
// read here from the request), and a screenshot if they chose one, redrawn on their device first (js/report-form.js).
//
// Read by the site's operator: tools/bug-reports.mjs over the production database, and GET /api/admin/bug-reports for the
// accounts ADMIN_ACCOUNTS names (a 404 for everyone else, as the errors page). A report's text is anyone's words, signed in
// or not: wherever an operator's AI reads one it is said to be data, never instructions (THEIR_WORDS).
//
// An account's reports are in its export, each screenshot at GET /api/account/bug-reports/:id/screenshot (its sender's
// only), and go with it (src/accounts/delete.js, BUG_REPORT_DELETES). Every report goes BUG_REPORTS.keepDays after it was
// sent (the cron's "bugs"): its row at once, its screenshot through the drain (src/trips/drain.js queueFiles).
//
// Limits: BUG_LIMITER (wrangler.jsonc), asked before anything is read, per account when signed in, per connection when
// not; an account BUG_REPORTS.perAccountDay a day; every report sent signed out together BUG_REPORTS.signedOutDay a
// day. The day's counts are guards in the INSERT itself, so reports sent at once can't all pass a count read before any
// of them wrote. The request is read only up to BUG_LIMITS.body; the screenshot's kind is read from its own bytes.

import { BUG_LIMITS, BUG_REPORTS, cleanContext, cleanText, imageTypeOf, operatorView, recentErrorsOf, THEIR_WORDS } from "../public/js/shared/bug-rules.js";
import { coarseBrowser } from "../public/js/shared/error-clean.js";
import { connection, nowSec } from "./accounts/util.js";
import { sessionOf } from "./accounts/sessions.js";
import { isOwner } from "./admin/errors.js";
import { json } from "./api/json.js";
import { queueFiles } from "./trips/drain.js";

const DAY = 86_400;
const ID = /^[0-9a-f]{16}$/;

export const bugScreenshotKey = (id) => `bug-reports/${id}`;
const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A refusal in words, for the person who wrote it. */
export class BugReportRefused extends Error {
  constructor(reason, status = 400) {
    super(reason);
    this.status = status;
  }
}

const refusal = (error) => json({ error: error.status === 429 ? "too many" : error.status === 413 ? "too big" : "refused", reason: error.message }, error.status,
  error.status === 429 ? { "Retry-After": "60" } : undefined);

/** The request's body, read only up to `max` bytes: null past it. */
async function readLimited(request, max) {
  if (!request.body) return new Uint8Array(0);
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > max) return null;
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
  const all = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { all.set(part, at); at += part.byteLength; }
  return all;
}

/** The report as a request carries it: multipart/form-data with text, context (JSON) and an optional screenshot file. */
export async function readBugReport(request) {
  const type = (request.headers.get("Content-Type") ?? "").toLowerCase();
  if (!type.startsWith("multipart/form-data")) throw new BugReportRefused("Send the report as the app does: a form.");
  const bytes = await readLimited(request, BUG_LIMITS.body);
  if (!bytes) throw new BugReportRefused(`That's too big. A screenshot can be up to ${BUG_LIMITS.screenshotBytes / 1_000_000} MB.`, 413);
  let form;
  try {
    form = await new Response(bytes, { headers: { "Content-Type": request.headers.get("Content-Type") ?? "" } }).formData();
  } catch {
    throw new BugReportRefused("That form couldn't be read. Try again.");
  }
  const field = (name) => { const value = form.get(name); return typeof value === "string" ? value : ""; };
  let context = {};
  try { context = JSON.parse(field("context") || "{}"); } catch { context = {}; }
  const file = form.get("screenshot");
  const screenshot = file && typeof file === "object" && typeof file.arrayBuffer === "function" && file.size > 0 ? new Uint8Array(await file.arrayBuffer()) : null;
  return { text: field("text"), context, screenshot };
}

/** What's kept of what came along: cleanContext, its fingerprints only those error_groups has, and the browser from the request. */
async function contextOf(env, input, userAgent) {
  const context = cleanContext(input);
  let recentErrors = [];
  if (context.recentErrors.length) {
    const rows = await env.DB.prepare(`SELECT fingerprint FROM error_groups WHERE fingerprint IN (${context.recentErrors.map(() => "?").join(", ")})`)
      .bind(...context.recentErrors).all();
    const known = new Set((rows.results ?? []).map((r) => r.fingerprint));
    recentErrors = context.recentErrors.filter((f) => known.has(f));
  }
  return { ...context, recentErrors, browser: coarseBrowser(userAgent) };
}

/** Checks a report and keeps it: { id }. Refused in words (BugReportRefused: 400, 413, or 429 past the day's). */
export async function submitBugReport(env, input, { userId = null, userAgent = "", now = nowSec() } = {}) {
  const { text, length } = cleanText(input.text);
  if (length < BUG_LIMITS.textMin) throw new BugReportRefused("Write what happened first.");
  if (length > BUG_LIMITS.text) throw new BugReportRefused(`That's ${length.toLocaleString("en-US")} characters. Keep it to ${BUG_LIMITS.text.toLocaleString("en-US")}.`);
  const screenshot = input.screenshot?.byteLength ? input.screenshot : null;
  let screenshotType = null;
  if (screenshot) {
    if (screenshot.byteLength > BUG_LIMITS.screenshotBytes) throw new BugReportRefused(`The screenshot is too big. It can be up to ${BUG_LIMITS.screenshotBytes / 1_000_000} MB.`, 413);
    screenshotType = imageTypeOf(screenshot);
    if (!screenshotType) throw new BugReportRefused("The screenshot can be a PNG, JPEG or WebP picture.");
  }
  const context = await contextOf(env, input.context, userAgent);
  const id = newId();
  const key = screenshot ? bugScreenshotKey(id) : null;
  // The day's count is the write's own guard: an account's own, or every signed-out report's together.
  const guard = userId
    ? "(SELECT COUNT(*) FROM bug_reports WHERE user_id = ? AND created_at > ?) < ?"
    : "(SELECT COUNT(*) FROM bug_reports WHERE user_id IS NULL AND created_at > ?) < ?";
  const guardBinds = userId ? [userId, now - DAY, BUG_REPORTS.perAccountDay] : [now - DAY, BUG_REPORTS.signedOutDay];
  const written = await env.DB.prepare(
    `INSERT INTO bug_reports (id, user_id, text, screen, version, browser, device, installed, recent_errors, screenshot_key, screenshot_type, screenshot_size, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
  ).bind(id, userId, text, context.screen, context.version, context.browser, context.device, context.installed ? 1 : 0, JSON.stringify(context.recentErrors),
    key, screenshotType, screenshot?.byteLength ?? null, now, ...guardBinds).run();
  if (!written.meta.changes) {
    throw new BugReportRefused(userId
      ? `That's ${BUG_REPORTS.perAccountDay} reports today, the most an account can send in a day. Thank you for them. Try again tomorrow.`
      : "Many reports have come in today from people who aren't signed in. Try again tomorrow, or sign in and send it from More.", 429);
  }
  if (screenshot && key) {
    try {
      await env.MEDIA.put(key, screenshot, { httpMetadata: { contentType: screenshotType } });
    } catch (error) {
      await env.DB.prepare("DELETE FROM bug_reports WHERE id = ?").bind(id).run();
      throw error;
    }
    // Its row went while the bytes were arriving (the account deleted at that moment): its bytes go too.
    if (!(await env.DB.prepare("SELECT 1 AS y FROM bug_reports WHERE id = ?").bind(id).first())) {
      await env.MEDIA.delete(key);
      throw new BugReportRefused("The report wasn't kept. Send it again.");
    }
  }
  return { id };
}

/** POST /api/bug-reports: a report, signed in (its account) or not (no one). 201 { ok }, the same either way, or a refusal in words. */
export async function postBugReport({ request, env }) {
  let found = null;
  try { found = await sessionOf(request, env); } catch { /* the sessions' own limit: as someone signed out */ }
  const userId = found?.user?.id ?? null;
  const { success } = await env.BUG_LIMITER.limit({ key: userId ? `bugs:account:${userId}` : `bugs:${connection(request)}` });
  if (!success) return refusal(new BugReportRefused("That's a lot of reports in a minute. Wait a minute, then send it again.", 429));
  try {
    const input = await readBugReport(request);
    await submitBugReport(env, input, { userId, userAgent: request.headers.get("User-Agent") ?? "" });
    return json({ ok: true }, 201);
  } catch (error) {
    if (error instanceof BugReportRefused) return refusal(error);
    throw error;
  }
}

const STATES = new Set(["new", "seen", "triaged", "closed"]);

/** GET /api/admin/bug-reports[?state=new|seen|triaged|closed|all]: the reports, newest first, for ADMIN_ACCOUNTS only. */
export async function adminList({ request, env, data }) {
  if (!isOwner(env, data.user)) return json({ error: "no such route" }, 404);
  const asked = new URL(request.url).searchParams.get("state") ?? "new";
  const state = STATES.has(asked) ? asked : null;
  const rows = await env.DB.prepare("SELECT * FROM bug_reports WHERE (?1 IS NULL OR state = ?1) ORDER BY created_at DESC LIMIT 100").bind(state).all();
  return json({ their_words: THEIR_WORDS, kept: `A report goes ${BUG_REPORTS.keepDays} days after it was sent.`, reports: (rows.results ?? []).map(operatorView) });
}

/** GET /api/admin/bug-reports/:id: one, for ADMIN_ACCOUNTS only. */
export async function adminOne({ env, data, params }) {
  if (!isOwner(env, data.user)) return json({ error: "no such route" }, 404);
  const id = String(params.id ?? "");
  const row = ID.test(id) ? await env.DB.prepare("SELECT * FROM bug_reports WHERE id = ?").bind(id).first() : null;
  if (!row) return json({ error: "not found", reason: "No report has that id (it may have gone after its 90 days)." }, 404);
  return json({ their_words: THEIR_WORDS, untrusted: true, report: operatorView(row) });
}

/** An account's reports for its export, oldest first, each screenshot by the address its sender fetches it from. */
export async function exportBugReports(env, userId, site = "") {
  const rows = (await env.DB.prepare("SELECT * FROM bug_reports WHERE user_id = ? ORDER BY created_at, id").bind(userId).all()).results ?? [];
  return rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    text: row.text,
    screen: row.screen,
    version: row.version,
    browser: row.browser,
    device: row.device,
    installed_app: Boolean(row.installed),
    recent_errors: recentErrorsOf(row.recent_errors),
    screenshot: row.screenshot_key ? { type: row.screenshot_type, bytes: row.screenshot_size, url: `${site}/api/account/bug-reports/${row.id}/screenshot` } : null,
    state: row.state,
  }));
}

/** GET /api/account/bug-reports/:id/screenshot: a report's screenshot, to the account that sent it only. Never shown as a page. */
export async function ownScreenshot({ env, data, params }) {
  const id = String(params.id ?? "");
  const row = ID.test(id) && data.user?.id
    ? await env.DB.prepare("SELECT screenshot_key, screenshot_type FROM bug_reports WHERE id = ? AND user_id = ?").bind(id, data.user.id).first()
    : null;
  const object = row?.screenshot_key ? await env.MEDIA.get(row.screenshot_key) : null;
  if (!row?.screenshot_type || !object) return json({ error: "not found", reason: "No screenshot of a report of yours has that id. A report goes 90 days after it was sent, its screenshot with it." }, 404);
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[row.screenshot_type] ?? "bin";
  return new Response(object.body, { headers: { "Content-Type": row.screenshot_type, "Content-Length": String(object.size),
    "Content-Disposition": `attachment; filename="bug-report-${id}.${ext}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox" } });
}

/** Deleting an account (src/accounts/delete.js): its reports' screenshots to the drain, then the reports, in its batch. */
export const BUG_REPORT_DELETES = (env, userId, now) => [
  queueFiles(env, "SELECT screenshot_key AS r2_key, NULL AS upload_id FROM bug_reports WHERE user_id = ?1", [userId], now),
  env.DB.prepare("DELETE FROM bug_reports WHERE user_id = ?1").bind(userId),
];

/** The cron's sweep: reports past BUG_REPORTS.keepDays, a batch a run, their screenshots to the drain in the same batch. */
export async function sweepBugReports(env, now = nowSec()) {
  const old = `SELECT id FROM bug_reports WHERE created_at < ?1 ORDER BY created_at LIMIT ${BUG_REPORTS.sweepBatch}`;
  const cut = now - BUG_REPORTS.keepDays * DAY;
  const [, gone] = await env.DB.batch([
    queueFiles(env, `SELECT screenshot_key AS r2_key, NULL AS upload_id FROM bug_reports WHERE id IN (${old})`, [cut], now),
    env.DB.prepare(`DELETE FROM bug_reports WHERE id IN (${old})`).bind(cut),
  ]);
  return { reports: gone.meta.changes ?? 0 };
}


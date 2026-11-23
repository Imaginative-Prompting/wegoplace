// An email on the account, for one thing: getting back in when every passkey is lost. It is
// never a way to sign in by itself, never joins one account to another, and is never shown to
// anyone else.
//
// - Adding one: a 6-digit code goes to the address, and the address is kept only once that code
//   comes back. One address per account, and an address on one account only.
// - Getting back in: on the sign-in page, the address, then the code sent to it; the code opens
//   a session, and the page offers a passkey for this device at once. Asking answers the same
//   whether or not the address is known, a code is sent only where it is, and the sending
//   happens after the answer, so neither the words nor the time give an address away.
// - A code: 6 digits, only its hash kept, 15 minutes, 5 tries, used once (checked and taken in
//   one statement), and at most 5 asked for an hour per account or address.
// - No email carries a link: a code is typed into the app that asked for it.
// - What sends it: Cloudflare's Email Sending (the EMAIL binding, from EMAIL_FROM). A site
//   without both has none of this: the routes answer 404 and the pages don't offer it.
//
//   GET    /api/account/email            { offered, email, verifiedAt }
//   POST   /api/account/email            { email } -> { id, sentTo }: a code is on its way
//   POST   /api/account/email/confirm    { id, code } -> { email, verifiedAt }
//   DELETE /api/account/email            -> { email: null }
//   POST   /api/auth/recover             { email } -> { id }           (anyone, from this site)
//   POST   /api/auth/recover/confirm     { id, code } -> { ok, user }, signed in

import { startSession } from "./sessions.js";
import { guestRefused, isGuest, waysIn } from "./guests.js";
import { answer, limited, nowSec, randomId, readObject, sameOrigin, sha256Hex, tooMany } from "./util.js";
import { errorLine } from "../log.js";

export const CODE_MINUTES = 15;
export const CODE_TRIES = 5;
export const CODES_AN_HOUR = 5;
const HOUR = 3600;

class EmailError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.status = status;
    this.extra = extra;
  }
}
const refused = (error) => {
  // Too many: the reason says when in words, Retry-After in seconds.
  if (error instanceof EmailError) return answer({ error: error.message, ...error.extra }, error.status, [], error.status === 429 ? { "Retry-After": String(HOUR) } : undefined);
  throw error;
};

/** Whether this site sends account email: Cloudflare's Email Sending bound as EMAIL, and an address to send from. */
export const emailOffered = (env) => Boolean(env.EMAIL && env.EMAIL_FROM);
const mustOffer = (env) => { if (!emailOffered(env)) throw new EmailError("no email", 404); };

/** An address as kept: trimmed, in small letters; null when it isn't one (one @, a dot in its domain, no spaces, at most 254 characters). */
export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return null;
  const at = email.lastIndexOf("@");
  if (at < 1 || at !== email.indexOf("@")) return null;
  const [local, domain] = [email.slice(0, at), email.slice(at + 1)];
  if (local.length > 64 || !/^[^\s@<>()[\]\\,;:"]+$/.test(local)) return null;
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return null;
  return email;
}

/** An address as it may be named back to its own account: the first letter and the domain (j…@example.com). */
const masked = (email) => `${email[0]}…${email.slice(email.indexOf("@"))}`;

/** Six digits, every one as likely. */
function newCode() {
  const box = new Uint32Array(1);
  // 4,294,000,000 is the largest multiple of a million under 2^32: anything above would make the low codes likelier.
  let n = 4_294_000_000;
  while (n >= 4_294_000_000) n = crypto.getRandomValues(box)[0];
  return String(n % 1_000_000).padStart(6, "0");
}
const codeHash = (id, code) => sha256Hex(`${id}.${code}`);

async function accountEmail(env, userId) {
  const row = await env.DB.prepare("SELECT email, verified_at FROM account_emails WHERE user_id = ?1").bind(userId).first();
  return row ? { email: row.email, verifiedAt: row.verified_at } : null;
}

// ── the emails ─────────────────────────────────────────────────────────────────────────────
// Plain text, with the same words as simple HTML. No links: a code is typed in the app.

async function send(env, { to, subject, text }) {
  const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#1d1d1f">${text
    .split("\n\n")
    .map((part) => `<p>${part.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`)
    .join("")}</div>`;
  await env.EMAIL.send({ to, from: { email: env.EMAIL_FROM, name: env.RP_NAME }, subject, text, html });
}

const sendLater = (env, waitUntil, mail) => {
  if (mail) waitUntil(send(env, mail).catch((error) => console.error(JSON.stringify({ email_error: errorLine(error, env) }))));
};

function mails(env) {
  const site = env.RP_NAME;
  const foot = `${site} uses this address only to help you get back into your account. It never sends a link to sign in.`;
  return {
    confirm: (code) => ({
      subject: `Your ${site} code: ${code}`,
      text: `Your code to add this email to your ${site} account is ${code}. It works for ${CODE_MINUTES} minutes.\n\nIf you didn't ask for it, you can ignore this email: nothing changes without the code.\n\n${foot}`,
    }),
    recover: (code) => ({
      subject: `Your code to get back into ${site}: ${code}`,
      text: `Someone asked to get back into the ${site} account that has this email. If it was you, type ${code} in the app. It works for ${CODE_MINUTES} minutes.\n\nIf it wasn't you, ignore this: nobody gets in without the code. Never type it anywhere but ${site}.\n\n${foot}`,
    }),
    recovered: (when) => ({
      subject: `You got back into ${site} with your email`,
      text: `Your ${site} account was opened with a code sent to this address, on ${new Date(when * 1000).toUTCString()}.\n\nIf that wasn't you, sign in, open your account page, choose "Sign out everywhere" and remove this email there.\n\n${foot}`,
    }),
    replaced: (now) => ({
      subject: `Your ${site} email was changed`,
      text: `Your ${site} account no longer uses this address. Its email is now ${now}.\n\nIf you didn't change it, sign in and look at your account page.\n\n${foot}`,
    }),
  };
}

// ── codes ──────────────────────────────────────────────────────────────────────────────────

/**
 * Adds a code, unless the address has had CODES_AN_HOUR sent to it in the last hour (for any
 * account, to add it or to get back in), or the account adding it has asked for that many.
 * Counted in the same statement that writes the send, so requests sent at once can't all pass.
 * Returns { id, code }, or null when over the limit.
 */
async function addCode(env, { userId, email, purpose }) {
  const id = randomId(16);
  const code = newCode();
  const now = nowSec();
  const adder = purpose === "confirm" ? userId : null;
  const sent = await env.DB.prepare(
    `INSERT INTO email_sends (address_hash, user_id, sent_at)
     SELECT ?1, ?2, ?3
     WHERE (SELECT COUNT(*) FROM email_sends WHERE address_hash = ?1 AND sent_at > ?4) < ?5
       AND (?2 IS NULL OR (SELECT COUNT(*) FROM email_sends WHERE user_id = ?2 AND sent_at > ?4) < ?5)`,
  ).bind(await sha256Hex(`email-send:${email}`), adder, now, now - HOUR, CODES_AN_HOUR).run();
  if (!sent.meta.changes) return null;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO email_codes (id, user_id, email, purpose, code_hash, attempts, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)",
    ).bind(id, userId, email, purpose, await codeHash(id, code), now + CODE_MINUTES * 60, now),
    // Codes long past their time, and sends past their hour, go as new ones arrive.
    env.DB.prepare("DELETE FROM email_codes WHERE expires_at < ?1").bind(now - HOUR),
    env.DB.prepare("DELETE FROM email_sends WHERE sent_at < ?1").bind(now - HOUR),
  ]);
  return { id, code };
}

/**
 * Takes a code if it's right, unexpired and has tries left. Every answer takes a try first, in
 * one statement that refuses a sixth, and only then is the code compared: answers sent all at
 * once can't all be compared. The right one is then taken in one statement, so it works once.
 */
async function takeCode(env, id, code, purpose) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(id) || typeof code !== "string") return { row: null, left: 0 };
  const tried = await env.DB.prepare(
    "UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?1 AND purpose = ?2 AND expires_at > ?3 AND attempts < ?4 RETURNING attempts",
  ).bind(id, purpose, nowSec(), CODE_TRIES).first();
  if (!tried) return { row: null, left: 0 };
  const digits = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(digits)) {
    const row = await env.DB.prepare("DELETE FROM email_codes WHERE id = ?1 AND purpose = ?2 AND code_hash = ?3 RETURNING user_id, email")
      .bind(id, purpose, await codeHash(id, digits)).first();
    if (row) return { row, left: CODE_TRIES };
  }
  return { row: null, left: Math.max(0, CODE_TRIES - tried.attempts) };
}
const wrong = (left) => (left > 0 ? new EmailError("wrong code", 400, { left }) : new EmailError("code used up", 400));

// ── an address on the account that is signed in ────────────────────────────────────────────

export async function emailGet({ env, data }) {
  return answer({ offered: emailOffered(env), ...((await accountEmail(env, data.user.id)) ?? { email: null, verifiedAt: null }) });
}

/** A code goes to the address. Sent here and now, so a failure says so. */
export async function emailAdd({ request, env, data }) {
  if (isGuest(data.user)) return guestRefused(env, `An email on the account is for getting back in when a passkey is lost. Add ${waysIn(env)} first.`);
  try {
    mustOffer(env);
    const email = normalizeEmail((await readObject(request))?.email);
    if (!email) throw new EmailError("bad email");
    const added = await addCode(env, { userId: data.user.id, email, purpose: "confirm" });
    if (!added) throw new EmailError("too many codes", 429, { reason: `That's ${CODES_AN_HOUR} codes for this address in an hour. Wait an hour, then ask again.` });
    try {
      await send(env, { to: email, ...mails(env).confirm(added.code) });
    } catch (error) {
      console.error(JSON.stringify({ email_error: errorLine(error, env) }));
      throw new EmailError("send failed", 502);
    }
    return answer({ id: added.id, sentTo: email });
  } catch (error) {
    return refused(error);
  }
}

/** The code back: the address is the account's now. Its old address, if it had another, is told. */
export async function emailConfirm({ request, env, data, waitUntil }) {
  if (isGuest(data.user)) return guestRefused(env, `An email on the account is for getting back in when a passkey is lost. Add ${waysIn(env)} first.`);
  try {
    mustOffer(env);
    const body = await readObject(request);
    const userId = data.user.id;
    const { row, left } = await takeCode(env, body?.id, body?.code, "confirm");
    if (!row || row.user_id !== userId) throw wrong(left);
    const before = await accountEmail(env, userId);
    const now = nowSec();
    // Only the address's owner gets here (they have its code), so saying it's on another
    // account tells them nothing they couldn't find out.
    try {
      await env.DB.prepare(
        `INSERT INTO account_emails (user_id, email, verified_at, created_at) VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, verified_at = excluded.verified_at`,
      ).bind(userId, row.email, now).run();
    } catch {
      throw new EmailError("email taken", 409);
    }
    await env.DB.prepare("DELETE FROM email_codes WHERE user_id = ?1 AND purpose = 'confirm'").bind(userId).run();
    if (before && before.email !== row.email) sendLater(env, waitUntil, { to: before.email, ...mails(env).replaced(masked(row.email)) });
    return answer({ email: row.email, verifiedAt: now });
  } catch (error) {
    return refused(error);
  }
}

export async function emailRemove({ env, data }) {
  if (isGuest(data.user)) return guestRefused(env, `An email on the account is for getting back in when a passkey is lost. Add ${waysIn(env)} first.`);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM account_emails WHERE user_id = ?1").bind(data.user.id),
    env.DB.prepare("DELETE FROM email_codes WHERE user_id = ?1").bind(data.user.id),
  ]);
  return answer({ email: null });
}

// ── getting back in ────────────────────────────────────────────────────────────────────────
// From this site's own pages only. These need no session and the second hands one out, so
// another site's form could otherwise sign a visitor in to an account whose code that site holds.

/**
 * Asked to get back in by an address: { id } either way, and an email only when the address is
 * on an account. An address on none keeps a row too (its code is one nobody has), so the next
 * step answers the same.
 */
export async function recoverStart({ request, env, waitUntil }) {
  if (!sameOrigin(request, env)) return answer({ error: "cross site" }, 403);
  if (await limited(env.AUTH_LIMITER, "auth", request)) return tooMany();
  try {
    mustOffer(env);
    const email = normalizeEmail((await readObject(request))?.email);
    if (!email) throw new EmailError("bad email");
    const owner = await env.DB.prepare(
      "SELECT e.user_id FROM account_emails e JOIN users u ON u.id = e.user_id WHERE e.email = ?1 AND u.deleted_at IS NULL",
    ).bind(email).first();
    const added = await addCode(env, { userId: owner?.user_id ?? null, email, purpose: "recover" });
    if (!added) throw new EmailError("too many codes", 429, { reason: `That's ${CODES_AN_HOUR} codes for this address in an hour. Wait an hour, then ask again.` });
    if (owner) sendLater(env, waitUntil, { to: email, ...mails(env).recover(added.code) });
    return answer({ id: added.id });
  } catch (error) {
    return refused(error);
  }
}

/** The code back: a session for the account the address is on, and an email telling the address it was used. */
export async function recoverConfirm({ request, env, waitUntil }) {
  if (!sameOrigin(request, env)) return answer({ error: "cross site" }, 403);
  if (await limited(env.AUTH_LIMITER, "verify", request)) return tooMany();
  try {
    mustOffer(env);
    const body = await readObject(request);
    const { row, left } = await takeCode(env, body?.id, body?.code, "recover");
    if (!row?.user_id) throw wrong(row ? 0 : left);
    // Still that account's address (it may have been removed since the code went).
    const user = await env.DB.prepare(
      `SELECT u.id, u.name FROM account_emails e JOIN users u ON u.id = e.user_id
       WHERE e.user_id = ?1 AND e.email = ?2 AND u.deleted_at IS NULL`,
    ).bind(row.user_id, row.email).first();
    if (!user) throw wrong(0);
    const now = nowSec();
    const cookies = await startSession(env, user.id, request, now);
    sendLater(env, waitUntil, { to: row.email, ...mails(env).recovered(now) });
    return answer({ ok: true, user: { id: user.id, name: user.name } }, 200, cookies);
  } catch (error) {
    return refused(error);
  }
}

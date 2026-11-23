// A person's drawn picture (migration 0043; the format is public/js/shared/avatar.js).
//
//   PUT    /api/me/avatar { drawing: <base64url bytes> } -> { me }   the picture, in place of the initials
//   DELETE /api/me/avatar                                  -> { me }   back to the initials
//   GET    /api/avatars/<hash>                             -> the bytes (application/octet-stream)
//
// Like PATCH /api/me, the two writes name no account: the session's is the only one they can change. The bytes are
// checked by the same walk the app's pad uses, and the server names them itself (the hash of what it stores), so no
// one can give their picture another's name. Sending the picture already held writes nothing, so a write sent again
// after its answer was lost answers as the first did.
//
// A picture shows on every trip roster its person is on (src/api/trip.js listMembers carries the hash), so changing
// it is a write to each of those trips, as a new name is: each trip's rev goes up, the person's member row takes it,
// and each trip's room hears it, so the others see it within seconds.
//
// WHO MAY READ ONE: someone signed in who is on a trip now (not left) with a person whose picture it is (that person
// may have left it: they are still on its roster), or its own person. Anyone else gets the same 404 as for a hash
// nobody holds, so a stranger can't learn whether a picture exists.
//
// A drawing no account points at is removed by the write that let it go: here, and when an account is deleted
// (src/accounts/delete.js). Two people who send the same bytes share one row, and it stays while either holds it.

import { json, readJson } from "../api/json.js";
import { moved } from "../trips/rev.js";
import { readMe } from "../api/me.js";
import { DRAWING_B64_MAX, fromB64url, hashOf, isDrawingHash, validate } from "../../public/js/shared/avatar.js";
import { AVATAR_WRITES_PER_HOUR } from "../../public/js/shared/limits.js";

const HOUR = 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

/** The statement that removes every drawing no account points at (run in the batch of the write that let one go). */
export const sweepDrawings = (db) =>
  db.prepare("DELETE FROM drawings WHERE hash NOT IN (SELECT avatar FROM users WHERE avatar IS NOT NULL)");

/** The two statements that move the rev of every trip the person is on, and their row on each (as PATCH /api/me does). */
const tripRevs = (db, userId) => [
  db.prepare(
    "UPDATE trips SET rev = rev + 1, data_rev = rev + 1 WHERE id IN " +
    "(SELECT trip_id FROM trip_members WHERE user_id = ?1 AND left_at IS NULL) RETURNING id, rev").bind(userId),
  db.prepare(
    "UPDATE trip_members SET rev = (SELECT rev FROM trips WHERE id = trip_members.trip_id) " +
    "WHERE user_id = ?1 AND left_at IS NULL").bind(userId),
];

/** The person as GET /api/me answers, read afresh (src/api/me.js). */
const me = (ctx) => readMe(ctx.env, ctx.data.user);

/** null when one more picture write fits in the hour, else the 429 to answer (in words, with when to try again). */
async function overHour(db, userId, now) {
  const row = await db.prepare("SELECT COUNT(*) AS n, MIN(at) AS first FROM hour_counts WHERE kind = 'avatar' AND key = ?1 AND at > ?2")
    .bind(userId, now - HOUR).first();
  if ((row?.n ?? 0) < AVATAR_WRITES_PER_HOUR) return null;
  const wait = Math.max(60, (row.first ?? now) + HOUR - now);
  return json({ error: "too many", max: AVATAR_WRITES_PER_HOUR,
    reason: `That's ${AVATAR_WRITES_PER_HOUR} changes to your picture in an hour. Try again in ${Math.ceil(wait / 60)} minutes.` },
  429, { "Retry-After": String(wait) });
}

/** Writes the batch (the change, the sweep, the count, the trips' revs) and tells each trip's room. */
async function write(ctx, change, now) {
  const db = ctx.env.DB, userId = ctx.data.user.id;
  const stmts = [
    ...change,
    sweepDrawings(db),
    db.prepare("INSERT INTO hour_counts (kind, key, at) VALUES ('avatar', ?1, ?2)").bind(userId, now),
    ...tripRevs(db, userId),
  ];
  const done = await db.batch(stmts);
  const moves = done[done.length - 2].results ?? [];
  await Promise.all(moves.map((t) => moved(ctx.env, t.id, t.rev)));
}

export async function putAvatar(ctx) {
  const u = ctx.data.user;
  if (!u) return json({ error: "unauthorized" }, 401);
  const body = await readJson(ctx.request);
  const sent = body && typeof body.drawing === "string" ? body.drawing : null;
  if (sent === null) return json({ error: "no drawing", reason: "Nothing was sent to draw: the picture goes in `drawing`, as base64url." }, 400);
  if (sent.length > DRAWING_B64_MAX) return json({ error: "too large", reason: "That picture is bigger than a picture can be. Draw it again with fewer strokes." }, 413);
  const bytes = fromB64url(sent);
  if (!bytes || !validate(bytes)) return json({ error: "not a drawing", reason: "That isn't a picture this app can show." }, 400);
  const hash = await hashOf(bytes);
  const db = ctx.env.DB, now = nowSec();
  const row = await db.prepare("SELECT avatar FROM users WHERE id = ?1").bind(u.id).first();
  // The picture already held: nothing to write, and the answer the first write gave.
  if (row?.avatar === hash) return json({ me: await me(ctx) });
  const refused = await overHour(db, u.id, now);
  if (refused) return refused;
  await write(ctx, [
    db.prepare("INSERT OR IGNORE INTO drawings (hash, bytes, created_at) VALUES (?1, ?2, ?3)").bind(hash, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), now),
    db.prepare("UPDATE users SET avatar = ?1 WHERE id = ?2").bind(hash, u.id),
  ], now);
  return json({ me: await me(ctx) });
}

export async function deleteAvatar(ctx) {
  const u = ctx.data.user;
  if (!u) return json({ error: "unauthorized" }, 401);
  const db = ctx.env.DB, now = nowSec();
  const row = await db.prepare("SELECT avatar FROM users WHERE id = ?1").bind(u.id).first();
  // Already the initials: nothing to write.
  if (!row?.avatar) return json({ me: await me(ctx) });
  const refused = await overHour(db, u.id, now);
  if (refused) return refused;
  await write(ctx, [db.prepare("UPDATE users SET avatar = NULL WHERE id = ?1").bind(u.id)], now);
  return json({ me: await me(ctx) });
}

// The same words for a name nobody holds and for one this person may not see, so neither says which it was.
const notHere = () => json({ error: "not found", reason: "There's no picture by that name for you to see: it is someone's on no trip you share, or gone." }, 404);

export async function getAvatar(ctx) {
  const u = ctx.data.user;
  if (!u) return json({ error: "unauthorized" }, 401);
  const hash = isDrawingHash(ctx.params?.hash);
  if (!hash) return notHere();
  const row = await ctx.env.DB.prepare(
    `SELECT d.bytes FROM drawings d WHERE d.hash = ?1 AND (
       EXISTS (SELECT 1 FROM users self WHERE self.id = ?2 AND self.avatar = ?1)
       OR EXISTS (SELECT 1 FROM users o
                  JOIN trip_members mo ON mo.user_id = o.id
                  JOIN trip_members mm ON mm.trip_id = mo.trip_id AND mm.user_id = ?2 AND mm.left_at IS NULL
                  WHERE o.avatar = ?1 AND o.deleted_at IS NULL))`,
  ).bind(hash, u.id).first();
  if (!row) return notHere();
  // A name is its bytes for good: the same hash is never other bytes, so it may be kept as long as a phone likes.
  // Private: who may read it is a question about the person asking.
  return new Response(new Uint8Array(row.bytes), {
    headers: { "Content-Type": "application/octet-stream", "Cache-Control": "private, max-age=31536000, immutable", ETag: `"${hash}"` },
  });
}

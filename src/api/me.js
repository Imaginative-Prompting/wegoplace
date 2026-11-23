// GET    /api/me -> { id, name, note_color, initials, native_currency, tab_layout, units, guest, avatar?, note_colors }
//        note_colors: the palette a person picks their own color from, [{ hex, name }] (trip.js's one table)
//   `avatar`: the hash of the picture they drew (src/accounts/avatar.js), present only when there is one.
// PATCH  /api/me { name?, note_color?, initials?, native_currency?, tab_layout?, units? } -> { me: { ... } }
//   `units` is 'metric' or 'imperial', or null until the person picks (the app goes by the
//   phone's locale until then). Only its owner sees it: changing it moves no trip's rev.
// DELETE /api/me { confirm: "delete" }   deletes the account (src/accounts/account.js)
//   Any key alone, or several. An absent key is left alone; `initials: null`
//   clears the override and goes back to deriving from the name.
//
// The gate refuses this path without a session and sets ctx.data.user, so an unauthenticated
// request never reaches here (it 401s upstream). That 401 is how a page learns nobody is
// signed in: the app's files are answered to anyone, and this is the first thing they ask.
//
// Nothing here says which trips the account is on: that is GET /api/trips.
//
// A name, a colour, initials and a home currency show on the roster of every trip the account
// is on, so changing one is a write to each of those trips: each trip's rev goes up, and the
// account's member row there takes it.
//
// ── THE ROUTE HAS NO ID IN IT, AND THAT IS THE SECURITY MODEL ───────────────────────────
// PATCH /api/me writes to exactly one row: the one the signed session names. There is no
// /api/me/:id and there must never be, because the whole feature is "let a person change
// their own color" and a route that took a user id would be a route that changes
// somebody else's. ctx.data.user comes from the session; nothing in the request body
// can name a different user, so there is no ownership check to get wrong — the shape of the
// URL is the check.
//
// ── AND THE COLOUR IS NEVER STORED AS SENT ─────────────────────────────────────────────
// isNoteColor() in trip.js checks it against NOTE_COLORS, the same table the pickers were
// drawn from. The palette is not decoration: it has no red and no green in it at all, its
// four hues are separated by LIGHTNESS as well as hue so they survive deuteranopia, and the
// ink drawn on top of each one is computed from the hue itself (inkOn(), public/js/util.js,
// and re-measured against this palette by scripts/theme_contrast.js on every run). A
// client that could write an arbitrary hex could give itself initials nobody can read, on
// four other people's screens, four days from any signal to fix it with.

import { cleanName } from "../accounts/util.js";
import { json, readJson } from "./json.js";
import { isNoteColor, noteColorList } from "./trip.js";
import { moved } from "../trips/rev.js";

// One SELECT rather than trusting ctx.data.user, which the gate builds from the session and
// which doesn't carry the settings. Cheap, and it means GET and PATCH answer with the same
// shape from the same source.
export async function readMe(env, u) {
  const r = await env.DB.prepare(
    "SELECT name, note_color, initials, native_currency, tab_layout, units, guest, avatar FROM users WHERE id = ?1")
    .bind(u.id).first();
  return { id: u.id, name: (r && r.name) || u.name,
    note_color: (r && r.note_color) || null, initials: (r && r.initials) || null,
    native_currency: (r && r.native_currency) || null,
    tab_layout: (r && r.tab_layout) || null, units: (r && r.units) || null,
    // A guest (model §22; src/accounts/guests.js): on trips by link with only a name, signed in on this phone alone.
    guest: !!(r && r.guest),
    // The picture they drew (src/accounts/avatar.js), only when there is one: someone who never draws gets the answer
    // they always got, byte for byte.
    ...(r && r.avatar ? { avatar: r.avatar } : {}) };
}

export async function onRequestGet(ctx) {
  const u = ctx.data.user;
  if (!u) return json({ error: "unauthorized" }, 401);
  // The palette rides with GET only (Your account picks from it outside any trip); PATCH answers as before.
  return json({ ...(await readMe(ctx.env, u)), note_colors: noteColorList() });
}

export async function onRequestPatch(ctx) {
  const u = ctx.data.user;
  if (!u) return json({ error: "unauthorized" }, 401);

  const body = await readJson(ctx.request);
  const wantsColor = "note_color" in body, wantsInitials = "initials" in body;
  const wantsCurrency = "native_currency" in body;
  const wantsTabs = "tab_layout" in body;
  const wantsName = "name" in body;
  const wantsUnits = "units" in body;
  // A key missing from this list is not a no-op — it is a SILENT DATA LOSS. store.js treats
  // a 4xx as permanent and DROPS the queued write, so a field the client can set but this
  // line does not name applies optimistically, disappears on the next refresh, and never
  // retries. native_currency shipped exactly that way and nobody noticed until Split needed
  // to convert into it. Anything added to the users table that the client can write must be
  // added here in the same change.
  if (!wantsColor && !wantsInitials && !wantsCurrency && !wantsTabs && !wantsName && !wantsUnits)
    return json({ error: "nothing to patch", reason: "Nothing was sent to change. An account's settings are name, note_color, initials, native_currency, tab_layout and units." }, 400);
  // The name the people on your trips see: 1 to 40 characters. Two accounts may share one.
  const name = wantsName ? cleanName(body.name) : null;
  if (wantsName && !name) return json({ error: "bad name" }, 400);
  if (wantsColor && !isNoteColor(body.note_color))
    return json({ error: "bad color", reason: "That isn't one of the colors to pick from: pick one of its swatches." }, 400);

  // ── INITIALS ARE VALIDATED, NOT TRUSTED ───────────────────────────────────────────────
  // They are the thing that NAMES a person on a note — the palette is four hues that survive
  // deuteranopia, which is to say colour is never the only signal and the initials carry the
  // identity. So the same argument that keeps the hue on a fixed table applies here: a client
  // that could write anything could put an empty string, or forty characters, or a newline on
  // four other people's screens, four days from any signal to fix it.
  //
  // One to three letters or digits, uppercased, no spaces or punctuation. Explicit null (or
  // an empty string) clears the override and goes back to deriving from the name.
  let initials;
  if (wantsInitials) {
    if (body.initials === null || body.initials === "") initials = null;
    else {
      initials = String(body.initials).trim().toUpperCase();
      if (!/^[\p{L}\p{N}]{1,3}$/u.test(initials))
        return json({ error: "initials must be 1-3 letters or digits", reason: "Initials are one to three letters or digits." }, 400);
    }
  }

  // ── NATIVE CURRENCY ───────────────────────────────────────────────────────────────────
  // The currency Split converts INTO for this person — "be able to convert all currencies to
  // your native currency so its easy to tell what everything costs". It is per-user and not
  // per-trip on purpose: four people on one trip can each read the same purchases in their
  // own money, and nobody's choice changes what anybody else sees.
  //
  // Three uppercase letters, which is ISO 4217's whole shape. Validated for the same reason
  // the initials are: this string is concatenated into no SQL, but it IS looked up in the fx
  // table on every render, and a junk code there is a column of "rate pending" that the user
  // has no way to explain. Explicit null (or empty) clears the override and falls back to the
  // trip's own currency, which is what a member who never opens the setting gets.
  let currency;
  if (wantsCurrency) {
    if (body.native_currency === null || body.native_currency === "") currency = null;
    else {
      currency = String(body.native_currency).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency))
        return json({ error: "native_currency must be a 3-letter ISO code", reason: "Your home currency is a three-letter code: USD, EUR, JPY." }, 400);
    }
  }

  // ── TAB LAYOUT ────────────────────────────────────────────────────────────────────────
  // A JSON array of section ids: the order of the bottom bar and which sections are in it.
  // Validated as SHAPE only — an array of short plain strings — and deliberately not against
  // the section registry, because that registry lives in public/js/tabs.js and ships with the
  // client. A phone running a newer build may legitimately name a section this deployment has
  // never heard of, and rejecting it here would make the bar un-settable for exactly the
  // person who updated first. tabs.js's resolve() repairs anything unusable at render time,
  // which is the right place: it is the only code that knows how many slots there are.
  //
  // Explicit null (or empty) clears the override and goes back to the shipped default.
  let tabs;
  if (wantsTabs) {
    if (body.tab_layout === null || body.tab_layout === "") tabs = null;
    else {
      let arr = body.tab_layout;
      if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch { arr = null; } }
      if (!Array.isArray(arr) || arr.length > 16
          || !arr.every((v) => typeof v === "string" && /^[a-z0-9_-]{1,32}$/.test(v)))
        return json({ error: "tab_layout must be an array of section ids", reason: "The tabs' order is a list of at most 16 tab names." }, 400);
      tabs = JSON.stringify(arr);
    }
  }

  if (wantsUnits && body.units !== null && body.units !== "metric" && body.units !== "imperial") {
    return json({ error: "bad units", need: "metric, imperial, or null to go by the phone", reason: "Units are metric or imperial, or nothing to go by the phone's own." }, 400);
  }

  // Two people MAY end up sharing a hue now, and that is the deliberate consequence of
  // letting anyone choose. ensureNoteColors() only ever hands out distinct colours to people
  // who have none; it does not police a choice made on purpose, and refusing one because a
  // housemate got there first would be a control that sometimes silently does nothing. The
  // initials on their face are what name the person — the palette's own design note says so
  // — and they are unaffected by two people agreeing on amber.
  // One statement per field that was actually asked for, so PATCHing the colour never
  // silently blanks the initials and vice versa.
  const D = ctx.env.DB;
  const stmts = [];
  if (wantsName) stmts.push(D.prepare("UPDATE users SET name = ?1 WHERE id = ?2").bind(name, u.id));
  if (wantsColor) stmts.push(D.prepare("UPDATE users SET note_color = ?1 WHERE id = ?2").bind(body.note_color, u.id));
  if (wantsInitials) stmts.push(D.prepare("UPDATE users SET initials = ?1 WHERE id = ?2").bind(initials, u.id));
  if (wantsCurrency) stmts.push(D.prepare("UPDATE users SET native_currency = ?1 WHERE id = ?2").bind(currency, u.id));
  if (wantsTabs) stmts.push(D.prepare("UPDATE users SET tab_layout = ?1 WHERE id = ?2").bind(tabs, u.id));
  if (wantsUnits) stmts.push(D.prepare("UPDATE users SET units = ?1 WHERE id = ?2").bind(body.units, u.id));
  // What a roster shows changed (everything here but the tab layout, which only its owner
  // sees): every trip the account is on now, and its row on each, takes one step of rev.
  if (wantsName || wantsColor || wantsInitials || wantsCurrency) {
    stmts.push(
      D.prepare(
        "UPDATE trips SET rev = rev + 1, data_rev = rev + 1 WHERE id IN " +
        "(SELECT trip_id FROM trip_members WHERE user_id = ?1 AND left_at IS NULL) RETURNING id, rev").bind(u.id),
      D.prepare(
        "UPDATE trip_members SET rev = (SELECT rev FROM trips WHERE id = trip_members.trip_id) " +
        "WHERE user_id = ?1 AND left_at IS NULL").bind(u.id),
    );
  }
  // One batch is one transaction: the fields and the revs land together.
  const done = await D.batch(stmts);
  // Each of those trips' rooms hears its new rev.
  const moves = wantsName || wantsColor || wantsInitials || wantsCurrency ? done[done.length - 2].results ?? [] : [];
  await Promise.all(moves.map((t) => moved(ctx.env, t.id, t.rev)));

  // Enveloped under `me`, because that is what store.js's unwrap() looks for on a write
  // response. Reaching for a bare row there finds nothing SILENTLY: the write still lands,
  // but the server's version of the row never replaces the optimistic one.
  // Read back rather than echo: a PATCH of one field still has to answer with BOTH, or the
  // optimistic row on the client gets replaced by one that is missing the other.
  return json({ me: await readMe(ctx.env, u) });
}

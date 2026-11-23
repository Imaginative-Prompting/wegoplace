// WHO MAY CALL WHAT: the rule for every row of src/routes.js, written down once, in words, with what each caller
// gets. checks/access/sweep.mjs reads the route table itself and calls every row as each of six callers; a row
// with no rule here fails the sweep, so a new route can't go out without one.
//
// The six callers (all made up): "out" signed out; "none" signed in, on no trip; "other" the host of another
// trip, not on this one; "member" on this trip; "host" this trip's host; "guest" on this trip as a guest (joined by
// its link with only a name, model §22): a member in everything but what needs an account.
//
// What a caller gets, as a rule says it:
//   401        refused: not signed in ({ error: "unauthorized" } on the API; a page's 401 on a page)
//   "no trip"  refused exactly as if the trip didn't exist (src/trips/access.js noSuchTrip): never "forbidden"
//   403        refused in words: { error, reason } with a reason a person can read
//   "403 page" refused with a page (403) that says why, for an address a person opens
//   "in"       let through to the route: anything but 401, 403 or "no trip" (what it then says is the route's)
//   "2xx"      let through, and done: the body given is a real one, so a refused caller's same body would write
//   "same"     (anyone) every caller gets the same answer: nothing depends on who
//   a number   exactly that status
// Every refused call must also have written nothing: every table read before and after (the sweep).
// Every answer in JSON, to every caller, says `Cache-Control: no-store` (src/api/json.js): it is someone's trip or
// account, and no cache may keep it. A row that keeps its own (cache: in words) must still say one.
//
// Each rule: { rule (in words), who: "anyone" | "signed-in" | "trip" | "host", want?: { caller: expected } over
// the kind's, params?(fx, who), body?(fx, who), page? (asked for as a page), last? (it ends sessions or deletes
// what the sweep stands on: run at the end), ok?: callers whose call must be done (2xx), cache? }.
// fx: the sweep's fixtures (ids of real rows on the trip, made through the routes).

import { encode, toB64url } from "../../public/js/shared/avatar.js";

// A real picture, for the write that takes one (public/js/shared/avatar.js).
const SWEEP_DRAWING = toB64url(encode({ palette: 0, strokes: [{ ink: 0, brush: 52, pts: [[100, 100], [150, 150]] }] }));

const kinds = {
  anyone: { out: "same", none: "same", other: "same", member: "same", host: "same", guest: "same" },
  "signed-in": { out: 401, none: "in", other: "in", member: "in", host: "in", guest: "in" },
  trip: { out: 401, none: "no trip", other: "no trip", member: "in", host: "in", guest: "in" },
  host: { out: 401, none: "no trip", other: "no trip", member: 403, host: "in", guest: 403 },
};
// What only an account may do (model §22): a guest is refused in words.
const NOT_GUEST = { guest: 403 };
export const expected = (r, who) => (r.want?.[who] ?? kinds[r.who][who]);

const anyone = (rule, more = {}) => ({ rule, who: "anyone", ...more });
const signedIn = (rule, more = {}) => ({ rule, who: "signed-in", ...more });
const trip = (rule, more = {}) => ({ rule, who: "trip", ...more });
const host = (rule, more = {}) => ({ rule, who: "host", ...more });
const id = (who) => `sw-${who}`;

export const RULES = {
  // ── signing in: the flow's own challenge, code or token decides, never a session ──
  "POST /api/auth/register/options": anyone("Anyone may start making an account (a challenge, kept 5 minutes).", { body: () => ({ name: "" }) }),
  "POST /api/auth/register/verify": anyone("The challenge decides, never who asks."),
  "POST /api/auth/login/options": anyone("Anyone may start signing in."),
  "POST /api/auth/login/verify": anyone("The passkey's signature decides."),
  "POST /api/auth/passkeys/options": signedIn("Adding a passkey is to your own account."),
  "POST /api/auth/passkeys/verify": signedIn("Adding a passkey is to your own account."),
  "POST /api/auth/pending/create": anyone("A sign-in from Google or GitHub, waiting in its own cookie, decides."),
  "POST /api/auth/pending/attach": signedIn("Attaching a waiting sign-in is to your own account."),
  "GET /api/auth/pending": anyone("Its own cookie decides."),
  "POST /api/auth/recover/confirm": anyone("The emailed code decides."),
  "POST /api/auth/recover": anyone("Anyone may ask for a code to their email; the answer never says whether the address is known.", { body: () => ({ email: "nobody@example.org" }) }),
  "POST /api/auth/link": anyone("The link's token decides.", { body: () => ({ token: "a".repeat(43) }) }),
  "POST /api/auth/logout/all": signedIn("Ends your own sessions.", { last: true }),
  "POST /api/auth/logout": anyone("Ends your own session; signed out, there is nothing to end.", { last: true, want: { out: "in", none: "in", other: "in", member: "in", host: "in", guest: "in" } }),
  "GET /api/auth/config": anyone("Which ways in this site offers."),
  "DELETE /api/auth/ways/passkey/:id": signedIn("Only your own passkeys (another account's: as if none).", { params: (fx) => ({ id: fx.passkeyOf.host }), want: { host: "in", none: 404, other: 404, member: 404, guest: 404 } }),
  "DELETE /api/auth/ways/:provider/:subject": signedIn("Only your own ways in.", { params: () => ({ provider: "google", subject: "sw-nobody" }) }),
  "GET /api/auth/ways": signedIn("Your own ways in."),
  "POST /api/account/email/confirm": signedIn("Your own email; a guest has none.", { want: NOT_GUEST }),
  "GET /api/account/email": signedIn("Your own email."),
  "POST /api/account/email": signedIn("Your own email; a guest has none.", { want: NOT_GUEST }),
  "DELETE /api/account/email": signedIn("Your own email; a guest has none.", { want: NOT_GUEST }),
  "GET /api/account/storage": signedIn("What your own trips hold."),
  "GET /api/account/export": signedIn("Your own data, and nobody else's (check:assistant-export)."),
  "GET /api/account/plan": signedIn("Your own plan."),
  "POST /api/account/plan/checkout": signedIn("Buying the plan for your own account; a guest can't host, so can't.", { body: () => ({ interval: "sideways" }), want: NOT_GUEST }),
  "POST /api/account/plan/portal": signedIn("Your own plan at Stripe; a guest has none.", { want: NOT_GUEST }),
  "POST /api/billing/stripe": anyone("Only Stripe's signature (check:billing holds a signed event): unsigned, refused for everyone, nothing read.",
    { body: () => ({ id: "evt_sweep", type: "customer.subscription.deleted", data: { object: {} } }), want: { out: 400, none: 400, other: 400, member: 400, host: 400, guest: 400 } }),
  "GET /api/me": signedIn("Yourself."),
  "PATCH /api/me": signedIn("Yourself.", { body: (fx, who) => ({ name: `Sweep ${who}` }) }),
  "DELETE /api/me": signedIn("Deletes your own account only.", { last: true }),
  // A drawn picture (src/accounts/avatar.js): one's own only, guests too (a guest is a person on the trip).
  "PUT /api/me/avatar": signedIn("Your own picture, guests too.", { body: () => ({ drawing: SWEEP_DRAWING }) }),
  "DELETE /api/me/avatar": signedIn("Your own picture, guests too."),
  "GET /api/avatars/:hash": signedIn("Someone on a trip with its person (checks/avatar: who may read one); a name nobody holds is 404 to everyone signed in.",
    { params: () => ({ hash: "A".repeat(12) }), want: { none: 404, other: 404, member: 404, host: 404, guest: 404 } }),
  "GET /login/new": anyone("The sign-in page.", { page: true }),
  "GET /login/link/:token": anyone("The sign-in page; the token is read by POST /api/auth/link.", { page: true, params: () => ({ token: "x".repeat(43) }) }),
  "GET /login/:provider/callback": anyone("The provider's answer decides (not set up here: as if none).", { page: true, params: () => ({ provider: "google" }) }),
  "POST /login/:provider": anyone("Starts a provider's sign-in (not set up here).", { page: true, params: () => ({ provider: "google" }) }),
  "GET /login/:provider": anyone("Starts a provider's sign-in (not set up here).", { page: true, params: () => ({ provider: "google" }) }),
  "POST /api/fx/refresh": signedIn("Exchange rates, for anyone signed in; the provider is asked at most once a gap per isolate (fx.js MIN_ATTEMPT_GAP_MS), whoever asks."),
  "GET /api/fx": signedIn("Exchange rates.", { cache: "the same for everyone, kept privately until the next fetch is due (fx.js cacheControl)" }),
  "* /api/fx": signedIn("Exchange rates.", { cache: "the same for everyone, kept privately until the next fetch is due (fx.js cacheControl)" }),
  "GET /authorize": signedIn("A person approves an app for their own account; signed out, the sign-in page first; a guest, the page saying to add a passkey first.", { page: true, want: { out: "in", guest: "403 page" } }),
  "POST /authorize": signedIn("Only the answer to the page this person was shown; a guest, the page saying to add a passkey first.", { body: () => ({ decision: "approve" }), want: { guest: "403 page" } }),
  "GET /api/account/apps": signedIn("Your own connected apps."),
  "POST /api/errors": anyone("A page's error report, signed in or not: taken the same for everyone (200, its kind's fingerprint), and it keeps nothing of who.",
    { body: () => ({ kind: "error", name: "Error", message: "the sweep's report", stack: "Error\n    at a (https://wegoplace.com/js/a.js:1:1)" }) }),
  "POST /api/bug-reports": anyone("A bug report, signed in (linked to the account) or not (to no one): answered the same for everyone. Here a JSON body, which every caller has refused in the same words, nothing written; check:bug-reports sends real ones.",
    { body: () => ({ text: "the sweep's report" }) }),
  "GET /api/account/bug-reports/:id/screenshot": signedIn("A bug report's screenshot, to the account that sent it only: anyone else's, or none, is 404 (check:bug-reports)."),
  "GET /api/admin/bug-reports": signedIn("The operator's list of bug reports: absent for everyone ADMIN_ACCOUNTS doesn't name.", { want: { none: 404, other: 404, member: 404, host: 404, guest: 404 } }),
  "GET /api/admin/bug-reports/:id": signedIn("One bug report, for the operator: absent for everyone ADMIN_ACCOUNTS doesn't name.", { want: { none: 404, other: 404, member: 404, host: 404, guest: 404 } }),
  "GET /admin/errors": signedIn("The site owner's page of what broke: only an account ADMIN_ACCOUNTS names (none of these), absent for everyone else; signed out, sent to sign in first, as every page behind the gate.", { page: true, want: { out: "in", none: 404, other: 404, member: 404, host: 404, guest: 404 } }),
  "GET /api/admin/errors": signedIn("The owner's list of what broke: absent for everyone ADMIN_ACCOUNTS doesn't name.", { want: { none: 404, other: 404, member: 404, host: 404, guest: 404 } }),
  "POST /api/admin/errors/clear": signedIn("Clearing a kind of error: the owner's alone, absent for everyone else, nothing cleared.", { body: () => ({ fingerprints: ["sweep"] }), want: { none: 404, other: 404, member: 404, host: 404, guest: 404 } }),
  "DELETE /api/account/apps/:id": signedIn("Only your own apps (another account's grant: nothing happens to it).", { params: (fx) => ({ id: fx.grantOf.host }) }),
  "GET /api/account/push": signedIn("Your own phones."),
  "PUT /api/account/push": signedIn("Your own phones."),
  "DELETE /api/account/push": signedIn("Your own phones."),

  // ── trips, joining, pictures by link, pages ──
  "GET /api/trips": signedIn("The trips you're on."),
  "POST /api/trips": signedIn("A trip of your own, you its host; a guest can't host.", { body: (fx, who) => ({ id: `t-${id(who)}`, name: "Sweep made", default_tz: "UTC" }), want: NOT_GUEST }),
  "GET /api/join/:code": anyone("Anyone with the link sees what it joins (and not without it).", { params: () => ({ code: "J".repeat(22) }) }),
  "POST /api/join/:code": signedIn("Joining is as yourself, with the link; signed out, as a guest by the name given (the link decides).", { params: () => ({ code: "J".repeat(22) }), want: { out: "in" } }),
  "GET /join/:code": anyone("The join page.", { page: true, params: () => ({ code: "J".repeat(22) }) }),
  "PUT /pictures/upload/:token": anyone("Only the link's token: one use, 15 minutes (the sweep holds both).", { params: () => ({ token: "x".repeat(43) }) }),
  "GET /trips/:id": signedIn("The trip's people page: a page with nothing of the trip in it; it reads the trip through the API.", { page: true, want: { out: "in" } }),
  "GET /t/:id": signedIn("The app at a trip: a page with nothing of the trip in it; it reads the trip through the API.", { page: true, want: { out: "in" } }),

  // ── a trip's own: on it, or as if it didn't exist ──
  "GET /api/trips/:trip/rev": trip("On the trip."),
  "GET /api/trips/:trip/live": trip("On the trip (a WebSocket)."),
  "GET /api/trips/:trip/members": trip("On the trip."),
  "GET /api/trips/:trip/people": trip("On the trip."),
  "DELETE /api/trips/:trip/members/:user": host("The host removes someone; a member only leaves (themself: check:trips).", { params: (fx) => ({ user: fx.ids.host }), want: { host: 409 } }),
  "POST /api/trips/:trip/members/:user/rejoin": host("Only the host makes a link that signs a guest in again (check:accounts' guests part holds who it may be for).", { params: (fx) => ({ user: fx.ids.guest }), ok: ["host"] }),
  "POST /api/trips/:trip/host/accept": trip("Only the person offered the role (others: no offer); a guest can't host.", { want: NOT_GUEST }),
  "POST /api/trips/:trip/host/decline": trip("Only the person offered the role."),
  "POST /api/trips/:trip/host": host("Only the host offers the role.", { body: (fx) => ({ to: fx.ids.member }), last: true }),
  "DELETE /api/trips/:trip/host": host("Only the host takes an offer back."),
  "* /api/trips/:trip/tiles": trip("On the trip."),
  "POST /api/trips/:trip/tiles/cut": host("Only the host remakes the map."),
  "POST /api/trips/:trip/tiles/plan": trip("Anyone on the trip may plan a map."),
  "POST /api/trips/:trip/tiles/use": host("Only the host sets the map.", { body: () => ({ key: "o/ab/nothing/x.pmtiles" }) }),
  "GET /api/trips/:trip/links": trip("On the trip."),
  "POST /api/trips/:trip/links": trip("Anyone on the trip may invite.", { body: () => ({ days: 1, uses: 1 }), ok: ["member", "host"] }),
  "DELETE /api/trips/:trip/links/:id": host("Only the host revokes a link.", { params: (fx) => ({ id: fx.link }), last: true }),
  "GET /api/trips/:trip/changes": trip("On the trip."),
  "DELETE /api/trips/:trip/changes": host("Only the host clears the list.", { last: true }),
  "POST /api/trips/:trip/changes/:id/undo": trip("On the trip."),
  "GET /api/trips/:trip/areas": trip("On the trip."),
  "PUT /api/trips/:trip/areas": trip("On the trip.", { body: (fx, who) => ({ areas: [{ id: fx.area, name: `Area by ${who}`, sort: 1 }] }), ok: ["member", "host"] }),
  "DELETE /api/trips/:trip/areas": trip("On the trip.", { body: (fx, who) => (["member", "host"].includes(who) ? { ids: [id(who)] } : { ids: [fx.area] }), last: true }),
  "DELETE /api/trips/:trip/areas/:id": trip("On the trip.", { params: (fx, who) => ({ id: ["member", "host"].includes(who) ? id(who) : fx.area }), last: true }),
  "POST /api/trips/:trip/references": trip("On the trip: anyone on it adds to the quick reference, as with plans.", { body: (fx, who) => ({ id: `${id(who)}-rf`, title: `Sweep note by ${who}` }), ok: ["member", "host"] }),
  "PUT /api/trips/:trip/references": trip("On the trip.", { body: (fx, who) => ({ references: [{ id: `${id(who)}-rfp`, title: `Sweep notes by ${who}`, body: "112" }] }), ok: ["member", "host"] }),
  "PATCH /api/trips/:trip/references/:id": trip("On the trip.", { params: (fx, who) => ({ id: `${id(who)}-rf` }), body: (fx, who) => ({ body: `Changed by ${who}` }) }),
  "DELETE /api/trips/:trip/references/:id": trip("On the trip.", { params: (fx, who) => ({ id: `${id(who)}-rf` }), last: true }),
  "DELETE /api/trips/:trip/references": trip("On the trip.", { body: (fx, who) => ({ ids: [`${id(who)}-rfp`] }), last: true }),
  "PUT /api/trips/:trip/places": trip("On the trip.", { body: (fx, who) => ({ places: [{ id: fx.place, notes: `Note by ${who}` }] }), ok: ["member", "host"] }),
  "DELETE /api/trips/:trip/places": trip("On the trip.", { body: (fx, who) => ({ ids: [["member", "host"].includes(who) ? id(who) : fx.place] }), last: true }),
  "DELETE /api/trips/:trip/places/:id": trip("On the trip.", { params: (fx, who) => ({ id: ["member", "host"].includes(who) ? id(who) : fx.place }), last: true }),
  "PUT /api/trips/:trip/packing/lists": trip("On the trip.", { body: (fx, who) => ({ lists: [{ key: fx.list, name: `List by ${who}` }] }), ok: ["member", "host"] }),
  "DELETE /api/trips/:trip/packing/lists/:key": trip("On the trip.", { params: (fx, who) => ({ key: ["member", "host"].includes(who) ? id(who) : fx.list }), last: true }),
  "PUT /api/trips/:trip/packing/starters": trip("On the trip."),
  "PATCH /api/trips/:trip/packing/starters": trip("On the trip."),
  "PUT /api/trips/:trip/packing/ticks": trip("On the trip; another person's own item: refused in words.",
    { body: (fx) => ({ item_id: fx.memberItem, list_key: fx.list, ticked: true }), want: { host: 403, guest: 403 }, ok: ["member"] }),
  "PUT /api/trips/:trip/packing/items": trip("On the trip; another person's own item: the batch refused, naming that row (400), nothing written.",
    { body: (fx, who) => ({ items: [{ id: fx.memberItem, label: `Changed by ${who}`, category: "clothes" }] }), want: { host: 400 }, ok: ["member"] }),
  "DELETE /api/trips/:trip/events/:id": trip("On the trip.", { params: (fx, who) => ({ id: ["member", "host"].includes(who) ? id(who) : fx.event }), last: true }),
  "PATCH /api/trips/:trip/events/:id": trip("On the trip.", { params: (fx) => ({ id: fx.event }), body: (fx, who) => ({ detail: `By ${who}` }), ok: ["member", "host"] }),
  "DELETE /api/trips/:trip/packing/:id": trip("On the trip; another person's own item: refused in words.", { params: (fx, who) => ({ id: who === "member" ? id(who) : fx.memberItem }), want: { host: 403, guest: 403 }, last: true }),
  "PATCH /api/trips/:trip/packing/:id": trip("On the trip; another person's own item: refused in words.",
    { params: (fx) => ({ id: fx.memberItem }), body: (fx, who) => ({ label: `By ${who}` }), want: { host: 403, guest: 403 }, ok: ["member"] }),
  "DELETE /api/trips/:trip/purchases/:id": trip("On the trip; only who made it or paid it.", { params: (fx) => ({ id: fx.purchase }), want: { host: 403, guest: 403 }, last: true }),
  "PUT /api/trips/:trip/pictures/cover": trip("On the trip."),
  "DELETE /api/trips/:trip/pictures/cover": trip("On the trip.", { last: true }),
  "POST /api/trips/:trip/pictures/cover/from-url": trip("On the trip."),
  "POST /api/trips/:trip/pictures/cover/upload-link": trip("On the trip.", { body: () => ({ license: "own" }), ok: ["member", "host"] }),
  "PUT /api/trips/:trip/pictures/:kind/:id": trip("On the trip.", { params: (fx) => ({ kind: "place", id: fx.place }) }),
  "DELETE /api/trips/:trip/pictures/:kind/:id": trip("On the trip.", { params: (fx) => ({ kind: "place", id: fx.place }), last: true }),
  "POST /api/trips/:trip/pictures/:kind/:id/from-url": trip("On the trip.", { params: (fx) => ({ kind: "place", id: fx.place }) }),
  "POST /api/trips/:trip/pictures/:kind/:id/upload-link": trip("On the trip.", { params: (fx) => ({ kind: "place", id: fx.place }), body: () => ({ license: "own" }), ok: ["member", "host"] }),
  "PATCH /api/trips/:trip/purchases/:id": trip("On the trip; only who made it or paid it.", { params: (fx) => ({ id: fx.purchase }), body: () => ({ note: "Changed" }), want: { host: 403, guest: 403 }, ok: ["member"] }),
  "* /api/trips/:trip/collage/:path*": trip("On the trip (its routes: SUBROUTES below).", { params: () => ({ path: "shares" }) }),
  "* /api/trips/:trip/media/:path*": trip("On the trip (its routes: SUBROUTES below).", { params: () => ({ path: "x" }) }),
  "* /api/trips/:trip/memories/:path*": trip("On the trip (its routes: SUBROUTES below).", { params: () => ({ path: "" }) }),
  "GET /api/trips/:trip/events": trip("On the trip."),
  "POST /api/trips/:trip/events": trip("On the trip.", { body: (fx, who) => ({ id: `${id(who)}-p`, title: "Sweep plan", starts_at: fx.t0, tz: "UTC" }), ok: ["member", "host"] }),
  "PUT /api/trips/:trip/events": trip("On the trip.", { body: (fx, who) => ({ events: [{ id: fx.event, title: "Sweep plan", kind: "plan", starts_at: fx.t0, tz: "UTC", detail: `By ${who}` }] }) }),
  "DELETE /api/trips/:trip/events": trip("On the trip.", { body: (fx, who) => ({ ids: [["member", "host"].includes(who) ? id(who) : fx.event] }), last: true }),
  "GET /api/trips/:trip/messages": trip("On the trip."),
  "POST /api/trips/:trip/messages": trip("On the trip.", { body: (fx, who) => ({ id: `${id(who)}-m`, body: "Sweep" }), ok: ["member", "host"] }),
  "PATCH /api/trips/:trip/messages/:id": trip("On the trip; only its writer edits it.", { params: (fx) => ({ id: fx.message }), body: () => ({ body: "Edited" }), want: { host: 403, guest: 403 }, ok: ["member"] }),
  "DELETE /api/trips/:trip/messages/:id": trip("On the trip; its writer or the host deletes it.", { params: (fx) => ({ id: fx.hostMessage }), want: { member: 403, guest: 403 }, last: true }),
  "PUT /api/trips/:trip/chat/mute": trip("On the trip: your own mute.", { body: () => ({ muted: false }), ok: ["member", "host"] }),
  "GET /api/trips/:trip/assistant": trip("On the trip."),
  "PUT /api/trips/:trip/assistant/off": host("Only the host turns it off for the trip.", { body: () => ({ off: false }), ok: ["host"] }),
  "POST /api/trips/:trip/assistant/conversations": trip("On the trip: a conversation of your own.", { body: (fx, who) => ({ id: `${id(who)}-c` }), ok: ["member", "host"] }),
  "GET /api/trips/:trip/assistant/conversations/:id": trip("On the trip: only your own (another's: as if none).", { params: (fx) => ({ id: fx.conversation }), want: { host: 404 }, ok: ["member"] }),
  "DELETE /api/trips/:trip/assistant/conversations/:id": trip("Only your own (another's: as if none).", { params: (fx) => ({ id: fx.conversation }), want: { host: 404, member: "in", guest: 404 }, last: true }),
  "POST /api/trips/:trip/assistant/conversations/:id/ask": trip("Only into your own (another's: as if none).", { params: (fx) => ({ id: fx.conversation }), body: () => ({ id: "sw-ask", words: "Hello" }), want: { host: 404, member: "in", guest: 404 } }),
  "POST /api/trips/:trip/assistant/conversations/:id/files": trip("Only into your own conversation (another's: as if none).", { params: (fx) => ({ id: fx.conversation }), body: () => Buffer.from("A short note."), want: { host: 404, member: "in", guest: 404 } }),
  "GET /api/trips/:trip/assistant/conversations/:id/files": trip("Only your own conversation's (another's: as if none).", { params: (fx) => ({ id: fx.conversation }), want: { host: 404, member: "in", guest: 404 } }),
  "GET /api/trips/:trip/assistant/conversations/:id/files/:file": trip("Only your own file (another's: as if none, the host's too).", { params: (fx) => ({ id: fx.conversation, file: fx.file }), want: { host: 404, member: "in", guest: 404 } }),
  "DELETE /api/trips/:trip/assistant/conversations/:id/files/:file": trip("Only your own file (another's: as if none).", { params: (fx) => ({ id: fx.conversation, file: fx.file }), want: { host: 404, member: "in", guest: 404 }, last: true }),
  "POST /api/trips/:trip/assistant/conversations/:id/share": trip("Only from your own (another's: as if none).", { params: (fx) => ({ id: fx.conversation }), body: (fx) => ({ id: "sw-share", turn: fx.turn }), want: { host: 404, member: "in", guest: 404 } }),
  "DELETE /api/trips/:trip/packing": trip("On the trip; another person's own item: refused in words.", { body: (fx, who) => ({ id: who === "member" ? id(who) : fx.memberItem }), want: { host: 403, guest: 403 }, last: true }),
  "GET /api/trips/:trip/packing": trip("On the trip: the group's, and your own."),
  "PATCH /api/trips/:trip/packing": trip("On the trip; another person's own item: refused in words.", { body: (fx, who) => ({ id: fx.memberItem, label: `By ${who}` }), want: { host: 403, guest: 403 }, ok: ["member"] }),
  "POST /api/trips/:trip/packing": trip("On the trip.", { body: (fx, who) => ({ id: `${id(who)}-k`, label: "Sweep", owner: "group" }), ok: ["member", "host"] }),
  "GET /api/trips/:trip/places": trip("On the trip."),
  "GET /api/trips/:trip/references": trip("On the trip."),
  "GET /api/trips/:trip/purchases": trip("On the trip."),
  "POST /api/trips/:trip/purchases": trip("On the trip.", { body: (fx, who) => ({ id: `${id(who)}-u`, description: "Sweep", amount_minor: 100, currency: "USD", paid_by: fx.ids[who] ?? fx.ids.host, spent_at: fx.t0, split_mode: "weight", shares: [{ user_id: fx.ids[who] ?? fx.ids.host, weight: 1, share_minor: 100 }] }), ok: ["member", "host"] }),
  "GET /api/trips/:trip": trip("On the trip."),
  "PATCH /api/trips/:trip": trip("On the trip.", { body: (fx, who) => ({ interests: `By ${who}` }), ok: ["member", "host"] }),
  "DELETE /api/trips/:trip": host("Only the host deletes the trip.", { last: true }),

  // ── shared links and files ──
  "GET /s/:id*": anyone("Anyone with a share's link sees what was shared, while it is shared (the sweep holds a real one).", { page: true, params: (fx) => ({ id: fx.goneShare }) }),
  "* /media/:path*": trip("A file of a trip: only someone on that trip (as if none otherwise).", { params: (fx) => ({ path: fx.mediaKey }), want: { none: 404, other: 404 } }),
  "* /tiles/fonts/:path*": signedIn("The map's fonts, for anyone on some trip.", { params: () => ({ path: "x" }), want: { none: "in" } }),
};

// The routes inside a dispatcher's row, which the table can't list: [method, the path after the trip, the rule].
// media/ answers its own list of routes (its 404), and the sweep holds that every one is here.
const sub = (under, method, action, path, rule, more = {}) => ({ under, method, action, path, rule, who: "trip", ...more });
const pendingQ = (fx) => `key=${encodeURIComponent(fx.pending.key)}&id=${encodeURIComponent(fx.pending.id)}`;
export const SUBROUTES = [
  sub("media", "GET", "config", () => "config", "On the trip: how uploads are cut."),
  sub("media", "POST", "begin", () => "begin", "On the trip: an upload of your own.", { body: () => ({ name: "a.jpg", mime: "image/jpeg", bytes: 1024, kind: "photo" }), ok: ["member", "host"] }),
  sub("media", "PUT", "part", (fx) => `part?${pendingQ(fx)}&n=1`, "Only the person who started the upload goes on with it.", { want: { host: 403, guest: 403 } }),
  sub("media", "POST", "part", (fx) => `part?${pendingQ(fx)}&n=1`, "Only the person who started the upload goes on with it.", { want: { host: 403, guest: 403 } }),
  sub("media", "POST", "finish", () => "finish", "Only the person who started the upload finishes it.", { body: (fx) => ({ key: fx.pending.key, id: fx.pending.id, parts: [] }), want: { host: 403, guest: 403 } }),
  sub("media", "POST", "thumb", (fx) => `thumb?for=${encodeURIComponent(fx.mediaKey)}&mime=image/webp`, "A thumbnail only for a file you uploaded yourself.", { body: () => Buffer.alloc(512, 7), want: { host: 403, guest: 403 } }),
  sub("media", "PUT", "thumb", (fx) => `thumb?for=${encodeURIComponent(fx.mediaKey)}&mime=image/webp`, "A thumbnail only for a file you uploaded yourself.", { body: () => Buffer.alloc(512, 7), want: { host: 403, guest: 403 } }),
  sub("media", "POST", "abort", () => "abort", "Only the person who started the upload stops it.", { body: (fx) => ({ key: fx.pending.key, id: fx.pending.id }), want: { host: 403 } }),
  sub("media", "DELETE", "object", (fx) => `object?key=${encodeURIComponent(fx.hostLoose)}`, "Only who uploaded a file, or the host, deletes it.", { want: { member: 403, guest: 403 } }),
  sub("memories", "GET", "", () => "", "On the trip."),
  sub("memories", "POST", "", () => "", "On the trip: a memory of your own uploads.", { body: (fx, who) => ({ id: `mem-${who}`, caption: "x", media: [{ key: fx.mediaKey, w: 10, h: 10 }] }), want: { host: 403, guest: 403 } }),
  sub("memories", "GET", "tags", () => "tags", "On the trip."),
  sub("memories", "GET", ":id", (fx) => fx.memory, "On the trip."),
  sub("memories", "PATCH", ":id", (fx) => fx.memory, "When a memory happened: only who posted it.", { body: (fx) => ({ day: fx.day0 }), want: { host: 403, guest: 403 } }),
  sub("memories", "DELETE", ":id", (fx) => fx.hostMemory, "Who made a memory, or the host, deletes it.", { want: { member: 403, guest: 403 } }),
  sub("collage", "GET", "shares", () => "shares", "On the trip."),
  sub("collage", "POST", "share", () => "share?mime=image/jpeg&w=10&h=10&title=x", "On the trip."),
  sub("collage", "POST", "share/:id/item", (fx) => `share/${fx.hostBoard}/item`, "On the trip."),
  sub("collage", "POST", "share/:id/video", (fx) => `share/${fx.hostBoard}/video`, "On the trip."),
  sub("collage", "DELETE", "share/:id", (fx) => `share/${fx.hostBoard}`, "Its maker or the host revokes a board.", { want: { member: 403, guest: 403 } }),
];

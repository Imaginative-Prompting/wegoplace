# API

The server is one Cloudflare Worker, `src/`, with `public/` as its static files.

**The app's own files never reach the Worker.** Cloudflare's asset server answers everything in
`public/` to anyone: pages, scripts, styles, pictures. They are the same for everyone and hold
nothing of anyone's; a page learns whether someone is signed in by asking `/api/me`. What the
Worker sees is what `wrangler.jsonc`'s `run_worker_first` lists: `/api`, `/media/`, `/tiles/`,
a shared board's page (`/s/`), the sign-in addresses under `/login/`, and a join link's page
(`/join/<code>`). Those globs are case-sensitive and exact: `/API/…`, or a bare `/media`, is a
file request, and the file server answers it with the app's page.

For a request that does reach it, `src/index.js` runs the gate (`src/gate.js`) first, then the
route table (`src/routes.js`). Everything is JSON except stored files (`/media/*`), map data
(`/tiles/*`) and the three pages the Worker hands out itself (`/login/new`,
`/login/link/<token>`, `/join/<code>`). Every JSON answer carries `Cache-Control: no-store`
(`src/api/json.js`), so no cache keeps someone's trip or account; the exchange rates
(`GET /api/fx`) are the one route with caching of their own.

Every page of the app says `X-Frame-Options: DENY` and `Content-Security-Policy:
frame-ancestors 'none'` (`public/_headers`): no other site can show it inside its own. A shared
board's page (`/s/`) is the exception, public with nothing to press, so anyone may embed it.

The gate sorts an address into one of two kinds:

| kind | what it is | who gets an answer |
|---|---|---|
| public | the routes that sign someone in or out, the sign-in addresses, a shared board's page, a join link's page and what it shows (`GET /api/join/<code>`) | anyone |
| signed in | everything else | any account with a session |

What it answers itself, before any route runs:

- no session, for anything not public: `401 {"error":"unauthorized"}` under `/api`, and `401`
  with the text `unauthorized` for a stored file or map data fetched by a script. The app's
  pages are public files that never reach the gate, and each sends a signed-out visitor to
  `/login?next=<where it was>` itself; the one redirect left is for a stored file or map data
  opened as a page (`Accept: text/html`), which goes to `/login?next=<that address>`. A
  request whose session cookie finds no session is also told to clear it (and `wgp_who`, below);
- a change (`POST`, `PATCH`, `PUT`, `DELETE`) that a browser says came from another site's page
  (an `Origin` that isn't this site's, or `Sec-Fetch-Site` saying `same-site` or `cross-site`):
  `403 {"error":"cross site"}`, the public routes included, before anything runs and with no
  cookie set. A request with neither header isn't a browser's and is let through;
- cookies that find no session, more than 1,200 of them a minute from one connection:
  `429 {"error":"too many"}` with `Retry-After`. People who are signed in are not counted for
  using the app, however many requests that is (`src/accounts/sessions.js` says how).

**Signing in puts nobody on a trip.** Whether the caller is on the trip an address names is
checked once, in the route table: every row under `/api/trips/:trip` is wrapped by `inTrip()`
(`src/trips/access.js`), which reads the trip and the caller's place on it in one query before
the handler runs. A trip that doesn't exist and a trip the caller isn't on (never was, left, or
was removed) answer the same `404 {"error":"no such trip"}`, so an id tells nobody whether
there is a trip behind it. Someone removed is refused on their next request.

Past the gate a route reads `ctx.data.user = { id, name, onTrip }`; under a trip it also reads
`ctx.data.trip` (the trip's row) and `ctx.data.host` (whether the caller hosts it). Routes
never parse the cookie and never look the trip up themselves. Accounts and sessions are
described under [Accounts](#accounts) below.

Under `/api`, an address nothing answers is `404 {"error":"no such route"}`, and an address
that exists but not for that method is `405 {"error":"method not allowed","allow":[…]}` with
an `Allow` header. Both stand behind the gate, so someone signed out gets the `401` first.

Errors are always `{ "error": "...", ...context }` with a matching status. Timestamps are
**epoch seconds**, everywhere, matching the schema. Integer flags (`all_day`, `done`,
`is_anchor`) come back as the `0`/`1` the column holds — there is no boolean translation
layer to get backwards between D1, IndexedDB, and the view modules. The one decoded field
is `places.tags`, which is stored as a JSON string and returned as an array.

## Which trip?

The one in the address. Everything a trip holds is under `/api/trips/:trip/`: `…/events`,
`…/notes`, `…/packing`, `…/purchases` and the rest. Nothing is resolved from "the account's
trip", because an account can be on several. Exchange rates (`/api/fx`) are the site's, one
table for every trip, so they have no trip in the address; any signed-in account reads them.
The server gets them from a provider (`src/api/fx.js`); `FX_PROVIDER_URL` points it at another
one, and is honoured only on a loopback address: it is for the checks, which stand in a provider
with fixed rates on the same machine. A site never sets it.

**The old addresses** (`/api/trip`, `/api/events`, …, as the app used them when the site held
one trip) still answer for an account that is on exactly one trip, by the same handlers and
the same checks as that trip's new addresses. For an account on no trip or on several they are
no address at all (`404 {"error":"no such route"}`); the server never guesses a trip. This is
`src/old-addresses.js`, and it is temporary: `npm run check:routes` fails once the app's own
code addresses `/api/trips/` while that file still exists, and it never reaches production.

## The rev

A trip has one number, `rev`, that goes up by one in every write to anything in it
(`src/trips/rev.js`). Every answer to a write carries the new `rev`, the snapshot carries the
`rev` it was read at, and every row carries the trip's `rev` as of its own last write.

```
GET /api/trips/:trip/rev  -> { rev, data_rev, seq }
```

`rev` moves on every write. Since the chat (migration 0024) it has two parts a client may read
instead: `data_rev`, the rev of the trip's last write that wasn't the chat's, and `seq`, the chat's
counter, which moves on every message sent, changed or deleted. A client that reads only `rev`
works as before. One that reads all three reads the whole trip (`GET /api/trips/:trip`) only when
`data_rev` moved, and only what the chat changed (`GET …/messages?after=<seq it had>`) when `seq`
did: a chat message never makes every phone read the whole trip (a trip of 300 places is a snapshot of about 430 KB).
The snapshot carries `data_rev` and `chat.seq` beside `rev`.

One row read: a client that holds a snapshot asks this to learn whether anything changed, and
reads the trip again only when the number moved. The bump goes first in the same transaction
as the write, so a write and its rev can't come apart. A write that turns out to change
nothing (a second delete of a row already gone, a refused link) still moves the rev: that
costs a client one snapshot it didn't need, and can never hide a change.

### Live updates: the trip's socket

```
GET /api/trips/:trip/live   (a WebSocket: Upgrade: websocket, from a page of this site)
  server -> {"rev": n}      on opening, the trip's rev now; then each time the trip changes
  client -> "ping"          the only thing a tab may send; answered "pong"
```

Each trip has a room (`src/trips/room.js`, one Durable Object per trip) that every open tab of
the trip connects to. Every write that moves the trip's rev tells it, after the write has landed,
and it tells every tab `{"rev": n}`. **That is all a message ever carries**: never what changed,
never anything of the trip. The tab then reads through the routes exactly as it does without a
socket, so what someone may see is decided in one place.

**Who may open it:** the same people as every route of the trip (someone on it, signed in), from a
page of this site: the `Origin` header must be the site's own. Refused before any socket:
`401 unauthorized` (no session), `404 no such trip` (not on it, or no such trip), `403 cross site`
(another site's page, or no Origin), `426 websocket only` (asked for as a page).

**What a tab does with it** (the rules a client must keep):

1. Hold the `rev` of the snapshot it has. On a message whose `rev` is **newer** than the one
   held, ask `GET …/rev` and read what moved (the section above): the trip when `data_rev` moved,
   the chat's changes when `seq` did. An older or equal `rev` is ignored: the room can send a late
   one out of order.
2. **Read at most once a second**, however many messages arrive. A burst of writes (a phone
   flushing its queue, an AI's batch) sends one message a write; a tab that read on each would
   make every phone on a thirty-person trip read the whole trip that many times. So: read at the
   first newer message, then wait; if newer ones came during the second, read once at its end.
   check:live prints what a burst looks like: twenty writes in a row are twenty messages, and a
   tab keeping this rule reads the trip once or twice.
3. **Fall back to what exists.** No socket (it couldn't open, it was refused, the browser has
   none), or the socket closed: ask `GET /api/trips/:trip/rev` as before (while visible, backing
   off to once a minute), and open the socket again with a backoff (1 s, doubling, at most a
   minute; reset once a socket has stayed open a minute). Nothing is wrong without the socket:
   it only makes changes arrive within seconds instead of within the next poll.
4. **Keep it honest.** Send `"ping"` every 30 seconds; no `"pong"` within 10 seconds, or the
   socket sitting in `CLOSING`, counts as closed (rule 3). (Chrome fires the close event the moment
   the room's close arrives, on a local server too: check:live-browser holds it. Node's own client
   waits for the connection to end, which a local server holds open; the rule covers any client.)
5. When the page is hidden, a tab may close its socket and open it again when shown, asking
   `/rev` once on the way back.

**Close codes** a tab can see, and what to do:

| code | why | then |
| --- | --- | --- |
| 4001 | not on this trip any more (removed, left, account deleted), or signed out on this browser | don't reopen; read the trip (the routes answer as things are now) |
| 4004 | the trip was deleted | don't reopen; read the trip (its 404 says so) |
| 4008 | this person has more open on this trip than it keeps (`LIVE_PER_PERSON`, 6): the oldest closes | reopen only if this tab is still showing the trip, with the backoff |
| 4000 | the socket was open `LIVE_SOCKET_HOURS` (12): open it again (it goes through the session check) | reopen at once |
| 1003 | the tab sent something other than `"ping"` | a bug in the tab |
| other | the network, a deploy | reopen with the backoff |

A trip's room keeps at most `LIVE_PER_TRIP` (180) sockets; past that an open is refused
(`429`) and the tab falls back (rule 3). Limits in `public/js/shared/limits.js`.

---

## The chat: `/api/trips/:trip/messages`

One chat per trip (model §17; `src/api/messages.js`). Everyone on the trip reads and writes it;
someone who joins later reads what came before; someone who leaves, or deletes their account,
keeps their name on what they wrote.

```
GET    …/messages[?before=<seq>|?after=<n>][&about=<kind>:<id>][&limit=1..100]  -> { messages, seq, more }
POST   …/messages {id, body, about?: {kind, id, part?}}  -> { message, rev, seq }  201 (200: sent before)
PATCH  …/messages/:id {body}                             -> { message, rev, seq }  the author only
DELETE …/messages/:id                                    -> { message, rev, seq }  the author, or the host
PUT    …/chat/mute {muted: true|false}                   -> { muted, rev }         the caller's own
```

**Notifications of new messages** (Web Push, `src/push/`; the app's side `public/js/push.js`, the
worker's `public/js/push-sw.js`; tap: Chat → the bell):

```
GET    /api/account/push                      -> { push: true, key }   the VAPID public key a page subscribes
                                                 with; 503 "push off" where the site has no keys
PUT    /api/account/push {endpoint, keys: {p256dh, auth}, words?}
                                              -> { ok, words }         this browser's subscription, kept for
                                                 the account (a browser another account had moves to this one)
DELETE /api/account/push {endpoint}           -> { ok, deleted }       this browser no longer told
```

- **Who is told:** a new message (never one sent again) goes to every phone of everyone else on the
  trip, but those who muted its chat (`…/chat/mute`) or left it. After the answer, six push services
  at a time; a subscription its service says has ended (404, 410) goes, and so does one that has
  failed ten times in a row.
- **What a phone shows:** "<who> wrote in <trip>", and "Open the chat to read it."; the words only on
  a phone whose `words` is on (the person's choice, per phone). One notification per trip (a newer
  one replaces it), with "Mute this trip" (the worker sends `…/chat/mute {muted: true}`); a tap opens
  the trip's chat. The body is Declarative Web Push's JSON: `{ web_push: 8030, notification: { title,
  body, navigate, lang, dir }, wgp: { kind: "chat", trip, seq, tag, mute } }`.
- **Only a push service's address** is taken as an endpoint (FCM, Mozilla's, Apple's, Windows'); keys
  are 65 and 16 bytes. Signing out deletes this browser's row first; signing out everywhere and
  deleting the account delete all of the account's.
- **The keys:** `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (a JWK), made by `tools/vapid-keys.mjs`;
  `VAPID_SUBJECT` defaults to `PUBLIC_ORIGIN`. Without them the chat works and nothing is sent.

A message:

```
{ id, seq, touched, author, author_name, body, about: null | { kind, id, part?, name },
  created_at, edited_at: null | seconds, deleted: null | { at, by }, rev }
```

- **`id` is the sender's** (lowercase letters, digits and hyphens), made when the message is
  written, so one waiting in the phone's queue and sent twice lands once (the second answer is
  200 with the same message). Show it as waiting until the answer comes.
- **Order is `seq`**, the server's, never the phone's clock. `touched` is the chat's counter at the
  message's last change.
- **No cursor**: the newest window (50, or `limit`), oldest first; `more` says there are older ones.
  **`before=<seq>`**: the window before that message, to page back. **`after=<n>`**: every message
  the chat changed after its counter was `n` (sent, edited or deleted since), in `seq` order; merge
  them by `id`. When `more`, ask again from the last one's `touched`.
- **`about`** is one thing in the trip: `event`, `place` or `purchase` (a purchase, not a payment),
  by id. `part: "before"` (events only) means the empty time before it, what a "gap" note was.
  `name` is the thing's name when the message was written, kept if the thing is deleted later:
  show it, and open the thing only while it's there. `?about=event:<id>` reads only those.
- **The snapshot** carries `chat: { seq, about: { event: { <id>: n }, place: {…}, purchase: {…} },
  muted }`: how many (not deleted) messages are about each thing, for the Itinerary's count without
  reading the chat. Keep it current from the messages read with `after`.
- **Edited** (`edited_at`) and **deleted** (`deleted`, the words gone, who and when kept) messages
  stay in their place: show "edited", and a line saying one was deleted.
- **Muted**: the person's own choice for this trip's chat. Nothing is sent yet (push notifications
  are a piece of their own); it is kept so the setting exists.
- Limits, each refused in words (`reason`): 1 to 4,000 characters (`MESSAGE_MAX`); 30 a minute a
  person (`MESSAGES_PER_MINUTE`, 429); 50,000 a trip (`MESSAGES_PER_TRIP_MAX`, 409: nothing is
  deleted to make room); a read answers at most 100 (`MESSAGES_PAGE_MAX`).

## Trips

`src/trips/`. The limits named here are in `public/js/shared/limits.js`, one copy for the app
and the server.

```
GET   /api/trips                 -> { trips: [ { …trip, role: "host"|"member", members: <how many are on it>, host: { id, name }, offered_to_me, chat: { from_others } } ] }
POST  /api/trips  { name, default_tz, starts_on?, ends_on?, currencies?, interests?, id? }
                                 -> 201 { trip, rev }      the maker is its host
PATCH /api/trips/:trip  { name?, starts_on?, ends_on?, default_tz?, currencies?, interests? }
                                 -> { trip, rev }          any member
```

A `trip` is `{ id, name, starts_on, ends_on, default_tz, currencies, interests, host_id,
created_by, collage_seed, collage_version, created_at, updated_at, rev }`. `starts_on` and `ends_on` are
`YYYY-MM-DD`, both or neither: a trip's dates may not be known yet, and then both are `null`.
`currencies` is the trip's own list in its order, the first its main one (the whole trip's
top-level `currencies` is a different thing: every currency its people use, this list first).
`interests` is what the group cares about, in their words (at most 4,000 characters; the
guide `trip-setup.md` says what it holds). `GET /api/trips` lists the trips the account is on
now, soonest first, undated ones last. Each one's `chat.from_others` is the seq of the newest
message someone else wrote on it and didn't delete (0 when none): Your trips compares it with
where reading stopped on the phone to say "New messages".

A new trip starts with one packing list, `leaving-home` ("Leaving home"), with the bags
`main-bag`, `day-bag` and `on-me` (see [Packing](#packing)).

**Dates and events.** An event starts on a day of its trip, in its own zone. So a `PATCH`
whose dates would leave an event outside them is refused, `409 {"error":"events outside",
"first_event_day":"…","last_event_day":"…","reason":"…"}`, and so is clearing the dates while
the trip has events. Moving a whole trip by some days is a later feature.

Any account can make a trip: `name` is 1 to 80 characters, `default_tz` an IANA zone,
`currencies` at most 12 three-letter codes. An account hosts at most 20 trips at a time
(`409 {"error":"too many trips","max":20}`). `id` is for a client that makes the id itself, so
a create sent twice lands on the trip it already made (`200` with that trip); an id someone
else's trip has is `409 {"error":"id already exists"}`. The refusals: `400` `bad id`, `bad
name`, `bad default_tz`, `bad dates`, `bad currencies`; a `PATCH` with none of its keys is
`400 {"error":"nothing to patch"}`.

**Deleting a trip**, host only, needs its name typed:

```
DELETE /api/trips/:trip { confirm: "<the trip's name>" } -> { ok, deleted, files }
```

The name is compared after trimming and in Unicode NFC, otherwise exactly. Without it, or with
something else, nothing goes and the answer is `400 {"error":"confirm","need":"<the name>",
"reason":…,"goes":{ members, photos, videos, bytes, boards, purchases, payments, someone_owes
}}`, so the app's dialog can say truthfully what would go. With it, one write removes every
row the trip has and queues every file for the drain (`files` is how many); what the trip held
stops counting at once. Afterwards, asking for the trip answers exactly as a trip you aren't on
(`404 {"error":"no such trip"}`): no tombstone. A trip also goes with its host's account when
nobody else is on it (see [deleting an account](#signing-out-and-deleting-an-account)).

### The people on a trip

```
GET    /api/trips/:trip/members          -> { members }               everyone who is or has been on it
GET    /api/trips/:trip/people           -> { trip, you: { id, host }, members, links, handover, storage, rev }   trip.cover: the snapshot's shape, or null
DELETE /api/trips/:trip/members/:user    -> { ok, left, rev }         yourself: leave. Someone else: host only
POST   /api/trips/:trip/members/:user/rejoin  -> 201 { url, expires_at }  host only: a guest's way back
POST   /api/trips/:trip/host  { to }     -> 201 { handover, rev }     host only: offer the trip to a member
DELETE /api/trips/:trip/host             -> { ok, withdrawn, rev }    host only: take the offer back
POST   /api/trips/:trip/host/accept      -> { trip, rev }             the member offered it: they host it now
POST   /api/trips/:trip/host/decline     -> { ok, rev }               the member offered it
```

`GET people` is what the page of a trip's people and settings shows, in one read and without
the trip's plan: `members` and `links` as their own routes answer them, `handover` and `storage`
as the snapshot does, and `you.host` whether the caller hosts it.

A member is `{ id, name, role: "host"|"member", joined_at, left_at, deleted, guest, note_color,
initials, rev }` (`guest`: on the trip by its link with only a name, below). A trip has exactly one host, the account `trip.host_id` names: the one who
can remove people, revoke a link, offer the trip to someone else, and delete it.

Leaving and being removed are almost the same change: the row stays, with `left_at` set. What
the person wrote and paid stays on the trip under their name, because the money other people
owe is made of it; they can't read or write the trip from their next request. `left` is
`false` when they had already gone.

**Removed is not left.** Someone who left on their own comes back by any link that still
works. Someone the host removed comes back only by a link made after the removal: to them, a
link made before it answers `404 {"error":"no such link"}`, like any link that doesn't work, so
a link they already hold doesn't undo the host's choice. "After" is the trip's rev, not the
clock (`trip_members.removed_rev` against `trip_links.created_rev`, migration 0018): a removal
and a link made in the same second still have an order.

| asked | answered |
|---|---|
| remove someone else, not the host | `403 {"error":"forbidden","reason":"host only"}` |
| someone who was never on the trip | `404 {"error":"no such member"}` |
| the host leaving | `409 {"error":"the host can't leave"}`: offer it to someone first, or delete the trip |
| offer it to nobody, or to yourself | `400 {"error":"bad to"}` |
| offer it to someone not on the trip now | `404 {"error":"no such member"}` |
| accept or decline what isn't offered to you | `404 {"error":"no offer"}` |
| accept when you host 20 already | `409 {"error":"too many trips"}` |
| accept a trip that doesn't fit what you may hold | `413 {"error":"storage full","needed":…,"used":…,"limit":…,"reason":…}` |

**Handing a trip over is an offer the other person accepts.** Hosting costs something (the
trip's storage counts against the host, and a host can't leave or delete their account while
others are on the trip), so nobody is made a host without saying yes. One offer a trip at a
time: a new one replaces it, the host can take it back, and it ends if that member leaves or is
removed. Nothing changes until it is accepted; accepting checks the trip fits what the new host
may hold (everything they hold, uploads under way included, plus this trip). The snapshot
carries `handover: { to, offered_by, offered_at, rev } | null`, and `GET /api/trips` marks a
trip offered to the caller with `offered_to_me: { offered_at } | null`, so the home screen can
show it without opening the trip.

### Links, and joining

```
POST   /api/trips/:trip/links  { days?, uses? }  -> 201 { link, rev }       any member
GET    /api/trips/:trip/links                    -> { links }               any member; no codes
DELETE /api/trips/:trip/links/:id                -> { ok, revoked, rev }    host only

GET    /api/join/:code   -> { trip: { name, starts_on, ends_on }, host: { name } }     anyone
POST   /api/join/:code   -> { trip, joined, rev, guest }                               signed in, or
                            { name } signed out: a guest (below)
```

People get onto a trip one way: a link. A link is a code with an end: it lasts `days` (7
unless said, at most 30), puts at most `uses` people on the trip (10 unless said, at most 50),
and the host can revoke it. A trip has at most 20 links in use at once (`409 {"error":"too
many links"}`); `400` `bad days` and `bad uses` say what they take.

`link` is `{ id, created_by, created_at, expires_at, max_uses, uses, revoked_at, live, rev }`.
The answer to `POST` also carries `code` and `url` (`/join/<code>`), **once**: only a hash of
the code is kept, so a list of links, the database or a backup of it can't be turned into a
way in.

`GET /api/join/:code` is what the join page (`public/join.html`, served at `/join/<code>`)
shows before anyone is on the trip: its name, its dates, who hosts it, and nothing else.
`POST` puts the signed-in account on the trip (`joined: true`, one use of the link); someone
already on it gets `joined: false` and the link is not used. Someone who left comes back the
same way, onto the row they had; someone who was removed, only by a link made after that.

**A link that has run out, been used up or been revoked answers exactly as a code that never
existed:** `404 {"error":"no such link"}`, on both routes, so nobody learns from the answer
that a link once worked. A trip with 30 people on it is `409 {"error":"trip is full","max":30}`,
and a join refused that way costs the link nothing.

**Joining as a guest (model §22).** Signed out, `POST` with `{ name }` makes a guest: a person
with that name (trimmed, 1 to 40 characters; else `400 {"error":"name"}`) who signs in nowhere
but on this phone, with the session this answer sets (180 days from its last use, as anyone's),
and puts them on the trip, all in the one write: a link that ended or a trip that filled makes
nobody. The answer is `guest: true`; signed in, `guest` says whether the caller is one. One
phone's guest is one person on every trip it joins: signed in as a guest, joining another
trip is as that guest. A guest is a member like anyone, except that what needs an account is
refused in words (`403 {"error":"guest","reason"}`): making a trip, being offered or accepting a
trip to host, an email on the account, a plan, and connecting an AI app (a page saying so).
Adding a passkey (`POST /api/auth/passkeys/…`) or Google or GitHub (the account page's "Add")
makes the same person an account, in the same write. Guests made are limited to 20 an hour
from one address and 30 an hour by one link (`429`, a reason, `Retry-After`); while sign-ups
are paused, joining with a name is `503 {"error":"signups paused"}`.

### Areas

```
GET    /api/trips/:trip/areas                 -> { areas }
PUT    /api/trips/:trip/areas  { areas: [...] } -> { areas, rev }        adds each, or changes the one with that id
DELETE /api/trips/:trip/areas/:id             -> { ok, deleted, rev }
DELETE /api/trips/:trip/areas  { ids: [...] }  -> { ok, deleted, rev }
```

An area is a named part of the trip: `{ id, name, parent, west, south, east, north, sort,
rev }`. A top-level area with bounds is a region the map covers ("Lisbon"); a child
(`parent` is a top-level area's id) is a neighborhood under it. Any member writes them.

- A new area's id is the writer's choice: lowercase letters, digits and hyphens, at most 64,
  unique within the trip (`public/js/shared/trip-rules.js`). Sending an id that exists
  changes that area, and only in the fields sent.
- Two levels at most: a child's parent is a top-level area of the same trip, and an area with
  children can't go under another.
- Bounds are all four edges or none, in degrees: `south` below `north`, both from -90 to 90;
  `west` and `east` from -180 to 180 and not equal. `west` greater than `east` is a box that
  crosses the 180° line (west 177, east -178), and a place at 179.5 or -179.5 is inside it.
- A place in an area lies inside the bounds of its area or of that area's parent, whichever
  have bounds. New bounds that would leave a place it holds outside are refused,
  `409 {"error":"places outside","places":[{id, why}]}`.
- An area that places point at, or that has areas under it, can't be removed:
  `409 {"error":"area in use","places":[…],"areas":[…]}`. Removed together with its children,
  it can.
- A `PUT` is all or nothing, at most 200 rows and 200 areas on a trip. One row that can't be
  written refuses the call: `400 {"error":"bad areas","rows":[{index, id, error}]}`, each
  `error` a sentence saying what was wrong and what is allowed.

---

## A field a write doesn't take: said, not swallowed

Every write of a trip's rows (events, places, areas, notes, purchases, packing items, lists,
starters, ticks, messages, the trip itself) answers, when it succeeds, with
`ignored: ["zz", "events[1].zz", "shares[0].zz", "about.zz"]` naming each field it was sent and
doesn't take, and does the write. No `ignored` means nothing was left out. A field whose meaning
moved is refused instead, `400 {error: "field moved", fields, reason}` saying where it went:
on a packing item, `done` (a tick of its own now: `PUT …/packing/ticks`) and `section` (its
`bags` now). The lists are `src/api/ignored.js`; `check:routes` fails on a write of a trip's rows
that doesn't say, and `check:trips` (part noSilentYes) asks each one.

## Permission rules, as enforced

| Action | Rule |
|---|---|
| edit / delete an **event**, a **place**, an **area** | any member (model §4: the author rule on events is gone) |
| the trip's details, its **packing lists**, bags and **starters** | any member |
| add a **note** | any member, on any event |
| read / write / tick a **packing item**, and its bags | `packing_items.owner` is the session user or the literal `'group'` — else `403` |
| remove a member, revoke a link, hand the trip over | the trip's host — else `403 {"error":"forbidden","reason":"host only"}` |
| everything else of a trip | anyone on it now; anyone else gets `404 {"error":"no such trip"}` |

Hosting a trip is not a key to other people's packing lists: a host reading another
member's list gets the same `403` anyone else does. Nothing is site-wide: no account can do
anything in a trip it isn't on.

### Why packing is scoped by `owner` and not by `created_by`

On the group list four people are packing one duffel, so whoever ticks "4-person tent" is
usually not whoever typed it. Scoping writes by author would make the shared list
unusable. Personal lists are unaffected: nothing but you can create a row you own. A group
item's tick is the group's: one tick, whoever made it.

---

## Idempotency, because four days have no signal

`POST /api/trips/:trip/events`, `/api/trips/:trip/notes` and `/api/trips/:trip/packing` all accept a **client-supplied `id`**
(omit it and the server mints a UUID). This is what makes a queued offline write safe to
replay — the flush happens over a cell tower that drops responses, and a server-minted id
would create a duplicate on every retry.

- An **event's** id (and a place's and an area's, through their `PUT`s) is unique within the
  trip and, when new, lowercase letters, digits and hyphens, at most 64. A `POST` whose id is
  an event of the trip already answers `200` with that event, unchanged: the replay succeeded.
  Any member may change it with `PATCH`.
- A **note's** and a **packing item's** id (`[A-Za-z0-9_.-]{1,64}`) is one row on the whole
  site: id free → `201`; taken by you → `200` with the existing row; taken by anyone else →
  `409 {"error":"id already exists"}`. Never an overwrite.
- A **memory's** id is the same: one row on the whole site; sent again by its poster → `200` with
  the memory the first one made (and `not_taken`, when it had one), before anything about its
  photographs is checked, so a post whose answer was lost is never refused for photographs it
  already holds.
- An **upload** can name its own id (`media/begin {…, id}`, the same characters as an event's).
  Sent again with it while its upload is under way → `200` with the same `key` and `uploadId`,
  and its bytes held once; the same id with another file (`bytes`, `mime`, `name` or `kind`) →
  `409 "id already used"`; one that finished, lapsed or was cancelled begins afresh.
  `media/finish` sent again after it stored the file answers what it answered the first time.
- **A known edge: joining as a guest.** If the answer to a signed-out `POST /api/join/:code {name}`
  is lost, its session cookie is lost with it, and the join sent again arrives signed out: it
  makes a second guest of that name and takes another of the link's uses. Nothing here sends it
  again by itself (the join page sends it once, when it is pressed). It is left so on purpose:
  handing the first guest's session to whoever repeats the join would make the repeat a way in.
  The host removes the extra guest from the trip's people (`DELETE …/members/:user`).

`DELETE` answers `200 {"ok":true,"id":…,"deleted":false}` when the row is already gone.
A `404` there would wedge the head of `store.js`'s flush queue with nothing behind it able
to drain.

---

## GET `/api/me` · PATCH `/api/me` · DELETE `/api/me`

```
GET    /api/me                        -> { id, name, note_color, initials, native_currency, tab_layout, units, guest, note_colors }
PATCH  /api/me { name?, note_color?, initials?, native_currency?, tab_layout?, units? }  -> { me: { … the same … } }
DELETE /api/me { confirm: "delete" }  -> { ok: true }      deletes the account; see Accounts
```

It says nothing about trips: which ones the account is on is `GET /api/trips`. `note_colors` is the palette a person
picks their own color from, `[{ hex, name }]`, the same table a trip's snapshot carries (GET only; PATCH answers without it). `units` is
`metric` or `imperial`, or `null` until the person picks (the app goes by the phone's locale
until then); only its owner sees it, so changing it moves no trip's rev. `name` is what
the people on your trips see: 1 to 40 characters, trimmed, inner runs of spaces made one; two
accounts may have the same name; anything else is `400 {"error":"bad name"}`.

A name, a colour, initials and a home currency show on the roster of every trip the account
is on, so changing one is a write to each of those trips: each trip's `rev` goes up.

**The route has no id in it, and that is the whole security model.** `PATCH /api/me` writes
to exactly one row — the one the signed session cookie names. There is no `/api/me/:id` and
there must never be: the feature is "let a person change their own color", and a
route that took a user id would be a route that changes somebody else's. Nothing in the body
can name a different user, so there is no ownership check that can be got wrong.

`note_color` is checked against `NOTE_COLORS` (`src/api/trips/:trip.js`) and refused with
`400 {"error":"bad color"}` otherwise — it is never stored as sent. The ink drawn on a
person's face is *computed* from its hue by `inkOn()`, so an arbitrary hex is a set of initials
nobody can read, on everyone else's screen.

**Two people may end up on the same hue, on purpose.** `ensureNoteColors()` only ever hands
out distinct colours to users who have *none*; it does not police a choice somebody made
deliberately, and refusing "amber, because your housemate got there first" would be a
control that sometimes silently does nothing. The **initials** on their face are what name
the person — that has always been the rule the palette is written against.

`note_color` is denormalised onto note and memory rows when they are read, so a change shows
up everywhere on the next `GET /api/trips/:trip`. `store.js` applies it optimistically first (to the
roster row and to every note this user has already written), which is what makes it instant
and what makes it work offline.

---

## Accounts

`src/accounts/`. Anyone can make an account; there is no invite code. An account signs in with a
passkey, with Google or with GitHub, and can hold several of each. Display names are not unique
and are never how an account is found. Every answer here carries `Cache-Control: no-store`.

**A session** is a row in `sessions` and a cookie, `wgp_session`, holding a random token; the
table holds only the token's sha256. It lasts 180 days from its last use (it is moved forward
again once a day of that has been used, so at most one write a day) and ends when it is signed
out, when the account signs out everywhere, or when the account is deleted. Cookies are
`HttpOnly; SameSite=Lax; Path=/`, and `Secure` everywhere but a local `http://localhost` copy.

**Who is signed in, for the phone.** Beside the session cookie the server sets `wgp_who`, the
signed-in account's id and nothing else, which the page CAN read (no `HttpOnly`; otherwise the
session cookie's attributes and life). The app keeps trips on the phone and must know, before
it shows one, whether they are this person's: it compares this id with the one stored with
them and clears the phone when they differ. Every way of signing in sets it (a passkey, Google,
GitHub, the email code, the operator's link, the carried-over old cookie); every way of
signing out clears it, with the session (signing out, signing out everywhere, deleting the
account). A signed-in request that arrives without it, or with another account's, is sent it
again; a request whose session cookie finds no session is told to clear both. **The server
never trusts it**: it signs nobody in and decides nothing; the gate reads it only to know
whether to send it.

**Errors** are one short word or two, never a sentence; `public/js/auth.js` has the words a
person reads for each. The ones several routes share: `name` (not a usable display name),
`expired` (the challenge, link or waiting sign-in ran out or was already used), `not verified`
(the passkey's answer didn't check out), `too many` (429, with `Retry-After`), `signups paused`
(503), `cross site` (403: the request must carry this site's `Origin`).

### What the site offers

```
GET /api/auth/config  -> { name, origin, providers: { google, github }, signups: "open" | "paused", email }
```

Public. `origin` is the site's own address (`PUBLIC_ORIGIN`), the one the app prints for someone
else to use (an AI app's address, a join link, a shared board: `public/js/site.js`), whichever of
the site's addresses the page is at. `providers` says which of Google and GitHub are set up,
`signups` whether new accounts can be made (`SIGNUPS` in `wrangler.jsonc`), `email` whether
account email is on.

### The site's second address (www.)

`ALSO_ORIGINS` (`wrangler.jsonc`, comma-separated) names other addresses that serve the same site
in full: `https://www.wegoplace.com`, for a phone whose app was added there. At each:

- a session is the address's own (cookies carry no `Domain`); a passkey works at every address
  (`RP_ID` is the domain they share), each answer held to the page it was made on;
- a write, a passkey's answer and the live socket must come from a page at THAT address: a request
  that crosses (a page at one address to the other) is `403 cross site`, as from another site;
- Google and GitHub come back only to `PUBLIC_ORIGIN`, so `POST /login/<provider>` at another
  address answers `303` to `PUBLIC_ORIGIN/login?error=elsewhere&with=<provider>`, keeping nothing;
- `/mcp`, `/authorize`, `/token`, `/register` and `/.well-known/oauth-*` answer `421`
  `{ error: "misdirected", reason, use }`: an app is told `PUBLIC_ORIGIN/mcp` in words (a client
  holds the resource to the address it was given, so a redirect couldn't work);
- every address the server prints for someone else (a picture's upload link) is `PUBLIC_ORIGIN`'s.

Every page's first script (`public/js/www.js`) sends a new visitor at a `www.` address to the
same page without it, before anything is kept there; it stays for the installed app (display
mode, `navigator.standalone`), a service worker already in control, or anything in that
address's localStorage. check:www and check:www-browser hold all of it.

### Passkeys

```
POST /api/auth/register/options { name }           -> creation options       sets the challenge cookie
POST /api/auth/register/verify  <the attestation>  -> { ok, user }           makes the account, signs in
POST /api/auth/login/options    { username? }      -> request options
POST /api/auth/login/verify     <the assertion>    -> { ok, user }           signs in
POST /api/auth/passkeys/options {}                 -> creation options       signed in: another passkey
POST /api/auth/passkeys/verify  <the attestation>  -> { ok }
```

The body of a `verify` is the credential itself as WebAuthn serializes it (`id`, `rawId`,
`type`, `response`, `clientExtensionResults`), not wrapped in anything. A challenge waits five
minutes in `challenges` under the `wgp_chal` cookie and is taken once; asking for another
replaces it. Nothing is written for a sign-up until its passkey verifies.

Sign-in sends no list of passkeys: the device offers the ones it holds for this site, and the
account is found by the passkey's id. `username` is only for an account made before open
sign-up (it is the name that account typed to sign in, kept in `users.username`): the options
then name that account's passkeys, for a device that can't find one by itself; an unknown one
is `404 {"error":"unknown username"}`. A passkey this site doesn't know is
`401 {"error":"unknown passkey"}`; any other failed check is `401 {"error":"not verified"}`,
including a signature counter that went backwards. A passkey that is already on an account is
`409 {"error":"already registered"}`. The six `options` routes are limited together with the
provider starts: 60 a minute from one connection, then `429`.

### Google and GitHub

```
POST /login/<provider>            form: next, intent     -> 303 to the provider
GET  /login/<provider>/callback   ?code&state            -> 303 back into the site
GET  /api/auth/pending            -> { providers, labels, name, next } | 404 { error: "expired" }
POST /api/auth/pending/create     { name }  -> { ok, user, next }     a new account with what is waiting
POST /api/auth/pending/attach     (signed in) -> { added, next }      what is waiting, added to this account
```

`<provider>` is `google` or `github`. Each is offered once its client id is in `wrangler.jsonc`
and its secret is set; the redirect address to give the provider is
`<PUBLIC_ORIGIN>/login/<provider>/callback`. The start is a plain form post from this site's
own pages (PKCE, a `state`, and for Google a `nonce`, kept ten minutes under `wgp_oauth`).
What is kept of a provider's answer is its own id for the person (Google's `sub`, GitHub's
numeric id) and a label to tell two apart. No email address is read or kept, and nothing is
ever joined by email.

`intent` decides what coming back means:

- `signin` (the default): a sign-in an account already has signs it in and goes to `next`. One
  nobody has used waits fifteen minutes under `wgp_pending`, and the browser is sent to
  `/login/new`, where the person either makes an account with it (`pending/create`) or signs in
  to the account they already have and adds it (`pending/attach`). Nothing is made until then.
- `attach`: from `/login/new`, signing in with the other provider to reach an existing account;
  what was waiting is added to it.
- `link`: from the account page, signed in: adds the sign-in to this account and goes back to
  `/account?signin=<result>&with=<provider>`.

A trip that didn't work comes back with a short code instead: `/login?error=<code>&with=<provider>`
(or `/login/new?…`, or `/account?signin=…`), where the code is one of `cancelled`, `expired`,
`provider`, `busy`, `unavailable`, `signed-out`, `paused`, `unknown`, and on the account page
also `added`, `already`, `taken`. `next` is kept only if it is a path on this site.

### The ways an account signs in

```
GET    /api/auth/ways                        -> { passkeys: [{ id, synced, createdAt, lastUsedAt }],
                                                  identities: [{ provider, subject, label, createdAt, lastUsedAt }],
                                                  username, providers, guest }
DELETE /api/auth/ways/passkey/<id>           -> { ok }
DELETE /api/auth/ways/<provider>/<subject>   -> { ok }
```

`synced` is whether the passkey lives in a synced store (so it is on the person's other devices
too); `null` when that wasn't recorded. Removing one that isn't this account's is
`404 {"error":"not found"}`. An account always keeps one way in: removing the last is
`400 {"error":"last way"}`, checked inside the delete itself.

### Email, for getting back in

```
GET    /api/account/email           -> { offered, email, verifiedAt }
POST   /api/account/email           { email }     -> { id, sentTo }       a code is on its way
POST   /api/account/email/confirm   { id, code }  -> { email, verifiedAt }
DELETE /api/account/email           -> { email: null }
POST   /api/auth/recover            { email }     -> { id }               public, from this site's pages
POST   /api/auth/recover/confirm    { id, code }  -> { ok, user }         signs in
```

An address on an account is for one thing: a code to get back in when every way to sign in is
lost. It is never a way to sign in by itself, never joins two accounts, and is shown to nobody
else. One address per account, an address on one account only (`409 {"error":"email taken"}`;
one that isn't an address is `400 {"error":"bad email"}`),
and it is kept only once its code comes back. A code is 6 digits, kept only as a hash, good
for 15 minutes and 5 tries (`400 {"error":"wrong code","left":n}`, then `code used up`), used
once, and at most 5 are sent an hour per account or address (`429 {"error":"too many codes"}`).
`recover` answers the same whether or not the address is on an account, and sends after it has
answered. Email is sent by Cloudflare's Email Sending (the `EMAIL` binding and `EMAIL_FROM`); a
site without both answers `404 {"error":"no email"}` on all but the `GET`, and its pages don't
offer any of this.

### A one-use link from the operator

```
POST /api/auth/link { token }  -> { ok, user }   signs in      400 { error: "expired" }
```

The same kind of link, made by a trip's host for a guest on a new phone
(`POST /api/trips/:trip/members/:user/rejoin`): `url` is `/login/link/<token>`, one use, for
two hours, 10 an hour a host. Only for a guest (`409 {"error":"not a guest"}`: an account signs
in with its own passkey or sign-in) and only while every trip that guest is on is one this host
hosts (`409 {"error":"on another trip"}`, naming no trip): a host's link must never open
another host's trip. Both are checked again when the link is used, and using it signs the
guest's other phones out.

For someone who has lost every way in and has no email on the account, or whose passkey won't
sign them in. `node tools/signin-link.mjs --trip <id> --name "<their name>" --remote
--production-database <the D1 database_name>` (or `--account <id>` for one account) files the
link's sha256 in `signin_links` itself and prints the link, at the Worker's own `PUBLIC_ORIGIN`,
and when it stops working (two hours unless `--hours` says). `--remote` without the database
named refuses and writes nothing; `--local --persist-to <dir>` files it in a local database. The
link opens the sign-in page at `/login/link/<token>`, which uses nothing until its button is
pressed. It works once, until it expires (`check:signin-link`).

### The plan given by the operator

`node tools/plan-grant.mjs --user <account id> --reason "<why>" <where>` gives one account the plan with nothing
charged and no Stripe behind it (`plan_grants`, 0046): the plan's room, and the assistant on the trips it hosts for
everyone on them once the assistant's key and model are set, whether or not the site sells the plan or has the
assistant switched on. `--revoke` takes it back, `--show` says whether it holds; `<where>` is `--remote
--production-database <name>` or `--local --persist-to <dir>`, as for the sign-in link. It prints one line, never the
account's id. `GET /api/account/plan` then answers that account with `plan.status: "comp"` (no interval, renewal or end)
and `offered` saying whether the site sells the plan; Checkout and the Portal refuse it (`409`). A live subscription of
the same account comes first: whoever pays sees what they pay for, with the Portal to cancel it. The account's export
carries the grant (`plan_grant: { granted_at, reason }`) and deleting the account deletes it (`check:plan-grant`).

### Signing out, and deleting an account

```
POST   /api/auth/logout        -> { ok }   this browser; public, so a dead session can still be cleared
POST   /api/auth/logout/all    -> { ok }   every session of the account
DELETE /api/me { confirm: "delete" }  -> { ok }      400 { error: "confirm" } · 409 { error: "host" }
```

Deleting an account removes its passkeys, provider sign-ins, sessions, email and settings, its
own packing lists, and its memories with their stored files and the boards it shared from them.
What it added to the trip's plan stays (events, places, notes), and so does the money it logged:
its row in `users` is kept with the name it had and `deleted_at` set, because other people's
balances are made of it, and it stays on the trip's roster under that name. It can't sign in
again. A trip it hosts that nobody else is on is deleted with it, whole. A trip it hosts that other
people are on stops the deletion: `409 {"error":"host","trips":[{ id, name, members }, …]}` names each
one, with a `reason` naming both ways out: offer it to one of them, and once they accept the
account can be deleted; or delete the trip.
On other people's trips it counts as having left.

### The cookie from before

Before this, a sign-in was a signed cookie (`s2`) with nothing kept on the server. A browser
still holding one is given a session in its place the first time it asks
(`src/accounts/old-cookie.js`, which needs `AUTH_SECRET`), but only for an account that existed
when migration `0016_accounts.sql` ran (`old_cookie_accounts`); signing out everywhere takes an
account off that list. The last such cookie runs out 180 days after the migration.

---

## GET `/api/trips/:trip`

Any member. **The whole trip in one response** — this is the only read `store.js` makes, and
the per-collection routes below exist for curl and debugging.

```json
{ "trip":    { "id":"…", "name":"Lisbon in spring", "starts_on":"2031-05-01", "ends_on":"2031-05-09",
               "default_tz":"Europe/Lisbon", "currencies":["EUR"], "interests":"…", "host_id":"u-…",
               "created_by":"u-…", "collage_seed":"…", "collage_version":1,
               "created_at":1787117809, "updated_at":1787117809, "rev":41 },
  "members": [ { "id":"u-…", "name":"Mira", "role":"host", "joined_at":1787117809, "left_at":null,
                 "deleted":false, "note_color":"#0072B2", "initials":"MI", "rev":1 } ],
  "areas":   [ … ],     // as GET …/areas
  "places":  [ … ],     // as GET …/places
  "events":  [ … ],     // as GET …/events
  "notes":   [ … ],     // as GET …/notes — every note on the trip

  "packing":            [ … ],   // the items: yours + the group's, never anyone else's
  "packing_lists":      [ … ],   // the trip's lists, each with its bags in order
  "packing_placements": [ … ],   // { item_id, list_key, bag_key, rev }, for those items
  "packing_ticks":      [ … ],   // { item_id, list_key, day, created_by, created_at, rev }, for those items
  "packing_starters":   [ … ],   // the trip's suggested items

  "purchases":  [ … ],           // as GET …/purchases: purchases and payments
  "currencies": [ "PEN", "USD" ],
  "fx":         { … },           // as GET /api/fx

  "note_colors": [ { "hex":"#0072B2", "name":"Deep blue" },
                   { "hex":"#E69F00", "name":"Amber" },
                   { "hex":"#CC79A7", "name":"Mauve" },
                   { "hex":"#56B4E9", "name":"Sky" } ],
  "rev": 41 }
```

`rev` is the trip's rev as of this read (see [The rev](#the-rev)). `members` holds everyone
who is or has been on the trip: someone with `left_at` set has left or was removed, and
`deleted` marks an account that no longer exists; both stay because what they wrote and paid
is still on the trip under their name.

`note_colors` is the **palette**, not anybody's colour — the table `PATCH /api/me` validates
against, shipped so the pickers (Your color, in More and on the account page) can draw
themselves without holding a second copy of it. It rides the snapshot rather than taking a
route of its own for the same reason everything else does: the phone gets one request in
before the signal goes, and a picker that only works on wifi is a picker that does not work
on a trip. Every entry carries its **name**, because every picker must print the word
beside the swatch: color is never the only signal.

The `packing_*` keys are what [Packing](#packing) describes; `packing` is the item rows.

`note_color` (the person's color) and `initials` on a member are what the app draws their face
with, in Split, Chat and wherever people appear, and both are computed server-side so there is
one spelling of the rule.

**One bootstrap**, write-only-when-missing:

- **`note_color`** is assigned to any member that has none, when a trip is made and when
  someone joins it. FNV-1a over the user id picks a starting hue and the loop walks forward
  past any hue somebody already holds, then the answer is persisted, so it never changes
  again. The palette is four hues that survive **deuteranopia** — `#0072B2` deep blue,
  `#E69F00` amber, `#CC79A7` mauve, `#56B4E9` sky. There is no red and no green in it, and the
  four are separated by lightness as well as hue. The initials on every face are what
  actually name the person.
- **A deleted account has `note_color: null`, always** (`deleted: true` on its member row; it
  keeps its name and nothing else). It is never given a colour again, so the app draws its notes
  with its fallback. Today the colour is assigned when the snapshot is read and a member has
  none; that read writes, and moves the trip's `rev`, only then.

One snapshot rather than five requests, because the client hydrates IndexedDB from it and
then runs for days without signal: there has to be exactly one request that either succeeded
or did not.

Reading a trip puts nobody on it: an account that isn't on the trip gets
`404 {"error":"no such trip"}` here, as from every route of the trip.

## Filling a trip from a seed file: `tools/seed-trip.mjs`

There is no import route. A trip is filled through the routes that write each thing (areas,
places, events, packing lists, starters), which hold every row to the same checks a person's
or an AI's write is held to. `tools/seed-trip.mjs` puts a seed file through them, as the
trip's host:

```
node tools/seed-trip.mjs seed/demo-trip.json --base http://localhost:8788 --session <wgp_session value>
```

A harness imports `seedTrip(seed, send)` and passes its own request function. The tool reads
a seed's places strictly and prints what it changed: a subkind in another case or with spaces
or hyphens is respelled (`spelledSubkind`), any other word off the list refuses the seed; hours
in another spelling are written in the one format when every word of them reads (`readOldHours`),
otherwise they move to the top of `notes`; tags are lowercased and capped at six; with no
`areas`, each area code becomes a top-level area. (A database's own migration keeps every tag;
this is for seeding a trip.)

## Storage

A free account holds 1 GiB across every trip it hosts (model §7; `FREE_STORAGE_BYTES` in
`public/js/shared/limits.js`, read through `limitFor()` in `src/trips/storage.js`, the one
place a plan will go; a site of its own may set `STORAGE_LIMIT_BYTES` in `wrangler.jsonc`).
What counts, for each trip the account hosts, is read from the rows and never kept as a number:
its stored files (originals and thumbnails), its uploads under way at their declared size for a
day from when they began, and the boards shared from it that aren't revoked. The map doesn't.

```
GET /api/account/storage -> { limit, used, reserved, trips: [{ id, name, bytes, files }],
                              reservations: [{ key, trip_id, trip_name, user_id, user_name, bytes, since }] }
```

That is the host's meter (an account that hosts nothing gets an empty one). Every member sees
the host's room in the trip's snapshot: `storage: { host_id, limit, host_used, trip_bytes }`.

**A write that wouldn't fit is refused before any bytes move.** Every upload (`media/begin`,
`media/thumb`, a board, its video, a photograph on it) begins with one conditional insert of its
row at its declared size, which succeeds only if the host's use plus this fits. Refused:

```
413 { "error": "storage full", "reason": "…", "needed", "limit", "used", "reserved", "trip_bytes",
      "trips": [ … ], "reservations": [ … ] }      ← trips and reservations to the host only
```

The host's sentence names the trips they host, largest first, and says deleting a trip frees
what it holds. Anyone else's names only this trip's share, the host's room and limit, and that
only the host can free space: a member of one trip learns nothing of the host's others. When
uploads under way are what's in the way, both say so. No refusal mentions a price. An account
over its limit (a trip moved in, say) loses nothing: everything reads, and new bytes are
refused until it fits.

An upload under way holds its declared bytes for a day. Its uploader or the trip's host can
cancel it (`DELETE …/media/object?key=`), which frees them at once; after a day it holds nothing
and the drain clears it. `media/finish` refuses a file that came out bigger than declared (its
parts are already held to their sizes, so this guards R2 itself). `GET …/media/usage` is gone.

**Boards.** A shared board, its video and its photographs count until it is revoked. Its maker
or the host revokes it (`DELETE …/collage/share/:id`): its link stops answering and its files
go. A photograph sent to a board names the memory it came from (`…/item?memory=<id>`), and
deleting that memory revokes every board it is on (`DELETE …/memories/:id` answers
`boards_unshared`); boards from before this kept no such link, and stay until revoked.
With the memory it may name the photograph itself (`…&media=<memory_media id>`, one of that
memory's own; 400 `no such media` otherwise, 400 `media without its memory` alone): the item
keeps that photograph's thumbnail (migration 0026), and the board's page draws a tile at it when
the tile needs about 480 px or less (`/s/<id>/i/<n>/thumb`; an item with no thumbnail answers its
original there, never a 404). Left out, the item keeps none and the page uses the original.
A board's files (`/s/<id>/image`, `/video`, `/i/<n>` and its thumb) answer `Range` as `/media/` does
(src/media-files.js `rangedGet`): `Accept-Ranges: bytes` on every answer, `206` for a bounded,
open-ended or suffix range, `416` with `bytes */<size>` past the end. A video player seeks with
ranges, and Safari on an iPhone won't play a video without them.

**A board on its wall** (migration 0041). A board's picture is the board plus a band of the wall
round it. `POST …/collage/share` may say where the board is in it and what it is made of, all six
or none: `bx`, `by`, `bw`, `bh` (fractions of the picture's width and height, inside it), `bs`
(the picture's pixels per board unit, more than 0 and at most 64) and `bg` (`corkboard`, `paper`,
`linen`, `slate` or `fridge`). Its page then draws that board, in that material, on the wall, as
the app does (`public/js/shared/board-look.js`). Any of them wrong, or some sent without the rest,
is 400 `bad board` with a sentence, and nothing is kept. A board sent without them (every board
from before 0041) is drawn as a corkboard filling its picture. A photograph sent to it may carry
`pin`, its fastener's stream in the app (a whole number from 0 to 4294967295), so its page puts
the same tack or magnet in the same place; a `pin` that isn't one is 400 `bad pin`. Sent without,
the page hashes the photograph's slot and where it sits on the board, so a share draws the same tacks every time.

The trip's boards, to any member, newest first (the 50 most recent; a revoked one stays among
them so its maker sees that it stopped and why):

```
GET /api/trips/:trip/collage/shares -> { shares: [ { id, url, created_at, created_by, title, width, height, bytes,
                                                     revoked, revoked_at, revoked_why, memories, rev } ] }
```

`revoked_why` is `null` while it is shared, else `"maker"` (its maker revoked it; the host
revoking their own is this too), `"host"` (the trip's host revoked someone else's) or
`"memory"` (a memory on it was deleted, on its own or with its owner's account); boards revoked
before migration 0021 say `null` (nobody recorded why). `memories` are the memories a live
board's photographs come from (empty for a board from before photographs named their memory, and
for a revoked one). Each memory in the feed and on its own (`GET …/memories`, `…/memories/:id`)
carries `boards`: how many live boards show one of its photographs, so the app can say before a
delete that those links will stop.

**When a memory happened** (migration 0029; agreed with the client lane, 15 Nov). A memory carries:

```
day       "YYYY-MM-DD" | null   the trip-zone day it happened: read from its photographs, or chosen
taken_at  seconds | null        the earliest moment its photographs were taken, where a file says so;
                                a day chosen by hand has none (no time is invented)
at        seconds               the order the feed pages in, the server's: taken_at, else the last
                                second of `day` in the trip's zone (the newest of its day), else
                                created_at
```

`created_at` stays when it was posted, so "posted later" is `created_at` well after `at`. Every
memory from before 0029 has neither, and `at` = `created_at`.

```
POST  …/memories {id, caption, tags, media, day?, taken_at?}   -> { memory, rev, not_taken? }
PATCH …/memories/:id {day?, taken_at?, framing?}               a key not sent stays; null takes it
                                                               away. Its poster only (403 "not yours")
```

- **The feed** (`GET …/memories`) is newest first by `at`, and pages by `before=<at>&before_id=<id>`
  (`next_before` is an `at`). Order on the phone by `at` too, and a page never disagrees with it.
- **A day that isn't on the calendar, or a time that can't be** (before 1990, more than two days
  ahead): a POST still posts (a refused post would be lost on the phone), keeps it as none, and
  names it: `not_taken: [{ field: "day" | "taken_at", reason }]`, so the app can say it couldn't
  read when this was taken. A PATCH is a choice: refused in words (`bad day`, `bad taken_at`).
- Both go through told() (`SPECS.memory`, `SPECS.memoryEdit`), naming anything else in `ignored`.
  Nothing reads a file on the server: the phone reads the photographs' time.

**The drain.** Whatever deletes rows that name files (a trip, an account, a memory, a board, a
cancelled upload) queues the files in `files_to_delete` in the same write. A cron
(`wrangler.jsonc` `triggers`, every 15 minutes; locally `wrangler dev --test-scheduled` at
`/__scheduled`) removes up to 1,000 a run, aborts unfinished uploads, and clears uploads
abandoned past their day. A file that fails 10 runs stays, with its error, and every run logs
how many have stopped (`files_to_delete: N file(s) failed 10 runs…`).

## Settling up: a payment is a kind of purchase

`purchases.kind` is `'purchase'` (the default) or `'payment'`: one person gave another money
to settle up. A payment is a purchase row with exactly one share, so every balance is still
one sum over one table. `POST …/purchases` takes `kind`; the refusals, all `400`:

| sent | `error` |
|---|---|
| a `kind` that is neither | `unknown kind` |
| a payment with no share, or more than one | `a payment has exactly one share: the person who received it` |
| a payment whose share is the payer's own | `a payment's share is for someone other than the person who paid` |
| a payment whose share isn't its whole amount | `shares do not sum to the amount` |
| a payment with a `day`, an `event_id` or a `place_id` | `a payment has no day, event or place` |
| a `PATCH` that changes `kind` | `a purchase's kind can't be changed` |

Who may edit or delete one is the rule purchases already had (`403 {"error":"forbidden"}`).

## Pictures

One stored image per place, event, the trip's cover, and a purchase's receipt (model §6, §17).
`src/trips/pictures.js`, `src/trips/image.js`; migration 0022.

```
PUT    /api/trips/:trip/pictures/:kind/:id?license=&credit=&source=   (the bytes)  -> { picture, rev }
PUT    /api/trips/:trip/pictures/cover?license=&credit=&source=       (the bytes)  -> { picture, rev }
POST   /api/trips/:trip/pictures/:kind/:id/from-url { url, license, credit, source } -> { picture, rev }
POST   /api/trips/:trip/pictures/cover/from-url     { … }
POST   /api/trips/:trip/pictures/:kind/:id/upload-link { license, credit, source }
                                   -> 201 { url, method: "PUT", expires_at, max_bytes, max_px }
POST   /api/trips/:trip/pictures/cover/upload-link  { … }
PUT    /pictures/upload/:token      (the bytes; no session: the token is the credential) -> { picture, rev }
DELETE /api/trips/:trip/pictures/:kind/:id, DELETE /api/trips/:trip/pictures/cover
                                   -> { ok, removed, freed_bytes, rev }
```

`:kind` is `place`, `event` or `purchase` (its receipt; a payment has none). `picture` is
`{ url, width, height, bytes, mime, license, credit, source, created_by, created_at, rev }`;
`url` is `/media/<key>`, served to the trip's people only. The snapshot carries each place's and
event's `picture`, the trip's `cover` (on `trip`) and each purchase's `receipt`, `null` where
there is none.

- **One stored form.** JPEG, PNG, WebP or AVIF, decided by the file's first bytes; its size read
  from its own header. SVG and anything else: `415 {"error":"not a picture","reason"}`. One size
  per role (`PICTURE_LIMITS` in `public/js/shared/limits.js`, which the app reads to make that
  size on the phone): a picture or a receipt is at most 1600 px on its long side and 600 KB;
  larger is `413 {"error":"too big","max_px","max_bytes","got":{px,bytes},"reason"}`. **What is
  kept inside the file:** the app's way re-encodes on the phone, so a photo's location data and
  the like go; by address and by upload link the bytes are stored exactly as given.
- **What it hangs on must exist**, in the same statement that writes it: `404 {"error":"no such
  place"|"no such event"|"no such purchase","reason"}`. A receipt for a purchase not saved yet
  is that 404: send the purchase first, then its receipt.
- **Who:** a place's, an event's or the cover's picture, any member; a receipt, whoever may
  change the purchase (who logged it or who paid: `403`).
- **License:** `license` is required: `own` for your own photo, `CC0`, `Public domain`, or the one
  it was published under. Unless it is one of those three, `credit` and `source` (an https
  address) are required: `400 {"error":"credit needed"}`. A license naming NC or ND (any
  spelling) is `400 {"error":"license refused"}`.
- **Storage:** a picture is a file like any other: it counts toward the trip's host, through
  the same one conditional insert (a picture that wouldn't fit is the `413 "storage full"` of
  [Storage](#storage), before any bytes move). The meter's trips carry
  `pictures: { count, bytes }` and `receipts: { count, bytes }`; deleting a trip's `goes`
  counts `pictures` and `receipts`.
- **Replacing and removing by hand** (these routes) sends the old file to the drain at once.
  Deleting a place, an event, a purchase or the trip takes its picture with it. A picture stays
  when the account that added it is deleted: it is the trip's. (A change an AI makes later
  through the MCP will keep a picture it replaced, counted, for 30 days: model §9. The one
  function that replaces or removes takes which it is.)
- **By address:** https only, port 443, no name or password in the address, a site's name and
  not a number, no private name (`localhost`, `.local`, `.localdomain`, `.internal`, `.lan`,
  `.home.arpa` and the like, a trailing dot or not); redirects followed by hand,
  each held to the same rules, at most 3; the whole fetch within 10 s; never more read than the
  limit and one byte. For hosts that serve sized copies by address (Wikimedia), 1280 px is asked
  for, then 960, then the original: Wikimedia serves sized copies only at its standard widths
  (1600 and 1024 are refused, measured 14 Nov 2026). A refusal is `400 {"error":"fetch failed","cause","reason"}` with
  `cause` one of `not an address`, `not https`, `not port 443`, `credentials in the address`,
  `an address, not a name`, `a private name`, `redirects`, `too slow`, `unreachable`,
  `refused`: never the far site's own words. 20 fetches a minute per account (`429`). A sized
  copy the host won't serve tries the next; only the last address's refusal is the answer. Each
  fetch sends `User-Agent: WeGoPlace (+<the site's origin>)`, nothing about the person.
  **What the name test is not:** a public name that resolves to a private address is stopped by
  Cloudflare's network, not by this code: the Worker runs with `global_fetch_strictly_public`
  (wrangler.jsonc), so every fetch it makes goes to the public internet only. The name test
  refuses the obvious names first, in words. (The checks' Worker runs without the flag: their
  stand-ins are on the same machine.) A site run anywhere
  else sets `PICTURE_FETCH_BY_ADDRESS` to `off`, and the route answers
  `404 {"error":"not offered","reason"}` in words; the app's way and upload links still work.
- **Upload links:** one use, 15 minutes, for the thing they were made for, with the license
  given when made. An unknown, used or expired token, or one whose maker has left the trip, is
  `404 {"error":"no such link"}` before any of the body is read. A link is used up by its first
  PUT, even one refused (too big, not a picture): ask for another. 20 links a minute per account.
- **Two people setting the same picture at once:** the later write stands; the other is told
  `409 {"error":"picture changed","reason","picture"}` with the picture that is there.
- **For the checks only:** `PICTURE_FETCH_VIA`, honoured only on a loopback address, sends every
  fetch by address to a stand-in on the same machine (`checks/lib/far.mjs`). A site never sets it.

## GET `/api/trips/:trip/events`

Any member. Every event for the trip, `ORDER BY starts_at, id`.

→ `{ "events": [ { id, trip_id, starts_at, ends_at, tz, end_tz, all_day, title, kind,
place_id, detail, url, source, created_by, created_at, updated_at, rev } ] }`

`source` says where a row came from when it wasn't typed in the app (`import`, or later an
AI's change); the app leaves it empty.

`ends_at` is `null` for a point in time. Each event carries its own IANA `tz` — render in
it, never in the device zone (see `docs/CONTRACTS.md § Time`).

`end_tz` is the **arrival** zone and is `null` for anything that does not cross one. Render
arrivals as `fmtTime(ends_at, end_tz || tz)`, always. Only the two international legs carry
it, and they are exactly the rows where a single-zone render is an hour wrong in the wrong
city's clock. It is accepted on `POST` and `PATCH` (`null` or `""` clears it).

## POST `/api/trips/:trip/events`

Any member. `created_by` is the session user, always; a `created_by` in the body is ignored.

Body: `{ id?, title, starts_at, tz, ends_at?, end_tz?, all_day?, kind?, place_id?, detail?, url?, source? }`

| Field | Rule |
|---|---|
| `title` | required, trimmed, ≤ 200 |
| `id` | when new, lowercase letters, digits and hyphens, at most 64 (`400 {"error":"bad id","reason":…}`); one the trip has already answers `200` with that event |
| `starts_at` | required, integer epoch **seconds**, on **a day of the trip in the event's own `tz`** — else `400 {"error":"not a day of the trip","reason":…,"day":…,"starts_on":…,"ends_on":…}`, which catches a wrong year. A trip without dates takes no events. A value ≥ 1e11 is rejected as milliseconds — `Date.now()` lands ~1000× in the future and sorts to the bottom of the agenda forever, which reads as "my event vanished" rather than as a bug |
| `tz` | required, must survive `new Intl.DateTimeFormat(…, { timeZone })`. A bad zone does not fail here, it fails inside `util.js`'s `fmtTime` on every phone and takes the agenda render with it |
| `ends_at` | integer or `null`; must not precede `starts_at` |
| `kind` | one of `flight meal lodging activity transit plan` (default `plan`) |
| `place_id` | a place of the trip, else `400 {"error":"unknown place_id"}` |
| `url` | `http(s)` only, ≤ 500 |
| `detail` | ≤ 4000 |

→ `201 { "event": {…} }` (or `200` on a replay — see Idempotency).

## PATCH `/api/trips/:trip/events/:id`

Any member. Body is a partial of the POST fields; only keys actually present are touched.
`updated_at` is set server-side. `ends_at` is validated against the *merged* row, and so is the
day: a change of `starts_at` or `tz` that moves the start off the trip's days is refused.

→ `{ "event": {…}, "rev" }` · `404` if gone.

## DELETE `/api/trips/:trip/events/:id`

Any member. Its notes go with it; a purchase that pointed at it floats (its `event_id` is
cleared in the same write), keeping its money.

→ `{ "ok":true, "deleted":true|false, "rev" }`

## PUT `/api/trips/:trip/events` · DELETE `/api/trips/:trip/events` (batches)

The MCP's `put_events` and `remove_events`. Any member.

- `PUT` `{ events: [...] }`, at most 200: each row is added, or changes the event with that `id`
  (only the fields sent, as `PATCH` does), held to everything `POST` and `PATCH` hold a row to.
  One write: a refused row refuses the batch, `400 {"error":"bad events","rows":[{index, id,
  error, …the single route's own words}]}`, nothing written. → `{ events, rev }`
- `DELETE` `{ ids: [...] }`, at most 200: each with its notes and picture, purchases on it
  floating, in one write; an id that isn't there is skipped. → `{ ok, deleted: <count>, rev }`

## GET `/api/trips/:trip/notes[?event=<id>]`

Any member. **Default is every note on the trip.** `store.notes(eventId)` reads out of
IndexedDB, so the cache has to hold all of them before the signal goes; a per-event fetch
is the one shape that cannot work on the trail. `?event=` exists for completeness.

→ `{ "notes": [ { id, event_id, user_id, user_name, initials, note_color, anchor_kind,
body, created_at } ] }`

`user_name`, `initials` and `note_color` are all denormalized into the row on purpose:
offline the client cannot look up an author it never cached, and the `/api/trips/:trip` roster only
covers people who are **still** members — a message from somebody who left still has to
render with the right initials and the right hue, with no signal.

### `anchor_kind` — what the note is attached to

A note attaches to one of two things. (Notes become messages in the chat, about their event,
in the landing that brings the app's chat: model §17. Events are written by people and AIs alike
through …/events; the v2 rule that only notes were people's is long gone.)

| `anchor_kind` | means |
|---|---|
| `"event"` | the note is about the event itself — "gate changed to 24" |
| `"gap"` | the note is about the **empty time before** that event — "arrange the early bag drop" |

A **gap note anchors to the event that FOLLOWS the gap**, never the one before it. The gap's
start moves when the preceding event's end moves and its end moves when the following
event's start moves, but "the run-up to lunch at Mérito" is stable as long as lunch exists.
Anchor to the preceding event instead and deleting a flight orphans every note about the
wait for the next thing.

There is no second column and no NULL: `event_id` still means "the event this row points
at", and `anchor_kind` reinterprets that same pointer. Rows written before `0004` default to
`'event'`, which is what they already meant.

## POST `/api/trips/:trip/notes`

Any member, **any event, including locked seeded ones**. Body:
`{ id?, event_id, body, anchor_kind? }` (`body` trimmed, ≤ 2000). The event must belong to
the trip, else `404`.

`anchor_kind` is `"event"` (default) or `"gap"`; anything else is
`400 {"error":"bad anchor_kind","allowed":["event","gap"]}`. The default is what every v1
note meant and what a client that has not been updated still means.

→ `201 { "note": {…} }` — the response carries the author's `initials` and `note_color`, so
the composer can render the message it just sent without waiting for a refetch.

Append-only by design: there is no PATCH and no DELETE. A note is what somebody read and
acted on; letting it be edited or removed after the fact turns the one channel that still
works offline into a channel you cannot trust.

## Places

```
GET    /api/trips/:trip/places                  -> { places }
PUT    /api/trips/:trip/places  { places: [...] } -> { places, warnings, rev }   adds each, or changes the one with that id
DELETE /api/trips/:trip/places/:id              -> { ok, deleted, rev }
DELETE /api/trips/:trip/places  { ids: [...] }   -> { ok, deleted, rev }
```

Any member. `GET` is every place, ordered `is_anchor DESC, area, name`, each with every
column and `tags` as a list; `lat` and `lng` are `null` for a place nobody has located yet. No
server-side filtering: `store.js` holds every place on the phone anyway, and "pharmacy near
me" has to run without signal.

A `PUT` is all or nothing, at most 200 rows: one row that can't be written refuses the call,
`400 {"error":"bad places","rows":[{index, id, error}]}`, each `error` a sentence saying what
was wrong and what is allowed (the guide `places.md` tells an AI the same). A new place needs
`id`, `name`, `kind`, `subkind` and `why`. A row that changes a place sends only what changes;
what it leaves out stays, and `null` clears a field. The answer carries the rows written.

What holds (model §16, in `public/js/shared/`):

- **id**: when new, lowercase letters, digits and hyphens, at most 64, unique within the trip.
- **kind and subkind** from the one list, checked apart (`place-kinds.js`, `readPlaceKind`): a
  subkind not on the list is refused with the list in the error, grouped by home kind; an old
  spelling names today's.
- **hours** in the one format (`hours.js`, `readHours`: `Tue-Sat 12:30-15:00, 19:00-23:00; Sun
  12:30-16:00`, `Daily …`, `24 hours`), stored as its canonical spelling; anything else is
  refused with the format.
- **lat and lng** both or neither, never 0,0, and inside the bounds of the place's `area` or of
  that area's parent when either has bounds (`trip-rules.js`). `area` is an area of the trip.
- **rating and rating_count** together (above 0 up to 5, and a whole count of at least 1);
  **price_level** 1 to 4; **confidence** `high`, `medium` or `low`; **tags** at most six,
  lowercase words joined by hyphens. A write that doesn't send `tags` leaves them alone, so a
  row from before the rule keeps more than six until someone rewrites them.
- **near_anchor** a place of the trip, not itself; **walk_minutes** whole minutes;
  **checkout** (the steps for leaving, `[{title, detail?}]`, at most 20) on lodging only;
  **website** http(s).
- Pictures (`image_*`) come with the pictures routes; `gmaps_place_id` and `verified_at`
  aren't written here.

**Ceilings** (every member's phone holds all of these; a guard against a runaway loop, not a
quota): 2,000 places and 2,000 events a trip, 300 packing items an owner (a person's list, or
the group's, each on its own). Past one, `409 {"error":"too many places"|"too many events"|
"too many items","max":…}`.

A new place within 25 m of a place of the same kind is written, and `warnings` names the
other (`[{ id, near, meters, warning }]`): it may be the same place under two ids.

Removing a place is refused while events, or other places' `near_anchor`, point at it:
`409 {"error":"place in use","events":[…],"places":[…]}`. Removed with the places near it in
one call, it goes. A purchase that pointed at it floats.

---

# Packing

The trip defines its **lists** and the **bags** on each; an **item** belongs to a person or to
the group and has at most one bag on each list; a **tick** belongs to an item on a list. The
guide `packing.md` describes it to an AI; model §5 and §17 are the design.

```
GET    /api/trips/:trip/packing[?owner=<userId|group>] -> { items, lists, placements, ticks, starters }
POST   /api/trips/:trip/packing          { id?, owner?, label, category?, note?, qty?, sort?, bags? } -> 201 { item, rev }
PATCH  /api/trips/:trip/packing/:id      { label?, note?, qty?, sort?, category?, owner?, bags? }   -> { item, rev }
DELETE /api/trips/:trip/packing/:id      (also ?id= or a body { id })                                -> { ok, deleted, rev }
PUT    /api/trips/:trip/packing/ticks    { item_id, list_key, day?, ticked }                         -> { tick, rev }
PUT    /api/trips/:trip/packing/items    { items: [...] } (at most 200; each as POST adds or PATCH changes) -> { items, rev }
                                         one write: a refused row refuses the batch ("bad items", rows)
PUT    /api/trips/:trip/packing/lists    { lists: [...] }                                            -> { lists, rev }
DELETE /api/trips/:trip/packing/lists/:key                                                           -> { ok, deleted, rev }
PUT    /api/trips/:trip/packing/starters { starters: [...] }                                         -> { starters, rev }
PATCH  /api/trips/:trip/packing/starters { starters: [...] }   -> { starters, added, changed, removed, not_found, rev }
```

**Items** are `{ id, trip_id, owner, label, note, qty, sort, category, created_by, created_at,
updated_at, rev }`. `owner` is a user id (your own list) or `'group'` (the trip's shared one);
a session touches its own and the group's, nothing else (`403 {"error":"forbidden","reason":
"not your list"}`), the host included. `category` is one of `clothes documents electronics
toiletries gear meds misc`. `bags` is `{ list_key: bag_key }`; on a `PATCH` a `null` takes the
item off that list, and its ticks there with it. A bag named that isn't on its list is `400
{"error":"no such bag","bags":[…]}`; a list that isn't the trip's, `400 {"error":"no such list"}`.
An item and its bags are one write.

**Lists** are `{ key, name, sort, repeat, dates, rev, bags: [{ key, name, sort, rev }] }`. Any
member sets them.

- `repeat` is `once` (packed one time, before leaving) or `daily` (what goes in the bag each
  day out: its ticks belong to a day). `dates` names the days of a daily list, or is `null`
  for every day. A named date is a real date, and a day of the trip when the trip has dates.
  Shortening the trip later doesn't look at lists: a date left outside just never shows.
- `bags` sent with a list are added, or changed (`name`, `sort`); one left out stays, so two
  phones that each add a bag both keep theirs. A bag goes only when the write says so:
  `{ "key": "tote", "remove": true }` (already gone is fine). A new bag without a `sort` goes
  after the others, in the order sent. A bag that holds items, anyone's, can't be removed, nor
  one a starter starts in: the row says how many, `{index, key, error, held: [{key, items}]}`
  or `suggested: [{key, starters}]`. A list keeps 1 to 8 bags.
- `repeat` can't change while people have ticked the list.
- A new list or bag takes a key a writer chooses (lowercase letters, digits, hyphens, at most
  40). At most 10 lists, 8 bags a list, 60 dates. A `PUT` is all or nothing:
  `400 {"error":"bad lists","rows":[{index, key, error}]}`.
- A list that holds items, or that a starter starts in, can't be deleted:
  `409 {"error":"list in use", reason, items}` (items: how many, anyone's) or
  `{…, reason, starters: [ids]}`. A trip always has at least one list: the last is
  `409 {"error":"last list"}` (rename it, or add another first).

**Ticks** are per item per list. A once list's tick has no `day`; a daily list's tick carries
the trip's day it is for (`YYYY-MM-DD`, sent by the app: the Itinerary's day in the trip's
time zone, never the phone's): one of the list's dates when it names any, otherwise a day of
the trip when the trip has dates (`400 {"error":"not a day of the trip"}`). A trip without
dates still takes ticks. Only an item with a bag on that list can be ticked there (`400
{"error":"not on that list"}`). Setting what is already so changes nothing.

**Starters** are the trip's suggested items, the whole list: `{ id, scope: person|group, label,
category, note, qty, bags: { list_key: bag_key }, sort, rev }`. `PUT` replaces all of them (an
empty list removes them). Each bag must be on its list. They are offered behind a button and
never added to anyone's list for them.

Migration 0019 made today's lists the trip's: within a trip, every person's copy of a list of
the same name became one list, its bags the bags any copy had, every placement kept, and an
item that was ticked ticked on every list it has a bag on.

---

## GET|HEAD `/api/trips/:trip/tiles`, and `/tiles/*`

The trip's own offline map is `GET|HEAD /api/trips/:trip/tiles`: the archive its `tiles` names,
to the people on it, with the Range handling below. A trip without one answers `404 {"error":
"no map"}`; the app then draws its own ground with the places on it.

### The trip's map: made for any destination (`src/map/`)

The server makes each trip's map from the world build (Protomaps' daily build of OpenStreetMap)
when the trip's regions change: its top-level areas with bounds (a neighborhood is inside its
region). Each region goes as deep as zoom 15, and the region costing most goes a level shallower
until the whole fits `MAP_BUDGET_BYTES` (48 MB, what a phone keeps without asking); a region that
won't fit at zoom 10 is left out, and the note says so. One map maker per trip (a Durable Object)
cuts it 15 s after the last areas write, one cut at a time, at most `MAP_CUTS_PER_DAY` (12) a day;
an areas write that changes no region's bounds cuts nothing.

The snapshot's `tiles`:

```
null                               no map, and none being made
{ state, version, bytes, at, source, note, glyphs, ready }
  state    "none" | "cutting" | "ready" | "failed". A cut that stopped where nothing could record it
           (cutting for over MAP_CUTTING_STALE_S, 10 minutes) reads as "failed", its note saying so;
           the next areas write or the host's "cut again" starts over
  version  changes with each new map: keep (stash) the new one when it changes
  bytes    its size. A cut is within 48 MB by construction; an uploaded one may be bigger: ask the
           person before keeping one over the phone's budget
  at       when it was made (seconds); while "cutting", when the cut was asked for. An areas write
           that will make a map says "cutting" at once (the map maker waits 15 s for more writes
           before it cuts): when a region's bounds changed or the host asked, the map isn't one put
           in by hand, and the day's cuts aren't used up. A rename says nothing new.
  source   "cut" (the server's), "upload" (the host's, counted against their storage), "set" (named
           by hand: the first trip's)
  note     what to tell people: a region left out to fit, why a cut failed, the day's limit reached
  glyphs   the 256-character ranges ("0-255", "768-1023", …) the map's labels use: fetch
           /tiles/fonts/<font>/<range>.pbf for each after keeping the map, before signal goes
           (null for an uploaded map: it wasn't read)
  ready    whether an archive is there to read now (a failed cut keeps the last map)
```

```
POST …/tiles/cut              the host: make the map again now (an uploaded or hand-named one replaced
                              too) -> { ok, asked }; 503 "maps off" on a site without a map maker
POST …/tiles/use {key}        the host: make a map they uploaded the trip's -> { ok, version, bytes, rev }
POST …/tiles/plan {areas}     any member: what the map would be if the trip's top-level areas were
                              these (each { id?, name, west, south, east, north }; an id for one the
                              trip has), beside what it is now. Written nowhere.
  -> { regions: [{ id | null, name, now, would, removed? }], left_out: [name], lowered: [name],
       bytes: { now, would }, max_depth: 15 }
     now, would  each area's depth (zoom) now and as it would be, or null (not there, or left out).
                 15 is the deepest a cut goes; each level less is half the detail across. Measured
                 on Protomaps' build (15 Nov): at 14 every street is still drawn in Tokyo and Paris.
     lowered     the areas the trip has that would lose detail: "the old town keeps its streets;
                 the airport's side loses a level" is lowered: ["The airport's side"].
     left_out    the areas the map wouldn't cover at all (each would go below depth 10): "the coast
                 is too big to fit beside the city: the app draws its own ground there".
     removed     an area the trip has that `areas` leaves out (it would go).
  The cut's own planner on the world the map maker reads (its directories only, no tile), twice:
  a few seconds. `now` is planned again rather than stored, so it can differ by a day's world build
  from the map that was cut. 503 "maps off" (no map maker here, or the map was put in by hand: an
  areas write doesn't make it again), 503 "world unreachable"; 400 "bad box" in words; 429 past
  MAP_PLAN_LIMITER (10 a minute a trip).
```

The snapshot's `maps` (beside `tiles`): whether this site makes maps (a map maker is bound). Where it
is false, a trip with no area has nothing an area would bring; a map can still be uploaded.

**Uploading a map** (for a site that doesn't cut maps, or a map of your own): the host sends it as
any file (`POST …/media/begin` with `kind: "map"`, at most 200 MB, then its parts and `finish`),
then `POST …/tiles/use {key}`. It must be a PMTiles archive of version 3 with vector tiles (as the
app draws), or it is refused in words. It counts against the host's storage (the meter's
`trips[].map.bytes`, the delete dialog's `goes.map_bytes`); its file can't be deleted while it is
the trip's map; a later cut frees it. `tools/map-upload.mjs` does all of it from a shell.

`/tiles/*` is the address from before archives belonged to trips. It is TEMPORARY: it goes in
the same step as the old single-trip addresses (`check:routes` holds it to that). Until then:
session required — the service worker's fetches are same-origin and carry the cookie, so the
offline precache works — and the account has to be on a trip, any trip; an account on none gets
`403 {"error":"no trip"}`. (A stored file under `/media/*` does belong to a trip: it is
answered to someone on that trip, and is `404` to anyone else, exactly as a key that doesn't
exist.) Streams objects out of the `TILES` R2
bucket; the path after `/tiles/` is the R2 key (`/tiles/peru.pmtiles` →
`peru.pmtiles`).

MapLibre's pmtiles protocol does not fetch tiles. It fetches **byte ranges out of one large
archive** — a header read, then directory reads, then a range per tile — and it trusts the
response. A route that ignores `Range` and answers `200` with the whole body *looks* like it
works, because the reader slices the buffer it was given and finds the right bytes; it just
does that after pulling a multi-hundred-megabyte archive into a phone's memory, once per
request, until the tab dies.

So the slicing happens in R2, not in the Worker: `get(key, { range: { offset, length } })`
returns a stream, and nothing here ever holds more than the requested range in memory.
(`../reader`'s `withRange` is the reference for the header arithmetic, not for the
mechanism — it buffers the whole object with `arrayBuffer()`.)

| Request | Response |
|---|---|
| no `Range` | `200`, `Content-Length`, full stream |
| no `Range` + matching `If-None-Match` | `304` |
| `bytes=100-115` | `206`, `Content-Range: bytes 100-115/100000` |
| `bytes=99990-` | `206`, resolved against the object size |
| `bytes=-16` (suffix) | `206`, `Content-Range: bytes 99984-99999/100000` |
| `bytes=99990-999999` (past EOF) | `206`, clamped to the real end |
| `bytes=200000-` past EOF | `416` + `Content-Range: bytes */100000` |
| `bytes=0-1,5-6` (multipart) | `200`, full body — RFC 9110 permits ignoring a Range, and the pmtiles protocol never asks for one |
| missing key, `.`/`..`/empty segment | `404` |
| anything but GET/HEAD | `405` |

`Accept-Ranges: bytes` is set on **every** response, not just `206`s: a client that does not
see it on the first reply is entitled to stop asking for ranges and pull the whole archive.

A fully-bounded range — the only form pmtiles emits — costs one R2 op. Open-ended and suffix
ranges cost a `head()` first, because turning "the last 16 KiB" into an offset needs the
size, and a guess ships a `Content-Range` that disagrees with the bytes, which the pmtiles
reader reports as a corrupt archive.

`Content-Type` is derived from the extension (`.pmtiles` → `application/octet-stream`,
`.pbf` → `application/x-protobuf`, `.json`, `.png`, `.webp`, `.jpg`, `.woff2`), not from R2
metadata: `wrangler r2 object put` stores no content type unless told to.

`Cache-Control: private, max-age=3600` — `private` because the bucket sits behind the
session cookie; short because the service worker owns the offline copy, so HTTP caching here
only saves repeat ranges within a session and a long max-age would make a corrected extract
invisible for a week.

---

## The MCP: `/mcp`

An AI app (Claude, or any MCP client) works on a person's trips through `/mcp`, as that person
(model §13; `src/mcp/`). Every tool does its work through the routes in this file, called in the
same process, so it is held to exactly their rules and refused in their words.

- **Signing in is OAuth 2.1** (`@cloudflare/workers-oauth-provider`, `src/mcp/oauth.js`): the app
  registers itself (`POST /register`, or a client metadata document), sends the person to
  `/authorize`, and trades the code for tokens at `/token` (access an hour, refresh 90 days,
  sliding). `/.well-known/oauth-protected-resource/mcp` and
  `/.well-known/oauth-authorization-server` describe it; any other `/.well-known/` address is a 404.
- **Refresh tokens rotate, with one known looseness kept on purpose:** a refresh answers a new
  pair, and the refresh token just used keeps working until the new one has been used (the
  library's design, so a refresh whose answer was lost can be sent again; a server real Claude apps
  connect to behaves the same). Once the new one is used, the old one is `invalid_grant`.
  check:mcp-sdk holds both halves. Decided 15 Nov; the owner can overturn it.
- **Proved with the official clients** (check:mcp-sdk, `checks/mcp/sdk-walk.mjs`):
  `@modelcontextprotocol/sdk` 1.x and `@modelcontextprotocol/client` 2.x, protocol 2025-11-25
  and 2026-07-28, each the whole road from a bare `/mcp`, with Claude Code's loopback redirect
  (any port, `127.0.0.1` and `localhost`) and the hosted apps' `https://claude.ai/api/mcp/auth_callback`.
  check:mcp-sdk-cimd walks Claude Code's own client metadata document; it reaches the network,
  so it is run before the cutover and never on the gate.
- **`/authorize`** is a page behind the sign-in: it names the app, says it reaches **every trip
  the person is on**, what it may do, and where it sends what it gets. Allow or Cancel is a POST
  from that page, bound to the account it was drawn for.
- **Scopes:** `trips:read` (the read tools) and `trips:write` (every tool). A token without
  `trips:write` is given the read tools only.
- **The account's apps:** `GET /api/account/apps` → `{ apps: [{ id, name, scope, connected_at }] }`;
  `DELETE /api/account/apps/:id` → `{ ok, disconnected }`. A disconnected app is refused at
  `/token` and `/mcp` from then on, whatever the provider's store still holds (`revoked_grants`).
  Deleting the account disconnects every app.
- **How often:** 300 requests a minute per account, all its apps together (`MCP_LIMITER`); then
  429 with `Retry-After: 60`.
- **The tools:** the six guides (`get_trip_guide`, `get_itinerary_guide`, `get_places_guide`,
  `get_packing_guide`, `get_pictures_guide`, `get_split_guide`: `src/mcp/guides/`); the reads
  (`list_trips`, `get_trip`, `list_events`, `list_places`, `get_packing`, `get_split`,
  `list_messages`, `list_changes`, `open_in_app` (a link into the app: a plan, a place, a purchase, the cover, the chat, Changes; `add_photo` opens it ready for the person's own photo); the chat is read, never written: no tool posts a message); the writes (`create_trip`, `update_trip`, `put_areas`, `remove_areas`,
  `put_events`, `remove_events`, `put_places`, `remove_places`, `set_packing_lists`,
  `set_packing_starters`, `put_packing_items`, `set_picture`, `picture_upload`, `remove_picture`,
  `put_purchase`, `remove_purchase`, `put_payment`, `remove_payment`, `undo_change`).
- **What a tool adds to the routes:** event times as the booking prints them, local to their zone
  (`public/js/shared/clock.js`: a time the clocks skip or repeat is refused with what it could
  mean); amounts as text in the currency's decimals (an even split by `public/js/money.js`'s
  `allocate()`); each day with its weekday.
- **Every write takes `trip_id` and a `summary`, and is one change** (below). A write that takes
  several route calls (an itinerary's events) is all or nothing: when a later part is refused,
  what the earlier parts wrote is put back, the change is dropped, and the refusal names the part.
- **Nothing is removed by leaving it out:** `set_packing_lists` removes a bag or a list only when
  it comes with `"remove": true`, and `set_packing_starters` (`PATCH …/packing/starters`) adds or
  changes starters found by their scope and label, removing one only with `"remove": true`.
- **Never** (model §13): delete a trip, remove a member, hand a trip over, make a join link,
  anything about the plan, anything on another person's packing list.
- **An app's client metadata document** (CIMD, how Claude says who it is) is fetched by the OAuth
  library, which does that only with `global_fetch_strictly_public` on; registration (`/register`)
  works either way.
- `tools/mcp-call.mjs` calls one tool from a shell (`WGP_SESSION` in the environment for the first
  connection; the tokens kept in a file outside the tree).

## Every request within 50 D1 queries

Workers count a request's D1 queries: at most 50 on the free plan, 1,000 on the paid one. A
`db.batch()` is one query however many statements it holds; every `first()`, `all()`, `run()`
is one. Every request here is held to 50, so that a copy run on a free account is the same app:
a batch reads what it checks once (the trip's places, items, bags) and writes once, never a
query per row. `npm run check:queries` measures the heaviest (the whole snapshot of a trip the
size of the first one, the meter, a trip's and an account's delete, every MCP tool at 200 rows)
on a server started with `COUNT_QUERIES=on` (`src/query-count.js`, honoured only on this
machine's address), and fails on any over 50.

## Changes an AI makes: `/api/trips/:trip/changes`

Every write through the MCP is one change (model §9; `src/trips/changes.js`), recorded by the
database itself: migration 0023's triggers record each row the write touched, before and after,
while `write()` holds the change open inside its own batch. An edit made by hand in the app is
never recorded, and never listed.

```
GET    /api/trips/:trip/changes[?before=<created_at>&limit=n]
  -> { changes: [{ id, by: { id, name }, source, summary, kind, undo_of, undone_by, rev, created_at,
                   undoable, rows: [{ table, key, op, label, private, payment?, may_not }], private_rows_of_others }], days: 30 }
POST   /api/trips/:trip/changes/:id/undo   -> { change, undone, left: [{ table, key, label, why }] }
DELETE /api/trips/:trip/changes            -> { cleared, freed_pictures }        (the host only)
```

- `source` is `oauth:<the app's name>`, `app` for an undo pressed in the app. `kind` is `write`,
  `undo` (`undo_of` names the change it undid) or `create` (a trip made through the MCP: listed,
  with no undo).
- **Private rows:** a person's own packing items, with their bags and ticks. Everyone on the trip
  sees a change's line; its private rows are listed, and put back, only for their owner (anyone
  else sees `private_rows_of_others`, a count, and their undo leaves those rows, saying so).
- **Undo** puts each row back as it was before the change, newest first, if it is still as the
  change left it; a row written since is left, `why: "written since"`. It is held to the same
  rules as any write by the person pressing it (a purchase is its logger's or payer's), and one
  that something on the trip now points at (an event on a place it added) is left, saying so. The
  undo is a change of its own, so it can be undone.
- **Pictures:** one a change replaced or removed isn't drained: its file is held (`files_held`),
  stored and counted to the host (`/api/account/storage`'s `trips[].held`), so an undo can put
  it back. The cron frees it once the change is 30 days old, or when the host clears the list.
- **`may_not`**, on each row: null when the person reading could put it back as it stands now,
  else `{ why, who }`: the reason undo would give (the same rule, `mayWrite`) and, for a purchase,
  its payment or its receipt, the ids of the people who can (who logged it, who paid, and for a
  payment who received it). A row written since is only found out by the undo itself.
- **The app's screen** is Other, then Changes (`public/js/changes.js`). The trip snapshot's
  `trip.newest_change` is the rev of the newest line the reader has something to notice in (every
  line of the 30 days but making a trip and their own undos pressed in the app), for the mark on
  Other (`public/js/changes-dot.js`); null when none.
- Changes are kept 30 days (`CHANGE_DAYS`), then removed by the cron.

## File map

`src/routes.js` is the whole list, one row per method and path. By file, under `src/`:

| Route | File |
|---|---|
| `/api/auth/register/*`, `/api/auth/login/*`, `/api/auth/passkeys/*` | `accounts/passkeys.js` |
| `/login/<provider>`, `/login/<provider>/callback`, `/api/auth/pending*` | `accounts/providers.js` |
| `/api/account/email*`, `/api/auth/recover*` | `accounts/email.js` |
| `/api/auth/link` | `accounts/link.js` |
| `/api/auth/config`, `/api/auth/ways*`, `/api/auth/logout*`, `DELETE /api/me` | `accounts/account.js` |
| `/api/me` (`GET`, `PATCH`) | `api/me.js` |
| `/api/trips`, `PATCH` and `DELETE /api/trips/:trip`, `/api/trips/:trip/rev` | `trips/trips.js` |
| `/api/trips/:trip/members*`, `/api/trips/:trip/host*` | `trips/members.js` |
| `/api/trips/:trip/links*`, `/api/join/:code` | `trips/links.js` |
| `/join/:code`, `/login/new`, `/login/link/:token`, `/trips/:id` (pages); `/t/:id/` (the app at a trip's address) | `static.js` |
| `GET /api/trips/:trip` | `api/trip.js` |
| `/api/trips/:trip/events`, `/api/trips/:trip/events/:id` | `api/events.js` |
| `/api/trips/:trip/notes`, `/api/trips/:trip/notes/:id` | `api/notes.js` |
| `/api/trips/:trip/areas*` | `trips/areas.js` |
| `/api/account/storage`, and the limit and its refusal for every upload | `trips/storage.js` |
| `/api/trips/:trip/tiles` | `tiles.js` |
| `/api/trips/:trip/pictures*`, `/pictures/upload/:token` | `trips/pictures.js` (and `trips/image.js`) |
| the scheduled drain | `trips/drain.js` (from `index.js`'s `scheduled`) |
| `/api/trips/:trip/places*` | `api/places.js` |
| `/api/trips/:trip/packing`, `/api/trips/:trip/packing/:id`, `…/packing/ticks` | `api/packing.js` |
| `/api/trips/:trip/packing/lists*` | `api/packing/lists.js` |
| `/api/trips/:trip/packing/starters` | `api/packing/starters.js` |
| `/api/trips/:trip/purchases`, `/api/trips/:trip/purchases/:id` | `api/purchases.js` |
| `/api/fx`, `/api/fx/refresh` | `api/fx.js` |
| `/api/trips/:trip/media/*` | `api/media.js` |
| `/api/trips/:trip/memories`, `/api/trips/:trip/memories/*` | `api/memories.js` |
| `/api/trips/:trip/collage/*` | `api/collage.js` |
| `/media/*` | `media-files.js` |
| `/s/<id>` and what it shows | `share-page.js` |
| `/tiles/*` | `tiles.js` |
| the addresses from before trips had ids (temporary) | `old-addresses.js` |

`src/trips/access.js` is the one place that decides who is on a trip (`inTrip()`, around every
row under `/api/trips/:trip`), `src/trips/rev.js` the one place a trip's rev moves, and
`src/trips/delete.js` the list of everything a trip stores, as the statements that remove it.

Each surface lives in one file, the one that owns it per `docs/CONTRACTS.md`; the route
table names the handler for every method and path, `/things/:id` included.

`trip.js` also exports the pieces the other routes share — `err`, `nowSec`, `listMembers`,
`str`, `validId`, `validEpoch`, `validTz`, and now `NOTE_COLORS`, `initialsOf` and
`ensureNoteColors` — rather than introducing a util module nobody owns. `packing.js` holds
the owner rule (`mayTouch`), the categories and the readers of items, placements and ticks;
`packing/lists.js` and `packing/starters.js` their own readers. The checks a row is held to
live in `public/js/shared/` (`trip-rules.js`, `place-kinds.js`, `hours.js`, `limits.js`), one
copy for the app's forms and the Worker. `json` and `readJson` come from `src/api/json.js`.

The dependency runs both ways: `trip.js` imports `listPlaces` / `listEvents` / `listPacking`
/ `listNotes` from the four collection routes to build its snapshot. The cycle is fine in
ESM — nothing is read at module-evaluation time — and it is deliberate: the alternative is a
second copy of each `SELECT` in `trip.js`, which is exactly how `end_tz` came to be in the
schema, in the seed, and in nothing the app could see.

## The pages outside a trip, and the app's address for a trip

- `/trips` is `public/trips.html` (Your trips: the trips an account is on, making one, an offer to
  host, and a host's storage), drawn with `js/trips.js`. It keeps the last list under the
  `wgp.trips` key, with whose it is, so it opens with no signal; signing out clears it with every
  other `wgp.` key (`js/forget.js`), and a page signed in as someone else never draws it.
- `/trips/<id>` is `public/trip-people.html` (a trip's people, links, details, storage, leaving
  and deleting), drawn with `js/trip-people.js`; it needs a connection, and answers a trip that
  isn't the caller's in the same words as one that was deleted. Both pages share `js/trip-kit.js`
  and `css/trips.css`.
- `/t/<id>/` answers the app's own document, the same bytes and headers as `/`; the app reads
  the trip from the address. `/t/<id>` is a `308` to the slash form, keeping the query. Signed
  out, both go to sign in and back, as every page under the Worker does.
- A join and a new trip give the person their colour on notes in their own write (when they have
  none), so reading the trip never writes; `ensureNoteColors` stays as the backstop for rows from
  before.

## Documents given the assistant: `/api/trips/:trip/assistant/conversations/:id/files`

A planning document a person gives the assistant, on a conversation of their own (`src/assistant/files.js`; migration
0045 `ai_files`; what a file is and its text: `src/assistant/documents.js`). The assistant reads it with
`read_document` (its alone; the MCP has no such tool) and writes the trip with its usual tools, so every change is in
Changes with its undo.

```
POST   …/conversations/:id/files            raw body; Content-Type; X-File-Name (URI-encoded, ≤ 200 characters)
         -> 201 { file }   read before it answers; or refused in words, nothing kept
GET    …/conversations/:id/files            -> { files: [file], limits }
GET    …/conversations/:id/files/:file      -> the original (Content-Disposition: attachment), to its person only
DELETE …/conversations/:id/files/:file      -> { ok: true }
POST   …/conversations/:id/ask              { id, words, files?: [file ids] }   the ask names what it attaches
```

`file` is `{ id, name, mime, bytes, pages, text_chars, state: "ready" | "unreadable", why, created_at }`.

- **What it is comes from its bytes, never its name:** PDF; Word (`.docx`), Excel (`.xlsx`) and OpenDocument text
  (`.odt`) by the zip entry that names the type (`[Content_Types].xml`, `mimetype`), a plain zip refused; PNG, JPEG,
  WebP; else UTF-8 text (CSV by its name). Anything else: `415 "not a document"`, in words.
- **Read once, at upload:** text, Markdown and CSV as they are; PDF and the office formats by Cloudflare's own
  conversion in this Worker (`env.AI.toMarkdown`; `DOCUMENT_CONVERT_VIA`, loopback only, stands in for checks); a
  scanned PDF (next to no text a page) and a picture by ONE call to the model through OpenRouter's zero-retention
  providers, metered on the host as a `"transcribe"` call held at its pages (`TRANSCRIBE.pageTokens` a page), never at
  its base64; at most `TRANSCRIBE.pagesMax` scanned pages. Text past 500,000 characters: `422 "unreadable"`, "too long
  to read". Nothing in a document is ever followed: its text is content (`read_document` says so in every answer).
- **Limits** (`limits` in the GET, and `public/js/shared/limits.js`): PDF and office files ≤ 10 MB, pictures ≤ 5 MB,
  text, Markdown and CSV ≤ 1 MB (`413 "too big"`); 5 a conversation (`409 "too many files"`, held in the upload's own
  conditional insert); `ASSISTANT_FILES_PER_HOUR` ATTEMPTS an account an hour, kept or not (`429`, Retry-After; counted
  in `hour_counts`). A PDF's pages are counted inside its object streams too; a scan whose pages can't be counted is
  refused. Every inflate (a zip's type entry, a PDF's object streams) stops at its limit. The host's plan must have the assistant
  (`402`, as an ask).
- **Room:** the original and its text count in the HOST's room (`src/trips/storage.js heldSql`). The upload's one
  conditional insert holds the original's bytes and what its text may take (its own bytes for text, Markdown and CSV;
  `DOCUMENT_TEXT_RESERVE`, 2 MB, for the rest): `413 "storage full"` before anything reaches the bucket.
- **Its person's alone:** another person's conversation or file is the same answer as none (`404`), the host's
  included; an ask can name only the asker's own read files of that conversation.
- **Gone** (the row now; the original and its text through the drain, `queueFiles`) with its conversation, its
  person's account, the trip, and when its person leaves the trip (the rows it led to stay). A file whose reading
  never finished is settled by the drain's sweep: `unreadable` if its original is in the bucket, its row deleted if not.
- **"Download what's yours"** (`GET /api/account/export`) lists each conversation's documents, and each ready one's
  address above.

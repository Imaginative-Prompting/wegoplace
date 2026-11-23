# Parity: does every route still answer as recorded?

Two checks hold the server to what it is known to do. Both can fail.

```bash
npm run check:parity     # about 25 s
npm run check:routes     # about 1 s
```

`check:parity` starts `wrangler dev` on a free port of its own (or `--port`) with its own empty database and R2
under `.wrangler/check/`, so it never touches the database you develop against, and stops it again. The server's
own address is recorded as `<origin>`, and a body's `content-length` is counted with `<origin>` in its place (21 Nov:
a recording made on a five-digit port failed on a four-digit one, by a byte per address), so a recording holds on any
port and two lanes can run it at once. A named
port that is taken: it refuses.

## check:parity

`scenario.mjs` is a script of about 1,230 requests: signed out and signed in, as a trip's
host, as people on it and as people who aren't, right and wrong, every route and every file in
`public/`. A passkey is created and used in software (`lib.mjs`), so sign-up and sign-in run
for real. Two people start with a session row; the third signs up through the routes. Trips
are made by `POST /api/trips` and people get onto them by a link, as in the app.

`golden.json` is what the server answered to that script. `run.mjs` plays the script again
and compares status, headers and body of every answer with the recording.

What is random by nature is replaced before comparing, and only that: ids the server mints
(each is learned from the response that first carries it and becomes `<its-name>`), numbers
that are the clock (`<now>`, and `<now+Nd>` for the clock plus whole days: when a link runs
out), the value of a cookie the server made (`<token>`), the ETag of a static file, and the
`Date` and `cf-cache-status` headers. A body that is a file from `public/` is recorded as that
file's name and its `Content-Length` as `<length>`, so the client lane can change the file
without this failing. A static file added since the recording **fails** the check, named:

    UNRECORDED public/js/zz-planted.js: a file with no step in the recording, so how it is served is held by nothing. Record again (checks/parity/README.md).

(14 Nov: until then a new file was only noted, and nine went unrecorded.) A file removed since is
skipped: its step can't run, and hides nothing. A step the scenario runs that the recording lacks
fails the same way (`EXTRA … run, not in the recording`).

```bash
node checks/parity/run.mjs --compare checks/parity/golden.json   # the check
node checks/parity/run.mjs --record out.json                     # record a run
node checks/parity/run.mjs --diff a.json b.json                  # compare two recordings
```

## check:routes

`src/routes.js` is written by hand and its order is part of its behavior. The check holds it
to six things:

1. the gate runs before any route;
2. every row is on the check's own list, with the handler the list names: a row can't be
   added, dropped or pointed somewhere else without the list saying so;
3. every row under `/api/trips/:trip` is wrapped by `inTrip()` (`src/trips/access.js`), and no
   other row is; and the wrapper, asked about a trip the caller isn't on, answers
   `404 "no such trip"` (with its reason) without running the handler. This is what makes "membership
   is checked once, in the route table" something that can fail;
4. every row is the first to fit its own path;
5. the parity recording reaches every row a request can reach;
6. the addresses from before a trip had an id stay gone (`src/old-addresses.js` went when the
   app moved to `/api/trips/<id>/…`, 14 Nov), and the map's old `/tiles/<key>` row stays only
   while something under `public/` still reads an archive there: the check **fails** once
   nothing does and the row is still in the table. `/tiles/fonts/*` is not an archive.

## When a route is changed on purpose

A deliberate change to what a route answers fails `check:parity`, and that is the point: the
failure lists exactly what changed. Read the list, and when every line of it is one you meant:

1. record twice and compare the two (`--record a.json`, `--record b.json`, `--diff a.json
   b.json`): no difference, or something in the answer is random and needs a name;
2. make one of them the new `golden.json`, and say in the commit what changed.

A new row in the table goes on `routes-check.mjs`'s list of added rows, and the scenario gets
a step that reaches it.

## What the recording has been

- **v54, from Pages.** The first recording was the Pages site (commit 051630b) answering the
  script, and the Worker was held to it when the server moved into `src/` (commit 109984b),
  with eight written-down allowances for the static file server.
- **Accounts made over.** Recorded again from the Worker. Against the v54 recording, outside
  the account routes themselves, what changed: static files no longer carry
  `Access-Control-Allow-Origin: *`; the invite routes are gone; an account on no trip gets 403
  `{"error":"no trip"}` from every trip route (reading `/api/trip` puts nobody on a trip);
  `/api/me` says `member` and takes `name`; `DELETE /api/me` is a route; a signed-out page
  request is sent to `/login?next=<where it was going>`; `/api/login` and unknown paths under
  `/api/auth/` are 401 signed out, where they used to get the app's page. Every other step of
  the trip's routes answered byte for byte as it did.
- **Accounts, the follow-up.** Six steps added (1,022). What changed in the old ones: a change
  asked for by another site's page is refused by the gate before the public routes run, so a
  cross-site `POST /login/google` now gets the gate's JSON 403 `{"error":"cross site"}` with
  `Cache-Control: no-store` where the route used to answer 403 in plain text; and a static
  file's `Content-Length` is recorded as `<length>` (it used to be the number, which failed
  the check whenever a file in `public/` changed). New: signing out, and starting a sign-in,
  asked for by another site's page or a sibling subdomain's form (403, no cookie set); and a
  page request for `/` from an account on no trip (302 to `/account`; the same address
  fetched by a script still answers the app's page).
- **The sign-in marks.** Six steps added (1,028), none of the old ones changed. `public/`
  gained one file, `/img/marks/google-g.png`, which the sign-in page shows before anyone is
  signed in: the gate lets that one address through signed out (200, the file), and any other
  address under `/img/marks/` is still sent to sign in. The other four steps are the new
  file's own, in the walk through every file in `public/`.
- **Trips.** Recorded again: 1,132 steps, and almost every answer of the trip's routes moved.
  What changed: every address of a trip is under `/api/trips/<id>/`; a trip is made by `POST
  /api/trips` and people join by a link (`/api/join/<code>`), where the script used to write
  member rows itself; an account that isn't on a trip gets `404 "no such trip"` (with its reason) from
  it, where an account on no trip used to get `403 {"error":"no trip"}` from everything (map
  data under `/tiles/` still answers that); every answer to a write, the snapshot, and every
  row carry `rev`; the snapshot's `trip` has `host_id`, `created_at`, `updated_at` and `rev`,
  and its `members` have `role` (`host` or `member`), `left_at`, `deleted` and `rev` and no
  `isAdmin`; `/api/me` no longer says `isAdmin` or `member`; a purchase has `kind`; the import
  takes `{ places, events }` for a trip that exists, from its host, and refuses a body without
  both lists. The app's files are answered by the file server to anyone, signed in or not, so
  no page request is redirected by the server any more, and a cross-site `POST /login` is the
  file server's `405`. Under `/api`, signed out is `401 {"error":"unauthorized"}` (it was
  text), an address nothing answers is `404 {"error":"no such route"}` and a wrong method is
  `405` with `Allow` (both used to get the app's page). The old addresses answer for an
  account on exactly one trip, and are the 404 for an account on none or several. New steps:
  making trips, links, joining, the people on a trip, leaving, removing, handing over, two
  trips at once. One step went: a rates refresh on an empty database reached the live rates
  provider, and made two recordings differ. `pages-routes.json` (the Pages route list the
  first move was held to) is gone with the rows it described.
- **Removed members, the trip's own currencies, and who is signed in.** Recorded again (1,134
  steps: the two files added to `public/` since are in it now). What changed: a trip in every
  answer has its own ordered `currencies` and `created_by`; every answer that starts a session
  (sign-up, sign-in, the old cookie carried over) also sets `wgp_who` to the account's id,
  which the recording keeps as the learned name (`<carol-uid-5>`); every sign-out clears it;
  a signed-in request without it is sent it, its `Max-Age` recorded as `<rest of the
  session>`; and a session cookie that finds no session is told to clear itself, the old
  cookie and `wgp_who`. No status changed. Migration 0018 changes no answer the script
  reaches: someone the host removed coming back by an old link is `check:trips`'s.
- **The host removing someone who had already left.** Recorded again. That removal now writes
  (it marks them removed, so an old link doesn't bring them back): its answer's `rev` is one
  higher, and so is every rev after it in the script (seven steps). Nothing else changed.
- **What a trip carries.** Recorded again: 1,212 steps. The import is gone (`404 no such
  route`): the scenario fills its trip through `PUT …/areas`, `PUT …/places` and `POST …/events`,
  and puts the first trip in through `tools/seed-trip.mjs` as a trip of its own, so its
  steps are the tool's requests and three reads. The old packing routes (views,
  sections, placements) are gone with their steps; new steps set the trip's lists and bags, put
  items in bags, tick per list and per day, and set starters, each refusal once. New steps
  for areas and places (every §16 refusal, the 180° line, bounds that would strand a place,
  what's in use), for an event's day (after the trip, a wrong year, the next day in its own
  zone), for the trip's dates from the other side, `interests` and `units`. Ids of places and
  events in the script are hyphenated (`p-hotel`, `e-lunch`): an underscore is refused on a
  new one. What changed in old steps: events are any member's to change and remove (the
  `not yours` 403s are 200s now); an event POSTed again with an id the trip has answers 200
  unchanged, whoever made it; the trip has `interests`; `/api/me` has `units`; events have
  `source` and no `scenario`; the snapshot has `areas`, `packing_lists`, `packing_ticks` and
  `packing_starters` in place of `packing_views` and `packing_sections`, and items no `done`.
- **Bags are added, never removed by being left out.** Recorded again: 1,216 steps. Two steps
  added: a member adds one bag to a list sending only that bag (the others stay), and the host
  removes it with `{ key, remove: true }`. "lists a bag that holds items removed" now says
  `remove: true`; its refusal says the count is everyone's and carries `held: [{key, items}]`.
  A rename sent without bags no longer rewrites the bags, so their `rev` stays. The two
  `/js/forget.js` static steps arrived with rework. The rest is the trip's `rev` moving by the
  two new writes.
- **No check reaches the rates provider.** Recorded again: 1,218 steps. Every server a check
  starts asks a stand-in on this machine for exchange rates (`checks/lib/server.mjs`,
  `FX_PROVIDER_URL`, honoured only on a loopback address), which answers fixed rates. A step
  whose body is reduced to an outline records no `content-length` (the real body's length had
  leaked into "fx refresh" and moved with the day's rates). Two static steps for
  `/js/packing-refusals.js` arrived with the Pack tab.
- **Storage.** Recorded again: 1,240 steps. Handing a trip over is an offer now: the steps
  offer, show the offer in the list of trips, decline, take back and accept it (both ways), and
  refuse each wrong caller. New steps for the host's meter (`/api/account/storage`), the trip's
  own map (`…/tiles`, none here), a board revoked by someone who is neither its maker nor the
  host, and deleting a trip (its name not typed; typed with spaces; the trip gone afterwards).
  What changed in old steps: `media/usage` is `404 no such media route`; the trip's address
  answers `DELETE` (`400 confirm` without the name, with what would go); the snapshot has
  `storage`, `handover` and `tiles`; a revoke answers `revoked`.
- **The pages outside a trip.** Recorded again: 1,257 steps. New steps: a trip's people (`GET
  …/people`) as a member and as the host; the page `/trips/<id>`; the app at `/t/<id>/` and
  `/t/<id>` (a 308 to the slash form); the new files' static steps. What changed in old steps:
  `GET /api/trips` names each trip's `host: { id, name }`; a join and a new trip give the
  person's colour in their own write, so the trip's `rev` no longer moves a second time after a
  join and the revs after it are lower.
- **Who made each board, and why it stopped.** Recorded again: 1,259 steps. The boards list
  (`…/collage/shares`) carries `created_by`, `revoked_at`, `revoked_why` and `memories`; each
  memory carries `boards`. Two static steps for `/js/trip-words.js`.
- **Pictures.** Recorded again: 1,284 steps. New steps: a picture on a place, an event, the
  cover and a receipt; each kind of refusal once; by address (and its refusals: http, a fourth
  redirect) through the far sites' stand-in; upload links made, used, used again and made up;
  removing. Keys and tokens are learned names; an upload link's end is `<now+15m>`. What
  changed in old steps: the snapshot's places and events carry `picture`, its trip `cover`, its
  purchases `receipt`; the meter's trips carry `pictures` and `receipts`; a trip's `goes` counts
  them.
- **The MCP.** Recorded again: 1,302 steps. New steps: the change list (none yet, an undo of a
  change that isn't there, clearing it as someone else and as the host), the connected apps
  (none, disconnecting one that isn't there, signed out), the approval page (no request, an
  answer that isn't the page's), starters added, changed and removed by a `PATCH` (and its
  refusals), and the new shared files `public/` serves.
- **MCP polish.** Two steps for one new file in `public/` (1,304); nothing else changed.
- **Every request within 50 D1 queries.** 1,309 steps: `PUT …/events` with no events and the
  events batches (added and changed, a refused row writing nothing, a delete of one there and one
  not), the packing items batch (and someone else's list refusing it). The old `events PUT` step
  is gone with what it sent.
- **The old addresses go.** 1,310 steps: the five steps on the one-trip addresses (`/api/trip`,
  `/api/events`, `/api/packing`) are gone with them; six for three new files in `public/`.
- **Refusals in sentences.** Recorded again: 122 answers gained a `reason`, nothing else changed.
  Then ten `403` reasons say who may, nothing else changed.
- **The first trip's areas.** The seed's 15 area rows (4 regions with bounds) in the `peru`
  steps' answers; nothing else changed.
- **Live updates.** One step (1,311): `GET …/live` that isn't a socket is `426`.
- **The chat.** 1,340 steps: 29 for messages (sent, about an event, the time before one, a place;
  sent again; the same id from someone else; about nothing there; the pages back and forward;
  edits and deletes, the host's and the author's; mute) and the rev's split. A chat write moves
  the trip's `rev`, so 110 later answers' revs moved on; `GET …/rev` carries `data_rev` and `seq`,
  the snapshot `chat` and `data_rev`; nothing else changed.
- **A place without a why, and Hike gone.** 1,332 steps: a person's place may come without a
  `why` now (an AI's still needs one), so that step writes and every later rev moves on by one;
  eight static steps went with the Hike tab's files.
- **A trip's map.** 1,336 steps: asking for a cut again (not the host, no map maker) and using an
  upload (one that isn't there, not the host); the snapshot's `tiles` carries the map's state.
- **A made-up trip in place of the first one.** Recorded again: 1,338 steps. The big trip the
  scenario seeds is `seed/demo-trip.json` (made up by `tools/demo-seed.mjs`, the first trip's
  size: 15 areas, 331 places, 60 events), so the first trip's 68 steps (`peru 01` …) are gone
  and the demo's 70 (`demo 01` …, `demo trip` and the three reads) are in their place: two more,
  for its packing lists and starters. Every other step answers as it did, the two recordings
  identical.
- **The made-up trip, grown.** Recorded again: 1,338 steps. Only the `demo` steps moved, because the
  demo trip changed: its trip names its currencies, the way there changes planes in a third
  zone, the trek's days are whole days, and no two of its timed events are at once (the
  generator refuses that now). Every other step answers as it did, and the two
  recordings are identical.
- **New messages on Your trips, and the files added since.** Recorded again: 1,356 steps. The 18
  answers of `GET /api/trips` gain each trip's `chat: { from_others }` and nothing else (held by
  a comparison with that field taken out). 18 new steps are the static ones for the files added to
  `public/` since the last recording, which `--compare` doesn't report because it walks the golden's
  steps: the socket's client and the chat (`live.js`, `chat.js`, `chat-dot.js`, `chat-read.js`,
  `css/chat.css`), the time zone's control (`zone-picker.js`, `css/zone-picker.css`) and the
  Agenda's plan sheet (`plan-editor.js`, `plan-form.js`). The two recordings are identical.
- **The trip's own areas.** Recorded again: 1,358 steps. The first file the new rule named: B's
  `public/js/areas.js` (`UNRECORDED public/js/areas.js`), now two static steps; nothing else
  changed, and the two recordings are identical.
- **The map's old address goes.** Recorded again: 1,359 steps. `/tiles/<key>` (an archive by its
  name) is gone now the app's map reads only the trip's own; `/tiles/fonts/*` is what is left
  there. The 21 steps that held the range server ask for their test archive under `fonts/` now,
  each answer as it was (only the request's path moved), and one new step holds that the old
  address answers a plain 404 "not found", not the app's page. The two recordings are identical.
- **A purchase's receipt, and the people page's cover (sw v85).** Recorded again: 1,385 steps.
  Against v84's, 48 differences: every purchase answer gains `receipt` (11 single, 4 in lists:
  null, none was hung in these steps), `GET …/people`'s trip gains `cover` (2: null), each with its
  content-length; and 6 static steps for the files added (`receipts.js`, `picture-make.js`,
  `picture-wait.js`). Nothing else changed, and the two recordings are identical.
- **Notifications of the chat (sw v87, migration 0028).** Recorded again on v86: 1,395 steps. Against v86's,
  8 new and nothing else changed: four push steps (the key and a subscription with no keys on this
  server, a subscription that isn't there, the key signed out) and `push.js`, `push-sw.js` as static
  steps. The two recordings are identical.
- **A memory's day (migration 0029).** Recorded again: 1,395 steps. Against v87's, 33 differences: the 11
  answers that carry a memory gain its `day`, `taken_at` and `at` (null, null and when it was posted, for
  memories posted without either), each with its length; nothing else. The two recordings are identical.
- **The plan and the assistant, L1 to L5 (sw v89, migrations 0030 to 0033).** Recorded again on v88: 1,408 steps.
  Against v88's, 11 new steps and nothing else changed: on a site that doesn't offer them, the plan's four routes
  (404 "not offered", Stripe's webhook too) and the assistant's seven (its page's room `{ offered: false }`, a
  conversation refused "not offered", none of the rest found, signed out 401). Every message answers as before
  (0033's columns show only on the assistant's kinds). The two recordings are identical.
- **The host's numbers, off for one trip (migration 0034).** Recorded again on v89: 1,409 steps. Against v89's, one new
  step: PUT …/assistant/off on a site without the assistant (404 "not offered"); nothing else changed. The two
  recordings are identical.
- **A person's export (L7, sw v92).** Recorded again on v91: 1,415 steps. Against v91's, two new steps: GET
  /api/account/export signed in (the file, an attachment) and signed out (401); nothing else changed. The two
  recordings are identical.
- **Since my last (migration 0036, sw v94).** Recorded again on v93: 1,417 steps. Against v93's, two new steps: the new
  file /js/shared/delta.js, served in and out; every snapshot answer as before (a whole answer is unchanged; ?since= is
  held by checks/trips/delta.mjs). The two recordings are identical.
- **The limits sweep (migration 0037, sw v98).** Recorded again on v97: 1,417 steps. Against v97's, one step: a write of
  too many rows gains its reason ("A write is at most 200 rows: send the rest in another."). The two recordings are
  identical.
- **Error reports (migration 0039, sw v100).** Recorded again on v100: 1,429 steps. Against v100's, twelve new steps
  (POST /api/errors signed out, signed in, not JSON and from another origin; the owner's page, list and clear for
  someone else and signed out, all 404; the two new files, /js/error-report.js and /js/shared/error-clean.js, served in
  and out), the board page's text with the reporter's script tag in it (five steps), and the account export's file name,
  whose date now reads `<today>` (lib.mjs: the UTC day a run was on, so the recording compares on a later day). The
  two recordings are identical.
- **The privacy page and terms, and a board's pictures cleaned (sw v102).** Recorded again: 1,435 steps. The scenario's
  thumbnail, board item and board video are real files now (the check library's WebP and JPEG, and an MP4's boxes):
  what is kept for a board or as a thumbnail is cleaned first, and bytes that aren't a picture or a movie are refused
  (415), which made those steps refusals and the steps after them run on keys that weren't there. Against v101's: six
  new steps (/privacy.html, /terms.html and /css/legal.css, in and out), the bodies those real files change (their
  sizes, the thumbnails, the board's items and its page, whose lightbox says `W×H`), and the trip's snapshots and the
  demo trip's, whose storage totals count those bytes. No status changed. The two recordings are identical.
- **Guests (migration 0040, sw v104).** Recorded again on v103: 1,440 steps. Against v103's, 127 differences:
  - every person the server describes says whether they are a guest (`"guest":false` on /api/me, the trip's members and
    people, the join answers, an account's ways to sign in, the export; the demo trip's hash moves by that one field);
  - joining by a link signed out without a name is now a 400 that asks for one, where it was 401 (a guest joins with a
    name alone);
  - three new steps refuse a link to sign someone in again: not the host 403, a person with an account 409, someone
    never on the trip 404;
  - the new file /js/guest.js is served in and out (two steps).
  The two recordings are identical.
- **The guest's words name only this site's ways in (sw v106).** Recorded again: 1,440 steps. Against v105's, one step:
  the rejoin link refused for a person with an account says "with their passkey." where it said "with their passkey,
  Google or GitHub.": the parity server sets up neither, and a sentence names only the ways a site has
  (src/accounts/guests.js waysIn). The two recordings are identical.
- **A shared board's page: no focus ring under a finger, and a lightbox that opens on the tile's own print.**
  Recorded again: 1,440 steps. Against v106's, five steps, each the board page's text (the page, its trailing slash, an
  upper-case id, signed in, and the second board with no items): src/share-page.js gained the focus rule and the
  lightbox's print (1,723 characters more). No status or header changed. The two recordings are identical.
- **The board page's lightbox waits for its print, and its openings take turns.** Recorded again: 1,440 steps. Against
  the record above, the same five board-page steps, the page's text only: src/share-page.js shows the lightbox once the
  tile's print has decoded, and a close or a newer step makes an older opening do nothing (635 bytes more). No status
  or header changed. The two recordings are identical.
- **A shared board on the wall (migration 0041), and the cork a texture of its own.** Recorded again: 1,446 steps.
  Against the record above, 17 steps:
  - The board page's text, its five steps (the page, its trailing slash, an upper-case id, signed in, and the second
    board with no items): src/share-page.js draws the board in its material on the wall with the app's look
    (board-look.js, fasteners.js), and a photograph sent without a pin is pinned by its place on the board.
  - `/img/ambientcg-cork003-1k-color.jpg` is gone (its gate step and its two static steps). `/textures/cork.jpg` (its
    gate step and two static steps) is the cork now.
  - `/js/shared/board-look.js`, `/js/shared/fasteners.js` and `/textures/README.md` are served (two static steps each).
  No status or header changed. The two recordings are identical.
- **A shared board's page keeps its edge controls out of the safe areas (sw v110).** Recorded again: 1,446 steps.
  Against the record above, the same five board-page steps, the page's text only: src/share-page.js sets the zoom tools,
  the wordmark and the lightbox's ×, ‹, › and count at max(their margin, the screen's safe-area inset) (549 characters
  more, the same on each). No status or header changed. The two recordings are identical.
- **No cache keeps an API answer, and no other site frames the app's pages (sw v111).** Recorded again: 1,446 steps.
  Against the record above, headers only; no status or body changed:
  - `cache-control: no-store` on 663 API steps: src/api/json.js gives it to every JSON answer that sets no
    Cache-Control of its own (the exchange rates keep theirs).
  - `x-frame-options: DENY` and `content-security-policy: frame-ancestors 'none'` on 596 static steps, from the `/*`
    rule in public/_headers. /s/ is built by the Worker, so a shared board's page stays embeddable.
  - The same two on the two /authorize steps (the page with no request, and an answer that isn't the page's): the
    pages src/mcp/oauth.js draws set them themselves, since public/_headers can't reach Worker HTML.
  - `x-content-type-options: nosniff` on 20 plain-text error steps of /media, /tiles and /s/ (16 404s, two 400s and
    two 405s).
  - The seven /s/ "Not found" steps: `content-type: text/plain;charset=UTF-8` became `text/plain; charset=utf-8`, the
    type src/share-page.js now sets on that answer itself.
  The two recordings are identical.
- **A shared board's files answer Range (sw v112).** Recorded again: 1,446 steps. Against the record above, headers
  only, on the six steps that fetch a board's files (its picture, its video, items 0 and 1, item 0's thumb and an old
  /lod/ address): each gained `accept-ranges: bytes`, the object's `etag` and `x-content-type-options: nosniff`, as
  src/share-page.js now serves them through src/media-files.js rangedGet. No status or body changed; /media/'s own
  range steps are unchanged. The two recordings are identical.
- **A write sent again answers as the first did (migration 0042).** Recorded again: 1,446 steps. Against the record
  above, one step: "media finish again", finishing an upload a second time after it stored the file, was 409 `{"error":
  "upload already stored"}` and is now 200 with what the first finish answered (`ok`, `key`, `bytes`, `mime`, `url`,
  `etag`, `rev`), as src/api/media.js answers a finish sent again for the same upload by the same person. Its
  content-length went from 145 to 298. Nothing else changed. The two recordings are identical.
- **The heading face is Bricolage Grotesque (sw v116).** Recorded again: 1,446 steps. Against the record above: the
  four steps of Fraunces's two files (the font and its licence, in and out) are gone with the files, and four are new,
  in and out for Bricolage Grotesque's font file and its licence. Nothing else changed. The two recordings are
  identical.
- **A dark phone with nothing chosen is Void (sw v117).** Recorded again: 1,446 steps. Against the record above: the
  five board pages' bodies (/s/<share-1>, with a trailing slash, in upper case, signed in, and /s/<share-2>), as the
  wordmark each carries is inked in Void's off-white (#f4f4f6) on a dark phone where it was Slate's (#eef1f5). Nothing
  else changed: the sign-in client ids in wrangler.jsonc change no answer while their secrets are unset. The two
  recordings are identical.
- **The first trip's own pictures are out of public/img (sw v118).** Recorded again: 1,254 steps. Against the record
  above: the 96 files' static steps (in and out, 192) are gone with the files, and the signed-out /img step asks for
  /img/demo-card.webp, a picture still served, where it asked for one of the trip's. Nothing else changed. The two
  recordings are identical.
- **A drawn picture in place of the initials (migration 0043).** Recorded again: 1,272 steps. Against the record above:
  every one of its 1,254 steps is the same, so someone who never draws meets the app exactly as before. 18 steps are
  new: the format module's two static steps (/js/shared/avatar.js, in and out), and sixteen at the end. Those draw a
  fixed picture, send it again, read it as its own person, as a trip-mate, as someone on no trip with it, signed out and
  by names nobody holds, go back to initials, and read it once gone. The two recordings are identical.
- **The same, on v119 (rework bccd692).** Recorded again: 1,274 steps. Against the record above: /js/net.js (v119's
  new file) has its two static steps, in and out; and the four picture reads that answer 404 now say why in words (one
  sentence, the same for a name nobody holds and one the person may not see), so their bodies and lengths moved.
  Nothing else changed. The two recordings are identical.
- **The same, with the design system (sw v120, on rework c1b8da6).** Recorded again: 1,330 steps. Against the record
  above: the 28 public files the design system, the shell, the logo and the pad add each have their two static steps,
  in and out (design.html, public/ds/ (15), icons/icon-180.png, js/hikers-player.js, js/logo-player.js,
  logo/idle-60.json, logo/wordmark-data.json, the Geist Mono and Instrument Sans files with their licences,
  vendor/perfect-freehand/ (3)); the shared board's page (/s/<share>, its five reads) inlines the new wordmark in the
  logo's own colours; and the MCP's consent page (/authorize, its two reads) links the design system's tokens, where
  the logo's colours now are. Nothing else changed. The two recordings are identical.
- **Split on the design system, and the picture's two files.** Recorded again: 1,334 steps. Against the record above:
  the four static steps of public/js/account-picture.js and public/js/pictures.js (added with the picture you draw,
  which reached rework without steps of their own), in and out. Split's screens add no step and change none. The two
  recordings are identical.
- **Flow 7's files, and the paid plan's landing.** Recorded again: 1,336 steps. Against the record above: the two
  static steps of public/js/pack-count.js (added with flow 7 without steps of its own), in and out, and /authorize's
  answer, which serves the app page and so carries its theme script's new lines (retired looks go to the nearest).
  The landing's own changes (the assistant's caps, the tool-answer cut, the Terms and the privacy page, 0019 on a
  remote D1) add no step and change none. The two recordings are identical.
- **Flows 3–6 on the design system (sw v127).** Recorded again: 1,340 steps. Against the record above: the four
  static steps of public/js/plan-ai.js and public/js/shared/first-ask.js (added by Flow 3: Itinerary, Plan with your
  AI), in and out. None of the existing 1,336 steps changed (Itinerary, Places, Chat, Changes and Photos add or modify
  only existing files). The two recordings are identical.
- **On any port.** Recorded again: 1,340 steps. The server's own address is now `<origin>` (7 places: redirects'
  locations, a page that names itself), so the recording no longer names port 8791 and the check takes a free port.
  Nothing else changed (each other difference is a length that changed with it). Recorded on two different ports:
  identical. Planted with the origin not learned, two ports
  differ (16 places).

- **Documents given the assistant, on flow 8.** Recorded again on flow 8's tip: 1,346 steps, recorded twice, 0
  differences between the two. Against flow 8's own recording: the four routes of a person's documents in their own
  conversation (upload, list, original, delete), each a 404 in words for a conversation or a file that isn't the
  person's; and what flow 8 had not recorded: public/css/signin.css's two static steps, the sign-in and consent pages
  /authorize serves (GET and POST), and the shared board's page (/s/<share>, its five reads: the new wordmark). Nothing
  else moved.
- **Documents given the assistant, on the follow-up train.** Recorded again on the follow-up train's tip (v136): 1,348
  steps, recorded twice, 0 differences between the two. Against that train's own recording, only the four routes of a
  person's documents in their own conversation (upload, list, original, delete) are new. Nothing else moved.
- **Photos without the List view, and Invite people.** Recorded again on bundle 1's tip (on v154): 1,354 steps, recorded
  twice, 0 differences between the two. Against the recording before it: public/js/memories-list.js and
  public/css/memories-list.css's static steps gone (the files retired with the List view), public/js/invite.js's two
  static steps new. Nothing else moved.
- **Report a bug (migration 0047).** Recorded again on v162's tip: 1,368 steps, recorded twice, 0 differences between the two.
  Against the record above:
  - **New steps:** a bug report signed out and signed in (the same 201 { ok }), one that isn't a form (400 in words),
    a screenshot that isn't the asker's (404), and the operator's list and one report for someone ADMIN_ACCOUNTS
    doesn't name (404). Also the static steps of public/report.html, js/report-form.js, js/report-page.js and
    js/shared/bug-rules.js, in and out.
  - **Moved on purpose:** POST /api/errors answers 200 { group } (its kind's fingerprint) where it answered 204, and
    the account export gains `bug_reports: []`. A page from before, which reads nothing back, is counted the same
    (check:errors).
  - Nothing else moved.
- **The trip's quick reference list (migration 0048).** Recorded again: 1,380 steps, recorded twice, 0 differences
  between the two.
  - **New steps** (near the end, so no rev before them moves): the list read, an item added and the same add sent
    again (the same row), one with no title (400 in words), one changed and one that isn't there (404), a list put
    and removed, one removed and removed again. Also the static steps of public/js/references.js, in and out.
  - **Moved on purpose:** every trip snapshot gains `references: []`, sent always (an absent collection reads as
    unchanged on a phone).
  - Nothing else moved.

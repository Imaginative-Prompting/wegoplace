// WHAT EACH WRITE MAY DO, AND HOW MUCH: the limits of every row of src/routes.js that writes (and the reads a
// stranger could flood), written once, in words. checks/limits/sweep.mjs reads the route table itself and fails
// a write row with no limit written here; then it crosses each limit and holds what happens.
//
// The kinds of limit (`by`), each crossed by the sweep on every row that names it:
//   connection:<what>   60 tries a minute from one connection (AUTH_LIMITER, keyed by what): 429, a reason, Retry-After
//   pictures:<what>     PICTURE_FETCHES_PER_MINUTE a minute an account (PICTURE_LIMITER): 429, a reason, Retry-After
//   chat                MESSAGES_PER_MINUTE a minute a person: 429; MESSAGES_PER_TRIP_MAX a trip: 409
//   room                the host's room (FREE_STORAGE_BYTES, or the plan's pool): bytes that would cross it are
//                       refused whole, 413 "storage full", before anything reaches the bucket
//   rows                ROWS_PER_WRITE_MAX rows a write, and the trip's own caps (named in the words)
//   size                the most one thing may be (named in the words): 413
//   map-plans           10 maps planned a trip a minute (MAP_PLAN_LIMITER): 429, a reason, Retry-After
//   json                JSON_BODY_MAX bytes a request's JSON (every route): 413 before it's read
//   phones, boards, conversations, purchases, exports   the caps on how many (public/js/shared/limits.js)
//   guests              people made by joining with only a name: GUESTS_PER_ADDRESS_HOUR an address an hour and
//                       GUESTS_PER_LINK_HOUR a link an hour, counted in the database: 429, a reason, Retry-After
//   rejoins             a host's links to sign a guest in again: REJOIN_LINKS_PER_HOUR a host an hour: 429, likewise
//   avatars             changes to one's drawn picture: AVATAR_WRITES_PER_HOUR an account an hour, counted in the
//                       database: 429, a reason, Retry-After (crossed by check:avatar, which holds nothing is written)
//   bugs                bug reports: BUG_LIMITER per account or connection a minute, and the day's guards in the write
//                       (an account's, and every signed-out report's together): crossed by check:bug-reports
//   none                no limit in time of its own, and why that's enough (written)
// Everyone in the sweep is made up.

import {
  AREAS_MAX, EVENTS_MAX, FREE_STORAGE_BYTES, JSON_BODY_MAX, LINK_USES_MAX, LINKS_LIVE_MAX, MESSAGE_MAX, MESSAGES_PER_MINUTE,
  MESSAGES_PER_TRIP_MAX, PACKING_ITEMS_PER_OWNER_MAX, PUSH_PHONES_MAX, BOARDS_PER_TRIP_MAX, CONVERSATIONS_PER_PERSON_MAX,
  PURCHASES_PER_TRIP_MAX, EXPORTS_PER_HOUR, PACKING_LISTS_MAX, PACKING_STARTERS_MAX, PICTURE_FETCHES_PER_MINUTE, PICTURE_LINK_SECONDS,
  PICTURE_LIMITS, PLACES_MAX, ROWS_PER_WRITE_MAX, TRIP_MEMBERS_MAX, TRIPS_HOSTED_MAX, MAP_UPLOAD_MAX_BYTES,
  GUESTS_PER_ADDRESS_HOUR, GUESTS_PER_LINK_HOUR, REJOIN_LINK_HOURS, REJOIN_LINKS_PER_HOUR, AVATAR_WRITES_PER_HOUR,
  REFERENCES_MAX, REFERENCE_TITLE_MAX, REFERENCE_TEXT_MAX,
} from "../../public/js/shared/limits.js";

const GB = FREE_STORAGE_BYTES / 1024 ** 3;
const AUTH = (what) => `60 tries a minute from one connection ("${what}")`;
const TRIP_WRITE = `Only the trip's people write it, ${ROWS_PER_WRITE_MAX} rows at most a write`;
const r = (limit, by) => ({ limit, by });

export const LIMITS = {
  // ── signing in and accounts: what a stranger can reach ──
  "POST /api/auth/register/options": r(`${AUTH("auth")}: an account's passkey challenge (making accounts can't be flooded faster than this).`, ["connection:auth"]),
  "POST /api/auth/register/verify": r(`${AUTH("verify")}; the challenge is used once.`, ["connection:verify"]),
  "POST /api/auth/login/options": r(`${AUTH("auth")}.`, ["connection:auth"]),
  "POST /api/auth/login/verify": r(`${AUTH("verify")}.`, ["connection:verify"]),
  "POST /api/auth/passkeys/options": r(`${AUTH("auth")}; signed in (each asks a challenge of the database).`, ["connection:auth"]),
  "POST /api/auth/passkeys/verify": r(`${AUTH("verify")}; signed in.`, ["connection:verify"]),
  "POST /api/auth/pending/create": r("Only with a waiting sign-in from Google or GitHub, which their own limit made (60 a minute a connection, \"signin\").", ["none"]),
  "POST /api/auth/pending/attach": r("Signed in, with a waiting sign-in made under its limit; nothing to repeat.", ["none"]),
  "POST /api/auth/recover/confirm": r(`${AUTH("verify")}; a code takes 5 tries, then it's used up.`, ["connection:verify"]),
  "POST /api/auth/recover": r(`${AUTH("auth")}; and 5 codes an hour an address (429, a reason, Retry-After an hour).`, ["connection:auth"]),
  "POST /api/auth/link": r(`${AUTH("verify")}; a sign-in link's token is 43 characters of random (256 bits) and used once.`, ["connection:verify"]),
  "POST /api/auth/logout/all": r("Ends the caller's own sessions; nothing grows.", ["none"]),
  "POST /api/auth/logout": r("Ends the caller's own session; nothing grows.", ["none"]),
  "DELETE /api/auth/ways/passkey/:id": r("Removes the caller's own; nothing grows.", ["none"]),
  "DELETE /api/auth/ways/:provider/:subject": r("Removes the caller's own; nothing grows.", ["none"]),
  "POST /api/account/email/confirm": r("Signed in; a code takes 5 tries, then it's used up.", ["none"]),
  "POST /api/account/email": r("Signed in; 5 codes an hour an address (429, a reason, Retry-After an hour).", ["none"]),
  "DELETE /api/account/email": r("Removes the caller's own; nothing grows.", ["none"]),
  "POST /api/account/plan/checkout": r("Signed in; one Checkout open at a time (a second asks the same one back).", ["none"]),
  "POST /api/account/plan/portal": r("Signed in, with a plan; a Portal session is Stripe's.", ["none"]),
  "POST /api/billing/stripe": r("Only Stripe's signature; each event handled once.", ["none"]),
  "PATCH /api/me": r("Signed in; a name is 40 characters.", ["none"]),
  "DELETE /api/me": r("Deletes the caller's own account.", ["none"]),
  "PUT /api/me/avatar": r(`Signed in; one picture at most 16 KiB (413 past it), ${AVATAR_WRITES_PER_HOUR} changes an hour an account: 429, a reason, Retry-After.`, ["size", "avatars"]),
  "DELETE /api/me/avatar": r(`Signed in; back to initials counts among the ${AVATAR_WRITES_PER_HOUR} changes an hour: 429, a reason, Retry-After.`, ["avatars"]),
  // A form posted from the sign-in page: past its tries it goes back to that page, which says to wait (303).
  "POST /login/:provider": { ...r(`${AUTH("signin")}; past them, back to the sign-in page, which says to wait a minute.`, ["connection:signin"]), busy: true },
  "POST /api/fx/refresh": r("Signed in; the rates' provider is asked at most once a minute (an isolate's own throttle), whoever asks.", ["none"]),
  "* /api/fx": r("Answers 405 for a method it doesn't serve.", ["none"]),
  "POST /authorize": r("Signed in; only the answer to the page this person was shown, once.", ["none"]),
  "DELETE /api/account/apps/:id": r("Removes the caller's own; nothing grows.", ["none"]),
  "POST /api/errors": r(`${AUTH("errors")}; a report at most 8 KB (413); at most 60 written a minute per isolate (the rest counted into the next), at most 500 kinds kept (past it, one overflow row a source), and a kind goes 30 days after it was last seen (the cron).`, ["connection:errors"]),
  "POST /api/bug-reports": r("5 a minute an account, or a connection signed out (BUG_LIMITER): 429, a reason, Retry-After; an account 10 a day and every signed-out report together 100 a day, guards in the write itself (429); the text 2,000 characters, the screenshot 2 MB and a PNG, JPEG or WebP by its own bytes, the request read only up to its cap (413); a report goes 90 days after it was sent (the cron). Crossed by check:bug-reports, which holds nothing is written past each.", ["bugs"]),
  "POST /api/admin/errors/clear": r("The site owner's alone (404 for everyone else); removes kinds, nothing grows.", ["none"]),
  "PUT /api/account/push": r(`Signed in; one row a phone's push address (sent again, it's the same row); ${PUSH_PHONES_MAX} phones an account, the next replacing the one least recently seen (never refused: a new phone is never stuck).`, ["phones"]),
  "DELETE /api/account/push": r("Removes the caller's own; nothing grows.", ["none"]),

  // ── trips, joining ──
  "POST /api/trips": r(`Signed in; ${TRIPS_HOSTED_MAX} trips hosted an account.`, ["rows"]),
  "POST /api/join/:code": r(`${AUTH("join")}; a code is 22 characters of random (128 bits), at most ${LINK_USES_MAX} uses; a trip holds ${TRIP_MEMBERS_MAX} people. Signed out, it makes a guest: ${GUESTS_PER_ADDRESS_HOUR} an address an hour and ${GUESTS_PER_LINK_HOUR} a link an hour.`, ["connection:join", "guests"]),
  "PUT /pictures/upload/:token": r(`Only the link's token (43 characters of random), once, for ${PICTURE_LINK_SECONDS / 60} minutes; ${PICTURE_LIMITS.picture.bytes / 1024} KB a picture; the host's room.`, ["room", "size"]),
  "DELETE /api/trips/:trip/members/:user": r("The host removes, a member leaves; nothing grows.", ["none"]),
  "POST /api/trips/:trip/members/:user/rejoin": r(`The host only, for a guest on the trip; ${REJOIN_LINKS_PER_HOUR} links a host an hour, each 43 characters of random, used once, for ${REJOIN_LINK_HOURS} hours.`, ["rejoins"]),
  "POST /api/trips/:trip/host/accept": r("Only the person offered; once.", ["none"]),
  "POST /api/trips/:trip/host/decline": r("Only the person offered; once.", ["none"]),
  "POST /api/trips/:trip/host": r("The host; one offer at a time.", ["none"]),
  "DELETE /api/trips/:trip/host": r("The host; nothing grows.", ["none"]),
  "* /api/trips/:trip/tiles": r("A read of the trip's map by range; other methods answer 405.", ["none"]),
  "POST /api/trips/:trip/tiles/cut": r("The host; 12 cuts a trip a day (MAP_CUTS_PER_DAY), one at a time.", ["none"]),
  "POST /api/trips/:trip/tiles/plan": r("On the trip; 10 plans a trip a minute (MAP_PLAN_LIMITER), on a site with a map maker (without one it answers 503 first).", ["map-plans"]),
  "POST /api/trips/:trip/tiles/use": r(`The host; an upload of at most ${MAP_UPLOAD_MAX_BYTES / 1024 / 1024} MB, already counted in the host's room.`, ["none"]),
  "POST /api/trips/:trip/links": r(`On the trip; ${LINKS_LIVE_MAX} live links a trip.`, ["rows"]),
  "DELETE /api/trips/:trip/links/:id": r("The host; nothing grows.", ["none"]),
  "DELETE /api/trips/:trip/changes": r("The host; nothing grows.", ["none"]),
  "POST /api/trips/:trip/changes/:id/undo": r("On the trip; a change is undone once.", ["none"]),
  "PUT /api/trips/:trip/areas": r(`${TRIP_WRITE}; a trip holds ${AREAS_MAX} areas.`, ["rows"]),
  "DELETE /api/trips/:trip/areas": r(`${TRIP_WRITE}; nothing grows.`, ["none"]),
  "DELETE /api/trips/:trip/areas/:id": r("Nothing grows.", ["none"]),
  "PUT /api/trips/:trip/places": r(`${TRIP_WRITE}; a trip holds ${PLACES_MAX} places.`, ["rows"]),
  "POST /api/trips/:trip/references": r(`One item; a trip's quick reference holds ${REFERENCES_MAX}, a title ${REFERENCE_TITLE_MAX} characters, a text ${REFERENCE_TEXT_MAX}.`, ["rows"]),
  "PUT /api/trips/:trip/references": r(`${TRIP_WRITE}; a trip's quick reference holds ${REFERENCES_MAX}.`, ["rows"]),
  "PATCH /api/trips/:trip/references/:id": r(`One item; its title ${REFERENCE_TITLE_MAX} characters and text ${REFERENCE_TEXT_MAX}; nothing grows.`, ["none"]),
  "DELETE /api/trips/:trip/references/:id": r("Nothing grows.", ["none"]),
  "DELETE /api/trips/:trip/references": r(`${TRIP_WRITE}; nothing grows.`, ["none"]),
  "DELETE /api/trips/:trip/places": r(`${TRIP_WRITE}; nothing grows.`, ["none"]),
  "DELETE /api/trips/:trip/places/:id": r("Nothing grows.", ["none"]),
  "PUT /api/trips/:trip/packing/lists": r(`${TRIP_WRITE}; a trip holds ${PACKING_LISTS_MAX} lists of 8 bags.`, ["rows"]),
  "DELETE /api/trips/:trip/packing/lists/:key": r("Nothing grows.", ["none"]),
  "PUT /api/trips/:trip/packing/starters": r(`${TRIP_WRITE}; a trip holds ${PACKING_STARTERS_MAX} starters.`, ["rows"]),
  "PATCH /api/trips/:trip/packing/starters": r(`${TRIP_WRITE}; a trip holds ${PACKING_STARTERS_MAX} starters.`, ["rows"]),
  "PUT /api/trips/:trip/packing/ticks": r("One tick a write, on an item that has a bag there; nothing grows past the items.", ["none"]),
  "PUT /api/trips/:trip/packing/items": r(`${TRIP_WRITE}; ${PACKING_ITEMS_PER_OWNER_MAX} items a list (a person's own, or the group's).`, ["rows"]),
  "DELETE /api/trips/:trip/events/:id": r("Nothing grows.", ["none"]),
  "PATCH /api/trips/:trip/events/:id": r("One plan; nothing grows.", ["none"]),
  "DELETE /api/trips/:trip/packing/:id": r("Nothing grows.", ["none"]),
  "PATCH /api/trips/:trip/packing/:id": r("One item; nothing grows.", ["none"]),
  "DELETE /api/trips/:trip/purchases/:id": r("Nothing grows.", ["none"]),
  "PUT /api/trips/:trip/pictures/cover": r(`On the trip; ${PICTURE_LIMITS.picture.bytes / 1024} KB a picture; the host's room.`, ["room", "size"]),
  "DELETE /api/trips/:trip/pictures/cover": r("Nothing grows.", ["none"]),
  "POST /api/trips/:trip/pictures/cover/from-url": r(`${PICTURE_FETCHES_PER_MINUTE} fetches a minute an account; ${PICTURE_LIMITS.picture.bytes / 1024} KB; room for the most a picture may be, before anything is fetched.`, ["pictures:fetch", "room"]),
  "POST /api/trips/:trip/pictures/cover/upload-link": r(`${PICTURE_FETCHES_PER_MINUTE} links a minute an account; a link stores nothing (the picture sent to it is counted when it comes).`, ["pictures:link"]),
  "PUT /api/trips/:trip/pictures/:kind/:id": r(`On the trip; ${PICTURE_LIMITS.picture.bytes / 1024} KB a picture; the host's room.`, ["room", "size"]),
  "DELETE /api/trips/:trip/pictures/:kind/:id": r("Nothing grows.", ["none"]),
  "POST /api/trips/:trip/pictures/:kind/:id/from-url": r(`${PICTURE_FETCHES_PER_MINUTE} fetches a minute an account; room for the most a picture may be, before anything is fetched.`, ["pictures:fetch", "room"]),
  "POST /api/trips/:trip/pictures/:kind/:id/upload-link": r(`${PICTURE_FETCHES_PER_MINUTE} links a minute an account; a link stores nothing (the picture sent to it is counted when it comes).`, ["pictures:link"]),
  "PATCH /api/trips/:trip/purchases/:id": r("One purchase; nothing grows.", ["none"]),
  "* /api/trips/:trip/collage/:path*": r(`Boards: ${BOARDS_PER_TRIP_MAX} shared at once a trip; 12 MB a picture, 40 MB a video; the host's room.`, ["room", "size", "boards"]),
  "* /api/trips/:trip/media/:path*": r("Uploads: 8 GiB a file declared (and so the host's room), in parts of a fixed size, 10,000 parts; a thumbnail's own size.", ["room", "size"]),
  "* /api/trips/:trip/memories/:path*": r("A memory: 40 photographs or videos, 8 tags, 2,000 characters; made of the person's own uploads (counted when uploaded).", ["size"]),
  "POST /api/trips/:trip/events": r(`One plan; a trip holds ${EVENTS_MAX} plans.`, ["rows"]),
  "PUT /api/trips/:trip/events": r(`${TRIP_WRITE}; a trip holds ${EVENTS_MAX} plans.`, ["rows"]),
  "DELETE /api/trips/:trip/events": r(`${TRIP_WRITE}; nothing grows.`, ["none"]),
  "POST /api/trips/:trip/messages": r(`${MESSAGES_PER_MINUTE} messages a minute a person; ${MESSAGE_MAX.toLocaleString("en-US")} characters; a chat holds ${MESSAGES_PER_TRIP_MAX.toLocaleString("en-US")}.`, ["chat"]),
  "PATCH /api/trips/:trip/messages/:id": r(`Its writer; ${MESSAGE_MAX.toLocaleString("en-US")} characters; nothing grows.`, ["none"]),
  "DELETE /api/trips/:trip/messages/:id": r("Its writer or the host; nothing grows.", ["none"]),
  "PUT /api/trips/:trip/chat/mute": r("The caller's own; nothing grows.", ["none"]),
  "PUT /api/trips/:trip/assistant/off": r("The host; nothing grows.", ["none"]),
  "POST /api/trips/:trip/assistant/conversations": r(`On the trip, with the assistant offered; ${CONVERSATIONS_PER_PERSON_MAX} conversations a person a trip, the next refused in words (delete an old one first), never one dropped.`, ["conversations"]),
  "DELETE /api/trips/:trip/assistant/conversations/:id": r("The caller's own; nothing grows.", ["none"]),
  "POST /api/trips/:trip/assistant/conversations/:id/ask": r("One ask a trip at a time (429, a reason, Retry-After); 2,000 characters; the host's month of the assistant (check:assistant-meter holds it).", ["size"]),
  "POST /api/trips/:trip/assistant/conversations/:id/files": r("A document of the caller's own conversation: each kind's most in bytes (PDF and office 10 MB, pictures 5 MB, text, Markdown and CSV 1 MB: 413, and a length past every kind's most before anything is read), 500,000 characters of text (422), 5 a conversation (409, in the conditional insert), ASSISTANT_FILES_PER_HOUR ATTEMPTS an account an hour, kept or not (429, a reason, Retry-After), and the host's room, the original and what its text may take held by one conditional insert (413 storage full, nothing kept). The room, the counts and the text cap are crossed by check:assistant-documents (under the plan the room is the plan's pool, set small there).", ["size"]),
  "DELETE /api/trips/:trip/assistant/conversations/:id/files/:file": r("Only the caller's own file; its objects go through the drain.", ["none"]),
  "POST /api/trips/:trip/assistant/conversations/:id/share": r("One answer of the caller's own, shared once; a chat message's own limits.", ["none"]),
  "DELETE /api/trips/:trip/packing": r("Nothing grows.", ["none"]),
  "PATCH /api/trips/:trip/packing": r("One item; nothing grows.", ["none"]),
  "POST /api/trips/:trip/packing": r(`One item; ${PACKING_ITEMS_PER_OWNER_MAX} items a list.`, ["rows"]),
  "POST /api/trips/:trip/purchases": r(`One purchase; ${PURCHASES_PER_TRIP_MAX.toLocaleString("en-US")} purchases and payments a trip (one sent again isn't a new one).`, ["purchases"]),
  "PATCH /api/trips/:trip": r("The trip's details; nothing grows.", ["none"]),
  "DELETE /api/trips/:trip": r("The host; nothing grows.", ["none"]),
  "* /media/:path*": r("Files, read; other methods 405.", ["none"]),
  "* /tiles/fonts/:path*": r("The map's fonts, read; other methods 405.", ["none"]),
};

// Reads a stranger, or anyone signed in, could flood: their limits too.
export const READS = {
  "GET /api/join/:code": r(`${AUTH("join")}: a join link's page, before joining.`, ["connection:join"]),
  "GET /api/account/export": r(`Signed in; ${EXPORTS_PER_HOUR} an hour an account (each reads the whole account): 429, a reason, Retry-After.`, ["exports"]),
};

// Every path that writes bytes into a bucket: each counted against the host's room before anything is stored.
// [the route row, what it stores, how the sweep sends it]
export const BYTE_PATHS = [
  ["* /api/trips/:trip/media/:path*", "a memory's photo or video, or a map uploaded (media/begin reserves the whole file)"],
  ["* /api/trips/:trip/media/:path*", "a file's thumbnail (media/thumb)"],
  ["PUT /api/trips/:trip/pictures/cover", "the trip's cover"],
  ["PUT /api/trips/:trip/pictures/:kind/:id", "a place's, a plan's or a receipt's picture"],
  // The one write a refusal leaves: the link is used up by its first upload, even one refused (src/mcp/guides/pictures.md).
  ["PUT /pictures/upload/:token", "a picture sent to an upload link (refused, the link is used up, as its guide says; nothing else written)"],
  ["POST /api/trips/:trip/pictures/:kind/:id/from-url", "a picture fetched by address (room for the most a picture may be, before fetching)"],
  ["* /api/trips/:trip/collage/:path*", "a board's picture"],
  ["* /api/trips/:trip/collage/:path*", "a board's video"],
  ["* /api/trips/:trip/collage/:path*", "a board's photo or video item"],
];

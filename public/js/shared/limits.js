// Limits the app and the Worker both hold to: one copy, so a form can say the number the
// server will refuse at. Pure data: no imports, nothing that runs.

// ── trips ────────────────────────────────────────────────────────────────────────────────
/** A trip's name, in characters. */
export const TRIP_NAME_MAX = 80;
/** Trips one account may host at a time (being on other people's trips doesn't count). */
export const TRIPS_HOSTED_MAX = 20;
/** People on one trip at a time (someone who left doesn't count). */
export const TRIP_MEMBERS_MAX = 30;
/** Currencies on a trip's own short list. */
export const TRIP_CURRENCIES_MAX = 12;

// ── the links people join a trip by ──────────────────────────────────────────────────────
/** Days a link lasts when its maker doesn't say, and the most they may ask for. */
export const LINK_DAYS_DEFAULT = 7;
export const LINK_DAYS_MAX = 30;
/** People a link can put on the trip when its maker doesn't say, and the most they may ask for. */
export const LINK_USES_DEFAULT = 10;
export const LINK_USES_MAX = 50;
/** Links of one trip that can be in use at once (not expired, not used up, not revoked). */
export const LINKS_LIVE_MAX = 20;
/** Guests (people who join with only a name) made in an hour from one address: a group on one lodging's Wi-Fi is one. */
export const GUESTS_PER_ADDRESS_HOUR = 20;
/** Guests one join link may make in an hour: a whole trip's worth. */
export const GUESTS_PER_LINK_HOUR = TRIP_MEMBERS_MAX;
/** Links a host may make in an hour to sign a guest in again on a new phone, and the hours each works. */
export const REJOIN_LINKS_PER_HOUR = 10;
export const REJOIN_LINK_HOURS = 2;

// ── a person's drawn picture (src/accounts/avatar.js) ───────────────────────────────────────
/** Changes to one's picture (a new one, or back to initials) in an hour: each moves every trip one is on. */
export const AVATAR_WRITES_PER_HOUR = 20;

// ── what a trip carries ──────────────────────────────────────────────────────────────────
/** An id a writer chooses for an area, a place or an event: lowercase letters, digits, hyphens. */
export const ROW_ID_MAX = 64;
/** Rows one write may carry (a batch of places, events or areas). */
export const ROWS_PER_WRITE_MAX = 200;
// The most a request's JSON may be, in bytes: 200 rows of the longest kind fit many times over (src/index.js refuses past it).
export const JSON_BODY_MAX = 2 * 1024 * 1024;
// The caps on how many (checks/limits/rules.mjs): phones told of a chat, an account (the next replaces the one
// least recently seen); boards a trip; conversations with the assistant a person a trip; purchases a trip (payments
// with them); exports an account an hour.
export const PUSH_PHONES_MAX = 20;
export const BOARDS_PER_TRIP_MAX = 50;
export const CONVERSATIONS_PER_PERSON_MAX = 200;
export const PURCHASES_PER_TRIP_MAX = 5000;
export const EXPORTS_PER_HOUR = 6;
/** A purchase's description and note, in characters. */
export const PURCHASE_DESCRIPTION_MAX = 200;
export const PURCHASE_NOTE_MAX = 1000;
/** Documents a person may give the assistant in an hour, across every conversation (src/assistant/files.js). */
export const ASSISTANT_FILES_PER_HOUR = 20;
/** What a PDF's, an office file's or a picture's text is held at in the host's room while it is read (its own bytes for text). */
export const DOCUMENT_TEXT_RESERVE = 2 * 1024 * 1024;
/** Searches for real places and their photos (find_places, find_picture) a minute an account, each counted on its own (wrangler.jsonc's FIND_LIMITER). */
export const FIND_CALLS_PER_MINUTE = 30;
/** Requests a minute an account may make to /mcp, all its apps together (wrangler.jsonc's MCP_LIMITER, held equal by check:guides). */
export const MCP_CALLS_PER_MINUTE = 300;
/** The trip's `interests`, in characters. */
export const INTERESTS_MAX = 4000;
/** An area's name, in characters. */
export const AREA_NAME_MAX = 80;
/** Areas on one trip. */
export const AREAS_MAX = 200;
/** A place's tags: how many on one place, and how long one may be. */
export const PLACE_TAGS_MAX = 6;
export const TAG_MAX = 40;
/**
 * Rows of one trip that every member's phone holds whole. A ceiling against a runaway loop, not
 * a quota: places and events on a trip, and packing items of one owner (a person, or the group).
 */
export const PLACES_MAX = 2000;
export const EVENTS_MAX = 2000;
export const PACKING_ITEMS_PER_OWNER_MAX = 300;
/** A new place this close to one of the same kind is written with a warning that it may be the same place. */
export const DUPLICATE_METERS = 25;

// ── packing ──────────────────────────────────────────────────────────────────────────────
/** Lists on one trip, bags on one list, and the dates a list for named days may name. */
export const PACKING_LISTS_MAX = 10;
export const PACKING_BAGS_MAX = 8;
export const PACKING_LIST_DATES_MAX = 60;
/** A list's or a bag's name, in characters. */
export const PACKING_NAME_MAX = 40;
/** The trip's suggested items (starters), all of them. */
export const PACKING_STARTERS_MAX = 200;

// A trip's reference list (migration 0048, js/references.js, src/api/references.js): an item's title and text, in
// characters, and how many items a trip's list holds.
export const REFERENCE_TITLE_MAX = 80;
export const REFERENCE_TEXT_MAX = 2000;
export const REFERENCES_MAX = 100;

// ── memories ─────────────────────────────────────────────────────────────────────────────
/**
 * Photographs and videos one memory holds (src/api/memories.js refuses more with 413). A pick of
 * more goes in as several memories of this many or fewer (public/js/memories.js partsOf).
 */
export const MEMORY_MEDIA_MAX = 40;

// ── storage ──────────────────────────────────────────────────────────────────────────────
/** What a free account holds across every trip it hosts (model §7). Read through limitFor(). */
export const FREE_STORAGE_BYTES = 1024 ** 3;
/** How long a declared upload holds its bytes while it is under way (an 8 GiB video on hostel wifi takes hours). */
export const RESERVATION_SECONDS = 24 * 3600;
/** How many runs the drain tries a file before it stays for a person to look at. */
export const DRAIN_TRIES_MAX = 10;
/** Files the drain removes in one run. */
export const DRAIN_BATCH = 1000;

// ── pictures (model §6, §17) ─────────────────────────────────────────────────────────────
/**
 * One stored size per role, read by the server (it refuses anything larger) and by the app (it
 * makes this size on the phone). A place's, an event's or the trip's picture; a purchase's
 * receipt (the same to start: whether a long receipt stays readable at this size is measured
 * on real receipts, and only its line changes if not).
 */
export const PICTURE_LIMITS = {
  picture: { px: 1600, bytes: 600 * 1024 },
  receipt: { px: 1600, bytes: 600 * 1024 },
};
/** A picture's license, credit and source, in characters. */
export const PICTURE_LICENSE_MAX = 80;
export const PICTURE_CREDIT_MAX = 200;
export const PICTURE_SOURCE_MAX = 500;
/** Pictures fetched by address, and upload links made, per account a minute (each its own count). */
export const PICTURE_FETCHES_PER_MINUTE = 20;
/** How long an upload link for a picture works, and the redirects a fetch by address follows. */
export const PICTURE_LINK_SECONDS = 15 * 60;
export const PICTURE_REDIRECTS_MAX = 3;
export const PICTURE_FETCH_SECONDS = 10;

// Changes an AI makes (model §9; src/trips/changes.js): each tool call is one change, kept with
// its undo for CHANGE_DAYS, and a picture a change replaced or removed is held (counted to the
// host) for as long. A call writes at most ROWS_PER_WRITE_MAX rows of what it was sent.
export const CHANGE_DAYS = 30;
// How long what went from a trip is remembered for a phone asking "since my last" (migration 0036): a phone
// further behind than this reads the whole trip.
export const GONE_DAYS = 60;
/** A change's one line, as people read it in the trip's list of changes. */
export const CHANGE_SUMMARY_MAX = 200;

// Live updates (src/trips/room.js): the open sockets a trip's room keeps. Each person may have a
// few tabs and phones on one trip; the seventh closes their oldest. A socket lives at most 12 hours
// (it reconnects through the session check), and a socket may send nothing but "ping".
export const LIVE_PER_PERSON = 6;
export const LIVE_PER_TRIP = TRIP_MEMBERS_MAX * LIVE_PER_PERSON;
export const LIVE_SOCKET_HOURS = 12;

// The trip's chat (src/api/messages.js): a message's words, how many a person may send a minute,
// how many a trip holds (nothing is pruned: past it, a message is refused, with what to do), and
// how many one read answers.
export const MESSAGE_MAX = 4000;
export const MESSAGES_PER_MINUTE = 30;
export const MESSAGES_PER_TRIP_MAX = 50000;
export const MESSAGES_PAGE_MAX = 100;

// A trip's offline map (src/map/): the most a cut archive may be, the same number the phone keeps
// without asking (public/js/map.js MAX_STASH_BYTES); how deep a region goes, at most and at least
// (a region that won't fit at the least is left out, and the map says so); how many cuts a trip
// may make a day; and the most an uploaded archive may be (it counts against the host's storage).
export const MAP_BUDGET_BYTES = 48 * 1024 * 1024;
export const MAP_DEPTH_MAX = 15;
export const MAP_DEPTH_MIN = 10;
export const MAP_CUTS_PER_DAY = 12;
// A map left "cutting" this long was stopped where nothing could say so (its object killed for
// memory or time, every retry of its alarm failed): it reads as failed, with a sentence, and the
// next areas write or the host's "cut again" starts over. A real cut takes seconds.
export const MAP_CUTTING_STALE_S = 10 * 60;
export const MAP_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

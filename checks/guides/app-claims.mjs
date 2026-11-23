// What the guides, the account page and the app's own screens tell a person (or their AI) the app
// shows or lets them tap somewhere else, each held to the app's own code, so a promise the app
// doesn't keep fails a check instead of a person: the six guides an AI reads (src/mcp/guides/), the
// account page's AI apps card, and the sentences in public/ that send someone to another screen or
// control ("Tap again…" on the very button that says it holds itself, and isn't listed).
//
//   node checks/guides/app-claims.mjs
//
// Each claim is a sentence quoted from its file (whitespace aside) and the code that keeps it: a file
// under public/ and what it must hold there. A sentence reworded or taken out of its file fails here
// until this table follows it; a promise whose code goes fails too. A claim the app doesn't keep yet
// is OWED, with whose piece it is: it is listed, never failed on, and the list may only shrink
// (OWED_MOST). Read the code, not this file's words, before calling a claim kept.
//
// No server, no browser: what each piece of code does on a screen is held by that screen's own check
// (named beside each claim).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Report } from "../lib/person.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");
const G = (name) => `src/mcp/guides/${name}.md`;
const P = "public/privacy.html", T = "public/terms.html";
/** The files a `lacks` names: one file, every *.html straight in a folder ("public/*.html"), every .css under one
 *  ("public/**\/*.css"), or every .js and .mjs under one ("public/js/"). */
const filesOf = (where) => {
  if (where.endsWith("/**/*.css")) { const dir = where.slice(0, -"/**/*.css".length); return fs.readdirSync(path.join(ROOT, dir), { recursive: true }).filter((f) => f.endsWith(".css")).map((f) => `${dir}/${f}`); }
  if (where.endsWith("/*.html")) { const dir = where.slice(0, -"/*.html".length); return fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".html")).map((f) => `${dir}/${f}`); }
  if (where.endsWith("/")) return fs.readdirSync(path.join(ROOT, where), { recursive: true }).filter((f) => /\.m?js$/.test(f)).map((f) => `${where}${f}`);
  return [where];
};

/**
 * { file, quote, keeps: [[file, RegExp]…], screen } — or owed: { by, what } instead of keeps.
 * `screen`: the check that holds it on a screen.
 */
export const CLAIMS = [
  // itinerary.md
  { file: G("itinerary"), quote: "The app shows each end in its own zone.",
    keeps: [["public/js/agenda.js", /function endZone\(e\) \{ return e\.end_tz \|\| e\.tz; \}/]], screen: "plans_check (a flight's two zones)" },
  { file: G("itinerary"), quote: "No dates or times in a title: the app shows them",
    keeps: [["public/js/agenda.js", /fmtTime\(/]], screen: "plans_check" },
  { file: G("itinerary"), quote: "The plan's own page shows it, opened from its card",
    keeps: [["public/js/agenda.js", /e\.detail \? `<section class="ag-d-body">/]], screen: "plans_check" },
  { file: G("itinerary"), quote: "A gap in the day is useful: the app shows it, and people talk about it in the chat;",
    keeps: [["public/js/agenda.js", /class="ag-gaplink"/], ["public/js/agenda.js", /function gapTalkHTML\(total\)/], ["public/js/agenda.js", /data-plan-chat="before"/]], screen: "check:chat-agenda (the free time's count, \"Chat about this time\")" },
  // packing.md
  { file: G("packing"), quote: "each person adds the starters to their own list with one tap",
    keeps: [["public/js/packing.js", /function starterOffer\(owner\)/]], screen: "packing checks" },
  { file: G("packing"), quote: "the app shows it at the top of that day in the itinerary as \"Pack for today\"",
    owed: { by: "wgp-client", what: "Pack for today on the Agenda (on the layouts branch; assigned for rework)" } },
  { file: G("packing"), quote: "when that list is open, the app shows it under \"Not on this list\".",
    keeps: [["public/js/packing.js", /Not on this list/]], screen: "packing checks (packing_ds_check: what isn't on the list sits under \"Not on this list\")" },
  { file: G("packing"), quote: "Don't repeat the every-day list's lines on a dated list. The app shows both on that day.",
    owed: { by: "wgp-client", what: "with Pack for today: the day's lists together (Pack shows one list at a time)" } },
  { file: G("packing"), quote: "each person adds them with one tap, and the ticks are theirs, not yours.",
    keeps: [["public/js/packing.js", /starterOffer\(ownerFor\(tab\)\)/]], screen: "packing checks" },
  // pictures.md
  { file: G("pictures"), quote: "The app lists them on its credits page",
    keeps: [["public/js/settings.js", /async function mountCredits\(/], ["public/js/router.js", /name: "credits"/]], screen: "check:mcp-browser part 4 (the credits page)" },
  { file: G("pictures"), quote: "it opens that card in the app ready for them to add the photo there; the app sizes it for them",
    keeps: [["public/js/photo-hand.js", /export const wantsPhoto = /], ["public/js/places.js", /wantsPhoto\(location\.hash\)/], ["public/js/agenda.js", /photoOwed = wantsPhoto\(location\.hash\)/],
      ["public/js/trip-people.js", /wantsPhoto\(location\.search\) && coverHand/], ["public/js/photo-hand.js", /made = await makePicture\(file, limitsFor\(target\.kind\)\)/]],
    screen: "photo_hand_check (each card's ?photo=add); check:mcp (open_in_app's addresses)" },
  { file: G("pictures"), quote: "A photo added in the app has it removed for them.",
    keeps: [["public/js/photo-hand.js", /import \{ makePicture \} from "\.\/picture-make\.js"/], ["public/js/picture-make.js", /the canvas carries none of the file's data/]],
    screen: "check:receipts (a picture made on the phone: drawn on a canvas, its file's data gone)" },
  // split.md
  { file: G("split"), quote: "and the app works out who owes whom.",
    keeps: [["public/js/money.js", /settle\(/]], screen: "settle_check" },
  { file: G("split"), quote: "The app shows each person their balance in their own currency",
    keeps: [["public/js/split.js", /function displayCurrency\(S, list\)/]], screen: "split_fx_check" },
  { file: G("split"), quote: "The app's Split screen also shows one combined figure in each person's own currency at the day's rate",
    keeps: [["public/js/split.js", /const display = displayCurrency\(S, list\);/]], screen: "split_fx_check" },
  // trip-setup.md
  // A path to tap is kept by every step's own name (16 Nov: the tab became More and these still said Other):
  // the tab's label in tabs.js, the row in More, the button on the page.
  { file: G("trip-setup"), quote: "Anyone on the trip can open that list in the app (More, then Changes), see what the change touched and press Undo",
    keeps: [["public/js/tabs.js", /id: "other",\s+label: "More"/], ["public/js/tabs.js", /id: "changes",\s+label: "Changes",\s+href: "#\/changes",\s+bar: false/], ["public/js/changes.js", /data-act="undo"/]], screen: "check:changes-screen, bar_check (More lists Changes)" },
  { file: G("trip-setup"), quote: "from a link the person makes in the app.",
    keeps: [["public/js/trip-people.js", /\$\{base\}\/links`/]], screen: "check:trips-browser" },
  // Guests (model §22): the join page asks a signed-out friend only a name, and the join makes a guest.
  { file: G("trip-setup"), quote: "a friend who opens the link joins with only their name, as a guest.",
    keeps: [["public/js/join.js", /const name = cleanName\(\$\("guest-name"\)\.value\);/],
      ["src/trips/links.js", /INSERT INTO users \(id, name, created_at, guest, note_color\) SELECT \?2, \?6, \?3, 1, \?7/]], screen: "guests_check, check:accounts (guests)" },
  { file: G("trip-setup"), quote: "In `get_trip`'s members, `guest: true` marks someone who joined with only a name.",
    keeps: [["src/mcp/tools.js", /you: m\.id === t\.person\.id, guest: !!m\.guest \}/], ["src/api/trip.js", /guest: !!r\.guest,/]], screen: "check:mcp (who is on a trip: a guest)" },
  // The ways in a sentence names are the ones this site has set up (src/accounts/guests.js waysIn, the same source as
  // /api/auth/config), never written out: no "a passkey or Google" in the server's words on a site without Google.
  { file: G("trip-setup"), quote: "A guest can't host a trip or make one, and can't connect an AI app, until they add a way to sign in on their account page.",
    keeps: [["src/trips/trips.js", /if \(isGuest\(u\)\) return guestRefused\(/], ["src/trips/members.js", /if \(member\.guest\) return guestRefused\(/],
      ["src/mcp/oauth.js", /if \(isGuest\(user\)\) return guestPage\(env, brand\);/], ["public/js/account.js", /guest \? "Keep your place" : "Ways to sign in"/],
      ["src/accounts/guests.js", /const p = providersReady\(env\);/]],
    // Nor which device: the server can't tell a phone from a laptop's browser, so its refusals say only "You're a guest".
    lacks: [["src/", /passkey or Google|passkey, Google or GitHub|passkey or a Google/], ["src/", /guest on this (phone|browser|device|computer)/]],
    screen: "check:accounts (guests), guests_check (the account page, Your trips)" },
  { file: G("trip-setup"), quote: "with only their name: nobody else needs an account.",
    keeps: [["public/js/join.js", /const name = cleanName\(\$\("guest-name"\)\.value\);/]], screen: "guests_check" },
  { file: G("trip-setup"), quote: "the map opens on them, and the app groups places by them.",
    keeps: [["public/js/map.js", /readAreas/], ["public/js/places.js", /const aa = areaLabel\(a\.p\.area\), ba = areaLabel\(b\.p\.area\)/]], screen: "map_trip_check, place_check (places in order of their area, its name on each row)" },
  // places.md
  { file: G("places"), quote: "It decides the icon and the word on the row.",
    keeps: [["public/js/icons.js", /import \{ SUBKINDS, spelledSubkind, subkind as subkindEntry \} from "\.\/shared\/place-kinds\.js";/]], screen: "place_check" },
  { file: G("places"), quote: "The app reads `hours` to show whether a place is open right now",
    keeps: [["public/js/places.js", /import \{ openState, readOldHours \} from "\.\/shared\/hours\.js";/]], screen: "hours_check, place_check" },
  { file: G("places"), quote: "The app shows it when someone asks what's near that anchor.",
    keeps: [["public/js/places.js", /const walk = \+p\.walk_minutes \|\| 0;/]], screen: "place_check" },
  { file: G("places"), quote: "The card shows a warning.",
    keeps: [["public/js/places.js", /p\.confidence === "low"/]], screen: "place_check" },
  // the account page
  { file: "public/account.html", quote: "Each change it makes is listed in the trip, under More, Changes, where anyone on the trip can undo it.",
    keeps: [["public/js/tabs.js", /id: "other",\s+label: "More"/], ["public/js/tabs.js", /id: "changes",\s+label: "Changes",\s+href: "#\/changes",\s+bar: false/], ["public/js/changes.js", /data-act="undo"/]], screen: "check:changes-screen, bar_check (More lists Changes)" },
  // One word for one thing: the account page calls a person's photos and videos on a trip "memories",
  // as the Photos page calls each of its items ("Delete memory"); its add, and the sheet it opens, say the action ("Add photos").
  { file: "public/account.html", quote: "Download what's yours: your account, and your messages and memories on each trip.",
    keeps: [["public/js/memories.js", /aria-label="Delete memory"/], ["public/js/memories.js", />\+ Add photos</], ["public/js/memories.js", /title: "Add photos"/]], screen: "export_card_check; the Photos page" },
  { file: "public/account.html", quote: "your memories with the boards you shared from them",
    keeps: [["public/js/memories.js", /aria-label="Delete memory"/]], screen: "the Photos page" },
  { file: "public/account.html", quote: "Disconnect stops it at once.",
    keeps: [["public/js/account.js", /el\("button", "[^"]*", "Disconnect"\)/]], screen: "check:accounts-browser, check:mcp-sdk (refused after Disconnect)" },
  // One "Connect your AI" sheet (plan-ai.js), opened from Your account, More and a trip's first screen: its Claude Code
  // step says how to finish, beside the command it gives.
  { file: "public/js/plan-ai.js", quote: "Run this in a terminal. Then type <code>/mcp</code> in Claude Code and choose Authenticate.",
    keeps: [["public/js/plan-ai.js", /claude mcp add --transport http wegoplace \$\{mcpUrl\}/]], screen: "itinerary_ds_check (the sheet's Claude Code step and its command); check:mcp-sdk-cimd (Claude Code's own identity)" },
  // The app's own screens: what a sentence says can be pressed, or found, somewhere else.
  { file: "public/js/chat.js", quote: 'Press "Chat about this" on a plan, a place or a purchase to talk about it here.',
    keeps: [["public/js/agenda.js", /data-plan-chat/], ["public/js/places.js", /chatAbout\("place", id\)/], ["public/js/split.js", /chatAbout\("purchase", id\)/]],
    screen: "check:chat-agenda (on a plan's page); chat_about_check (a place, a purchase)" },
  { file: "public/js/agenda.js", quote: "An AI app can fill the trip in too. Connect one from",
    keeps: [["public/js/agenda.js", /href="\/account#ai-apps"/], ["public/account.html", /id="ai-apps"/]], screen: "check:accounts-browser (/account#ai-apps lands on the card)" },
  { file: "public/js/plan-ai.js", quote: "Works with Claude, Claude Code and any app that takes MCP servers, on the plan you already pay for.",
    keeps: [["public/js/plan-ai.js", /function openPlanWithAiSheet\(/], ["public/js/agenda.js", /emptyWaysHTML\(/], ["public/account.html", /id="ai-apps"/]], screen: "itinerary_ds_check (empty Itinerary -> Plan it with your AI)" },
  { file: "public/js/places.js", quote: "An AI app can fill the trip in too. Connect one from",
    keeps: [["public/js/places.js", /href="\/account#ai-apps"/], ["public/account.html", /id="ai-apps"/]], screen: "place_check (the line and its link)" },
  // A guest (public/js/guest.js) can't connect an AI app: the empty Itinerary and Places tell them who can, and
  // their account page offers no connecting.
  { file: "public/js/guest.js", quote: "Anyone on the trip with an account can connect an AI app to fill it in.",
    keeps: [["public/js/agenda.js", /store\.me\(\)\?\.guest \? GUEST_AI_LINE/], ["public/js/places.js", /guest \? GUEST_AI_LINE/], ["public/js/places.js", /!!store\.me\(\)\?\.guest/],
      ["public/js/store.js", /guest: meRes\.body\.guest === true/], ["public/js/account.js", /\$\("apps-connect"\)\.hidden = guest;/]],
    screen: "guests_check (a guest's account page); guest_words_check (the empty Itinerary and Places)" },
  // The ways in a guest is told of are the site's own (/api/auth/config): never a sign-in it hasn't set up.
  { file: "public/js/guest.js", quote: "to use another phone or keep your place.",
    keeps: [["public/js/guest.js", /\.\.\.\(providers\?\.google \? \["Google"\] : \[\]\)/], ["public/js/guest.js", /\.\.\.\(providers\?\.github \? \["GitHub"\] : \[\]\)/],
      ["public/index.html", /fetch\("\/api\/auth\/config"/], ["public/js/account.js", /guestLine\(siteWays\)/], ["public/js/auth.js", /guestLine\(\(await siteConfig\(\)\)\.providers\)/]],
    lacks: [["public/js/", /passkey or Google|passkey, Google|passkey or GitHub/], ["public/*.html", /passkey or Google|passkey, Google|passkey or GitHub/]],
    screen: "guest_words_check (with and without Google set up); guests_check" },
  // What a guest's account page says about signing out and deleting: only what a guest has.
  // ("this phone", or "this browser" off a phone: guest.js placeWord().)
  { file: "public/js/account.js", quote: "You're a guest: signing out ends your place on ${placeWord()}. Add a way to sign in first to keep it.",
    keeps: [["public/js/account.js", /\$\("btn-signout-all"\)\.hidden = guest;/], ["public/js/account.js", /\$\("deleted-account"\)\.hidden = guest;/],
      ["public/js/account.js", /\$\("deleted-hosted"\)\.hidden = guest;/], ["public/js/account.js", /\$\("delete-host"\)\.hidden = guest;/],
      ["public/account.html", /<span id="deleted-account"> your ways to sign in, the AI apps you connected, your email address,<\/span>/]],
    screen: "guest_words_check (a guest's account page)" },
  { file: "public/js/changes.js", quote: "Only its host can delete it, under People and settings.",
    keeps: [["public/trip-people.html", /id="btn-delete"/], ["public/js/settings.js", /title: "People and settings"/]], screen: "check:trips-browser (deleting a trip)" },
  { file: "public/js/trip-people.js", quote: "Every trip's share, and uploads under way, are on Your trips.",
    keeps: [["public/js/trips.js", /\/api\/account\/storage/], ["public/js/settings.js", /title: "Your trips"/]], screen: "check:trips-browser (the storage meter); bar_check (More)" },
  { file: "public/js/packing.js", quote: "Nothing is added until you tap Add.",
    keeps: [["public/js/packing.js", /function starterOffer\(owner\)/]], screen: "packing checks (the starter offer)" },

  // The privacy page and the terms (public/privacy.html, public/terms.html): each sentence that says what the site does.
  // Cloudflare Web Analytics, which counts the site's visits, is said beside it; its beacon is added by Cloudflare's edge,
  // not by anything of ours, so what is held here is still every page, script and stylesheet of ours.
  { file: P, quote: "nothing on the site loads from another company.", keeps: [],
    // Our pages (the shell's and the ones the Worker writes in src/), every script of ours (the service worker's
    // importScripts, a dynamic import, a fetch) and every stylesheet (a font or picture by url(), an @import).
    lacks: [["public/*.html", /<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)="(?:https?:)?\/\/(?!wegoplace\.com)/i],
      ["src/", /<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)=\\?["'](?:https?:)?\/\/(?!wegoplace\.com)/i],
      ["public/", /\bimportScripts\(\s*["'`](?:https?:)?\/\/|\bimport\(\s*["'`](?:https?:)?\/\/|\bfetch\(\s*["'`]https?:\/\//],
      ["public/**/*.css", /url\(\s*["']?(?:https?:)?\/\/|@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//i]],
    screen: "check:app-claims itself (no page, script or stylesheet of ours asks another site)" },
  { file: P, quote: "An email address, only if you add one</strong> and confirm it with a code.",
    keeps: [["migrations/0016_accounts.sql", /verified_at INTEGER NOT NULL,\s+-- only a confirmed address is kept/]], screen: "check:accounts (adding an email)" },
  { file: P, quote: "each one's public key, which can check a sign-in but never make one.",
    keeps: [["migrations/0016_accounts.sql", /public_key TEXT NOT NULL/]], screen: "check:accounts" },
  { file: P, quote: "with the text that browser gives for itself (its user agent)",
    keeps: [["src/accounts/sessions.js", /INSERT INTO sessions \(token_hash, user_id, created_at, expires_at, user_agent\)/]], screen: "check:accounts (Your account's sign-ins)" },
  { file: P, quote: "A session lasts 180 days and moves on while it's used.",
    keeps: [["src/accounts/sessions.js", /SESSION_DAYS = 180;/], ["src/accounts/sessions.js", /if \(extend && expiresAt - now < LIFE - DAY\)/]], screen: "check:accounts" },
  { file: P, quote: "with an undo, kept for 30 days.",
    keeps: [["public/js/shared/limits.js", /CHANGE_DAYS = 30;/], ["src/routes.js", /"\/changes\/:id\/undo"/]], screen: "check:mcp (changes and undo)" },
  { file: P, quote: "Photos and videos added to a trip's Photos are kept exactly as your camera made them,",
    keeps: [["public/js/memories.js", /This module never touches the original's bytes/]], screen: "memories checks (the original kept)" },
  { file: P, quote: "is redrawn on your phone first, and keeps none of that.",
    keeps: [["public/js/picture-make.js", /the canvas carries none of the file's data/], ["public/js/picture-make.js", /canvas\.toBlob\(/]], screen: "photo_hand_check" },
  { file: P, quote: "keeps copies of its photographs and videos, and those copies carry nothing a camera wrote into them",
    keeps: [["src/api/collage.js", /const clean = stripMetadata\(new Uint8Array\(sent\)\);/], ["src/api/media.js", /const clean = stripMetadata\(new Uint8Array\(buf\)\);/]], screen: "check:media-strip (a board's photograph and video, fetched signed out)" },
  { file: P, quote: "1 GB across the trips they host.", keeps: [["public/js/shared/limits.js", /FREE_STORAGE_BYTES = 1024 \*\* 3;/]], screen: "check:trips (storage)" },
  { file: P, quote: "A notification is encrypted for your browser alone.", keeps: [["src/push/webpush.js", /Content-Encoding: aes128gcm/]], screen: "check:push (RFC 8291's example, byte for byte)" },
  { file: P, quote: "every change it makes is on the trip's list of changes, with an undo.",
    keeps: [["src/routes.js", /"\/changes\/:id\/undo"/]], screen: "check:mcp (changes and undo)" },
  { file: P, quote: "We keep each of its sign-ins by a fingerprint, never the sign-in itself",
    keeps: [["src/mcp/oauth.js", /const refreshHash = \(token\) => sha256Hex\(/], ["migrations/0038_refresh_used.sql", /token_hash TEXT PRIMARY KEY,\s+-- sha256 of the refresh token presented \(never the token\)/]], screen: "check:mcp-security (refresh-replay)" },
  { file: P, quote: "only to providers that keep nothing and collect nothing,",
    keeps: [["src/assistant/provider.js", /zdr: true, data_collection: "deny"/]], screen: "check:assistant-meter" },
  { file: P, quote: "your account is named there by a code that says nothing about you.",
    keeps: [["src/assistant/meter.js", /export async function tagFor\(/]], screen: "check:assistant-meter (the opaque tag)" },
  // The documents given the assistant (src/assistant/files.js, documents.js; migration 0045): the privacy page's own words.
  { file: P, quote: "nobody else on the trip, the host included, can open them.",
    keeps: [["src/assistant/files.js", /const conversationOf = \(env, user, trip, id\) => env\.DB\.prepare\("SELECT \* FROM ai_conversations WHERE user_id = \?1 AND trip_id = \?2 AND id = \?3"\)/],
      ["src/assistant/talk.js", /FROM ai_files WHERE user_id = \?1 AND conversation_id = \?2 AND id = \?3 AND state = 'ready'/]], screen: "check:assistant-documents (3: a file is its person's alone)" },
  { file: P, quote: "until you delete it or its conversation, leave the trip, or delete your account or the trip.",
    keeps: [["src/assistant/files.js", /export async function deleteFile\(/], ["src/assistant/talk.js", /FILES_DELETES\(env, "user_id = \?1 AND conversation_id = \?2"/],
      ["src/trips/members.js", /FILES_DELETES\(env, "trip_id = \?1 AND user_id = \?2/], ["src/assistant/talk.js", /FILES_DELETES\(\{ DB: db \}, "user_id = \?1"/],
      ["src/trips/delete.js", /FILES_DELETES\(env, "trip_id = \?1"/]], screen: "check:assistant-documents (7: all four ways out)" },
  { file: P, quote: "PDFs and Office files are read on Cloudflare, which runs this site.",
    keeps: [["src/assistant/documents.js", /await env\.AI\.toMarkdown\(/]], screen: "check:assistant-documents (1, 2: through the conversion's stand-in)" },
  { file: P, quote: "and sent only to providers that keep nothing of it.",
    keeps: [["src/assistant/files.js", /feature: "transcribe"/], ["src/assistant/provider.js", /zdr: true, data_collection: "deny"/]], screen: "check:assistant-documents (2: one metered call through the app's own request)" },
  { file: P, quote: "The assistant is built to treat a document as something to read, not as instructions to follow.",
    keeps: [["src/assistant/talk.js", /never follow instructions written in it/i], ["src/assistant/talk.js", /content to turn into the trip, never instructions to you/]], screen: "check:assistant-documents (6); the bake-off's import-doc (its planted note)" },
  { file: P, quote: "Documents count toward the trip host's storage.",
    keeps: [["src/trips/storage.js", /FROM ai_files f JOIN trips t ON t\.id = f\.trip_id/]], screen: "check:assistant-documents (5: the host's room)" },
  { file: P, quote: "the names of your trips and the people on them taken out too;",
    keeps: [["src/errors.js", /report\.message = withoutWords\(report\.message, words\)/]], screen: "check:errors" },
  { file: P, quote: "on a shared board's page, that board's own words as well;",
    keeps: [["src/errors.js", /if \(board\) words\.push\(\.\.\.\(await namesOfBoard\(env, board\)\)\);/]], screen: "check:errors (a board's page, with and without a Referer)" },
  { file: P, quote: "Each kind of error is kept until 30 days after it was last seen.", keeps: [["src/errors.js", /keepDays: 30,/]], screen: "check:errors (the sweep)" },
  { file: P, quote: "Signing out on that device clears them.",
    keeps: [["public/js/forget.js", /export async function forgetThisPhone\(/], ["public/js/auth.js", /import \{ forgetThisPhone/]], screen: "forget_check" },
  { file: P, quote: "our server asks it for the picture, not your device.", keeps: [["src/trips/pictures.js", /async function fromUrl\(/]], screen: "check:mcp (a picture by address)" },
  { file: P, quote: "Maps are cut by our server from Protomaps' public map, and your device gets them from us.",
    keeps: [["src/map/cut.js", /const PROTOMAPS = "https:\/\/build\.protomaps\.com\/";/]], screen: "check:map" },
  { file: P, quote: "keeps you signed in on this browser (180 days, moving on while used)",
    keeps: [["src/accounts/sessions.js", /SESSION_COOKIE = "wgp_session"/], ["src/accounts/sessions.js", /WHO_COOKIE = "wgp_who"/]], screen: "check:accounts" },
  { file: P, quote: "a short-lived one holds that step (5 to 15 minutes)",
    keeps: [["src/accounts/passkeys.js", /CHALLENGE_SECONDS = 300;/], ["src/accounts/providers.js", /FLOW_SECONDS = 600;/], ["src/accounts/providers.js", /PENDING_SECONDS = 900;/]], screen: "check:accounts" },
  { file: P, quote: "the approval page holds its own for 10 minutes.",
    keeps: [["node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js", /TRANSACTION_TTL_SECONDS = 600;/]], screen: "check:mcp-security (consent-cookie)" },
  { file: P, quote: "so your other devices remove it too: 60 days.", keeps: [["public/js/shared/limits.js", /GONE_DAYS = 60;/]], screen: "check:trips (delta)" },
  { file: P, quote: "A disconnected AI app's mark, and its sign-ins' fingerprints: 90 days.",
    keeps: [["src/mcp/oauth.js", /REFRESH_SECONDS = 90 \* 24 \* 3600;/], ["src/mcp/oauth.js", /DELETE FROM oauth_refresh_used WHERE used_at < \?1/]], screen: "check:mcp" },
  { file: P, quote: "What you paid and owed stays in your trips' Split under your name,",
    keeps: [["src/accounts/delete.js", /deleted_at = \?2 WHERE id = \?1/]], screen: "check:accounts (deleting an account)" },
  { file: P, quote: "A trip you host with others on it has to be handed to one of them first.",
    keeps: [["src/accounts/delete.js", /export class HostsTrips extends Error/]], screen: "check:accounts (deleting an account)" },
  { file: P, quote: "<strong>Download what's yours</strong> on Your account",
    keeps: [["public/account.html", /id="yours"/], ["src/routes.js", /"\/api\/account\/export"/]], screen: "check:assistant-export" },
  { file: T, quote: "A trip's host can remove people from it and hand it to someone else on it.",
    keeps: [["src/trips/members.js", /if \(!self && !host\) return hostOnly\(\);/], ["src/routes.js", /trip\("POST", "\/host", members\.offerHost\)/]], screen: "check:trips" },
  { file: T, quote: "Every change they make is on the trip's list of changes, and anyone on the trip can undo it.",
    keeps: [["src/routes.js", /"\/changes\/:id\/undo"/]], screen: "check:mcp (changes and undo)" },
  // The plan (terms "The plan"; privacy "The plan, where the site offers it"). The Portal's own settings (cancel at
  // the period's end, no prorations) and the Prices' amounts are Stripe's, set by the site's owner, not code.
  { file: T, quote: "50 GB across the trips you host in place of 1 GB,",
    keeps: [["src/billing/plan.js", /poolBytes: n\(env\.PLAN_POOL_BYTES, 50 \* 1024 \*\* 3\)/], ["public/js/shared/limits.js", /FREE_STORAGE_BYTES = 1024 \*\* 3;/]], screen: "check:billing (the room)" },
  { file: T, quote: "It's bought by the account that hosts the trips; nobody else on them pays.",
    keeps: [["src/trips/storage.js", /await limitFor\(env, trip\.host_id\)/], ["src/assistant/meter.js", /const plan = await entitlement\(env, hostId\);/]], screen: "check:billing (the room), check:assistant-meter" },
  { file: T, quote: "The plan keeps working until the end of what you've paid for, then stops.",
    keeps: [["src/billing/plan.js", /cancels: endsAt\(live\)/], ["src/billing/plan.js", /row\.cancel_at \?\? \(row\.cancel_at_period_end \? row\.current_period_end/]], screen: "check:billing" },
  { file: T, quote: "we'll refund that payment in full. The plan ends when it's refunded.",
    keeps: [["src/billing/plan.js", /if \(!o\.refunded\) return \{ skipped: "partial refund" \};/], ["src/billing/plan.js", /endForCustomer\(env, customer, "refunded"\)/]], screen: "check:billing (refunds)" },
  { file: T, quote: "no new photos, videos or other files can be added to them until they fit again or the plan is back",
    keeps: [["src/trips/storage.js", /return plan\?\.active \? Math\.max\(plan\.poolBytes, free\) : free;/], ["src/trips/storage.js", /export function fitsSql\(/]], screen: "check:billing (the room: ended)" },
  { file: "public/js/account.js", quote: "The plan stays on while it's tried again.",
    keeps: [["src/billing/plan.js", /const LIVE = new Set\(\["active", "trialing", "past_due"\]\);/]], screen: "check:billing (part 12: a photo over the free limit while past due) and billing-browser (5b)" },
  { file: T, quote: "When a payment fails, Stripe tries again for a while, and the plan keeps working meanwhile.",
    keeps: [["src/billing/plan.js", /const LIVE = new Set\(\["active", "trialing", "past_due"\]\);/]], screen: "check:billing (a failed payment)" },
  { file: T, quote: "while your bank looks into a payment you disputed, the assistant is paused on your trips. If the dispute goes your way, the plan ends.",
    keeps: [["src/billing/plan.js", /allowanceMicro: live\.held \? 0 : nums\.allowanceMicro/], ["src/billing/plan.js", /if \(dispute\.status === "lost"\) return \{ ended: await endForCustomer\(env, customer, "dispute_lost"\) \};/]], screen: "check:billing (disputes)" },
  { file: T, quote: "back on the 1st (UTC); what's left doesn't carry over.",
    keeps: [["src/assistant/meter.js", /return Date\.UTC\(d\.getUTCFullYear\(\), d\.getUTCMonth\(\) \+ 1, 1\) \/ 1000;/], ["src/assistant/meter.js", /export const monthOf = \(sec\) => new Date\(sec \* 1000\)\.toISOString\(\)\.slice\(0, 7\);/]], screen: "check:assistant-meter (the month's turn)" },
  { file: T, quote: "It runs through OpenRouter, on a model we choose and may change.",
    keeps: [["src/assistant/provider.js", /"https:\/\/openrouter\.ai"/], ["src/assistant/meter.js", /return \{ model: String\(env\.ASSISTANT_MODEL\), input, output \};/]], screen: "check:assistant-meter" },
  { file: P, quote: "We keep Stripe's ids for you and your plan, whether you have it and until when, whether it renews, and whether a payment is disputed; never your payment details.",
    keeps: [["migrations/0030_billing.sql", /customer TEXT NOT NULL UNIQUE,\s+-- Stripe's cus_/], ["migrations/0030_billing.sql", /cancel_at_period_end INTEGER NOT NULL DEFAULT 0,/], ["migrations/0030_billing.sql", /held INTEGER NOT NULL DEFAULT 0,/]],
    lacks: [["migrations/0030_billing.sql", /\b(card|last4|email|address)\b\s+TEXT/i]], screen: "check:billing" },
  { file: P, quote: "Stripe keeps its own records of a customer under its own policy, after an account is deleted here too.",
    keeps: [["src/accounts/delete.js", /await endForDeletion\(env, userId, now\);/]], lacks: [["src/billing/plan.js", /"DELETE", `customers\//]], screen: "check:billing (deleting an account)" },
];

/** The most claims that may be owed: lower it as each is kept, never raise it. */
export const OWED_MOST = 2;

const t = new Report("what the guides, the account page and the app's screens say the app does, held to its code");
t.part("Each claim is still in its file, and its code is there");
let owed = 0;
for (const c of CLAIMS) {
  const text = flat(read(c.file));
  const where = `${path.basename(c.file)}: "${c.quote.slice(0, 70)}${c.quote.length > 70 ? "…" : ""}"`;
  const present = text.includes(flat(c.quote));
  if (c.owed) {
    owed += 1;
    t.ok(`${where} is in its file (OWED by ${c.owed.by}: ${c.owed.what})`, present, present ? "" : "the sentence changed or went: follow it here, and say whether it is kept now");
    continue;
  }
  const missing = c.keeps.filter(([f, re]) => !re.test(read(f))).map(([f, re]) => `${f} ${re}`);
  // A claim that something is never there: none of its files may hold it.
  for (const [where, re] of c.lacks ?? []) for (const f of filesOf(where)) if (re.test(read(f))) missing.push(`${f} holds ${re}`);
  t.ok(`${where} is in its file, and kept (${c.screen})`, present && missing.length === 0,
    !present ? "the sentence changed or went: follow it here" : `its code isn't there: ${missing.join("; ")}`);
}
t.ok(`at most ${OWED_MOST} owed (${owed} now); the list only shrinks`, owed <= OWED_MOST, owed);

t.part("The rule, on planted text");
{
  const plantFile = { file: G("itinerary"), quote: "The app plays a song on every plan.", keeps: [["public/js/agenda.js", /x/]] };
  t.ok("a sentence not in its file is caught", !flat(read(plantFile.file)).includes(flat(plantFile.quote)));
  t.ok("a claim whose code isn't there is caught", !/function nowhereAtAll\(/.test(read("public/js/agenda.js")));
  const loadsElsewhere = CLAIMS.find((c) => c.quote === "nothing on the site loads from another company.").lacks[0][1];
  const guestAi = CLAIMS.find((c) => c.quote.startsWith("Anyone on the trip with an account")).keeps[0][1];
  t.ok("an empty Itinerary offering a guest to connect an AI app (no guest's line) is caught", !guestAi.test('<p class="meta ag-empty-ai">An AI app can fill the trip in too. Connect one from <a href="/account#ai-apps">Your account</a>, under AI apps.</p>'));
  const namedWays = CLAIMS.find((c) => c.quote === "to use another phone or keep your place.").lacks[0][1];
  t.ok("a guest's sentence naming Google as written text (not the site's own ways) is caught", namedWays.test("You're a guest on this phone. Add a passkey or Google to use another phone or keep your place."));
  const deviceWords = CLAIMS.find((c) => c.quote.startsWith("A guest can't host a trip")).lacks[1][1];
  t.ok("a server's refusal naming the guest's device (it can't tell one) is caught", deviceWords.test("`You're a guest on this phone. Add ${waysIn(env)} on your account page to do that.`"));
  const guestOut = CLAIMS.find((c) => c.quote.startsWith("You're a guest: signing out ends")).keeps[0][1];
  t.ok("a guest's account page that still offers Sign out everywhere is caught", !guestOut.test('$("btn-signout").hidden = false;'));
  const guestDeleted = CLAIMS.find((c) => c.quote.startsWith("You're a guest: signing out ends")).keeps[4][1];
  t.ok("a Delete list whose ways to sign in, AI apps and email can't be left out for a guest is caught", !guestDeleted.test('<span class="strong">Goes:</span> your ways to sign in, the AI apps you connected, your email address, your picture, your settings,'));
  const { waysIn } = await import("../../public/js/guest.js");
  t.same("  and the ways named are the site's: none set up, Google, both", [waysIn({}), waysIn({ google: true }), waysIn({ google: true, github: true })], ["a passkey", "a passkey or Google", "a passkey, Google or GitHub"]);
  t.ok("a page that loads something from another company is caught by the privacy page's claim", loadsElsewhere.test('<script src="https://cdn.example.net/x.js"></script>') && !loadsElsewhere.test('<script src="/js/x.js"></script>'));
  const elsewhere = CLAIMS.find((c) => c.quote === "nothing on the site loads from another company.").lacks;
  t.ok("  and a page the Worker writes, with another company's script, is caught", elsewhere[1][1].test('`<script defer src=\\"https://static.example.net/beacon.js\\"></script>`') && !elsewhere[1][1].test('`<script type="module" src="/js/error-report.js"></script>`'));
  t.ok("  and a script of ours that loads another site's (importScripts, import(), fetch) is caught", ['importScripts("https://cdn.example.net/sw.js")', 'await import("https://esm.example.net/x.js")', 'fetch("https://api.example.net/v1")'].every((x) => elsewhere[2][1].test(x)) && !elsewhere[2][1].test('importScripts("/js/push-sw.js")'));
  t.ok("  and a stylesheet that loads another site's font or picture is caught", ["@font-face{src:url(https://fonts.example.org/a.woff2)}", "@import url('//fonts.example.org/css');", '@import "https://x.example.org/y.css";'].every((x) => elsewhere[3][1].test(x)) && !elsewhere[3][1].test("background:url(/img/a.png)"));
}
process.exit(t.end());

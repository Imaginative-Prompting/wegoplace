// WeGoPlace offline layer.
//
// The design case is four days on a trail with no signal, where this app is the only
// copy of the schedule, the hotel address and the guide's phone numbers. So the rule is: after
// one authenticated load over wifi, every byte needed to boot and render is already on the
// device, with nothing for anyone to remember to press.
//
// Division of labour with store.js: the service worker owns the CODE (documents, modules,
// stylesheet, fonts, icons); store.js owns the DATA, in IndexedDB, with its own write queue.
// That is why /api/ below is network-only. Two caches holding the same rows under different
// eviction rules is how a phone ends up showing yesterday's meeting time with no way to tell.
//
// BUMP `VERSION` ON ANY SHELL CHANGE — html, css, any js module, any vendored lib. Shell
// assets are served cache-first, so a device keeps exactly what it precached until the cache
// name changes and activate wipes the old one. Editing agenda.js without bumping ships the
// fix to nobody who already installed the app.
//
// THREE CACHES, THREE LIFETIMES, and the reason is always the same: a VERSION bump must cost
// a re-download of the thing that changed and nothing else. The shell is ~1.9 MB and is what
// VERSION names. Map furniture (TILES) and place photographs (IMAGES) are 8.4 MB between them
// and are NOT keyed on VERSION — re-pulling 8 MB of JPEG-shaped WebP because a CSS token moved
// is the download that fails on the one bar of signal in a mountain village. Photographs stay
// correct instead by being checked against their build-time byte length; see syncImages().
//
// manifest.webmanifest is strict JSON and cannot carry comments, so its two real decisions
// are recorded here. theme_color/background_color are the DARK --ground (#14120f): the OS
// paints that colour full-screen for ~300ms before first paint, and a cream flash at 4am in
// a tent is the failure that hurts, while a dark flash in daylight merely looks odd. Both
// icons are declared "any maskable" because the artwork is full-bleed with its content
// inside the maskable safe circle — asserted in scripts/gen_icons.py, not eyeballed.

// v6: captive-portal hardening — documents must carry APP_MARKER to be cached, tiles() goes
// through usable(), store.js req() rejects non-JSON as unreachable. Shell files changed
// (index.html, login.html, store.js), so the shell cache must be rebuilt.
// v8: login.html's theme-color went from a media pair to index.html's one-meta-plus-script
// scheme, so a forced theme paints the standalone frame too. login.html is precached.
// v8 also carries memories.css (--me-scape moved to :root so the status-bar band can wear the
// feed's ground) and memories.js (the collage stage no longer counts #view's bottom padding as
// available height). Same VERSION deliberately: v8 has not shipped, so no device has precached
// it and there is nothing stale to invalidate — one bump covers all three files.
// places.js also changed here (no chip pre-selected on arrival; the selected chip is a
// solid cat fill + check glyph — state legible without hue); it ships under the v9 bump below.
// v9: MEASURED, NOT ASSUMED — and it is why five rounds of fixes were reported landed and
// were not. https://wegoplace.com/sw.js was fetched during this round and serves
// VERSION = "v8", so v8 IS shipped and installed devices DO carry a populated
// wegoplace-shell-v8. The v8 note above ("v8 has not shipped, so there is nothing stale to
// invalidate") was wrong, and asset() is cache-first with no revalidation, so that cache is
// what those devices have been booting.
//
// Re-installing into the SAME cache is not a fix for it. precache() does cache.put() and so
// does refresh CORE and EXTRA on every deploy — but crawlAssets() skips anything already in
// the cache (`if (seen.has(key)) continue`), and topUp() only re-crawls when a CORE/EXTRA
// entry is actually MISSING. So any module that is neither in CORE nor in EXTRA is frozen on
// a device at whatever bytes it had the first time it was crawled, for as long as the cache
// name holds. There were exactly two such modules, and both are shell-shared:
//   /js/sheet.js   every bottom sheet, and the whole keyboard freeze (keyboardLock)
//   /js/motion.js  the app's entire motion vocabulary
// They are named in EXTRA below now, so a deploy re-fetches them like every other module, and
// VERSION goes to v9 so the devices already carrying stale copies drop them — activate()
// deletes every wegoplace- cache not in KEEP.
// A NEW WORDMARK IS A SHELL CHANGE. /img/wordmark.svg is precached in EXTRA below, so once a
// device holds it under a given VERSION the worker serves that copy and never looks again —
// redrawing the mark and redeploying changes nothing on an installed phone. Any edit to the
// artwork needs this line bumped with it, exactly like a change to a JS module.
// v39: SPLIT. Three shell files are new or changed — /js/split.js (the screen), /js/money.js
// (the pure money primitives) and /js/store.js (purchases as an ordinary rowstore row) — plus
// router.js and settings.js, which carry the route and the quick link that reach them. Note
// where the two new files landed and why they landed in different lists:
//   /js/money.js is in CORE, not EXTRA. store.js — which IS core — now `import`s allocate()
//   from it at module scope, so on a device where money.js is missing store.js does not
//   degrade, it fails to evaluate, and index.html's bootstrap fails with it: a blank app,
//   offline, with no way for the user to do anything about it. That is exactly the test CORE
//   states for itself ("without these there is no app at all"), so it goes in the list whose
//   failure aborts the install and leaves the previous worker in charge. (CORE rather than
//   EXTRA, because store.js holds a static dependency on both files,
//   and EXTRA is explicitly allowed to fail.
//   /js/split.js is in EXTRA, with the other lazily-import()ed view modules. A device that
//   misses it still has every tab it had before, and one quick link that needs signal once —
//   the same trade agenda.js and map.js already make — and topUp() fetches it on the next
//   launch that reaches the network.
// v41: the tab bar is data. /js/tabs.js is CORE, not EXTRA, and for the same reason
// /js/money.js is: index.html imports it at module scope, so a device missing it does not
// lose a feature, it fails to evaluate the bootstrap and shows a blank app offline. Also in
// v41: the Settings tab is now Other, and the Split drawer opens at the normal detent instead
// of promoting itself the instant it appears.
// v55: accounts (the sign-in page and /js/auth.js changed; /account is new) and Split's
// polish. A navigation is now only ever answered from the cache with a copy of the page that
// was asked for: see standIn().
// v56: place subkinds come from one shared list (/js/shared/place-kinds.js, which icons.js
// now imports).
// v57: Delete buttons (.btn-danger) read in the warning color at rest.
// v58: every place subkind has its own glyph (22 showed their kind's until now).
// v59: /js/forget.js. Signing out clears the phone, and stored data is only ever shown or
// sent under the account it was stored for.
// v60: packing is the trip's lists. store.js now imports /js/shared/limits.js and
// /js/shared/trip-rules.js, and the shell imports /js/packing-refusals.js.
// v61: /js/toast.js, the one transient message, which the shell and four screens import.
// v62: /js/board-words.js, what the app says about shared boards (memories.js imports it).
// v63: a trip has an address. /t/<id>/ is the app (standIn); store.js imports
//      /js/trip-here.js and /js/trip-adopt.js; /js/trip-gone.js; and Your trips (/trips) with
//      what it loads, so it opens with no signal.
// v64: the Hike tab is gone, with its data (/js/hike.js, /js/scenario.js, /data/hike.json,
//      /data/contours.json); the default bar shows Memories in its place. activate() removes
//      the cache that data was kept in ("wgp-shell-live").
// v65: plans by hand. agenda.js imports /js/plan-editor.js, which imports /js/plan-form.js
//      (and /js/shared/clock.js, already here for the store).
// v66: /js/live.js, the trip's socket: store.js imports it at module scope (another person's
//      change arrives within seconds), so it is CORE, as money.js is. And the chat: /js/chat.js
//      and /css/chat.css (a section the router loads lazily), /js/chat-dot.js (the shell
//      imports it at module scope, so CORE).
// v67: the time zone's control is its own module, /js/zone-picker.js with /css/zone-picker.css:
//      trip-kit.js imports it at module scope (Your trips and a trip's settings), and the app's
//      plan sheet will load it too.
// v68: the map and Places read the trip's own areas (/js/areas.js, imported by both), and the
//      map's offline archive is the trip's own (/api/trips/<id>/tiles, kept by map.js). It also
//      carries /js/chat.js's new words (changed after v67 without a version of its own).
// v69: the chat sends what waits in its outbox on launch and when the signal returns (chat.js and
//      chat-dot.js changed); "New messages" on Your trips (trips.js, trip-kit.js, css/trips.css);
//      /js/chat-read.js, where reading a chat stopped, imported at module scope by chat-dot.js
//      (the shell) and trips.js, so CORE.
// v70: a place by hand: /js/place-form.js (its rules; the shell imports it at module scope),
//      /js/place-editor.js (the sheet) and /js/spot-picker.js (the sheet that puts it on the
//      map), all CORE. A flight's two time zones in the plan sheet (plan-editor.js,
//      plan-form.js), and "Chat about this" on a plan's page (agenda.js).
// v71: settling up in Split (split.js, money.js, store.js: payments, Mark paid, Record a payment);
//      Split shows a trip in its own currency to someone with no home currency; Make a trip
//      offers a new account a currency guessed from the phone (trips.js, trip-kit.js,
//      css/trips.css), from /js/shared/home-currency.js, imported at module scope by trips.js, so
//      CORE.
// v72: a phone that had the old app keeps its waiting changes: ids take underscores
//      (shared/trip-rules.js), and a packing item goes as exactly the fields its route takes
//      (store.js; PACKING_ITEM_FIELDS in shared/trip-rules.js).
// v73: a phone that had the app before a trip had an address: the old app's unsent changes
//      are carried over in this app's shapes (/js/old-queue.js, CORE: store.js imports it;
//      trip-adopt.js, store.js), index.html runs none of the app on an older worker's scripts
//      and its marker is data-app="wegoplace-app" (APP_MARKER here matches it as a prefix),
//      and what was not carried, or was carried and refused, is said until tapped (toast.js).
//      /js/fresh-app.js is that first script as a file, for every page that is not
//      index.html (the sign-in page ran the old worker's auth.js); CORE.
// v74: the pages outside a trip (login, join, Your trips, account, a trip's people) say
//      data-app="wegoplace-app", so the old app's worker never keeps them, and start their own
//      script through /js/fresh-app.js, so they never run on the old app's scripts.
// v75: Split: the viewer as "You" in who pays whom, sticky day headings, somebody else's line
//      as a read view, people who left set apart in a new purchase (split.js); a packing item's
//      fields named in shared/trip-rules.js only (the server now names what a write ignores).
// v76: pictures show: a place's, an event's and the trip's cover drawn from its picture
//      (shared/photo.js, new in CORE; agenda.js, places.js, settings.js' credits, trips.js),
//      and the trip's pictures pinned offline (pictures-offline.js, new in CORE; index.html).
// v77: "reduce motion" means no transition starts at all (0s, so what a script writes is what it
//      measures: the map fits its panel, a sheet's field is where the sheet ends); a flight's
//      zone as a chip that opens the zone picker; a place's kind and rating written by one
//      function in the list and under the map; a gap's length said the same way on the Agenda
//      and on Places; with the map's panel shut its buttons stand above the +; a place with no
//      address says so; comments that name no trip and no person.
// v78: the trip's list of changes made through connected apps, with an undo (/js/changes.js,
//      Other, Changes), and its mark on Other (/js/changes-dot.js, imported by the shell, and
//      /js/changes-seen.js, both new in CORE; tabs.js, chat-dot.js, router.js, store.js).
// v79: a trip's map is on the phone after the trip's first open with signal, with the map never
//      opened: one keep (map-keep.js, new in CORE) that the shell starts in idle time and the
//      map screen joins; every font the style names, the Latin ranges for a map that lists none.
//      A map that couldn't be made has "Try again" for the host; a place's local name is said
//      once (util.js, places.js, agenda.js); no disc stands on a disc or a pin, and a region's
//      name and a pin's label keep off the marks, the scale and the buttons (map.js).
// v80: an undo on the Changes screen said in the trip's own verbs, and its list's foot clear of the
//      Offline pill and Back (changes.js); the account page's AI apps card says how to connect one, the
//      Claude app first, then Claude Code, with Copy (account.html, account.js, css/account.css); the
//      empty Agenda's and Places' AI line lands on it (agenda.js, places.js).
// v81: a trip says where it is: Make a trip asks for a town (the towns' table, public/towns/,
//      kept in its own cache as it is typed and cleared on sign-out), which gives the zone and
//      the trip's first area; the trip's page lists its areas ("Where it goes"); the Map of a
//      trip with no area says how it gets one (city-search.js, zone-picker.js, trip-people.js).
// v82: Pack for today: a list for the day at the top of its days in the Itinerary, ticked there on
//      the trip's today, one line on its other days and once it is all packed; #/pack?list=<key>
//      opens that list (agenda.js, packing.js). The Itinerary keeps a day chosen by its pill until
//      the hand moves the list, and comes back to the day being read (half an hour, the same day).
//      While the first script says it is updating, the old app's tab bar takes no tap (fresh-app.js
//      and index.html's copy).
// v83: the site's second address (www.): every page's first script (www.js) sends a new visitor
//      to the address without it and keeps the app where it already lives; what the app prints for
//      someone else is the site's own address (site.js: the AI apps card, a join link, a shared
//      board); the sign-in button names Face ID or Touch ID only where the device has one (auth.js).
// v84: notes on plans are the chat's messages: the free time before a plan carries a count, its own
//      page and the chat name it "Free time / Before <plan>" (agenda.js, chat.js); the Changes
//      screen keeps a reading width on a desktop and its head's dot travels with the time
//      (changes.js); the AI apps card's Copy wraps under its code at a narrow width (account.css,
//      account.js); the chat opened again reads what was said while it was closed (chat.js).
// v85: a purchase's receipt, made to its size on the phone (picture-make.js), held there with no
//      signal and sent after its purchase (picture-wait.js, one place for every picture waiting:
//      a receipt, a place's or a plan's photo, the cover); Split's row and drawer say when it waits
//      or was refused, and why (receipts.js, split.js); every separator dot on Split's second line
//      travels with what follows it.
// v86: the Agenda opens on today (today's header under the strip, the live moment or what's next in
//      view; a plan over midnight carried onto the next day, "Still going"); a 720 px column on a
//      desktop (agenda.js, places.js, packing.js); a photo by hand on a place, a plan and the trip's
//      cover (photo-hand.js, places.js, agenda.js, trip-people.js), its link (?photo=add) and the
//      sign-in page keeping an address's # (auth.js); "Chat about this" on a place and a purchase,
//      and "Said about this place" (places.js, split.js, chat.js); kilometers or miles (util.js,
//      map.js, store.js, account.js).
// v87: notifications of the trip's chat: the chat's bell and its panel (push.js), the worker's push
//      and notificationclick (push-sw.js, by importScripts below: one notification per trip, a tap
//      opens its chat); signing out forgets this phone's subscription first (auth.js, forget.js).
// v88: a link to the chat about one thing (#/chat?about=, chat.js); the app's own address "/" with no
//      tab bar and nothing that looks like a trip before it goes on (index.html, styles.css); a
//      memory's day, read from when its photos were taken (taken.js, memories.js); Places' list ends
//      clear of the + (places.js); the map's fits keep the places clear of its buttons, "Nearby",
//      the scale and the +, in the middle of the room they leave (map.js).
// v89: the plan and the assistant (model §20), all of it invisible until the site switches it on: the
//      plan's card on the account page (account.html, account.js) and the assistant's changes named in
//      Changes, "The assistant, asked by …" (changes.js).
// v90: the assistant's screens (model §20): Chat's tabs Group and Assistant, the person's own
//      conversations and Share with group (assistant.js, assistant-room.js), the assistant's and a
//      shared answer in the group chat, @assistant never kept to send later (chat.js), the host's
//      month on the plan card (account.js); a poke while the chat reads asks for one more read.
// v91: a stranger's walk: the Agenda under way from a trip's second day, the trip's name over its
//      day strip, plain words ("Starts in 5 days", "8 things to pack", "3 payments settle everyone")
//      (agenda.js, packing.js, split.js); the money of where the trip goes guessed from its town, a
//      second country's offered (trips.js, trip-people.js, trip-kit.js); a pasted link that names the
//      place places it (place-editor.js); an empty Memories says what it is, on the app's page
//      (memories.js); the + beside the column on a wide window (styles.css).
// v92: a code line on the AI apps card breaks only between its words, never inside "--transport"
//      (account.js, account.css).
// v93: "What's yours" on Your account (account.html, account.js), and the layouts' bar: the same six
//      for everyone (Itinerary, Places, Split, Photos, Chat, More), a floating pill that ducks on a
//      phone, a rail from 768 and a sidebar from 1024, a sheet a dialog with a × from 768, Packing
//      behind More, the tab bar editor gone, the +'s room at a page's foot, the day strip's arrows
//      and wheel on a desktop (tabs.js, router.js, settings.js, styles.css, agenda.js, map.js, …).
// v95: the tab you're on: its bubble fits its name, the six evenly spaced (styles.css, tabs.js).
// v96: since my last: the store asks for what changed after the rev it holds, merges it (shared/delta.js, a
//      new file), and asks the trip's rev before its 90 s pull and on coming back (store.js).
// v97: the layouts (b) and (c): from 1024 two panes (the Itinerary beside a plan or the trip's map,
//      Places beside a place or its map; router.js PAIRS), Split as a table with its balance beside it,
//      keys on a desktop (the bar read first, a page's heading focused, Esc closes a pane's page),
//      "+ Add a plan" / "+ Add a place" named from 768 (router.js, agenda.js, places.js, split.js,
//      map.js, tabs.js, styles.css, index.html). A phone unchanged, pixel for pixel.
// v98: the limits sweep: the caps on phones, boards, conversations, purchases and exports, shared with the
//      server (shared/limits.js).
// v99: the named add from 768 on Split ("+ Add a purchase"), Packing ("+ Add an item") and Photos
//      ("+ Add memory"), no floating + there (split.js, packing.js, memories.js, styles.css). A phone
//      unchanged, pixel for pixel.
// v100: what breaks reaches the site's owner: js/error-report.js on every page (with shared/error-clean.js), and the
//       store saying when its changes keep failing to send (store.js).
// v101: a tablet turned between one pane and two keeps the list's place and the page's heading out of focus, and
//       a narrow window keeps Places' phone face (router.js, places.js). A phone unchanged, pixel for pixel.
// v102: every request this worker answers has a time limit: a page only the server makes waits 8 s, then says in
//       words there's no connection, with the way back to your trips; a picture, file or map piece it doesn't keep
//       gives up after 6 s, so the page's own offline state takes over (this file). Nothing a phone with signal sees.
// v103: the privacy page and terms (privacy.html, terms.html, css/legal.css, new files, not kept offline), linked from
//       the sign-in and account pages (login.html, account.html); a shared board's print the server can't keep as it is
//       (HEIC, AVIF) sent as a JPEG the phone draws (memories.js).
// v104: guests: a join link asks only a name, and joining makes a guest (join.html, js/join.js); the guest is told
//       once in the app, and on Your account where to keep their place (js/guest.js, index.html, account.js);
//       every sign-out a guest can press warns them (auth.js); People offers the host a link to sign a guest in
//       again (trip-people.js); Your trips says why a guest can't make one (trips.js); the sign-in page laid out
//       as Lexicommons' (login.html, auth.js). Guests' limits, the numbers the server refuses at
//       (js/shared/limits.js: people joining from one connection and by one link in an hour, a host's links to
//       sign a guest in again).
// v105: the board in the app plays its videos in place: the few nearest the middle loop their trimmed seconds,
//       muted, paused off screen and under an open memory; none by itself under reduced motion or when the phone
//       saves data (memories.js, with collage-video.js). "Download your data" is named by the day where the person
//       is (account.js).
// v106: a guest is told only the ways in this site has, and the empty Itinerary and Places tell a guest who can
//       connect an AI app (guest.js, index.html, account.js, auth.js, agenda.js, places.js, store.js); a one-use
//       sign-in link names who is signed in on the phone and asks before replacing them (login.html, auth.js); the
//       guest's note goes once they're an account and isn't set again on reopening a link (join.js); Google's and
//       GitHub's sign-in pass this worker untouched (this file); the board's videos stay paused under an open
//       memory through a return to the app, and data saver is read when it changes (memories.js).
// v107: the board keeps its place and zoom through the List and back, lets its videos go while hidden, fits right on
//       its first open (its layout size, not its entrance), and its play disc fades as a clip starts; data saver lets
//       the prints go back to their posters (collage.js, collage.css, collage-video.js, memories.js).
// v108: the board's play disc is above the clip while it fades; an empty board says what the Feed says, and a named
//       Save or share sits beside its sliders; the upload button says how many (the sheet's title shows whole); a
//       message never covers the chat's box; a person's buttons go under their name on the people page; adding a
//       passkey no longer promises any phone; a guest off a phone is told "this browser"; the sign-in screen says what
//       WeGoPlace is; Photos' head add says "+ Add photos" (collage.css, memories.js, memories.css, styles.css,
//       trips.css, auth.js, guest.js, account.js, trips.js, join.js, account.css, trips.html, join.html, login.html);
//       the privacy page and the terms name each other in a sentence at their foot, not in a line above the title
//       (privacy.html, terms.html, css/legal.css; still not kept offline).
// v109: the board is a board on a wall: a finite panel of its material (the cork is a photo texture, precached)
//       with a frame or edge and a shadow, on a plain painted wall; it grows with its photos and only grows, a 4:3
//       landscape for a few turning to a 3:4 portrait by twelve; every photo bare (no Photo style); Automatic is
//       the cork; the camera opens on the whole board above the + button and can't lose it; Save image draws the
//       same board on its wall (collage.js, collage-layout.js, collage-export.js, collage-frames.js, memories.js,
//       collage.css, memories.css, js/shared/board-look.js, js/shared/fasteners.js, textures/cork.jpg); a
//       navigation's top-up gives way to a waiting worker and stops by 20 s (this file).
// v110: on a phone under 375 px Photos' view switch is its words alone, so it stays on a 320 screen (memories.css).
// v111: on a phone on its side the rail takes the left safe area into its width, its symbols and names clear of the notch (styles.css, places.js).
// v112: on a short screen on its side the rail's places draw closer and More stands clear of the home bar (styles.css); a small board on a 320 phone opens above the + (collage.js); the terms and the privacy page scroll (css/legal.css).
// v113: from 768 the chat's box starts beside the rail, not over its foot (css/chat.css); on a short screen the map's three buttons lie in a row, clear of the page's head (map.js).
// v114: on a phone on its side with the map's panel open, a fit keeps the places beside the buttons' row, not over it (map.js).
// v115: on a short screen the map's panel opens at 150, a fit places the places in the strip the map really shows, a place's card keeps its pin in view, and the map's buttons stop under the head and the card's buttons clear the + (map.js). A phone on its side (landscape, no taller than 420) has the rail and the named adds whatever its width, as 844 had (styles.css, tabs.js RAIL, router.js, sheet.js, chat.css, agenda.js, places.js, packing.js).
// v116: the heading face is Bricolage Grotesque, in place of Fraunces (styles.css and every heading rule, agenda.js,
//       map.js, packing.js, places.js, css/chat.css, css/memories.css, css/account.css, collage-frames.js; the font file below).
// v117: a dark phone with no theme chosen is Void, the black ground (styles.css's system block, memories.css, the
//       pages' theme-color and their first paint, settings.js's System swatch and Void marked the dark default,
//       manifest.webmanifest); Slate and Night stay in the list.
// v118: the first trip's own pictures are out of public/img, so no one is ever served them; /img/CREDITS.json (the list this
//       worker keeps pictures by, IMG_MANIFEST) names the demo picture alone.
// v119: a request to the server is given up when it goes unanswered (12 s a read, 20 s a write) and counts as no
//       signal; an upload, and the assistant's streamed answer, when nothing moves for 30 s (js/net.js, store.js,
//       memories.js, picture-wait.js, site.js, auth.js, chat.js, chat-dot.js, changes.js, push.js, assistant.js,
//       assistant-room.js, map.js, index.html); a write that got no definite answer is never folded into (store.js);
//       an upload names its own id to begin (memories.js); a sheet goes by its own slide's end (sheet.js).
// v120: the design system (public/ds/: tokens, base, controls, lists, feedback, sheets, avatar, shell, and the pad and
//       the faces of a picture someone draws), /design, the shell on it (five tabs, More as your picture, the
//       sliding highlight, sheets that follow the finger, the toast beside the +, the rail with the logo and, from
//       1024, everything More holds), and the logo drawn by art/make_logo.py (the icons, the favicon, the wordmark
//       in the logo's own colours, the hikers' idle loop on the sign-in page only).
// v121: the picture someone draws, everywhere a person shows on their trips: Your account's picture and its pad (in a
//       sheet, the pad keeping its own strokes from the sheet's pull: sheet.js data-own-gesture), the faces of the chat,
//       Photos, More and the trip's people, your own at the top right, loaded by its hash and kept on the phone for the
//       account that may see it (js/pictures.js, js/account-picture.js).
// v122: the end of a list (the bar back at its end, no foot room past the last day: tabs.js, agenda.js), a sheet's
//       keyboard room with a foot (styles.css), chips that keep their words inside (styles.css).
// v123: the privacy page's and the terms' contact is the site's support address (privacy.html, terms.html).
// v124: Split on the design system (split.js: the answer at the top, purchases as two columns, the sheets on the
//       system, Settle up beside the feed from 1180), and a disabled control recolored, never dimmed (ds/controls.css,
//       ds/overlays.css).
// v125: More, Packing, People and settings and Your account on the design system (settings.js, packing.js,
//       pack-count.js new in CORE, trip-people.js, account.js, their pages and css; ds/controls.css's ds-modes and its
//       buttons pressing at 44); the design system's notes say what they draw (ds/lists.css, sheets.css, shell.css).
// v126: the paid plan in the Terms and on the privacy page (terms.html, privacy.html: who sells it, the card
//       statement's name, the refund and cancel lines, each held to the code).
// v127: Flows 3–6 on the design system (Itinerary & Plan with your AI, Places & Void/Paper map, Chat & Changes, Photos).
// v129: a disabled control says why in words (util.js setDisabled; the plan's, Split's and Photos' add sheets, a
//       place's pin button named by its hint).
// v130: Flow 8 on the design system: the sign-in page, an AI app asking to connect, and the shared board's wordmark
//       (signin.css, the /authorize pages, the board page).
// v128: DS colour tokens (--cat-*, --plan-*, --person-*), shared person avatar tokens, Itinerary plan-kind colours.
// v129: Itinerary full-width photo rows, Places & Map category colours, Split personal colours.
// v130: solid filled avatars, neutral plain plans, refined CVD tokens, colour throughout Map clusters, Chat, Changes, Photos & editors.
// v131: fix Split catVars import and paintMore note_color lookup.
// v132: fix Split You owe row grid placement (.sp-row > .sp-mark) and word wrapping.
// v133: show drawn pictures everywhere via faceHtml (incl. top right) with no colored ring.
// v134: gate hover/active to fine pointers and add delayed touch press controller (www.js).
// v135: the color train: the person's color everywhere (filled faces), the kinds' colors, "Your color" (Your account
//       and More), the one Back on the pages More opens, a sheet that grows with the system's motion (sheet.js).
// v136: the follow-up: the color drop, the plan card's words for every ending and paused sales, the all-day head, light's one ground, Other currency; (was) the color train: the person's color everywhere (filled faces), the kinds' colors, "Your color" (Your account
//       and More), the one Back on the pages More opens, a sheet that grows with the system's motion (sheet.js).
// v137: the plan's refusals said as the server says them (account.js), Checkout without payment_method_types.
// v138: polish: a read-only field (a link to copy) leaves a sheet's scrim translucent (sheet.js); Your account as its
//       mock-up: why you can't delete yet in a box naming the trips you host, Delete off with it as its reason; "Any
//       one of these gets you in" under the ways to sign in (account.html, account.js, account.css).
// v139: the assistant's documents and planner (js/shared/limits.js gains the documents' limits; privacy.html its
//       documents section; the paperclip and Back above the box on the assistant's screens).
// v140: the open-source scrub of public/: comments name no internal document, round or person (#6).
// v141: the tree as the public repository starts from it (step 5): the old place-kind names gone from the shell's reader.
// v142: the location question is the person's to ask: opening a screen never raises it (util.js getPosition quiet), the
//       Itinerary's "Show distance from me", a refusal kept, the map's locate button saying why (agenda.js, places.js,
//       map.js); "Use my location" spaced under Places' chips.
// v143: connecting Claude names the way in as claude.ai has it now (Customize → Connectors → + Add → Add custom
//       connector: account.html, plan-ai.js); one failed call to /api/auth/config never takes Google and GitHub off the
//       sign-in page (auth.js siteConfig asks again, then shows every way).
// v144: the installed app's top blur (variant A): no black-translucent status bar on any page, so iOS draws the status bar
//       opaque in theme-color and the page below it, out of the system's scroll-edge blur (takes effect on a new install).
// v145: the Itinerary's stays named by the day (Check in · / Staying at / Check out ·) and sorted into the day by time;
//       a plan's distance only within 100 km (agenda.js).
// v146: a plan given by the site's operator (0046): the account page's plan card says it's on and given, with nothing to
//       buy or manage (account.js).
// v147: no notice about reinstalling: the one-time card on the Itinerary is gone, its words, its key and its look (agenda.js).
// v148: Packing is lists and checkboxes: no bags on screen, no line per thing about the other lists, "Lists" for
//       "Lists and bags", "On it / Not on it" per list (packing.js, packing-refusals.js).
// v149: no meter: the assistant's screens show no amounts, and the account's plan card says nothing of the month until it
//       runs low (account.js, account.html, assistant.js, assistant-room.js).
// v150: Photos is Feed and Board (the List view and its files gone); "Add photos" opens the phone's picker first, then
//       one "Add photos" sheet with tags under More (memories.js, css/memories.css).
// v151: one build per page: every page names its build (meta wgp-build); a worker never answers a page of another build
//       and waits until a page asks it to take over; a page of an older build still open reads its own build's files;
//       fresh-app.js reloads once per build per tab, and takes a waiting update when hidden with nothing unsent.
// v152: the sign-in page: three ways in (Google, GitHub, a passkey) and one "Trouble signing in?" row; a passkey sign-in
//       back without one opens the account's making by a name (login.html, auth.js, signin.css).
// v153: the icons under names made from their bytes (/icons/favicon.<hash>.ico, icon-180/192/512.<hash>.png): every page,
//       the guard, the manifest, this precache and the notifications link those (tools/icon-names.mjs).
// v154: the picture and the color are one: a drawn picture on its owner's color in its one ink, the pad's colors,
//       More's "Your color" row and the account's color card gone (ds/pad.js, drawing.js, avatar.*, settings.js,
//       account.*).
// v155: a takeover asked for on a hide is counted only once it is seen (fresh-app.js later()): one that didn't follow is
//       asked for again on the next hide, not left until the next launch.
// v156: a tall drawer's drag aims where the drawer settles (sheet.js tallFor measures the [data-tall] rule's own height,
//       the status-bar band included).
// v157: Split's words: "Totals in" on the head's currency menu; a purchase's "For" (a plan, a day or a place) for
//       "Goes with" (split.js).
// v158: Invite people: one tap makes a join link (7 days, 10 people) and hands it on, from the trip's first screen and
//       People and settings, whose two choices fold under Link settings (js/invite.js, plan-ai.js, agenda.js,
//       trip-people.*, css/trips.css).
// v159: Make a trip asks Name, Dates and Where, and says what Where set in one line; the form waits behind Make a trip
//       when there are trips; no Back on a page reached from signing in or joining (trips.*, js/page-back.js).
// v160: Connect your AI is one sheet, opened from the trip, More and Your account (plan-ai.js, settings.js, account.*).
// v158: Connect your AI is one sheet, opened from the trip, More and Your account (plan-ai.js, settings.js, account.*).
// v157: Connect your AI is one sheet, opened from the trip, More and Your account (plan-ai.js, settings.js, account.*).
// v155: Connect your AI is one sheet, opened from the trip, More and Your account (plan-ai.js, settings.js, account.*).
// v154: Connect your AI is one sheet, opened from the trip, More and Your account (plan-ai.js, settings.js, account.*).
// v152: Connect your AI is one sheet, opened from the trip, More and Your account (plan-ai.js, settings.js, account.*).
// v150: Connect your AI is one sheet, opened from the trip, More and Your account (plan-ai.js, settings.js, account.*).
// v161: a plan's page: Change and Chat about this; its photo's buttons further down; its place's name opens the place,
//       Open in Maps its one button; the kind "Plan" named "Other" (agenda.js, plan-form.js).
// v162: Your trips on the design system like the app's other pages; People and settings with one Back, its title at the
//       left, and "What the group cares about" saying what reads it (trips.*, trip-people.*, css/account.css).
// v163: Report a bug: More › Report a bug (a sheet, js/report-form.js) and /report from the sign-in page; error-report.js
//       keeps the fingerprints the site answers its reports with (shared/bug-rules.js).
// v164: the Connect your AI sheet gives the site's own address from every way in (a trip's first screen and More too, not
//       only Your account), asked in plan-ai.js itself (plan-ai.js, agenda.js, account.js).
// v165: Report a bug's Version row reads the page's own build (meta wgp-build), so a page with no offline copy yet says it
//       (report-form.js).
// v166: the trip's quick reference list: a button mirroring the + on the left, its sheet, kept offline (js/references.js,
//       store.js "references", DB_VERSION 4, styles.css .rf-*, index.html).
// v167: no field zooms the page on iOS: the design system's fields at 16px (ds/controls.css .ds-input, .ds-textarea,
//       .ds-select), and Split's currency menus (split.js .sp-cur select).
// v168: Split's currency menu its own text with the 16px menu laid over it (no zoom, and Settle up's title whole at 320);
//       the quick reference opens at its list's top (references.js); no "<app> is adding to this trip" banner or toast
//       on the Itinerary (agenda.js, plan-ai.js).
// v169: the quick reference redesigned: a lighter 48 px tonal button on the
//       +'s centre line; the items as rows, the whole title row opening the item; "+ Add" at the sheet's top; an item's
//       form a sheet over the list with Save at its top and Remove inside it (references.js, styles.css .rf-*).
// v170: a takeover a hidden page asked for that lands after the person is back no longer reloads the page under them; the
//       next hide (or launch) loads it instead (fresh-app.js, inline on every page).
// v171: the privacy page says Cloudflare Web Analytics counts the site's visits (no cookies, nothing stored on the
//       device, no fingerprinting) instead of "no analytics" (privacy.html).
// v172: the quick reference no longer shows the word "null" under its list (references.js: replaceChildren() was handed
//       an empty child unfiltered).
const VERSION = "v172";

// Push notifications of the trip's chat (/js/push-sw.js: the push and notificationclick handlers).
// importScripts at the top level, as a classic worker must; the browser keeps it with the worker.
importScripts("/js/push-sw.js");
const CACHE = `wegoplace-shell-${VERSION}`;
const TILES = "wegoplace-tiles-v1";     // map glyphs and sprites; separate lifetime, see tiles()
const IMAGES = "wegoplace-img-v1";      // place photographs; separate lifetime, see syncImages()
// Offline trip photos and videos. Fourth cache, fourth lifetime, same reason as the other
// three — a VERSION bump must never cost the device a re-download of the originals somebody
// pinned for the trip. Everything that reads or writes it lives in the offline media block at the
// bottom of this file; nothing above that block is changed.
const MEDIA = "wegoplace-media-v1";
// The files of the towns' table a person's typing has asked for (public/towns/, see towns()).
// Its own cache for two reasons: a VERSION bump must not cost them again, and WHICH files are
// here says what somebody typed, so signing out clears this cache whole (forget.js lists it
// with the caches that hold a person's things). The "v1" moves when the table is made again
// (scripts/make_towns.mjs says so at its top): files of two snapshots never mix.
const TOWNS = "wegoplace-towns-v1";
// ONE BUILD PER PAGE. Which build each open page is, by its client id (the page says so when it starts: fresh-app.js,
// "app/page-build"), and when each older shell cache stopped being the current one. Kept in a cache, never only in
// memory: a browser stops an idle worker whenever it likes (iOS often), and the next request must still find a page's
// build. See shellFor() and sweepShells().
const PAGES = "wegoplace-pages";
const KEEP = new Set([CACHE, TILES, IMAGES, MEDIA, TOWNS, PAGES]);

// Without these there is no app at all, so install FAILS if any of them fails and the
// previously installed service worker stays in charge — a device that boots an old build is
// strictly better than one that boots nothing.
//
// "/" and never "/index.html": Pages 308s /index.html to /, and a redirected response cannot
// be written to Cache Storage. That single entry would take the whole install down with it.
const CORE = [
  "/",
  "/styles.css",
  // The design system the shell is drawn on (index.html links them): the bar and More without them
  // would be unstyled on a launch with no signal.
  "/ds/tokens.css",
  "/ds/base.css",
  "/ds/controls.css",
  "/ds/lists.css",
  "/ds/feedback.css",
  "/ds/sheets.css",
  "/ds/avatar.css",
  "/ds/shell.css",
  "/js/store.js",
  "/js/error-report.js",
  "/js/router.js",
  "/js/util.js",
  // Split math. Not a view module and not optional: store.js imports allocate() from here at
  // module scope, so this file is as load-bearing as store.js itself — a missing copy is a
  // module-evaluation error, not a missing feature, and it takes the whole bootstrap down on
  // exactly the cold offline launch this cache exists for. crawlAssets() would find it (it is
  // a quoted specifier inside a cached module) and topUp() would eventually repair it, but
  // both of those run AFTER an install that has already been declared a success.
  "/js/money.js",
  // The same rule: store.js imports it at module scope (how long a request may go unanswered).
  "/js/net.js",
  // The same rule as money.js: store.js imports it at module scope (what the phone keeps about
  // a person, and whose it is), and the sign-in and account pages load it to clear the phone.
  "/js/forget.js",
  // And these two, for the same reason again: store.js imports both at module scope (which
  // trip the page is; the database from before a trip had an address).
  "/js/trip-here.js",
  "/js/trip-adopt.js",
  "/js/old-queue.js",
  // The first script of every page but index.html, which carries the same text inline.
  "/js/fresh-app.js",
  // The very first script of every page: at a www. address, the same page without it unless this
  // phone keeps the app there. A phone that stays opens offline too.
  "/js/www.js",
  // The site's own address for what the app prints (the AI card, a join link, a shared board):
  // memories.js (the shell) imports it at module scope.
  "/js/site.js",
  // The trip's socket: store.js imports it at module scope.
  "/js/live.js",
  // The chat's unread mark: the shell imports it at module scope.
  "/js/chat-dot.js",
  // A guest's one message after joining (the shell), and the words the account page shows them.
  "/js/guest.js",
  // Where reading a chat stopped: chat-dot.js (the shell) and trips.js import it at module scope.
  "/js/chat-read.js",
  // The mark on Other for a change an app made (the shell imports it at module scope), and how
  // far the list was looked at (changes-dot.js and changes.js import it).
  "/js/changes-dot.js",
  // How much of your packing is done (More's Packing row and Packing itself count through it).
  "/js/pack-count.js",
  "/js/changes-seen.js",
  // Push notifications: the worker's handlers (importScripts above) and the page's side (the chat's
  // header loads it).
  "/js/push-sw.js",
  "/js/push.js",
  "/js/shared/home-currency.js",
  "/js/tabs.js",
];

// Wanted, but not worth failing the install over: a view module that is not deployed yet, or
// one flaky request on hotel wifi, must not cost us the five files above. Anything missing
// here is retried on the next launch that reaches the network — see topUp().
//
// The manifest leads the list rather than sitting in CORE because the OS fetches it itself at
// install time, so nothing offline depends on our copy of it.
//
// The view modules are listed explicitly because router.js import()s them lazily, so a user
// who never opened the Map tab before losing signal would otherwise never have map.js.
// "/login" and not "/login.html" for the same redirect reason as "/".
const EXTRA = [
  "/manifest.webmanifest",
  // icons.js and settings.js are core UI modules. crawlAssets() would find both — icons.js is a
  // static import in three view modules and settings.js appears as a string in router.js's
  // route table — but the crawl only runs after a successful install, and Settings is where
  // the connection status and the licence-obligation credits page live. Both are named here
  // so they are fetched in the same pass as the modules that need them.
  "/js/icons.js",
  // The list of place subkinds. icons.js imports it statically, so every screen that draws a
  // place needs it; named for the reason in the v9 note above (the crawl finds a module once
  // and never fetches it again).
  "/js/shared/place-kinds.js",
  "/js/settings.js",
  // The trip's list of changes (Other, Changes): a view module, import()ed by the router.
  "/js/changes.js",
  // The assistant (model §20): its screen, import()ed by the router, and what it and the chat
  // share (assistant-room.js, imported at module scope by chat.js, so without it the chat doesn't
  // load offline).
  "/js/assistant.js",
  "/js/assistant-room.js",
  // NOT reachable any other way, and the reason is in the v9 note at the top of this file:
  // crawlAssets() finds them once and then skips them forever, because it will not re-fetch a
  // key the cache already holds. Both are shell-shared — sheet.js is every sheet in the app
  // plus the keyboard freeze, motion.js is every animation — so a stale copy of either is a
  // whole round of fixes that reaches nobody who has already installed the app.
  "/js/sheet.js",
  "/js/motion.js",
  "/js/agenda.js",
  // The empty Itinerary's AI setup ("Plan it with your AI") and its Invite people (invite.js), live AI banner and shared first ask,
  // plus the sheet a plan is added and changed in, and its rules. agenda.js imports these at module
  // scope, so without all of them the Agenda itself does not load offline.
  "/js/plan-ai.js",
  "/js/invite.js",
  "/js/shared/first-ask.js",
  "/js/plan-editor.js",
  "/js/plan-form.js",
  "/js/places.js",
  // What the trip's areas mean (regions, the words for where a place is). places.js and map.js
  // import it at module scope, so without it neither loads offline.
  "/js/areas.js",
  // A place by hand: its rules (the shell imports them at module scope, for the sentence that
  // goes with a refused write, so without this file the app does not start offline), the
  // sheet, and the sheet that puts it on the map. The last two are fetched when first asked
  // for, which without signal is exactly when the crawl has not been there.
  "/js/place-form.js",
  "/js/place-editor.js",
  "/js/spot-picker.js",
  // Opening hours: the format, both readers and "open now". places.js imports it statically
  // (and map.js through places.js), so the crawl finds it, but only once and never again
  // (the v9 note above): named, so a deploy that changes how hours are read reaches a device
  // that already has the app.
  "/js/shared/hours.js",
  // The numbers and the rules the server and the app share, and how a trip's answer is taken in.
  // store.js imports all three (what a list's name may be, which day a list for the day is
  // ticked for, a delta merged into what it holds), so without them cached
  // the store does not load and nothing opens offline. Named for the same reason as the two
  // above.
  "/js/shared/limits.js",
  "/js/shared/error-clean.js",
  // A bug report's rules (error-report.js imports them on every page: which of the site's error groups this device was
  // told) and its form (settings.js imports it: More's Report a bug). /report itself is the server's, not kept here.
  "/js/shared/bug-rules.js",
  "/js/report-form.js",
  // The trip's quick reference list (index.html imports it: its button, and the sheet): emergency numbers open with no signal.
  "/js/references.js",
  "/js/shared/delta.js",
  "/js/shared/trip-rules.js",
  "/js/packing.js",
  // What to say when the server refuses a packing write; the shell imports it.
  "/js/packing-refusals.js",
  "/js/toast.js",
  "/js/board-words.js",
  "/js/map.js",
  // The keep of a trip's map: map.js imports it, and so does the shell, lazily, to keep the
  // map with the map screen never opened. Named so it is here with the shell on the first
  // visit, which is the visit that keeps the map.
  "/js/map-keep.js",
  // Split view, for the same reason as the four above: router.js import()s it lazily, so the
  // crawl can only reach it on a launch that already cached router.js WITH a split entry in
  // it, and only after an install that succeeded. Named here so it lands in the same pass as
  // the screens it sits beside. It needs no stylesheet line — split.js injects its own
  // <style id="sp-styles"> from a module-level string, so precaching the module precaches
  // the styles, and there is no <link> for crawlAssets() to be unable to see.
  "/js/split.js",
  // A place's, an event's and the trip's photograph: which to draw (agenda.js, places.js,
  // settings.js import it), and the module the shell loads to keep the trip's pictures offline.
  "/js/shared/photo.js",
  "/js/pictures-offline.js",
  // A purchase's receipt: split.js imports it, and the shell import()s it when receipts wait
  // on this phone, so a receipt taken with no signal is sent from the first launch after.
  "/js/receipts.js",
  // What receipts.js is made of, and the shell's loader of what waits: a picture made to its size,
  // and the pictures waiting to be sent.
  "/js/picture-make.js",
  "/js/picture-wait.js",
  // The chat: router.js import()s it lazily, and it links its own stylesheet when it mounts,
  // which crawlAssets() can't see; both named so the chat opens with no signal.
  "/js/chat.js",
  "/css/chat.css",
  // Pre-cached for the same reason as the four above and one more. memories.js is lazily
  // import()ed by the route table, so crawlAssets() can only find it once router.js carries a
  // memories entry — and /css/memories.css it can never find at all: the crawl walks cached
  // JAVASCRIPT, and that stylesheet is referenced only from a <link> in index.html. Without
  // these three lines the Memories tab is a blank, unstyled screen on the first launch with no
  // signal, which on this trip is four days long. Measured, not assumed —
  // scripts/memories_shell_check.mjs asserts all three land in this cache.
  "/js/memories.js",
  "/js/memories-save.js",
  "/css/memories.css",
  // The wordmark. crawlAssets() walks cached JavaScript for import specifiers and cannot see
  // a URL that only exists inside a fetch() call, so it would never find this on its own — and
  // the login screen, which is the FIRST thing a new person sees and often the first thing
  // anyone sees after a reinstall, is exactly where a missing mark is most obvious.
  "/img/wordmark.svg",
  // The W and its hikers, at the top of the rail on a tablet; fetched for the same reason as the wordmark.
  "/img/mark.svg",
  // Pre-cached because the board is import()ed lazily from the collage slot in memories.js, so the
  // crawl can reach it — but only on a launch that already cached memories.js, and only after a
  // successful install. Named here so the board and its four siblings land in the SAME pass as
  // the tab that opens them; a collage that needs the network is not a collage on the trail.
  "/js/collage.js",
  "/js/collage-layout.js",
  "/js/shared/board-look.js",
  "/js/shared/fasteners.js",
  // The Corkboard's material (136 KB): a board opened with no signal is still cork, never bare ground.
  "/textures/cork.jpg",
  "/js/collage-video.js",
  "/js/collage-frames.js",
  "/js/collage-export.js",
  "/css/collage.css",
  "/js/auth.js",
  "/login",
  // The rest of what the sign-in page loads. The page is held back until /js/auth.js has its
  // answers, and its layout and its provider mark come from a <link> and an <img>: the crawl
  // walks cached JAVASCRIPT, so it can see neither. Without these a sign-in page opened
  // from this cache is the right document with half its styles and a broken mark.
  // scripts/sw_navigation_check.mjs reads the list off the page and fails on a missing file.
  "/css/account.css",
  "/css/signin.css",
  "/img/marks/google-g.png",
  // Your trips, which is where the app's own address "/" sends a phone that keeps no trip, and
  // where a person goes from one trip to another: it has to open with no signal. The document
  // and what it loads that nothing above already lists (its other files are /styles.css,
  // /css/account.css, /js/auth.js, /js/forget.js, /js/shared/limits.js, the wordmark and the
  // two fonts). scripts/sw_navigation_check.mjs reads the list off the page, as for /login.
  "/trips",
  "/css/trips.css",
  "/js/trips.js",
  // The one Back on the pages of their own (Your trips among them): js/page-back.js.
  "/js/page-back.js",
  "/js/trip-kit.js",
  // trip-kit.js imports it at module scope, and the trips pages link its stylesheet.
  "/js/zone-picker.js",
  "/css/zone-picker.css",
  // zone-picker.js imports it at module scope: how a typed town is found. The table itself
  // (/towns/) is NOT here: 10 MB nobody asked for. Only its index is, 18 KB, which is what lets
  // a zone be said as a place ("Tokyo, Japan") on a phone with no signal that never typed a town.
  "/js/city-search.js",
  "/towns/index.json",
  "/js/shared/bytes.js",
  // What the shell loads when the server says a trip is gone (index.html imports it then, and
  // "then" may be the first second of signal after days without).
  "/js/trip-gone.js",
  "/vendor/fonts/inter-latin-wght-normal.woff2",
  "/vendor/fonts/bricolage-grotesque-latin-opsz-normal.woff2",
  "/vendor/fonts/instrument-sans-latin-wght-normal.woff2",
  "/vendor/fonts/geist-mono-latin-wght-normal.woff2",
  "/icons/icon-180.b5a4a30b.png",
  "/icons/icon-192.e2026552.png",
  "/icons/icon-512.6333653f.png",
  "/icons/favicon.1ad16064.ico",
];

// A navigation that has a good cached copy waits this long for the network and no longer.
// navigator.onLine is true on a wifi network with no route out, and a captive-portal or
// one-bar-of-EDGE fetch can hang for half a minute before it rejects.
const NAV_TIMEOUT = 3500;

// HOW LONG ANY REQUEST THIS WORKER ANSWERS MAY WAIT FOR THE SERVER, cached copy or not. A captive
// portal, or one bar in a valley, can take a request and never answer it; without a limit the
// page sits blank for as long as the network does, and the browser holds an installed update
// back for as long as this worker still owes a page an answer.
//   LIMIT_PAGE: a page only the server makes, and a first launch with nothing kept, then a page in
//     words (offlineDoc).
//   LIMIT_MISS: a file the caches don't hold (a module, a photograph, a town, map furniture, a
//     range of a video), then the request fails, as it does with no signal, and the page's own
//     retry or offline state takes over.
// Counted to the response's headers. A body already arriving is not cut off: a big download on a
// slow line is still a download.
const LIMIT_PAGE = 8000;
const LIMIT_MISS = 6000;

// Ceiling on a single map asset this worker will keep. Glyph ranges are tens of KB and a
// sprite sheet is a few hundred; anything past this is not the kind of file meant here.
const TILE_ASSET_MAX = 4 * 1024 * 1024;

// The build-time record of every self-hosted photograph — see the images appendix in
// CONTRACTS.md. scripts/fetch_images.py writes it in the same pass that writes the .webp
// files, so it is the enumeration of what is actually on disk rather than a second list that
// drifts. NOTHING HERE NAMES AN IMAGE FILE: add a place with a photo, re-run the script, and
// the new file precaches itself. Each entry carries card/hero paths and their encoded byte
// lengths, and those lengths are what makes a cached copy verifiable.
const IMG_MANIFEST = "/img/CREDITS.json";

// 92 files. Promise.all over the lot opens 92 sockets on hotel wifi at once, which on a weak
// uplink is slower than a queue and loses more of them; the shell's 17 are small enough for
// the flat version.
const IMG_CONCURRENCY = 6;

// Free space that must remain AFTER the photographs land, before this worker will precache the
// hero tier. map.js may still want ~40 MB of .pmtiles and store.js needs IndexedDB to keep
// growing; on iOS an origin that runs over quota is evicted WHOLE, which would take the
// itinerary with it. Losing the schedule to save a photograph is the wrong trade in every
// direction, so the hero tier yields first. Cards are never skipped.
const STORAGE_HEADROOM = 50 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch(req), given up once `ms` pass with no headers. Giving up aborts the request, so nothing
// is left open on the line, except for a navigation: a navigation's request cannot be copied with
// a signal of its own (the Request constructor refuses one), so that one is only stopped being
// waited for. Either way the page has its answer, and the worker owes it nothing.
function within(req, ms) {
  const own = req.mode === "navigate" ? null : new AbortController();
  const signal = own && (AbortSignal.any ? AbortSignal.any([req.signal, own.signal]) : own.signal);
  let timer = 0;
  const late = new Promise((_, no) => {
    timer = setTimeout(() => {
      if (own) own.abort();
      no(new Error(`no answer in ${ms} ms: ${new URL(req.url).pathname}`));
    }, ms);
  });
  return Promise.race([own ? fetch(req, { signal }) : fetch(req), late]).finally(() => clearTimeout(timer));
}

// Cache under the bare path, always. router.js retries a failed dynamic import as
// "./map.js?r=1" to defeat the module map's memoised rejection; without stripping the query
// that retry would store a second copy of the module and, offline, match nothing at all.
const keyFor = (url) => url.origin + url.pathname;

// What a response for this path must claim to be. A captive portal — a hotel lobby, an
// airport, a hostel — answers every request with 200 text/html. Cached once, that
// HTML sits where store.js should be and the app is dead for the rest of the trip. Status
// and redirect checks do not catch it because it is a genuine 200. Content type does.
const EXPECT = [
  [/\.m?js$/, /javascript|ecmascript/],
  [/\.css$/, /text\/css/],
  [/\.woff2?$/, /font|octet-stream/],
  [/\.png$/, /image\/png/],
  [/\.webp$/, /image\/webp/],
  [/\.ico$/, /image\/|icon/],
  [/\.webmanifest$/, /manifest|json/],
  [/\.json$/, /json/],
  // The towns' table (public/towns/t-*.txt, near.txt): kept by towns() for as long as the
  // person stays signed in, so a portal's page stored as one would empty a letter of the world.
  [/\.txt$/, /text\/plain/],
  [/\.pmtiles$/, /octet-stream|pmtiles/],
  // MapLibre glyph ranges and sprite vectors, served by functions/tiles/[[path]].js as
  // application/x-protobuf. Listed so tiles() checks them against something real instead of
  // falling through to the permissive default — a poisoned glyph range blanks every accented
  // place name on the map, permanently, because TILES is in KEEP and never re-verified.
  [/\.pbf$/, /protobuf|octet-stream/],
];

// A captive portal's page and this app's page are both 200 text/html — that is the same
// content type by definition, so typeOk() cannot separate them however it is written.
// Documents therefore need proof of IDENTITY, not just of shape. This marker is on <html> in
// index.html and login.html; it is a dedicated attribute rather than the <title> so that
// retitling the app can never silently disable the check.
//
// The marker is matched as a PREFIX, and index.html's value is "wegoplace-app", not
// "wegoplace", on purpose. Service worker v54 and older keeps any page that arrives from the
// network carrying the exact text data-app="wegoplace" as its own page for that address, and
// serves the scripts it kept beside it. A phone still under such a worker (it had the app
// before a trip had an address, and the new worker has not finished installing) would
// replace its kept page with this app's index.html on its first visit, and from then on, with
// no signal, open this page on the old scripts: which index.html refuses to run (see "THE ONE
// LOAD ON AN OLDER WORKER'S SCRIPTS" there), so the trip would not open at all. With a value
// that worker doesn't recognize, it keeps its own page, and with no signal still opens the
// old app whole until the new worker has taken over. The pages outside a trip keep the old
// value: an old worker keeping one of those does no harm.
const APP_MARKER = 'data-app="wegoplace';

function typeOk(pathname, res) {
  const ct = (res.headers.get("Content-Type") || "").toLowerCase();
  for (const [ext, want] of EXPECT) if (ext.test(pathname)) return want.test(ct);
  // Extension-less: the addresses a cached document may answer (standIn) are documents.
  // Anything else unknown at least must not be somebody's HTML.
  return standIn(pathname) !== null ? ct.includes("text/html") : !ct.includes("text/html");
}

function usable(pathname, res) {
  // 200 exactly, never 3xx: the auth middleware 302s to /login the moment a session lapses,
  // and a login page cached under "/" or "/js/store.js" poisons offline mode permanently.
  return !!res && res.status === 200 && !res.redirected && typeOk(pathname, res);
}

// ── precache ──────────────────────────────────────────────────────────────────────────────

// Hand-rolled rather than cache.addAll() because addAll cannot apply the content-type check
// above: it happily stores a captive portal's 200. `strict` reproduces addAll's all-or-
// nothing semantics for CORE.
async function precache(urls, strict, cacheName = CACHE) {
  const cache = await caches.open(cacheName);
  const failed = [];

  await Promise.all(urls.map(async (u) => {
    const url = new URL(u, location.origin);
    try {
      // cache:"reload" bypasses the HTTP cache. The whole point of a VERSION bump is a fresh
      // snapshot, and a revalidated 304 out of the browser cache is not one.
      // credentials default to same-origin, which is load-bearing: everything except the
      // manifest, icons and /login is behind the session cookie in functions/_middleware.js.
      const res = await fetch(new Request(url, { cache: "reload", credentials: "same-origin" }));
      if (!usable(url.pathname, res)) {
        throw new Error(`${res.status} ${res.headers.get("Content-Type") || "no type"}`);
      }
      await cache.put(keyFor(url), res);
    } catch (e) {
      failed.push(`${u} (${e.message})`);
    }
  }));

  if (failed.length) {
    if (strict) throw new Error("shell precache failed: " + failed.join(", "));
    console.warn("[sw] not cached, will retry next launch:", failed);
  }
  return cache;
}

// Any quoted string in a module that looks like a same-origin asset path. Import specifiers
// are the obvious case, but the load-bearing one is not an import at all: maplibre builds its
// worker URL as new URL(`./${name}`, import.meta.url), so an import-graph walk alone leaves
// /vendor/maplibre/maplibre-gl-worker.mjs uncached and the map dies the first time it is
// opened without signal. `${}` is excluded so half-interpolated templates are not chased.
const ASSET_REF = /["'`]([^"'`\s${}]{1,120}\.(?:mjs|js|css|wasm|woff2|png|svg|json))["'`]/g;

// Walk what the cached modules reference and pull that in too, one hop at a time. This is how
// a library vendored into /vendor/ by whoever owns map.js reaches the device before anyone
// taps Map — the alternative is editing EXTRA above every time another role vendors
// something, and the edit that gets forgotten is the one that matters at 4,200 m.
//
// A few misses are expected and harmless: a build-time-only sibling like
// maplibre-gl-worker-dev.mjs simply 404s and is logged. Tolerating that is the price of not
// hand-maintaining a list of files this role does not own.
async function crawlAssets(cache, stop = () => false) {
  const seen = new Set((await cache.keys()).map((r) => r.url));
  let queue = [...seen].filter((u) => /\.m?js$/.test(new URL(u).pathname));

  let budget = 60;                        // a reference cycle or a generated file cannot run away
  while (queue.length && budget > 0) {
    const found = [];
    const nextJs = [];
    for (const u of queue) {
      if (stop()) return;
      const res = await cache.match(u);
      if (!res) continue;                 // referenced but failed to fetch; nothing to scan
      for (const m of (await res.text()).matchAll(ASSET_REF)) {
        let target;
        try { target = new URL(m[1], u); } catch { continue; }
        if (target.origin !== location.origin) continue;
        const key = keyFor(target);
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(key);
        if (/\.m?js$/.test(target.pathname)) nextJs.push(key);
      }
    }
    if (!found.length) break;
    budget -= found.length;
    await precache(found, false);
    queue = nextJs;
  }
}

// Self-heal, once per service worker lifetime. EXTRA is allowed to fail, so a device can be
// carrying a shell that boots but is missing, say, map.js. A worker is spun up and killed
// around each launch, so "once per lifetime, on a navigation that reached the network" is
// about once per launch while there is still signal — precisely the window that matters.
//
// IT YIELDS TO AN UPDATE. A worker that has called skipWaiting() still takes over only once THIS worker has no
// waitUntil() left running, and a top-up is the longest one there is (a walk of every cached script, 92 images, a
// download of any that changed). So it stops between steps once a newer worker is installing or waiting (whatever
// it skips, that worker's install has done), and the navigation that starts it gives it TOPUP_CEILING at most.
// self.__busy names what is still running, for a check to read on a red.
const TOPUP_CEILING = 20000;
self.__busy = new Set();
const updateWaiting = () => { const r = self.registration; return !!(r && (r.waiting || r.installing)); };
let toppedUp = false;
async function topUp(stop = updateWaiting) {
  if (toppedUp) return;
  toppedUp = true;
  self.__busy.add("topUp");
  try { await topUpSteps(stop); } finally { self.__busy.delete("topUp"); }
}
async function topUpSteps(stop) {
  const cache = await caches.open(CACHE);
  const missing = [];
  for (const u of [...CORE, ...EXTRA]) {
    if (stop()) return;
    if (!(await cache.match(new URL(u, location.origin).href))) missing.push(u);
  }
  // Only re-crawl when something new landed. Re-scanning otherwise would re-request the
  // handful of references that are permanently 404 — a build-time-only sibling such as
  // maplibre-gl-worker-dev.mjs — on every single launch, for nothing.
  if (missing.length) {
    if (stop()) return;
    await precache(missing, false);
    await crawlAssets(cache, stop);
  }
  if (stop()) return;
  // Photographs are re-checked every launch regardless of whether the shell was short of
  // anything: they live in their own cache on their own lifetime, so a shell that is complete
  // says nothing about whether all 92 files arrived, and re-encoding the set at a different
  // quality rung changes bytes without changing a single shell file. The check is 92 reads of
  // a length already on disk and fetches nothing when it all agrees.
  await syncImages(stop).catch((err) => console.warn("[sw] image top-up failed:", err.message));
}

// ── place photographs ─────────────────────────────────────────────────────────────────────

// 46 places, two derivatives each: 3.27 MB of ~640px cards and 5.09 MB of ~792px heroes, 8.39
// MB with the manifest. With the ~1.9 MB shell that is ~10.2 MB precached, so BOTH TIERS SHIP.
// The threshold for dropping heroes to on-demand was ~15 MB and this is comfortably under it.
//
// Precaching heroes is a bet on the near future rather than on today's code: agenda.js renders
// cards on every scroll, and places.js renders no photograph at all yet but is the module the
// hero exists for. If the hero tier only arrived on demand, it would arrive over the network —
// which is precisely the thing that is not there for four days. A file nobody opened before the
// trailhead is a file nobody can open on it. 5.09 MB now buys that; the reverse does not exist.
//
// The manifest's byte lengths are what makes any of this checkable. A cached photograph is
// correct only if it is exactly as long as the build said it is, so re-encoding the set at a
// different quality rung — same filenames, different bytes — heals on the next launch with
// signal WITHOUT a cache-name bump, and a truncated or substituted body never survives.
async function syncImages(stop = () => false) {
  const cache = await caches.open(IMAGES);
  const manUrl = new URL(IMG_MANIFEST, location.origin);

  const res = await fetch(new Request(manUrl, { cache: "reload", credentials: "same-origin" }));
  if (!usable(manUrl.pathname, res)) {
    throw new Error(`${IMG_MANIFEST}: ${res.status} ${res.headers.get("Content-Type") || "no type"}`);
  }
  const manifest = await res.clone().json();
  // Kept on the device deliberately. CONTRACTS.md: a place that renders a photograph and no
  // credit is a licence violation, not a styling choice — so the attribution record has to be
  // offline everywhere the photographs are.
  await cache.put(keyFor(manUrl), res);

  const want = new Map();                 // cache key -> expected encoded length
  const cards = [];
  const heroes = [];
  for (const im of manifest.images || []) {
    for (const [variant, bucket] of [["card", cards], ["hero", heroes]]) {
      const path = im[variant];
      // Same-origin /img/ only. CONTRACTS.md forbids a remote image URL coming back, and this
      // is the layer that would otherwise quietly re-enable one by caching it.
      if (typeof path !== "string" || !path.startsWith("/img/")) continue;
      const key = keyFor(new URL(path, location.origin));
      want.set(key, im[`${variant}_bytes`] || 0);
      bucket.push(key);
    }
  }
  if (!want.size) throw new Error(`${IMG_MANIFEST}: no usable image entries`);

  // Anything the manifest no longer lists — a place deleted, a photograph replaced by one with
  // a different id — is dead weight on a phone that has to hold a map extract too.
  for (const req of await cache.keys()) {
    const key = keyFor(new URL(req.url));
    if (key !== keyFor(manUrl) && !want.has(key)) await cache.delete(req);
  }

  const stale = async (keys) => {
    const out = [];
    for (const k of keys) {
      if (stop()) return [];
      const hit = await cache.match(k);
      if (!hit) { out.push(k); continue; }
      // blob() on a Cache Storage response is a lazy view of bytes already on disk, so asking
      // 92 of them for .size does not read 8 MB into a phone's memory.
      // A manifest that stopped recording lengths falls back to presence rather than treating
      // every file as wrong — being unable to verify must not mean re-downloading 8 MB a launch.
      const bytes = want.get(k);
      if (!bytes || (await hit.blob()).size === bytes) continue;
      out.push(k);
    }
    return out;
  };

  // Cards first, always. They are the picture on every list row, they are half the weight of a
  // hero, and if the wifi dies halfway through install this is the half worth having.
  const failed = await fetchImages(cache, await stale(cards), want, stop);
  if (stop()) return;

  const staleHeroes = await stale(heroes);
  const need = staleHeroes.reduce((n, k) => n + (want.get(k) || 0), 0);
  if (staleHeroes.length && !(await roomForHeroes(need))) {
    // Not a failure and not retried differently: the /img/ fetch rule below is cache-first, so
    // heroes still land the first time a place detail is opened with signal. This is the
    // degraded mode, entered only on a phone that has no room for the good one.
    console.warn(`[sw] storage tight, ${staleHeroes.length} hero images left to on-demand`);
  } else {
    failed.push(...await fetchImages(cache, staleHeroes, want, stop));
  }

  if (failed.length) console.warn("[sw] images not cached, will retry next launch:", failed);
  else console.info(`[sw] images verified: ${want.size} files`);
}

// Not precache(): that function cannot check a body's length, and length is the whole point
// here. Status, redirect, content type AND encoded size all have to agree with what the build
// wrote, so a captive portal's 200 text/html, a 302 to /login and a truncated download are
// three separate walls rather than one. A photograph is the one asset where a wrong body is
// invisible — it renders as a picture, just not the right one.
async function fetchImage(cache, key, bytes) {
  const url = new URL(key);
  // credentials matter: /img/ is NOT in the middleware's PUBLIC list, so an anonymous fetch
  // gets a 401 or the HTML login redirect. Both are rejected below rather than stored.
  const res = await fetch(new Request(url, { cache: "reload", credentials: "same-origin" }));
  if (!usable(url.pathname, res)) {
    throw new Error(`${res.status} ${res.headers.get("Content-Type") || "no type"}`);
  }
  const body = await res.blob();
  if (bytes && body.size !== bytes) throw new Error(`${body.size} B, expected ${bytes} B`);
  await cache.put(key, new Response(body, { status: 200, headers: res.headers }));
}

async function fetchImages(cache, keys, want, stop = () => false) {
  const failed = [];
  for (let i = 0; i < keys.length; i += IMG_CONCURRENCY) {
    if (stop()) break;
    await Promise.all(keys.slice(i, i + IMG_CONCURRENCY).map(async (k) => {
      try {
        await fetchImage(cache, k, want.get(k));
      } catch (e) {
        failed.push(`${new URL(k).pathname} (${e.message})`);
      }
    }));
  }
  return failed;
}

// Every uncertain answer is `true`. A wrong "no room" costs the trip its place photographs for
// four days; a wrong "yes" costs some cache the browser was going to evict anyway.
async function roomForHeroes(need) {
  if (!navigator.storage || !navigator.storage.estimate) return true;
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    if (!quota) return true;
    return quota - usage > need + STORAGE_HEADROOM;
  } catch {
    return true;
  }
}

// ── one build per page ────────────────────────────────────────────────────────────────────
// A page and the modules it loads are always one build. Two roads used to break that (21 Nov: "personTone is not a
// function" on an installed iPhone): a worker answered a page's address with the NEW document from the network while
// it served every module from its own OLD cache; and a new worker took over pages already open (skipWaiting on its
// own), after which their lazy import()s came from the new build. Now: a worker never answers a page of another build
// than its own (navigation()); a new worker WAITS until a page asks it to take over (fresh-app.js: before the app
// starts, or when the page is hidden, then the page loads again); and a page of an older build that is still open when
// that happens (another tab) is answered from its own build's cache while that cache is here (shellFor()).
const SHELL = "wegoplace-shell-";
const PAGES_KEY = `${location.origin}/__wgp/pages`;
const DAY_MS = 24 * 60 * 60 * 1000;
// The build a page of this app names: <meta name="wgp-build" content="vNNN"> (sw_version_check holds it equal to VERSION).
const BUILD_IN = /<meta name="wgp-build" content="(v\d{1,6})">/;
const buildIn = (html) => BUILD_IN.exec(html)?.[1] || "";
// Read from the cache every time, never kept in memory: the worker in charge and a waiting one both write it, and a
// stopped worker starts again with nothing.
async function pagesRead() {
  try {
    const r = await (await caches.open(PAGES)).match(PAGES_KEY);
    const j = r ? await r.json() : null;
    return { pages: j?.pages || {}, retired: j?.retired || {} };
  } catch { return { pages: {}, retired: {} }; }
}
async function pagesWrite(m) {
  await (await caches.open(PAGES)).put(PAGES_KEY, new Response(JSON.stringify(m), { headers: { "Content-Type": "application/json" } }));
}
const openPageIds = async () => new Set((await self.clients.matchAll({ includeUncontrolled: true, type: "window" })).map((c) => c.id));
/** A page says which build it is, as it starts. Pages that are gone are forgotten here too. */
async function notePage(id, build) {
  if (!id || !/^v\d{1,6}$/.test(build || "")) return;
  const m = await pagesRead();
  const open = await openPageIds();
  for (const k of Object.keys(m.pages)) if (!open.has(k)) delete m.pages[k];
  m.pages[id] = { build, at: Date.now() };
  await pagesWrite(m);
}
/** The cache of the build a page is, when that's an older build whose cache is still here; else null (the current one). */
async function shellFor(clientId) {
  if (!clientId) return null;
  const build = (await pagesRead()).pages[clientId]?.build;
  if (!build || build === VERSION || !(await caches.has(SHELL + build))) return null;
  return caches.open(SHELL + build);
}
/**
 * A file, from the cache this page should read: its own build's shell (an older one, still open), else this build's,
 * else the caches that live across builds (photographs, tiles, media, towns). Never another build's shell: with older
 * shells kept for their open pages, an unscoped caches.match() would answer from whichever is oldest. A page whose build
 * isn't known reads this build's, as before.
 */
async function matchHere(key, clientId) {
  const own = await shellFor(clientId);
  if (own) { const hit = await own.match(key, { ignoreSearch: true }); if (hit) return hit; }
  // caches.match with a cacheName, never caches.open(): open() CREATES a cache that isn't there, and a person's caches
  // (media, towns) deleted at sign-out (forget.js) must stay gone, not come back empty with the next file asked for.
  for (const cacheName of [CACHE, IMAGES, TILES, MEDIA, TOWNS]) {
    const r = await caches.match(key, { ignoreSearch: true, cacheName });
    if (r) return r;
  }
  return undefined;
}
/**
 * Older shells go once no open page is of their build, and 24 hours after they stopped being the current one in any
 * case, so storage can't grow. Run when this worker takes over and when a page says its build.
 */
async function sweepShells() {
  const m = await pagesRead();
  const open = await openPageIds();
  const inUse = new Set(Object.entries(m.pages).filter(([id]) => open.has(id)).map(([, p]) => p.build));
  const now = Date.now();
  for (const k of await caches.keys()) {
    if (!k.startsWith(SHELL) || k === CACHE) continue;
    const build = k.slice(SHELL.length);
    m.retired[build] ??= now;
    if (!inUse.has(build) || now - m.retired[build] > DAY_MS) { await caches.delete(k); delete m.retired[build]; }
  }
  for (const b of Object.keys(m.retired)) if (!(await caches.has(SHELL + b))) delete m.retired[b];
  await pagesWrite(m);
}

// ── lifecycle ─────────────────────────────────────────────────────────────────────────────

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await precache(CORE, true);
    await precache(EXTRA, false);
    await crawlAssets(cache);
    // NO TAKEOVER ON ITS OWN (one build per page, above): this worker waits, and the worker before it stays in charge of
    // every open page, its modules included, until a page asks this one to take over (fresh-app.js: "app/skip-waiting",
    // sent before that page's app starts, or while it is hidden, and that page then loads again). An installed app is
    // never closed, so waiting for every page to close would never end; asking is how the update lands.
    // Photographs are no longer fetched here: a waiting worker that is asked to take over must be ready at once, not
    // after 8.4 MB. topUp() fetches them on the first launch with signal after it takes over.
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      // Only our own "wegoplace-" namespace. map.js keeps its stashed .pmtiles archive in
      // "wgp-tiles-v1"; a broader sweep here would throw away a 40 MB download every time
      // someone fixed a CSS token, and that bug would only ever show up on the trail.
      // An older shell is kept while a page of its build is still open (sweepShells decides, below).
      if (k.startsWith("wegoplace-") && !KEEP.has(k) && !k.startsWith(SHELL)) await caches.delete(k);
    }
    await sweepShells();
    // One cache outside that namespace is let go by name: it held the Hike tab's data file,
    // and since v64 nothing reads it. A phone that had the app before still carries it.
    await caches.delete("wgp-shell-live");
    // TILES is in KEEP, so it is never swept and nothing re-verifies it — which means a
    // portal response stored by the old tiles() would outlive every future VERSION bump.
    // The guard above stops new ones; this evicts any already on disk. Cheap: these are
    // glyph ranges and sprites, and a real one is re-fetched on next use.
    const tc = await caches.open(TILES);
    for (const rq of await tc.keys()) {
      const r = await tc.match(rq);
      if (r && (r.headers.get("Content-Type") || "").toLowerCase().includes("text/html")) {
        await tc.delete(rq);
      }
    }
    // claim() adopts only pages NO worker controls (a first visit, the load after an unregister): pages the worker
    // before controlled were handed over by this activation itself. Those adopted pages came from the network, this
    // build's own files, so nothing mixes; it keeps a first visit controlled (offline photos, the media cache).
    await self.clients.claim();
  })());
});

// ── fetch ─────────────────────────────────────────────────────────────────────────────────

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;

  // Network only. store.js caches trip data in IndexedDB and queues writes; a second copy
  // here would answer with rows it has no idea are stale.
  if (url.pathname.startsWith("/api/")) return;
  // Signing in with Google or GitHub: the callback is a navigation the server answers only after it has
  // asked the provider (and may already have signed the person in), so it gets no time limit of ours and
  // no stand-in: the browser alone, as for /api/.
  if (/^\/login\/(google|github)(\/|$)/.test(url.pathname)) return;

  if (url.pathname.startsWith("/tiles/")) { e.respondWith(tiles(e, req, url)); return; }
  if (url.pathname.startsWith("/img/")) { e.respondWith(image(e, req, url)); return; }
  if (url.pathname.startsWith("/towns/")) { e.respondWith(towns(e, req, url)); return; }
  // Offline media route, ahead of the generic range branch below on purpose: a video seek has to be
  // answered out of the media cache when there is one, and a MISS must stay a pass-through
  // rather than pulling a 400 MB body for a 64 KB read. See media() below.
  if (url.pathname.startsWith("/media/")) { e.respondWith(media(e, req, url)); return; }
  if (req.mode === "navigate") { e.respondWith(navigation(e, req, url)); return; }
  if (req.headers.has("range")) {
    e.respondWith(rangeFromCache(req).then((r) => r || within(req, LIMIT_MISS)));
    return;
  }
  e.respondWith(asset(e, req, url));
});

// WHICH CACHED DOCUMENT MAY STAND IN FOR A NAVIGATION, by the path that was asked for. The
// cache holds three documents: the app ("/"), which the server also sends for every trip's
// address /t/<id>/ (the app reads the trip from the address); the sign-in page ("/login"),
// which it also sends for /login/new and /login/link/<token>; and Your trips ("/trips").
// Those are the only addresses a cached copy can honestly answer. Every other page on the
// site is made by the server (the account page, a trip's people at /trips/<id>, a shared
// collage at /s/<id>/, the sign-in hops to Google or GitHub), and answering one of those
// with the app shell puts the trip's agenda at the address of somebody's account page. null
// means: nothing here can stand in, ask the server.
//
// /t/<id> without its slash is not here: the server answers it with a redirect to the slash
// form, and a redirect is never cached or stood in for.
function standIn(pathname) {
  if (pathname === "/" || pathname === "/index.html") return "/";
  if (/^\/t\/[A-Za-z0-9_.-]{1,64}\/$/.test(pathname)) return "/";
  if (pathname === "/login" || pathname === "/login/new" || /^\/login\/link\/[^/]+$/.test(pathname)) return "/login";
  if (pathname === "/trips") return "/trips";
  return null;
}

// Navigations are NETWORK-FIRST. A cache-first document pins an installed iOS app to a stale
// build forever — there is no reload button in standalone mode to escape it. (One address is
// answered from the cache at once, "/", and the reason it is safe is beside it below.)
async function navigation(e, req, url) {
  const stand = standIn(url.pathname);
  // A page only the server can make: its answer, up to LIMIT_PAGE, or a plain statement that
  // there is no connection, with the way back to the trips the phone keeps. Never the cache.
  if (stand === null) return within(req, LIMIT_PAGE).catch(() => offlineDoc(NO_SIGNAL));

  // This build's own kept page, never another build's (older shells are kept for their open pages: matchHere()).
  const cached = await (await caches.open(CACHE)).match(location.origin + stand, { ignoreSearch: true });

  // A page of ANOTHER build than this worker's (a deploy since it installed) is neither kept nor shown: shown, it would
  // run on this worker's modules (one build per page, above). The kept page of this build answers instead, and the
  // update reaches the person when the new worker takes over (fresh-app.js asks it to). Read from the page's meta.
  let otherBuild = "";
  const net = within(req, LIMIT_PAGE).then(async (res) => {
    if (usable(url.pathname, res)) {
      // usable() proves this is a 200 text/html. It CANNOT prove it is our HTML, and a hostal
      // portal answering the first navigation of the trip is exactly a 200 text/html. Caching
      // it overwrites the one document with no self-heal offline — images are re-verified by
      // byte length each launch and the shell is replaced on a VERSION bump, but a poisoned
      // "/" is only repaired by a navigation that reaches the real server, which on the trek
      // is four days away. So read the body and require the app marker before it may replace
      // the good copy. The portal page is still returned to the user below — they have to see
      // it to sign in; it just never reaches the cache.
      const clone = res.clone();
      const text = await res.clone().text();
      const build = buildIn(text);
      if (build && build !== VERSION) { otherBuild = build; return res; }
      if (text.includes(APP_MARKER)) {
        const c = await caches.open(CACHE);
        // Under the document's own name, not the address asked for: every trip's address is
        // the one app document, and a copy kept per trip would be a copy per trip to go stale.
        await c.put(location.origin + stand, clone);
        // Online and healthy: finish anything install missed, for TOPUP_CEILING at most (an update waits on it).
        e.waitUntil(Promise.race([topUp(), new Promise((ok) => setTimeout(ok, TOPUP_CEILING))]));
      }
    }
    return res;
  });

  // Before any early return: this keeps the worker alive past the race so a slow-but-
  // successful response (inside LIMIT_PAGE) still refreshes the cache, and it is also what makes the
  // e.waitUntil(topUp()) above legal — the event stays active while `net` is in flight.
  e.waitUntil(net.catch(() => {}));

  if (!cached) return net.catch(() => offlineDoc(NOT_INSTALLED));   // nothing kept: nothing else to show
  const ownIfOther = (res) => (otherBuild ? cached.clone() : res);

  // The app's own address names no trip. The document there does one thing: it sends the person
  // on, to a trip's address or to Your trips (index.html), and THAT navigation waits for the
  // server as below. Waiting here as well made a slow network cost NAV_TIMEOUT twice before
  // anything was on screen. So the kept copy answers at once. It cannot pin anybody to an old
  // build: the address it sends them to is asked of the server, and the request above still
  // runs and replaces the copy.
  if (url.pathname === "/" || url.pathname === "/index.html") return cached.clone();

  return Promise.race([net.then(ownIfOther), sleep(NAV_TIMEOUT).then(() => cached.clone())])
    .catch(() => cached.clone());
}

// Everything else is CACHE-FIRST and deliberately so: a module load must never wait on the
// radio. Freshness comes from bumping VERSION, not from revalidating each file — see the
// header. Lookups ignoreSearch so router.js's "?r=1" import retry still hits.
async function asset(e, req, url) {
  const hit = await matchHere(keyFor(url), e.clientId);
  if (hit) return hit;

  const res = await within(req, LIMIT_MISS);
  if (usable(url.pathname, res)) {
    const clone = res.clone();
    e.waitUntil(caches.open(CACHE).then((c) => c.put(keyFor(url), clone)));
  }
  return res;
}

// Photographs are CACHE-FIRST, the exact opposite of the navigation rule above, and the two
// opposite answers come from the same question: what does a stale copy cost? A stale document
// pins an installed iOS app to an old build with no reload button to escape it. A stale
// photograph of a ruin is still a photograph of that ruin. Filenames are stable per place
// (`<id>-card.webp`), content changes only when someone re-runs the fetch script, and
// syncImages() catches that by length on the next launch with signal — so nothing is gained by
// putting the radio in front of a picture, and on the trail there is no radio to put there.
//
// Separate from asset(): the only difference is which cache a MISS writes into. An image that
// failed at install and arrives on demand belongs in IMAGES, where the next VERSION bump will
// not throw it away again.
async function image(e, req, url) {
  const hit = await matchHere(keyFor(url), e.clientId);
  if (hit) return hit;

  const res = await within(req, LIMIT_MISS);
  if (usable(url.pathname, res)) {
    const clone = res.clone();
    e.waitUntil(caches.open(IMAGES).then((c) => c.put(keyFor(url), clone)));
  }
  return res;
}

// The towns' table: CACHE-FIRST, for image()'s reason (a file of it is the same file until the
// table is made again, and then TOWNS takes a new name). A file is fetched when somebody types
// the letters it is named after and kept from then on, so the towns a person has looked up
// are found again with no signal; the index arrives with the shell (EXTRA) and is answered
// from there. Nothing here asks ahead: a town nobody typed costs nobody a byte.
async function towns(e, req, url) {
  const hit = await matchHere(keyFor(url), e.clientId);
  if (hit) return hit;

  const res = await within(req, LIMIT_MISS);
  if (usable(url.pathname, res)) {
    const clone = res.clone();
    e.waitUntil(caches.open(TOWNS).then((c) => c.put(keyFor(url), clone)));
  }
  return res;
}

// Map data, and the one place two roles touch the same bytes.
//
// The .pmtiles archive is map.js's to keep, NOT ours. It already stashes the whole file in its
// own cache ("wgp-tiles-v1") behind a storage.estimate() check, a saveData check and a size
// cap. A second copy here would silently double a 40 MB download and quietly invalidate that
// quota check — and on iOS an origin that runs over quota is evicted whole, which would take
// the itinerary in IndexedDB with it. So: never store an archive from here.
//
// Glyphs and sprites are the opposite case. They are tens of KB, nobody else keeps them, and
// without them every label on the map is blank offline. Those we keep, in a cache that
// survives a shell VERSION bump — re-downloading map furniture because a CSS token moved is
// exactly the kind of thing that happens on the one bar of signal in a mountain village.
//
// Reads are cache-first across ALL caches (caches.match is origin-wide), so map.js's own
// stashed archive answers a plain GET here without either of us knowing about the other.
async function tiles(e, req, url) {
  if (req.headers.has("range")) {
    return (await rangeFromCache(req)) || within(req, LIMIT_MISS);
  }
  const hit = await matchHere(keyFor(url), e.clientId);
  if (hit) return hit;

  const res = await within(req, LIMIT_MISS);
  // usable(), not a bare status check: this was the one cache-writing path that skipped the
  // content-type guard, so a captive portal's 200 text/html was stored verbatim as map
  // furniture — into TILES, which is in KEEP and so survives every VERSION bump by design and
  // is never re-verified. A bad entry here is permanent for the life of the install.
  if (!url.pathname.endsWith(".pmtiles") && usable(url.pathname, res)) {
    const clone = res.clone();
    e.waitUntil((async () => {
      // Measured on the blob, not on Content-Length: Pages answers chunked and sends no
      // length at all, so a header check alone silently keeps nothing.
      const body = await clone.blob();
      if (body.size > TILE_ASSET_MAX) return;
      const c = await caches.open(TILES);
      await c.put(keyFor(url), new Response(body, { status: 200, headers: res.headers }));
    })());
  }
  return res;
}

// Offline byte ranges. iOS Safari will not accept a 200 where it asked for a range, so a
// cached body has to be sliced here or nothing that seeks works without signal.
async function rangeFromCache(req) {
  const cached = await matchHere(keyFor(new URL(req.url)), undefined);
  if (!cached) return null;

  const m = /^bytes=(\d+)-(\d*)$/.exec((req.headers.get("range") || "").trim());
  if (!m) return cached;

  // Blob, not arrayBuffer: Cache Storage keeps the body on disk and blob.slice() is a view,
  // so answering a 64 KB tile read costs 64 KB of memory rather than the whole archive.
  // ../reader could afford arrayBuffer because a chapter of audio is 8 MB; a map extract is
  // tens of MB and this runs on a phone with the screen on and GPS running.
  const body = await cached.blob();
  const total = body.size;
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  if (start >= total || end < start) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
  }

  return new Response(body.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": cached.headers.get("Content-Type") || "application/octet-stream",
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

// The pages in words, for when the server can't be reached (no signal, or no answer inside
// LIMIT_PAGE). NO_SIGNAL: a page only the server makes; the trips the phone keeps are one tap
// away (/trips is answered from the cache). NOT_INSTALLED: the cache holds no copy of the
// document asked for, so there is nowhere on the phone to send anybody.
const NO_SIGNAL = {
  title: "No connection right now",
  words: "This page comes from the server. Your trips are still here.",
  links: [["/trips", "Back to your trips"], ["", "Try again"]],
};
const NOT_INSTALLED = {
  title: "No connection",
  words: "WeGoPlace hasn't finished installing on this phone yet. Open it once with signal and it will keep working without.",
  links: [["", "Try again"]],
};

// Plain inline HTML with no dependencies, in the dark ground colour so it does not flash white.
// A link to "" opens the same address again.
function offlineDoc({ title, words, links }) {
  const a = links.map(([href, text]) => `<a href="${href}">${text}</a>`).join("");
  return new Response(
    `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>WeGoPlace</title>
<style>html{background:#14120f;color:#f0eae0;font:16px/1.5 system-ui,sans-serif}
body{margin:0;display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center}
p{max-width:26ch;margin:0 auto;color:#bdb4a5}
nav{display:flex;flex-direction:column;gap:12px;align-items:center;margin-top:24px}
a{color:#f0eae0;min-height:44px;display:inline-flex;align-items:center;padding:0 16px;border:1px solid #4a443b;border-radius:22px;text-decoration:none}
a:first-child{background:#f0eae0;color:#14120f;border-color:#f0eae0}</style>
<body><main><h1 style="font-size:20px;margin:0 0 8px">${title}</h1>
<p>${words}</p><nav>${a}</nav></main>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// ── offline media ─────────────────────────────────────────────────────────────────────────
//
// Self-contained offline media subsystem. Everything below this line is additive. VERSION and its
// semantics, navigation(), typeOk(), usable(), tiles(), image(), asset() and rangeFromCache()
// are untouched; the only change above is the one new cache name added to KEEP.
//
// The case: four days on a trail with no signal, and the Memories tab is where the
// trip's photographs are. So —
//
//   THUMBNAILS are cached on sight. They are ~40 KB of client-encoded WebP, they are the
//   entire feed, and a feed of grey rectangles is the tab not existing. No gate worth arguing
//   about.
//
//   ORIGINALS are cached when VIEWED or PINNED, never speculatively. A 4K clip off a
//   phone is hundreds of megabytes; precaching the set would fill the phone and, on iOS, an
//   origin that runs over quota is evicted WHOLE — which takes the itinerary in IndexedDB with
//   it. Opening a memory, or mediaCache.prefetch() from memories-save.js, is what pulls one.
//
//   The originals cache is bounded by MEDIA_ORIGINALS_BUDGET and evicted LRU. A PIN IS NEVER
//   EVICTED: pinning is a person saying "this one comes on the trail", and an eviction policy
//   that can overrule that is a policy that fails on exactly the day it exists for. When
//   everything left is pinned, the NEW item is refused instead — logged, not silent.
//
// RANGE REQUESTS, deliberately. The Cache API cannot store a 206 — cache.put() rejects one —
// and iOS Safari will not accept a 200 where it asked for a range, so video scrubbing needs a
// real 206 either way. Two rules follow, and they are the whole of the interaction:
//   1. A range request HITS by slicing a complete cached 200 into a 206, through the existing
//      rangeFromCache(), which already does exactly this for map tiles — blob-sliced, so a
//      seek costs the slice and not the file.
//   2. A range request MISSES straight to the network and caches NOTHING. Caching a range miss
//      means either storing a partial body under the key of a whole object — the bug that
//      makes an offline video play its first eight seconds and stop — or fetching the entire
//      file to answer a 64 KB seek, once per seek. A video becomes cacheable only through
//      prefetch/pin, which fetch it whole with no Range header; from then on every seek is
//      rule 1.
//
// The index: byte length, class, pin flag and last-use live in ONE JSON entry inside the media
// cache itself, under a synthetic off-origin key no request can collide with. A separate
// IndexedDB would be a second database with a second lifetime next to the one store.js owns;
// this rides the same eviction boundary as the bytes it describes, which is the only place it
// can never disagree with them.

const MEDIA_INDEX_KEY = "https://media-index.wegoplace.invalid/v1";

// Thumb/original classification is normally EXACT: mediaCache.register() hands over the `bytes`
// column from memory_media before anything renders. This is the fallback for a key nobody
// registered — a deep link, a stale feed — applied to Content-Length. Client thumbs are ~480px
// WebP, tens of KB; nothing a phone camera produces lands under this.
const MEDIA_THUMB_MAX = 512 * 1024;

// The ceiling on cached ORIGINALS. Sized against the rest of the phone: the shell is ~1.9 MB,
// tiles and photographs ~8.4 MB, map.js may stash a ~40 MB .pmtiles archive, and store.js needs
// IndexedDB to keep growing for the write queue. 320 MB is a generous trek's worth of full-res
// stills plus a few clips and still leaves a 64 GB phone unbothered. Tunable at runtime through
// mediaCache.setBudget(), for the same reason SHARE_BATCH_BYTES is tunable: the right number is
// a property of the device, calibrated on an actual iPhone.
const MEDIA_ORIGINALS_BUDGET = 320 * 1024 * 1024;
const MEDIA_BUDGET_MIN = 16 * 1024 * 1024;
const MEDIA_BUDGET_MAX = 2 * 1024 * 1024 * 1024;

// Thumbnails get their own, much smaller ceiling and their own LRU. At ~40 KB each this is
// ~1,500 thumbnails, comfortably more than this trip produces, and it exists only so a runaway
// feed cannot quietly become the largest thing on the device.
const MEDIA_THUMBS_BUDGET = 64 * 1024 * 1024;

// Prefetch is a background pull over hotel wifi. Two at a time: enough to keep the pipe busy,
// few enough that it does not starve the foreground request for the photo being looked at.
const MEDIA_PREFETCH_CONCURRENCY = 2;

// A read touches the LRU clock and a feed scroll is fifty reads. Coalesce them: collect keys
// and write the index once, rather than serialising a JSON blob per thumbnail.
const MEDIA_TOUCH_DEBOUNCE = 1500;

// ── index ────────────────────────────────────────────────────────────────────────────────
// Entry shape, kept terse because it is serialised on every write:
//   b  bytes            declared by register(), else Content-Length, else 0
//   c  class            "t" thumb | "o" original
//   p  pinned           1 | absent
//   s  stored           1 when the body is actually in the cache | absent
//   t  last used        epoch ms, the LRU clock
//   m  content type
// Top level also carries `x`, the budget override written by media/budget.

let mediaIndexP = null;                 // in-memory copy for this worker lifetime
let mediaWrite = Promise.resolve();     // serialises read-modify-write; one worker, one chain

async function mediaLoadIndex() {
  if (mediaIndexP) return mediaIndexP;
  mediaIndexP = (async () => {
    const cache = await caches.open(MEDIA);
    let idx = { v: 1, e: {} };
    try {
      const hit = await cache.match(MEDIA_INDEX_KEY);
      if (hit) {
        const parsed = await hit.json();
        if (parsed && parsed.e) idx = parsed;
      }
    } catch { /* corrupt index: rebuilt from what is on disk below */ }

    // Reconcile once per worker lifetime. The browser can drop a cache under storage pressure
    // without telling anyone, and an index claiming 300 MB of originals that are no longer
    // there would refuse to cache anything ever again. The cache is the authority on what
    // exists; the index is only the authority on what it MEANS.
    const present = new Set();
    for (const rq of await cache.keys()) {
      if (rq.url === MEDIA_INDEX_KEY) continue;
      present.add(rq.url);
    }
    for (const [k, ent] of Object.entries(idx.e)) {
      if (ent.s && !present.has(k)) delete ent.s;
    }
    for (const k of present) {
      if (!idx.e[k]) idx.e[k] = { c: "o", b: 0, t: Date.now() };
      idx.e[k].s = 1;
    }
    return idx;
  })();
  return mediaIndexP;
}

async function mediaSaveIndex(idx) {
  const cache = await caches.open(MEDIA);
  await cache.put(MEDIA_INDEX_KEY, new Response(JSON.stringify(idx), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

// Every mutation goes through here, so two in-flight fetch events cannot interleave a
// read-modify-write and lose one of the two updates.
function mediaMutate(fn) {
  mediaWrite = mediaWrite.then(async () => {
    const idx = await mediaLoadIndex();
    const out = await fn(idx);
    await mediaSaveIndex(idx);
    return out;
  }).catch((err) => {
    console.warn("[sw] media index write failed:", err && err.message);
  });
  return mediaWrite;
}

const mediaBudget = (idx) => Math.min(MEDIA_BUDGET_MAX, Math.max(MEDIA_BUDGET_MIN,
  Number(idx.x) > 0 ? Number(idx.x) : MEDIA_ORIGINALS_BUDGET));

function mediaTotals(idx) {
  const t = { o: { count: 0, bytes: 0 }, t: { count: 0, bytes: 0 }, pinned: { count: 0, bytes: 0 } };
  for (const ent of Object.values(idx.e)) {
    if (!ent.s) continue;
    const bucket = ent.c === "t" ? t.t : t.o;
    bucket.count += 1;
    bucket.bytes += ent.b || 0;
    if (ent.p) { t.pinned.count += 1; t.pinned.bytes += ent.b || 0; }
  }
  return t;
}

// ── LRU ──────────────────────────────────────────────────────────────────────────────────

const mediaTouches = new Set();
let mediaTouchTimer = false;

function mediaTouch(e, key) {
  mediaTouches.add(key);
  if (mediaTouchTimer) return;
  mediaTouchTimer = true;
  // waitUntil keeps the worker alive across the debounce; without it the timer is a coin flip.
  e.waitUntil(new Promise((resolve) => setTimeout(async () => {
    const keys = [...mediaTouches];
    mediaTouches.clear();
    mediaTouchTimer = false;
    const now = Date.now();
    await mediaMutate((idx) => { for (const k of keys) if (idx.e[k]) idx.e[k].t = now; });
    resolve();
  }, MEDIA_TOUCH_DEBOUNCE)));
}

// Make room for `need` bytes of class `cls`; true when there is room afterwards.
//
// Victims are the least recently used STORED entries of the same class that are NOT pinned.
// Pinned entries are never candidates, at any pressure. If the survivors still do not fit this
// returns false and the caller declines to cache the new item — the alternative is throwing
// away something a person explicitly asked to have on the trail in order to store something
// nobody asked for. Runs inside mediaMutate, which is what makes the read-modify-write safe.
async function mediaEvict(idx, cls, need) {
  const budget = cls === "t" ? MEDIA_THUMBS_BUDGET : mediaBudget(idx);
  const stored = Object.entries(idx.e).filter(([, en]) => en.s && (en.c || "o") === cls);
  let total = stored.reduce((n, [, en]) => n + (en.b || 0), 0);
  if (total + need <= budget) return true;

  const cache = await caches.open(MEDIA);
  const victims = stored
    .filter(([, en]) => !en.p)
    .sort((a, b) => (a[1].t || 0) - (b[1].t || 0));

  for (const [k, en] of victims) {
    if (total + need <= budget) break;
    await cache.delete(k);
    delete en.s;
    total -= en.b || 0;
    console.info("[sw] media evicted", new URL(k).pathname, en.b || 0, "B");
  }
  return total + need <= budget;
}

// ── fetch path ───────────────────────────────────────────────────────────────────────────

// Stricter than usable(): media keys often carry no extension at all, so typeOk()'s table has
// nothing to match and falls through to its permissive default. A photograph or a video
// announces itself as image/*, video/* or, from R2 with no recorded type, octet-stream —
// anything else answering /media/ is a captive portal, a login redirect or an error page, and
// none of those may reach the cache where a memory is supposed to be.
function mediaUsable(res) {
  if (!res || res.status !== 200 || res.redirected) return false;
  const ct = (res.headers.get("Content-Type") || "").toLowerCase();
  if (!ct || ct.includes("text/html")) return false;
  return /^(image|video|audio)\//.test(ct) || ct.includes("octet-stream");
}

function mediaDeclaredBytes(entry, res) {
  if (entry && entry.b > 0) return entry.b;
  const n = Number(res && res.headers.get("Content-Length"));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function media(e, req, url) {
  const key = keyFor(url);

  // Range: slice a complete cached body, or pass straight through. Never cache. See the header
  // note — this is the rule that stops an offline video playing eight seconds and halting.
  if (req.headers.has("range")) {
    const sliced = await rangeFromCache(req);
    if (sliced) { mediaTouch(e, key); return sliced; }
    // Same reasoning as the whole-object miss below: a rejected respondWith reaches <video> as
    // an opaque decode failure, and a labelled status is something the viewer can render.
    try { return await within(req, LIMIT_MISS); } catch { return new Response("", { status: 504, statusText: "media not cached" }); }
  }

  const cache = await caches.open(MEDIA);
  const hit = await cache.match(key);
  if (hit) { mediaTouch(e, key); return hit; }

  let res;
  try {
    res = await within(req, LIMIT_MISS);
  } catch {
    // Offline and not cached. A 504 the viewer can recognise beats a rejected promise, which
    // surfaces in the page as an unlabelled TypeError with no way to tell it from a bug.
    return new Response("", { status: 504, statusText: "media not cached" });
  }
  if (!mediaUsable(res)) return res;

  // The save path pulls originals it is about to hand to the share sheet. Those bytes are on
  // their way to Photos; writing a 350 MB batch into a 320 MB cache would evict the whole trek
  // to store copies of files the phone now has twice. Reads still hit the cache above — this
  // suppresses the WRITE only.
  if ((req.headers.get("x-wgp-media") || "") === "save") return res;

  const idx = await mediaLoadIndex();
  const entry = idx.e[key];
  const bytes = mediaDeclaredBytes(entry, res);
  const cls = entry && entry.c ? entry.c : (bytes && bytes <= MEDIA_THUMB_MAX ? "t" : "o");

  // Unknown length and unregistered: refuse rather than guess. Caching a body of unknown size
  // makes the byte ceiling fiction, and the ceiling is what stops this cache from being the
  // reason the itinerary gets evicted.
  if (!bytes) return res;

  const clone = res.clone();
  e.waitUntil(mediaStore(key, clone, cls, bytes, res.headers.get("Content-Type") || ""));
  return res;
}

// Streams into the cache. Nothing is buffered: cache.put() consumes the clone's body as it
// arrives, which is why a 400 MB video can be stored on a phone at all.
async function mediaStore(key, response, cls, bytes, mime) {
  // OS-level headroom, not just our own ceiling. roomForHeroes() is the existing answer to "is
  // there space for `need` bytes on top of STORAGE_HEADROOM", and it is asked here for the same
  // reason it is asked there — every uncertain answer is yes, because a wrong "no" costs the
  // trip its photographs and a wrong "yes" costs a cache the browser was going to evict anyway.
  if (cls === "o" && !(await roomForHeroes(bytes))) {
    console.warn("[sw] storage tight, not caching original", new URL(key).pathname);
    return;
  }
  await mediaMutate(async (idx) => {
    if (!(await mediaEvict(idx, cls, bytes))) {
      console.warn("[sw] media cache is all pins, not caching", new URL(key).pathname);
      return;
    }
    const cache = await caches.open(MEDIA);
    try {
      await cache.put(key, response);
    } catch (err) {
      // An aborted page fetch errors the cloned stream. Not worth surfacing: the next open
      // re-fetches, and half a video in the cache is the one outcome that must not happen.
      console.info("[sw] media not stored", new URL(key).pathname, err && err.message);
      return;
    }
    const ent = idx.e[key] || (idx.e[key] = {});
    ent.c = cls;
    ent.b = bytes;
    ent.s = 1;
    ent.t = Date.now();
    if (mime) ent.m = mime;
  });
}

// ── prefetch ─────────────────────────────────────────────────────────────────────────────

// Deliberately NOT a range request, and deliberately whole-object: this is the one path that
// makes a video seekable offline, because rangeFromCache() can only slice a body it has all
// of. Needs signal, by design — the spec is explicit that uploads and first views require
// coverage, and a retry queue that pretended otherwise would fill the phone with video.
async function mediaPrefetchOne(key) {
  const idx = await mediaLoadIndex();
  const cache = await caches.open(MEDIA);
  if (await cache.match(key)) return "cached";

  const res = await fetch(new Request(key, { credentials: "same-origin" }));
  if (!mediaUsable(res)) return `bad:${res.status}`;

  const entry = idx.e[key];
  const bytes = mediaDeclaredBytes(entry, res);
  if (!bytes) return "unknown-length";
  const cls = entry && entry.c ? entry.c : (bytes <= MEDIA_THUMB_MAX ? "t" : "o");
  await mediaStore(key, res, cls, bytes, res.headers.get("Content-Type") || "");
  return (await cache.match(key)) ? "fetched" : "refused";
}

async function mediaPrefetch(keys) {
  const out = { fetched: 0, cached: 0, failed: [] };
  for (let i = 0; i < keys.length; i += MEDIA_PREFETCH_CONCURRENCY) {
    await Promise.all(keys.slice(i, i + MEDIA_PREFETCH_CONCURRENCY).map(async (k) => {
      try {
        const r = await mediaPrefetchOne(k);
        if (r === "fetched") out.fetched += 1;
        else if (r === "cached") out.cached += 1;
        else out.failed.push(`${new URL(k).pathname} (${r})`);
      } catch (err) {
        out.failed.push(`${new URL(k).pathname} (${err && err.message})`);
      }
    }));
  }
  return out;
}

// ── messages ─────────────────────────────────────────────────────────────────────────────
//
// The only control surface. `mediaCache` in memories-save.js is the only caller; these message
// names are duplicated there and nowhere else.

// The page speaks in R2 keys, the cache speaks in absolute URLs. One conversion, here, so a key
// spelled two ways can never become two cache entries — one of which is always the missing one.
function mediaKeyToUrl(k) {
  const s = String(k || "").replace(/^\/+/, "");
  if (!s) return null;
  const path = s.startsWith("media/")
    ? "/" + s
    : "/media/" + s.split("/").map(encodeURIComponent).join("/");
  try { return keyFor(new URL(path, location.origin)); } catch { return null; }
}

self.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg || typeof msg.type !== "string") return;

  // WHICH BUILD AM I RUNNING. A service worker serves its precached shell until a VERSION bump
  // replaces it, so a phone can sit on an old bundle indefinitely while the server has moved on
  // — and there was no way to tell from inside the app. That cost real review rounds: fixes were
  // reported as "still broken" when the device had simply never taken them.
  if (msg.type === "app/version") {
    if (e.ports && e.ports[0]) e.ports[0].postMessage({ version: VERSION });
    return;
  }
  // Take over NOW rather than after every tab is closed. Only ever when a page asks: a deliberate tap in Settings, or
  // fresh-app.js before a page's app starts (its build differs) or while the page is hidden with nothing unsent. Never
  // on its own, because swapping the shell under a person mid-edit is its own bug; an older page still open elsewhere
  // keeps reading its own build's files (shellFor()).
  if (msg.type === "app/skip-waiting") { self.skipWaiting(); return; }
  // A page says which build it is, as it starts (fresh-app.js): the worker answers its modules from that build's cache.
  if (msg.type === "app/page-build") {
    e.waitUntil(notePage(e.source && e.source.id, msg.build).then(sweepShells).catch(() => {}));
    return;
  }

  if (!msg.type.startsWith("media/")) return;
  const reply = (data) => { if (e.ports && e.ports[0]) e.ports[0].postMessage(data); };
  e.waitUntil(mediaMessage(msg, reply).catch((err) => {
    console.warn("[sw]", msg.type, "failed:", err && err.message);
    reply({ ok: false, reason: (err && err.message) || "failed" });
  }));
});

async function mediaMessage(msg, reply) {
  const urls = (msg.keys || []).map(mediaKeyToUrl).filter(Boolean);

  switch (msg.type) {
    // What the feed knows: exact byte lengths out of memory_media, and which key is a
    // thumbnail. Registering costs nothing and removes every guess from the fetch path.
    case "media/register": {
      await mediaMutate((idx) => {
        for (const it of msg.items || []) {
          const u = mediaKeyToUrl(it.key);
          if (u) {
            const ent = idx.e[u] || (idx.e[u] = { t: 0 });
            ent.c = "o";
            if (it.bytes > 0) ent.b = it.bytes;
            if (it.mime) ent.m = it.mime;
          }
          const tu = mediaKeyToUrl(it.thumbKey);
          if (tu) {
            const ent = idx.e[tu] || (idx.e[tu] = { t: 0 });
            ent.c = "t";
            ent.of = u || ent.of;
            // A thumbnail inherits its original's pin: a pinned memory whose thumbnail was
            // evicted is a pinned memory that shows a grey rectangle in the feed.
            if (u && idx.e[u] && idx.e[u].p) ent.p = 1;
          }
        }
      });
      const idx = await mediaLoadIndex();
      return reply({ ok: true, known: Object.keys(idx.e).length });
    }

    case "media/prefetch":
      return reply({ ok: true, ...(await mediaPrefetch(urls)) });

    case "media/pin": {
      const set = new Set(urls);
      await mediaMutate((idx) => {
        for (const u of urls) {
          const ent = idx.e[u] || (idx.e[u] = { c: "o", b: 0, t: Date.now() });
          ent.p = 1;
          ent.t = Date.now();
        }
        for (const ent of Object.values(idx.e)) if (ent.c === "t" && set.has(ent.of)) ent.p = 1;
      });
      return reply({ ok: true, ...(await mediaPrefetch(urls)) });
    }

    case "media/unpin":
      await mediaMutate((idx) => {
        const set = new Set(urls);
        for (const u of urls) if (idx.e[u]) delete idx.e[u].p;
        for (const ent of Object.values(idx.e)) if (ent.c === "t" && set.has(ent.of)) delete ent.p;
      });
      return reply({ ok: true });

    case "media/forget": {
      const cache = await caches.open(MEDIA);
      await mediaMutate(async (idx) => {
        for (const u of urls) { await cache.delete(u); delete idx.e[u]; }
      });
      return reply({ ok: true, forgotten: urls.length });
    }

    case "media/budget": {
      const want = Number(msg.bytes);
      await mediaMutate((idx) => {
        idx.x = Math.min(MEDIA_BUDGET_MAX, Math.max(MEDIA_BUDGET_MIN, want || MEDIA_ORIGINALS_BUDGET));
      });
      // Applied immediately, not at the next fetch: lowering the ceiling has to shed bytes now,
      // or a phone that is short of space stays short until somebody happens to browse.
      await mediaMutate((idx) => mediaEvict(idx, "o", 0));
      return reply({ ok: true, budget: mediaBudget(await mediaLoadIndex()) });
    }

    case "media/stats": {
      const idx = await mediaLoadIndex();
      const t = mediaTotals(idx);
      let quota = null;
      let usage = null;
      try {
        if (navigator.storage && navigator.storage.estimate) {
          const est = await navigator.storage.estimate();
          quota = est.quota ?? null;
          usage = est.usage ?? null;
        }
      } catch { /* unsupported: reported as null rather than guessed at */ }
      return reply({
        ok: true,
        originals: t.o,
        thumbs: t.t,
        pinned: t.pinned,
        budget: mediaBudget(idx),
        thumbsBudget: MEDIA_THUMBS_BUDGET,
        quota,
        usage,
      });
    }

    default:
      return reply({ ok: false, reason: "unknown" });
  }
}

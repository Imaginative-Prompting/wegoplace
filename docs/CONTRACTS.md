# Build contracts

Every module is written against these. Agents own disjoint files; nothing here is
negotiable mid-build because other modules are compiled against it.

## File ownership

| Owner | Files |
|---|---|
| shell | `public/index.html`, `public/styles.css`, `public/js/store.js`, `public/js/router.js`, `public/js/util.js`, `public/js/icons.js`, `public/js/settings.js` |
| api | `functions/api/trip.js`, `events.js`, `places.js`, `packing.js`, `notes.js`, `functions/tiles/[[path]].js` |
| agenda | `public/js/agenda.js` |
| places | `public/js/places.js` |
| packing | `public/js/packing.js` |
| map | `public/js/map.js` |
| login | `public/login.html`, `public/js/auth.js` |
| offline | `public/sw.js`, `public/manifest.webmanifest` |

Nobody edits a file they do not own. Shared changes go through the shell owner.

## store.js — the only way modules touch data

Offline-first. Reads never hit the network; they resolve from IndexedDB, and a background
refresh updates the cache and re-emits. Writes apply optimistically to the local cache,
enqueue, and flush when online.

```js
import { store } from "./store.js";

await store.ready();                  // hydrate from IndexedDB, kick a background refresh

store.trip();                         // { id, name, starts_on, ends_on, default_tz }
store.events();                       // Event[]  sorted by starts_at
store.places();                       // Place[]
store.packing(owner);                 // PackingItem[]   owner = userId | 'group'
store.packLists();                    // the TRIP's lists, in order: { key, name, sort, repeat, dates, bags: [{ key, name, sort }] }
store.packBag(itemId, listKey);       // the bag key an item sits in on a list, or null: not carried
store.packTicked(itemId, listKey, day); // day is null on a list packed once
store.packDay(listKey);               // { day, open }: the trip's day a list for the day is ticked for, and whether today is one of its days
store.packHeld(listKey, bagKey);      // how many placements THIS PHONE knows of (yours and the group's); bagKey null counts the list
store.packStarters();                 // the trip's suggested items
store.me();                           // { id, name, tab_layout }. Who hosts the trip is trip.host_id
store.members();                      // v2. Member[] with note_color + initials
store.notes(eventId);                 // EventNote[]  ALL anchor kinds, sorted oldest first

// v8 / Split. A purchase is an ordinary rowstore row (kind "purchase", ids uid("pu"),
// envelope { purchase: row }, wire /api/purchases) — optimistic, queued, folded, replayed.
// `currencies` and `fx` are server-owned singletons riding `meta`, like members/noteColors.
store.purchases();                    // Purchase[]  NEWEST first (spent_at desc, then toMs(created_at))
store.purchase(id);                   // Purchase | null
store.currencies();                   // ["PEN","USD"] — the trip's short list, home currency first
store.fx();                           // { base:"USD", rates:{}, fetched_at, next_at }  frozen; 0 = never fetched
store.myNativeCurrency();             // "USD" until chosen
store.canEditPurchase(row);           // created_by === me.id || paid_by === me.id

await store.addPurchase(partial);     // -> Purchase   share_minor is RECOMPUTED, never trusted
await store.updatePurchase(id, patch);// any patch touching amount_minor/currency/amount_exp/
                                      // split_mode/shares must carry ALL FIVE (shallow fold)
await store.deletePurchase(id);
await store.setNativeCurrency(code);  // kind:"me", folds with note_color + initials
await store.refreshRates();           // -> FxTable    no-op offline; needs functions/api/fx.js

await store.addEvent(partial);        // -> Event      optimistic   (v2: NOTHING CALLS THIS)
await store.updateEvent(id, patch);   // rejects unless created_by === me.id   (v2: unused)
await store.deleteEvent(id);          // rejects unless created_by === me.id   (v2: unused)
await store.addNote(eventId, body, { anchor_kind });  // 'event' (default) | 'gap' 
await store.setPacking(id, patch);    // label, qty, note, category, sort. Never where it sits or whether it is packed
await store.addPacking(owner, partial); // partial.bags = { list key: bag key }: the bags it starts in, sent with the item
await store.deletePacking(id);
await store.tickPacking(itemId, listKey, day, ticked);
await store.placePacking(itemId, listKey, bagKey);   // bagKey null: off that list (its ticks there go too)
await store.addPackList(name, bagNames);             // -> key. Packed once
await store.setPackList(key, { name, sort });
await store.deletePackList(key);                     // throws for the last list, or one this phone sees things on
await store.addPackBag(listKey, name);               // -> key
await store.setPackBag(listKey, bagKey, { name, sort });
await store.deletePackBag(listKey, bagKey);          // throws for a list's last bag, or one this phone sees things in

store.on("change", fn);               // fires after any local or synced mutation
store.online();                       // boolean
store.pending();                      // count of unflushed writes

// Which trip. A page is bound to ONE trip for its whole life: see "Which trip a page is" below.
store.tripId();                       // the id in the address, "/t/<id>/". Never a default
store.tripApi(rest);                  // "/api/trips/<id>" + rest: the address of anything this trip holds
store.signInAddress();                // "/login?next=<this trip and section>"
store.on("gone", fn);                 // the server said the trip is deleted or no longer this person's
```

### Which trip a page is

- **A trip's page is `/t/<id>/`**, and the one app document is served at every such address. The
  id is read once, from the address, by `public/js/trip-here.js` (`tripIdFromPath`); going to
  another trip is a full page load. The app's own address `/` names no trip: it only sends the
  person on, to the trip this phone opened last, else to Your trips (`/trips`).
- **Everything a trip holds is asked for under `/api/trips/<id>/…`** (`store.tripApi`, never a
  string typed out in a module). `/api/me` and `/api/fx` belong to no trip.
- **One database per trip on the phone:** `wegoplace:<id>` (the snapshot and the queue of unsent
  changes) and `wegoplace-memories:<id>` (what the feed last showed), opened as
  `indexedDB.open(dbName(<BASE>, <trip>))`. The bare names are the databases a phone had before a
  trip had an address; `public/js/trip-adopt.js` moves what they hold into the trip's own the
  first time that trip opens, and leaves them empty. `forget.js`'s table marks both `perTrip`.
- **The phone's list of trips** is localStorage `wgp.kept`: `{ v: 1, who, last, trips: { <id>:
  { name, at } } }`. It is how `/` knows where to go and how signing out finds every trip's
  database. A list written for another account is never read, and that account signing in
  clears the phone before a row is shown.
- **A choice the phone remembers about one trip** (where the map was left, the open packing list,
  folded sections, Split's currencies) is stored as `<key>@<trip id>`, through `here(KEY)` in
  the module that owns it; the keys are listed in `TRIP_KEYS` (trip-here.js) and
  `scripts/forget_check.mjs` fails when the two disagree. Everything else under `wgp.` is the
  phone's or the person's, the same on every trip.
- **A trip that is gone** (the server's `404 {"error":"no such trip"}` to a signed-in account):
  `store` emits `gone`, the shell loads `public/js/trip-gone.js`, and that trip's rows, unsent
  changes, feed, kept pictures and remembered choices leave the phone before it goes to
  `/trips?gone=1`. Nothing of any other trip is touched.

### A phone that had the app before

A phone that had the app before a trip had an address (service worker v54 and older) comes
back with that worker still in control, one trip in one database, and maybe changes it never
sent. These are the rules the app holds there.

- **The one load on the old worker's scripts runs none of the app.** The old worker fetches a
  page from the network and serves scripts from its own cache, so the first load after the
  change is THIS page with the OLD `store.js`. Run like that, the old store sent the phone's
  unsent changes to addresses that are gone, was refused, and dropped them. So `index.html`
  asks the worker in control which build it is (`app/version`) before it imports anything, and
  for one from before v60 says "Updating the app…", waits for the new worker and loads again.
  The app's modules are `import()`, never `import` statements, for that reason: a statement
  runs before the first line of the script. A new shell module goes in the `Promise.all` there.
- **Every page has that first script, from one text.** `public/js/fresh-app.js` is the script;
  `index.html` carries the same text inline, word for word (`old_queue_check.mjs` holds them
  equal), because a file can fail to arrive and the app must not start with nothing asked.
  Every other page loads the file as a classic script and starts its module with
  `freshApp(() => import("/js/<module>.js"))`, never with a module script that has a `src`:
  under the old worker the sign-in page ran the old `auth.js` and no button on it worked. On
  a page with no `#view` the script says "Updating the app…" over the whole page. The old
  worker never had a file of that name, so it fetches it from the network.
- **Only a worker's own answer is remembered.** `wgp.shell` is set when the worker in control
  has answered as v60 or later, never on a load nobody controlled: a reload that skips the
  worker says nothing about the old one still registered behind it, which controls the next
  load (the walk's `--first hard`).
- **No road runs this app on that worker's scripts.** There is no "start anyway". While the
  page says "Updating the app…" it looks every 5 s:
  - no connection (a request to `/api/me`, which the old worker passes straight to the
    network, fails): the page loads again, and the old worker, which can't reach the network
    either, serves the page it kept: the OLD app, whole, as it always opened with no signal;
  - a connection and the new worker still downloading its shell: it keeps waiting, up to 90 s
    (the old worker is the only thing that opens the trip with no signal until the new one is
    in, so it is not given up while there is hope);
  - a connection and no new worker on its way after 20 s (its install failed), or still
    downloading after 90 s: every worker is unregistered and the page loads again with
    nothing in control, all from the network. Until a worker installs, that phone opens only
    with signal.
  "Still updating the app … Try again" is only for a load that came back to this page with
  still no connection (a worker that kept this page after all).
- **Until the new worker is installed, a phone with no signal opens the old app whole.** The
  old worker keeps any page that arrives carrying the exact text `data-app="wegoplace"` as
  its own page for that address, and serves its old scripts beside it. So `index.html` says
  `data-app="wegoplace-app"`, which the old worker doesn't recognize, and `sw.js` matches the
  marker as a prefix. NOTHING THE NEW SITE SENDS MAY REPLACE WHAT THE OLD WORKER KEEPS, AND
  IT MAY KEEP NO PAGE OF THE NEW SITE'S: the walk compares the old shell byte for byte at
  every look until the new worker has cleared it. A new page must not carry the old text.
- **The server keeps what the old app itself would lose** (the other half, `src/old-writes.js`):
  a write to an address the old app used answers 503, which the old store keeps the change on.
  That is the only protection on the road the page can't close: the old worker waits 3.5 s for
  a page and then serves the one it kept, so on a slow connection the whole OLD app runs, with
  signal, against the new server, until the new worker takes over and the old page reloads.
- **Nothing unsent is emptied unread.** `trip-adopt.js` moves the old database's rows and queue
  into the trip's own, each waiting change marked `from: "v54"`; a change that turns up in the
  old database after the move joins the trip's queue on the next load; the old packing
  screen's separate queue (database `wegoplace-pack`) comes as the meta record `old-pack`.
- **Nothing marked is sent as it was written.** After the first snapshot from the server,
  `store.js` hands them to `old-queue.js` (`translateOld`, pure, `scripts/old_queue_check.mjs`)
  and replaces them in one transaction; `flush()` waits for that. The translation:
  - a plan, a note, a purchase, the person's own settings: as written (the server takes the
    old app's ids, `ev_…`);
  - a new packing thing: without `done` and `section`;
  - `done` on a thing: one tick (or the tick taken off) on every list the thing sits on that
    is packed once, with no day: what the server's own move of the old rows did with the flag;
  - from the old packing screen, what ADDS is carried: a new list (packed once, with the bags
    the same queue gives it), a new bag, a thing put in a bag or taken off a list;
  - what would change a list or a bag for everyone is NOT carried: it was made on what was
    then the person's own copy. A rename and a removal are said; a new order is not.
- **Which list or bag an old id means**: by name; else by what sits in it; else by being the
  only one left over. The old app saved its lists with its unsent changes already applied, so
  a renamed one is known there only by the new name and a removed one not at all. When two
  could be it, the sentence is said without a name. Never the wrong name.
- **A carried change the trip then refuses is said the same way.** The person made it weeks
  ago, against the trip as it was then (a purchase that has since changed hands, a plan since
  removed), so they are not watching for it. Every change `translateOldNow` writes carries
  `carried: { label }`, the name the trip has for the thing now (from the snapshot as the
  server sent it: in the cache a removed thing is already gone). `flush()` puts any 4xx on
  such a change into `old-told` as `{ case: "refused", kind, op, label, status }` and not
  into the passing "reject" message. A removal answered 404 says nothing: the thing is gone.
- **What was not carried is said until it is tapped.** One message (`toastHold` in `toast.js`),
  three lines at most (`oldLines`), kept in the trip's meta (`old-told`) across reloads until
  the person taps OK. Five seconds is not "said" for something that is said once.

### Where the keyboard's focus starts

A sheet's first focus is given by `keeperIn` in `public/js/sheet.js`: the first control that
does not destroy. A control that destroys says so in its markup (`.btn-danger`, or
`data-destroys` on anything drawn another way), and an ask drawn in place calls `focusKeeper`
on the row it drew. `scripts/first_focus_check.mjs` holds every sheet to it and knows each
sheet by the file that opens it: a new sheet is added to its table.

## Plans by hand

A plan (an event) is added, changed and removed in one sheet, `public/js/plan-editor.js`:
`openPlanEditor({ day })` for a new one, `openPlanEditor({ eventId, onRemoved })` for one that
exists. The Agenda offers the ways in (the empty Agenda's "Add a plan", the + button, "Change"
on a plan's page). The rules are `public/js/plan-form.js`, which has no DOM:

- `readPlan(form, { zone, endZone })` turns the form's values into an event's fields, or names
  the field and the sentence to show under it. The start is read in `zone` and the end in
  `endZone`: the TRIP's zone unless the person said otherwise, never the phone's. No start
  time is an all-day plan. With no end day chosen, the end is the first time its own zone's
  clock reads the end time after the start: the start's day or the next in one zone, and
  across zones possibly the day before (Tokyo 10:00 to Honolulu 22:00 lands the evening
  before). `workedEndDay()` is that day, for the sheet to show. `end_tz` is written only when
  there is an end and its zone is not the start's.
- `formOf(event)` is the other way, and `changesOf(event, next)` is what a change writes: only
  the fields that differ, so a field the form does not show (`source`) is never touched. The
  end's zone is compared as what it means (`end_tz || tz`), never as it is spelled.

Zones in the sheet: a Flight or a Transit offers "Leaves from another time zone" and "Arrives
in another time zone", each closed (the trip's zone) until opened; open, it is the
find-by-town control the trips pages use (`zone-picker.js`, `/css/zone-picker.css`; "A town
says where a trip is", below) with a way back to the trip's zone. A plan that already has a zone of its own opens with it showing,
whatever its kind. An opened side left without a zone is refused in a sentence under it.
With a zone of its own, the line under the times says each time on its own zone's clock:
"Leaves at 18:00, New York time. Arrives the next day, Sun 8 Nov, at 06:05 Lisbon time."

The sheet never shows one thing and saves another: when the end falls on another day than the
start's and no end day was picked, "Ends on" itself shows that day (and lets it go when it
stops doing so); a day the person picked is theirs and is left alone. A sentence under a field
goes when that field is changed.

The writes are the store's (`addEvent`, `updateEvent`, `deleteEvent`): optimistic and queued,
so a plan made with no signal waits on the phone like a purchase. A trip with no dates takes
no plans, so the sheet asks for the dates first and sets them with `store.setTripDates()`,
the one write here that is NOT queued (it needs signal, and says so).

Any member changes or removes any plan, wherever it came from (docs/API.md, the permission
rules). The store has no author rule for events.

## A place by hand

A place is added, changed and removed in one sheet, `public/js/place-editor.js`:
`openPlaceEditor({ name, kind, onSaved })` for a new one, `openPlaceEditor({ placeId,
onRemoved })` for one that exists. The ways in: the empty Places' "Add a place", the + button
on Places, "Change" on a place's page, and a plan's Where (a name no place has is offered as
a new place, and the saved place becomes the plan's). The rules are `public/js/place-form.js`,
which has no DOM:

- `readPlace(form, { areas })` turns the form's values into a place's fields, or names the
  field and the sentence to show under it. A place needs a name and a kind: no kind is
  pressed for it, because a default would file every unchosen place as that kind. A pin
  must lie inside the place's area (or the area's parent) when either has bounds, the
  server's own rule, said before it is sent.
- `placeChanges(place, next)` is what a change writes: only the fields that differ; a pin
  taken off goes as `lat: null, lng: null`.
- `readMapLink(text)` reads a location from a link's or an address's OWN text (Google, Apple,
  OpenStreetmap, Bing, `geo:`, a bare pair). Nothing is fetched: a short link says nothing,
  and the sheet says so.
- `nearWords`, `inUseWords`, `placeRefusalWords`: the sentences for a new place a few meters
  from another of its kind, a place that can't be removed yet, and a write the server turned
  down after the fact.

A place with no pin is a whole place: its row says "not on the map" and its page "Not on the
map: go by the address." in a quiet line (the warning banner is for details a tool could not
confirm).

"Put it on the map" is `public/js/spot-picker.js`: `canPickSpot(store)` (the trip has a map)
and `pickSpot({ store, lat, lng, area, name })`, a sheet over the place sheet with the trip's
map under a fixed pin. The map is the app's one live map, lent by `map.js mountPicker()` and
given back to the host that had it, where it was. The spot is the middle of the map; arrow
keys and + / − move it for whoever has no finger on it.

The writes are the store's (`addPlace(id, fields)`, `updatePlace(id, changes)`,
`deletePlace(id)`, with `placeUses(id)` for what still points at a place): optimistic and
queued under the kind `place`, each sent as a list of one through `PUT …/places` (a removal
through `DELETE …/places/:id`). The id is made on the phone: the name as a slug and six random
characters. The server's nearness warning arrives as the store's `place-near` event; the shell
says it.

Any member adds, changes or removes any place (docs/API.md).

## Settling up: a payment

A **payment** is one person giving another money to settle what is owed. It is a purchase row
with `kind: "payment"` (the server's `docs/API.md`, "Settling up"): ONE share, the person who
received it, for the whole amount; no description, no day, no event, no place. It rides the
same queue as a purchase, so it works with no signal.

- **money.js** `netBalances()` moves the two nets by a payment and nothing else. `total`,
  `paid` and `owed` mean purchases only (a payment is not spending); `back` and `got` are what
  each person paid back and got back, so `net = paid - owed + back - got` for everyone.
  `isPayment(row)` is the one test. `scripts/split_math_check.mjs` part 2b holds this, and its
  20,000 trips record every suggested transfer as a payment and find everyone even.
- **store.js** `addPayment({ from, to, amount_minor, currency, amount_exp })` and
  `updatePayment(id, { from?, to?, amount_minor?, currency?, amount_exp? })`. A payment's amount
  and its one share always travel together. `canEditPurchase(row)` is true for whoever wrote a
  payment down, paid it **or received it** (the server's `mayTouchPurchase()` says the same).
  `deletePurchase(id)` deletes either kind. The kind is fixed when the row is made.
- **split.js** A payment's sheet is the purchase drawer with `D.kind === "payment"`: the
  amount, From (one person), To (one other; never the person it is from; choosing the receiver
  as the payer swaps the two). `openDrawer(null, { payment: true, from, to, amount_minor,
  currency, back: "settle" })` opens it filled in. On the settle sheet a transfer is a button
  (`.sp-tr[data-act="mark-paid"]`) that opens it and records nothing by itself; payments made
  are listed under the transfers (`.sp-tr[data-act="payment"]`), and the sheet ends in "Record
  a payment". Opened from the settle sheet, the payment's sheet REPLACES it and the settle sheet
  comes back when it closes. In the feed a payment is `.sp-row[data-kind="payment"]`: "Ben paid
  Ada", an arrow, the receiver's square and the word "Payment".
- A payment made from a combined (converted) transfer is recorded at face value in the display
  currency. If the rate moves later, "Combined" shows a small balance again and "By currency"
  stays exact.

`scripts/settle_check.mjs` holds all of it in three browsers.

## Pack for today

A packing list "for the day" (`repeat: "daily"`, on its `dates` or, with none, every day of the trip) is
packed where the day is read. The packing guide tells every AI the app shows it "at the top of that day in
the itinerary as "Pack for today"", and agenda.js does: `packsFor(day)` gives each list for the day that is
packed on that day, with the reader's own things and the group's in a bag of it (someone else's are theirs).
On the trip's today (`store.packDay(key)`: the TRIP's day, open) the band is the list, each row ticked with
`store.tickPacking`, the same write as Pack's, queued with no signal like any tick. On the list's other days
it is one line ("Pack for the day": what was packed on a day gone, how many things on a day to come) and the
way to the list, `#/pack?list=<key>`, which packing.js opens on your own things. A day that is none of the
list's, or a list that carries nothing of yours or the group's, shows nothing. `packSlice()` is in the
agenda's `dataSlice()`: a tick, a bag or a list changing repaints the day. Held by
`scripts/pack_today_check.mjs`.

## Areas, and the trip's own map

A trip's areas are rows (`store.areas()`; docs/API.md, Areas): a top-level area is a region,
a child is a neighborhood under it. `public/js/areas.js` reads them, with no store and no
DOM, and it is the ONLY place that words where a place is or decides what a region is:

- Places and the map both call `readAreas(rows)` and use its `label(areaId)` ("Alfama,
  Lisbon"; a region alone; nothing when the place has no area; the id as words when its row
  is gone) and its `regions` (the top-level areas; the ones with bounds are the plates the
  map names and shades).
- No module holds a table of one trip's areas, regions, coordinates or codes. A trip with no
  areas has no plates and no area words; its map fits its places, or shows the whole planet.
- A box whose west is greater than its east crosses the 180° line; `nearLng()` and `widthOf()`
  are how anything measures or draws across it.

THE MARKS ON THE MAP NEVER STAND ON EACH OTHER. Places near each other are one disc with
their count (`map.js buildGroups()`: a grouping radius that tightens with the zoom). A disc is
wider than that radius, so a second pass, `settle()`, takes into a disc whatever its box would
reach, a disc or a pin, until nothing touches (`MARK_GAP_PX` of ground between them). Two pins
are left to the radius alone. The selected pin and an open fan are never taken in: they are
drawn above what is under them. `groupCountAt()` (would zooming split this disc?) runs the
same second pass. A plate's name (the flat ground's) is written at the first of eight spots
around the plate's corners that no mark stands on (`nameSpot()`), and a pin's label keeps off
it. Held on the made-up trip at four zooms and two widths: `scripts/map_discs_check.mjs`.

The offline map is the TRIP's. `store.tiles()` is the snapshot's `tiles` (docs/API.md: `state`
none / cutting / ready / failed, `version`, `bytes`, `source`, `note`, `glyphs`, `ready`), and
`map-keep.js mapStateOf()` is the one place that reads it (`map.js mapState()` calls it).

THE MAP IS KEPT WITHOUT THE MAP BEING OPENED. Everything a trip needs with no signal is on the
phone after its first open with signal, and there is no button for it. `map-keep.js keepMap()`
is the one keep: the shell calls it (index.html, after `start()`, in idle time, once this visit
has heard from the server), and the map screen calls it when its first view has settled and
when a person answers its note. A call for a map already on its way joins that call. It
keeps the archive, then the glyph ranges the map lists (`tiles.glyphs`; a map that lists none
gets `LATIN`, 0-255 and 256-511) for every font the style names (`fontStacks(styleLayers())`:
named outright, by a rule, or for a script inside a name), each stored by the page itself in
the worker's cache of map furniture (`wegoplace-tiles-v1`) under the address the worker looks
it up by, so a first visit the worker doesn't control yet keeps them too. A range already
there is not asked for again.

- Kept without asking: a map within the budget (`MAX_STASH_BYTES`, 48 MB; a cut is, by
  construction). Asks first, in the map's note: a map over the budget, and any map while the
  browser is set to save data. Not kept, and said in words: a phone short of room (less than
  twice the map free), where the trip is kept and the map is not; nothing ever removes another
  trip's map to make room.
- What a person reads: `KEEPING_WORDS` as one passing line when a map starts coming down, once
  for each map; `roomWords()` once in passing and in the map's note until OK. Which map each
  was said for is in `wgp.map.said` (`told`, `roomTold`, `room`, beside `keep`, `skip`, `note`).
- `map.js buildStyle()` draws with `styleLayers()`, so the fonts kept are the fonts drawn.
- A known edge: an UPLOADED map lists no glyph ranges, so only Latin is kept for it. A name in
  another script on it, never drawn with signal, is drawn with no signal in the phone's own
  font (MapLibre's fallback): the name shows, not in the map's font. A cut lists what it uses.
- Held end to end on a real cut, with real fonts and the worker on: `scripts/map_keep_real.mjs`.

- The archive is asked for at the trip's own address with its version,
  `/api/trips/<id>/tiles?v=<version>`, and the phone's copy lives in the cache `wgp-tiles-v1`
  under the address WITHOUT the version, marked with the version it is (`X-Map-Version`). A
  copy is kept again when `version` changes, never on a timer and never by asking the server
  what it has. A kept copy with no mark (from before versions) counts as current when it is
  the same size to the byte.
- A map that isn't ready draws the map's own ground (areas as plates, the scale, the planet's
  lines on a trip with nothing in it) and asks for no archive at all.
- The map says one thing about itself at a time, in one card (`.mp-note`): the map is being
  made; it could not be made (the server's `note`, with OK; the trip's host also has "Try again",
  which is `POST …/tiles/cut`, and what the server answers is said under the sentence in its
  own words; anybody else reads who hosts the trip and can ask; no "Try again" while an
  uploaded map is in use, because a cut asked for by hand replaces it); a ready map's note; the question
  whether to keep it on this phone (an uploaded map over 48 MB, or a browser set to save
  data); and that the phone is short of room for it (with OK). What a person
  answered or put away is remembered per trip in `wgp.map.said` (a trip's key: `trip-here.js`
  lists it).
- A phone from before trips had addresses keeps its old archive as that trip's
  (`adoptOldArchive`). Signing out leaves trips' maps on the phone; a trip that is gone takes
  its own with it (`forget.js forgetTrip`, which shares the cache's name and the address with
  `map.js`; `forget_check` holds the two together).

The map's box, for anyone who changes it: the root reaches out of its host onto the whole of
`#view`, with offsets taken from the HOST's and `#view`'s rects (`fitShell`). Never measure
something straight after writing its style while it can carry a transition: the rect that
comes back is the old one. Under "reduce motion" `styles.css` gives transitions no length at
all (0s, so none starts; while it was 0.01 ms every write on every element lagged its read).
The root and Places' map host take no transitions under any setting, for that reason. A fit is a center plus an offset, on
both engines (MapLibre's `jumpTo` takes no offset; the GL view's `jumpTo` goes through an ease
of no length). `map_trip_check` 1b holds the box and the first fit, with motion reduced and
allowed.

## A town says where a trip is

A trip made by hand gets its map because the form asks where it is. One control finds a place
by typing its town (`public/js/zone-picker.js` over `public/js/city-search.js`), and it is the
only one: Make a trip's "Where", the trip's page ("Where it goes", Add a city), and every field
that takes a time zone (Make a trip's zone behind "Change", the trip's details, a flight's two
zones). What must stay true:

- **One answer, two things.** A town picked in "Where" is the trip's zone (changeable right
  there, said as "Tokyo time, GMT+9") AND its first area: `areaOf(row)` makes
  `{ id, name, west, south, east, north }` and the form writes it with the trip (`POST
  /api/trips`, then `PUT …/areas`), so the server starts the map by itself. A country gives a
  zone and no area, and the form says a town is still wanted.
- **The zone database's region word shows nowhere.** A zone is said as a place and an offset:
  "Lima, Peru · GMT-5", never "Lima · America". The offset is the one on the trip's first day
  (or the plan's day), so Lisbon is GMT+1 in April.
- **The towns' table is static files** (`public/towns/`: GeoNames, CC BY 4.0, towns of 500
  people and more, names in Latin letters; `scripts/make_towns.mjs` makes it and says at its
  top why nobody runs it casually). It is cut by the first letters typed, so a lookup fetches
  the index (18 KB, which comes with the app) and ONE file of at most 48 KB; nothing is asked of
  any other server, and nothing is fetched until a field is used. `city-search.js` is pure: the
  generator imports its `fold`, `squash` and file naming, so the files and the lookup can't
  disagree. Its date is on the Credits page, read from the index.
- **Names.** Accents, capitals, spaces and punctuation don't count. A town found by another of
  its names is shown by the name that was typed ("Machu Picchu", "Kioto"), unless that would
  read exactly like another row. Two of one name are told apart by region and country. Bigger
  towns first; a country before a small town of its name.
- **The box** is a square around the town's point: 12 km to each side up to 100,000 people,
  growing to 20 km at a million, no further (`boxFor`).
- **What no list of towns has** (an island, a coast, a park): under every list of "Where" stands
  the offer of a map link, alone with a sentence when nothing is found, and in sight under a
  list long enough to scroll. The link is read by place-form.js's reader (no request); the area
  is a box around that spot with the name that was typed, and the zone is the one the towns
  near it keep (`near.txt`).
- **With no signal** the field finds time zones (the browser's own list) and the towns whose
  files the phone has, and says so in the list.
- **The files a phone has say what somebody typed.** The worker keeps them in a cache of their
  own (`wegoplace-towns-v1`), and forget.js clears it with a person's things on sign-out and
  for another account.
- **Where it goes** (`trip-people.js`): the trip's top-level areas, Add a city (towns only: the
  trip has its zone), Remove (asked twice; the server's refusal, in its words, when a place
  points at it). Before a town is added the page asks the server what the map would be
  (`POST …/tiles/plan`, which changes nothing) and says, in a sentence, what it costs the towns
  already there (`planWords`: never a zoom number). No answer says nothing and holds nothing up.
- **The Map of a trip with no area** says "Say where this trip is and its map gets made." with
  a link to the trip's page at `#where` (map.js, the note of kind "where"). Not on a site that
  makes no maps (`store.mapsMade()` is false: the snapshot's `maps`), where it would promise
  what can't come.

`scripts/towns_check.mjs` (node, on the gate) reads the whole table and holds the names;
`scripts/where_check.mjs` holds the screens and what the server is sent.

## Permission rule, stated once

- **edit / delete** an event: any member of the trip
- **edit / delete** a packing item: `created_by === session.user.id`
- **add a note**: any authenticated trip member, on any event
- **edit / delete a purchase**: `created_by === me.id` **or** `paid_by === me.id` — the author
  or the payer, nobody else including admins. Not the events rule, because if Ada logs
  "Teo paid 120 for the taxi" and gets it wrong, it is Teo's money to fix. Not the
  packing group rule, because a ledger any member can silently rewrite is one nobody trusts
  and there is no soft delete to appeal to. Like the packing rule it lives in **three files
  that must move together**: `store.js canEditPurchase()`,
  `functions/api/purchases.js mayTouchPurchase()`, and the split view's own `canEdit()`.
- The API enforces this. The UI mirrors it by hiding controls, but the API is the authority.

## Time

Every event carries its own IANA `tz`. Render in `event.tz`, never in the device zone.
`util.js` exports:

```js
fmtTime(epoch, tz)        // "23:15"
fmtDay(epoch, tz)         // "Fri Aug 28"
tzLabel(epoch, tz)        // "EDT" — render only when tz !== trip.default_tz
dayKey(epoch, tz)         // "2026-08-28", the agenda's grouping key
```

A departure from home can be in `America/New_York` while everything else on the trip is in
a zone an hour west. A naive device-local render shows 22:15 for a 23:15 flight. This is the one bug that would actually
make someone miss a plane.

### end_tz — added after the real confirmations arrived

A flight **lands in a different zone than it departs**. `events.end_tz` (migration 0002,
nullable) holds the arrival zone; it is NULL for anything that stays put.

```js
fmtTime(e.starts_at, e.tz)              // departure
fmtTime(e.ends_at,   e.end_tz || e.tz)  // arrival  <- ALWAYS use the fallback
```

Render arrival with `e.tz` and a flight home reads "lands 19:35" when the ticket says 20:35 EDT.
An international leg can cross a zone; a domestic leg often does not.

Show the tz label on any event where `tz !== trip.default_tz` **or** `end_tz !== tz` — those
are exactly the events where a bare clock time is ambiguous.

## CSS

Tokens live on `:root` in `styles.css`, with the three-state theme pattern (bare `:root`
light, `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`, and
`:root[data-theme="dark"]`). Never declare a colour only inside a media or `[data-theme]`
block.

Mobile only. Design for 390x844. No desktop breakpoints — nobody is bringing a laptop.
Safe-area insets matter: this runs as an installed PWA with no browser chrome.

```
--ground --surface --surface-2 --bar --line --line-strong --ink --ink-2 --ink-3
--accent --accent-ink --accent-soft
--warn --warn-soft --ok --ok-soft
--press --scrim --shadow --shadow-lift
--kind-{flight,transit,meal,lodging,activity,plan} and each -soft pair
--on-shot --on-shot-veil --on-shot-halo
--r-sm --r-md --r-lg   --sp-1..--sp-6   --tap --bar-h   --font-ui --font-display
```

**Event/place kind colour is a token, not a module's invention.** `--kind-*` is the ink and
`--kind-*-soft` the wash for the six kinds an event can be. Tinting a dinner out of `--warn`
says "warning" about dinner. `places.js` maps its seven place kinds onto these six
(`practical`→`plan`, `food`/`drink`→`meal`, `sight`→`activity`, …) so a place and its event
carry the same hue. **Colour is never the only signal** — every kind also has its own glyph,
which is what makes food and drink sharing a hue safe. The app is used on daltonized displays;
this is a rule, not a preference.

`--on-shot` (and its veil) is type set *over a photograph*. It is declared in bare `:root`
only, and deliberately not re-declared per theme: what sits behind it is a picture, not a
surface, so flipping it with the theme could only be wrong half the time. That is the one
intended exception to "declare every colour in bare `:root` and override per theme" — the
declaration is still in bare `:root`, there is simply nothing to override.

Component classes are prefixed by owner: `.ag-*` agenda, `.pl-*` places, `.pk-*` packing,
`.mp-*` map. No bare element selectors outside `styles.css`.

## Module interface

Each view module default-exports a mount function:

```js
export default function mount(el, ctx) { /* ... */ return () => {/* cleanup */}; }
```

`ctx = { store, router, params }`. Return an unmount function. The router calls it on
navigation.

**A message that comes and goes is `toast(msg)` from `public/js/toast.js`, and nothing else.**
One node (the shell's `#toast`), one pair of timers, five seconds. A screen imports the
function; it never makes a node like it, reaches for `#toast`, names the `toast-in` class or
keeps a timer on it. Five copies of this once hid each other's messages: a refusal that
arrived while the last message faded was never seen. `scripts/toast_check.mjs` fails on a
sixth.

## Routes

```
#/                  agenda (default)          tab root, tab "agenda"
#/e/:id             event detail               tab "agenda"
#/e/:id?gap=1       the GAP BEFORE that event  tab "agenda" — same mount, agenda swaps its face
#/places            places list + filter       tab root, tab "places"
#/places?near=<id>  places sorted from <id>    tab "places" — reachable only from a place page
#/p/:id             place detail               tab "places"
#/map               map view                   tab "places", NOT a tab root
#/pack              packing                    tab root, tab "pack"
#/settings          settings                   tab root, tab "settings"
#/settings/credits  image credits              tab "settings"
```

`ctx.route` is one of `agenda | event | places | place | map | pack | settings | credits`.
A query string is NOT part of the route: `parse()` strips it, so `#/e/x` -> `#/e/x?gap=1`
fires `onNavigate` without remounting, and the view swaps its own face. `onNavigate(fn)`
receives `(route, router)` and **fires twice per navigation** (before and after mount),
because `canGoBack()` cannot answer for a screen that is not current yet — make listeners
idempotent. Any code calling `history.pushState`/`replaceState` directly must preserve
`history.state.wgp` or the back button skips a page; use `router.go()` / `router.replace()`.

## Language

**All UI copy is English, and a trip's content is in its travellers' language.**

The one exception is `place.name_local` and the `address` field, which stay in the place's own
language on purpose — those exist to be *shown to someone local*, read off a sign, or spoken to a taxi
driver. Everything the traveller reads for comprehension (`why`, `notes`, `hours`, all UI
chrome) is English.

Where a source document is Spanish — an Airbnb host's check-in instructions, a booking
confirmation — translate it into `detail`/`notes` rather than pasting the original. Untranslated
Spanish in a field meant to be read is a bug.

## Address ambiguity is a real failure mode

One city can have an **avenue** in one district (where the stay is) and a **street of the same
name** in another (where the restaurant is), 2.2 km apart. A taxi given only the street's name
gets it right half the time.

So: the district is part of the address, never an optional suffix. Place detail must render
the district prominently, and any address shown for the purpose of being read aloud includes
it. This generalises — many cities reuse street names across districts constantly.

---

# Appendix: resolved at integration

Everything above is what the modules were written against and still holds. These three
points were ambiguous or under-specified, were resolved once during integration, and are now
true in every file that touches them. Nothing here is a licence to reopen the rules above.

**1. Packing is scoped by OWNER, not by author.** The permission rule reads
`created_by === session.user.id` for "an event or packing item". Applied literally to the
group list it makes the shared list read-only for three of the four people packing the
duffel — whoever ticks "4-person tent" is almost never whoever typed it. Resolved:

- *ticking* (any field) a row whose `owner === 'group'` is open to every member
- *renaming and deleting* a row still belongs to its author, so nobody's line vanishes
- private lists are unchanged; nobody else can create a row you own
- events have no author rule any more: any member changes any plan (see Plans by hand)

Enforced in three places that must move together: `store.js` (`packMine`, used by
`tickPacking()` and `placePacking()`; `setPacking()`), the server's `mayTouch()` in
`src/api/packing.js`, and `public/js/packing.js canTick()`. Moving a group item is as open
as ticking it.

**2. `GET /api/trip` returns the whole snapshot**, `{ trip, members, places, events, packing,
notes }`, not just the trip row. That is what `store.js` was written against and it is the
offline requirement in one line: there is exactly one request that has to have succeeded
before the signal goes.

**2b. `ctx` carries a fourth key, `ctx.route`** — `"agenda" | "event" | "places" | "place" |
"pack" | "map"`. Six routes, four view modules: `#/e/:id` mounts `agenda.js` and `#/p/:id`
mounts `places.js`, so a module has to be told which face to render rather than inferring it
from the presence of `params.id`. `mount(el, ctx)` may be async; the router awaits it.

**3. The client cannot seed itself.** A trip's seed (a JSON export like `seed/demo-trip.json`) sits outside
`pages_build_output_dir`, so the browser cannot fetch it, and `/api/trip/import` is
admin-only. Seeding is a deploy step run with curl — see the first-deploy checklist in
`README.md`. `store.js` treats a `404` from `/api/trip` as "leave the cache alone".

---

# Appendix: images are self-hosted

Appended by the localise role. Nothing above is amended.

The first seed shipped with `image_url` pointing at `upload.wikimedia.org`. It no
longer does, and it must not again. `scripts/fetch_images.py` downloads each licensed source
once at build time, re-encodes it to WebP at phone sizes, writes it into `public/img/`, and
rewrites the seed to point at the local copy.

```
image_url    "/img/<place id>-card.webp"    ~640px wide   list / agenda card
image_hero   "/img/<place id>-hero.webp"    ~800px wide   place detail
```

**No module fetches an image from a remote host.** Four days of this trip have no signal, and
a remote URL is a blank card exactly when the app is the only thing anybody has. It is also
what Wikimedia asks people not to do. A remote `image_url` reappearing in the seed is a
regression, not a shortcut.

**`image_credit`, `image_license` and `image_source` survive re-hosting untouched.** Copying
a file to our own origin does not dissolve the attribution obligation — these are CC BY /
CC BY-SA works and the app is deployed on a public domain. The fetch script never writes
those three fields, only reads them. `migrations/0003_images.sql` already says an `image_url`
with no `image_license` is a bug; that stays true after the URL becomes local, and the script
skips and reports any such row rather than silently downloading it. **A place that renders an
image and no credit is a licence violation, not a styling choice.**

**The hero path is derivable.** It is always the card path with `-card.webp` replaced by
`-hero.webp`, so a module holding only `image_url` can compute the hero without a schema
change. That matters because `image_hero` is *not* a column: `migrations/0003_images.sql`
predates it and `functions/api/trip.js` imports a fixed column list, so the seed's
`image_hero` is dropped at import until the api role adds it.

**`public/img/CREDITS.json`** is the machine-readable record, one entry per image: credit,
licence, canonical source page, encoded byte sizes, and the original URL it came from. It has
three jobs — it is the attribution record that ships next to the files, it is what makes the
fetch re-runnable once the seed's remote URLs are gone, and it is a ready-made precache list.
That last one is load-bearing: image files are referenced only from row data, never from a
JS module, so `sw.js`'s `crawlAssets()` cannot discover them by scanning source. `sw.js`
`syncImages()` reads this file instead and precaches every entry into its own `IMAGES` cache,
verifying each body against the recorded byte length — so the manifest is not documentation of
the precache, it *is* the precache list. Cards land first and unconditionally; the hero tier is
skipped only when free storage is short. Verified end to end: 92 files, 8,361,018 bytes, and
the agenda and place detail both render offline with no network at all.

**Total encoded weight is capped.** `--budget-mb` (default 8) is a hard ceiling, not advice;
the script walks a calibrated ladder — hero pixels first, card size last — until the set fits,
and records the rung it landed on in `CREDITS.json`. The whole set is precached onto a phone
over hotel wifi before the trailhead, so weight is a correctness property here, not a
nice-to-have.

---

# Appendix: resolved at v2 integration

Appended by the integrator after the six v2 roles landed. Nothing above is amended except the
file-ownership table, the `store.js` block and the route table, which were stale.

**1. `store.js` is v2 now.** It was the one shell file no role rewrote, and three modules were
compiled against an API it did not have.

- `store.addNote(eventId, body, { anchor_kind })` — the third argument reaches
  `POST /api/notes` under that exact key. Before this fix a note written from the gap page
  was filed as an EVENT note, silently and permanently: notes are append-only, so it could
  not be moved afterwards. Verified in the browser — a note typed into the gap composer comes
  back from the API as `anchor_kind:"gap"`.
- `store.members()` — the roster, with `note_color` and `initials`. `applySnapshot` keeps
  `snap.members`, and it persists in `meta` so it survives offline. agenda.js feature-detected
  this and fell back; the fallback is no longer the only path.
- Notes carry `initials` and `note_color` on the optimistic row too, computed by an
  `initialsOf()` that is character-for-character the same rule as
  `functions/api/trip.js`. A sticky that changed its initials the moment it synced would be
  a sticky nobody trusts.
- `notes()` sorts through `toMs()`. `created_at` is SECONDS from the API and MILLISECONDS
  when stamped locally, so the raw comparison put every unflushed note at the end of the
  list regardless of when it was written.

**2. Packing's structure is in `store.js` (13 Nov 2026; the seam this point used to describe is
closed).** `packing.js` once carried `struct`, its own IndexedDB database, cache and write
queue for per-person views and sections. Lists and bags now belong to the trip, arrive in the
snapshot (`packing_lists`, `packing_placements`, `packing_ticks`, `packing_starters`) and are
written through the store's one queue under four kinds that own no row and are replayed by
effect, the way `me` is: `pack-tick`, `pack-place`, `pack-list`, `pack-bag`. A list or bag
write names only what it changes; the server leaves everything else as it is, so a phone
that was offline cannot remove a bag by not knowing about it. A refused write is dropped,
the next snapshot puts the screen back, and `public/js/packing-refusals.js` gives the shell
the sentence to show. The old database `wegoplace-pack` is opened by nothing; `forget.js`
still lists it as retired so a phone that has one is still cleared.
`scripts/pack_lists_check.mjs` holds all of this with two people in two browsers.

**3. `places.checkout` is imported and selected.** Migration 0005 added the column and the
seed fills it for two stays, but `PLACE_COLS` in `functions/api/trip.js` and `COLS`
in `functions/api/places.js` both predated it, so the import dropped it and the snapshot never
carried it. `places.js` renders a stay's checkout checklist and was rendering nothing.
**Any column added by a migration has to be added to BOTH lists or it does not exist to the app.**

**4. `POST /api/trip/import` now PRUNES.** It was upsert-only, so an event deleted from the
seed lived on in D1 forever (a dropped event came back on every import). It now deletes seed
events (`created_by='seed'`) that are absent from the payload, and REFUSES to delete one that
carries notes, reporting it in `kept_for_notes` instead. `event_notes.event_id` has no
`ON DELETE CASCADE` and a note is the one thing in this app nobody else authored.

**5. A remote `image_url` regressed into the seed and is now checked for.** 44 of the 46
photographs were pointing back at `upload.wikimedia.org`: `merge_trek.py` writes the original
URLs and `fetch_images.py` — the slow, network-bound pass that rewrites them — is not part of
`rebuild_seed.sh`. The rewrite is now split from the download: `scripts/localise_images.py`
re-points every `image_url` at the file `public/img/CREDITS.json` says is on disk, runs offline
in a second, is step 5 of `rebuild_seed.sh`, and the rebuild's post-conditions now include
`no remote image_url`. The old post-condition only COUNTED images, which is how this got through.

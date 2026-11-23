# WeGoPlace: working agreements

Offline-first trip planner for a group. One Cloudflare Worker (`src/`, with `public/` as its static assets), D1, R2 and
two Durable Objects (a trip's room, a trip's map); vanilla ES modules, **no build step**: what is in `public/` is what
ships.

## Never

- No in-app notices, banners, hints, toasts or "what's new" messages to people about internal or technical matters
  (updates, reinstalling, caches, versions) without the owner's explicit OK first: real people use the app.

## Run it

```sh
npm install
npx wrangler d1 migrations apply wegoplace --local      # a fresh local database
npm run dev                                              # wrangler dev on 8788 (npm run dev -- --port <n>)
node tools/seed-trip.mjs seed/demo-trip.json --base=http://localhost:8788 --session <a session cookie's value>
```

`wrangler.jsonc` carries placeholder ids for the database and the OAuth store: wrangler dev keeps its own local copies.
A deploy of your own needs its own (`wrangler d1 create`, `wrangler kv namespace create`).

## The checks

- **Node checks:** `npm run check:<name>` (`package.json` lists them). Each starts its own `wrangler dev` on a free
  port with its own database, unless given `--port`. Run them niced, one set at a time: a set starts dozens of servers.
- **Parity:** `npm run check:parity` answers every recorded request (`checks/parity/`) as the recording says. A change
  that moves an answer on purpose records again, twice identical, and says what moved (`checks/parity/README.md`).
- **The client's gate:** `node scripts/gate.mjs` starts a server on a free port with a database made from nothing (the
  migrations, then the made-up trip `seed/demo-trip.json` through the routes), runs every browser check in turn, and
  removes it all. `--only "a,b"`, `--affected <base>` (only what the branch's files can touch, plus a core set),
  `--list`, `--serve` (keep the server up to look at the app).
- **Browsers:** every check gets its browser from `scripts/lib/browser.mjs` (Chrome for Testing, pinned, walled off
  from every outside address). Nothing else may start or attach to a browser: `node scripts/test-browser-launcher.mjs`
  fails if a script can. Run it before landing any script.
- **Public tree:** `npm run check:open-source` fails on keys, cookies, real emails, account ids and marks in the tree.

## Verifying

- Never claim something works without having run it: the real flow in a real browser, not a typecheck and not a
  passing harness alone. Say exactly what was run. Re-run; don't trust a transcript's claim that it was green.
- A check must be able to fail: plant the fault it is for and watch it go red.
- Anything multi-person needs two browser contexts with two different people signed in. A single-context check cannot
  see a sync bug.
- Colour is never the only signal: every state has a second carrier (words, a glyph, weight, a shape).

## Checks and the rows they touch

- A check drives the made-up trip through `scripts/lib/gate_trip.mjs` (`TRIP`, `tripPath()`, `PEOPLE`, `signedIn()`):
  no check writes a trip's id, an account's id or a cookie in its own text.
- A check removes only rows it made, each by the id it recorded when it made it; never "the first", "the last" or "the
  newest". The gate reads every row of the trip before and after each check; a check that leaves the set different
  has failed whatever its own tally says.
- Never `DELETE FROM` a whole table for a clean state. To show an empty state, intercept the response with CDP
  (`Fetch.enable` + `Fetch.fulfillRequest`).
- Fixtures are baseline-aware: read what is there, assert the delta.
- A server is yours only by the pid you recorded or its port read from the whole command line. Never signal a process
  you didn't start, orphaned browsers included; fix the check that collides with them.
- When you finish, nothing you started is still alive: no node, no browser, no temp folder of yours.

## store.js: three that fail silently

- **`DB_VERSION` must be bumped whenever `ROWSTORES` grows.** An existing install never runs `onupgradeneeded`, the new
  store is never made, `hydrate()` throws `NotFoundError` (which `index.html` catches), and the app quietly stops
  persisting and syncing: the durable write queue is never read back.
- **`unwrap()` is the only place that knows the response envelope.** A route answering `{ purchase: {...} }` that
  `unwrap()` doesn't name returns null, and the server's row never replaces the optimistic one.
- **`storeOf()` defaults to `packing`.** An unmapped `kind` files its rows into the packing list instead of throwing.

Two more: the server stamps `created_at` in seconds and the client in milliseconds, so sort on `toMs()`; and the queue
folds payloads shallowly, so a patch touching a nested value (a shares array) carries the whole value, never a delta.

## Deploying (a copy of your own)

- **Migrations first:** `wrangler d1 migrations apply wegoplace --remote` before `wrangler deploy`. Code that reads a
  column the remote database doesn't have yet takes the site down.
- **A migration only adds** (nullable or defaulted columns, new tables): between the two steps the old code runs
  against the new schema. A migration's SQL never changes once it has run anywhere; only its comments may
  (`checks/migrations/frozen.mjs`).
- **A shell or artwork change bumps `VERSION` in `public/sw.js`.** Without it an installed phone never refetches. Find
  the line with `grep '^const VERSION'` (a comment above it also contains `VERSION = "v`). Every page's
  `<meta name="wgp-build">` and `src/build.js`'s `BUILD` (the MCP's serverInfo.version) move with it:
  `scripts/sw_version_check.mjs` holds all three equal.

## The artwork

`art/make_logo.py` draws the wordmark, the mark, the app icon and the favicon (Python 3 and `rsvg-convert`).
`python3 art/make_logo.py --site` rewrites `public/img/wordmark.svg`, `mark.svg`, `icon.svg`, `public/icons/` and
`public/favicon.ico`. Never hand-edit those: change the generator and run it, and bump `sw.js`'s VERSION.
`scripts/logo_check.mjs` fails on any served file the generator didn't draw.

## Files

Nothing loose in the repo root. Scratch output goes outside the tree; dated artefacts under `docs/`.

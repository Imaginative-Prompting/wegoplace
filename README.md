# WeGoPlace

A trip planner for a group travelling together, built for the phone in your pocket and for the days when that phone
has no signal at all: the plan, the places, the packing lists, who paid for what, the photos and a map, shared by
everyone on the trip and kept on each phone.

It installs to the home screen as a web app. It runs as one Cloudflare Worker with D1, R2 and two Durable Objects, and
it has no build step: what is in `public/` is what ships. MIT licensed (`LICENSE`).

## The one hard requirement: it works with no signal

There is no "save for offline" button anywhere, because a button is something everyone can forget to press. Everything
is kept on the phone from the first signed-in load:

- **`public/sw.js`** owns the *code*: it precaches the document, every module (the lazily imported views too), the
  stylesheets, the fonts and the icons, then crawls the cached modules for what they reference.
- **`public/js/store.js`** owns the *data*, in IndexedDB, with its own durable write queue. Reads are synchronous over
  an in-memory mirror: they never wait and never touch the network. Writes apply at once, queue, and go when the radio
  comes back.
- **`public/js/map.js`** owns the *tiles*: one `.pmtiles` archive per trip, kept in its own cache and read by range.

Nothing writes trip rows into Cache Storage and nothing writes code into IndexedDB: two copies of one thing under two
eviction policies is how a phone shows yesterday's meeting time with no way to tell.

## The other thing that will bite you: time zones

Every event carries its own IANA `tz`, and a flight carries `end_tz` for where it lands. Render in the event's zone,
never the device's:

```js
fmtTime(e.starts_at, e.tz)               // departure
fmtTime(e.ends_at, e.end_tz || e.tz)     // arrival: ALWAYS the fallback
```

A device-local render shows a departure in the wrong zone, and an arrival without `end_tz` an hour or more off: the one
bug here that makes somebody miss a plane. `docs/CONTRACTS.md § Time` is the authority; `public/js/util.js` has no
zone-less formatter to reach for by accident.

## Stack

| Layer | What |
|---|---|
| Client | ES modules in `public/js/`, served as files by Cloudflare's asset server; one hash router |
| Server | One Worker in `src/`: a gate and a route table. Every route of a trip has the trip's id in its address, and who is on it is checked once (`src/trips/access.js`) |
| Data | D1 (SQLite), `migrations/`; a trip's live room and its map maker are Durable Objects |
| Files | R2: photos, videos, receipts, and one map archive per trip, served with HTTP ranges |
| Accounts | Open sign-up: passkeys, or Google and GitHub when their client ids are set; sessions are rows behind a random cookie |
| AI apps | An MCP server (`src/mcp/`) with OAuth, so a person's own AI app can read and change their trips |
| Vendored | MapLibre GL, pmtiles, fflate and the fonts in `public/vendor/`; the towns a trip's "Where" is found in, in `public/towns/` (GeoNames, CC BY 4.0). No CDN |

## Run it locally

Node 24 or later.

```bash
npm install
cp .dev.vars.example .dev.vars                 # http://localhost:8788 (passkeys are made for one address)
npx wrangler d1 migrations apply wegoplace --local
npm run dev                                    # http://localhost:8788
```

The map's labels, locally: the same fonts as a deploy's (step 4 below), into the local bucket with
`node tools/fonts-upload.mjs --from basemaps-assets/fonts --local .wrangler/state`.

Open `http://localhost:8788/login` (that address exactly), type a name and make a passkey. Any account can make a trip
and hosts it; others join by a link (`POST /api/trips/<id>/links`, or the trip's People page).

A trip to look at: `seed/demo-trip.json` is a made-up one (made by `tools/demo-seed.mjs`). `tools/seed-trip.mjs` puts it
in through the same routes the app uses, as the account a session cookie names:

```bash
node tools/seed-trip.mjs seed/demo-trip.json --base=http://localhost:8788 --session <your wgp_session cookie's value>
```

Running the Worker anywhere but Cloudflare: set `PICTURE_FETCH_BY_ADDRESS` to `off` in `wrangler.jsonc`'s vars.
Fetching a picture by its address refuses private names, but a public name that resolves to a private address is
stopped only by Cloudflare's own network.

## The checks

Each starts its own server, on a free port, with its own database made from nothing, and touches nothing of yours.

```bash
npm run check:parity          # every recorded request (checks/parity/), answered as the recording says
npm run check:routes          # the route table: every row of a trip behind the one membership check
npm run check:accounts        # accounts end to end, as made-up people with software passkeys
npm run check:trips           # trips: making, joining, leaving, handing over; what a trip carries
npm run check:mcp             # an AI app connecting as apps do: every tool, changes and undo
npm run check:open-source     # no keys, cookies, real emails, account ids or marks in the tree
node scripts/gate.mjs         # the client's browser checks, on a server of their own (Chrome for Testing)
```

`package.json` lists them all (`check:*`); `AGENTS.md` says how to work with them, and the READMEs under `checks/` what
holds.

## Deploy your own

What it takes: a Cloudflare account, a domain on it, Node 24 or later, and `npx wrangler login`. Nothing else of ours:
the site runs with every optional part off (below), and people sign in by passkey alone.

1. **The stores.** Make the database, the two buckets and the OAuth store, and put their ids in `wrangler.jsonc` (it
   carries placeholders): `npx wrangler d1 create wegoplace`, `npx wrangler r2 bucket create wegoplace-media`,
   `npx wrangler r2 bucket create wegoplace-tiles`, `npx wrangler kv namespace create wegoplace-oauth`. R2 has to be
   switched on for the account once, in the dashboard, before its first bucket.
2. **The address.** In `wrangler.jsonc`'s vars: `PUBLIC_ORIGIN` your site's address (`https://example.com`), `RP_ID` its
   domain (`example.com`: the one passkeys are made for, and can't be moved later), `ALSO_ORIGINS` empty (or
   `https://www.example.com` if that serves it too), `RP_NAME` the name people see. In `routes`, your domain as a Custom
   Domain: `[{ "pattern": "example.com", "custom_domain": true }]`. The site is built for one address of its own:
   `workers_dev` is off (a second address would be a second place to sign in, with its own passkeys).
3. **Deploy.** Apply the migrations, then deploy, in that order: `npx wrangler d1 migrations apply wegoplace --remote`,
   then `npx wrangler deploy`. The Durable Objects (each trip's live room and its map maker), the rate limits and the
   cron (the drain, every 15 minutes) come with the deploy: nothing to make by hand.
4. **The map's label fonts**, once: a trip's map is cut from Protomaps' public daily world build, read by range (set
   `WORLD_URL` to read your own copy instead), so there is nothing to upload for the map itself; its labels are drawn
   with glyph files that live in the tiles bucket. Get Protomaps' fonts (17.7 MB, 1,024 files) and send them up:

   ```bash
   git clone --depth 1 --filter=blob:none --sparse https://github.com/protomaps/basemaps-assets
   git -C basemaps-assets sparse-checkout set fonts
   node tools/fonts-upload.mjs --from basemaps-assets/fonts --remote
   ```

   Without them the map's labels have no glyph files to draw with.
5. **Your own Terms and Privacy pages.** `public/terms.html` and `public/privacy.html` are this site's (its seller, its
   contact address, its promises): write your own before anyone signs up. And Cloudflare adds its Web Analytics script
   to a zone's pages by default; turn it off for the zone (Analytics & Logs › Web Analytics) if your Privacy page says
   no analytics, as ours does.
6. **The first account.** Open `https://<your site>/login` and make a passkey: sign-up is open (`SIGNUPS`; `"paused"`
   stops new accounts while everyone who has one signs in). To see the site's error page (`/admin/errors`), put your
   account's id (`GET /api/me` answers it when signed in) in the secret `ADMIN_ACCOUNTS` (several: comma-separated).

**Optional, each off until it is set** (`npx wrangler secret put <NAME>` for a secret; `wrangler.jsonc`'s comments say
what each does):

- Sign in with Google or GitHub: the app's client id in `GOOGLE_CLIENT_ID` / `GITHUB_CLIENT_ID` (vars) and its secret in
  `GOOGLE_CLIENT_SECRET` / `GITHUB_CLIENT_SECRET`; register `<PUBLIC_ORIGIN>/login/google/callback` or
  `<PUBLIC_ORIGIN>/login/github/callback` as the app's redirect address.
- The chat's notifications: `node tools/vapid-keys.mjs --put` makes the key pair and sets both secrets without showing
  them.
- A code by email to get back in when every passkey is lost: switch on Cloudflare's Email Sending for the domain, add
  `"send_email": [{ "name": "EMAIL" }]` beside `"vars"`, and set `EMAIL_FROM`.
- The assistant, which comes with the paid plan: `OPENROUTER_API_KEY` (secret), `ASSISTANT_ENABLED` and its model's
  settings (vars). It reads a PDF or an office file a person gives it with Workers AI (the `ai` binding: nothing to
  switch on).
- The paid plan: `PLAN_ENABLED`, Stripe's prices (vars) and `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` (secrets).
  To give one account the plan without Stripe (your own, say), run `tools/plan-grant.mjs` (docs/API.md, "The plan
  given by the operator").

**Updating** to a newer version: pull it, apply the new migrations (`npx wrangler d1 migrations apply wegoplace
--remote`), then `npx wrangler deploy`, in that order.

**What it costs:** we run it on Workers Paid. The free plan has every service it uses (Workers, D1, R2's free tier,
Durable Objects of the SQLite kind, which these are), but it is untested there: its 10 ms of CPU a request may be too
little for cutting a trip's map or a large upload. If something fails on the free plan, Workers Paid is the answer.
Cloudflare's own pages have the numbers: Workers (https://developers.cloudflare.com/workers/platform/pricing/), D1
(https://developers.cloudflare.com/d1/platform/limits/), R2 (https://developers.cloudflare.com/r2/pricing/), Durable
Objects (https://developers.cloudflare.com/durable-objects/platform/pricing/).

Every change to the app shell (HTML, CSS, any module, the artwork) bumps `VERSION` in `public/sw.js`: phones serve the
shell from their cache and refetch it only when the version changes.

## Where the rules live

- `docs/CONTRACTS.md`: file ownership, the store's API, permissions, the CSS tokens.
- `docs/API.md`: every route, its shape, and why it is shaped that way.
- `AGENTS.md`: how to work in this tree.

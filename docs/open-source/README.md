<!--
A DRAFT of the open repository's README, for review before it replaces README.md. Nothing reads this file.
Before it is published:
  - The stills are named by their path in the review folders, not copied in: each goes into docs/images/
    when this becomes the README, and its link changes to that path.
  - WeGoPlace's own license is to be chosen; "License" below says what it carries, and that.
  - wrangler.jsonc still names this site's own addresses and database id; a fork changes them (Host your own).
-->

# WeGoPlace

WeGoPlace is a trip planner for a group travelling together. One person makes the trip and invites the
others by a link (someone without an account can join with just their name, as a guest, and add a passkey
later to keep their place), and from then on everyone has the same plan, places, packing, money and photos on
their phone, even where there's no signal. It's for friends and families who are tired of the plan living in one
person's spreadsheet and a group chat nobody can search.

It is a web app you add to your home screen. There is no build step and no framework: the browser loads
plain modules from `public/`, and one Cloudflare Worker in `src/` answers everything else.

## What it does

Six tabs, the same for everyone: Itinerary, Places, Split, Photos, Chat and More. On a phone they're a bar at
the foot; on a wider screen, a rail or a sidebar.

- **The itinerary, by day.** Flights, stays, buses, meals and walks, each in the time zone where it happens, with
  what's next and how long until it.
  ![The plan for one day](16-wegoplace/review/client/agenda-today-made-up-trip/390-light-agenda-0830.png)
- **Places worth going,** sorted by kind, on the trip's own map. The map is cut for the trip's areas and kept
  on the phone, so it still works with no signal.
  ![Places on the trip's map](16-wegoplace/review/client/agenda-today-made-up-trip/1440-light-map.png)
- **Talking about it.** One chat for the trip, and "said about this" on any place, plan or purchase.
  ![A place, with what people said about it](16-wegoplace/review/client/chat-about-and-miles-made-up-trip/390-light-place-said-about-this-place.png)
- **Split.** Who paid for what, in any currency, split however you like, and who owes whom at the end.
  ![Adding a purchase](16-wegoplace/review/server/split-simpler/new-add-filled-390-light.png)
- **Packing,** under More. Your own list, private to you, and the group's, by bag and by day.
  ![Packing for today](16-wegoplace/review/client/pack-today-made-up-trip/390-light-today-one-packed.png)
- **Photos, and an assistant if the site offers one.** Photos and videos by the day they happened, boards
  you can share by link, and an assistant each person talks to privately. Each person can share an answer
  with the group.
  ![An answer shared in the chat](16-wegoplace/review/client/assistant-made-up-trip/390-light-chat.png)
- **What's yours.** On Your account, a download of your account, your messages and memories on each trip, and
  your conversations with the assistant. Deleting the account is on the same page.

A phone keeps the whole trip, and when it's been away it asks only for what changed since it last looked. On a
big trip that's a few kilobytes, not the whole trip again.

Every still here is of a made-up trip, with made-up people.

## Run it on your own computer

You need [Node](https://nodejs.org) 24 or later.

```bash
npm install
npm run demo
```

`npm run demo` starts the Worker on `http://localhost:8788` (or `npm run demo -- --port 8790`, if 8788 is taken)
with a fresh database. It puts in a made-up
trip of twelve days, with 60 plans, 331 places and four people, through the same routes the app uses. It
then prints a one-use sign-in link for each of the four people. Open one and press the button, and you're
that person on the trip. Open another in a private window to be someone else beside them. Ctrl-C stops it,
and its database goes with it.

To keep a database between runs, run the Worker yourself:

```bash
cp .dev.vars.example .dev.vars                         # the local address; passkeys are made for it
npx wrangler d1 migrations apply wegoplace --local     # the tables, from migrations/
npm run dev                                            # http://localhost:8788
```

Then open `http://localhost:8788/login`, at exactly that address (passkeys made at `localhost` don't work at
`127.0.0.1`), type a name and make a passkey. The database stays in `.wrangler/state` (git ignores it).

On another port, put it in `.dev.vars`'s `PUBLIC_ORIGIN` and start the Worker with `npm run dev -- --port 8790`.
(`npm run dev` runs wrangler dev without its local trace store, which otherwise grows about half a gigabyte an hour.)

The map's place labels need its fonts in the local bucket, once (the fonts are below, in step 5 of Host your
own). Each file is its own local put, so this takes a while:

```bash
node tools/fonts-upload.mjs --from <basemaps-assets>/fonts --local .wrangler/state
```

## Host your own

WeGoPlace runs on Cloudflare: a Worker, a D1 database, two R2 buckets, one KV namespace and two Durable
Objects. A Cloudflare account's free allowances cover a small group's site. R2 has to be switched on in the
dashboard before its buckets can be made.

Everything above runs without a Cloudflare account; from here on you need one.

1. **Make what it stores things in**, and put each id in `wrangler.jsonc` in place of this site's own:
   ```bash
   npx wrangler login                                # opens Cloudflare's sign-in in your browser, once
   npx wrangler d1 create wegoplace                  # its database_id goes in d1_databases
   npx wrangler r2 bucket create wegoplace-tiles     # the trips' maps and the map's label fonts
   npx wrangler r2 bucket create wegoplace-media     # photos and videos
   npx wrangler kv namespace create OAUTH_KV         # connected apps' grants; its id goes in kv_namespaces
   ```
2. **Say where the site lives.** In `wrangler.jsonc`'s `vars`, set `PUBLIC_ORIGIN` (`https://trips.example.com`),
   `RP_ID` (`trips.example.com`: passkeys are made for it), `RP_NAME`, and `ALSO_ORIGINS` (empty, unless a second
   address serves the same site). `SIGNUPS` is `"open"`, or `"paused"` to let only existing accounts in.
3. **Give it its address.** A name that serves nothing yet is a Custom Domain, added to `wrangler.jsonc`:
   `"routes": [{ "pattern": "trips.example.com", "custom_domain": true }]`.
4. **Make the tables, then deploy:**
   ```bash
   npx wrangler d1 migrations apply wegoplace --remote
   npx wrangler deploy
   ```
5. **The map's label fonts, once.** The fonts come from Protomaps'
   [basemaps-assets](https://github.com/protomaps/basemaps-assets); `tools/fonts-upload.mjs` says how to get them.
   ```bash
   node tools/fonts-upload.mjs --from <basemaps-assets>/fonts --remote
   ```
   A trip's map is cut from Protomaps' public daily world build, read by range. Nothing to set up: set
   `WORLD_URL` only to cut from a copy of your own.

That's a working site: passkeys, trips, invites, the map, photos, Split, the chat and the MCP. Each of these is
optional, and stays hidden until it's set up:

| What | How |
|---|---|
| Sign in with Google or GitHub | An OAuth app at each, with the redirect address `PUBLIC_ORIGIN` + `/login/google/callback` (or `/github/callback`); its client id in `GOOGLE_CLIENT_ID` / `GITHUB_CLIENT_ID`, its secret by `npx wrangler secret put GOOGLE_CLIENT_SECRET` (or `GITHUB_CLIENT_SECRET`) |
| Email, to get back in when every passkey is lost | Cloudflare's Email Sending switched on for the domain, the `"send_email": [{ "name": "EMAIL" }]` binding, and `EMAIL_FROM` |
| Notifications of new chat messages | `node tools/vapid-keys.mjs --put` makes the site's keys and sets them as secrets, once |
| More room per account | `STORAGE_LIMIT_BYTES` (1 GiB across the trips an account hosts, if empty) |
| The site's own page of what broke (`/admin/errors`: errors from the pages, the Worker and the cron, kept without who or which trip) | `ADMIN_ACCOUNTS`: the account ids that may open it, comma-separated (yours is the `id` in `/api/me`), in `vars` or by `npx wrangler secret put ADMIN_ACCOUNTS`; unset, the page is a 404 for everyone |
| A paid plan, and the assistant | Off unless `PLAN_ENABLED` is `"true"`, with a Stripe product's monthly and yearly prices, its keys, and a webhook at `/api/billing/stripe`; the assistant also needs `ASSISTANT_ENABLED`, an OpenRouter key and a model with its prices. `wrangler.jsonc` says what each setting does, and `tools/assistant-bakeoff.mjs` compares models on trip tasks before you pick one |

Off Cloudflare, set `PICTURE_FETCH_BY_ADDRESS` to `"off"`. Fetching a picture by its address relies on
Cloudflare's network to keep it from reaching private addresses.

## Connect an AI

WeGoPlace is an MCP server at `PUBLIC_ORIGIN` + `/mcp`. An app connects with OAuth: the person signs in, sees
what the app may do, and says yes. It then works on every trip they're on, as them. Every change it makes is
listed on the trip, and anyone on the trip can undo it.

- **The Claude app:** Customize → Connectors → + Add → Add custom connector, and paste the address. Add it on the web
  or the desktop app; it then works in the phone app too.
- **Claude Code:** `claude mcp add --transport http wegoplace https://trips.example.com/mcp`, then `/mcp` and
  Authenticate.
- **Anything else that takes MCP servers:** give it the address.

It serves guides as well as tools: how to set up a trip from booking confirmations, add places worth seeing
and say why, or make a packing list. An app can't delete a trip, add or remove anyone, make join links, hand a
trip over, or touch anyone's own packing list but the person's. An app connected read-only can't write at all.

## The checks

Each check starts its own Worker on a database of its own, with made-up people, and touches nothing of yours.
Most need only Node:

```bash
npm run check:access     # every route, as six different callers, against its rule in checks/access/rules.mjs
npm run check:privacy    # what WeGoPlace promises about privacy, each promise held by the checks that prove it
npm run check:limits     # every write's limits (sizes, counts, rates), written in checks/limits/rules.mjs, crossed
npm run check:parity     # 1,440 requests answered as checks/parity/golden.json records them
npm run check:routes     # the route table: every row reached, every trip's row behind the one membership check
npm run check:trips      # making, joining, leaving, handing over; everything a trip holds
npm run check:mcp        # an app connecting as apps do, every tool, changes and undo
```

Each starts its Worker on a port of its own (8791 for the core ones, like `trips`, `mcp` and `parity`), and
takes `--port <n>` for another (`npm run check:trips -- --port 8801`). `check:parity` must stay on 8791: its
recording holds addresses with that port in them. Every limit the site
keeps, in words, is printed by `node checks/limits/sweep.mjs --table`; its first lines say which are counted
by the site and which are Cloudflare's rate limiting, which is approximate.

`package.json` lists them all. About twenty of them drive a headless Chrome for Testing at one pinned version,
never your own browser: the ones named `-browser`, and others such as `journey`, `chat-screen` and `map-draw`.
Install it once (Mac, Linux x64 or Windows x64; it checks Google's zip against a pinned hash, and takes about
370 MB):

```bash
node scripts/install-check-chrome.mjs
node scripts/gate.mjs        # every check, on one server of its own with the made-up trip, one at a time (about an hour)
```

## License

WeGoPlace's own code: *to be chosen before publishing.* What it carries keeps its own license, each in a file
beside it:

| What | Where | License |
|---|---|---|
| MapLibre GL | `public/vendor/maplibre/` | BSD 3-Clause |
| PMTiles | `public/vendor/pmtiles/` | BSD 3-Clause |
| Protomaps basemaps (the map's style) | `public/vendor/basemaps/` | BSD 3-Clause |
| fflate | `public/vendor/fflate/` | MIT |
| Inter, Bricolage Grotesque (the app's fonts) | `public/vendor/fonts/` | SIL Open Font License 1.1 |
| The map's label fonts | uploaded from Protomaps' basemaps-assets | SIL Open Font License 1.1 |
| Towns and their time zones | `public/towns/`, from [GeoNames](https://www.geonames.org/) | CC BY 4.0 |
| Map data | Protomaps' builds of [OpenStreetMap](https://www.openstreetmap.org/copyright) | ODbL; © OpenStreetMap contributors |

The app credits OpenStreetMap, Protomaps and GeoNames in its settings.

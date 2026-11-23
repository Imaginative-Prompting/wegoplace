# The trips check

Trips are `src/trips/` on the server: making one, the people on it, the links they join by,
and the rev every write moves; and what a trip carries (its areas, places, events, packing
lists and suggested items), and its storage. One check holds them, and it can fail.

```bash
npm run check:trips        # about 30 s
```

It starts `wrangler dev` on port 8791 with its own empty database and R2 under
`.wrangler/check/`, and stops it again. Its server's storage limit is 1 MiB
(`STORAGE_LIMIT_BYTES`), so the storage part can fill it, and it runs the drain at
`/__scheduled` (`wrangler dev --test-scheduled`, as every check's server does). It refuses to start if the port is taken, so run one
check at a time (`check:accounts`, `check:parity` and `check:upload` use the same port).

`run.mjs` plays every part in order, as made-up people who each have their own cookies and
their own software passkeys (`../lib/person.mjs`). Plain HTTP: no page is drawn. What the join
link's page and the account page's list of trips show is `check:accounts-browser`'s to say
(`../accounts/README.md`).

| part | what it holds |
| --- | --- |
| `rates` | every check's server asks a stand-in on this machine for exchange rates (fixed rates, `FX_PROVIDER_URL`); wrangler.jsonc names no provider; an address that isn't loopback is refused for the real one |
| `making` | any account makes a trip and is its host; what a name, dates, a zone and currencies may be; a create sent twice lands on one trip; the most trips one account hosts |
| `whole` | the whole trip in one read, its details changed by any member, and the rev: it goes up by one in every write, every answer to a write carries it, and a row keeps the rev of its own last write |
| `joining` | a link: what it answers before anyone has joined, joining once, the same person joining twice, its expiry, its use limit, revoking it, the most links and the most people; **a link past its use limit, run out or revoked answers the same words as one that never existed** |
| `writes` | **a second member sees the first's write through the rev route**, for every kind of row a trip holds |
| `leaving` | **a removed member is refused on the next request, and a member who left can't read the trip**; only the host removes; the host can't leave; what they wrote and paid stays; someone who left comes back by any link that works, someone the host removed only by a link made after the removal (an older one is "no such link", costs nothing, writes nothing), ordered by the rev even within one second; the host removing someone who had already left marks them removed too |
| `handing` | handing a trip over: host only, to someone on it now, and what the old host can and can't do after |
| `apart` | two trips stay apart: nothing of one is read, written or guessed at through the other's address, stored files and map data included |
| `settling` | a payment is a kind of purchase: each refusal, in its exact words and status |
| `addresses` | under `/api`: an address nothing answers (404, JSON), a wrong method (405 with `Allow`), signed out (401, JSON); the app's files answered to anyone; the old addresses, for an account on one trip, none and several |
| `deleting` | deleting an account that hosts: refused, naming the trips, while other people are on one; a trip nobody else is on goes with it, down to its rows and stored files (areas, places, packing lists, ticks and starters included) |
| `storage` | storage (`storage.mjs`): the host's meter and what every member sees of it; a write that doesn't fit refused before any bytes move, and what the host and a member are each told (a member never sees the host's other trips); an upload under way holding its bytes, cancelled by the host and freed at once, and dropped after a day by the drain; a host over the limit reading and refused new bytes; a board and its photograph counting, a deleted memory unsharing its board, only the maker or the host revoking; handing a trip over as an offer (offered, shown on the member's list, taken back, declined, ended when the member leaves, refused when the trip doesn't fit the new host, accepted); account deletion's two ways out; the trip's own map by range; deleting a trip (the preview of what goes, the name typed with spaces, no tombstone, the drain emptying the bucket, a file that fails ten runs staying and being counted in the log) |
| `carries` | what a trip carries (`carries.mjs`, its own people and trips): interests and the person's units; areas (each refusal in its words, two levels, a box across the 180° line taking a place at 179.5 and -179.5 and refusing one at 170, bounds that would strand a place, areas in use); places (the guide's example, every §16 refusal saying what is allowed, all or nothing, 200 rows, the 25 m warning, a change that keeps what it doesn't send, an old row's nine tags kept until rewritten, places in use, a purchase left floating); events (no dates, a wrong year, the last day in the event's own zone, any member changing and removing, the trip's dates refused from the other side); packing (the guide's lists, ticks per item per list and per day, every refusal, what can't be removed, starters); and a seed put in through the routes by `tools/seed-trip.mjs` |

`node checks/trips/run.mjs making joining` runs only the parts named (a part needs the ones
before it). `--port <n>` moves it; `--keep` leaves the server's folder and log for reading.

After the parts it reads the server's log: nothing may have failed inside the server. It also
prints the settling-up refusals as the server answered them, so the words in `docs/API.md` and
in the app can be read against the real ones.

## The pages outside a trip, in a browser

```bash
npm run check:trips-browser -- --shots ~/Documents/GitHub/imaginative-prompting/16-wegoplace/review/server/trips
```

`browser.mjs` draws Your trips (`/trips`) and a trip's people and settings (`/trips/<id>`) in
Chrome for Testing (through `scripts/lib/browser.mjs`), with two made-up people, each in a browser
of their own and signed in with their own session: the empty list, making a trip (and where it
goes: the app at `/t/<id>/`), the list as a host with the storage block, a link made and shown
once, the other person joining by it, the offer to host shown to them as a card and accepted,
**the old host's still-open page refused in words and redrawn as things are now**, the details
changed by a member (the dates refused while they'd leave an event outside), leaving, the list
with no signal (and never another account's list), deleting with the typed name, and the kept
list gone after signing out. `/t/<id>/` is held to the same bytes and headers as `/`. Each screen
is measured at 390, 820 and 1440 wide in light and dark, and its text against each theme
(`../lib/look.mjs`, shared with the account pages' check). One line is listed as WAITING: that
the app at `/t/<id>/` opens the trip, which is the client's trips piece.

## A check stopped from outside

Each check's server is written down when it starts (`$TMPDIR/wgp-server-checks/`, its pid, port
and check) and the record removed when it stops. A run stopped from outside leaves both:
`node checks/lib/leftovers.mjs` lists them, and `--stop` stops each one still running by its
recorded process group, after reading its whole command line to see it is still that server.
Nothing else is a way to find this lane's servers: both lanes' servers carry
`lanes/server/node_modules` in their command lines.

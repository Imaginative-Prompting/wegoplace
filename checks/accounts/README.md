# The accounts checks

Accounts are `src/accounts/` on the server and `public/login.html`, `public/account.html`,
`public/js/auth.js` and `public/js/account.js` in the browser. The page a join link opens
(`public/join.html`, `public/js/join.js`) is drawn with the same parts and is held here too.
Four checks hold them, and each can fail.

```bash
npm run check:accounts                # about 2 minutes
npm run check:accounts-browser        # about 2 minutes; starts a browser (see below)
npm run check:carry-over              # about 50 s; needs commit 109984b in the clone
```

Each starts `wrangler dev` on port 8791 with their own empty database and R2 under
`.wrangler/check/`, and stop it again. They refuse to start if the port is taken, so run one at
a time (`check:trips`, `check:parity` and `check:upload` use the same port).

## check:accounts

`run.mjs` plays every part in order, as made-up people who each have their own cookies, their
own connection and their own software passkeys (`../lib/person.mjs`). Google and GitHub are
played on this computer by `../lib/standin.mjs` (the server is pointed at it with
`AUTH_STANDIN`, which only works on localhost), and email is `wrangler dev`'s own simulated
sending, read back from its log.

| part | what it holds |
| --- | --- |
| `passkeys` | sign-up with a name and a passkey, sign-in, a second passkey, and each thing that must be refused |
| `trips` | signing in puts nobody on a trip: an account that isn't on one gets `404 "no such trip"` (with its reason) from every route of it; any account makes a trip; someone joins by a link; another site's page can change nothing |
| `pages` | the sign-in page and the account page are files anyone is answered, and say nothing of anyone until their script asks; signed out, what they ask is refused; every request their scripts make has a handler; every element they reach for is in the page |
| `client` | `public/js/auth.js` itself, run against the server with a made-up device: what it sends is what the server reads, and each refusal comes back in its own words |
| `providers` | Google and GitHub: a new account, signing in, adding and removing a way to sign in, and each way the trip there and back can be bent |
| `email` | an address on the account, confirmed by a code; getting back in with it; the limits on codes |
| `link` | the operator's one-use sign-in link (`tools/signin-link.mjs`) |
| `guests` | joining a trip by its link with only a name (model §22): who is made and who isn't, a guest on the trip like anyone, what needs an account (a trip of their own, hosting, an email, an AI app), the host's link that signs a guest in again on a new phone (only while every trip they're on is that host's; the old phone signed out), adding a passkey or Google makes the same person an account, a guest's export, deleting and signing out |
| `who` | the page's note of who is signed in (`wgp_who`): each way in sets it (a new account by passkey, a passkey, a new account from Google, Google, GitHub, the email code, the operator's link, the old cookie carried over) to the account's id and nothing else, readable by the page and otherwise as the session cookie; each way out clears it (signing out, everywhere, deleting); a signed-in browser without it, or with another account's, is sent the right one and answered as its session's account; alone it signs nobody in |
| `sessions` | a session slides forward, runs out, is ended; the cookie from before sessions were rows becomes one; signing out everywhere |
| `deleting` | what goes and what stays when an account is deleted, down to the bytes in R2 |
| `limits` | run with small limits (10 sign-in starts and 50 unknown cookies a minute, `LIMITS_HERE`), so a busy machine still reaches them; wrangler.jsonc keeps 60 and 1,200. One connection's sign-in starts, then 429; three people signed in on one address send 2,700 requests, many times the limit a minute, and none is refused, while made-up cookies from that address are counted and turned away at the limit |
| `paused` | with `SIGNUPS=paused`: nobody new, everyone who has an account still signs in |

`node checks/accounts/run.mjs passkeys trips` runs only the parts named (a part needs the ones
before it). `--port <n>` moves it; `--keep` leaves the server's folder and log for reading.

No page is drawn by any of this: `pages` and `client` read the pages' source and run their
script. What a browser shows is the next check's to say.

## check:accounts-browser

`browser.mjs` opens the sign-in page, the account page and a join link's page in Chrome for Testing (through
`scripts/lib/browser.mjs`, the one file that may start a browser) and goes through everything
they offer as made-up people, each in a browser of their own (`../lib/chrome.mjs`): its own
cookies, its own screen, and a device that makes and uses real passkeys (Chrome's virtual
authenticator). It makes an account, signs out and in again with nothing typed, adds a second
passkey from another browser, adds and removes GitHub, confirms an email and gets back in with
it, arrives with a Google account nobody has used, uses a one-use link, deletes an account,
and opens the page where passkeys can't work and where new accounts are paused.

For trips: a host's account page lists its trips by name, with their dates, how many people
are on each, and "You host it" in words with a flag. A join link, opened signed out, shows the
trip's name, dates and host and offers to sign in; an account made from there comes back to
the link, joins with one button, and lands in the app. The page says so in words when the trip
is full, when the link doesn't work (turned off, never existed, not a code at all: one screen,
the same words), when the server can't be reached, and when its own script didn't load.
Deleting an account that hosts a trip other people are on is refused in words that name the
trip.

Leaving takes what the phone keeps about the person with it (`public/js/forget.js`). With
changes planted on the phone that haven't been sent (in the trip's queue and the packing list's),
a kept picture and two remembered choices, Sign out (on the account page and on the sign-in
page) and Delete ask first and say how many changes haven't been sent. A sign-out the server
never hears says so and clears nothing. Once the server has said yes the phone holds none of
it, and keeps only its own theme. A browser that refuses to store anything is told on the
sign-in page that the phone couldn't be fully cleared, what may be left, and how to remove it.

The app's own screens for making a trip and a link aren't these pages': where the check
needs one, the request is sent from the host's signed-in page.

At each screen it measures the page at 390, 820 and 1440 wide, in light and in dark: nothing
off the side, clipped or overlapping; every control at least 44 high (the kit's small button
36, with its own tap area), named, and reachable by scrolling. Every message must carry its
icon as well as its tint, every button that asks twice must change its words, and all text must
be readable against its background (WCAG's 4.5 to 1, 3 to 1 for large text) in each of the five
themes and, on the account page, each of the six accents. Every still and every measure is
taken with the page at rest (fonts in, no transition still running). A button that asks
twice stops asking after five seconds; where the check does slow work between the two
presses it looks first, and presses once more if the asking has lapsed, as a person who
waited would.

It also holds the pages to a few things a person would notice: on a slow connection the
sign-in page is drawn once, with its heading and passkey button where they stay (and, opened
while signed in, never draws the sign-in screen first). That is read from where things are,
frame by frame: every element a person can see on the page must stay in the place it was
first seen in. The browser's own layout-shift score is kept beside it, but it is not the
proof: it has read 0 for a page whose heading moved 79 px. The wait that makes this possible
has to end by itself: with the page's script held back for good the heading must still show
four seconds after the page opens, and with the script refused the page must say so in
words, with a way to try again and no button that can't work. The join page is held to the
same record on a slow connection, and the check counts how many elements it watched, so
"none moved" can't mean "none seen". The account page's cards read Name,
Trips, Ways to sign in, Email, Signing out, Delete at every width; the button that deletes the
account wears the warning color and fills with it when it asks; and Google's and GitHub's
buttons carry their marks, Google's on the fills Google allows (`public/img/marks/SOURCES.md`).

A launch has to come through the machine's queue, or the launcher refuses:

```bash
python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
  --label "accounts in a browser" -- npm run -s check:accounts-browser -- --shots <folder>
```

`--shots <folder>` writes a picture of each screen at each size. The app's service worker is
left out of these pages on purpose (it would answer from its cache).

Every page is a window of its own, and headless windows open on top of one another. Chrome
refuses a passkey to a window it counts as covered ("the page does not have focus"), and which
ones count follows how many are open and the order they were used in: with eight open, five
were refused. `../lib/chrome.mjs` starts the browser with
`--disable-backgrounding-occluded-windows`, so every page is the one in front, as each
person's own browser is.

## check:carry-over

The accounts and the trip that existed before this, carried across migrations
`0016_accounts.sql` and `0017_trips.sql`. It runs the server as it was at commit 109984b, has
two people sign up there with invite codes and passkeys, stops it, applies 0016 (and applies
it a second time: nothing changes), then 0017 as one file, and starts the server as it is now:
both are still signed in with the cookie they had, sign in with the passkey they had (with and
without the username), and can add another. After 0017 the accounts are the same rows without
`is_admin`, the trip is as it was with the account that ran the site as its host and everyone
still on it, every purchase is a `purchase`, the board has its seed, no foreign key is broken,
and the trip answers at `/api/trips/<its id>`. 0017 can't be applied twice (`ALTER TABLE … ADD
COLUMN`), and the check holds that a second application fails rather than half-running.

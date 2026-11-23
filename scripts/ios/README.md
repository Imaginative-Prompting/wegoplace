# The iPhone driver (off the gate)

These files run a walk on an **iPhone Simulator's Home Screen app**: real Safari,
real WebKit storage and service worker, real touches through UIKit, and iOS's own passkey sheets. Headless Chrome and
WebKit can't show those. None of it is on the gate: a booted device is heavy, and it needs Xcode.

| File | What it is |
|---|---|
| `phone.mjs` | the phone a walk drives (--phone): boots the device, adds the old app to the Home Screen, opens it from its icon, touches what a person touches, takes stills, shuts the device down |
| `proxy.mjs` | the relay in front of the site: puts a small probe in every page (what it says, its errors, scripts the check sends), hands the phone its cookie, cuts the signal on demand |
| `clip_share.mjs` | a clip on a shared board, opened from its link in a friend's Safari tab (no worker): it plays, a seek to 7.5 s lands there, and the server answers its requests with 206s, never the whole file |
| `where_error_test.mjs` | node only: the relay places each page error by the page that sent it and when (against that page's hello and its goodbye on pagehide), not by the last page to say hello; `IOS_WHERE_PLANT=lasthello` puts back the old rule (red) |
| `home_launch.mjs` | the app added to the Home Screen and opened from its icon, each page error placed by its page; `offline`: the worker in control, the app opened again, then with the server cut: does it load, does the trip draw from the phone's copy |

## What it needs

- **macOS with Xcode** and an iPhone simulator runtime (written on iOS 26.4, an iPhone 17). Make a device of your
  own and use it for nothing else: `xcrun simctl create old-phone "iPhone 17"`. Its UDID is `LAB_UDID`. The run erases
  it each time.
- **AXe 1.8.0** (github.com/cameroncooke/AXe), from its GitHub release, checked by hash before use:
  `axe.tgz` SHA-256 `87eb09cd49dfc74fa8f7f5a46a03dfe2f14518b01d819f6a4094eab0d344ea7f`, the `axe` binary inside it
  SHA-256 `24a3dc336f1bb968670331fc33923116d090363bea6517d14dd08e6269175fcd`. `IOS_AXE` is the binary's path.
- The sandbox off: `simctl`, AXe and the old site's `wrangler` need it.


## A board shared from the phone, with a HEIC on it

```sh
LAB_UDID=<your device> IOS_AXE=<path to axe> WGP_BASE=… WGP_GATE_CARD=… \
  node scripts/ios/heic_share.mjs <out folder>
```

On a gate's server (`node scripts/gate.mjs --serve` prints the two variables). It puts two JPEG memories and one HEIC
(made up, with made-up camera data) on the gate's trip, shares the board from the phone's Safari with real touches,
and checks the board's page: a print for each, each opening its own picture, none carrying camera data. It erases the
device first and shuts it down at the end, whatever happens; the memories it made are removed. The out folder gets
the stills and the log (made-up data only).

## A clip on a shared board, in a friend's Safari

```sh
LAB_UDID=<your device> IOS_AXE=<path to axe> WGP_BASE=… WGP_GATE_CARD=… \
  node scripts/ios/clip_share.mjs <out folder>
```

On a gate's server, like the HEIC run. It makes a 12 s test pattern with ffmpeg (its index at the end, as a phone's
camera writes it), shares a board with it through the routes as the trip's host, and opens the board's link in a
Mobile Safari tab on the erased device. Then it plays the clip, seeks it to 7.5 s, and reads the relay's record of
how the server answered the clip's requests. A server answering with the whole file still plays and seeks in the
Simulator, so the third check (206s, never a whole 200) is the one that tells it apart. The share is revoked by its id
at the end. The out folder gets two stills, the relay's timeline and the log (made-up data only).

## The app from its Home Screen icon, and offline

```sh
LAB_UDID=<your device> IOS_AXE=<path to axe> WGP_BASE=… WGP_GATE_CARD=… \
  node scripts/ios/home_launch.mjs <out folder> [launches | offline]
```

On a gate's server, as the trip's host (the relay hands the phone the host's session). The app is opened in Mobile Safari,
added to the Home Screen by real touches and opened from its icon (twice unless said), the app shut between. Every page
says hello and goodbye to the relay, and each page error is placed by its own page (whereError()): Safari's tab apart
from the Home Screen app, the first page "/" apart from the trips page it sends on to. With `offline`: after the first
launch, the worker ready and in control (one reload if not), the trip opened once with the server there, the app shut
and opened again (in control from its first page?), then the relay's route to the server cut (/api/me checked failing)
and the app opened from its icon once more: does it load, does the trip draw from the phone's copy, and what does it
say. A first launch that is shut before its worker has installed is not ready offline yet: open the installed app once
with signal and let it settle. The device is erased first and shut down at the end, whatever happens. The out folder
gets the stills, the relay's timeline and `home-launch.json` (made-up data only).

## The app as it is used: the head, the end of a list, the keys, the chips

```sh
LAB_UDID=<your device> IOS_AXE=<path to axe> WGP_BASE=… WGP_GATE_CARD=… \
  node scripts/ios/notes_check.mjs <out folder>
```

On a gate's server, as the trip's host, in the app opened from its Home Screen icon. A: the heads of the Itinerary,
Places, Split, Photos and Chat in light and dark, at rest (the title below the status bar's strip, nothing drawn or
see-through over it), and a still a little scrolled. B: the Itinerary's last day chosen and the list scrolled to its
end: the bar back, at most 48 px below the last row. C: each add sheet (a plan, a place, a purchase, a packing item)
with its first field touched and then its lower fields, each touched where it stands low on the screen: the field and
the sheet's action wholly above the software keyboard (window.visualViewport). D: no chip with a symbol has its symbol
or words past its own edge. iOS's location question is answered Allow, read at its place (it is not in the app's
accessibility tree). The device is erased first and shut down at the end. The out folder gets `notes-*.png`,
`notes.json` and the log (made-up data only).

## How it touches

- **A page's control** (inside a Home Screen app the page is one "Web" element to the accessibility tree): its box is
  read by the probe, and the touch goes to its middle. The page is edge to edge in the Home Screen app
  (`viewport-fit=cover`), so a page point is a screen point there. In a Safari tab the page starts below the browser's
  bar (62 pt on an iPhone 17; `IOS_PAGE_TOP` to say otherwise). Before each touch it logs the point beside the box:
  `a touch at 155,437 for #btn-add-passkey: its box 33..277 × 415..459 (page top 0, Home Screen app)`.
- **A system sheet's control** (the passkey sheets are in the accessibility tree) by its exact name, from a list tried in
  order. The button comes first, since a sheet's title can share its words ("Sign In" above "Use Passkey").
- **Face ID**: enrolled, then a match, by `notifyutil` on the device.
- **Add to Home Screen**: the share sheet isn't in the accessibility tree, so its rows are touched by position, measured
  on an iPhone 17 (`IOS_VIEW_MORE`, `IOS_ADD_ROW`, `IOS_ADD` as "x,y" for another device; `IOS_ICON` is the icon's name).
- **Never `axe type`** (it switches the device to a hardware keyboard), and **never Simulator.app** (quitting it shuts the
  device down). AXe works headless.

## The site behind the relay

Once the site is behind the relay, the relay keeps the phone's own address (Host, Origin, Referer). A site run for the
walk counts it as one of its own (`--also-origin`), as wegoplace.com is the real site's.
A passkey's client data names the page's address. If the site hears its own port instead, it refuses the passkey
("not verified"). A phone at the real address never meets this: there the page's address and the site's are the same.

## What a red means

- `before … the relay's site did not answer this process`: the site, not the phone. The relay asks it before the phone
  is asked.
- A touch's logged point outside its box: the driver, not the app.
- A page error "Script error. @ (no file)" from the old app's first page in Safari is the full probe's own; the bare
  load (`IOS_BARE_LOOK=1`) shows the old app alone has none.

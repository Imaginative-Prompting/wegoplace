# Testing on REAL iOS Safari

Five rounds of fixes were reported landed, with passing harnesses, and each was found broken on
a real phone within a minute. Every one of those harnesses ran in **headless Chrome**. Two of
the bugs — the day-pill vanishing mid-glide, and the software keyboard shoving the page behind a
sheet — **cannot happen in headless Chrome at all**. Chrome was the wrong oracle, so the fixes were
"proved" against an engine that never had the bug.

This directory is the rig that fixed that. It runs the shipping app on **real iOS WebKit**, driven
by **real touch**, and reads the result out of **real pixels**.

## The runtimes were here all along

    xcrun simctl list runtimes      # iOS 18.5, iOS 26.4
    xcrun simctl list devices       # ...may be empty. That is not the same thing.

A previous round concluded "no iOS simulator installed" because no *devices* existed. The runtimes
did. Create one:

    xcrun simctl create wgp-ios iPhone-16 com.apple.CoreSimulator.SimRuntime.iOS-26-4
    xcrun simctl boot <udid>
    open -a Simulator

## 1. Auth — you cannot type a passkey into a simulator

Sign-in is WebAuthn. `proxy.js` fronts `wrangler pages dev` and adds the signed `s2` cookie
server-side, so Mobile Safari gets an authenticated session and byte-identical app modules.

    PORT=<free port> WGP_BASE=http://127.0.0.1:<dev server port> node scripts/ios-real/proxy.js
    xcrun simctl openurl <udid> "http://localhost:<free port>/#/"

## 2. Never test stale bytes

`sw.js` precaches every app module and `asset()` is cache-first with no revalidation. On the
simulator that means your second run can serve the code from *before* your edit — the exact way a
fix looks landed when it is not. By default the proxy serves a **self-unregistering `sw.js`** on
its own origin. That is the iOS equivalent of `Network.setBypassServiceWorker`.

Cheapest full reset: **use a different port**. A new origin has no worker and no HTTP cache.

Once, deliberately, at the end of a round, re-run with `NOSW=0` to confirm the app still boots
against the real worker.

## 3. Real touch

`simctl` HID input is a real finger as far as WebKit is concerned. Two traps, both of which cost
this round a wasted recording each:

* **Start a scroll inside the list.** The tab bar and the Safari toolbar are not scrollable; a
  swipe that begins on them does nothing, and it looks exactly like "the scroll fix is broken".
* **A swipe that is too short or too fast reads as a tap** and navigates instead of scrolling.

Turn the software keyboard ON — the simulator suppresses it while a hardware keyboard is
"connected", and without it you are not testing the keyboard at all:

    defaults write com.apple.iphonesimulator DevicePreferences -dict-add <udid> \
      '{ConnectHardwareKeyboard = 0;}'
    # then quit and relaunch Simulator.app

## 4. Frames — 120 fps, from the window

`xcrun simctl io <udid> recordVideo` and `... screenshot` both fail in the Claude Code
environment (`SimRenderServer error 2`, and a read-only filesystem for simctl's own writes). The
macOS window recorder does not:

    screencapture -x -t png -R <x,y,w,h> shot.png      # still, points not pixels
    screencapture -v -V 12 -R <x,y,w,h> take.mp4       # ~120 fps, 740x1716 for an iPhone 16

Bring the Simulator to the front first (`open -a Simulator`) or another window will be in the
region. Find the region by taking one full-screen capture and reading the window off it — the
Accessibility API is not available to `osascript` here.

**Timing.** Tool-call latency between starting a recording and issuing a tap is unpredictable and
will not fit inside a short take. Do not race it: record generously (30–40 s), perform the whole
flow, and then *find* the moment in the frames analytically rather than assuming when it happened.

## 5. Numbers — an observer, not a driver

`PROBE=1` injects `probe.js` at the end of `<head>`. It samples at 33 Hz and POSTs to
`/__v7log`; `GET /__v7reset` truncates between takes.

It **only observes**: no scrolling, no focus, no synthesized events, no shadowed APIs. That is the
rule the previous rounds broke — a harness that shadows `visualViewport` and fires its events
proves nothing about what iOS does, which is scroll the focused input's scroll ancestor.

It deliberately samples on a 30 ms timer rather than per animation frame: reading layout every
frame is an observer that changes what it observes.

It reports `#view.scrollTop`, `visualViewport.{offsetTop,height}`, `body.style.top`, the strip's
`scrollLeft`, the ring's `left` and live animation count, the lit day pill, `<img>` load and
insertion counts, and the rects of the sheet, the focused field and the page behind.

## 5b. simctl coordinates are SCREEN points, the page's are 62pt lower

This cost a whole round. `simctl` / the simulator MCP take **device screen** points; everything
you read out of the page (`getBoundingClientRect`, `elementFromPoint`, the probe's rects) is in
**page** coordinates, whose origin sits below Safari's top bars. On an iPhone 16 in this setup:

    device_y = page_y + 62          # 402x874 screen, 402x714 page

Get this wrong and every touch lands ~62pt high — which looks *exactly* like a product bug,
because it lands on the control above the gap you were aiming at and the drawer correctly
refuses to drag from a control. Symptom to recognise: the gesture does nothing at all, no drag
and no scroll. Before concluding anything, have the page report the target it actually got
(the probe's `D` field pattern) rather than trusting the coordinate you sent.

Derive the offset per run rather than hardcoding 62: take a screenshot, find a known element,
and compare against its `getBoundingClientRect()` from the probe.

## 6. Read screen coordinates, not layout coordinates

The whole iOS keyboard failure is **the layout viewport moving under a page that is trying to stand
still**. `getBoundingClientRect().y` is measured against the layout viewport, so it moves with it
and tells you nothing on its own. Always compute:

    screenY = rect.y - visualViewport.offsetTop

## 7. The DOM can report a state that was never painted

Measured this round: during a real keyboard rise there is a ~32 ms window (3 samples) where
`offsetTop` and `body.style.top` disagree by up to 336 px — and **no frame was ever composited in
that state**; the compensation lands inside the same frame. If you assert on the DOM alone you will
report a bug that does not exist. If you assert only on settled values you will miss one that does.

Ask the pixels. Align the band above the sheet against a reference frame and find the vertical
shift that best fits; a page that stands still scores 0 on every frame. Watch the alignment
**error** too — a large error means the picture is genuinely different (the sheet has covered the
band), not that it shifted, and reading that as a shift is the easiest way to invent a regression.

## 8. Hit-test tap targets; do not measure their boxes

`.ag-pill` is a 30 px box and a **44 px target** — `::before` at `height: var(--tap)` does the
work. Same for `.pl-head .chip` (32 / 44). Walk outward from the centre with
`document.elementFromPoint` until it stops returning the control. A `getBoundingClientRect` sweep
will hand you twenty §8 violations that are not real.

## And the thing that made all five look unfixed

Check what is actually deployed before believing anything:

    curl -s https://wegoplace.com/sw.js | grep 'const VERSION'

If that VERSION is behind the repo, the fixes are not on his phone and no amount of local green
changes that.

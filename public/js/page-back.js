// THE ONE BACK, ON A PAGE OF ITS OWN (21 Nov: the pages reached from More, People and settings, Your account, Your trips,
// Privacy and the Terms, could only be left with a swipe). The same Back the app's screens have (index.html's dock:
// .dock .backbtn, the same words and the same look), at the foot of the page:
//   * it goes back when the page was opened from somewhere on this site, as a phone's own Back would;
//   * otherwise to the page's own place: a trip's people to that trip's More, Your account to Your trips, the rest to
//     the start (Your trips, opened as the start, shows no Back: there is nowhere to go back to).
// The page keeps room at its foot so the Back never sits on its last row.

const here = location.pathname;
// Signing in and joining are ways IN, not places to go back to: Your trips reached from them is the start (21 Nov: the
// Back stood over "Make the trip" on the first screen after signing up, and led to the sign-in page).
const WAYS_IN = /^\/(login|join|signin|s\/)/;
const sameSite = (() => { try { const r = new URL(document.referrer); return !!document.referrer && r.origin === location.origin && r.pathname !== here && !WAYS_IN.test(r.pathname); } catch { return false; } })();
const people = /^\/trips\/([^/]+)\/?$/.exec(here);
const home = /^\/trips\/?$/.test(here);
const fallback = people ? `/t/${people[1]}/#/settings` : here.startsWith("/account") ? "/trips" : "/";

if (sameSite || !home) {
  const dock = document.createElement("div");
  dock.className = "dock page-dock";
  dock.innerHTML = '<button class="backbtn" type="button" data-page-back aria-label="' + (!sameSite && people ? "Back to the trip" : "Back") + '">'
    + '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5-7 6.5 7 6.5"/></svg><span>Back</span></button>';
  dock.querySelector("button").addEventListener("click", () => {
    if (sameSite && history.length > 1) history.back();
    else location.assign(fallback);
  });
  document.body.append(dock);
  document.body.dataset.pageDock = "1";
}

// The page a join link opens (/join/<code>): it says what the link is for, and puts someone on
// the trip.
//
// What it asks the server (src/trips/links.js):
//   GET  /api/join/<code>            -> { trip: { name, starts_on, ends_on }, host: { name } }   anyone
//   POST /api/join/<code>            -> { trip, joined, rev }                    signed in
//   POST /api/join/<code> { name }   -> { trip, joined, rev, guest: true }       signed out: a guest
// A link that has run out, been used up or been turned off answers 404 "no such link", the same
// as a code that never existed, so this page has one screen for all of them.
//
// Signed out, a name is all it asks: joining makes a guest, someone on the trip whose way back in
// is this browser's session (js/guest.js says so once they are in). "Already have an account?
// Sign in" goes to /login?next=/join/<code>, which sends them back here once they are in.

import {
  AuthError, afterLeaving, api, askTwice, busyState, cleanName, leavingWords, me, messages, paintWordmark, serverError, signOut, siteConfig, tripDates,
} from "./auth.js";
import { guestJoined, paintHere } from "./guest.js";

const $ = (id) => document.getElementById(id);
const busy = busyState();
const msg = messages($("msg"), $("detail"));

// A code is 16 random bytes, url-safe: 22 characters. Anything else isn't a link.
const code = location.pathname.match(/^\/join\/([A-Za-z0-9_-]{22})\/?$/)?.[1] ?? null;
const here = `/join/${code}`;
const signInHere = `/login?next=${encodeURIComponent(here)}`;

function show(which) {
  for (const p of ["trip", "gone", "failed"]) $("p-" + p).hidden = p !== which;
}
function failed(error) {
  $("failed-text").textContent = error instanceof AuthError ? error.message : "Something went wrong. Try again in a moment.";
  show("failed");
}

/** One action at a time: the button waits with a spinner, and what went wrong is said above. */
async function run(btn, waiting, action) {
  if (busy.on) return;
  msg.clear();
  busy.start(btn, waiting);
  try {
    await action();
  } catch (e) {
    busy.stop(btn);
    msg.fail(e);
  }
}

/** Into the app at this trip, or what went wrong, for an answer to POST /api/join/<code>. */
function joined(btn, { status, body }) {
  // On the trip now, or already was: into the app, at this trip (the phone may keep no trip yet,
  // and "/" would go to Your trips). replace, not assign: Back from the app must not land on a
  // link that has done its work.
  if (status === 200) {
    // Said once, when this join made them part of the trip (not on opening a trip's link again).
    if (body?.guest && body?.joined) guestJoined();
    location.replace(body?.trip?.id ? `/t/${encodeURIComponent(body.trip.id)}/` : "/");
    return;
  }
  // Signed out underneath this page.
  if (status === 401) { location.replace(signInHere); return; }
  // The link ended between this page opening and the button.
  if (status === 404) { busy.stop(btn); show("gone"); return; }
  if (status === 409 && body.error === "trip is full") {
    throw new AuthError("full", `This trip has as many people on it as a trip can hold (${body.max}). Someone has to leave it before you can join.`, `trip is full · HTTP 409`);
  }
  if (status === 503 && body.error === "signups paused") {
    throw new AuthError("paused", "Joining without an account is paused for now. If you have an account, sign in and join with it.", `signups paused · HTTP 503`);
  }
  if (status === 429) {
    throw new AuthError("busy", "Too many people have joined from this connection or by this link in the last hour. Wait a while, then try again.", `${body.error || "too many"} · HTTP 429`);
  }
  throw serverError(body, status);
}

$("btn-join").addEventListener("click", (e) => run(e.currentTarget, "Joining…", async () => {
  joined($("btn-join"), await api("POST", `/api/join/${code}`, {}));
}));

// Signed out: by name. The name is checked here as the server checks it (auth.js cleanName), so
// a blank one is said at once, under the field's own words.
$("form-guest").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = cleanName($("guest-name").value);
  if (!name) { msg.say("Type your name, up to 40 characters. It's what the people on this trip will see.", "err"); $("guest-name").focus(); return; }
  run($("btn-guest"), "Joining…", async () => {
    joined($("btn-guest"), await api("POST", `/api/join/${code}`, { name }));
  });
});

// Someone else's device, or the wrong one of two accounts: sign out here (which clears this
// phone, auth.js) and come back as whoever they sign in as. Changes made here that haven't been
// sent would go with it, so then it asks first and says how many.
// A guest's way back in is this browser alone, so for them it always asks, and says what goes.
let guest = false;
askTwice($("btn-other"), leavingWords("Tap again to use a different account", { always: false, guest: () => guest }), (btn) => run(btn, "Signing out…", async () => {
  location.replace(afterLeaving(await signOut(), "", signInHere));
}));

async function start() {
  const mark = paintWordmark($("brand"));
  try {
    if (!code) { show("gone"); return; }
    $("go-signin").href = signInHere;
    const [view, user, site] = await Promise.all([api("GET", `/api/join/${code}`), me(), siteConfig()]);
    if (view.status === 404) { show("gone"); return; }
    if (view.status !== 200) throw serverError(view.body, view.status);

    const { trip, host } = view.body;
    document.title = `Join ${trip.name} · WeGoPlace`;
    $("trip-name").textContent = trip.name;
    $("trip-when").textContent = tripDates(trip.starts_on, trip.ends_on) || "Dates not set yet";
    $("trip-host").textContent = host?.name ? `Hosted by ${host.name}` : "";
    $("trip-host").hidden = !host?.name;
    guest = !!user?.guest;
    $("me-name").textContent = user?.name ?? "";
    $("me-guest").hidden = !guest;
    paintHere($("me-guest"));
    $("as-account").hidden = !user;
    $("as-visitor").hidden = !!user;
    // While new accounts are paused, so are guests (the server refuses them): only signing in.
    const paused = site.signups === "paused";
    $("form-guest").hidden = paused;
    $("guest-paused").hidden = !paused;
    show("trip");
  } catch (e) {
    failed(e);
  } finally {
    // Now the page is what it will stay (css/account.css: it shows itself after four seconds
    // regardless).
    await mark;
    $("page").removeAttribute("data-wait");
  }
}

start();

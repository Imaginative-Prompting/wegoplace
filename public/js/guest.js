// A guest: someone who joined a trip by its link with only a name. They have no way to sign in
// but this browser's session, so the app says so, in one sentence, in three places: once in
// the app right after they join (the shell holds it until it is tapped), on the account page for
// as long as they are a guest (with the ways to become an account under it), and in the warning
// before a guest signs out.
//
// No imports: the shell, the join page and the account page each load this alone.

/**
 * The ways in this site offers, named, for a sentence: a passkey always, then Google and GitHub each only
 * where this site has it set up. `providers` is /api/auth/config's (or /api/auth/ways').
 */
export function waysIn(providers = {}) {
  const names = ["a passkey", ...(providers?.google ? ["Google"] : []), ...(providers?.github ? ["GitHub"] : [])];
  return names.length < 3 ? names.join(" or ") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/**
 * Is this a phone? A screen under 600 px on its short side, in either orientation (a 1024 by 600 netbook is not one): the device's screen, not the
 * window (a desktop's window narrowed to a phone's width is still a desktop). Anywhere else (a desktop, a tablet) a
 * guest's place is named "this browser": it is that browser's session, and "this phone" on a desktop reads untrue.
 * With no screen (a check in Node) the phone's words.
 */
export function onPhone() {
  if (typeof screen === "undefined" || !screen.width) return true;
  return Math.min(screen.width, screen.height) < 600;
}

/** Where a guest's place is, in words: "this phone", or "this browser" off a phone. */
export const placeWord = (phone = onPhone()) => (phone ? "this phone" : "this browser");

/** Every [data-here] under `root` says where the place is (a page's own words, written as "this phone"). */
export function paintHere(root = document) {
  for (const n of root.querySelectorAll("[data-here]")) n.textContent = placeWord();
}

/** What a guest is told, everywhere it is said, naming only the ways in this site has. */
export const guestLine = (providers, phone = onPhone()) =>
  `You're a guest on ${placeWord(phone)}. Add ${waysIn(providers)} ` +
  (phone ? "to use another phone or keep your place." : "to use another device or keep your place.");

/** The empty Itinerary's and Places' line about AI apps, for a guest, who can't connect one. */
export const GUEST_AI_LINE = "Anyone on the trip with an account can connect an AI app to fill it in.";

/** Said before a guest signs out (askTwice's second ask). */
export const GUEST_LEAVING = "You're a guest: signing out loses your place. Tap again to sign out";

// Set by the join page as a guest joins, taken away when the shell's message is tapped. A "wgp."
// key, so signing out (js/forget.js) clears it with everything else of the person's.
const NOTE_KEY = "wgp.guestNote";

/** The join page: a guest has just joined, so the app says guestLine once. */
export function guestJoined() {
  try { localStorage.setItem(NOTE_KEY, "1"); } catch { /* private mode: the account page still says it */ }
}

/** The shell: is guestLine still to be said? */
export function guestNoteDue() {
  try { return localStorage.getItem(NOTE_KEY) === "1"; } catch { return false; }
}

/** The shell, once the message has been tapped away. */
export function guestNoteSeen() {
  try { localStorage.removeItem(NOTE_KEY); } catch { /* it is said again next time, which is no harm */ }
}

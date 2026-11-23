// What the two pages outside a trip share: "Your trips" (/trips, js/trips.js) and a trip's
// people and settings (/trips/<id>, js/trip-people.js). They stand outside the app, like the
// account page, and are drawn with the same kit (styles.css, css/account.css) and css/trips.css.
//
// Here: making elements and icons, asking the server and saying its refusals in words, the
// list of trips kept on the phone so /trips opens with no signal, and the few words both say.

import { AuthError, api, tripDates } from "./auth.js";
import { ownerVerdict, sessionAccount } from "./forget.js";
import {
  INTERESTS_MAX, LINKS_LIVE_MAX, LINK_DAYS_MAX, LINK_USES_MAX, TRIP_CURRENCIES_MAX, TRIP_MEMBERS_MAX, TRIP_NAME_MAX, TRIPS_HOSTED_MAX,
} from "./shared/limits.js";

export const $ = (id) => document.getElementById(id);

const SVG = "http://www.w3.org/2000/svg";
const ICONS = {
  trip: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.4"/>',
  host: '<path d="M6 21V4M6 5h11l-2.2 3.5L17 12H6"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.4-3.8 4.4-5.8 8-5.8s6.6 2 8 5.8"/>',
  people: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 19.5c1-3.2 3.5-5 6.5-5s5.5 1.8 6.5 5"/><path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.8c2 .7 3.4 2.3 4 4.7"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  share: '<path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  storage: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
  upload: '<path d="M12 16V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  bin: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7M10 11v5M14 11v5"/>',
  leave: '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9"/>',
  offline: '<path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4.2-2.5M14.8 10.5A10 10 0 0 1 19 13M2 9.5a15 15 0 0 1 4.5-2.8M11 6a15 15 0 0 1 11 3.5"/><circle cx="12" cy="20" r=".6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  cross: '<path d="M6 6l12 12M18 6 6 18"/>',
  warn: '<path d="M12 4.5 2.8 20h18.4L12 4.5Z"/><path d="M12 10v4M12 17v.4"/>',
  // A speech bubble, as the Chat tab draws it.
  chat: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5v-8Z"/><path d="M8 8.8h8M8 12.2h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2.1 1.2M17.7 15.3l2.1 1.2M4.2 16.5l2.1-1.2M17.7 8.7l2.1-1.2"/>',
};

export function icon(name, cls) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  svg.innerHTML = ICONS[name];
  return svg;
}

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A pill with an icon and words: the words say it, the tint never alone. */
export function pill(iconName, words, cls = "") {
  const tag = el("span", `pill${cls ? ` ${cls}` : ""}`);
  tag.append(icon(iconName), words);
  return tag;
}

/** A button of the kit, with data-act so the page's busy state switches it off while something runs. */
export function button(words, { cls = "btn", iconName = null, label = null, net = true } = {}) {
  const btn = el("button", cls);
  btn.type = "button";
  btn.setAttribute("data-act", "");
  if (net) btn.setAttribute("data-net", "");
  if (iconName) btn.append(icon(iconName, "ac-ico"));
  btn.append(el("span", "", words));
  btn.lastChild.setAttribute("data-words", "");
  if (label) btn.setAttribute("aria-label", label);
  return btn;
}

export const datesOf = (t) => tripDates(t.starts_on, t.ends_on) || "Dates not set yet";
export const day = (seconds) => new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
export const when = (seconds) => new Date(seconds * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
export const peopleWords = (n) => (n === 1 ? "only you on it" : `${n} people on it`);
export const listWords = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

// ── asking the server ──────────────────────────────────────────────────────────────────

/** What the server said no to, in words for the person. `code` is the server's own error. */
export class Refused extends Error {
  constructor(code, message, status, body) {
    super(message);
    this.code = code;
    this.status = status;
    this.body = body;
    this.detail = `${code || "no reason given"} · HTTP ${status}`;
  }
}

// The server's refusals that the pages put in their own words. Where the server already wrote
// a sentence for a person (`reason`, starting with a capital), that is what is shown.
const WORDS = {
  "too many trips": () => `You host ${TRIPS_HOSTED_MAX} trips, the most one account can. Delete one, or offer one to someone on it, first.`,
  "bad name": () => `A trip's name is 1 to ${TRIP_NAME_MAX} characters.`,
  "bad dates": () => "Give both dates, the first on or before the last, or neither if they aren't known yet.",
  "bad default_tz": () => "Choose the trip's time zone from the list.",
  "bad currencies": () => `A trip has at most ${TRIP_CURRENCIES_MAX} currencies.`,
  "bad interests": () => `What the group cares about is at most ${INTERESTS_MAX.toLocaleString()} characters.`,
  "nothing to patch": () => "Nothing has changed.",
  "no offer": () => "That offer isn't there any more: the host took it back, or offered the trip to someone else.",
  "no such member": () => "That person isn't on the trip any more.",
  "the host can't leave": () => "You host this trip, so you can't leave it. Offer it to someone on it, and leave once they accept; or delete it.",
  "too many links": () => `A trip can have ${LINKS_LIVE_MAX} links working at once. Take one back first.`,
  "bad days": () => `A link lasts 1 to ${LINK_DAYS_MAX} days.`,
  "bad uses": () => `A link brings 1 to ${LINK_USES_MAX} people.`,
  "trip is full": () => `This trip has ${TRIP_MEMBERS_MAX} people on it, the most a trip can.`,
  "forbidden": () => "Only the trip's host can do that.",
  "no such trip": () => "This trip isn't one of yours any more, or it was deleted.",
  "too many": () => "Too many tries from this connection. Wait a minute, then try again.",
  "guest": () => "A guest can't do that. Add a way to sign in on your account first, and you can.",
  "not a guest": () => "They have an account now, so they sign in with it: no link is needed.",
  "on another trip": () => "They're also on a trip you don't host, so a link from you can't sign them in. They can rejoin that trip by its own link, or add a passkey on the phone they still have.",
};

/**
 * Asks the server. Answers the body of a 2xx. A 401 sends the page to sign in, and throws so
 * the caller stops; anything else throws a Refused in words, or the AuthError "offline" when
 * nothing got through.
 */
export async function ask(method, path, body) {
  const r = await api(method, path, body);
  if (r.status >= 200 && r.status <= 299) return r.body;
  const code = String(r.body?.error || "");
  if (r.status === 401) {
    // The whole address back, its query and its #: a link to add the cover (?photo=add#cover) comes
    // back to the same place after signing in.
    location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}&error=signed-out`);
    throw new Refused("signed out", "This browser isn't signed in any more.", 401, r.body);
  }
  const reason = typeof r.body?.reason === "string" && /^[A-Z“"]/.test(r.body.reason) ? r.body.reason : "";
  const words = reason || WORDS[code]?.(r.body) || (r.status >= 500 ? "The server couldn't do that just now. Try again in a moment." : "The server refused that. Reload the page and try again.");
  throw new Refused(code, words, r.status, r.body);
}

export const isOffline = (e) => e instanceof AuthError && e.code === "offline";

/**
 * A message box (css/account.css .lg-msg) that says a Refused or an AuthError in its own words,
 * keeping the server's code for the folded detail.
 */
export function sayer(box, detail) {
  const marks = { info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.4"/>', err: ICONS.warn, ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.8 2.8L16.4 9"/>' };
  const say = (words, kind = "info", tail = "") => {
    box.querySelector("svg").innerHTML = marks[kind] || marks.info;
    box.querySelector("span").textContent = words;
    box.className = "lg-msg" + (kind === "err" ? " lg-msg-err" : kind === "ok" ? " lg-msg-ok" : "");
    box.hidden = false;
    if (detail) { detail.textContent = tail; detail.hidden = !tail; }
    box.scrollIntoView?.({ block: "nearest" });
  };
  return {
    say,
    fail(e) {
      if (isOffline(e)) say("No connection. This needs one: try again when you have signal.", "err");
      else if (e instanceof Refused || e instanceof AuthError) say(e.message, "err", e.detail || "");
      else { say("Something went wrong. Try again.", "err", String(e?.message || e)); console.error("[trips]", e); }
    },
    clear() { box.hidden = true; if (detail) detail.hidden = true; },
  };
}

// ── the list kept on the phone ─────────────────────────────────────────────────────────
// /trips opens with no signal: the last list the server gave, under a "wgp." key, so signing
// out or deleting the account takes it away with everything else (forget.js clears every
// "wgp." key but the phone's own). It carries whose list it is, and a page signed in as
// someone else never draws it.
const KEPT = "wgp.trips";

export function keepTrips(userId, trips, storage) {
  try { localStorage.setItem(KEPT, JSON.stringify({ who: userId, at: Date.now(), trips, storage: storage ?? null })); } catch { /* a full or private store: the page still works online */ }
}

/** The list last kept, when it is this session's account's (or nobody has said whose yet). */
export function keptTrips() {
  let kept = null;
  try { kept = JSON.parse(localStorage.getItem(KEPT) || "null"); } catch { kept = null; }
  if (!kept || !Array.isArray(kept.trips)) return null;
  return ownerVerdict(kept.who, sessionAccount()) === "other" ? null : kept;
}

// ── a trip's address in the app ────────────────────────────────────────────────────────
export const appUrl = (id) => `/t/${encodeURIComponent(id)}/`;
export const peopleUrl = (id) => `/trips/${encodeURIComponent(id)}`;

// ── time zones and currencies, for the forms ───────────────────────────────────────────
// The time zone's control is its own module, which the app loads too; these pages keep their names.
export { phoneZone, zoneLabel, zonePicker, zones } from "./zone-picker.js";
export function currencyCodes() {
  try { return Intl.supportedValuesOf("currency"); } catch { return ["EUR", "USD", "GBP"]; }
}
const currencyNames = (() => { try { return new Intl.DisplayNames(undefined, { type: "currency" }); } catch { return null; } })();
export const currencyName = (code) => { try { return currencyNames?.of(code) || code; } catch { return code; } };

/**
 * The currencies control: chips in order, the first the trip's main one, each with a button to
 * take it off; a select to add one. Answers { get(), set(codes) }.
 */
export function currencyPicker(chipsBox, addSelect, onChange = () => {}) {
  let codes = [];
  // A currency the page guessed rather than one the person chose: its chip says "guess", with a
  // dashed edge, and a sentence under the chips says where the guess came from. It stays a guess
  // until it is taken off.
  let guess = null;
  const paint = () => {
    chipsBox.replaceChildren(...codes.map((code, i) => {
      const chip = el("span", "tr-cur");
      chip.append(el("span", "tr-cur-code", code), el("span", "tr-cur-name", currencyName(code)));
      if (guess && guess.code === code) { chip.dataset.guess = ""; chip.append(el("span", "tr-cur-main", "guess")); }
      else if (i === 0) chip.append(el("span", "tr-cur-main", "main"));
      const off = el("button", "tr-cur-off");
      off.type = "button";
      off.setAttribute("aria-label", `Take ${currencyName(code)} off`);
      off.append(icon("cross"));
      off.addEventListener("click", () => {
        codes = codes.filter((c) => c !== code);
        if (guess && guess.code === code) guess = null;
        paint(); onChange();
      });
      chip.append(off);
      return chip;
    }), ...(guess ? [el("p", "meta tr-cur-why", guess.words)] : []));
    chipsBox.hidden = !codes.length;
    addSelect.disabled = codes.length >= TRIP_CURRENCIES_MAX;
  };
  const first = el("option", "", "Add a currency…");
  first.value = "";
  addSelect.replaceChildren(first, ...currencyCodes().map((c) => { const o = el("option", "", `${c} · ${currencyName(c)}`); o.value = c; return o; }));
  addSelect.addEventListener("change", () => {
    const code = addSelect.value;
    addSelect.value = "";
    if (code && !codes.includes(code) && codes.length < TRIP_CURRENCIES_MAX) { codes.push(code); paint(); onChange(); }
  });
  paint();
  return {
    get: () => [...codes],
    set: (list) => { codes = [...(list || [])]; guess = null; paint(); },
    /** Offers one currency as a guess, `words` saying where it came from; `rest` follow it, as they are. */
    guess: (code, words, rest = []) => { codes = [code, ...rest.filter((c) => c !== code)]; guess = { code, words }; paint(); },
    guessed: () => (guess ? guess.code : null),
  };
}

/**
 * Reads a pair of date fields as the server takes them: both or neither. Answers { starts_on,
 * ends_on } or { bad: words }.
 */
export function readDateFields(from, to) {
  const a = from.value, b = to.value;
  if (!a && !b) return { starts_on: null, ends_on: null };
  if (!a || !b) return { bad: "Give both dates, or neither if they aren't known yet." };
  if (a > b) return { bad: "The trip can't end before it starts." };
  return { starts_on: a, ends_on: b };
}

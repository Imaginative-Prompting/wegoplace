// Your trips (/trips, public/trips.html): every trip this account is on, a way to make one, a
// trip offered to this account to host, and, for a host, what their trips hold.
//
// The routes it uses (docs/API.md):
//   GET  /api/me, GET /api/trips (each trip with its host, how many people, offered_to_me)
//   POST /api/trips { id, name, default_tz, starts_on?, ends_on?, currencies? }
//   PUT  /api/trips/<id>/areas { areas: [{ id, name, west, south, east, north }] }  (where a new trip is)
//   POST /api/trips/<id>/host/accept, POST /api/trips/<id>/host/decline
//   GET  /api/account/storage, DELETE /api/trips/<trip>/media/object?key=  (an upload under way)
//
// It opens with no signal: the list it last got is kept on the phone (js/trip-kit.js) and drawn
// with words saying what needs a connection. A trip opens in the app at /t/<id>/; its people and
// settings are /trips/<id>.

import { askTwice, busyState, me, paintWordmark } from "./auth.js";
import { paintHere } from "./guest.js";
import { formatBytes } from "./shared/bytes.js";
import { lastReadOf } from "./chat-read.js";
import { currencyOfRegion, guessHomeCurrency, regionOfZone } from "./shared/home-currency.js";
import {
  $, Refused, appUrl, ask, button, currencyName, currencyPicker, datesOf, el, icon, isOffline, keepTrips, keptTrips,
  peopleUrl, peopleWords, phoneZone, pill, readDateFields, sayer, when, zonePicker,
} from "./trip-kit.js";
import { areaOf, dayWhen, placeWords, zoneWords } from "./city-search.js";

const busy = busyState();
const detail = $("detail");
const said = Object.fromEntries(["arrived", "msg-list", "msg-make", "msg-storage"].map((id) => [id, sayer($(id), detail)]));
const clearAll = () => { for (const m of Object.values(said)) m.clear(); };

let user = null;
let online = true;

/** Everything that needs the server is off while there is no connection; it says so above. */
function netControls() {
  for (const b of document.querySelectorAll("[data-net]")) {
    if (!online) { b.disabled = true; b.setAttribute("aria-disabled", "true"); }
    else if (!busy.on) { b.disabled = false; b.removeAttribute("aria-disabled"); }
  }
  for (const f of document.querySelectorAll("#form-make input, #form-make select")) f.disabled = !online;
}

/** One action at a time: the button waits with a spinner, and what went wrong lands beside it. */
async function run(btn, waiting, where, action) {
  if (busy.on || !online) return;
  clearAll();
  busy.start(btn, waiting);
  try {
    await action();
  } catch (e) {
    if (e instanceof Refused && e.status === 401) return;     // on its way to sign in
    if (isOffline(e)) goneOffline();
    said[where].fail(e);
  } finally {
    busy.stop(btn);
    netControls();
  }
}

// ── the trips ──────────────────────────────────────────────────────────────────────────

function tripRow(t) {
  const row = el("div", "ac-way tr-trip");
  // Its cover picture where it has one (set in the app, by link, or by an AI app), else the trip's mark.
  if (t.cover && typeof t.cover.url === "string" && t.cover.url.startsWith("/media/")) {
    const img = el("img", "tr-cover");
    img.src = t.cover.url;
    img.alt = "";
    img.width = 44; img.height = 44;
    img.decoding = "async";
    // With no signal a cover this phone hasn't kept can't load: the trip's mark, never a broken picture.
    img.addEventListener("error", () => img.replaceWith(icon("trip", "ac-ico")), { once: true });
    row.append(img);
  } else row.append(icon("trip", "ac-ico"));
  const main = el("div", "ac-way-main");
  const head = el("div", "ac-way-title");
  const name = el("a", "tr-trip-name", t.name);
  name.href = appUrl(t.id);
  head.append(name);
  if (t.role === "host") head.append(pill("host", "You host it"));
  // Someone else wrote in its chat since this person last read it on this phone: a pill with its
  // words, which opens the trip's chat. Not drawn before the person is known (the kept list, offline).
  if (user && (t.chat?.from_others ?? 0) > lastReadOf(t.id, user.id)) {
    const fresh = el("a", "pill pill-accent tr-new");
    fresh.href = `${appUrl(t.id)}#/chat`;
    fresh.append(icon("chat"), "New messages");
    fresh.setAttribute("aria-label", `New messages in ${t.name}'s chat`);
    head.append(fresh);
  }
  main.append(head);
  const who = t.role === "host" ? "" : ` · hosted by ${t.host?.name || "someone who left"}`;
  main.append(el("span", "meta", `${datesOf(t)} · ${peopleWords(t.members)}${who}`));
  if (t.offered_to_me) main.append(el("span", "meta tr-strong", "Offered to you to host: see above."));
  row.append(main);
  const more = el("a", "ds-button ds-button--gray ds-button--sm tr-row-btn");
  more.href = peopleUrl(t.id);
  more.append(icon("people", "ac-ico"), el("span", "", "People and settings"));
  more.setAttribute("aria-label", `People and settings of ${t.name}`);
  row.append(more);
  return row;
}

function paintList(trips) {
  $("list").replaceChildren(...trips.map(tripRow));
  $("list").hidden = !trips.length;
  $("none").hidden = !!trips.length;
  paintMake(trips.length);
}

// MAKE A TRIP, CLOSED UNTIL ASKED FOR, once there are trips to look at: the list is what this page is for then. With no
// trip yet, making one is the thing to do, so the form is open. Opened, it stays open (a repaint doesn't fold it away).
let makeAsked = false;
function paintMake(count) {
  if (user && user.guest) return;
  const shut = count > 0 && !makeAsked;
  $("make-open").hidden = !shut;
  $("form-make").hidden = shut;
  // Closed, the button says it: the section's heading would only say it again above it (kept for the section's name).
  $("make-title").classList.toggle("sr-only", shut);
  $("make-open").setAttribute("aria-expanded", String(!shut));
}
$("make-open").addEventListener("click", () => {
  makeAsked = true;
  paintMake(1);
  $("make-name").focus();
});

// ── offers to host ─────────────────────────────────────────────────────────────────────
// What hosting means is said before anyone says yes: the trip's storage becomes theirs, and
// while others are on it they can't leave it or delete their account.

function offerCard(t) {
  const card = el("section", "card ac-card tr-offer");
  card.setAttribute("aria-label", `An offer to host ${t.name}`);
  const head = el("div", "tr-offer-head");
  head.append(icon("host", "ac-ico"), el("h2", "h3", `${t.host?.name || "The host"} offered you “${t.name}” to host`));
  card.append(head, el("p", "meta", `${datesOf(t)} · ${peopleWords(t.members).replace("only you on it", "one person on it")} · offered ${when(t.offered_to_me.offered_at)}`));
  const list = el("div", "ac-list");
  for (const [mark, words] of [
    ["storage", "Its photos, videos and shared boards count against your storage, not theirs."],
    ["leave", "While other people are on it, you can't leave it or delete your account: you'd offer it on to someone, or delete it."],
    ["people", "Only the host removes people, revokes links and deletes the trip."],
  ]) {
    const line = el("p", "ac-list-row");
    line.append(icon(mark, "ac-ico"), el("span", "", words));
    list.append(line);
  }
  card.append(list);
  const box = el("p", "lg-msg");
  box.hidden = true;
  box.setAttribute("role", "status");
  box.setAttribute("aria-live", "polite");
  box.append(document.createElementNS("http://www.w3.org/2000/svg", "svg"), el("span"));
  box.firstChild.setAttribute("viewBox", "0 0 24 24");
  box.firstChild.setAttribute("aria-hidden", "true");
  const say = sayer(box, detail);
  const actions = el("div", "ac-actions");
  const yes = button("Accept: I'll host it", { cls: "ds-button ds-button--white", iconName: "check" });
  const no = button("Decline", { cls: "ds-button ds-button--gray", iconName: "cross" });
  const act = (btn, waiting, path, done) => async () => {
    if (busy.on || !online) return;
    clearAll(); say.clear();
    busy.start(btn, waiting);
    try {
      await ask("POST", `/api/trips/${encodeURIComponent(t.id)}/host/${path}`, {});
      busy.stop(btn);
      await load();
      said["msg-list"].say(done, "ok");
    } catch (e) {
      busy.stop(btn);
      if (e instanceof Refused && e.status === 401) return;
      if (isOffline(e)) goneOffline();
      say.fail(e);
      // The offer may have ended in the meantime: the list says what is true now.
      if (e instanceof Refused && e.code === "no offer") await load().catch(() => {});
    } finally {
      netControls();
    }
  };
  yes.addEventListener("click", act(yes, "Accepting…", "accept", `You host “${t.name}” now.`));
  no.addEventListener("click", act(no, "Declining…", "decline", `Declined. ${t.host?.name || "The host"} still hosts “${t.name}”.`));
  actions.append(yes, no);
  card.append(actions, box);
  return card;
}

function paintOffers(trips) {
  const offered = trips.filter((t) => t.offered_to_me);
  $("offers").replaceChildren(...offered.map(offerCard));
  $("offers").hidden = !offered.length;
}

// ── storage, for a host ────────────────────────────────────────────────────────────────

function paintStorage(meter) {
  if (!meter || !meter.trips?.length) { $("storage").hidden = true; return; }
  const share = meter.limit ? Math.min(1, meter.used / meter.limit) : 0;
  const box = $("meter");
  const words = el("p", "tr-meter-words");
  words.append(el("span", "strong", formatBytes(meter.used)), ` of ${formatBytes(meter.limit)} used`);
  const left = Math.max(0, meter.limit - meter.used);
  const note = el("p", "meta", share >= 0.9 ? `Nearly full: ${formatBytes(left)} left.` : `${formatBytes(left)} left, across the trips you host.`);
  if (share >= 0.9) note.prepend(icon("warn", "tr-inline-ico"));
  const bar = el("div", "tr-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `${Math.round(share * 100)} percent used`);
  const fill = el("span", "tr-bar-fill");
  fill.style.width = `${(share * 100).toFixed(1)}%`;
  bar.append(fill);
  box.replaceChildren(words, bar, note);

  $("storage-trips").replaceChildren(...meter.trips.map((t) => {
    const row = el("div", "ac-way");
    row.append(icon("trip", "ac-ico"));
    const main = el("div", "ac-way-main");
    // Its files, and of them the pictures and receipts (each a count and how much).
    const parts = [formatBytes(t.bytes), t.files === 1 ? "1 file" : `${t.files} files`];
    if (t.pictures?.count) parts.push(`${t.pictures.count === 1 ? "1 picture" : `${t.pictures.count} pictures`} (${formatBytes(t.pictures.bytes)})`);
    if (t.receipts?.count) parts.push(`${t.receipts.count === 1 ? "1 receipt" : `${t.receipts.count} receipts`} (${formatBytes(t.receipts.bytes)})`);
    // Pictures an AI's change replaced or removed, kept so the change can be undone (30 days).
    if (t.held?.count) parts.push(`${t.held.count === 1 ? "1 picture" : `${t.held.count} pictures`} kept for undo (${formatBytes(t.held.bytes)})`);
    main.append(el("span", "ac-way-label tr-strong", t.name), el("span", "meta", parts.join(" · ")));
    row.append(main);
    return row;
  }));

  const ups = meter.reservations || [];
  $("uploads").hidden = !ups.length;
  $("upload-list").replaceChildren(...ups.map((r) => {
    const row = el("div", "ac-way");
    row.append(icon("upload", "ac-ico"));
    const main = el("div", "ac-way-main");
    main.append(el("span", "ac-way-label", `${formatBytes(r.bytes)} by ${r.user_name || "someone who left"}`),
      el("span", "meta", `On “${r.trip_name}” · since ${when(r.since)}`));
    row.append(main);
    const cancel = button("Cancel", { cls: "ds-button ds-button--gray ds-button--sm", label: `Cancel the upload of ${formatBytes(r.bytes)} by ${r.user_name || "someone"}` });
    askTwice(cancel, "Tap again to cancel it", (btn) => run(btn, "Cancelling…", "msg-storage", async () => {
      await ask("DELETE", `/api/trips/${encodeURIComponent(r.trip_id)}/media/object?key=${encodeURIComponent(r.key)}`);
      await load();
      said["msg-storage"].say(`Cancelled. ${formatBytes(r.bytes)} is free again.`, "ok");
    }), { destroys: true });
    row.append(cancel);
    return row;
  }));
  $("storage").hidden = false;
}

// ── making a trip ──────────────────────────────────────────────────────────────────────

// WHERE THE TRIP IS. One answer, a town ("Kyoto"), gives the trip its time zone and its first
// area, which is what the trip's map is made around. The zone is said under it and can be
// changed there; until a place is named it is the phone's own. A country names a zone and no
// area; the trip's Map then says how to give it one.
const firstDay = () => $("make-from").value;
const dayOf = () => dayWhen(firstDay());
let zoneFrom = "phone";             // who chose the zone: the phone, the place, or the person
// ONE QUIET LINE for what Where set: the zone and the money, never two more things to fill in. Both are changed in the
// trip's details (People and settings) once it is made.
function sayZone() {
  const z = zone.get();
  const row = where.row();
  const words = zoneWords(z, dayOf());
  const money = (currencies && currencies.get()) || [];
  const cash = money.length ? money.map(currencyName).join(" and ") : "";
  const on = `On ${words}${zoneFrom === "phone" ? " (your phone's)" : ""}${cash ? `, in ${cash}` : ""}.`;
  $("make-zone-said").textContent = `${zoneFrom === "spot" ? "No town is near that spot. " : ""}${on} Change them in the trip's details.`;
  $("make-where-said").textContent = !row ? WHERE_HELP : placeWords(row);
}
const WHERE_HELP = $("make-where-said").textContent;
const zone = zonePicker($("make-tz"), $("make-tz-list"), { at: firstDay, onChange: () => { zoneFrom = "person"; sayZone(); } });
const where = zonePicker($("make-where"), $("make-where-list"), {
  at: firstDay, place: true,
  onChange: (z, row) => {
    zone.set(z);
    zoneFrom = row.kind === "spot" && !row.zoneFound ? "spot" : "place";
    sayZone();
    guessFromWhere(row);
  },
});
zone.set(phoneZone());
$("make-from").addEventListener("change", sayZone);
// Emptied by hand, the place is let go (the zone stays as it is, and is said as chosen), and so is
// the currency it guessed.
$("make-where").addEventListener("input", () => { if (!$("make-where").value.trim() && where.row()) { where.clear(); sayZone(); guessFromWhere(null); } });
// The person's own hand on the currencies (a chip taken off, one added): from then on they are
// theirs, and where the trip goes changes nothing in them.
let curTouched = false;
const currencies = currencyPicker($("make-curs"), $("make-cur"), () => { curTouched = true; sayZone(); });
sayZone();

// THE MONEY OF WHERE THE TRIP GOES (a stranger's walk, 16 Nov: a trip to Porto made on a US phone
// got the dollar, guessed from the phone's region). A town picked in Where makes its country's
// currency the guess, marked as one and saying where it came from: it replaces the phone's guess,
// and leads the account's own home currency (which stays, second). It never touches currencies the
// person chose or took off. Let go of the town, and what was there before comes back.
let before = null;                   // { codes, guessed, words } as the page offered them, before any town
function guessFromWhere(row) {
  if (curTouched) return;
  before ??= { codes: currencies.get(), guessed: currencies.guessed(), words: $("make-curs").querySelector(".tr-cur-why")?.textContent || "" };
  const cc = row && (row.cc || regionOfZone(row.zone));
  const code = cc ? currencyOfRegion(cc) : "";
  if (!code) {
    if (before.guessed) currencies.guess(before.guessed, before.words, before.codes.slice(1));
    else currencies.set(before.codes);
    sayZone();
    return;
  }
  // The town's money is the account's own already (a euro account going to Lisbon): nothing to
  // guess, and the account's main currency stays main.
  if (!before.guessed && before.codes.includes(code)) { currencies.set(before.codes); sayZone(); return; }
  let country = cc;
  try { country = new Intl.DisplayNames(["en"], { type: "region" }).of(cc) || cc; } catch { /* the code, then */ }
  // The account's home currency stays, after it; the phone's guess goes.
  const keep = before.guessed ? before.codes.filter((c) => c !== before.guessed) : before.codes;
  currencies.guess(code, `A guess from where the trip goes (${country}). Take it off if it's wrong.`, keep);
  sayZone();
}

// One trip for one filling-in of the form: the id is made once, so a create sent twice (the
// answer lost on a bad connection) lands on the trip it already made, and a press after the
// trip was made and its area was not sends the area alone.
let making = null;                  // { id, made }
$("form-make").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("make-name").value.trim().replace(/\s+/g, " ");
  if (!name) { clearAll(); said["msg-make"].say("Give the trip a name.", "err"); $("make-name").focus(); return; }
  const dates = readDateFields($("make-from"), $("make-to"));
  if (dates.bad) { clearAll(); said["msg-make"].say(dates.bad, "err"); return; }
  if (!making) making = { id: crypto.randomUUID(), made: false };
  const { id } = making;
  const area = areaOf(where.row());
  run($("btn-make"), "Making it…", "msg-make", async () => {
    if (!making.made) {
      await ask("POST", "/api/trips", { id, name, default_tz: zone.get(), ...dates, currencies: currencies.get() });
      making.made = true;
    }
    // The area goes right behind the trip: the server starts the trip's map from it by itself.
    if (area) await ask("PUT", `/api/trips/${encodeURIComponent(id)}/areas`, { areas: [area] });
    location.assign(appUrl(id));
  });
});

// ── loading, and having no signal ──────────────────────────────────────────────────────

async function load() {
  const [{ trips }, meter] = await Promise.all([
    ask("GET", "/api/trips"),
    ask("GET", "/api/account/storage"),
  ]);
  paintOffers(trips);
  paintList(trips);
  paintStorage(meter);
  keepTrips(user.id, trips, meter.trips.length ? meter : null);
}

function goneOffline() {
  online = false;
  const kept = keptTrips();
  $("offline-text").textContent = kept
    ? `No connection. This is your list of trips from ${when(kept.at / 1000)}. Making a trip, accepting an offer and cancelling an upload need a connection; so do links, handing a trip over and deleting one.`
    : "No connection. Making a trip, links, handing a trip over and deleting one need a connection.";
  $("offline").hidden = false;
  netControls();
}

function drawKept() {
  const kept = keptTrips();
  if (!kept) return false;
  paintOffers(kept.trips);
  paintList(kept.trips);
  paintStorage(kept.storage);
  return true;
}

function arrivedWords(query) {
  if (query.get("done") === "trip-deleted") return ["ok", "The trip is deleted, for everyone who was on it."];
  if (query.get("done") === "left") return ["ok", "You left the trip. What you added stays on it, and a link brings you back."];
  if (query.get("gone") !== null) {
    // The changes still waiting for it when the app left it went with it (the app sends the count).
    const n = /^[1-9]\d{0,5}$/.test(query.get("unsent") ?? "") ? Number(query.get("unsent")) : 0;
    const gone = "That trip isn't one of yours any more, or it was deleted.";
    if (!n) return ["info", gone];
    return ["err", `${gone} ${n === 1 ? "1 change made here hadn't been sent, and went with it." : `${n} changes made here hadn't been sent, and went with it.`}`];
  }
  return null;
}

/** The currency the phone's region uses, offered as a guess that says where it came from. */
function offerGuess() {
  const g = guessHomeCurrency();
  if (!g) return;
  let place = g.region;
  try { place = new Intl.DisplayNames(["en"], { type: "region" }).of(g.region) || g.region; } catch { /* the code, then */ }
  currencies.guess(g.code, `A guess from your phone's ${g.from === "language" ? "region" : "time zone"} (${place}). Take it off if it's wrong.`);
}

async function start() {
  paintWordmark($("brand"));
  const query = new URLSearchParams(location.search);
  const arrived = arrivedWords(query);
  if (query.size) history.replaceState(null, "", "/trips");

  try {
    user = await me();
    if (!user) { location.replace("/login?next=/trips"); return; }
    $("make-guest").hidden = !user.guest;
    paintHere($("make-guest"));
    $("form-make").hidden = !!user.guest;
    // A new trip starts with the person's home currency, so Split has a main one from the start;
    // they can take it off or add others before it. (A trip made with none still works: the
    // app falls back to each person's home currency.) An account that has none yet, a new one,
    // is offered a guess from the phone's region, marked as one (shared/home-currency.js).
    if (!currencies.get().length) {
      if (user.native_currency) currencies.set([user.native_currency]);
      else offerGuess();
      sayZone();                    // the one quiet line names the money it starts with
    }
    await load();
  } catch (e) {
    if (e instanceof Refused && e.status === 401) return;
    $("loading").hidden = true;
    if (isOffline(e) && drawKept()) {
      goneOffline();
      $("page").hidden = false;
      return;
    }
    $("failed-text").textContent = isOffline(e)
      ? "No connection, and this phone hasn't kept a list of your trips yet. Try again when you have signal."
      : `${e?.message || "This page couldn't load."} Reload to try again.`;
    $("failed").hidden = false;
    return;
  }
  $("loading").hidden = true;
  $("page").hidden = false;
  if (arrived) said.arrived.say(arrived[1], arrived[0]);
}

// Signal back: the list again, from the server, and everything switched back on.
addEventListener("online", async () => {
  if (online || !user) { if (!user) location.reload(); return; }
  try {
    await load();
    online = true;
    $("offline").hidden = true;
    netControls();
  } catch { /* still none: the words above stay true */ }
});

start();

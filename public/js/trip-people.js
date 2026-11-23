// A trip's people and settings (/trips/<id>, public/trip-people.html): who is on it and who
// was, the links that bring people onto it, handing it over, leaving it, its details, what it
// holds, and deleting it. Only with a connection: everything here is a question to the server.
//
// The routes it uses (docs/API.md):
//   GET    /api/trips/<id>/people        { trip, you, members, links, handover, storage, rev }
//   PATCH  /api/trips/<id>               the details, any member
//   GET    /api/trips/<id>/areas; PUT …/areas { areas }; DELETE …/areas/<area>   where it goes, any member
//   POST   /api/trips/<id>/tiles/plan { areas }   what the map would be with one more (nothing is changed)
//   POST   /api/trips/<id>/links { days, uses }; DELETE /api/trips/<id>/links/<link>   (host)
//   DELETE /api/trips/<id>/members/<user>  leave (yourself) or remove (the host)
//   POST   /api/trips/<id>/host { to }; DELETE /api/trips/<id>/host; POST …/host/accept|decline
//   POST   /api/trips/<id>/members/<user>/rejoin  -> { url, expires_at }   (host) a guest's way back
//   DELETE /api/trips/<id> { confirm }    the host; without the name it answers what would go
//
// Two people can have this page open at once, so anything refused because the other changed
// it first is said in words and the page reads the trip again.

import { askTwice, busyState, me } from "./auth.js";
import { areaAcrossKm, areaOf, fold, planWords } from "./city-search.js";
import { formatBytes } from "./shared/bytes.js";
import { goesLines } from "./trip-words.js";
import { siteUrl } from "./site.js";
import { openInvite } from "./invite.js";
import { ensurePhotoCss, photoHand, wantsPhoto } from "./photo-hand.js";
import { startForTrip } from "./picture-wait.js";
import { pictureInto, wakePictures } from "./pictures.js";
import { faceHtml } from "../ds/avatar.js";
import { fitName } from "./util.js";
import { INTERESTS_MAX, LINK_DAYS_DEFAULT, LINK_DAYS_MAX, LINK_USES_DEFAULT, LINK_USES_MAX, TRIP_CURRENCIES_MAX } from "./shared/limits.js";
import { currencyOfRegion, regionOfZone } from "./shared/home-currency.js";
import {
  $, Refused, ask, button, currencyName, currencyPicker, datesOf, day, el, icon, isOffline,
  readDateFields, sayer, zonePicker,
} from "./trip-kit.js";

const tripId = (() => { try { return decodeURIComponent(location.pathname.split("/")[2] || ""); } catch { return ""; } })();
const base = `/api/trips/${encodeURIComponent(tripId)}`;

const busy = busyState();
const detail = $("detail");
const said = Object.fromEntries(["msg-people", "msg-links", "msg-details", "msg-where", "msg-leave", "msg-delete", "msg-dialog"].map((id) => [id, sayer($(id), detail)]));
const clearAll = () => { for (const m of Object.values(said)) m.clear(); };

let state = null;        // the last answer of GET people
let areas = [];          // the last answer of GET areas
const nameOf = (id) => state?.members.find((m) => m.id === id)?.name || "someone who left";

/** A trip that isn't this account's, or no connection: the page says which, and links back. */
function stop(words) {
  $("loading").hidden = true;
  $("page").hidden = true;
  $("offer").hidden = true;
  $("failed-text").textContent = "";
  const link = el("a", "", "Your trips");
  link.href = "/trips";
  $("failed-text").append(`${words} `, link);
  $("failed").hidden = false;
}
const GONE = "This trip isn't one of yours, or it was deleted.";
const NO_SIGNAL = "This page needs a connection. Your trips are listed without one:";

/** One action at a time; afterwards the page reads the trip again, since the other people may have changed it too. */
async function run(btn, waiting, where, action) {
  if (busy.on) return;
  clearAll();
  busy.start(btn, waiting);
  try {
    await action();
  } catch (e) {
    if (e instanceof Refused && e.status === 401) return;
    if (e instanceof Refused && e.code === "no such trip") { stop(GONE); return; }
    said[where].fail(e);
    if (e instanceof Refused) await load().catch(() => {});
  } finally {
    busy.stop(btn);
    $("btn-area").disabled = !adding;      // busy.stop turns every control on; this one is on only while a town is picked
  }
}

// ── the people ─────────────────────────────────────────────────────────────────────────

function personRow(m) {
  const { you, handover } = state;
  const row = el("div", "ac-way");
  // Their face, the system's: initials on gray, or the picture they drew (by its hash) in place of them.
  const face = el("span", "tp-face");
  face.setAttribute("aria-hidden", "true");
  face.innerHTML = faceHtml({ name: m.name, initials: m.initials, size: 32, me: m.id === you.id, color: m.note_color });
  if (m.avatar) pictureInto(face.firstElementChild, m.avatar);
  row.append(face);
  const main = el("div", "ac-way-main");
  const head = el("div", "ac-way-title");
  head.append(el("span", "ac-way-label", m.name));
  // Small gray tags, words only (the mock-up's "Host", "You", "Guest").
  const tag = (words, cls = "") => el("span", `ds-tag${cls ? ` ${cls}` : ""}`, words);
  if (m.role === "host") head.append(tag("Host"));
  if (m.id === you.id) head.append(tag("You"));
  if (handover?.to === m.id) head.append(tag("Offered to host", "pill-accent"));
  if (m.guest) head.append(tag("Guest"));
  main.append(head, el("span", "meta", `Joined ${day(m.joined_at)}`));
  row.append(main);

  if (you.host && m.id !== you.id) {
    const acts = el("div", "tr-row-acts");
    if (handover?.to === m.id) {
      const back = button("Take the offer back", { cls: "ds-button ds-button--fade ds-button--sm", label: `Take back the offer to ${m.name}` });
      back.addEventListener("click", () => run(back, "Taking it back…", "msg-people", async () => {
        await ask("DELETE", `${base}/host`);
        await load();
        said["msg-people"].say(`The offer to ${m.name} is taken back. You still host the trip.`, "ok");
      }));
      acts.append(back);
    } else if (m.guest) {
      // A guest (js/guest.js) has no way to sign in but their own browser: a lost or new phone
      // gets back in by a link the host sends them, signing in as them once (rejoinBox). A guest
      // can't host, so there's no offer.
      const rejoin = button(`Send a link to rejoin as ${m.name}`, { cls: "ds-button ds-button--gray ds-button--sm", iconName: "link" });
      rejoin.addEventListener("click", () => run(rejoin, "Making it…", "msg-people", async () => {
        const { url } = await ask("POST", `${base}/members/${encodeURIComponent(m.id)}/rejoin`, {});
        const full = await siteUrl(url);
        if (!full) throw new Error("The link is made, but this phone couldn't reach the site for its address. Try again.");
        row.querySelector(".tr-rejoin")?.remove();
        row.append(rejoinBox(m, full));
        said["msg-people"].say(`Made. Send it to ${m.name} only: it signs in as them, once, within two hours.`, "ok");
      }));
      acts.append(rejoin);
    } else {
      const offer = button("Offer to host", { cls: "ds-button ds-button--fade ds-button--sm", label: `Offer the trip to ${m.name} to host` });
      askTwice(offer, `Tap again to offer it to ${m.name}`, (btn) => run(btn, "Offering…", "msg-people", async () => {
        await ask("POST", `${base}/host`, { to: m.id });
        await load();
        said["msg-people"].say(`Offered to ${m.name}. You host it until they accept; you can take the offer back until then.`, "ok");
      }));
      acts.append(offer);
    }
    const remove = button("Remove", { cls: "ds-button ds-button--fade ds-button--sm", label: `Remove ${m.name} from the trip` });
    askTwice(remove, `Tap again to remove ${m.name}`, (btn) => run(btn, "Removing…", "msg-people", async () => {
      await ask("DELETE", `${base}/members/${encodeURIComponent(m.id)}`);
      await load();
      said["msg-people"].say(`${m.name} is off the trip. What they added stays; an older link won't bring them back.`, "ok");
    }), { destroys: true });
    acts.append(remove);
    row.append(acts);
  }
  return row;
}

/** A guest's rejoin link, under their row: the address, Copy, and Share where the phone has it. */
function rejoinBox(m, url) {
  const box = el("div", "tr-made tr-rejoin");
  const id = `rejoin-${m.id}`;
  const label = el("label", "tr-sub", `${m.name}'s link back in`);
  label.htmlFor = id;
  const field = el("input", "input tr-made-url");
  field.id = id;
  field.type = "text";
  field.readOnly = true;
  field.value = url;
  const acts = el("div", "ac-actions");
  const copy = button("Copy", { cls: "ds-button ds-button--gray ds-button--sm", net: false });
  copy.addEventListener("click", async () => {
    clearAll();
    try {
      await navigator.clipboard.writeText(url);
      said["msg-people"].say(`Copied. Send it to ${m.name} only.`, "ok");
    } catch {
      field.select();
      said["msg-people"].say("This browser didn't let the page copy it. It's selected in the box: copy it from there.", "info");
    }
  });
  acts.append(copy);
  if (navigator.share) {
    const share = button("Share", { cls: "ds-button ds-button--gray ds-button--sm", net: false });
    share.addEventListener("click", async () => {
      try { await navigator.share({ title: state.trip.name, text: `Your way back into “${state.trip.name}” on WeGoPlace`, url }); }
      catch { /* closed without sharing: nothing to say */ }
    });
    acts.append(share);
  }
  box.append(label, field, acts, el("p", "meta", "It signs in as them on the phone that opens it, once, for two hours, and signs them out of their other phones."));
  return box;
}

function goneRow(m) {
  const row = el("div", "ac-way");
  row.append(icon("person", "ac-ico"));
  const main = el("div", "ac-way-main");
  main.append(el("span", "ac-way-label", m.name), el("span", "meta", m.deleted ? "Account deleted" : `Left ${day(m.left_at)}`));
  row.append(main);
  return row;
}

function paintPeople() {
  const here = state.members.filter((m) => m.left_at === null);
  const gone = state.members.filter((m) => m.left_at !== null);
  $("people").replaceChildren(...here.map(personRow));
  // Each whole name: smaller before it wraps (a name is what this list is for).
  for (const n of $("people").querySelectorAll(".ac-way-label")) fitName(n);
  wakePictures($("people"));
  $("gone-list").replaceChildren(...gone.map(goneRow));
  $("gone-people").hidden = !gone.length;
}

// ── an offer to this account ───────────────────────────────────────────────────────────

function paintOffer() {
  const { handover, you, trip } = state;
  const box = $("offer");
  if (handover?.to !== you.id) { box.hidden = true; box.replaceChildren(); return; }
  const card = el("section", "card ac-card tr-offer");
  const head = el("div", "tr-offer-head");
  head.append(icon("host", "ac-ico"), el("h2", "h3", `${nameOf(handover.offered_by)} offered you this trip to host`));
  const list = el("div", "ac-list");
  for (const [mark, words] of [
    ["storage", "Its photos, videos and shared boards would count against your storage."],
    ["leave", "While other people are on it, you couldn't leave it or delete your account: you'd offer it on, or delete it."],
  ]) {
    const line = el("p", "ac-list-row");
    line.append(icon(mark, "ac-ico"), el("span", "", words));
    list.append(line);
  }
  const acts = el("div", "ac-actions");
  const yes = button("Accept: I'll host it", { cls: "ds-button ds-button--white", iconName: "check" });
  const no = button("Decline", { cls: "ds-button ds-button--gray", iconName: "cross" });
  yes.addEventListener("click", () => run(yes, "Accepting…", "msg-people", async () => {
    await ask("POST", `${base}/host/accept`, {});
    await load();
    said["msg-people"].say(`You host “${trip.name}” now.`, "ok");
  }));
  no.addEventListener("click", () => run(no, "Declining…", "msg-people", async () => {
    await ask("POST", `${base}/host/decline`, {});
    await load();
    said["msg-people"].say(`Declined. ${nameOf(handover.offered_by)} still hosts it.`, "ok");
  }));
  acts.append(yes, no);
  card.append(head, list, acts);
  box.replaceChildren(card);
  box.hidden = false;
}

// ── links ──────────────────────────────────────────────────────────────────────────────

function fillLinkChoices() {
  const daysList = [...new Set([1, 3, LINK_DAYS_DEFAULT, 14, LINK_DAYS_MAX])].sort((a, b) => a - b);
  $("link-days").replaceChildren(...daysList.map((d) => { const o = el("option", "", d === 1 ? "1 day" : `${d} days`); o.value = d; return o; }));
  $("link-days").value = String(LINK_DAYS_DEFAULT);
  const usesList = [...new Set([1, 2, 5, LINK_USES_DEFAULT, 20, 30, LINK_USES_MAX])].sort((a, b) => a - b);
  $("link-uses").replaceChildren(...usesList.map((n) => { const o = el("option", "", n === 1 ? "1 person" : `${n} people`); o.value = n; return o; }));
  $("link-uses").value = String(LINK_USES_DEFAULT);
}

function linkRow(l) {
  const row = el("div", "ac-way");
  row.append(icon("link", "ac-ico"));
  const main = el("div", "ac-way-main");
  main.append(el("span", "ac-way-label", `Made by ${nameOf(l.created_by)} on ${day(l.created_at)}`),
    el("span", "meta", `Works until ${day(l.expires_at)} · ${l.uses} of ${l.max_uses} ${l.max_uses === 1 ? "person" : "people"} joined by it`));
  row.append(main);
  if (state.you.host) {
    const revoke = button("Take back", { cls: "ds-button ds-button--fade ds-button--sm", label: `Take back the link made by ${nameOf(l.created_by)} on ${day(l.created_at)}` });
    askTwice(revoke, "Tap again to revoke it", (btn) => run(btn, "Revoking…", "msg-links", async () => {
      await ask("DELETE", `${base}/links/${encodeURIComponent(l.id)}`);
      await load();
      said["msg-links"].say("Taken back. That link brings nobody onto the trip now.", "ok");
    }), { destroys: true });
    row.append(revoke);
  }
  return row;
}

function paintLinks() {
  const live = state.links.filter((l) => l.live);
  const ended = state.links.length - live.length;
  $("links").replaceChildren(...live.map(linkRow));
  $("links-none").hidden = !!live.length;
  $("links-ended").hidden = !ended;
  $("links-ended").textContent = ended === 1 ? "1 link has ended, run out or been taken back." : `${ended} links have ended, run out or been taken back.`;
}

$("form-link").addEventListener("submit", (e) => {
  e.preventDefault();
  run($("btn-link"), "Making it…", "msg-links", async () => {
    const { link } = await ask("POST", `${base}/links`, { days: Number($("link-days").value), uses: Number($("link-uses").value) });
    // At the site's own address, never this page's (a phone at www. hands out the address without it).
    const url = await siteUrl(link.url);
    if (!url) throw new Error("The link is made, but this phone couldn't reach the site for its address. Open People again to copy it.");
    $("made-url").value = url;
    $("made").hidden = false;
    $("btn-share").hidden = !navigator.share;
    await load();
    said["msg-links"].say("Made. Copy it now and send it to the people you're inviting.", "ok");
    $("made-url").select();
  });
});

// Invite people: the same sheet as the trip's first screen, with the defaults; the links below are read again after it.
$("btn-invite").addEventListener("click", () => {
  clearAll();
  openInvite({
    tripId: state.trip.id, tripName: state.trip.name,
    onClose: () => { load().catch(() => {}); },
    // "Links and how long they work", from this page: Link settings, opened, with its summary focused.
    onSettings: () => {
      const set = document.querySelector(".tr-linkset");
      set.open = true;
      const summary = set.querySelector("summary");
      summary.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      summary.focus({ preventScroll: true });
    },
  });
});

$("btn-copy").addEventListener("click", async () => {
  clearAll();
  try {
    await navigator.clipboard.writeText($("made-url").value);
    said["msg-links"].say("Copied.", "ok");
  } catch {
    $("made-url").select();
    said["msg-links"].say("This browser didn't let the page copy it. It's selected in the box: copy it from there.", "info");
  }
});

$("btn-share").addEventListener("click", async () => {
  try {
    await navigator.share({ title: state.trip.name, text: `Join “${state.trip.name}” on WeGoPlace`, url: $("made-url").value });
  } catch { /* closed without sharing: nothing to say */ }
});

// ── the details ────────────────────────────────────────────────────────────────────────

const currencies = currencyPicker($("d-curs"), $("d-cur"));
const zone = zonePicker($("d-tz"), $("d-tz-list"), { at: () => $("d-from").value });
const counted = () => { $("d-count").textContent = `${$("d-interests").value.length.toLocaleString()} of ${INTERESTS_MAX.toLocaleString()} characters`; };
$("d-interests").addEventListener("input", counted);

function paintDetails() {
  const t = state.trip;
  $("d-name").value = t.name;
  $("d-from").value = t.starts_on || "";
  $("d-to").value = t.ends_on || "";
  zone.set(t.default_tz);
  currencies.set(t.currencies || []);
  $("d-interests").value = t.interests || "";
  counted();
}

$("form-details").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = state.trip;
  const name = $("d-name").value.trim().replace(/\s+/g, " ");
  if (!name) { clearAll(); said["msg-details"].say("The trip needs a name.", "err"); return; }
  const dates = readDateFields($("d-from"), $("d-to"));
  if (dates.bad) { clearAll(); said["msg-details"].say(dates.bad, "err"); return; }
  // Only what changed: two people saving at once each change only what they touched.
  const patch = {};
  if (name !== t.name) patch.name = name;
  if (dates.starts_on !== (t.starts_on || null) || dates.ends_on !== (t.ends_on || null)) Object.assign(patch, dates);
  if (zone.get() !== t.default_tz) patch.default_tz = zone.get();
  const cur = currencies.get();
  if (JSON.stringify(cur) !== JSON.stringify(t.currencies || [])) patch.currencies = cur;
  if ($("d-interests").value !== (t.interests || "")) patch.interests = $("d-interests").value;
  if (!Object.keys(patch).length) { clearAll(); said["msg-details"].say("Nothing has changed.", "info"); return; }
  run($("btn-details"), "Saving…", "msg-details", async () => {
    await ask("PATCH", base, patch);
    await load();
    said["msg-details"].say("Saved. Everyone on the trip sees it the next time their phone asks.", "ok");
  });
});

// ── the cover ──────────────────────────────────────────────────────────────────────────
// Any member adds, changes or removes it (src/trips/pictures.js). Made smaller on this phone and
// held here until it is sent (picture-wait.js, startForTrip: this page has no trip store, so it
// holds the cover only); the trip's app sends it too if the signal goes before this page does.

let coverHand = null;
let coverHeld = false;      // a cover waits or is being removed here: when it goes, the page reads the trip again

function paintCover() {
  if (!state) return;
  if (!coverHand) {
    ensurePhotoCss();
    coverHand = photoHand({
      target: { trip: tripId, kind: "cover" },
      stored: () => state?.trip?.cover || null,
      repaint: coverChanged,
      inputHost: $("cover"),
      start: () => startForTrip(tripId),
      noun: "trip",
    });
  }
  const shown = coverHand.view({ cover: state.trip.cover || null }).cover;
  const box = $("cover-pic");
  if (shown && shown.url) {
    const img = el("img");
    img.src = shown.url;
    img.alt = "";
    img.decoding = "async";
    // A cover that can't load (no signal, and this phone never kept it): the trip's mark.
    img.addEventListener("error", () => img.replaceWith(icon("trip", "ac-ico")), { once: true });
    box.replaceChildren(img);
  } else box.replaceChildren(icon("trip", "ac-ico"));
  $("cover-acts").innerHTML = coverHand.html();
  coverHand.painted();
}

function coverChanged() {
  const st = coverHand.shown()?.state;
  const held = st === "waiting" || st === "removing";
  // Sent (or removed on the server): what is there now comes with the trip.
  if (coverHeld && !held && st !== "refused") load().catch(() => {});
  coverHeld = held;
  paintCover();
}

$("cover-acts").addEventListener("click", (e) => { if (coverHand) coverHand.click(e.target); });

// ── where it goes ──────────────────────────────────────────────────────────────────────
// The trip's areas. The ones at the top with bounds are what the server makes the map around
// (a neighborhood is inside its region), so this card is how a trip made by hand gets its map,
// and how a second town joins it. The same picker as Make a trip's "Where", offering only what
// has a position: the trip has its time zone already.

let adding = null;       // { area, row }: the town picked and not yet added
let planSeq = 0;         // the latest question about the map; an older answer is dropped

const where = zonePicker($("area-where"), $("area-where-list"), {
  place: true, townsOnly: true, at: () => state?.trip.starts_on || "", onChange: (_zone, row) => pickedArea(row),
});
// Typing again after a pick: what was picked is no longer what the field says.
$("area-where").addEventListener("input", () => { if (adding) { adding = null; planSeq++; paintAdding(""); } });

function paintAdding(words) {
  $("area-said").textContent = words;
  $("area-said").hidden = !words;
  $("btn-area").disabled = !adding;
}

/** The trip's regions as they would be with one more: what POST …/tiles/plan is asked about. */
const regionsWith = (area) => [
  ...areas.filter((a) => !a.parent && a.west != null).map(({ id, name, west, south, east, north }) => ({ id, name, west, south, east, north })),
  { name: area.name, west: area.west, south: area.south, east: area.east, north: area.north },
];

async function pickedArea(row) {
  clearAll();
  const my = ++planSeq;
  const area = areaOf(row, areas.map((a) => a.id));
  if (!area) { adding = null; paintAdding(""); return; }
  // After the ones it has: the server lists areas by `sort`, and the first town stays first.
  area.sort = areas.reduce((most, a) => Math.max(most, Number(a.sort) || 0), 0) + 1;
  if (areas.some((a) => !a.parent && fold(a.name) === fold(area.name))) {
    adding = null;
    paintAdding(`${area.name} is on the trip already.`);
    return;
  }
  adding = { area, row, mapped: null };
  const across = `${areaAcrossKm(area)} km across`;
  const first = row.kind === "spot" ? `The trip's map gains that spot, ${across}, called ${area.name}.` : `The trip's map gains ${area.name}, ${across}.`;
  paintAdding(first);
  // What it costs the towns already there, said before it is added. A site that makes no maps,
  // an uploaded map, or no answer: nothing to say, and adding is never held up by this.
  let plan = null;
  try { plan = await ask("POST", `${base}/tiles/plan`, { areas: regionsWith(area) }); } catch { plan = null; }
  if (my !== planSeq || !adding) return;
  adding.mapped = !!plan;
  const cost = planWords(plan, area.name);
  if (cost) paintAdding(`${first} ${cost}`);
}

function areaRow(a) {
  const row = el("div", "ac-way");
  row.append(icon("trip", "ac-ico"));
  const main = el("div", "ac-way-main");
  const inside = areas.filter((c) => c.parent === a.id);
  const facts = [a.west != null ? `About ${areaAcrossKm(a)} km across` : "Not on the map: it has no bounds"];
  if (inside.length) facts.push(inside.length === 1 ? `1 neighborhood: ${inside[0].name}` : `${inside.length} neighborhoods`);
  main.append(el("span", "ac-way-label", a.name), el("span", "meta", facts.join(" · ")));
  row.append(main);
  const remove = button("Remove", { cls: "ds-button ds-button--fade ds-button--sm", label: `Remove ${a.name} from where the trip goes` });
  askTwice(remove, `Tap again to remove ${a.name}`, (btn) => run(btn, "Removing…", "msg-where", async () => {
    await ask("DELETE", `${base}/areas/${encodeURIComponent(a.id)}`);
    await load();
    said["msg-where"].say(a.west != null
      ? `${a.name} is off the trip. Its map is made again without it; the Map in the trip says when it's ready.`
      : `${a.name} is off the trip.`, "ok");
  }), { destroys: true });
  row.append(remove);
  return row;
}

function paintWhere() {
  // In the server's order (its `sort`; a town added here goes after the ones before it).
  const tops = areas.filter((a) => !a.parent).sort((x, y) => (x.sort ?? 0) - (y.sort ?? 0));
  $("areas").replaceChildren(...tops.map(areaRow));
  $("areas-none").hidden = !!tops.length;
}

$("form-area").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!adding) return;
  const { area, mapped, row } = adding;
  run($("btn-area"), "Adding…", "msg-where", async () => {
    await ask("PUT", `${base}/areas`, { areas: [area] });
    adding = null; planSeq++;
    where.clear();
    paintAdding("");
    await load();
    said["msg-where"].say(mapped
      ? `${area.name} is added. The trip's map is being made again with it; the Map in the trip says when it's ready.`
      : `${area.name} is added to the trip.`, "ok");
    offerCurrencyOf(area.name, row);
  });
});

// A TOWN IN ANOTHER COUNTRY'S MONEY, offered and never added: the trip goes to a second country,
// and its currency isn't one of the trip's. One button adds it, after the ones it has; nothing else
// changes. Gone when it's added, or when the page is read again for anything else.
function offerCurrencyOf(name, row) {
  const box = $("cur-offer");
  box.replaceChildren();
  box.hidden = true;
  const cc = row && (row.cc || regionOfZone(row.zone));
  const code = cc ? currencyOfRegion(cc) : "";
  const have = state?.trip?.currencies || [];
  if (!code || have.includes(code) || have.length >= TRIP_CURRENCIES_MAX) return;
  let country = cc;
  try { country = new Intl.DisplayNames(["en"], { type: "region" }).of(cc) || cc; } catch { /* the code, then */ }
  const add = button(`Add ${currencyName(code)}`, { cls: "ds-button ds-button--gray ds-button--sm", label: `Add ${currencyName(code)} to the trip's currencies` });
  add.addEventListener("click", () => run(add, "Adding…", "msg-where", async () => {
    const now = state?.trip?.currencies || [];
    if (!now.includes(code)) await ask("PATCH", base, { currencies: [...now, code] });
    box.hidden = true;
    await load();
    said["msg-where"].say(`${currencyName(code)} is one of the trip's currencies now, after ${currencyName(now[0] || code)}.`, "ok");
  }));
  box.append(el("p", "meta", `${name} is in ${country}, where people pay in ${currencyName(code)}. It isn't one of the trip's currencies yet.`), add);
  box.hidden = false;
}

// ── storage ────────────────────────────────────────────────────────────────────────────

function paintStorage() {
  const s = state.storage;
  // One thin line (the host's share of their storage) and one sentence, numbers in the mono face.
  const mono = (n) => el("span", "tp-mono", formatBytes(n));
  const share = s.limit > 0 ? Math.min(1, Math.max(0, s.host_used / s.limit)) : 0;
  const line = el("div", "tp-meter");
  line.setAttribute("role", "img");
  line.setAttribute("aria-label", `${formatBytes(s.host_used)} of ${formatBytes(s.limit)} used`);
  const fill = el("i");
  fill.style.width = `${Math.round(share * 1000) / 10}%`;
  line.append(fill);
  const words = el("p", "tr-meter-words");
  if (state.you.host) {
    words.append("This trip holds ", mono(s.trip_bytes), ". You hold ", mono(s.host_used), " of ", mono(s.limit), " across the trips you host. ");
    const more = el("a", "", "Every trip's share, and uploads under way, are on Your trips.");
    more.href = "/trips";
    words.append(more);
  } else {
    words.append("This trip holds ", mono(s.trip_bytes), `. ${nameOf(s.host_id)}, who hosts it, has `, mono(Math.max(0, s.limit - s.host_used)), " left of ", mono(s.limit), ". Photos and videos added to the trip count against the host.");
  }
  $("storage").replaceChildren(line, words);
}

// ── leaving ────────────────────────────────────────────────────────────────────────────

function paintLeave() {
  const { you, trip } = state;
  $("leave-card").hidden = false;
  if (you.host) {
    $("leave-words").textContent = "You host this trip, so you can't leave it. Offer it to someone on it, and leave once they accept; or delete it below.";
    $("leave-actions").replaceChildren();
    return;
  }
  $("leave-words").textContent = "You stop seeing the trip at once. What you added and paid stays on it, under your name; a link brings you back.";
  const leave = button("Leave this trip", { cls: "ds-button ds-button--gray", iconName: "leave" });
  askTwice(leave, `Tap again to leave “${trip.name}”`, (btn) => run(btn, "Leaving…", "msg-leave", async () => {
    await ask("DELETE", `${base}/members/${encodeURIComponent(you.id)}`);
    location.replace("/trips?done=left");
  }), { destroys: true });
  $("leave-actions").replaceChildren(leave);
}

// ── deleting ───────────────────────────────────────────────────────────────────────────

const sameName = (a, b) => a.trim().normalize("NFC") === b.trim().normalize("NFC");


$("btn-delete").addEventListener("click", () => run($("btn-delete"), "Asking what goes…", "msg-delete", async () => {
  // Without the name the server deletes nothing and answers what would go.
  let preview;
  try {
    await ask("DELETE", base, {});
  } catch (e) {
    if (!(e instanceof Refused && e.code === "confirm")) throw e;
    preview = e.body;
  }
  if (!preview) throw new Refused("confirm", "The server didn't say what would go. Reload and try again.", 0, null);
  $("dlg-title").textContent = `Delete “${preview.need}”?`;
  $("dlg-goes").replaceChildren(...goesLines(preview.goes).map(([mark, words]) => {
    const line = el("p", "ac-list-row");
    line.append(icon(mark, "ac-ico"), el("span", "", words));
    return line;
  }));
  $("dlg-label").textContent = `Type its name, ${preview.need}, to delete it`;
  $("dlg-name").value = "";
  $("dlg-delete").disabled = true;
  said["msg-dialog"].clear();
  $("delete-dialog").showModal();
  $("dlg-name").focus();
}));

$("dlg-name").addEventListener("input", () => { $("dlg-delete").disabled = !sameName($("dlg-name").value, state.trip.name); });
$("dlg-cancel").addEventListener("click", () => $("delete-dialog").close());
$("form-delete").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!sameName($("dlg-name").value, state.trip.name)) return;
  run($("dlg-delete"), "Deleting…", "msg-dialog", async () => {
    await ask("DELETE", base, { confirm: $("dlg-name").value });
    location.replace("/trips?done=trip-deleted");
  }).finally(() => {
    // Still here (refused, or no connection): the button is on only while the name matches.
    $("dlg-delete").disabled = !sameName($("dlg-name").value, state.trip.name);
  });
});

// ── loading ────────────────────────────────────────────────────────────────────────────

function paint() {
  const { trip, you } = state;
  document.title = `${trip.name} · people and settings · WeGoPlace`;
  $("trip-name").textContent = trip.name;
  $("trip-meta").textContent = `${datesOf(trip)} · ${you.host ? "you host it" : `hosted by ${nameOf(trip.host_id)}`}`;
  $("trip-meta").hidden = false;
  paintOffer();
  paintPeople();
  paintLinks();
  paintWhere();
  paintStorage();
  paintCover();
  paintLeave();
  $("delete-card").hidden = !you.host;
}

async function load() {
  const [people, there] = await Promise.all([ask("GET", `${base}/people`), ask("GET", `${base}/areas`)]);
  state = people;
  areas = Array.isArray(there.areas) ? there.areas : [];
  paint();
  // The form keeps what someone is typing; it is filled from the server only when not in use.
  if (!$("form-details").contains(document.activeElement)) paintDetails();
}

async function start() {
  fillLinkChoices();
  if (!tripId) { stop(GONE); return; }
  try {
    const user = await me();
    if (!user) { location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`); return; }
    await load();
    paintDetails();
  } catch (e) {
    if (e instanceof Refused && e.status === 401) return;
    if (isOffline(e)) { stop(NO_SIGNAL); return; }
    if (e instanceof Refused && e.code === "no such trip") { stop(GONE); return; }
    stop(`${e?.message || "This page couldn't load."} Reload to try again, or go back to`);
    return;
  }
  $("loading").hidden = true;
  $("page").hidden = false;
  // Come from the Map's "Say where": the card is where the page opens.
  if (location.hash === "#where") $("where").scrollIntoView({ block: "start" });
  // A link to add the cover (/trips/<id>?photo=add#cover, what an AI app hands the person).
  if (wantsPhoto(location.search) && coverHand) coverHand.arrive();
}

start();

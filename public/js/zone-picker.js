// Where something is, found by typing its town: one control, used by the pages outside a trip
// (Your trips' "make a trip", a trip's settings and its areas) and by the app (a plan's "leaves
// from / arrives in another time zone"). It answers a time zone, and where it is asked WHERE
// A TRIP IS (`place: true`) it answers the town too, for the trip's map. Nothing runs on import,
// and nothing is fetched until somebody uses the field. Its styles are /css/zone-picker.css.
//
// What it finds, how names are compared and what a row says: public/js/city-search.js, over
// the table in public/towns/ (GeoNames; docs/CONTRACTS.md, "A town says where a trip is").
//
//   zonePicker(input, list, { onChange, at, place, townsOnly })  -> { get(), row(), set(zone), clear() }
//   zoneLabel(zone)                             "Lisbon": a zone as a person names it
//   zones()                                     every zone this browser knows
//   phoneZone()                                 the phone's own

import { dayWhen, findTowns, rowLabel, rowWhere, townSource, zoneName, zoneNear, zoneOffset, zonePlace } from "./city-search.js";

/** An element with a class and its words: the one helper the list needs. */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function zones() {
  try { const all = Intl.supportedValuesOf("timeZone"); return all.includes("UTC") ? all : [...all, "UTC"]; } catch { return ["UTC"]; }
}
export function phoneZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}
/** A zone as a person names it: its city ("Lisbon", "Buenos Aires"). The zone database's region word is shown nowhere. */
export const zoneLabel = (z) => zoneName(z);

// One table for the page: every picker on it reads the same files once.
//
// KEPT AS THEY ARE TYPED FOR. The worker keeps each file it fetches in the towns' own cache
// (sw.js towns()); a page the worker doesn't control yet (the first visit after signing in, when
// it was registered but has not taken the page) keeps its own copy in the same cache and reads
// it back first, so a town looked up once is found with no signal either way. forget.js clears
// that cache with the rest of a person's things.
const TOWNS_CACHE = "wegoplace-towns-v1";
async function keptFetch(url) {
  const ruled = !!(globalThis.navigator && navigator.serviceWorker && navigator.serviceWorker.controller);
  let cache = null;
  if (!ruled && globalThis.caches) { try { cache = await caches.open(TOWNS_CACHE); } catch { cache = null; } }
  if (cache) { const hit = await cache.match(url).catch(() => null); if (hit) return hit; }
  const res = await fetch(url);
  if (cache && res.ok) cache.put(url, res.clone()).catch(() => {});
  return res;
}
let table = null;
const theTable = () => table || (table = townSource({ fetcher: keptFetch }));
let tableIndex = null;              // the table's index, once any picker has read it

export const WORDS = {
  hint: "Type a town, a city or a country.",
  hintZone: "Type a city or a country.",
  hintTown: "Type a town or a city.",
  looking: "Looking…",
  none: "No town or country by that name.",
  noneTown: "No town by that name.",
  noneOffline: "Nothing by that name here. With no signal only time zones, and towns already looked up, can be found.",
  offline: "No signal: only time zones, and towns already looked up, are here.",
  zoneOnly: "sets the time zone only",
  linkOffer: "Not a town? Paste a map link to it",
  linkOfferFound: "Not here? Paste a map link to it",
  linkBack: "Back to typing a town",
  linkHint: (name) => `Paste a link from a maps app, or coordinates. The trip will call it “${name}”.`,
  linkPlaceholder: (name) => `Paste a map link to ${name}`,
  linkShort: "A short map link doesn't say where it points. Open it and copy the long link, or paste the coordinates.",
  linkUnread: "That doesn't say where it is. Paste a link from a maps app that has the spot in it, or the coordinates.",
  linkView: "That link only says where the map was looking, so the spot is a guess. A link to the place itself is surer.",
};

/**
 * A place found by typing: an input (role combobox) and the list under it (role listbox).
 * "lis" finds Lisbon; "kyoto" finds Kyoto and with it Tokyo's time; "japan" finds the country's
 * zone. Arrows and Enter choose, as does a tap; Escape closes. The field then says the place and
 * its offset ("Kyoto, Japan · GMT+9"). Leaving the field without choosing puts back what was
 * chosen. Each offset is the one on `at()` (the trip's first day, when it has one: Lisbon is
 * GMT+1 in April), else today's.
 *
 * `place: true` is the field that asks where a trip is: a row that gives no position says so,
 * and what no list of towns has (an island, a coast, a park) can be given by a map link, read
 * from the link's own text, with the name that was typed. `townsOnly` with it is the field that
 * adds a town to a trip that has its zone already: only what has a position is offered.
 *
 * Answers { get(), row(), set(zone), clear() }: the zone's id; the row that was picked (kind
 * "city" or "spot" has lat, lng and people; null after set()); onChange(zone, row).
 */
export function zonePicker(input, list, { onChange = () => {}, at = () => null, place = false, townsOnly = false } = {}) {
  const all = zones();
  const placeholder = input.getAttribute("placeholder") || "";
  let value = null;                 // the zone's id
  let picked = null;                // the row it came from, when it was picked here
  let shown = [];                   // the rows that can be chosen
  let acts = [];                    // what each option does when chosen, in the list's order
  let active = -1;
  let seq = 0;                      // the latest question asked; an older answer is dropped
  let link = null;                  // { name }: the field is taking a map link for that name

  const when = () => dayWhen(at());
  const said = (zone, words) => (/^(UTC|GMT)$/i.test(zoneName(zone)) && !words ? "UTC" : [words || (tableIndex ? zonePlace(tableIndex, zone) : zoneName(zone)), zoneOffset(zone, when())].filter(Boolean).join(" · "));
  const fieldText = () => (picked ? said(value, rowLabel(picked)) : value ? said(value, "") : "");
  const readIndex = () => theTable().index().then((i) => { tableIndex = i; return i; }).catch(() => null);

  const close = () => {
    seq++;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };
  const endLink = () => { if (!link) return; link = null; input.setAttribute("placeholder", placeholder); input.removeAttribute("inputmode"); };
  const choose = (row) => { endLink(); value = row.zone; picked = row; input.value = fieldText(); close(); onChange(value, row); };
  const mark = () => {
    const opts = [...list.querySelectorAll('[role="option"]:not([aria-disabled="true"])')];
    opts.forEach((li, i) => li.setAttribute("aria-selected", i === active ? "true" : "false"));
    if (active >= 0 && opts[active]) {
      input.setAttribute("aria-activedescendant", opts[active].id);
      opts[active].scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  /** A line of the list that is words, not a choice. */
  const note = (words, cls = "tr-zone-none") => { const li = el("li", cls, words); li.setAttribute("role", "option"); li.setAttribute("aria-disabled", "true"); return li; };
  /** A line of the list that does something when chosen. */
  const option = (cls, act, ...kids) => {
    const li = el("li", cls);
    li.id = `${list.id}-${acts.length}`;
    li.setAttribute("role", "option");
    li.append(...kids);
    // pointerdown, not click: the field keeps its focus, so the list doesn't close first.
    li.addEventListener("pointerdown", (e) => { e.preventDefault(); act(); });
    acts.push(act);
    return li;
  };
  // The whole list on the screen: never taller than the screen has under the field, and
  // scrolled into sight when it opens past the bottom edge (a short phone, a field low on the
  // page), so its last line, the way out for what no list of towns has, is not below the fold.
  const fit = () => {
    const vv = window.visualViewport;
    const tall = vv ? vv.height : window.innerHeight;
    const field = input.getBoundingClientRect();
    list.style.maxHeight = `${Math.max(140, Math.min(360, Math.floor(tall - field.height - 28)))}px`;
    const edge = (vv ? vv.offsetTop : 0) + tall;
    if (list.getBoundingClientRect().bottom > edge - 4) list.scrollIntoView({ block: "nearest" });
  };
  const open = (...lines) => {
    list.replaceChildren(...lines);
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    active = shown.length ? 0 : -1;
    mark();
    fit();
  };

  // ── a map link, for what no list of towns has ──
  const startLink = (name) => {
    link = { name };
    input.value = "";
    input.setAttribute("placeholder", WORDS.linkPlaceholder(name));
    input.setAttribute("inputmode", "url");
    paintLink();
  };
  const backFromLink = () => { const name = link ? link.name : ""; endLink(); input.value = name; paint(); };
  async function paintLink(saying = "") {
    const my = ++seq;
    const text = input.value.trim();
    shown = []; acts = [];
    const back = () => option("tr-zone-opt tr-zone-act", backFromLink, el("span", "tr-zone-link", WORDS.linkBack));
    if (!text) { open(note(saying || WORDS.linkHint(link.name)), back()); return; }
    const form = await import("./place-form.js");
    if (my !== seq || !link) return;
    const read = form.readMapLink(text);
    if (!read) { open(note(form.isShortMapLink(text) ? WORDS.linkShort : WORDS.linkUnread), back()); return; }
    // The zone of the nearest towns; with none near (open sea, a far park) the zone stays as it was.
    const near = await zoneNear(theTable(), read.lat, read.lng).catch(() => null);
    if (my !== seq || !link) return;
    const row = { kind: "spot", name: link.name, town: "", region: "", country: "", cc: "", zone: (near && near.zone) || value || phoneZone(),
      lat: read.lat, lng: read.lng, people: 0, zoneFound: !!(near && near.zone), viewOnly: form.isViewOnly(read) };
    choose(row);
  }

  // ── the list for what is typed ──
  async function paint() {
    if (link) { paintLink(); return; }
    const typed = input.value;
    const my = ++seq;
    if (!typed.trim()) { shown = []; acts = []; open(note(townsOnly ? WORDS.hintTown : place ? WORDS.hint : WORDS.hintZone)); return; }
    // Words while the first file is on its way, only if there is nothing to look at yet.
    const slow = setTimeout(() => { if (my === seq && list.hidden) { shown = []; acts = []; open(note(WORDS.looking)); } }, 250);
    const found = await findTowns(theTable(), typed, townsOnly ? { zones: [], limit: 16 } : { zones: all });
    const reached = found.reached;
    const rows = townsOnly ? found.rows.filter((r) => r.kind === "city").slice(0, 8) : found.rows;
    clearTimeout(slow);
    if (my !== seq) return;
    if (reached && !tableIndex) await readIndex();
    if (my !== seq) return;
    shown = rows; acts = [];
    const at = when();
    const lines = rows.map((r) => option("tr-zone-opt", () => choose(r),
      el("span", "tr-zone-city", rowLabel(r)),
      el("span", "tr-zone-where", [rowWhere(r, at), place && r.kind !== "city" ? WORDS.zoneOnly : ""].filter(Boolean).join(" · "))));
    if (!rows.length) lines.push(note(!reached ? WORDS.noneOffline : townsOnly ? WORDS.noneTown : WORDS.none));
    else if (!reached) lines.push(note(WORDS.offline, "tr-zone-none tr-zone-foot"));
    if (place) lines.push(option("tr-zone-opt tr-zone-act", () => startLink(typed.trim().replace(/\s+/g, " ")), el("span", "tr-zone-link", rows.length ? WORDS.linkOfferFound : WORDS.linkOffer)));
    open(...lines);
  }

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", list.id);
  input.addEventListener("input", paint);
  input.addEventListener("focus", () => {
    input.select();
    if (!tableIndex) readIndex();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) { paint(); return; }
      if (!acts.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : acts.length - 1)) % acts.length;
      mark();
    } else if (e.key === "Enter") {
      if (!list.hidden && active >= 0 && acts[active]) { e.preventDefault(); acts[active](); }
    } else if (e.key === "Escape") {
      if (!list.hidden) { e.preventDefault(); endLink(); close(); input.value = fieldText(); }
    }
  });
  input.addEventListener("blur", () => { endLink(); close(); input.value = fieldText(); });
  return {
    get: () => value,
    row: () => picked,
    set: (z) => {
      endLink(); value = z || phoneZone(); picked = null; input.value = fieldText(); close();
      // A stored zone is said as a place ("Tokyo, Japan"), which takes the table's index: 18 KB
      // that comes with the app. When it arrives, a field nobody is typing in says it whole.
      if (!tableIndex) {
        const was = value;
        readIndex().then((i) => { if (i && value === was && !picked && !link && document.activeElement !== input) input.value = fieldText(); });
      }
    },
    clear: () => { endLink(); value = null; picked = null; input.value = ""; close(); },
  };
}

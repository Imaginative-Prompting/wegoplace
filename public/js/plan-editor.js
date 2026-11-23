// plan-editor.js: the sheet a plan is added, changed and removed in, by hand.
//
//   import { openPlanEditor } from "./plan-editor.js";
//   openPlanEditor({ day: "2027-05-08" });            // a new plan, that day chosen
//   openPlanEditor({ eventId, onRemoved: () => … });  // change or remove one
//
// The rules (what the form's values mean, what a change writes) are plan-form.js, which has
// no DOM and is checked in node. This file is the form on screen and the three writes, each
// through the store, so a plan made with no signal waits on the phone like a purchase does.
//
// A plan goes on a day of its trip. A trip made without dates takes none, so the sheet asks
// for the dates first (any member may set them; that one needs signal, because every phone
// has to agree on the trip's days before a plan is put on one).
//
// Its times are the trip's clock. A flight or a transit can say it leaves from, or arrives in,
// another time zone (the flight from home leaves from home's zone): each is closed until it is
// opened, and opens the find-by-city control the trips pages use (zone-picker.js). A plan that
// already has a zone of its own opens with it showing, whatever its kind.

import { store } from "./store.js";
import { openSheet, focusKeeper } from "./sheet.js";
import { toast } from "./toast.js";
import { esc, clip, setDisabled } from "./util.js";
import { getIcon, categoryOf } from "./icons.js";
import { daysBetween, clockOf, isZone } from "./shared/clock.js";
import { KINDS, TITLE_MAX, DETAIL_MAX, readPlan, formOf, changesOf, hasDates, dayAfter, dayBefore, workedEndDay } from "./plan-form.js";
import { zonePicker, zoneLabel } from "./zone-picker.js";

// The glyph each kind of plan is drawn with on its card (agenda.js EVENT_SUB): the same six.
const KIND_SUB = { flight: "flight", transit: "transfer", meal: "meal", lodging: "hotel", activity: "walk", plan: "" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FOUND_MAX = 6;
// The kinds that go from one place to another, and so may leave from or arrive in another zone.
const MOVES = new Set(["flight", "transit"]);
// The kind of place a kind of plan is most likely at, for a place made from a plan's Where.
const PLACE_KIND_OF = { meal: "food", lodging: "lodging", activity: "activity", transit: "transit", flight: "transit" };
const PLUS = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
const CHEVRON_ICO = `<svg class="ico pe-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

const dayNum = (day) => Number(day.slice(8, 10));
const monthOf = (day) => MONTHS[Number(day.slice(5, 7)) - 1];
const dayWords = (d) => `${d.weekday.slice(0, 3)} ${dayNum(d.day)} ${monthOf(d.day)}`;
const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

let open = null;   // one plan sheet at a time

/** A chip chosen while half off the edge of its row comes fully into it. (The place form's too.) */
export function showChip(chip) {
  const row = chip.parentElement;
  const rr = row.getBoundingClientRect(), cr = chip.getBoundingClientRect();
  const pad = 8;
  if (cr.left < rr.left + pad) row.scrollLeft += cr.left - rr.left - pad;
  else if (cr.right > rr.right - pad) row.scrollLeft += cr.right - rr.right + pad;
}

/**
 * Open the sheet.
 *   eventId    the plan to change; none for a new one
 *   day        for a new plan, the day to start on ("YYYY-MM-DD"); the trip's first otherwise
 *   startTime  optional "HH:MM" for a new plan (from a free-time gap)
 *   endTime    optional "HH:MM" for a new plan
 *   onSaved    (id, day, { isNew }) after a plan is added or changed
 *   onRemoved  (id) after one is removed
 */
export function openPlanEditor({ eventId = null, day = "", startTime = "", endTime = "", onSaved = null, onRemoved = null } = {}) {
  if (open) return open;
  injectFormStyles();
  const trip = store.trip();
  if (!trip) { toast("This trip hasn't reached this phone yet."); return null; }
  const was = eventId ? store.event(eventId) : null;
  if (eventId && !was) { toast("That plan isn't on this phone any more."); return null; }

  const body = document.createElement("form");
  body.className = "pe ds";
  body.noValidate = true;
  body.addEventListener("submit", (ev) => ev.preventDefault());
  const foot = document.createElement("div");
  foot.className = "pe-foot ds";

  // The form's values, kept here and written back into the controls by paint().
  let F = null;
  let busy = false;
  let asking = false;   // "Remove this plan?" is showing
  let moreOpen = false;
  // The end day in the form is one the sheet worked out (an end at or before the start's clock
  // is the next day; across zones, whichever day the end's clock first reads its time after the
  // start), not one the person picked: it follows the times, the day and the zones.
  let autoEnd = false;

  // The zones. Each side is the trip's until the person opens it: `from` for the start,
  // `to` for the end. An open side with no zone chosen yet holds "" and is refused on save.
  const tripZone = () => (isZone(store.trip() && store.trip().default_tz) ? store.trip().default_tz : "UTC");
  const Z = { from: null, to: null };     // null: closed (the trip's); "": open, none chosen; else the zone
  if (was) {
    const tz = isZone(was.tz) ? was.tz : tripZone();
    const ez = isZone(was.end_tz) ? was.end_tz : tz;
    if (tz !== tripZone()) Z.from = tz;
    // An end with no zone of its own ends in the start's: shown as such when that isn't the trip's.
    if (was.ends_at != null && ez !== tripZone()) Z.to = ez;
  }
  const zone = () => Z.from || tripZone();
  const endZone = () => Z.to || tripZone();
  const pickers = {};
  const tripDays = () => {
    const t = store.trip();
    const days = hasDates(t) ? daysBetween(t.starts_on, t.ends_on) : [];
    // A plan already on a day outside the trip's (none can be made, but one may exist) keeps its day on offer.
    if (F && F.day && !days.some((d) => d.day === F.day)) {
      days.push(...daysBetween(F.day, F.day));
      days.sort((a, b) => (a.day < b.day ? -1 : 1));
    }
    return days;
  };

  const sheet = openSheet({
    title: was ? "Change plan" : "Add a plan",
    contentEl: body,
    footEl: foot,
    // The handle and the backdrop are the ways out on a phone; from 768 it is a dialog with a ×.
    dragFrom: "handle",
    closeButton: false,
    onOpen: () => {
      // Open at content height: leave #pe-title unfocused until tapped so the sheet stays compact.
    },
    onClose: () => { if (open === api) open = null; if (resized) resized.disconnect(); },
  });
  const api = { close: () => sheet.close(), el: sheet.el };
  open = api;

  // ── the trip has no dates: ask for them first ────────────────────────────────────────────
  function paintDates(say = "") {
    foot.innerHTML = "";
    body.innerHTML =
      `<p class="pe-lead">A plan goes on a day of the trip, and this trip has no dates yet. Setting them is for everyone on the trip.</p>` +
      `<div class="pe-pair pe-dates">` +
        `<div class="ds-field"><label class="ds-label" for="pe-first">First day</label><input class="ds-input" id="pe-first" type="date"></div>` +
        `<div class="ds-field"><label class="ds-label" for="pe-last">Last day</label><input class="ds-input" id="pe-last" type="date"></div>` +
      `</div>` +
      `<p class="pe-say" data-say="dates" role="alert"${say ? "" : " hidden"}>${esc(say)}</p>` +
      `<button type="button" class="ds-button ds-button--white ds-button--lg ds-button--block" data-act="set-dates">Set the dates</button>`;
  }

  async function setDates() {
    if (busy) return;
    const first = body.querySelector("#pe-first").value;
    const last = body.querySelector("#pe-last").value;
    const say = (words) => {
      const p = body.querySelector('[data-say="dates"]');
      p.textContent = words; p.hidden = !words;
    };
    if (!first || !last) { say("Pick both days."); body.querySelector(first ? "#pe-last" : "#pe-first").focus(); return; }
    if (last < first) { say("The last day can't be before the first."); body.querySelector("#pe-last").focus(); return; }
    busy = true;
    const btn = body.querySelector('[data-act="set-dates"]');
    btn.disabled = true; btn.textContent = "Setting the dates…";
    say("");
    const res = await store.setTripDates(first, last);
    busy = false;
    if (!body.isConnected) return;
    if (res.ok) { startForm(true); return; }
    btn.disabled = false; btn.textContent = "Set the dates";
    say(res.offline ? "Setting the dates needs signal. Try again when you have it."
      : (res.body && res.body.reason) || `The dates couldn't be set (${res.status}).`);
  }

  function syncSave() {
    const btn = foot.querySelector('[data-act="save"]');
    if (!btn) return;
    const inp = body.querySelector("#pe-title");
    const titleNow = inp ? inp.value : (F ? F.title : "");
    setDisabled(btn, busy ? "Saving the plan" : !String(titleNow || "").trim() ? "Enter what it is" : "");
  }

  function setMore(on) {
    moreOpen = !!on;
    const wrap = body.querySelector("#pe-more");
    const btn = body.querySelector('[data-act="toggle-more"]');
    if (wrap) wrap.hidden = !moreOpen;
    if (btn) btn.setAttribute("aria-expanded", String(moreOpen));
  }

  // ── the form ─────────────────────────────────────────────────────────────────────────────
  function startForm(focusName = false) {
    if (was) {
      F = formOf(was);
      autoEnd = !!F.endDay && F.endDay === workedEndDay({ ...F, endDay: "" }, { zone: zone(), endZone: endZone() });
      moreOpen = !!(F.endDay || F.placeId || F.detail || F.url);
    } else {
      const days = hasDates(store.trip()) ? daysBetween(store.trip().starts_on, store.trip().ends_on) : [];
      const today = clockOf(Math.floor(Date.now() / 1000), zone()).date;
      const start = days.some((d) => d.day === day) ? day : days.some((d) => d.day === today) ? today : (days[0] ? days[0].day : "");
      const okTime = (s) => (/^\d{2}:\d{2}$/.test(String(s || "")) ? String(s) : "");
      F = { title: "", kind: "plan", day: start, time: okTime(startTime), endDay: "", endTime: okTime(startTime) ? okTime(endTime) : "", placeId: "", detail: "", url: "" };
      autoEnd = !!F.endTime && !!F.time && !!workedEndDay({ ...F, endDay: "" }, { zone: zone(), endZone: endZone() });
      if (autoEnd) F.endDay = workedEndDay({ ...F, endDay: "" }, { zone: zone(), endZone: endZone() });
      moreOpen = !!(F.endDay || F.placeId || F.detail || F.url);
    }
    paintForm();
    if (focusName) body.querySelector("#pe-title").focus({ preventScroll: true });
  }

  const kindChips = () => KINDS.map(([k, word]) =>
    `<button type="button" class="pe-chip pe-kind" data-kind="${k}" aria-pressed="${F.kind === k}"` +
    ` style="--ds-k:var(--plan-${k});--ds-k-bg:var(--plan-${k}-bg);--ds-k-edge:var(--plan-${k}-edge)">` +
    `${getIcon(k, KIND_SUB[k], { cls: "pe-kindg" })}<span>${word}</span></button>`).join("");

  const dayChips = () => {
    let month = "";
    return tripDays().map((d) => {
      const m = monthOf(d.day);
      const showMonth = m !== month; month = m;
      return `<button type="button" class="pe-chip pe-day" data-day="${d.day}" aria-pressed="${F.day === d.day}" aria-label="${esc(`${d.weekday} ${dayNum(d.day)} ${m}`)}">` +
        `<span class="pe-dow">${d.weekday.slice(0, 3)}</span><span class="pe-dnum num">${dayNum(d.day)}</span>` +
        `${showMonth ? `<span class="pe-dmon">${m}</span>` : ""}</button>`;
    }).join("");
  };

  // The days an end can be on: the days after the start, to the day after the trip's last (a
  // night bus out on the last evening arrives the morning after). Across zones the day before
  // too, first: eastward over the date line a flight lands the evening before it left.
  const endDays = () => {
    if (!F.day) return [];
    const t = store.trip();
    const lastOffered = hasDates(t) && t.ends_on >= F.day ? dayAfter(t.ends_on) : dayAfter(F.day);
    const days = daysBetween(dayAfter(F.day), lastOffered);
    if (F.endDay && F.endDay > F.day && !days.some((d) => d.day === F.endDay)) days.push(...daysBetween(F.endDay, F.endDay));
    if (zone() !== endZone()) days.unshift(...daysBetween(dayBefore(F.day), dayBefore(F.day)));
    return days;
  };
  const endOptions = () => {
    const days = endDays();
    const before = days.filter((d) => d.day < F.day), after = days.filter((d) => d.day > F.day);
    const opt = (d) => `<option value="${d.day}"${F.endDay === d.day ? " selected" : ""}>${esc(dayWords(d))}</option>`;
    return before.map(opt).join("") + `<option value=""${F.endDay ? "" : " selected"}>The same day</option>` + after.map(opt).join("");
  };

  // A zone as a person says it: its city ("New York").
  const city = (z) => zoneLabel(z);

  // One line under the times that says what they mean, where it isn't obvious.
  function hint() {
    const zoned = zone() !== tripZone() || endZone() !== tripZone();
    if (!F.time) {
      if (zoned) return "Add the times it leaves and arrives, each on its own zone's clock.";
      return F.endDay ? "No start time: it takes whole days, through the day it ends." : "No start time: it takes the whole day.";
    }
    if (zoned) {
      // Every time on its own zone's clock, said with the city, so nobody has to work it out.
      const leaves = `Leaves at ${F.time}, ${city(zone())} time.`;
      if (!F.endTime) return leaves;
      const endDay = F.endDay || F.day;
      const d = daysBetween(endDay, endDay)[0];
      const when = endDay === F.day ? "the same day" : endDay === dayAfter(F.day) ? `the next day, ${dayWords(d)}` : endDay === dayBefore(F.day) ? `the day before, ${dayWords(d)}` : dayWords(d);
      return `${leaves} Arrives ${when}, at ${F.endTime} ${city(endZone())} time.`;
    }
    if (autoEnd) {
      const next = daysBetween(F.endDay, F.endDay)[0];
      return `Ends the next day, ${dayWords(next)}.`;
    }
    return "";
  }

  // Keep "Ends on" true to the times: when the end falls on another day than the start's (past
  // midnight, or across zones) and the person has picked no end day, that day is chosen for
  // them, in the control, where they can see it; when it stops doing so, a day chosen that way
  // is let go again.
  function syncEnd() {
    const worked = workedEndDay({ ...F, endDay: "" }, { zone: zone(), endZone: endZone() });
    if (worked && (!F.endDay || autoEnd)) { F.endDay = worked; autoEnd = true; }
    else if (autoEnd) { F.endDay = ""; autoEnd = false; }
    const sel = body.querySelector("#pe-endday");
    if (sel) sel.innerHTML = endOptions();
    paintHint();
  }

  // The two zones, under the times: for a flight or a transit, or for any plan that already
  // has a zone of its own. Closed, a side is a button; open, it is the find-by-city field with
  // a way to close it again (back to the trip's zone).
  const SIDES = {
    from: { open: "Leaves from another time zone", label: "Leaves from", ph: "Type the city it leaves from" },
    to: { open: "Arrives in another time zone", label: "Arrives in", ph: "Type the city it arrives in" },
  };
  function zonesHtml() {
    const shown = MOVES.has(F.kind) || Z.from !== null || Z.to !== null;
    if (!shown) return "";
    return Object.entries(SIDES).map(([side, w]) => {
      if (Z[side] === null) {
        return `<button type="button" class="pe-zopen" data-act="zone-open" data-side="${side}" aria-expanded="false">${PLUS}<span>${w.open}</span></button>`;
      }
      return `<div class="ds-field pe-zone" data-side="${side}"><div class="pe-zhead"><label class="ds-label" for="pe-${side}zone">${w.label}</label>` +
        `<button type="button" class="pe-zclose" data-act="zone-close" data-side="${side}" aria-expanded="true">The trip's time zone</button></div>` +
        `<div class="tr-zone-box"><input class="ds-input" id="pe-${side}zone" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${w.ph}">` +
        `<ul class="tr-zone-list" id="pe-${side}zone-list" role="listbox" aria-label="Time zones" hidden></ul></div>` +
        `<p class="pe-say" data-say="${side}zone" role="alert" hidden></p></div>`;
    }).join("");
  }
  // Paint the zones' block and wire each open side's control to Z.
  function paintZones(focusSide = "") {
    const box = body.querySelector(".pe-zones");
    if (!box) return;
    box.innerHTML = zonesHtml();
    for (const side of Object.keys(SIDES)) {
      const input = body.querySelector(`#pe-${side}zone`);
      if (!input) { delete pickers[side]; continue; }
      pickers[side] = zonePicker(input, body.querySelector(`#pe-${side}zone-list`), {
        onChange: (z) => { Z[side] = z; unsay(`pe-${side}zone`); readControls(); syncEnd(); },
        at: () => F.day || null,
      });
      if (Z[side]) pickers[side].set(Z[side]);
    }
    if (focusSide) {
      const n = body.querySelector(`#pe-${focusSide}zone`);
      if (n) n.focus({ preventScroll: true });
    }
  }
  function openZone(side) {
    Z[side] = "";
    paintZones(side);
    const f = body.querySelector(`.pe-zone[data-side="${side}"]`);
    if (f) f.scrollIntoView({ block: "nearest" });
  }
  function closeZone(side) {
    Z[side] = null;
    unsay(`pe-${side}zone`);
    readControls();
    paintZones();
    syncEnd();
    const again = body.querySelector(`.pe-zopen[data-side="${side}"]`);
    if (again) again.focus({ preventScroll: true });
  }

  // A place as one line: its glyph, its name, and what kind of place it is in its own words
  // (two places can share a name: a market and the restaurant inside it).
  const placeLine = (p) => {
    const sort = String(p.subkind || p.kind || "").replace(/[_-]+/g, " ").trim();
    return `${getIcon(p.kind, p.subkind, { cls: "pe-placeg" })}<span class="pe-placen">${esc(clip(p.name || "", 60))}</span>` +
      `${sort ? `<span class="pe-placea">${esc(sort)}</span>` : ""}`;
  };

  function whereHtml() {
    const chosen = F.placeId ? store.place(F.placeId) : null;
    if (chosen) {
      return `<div class="ds-field"><span class="ds-label pe-label" id="pe-where-l">Where</span>` +
        `<div class="pe-place" role="group" aria-labelledby="pe-where-l" style="--ds-k:var(--cat-${categoryOf(chosen.kind)})"><span class="pe-placeline">${placeLine(chosen)}</span>` +
        `<button type="button" class="ds-button ds-button--gray ds-button--sm" data-act="clear-place">Change</button></div></div>`;
    }
    return `<div class="ds-field"><label class="ds-label" for="pe-where">Where</label>` +
      `<input class="ds-input" id="pe-where" type="search" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" ` +
      `placeholder="${store.places().length ? "Search this trip's places, or name a new one" : "Name a place"}" aria-controls="pe-found">` +
      `<div class="pe-found" id="pe-found" role="group" aria-label="Places found"></div></div>`;
  }

  function paintFound() {
    const box = body.querySelector("#pe-found");
    const input = body.querySelector("#pe-where");
    if (!box || !input) return;
    const q = fold(input.value).trim();
    if (!q) { box.innerHTML = ""; return; }
    const hits = [];
    for (const p of store.places()) {
      const n = fold(p.name);
      const at = n.indexOf(q);
      if (at < 0) continue;
      hits.push({ p, rank: at === 0 ? 0 : n[at - 1] === " " ? 1 : 2 });
    }
    hits.sort((a, b) => a.rank - b.rank || String(a.p.name).localeCompare(String(b.p.name)));
    // A name no place has exactly: offer to make the place, with the name as typed.
    const typed = input.value.replace(/\s+/g, " ").trim();
    const exact = hits.some(({ p }) => fold(p.name).trim() === q);
    const make = exact ? "" :
      `<button type="button" class="pe-hit pe-make" data-act="new-place">${PLUS}<span class="pe-placen">Add “${esc(clip(typed, 40))}” as a new place</span></button>`;
    box.innerHTML = hits.slice(0, FOUND_MAX).map(({ p }) =>
        `<button type="button" class="pe-hit" data-place="${esc(p.id)}" style="--ds-k:var(--cat-${categoryOf(p.kind)})">${placeLine(p)}</button>`).join("") +
      (hits.length > FOUND_MAX ? `<p class="pe-more">${hits.length - FOUND_MAX} more: keep typing.</p>` : "") +
      make;
  }

  // The place sheet over this one, the typed name already in it; saved, that place is this
  // plan's Where. The plan's kind says what kind of place it most likely is.
  async function newPlace() {
    const input = body.querySelector("#pe-where");
    const typed = input ? input.value.replace(/\s+/g, " ").trim() : "";
    const { openPlaceEditor } = await import("./place-editor.js");
    openPlaceEditor({
      name: typed,
      kind: PLACE_KIND_OF[F.kind] || "",
      onSaved: (id) => {
        if (!body.isConnected) return;
        F.placeId = id;
        body.querySelector(".pe-where").innerHTML = whereHtml();
        const again = body.querySelector('[data-act="clear-place"]');
        if (again) again.focus({ preventScroll: true });
      },
    });
  }

  function paintForm() {
    foot.innerHTML = `<button type="button" class="btn ds-button ds-button--white ds-button--sm" data-act="save">${was ? "Save" : "Add"}</button>`;
    body.innerHTML =
      `<div class="ds-field"><label class="ds-label" for="pe-title">What</label>` +
        `<input class="ds-input ds-input--lg" id="pe-title" type="text" maxlength="${TITLE_MAX}" autocomplete="off" enterkeyhint="done" placeholder="Dinner by the harbor">` +
        `<p class="pe-say" data-say="title" role="alert" hidden></p></div>` +
      `<div class="ds-field" role="group" aria-labelledby="pe-kind-l"><span class="ds-label pe-label" id="pe-kind-l">Kind</span>` +
        `<div class="pe-kindwrap pe-kinds">${kindChips()}</div></div>` +
      `<div class="ds-field" role="group" aria-labelledby="pe-day-l"><span class="ds-label pe-label" id="pe-day-l">Day</span>` +
        `<div class="pe-chiprow pe-days">${dayChips()}</div>` +
        `<p class="pe-say" data-say="day" role="alert" hidden></p></div>` +
      `<div class="pe-pair">` +
        `<div class="ds-field"><label class="ds-label" for="pe-time">Starts</label><input class="ds-input num" id="pe-time" type="time"></div>` +
        `<div class="ds-field"><label class="ds-label" for="pe-end">Ends</label><input class="ds-input num" id="pe-end" type="time"></div>` +
      `</div>` +
      `<div class="pe-zones"></div>` +
      `<p class="pe-hint" id="pe-hint"></p>` +
      `<p class="pe-say" data-say="time" role="alert" hidden></p>` +
      `<button type="button" class="pe-morebtn" data-act="toggle-more" aria-expanded="${moreOpen}"><span>More details</span>${CHEVRON_ICO}</button>` +
      `<div class="pe-morefields" id="pe-more"${moreOpen ? "" : " hidden"}>` +
        `<div class="ds-field"><label class="ds-label" for="pe-endday">Ends on</label>` +
          `<div class="ds-select-wrap"><select class="ds-select" id="pe-endday">${endOptions()}</select></div>` +
          `<p class="pe-say" data-say="end" role="alert" hidden></p></div>` +
        `<div class="pe-where">${whereHtml()}</div>` +
        `<div class="ds-field"><label class="ds-label" for="pe-note">Note</label>` +
          `<textarea class="ds-textarea" id="pe-note" maxlength="${DETAIL_MAX}" rows="3" placeholder="A booking number, what to bring"></textarea>` +
          `<p class="pe-say" data-say="detail" role="alert" hidden></p></div>` +
        `<div class="ds-field"><label class="ds-label" for="pe-link">Link</label>` +
          `<input class="ds-input" id="pe-link" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="example.com/booking">` +
          `<p class="pe-say" data-say="url" role="alert" hidden></p></div>` +
      `</div>` +
      (was ? `<div class="pe-remove" id="pe-remove"></div>` : "");
    body.querySelector("#pe-title").value = F.title;
    body.querySelector("#pe-time").value = F.time;
    body.querySelector("#pe-end").value = F.endTime;
    body.querySelector("#pe-note").value = F.detail;
    body.querySelector("#pe-link").value = F.url;
    paintZones();
    paintHint();
    paintRemove();
    syncSave();
    // The chosen day is in view, wherever in a long trip it is.
    const on = body.querySelector('.pe-day[aria-pressed="true"]');
    const row = body.querySelector(".pe-days");
    if (on && row) row.scrollLeft = Math.max(0, on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2);
  }

  function paintHint() {
    const p = body.querySelector("#pe-hint");
    if (!p) return;
    const words = hint();
    p.textContent = words; p.hidden = !words;
  }

  function paintRemove() {
    const box = body.querySelector("#pe-remove");
    if (!box) return;
    box.innerHTML = asking
      ? `<p class="pe-ask" id="pe-ask">Remove “${esc(clip(was.title || "this plan", 60))}”? The notes on it go with it.</p>` +
        `<div class="pe-askrow"><button type="button" class="ds-button ds-button--gray" data-act="keep">Keep it</button>` +
        `<button type="button" class="ds-button ds-button--red" data-act="remove-yes" data-destroys>Remove</button></div>`
      : `<button type="button" class="ds-button ds-button--red ds-button--block" data-act="remove" data-destroys>Remove this plan</button>`;
  }

  function say(field, words) {
    for (const p of body.querySelectorAll(".pe-say")) { p.hidden = true; p.textContent = ""; }
    if (!field) return;
    if ((field === "detail" || field === "url" || field === "end") && !moreOpen) setMore(true);
    const p = body.querySelector(`[data-say="${field}"]`);
    if (!p) return;
    p.textContent = words; p.hidden = false;
    const control = { title: "#pe-title", day: ".pe-day", time: "#pe-time", end: F.endTime || !F.endDay ? "#pe-end" : "#pe-endday", detail: "#pe-note", url: "#pe-link",
      fromzone: "#pe-fromzone", tozone: "#pe-tozone" }[field];
    const n = control && body.querySelector(control);
    if (n) n.focus({ preventScroll: true });
    p.scrollIntoView({ block: "nearest" });
  }

  function readControls() {
    F.title = body.querySelector("#pe-title").value;
    F.time = body.querySelector("#pe-time").value;
    F.endTime = body.querySelector("#pe-end").value;
    F.endDay = body.querySelector("#pe-endday").value;
    F.detail = body.querySelector("#pe-note").value;
    F.url = body.querySelector("#pe-link").value;
  }

  async function save() {
    if (busy) return;
    readControls();
    // A side opened and left without a zone: the sentence goes under it, not a guess.
    for (const side of ["from", "to"]) {
      if (Z[side] === "") { say(`${side}zone`, side === "from" ? "Choose the time zone it leaves from, or close it to use the trip's." : "Choose the time zone it arrives in, or close it to use the trip's."); return; }
    }
    const r = readPlan(F, { zone: zone(), endZone: endZone() });
    if (!r.event) { say(r.field, r.words); return; }
    say("", "");
    busy = true;
    syncSave();
    try {
      if (was) {
        const changes = changesOf(was, r.event);
        if (Object.keys(changes).length) await store.updateEvent(was.id, changes);
        sheet.close();
        if (onSaved) onSaved(was.id, F.day, { isNew: false });
      } else {
        const row = await store.addEvent(r.event);
        sheet.close();
        if (onSaved) onSaved(row.id, F.day, { isNew: true });
      }
    } catch (e) {
      console.warn("[plan] not saved", e);
      toast(was ? "That plan couldn't be changed." : "That plan couldn't be added.");
    } finally {
      busy = false;
      syncSave();
    }
  }

  async function remove() {
    if (busy) return;
    busy = true;
    try {
      await store.deleteEvent(was.id);
      sheet.close();
      if (onRemoved) onRemoved(was.id);
    } catch (e) {
      console.warn("[plan] not removed", e);
      toast("That plan couldn't be removed.");
    } finally {
      busy = false;
    }
  }

  // A sentence about a field is taken back once the person changes that field.
  const SAY_OF = { "pe-title": "title", "pe-time": "time", "pe-end": "end", "pe-endday": "end", "pe-note": "detail", "pe-link": "url",
    "pe-fromzone": "fromzone", "pe-tozone": "tozone" };
  function unsay(id) {
    const field = SAY_OF[id];
    const p = field && body.querySelector(`[data-say="${field}"]`);
    if (p && !p.hidden) { p.hidden = true; p.textContent = ""; }
    // The times answer for each other: a sentence under one is about both.
    if (id === "pe-time" || id === "pe-end" || id === "pe-endday") for (const f of ["time", "end"]) {
      const q = body.querySelector(`[data-say="${f}"]`);
      if (q && !q.hidden) { q.hidden = true; q.textContent = ""; }
    }
  }

  // The chosen day stays in view when the sheet changes width (a phone turned on its side).
  const showChosen = () => {
    for (const on of body.querySelectorAll('.pe-day[aria-pressed="true"]')) showChip(on);
  };
  const resized = typeof ResizeObserver === "function" ? new ResizeObserver(showChosen) : null;
  if (resized) resized.observe(body);

  // Clicks anywhere in the sheet: the form's and the action beside the title.
  sheet.el.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-act],[data-kind],[data-day],[data-place]");
    if (!t || !sheet.el.contains(t)) return;
    if (t.dataset.kind) {
      F.kind = t.dataset.kind;
      for (const b of body.querySelectorAll(".pe-kind")) b.setAttribute("aria-pressed", String(b.dataset.kind === F.kind));
      // A flight or a transit offers the zones; any other kind hides them while both are closed.
      readControls();
      paintZones();
      return;
    }
    if (t.dataset.day) {
      readControls();
      F.day = t.dataset.day;
      if (F.endDay && F.endDay <= F.day) { F.endDay = ""; autoEnd = false; }
      for (const b of body.querySelectorAll(".pe-day")) b.setAttribute("aria-pressed", String(b.dataset.day === F.day));
      syncEnd();
      showChip(t);
      { const p = body.querySelector('[data-say="day"]'); if (p) { p.hidden = true; p.textContent = ""; } }
      return;
    }
    if (t.dataset.place) {
      F.placeId = t.dataset.place;
      body.querySelector(".pe-where").innerHTML = whereHtml();
      const again = body.querySelector('[data-act="clear-place"]');
      if (again) again.focus({ preventScroll: true });
      return;
    }
    const act = t.dataset.act;
    if (act === "save") save();
    else if (act === "toggle-more") setMore(!moreOpen);
    else if (act === "new-place") newPlace();
    else if (act === "set-dates") setDates();
    else if (act === "zone-open") openZone(t.dataset.side);
    else if (act === "zone-close") closeZone(t.dataset.side);
    else if (act === "clear-place") {
      F.placeId = "";
      body.querySelector(".pe-where").innerHTML = whereHtml();
      const input = body.querySelector("#pe-where");
      if (input) input.focus({ preventScroll: true });
    } else if (act === "remove") {
      asking = true; paintRemove();
      focusKeeper(body.querySelector("#pe-remove"));
      body.querySelector("#pe-remove").scrollIntoView({ block: "nearest" });
    } else if (act === "keep") {
      asking = false; paintRemove();
      const again = body.querySelector('[data-act="remove"]');
      if (again) again.focus({ preventScroll: true });
    } else if (act === "remove-yes") remove();
  });
  body.addEventListener("input", (ev) => {
    if (ev.target.id === "pe-where") { paintFound(); return; }
    if (ev.target.id === "pe-fromzone" || ev.target.id === "pe-tozone") return;   // the picker's own
    if (ev.target.id === "pe-title") syncSave();
    unsay(ev.target.id);
    if (ev.target.id === "pe-time" || ev.target.id === "pe-end") { readControls(); syncEnd(); }
  });
  body.addEventListener("change", (ev) => {
    if (ev.target.id !== "pe-endday") return;
    unsay("pe-endday");
    readControls();
    autoEnd = false;      // the person picked: it is theirs now
    syncEnd();            // …unless they picked the same day for an end that wraps
  });
  // Enter in a one-line field saves, as the keyboard's "done" says it will.
  body.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.isComposing) return;
    const id = ev.target.id;
    if (id === "pe-title" || id === "pe-link" || id === "pe-time" || id === "pe-end") { ev.preventDefault(); save(); }
    else if (id === "pe-fromzone" || id === "pe-tozone") ev.preventDefault();   // Enter chooses in the list; it never saves
    else if (id === "pe-where") {
      ev.preventDefault();
      const first = body.querySelector(".pe-hit");
      if (first) first.click();
    } else if (id === "pe-first" || id === "pe-last") { ev.preventDefault(); setDates(); }
  });

  if (!was && !hasDates(trip)) paintDates();
  else startForm();
  return api;
}

// ── styles: .pe-* only, from the shell's tokens, injected once ─────────────────────────────
// The place form (place-editor.js) is built from the same parts and asks for them here.
let injected = false;
export function injectFormStyles() {
  if (injected || document.getElementById("pe-styles")) { injected = true; return; }
  injected = true;
  const s = document.createElement("style");
  s.id = "pe-styles";
  s.textContent = PE_CSS;
  document.head.append(s);
  // The time zone's control brings its own sheet of styles (the trips pages link the same one).
  if (!document.querySelector('link[href="/css/zone-picker.css"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "/css/zone-picker.css";
    document.head.append(l);
  }
}

const PE_CSS = `
/* Keep legacy .pe rules scoped for screens still using .pe without .ds. */
.pe:not(.ds) { display: flex; flex-direction: column; gap: var(--sp-4); padding-bottom: var(--sp-5); }
.pe:not(.ds) .pe-lead { margin: 0; color: var(--ink-2); line-height: 1.45; }
.pe:not(.ds) .pe-label { font-size: 12.5px; font-weight: 650; letter-spacing: .03em; color: var(--ink-3); text-transform: uppercase; }
.pe:not(.ds) .pe-pair { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
.pe:not(.ds) .pe-dates { grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); }
.pe:not(.ds) .pe-pair .field, .pe:not(.ds) .pe-pair input { min-width: 0; }
.pe:not(.ds) .pe-wide { width: 100%; justify-content: center; }
.pe:not(.ds) .pe-say { margin: 0; color: var(--warn); font-size: 14px; font-weight: 600; line-height: 1.35; }
.pe:not(.ds) .pe-say::before { content: "! "; font-weight: 800; }
.pe:not(.ds) .pe-hint { margin: calc(var(--sp-2) * -1) 0 0; color: var(--ink-3); font-size: 14px; line-height: 1.35; }
.pe:not(.ds) .pe-kind .ico, .pe:not(.ds) .pe-kindg { width: 18px; height: 18px; flex: 0 0 auto; }
.pe:not(.ds) .chip[aria-pressed="true"] { border-width: 2px; font-weight: 750; padding: 0 calc(var(--sp-4) - 1px); }
.pe:not(.ds) .pe-day { flex: 0 0 auto; gap: 6px; }
.pe:not(.ds) .pe-dow { font-weight: 600; }
.pe:not(.ds) .pe-dmon { font-size: 12px; color: var(--ink-3); font-weight: 650; }
.pe:not(.ds) .pe-day[aria-pressed="true"] .pe-dmon { color: inherit; }
.pe:not(.ds) .pe-place { display: flex; align-items: center; gap: var(--sp-3); min-height: var(--tap);
  padding: var(--sp-2) var(--sp-3); border: 1px solid var(--line-strong); border-radius: var(--r-sm); background: var(--surface); }
.pe:not(.ds) .pe-placeline, .pe:not(.ds) .pe-hit { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; flex: 1 1 auto; }
.pe:not(.ds) .pe-placeg, .pe:not(.ds) .pe-place .ico, .pe:not(.ds) .pe-hit .ico { width: 18px; height: 18px; flex: 0 0 auto; color: var(--ink-2); }
.pe:not(.ds) .pe-placen { font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.pe:not(.ds) .pe-placea { color: var(--ink-3); font-size: 13.5px; white-space: nowrap; flex: 0 0 auto; }
.pe:not(.ds) .pe-found { display: flex; flex-direction: column; }
.pe:not(.ds) .pe-hit { min-height: var(--tap); padding: var(--sp-2) var(--sp-3); border: 0; border-bottom: 1px solid var(--line);
  background: transparent; color: inherit; text-align: left; font: inherit; width: 100%; }
.pe:not(.ds) .pe-hit[data-press="1"] { background: var(--surface-2); }
@media (hover: hover) and (pointer: fine) {
  .pe:not(.ds) .pe-hit:active { background: var(--surface-2); }
}
.pe:not(.ds) .pe-make .pe-placen { white-space: normal; overflow: visible; overflow-wrap: anywhere; text-align: left; }
.pe:not(.ds) .pe-more { margin: 0; padding: var(--sp-2) var(--sp-3); color: var(--ink-3); font-size: 14px; }
.pe:not(.ds) .pe-zones { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: calc(var(--sp-2) * -1); }
.pe:not(.ds) .pe-zopen { display: inline-flex; align-items: center; gap: var(--sp-2); align-self: flex-start; min-height: var(--tap);
  padding: 0 var(--sp-1); border: 0; background: transparent; color: var(--accent); font: inherit; font-weight: 650; }
.pe:not(.ds) .pe-zopen .ico { width: 18px; height: 18px; flex: 0 0 auto; }
.pe:not(.ds) .pe-zhead { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); }
.pe:not(.ds) .pe-zhead label { font-size: 12.5px; font-weight: 650; letter-spacing: .03em; color: var(--ink-3); text-transform: uppercase; }
.pe:not(.ds) .pe-zclose { min-height: var(--tap); padding: 0 var(--sp-1); border: 0; background: transparent; color: var(--ink-2);
  font: inherit; font-size: 14px; text-decoration: underline; text-underline-offset: 3px; }
.pe:not(.ds) .pe-remove { margin-top: var(--sp-3); padding-top: var(--sp-4); border-top: 1px solid var(--line); }
.pe:not(.ds) .pe-ask { margin: 0 0 var(--sp-3); color: var(--ink); line-height: 1.4; }
.pe:not(.ds) .pe-askrow { display: flex; gap: var(--sp-3); }
.pe:not(.ds) .pe-askrow .btn { flex: 1 1 0; justify-content: center; }
.pe-where:empty, .pe-zones:empty { display: none; }

/* Design-system plan sheet (.pe.ds & .pe-foot.ds) */
.pe.ds { display: flex; flex-direction: column; gap: 18px; padding-bottom: 12px; }
.pe-foot.ds .btn.ds-button--white {
  background: var(--solid); color: var(--on-solid);
  border: 1px solid transparent; border-radius: var(--radius-full);
  min-height: var(--control-44); padding: 0 18px;
  font-family: var(--type-ui); font-size: var(--size-14); font-weight: 600;
  white-space: nowrap;
}
.pe-foot.ds .btn.ds-button--white:not(:disabled)[data-press="1"] { background: var(--solid-hover); }
@media (hover: hover) and (pointer: fine) {
  .pe-foot.ds .btn.ds-button--white:not(:disabled):active { background: var(--solid-hover); }
}
.pe-foot.ds .btn.ds-button--white:disabled {
  cursor: not-allowed; opacity: 1; transform: none; border-color: transparent; background: var(--fill); color: var(--ink-4); box-shadow: none;
}
.pe.ds .pe-lead { margin: 0; color: var(--ink-2); font-size: var(--size-14); line-height: 1.45; }
.pe.ds .pe-label { text-transform: none; letter-spacing: 0; color: var(--ink-2); }
.pe.ds .pe-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.pe.ds .pe-dates { grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); }
.pe.ds .pe-pair .ds-field, .pe.ds .pe-pair input { min-width: 0; }
.pe.ds .pe-say { margin: 0; color: var(--negative); font-size: var(--size-14); font-weight: 500; line-height: 1.35; }
.pe.ds .pe-say::before { content: "! "; font-weight: 700; }
.pe.ds .pe-hint { margin: -8px 0 0; color: var(--ink-2); font-size: var(--size-14); line-height: 1.4; }
.pe.ds .pe-kindwrap { display: flex; flex-wrap: wrap; gap: 8px; }
.pe.ds .pe-morebtn {
  display: flex; align-items: center; justify-content: space-between; width: 100%;
  min-height: var(--control-44); padding: 10px 0; border: 0; border-top: 1px solid var(--hair);
  background: transparent; color: var(--ink-1); font-family: var(--type-ui);
  font-size: var(--size-14); font-weight: 600; cursor: pointer;
}
.pe.ds .pe-chev { width: 16px; height: 16px; flex: 0 0 auto; color: var(--ink-2); transition: transform var(--dur-150) var(--ease-standard); }
.pe.ds .pe-morebtn[aria-expanded="true"] .pe-chev { transform: rotate(180deg); }
.pe.ds .pe-morefields { display: flex; flex-direction: column; gap: 18px; }
.pe.ds .pe-morefields[hidden] { display: none; }
.pe.ds .pe-chiprow {
  display: flex; flex-wrap: nowrap; gap: 8px;
  overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
  padding: 2px 0;
}
.pe.ds .pe-chiprow::-webkit-scrollbar { display: none; }
.pe.ds .pe-chip {
  appearance: none;
  flex: 0 0 auto;
  max-width: 100%; overflow: hidden;
  display: inline-flex; align-items: center; gap: 6px;
  min-height: var(--control-44); padding: 0 14px;
  border-radius: var(--radius-full);
  border: 1px solid var(--edge);
  background: transparent;
  color: var(--ink-1);
  font-family: var(--type-ui); font-size: var(--size-14); font-weight: 500;
  white-space: nowrap; cursor: pointer;
  transition: background var(--dur-150) var(--ease-standard), color var(--dur-150) var(--ease-standard), border-color var(--dur-150) var(--ease-standard);
}
.pe.ds .pe-kind > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pe.ds .pe-chip[data-press="1"] { background: var(--fill-active); }
@media (hover: hover) and (pointer: fine) {
  .pe.ds .pe-chip:hover { background: var(--fill); }
  .pe.ds .pe-chip:active { background: var(--fill-active); }
}
.pe.ds .pe-chip[aria-pressed="true"] {
  background: var(--ds-k, var(--solid)); color: var(--on-solid); border-color: var(--ds-k, var(--solid)); font-weight: 600;
}
.pe.ds .pe-kind .ico, .pe.ds .pe-kindg { width: 16px; height: 16px; flex: 0 0 auto; color: var(--ds-k, var(--ink-2)); }
.pe.ds .pe-kind[aria-pressed="true"] .ico, .pe.ds .pe-kind[aria-pressed="true"] .pe-kindg { color: var(--on-solid); }
.pe.ds .pe-dow { font-weight: 500; }
.pe.ds .pe-dnum { font-family: var(--type-mono); font-size: var(--size-14); }
.pe.ds .pe-dmon { font-size: var(--size-12); color: var(--ink-2); font-weight: 500; }
.pe.ds .pe-day[aria-pressed="true"] .pe-dmon { color: inherit; }
.pe.ds .pe-place {
  display: flex; align-items: center; gap: 12px; min-height: var(--control-44);
  padding: 8px 0; border-bottom: 1px solid var(--hair);
}
.pe.ds .pe-placeline, .pe.ds .pe-hit { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1 1 auto; }
.pe.ds .pe-placeg, .pe.ds .pe-place .ico, .pe.ds .pe-hit .ico { width: 18px; height: 18px; flex: 0 0 auto; color: var(--ds-k, var(--ink-2)); }
.pe.ds .pe-placen { font-weight: 500; color: var(--ink-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.pe.ds .pe-placea { color: var(--ink-2); font-size: var(--size-12); white-space: nowrap; flex: 0 0 auto; }
.pe.ds .pe-found { display: flex; flex-direction: column; }
.pe.ds .pe-hit {
  min-height: var(--control-44); padding: 10px 4px;
  border: 0; border-bottom: 1px solid var(--hair);
  background: transparent; color: inherit; text-align: left; font: inherit; width: 100%; cursor: pointer;
}
.pe.ds .pe-hit[data-press="1"] { background: var(--fill-active); }
@media (hover: hover) and (pointer: fine) {
  .pe.ds .pe-hit:hover { background: var(--fill); }
  .pe.ds .pe-hit:active { background: var(--fill-active); }
}
.pe.ds .pe-make .pe-placen { white-space: normal; overflow: visible; overflow-wrap: anywhere; text-align: left; }
.pe.ds .pe-more { margin: 0; padding: 10px 4px; color: var(--ink-2); font-size: var(--size-14); }
.pe.ds .pe-zones { display: flex; flex-direction: column; gap: 12px; margin-top: -6px; }
.pe.ds .pe-zopen {
  display: inline-flex; align-items: center; gap: 8px; align-self: flex-start; min-height: var(--control-44);
  padding: 0 4px; border: 0; background: transparent; color: var(--ink-1);
  font-family: var(--type-ui); font-size: var(--size-14); font-weight: 500; cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .pe.ds .pe-zopen:hover { text-decoration: underline; text-underline-offset: 3px; }
}
.pe.ds .pe-zopen .ico { width: 16px; height: 16px; flex: 0 0 auto; color: var(--ink-2); }
.pe.ds .pe-zhead { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.pe.ds .pe-zclose {
  min-height: var(--control-44); padding: 0 4px; border: 0; background: transparent;
  color: var(--ink-2); font: inherit; font-size: var(--size-12);
  text-decoration: underline; text-underline-offset: 3px; cursor: pointer;
}
.pe.ds .tr-zone-list { background: var(--chrome); border-color: var(--edge-strong); box-shadow: var(--shadow-pop); border-radius: var(--radius-12); }
.pe.ds .tr-zone-opt[aria-selected="true"] { background: var(--fill-active); box-shadow: inset 3px 0 0 var(--solid); }
.pe.ds .tr-zone-city { color: var(--ink-1); }
.pe.ds .tr-zone-where, .pe.ds .tr-zone-none { color: var(--ink-2); }
.pe.ds .pe-remove { margin-top: 8px; padding-top: 18px; border-top: 1px solid var(--hair); }
.pe.ds .pe-ask { margin: 0 0 12px; color: var(--ink-1); font-size: var(--size-14); line-height: 1.45; }
.pe.ds .pe-askrow { display: flex; gap: 10px; }
.pe.ds .pe-askrow > .ds-button { flex: 1 1 0; justify-content: center; }
@media (prefers-reduced-motion: reduce) {
  .pe.ds .pe-chip, .pe.ds .pe-chev { transition: none; }
}
`;

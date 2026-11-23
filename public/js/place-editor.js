// place-editor.js: the sheet a place is added, changed and removed in, by hand.
//
//   import { openPlaceEditor } from "./place-editor.js";
//   openPlaceEditor({});                                   // a new place
//   openPlaceEditor({ name: "Tide cafe", kind: "food", onSaved: (id) => … });   // from a plan's Where
//   openPlaceEditor({ placeId, onRemoved: () => … });      // change or remove one
//
// The rules (what the form's values mean, the id a new place gets, what a change writes, what
// can be read out of a map link) are place-form.js, which has no DOM and is checked in node.
// This file is the form on screen and the three writes, each through the store, so a place
// made with no signal waits on the phone like a purchase does.
//
// A place needs a name and a kind. Everything else is optional, the pin included: a place
// with no pin is in the list, has a page, and can be a plan's Where.

import { store } from "./store.js";
import { openSheet, focusKeeper } from "./sheet.js";
import { toast } from "./toast.js";
import { esc, clip } from "./util.js";
import { getIcon, categoryOf } from "./icons.js";
import { readAreas } from "./areas.js";
import { injectFormStyles } from "./plan-editor.js";
import { canPickSpot, pickSpot } from "./spot-picker.js";
import {
  NAME_MAX, ADDRESS_MAX, WHY_MAX, KIND_WORDS, subkindsFor, firstSubkind, placeId, readPlace, formOfPlace,
  placeChanges, readMapLink, isShortMapLink, isViewOnly, pinWords, pinOutsideArea, inUseWords, areaChipList,
} from "./place-form.js";

const KIND_WORD = Object.fromEntries(KIND_WORDS);
const TAIL = "abcdefghijklmnopqrstuvwxyz0123456789";
const PIN_ICO = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s6.5-6 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15 12 21 12 21Z"/><circle cx="12" cy="10.5" r="2.3"/></svg>';
const CHEVRON_ICO = '<svg class="ico pf-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

/** Six of [a-z0-9]: what keeps two places of one name two rows. */
function tail() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => TAIL[b % TAIL.length]).join("");
}

let open = null;   // one place sheet at a time

/**
 * Open the sheet.
 *   placeId    the place to change; none for a new one
 *   name, kind for a new place, what is already known (a name typed in a plan's Where)
 *   onSaved    (id) after a place is added or changed
 *   onRemoved  (id) after one is removed
 */
export function openPlaceEditor({ placeId: editId = null, name = "", kind = "", onSaved = null, onRemoved = null } = {}) {
  if (open) return open;
  injectFormStyles();
  injectStyles();
  if (!store.trip()) { toast("This trip hasn't reached this phone yet."); return null; }
  const was = editId ? store.place(editId) : null;
  if (editId && !was) { toast("That place isn't on this phone any more."); return null; }

  const body = document.createElement("form");
  body.className = "pe pf ds";
  body.noValidate = true;
  body.addEventListener("submit", (ev) => ev.preventDefault());
  const foot = document.createElement("div");
  foot.className = "pe-foot pf-foot ds";

  // The form's values, kept here and written back into the controls by paint().
  const F = was ? formOfPlace(was) : { name: String(name || ""), kind: KIND_WORD[kind] ? kind : "", subkind: KIND_WORD[kind] ? firstSubkind(kind) : "", area: "", address: "", why: "", link: "", lat: null, lng: null };
  let busy = false;
  let asking = "";   // "" | "ask" (Remove this place?) | "held" (it can't be removed yet)
  let moreOpen = !!(was && (F.area || F.why || F.link));

  const hasPin = () => F.lat !== null && F.lng !== null;
  // A PIN FROM THE LINK (a stranger's walk, 16 Nov). A link that names the place itself (a Google
  // place's !3d/!4d, geo:, coordinates, Apple's coordinate or ll, an OpenStreetMap marker) places it
  // as it is pasted, and says so; one that names only where its map was looking keeps the offer.
  // Never over a pin the person put there; a pin taken off isn't put back by the same link; a link
  // emptied takes the pin it placed with it.
  let pinFromLink = false;
  let letGoOf = "";            // the link whose pin the person took off
  function placeFromLink() {
    const spot = linkSpot();
    const text = `${F.link}\n${F.address}`;
    if (spot && !isViewOnly(spot.read) && (!hasPin() || pinFromLink) && text !== letGoOf) {
      F.lat = spot.read.lat; F.lng = spot.read.lng;
      pinFromLink = true;
    } else if (pinFromLink && (!spot || isViewOnly(spot.read))) {
      // The link it came from is gone (emptied, or now one that names only a view).
      F.lat = null; F.lng = null;
      pinFromLink = false;
    }
  }
  // The trip's areas, as chips: a region, then the neighborhoods under it, in the trip's order,
  // adding the parent name whenever two areas share a name.
  const areaChips = () => areaChipList(store.areas());

  const sheet = openSheet({
    title: was ? "Change place" : "Add a place",
    contentEl: body,
    footEl: foot,
    // The handle and the backdrop are the ways out, as on the plan's form: no X beside the
    // action, and no swipe over the fields.
    dragFrom: "handle",
    closeButton: false,
    onOpen: () => {
      // Keep initial focus on the sheet itself so no chip paints a focus ring on open and the
      // sheet stays at its compact natural height until a text field is tapped.
    },
    onClose: () => { if (open === api) open = null; },
  });
  const api = { close: () => sheet.close(), el: sheet.el };
  open = api;

  // ── the parts that repaint on their own ──────────────────────────────────────────────────
  const kindChips = () => KIND_WORDS.map(([k, word]) =>
    `<button type="button" class="chip pe-kind pf-kind" data-kind="${k}" aria-pressed="${F.kind === k}"` +
    ` style="--ds-k:var(--cat-${categoryOf(k)});--ds-k-on:var(--cat-${categoryOf(k)}-on)">` +
    `${getIcon(k, firstSubkind(k), { cls: "pe-kindg" })}<span>${word}</span></button>`).join("");

  // "What kind of food": the kind's own list, the first already chosen, so that choosing the
  // kind alone is enough. Absent until a kind is chosen.
  function subHtml() {
    if (!F.kind) return "";
    const c = categoryOf(F.kind);
    return `<div class="field" role="group" aria-labelledby="pf-sub-l"><span class="pe-label" id="pf-sub-l">What kind of ${esc(KIND_WORD[F.kind].toLowerCase())}</span>` +
      `<div class="pf-wrap" style="--ds-k:var(--cat-${c});--ds-k-on:var(--cat-${c}-on)">` + subkindsFor(F.kind).map((s) =>
        `<button type="button" class="chip pf-sub" data-sub="${esc(s.id)}" aria-pressed="${F.subkind === s.id}"><span>${esc(s.label)}</span></button>`).join("") +
      `</div></div>`;
  }

  function areaHtml() {
    const chips = areaChips();
    // A place already in an area the trip no longer has keeps that area on offer, by its id.
    if (F.area && !chips.some((c) => c.id === F.area)) chips.push({ id: F.area, name: readAreas(store.areas()).label(F.area) || F.area });
    if (!chips.length) return "";
    return `<div class="field" role="group" aria-labelledby="pf-area-l"><span class="pe-label" id="pf-area-l">Area</span>` +
      `<div class="pf-wrap pf-areas">` +
      [{ id: "", name: "No area" }, ...chips].map((c) =>
        `<button type="button" class="chip pf-area" data-area="${esc(c.id)}" aria-pressed="${F.area === c.id}"><span>${esc(clip(c.name, 40))}</span></button>`).join("") +
      `</div></div>`;
  }

  // What the Link (or a pasted Address) says about where the place is, read from its own text.
  function linkSpot() {
    for (const text of [F.link, F.address]) {
      const read = readMapLink(text);
      if (read) return { read, coords: read.from === "coordinates" || read.from === "geo" };
    }
    return null;
  }

  // On the map: an explicit action when unpinned with the hint underneath, or the chosen spot.
  function pinHtml() {
    const pick = canPickSpot(store);
    const spot = linkSpot();
    const same = spot && hasPin() && Math.abs(spot.read.lat - F.lat) < 1e-6 && Math.abs(spot.read.lng - F.lng) < 1e-6;
    let h = `<div class="pf-pin">`;
    if (hasPin()) {
      const line = pinFromLink
        ? `Placed from the ${spot && spot.coords ? "coordinates" : "link"}, at <span class="num">${esc(pinWords(F.lat, F.lng))}</span>.`
        : `On the map at <span class="num">${esc(pinWords(F.lat, F.lng))}</span>.`;
      h += `<p class="pf-pinline" id="pf-pinline">${line}</p><div class="pf-pinacts">`;
      if (pick) h += `<button type="button" class="btn ds-button ds-button--gray" data-act="pick">${pinFromLink ? "Change" : "Move the pin"}</button>`;
      if (spot && !same) h += `<button type="button" class="btn ds-button ds-button--gray" data-act="use-link">${spot.coords ? "Use these coordinates" : "Use this link's location"}</button>`;
      h += `<button type="button" class="btn ds-button ds-button--gray" data-act="unpin">Take it off the map</button></div>`;
    } else if (pick) {
      h += `<button type="button" class="btn ds-button ds-button--gray ds-button--block pf-mapbtn" data-act="pick">${PIN_ICO}<span>Put it on the map</span></button>`;
      if (spot && !same) h += `<div class="pf-pinacts"><button type="button" class="btn ds-button ds-button--gray" data-act="use-link">${spot.coords ? "Use these coordinates" : "Use this link's location"}</button></div>`;
      h += `<p class="pf-pinhint" id="pf-pinline">It shows in the list either way.</p>`;
    } else {
      h += `<button type="button" class="btn ds-button ds-button--gray ds-button--block pf-mapbtn" data-pin-wait="1" disabled aria-describedby="pf-pinline">${PIN_ICO}<span>Put it on the map</span></button>`;
      if (spot && !same) h += `<div class="pf-pinacts"><button type="button" class="btn ds-button ds-button--gray" data-act="use-link">${spot.coords ? "Use these coordinates" : "Use this link's location"}</button></div>`;
      h += `<p class="pf-pinhint" id="pf-pinline">This trip has no map yet. Paste a map link or coordinates in Address or Link. It shows in the list either way.</p>`;
    }
    if (spot && !same && isViewOnly(spot.read)) h += `<p class="pf-pinnote">That link says where its map was looking, which may be beside the place. Check the pin after.</p>`;
    else if (!spot && isShortMapLink(F.link)) h += `<p class="pf-pinnote">A short map link doesn't say where it points. Open it and copy the long link${pick ? ", or put the pin on the map" : ""}.</p>`;
    return h + `<p class="pe-say" data-say="pin" role="alert" hidden></p></div>`;
  }

  function paintPin(keepSay = false) {
    const box = body.querySelector("#pf-pinbox");
    if (!box) return;
    const said = keepSay ? (box.querySelector('[data-say="pin"]') || {}).textContent || "" : "";
    box.innerHTML = pinHtml();
    if (said) { const p = box.querySelector('[data-say="pin"]'); p.textContent = said; p.hidden = false; }
  }

  // A pin that has left its area is said at once, where the pin is, not at Save.
  function sayPinPlace() {
    const p = body.querySelector('[data-say="pin"]');
    if (!p) return;
    const words = hasPin() ? pinOutsideArea(store.areas(), F.area, F.lat, F.lng) || "" : "";
    p.textContent = words; p.hidden = !words;
  }

  function syncSave() {
    const btn = foot.querySelector('[data-act="save"]');
    if (!btn) return;
    const inp = body.querySelector("#pf-name");
    const nameNow = String((inp ? inp.value : F.name) || "").trim();
    btn.disabled = busy || !nameNow;
    const why = !nameNow && !F.kind ? "Enter a name and choose a kind"
      : !nameNow ? "Enter a name"
      : !F.kind ? "Choose a kind"
      : "";
    if (why) {
      btn.setAttribute("title", why);
      btn.setAttribute("aria-description", why);
    } else {
      btn.removeAttribute("title");
      btn.removeAttribute("aria-description");
    }
  }

  function setMore(on) {
    moreOpen = !!on;
    const wrap = body.querySelector("#pf-more");
    const btn = body.querySelector('[data-act="toggle-more"]');
    if (wrap) wrap.hidden = !moreOpen;
    if (btn) btn.setAttribute("aria-expanded", String(moreOpen));
  }

  function paintForm() {
    foot.innerHTML = `<button type="button" class="btn ds-button ds-button--white ds-button--sm" data-act="save">${was ? "Save" : "Add"}</button>`;
    body.innerHTML =
      `<div class="field"><label for="pf-name">Name</label>` +
        `<input class="input ds-input" id="pf-name" type="text" maxlength="${NAME_MAX}" autocomplete="off" enterkeyhint="done" placeholder="Corner bakery">` +
        `<p class="pe-say" data-say="name" role="alert" hidden></p></div>` +
      `<div class="field" role="group" aria-labelledby="pf-kind-l"><span class="pe-label" id="pf-kind-l">Kind</span>` +
        `<div class="pf-wrap pf-kinds">${kindChips()}</div>` +
        `<p class="pe-say" data-say="kind" role="alert" hidden></p></div>` +
      `<div class="pf-subbox" id="pf-subbox">${subHtml()}</div>` +
      `<div class="field"><label for="pf-address">Address</label>` +
        `<input class="input ds-input" id="pf-address" type="text" maxlength="${ADDRESS_MAX}" autocomplete="off" enterkeyhint="done" placeholder="Street, or how to find it">` +
        `<p class="pe-say" data-say="address" role="alert" hidden></p></div>` +
      `<div class="field" role="group" aria-labelledby="pf-pin-l"><span class="pe-label" id="pf-pin-l">On the map</span>` +
        `<div id="pf-pinbox">${pinHtml()}</div></div>` +
      `<button type="button" class="pf-morebtn" data-act="toggle-more" aria-expanded="${moreOpen}"><span>More details</span>${CHEVRON_ICO}</button>` +
      `<div class="pf-morefields" id="pf-more"${moreOpen ? "" : " hidden"}>` +
        `<div class="pf-areabox" id="pf-areabox">${areaHtml()}</div>` +
        `<div class="field"><label for="pf-why">Note</label>` +
          `<textarea class="ds-textarea" id="pf-why" maxlength="${WHY_MAX}" rows="3" placeholder="Why it is on the list, what to order"></textarea>` +
          `<p class="pe-say" data-say="why" role="alert" hidden></p></div>` +
        `<div class="field"><label for="pf-link">Link</label>` +
          `<input class="input ds-input" id="pf-link" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="example.com">` +
          `<p class="pe-say" data-say="link" role="alert" hidden></p></div>` +
      `</div>` +
      (was ? `<div class="pe-remove" id="pf-remove"></div>` : "");
    body.querySelector("#pf-name").value = F.name;
    body.querySelector("#pf-address").value = F.address;
    body.querySelector("#pf-why").value = F.why;
    body.querySelector("#pf-link").value = F.link;
    paintRemove();
    sayPinPlace();
    syncSave();
  }

  function paintRemove() {
    const box = body.querySelector("#pf-remove");
    if (!box) return;
    const name = clip(was.name || "this place", 60);
    if (asking === "held") {
      box.innerHTML = `<p class="pe-ask" id="pf-ask" role="alert">${esc(inUseWords(was, store.placeUses(was.id)))}</p>` +
        `<div class="pe-askrow"><button type="button" class="btn ds-button ds-button--gray" data-act="keep">OK</button></div>`;
    } else if (asking === "ask") {
      const bought = store.placeUses(was.id).purchases;
      const also = bought ? ` ${bought === 1 ? "The purchase made here stays" : `The ${bought} purchases made here stay`}, without the place.` : "";
      box.innerHTML = `<p class="pe-ask" id="pf-ask">Remove “${esc(name)}”?${also}</p>` +
        `<div class="pe-askrow"><button type="button" class="btn ds-button ds-button--gray" data-act="keep">Keep it</button>` +
        `<button type="button" class="btn btn-danger ds-button ds-button--red" data-destroys data-act="remove-yes">Remove</button></div>`;
    } else {
      box.innerHTML = `<button type="button" class="btn btn-danger ds-button ds-button--red ds-button--block pe-wide" data-destroys data-act="remove">Remove this place</button>`;
    }
  }

  function say(field, words) {
    for (const p of body.querySelectorAll(".pe-say")) { p.hidden = true; p.textContent = ""; }
    if (!field) return;
    if ((field === "why" || field === "link") && !moreOpen) setMore(true);
    const p = body.querySelector(`[data-say="${field}"]`);
    if (!p) return;
    p.textContent = words; p.hidden = false;
    const control = { name: "#pf-name", kind: ".pf-kind", address: "#pf-address", why: "#pf-why", link: "#pf-link", pin: "#pf-pinbox .btn" }[field];
    const n = control && body.querySelector(control);
    if (n) n.focus({ preventScroll: true });
    p.scrollIntoView({ block: "nearest" });
  }

  function readControls() {
    F.name = body.querySelector("#pf-name").value;
    F.address = body.querySelector("#pf-address").value;
    F.why = body.querySelector("#pf-why").value;
    F.link = body.querySelector("#pf-link").value;
  }

  async function save() {
    if (busy) return;
    readControls();
    const r = readPlace(F, { areas: store.areas() });
    if (!r.place) { say(r.field, r.words); return; }
    say("", "");
    busy = true;
    syncSave();
    try {
      if (was) {
        const changes = placeChanges(was, r.place);
        if (Object.keys(changes).length) await store.updatePlace(was.id, changes);
        sheet.close();
        if (onSaved) onSaved(was.id);
      } else {
        let id = placeId(r.place.name, tail());
        while (store.place(id)) id = placeId(r.place.name, tail());
        await store.addPlace(id, r.place);
        sheet.close();
        if (onSaved) onSaved(id);
      }
    } catch (e) {
      console.warn("[place] not saved", e);
      toast(was ? "That place couldn't be changed." : "That place couldn't be added.");
    } finally {
      busy = false;
      syncSave();
    }
  }

  async function remove() {
    if (busy) return;
    // Something may have been pointed at it while the question was showing.
    const uses = store.placeUses(was.id);
    if (uses.events.length || uses.places.length) { asking = "held"; paintRemove(); focusKeeper(body.querySelector("#pf-remove")); return; }
    busy = true;
    try {
      await store.deletePlace(was.id);
      sheet.close();
      if (onRemoved) onRemoved(was.id);
    } catch (e) {
      console.warn("[place] not removed", e);
      toast("That place couldn't be removed.");
    } finally {
      busy = false;
    }
  }

  // The map, with a pin fixed in its middle: the person moves the map under it and says "Here".
  async function pick() {
    readControls();
    const spot = await pickSpot({ store, lat: F.lat, lng: F.lng, area: F.area, name: F.name.trim() });
    if (!spot || !body.isConnected) return;
    F.lat = spot.lat; F.lng = spot.lng;
    pinFromLink = false;
    paintPin();
    sayPinPlace();
    const again = body.querySelector('[data-act="pick"]');
    if (again) again.focus({ preventScroll: true });
  }

  // A sentence about a field is taken back once the person changes that field.
  const SAY_OF = { "pf-name": "name", "pf-address": "address", "pf-why": "why", "pf-link": "link" };
  function unsay(field) {
    const p = field && body.querySelector(`[data-say="${field}"]`);
    if (p && !p.hidden) { p.hidden = true; p.textContent = ""; }
  }

  sheet.el.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-act],[data-kind],[data-sub],[data-area]");
    if (!t || !sheet.el.contains(t)) return;
    if (t.dataset.kind) {
      if (F.kind !== t.dataset.kind) { F.kind = t.dataset.kind; F.subkind = firstSubkind(F.kind); }
      for (const b of body.querySelectorAll(".pf-kind")) b.setAttribute("aria-pressed", String(b.dataset.kind === F.kind));
      body.querySelector("#pf-subbox").innerHTML = subHtml();
      unsay("kind");
      syncSave();
      return;
    }
    if (t.dataset.sub) {
      F.subkind = t.dataset.sub;
      for (const b of body.querySelectorAll(".pf-sub")) b.setAttribute("aria-pressed", String(b.dataset.sub === F.subkind));
      return;
    }
    if (t.dataset.area !== undefined) {
      F.area = t.dataset.area;
      for (const b of body.querySelectorAll(".pf-area")) b.setAttribute("aria-pressed", String(b.dataset.area === F.area));
      sayPinPlace();
      return;
    }
    const act = t.dataset.act;
    if (act === "save") save();
    else if (act === "toggle-more") setMore(!moreOpen);
    else if (act === "pick") pick();
    else if (act === "use-link") {
      readControls();
      const spot = linkSpot();
      if (!spot) return;
      F.lat = spot.read.lat; F.lng = spot.read.lng;
      pinFromLink = false;
      paintPin();
      sayPinPlace();
      const next = body.querySelector("#pf-pinbox .btn");
      if (next) next.focus({ preventScroll: true });
    } else if (act === "unpin") {
      if (pinFromLink) letGoOf = `${F.link}\n${F.address}`;
      pinFromLink = false;
      F.lat = null; F.lng = null;
      paintPin();
      const next = body.querySelector("#pf-pinbox .btn") || body.querySelector("#pf-why");
      if (next) next.focus({ preventScroll: true });
    } else if (act === "remove") {
      const uses = store.placeUses(was.id);
      asking = uses.events.length || uses.places.length ? "held" : "ask";
      paintRemove();
      focusKeeper(body.querySelector("#pf-remove"));
      body.querySelector("#pf-remove").scrollIntoView({ block: "nearest" });
    } else if (act === "keep") {
      asking = ""; paintRemove();
      const again = body.querySelector('[data-act="remove"]');
      if (again) again.focus({ preventScroll: true });
    } else if (act === "remove-yes") remove();
  });
  body.addEventListener("input", (ev) => {
    unsay(SAY_OF[ev.target.id]);
    if (ev.target.id === "pf-name") syncSave();
    // What the Link or the Address says about the place's location is offered as it is typed.
    if (ev.target.id === "pf-link" || ev.target.id === "pf-address") { readControls(); placeFromLink(); paintPin(true); sayPinPlace(); }
  });
  // Enter in a one-line field saves, as the keyboard's "done" says it will.
  body.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.isComposing) return;
    const id = ev.target.id;
    if (id === "pf-name" || id === "pf-address" || id === "pf-link") { ev.preventDefault(); save(); }
  });

  paintForm();
  return api;
}

// ── styles: .pf-* only (the rest is the plan form's), from the shell's tokens, injected once ─
let injected = false;
function injectStyles() {
  if (injected || document.getElementById("pf-styles")) { injected = true; return; }
  injected = true;
  const s = document.createElement("style");
  s.id = "pf-styles";
  s.textContent = PF_CSS;
  document.head.append(s);
}

const PF_CSS = `
.pf.ds { display: flex; flex-direction: column; gap: 16px; }
.pf.ds .field { display: flex; flex-direction: column; gap: 6px; margin: 0; min-width: 0; }
.pf.ds .field > label, .pf.ds .pe-label {
  font-family: var(--type-ui); font-size: var(--size-14); font-weight: 500; line-height: 20px;
  color: var(--ink-2); text-transform: none; letter-spacing: 0; }
.pf.ds .ds-input, .pf.ds .ds-textarea {
  width: 100%; min-width: 0; border-radius: var(--radius-12);
  background: var(--well); border: 1px solid var(--edge); color: var(--ink-1);
  font-family: var(--type-ui); font-size: var(--size-16); line-height: 1.45; }
.pf.ds .ds-input { height: var(--control-44); padding: 0 14px; border-radius: var(--radius-16); }
.pf.ds .ds-textarea { min-height: 92px; padding: 10px 14px; border-radius: var(--radius-16); resize: vertical; }
.pf.ds .ds-input:focus-visible, .pf.ds .ds-textarea:focus-visible {
  outline: none; border-color: var(--edge-strong); box-shadow: 0 0 0 3px var(--ring-soft); }
.pf.ds .pe-say { margin: 4px 0 0; font-size: var(--size-14); line-height: 1.4; color: var(--negative); font-weight: 500; }
.pf.ds .pe-say[hidden] { display: none; }
.pf.ds .chip-row { gap: 8px; padding-block: 4px; }
.pf.ds .chip {
  flex: 0 0 auto; max-width: 100%; overflow: hidden;
  display: inline-flex; align-items: center; gap: 6px;
  min-height: var(--control-32); height: var(--control-32); padding: 0 12px;
  border-radius: var(--radius-full); background: var(--fill); border: 1px solid var(--edge);
  color: var(--ink-2); font-family: var(--type-ui); font-size: var(--size-14); font-weight: 600; }
.pf.ds .chip > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pf.ds .chip[aria-pressed="true"] { background: var(--ds-k, var(--solid)); border-color: var(--ds-k, var(--solid)); color: var(--ds-k-on, var(--on-solid)); }
.pf.ds .pe-kindg { width: 16px; height: 16px; flex: 0 0 auto; color: var(--ds-k, var(--ink-2)); }
.pf.ds .pf-kind[aria-pressed="true"] .pe-kindg { color: var(--ds-k-on, var(--on-solid)); }
.pf-subbox:empty, .pf-areabox:empty { display: none; }
/* Kinds, subkinds, and areas wrap so every choice is visible without a sideways hunt. */
.pf-wrap { display: flex; flex-wrap: wrap; gap: 8px; }
.pf.ds .pf-pin { display: flex; flex-direction: column; gap: 8px; padding: 0; border: 0; background: transparent; }
.pf.ds .pf-mapbtn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%;
  height: var(--control-44); padding: 0 14px; border-radius: var(--radius-16);
  border: 1px solid var(--edge); background: var(--fill); color: var(--ink-1);
  font-family: var(--type-ui); font-size: var(--size-14); font-weight: 600; cursor: pointer; }
.pf.ds .pf-mapbtn[data-press="1"] { background: var(--fill-active); }
@media (hover: hover) and (pointer: fine) {
  .pf.ds .pf-mapbtn:hover { background: var(--fill-hover); }
  .pf.ds .pf-mapbtn:active { background: var(--fill-active); }
}
.pf.ds .pf-mapbtn:disabled {
  cursor: not-allowed; opacity: 1; background: var(--fill); border-color: var(--hair); color: var(--ink-4); }
.pf.ds .pf-mapbtn:disabled .ico { color: var(--ink-4); }
.pf.ds .pf-mapbtn .ico { width: 16px; height: 16px; flex: 0 0 auto; color: var(--ink-2); }
.pf.ds .pf-pinline { margin: 0; color: var(--ink-1); font-size: var(--size-14); line-height: 1.45; }
.pf.ds .pf-pinhint { margin: 0; color: var(--ink-2); font-size: var(--size-14); line-height: 1.4; }
.pf.ds .pf-pinline .num { font-family: var(--type-mono); font-variant-numeric: tabular-nums; letter-spacing: var(--track-number); }
.pf.ds .pf-pinacts { display: flex; flex-wrap: wrap; gap: 8px; }
.pf.ds .pf-pinacts:empty { display: none; }
.pf.ds .pf-pinnote { margin: 0; color: var(--ink-2); font-size: var(--size-14); line-height: 1.4; }
.pf.ds .pf-morebtn { display: flex; align-items: center; justify-content: space-between; width: 100%;
  min-height: var(--control-44); padding: 10px 0; border: 0; border-top: 1px solid var(--hair);
  background: transparent; color: var(--ink-1); font-family: var(--type-ui);
  font-size: var(--size-14); font-weight: 600; cursor: pointer; }
.pf.ds .pf-chev { width: 16px; height: 16px; flex: 0 0 auto; color: var(--ink-2);
  transition: transform var(--dur-150) var(--ease-standard); }
.pf.ds .pf-morebtn[aria-expanded="true"] .pf-chev { transform: rotate(180deg); }
.pf.ds .pf-morefields { display: flex; flex-direction: column; gap: 16px; }
.pf.ds .pf-morefields[hidden] { display: none; }
@media (prefers-reduced-motion: reduce) { .pf.ds .pf-chev { transition: none; } }
.pf.ds .ds-button--gray {
  background: var(--fill); border-color: var(--edge); color: var(--ink-1); font-size: var(--size-14); font-weight: 600; }
.pf.ds .pe-remove { margin-top: 6px; padding-top: 16px; border-top: 1px solid var(--hair); }
.pf.ds .pe-ask { margin: 0 0 12px; color: var(--ink-1); font-size: var(--size-14); line-height: 1.45; }
.pf.ds .pe-askrow { display: flex; gap: 8px; }
.pf.ds .pe-askrow .btn { flex: 1 1 0; height: var(--control-44); border-radius: var(--radius-16); font-size: var(--size-14); font-weight: 600; }
.pf.ds .btn.btn-danger {
  background: var(--negative-bg); border: 1px solid var(--negative-edge); color: var(--negative);
  height: var(--control-44); border-radius: var(--radius-16); font-size: var(--size-14); font-weight: 600; }
.pf-foot.ds [data-act="save"] {
  min-height: var(--control-44); padding: 0 18px; border-radius: var(--radius-full);
  background: var(--solid); border: 1px solid transparent; color: var(--on-solid);
  font-family: var(--type-ui); font-size: var(--size-14); font-weight: 600; white-space: nowrap; }
@media (hover: hover) and (pointer: fine) {
  .pf-foot.ds [data-act="save"]:not(:disabled):hover { background: var(--solid-hover); }
}
.pf-foot.ds [data-act="save"]:disabled {
  cursor: not-allowed; opacity: 1; transform: none; border-color: transparent; background: var(--fill); color: var(--ink-4); box-shadow: none; }
`;

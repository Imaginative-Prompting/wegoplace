// spot-picker.js: say WHERE a place is by moving the trip's map under a pin.
//
// One sheet over whatever asked (the place sheet): the trip's map with a pin fixed in its
// middle, and "Here". The map is the app's one live map, lent for the length of the sheet
// (map.js, mountPicker), so it opens where the person last looked and already has the trip's
// tiles. Nothing is written here: the answer goes back to the caller.
//
//   canPickSpot(store)                         is there a map of this trip to move?
//   pickSpot({ store, lat, lng, area, name })  -> Promise<{ lat, lng } | null>
//
// It is offered only when the trip has a map (the snapshot's `tiles` says one is ready). On a
// trip without one the ground under the pin would be blank, and a pin put down on a blank
// ground is a guess; the place sheet's other ways (a link that carries a location) remain.

import { openSheet } from "./sheet.js";
import { router } from "./router.js";
import { boundsOf } from "./areas.js";

const STEP = 64;         // px an arrow key moves the map
const FINE = 8;          // … with Shift held

/** Is there a map of this trip to put a pin on? */
export function canPickSpot(store) {
  const t = store && typeof store.tiles === "function" ? store.tiles() : null;
  if (!t) return false;
  return t.ready != null ? !!t.ready : t.state === "ready";
}

/** The box to open on for a place in this area: the area's own bounds, else its parent's. */
function boxOf(store, area) {
  if (area == null || area === "") return null;
  const rows = (store.areas() || []).filter((a) => a && a.id != null);
  const row = rows.find((a) => String(a.id) === String(area));
  if (!row) return null;
  const own = boundsOf(row);
  if (own) return own;
  const parent = row.parent != null && row.parent !== "" ? rows.find((a) => String(a.id) === String(row.parent)) : null;
  return parent ? boundsOf(parent) : null;
}

const SP_CSS = `
.sp-pick.ds { display: grid; gap: 12px; }
.sp-pick-say { margin: 0; color: var(--ink-2); font-size: var(--size-14); line-height: 1.45; }
.sp-pick-map { position: relative; height: min(58dvh, 560px); min-height: 240px; border-radius: var(--radius-16);
  overflow: hidden; background: var(--well); border: 1px solid var(--edge); }
.sp-pick-map:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.sp-pick-zoom { position: absolute; left: 10px; bottom: 10px; z-index: 5; display: grid; gap: 8px; }
.sp-pick-zoom button { width: var(--control-44); height: var(--control-44); border-radius: var(--radius-full);
  border: 1px solid var(--edge); background: var(--fill); color: var(--ink-1);
  font-family: var(--type-ui); font-size: var(--size-20); font-weight: 500; line-height: 1;
  display: grid; place-items: center; cursor: pointer; box-shadow: var(--shadow-pop);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
.sp-pick-zoom button[data-press="1"] { transform: scale(.96); background: var(--fill-active); }
.sp-pick-foot.ds { display: flex; gap: 8px; justify-content: flex-end; }
.sp-pick-foot.ds .btn { min-height: var(--control-44); padding: 0 14px; border-radius: var(--radius-full); font-family: var(--type-ui); font-size: var(--size-14); font-weight: 600; white-space: nowrap; }
.sp-pick-foot.ds .ds-button--gray { background: var(--fill); border-color: var(--edge); color: var(--ink-1); }
.sp-pick-foot.ds .ds-button--white { background: var(--solid); border-color: transparent; color: var(--on-solid); }
@media (hover: hover) and (pointer: fine) {
  .sp-pick-zoom button:active { transform: scale(.96); background: var(--fill-active); }
  .sp-pick-foot.ds .ds-button--white:hover { background: var(--solid-hover); }
}
`;

let styled = false;
function injectStyles() {
  if (styled || document.getElementById("sp-pick-css")) { styled = true; return; }
  styled = true;
  const st = document.createElement("style");
  st.id = "sp-pick-css";
  st.textContent = SP_CSS;
  document.head.append(st);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * Ask where a place is. Resolves with the spot under the pin when the person presses "Here",
 * or null when they leave the sheet any other way.
 * @param {{store: object, lat?: number|null, lng?: number|null, area?: string|null, name?: string}} o
 * @returns {Promise<{lat: number, lng: number} | null>}
 */
export async function pickSpot({ store, lat = null, lng = null, area = null, name = "" } = {}) {
  if (!canPickSpot(store)) return null;
  injectStyles();
  // map.js is the app's heaviest module; a person who never asks for the map never pays for it.
  const { mountPicker } = await import("./map.js");

  const body = document.createElement("div");
  body.className = "sp-pick ds";
  body.innerHTML =
    `<p class="sp-pick-say" id="sp-pick-say">Move the map until the pin is on ${name ? `“${esc(name)}”` : "the place"}, then press Here.</p>` +
    `<div class="sp-pick-map" tabindex="0" role="application" aria-describedby="sp-pick-say" ` +
      `aria-label="The trip's map. Arrow keys move it; plus and minus zoom.">` +
      `<div class="sp-pick-zoom"><button type="button" data-zoom="1" aria-label="Zoom in">+</button>` +
      `<button type="button" data-zoom="-1" aria-label="Zoom out">−</button></div></div>`;
  const foot = document.createElement("div");
  foot.className = "sp-pick-foot ds";
  foot.innerHTML =
    `<button type="button" class="btn ds-button ds-button--gray ds-button--sm" data-act="cancel">Cancel</button>` +
    `<button type="button" class="btn ds-button ds-button--white ds-button--sm" data-act="here">Here</button>`;
  const host = body.querySelector(".sp-pick-map");

  return new Promise((resolve) => {
    let picker = null, answer = null, sheet = null;
    const mount = () => {
      if (picker || !host.isConnected) return;
      const hasPin = lat != null && lng != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
      picker = mountPicker(host, { store, router }, hasPin ? { lat: Number(lat), lng: Number(lng) } : { box: boxOf(store, area) });
    };
    host.addEventListener("keydown", (e) => {
      if (!picker || e.target !== host) return;
      const d = e.shiftKey ? FINE : STEP;
      const move = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key];
      if (move) { e.preventDefault(); picker.move(move[0], move[1]); return; }
      if (e.key === "+" || e.key === "=") { e.preventDefault(); picker.zoom(1); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); picker.zoom(-1); }
    });
    host.addEventListener("click", (e) => {
      const z = e.target.closest("[data-zoom]");
      if (z && picker) picker.zoom(Number(z.dataset.zoom));
    });
    foot.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      if (b.dataset.act === "here" && picker) {
        const s = picker.spot();
        answer = { lat: Math.round(s.lat * 1e6) / 1e6, lng: Math.round(s.lng * 1e6) / 1e6 };
      }
      sheet.close();
    });
    sheet = openSheet({
      title: "On the map",
      contentEl: body,
      footEl: foot,
      dragFrom: "handle",          // a finger on the map moves the map, never the sheet
      closeButton: false,
      onOpen: mount,
      onClose: () => {
        if (picker) { picker.destroy(); picker = null; }
        resolve(answer);
      },
    });
    // The sheet is in the page as soon as it is made; the map wants its real size, which it
    // has by the next frame. onOpen (after the sheet has come up) is the fallback.
    requestAnimationFrame(() => requestAnimationFrame(mount));
  });
}

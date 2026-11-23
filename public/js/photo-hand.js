// A photo added by hand (model §6, "by the person"): Add a photo, Change, Remove on a place's page,
// a plan's page and the trip's own page (its cover). One controller for the three, over the one
// way a picture is made on this phone and the one place pictures wait (picture-make.js,
// picture-wait.js, wgp-server's): made to the picture's size here, upright, the camera's data
// (where it was taken, the phone) gone because the canvas carries none of it; sent with
// license "own"; held on this phone with no signal and sent when there is, the card saying so;
// a refusal said in the server's own sentence, and the picture kept until it is replaced or
// removed (a picture never disappears without a word).
//
//   const ph = photoHand({ target, stored, repaint, inputHost, start, noun })
//     target     { trip, kind: "place" | "event" | "cover", id }
//     stored()   the picture on the server as the page has it ({ url, width, height }) or null
//     repaint()  the page's own paint; called whenever what this shows changes
//     inputHost  where the file field lives: OUTSIDE whatever repaint() rewrites, so a sync's
//                repaint while the phone's picker is open can't take the field (and its answer) away
//     start()    starts picture-wait for this page (start(store) in the app, startForTrip on the trip's page)
//     noun       "place" | "plan" | "trip": the words a link's arrival says, and the remove button's:
//                "Remove photo" on a place's and a plan's row, where "Change" beside it is the place
//                or the plan (a "Remove" there reads as removing it); "Remove" under the cover's own
//                label
//   ph.html({ lead, cls })   the block: its buttons (after `lead`, the page's own first buttons, in
//                      one row with class `cls`), then its state in words
//   ph.view(row)       the row as it should draw: a picture waiting or refused here in place of the
//                      server's (its address on this phone), none while a removal waits
//   ph.click(el)       a click inside the page; answers true when it was this block's
//   ph.arrive()        the page was opened by a link to add the photo (?photo=add): the block is
//                      brought into view and its button focused; nothing is taken until a photo is picked
//   ph.painted()       the page wrote the block again: an arrival's focus and mark are put back on it
//                      (a sync's repaint, or the page's own, must not take them in the first seconds)
//   ph.stop()

import { limitsFor, holdMade, on, removePicture, waitingFor } from "./picture-wait.js";
import { makePicture } from "./picture-make.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ICO_PHOTO = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.4-2h4.6l1.4 2h1.8A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5Z"/><circle cx="12" cy="12.4" r="3.4"/></svg>`;
const REMOVE_ARM_MS = 3000;

/** The query a link into the app carries to open a card's "Add a photo". */
export const wantsPhoto = (search) => new URLSearchParams(String(search || "").replace(/^[^?]*\?/, "")).get("photo") === "add";

/** What the server's refusal says, in a sentence the card can show. */
export function refusedWords(st) {
  const reason = String(st.reason || "").trim();
  // Too big: this phone made it to the size the server keeps, so the making fell short; the
  // server's limit after it, and what to try.
  if (st.status === 413 && /^An? (picture|receipt) is at most/i.test(reason)) {
    return `Not sent: still too big after this phone made it smaller (${reason.replace(/\.$/, "").replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLowerCase())}). Try another picture.`;
  }
  return `Not sent: ${reason || "it couldn't be kept."}`;
}

export function photoHand({ target, stored, repaint, inputHost, start, noun }) {
  let busy = false;
  let said = null;             // { words, kind }: one thing to say that isn't the picture's state
  let armed = 0;               // Remove asks twice: the time the first tap was made
  let armTimer = 0;
  let dead = false;
  let arrivedUntil = 0;        // a link's arrival: its mark and its focus hold this long through repaints

  // The file field: never seen, never repainted, out of the page's layout (hidden, as Memories'
  // own: a hidden file field still opens the phone's picker from a tap's click()). Picking from
  // the library or taking one with the camera is the phone's own sheet (accept="image/*").
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.className = "ph-file";
  input.hidden = true;
  inputHost.append(input);

  const paint = () => { if (!dead) repaint(); };
  start();
  const off = on("change", paint);

  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    busy = true; said = null; armed = 0;
    paint();
    let made = null;
    try { made = await makePicture(file, limitsFor(target.kind)); }
    catch (e) { said = { words: (e && e.message) || "That picture couldn't be opened on this phone.", kind: "err" }; }
    if (made) {
      // Kept here first and answered at once: the sending goes on by itself (with signal, a
      // second or two; without, whenever the phone has it again, from any screen of the trip).
      try { await holdMade(target, made, { wait: false }); }
      catch (e) { said = { words: "This phone couldn't keep the picture. Try again.", kind: "err" }; console.warn("[photo] hold", e); }
    }
    busy = false;
    paint();
  });

  /** The picture as this page shows it: waiting, refused or being removed here, else the server's. */
  function shown() {
    const here = waitingFor(target);
    if (here) return here;
    const s = stored();
    return s && s.url ? { state: "stored", url: s.url, w: s.width || 0, h: s.height || 0 } : null;
  }

  function stateWords(sh) {
    if (busy) return { words: "Making the picture smaller…", kind: "info" };
    if (said) return said;
    if (!sh) return null;
    if (sh.state === "waiting") {
      return navigator.onLine === false
        ? { words: "Waiting to send. It goes when there's signal.", kind: "info" }
        : { words: "Sending…", kind: "info" };
    }
    if (sh.state === "refused") return { words: refusedWords(sh), kind: "err" };
    if (sh.state === "removing") return { words: "Removed here. It goes from everyone's phones when there's signal.", kind: "info" };
    return null;
  }

  function html({ lead = "", cls = "" } = {}) {
    const sh = shown();
    const has = !!sh && sh.state !== "removing";
    const w = stateWords(sh);
    const btn = (act, label, words, extra = "") =>
      `<button type="button" class="ds-button ds-button--gray" data-photo="${act}"${extra}${busy ? " disabled" : ""}>${words}</button>`;
    const acts = has
      ? btn("pick", "", `${ICO_PHOTO}Change photo`) +
        // What it removes, where a person sees it: on a place's or a
        // plan's row "Change" is the place or the plan, so "Remove" alone there reads as removing
        // it; the row wraps when it must. Under the cover's own label, "Remove" is clear.
        btn("remove", "", armed ? "Tap again to remove" : (noun === "trip" ? "Remove" : "Remove photo"), ` aria-label="${armed ? "Tap again to remove the photo" : "Remove the photo"}"` + (armed ? ` data-armed="1"` : ""))
      : btn("pick", "", `${ICO_PHOTO}Add a photo`);
    const hit = Date.now() < arrivedUntil ? ` data-hit="1"` : "";
    return `<div class="ph" id="photo" data-photo-state="${busy ? "busy" : (sh ? sh.state : "none")}"${hit}>` +
      `<div class="ph-acts${cls ? " " + cls : ""}">${lead}${acts}</div>` +
      (w ? `<p class="ph-say" data-kind="${w.kind}" role="status">${esc(w.words)}</p>` : `<p class="ph-say" role="status" hidden></p>`) +
      `</div>`;
  }

  /** The row to draw: its picture as this page shows it. */
  function view(row) {
    const sh = shown();
    if (!sh || sh.state === "stored") return row;
    if (sh.state === "removing") return { ...row, picture: null, cover: null };
    const pic = { url: sh.url, width: sh.w, height: sh.h, license: "own", credit: "", source: "" };
    return target.kind === "cover" ? { ...row, cover: pic } : { ...row, picture: pic };
  }

  function click(el) {
    const b = el && el.closest && el.closest("[data-photo]");
    if (!b || busy) return !!b;
    if (b.dataset.photo === "pick") {
      said = null; armed = 0;
      input.click();
      return true;
    }
    if (b.dataset.photo === "remove") {
      if (!armed || Date.now() - armed > REMOVE_ARM_MS) {
        armed = Date.now();
        clearTimeout(armTimer);
        armTimer = setTimeout(() => { armed = 0; paint(); }, REMOVE_ARM_MS);
        paint();
        return true;
      }
      armed = 0;
      clearTimeout(armTimer);
      said = null;
      const s = stored();
      // Remove takes what the card shows. One that never reached the server (waiting, or refused)
      // goes from this phone at once, and the one on the server, if there is one, shows again;
      // one on the server goes from everyone's phones when there is signal.
      const here = waitingFor(target);
      removePicture(target, { onServer: !here && !!(s && s.url) }).catch((e) => console.warn("[photo] remove", e)).finally(paint);
      paint();
      return true;
    }
    return true;
  }

  function arrive() {
    if (!document.getElementById("photo")) return;
    const has = !!shown() && shown().state !== "removing";
    said = { words: noun === "trip" ? `Pick the trip's cover: tap ${has ? "Change photo" : "Add a photo"}.` : `Pick the photo for this ${noun}: tap ${has ? "Change photo" : "Add a photo"}.`, kind: "info" };
    arrivedUntil = Date.now() + 2400;
    paint();
    const block = document.getElementById("photo");
    if (!block) return;
    block.scrollIntoView({ block: "center" });
    painted();
    setTimeout(() => { if (!dead) paint(); }, 2500);      // the mark goes
  }

  function painted() {
    if (dead || Date.now() >= arrivedUntil) return;
    const block = document.getElementById("photo");
    if (!block || block.contains(document.activeElement)) return;
    const first = block.querySelector('[data-photo="pick"]');
    if (first) first.focus({ preventScroll: true });
  }

  function stop() {
    dead = true;
    off();
    clearTimeout(armTimer);
    input.remove();
  }

  return { html, view, click, arrive, painted, stop, shown };
}

/** The block's look, the same on the three pages: put in once per document. */
export function ensurePhotoCss() {
  if (document.getElementById("ph-css")) return;
  const s = document.createElement("style");
  s.id = "ph-css";
  s.textContent = PHOTO_CSS;
  document.head.append(s);
}
const PHOTO_CSS = `
.ph{margin:var(--sp-3) 0 0}
.ph-acts{display:flex;flex-wrap:wrap;gap:var(--sp-2)}
.ph-acts [data-photo] .ico{width:16px;height:16px}
.ph-acts [data-armed]{color:var(--warn);border-color:var(--warn)}
.ph-say{margin:var(--sp-2) 0 0;font-size:13px;line-height:1.45;color:var(--ink-2)}
.ph-say[data-kind="err"]{color:var(--warn)}
.ph[data-hit] .ph-acts [data-photo="pick"]{box-shadow:0 0 0 3px var(--accent-soft)}
`;

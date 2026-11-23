// sheet.js — the app's only bottom sheet. Shell-owned, shared by every view.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE CONTRACT. Three exports — openSheet, closeAllSheets, and keyboardLock (the keyboard
// primitive, documented in its own block below and shared with the agenda's note composer).
//
//   import { openSheet } from "./sheet.js";
//
//   const body = document.createElement("div");
//   body.innerHTML = `<label class="field">…</label>`;
//
//   const sheet = openSheet({
//     title: "Add item",          // string. Shown as the heading and used as the dialog's
//                                 // accessible name. Optional — omit it for a bare panel.
//     contentEl: body,            // any Node. APPENDED into the sheet's scrolling body.
//     footEl: bar,                // any Node. Pinned BELOW the scrolling body, so it stays on
//                                 // screen however far the body scrolls. Optional.
//     footRow: true,              // footEl is a BLOCK (several buttons, a field, a status
//                                 // line), not one button: it takes the row under the title
//                                 // instead of sitting beside it. Default false.
//     closeButton: false,         // drop the top-right X. Default true.
//     dragFrom: "handle",         // "body" (default): a swipe anywhere dismisses, as long as
//                                 // the body is scrolled to top. "handle": ONLY the grab
//                                 // handle and the title row drag — a swipe over the content
//                                 // never dismisses, which is what lets a scrolling form live
//                                 // in here without the two gestures fighting.
//     maxFraction: 2 / 3,         // cap the sheet at this fraction of the SCREEN. Optional,
//                                 // and the visual-viewport cap below still applies as well.
//     opaque: true,               // keep the backdrop fully opaque even with the keys DOWN.
//                                 // Optional, and rarely what you want: the backdrop already
//                                 // goes opaque on its own the moment a text field in the
//                                 // sheet takes focus, and stays that way while the keyboard
//                                 // is up (see paintScrim below). This flag is only for a
//                                 // sheet that must hide the page with no keyboard involved.
//     onClose: () => { … },       // called once, after the sheet has left the screen, for
//                                 // ANY dismissal: the X, the backdrop, Escape, a swipe
//                                 // down, or sheet.close() itself.
//   });
//
//   sheet.close();                // dismiss it yourself. Idempotent; onClose still fires once.
//   sheet.el;                     // the .sh-sheet element, if you need to measure it.
//
// THINGS WORTH KNOWING BEFORE YOU BUILD ON IT
//
//   * The sheet OWNS contentEl (and footEl) once you hand them over. Closing removes the whole
//     sheet from the DOM, both with it. Keep your own reference if you want a node back.
//   * openSheet returns synchronously and the sheet is on screen in the same frame; the
//     slide is a CSS transition, not a promise you have to await.
//   * A sheet is MODAL. While one is open the rest of the app is `inert`, so a stray tap on
//     the tab bar behind the scrim cannot navigate out from under it.
//   * Sheets stack. Escape and the backdrop always act on the topmost one.
//   * The keyboard is handled here, not by the caller: put an <input> in your content and
//     the sheet rides above the keys while the page behind it is frozen solid. Nothing but
//     the sheet's own body may move — see the keyboardLock block below. The backdrop turns
//     opaque as that field takes focus, so the page never shows through while you type.
//   * Styles are .sh-* in styles.css, not injected by this module — the first sheet of a
//     session has to paint in one frame, with no flash of an unstyled panel.
//
// WHY THIS FILE EXISTS: popovers shove the text field
// off screen, so all sheets are real bottom sheets: drag handle, smooth drag, swipe-down
// anywhere to dismiss, keyboard-aware. Every one of those four is a thing a plain
// position:fixed panel gets wrong, and getting them wrong four separate times in four view
// modules is how the app ended up with a popover that hides its own text field.
// ─────────────────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE SECOND EXPORT: keyboardLock — the shared "nothing moves" primitive.
// Every sheet holds one. The agenda's note composer is not a sheet and holds one too; that
// is the whole reason it is exported rather than kept private to openSheet().
//
//   import { keyboardLock } from "./sheet.js";
//
//   const lock = keyboardLock({
//     pin: panelEl,          // element laid EXACTLY over the visual viewport: top / left /
//                            // width / height written inline from visualViewport, so a
//                            // position:fixed panel sits on the keyboard instead of behind
//                            // it, and survives iOS OFFSETTING the visual viewport rather
//                            // than resizing the layout one. Optional.
//     vars: panelEl,         // element that receives the measurements as custom properties
//                            // --kb-height / --vv-height / --vv-top, plus data-kb="0|1".
//                            // Usually the same node as `pin` — and the way to use this
//                            // helper WITHOUT handing over your geometry: take `vars` only
//                            // and position off the numbers yourself. (These are the panel's
//                            // own properties. The shell's --kb-h on <html> is a different
//                            // contract, written by index.html; do not confuse them.)
//     scrollport: bodyEl,    // the ONE element allowed to move when the keyboard opens.
//                            // reveal() scrolls this and nothing else. Optional.
//     onViewport: (m) => {}, // every viewport change, with the metrics object. Optional.
//   });
//
//   lock.reveal(field);      // put `field` inside the scrollport, clear of the keyboard.
//   lock.metrics();          // { kb, height, width, offsetTop, offsetLeft }
//   lock.release();          // once, when your panel closes. Idempotent.
//
// CREATING THE LOCK FREEZES THE PAGE. Take it when your panel OPENS (or when its field takes
// focus) and release it when the panel closes — not for the lifetime of a composer that is
// merely present on screen, or the page under it can never be scrolled again.
//
// WHAT IT ACTUALLY DENIES. iOS does not resize the layout viewport for the keyboard: it
// shrinks the VISUAL viewport, and then — the focused field now being under the keys — it
// reveals that field by any means it has. There are TWO of those, and a freeze that only
// answers the first is the bug reported five times running.
//
//   1. IT SCROLLS. Whatever scroller can reach the field is scrolled, and the page behind
//      the panel goes with it. Answered by taking the page's scroll away:
//        * document.body goes position:fixed, so the document itself has nowhere to go;
//        * the shell's scroller (#view) goes overflow:hidden with its offset saved — and
//          because overflow:hidden only stops the FINGER, never the engine's own
//          scroll-into-view, the saved offset is put back both from a capture-phase scroll
//          listener (same task as the offending scroll, before paint) and from a
//          per-frame re-assert (the listener alone loses to a scroll that lands on the
//          COMPOSITOR — an -webkit-overflow-scrolling fling, or WebKit's own reveal).
//
//   2. IT OFFSETS THE VISUAL VIEWPORT. When nothing can be scrolled — which is precisely
//      what the freeze above has just arranged — WebKit slides the whole LAYOUT viewport up
//      instead and reports it as visualViewport.offsetTop. Every fixed box in the shell goes
//      up with it: the pack list, the status strip, the dock. `inert` does not touch this and
//      neither does overflow:hidden; there is nothing to intercept, because nothing scrolled.
//      Answered by pinning the frozen body by the same offset, every frame, so the page comes
//      back down by exactly what the engine took it up by and does not move ON THE GLASS.
//      (The panel is NOT double-corrected: it is position:fixed, so `top` on body cannot
//      reach it, and it has its own `pin` against the same numbers.)
//
// Everything written here is restored byte-exactly on release.
// Locks are REFCOUNTED: a sheet over the composer, or two stacked sheets, freeze the page
// once and thaw it when the last one lets go.
// ─────────────────────────────────────────────────────────────────────────────────────────

import { RAIL } from "./tabs.js";

// The shell's scroller. index.html's #view is the only element in this app that scrolls the
// page (styles.css: "only #view scrolls; the bars never move"), so it is the only one the
// freeze has to hold still. Looked up per freeze, never cached: the shell may re-render.
const PAGE_SCROLLER_ID = "view";

// Breathing room left between a revealed field and the edge of its scrollport. Enough that
// the field reads as "above the keyboard" rather than "jammed against it".
const REVEAL_PAD = 12;

let freezeCount = 0;
let frozen = null;

function freezePage() {
  if (++freezeCount > 1) return;
  const view = document.getElementById(PAGE_SCROLLER_ID);
  frozen = {
    view,
    top: view ? view.scrollTop : 0,
    left: view ? view.scrollLeft : 0,
    overflowY: view ? view.style.overflowY : "",
  };
  // ONE MECHANISM, NOT FOUR. This used to also pin <body> to position:fixed, translate it by
  // visualViewport.offsetTop every time that number moved, and run a requestAnimationFrame loop
  // re-asserting both — three corrections racing WebKit and each other on every keystroke. That
  // is the jitter seen on every text field here and nowhere else on the web.
  //
  // WebKit scrolls a focused field's nearest scrollable ancestor. Make it un-scrollable and
  // there is nothing to correct: the page cannot move, so nothing has to move it back. The
  // document itself is already unscrollable (body is height:100dvh, overflow:hidden).
  if (view) {
    view.style.overflowY = "hidden";
    view.scrollTop = frozen.top;
    view.scrollLeft = frozen.left;
  }
}


function thawPage() {
  if (freezeCount === 0) return;
  if (--freezeCount > 0) return;
  const f = frozen;
  frozen = null;
  if (!f || !f.view) return;
  f.view.style.overflowY = f.overflowY;
  f.view.scrollTop = f.top;
  f.view.scrollLeft = f.left;
}

// Visual-viewport height with no keyboard up, re-learned whenever focus is not in a text field.
// A collapsing URL bar or a rotation therefore re-baselines instead of reading as a keyboard.
let vvBase = 0;
function vvBaseline(vv) {
  const a = document.activeElement;
  // A read-only or disabled field (a link to copy) raises no keyboard, so it doesn't count as typing.
  const typing = a && !a.readOnly && !a.disabled && (a.tagName === "TEXTAREA" || a.isContentEditable
    || (a.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset|range|color|file)$/i.test(a.type || "text")));
  if (!typing && vv.height > vvBase) vvBase = vv.height;
  if (!vvBase) vvBase = vv.height;
  return vvBase;
}

function measureViewport() {
  const vv = window.visualViewport;
  if (!vv) {
    return { kb: 0, height: window.innerHeight, width: window.innerWidth,
             offsetTop: 0, offsetLeft: 0 };
  }
  // NOT innerHeight-based. That comment used to say "iOS leaves the layout viewport alone" and
  // it is false on iOS 26: measured on a real iPhone, innerHeight went 714 -> 377 with the keys
  // up while vv.height was also 377 and vv.offsetTop was 337.
  return {
    // Same correction as the shell's kbHeight(): innerHeight SHRINKS with the keyboard on
    // iOS 26, so innerHeight - vv.height - vv.offsetTop measured 0 on a real iPhone while the
    // keys were plainly up. The drop from the keyboard-down visual viewport is the signal.
    // Same universal formula as the shell's kbHeight() — see the long note there. How much of
    // the LAYOUT viewport the keyboard covers, which is 0 in Safari (where the layout viewport
    // shrinks on its own) and the keyboard's height in an installed PWA (where it does not).
    kb: Math.max(0, window.innerHeight - vv.offsetTop - vv.height),
    height: vv.height, width: vv.width,
    offsetTop: vv.offsetTop, offsetLeft: vv.offsetLeft,
  };
}

// Scroll `port` — and ONLY `port` — until `field` is clear of both its edges. Deliberately
// not scrollIntoView(): that walks every scrollable ancestor and the document with it, which
// is the movement this file exists to deny.
function revealIn(port, field, pad = REVEAL_PAD) {
  if (!port || !field || !port.contains(field)) return;
  const raw = port.getBoundingClientRect();
  // THE PORT IS TALLER THAN WHAT YOU CAN SEE OF IT. Since the drawer stopped riding the keyboard
  // and started passing behind it, this rect runs all the way to the bottom of the screen while
  // the keys cover its foot. Measuring against the raw rect made a field at y=511 look "already
  // visible" with the keyboard starting at 508, so nothing scrolled and you typed into a box you
  // could not see. Clip the port to the part that is actually on glass; everything below reads
  // this and needs no other change.
  const vv = window.visualViewport;
  const glassBottom = vv ? Math.min(raw.bottom, vv.offsetTop + vv.height) : raw.bottom;
  const pr = { top: raw.top, bottom: glassBottom, height: glassBottom - raw.top };
  // Bring the field's whole labelled block if it fits — a value whose label is cut off above
  // it reads as an unlabelled box. If the block does not fit, the field itself wins.
  let box = field.closest(".field") || field;
  let br = box.getBoundingClientRect();
  if (br.height > pr.height - pad * 2) { box = field; br = box.getBoundingClientRect(); }
  let d = 0;
  if (br.height > pr.height - pad * 2) {
    // STILL taller than the port, so there is no scroll offset that frames it and the two
    // branches below are both wrong: "bring its bottom up" scrolls to the FAR END of it.
    //
    // That is not a hypothetical. packing.js's editor focuses its <form tabindex="-1"> on an
    // EDIT — deliberately, so that opening the sheet does not raise the keyboard — and the
    // form is the whole scrollable content. Reading that as "reveal the bottom of the form"
    // is what opened "Edit item" scrolled to the last of its bag pickers, with the item's own
    // name 320px above the top of the sheet. Measured, at scrollTop 347 of a maximum of 347.
    //
    // A box that cannot be framed gets its TOP aligned instead, which for a wrapper means the
    // start of the form and for a genuinely enormous field means its first line.
    d = br.top - (pr.top + pad);
  } else if (br.bottom > pr.bottom - pad) d = br.bottom - (pr.bottom - pad);
  else if (br.top < pr.top + pad) d = br.top - (pr.top + pad);
  if (!d) return;
  const max = Math.max(0, port.scrollHeight - port.clientHeight);
  port.scrollTop = Math.min(max, Math.max(0, port.scrollTop + d));
}

/**
 * Freeze the page and follow the keyboard. See the block comment above.
 * @param {{pin?: Element, vars?: Element, scrollport?: Element,
 *          onViewport?: (m: object) => void}} opts
 * @returns {{reveal: (field: Element) => void, metrics: () => object, release: () => void}}
 */
export function keyboardLock({ pin = null, vars = null, scrollport = null,
                               onViewport = null } = {}) {
  let live = true;
  let last = measureViewport();

  function apply() {
    if (!live) return;
    // Nothing to correct any more. The page is frozen by making its scroller un-scrollable, so
    // there is no drift to chase here — this handler only measures and publishes.
    const m = measureViewport();
    const moved = m.kb !== last.kb || m.height !== last.height
      || m.offsetTop !== last.offsetTop || m.offsetLeft !== last.offsetLeft;
    last = m;
    if (pin && window.visualViewport) {
      // Both offsetTop AND height, which is the whole of "pin against the visual viewport":
      // a position:fixed box is laid out against the LAYOUT viewport, so on iOS it drifts by
      // offsetTop and overhangs by the keyboard's height unless it is told otherwise.
      pin.style.top = `${m.offsetTop}px`;
      pin.style.left = `${m.offsetLeft}px`;
      pin.style.width = `${m.width}px`;
      pin.style.height = `${m.height}px`;
    }
    if (vars) {
      vars.style.setProperty("--kb-height", `${Math.round(m.kb)}px`);
      vars.style.setProperty("--vv-height", `${Math.round(m.height)}px`);
      vars.style.setProperty("--vv-top", `${Math.round(m.offsetTop)}px`);
      vars.dataset.kb = m.kb > 0 ? "1" : "0";
    }
    if (onViewport) onViewport(m);
    // The keyboard arrives AFTER the focus that opened it, so any reveal done at focus time
    // was measured against a scrollport that has since shrunk. Redo it here — this is the
    // event that actually knows how tall the keyboard is.
    //
    // Only when the viewport ACTUALLY moved. visualViewport fires on plenty of things that
    // change none of these four numbers, and re-revealing on those would drag the scrollport
    // back to the focused field under a thumb that was deliberately scrolling away from it.
    if (!moved) return;
    const a = document.activeElement;
    if (scrollport && a && scrollport.contains(a)) revealIn(scrollport, a);
  }

  // TRACK THE KEYBOARD PER FRAME WHILE IT MOVES.
  //
  // iOS does not fire visualViewport `resize` continuously during the keyboard animation — it
  // fires once, at the end. Anything driven purely by that event therefore holds still for the
  // whole ~250ms and then teleports, which is what was seen first; adding a CSS transition only
  // made it animate AFTER the keys had finished, which is what was seen next.
  //
  // The visualViewport PROPERTIES, though, update continuously. So sample them per frame while
  // the keyboard is in motion and the row moves WITH it, because it is reading the same number
  // the keyboard is drawing itself from.
  //
  // This is a short bounded burst, not the permanent requestAnimationFrame loop that was
  // removed for causing jitter: it starts on a focus change, stops as soon as the height has
  // been steady for a few frames, and gives up after 900ms regardless.
  let burst = 0, steady = 0, lastKb = -1, burstEnd = 0;
  function frame() {
    if (!live) { burst = 0; return; }
    apply();
    const kb = measureViewport().kb;
    if (Math.abs(kb - lastKb) < 0.5) steady++; else { steady = 0; lastKb = kb; }
    if (steady >= 5 || Date.now() > burstEnd) { burst = 0; return; }
    burst = requestAnimationFrame(frame);
  }
  function track() {
    if (!live) return;
    steady = 0; lastKb = -1; burstEnd = Date.now() + 900;
    if (!burst) burst = requestAnimationFrame(frame);
  }
  // Both directions: focusin is before the keys rise, focusout before they fall.
  addEventListener("focusin", track, true);
  addEventListener("focusout", track, true);

  freezePage();
  apply();
  track();

  const vv = window.visualViewport;
  addEventListener("resize", apply);
  if (vv) {
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
  }

  return {
    reveal(field) { if (live) revealIn(scrollport, field); },
    metrics() { return last; },
    release() {
      if (burst) { cancelAnimationFrame(burst); burst = 0; }
      removeEventListener("focusin", track, true);
      removeEventListener("focusout", track, true);
      if (!live) return;
      live = false;
      removeEventListener("resize", apply);
      if (vv) {
        vv.removeEventListener("resize", apply);
        vv.removeEventListener("scroll", apply);
      }
      thawPage();
    },
  };
}

const CLOSE_ICON = '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>';

// Sized against the .sh-sheet transition in styles.css (--dur-slow, 320ms) plus headroom, so
// transitionend stays the common path. Used only as a fallback deadline: a `transition: none`
// under prefers-reduced-motion never fires transitionend, and a sheet that never gets removed
// from the DOM leaves the app permanently inert.
const EXIT_MS = 360;

// How long the sheet's slide takes as the stylesheet has it now, in ms: 0 when nothing will
// move (`transition: none`, or every duration zero), which is "reduce motion". Then there is
// no slide to wait for, and waiting the deadline out would leave the page behind a closed
// sheet inert for a third of a second.
function slideMs(el) {
  const cs = getComputedStyle(el);
  if (cs.transitionProperty === "none") return 0;
  // "0.32s, 0.18s": the longest of the list is when the last property lands.
  return Math.max(0, ...String(cs.transitionDuration || "0s").split(",")
    .map((t) => (/ms$/.test(t.trim()) ? parseFloat(t) : parseFloat(t) * 1000))
    .map((n) => (Number.isFinite(n) ? n : 0)));
}

// Dismiss thresholds, tuned for a thumb on a 390pt phone.
const DISMISS_FRACTION = 0.28;   // of the sheet's own height
const DISMISS_VELOCITY = 0.6;    // px/ms downward — a flick, regardless of distance
const FLICK_MIN_PX = 24;         // a flick still has to travel far enough to be intentional
const DRAG_SLOP = 6;             // px before we decide this is a drag and not a tap
// How far a tall drawer must be pulled down before it gives up the tall state. Comfortably more
// than a stray thumb-drag, comfortably less than the dismiss threshold.
const TALL_RELEASE = 48;
// How far an upward pull travels before a normal drawer goes full height. Only reached when
// the pull could not be previewed — see TALL_SETTLE, which is what decides the normal case.
const PULL_UP = 56;
// What FRACTION of the way to full height an upward drag has to cover for releasing to
// complete it. Below half, so letting go anywhere past the middle finishes the gesture — which
// is what a drag between two detents is expected to do.
const TALL_SETTLE = 0.4;
// Sized against --dur (220ms), the transition the settle runs on, plus headroom. This is a
// cleanup deadline, not the animation: it is when the drag's explicit height hands back to the
// class-driven one, and it must outlast the transition or the height would snap at the end.
const SETTLE_MS = 280;

let seq = 0;
const stack = [];

// The rest of the app, made unreachable while a sheet is up. Collected once per open rather
// than kept in a module constant: index.html is the shell's, and a selector cached at import
// time would go stale if it ever re-renders its chrome.
function backdropTargets() {
  return [document.getElementById("view"), document.querySelector(".tabbar"),
          document.getElementById("dock")].filter(Boolean);
}

function setInert(on) {
  for (const el of backdropTargets()) {
    if (on) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }
}

/**
 * Open a bottom sheet.
 * @param {{title?: string, contentEl?: Node, footEl?: Node, footRow?: boolean, closeButton?: boolean,
 *          dragFrom?: "body"|"handle", maxFraction?: number, opaque?: boolean,
 *          onOpen?: () => void, onClose?: () => void}} opts
 * @returns {{close: () => void, el: HTMLElement}}
 */
/**
 * The height a tall drawer settles onto in this root: the [data-tall] rule's own formula (styles.css), measured on a
 * probe inside the root, so the drag target and the rule can't disagree. (It used to parse --safe-top's text with
 * parseFloat; that text is a calc(), so it read NaN and fell back to 0, and the drag aimed past the status-bar band.)
 */
export function tallFor(root) {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:calc(100% - var(--safe-top) - var(--sp-3))";
  root.append(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return Math.max(0, h);
}

export function openSheet({
  title = "", contentEl = null, footEl = null, footRow = false, closeButton = true,
  dragFrom = "body", maxFraction = 0, opaque = false, onOpen = null, onClose = null,
} = {}) {
  const id = `sh-t-${++seq}`;
  const handleOnly = dragFrom === "handle";

  // Where the screen has room a sheet is laid out as a dialog (styles.css): nothing to drag,
  // so every one of them gets the × whether or not its caller asked for it.
  const asDialog = () => typeof matchMedia === "function" && matchMedia(RAIL).matches;

  const root = document.createElement("div");
  root.className = "sh-root ds";   // its frame is on the design system; its body keeps the screen's own look (styles.css)
  root.dataset.open = "0";
  root.dataset.drag = "0";
  root.innerHTML =
    `<div class="sh-scrim"></div>` +
    `<div class="sh-sheet" role="dialog" aria-modal="true" tabindex="-1"` +
    `${title ? ` aria-labelledby="${id}"` : ` aria-label="Panel"`}>` +
      `<div class="sh-grab" aria-hidden="true"></div>` +
      `<div class="sh-head">` +
        `<h2 class="sh-title" id="${id}"></h2>` +
        // Always drawn: a sheet that didn't ask for one has it only while it is a dialog (styles.css,
        // .sh-x[data-dialog-only]), which has no grab to drag it down by. Drawn whatever the layout at open, since a
        // phone turned on its side with the sheet up makes it a dialog then.
        `<button class="sh-x" type="button" aria-label="Close"${closeButton ? "" : " data-dialog-only"}>` +
          `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${CLOSE_ICON}</svg>` +
        `</button>` +
      `</div>` +
      `<div class="sh-body"></div>` +
    `</div>`;

  const sheet = root.querySelector(".sh-sheet");
  const scrim = root.querySelector(".sh-scrim");
  const grab = root.querySelector(".sh-grab");
  const body = root.querySelector(".sh-body");
  const titleEl = root.querySelector(".sh-title");

  // THE SCRIM OVERHANGS THE ROOT, BY A SCREEN, IN EVERY DIRECTION.
  //
  // .sh-root is re-laid over the visual viewport from a visualViewport event — and iOS
  // dispatches that event AFTER it has already painted the new offset. During the keyboard's
  // 300ms rise that is a frame at a time, every frame, where the root is in last frame's
  // place and a strip of screen at one edge is not covered by it. What shows in that strip is
  // the page, mid-move. Eighteen frames of it is not a flicker; it is the report.
  //
  // The fix is not better timing — there is no timing that beats a paint we are told about
  // afterwards. It is a scrim too big to have an edge on screen at all, whatever the root is
  // doing. It costs one paint of a colour that was already being painted.
  //
  // Inline rather than a stylesheet rule, deliberately: .sh-* lives in styles.css and this
  // file must not need an edit over there to be correct.
  scrim.style.top = "-100vh";
  scrim.style.bottom = "-100vh";
  scrim.style.left = "-100vw";
  scrim.style.right = "-100vw";

  // A sheet with no X and no body-swipe would be dismissible only by the handle, the backdrop
  // and Escape. That is a deliberate combination, and it
  // is only safe because the handle is always there — which is why this file, and not the
  // caller, owns the handle and never lets it be turned off.
  if (handleOnly) root.dataset.drag = "0";
  // Marks the FORM drawers (dragFrom:"handle") for the stylesheet. Their blank space is a drag
  // surface, so it must not also be a text-selection surface; a prose sheet's is the opposite.
  if (handleOnly) root.dataset.handle = "1";
  if (opaque) root.dataset.opaque = "1";

  // textContent, not innerHTML: a title is a string from a caller and this file is not the
  // place to decide whether that caller escaped it.
  titleEl.textContent = title;
  if (!title) titleEl.hidden = true;
  if (contentEl) body.append(contentEl);
  // OUTSIDE .sh-body on purpose. A footer inside the scrollport can only be kept on screen
  // with position:sticky, which pins to the scroll container's CONTENT box and needs a
  // negative offset to cover its bottom padding. As a sibling it is simply the last flex row
  // of the sheet: the body takes what is left, the bar never moves, and a form whose fields
  // overflow still shows its Save button.
  if (footEl) {
    // THE ACTION GOES AT THE TOP, beside the title, not in a band across the foot.
    // The add button sits at the top of the drawer, where it cannot be scrolled away from,
    // instead of taking a band of vertical space at the bottom just for itself; that
    // lets the drawer come down further.
    // Two things fall out of this for free: it can never be scrolled away from, and it stops
    // needing to be lifted clear of the keyboard, because it was never down there to begin with.
    footEl.classList.add("sh-foot");
    const head = sheet.querySelector(".sh-head");
    const x = head && head.querySelector(".sh-x");
    if (head) { if (x) head.insertBefore(footEl, x); else head.append(footEl); }
    else sheet.append(footEl);
    sheet.dataset.foot = "1";
    // `footRow`: the actions are a block (several buttons, a field, a line of status), not one
    // button. Beside the title a block is as wide as its longest line, which pushes the title
    // to nothing and the close button off the screen. It takes the row under the title instead,
    // still in the head, so it still cannot be scrolled away from.
    if (footRow && head) sheet.dataset.footRow = "1";
  }

  // ── keyboard ─────────────────────────────────────────────────────────────────────────
  // Stated as physics: WHEN THE KEYBOARD OPENS, NOTHING MOVES. Not the page, not
  // the sheet's frame — only the sheet's own body scrolls, to lift the focused field clear.
  //
  // .sh-root is `position: fixed; inset: 0`, i.e. laid out against the LAYOUT viewport, which
  // iOS does not shrink for the keyboard and does offset. So the lock re-lays the root over
  // the VISUAL viewport instead, and from then on the root IS what is on screen: the sheet's
  // `bottom` sits on the keyboard at 0, and the scrim covers every visible pixel and no
  // invisible ones. --sh-kb therefore stays 0 — the offset it used to carry is in the root's
  // own geometry now, where the scrim gets it too.
  //
  // The last measured keyboard height. Read by paintScrim(), which also runs on the very
  // first onViewport — synchronously, from inside keyboardLock() — where `lock` itself is
  // still in its temporal dead zone and lock.metrics() would throw.
  let kbNow = 0;
  const lock = keyboardLock({
    // pin: null — DELIBERATELY. Clamping .sh-root to the visual viewport is what made the drawer
    // ride the keyboard: root's height became 844-336, so a sheet at bottom:0 inside it sat at
    // 508 with its head off the top of the screen, and the app showed through the band above it.
    // The keyboard is an overlay. The root keeps its `inset: 0` full-screen box and the drawer's
    // foot passes behind the keys.
    pin: null, vars: root, scrollport: body,
    onViewport: (m) => {
      kbNow = m.kb;
      // maxFraction is measured against the SCREEN, not the visual viewport: "two thirds
      // tall" has to mean the same thing with the keyboard up as with it down, and the
      // visual viewport is already the smaller term in the min() that reads this.
      if (maxFraction > 0) {
        root.style.setProperty("--sh-max", `${Math.round(window.innerHeight * maxFraction)}px`);
      }
      // The REAL keyboard height now. It used to be pinned to 0 because the sheet rode it as a
      // bottom offset — that is the lift that turned a drawer into a sliver. The drawer now sits
      // at bottom:0 and passes behind the keys; --sh-kb is how its scrollport knows how much of
      // its own foot is covered, so a flick can still bring the last field into view.
      root.style.setProperty("--sh-kb", `${Math.round(m.kb)}px`);
      root.style.setProperty("--sh-vh", `${Math.round(m.height)}px`);
      // With the keys up, a sheet shorter than the screen leaves a band of page showing
      // through a translucent scrim — reading the list you are editing, through the editor.
      // Every sheet blacks that band out while the keyboard is open, not just the ones that
      // opted in: there is no sheet for which the answer is "show them the page instead".
      // No longer forcing the scrim opaque with the keyboard. That existed to hide the page
      // behind moving; the page no longer moves (see goTall below), and a drawer you cannot see
      // past is worse than one you can.
      paintScrim();
    },
  });

  // ── the scrim goes solid on FOCUS, not on the measurement ────────────────────────────
  // The stylesheet blacks the band out at [data-opaque][data-kb="1"], and data-kb cannot be
  // set until visualViewport has told us how tall the keys are — which on iOS is 250-400ms
  // AFTER the focus that raised them, and is then faded in over another 180ms by the
  // background-color transition. Measured in the harness: for roughly half a second of every
  // "New item" the pack list is legible through the scrim, directly above the sheet. That
  // half-second IS "the keyboard shoves the card up and reveals the page beneath".
  //
  // Focus is the signal that arrives on time: a text field taking focus in a sheet means the
  // keyboard is coming, whatever the viewport has noticed yet. So the solid state is written
  // inline, from focus, and only the fade BACK to translucent keeps its transition — going
  // solid must be instant or it is just a slower version of the same leak, while coming back
  // is a real state change worth easing (it happens as the keys slide away and the page is
  // returning anyway).
  //
  // Inline, rather than a new attribute, because .sh-* lives in styles.css: this file must
  // not need a stylesheet edit to be correct.
  const TYPEABLE = /^(text|search|url|tel|email|password|number|date|time|datetime-local|month|week)$/i;
  function typing() {
    const a = document.activeElement;
    if (!a || !sheet.contains(a)) return false;
    // A read-only or disabled field (the board's share link, selected to copy) raises no keyboard: the scrim stays as
    // it is (21 Nov: focusing the link turned everything above the sheet black in one frame).
    if (a.readOnly || a.disabled) return false;
    if (a.tagName === "TEXTAREA" || a.isContentEditable === true) return true;
    return a.tagName === "INPUT" && TYPEABLE.test(a.type || "text");
  }
  function paintScrim() {
    // As a dialog (styles.css, from 768 wide) the page stays in view behind it, shaded: the
    // dialog sits in the middle of it and nothing is shoved anywhere by a field taking the
    // focus. Keys on the glass (a tablet's) still turn it solid, as on a phone.
    const solid = kbNow > 0 || (typing() && !asDialog());
    if (solid) {
      scrim.style.transitionProperty = "opacity";     // no 180ms readable window
      scrim.style.background = "var(--ground)";
    } else {
      scrim.style.transitionProperty = "";            // back to the stylesheet's pair
      scrim.style.removeProperty("background");
    }
  }

  // A field that takes focus behind the keyboard is lifted by scrolling THIS BODY and
  // nothing else. Delegated on the sheet so it covers the pinned footer's controls too.
  sheet.addEventListener("focusin", (e) => {
    if (body.contains(e.target)) lock.reveal(e.target);
    paintScrim();
  });
  // Deferred by a tick: moving between two fields fires focusout before focusin, and reacting
  // to that gap would flash the page back through the scrim between them.
  sheet.addEventListener("focusout", () => setTimeout(paintScrim, 0));

  // ── drag ─────────────────────────────────────────────────────────────────────────────
  // "Swipe-down from anywhere on the sheet when its content is scrolled to top." The
  // scrolled-to-top condition is what keeps the gesture from stealing a scroll: at the top
  // of a list there is nothing above to reveal, so a downward drag can only mean dismiss.
  // The grab handle is exempt and always drags, which is the entire reason a handle exists.
  let startY = 0, lastY = 0, lastT = 0, dy = 0, dyRaw = 0, vel = 0;
  let tracking = false;     // finger down, direction not yet decided
  let dragging = false;     // committed: the sheet is following the finger
  let fromGrab = false;      // the handle or the head: a drag surface in both directions, always
  let fromBlank = false;    // blank space inside the body: a drag surface only at a scroll edge
  let liftFrom = 0;         // sheet height when the upward drag committed
  let liftTo = 0;           // the tall height it is being dragged toward

  function onDown(e) {
    if (e.button != null && e.button !== 0) return;     // right-click, middle-click
    // THE EXACT POINT, not the event's target. Both engines do touch adjustment: a touch that
    // lands near a control is retargeted ONTO that control, so `e.target` for a drag starting
    // in the gap beside a button is the button. That is the right answer for a tap and the
    // wrong one for a drag — it would make "swipe down from blank space" fail wherever the
    // form is dense, which is everywhere that matters. Hit-testing the coordinate gives the
    // element actually under the finger; taps are unaffected, because nothing here consumes
    // the event unless a drag commits.
    const at = (e.clientX != null && document.elementFromPoint(e.clientX, e.clientY))
      || e.target;
    if (at.closest(".sh-x")) return;                    // the close button is not a handle
    // A region that handles its own gestures (the picture pad, which you draw on with the same finger) is never a
    // handle: a stroke down the pad is a stroke, not the sheet being pulled away.
    if (at.closest("[data-own-gesture]")) return;
    // ...but NOT the action bar that now lives in the head: a press on Save is a press on Save,
    // not the start of a dismiss drag.
    fromGrab = (!!at.closest(".sh-grab") || !!at.closest(".sh-head"))
      && !at.closest(".sh-foot");
    // BLANK SPACE IS A HANDLE TOO. A drawer you can only drag by its lip is a drawer you keep
    // missing — the gaps beside buttons, between rows, around a fieldset all read as "the
    // drawer" to a thumb. Anything that is not itself a control counts, so a pull that starts
    // on a button still belongs to the button and a pull that starts on nothing belongs here.
    const onControl = !!at.closest(
      "button,a[href],input,select,textarea,label,[role=button],[contenteditable=true]");
    // "A pull that starts on a button belongs to the button" is a rule for the drawers that
    // asked for it — the ones with dragFrom:"handle", which are the forms. A dragFrom:"body"
    // sheet's whole contract is that a swipe anywhere dismisses it, and quietly exempting its
    // controls would take the dismiss gesture off a sheet that is mostly controls.
    fromBlank = !fromGrab && (!handleOnly || !onControl);
    // dragFrom:"handle" — the content is not a dismiss surface at all. This is what resolves
    // the scroll-vs-dismiss fight for a sheet whose body scrolls: at the top of a form, a
    // downward drag is ambiguous, and guessing wrong either eats the scroll or eats the form.
    if (handleOnly && !fromGrab && !fromBlank) return;
    // NO scroll gate here. Which edge matters depends on which way the finger goes, and at
    // pointerdown there is no direction yet — asking now would gate an upward drag on the
    // top edge. canDrag() decides once the direction is known.
    tracking = true; dragging = false;
    startY = lastY = e.clientY;
    lastT = performance.now();
    dy = 0; dyRaw = 0; vel = 0;
  }

  // SCROLL EDGES. Sampled live rather than at gesture start: if the scroller moved under
  // an earlier part of the same gesture, the drawer must not then claim the rest of it.
  // A body with nothing to scroll (scrollHeight <= clientHeight) is at BOTH edges at once,
  // which is what makes a short form draggable from anywhere in either direction.
  const EDGE_SLOP = 1;   // sub-pixel scroll offsets never quite reach the arithmetic bottom
  const atTop = () => body.scrollTop <= EDGE_SLOP;
  const atBottom = () =>
    body.scrollTop >= body.scrollHeight - body.clientHeight - EDGE_SLOP;

  // Whether a drag in direction `d` belongs to the drawer or to the scroller underneath it.
  // The handle and the head always belong to the drawer. Blank space in the BODY only takes
  // the gesture at the edge the gesture is heading away from — otherwise the list still has
  // somewhere to go and scrolling is what the thumb meant.
  function canDrag(d) {
    if (d > 0) {                                   // downward: tall -> normal, or dismiss
      if (fromGrab) return true;
      return fromBlank && atTop();
    }
    if (root.dataset.tall === "1") return false;   // upward: already as tall as it goes
    if (fromGrab) return true;
    return fromBlank && atBottom();
  }

  // The height the drawer is dragged TOWARD. .sh-root is inset:0, so its clientHeight is the
  // layout viewport — the same base the [data-tall] rule's `100%` resolves against, which is
  // why this is measured off the root and not off 100dvh (dvh does not shrink for the keys).
  function tallHeight() {
    // MUST match the [data-tall] rule in styles.css exactly. It is the height the drag settles
    // onto, so a formula that disagrees by even a few pixels shows up as the drawer snapping
    // at the end of an otherwise smooth pull. tallFor() measures the rule's own formula, --safe-top (the status-bar band)
    // included, which is what keeps the tall drawer out from under the clock.
    return tallFor(root);
  }

  function onMove(e) {
    if (!tracking) return;
    const y = e.clientY;
    // performance.now(), NOT e.timeStamp. Both are DOMHighResTimeStamps and they are
    // supposed to share an origin, but mixing the two clocks across handlers is how you get
    // a velocity of 40px divided by "milliseconds since the page loaded". One clock.
    const t = performance.now();

    if (!dragging) {
      const d = y - startY;
      if (Math.abs(d) < DRAG_SLOP) return;
      // Upward, or the body has scrolled under us mid-gesture: this is a scroll, not a
      // dismiss. Let go of it completely rather than fighting the scroller.
        // An upward pull is a legitimate gesture now (normal -> tall), so it is no longer
      // abandoned — but only from a handle or blank space, never from inside a scrolling list
      // that still has somewhere to go.
      if (!canDrag(d)) { tracking = false; return; }
      dragging = true;
      root.dataset.drag = "1";
      // A drag that starts DURING a settle takes the drawer over from wherever it has animated
      // to. Without this the settle's transition is still on — it is declared after the drag
      // rule at equal specificity, so it wins — and the drawer follows the thumb through a
      // 220ms curve, which feels like dragging something through syrup. Pin the height that is
      // actually on screen, drop the transition, and the drag picks it up exactly there.
      if (root.dataset.settle === "1") {
        clearTimeout(settleT);
        delete root.dataset.settle;
        root.style.setProperty("--sh-h", `${Math.round(sheet.offsetHeight)}px`);
      }
      // Measured ONCE, at the moment the drag commits — not per frame. Reading offsetHeight
      // inside the move handler would force a synchronous layout on every sample, which is
      // the classic way a drag like this drops to 30fps.
      liftFrom = sheet.offsetHeight;
      liftTo = tallHeight();
      if (e.pointerId != null && sheet.setPointerCapture) {
        try { sheet.setPointerCapture(e.pointerId); } catch { /* mouse on some engines */ }
      }
    }

    dyRaw = y - startY;
    // Downward travel moves the panel; upward travel grows it. Different properties because
    // they are different gestures — one slides the drawer toward the edge of the screen, the
    // other changes how much screen the drawer occupies — but both follow the thumb frame for
    // frame. Neither is decided on release; release only settles onto the nearest detent.
    dy = Math.max(0, dyRaw);
    root.style.setProperty("--sh-dy", `${dy}px`);

    const up = Math.max(0, -dyRaw);
    if (up > 0 && liftTo > liftFrom) {
      root.style.setProperty("--sh-h", `${Math.round(Math.min(liftTo, liftFrom + up))}px`);
      root.dataset.lift = "1";
    } else if (root.dataset.lift === "1") {
      delete root.dataset.lift;
      root.style.removeProperty("--sh-h");
    }

    // Instantaneous speed over the most recent leg, not an average of the whole gesture: a
    // slow pull that ends in a flick has to read as a flick, and a fast pull that stops dead
    // at the bottom has to read as a stop. 8ms is a floor on the sample window — at 120Hz
    // two frames can arrive inside a millisecond of each other and the division explodes.
    const dt = t - lastT;
    if (dt > 8) { vel = (y - lastY) / dt; lastY = y; lastT = t; }
  }

  // Releasing mid-drag must ANIMATE to the detent, not jump to it. The drag leaves the
  // drawer at an arbitrary height and the resting rules would snap it up to half a screen
  // away, which reads as the drawer being yanked out of your hand at the last moment.
  //
  // height:auto is not animatable, so the settle keeps driving --sh-h — now toward the target
  // rather than from the finger — and only hands back to the class-driven height once the
  // transition has landed on the same number. data-settle is what turns the transition on;
  // without it every per-frame write during the drag would be chasing a curve.
  let settleT = 0;
  function settleTo(target) {
    clearTimeout(settleT);
    if (!(target > 0)) { clearLift(); return; }
    root.style.setProperty("--sh-h", `${Math.round(target)}px`);
    root.dataset.settle = "1";
    settleT = setTimeout(clearLift, SETTLE_MS);
  }
  function clearLift() {
    clearTimeout(settleT);
    delete root.dataset.settle;
    delete root.dataset.lift;
    root.style.removeProperty("--sh-h");
  }

  // ── THE SHEET FOLLOWS ITS CONTENT WITH THE SYSTEM'S MOTION ─────────────────────────────
  // A sheet whose content grows after a request (a share link arriving, "More details" opening) used to jump to its new
  // height in one frame, everything below the new row moving ~240 px at once (20 Nov, the board's share sheet). A
  // ResizeObserver sees the new height after layout and before paint: the sheet is held at the height it had, then
  // settles to the new one exactly as a released drag does (settleTo: height eased over --dur, nothing blocked, a tap
  // still lands where it is). Not while a finger drags it or a settle runs, not when the keys came up or went down (the
  // keyboard's own rules move it), not before the sheet has arrived, and not under reduced motion: it simply arrives.
  let restH = 0, restKb = root.dataset.kb || "";
  const follow = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    const h = sheet.offsetHeight, was = restH, kb = root.dataset.kb || "", kbWas = restKb;
    restH = h; restKb = kb;
    if (torn || root.dataset.entered !== "1" || tracking || dragging || root.dataset.lift === "1" || root.dataset.settle === "1") return;
    if (!was || Math.abs(h - was) < 4 || kb !== kbWas) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    root.dataset.lift = "1";
    root.style.setProperty("--sh-h", `${was}px`);
    void sheet.offsetHeight;          // commit the old height before the eased one is asked for
    settleTo(h);
  }) : null;
  if (follow) follow.observe(sheet);

  // ABANDONED, not released. A second finger landing mid-drag, a touchcancel from an incoming
  // call or a system edge gesture — none of these are the user letting go, so none of them get
  // to decide anything. The old guard only cleared the flags, which left --sh-dy, --sh-h and
  // data-drag exactly as the drag had written them and the following touchend taking onUp's
  // `!tracking` exit: the drawer stayed stuck at whatever height and offset the finger left it.
  // Put back everything the drag wrote and settle to the detent it started from.
  function cancelDrag() {
    if (!tracking && !dragging) return;
    const wasLifted = root.dataset.lift === "1";
    tracking = false; dragging = false;
    root.dataset.drag = "0";
    root.style.removeProperty("--sh-dy");
    dy = 0; dyRaw = 0; vel = 0;
    if (wasLifted) settleTo(liftFrom); else clearLift();
  }

  function onUp() {
    if (!tracking) return;
    const wasDragging = dragging;
    tracking = false; dragging = false;
    root.dataset.drag = "0";
    root.style.removeProperty("--sh-dy");
    if (!wasDragging) return;

    // A flick that ended more than 120ms ago is not a flick. Holding the sheet still at 100px
    // and then lifting is a decision to keep it, and without this it would be dismissed by a
    // velocity measured a second earlier.
    if (performance.now() - lastT > 120) vel = 0;

    const far = dy > sheet.offsetHeight * DISMISS_FRACTION;
    const flicked = vel > DISMISS_VELOCITY && dy > FLICK_MIN_PX;
    // THREE POSITIONS, not two: closed / normal / tall. The release lands on whichever the
    // gesture asked for.
    //   tall   + pulled down -> normal   (never straight to closed — stopping in the middle is
    //                                     the point, rather than all-or-nothing)
    //   normal + pulled down -> closed
    //   normal + pulled up   -> tall     (so typing is not the only way to get full height)
    const up = -dyRaw;
    const lifted = root.dataset.lift === "1";
    if (root.dataset.tall === "1") {
      if (dy > TALL_RELEASE || (flicked && dy > 24)) {
        delete root.dataset.tall;
        const a = document.activeElement;
        if (a && sheet.contains(a) && typeof a.blur === "function") a.blur();
      }
      return;                              // a tall drawer never dismisses in one pull
    }
    if (lifted) {
      // PROPORTIONAL, not a fixed distance. Once the pull is previewed continuously, what
      // settles it is how much of the way it got — a 56px rule would complete a gesture that
      // visibly covered a fifth of the travel, which is the same lie as snapping.
      const span = Math.max(1, liftTo - liftFrom);
      const covered = Math.min(1, Math.max(0, up) / span);
      const wantTall = covered > TALL_SETTLE
        || (vel < -DISMISS_VELOCITY && up > FLICK_MIN_PX);   // a flick always completes
      if (wantTall) root.dataset.tall = "1";
      settleTo(wantTall ? liftTo : liftFrom);
      return;
    }
    // No preview happened — there was nothing to grow into. Fall back to the flat threshold.
    if (up > PULL_UP || (vel < -DISMISS_VELOCITY && up > 24)) { root.dataset.tall = "1"; return; }
    if (far || flicked) close();
    // else: data-drag went to 0 and the CSS transition springs it back to translateY(0).
  }

  // Non-passive, and the reason is iOS: a touchmove that is not preventDefault()ed hands the
  // gesture to the scroller, which then fires pointercancel and the drag dies halfway down.
  //
  // It also has to decide EARLIER than the pointer stream does. Safari can dispatch
  // touchmove ahead of the pointermove derived from it, and by the time `dragging` flips the
  // scroller may already own the gesture. So: at the top of the body, or on the handle, any
  // downward movement is claimed from the very first event. That is safe by construction —
  // at scrollTop 0 there is nothing above to scroll to, so a downward drag can only be a
  // dismiss.
  // One finger only. A second finger landing mid-drag means a pinch or a fumble, and carrying
  // on with the first one's coordinates is how a drawer ends up halfway off the screen.
  sheet.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { cancelDrag(); return; }
    onDown({ target: e.target, clientX: e.touches[0].clientX,
      clientY: e.touches[0].clientY, button: 0, pointerId: null });
  }, { passive: true });

  sheet.addEventListener("touchmove", (e) => {
    if (!tracking || !e.touches || !e.touches.length) return;
    const t = e.touches[0];
    const d = t.clientY - startY;
    // Claimed BEFORE the drag commits, not after. A touchmove WebKit was allowed to handle
    // goes to the scroller, and the gesture never gets a second chance — which is why this
    // asks canDrag() from the first pixel rather than waiting for DRAG_SLOP.
    if (dragging || (Math.abs(d) >= 1 && canDrag(d))) e.preventDefault();
    onMove({ clientY: t.clientY, pointerId: null });
  }, { passive: false });

  sheet.addEventListener("touchend", () => onUp());
  sheet.addEventListener("touchcancel", () => cancelDrag());

  // Mouse and pen only — see above. On a touchscreen these would be a second, lagging copy of
  // a gesture that is already being handled.
  const mouse = (fn) => (e) => { if (e.pointerType !== "touch") fn(e); };
  sheet.addEventListener("pointerdown", mouse(onDown));
  sheet.addEventListener("pointermove", mouse(onMove));
  sheet.addEventListener("pointerup", mouse(onUp));
  sheet.addEventListener("pointercancel", mouse(cancelDrag));

  // ── dismissal ────────────────────────────────────────────────────────────────────────
  scrim.addEventListener("click", () => close());
  const xBtn = root.querySelector(".sh-x");
  if (xBtn) xBtn.addEventListener("click", () => close());

  function onKey(e) {
    if (stack[stack.length - 1] !== api) return;        // only the topmost sheet answers
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    // Keep Tab inside the sheet. Without this the first Tab lands on whatever the browser
    // thinks is next in the document, which with `inert` applied is nothing at all — focus
    // goes to the address bar and never comes back.
    const f = sheet.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    // preventScroll on BOTH, like every other focus() in this file. A Tab that wraps to the
    // far end of a scrolling form is the browser's own scroll-into-view invitation, and it
    // does not stop at the sheet's body — it walks #view and the document too. The focusin
    // handler below lifts the field inside the scrollport instead, which is the only mover
    // this file allows. (Reachable with a hardware keyboard, and on iOS with the keyboard's
    // own next/previous arrows, which dispatch exactly this.)
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus({ preventScroll: true }); lock.reveal(last);
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus({ preventScroll: true }); lock.reveal(first);
    }
  }
  document.addEventListener("keydown", onKey, true);

  let closed = false;
  let torn = false;
  let exitTimer = null;
  const returnFocus = document.activeElement;

  function teardown() {
    // Both exits race by design — transitionend and the deadline — and whichever loses
    // still fires. Without this guard onClose() runs twice, which for a caller that reopens
    // or refetches on close is a real double action, not a cosmetic one.
    if (torn) return;
    torn = true;
    if (follow) follow.disconnect();
    if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
    document.removeEventListener("keydown", onKey, true);
    // Normally already released, by close(). Repeated here because teardown is also the
    // deadline path, and a lock left held would freeze the page forever. Idempotent.
    lock.release();
    root.remove();
    const i = stack.indexOf(api);
    if (i >= 0) stack.splice(i, 1);
    if (!stack.length) setInert(false);
    // Only take focus back if it is still ours to give — the caller's onClose may have
    // navigated, and stealing focus onto a detached node blanks it for VoiceOver.
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === "function") {
      // preventScroll, always: the page has just been unfrozen at exactly the offset it had
      // when the sheet opened, and a focus that scrolls to find its target would undo that
      // in the last frame of the close.
      returnFocus.focus({ preventScroll: true });
    }
    if (typeof onClose === "function") onClose();
  }

  function close() {
    if (closed) return;
    closed = true;
    root.dataset.open = "0";
    root.dataset.drag = "0";
    // BLUR BEFORE THAWING, and the order is the whole point. The sheet lives on for the
    // length of the slide and the focused field lives with it, so on iOS the keys are still
    // up — and they only start coming down when that field gives up focus. Every frame of
    // that descent is another visual-viewport change, i.e. another chance for the engine to
    // move the page. Asking for it HERE spends those frames against a page that is still
    // pinned; leaving it to teardown spends them against one that is not.
    const a = document.activeElement;
    if (a && sheet.contains(a) && typeof a.blur === "function") a.blur();
    // Unfreeze HERE, at the start of the exit, not at teardown 280ms later. Two reasons, both
    // about who owns the page's scroll next: an unmount closes its sheet on the way out and
    // the router restores the incoming screen's scroll inside that same window, and a caller
    // that closes one sheet to open another must not have the second freeze racing the
    // first's thaw. During the slide the page is still `inert` and still behind the scrim, so
    // giving its scroll back early costs nothing.
    lock.release();
    // transitionend OR the deadline, whichever lands first. Under reduced motion the
    // transition is `none` and the event never fires at all: nothing slides, so the sheet is
    // taken down in the next task (never in this one: a caller's lines after close() run first).
    // Only the sheet's OWN slide counts. transitionend bubbles, so a button inside it that
    // eases its own transform on a press sends one up too, and taking that for the slide's
    // end tore the sheet down mid-slide. Any other end that arrives first is passed over, and
    // the listener stays until the sheet's own does.
    sheet.addEventListener("transitionend", (e) => {
      if (e.target === sheet && e.propertyName === "transform") teardown();
    });
    exitTimer = setTimeout(teardown, slideMs(sheet) <= 0 ? 0 : EXIT_MS);
  }

  const api = { close, el: sheet };

  // ── on screen ────────────────────────────────────────────────────────────────────────
  document.body.append(root);
  setInert(true);
  stack.push(api);

  // A forced reflow, NOT requestAnimationFrame. The element has to be laid out at
  // translateY(100%) before the attribute flips, or the browser coalesces both styles into
  // one recalc and the sheet just appears. Reading offsetHeight commits that first state
  // synchronously, which is the same trick the shell's toast uses.
  //
  // rAF would do it too, and would silently NOT do it in a backgrounded tab, where rAF is
  // throttled to nothing — measured here: the sheet stayed at data-open="0" indefinitely.
  // A panel that never opens because the phone was asleep when the callback was queued is
  // not a trade worth making for one frame.
  void sheet.offsetHeight;
  root.dataset.open = "1";

  // ── THE SHEET IS REALLY OPEN, ANNOUNCED ONCE ─────────────────────────────────────────
  //
  // A caller that wants to do something the instant the drawer has finished arriving — put
  // the caret in a field, start a measurement, announce a heading — used to have to guess
  // the length of the slide with its own setTimeout. Guessing is wrong in both directions:
  // too early focuses a field that is still moving under the thumb, which is the exact bug
  // the "never autofocus mid-slide" rule above exists to prevent, and too late leaves the
  // drawer sitting there with a dead keypad. It is also silently wrong the moment
  // --dur-slow changes in styles.css, because the caller's number does not.
  //
  // So the sheet says when it has arrived, and it says it EXACTLY ONCE. The mechanism is the
  // same "real event OR a deadline, whichever lands first" pair teardown() uses, for the same
  // reason: `transition: none` under prefers-reduced-motion never fires transitionend at all,
  // and a promise that only resolves when the phone happens to be animating is not a promise.
  //
  //   * transitionend on the sheet's own `transform` is the truth, and the common path.
  //   * The deadline is read off the ELEMENT's own computed transition rather than off a
  //     constant, so it tracks the stylesheet instead of drifting from it. A 0s transition —
  //     reduced motion, or a backgrounded tab that never composites — resolves on the next
  //     frame instead of after a wait nobody is watching.
  //
  // data-entered is stamped at the same moment and is deliberately observable from outside:
  // it is what the harnesses wait on, so the check and the app agree on ONE definition of
  // "open" rather than each keeping its own sleep().
  let entered = false;
  let enterTimer = null;
  const onEntered = () => {
    if (entered || torn) return;
    entered = true;
    if (enterTimer) { clearTimeout(enterTimer); enterTimer = null; }
    root.dataset.entered = "1";
    // The caller runs LAST, after the attribute, so anything it does synchronously — taking
    // focus, measuring — happens against a sheet that already reads as open to everyone else.
    if (typeof onOpen === "function") onOpen();
  };
  sheet.addEventListener("transitionend", (e) => {
    if (e.target === sheet && e.propertyName === "transform") onEntered();   // its own slide, as close()'s
  });
  {
    const longest = slideMs(sheet);
    // setTimeout and not requestAnimationFrame, for the reason spelled out over the forced
    // reflow above: rAF is throttled to nothing in a backgrounded tab, and a drawer that
    // never announces itself because the phone was asleep is the failure this is meant to
    // remove. A 0ms timer is a task, and tasks still run.
    enterTimer = setTimeout(onEntered, longest <= 0 ? 0 : longest + 60);   // headroom, like EXIT_MS's
  }

  // Focus the first real control if there is one; the panel itself otherwise.
  //
  // The comment here used to say "deliberately NOT an autofocus into a text field" while the
  // selector below happily matched `input` and `textarea` — so New item, whose first control IS
  // its label field, opened the keyboard the instant the + was tapped, mid-slide: a text
  // field selected by itself, and the screen jumping around right after the press of the
  // plus button. The intent was right; the selector never implemented it.
  //
  // Text entry is now always the user's decision. Buttons, selects and links still take focus,
  // because those do not summon a keyboard.
  // ── TAPPING A TEXT FIELD IN A DRAWER ─────────────────────────────────────────────────
  //
  // Three things, in one gesture, for the same reason the note composer does it on touchstart:
  // WebKit decides whether to scroll the PAGE to reveal the focused field, and it has decided
  // by the time focusin runs. Give it nothing to reveal and it leaves the page alone.
  //
  //   1. Go TALL. The drawer grows to near-fullscreen and STAYS there — dismissing the keyboard
  //      does not shrink it back. It drops only when dragged down or closed.
  //   2. Scroll the DRAWER to the field, so the field is above where the keys will land. This is
  //      the movement that should happen: inside the drawer, focus behaves like a normal page.
  //   3. Focus it here, because steps 1 and 2 move the field out from under the finger and the
  //      native tap would otherwise land on whatever slid into its place.
  function goTall(field) {
    root.dataset.tall = "1";
    const kb = kbHint();
    // Where the keys will land, in viewport coordinates.
    const keyLine = window.innerHeight - kb;
    // Let the tall state apply before measuring, or the scroll is computed against the old box.
    const r = field.getBoundingClientRect();
    const over = r.bottom - (keyLine - REVEAL_PAD);
    if (over > 0 && body) {
      const max = Math.max(0, body.scrollHeight - body.clientHeight);
      body.scrollTop = Math.min(max, body.scrollTop + over);
    }
    if (document.activeElement !== field) field.focus({ preventScroll: true });
  }

  // The keyboard's height, remembered by the shell from the last time it was measured. The
  // drawer needs the number BEFORE the keyboard exists, which is the whole point.
  function kbHint() {
    let n = 0;
    try { n = Number(localStorage.getItem("wgp.kbh")) || 0; } catch (e) { /* private mode */ }
    if (!n) n = Math.round(window.innerHeight * 0.42);   // first ever focus: a sane guess
    return n;
  }

  const isTextField = (el) => !!el && el.closest
    && !!el.closest("input:not([type=checkbox]):not([type=radio]):not([type=button])"
                    + ":not([type=submit]),textarea");

  sheet.addEventListener("touchstart", (e) => {
    // Hit-tested at the coordinate, for the same reason onDown is: touch adjustment retargets a
    // touch that landed in the gap BESIDE a field onto the field. Reading e.target here meant
    // that starting a scroll near an input focused it, raised the keyboard and threw the drawer
    // to full height — a gesture the user never made.
    const t = e.touches && e.touches[0];
    const at = (t && document.elementFromPoint(t.clientX, t.clientY)) || e.target;
    const field = at.closest("input:not([type=checkbox]):not([type=radio]):not([type=button])"
      + ":not([type=submit]),textarea");
    if (!field || !sheet.contains(field)) return;
    if (document.activeElement === field) return;   // already typing; let the caret move
    goTall(field);
    e.preventDefault();
  }, { passive: false });

  // Touch is the common path, but not the only one: the keyboard's own next/previous arrows, a
  // hardware Tab, and anything that calls focus() directly all arrive here instead. Same result,
  // minus the focus call — it already has focus by now.
  sheet.addEventListener("focusin", (e) => {
    if (!isTextField(e.target)) return;
    if (root.dataset.tall === "1") { revealIn(body, e.target); return; }
    goTall(e.target);
  });

  (keeperIn(sheet) || sheet).focus({ preventScroll: true });

  return api;
}

// ── where the keyboard's focus starts ───────────────────────────────────────────────────
// THE FIRST FOCUS NEVER LANDS ON A BUTTON THAT DESTROYS SOMETHING. Whatever has the focus is
// what Enter and Space press, and a sheet takes the focus the moment it opens: a sheet that
// asks "delete this?" with the focus on Delete deletes on the Enter that was meant for the
// field behind it. So the focus starts on the first control that KEEPS: every control that
// destroys is passed over, wherever it sits in the sheet. A sheet with nothing but
// destroying controls takes the focus itself, and Enter then presses nothing.
//
// A control that destroys says so in its markup: the danger style (.btn-danger), or
// data-destroys where it is drawn another way (an icon, a small "Discard").
// scripts/first_focus_check.mjs opens the app's sheets and holds them to this, and fails on a
// button whose words destroy and whose markup doesn't say so.
const DESTROYS = ".btn-danger,[data-destroys]";
const TAKES_FOCUS = 'select,button:not(.sh-x),a[href],input[type="checkbox"],input[type="radio"]';

/** The control in `root` the focus should start on: the first that doesn't destroy. null when there is none. */
export function keeperIn(root) {
  for (const n of root.querySelectorAll(TAKES_FOCUS)) {
    if (n.matches(DESTROYS) || n.disabled) continue;
    return n;
  }
  return null;
}

/**
 * For an ask drawn in place (a row that turns into "Stop sharing this? [Stop] [Keep]"): put
 * the focus on the control in `root` that keeps. Returns it, or null when there is none (the
 * focus is then left where it was).
 */
export function focusKeeper(root) {
  const n = root ? keeperIn(root) : null;
  if (n) n.focus({ preventScroll: true });
  return n;
}

/** Close every open sheet. For the router, on navigation away. */
export function closeAllSheets() {
  for (const s of [...stack]) s.close();
}

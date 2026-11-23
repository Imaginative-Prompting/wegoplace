// Report a bug: the one form, in More's sheet (settings.js, signed in: the report is linked to the account) and on the
// sign-in page's /report (report-page.js, signed out: sent without the session cookie, linked to no one). The person
// writes what happened, may add a screenshot, and SEES everything that goes along before Send (the rows under "Sent
// with it"), built from the very object that is sent: nothing goes that isn't on a row. The rules are the server's own
// (shared/bug-rules.js; src/bug-reports.js keeps it).
//
// A screenshot is always redrawn here before it goes: the picture only, so whatever its file carried besides (where a
// photo was taken, the camera, a PNG's text, a color profile) stays on the device; a PNG stays a PNG while it's small
// enough, so its words stay sharp, else it's scaled and sent as WebP (JPEG where the browser can't write WebP).

import { BUG_LIMITS, cleanContext, recentGroups, SCREENSHOT_TYPES } from "./shared/bug-rules.js";
import { coarseBrowser } from "./shared/error-clean.js";

/** The kind of device: a touch screen's shorter side under 600 px a phone, over it a tablet; no touch screen, a computer. */
export function deviceKind() {
  try {
    if (!matchMedia("(pointer: coarse)").matches) return "computer";
    return Math.min(screen.width, screen.height) < 600 ? "phone" : "tablet";
  } catch { return ""; }
}

/** Whether this is the app from the Home Screen, not a browser's tab. */
export function installedApp() {
  try { return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; } catch { return false; }
}

/**
 * The app's version on this page: the build the page names (<meta name="wgp-build">, which every page carries, held
 * equal to sw.js VERSION), so a page with no offline copy yet (a first visit, a private window, caches cleared) still
 * says it; only a page without the meta falls back to its offline copy's (sw.js names the shell cache
 * wegoplace-shell-<VERSION>). "" when neither says.
 */
export async function appVersion() {
  try {
    const built = document.querySelector('meta[name="wgp-build"]')?.getAttribute("content") ?? "";
    if (/^v\d{1,6}$/.test(built)) return built;
  } catch { /* no document: the offline copy's */ }
  try {
    const keys = (await globalThis.caches?.keys()) ?? [];
    const own = keys.map((k) => /^wegoplace-shell-(v\d{1,6})$/.exec(k)?.[1]).filter(Boolean).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
    return own[0] ?? "";
  } catch { return ""; }
}

/** What goes along, exactly as it's sent: the screen as an address (cleaned to its pattern), and this device's facts. */
export async function reportContext(screenAddress) {
  return cleanContext({ screen: String(screenAddress ?? ""), version: await appVersion(), device: deviceKind(), installed: installedApp(), recentErrors: recentGroups() });
}

/** A screenshot that can't be sent: "unreadable" (this browser can't open it) or "big" (too big even scaled down). */
export class ScreenshotError extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
}

const blobOf = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/** A picture from the device, redrawn, ready to send (above): a Blob of a type SCREENSHOT_TYPES names, under the target. */
export async function redrawScreenshot(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new ScreenshotError("unreadable"); }
  try {
    const side = Math.max(bitmap.width, bitmap.height);
    for (const maxSide of [BUG_LIMITS.screenshotSide, 1600, 1200]) {
      const scale = Math.min(1, maxSide / side);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (file.type === "image/png") {
        const png = await blobOf(canvas, "image/png");
        if (png && png.size <= BUG_LIMITS.screenshotTarget) return png;
      }
      for (const quality of [0.86, 0.72]) {
        let blob = await blobOf(canvas, "image/webp", quality);
        // A browser that can't write WebP hands back a PNG instead; JPEG stays small.
        if (!blob || blob.type !== "image/webp") blob = await blobOf(canvas, "image/jpeg", quality);
        if (blob && SCREENSHOT_TYPES.includes(blob.type) && blob.size <= BUG_LIMITS.screenshotTarget) return blob;
      }
    }
  } finally {
    bitmap.close?.();
  }
  throw new ScreenshotError("big");
}

/**
 * Sends a report: { ok: true }, { ok: false, offline: true } when no answer came, or { ok: false, reason } with the server's
 * words (null when it gave none). `withAccount` false sends it without the session cookie: from /report, it names no one.
 */
export async function sendReport({ text, context, screenshot = null, withAccount }) {
  const form = new FormData();
  form.set("text", text);
  form.set("context", JSON.stringify(context));
  if (screenshot) form.set("screenshot", screenshot, "screenshot");
  let response;
  try {
    response = await fetch("/api/bug-reports", { method: "POST", body: form, credentials: withAccount ? "same-origin" : "omit", cache: "no-store" });
  } catch {
    return { ok: false, offline: true };
  }
  if (response.ok) return { ok: true };
  let reason = null;
  try { const body = await response.json(); reason = typeof body?.reason === "string" ? body.reason : null; } catch { /* no words */ }
  return { ok: false, reason };
}

/** A size for people: 412 KB, 1.2 MB. */
export const sizeWords = (bytes) => (bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`);

const DEVICE_WORDS = { phone: "Phone", tablet: "Tablet", computer: "Computer" };

// The form's own look, on the design system's tokens, the same in More's sheet and on /report: put in once.
const STYLE = `
.rb-form { display: grid; gap: 14px; }
.rb-form .rb-text { min-height: 7.5em; }
.rb-form .rb-shot-row { padding: 4px 0; }
.rb-form .rb-thumb { width: 52px; height: 52px; object-fit: cover; border-radius: 10px; border: 1px solid var(--edge); display: block; }
.rb-form .rb-along { margin: 4px 0 0; }
.rb-form .rb-along-help { margin: -8px 0 0; }
.rb-form .rb-rows .ds-item { min-height: 0; padding: 6px 0; }
.rb-form .rb-rows .ds-item-title { font-weight: 500; }
.rb-form .rb-value { white-space: normal; max-width: 60vw; }
.rb-form .rb-status { margin: 0; min-height: 1.4em; color: var(--ink-2); }
.rb-form .rb-status[data-mood="right"] { color: var(--positive); font-weight: 600; }
.rb-form .rb-status[data-mood="wrong"] { color: var(--negative); font-weight: 600; }
`;
function styleOnce() {
  if (document.getElementById("rb-style")) return;
  const style = document.createElement("style");
  style.id = "rb-style";
  style.textContent = STYLE;
  document.head.append(style);
}

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.filter(Boolean));
  return node;
}

/**
 * The form. `screenAddress` is the screen the person was on, as an address ("/t/k3x9…/#/split": only its pattern is
 * sent); `screenName` what it's called ("Split"); `withAccount` whether it goes with their account (More) or with none
 * (/report). Returns { el, ready, dispose }: `ready` settles once the rows show what will be sent.
 */
export function reportForm({ screenAddress, screenName = "", withAccount }) {
  styleOnce();
  let context = null;
  let screenshot = null;
  let preview = null;
  let busy = false;

  const box = h("textarea", { class: "ds-textarea rb-text", id: "rb-text", name: "text", rows: "5", maxlength: String(BUG_LIMITS.text),
    autocapitalize: "sentences", placeholder: "What you did, what you expected, and what happened instead" });
  const count = h("span", { class: "ds-label-aside rb-count", "aria-live": "off" });
  const paintCount = () => { const n = [...box.value].length; count.textContent = n > BUG_LIMITS.text * 0.8 ? `${n} of ${BUG_LIMITS.text}` : ""; };
  box.addEventListener("input", paintCount);

  const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/heic,image/heif", hidden: true, "data-rb-file": true });
  const shot = h("div", { class: "rb-shot" });
  const status = h("p", { class: "rb-status", role: "status", "aria-live": "polite" });
  const say = (words, mood = "") => { status.textContent = words; status.dataset.mood = mood; };

  function drawShot() {
    if (preview) URL.revokeObjectURL(preview);
    preview = screenshot ? URL.createObjectURL(screenshot) : null;
    if (!screenshot) {
      const add = h("button", { type: "button", class: "ds-button ds-button--gray ds-button--sm rb-add", text: "Add a screenshot" });
      add.addEventListener("click", () => file.click());
      shot.replaceChildren(add);
      return;
    }
    const remove = h("button", { type: "button", class: "ds-button ds-button--fade ds-button--sm rb-remove", text: "Remove" });
    remove.addEventListener("click", () => { screenshot = null; drawShot(); paintRows(); });
    shot.replaceChildren(h("div", { class: "ds-item rb-shot-row" },
      h("span", { class: "ds-item-lead" }, h("img", { class: "rb-thumb", src: preview, alt: "Your screenshot" })),
      h("span", { class: "ds-item-main" }, h("span", { class: "ds-item-title", text: "Screenshot" }), h("span", { class: "ds-item-sub", text: `${sizeWords(screenshot.size)}, redrawn on this device` })),
      h("span", { class: "ds-item-trail" }, remove)));
  }
  file.addEventListener("change", async () => {
    const picked = file.files?.[0];
    file.value = "";
    if (!picked) return;
    try {
      screenshot = await redrawScreenshot(picked);
      say("");
    } catch (error) {
      screenshot = null;
      say(error instanceof ScreenshotError && error.kind === "big" ? `That picture is too big, even made smaller. A screenshot can be up to ${BUG_LIMITS.screenshotBytes / 1_000_000} MB.`
        : "That picture couldn't be opened here. Try a PNG or JPEG screenshot.", "wrong");
    }
    drawShot();
    paintRows();
  });

  // What goes along, one row each, from the object that is sent.
  const rows = h("div", { class: "rb-rows", "data-rb-along": true });
  function paintRows() {
    if (!context) return;
    const row = (title, value, key) => h("div", { class: "ds-item rb-row", "data-along": key },
      h("span", { class: "ds-item-main" }, h("span", { class: "ds-item-title", text: title })),
      h("span", { class: "ds-item-trail ds-item-sub rb-value", text: value || "Not known" }));
    const device = [DEVICE_WORDS[context.device], coarseBrowser(navigator.userAgent), context.installed ? "the installed app" : "a browser tab"].filter(Boolean).join(" · ");
    const errors = context.recentErrors.length;
    rows.replaceChildren(
      row("Screen", context.screen ? screenName || context.screen : "", "screen"),
      row("Version", context.version, "version"),
      row("Device", device, "device"),
      row("Recent errors on this device", errors ? `${errors} (codes only)` : "None", "errors"),
      row("Screenshot", screenshot ? sizeWords(screenshot.size) : "None", "screenshot"),
      row("Account", withAccount ? "Yours" : "None", "account"),
    );
  }

  const send = h("button", { type: "submit", class: "ds-button ds-button--white ds-button--lg ds-button--block rb-send", text: "Send" });
  const el = h("form", { class: "rb-form", novalidate: true, "data-rb": withAccount ? "account" : "none" },
    h("div", { class: "ds-field" }, h("label", { class: "ds-label", for: "rb-text" }, "What happened?", count), box),
    shot, file,
    h("h3", { class: "ds-day rb-along", text: "Sent with it" }),
    h("p", { class: "ds-help rb-along-help", text: withAccount
      ? "Only what you write, your screenshot if you add one, and these. Nothing from your trips."
      : "Only what you write, your screenshot if you add one, and these. It's sent without an account." }),
    rows, send, status);

  el.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !context) return;     // a press while one is on its way does nothing more
    if ([...box.value.trim()].length < BUG_LIMITS.textMin) { say("Write what happened first.", "wrong"); box.focus(); return; }
    busy = true;
    send.disabled = true;
    send.textContent = "Sending…";
    say("");
    try {
      const sent = await sendReport({ text: box.value, context, screenshot, withAccount });
      if (sent.ok) {
        box.value = "";
        paintCount();
        screenshot = null;
        drawShot();
        paintRows();
        say("✓ Sent. Thank you: it's read by the person who runs WeGoPlace.", "right");
      } else {
        say(sent.offline ? "It couldn't be sent: this device is offline. Try again when it's back online." : sent.reason ?? "It couldn't be sent. Try again in a moment.", "wrong");
      }
    } finally {
      busy = false;
      send.disabled = false;
      send.textContent = "Send";
    }
  });

  drawShot();
  const ready = reportContext(screenAddress).then((c) => { context = c; paintRows(); });
  return { el, ready, dispose: () => { if (preview) URL.revokeObjectURL(preview); } };
}

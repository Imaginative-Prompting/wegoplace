// What breaks on a page reaches the site's owner: every uncaught error and unhandled rejection, and a sync that keeps
// failing (the store's "wgp:sync-failing" event), cleaned on the device before it leaves (shared/error-clean.js: no
// quoted text, no addresses, no ids, only our own code's frames, the screen by its route's pattern) and sent to this
// site's own POST /api/errors, nowhere else. At most ERROR_LIMITS.perPage a page load, the same error once. It never
// throws, never logs, never waits, never retries: a report that can't be sent (offline) is dropped. Loaded as a module
// right after www.js on each page: modules run once the page is parsed, in order, so it listens before the page's own
// modules (index.html's main one included), but AFTER the classic inline scripts in <head> (the theme, fresh-app's
// old-worker guard): an error in those is not reported. The server cleans each report again, and takes out the names of
// the reporter's trips and the people on them.
//
// Not reported, as noise: "Script error." with no file (another origin's script, an extension: the cleaner drops it), an
// AbortError (a sheet, a map tile or a fetch the app called off on purpose), and a fetch that failed while the device is
// offline (the app expects to be; the store tells its own sync failures, through "wgp:sync-failing").

import { cleanReport, ERROR_LIMITS, groupKey } from "./shared/error-clean.js";
import { keepGroup } from "./shared/bug-rules.js";

const sent = new Set();
// Noise that says nothing about our code: the browser's ResizeObserver note.
const IGNORED = /^ResizeObserver loop/;
// A fetch that failed for want of a network, in each engine's words (Chrome, Safari, Firefox).
const NO_NETWORK = /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/;
const offline = () => { try { return navigator.onLine === false; } catch { return false; } };

// The app's version: the service worker's shell cache is named for it (sw.js: wegoplace-shell-<VERSION>).
let version = "";
try {
  globalThis.caches?.keys().then((keys) => {
    const own = keys.map((k) => /^wegoplace-shell-(v\d{1,6})$/.exec(k)?.[1]).filter(Boolean).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
    if (own[0]) version = own[0];
  }).catch(() => {});
} catch { /* no Cache API: no version */ }

// A shared board's page says which board it is, so the server can take that board's own words out of the report (its
// title, its trip's name, its people's). Sent beside the report, never kept: the report's place is only "/s/:id/".
const BOARD = /^\/s\/([a-f0-9]{32})(\/|$)/i.exec(location.pathname)?.[1]?.toLowerCase() ?? null;

// The kinds of error this device reported, by the fingerprint the site counted each in (its answer): the newest few, kept
// on this device only, so a bug report can say which of the site's errors came before it (js/report-form.js, shown to the
// person before it's sent). Nothing else of an error is kept here.

function send(report) {
  try {
    if (!report || sent.size >= ERROR_LIMITS.perPage) return;
    const key = groupKey({ source: "client", ...report });
    if (sent.has(key)) return;
    sent.add(key);
    const body = JSON.stringify(BOARD ? { ...report, board: BOARD } : report);
    if (body.length > ERROR_LIMITS.body) return;
    fetch("/api/errors", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true, cache: "no-store", credentials: "same-origin" })
      .then((r) => (r.status === 200 ? r.json() : null)).then((answer) => keepGroup(answer?.group)).catch(() => {});
  } catch {
    // A report must never be the next error.
  }
}

function sendError(kind, error, message, file, line, col) {
  try {
    const isError = error instanceof Error;
    // An AbortError whether it's an Error or a DOMException (not an Error in every engine).
    if (error?.name === "AbortError") return;
    const raw = isError ? error.message : message ?? (error === undefined ? "" : String(error));
    if (IGNORED.test(raw ?? "")) return;
    if (error?.name === "TypeError" && NO_NETWORK.test(raw ?? "") && offline()) return;
    send(cleanReport({ kind, name: isError ? error.name : "Error", message: raw, stack: isError ? error.stack : "", file, line, col,
      place: `${location.pathname}${location.hash}`, version }));
  } catch {
    // A report must never be the next error.
  }
}

/** Reports an error the page caught itself, cleaned as an uncaught one is (once a page per kind of message). */
export function reportCaught(error) {
  sendError("error", error, undefined);
}

addEventListener("error", (event) => {
  // Only the page's own errors: a picture or a script that failed to load fires here too, with no message.
  if (event instanceof ErrorEvent) sendError("error", event.error, event.message, event.filename, event.lineno, event.colno);
});
addEventListener("unhandledrejection", (event) => sendError("rejection", event.reason, undefined));
// The store says its changes keep failing to send (js/store.js): the status and the tries, nothing of the changes.
addEventListener("wgp:sync-failing", (event) => {
  try {
    const { status, tries } = event.detail ?? {};
    send(cleanReport({ kind: "sync", status, tries, place: `${location.pathname}${location.hash}`, version }));
  } catch { /* never the next error */ }
});

// Error reports, cleaned: what an error says once everything that could be a trip's or a person's is taken out. Pure, and
// the same on both sides: the page cleans a report before it leaves the device (js/error-report.js), and the Worker cleans
// it again before it's kept (src/errors.js), since a report can come from anything that can send a request.
//
// What survives: the error's name; its message with quoted text, links, addresses, long numbers and tokens replaced; the
// frames of our own code (path, function, line); the screen by its route's pattern (/t/:trip/#/e/:id: never an id); the
// app's version; the browser's name and major version. What never does: anything a trip holds or a person typed, a page's
// real address, an account, an IP.

export const ERROR_LIMITS = Object.freeze({
  message: 300, // characters kept of a cleaned message
  frames: 10,   // frames kept of a stack
  perPage: 10,  // reports one page load sends at most
  body: 8 * 1024, // bytes of a report's JSON
});

const ELLIPSIS = "…";
// Single-quoted words that are code (a property, a method, a module's name), which say where it broke: "reading 'length'".
const CODE_WORD = /^[A-Za-z_$][\w$.\-]{0,40}$/;
// Our own scripts, which a message may name ("Failed to fetch dynamically imported module: …/js/x.js").
const OWN_ASSET = /^\/(?:js|css|vendor|img|icons)\/[\w\-./]{1,160}$/;

// ── where: a page's address as its pattern ────────────────────────────────────────────────────
//
// The app's own pages (the path) and screens (the hash, js/router.js ROUTES), each segment kept only when it's one of
// these words; any other segment is an id and becomes ":id" (":trip" after /t/). A part that's neither is "?".
const PAGE_WORDS = new Set(["t", "trips", "account", "join", "login", "people", "new", "link", "s", "report"]);
const SCREEN_WORDS = new Set(["e", "p", "places", "map", "pack", "memories", "chat", "assistant", "split", "settings", "credits", "changes"]);

function pattern(parts, words, firstId) {
  return parts.map((part, i) => (part === "" ? "" : words.has(part) ? part : i > 0 && parts[i - 1] === "t" ? firstId : ":id"));
}

/** A page's address (path and hash) as its pattern: "/t/k3x9…/#/e/ev-12" -> "/t/:trip/#/e/:id". Never more than that. */
export function placeOf(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return "";
  const [beforeHash, hash = ""] = value.split("#", 2);
  const path = beforeHash.split("?")[0];
  const kept = pattern(path.split("/"), PAGE_WORDS, ":trip").join("/");
  const screen = hash.split("?")[0];
  const shown = screen ? pattern(screen.split("/"), SCREEN_WORDS, ":id").join("/") : "";
  const place = shown ? `${kept}#${shown}` : kept;
  return /^[\w\-/:#]{1,120}$/.test(place) ? place : "?";
}

/** A URL as what it's safe to keep: one of our own scripts' paths, or nothing of it. */
function cleanUrl(text) {
  if (/^data:/i.test(text)) return "[data]";
  try {
    const url = new URL(text);
    if ((url.protocol === "https:" || url.protocol === "http:") && OWN_ASSET.test(url.pathname)) return url.pathname;
  } catch { /* not a URL */ }
  return "[link]";
}

const safeString = (value) => { try { return String(value); } catch { return ""; } };

/** An error message with everything that could be someone's replaced. */
export function cleanMessage(value) {
  let text = typeof value === "string" ? value : value === undefined || value === null ? "" : safeString(value);
  text = text.slice(0, 2000)
    // Links of any scheme, before anything inside them is read as words.
    .replace(/\b(?:https?|wss?|blob|data|file|ftp|chrome-extension|moz-extension|safari-web-extension|webkit-masked-url):[^\s"'`<>)\]]*/gi, (m) => {
      const end = /[.,;:!?]+$/.exec(m)?.[0] ?? "";
      return `${cleanUrl(m.slice(0, m.length - end.length))}${end}`;
    })
    // Addresses.
    .replace(/[^\s@"'`<>()]+@[^\s@"'`<>()]+\.[A-Za-z]{2,}/g, "[email]")
    // Quoted text: what someone typed or a trip holds. "…", “…”, «…», `…` always; '…' unless it's a word of code.
    .replace(/"[^"\n]*"/g, `"${ELLIPSIS}"`)
    .replace(/“[^”\n]*”/g, `“${ELLIPSIS}”`)
    .replace(/«[^»\n]*»/g, `«${ELLIPSIS}»`)
    .replace(/`[^`\n]*`/g, `\`${ELLIPSIS}\``)
    .replace(/(^|[^A-Za-z0-9])'([^'\n]*)'(?![A-Za-z])/g, (m, before, inner) => (CODE_WORD.test(inner) ? m : `${before}'${ELLIPSIS}'`))
    // Tokens, keys and ids: long runs of letters and digits that mix in digits.
    .replace(/[A-Za-z0-9_\-+/=]{20,}/g, (m) => (/\d/.test(m) ? ELLIPSIS : m))
    // Long numbers (a phone number, an amount, an id): 5 digits or more.
    .replace(/\d{5,}/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > ERROR_LIMITS.message ? `${text.slice(0, ERROR_LIMITS.message - 1)}${ELLIPSIS}` : text;
}

/**
 * The same message with the given words taken out wherever they stand, quoted or not (a trip's name, the people on it):
 * each becomes "…". Longest first, so a name inside a longer one goes whole; case aside; words of 3 letters or more.
 */
export function withoutWords(message, words) {
  const list = [...new Set((words ?? []).filter((w) => typeof w === "string").map((w) => w.trim()).filter((w) => w.length >= 3))]
    .sort((a, b) => b.length - a.length);
  let text = message;
  for (const word of list) {
    const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    text = text.replace(re, ELLIPSIS);
  }
  return text;
}

// A frame's place: a URL or a path, then :line:col.
const PLACE = /((?:[a-z][\w+.-]*:\/\/[^\s()]*?)|(?:\/[^\s():]*?)|(?:[\w.-]+\.(?:js|mjs|ts|html)))(?::(\d+))(?::(\d+))?\)?\s*$/i;
const FUNCTION = /^[\w$.<>[\] ]{1,80}$/;

/** One stack line, in V8's form ("at fn (url:1:2)"), JavaScriptCore's and SpiderMonkey's ("fn@url:1:2"), or our cleaned "fn (path:1:2)". */
function readFrame(line) {
  const text = line.trim();
  if (!text) return null;
  const place = PLACE.exec(text);
  if (!place) return null;
  let fn = "";
  if (text.startsWith("at ")) fn = text.slice(3, place.index).replace(/\($/, "").trim().replace(/^async /, "").replace(/ \[as [^\]]*\]$/, "");
  else if (text.includes("@")) fn = text.slice(0, text.indexOf("@"));
  else if (/ \($/.test(text.slice(0, place.index))) fn = text.slice(0, place.index).replace(/\($/, "").trim();
  if (!FUNCTION.test(fn)) fn = "";
  // A web address keeps its path (never its host or query); any other only its file's name.
  let full = place[1];
  if (/^[a-z][\w+.-]*:\/\//i.test(full)) {
    try { const url = new URL(full); full = url.protocol === "http:" || url.protocol === "https:" ? url.pathname : url.pathname.split("/").pop() || "?"; } catch { full = "?"; }
  } else full = full.replace(/[?#].*$/, "");
  return { fn, full, line: Number(place[2]), col: place[3] === undefined ? null : Number(place[3]) };
}

/** Our own code's frames: a script under /js/ as it is, or one of the app's pages (an inline script) by its pattern. */
export const appOwn = (full) => /^\/js\/[\w\-./]+\.m?js$/.test(full) || PAGE_WORDS.has(full.split("/")[1] ?? "") || full === "/";
export const workerOwn = (full) => !full.includes("node_modules") && full !== "?";

const framePath = (full) => (/^\/js\//.test(full) ? full : full.startsWith("/") ? placeOf(full) : full);
const frameText = (f) => `${f.fn || "?"} (${framePath(f.full)}:${f.line}${f.col === null ? "" : `:${f.col}`})`;

/** A stack's frames of our own code, as "fn (path:line:col)" lines. */
export function cleanStack(stack, own) {
  if (typeof stack !== "string") return [];
  const frames = [];
  for (const line of stack.slice(0, 16_000).split("\n")) {
    const frame = readFrame(line);
    if (frame && own(frame.full)) frames.push(frame);
    if (frames.length >= ERROR_LIMITS.frames) break;
  }
  return frames.map(frameText);
}

/** The browser's name and major version, and the system, from a user agent: "Safari 26 · iOS". Nothing finer. */
export function coarseBrowser(ua) {
  if (typeof ua !== "string" || !ua) return "unknown";
  const major = (re) => re.exec(ua)?.[1] ?? "";
  let name = "other", version = "";
  if (/Edg(?:A|iOS)?\//.test(ua)) [name, version] = ["Edge", major(/Edg(?:A|iOS)?\/(\d+)/)];
  else if (/OPR\//.test(ua)) [name, version] = ["Opera", major(/OPR\/(\d+)/)];
  else if (/SamsungBrowser\//.test(ua)) [name, version] = ["Samsung Internet", major(/SamsungBrowser\/(\d+)/)];
  else if (/Firefox\/|FxiOS\//.test(ua)) [name, version] = ["Firefox", major(/(?:Firefox|FxiOS)\/(\d+)/)];
  else if (/CriOS\//.test(ua)) [name, version] = ["Chrome", major(/CriOS\/(\d+)/)];
  else if (/Chrome\//.test(ua)) [name, version] = ["Chrome", major(/Chrome\/(\d+)/)];
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) [name, version] = ["Safari", major(/Version\/(\d+)/)];
  const system = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /CrOS/.test(ua) ? "ChromeOS"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "other";
  return `${name}${version ? ` ${version}` : ""} · ${system}`;
}

/**
 * A sync that keeps failing: a fixed sentence, the status the server last answered (a number, or 0: no answer) and how
 * many tries in a row. Nothing of what was being sent.
 */
export const SYNC = Object.freeze({ name: "SyncFailing", statuses: [0, 401, 408, 429, 500, 502, 503, 504] });
const syncMessage = (status, tries) => `Changes kept failing to send: ${tries} tries in a row, the last answered ${status || "nothing"}.`;

const KINDS = new Set(["error", "rejection", "sync"]);
const cleanVersion = (value) => (typeof value === "string" && /^v?\d{1,6}$/.test(value) ? value : "");

/**
 * A report from the page as it's kept, or null for one not worth keeping: nothing to say, the browser's "Script error."
 * (another site's script hides its error), or an error only in code that isn't ours (a browser extension's).
 *   input: { kind, name, message, stack, file, line, col, place, version } (js/error-report.js), or anything at all.
 * A "sync" report is SYNC's: its status and tries in fixed words, its screen and version; nothing else of it is read.
 */
export function cleanReport(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const kind = KINDS.has(input.kind) ? input.kind : "error";
  if (kind === "sync") {
    const status = SYNC.statuses.includes(input.status) ? input.status : 500;
    const tries = Number.isInteger(input.tries) && input.tries > 0 ? Math.min(input.tries, 99) : 1;
    return { kind, name: SYNC.name, message: syncMessage(status, tries), stack: "", place: placeOf(input.place), version: cleanVersion(input.version) };
  }
  const name = typeof input.name === "string" && /^[A-Za-z][\w$]{0,39}$/.test(input.name) ? input.name : "Error";
  const message = cleanMessage(input.message);
  let stack = cleanStack(input.stack, appOwn);
  const file = typeof input.file === "string" ? input.file : "";
  if (!stack.length && file) {
    const frame = readFrame(`${file}:${Number(input.line) || 0}:${Number(input.col) || 0}`);
    if (frame && appOwn(frame.full)) stack = [frameText(frame)];
    else return null; // thrown in someone else's script
  }
  if (!stack.length && (kind === "error" || (typeof input.stack === "string" && input.stack.trim()))) return null;
  if (!message && !stack.length) return null;
  return { kind, name, message, stack: stack.join("\n"), place: placeOf(input.place), version: cleanVersion(input.version) };
}

/** What two reports share when they're the same error: digits made alike, the first frame without its line. */
export function groupKey({ source, kind, name, message, stack, place }) {
  const first = (stack ?? "").split("\n")[0].replace(/:\d+(?::\d+)?\)$/, ")");
  return [source, kind, name, (message ?? "").replace(/\d+/g, "0"), first, first ? "" : place].join("|");
}

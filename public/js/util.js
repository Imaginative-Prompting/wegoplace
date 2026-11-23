// Pure helpers shared by every view. No DOM, no state, no imports — this module is the
// one thing that can be reasoned about in isolation, so keep it that way.
//
// The time functions exist because of one specific bug: a departure is 23:15 in
// America/New_York, and a device-local render an hour west shows 22:15. Miss-your-plane wrong.
// So every formatter here takes an explicit IANA zone and there is no zone-less variant to
// reach for by accident.

// ── epoch normalisation ────────────────────────────────────────────────────────────────
// Two units live in the data on purpose: starts_at/ends_at are epoch SECONDS (that is what
// the seed and D1 carry), while created_at/updated_at written by store.js are epoch
// MILLISECONDS (last-write-wins needs sub-second resolution). Rather than make every caller
// remember which is which, sniff it: 1e11 as ms is 1973, as seconds it is the year 5138.
// No timestamp this app will ever hold is near that line.
const MS_CUTOFF = 1e11;
export function toMs(epoch) {
  const n = Number(epoch);
  if (!Number.isFinite(n)) return NaN;
  return Math.abs(n) < MS_CUTOFF ? n * 1000 : n;
}
export function toSec(epoch) {
  const n = Number(epoch);
  if (!Number.isFinite(n)) return NaN;
  return Math.abs(n) < MS_CUTOFF ? Math.round(n) : Math.round(n / 1000);
}

// ── formatter cache ────────────────────────────────────────────────────────────────────
// Constructing an Intl.DateTimeFormat costs roughly two orders of magnitude more than using
// one. The agenda re-formats every event on every store "change", so a per-call constructor
// is a visible stutter on a phone. Keyed by shape+zone; at most a dozen ever exist.
const FMT = new Map();
function fmt(shape, tz, opts) {
  const k = shape + "\u0000" + tz;
  let f = FMT.get(k);
  if (!f) {
    // A bad tz string throws from the constructor; fall back to UTC rather than letting one
    // malformed row take down the whole render.
    try { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }); }
    catch { f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }); }
    FMT.set(k, f);
  }
  return f;
}
function parts(f, ms) {
  const out = Object.create(null);
  for (const p of f.formatToParts(ms)) out[p.type] = p.value;
  return out;
}

// "23:15". hourCycle:"h23" rather than hour12:false — the latter renders midnight as "24:00"
// on some older WebKit builds, which is exactly the kind of thing you only find out at 00:30
// in an airport.
export function fmtTime(epoch, tz) {
  const ms = toMs(epoch);
  if (!Number.isFinite(ms)) return "";
  return fmt("t", tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
}

// "Tue Jun 1". Assembled from parts because en-US formats this as "Tue, Jun 1" and the
// comma is noise in a dense agenda list.
export function fmtDay(epoch, tz) {
  const ms = toMs(epoch);
  if (!Number.isFinite(ms)) return "";
  const p = parts(fmt("d", tz, { weekday: "short", month: "short", day: "numeric" }), ms);
  return `${p.weekday} ${p.month} ${p.day}`;
}

// "EDT". Render only when event.tz !== trip.default_tz — a zone label on every row is visual
// noise. Note America/Lima has no common abbreviation, so this yields "GMT-5" there; that is
// correct and readable, and it is the away-zone case that actually needs the label anyway.
export function tzLabel(epoch, tz) {
  const ms = toMs(epoch);
  if (!Number.isFinite(ms)) return "";
  return parts(fmt("z", tz, { timeZoneName: "short" }), ms).timeZoneName || "";
}

// A zone as a small chip beside a time: "EDT", "GMT", "GMT+1", "GMT-5", "GMT+5:45". Letters
// where the zone has them, and where it has none, GMT and the hours. Never a bare "+00" or
// "-05": beside a weekday ("06:05 +00 Wed") that reads as a count of days. An engine that
// answers with the bare offset, or with "UTC+2", is written the same way as the rest.
export function tzChip(epoch, tz) {
  const raw = tzLabel(epoch, tz);
  const m = /^(?:GMT|UTC)?([+\-\u2212])(\d{1,2})(?::?(\d{2}))?$/.exec(raw);
  if (!m) return raw;
  const mins = m[3] && m[3] !== "00" ? `:${m[3]}` : "";
  if (+m[2] === 0 && !mins) return "GMT";
  return `GMT${m[1] === "+" ? "+" : "-"}${+m[2]}${mins}`;
}

// "2027-06-01" — the agenda's grouping key, in the EVENT's zone.
// Not toISOString().slice(0,10): that is UTC, and it files a 23:15 EDT departure under
// the next day, splitting the first day of the trip in half.
export function dayKey(epoch, tz) {
  const ms = toMs(epoch);
  if (!Number.isFinite(ms)) return "";
  const p = parts(fmt("k", tz, { year: "numeric", month: "2-digit", day: "2-digit" }), ms);
  return `${p.year}-${p.month}-${p.day}`;
}

// ── geometry ───────────────────────────────────────────────────────────────────────────
// These two are the map's graceful degradation. On a mountain trail there are no tiles, no
// Google Maps, and no data — but the browser's GPS still works with the radio off, so
// "The old bridge, 4.2 km, NE" is a real answer computed entirely on-device.

const R_EARTH = 6371008.8;              // IUGG mean radius, metres
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// Great-circle distance in METRES between {lat,lng} points.
export function haversine(a, b) {
  if (!a || !b) return NaN;
  const la1 = rad(+a.lat), la2 = rad(+b.lat);
  const dLa = la2 - la1;
  const dLo = rad(+b.lng - +a.lng);
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

const POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

// Initial great-circle bearing from a to b, as a 16-point compass string ("NE", "NNW").
// 16 points not 8: a 45-degree bucket is useless when you are choosing between two trail
// forks, and every phone compass app uses the same vocabulary so nobody has to translate.
export function bearing(a, b) {
  if (!a || !b) return "";
  const la1 = rad(+a.lat), la2 = rad(+b.lat), dLo = rad(+b.lng - +a.lng);
  const y = Math.sin(dLo) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLo);
  const brg = (deg(Math.atan2(y, x)) + 360) % 360;
  return POINTS[Math.round(brg / 22.5) % 16];
}

// Degrees, for rotating an arrow glyph. Same maths as bearing(), kept separate so the string
// version stays the obvious default.
export function bearingDeg(a, b) {
  if (!a || !b) return NaN;
  const la1 = rad(+a.lat), la2 = rad(+b.lat), dLo = rad(+b.lng - +a.lng);
  const y = Math.sin(dLo) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLo);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// ── kilometers or miles (model §3) ───────────────────────────────────────────────────────────
// The account's own choice (GET /api/me `units`: "metric" | "imperial", null until it picks;
// store.js hands it over with setUnits), else the phone's language: a phone set to US or
// Liberian English, or to Burmese, reads miles. Every distance the app draws goes through
// fmtDistance and the map's scale through distanceUnits(), so one setting moves them all; times
// on foot are minutes either way.
let UNITS = null;
export function setUnits(u) { UNITS = u === "metric" || u === "imperial" ? u : null; }
/** What the phone's language reads: "imperial" for en-US, en-LR and my (Burmese), else "metric". */
export function localeUnits(lang = (globalThis.navigator && ((navigator.languages && navigator.languages[0]) || navigator.language)) || "") {
  const [base = "", region = ""] = String(lang).split(/[-_]/);
  return region.toUpperCase() === "US" || region.toUpperCase() === "LR" || base.toLowerCase() === "my" ? "imperial" : "metric";
}
/** The units distances are drawn in now: the account's choice, else the phone's language. */
export const distanceUnits = () => UNITS || localeUnits();

const FEET_PER_METRE = 3.28084;
const METRES_PER_MILE = 1609.344;

// "180 m" / "1.2 km" / "14 km". Metres below 1000, one decimal to 10 km, whole km above —
// a tenth of a kilometre is below the noise floor of a phone GPS at that range anyway.
// Miles the same way: "600 ft" below 1,000 ft, then "0.2 mi", one decimal to 10 mi, whole above.
export function fmtDistance(metres) {
  if (!Number.isFinite(metres)) return "";
  // Decided on the ROUNDED figure, so 997 ft is "0.2 mi" and not "1000 ft", and 9.97 is "10", not "10.0".
  if (distanceUnits() === "imperial") {
    const feet = Math.round((metres * FEET_PER_METRE) / 10) * 10;
    if (feet < 1000) return `${feet} ft`;
    const mi = metres / METRES_PER_MILE;
    return Math.round(mi * 10) < 100 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
  }
  if (metres < 950) return `${Math.round(metres / 10) * 10} m`;
  const km = metres / 1000;
  return Math.round(km * 10) < 100 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

// "12 min" / "1 h 40" — for walk_minutes and event durations.
export function fmtMinutes(min) {
  const m = Math.round(Number(min));
  if (!Number.isFinite(m) || m <= 0) return "";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${String(r).padStart(2, "0")}` : `${h} h`;
}

// A stretch of time, from milliseconds: "45m" / "4h" / "4h 25m" / "1d 6h". Compact on purpose:
// on the Agenda it sits on a rail beside a card, and every character it spends is width the
// title does not get. ONE function for every screen that says how long a gap is (the Agenda's
// cards and a gap's page, and the head of Places when it is opened from a gap), so the same
// gap never reads "9h 10m" on one screen and "550 min" on the next.
export function fmtSpan(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) {
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}

// "just now" / "6 min ago" / "3 days ago". The header uses this for last-sync, which is the
// number that matters after four days without signal.
export function fmtAgo(epoch, now = Date.now()) {
  const ms = toMs(epoch);
  if (!Number.isFinite(ms)) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

// ── the ink that goes on a person's own color ───────────────────────────────────────────
// Computed rather than tabulated. The palette is fixed in functions/api/trip.js and no view
// may hold a second copy of it — but the four hues span a 4x range of luminance (#0072B2 is
// dark, #56B4E9 and #E69F00 are light), so ONE ink cannot sit on all of them: white on the
// amber measures 2.1:1. Deriving the choice from the actual hex means a fifth colour added
// upstream is still legible on the day it ships, with no edit anywhere.
//
// It lives HERE, not in agenda.js where it was written, because a person can now choose their
// own colour and the swatch in Settings has to draw its tick in exactly the same ink the
// sticky will wear. Two implementations of "what is readable on this hue" is how a picker
// starts promising something the thing it is picking for does not deliver.
// scripts/theme_contrast.js re-measures every palette hue against the answer this returns.
export function inkOn(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || "").trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // Contrast against near-black vs against white; take whichever is further away.
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? "#101010" : "#ffffff";
}

// ── text ───────────────────────────────────────────────────────────────────────────────
// Every view builds markup with template strings, and event notes are free text typed by
// four people. One unescaped `<` in a note breaks the agenda for the rest of the trip.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
}

// A place's local name, where it adds something: "" when there is none or when it is the name
// again (in capitals, with other spacing or without its accents), which would be the same line
// twice. The ONE place that decides it: a plan's page, a place's page and anything else that
// draws a local name ask here.
export function localNameOf(place) {
  const words = (v) => String(v == null ? "" : v).normalize("NFD").replace(/\p{M}+/gu, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const local = place && place.name_local ? String(place.name_local).replace(/\s+/g, " ").trim() : "";
  return local && words(local) !== words(place.name) ? local : "";
}

// Collapse whitespace and hard-truncate at a word boundary, for one-line list rows.
export function clip(s, n = 90) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

// Stable ids generated on the client so an item created in a tent has its final id
// immediately: it can be edited and deleted offline, and re-sending a queued create is an
// idempotent upsert instead of a duplicate row. crypto.randomUUID needs a secure context,
// which a PWA always is, but the fallback keeps file:// debugging alive.
//
// The prefix is joined with a hyphen: an id is lowercase letters, digits and hyphens, which is
// what the server takes for a new row. Rows made before 13 Nov 2026 keep their "pu_…" ids.
export function uid(prefix = "") {
  const u = (crypto.randomUUID && crypto.randomUUID()) ||
    ([...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, "0")).join(""));
  return prefix ? `${prefix}-${u}` : u;
}

// ── position: ONE read, cached ─────────────────────────────────────────────────────────
// Deliberately one cached read — this is a battery decision, not a code-style one:
// a single read, cached, NOT watchPosition. Four of these eleven days have no signal and no
// charger, and `watchPosition` keeps the GPS chip awake for as long as the page is open —
// which, in an installed PWA that nobody ever closes, is all day.
//
// Three layers of cache, cheapest first:
//   1. `last`      — this session. A synchronous read for renderers that cannot await.
//   2. localStorage— survives a relaunch, so the agenda has a distance on the FIRST frame
//                    after the app is reopened in a tent rather than after a 20s GPS fix.
//   3. maximumAge  — handed to the platform, which lets CoreLocation return a fix it already
//                    has without powering the radio at all. This is the layer that actually
//                    saves the battery; the other two just save the wait.
//
// It never rejects. Every caller is "show the distance if we can", and a rejecting promise
// would need a try/catch at every call site whose only branch is the one null already gives.

const POS_KEY = "wgp.pos";
// A refusal, kept on this phone (the app never asks again by itself once the person said no; only
// "Update my location" in More, a person's own ask, clears it). Cleared on sign-out with the rest (forget.js), when the
// browser's own "denied" for the site still says it.
const REFUSED_KEY = "wgp.pos.refused";
let last = null;        // { lat, lng, accuracy, at }  at = epoch ms
let inflight = null;    // dedupes concurrent callers into one platform read
let denied = (() => { try { return localStorage.getItem(REFUSED_KEY) === "1"; } catch { return false; } })();
function refuse() { denied = true; try { localStorage.setItem(REFUSED_KEY, "1"); } catch {} }
/** The map's own watch heard "no" (PERMISSION_DENIED): kept here too, so every screen stops offering to ask. */
export function notePositionRefused() { refuse(); }

function loadStoredPosition() {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return Number.isFinite(p?.lat) && Number.isFinite(p?.lng) && Number.isFinite(p?.at) ? p : null;
  } catch { return null; }
}
last = loadStoredPosition();

/** The last fix we hold, or null. Synchronous, never prompts, never touches the radio. */
export function lastPosition() { return last; }

/** True if the browser told us the user said no. Settings uses this to explain the blank. */
export function positionDenied() { return denied; }

/** Forget the cached fix — "Update my location" in Settings, and the test hook. */
export function clearPosition() {
  last = null;
  denied = false;
  try { localStorage.removeItem(POS_KEY); localStorage.removeItem(REFUSED_KEY); } catch {}
}

/** What the browser says of this site's location permission: "granted", "denied", "prompt", or "unknown" where it
 *  can't say (no Permissions API, or one that refuses the name, as older Safari did). Never prompts. */
export async function positionPermission() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return "unknown";
    const st = await navigator.permissions.query({ name: "geolocation" });
    return st && ["granted", "denied", "prompt"].includes(st.state) ? st.state : "unknown";
  } catch { return "unknown"; }
}

/**
 * getPosition({ maxAgeMs, timeoutMs, force }) -> Promise<{lat,lng,accuracy,at} | null>
 *
 * maxAgeMs  how old a fix may be and still count as the answer. Default 5 min, which is
 *           roughly how long it takes to walk far enough for a straight-line distance in
 *           a city to change in a way anyone would notice.
 * timeoutMs how long to wait for the platform. Default 12s: a cold high-accuracy fix at
 *           altitude with no assistance data genuinely takes that long.
 * force     skip the caches and take a new reading.
 * quiet     a screen opening, not a person asking (the app never raises the location question by
 *           itself): it reads only when the browser says permission is already granted, and otherwise answers the fix
 *           it keeps, or null, without touching the radio. A browser that says "denied" is kept as a refusal.
 */
export function getPosition({ maxAgeMs = 300000, timeoutMs = 12000, force = false, quiet = false } = {}) {
  if (quiet && !force) {
    if (denied) return Promise.resolve(last);
    return positionPermission().then((state) => {
      if (state === "denied") refuse();
      return state === "granted" ? getPosition({ maxAgeMs, timeoutMs }) : last;
    });
  }
  // Strictly less-than, so maxAgeMs:0 means "never reuse a cached fix" rather than "reuse one
  // taken in this exact millisecond" — which is what it accidentally meant with <=, and which
  // made {maxAgeMs:0} silently a no-op whenever a fix had just been taken.
  const fresh = last && Date.now() - last.at < maxAgeMs;
  if (fresh && !force) return Promise.resolve(last);
  if (denied && !force) return Promise.resolve(last);       // stale-but-real beats nothing
  if (!navigator.geolocation) return Promise.resolve(last);
  if (inflight) return inflight;

  // NOTE the `.finally` rather than clearing `inflight` inside the executor. A geolocation
  // implementation that answers SYNCHRONOUSLY — a polyfill, a test double, or a platform
  // serving a cached fix — runs the callback before this assignment completes, so an
  // in-executor `inflight = null` is immediately overwritten by the assignment and the
  // module is wedged on a resolved promise for the rest of the session: every later call,
  // including force:true, silently returns the first fix and never touches the radio again.
  // Caught by a test double doing exactly that; the real API is async and hides it.
  const run = new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    navigator.geolocation.getCurrentPosition(
      (p) => {
        last = {
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
          at: p.timestamp || Date.now(),
        };
        denied = false;
        try { localStorage.setItem(POS_KEY, JSON.stringify(last)); } catch {}
        done(last);
      },
      (err) => {
        // 1 = PERMISSION_DENIED. 2/3 are "not right now" (no fix indoors, timed out) and
        // must NOT become sticky, or stepping outside would never start working.
        if (err && err.code === 1) refuse();
        done(last);
      },
      {
        // High accuracy on purpose. The low-accuracy path is a wifi/cell lookup, and on the
        // trail there is neither — it would simply time out. maximumAge lets the
        // platform answer from its own cache first, which is the read that costs nothing.
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: force ? 0 : maxAgeMs,
      },
    );
  });
  inflight = run.finally(() => { inflight = null; });
  return inflight;
}

/** A control turned off says why, in words (a disabled control is exempt from the contrast floor, never from saying why):
 *  off with its reason as an aria-description and a title, or on again without one. `why` empty or null turns it on. */
export function setDisabled(el, why) {
  el.disabled = !!why;
  if (why) { el.setAttribute("aria-description", why); el.setAttribute("title", why); }
  else { el.removeAttribute("aria-description"); el.removeAttribute("title"); }
}

/** A NAME SHRINKS TO FIT BEFORE IT WRAPS (21 Nov: a long name was cut with "…" where the whole of it matters). On one
 *  line, its size stepped down by half a pixel until it fits, no smaller than `floor` (14 px: still read at arm's
 *  length); only a name that can't fit even then wraps, as its own rules say (a list's title: two lines). Fitted again
 *  whenever its row's width changes. Returns the size it settled on. */
const fitting = new WeakMap();
export function fitName(el, floor = 14) {
  if (!el || !el.isConnected) return 0;
  el.style.fontSize = ""; el.style.whiteSpace = "nowrap";
  let size = parseFloat(getComputedStyle(el).fontSize) || 16;
  while (el.scrollWidth > el.clientWidth + 0.5 && size > floor) { size = Math.max(floor, size - 0.5); el.style.fontSize = `${size}px`; }
  if (el.scrollWidth > el.clientWidth + 0.5) el.style.whiteSpace = "";     // still too long at the floor: it wraps
  if (!fitting.has(el) && typeof ResizeObserver === "function" && el.parentElement) {
    let w = el.parentElement.clientWidth;
    const ro = new ResizeObserver(() => { const now = el.parentElement ? el.parentElement.clientWidth : 0; if (Math.abs(now - w) < 1) return; w = now; fitName(el, floor); });
    ro.observe(el.parentElement);
    fitting.set(el, ro);
  }
  return size;
}

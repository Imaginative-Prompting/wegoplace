// More + Image credits. Both faces live here; ctx.route says which.
//
// More is where everything not on the bar lives: the trip's name and dates, you, the sections not on the bar, the
// trip's people and settings, AI apps, your trips, Appearance, and what the app is doing on this
// phone (its connection, location, version), with Report a bug. It is opened from your picture.
//
// The Image credits page is NOT a nicety. Photo credits are kept off cards, agenda
// rows and place pages, making this page the single place the
// CC BY / CC BY-SA attribution obligation is met. 46 photographs are re-hosted on our own
// origin; re-hosting does not dissolve the licence. If this page stops rendering the app is
// in breach. It lists every photograph the trip shows, from the pictures themselves (each carries
// its license, credit and source: shared/photo.js); a row still on the old columns is credited
// from public/img/CREDITS.json, and the page says so loudly when that is needed and can't load.

import { fmtDay, dayKey, fmtAgo, fmtDistance, esc, getPosition, lastPosition, positionDenied, fitName }
  from "./util.js";
import { ms, reducedMotion } from "./motion.js";
import { coverOf, creditOf, pictureOf, placePhoto } from "./shared/photo.js";
// The section registry. This file enumerates no sections of its own — see tabs.js.
import { quickLinks } from "./tabs.js";
// Your face on your account's row: the system's, with the picture you drew once it is here.
import { faceHtml } from "../ds/avatar.js";
import { pictureInto } from "./pictures.js";
import { myPackCount } from "./pack-count.js";
import { reportForm } from "./report-form.js";
import { openSheet } from "./sheet.js";

// ── theme ──────────────────────────────────────────────────────────────────────────────
// Three states, matching the three-state CSS: system (no attribute), light, dark. An
// explicit choice has to override a wrong OS setting in BOTH directions — the phone is on
// auto-dark and the tent is dark at 4pm, or the phone is in night mode on a glaring pass.
//
// Exported because index.html has to apply the stored choice and keep <meta name=theme-color>
// honest at boot, and there must be exactly one place that knows what "system" means.

const THEME_KEY = "wgp.theme";

// The catalogue lives in index.html's boot script, which has to know it before first paint and
// cannot import this module (a route module missing from the precache would take the whole
// shell down with it). So the shell publishes the table and this reads it: one list, no mirror.
// The fallback keeps this screen usable if the shell is ever loaded without it.
export const themeTable = () => (typeof window !== "undefined" && window.WGP_THEMES) || {
  light: { name: "Light", lm: "light", bar: "#fdfdfc" },
  void: { name: "Dark", lm: "dark", bar: "#000000" },
};
export const THEME_MODES = () => ["system", ...Object.keys(themeTable())];

export function readTheme() {
  const t = document.documentElement.getAttribute("data-theme");
  return themeTable()[t] ? t : "system";
}

/** What the user is actually looking at right now — "system" resolved against the OS. */
export function resolvedTheme() {
  const t = readTheme();
  if (t !== "system") return t;
  // A dark phone with nothing chosen is Void (styles.css's system block, the shell's paint()).
  return matchMedia("(prefers-color-scheme: dark)").matches ? "void" : "light";
}

/** The accent family a theme belongs to — "light" or "dark". */
export function themeLum(id) {
  const e = themeTable()[id];
  return e ? e.lm : "light";
}

/** "light" or "dark" for whatever is on screen right now, whichever named theme that is.
 *  Anything choosing between two artefacts — a basemap flavour, a raster, a canvas palette —
 *  wants THIS and not resolvedTheme(): there are many themes and only two of most things. */
export function resolvedLum() {
  return themeLum(resolvedTheme());
}

// Accent/theme change from Settings: 200ms colour crossfade on the token
// transition. Colour is not on the transforms+opacity whitelist that governs the rest of the
// app, and this deliberate exception is kept isolated — so it is
// fenced in hard: the stamp on <html> lives for exactly one --dur (the vocabulary has no
// 200ms token; 220ms is the nearest and the same number every other deliberate change uses),
// it is only ever set by the two handlers below (never at boot, where index.html applies the
// stored theme before first paint and must not fade anything in), and prefers-reduced-motion
// removes it entirely — the global reduce block would zero the duration anyway.
let fadeTimer = 0;
function crossfadeTokens() {
  const root = document.documentElement;
  if (reducedMotion()) { root.removeAttribute("data-tokenfade"); return; }
  root.setAttribute("data-tokenfade", "1");
  clearTimeout(fadeTimer);
  // +40ms of slack so the attribute outlives the transition it started rather than cutting
  // its last frame; a second tap inside the window restarts the timer instead of stacking.
  fadeTimer = setTimeout(() => root.removeAttribute("data-tokenfade"), ms("--dur", 220) + 40);
}

export function applyTheme(mode) {
  const m = THEME_MODES().includes(mode) ? mode : "system";
  crossfadeTokens();
  if (m === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", m);
  try { localStorage.setItem(THEME_KEY, m); } catch { /* Safari private mode */ }
  // The shell owns data-lum and the status-bar colour, and it derives both from the same table
  // it used at boot — so a theme change here goes through exactly the path a cold start does.
  if (typeof window !== "undefined" && typeof window.WGP_PAINT === "function") window.WGP_PAINT();
  else paintThemeColor();
  return m;
}

// One meta, rewritten, rather than two media-scoped ones. Media-scoped metas cannot express
// "the user forced dark on a light phone", which is exactly the case the in-app control
// exists for; with them the status bar stays paper-white behind a black screen.
//
// The colour is READ BACK from --ground rather than kept in a table here. getComputedStyle
// forces a style recalc, so immediately after the data-theme flip it already reports the new
// value — which means the token stays the single source of truth and a future change to
// --ground cannot leave the iOS status bar a shade off with nothing to point at. The boot
// script in index.html carries the only literals, because it has to run before CSS applies.
function paintThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const ground = getComputedStyle(document.documentElement).getPropertyValue("--ground").trim();
  if (ground) meta.setAttribute("content", ground);
}

// ── glyphs ─────────────────────────────────────────────────────────────────────────────
// Local to this screen. The three theme glyphs are the ones the old app bar used.
const ICO = {
  system: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none"/>',
  light: '<circle cx="12" cy="12" r="4.6"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"/>',
  dark: '<path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z"/>',
  // Connectivity. Three states, three DIFFERENT SHAPES — a hue-only indicator
  // would leave synced and offline 1.15:1 apart under
  // deuteranopia, i.e. the same colour. Tick / circling arrows / struck-through cloud.
  synced: '<circle cx="12" cy="12" r="8.6"/><path d="m8 12.2 2.8 2.8L16.2 9.6"/>',
  queued: '<path d="M20.4 12a8.4 8.4 0 0 1-14.6 5.7M3.6 12a8.4 8.4 0 0 1 14.6-5.7"/><path d="M3.4 17.8v-4h4M20.6 6.2v4h-4"/>',
  offline: '<path d="M6.8 19.4h10.4a4.6 4.6 0 0 0 .7-9.1 6.4 6.4 0 0 0-10.3-3.6"/><path d="M6.8 19.4a4.2 4.2 0 0 1-.4-8.4"/><path d="M3.2 3.2 20.8 20.8"/>',
  locate: '<circle cx="12" cy="12" r="3.4"/><circle cx="12" cy="12" r="7.6"/><path d="M12 1.6v3.2M12 19.2v3.2M1.6 12h3.2M19.2 12h3.2"/>',
  credits: '<rect x="2.8" y="4.6" width="18.4" height="14.8" rx="2.2"/><circle cx="8.4" cy="10" r="1.8"/><path d="M2.8 16.4 8.6 11l4.4 4.1 3.2-2.6 4.8 4.1"/>',
  // Split's mark: a torn receipt — a rectangle with a zig-zag bottom edge and two lines of
  // type in it. No other glyph in this app is a rectangle with a serrated
  // edge, because no two icons may differ by hue alone, and
  // this one sits in a column with a photo frame and a location target.
  // THE PATH IS THE SAME PATH split.js DRAWS (its SVG_RECEIPT). Copied rather than imported
  // because one route module importing a UI helper from another is a dependency neither of
  // them wants, and because importing a 118 KB view module to draw one 22px glyph would load
  // the whole Split screen every time anybody opened Settings. If either copy is ever redrawn, redraw both: a quick link that
  // does not look like the screen it opens is a quick link nobody trusts.
  // scripts/split_wiring_check.mjs compares these two strings on every run.
  receipt: '<path d="M5.5 3.5h13v15.2l-2.2-1.6-2.15 1.6-2.15-1.6-2.15 1.6-2.2-1.6z"/><path d="M9 8h6M9 11.5h6"/>',
  chevron: '<path d="m9 5.5 7 6.5-7 6.5"/>',
  tick: '<path d="m5.5 12.4 4.2 4.2 8.8-9.2"/>',
  external: '<path d="M13.6 4.4H19.6V10.4"/><path d="M19.6 4.4 11.4 12.6"/><path d="M18.2 14v4.4a1.8 1.8 0 0 1-1.8 1.8H5.6a1.8 1.8 0 0 1-1.8-1.8V7.6a1.8 1.8 0 0 1 1.8-1.8H10"/>',
};
const svg = (id, cls = "") => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICO[id]}</svg>`;

// Appearance is three choices: what the phone says (System), Light, Dark. Dark is Void, a dark phone's default; the
// app's other themes are no longer offered (a phone that kept Night or Slate reads as Dark, Linen as Light: index.html's
// boot script, which the shell runs before first paint).
const APPEARANCE = [["system", "System"], ["light", "Light"], ["void", "Dark"]];

// ── mount ──────────────────────────────────────────────────────────────────────────────

export default async function mount(el, ctx) {
  return ctx.route === "credits" ? mountCredits(el, ctx) : mountSettings(el, ctx);
}

// ── settings ───────────────────────────────────────────────────────────────────────────


function mountSettings(el, ctx) {
  const { store } = ctx;

  const go = svg("chevron", "st-go");

  // MORE, on the design system (the shell's mock-up, chat-more-mock.html): the trip; you; a plain list of where to go,
  // each saying what it holds at its right; Appearance; and what this app is doing on this phone. The rows not on the
  // bar come from tabs.js's sections (quickLinks), so a section added there is a row here with no edit to this file.
  // Handles other code and the checks read are kept: #st-trip, #st-sections, .st-title, [data-mode].
  const rowsFor = quickLinks().map((sec) => row({ href: sec.href, icon: MORE_ICO[sec.id] || "", title: sec.label, note: `<span data-note="${esc(sec.id)}"></span>` })).join("");
  el.innerHTML = `
    <div class="ds st-more">
      <div class="ds-head"><h1 class="st-title">More</h1><div class="ds-head-end"></div></div>
      <div class="st-tripsum" id="st-trip"></div>
      <a class="ds-item st-you" href="/account" data-st-you>
        <span class="ds-item-lead" data-st-face></span>
        <span class="ds-item-main"><span class="ds-item-title" data-st-name></span><span class="ds-item-sub">Your account and your picture</span></span>
        <span class="ds-item-trail">${go}</span>
      </a>
      <!-- Two groups, each a plain question (21 Nov, "clean up the settings a bit"): this trip, and you. -->
      <nav id="st-sections" aria-label="More">
        <h2 class="ds-day st-label">This trip</h2>
        <div class="st-list">
          ${rowsFor}
          ${row({ href: `/trips/${encodeURIComponent(store.tripId())}`, icon: MORE_ICO.people, title: "People and settings", note: '<span data-note="people"></span>' })}
        </div>
        <h2 class="ds-day st-label">You</h2>
        <div class="st-list">
          ${(store.me && store.me() && store.me().guest)
            ? row({ href: "/account#ai-apps", icon: MORE_ICO.apps, title: "AI apps", note: '<span data-note="apps"></span>' })
            : row({ button: "st-apps", icon: MORE_ICO.apps, title: "AI apps", note: '<span data-note="apps"></span>' })}
          ${row({ href: "/trips", icon: MORE_ICO.trips, title: "Your trips", note: '<span data-note="trips"></span>' })}
        </div>
      </nav>

      <h2 class="ds-day st-label">Appearance</h2>
      <div class="ds-segmented st-look" id="st-theme" role="radiogroup" aria-label="Appearance">
        ${APPEARANCE.map(([mode, name]) => `<button type="button" class="ds-segment" role="radio" data-mode="${mode}" aria-checked="false">${name}</button>`).join("")}
      </div>

      <h2 class="ds-day st-label">This app</h2>
      <div class="st-list">
        ${row({ button: "st-net", icon: "", title: "Connection", note: '<span data-note="net"></span>', go: false })}
        ${row({ button: "st-loc", icon: "", title: "Location", note: '<span data-note="loc"></span>', go: false })}
        ${row({ button: "st-build", icon: "", title: "Version", note: '<span class="st-mono" id="st-buildsub">Checking</span>', go: false })}
        ${row({ href: "#/settings/credits", icon: "", title: "Credits", note: '<span id="st-credn"></span>' })}
        ${row({ button: "st-report", icon: "", title: "Report a bug", note: "" })}
        ${row({ href: "/privacy", icon: "", title: "Privacy and terms", note: "" })}
      </div>
    </div>
  `;
  const note = (id) => el.querySelector(`[data-note="${id}"]`);

  // — you —
  function paintYou() {
    const me = store.me && store.me();
    const name = (me && me.name) || "";
    const nameEl = el.querySelector("[data-st-name]");
    nameEl.textContent = name || "Your account";
    requestAnimationFrame(() => fitName(nameEl));          // your whole name: smaller before it wraps
    const host = el.querySelector("[data-st-face]");
    const color = (typeof store.myNoteColor === "function" && store.myNoteColor()) || (me && me.note_color) || null;
    host.innerHTML = faceHtml({ name, initials: me && me.initials, size: 44, me: true, color });
    const yours = (me && me.avatar) || "";
    if (yours) pictureInto(host.querySelector(".ds-face"), yours);
  }
  paintYou();

  // — what each row holds —
  function paintNotes() {
    const pack = note("pack"), changes = note("changes"), people = note("people");
    if (changes) {
      const fresh = document.documentElement.hasAttribute("data-changes-new");
      changes.className = fresh ? "st-new" : "";
      changes.textContent = fresh ? "New" : "";
    }
    if (people) {
      const n = (store.members ? store.members() : []).length;
      people.textContent = n ? `${n} ${n === 1 ? "person" : "people"}` : "";
    }
    if (pack) {
      const c = myPackCount(store);
      pack.textContent = c ? `${c.done} of ${c.carried} packed` : "";
    }
  }
  paintNotes();
  // What only the server knows, asked once a mount and said when it answers; nothing is said without signal.
  const paintApps = () => fetch("/api/account/apps", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((j) => {
    const n = j && Array.isArray(j.apps) ? j.apps.length : null;
    if (n !== null && note("apps")) note("apps").textContent = n ? `${n} connected` : "None yet";
  }, () => {});
  paintApps();
  // AI apps: the one Connect your AI sheet, here in the trip (js/plan-ai.js); a guest's row goes to Your account, which
  // says what they need first. The apps connected, and Disconnect, are on Your account.
  el.querySelector("#st-apps")?.addEventListener("click", async () => {
    const { openPlanWithAiSheet } = await import("./plan-ai.js");
    const trip = store.trip();
    const people = typeof store.members === "function" ? store.members().filter((m) => !m.left_at).length : 0;
    openPlanWithAiSheet({ title: "Connect your AI", trip, people, place: (store.places()[0] && store.places()[0].name) || "",
      onConnected: () => { paintApps(); } });
  });
  fetch("/api/trips", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((j) => {
    const n = j && Array.isArray(j.trips) ? j.trips.length : null;
    if (n && note("trips")) note("trips").textContent = String(n);
  }, () => {});

  // A service worker keeps serving its precached shell until a VERSION bump replaces it, so the row asks the RUNNING
  // worker what it is, not the network. A waiting worker is the newer shell held back until every tab closes: the
  // state a person can act on.
  const buildBtn = el.querySelector("#st-build");
  const buildSub = el.querySelector("#st-buildsub");
  const askWorker = (worker, type) => new Promise((resolve) => {
    if (!worker) return resolve(null);
    const ch = new MessageChannel();
    const done = setTimeout(() => resolve(null), 1500);
    ch.port1.onmessage = (ev) => { clearTimeout(done); resolve(ev.data); };
    try { worker.postMessage({ type }, [ch.port2]); } catch { clearTimeout(done); resolve(null); }
  });
  async function paintBuild() {
    const sw = navigator.serviceWorker;
    if (!sw) { buildSub.textContent = "No offline copy"; buildBtn.disabled = true; return; }
    const reg = await sw.getRegistration().catch(() => null);
    // The worker running this page; on a first visit it may be installed but not yet in control of it.
    const running = await askWorker(sw.controller || (reg && reg.active), "app/version");
    if (!running || !running.version) {
      buildSub.textContent = "Not kept offline yet";
      buildBtn.dataset.ready = "0";
      buildBtn.setAttribute("aria-label", "Version: not kept offline yet. Check again");
      return;
    }
    const ver = running.version;
    buildSub.textContent = reg && reg.waiting ? `${ver} · update ready` : ver;
    buildBtn.dataset.ready = reg && reg.waiting ? "1" : "0";
    buildBtn.setAttribute("aria-label", reg && reg.waiting ? `Version ${ver}, an update is ready: install it` : `Version ${ver}: check for an update`);
  }
  buildBtn.addEventListener("click", async () => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const reg = await sw.getRegistration().catch(() => null);
    if (!reg) { buildSub.textContent = "No offline copy"; return; }
    if (reg.waiting) {
      buildSub.textContent = "Installing";
      await askWorker(reg.waiting, "app/skip-waiting");
      // controllerchange fires once the waiting worker takes over; reloading then lands on the new shell.
      sw.addEventListener("controllerchange", () => location.reload(), { once: true });
      setTimeout(() => location.reload(), 1200);
      return;
    }
    buildSub.textContent = "Checking";
    try { await reg.update(); } catch { /* no signal: the row says what it already knew */ }
    await paintBuild();
  });
  paintBuild();

  // — the trip —
  const tripEl = el.querySelector("#st-trip");
  function paintTrip() {
    const trip = store.trip();
    if (!trip) { tripEl.innerHTML = `<p class="ds-meta">Trip not loaded.</p>`; return; }
    // starts_on/ends_on are plain ISO dates with no zone: read as UTC, so west of Greenwich they aren't a day early.
    const start = Date.parse(trip.starts_on + "T00:00:00Z");
    const end = Date.parse(trip.ends_on + "T00:00:00Z");
    const now = Date.parse(dayKey(Date.now(), trip.default_tz) + "T00:00:00Z");
    const dated = Number.isFinite(start) && Number.isFinite(end);
    let when = dated ? `${fmtDay(start, "UTC")} – ${fmtDay(end, "UTC")}` : "Dates not set yet";
    if (dated && now >= start && now <= end) {
      const day = Math.round((now - start) / 86400000) + 1;
      const total = Math.round((end - start) / 86400000) + 1;
      when = `Day ${day} of ${total} · ${fmtDay(now, "UTC")}`;
    }
    tripEl.innerHTML = `<p class="st-tripname">${esc(trip.name)}</p><p class="ds-meta num">${esc(when)}</p>`;
  }
  paintTrip();

  // — appearance —
  const seg = el.querySelector("#st-theme");
  function paintTheme() {
    const cur = readTheme();
    for (const b of seg.querySelectorAll("[data-mode]")) b.setAttribute("aria-checked", String(b.dataset.mode === cur));
  }
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b) return;
    applyTheme(b.dataset.mode);
    paintTheme();
  });
  paintTheme();

  // — connection: the one place the app says its sync state in words; a tap sends what waits and asks for news —
  const netBtn = el.querySelector("#st-net");
  function paintNet() {
    const s = store.status();
    const words = `${s.online ? "Online" : "Offline"}${s.pending ? ` · ${s.pending} waiting` : ""}`;
    note("net").textContent = words;
    netBtn.setAttribute("aria-label", `Connection: ${words}${s.lastSync ? `, synced ${fmtAgo(s.lastSync)}` : ""}. Sync now`);
  }
  netBtn.addEventListener("click", () => { store.flush(); store.refresh(); });
  paintNet();

  // — location: what this phone knows of where you are; a tap asks again —
  const locBtn = el.querySelector("#st-loc");
  let busy = false;
  function paintLoc() {
    const p = lastPosition();
    const words = busy ? "Finding you…" : p ? "On" : positionDenied() ? "Off" : "Not asked";
    note("loc").textContent = words;
    locBtn.disabled = busy;
    locBtn.setAttribute("aria-label", `Location: ${words}${p ? `, within ${fmtDistance(p.accuracy)}` : ""}. ${p ? "Update" : "Locate"}`);
  }
  locBtn.addEventListener("click", async () => {
    busy = true; paintLoc();
    await getPosition({ force: true });
    busy = false; paintLoc();
  });
  paintLoc();

  // — report a bug: the form in a sheet (report-form.js), naming the screen before More: what was open when it went wrong —
  el.querySelector("#st-report").addEventListener("click", () => {
    const before = ctx.router?.prev?.();
    const screenAddress = `${location.pathname}#${before?.path ?? "/settings"}`;
    const form = reportForm({ screenAddress, screenName: before?.title ?? "More", withAccount: true });
    openSheet({ title: "Report a bug", contentEl: form.el, onClose: form.dispose });
  });

  // — credits: the photographs the trip shows —
  {
    const n = shownPhotos(store).length;
    el.querySelector("#st-credn").textContent = n ? `${n} photograph${n === 1 ? "" : "s"}` : "";
  }

  const offChange = store.on("change", () => { paintTrip(); paintYou(); paintNotes(); });
  const offStatus = store.on("status", paintNet);
  const marks = new MutationObserver(paintNotes);
  marks.observe(document.documentElement, { attributes: true, attributeFilter: ["data-changes-new"] });
  return () => { offChange(); offStatus(); marks.disconnect(); };
}

// A row of More: an icon, its name, what it holds at the right, and the way on. A link, or a button for what acts here.
function row({ href, button, icon, title, note, go = true }) {
  const inner = `<span class="ds-item-lead st-ico">${icon ? `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>` : ""}</span>`
    + `<span class="ds-item-main"><span class="ds-item-title">${esc(title)}</span></span>`
    + `<span class="ds-item-trail st-hold">${note}${go ? svg("chevron", "st-go") : ""}</span>`;
  return href ? `<a class="ds-item st-row" href="${esc(href)}">${inner}</a>` : `<button type="button" class="ds-item st-row" id="${button}">${inner}</button>`;
}

// The mock-up's symbols for More's rows.
const MORE_ICO = {
  changes: '<path d="M12 7v5l3 2M4 12a8 8 0 1 0 2.5-5.8M4 5v4h4"/>',
  pack: '<path d="M6 8h12l1 12H5L6 8ZM9 8V6a3 3 0 0 1 6 0v2"/>',
  people: '<circle cx="9" cy="9" r="3"/><path d="M3 19c.5-3 3-4.5 6-4.5s5.5 1.5 6 4.5M16 6.5a3 3 0 0 1 0 5.5M17.5 14.8c1.8.6 3 2 3.5 4.2"/>',
  apps: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5 9 9M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5"/>',
  trips: '<rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M9 8V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v2"/>',
};

// ── credits ────────────────────────────────────────────────────────────────────────────

// Map credits: the map's "OpenStreetMap · Protomaps" control is omitted from the
// canvas, and ODbL 4.3 still requires reasonable attribution somewhere a reader will find it.
// This is that somewhere — the same page, the same pattern as the photographs, because it is
// the same obligation. Data, not a new page: the map role added this array and the six lines
// that render it.
const DATA_CREDITS = [
  {
    name: "Street map data",
    credit: "OpenStreetMap contributors",
    license: "ODbL 1.0",
    source: "https://www.openstreetmap.org/copyright",
  },
  {
    name: "Basemap tiles and style",
    credit: "Protomaps",
    license: "BSD-3-Clause",
    source: "https://protomaps.com",
  },
];
// The towns a trip's "Where" is found in (public/towns/, made by scripts/make_towns.mjs from
// GeoNames, CC BY 4.0). Its date is the table's own, read from its index: the line can't say a
// snapshot the files aren't.
const TOWNS_CREDIT = { name: "Towns, cities and their time zones", credit: "GeoNames", license: "CC BY 4.0", source: "https://www.geonames.org/" };
async function townsCredit() {
  let made = "";
  try {
    const res = await fetch("/towns/index.json");
    if (res.ok) made = String((await res.json()).made || "");
  } catch { /* no signal and no kept copy: the credit stands without its date */ }
  const day = /^\d{4}-\d{2}-\d{2}$/.test(made)
    ? new Date(`${made}T12:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "";
  return { ...TOWNS_CREDIT, license: day ? `${TOWNS_CREDIT.license} · as of ${day}` : TOWNS_CREDIT.license };
}


// Cached across mounts: the file is ~20 KB of JSON and this page is reachable from a row
// that people will tap, back out of, and tap again.
let creditsCache = null;
async function loadCredits() {
  if (creditsCache) return creditsCache;
  const res = await fetch("/img/CREDITS.json", { cache: "force-cache" });
  if (!res.ok) throw new Error(`CREDITS.json ${res.status}`);
  creditsCache = await res.json();
  return creditsCache;
}

/**
 * Every photograph the trip shows, once each: its places' (a picture, or the old columns until
 * the cutover moves them), its events' own pictures, and its cover. [{ name, card, credit, old }],
 * `credit` null for a row on the old columns (the manifest has it).
 */
function shownPhotos(store) {
  const out = [];
  const seen = new Set();
  const add = (name, card, credit, old) => { if (card && !seen.has(card)) { seen.add(card); out.push({ name, card, credit, old }); } };
  const cover = coverOf(store.trip());
  if (cover) add("The trip's cover", cover.url, cover.credit, false);
  for (const e of store.events()) { const pic = pictureOf(e); if (pic) add(e.title, pic.url, creditOf(pic), false); }
  for (const p of store.places()) {
    const shot = placePhoto(p);
    if (shot) add(p.name, shot.card, pictureOf(p) ? shot.credit : null, !pictureOf(p));
  }
  return out;
}

/** "own" is the person's own photograph: credited to whoever on the trip added it. */
function creditWords(c, store, pic) {
  if (String(c.license).toLowerCase() === "own") {
    const who = pic && pic.created_by ? (store.members() || []).find((m) => m.id === pic.created_by) : null;
    return { by: who ? `Photo by ${who.name}` : "Photo by someone on the trip", license: "Their own photo" };
  }
  return { by: c.credit || "Unknown photographer", license: c.license || "Licence not recorded" };
}

async function mountCredits(el, ctx) {
  const { store } = ctx;
  el.innerHTML = `
    <h1 class="st-title">Credits</h1>
    <p class="st-intro">Photographs, map data and town names, under the licence named beside each.</p>
    <div class="stack" id="cr-body"><div class="skeleton" style="height:64px"></div>
      <div class="skeleton" style="height:64px"></div>
      <div class="skeleton" style="height:64px"></div></div>
  `;
  const body = el.querySelector("#cr-body");
  const rows = shownPhotos(store);

  // The manifest only for rows still on the old columns; a picture carries its own credit.
  let failed = null;
  if (rows.some((r) => r.old)) {
    try {
      const data = await loadCredits();
      const byCard = new Map((data.images || []).map((i) => [i.card, i]));
      for (const r of rows) {
        if (!r.old) continue;
        const i = byCard.get(r.card);
        if (i) r.credit = { license: i.license, credit: i.credit, source: i.source };
      }
    } catch (e) { failed = e; }
  }
  const dataCredits = [...DATA_CREDITS, await townsCredit()];
  const pics = new Map();
  for (const e of store.events()) if (pictureOf(e)) pics.set(pictureOf(e).url, pictureOf(e));
  for (const p of store.places()) if (pictureOf(p)) pics.set(pictureOf(p).url, pictureOf(p));
  const cover = store.trip() && store.trip().cover;
  if (cover && cover.url) pics.set(cover.url, cover);

  const imgs = rows.map((r) => ({ ...r, words: r.credit ? creditWords(r.credit, store, pics.get(r.card)) : null }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  // Licence tally up front: it is the summary a reuser or a takedown request actually wants,
  // and it makes an accidentally-empty list obvious at a glance.
  const tally = new Map();
  for (const i of imgs) { const lic = i.words ? i.words.license : "Licence not recorded"; tally.set(lic, (tally.get(lic) || 0) + 1); }
  const summary = [...tally.entries()].sort((a, b) => b[1] - a[1])
    .map(([lic, n]) => `<span class="pill">${esc(lic)} · ${n}</span>`).join("");

  body.innerHTML =
    // Loud, not silent: a photograph shown without its credit is a licence breach wearing a
    // styling bug's clothes.
    (failed ? `<div class="banner"><svg viewBox="0 0 24 24" aria-hidden="true">` +
      `<path d="M12 8.4v5M12 16.6v.1"/><circle cx="12" cy="12" r="9"/></svg>` +
      `<span><strong>Some credits didn't load</strong> — attribution not shown for those below. ` +
      `Reconnect and reopen. (${esc(String(failed.message || failed))})</span></div>` : "") +
    `<p class="meta num">${imgs.length} photograph${imgs.length === 1 ? "" : "s"}</p>` +
    (imgs.length ? `<div class="row wrap st-licences">${summary}</div>` : "") +
    `<ul class="cr-list">` +
    imgs.map((i) => `
      <li class="cr-item">
        <img class="cr-thumb" src="${esc(i.card)}" alt="" loading="lazy" decoding="async" width="56" height="56">
        <div class="grow">
          <div class="cr-name">${esc(i.name)}</div>
          <div class="cr-by">${esc(i.words ? i.words.by : "Credit not loaded")}</div>
          <div class="cr-lic num">${esc(i.words ? i.words.license : "Licence not loaded")}</div>
          ${i.credit && i.credit.source ? `<a class="cr-src" href="${esc(i.credit.source)}" target="_blank" rel="noopener noreferrer">
              Source ${svg("external", "cr-ext")}</a>` : ""}
        </div>
      </li>`).join("") +
    `</ul>` +
    `<h2 class="eyebrow st-head">Map data</h2>` +
    `<ul class="cr-list">` +
    dataCredits.map((d) => `
      <li class="cr-item">
        <div class="grow">
          <div class="cr-name">${esc(d.name)}</div>
          <div class="cr-by">${esc(d.credit)}</div>
          <div class="cr-lic num">${esc(d.license)}</div>
          <a class="cr-src" href="${esc(d.source)}" target="_blank" rel="noopener noreferrer">
            Source ${svg("external", "cr-ext")}</a>
        </div>
      </li>`).join("") +
    `</ul>`;
}

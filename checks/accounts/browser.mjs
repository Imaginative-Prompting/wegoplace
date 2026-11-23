// The sign-in page, the account page and the page a join link opens, in a real browser: made-up
// people, each in a browser of their own with a device that makes and uses real passkeys, going
// through everything the three pages offer against a server started for this check (Google and
// GitHub played on this computer, email read back from the server's log). The app's own screens
// (making a trip, making a link) aren't these pages': where a part needs a trip or a link, the
// request is sent from the host's signed-in page. Along the way it measures each page at a
// phone's, a tablet's and a desktop's width and in every theme: nothing off the side, nothing
// clipped, nothing overlapping, every control big enough to tap and named, every message with
// an icon as well as its tint, and all text readable against what is behind it.
//
// It starts a browser, so it goes through the machine's queue (the launcher refuses otherwise):
//   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
//     --label "accounts in a browser" -- node checks/accounts/browser.mjs
//   --port 8791   --keep   --shots <folder> (a picture of each state, to look at)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startServer, CheckError } from "../lib/server.mjs";
import { startStandin } from "../lib/standin.mjs";
import { Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";
import { makeAccount, openMaking } from "../lib/signin-page.mjs";
import { DESKTOP, NARROW, PHONE, SIZES, TABLET, empty, looks } from "../lib/look.mjs";
import { makeLink } from "../../tools/signin-link.mjs";
import { register } from "../lib/mcp.mjs";
import { TRIP_MEMBERS_MAX, TRIP_NAME_MAX } from "../../public/js/shared/limits.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8791);
const shots = flag("--shots");
const keep = argv.includes("--keep");
if (shots) fs.mkdirSync(shots, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const made = () => crypto.randomBytes(24).toString("base64url");
const clients = { google: { id: "check-google-client", secret: made() }, github: { id: "check-github-client", secret: made() } };


// ── what is measured inside the page ──────────────────────────────────────────────────────
// The layout and contrast measurements are checks/lib/look.mjs's (shared with the trips pages).

/**
 * Run in every document before its own script: where the sign-in heading and the passkey
 * button are in each frame they can be seen (and when the heading first was), every other
 * element of the page that is seen in a second place (`others`; `tracked` is how many it
 * watched at most, so "none moved" can't mean "none seen"), and how much the
 * browser says the page's content moved by itself (its layout-shift score, with what moved).
 * The places are the proof; the score alone has read 0 for a page whose heading moved 79 px.
 */
const TRACK = `(() => {
  const seen = { title: [], button: [], shifts: 0, titleAt: null };
  window.__moved = seen;
  // Every press, as the page heard it: what the pointer went down and came up on (with where), whether a click and a
  // submit followed, and whether the page held the submit. arrive() prints them when a page never gets where it went.
  const presses = window.__presses = [];
  const nameOf = (el) => (el && el.nodeType === 1 ? (el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.closest("[id]") ? " in #" + el.closest("[id]").id : "")) : "?");
  for (const type of ["pointerdown", "pointerup", "click"]) {
    addEventListener(type, (e) => presses.push(type + " " + nameOf(e.target) + " @" + Math.round(e.clientX) + "," + Math.round(e.clientY)), true);
  }
  addEventListener("submit", (e) => { presses.push("submit " + nameOf(e.target)); setTimeout(() => presses.push("  held by the page: " + e.defaultPrevented)); }, true);
  addEventListener("focusout", (e) => presses.push("focusout " + nameOf(e.target)), true);
  const at = (id, list) => {
    const el = document.getElementById(id);
    if (!el || el.closest("[hidden]") || getComputedStyle(el).visibility === "hidden") return;
    const r = el.getBoundingClientRect();
    if (!r.height) return;
    const where = [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 2) / 2).join(" ");
    if (list[list.length - 1] !== where) list.push(where);
    if (id === "signin-title") seen.titleAt ??= Math.round(performance.now());     // ms after the page began to open
  };
  // The first twenty seconds of the page: long after it has come to rest, and no work left
  // running in a page the check has finished with.
  const until = performance.now() + 20000;
  const name = (n) => !n ? "something gone" : n.id ? "#" + n.id : n.nodeType === 3 ? "text in " + name(n.parentElement) : n.tagName.toLowerCase() + (n.className && n.className.baseVal === undefined ? "." + String(n.className).trim().split(/\\s+/).join(".") : "");
  // Everything else a person can see on the sign-in page: once seen in a place, it stays there.
  const places = new Map();
  const others = () => {
    const root = document.getElementById("page");
    if (!root) return;
    for (const el of root.querySelectorAll("*")) {
      if (!el.checkVisibility({ visibilityProperty: true })) { places.delete(el); continue; }
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const where = [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 2) / 2).join(" ");
      const was = places.get(el);
      if (was && was !== where && seen.others.length < 12) seen.others.push(Math.round(performance.now()) + " ms: " + name(el) + " " + was + " -> " + where);
      places.set(el, where);
    }
    seen.tracked = Math.max(seen.tracked, places.size);
  };
  seen.others = [];
  seen.tracked = 0;
  const frame = () => { at("signin-title", seen.title); at("btn-signin", seen.button); others(); if (performance.now() < until) requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  try {
    const box = (r) => [r.x, r.y, r.width, r.height].map(Math.round).join(" ");
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        seen.shifts += e.value;
        // What moved, from where to where, and when: a failure says more than a number.
        (seen.moved ??= []).push(Math.round(e.startTime) + " ms: " + e.sources.map((s) => name(s.node) + " " + box(s.previousRect) + " -> " + box(s.currentRect)).join("; "));
      }
    }).observe({ type: "layout-shift", buffered: true });
    document.fonts.addEventListener("loadingdone", (e) => (seen.fonts ??= []).push(Math.round(performance.now()) + " ms: " + e.fontfaces.map((f) => f.family).join(", ")));
  } catch (e) { /* a browser without it still has the two lists */ }
})();`;

/** A color as the page resolves it: a token (\`var(--warn)\`) or an element's own. */
const COLORS = `
  const resolved = (value) => { const probe = document.createElement("i"); probe.style.color = value; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; };
`;

/** The mark each provider's button carries: which element, how tall, drawn or not, and before the words. */
const MARKS = (scope) => `[...document.querySelectorAll(${JSON.stringify(scope)} + " form[data-provider]")].filter((f) => !f.hidden).map((f) => {
  const button = f.querySelector("button"), mark = button.querySelector(".lg-mark");
  if (!mark) return f.dataset.provider + ": no mark";
  const r = mark.getBoundingClientRect(), words = button.querySelector("[data-words]")?.getBoundingClientRect();
  const drawn = mark.tagName === "IMG" ? mark.complete && mark.naturalWidth > 0 : !!mark.querySelector("path");
  const square = Math.abs(r.width / r.height - (mark.tagName === "IMG" ? mark.naturalWidth / mark.naturalHeight : 1)) < 0.03;
  return [f.dataset.provider, mark.tagName.toLowerCase(), Math.round(r.height), drawn && square, !!words && r.right <= words.left, mark.getAttribute("aria-hidden") === "true" || mark.getAttribute("alt") === ""].join(" ");
})`;

const SAID = (id) => `(() => {
  const box = document.getElementById(${JSON.stringify(id)});
  if (!box || box.hidden) return null;
  return {
    kind: box.classList.contains("lg-msg-err") ? "err" : box.classList.contains("lg-msg-ok") ? "ok" : "info",
    words: box.querySelector("span").textContent,
    icon: box.querySelector("svg").children.length > 0,
  };
})()`;

// ── the check ─────────────────────────────────────────────────────────────────────────────

const t = new Report("accounts in a browser");
const { layouts, readable } = looks({ t, shots });
let server, standin, chrome;
let code = 1;
const everyPage = [];

/** What a message box says, once it says something matching `words`. */
async function said(page, id, words, within = 15000) {
  const end = Date.now() + within;
  let last = null;
  for (;;) {
    try { last = await page.eval(SAID(id)); } catch { /* mid-navigation */ }
    if (last && words.test(last.words)) return last;
    if (Date.now() > end) return last ?? { kind: null, words: "(nothing was said)", icon: false };
    await sleep(60);
  }
}
/** One message that must be of a kind, in words, with its icon. */
async function mustSay(what, page, id, kind, words) {
  const got = await said(page, id, words);
  const right = got.kind === kind && words.test(got.words) && got.icon;
  // What the browser itself said, which the page keeps under its own words.
  const detail = right ? "" : await page.eval(`(() => { const d = document.getElementById("detail"); return d && !d.hidden ? d.textContent : ""; })()`).catch(() => "");
  return t.ok(what, right, detail ? { ...got, detail } : got);
}


/**
 * Text against its background, in each theme. A
 * theme is put on the way the app does it: the attribute, then the page's own script paints
 * what follows from it (it runs whenever the system's light or dark changes).
 */

/** The provider's own page: the browser has been sent there, and `person` says yes. */
async function throughProvider(page, provider, person) {
  const href = await page.until(`location.href.startsWith(${JSON.stringify(standin.origin)}) && location.href`, `the browser to be sent to ${provider}`);
  const { code: grant, state, redirectUri } = standin.allow(provider, href, person);
  await page.send("Page.navigate", { url: `${redirectUri}?code=${encodeURIComponent(grant)}&state=${encodeURIComponent(state)}` });
}

/** Waits for a page to be at an address; if it never gets there, says what the page is showing instead. */
async function arrive(page, where) {
  try {
    await page.at(where);
  } catch (e) {
    const says = await page.eval(`[...document.querySelectorAll(".lg-msg:not([hidden]) span, .err-detail:not([hidden])")].map((n) => n.textContent).join(" | ")`).catch(() => "");
    // A button still saying what it's waiting for ("Creating your account…") is a request that never came back; one
    // with its own words is a press that did nothing. The page's own errors say why either way.
    const waiting = await page.eval(`[...document.querySelectorAll("button:has(.lg-spin)")].map((b) => (b.id || "a button") + ": " + b.textContent.trim()).join(" | ")`).catch(() => "");
    const errors = (page.errors ?? []).slice(0, 3).join(" | ");
    const presses = await page.eval(`(window.__presses || []).slice(-10).join(" / ")`).catch(() => "");
    throw new Error(`${e.message}${says ? `; the page says: ${says}` : ""}${waiting ? `; still waiting: ${waiting}` : "; no button waiting"}${errors ? `; its errors: ${errors}` : ""}${presses ? `; its last presses: ${presses}` : ""}`);
  }
}

/** The sign-in page has asked what this site offers and drawn it, so its buttons are where they will stay. */
/** Whether a button that asks twice is asking now. */
const asking = (page, selector) => page.eval(`document.querySelector(${JSON.stringify(selector)}).classList.contains("lg-armed")`);
/**
 * The second press of a button that asks twice. The asking lapses after five seconds, as it
 * should; a check that took longer than that in between (a busy machine) is asked again
 * first, as a person who waited would be.
 */
async function pressAgain(page, selector) {
  if (!(await asking(page, selector))) {
    await page.click(selector);
    await armed(page, selector);
  }
  await page.click(selector);
}
/** A button that asks twice, asking: some first count what is waiting on the phone before they do. */
const armed = (page, selector) => page.until(`document.querySelector(${JSON.stringify(selector)}).classList.contains("lg-armed")`, `${selector} to ask`);

// What a phone keeps about a person (public/js/forget.js). PLANT puts there `changes` changes in
// the trip's queue and one in the packing list's, none of them sent, a kept picture, and two
// remembered choices: one about the person (it goes) and one about the phone (it stays).
const PLANT = (changes) => `(async () => {
  const open = (name, make) => new Promise((ok, no) => { const r = indexedDB.open(name); r.onupgradeneeded = () => make(r.result); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const put = (db, store, rows) => new Promise((ok, no) => { const t = db.transaction([store], "readwrite"); for (const row of rows) t.objectStore(store).put(row); t.oncomplete = ok; t.onerror = () => no(t.error); });
  const trip = await open("wegoplace", (db) => db.createObjectStore("queue", { keyPath: "seq", autoIncrement: true }));
  await put(trip, "queue", Array.from({ length: ${changes} }, (_, i) => ({ kind: "notes", op: "put", body: { id: "nt-planted-" + i } })));
  trip.close();
  const pack = await open("wegoplace-pack", (db) => db.createObjectStore("kv", { keyPath: "k" }));
  await put(pack, "kv", [{ k: "queue", v: [{ op: "put", id: "pk-planted" }] }]);
  pack.close();
  await (await caches.open("wegoplace-media-v1")).put("/media/planted", new Response("a kept picture"));
  localStorage.setItem("wgp.lastTrip", "planted");
  localStorage.setItem("wgp.theme", "dark");
  return true;
})()`;
/** What of that is on the phone now. Opens nothing that isn't there. */
const HELD = `(async () => {
  const open = (name) => new Promise((ok) => { let made = false; const r = indexedDB.open(name); r.onupgradeneeded = () => { made = true; r.transaction.abort(); }; r.onsuccess = () => ok(made ? null : r.result); r.onerror = (e) => { e.preventDefault(); ok(null); }; });
  const count = (db, store, key) => new Promise((ok) => {
    if (!db || !db.objectStoreNames.contains(store)) { ok(0); return; }
    const os = db.transaction([store]).objectStore(store);
    const r = key ? os.get(key) : os.count();
    r.onsuccess = () => ok(key ? (r.result?.v?.length ?? 0) : r.result);
    r.onerror = () => ok("unreadable");
  });
  const trip = await open("wegoplace"), pack = await open("wegoplace-pack");
  const held = { queue: await count(trip, "queue"), pack: await count(pack, "kv", "queue"), picture: await caches.has("wegoplace-media-v1"),
    person: localStorage.getItem("wgp.lastTrip"), phone: localStorage.getItem("wgp.theme"), cleared: !!localStorage.getItem("wgp.epoch") };
  trip?.close(); pack?.close();
  return held;
})()`;
const kept = (queue, cleared) => ({ queue, pack: 1, picture: true, person: "planted", phone: "dark", cleared });
const CLEARED = { queue: 0, pack: 0, picture: false, person: null, phone: "dark", cleared: true };
/** Does `work` while a button is asking, and again (having pressed again) if the asking lapsed under it. */
async function whileAsking(page, selector, work) {
  for (let tries = 0; ; tries++) {
    const got = await work();
    if (await asking(page, selector) || tries === 3) return got;
    await page.click(selector);
  }
}

const signinDrawn = (page) => page.until(`!document.getElementById("providers").hidden || !document.getElementById("paused").hidden`, "the sign-in page to show what this site offers");

const panels = (page) => page.eval(`["signin", "new", "link", "recover", "account"].filter((p) => !document.getElementById("p-" + p).hidden)`);
const waysShown = (page) => page.eval(`[...document.querySelectorAll("#ways .ac-way")].map((row) => ({
  title: row.querySelector(".ac-way-title span").textContent,
  label: row.querySelector(".ac-way-label")?.textContent ?? "",
  pill: row.querySelector(".ds-tag")?.textContent ?? "",
  pillIcon: !!row.querySelector(".ds-tag svg"),
  remove: !!row.querySelector("button"),
}))`);
const accountShown = (page) => page.until(`!document.getElementById("account").hidden`, "the account page to finish loading");
/** The trips an account is on, as Your trips shows them (they left the account page, flow 7): the name, the words
 *  that say it hosts one, and the line of dates and people (without a guest's " · hosted by …"). It comes back to
 *  Your account after, where its callers carry on. */
const tripsShown = async (page) => {
  const here = await page.eval(`location.origin`);
  await page.goto(`${here}/trips`);
  await page.until(`document.querySelector("#list .tr-trip")`, "Your trips to list the trips");
  const rows = await page.eval(`[...document.querySelectorAll("#list .tr-trip")].map((row) => ({
    name: row.querySelector(".tr-trip-name").textContent,
    pill: row.querySelector(".ac-way-title .pill:not(.tr-new)")?.textContent.trim() ?? "",
    pillIcon: !!row.querySelector(".ac-way-title .pill:not(.tr-new) svg path"),
    meta: row.querySelector(".ac-way-main > .meta").textContent.replace(/ · hosted by .*$/, ""),
  }))`);
  await page.goto(`${here}/account`);
  await accountShown(page);
  return rows;
};
/** A request sent from a signed-in page, the way the app sends one. */
const ask = (page, method, address, body) => page.eval(`fetch(${JSON.stringify(address)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json" }${body === undefined ? "" : `, body: ${JSON.stringify(JSON.stringify(body))}`} })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))`);
/** Which of the join page's screens is up, once it has decided. */
const joinDrawn = async (page) => {
  await page.until(`!document.getElementById("page").hasAttribute("data-wait") && ["trip", "gone", "failed"].some((p) => !document.getElementById("p-" + p).hidden)`, "the join page to say what the link is");
  return page.eval(`["trip", "gone", "failed"].filter((p) => !document.getElementById("p-" + p).hidden)`);
};
/** The screen for a link that doesn't work: which screen, its words, where its button goes. */
const GONE = `(() => { const p = document.getElementById("p-gone"); return [["trip", "gone", "failed"].filter((q) => !document.getElementById("p-" + q).hidden), p.querySelector("h1").textContent, p.querySelector(".lead").textContent, p.querySelector("a").getAttribute("href")]; })()`;
const GONE_WORDS = [["gone"], "This link doesn't work", "It may have run out, been used by as many people as it allows, or been turned off. Ask someone on the trip for a new one.", "/"];
const sql = (text) => server.sql(text);

try {
  standin = await startStandin({ port: port + 10, clients });
  const settings = {
    vars: { GOOGLE_CLIENT_ID: clients.google.id, GITHUB_CLIENT_ID: clients.github.id, EMAIL_FROM: "account@check.example", AUTH_STANDIN: standin.origin },
    secrets: { GOOGLE_CLIENT_SECRET: clients.google.secret, GITHUB_CLIENT_SECRET: clients.github.secret },
  };
  server = await startServer({ name: "accounts-browser", port, keep, email: true, ...settings });
  await server.start();
  const { origin } = server;
  chrome = await openChrome();
  const open = async (o) => { const page = await chrome.page({ ...o, before: TRACK + (o.before ?? "") }); everyPage.push(page); return page; };

  // ── the sign-in page, signed out ────────────────────────────────────────────────────────
  t.part("The sign-in page, on a phone");
  const phone = await open(PHONE);
  await phone.goto(`${origin}/account`);
  await arrive(phone, "/login?next=/account");
  t.same("asking for /account signed out lands on the sign-in page, which remembers where to go back to", await phone.where(), "/login?next=/account");
  await phone.until(`!document.getElementById("providers").hidden && !document.getElementById("btn-recover").hidden`, "the page to show what this site offers");
  t.same("it shows the sign-in screen and no other", await panels(phone), ["signin"]);
  t.ok("the wordmark is drawn", await phone.until(`document.querySelector("#brand svg") && document.querySelector("#brand svg").getBoundingClientRect().width > 60`, "the wordmark"));
  t.same("Google, GitHub and getting back in by email are offered, since this site has them; nothing says passkeys can't work here",
    await phone.eval(`[...document.querySelectorAll("#p-signin form[data-provider]")].map((f) => !f.hidden).concat([!document.getElementById("btn-recover").hidden, document.getElementById("unsupported").hidden, document.getElementById("no-platform").hidden])`),
    [true, true, true, true, true]);
  t.same("Google's button carries Google's G and GitHub's the GitHub mark: each 20 high, drawn, in its own shape, before the words, and not read out twice",
    await phone.eval(MARKS("#p-signin")), ["google img 20 true true true", "github svg 20 true true true"]);
  const googleLook = `(() => { const cs = getComputedStyle(document.querySelector('#p-signin form[data-provider="google"] button')); return [cs.backgroundColor, cs.borderTopColor, cs.color].join(" / "); })()`;
  const looks = [await phone.eval(googleLook)];
  await phone.scheme("dark");
  await phone.rest();
  looks.push(await phone.eval(googleLook));
  await phone.scheme("light");
  await phone.rest();
  // The sign-in screen's one white button is Google's own light one, on a dark page too (Google's rules give the light,
  // dark and neutral buttons for any page); the screen that adds Google to an account (#p-new) takes its dark one there.
  t.same("the G sits on the light button Google gives it, in both themes: white, with Google's own outline and text colors",
    looks, ["rgb(255, 255, 255) / rgb(116, 119, 117) / rgb(31, 31, 31)", "rgb(255, 255, 255) / rgb(116, 119, 117) / rgb(31, 31, 31)"]);
  await layouts(phone, "the sign-in screen", "signin");
  await readable(phone, "the sign-in screen");

  t.part("The sign-in page when asking what this site offers fails");
  {
    // A phone on a bad connection: the call fails, and fails again. That never reads as "no Google": both buttons show.
    const lost = await open(PHONE);
    let asked = 0;
    lost.wire.listeners.add((m) => { if (m.sessionId === lost.session && m.method === "Fetch.requestPaused") asked++; });
    await lost.requests("*/api/auth/config*", "fail");
    await lost.goto(`${origin}/login`);
    const shown = await lost.until(`!document.getElementById("providers").hidden`, "the providers, with the call failing", 20000).then(() => true, () => false);
    t.same("with the call failing twice, Google and GitHub are both still offered beside the passkey (never the passkey alone)",
      [shown, await lost.eval(`[...document.querySelectorAll("#p-signin form[data-provider]")].map((f) => f.dataset.provider + ":" + !f.hidden).join(" ")`), asked],
      [true, "google:true github:true", 2]);
    await lost.requests("*/api/auth/config*", "off");
    await lost.close();
  }

  t.part("The sign-in page as it opens, on a slow connection");
  for (const size of [PHONE, TABLET]) {
    const slowly = await open(size);
    await slowly.slow(300);
    await slowly.goto(`${origin}/login`);
    await signinDrawn(slowly);
    await slowly.rest();
    const moved = await slowly.eval("window.__moved");
    t.ok(`at ${size.width} wide the heading and the passkey button are each seen in one place only, from the first frame they are drawn to rest, and nothing else on the page moves either`,
      moved.title.length === 1 && moved.button.length === 1 && moved.others.length === 0 && moved.shifts < 0.001, moved);
    await slowly.close();     // (what went wrong inside it, if anything, stays on the list)
  }

  // The wait must end without the page's script: it may be slow to arrive, or never arrive.
  t.part("The sign-in page when its script doesn't arrive");
  const stalled = await open(PHONE);
  await stalled.requests("*/js/auth.js", "stall");
  await stalled.open(`${origin}/login`);
  await stalled.until(`window.__moved && window.__moved.titleAt !== null`, "the sign-in page to show its heading with its script still on the way", 12000).catch(() => { /* never shown: the answer below says so */ });
  const shown = await stalled.eval(`({ at: window.__moved.titleAt, held: document.getElementById("page").hasAttribute("data-wait"), heading: document.getElementById("signin-title").textContent.trim(), state: document.readyState })`);
  t.ok("with the script still on the way, the page shows its heading by itself four seconds after it opens: not before, and not long after",
    // `held`: the page still waits on its script (it hasn't run). The document itself may be
    // "complete" by then: since v74 the page starts its script by import() through fresh-app.js,
    // which the document's load doesn't wait for.
    shown.at !== null && shown.at >= 3900 && shown.at <= 6000 && shown.held && shown.heading.length > 3, shown);
  await stalled.close();

  const cut = await open(PHONE);
  await cut.requests("*/js/auth.js", "fail");
  await cut.goto(`${origin}/login`);
  const told = await cut.eval(`(() => {
    const note = document.getElementById("no-script"), seen = (el) => el.checkVisibility({ visibilityProperty: true });
    return { at: Math.round(performance.now()), held: document.getElementById("page").hasAttribute("data-wait"), words: seen(note) ? note.querySelector("p").textContent.trim() : "", again: seen(note.querySelector("a")) ? note.querySelector("a").textContent.trim() : "",
      dead: [...document.querySelectorAll("#page button")].filter(seen).length };
  })()`);
  t.ok("when the script can't be fetched, the page says so in words at once, offers to try again, and shows no button that can't work",
    /didn't finish loading/.test(told.words) && told.again === "Try again" && told.dead === 0 && !told.held, told);
  await layouts(cut, "the sign-in page whose script couldn't be fetched", "signin-failed");
  await cut.requests("*/js/auth.js", "off");
  await cut.click("#no-script a");
  await signinDrawn(cut);
  t.same("Try again loads the page again, and with the script back it is the sign-in screen", [await panels(cut), await cut.eval(`document.getElementById("no-script").hidden`)], [["signin"], true]);
  await cut.close();

  // Three buttons and one row: nothing to make an account with until a passkey sign-in comes back without one.
  const MAKING = `[document.getElementById("signin-make").hidden, document.getElementById("make-what").textContent.trim(), document.getElementById("join-name").checkVisibility(),
    document.getElementById("btn-join").textContent.trim(), document.getElementById("btn-signin-again").checkVisibility(), document.getElementById("msg").hidden]`;
  t.same("before a sign-in: the passkey button says Continue with a passkey, and no name field or Try again is shown",
    [await phone.eval(`document.getElementById("btn-signin").textContent.trim()`), (await phone.eval(MAKING))[0], await phone.eval(`document.getElementById("trouble").open`)], ["Continue with a passkey", true, false]);
  await phone.click("#btn-signin");
  await phone.until(`!document.getElementById("signin-make").hidden`, "the account's making, after a sign-in with no passkey here", 30000);
  t.same("Continue with a passkey on a device with none for this site: it opens the account's making (its line, Your name, Create account) and Try again, and no other message; nothing made",
    [...await phone.eval(MAKING), sql("SELECT COUNT(*) AS n FROM users")[0].n], [false, "No passkey here yet? Make your account.", true, "Create account", true, true, 0]);
  await layouts(phone, "the sign-in screen with the account's making open", "signin-making");
  await readable(phone, "the sign-in screen with the account's making open");
  await phone.click("#btn-join");
  await mustSay("creating an account with no name says what to type, and makes nothing", phone, "msg", "err", /Type a name/);
  t.same("  (no account was made)", sql("SELECT COUNT(*) AS n FROM users")[0].n, 0);
  await phone.click("#btn-signin-again");
  // Its press marks it busy at once (auth.js busyState: a spinner in place of its words); back, its words return.
  await phone.until(`!document.querySelector("#btn-signin-again .lg-spin") && document.getElementById("btn-signin-again").textContent.trim() === "Try again"`, "Try again's sign-in to come back", 30000);
  t.same("Try again asks for a passkey again: still none, the making stays open, nothing made",
    [(await phone.eval(MAKING))[0], sql("SELECT COUNT(*) AS n FROM users")[0].n], [false, 0]);

  // The other ways in, folded into one row.
  await phone.click("#trouble > summary");
  t.same("Trouble signing in? opens the username way and the email way (and every button stays pressable: Try again, Create account)",
    await phone.eval(`[document.getElementById("trouble").open, document.getElementById("signin-name").checkVisibility(), document.getElementById("btn-signin-name").textContent.trim(), document.getElementById("btn-recover").checkVisibility(),
      ["btn-signin", "btn-signin-again", "btn-join", "btn-signin-name"].filter((id) => document.getElementById(id).disabled)]`),
    [true, true, "Sign in with my username", true, []]);
  await layouts(phone, "the sign-in screen with Trouble signing in? open", "signin-trouble");
  await phone.click("#trouble > summary");

  // ── a new account, and its account page ─────────────────────────────────────────────────
  t.part("A new account, made on the phone");
  await phone.type("#join-name", "  Mira   Check ");
  await phone.click("#btn-join");
  await arrive(phone, "/account");
  await accountShown(phone);
  const mira = sql("SELECT id, name FROM users")[0];
  t.same("a name and a passkey make an account, signed in, and it goes where it was headed", [mira?.name, (await phone.passkeys()).length, sql("SELECT COUNT(*) AS n FROM passkeys")[0].n], ["Mira Check", 1, 1]);
  t.same("the account page shows the name and its one way in, which can't be removed, and lists no trips (they are Your trips, under More)",
    [await phone.eval(`document.getElementById("name").value`), await phone.eval(`[!document.getElementById("trips"), !document.getElementById("trip-title"), !document.getElementById("ways-only").hidden]`), await waysShown(phone)],
    ["Mira Check", [true, true, true], [{ title: "Passkey", label: "", pill: "On one device only", pillIcon: true, remove: false }]]);
  t.same("adding Google, GitHub and an email is offered", await phone.eval(`[...document.querySelectorAll("#account form[data-provider]")].map((f) => !f.hidden).concat([!document.getElementById("email-card").hidden])`), [true, true, true]);
  await layouts(phone, "the account page", "account");
  await readable(phone, "the account page");
  const cardOrder = `[...document.querySelectorAll("#account .ac-card")].filter((c) => !c.hidden).map((c) => ({ title: c.querySelector("h2").textContent, r: c.getBoundingClientRect() }))
    .sort((a, b) => Math.round(a.r.left) - Math.round(b.r.left) || a.r.top - b.r.top).map((c) => c.title)`;
  const orders = [];
  for (const size of SIZES) { await phone.size(size); await phone.rest(); orders.push(await phone.eval(cardOrder)); }
  await phone.size(PHONE);
  // Your picture leads, with the button that opens its sheet (your color is the picture's background, chosen there since 25 Nov); trips are Your trips, under More,
  // not a card here; "What's yours" (v93: the export, over deleting the account) before the last card.
  const ORDER = ["Your picture", "Name", "Ways to sign in", "AI apps", "Email, for getting back in", "Signing out", "What's yours", "Delete your account"];
  t.same("its cards read in one order at 390, 820 and 1440 wide (down the first column, then the second), your picture first, deleting the account last", orders, [ORDER, ORDER, ORDER]);
  // Planted in the page: the picture's card moved to the end of the cards reads as another order (the read can tell).
  const moved = await phone.eval(`(() => { const p = document.getElementById("pic-title").closest(".ac-card"), last = [...document.querySelectorAll("#account .ac-card")].pop();
    const home = p.parentNode, next = p.nextSibling;
    last.after(p); const o = ${cardOrder}; home.insertBefore(p, next); return o; })()`);
  t.ok("  (planted: the picture's card moved last reads as another order, and put back it reads as before)",
    JSON.stringify(moved) !== JSON.stringify(ORDER) && JSON.stringify(await phone.eval(cardOrder)) === JSON.stringify(ORDER), JSON.stringify(moved));
  t.same("  (a site that doesn't offer the plan shows no plan card: GET /api/account/plan answers 404, and the card stays hidden)",
    [await phone.eval(`fetch("/api/account/plan", { credentials: "same-origin" }).then((r) => r.status)`), await phone.eval(`document.getElementById("plan").hidden`)], [404, true]);
  t.same("Delete my account is in the warning color, not the accent a friendly button wears, and carries an icon as well",
    await phone.eval(`(() => { ${COLORS} const b = document.getElementById("btn-delete"), c = getComputedStyle(b).color;
      // The system's warning colour, read where the button is (its tokens live on .ds, not on the body).
      const near = (v) => { const p = document.createElement("i"); p.style.color = v; b.parentElement.append(p); const x = getComputedStyle(p).color; p.remove(); return x; };
      return [c === near("var(--negative)"), c === near("var(--accent)"), !!b.querySelector("svg path")]; })()`),
    [true, false, true]);
  t.same("Add Google and Add GitHub carry their marks too", await phone.eval(MARKS("#account")), ["google img 20 true true true", "github svg 20 true true true"]);
  await phone.size(DESKTOP);
  t.ok("at 1440 wide its cards sit in two columns; at 820 and 390 in one",
    await phone.eval(`(() => { const [a, b] = [...document.querySelectorAll(".ac-col")].map((c) => c.getBoundingClientRect()); return b.left >= a.right && Math.abs(a.top - b.top) < 1; })()`)
    && await (async () => { await phone.size(TABLET); const one = await phone.eval(`(() => { const [a, b] = [...document.querySelectorAll(".ac-col")].map((c) => c.getBoundingClientRect()); return b.top >= a.bottom && Math.abs(a.left - b.left) < 1; })()`); await phone.size(PHONE); return one; })());

  t.part("The account page: the name");
  await phone.type("#name", "");
  await phone.click("#btn-name");
  await mustSay("an empty name is refused beside the field", phone, "msg-name", "err", /Type a name/);
  await phone.type("#name", "Mira C. Check");
  await phone.click("#btn-name");
  await mustSay("a new name is saved, and says so", phone, "msg-name", "ok", /Saved/);
  t.same("  (the server has it)", sql(`SELECT name FROM users WHERE id = '${mira.id}'`)[0].name, "Mira C. Check");
  await layouts(phone, "the account page with a message", "account-saved");

  t.part("The account page: ways to sign in");
  await phone.click("#btn-add-passkey");
  await mustSay("adding a passkey on a device that already has one says so", phone, "msg-ways", "err", /already has a passkey/);
  await phone.click(`#account form[data-provider="github"] button`);
  await throughProvider(phone, "github", { id: 7001, login: "mira-check", name: "Mira Check" });
  await arrive(phone, "/account");
  await accountShown(phone);
  await mustSay("adding GitHub goes there and comes back to the account page, which says it was added (and the address is clean again)", phone, "arrived", "ok", /GitHub added/);
  t.same("GitHub is listed with which account it is, and both ways can now be removed",
    [await waysShown(phone), await phone.eval(`document.getElementById("ways-only").hidden`)],
    [[{ title: "Passkey", label: "", pill: "On one device only", pillIcon: true, remove: true }, { title: "GitHub", label: "@mira-check", pill: "", pillIcon: false, remove: true }], true]);
  await layouts(phone, "the account page with two ways to sign in", "account-ways");

  t.part("A second browser, on a desktop");
  const desk = await open(DESKTOP);
  await desk.goto(`${origin}/login?next=/account`);
  await desk.until(`!document.getElementById("providers").hidden`, "the providers");
  await desk.click(`#p-signin form[data-provider="github"] button`);
  await throughProvider(desk, "github", { id: 7001, login: "mira-check", name: "Mira Check" });
  await arrive(desk, "/account");
  await accountShown(desk);
  t.same("signing in with GitHub there reaches the same account, and goes on to the account page it was headed for",
    [await desk.eval(`document.getElementById("name").value`), sql("SELECT COUNT(*) AS n FROM users")[0].n], ["Mira C. Check", 1]);
  await desk.click("#btn-add-passkey");
  await mustSay("a passkey is added on this device", desk, "msg-ways", "ok", /Passkey added/);
  t.same("  (three ways now, one of them this device's)", [(await waysShown(desk)).map((w) => w.title), (await desk.passkeys()).length], [["Passkey", "Passkey", "GitHub"], 1]);
  await desk.click(`#ways button[aria-label="Remove GitHub @mira-check"]`);
  t.same("Remove asks first: its words change, not only its tint",
    await desk.eval(`(() => { const b = document.querySelector('#ways button[aria-label="Remove GitHub @mira-check"]'); return [b.textContent, b.classList.contains("lg-armed")]; })()`), ["Tap again to remove", true]);
  t.same("  (and nothing is removed yet)", sql("SELECT COUNT(*) AS n FROM identities")[0].n, 1);
  await pressAgain(desk, `#ways button[aria-label="Remove GitHub @mira-check"]`);
  await mustSay("the second press removes it", desk, "msg-ways", "ok", /GitHub removed/);
  t.same("  (it is gone from the list and the server)", [(await waysShown(desk)).map((w) => w.title), sql("SELECT COUNT(*) AS n FROM identities")[0].n], [["Passkey", "Passkey"], 0]);
  await layouts(desk, "the account page on the desktop", "account-desk");

  t.part("The account page: email, for getting back in");
  await phone.goto(`${origin}/account`);
  await accountShown(phone);
  await phone.type("#email", "not an address");
  await phone.click("#btn-email-send");
  await mustSay("something that isn't an address is refused in words", phone, "msg-email", "err", /./);
  let mark = server.logMark();
  await phone.type("#email", "mira@check.example");
  await phone.click("#btn-email-send");
  await mustSay("an address is sent a code, and the page asks for it", phone, "msg-email", "info", /code is on its way/);
  t.same("  (the code field is shown, saying where the code went)", await phone.eval(`[document.getElementById("form-email").hidden, !document.getElementById("form-email-code").hidden, document.getElementById("email-sent-to").textContent]`), [true, true, "mira@check.example"]);
  const codeIn = (mail) => mail?.subject.match(/\b(\d{6})\b/)?.[1] ?? null;
  const emailCode = codeIn(await server.mailTo("mira@check.example", mark));
  await layouts(phone, "the account page asking for a code", "account-code");
  await phone.type("#email-code", emailCode === "000000" ? "000001" : "000000");
  await phone.click("#btn-email-confirm");
  await mustSay("a wrong code says how many tries are left", phone, "msg-email", "err", /4 tries left/);
  await phone.type("#email-code", emailCode ?? "");
  await phone.click("#btn-email-confirm");
  await mustSay("the right code confirms the address", phone, "msg-email", "ok", /Confirmed/);
  t.same("  (it is shown as confirmed, with a tick as well as the word, and the server has it)",
    [await phone.eval(`[!document.getElementById("email-has").hidden, document.getElementById("email-address").textContent, !!document.querySelector("#email-has .ds-tag--positive svg"), document.querySelector("#email-has .ds-tag--positive").textContent]`), sql("SELECT email FROM account_emails")[0]?.email],
    [[true, "mira@check.example", true, "Confirmed"], "mira@check.example"]);
  await layouts(phone, "the account page with an email", "account-email");

  t.part("Signing out, and back in");
  t.same("(planted on the phone: three changes not yet sent, a kept picture, two remembered choices)", await phone.eval(PLANT(2)), true);
  await phone.requests("*/api/auth/logout", "fail");
  await phone.click("#btn-signout");
  await armed(phone, "#btn-signout");
  t.same("with changes not yet sent, Sign out asks first and says how many", await phone.eval(`document.getElementById("btn-signout").textContent`), "3 changes haven't been sent. Tap again to sign out");
  t.same("  (the longer words fit the button: nothing cut off, nothing off the side)",
    await phone.eval(`(() => { const b = document.querySelector('#btn-signout'); const r = b.getBoundingClientRect(); return [b.scrollWidth <= b.clientWidth + 1, r.left >= 0 && r.right <= innerWidth]; })()`), [true, true]);
  if (shots) await phone.shot(path.join(shots, "account-signout-waiting-390-light.png"));
  await pressAgain(phone, "#btn-signout");
  await mustSay("a sign-out that doesn't reach the server says so", phone, "msg-out", "err", /No connection/);
  t.same("  (and clears nothing: still on the account page, all of it still on the phone)", [await phone.where(), await phone.eval(HELD)], ["/account", kept(2, false)]);
  await phone.requests("*/api/auth/logout", "off");
  await pressAgain(phone, "#btn-signout");
  await arrive(phone, "/login");
  t.same("once the server has signed it out, the phone keeps nothing of the person: no stored changes, no kept picture, no remembered choice of theirs; the phone's own theme stays",
    await phone.eval(HELD), CLEARED);
  await signinDrawn(phone);
  t.same("Sign out ends up on the sign-in screen", await panels(phone), ["signin"]);
  await phone.goto(`${origin}/account`);
  await arrive(phone, "/login?next=/account");
  await signinDrawn(phone);
  await phone.click("#btn-signin");
  await arrive(phone, "/account");
  await accountShown(phone);
  t.same("the passkey on the phone signs the same account in again, with nothing typed", await phone.eval(`document.getElementById("name").value`), "Mira C. Check");
  await phone.slow(300);
  await phone.goto(`${origin}/login?next=/account`);
  await phone.until(`!document.getElementById("p-account").hidden`, "the already-signed-in screen");
  await phone.rest();
  const flashed = await phone.eval("window.__moved");
  await phone.slow(0);
  t.ok("on a slow connection it never draws the sign-in screen first: the page waits until it knows who is asking", flashed.title.length === 0 && flashed.button.length === 0 && flashed.others.length === 0 && flashed.shifts < 0.001, flashed);
  t.same("the sign-in page, opened while signed in, says who is signed in instead of asking again", [await panels(phone), await phone.eval(`document.getElementById("account-name").textContent`)], [["account"], "Mira C. Check"]);
  await layouts(phone, "the already-signed-in screen", "signin-already");
  await phone.click("#btn-continue");
  await arrive(phone, "/account");
  t.same("Continue goes on to where the address says it was headed", await phone.where(), "/account");
  await accountShown(phone);

  await desk.click("#btn-signout-all");
  await armed(desk, "#btn-signout-all");
  t.same("Sign out everywhere asks first, in words (nothing is waiting on this one)", await desk.eval(`document.getElementById("btn-signout-all").textContent`), "Tap again to sign out everywhere");
  // This browser refuses to store anything, as a full or locked-down one can.
  await desk.eval(`(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === "wgp.epoch") throw new DOMException("refused", "QuotaExceededError"); return set.call(this, k, v); }; return true; })()`);
  await pressAgain(desk, "#btn-signout-all");
  await arrive(desk, "/login?done=uncleared&kept=localStorage");
  await mustSay("a phone that couldn't be fully cleared is told so on the sign-in page, with what may be left and how to remove it", desk, "msg", "err",
    /^You're signed out, but this phone couldn't be fully cleared: remembered choices may still be on it\. Clearing this site's data in the browser's settings removes what's left\.$/);
  t.same("then signs out this browser", sql("SELECT COUNT(*) AS n FROM sessions")[0].n, 0);
  await phone.type("#name", "Mira Check");
  await phone.click("#btn-name");
  await arrive(phone, "/login?next=/account&error=signed-out");
  await signinDrawn(phone);
  await mustSay("and the other one: its open account page, at the next thing it tries, goes to sign in and says why", phone, "msg", "err", /isn't signed in any more/);

  t.part("Getting back in by email");
  // Under "Trouble signing in?", opened first, as a person opens it.
  await phone.click("#trouble > summary");
  await phone.click("#btn-recover");
  t.same("the way back by email has a screen of its own", await panels(phone), ["recover"]);
  mark = server.logMark();
  await phone.type("#recover-email", "mira@check.example");
  await phone.click("#btn-recover-send");
  await mustSay("asking says the same thing whether or not the address is known", phone, "msg", "info", /If that address is on an account/);
  await layouts(phone, "the get-back-in screen asking for a code", "recover");
  await phone.type("#recover-code", codeIn(await server.mailTo("mira@check.example", mark)) ?? "");
  await phone.click("#btn-recover-code");
  await arrive(phone, "/account");
  await accountShown(phone);
  await mustSay("the code signs the account in and the account page says to add a passkey", phone, "arrived", "ok", /You're back in/);

  // ── someone new, arriving by Google ─────────────────────────────────────────────────────
  t.part("Someone new, arriving with Google on a tablet");
  const tablet = await open(TABLET);
  await tablet.goto(`${origin}/login?next=/account`);
  await tablet.until(`!document.getElementById("providers").hidden`, "the providers");
  await tablet.click(`#p-signin form[data-provider="google"] button`);
  await throughProvider(tablet, "google", { sub: "9001", name: "Noor Check" });
  await arrive(tablet, "/login/new");
  await tablet.until(`document.getElementById("new-name").value`, "the name from Google");
  t.same("a Google account nobody here uses makes nothing: it asks, with the name filled in, and offers GitHub (not Google) to reach an account you have",
    [await panels(tablet), await tablet.eval(`[document.getElementById("new-name").value, document.getElementById("new-what").textContent]`),
      await tablet.eval(`[...document.querySelectorAll("#p-new form[data-provider]")].map((f) => f.dataset.provider + ":" + !f.hidden)`), sql("SELECT COUNT(*) AS n FROM users")[0].n],
    [["new"], ["Noor Check", "Nobody here signs in with that Google account yet."], ["google:false", "github:true"], 1]);
  await layouts(tablet, "the one-more-step screen", "new");
  await tablet.click("#btn-new");
  await arrive(tablet, "/account");
  await accountShown(tablet);
  const noor = sql("SELECT id FROM users WHERE name = 'Noor Check'")[0];
  t.same("Create an account makes it, with Google as its one way in", [!!noor, await waysShown(tablet)], [true, [{ title: "Google", label: "Noor Check", pill: "", pillIcon: false, remove: false }]]);

  t.part("A one-use link from the operator");
  const link = makeLink({ who: noor.id, origin, hours: 1 });
  sql(link.sql);
  const fresh = await open(PHONE);
  await fresh.goto(link.url);
  t.same("opening the link shows its own screen and uses nothing", [await panels(fresh), sql("SELECT COUNT(*) AS n FROM signin_links")[0].n, sql(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = '${noor.id}'`)[0].n], [["link"], 1, 1]);
  await layouts(fresh, "the one-use link screen", "link");
  await fresh.eval(`(() => { const d = document.querySelector(".tr-linkset"); if (d) d.open = true; return 1; })()`);   // Make a link is under Link settings
  await fresh.click("#btn-link");
  await arrive(fresh, "/account");
  await accountShown(fresh);
  await mustSay("its button signs that account in, once, and the account page says to add a passkey", fresh, "arrived", "ok", /signed in with the link/);
  t.same("  (it is that account)", await fresh.eval(`document.getElementById("name").value`), "Noor Check");
  const again = await open(PHONE);
  await again.goto(link.url);
  await again.eval(`(() => { const d = document.querySelector(".tr-linkset"); if (d) d.open = true; return 1; })()`);   // Make a link is under Link settings
  await again.click("#btn-link");
  await mustSay("the same link a second time says it was used", again, "msg", "err", /already used, or it ran out/);

  // ── trips: the account page's list, and the page a join link opens ──────────────────────
  t.part("The account page: trips");
  const LONG = "Wanderwegweiser".repeat(6).slice(0, TRIP_NAME_MAX);     // the longest name a trip can have, with nowhere to break it
  const lisbon = await ask(phone, "POST", "/api/trips", { name: "Lisbon in spring", starts_on: "2031-05-01", ends_on: "2031-05-09", default_tz: "Europe/Lisbon" });
  const longTrip = await ask(phone, "POST", "/api/trips", { name: LONG, default_tz: "Europe/Lisbon" });
  if (lisbon.status !== 201 || longTrip.status !== 201) throw new CheckError(`couldn't make the trips this part needs: ${lisbon.status} ${JSON.stringify(lisbon.json)}, ${longTrip.status} ${JSON.stringify(longTrip.json)}`);
  const tripId = lisbon.json.trip.id;
  const invite = (await ask(phone, "POST", `/api/trips/${tripId}/links`, {})).json?.link;
  const longInvite = (await ask(phone, "POST", `/api/trips/${longTrip.json.trip.id}/links`, {})).json?.link;
  if (!invite?.code || !longInvite?.code) throw new CheckError("couldn't make the links this part needs");
  const onTrip = (id, who) => sql(`SELECT COUNT(*) AS n FROM trip_members WHERE trip_id = '${id}' AND left_at IS NULL${who ? ` AND user_id = '${who}'` : ""}`)[0].n;
  const uses = (link) => sql(`SELECT uses FROM trip_links WHERE id = '${link.id}'`)[0].uses;
  const inMay = (words) => /May/.test(words) && /\b1\b\D+\b9\b/.test(words) && /2031/.test(words);

  await phone.goto(`${origin}/account`);
  await accountShown(phone);
  let listed = await tripsShown(phone);
  const row = (name) => listed.find((r) => r.name === name) ?? {};
  t.ok("an account that hosts two trips sees each on Your trips by name, with its dates (or that they aren't set) and that nobody else is on it",
    listed.length === 2 && inMay(row("Lisbon in spring").meta ?? "") && / · only you on it$/.test(row("Lisbon in spring").meta) && row(LONG).meta === "Dates not set yet · only you on it", listed);
  t.same("that it hosts them is said in words with a flag beside them, not by a tint", listed.map((r) => [r.pill, r.pillIcon]), [["You host it", true], ["You host it", true]]);
  await layouts(phone, "the account page of an account on two trips", "account-trips");
  await readable(phone, "the account page of an account on two trips");

  t.part("Connecting an AI app, and the account's list of them");
  {
    // How to connect one is the one sheet (js/plan-ai.js), opened from the card's one button; the card holds the
    // apps connected and nothing about connecting one (25 Nov: it repeated the trip's sheet in its own words).
    const card = () => phone.eval(`JSON.stringify({ word: document.getElementById("apps-connect").textContent.trim(),
      rows: document.querySelectorAll("#apps .ac-way").length,
      howto: !!document.querySelector("#ai-apps code, #ai-apps [data-copy], #ai-apps .ac-asks") })`).then(JSON.parse);
    const none = await card();
    t.same("with none, the card says what an app does, and holds one Connect your AI button and nothing of how to connect one",
      [none.word, none.rows, none.howto], ["Connect your AI", 0, false]);
    await phone.click("#apps-connect");
    await phone.until(`!!document.querySelector(".sh-root .pa-sheet")`, "the Connect your AI sheet", 8000);
    const sheet = await phone.eval(`JSON.stringify({ title: (document.querySelector(".sh-root .sh-title") || {}).textContent || "",
      url: (document.querySelector(".sh-root .pa-step1 code") || {}).textContent || "", ask: (document.querySelector(".sh-root .pa-ask-pre") || {}).textContent || "" })`).then(JSON.parse);
    t.same("it opens the one Connect your AI sheet: the site's address, and an ask for no trip in particular",
      [sheet.title, sheet.url, /^In WeGoPlace, read my trips, then plan the next one: /.test(sheet.ask)], ["Connect your AI", `${origin}/mcp`, true]);
    // Copy, with the page allowed the clipboard as a person's tap allows it: Claude Code's line, from its tab.
    await phone.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin, browserContextId: phone.context }).catch(() => {});
    await phone.click('.sh-root [data-pa-pick="code"]');
    await phone.click('.sh-root [data-pa-copy="cmd"]');
    await phone.until(`document.querySelector('.sh-root [data-pa-copy="cmd"]').textContent !== "Copy"`, "the button to say it copied", 5000).catch(() => {});
    const copied = await phone.eval(`(async () => [document.querySelector('.sh-root [data-pa-copy="cmd"]').textContent, await navigator.clipboard.readText().catch((e) => "read: " + e.message)])()`);
    t.same("Copy in it puts Claude Code's line on the clipboard, and says so", copied, ["Copied", `claude mcp add --transport http wegoplace ${origin}/mcp`]);
    await phone.eval(`(document.querySelector(".sh-scrim") && document.querySelector(".sh-scrim").click(), 1)`);
    await phone.until(`!document.querySelector(".sh-root")`, "the sheet closed", 5000).catch(() => {});
    await layouts(phone, "the account page with no app connected", "account-connect", { sizes: [NARROW, PHONE, DESKTOP] });
    await readable(phone, "the account page with no app connected");
    // From a trip's empty itinerary: /account#ai-apps lands on the card.
    await phone.goto(`${origin}/account#ai-apps`);
    await accountShown(phone);
    await new Promise((r) => setTimeout(r, 400));
    t.ok("/account#ai-apps lands on the card, not the top of the page", await phone.eval(`(() => { const r = document.getElementById("ai-apps").getBoundingClientRect(); return r.top >= -2 && r.top < innerHeight / 3 && scrollY > 0; })()`),
      await phone.eval(`JSON.stringify([document.getElementById("ai-apps").getBoundingClientRect().top, scrollY, innerHeight])`));
    const reg = await register(origin, { name: "Check Assistant", address: "10.7.0.1" });
    if (reg.status !== 201) throw new CheckError(`couldn't register an app: ${reg.status}`);
    const q = new URLSearchParams({ response_type: "code", client_id: reg.json.client_id, redirect_uri: "http://127.0.0.1:9/callback", scope: "trips:read trips:write",
      state: "s", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", resource: `${origin}/mcp` });
    await phone.goto(`${origin}/authorize?${q}`);
    await phone.until(`!!document.querySelector("form[action='/authorize']")`, "the approval page");
    const words = await phone.eval(`document.querySelector("main").innerText`);
    t.ok("the approval page names the app, says in bold that it reaches every trip, what it may do, and who is signed in",
      /Check Assistant wants to use your WeGoPlace account/.test(words) && /It reaches every trip you're on/.test(words) && /See your trips/.test(words) && /Change them/.test(words) && /Mira C\. Check/.test(words)
        && await phone.eval(`getComputedStyle(document.querySelector(".lead strong")).fontWeight >= 600`), words.slice(0, 500));
    t.same("the wordmark heads it, inlined as on the sign-in pages (it takes the theme's colors)",
      await phone.eval(`[!!document.querySelector(".lg-brand svg"), document.querySelector(".lg-brand")?.getAttribute("aria-label")]`), [true, "We Go Place"]);
    t.same("Allow is the page's main button, Cancel beside it plain, before it in the page as on the screen", await phone.eval(`[...document.querySelectorAll("form button")].map((b) => [b.textContent, b.classList.contains("ds-button--white")])`), [["Cancel", false], ["Allow", true]]);
    await layouts(phone, "the page that approves an app", "authorize");
    await readable(phone, "the page that approves an app");
    // Allow, as the form sends it (the app's address on this machine answers nothing, so the
    // browser isn't sent there). The page is opened again first: looking at it at each size
    // loaded it again, and each load binds a new form to this browser.
    await phone.goto(`${origin}/authorize?${q}`);
    await phone.until(`!!document.querySelector("form[action='/authorize']")`, "the approval page");
    const allowed = await phone.eval(`(async () => { const f = new FormData(document.querySelector("form[action='/authorize']")); f.set("decision", "approve");
      const r = await fetch("/authorize", { method: "POST", body: new URLSearchParams(f), redirect: "manual" });
      return r.type === "opaqueredirect" ? r.type : r.status + " " + (await r.text()).replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ").slice(0, 300); })()`);
    t.same("  (Allow answers the app with a redirect)", allowed, "opaqueredirect");
    await phone.goto(`${origin}/account`);
    await accountShown(phone);
    const apps = await phone.eval(`[...document.querySelectorAll("#apps .ac-way")].map((r) => [r.querySelector(".ac-way-label").textContent, r.querySelector(".meta").textContent, r.querySelector("button").textContent, !!r.querySelector("svg.ac-ico")])`);
    t.ok("the account page lists it: its name, what it may do, since when, with Disconnect", apps.length === 1 && apps[0][0] === "Check Assistant" && /^Can see and change your trips · connected /.test(apps[0][1]) && /20\d\d/.test(apps[0][1]) && apps[0][2] === "Disconnect" && apps[0][3], apps);
    const one = await card();
    t.same("with one connected, the button says Connect another AI", [one.word, one.rows], ["Connect another AI", 1]);
    await layouts(phone, "the account page with an app connected", "account-apps", { sizes: [NARROW, PHONE, DESKTOP] });
    await phone.click("#apps .ac-way button");
    await armed(phone, "#apps .ac-way button");
    t.same("Disconnect asks again first", sql("SELECT COUNT(*) AS n FROM revoked_grants")[0].n, 0);
    await pressAgain(phone, "#apps .ac-way button");
    await mustSay("pressed again, it disconnects, and says so", phone, "msg-apps", "ok", /Check Assistant is disconnected/);
    t.same("  (the list is empty again, and the marker that keeps it disconnected is written)", [await phone.eval(`document.querySelectorAll("#apps .ac-way").length`), sql("SELECT COUNT(*) AS n FROM revoked_grants")[0].n], [0, 1]);
  }

  t.part("The page a join link opens, to someone signed out");
  const joinAt = `/join/${invite.code}`;
  const signInToJoin = `/login?next=${encodeURIComponent(joinAt)}`;
  for (const size of [PHONE, TABLET]) {
    const slowly = await open(size);
    await slowly.slow(300);
    await slowly.goto(`${origin}${joinAt}`);
    await joinDrawn(slowly);
    await slowly.rest();
    const moved = await slowly.eval("window.__moved");
    t.ok(`at ${size.width} wide, on a slow connection, the page appears once: nothing on it is seen in one place and then another`,
      moved.tracked >= 6 && moved.others.length === 0 && moved.shifts < 0.001, moved);
    await slowly.close();
  }
  const guest = await open(PHONE);
  await guest.goto(`${origin}${joinAt}`);
  t.same("a link that works shows the trip's screen and no other", await joinDrawn(guest), ["trip"]);
  t.same("it says what the link is for: the trip's name and who hosts it, and the name is in the tab's title",
    await guest.eval(`[document.getElementById("trip-name").textContent, document.getElementById("trip-host").textContent, document.title]`),
    ["Lisbon in spring", "Hosted by Mira C. Check", "Join Lisbon in spring · WeGoPlace"]);
  t.ok("and its dates", inMay(await guest.eval(`document.getElementById("trip-when").textContent`)), await guest.eval(`document.getElementById("trip-when").textContent`));
  t.same("signed out, it asks only a name to join, with Sign in under it, which goes to the sign-in page with this link to come back to",
    await guest.eval(`[!document.getElementById("as-visitor").hidden, document.getElementById("as-account").hidden, document.getElementById("go-signin").getAttribute("href")]`), [true, true, signInToJoin]);
  t.ok("the wordmark is drawn", await guest.until(`document.querySelector("#brand svg") && document.querySelector("#brand svg").getBoundingClientRect().width > 60`, "the wordmark"));
  await layouts(guest, "the join page, signed out", "join-visitor");
  await readable(guest, "the join page");

  t.part("The join link: making an account from it, and joining");
  await guest.click("#go-signin");
  await arrive(guest, signInToJoin);
  await signinDrawn(guest);
  await makeAccount(guest, "Pia Check");
  await arrive(guest, joinAt);
  await joinDrawn(guest);
  const pia = sql("SELECT id FROM users WHERE name = 'Pia Check'")[0];
  t.same("an account made from there comes back to the link's page, which now says who is signed in and offers to join; nobody has joined yet",
    [await guest.eval(`[document.getElementById("me-name").textContent, document.getElementById("as-visitor").hidden, !document.getElementById("as-account").hidden, document.getElementById("btn-join").textContent.trim()]`), onTrip(tripId), uses(invite)],
    [["Pia Check", true, true, "Join this trip"], 1, 0]);
  await layouts(guest, "the join page, signed in", "join-account");

  // The most people a trip holds. The others are made by hand: that many sign-ups would prove nothing more.
  const fill = TRIP_MEMBERS_MAX - onTrip(tripId);
  const nowSeconds = Math.floor(Date.now() / 1000);
  sql([
    ...Array.from({ length: fill }, (_, i) => `INSERT INTO users (id, name, created_at) VALUES ('fill-${i}', 'Filler ${i}', ${nowSeconds})`),
    ...Array.from({ length: fill }, (_, i) => `INSERT INTO trip_members (trip_id, user_id, joined_at) VALUES ('${tripId}', 'fill-${i}', ${nowSeconds})`),
  ].join("; "));
  await guest.click("#btn-join");
  await mustSay(`a trip that already has ${TRIP_MEMBERS_MAX} people on it says so in words, with the number`, guest, "msg", "err", new RegExp(`as many people on it as a trip can hold \\(${TRIP_MEMBERS_MAX}\\)\\. Someone has to leave it before you can join\\.`));
  t.same("  (nobody joined, the link wasn't used, and the button is ready to press again)",
    [onTrip(tripId, pia.id), uses(invite), await guest.eval(`(() => { const b = document.getElementById("btn-join"); return [b.textContent.trim(), b.disabled]; })()`)], [0, 0, ["Join this trip", false]]);
  await layouts(guest, "the join page saying the trip is full", "join-full");
  sql(`DELETE FROM trip_members WHERE trip_id = '${tripId}' AND user_id LIKE 'fill-%'; DELETE FROM users WHERE id LIKE 'fill-%'`);

  await guest.click("#btn-join");
  await arrive(guest, `/t/${tripId}/`);
  t.same("with room on the trip, Join this trip puts the account on it, uses the link once, and goes into the app at that trip", [onTrip(tripId, pia.id), onTrip(tripId), uses(invite)], [1, 2, 1]);
  await guest.goto(`${origin}/account`);
  await accountShown(guest);
  listed = await tripsShown(guest);
  t.ok("the new member's Your trips lists the trip, with two people on it and no word that they host it",
    listed.length === 1 && listed[0].name === "Lisbon in spring" && listed[0].pill === "" && / · 2 people on it$/.test(listed[0].meta), listed);
  await guest.goto(`${origin}${joinAt}`);
  await joinDrawn(guest);
  await guest.click("#btn-join");
  await arrive(guest, `/t/${tripId}/`);
  t.same("opening the link again when already on the trip goes into the app at that trip too, and costs the link nothing", [onTrip(tripId), uses(invite)], [2, 1]);

  t.part("The join page for a trip with the longest name a trip can have, and no dates");
  await guest.goto(`${origin}/join/${longInvite.code}`);
  t.same("it shows", [await joinDrawn(guest), await guest.eval(`[document.getElementById("trip-name").textContent, document.getElementById("trip-when").textContent]`)], [["trip"], [LONG, "Dates not set yet"]]);
  await layouts(guest, `the join page with a name of ${TRIP_NAME_MAX} letters and no spaces`, "join-long-name");

  t.part("The join link, opened by someone signed in as the wrong account");
  await desk.goto(`${origin}${joinAt}`);
  await joinDrawn(desk);
  await desk.click("#go-signin");
  await arrive(desk, signInToJoin);
  await signinDrawn(desk);
  await desk.click("#btn-signin");
  await arrive(desk, joinAt);
  await joinDrawn(desk);
  const sessionsOf = (id) => sql(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = '${id}'`)[0].n;
  const hadSessions = sessionsOf(mira.id);
  t.same("signing in with a passkey from the link comes back to it, and it says whose account this is", await desk.eval(`document.getElementById("me-name").textContent`), "Mira C. Check");
  await desk.click("#btn-other");
  await arrive(desk, signInToJoin);
  await signinDrawn(desk);
  t.same("Use a different account signs this browser out and goes to sign in, with the link still to come back to", [await panels(desk), hadSessions - sessionsOf(mira.id)], [["signin"], 1]);

  t.part("A join link that can't be asked about, or whose page didn't load");
  const down = await open(PHONE);
  await down.requests("*/api/join/*", "fail");
  await down.goto(`${origin}${joinAt}`);
  t.same("when the server can't be reached the page says it couldn't check the link, in words, with a way to try again: it doesn't call the link dead",
    [await joinDrawn(down), await down.eval(`(() => { const p = document.getElementById("p-failed"); return [p.querySelector("h1").textContent, p.querySelector("#failed-text").textContent.length > 20, p.querySelector("a").textContent]; })()`)],
    [["failed"], ["Couldn't check this link", true, "Try again"]]);
  await layouts(down, "the join page that couldn't reach the server", "join-unreachable");
  await down.requests("*/api/join/*", "off");
  await down.click("#p-failed a");
  await down.until(`!document.getElementById("p-trip").hidden`, "the trip, once the server answers");
  t.same("Try again asks again, and with the server back it is the trip's screen", await joinDrawn(down), ["trip"]);
  await down.close();

  const lost = await open(PHONE);
  await lost.requests("*/js/join.js", "fail");
  await lost.goto(`${origin}${joinAt}`);
  const unloaded = await lost.eval(`(() => {
    const note = document.getElementById("no-script"), seen = (el) => el.checkVisibility({ visibilityProperty: true });
    return { held: document.getElementById("page").hasAttribute("data-wait"), words: seen(note) ? note.querySelector("p").textContent.trim() : "", again: seen(note.querySelector("a")) ? note.querySelector("a").textContent.trim() : "",
      dead: [...document.querySelectorAll("#page button")].filter(seen).length };
  })()`);
  t.ok("when the page's script can't be fetched, it says so in words at once, offers to try again, and shows no button that can't work",
    /didn't finish loading/.test(unloaded.words) && unloaded.again === "Try again" && unloaded.dead === 0 && !unloaded.held, unloaded);
  await layouts(lost, "the join page whose script couldn't be fetched", "join-failed");
  await lost.close();

  t.part("A join link that doesn't work");
  await guest.goto(`${origin}/join/${longInvite.code}`);
  await joinDrawn(guest);
  const off = [await ask(phone, "DELETE", `/api/trips/${tripId}/links/${invite.id}`), await ask(phone, "DELETE", `/api/trips/${longTrip.json.trip.id}/links/${longInvite.id}`)];
  t.same("  (the host turns both links off)", off.map((r) => [r.status, r.json?.revoked]), [[200, true], [200, true]]);
  await guest.click("#btn-join");
  await guest.until(`!document.getElementById("p-gone").hidden`, "the page to say the link doesn't work");
  t.same("a link turned off while its page was open: Join this trip says the link doesn't work, and joins nobody", [await guest.eval(GONE), onTrip(longTrip.json.trip.id)], [GONE_WORDS, 1]);
  const dead = [];
  for (const address of [joinAt, `/join/${made().slice(0, 22)}`, "/join/not-a-code"]) {
    await desk.goto(`${origin}${address}`);
    await joinDrawn(desk);
    dead.push(await desk.eval(GONE));
  }
  t.same("a link the host turned off, a code that never existed and something that isn't a code all get one screen, in the same words", dead, [GONE_WORDS, GONE_WORDS, GONE_WORDS]);
  await layouts(desk, "the screen for a link that doesn't work", "join-gone");
  await readable(desk, "the screen for a link that doesn't work");

  t.part("Deleting an account that hosts a trip other people are on");
  await phone.goto(`${origin}/account`);
  await accountShown(phone);
  listed = await tripsShown(phone);
  t.ok("the host's Your trips now says two people are on the trip", / · 2 people on it$/.test(row("Lisbon in spring").meta ?? ""), listed);
  // Before anyone presses: the reason in a box naming the trip, and Delete off with that box as its reason (Your account
  // opened again, now that someone else is on the trip).
  await phone.goto(`${origin}/account`);
  await accountShown(phone);
  const hostBox = await phone.eval(`(() => { const box = document.getElementById("delete-host"), b = document.getElementById("btn-delete");
    return { shown: !box.hidden, words: box.textContent.replace(/\\s+/g, " ").trim(), off: b.disabled, why: b.getAttribute("aria-describedby") }; })()`);
  t.same("before anyone presses, the page says why it can't be deleted yet, naming the trip, and Delete is off with that as its reason",
    hostBox, { shown: true, words: "You host “Lisbon in spring”, and other people are on it. Offer it to one of them, or delete the trip, first.", off: true, why: "delete-host" });
  // The server still refuses it on its own (a page that didn't know would be told).
  const refused = await phone.eval(`fetch("/api/me", { method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "delete" }) }).then(async (r) => [r.status, (await r.json()).error])`);
  t.same("  (and the server refuses it on its own: 409, host)", refused, [409, "host"]);
  t.same("  (the account is still there and still signed in, and so are its trips)",
    [sql(`SELECT deleted_at FROM users WHERE id = '${mira.id}'`)[0].deleted_at, sessionsOf(mira.id) > 0, sql(`SELECT COUNT(*) AS n FROM trips WHERE host_id = '${mira.id}'`)[0].n, await phone.where()], [null, true, 2, "/account"]);
  await layouts(phone, "the account page refusing to delete a host's account", "account-host");

  t.part("Deleting an account");
  t.same("(planted on the tablet: one change not yet sent, a kept picture, two remembered choices)", await tablet.eval(PLANT(0)), true);
  await tablet.click("#btn-delete");
  await armed(tablet, "#btn-delete");
  t.same("Delete asks first, in words, saying what hasn't been sent", [await tablet.eval(`document.getElementById("btn-delete").textContent.trim()`), sql(`SELECT deleted_at FROM users WHERE id = '${noor.id}'`)[0].deleted_at], ["1 change hasn't been sent. Tap again to delete your account for good", null]);
  t.same("  (the longer words fit the button: nothing cut off, nothing off the side)",
    await tablet.eval(`(() => { const b = document.querySelector('#btn-delete'); const r = b.getBoundingClientRect(); return [b.scrollWidth <= b.clientWidth + 1, r.left >= 0 && r.right <= innerWidth]; })()`), [true, true]);
  if (shots) await tablet.shot(path.join(shots, "account-delete-waiting-820-light.png"));
  t.same("  (asking, the button fills with the warning color and keeps its icon)",
    await whileAsking(tablet, "#btn-delete", async () => {
      await tablet.rest();
      const look = await tablet.eval(`(() => { const b = document.getElementById("btn-delete"), cs = getComputedStyle(b);
        const near = (v) => { const p = document.createElement("i"); p.style.color = v; b.parentElement.append(p); const x = getComputedStyle(p).color; p.remove(); return x; };
        return [cs.backgroundColor === near("var(--negative)"), cs.color === near("var(--on-solid)"), !!b.querySelector("svg path")]; })()`);
      if (shots) await tablet.shot(path.join(shots, "account-delete-asking-820-light.png"));
      return look;
    }),
    [true, true, true]);
  await pressAgain(tablet, "#btn-delete");
  await arrive(tablet, "/login?done=deleted");
  await mustSay("the second press deletes it and says so on the sign-in page", tablet, "msg", "ok", /Your account is deleted/);
  t.same("  (it can't sign in any more: no ways in, no sessions)",
    [sql(`SELECT deleted_at IS NOT NULL AS gone FROM users WHERE id = '${noor.id}'`)[0].gone, sql(`SELECT COUNT(*) AS n FROM identities WHERE user_id = '${noor.id}'`)[0].n, sql(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = '${noor.id}'`)[0].n], [1, 0, 0]);
  await fresh.goto(`${origin}/account`);
  await arrive(fresh, "/login?next=/account");
  t.same("its other browser is signed out too", await fresh.where(), "/login?next=/account");
  t.same("the deleting browser keeps nothing of the person", await tablet.eval(HELD), CLEARED);

  t.part("Signing out from the sign-in page");
  await phone.goto(`${origin}/login`);
  await phone.until(`!document.getElementById("p-account").hidden`, "the already-signed-in screen");
  t.same("(planted on the phone again: two changes not yet sent, a kept picture, two remembered choices)", await phone.eval(PLANT(1)), true);
  await phone.requests("*/api/auth/logout", "fail");
  await phone.click("#btn-signout");
  await armed(phone, "#btn-signout");
  t.same("it asks first and says how many changes haven't been sent", await phone.eval(`document.getElementById("btn-signout").textContent`), "2 changes haven't been sent. Tap again to sign out");
  t.same("  (the longer words fit the button: nothing cut off, nothing off the side)",
    await phone.eval(`(() => { const b = document.querySelector('#btn-signout'); const r = b.getBoundingClientRect(); return [b.scrollWidth <= b.clientWidth + 1, r.left >= 0 && r.right <= innerWidth]; })()`), [true, true]);
  if (shots) await phone.shot(path.join(shots, "signin-signout-waiting-390-light.png"));
  await pressAgain(phone, "#btn-signout");
  await mustSay("a sign-out that doesn't reach the server says so", phone, "msg", "err", /No connection/);
  t.same("  (and clears nothing: still signed in here, all of it still on the phone)", [await panels(phone), await phone.eval(HELD)], [["account"], kept(1, true)]);
  await phone.requests("*/api/auth/logout", "off");
  await pressAgain(phone, "#btn-signout");
  await mustSay("once it reaches the server it says Signed out", phone, "msg", "info", /^Signed out\.$/);
  t.same("  (the sign-in screen, no note of who is signed in, and the phone keeps nothing of the person)",
    [await panels(phone), await phone.eval(`document.cookie.includes("wgp_who=")`), await phone.eval(HELD)], [["signin"], false, CLEARED]);

  // ── a browser that can't hold passkeys, and a site that has paused new accounts ─────────
  t.part("Where passkeys can't work");
  const old = await open({ ...PHONE, passkeys: false, before: "delete window.PublicKeyCredential;" });
  await old.goto(`${origin}/login`);
  await old.until(`!document.getElementById("providers").hidden`, "the providers");
  t.same("the page says why, switches the passkey buttons off, and still offers Google and GitHub",
    [await old.eval(`[!document.getElementById("unsupported").hidden, document.getElementById("unsupported-text").textContent.length > 20, !!document.querySelector("#unsupported svg")]`),
      await old.eval(`["btn-signin", "btn-join"].map((id) => document.getElementById(id).disabled)`),
      await old.eval(`[...document.querySelectorAll("#p-signin form[data-provider] button")].map((b) => b.disabled)`)],
    [[true, true, true], [true, true], [false, false]]);
  await layouts(old, "the sign-in screen where passkeys can't work", "signin-unsupported");

  t.part("With new accounts paused");
  await server.halt();
  await server.start({ vars: { ...settings.vars, SIGNUPS: "paused" } });
  const late = await open(PHONE);
  await late.goto(`${origin}/login`);
  await late.until(`!document.getElementById("paused").hidden`, "the paused notice");
  t.same("the sign-in screen says so, with an icon, and has no form for a new account; signing in is still there",
    await late.eval(`[!!document.querySelector("#paused svg"), document.getElementById("form-join").hidden, !document.getElementById("btn-signin").hidden && !document.getElementById("btn-signin").disabled]`), [true, true, true]);
  await layouts(late, "the sign-in screen with new accounts paused", "signin-paused");
  await openMaking(late);
  t.same("  a passkey sign-in back without one offers Try again only: no line asking to make an account, no name field",
    await late.eval(`[document.getElementById("make-what").checkVisibility(), document.getElementById("join-name").checkVisibility(), document.getElementById("btn-signin-again").checkVisibility()]`), [false, false, true]);
  await late.click(`#p-signin form[data-provider="google"] button`);
  await throughProvider(late, "google", { sub: "9002", name: "Omar Check" });
  await arrive(late, "/login?error=paused&with=google");
  await mustSay("a Google account nobody here uses is told new accounts are paused, and nothing is made", late, "msg", "err", /new accounts are paused/);
  t.same("  (still the two accounts that can sign in)", sql("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL")[0].n, 2);

  // ── nothing went wrong underneath ───────────────────────────────────────────────────────
  t.part("Underneath");
  const errors = everyPage.flatMap((p) => p.errors);
  t.ok("no page threw an error or logged one", errors.length === 0, errors.slice(0, 8).join("\n        "));
  const log = server.log();
  const failed = log.split("\n").filter((line) => /Uncaught|✘|\[ERROR\]|\b500\b/.test(line) && !/signin_error/.test(line));
  t.ok("nothing failed inside the server", failed.length === 0, failed.slice(0, 8).join("\n        "));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  if (keep && server) console.log(`kept: ${server.work}`);
  await chrome?.close().catch((e) => console.error(e.message));
  await server?.stop();
  await standin?.stop();
}
process.exit(code);

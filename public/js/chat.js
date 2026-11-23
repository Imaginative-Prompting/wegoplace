// chat.js — the trip's group chat (model §17; the server's side is docs/API.md, "The chat").
//
// A section of its own (#/chat), reachable from Other as Pack is. What it shows:
//   - the trip's messages, oldest at the top and newest at the bottom, paging back as you scroll
//     up; who wrote each (their avatar: drawn picture or initials in their personal colour) and when,
//     with the day between days;
//   - a message about an event, a place or a purchase carries that thing as a small card over
//     its words, and the card opens it; a thing since deleted keeps the name it had, unlinked;
//   - sending works without signal: a message waits on this phone, shows as waiting, and takes
//     the server's order (its seq) when it lands. A message the server refuses for good says why,
//     with Try again and Remove;
//   - your own messages can be changed and deleted, the trip's host can delete anyone's, and a
//     deleted one leaves "Message deleted" in its place; a changed one says "edited";
//   - new messages arrive by the trip's socket (live.js, "chat"), or by asking every 20 s while
//     the screen is open and there is no socket.
//
// chatAbout(kind, id) opens the chat with that thing held above the box: the next message sent
// is about it ("replying about the event").
//
// THE ASSISTANT (model §20), only where the site offers it (assistant-room.js): the tabs Group and
// Assistant at the top (the person's own conversations are assistant.js); "@assistant" anywhere in a
// message asks it, and its answer comes into the chat as a message of its own kind, "Assistant ·
// asked by Ben", saying each step while it works and folded when long; an answer someone shared
// from their own conversation is drawn as theirs, the question over it. A message that asks it is
// NEVER kept to send later: with no signal it is refused in words, and one that couldn't go waits
// for the person's own Try again (a paid call must not fire by itself when the phone reconnects).
//
// ITS OWN DATABASE AND QUEUE, per trip, as memories.js keeps its feed: "wegoplace-chat:<trip>"
// holds the messages last seen, the changes not yet sent (outbox), and where reading stopped
// (meta). Listed in forget.js, so signing out clears it and counts what was still waiting.
//
// Owner prefix .ch-*; styles in /css/chat.css (linked by this module when it first mounts).

import { esc, fmtDay, fmtTime, dayKey, uid, toMs } from "./util.js";
import { keyboardLock, openSheet } from "./sheet.js";
import { toast } from "./toast.js";
import { store } from "./store.js";
import { fetchWithin } from "./net.js";
import { pictureNow } from "./pictures.js";
import { dbName } from "./trip-here.js";
import { live } from "./live.js";
import { MESSAGE_MAX, MESSAGES_PAGE_MAX } from "./shared/limits.js";
import { subkind } from "./shared/place-kinds.js";
import { lastReadOf, markReadTo } from "./chat-read.js";
import { fmtMoney } from "./money.js";
import { faceHtml, personTone, personVars } from "../ds/avatar.js";
import { categoryOf } from "./icons.js";
import { answering, namesAssistant, offered, onRoom, readRoom, roomWords, tabsHtml } from "./assistant-room.js";

const DB_BASE = "wegoplace-chat";
const POLL_MS = 20_000;               // asking for changes while open, when there is no socket
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const GROUP_GAP_S = 5 * 60;           // one person's messages within this run together
const PAGE = 50;

// ── the trip's chat database ─────────────────────────────────────────────────────────────
let dbP = null;
function db() {
  if (dbP) return dbP;
  dbP = new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(DB_BASE, store.tripId()), 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("messages", { keyPath: "id" });
      d.createObjectStore("outbox", { keyPath: "key" });
      d.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbP;
}
async function tx(storeName, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const s = t.objectStore(storeName);
    const out = fn(s);
    t.oncomplete = () => resolve(out && "result" in out ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}
const all = (name) => tx(name, "readonly", (s) => s.getAll());
const put = (name, value, key) => tx(name, "readwrite", (s) => (key === undefined ? s.put(value) : s.put(value, key)));
const del = (name, key) => tx(name, "readwrite", (s) => s.delete(key));
const getMeta = (key) => tx("meta", "readonly", (s) => s.get(key));

// ── state, module-wide (a message waiting to send outlives the screen) ─────────────────────
const msgs = new Map();               // id -> the server's message
let outbox = [];                      // [{ key, op: "post"|"patch"|"delete", id, body?, about?, at, state, error? }]
let cursor = null;                    // the chat's counter as of the last read of changes
let oldestDone = false;               // nothing older to page back to
let loaded = null;
let flushing = false;
let retryStep = 0;
let retryTimer = null;
let held = null;                      // { kind, id } a message being written is about
const views = new Set();              // mounted screens' render functions
// A message that asks the assistant goes only from the page it was written on, once: any other
// sending of it (a later launch, the signal coming back) is the person's own Try again.
const SESSION = Math.random().toString(36).slice(2);
const aiRefused = new Map();          // message id -> why the assistant didn't answer it (the sender's alone)
const ASKS_LATER = "a message that asks the assistant is never sent later by itself. Press Try again when you're connected.";

const api = (rest = "") => store.tripApi(rest);

async function req(method, path, body) {
  try {
    const res = await fetchWithin(path, {
      method, credentials: "same-origin",
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: null };      // no signal
  }
}

function changed() { for (const fn of views) fn(); }

function keep(m) {
  if (!m || !m.id) return;
  msgs.set(m.id, m);
  put("messages", m).catch(() => {});
}

/** The outbox as this phone keeps it, read once, by whichever comes first: the screen or sendWaiting(). */
let outboxRead = null;
function readOutbox() {
  outboxRead ??= (async () => {
    try { outbox = (await all("outbox")).sort((a, b) => a.at - b.at); } catch (e) { console.warn("[chat] couldn't read what waits to be sent", e); }
  })();
  return outboxRead;
}

/**
 * Sends what waits in the outbox, without the screen: called by chat-dot.js (always loaded) on
 * launch and when the signal returns, so a message written on the pass goes when the phone next
 * has signal, not when its writer next opens the chat. Answers how many still wait.
 */
export async function sendWaiting() {
  await readOutbox();
  if (outbox.some((e) => e.state === "waiting")) await flush();
  return outbox.filter((e) => e.state === "waiting").length;
}

async function load() {
  if (loaded) return loaded;
  loaded = (async () => {
    try {
      for (const m of await all("messages")) msgs.set(m.id, m);
      await readOutbox();
      cursor = (await getMeta("cursor")) ?? null;
      oldestDone = (await getMeta("oldestDone")) === true;
    } catch (e) { console.warn("[chat] couldn't read what this phone kept", e); }
    changed();
    await readNewest();
    flush();
  })();
  return loaded;
}

/** The newest window, and from then on only what changed. */
async function readNewest() {
  if (cursor !== null) return readChanges();
  const r = await req("GET", api(`/messages?limit=${PAGE}`));
  if (!r.ok) return;
  for (const m of r.json.messages) keep(m);
  if (!r.json.more) { oldestDone = true; put("meta", true, "oldestDone").catch(() => {}); }
  cursor = r.json.seq;
  put("meta", cursor, "cursor").catch(() => {});
  changed();
}

// A poke while a read is out asks for one more read after it: what changed during the read (the
// assistant's next step, a message just sent) is never left for the poke after (15 Nov: two of the
// assistant's steps a moment apart, and another phone's chat stayed on the first).
let readingChanges = null;
let readAgain = false;
async function readChanges() {
  if (readingChanges) { readAgain = true; return readingChanges; }
  readingChanges = (async () => {
    do {
      readAgain = false;
      for (let i = 0; i < 20; i++) {
        const r = await req("GET", api(`/messages?after=${cursor ?? 0}&limit=${MESSAGES_PAGE_MAX}`));
        if (!r.ok) return;
        for (const m of r.json.messages) keep(m);
        const last = r.json.messages.reduce((n, m) => Math.max(n, m.touched), cursor ?? 0);
        cursor = r.json.more ? last : Math.max(last, r.json.seq);
        put("meta", cursor, "cursor").catch(() => {});
        changed();
        if (!r.json.more) break;
      }
    } while (readAgain);
  })();
  try { await readingChanges; } finally { readingChanges = null; }
}

async function readOlder() {
  if (oldestDone) return false;
  const oldest = [...msgs.values()].reduce((n, m) => Math.min(n, m.seq), Infinity);
  if (!Number.isFinite(oldest)) return false;
  const r = await req("GET", api(`/messages?before=${oldest}&limit=${PAGE}`));
  if (!r.ok) return false;
  for (const m of r.json.messages) keep(m);
  if (!r.json.more) { oldestDone = true; put("meta", true, "oldestDone").catch(() => {}); }
  changed();
  return r.json.messages.length > 0;
}

// ── sending, with or without signal ───────────────────────────────────────────────────────
async function enqueue(entry) {
  const e = { key: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), state: "waiting", ...entry };
  if (e.op === "post" && namesAssistant(e.body)) { e.asks = true; e.session = SESSION; }
  // A change to a message still waiting to be sent changes what will be sent.
  if (e.op === "patch") {
    const post = outbox.find((x) => x.op === "post" && x.id === e.id);
    if (post) { post.body = e.body; await put("outbox", post); changed(); return; }
  }
  if (e.op === "delete") {
    const post = outbox.find((x) => x.op === "post" && x.id === e.id);
    if (post) { outbox = outbox.filter((x) => x !== post); await del("outbox", post.key); changed(); return; }
    outbox = outbox.filter((x) => !(x.op === "patch" && x.id === e.id));
  }
  outbox.push(e);
  await put("outbox", e);
  changed();
  flush();
}

async function flush() {
  if (flushing) return;
  flushing = true;
  clearTimeout(retryTimer);
  try {
    for (;;) {
      const e = outbox.find((x) => x.state === "waiting");
      if (!e) break;
      // Asking the assistant: only now, from this page, the first time. Otherwise it waits for a press.
      if (e.op === "post" && namesAssistant(e.body) && (e.session !== SESSION || e.tried)) {
        e.state = "failed"; e.error = ASKS_LATER;
        await put("outbox", e); changed(); continue;
      }
      if (e.op === "post" && namesAssistant(e.body)) { e.tried = true; await put("outbox", e); }
      const r = e.op === "post"
        ? await req("POST", api("/messages"), { id: e.id, body: e.body, ...(e.about ? { about: e.about } : {}) })
        : e.op === "patch"
          ? await req("PATCH", api(`/messages/${encodeURIComponent(e.id)}`), { body: e.body })
          : await req("DELETE", api(`/messages/${encodeURIComponent(e.id)}`));
      if (r.ok) {
        keep(r.json.message);
        // The assistant won't answer it (no plan, off, used up, busy): said to its sender, under it.
        if (r.json.assistant && r.json.assistant.asked === false && r.json.message) aiRefused.set(r.json.message.id, r.json.assistant.reason || "The assistant can't answer just now.");
        outbox = outbox.filter((x) => x !== e);
        await del("outbox", e.key);
        retryStep = 0;
        changed();
        continue;
      }
      if ((r.status === 0 || r.status >= 500 || r.status === 429) && e.op === "post" && namesAssistant(e.body)) {
        e.state = "failed"; e.error = ASKS_LATER;
        await put("outbox", e); changed(); continue;
      }
      if (r.status === 0 || r.status >= 500 || r.status === 429) {
        // No signal, the server down, or too fast: it waits and goes again.
        retryTimer = setTimeout(flush, RETRY_MS[Math.min(retryStep++, RETRY_MS.length - 1)]);
        break;
      }
      // Refused for good: kept, with the server's own words, for the person to decide.
      e.state = "failed";
      e.error = r.json?.reason || r.json?.error || `The server said ${r.status}.`;
      await put("outbox", e);
      changed();
    }
  } finally { flushing = false; }
}
globalThis.addEventListener?.("online", () => { retryStep = 0; flush(); });

// ── the unread mark, kept per person on this phone ─────────────────────────────────────────
// Kept by chat-dot.js, which reads it to decide the dot.
function lastRead() { return lastReadOf(store.tripId(), store.me().id); }
function markRead() {
  if (document.visibilityState !== "visible") return;
  markReadTo(store.tripId(), store.me().id, [...msgs.values()].reduce((n, m) => Math.max(n, m.seq), 0));
}

// ── what a message is about ───────────────────────────────────────────────────────────────
// The words the app uses for each: an event is a "plan" everywhere a person reads it.
const KIND_WORD = { event: "Plan", place: "Place", purchase: "Purchase" };
function aboutNow(about) {
  if (!about) return null;
  const t = store.trip();
  const tz = t?.default_tz;
  if (about.kind === "event") {
    const e = store.events().find((x) => x.id === about.id);
    // The time before a plan is named the way its own page names it: "Free time", "Before <the
    // plan>" (the anchor that stays true when the plans around it move), then the day.
    if (about.part === "before") {
      if (!e) return { ...about, word: "Free time", icon: "clock", gone: true, title: about.name ? `Before ${about.name}` : "Free time", line: "No longer on the trip" };
      return { ...about, word: "Free time", icon: "clock", title: `Before ${e.title}`, line: fmtDay(e.starts_at, e.tz || tz), href: `#/e/${encodeURIComponent(e.id)}?gap=1` };
    }
    if (!e) return { ...about, gone: true, title: about.name, line: "No longer on the trip" };
    const place = e.place_id ? store.places().find((x) => x.id === e.place_id) : null;
    const pk = ["flight", "transit", "meal", "lodging", "activity", "plan"].includes(e.kind) ? e.kind : "plan";
    const tok = (pk !== "flight" && pk !== "transit" && place && place.kind) ? `--cat-${categoryOf(place.kind)}` : `--plan-${pk}`;
    return { ...about, tok, title: e.title, line: `${fmtDay(e.starts_at, e.tz || tz)} · ${e.all_day ? "All day" : fmtTime(e.starts_at, e.tz || tz)}`, href: `#/e/${encodeURIComponent(e.id)}` };
  }
  if (about.kind === "place") {
    const p = store.places().find((x) => x.id === about.id);
    if (!p) return { ...about, gone: true, title: about.name, line: "No longer on the trip" };
    return { ...about, tok: `--cat-${categoryOf(p.kind)}`, title: p.name, line: subkind(p.subkind)?.label ?? "Place", href: `#/p/${encodeURIComponent(p.id)}` };
  }
  const pu = store.purchases().find((x) => x.id === about.id);
  if (!pu) return { ...about, gone: true, title: about.name || "A purchase", line: "No longer on the trip" };
  // The amount as Split writes it ("S/ 239.65", "€42.00"): one spelling of money in the app.
  const amount = fmtMoney(pu.amount_minor, pu.amount_exp, pu.currency);
  // What it was, the amount and who paid; never the split (who owes what is Split's to say).
  const payer = pu.paid_by ? skin(pu.paid_by).name : "";
  return { ...about, title: pu.description || "A purchase", line: payer ? `${amount} · paid by ${payer}` : amount, href: `#/split/${encodeURIComponent(pu.id)}` };
}

// ── people ────────────────────────────────────────────────────────────────────────────────
function initialsFrom(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
function skin(id, nameFallback) {
  const m = store.members().find((x) => x && x.id === id);
  const name = m?.name || nameFallback || "Someone";
  const tone = personTone(m?.note_color);
  return { name, first: name.trim().split(/\s+/)[0], initials: m?.initials || initialsFrom(name), pic: m?.avatar || "", color: m?.note_color || "", tone, style: personVars(tone) };
}

// ── a message's words ─────────────────────────────────────────────────────────────────────
// Text, and nothing in it is interpreted, except that an http(s) address is a link that opens
// outside the app with no referrer. Everything else, markup included, is shown as written.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
export function wordsHtml(text) {
  const t = String(text ?? "");
  let out = "";
  let at = 0;
  for (const m of t.matchAll(URL_RE)) {
    // Punctuation that ends a sentence isn't part of the address; a ")" is, when the address opened one.
    let url = m[0].replace(/[.,;:!?'"\]}]+$/, "");
    if (url.endsWith(")") && !url.includes("(")) url = url.replace(/\)+$/, "");
    let href = null;
    try { const u = new URL(url); if (u.protocol === "http:" || u.protocol === "https:") href = u.href; } catch { /* not an address */ }
    out += esc(t.slice(at, m.index));
    out += href ? `<a class="ch-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${esc(url)}</a>` : esc(url);
    at = m.index + url.length;
  }
  return out + esc(t.slice(at));
}

// ── the screen ────────────────────────────────────────────────────────────────────────────
/** Links /css/chat.css once; answers a promise of it being applied. */
function ensureStyles() {
  let l = document.querySelector("link[data-chat-css]");
  if (!l) {
    l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "/css/chat.css";
    l.dataset.chatCss = "1";
    l.loaded = new Promise((r) => { l.onload = r; l.onerror = r; });
    document.head.append(l);
  }
  return l.loaded ?? Promise.resolve();
}

const ICON = {
  event: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  place: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/>',
  purchase: '<path d="M12 20V13"/><path d="M12 13 6.5 7.5"/><path d="M12 13 17.5 7.5"/><path d="M6.5 11.4V7.5h3.9"/><path d="M17.5 11.4V7.5h-3.9"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  alert: '<path d="M12 4 21 20H3L12 4Z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2H4.5L6 16.5Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  bellOff: '<path d="M6 16.5V11a6 6 0 0 1 9.4-4.9M18 11v5.5l1.5 2H8"/><path d="M10 20.5a2 2 0 0 0 4 0"/><path d="M3.5 3.5l17 17"/>',
  // The assistant's mark (assistant.js draws the same).
  mark: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5"/>',
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
};
const svg = (name, cls = "ico") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

function cardHtml(a, { held: isHeld = false } = {}) {
  // A kind this app doesn't know draws no card (the words still show).
  if (!a || !Object.hasOwn(KIND_WORD, a.kind)) return "";
  const now = aboutNow(a);
  if (!now) return "";
  const inner = `${svg(now.icon ?? a.kind, "ico ch-card-ico")}<span class="ch-card-text"><span class="ch-card-kind">${esc(now.word ?? KIND_WORD[a.kind])}</span>` +
    `<span class="ch-card-title">${esc(now.title || "")}</span><span class="ch-card-line">${esc(now.line || "")}</span></span>`;
  const tone = now.tok ? ` data-toned="1" style="--ds-k:var(${esc(now.tok)})"` : "";
  if (isHeld) return `<div class="ch-card ch-card-held" data-kind="${esc(a.kind)}"${tone}>${inner}<button type="button" class="ch-card-x" data-act="drop-about" aria-label="Not about this">${svg("x")}</button></div>`;
  return now.href && !now.gone
    ? `<a class="ch-card" data-kind="${esc(a.kind)}"${tone} href="${esc(now.href)}">${inner}</a>`
    : `<div class="ch-card ch-card-gone" data-kind="${esc(a.kind)}"${tone}>${inner}</div>`;
}

/**
 * A link to the chat about one thing, what an AI app hands the person (open_in_app):
 * #/chat?about=<kind>:<id>, with &part=before for the time before a plan. Read once, as the chat
 * mounts, into what the next message is about, the same as "Chat about this"; the query is then
 * taken off the address, so a reload or a step back doesn't hold it again. A kind the chat doesn't
 * know, a thing not on this phone, or a payment (no purchase to talk about) holds nothing.
 */
function heldFromAddress() {
  const h = String(location.hash || "");
  const i = h.indexOf("?");
  if (i < 0) return;
  const q = new URLSearchParams(h.slice(i + 1));
  history.replaceState(history.state, "", `${location.pathname}${location.search}#/chat`);
  // The link says what the next message is about, and only that: what was held before it goes.
  held = null;
  const about = q.get("about") || "";
  const colon = about.indexOf(":");
  const kind = colon > 0 ? about.slice(0, colon) : "";
  const id = colon > 0 ? about.slice(colon + 1) : "";
  if (!KIND_WORD[kind] || !id) return;
  const there = kind === "event" ? store.event(id) : kind === "place" ? store.place(id) : store.purchase(id);
  if (!there || (kind === "purchase" && there.kind === "payment")) return;
  const part = kind === "event" && q.get("part") === "before" ? "before" : null;
  held = { kind, id, ...(part ? { part } : {}) };
}

export default function mount(el, ctx) {
  heldFromAddress();
  const styled = ensureStyles();
  const router = ctx.router;
  let dead = false;
  let pollTimer = null;
  let pinnedToBottom = true;
  const shownTime = new Set();         // messages whose time was tapped open
  const unfolded = new Set();          // long answers opened
  let working = false;                 // the assistant is answering in the chat: asked again sooner
  let readAtOpen = lastRead();
  let justSentId = null;

  const root = document.createElement("section");
  root.className = "ch ds";
  root.innerHTML =
    `<div class="ch-head ds-head"><h1 class="ch-h1">Chat</h1>` +
      `<div class="ds-head-end"><span class="ch-who"></span>` +
      `<button type="button" class="ch-bell ds-button ds-button--gray ds-button--icon ds-button--lg" data-act="notify" aria-expanded="false" aria-controls="ch-notify"></button></div></div>` +
    `<div class="ch-tabs-slot"></div>` +
    `<div class="ch-notify" id="ch-notify" hidden></div>` +
    `<div class="ch-older" hidden><button type="button" class="btn ds-button ds-button--gray" data-act="older">Earlier messages</button></div>` +
    `<ol class="ch-feed" aria-live="polite"></ol>` +
    `<div class="ch-empty" hidden><p class="ch-empty-t">No messages yet</p><p class="ch-empty-s">Everyone on the trip sees what's written here. Press "Chat about this" on a plan, a place or a purchase to talk about it here.</p></div>`;
  el.append(root);
  const feed = root.querySelector(".ch-feed");

  const layer = router.fixedLayer();
  const box = document.createElement("form");
  box.className = "ch-box ds";
  box.innerHTML =
    `<p class="ch-ai-hint" role="status" hidden></p>` +
    `<div class="ch-held"></div>` +
    `<div class="ch-box-row">` +
      `<label class="sr-only" for="ch-input">Message</label>` +
      `<textarea id="ch-input" class="ch-input" rows="1" maxlength="${MESSAGE_MAX}" placeholder="Message the group" enterkeyhint="send"></textarea>` +
      `<button type="submit" class="ch-send" aria-label="Send" disabled>${svg("send")}</button>` +
    `</div>`;
  layer.append(box);
  const input = box.querySelector(".ch-input");
  const sendBtn = box.querySelector(".ch-send");
  const boxRow = box.querySelector(".ch-box-row");
  const heldEl = box.querySelector(".ch-held");
  const hintEl = box.querySelector(".ch-ai-hint");
  let hintSaid = "";                   // a refusal of a send that asked the assistant

  // Whether words fit the box on one line: a placeholder that wraps is cut in half (320 with larger
  // text). Measured in the box's own font; before the stylesheet has laid it out, they fit.
  const measure = document.createElement("canvas").getContext("2d");
  function fits(words) {
    const w = input.clientWidth;
    if (!w || !measure) return true;
    const cs = getComputedStyle(input);
    measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return measure.measureText(words).width <= w - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 4;
  }
  // Where the site offers the assistant: the tabs, the box's hint, and what a message naming it does.
  function paintAi() {
    root.querySelector(".ch-tabs-slot").innerHTML = tabsHtml("group");
    input.placeholder = offered() && answering() && fits("Message or @assistant") ? "Message or @assistant" : "Message the group";
    const asks = offered() && namesAssistant(input.value);
    const words = hintSaid || (!asks ? ""
      : !navigator.onLine ? "No signal: a message that asks the assistant isn't sent until you're connected, and never by itself."
      : answering() ? "The assistant answers in the chat, for everyone on the trip."
      : `${roomWords().words} The message still goes to the group.`);
    hintEl.textContent = words;
    hintEl.hidden = !words;
    hintEl.dataset.kind = hintSaid || (asks && (!navigator.onLine || !answering())) ? "no" : "yes";
  }

  // The box grows with what's written, to five lines; empty, it is its one-line height from the
  // stylesheet (measuring before the stylesheet applies would pin the unstyled height).
  function grow() {
    input.style.height = "";
    if (input.value) input.style.height = `${Math.min(Math.max(input.scrollHeight + 2, input.offsetHeight), 140)}px`;
    // Scrolls only once it is at its tallest; below that every line shows and there is nothing to scroll.
    input.style.overflowY = input.scrollHeight + 2 > 140 ? "auto" : "hidden";
    const has = !!input.value.trim();
    sendBtn.disabled = !has;
    boxRow.dataset.has = has ? "1" : "";
    paintAi();
    document.documentElement.style.setProperty("--ch-box-h", `${box.offsetHeight}px`);
  }

  function renderHeld() {
    heldEl.innerHTML = held ? cardHtml(held, { held: true }) : "";
    grow();
  }

  function render() {
    if (dead) return;
    const me = store.me().id;
    const trip = store.trip();
    const tz = trip?.default_tz;
    const people = store.members().filter((m) => !m.left && !m.deleted).length;
    root.querySelector(".ch-who").textContent = people > 1 ? `${people} people` : "";

    const waiting = new Map(outbox.filter((e) => e.op === "post").map((e) => [e.id, e]));
    const pending = new Map(outbox.filter((e) => e.op !== "post").map((e) => [e.id, e]));
    const rows = [...msgs.values()].sort((a, b) => a.seq - b.seq);
    for (const e of waiting.values()) {
      if (msgs.has(e.id)) continue;
      rows.push({ id: e.id, seq: Infinity, author: me, author_name: store.me().name, body: e.body, about: e.about ? { ...e.about, name: "" } : null, created_at: Math.floor(e.at / 1000), waiting: e });
    }
    root.querySelector(".ch-empty").hidden = rows.length > 0;
    root.querySelector(".ch-older").hidden = oldestDone || rows.length === 0;

    const wasAtBottom = pinnedToBottom;
    // A run: one person's messages on one day, each within five minutes of the last. The run
    // shows its writer once (on the first) and its time once (on the last); the others' times
    // are there for a screen reader, and show when the message is tapped.
    const person = (m) => !m.kind || m.kind === "person";
    const continues = (a, b) => !!a && !!b && person(a) && person(b) && a.author === b.author && b.created_at - a.created_at < GROUP_GAP_S
      && !a.deleted && !b.deleted && dayKey(a.created_at, tz) === dayKey(b.created_at, tz);
    let html = "";
    let lastDay = "";
    let markedNew = false;
    for (let i = 0; i < rows.length; i++) {
      const m = rows[i];
      const day = dayKey(m.created_at, tz);
      if (day !== lastDay) { html += `<li class="ch-day"><span>${esc(fmtDay(m.created_at, tz))}</span></li>`; lastDay = day; }
      if (!markedNew && readAtOpen > 0 && Number.isFinite(m.seq) && m.seq > readAtOpen && m.author !== me && !m.deleted) {
        html += `<li class="ch-newline" aria-label="New messages">New</li>`;
        markedNew = true;
      }
      const mine = m.author === me;
      const s = skin(m.author, m.author_name);
      const joined = continues(rows[i - 1], m);
      const lastOfRun = !continues(m, rows[i + 1]);
      const p = pending.get(m.id);
      const state = m.waiting
        ? (m.waiting.state === "failed"
          ? `<span class="ch-state ch-failed">${svg("alert")}Not sent: ${esc(m.waiting.error)}</span><span class="ch-state-acts"><button type="button" class="btn ds-button ds-button--white" data-act="retry" data-key="${esc(m.waiting.key)}">Try again</button><button type="button" class="btn ds-button ds-button--gray" data-act="discard" data-destroys data-key="${esc(m.waiting.key)}">Remove</button></span>`
          : `<span class="ch-state">${svg("clock")}Waiting to send</span>`)
        : p ? `<span class="ch-state">${svg("clock")}${p.op === "delete" ? "Deleting" : "Saving the change"}…</span>` : "";
      const ai = m.kind === "assistant";
      const shared = m.kind === "shared";
      const refusedAi = mine && aiRefused.get(m.id);
      const arriving = justSentId === m.id;
      if (arriving) justSentId = null;
      const body = m.deleted
        ? `<p class="ch-deleted">${m.deleted.by && m.deleted.by !== m.author ? "Message deleted by the host" : "Message deleted"}</p>`
        : ai ? aiBodyHtml(m)
        : shared ? sharedBodyHtml(m, mine ? "You" : s.first)
        : `${m.about ? cardHtml(m.about) : ""}<p class="ch-body">${wordsHtml(p?.op === "patch" ? p.body : m.body)}</p>`;
      // The assistant's answer: under its own mark, never the asker's face.
      const asMine = mine && !ai;
      const label = ai ? `The assistant's answer, asked by ${mine ? "you" : s.first}` : shared ? `${mine ? "Your" : `${s.first}'s`} shared answer` : mine ? "Your message" : `${s.first}'s message`;
      const can = mine && !ai && !shared ? ", Edit and Delete" : mine ? " and Delete" : "";
      const meta = `<span class="ch-meta${lastOfRun ? "" : " ch-quiet"}${m.edited_at && !m.deleted ? " ch-has-edited" : ""}"><time datetime="${new Date(toMs(m.created_at)).toISOString()}">${esc(fmtTime(m.created_at, tz))}</time>${m.edited_at && !m.deleted ? `<span class="ch-edited">edited</span>` : ""}</span>`;
      const hasHead = !joined && !shared;
      const headRow = hasHead
        ? `<div class="ch-headrow"><span class="ch-name"${!asMine && !ai && s.tone ? ` data-person="${esc(s.tone)}" style="${esc(s.style)}"` : ""}>${ai ? `Assistant · asked by ${esc(mine ? "you" : s.first)}` : asMine ? "You" : esc(s.name)}</span>${meta}</div>`
        : "";
      html +=
        `<li class="ch-msg${asMine ? " ch-mine" : ""}${joined ? " ch-joined" : ""}${m.waiting ? " ch-waiting" : ""}${ai ? " ch-ai" : ""}${shared ? " ch-shared" : ""}${ai && m.working ? " ch-ai-work" : ""}${shownTime.has(m.id) ? " ch-show-time" : ""}${arriving ? " ch-arriving" : ""}" data-id="${esc(m.id)}">` +
          (ai ? `<span class="ch-sq ch-ai-sq ds-face" style="" aria-hidden="true">${svg("mark")}</span>`
            : joined ? `<span class="ch-sq ds-face" aria-hidden="true"></span>`
            : faceHtml({
              name: s.name,
              label: asMine ? "You" : s.name,
              initials: s.initials,
              drawing: s.pic ? pictureNow(s.pic) : null,
              picture: s.pic && !pictureNow(s.pic) ? s.pic : null,
              size: 32,
              me: asMine,
              color: s.color,
              className: "ch-sq",
            })) +
          `<div class="ch-bubble"${m.deleted || m.waiting || (ai && m.working) ? "" : ` role="button" tabindex="0" data-act="bubble" aria-haspopup="dialog" aria-label="${esc(label)}: hold or press Enter for Copy${can}"`}>` +
            headRow +
            body +
            (refusedAi ? `<span class="ch-state ch-failed">${svg("alert")}The assistant didn't answer: ${esc(refusedAi)}</span>` : "") +
            (hasHead ? "" : meta) +
            state +
          `</div>` +
        `</li>`;
    }
    feed.innerHTML = html;
    if (wasAtBottom) scrollToEnd();
    markRead();
    working = rows.some((m) => m.kind === "assistant" && m.working && !m.deleted);
  }

  // The assistant's answer in the chat: the step it is on while it works, then its words (folded
  // when long) and what it changed, with the way to Changes.
  function aiBodyHtml(m) {
    if (m.working) return `<p class="ch-ai-working" role="status"><span class="as-dots" aria-hidden="true"><i></i><i></i><i></i></span>${esc(String(m.working).replace(/…$/, ""))}…</p>`;
    const did = (Array.isArray(m.did) ? m.did : []).filter((d) => d && d.ok);
    return foldHtml(m.id, `<p class="ch-body">${wordsHtml(m.body)}</p>`, m.body) +
      (did.length ? `<p class="ch-ai-did">${svg("check", "ico ch-ai-did-ico")}<span>${esc(did.map((d) => d.words).join("; "))}. <a class="ch-link" href="#/changes">In Changes, with an undo</a></span></p>` : "");
  }
  // An answer someone shared from their own conversation: their question over the answer.
  function sharedBodyHtml(m, who) {
    const q = m.shared?.question || "";
    return `<p class="ch-shared-t">${svg("mark", "ico ch-shared-ico")}${esc(who)} shared the assistant's answer</p>` +
      (q ? `<p class="ch-shared-q"><span class="sr-only">The question: </span>${wordsHtml(q)}</p>` : "") +
      foldHtml(m.id, `<p class="ch-body">${wordsHtml(m.shared?.answer ?? m.body)}</p>`, m.shared?.answer ?? m.body);
  }
  // Folded when long: the start, then "Show all" (and "Show less" once open), never cut silently.
  function foldHtml(id, inner, text) {
    const t = String(text || "");
    const long = t.length > 600 || t.split("\n").length > 10;
    if (!long) return inner;
    const open = unfolded.has(id);
    return `<div class="ch-fold${open ? " ch-fold-open" : ""}">${inner}</div>` +
      `<button type="button" class="ch-fold-btn" data-act="fold" data-id="${esc(id)}" aria-expanded="${open}">${open ? "Show less" : "Show all"}</button>`;
  }

  // #view is the scroller (the shell's), not the window.
  function scrollToEnd() {
    requestAnimationFrame(() => { if (!dead) el.scrollTop = el.scrollHeight; });
  }
  const onScroll = () => {
    pinnedToBottom = el.clientHeight + el.scrollTop >= el.scrollHeight - 80;
  };
  el.addEventListener("scroll", onScroll, { passive: true });

  function actions(id) {
    const m = msgs.get(id);
    if (!m) return;
    const me = store.me().id;
    const isHost = store.trip()?.host_id === me;
    const mine = m.author === me;
    if (m.deleted) return;
    const who = skin(m.author, m.author_name).first;
    const content = document.createElement("div");
    content.className = "ch-acts ds";
    content.innerHTML =
      `<button type="button" class="btn btn-block ds-button ds-button--gray ds-button--lg ds-button--block" data-do="copy">Copy</button>` +
      (mine && (!m.kind || m.kind === "person") ? `<button type="button" class="btn btn-block ds-button ds-button--gray ds-button--lg ds-button--block" data-do="edit">Edit message</button>` : "") +
      (mine || isHost ? `<button type="button" class="btn btn-block btn-danger ds-button ds-button--gray ds-button--lg ds-button--block" data-destroys data-do="delete">${mine ? "Delete message" : `Delete ${esc(who)}'s message`}</button>` : "");
    const sheet = openSheet({ title: mine ? "Your message" : `${who}'s message`, contentEl: content });
    content.addEventListener("click", async (ev) => {
      const b = ev.target.closest("[data-do]");
      if (!b) return;
      sheet.close();
      if (b.dataset.do === "copy") {
        try { await navigator.clipboard.writeText(m.body); toast("Copied"); } catch { toast("Couldn't copy on this phone."); }
      } else if (b.dataset.do === "edit") editing(m);
      else enqueue({ op: "delete", id: m.id });
    });
  }

  let editingId = null;
  function editing(m) {
    editingId = m.id;
    held = null;
    renderHeld();
    heldEl.innerHTML = `<div class="ch-editing"><span>Editing your message</span><button type="button" class="btn btn-sm btn-ghost" data-act="cancel-edit">Cancel</button></div>`;
    input.value = m.body;
    grow();
    input.focus();
  }

  // A message: a tap shows its time (when its run shows it only on the last); holding it, a
  // right click, or Enter opens what can be done with it. Links and cards inside it are theirs.
  let pressTimer = null;
  let pressed = null;
  const PRESS_MS = 450;
  root.addEventListener("pointerdown", (ev) => {
    const b = ev.target.closest('[data-act="bubble"]');
    if (!b || ev.target.closest("a")) return;
    pressed = { b, x: ev.clientX, y: ev.clientY, fired: false };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { if (pressed) { pressed.fired = true; actions(b.closest(".ch-msg").dataset.id); } }, PRESS_MS);
  });
  root.addEventListener("pointermove", (ev) => {
    if (pressed && Math.hypot(ev.clientX - pressed.x, ev.clientY - pressed.y) > 9) { clearTimeout(pressTimer); pressed = null; }
  });
  const endPress = () => { clearTimeout(pressTimer); };
  root.addEventListener("pointerup", endPress);
  root.addEventListener("pointercancel", () => { clearTimeout(pressTimer); pressed = null; });
  root.addEventListener("contextmenu", (ev) => {
    const b = ev.target.closest('[data-act="bubble"]');
    if (!b || ev.target.closest("a")) return;
    ev.preventDefault();
    clearTimeout(pressTimer);
    if (!pressed?.fired) actions(b.closest(".ch-msg").dataset.id);
    pressed = null;
  });

  root.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "bubble") {
      if (ev.target.closest("a")) return;
      const wasHeld = pressed?.fired;
      pressed = null;
      if (wasHeld) return;
      const li = b.closest(".ch-msg");
      const id = li.dataset.id;
      if (shownTime.has(id)) shownTime.delete(id); else shownTime.add(id);
      li.classList.toggle("ch-show-time", shownTime.has(id));
      return;
    }
    if (b.dataset.act === "older") {
      const y = el.scrollHeight - el.scrollTop;
      b.disabled = true;
      const got = await readOlder();
      b.disabled = false;
      if (got) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - y; });
    }
    if (b.dataset.act === "fold") {
      const id = b.dataset.id;
      if (unfolded.has(id)) unfolded.delete(id); else unfolded.add(id);
      render();
      return;
    }
    if (b.dataset.act === "retry") {
      const e = outbox.find((x) => x.key === b.dataset.key);
      if (e) {
        // A press is the person's own: a message that asks the assistant goes again, now, once.
        if (namesAssistant(e.body)) {
          if (!navigator.onLine) { toast("No signal: a message that asks the assistant goes only when you're connected."); return; }
          e.session = SESSION; e.tried = false;
        }
        e.state = "waiting"; delete e.error; await put("outbox", e); changed(); flush();
      }
    }
    if (b.dataset.act === "discard") {
      const e = outbox.find((x) => x.key === b.dataset.key);
      if (e) { outbox = outbox.filter((x) => x !== e); await del("outbox", e.key); changed(); }
    }
  });
  root.addEventListener("keydown", (ev) => {
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.dataset?.act === "bubble") { ev.preventDefault(); actions(ev.target.closest(".ch-msg").dataset.id); }
  });
  box.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "drop-about") { held = null; renderHeld(); }
    if (b.dataset.act === "cancel-edit") { editingId = null; input.value = ""; renderHeld(); }
  });
  input.addEventListener("input", () => { hintSaid = ""; grow(); });

  // THE KEYBOARD, the way the agenda's note composer rides it: the box sits at
  // calc(--tabbar-space + --kb-h) (chat.css), the shell publishes --kb-h on <html>, and while the
  // box has focus keyboardLock() holds the conversation still (iOS would otherwise scroll it to
  // "reveal" a field that is fixed and needs no revealing) and republishes the more exact
  // keyboard height onto the box and the conversation's foot, so the last message, the held
  // thing and the box all stay on glass. At the end, the conversation follows it there.
  let kbLock = null;
  const onKb = (m) => {
    const h = `${Math.round(m.kb)}px`;
    box.style.setProperty("--kb-h", h);
    root.style.setProperty("--kb-h", h);
    if (pinnedToBottom) el.scrollTop = el.scrollHeight;
  };
  input.addEventListener("focus", () => {
    if (kbLock || dead) return;
    kbLock = keyboardLock({ onViewport: onKb });
  });
  input.addEventListener("blur", () => {
    if (!kbLock) return;
    const l = kbLock;
    kbLock = null;
    box.style.removeProperty("--kb-h");
    root.style.removeProperty("--kb-h");
    l.release();
    if (pinnedToBottom) scrollToEnd();
  });
  input.addEventListener("keydown", (ev) => {
    // Enter sends on a keyboard; on a phone the return key makes a new line (enterkeyhint says send).
    if (ev.key === "Enter" && !ev.shiftKey && matchMedia("(hover: hover)").matches) { ev.preventDefault(); box.requestSubmit(); }
  });
  box.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = input.value;
    if (!text.trim()) return;
    if (text.length > MESSAGE_MAX) { toast(`A message is at most ${MESSAGE_MAX.toLocaleString()} characters. Send it as two.`); return; }
    // Asking the assistant with no signal: refused in words, and the words stay in the box.
    if (!editingId && offered() && namesAssistant(text) && !navigator.onLine) {
      hintSaid = "No signal: a message that asks the assistant isn't sent until you're connected, and never by itself. It's still here.";
      paintAi();
      return;
    }
    if (editingId) {
      enqueue({ op: "patch", id: editingId, body: text });
      editingId = null;
    } else {
      const id = uid("m-");
      justSentId = id;
      readAtOpen = Infinity;
      enqueue({ op: "post", id, body: text, about: held ? { kind: held.kind, id: held.id, ...(held.part ? { part: held.part } : {}) } : null });
      held = null;
    }
    input.value = "";
    pinnedToBottom = true;
    renderHeld();
  });

  // New messages: the socket's poke, or asking while open when there is none.
  const offLive = live.on("chat", () => readChanges());
  // While the assistant answers in the chat its steps are read every few seconds when there's no socket.
  const poll = () => {
    pollTimer = setTimeout(async () => {
      if (dead) return;
      if (document.visibilityState === "visible" && live.state().status !== "open") await readChanges();
      poll();
    }, working ? 3_000 : POLL_MS);
  };
  poll();
  const onStore = () => render();
  const offStore = store.on ? store.on("change", onStore) : null;

  // ── notifications: this phone's, and the trip's mute ───────────────────────────────────
  // The bell names where things stand in its own words (and its glyph crosses through when the
  // trip is muted); the panel under the header says each state in a sentence, never a tint alone.
  const bell = root.querySelector(".ch-bell");
  const panel = root.querySelector(".ch-notify");
  let pushNow = { state: "ask", words: false };
  let pushBusy = false;
  let pushSaid = "";
  const pushMod = () => import("./push.js");
  const PHONE_WORDS = {
    off: "This site doesn't send notifications.",
    unsupported: "This browser can't show notifications.",
    install: "To be told on an iPhone or iPad, add WeGoPlace to your Home Screen first (Share, then Add to Home Screen), open it from there, and turn notifications on here.",
    blocked: "Notifications are blocked for WeGoPlace in this browser's settings. Allow them there, then come back here.",
    ask: "Get told on this phone when someone else writes in this trip's chat.",
    on: "On for this phone: you're told when someone else writes.",
  };
  function paintBell() {
    const muted = store.chatMuted() === true;
    const on = pushNow.state === "on";
    bell.dataset.state = muted ? "muted" : on ? "on" : "ask";
    bell.innerHTML = `${svg(muted ? "bellOff" : "bell", "ico ch-bell-ico")}<span class="ch-bell-t sr-only">${muted ? "Muted" : on ? "On" : "Notify"}</span>`;
    bell.setAttribute("aria-label", `Notifications: ${muted ? "this trip's chat is muted" : on ? "on for this phone" : "off for this phone"}`);
  }
  function paintPanel() {
    if (panel.hidden) return;
    const muted = store.chatMuted() === true;
    const s = pushNow.state;
    const offline = !navigator.onLine;
    panel.innerHTML =
      `<p class="ch-n-line" data-state="${esc(s)}">${esc(PHONE_WORDS[s] || "")}</p>` +
      (s === "ask" ? `<button type="button" class="btn btn-primary btn-sm ds-button ds-button--white" data-act="push-on"${pushBusy || offline ? " disabled" : ""}>${offline ? "Turning on needs signal" : "Turn on notifications"}</button>` : "") +
      (s === "on" ? `<label class="ch-n-switch"><input type="checkbox" class="ds-check" data-act="push-words"${pushNow.words ? " checked" : ""}${pushBusy || offline ? " disabled" : ""}>` +
        `<span><b>Show what was said on the lock screen</b><small>${pushNow.words ? "On: the message's words show on this phone's lock screen." : "Off: it says who wrote and in which trip, not what."}</small></span></label>` +
        `<button type="button" class="btn btn-ghost btn-sm ds-button ds-button--gray" data-act="push-off"${pushBusy || offline ? " disabled" : ""}>Turn off for this phone</button>` : "") +
      `<label class="ch-n-switch"><input type="checkbox" class="ds-check" data-act="mute"${muted ? " checked" : ""}${offline ? " disabled" : ""}>` +
        `<span><b>Mute this trip's chat</b><small>${muted ? "Muted: no notifications from this trip on any of your phones. The chat is as ever." : "Every trip you're on is heard unless you mute it here."}</small></span></label>` +
      (offline ? `<p class="ch-n-said">No signal: these change when you're connected.</p>` : "") +
      (pushSaid ? `<p class="ch-n-said" role="status">${esc(pushSaid)}</p>` : "");
  }
  async function refreshPush() {
    try { pushNow = await (await pushMod()).pushState(); } catch { pushNow = { state: "unsupported", words: false }; }
    if (!dead) { paintBell(); paintPanel(); }
  }
  root.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-act]");
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === "notify") {
      panel.hidden = !panel.hidden;
      bell.setAttribute("aria-expanded", String(!panel.hidden));
      pushSaid = "";
      paintPanel();
      if (!panel.hidden) refreshPush();
      return;
    }
    if (act === "push-on" || act === "push-off") {
      pushBusy = true; pushSaid = ""; paintPanel();
      try {
        const m = await pushMod();
        pushNow = act === "push-on" ? await m.turnOn({ words: pushNow.words }) : await m.turnOff();
        if (act === "push-on" && pushNow.state === "blocked") pushSaid = "The browser said no. You can allow it in its settings.";
      } catch (e) { pushSaid = navigator.onLine ? (e?.message || "That didn't work.") : "No signal: nothing changed. Try again when you're connected."; }
      pushBusy = false;
      if (!dead) { paintBell(); paintPanel(); }
    }
  });
  root.addEventListener("change", async (ev) => {
    const toggle = ev.target.closest("input[data-act]");
    if (!toggle) return;
    if (toggle.dataset.act === "push-words") {
      pushBusy = true; pushSaid = ""; paintPanel();
      try { pushNow = await (await pushMod()).setWords(toggle.checked); }
      catch (e) { pushSaid = navigator.onLine ? (e?.message || "That didn't work.") : "No signal: nothing changed."; }
      pushBusy = false; paintPanel();
    }
    if (toggle.dataset.act === "mute") {
      const want = toggle.checked;
      toggle.disabled = true;
      try {
        const res = await fetchWithin(api("/chat/mute"), { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ muted: want }) });
        const j = await res.json().catch(() => null);
        if (!res.ok) throw new Error(j?.reason || `The server didn't take it (${res.status}).`);
        store.setChatMuted(j.muted);
        pushSaid = "";   // the switch's own line says what muted means, once
      } catch (e) { pushSaid = navigator.onLine ? (e?.message || "That didn't work.") : "No signal: nothing changed."; }
      if (!dead) { paintBell(); paintPanel(); }
    }
  });
  const onNet = () => { if (!dead) { paintPanel(); paintAi(); } };
  const onResize = () => { if (!dead) grow(); };
  addEventListener("resize", onResize);
  addEventListener("online", onNet);
  addEventListener("offline", onNet);
  const offMute = store.on("change", () => { if (!dead) paintBell(); });
  paintBell();
  refreshPush();
  // A subscription this browser holds, told to the server again (its keys rotate now and then).
  pushMod().then((m) => m.keepCurrent()).catch(() => {});

  views.add(render);
  const offRoom = onRoom(() => { if (!dead) { paintAi(); grow(); } });
  readRoom();
  styled.then(() => { if (!dead) grow(); });
  renderHeld();
  render();
  // Opened again after being somewhere else: the socket's pokes reach the chat only while it is
  // open, so what was said meanwhile is read now (the first opening reads the newest in load()).
  const again = !!loaded;
  load().then(() => { if (again && !dead) readChanges(); });

  // A link followed while the chat is open: the router doesn't mount it again for a query.
  const offNav = typeof router.onNavigate === "function"
    ? router.onNavigate(() => { if (!dead && /^#\/chat\?/.test(location.hash)) { heldFromAddress(); renderHeld(); } })
    : () => {};

  return () => {
    dead = true;
    removeEventListener("online", onNet);
    removeEventListener("offline", onNet);
    removeEventListener("resize", onResize);
    if (typeof offMute === "function") offMute();
    offRoom();
    offNav();
    if (kbLock) { kbLock.release(); kbLock = null; }
    views.delete(render);
    clearTimeout(pollTimer);
    offLive();
    if (typeof offStore === "function") offStore();
    el.removeEventListener("scroll", onScroll);
    box.remove();
    // The next screen mounts before this one goes (the Assistant tab has its box too): its height stays.
    if (!document.querySelector(".ch-box")) document.documentElement.style.removeProperty("--ch-box-h");
  };
}

/** Opens the chat with this thing held above the box: the next message is about it. */
export function chatAbout(kind, id, { part = null } = {}) {
  if (!KIND_WORD[kind] || !id) throw new Error("chatAbout(kind, id): an event, a place or a purchase");
  held = { kind, id, ...(part ? { part } : {}) };
  location.hash = "#/chat";
}

// ── what has been said about one thing (a plan's page) ─────────────────────────────────────
// Notes on plans are messages about them (migration 0027): a plan's page lists them. They come
// from what the chat holds on this phone, the ones waiting to be sent, and the thing's own read
// (GET messages?about=…), which is kept on this phone under the thing ("about:<kind>:<id>" in
// meta), never among the chat's own messages: the chat pages back from the oldest message it
// holds, and an old message about a plan in among them would make it skip everything between.

/**
 * Calls fn(list) now and whenever what has been said about the thing changes: the messages about
 * it (part "before": about the time before a plan), not deleted, in the chat's order, then the
 * ones waiting on this phone. Each is { id, author, author_name, body, created_at, waiting?,
 * failed? }. Answers the stop.
 */
export function watchAbout(kind, id, part, fn) {
  const match = (a) => !!a && a.kind === kind && a.id === id && (part === "before" ? a.part === "before" : !a.part);
  const key = `about:${kind}:${id}`;
  let kept = [];
  let stopped = false;
  const pick = () => {
    const byId = new Map(kept.map((m) => [m.id, m]));
    for (const m of msgs.values()) if (match(m.about)) byId.set(m.id, m);
    const sent = [...byId.values()].filter((m) => !m.deleted).sort((a, b) => a.seq - b.seq);
    const me = store.me();
    const waiting = outbox.filter((e) => e.op === "post" && match(e.about) && !byId.has(e.id)).map((e) => ({
      id: e.id, author: me.id, author_name: me.name || "", body: e.body, created_at: Math.floor(e.at / 1000),
      waiting: e.state === "waiting", failed: e.state === "failed",
    }));
    return [...sent, ...waiting];
  };
  const view = () => { if (!stopped) fn(pick()); };
  views.add(view);
  const offLive = live.on("chat", () => readChanges());
  (async () => {
    try { kept = (await getMeta(key)) || []; } catch { kept = []; }
    view();
    load();
    const r = await req("GET", api(`/messages?about=${kind}:${encodeURIComponent(id)}&limit=${MESSAGES_PAGE_MAX}`));
    if (stopped || !r.ok) return;
    kept = r.json.messages.filter((m) => match(m.about));
    put("meta", kept, key).catch(() => {});
    view();
  })();
  view();
  return () => { stopped = true; views.delete(view); offLive(); };
}

/** The list watchAbout() hands over, as the rows a plan's page shows (chat.css's .ch-said). */
export function saidHtml(list) {
  const tz = store.trip()?.default_tz;
  const me = store.me().id;
  return `<ol class="ch-said ds">${list.map((m) => {
    const s = skin(m.author, m.author_name);
    const mine = m.author === me;
    const state = m.failed ? `<span class="ch-said-state" data-state="failed">Not sent</span>`
      : m.waiting ? `<span class="ch-said-state">${svg("clock")}Waiting to send</span>` : "";
    return `<li class="ch-said-row" data-id="${esc(m.id)}">` +
      faceHtml({
        name: s.name,
        label: mine ? "You" : s.name,
        initials: s.initials,
        drawing: s.pic ? pictureNow(s.pic) : null,
        picture: s.pic && !pictureNow(s.pic) ? s.pic : null,
        size: 32,
        me: mine,
        color: s.color,
        className: "ch-sq",
      }) +
      `<div class="ch-said-main"><p class="ch-said-who"><b>${esc(mine ? "You" : s.name)}</b>` +
        `<time datetime="${new Date(toMs(m.created_at)).toISOString()}">${esc(`${fmtDay(m.created_at, tz)}, ${fmtTime(m.created_at, tz)}`)}</time>${state}</p>` +
        `<p class="ch-said-body">${wordsHtml(m.body)}</p></div>` +
    `</li>`;
  }).join("")}</ol>`;
}

/** chat.css, for a screen outside the chat that shows its rows (a plan's page). */
export const chatStyles = () => ensureStyles();

/** For the unread dot (chat-dot.js) and the checks: what this phone holds. */
export const chatState = () => ({ messages: msgs.size, outbox: outbox.map((e) => ({ op: e.op, id: e.id, state: e.state })), cursor, lastRead: lastRead() });

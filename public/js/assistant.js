// assistant.js — talking to the trip's assistant (model §20; the server's side is src/assistant/talk.js).
//
// Everyone on the trip asks the assistant for themselves, and what it answered goes to the group in
// one press. Beside the group chat, under the same tab (Chat: Group | Assistant):
//   #/chat/assistant        the person's own conversations on this trip (only they see them), where
//                           the assistant stands this month, and a box to ask something new;
//   #/chat/assistant/<id>   one conversation: each question, and under each answer what it changed
//                           (with the way to Changes, where each change has an undo), how it got
//                           there, and "Share with group", one press.
//
// A DOCUMENT (a planning doc, a PDF, a photo of a page) goes with a question: the paperclip in the box chooses it,
// it is sent at once and read by the server ("Reading <name>…" on its chip, then ready with its pages, or the
// server's refusal in its words), and the question sends it (files) and keeps it. The conversation's More lists
// its documents, each with delete (src/assistant/files.js; the limits are the server's, read with the list).
//
// WHILE IT WORKS each step is said in words as it is taken ("Reading the plans…"), from the server's
// lines (NDJSON). WITH NO SIGNAL an ask is refused in words and never kept to send later: a paid call
// must not fire by itself when the phone reconnects. Every refusal is the server's own sentence.
//
// What is kept: the conversations live on the server with the person's account. This module holds
// what it read in memory for as long as the app is open, and on this phone only which answers were
// shared ("wgp.assistant.shared@<trip>", trip-here.js's TRIP_KEYS: cleared at sign-out with every
// "wgp." key, and dropped when the person leaves the trip).
//
// Owner prefix .as-*; styles in /css/chat.css with the chat's (chat.js links it).

import { esc, fmtDay, fmtTime, uid, toMs, setDisabled } from "./util.js";
import { keyboardLock, openSheet } from "./sheet.js";
import { toast } from "./toast.js";
import { store } from "./store.js";
import { fetchWithin, STALL_MS } from "./net.js";
import { answering, boxWords, offered, onRoom, readRoom, roomKept, roomWords, tabsHtml } from "./assistant-room.js";
import { chatStyles, wordsHtml } from "./chat.js";
import { tripIdFromPath, tripKey } from "./trip-here.js";

const ASK_MAX = 2000;                 // the server's TALK.wordsMax
// What the paperclip offers: files and, on a phone, the camera and the photo library (image/* lets iOS show both).
const ACCEPT = "image/*,application/pdf,.pdf,.docx,.xlsx,.odt,.txt,.md,.markdown,.csv,text/plain,text/markdown,text/csv," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet," +
  "application/vnd.oasis.opendocument.text";
const UPLOAD_MS = 120_000;            // a scan's reading is one model call; past this it is given up, said so
const LOST_WAITS = [3_000, 6_000, 12_000, 24_000];   // an answer whose line dropped: read again after these

// ── what this app holds, while it is open ─────────────────────────────────────────────────
let list = null;                      // [{ id, title, created_at, updated_at }] for this trip, newest first
let listTrip = null;
const turnsOf = new Map();            // conversation id -> [turn]
let asking = null;                    // { conv, id, words, step, lost?, at }
// A first question asked from the list moves to its new conversation, which is a new screen: if the
// ask is then refused, that screen shows why and puts the words back in its box.
let refusedFor = null;                // { conv, words, why }
// Documents chosen for the next question, by conversation ("" on the list, before there is one): each
// { key, name, state: "reading" | "ready" | "refused", id?, pages?, why? }.
const pickedOf = new Map();
const docsOf = new Map();             // conversation id -> its documents, as the server lists them
let docLimits = null;                 // the server's: sizes, 5 a conversation, words for them
const views = new Set();
const changed = () => { for (const fn of views) fn(); };

const api = (rest) => store.tripApi(`/assistant${rest}`);
async function call(method, path, body) {
  try {
    const res = await fetchWithin(path, {
      method, credentials: "same-origin",
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, json };
  } catch { return { ok: false, status: 0, json: null }; }
}
const NO_SIGNAL = "No signal: asking the assistant needs signal. Nothing was sent, and it won't be sent later by itself.";
const reasonOf = (r, fallback) => (r.status === 0 ? NO_SIGNAL : r.json?.reason || fallback);

async function readList() {
  const got = await readRoom();
  if (!got) return false;
  list = Array.isArray(got.conversations) ? got.conversations : [];
  listTrip = store.tripId();
  changed();
  return true;
}
async function readConversation(id) {
  const r = await call("GET", api(`/conversations/${encodeURIComponent(id)}`));
  if (r.ok) {
    turnsOf.set(id, Array.isArray(r.json.turns) ? r.json.turns : []);
    const c = r.json.conversation;
    if (c && list) { const i = list.findIndex((x) => x.id === c.id); if (i >= 0) list[i] = c; else list.unshift(c); }
    changed();
  }
  return r;
}

async function readDocs(conv) {
  const r = await call("GET", api(`/conversations/${encodeURIComponent(conv)}/files`));
  if (r.ok) { docsOf.set(conv, Array.isArray(r.json.files) ? r.json.files : []); docLimits = r.json.limits ?? docLimits; changed(); }
  return r;
}

// ── documents for a question ───────────────────────────────────────────────────────────────
const KINDS = [[/^image\//, /\.(jpe?g|png|webp|heic)$/i, "image"], [/pdf/, /\.pdf$/i, "pdf"], [/officedocument|opendocument/, /\.(docx|xlsx|odt)$/i, "docx"],
  [/^text\/csv/, /\.csv$/i, "csv"], [/^text\//, /\.(txt|md|markdown)$/i, "text"]];
const kindOf = (f) => KINDS.find(([type, ext]) => type.test(f.type || "") || ext.test(f.name || ""))?.[2] ?? null;
const picked = (conv) => pickedOf.get(conv ?? "") || [];
const sizeWords = (n) => (n >= 1048576 ? `${Math.round(n / 104857.6) / 10} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * One chosen file, sent at once to the conversation and read there: its chip says "Reading" until the server has
 * read it, then ready (its pages), or the server's refusal in its own words. A file over its kind's size is refused
 * here first, in the same words, and nothing is sent.
 */
async function upload(conv, file) {
  const entry = { key: uid("f"), name: file.name || "photo.jpg", state: "reading" };
  pickedOf.set(conv, [...picked(conv), entry]);
  const max = docLimits && kindOf(file) ? docLimits[kindOf(file)] : null;
  if (max && file.size > max) {
    Object.assign(entry, { state: "refused", why: `It's too big (${sizeWords(file.size)}). ${docLimits.words}` });
    changed();
    return;
  }
  changed();
  const ctl = new AbortController();
  const late = setTimeout(() => ctl.abort(), UPLOAD_MS);
  try {
    const res = await fetch(api(`/conversations/${encodeURIComponent(conv)}/files`), {
      method: "POST", credentials: "same-origin", signal: ctl.signal, body: file,
      headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(entry.name), Accept: "application/json" },
    });
    let j = null;
    try { j = await res.json(); } catch { /* not JSON */ }
    if (res.ok && j?.file) {
      Object.assign(entry, { state: "ready", id: j.file.id, pages: j.file.pages ?? null });
      docsOf.set(conv, [...(docsOf.get(conv) || []).filter((d) => d.id !== j.file.id), j.file]);
    } else {
      Object.assign(entry, { state: "refused", why: j?.reason || `It couldn't be added just now (the server said ${res.status}).` });
    }
  } catch (e) {
    Object.assign(entry, { state: "refused", why: e?.name === "AbortError" && navigator.onLine
      ? "Reading it took too long, so it wasn't added. Try again, or a smaller file."
      : "No signal: nothing was sent. Choose it again when you're connected." });
  } finally { clearTimeout(late); }
  changed();
}

// ── shared answers, remembered on this phone ───────────────────────────────────────────────
const SHARED_KEY = "wgp.assistant.shared";
const here = (k) => tripKey(k, tripIdFromPath(location.pathname));
function sharedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(here(SHARED_KEY)) || "[]")); } catch { return new Set(); }
}
function markShared(turnId) {
  const s = sharedSet();
  s.add(turnId);
  try { localStorage.setItem(here(SHARED_KEY), JSON.stringify([...s].slice(-500))); } catch { /* storage full or off */ }
}
// The message's id in the chat comes from the answer's (the server takes the same id twice as one
// message): a second press, on this phone or after a reload, never shares it twice.
const shareId = (turnId) => `sh-${String(turnId).replace(/\.answer$/, "").replace(/[^a-z0-9_-]/g, "-")}`.slice(0, 64);

// ── asking ─────────────────────────────────────────────────────────────────────────────────
/**
 * One ask in a conversation (made first when there is none): the question shown at once, each step
 * as the server says it, the answer kept. Answers null when it was taken, or the words why not
 * (the question then stays in the box).
 */
/** A new conversation (from the list): { conv } or { why }. Documents chosen on the list move with it. */
async function startConversation() {
  const made = await call("POST", api("/conversations"), { id: uid("c"), title: "" });
  if (!made.ok) return { why: reasonOf(made, "A conversation couldn't be started just now. Try again in a moment.") };
  const conv = made.json.conversation.id;
  list = [made.json.conversation, ...(list || []).filter((c) => c.id !== conv)];
  turnsOf.set(conv, []);
  docsOf.set(conv, []);
  return { conv };
}

async function ask(convId, words, onConversation) {
  if (!navigator.onLine) return NO_SIGNAL;
  if (asking) return "The assistant is still answering your last question.";
  let conv = convId;
  if (!conv) {
    const made = await startConversation();
    if (made.why) return made.why;
    conv = made.conv;
    onConversation?.(conv);
  }
  // The documents it goes with: those read and ready (the box doesn't send while one is still being read).
  const ready = picked(conv).filter((f) => f.state === "ready");
  const files = ready.map((f) => f.id);
  const id = uid("q");
  asking = { conv, id, words, step: "Sending your question", at: Math.floor(Date.now() / 1000), files: ready.map((f) => ({ id: f.id, name: f.name })) };
  changed();
  // No clock on the ask: the answer streams while it is worked out, and a long one is fine. It is
  // given up only when nothing has come for net.js's STALL_MS, before the answer starts (no signal)
  // or partway (the line dropped: readLines() reads the conversation again).
  const ctl = new AbortController();
  let stall = 0;
  const moving = () => { clearTimeout(stall); stall = setTimeout(() => ctl.abort(), STALL_MS); };
  const still = () => clearTimeout(stall);
  moving();
  let res;
  try {
    res = await fetch(api(`/conversations/${encodeURIComponent(conv)}/ask`), {
      method: "POST", credentials: "same-origin", signal: ctl.signal,
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson, application/json" },
      body: JSON.stringify({ id, words, ...(files.length ? { files } : {}) }),
    });
  } catch {
    still();
    asking = null; changed();
    return NO_SIGNAL;
  }
  moving();
  if (!res.ok) {
    still();
    let j = null;
    try { j = await res.json(); } catch { /* not JSON */ }
    asking = null; changed();
    if (res.status === 402) readRoom();       // used up, off, no plan: the room's line says so too
    return j?.reason || `The assistant couldn't be asked just now (the server said ${res.status}).`;
  }
  // Taken: the question is the conversation's now, with its documents (they leave the box).
  const turns = turnsOf.get(conv) || [];
  turns.push({ id, role: "person", words, created_at: asking.at, ...(ready.length ? { files: ready.map((f) => ({ id: f.id, name: f.name })) } : {}) });
  pickedOf.set(conv, picked(conv).filter((f) => !ready.includes(f)));
  turnsOf.set(conv, turns);
  readLines(res, conv, id, moving).finally(still);
  return null;
}

async function readLines(res, conv, id, moving = () => {}) {
  const reader = res.body?.getReader?.();
  const dec = new TextDecoder();
  let buf = "", answered = false;
  const take = (line) => {
    if (!line.trim()) return;
    let o = null;
    try { o = JSON.parse(line); } catch { return; }
    if (o && typeof o.step === "string" && asking?.id === id) { asking.step = o.step.replace(/…$/, ""); changed(); }
    if (o && o.turn && typeof o.turn === "object") {
      answered = true;
      const turns = turnsOf.get(conv) || [];
      if (!turns.some((t) => t.id === o.turn.id)) turns.push(o.turn);
      turnsOf.set(conv, turns);
      if (asking?.id === id) asking = null;
      changed();
    }
  };
  try {
    if (reader) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        moving();
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) { take(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      }
      take(buf);
    } else {
      for (const line of (await res.text()).split("\n")) take(line);
    }
  } catch { /* the line dropped: below */ }
  if (answered) { readConversation(conv); readRoom(); return; }
  // The line dropped before the answer came. The server goes on and keeps it (talk.js): it is read
  // again, and shows here when it is there.
  if (asking?.id === id) { asking.lost = true; changed(); }
  for (const wait of LOST_WAITS) {
    await new Promise((r) => setTimeout(r, wait));
    if (!navigator.onLine) continue;
    const r = await readConversation(conv);
    if (r.ok && (turnsOf.get(conv) || []).some((t) => t.id === `${id}.answer`)) { if (asking?.id === id) asking = null; changed(); return; }
  }
  if (asking?.id === id) { asking.lost = "long"; changed(); }
}
addEventListener("online", () => {
  if (asking?.lost) readConversation(asking.conv).then(() => {
    if (asking?.lost && (turnsOf.get(asking.conv) || []).some((t) => t.id === `${asking.id}.answer`)) { asking = null; changed(); }
  });
});

// ── drawing ────────────────────────────────────────────────────────────────────────────────
const ICON = {
  mark: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  more: '<circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/>',
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  alert: '<path d="M12 4 21 20H3L12 4Z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  clip: '<path d="M16.5 7.5 9.4 14.6a2 2 0 0 0 2.8 2.8l7.4-7.4a4 4 0 0 0-5.7-5.7L6.5 11.7a6 6 0 0 0 8.5 8.5l5.5-5.5"/>',
  doc: '<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4M9.5 12h6M9.5 15.5h6"/>',
};
/** A document's chip: its name, and how it stands ("Reading…", its pages, "not added"). The chip opens its sheet. */
function chipHtml(f) {
  const state = f.state === "reading" ? "Reading…" : f.state === "refused" ? "not added" : f.pages ? `${f.pages} ${f.pages === 1 ? "page" : "pages"}` : "ready";
  const ico = f.state === "reading" ? '<span class="as-dots" aria-hidden="true"><i></i><i></i><i></i></span>' : f.state === "refused" ? svg("alert", "ico as-file-ico") : svg("doc", "ico as-file-ico");
  return `<li><button type="button" class="ds-chip as-file" data-state="${f.state}" data-file="${esc(f.key)}" aria-haspopup="dialog">${ico}` +
    `<span class="ds-chip-text">${esc(f.name)}</span><span class="as-file-state">${esc(state)}</span></button></li>`;
}
const svg = (name, cls = "ico") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
const when = (sec) => {
  const tz = store.trip()?.default_tz;
  return `<time datetime="${new Date(toMs(sec)).toISOString()}">${esc(`${fmtDay(sec, tz)}, ${fmtTime(sec, tz)}`)}</time>`;
};

function roomHtml({ always }) {
  const k = roomKept();
  const r = roomWords(k);
  if (r.kind === "none") return "";
  if (r.kind === "ready" && !always) return "";
  const isHost = store.trip()?.host_id === store.me().id;
  const sw = isHost && k?.room && (k.room.on === true || k.room.off_by_host)
    ? `<label class="ch-n-switch as-switch"><input type="checkbox" class="ds-check" data-act="ai-on"${k.room.off_by_host ? "" : " checked"}${navigator.onLine ? "" : " disabled"}>` +
      `<span><b>The assistant on this trip</b><small>${k.room.off_by_host ? "Off: nobody on this trip can ask it until you turn it back on." : "On: everyone on the trip can ask it, out of your plan's month."}${navigator.onLine ? "" : " No signal: this changes when you're connected."}</small></span></label>`
    : "";
  const warn = r.kind === "used" || r.kind === "off";
  return `<div class="as-room" data-kind="${r.kind}">` +
    `<div class="as-room-row">${warn ? svg("alert", "ico as-room-ico") : ""}<p class="as-room-line" role="status">${esc(r.words)}</p></div>` +
    sw + `</div>`;
}

// In a conversation the host still has their switch (the room's words are the box's). No amounts on any screen: the
// month's use is said only where it runs low or out (roomWords' refusal here, the account card's line).
function hostLineHtml() {
  const k = roomKept();
  if (!k?.room || store.trip()?.host_id !== store.me().id) return "";
  return roomHtml({ always: true }).replace(/<div class="as-room-row">[\s\S]*?<\/div>/, "");
}

function answerHtml(t, shared) {
  const d = t.detail || {};
  const did = Array.isArray(d.did) ? d.did : [];
  // The steps that did something (read, changed); "Working out what to do" alone says nothing.
  const steps = (Array.isArray(d.steps) ? d.steps : []).filter((x) => !/^Working out /.test(String(x)));
  const notDone = Array.isArray(d.not_done) ? d.not_done : [];
  const isShared = shared.has(t.id);
  return `<li class="as-a" data-turn="${esc(t.id)}">` +
    `<p class="as-a-head">${svg("mark", "ico as-mark")}<span class="as-a-name">Assistant</span>${when(t.created_at)}</p>` +
    `<p class="as-a-body">${wordsHtml(t.words)}</p>` +
    (did.length ? `<div class="as-did"><p class="as-did-t">What it did</p><ul>${did.map((x) =>
      `<li${x.ok ? "" : ' data-state="not"'}>${x.ok ? svg("check", "ico as-did-ico") : svg("alert", "ico as-did-ico")}<span>${esc(x.ok ? x.words : `Not done: ${x.words}`)}</span></li>`).join("")}</ul>` +
      (did.some((x) => x.ok) ? `<a class="as-did-link" href="#/changes">Each change is in Changes, with an undo</a>` : "") + `</div>` : "") +
    (notDone.length ? `<p class="as-notdone">${esc(`Not done: ${notDone.join("; ")}`)}</p>` : "") +
    (steps.length ? `<details class="as-steps"><summary>How it got there: ${steps.length} ${steps.length === 1 ? "step" : "steps"}</summary><ol>${steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></details>` : "") +
    `<div class="as-a-acts">` + (isShared
      ? `<p class="as-shared">${svg("check", "ico as-did-ico")}Shared with the group <a href="#/chat">See it in the chat</a></p>`
      : `<button type="button" class="btn ds-button ds-button--gray as-share" data-act="share" data-turn="${esc(t.id)}">Share with group</button>`) +
    `</div></li>`;
}

/** Under a question, the documents it was asked with (a deleted one keeps its name, saying so). */
function questionFiles(files) {
  if (!Array.isArray(files) || !files.length) return "";
  return `<ul class="as-q-files ds-chip-list" aria-label="Documents with this question">${files.map((f) => {
    const gone = docsOf.has(currentConv) && !(docsOf.get(currentConv) || []).some((d) => d.id === f.id);
    return `<li class="ds-chip as-file" data-state="${gone ? "gone" : "ready"}">${svg("doc", "ico as-file-ico")}<span class="ds-chip-text">${esc(f.name)}</span>${gone ? '<span class="as-file-state">deleted</span>' : ""}</li>`;
  }).join("")}</ul>`;
}
let currentConv = null;

function workingHtml(a, withQuestion) {
  const line = a.lost === "long"
    ? "The connection dropped while it worked. Its answer is kept, and shows here when you open this conversation again."
    : a.lost ? "The connection dropped while it worked. Its answer is kept: it shows here when you're connected." : `${a.step}…`;
  return (withQuestion ? `<li class="as-q"><p class="as-q-bubble">${esc(a.words)}</p>${questionFiles(a.files)}</li>` : "") +
    `<li class="as-a as-working"><p class="as-a-head">${svg("mark", "ico as-mark")}<span class="as-a-name">Assistant</span></p>` +
    `<p class="as-step" role="status" aria-live="polite">${a.lost ? "" : '<span class="as-dots" aria-hidden="true"><i></i><i></i><i></i></span>'}${esc(line)}</p></li>`;
}

// ── the screen ─────────────────────────────────────────────────────────────────────────────
export default function mount(el, ctx) {
  const router = ctx.router;
  const convId = ctx.params?.id ? String(ctx.params.id) : null;
  const styled = chatStyles();
  let dead = false;
  let said = "";                       // the box's own line: a refusal, in words
  if (listTrip !== store.tripId()) { list = null; turnsOf.clear(); docsOf.clear(); pickedOf.clear(); }

  const root = document.createElement("section");
  root.className = `ch as ds${convId ? " as-conv" : ""}`;
  el.append(root);

  const layer = router.fixedLayer();
  const box = document.createElement("form");
  box.className = "ch-box as-box ds";
  box.innerHTML =
    `<p class="as-said" role="status" hidden></p>` +
    `<ul class="as-files ds-chip-list" aria-label="Documents for your question" hidden></ul>` +
    `<div class="ch-box-row">` +
      `<button type="button" class="as-attach" data-act="attach" aria-label="Add a document or a photo">${svg("clip")}</button>` +
      `<input type="file" class="as-file-input" accept="${ACCEPT}" multiple hidden tabindex="-1" aria-hidden="true">` +
      `<label class="sr-only" for="as-input">Ask the assistant</label>` +
      `<textarea id="as-input" class="ch-input" rows="1" maxlength="${ASK_MAX}" placeholder="Ask the assistant about this trip" enterkeyhint="send"></textarea>` +
      `<button type="submit" class="ch-send" aria-label="Ask" disabled>${svg("send")}</button>` +
    `</div>`;
  layer.append(box);
  // The dock's Back rides above this box while it's here (chat.css, body[data-as-box]).
  document.body.dataset.asBox = "1";
  const input = box.querySelector(".ch-input");
  const sendBtn = box.querySelector(".ch-send");
  const boxRow = box.querySelector(".ch-box-row");
  const saidEl = box.querySelector(".as-said");
  const filesEl = box.querySelector(".as-files");
  const attachBtn = box.querySelector(".as-attach");
  const fileInput = box.querySelector(".as-file-input");
  const boxConv = () => convId ?? "";
  currentConv = convId;

  function grow() {
    input.style.height = "";
    if (input.value) input.style.height = `${Math.min(Math.max(input.scrollHeight + 2, input.offsetHeight), 140)}px`;
    input.style.overflowY = input.scrollHeight + 2 > 140 ? "auto" : "hidden";
    const can = answering() && !asking;
    const reading = picked(boxConv()).find((f) => f.state === "reading");
    const ready = !!input.value.trim() && can && !reading;
    // Off says why, in words (the room's reasons are the box's own line, below).
    setDisabled(sendBtn, ready ? "" : !can ? (asking ? "The assistant is still answering your last question." : boxWords() || "The assistant can't be asked now.")
      : reading ? `Wait for ${reading.name} to be read.` : "Write your question first.");
    boxRow.dataset.has = ready ? "1" : "";
    document.documentElement.style.setProperty("--ch-box-h", `${box.offsetHeight}px`);
  }
  function paintBox() {
    const r = roomWords();
    // Where it can't answer, the box says why in place of a question (never a dead button alone).
    const why = !offered() ? "" : r.kind !== "ready" ? r.words : "";
    input.disabled = !!why;
    const mine = picked(boxConv());
    const kept = (convId ? docsOf.get(convId) || [] : []).length + mine.filter((f) => f.state !== "refused" && !(convId && (docsOf.get(convId) || []).some((d) => d.id === f.id))).length;
    const most = docLimits?.perConversation ?? 5;
    setDisabled(attachBtn, why ? "The assistant can't be asked now, so no document can be added." : !navigator.onLine ? "No signal: a document is sent as soon as it's chosen, so it needs signal."
      : kept >= most ? `This conversation has its ${most} documents: delete one (More) to add another.` : "");
    filesEl.innerHTML = mine.map(chipHtml).join("");
    filesEl.hidden = !mine.length;
    // Where it can't be asked the box keeps its place, disabled, and says why in its own words.
    input.placeholder = why ? boxWords() || "The assistant can't be asked now"
      : mine.some((f) => f.state !== "refused") ? "Say what to do with it" : "Ask the assistant about this trip";
    // Why it can't be asked: on the list the room's card says it; in a conversation (the card isn't
    // there) the box does. Never both on one screen.
    // A document refused just now says why here too, until its chip is removed.
    const refusedNow = mine.find((f) => f.state === "refused");
    const line = said || (refusedNow ? `${refusedNow.name} wasn't added: ${refusedNow.why}` : "") || (why && convId && !input.value ? why : "");
    saidEl.textContent = line;
    saidEl.hidden = !line;
    saidEl.dataset.kind = said ? "said" : "room";
    grow();
  }

  function render() {
    if (dead) return;
    // Refused after it moved here from the list: why, and the words back in the box.
    if (refusedFor && convId && refusedFor.conv === convId) { said = refusedFor.why; input.value = refusedFor.words; refusedFor = null; }
    const more = root.querySelector(".head-more");
    if (!offered()) {
      // A site (or a trip, as far as this phone knows) without the assistant: nothing of it here.
      root.innerHTML = `<div class="ch-head ds-head"><h1 class="ch-h1">Chat</h1><div class="ds-head-end"></div></div><p class="as-lead">This site doesn't have the assistant. <a href="#/chat">Back to the group chat</a></p>`;
      if (more) root.querySelector(".ds-head-end")?.append(more);
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const shared = sharedSet();
    if (!convId) {
      const rows = (list || []).map((c) =>
        `<li><a class="as-row" href="#/chat/assistant/${encodeURIComponent(c.id)}"><span class="as-row-t">${esc(c.title || "A new conversation")}</span>` +
        `<span class="as-row-when">${when(c.updated_at)}</span></a></li>`).join("");
      root.innerHTML =
        `<div class="ch-head ds-head"><h1 class="ch-h1">Chat</h1><div class="ds-head-end"></div></div>${tabsHtml("assistant")}` +
        roomHtml({ always: true }) +
        `<p class="as-lead">Only you see these conversations. Share with group, under an answer, puts it in the group chat; there, @assistant in a message asks it for everyone.</p>` +
        (list === null
          ? `<p class="as-lead as-wait">${navigator.onLine ? "Reading your conversations…" : "No signal: your conversations show when you're connected."}</p>`
          : rows
            ? `<h2 class="as-h2">Your conversations</h2><ol class="as-list">${rows}</ol>`
            // Nothing yet. Where it can be asked, an invitation; where it can't, only what it does (the
            // card above and the box say why not).
            : roomWords().kind === "ready"
              ? `<div class="as-empty"><p class="ch-empty-t">Ask it anything about the trip</p><p class="ch-empty-s">It reads the plans, places, lists, Split and the chat, and can change them for you: "Add the museums we saved to Thursday". Every change it makes is in Changes, where anyone can undo it.</p></div>`
              : `<div class="as-empty as-about"><p class="as-h2">What the assistant does</p><p class="ch-empty-s">It reads the plans, places, lists, Split and the chat, and can change them for you. Every change it makes is in Changes, where anyone can undo it.</p></div>`);
      if (more) root.querySelector(".ds-head-end")?.append(more);
    } else {
      const c = (list || []).find((x) => x.id === convId);
      const turns = turnsOf.get(convId);
      const items = (turns || []).map((t) => (t.role === "person"
        ? `<li class="as-q" data-turn="${esc(t.id)}"><p class="as-q-bubble">${esc(t.words)}</p>${questionFiles(t.files)}</li>`
        : answerHtml(t, shared))).join("");
      // The question being answered: from the turns once the server has taken it, until then from the ask.
      const working = asking && asking.conv === convId ? workingHtml(asking, !(turns || []).some((t) => t.id === asking.id)) : "";
      root.innerHTML =
        `<div class="ch-head as-head ds-head"><h1 class="ch-h1 as-title">${esc(c?.title || (turns ? "A new conversation" : "Conversation"))}</h1>` +
          `<div class="ds-head-end"><button type="button" class="as-more ds-button ds-button--gray" data-act="more" aria-label="This conversation: its documents, and delete it" aria-haspopup="dialog">${svg("more")}</button></div></div>` +
        hostLineHtml() +
        (turns === undefined
          ? `<p class="as-lead as-wait">${navigator.onLine ? "Reading the conversation…" : "No signal: this conversation shows when you're connected."}</p>`
          : `<ol class="as-turns">${items}${working}</ol>`);
    }
    paintBox();
    if (convId && pinned) scrollToEnd();
  }

  let pinned = true;
  function scrollToEnd() { requestAnimationFrame(() => { if (!dead) el.scrollTop = el.scrollHeight; }); }
  const onScroll = () => { pinned = el.clientHeight + el.scrollTop >= el.scrollHeight - 80; };
  el.addEventListener("scroll", onScroll, { passive: true });

  root.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-act]");
    if (!b || b.disabled) return;
    if (b.dataset.act === "share") {
      if (!navigator.onLine) { toast("Sharing needs signal. Nothing was shared."); return; }
      const turn = b.dataset.turn;
      b.disabled = true;
      b.textContent = "Sharing…";
      const r = await call("POST", api(`/conversations/${encodeURIComponent(convId)}/share`), { id: shareId(turn), turn });
      if (r.ok) { markShared(turn); toast("Shared with the group"); render(); return; }
      b.disabled = false;
      b.textContent = "Share with group";
      toast(reasonOf(r, "That couldn't be shared just now. Try again in a moment.").replace(/^No signal: asking the assistant needs signal\..*$/, "No signal: nothing was shared."));
    }
    if (b.dataset.act === "more") {
      const content = document.createElement("div");
      content.className = "ch-acts ds";
      // Its documents, each with delete (yours alone: nobody else on the trip can open them), then the conversation.
      const docs = docsOf.get(convId);
      const docRows = (docs || []).map((d) => `<li class="as-doc"><span class="as-doc-ico">${svg("doc", "ico")}</span>` +
        `<span class="as-doc-t"><b>${esc(d.name)}</b><small>${esc([d.pages ? `${d.pages} ${d.pages === 1 ? "page" : "pages"}` : "", sizeWords(d.bytes || 0), d.state === "unreadable" ? `not read: ${d.why || "it couldn't be read"}` : ""].filter(Boolean).join(" · "))}</small></span>` +
        `<button type="button" class="ds-button ds-button--gray as-doc-del" data-destroys data-do="delete-doc" data-doc="${esc(d.id)}" aria-label="Delete ${esc(d.name)}">Delete</button></li>`).join("");
      content.innerHTML =
        `<h3 class="as-h2">Documents</h3>` +
        (docs === undefined ? `<p class="as-sheet-line">${navigator.onLine ? "Reading its documents…" : "No signal: its documents show when you're connected."}</p>`
          : docRows ? `<ul class="as-docs">${docRows}</ul><p class="as-sheet-line">Only you can open them. What the assistant added from them is the trip's.</p>`
          : `<p class="as-sheet-line">None yet. The paperclip in the box adds a document or a photo for a question.</p>`) +
        `<p class="as-sheet-line">Deleting the conversation removes it and its documents for good, from every phone of yours. What the assistant changed on the trip stays, in Changes.</p>` +
        `<button type="button" class="btn btn-block btn-danger ds-button ds-button--gray ds-button--lg ds-button--block" data-destroys data-do="delete">Delete this conversation</button>`;
      const sheet = openSheet({ title: "This conversation", contentEl: content });
      content.addEventListener("click", async (e2) => {
        const del = e2.target.closest('[data-do="delete-doc"]');
        if (del && !del.disabled) {
          if (!navigator.onLine) { toast("Deleting needs signal. Nothing was deleted."); return; }
          del.disabled = true;
          const docId = del.dataset.doc;
          const r = await call("DELETE", api(`/conversations/${encodeURIComponent(convId)}/files/${encodeURIComponent(docId)}`));
          if (!r.ok) { del.disabled = false; toast(reasonOf(r, "That couldn't be deleted just now. Try again in a moment.").replace(/^No signal: asking.*$/, "No signal: nothing was deleted.")); return; }
          docsOf.set(convId, (docsOf.get(convId) || []).filter((x) => x.id !== docId));
          pickedOf.set(convId, picked(convId).filter((x) => x.id !== docId));
          del.closest(".as-doc")?.remove();
          toast("Document deleted");
          changed();
          return;
        }
        const d = e2.target.closest('[data-do="delete"]');
        if (!d) return;
        if (!navigator.onLine) { toast("Deleting needs signal. Nothing was deleted."); return; }
        d.disabled = true;
        const r = await call("DELETE", api(`/conversations/${encodeURIComponent(convId)}`));
        if (!r.ok) { d.disabled = false; toast(reasonOf(r, "That couldn't be deleted just now. Try again in a moment.").replace(/^No signal: asking.*$/, "No signal: nothing was deleted.")); return; }
        sheet.close();
        list = (list || []).filter((x) => x.id !== convId);
        turnsOf.delete(convId);
        docsOf.delete(convId);
        pickedOf.delete(convId);
        toast("Conversation deleted");
        router.replace("#/chat/assistant");
      });
    }
  });
  root.addEventListener("change", async (ev) => {
    const t = ev.target.closest('input[data-act="ai-on"]');
    if (!t) return;
    const off = !t.checked;
    t.disabled = true;
    const r = await call("PUT", api("/off"), { off });
    if (!r.ok) { t.checked = !t.checked; toast(r.status === 0 ? "No signal: nothing changed." : r.json?.reason || "That didn't change just now. Try again in a moment."); }
    await readRoom();
    render();
  });

  // The paperclip: the phone's own picker (files, the camera, the photo library). Each file chosen is sent at once;
  // from the list, a conversation is made for it first, and opens.
  attachBtn.addEventListener("click", () => { if (!attachBtn.disabled) fileInput.click(); });
  fileInput.addEventListener("change", async () => {
    const chosen = [...fileInput.files];
    fileInput.value = "";
    if (!chosen.length) return;
    said = "";
    let conv = convId;
    if (!conv) {
      const made = await startConversation();
      if (made.why) { said = made.why; paintBox(); return; }
      conv = made.conv;
      if (!dead) router.go(`#/chat/assistant/${encodeURIComponent(conv)}`);
    }
    const most = docLimits?.perConversation ?? 5;
    const room = most - (docsOf.get(conv) || []).length - picked(conv).filter((f) => f.state === "reading").length;
    for (const [i, f] of chosen.entries()) {
      if (i >= room) { pickedOf.set(conv, [...picked(conv), { key: uid("f"), name: f.name || "photo.jpg", state: "refused", why: `A conversation holds ${most} documents: delete one (More) to add another.` }]); changed(); continue; }
      upload(conv, f);
    }
  });
  filesEl.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-file]");
    if (!b) return;
    const f = picked(boxConv()).find((x) => x.key === b.dataset.file);
    if (f) fileSheet(f);
  });
  /** A chosen document's sheet: how it stands, in words, and the one thing to do with it. */
  function fileSheet(f) {
    const conv = boxConv();
    const content = document.createElement("div");
    content.className = "ch-acts ds";
    const line = f.state === "reading" ? "It's being read. It goes with your question when it's ready."
      : f.state === "refused" ? `It wasn't added: ${f.why}`
      : `Read${f.pages ? `: ${f.pages} ${f.pages === 1 ? "page" : "pages"}` : ""}. It goes with your next question, and stays in this conversation's documents (More).`;
    content.innerHTML = `<p class="as-sheet-line">${esc(line)}</p>` + (f.state === "refused"
      ? `<button type="button" class="btn btn-block ds-button ds-button--gray ds-button--lg ds-button--block" data-destroys data-do="drop">Remove it</button>`
      : `<button type="button" class="btn btn-block btn-danger ds-button ds-button--gray ds-button--lg ds-button--block" data-destroys data-do="delete"${f.state === "reading" ? " disabled" : ""}>Delete this document</button>`);
    if (f.state === "reading") setDisabled(content.querySelector('[data-do="delete"]'), "It can be deleted once it's been read.");
    const sheet = openSheet({ title: f.name, contentEl: content });
    content.addEventListener("click", async (e2) => {
      const d = e2.target.closest("[data-do]");
      if (!d || d.disabled) return;
      if (d.dataset.do === "drop") { pickedOf.set(conv, picked(conv).filter((x) => x !== f)); sheet.close(); changed(); return; }
      if (!navigator.onLine) { toast("Deleting needs signal. Nothing was deleted."); return; }
      d.disabled = true;
      const r = await call("DELETE", api(`/conversations/${encodeURIComponent(conv)}/files/${encodeURIComponent(f.id)}`));
      if (!r.ok) { d.disabled = false; toast(reasonOf(r, "That couldn't be deleted just now. Try again in a moment.").replace(/^No signal: asking.*$/, "No signal: nothing was deleted.")); return; }
      pickedOf.set(conv, picked(conv).filter((x) => x !== f));
      docsOf.set(conv, (docsOf.get(conv) || []).filter((x) => x.id !== f.id));
      sheet.close();
      toast("Document deleted");
      changed();
    });
  }

  input.addEventListener("input", () => { if (said) { said = ""; } paintBox(); });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && matchMedia("(hover: hover)").matches) { ev.preventDefault(); box.requestSubmit(); }
  });
  box.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const words = input.value.trim();
    if (!words || sendBtn.disabled) return;
    said = "";
    sendBtn.disabled = true;
    pinned = true;
    let made = null;
    const why = await ask(convId, words, (id) => {
      // A first question from the list: the conversation it made opens, and the answer comes there.
      made = id;
      router.go(`#/chat/assistant/${encodeURIComponent(id)}`);
    });
    if (dead) { if (why && made) { refusedFor = { conv: made, words, why }; changed(); } return; }
    if (why) { said = why; paintBox(); return; }
    input.value = "";
    paintBox();
  });

  // The keyboard: as the chat's box rides it (chat.js), the conversation held still while it opens.
  let kbLock = null;
  const onKb = (m) => {
    const h = `${Math.round(m.kb)}px`;
    box.style.setProperty("--kb-h", h);
    root.style.setProperty("--kb-h", h);
    if (pinned) el.scrollTop = el.scrollHeight;
  };
  input.addEventListener("focus", () => { if (!kbLock && !dead) kbLock = keyboardLock({ onViewport: onKb }); });
  input.addEventListener("blur", () => {
    if (!kbLock) return;
    const l = kbLock; kbLock = null;
    box.style.removeProperty("--kb-h"); root.style.removeProperty("--kb-h");
    l.release();
  });

  const onNet = () => { if (!dead) render(); };
  addEventListener("online", onNet);
  addEventListener("offline", onNet);
  const offRoom = onRoom(() => { if (!dead) render(); });
  views.add(render);
  styled.then(() => { if (!dead) grow(); });
  render();
  readList();
  if (convId) { readConversation(convId); readDocs(convId); }

  return () => {
    dead = true;
    views.delete(render);
    offRoom();
    removeEventListener("online", onNet);
    removeEventListener("offline", onNet);
    el.removeEventListener("scroll", onScroll);
    if (kbLock) { kbLock.release(); kbLock = null; }
    box.remove();
    // The next screen mounts before this one goes (a conversation opened from the list): what it set stays.
    if (!document.querySelector(".as-box")) delete document.body.dataset.asBox;
    if (!document.querySelector(".ch-box")) document.documentElement.style.removeProperty("--ch-box-h");
  };
}

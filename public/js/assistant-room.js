// assistant-room.js — whether this trip has the assistant, said in words (model §20; the server's
// side is src/assistant/talk.js getAssistant and meter.js roomFor). Shared by the group chat
// (chat.js: its tabs and the @assistant hint) and the assistant's own screen (assistant.js).
//
// GET /api/trips/:trip/assistant answers { room, conversations, host? }:
//   room  { offered: false }                         the site doesn't offer it: NOTHING of it shows anywhere
//         { offered: true, on: false }               the host has no plan (one line: what it is, who can turn it on)
//         { offered: true, on: false, off_by_host }  the host turned it off on this trip
//         { offered: true, on: true, room, back }    room this month, or the day it's back (seconds)
//   host  (the trip's host only) { month, allowance, used, back, trip: { used, calls } }, micro-dollars: kept, shown on no screen
//
// What the last answer said is kept on this phone, once for each trip ("wgp.assistant@<trip>",
// trip-here.js's TRIP_KEYS: a "wgp." key, so signing out clears it with everything else about the
// person, and leaving the trip drops it), so the tabs are drawn at once and without signal. A member
// never learns numbers; the host learns them per trip, never per person.

import { store } from "./store.js";
import { fetchWithin } from "./net.js";
import { esc } from "./util.js";
import { tripIdFromPath, tripKey } from "./trip-here.js";

const ROOM_KEY = "wgp.assistant";
const here = (k) => tripKey(k, tripIdFromPath(location.pathname));
const listeners = new Set();
let last = null;

/** What this phone last heard: { room, host?, at } or null. */
export function roomKept() {
  if (last && last.trip === store.tripId()) return last;
  try {
    const v = JSON.parse(localStorage.getItem(here(ROOM_KEY)) || "null");
    if (v && v.room && typeof v.room === "object") { last = { ...v, trip: store.tripId() }; return last; }
  } catch { /* nothing kept */ }
  return null;
}

/** Calls fn() whenever what is known changes; answers the stop. */
export function onRoom(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function keep(v) {
  last = { room: v.room, host: v.host ?? null, at: Date.now(), trip: store.tripId() };
  try { localStorage.setItem(here(ROOM_KEY), JSON.stringify({ room: last.room, host: last.host, at: last.at })); } catch { /* storage full or off */ }
  for (const fn of listeners) { try { fn(); } catch { /* a screen gone */ } }
}

/**
 * Asks the server. Answers the whole answer ({ room, conversations, host? }), or null with no
 * signal or no answer (what was kept stays). A site without the routes (an older Worker) is a site
 * without the assistant.
 */
export async function readRoom() {
  let res;
  try { res = await fetchWithin(store.tripApi("/assistant"), { credentials: "same-origin", headers: { Accept: "application/json" } }); }
  catch { return null; }
  if (res.status === 404) { keep({ room: { offered: false } }); return { room: { offered: false }, conversations: [] }; }
  if (!res.ok) return null;
  let j = null;
  try { j = await res.json(); } catch { return null; }
  if (!j || typeof j.room !== "object" || !j.room) return null;
  keep(j);
  return j;
}

/** The site offers the assistant on this trip (whether or not it is on). */
export const offered = (k = roomKept()) => !!k?.room?.offered;
/** It would answer now: offered, on, with room this month. */
export const answering = (k = roomKept()) => !!k?.room?.offered && k.room.on === true && k.room.room !== false;

/** "@assistant" as a word, anywhere: the server's own test (src/assistant/talk.js namesAssistant). */
export const namesAssistant = (text) => /(^|[^\w@])@assistant\b/i.test(String(text ?? ""));

const isHost = () => !!store.trip() && store.trip().host_id === store.me().id;
function hostFirst() {
  const t = store.trip();
  const h = t && store.members().find((m) => m && m.id === t.host_id);
  return (h?.name || "").trim().split(/\s+/)[0] || "The trip's host";
}

/** A day the assistant is back, in words ("December 1"): the month turns in UTC on the server. */
export function backDay(sec) {
  if (!Number.isFinite(Number(sec))) return "";
  return new Date(Number(sec) * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/**
 * Where the assistant stands on this trip, in one sentence for whoever reads it, and its kind:
 * { kind: "ready" | "used" | "off" | "noplan" | "none", words }. "none": say nothing (not offered).
 */
export function roomWords(k = roomKept()) {
  const r = k?.room;
  if (!r || !r.offered) return { kind: "none", words: "" };
  if (r.on !== true) {
    if (r.off_by_host) return { kind: "off", words: isHost() ? "You've turned the assistant off on this trip." : "The trip's host has turned the assistant off on this trip." };
    return { kind: "noplan", words: isHost()
      ? "The assistant answers questions about this trip and can change it for you. It comes with your plan, on Your account."
      : `The assistant answers questions about this trip and can change it for you. It comes with the host's plan: ${hostFirst()} can turn it on.` };
  }
  if (r.room === false) return { kind: "used", words: `The assistant has used this month's room on this trip's plan. It's back on ${backDay(r.back)}.` };
  return { kind: "ready", words: "The assistant has room this month." };
}

/**
 * The reason, short enough for the box's one line where it can't be asked: "Ben can turn it on",
 * "Back on December 1", "Turned off for this trip". "" where it can.
 */
export function boxWords(k = roomKept()) {
  const r = k?.room;
  if (!r || !r.offered || (r.on === true && r.room !== false)) return "";
  if (r.on !== true) {
    if (r.off_by_host) return isHost() ? "You turned it off for this trip" : "Turned off for this trip";
    return isHost() ? "Comes with your plan" : `${hostFirst()} can turn it on`;
  }
  return `Back on ${backDay(r.back)}`;
}

/** The two tabs at the top of Chat, where the site offers the assistant: "" where it doesn't. */
export function tabsHtml(active) {
  if (!offered()) return "";
  const tab = (href, label, on) => `<a class="ch-tab" href="${href}"${on ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
  return `<nav class="ch-tabs" data-active="${active === "assistant" ? "1" : "0"}" aria-label="Chat">` +
    `<span class="ch-tabs-pill" aria-hidden="true"></span>` +
    `${tab("#/chat", "Group", active === "group")}${tab("#/chat/assistant", "Assistant", active === "assistant")}</nav>`;
}

// The chat's unread mark: what a person needs to notice a new message while in another section.
//
// Loaded by the shell on a trip's page (small, and nothing else of the chat loads until the chat
// is opened). It keeps nothing of its own: chat.js writes where reading stopped (the newest seq
// seen, per person per trip, on this phone), and this file compares it with the chat's counter
// as the trip's socket reports it (live.js "chat"), or as GET …/rev says while there is no socket.
// When the counter has moved past it, one small read asks whether anyone else wrote; your own
// messages, edits and deletes never mark it.
//
// The mark: a dot on the Chat tab when Chat is in the bar, otherwise on Other, and on Other's
// Chat row; with "new messages" in their accessible names. A dot and words, never a tint alone.

import { live } from "./live.js";
import { store } from "./store.js";
import { fetchWithin } from "./net.js";
import { labelOther } from "./tabs.js";
import { dbName, tripApi, tripIdFromPath } from "./trip-here.js";

const TRIP = tripIdFromPath(globalThis.location?.pathname ?? "");
const POLL_MS = 90_000;            // without a socket, as the store's heartbeat

// Where reading stopped is kept by chat-read.js (shared with chat.js and Your trips).
export { kChatRead, lastReadOf, markReadTo } from "./chat-read.js";
import { lastReadOf } from "./chat-read.js";

const STYLE = `
[data-chat-unread] a.st-row[href="#/chat"]::after {
  content: "New"; margin-left: auto; padding: 2px 8px; border-radius: 999px; font-size: 12px;
  font-weight: 700; background: var(--accent); color: var(--accent-ink); }
`;

let unread = false;
let checking = null;

function inChat() { return /^#\/chat\/?$/.test(location.hash); }

function paint() {
  const root = document.documentElement;
  root.toggleAttribute("data-chat-unread", unread);
  const inBar = !!document.querySelector('.tabbar .tab[data-tab="chat"]');
  root.toggleAttribute("data-chat-off-bar", !inBar);
  const tab = document.querySelector('.tabbar .tab[data-tab="chat"]');
  if (tab) {
    tab.toggleAttribute("data-new", unread);         // the tab's own dot (public/ds/shell.css .ds-tab-dot)
    const word = tab.textContent.trim();
    if (unread) tab.setAttribute("aria-label", `${word}, new messages`);
    else tab.removeAttribute("aria-label");
  }
  // More's name says what its own dot stands for (tabs.js).
  labelOther();
}

function set(on) {
  if (on && inChat()) on = false;      // the chat is open: its messages are being read
  if (on === unread) return;
  unread = on;
  paint();
}

/** The counter moved to `seq`: is there a message from someone else past where reading stopped? */
async function check(seq) {
  if (!TRIP) return;
  const me = store.me().id;
  if (!me) return;
  const last = lastReadOf(TRIP, me);
  if (!Number.isInteger(seq) || seq <= last) { set(false); return; }
  if (checking) return;
  checking = (async () => {
    try {
      // Everything the chat changed since reading stopped, a page at a time: a message from someone
      // else, not deleted, past that point, and not one made from a note on a plan (migration
      // 0027: words everyone had read as notes) is new.
      let after = last;
      for (let page = 0; page < 20; page++) {
        const res = await fetchWithin(tripApi(TRIP, `/messages?after=${after}&limit=100`), { credentials: "same-origin", headers: { Accept: "application/json" } });
        if (!res.ok) return;
        const { messages, more } = await res.json();
        if (messages.some((m) => m.author !== me && !m.deleted && !m.from_note && m.seq > last)) { set(true); return; }
        if (!more || !messages.length) break;
        after = messages.reduce((n, m) => Math.max(n, m.touched), after);
      }
      set(false);
    } catch { /* no signal: the next poke or poll asks again */ }
  })();
  try { await checking; } finally { checking = null; }
}

if (TRIP && typeof document !== "undefined") {
  const s = document.createElement("style");
  s.dataset.chatDot = "1";
  s.textContent = STYLE;
  document.head.append(s);
  live.on("chat", (at) => check(at.seq));
  // Without a socket: ask the counter now and then, while the page is visible.
  setInterval(async () => {
    if (document.visibilityState !== "visible" || live.state().status === "open") return;
    try {
      const res = await fetchWithin(tripApi(TRIP, "/rev"), { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (res.ok) check((await res.json()).seq);
    } catch { /* no signal */ }
  }, POLL_MS);
  // What waits in the chat's outbox goes when there is signal, whether or not the chat is opened:
  // a few seconds after launch (the app's own reads first) and whenever the signal returns. The
  // chat's module is loaded for it only when this trip's chat database exists, where the browser
  // can say (chat.js opens the database itself: opening it here would make it without its stores).
  const sendChatWaiting = async () => {
    try {
      if (indexedDB.databases) {
        const names = (await indexedDB.databases()).map((d) => d.name);
        if (!names.includes(dbName("wegoplace-chat", TRIP))) return;
      }
      await (await import("./chat.js")).sendWaiting();
    } catch (e) { console.warn("[chat-dot] couldn't send what waits", e); }
  };
  setTimeout(sendChatWaiting, 2500);
  addEventListener("online", sendChatWaiting);
  addEventListener("hashchange", () => { if (inChat()) set(false); else paint(); });
  addEventListener("wgp:chat-read", () => set(false));
  // The bar can be rearranged: paint again when it is.
  new MutationObserver(() => paint()).observe(document.querySelector(".tabbar") ?? document.body, { childList: true, subtree: false });
}

/** For the checks. */
export const chatDotState = () => ({ unread, trip: TRIP });

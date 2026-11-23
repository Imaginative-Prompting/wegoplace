// Where reading a trip's chat stopped, per person per trip, on this phone: the newest message's
// order (seq) seen. The chat marks it (chat.js), the unread dot reads it (chat-dot.js), and Your
// trips compares each trip's newest message from someone else with it (trips.js). Pure: no
// imports, nothing runs on import.

export const kChatRead = (trip, me) => `wgp.chat.read:${trip}:${me ?? ""}`;

export function lastReadOf(trip, me) {
  const key = kChatRead(trip, me);
  try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; }
}

/** Marks reading as far as `seq` (never back), and tells the dot. */
export function markReadTo(trip, me, seq) {
  const key = kChatRead(trip, me);
  try { if (seq > lastReadOf(trip, me)) localStorage.setItem(key, String(seq)); } catch { /* private mode */ }
  dispatchEvent(new Event("wgp:chat-read"));
}

// How far a person has looked at a trip's list of changes, on this phone: the rev of the newest
// line they have seen. The list marks it (changes.js), the mark on Other reads it
// (changes-dot.js). Pure: no imports, nothing runs on import.

export const kChangesSeen = (trip, me) => `wgp.changes.seen:${trip}:${me ?? ""}`;

export function changesSeenOf(trip, me) {
  const key = kChangesSeen(trip, me);
  try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; }
}

/** Marks the list seen as far as `rev` (never back), and tells the mark. */
export function markChangesSeen(trip, me, rev) {
  const key = kChangesSeen(trip, me);
  try { if (rev > changesSeenOf(trip, me)) localStorage.setItem(key, String(rev)); } catch { /* private mode */ }
  dispatchEvent(new Event("wgp:changes-seen"));
}

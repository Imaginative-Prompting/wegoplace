// The mark that says a connected app changed something on the trip since this person last
// looked at the list of changes: a dot on your picture (More, tabs.js labelOther) and "New" on
// More's Changes row (settings.js paints it from [data-changes-new]), with "new changes" in More's accessible name.
// A dot and words, never a tint alone.
//
// Loaded by the shell on a trip's page. It asks nothing of its own: the trip's snapshot carries
// `trip.newest_change` (the rev of the newest line this person has something to notice in; an
// undo they pressed themselves in the app is not one), and the store reads the snapshot again
// within seconds of a write (the trip's socket). changes-seen.js keeps how far they have looked.

import { store } from "./store.js";
import { labelOther } from "./tabs.js";
import { changesSeenOf } from "./changes-seen.js";
import { tripIdFromPath } from "./trip-here.js";

const TRIP = tripIdFromPath(globalThis.location?.pathname ?? "");

let marked = false;
const inList = () => /^#\/changes\/?$/.test(location.hash);

function check() {
  const me = store.me().id;
  const newest = store.trip()?.newest_change;
  const on = !!me && Number.isInteger(newest) && newest > changesSeenOf(TRIP, me) && !inList();
  if (on === marked) return;
  marked = on;
  document.documentElement.toggleAttribute("data-changes-new", on);
  labelOther();
}

if (TRIP && typeof document !== "undefined") {
  store.on("change", check);
  addEventListener("wgp:changes-seen", check);
  addEventListener("hashchange", check);
  check();
}

/** For the checks. */
export const changesDotState = () => ({ marked, trip: TRIP });

import { MAP_CUTTING_STALE_S } from "../../public/js/shared/limits.js";

// The trip's map as the snapshot says it (docs/API.md "The trip's map"): null when there is none
// and none is being made; else its state, the version that changes with each new map (a phone
// keeps the new one when it changes), its size (a phone asks before keeping an uploaded one over
// its budget), when it was made, where it came from, what to tell people, and the label fonts'
// ranges it needs offline.
export function tilesShape(t, now = Math.floor(Date.now() / 1000)) {
  let state = t.tiles_state ?? (t.tiles ? "ready" : "none");
  if (!t.tiles && state === "none" && !t.tiles_note) return null;
  // A cut that stopped where nothing could record it (MAP_CUTTING_STALE_S): failed, in words.
  if (state === "cutting" && Number.isInteger(t.tiles_at) && now - t.tiles_at > MAP_CUTTING_STALE_S) {
    state = "failed";
    t = { ...t, tiles_note: `Making this trip's map stopped before it finished. The app draws its own ground until a map is made again: ${t.tiles ? "the last map stays in use, and " : ""}the next change to the trip's areas makes one, or the host can ask for a new one.` };
  }
  let glyphs = [];
  try { glyphs = t.tiles_glyphs ? JSON.parse(t.tiles_glyphs) : []; } catch { glyphs = []; }
  return {
    state, version: t.tiles_version ?? null, bytes: t.tiles_bytes ?? null, at: t.tiles_at ?? null,
    source: t.tiles_source ?? null, note: t.tiles_note ?? "", glyphs, ready: Boolean(t.tiles),
  };
}

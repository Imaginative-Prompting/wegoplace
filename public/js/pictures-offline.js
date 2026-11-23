// The trip's pictures, kept on this phone (model §6): every place's and event's picture and the
// trip's cover, pinned in the service worker's media cache so a place's photograph is there with
// no signal, as the old photographs were (sw.js precached all of public/img). A pin is never
// evicted (sw.js media cache), and a picture is at most 600 KB, so a trip's set is a few MB.
//
// It follows the trip: a picture added (here, on another phone, by an AI app) is pinned the next
// time the trip changes with signal; one replaced or removed is unpinned, and the cache's LRU frees
// it when it wants the room. What it pinned is remembered per trip in localStorage ("wgp." keys go
// on sign-out, with the media cache itself: forget.js).
//
// Started by the shell (index.html) once the store is ready. Without a service worker (a first
// visit, a browser that has none) it does nothing, and the pictures load from the network.

import { mediaCache } from "./memories-save.js";
import { pictureOf } from "./shared/photo.js";
import { tripKey } from "./trip-here.js";

// What this phone pinned, per trip ("wgp.pics@<trip>"), named as forget_check reads keys: a
// constant, through here().
const PICS_KEY = "wgp.pics";

const keyOf = (url) => (typeof url === "string" && url.startsWith("/media/") ? url.slice("/media/".length) : null);

/** Every picture the trip shows: [{ key, bytes, mime }]. */
function picturesOf(store) {
  const out = new Map();
  const add = (pic) => { const key = pic && keyOf(pic.url); if (key) out.set(key, { key, bytes: pic.bytes || 0, mime: pic.mime || "" }); };
  for (const p of store.places()) add(pictureOf(p));
  for (const e of store.events()) add(pictureOf(e));
  const trip = store.trip();
  if (trip && trip.cover) add(trip.cover);
  return [...out.values()];
}

export function keepPicturesOffline(store) {
  const here = (k) => tripKey(k, store.tripId());
  let held;
  try { held = new Set(JSON.parse(localStorage.getItem(here(PICS_KEY)) || "[]")); } catch { held = new Set(); }
  let running = false;
  let again = false;
  async function sync() {
    if (running) { again = true; return; }
    running = true;
    try {
      const now = picturesOf(store);
      const keys = new Set(now.map((x) => x.key));
      const gone = [...held].filter((k) => !keys.has(k));
      const fresh = now.filter((x) => !held.has(x.key));
      if (!fresh.length && !gone.length) return;
      // The worker classifies a /media/ file by the bytes it was told: register first.
      if (fresh.length) {
        await mediaCache.register(fresh);
        const r = await mediaCache.pin(fresh.map((x) => x.key));
        // No signal, or no worker yet: tried again at the next change.
        if (!r || r.ok === false) return;
      }
      if (gone.length) await mediaCache.unpin(gone);
      held = keys;
      try { localStorage.setItem(here(PICS_KEY), JSON.stringify([...held])); } catch { /* private mode: pinned again next time */ }
    } catch (e) {
      console.warn("[pictures-offline]", e);
    } finally {
      running = false;
      if (again) { again = false; sync(); }
    }
  }
  let timer = 0;
  const soon = () => { clearTimeout(timer); timer = setTimeout(sync, 1500); };
  store.on("change", soon);
  addEventListener("online", soon);
  soon();
  /** For the checks: what this phone has pinned. */
  return { held: () => [...held] };
}

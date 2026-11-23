// The pictures people drew, as every face in the app shows them. A person's row carries the picture's hash only when
// they have drawn one (rosters and /api/me: `avatar`), and the picture is fetched by it: GET /api/avatars/<hash>,
// read by the format the server checks it with (shared/avatar.js).
//
// A hash names one picture forever (its bytes never change), so a picture is kept once fetched: in memory for this
// page, and in this phone's Cache Storage, so a face drawn once is drawn again with no signal. It is a person's
// picture, so signing out takes the cache with it (forget.js, PRIVATE_CACHES). And it is kept for the account that
// was let see it: each entry is filed under who is signed in (the readable wgp_who cookie), so another account on the
// same phone never reads it, and asks the server, which refuses someone on no shared trip. With no one known, nothing
// is kept or read back.
//
// Someone who never draws changes nothing: a face with no hash gets no holder (pictureHolder returns ""), and nothing
// is fetched.
//
//   pictureHolder(hash)   the markup to put inside a face: the picture at once when this page already has it, else an
//                         empty holder that wakePictures fills; "" for no hash (the initials, as always)
//   wakePictures(root)    fills the holders under root, each with a short cross-fade over the initials
//   pictureOf(hash)       the drawing (drawing.js's shape), or null
//   pictureInto(face, h)  a face already on screen (yours at the top right): the picture a hash names, or the
//                         initials again for none
//   forgetPicture(hash)   drops one from this page's memory (a picture replaced)
import { decode, isDrawingHash } from "./shared/avatar.js";
import { fetchWithin } from "./net.js";
import { sessionAccount } from "./forget.js";
import { checkDrawing, pictureSvg } from "../ds/drawing.js";
import { setFaceDrawing, wakeFaces } from "../ds/avatar.js";

export const PICTURES_CACHE = "wegoplace-pictures-v1";
const known = new Map();            // hash -> drawing | null, once asked
const asking = new Map();           // hash -> the promise while it is fetched
const address = (hash) => `/api/avatars/${hash}`;
/** Where a picture is kept for whoever is signed in, or null when nobody is known. */
const keptAt = (hash) => { const who = sessionAccount(); return who ? `${address(hash)}?for=${encodeURIComponent(who)}` : null; };

async function fromCache(hash) {
  const at = keptAt(hash);
  if (typeof caches === "undefined" || !at) return null;
  try {
    const hit = await caches.match(at, { cacheName: PICTURES_CACHE });
    return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
  } catch { return null; }
}
async function keep(hash, bytes) {
  const at = keptAt(hash);
  if (typeof caches === "undefined" || !at) return;
  try {
    const c = await caches.open(PICTURES_CACHE);
    await c.put(at, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
  } catch { /* a phone out of room keeps the face as initials until it is asked again */ }
}

/** The drawing a hash names, or null (no picture, a refusal, no signal and nothing kept). Never throws. */
export function pictureOf(hash) {
  const h = isDrawingHash(hash);
  if (!h) return Promise.resolve(null);
  if (known.has(h)) return Promise.resolve(known.get(h));
  if (asking.has(h)) return asking.get(h);
  const p = (async () => {
    let bytes = await fromCache(h);
    if (!bytes) {
      try {
        const res = await fetchWithin(address(h), { credentials: "same-origin" });
        if (res.ok) {
          bytes = new Uint8Array(await res.arrayBuffer());
          // Bytes that aren't a picture are answered once, with the initials, like a refusal: asking again for the
          // same hash would only fetch the same bytes.
          if (decode(bytes)) await keep(h, bytes);
          else { known.set(h, null); bytes = null; }
        } else if (res.status === 404) {
          known.set(h, null);    // a picture this person may not see, or one deleted: initials, and not asked again
        }
      } catch { /* no signal: initials now, asked again by the next face that wants it */ }
    }
    const drawing = bytes ? checkDrawing(decode(bytes)) : null;
    if (drawing) known.set(h, drawing);
    asking.delete(h);
    return drawing;
  })();
  asking.set(h, p);
  return p;
}

/** The picture now, if this page already has it; undefined otherwise. */
export function pictureNow(hash) {
  const h = isDrawingHash(hash);
  return h && known.has(h) ? known.get(h) : undefined;
}

/** What goes inside a face for a hash: the picture now if it is here, an empty holder if not, "" for none. */
export function pictureHolder(hash) {
  const h = isDrawingHash(hash);
  if (!h) return "";
  const now = known.get(h);
  if (now) return `<span class="ds-face-pic" data-ready>${pictureSvg(now)}</span>`;
  if (known.has(h)) return "";
  return `<span class="ds-face-pic" data-face-hash="${h}"></span>`;
}

/** Fills the empty holders under root. */
export function wakePictures(root = document) {
  wakeFaces(root, pictureOf);
}

/** A face already on screen shows the picture `hash` names, or its initials again for none. */
export function pictureInto(face, hash) {
  if (!face) return;
  const h = isDrawingHash(hash) || "";
  if ((face.dataset.pic || "") === h) return;
  face.dataset.pic = h;
  if (!h) { setFaceDrawing(face, null); return; }
  pictureOf(h).then((d) => { if (face.dataset.pic === h) setFaceDrawing(face, d); });
}

/** Forgets one picture on this page (after it is replaced, so the next face asks again). */
export function forgetPicture(hash) {
  const h = isDrawingHash(hash);
  if (h) { known.delete(h); asking.delete(h); }
}

/** Puts a picture in hand into this page's memory under its hash (just saved: no fetch for one's own). */
export function rememberPicture(hash, drawing) {
  const h = isDrawingHash(hash), d = checkDrawing(drawing);
  if (h && d) known.set(h, d);
}

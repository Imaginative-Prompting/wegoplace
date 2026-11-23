// The photograph to draw for a place, an event or the trip, and what credits it.
//
// A row's PICTURE is the one the pictures route keeps (src/trips/pictures.js; model §6): set in
// the app, through an upload link, or by an AI app (set_picture), stored once, counted in the
// host's storage, with its license, credit and source. The snapshot carries it on each place and
// event (`picture`) and on the trip (`cover`): { url, width, height, license, credit, source, … }.
//
// THE OLD COLUMNS (image_url, image_license, image_credit, image_source; migration 0003) are the
// first trip's photographs from before there were pictures, files in public/img/ that the cutover
// sends through the pictures route (its step 8) and then takes out of the site (step 10). Until a
// row has been moved they still draw, so nothing goes blank on the way.
//
// WHEN A ROW HAS BOTH, THE PICTURE WINS: it is the one a person or an app chose most recently,
// through the one route that stores pictures now, and it is what survives the cutover; the old
// columns are only what the seed put there. A row with an old address and no license is a data
// bug (migration 0003) and draws nothing, as before.

/** A picture as the snapshot carries it, or null. */
export function pictureOf(row) {
  const pic = row && row.picture;
  return pic && typeof pic === "object" && typeof pic.url === "string" && pic.url ? pic : null;
}

/**
 * What to draw for a place: { card, hero, credit } or null. `card` is the smaller file where there
 * are two (the old columns' ~640px crop); a picture is one file, made to its size on the phone or
 * by the server, so both are its address.
 */
export function placePhoto(p) {
  const pic = pictureOf(p);
  if (pic) return { card: pic.url, hero: pic.url, width: pic.width || 0, height: pic.height || 0, credit: creditOf(pic) };
  if (!p || !p.image_url || !p.image_license) return null;
  const card = String(p.image_url);
  return {
    card,
    // image_hero is not a column (migration 0003 predates it): its address is the card's with
    // -card.webp swapped for -hero.webp (docs/CONTRACTS.md, images).
    hero: p.image_hero || (/-card\.webp$/.test(card) ? card.replace(/-card\.webp$/, "-hero.webp") : card),
    width: 0, height: 0,
    credit: { license: p.image_license, credit: p.image_credit || "", source: p.image_source || "" },
  };
}

/** What to draw for an event: its own picture, else its place's photograph. */
export function eventPhoto(e, place) {
  const pic = pictureOf(e);
  if (pic) return { card: pic.url, hero: pic.url, width: pic.width || 0, height: pic.height || 0, credit: creditOf(pic) };
  return placePhoto(place);
}

/** The trip's cover: { url, width, height, credit } or null. */
export function coverOf(trip) {
  const c = trip && trip.cover;
  return c && typeof c.url === "string" && c.url ? { url: c.url, width: c.width || 0, height: c.height || 0, credit: creditOf(c) } : null;
}

/** A picture's license, credit and source, as the credits page lists them ("own": your own photo). */
export function creditOf(pic) {
  return { license: pic.license || "", credit: pic.credit || "", source: pic.source || "" };
}

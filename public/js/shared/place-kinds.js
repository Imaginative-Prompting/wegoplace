// Place kinds and subkinds: the one list, and the two readers of it.
//
// Pure: no DOM, no fetch, no imports. The Worker imports this file to check what a person or
// an AI writes; the app imports it to draw what was written. One list, so the server can never
// accept a subkind the app has no word and no glyph for.
//
// A place has a KIND and a SUBKIND.
//
//   kind      one of seven, fixed: it is why you would go there. It picks the chip the place
//             is found under and the color it is drawn in.
//   subkind   one of the list below: it is what the place is. It picks the glyph and the word
//             on the row. Each subkind has a HOME kind, the kind its row of the list sits
//             under.
//
// Cuisine, style and every other flavor is a tag, never a subkind: "restaurant" with the tag
// "seafood", not "seafood_restaurant". That is what keeps the list short enough to read in an
// error message, and it is the rule that was missing when the first trip's research came back
// with eleven spellings of "a restaurant".
//
// THE READER, and a speller:
//
//   readPlaceKind(kind, subkind)      STRICT, for everything written. The exact ids or a
//                                     refusal that carries the list, so an AI that guessed
//                                     corrects itself on the next call.
//   spelledSubkind(word)              the list's id for a word written in another case or
//                                     with spaces or hyphens ("Ice Cream" is ice_cream), or
//                                     null. It never maps one word onto another.

/** The seven kinds, in the order the list below and the guides give them. */
export const PLACE_KINDS = ["lodging", "food", "drink", "sight", "activity", "transit", "practical"];

/** What each kind is for, in the guides' words. A refusal of a kind prints them. */
export const KIND_COVERS = {
  lodging: "where they sleep",
  food: "where they'd eat",
  drink: "where they'd go for the drink",
  sight: "something to see",
  activity: "something to do",
  transit: "how they arrive, leave and get around",
  practical: "everything that keeps the trip running: cash, pharmacy, medical, groceries, laundry, phone, luggage storage, gear, toilets, police",
};

// [id, home kind, label, what it covers]
const LIST = [
  ["hotel", "lodging", "Hotel", "Hotels, guesthouses, inns, resorts"],
  ["hostel", "lodging", "Hostel", "Hostels and dorm beds"],
  ["apartment", "lodging", "Apartment", "A rented apartment, house or room"],
  ["campsite", "lodging", "Campsite", "Campsites, and camps on a trek"],
  ["cabin", "lodging", "Cabin", "Mountain huts, lodges, cabins"],

  ["restaurant", "food", "Restaurant", "Anywhere you sit down to a meal; the cuisine goes in tags"],
  ["cafe", "food", "Café", "Cafés, coffee shops, breakfast and brunch places"],
  ["bakery", "food", "Bakery", "Bakeries and pastry shops"],
  ["ice_cream", "food", "Ice cream", "Ice cream, gelato, dessert shops"],
  ["street_food", "food", "Street food", "Stalls, carts, food trucks, takeaway counters"],
  ["market", "food", "Market", "Food markets and market halls"],

  ["bar", "drink", "Bar", "Bars, pubs, cocktail bars, rooftop bars"],
  ["winery", "drink", "Winery", "Wineries, vineyards, distilleries, tasting rooms"],
  ["brewery", "drink", "Brewery", "Breweries, taprooms, beer halls"],

  ["viewpoint", "sight", "Viewpoint", "Lookouts, overlooks, a view worth stopping for"],
  ["museum", "sight", "Museum", "Museums, galleries, exhibitions"],
  ["ruin", "sight", "Ruins", "Ruins and archaeological sites"],
  ["church", "sight", "Church", "Churches, cathedrals, chapels, monasteries"],
  ["temple", "sight", "Temple", "Temples and pagodas"],
  ["mosque", "sight", "Mosque", "Mosques"],
  ["synagogue", "sight", "Synagogue", "Synagogues"],
  ["shrine", "sight", "Shrine", "Shrines"],
  ["castle", "sight", "Castle", "Castles, palaces, forts"],
  ["landmark", "sight", "Landmark", "Monuments, statues, towers, famous buildings; a place of worship that is none of the five above"],
  ["plaza", "sight", "Plaza", "Squares and plazas"],
  ["park", "sight", "Park", "Parks and gardens"],
  ["beach", "sight", "Beach", "Beaches"],
  ["nature", "sight", "Nature", "Waterfalls, lakes, caves, canyons"],
  ["mountain", "sight", "Mountain", "Peaks, passes, volcanoes"],
  ["town", "sight", "Town", "Villages, old towns, neighborhoods, a famous street"],
  ["bridge", "sight", "Bridge", "Bridges"],
  ["zoo", "sight", "Zoo", "Zoos, aquariums, wildlife reserves"],

  ["tour", "activity", "Tour", "Guided tours, day trips, a tour operator's office"],
  ["cooking_class", "activity", "Cooking class", "Cooking classes, tastings, workshops"],
  ["hike", "activity", "Hike", "Hikes and walks"],
  ["boat_trip", "activity", "Boat trip", "Boat trips, cruises, paddling"],
  ["adventure", "activity", "Adventure", "Paragliding, zip lines, rafting, climbing, buggies"],
  ["water_sport", "activity", "Water sport", "Surfing, diving, snorkeling, swimming spots"],
  ["snow_sport", "activity", "Snow sport", "Ski areas, sledding, ice rinks"],
  ["show", "activity", "Show", "Theater, music, a match"],
  ["spa", "activity", "Spa", "Spas, baths, hot springs"],
  ["shopping", "activity", "Shopping", "Shops, malls, souvenir and craft markets"],
  ["theme_park", "activity", "Theme park", "Theme parks, water parks, fairs"],

  ["airport", "transit", "Airport", "Airports and airfields"],
  ["train_station", "transit", "Train station", "Train stations"],
  ["bus_station", "transit", "Bus station", "Bus stations, terminals, stops"],
  ["metro", "transit", "Metro", "Metro, subway and tram stops"],
  ["ferry", "transit", "Ferry", "Ferries, piers, ports"],
  ["taxi", "transit", "Taxi", "Taxi ranks, pickup points"],
  ["car_rental", "transit", "Car rental", "Car, scooter and bike rental"],
  ["parking", "transit", "Parking", "Car parks and parking lots"],
  ["cable_car", "transit", "Cable car", "Cable cars, funiculars, gondolas"],
  ["trailhead", "transit", "Trailhead", "Where a trail starts or ends"],
  ["border", "transit", "Border", "Border crossings, checkpoints, entry controls"],
  ["ticket_office", "transit", "Ticket office", "Where tickets and permits are bought or collected"],

  ["atm", "practical", "ATM", "Cash machines and bank branches"],
  ["money_exchange", "practical", "Money exchange", "Currency exchange"],
  ["pharmacy", "practical", "Pharmacy", "Pharmacies and drugstores"],
  ["clinic", "practical", "Clinic", "Clinics, doctors, urgent care"],
  ["hospital", "practical", "Hospital", "Hospitals and emergency rooms"],
  ["dentist", "practical", "Dentist", "Dentists"],
  ["police", "practical", "Police", "Police stations, tourist police"],
  ["embassy", "practical", "Embassy", "Embassies and consulates"],
  ["supermarket", "practical", "Supermarket", "Supermarkets and grocery stores"],
  ["convenience", "practical", "Convenience store", "Convenience stores, minimarkets, kiosks"],
  ["water", "practical", "Water", "Drinking water: fountains and refill points"],
  ["laundry", "practical", "Laundry", "Laundromats and laundry services"],
  ["sim", "practical", "SIM card", "Phone shops: SIM cards, eSIMs, top-ups"],
  ["luggage_storage", "practical", "Luggage storage", "Left luggage and lockers"],
  ["outdoor_gear", "practical", "Outdoor gear", "Gear shops and gear rental"],
  ["hardware", "practical", "Hardware store", "Hardware stores and repairs"],
  ["fuel", "practical", "Fuel", "Fuel stations and chargers"],
  ["toilets", "practical", "Toilets", "Public toilets"],
  ["shower", "practical", "Showers", "Public showers"],
  ["tourist_office", "practical", "Tourist office", "Tourist information"],
];

/** Every subkind, in list order: `{ id, kind (its home), label, covers }`. */
export const SUBKINDS = Object.freeze(LIST.map(([id, kind, label, covers]) => Object.freeze({ id, kind, label, covers })));

const BY_ID = new Map(SUBKINDS.map((s) => [s.id, s]));

/** One subkind's entry, or null. Exact ids only. */
export function subkind(id) {
  return BY_ID.get(id) || null;
}

/**
 * The word a person reads for a subkind: the list's own label. A word not on the list (a row
 * from before it) is shown as it was written, with a capital. Every
 * screen that names a subkind asks here, so a row, the map and the sheet that chose it say
 * the same word.
 */
export function subkindLabel(word) {
  const hit = BY_ID.get(word);
  if (hit) return hit.label;
  return String(word || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^./, (c) => c.toUpperCase());
}

/** The ids whose home is `kind`, in list order. */
export function subkindsOf(kind) {
  return SUBKINDS.filter((s) => s.kind === kind).map((s) => s.id);
}

/** The whole list, one line per home kind: what a refusal carries, and what the guides print. */
export const SUBKIND_LIST = PLACE_KINDS.map((k) => `${k}: ${subkindsOf(k).join(", ")}`).join("\n");

// ── the strict reader ─────────────────────────────────────────────────────────────────────

/**
 * A kind and a subkind as they must be written from now on. Returns `{ ok: true, kind,
 * subkind }` or `{ ok: false, error }`, where the error is a sentence for whoever wrote it
 * and carries the list.
 *
 * The kind and the subkind are checked on their own: a market may be filed under food, sight
 * or practical, a viewpoint under transit when it is seen from the train. The home kind only
 * says where a subkind sits in the list.
 */
export function readPlaceKind(kind, subkind) {
  if (typeof kind !== "string" || !PLACE_KINDS.includes(kind)) return { ok: false, error: notAKind(kind) };
  if (typeof subkind !== "string" || !BY_ID.has(subkind)) {
    // Right word, wrong spelling (a capital, a space, a hyphen): say how it is written. Any other word: the list.
    const near = typeof subkind === "string" ? spelledSubkind(subkind) : null;
    const fix = near ? ` Write it as "${near}".` : " Pick the closest one.";
    return {
      ok: false,
      error: `${show(subkind)} is not on the list of subkinds.${fix} Cuisine and other flavor go in tags. The list, by kind:\n${SUBKIND_LIST}`,
    };
  }
  return { ok: true, kind, subkind };
}

// What was written, as it was written: a trailing space or a capital is the whole mistake, so
// it has to be visible in the sentence.
const show = (v) => (typeof v === "string" && v !== "" ? JSON.stringify(v.slice(0, 40)) : "Nothing");

function notAKind(kind) {
  const k = typeof kind === "string" ? spelled(kind) : "";
  return `${show(kind)} is not a kind of place.`
    + (PLACE_KINDS.includes(k) ? ` Write it as "${k}".` : "")
    + ` The kind says why they'd go there: ${PLACE_KINDS.map((x) => `${x} (${KIND_COVERS[x]})`).join("; ")}.`;
}

// ── spelling ────────────────────────────────────────────────────────────────────────────

const spelled = (s) => String(s || "").trim().toLowerCase().replace(/[\s-]+/g, "_");

/** The list's id for a word written in another case or with spaces or hyphens, or null. */
export function spelledSubkind(word) {
  const s = spelled(word);
  return s && BY_ID.has(s) ? s : null;
}

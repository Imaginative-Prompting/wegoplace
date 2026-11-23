#!/usr/bin/env node
// A made-up trip the size of the first one, for every check and lane that needs a big trip
// (docs/open-source-scrub.md, step 1): seed/demo-trip.json, the same file every time (a seeded random
// number), nothing in it from any real trip. Its places and people are invented; its regions sit over
// the stretch of the world check:map's stand-in covers, so a map can be cut for it.
//
//   node tools/demo-seed.mjs [--out seed/demo-trip.json] [--check]
//
// --check: exit 1 when the file isn't what the generator makes (a hand edit, or the generator
// changed without writing it again).
//
// What it holds, as the first trip did: 4 regions with bounds and 11 areas under them; 331 places
// in the same mix of kinds (most of them practical: the bank machines, pharmacies and laundries
// near where people stay), with hours, tags, anchors and the places near them; 60 events over
// twelve days (flights from another zone, stays, meals, transit, activities, a trek); two packing
// lists and a daily one, and ten starters; four made-up people (each with a color of their own), 42 purchases split every way Split
// can, three payments, 40 packing items and 13 pictures, which tools/demo-fill.mjs writes as each
// person (the seed tool, tools/seed-trip.mjs, puts in the rest as the host).

import fs from "node:fs";
import path from "node:path";
import { SUBKINDS } from "../public/js/shared/place-kinds.js";
import { NOTE_COLORS } from "../src/api/trip.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** A seeded random number in [0, 1): the same sequence for the same seed. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Invented words: none is a place, a business or a person.
const FIRST = ["Lumbre", "Viento", "Brisa", "Ceniza", "Alba", "Nube", "Roca", "Sauce", "Ámbar", "Coral", "Musgo", "Cobre", "Tejo",
  "Cardo", "Junco", "Olmo", "Nácar", "Garza", "Lince", "Trigo", "Salvia", "Pizarra", "Cedro", "Añil", "Sereno", "Rumor", "Ocre", "Cumbre"];
const SECOND = ["del Paso", "de la Loma", "Alto", "Sur", "del Río", "Viejo", "Nuevo", "del Valle", "de Piedra", "Claro", "Escondido",
  "del Cerro", "Grande", "Chico", "del Puerto", "Azul", "Verde", "Blanco", "de Abajo", "Mayor"];
// What a place is called, by its subkind: the word a sign there would say, and the word an
// English guide would use. A place with a local name (most of them, as on the first trip) is
// called in English with the local words as its local name ("Brisa Alto Pharmacy", local
// "Farmacia Brisa Alto"); the rest go by the local words alone. Either way the name says what
// the place is, so a pharmacy is never called a laundry.
const NAMES = {
  hotel: [["Hotel", "Hotel"], ["Posada", "Inn"]], hostel: [["Hostal", "Hostel"]], apartment: [["Departamento", "Apartment"], ["Casa", "House"]],
  campsite: [["Campamento", "Camp"]], cabin: [["Refugio", "Hut"], ["Cabaña", "Cabin"]],
  restaurant: [["Restaurante", "Restaurant"], ["Picantería", "Kitchen"], ["Cocina", "Kitchen"]], cafe: [["Café", "Café"]],
  bakery: [["Panadería", "Bakery"]], ice_cream: [["Heladería", "Ice Cream"]], street_food: [["Puesto", "Stall"], ["Carretilla", "Cart"]],
  market: [["Mercado", "Market"]],
  bar: [["Bar", "Bar"], ["Taberna", "Tavern"]], winery: [["Bodega", "Winery"], ["Viñedo", "Vineyard"]], brewery: [["Cervecería", "Brewery"]],
  viewpoint: [["Mirador", "Lookout"]], museum: [["Museo", "Museum"]], ruin: [["Ruinas", "Ruins"]], church: [["Iglesia", "Church"], ["Capilla", "Chapel"]],
  temple: [["Templo", "Temple"]], mosque: [["Mezquita", "Mosque"]], synagogue: [["Sinagoga", "Synagogue"]], shrine: [["Santuario", "Shrine"]],
  castle: [["Fortaleza", "Fort"], ["Castillo", "Castle"]], landmark: [["Torre", "Tower"], ["Monumento", "Monument"]], plaza: [["Plaza", "Square"]],
  park: [["Parque", "Park"], ["Jardín", "Garden"]], beach: [["Playa", "Beach"]], nature: [["Laguna", "Lagoon"], ["Cascada", "Falls"], ["Cañón", "Canyon"]],
  mountain: [["Cerro", "Hill"], ["Nevado", "Peak"]], town: [["Barrio", "Quarter"], ["Pueblo", "Village"]], bridge: [["Puente", "Bridge"]],
  zoo: [["Reserva", "Reserve"]],
  tour: [["Excursiones", "Tours"]], cooking_class: [["Escuela de Cocina", "Cooking School"]], hike: [["Sendero", "Trail"]],
  boat_trip: [["Paseos en Bote", "Boat Trips"]], adventure: [["Aventura", "Adventures"]], water_sport: [["Escuela de Surf", "Surf School"]],
  snow_sport: [["Pista", "Ski Slope"]], show: [["Teatro", "Theater"], ["Peña", "Music Hall"]], spa: [["Baños Termales", "Hot Springs"]],
  shopping: [["Feria", "Craft Market"], ["Galería", "Arcade"]], theme_park: [["Parque de Juegos", "Fun Park"]],
  airport: [["Aeropuerto", "Airport"]], train_station: [["Estación", "Station"]], bus_station: [["Terminal Terrestre", "Bus Station"]],
  metro: [["Paradero", "Tram Stop"]], ferry: [["Muelle", "Pier"]], taxi: [["Paradero de Taxis", "Taxi Rank"]],
  car_rental: [["Alquiler de Autos", "Car Rental"]], parking: [["Estacionamiento", "Parking"]], cable_car: [["Teleférico", "Cable Car"]],
  trailhead: [["Inicio del Sendero", "Trailhead"]], border: [["Control", "Checkpoint"]], ticket_office: [["Boletería", "Ticket Office"]],
  atm: [["Cajero", "ATM"]], money_exchange: [["Casa de Cambio", "Exchange"]], pharmacy: [["Farmacia", "Pharmacy"], ["Botica", "Pharmacy"]],
  clinic: [["Clínica", "Clinic"]], hospital: [["Hospital", "Hospital"]], dentist: [["Consultorio Dental", "Dental Clinic"]],
  police: [["Comisaría", "Police Station"]], embassy: [["Consulado", "Consulate"]], supermarket: [["Supermercado", "Supermarket"]],
  convenience: [["Minimarket", "Minimarket"], ["Kiosko", "Kiosk"]], water: [["Fuente", "Water Point"]], laundry: [["Lavandería", "Laundry"]],
  sim: [["Celulares", "Phone Shop"]], luggage_storage: [["Consigna", "Left Luggage"]], outdoor_gear: [["Equipos", "Outdoor Gear"]],
  hardware: [["Ferretería", "Hardware"]], fuel: [["Grifo", "Gas Station"]], toilets: [["Baños", "Restrooms"]], shower: [["Duchas", "Showers"]],
  tourist_office: [["Informes", "Tourist Office"]],
};
const WHY = {
  lodging: "Where the group sleeps in this part of the trip.", food: "Somewhere good to eat near where we stay.",
  drink: "A place for the evening.", sight: "Worth the walk.", activity: "Something to do on a free afternoon.",
  transit: "How we get in and out.", practical: "Close to where we stay, for the small things.",
};
const TAGS = ["cash-only", "cards-ok", "open-late", "open-early", "vegetarian-ok", "reserve-ahead", "wifi", "quiet", "busy-evenings", "uphill"];

const REGIONS = [
  { id: "costa", name: "Costa Alta", west: -77.2, south: -12.35, east: -76.82, north: -11.9 },
  { id: "valle-seco", name: "Valle Seco", west: -76.4, south: -14.3, east: -75.62, north: -13.72 },
  { id: "sierra", name: "Sierra Clara", west: -72.2, south: -13.75, east: -71.76, north: -13.35 },
  { id: "paso-alto", name: "Paso Alto", west: -72.62, south: -13.3, east: -72.45, north: -13.12 },
];
// The neighborhoods under them: [region, id, name].
const NEIGHBORHOODS = [
  ["costa", "costa-puerto", "El Puerto"], ["costa", "costa-loma", "La Loma"], ["costa", "costa-centro", "Centro"], ["costa", "costa-aeropuerto", "Airport"],
  ["valle-seco", "valle-dunas", "Las Dunas"], ["sierra", "sierra-centro", "Centro"], ["sierra", "sierra-barrio", "Barrio Alto"],
  ["sierra", "sierra-aeropuerto", "Airport"], ["sierra", "sierra-valle", "The valley"], ["paso-alto", "paso-trek", "The trek"], ["paso-alto", "paso-pueblo", "The village"],
];
// The first trip's mix of kinds, place for place, and how many of its places carry each field.
const MIX = { practical: 134, food: 63, sight: 62, transit: 26, activity: 19, lodging: 15, drink: 12 };
const HAVE = { hours: 193, tags: 317, name_local: 287, notes: 325, address_note: 257, website: 93, phone: 68, price_level: 82, rating: 12, elevation_m: 62 };
const CONFIDENCE = { high: 123, medium: 161, low: 47 };
// Where the stays go (each region has some), and the stations, with what each is: the two
// airports the flights land at, and a bus station in each region the long rides arrive in.
const STAYS = ["costa-puerto", "costa-loma", "costa-centro", "costa-puerto", "valle-dunas", "valle-dunas", "sierra-centro", "sierra-barrio",
  "sierra-centro", "sierra-valle", "sierra-barrio", "paso-pueblo", "paso-pueblo", "costa-loma", "sierra-valle"];
const STATIONS = [["costa-aeropuerto", "airport"], ["valle-dunas", "bus_station"], ["sierra-aeropuerto", "airport"], ["paso-pueblo", "bus_station"],
  ["costa-centro", "bus_station"], ["sierra-centro", "bus_station"]];
// The first practical places, what the plans need: the money changed on day 2 in Costa Alta,
// the laundry on day 10 in Sierra Clara.
const ERRANDS = [["costa-centro", "money_exchange"], ["sierra-centro", "laundry"]];
// Hours as the first trip has them: mostly the one format, some in an older spelling the seed tool
// respells, and a few it can't read as hours at all (they go to the notes).
const HOURS = ["Mon-Sat 08:00-20:00", "Tue-Sat 12:30-15:00, 19:00-23:00; Sun 12:30-16:00", "Daily 07:00-22:00", "Mon-Fri 09:00-18:00; Sat 09:00-13:00",
  "Daily 18:00-02:00", "24 hours", "Mo-Fr 9:00-18:00", "Monday to Saturday 9am-5pm; closed Sunday", "Approx Mo-Sa 09:00-18:00 (unverified)"];
const STREETS = ["Calle de los Sauces", "Avenida del Viento", "Jirón Cobre", "Pasaje Alba", "Calle Nube", "Avenida Ceniza", "Jirón Musgo", "Calle Real Chica"];

export function demoTrip(seed = 20270601) {
  const rnd = random(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const between = (a, b) => a + (b - a) * rnd();
  const round = (n, d = 5) => Math.round(n * 10 ** d) / 10 ** d;
  /** `count` of `list`, chosen by the seeded random number: the same ones every time. */
  const some = (list, count) => {
    const order = list.map((x) => [rnd(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
    return new Set(order.slice(0, count));
  };
  const areas = [
    ...REGIONS.map((r, i) => ({ ...r, sort: i + 1 })),
    ...NEIGHBORHOODS.map(([parent, id, name], i) => ({ id, name, parent, sort: i + 1 })),
  ];
  const regionOf = Object.fromEntries(NEIGHBORHOODS.map(([parent, id]) => [id, REGIONS.find((r) => r.id === parent)]));

  const places = [];
  for (const [kind, count] of Object.entries(MIX)) {
    const subkinds = SUBKINDS.filter((s) => s.kind === kind).map((s) => s.id);
    for (let i = 0; i < count; i++) {
      const fixed = kind === "transit" ? STATIONS[i] : kind === "practical" ? ERRANDS[i] : null;
      const area = kind === "lodging" ? STAYS[i] : fixed ? fixed[0] : kind === "sight" && i < 6 ? "paso-trek" : pick(NEIGHBORHOODS)[1];
      const r = regionOf[area];
      // A stay on the trek is a camp or a hut, in a town a hotel, a hostel or a flat; every
      // fourth eatery is a restaurant, the ones the meals are booked at.
      const subkind = fixed ? fixed[1]
        : kind === "lodging" ? (area.startsWith("paso-") ? ["campsite", "cabin"][i % 2] : ["hotel", "hostel", "apartment"][i % 3])
        : kind === "food" && i % 4 === 0 && i < 56 ? "restaurant" : pick(subkinds);
      places.push({
        id: `p-${String(places.length + 1).padStart(3, "0")}`, name: "", kind, subkind, area,
        address: `${pick(STREETS)} ${100 + Math.floor(rnd() * 900)}, ${areas.find((a) => a.id === area).name}, ${r.name}`,
        lat: round(between(r.south + 0.002, r.north - 0.002)), lng: round(between(r.west + 0.002, r.east - 0.002)),
        why: WHY[kind],
      });
    }
  }
  const has = Object.fromEntries(Object.entries(HAVE).map(([k, n]) => [k, some(places, n)]));
  // The names, from a random number of their own, so a change to the words moves nothing else:
  // the sign's words, and for a place with a local name the English one, the sign's words its
  // local name. No two places share either.
  const words = random(seed + 1);
  const choose = (list) => list[Math.floor(words() * list.length)];
  const taken = new Set();
  for (const p of places) {
    let local, english;
    do {
      const [es, en] = choose(NAMES[p.subkind]);
      const own = `${choose(FIRST)} ${choose(SECOND)}`;
      [local, english] = [`${es} ${own}`, `${own} ${en}`];
    } while (taken.has(local) || taken.has(english));
    taken.add(local); taken.add(english);
    if (has.name_local.has(p)) Object.assign(p, { name: english, name_local: local });
    else p.name = local;
  }
  // How sure the research was of each: the first trip's split, high, medium and low.
  const shuffled = [...some(places, places.length)];
  for (const [level, n] of Object.entries(CONFIDENCE)) for (const p of shuffled.splice(0, n)) p.confidence = level;
  for (const p of places) {
    if (has.hours.has(p)) p.hours = pick(HOURS);
    if (has.tags.has(p)) p.tags = [...new Set([pick(TAGS), pick(TAGS), ...(rnd() < 0.2 ? [pick(TAGS)] : [])])];
    if (has.notes.has(p)) p.notes = pick(["Ask for the table by the window.", "Closed on the first Monday of the month.", "Cash is quicker.", "Up the stairs from the square.", "Busy at lunch; fine after two."]);
    if (has.address_note.has(p)) p.address_note = pick(["The door beside the blue gate.", "Across from the fountain.", "Second floor.", "Behind the market."]);
    if (has.website.has(p)) p.website = `https://example.com/${p.id}`;
    // Made-up numbers in no country's plan (+00 is no country's code).
    if (has.phone.has(p)) p.phone = `+00 ${String(100 + Math.floor(rnd() * 900))} ${String(1000 + Math.floor(rnd() * 9000))}`;
    if (has.price_level.has(p)) p.price_level = 1 + Math.floor(rnd() * 4);
    if (has.rating.has(p)) { p.rating = Math.round(between(3.6, 4.9) * 10) / 10; p.rating_count = 5 + Math.floor(rnd() * 400); }
    if (has.elevation_m.has(p)) p.elevation_m = Math.round(regionOf[p.area].id === "costa" ? between(5, 160) : regionOf[p.area].id === "valle-seco" ? between(380, 520) : between(2400, 4600));
  }
  // 14 anchors (three stays and eleven sights); 255 places near one, in their own region, 244 with the walk.
  const anchors = [...places.filter((p) => p.kind === "lodging").filter((_, i) => [0, 6, 11].includes(i)), ...places.filter((p) => p.kind === "sight").slice(0, 11)];
  for (const p of anchors) p.is_anchor = true;
  const nearable = places.filter((p) => !p.is_anchor && anchors.some((a) => regionOf[a.area] === regionOf[p.area]));
  const near = some(nearable, 255);
  const walked = some([...near], 244);
  for (const p of nearable) {
    if (!near.has(p)) continue;
    p.near_anchor = pick(anchors.filter((a) => regionOf[a.area] === regionOf[p.area])).id;
    if (walked.has(p)) p.walk_minutes = 2 + Math.floor(rnd() * 14);
  }
  // Two stays with checkout steps.
  for (const p of places.filter((x) => x.kind === "lodging").slice(0, 2)) {
    p.checkout = [{ title: "Strip the beds" }, { title: "Keys to the front desk", detail: "Before eleven." }, { title: "Check the safe" }];
  }

  // Twelve days, 1 to 12 June 2027, in the trip's zone (UTC-5, no summer time); the flights there from
  // New York through a third zone, and home.
  const DAY0 = Date.UTC(2027, 5, 1, 5) / 1000;        // 00:00 on 1 June, UTC-5
  const at = (day, hour, minute = 0) => DAY0 + day * 86400 + hour * 3600 + minute * 60;
  const of = (kind, region) => places.filter((p) => p.kind === kind && (!region || regionOf[p.area].id === region));
  const events = [];
  const add = (kind, title, starts, extra = {}) => events.push({ id: `e-${String(events.length + 1).padStart(2, "0")}`, kind, title, starts_at: starts, tz: "America/Lima", ...extra });
  // A flight lands at its region's airport; a long ride ends at its region's bus station.
  const station = (region, subkind) => of("transit", region).find((p) => p.subkind === subkind);
  const airport = (region) => station(region, "airport").id;
  // Just after midnight in New York, a change of planes in a third zone, in by late morning.
  add("flight", "XY 100 to the connection", at(0, 0, 30), { tz: "America/New_York", ends_at: at(0, 4, 15), end_tz: "America/Mexico_City", detail: "Seats together, row 21." });
  add("flight", "XY 300 to Costa Alta", at(0, 6), { tz: "America/Mexico_City", ends_at: at(0, 11, 30), end_tz: "America/Lima", place_id: airport("costa"), detail: "The bags go through." });
  add("flight", "XY 210 to Sierra Clara", at(4, 16), { ends_at: at(4, 17, 25), place_id: airport("sierra"), detail: "One bag each in the hold." });
  add("flight", "XY 211 back to Costa Alta", at(10, 9, 30), { ends_at: at(10, 11), place_id: airport("costa"), detail: "Online check-in opens the day before." });
  add("flight", "XY 101 home", at(11, 23, 40), { ends_at: at(12, 7, 10), end_tz: "America/New_York", place_id: airport("costa"), detail: "Leave for the airport by 20:30." });
  const stayIn = (from, to, region, i) => {
    const p = of("lodging", region)[i];
    add("lodging", `Check in: ${p.name}`, at(from, 15), { ends_at: at(to, 11), place_id: p.id, detail: "Booked under the group." });
  };
  stayIn(0, 2, "costa", 0); stayIn(2, 4, "valle-seco", 0); stayIn(4, 6, "sierra", 0); stayIn(6, 8, "paso-alto", 0); stayIn(8, 9, "sierra", 1);
  stayIn(9, 10, "sierra", 2); stayIn(10, 11, "costa", 1); stayIn(1, 2, "costa", 2); stayIn(3, 4, "valle-seco", 1);
  // The four long rides between regions, then local rides on days of their own, in the region
  // the group is in that day.
  // The trek (days 5 to 8) starts with the bus out to it and ends with the bus back: a night bus,
  // 22:30 to 02:45, a plan that runs over midnight (the Agenda carries it onto the next day).
  const bus = [["costa", "valle-seco", 2, 6.5], ["valle-seco", "costa", 4, 6.5], ["sierra", "paso-alto", 5, 4.5], ["paso-alto", "sierra", 8, 22.5]];
  const regionOn = (d) => (d < 2 ? "costa" : d < 4 ? "valle-seco" : d < 6 ? "sierra" : d < 8 ? "paso-alto" : d < 10 ? "sierra" : "costa");
  // Not on the trek (days 5 to 8), and never two at once: morning, evening, later evening.
  const LOCAL_DAYS = [1, 3, 9, 11, 1, 3, 9, 11, 2, 9, 11];
  for (let i = 0; i < 15; i++) {
    if (i < bus.length) {
      const [from, to, day, hour] = bus[i];
      const stop = station(to, "bus_station");
      add("transit", `Bus from ${REGIONS.find((r) => r.id === from).name} to ${stop.name}`, at(day, Math.floor(hour), (hour % 1) * 60), {
        ends_at: at(day, Math.floor(hour) + 4, 15 + (hour % 1) * 60), place_id: stop.id, ...(i % 5 ? { detail: "Tickets in the shared folder." } : {}),
      });
    } else {
      const day = LOCAL_DAYS[i - bus.length];
      const stops = of("transit", regionOn(day));
      const stop = stops[(i + 1) % stops.length];
      const hour = [9, 17, 18][Math.floor((i - bus.length) / 4)];
      add("transit", `Colectivo to ${stop.name}`, at(day, hour, 15), {
        ...(i < 14 ? { ends_at: at(day, hour, 55) } : {}), place_id: stop.id, ...(i % 5 ? { detail: "Small change for the fare." } : {}),
      });
    }
  }
  const meals = of("food");
  // One meal a day, two on the first two days: a day's second is the other meal of the day.
  for (let i = 0; i < 14; i++) {
    const dinner = (i % 2 === 1) !== (i >= 12);
    add("meal", `${dinner ? "Dinner" : "Lunch"} at ${meals[i * 4].name}`, at(i % 12, dinner ? 20 : 13, 30), { place_id: meals[i * 4].id, ...(i % 7 ? { detail: "A table for the group." } : {}) });
  }
  const acts = [...of("activity"), ...of("sight", "paso-alto")];
  for (let i = 0; i < 14; i++) add("activity", i < 4 ? `The trek, day ${i + 1}` : acts[i].name, i < 4 ? at(5 + i, 0) : at([1, 2, 3, 9, 10, 11, 1, 2, 3, 9][i - 4], i < 10 ? 16 : 11), { ...(i < 4 ? { all_day: true } : {}), place_id: (i < 4 ? of("sight", "paso-alto")[i] : acts[i]).id, ...(i === 5 || i === 9 ? {} : { detail: i === 1 ? "The high pass: the warm layer in the daypack." : "Meet at the door." }) });
  // Packing at the night's stay; the money and the laundry at the two errands' places.
  const errand = (subkind) => of("practical").find((p) => p.subkind === subkind).id;
  [["Pack for the trek", 4, of("lodging", "sierra")[0].id], ["Change money", 1, errand("money_exchange")], ["Laundry", 9, errand("laundry")]].forEach(([title, day, place]) =>
    add("plan", title, at(day, 19), { place_id: place, detail: "Whoever's free." }));

  for (const e of events) if (e.ends_at !== undefined && e.ends_at <= e.starts_at) throw new Error(`demo-seed: ${e.id} ends before it starts`);
  // A day the agenda can read: no two timed things at once (a stay and a whole day aside; a
  // moment counts as an hour).
  const timed = events.filter((e) => !e.all_day && e.kind !== "lodging").map((e) => [e.starts_at, e.ends_at ?? e.starts_at + 3600, e.id]).sort((x, y) => x[0] - y[0]);
  let last = [0, 0, ""];
  for (const e of timed) {
    if (e[0] < last[1]) throw new Error(`demo-seed: ${last[2]} and ${e[2]} are at the same time`);
    if (e[1] > last[1]) last = e;
  }

  // ── the people and the money (written by tools/demo-fill.mjs, as each person) ─────────────
  // Four made-up people, the first the host. Shares name a person by key; the fill tool turns
  // each key into the account it made and works out the shares as the app does.
  // Each with a color of their own, SET (checks/lib/demo.mjs sends it as the person, PATCH /api/me): one the app draws
  // from an account's id changes at every start, since the ids are new each time, and every look at a board then reads
  // as changed (21 Nov, Project Overview's boards: AV green then pink). Four far apart, from the palette's own
  // spellings (src/api/trip.js NOTE_COLORS: the route takes those exactly).
  const people = [
    { key: "ada", name: "Ada Vale", host: true, color: "#0072B2" }, { key: "teo", name: "Teo Marsh", color: "#E69F00" },
    { key: "lin", name: "Lin Arbor", color: "#009E73" }, { key: "sol", name: "Sol Reyes", color: "#CC79A7" },
  ];
  for (const x of people) if (!NOTE_COLORS.includes(x.color)) throw new Error(`demo-seed: ${x.name}'s color ${x.color} isn't one of the palette's (src/api/trip.js)`);
  const everyone = people.map((x) => x.key);
  const dayOf = (d) => `2027-06-${String(d + 1).padStart(2, "0")}`;
  const mealEvents = events.filter((x) => x.kind === "meal");
  const busEvents = events.filter((x) => x.kind === "transit");
  // The shops a purchase can hang on, each with what is bought there.
  const BOUGHT = { supermarket: ["Water and snacks", "Groceries"], convenience: ["Water and snacks", "Batteries"], pharmacy: ["Sunscreen", "Bandages"],
    laundry: ["Laundry"], outdoor_gear: ["Gas canister", "Rain ponchos"], hardware: ["Batteries", "Padlock"], sim: ["SIM cards"], fuel: ["Fuel"] };
  const shops = of("practical").filter((p) => BOUGHT[p.subkind]);
  // Every way Split can split: evenly between all, between some, by weight, exact amounts, one
  // person alone, and a purchase logged by someone other than the person who paid.
  const WAYS = ["all", "all", "all", "some", "weights", "exact", "alone", "all", "some", "logged"];
  const purchases = [];
  for (let i = 0; i < 42; i++) {
    const way = WAYS[i % WAYS.length];
    const currency = i % 14 === 6 ? "EUR" : i % 8 === 3 ? "USD" : "PEN";
    const amount = currency === "PEN" ? 1500 + Math.floor(rnd() * 40000) : 500 + Math.floor(rnd() * 12000);
    const paid_by = everyone[(i * 3 + 1) % 4];
    const day = i % 12;
    const pu = { id: `pu-${String(i + 1).padStart(2, "0")}`, description: "", amount_minor: amount, currency, amount_exp: 2, paid_by, split_mode: "weight", spent_at: at(day, 9 + (i % 12)) };
    if (way === "all") pu.shares = everyone.map((k) => ({ person: k, weight: 1 }));
    else if (way === "some") pu.shares = everyone.filter((k, j) => j !== i % 4).map((k) => ({ person: k, weight: 1 }));
    else if (way === "weights") pu.shares = everyone.map((k, j) => ({ person: k, weight: j === 0 ? 2 : 1 }));
    else if (way === "alone") pu.shares = [{ person: paid_by, weight: 1 }];
    else if (way === "exact") {
      pu.split_mode = "exact";
      const a = Math.floor(amount * 0.4), b = Math.floor(amount * 0.35);
      pu.shares = [{ person: "ada", weight: a }, { person: "teo", weight: b }, { person: "lin", weight: amount - a - b }];
    } else {
      pu.shares = everyone.map((k) => ({ person: k, weight: 1 }));
      pu.logged_by = everyone[(everyone.indexOf(paid_by) + 1) % 4];
    }
    // What it hangs on: a meal's event, a bus's event, a shop, a day alone, or nothing.
    const hang = i % 5;
    if (hang === 0 && mealEvents[i % mealEvents.length]) {
      const m = mealEvents[i % mealEvents.length];
      Object.assign(pu, { description: m.title, event_id: m.id, place_id: m.place_id, spent_at: m.starts_at + 3600 });
    } else if (hang === 1) {
      const b = busEvents[i % busEvents.length];
      Object.assign(pu, { description: "Bus tickets", event_id: b.id, spent_at: b.starts_at - 1800 });
    } else if (hang === 2) {
      const shop = shops[(i * 7) % shops.length];
      Object.assign(pu, { description: pick(BOUGHT[shop.subkind]), place_id: shop.id });
    } else if (hang === 3) Object.assign(pu, { description: pick(["Taxi", "Tips", "Entry tickets", "Groceries"]), day: dayOf(day) });
    else pu.description = i % 10 === 4 ? ["Bottled water", "Phone credit", "Bus snacks", "Shared taxi"][Math.floor(i / 10)] : pick(["Coffee", "Ice cream", "Postcards", "Market fruit"]);
    if (i % 6 === 0) pu.note = "Receipt in the folder.";
    purchases.push(pu);
  }
  // Settling up, part of the way: three payments, each one person to another.
  const payments = [["teo", "ada", 12000], ["lin", "sol", 4550], ["sol", "ada", 8000]].map(([from, to, amount], i) => ({
    id: `pay-${i + 1}`, paid_by: from, to, amount_minor: amount, currency: "PEN", amount_exp: 2, spent_at: at(9 + i, 21), description: "Settling up",
  }));
  // 40 packing items: the group's eight, then each person's own eight, no two alike on one
  // person's list (each starts at another place in the words), in bags. What comes on a day out
  // is in the day-out list's daypack, for everyone who has it.
  const ITEM_WORDS = [["Rain jacket", "clothes"], ["Warm hat", "clothes"], ["Gloves", "clothes"], ["Socks", "clothes", 4], ["Passport", "documents"],
    ["Charger", "electronics"], ["Toothbrush", "toiletries"], ["Flask", "gear"], ["Sunglasses", "gear"], ["Altitude tablets", "meds"]];
  const DAY_OUT = ["Rain jacket", "Flask", "Sunglasses", "Altitude tablets"];
  const packing_items = [];
  for (let i = 0; i < 40; i++) {
    const owner = i < 8 ? "group" : everyone[i % 4];
    const [label, category, qty] = owner === "group" ? [] : ITEM_WORDS[(Math.floor((i - 8) / 4) + 3 * (i % 4)) % ITEM_WORDS.length];
    const dayOut = owner === "group" ? i === 4 : DAY_OUT.includes(label);
    packing_items.push({
      id: `pk-${String(i + 1).padStart(2, "0")}`, owner, label: owner === "group" ? ["Stove", "Fuel", "Cards", "Map", "First-aid kit", "Rope", "Tarp", "Cooking pot"][i] : label,
      category: owner === "group" ? ["gear", "gear", "misc", "documents", "meds", "gear", "gear", "gear"][i] : category,
      ...(qty ? { qty } : {}), ...(i % 9 === 0 ? { note: "The light one." } : {}),
      bags: { "leaving-home": i % 3 ? "main-bag" : "day-bag", ...(i % 2 ? { trek: i % 4 === 1 ? "daypack" : "duffel" } : {}), ...(dayOut ? { "day-out": "daypack" } : {}) },
    });
  }
  // Pictures, made by the fill tool (no photograph of anything): the cover, eight places, two
  // events, two receipts.
  const pictures = [
    { kind: "cover" },
    ...places.filter((x) => x.is_anchor).slice(0, 8).map((x) => ({ kind: "place", id: x.id })),
    { kind: "event", id: events.find((x) => x.all_day).id }, { kind: "event", id: mealEvents[0].id },
    { kind: "purchase", id: purchases[0].id }, { kind: "purchase", id: purchases[6].id },
  ];

  return {
    trip: { id: "demo-2027", name: "Coast, sierra and the high pass (a made-up trip)", starts_on: "2027-06-01", ends_on: "2027-06-12", default_tz: "America/Lima", currencies: ["PEN", "USD", "EUR"] },
    areas, places, events,
    people, purchases, payments, packing_items, pictures,
    packing_lists: [
      { key: "leaving-home", name: "Leaving home", bags: [{ key: "main-bag", name: "Main bag" }, { key: "day-bag", name: "Day bag" }, { key: "on-me", name: "On me" }] },
      { key: "trek", name: "The trek", repeat: "once", bags: [{ key: "duffel", name: "Duffel (carried for us)" }, { key: "daypack", name: "Daypack" }, { key: "on-me", name: "On me" }] },
      { key: "day-out", name: "A day out", repeat: "daily", dates: ["2027-06-02", "2027-06-03", "2027-06-10"], bags: [{ key: "daypack", name: "Daypack" }] },
    ],
    packing_starters: [
      ["First-aid kit", "meds", "group"], ["Water filter", "gear", "group"], ["Sunscreen", "toiletries", "person"], ["Power bank", "electronics", "person"],
      ["Rope", "gear", "group"], ["Snacks for the pass", "misc", "person"], ["Headlamp", "gear", "person"], ["Card game", "misc", "group"],
      ["Spare laces", "gear", "person"], ["Copies of passports", "documents", "person"],
    ].map(([label, category, scope], i) => ({ scope, label, category, ...(i === 6 ? { qty: 1 } : {}), bags: { "leaving-home": i % 2 ? "main-bag" : "day-bag", trek: i % 3 ? "duffel" : "daypack", ...(i < 3 ? { "day-out": "daypack" } : {}) } })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--out");
  const out = path.resolve(i < 0 ? path.join(ROOT, "seed/demo-trip.json") : argv[i + 1]);
  const text = JSON.stringify(demoTrip(), null, 2) + "\n";
  if (argv.includes("--check")) {
    const same = fs.existsSync(out) && fs.readFileSync(out, "utf8") === text;
    console.log(same ? `${path.relative(ROOT, out)} is what the generator makes` : `${path.relative(ROOT, out)} isn't what the generator makes: run node tools/demo-seed.mjs`);
    process.exit(same ? 0 : 1);
  }
  fs.writeFileSync(out, text);
  const t = JSON.parse(text);
  console.log(`${path.relative(ROOT, out)}: ${t.areas.length} areas, ${t.places.length} places, ${t.events.length} events, ${t.packing_starters.length} starters`);
}

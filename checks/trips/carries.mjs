// What a trip carries: its interests, areas, places, events, packing lists and suggested
// items, and the person's units, each held to the checks the model (§5, §6, §16, §17) and the
// guides (16-wegoplace/docs/guides/) promise. Part of check:trips (run.mjs), with its own
// made-up people and trips. Every place, business and address here is invented, as in the
// guides.

import { seedTrip } from "../../tools/seed-trip.mjs";
import {
  DUPLICATE_METERS, EVENTS_MAX, INTERESTS_MAX, PACKING_ITEMS_PER_OWNER_MAX, PLACE_TAGS_MAX, PLACES_MAX, ROWS_PER_WRITE_MAX,
} from "../../public/js/shared/limits.js";

/** Epoch seconds for a wall-clock time in a zone ("2027-05-07T10:00", "Europe/Lisbon"). */
function at(local, tz) {
  const guess = Date.parse(`${local}:00Z`);
  const shown = new Date(new Date(guess).toLocaleString("en-US", { timeZone: tz })).getTime();
  const utc = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return (guess - (shown - utc)) / 1000;
}

export async function carries({ t, server, person, patch, put, del, revOf, newTrip, bring }) {
  const ida = await person("Ida Check");
  const jon = await person("Jon Check");
  const trip = await newTrip(ida, { name: "Lisbon and Porto", starts_on: "2027-05-07", ends_on: "2027-05-16", currencies: ["EUR", "USD"] });
  const T = `/api/trips/${trip.id}`;
  await bring(ida, trip.id, jon);
  const rows = (res) => (res.json?.rows ?? []).map((r) => r.error).join(" | ");

  // ── interests and units ─────────────────────────────────────────────────────────────────
  t.part("What the group cares about, and the person's units");
  {
    const said1 = await patch(jon, T, { interests: "  Five friends; one vegetarian (strict). Coffee every morning.  " });
    t.same("any member writes the trip's interests, trimmed, in the trip's answer", [said1.status, said1.json?.trip?.interests], [200, "Five friends; one vegetarian (strict). Coffee every morning."]);
    t.same("and the whole trip carries them", (await ida.get(T)).json?.trip?.interests, "Five friends; one vegetarian (strict). Coffee every morning.");
    const long = await patch(jon, T, { interests: "x".repeat(INTERESTS_MAX + 1) });
    t.same(`more than ${INTERESTS_MAX} characters is refused`, [long.status, long.json?.error], [400, "bad interests"]);
    const madeWith = await ida.post("/api/trips", { name: "With interests", default_tz: "UTC", interests: "Slow mornings." });
    t.same("a trip can be made with them", madeWith.json?.trip?.interests, "Slow mornings.");
    t.same("a person's units start unset (the app goes by the phone)", (await ida.get("/api/me")).json?.units, null);
    t.same("they set metric or imperial", [(await patch(ida, "/api/me", { units: "imperial" })).json?.me?.units, (await ida.get("/api/me")).json?.units], ["imperial", "imperial"]);
    t.same("and nothing else", [(await patch(ida, "/api/me", { units: "furlongs" })).status], [400]);
    t.same("null goes back to the phone's", (await patch(ida, "/api/me", { units: null })).json?.me?.units, null);
  }

  // ── areas ───────────────────────────────────────────────────────────────────────────────
  t.part("Areas");
  {
    const guide = [
      { id: "lisbon", name: "Lisbon", sort: 1, west: -9.23, south: 38.69, east: -9.09, north: 38.80 },
      { id: "alfama", name: "Alfama", parent: "lisbon", sort: 2 },
      { id: "baixa-chiado", name: "Baixa and Chiado", parent: "lisbon", sort: 3 },
      { id: "belem", name: "Belém", parent: "lisbon", sort: 4 },
      { id: "sintra", name: "Sintra", sort: 5, west: -9.47, south: 38.76, east: -9.35, north: 38.83 },
      { id: "porto", name: "Porto", sort: 6, west: -8.69, south: 41.13, east: -8.55, north: 41.19 },
    ];
    const r0 = await revOf(ida, trip.id);
    const set = await put(jon, `${T}/areas`, { areas: guide });
    t.same("the guide's example sets the trip's areas, in one step of rev, in their order",
      [set.status, set.json?.rev, set.json?.areas?.map((a) => [a.id, a.parent])],
      [200, r0 + 1, [["lisbon", null], ["alfama", "lisbon"], ["baixa-chiado", "lisbon"], ["belem", "lisbon"], ["sintra", null], ["porto", null]]]);
    t.same("the whole trip carries them", (await ida.get(T)).json?.areas?.length, 6);
    const refusals = [
      ["an id with a capital", { id: "Old-town", name: "Old town" }, /can't be an id/],
      ["three edges of four", { id: "x1", name: "x", west: 1, south: 1, east: 2 }, /all four numbers or none/],
      ["south above north", { id: "x2", name: "x", west: 1, south: 5, east: 2, north: 4 }, /South must be below north/],
      ["west the same as east", { id: "x3", name: "x", west: 1, south: 1, east: 1, north: 2 }, /no width/],
      ["a parent that isn't there", { id: "x4", name: "x", parent: "nowhere" }, /no area "nowhere"/],
      ["a third level", { id: "x5", name: "x", parent: "alfama" }, /two levels at most/],
      ["its own parent", { id: "x6", name: "x", parent: "x6" }, /its own parent/],
      ["no name", { id: "x7" }, /needs a name/],
      ["a city with neighborhoods put under another", { id: "lisbon", parent: "porto" }, /has areas under it/],
    ];
    const r1 = await revOf(ida, trip.id);
    for (const [what, row, words] of refusals) {
      const res = await put(jon, `${T}/areas`, { areas: [row] });
      t.ok(`refused, saying what is allowed: ${what}`, res.status === 400 && words.test(rows(res)), res.json);
    }
    t.same("  (none of those wrote anything)", await revOf(ida, trip.id), r1);
    const mixed = await put(jon, `${T}/areas`, { areas: [{ id: "cascais", name: "Cascais" }, { id: "Bad one", name: "x" }] });
    t.same("one bad row refuses the whole call, naming the row", [mixed.status, mixed.json?.rows?.map((r) => [r.index, r.id]), (await ida.get(T)).json.areas.some((a) => a.id === "cascais")], [400, [[1, "Bad one"]], false]);

    // A region that crosses the 180° line: west is greater than east.
    const fiji = await put(ida, `${T}/areas`, { areas: [{ id: "islands", name: "Islands", west: 177, south: -20, east: -178, north: -15 }] });
    t.same("a box across the 180° line is a box like any other (west 177, east -178)", fiji.status, 200);
    const across = await put(ida, `${T}/places`, { places: [
      { id: "east-of-line", name: "East of the line", kind: "sight", subkind: "beach", why: "x", area: "islands", lat: -17, lng: 179.5 },
      { id: "west-of-line", name: "West of the line", kind: "sight", subkind: "beach", why: "x", area: "islands", lat: -17, lng: -179.5 },
    ] });
    t.same("it takes a place at 179.5 and one at -179.5", [across.status, across.json?.places?.length], [200, 2]);
    const outside = await put(ida, `${T}/places`, { places: [{ id: "far-west", name: "Too far west", kind: "sight", subkind: "beach", why: "x", area: "islands", lat: -17, lng: 170 }] });
    t.ok("and refuses one at 170, naming the bounds", outside.status === 400 && /outside the bounds of "islands"/.test(rows(outside)), outside.json);
    const shrink = await put(ida, `${T}/areas`, { areas: [{ id: "islands", west: 177, east: 179.9 }] });
    t.same("bounds that would leave a place it holds outside are refused, naming the place",
      [shrink.status, shrink.json?.error, shrink.json?.places?.map((p) => p.id)], [409, "places outside", ["west-of-line"]]);

    const inUse = await del(ida, `${T}/areas/islands`);
    t.same("an area places point at can't be removed; the answer names them", [inUse.status, inUse.json?.error, inUse.json?.places?.sort()], [409, "area in use", ["east-of-line", "west-of-line"]]);
    const parentOnly = await del(ida, `${T}/areas/lisbon`);
    t.same("nor one with areas under it", [parentOnly.status, parentOnly.json?.areas?.sort()], [409, ["alfama", "baixa-chiado", "belem"]]);
    await del(ida, `${T}/places`, { ids: ["east-of-line", "west-of-line"] });
    const gone = await del(ida, `${T}/areas/islands`);
    t.same("once nothing points at it, it goes; asked again, nothing to do", [gone.json?.deleted, (await del(ida, `${T}/areas/islands`)).json?.deleted], [1, 0]);
  }

  // ── places ──────────────────────────────────────────────────────────────────────────────
  t.part("Places");
  const guidePlaces = [
    { id: "stay-lisbon", name: "Alfama apartment", kind: "lodging", subkind: "apartment", area: "alfama", lat: 38.7114, lng: -9.1301,
      address: "Rua do Exemplo 14, 2.º Esq., 1100-000 Lisboa", why: "Home for the four Lisbon nights.",
      checkout: [{ title: "Take the trash down", detail: "Bins are on the corner." }, { title: "Leave both keys on the kitchen table" }],
      is_anchor: true, confidence: "high", source: "The booking confirmation" },
    { id: "cafe-da-esquina", name: "Café da Esquina", kind: "food", subkind: "cafe", area: "alfama", lat: 38.7117, lng: -9.1296,
      why: "Two minutes downhill and open from 07:00.", hours: "Mon-Sat 07:00-19:00; Sun 08:00-14:00", price_level: 1,
      tags: ["open-early", "cards-ok", "vegetarian-ok", "uphill-return"], near_anchor: "stay-lisbon", walk_minutes: 2, confidence: "high" },
    { id: "farmacia-do-largo", name: "Farmácia do Largo", kind: "practical", subkind: "pharmacy", area: "alfama", lat: 38.7109, lng: -9.1311,
      why: "The nearest pharmacy to the apartment.", hours: "Mon-Fri 09:00-19:30; Sat 09:00-13:00", tags: ["cards-ok"], near_anchor: "stay-lisbon", walk_minutes: 4 },
  ];
  {
    const r0 = await revOf(ida, trip.id);
    const wrote = await put(jon, `${T}/places`, { places: guidePlaces });
    t.same("any member writes places: the guide's example, one step of rev, no warnings",
      [wrote.status, wrote.json?.places?.length, wrote.json?.warnings, wrote.json?.rev], [200, 3, [], r0 + 1]);
    const cafe = wrote.json.places.find((p) => p.id === "cafe-da-esquina");
    t.same("what was sent is what is kept: the hours in the one format, the tags as a list",
      [cafe?.hours, cafe?.tags, cafe?.near_anchor, cafe?.area], ["Mon-Sat 07:00-19:00; Sun 08:00-14:00", ["open-early", "cards-ok", "vegetarian-ok", "uphill-return"], "stay-lisbon", "alfama"]);
    t.same("the stay keeps its checkout steps", JSON.parse(wrote.json.places.find((p) => p.id === "stay-lisbon").checkout), guidePlaces[0].checkout);

    const base = { id: "p-new", name: "A place", kind: "food", subkind: "restaurant", why: "x" };
    const refusals = [
      ["no name", { id: "p-1", kind: "food", subkind: "cafe" }, /needs id, name, kind, subkind; this one has no name/],
      ["an id with capitals", { ...base, id: "P-New" }, /can't be an id/],
      ["a kind that isn't one", { ...base, kind: "eat" }, /not a kind of place.*The kind says why/],
      ["a subkind that isn't on the list (the error carries it)", { ...base, subkind: "gastropub" }, /not on the list of subkinds.*The list, by kind:\nlodging: hotel/s],
      ["a word not on the list (refused with the list, no guess)", { ...base, kind: "lodging", subkind: "airbnb" }, /"airbnb" is not on the list of subkinds\. Pick the closest one\./],
      ["hours in another spelling", { ...base, hours: "Mo-Fr 9:00-18:00" }, /Tue-Sat 12:30-15:00/],
      ["hours with a remark", { ...base, hours: "approx Mon-Sat 09:00-18:00" }, /Tue-Sat 12:30-15:00/],
      [`${PLACE_TAGS_MAX + 1} tags`, { ...base, tags: ["a", "b", "c", "d", "e", "f", "g"] }, /too many/],
      ["a tag in capitals", { ...base, tags: ["Cash-only"] }, /can't be a tag/],
      ["a rating without its count", { ...base, rating: 4.5 }, /come together or not at all/],
      ["a price level of 5", { ...base, price_level: 5 }, /price_level is 1 to 4/],
      ["a confidence that isn't one", { ...base, confidence: "sure" }, /high, medium or low/],
      ["lat without lng", { ...base, lat: 38.7 }, /Only one of lat and lng/],
      ["0,0", { ...base, lat: 0, lng: 0 }, /0,0 is in the sea/],
      ["an area that isn't the trip's", { ...base, area: "madrid" }, /no area "madrid"/],
      ["coordinates outside the area and its parent", { ...base, area: "alfama", lat: 41.15, lng: -8.61 }, /outside the bounds of "alfama"\s*\(|outside the bounds of "lisbon"/],
      ["near an anchor that isn't there", { ...base, near_anchor: "nowhere" }, /no place "nowhere"/],
      ["checkout steps on a restaurant", { ...base, checkout: [{ title: "Pay" }] }, /checkout is for lodging only/],
      ["a website that isn't an address", { ...base, website: "cafe.example" }, /http or https/],
    ];
    const r1 = await revOf(ida, trip.id);
    for (const [what, row, words] of refusals) {
      const res = await put(jon, `${T}/places`, { places: [row] });
      t.ok(`refused, saying what is allowed: ${what}`, res.status === 400 && words.test(rows(res)), res.json);
    }
    t.same("  (none of those wrote anything)", await revOf(ida, trip.id), r1);
    const byHand = await put(jon, `${T}/places`, { places: [{ id: "bakery", name: "The bakery by the hostel", kind: "food", subkind: "bakery" }, { id: "bench", name: "A bench", kind: "sight", subkind: "viewpoint", why: "   " }] });
    t.same("a person adding a place by hand may leave its why out, or empty: it is kept empty (an AI's must give one: check:mcp)",
      [byHand.status, byHand.json?.places?.map((p) => [p.id, p.why])], [200, [["bakery", ""], ["bench", ""]]]);
    const mixed = await put(jon, `${T}/places`, { places: [{ ...base, id: "p-good" }, { ...base, id: "p-bad", price_level: 9 }] });
    t.same("one bad row refuses the whole call, naming it", [mixed.status, mixed.json?.rows?.map((r) => [r.index, r.id]), (await jon.get(T)).json.places.some((p) => p.id === "p-good")], [400, [[1, "p-bad"]], false]);
    const tooMany = await put(jon, `${T}/places`, { places: Array.from({ length: ROWS_PER_WRITE_MAX + 1 }, (_, i) => ({ ...base, id: `p-${i}` })) });
    t.same(`at most ${ROWS_PER_WRITE_MAX} rows in one call`, [tooMany.status, tooMany.json], [400, { error: "too many rows", max: ROWS_PER_WRITE_MAX, reason: `A write is at most ${ROWS_PER_WRITE_MAX} rows: send the rest in another.` }]);

    const twin = await put(jon, `${T}/places`, { places: [{ id: "esquina-cafe", name: "Esquina", kind: "food", subkind: "cafe", why: "x", area: "alfama", lat: 38.71178, lng: -9.12965 }] });
    t.ok(`a new place within ${DUPLICATE_METERS} m of one of the same kind is written, with a warning naming the other`,
      twin.status === 200 && twin.json?.warnings?.length === 1 && twin.json.warnings[0].near === "cafe-da-esquina" && twin.json.warnings[0].meters <= DUPLICATE_METERS, twin.json?.warnings);
    const noCoords = await put(jon, `${T}/places`, { places: [{ id: "somewhere", name: "Somewhere", kind: "sight", subkind: "viewpoint", why: "x", area: "alfama" }] });
    t.same("a place without coordinates is allowed (shown as not confirmed)", [noCoords.status, noCoords.json?.places?.[0]?.lat, noCoords.json?.places?.[0]?.lng], [200, null, null]);

    // A change sends only what changes; what it leaves out stays.
    const renamed = await put(ida, `${T}/places`, { places: [{ id: "cafe-da-esquina", name: "Café da Esquina (corner)" }] });
    const after = renamed.json?.places?.[0];
    t.same("a change that sends a name keeps the rest: kind, hours, tags", [after?.name, after?.subkind, after?.hours, after?.tags?.length], ["Café da Esquina (corner)", "cafe", "Mon-Sat 07:00-19:00; Sun 08:00-14:00", 4]);
    t.same("hours written in another order come back in the one spelling",
      (await put(ida, `${T}/places`, { places: [{ id: "cafe-da-esquina", hours: "Sun 08:00-14:00; Mon-Sat 07:00-19:00" }] })).json?.places?.[0]?.hours, "Mon-Sat 07:00-19:00; Sun 08:00-14:00");
    const cleared = await put(ida, `${T}/places`, { places: [{ id: "cafe-da-esquina", hours: null, rating: null, rating_count: null }] });
    t.same("null clears a field", [cleared.json?.places?.[0]?.hours, cleared.json?.places?.[0]?.rating], ["", 0]);

    // A row from before the six-tag rule keeps its tags until someone rewrites them.
    const many = JSON.stringify(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    server.sql(`UPDATE places SET tags = '${many}' WHERE trip_id = '${trip.id}' AND id = 'farmacia-do-largo'`);
    const kept = await put(ida, `${T}/places`, { places: [{ id: "farmacia-do-largo", notes: "Closed Sundays." }] });
    t.same("an old row with nine tags, changed without sending tags, keeps all nine", [kept.status, kept.json?.places?.[0]?.tags?.length], [200, 9]);
    const rewritten = await put(ida, `${T}/places`, { places: [{ id: "farmacia-do-largo", tags: ["cards-ok", "open-late"] }] });
    t.same("sending tags rewrites them under the rule", rewritten.json?.places?.[0]?.tags, ["cards-ok", "open-late"]);

    // A place an older database brought more than six tags into (the six are for writes from
    // now on) is still editable: what a write leaves out stays.
    const eight = ["a-1", "a-2", "a-3", "a-4", "a-5", "a-6", "a-7", "a-8"];
    server.sql(`UPDATE places SET tags = '${JSON.stringify(eight)}' WHERE trip_id = '${T.split("/").pop()}' AND id = 'farmacia-do-largo'`);
    const untouched = await put(ida, `${T}/places`, { places: [{ id: "farmacia-do-largo", name: "Farmácia do Largo", notes: "Closed Sundays. Ask for the night bell." }] });
    t.same("a place with more than six tags (migrated) is edited without touching them: the write is taken, all eight stay",
      [untouched.status, untouched.json?.places?.[0]?.tags], [200, eight]);
    const all8 = await put(ida, `${T}/places`, { places: [{ id: "farmacia-do-largo", tags: eight }] });
    t.ok("sending its tags is held to six, in words, and they stay as they were",
      all8.status === 400 && /too many/.test(rows(all8)) && JSON.stringify((await ida.get(T)).json.places.find((x) => x.id === "farmacia-do-largo")?.tags) === JSON.stringify(eight), all8.json);
    const six = await put(ida, `${T}/places`, { places: [{ id: "farmacia-do-largo", tags: eight.slice(0, 6) }] });
    t.same("sending six of them is taken: the place is under the rule from then on", [six.status, six.json?.places?.[0]?.tags], [200, eight.slice(0, 6)]);

    // Removing.
    const purchase = await ida.post(`${T}/purchases`, { id: "pu-coffee", description: "Coffee", amount_minor: 300, currency: "EUR", amount_exp: 2, split_mode: "weight",
      spent_at: at("2027-05-08T08:00", "Europe/Lisbon"), place_id: "farmacia-do-largo", shares: [{ user_id: ida.user.id, weight: 1, share_minor: 300 }] });
    t.same("  (a purchase points at the pharmacy)", purchase.status, 201);
    await ida.post(`${T}/events`, { id: "check-in", title: "Check in", starts_at: at("2027-05-07T15:00", "Europe/Lisbon"), tz: "Europe/Lisbon", kind: "lodging", place_id: "stay-lisbon" });
    const anchorUse = await del(jon, `${T}/places/stay-lisbon`);
    t.same("a place that events and other places' near_anchor point at can't be removed; the answer names them",
      [anchorUse.status, anchorUse.json?.error, anchorUse.json?.events, anchorUse.json?.places?.sort()], [409, "place in use", ["check-in"], ["cafe-da-esquina", "farmacia-do-largo"]]);
    const goes = await del(jon, `${T}/places/farmacia-do-largo`);
    t.same("one nothing points at goes", [goes.status, goes.json?.deleted], [200, 1]);
    t.same("and the purchase that pointed at it floats, keeping its money", (await ida.get(`${T}/purchases`)).json.purchases.find((p) => p.id === "pu-coffee")?.place_id ?? null, null);
  }

  // ── events ──────────────────────────────────────────────────────────────────────────────
  t.part("Events");
  {
    const undated = await newTrip(ida, { name: "Someday" });
    const none = await ida.post(`/api/trips/${undated.id}/events`, { title: "Dinner", starts_at: at("2027-05-08T20:00", "Europe/Lisbon"), tz: "Europe/Lisbon" });
    t.same("a trip without dates takes no events, and says to set them", [none.status, none.json?.error, none.json?.reason],
      [400, "not a day of the trip", "The trip has no dates yet, so nothing can be put on a day of it. Set the trip's dates first."]);
    const wrongYear = await ida.post(`${T}/events`, { title: "Dinner", starts_at: at("2026-05-08T20:00", "Europe/Lisbon"), tz: "Europe/Lisbon" });
    t.ok("an event outside the trip's dates (a wrong year) is refused with the dates",
      wrongYear.status === 400 && wrongYear.json?.starts_on === "2027-05-07" && wrongYear.json?.ends_on === "2027-05-16" && /2026-05-08, which isn't a day of the trip/.test(wrongYear.json?.reason), wrongYear.json);
    const lastNight = await ida.post(`${T}/events`, { id: "late-dinner", title: "Late dinner", starts_at: at("2027-05-16T23:30", "Europe/Lisbon"), tz: "Europe/Lisbon" });
    t.same("23:30 on the last day, in the event's own zone, is a day of the trip", lastNight.status, 201);
    const otherZone = await ida.post(`${T}/events`, { title: "Call home", starts_at: at("2027-05-16T23:30", "Europe/Lisbon"), tz: "Pacific/Auckland" });
    t.ok("the same moment shown in a zone where it is already the next day is refused", otherZone.status === 400 && /2027-05-17/.test(otherZone.json?.reason), otherZone.json);
    const badId = await ida.post(`${T}/events`, { id: "Ev 1", title: "x", starts_at: at("2027-05-08T10:00", "Europe/Lisbon"), tz: "Europe/Lisbon" });
    t.ok("a new event's id is lowercase letters, digits, hyphens and underscores: a capital or a space is refused, saying so", badId.status === 400 && badId.json?.error === "bad id" && /lowercase letters, digits, hyphens and underscores/.test(badId.json?.reason), badId.json);
    // The old app's own ids (ev_<uuid>): a plan it made with no signal just before the cutover.
    const oldAppId = await ida.post(`${T}/events`, { id: "ev_3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f", title: "Made on the old app", starts_at: at("2027-05-08T10:00", "Europe/Lisbon"), tz: "Europe/Lisbon" });
    t.same("an id the old app made (ev_<uuid>) is taken", oldAppId.status, 201);

    // Any member changes and removes any event.
    const changed = await patch(jon, `${T}/events/check-in`, { title: "Check in (from 15:00)", source: "the booking" });
    t.same("a member changes an event someone else made", [changed.status, changed.json?.event?.title, changed.json?.event?.source], [200, "Check in (from 15:00)", "the booking"]);
    t.ok("events carry where they came from, and no scenario", "source" in changed.json.event && !("scenario" in changed.json.event), changed.json.event);
    const moved = await patch(jon, `${T}/events/check-in`, { starts_at: at("2027-05-20T15:00", "Europe/Lisbon") });
    t.same("a change that moves it off the trip's days is refused", [moved.status, moved.json?.error], [400, "not a day of the trip"]);
    await jon.post(`${T}/messages`, { id: "n-dinner", body: "Booked for 6", about: { kind: "event", id: "late-dinner" } });
    await ida.post(`${T}/purchases`, { id: "pu-dinner", description: "Dinner", amount_minor: 6000, currency: "EUR", amount_exp: 2, split_mode: "weight",
      spent_at: at("2027-05-16T23:59", "Europe/Lisbon"), event_id: "late-dinner", shares: [{ user_id: ida.user.id, weight: 1, share_minor: 6000 }] });
    const removed = await del(jon, `${T}/events/late-dinner`);
    const snap = (await ida.get(T)).json;
    const said = (await ida.get(`${T}/messages?about=event:late-dinner`)).json.messages.map((m) => [m.id, m.about.name]);
    t.same("a member removes an event someone else made; what was said about it stays in the chat with its name, and a purchase on it floats",
      [removed.json?.deleted, said, snap.purchases.find((p) => p.id === "pu-dinner")?.event_id ?? null], [true, [["n-dinner", "Late dinner"]], null]);

    // The trip's dates, from the other side.
    await ida.post(`${T}/events`, { id: "porto-train", title: "Train to Porto", starts_at: at("2027-05-12T09:00", "Europe/Lisbon"), tz: "Europe/Lisbon", kind: "transit" });
    const shorter = await patch(ida, T, { ends_on: "2027-05-10" });
    t.same("dates that would leave an event outside are refused, naming the first and last event day",
      [shorter.status, shorter.json?.error, shorter.json?.first_event_day, shorter.json?.last_event_day], [409, "events outside", "2027-05-07", "2027-05-12"]);
    const clearing = await patch(ida, T, { starts_on: null, ends_on: null });
    t.same("and so is clearing them", [clearing.status, clearing.json?.error], [409, "events outside"]);
    const holding = await patch(ida, T, { starts_on: "2027-05-06", ends_on: "2027-05-12" });
    t.same("dates that hold every event are taken", [holding.status, holding.json?.trip?.ends_on], [200, "2027-05-12"]);
    await patch(ida, T, { starts_on: "2027-05-07", ends_on: "2027-05-16" });
  }

  // ── packing ─────────────────────────────────────────────────────────────────────────────
  t.part("Packing: the trip's lists, its bags, ticks and suggestions");
  {
    const lists = await put(jon, `${T}/packing/lists`, { lists: [
      { key: "travel", name: "Carry-on only", bags: [{ key: "carry-on", name: "Carry-on" }, { key: "personal", name: "Personal item" }, { key: "on-me", name: "On me" }] },
      { key: "day-out", name: "Every day out", repeat: "daily", bags: [{ key: "pack", name: "Day pack" }] },
      { key: "boat-day", name: "Boat day", repeat: "daily", dates: ["2027-05-14"], bags: [{ key: "pack", name: "Day pack" }] },
    ] });
    t.same("any member sets the guide's lists; they are the trip's, beside the one it started with",
      [lists.status, lists.json?.lists?.map((l) => [l.key, l.repeat, l.dates, l.bags.length])],
      [200, [["leaving-home", "once", null, 3], ["travel", "once", null, 3], ["day-out", "daily", null, 1], ["boat-day", "daily", ["2027-05-14"], 1]]]);
    t.same("the other member sees the same lists", (await ida.get(T)).json.packing_lists.map((l) => l.key), ["leaving-home", "travel", "day-out", "boat-day"]);

    const listRefusals = [
      ["a named date outside the trip", { key: "x-1", name: "x", repeat: "daily", dates: ["2027-06-01"], bags: [{ key: "pack", name: "Pack" }] }, /2027-06-01 isn't a day of the trip\. The trip runs from 2027-05-07 to 2027-05-16/],
      ["a date that doesn't exist", { key: "x-2", name: "x", repeat: "daily", dates: ["2027-02-30"], bags: [{ key: "pack", name: "Pack" }] }, /isn't a date/],
      ["dates on a list packed once", { key: "x-3", name: "x", dates: ["2027-05-08"], bags: [{ key: "pack", name: "Pack" }] }, /Only a list for the day names dates/],
      ["a repeat that isn't one", { key: "x-4", name: "x", repeat: "weekly", bags: [{ key: "pack", name: "Pack" }] }, /repeat is "once"/],
      ["a new list without bags", { key: "x-5", name: "x" }, /needs its bags/],
      ["a key with capitals", { key: "Day", name: "x", bags: [{ key: "pack", name: "Pack" }] }, /can't be a list's key/],
    ];
    for (const [what, list, words] of listRefusals) {
      const res = await put(jon, `${T}/packing/lists`, { lists: [list] });
      t.ok(`refused, saying what is allowed: ${what}`, res.status === 400 && words.test(rows(res)), res.json);
    }

    // Bags are added or changed; nothing is removed by being left out.
    const bagsOf = async (key) => (await ida.get(T)).json.packing_lists.find((l) => l.key === key).bags.map((x) => [x.key, x.name, x.sort]);
    const knew = [{ key: "carry-on" }, { key: "personal" }, { key: "on-me" }];
    const jonAdds = await put(jon, `${T}/packing/lists`, { lists: [{ key: "travel", bags: [...knew, { key: "camera-bag", name: "Camera bag" }] }] });
    const idaAdds = await put(ida, `${T}/packing/lists`, { lists: [{ key: "travel", bags: [...knew, { key: "tote", name: "Tote" }] }] });
    t.same("two phones that each add a bag, knowing only the bags they last saw, both keep theirs: the second write leaves the first one's bag out, and it stays",
      [jonAdds.status, idaAdds.status, await bagsOf("travel")],
      [200, 200, [["carry-on", "Carry-on", 0], ["personal", "Personal item", 1], ["on-me", "On me", 2], ["camera-bag", "Camera bag", 3], ["tote", "Tote", 4]]]);
    const changed = await put(ida, `${T}/packing/lists`, { lists: [{ key: "travel", bags: [{ key: "tote", name: "Tote bag" }, { key: "camera-bag", sort: 9 }] }] });
    t.same("a bag sent on its own is renamed, or moved by its sort; the bags not sent stay as they were",
      [changed.status, await bagsOf("travel")],
      [200, [["carry-on", "Carry-on", 0], ["personal", "Personal item", 1], ["on-me", "On me", 2], ["tote", "Tote bag", 4], ["camera-bag", "Camera bag", 9]]]);
    const nine = await put(jon, `${T}/packing/lists`, { lists: [{ key: "travel", bags: ["a", "b", "c", "d"].map((k) => ({ key: `extra-${k}`, name: k })) }] });
    t.ok("a list holds at most 8 bags, counting the ones it has", nine.status === 400 && /A list has 1 to 8 bags/.test(rows(nine)), nine.json);
    const gone = { lists: [{ key: "travel", bags: [{ key: "camera-bag", remove: true }, { key: "tote", remove: true }] }] };
    const removed = await put(jon, `${T}/packing/lists`, gone);
    const twice = await put(jon, `${T}/packing/lists`, gone);
    t.same("a bag goes only when the write says remove: true; sent twice, the second changes nothing",
      [removed.status, twice.status, (await bagsOf("travel")).map(([k]) => k)], [200, 200, ["carry-on", "personal", "on-me"]]);
    const notTrue = await put(jon, `${T}/packing/lists`, { lists: [{ key: "travel", bags: [{ key: "personal", remove: "yes" }] }] });
    t.ok("remove is true or nothing", notTrue.status === 400 && /remove is true/.test(rows(notTrue)), notTrue.json);
    const lastBag = await put(jon, `${T}/packing/lists`, { lists: [{ key: "day-out", bags: [{ key: "pack", remove: true }] }] });
    t.ok("a list keeps at least one bag", lastBag.status === 400 && /A list has 1 to 8 bags/.test(rows(lastBag)), lastBag.json);

    // Items in bags, and ticks per list.
    const jacket = await jon.post(`${T}/packing`, { id: "pk-jacket", label: "Rain jacket", category: "clothes", bags: { travel: "carry-on", "day-out": "pack" } });
    t.same("an item is made in a bag on each of two lists, in one write", [jacket.status], [201]);
    const placed = (await jon.get(`${T}/packing`)).json.placements.filter((p) => p.item_id === "pk-jacket").map((p) => [p.list_key, p.bag_key]);
    t.same("  (one bag per list)", placed.sort(), [["day-out", "pack"], ["travel", "carry-on"]]);
    const tick = (body) => put(jon, `${T}/packing/ticks`, { item_id: "pk-jacket", ...body });
    t.same("ticked for the list packed once, with no day", [(await tick({ list_key: "travel", ticked: true })).status], [200]);
    const ticks = () => jon.get(`${T}/packing`).then((r) => r.json.ticks.filter((x) => x.item_id === "pk-jacket").map((x) => [x.list_key, x.day]));
    t.same("a tick belongs to the item on that list: the day list isn't ticked", await ticks(), [["travel", null]]);
    t.same("a tick for the day carries the trip's day", [(await tick({ list_key: "day-out", day: "2027-05-08", ticked: true })).status], [200]);
    t.same("each day starts unticked: the next day is its own", [(await tick({ list_key: "day-out", day: "2027-05-09", ticked: true })).status, (await ticks()).length], [200, 3]);
    t.same("ticking what is already ticked changes nothing", (await tick({ list_key: "travel", ticked: true })).json?.rev, await revOf(jon, trip.id));
    const tickRefusals = [
      ["a day list's tick without its day", { list_key: "day-out", ticked: true }, "bad day"],
      ["a day on a list packed once", { list_key: "travel", day: "2027-05-08", ticked: true }, "bad day"],
      ["a day the list doesn't name", { list_key: "boat-day", day: "2027-05-08", ticked: true }, "not a day of that list"],
      ["a list the item has no bag on", { list_key: "leaving-home", ticked: true }, "not on that list"],
      ["a list that isn't there", { list_key: "nowhere", ticked: true }, "no such list"],
    ];
    await patch(jon, `${T}/packing/pk-jacket`, { bags: { "boat-day": "pack" } });
    for (const [what, body, error] of tickRefusals) {
      const res = await tick(body);
      t.same(`refused: ${what}`, [res.status >= 400, res.json?.error], [true, error]);
    }
    const lateTick = await tick({ list_key: "day-out", day: "2031-05-08", ticked: true });
    t.same("a list for every day takes only the trip's days when the trip has dates", [lateTick.status, lateTick.json?.error], [400, "not a day of the trip"]);
    const datedTick = await tick({ list_key: "boat-day", day: "2027-05-14", ticked: true });
    t.same("a tick on a day the list names", datedTick.status, 200);
    t.same("a trip without dates still takes a day list's ticks", await (async () => {
      const someday = (await ida.get("/api/trips")).json.trips.find((x) => x.name === "Someday");
      const S = `/api/trips/${someday.id}`;
      await put(ida, `${S}/packing/lists`, { lists: [{ key: "day-out", name: "Day out", repeat: "daily", bags: [{ key: "pack", name: "Day pack" }] }] });
      await ida.post(`${S}/packing`, { id: "pk-someday", label: "Water", bags: { "day-out": "pack" } });
      return (await put(ida, `${S}/packing/ticks`, { item_id: "pk-someday", list_key: "day-out", day: "2027-01-01", ticked: true })).status;
    })(), 200);
    const ownTick = await put(ida, `${T}/packing/ticks`, { item_id: "pk-jacket", list_key: "travel", ticked: false });
    t.same("nobody ticks someone else's own item, and is told whose it is", [ownTick.status, ownTick.json?.error, /another person's list/.test(ownTick.json?.reason ?? "")], [403, "forbidden", true]);
    await jon.post(`${T}/packing`, { id: "pk-kit", owner: "group", label: "First-aid kit", category: "meds", bags: { travel: "carry-on" } });
    await put(jon, `${T}/packing/ticks`, { item_id: "pk-kit", list_key: "travel", ticked: true });
    t.same("a group item's tick is the group's: the other member sees it", (await ida.get(`${T}/packing`)).json.ticks.filter((x) => x.item_id === "pk-kit").length, 1);
    const repeatChange = await put(jon, `${T}/packing/lists`, { lists: [{ key: "day-out", repeat: "once" }] });
    t.ok("a list people have ticked can't change between packed once and for the day", repeatChange.status === 400 && /can't change between packed once and for the day/.test(rows(repeatChange)), repeatChange.json);
    const offList = await patch(jon, `${T}/packing/pk-jacket`, { bags: { "day-out": null } });
    t.same("taking an item off a list takes its ticks there with it", [offList.status, (await ticks()).filter(([l]) => l === "day-out").length], [200, 0]);

    // What can't be removed.
    const bagInUse = await put(jon, `${T}/packing/lists`, { lists: [{ key: "travel", bags: [{ key: "carry-on", remove: true }] }] });
    t.ok("a bag that holds items can't be removed; the refusal says how many, counting everyone's (one person's and the group's)",
      bagInUse.status === 400 && /"carry-on" holds 2 \(counting everyone's\)/.test(rows(bagInUse)) && JSON.stringify(bagInUse.json.rows[0].held) === JSON.stringify([{ key: "carry-on", items: 2 }]), bagInUse.json);
    const listInUse = await del(jon, `${T}/packing/lists/travel`);
    t.same("nor a list that holds any", [listInUse.status, listInUse.json?.error, listInUse.json?.items], [409, "list in use", 2]);
    const emptyGoes = await del(jon, `${T}/packing/lists/day-out`);
    t.same("an empty list goes", [emptyGoes.status, emptyGoes.json?.deleted], [200, true]);
    const outsideDay = await put(jon, `${T}/packing/ticks`, { item_id: "pk-kit", list_key: "travel", ticked: true });
    t.same("  (a once list's tick still needs no day)", outsideDay.status, 200);

    // Suggested items.
    const starters = await put(jon, `${T}/packing/starters`, { starters: [
      { scope: "person", label: "Passport", category: "documents", bags: { travel: "on-me" }, note: "Check your government's travel advice." },
      { scope: "person", label: "Shirts", category: "clothes", bags: { travel: "carry-on" } },
      { scope: "group", label: "Plug adapters", category: "electronics", bags: { travel: "carry-on" }, note: "Type F at 230 V." },
      { scope: "person", label: "Swimsuit and towel", category: "clothes", bags: { travel: "carry-on", "boat-day": "pack" } },
    ] });
    t.same("the guide's starters are the trip's, in order", [starters.status, starters.json?.starters?.map((s) => s.label)], [200, ["Passport", "Shirts", "Plug adapters", "Swimsuit and towel"]]);
    t.same("the snapshot carries them", (await ida.get(T)).json.packing_starters.length, 4);
    const starterRefusals = [
      ["a bag that isn't on its list", { scope: "person", label: "x", category: "gear", bags: { travel: "duffel" } }, /has no bag "duffel"/],
      ["a list that isn't there", { scope: "person", label: "x", category: "gear", bags: { trek: "pack" } }, /no list "trek"/],
      ["a category that isn't one", { scope: "person", label: "x", category: "shoes", bags: {} }, /category is one of/],
      ["a scope that isn't one", { scope: "everyone", label: "x", category: "gear" }, /scope is "person"/],
      ["a quantity nobody needs", { scope: "person", label: "x", category: "gear", qty: 0 }, /qty is a whole number/],
    ];
    for (const [what, row, words] of starterRefusals) {
      const res = await put(jon, `${T}/packing/starters`, { starters: [row] });
      t.ok(`refused, saying what is allowed: ${what}`, res.status === 400 && words.test(rows(res)), res.json);
    }
    await patch(jon, `${T}/packing/pk-jacket`, { bags: { "boat-day": null } });
    const boatInUse = await del(jon, `${T}/packing/lists/boat-day`);
    t.ok("a list a suggested item starts in isn't removed while it does", boatInUse.status === 409 && /suggested item/.test(boatInUse.json?.reason), boatInUse.json);
    t.same("an empty list of starters removes them all", (await put(jon, `${T}/packing/starters`, { starters: [] })).json?.starters, []);
    const one = await newTrip(ida, { name: "One list" });
    const last = await del(ida, `/api/trips/${one.id}/packing/lists/leaving-home`);
    t.same("a trip's last list can't be removed: rename it, or add another first", [last.status, last.json?.error], [409, "last list"]);

    // Ceilings against a runaway loop (every member's phone holds all of these). Filled by SQL.
    const fill = (table, n, row) => server.sql(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ${n}) INSERT INTO ${table} SELECT ${row} FROM k`);
    const C = await newTrip(ida, { name: "Ceilings", starts_on: "2027-05-07", ends_on: "2027-05-16" });
    const CT = `/api/trips/${C.id}`;
    fill("places (trip_id, id, name, kind, subkind, why)", PLACES_MAX - 1, `'${C.id}', 'p-' || i, 'P', 'sight', 'viewpoint', 'x'`);
    t.same(`a trip takes places up to ${PLACES_MAX}`, (await put(ida, `${CT}/places`, { places: [{ id: "p-last", name: "Last", kind: "sight", subkind: "viewpoint", why: "x" }] })).status, 200);
    const overPlaces = await put(ida, `${CT}/places`, { places: [{ id: "p-over", name: "Over", kind: "sight", subkind: "viewpoint", why: "x" }] });
    t.same("and no more, naming the number", [overPlaces.status, overPlaces.json?.error, overPlaces.json?.max], [409, "too many places", PLACES_MAX]);
    fill("events (trip_id, id, starts_at, tz, title, created_by, created_at, updated_at)", EVENTS_MAX, `'${C.id}', 'e-' || i, ${at("2027-05-08T10:00", "UTC")}, 'UTC', 'E', '${ida.user.id}', 0, 0`);
    const overEvents = await ida.post(`${CT}/events`, { title: "Over", starts_at: at("2027-05-08T10:00", "UTC"), tz: "UTC" });
    t.same(`a trip holds at most ${EVENTS_MAX} events, naming the number`, [overEvents.status, overEvents.json?.error, overEvents.json?.max], [409, "too many events", EVENTS_MAX]);
    fill("packing_items (id, trip_id, owner, section, label, created_by, created_at, updated_at)", PACKING_ITEMS_PER_OWNER_MAX, `'ceil-' || i, '${C.id}', '${ida.user.id}', '', 'x', '${ida.user.id}', 0, 0`);
    const overItems = await ida.post(`${CT}/packing`, { label: "Over" });
    t.same(`a person's list holds at most ${PACKING_ITEMS_PER_OWNER_MAX} items, naming the number`, [overItems.status, overItems.json?.error, overItems.json?.max], [409, "too many items", PACKING_ITEMS_PER_OWNER_MAX]);
    t.same("the group's list counts on its own", (await ida.post(`${CT}/packing`, { label: "Ours", owner: "group" })).status, 201);
    const intoFull = await patch(ida, `${CT}/packing/${(await ida.post(`${CT}/packing`, { label: "x", owner: "group" })).json?.item?.id}`, { owner: ida.user.id });
    t.same("and an item handed to a full list is refused the same way", [intoFull.status, intoFull.json?.error], [409, "too many items"]);
  }

  // ── a seed, through the routes ──────────────────────────────────────────────────────────
  t.part("A seed put in through the routes (tools/seed-trip.mjs)");
  {
    const seed = {
      trip: { name: "Old-style seed", starts_on: "2027-05-07", ends_on: "2027-05-16", default_tz: "Europe/Lisbon" },
      places: [
        { id: "stay", name: "The flat", kind: "lodging", subkind: "Apartment", area: "lisbon_old_town", lat: 38.7114, lng: -9.1301, why: "Home", is_anchor: true,
          checkout: JSON.stringify([{ title: "Keys on the table" }]) },
        { id: "fish-place", name: "A fish place", kind: "food", subkind: " restaurant", area: "lisbon_old_town", lat: 38.712, lng: -9.131, why: "Fish",
          hours: "Mo-Fr 9:00-18:00", tags: JSON.stringify(["Seafood", "Cash Only", "late", "a", "b", "c", "d", "e"]), rating: 4.4, near_anchor: "stay", walk_minutes: 3 },
        { id: "market", name: "A market", kind: "food", subkind: "market", area: "lisbon_old_town", lat: 38.713, lng: -9.132, why: "Fruit",
          hours: "approx 9-5 (unverified)", notes: "Busy on Saturdays." },
      ],
      events: [{ id: "arrive", title: "Land", starts_at: at("2027-05-07T06:35", "Europe/Lisbon"), tz: "Europe/Lisbon", kind: "transit", place_id: "stay", scenario: "classic", created_by: "seed" }],
    };
    const send = (method, path, body) => ida.call(method, path, body);
    const { tripId, report } = await seedTrip(seed, send);
    const s = (await ida.get(`/api/trips/${tripId}`)).json;
    t.same("it makes the trip, an area per code, the places and the events, as the account that sent it",
      [report.areas, report.places, report.events, s.trip.host_id, s.areas.map((a) => [a.id, a.name]), s.events[0].created_by, s.events[0].source],
      [1, 3, 1, ida.user.id, [["lisbon-old-town", "Lisbon Old Town"]], ida.user.id, "import"]);
    const p = (id) => s.places.find((x) => x.id === id);
    t.same("a subkind in another case or with a space is respelled as the list's; the kind untouched", [p("stay").subkind, p("fish-place").kind, p("fish-place").subkind, p("fish-place").tags[0]], ["apartment", "food", "restaurant", "seafood"]);
    const offList = { ...seed, trip: { ...seed.trip, name: "A seed with a word off the list" }, places: [{ ...seed.places[2], id: "odd", subkind: "tapas_bar" }], events: [] };
    const tripsBefore = (await ida.get("/api/trips")).json?.trips?.length;
    const refused = await seedTrip(offList, send).then(() => null, (e) => String(e.message));
    t.ok("a seed with a subkind off the list is refused before anything is made, naming the place, with the list",
      /^place odd: "tapas_bar" is not on the list of subkinds\./.test(refused ?? "") && (await ida.get("/api/trips")).json?.trips?.length === tripsBefore, refused ?? "it was put in");
    t.same("hours in another spelling are written in the one format", p("fish-place").hours, "Mon-Fri 09:00-18:00");
    t.same("hours that can't be read move to the top of the notes", [p("market").hours, p("market").notes], ["", "approx 9-5 (unverified)\n\nBusy on Saturdays."]);
    t.same("tags lowercased with hyphens, past six left out and counted; a rating without its count left out",
      [p("fish-place").tags.length, p("fish-place").tags.slice(0, 2), p("fish-place").rating, report.changed[`tags past ${PLACE_TAGS_MAX}: 2`]], [PLACE_TAGS_MAX, ["seafood", "cash-only"], 0, 1]);
    t.same("the checkout steps arrive as steps", JSON.parse(p("stay").checkout), [{ title: "Keys on the table" }]);
    const again = await seedTrip(seed, send, { tripId });
    t.same("put in again, it changes the same rows (an event already there is left as it is)", [again.tripId, (await ida.get(`/api/trips/${tripId}`)).json.places.length], [tripId, 3]);
  }
}

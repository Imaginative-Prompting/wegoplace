#!/usr/bin/env node
/* A place added by hand, the rules with no browser: public/js/place-form.js.
 *   node scripts/place_form_check.mjs
 * The form's values become a place the server takes, a place becomes the form again, a change
 * writes only what differs, a new place gets an id the server takes, and a map link's own text
 * gives up its location (or doesn't, and nothing is asked of anyone).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = process.env.PLACE_FORM || path.join(HERE, "../public/js/place-form.js");
const F = await import(MOD);
const K = await import(path.join(path.dirname(MOD), "shared/place-kinds.js"));
const R = await import(path.join(path.dirname(MOD), "shared/trip-rules.js"));   // the server's own rules

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "   -> " + JSON.stringify(detail) : ""}`); }
};
const base = { name: "Tide cafe", kind: "food", subkind: "cafe", area: "harbor", address: "Cais do Sal, by the ferry steps", why: "Opens at six.", link: "example.com/tide", lat: null, lng: null };

console.log("\nthe form becomes a place");
let r = F.readPlace(base);
check("every field as the server takes it, the link made whole, no pin as two nulls",
  r.place && r.place.name === "Tide cafe" && r.place.kind === "food" && r.place.subkind === "cafe" && r.place.area === "harbor"
    && r.place.address === "Cais do Sal, by the ferry steps" && r.place.why === "Opens at six." && r.place.website === "https://example.com/tide" && r.place.lat === null && r.place.lng === null, r);
check("the kind and subkind it writes are ones the one list takes", K.readPlaceKind(r.place.kind, r.place.subkind).ok === true);
check("a name alone is enough: the kind's first subkind, no area, empty address, note and link",
  (r = F.readPlace({ name: "The bakery by the hostel", kind: "food" })).place && r.place.subkind === K.subkindsOf("food")[0] && r.place.area === null && r.place.address === "" && r.place.why === "" && r.place.website === "", r);
check("the name is trimmed and its inner spaces settled", F.readPlace({ ...base, name: "  Tide   cafe " }).place.name === "Tide cafe");
check("no name is refused under the name", (r = F.readPlace({ ...base, name: "  " })).field === "name" && /name/.test(r.words), r);
check("a name past 200 characters is refused with its length", (r = F.readPlace({ ...base, name: "a".repeat(201) })).field === "name" && /201/.test(r.words), r);
check("no kind is refused under the kind", F.readPlace({ ...base, kind: "" }).field === "kind" && F.readPlace({ ...base, kind: "pub" }).field === "kind");
check("… in the sentence the sheet shows: Choose what kind of place it is.", F.readPlace({ ...base, kind: "" }).words === "Choose what kind of place it is.", F.readPlace({ ...base, kind: "" }).words);
check("a subkind the list doesn't have becomes the kind's first", F.readPlace({ ...base, subkind: "tea house" }).place.subkind === K.subkindsOf("food")[0]);
check("a subkind from another kind's home is kept (a market under sight)", F.readPlace({ ...base, kind: "sight", subkind: "market" }).place.subkind === "market");
check("an address past 500 and a note past 500 are refused under their own fields",
  F.readPlace({ ...base, address: "a".repeat(501) }).field === "address" && F.readPlace({ ...base, why: "a".repeat(501) }).field === "why");
check("something that is not a link is refused under the link", (r = F.readPlace({ ...base, link: "ask at the desk" })).field === "link", r);
check("a pin is both numbers, and a pair the server's own rule takes", (r = F.readPlace({ ...base, lat: 38.7071, lng: -9.1355 })).place && r.place.lat === 38.7071 && r.place.lng === -9.1355
  && R.readCoordinates(r.place.lat, r.place.lng).ok === true && R.readCoordinates(F.readPlace(base).place.lat, F.readPlace(base).place.lng).ok === true, r);
check("half a pin, a pin off the planet, and 0,0 are refused as a pin",
  F.readPlace({ ...base, lat: 38.7, lng: null }).field === "pin" && F.readPlace({ ...base, lat: 91, lng: 0 }).field === "pin" && F.readPlace({ ...base, lat: 0, lng: 0 }).field === "pin");

console.log("\nthe kinds on offer");
check("seven kinds, each with a word, in the list's order", F.KIND_WORDS.map(([k]) => k).join() === K.PLACE_KINDS.join() && F.KIND_WORDS.every(([, w]) => /^[A-Z][a-z]+$/.test(w)));
check("every kind offers its own subkinds with their labels, and starts on its first",
  K.PLACE_KINDS.every((k) => { const subs = F.subkindsFor(k); return subs.length > 0 && subs.every((s) => K.subkind(s.id).kind === k && s.label) && F.firstSubkind(k) === subs[0].id; }));

console.log("\na new place's id");
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
check("the name as a slug, then the tail", F.placeId("Tide cafe", "k3x9qa") === "tide-cafe-k3x9qa");
check("accents fold, punctuation becomes one hyphen", F.placeId("Café  São João (porto)", "abc123") === "cafe-sao-joao-porto-abc123");
check("a name with no letters the id can hold is still an id", F.placeId("東京タワー", "abc123") === "place-abc123" && F.placeId("", "abc123") === "place-abc123");
check("a very long name is cut to the server's 64, never ending its head on a hyphen",
  (() => { const id = F.placeId("a ".repeat(100), "abc123"); return id.length <= 64 && ID.test(id) && id.endsWith("-abc123"); })(), F.placeId("a ".repeat(100), "abc123"));
check("every id is lowercase letters, digits and single hyphens, and one the server's own rule takes",
  ["Tide cafe", "  ", "A--B", "É", "x".repeat(300), "東京タワー"].every((n) => { const id = F.placeId(n, "Q1w2E3"); return ID.test(id) && R.readNewId(id).ok === true; }));

console.log("\na place becomes the form, and a change writes only what differs");
const row = { id: "tide-cafe-k3x9qa", name: "Tide cafe", kind: "food", subkind: "cafe", area: "harbor", address: "Cais do Sal", why: "Opens at six.", website: "https://example.com/tide", lat: 38.7071, lng: -9.1355, hours: "Daily 06:00-15:00", tags: ["coffee"] };
const form = F.formOfPlace(row);
check("the form holds the place", form.name === "Tide cafe" && form.kind === "food" && form.subkind === "cafe" && form.area === "harbor" && form.link === "https://example.com/tide" && form.lat === 38.7071 && form.lng === -9.1355, form);
check("read back unchanged, nothing is written", Object.keys(F.placeChanges(row, F.readPlace(form).place)).length === 0, F.placeChanges(row, F.readPlace(form).place));
check("a new name writes the name alone", JSON.stringify(F.placeChanges(row, F.readPlace({ ...form, name: "Tide café" }).place)) === JSON.stringify({ name: "Tide café" }));
check("the area cleared writes null", JSON.stringify(F.placeChanges(row, F.readPlace({ ...form, area: "" }).place)) === JSON.stringify({ area: null }));
check("the pin moved writes both numbers; the pin removed writes both nulls",
  JSON.stringify(F.placeChanges(row, F.readPlace({ ...form, lat: 38.70712 }).place)) === JSON.stringify({ lat: 38.70712, lng: -9.1355 })
    && JSON.stringify(F.placeChanges(row, F.readPlace({ ...form, lat: null, lng: null }).place)) === JSON.stringify({ lat: null, lng: null }));
check("what the form does not show is never in a change (hours, tags)", !("hours" in F.placeChanges(row, F.readPlace({ ...form, why: "Sit outside." }).place)) && !("tags" in F.placeChanges(row, F.readPlace({ ...form, why: "Sit outside." }).place)));
check("a place with no pin, or a 0,0 one from before the rule, has no pin in the form", F.formOfPlace({ ...row, lat: null, lng: null }).lat === null && F.formOfPlace({ ...row, lat: 0, lng: 0 }).lat === null);
check("a place whose kind or subkind the list no longer has still opens", F.formOfPlace({ ...row, kind: "pub", subkind: "tea house" }).kind === "practical" && !!K.subkind(F.formOfPlace({ ...row, kind: "pub", subkind: "tea house" }).subkind));

console.log("\na location read from a link's own text");
const at = (text) => { const p = F.readMapLink(text); return p ? `${p.lat},${p.lng} ${p.from}` : null; };
const CASES = [
  ["coordinates as a maps app copies them", "38.7071, -9.1355", "38.7071,-9.1355 coordinates"],
  ["…with no space, and southern and western signs", "-33.8568,151.2153", "-33.8568,151.2153 coordinates"],
  ["a geo: address", "geo:38.7071,-9.1355?z=17", "38.7071,-9.1355 geo"],
  ["a Google place link: the place (!3d !4d), not the view (@)", "https://www.google.com/maps/place/Tide+Cafe/@38.7090,-9.1400,17z/data=!3m1!4b1!4m6!3m5!1s0xd19347!8m2!3d38.7071!4d-9.1355!16s%2Fg%2F1", "38.7071,-9.1355 google place"],
  ["a Google link with only a view", "https://www.google.com/maps/@38.7090,-9.1400,15z", "38.709,-9.14 google view"],
  ["a Google q= of coordinates (what a chat app's shared location is)", "https://maps.google.com/?q=38.7071,-9.1355", "38.7071,-9.1355 google q"],
  ["a Google search link with query= coordinates", "https://www.google.com/maps/search/?api=1&query=38.7071%2C-9.1355", "38.7071,-9.1355 google query"],
  ["a Google link on another country's address", "https://www.google.pt/maps?ll=38.7071,-9.1355&z=16", "38.7071,-9.1355 google ll"],
  ["an Apple Maps link with ll and a name", "https://maps.apple.com/?ll=38.7071,-9.1355&q=Tide%20Cafe", "38.7071,-9.1355 apple ll"],
  ["an Apple Maps place link with coordinate", "https://maps.apple.com/place?address=Cais%20do%20Sal&coordinate=38.7071,-9.1355&name=Tide%20Cafe", "38.7071,-9.1355 apple coordinate"],
  ["an Apple Maps view", "https://maps.apple.com/frame?center=38.7090,-9.1400&span=0.02,0.02", "38.709,-9.14 apple view"],
  ["an OpenStreetMap link with a marker", "https://www.openstreetmap.org/?mlat=38.7071&mlon=-9.1355#map=17/38.7090/-9.1400", "38.7071,-9.1355 osm marker"],
  ["an OpenStreetMap view", "https://www.openstreetmap.org/#map=17/38.7090/-9.1400", "38.709,-9.14 osm view"],
  ["a Bing Maps link", "https://www.bing.com/maps?cp=38.7071~-9.1355&lvl=16", "38.7071,-9.1355 bing"],
  ["a link typed with no https", "maps.google.com/?q=38.7071,-9.1355", "38.7071,-9.1355 google q"],
];
for (const [name, text, want] of CASES) check(name, at(text) === want, at(text));
const NONE = [
  ["a short Google link carries nothing", "https://maps.app.goo.gl/AbCdEf123456"],
  ["a Google link that names a place in words only", "https://www.google.com/maps?q=Tide+Cafe+Lisbon"],
  ["an Apple link with only a name", "https://maps.apple.com/?q=Tide%20Cafe"],
  ["a name and a town with a comma between them", "https://maps.apple.com/?q=Tide%20Cafe,%20Lisbon"],
  ["a street number and a postcode with a comma between them", "https://www.google.com/maps?q=12,+1100+Lisboa"],
  ["a place's own site", "https://example.com/tide?ll=38.7071,-9.1355"],
  ["coordinates off the planet", "95.0, 200.0"],
  ["0,0", "0, 0"],
  ["three numbers", "38.7071, -9.1355, 17"],
  ["a street address with a number", "Rua do Sal 12, 1100-001"],
  ["nothing", ""],
];
for (const [name, text] of NONE) check(`${name}: no location`, at(text) === null, at(text));
check("a short map link is known as one, so the sheet can say why it can't be read",
  F.isShortMapLink("https://maps.app.goo.gl/AbCdEf") && F.isShortMapLink("goo.gl/maps/abc") && !F.isShortMapLink("https://www.google.com/maps/@38.7,-9.1,15z") && !F.isShortMapLink("example.com"));
check("a view is told from a place", F.isViewOnly(F.readMapLink("https://www.google.com/maps/@38.7090,-9.1400,15z")) && !F.isViewOnly(F.readMapLink("38.7071, -9.1355")) && !F.isViewOnly(null));
check("a pin's words are five decimals", F.pinWords(38.7071, -9.1355) === "38.70710, -9.13550");

console.log("\na pin lies in its area");
const AREAS = [
  { id: "town", name: "The town", parent: null, west: -9.20, south: 38.68, east: -9.10, north: 38.75 },
  { id: "old-town", name: "Old town", parent: "town", west: -9.14, south: 38.70, east: -9.12, north: 38.72 },
  { id: "hill", name: "The hill", parent: "town", west: null, south: null, east: null, north: null },
  { id: "far", name: "Far shore", parent: null, west: null, south: null, east: null, north: null },
  { id: "isles", name: "The isles", parent: null, west: 177, south: -18, east: -178, north: -16 },
];
check("inside its area: fine", F.pinOutsideArea(AREAS, "old-town", 38.7071, -9.1355) === null);
check("outside its area but inside the area's parent: fine, as the server has it", F.pinOutsideArea(AREAS, "old-town", 38.69, -9.18) === null);
check("outside both: a sentence that names the area", F.pinOutsideArea(AREAS, "old-town", 40.4, -3.7) === "That spot is outside Old town. Move the pin, or pick the area it is in.", F.pinOutsideArea(AREAS, "old-town", 40.4, -3.7));
check("an area with no bounds under a parent that has them: held to the parent, and named by it",
  F.pinOutsideArea(AREAS, "hill", 38.70, -9.15) === null && /outside The town\./.test(F.pinOutsideArea(AREAS, "hill", 40.4, -3.7) || ""), F.pinOutsideArea(AREAS, "hill", 40.4, -3.7));
check("no bounds anywhere, no area, an area the trip doesn't have, or no pin: nothing to hold it to",
  F.pinOutsideArea(AREAS, "far", 1, 1) === null && F.pinOutsideArea(AREAS, "", 1, 1) === null && F.pinOutsideArea(AREAS, null, 1, 1) === null
    && F.pinOutsideArea(AREAS, "nowhere", 1, 1) === null && F.pinOutsideArea(AREAS, "old-town", null, null) === null && F.pinOutsideArea(null, "old-town", 1, 1) === null);
check("an area across the 180° line holds a pin on either side of it",
  F.pinOutsideArea(AREAS, "isles", -17, 179.5) === null && F.pinOutsideArea(AREAS, "isles", -17, -179.5) === null && F.pinOutsideArea(AREAS, "isles", -17, 170) !== null);
r = F.readPlace({ ...base, area: "old-town", lat: 40.4, lng: -3.7 }, { areas: AREAS });
check("the form refuses such a pin under the pin, before anything is sent", r.field === "pin" && /outside Old town/.test(r.words), r);
r = F.readPlace({ ...base, area: "old-town", lat: 38.7071, lng: -9.1355 }, { areas: AREAS });
check("…and takes one inside", !!r.place && r.place.lat === 38.7071 && r.place.area === "old-town", r);
r = F.readPlace({ ...base, area: "", lat: 40.4, lng: -3.7 }, { areas: AREAS });
check("…and one anywhere when the place has no area", !!r.place && r.place.area === null, r);

console.log("\nthe sentences");
check("near another of its kind: both names and the distance",
  F.nearWords({ name: "Tide cafe" }, { name: "Harbor Grill" }, 12.4) === "“Tide cafe” is 12 m from “Harbor Grill”. If they are one place, remove one of them.", F.nearWords({ name: "Tide cafe" }, { name: "Harbor Grill" }, 12.4));
check("…and it still reads when the other place isn't on this phone", F.nearWords({ name: "Tide cafe" }, null, undefined) === "“Tide cafe” is a few meters from “another place”. If they are one place, remove one of them.", F.nearWords({ name: "Tide cafe" }, null, undefined));
check("a place one plan is at: the plan by name", F.inUseWords({ name: "Tide cafe" }, { events: [{ title: "Breakfast before the ferry" }], places: [] }) === "“Tide cafe” is where a plan is: “Breakfast before the ferry”. Change where that plan is first.",
  F.inUseWords({ name: "Tide cafe" }, { events: [{ title: "Breakfast before the ferry" }], places: [] }));
const five = ["One", "Two", "Three", "Four", "Five"].map((title) => ({ title }));
check("five plans: three by name and how many more", F.inUseWords({ name: "Tide cafe" }, { events: five, places: [] }) === "“Tide cafe” is where 5 plans are: “One”, “Two”, “Three” and 2 more. Change where those plans are first.",
  F.inUseWords({ name: "Tide cafe" }, { events: five, places: [] }));
check("a place another is listed as near", F.inUseWords({ name: "The hostel" }, { events: [], places: [{ name: "Corner bakery" }] }) === "“Corner bakery” is listed as near “The hostel”, so “The hostel” stays.",
  F.inUseWords({ name: "The hostel" }, { events: [], places: [{ name: "Corner bakery" }] }));
check("…and two", F.inUseWords({ name: "The hostel" }, { events: [], places: [{ name: "Corner bakery" }, { name: "The pier" }] }) === "2 places are listed as near “The hostel” (“Corner bakery”, “The pier”), so it stays.",
  F.inUseWords({ name: "The hostel" }, { events: [], places: [{ name: "Corner bakery" }, { name: "The pier" }] }));
check("nothing points at it: nothing to say", F.inUseWords({ name: "Tide cafe" }, { events: [], places: [] }) === "" && F.inUseWords({ name: "Tide cafe" }, null) === "");

// ── a place's write the server turns down ──
const refused = (op, status, body, known) => F.placeRefusalWords({ op: { kind: "place", id: "tide-cafe-ab12cd", ...op }, status, body }, known);
check("not a place's write: nothing to say", F.placeRefusalWords({ op: { kind: "purchase", op: "create", id: "x", payload: { name: "Lunch" } }, status: 400, body: {} }) === null && F.placeRefusalWords({}) === null);
check("a 403 is the general line's", refused({ op: "update", payload: { why: "x" } }, 403, { error: "forbidden" }, { name: "Tide cafe" }) === null);
check("removed, but a plan was put there meanwhile", refused({ op: "delete", payload: { name: "Tide cafe" } }, 409, { error: "place in use", events: ["e1"], event_count: 1 }) === "A plan is at “Tide cafe” now, so it stays.",
  refused({ op: "delete", payload: { name: "Tide cafe" } }, 409, { error: "place in use", events: ["e1"], event_count: 1 }));
check("…three plans", refused({ op: "delete", payload: { name: "Tide cafe" } }, 409, { error: "place in use", events: ["a", "b", "c"], event_count: 3 }) === "3 plans are at “Tide cafe” now, so it stays.");
check("…or another place is near it now", refused({ op: "delete", payload: { name: "Tide cafe" } }, 409, { error: "place in use", places: ["p1"], place_count: 1 }) === "Another place is listed as near “Tide cafe” now, so it stays.");
check("a removal with no name still reads", refused({ op: "delete", payload: null }, 409, { error: "place in use", event_count: 1 }) === "A plan is at that place now, so it stays.");
check("a new place whose area is gone", refused({ op: "create", payload: { name: "Tide cafe", area: "harbor" } }, 400, { error: "bad places", rows: [{ index: 0, id: "tide-cafe-ab12cd", error: 'There is no area "harbor" in this trip. Use the id of one of its areas (old-town).' }] }) === "Its area was removed on another phone, so “Tide cafe” wasn't added.",
  refused({ op: "create", payload: { name: "Tide cafe", area: "harbor" } }, 400, { error: "bad places", rows: [{ index: 0, error: 'There is no area "harbor" in this trip.' }] }));
check("a change whose pin is outside the area by then, named by what the phone knows", refused({ op: "update", payload: { lat: 1, lng: 2 } }, 400, { error: "bad places", rows: [{ index: 0, error: '1, 2 is outside the bounds of "harbor" (west 0, south 0, east 1, north 1). Check the coordinates against a map source; if they\'re right, the area\'s bounds are too small.' }] }, { name: "Tide cafe" }) === "The pin is outside the place's area, so the change to “Tide cafe” wasn't kept.",
  refused({ op: "update", payload: { lat: 1, lng: 2 } }, 400, { error: "bad places", rows: [{ index: 0, error: '1, 2 is outside the bounds of "harbor" (…)' }] }, { name: "Tide cafe" }));
check("a change to a place removed on another phone", refused({ op: "update", payload: { why: "Sit outside." } }, 400, { error: "bad places", rows: [{ index: 0, error: "A new place needs id, name, kind, subkind; this one has no name, kind, subkind. Every other field is left out when you don't have it from a source." }] }, { name: "Tide cafe" }) === "“Tide cafe” was removed on another phone.");
check("a trip that is full", refused({ op: "create", payload: { name: "Tide cafe" } }, 409, { error: "too many places", max: 2000, reason: "A trip holds at most 2000 places; this would make 2001." }) === "This trip has as many places as a trip holds (2000), so “Tide cafe” wasn't added.");
check("anything else: what was lost, without the server's field names", refused({ op: "create", payload: { name: "Tide cafe" } }, 400, { error: "bad places", rows: [{ index: 0, error: "website is the place's own site, an http or https address, at most 500 characters." }] }) === "“Tide cafe” wasn't added." &&
  refused({ op: "update", payload: { website: "x" } }, 400, { error: "bad places", rows: [] }) === "The change to that place wasn't kept.");
check("a long name is cut", refused({ op: "create", payload: { name: "A".repeat(60) } }, 400, {}) === `“${"A".repeat(39)}…” wasn't added.`);

console.log("\narea chips");
const dupAreas = [
  { id: "ca", name: "Costa Alta", parent: null, sort: 0 },
  { id: "ca-centro", name: "Centro", parent: "ca", sort: 0 },
  { id: "ca-airport", name: "Airport", parent: "ca", sort: 1 },
  { id: "ca-puerto", name: "El Puerto", parent: "ca", sort: 2 },
  { id: "vs", name: "Valle Seco", parent: null, sort: 1 },
  { id: "vs-centro", name: "Centro", parent: "vs", sort: 0 },
  { id: "vs-airport", name: "Airport", parent: "vs", sort: 1 },
  { id: "vs-loma", name: "La Loma", parent: "vs", sort: 2 },
];
const chips = F.areaChipList(dupAreas).map((c) => `${c.id}:${c.name}`);
check("duplicate area names add their parent while unique names stay concise",
  chips.join("|") === "ca:Costa Alta|ca-centro:Centro, Costa Alta|ca-airport:Airport, Costa Alta|ca-puerto:El Puerto|vs:Valle Seco|vs-centro:Centro, Valle Seco|vs-airport:Airport, Valle Seco|vs-loma:La Loma",
  chips.join("|"));
const uniqueChips = F.areaChipList(AREAS.slice(0, 3)).map((c) => `${c.id}:${c.name}`);
check("when every area name is unique, none adds its parent",
  uniqueChips.join("|") === "town:The town|old-town:Old town|hill:The hill",
  uniqueChips.join("|"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// The trip's areas, read (public/js/areas.js): the words for a place's area, the regions the
// map names, and boxes either side of the 180° line. Node only: no server, no browser.
//   node scripts/areas_check.mjs
import { readAreas, boundsOf, inBounds, widthOf, nearLng, nearTrip, boxAround } from "../public/js/areas.js";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass += 1; else { fail += 1; console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const close = (a, b) => Math.abs(a - b) < 1e-9;

// A made-up trip: a city with two neighborhoods, a valley drawn inside its province, a region
// with no bounds, and an island group across the 180° line.
const areas = [
  { id: "harbor", name: "Harbor City", parent: null, west: -9.3, south: 38.6, east: -9.0, north: 38.9, sort: 0 },
  { id: "old-town", name: "Old Town", parent: "harbor", west: null, south: null, east: null, north: null, sort: 1 },
  { id: "docks", name: "Docks", parent: "harbor", sort: 2 },
  { id: "province", name: "The Province", parent: null, west: -8.5, south: 39.0, east: -6.5, north: 41.0, sort: 3 },
  { id: "valley", name: "Green Valley", parent: null, west: -7.6, south: 39.8, east: -7.2, north: 40.1, sort: 4 },
  { id: "coast", name: "The Coast", parent: null, sort: 5 },
  { id: "islands", name: "The Islands", parent: null, west: 177, south: -19, east: -178, north: -16, sort: 6 },
];
const A = readAreas(areas);

// ── the words ──
check("a neighborhood is named with its region", A.label("old-town") === "Old Town, Harbor City", A.label("old-town"));
check("a region is its own name", A.label("harbor") === "Harbor City" && A.label("coast") === "The Coast");
check("no area is no words", A.label("") === "" && A.label(null) === "" && A.label(undefined) === "");
check("a code no row answers for reads as words", A.label("north_shore") === "North Shore" && A.label("far-side") === "Far Side", `${A.label("north_shore")} / ${A.label("far-side")}`);
check("a trip with no areas still words a code", readAreas([]).label("old_town") === "Old Town" && readAreas(null).label("x") === "X");
check("a child whose parent row is missing is named alone", readAreas([{ id: "lost", name: "Lost Quarter", parent: "gone" }]).label("lost") === "Lost Quarter");

// ── the regions ──
check("the regions are the top-level areas, in the trip's order", same(A.regions.map((r) => r.id), ["harbor", "province", "valley", "coast", "islands"]), A.regions.map((r) => r.id).join(","));
check("a region without bounds has none", A.regions.find((r) => r.id === "coast").bounds === null);
check("only bounded regions are shaded, smallest first", same(A.bounded.map((r) => r.id), ["harbor", "valley", "province", "islands"]), A.bounded.map((r) => r.id).join(","));
check("a place belongs to its area's region", A.regionOf({ area: "docks", lng: 0, lat: 0 }).id === "harbor");
check("a place in a region without bounds still belongs to it", A.regionOf({ area: "coast", lng: 5, lat: 5 }).id === "coast");
check("a place with no area belongs to the region that holds it", A.regionOf({ lng: -9.1, lat: 38.7 }).id === "harbor");
check("the smaller of two boxes wins", A.regionOf({ lng: -7.4, lat: 40.0 }).id === "valley" && A.regionOf({ lng: -8.0, lat: 40.5 }).id === "province");
check("a place with an area no row answers for is found by its coordinates", A.regionOf({ area: "north_shore", lng: -7.4, lat: 40.0 }).id === "valley");
check("a place nowhere near has no region", A.regionOf({ lng: 20, lat: 20 }) === null && A.regionOf(null) === null && A.regionOf({}) === null);
check("inRegion is the same rule for one region", A.inRegion(A.regions[0], { area: "old-town" }) && !A.inRegion(A.regions[0], { lng: -7.4, lat: 40.0 }) && !A.inRegion(null, { area: "old-town" }));

// ── bounds ──
check("bounds are four numbers or nothing", boundsOf(areas[0]).west === -9.3 && boundsOf(areas[1]) === null && boundsOf(areas[2]) === null && boundsOf(null) === null);
check("bad bounds are no bounds", boundsOf({ west: 1, south: 5, east: 2, north: 4 }) === null && boundsOf({ west: 1, south: 1, east: 1, north: 2 }) === null
  && boundsOf({ west: -181, south: 1, east: 1, north: 2 }) === null && boundsOf({ west: "", south: 1, east: 1, north: 2 }) === null);
check("numbers sent as text are read", same(boundsOf({ west: "1", south: "2", east: "3", north: "4" }), { west: 1, south: 2, east: 3, north: 4 }));
const isl = boundsOf(areas[6]);
check("a box across the line is 5° wide, not 355°", close(widthOf(isl), 5) && close(widthOf(boundsOf(areas[0])), 0.3), String(widthOf(isl)));
check("both sides of the line are inside it", inBounds(isl, 179.5, -17) && inBounds(isl, -179.5, -17) && inBounds(isl, 180, -17) && inBounds(isl, -180, -17) && inBounds(isl, 177, -17) && inBounds(isl, -178, -17));
check("the rest of the planet is outside it", !inBounds(isl, 0, -17) && !inBounds(isl, 176.9, -17) && !inBounds(isl, -177.9, -17) && !inBounds(isl, 179, -15.9) && !inBounds(isl, 179, -19.1));
check("padding widens every side", inBounds(isl, 176, -17, 1) && inBounds(isl, -177, -17, 1) && inBounds(isl, 179, -15, 1) && !inBounds(isl, 175.9, -17, 1));
check("an ordinary box", inBounds(boundsOf(areas[0]), -9.1, 38.7) && !inBounds(boundsOf(areas[0]), -8.9, 38.7) && !inBounds(boundsOf(areas[0]), NaN, 38.7) && !inBounds(null, 0, 0));
check("a pad that wraps the planet holds every meridian", inBounds({ west: -170, south: -10, east: 170, north: 10 }, 180, 0, 10));

// ── the same meridian, written near another ──
check("179 seen from -179 is -181", close(nearLng(179, -179), -181) && close(nearLng(-179, 179), 181) && close(nearLng(10, 20), 10) && close(nearLng(-170, 175), 190));

// ── is a camera near the trip ──
const places = [{ lng: 12.5, lat: 41.9 }, { lng: 179.9, lat: -17 }, { lng: "x", lat: 1 }];
check("near a region", nearTrip(A, [], -9.1, 38.7) && nearTrip(A, [], -11, 38.7) && !nearTrip(A, [], -13, 38.7));
check("near a place", nearTrip(A, places, 13, 42) && nearTrip(readAreas([]), places, 14.5, 44) && !nearTrip(readAreas([]), places, 20, 42));
check("near a place across the line", nearTrip(readAreas([]), places, -179.5, -17) && !nearTrip(readAreas([]), places, -170, -17));
check("near the islands from either side", nearTrip(A, [], -176, -17) && nearTrip(A, [], 175, -17) && !nearTrip(A, [], 170, -17));
check("a trip with no regions and no places is near everywhere", nearTrip(readAreas([]), [], 100, 50) && nearTrip(readAreas([]), [{ lng: null, lat: null }], 0, 0));
check("a camera that is not a number is near nothing", !nearTrip(A, places, NaN, 0) && !nearTrip(readAreas([]), [], 0, NaN));

// ── the box around points and boxes ──
const b1 = boxAround([[-9.1, 38.7], [-7.4, 40.0]]);
check("two points on one side", close(b1.west, -9.1) && close(b1.east, -7.4) && close(b1.south, 38.7) && close(b1.north, 40.0) && close(b1.width, 1.7), JSON.stringify(b1));
const b2 = boxAround([[179.5, -17], [-179.5, -16]]);
check("two points either side of the line are 1° apart", close(b2.west, 179.5) && close(b2.east, -179.5) && close(b2.width, 1), JSON.stringify(b2));
const b3 = boxAround([[170, 0]], [isl]);
check("a point and a box across the line", close(b3.west, 170) && close(b3.east, -178) && close(b3.width, 12) && b3.south === -19 && b3.north === 0, JSON.stringify(b3));
const b4 = boxAround([[5, 5]]);
check("one point is a box of no width", close(b4.west, 5) && close(b4.east, 5) && b4.width === 0, JSON.stringify(b4));
check("nothing is no box", boxAround([]) === null && boxAround(null, [null]) === null && boxAround([[NaN, 1]]) === null);
const b5 = boxAround([[-170, 0], [-50, 0], [70, 0]]);
check("three points a third of the way round each: the box leaves out one gap", close(b5.width, 240), JSON.stringify(b5));
const b6 = boxAround([[-9.1, 38.7]], [boundsOf(areas[0]), boundsOf(areas[3])]);
check("boxes on one side", close(b6.west, -9.3) && close(b6.east, -6.5) && b6.south === 38.6 && b6.north === 41.0, JSON.stringify(b6));
const b7 = boxAround([[0, 0], [90, 0], [180, 0], [-90, 0]]);
check("points all the way round still give one box", b7 && b7.width <= 360 && b7.width >= 270, JSON.stringify(b7));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

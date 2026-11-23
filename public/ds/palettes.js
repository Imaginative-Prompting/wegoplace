// The palettes of a picture someone draws: a ground and two inks each. A picture always sits on its palette's ground,
// so it looks the same on the black app and the light one; it is the one place a person has colour.
//
// A stored picture names its palette by its place in this list. So the list only grows at its end, and a place is
// never given another palette. Their order is dark ground to light, as the pad's row shows them.
//
// They are chosen by measurement (scripts/palette_check.mjs, on the gate, holds all three):
//   1. either ink reads on its ground: WCAG contrast at least 3.5 to 1;
//   2. the two inks stay apart without colour: CIELAB lightness at least 18 apart;
//   3. no two grounds are mistaken for each other by typical, deuteranope or protanope eyes: CIELAB distance at
//      least 22 in all three.
export const PALETTES = Object.freeze([
  Object.freeze({ name: "dusk", ground: "#182442", inks: Object.freeze(["#FFF5E1", "#FF8A3D"]) }),
  Object.freeze({ name: "moss", ground: "#23402B", inks: Object.freeze(["#F1F3D0", "#FF9B70"]) }),
  Object.freeze({ name: "plum", ground: "#653586", inks: Object.freeze(["#FFF6E6", "#FF8FB1"]) }),
  Object.freeze({ name: "ocean", ground: "#2B80CF", inks: Object.freeze(["#FFFFFF", "#0B1F3A"]) }),
  Object.freeze({ name: "sunrise", ground: "#E2531B", inks: Object.freeze(["#FFF8EC", "#1B2748"]) }),
  Object.freeze({ name: "sky", ground: "#9CCBF5", inks: Object.freeze(["#0B1F3A", "#A11D4E"]) }),
  Object.freeze({ name: "sun", ground: "#FFD25A", inks: Object.freeze(["#1B2748", "#C02A20"]) }),
  Object.freeze({ name: "paper", ground: "#FBF3E4", inks: Object.freeze(["#1B2748", "#0E7F77"]) }),
]);

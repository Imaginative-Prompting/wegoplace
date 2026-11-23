// ONE GROUND REGISTRY — asserted, because it was three and they disagreed.
//
// Until v9 there were three tables: CSS gradients in collage.js, canvas textures in
// collage-frames.js, and a hand-written gate list in collage-layout.js. They differed on every
// colour, and `slate` existed in exactly one of them, which made it a ground nothing could
// select and the export could not have drawn. This is the check that stops that returning.
//
// PLANTED: GROUNDCHECK_PLANT=grain reads the shared GRAIN with slate taken out (3's slate goes red);
// GROUNDCHECK_PLANT=paint reads collage.js painting its grounds with no texture (3's "paints each ground" goes red).
import { GROUNDS as SPEC, BACKGROUNDS, fastenerFor } from "../public/js/collage-layout.js";
import { GROUNDS as CANVAS, GROUND_KEYS } from "../public/js/collage-frames.js";
import { GRAIN as SHARED_GRAIN } from "../public/js/shared/board-look.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const check = (name, ok, detail) => {
  results.push(!!ok);
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? "   — " + detail : ""}`);
};

console.log("\n1. one list of grounds, not three");
check("the gate list IS the registry's own keys",
  BACKGROUNDS.join(",") === Object.keys(SPEC).join(","), BACKGROUNDS.join(","));
check("the canvas renderer knows exactly the same grounds",
  GROUND_KEYS.join(",") === Object.keys(SPEC).join(","), GROUND_KEYS.join(","));

console.log("\n2. the colours cannot drift, because there is one copy");
for (const k of Object.keys(SPEC)) {
  const a = SPEC[k].fill, b = CANVAS[k] && CANVAS[k].base;
  check(`${k}: canvas base === registry fill, both themes`,
    !!b && a.light === b.light && a.dark === b.dark,
    b ? `${a.light}/${a.dark} vs ${b.light}/${b.dark}` : "MISSING from the canvas renderer");
}

console.log("\n3. every ground is reachable and drawable");
const framesSrc = fs.readFileSync(path.join(REPO, "public/js/collage-frames.js"), "utf8");
const drawMap = (/const GROUND_DRAW = \{([\s\S]*?)\};/.exec(framesSrc) || [])[1] || "";
for (const k of Object.keys(SPEC)) {
  check(`${k}: has a canvas texture (GROUND_DRAW entry)`,
    new RegExp("(^|[\\s,{])" + k + "\\s*:").test(drawMap), k);
}
// The DOM's texture is shared/board-look.js's GRAIN (the app's board and a shared board's page both draw from it).
const GRAIN = process.env.GROUNDCHECK_PLANT === "grain" ? (({ slate, ...rest }) => rest)(SHARED_GRAIN) : SHARED_GRAIN;
for (const k of Object.keys(SPEC)) {
  const g = GRAIN[k];
  check(`${k}: has a DOM texture (GRAIN entry, both themes)`,
    !!g && typeof g.light === "string" && !!g.light && typeof g.dark === "string" && !!g.dark, k);
}
const collageSrc = ((src) => { if (process.env.GROUNDCHECK_PLANT !== "paint") return src;
  const t = src.split("(GRAIN[k] || {})").join("({})");     // the board painted with no texture
  if (t === src) throw new Error("the paint plant changed nothing"); return t; })(fs.readFileSync(path.join(REPO, "public/js/collage.js"), "utf8"));
// The board the app draws has that texture: collage.js takes GRAIN from the shared file and paints each ground with it.
const takes = /import\s*\{[^}]*\bGRAIN\b[^}]*\}\s*from\s*"\.\/shared\/board-look\.js"/.test(collageSrc);
const paints = /\(GRAIN\[k\]\s*\|\|\s*\{\}\)\.light/.test(collageSrc) && /\(GRAIN\[k\]\s*\|\|\s*\{\}\)\.dark/.test(collageSrc);
check("collage.js takes GRAIN from shared/board-look.js and paints each ground with it, both themes",
  takes && paints, `imports it: ${takes}; paints GRAIN[k] light and dark: ${paints}`);

console.log("\n4. the fastener is a property of the ground");
check("every ground names a fastener",
  Object.keys(SPEC).every((k) => !!fastenerFor(k)),
  Object.entries(SPEC).map(([k, g]) => `${k}=${g.fastener}`).join(" "));
check("corkboard gets tacks, the fridge gets magnets",
  fastenerFor("corkboard") === "tack" && fastenerFor("fridge") === "magnet");
check("an unknown ground gets NO fastener rather than a wrong one",
  fastenerFor("nope") === null);

console.log("\n5. nobody declares a ground colour privately any more");
check("collage.js declares no GRAIN of its own, and the shared GRAIN holds no hex colours",
  !/const GRAIN\s*=/.test(collageSrc) && !Object.values(GRAIN).some((g) => /#[0-9a-fA-F]{3,8}\b/.test(g.light + g.dark)),
  "GRAIN carries texture only");

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);

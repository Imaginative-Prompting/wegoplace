// The limits the guides tell an AI it will meet, held to the numbers the code keeps (public/js/shared/limits.js),
// so a limit changed without its guide fails check:guides. Each claim is a sentence in a guide, found by its
// words, with the constant its number must equal; every place a guide says "at most", "up to" or "no more
// than" a number must be one of these claims, so a new limit can't be stated unchecked. The rate limits the
// guides name are held to wrangler.jsonc's bindings too.
//
//   limitClaims({ dir, values, wrangler }) -> [{ ok, what, detail }]
//
// `values` and the guides' folder can be swapped, for the plants.

import fs from "node:fs";
import path from "node:path";
import * as L from "../../public/js/shared/limits.js";

/** The numbers the guides may state, by name: the code's own, in the unit the guide writes them in. */
export const VALUES = {
  ROWS_PER_WRITE_MAX: L.ROWS_PER_WRITE_MAX,
  MCP_CALLS_PER_MINUTE: L.MCP_CALLS_PER_MINUTE,
  AREAS_MAX: L.AREAS_MAX,
  EVENTS_MAX: L.EVENTS_MAX,
  PLACES_MAX: L.PLACES_MAX,
  PACKING_LISTS_MAX: L.PACKING_LISTS_MAX,
  PACKING_STARTERS_MAX: L.PACKING_STARTERS_MAX,
  PACKING_BAGS_MAX: L.PACKING_BAGS_MAX,
  PACKING_ITEMS_PER_OWNER_MAX: L.PACKING_ITEMS_PER_OWNER_MAX,
  PICTURE_PX: L.PICTURE_LIMITS.picture.px,
  PICTURE_KB: L.PICTURE_LIMITS.picture.bytes / 1024,
  PICTURE_LINK_MINUTES: L.PICTURE_LINK_SECONDS / 60,
  PICTURE_FETCHES_PER_MINUTE: L.PICTURE_FETCHES_PER_MINUTE,
  FREE_STORAGE_GB: L.FREE_STORAGE_BYTES / 1024 ** 3,
  PURCHASE_DESCRIPTION_MAX: L.PURCHASE_DESCRIPTION_MAX,
  PURCHASE_NOTE_MAX: L.PURCHASE_NOTE_MAX,
  PURCHASES_PER_TRIP_MAX: L.PURCHASES_PER_TRIP_MAX,
};

const N = String.raw`(\d[\d,]*)`;
/** Each limit a guide states: its guide, the words around the number (the number is the one group), the value's name. */
export const CLAIMS = [
  ["trip-setup.md", String.raw`A trip holds at most ${N} areas`, "AREAS_MAX"],
  ["trip-setup.md", String.raw`A call writes at most ${N} rows`, "ROWS_PER_WRITE_MAX"],
  ["trip-setup.md", String.raw`makes at most ${N} calls a minute`, "MCP_CALLS_PER_MINUTE"],
  ["itinerary.md", String.raw`A call takes at most ${N} events`, "ROWS_PER_WRITE_MAX"],
  ["itinerary.md", String.raw`and a trip holds at most ${N}\.`, "EVENTS_MAX"],
  ["itinerary.md", String.raw`more than ${N} to write`, "ROWS_PER_WRITE_MAX"],
  ["places.md", String.raw`A call takes at most ${N} places`, "ROWS_PER_WRITE_MAX"],
  ["places.md", String.raw`A trip holds at most ${N} places`, "PLACES_MAX"],
  ["packing.md", String.raw`a trip has at most ${N} lists`, "PACKING_LISTS_MAX"],
  ["packing.md", String.raw`lists and ${N} starters`, "PACKING_STARTERS_MAX"],
  // A list's bag limit (PACKING_BAGS_MAX) is no longer a guide's: bags left the app's packing screen (21 Nov) and the guide teaches lists.
  ["packing.md", String.raw`own items hold\s+at most ${N}`, "PACKING_ITEMS_PER_OWNER_MAX"],
  ["pictures.md", String.raw`at most \*\*${N} pixels on the long side`, "PICTURE_PX"],
  ["pictures.md", String.raw`on the long side and ${N} kB`, "PICTURE_KB"],
  ["pictures.md", String.raw`good for ${N} minutes`, "PICTURE_LINK_MINUTES"],
  ["pictures.md", String.raw`at most ${N} pictures fetched by address`, "PICTURE_FETCHES_PER_MINUTE"],
  ["pictures.md", String.raw`and ${N} upload links a minute`, "PICTURE_FETCHES_PER_MINUTE"],
  ["pictures.md", String.raw`a free account holds ${N} GB`, "FREE_STORAGE_GB"],
  ["split.md", String.raw`"Taxi from the airport"\. Up to ${N} characters`, "PURCHASE_DESCRIPTION_MAX"],
  ["split.md", String.raw`worth remembering about it\. Up to ${N} characters`, "PURCHASE_NOTE_MAX"],
  ["split.md", String.raw`at most ${N} purchases and payments`, "PURCHASES_PER_TRIP_MAX"],
];

/** Wherever a guide states a limit by these words, it must be one of the claims, or a number that isn't the site's. */
const STATES_A_LIMIT = /\b(?:at most|up to|no more than)\s+\**(\d[\d,]*)/gi;
/** Numbers said that way that aren't the site's, each with why: [guide, its words, why]. */
export const NOT_THE_SITES = [
  ["packing.md", /at most 7 kg/, "a porter's weight limit in an example starter: the trip's own fact, not the site's"],
];

/** The rate limits the guides name, against wrangler.jsonc's bindings. */
const BINDINGS = [["MCP_LIMITER", "MCP_CALLS_PER_MINUTE"], ["PICTURE_LIMITER", "PICTURE_FETCHES_PER_MINUTE"]];

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const num = (s) => Number(s.replace(/,/g, ""));

export function limitClaims({ dir = path.join(ROOT, "src/mcp/guides"), values = VALUES, wrangler = fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8") } = {}) {
  const out = [];
  const texts = Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
  const covered = Object.fromEntries(Object.keys(texts).map((f) => [f, []]));
  for (const [file, words, name] of CLAIMS) {
    const text = texts[file] ?? "";
    const found = [...text.matchAll(new RegExp(words, "g"))];
    const want = values[name];
    const said = found.map((m) => num(m[1]));
    out.push({
      ok: found.length > 0 && said.every((n) => n === want),
      what: `${file} states ${name}, ${want.toLocaleString("en-US")}`,
      detail: found.length ? `says ${said.join(", ")}` : "not found in the guide (reworded? then its claim here changes with it)",
    });
    for (const m of found) covered[file].push([m.index, m.index + m[0].length]);
  }
  const loose = [];
  for (const [file, text] of Object.entries(texts)) {
    for (const m of text.matchAll(STATES_A_LIMIT)) {
      const notOurs = NOT_THE_SITES.some(([f, words]) => f === file && words.test(text.slice(m.index, m.index + 60)));
      if (!notOurs && !covered[file].some(([a, b]) => m.index >= a && m.index < b)) loose.push(`${file}: "${text.slice(m.index, m.index + 40).replace(/\s+/g, " ")}…"`);
    }
  }
  out.push({ ok: loose.length === 0, what: "every limit a guide states (at most, up to, no more than a number) is one of the claims", detail: loose.join("; ") });
  for (const [binding, name] of BINDINGS) {
    const m = wrangler.match(new RegExp(`"name":\\s*"${binding}"[^}]*"limit":\\s*(\\d+)`));
    out.push({ ok: !!m && Number(m[1]) === values[name], what: `wrangler.jsonc's ${binding} is ${name} (${values[name]})`, detail: m ? `limit ${m[1]}` : "binding not found" });
  }
  return out;
}

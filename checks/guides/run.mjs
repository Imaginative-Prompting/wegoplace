// The guides an AI reads (src/mcp/guides/, served by the MCP) against the code that holds them to
// what they say: today, the place subkinds and every example's rows. No server. The guides
// promise these (model §16; the guides' README, "Rules for these files"):
//   * the block marked `text list:place_subkinds` in places.md is the shared module's list,
//     home kinds and order included, character for character (public/js/shared/place-kinds.js);
//   * every fenced `json example:<tool>` block is JSON, and every row in it passes the checks
//     the routes hold that row to: a place's id, kind and subkind, hours, tags and coordinates;
//     an area's id and bounds; a packing list's and bag's keys, a starter's category; an
//     event's kind. (Running each example through the real tool is the MCP's check, when the
//     tools exist.)
//
//   node checks/guides/run.mjs [--guides <folder>]     (or WGP_GUIDES)
// The folder defaults to the repo's own copy, src/mcp/guides/, the one that is edited. Each
// example also runs through its real tool in check:mcp (checks/mcp/guides.mjs).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, CheckError } from "../lib/server.mjs";
import { VALUES, limitClaims } from "./limits.mjs";
import { Report } from "../lib/person.mjs";
import { SUBKIND_LIST, readPlaceKind } from "../../public/js/shared/place-kinds.js";
import { readHours } from "../../public/js/shared/hours.js";
import { readBounds, readCoordinates, readNewId, readTags } from "../../public/js/shared/trip-rules.js";
import { CATEGORIES } from "../../src/api/packing.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const dir = path.resolve(flag("--guides") ?? process.env.WGP_GUIDES ?? path.join(ROOT, "src/mcp/guides"));
const t = new Report("guides");
const EVENT_KINDS = ["flight", "transit", "lodging", "meal", "activity", "plan"];
const KEY = /^[a-z0-9-]{1,40}$/;

let code = 1;
try {
  if (!fs.existsSync(path.join(dir, "places.md"))) throw new CheckError(`no guides at ${dir} (pass --guides <folder>)`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const blocks = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    for (const m of text.matchAll(/^```(\S+)(?: ([a-z]+):(\S+))?\n([\s\S]*?)^```$/gm)) blocks.push({ file, lang: m[1], role: m[2], name: m[3], body: m[4] });
  }

  t.part("The subkinds in places.md are the module's");
  const lists = blocks.filter((b) => b.role === "list" && b.name === "place_subkinds");
  t.same("places.md has the list once", lists.map((b) => b.file), ["places.md"]);
  const want = `${SUBKIND_LIST}\n`;
  const got = lists[0]?.body ?? "";
  const firstOff = [...want].findIndex((c, i) => c !== got[i]);
  t.ok("it is public/js/shared/place-kinds.js's list, home kinds and order included, character for character", got === want,
    firstOff < 0 ? `the guide's block is ${got.length} characters, the module's ${want.length}` : `they part at character ${firstOff}: guide "${got.slice(firstOff, firstOff + 30)}", module "${want.slice(firstOff, firstOff + 30)}"`);

  t.part("Every example is JSON, and its rows pass the routes' checks");
  const examples = blocks.filter((b) => b.role === "example");
  const parsed = [];
  for (const b of examples) {
    try { parsed.push({ ...b, json: JSON.parse(b.body) }); } catch (e) { t.ok(`${b.file}, ${b.name}: is JSON`, false, e.message); }
  }
  t.ok(`all ${examples.length} examples in ${files.length} guides are JSON`, parsed.length === examples.length);
  const off = [];
  const where = (b, i) => `${b.file}, ${b.name}${i === undefined ? "" : ` row ${i + 1}`}`;
  let places = 0, areas = 0, events = 0, lists2 = 0, starters = 0;
  for (const b of parsed) {
    const j = b.json;
    for (const [i, p] of (j.places ?? []).entries()) {
      places++;
      const checks = [readNewId(p.id), readPlaceKind(p.kind, p.subkind)];
      if (p.hours) checks.push(readHours(p.hours));
      if (p.tags) checks.push(readTags(p.tags));
      if (p.lat !== undefined || p.lng !== undefined) checks.push(readCoordinates(p.lat, p.lng));
      for (const c of checks) if (!c.ok) off.push(`${where(b, i)} (${p.id}): ${c.error.split("\n")[0]}`);
      if (!p.name || !p.why) off.push(`${where(b, i)} (${p.id}): a place needs a name and a why`);
    }
    for (const [i, a] of (j.areas ?? []).entries()) {
      areas++;
      for (const c of [readNewId(a.id), readBounds(a)]) if (!c.ok) off.push(`${where(b, i)} (${a.id}): ${c.error}`);
    }
    for (const [i, e] of (j.events ?? []).entries()) {
      events++;
      if (e.kind && !EVENT_KINDS.includes(e.kind)) off.push(`${where(b, i)}: "${e.kind}" isn't one of the six kinds`);
      if (e.id !== undefined && !readNewId(e.id).ok) off.push(`${where(b, i)}: ${readNewId(e.id).error}`);
    }
    for (const [i, l] of (j.lists ?? []).entries()) {
      lists2++;
      if (!KEY.test(l.key)) off.push(`${where(b, i)}: the list key "${l.key}"`);
      for (const bag of l.bags ?? []) if (!KEY.test(bag.key)) off.push(`${where(b, i)}: the bag key "${bag.key}"`);
      if (l.repeat !== undefined && !["once", "daily"].includes(l.repeat)) off.push(`${where(b, i)}: repeat "${l.repeat}"`);
    }
    for (const [i, s] of (j.starters ?? []).entries()) {
      starters++;
      if (!CATEGORIES.includes(s.category)) off.push(`${where(b, i)}: the category "${s.category}"`);
      if (!["person", "group"].includes(s.scope)) off.push(`${where(b, i)}: the scope "${s.scope}"`);
      for (const [list, bag] of Object.entries(s.bags ?? {})) if (!KEY.test(list) || !KEY.test(bag)) off.push(`${where(b, i)}: bags ${list}: ${bag}`);
    }
  }
  t.ok(`their ${places} places, ${areas} areas, ${events} events, ${lists2} packing lists and ${starters} starters pass the routes' checks`, off.length === 0, off.join("\n        "));
  const used = parsed.flatMap((b) => (b.json.places ?? []).map((p) => p.subkind));
  t.ok(`every subkind an example uses is on the list (${new Set(used).size} of them)`, used.every((s) => readPlaceKind("sight", s).ok), used.filter((s) => !readPlaceKind("sight", s).ok));

  // The limits a guide tells an AI it will meet are the code's (checks/guides/limits.mjs).
  t.part("Every limit a guide states is the code's");
  for (const r of limitClaims({ dir })) t.ok(r.what, r.ok, r.detail);
  // Planted, each on a copy of the guides (or of the numbers): each must turn a line red.
  const plantDir = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-guide-limits-"));
  try {
    const plant = (file, edit) => {
      fs.rmSync(plantDir, { recursive: true, force: true }); fs.mkdirSync(plantDir);
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) fs.copyFileSync(path.join(dir, f), path.join(plantDir, f));
      if (file) { const p = path.join(plantDir, file); const before = fs.readFileSync(p, "utf8"); const after = edit(before); if (after === before) throw new CheckError(`a plant changed nothing in ${file}`); fs.writeFileSync(p, after); }
      return plantDir;
    };
    const red = (results) => results.filter((r) => !r.ok).length;
    const wrangler = fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
    t.same("  (planted: places.md says 2,500 places; the code says 2,000; the one rule saying 2,000 places red, nothing else)",
      red(limitClaims({ dir: plant("places.md", (s) => s.replace("A trip holds at most 2,000 places", "A trip holds at most 2,500 places")) })), 1);
    t.same("  (planted: the code's PLACES_MAX moved without its guide: red)",
      red(limitClaims({ dir: plant(null), values: { ...VALUES, PLACES_MAX: VALUES.PLACES_MAX + 500 } })), 1);
    t.same("  (planted: a guide states a new limit no claim holds, \"at most 9 trips\": red)",
      red(limitClaims({ dir: plant("trip-setup.md", (s) => s.replace("A trip holds at most 200 areas.", "A trip holds at most 200 areas, and a person at most 9 trips.")) })), 1);
    t.same("  (planted: wrangler.jsonc's MCP_LIMITER at 400 while the code says 300: red)",
      red(limitClaims({ dir: plant(null), wrangler: wrangler.replace(/("name":\s*"MCP_LIMITER"[^}]*"limit":\s*)300/, "$1400") })), 1);
    t.same("  (planted: a claim's sentence reworded away, so the number goes unchecked: red)",
      red(limitClaims({ dir: plant("pictures.md", (s) => s.replace("good for 15 minutes", "valid for a quarter of an hour")) })), 1);
  } finally {
    fs.rmSync(plantDir, { recursive: true, force: true });
  }

  // What a guide says get_trip's members carry (“In `get_trip`'s members, `guest: true` marks…”) is what the tool answers:
  // each field named that way is a key of its members (src/mcp/tools.js), so a field renamed or dropped there fails here.
  t.part("The people on a trip, as the guides name them, are what get_trip answers");
  const toolsText = fs.readFileSync(path.join(ROOT, "src/mcp/tools.js"), "utf8");
  const memberFields = (guideText, tools) => {
    const named = [...guideText.matchAll(/`get_trip`'s members, `(\w+): true`/g)].map((m) => m[1]);
    const shape = /members: \(s\.members \?\? \[\]\)\.map\(\(m\) => \(\{([^}]*)\}\)\)/.exec(tools)?.[1] ?? "";
    const keys = [...shape.matchAll(/(\w+):/g)].map((m) => m[1]);
    return { named, missing: named.filter((f) => !keys.includes(f)) };
  };
  const allGuides = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  const fields = memberFields(allGuides, toolsText);
  t.ok(`the members' fields the guides name (${fields.named.join(", ") || "none"}) are get_trip's`, fields.named.length > 0 && fields.missing.length === 0, fields.missing.join(", "));
  t.same("  (planted: get_trip without its guest field: red)", memberFields(allGuides, toolsText.replace(", guest: !!m.guest", "")).missing, ["guest"]);
  t.same("  (planted: a guide naming a field get_trip hasn't, `visitor: true`: red)",
    memberFields(allGuides.replace("members, `guest: true`", "members, `visitor: true`"), toolsText).missing, ["visitor"]);
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  code = 2;
}
process.exit(code);

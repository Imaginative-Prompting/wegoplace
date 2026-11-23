// Puts a trip from a seed file into a running server, through the same routes the app and
// the MCP use, as the trip's host. What replaced POST …/import: every row is held to the
// checks a person's or an AI's write is held to, so a seed can't put in what the app would
// refuse.
//
//   node tools/seed-trip.mjs <seed.json> --base=http://127.0.0.1:<port> --session <wgp_session value> [--trip-id <id>] [--quiet]
//   (or WGP_BASE and WGP_SESSION in the environment; the address is read by scripts/lib/browser.mjs's
//   baseUrl(), so there is no default server to write to by mistake)
//
// The session is the trip's host-to-be: the account it belongs to makes the trip (or must
// already host it, when the trip exists). A harness imports seedTrip() and passes its own
// request function instead.
//
// THE SEED FILE: { trip: { id?, name, starts_on?, ends_on?, default_tz, currencies?, interests? },
//   areas?: [...], places: [...], events: [...], packing_lists?: [...], packing_starters?: [...] }
// in the shapes the routes take (docs/API.md). Older seeds are read the way the app reads old
// rows, and the tool says what it changed:
//   * a kind and a subkind are the list's (public/js/shared/place-kinds.js, readPlaceKind), a subkind in another case
//     or with spaces or hyphens respelled (spelledSubkind); any other word refuses the seed, naming the place;
//   * hours in another spelling are written in the one format when every word of them can be
//     read (hours.js, readOldHours); otherwise the text moves to the top of `notes`;
//   * tags are lowercased and joined by hyphens; one that only repeats the subkind is dropped; past six, the rest are
//     left out, and the report counts them (a seed for a lane's check, not a person's trip);
//   * with no `areas`, each area code the places use becomes a top-level area without bounds,
//     its id the code in lowercase with hyphens, its name the code in words;
//   * a rating without its count, a price level outside 1 to 4, coordinates of 0,0, and a
//     checkout that isn't a list of steps are left out; pictures (`image_*`, `gallery`) wait
//     for the pictures routes and aren't sent.
// Events already on the trip are left as they are (a create sent again finds its row).

import fs from "node:fs";
import { readPlaceKind, spelledSubkind } from "../public/js/shared/place-kinds.js";
import { readHours, readOldHours } from "../public/js/shared/hours.js";
import { PLACE_TAGS_MAX, ROWS_PER_WRITE_MAX } from "../public/js/shared/limits.js";
import { baseUrl } from "../scripts/lib/browser.mjs";

const slug = (v) => String(v).trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
const words = (code) => String(code).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function tagsOf(t) {
  if (Array.isArray(t)) return t.map(String);
  if (typeof t === "string" && t.trim()) {
    try { const x = JSON.parse(t); return Array.isArray(x) ? x.map(String) : []; } catch { return []; }
  }
  return [];
}

/** One seed place as the routes take it, and what had to change. */
export function placeFromSeed(p, { areaIdOf, ids }) {
  const said = [];
  const out = { id: p.id, name: String(p.name ?? "").trim().slice(0, 200), why: String(p.why ?? "").trim().slice(0, 500) };
  const sub = spelledSubkind(p.subkind) ?? p.subkind;
  const kind = readPlaceKind(typeof p.kind === "string" ? p.kind.trim().toLowerCase() : p.kind, sub);
  if (!kind.ok) throw new Error(`place ${p.id}: ${kind.error}`);
  out.kind = kind.kind;
  out.subkind = kind.subkind;
  if (kind.subkind !== p.subkind || kind.kind !== p.kind) said.push("subkind");

  let notes = String(p.notes ?? "").trim();
  if (p.hours && String(p.hours).trim()) {
    const strict = readHours(String(p.hours));
    const lenient = strict.ok ? strict : readOldHours(String(p.hours));
    if (lenient.ok) { out.hours = lenient.text; if (!strict.ok) said.push("hours respelled"); }
    else { notes = `${String(p.hours).trim()}${notes ? `\n\n${notes}` : ""}`; said.push("hours to notes"); }
  }
  if (notes) out.notes = notes.slice(0, 4000);

  const tags = [];
  for (const t of tagsOf(p.tags)) {
    const s = slug(t);
    if (s && s !== out.subkind && !tags.includes(s)) tags.push(s);
  }
  if (tags.length > PLACE_TAGS_MAX) said.push(`tags past ${PLACE_TAGS_MAX}: ${tags.length - PLACE_TAGS_MAX}`);
  if (tags.length) out.tags = tags.slice(0, PLACE_TAGS_MAX);

  for (const k of ["name_local", "address", "address_note", "source"]) if (p[k]) out[k] = String(p[k]).trim().slice(0, k === "address_note" || k === "source" ? 1000 : k === "address" ? 500 : 200);
  if (p.phone && String(p.phone).length <= 40) out.phone = String(p.phone).trim();
  if (p.website && /^https?:\/\/\S+$/i.test(p.website) && p.website.length <= 500) out.website = p.website;
  if (p.area) out.area = areaIdOf(p.area);
  if (Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0)) { out.lat = p.lat; out.lng = p.lng; }
  if (p.rating > 0 && p.rating <= 5 && Number.isInteger(p.rating_count) && p.rating_count >= 1) { out.rating = p.rating; out.rating_count = p.rating_count; }
  else if (p.rating) said.push("rating without its count");
  if (Number.isInteger(p.price_level) && p.price_level >= 1 && p.price_level <= 4) out.price_level = p.price_level;
  if (["high", "medium", "low"].includes(p.confidence)) out.confidence = p.confidence;
  if (p.is_anchor !== undefined) out.is_anchor = !!p.is_anchor;
  if (p.near_anchor && ids.has(p.near_anchor) && p.near_anchor !== p.id) out.near_anchor = p.near_anchor;
  if (Number.isInteger(p.walk_minutes) && p.walk_minutes > 0 && p.walk_minutes <= 600) out.walk_minutes = p.walk_minutes;
  if (Number.isInteger(p.elevation_m) && p.elevation_m > 0 && p.elevation_m <= 9000) out.elevation_m = p.elevation_m;
  if (p.checkout && out.kind === "lodging") {
    let steps = p.checkout;
    if (typeof steps === "string") { try { steps = JSON.parse(steps); } catch { steps = null; } }
    if (Array.isArray(steps) && steps.length && steps.every((s) => s && typeof s.title === "string")) {
      out.checkout = steps.slice(0, 20).map((s) => ({ title: s.title.slice(0, 120), ...(s.detail ? { detail: String(s.detail).slice(0, 500) } : {}) }));
    } else said.push("checkout not a list of steps");
  }
  if (p.image_url || (Array.isArray(p.gallery) && p.gallery.length)) said.push("picture not sent");
  return { place: out, said };
}

/** One seed event as the routes take it. */
export function eventFromSeed(e) {
  const out = { id: e.id, title: e.title, starts_at: e.starts_at, tz: e.tz, kind: e.kind || "plan", source: "import" };
  for (const k of ["ends_at", "end_tz", "place_id", "detail", "url"]) if (e[k] !== undefined && e[k] !== null && e[k] !== "") out[k] = e[k];
  if (e.all_day) out.all_day = true;
  return out;
}

/**
 * Puts a seed in. `send(method, path, body)` answers { status, json } as the trip's host.
 * Answers { tripId, report }; throws, naming the step and the server's answer, on a refusal.
 */
export async function seedTrip(seed, send, { tripId } = {}) {
  const fail = (step, res) => { throw new Error(`${step}: ${res.status} ${JSON.stringify(res.json).slice(0, 1500)}`); };
  const t = seed.trip ?? {};
  // Every place is read before anything is written: a seed with a word off the list makes no trip at all.
  const codes = new Map();
  for (const p of seed.places ?? []) if (p.area && !codes.has(p.area)) codes.set(p.area, slug(p.area));
  // A place names its area by the seed's id, or by an old code (lima_miraflores) whose id is the same with hyphens.
  const areaIdOf = (code) => codes.get(code) ?? slug(code);
  const ids = new Set((seed.places ?? []).map((p) => p.id));
  const read = (seed.places ?? []).map((p) => placeFromSeed(p, { areaIdOf, ids }));
  const made = await send("POST", "/api/trips", {
    ...(tripId ?? t.id ? { id: tripId ?? t.id } : {}), name: t.name, default_tz: t.default_tz,
    ...(t.starts_on ? { starts_on: t.starts_on, ends_on: t.ends_on } : {}),
    ...(t.currencies ? { currencies: t.currencies } : {}), ...(t.interests ? { interests: t.interests } : {}),
  });
  if (made.status !== 201 && made.status !== 200) fail("making the trip", made);
  const id = made.json.trip.id;
  const at = `/api/trips/${encodeURIComponent(id)}`;
  const report = { trip: id, areas: 0, places: 0, events: 0, changed: {} };
  const count = (what) => { report.changed[what] = (report.changed[what] ?? 0) + 1; };

  // Areas: the seed's own, or one per code its places use.
  const areas = seed.areas ?? [...codes].map(([code, aid], i) => ({ id: aid, name: words(code), sort: i }));
  for (let i = 0; i < areas.length; i += ROWS_PER_WRITE_MAX) {
    const res = await send("PUT", `${at}/areas`, { areas: areas.slice(i, i + ROWS_PER_WRITE_MAX) });
    if (res.status !== 200) fail("the areas", res);
  }
  report.areas = areas.length;

  // Places that others are near go first, so a place near one finds it in the same call or
  // an earlier one.
  const named = new Set((seed.places ?? []).map((p) => p.near_anchor).filter(Boolean));
  const places = read.map(({ place, said }) => { said.forEach(count); return place; })
    .sort((a, b) => (named.has(b.id) ? 1 : 0) - (named.has(a.id) ? 1 : 0));
  for (let i = 0; i < places.length; i += ROWS_PER_WRITE_MAX) {
    const res = await send("PUT", `${at}/places`, { places: places.slice(i, i + ROWS_PER_WRITE_MAX) });
    if (res.status !== 200) fail("the places", res);
    for (const w of res.json.warnings ?? []) count("possible duplicate");
  }
  report.places = places.length;

  for (const e of seed.events ?? []) {
    const res = await send("POST", `${at}/events`, eventFromSeed(e));
    if (res.status !== 201 && res.status !== 200) fail(`the event ${e.id}`, res);
    report.events += 1;
  }

  if (seed.packing_lists) {
    const res = await send("PUT", `${at}/packing/lists`, { lists: seed.packing_lists });
    if (res.status !== 200) fail("the packing lists", res);
  }
  if (seed.packing_starters) {
    const res = await send("PUT", `${at}/packing/starters`, { starters: seed.packing_starters });
    if (res.status !== 200) fail("the packing starters", res);
  }
  return { tripId: id, report };
}

// ── run from the command line ─────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
  const session = flag("--session") ?? process.env.WGP_SESSION;
  const tripId = flag("--trip-id") ?? undefined;
  const quiet = argv.includes("--quiet");
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file || !session) {
    console.error("usage: node tools/seed-trip.mjs <seed.json> --base=<origin> --session <wgp_session value> [--trip-id <id>] [--quiet]");
    process.exit(2);
  }
  let base;
  try { base = baseUrl(); } catch (error) { console.error(`seed-trip: ${error.message}`); process.exit(2); }
  const send = async (method, path, body) => {
    const res = await fetch(new URL(path, base), {
      method, headers: { "Content-Type": "application/json", Cookie: `wgp_session=${encodeURIComponent(session)}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    const { report } = await seedTrip(JSON.parse(fs.readFileSync(file, "utf8")), send, { tripId });
    if (!quiet) console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`seed-trip: ${error.message}`);
    process.exit(1);
  }
}

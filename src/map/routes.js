// The trip's map, its routes beside GET …/tiles (src/tiles.js).
//
// POST …/tiles/cut   the host asks for the map to be made again from the trip's regions, now: an
//                    uploaded map, or one named by hand, is replaced too. Answers at once; the
//                    snapshot's tiles.state says "cutting", then "ready" or "failed".
// POST …/tiles/plan {areas}
//                    any member: what the trip's map would be cut to if its top-level areas were
//                    these, beside what they are now, written nowhere. For the app to say, before a
//                    town is added, that the map's other places would lose detail. 503 "maps off"
//                    where this site makes no maps, or where the trip's map was uploaded (an areas
//                    write doesn't cut it again).
// POST …/tiles/use {key}
//                    the host makes an archive they uploaded (POST …/media/begin with kind "map",
//                    its parts, finish: tools/map-upload.mjs does it) the trip's map. It is read
//                    first: a PMTiles archive of version 3 with vector tiles, or refused in words.
//                    It counts against the host's storage like any file; the map it replaces
//                    goes (a cut one to the drain, an uploaded one with its file row, freeing it).

import { json } from "../api/json.js";
import { err } from "../api/trip.js";
import { hostOnly } from "../trips/access.js";
import { askForMap } from "./ask.js";
import { Archive, planCut } from "./pmtiles.js";
import { dropMapSteps } from "./drop.js";
import { REV, write } from "../trips/rev.js";
import { readJson } from "../api/json.js";
import { nowSec } from "../api/trip.js";
import { MAP_BUDGET_BYTES, MAP_DEPTH_MAX, MAP_DEPTH_MIN } from "../../public/js/shared/limits.js";
import { agentOf, rangeReader, regionsOf, worldUrl } from "./cut.js";

/** How many top-level areas a plan may be asked about: a trip's regions are a handful. */
const PLAN_AREAS_MAX = 50;

/** The areas a plan was asked about, read and checked: [{ id, name, west, south, east, north }], or a refusal. */
function planAreas(raw) {
  if (!Array.isArray(raw) || !raw.length) return { error: err(400, "bad areas", { reason: "Give areas: the trip's top-level areas as they would be, each with its box (west, south, east, north)." }) };
  if (raw.length > PLAN_AREAS_MAX) return { error: err(400, "too many areas", { max: PLAN_AREAS_MAX, reason: `A plan is asked about at most ${PLAN_AREAS_MAX} top-level areas; this asks about ${raw.length}.` }) };
  const out = [];
  for (const [i, a] of raw.entries()) {
    const n = (k) => (typeof a?.[k] === "number" && Number.isFinite(a[k]) ? a[k] : NaN);
    const box = { west: n("west"), south: n("south"), east: n("east"), north: n("north") };
    const lonOk = (x) => x >= -180 && x <= 180;
    const latOk = (y) => y >= -85.06 && y <= 85.06;
    if (![box.west, box.east].every(lonOk) || ![box.south, box.north].every(latOk) || box.south >= box.north) {
      return { error: err(400, "bad box", { index: i, reason: "An area's box is west and east in -180…180, south below north in -85…85 (degrees)." }) };
    }
    const id = typeof a.id === "string" && a.id ? a.id : null;
    const name = typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 80) : (id ?? `the new area ${i + 1}`);
    out.push({ key: id ?? `new:${i}`, id, name, ...box });
  }
  return { areas: out };
}

export async function planMap({ request, env, data }) {
  const { trip } = data;
  if (!env.MAPS) return err(503, "maps off", { reason: "This site doesn't make maps (it runs without a map maker)." });
  if (trip.tiles && trip.tiles_source && trip.tiles_source !== "cut") {
    return err(503, "maps off", { reason: "This trip's map was put in by hand, so adding an area doesn't make it again." });
  }
  const asked = planAreas((await readJson(request)).areas);
  if (asked.error) return asked.error;
  if (env.MAP_PLAN_LIMITER && !(await env.MAP_PLAN_LIMITER.limit({ key: `plan:${trip.id}` })).success) {
    return json({ error: "slow down", reason: "Too many maps planned for this trip just now. Try again in a minute." }, 429, { "Retry-After": "60" });
  }
  const current = await regionsOf(env, trip.id);
  const budget = Number(env.MAP_BUDGET_BYTES) > 0 ? Number(env.MAP_BUDGET_BYTES) : MAP_BUDGET_BYTES;
  let world;
  try {
    const { fetchRange } = rangeReader(await worldUrl(env), { agent: agentOf(env) });
    world = await Archive.open(fetchRange);
  } catch (e) {
    return err(503, "world unreachable", { reason: `The map's source couldn't be read just now (${String(e?.message ?? e).slice(0, 120)}). Try again in a while.` });
  }
  // The cut's own planner, as a cut would run it: the areas as they are, and as they'd be.
  const opts = { budget, maxDepth: MAP_DEPTH_MAX, minDepth: MAP_DEPTH_MIN };
  const asRegions = (list) => list.map((a) => ({ id: a.key ?? a.id, west: a.west, south: a.south, east: a.east, north: a.north }));
  const [nowPlan, wouldPlan] = [
    current.length ? await planCut(world, asRegions(current), opts) : null,
    await planCut(world, asRegions(asked.areas), opts),
  ];
  const depthOf = (plan, key) => plan?.regions.find((r) => r.id === key)?.depth ?? null;
  const rows = [];
  for (const a of asked.areas) rows.push({ id: a.id, name: a.name, now: a.id ? depthOf(nowPlan, a.id) : null, would: depthOf(wouldPlan, a.key) });
  // An area the trip has that the plan leaves out: it would go, and has nothing to lower.
  for (const c of current) if (!asked.areas.some((a) => a.id === c.id)) rows.push({ id: c.id, name: c.name, now: depthOf(nowPlan, c.id), would: null, removed: true });
  return json({
    regions: rows,
    left_out: rows.filter((r) => !r.removed && r.would === null).map((r) => r.name),
    lowered: rows.filter((r) => !r.removed && r.now !== null && r.would !== null && r.would < r.now).map((r) => r.name),
    bytes: { now: nowPlan?.bytes ?? null, would: wouldPlan.bytes },
    max_depth: MAP_DEPTH_MAX,
  });
}

export async function cutAgain({ env, data }) {
  if (!data.host) return hostOnly();
  if (!env.MAPS) {
    return err(503, "maps off", { reason: "This site doesn't make maps (it runs without a map maker); the host can upload one instead." });
  }
  await askForMap(env, data.trip.id, { forced: true });
  return json({ ok: true, asked: true });
}

const VECTOR = 1;   // PMTiles' tile type for vector tiles (MVT)

export async function useUpload({ request, env, data }) {
  const { trip, user } = data;
  if (!data.host) return hostOnly();
  const b = await readJson(request);
  const key = typeof b.key === "string" ? b.key : "";
  const row = key ? await env.DB.prepare(
    "SELECT r2_key, bytes, state, role FROM media_objects WHERE r2_key = ?1 AND trip_id = ?2",
  ).bind(key, trip.id).first() : null;
  if (!row || row.role !== "map") return err(404, "no such map", { key, reason: "There's no map uploaded to this trip by that key: upload it first (kind \"map\"), then use its key." });
  if (row.state !== "stored") return err(409, "not finished", { key, reason: "That map's upload hasn't finished yet." });
  if (trip.tiles === key) return json({ ok: true, version: trip.tiles_version, rev: trip.rev });
  let header;
  try {
    const archive = await Archive.open(async (offset, length) => {
      const obj = await env.MEDIA.get(key, { range: { offset, length } });
      if (!obj) throw new Error("the file isn't there");
      return new Uint8Array(await obj.arrayBuffer());
    }, { untrusted: true });   // a person's own file: its root's numbers are held, not believed
    header = archive.header;
    if (!archive.root.length) throw new Error("it holds no tiles");
  } catch (e) {
    return err(400, "not a map", { key, reason: `That file isn't a map the app can use (${String(e?.message ?? e).slice(0, 120)}): a map is a PMTiles archive of version 3.` });
  }
  if (header.tileType !== VECTOR) {
    return err(400, "not a vector map", { key, reason: "That archive holds pictures of the map, not its shapes: the app draws vector tiles (a PMTiles archive of the Protomaps basemap, as the server cuts)." });
  }
  const now = nowSec();
  const version = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const { rev } = await write(env, trip.id, [
    ...dropMapSteps(env, trip.id, now),
    env.DB.prepare(
      `UPDATE trips SET tiles = ?2, tiles_state = 'ready', tiles_source = 'upload', tiles_version = ?3, tiles_bytes = ?4, tiles_at = ?5,
         tiles_glyphs = NULL, tiles_note = '', rev = ${REV(1)} WHERE id = ?1`,
    ).bind(trip.id, key, version, row.bytes, now),
  ]);
  console.log(JSON.stringify({ map_uploaded: trip.id, by: user.id, bytes: row.bytes }));
  return json({ ok: true, version, bytes: row.bytes, rev });
}

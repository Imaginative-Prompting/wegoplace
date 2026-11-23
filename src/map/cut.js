// A trip's map, cut from the world build (model §5 "Map"; docs/map-options.md, option 1).
//
// cutTrip() reads the trip's regions (its top-level areas with bounds: a neighborhood is inside its
// region), opens the world build by range, plans the archive from its directories alone (each
// region's depth, so the whole fits MAP_BUDGET_BYTES), and writes it to the TILES bucket in parts
// as the tile bytes arrive: the archive is never held whole. Then the trip's row names the new
// archive, the old one goes to the drain, and the trip's room hears a new rev.
//
// It runs in the trip's TripMap object (src/map/map-object.js), one at a time per trip, never in a
// request. A map someone uploaded, or one named by hand (the first trip's), isn't replaced by an
// areas write: only by the host asking for a cut (POST …/tiles/cut).
//
// THE WORLD: WORLD_URL when it is set (a check's stand-in on this machine, or a copy in R2 later);
// otherwise the newest of Protomaps' daily builds, looked for a week back.

import { Archive, planCut, writeCut } from "./pmtiles.js";
import { MAP_BUDGET_BYTES, MAP_DEPTH_MAX, MAP_DEPTH_MIN } from "../../public/js/shared/limits.js";
import { glyphRanges } from "./glyphs.js";
import { queueFiles } from "../trips/drain.js";
import { dropMapSteps } from "./drop.js";
import { REV, write } from "../trips/rev.js";
import { formatBytes } from "../../public/js/shared/bytes.js";
import { errorLine } from "../log.js";

const PART = 8 * 1024 * 1024;          // R2 takes parts of 5 MiB at least, but the last
const PROTOMAPS = "https://build.protomaps.com/";

/** The world build's address: WORLD_URL, or the newest daily build of the last week. */
export async function worldUrl(env, now = new Date()) {
  if (env.WORLD_URL) return env.WORLD_URL;
  for (let back = 0; back < 8; back++) {
    const d = new Date(now.getTime() - back * 86400000);
    const url = `${PROTOMAPS}${d.toISOString().slice(0, 10).replace(/-/g, "")}.pmtiles`;
    const res = await fetch(url, { method: "HEAD", headers: { "User-Agent": agentOf(env) } });
    if (res.ok) return url;
  }
  throw new Error("no daily world build of the last week could be found");
}

/**
 * Who is asking, on every read of the world build: it is someone else's free bucket, and large
 * collections refuse or slow clients that don't say who they are. The app and this site's own
 * address, as the picture fetches say it (src/trips/pictures.js); nothing about the person.
 */
export const agentOf = (env) => (env.PUBLIC_ORIGIN ? `WeGoPlace (+${env.PUBLIC_ORIGIN})` : "WeGoPlace");

/**
 * Reads of the world by range, counted. Only what was asked is ever read: a server that ignores
 * the range (a 200 with the whole file; the planet is over 100 GB) or answers another one is
 * refused before its body is read, in words, so the cut fails as "failed" with why, never by
 * running out of memory halfway with the trip left "cutting".
 */
export function rangeReader(url, { agent = "WeGoPlace" } = {}) {
  const reads = { requests: 0, bytes: 0 };
  const stopReading = async (res, why) => {
    try { await res.body?.cancel(); } catch { /* gone */ }
    throw new Error(why);
  };
  const fetchRange = async (offset, length) => {
    reads.requests += 1;
    const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}`, "User-Agent": agent } });
    if (res.status === 200) {
      // The whole file: taken only when it is no bigger than what was asked for.
      const size = Number(res.headers.get("Content-Length"));
      if (!(size >= 0 && size <= offset + length)) await stopReading(res, "the world build doesn't answer by range: it sent the whole file");
    } else if (res.status === 206) {
      const m = /^bytes (\d+)-(\d+)\//.exec(res.headers.get("Content-Range") ?? "");
      if (!m || Number(m[1]) !== offset || Number(m[2]) > offset + length - 1) {
        await stopReading(res, `the world build answered another range than the one asked (${res.headers.get("Content-Range") ?? "none"} for bytes ${offset}-${offset + length - 1})`);
      }
    } else {
      await stopReading(res, `the world build answered ${res.status}`);
    }
    const got = new Uint8Array(await res.arrayBuffer());
    reads.bytes += got.length;
    return res.status === 200 ? got.subarray(offset, offset + length) : got;
  };
  return { fetchRange, reads };
}

/** A sink writing to R2 in parts of PART bytes, holding at most one part. */
async function partsTo(bucket, key) {
  const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: "application/octet-stream" } });
  const parts = [];
  let buf = new Uint8Array(PART);
  let fill = 0;
  let total = 0;
  const flush = async () => {
    if (!fill) return;
    parts.push(await upload.uploadPart(parts.length + 1, buf.slice(0, fill)));
    fill = 0;
  };
  return {
    upload,
    async write(bytes) {
      total += bytes.length;
      let at = 0;
      while (at < bytes.length) {
        const take = Math.min(PART - fill, bytes.length - at);
        buf.set(bytes.subarray(at, at + take), fill);
        fill += take;
        at += take;
        if (fill === PART) await flush();
      }
    },
    async close() { await flush(); buf = null; return upload.complete(parts); },
    async abort() { try { await upload.abort(); } catch { /* gone */ } },
    get total() { return total; },
  };
}

/** The trip's regions: its top-level areas with bounds. */
export async function regionsOf(env, tripId) {
  return (await env.DB.prepare(
    "SELECT id, name, west, south, east, north FROM areas WHERE trip_id = ?1 AND parent IS NULL AND west IS NOT NULL ORDER BY sort, id",
  ).bind(tripId).all()).results ?? [];
}

/** Writes the map's state on the trip's row, as a write to the trip (its rev moves, its room hears). */
async function setState(env, tripId, fields) {
  const keys = Object.keys(fields);
  await write(env, tripId, [env.DB.prepare(
    `UPDATE trips SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(", ")}, rev = ${REV(1)} WHERE id = ?1`,
  ).bind(tripId, ...keys.map((k) => fields[k]))]);
}

/**
 * Cuts the trip's map. `forced`: the host asked (a map uploaded or named by hand is replaced too).
 * Answers what happened, for the object's log and the checks: { state, version?, bytes?, ... }.
 */
export async function cutTrip(env, tripId, { forced = false, now = Date.now() } = {}) {
  const trip = await env.DB.prepare("SELECT id, tiles, tiles_source, tiles_state FROM trips WHERE id = ?1").bind(tripId).first();
  if (!trip) return { state: "gone" };
  if (!forced && trip.tiles && trip.tiles_source && trip.tiles_source !== "cut") return { state: "kept", source: trip.tiles_source };
  const regions = await regionsOf(env, tripId);
  const at = Math.floor(now / 1000);
  if (!regions.length) {
    // No region with bounds: no map. A cut one the trip had goes to the drain.
    await env.DB.batch([queueFiles(env, "SELECT tiles AS r2_key, NULL AS upload_id FROM trips WHERE id = ?1 AND tiles_source = 'cut'", [tripId], at, { bucket: "tiles" })]);
    await setState(env, tripId, { tiles: null, tiles_state: "none", tiles_source: null, tiles_version: null, tiles_bytes: null, tiles_glyphs: null, tiles_at: at,
      tiles_note: "This trip has no area with bounds yet, so there's no map to make." });
    return { state: "none" };
  }
  // When the cut began, so a cut that dies unrecorded reads as failed after a while (src/map/shape.js).
  await setState(env, tripId, { tiles_state: "cutting", tiles_note: "", tiles_at: at });
  const started = Date.now();
  const budget = Number(env.MAP_BUDGET_BYTES) > 0 ? Number(env.MAP_BUDGET_BYTES) : MAP_BUDGET_BYTES;
  let sink = null;
  try {
    const { fetchRange, reads } = rangeReader(await worldUrl(env, new Date(now)), { agent: agentOf(env) });
    const world = await Archive.open(fetchRange);
    const plan = await planCut(world, regions, { budget, maxDepth: MAP_DEPTH_MAX, minDepth: MAP_DEPTH_MIN });
    if (!plan.tiles.length) throw new Error("the world build has no tiles for this trip's regions");
    const version = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const key = `trips/${tripId}/${version}.pmtiles`;
    sink = await partsTo(env.TILES, key);
    const glyphs = glyphRanges();
    // Reads of at most 4 MB at once, and one part of 8 MB waiting for R2: well inside an object's 128 MB.
    const { bytes } = await writeCut(world, plan, { write: (b) => sink.write(b) }, { onTile: glyphs.read, runMax: 4 * 1024 * 1024 });
    await sink.close();
    const leftOut = plan.leftOut.map((id) => regions.find((r) => r.id === id)?.name ?? id);
    const note = leftOut.length
      ? `${leftOut.join(", ")} ${leftOut.length === 1 ? "is" : "are"} too big for a map a phone keeps (${formatBytes(budget)}): the app draws its own ground there.`
      : "";
    const ranges = await glyphs.done();
    // The new map in, the one it replaces (a cut of ours) to the drain, in one batch.
    await write(env, tripId, [
      ...dropMapSteps(env, tripId, at),
      env.DB.prepare(
        `UPDATE trips SET tiles = ?2, tiles_state = 'ready', tiles_source = 'cut', tiles_version = ?3, tiles_bytes = ?4, tiles_at = ?5,
           tiles_glyphs = ?6, tiles_note = ?7, rev = ${REV(1)} WHERE id = ?1`,
      ).bind(tripId, key, version, bytes, at, JSON.stringify(ranges), note),
    ]);
    // The cut's own record: the ranges above U+FFFF its labels touched and the list leaves off.
    console.log(JSON.stringify({ map_cut: tripId, bytes, tiles: plan.tiles.length, glyph_ranges: ranges.length, glyph_ranges_beyond: glyphs.beyond(), glyph_ranges_drawn_locally: glyphs.local() }));
    return { state: "ready", version, key, bytes, regions: plan.regions, leftOut, requests: reads.requests, readBytes: reads.bytes, ms: Date.now() - started, glyphs: ranges, glyphsBeyond: glyphs.beyond() };
  } catch (e) {
    await sink?.abort();
    const why = String(e?.message ?? e).slice(0, 300);
    console.log(JSON.stringify({ map_cut_failed: tripId, error: errorLine(e, env) }));
    await setState(env, tripId, { tiles_state: "failed", tiles_at: at, tiles_note: `The map couldn't be made (${why}). The app draws its own ground until it can${trip.tiles ? "; the last map stays in use" : ""}.` });
    return { state: "failed", why };
  }
}

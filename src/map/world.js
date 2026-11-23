// The world build, read for real places (src/map/pois.js) by find_places and find_picture's neighbours: the same file a
// trip's map is cut from (src/map/cut.js), read a few tiles at a time.
//
// IT IS SOMEONE ELSE'S FREE BUCKET (cut.js agentOf). So:
//   * which daily build is newest is asked once a UTC day, not on every call (cut.js worldUrl asks up to 8 HEADs);
//   * every range read (the header and root, a leaf directory, a z15 tile) is kept in the Worker's cache
//     (caches.default) under the build's own name and the range, so the same tile is fetched from Protomaps once
//     per data centre per build, whoever asks; a build's bytes never change, so the cache needs no expiry rules of
//     its own beyond the day (DAY_SECONDS);
//   * every request says who is asking (agentOf).
// Where there is no cache (Node: the checks), it reads straight through.

import { Archive, decompress } from "./pmtiles.js";
import { agentOf, rangeReader, worldUrl } from "./cut.js";
import { zxyToTileId } from "./pmtiles.js";

const DAY_SECONDS = 86400;
const CACHE_HOST = "https://world-cache.wegoplace.invalid";
const cache = () => (typeof caches !== "undefined" && caches.default ? caches.default : null);
const today = (now) => new Date(now).toISOString().slice(0, 10);

/** The world build's address: WORLD_URL, or the newest daily build, asked once a UTC day. */
export async function worldOfToday(env, now = Date.now()) {
  if (env.WORLD_URL) return env.WORLD_URL;
  const c = cache();
  const key = `${CACHE_HOST}/newest/${today(now)}`;
  const hit = c ? await c.match(key) : null;
  if (hit) return hit.text();
  const url = await worldUrl(env, new Date(now));
  if (c) await c.put(key, new Response(url, { headers: { "Cache-Control": `max-age=${DAY_SECONDS}` } }));
  return url;
}

/** A fetchRange over the world build that keeps each range it reads in the Worker's cache, by build and range. */
export function cachedRange(url, { agent }) {
  const reader = rangeReader(url, { agent });
  const read = reader.fetchRange ?? reader;
  const build = encodeURIComponent(url);
  return async (offset, length) => {
    const c = cache();
    const key = `${CACHE_HOST}/range/${build}/${offset}-${length}`;
    const hit = c ? await c.match(key) : null;
    if (hit) return new Uint8Array(await hit.arrayBuffer());
    const bytes = await read(offset, length);
    if (c) await c.put(key, new Response(bytes, { headers: { "Cache-Control": `max-age=${DAY_SECONDS}`, "Content-Type": "application/octet-stream" } }));
    return bytes;
  };
}

/**
 * The world build, opened for reading tiles: { url, build (its date, from the file's name, or "stand-in"),
 * getTile(z, x, y) -> decompressed tile bytes or null, requests() (range reads asked for, the cache's answers
 * among them) }.
 */
export async function openWorld(env, now = Date.now()) {
  const url = await worldOfToday(env, now);
  let requests = 0;
  const fetchRange = cachedRange(url, { agent: agentOf(env) });
  const archive = await Archive.open(async (offset, length) => { requests += 1; return fetchRange(offset, length); });
  const getTile = async (z, x, y) => {
    const id = zxyToTileId(z, x, y);
    const e = (await archive.entriesFor([id])).get(id);
    if (!e) return null;
    return decompress(await archive.fetch(archive.header.dataOffset + e.offset, e.length), archive.header.tileCompression);
  };
  const build = /(\d{8})\.pmtiles$/.exec(url)?.[1] ?? "stand-in";
  return { url, build, getTile, requests: () => requests };
}

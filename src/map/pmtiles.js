// PMTiles version 3, read and written: the format of a trip's offline map archive and of the world
// build it is cut from (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
//
// Pure: nothing here knows about Workers, R2 or the network. Bytes come from a `fetchRange(offset,
// length)` the caller gives, and go to a `sink` the caller gives, so the same module cuts a map in
// the Worker (src/map/cut.js) and in Node (check:map, held against the official tool). Gzip goes
// through CompressionStream and DecompressionStream, which both have.
//
// An archive is: a 127-byte header; the root directory (in the first 16 KiB with the header); the
// metadata (JSON); the leaf directories; the tile data. A directory lists entries { tileId, offset,
// length, runLength }: a tile (or `runLength` tiles in a row with the same bytes), or, with
// runLength 0, a leaf directory to read for that range of ids. Tile ids run along a Hilbert curve
// within each zoom, zoom after zoom, so the tiles of a box sit close together in the file.

export const HEADER_BYTES = 127;
const ROOT_MAX = 16384 - HEADER_BYTES;
export const COMPRESSION = { unknown: 0, none: 1, gzip: 2, brotli: 3, zstd: 4 };

// ── numbers in the header and directories ──────────────────────────────────────────────────

const u64 = (v, at) => Number(v.getBigUint64(at, true));
const e7 = (v, at) => v.getInt32(at, true) / 1e7;

/** The header, from its 127 bytes. */
export function readHeader(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < HEADER_BYTES || String.fromCharCode(...b.subarray(0, 7)) !== "PMTiles") throw new Error("not a PMTiles archive");
  if (b[7] !== 3) throw new Error(`a PMTiles archive of version ${b[7]}, not 3`);
  const v = new DataView(b.buffer, b.byteOffset, HEADER_BYTES);
  return {
    rootOffset: u64(v, 8), rootLength: u64(v, 16), metadataOffset: u64(v, 24), metadataLength: u64(v, 32),
    leafOffset: u64(v, 40), leafLength: u64(v, 48), dataOffset: u64(v, 56), dataLength: u64(v, 64),
    addressedTiles: u64(v, 72), tileEntries: u64(v, 80), tileContents: u64(v, 88),
    clustered: b[96] === 1, internalCompression: b[97], tileCompression: b[98], tileType: b[99],
    minZoom: b[100], maxZoom: b[101],
    minLon: e7(v, 102), minLat: e7(v, 106), maxLon: e7(v, 110), maxLat: e7(v, 114),
    centerZoom: b[118], centerLon: e7(v, 119), centerLat: e7(v, 123),
  };
}

/** The header's 127 bytes. */
export function writeHeader(h) {
  const b = new Uint8Array(HEADER_BYTES);
  b.set([..."PMTiles"].map((c) => c.charCodeAt(0)), 0);
  b[7] = 3;
  const v = new DataView(b.buffer);
  const set64 = (at, n) => v.setBigUint64(at, BigInt(n), true);
  set64(8, h.rootOffset); set64(16, h.rootLength); set64(24, h.metadataOffset); set64(32, h.metadataLength);
  set64(40, h.leafOffset); set64(48, h.leafLength); set64(56, h.dataOffset); set64(64, h.dataLength);
  set64(72, h.addressedTiles); set64(80, h.tileEntries); set64(88, h.tileContents);
  b[96] = h.clustered ? 1 : 0; b[97] = h.internalCompression; b[98] = h.tileCompression; b[99] = h.tileType;
  b[100] = h.minZoom; b[101] = h.maxZoom;
  const set7 = (at, deg) => v.setInt32(at, Math.round(deg * 1e7), true);
  set7(102, h.minLon); set7(106, h.minLat); set7(110, h.maxLon); set7(114, h.maxLat);
  b[118] = h.centerZoom; set7(119, h.centerLon); set7(123, h.centerLat);
  return b;
}

// ── compression ─────────────────────────────────────────────────────────────────────────────

/** Bytes through a stream, stopping once the output passes `max` (a file that inflates without end). */
async function through(stream, bytes, max = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel().catch(() => {}); throw new Error(`a directory unpacks to more than ${max} bytes`); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
/** Bytes as stored with the archive's internal compression, back to plain (at most `max` bytes of them). */
export async function decompress(bytes, kind, max = Infinity) {
  if (kind === COMPRESSION.none) return bytes;
  if (kind === COMPRESSION.gzip) return through(new DecompressionStream("gzip"), bytes, max);
  throw new Error(`an archive compressed with kind ${kind}, which this reader can't open (gzip and none only)`);
}
export const gzip = (bytes) => through(new CompressionStream("gzip"), bytes);

// ── directories ─────────────────────────────────────────────────────────────────────────────

function readVarint(b, pos) {
  let v = 0, shift = 0, byte;
  do {
    if (pos.i >= b.length) throw new Error("a directory ends inside a number");
    // A number is at most ten bytes (64 bits, seven to a byte); more is a file that isn't one.
    if (shift >= 70) throw new Error("a directory holds a number longer than ten bytes");
    byte = b[pos.i++];
    v += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return v;
}
function writeVarint(out, v) {
  while (v >= 0x80) { out.push((v % 0x80) | 0x80); v = Math.floor(v / 0x80); }
  out.push(v);
}

/** A directory's entries, from its plain (decompressed) bytes. */
export function decodeDirectory(bytes) {
  const pos = { i: 0 };
  const n = readVarint(bytes, pos);
  // Each entry is four numbers of a byte at least: a count past a quarter of the bytes is a file
  // that isn't a directory, and is refused before anything is made for it.
  if (n > (bytes.length - pos.i) / 4) throw new Error(`a directory says it holds ${n} entries in ${bytes.length} bytes`);
  const entries = Array.from({ length: n }, () => ({ tileId: 0, offset: 0, length: 0, runLength: 0 }));
  let last = 0;
  for (const e of entries) { last += readVarint(bytes, pos); e.tileId = last; }
  for (const e of entries) e.runLength = readVarint(bytes, pos);
  for (const e of entries) e.length = readVarint(bytes, pos);
  for (let i = 0; i < n; i++) {
    const v = readVarint(bytes, pos);
    entries[i].offset = v === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : v - 1;
  }
  return entries;
}

/** A directory's plain bytes, from its entries (sorted by tileId). */
export function encodeDirectory(entries) {
  const out = [];
  writeVarint(out, entries.length);
  let last = 0;
  for (const e of entries) { writeVarint(out, e.tileId - last); last = e.tileId; }
  for (const e of entries) writeVarint(out, e.runLength);
  for (const e of entries) writeVarint(out, e.length);
  entries.forEach((e, i) => writeVarint(out, i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length ? 0 : e.offset + 1));
  return Uint8Array.from(out);
}

// ── tile ids ────────────────────────────────────────────────────────────────────────────────

/** The id of tile z/x/y: the tiles of every lower zoom, then its place on the Hilbert curve at z. */
export function zxyToTileId(z, x, y) {
  if (z > 26) throw new Error("zoom past 26");
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) throw new Error(`tile ${z}/${x}/${y} is outside its zoom`);
  const acc = (n * n - 1) / 3;
  let tx = x, ty = y, d = 0;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0;
    const ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { tx = s - 1 - (tx % s); ty = s - 1 - (ty % s); }
      [tx, ty] = [ty, tx];
    }
    tx %= s; ty %= s;
  }
  return acc + d;
}

/** [z, x, y] of a tile id. */
export function tileIdToZxy(id) {
  let acc = 0;
  for (let z = 0; z < 27; z++) {
    const count = 4 ** z;
    if (id < acc + count) {
      let t = id - acc, x = 0, y = 0;
      for (let s = 1; s < 2 ** z; s *= 2) {
        const rx = 1 & Math.floor(t / 2);
        const ry = 1 & (t ^ rx);
        if (ry === 0) {
          if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
          [x, y] = [y, x];
        }
        x += s * rx; y += s * ry;
        t = Math.floor(t / 4);
      }
      return [z, x, y];
    }
    acc += count;
  }
  throw new Error("a tile id past zoom 26");
}

const lonToX = (lon, n) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
const latToY = (lat, n) => {
  const r = (Math.max(-85.0511287798, Math.min(85.0511287798, lat)) * Math.PI) / 180;
  return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)));
};

/** The tiles a box covers at zoom z: { x0, x1, y0, y1 }, inclusive. */
export function tilesInBox(z, { west, south, east, north }) {
  const n = 2 ** z;
  return { x0: lonToX(west, n), x1: lonToX(east, n), y0: latToY(north, n), y1: latToY(south, n) };
}

/**
 * A box across the 180° line (west > east, as areas.js allows: Fiji's Taveuni sits on it) is two
 * boxes, one each side; any other box is itself. They are measured and cut as one region.
 */
export const boxHalves = (box) => (box.west > box.east ? [{ ...box, east: 180 }, { ...box, west: -180 }] : [box]);

/** At zoom z of a cut to `depth`: the box's columns as merged ranges, and its rows. */
function spansAt(box, depth, z) {
  const k = 2 ** (depth - z);
  const cols = boxHalves(box).map((h) => { const t = tilesInBox(depth, h); return [Math.floor(t.x0 / k), Math.floor(t.x1 / k)]; }).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of cols) { const last = merged.at(-1); if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else merged.push([a, b]); }
  const t = tilesInBox(depth, box);
  return { cols: merged, y0: Math.floor(t.y0 / k), y1: Math.floor(t.y1 / k) };
}

/**
 * The tile ids a box needs from zoom 0 to `depth`: the tiles it covers at `depth`, and every
 * parent of those (as the official tool's extract does), sorted. Each id once, also for a box
 * across the 180° line, whose two halves share their parents near the top.
 */
export function boxTileIds(box, depth) {
  const ids = [];
  for (let z = 0; z <= depth; z++) {
    const { cols, y0, y1 } = spansAt(box, depth, z);
    for (const [x0, x1] of cols) for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) ids.push(zxyToTileId(z, x, y));
  }
  return ids.sort((a, b) => a - b);
}

/** How many tiles a box needs from zoom 0 to `depth`, without listing them. */
export function boxTileCount(box, depth) {
  let n = 0;
  for (let z = 0; z <= depth; z++) {
    const { cols, y0, y1 } = spansAt(box, depth, z);
    for (const [x0, x1] of cols) n += (x1 - x0 + 1) * (y1 - y0 + 1);
  }
  return n;
}

// ── reading an archive ──────────────────────────────────────────────────────────────────────

/** The most a root directory may unpack to in a file a person uploaded: one that fits in 16 KiB packed has no reason to pass a few MiB plain. */
export const ROOT_PLAIN_MAX = 4 * 1024 * 1024;

/**
 * An archive read through `fetchRange(offset, length) -> Uint8Array`. Its header and root are read
 * once; leaf directories as they are needed, each once. `requests` counts the reads.
 */
export class Archive {
  //
  // `untrusted`: a file a person uploaded. Its root must lie in its first 16 KiB, as the format
  // says every root does (a header naming a root elsewhere could ask for any length, all of it
  // read into memory), and must unpack to at most ROOT_PLAIN_MAX. The world build is the
  // operator's (WORLD_URL or Protomaps), and its reads stay as they are.
  static async open(fetchRange, { untrusted = false } = {}) {
    const a = new Archive();
    a.requests = 0;
    a.fetch = async (offset, length) => { a.requests += 1; return fetchRange(offset, length); };
    const first = await a.fetch(0, 16384);
    a.header = readHeader(first);
    const h = a.header;
    const inFirst = h.rootOffset + h.rootLength <= first.length;
    if (untrusted && !inFirst) throw new Error("its root directory isn't in its first 16 KiB, where every version-3 archive keeps it");
    const root = inFirst ? first.subarray(h.rootOffset, h.rootOffset + h.rootLength) : await a.fetch(h.rootOffset, h.rootLength);
    a.root = decodeDirectory(await decompress(root, h.internalCompression, untrusted ? ROOT_PLAIN_MAX : Infinity));
    a.leaves = new Map();
    return a;
  }

  async metadata() {
    const h = this.header;
    if (!h.metadataLength) return new Uint8Array(0);
    return decompress(await this.fetch(h.metadataOffset, h.metadataLength), h.internalCompression);
  }

  async leaf(entry) {
    let got = this.leaves.get(entry.offset);
    if (!got) {
      const h = this.header;
      got = decodeDirectory(await decompress(await this.fetch(h.leafOffset + entry.offset, entry.length), h.internalCompression));
      this.leaves.set(entry.offset, got);
    }
    return got;
  }

  /**
   * The tile entries for a sorted list of ids: Map id -> { offset, length } (offset into the tile
   * data), for the ids the archive has. Leaves are read in parallel, a few at a time.
   */
  async entriesFor(ids) {
    const found = new Map();
    let level = [{ dir: this.root, ids }];
    while (level.length) {
      const next = [];
      const needs = new Map();
      for (const { dir, ids: want } of level) {
        let j = 0;
        for (const id of want) {
          while (j + 1 < dir.length && dir[j + 1].tileId <= id) j += 1;
          const e = dir[j];
          if (!e || id < e.tileId) continue;
          if (e.runLength === 0) {
            (needs.get(e.offset) ?? needs.set(e.offset, { entry: e, ids: [] }).get(e.offset)).ids.push(id);
          } else if (id < e.tileId + e.runLength) {
            found.set(id, { offset: e.offset, length: e.length });
          }
        }
      }
      const wanted = [...needs.values()];
      for (let i = 0; i < wanted.length; i += 8) {
        const batch = wanted.slice(i, i + 8);
        const dirs = await Promise.all(batch.map((w) => this.leaf(w.entry)));
        batch.forEach((w, k) => next.push({ dir: dirs[k], ids: w.ids }));
      }
      level = next;
    }
    return found;
  }

  /** Every tile entry the archive addresses, runs spread out: [{ id, offset, length }], by id. */
  async allTiles() {
    const out = [];
    const walk = async (dir) => {
      for (const e of dir) {
        if (e.runLength === 0) await walk(await this.leaf(e));
        else for (let k = 0; k < e.runLength; k++) out.push({ id: e.tileId + k, offset: e.offset, length: e.length });
      }
    };
    await walk(this.root);
    return out.sort((a, b) => a.id - b.id);
  }

  /** One tile's stored bytes (as the archive keeps them: gzip for vector tiles), or null. */
  async tile(z, x, y) {
    const id = zxyToTileId(z, x, y);
    const e = (await this.entriesFor([id])).get(id);
    return e ? this.fetch(this.header.dataOffset + e.offset, e.length) : null;
  }
}

// ── cutting ─────────────────────────────────────────────────────────────────────────────────

/**
 * What a trip's archive will hold, worked out from the source's directories before any tile's
 * bytes are fetched: each region's depth, the tiles, and the size.
 *
 *   regions  [{ id, west, south, east, north }]   the trip's top-level areas with bounds
 *   budget   the most the archive may be, in bytes
 *
 * Each region starts at `maxDepth` (15, or the source's deepest); while the whole is over the
 * budget, the region costing most drops a level. A region that would go below `minDepth` (10) is
 * left out (its tiles are none of the archive's), and named in `leftOut`. A region whose tiles at
 * a depth would be more than `tileCap` to list starts lower.
 */
export async function planCut(archive, regions, { budget, maxDepth = 15, minDepth = 10, tileCap = 300000 } = {}) {
  const h = archive.header;
  const top = Math.min(maxDepth, h.maxZoom);
  const state = regions.map((r) => {
    let depth = top;
    while (depth > 0 && boxTileCount(r, depth) > tileCap) depth -= 1;
    return { region: r, depth, ids: null, bytes: 0 };
  });
  const known = new Map();                                     // id -> entry, read once across levels
  const measure = async (s) => {
    s.ids = boxTileIds(s.region, s.depth);
    const missing = s.ids.filter((id) => !known.has(id));
    const got = await archive.entriesFor(missing);
    for (const id of missing) known.set(id, got.get(id) ?? null);
    s.bytes = 0;
    const seen = new Set();
    for (const id of s.ids) { const e = known.get(id); if (e && !seen.has(e.offset)) { seen.add(e.offset); s.bytes += e.length; } }
  };
  for (const s of state) await measure(s);
  const total = () => {
    const seen = new Set();
    let n = 0;
    for (const s of state) if (!s.leftOut) for (const id of s.ids) { const e = known.get(id); if (e && !seen.has(e.offset)) { seen.add(e.offset); n += e.length; } }
    return n;
  };
  while (total() > budget) {
    const biggest = state.filter((s) => !s.leftOut).sort((a, b) => b.bytes - a.bytes)[0];
    if (!biggest) break;
    if (biggest.depth - 1 < minDepth) { biggest.leftOut = true; continue; }
    biggest.depth -= 1;
    await measure(biggest);
  }
  // The archive's tiles: every id any region (not left out) needs that the source has.
  const ids = [...new Set(state.filter((s) => !s.leftOut).flatMap((s) => s.ids))].sort((a, b) => a - b);
  const tiles = ids.map((id) => ({ id, ...known.get(id) })).filter((t) => t.length !== undefined && t.offset !== undefined);
  const kept = state.filter((s) => !s.leftOut);
  // The archive's bounds, for its header: one box can't say two sides of the 180° line, so a cut
  // holding a region across it says the whole width (its tiles are only the regions' own).
  const crosses = kept.some((s) => s.region.west > s.region.east);
  const bounds = kept.length ? {
    west: crosses ? -180 : Math.min(...kept.map((s) => s.region.west)), south: Math.min(...kept.map((s) => s.region.south)),
    east: crosses ? 180 : Math.max(...kept.map((s) => s.region.east)), north: Math.max(...kept.map((s) => s.region.north)),
  } : null;
  return {
    tiles, bounds,
    regions: state.map((s) => ({ id: s.region.id, depth: s.leftOut ? null : s.depth, bytes: s.bytes, tiles: s.ids.length })),
    leftOut: state.filter((s) => s.leftOut).map((s) => s.region.id),
    bytes: total(),
  };
}

/** The directory layout for an archive's tiles: root (and leaves when the root doesn't fit), as stored bytes. */
async function directories(entries, compress) {
  const root = await compress(encodeDirectory(entries));
  if (root.length <= ROOT_MAX) return { root, leaves: new Uint8Array(0) };
  for (let size = 4096; ; size *= 2) {
    const leafParts = [];
    const rootEntries = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += size) {
      const part = await compress(encodeDirectory(entries.slice(i, i + size)));
      rootEntries.push({ tileId: entries[i].tileId, offset, length: part.length, runLength: 0 });
      leafParts.push(part);
      offset += part.length;
    }
    const r = await compress(encodeDirectory(rootEntries));
    if (r.length <= ROOT_MAX) {
      const leaves = new Uint8Array(offset);
      let at = 0;
      for (const p of leafParts) { leaves.set(p, at); at += p.length; }
      return { root: r, leaves };
    }
  }
}

/**
 * Writes the archive a plan describes to `sink.write(bytes)` (in order, awaited), fetching the
 * tiles' bytes from the source in runs (neighbors in the source closer than `gap` are one read).
 * Nothing is held whole: the header and directories first (their layout is known from the plan),
 * then the tile data as it arrives. `onTile(bytes)` sees each tile's stored bytes on the way (the
 * label fonts' ranges are read so). Answers the header written and how many bytes.
 */
export async function writeCut(archive, plan, sink, { gap = 256 * 1024, runMax = 8 * 1024 * 1024, onTile = null } = {}) {
  const src = archive.header;
  // The output's contents: each source content once, at its first id; entries collapse runs of
  // ids in a row that share one content.
  const placed = new Map();                       // source offset -> { offset, length } in the new data
  const contents = [];                            // in the new data's order: { srcOffset, length }
  let dataLength = 0;
  const entries = [];
  for (const t of plan.tiles) {
    let at = placed.get(t.offset);
    if (!at) {
      at = { offset: dataLength, length: t.length };
      placed.set(t.offset, at);
      contents.push({ srcOffset: t.offset, length: t.length });
      dataLength += t.length;
    }
    const last = entries.at(-1);
    if (last && last.offset === at.offset && last.tileId + last.runLength === t.id) last.runLength += 1;
    else entries.push({ tileId: t.id, offset: at.offset, length: at.length, runLength: 1 });
  }
  const compress = src.internalCompression === COMPRESSION.gzip ? gzip : async (b) => b;
  const { root, leaves } = await directories(entries, compress);
  const metadata = await compress(await archive.metadata());
  // The zooms the cut holds, in one pass: spreading them into Math.min/max runs out of stack past
  // about 125,000 tiles (measured in Node 24), and a region may hold up to its tile cap.
  let minZoom = Infinity, maxZoom = -Infinity;
  for (const t of plan.tiles) { const z = tileIdToZxy(t.id)[0]; if (z < minZoom) minZoom = z; if (z > maxZoom) maxZoom = z; }
  if (!plan.tiles.length) minZoom = maxZoom = 0;
  const b = plan.bounds ?? { west: src.minLon, south: src.minLat, east: src.maxLon, north: src.maxLat };
  const header = {
    rootOffset: HEADER_BYTES, rootLength: root.length,
    metadataOffset: HEADER_BYTES + root.length, metadataLength: metadata.length,
    leafOffset: HEADER_BYTES + root.length + metadata.length, leafLength: leaves.length,
    dataOffset: HEADER_BYTES + root.length + metadata.length + leaves.length, dataLength,
    addressedTiles: plan.tiles.length, tileEntries: entries.length, tileContents: contents.length,
    clustered: true, internalCompression: src.internalCompression, tileCompression: src.tileCompression, tileType: src.tileType,
    minZoom, maxZoom,
    minLon: b.west, minLat: b.south, maxLon: b.east, maxLat: b.north,
    centerZoom: minZoom, centerLon: (b.west + b.east) / 2, centerLat: (b.south + b.north) / 2,
  };
  await sink.write(writeHeader(header));
  await sink.write(root);
  await sink.write(metadata);
  if (leaves.length) await sink.write(leaves);
  // The tile data, in runs read from the source: contents next to each other there are one read.
  let i = 0;
  while (i < contents.length) {
    let j = i;
    let end = contents[i].srcOffset + contents[i].length;
    while (j + 1 < contents.length) {
      const c = contents[j + 1];
      if (c.srcOffset < end || c.srcOffset - end > gap || c.srcOffset + c.length - contents[i].srcOffset > runMax) break;
      j += 1;
      end = c.srcOffset + c.length;
    }
    const from = contents[i].srcOffset;
    const run = await archive.fetch(src.dataOffset + from, end - from);
    for (let k = i; k <= j; k++) {
      const bytes = run.subarray(contents[k].srcOffset - from, contents[k].srcOffset - from + contents[k].length);
      if (onTile) await onTile(bytes);
      await sink.write(bytes);
    }
    i = j + 1;
  }
  return { header, bytes: header.dataOffset + dataLength };
}

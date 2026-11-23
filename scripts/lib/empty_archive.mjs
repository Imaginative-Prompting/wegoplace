// A PMTiles archive for checks that need the trip to HAVE a map without needing a map drawn.
import { Buffer } from "node:buffer";

// A valid PMTiles v3 archive that holds no tiles: a header, a directory of no entries, empty
// metadata. Enough for the reader to open it and for the map to switch its ground to tiles.
// `fill` pads it, so two archives differ in size as well as in their tag.
export function emptyArchive(fill = 0) {
  const root = Buffer.from([0]);
  const meta = Buffer.from("{}");
  const h = Buffer.alloc(127);
  h.write("PMTiles", 0, "latin1"); h[7] = 3;
  const u64 = (at, v) => h.writeBigUInt64LE(BigInt(v), at);
  u64(8, 127); u64(16, root.length);                        // root directory
  u64(24, 127 + root.length); u64(32, meta.length);         // metadata
  u64(40, 0); u64(48, 0);                                   // leaf directories
  u64(56, 127 + root.length + meta.length); u64(64, 0);     // tile data
  u64(72, 0); u64(80, 0); u64(88, 0);                       // addressed tiles, entries, contents
  h[96] = 1; h[97] = 1; h[98] = 1; h[99] = 1;               // clustered; no compression; vector tiles
  h[100] = 0; h[101] = 14;                                  // zooms
  h.writeInt32LE(-1800000000, 102); h.writeInt32LE(-850000000, 106);
  h.writeInt32LE(1800000000, 110); h.writeInt32LE(850000000, 114);
  h[118] = 0; h.writeInt32LE(0, 119); h.writeInt32LE(0, 123);
  return Buffer.concat([h, root, meta, Buffer.alloc(fill)]);
}

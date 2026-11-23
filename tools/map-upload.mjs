#!/usr/bin/env node
// Uploads a map you cut yourself as a trip's map (docs/map-options.md, option 4): for a site that
// doesn't cut maps (a copy on the free Workers plan), or a map of your own (a hiking map, a bigger
// area than the server's budget). You must host the trip. The map counts against your storage.
//
//   WGP_SESSION=<your wgp_session cookie> node tools/map-upload.mjs <map.pmtiles> --trip <id> --base <origin>
//
// The file is checked here first (a PMTiles archive of version 3 with vector tiles, as the app
// draws), then sent as any file is (POST …/media/begin with kind "map", its parts, finish), then
// made the trip's map (POST …/tiles/use). Your session comes from the environment only: it is
// never an argument, a file or a line of output.
//
// Cutting one yourself: the official tool, `pmtiles extract https://build.protomaps.com/<date>.pmtiles
// out.pmtiles --bbox=<west,south,east,north> --maxzoom=<z>` (https://docs.protomaps.com/pmtiles/cli).

import fs from "node:fs";
import { asHost } from "./cutover-send.mjs";
import { readHeader } from "../src/map/pmtiles.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const trip = flag("--trip");
const base = flag("--base");
const file = argv[0];
const session = process.env.WGP_SESSION;
if (!file || !trip || !base) { console.error("usage: WGP_SESSION=… node tools/map-upload.mjs <map.pmtiles> --trip <id> --base <origin>"); process.exit(2); }
if (!session) { console.error("refused: your session comes from WGP_SESSION in the environment, and it isn't set."); process.exit(2); }

const size = fs.statSync(file).size;
const fd = fs.openSync(file, "r");
const head = Buffer.alloc(127);
fs.readSync(fd, head, 0, 127, 0);
let header;
try { header = readHeader(head); } catch (e) { console.error(`refused: ${file} isn't a map the app can use (${e.message}).`); process.exit(2); }
if (header.tileType !== 1) { console.error("refused: that archive holds pictures of the map, not vector tiles; the app draws vector tiles."); process.exit(2); }

const send = asHost(base, session);
const at = `/api/trips/${encodeURIComponent(trip)}`;
const begun = await send("POST", `${at}/media/begin`, { name: file.split("/").pop(), mime: "application/vnd.pmtiles", bytes: size, kind: "map" });
if (begun.status !== 201) { console.error(`refused (${begun.status}): ${begun.json?.reason ?? JSON.stringify(begun.json)}`); process.exit(1); }
const { key, uploadId, part_size: partSize, parts: count } = begun.json;
const parts = [];
for (let n = 1; n <= count; n++) {
  const len = Math.min(partSize, size - (n - 1) * partSize);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, (n - 1) * partSize);
  const res = await send("PUT", `${at}/media/part?key=${encodeURIComponent(key)}&id=${encodeURIComponent(uploadId)}&n=${n}`, buf, { raw: true });
  if (res.status !== 200) { console.error(`part ${n} refused (${res.status}): ${res.json?.reason ?? res.json?.error}`); process.exit(1); }
  parts.push({ n, etag: res.json.etag });
  process.stdout.write(`\r${n} of ${count} parts`);
}
fs.closeSync(fd);
process.stdout.write("\n");
const done = await send("POST", `${at}/media/finish`, { key, id: uploadId, parts });
if (done.status !== 200) { console.error(`finishing refused (${done.status}): ${done.json?.reason ?? done.json?.error}`); process.exit(1); }
const used = await send("POST", `${at}/tiles/use`, { key });
if (used.status !== 200) { console.error(`refused as the trip's map (${used.status}): ${used.json?.reason ?? used.json?.error}`); process.exit(1); }
console.log(`the trip's map now: ${(size / 1e6).toFixed(1)} MB, version ${used.json.version}`);

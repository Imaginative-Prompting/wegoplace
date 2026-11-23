# check:map

```
npm run check:map -- --world <a .pmtiles archive> --pmtiles <the official pmtiles tool>
```

It never reaches the network: the world build is stood in by an archive on this machine, served by
range from a small local server (`world.mjs`), and the official tool reads the same address. Without
both it can't run, and says so (exit 2).

- **The official tool:** the `pmtiles` command-line program, from its releases page:
  https://github.com/protomaps/go-pmtiles/releases (one binary per system; this check was written
  against 1.31.2). `pmtiles extract`, `pmtiles tile` and `pmtiles verify` are what it runs.
- **A world to stand in:** any PMTiles archive of the Protomaps basemap (vector tiles). Cut a small
  one from the daily build with the same tool, once, where you have a network:
  `pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles world.pmtiles --bbox=<west,south,east,north> --maxzoom=14`
  (a city takes a few MB; https://docs.protomaps.com/basemaps/downloads lists the builds).
  Cut it with `--region=<name>-region.geojson` (a GeoJSON of the boxes) instead of `--bbox`, and keep
  that file beside the archive (`world.pmtiles`, `world-region.geojson`): part 2 then cuts those
  boxes again and holds the result to the archive, tile for tile. Or pass `--regions <file>` (that
  GeoJSON, or a list of `{ id, west, south, east, north }`). Without either, part 2 is skipped,
  saying so, and the parts after it use the made-up trip's regions (`seed/demo-trip.json`), which
  sit inside the stand-in this check was written against.
- Its own servers on 8791 and 8795 (`--port` moves both).

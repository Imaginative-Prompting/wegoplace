// The world build, stood in on this machine for check:map: any PMTiles archive on disk, served by
// range from a small local server, so a cut reads it exactly as it reads Protomaps' daily build in
// production, and the official tool reads the same address. Never the network.

import fs from "node:fs";
import http from "node:http";

/**
 * Serves `file` at http://127.0.0.1:<port>/world.pmtiles with HTTP ranges. Answers { url, stop,
 * served }. Two more addresses misbehave, for the checks: /whole/world.pmtiles ignores the range
 * (a 200 with the whole file, as a server without ranges does), and /shifted/world.pmtiles answers
 * a range a byte later than the one asked.
 */
export async function serveWorld(file, port = 0) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  const served = { requests: 0, bytes: 0, agents: new Set() };
  const server = http.createServer((req, res) => {
    const how = { "/world.pmtiles": "ranges", "/whole/world.pmtiles": "whole", "/shifted/world.pmtiles": "shifted" }[req.url];
    if (!how) { res.writeHead(404); res.end(); return; }
    served.requests += 1;
    served.agents.add(req.headers["user-agent"] ?? "");
    const m = how === "whole" ? null : /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) + (how === "shifted" ? 1 : 0) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
    const buf = Buffer.alloc(end - start + 1);
    fs.readSync(fd, buf, 0, buf.length, start);
    served.bytes += buf.length;
    res.writeHead(m ? 206 : 200, { "Content-Length": buf.length, "Accept-Ranges": "bytes", ...(m ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}), ETag: `"${size}"` });
    if (req.method === "HEAD") res.end(); else res.end(buf);
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/world.pmtiles`;
  return { url, served, size, stop: () => new Promise((r) => { server.close(r); fs.closeSync(fd); }) };
}

/** A fetchRange over HTTP ranges, as the Worker's cut uses one. */
export const httpRange = (url) => async (offset, length) => {
  const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`the world answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

/** A fetchRange over a file on disk. */
export const fileRange = (file) => {
  const fd = fs.openSync(file, "r");
  const size = fs.statSync(file).size;
  return async (offset, length) => {
    const n = Math.max(0, Math.min(length, size - offset));
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, offset);
    return new Uint8Array(buf);
  };
};

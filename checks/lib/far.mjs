// Far sites, stood in for. A picture fetched by its address (src/trips/pictures.js) never
// reaches the network from a check: every server a check starts sends those fetches here, on
// this machine (PICTURE_FETCH_VIA, honoured only on loopback), naming the address it was asked
// for in X-Fetch-For; this answers as that far site would. The rules on an address (https, its
// port, no credentials, no private name, at most three redirects) are the server's, applied to
// the asked address before anything is sent here, so a check holds the rules themselves.
//
// What it knows (anything else is a 404):
//   https://pics.example/harbour.png      an 800 x 600 PNG
//   https://pics.example/big.png          a 1000 x 1000 PNG of noise, about 1 MB (over the bytes)
//   https://pics.example/wide.png         1700 x 100 (over the pixels)
//   https://pics.example/drawing.svg      an SVG
//   https://pics.example/once             a redirect to harbour.png
//   https://pics.example/hop1 … hop4      four redirects, then harbour.png (one too many)
//   https://pics.example/to-private       a redirect to https://router.local/x
//   https://pics.example/slow             never answers
//   https://upload.wikimedia.org/wikipedia/commons/a/ab/Big.png   3000 x 2000; its sized copies
//     …/thumb/a/ab/Big.png/<w>px-Big.png answer w x (w * 2/3), at a standard width (960, 1280)
//     only, as Wikimedia now does: 1600 or 1024 is a 400
//   https://images.example/<anything>    a 1280 x 853 PNG (the guides' own examples' address)
//   https://upload.wikimedia.org/wikipedia/commons/c/cd/Small.png 1200 x 800; as Wikimedia does,
//     a sized copy wider than the original is refused (a 400), narrower ones are served
// Every fetch's User-Agent is kept beside the address it asked for (heard).

import http from "node:http";
import { SVG, png } from "./images.mjs";

const BIG = png(1000, 1000, { noise: true });
const GUIDE_PICTURE = png(1280, 853);
// The sized-copy widths Wikimedia serves, of those a picture's limit allows (measured 14 Nov 2026).
const STANDARD_WIDTHS = [960, 1280];
const FILES = {
  "https://pics.example/harbour.png": png(800, 600),
  "https://pics.example/big.png": BIG,
  "https://pics.example/wide.png": png(1700, 100),
  "https://pics.example/drawing.svg": SVG,
  "https://upload.wikimedia.org/wikipedia/commons/a/ab/Big.png": png(3000, 2000),
  "https://upload.wikimedia.org/wikipedia/commons/c/cd/Small.png": png(1200, 800),
};
const REDIRECTS = {
  "https://pics.example/once": "/harbour.png",
  "https://pics.example/hop1": "/hop2",
  "https://pics.example/hop2": "/hop3",
  "https://pics.example/hop3": "/hop4",
  "https://pics.example/hop4": "/harbour.png",
  "https://pics.example/to-private": "https://router.local/x",
};

export function startFar() {
  const asked = [];
  const heard = [];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const at = String(req.headers["x-fetch-for"] || "");
      asked.push(at);
      heard.push({ at, agent: String(req.headers["user-agent"] || "") });
      if (at === "https://pics.example/slow") return;              // never answers
      if (REDIRECTS[at]) { res.writeHead(302, { Location: REDIRECTS[at] }); res.end(); return; }
      const sized = at.match(/^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/thumb\/(?:a\/ab\/Big|c\/cd\/Small)\.png\/(\d+)px-(Big|Small)\.png$/);
      const original = sized && (sized[2] === "Big" ? 3000 : 1200);
      if (sized && Number(sized[1]) > original) { res.writeHead(400, { "Content-Type": "text/plain" }); res.end("Error: thumbnail wider than the original"); return; }
      // As Wikimedia does now: a sized copy only at a standard width (1600 and 1024 refused).
      if (sized && !STANDARD_WIDTHS.includes(Number(sized[1]))) { res.writeHead(400, { "Content-Type": "text/html" }); res.end("Use a standard thumbnail size"); return; }
      const body = sized ? png(Number(sized[1]), Math.round((Number(sized[1]) * 2) / 3)) : at.startsWith("https://images.example/") ? GUIDE_PICTURE : FILES[at];
      if (!body) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("the far site's own words, which must never be shown"); return; }
      res.writeHead(200, { "Content-Type": at.endsWith(".svg") ? "image/svg+xml" : "image/png", "Content-Length": body.length });
      res.end(body);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, asked, heard, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

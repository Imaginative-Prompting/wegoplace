// A server in front of the app's that can take a request and never answer it (one bar in a valley, a
// server that took the connection and stalled), the way sw_limits_check's does, for checks that hold
// the API itself.
//
//   const px = await holdProxy(upstream, { rewrite });
//   px.origin                       this server's own address (http://localhost:<port>)
//   px.hold(match)                  hold every request match({ method, path, body }) says yes to:
//                                   it is read to its end and never answered; its connection stays
//                                   open until the browser closes it
//   px.held                         every request held: { method, path, body, at, ended, closed }
//                                   (at: it began; ended: its body was all in; closed: the browser
//                                   closed its connection; all ms since the epoch, 0 if not yet)
//   px.applyLate(h)                 sends a held request on to the app's server as it was sent (the
//                                   write the browser gave up on, applied after all); answers its
//                                   status and JSON
//   px.release()                    holds nothing more, and closes what is still held
//   px.seen                         every request passed through or held: { method, path, at }
//   px.close()
//
// rewrite(path, text) may change a JavaScript file on its way to the browser (a planted change),
// returning the text to serve; it is asked only for .js answers.
import http from "node:http";
import net from "node:net";

export async function holdProxy(upstream, { rewrite = null } = {}) {
  const up = new URL(upstream);
  let ORIGIN = "";
  // The app takes a request whose Origin isn't its own address as another site's, so on the way
  // through it is made to look as the browser would send it to the app directly.
  const inward = (h, plain = false) => {
    const o = { ...h, host: up.host };
    if (plain) delete o["accept-encoding"];
    if (o.origin === ORIGIN) o.origin = up.origin;
    if (o.referer && o.referer.startsWith(ORIGIN)) o.referer = up.origin + o.referer.slice(ORIGIN.length);
    return o;
  };
  const outward = (h) => (h.location && h.location.startsWith(up.origin) ? { ...h, location: ORIGIN + h.location.slice(up.origin.length) } : h);
  const matches = [];
  const held = [];
  const seen = [];
  const send = (method, path, headers, body) => new Promise((resolve) => {
    const out = http.request({ host: up.hostname, port: up.port, method, path, headers: inward(headers, true) }, (r) => {
      const parts = [];
      r.on("data", (c) => parts.push(c));
      r.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: r.statusCode, json });
      });
    });
    out.on("error", (e) => resolve({ status: 0, json: null, error: String(e.message) }));
    out.end(body);
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const parts = [];
    const at = Date.now();
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const body = Buffer.concat(parts);
      const asked = { method: req.method, path: u.pathname, search: u.search, body: body.toString("utf8") };
      seen.push({ method: req.method, path: u.pathname, at });
      if (matches.some((m) => m(asked))) {
        const h = { ...asked, url: req.url, headers: req.headers, raw: body, at, ended: Date.now(), closed: 0, socket: req.socket };
        held.push(h);
        if (req.socket.destroyed) h.closed = Date.now();
        else req.socket.once("close", () => { h.closed = Date.now(); });
        return;                                   // read it all, answer nothing
      }
      const js = rewrite && /\.js$/.test(u.pathname) && req.method === "GET";
      const out = http.request({ host: up.hostname, port: up.port, method: req.method, path: req.url, headers: inward(req.headers, js) }, (r) => {
        if (!js || r.statusCode !== 200) { res.writeHead(r.statusCode, outward(r.headers)); r.pipe(res); return; }
        const got = [];
        r.on("data", (c) => got.push(c));
        r.on("end", () => {
          const text = rewrite(u.pathname, Buffer.concat(got).toString("utf8"));
          const headers = { ...r.headers, "content-length": String(Buffer.byteLength(text)) };
          delete headers["content-encoding"]; delete headers["transfer-encoding"];
          res.writeHead(r.statusCode, headers); res.end(text);
        });
      });
      out.on("error", () => { try { res.writeHead(502); res.end(); } catch { /* gone */ } });
      out.end(body);
    });
  });
  // The app's live updates: a WebSocket, passed through as bytes.
  server.on("upgrade", (req, sock, head) => {
    const o = net.connect(Number(up.port), up.hostname, () => {
      o.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(inward(req.headers)).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head.length) o.write(head);
      sock.pipe(o); o.pipe(sock);
    });
    o.on("error", () => sock.destroy()); sock.on("error", () => o.destroy());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  ORIGIN = `http://localhost:${server.address().port}`;
  return {
    origin: ORIGIN,
    held, seen,
    hold(match) { matches.push(match); },
    applyLate: (h) => send(h.method, h.url, h.headers, h.raw),
    release() { matches.length = 0; for (const h of held) if (!h.closed) h.socket.destroy(); },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

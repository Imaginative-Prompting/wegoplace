// What the parity recorder is made of: a raw HTTP client, a software passkey, the normalizer
// that turns a response into something two runs can be compared on, and the comparison.
//
// Plain Node, no browser and no dependencies. See README.md beside this file.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── HTTP ────────────────────────────────────────────────────────────────────────────────
// node:http rather than fetch(): the request path goes on the wire exactly as written
// (fetch would resolve "..", lower-case nothing, and refuse some headers), every response
// header arrives untouched, and a redirect is an answer to record, never something to follow.

/** One request. timeoutMs: how long it may take before it is given up (a minute, unless the caller knows better). */
export function request(origin, { method = "GET", path: reqPath = "/", headers = {}, body = null, timeoutMs = 60000 }) {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    const h = { Host: u.host, ...headers };
    if (body != null && h["Content-Length"] === undefined) h["Content-Length"] = Buffer.byteLength(body);
    const req = http.request({
      host: "127.0.0.1", port: u.port, method, path: reqPath, headers: h, agent: false,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const pairs = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2)
          pairs.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]]);
        resolve({ status: res.statusCode, headers: pairs, body: Buffer.concat(chunks) });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout: ${method} ${reqPath}`)));
    if (body != null) req.write(body);
    req.end();
  });
}

// ── A cookie jar, one per person ────────────────────────────────────────────────────────
// Name and value only. The app's cookies are all Path=/ and Secure; a jar that honoured
// Secure would never send them over http://localhost, which a real browser does (localhost
// is a secure context).

export class Jar {
  constructor() { this.cookies = new Map(); }
  take(headers) {
    for (const [name, value] of headers) {
      if (name !== "set-cookie") continue;
      const first = value.split(";")[0];
      const eq = first.indexOf("=");
      if (eq < 0) continue;
      const k = first.slice(0, eq).trim();
      const v = first.slice(eq + 1).trim();
      const gone = /;\s*Max-Age=0\b/i.test(value) || v === "";
      if (gone) this.cookies.delete(k); else this.cookies.set(k, v);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

// ── The sign-in cookie from before sessions were rows (src/accounts/old-cookie.js) ───────
// s2=<userId>.<exp>.<hmac-sha256-hex(AUTH_SECRET, "<userId>.<exp>")>

export function hmacHex(secret, msg) {
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}
export function sessionValue(secret, userId, expSec) {
  return `${userId}.${expSec}.${hmacHex(secret, `${userId}.${expSec}`)}`;
}

// ── A software passkey ──────────────────────────────────────────────────────────────────
// What navigator.credentials.create()/get() hand to public/js/auth.js, built by hand: an
// ES256 key, attestation "none". The keys below are test fixtures made for this file; they
// open nothing anywhere.

const b64u = (buf) => Buffer.from(buf).toString("base64url");

export const TEST_KEYS = {
  carol: { kty: "EC", crv: "P-256", x: "V8NsuQSx4UzlFk50s5DlSqBC7lw1jICAmLxFIO3W6hs", y: "VyUQMvDGKfPjN0QlDMm4mbPoa_z_ZlTZ6_1YDGY7cT8", d: "wYe2L3u_4syoPURrk42IuvsRvLFpf4QU5ITvXvQuYCs" },
  carol2: { kty: "EC", crv: "P-256", x: "TgKIOYbhorJ42ZQ45KDsNu6piwwEc3M9T6qPaNIqeu4", y: "Vj-x3YptnxJycAEOT4-tgch8QuvHkTmFrjUJVugx1rU", d: "WfAZk1a5jtK5BOImn1ZkU5xonrMMw-KisGX10lnmHko" },
};

// The little of CBOR an attestation object needs: unsigned and negative ints, byte strings,
// text strings, maps.
function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
export function cbor(v) {
  if (typeof v === "number") return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([cborHead(2, v.length), Buffer.from(v)]);
  if (typeof v === "string") { const s = Buffer.from(v, "utf8"); return Buffer.concat([cborHead(3, s.length), s]); }
  if (v instanceof Map) {
    const parts = [cborHead(5, v.size)];
    for (const [k, x] of v) parts.push(cbor(k), cbor(x));
    return Buffer.concat(parts);
  }
  throw new Error("cbor: unsupported value");
}

export class Passkey {
  /**
   * @param {string|object} name a key of TEST_KEYS, or a P-256 private key as a JWK
   * @param {string} credId any bytes, as text
   */
  constructor(name, credId) {
    this.jwk = typeof name === "string" ? TEST_KEYS[name] : name;
    this.key = crypto.createPrivateKey({ key: this.jwk, format: "jwk" });
    this.credId = Buffer.from(credId, "utf8");
    this.id = b64u(this.credId);
    this.counter = 0;
    // The account the device keeps with the passkey (set from the creation options' user.id),
    // sent back at sign-in as a discoverable passkey does. Null: the device keeps none.
    this.userHandle = null;
    // Flag bits on top of "present" and "verified": 0x08 can be backed up, 0x10 is backed up.
    this.extraFlags = 0;
  }
  /** A passkey with a key made now, for a check that needs more people than TEST_KEYS has. */
  static fresh(credId) {
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    return new Passkey(privateKey.export({ format: "jwk" }), credId);
  }
  coseKey() {
    return cbor(new Map([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(this.jwk.x, "base64url")], [-3, Buffer.from(this.jwk.y, "base64url")],
    ]));
  }
  authData(rpId, { attested }) {
    const rpIdHash = crypto.createHash("sha256").update(rpId).digest();
    const flags = Buffer.from([0x01 | 0x04 | this.extraFlags | (attested ? 0x40 : 0)]);   // present, verified, (attested)
    const count = Buffer.alloc(4); count.writeUInt32BE(this.counter);
    if (!attested) return Buffer.concat([rpIdHash, flags, count]);
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
    return Buffer.concat([rpIdHash, flags, count, Buffer.alloc(16), len, this.credId, this.coseKey()]);
  }
  /** What navigator.credentials.create() answers, serialized as auth.js sends it. */
  create({ challenge, origin, rpId }) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
    const attestationObject = cbor(new Map([
      ["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData(rpId, { attested: true })],
    ]));
    return {
      id: this.id, rawId: this.id, type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject) },
    };
  }
  /** What navigator.credentials.get() answers. */
  get({ challenge, origin, rpId }) {
    this.counter += 1;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
    const authenticatorData = this.authData(rpId, { attested: false });
    const signed = Buffer.concat([authenticatorData, crypto.createHash("sha256").update(clientDataJSON).digest()]);
    const signature = crypto.sign("sha256", signed, { key: this.key, dsaEncoding: "der" });
    return {
      id: this.id, rawId: this.id, type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData),
        signature: b64u(signature), userHandle: this.userHandle,
      },
    };
  }
}

// ── Every static file, by the hash of its bytes ─────────────────────────────────────────
// A body that is byte for byte a file in public/ is recorded as that file's name, never as
// its bytes or their hash, so the recording survives the client lane editing the file.

export function publicFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name !== ".DS_Store") out.push(p);
    }
  };
  walk(dir);
  return out.map((p) => path.relative(dir, p).split(path.sep).join("/"));
}
export function hashIndex(dir) {
  const index = new Map();
  for (const rel of publicFiles(dir)) {
    const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, rel))).digest("hex");
    if (!index.has(sha)) index.set(sha, `public/${rel}`);
  }
  return index;
}

// ── The normalizer ──────────────────────────────────────────────────────────────────────
// Two runs of one server never answer byte for byte the same: challenges are random, ids are
// minted, rows are stamped with the clock. Each of those is replaced by a name, and nothing
// else is. `counts` says how many of each were replaced, so a recording shows how much it
// leaned on this.

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** How much of a body is kept in the recording as text; a larger one is kept as its hash. */
const INLINE_MAX = 16 * 1024;

export class Normalizer {
  constructor({ startSec, files }) {
    this.startSec = startSec;
    this.files = files;                // sha256 -> "public/<path>"
    this.learned = [];                 // [literal, name], longest literal first
    this.counts = { now: 0, learned: 0, etag: 0, date: 0, token: 0, file: 0 };
    this.client = new Set();           // every whole number a request has sent in a JSON body
  }

  /**
   * A request's JSON body: its whole numbers are the scenario's own, never the clock's, wherever
   * they come back. The scenario sends fixed times (the demo trip's 2027 events sit on quarter
   * hours), and one of those can fall on "the run's clock plus whole days": a run that started
   * at the same time of day as a demo event recorded it as <now+201d> (14 Nov), about one run in
   * ten with sixty events and a two-minute run.
   */
  sent(v) {
    if (typeof v === "number") { if (Number.isInteger(v)) this.client.add(v); return; }
    if (Array.isArray(v)) { for (const x of v) this.sent(x); return; }
    if (v && typeof v === "object") for (const x of Object.values(v)) this.sent(x);
  }

  /** From here on, every occurrence of `literal` reads `<name>`. */
  learn(name, literal) {
    if (typeof literal !== "string" || literal.length < 6)
      throw new Error(`learn(${name}): a value this short would be replaced where it doesn't belong: ${JSON.stringify(literal)}`);
    if (this.learned.some(([l]) => l === literal)) return;
    this.learned.push([literal, `<${name}>`]);
    // The same value as the scenario sends it back: percent-encoded in a query, or upper-cased
    // to show a route ignores case. Each form keeps its own placeholder so the request still
    // says which form was sent.
    for (const [form, tag] of [[encodeURIComponent(literal), "encoded"], [literal.toUpperCase(), "upper"]])
      if (form !== literal && !this.learned.some(([l]) => l === form)) this.learned.push([form, `<${name}:${tag}>`]);
    this.learned.sort((a, b) => b[0].length - a[0].length);
  }

  text(s) {
    let out = s;
    for (const [literal, name] of this.learned) {
      if (!out.includes(literal)) continue;
      this.counts.learned += out.split(literal).length - 1;
      out = out.split(literal).join(name);
    }
    return out;
  }

  /** Seconds on the clock during this run, give or take: the only numbers treated as "now". */
  isNow(n, offset = 0) {
    const now = Math.floor(Date.now() / 1000);
    return Number.isInteger(n) && n >= this.startSec + offset - 5 && n <= now + offset + 5;
  }

  json(v) {
    if (typeof v === "string") return this.text(v);
    if (typeof v === "number") {
      if (this.client.has(v)) return v;
      if (this.isNow(v)) { this.counts.now++; return "<now>"; }
      // The clock plus a whole number of days: when a join link runs out. The days are what
      // the server chose, so they are kept.
      const days = Math.round((v - this.startSec) / 86400);
      if (days >= 1 && days <= 400 && this.isNow(v, days * 86400)) { this.counts.now++; return `<now+${days}d>`; }
      // The clock plus 15 minutes: when a picture's upload link runs out (PICTURE_LINK_SECONDS).
      if (this.isNow(v, 15 * 60)) { this.counts.now++; return "<now+15m>"; }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => this.json(x));
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[this.text(k)] = this.json(x);
      return o;
    }
    return v;
  }

  /**
   * One Set-Cookie value. Each of the app's cookies holds a random value the server made (a
   * session's token, or the id of a challenge that is waiting): recorded as <token>, with its
   * attributes as sent. A cookie being cleared (an empty value) is recorded as sent, and so is
   * anything else.
   *
   * `wgp_who` is the one that isn't random: it is the signed-in account's id, so it is recorded
   * through the learned names (`<alice>`), which is the point of it. Its life is the session's:
   * a full 180 days when a session starts or moves forward, and otherwise what is left of the
   * session it was sent again for, which depends on the second the run reached it
   * (`<rest of the session>`).
   */
  setCookie(value) {
    const m = /^(wgp_[a-z_]+)=([^;]+)(;.*)?$/.exec(value);
    if (!m) return this.text(value);
    if (m[1] === "wgp_who") {
      const attrs = (m[3] ?? "").replace(/Max-Age=(\d+)/, (all, n) => (n === "0" || n === "15552000" ? all : "Max-Age=<rest of the session>"));
      return `${m[1]}=${this.text(decodeURIComponent(m[2]))}${attrs}`;
    }
    this.counts.token++;
    return `${m[1]}=<token>${m[3] ?? ""}`;
  }

  headers(pairs, { staticAsset, fileLength = false }) {
    const out = [];
    for (const [name, value] of pairs) {
      if (name === "date") { this.counts.date++; continue; }
      // The length of a file from public/ changes whenever the file does; that there is one is
      // what's recorded.
      if (name === "content-length" && fileLength) { out.push([name, "<length>"]); continue; }
      // Hop-by-hop, set by the local dev server's own HTTP layer and not by the app.
      if (name === "connection" || name === "keep-alive") continue;
      // Whether the file server had this file in its own cache yet: it differs run to run.
      if (name === "cf-cache-status") continue;
      if (name === "set-cookie") { out.push([name, this.setCookie(value)]); continue; }
      if (name === "etag" && staticAsset) {
        // A static file's ETag is a hash the host computes its own way; whether there is one,
        // and whether it is weak, is what's recorded. The run checks that a request carrying
        // it back gets a 304.
        this.counts.etag++;
        out.push([name, /^W\//.test(value) ? 'W/"<etag>"' : '"<etag>"']);
        continue;
      }
      if (name === "last-modified") {
        const t = Date.parse(value);
        if (Number.isFinite(t) && this.isNow(Math.floor(t / 1000))) { this.counts.date++; out.push([name, "<now>"]); continue; }
      }
      // A download's name carries the UTC day it was made (src/accounts/export.js): a day this run
      // was on reads <today>, so a recording compares on any later day.
      if (name === "content-disposition") {
        const named = value.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => {
          const day = Date.parse(`${d}T00:00:00Z`) / 1000;
          if (!Number.isFinite(day) || !(day + 86400 > this.startSec - 5 && day <= Math.floor(Date.now() / 1000) + 5)) return d;
          this.counts.date++;
          return "<today>";
        });
        out.push([name, this.text(named)]);
        continue;
      }
      out.push([name, this.text(value)]);
    }
    out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    return out.map(([k, v]) => `${k}: ${v}`);
  }

  body(buf, contentType) {
    if (!buf.length) return { empty: true };
    const file = this.files.get(sha256(buf));
    if (file) { this.counts.file++; return { file }; }
    const type = String(contentType || "").toLowerCase();
    if (type.includes("json")) {
      let parsed;
      try { parsed = JSON.parse(buf.toString("utf8")); } catch { parsed = undefined; }
      if (parsed !== undefined) {
        const norm = this.json(parsed);
        const text = JSON.stringify(norm);
        if (text.length <= INLINE_MAX) return { json: norm };
        const outline = norm && typeof norm === "object" && !Array.isArray(norm)
          ? Object.fromEntries(Object.entries(norm).map(([k, x]) => [k, Array.isArray(x) ? `array(${x.length})` : typeof x]))
          : Array.isArray(norm) ? `array(${norm.length})` : typeof norm;
        return { json_sha256: sha256(Buffer.from(text)), chars: text.length, outline };
      }
    }
    if (/^text\/|json|javascript|xml|svg/.test(type) || !type) {
      const text = this.text(buf.toString("utf8"));
      if (!/�/.test(text)) {
        if (text.length <= INLINE_MAX) return { text };
        return { text_sha256: sha256(Buffer.from(text)), chars: text.length };
      }
    }
    return { bytes_sha256: sha256(buf), bytes: buf.length };
  }

  /** How many bytes longer the body is for the server's own address than for "<origin>" where it appears: the address
   * is as long as its port, and the body is recorded with "<origin>" in its place, so its length is counted the same way
   * (else a recording made on a five-digit port fails on a four-digit one, by one byte a time). */
  originBytes(buf) {
    if (!buf.length) return 0;
    const text = buf.toString("utf8");
    let n = 0;
    for (const [literal, name] of this.learned) {
      if (!name.startsWith("<origin") || !text.includes(literal)) continue;
      n += (text.split(literal).length - 1) * (Buffer.byteLength(literal) - Buffer.byteLength(name));
    }
    return n;
  }

  response(res, opts = {}) {
    const type = (res.headers.find(([k]) => k === "content-type") || [])[1];
    const body = this.body(res.body, type);
    const less = body.file ? 0 : this.originBytes(res.body);
    const pairs = less ? res.headers.map(([k, v]) => (k === "content-length" && /^\d+$/.test(v) ? [k, String(Number(v) - less)] : [k, v])) : res.headers;
    return {
      status: res.status,
      // A body that is a file from public/ is a static file whether or not the step said so.
      headers: this.headers(pairs, { staticAsset: !!opts.staticAsset || !!body.file, fileLength: !!body.file }),
      body,
    };
  }
}

// ── Comparing two recordings ────────────────────────────────────────────────────────────

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Every difference between two recordings, as lines of text. `allow` is the list of
 * differences that are understood and written down: each is { id, why, match(step, kind,
 * a, b) }, and `used` (returned) counts how often each one applied, so an allowance that no
 * longer matches anything shows up as unused.
 */
export function compare(golden, live, { allow = [], skipped = new Set() } = {}) {
  const lines = [];
  const used = new Map(allow.map((a) => [a.id, 0]));
  const liveBy = new Map(live.steps.map((s) => [s.name, s]));
  const goldenNames = new Set(golden.steps.map((s) => s.name));
  let compared = 0;
  for (const g of golden.steps) {
    if (skipped.has(g.name)) continue;
    const l = liveBy.get(g.name);
    if (!l) { lines.push(`MISSING  ${g.name}: recorded, not run`); continue; }
    compared++;
    const allowed = (kind, a, b) => {
      for (const rule of allow) {
        if (rule.match(g, kind, a, b)) { used.set(rule.id, used.get(rule.id) + 1); return true; }
      }
      return false;
    };
    if (!same(g.request, l.request)) lines.push(`REQUEST  ${g.name}: the two runs didn't send the same thing\n    was ${JSON.stringify(g.request)}\n    now ${JSON.stringify(l.request)}`);
    const a = g.response, b = l.response;
    if (a.status !== b.status && !allowed("status", a.status, b.status))
      lines.push(`STATUS   ${g.name} [${g.request.method} ${g.request.path}]: was ${a.status}, now ${b.status}`);
    const ha = new Set(a.headers), hb = new Set(b.headers);
    for (const h of a.headers) if (!hb.has(h) && !allowed("header-", h, null))
      lines.push(`HEADER-  ${g.name} [${g.request.method} ${g.request.path}]: lost "${h}"`);
    for (const h of b.headers) if (!ha.has(h) && !allowed("header+", null, h))
      lines.push(`HEADER+  ${g.name} [${g.request.method} ${g.request.path}]: gained "${h}"`);
    if (!same(a.body, b.body) && !allowed("body", a.body, b.body)) {
      const cut = (x) => { const s = JSON.stringify(x); return s.length > 700 ? s.slice(0, 700) + "…" : s; };
      lines.push(`BODY     ${g.name} [${g.request.method} ${g.request.path}]:\n    was ${cut(a.body)}\n    now ${cut(b.body)}`);
    }
  }
  for (const l of live.steps) if (!goldenNames.has(l.name)) lines.push(`EXTRA    ${l.name}: run, not in the recording`);
  return { lines, compared, used };
}

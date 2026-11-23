// A trip's chat, told to people's phones (Web Push: src/push/), on a server of its own:
//
//   node checks/push/run.mjs [--port <port>]
//
// It holds:
//   1. the encryption, to RFC 8291's own worked example (Appendix A's inputs give Section 5's message,
//      byte for byte), and a message with fresh keys a browser opens; the VAPID header (RFC 8292):
//      its audience the push service's origin, a day at most, signed by the site's key;
//   2. a browser's subscription kept for its account: only a push service's address, the keys'
//      lengths, signed in;
//   3. a new message tells everyone else on the trip, through a stand-in push service on this
//      machine (the checks' servers allow its origin, PUSH_TEST_ORIGIN): what each phone opens says
//      who wrote and in which trip; the words only on a phone that asked; never the author, a member
//      who muted the trip's chat, or one who left; a message sent again tells no one twice; an ended
//      subscription (410) goes; a deleted subscription hears nothing; a deleted account's go;
//   4. a site without keys: "push off", and the chat works as ever.
// Everyone in it is made up.

import http from "node:http";
import { CheckError, startServer, freePort } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { b64url, encrypt, fromB64url, vapidHeader } from "../../src/push/webpush.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? await freePort());
const t = new Report("a trip's chat, told to people's phones");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const te = new TextEncoder();
const td = new TextDecoder();
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), data));
const hkdf = async (salt, ikm, info, n) => (await hmac(await hmac(salt, ikm), cat(info, new Uint8Array([1])))).slice(0, n);

/** The browser's side of RFC 8291, only to open what the server sends. */
async function open(body, uaPrivate, uaPublic, auth) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const pub = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, uaPrivate, 256));
  const ikm = await hkdf(auth, shared, cat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)));
  return td.decode(plain.slice(0, plain.lastIndexOf(2)));
}
/** A browser's subscription keys: a P-256 pair and 16 random bytes. */
async function phoneKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, pub, auth, keys: { p256dh: b64url(pub), auth: b64url(auth) } };
}

// ── 1. the encryption and the signature ──────────────────────────────────────────────────────
t.part("1. RFC 8291 and RFC 8292");
{
  const join = (s) => s.replace(/\s+/g, "");
  const RFC = {   // RFC 8291, Appendix A (and Section 5's result)
    plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
    asPublic: join("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
    asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    uaPublic: join("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
    salt: "DGv6ra1nlYgDCS1FRnbzlw",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
    header: join("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8"),
    ciphertext: join("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ"),
  };
  const asPub = fromB64url(RFC.asPublic);
  const body = await encrypt({ p256dh: RFC.uaPublic, auth: RFC.auth }, fromB64url(RFC.plaintext), {
    asPrivate: { kty: "EC", crv: "P-256", d: RFC.asPrivate, x: b64url(asPub.slice(1, 33)), y: b64url(asPub.slice(33, 65)), ext: true },
    asPublic: asPub, salt: fromB64url(RFC.salt),
  });
  t.same("RFC 8291's worked example: the same header and ciphertext, byte for byte", [b64url(body.slice(0, 86)), b64url(body.slice(86))], [RFC.header, RFC.ciphertext]);
  const phone = await phoneKeys();
  const a = await encrypt(phone.keys, te.encode("Hello"));
  const b = await encrypt(phone.keys, te.encode("Hello"));
  t.same("with fresh keys, a browser opens it, and two sends never look alike", [await open(a, phone.pair.privateKey, phone.pub, phone.auth), b64url(a) === b64url(b)], ["Hello", false]);
  const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const { kty, crv, d, x, y } = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);
  const vapidPublic = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", vapidPair.publicKey)));
  const now = Date.parse("2026-11-15T12:00:00Z");
  const h = await vapidHeader("https://fcm.googleapis.com/fcm/send/abc", { publicKey: vapidPublic, privateJwk: { kty, crv, d, x, y }, subject: "https://wegoplace.example" }, now);
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h) ?? [];
  const [head, claims, sig] = (jwt ?? "").split(".");
  const okSig = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, vapidPair.publicKey, fromB64url(sig), te.encode(`${head}.${claims}`));
  const c = JSON.parse(td.decode(fromB64url(claims)));
  t.same("the VAPID header: signed by the site's key, its audience the push service's origin, no more than a day ahead, its subject the site, the public key beside it",
    [okSig, c.aud, c.exp - now / 1000 <= 86400 && c.exp > now / 1000, c.sub, k], [true, "https://fcm.googleapis.com", true, "https://wegoplace.example", vapidPublic]);
}

// ── the stand-in push service ─────────────────────────────────────────────────────────────────
const got = [];
const standin = http.createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    got.push({ path: req.url, headers: req.headers, body: new Uint8Array(Buffer.concat(parts)) });
    res.writeHead(req.url.startsWith("/gone/") ? 410 : 201);
    res.end();
  });
});
await new Promise((r) => standin.listen(0, "127.0.0.1", r));
const STANDIN = `http://127.0.0.1:${standin.address().port}`;

let server, bare, code = 1;
try {
  const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);
  const VAPID_PUBLIC = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", vapidPair.publicKey)));
  server = await startServer({ name: "push", port, vars: { PUSH_TEST_ORIGIN: STANDIN },
    secrets: { VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y }) } });
  await server.start();
  const { origin } = server;
  const sql = (q) => server.sql(q);

  t.part("2. A browser's subscription");
  const people = Object.fromEntries(["Ada Reyes", "Ben Okafor", "Cleo Tran", "Dee Marsh", "Eli Stone", "Fay Lund"].map((n) => [n.split(" ")[0].toLowerCase(), new Person(origin, n)]));
  for (const p of Object.values(people)) if ((await p.signUp()).status !== 200) throw new CheckError(`couldn't make ${p.name}`);
  const { ada, ben, cleo, dee, eli, fay } = people;
  const signedOut = await fetch(new URL("/api/account/push", origin), { headers: { Accept: "application/json" } });
  const key = await ada.get("/api/account/push");
  t.same("the site's push key, to a person signed in (signed out: refused)", [signedOut.status, key.status, key.json?.key], [401, 200, VAPID_PUBLIC]);
  const phones = {};
  for (const name of Object.keys(people)) phones[name] = await phoneKeys();
  const endpoint = (name, gone = false) => `${STANDIN}/${gone ? "gone" : "ok"}/${name}`;
  t.same("only a push service's address is taken, and keys of the right lengths",
    [(await ben.call("PUT", "/api/account/push", { endpoint: "https://evil.example/push", keys: phones.ben.keys })).status,
      (await ben.call("PUT", "/api/account/push", { endpoint: endpoint("ben"), keys: { p256dh: phones.ben.keys.p256dh.slice(4), auth: phones.ben.keys.auth } })).status],
    [400, 400]);
  const subscribe = (p, name, words, gone = false) => p.call("PUT", "/api/account/push", { endpoint: endpoint(name, gone), keys: phones[name].keys, words });
  const answers = [await subscribe(ada, "ada", false), await subscribe(ben, "ben", false), await subscribe(cleo, "cleo", true),
    await subscribe(dee, "dee", true), await subscribe(eli, "eli", false), await subscribe(fay, "fay", false, true)];
  t.same("six phones say yes; Cleo's asks for the words", answers.map((a) => [a.status, a.json?.words]), [[200, false], [200, false], [200, true], [200, true], [200, false], [200, false]]);
  t.same("  (kept once each, for its account)", sql("SELECT COUNT(*) AS n FROM push_subscriptions")[0].n, 6);

  t.part("3. A new message, told");
  const made = await ada.post("/api/trips", { name: "Coast week", default_tz: "UTC" });
  const trip = made.json.trip.id;
  for (const p of [ben, cleo, dee, eli, fay]) await p.post(`/api/join/${(await ada.post(`/api/trips/${trip}/links`, { uses: 1 })).json.link.code}`);
  const muted = await dee.call("PUT", `/api/trips/${trip}/chat/mute`, { muted: true });
  const left = await eli.call("DELETE", `/api/trips/${trip}/members/${encodeURIComponent(eli.user.id)}`);
  t.same("  (Dee mutes the trip's chat; Eli leaves the trip)", [muted.status, left.status], [200, 200]);
  const before = got.length;
  const sent = await ada.post(`/api/trips/${trip}/messages`, { id: "m-1", body: "Bring cash, the boat takes no cards" });
  for (let i = 0; i < 50 && got.length - before < 3; i++) await sleep(100);
  await sleep(400);
  const arrived = got.slice(before);
  const to = (name) => arrived.filter((g) => g.path === `/ok/${name}` || g.path === `/gone/${name}`);
  t.same("Ada's message reaches Ben, Cleo and Fay's phones, once each; never Ada's own, Dee's (muted) or Eli's (left)",
    [sent.status, ["ada", "ben", "cleo", "dee", "eli", "fay"].map((n) => to(n).length)], [201, [0, 1, 1, 0, 0, 1]]);
  const opened = async (name) => JSON.parse(await open(to(name)[0].body, phones[name].pair.privateKey, phones[name].pub, phones[name].auth));
  const benSaw = await opened("ben");
  const cleoSaw = await opened("cleo");
  t.same("Ben's phone (no words): who wrote, and in which trip; the link opens the trip's chat; one per trip",
    [benSaw.notification.title, benSaw.notification.body, benSaw.notification.navigate, benSaw.wgp.tag, benSaw.wgp.mute],
    ["Ada Reyes wrote in Coast week", "Open the chat to read it.", `${origin}/t/${trip}/#/chat`, `chat:${trip}`, `/api/trips/${trip}/chat/mute`]);
  t.same("Cleo's phone (words on): what was said", cleoSaw.notification.body, "Bring cash, the boat takes no cards");
  const h = to("ben")[0].headers;
  const [, jwt] = /^vapid t=([^,]+), k=/.exec(h.authorization ?? "") ?? [];
  const [head, claims, sig] = (jwt ?? "..").split(".");
  const okSig = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, vapidPair.publicKey, fromB64url(sig || "AA"), te.encode(`${head}.${claims}`));
  t.same("sent as RFC 8030 asks: aes128gcm, a TTL, an urgency, a topic, signed by the site's key for the service's origin",
    [h["content-encoding"], Number(h.ttl) > 0, h.urgency, !!h.topic, okSig, JSON.parse(td.decode(fromB64url(claims || "e30"))).aud], ["aes128gcm", true, "normal", true, true, STANDIN]);
  t.same("Fay's push service says her subscription has ended (410): it goes", sql(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = '${fay.user.id}'`)[0].n, 0);
  const again = got.length;
  const resent = await ada.post(`/api/trips/${trip}/messages`, { id: "m-1", body: "Bring cash, the boat takes no cards" });
  await sleep(1200);
  t.same("the same message sent again (a phone's queue replaying it) tells no one twice", [resent.status, got.length - again], [200, 0]);
  const off = await ben.call("DELETE", "/api/account/push", { endpoint: endpoint("ben") });
  const after = got.length;
  await cleo.post(`/api/trips/${trip}/messages`, { id: "m-2", body: "I'll get the tickets" });
  for (let i = 0; i < 30 && got.length - after < 1; i++) await sleep(100);
  await sleep(400);
  const second = got.slice(after);
  t.same("Ben turns it off on his phone (DELETE): Cleo's message reaches Ada, not Ben, not Cleo herself",
    [off.json?.deleted, second.map((g) => g.path).sort()], [1, ["/ok/ada"]]);
  const gone = await cleo.call("DELETE", "/api/me", { confirm: "delete" });
  t.same("a deleted account's phones go with it", [gone.status, sql(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = '${cleo.user.id}'`)[0].n], [200, 0]);

  t.part("4. A site without push keys");
  bare = await startServer({ name: "push-bare", port: port + 2 });
  await bare.start();
  const zed = new Person(bare.origin, "Zed Ames");
  await zed.signUp();
  const zt = (await zed.post("/api/trips", { name: "Quiet trip", default_tz: "UTC" })).json.trip.id;
  const keyless = await zed.get("/api/account/push");
  const msg = await zed.post(`/api/trips/${zt}/messages`, { id: "m-1", body: "Hello" });
  t.same("\"push off\" in words, and the chat works as ever", [keyless.status, keyless.json?.error, !!keyless.json?.reason, msg.status], [503, "push off", true, 201]);
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  standin.close();
  await server?.stop();
  await bare?.stop();
}
process.exit(code);

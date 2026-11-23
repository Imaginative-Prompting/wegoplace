// The browser's side of accounts, public/js/auth.js, run here against the server: the same
// module the sign-in page and the account page load, with a made-up browser around it (its own
// cookies, and a device that makes and uses passkeys the way navigator.credentials does, in the
// browser's own shapes: buffers in, buffers out). So what the script sends is what the server
// reads, and each refusal reaches a person as the words meant for it.
//
// No page is drawn here; a browser check does that.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../lib/server.mjs";
import { Person, newPasskey } from "../lib/person.mjs";

const b64 = (bytes) => Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength).toString("base64url");
const buf = (text) => { const b = Buffer.from(text, "base64url"); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const refusal = (name) => Object.assign(new Error(`the device refused (${name})`), { name });

/** A device: the passkeys it holds, and what it answers the browser with. */
class Device {
  constructor(origin) { this.origin = origin; this.passkeys = []; }
  /** A credential as the browser hands it to a page. */
  credential(json, transports) {
    const r = json.response;
    const response = { clientDataJSON: buf(r.clientDataJSON) };
    if (r.attestationObject) { response.attestationObject = buf(r.attestationObject); response.getTransports = () => transports; }
    if (r.authenticatorData) {
      response.authenticatorData = buf(r.authenticatorData);
      response.signature = buf(r.signature);
      response.userHandle = r.userHandle ? buf(r.userHandle) : null;
    }
    return { id: json.id, rawId: buf(json.rawId), type: "public-key", authenticatorAttachment: "platform", response, getClientExtensionResults: () => ({}) };
  }
  async create({ publicKey }) {
    // A device won't make a second passkey for an account it already holds one for.
    const held = (publicKey.excludeCredentials ?? []).some((c) => this.passkeys.some((p) => p.id === b64(c.id)));
    if (held) throw refusal("InvalidStateError");
    const passkey = newPasskey();
    passkey.userHandle = b64(publicKey.user.id);
    const made = passkey.create({ challenge: b64(publicKey.challenge), origin: this.origin, rpId: publicKey.rp.id });
    this.passkeys.push(passkey);
    return this.credential(made, ["internal"]);
  }
  async get({ publicKey }) {
    const allowed = publicKey.allowCredentials ?? [];
    const passkey = allowed.length ? this.passkeys.find((p) => allowed.some((c) => b64(c.id) === p.id)) : this.passkeys[0];
    // No passkey for this site, or the prompt closed: the browser says the same for both.
    if (!passkey) throw refusal("NotAllowedError");
    return this.credential(passkey.get({ challenge: b64(publicKey.challenge), origin: this.origin, rpId: publicKey.rpId }));
  }
}

export async function client({ server, report: t }) {
  const { origin } = server;

  // The made-up browser. `now` is whoever is using it: their cookies, their device.
  let now = null;
  const use = (person, device) => { now = { person, device }; };
  const before = { fetch: globalThis.fetch, window: Object.getOwnPropertyDescriptor(globalThis, "window"), navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"), location: Object.getOwnPropertyDescriptor(globalThis, "location") };
  const set = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const page = { hostname: "localhost", origin, search: "", hash: "" };
  set("window", { isSecureContext: true, PublicKeyCredential: class {} });
  set("navigator", {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) check",
    credentials: { create: (o) => now.device.create(o), get: (o) => now.device.get(o) },
  });
  set("location", page);
  set("fetch", async (address, init = {}) => {
    const res = await now.person.call(init.method ?? "GET", address, init.body ?? null, { headers: init.headers ?? {} });
    // As much of a Response as the page's own code reads (public/js/net.js fetchWithin rebuilds one from it: its
    // status, its headers and its bytes).
    return { status: res.status, statusText: "", headers: new Headers(res.headers.filter(([k]) => k !== "set-cookie")),
      json: async () => JSON.parse(res.text), text: async () => res.text, arrayBuffer: async () => new TextEncoder().encode(res.text).buffer };
  });

  try {
    const auth = await import(pathToFileURL(path.join(ROOT, "public/js/auth.js")));
    /** The AuthError code a flow ends in, or "no error". */
    const codeOf = async (flow) => { try { await flow(); return "no error"; } catch (e) { return e instanceof auth.AuthError ? e.code : `not an AuthError: ${e?.message ?? e}`; } };
    const messageOf = async (flow) => { try { await flow(); return ""; } catch (e) { return e?.message ?? ""; } };

    t.part("The sign-in script, run against the server");
    const kai = new Person(origin, "Kai Check");
    const phone = new Device(origin);
    use(kai, phone);
    t.same("it finds passkeys usable here", auth.support(), { ok: true });
    const site = await auth.siteConfig();
    t.same("it reads what the site offers", [site.signups, site.providers, site.email], ["open", { google: true, github: true }, true]);
    t.same("signed out, me() is null", await auth.me(), null);

    const made = await auth.register({ name: "  Kai   Check " });
    t.same("register() makes an account with a passkey from the device, the name tidied", [made?.name, phone.passkeys.length, kai.signedIn], ["Kai Check", 1, true]);
    const who = await auth.me();
    t.same("me() is that account", [who?.id, who?.name], [made.id, "Kai Check"]);
    t.same("the passkey the server kept is the device's, spelled the same", server.sql(`SELECT id FROM passkeys WHERE user_id = '${made.id}'`).map((r) => r.id), [phone.passkeys[0].id]);

    await auth.signOut();
    t.same("signOut() ends it", [kai.signedIn, await auth.me()], [false, null]);

    // Another browser on the same device (the passkey lives with the device, not the cookies).
    const again = new Person(origin, "Kai Check");
    use(again, phone);
    const back = await auth.signIn();
    t.same("signIn() with no username signs the same account in", [back?.id, again.signedIn], [made.id, true]);
    await auth.signOut();
    await auth.primeSignIn();
    const primed = await auth.signIn();
    t.same("and so does a sign-in whose challenge was fetched ahead of the tap", [primed?.id, again.signedIn], [made.id, true]);
    t.same("the passkey's counter went up with each use", server.sql(`SELECT counter FROM passkeys WHERE user_id = '${made.id}'`)[0].counter, 2);

    t.same("addPasskey() on a device that already has one says so, in words",
      [await codeOf(() => auth.addPasskey()), await messageOf(() => auth.addPasskey())], ["already-registered", "This device already has a passkey for your account."]);
    const laptop = new Device(origin);
    use(again, laptop);
    await auth.addPasskey();
    t.same("addPasskey() on another device adds it", server.sql(`SELECT COUNT(*) AS n FROM passkeys WHERE user_id = '${made.id}'`)[0].n, 2);
    const third = new Person(origin, "Kai Check");
    use(third, laptop);
    t.same("and that device signs in with it", (await auth.signIn())?.id, made.id);

    t.part("The sign-in script: each refusal in words");
    const stranger = new Person(origin, "Stranger");
    const empty = new Device(origin);
    use(stranger, empty);
    t.same("a device with no passkey for this site: no passkey was used", await codeOf(() => auth.signIn()), "cancelled");
    const other = new Device(origin);
    other.passkeys.push(newPasskey());
    use(stranger, other);
    t.same("a passkey this site has never seen: no account, with what to do", [await codeOf(() => auth.signIn()), /create an account/i.test(await messageOf(() => auth.signIn()))], ["no-account", true]);
    t.same("a username nobody signed up with", await codeOf(() => auth.signIn({ username: "nobody-by-this-name" })), "no-account");
    t.same("a name that isn't one", await codeOf(() => auth.register({ name: "   " })), "name");
    t.same("and one that's too long", await codeOf(() => auth.register({ name: "x".repeat(41) })), "name");
    t.same("nothing was made by any of those", [stranger.signedIn, server.sql("SELECT COUNT(*) AS n FROM users WHERE name IN ('Stranger', '')")[0].n], [false, 0]);
    t.same("signed out, a signed-in route says this browser isn't signed in", await codeOf(() => auth.signOutEverywhere()), "signed-out");
    t.same("and so does adding a passkey", await codeOf(() => auth.addPasskey()), "signed-out");
    const left = auth.serverError({ error: "wrong code", left: 2 }, 400);
    const last = auth.serverError({ error: "wrong code", left: 1 }, 400);
    t.same("a wrong code says how many tries are left", [left.code, left.message, last.message], ["wrong-code", "That isn't the code. 2 tries left.", "That isn't the code. One try left."]);
    const unknown = auth.serverError({ error: "something new" }, 500);
    t.same("an answer it has no words for still says something, and keeps the server's word for the detail", [unknown.code, unknown.detail], ["server", "something new · HTTP 500"]);

    t.part("The sign-in script: where it goes afterwards");
    const next = (search) => { page.search = search; return auth.nextPath(); };
    t.same("a path on this site is kept; anything else is the app",
      [next(""), next("?next=%2Faccount"), next("?next=%2F%3Ftab%3Dplan"), next("?next=%2F%2Fother.example"), next("?next=https%3A%2F%2Fother.example%2F"), next("?next=%2F%5Cother.example"), next("?next=account")],
      ["/", "/account", "/?tab=plan", "/", "/", "/", "/"]);
    // The # the browser carried onto /login (the server's redirect never sees it) comes back with a
    // next that has none; a next with its own keeps that; one that isn't ours is still the app.
    page.hash = "#/p/pier?photo=add";
    t.same("  the address's # comes back after signing in, as v86 keeps it (a link into the app, a card of a page)",
      [next("?next=%2Ft%2Ftrip-1%2F"), next("?next=%2Ftrips%2Ftrip-1%3Fphoto%3Dadd%23cover"), next("?next=%2F%2Fother.example")],
      ["/t/trip-1/#/p/pier?photo=add", "/trips/trip-1?photo=add#cover", "/"]);
    page.hash = "";
    page.search = "";
    const bytes = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) % 256);
    t.ok("its base64url goes there and back, with no padding and no + or /",
      Buffer.from(auth.unb64u(auth.b64u(bytes))).equals(Buffer.from(bytes)) && !/[+/=]/.test(auth.b64u(bytes)) && auth.b64u(bytes) === Buffer.from(bytes).toString("base64url"));
    t.same("every result a redirect can come back with has a kind and words",
      ["cancelled", "expired", "provider", "busy", "unavailable", "signed-out", "paused", "unknown", "added", "already", "taken", "link", "recovered", "deleted"]
        .filter((code) => { const w = auth.resultWords(code, "github"); return !(w && ["info", "err", "ok"].includes(w[0]) && w[1].length > 10); }), []);
    t.same("and an unknown one says nothing", auth.resultWords("made-up", "github"), null);
  } finally {
    globalThis.fetch = before.fetch;
    for (const name of ["window", "navigator", "location"]) {
      if (before[name]) Object.defineProperty(globalThis, name, before[name]); else delete globalThis[name];
    }
  }
}

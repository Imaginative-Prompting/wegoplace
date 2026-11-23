// A person in a check: their own cookies, their own passkeys, and the requests their browser
// would make. Plain HTTP, no browser. Also the small reporter every check prints through.

import { Jar, Passkey, request } from "../parity/lib.mjs";

// ── reporting ───────────────────────────────────────────────────────────────────────────────

export class Report {
  constructor(title) {
    this.title = title;
    this.passed = 0;
    this.failed = [];
    this.section = "";
  }
  part(name) {
    this.section = name;
    console.log(`\n${name}`);
  }
  /** One thing that must hold. `detail` is printed when it doesn't. */
  ok(what, holds, detail = "") {
    if (holds) {
      this.passed += 1;
      console.log(`  pass  ${what}`);
    } else {
      this.failed.push(`${this.section}: ${what}`);
      console.log(`  FAIL  ${what}${detail === "" ? "" : `\n        ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
    }
    return !!holds;
  }
  /** Two values that must be the same (compared as JSON). */
  same(what, got, want) {
    return this.ok(what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
  }
  /** Prints the totals and returns the exit code. */
  end() {
    console.log(`\n${this.title}: ${this.passed} passed, ${this.failed.length} failed`);
    for (const line of this.failed) console.log(`  FAILED  ${line}`);
    return this.failed.length ? 1 : 0;
  }
}

// ── a person ────────────────────────────────────────────────────────────────────────────────

let made = 0;
let keys = 0;
/** A passkey of its own, on a device of its own. */
export const newPasskey = () => Passkey.fresh(`check-passkey-${++keys}`);

export class Person {
  /**
   * @param {string} origin  the server's origin
   * @param {string} name    the display name they will sign up with
   * @param {string} [address]  the connection they come from (CF-Connecting-IP), so one person's
   *                            requests don't count against another's limits
   */
  constructor(origin, name, address = `10.1.${Math.floor(made / 250)}.${(made % 250) + 1}`) {
    made += 1;
    this.origin = origin;
    this.name = name;
    this.address = address;
    this.jar = new Jar();
    this.passkeys = [];
    this.user = null;
  }

  /** Another browser of the same person: the same passkeys, its own cookies. */
  otherBrowser() {
    const other = new Person(this.origin, this.name, this.address);
    other.passkeys = this.passkeys;
    return other;
  }

  /**
   * One request as this person's browser sends it. A body that is an object goes as JSON; a
   * string or a Buffer goes as it is. Answers { status, headers (pairs), text, json (or null), location,
   * cookies (the Set-Cookie values) }.
   */
  async call(method, path, body = null, { headers = {}, origin = this.origin, page = false, form = false, timeoutMs } = {}) {
    const h = { "CF-Connecting-IP": this.address, ...headers };
    const cookie = this.jar.header();
    if (cookie) h.Cookie = cookie;
    if (page) h.Accept = "text/html,application/xhtml+xml";
    let sent = null;
    if (body !== null) {
      if (form) {
        sent = new URLSearchParams(body).toString();
        h["Content-Type"] = "application/x-www-form-urlencoded";
      } else if (typeof body === "string" || Buffer.isBuffer(body)) sent = body;
      else {
        sent = JSON.stringify(body);
        h["Content-Type"] = "application/json";
      }
    }
    // A browser puts Origin on every request that isn't a GET or HEAD.
    if (!["GET", "HEAD"].includes(method) && origin !== null && h.Origin === undefined) h.Origin = origin;
    const res = await request(this.origin, { method, path, headers: h, body: sent, ...(timeoutMs ? { timeoutMs } : {}) });
    this.jar.take(res.headers);
    const text = res.body.toString("utf8");
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return {
      status: res.status, headers: res.headers, text, json,
      location: res.headers.find(([k]) => k === "location")?.[1] ?? null,
      cookies: res.headers.filter(([k]) => k === "set-cookie").map(([, v]) => v),
    };
  }
  get(path, opts) { return this.call("GET", path, null, opts); }
  post(path, body = {}, opts) { return this.call("POST", path, body, opts); }

  /** Whether this browser holds a session cookie. */
  get signedIn() { return this.jar.cookies.has("wgp_session"); }

  /** Makes an account with a new passkey. Answers the verify response. */
  async signUp(passkey = newPasskey()) {
    const options = await this.post("/api/auth/register/options", { name: this.name });
    if (options.status !== 200) return options;
    passkey.userHandle = options.json.user.id;
    const made = await this.post("/api/auth/register/verify", passkey.create({
      challenge: options.json.challenge, origin: this.origin, rpId: options.json.rp.id,
    }));
    if (made.status === 200) {
      this.passkeys.push(passkey);
      this.user = made.json.user;
    }
    return made;
  }

  /** Signs in with a passkey; `username` is the old accounts' way of naming their passkeys first. */
  async signIn(passkey = this.passkeys[0], { username, origin = this.origin, rpId = "localhost", change } = {}) {
    const options = await this.post("/api/auth/login/options", username === undefined ? {} : { username });
    if (options.status !== 200) return options;
    const response = passkey.get({ challenge: options.json.challenge, origin, rpId });
    change?.(response);
    const done = await this.post("/api/auth/login/verify", response);
    if (done.status === 200) this.user = done.json.user;
    return done;
  }

  /** Adds another passkey to the account this browser is signed in to. */
  async addPasskey(passkey = newPasskey()) {
    const options = await this.post("/api/auth/passkeys/options");
    if (options.status !== 200) return options;
    passkey.userHandle = options.json.user.id;
    const done = await this.post("/api/auth/passkeys/verify", passkey.create({
      challenge: options.json.challenge, origin: this.origin, rpId: options.json.rp.id,
    }));
    if (done.status === 200) this.passkeys.push(passkey);
    return done;
  }

  async me() { return (await this.get("/api/me")).json; }
}

/** The first Set-Cookie for a name, or undefined. */
export const cookieNamed = (res, name) => res.cookies.find((c) => c.startsWith(`${name}=`));

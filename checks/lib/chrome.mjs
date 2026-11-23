// A real browser for a check: Chrome for Testing, started by the one file that may start a
// browser (scripts/lib/browser.mjs), driven over its debugging protocol. Each `page()` is a
// browser of its own as far as the site can tell: its own cookies and storage, its own screen
// size, and its own device for passkeys (Chrome's virtual authenticator, which makes and uses
// real passkeys with no prompt to tap).
//
//   const chrome = await openChrome();
//   const page = await chrome.page({ width: 390, height: 844, mobile: true });
//   await page.goto(origin + "/login");
//   await page.click("#btn-join");
//   await chrome.close();

import fs from "node:fs";
import { launchChrome } from "../../scripts/lib/browser.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Wire {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.listeners = new Set(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("couldn't connect to the browser")); });
    const wire = new Wire(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const waiting = m.id && wire.waiting.get(m.id);
      if (waiting) {
        wire.waiting.delete(m.id);
        clearTimeout(waiting.timer);
        if (m.error) waiting.reject(new Error(`${waiting.method}: ${m.error.message}`)); else waiting.resolve(m.result);
      } else for (const fn of wire.listeners) fn(m);
    };
    return wire;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(`the browser didn't answer ${method} in 30 s`)); }, 30000);
      this.waiting.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

class Page {
  constructor(wire, session, context) {
    this.wire = wire; this.session = session; this.context = context;
    /** What went wrong inside the page: uncaught errors and console.error, never a refused request. */
    this.errors = [];
    this.authenticator = null;
    this.listeners = new Set();
  }
  /** Every event the browser sends about this page (Network.*, Page.*, …), to `fn`. Answers the way to stop. */
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  send(method, params) { return this.wire.send(method, params, this.session); }

  /** The page's screen: CSS pixels. `mobile` is a phone or tablet (touch, the viewport meta honored). */
  async size({ width, height, mobile = false }) {
    this.width = width;
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  }
  /** "light" or "dark": what the system says, for a page with no theme chosen. */
  scheme(value) { return this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] }); }

  /**
   * Lets the page draw what has changed: two frames, with this page in front (a page behind
   * another gets no frames at all, so the wait also ends by the clock).
   */
  async settle() {
    await this.send("Page.bringToFront");
    await this.eval("new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 400); })");
  }

  /**
   * Waits until the page is at rest: its fonts loaded, its pictures in, and no transition or
   * animation still running. A still or a measure taken before that shows a color half way
   * between two themes, which nobody ever sees. Throws, naming what is still moving, if the
   * page doesn't come to rest.
   */
  async rest(within = 8000) {
    await this.settle();      // a change made a moment ago gets a frame to start its transitions
    const moving = `document.getAnimations().filter((a) => a.playState === "running" || a.playState === "pending")`;
    try {
      await this.until(`document.fonts.status === "loaded" && [...document.images].every((i) => i.complete) && ${moving}.length === 0`, "the page to come to rest", within);
    } catch (e) {
      const what = await this.eval(`${moving}.map((a) => (a.transitionProperty || a.animationName || "animation") + " on " + (a.effect?.target?.id ? "#" + a.effect.target.id : a.effect?.target?.className || a.effect?.target?.tagName)).join(", ")`).catch(() => "");
      throw new Error(`${e.message}${what ? `; still moving: ${what}` : ""}`);
    }
    await this.settle();      // and the last frame of it is drawn
  }

  /** Slows every request this page makes by `ms`, as a far-off server would. 0 puts it back. */
  slow(ms) {
    return this.send("Network.emulateNetworkConditions", { offline: false, latency: ms, downloadThroughput: -1, uploadThroughput: -1 });
  }

  /**
   * What happens to this page's requests for addresses matching `pattern` (`*` is anything):
   * "stall", they never answer; "fail", the connection drops; "off", they go through again.
   */
  async requests(pattern, how) {
    if (this.unhook) { this.wire.listeners.delete(this.unhook); this.unhook = null; await this.send("Fetch.disable"); }
    if (how === "off") return;
    this.unhook = (m) => {
      if (m.sessionId !== this.session || m.method !== "Fetch.requestPaused" || how !== "fail") return;
      this.send("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "ConnectionFailed" }).catch(() => { /* the page went away */ });
    };
    this.wire.listeners.add(this.unhook);
    await this.send("Fetch.enable", { patterns: [{ urlPattern: pattern }] });
  }

  /** Runs an expression in the page and returns its value (a promise is awaited). */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  /** Waits until an expression is truthy and returns it. A page that is mid-navigation just isn't ready yet. */
  async until(expression, what = expression, within = 15000) {
    const end = Date.now() + within;
    let last = "";
    for (;;) {
      try {
        const value = await this.eval(`(() => { try { return (${expression}); } catch (e) { return null; } })()`);
        if (value) return value;
      } catch (e) { last = e.message; }
      if (Date.now() > end) {
        let where = "";
        try { where = await this.eval("location.href"); } catch { /* still navigating */ }
        throw new Error(`waited ${within / 1000} s for: ${what}${where ? ` (at ${where})` : ""}${last ? ` (${last})` : ""}`);
      }
      await sleep(60);
    }
  }
  async goto(url) {
    await this.open(url);
    await this.until("document.readyState === 'complete'", `${url} to load`);
  }
  /** Starts going to an address without waiting for it to finish loading (it may never). */
  open(url) { return this.send("Page.navigate", { url }); }
  /** Where the page is: path and query. */
  where() { return this.eval("location.pathname + location.search"); }
  /** Waits for the page to be at a path (with its query), loaded. */
  at(pathAndQuery, within) {
    return this.until(`location.pathname + location.search === ${JSON.stringify(pathAndQuery)} && document.readyState === "complete"`, `the page to be at ${pathAndQuery}`, within);
  }

  /**
   * A real click: the element is scrolled into view and the mouse pressed at its middle. The
   * page is brought to the front first: a browser only lets the window in front use a passkey.
   */
  async click(selector) {
    await this.send("Page.bringToFront");     // a person clicks in the window in front
    // As a person's eye does: the target holds still for two frames before it is pressed (21 Nov: a sheet easing to its
    // new height carried a button 227 px while the journey pressed where it had been).
    const spot = await this.until(`new Promise((ok) => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || el.disabled) return ok(null);
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const at = () => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(","); };
      const before = at();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || at() !== before) return ok(null);
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const top = document.elementFromPoint(x, y);
        if (!top || !(el === top || el.contains(top))) return ok(null);
        ok({ x, y });
      }));
    })`, `${selector} to be there to click, holding still, with nothing over it`);
    const mouse = { x: spot.x, y: spot.y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x, y: spot.y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...mouse });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...mouse });
  }
  /** Clicks a field, replaces what is in it, and types `text` as a keyboard would. */
  async type(selector, text) {
    await this.click(selector);
    await this.eval(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    if (text) await this.send("Input.insertText", { text });
  }

  /** Puts a cookie in this browser for a site, as if the site had set it. */
  setCookie(origin, name, value) {
    return this.send("Network.setCookie", { url: origin, name, value, httpOnly: true, sameSite: "Lax" });
  }

  /** A PNG of the whole page at rest, written to `file`. */
  async shot(file) {
    await this.rest();
    const { data } = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
  }

  /** Closes this page, as closing its window would. */
  close() { return this.wire.send("Target.closeTarget", { targetId: this.target }); }

  // ── the device's passkeys ─────────────────────────────────────────────────────────────
  /** Gives this page's device a place to keep passkeys, like a phone's own: nothing to tap. */
  async passkeyDevice() {
    await this.send("WebAuthn.enable", { enableUI: false });
    const made = await this.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    this.authenticator = made.authenticatorId;
  }
  /** The passkeys this page's device holds. */
  async passkeys() {
    return (await this.send("WebAuthn.getCredentials", { authenticatorId: this.authenticator })).credentials;
  }
}

/** Starts the browser. Goes through the machine's queue (the launcher refuses otherwise). */
export async function openChrome() {
  // Each page is a window of its own, and headless windows open on top of one another. A
  // browser counts a window that others cover as not shown, and refuses it a passkey ("the page
  // does not have focus") however the page itself reads; which windows count as covered follows
  // how many are open and in what order they were used. The flag tells it to count every
  // window as shown, so each page is the one in front, as each person's own browser is.
  const browser = await launchChrome({ args: ["--disable-backgrounding-occluded-windows", "about:blank"] });
  const wire = await Wire.connect(browser.wsUrl);
  const pages = new Map();
  wire.listeners.add((m) => {
    const page = pages.get(m.sessionId);
    if (!page) return;
    for (const fn of page.listeners) fn(m);
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      page.errors.push(`uncaught: ${d.exception?.description ?? d.text}`);
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      page.errors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    }
  });
  let profileTaken = false;
  return {
    /**
     * A browser of its own: cookies, storage, screen and passkey device.
     * @param {{ width: number, height: number, mobile?: boolean, passkeys?: boolean, before?: string, serviceWorker?: boolean }} o
     *   `before` is script run in every document before the page's own (to take something away from it).
     *   `serviceWorker`: let the app's service worker answer this page, as it does for a person.
     *   `ownProfile`: the page opens in the browser's own profile instead of a context of its own.
     *     Those contexts are off the record, like a private window, and Chrome never offers to install
     *     an app from one. Only one such page per browser: two would share everything.
     */
    async page({ width, height, mobile = false, passkeys = true, before = null, serviceWorker = false, ownProfile = false }) {
      if (ownProfile && profileTaken) throw new Error("this browser's own profile already has a page: open another browser");
      profileTaken ||= ownProfile;
      const { browserContextId } = ownProfile ? {} : await wire.send("Target.createBrowserContext");
      const { targetId } = await wire.send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await wire.send("Target.attachToTarget", { targetId, flatten: true });
      const page = new Page(wire, sessionId, browserContextId);
      page.target = targetId;
      pages.set(sessionId, page);
      await page.send("Page.enable");
      await page.send("Runtime.enable");
      await page.send("Network.enable");
      // Unless asked for, the app's service worker is left out: with it, a slow answer could be
      // served from its cache instead of by the server under check.
      if (!serviceWorker) await page.send("Network.setBypassServiceWorker", { bypass: true });
      // Each page behaves as the one in front: focused, drawing frames, running its timers.
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      if (before) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: before });
      await page.size({ width, height, mobile });
      await page.scheme("light");
      if (passkeys) await page.passkeyDevice();
      return page;
    },
    /**
     * A second tab beside `of`, in its browser context: the same cookies, the same IndexedDB and
     * storage, its own network conditions (one tab offline, the other with signal, as two tabs on
     * one phone). Set up as page() sets one up.
     */
    async tabBeside(of, { width, height, mobile = false, serviceWorker = false } = {}) {
      const { targetId } = await wire.send("Target.createTarget", { url: "about:blank", browserContextId: of.context });
      const { sessionId } = await wire.send("Target.attachToTarget", { targetId, flatten: true });
      const page = new Page(wire, sessionId, of.context);
      page.target = targetId;
      pages.set(sessionId, page);
      await page.send("Page.enable");
      await page.send("Runtime.enable");
      await page.send("Network.enable");
      if (!serviceWorker) await page.send("Network.setBypassServiceWorker", { bypass: true });
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await page.size({ width, height, mobile });
      await page.scheme("light");
      return page;
    },
    async close() {
      wire.close();
      await browser.close();
    },
  };
}

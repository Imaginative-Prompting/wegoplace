#!/usr/bin/env node
/* A DARK PHONE WITH NOTHING CHOSEN IS VOID. On the gate's made-up trip, its host, a phone set to dark and no theme
 * stored:
 *   1. The app (the Itinerary, Photos, More), Your trips, Your account, the sign-in page and the privacy page each
 *      paint on Void's black: --ground is #000000, <html> is the dark family, and the status bar's colour
 *      (theme-color, where the page sets one) is #000000. Photos' backdrop is black too.
 *   2. More's Appearance is System, Light, Dark (Dark is Void), System chosen.
 *   3. A retired look stored is read as the nearest and left as stored: Slate (or Night) is Dark, Linen is Light, on the
 *      sign-in page and in More; picking Light in More then stores "light".
 *
 *   node scripts/gate.mjs --only dark_default_check
 *
 * PLANTED: DARK_PLANT=slate serves styles.css with its system block's ground back at Slate's #101216 and the pages
 * with their old default (Slate's) for a dark phone: 1 red on every page.
 */
import { BASE, boot, evalIn, waitFor, sleep, appSettled, signInAs } from "./lib/standalone_cdp.mjs";
import { tripPath, HOST } from "./lib/gate_trip.mjs";

const PLANT = process.env.DARK_PLANT || "";
if (PLANT && PLANT !== "slate") throw new Error("DARK_PLANT is slate");
let planted = 0;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

const b = await boot({ vw: 390, vh: 844, dsf: 1, reduceMotion: true });
const { cdp, S } = b;
const page = (e) => evalIn(cdp, S, e);
try {
  await cdp.send("Emulation.setEmulatedMedia", { features: [
    { name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }] }, S);
  if (PLANT) {
    cdp.on(async (m) => {
      if (m.sessionId !== S || m.method !== "Fetch.requestPaused") return;
      const { requestId, responseStatusCode: status, responseHeaders: headers = [] } = m.params;
      try {
        if (status !== 200) { await cdp.send("Fetch.continueRequest", { requestId }, S); return; }
        const r = await cdp.send("Fetch.getResponseBody", { requestId }, S);
        const text = r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body;
        const out = text
          .replace(/(@media \(prefers-color-scheme: dark\) \{\n  :root:not\(\[data-theme\]\) \{[^}]*?--ground: )#000000;/, "$1#101216;")
          .replace(/mq\.matches \? THEMES\.void : THEMES\.light/g, 'mq.matches ? { lm: "dark", bar: "#101216" } : THEMES.light');
        if (out !== text) planted++;
        await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200,
          responseHeaders: headers.filter((h) => !/^(content-length|content-encoding)$/i.test(h.name)),
          body: Buffer.from(out, "utf8").toString("base64") }, S);
      } catch { try { await cdp.send("Fetch.continueRequest", { requestId }, S); } catch { /* gone */ } }
    });
    await cdp.send("Fetch.enable", { patterns: ["*/styles.css*", "*/t/*", "*/login*", "*/trips*", "*/account*", "*/privacy*"]
      .map((urlPattern) => ({ urlPattern, requestStage: "Response" })) }, S);
    console.log("PLANTED: the old dark default (Slate) served back");
  }
  const go = async (url, ready) => {
    await cdp.send("Page.navigate", { url: "about:blank" }, S);
    await sleep(100);
    await cdp.send("Page.navigate", { url }, S);
    await appSettled(cdp, S).catch(() => {});
    await waitFor(cdp, S, `${ready} ? 1 : 0`, { label: url, timeout: 40000 });
    await sleep(600);
  };
  const LOOK = `JSON.stringify({
    stored: (() => { try { return localStorage.getItem("wgp.theme"); } catch { return "unreadable"; } })(),
    theme: document.documentElement.getAttribute("data-theme"),
    lum: document.documentElement.getAttribute("data-lum"),
    ground: getComputedStyle(document.documentElement).getPropertyValue("--ground").trim(),
    body: getComputedStyle(document.documentElement).backgroundColor,
    bar: (document.querySelector('meta[name="theme-color"]') || {}).content ?? null })`;

  section("1. a dark phone, nothing chosen: every page on Void's black");
  const PAGES = [
    ["the Itinerary", `${BASE}${tripPath("#/")}`, `document.querySelector("#view .ag-day")`, true],
    ["Photos", `${BASE}${tripPath("#/memories")}`, `document.querySelector("#view .me-feed, #view .me-top")`, true],
    ["More", `${BASE}${tripPath("#/settings")}`, `document.querySelector("#view .st-title")`, true],
    ["Your trips", `${BASE}/trips`, `document.querySelector(".tr-title")`, true],
    ["Your account", `${BASE}/account`, `document.querySelector("h1")`, true],
    ["the privacy page", `${BASE}/privacy`, `document.querySelector("h1")`, false],
  ];
  for (const [name, url, ready, hasBar] of PAGES) {
    await go(url, ready);
    const l = JSON.parse(await page(LOOK));
    check(`${name}: no theme stored, --ground #000000 and the page painted black${hasBar ? ", theme-color #000000, the dark family" : ""}`,
      !l.stored && !l.theme && l.ground === "#000000" && l.body === "rgb(0, 0, 0)" && (!hasBar || l.bar === "#000000") && (l.lum === "dark" || !hasBar),
      JSON.stringify(l));
    if (name === "Photos") {
      const scape = await page(`getComputedStyle(document.documentElement).getPropertyValue("--me-scape").trim()`);
      check("Photos' backdrop is black too", scape === "#000000", scape);
    }
    if (name === "More") {
      section("2. More's Appearance");
      const look = JSON.parse(await page(`JSON.stringify([...document.querySelectorAll('#st-theme [data-mode]')].map((b) => [b.dataset.mode, b.textContent.trim(), b.getAttribute("aria-checked")]))`));
      check("Appearance is System, Light, Dark (Void), with System chosen",
        JSON.stringify(look) === JSON.stringify([["system", "System", "true"], ["light", "Light", "false"], ["void", "Dark", "false"]]), JSON.stringify(look));
    }
  }
  await cdp.send("Network.clearBrowserCookies", {}, S);
  await go(`${BASE}/login`, `document.body && document.body.innerText.trim().length > 20`);
  {
    const l = JSON.parse(await page(LOOK));
    check("the sign-in page, signed out: --ground #000000, painted black, theme-color #000000",
      !l.theme && l.ground === "#000000" && l.body === "rgb(0, 0, 0)" && l.bar === "#000000", JSON.stringify(l));
  }

  section("3. a retired look is read as the nearest, and left as stored");
  for (const [stored, theme, ground] of [["slate", "void", "#000000"], ["dark", "void", "#000000"], ["linen", "light", "#fdfdfc"]]) {
    await page(`(localStorage.setItem("wgp.theme", ${JSON.stringify(stored)}), 1)`);
    await go(`${BASE}/login`, `document.body && document.body.innerText.trim().length > 20`);
    const l = JSON.parse(await page(LOOK));
    check(`${stored} stored: the sign-in page paints ${theme === "void" ? "Dark" : "Light"} (${ground}, its theme-color too), and "${stored}" stays stored`,
      l.theme === theme && l.ground === ground && l.bar === ground && l.stored === stored, JSON.stringify(l));
  }
  await page(`(localStorage.setItem("wgp.theme", "slate"), 1)`);
  await signInAs(cdp, S, HOST.key);               // the sign-in page above was seen signed out
  await go(`${BASE}${tripPath("#/settings")}`, `document.querySelector("#st-theme [data-mode]")`);
  {
    const chosen = await page(`(document.querySelector('#st-theme [aria-checked="true"]') || {}).dataset?.mode || null`);
    const l = JSON.parse(await page(LOOK));
    check("slate stored: More's Appearance has Dark chosen, the app on Void, \"slate\" still stored", chosen === "void" && l.theme === "void" && l.stored === "slate", JSON.stringify({ chosen, ...l }));
    await page(`document.querySelector('#st-theme [data-mode="light"]').click()`);
    await sleep(400);
    const after = JSON.parse(await page(LOOK));
    check("picking Light stores \"light\" and paints the light ground", after.stored === "light" && after.theme === "light" && after.ground === "#fdfdfc", JSON.stringify(after));
  }
  await page(`(localStorage.removeItem("wgp.theme"), 1)`);
  check("nothing thrown on any page", b.pageErrors.length === 0, b.pageErrors.join(" | ").slice(0, 400));
} catch (e) {
  fail++; failures.push(`stopped: ${e.message}`);
  console.log(`  FAIL  stopped: ${e.stack || e}`);
} finally {
  await b.done().catch(() => {});
}
if (PLANT && !planted) { console.log("\nError: the slate plant changed nothing"); process.exit(1); }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }
